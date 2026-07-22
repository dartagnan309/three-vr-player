/**
 * Geometry and hit-testing for the in-VR control panel, expressed purely in
 * canvas-pixel space — no three.js, no DOM. Both the painter (VRControls draws
 * to a 2D canvas) and the controller-ray hit-tester read the SAME layout, so a
 * button is never drawn in one place and clicked in another. Kept dependency-free
 * so it can be unit-tested.
 */

export const PANEL_W = 1024;
export const PANEL_H = 340;

export type VRRegion = 'play' | 'seek' | 'volume' | 'exit' | 'recenter' | 'projection' | 'passthrough' | 'settings';

export interface Rect { x: number; y: number; w: number; h: number; }

export interface PanelLayout {
  width: number; height: number;
  title: Rect;
  recenter: Rect;
  projection: Rect;   // opens the projection popup
  passthrough: Rect;
  settings: Rect;     // opens the view-settings popup
  exit: Rect;
  play: Rect;
  volIcon: Rect;
  volBar: Rect;
  projLabel: Rect;    // display only (no hit-test) — the current projection name
  seekBar: Rect;
  timeCur: { x: number; y: number };
  timeDur: { x: number; y: number };
}

/** Where every control sits on the main panel canvas. A single source of truth. */
export function panelLayout(): PanelLayout {
  const W = PANEL_W, H = PANEL_H, pad = 48;
  return {
    width: W, height: H,
    // Top-row icon buttons (door-arrow / reticle / eye / globe / gear). Compact so they read
    // as icons. Exit sits alone on the left, recenter in the centre, the rest cluster right.
    exit:        { x: 30, y: 26, w: 64, h: 52 },
    recenter:    { x: W / 2 - 32, y: 26, w: 64, h: 52 }, // reticle, top centre
    passthrough: { x: W - 250, y: 26, w: 64, h: 52 }, // toggle; shown only in a passthrough (AR) session
    projection:  { x: W - 172, y: 26, w: 64, h: 52 }, // globe → opens the projection popup (immediately left of settings)
    settings:    { x: W - 94, y: 26, w: 64, h: 52 },  // gear → opens the view-settings popup
    title:   { x: 0, y: 92, w: W, h: 44 },
    play:    { x: W / 2 - 44, y: 150, w: 88, h: 88 },
    volIcon: { x: pad, y: 178, w: 44, h: 44 },
    volBar:  { x: pad + 60, y: 192, w: 200, h: 16 },
    projLabel: { x: 560, y: 178, w: W - 94 - 560, h: 46 },
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
  if (inRect(layout.projection, x, y)) return { region: 'projection' };
  if (inRect(layout.passthrough, x, y)) return { region: 'passthrough' };
  if (inRect(layout.settings, x, y)) return { region: 'settings' };
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

// ---- Projection sub-page: a decomposed grid (layout × type × fisheye-angle) ----

export type ProjAxis = 'split' | 'type' | 'angle' | 'flatWidth';
export interface ProjCell { axis: ProjAxis; value: string; label: string; rect: Rect; }
export interface ProjGroup { caption: string; captionY: number; cells: ProjCell[]; }
export interface ProjGridLayout {
  width: number; height: number;
  close: Rect;
  title: { x: number; y: number };
  groups: ProjGroup[];
}

/** The contextual third row (below Layout + Type): fisheye angles, flat-SBS width, etc. */
export interface ThirdRow { caption: string; cells: { axis: ProjAxis; value: string; label: string }[]; }
export const ANGLE_THIRD_ROW: ThirdRow = {
  caption: 'Fisheye angle',
  cells: [190, 200, 210, 220].map((a) => ({ axis: 'angle' as ProjAxis, value: String(a), label: `${a}°` })),
};

/** Evenly space `n` buttons of height `h` across the panel's padded width at row top `top`. */
function cols(n: number, top: number, h: number, W = PANEL_W, pad = 40, gap = 16): Rect[] {
  const usable = W - pad * 2;
  const w = (usable - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ x: pad + i * (w + gap), y: top, w, h }));
}

function group(caption: string, captionY: number, rowTop: number, h: number, items: { axis: ProjAxis; value: string; label: string }[]): ProjGroup {
  const rects = cols(items.length, rowTop, h);
  return { caption, captionY, cells: items.map((it, i) => ({ ...it, rect: rects[i] })) };
}

