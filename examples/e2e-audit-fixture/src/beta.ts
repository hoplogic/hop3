// @module: beta ^anc-struct-beta

import { c2f } from './alpha.js';

// 温度报告。见 design/beta.md。// @a: anc-obs-temp-report
export function report(c: number): string {
  const f = c2f(c);
  return `${c.toFixed(1)}°C = ${f.toFixed(1)}°F`;
}

// 本地化占位。// @a: anc-string-locale
export function locale(): string {
  return 'zh-CN';
}
