import { describe, it, expect } from 'vitest';
import { formatTime } from '../src/ui/format.js';

describe('formatTime', () => {
  it('m:ss / h:mm:ss, guarding bad input', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(5)).toBe('0:05');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(3661)).toBe('1:01:01');
    expect(formatTime(NaN)).toBe('0:00');
    expect(formatTime(-3)).toBe('0:00');
  });
});
