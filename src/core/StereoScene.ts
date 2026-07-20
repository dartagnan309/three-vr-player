import * as THREE from 'three';
import type { Projection } from '../types.js';
import { MODES } from './projections.js';

/**
 * Maps a video onto the geometry for a chosen projection (inside-out 180/360
 * sphere or a flat screen plane). Stereo is done the way the reference VR180
 * players do it: a single mesh, with the shared video texture shifted per eye
 * in onBeforeRender (no per-eye meshes or camera layers). Sizes to its canvas's
 * container (not the window), for embedding.
 */
export class StereoScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly maxAnisotropy: number;

  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly texture: THREE.VideoTexture;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly frameCbs: (() => void)[] = [];
  private readonly animate = () => {
    for (const cb of this.frameCbs) cb();
    // Upload the current video frame synchronously, before the render, every frame. This
    // is load-bearing on the Quest: without it, VideoTexture's own async (video-frame-
    // callback) upload can land mid-render during an XR eye pass and corrupt the triangles
    // being drawn — the "hard triangle edges popping to black". Reference VR180 players do
    // the same. (Yes, it re-uploads at headset rate; that's the cost of a stable image.)
    if (this.video.readyState >= this.video.HAVE_CURRENT_DATA) this.texture.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  };
  private readonly ro: ResizeObserver;
  private currentMode: Projection;
  private currentSwap: boolean;
  // local-floor as OPTIONAL (widest device support — don't hard-fail headsets without it).
  // Deliberately NOT requesting 'layers': it flips three.js to an XRProjectionLayer depth
  // path that flickers on the Quest.
  private readonly vrSessionInit: XRSessionInit = { optionalFeatures: ['local-floor'] };

  constructor(opts: {
    canvas: HTMLCanvasElement; video: HTMLVideoElement;
    projection?: Projection; swapEyes?: boolean; fov?: number; supersampling?: number;
  }) {
    const { canvas, video, projection = '180-sbs', swapEyes = false, fov = 70, supersampling = 1.5 } = opts;
    this.canvas = canvas;
    this.video = video;
    this.currentMode = MODES[projection] ? projection : '180-sbs';
    this.currentSwap = swapEyes;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(this.pixelRatioFor(supersampling));
    this.renderer.setSize(this.w(), this.h(), false);
    this.renderer.xr.enabled = true;

    this.camera = new THREE.PerspectiveCamera(fov, this.w() / this.h(), 0.1, 1000);
    this.camera.position.set(0, 0, 0);

    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.texture = new THREE.VideoTexture(video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    // Keep anisotropy at the default (1). Cranking it to max makes the equirect video
    // sphere shimmer/flicker at grazing angles (the upper part of the view) once the head
    // moves in VR — the reference VR180 players leave it at the default. maxAnisotropy is
    // still exposed on the instance for consumers who want to opt back in.
    this.texture.anisotropy = 1;

    this.applyProjection(this.currentMode, this.currentSwap);
    video.addEventListener('loadedmetadata', () => {
      if (MODES[this.currentMode].flat) this.applyProjection(this.currentMode, this.currentSwap);
    });

    this.renderer.setAnimationLoop(this.animate);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }

  private w() { return this.canvas.clientWidth || 1; }
  private h() { return this.canvas.clientHeight || 1; }
  private pixelRatioFor(ss: number) { return Math.min(window.devicePixelRatio * ss, 4); }

  private planeAspect(mode: Projection) {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return 16 / 9;
    return MODES[mode].aspect === 'per-eye' ? (vw / 2) / vh : vw / vh;
  }

  private buildGeometry(mode: Projection): THREE.BufferGeometry {
    // Match the reference VR180 geometry: 64×32 sphere, front gore at phiStart -π/2.
    const kind = MODES[mode].geom;
    if (kind === 'sphere180') { const g = new THREE.SphereGeometry(500, 64, 32, -Math.PI / 2, Math.PI, 0, Math.PI); g.scale(-1, 1, 1); return g; }
    if (kind === 'sphere360') { const g = new THREE.SphereGeometry(500, 64, 32); g.scale(-1, 1, 1); return g; }
    const h = 2.4, w = h * this.planeAspect(mode);
    const g = new THREE.PlaneGeometry(w, h); g.translate(0, 0, -2); return g;
  }

  /** Shift the shared video texture for the eye/half being drawn. Runs from the mesh's
   *  onBeforeRender, so it's called once per eye per frame (the reference approach). */
  private updateStereoUV(cam: THREE.Camera) {
    const map = this.texture;
    const split = MODES[this.currentMode].split;
    // Robust eye detection (the reference player's cascade): direct camera-ref match, then
    // view-matrix X, then projection asymmetry — so a frame never gets the wrong half.
    let isLeft = true;
    if (this.renderer.xr.isPresenting) {
      const c = cam as THREE.PerspectiveCamera;
      const cams = (this.renderer.xr.getCamera() as unknown as { cameras?: THREE.PerspectiveCamera[] }).cameras;
      if (cams && cams.length >= 2) {
        if (c === cams[0]) isLeft = true;
        else if (c === cams[1]) isLeft = false;
        else isLeft = Math.abs(c.matrixWorldInverse.elements[12] - cams[0].matrixWorldInverse.elements[12])
          <= Math.abs(c.matrixWorldInverse.elements[12] - cams[1].matrixWorldInverse.elements[12]);
      } else {
        isLeft = c.projectionMatrix.elements[8] <= 0;
      }
    }
    const second = !isLeft !== this.currentSwap; // this eye shows the 2nd half (right / bottom)
    if (split === 'sbs') { map.repeat.set(0.5, 1); map.offset.set(second ? 0.5 : 0, 0); }
    else if (split === 'tb') { map.repeat.set(1, 0.5); map.offset.set(0, second ? 0 : 0.5); }
    else { map.repeat.set(1, 1); map.offset.set(0, 0); }
  }

  private clearMeshes() {
    for (const m of this.meshes) { this.scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.meshes.length = 0;
  }

  private applyProjection(mode: Projection, swap: boolean) {
    if (!MODES[mode]) mode = '180-sbs';
    this.clearMeshes();
    this.currentMode = mode; this.currentSwap = swap;
    // One mesh (reference approach), plain FrontSide MeshBasicMaterial. Stereo is handled
    // per eye by updateStereoUV via onBeforeRender — not by per-eye meshes or camera layers.
    const mesh = new THREE.Mesh(this.buildGeometry(mode), new THREE.MeshBasicMaterial({ map: this.texture }));
    mesh.layers.set(0); // desktop + both XR eyes see the single mesh
    if (MODES[mode].geom === 'sphere180') mesh.rotation.y = Math.PI / 2; // orient the 180 gore forward
    mesh.onBeforeRender = (_r, _s, cam) => this.updateStereoUV(cam);
    this.scene.add(mesh); this.meshes.push(mesh);
  }

  setProjection(p: Projection) { this.applyProjection(p, this.currentSwap); }
  setSwapEyes(v: boolean) { this.applyProjection(this.currentMode, v); }
  setFov(deg: number) { this.camera.fov = deg; this.camera.updateProjectionMatrix(); }
  setSupersampling(ss: number) { this.renderer.setPixelRatio(this.pixelRatioFor(ss)); this.renderer.setSize(this.w(), this.h(), false); }
  getProjection() { return this.currentMode; }
  isFlat() { return !!MODES[this.currentMode].flat; }
  onFrame(cb: () => void) { this.frameCbs.push(cb); }
  pauseRendering() { this.renderer.setAnimationLoop(null); }
  resumeRendering() { this.renderer.setAnimationLoop(this.animate); }

  /** Enter immersive VR. Rejects with a readable message on failure so the caller can
   *  surface it — instead of the silent no-op three.js's VRButton produces. Called from
   *  a click handler so the request keeps the user's transient activation. */
  async enterVR(): Promise<void> {
    if (!navigator.xr) throw new Error('WebXR is unavailable here — open the page over HTTPS or localhost.');
    const session = await navigator.xr.requestSession('immersive-vr', this.vrSessionInit);
    await this.renderer.xr.setSession(session);
  }
  exitVR(): void { void this.renderer.xr.getSession()?.end(); }
  /** Arm the browser/headset's own "Enter VR" affordance (e.g. the Quest system button). */
  offerVR(): void {
    const offer = (navigator.xr as { offerSession?: (m: XRSessionMode, i: XRSessionInit) => Promise<XRSession> } | undefined)?.offerSession;
    if (!offer) return;
    const run = () => offer.call(navigator.xr, 'immersive-vr', this.vrSessionInit)
      .then((s) => this.renderer.xr.setSession(s))
      .catch(() => { /* the UA declined the offer or the user dismissed it */ });
    this.renderer.xr.addEventListener('sessionend', () => void run());
    void run();
  }

  resize = () => {
    if (this.renderer.xr.isPresenting) return; // never resize while the headset drives the size
    const w = this.w(), h = this.h();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  };

  dispose() {
    this.ro.disconnect();
    this.renderer.setAnimationLoop(null);
    this.texture.dispose();
    this.clearMeshes();
    this.renderer.dispose();
  }
}
