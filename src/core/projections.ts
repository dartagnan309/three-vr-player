import type { Projection } from '../types.js';

export type Split = 'mono' | 'sbs' | 'tb';
export type GeomKind = 'sphere180' | 'sphere360' | 'fisheye' | 'plane';
/** The four projection "types" the selector grid exposes (Type row). */
export type ProjType = 'flat' | '180' | '360' | 'fisheye';
/** Fisheye field-of-view options (Fisheye-angle row). */
export type FisheyeAngle = 190 | 200 | 210 | 220;
export const FISHEYE_ANGLES: readonly FisheyeAngle[] = [190, 200, 210, 220];
/** Flat SBS packing: 'full' = each eye full-width; 'half' = anamorphic (squeezed to frame). */
export type FlatWidth = 'half' | 'full';

export interface ModeConfig {
  geom: GeomKind;
  split: Split;
  stereo: boolean;
  flat?: boolean;
  /** plane only: 'full' = displayW/H, 'per-eye' = split-adjusted (SBS→W/2, TB→H/2) */
  aspect?: 'full' | 'per-eye';
  /** fisheye only: full field of view in degrees (dome half-angle = angle/2). */
  fisheyeAngle?: FisheyeAngle;
}

const fish = (split: Split, a: FisheyeAngle): ModeConfig =>
  ({ geom: 'fisheye', split, stereo: split !== 'mono', fisheyeAngle: a });

export const MODES: Record<Projection, ModeConfig> = {
  '180-mono':      { geom: 'sphere180', split: 'mono', stereo: false },
  '180-sbs':       { geom: 'sphere180', split: 'sbs',  stereo: true },
  '180-tb':        { geom: 'sphere180', split: 'tb',   stereo: true },
  '360-mono':      { geom: 'sphere360', split: 'mono', stereo: false },
  '360-sbs':       { geom: 'sphere360', split: 'sbs',  stereo: true },
  '360-tb':        { geom: 'sphere360', split: 'tb',   stereo: true },
  // DeoVR-style fisheye domes, one circle per eye, at several field-of-view widths.
  'fisheye190-mono': fish('mono', 190), 'fisheye190-sbs': fish('sbs', 190), 'fisheye190-tb': fish('tb', 190),
  'fisheye200-mono': fish('mono', 200), 'fisheye200-sbs': fish('sbs', 200), 'fisheye200-tb': fish('tb', 200),
  'fisheye210-mono': fish('mono', 210), 'fisheye210-sbs': fish('sbs', 210), 'fisheye210-tb': fish('tb', 210),
  'fisheye220-mono': fish('mono', 220), 'fisheye220-sbs': fish('sbs', 220), 'fisheye220-tb': fish('tb', 220),
  'flat-2d':       { geom: 'plane', split: 'mono', stereo: false, flat: true, aspect: 'full' },
  'flat-sbs-full': { geom: 'plane', split: 'sbs',  stereo: true,  flat: true, aspect: 'per-eye' },
  'flat-sbs-half': { geom: 'plane', split: 'sbs',  stereo: true,  flat: true, aspect: 'full' },
  'flat-tb':       { geom: 'plane', split: 'tb',   stereo: true,  flat: true, aspect: 'per-eye' },
};

export const PROJECTIONS: { value: Projection; label: string }[] = [
  { value: '180-mono', label: '180° Mono' },
  { value: '180-sbs', label: '180° SBS (VR180)' },
  { value: '180-tb', label: '180° Top-Bottom' },
  { value: '360-mono', label: '360° Mono' },
  { value: '360-sbs', label: '360° SBS' },
  { value: '360-tb', label: '360° Top-Bottom' },
  { value: 'fisheye190-sbs', label: 'Fisheye 190° SBS' },
  { value: 'fisheye190-mono', label: 'Fisheye 190° Mono' },
  { value: 'fisheye200-sbs', label: 'Fisheye 200° SBS' },
  { value: 'fisheye210-sbs', label: 'Fisheye 210° SBS' },
  { value: 'fisheye220-sbs', label: 'Fisheye 220° SBS' },
  { value: 'flat-2d', label: 'Flat 2D' },
  { value: 'flat-sbs-full', label: 'Flat 3D — Full SBS' },
  { value: 'flat-sbs-half', label: 'Flat 3D — Half SBS' },
  { value: 'flat-tb', label: 'Flat 3D — Top-Bottom' },
];

