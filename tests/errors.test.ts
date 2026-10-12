// @module: shared-errors ^anc-error-error-code
// shared-errors 专属测试（todo/0129 A 组——模块此前零测试文件;行为散在各模块测试,本文件只钉"设计表与枚举集合一致"这条机检面）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorCode } from '../src/errors.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// @v: anc-error-code-table-sync
describe('ErrorCode 枚举与 shared-errors 设计表集合一致（todo/0129 A 组,两向各漏过一次后立机检）', () => {
  const doc = readFileSync(join(REPO, 'docs', 'design', 'shared-errors.md'), 'utf-8');
  const table = new Set([...doc.matchAll(/^\| `([A-Z_]+)` \| /gm)].map(m => m[1]));
  const enumSet = new Set(Object.values(ErrorCode).filter(v => typeof v === 'string') as string[]);

  it('正例：设计表第一列的每个错误码都在枚举里（表加了码、枚举漏加 → 红点名——2026-09-06 ADVANCE_ORDER_VIOLATION 实撞）', () => {
    const missingInEnum = [...table].filter(c => !enumSet.has(c));
    expect(missingInEnum, `设计表有、枚举没有：${missingInEnum.join(', ')}`).toEqual([]);
  });
  it('正例：枚举的每个成员都在设计表里（枚举加了码、表漏登 → 红点名——2026-10-07 DIRS_NOT_APPROVED 实撞）', () => {
    const missingInTable = [...enumSet].filter(c => !table.has(c));
    expect(missingInTable, `枚举有、设计表没有：${missingInTable.join(', ')}`).toEqual([]);
  });
  it('反例：表解析真读到了码（防正则与表格式漂移后两集合同为空而假绿）', () => {
    expect(table.size).toBeGreaterThan(20);
    expect(table.has('SCHEMA_MISMATCH')).toBe(true);
    expect(enumSet.size).toBe(table.size);
  });
});
