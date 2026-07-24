/**
 * Dev-only in-VR test harness.
 *
 * Loaded only when the demo URL carries `?xr` (see main.ts), so neither this module nor its
 * `iwer` dependency ever enters the normal demo path or the published library (which builds
 * from src/ only).
 *
 * It installs an emulated WebXR runtime (IWER), enters an immersive session against the real
 * Player/VRControls, and exposes drive + measure helpers on `window.xrHarness` for repeatable
 * in-VR checks — run from devtools or an automated Playwright driver. `runChecks()` runs a small
 * facing + interaction suite and prints a pass/fail table.
 *
 * Usage:
 *   npm run dev  ->  open http://localhost:8080/?xr
 *   await xrHarness.runChecks()                 // full suite, returns { pass, results }
 *   await xrHarness.enterVR(); xrHarness.summon(); await xrHarness.openProjection();
 *   xrHarness.facingAngle('proj')               // ~0 (faces the viewer)
 */
import * as THREE from 'three';
import type { Player } from 'three-vr-player';
import { PANEL_W, PANEL_H, projGridHitTest } from '../../src/core/vr-panel-layout.js';
import type { ProjGridLayout, ProjAxis, ProjGridHit } from '../../src/core/vr-panel-layout.js';

// ---- structural views over the internals we reach into (Player.scene and its VRControls are
//      private; we only touch a documented subset here, kept honest by these interfaces) ----

/** A controller-shaped stand-in for rayHitMesh: it reads only `.matrixWorld`. */
interface RayLike { matrixWorld: THREE.Matrix4; }

interface VrControls {
  show(): void;
  reposition(): void;
  openProj(): void;
  closeProj(): void;
  openSettings(): void;
  closeSettings(): void;
  projLayout(): ProjGridLayout;
  rayHitMesh(controller: RayLike, mesh: THREE.Object3D, w: number, h: number): { uv: { x: number; y: number } | null };
  panel: THREE.Object3D;
  projPanel: THREE.Object3D;
  setPanel: THREE.Object3D;
  projOpen: boolean;
  settingsOpen: boolean;
  idleAt: number;
}

/** Player.scene is private; we only reach its VRControls. Everything else uses public API. */
interface PlayerInternals { scene: { vrControls?: VrControls }; }

export interface CheckResult { name: string; ok: boolean; detail: string; info?: boolean; }
export interface HarnessReport { pass: boolean; results: CheckResult[]; }

export interface XrHarness {
  enterVR(): Promise<void>;
  exitVR(): void;
  summon(): void;
  openProjection(): Promise<void>;
  openSettings(): Promise<void>;
  closePopups(): void;
  setHeadPose(pose: { x?: number; y?: number; z?: number; yawDeg?: number; pitchDeg?: number }): Promise<void>;
  reposition(): Promise<void>;
  facingAngle(which: 'main' | 'proj' | 'settings'): number;
  aimAtProjCell(axis: ProjAxis, value: string): ProjGridHit | null;
  snapshot(): Record<string, unknown>;
  runChecks(): Promise<HarnessReport>;
}

declare global {
  interface Window { xrHarness?: XrHarness; }
}

const NO_HIDE = Number.MAX_SAFE_INTEGER;
const FACE_TOL_DEG = 1.0;   // "faces the viewer head-on" tolerance for the projection popup
const MAIN_TOL_DEG = 6.0;   // main panel tracks the eye from its low seat (measured ~3°)

const settle = (ms = 250): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * three.js r0.185 latches `supportsGlBinding` from `typeof XRWebGLBinding` at the top of
 * setSession, then IWER nulls that global during the `await gl.makeXRCompatible()` inside it —
 * so `XRWebGLBinding.prototype` throws. Pin the global to a stable stub whose prototype lacks
 * `createProjectionLayer`, forcing the baseLayer path (XRWebGLLayer, which IWER provides). The
 * setter swallows IWER's writes so it stays put across sessions.
 */
function pinXrWebGLBinding(): void {
  const Stub = class XRWebGLBinding {};
  Object.defineProperty(window, 'XRWebGLBinding', { get: () => Stub, set: () => { /* ignore */ }, configurable: true });
}

/** World-space position (translation column) of an object's matrixWorld — numeric only, so it
 *  is safe across possibly-distinct three instances. */
function worldPos(obj: THREE.Object3D): THREE.Vector3 {
  obj.updateWorldMatrix(true, false);
  const e = obj.matrixWorld.elements;
  return new THREE.Vector3(e[12], e[13], e[14]);
}

