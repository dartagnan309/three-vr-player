import { describe, it, expect } from 'vitest';
import { clampAngles } from '../src/core/LookControls.js';

describe('clampAngles', () => {
  it('clamps to the front hemisphere', () => {
    expect(clampAngles(200, 200)).toEqual({ lon: 90, lat: 85 });
    expect(clampAngles(-200, -200)).toEqual({ lon: -90, lat: -85 });
    expect(clampAngles(10, -10)).toEqual({ lon: 10, lat: -10 });
  });
});
