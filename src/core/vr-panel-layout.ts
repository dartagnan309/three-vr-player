/**
 * Geometry and hit-testing for the in-VR control panel, expressed purely in
 * canvas-pixel space — no three.js, no DOM. Both the painter (VRControls draws
 * to a 2D canvas) and the controller-ray hit-tester read the SAME layout, so a
 * button is never drawn in one place and clicked in another. Kept dependency-free
 * so it can be unit-tested.
 */

export const PANEL_W = 1024;
export const PANEL_H = 340;

export type VRRegion = 'play' | 'seek' | 'volume' | 'exit' | 'recenter' | 'passthrough' | 'projPrev' | 'projNext';

export interface Rect { x: number; y: number; w: number; h: number; }

export interface PanelLayout {
  width: number; height: number;
  title: Rect;
  recenter: Rect;
  passthrough: Rect;
  exit: Rect;
  play: Rect;
  volIcon: Rect;
  volBar: Rect;
  projPrev: Rect;
  projNext: Rect;
  projLabel: Rect;   // display only (no hit-test) — the current projection name
  seekBar: Rect;
  timeCur: { x: number; y: number };
  timeDur: { x: number; y: number };
}

/** Where every control sits on the panel canvas. A single source of truth. */
export function panelLayout(): PanelLayout {
  const W = PANEL_W, H = PANEL_H, pad = 48;
  return {
    width: W, height: H,
    // Top-row icon buttons (reticle / eye / door-arrow). Compact so they read as icons, not labels.
    recenter:    { x: 30, y: 26, w: 64, h: 52 },
    passthrough: { x: 108, y: 26, w: 64, h: 52 }, // toggle; shown only for alpha (passthrough) content
    exit:        { x: W - 94, y: 26, w: 64, h: 52 },
    title:   { x: 0, y: 92, w: W, h: 44 },
    play:    { x: W / 2 - 44, y: 150, w: 88, h: 88 },
    volIcon: { x: pad, y: 178, w: 44, h: 44 },
    volBar:  { x: pad + 60, y: 192, w: 200, h: 16 },
    // Projection stepper on the right: ◀ [label] ▶
    projPrev:  { x: 592, y: 178, w: 46, h: 46 },
    projNext:  { x: W - 94, y: 178, w: 46, h: 46 },
    projLabel: { x: 646, y: 178, w: W - 94 - 646, h: 46 },
    seekBar: { x: pad, y: 286, w: W - pad * 2, h: 14 },
    timeCur: { x: pad, y: 262 },
    timeDur: { x: W - pad, y: 262 },
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function inRect(r: Rect, x: number, y: number, padX = 0, padY = 0): boolean {
  return x >= r.x - padX && x <= r.x + r.w + padX && y >= r.y - padY && y <= r.y + r.h + padY;
}

export interface VRHit {
  region: VRRegion;
  /** For bars, the 0..1 fraction along the track. For the volume icon (mute
   *  toggle) it is undefined — a bare `volume` hit means "toggle mute". */
  value?: number;
}

/**
 * Map a canvas-pixel point to the control it lands on, or null for empty space.
 * The thin bars get generous vertical padding so aiming with a jittery controller
 * ray is forgiving.
 */
export function hitTest(x: number, y: number, layout: PanelLayout = panelLayout()): VRHit | null {
  const BAR_PAD = 26;
  if (inRect(layout.recenter, x, y)) return { region: 'recenter' };
  if (inRect(layout.passthrough, x, y)) return { region: 'passthrough' };
  if (inRect(layout.exit, x, y)) return { region: 'exit' };
  if (inRect(layout.projPrev, x, y)) return { region: 'projPrev' };
  if (inRect(layout.projNext, x, y)) return { region: 'projNext' };
  if (inRect(layout.play, x, y)) return { region: 'play' };
  if (inRect(layout.volIcon, x, y)) return { region: 'volume' }; // no value -> toggle mute
  if (inRect(layout.volBar, x, y, 12, BAR_PAD)) {
    return { region: 'volume', value: clamp01((x - layout.volBar.x) / layout.volBar.w) };
  }
  if (inRect(layout.seekBar, x, y, 12, BAR_PAD)) {
    return { region: 'seek', value: clamp01((x - layout.seekBar.x) / layout.seekBar.w) };
  }
  return null;
}
