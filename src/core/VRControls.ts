import * as THREE from 'three';
import { formatTime } from '../ui/format.js';
import { PANEL_W, PANEL_H, panelLayout, hitTest, type PanelLayout, type VRRegion } from './vr-panel-layout.js';

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
}

const ACCENT = '#4f8cff';
const TEXT = '#e8eaed';
const MUTED_TEXT = '#aab2c0';
// Quest Touch (xr-standard) face buttons: 4 = A/X (lower), 5 = B/Y (upper).
const TOGGLE_BUTTONS = [4, 5];
const IDLE_HIDE_MS = 8000;

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

  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly controllers: THREE.Group[] = [];
  private readonly lasers: THREE.Line[] = [];
  private readonly selectHandlers: (() => void)[] = [];

  private visible = false;
  private hover: VRRegion | null = null;
  private paintKey = '';
  private idleAt = 0;
  private togglePrev = false;

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
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }),
    );
    this.panel.renderOrder = 10;   // always drawn on top of the video sphere
    this.panel.frustumCulled = false;
    this.panel.visible = false;
    this.scene.add(this.panel);

    for (let i = 0; i < 2; i++) {
      const c = this.renderer.xr.getController(i);
      const laser = this.makeLaser();
      laser.visible = false;
      c.add(laser);
      this.scene.add(c);
      const handler = () => this.onSelect(i);
      (c as unknown as { addEventListener(t: string, l: () => void): void }).addEventListener('selectstart', handler);
      this.controllers.push(c);
      this.lasers.push(laser);
      this.selectHandlers.push(handler);
    }

    this.paint(true);
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

    if (!this.visible) { for (const l of this.lasers) l.visible = false; return; }

    // Auto-hide after a spell of no aiming at the panel.
    if (this.idleAt && time > this.idleAt) { this.hide(); return; }

    // Raycast both controllers; the one pointing at the panel wins the hover.
    let hover: VRRegion | null = null;
    for (let i = 0; i < this.controllers.length; i++) {
      const laser = this.lasers[i];
      laser.visible = true;
      const r = this.rayHit(this.controllers[i]);
      laser.scale.z = r.distance;
      if (r.hit) hover = r.hit.region;
    }
    if (hover) this.idleAt = time + IDLE_HIDE_MS; // stay up while actively aimed at
    this.hover = hover;
    this.paint(false);
  }

  /** Ray from a controller against the panel: the region under it (if any) and
   *  how far the laser reaches. */
  private rayHit(controller: THREE.Group): { hit: ReturnType<typeof hitTest>; distance: number } {
    this.tmpMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tmpMatrix);
    const hits = this.raycaster.intersectObject(this.panel, false);
    if (!hits.length || !hits[0].uv) return { hit: null, distance: 5 };
    const uv = hits[0].uv;
    return { hit: hitTest(uv.x * PANEL_W, (1 - uv.y) * PANEL_H, this.layout), distance: hits[0].distance };
  }

  private onSelect(index: number): void {
    if (!this.visible) return;
    const { hit } = this.rayHit(this.controllers[index]);
    if (!hit) return;
    this.idleAt = performanceNow() + IDLE_HIDE_MS;
    switch (hit.region) {
      case 'play': this.actions.togglePlay(); break;
      case 'exit': this.actions.exitVR(); break;
      case 'seek': if (hit.value !== undefined) this.actions.seekFraction(hit.value); break;
      case 'volume':
        if (hit.value !== undefined) this.actions.setVolume(hit.value);
        else this.actions.toggleMute();
        break;
    }
    this.paint(true);
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
    this.visible = true;
    this.panel.visible = true;
    this.idleAt = performanceNow() + IDLE_HIDE_MS;
    this.paint(true);
  }

  private hide(): void {
    this.visible = false;
    this.panel.visible = false;
    for (const l of this.lasers) l.visible = false;
  }

  /** World-lock the panel in front of the current head pose (the "recenter"): a
   *  little below eye line, facing the viewer. Re-run on every summon. */
  private place(): void {
    const cam = this.renderer.xr.getCamera();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    cam.getWorldPosition(pos);
    cam.getWorldQuaternion(quat);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    this.panel.position.copy(pos).addScaledVector(forward, 1.6);
    this.panel.position.y -= 0.28;
    this.panel.quaternion.copy(quat); // plane front (+Z) faces back toward the viewer
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
    const key = [this.actions.isPlaying(), Math.floor(cur), Math.floor(dur), vol.toFixed(2), muted, this.hover, this.actions.title()].join('|');
    if (!force && key === this.paintKey) return;
    this.paintKey = key;

    const c = this.ctx, L = this.layout;
    c.clearRect(0, 0, PANEL_W, PANEL_H);

    // Slab
    this.roundRect(0, 0, PANEL_W, PANEL_H, 28);
    c.fillStyle = 'rgba(22,24,30,0.84)'; c.fill();
    c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,0.08)'; c.stroke();

    // Title
    const title = this.actions.title();
    if (title) {
      c.fillStyle = TEXT; c.font = '600 30px system-ui,"Segoe UI",Roboto,sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(title, PANEL_W / 2, L.title.y + L.title.h / 2, PANEL_W - 240);
    }

    // Exit pill
    this.roundRect(L.exit.x, L.exit.y, L.exit.w, L.exit.h, 26);
    c.fillStyle = this.hover === 'exit' ? ACCENT : 'rgba(255,255,255,0.12)'; c.fill();
    c.fillStyle = this.hover === 'exit' ? '#fff' : TEXT;
    c.font = '600 24px system-ui,sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('Exit VR', L.exit.x + L.exit.w / 2, L.exit.y + L.exit.h / 2);

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
    for (let i = 0; i < this.controllers.length; i++) {
      const c = this.controllers[i];
      (c as unknown as { removeEventListener(t: string, l: () => void): void }).removeEventListener('selectstart', this.selectHandlers[i]);
      c.remove(this.lasers[i]);
      this.lasers[i].geometry.dispose();
      (this.lasers[i].material as THREE.Material).dispose();
      this.scene.remove(c);
    }
    this.scene.remove(this.panel);
    this.panel.geometry.dispose();
    (this.panel.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}

/** performance.now(), but tolerant of environments without it (tests). */
function performanceNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}
