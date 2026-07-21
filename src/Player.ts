import { StereoScene } from './core/StereoScene.js';
import { LookControls } from './core/LookControls.js';
import { VideoSource } from './core/VideoSource.js';
import { buildProxyUrl, type ProxyConfig } from './core/proxy.js';
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
  private native = false;
  private tainted = false;              // current video loaded via CORS-fallback (crossOrigin removed)
  private displayMode: Projection | 'off';
  private loading = false;
  private proxyConfig?: ProxyConfig;
  private useProxy = false;
  private currentSrc?: string;

  constructor(container: HTMLElement, options: PlayerOptions = {}) {
    this.opts = options;
    this.proxyConfig = options.proxy;
    this.useProxy = !!options.proxy;
    const stored = options.persistSettings ? this.loadSettings() : null;
    this.view = {
      projection: options.projection ?? stored?.projection ?? '180-sbs',
      swapEyes: options.swapEyes ?? stored?.swapEyes ?? false,
      fov: options.fov ?? stored?.fov ?? 70,
      supersampling: options.supersampling ?? stored?.supersampling ?? 1.5,
    };
    this.displayMode = this.view.projection;

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
    if (options.title) this.scene.setVRTitle(options.title);
    this.look = new LookControls(this.scene.camera, this.canvas, { isPresenting: () => this.scene.renderer.xr.isPresenting });
    this.scene.onFrame(() => this.look.update());
    this.look.setEnabled(!this.scene.isFlat());

    if (options.controls !== false) {
      this.ui = new ControlsUI(root, {
        video: this.video,
        surface: this.canvas,
        fullscreenTarget: this.wrap,
        vrSupported: () => this.vrSupported(),
        enterVR: () => this.enterVR(),
        exitVR: () => this.scene.exitVR(),
        isPresenting: () => this.scene.renderer.xr.isPresenting,
        onVrChange: (cb) => { this.on('enterxr', () => cb(true)); this.on('exitxr', () => cb(false)); },
        getProjection: () => this.displayMode,
        setProjection: (p) => this.setProjection(p),
        setSwapEyes: (v) => this.setSwapEyes(v),
        setFov: (d) => this.setFov(d),
        setSupersampling: (x) => this.setSupersampling(x),
        initial: { swapEyes: this.view.swapEyes, fov: this.view.fov, supersampling: this.view.supersampling },
        proxy: { url: this.proxyConfig?.url ?? '', apiPassword: this.proxyConfig?.apiPassword ?? '', enabled: this.useProxy },
        setProxy: (p) => this.setProxy(p),
      });
    }

    this.video.addEventListener('play', () => this.emit('play'));
    this.video.addEventListener('pause', () => this.emit('pause'));
    this.video.addEventListener('ended', () => this.emit('ended'));
    this.video.addEventListener('timeupdate', () => this.emit('timeupdate', this.video.currentTime));
    this.video.addEventListener('error', () => { if (!this.loading) this.emit('error', this.video.error); });
    this.video.addEventListener('loadedmetadata', () => { if (!this.readyEmitted) { this.readyEmitted = true; this.emit('ready'); } });
    this.scene.renderer.xr.addEventListener('sessionstart', () => this.emit('enterxr'));
    this.scene.renderer.xr.addEventListener('sessionend', () => this.emit('exitxr'));
    // Arm the headset/browser's own "Enter VR" affordance when immersive VR is available.
    void this.vrSupported().then((ok) => { if (ok) this.scene.offerVR(); });

    if (options.src) void this.load(options.src, { projection: options.projection });
  }

  private vrSupported(): Promise<boolean> {
    if (this.opts.vrButton === false || !navigator.xr) return Promise.resolve(false);
    return navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  }

  /** Whether immersive-ar (passthrough) is available — used for alpha/fisheye content. */
  arSupported(): Promise<boolean> {
    if (!navigator.xr) return Promise.resolve(false);
    return navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  }

  async load(src: string, o: { projection?: Projection } = {}): Promise<void> {
    this.currentSrc = src;
    const proj = o.projection ?? (this.opts.autoDetect !== false ? detectProjection(src) : null);
    if (proj) this.applyProjectionGeometry(proj);
    // Packed alpha matte (fisheye passthrough): explicit option, else DeoVR's `_ALPHA` filename marker.
    this.scene.setAlphaMatte(this.opts.alpha ?? /_alpha/i.test(src));
    if (this.displayMode !== 'off') this.displayMode = this.view.projection;
    const { url, format } = buildProxyUrl(src, this.useProxy ? this.proxyConfig : undefined);
    const primaryCO = this.opts.crossOrigin === undefined ? 'anonymous' : this.opts.crossOrigin;
    this.loading = true;
    try {
      await this.source.attach(this.video, { url, format }, { crossOrigin: primaryCO });
      this.tainted = false;
      this.applyDisplay();
      await this.video.play().catch(() => { /* autoplay may be blocked until a user gesture */ });
    } catch (err) {
      // A cross-origin progressive source that isn't CORS-clean (and isn't proxied) can't be a
      // WebGL texture. Retry without crossOrigin and show plain 2D <video> playback if allowed.
      if (this.opts.nativeFallback !== false && format === 'progressive' && primaryCO !== null) {
        try {
          this.tainted = true;
          this.setNativeFallback(true); // stop WebGL rendering before the tainted video loads
          await this.source.attach(this.video, { url, format }, { crossOrigin: null });
          await this.video.play().catch(() => {});
          this.emit('fallback');
          return;
        } catch (err2) {
          this.tainted = false;
          this.setNativeFallback(false);
          this.emit('error', err2);
          throw err2;
        }
      }
      this.setNativeFallback(false);
      this.emit('error', err);
      throw err;
    } finally {
      this.loading = false;
    }
  }

  /** Swap between WebGL (3D) rendering and plain 2D `<video>` playback. */
  private setNativeFallback(on: boolean) {
    if (on === this.native) return;
    this.native = on;
    if (on) {
      this.scene.pauseRendering();
      this.canvas.style.display = 'none';
      Object.assign(this.video.style, {
        display: 'block', position: 'absolute', inset: '0',
        width: '100%', height: '100%', objectFit: 'contain', background: '#000', zIndex: '1',
      });
    } else {
      this.canvas.style.display = '';
      this.video.style.cssText = '';
      this.scene.resumeRendering();
    }
  }

  async play() { await this.video.play(); }
  pause() { this.video.pause(); }
  /** Set the display mode: a geometry projection (WebGL 3D) or 'off' for plain 2D `<video>`. */
  setProjection(p: Projection | 'off') {
    if (p === 'off') {
      this.displayMode = 'off';
      this.setNativeFallback(true);
      this.emit('projectionchange', p);
      return;
    }
    this.displayMode = p;
    this.applyProjectionGeometry(p);
    // A CORS-tainted (native-fallback) video can't be a WebGL texture — reload to re-attempt 3D.
    if (this.tainted && this.currentSrc) void this.load(this.currentSrc);
    else this.setNativeFallback(false);
    this.emit('projectionchange', p);
  }
  private applyProjectionGeometry(p: Projection) {
    this.scene.setProjection(p);
    this.look.setEnabled(!this.scene.isFlat());
    this.look.reset();
    this.view.projection = p; this.persist();
  }
  private applyDisplay() { this.setNativeFallback(this.displayMode === 'off'); }
  setSwapEyes(v: boolean) { this.scene.setSwapEyes(v); this.view.swapEyes = v; this.persist(); }
  setFov(deg: number) { this.scene.setFov(deg); this.view.fov = deg; this.persist(); }
  setSupersampling(x: number) { this.scene.setSupersampling(x); this.view.supersampling = x; this.persist(); }
  /** Update the CORS proxy config / toggle it, and reload the current source if any. */
  setProxy(p: { url: string; apiPassword?: string; enabled: boolean }) {
    this.proxyConfig = p.url ? { url: p.url, apiPassword: p.apiPassword || undefined } : undefined;
    this.useProxy = p.enabled;
    if (this.currentSrc) void this.load(this.currentSrc);
  }

  /** Enter immersive VR. Rejects if the WebXR session request fails (e.g. no headset,
   *  or a non-secure origin) — the built-in controls surface the reason as a toast. */
  async enterVR() { await this.scene.enterVR(); }
  /** Enter immersive AR (passthrough) — for alpha/fisheye content. */
  async enterAR() { await this.scene.enterAR(); }
  exitVR() { this.scene.exitVR(); }

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
