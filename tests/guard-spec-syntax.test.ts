// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: hop-cli ^anc-struct-hop-cli
// G12 守卫（check-spec-syntax）docs 行文扫描面的判据回归——2026-08-13 作者定"扩"后按准入四步补
//（守卫自证:G12 上守卫时欠判据测试,本次扩面一并还）。见 chain-enforcement §1 G12 行。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARD = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-spec-syntax.mjs');

function runGuard(root: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [GUARD], {
      encoding: 'utf-8', env: { ...process.env, HOPJIT_CHECK_ROOT: root },
    });
    return { code: 0, out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function makeRepo(docLine: string): string {
  const root = mkdtempSync(join(tmpdir(), 'spec-syntax-fixture-'));
  mkdirSync(join(root, 'docs', 'design'), { recursive: true });
  mkdirSync(join(root, 'docs', 'rounds'), { recursive: true });
  writeFileSync(join(root, 'docs', 'design', 'x.md'), `# 设计\n\n${docLine}\n`);
  return root;
}

// @v: anc-meta-guard-admission —— G12 docs 行文扫描面正反例（负向验证,准入四步③）
describe('check-spec-syntax docs 行文扫描面', () => {
  it('反例：设计文档行文含旧写法（[check finally]）→ 红（旧术语在行文里繁殖的实撞形态）', () => {
    const r = runGuard(makeRepo('交付契约与 `[check finally]` 不可改。'));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('行文含旧写法');
  });

  it('正例：废止告示类合法提及（行含标记词）→ 豁免不误伤', () => {
    const r = runGuard(makeRepo('旧修饰 `check finally`：过渡期兼容读，将废止——新写一律 final。'));
    expect(r.code).toBe(0);
  });

  it('正例：rounds/ 整目录豁免（讨论存档不改正文）', () => {
    const root = makeRepo('干净行文。');
    writeFileSync(join(root, 'docs', 'rounds', 'old-draft.md'), '草案里写 [check finally] 也不管。\n');
    expect(runGuard(root).code).toBe(0);
  });

  it('正例：现行写法 [check final] 通过', () => {
    const r = runGuard(makeRepo('验收门用 `[check final]`，replan 不可改写。'));
    expect(r.code).toBe(0);
  });
});
