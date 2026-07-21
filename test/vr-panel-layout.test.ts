import { describe, it, expect } from 'vitest';
import { hitTest, panelLayout, PANEL_W } from '../src/core/vr-panel-layout.js';

const L = panelLayout();
const mid = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

describe('vr panel hitTest', () => {
  it('hits the play button at its center', () => {
    const p = mid(L.play);
    expect(hitTest(p.x, p.y)).toEqual({ region: 'play' });
  });

  it('hits the exit button top-right', () => {
    const p = mid(L.exit);
    expect(hitTest(p.x, p.y)).toEqual({ region: 'exit' });
  });

  it('hits the recenter button top-left', () => {
    const p = mid(L.recenter);
    expect(hitTest(p.x, p.y)).toEqual({ region: 'recenter' });
  });

  it('hits the passthrough toggle top row', () => {
    const p = mid(L.passthrough);
    expect(hitTest(p.x, p.y)).toEqual({ region: 'passthrough' });
  });

  it('hits the projection stepper arrows', () => {
    expect(hitTest(mid(L.projPrev).x, mid(L.projPrev).y)).toEqual({ region: 'projPrev' });
    expect(hitTest(mid(L.projNext).x, mid(L.projNext).y)).toEqual({ region: 'projNext' });
  });

  it('reads a seek fraction from the bar position', () => {
    const y = L.seekBar.y + L.seekBar.h / 2;
    expect(hitTest(L.seekBar.x, y)?.value).toBeCloseTo(0, 2);
    expect(hitTest(L.seekBar.x + L.seekBar.w / 2, y)).toMatchObject({ region: 'seek' });
    expect(hitTest(L.seekBar.x + L.seekBar.w / 2, y)?.value).toBeCloseTo(0.5, 2);
    expect(hitTest(L.seekBar.x + L.seekBar.w, y)?.value).toBeCloseTo(1, 2);
  });

  it('clamps the seek fraction to 0..1 within the padded hit area', () => {
    const y = L.seekBar.y + L.seekBar.h / 2;
    expect(hitTest(L.seekBar.x - 8, y)?.value).toBe(0);
    expect(hitTest(L.seekBar.x + L.seekBar.w + 8, y)?.value).toBe(1);
  });

  it('reads a volume fraction from the volume bar', () => {
    const y = L.volBar.y + L.volBar.h / 2;
    expect(hitTest(L.volBar.x + L.volBar.w / 2, y)).toMatchObject({ region: 'volume' });
    expect(hitTest(L.volBar.x + L.volBar.w / 2, y)?.value).toBeCloseTo(0.5, 2);
  });

  it('treats the volume icon as a mute toggle (no value)', () => {
    const p = mid(L.volIcon);
    expect(hitTest(p.x, p.y)).toEqual({ region: 'volume' });
  });

  it('returns null for empty space', () => {
    expect(hitTest(PANEL_W / 2, 5)).toBeNull();
  });
});
