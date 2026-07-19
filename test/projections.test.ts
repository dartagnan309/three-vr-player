import { describe, it, expect } from 'vitest';
import { detectProjection, isFlatMode } from '../src/core/projections.js';

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
});

describe('isFlatMode', () => {
  it('flags flat modes', () => {
    expect(isFlatMode('flat-2d')).toBe(true);
    expect(isFlatMode('flat-sbs-full')).toBe(true);
    expect(isFlatMode('180-sbs')).toBe(false);
    expect(isFlatMode('360-tb')).toBe(false);
  });
});
