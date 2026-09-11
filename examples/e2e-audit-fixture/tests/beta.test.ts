// @module: beta ^anc-struct-beta
import { describe, it, expect } from 'vitest';
import { report } from '../src/beta.js';

// @v: anc-obs-temp-report
describe('report', () => {
  it('formats with one decimal', () => { expect(report(0)).toBe('0.0°C = 32.0°F'); });
});
