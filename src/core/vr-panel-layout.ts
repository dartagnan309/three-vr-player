/**
 * Geometry and hit-testing for the in-VR control panel, expressed purely in
 * canvas-pixel space — no three.js, no DOM. Both the painter (VRControls draws
 * to a 2D canvas) and the controller-ray hit-tester read the SAME layout, so a
 * button is never drawn in one place and clicked in another. Kept dependency-free
 * so it can be unit-tested.
 */

export const PANEL_W = 1024;
export const PANEL_H = 340;

export type VRRegion = 'play' | 'seek' | 'volume' | 'exit';

export interface Rect { x: number; y: number; w: number; h: number; }

export interface PanelLayout {
  width: number; height: number;
  title: Rect;
  exit: Rect;
  play: Rect;
  volIcon: Rect;
  volBar: Rect;
  seekBar: Rect;
  timeCur: { x: number; y: number };
  timeDur: { x: number; y: number };
}

/** Where every control sits on the panel canvas. A single source of truth. */
export function panelLayout(): PanelLayout {
  const W = PANEL_W, H = PANEL_H, pad = 48;
  return {
    width: W, height: H,
    exit:    { x: W - 190, y: 26, w: 160, h: 52 },
    title:   { x: 0, y: 92, w: W, h: 44 },
    play:    { x: W / 2 - 44, y: 150, w: 88, h: 88 },
    volIcon: { x: pad, y: 178, w: 44, h: 44 },
    volBar:  { x: pad + 60, y: 192, w: 200, h: 16 },
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
  if (inRect(layout.exit, x, y)) return { region: 'exit' };
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
