import { describe, it, expect } from 'vitest';
import { hitTest, panelLayout, PANEL_W, projGridLayout, projGridHitTest, settingsLayout, settingsHitTest } from '../src/core/vr-panel-layout.js';

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

  it('hits the projection button top row', () => {
    const p = mid(L.projection);
    expect(hitTest(p.x, p.y)).toEqual({ region: 'projection' });
  });

  it('hits the settings button top row', () => {
    const p = mid(L.settings);
    expect(hitTest(p.x, p.y)).toEqual({ region: 'settings' });
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

describe('projection grid hitTest', () => {
  const G = projGridLayout();
  const cellOf = (axis: string, value: string) =>
    G.groups.flatMap((g) => g.cells).find((cl) => cl.axis === axis && cl.value === value)!;

  it('hits the close button', () => {
    expect(projGridHitTest(mid(G.close).x, mid(G.close).y)).toEqual({ region: 'close' });
  });

  it('hits each axis cell it draws', () => {
    for (const [axis, value] of [['split', 'sbs'], ['type', 'fisheye'], ['angle', '210']] as const) {
      const r = cellOf(axis, value).rect;
      expect(projGridHitTest(r.x + r.w / 2, r.y + r.h / 2)).toEqual({ region: 'cell', axis, value });
    }
  });

  it('returns null between rows', () => {
    expect(projGridHitTest(PANEL_W / 2, 172)).toBeNull(); // gap between the Layout and Type rows
  });

  it('hits the contextual third row when it is the flat-SBS width row', () => {
    const widthLayout = projGridLayout({
      caption: 'SBS width',
      cells: [{ axis: 'flatWidth', value: 'half', label: 'Half' }, { axis: 'flatWidth', value: 'full', label: 'Full' }],
    });
    const half = widthLayout.groups[2].cells.find((cl) => cl.value === 'half')!.rect;
    expect(projGridHitTest(half.x + half.w / 2, half.y + half.h / 2, widthLayout))
      .toEqual({ region: 'cell', axis: 'flatWidth', value: 'half' });
  });
});

describe('settings popup hitTest', () => {
  const S = settingsLayout();
  const midR = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

  it('hits close and reset', () => {
    expect(settingsHitTest(midR(S.close).x, midR(S.close).y)).toEqual({ region: 'close' });
    expect(settingsHitTest(midR(S.reset).x, midR(S.reset).y)).toEqual({ region: 'reset' });
  });

  it('hits each row stepper (− and +)', () => {
    for (const row of S.rows) {
      expect(settingsHitTest(midR(row.minus).x, midR(row.minus).y)).toEqual({ region: 'step', key: row.key, dir: -1 });
      expect(settingsHitTest(midR(row.plus).x, midR(row.plus).y)).toEqual({ region: 'step', key: row.key, dir: 1 });
    }
  });

  it('exposes the five expected settings in order', () => {
    expect(S.rows.map((r) => r.key)).toEqual(['zoom', 'pitch', 'yaw', 'height', 'roll']);
  });

  it('reads a fraction from a slider track (tap/drag to position)', () => {
    const row = S.rows[1]; // pitch
    const y = row.bar.y + row.bar.h / 2;
    expect(settingsHitTest(row.bar.x, y)).toMatchObject({ region: 'set', key: 'pitch', value: 0 });
    const mid = settingsHitTest(row.bar.x + row.bar.w / 2, y);
    expect(mid).toMatchObject({ region: 'set', key: 'pitch' });
    expect((mid as { value: number }).value).toBeCloseTo(0.5, 2);
    expect(settingsHitTest(row.bar.x + row.bar.w, y)).toMatchObject({ region: 'set', value: 1 });
  });

  it('clamps the slider fraction to 0..1 within the padded track', () => {
    const row = S.rows[0];
    const y = row.bar.y + row.bar.h / 2;
    expect((settingsHitTest(row.bar.x - 8, y) as { value: number }).value).toBe(0);
    expect((settingsHitTest(row.bar.x + row.bar.w + 8, y) as { value: number }).value).toBe(1);
  });
});
