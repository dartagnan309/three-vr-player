import * as THREE from 'three';
import type { Projection } from '../types.js';
import { formatTime } from '../ui/format.js';
import {
  composeProjection, decomposeProjection, PROJECTION_SHORT,
  type ProjType, type Split, type FisheyeAngle, type FlatWidth, type ProjSpec,
} from './projections.js';
import {
  PANEL_W, PANEL_H, panelLayout, hitTest, projGridLayout, projGridHitTest, ANGLE_THIRD_ROW,
  type PanelLayout, type VRRegion, type Rect, type ProjGridHit, type ThirdRow, type ProjGridLayout,
} from './vr-panel-layout.js';

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
  /** Projection grid: the current mode, and select a specific mode. */
  currentProjection(): Projection;
  setProjection(p: Projection): void;
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
// Right thumbstick: X zooms (content fov), Y tilts (pitch); the grip grab-rotate also does
// pitch/yaw. Tunable.
const STICK_DEADZONE = 0.15;
const ZOOM_RATE = 0.012;            // content fov (stick X)
const TILT_RATE = 0.012;            // radians/frame at full deflection (stick Y)
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
  // Projection chooser — a separate popup panel that floats above the main controls.
  private readonly projCanvas: HTMLCanvasElement;
  private readonly projCtx: CanvasRenderingContext2D;
  private readonly projTexture: THREE.CanvasTexture;
  private readonly projPanel: THREE.Mesh;
  private panelH = 0;                     // main panel world height (for placing the popup above it)
  private projPanelH = 0;                 // popup world height
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
  private projOpen = false;                     // is the projection popup showing?
  private hover: VRRegion | null = null;        // main-panel hover
  private projHover: string | null = null;      // popup hover: 'close' or 'axis:value'
  private paintKey = '';
  private projPaintKey = '';
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
    this.panelH = ph;
    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(pw, ph),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, side: THREE.DoubleSide }),
    );
    this.panel.renderOrder = 10;   // always drawn on top of the video sphere
    this.panel.frustumCulled = false;
    this.panel.visible = false;
    this.scene.add(this.panel);

    // Projection popup: its own canvas/texture/mesh, floated above the main panel on demand.
    this.projCanvas = document.createElement('canvas');
    this.projCanvas.width = PANEL_W; this.projCanvas.height = PANEL_H;
    this.projCtx = this.projCanvas.getContext('2d')!;
    this.projTexture = new THREE.CanvasTexture(this.projCanvas);
    this.projTexture.colorSpace = THREE.SRGBColorSpace;
    this.projTexture.minFilter = THREE.LinearFilter;
    const ppw = 0.86, pph = (ppw * PANEL_H) / PANEL_W;
    this.projPanelH = pph;
    this.projPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(ppw, pph),
      new THREE.MeshBasicMaterial({ map: this.projTexture, transparent: true, depthTest: false, side: THREE.DoubleSide }),
    );
    this.projPanel.renderOrder = 12;   // above the main panel
    this.projPanel.frustumCulled = false;
    this.projPanel.visible = false;
    this.scene.add(this.projPanel);

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
    this.paintProj(true);
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

    // Raycast both controllers against the popup (if open) first, then the main panel —
    // the popup floats on top, so it wins the hover where the two overlap.
    let hover: VRRegion | null = null;
    let projHover: string | null = null;
    let cursorAt: THREE.Vector3 | null = null;
    for (let i = 0; i < this.controllers.length; i++) {
      const laser = this.lasers[i];
      const controller = this.controllers[i];
      // A controller slot with no bound input source is left at the world origin,
      // so its laser would draw as a fixed phantom line. Require both a live
      // connection and a real pose (off the origin) before drawing/raycasting it.
      const posed = this.tmpVec.setFromMatrixPosition(controller.matrixWorld).lengthSq() > 1e-6;
      if (!this.connected[i] || !posed) { laser.visible = false; continue; }
      let r: RayResult | null = null;
      if (this.projOpen) {
        const rp = this.rayHitMesh(controller, this.projPanel);
        if (rp.uv) { const g = projGridHitTest(rp.uv.x, rp.uv.y, this.projLayout()); if (g) projHover = projHitKey(g); r = rp; }
      }
      if (!r) {
        const rm = this.rayHitMesh(controller, this.panel);
        if (rm.uv) { const hh = hitTest(rm.uv.x, rm.uv.y, this.layout); if (hh) hover = hh.region; r = rm; }
      }
      // Draw a laser only when it actually meets a panel — the aiming feedback the user
      // needs, and no phantom line when the controller is aimed away / set down.
      if (r && r.point) { laser.visible = true; laser.scale.z = r.distance; cursorAt = r.point; }
      else laser.visible = false;
    }
    if (cursorAt) { this.cursor.position.copy(cursorAt); this.cursor.visible = true; }
    else this.cursor.visible = false;
    if (hover || projHover) this.idleAt = time + IDLE_HIDE_MS; // stay up while actively aimed at
    this.hover = hover;
    this.projHover = projHover;
    this.paint(false);
    if (this.projOpen) this.paintProj(false);
  }

  /** Ray from a controller against a panel mesh: the canvas-pixel UV under it (if any),
   *  the laser reach, and the world hit point. */
  private rayHitMesh(controller: THREE.Group, mesh: THREE.Mesh): RayResult {
    this.tmpMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tmpMatrix);
    const hits = this.raycaster.intersectObject(mesh, false);
    if (!hits.length) return { uv: null, distance: 5, point: null };
    const h = hits[0];
    const uv = h.uv ? { x: h.uv.x * PANEL_W, y: (1 - h.uv.y) * PANEL_H } : null;
    return { uv, distance: h.distance, point: h.point };
  }

  private onSelect(index: number): void {
    if (!this.connected[index]) return;
    // Trigger with the panel hidden just summons it — there's nothing to aim at yet.
    if (!this.visible) { this.show(); return; }
    this.idleAt = performanceNow() + IDLE_HIDE_MS;
    // Popup is modal-ish: if it's open and the ray is on it, that tap is for the popup.
    if (this.projOpen) {
      const rp = this.rayHitMesh(this.controllers[index], this.projPanel);
      if (rp.uv) { this.onProjSelect(rp.uv.x, rp.uv.y); return; }
    }
    const r = this.rayHitMesh(this.controllers[index], this.panel);
    if (!r.uv) return;
    const hit = hitTest(r.uv.x, r.uv.y, this.layout);
    if (!hit) return;
    switch (hit.region) {
      case 'play': this.actions.togglePlay(); break;
      case 'exit': this.actions.exitVR(); break;
      case 'passthrough': if (this.actions.passthroughAvailable()) this.actions.togglePassthrough(); break;
      case 'projection': this.projOpen ? this.closeProj() : this.openProj(); break; // globe toggles the popup
      case 'recenter': this.actions.recenter(); break; // recenter() re-places the panel via reposition()

      case 'seek': if (hit.value !== undefined) this.actions.seekFraction(hit.value); break;
      case 'volume':
        if (hit.value !== undefined) this.actions.setVolume(hit.value);
        else this.actions.toggleMute();
        break;
    }
    this.paint(true);
  }

  /** The contextual third row of the popup grid: fisheye angles for fisheye, Half/Full for
   *  flat SBS, and nothing at all for any other type. */
  private projThirdRow(spec: ProjSpec): ThirdRow {
    if (spec.type === 'fisheye') return ANGLE_THIRD_ROW;
    if (spec.type === 'flat' && spec.split === 'sbs') {
      return { caption: 'SBS width', cells: [
        { axis: 'flatWidth', value: 'half', label: 'Half' },
        { axis: 'flatWidth', value: 'full', label: 'Full' },
      ] };
    }
    return { caption: '', cells: [] }; // no third row for 180 / 360 / flat-mono / flat-tb
  }

  /** Popup grid layout built for the current mode (so paint + hit-test share the third row). */
  private projLayout(): ProjGridLayout {
    return projGridLayout(this.projThirdRow(decomposeProjection(this.actions.currentProjection())));
  }

  /** A tap on the projection popup: ✕ closes it; a cell edits one axis of the current
   *  projection and re-composes the mode (popup stays open for more edits). */
  private onProjSelect(x: number, y: number): void {
    const g = projGridHitTest(x, y, this.projLayout());
    if (!g) return;
    if (g.region === 'close') { this.closeProj(); this.paint(true); return; }
    const s = decomposeProjection(this.actions.currentProjection());
    if (g.axis === 'type') s.type = g.value as ProjType;
    else if (g.axis === 'split') s.split = g.value as Split;
    else if (g.axis === 'angle') { s.type = 'fisheye'; s.angle = Number(g.value) as FisheyeAngle; } // angle → force fisheye
    else if (g.axis === 'flatWidth') s.flatWidth = g.value as FlatWidth;                            // (flat SBS only)
    this.actions.setProjection(composeProjection(s.type, s.split, s.angle, s.flatWidth));
    this.paintProj(true);
    this.paint(true); // main panel shows the current-mode label
  }

  /** Open the projection popup, floated above the main panel. */
  private openProj(): void {
    this.projOpen = true;
    this.placeProj();
    this.projPanel.visible = true;
    this.paintProj(true);
  }

  /** Close the projection popup. */
  private closeProj(): void {
    this.projOpen = false;
    this.projPanel.visible = false;
  }

  /** Position the popup just above the main panel, sharing its orientation. */
  private placeProj(): void {
    const up = this.tmpVec.set(0, 1, 0).applyQuaternion(this.panel.quaternion);
    this.projPanel.quaternion.copy(this.panel.quaternion);
    this.projPanel.position.copy(this.panel.position).addScaledVector(up, this.panelH / 2 + 0.05 + this.projPanelH / 2);
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

  /** Right thumbstick, applied every frame it's held: X zooms the content fov (push right =
   *  zoom in), Y tilts the content pitch (push up = tilt up). The grip grab-rotate also does
   *  pitch/yaw; the two coexist. */
  private handleThumbstick(): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;
    const ramp = (v: number) => Math.sign(v) * (Math.abs(v) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
    for (const src of session.inputSources) {
      if (src.handedness !== 'right' || !src.gamepad) continue;
      const ax = src.gamepad.axes;
      // xr-standard: thumbstick X/Y at axes[2]/[3]; fall back to [0]/[1] on 2-axis runtimes.
      const x = ax.length >= 4 ? (ax[2] ?? 0) : (ax[0] ?? 0);
      const y = ax.length >= 4 ? (ax[3] ?? 0) : (ax[1] ?? 0);
      if (Math.abs(x) > STICK_DEADZONE) this.actions.adjustZoom(ramp(x) * ZOOM_RATE);
      // Stick up reads as negative Y; tilt up = positive delta (matches the grab-rotate sign).
      if (Math.abs(y) > STICK_DEADZONE) this.actions.adjustTilt(-ramp(y) * TILT_RATE);
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

  /** Re-lock the panel to the current head pose over the next few frames (e.g. after a
   *  recenter — button, API, or the headset's own system recenter). No-op while hidden;
   *  show() re-places it fresh anyway. */
  reposition(): void { if (this.visible) this.placeFrames = 12; }

  private toggle(): void { this.visible ? this.hide() : this.show(); }

  private show(): void {
    this.place();
    this.placeFrames = 12;   // settle onto the real head pose over the next frames
    this.projOpen = false; this.projPanel.visible = false; // always summon to the main controls
    this.visible = true;
    this.panel.visible = true;
    this.idleAt = performanceNow() + IDLE_HIDE_MS;
    this.paint(true);
  }

  private hide(): void {
    this.visible = false;
    this.panel.visible = false;
    this.projOpen = false; this.projPanel.visible = false;
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
    if (this.projOpen) this.placeProj();           // keep the popup pinned above the main panel
  }

  /** Trim text with a trailing ellipsis to fit maxWidth. Assumes c.font is set. */
  private ellipsize(text: string, maxWidth: number, c: CanvasRenderingContext2D = this.ctx): string {
    if (c.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && c.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t.replace(/\s+$/, '') + '…';
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number, c: CanvasRenderingContext2D = this.ctx): void {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /** Repaint the main panel only when something visible changed (state or hover). */
  private paint(force: boolean): void {
    const cur = this.actions.currentTime(), dur = this.actions.duration();
    const vol = this.actions.volume(), muted = this.actions.muted();
    const ptOn = this.actions.passthroughAvailable() && this.actions.passthroughEnabled();
    const key = ['main', this.actions.isPlaying(), Math.floor(cur), Math.floor(dur), vol.toFixed(2), muted, this.hover, this.actions.title(), this.actions.passthroughAvailable(), ptOn, this.actions.currentProjection(), this.projOpen].join('|');
    if (!force && key === this.paintKey) return;
    this.paintKey = key;

    const c = this.ctx, L = this.layout;
    c.clearRect(0, 0, PANEL_W, PANEL_H);
    this.slab();

    // Title, centered and truncated with an ellipsis so it never runs into the Exit button
    const title = this.actions.title();
    if (title) {
      c.font = '600 30px system-ui,"Segoe UI",Roboto,sans-serif';
      c.fillStyle = TEXT; c.textAlign = 'center'; c.textBaseline = 'middle';
      const maxW = 2 * L.exit.x - 48 - PANEL_W; // keep the centered title clear of the top-right pill
      c.fillText(this.ellipsize(title, maxW), PANEL_W / 2, L.title.y + L.title.h / 2);
    }

    // Top-row icon buttons: recenter (reticle), projection (globe) and exit (door-arrow) are
    // momentary; passthrough (eye, slashed when off) is a toggle (accent when on, border on hover).
    this.drawIconButton(L.recenter, this.hover === 'recenter', false, (x, y, col) => this.iconRecenter(x, y, col));
    this.drawIconButton(L.projection, this.projOpen, this.hover === 'projection', (x, y, col) => this.iconGlobe(x, y, col));
    this.drawIconButton(L.exit, this.hover === 'exit', false, (x, y, col) => this.iconExit(x, y, col));
    if (this.actions.passthroughAvailable()) {
      const on = this.actions.passthroughEnabled();
      this.drawIconButton(L.passthrough, on, this.hover === 'passthrough', (x, y, col) => this.iconEye(x, y, !on, col));
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

    // Current projection name (read-only; tap the globe to change it)
    c.fillStyle = MUTED_TEXT; c.font = '600 15px system-ui,sans-serif'; c.textAlign = 'right'; c.textBaseline = 'alphabetic';
    c.fillText('PROJECTION', L.projLabel.x + L.projLabel.w, L.projLabel.y);
    c.fillStyle = TEXT; c.font = '600 24px system-ui,sans-serif'; c.textBaseline = 'middle';
    const label = PROJECTION_SHORT[this.actions.currentProjection()] ?? this.actions.currentProjection();
    c.fillText(this.ellipsize(label, L.projLabel.w), L.projLabel.x + L.projLabel.w, L.projLabel.y + 26);

    // Seek + times
    const seekFrac = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
    this.drawBar(L.seekBar, seekFrac, this.hover === 'seek', true);
    c.fillStyle = MUTED_TEXT; c.font = '22px system-ui,sans-serif'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.fillText(formatTime(cur), L.timeCur.x, L.timeCur.y);
    c.textAlign = 'right'; c.fillText(dur > 0 ? formatTime(dur) : '--:--', L.timeDur.x, L.timeDur.y);

    this.texture.needsUpdate = true;
  }

  /** Paint the projection popup (its own canvas): a decomposed grid (Layout / Type /
   *  Fisheye-angle) with a title and ✕ close. The current mode's axes are highlighted;
   *  the angle row dims unless Fisheye is on. */
  private paintProj(force: boolean): void {
    const spec = decomposeProjection(this.actions.currentProjection());
    const key = [spec.type, spec.split, spec.angle, spec.flatWidth, this.projHover].join('|');
    if (!force && key === this.projPaintKey) return;
    this.projPaintKey = key;

    const c = this.projCtx, L = this.projLayout();
    c.clearRect(0, 0, PANEL_W, PANEL_H);
    this.slab(c);

    // Title (left) + ✕ close (top-right)
    c.fillStyle = TEXT; c.font = '600 28px system-ui,"Segoe UI",Roboto,sans-serif';
    c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText('Projection', L.title.x, L.title.y);
    this.drawIconButton(L.close, false, this.projHover === 'close', (x, y, col) => this.iconClose(x, y, col, c), c);

    for (const g of L.groups) {
      if (!g.cells.length) continue; // contextual third row can be empty (e.g. 180/360)
      c.fillStyle = MUTED_TEXT; c.font = '600 15px system-ui,sans-serif';
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.fillText(g.caption.toUpperCase(), g.cells[0].rect.x, g.captionY);
      for (const cell of g.cells) {
        const active =
          cell.axis === 'type' ? cell.value === spec.type :
          cell.axis === 'split' ? cell.value === spec.split :
          cell.axis === 'angle' ? cell.value === String(spec.angle) :
          cell.value === spec.flatWidth; // flatWidth
        this.drawTextButton(cell.rect, cell.label, active, this.projHover === projCellKey(cell.axis, cell.value), c);
      }
    }

    this.projTexture.needsUpdate = true;
  }

  /** The panel's rounded background slab. */
  private slab(c: CanvasRenderingContext2D = this.ctx): void {
    this.roundRect(0, 0, PANEL_W, PANEL_H, 28, c);
    c.fillStyle = 'rgba(22,24,30,0.84)'; c.fill();
    c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,0.08)'; c.stroke();
  }

  /** A rounded pill button with a centred text label (projection-grid cells). */
  private drawTextButton(r: Rect, label: string, active: boolean, hover: boolean, c: CanvasRenderingContext2D = this.ctx): void {
    this.roundRect(r.x, r.y, r.w, r.h, 12, c);
    c.fillStyle = active ? ACCENT : 'rgba(255,255,255,0.10)'; c.fill();
    if (hover) { c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,0.9)'; c.stroke(); }
    c.fillStyle = active ? '#fff' : TEXT;
    c.font = '600 22px system-ui,"Segoe UI",Roboto,sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(this.ellipsize(label, r.w - 16, c), r.x + r.w / 2, r.y + r.h / 2 + 1);
  }

  /** A rounded-square icon button: accent fill when `filled`, white border when `hover`; the
   *  icon is drawn centred in `filled ? white : TEXT`. */
  private drawIconButton(r: Rect, filled: boolean, hover: boolean, draw: (cx: number, cy: number, color: string) => void, c: CanvasRenderingContext2D = this.ctx): void {
    this.roundRect(r.x, r.y, r.w, r.h, 14, c);
    c.fillStyle = filled ? ACCENT : 'rgba(255,255,255,0.12)'; c.fill();
    if (hover) { c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,0.9)'; c.stroke(); }
    draw(r.x + r.w / 2, r.y + r.h / 2, filled ? '#fff' : TEXT);
  }

  /** Recenter — a reticle (ring + centre dot + crosshair ticks). */
  private iconRecenter(cx: number, cy: number, color: string): void {
    const c = this.ctx;
    c.strokeStyle = color; c.fillStyle = color; c.lineWidth = 2.5; c.lineCap = 'round';
    c.beginPath(); c.arc(cx, cy, 9, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(cx, cy, 2.4, 0, Math.PI * 2); c.fill();
    c.beginPath();
    c.moveTo(cx, cy - 16); c.lineTo(cx, cy - 6);
    c.moveTo(cx, cy + 6); c.lineTo(cx, cy + 16);
    c.moveTo(cx - 16, cy); c.lineTo(cx - 6, cy);
    c.moveTo(cx + 6, cy); c.lineTo(cx + 16, cy);
    c.stroke();
  }

  /** Passthrough — an eye; a diagonal slash across it means passthrough is off. */
  private iconEye(cx: number, cy: number, off: boolean, color: string): void {
    const c = this.ctx, w = 16, h = 10;
    c.strokeStyle = color; c.fillStyle = color; c.lineWidth = 2.5; c.lineCap = 'round';
    c.beginPath();
    c.moveTo(cx - w, cy);
    c.quadraticCurveTo(cx, cy - h * 1.7, cx + w, cy);
    c.quadraticCurveTo(cx, cy + h * 1.7, cx - w, cy);
    c.stroke();
    c.beginPath(); c.arc(cx, cy, 4, 0, Math.PI * 2); c.fill();
    if (off) { c.beginPath(); c.moveTo(cx - w, cy + h); c.lineTo(cx + w, cy - h); c.stroke(); }
  }

  /** Close — an ✕ (used on the projection popup, drawn to its own context). */
  private iconClose(cx: number, cy: number, color: string, c: CanvasRenderingContext2D): void {
    const s = 9;
    c.strokeStyle = color; c.lineWidth = 2.6; c.lineCap = 'round';
    c.beginPath();
    c.moveTo(cx - s, cy - s); c.lineTo(cx + s, cy + s);
    c.moveTo(cx + s, cy - s); c.lineTo(cx - s, cy + s);
    c.stroke();
  }

  /** Exit — a door frame with an arrow pointing out to the right. */
  private iconExit(cx: number, cy: number, color: string): void {
    const c = this.ctx, dx = cx - 15, dw = 11, dh = 22, a1 = cx + 16;
    c.strokeStyle = color; c.lineWidth = 2.5; c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(dx + dw, cy - dh / 2); c.lineTo(dx, cy - dh / 2);
    c.lineTo(dx, cy + dh / 2); c.lineTo(dx + dw, cy + dh / 2);
    c.stroke();
    c.beginPath();
    c.moveTo(cx - 3, cy); c.lineTo(a1, cy);
    c.moveTo(a1 - 7, cy - 6); c.lineTo(a1, cy); c.lineTo(a1 - 7, cy + 6);
    c.stroke();
  }

  /** Projection — a globe (circle + a meridian and two parallels). */
  private iconGlobe(cx: number, cy: number, color: string): void {
    const c = this.ctx, r = 13;
    c.strokeStyle = color; c.lineWidth = 2.2; c.lineCap = 'round';
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.ellipse(cx, cy, r * 0.45, r, 0, 0, Math.PI * 2); c.stroke(); // meridian
    c.beginPath();
    c.moveTo(cx - r, cy); c.lineTo(cx + r, cy);                                   // equator
    c.moveTo(cx - r * 0.86, cy - r * 0.5); c.lineTo(cx + r * 0.86, cy - r * 0.5); // upper parallel
    c.moveTo(cx - r * 0.86, cy + r * 0.5); c.lineTo(cx + r * 0.86, cy + r * 0.5); // lower parallel
    c.stroke();
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
    this.scene.remove(this.projPanel);
    this.projPanel.geometry.dispose();
    (this.projPanel.material as THREE.Material).dispose();
    this.projTexture.dispose();
    this.scene.remove(this.cursor);
    this.cursor.geometry.dispose();
    (this.cursor.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}

/** A controller-ray hit against a panel mesh. */
interface RayResult { uv: { x: number; y: number } | null; distance: number; point: THREE.Vector3 | null; }

/** performance.now(), but tolerant of environments without it (tests). */
function performanceNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

/** Stable hover/identity key for a projection-grid cell. */
function projCellKey(axis: string, value: string): string { return `${axis}:${value}`; }
function projHitKey(g: ProjGridHit): string { return g.region === 'close' ? 'close' : projCellKey(g.axis, g.value); }
