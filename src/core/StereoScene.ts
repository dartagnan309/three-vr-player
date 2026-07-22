import * as THREE from 'three';
import type { Projection } from '../types.js';
import { MODES } from './projections.js';
import { VRControls } from './VRControls.js';
import type { SettingsKey } from './vr-panel-layout.js';


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
  // Holds the video mesh(es); tilt (pitch) and zoom (scale) are applied here so the
  // in-VR panel/controllers (added straight to the scene) aren't affected.
  private readonly rig = new THREE.Group();
  private tilt = 0;        // radians (rig pitch)
  private fov = 1;         // content field-of-view factor: 1 = full immersive, <1 = smaller/farther window
  private builtFov = 1;    // fov the current geometry was built at (rebuild throttle)
  private readonly frameCbs: (() => void)[] = [];
  private alphaFisheye = false;   // content has a DeoVR-style packed alpha matte
  private inPassthroughSession = false; // current XR session is immersive-ar (non-opaque blend)
  private passthroughOn = true;   // passthrough on = real world visible (alpha content also keys the subject)
  // Uniforms shared with the alpha-fisheye shader; uPtShift/uTexel updated each eye in updateStereoUV.
  private alphaUniforms?: { uPtShift: { value: number }; uTexel: { value: THREE.Vector2 }; uAlphaEnabled: { value: number } };
  private vrControls?: VRControls;
  private disposed = false;
  private offerCleanup?: () => void;   // removes the offerVR re-offer listener on dispose
  private resetCleanup?: () => void;   // removes the reference-space 'reset' listener on session end
  private readonly animate = (time?: number) => {
    for (const cb of this.frameCbs) cb();
    this.vrControls?.update(time ?? 0);
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
  // We use a 'local' (eye-level) reference space — set on the renderer below — so content
  // centres on the horizon instead of sitting at floor height. Deliberately NOT requesting
  // 'layers': it flips three.js to an XRProjectionLayer depth path that flickers on the Quest.
  private readonly vrSessionInit: XRSessionInit = {};
  // immersive-ar for passthrough: the UA turns on camera passthrough (alpha-blend / additive
  // blend mode) for the session automatically; no extra session features are needed.
  private readonly arSessionInit: XRSessionInit = {};

  constructor(opts: {
    canvas: HTMLCanvasElement; video: HTMLVideoElement;
    projection?: Projection; swapEyes?: boolean; fov?: number; supersampling?: number;
  }) {
    const { canvas, video, projection = '180-sbs', swapEyes = false, fov = 70, supersampling = 1.5 } = opts;
    this.canvas = canvas;
    this.video = video;
    this.currentMode = MODES[projection] ? projection : '180-sbs';
    this.currentSwap = swapEyes;

    // alpha:true so the framebuffer can be transparent for immersive-ar passthrough. Keep the
    // clear fully opaque black otherwise (VR + desktop are unaffected); AR flips clearAlpha to 0.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setPixelRatio(this.pixelRatioFor(supersampling));
    this.renderer.setSize(this.w(), this.h(), false);
    this.renderer.xr.enabled = true;
    // Eye-level origin: the default 'local-floor' space puts the origin on the floor, so a flat
    // screen at y=0 renders ~1.6 m below the viewer. 'local' centres content on the horizon.
    this.renderer.xr.setReferenceSpaceType('local');

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

    this.rig.rotation.order = 'YXZ'; // yaw then pitch, so grab-rotate composes naturally
    this.scene.add(this.rig);
    this.applyProjection(this.currentMode, this.currentSwap);
    video.addEventListener('loadedmetadata', () => {
      if (MODES[this.currentMode].flat) this.applyProjection(this.currentMode, this.currentSwap);
    });

    this.renderer.setAnimationLoop(this.animate);

    // In-VR controls live only for the duration of an immersive session: the DOM
    // control bar isn't visible inside the headset, so we draw a panel in the scene.
    this.renderer.xr.addEventListener('sessionstart', () => {
      // Passthrough sessions (immersive-ar) report a non-opaque blend mode; start with
      // passthrough on (transparent clear + keyed matte) so the real world shows through.
      const blend = (this.renderer.xr.getSession() as unknown as { environmentBlendMode?: string })?.environmentBlendMode;
      this.inPassthroughSession = !!(blend && blend !== 'opaque');
      if (this.inPassthroughSession) this.setPassthrough(true);
      this.buildVRControls();
      this.bindReferenceReset(); // react to the user's system (headset) recenter
    });
    this.renderer.xr.addEventListener('sessionend', () => {
      this.renderer.setClearAlpha(1); // restore opaque clear for desktop / next VR session
      this.inPassthroughSession = false;
      this.resetCleanup?.(); this.resetCleanup = undefined;
      this.vrControls?.dispose(); this.vrControls = undefined;
      this.video.pause(); // stop playback when leaving VR
    });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }

  private buildVRControls() {
    const v = this.video;
    this.vrControls = new VRControls({
      renderer: this.renderer,
      scene: this.scene,
      actions: {
        isPlaying: () => !v.paused,
        currentTime: () => v.currentTime,
        duration: () => v.duration || 0,
        volume: () => v.volume,
        muted: () => v.muted,
        title: () => this.vrTitle,
        togglePlay: () => { if (v.paused) void v.play(); else v.pause(); },
        seekFraction: (f) => { if (v.duration) v.currentTime = f * v.duration; },
        setVolume: (x) => { v.volume = x; if (x > 0) v.muted = false; },
        toggleMute: () => { v.muted = !v.muted; },
        exitVR: () => this.exitVR(),
        recenter: () => this.recenter(),
        adjustTilt: (d) => this.adjustTilt(d),
        adjustYaw: (d) => this.adjustYaw(d),
        adjustZoom: (d) => this.adjustZoom(d),
        passthroughAvailable: () => this.inPassthroughSession, // any AR session, not just alpha content
        passthroughEnabled: () => this.passthroughOn,
        togglePassthrough: () => this.setPassthrough(!this.passthroughOn),
        currentProjection: () => this.currentMode,
        setProjection: (p) => this.requestProjection(p),
        viewParam: (k) => this.viewParam(k),
        setView: (k, v) => this.setView(k, v),
        resetView: () => this.resetView(),
      },
    });
  }

  /** Recenter the view: make the viewer's current spot and facing the origin, so the
   *  video front is straight ahead again. Resets yaw and horizontal position; keeps
   *  head height and a level horizon (no pitch/roll). */
  recenter(): void {
    const xr = this.renderer.xr;
    if (!xr.isPresenting) return;
    const baseRef = xr.getReferenceSpace();
    if (!baseRef) return;
    const cam = xr.getCamera();
    const pos = cam.getWorldPosition(new THREE.Vector3());
    const yaw = new THREE.Euler().setFromQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()), 'YXZ').y;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
    const offset = new XRRigidTransform({ x: pos.x, y: 0, z: pos.z }, { x: q.x, y: q.y, z: q.z, w: q.w });
    xr.setReferenceSpace(baseRef.getOffsetReferenceSpace(offset));
    this.bindReferenceReset();       // re-listen on the new offset space
    this.vrControls?.reposition();   // re-lock the panel in front after the recenter
  }

  /** (Re)attach a 'reset' listener to the active reference space so a system (headset)
   *  recenter re-places the world-locked VR panel in front of the viewer. */
  private bindReferenceReset(): void {
    this.resetCleanup?.();
    const ref = this.renderer.xr.getReferenceSpace();
    if (!ref) { this.resetCleanup = undefined; return; }
    const onReset = () => this.vrControls?.reposition();
    ref.addEventListener('reset', onReset);
    this.resetCleanup = () => ref.removeEventListener('reset', onReset);
  }

  /** Optional title shown on the in-VR control panel. */
  setVRTitle(t: string) { this.vrTitle = t; }
  private vrTitle = '';

  private w() { return this.canvas.clientWidth || 1; }
  private h() { return this.canvas.clientHeight || 1; }
  private pixelRatioFor(ss: number) { return Math.min(window.devicePixelRatio * ss, 4); }

  private planeAspect(mode: Projection) {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return 16 / 9;
    const cfg = MODES[mode];
    // 'per-eye' aspect: one eye occupies half the packed frame — SBS halves the width,
    // TB halves the height. 'full' shows the frame at its native aspect (mono / anamorphic).
    if (cfg.aspect === 'per-eye') {
      if (cfg.split === 'tb') return vw / (vh / 2);
      return (vw / 2) / vh;
    }
    return vw / vh;
  }

  private buildGeometry(mode: Projection): THREE.BufferGeometry {
    // 64×32 sphere, front gore centred (reference VR180 geometry). The zoom `fov` factor
    // shrinks the angular cap the video occupies (and the flat plane's size) so the
    // scene recedes into a smaller window and feels farther; fov = 1 is the full frame.
    const kind = MODES[mode].geom, f = this.fov;
    if (kind === 'sphere180') {
      const phiLen = Math.PI * f, thetaLen = Math.PI * f;
      const g = new THREE.SphereGeometry(50, 64, 32, -phiLen / 2, phiLen, Math.PI / 2 - thetaLen / 2, thetaLen);
      g.scale(-1, 1, 1); return g;
    }
    if (kind === 'sphere360') {
      const phiLen = 2 * Math.PI * f, thetaLen = Math.PI * f;
      const g = new THREE.SphereGeometry(50, 64, 32, Math.PI - phiLen / 2, phiLen, Math.PI / 2 - thetaLen / 2, thetaLen);
      g.scale(-1, 1, 1); return g;
    }
    // Zoom shrinks the dome's half-angle (like the spheres' arc), so the fisheye content
    // recedes into a smaller window as f drops; f = 1 is the content's full field of view.
    if (kind === 'fisheye') return this.buildFisheyeDome(((MODES[mode].fisheyeAngle ?? 190) / 2) * f);
    const h = 2.4 * f, w = h * this.planeAspect(mode);
    const g = new THREE.PlaneGeometry(w, h); g.translate(0, 0, -2); return g;
  }

  /**
   * A dome covering the fisheye field of view (FISHEYE190 ≈ 190° → a 95° half-angle cap in
   * front of the viewer), with equidistant-fisheye UVs: the angle from the forward axis maps
   * linearly to radius on the texture disc (centre 0.5,0.5, radius 0.5). UVs are authored in
   * full-frame [0,1] space; updateStereoUV's per-eye repeat/offset selects the L/R circle.
   * Forward is −z (the camera's default view direction), so no extra rotation is needed.
   */
  private buildFisheyeDome(halfAngleDeg = 95): THREE.BufferGeometry {
    const RINGS = 64, SECTORS = 128, R = 50;
    const thetaMax = THREE.MathUtils.degToRad(halfAngleDeg);
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let i = 0; i <= RINGS; i++) {
      const t = i / RINGS;             // 0 at centre (dead ahead), 1 at the rim
      const theta = t * thetaMax;
      const discR = t * 0.5;           // equidistant: disc radius ∝ angle from axis
      const sinT = Math.sin(theta), cosT = Math.cos(theta);
      for (let j = 0; j <= SECTORS; j++) {
        const phi = (j / SECTORS) * Math.PI * 2;
        const cp = Math.cos(phi), sp = Math.sin(phi);
        pos.push(sinT * cp * R, sinT * sp * R, -cosT * R); // forward = −z
        uv.push(0.5 + discR * cp, 0.5 + discR * sp);
      }
    }
    const stride = SECTORS + 1;
    for (let i = 0; i < RINGS; i++) {
      for (let j = 0; j < SECTORS; j++) {
        const a = i * stride + j, b = a + 1, c = a + stride, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /**
   * Transparent material for fisheye content with a DeoVR-style packed alpha matte. Built by
   * patching MeshBasicMaterial (so three.js keeps handling colour management, the map sample and
   * flipY) and injecting DeoVR's exact alpha decode (ported from their WebXR player):
   *
   *   ptUV = fract(vec2(discUV.x*0.2 + ptShift, discUV.y*0.4 + 0.8));   // ptShift 0.4 L / 0.9 R
   *   alpha = smoothstep(0.0, 0.8, average of the 3×3 red neighbourhood at ptUV);
   *
   * The matte is a 0.4×-scaled copy of the disc's alpha stored per eye at that offset, wrapped
   * across the frame edges (hence it appears tucked into the corners). It's indexed by the SAME
   * disc UV as the colour, so it aligns exactly — including per-eye parallax. Outside the disc → clip.
   */
  private makeFisheyeAlphaMaterial(): THREE.MeshBasicMaterial {
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const uniforms = {
      uPtShift: { value: 0.4 },
      uTexel: { value: new THREE.Vector2(1 / 8000, 1 / 4000) },
      uAlphaEnabled: { value: this.passthroughOn ? 1 : 0 }, // 0 → opaque dome (passthrough off)
    };
    this.alphaUniforms = uniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uPtShift = uniforms.uPtShift;
      shader.uniforms.uTexel = uniforms.uTexel;
      shader.uniforms.uAlphaEnabled = uniforms.uAlphaEnabled;
      shader.vertexShader = 'varying vec2 vDiscUv;\n' +
        shader.vertexShader.replace('void main() {', 'void main() {\n\tvDiscUv = uv;');
      shader.fragmentShader =
        'uniform float uPtShift;\nuniform vec2 uTexel;\nuniform float uAlphaEnabled;\nvarying vec2 vDiscUv;\n' +
        shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec2 n = (vDiscUv - 0.5) * 2.0;
          if (dot(n, n) > 1.0) discard;                 // outside the fisheye circle
          vec2 mUv = fract(vec2(vDiscUv.x * 0.2 + uPtShift, vDiscUv.y * 0.4 + 0.8));
          float s = 0.0;                                // DeoVR getMask(): 3x3 red average
          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              s += texture2D(map, mUv + uTexel * vec2(float(dx), float(dy))).r;
            }
          }
          // uAlphaEnabled 1 → keyed matte (passthrough); 0 → fully opaque dome (no passthrough)
          diffuseColor.a *= mix(1.0, smoothstep(0.0, 0.8, s / 9.0), uAlphaEnabled);
        }`);
    };
    return mat;
  }

  /** Passthrough on/off (immersive-ar only): on = real world visible (transparent clear); off =
   *  opaque black surround (VR-style). Alpha content additionally keys the subject via the matte;
   *  without a matte the dome stays opaque and only the surround changes. */
  setPassthrough(on: boolean): void {
    this.passthroughOn = on;
    if (this.alphaUniforms) this.alphaUniforms.uAlphaEnabled.value = on ? 1 : 0;
    const blend = (this.renderer.xr.getSession() as unknown as { environmentBlendMode?: string })?.environmentBlendMode;
    if (blend && blend !== 'opaque') this.renderer.setClearAlpha(on ? 0 : 1);
  }

  /** Mark the current content as carrying a DeoVR-style packed alpha matte (fisheye only). */
  setAlphaMatte(on: boolean) {
    if (this.alphaFisheye === on) return;
    this.alphaFisheye = on;
    this.applyProjection(this.currentMode, this.currentSwap);
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
    // Alpha-fisheye: each eye reads its own packed matte (x-offset 0.4 left / 0.9 right), and
    // the 3×3 getMask blur needs the video's texel size.
    if (this.alphaUniforms) {
      this.alphaUniforms.uPtShift.value = second ? 0.9 : 0.4;
      const vw = this.video.videoWidth, vh = this.video.videoHeight;
      if (vw && vh) this.alphaUniforms.uTexel.value.set(1 / vw, 1 / vh);
    }
  }

  private clearMeshes() {
    for (const m of this.meshes) { this.rig.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.meshes.length = 0;
  }

  private applyProjection(mode: Projection, swap: boolean) {
    if (!MODES[mode]) mode = '180-sbs';
    this.clearMeshes();
    this.currentMode = mode; this.currentSwap = swap;
    // One mesh (reference approach), plain MeshBasicMaterial. Stereo is handled per eye by
    // updateStereoUV via onBeforeRender — not by per-eye meshes or camera layers. Spheres are
    // scaled inside-out (FrontSide); the fisheye dome isn't, so it's viewed as DoubleSide.
    this.alphaUniforms = undefined;
    let material: THREE.Material;
    if (MODES[mode].geom === 'fisheye' && this.alphaFisheye) {
      material = this.makeFisheyeAlphaMaterial();          // transparent, reconstructs packed alpha
    } else {
      const side = MODES[mode].geom === 'fisheye' ? THREE.DoubleSide : THREE.FrontSide;
      material = new THREE.MeshBasicMaterial({ map: this.texture, side });
    }
    const mesh = new THREE.Mesh(this.buildGeometry(mode), material);
    mesh.layers.set(0); // desktop + both XR eyes see the single mesh
    if (MODES[mode].geom === 'sphere180') mesh.rotation.y = Math.PI / 2; // orient the 180 gore forward
    mesh.onBeforeRender = (_r, _s, cam) => this.updateStereoUV(cam);
    this.rig.add(mesh); this.meshes.push(mesh);
  }

  /** Pitch the video content up/down (radians, accumulated and clamped). */
  adjustTilt(delta: number) {
    this.tilt = Math.max(-0.9, Math.min(0.9, this.tilt + delta));
    this.rig.rotation.x = this.tilt;
  }
  /** Yaw the video content left/right (radians, accumulated, unclamped). */
  adjustYaw(delta: number) {
    this.rig.rotation.y += delta;
  }
  /** Zoom by changing the content field of view (positive delta = zoom in / more
   *  immersive). Shrinking the fov maps the video into a smaller angular window so the
   *  scene recedes and feels farther; growing it fills the view. Rebuilds the projection
   *  geometry, throttled so it doesn't churn every frame. */
  adjustZoom(delta: number) {
    const z = StereoScene.VIEW_RANGES.zoom;
    this.fov = Math.max(z.min, Math.min(z.max, this.fov + delta));
    if (Math.abs(this.fov - this.builtFov) >= 0.03) this.rebuildGeometry();
  }

  // ---- Absolute view settings (the in-VR settings popup): zoom/pitch/yaw/height/roll ----
  private static readonly VIEW_RANGES: Record<SettingsKey, { min: number; max: number; step: number }> = {
    zoom:   { min: 0.3, max: 1.5,           step: 0.05 }, // >1 magnifies past the content's natural size
    pitch:  { min: -0.9, max: 0.9,          step: 0.04 },
    yaw:    { min: -Math.PI, max: Math.PI,  step: 0.05 },
    height: { min: -1.5, max: 1.5,          step: 0.05 },
    roll:   { min: -0.6, max: 0.6,          step: 0.03 },
  };

  private viewValue(key: SettingsKey): number {
    if (key === 'zoom') return this.fov;
    if (key === 'pitch') return this.tilt;
    if (key === 'yaw') return this.rig.rotation.y;
    if (key === 'roll') return this.rig.rotation.z;
    return this.rig.position.y; // height
  }

  private applyView(key: SettingsKey, v: number): void {
    if (key === 'zoom') { this.fov = v; if (Math.abs(this.fov - this.builtFov) >= 0.03) this.rebuildGeometry(); }
    else if (key === 'pitch') { this.tilt = v; this.rig.rotation.x = v; }
    else if (key === 'yaw') this.rig.rotation.y = v;
    else if (key === 'roll') this.rig.rotation.z = v;
    else this.rig.position.y = v; // height
  }

  /** Current value + range of a view setting (for the in-VR settings sliders). */
  viewParam(key: SettingsKey): { value: number; min: number; max: number } {
    const r = StereoScene.VIEW_RANGES[key];
    return { value: this.viewValue(key), min: r.min, max: r.max };
  }
  /** Set a view setting to an absolute value (clamped) — for slider tap/drag. */
  setView(key: SettingsKey, value: number): void {
    const r = StereoScene.VIEW_RANGES[key];
    this.applyView(key, Math.max(r.min, Math.min(r.max, value)));
  }
  /** Reset zoom/pitch/yaw/height/roll to their defaults. */
  resetView(): void {
    this.fov = 1; this.tilt = 0;
    this.rig.rotation.set(0, 0, 0);
    this.rig.position.y = 0;
    this.rebuildGeometry();
  }

  private rebuildGeometry() {
    for (const m of this.meshes) { const old = m.geometry; m.geometry = this.buildGeometry(this.currentMode); old.dispose(); }
    this.builtFov = this.fov;
  }

  setProjection(p: Projection) { this.applyProjection(p, this.currentSwap); }
  /** Player registers this so an in-VR projection change flows back through Player — keeping its
   *  state, persistence, and the DOM controls in sync. Falls back to a direct geometry swap. */
  setProjectionRequester(cb: (p: Projection) => void) { this.projectionRequester = cb; }
  private projectionRequester?: (p: Projection) => void;
  /** Change projection, routing through the requester (Player) when set so its state,
   *  persistence, and the DOM controls stay in sync; else swap geometry directly. */
  private requestProjection(p: Projection): void {
    (this.projectionRequester ?? ((x: Projection) => this.setProjection(x)))(p);
  }
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
  /** Enter immersive AR (passthrough). Same contract as enterVR — called from a click so it
   *  keeps transient activation, rejects with a readable message. The UA composites our
   *  transparent framebuffer over the camera feed. */
  async enterAR(): Promise<void> {
    if (!navigator.xr) throw new Error('WebXR is unavailable here — open the page over HTTPS or localhost.');
    const session = await navigator.xr.requestSession('immersive-ar', this.arSessionInit);
    await this.renderer.xr.setSession(session);
  }
  exitVR(): void {
    if (!this.video.paused) this.video.pause(); // pause first if playing, then leave VR
    void this.renderer.xr.getSession()?.end();
  }
  /** Arm the browser/headset's own "Enter VR" affordance (e.g. the Quest system button).
   *  The offer is re-armed on every session end so the affordance keeps working; dispose()
   *  stops it so a torn-down player can't be pulled back into a session. */
  offerVR(): void {
    const offer = (navigator.xr as { offerSession?: (m: XRSessionMode, i: XRSessionInit) => Promise<XRSession> } | undefined)?.offerSession;
    if (!offer || this.disposed) return;
    const run = () => offer.call(navigator.xr, 'immersive-vr', this.vrSessionInit)
      .then((s) => {
        // The player may have been disposed while the offer was pending — decline the
        // granted session instead of attaching it to a dead renderer.
        if (this.disposed) { void s.end(); return; }
        void this.renderer.xr.setSession(s);
      })
      .catch(() => { /* the UA declined the offer or the user dismissed it */ });
    const onEnd = () => { if (!this.disposed) void run(); };
    this.renderer.xr.addEventListener('sessionend', onEnd);
    this.offerCleanup = () => this.renderer.xr.removeEventListener('sessionend', onEnd);
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
    this.disposed = true;          // stops any pending offerVR re-offer from re-entering
    this.offerCleanup?.();
    this.ro.disconnect();
    this.renderer.setAnimationLoop(null);
    this.vrControls?.dispose();
    this.texture.dispose();
    this.clearMeshes();
    this.renderer.dispose();
  }
}