/** Compact labels (used where space is tight, e.g. the in-VR panel). */
export const PROJECTION_SHORT: Record<Projection, string> = {
  '180-mono': '180° Mono', '180-sbs': '180° SBS', '180-tb': '180° TB',
  '360-mono': '360° Mono', '360-sbs': '360° SBS', '360-tb': '360° TB',
  'fisheye190-mono': 'Fisheye 190° Mono', 'fisheye190-sbs': 'Fisheye 190° SBS', 'fisheye190-tb': 'Fisheye 190° TB',
  'fisheye200-mono': 'Fisheye 200° Mono', 'fisheye200-sbs': 'Fisheye 200° SBS', 'fisheye200-tb': 'Fisheye 200° TB',
  'fisheye210-mono': 'Fisheye 210° Mono', 'fisheye210-sbs': 'Fisheye 210° SBS', 'fisheye210-tb': 'Fisheye 210° TB',
  'fisheye220-mono': 'Fisheye 220° Mono', 'fisheye220-sbs': 'Fisheye 220° SBS', 'fisheye220-tb': 'Fisheye 220° TB',
  'flat-2d': 'Flat 2D', 'flat-sbs-full': 'Flat SBS', 'flat-sbs-half': 'Flat SBS½', 'flat-tb': 'Flat TB',
};

/** The axes of a projection, as the selector grid presents them. `angle` applies only to
 *  the fisheye type; `flatWidth` only to flat SBS. */
export interface ProjSpec { type: ProjType; split: Split; angle: FisheyeAngle; flatWidth: FlatWidth; }

/** Break a Projection into its (type, split, fisheye-angle, flat-width) axes for the grid. */
export function decomposeProjection(p: Projection): ProjSpec {
  const m = MODES[p];
  const type: ProjType =
    m.geom === 'sphere180' ? '180' :
    m.geom === 'sphere360' ? '360' :
    m.geom === 'fisheye' ? 'fisheye' : 'flat';
  return { type, split: m.split, angle: m.fisheyeAngle ?? 190, flatWidth: p === 'flat-sbs-half' ? 'half' : 'full' };
}

/**
 * Compose a Projection from the grid's axes. `angle` is only consulted for the fisheye
 * type; `flatWidth` only for flat SBS (full = each eye full-width, half = anamorphic).
 */
export function composeProjection(type: ProjType, split: Split, angle: FisheyeAngle = 190, flatWidth: FlatWidth = 'full'): Projection {
  switch (type) {
    case 'flat':
      return split === 'mono' ? 'flat-2d'
        : split === 'tb' ? 'flat-tb'
        : flatWidth === 'half' ? 'flat-sbs-half' : 'flat-sbs-full';
    case 'fisheye':
      return `fisheye${angle}-${split}` as Projection;
    default: // '180' | '360'
      return `${type}-${split}` as Projection;
  }
}

export function isFlatMode(p: Projection): boolean {
  return !!MODES[p]?.flat;
}

/** Guess a projection from a URL / filename; null when nothing recognizable. */
export function detectProjection(url: string): Projection | null {
  const s = String(url).toLowerCase();
  const tb = /(^|[^a-z])(tb|ou|top.?bottom|over.?under)([^a-z]|$)/.test(s);
  const sbs = /(sbs|side.?by.?side)/.test(s);
  const split: Split = s.includes('mono') ? 'mono' : tb ? 'tb' : 'sbs';
  // DeoVR fisheye lenses — the tag implies the field of view (MKX200→200°, VRCA220→220°).
  if (/(fisheye|mkx200|rf52|vrca220)/.test(s)) {
    const angle: FisheyeAngle =
      /(vrca220|220)/.test(s) ? 220 :
      /(mkx200|200)/.test(s) ? 200 :
      s.includes('210') ? 210 : 190;
    return composeProjection('fisheye', split, angle);
  }
  if (s.includes('360')) {
    if (tb) return '360-tb';
    if (sbs) return '360-sbs';
    return '360-mono';
  }
  if (s.includes('180') || s.includes('vr180')) {
    if (s.includes('mono')) return '180-mono';
    return tb ? '180-tb' : '180-sbs';
  }
  if (tb) return 'flat-tb';
  if (sbs) return s.includes('half') ? 'flat-sbs-half' : 'flat-sbs-full';
  return null;
}
