import * as THREE from 'three';
import { formatTime } from '../ui/format.js';
import { PANEL_W, PANEL_H, panelLayout, hitTest, type PanelLayout, type VRRegion, type Rect } from './vr-panel-layout.js';

/** The playback state + commands the panel needs. Kept small so the owner
 *  (StereoScene) can wire it straight to the `<video>` element. */
export interface VRControlsActions {
  isPlaying(): boolean;
  currentTime(): number;
  duration(): number;
  volume(): number;   // 0..1
  muted(): boolean;
  title(): string;
  togglePlay(): void;
  seekFraction(f: number): void;
  setVolume(v: number): void;
  toggleMute(): void;
  exitVR(): void;
  recenter(): void;
  adjustTilt(delta: number): void;
  adjustYaw(delta: number): void;
  adjustZoom(delta: number): void;
  /** Passthrough (alpha) content only: whether the toggle applies, its state, and the toggle. */
  passthroughAvailable(): boolean;
  passthroughEnabled(): boolean;
  togglePassthrough(): void;
}

const ACCENT = '#4f8cff';
const TEXT = '#e8eaed';
const MUTED_TEXT = '#aab2c0';
// Quest Touch (xr-standard) face buttons: 4 = A/X (lower), 5 = B/Y (upper).
const TOGGLE_BUTTONS = [4, 5];
const IDLE_HIDE_MS = 8000;
// Deliberate controller motion (per frame) that re-summons the panel; tunable.
const MOTION_ROT = 0.05;            // radians
const MOTION_POS = 0.02;            // metres
const REVEAL_COOLDOWN_MS = 1500;    // don't re-summon on motion right after hiding
// Right thumbstick X zooms (content fov); pitch/yaw are the grip grab-rotate. Tunable.
const STICK_DEADZONE = 0.15;
const ZOOM_RATE = 0.012;            // content fov (stick X)
const GRAB_TAP_ANGLE = 0.08;        // radians: a grip turned less than this is a tap (toggle), not a grab

/** A world-locked control panel for immersive VR, drawn to a canvas texture and
 *  driven by the motion controllers' laser + trigger. Lives only while an XR
 *  session is active; StereoScene builds it on sessionstart and disposes it on end. */
export class VRControls {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly actions: VRControlsActions;
  private readonly layout: PanelLayout = panelLayout();

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly panel: THREE.Mesh;
  private readonly cursor: THREE.Mesh;   // white dot at the laser/panel intersection

  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly prevQuat: THREE.Quaternion[] = [];   // last frame's controller poses, for motion reveal
  private readonly prevPos: THREE.Vector3[] = [];
  private revealCooldownUntil = 0;
  // Grip grab-rotate: while held, the controller's rotation drives content pitch/yaw.
  private grabbing: number | null = null;
  private readonly grabStartQuat = new THREE.Quaternion();
  private readonly prevGrabQuat = new THREE.Quaternion();
  private readonly grabQuat = new THREE.Quaternion();
  private readonly deltaQuat = new THREE.Quaternion();
  private readonly grabEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly controllers: THREE.Group[] = [];
  private readonly lasers: THREE.Line[] = [];
  private readonly connected: boolean[] = [];   // per slot: is a real tracked-pointer bound?
  private readonly cleanups: (() => void)[] = [];

  private visible = false;
  private hover: VRRegion | null = null;
  private paintKey = '';
  private idleAt = 0;
  private togglePrev = false;
  private placeFrames = 0;               // re-lock the panel to the head pose for a few frames after summon