/** Layout of the projection grid popup. The third row is contextual (fisheye angle,
 *  flat-SBS width, …); pass it in so the painter and hit-tester agree on its cells. */
export function projGridLayout(third: ThirdRow = ANGLE_THIRD_ROW): ProjGridLayout {
  const H = 52;
  return {
    width: PANEL_W, height: PANEL_H,
    close: { x: PANEL_W - 84, y: 22, w: 60, h: 48 }, // ✕ top-right, like the reference popup
    title: { x: 48, y: 52 },                         // "Projection" title, left-aligned
    groups: [
      group('Layout', 96, 108, H, [
        { axis: 'split', value: 'mono', label: 'Mono' },
        { axis: 'split', value: 'sbs', label: 'SBS' },
        { axis: 'split', value: 'tb', label: 'TB' },
      ]),
      group('Type', 176, 188, H, [
        { axis: 'type', value: 'flat', label: 'Flat' },
        { axis: 'type', value: '180', label: '180°' },
        { axis: 'type', value: '360', label: '360°' },
        { axis: 'type', value: 'fisheye', label: 'Fisheye' },
      ]),
      group(third.caption, 256, 268, H, third.cells),
    ],
  };
}

export type ProjGridHit = { region: 'close' } | { region: 'cell'; axis: ProjAxis; value: string };

/** Map a canvas-pixel point on the projection popup to a cell / the close button. */
export function projGridHitTest(x: number, y: number, layout: ProjGridLayout = projGridLayout()): ProjGridHit | null {
  if (inRect(layout.close, x, y)) return { region: 'close' };
  for (const g of layout.groups) {
    for (const cell of g.cells) {
      if (inRect(cell.rect, x, y)) return { region: 'cell', axis: cell.axis, value: cell.value };
    }
  }
  return null;
}

// ---- View-settings popup: stepper rows for zoom / pitch / yaw / height / roll ----

export const SETTINGS_W = 560;
export const SETTINGS_H = 640;
export type SettingsKey = 'zoom' | 'pitch' | 'yaw' | 'height' | 'roll';

export interface SettingsRow {
  key: SettingsKey; caption: string; captionY: number;
  bar: Rect;
}
export interface SettingsLayout {
  width: number; height: number;
  close: Rect;
  title: { x: number; y: number };
  reset: Rect;
  rows: SettingsRow[];
}

const SETTINGS_ROWS: { key: SettingsKey; caption: string }[] = [
  { key: 'zoom', caption: 'Zoom' },
  { key: 'pitch', caption: 'Pitch' },
  { key: 'yaw', caption: 'Yaw' },
  { key: 'height', caption: 'Height' },
  { key: 'roll', caption: 'Roll' },
];

/** Layout of the view-settings popup (a portrait panel floated to the right). */
export function settingsLayout(): SettingsLayout {
  const W = SETTINGS_W, pad = 32;
  const rows: SettingsRow[] = SETTINGS_ROWS.map(({ key, caption }, i) => {
    const ry = 104 + i * 100;                 // caption baseline
    // Full-width slider track (the ∓ steppers are gone — tap/drag the bar instead).
    const bar: Rect = { x: pad, y: ry + 31, w: W - pad * 2, h: 22 };
    return { key, caption, captionY: ry, bar };
  });
  return {
    width: W, height: SETTINGS_H,
    close: { x: W - 60, y: 20, w: 44, h: 44 },
    title: { x: pad, y: 46 },
    reset: { x: W / 2 - 100, y: 584, w: 200, h: 48 },
    rows,
  };
}

export type SettingsHit =
  | { region: 'close' }
  | { region: 'reset' }
  /** A tap/drag on a slider track: `value` is the 0..1 fraction along it. */
  | { region: 'set'; key: SettingsKey; value: number };

/** Map a canvas-pixel point on the settings popup to a slider / reset / close.
 *  The bar gets generous vertical padding so aiming with a jittery ray is forgiving. */
export function settingsHitTest(x: number, y: number, layout: SettingsLayout = settingsLayout()): SettingsHit | null {
  const BAR_PAD = 22;
  if (inRect(layout.close, x, y)) return { region: 'close' };
  if (inRect(layout.reset, x, y)) return { region: 'reset' };
  for (const row of layout.rows) {
    if (inRect(row.bar, x, y, 12, BAR_PAD)) return { region: 'set', key: row.key, value: clamp01((x - row.bar.x) / row.bar.w) };
  }
  return null;
}