/** Angle (degrees) between a panel's front (+Z world) and the direction to `eye`. 0 = head-on. */
function facingDeg(panel: THREE.Object3D, eye: THREE.Vector3): number {
  panel.updateWorldMatrix(true, false);
  const e = panel.matrixWorld.elements;
  const pos = new THREE.Vector3(e[12], e[13], e[14]);
  const normal = new THREE.Vector3(e[8], e[9], e[10]).normalize();   // local +Z in world space
  const dir = eye.clone().sub(pos).normalize();
  return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(normal.dot(dir), -1, 1)));
}

/** Pixel centre of a projection-grid cell, or null if the mode doesn't expose it. */
function cellCenterPx(layout: ProjGridLayout, axis: ProjAxis, value: string): { x: number; y: number } | null {
  for (const g of layout.groups) {
    for (const c of g.cells) {
      if (c.axis === axis && c.value === value) return { x: c.rect.x + c.rect.w / 2, y: c.rect.y + c.rect.h / 2 };
    }
  }
  return null;
}

export async function install(player: Player): Promise<XrHarness> {
  const iwer = await import('iwer');
  const device = new iwer.XRDevice(iwer.metaQuest3);
  device.installRuntime();
  pinXrWebGLBinding();
  device.controlMode = 'programmatic';

  const scene = (player as unknown as PlayerInternals).scene;
  const renderer = player.three.renderer;

  const vc = (): VrControls => {
    const c = scene.vrControls;
    if (!c) throw new Error('Not in VR — call enterVR() first.');
    return c;
  };
  const eye = (): THREE.Vector3 => worldPos(renderer.xr.getCamera());

  const enterVR = async (): Promise<void> => {
    if (renderer.xr.isPresenting) return;
    pinXrWebGLBinding();                 // re-assert right before setSession
    const xr = navigator.xr;
    if (!xr) throw new Error('Emulated navigator.xr missing — installRuntime failed.');
    // The library's own vrSessionInit is `{}`; a real Quest grants local-floor implicitly, but
    // IWER follows the spec strictly, so three's default local-floor reference space needs the
    // feature requested here. We then drive the real setSession path (fires sessionstart →
    // buildVRControls), so we exercise the actual in-VR UI.
    const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    await renderer.xr.setSession(session);
    await settle(400);                   // let the first XR frames populate the camera pose
  };
  const exitVR = (): void => player.exitVR();

  const summon = (): void => { const c = vc(); c.show(); c.idleAt = NO_HIDE; };
  const reposition = async (): Promise<void> => { const c = vc(); c.reposition(); c.idleAt = NO_HIDE; await settle(300); };
  const openProjection = async (): Promise<void> => { const c = vc(); c.openProj(); c.idleAt = NO_HIDE; await settle(120); };
  const openSettings = async (): Promise<void> => { const c = vc(); c.openSettings(); c.idleAt = NO_HIDE; await settle(120); };
  const closePopups = (): void => { const c = vc(); c.closeProj(); c.closeSettings(); };

  const setHeadPose = async (pose: { x?: number; y?: number; z?: number; yawDeg?: number; pitchDeg?: number }): Promise<void> => {
    const { x = 0, y = 0, z = 0, yawDeg = 0, pitchDeg = 0 } = pose;
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(THREE.MathUtils.degToRad(pitchDeg), THREE.MathUtils.degToRad(yawDeg), 0, 'YXZ'),
    );
    device.position.set(x, y, z);
    device.quaternion.set(q.x, q.y, q.z, q.w);
    device.notifyStateChange();
    await settle(120);
  };

  const facingAngle = (which: 'main' | 'proj' | 'settings'): number => {
    const c = vc();
    const panel = which === 'proj' ? c.projPanel : which === 'settings' ? c.setPanel : c.panel;
    return facingDeg(panel, eye());
  };

  const aimAtProjCell = (axis: ProjAxis, value: string): ProjGridHit | null => {
    const c = vc();
    const layout = c.projLayout();
    const px = cellCenterPx(layout, axis, value);
    if (!px) return null;
    // Cell pixel -> plane-local point -> world point on the popup (inverse of rayHitMesh's UV map).
    const u = px.x / PANEL_W, v = 1 - px.y / PANEL_H;
    const geo = (c.projPanel as THREE.Mesh).geometry as THREE.PlaneGeometry;
    c.projPanel.updateWorldMatrix(true, false);
    const world = new THREE.Vector3((u - 0.5) * geo.parameters.width, (v - 0.5) * geo.parameters.height, 0)
      .applyMatrix4(c.projPanel.matrixWorld);
    // Synthetic controller ray from the eye through that world point — drives the real rayHitMesh.
    const origin = eye();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), world.clone().sub(origin).normalize());
    const m = new THREE.Matrix4().compose(origin, quat, new THREE.Vector3(1, 1, 1));
    const hit = c.rayHitMesh({ matrixWorld: m }, c.projPanel, PANEL_W, PANEL_H);
    return hit.uv ? projGridHitTest(hit.uv.x, hit.uv.y, layout) : null;
  };

  const snapshot = (): Record<string, unknown> => {
    const c = vc();
    const e = eye();
    return {
      eye: e.toArray().map((n) => +n.toFixed(3)),
      main: { pos: worldPos(c.panel).toArray().map((n) => +n.toFixed(3)), facingDeg: +facingDeg(c.panel, e).toFixed(2) },
      proj: { visible: c.projOpen, facingDeg: +facingDeg(c.projPanel, e).toFixed(2) },
      settings: { visible: c.settingsOpen, facingDeg: +facingDeg(c.setPanel, e).toFixed(2) },
    };
  };

  const runChecks = async (): Promise<HarnessReport> => {
    const results: CheckResult[] = [];
    const check = (name: string, ok: boolean, detail: string, info = false): void => { results.push({ name, ok, detail, info }); };

    await enterVR();
    summon();

    // ---- facing suite: the projection popup must face the viewer head-on from any head pose ----
    const poses: { name: string; pose: Parameters<typeof setHeadPose>[0] }[] = [
      { name: 'straight-on', pose: { pitchDeg: 0, yawDeg: 0 } },
      { name: 'pitched-down', pose: { pitchDeg: -25 } },
      { name: 'yawed', pose: { yawDeg: 30 } },
    ];
    for (const { name, pose } of poses) {
      await setHeadPose(pose);
      await reposition();
      await openProjection();
      const proj = facingAngle('proj');
      check(`projection popup faces eye @ ${name}`, proj < FACE_TOL_DEG, `${proj.toFixed(2)}°`);
      const main = facingAngle('main');
      check(`main panel faces eye @ ${name}`, main < MAIN_TOL_DEG, `${main.toFixed(2)}°`);
      closePopups();
    }

    // Settings popup is intentionally yawed to the side (not head-on) — report, don't assert.
    await setHeadPose({});
    await reposition();
    await openSettings();
    check('settings popup facing (info — intentionally yawed)', true, `${facingAngle('settings').toFixed(2)}°`, true);
    closePopups();

    // ---- interaction suite ----
    await openProjection();
    check('projection popup opens (visible)', vc().projOpen && vc().projPanel.visible, String(vc().projPanel.visible));

    const hit = aimAtProjCell('type', 'flat');
    const hitOk = !!hit && hit.region === 'cell' && hit.axis === 'type' && hit.value === 'flat';
    check("ray at 'Type: Flat' cell resolves to type=flat", hitOk, JSON.stringify(hit));

    player.setProjection('flat-sbs-half');
    await settle(80);
    const third = vc().projLayout().groups[2].cells;
    check('popup reflects mode: flat-sbs → SBS-width row', third.some((c) => c.axis === 'flatWidth' && c.value === 'half'), third.map((c) => c.value).join(',') || '(none)');

    player.setProjection('360-mono');
    await settle(80);
    const third2 = vc().projLayout().groups[2].cells;
    check('popup reflects mode: 360-mono → no third row', third2.length === 0, `${third2.length} cells`);

    closePopups();
    check('toggle closes projection popup', !vc().projOpen && !vc().projPanel.visible, String(vc().projPanel.visible));

    const graded = results.filter((r) => !r.info);
    const pass = graded.every((r) => r.ok);
    // eslint-disable-next-line no-console
    console.table(results.map((r) => ({ check: r.name, result: r.info ? 'ℹ' : r.ok ? '✓' : '✗', detail: r.detail })));
    const badge = pass ? 'background:#137333' : 'background:#b3261e';
    // eslint-disable-next-line no-console
    console.log(`%c ${pass ? 'ALL IN-VR CHECKS PASSED' : 'SOME IN-VR CHECKS FAILED'} `, `${badge};color:#fff;padding:2px 8px;border-radius:3px;font-weight:600`);
    return { pass, results };
  };

  return { enterVR, exitVR, summon, openProjection, openSettings, closePopups, setHeadPose, reposition, facingAngle, aimAtProjCell, snapshot, runChecks };
}