  constructor(opts: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; actions: VRControlsActions }) {
    this.renderer = opts.renderer;
    this.scene = opts.scene;
    this.actions = opts.actions;

    this.canvas = document.createElement('canvas');
    this.canvas.width = PANEL_W; this.canvas.height = PANEL_H;
    this.ctx = this.canvas.getContext('2d')!;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;

    const pw = 1.0, ph = (pw * PANEL_H) / PANEL_W; // ~3:1, ~35° wide at 1.6 m
    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(pw, ph),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, side: THREE.DoubleSide }),
    );
    this.panel.renderOrder = 10;   // always drawn on top of the video sphere
    this.panel.frustumCulled = false;
    this.panel.visible = false;
    this.scene.add(this.panel);

    this.cursor = new THREE.Mesh(
      new THREE.SphereGeometry(0.007, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }),
    );
    this.cursor.renderOrder = 11;  // on top of the panel
    this.cursor.frustumCulled = false;
    this.cursor.visible = false;
    this.scene.add(this.cursor);

    // Seed connected state from the session's current input sources (the 'connected'
    // event may have already fired before this object existed), then keep it live
    // via connect/disconnect. Only a bound tracked-pointer gets a laser — otherwise
    // the empty controller slot sits at the origin and draws a fixed phantom line.
    const session = this.renderer.xr.getSession();
    const trackedCount = session ? Array.from(session.inputSources).filter((s) => s.targetRayMode === 'tracked-pointer').length : 0;
    for (let i = 0; i < 2; i++) {
      const c = this.renderer.xr.getController(i);
      const laser = this.makeLaser();
      laser.visible = false;
      c.add(laser);
      this.scene.add(c);
      this.controllers.push(c);
      this.lasers.push(laser);
      this.connected.push(i < trackedCount);

      const select = () => this.onSelect(i);
      const grabStart = () => this.onGrabStart(i); // grip down: begin grab-rotate
      const grabEnd = () => this.onGrabEnd(i);     // grip up: end grab, or toggle panel if it was a tap
      const connect = (e?: { data?: { targetRayMode?: string } }) => { this.connected[i] = !e?.data || e.data.targetRayMode === 'tracked-pointer'; };
      const disconnect = () => { this.connected[i] = false; };
      const ev = c as unknown as {
        addEventListener(t: string, l: (e?: { data?: { targetRayMode?: string } }) => void): void;
        removeEventListener(t: string, l: (e?: { data?: { targetRayMode?: string } }) => void): void;
      };
      ev.addEventListener('selectstart', select);
      ev.addEventListener('squeezestart', grabStart);
      ev.addEventListener('squeezeend', grabEnd);
      ev.addEventListener('connected', connect);
      ev.addEventListener('disconnected', disconnect);
      this.cleanups.push(() => {
        ev.removeEventListener('selectstart', select);
        ev.removeEventListener('squeezestart', grabStart);
        ev.removeEventListener('squeezeend', grabEnd);
        ev.removeEventListener('connected', connect);
        ev.removeEventListener('disconnected', disconnect);
      });
    }

    this.paint(true);
    // Not shown on entry — summoned by the grip button or by moving a controller.
  }

  private makeLaser(): THREE.Line {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const mat = new THREE.LineBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.8 });
    return new THREE.Line(geo, mat);
  }

  /** Called once per frame from the render loop (before renderer.render). */
  update(time: number): void {
    if (!this.renderer.xr.getSession()) return;
    this.pollToggle();
    this.handleThumbstick();
    this.handleGrab();
    this.maybeRevealOnMotion(time);

    if (!this.visible) { for (const l of this.lasers) l.visible = false; this.cursor.visible = false; return; }

    // Re-lock to the head pose for a few frames after summon: the XR camera pose
    // isn't updated until renderer.render (which runs after this), so the pose read
    // on the very first frame is stale/identity. Settling over a few frames fixes it.
    if (this.placeFrames > 0) { this.place(); this.placeFrames--; }

    // Auto-hide after a spell of no aiming at the panel.
    if (this.idleAt && time > this.idleAt) { this.hide(); return; }

    // Raycast both controllers; the one pointing at the panel wins the hover.
    let hover: VRRegion | null = null;
    let cursorAt: THREE.Vector3 | null = null;
    for (let i = 0; i < this.controllers.length; i++) {
      const laser = this.lasers[i];
      const controller = this.controllers[i];
      // A controller slot with no bound input source is left at the world origin,
      // so its laser would draw as a fixed phantom line. Require both a live
      // connection and a real pose (off the origin) before drawing/raycasting it.
      const posed = this.tmpVec.setFromMatrixPosition(controller.matrixWorld).lengthSq() > 1e-6;
      if (!this.connected[i] || !posed) { laser.visible = false; continue; }
      const r = this.rayHit(controller);
      // Draw a laser only when it actually meets the panel. That's the aiming feedback
      // the user needs, and it means a controller that's set down (still a live input
      // source at its resting pose, but not aimed at the panel) never draws a phantom line.
      if (r.point) {
        laser.visible = true;
        laser.scale.z = r.distance;
        cursorAt = r.point;              // laser is on the panel — show the dot there
        if (r.hit) hover = r.hit.region;
      } else {
        laser.visible = false;
      }
    }
    if (cursorAt) { this.cursor.position.copy(cursorAt); this.cursor.visible = true; }
    else this.cursor.visible = false;
    if (hover) this.idleAt = time + IDLE_HIDE_MS; // stay up while actively aimed at
    this.hover = hover;
    this.paint(false);
  }

  /** Ray from a controller against the panel: the region under it (if any) and
   *  how far the laser reaches. */
  private rayHit(controller: THREE.Group): { hit: ReturnType<typeof hitTest>; distance: number; point: THREE.Vector3 | null } {
    this.tmpMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tmpMatrix);
    const hits = this.raycaster.intersectObject(this.panel, false);
    if (!hits.length) return { hit: null, distance: 5, point: null };
    const h = hits[0];
    const hit = h.uv ? hitTest(h.uv.x * PANEL_W, (1 - h.uv.y) * PANEL_H, this.layout) : null;
    return { hit, distance: h.distance, point: h.point };
  }

  private onSelect(index: number): void {
    if (!this.visible || !this.connected[index]) return;
    const { hit } = this.rayHit(this.controllers[index]);
    if (!hit) return;
    this.idleAt = performanceNow() + IDLE_HIDE_MS;
    switch (hit.region) {
      case 'play': this.actions.togglePlay(); break;
      case 'exit': this.actions.exitVR(); break;
      case 'passthrough': if (this.actions.passthroughAvailable()) this.actions.togglePassthrough(); break;
      case 'recenter': this.actions.recenter(); this.placeFrames = 12; break; // re-place the panel in the new frame

      case 'seek': if (hit.value !== undefined) this.actions.seekFraction(hit.value); break;
      case 'volume':
        if (hit.value !== undefined) this.actions.setVolume(hit.value);
        else this.actions.toggleMute();
        break;
    }
    this.paint(true);
  }

  /** Re-summon the panel when a connected controller is deliberately moved (and
   *  we're past the post-hide cooldown). Tracks each controller's pose per frame. */
  private maybeRevealOnMotion(time: number): void {
    if (this.grabbing !== null) return; // don't pop the panel while grab-rotating
    for (let i = 0; i < this.controllers.length; i++) {
      const c = this.controllers[i];
      const p = this.tmpVec.setFromMatrixPosition(c.matrixWorld);
      if (!this.connected[i] || p.lengthSq() <= 1e-6) continue; // skip unbound/unposed slots
      const q = this.tmpQuat.setFromRotationMatrix(c.matrixWorld);
      const prevQ = this.prevQuat[i], prevP = this.prevPos[i];
      if (prevQ && prevP && !this.visible && time > this.revealCooldownUntil
          && (q.angleTo(prevQ) > MOTION_ROT || p.distanceTo(prevP) > MOTION_POS)) {
        this.show();
      }
      if (!this.prevQuat[i]) this.prevQuat[i] = new THREE.Quaternion();
      if (!this.prevPos[i]) this.prevPos[i] = new THREE.Vector3();
      this.prevQuat[i].copy(q);
      this.prevPos[i].copy(p);
    }
  }

  /** Right thumbstick X zooms the content fov every frame it's held (push right =
   *  zoom in). Pitch/yaw are handled by the grip grab-rotate, not the stick. */
  private handleThumbstick(): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;
    for (const src of session.inputSources) {
      if (src.handedness !== 'right' || !src.gamepad) continue;
      const ax = src.gamepad.axes;
      // xr-standard: thumbstick X at axes[2]; fall back to [0] on runtimes with only 2 axes.
      const x = ax.length >= 4 ? (ax[2] ?? 0) : (ax[0] ?? 0);
      const a = Math.abs(x);
      if (a > STICK_DEADZONE) this.actions.adjustZoom(Math.sign(x) * (a - STICK_DEADZONE) / (1 - STICK_DEADZONE) * ZOOM_RATE);
      break;
    }
  }

  private onGrabStart(i: number): void {
    if (!this.connected[i]) return;
    this.grabbing = i;
    this.controllers[i].getWorldQuaternion(this.grabStartQuat);
    this.prevGrabQuat.copy(this.grabStartQuat);
  }

  private onGrabEnd(i: number): void {
    if (this.grabbing !== i) return;
    this.grabbing = null;
    this.revealCooldownUntil = performanceNow() + REVEAL_COOLDOWN_MS;
    // A grip barely turned is a tap -> toggle the panel; a real turn was a grab.
    if (this.controllers[i].getWorldQuaternion(this.grabQuat).angleTo(this.grabStartQuat) < GRAB_TAP_ANGLE) this.toggle();
  }

  /** While the grip is held, apply the controller's frame-to-frame rotation to the
   *  content's yaw and pitch — a 1:1 grab-and-turn. Roll is ignored. */
  private handleGrab(): void {
    if (this.grabbing === null) return;
    if (!this.connected[this.grabbing]) { this.grabbing = null; return; }
    const cur = this.controllers[this.grabbing].getWorldQuaternion(this.grabQuat);
    this.deltaQuat.copy(this.prevGrabQuat).invert().premultiply(cur); // cur * prev⁻¹ (world-space delta)
    this.grabEuler.setFromQuaternion(this.deltaQuat, 'YXZ');
    this.actions.adjustYaw(this.grabEuler.y);
    this.actions.adjustTilt(this.grabEuler.x);
    this.prevGrabQuat.copy(cur);
  }

  private pollToggle(): void {
    const session = this.renderer.xr.getSession();
    let pressed = false;
    for (const src of session?.inputSources ?? []) {
      const g = src.gamepad;
      if (g && TOGGLE_BUTTONS.some((b) => g.buttons[b]?.pressed)) pressed = true;
    }
    if (pressed && !this.togglePrev) this.toggle();
    this.togglePrev = pressed;
  }

  private toggle(): void { this.visible ? this.hide() : this.show(); }

  private show(): void {
    this.place();
    this.placeFrames = 12;   // settle onto the real head pose over the next frames
    this.visible = true;
    this.panel.visible = true;
    this.idleAt = performanceNow() + IDLE_HIDE_MS;
    this.paint(true);
  }

  private hide(): void {
    this.visible = false;
    this.panel.visible = false;
    this.cursor.visible = false;
    for (const l of this.lasers) l.visible = false;
    this.revealCooldownUntil = performanceNow() + REVEAL_COOLDOWN_MS;
  }

  /** World-lock the panel in front of the current head pose (the "recenter"). Uses
   *  yaw only (so head pitch/roll at summon doesn't skew it), drops it into the lower
   *  field of view, and tilts its face up toward the viewer. Re-run on every summon. */
  private place(): void {
    const cam = this.renderer.xr.getCamera();
    const pos = cam.getWorldPosition(new THREE.Vector3());
    const quat = cam.getWorldQuaternion(new THREE.Quaternion());
    const yaw = new THREE.Euler().setFromQuaternion(quat, 'YXZ').y;
    const yawQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(yawQuat);
    this.panel.position.copy(pos).addScaledVector(forward, 1.5);
    this.panel.position.y -= 0.55;                 // near the lower field of view
    this.panel.quaternion.copy(yawQuat);           // plane front (+Z) faces back toward the viewer
    this.panel.rotateX(-0.3);                      // sitting low, angle the face up toward the eyes
  }

  /** Trim text with a trailing ellipsis to fit maxWidth. Assumes ctx.font is set. */
  private ellipsize(text: string, maxWidth: number): string {
    const c = this.ctx;
    if (c.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && c.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t.replace(/\s+$/, '') + '…';
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /** Repaint the panel only when something visible changed (state or hover). */
  private paint(force: boolean): void {
    const cur = this.actions.currentTime(), dur = this.actions.duration();
    const vol = this.actions.volume(), muted = this.actions.muted();
    const ptOn = this.actions.passthroughAvailable() && this.actions.passthroughEnabled();
    const key = [this.actions.isPlaying(), Math.floor(cur), Math.floor(dur), vol.toFixed(2), muted, this.hover, this.actions.title(), this.actions.passthroughAvailable(), ptOn].join('|');
    if (!force && key === this.paintKey) return;
    this.paintKey = key;

    const c = this.ctx, L = this.layout;
    c.clearRect(0, 0, PANEL_W, PANEL_H);

    // Slab
    this.roundRect(0, 0, PANEL_W, PANEL_H, 28);
    c.fillStyle = 'rgba(22,24,30,0.84)'; c.fill();
    c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,0.08)'; c.stroke();

    // Title, centered and truncated with an ellipsis so it never runs into the Exit button
    const title = this.actions.title();
    if (title) {
      c.font = '600 30px system-ui,"Segoe UI",Roboto,sans-serif';
      c.fillStyle = TEXT; c.textAlign = 'center'; c.textBaseline = 'middle';
      const maxW = 2 * L.exit.x - 48 - PANEL_W; // keep the centered title clear of the top-right pill
      c.fillText(this.ellipsize(title, maxW), PANEL_W / 2, L.title.y + L.title.h / 2);
    }

    // Top pills
    this.drawPill(L.recenter, 'Recenter', this.hover === 'recenter');
    this.drawPill(L.exit, 'Exit VR', this.hover === 'exit');
    // Passthrough toggle (alpha content only): filled/accent when ON, white border on hover.
    if (this.actions.passthroughAvailable()) {
      const r = L.passthrough, on = this.actions.passthroughEnabled();
      this.roundRect(r.x, r.y, r.w, r.h, r.h / 2);
      c.fillStyle = on ? ACCENT : 'rgba(255,255,255,0.12)'; c.fill();
      if (this.hover === 'passthrough') { c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,0.9)'; c.stroke(); }
      c.fillStyle = on ? '#fff' : TEXT;
      c.font = '600 24px system-ui,sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('Passthrough', r.x + r.w / 2, r.y + r.h / 2);
    }

    // Play / pause
    const pc = { x: L.play.x + L.play.w / 2, y: L.play.y + L.play.h / 2 };
    c.beginPath(); c.arc(pc.x, pc.y, 44, 0, Math.PI * 2);
    c.fillStyle = this.hover === 'play' ? ACCENT : 'rgba(255,255,255,0.14)'; c.fill();
    c.fillStyle = '#fff';
    if (this.actions.isPlaying()) {
      c.fillRect(pc.x - 13, pc.y - 16, 9, 32);
      c.fillRect(pc.x + 4, pc.y - 16, 9, 32);
    } else {
      c.beginPath(); c.moveTo(pc.x - 12, pc.y - 17); c.lineTo(pc.x - 12, pc.y + 17); c.lineTo(pc.x + 18, pc.y); c.closePath(); c.fill();
    }

    // Volume: speaker + track
    this.drawSpeaker(L.volIcon, muted);
    const volFrac = muted ? 0 : Math.max(0, Math.min(1, vol));
    this.drawBar(L.volBar, volFrac, this.hover === 'volume');

    // Seek + times
    const seekFrac = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
    this.drawBar(L.seekBar, seekFrac, this.hover === 'seek', true);
    c.fillStyle = MUTED_TEXT; c.font = '22px system-ui,sans-serif'; c.textBaseline = 'alphabetic';
    c.textAlign = 'left'; c.fillText(formatTime(cur), L.timeCur.x, L.timeCur.y);
    c.textAlign = 'right'; c.fillText(dur > 0 ? formatTime(dur) : '--:--', L.timeDur.x, L.timeDur.y);

    this.texture.needsUpdate = true;
  }

  private drawPill(r: Rect, label: string, active: boolean): void {
    const c = this.ctx;
    this.roundRect(r.x, r.y, r.w, r.h, r.h / 2);
    c.fillStyle = active ? ACCENT : 'rgba(255,255,255,0.12)'; c.fill();
    c.fillStyle = active ? '#fff' : TEXT;
    c.font = '600 24px system-ui,sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
  }

  private drawBar(r: { x: number; y: number; w: number; h: number }, frac: number, hovered: boolean, knob = false): void {
    const c = this.ctx, rad = r.h / 2;
    this.roundRect(r.x, r.y, r.w, r.h, rad); c.fillStyle = 'rgba(255,255,255,0.22)'; c.fill();
    if (frac > 0) { this.roundRect(r.x, r.y, r.w * frac, r.h, rad); c.fillStyle = ACCENT; c.fill(); }
    if (knob || hovered) {
      c.beginPath(); c.arc(r.x + r.w * frac, r.y + r.h / 2, hovered ? 12 : 9, 0, Math.PI * 2);
      c.fillStyle = '#fff'; c.fill();
    }
  }

  private drawSpeaker(r: { x: number; y: number; w: number; h: number }, muted: boolean): void {
    const c = this.ctx, x = r.x, y = r.y + r.h / 2;
    c.fillStyle = muted ? MUTED_TEXT : TEXT;
    c.beginPath();
    c.moveTo(x, y - 7); c.lineTo(x + 10, y - 7); c.lineTo(x + 20, y - 16);
    c.lineTo(x + 20, y + 16); c.lineTo(x + 10, y + 7); c.lineTo(x, y + 7); c.closePath(); c.fill();
    c.strokeStyle = muted ? '#e06a6a' : TEXT; c.lineWidth = 3;
    if (muted) {
      c.beginPath(); c.moveTo(x + 26, y - 9); c.lineTo(x + 40, y + 9); c.moveTo(x + 40, y - 9); c.lineTo(x + 26, y + 9); c.stroke();
    } else {
      c.beginPath(); c.arc(x + 24, y, 8, -Math.PI / 3, Math.PI / 3); c.stroke();
      c.beginPath(); c.arc(x + 24, y, 15, -Math.PI / 3, Math.PI / 3); c.stroke();
    }
  }

  dispose(): void {
    for (const fn of this.cleanups) fn();
    for (let i = 0; i < this.controllers.length; i++) {
      const c = this.controllers[i];
      c.remove(this.lasers[i]);
      this.lasers[i].geometry.dispose();
      (this.lasers[i].material as THREE.Material).dispose();
      this.scene.remove(c);
    }
    this.scene.remove(this.panel);
    this.panel.geometry.dispose();
    (this.panel.material as THREE.Material).dispose();
    this.scene.remove(this.cursor);
    this.cursor.geometry.dispose();
    (this.cursor.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}

/** performance.now(), but tolerant of environments without it (tests). */
function performanceNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}
