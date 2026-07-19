import type { Projection } from '../types.js';

export type Split = 'mono' | 'sbs' | 'tb';
export type GeomKind = 'sphere180' | 'sphere360' | 'plane';

export interface ModeConfig {
  geom: GeomKind;
  split: Split;
  stereo: boolean;
  flat?: boolean;
  /** plane only: 'full' = displayW/H, 'per-eye' = (W/2)/H */
  aspect?: 'full' | 'per-eye';
}

export const MODES: Record<Projection, ModeConfig> = {
  '180-sbs':       { geom: 'sphere180', split: 'sbs',  stereo: true },
  '180-mono':      { geom: 'sphere180', split: 'mono', stereo: false },
  '360-mono':      { geom: 'sphere360', split: 'mono', stereo: false },
  '360-sbs':       { geom: 'sphere360', split: 'sbs',  stereo: true },
  '360-tb':        { geom: 'sphere360', split: 'tb',   stereo: true },
  'flat-2d':       { geom: 'plane',     split: 'mono', stereo: false, flat: true, aspect: 'full' },
  'flat-sbs-full': { geom: 'plane',     split: 'sbs',  stereo: true,  flat: true, aspect: 'per-eye' },
  'flat-sbs-half': { geom: 'plane',     split: 'sbs',  stereo: true,  flat: true, aspect: 'full' },
};

export const PROJECTIONS: { value: Projection; label: string }[] = [
  { value: '180-sbs', label: '180° SBS (VR180)' },
  { value: '180-mono', label: '180° Mono' },
  { value: '360-mono', label: '360° Mono' },
  { value: '360-sbs', label: '360° SBS' },
  { value: '360-tb', label: '360° Top-Bottom' },
  { value: 'flat-2d', label: 'Flat 2D (regular movie)' },
  { value: 'flat-sbs-full', label: 'Flat 3D — Full SBS' },
  { value: 'flat-sbs-half', label: 'Flat 3D — Half SBS' },
];

export function isFlatMode(p: Projection): boolean {
  return !!MODES[p]?.flat;
}

/** Guess a projection from a URL / filename; null when nothing recognizable. */
export function detectProjection(url: string): Projection | null {
  const s = String(url).toLowerCase();
  const tb = /(^|[^a-z])(tb|ou|top.?bottom|over.?under)([^a-z]|$)/.test(s);
  const sbs = /(sbs|side.?by.?side)/.test(s);
  if (s.includes('360')) {
    if (tb) return '360-tb';
    if (sbs) return '360-sbs';
    return '360-mono';
  }
  if (s.includes('180') || s.includes('vr180')) {
    return s.includes('mono') ? '180-mono' : '180-sbs';
  }
  if (sbs) return s.includes('half') ? 'flat-sbs-half' : 'flat-sbs-full';
  return null;
}
