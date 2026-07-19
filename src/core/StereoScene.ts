import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import type { Projection } from '../types.js';
import { MODES } from './projections.js';

/**
 * Maps a video onto the geometry for a chosen projection (inside-out 180/360
 * sphere or a flat screen plane) and packs stereo eyes via UV split + WebXR
 * layers. Sizes to its canvas's container (not the window), for embedding.
 */
export class StereoScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly vrButton: HTMLElement;
  readonly maxAnisotropy: number;

  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly texture: THREE.VideoTexture;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly frameCbs: (() => void)[] = [];
  private readonly ro: ResizeObserver;
  private currentMode: Projection;
  private currentSwap: boolean;

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
    this.camera.layers.enable(1); // desktop shows Layer 1 (left eye) for stereo modes

    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.texture = new THREE.VideoTexture(video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = this.maxAnisotropy;

    this.applyProjection(this.currentMode, this.currentSwap);
    video.addEventListener('loadedmetadata', () => {
      if (MODES[this.currentMode].flat) this.applyProjection(this.currentMode, this.currentSwap);
    });

    this.renderer.setAnimationLoop(() => {
      for (const cb of this.frameCbs) cb();
      this.renderer.render(this.scene, this.camera);
    });
    this.vrButton = VRButton.createButton(this.renderer);

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
    const kind = MODES[mode].geom;
    if (kind === 'sphere180') { const g = new THREE.SphereGeometry(500, 60, 40, -Math.PI, Math.PI, 0, Math.PI); g.scale(-1, 1, 1); return g; }
    if (kind === 'sphere360') { const g = new THREE.SphereGeometry(500, 60, 40); g.scale(-1, 1, 1); return g; }
    const h = 2.4, w = h * this.planeAspect(mode);
    const g = new THREE.PlaneGeometry(w, h); g.translate(0, 0, -2); return g;
  }

  private splitUV(geo: THREE.BufferGeometry, split: string, eye: 'left' | 'right') {
    if (split === 'mono') return;
    const uv = geo.attributes.uv.array as Float32Array;
    for (let i = 0; i < uv.length; i += 2) {
      if (split === 'sbs') uv[i] = uv[i] * 0.5 + (eye === 'right' ? 0.5 : 0);
      else if (split === 'tb') uv[i + 1] = uv[i + 1] * 0.5 + (eye === 'left' ? 0.5 : 0); // top = left
    }
    geo.attributes.uv.needsUpdate = true;
  }

  private clearMeshes() {
    for (const m of this.meshes) { this.scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.meshes.length = 0;
  }

  private applyProjection(mode: Projection, swap: boolean) {
    if (!MODES[mode]) mode = '180-sbs';
    this.clearMeshes();
    const cfg = MODES[mode];
    if (!cfg.stereo) {
      const m = new THREE.Mesh(this.buildGeometry(mode), new THREE.MeshBasicMaterial({ map: this.texture }));
      m.layers.set(0); // mono: desktop + both XR eyes
      this.scene.add(m); this.meshes.push(m);
    } else {
      const gL = this.buildGeometry(mode); this.splitUV(gL, cfg.split, 'left');
      const gR = this.buildGeometry(mode); this.splitUV(gR, cfg.split, 'right');
      const mL = new THREE.Mesh(gL, new THREE.MeshBasicMaterial({ map: this.texture }));
      const mR = new THREE.Mesh(gR, new THREE.MeshBasicMaterial({ map: this.texture }));
      mL.layers.set(swap ? 2 : 1); mR.layers.set(swap ? 1 : 2);
      this.scene.add(mL, mR); this.meshes.push(mL, mR);
    }
    this.currentMode = mode; this.currentSwap = swap;
  }

  setProjection(p: Projection) { this.applyProjection(p, this.currentSwap); }
  setSwapEyes(v: boolean) { this.applyProjection(this.currentMode, v); }
  setFov(deg: number) { this.camera.fov = deg; this.camera.updateProjectionMatrix(); }
  setSupersampling(ss: number) { this.renderer.setPixelRatio(this.pixelRatioFor(ss)); this.renderer.setSize(this.w(), this.h(), false); }
  getProjection() { return this.currentMode; }
  isFlat() { return !!MODES[this.currentMode].flat; }
  onFrame(cb: () => void) { this.frameCbs.push(cb); }

  resize = () => {
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
