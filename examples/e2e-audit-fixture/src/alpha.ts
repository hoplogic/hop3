// @module: alpha ^anc-struct-alpha

// 摄氏转华氏。见 design/alpha.md。// @a: anc-rule-c2f-convert
export function c2f(c: number): number {
  if (typeof c !== 'number' || Number.isNaN(c)) throw new Error('not a number');
  if (c < -273.15) throw new RangeError('below absolute zero'); // @a: anc-error-abs-zero-reject
  return c * 9 / 5 + 32;
}
