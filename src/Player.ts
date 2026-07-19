import { StereoScene } from './core/StereoScene.js';
import { LookControls } from './core/LookControls.js';
import { VideoSource } from './core/VideoSource.js';
import { buildProxyUrl } from './core/proxy.js';
import { detectProjection } from './core/projections.js';
import { ControlsUI } from './ui/ControlsUI.js';
import css from './ui/controls.css?inline';
import type { PlayerOptions, PlayerEvent, Projection } from './types.js';

type ViewSettings = { projection: Projection; swapEyes: boolean; fov: number; supersampling: number };
const STORE_KEY = 'three-vr-player:settings';

/**
 * A drop-in 3D/VR video player. Mounts a canvas + controls (into a Shadow DOM by
 * default) inside `container`, composing the headless core.
 */
export class Player {
  readonly video: HTMLVideoElement;

  private readonly opts: PlayerOptions;
  private readonly wrap: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly scene: StereoScene;
  private readonly look: LookControls;
  private readonly source = new VideoSource();
  private readonly ui?: ControlsUI;
  private readonly listeners = new Map<PlayerEvent, Set<(p?: unknown) => void>>();
  private view: ViewSettings;
  private readyEmitted = false;

  constructor(container: HTMLElement, options: PlayerOptions = {}) {
    this.opts = options;
    const stored = options.persistSettings ? this.loadSettings() : null;
    this.view = {
      projection: options.projection ?? stored?.projection ?? '180-sbs',
      swapEyes: options.swapEyes ?? stored?.swapEyes ?? false,
      fov: options.fov ?? stored?.fov ?? 70,
      supersampling: options.supersampling ?? stored?.supersampling ?? 1.5,
    };

    this.wrap = document.createElement('div');
    this.wrap.className = 'tvp';
    this.wrap.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
    container.appendChild(this.wrap);

    let root: ParentNode;
    if (options.shadowDom !== false) {
      const shadow = this.wrap.attachShadow({ mode: 'open' });
      const style = document.createElement('style'); style.textContent = css; shadow.appendChild(style);
      root = shadow;
    } else {
      if (!document.getElementById('tvp-styles')) {
        const style = document.createElement('style'); style.id = 'tvp-styles'; style.textContent = css; document.head.appendChild(style);
      }
      root = this.wrap;
    }

    this.canvas = document.createElement('canvas'); this.canvas.className = 'tvp-canvas';
    this.video = document.createElement('video'); this.video.className = 'tvp-video'; this.video.playsInline = true;
    if (options.crossOrigin !== null) this.video.crossOrigin = options.crossOrigin ?? 'anonymous';
    root.append(this.canvas, this.video);

    this.scene = new StereoScene({
      canvas: this.canvas, video: this.video,
      projection: this.view.projection, swapEyes: this.view.swapEyes,
      fov: this.view.fov, supersampling: this.view.supersampling,
    });
    this.look = new LookControls(this.scene.camera, this.canvas, { isPresenting: () => this.scene.renderer.xr.isPresenting });
    this.scene.onFrame(() => this.look.update());
    this.look.setEnabled(!this.scene.isFlat());

    if (options.controls !== false) {
      this.ui = new ControlsUI(root, {
        video: this.video,
        surface: this.canvas,
        fullscreenTarget: this.wrap,
        vrButton: this.scene.vrButton,
        vrSupported: () => this.vrSupported(),
        getProjection: () => this.scene.getProjection(),
        setProjection: (p) => this.setProjection(p),
        setSwapEyes: (v) => this.setSwapEyes(v),
        setFov: (d) => this.setFov(d),
        setSupersampling: (x) => this.setSupersampling(x),
        initial: { swapEyes: this.view.swapEyes, fov: this.view.fov, supersampling: this.view.supersampling },
      });
    }

    this.video.addEventListener('play', () => this.emit('play'));
    this.video.addEventListener('pause', () => this.emit('pause'));
    this.video.addEventListener('ended', () => this.emit('ended'));
    this.video.addEventListener('timeupdate', () => this.emit('timeupdate', this.video.currentTime));
    this.video.addEventListener('error', () => this.emit('error', this.video.error));
    this.video.addEventListener('loadedmetadata', () => { if (!this.readyEmitted) { this.readyEmitted = true; this.emit('ready'); } });
    this.scene.renderer.xr.addEventListener('sessionstart', () => this.emit('enterxr'));
    this.scene.renderer.xr.addEventListener('sessionend', () => this.emit('exitxr'));

    if (options.src) void this.load(options.src, { projection: options.projection });
  }

  private vrSupported(): Promise<boolean> {
    if (this.opts.vrButton === false || !navigator.xr) return Promise.resolve(false);
    return navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  }

  async load(src: string, o: { projection?: Projection } = {}): Promise<void> {
    const proj = o.projection ?? (this.opts.autoDetect !== false ? detectProjection(src) : null);
    if (proj) this.setProjection(proj);
    const { url, format } = buildProxyUrl(src, this.opts.proxy);
    try {
      await this.source.attach(this.video, { url, format });
      await this.video.play().catch(() => { /* autoplay may be blocked until a user gesture */ });
    } catch (err) { this.emit('error', err); throw err; }
  }

  async play() { await this.video.play(); }
  pause() { this.video.pause(); }
  setProjection(p: Projection) {
    this.scene.setProjection(p);
    this.look.setEnabled(!this.scene.isFlat());
    this.look.reset();
    this.view.projection = p; this.persist();
    this.emit('projectionchange', p);
  }
  setSwapEyes(v: boolean) { this.scene.setSwapEyes(v); this.view.swapEyes = v; this.persist(); }
  setFov(deg: number) { this.scene.setFov(deg); this.view.fov = deg; this.persist(); }
  setSupersampling(x: number) { this.scene.setSupersampling(x); this.view.supersampling = x; this.persist(); }

  async enterVR() {
    const btn = this.scene.vrButton as HTMLButtonElement;
    btn?.click?.();
  }

  get three() { return { renderer: this.scene.renderer, scene: this.scene.scene, camera: this.scene.camera }; }

  on(e: PlayerEvent, cb: (p?: unknown) => void) {
    let s = this.listeners.get(e); if (!s) { s = new Set(); this.listeners.set(e, s); } s.add(cb); return this;
  }
  off(e: PlayerEvent, cb: (p?: unknown) => void) { this.listeners.get(e)?.delete(cb); return this; }
  private emit(e: PlayerEvent, p?: unknown) { this.listeners.get(e)?.forEach((cb) => cb(p)); }

  private persist() {
    if (!this.opts.persistSettings) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.view)); } catch { /* private mode */ }
  }
  private loadSettings(): Partial<ViewSettings> | null {
    try { const raw = localStorage.getItem(STORE_KEY); return raw ? JSON.parse(raw) as Partial<ViewSettings> : null; }
    catch { return null; }
  }

  dispose() {
    this.ui?.dispose(); this.look.dispose(); this.source.dispose(); this.scene.dispose();
    this.video.remove(); this.canvas.remove(); this.wrap.remove(); this.listeners.clear();
  }
}
