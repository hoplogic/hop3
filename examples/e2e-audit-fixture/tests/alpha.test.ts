// @module: alpha ^anc-struct-alpha
import { describe, it, expect } from 'vitest';
import { c2f } from '../src/alpha.js';

// @v: anc-rule-c2f-convert
describe('c2f', () => {
  it('converts 0C to 32F', () => { expect(c2f(0)).toBe(32); });
  it('converts 100C to 212F', () => { expect(c2f(100)).toBe(212); });
});

// @v: anc-error-abs-zero-reject
describe('c2f boundary', () => {
  it('rejects below absolute zero', () => { expect(() => c2f(-300)).toThrow(RangeError); });
});
