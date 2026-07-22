import { describe, it, expect } from 'vitest';
import { detectProjection, isFlatMode, composeProjection, decomposeProjection, MODES } from '../src/core/projections.js';
import type { Projection } from '../src/types.js';

describe('detectProjection', () => {
  it('flat 3D movies', () => {
    expect(detectProjection('https://x/Dune (2024) 3D-Full-SBS.mkv')).toBe('flat-sbs-full');
    expect(detectProjection('https://x/Movie.3D.Half-SBS.mp4')).toBe('flat-sbs-half');
  });
  it('360', () => {
    expect(detectProjection('https://x/clip_360.mp4')).toBe('360-mono');
    expect(detectProjection('https://x/clip_360_SBS.mp4')).toBe('360-sbs');
    expect(detectProjection('https://x/clip_360_TB.mp4')).toBe('360-tb');
    expect(detectProjection('https://x/clip.360.over-under.mp4')).toBe('360-tb');
  });
  it('180 + null', () => {
    expect(detectProjection('https://x/vr180_clip.mp4')).toBe('180-sbs');
    expect(detectProjection('https://x/180_mono.mp4')).toBe('180-mono');
    expect(detectProjection('https://x/IPS_sample.mp4')).toBeNull();
    expect(detectProjection('https://youtube.com/watch?v=abc')).toBeNull();
  });
  it('DeoVR fisheye (angle from lens tag; stereo by default, mono when tagged)', () => {
    expect(detectProjection('sample_4000p_FISHEYE190_alpha.mp4')).toBe('fisheye190-sbs');
    expect(detectProjection('https://x/clip_MKX200.mp4')).toBe('fisheye200-sbs');
    expect(detectProjection('https://x/clip_VRCA220.mp4')).toBe('fisheye220-sbs');
    expect(detectProjection('https://x/clip_rf52.mp4')).toBe('fisheye190-sbs');
    expect(detectProjection('https://x/fisheye_mono.mp4')).toBe('fisheye190-mono');
  });
});

describe('compose/decompose projection', () => {
  it('composes each axis combination into a real mode', () => {
    expect(composeProjection('flat', 'mono')).toBe('flat-2d');
    expect(composeProjection('flat', 'sbs')).toBe('flat-sbs-full');           // defaults to full
    expect(composeProjection('flat', 'sbs', 190, 'half')).toBe('flat-sbs-half');
    expect(composeProjection('flat', 'sbs', 190, 'full')).toBe('flat-sbs-full');
    expect(composeProjection('flat', 'tb')).toBe('flat-tb');
    expect(composeProjection('180', 'sbs')).toBe('180-sbs');
    expect(composeProjection('360', 'tb')).toBe('360-tb');
    expect(composeProjection('fisheye', 'sbs', 200)).toBe('fisheye200-sbs');
    expect(composeProjection('fisheye', 'mono', 220)).toBe('fisheye220-mono');
  });

  it('every composed value is a defined mode', () => {
    for (const type of ['flat', '180', '360', 'fisheye'] as const) {
      for (const split of ['mono', 'sbs', 'tb'] as const) {
        for (const angle of [190, 200, 210, 220] as const) {
          expect(MODES[composeProjection(type, split, angle)]).toBeDefined();
        }
      }
    }
  });

  it('decompose is the inverse of compose across every axis', () => {
    const cases: Projection[] = ['180-tb', '360-mono', 'fisheye210-sbs', 'flat-tb', 'flat-2d', 'flat-sbs-half', 'flat-sbs-full'];
    for (const p of cases) {
      const s = decomposeProjection(p);
      expect(composeProjection(s.type, s.split, s.angle, s.flatWidth)).toBe(p);
    }
    // The two flat SBS variants differ only by flatWidth.
    expect(decomposeProjection('flat-sbs-half')).toEqual({ type: 'flat', split: 'sbs', angle: 190, flatWidth: 'half' });
    expect(decomposeProjection('flat-sbs-full')).toEqual({ type: 'flat', split: 'sbs', angle: 190, flatWidth: 'full' });
  });
});

describe('isFlatMode', () => {
  it('flags flat modes', () => {
    expect(isFlatMode('flat-2d')).toBe(true);
    expect(isFlatMode('flat-sbs-full')).toBe(true);
    expect(isFlatMode('180-sbs')).toBe(false);
    expect(isFlatMode('360-tb')).toBe(false);
  });
});
