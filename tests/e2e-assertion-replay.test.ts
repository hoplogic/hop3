// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: hop-cli ^anc-struct-hop-cli
// e2e 断言存档重放守卫（G13②）的判据回归——offline 模式对合成归档的正/负向核验 +
// check-e2e-assertions.mjs 的进程级正反例（守卫准入四步之负向验证,持久化形态）。
// 见 design/carrier-live-e2e.md ^anc-driver-live-e2e-assertions。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

// 合成一份 cc:parallel-partial 通过态归档（账面形状=断言当前契约假设：
// doubled_list 长度2 / summary=collected=2 / 父账零 failed / reap 1失败2完成 / dispatch≥3 / 无在飞）
function makeArchive(root: string, mutate?: (vars: Record<string, unknown>, state: Record<string, unknown>, hoplog: { text: string }) => void): string {
  const stamp = '2026-08-12T00-00-00-000Z';
  const dir = join(root, 'passes', `cc-parallel-partial-${stamp}`);
  const inst = join(dir, '.hopstate', 'inst-1');
  mkdirSync(inst, { recursive: true });
  const state: Record<string, unknown> = {
    format_version: 1,
    step_states: { '1': 'done', '1.1': 'done', '2': 'done' },
    retry_counters: {},
    loop_counters: {},
    inflight: [
      { child: '1.1.1', status: 'reaped' },
      { child: '1.1.2', status: 'reaped' },
      { child: '1.1.3', status: 'reaped' },
    ],
  };
  const vars: Record<string, unknown> = { doubled_list: [6400, 8200], summary: 'collected=2' };
  const hoplog = {
    text: [
      'run: e2e-parallel',
      'dispatch:', '  child: 1.1.1', 'dispatch:', '  child: 1.1.2', 'dispatch:', '  child: 1.1.3',
      'reap:', '  child: 1.1.1', '  status: completed',
      'reap:', '  child: 1.1.2', '  status: failed',
      'reap:', '  child: 1.1.3', '  status: completed',
      'status: completed',
    ].join('\n'),
  };
  mutate?.(vars, state, hoplog);
  writeFileSync(join(inst, 'state.json'), JSON.stringify(state));
  writeFileSync(join(inst, 'vars.json'), JSON.stringify({ scopes: { root: { variables: vars } } }));
  const runDir = join(dir, '.hoplog', 'run-1');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'main.yaml'), hoplog.text);
  return dir;
}

function runGuard(root: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ['scripts/check-e2e-assertions.mjs'], {
      encoding: 'utf-8', env: { ...process.env, HOPJIT_E2E_EVIDENCE_ROOT: root },
    });
    return { code: 0, out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// @v: anc-driver-live-e2e-assertions —— 存档重放守卫正反例（负向验证:准入四步③）
describe('check:e2e-assertions 存档重放守卫', () => {
  it('正例：合成通过态归档 → 守卫绿（账面形状与断言契约一致）', () => {
    const root = mkdtempSync(join(tmpdir(), 'e2e-replay-pos-'));
    makeArchive(root);
    const r = runGuard(root);
    expect(r.out).toContain('✅ cc:parallel-partial');
    expect(r.code).toBe(0);
  });

  it('反例：账面形状漂移（doubled_list 长度1）→ 守卫红非零退出（陈旧断言假设离线即暴露）', () => {
    const root = mkdtempSync(join(tmpdir(), 'e2e-replay-neg-'));
    makeArchive(root, vars => { vars['doubled_list'] = [6400]; });
    const r = runGuard(root);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('doubled_list');
  });

  it('反例：HopLog reap 凭据缺失 → 守卫红（过程轨迹面也在重放覆盖内）', () => {
    const root = mkdtempSync(join(tmpdir(), 'e2e-replay-neg2-'));
    makeArchive(root, (_v, _s, hoplog) => { hoplog.text = hoplog.text.replace('  status: failed', '  status: completed'); });
    const r = runGuard(root);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('reap');
  });

  // standalone 真空回归（2026-08-12 review 实撞：该断言原零盘面读取,offline 恒真空绿——修后必须实核账面）
  it('反例：standalone 归档账面破坏（weekly_report 缺 27600）→ 守卫红（原真空绿版本测不出此破坏）', () => {
    const root = mkdtempSync(join(tmpdir(), 'e2e-replay-sa-'));
    const dir = join(root, 'passes', 'cc-standalone-2026-08-12T00-00-00-000Z');
    const inst = join(dir, '.hopstate', 'inst-1');
    mkdirSync(inst, { recursive: true });
    writeFileSync(join(inst, 'state.json'), JSON.stringify({ format_version: 1, step_states: { '1': 'done' }, retry_counters: {}, loop_counters: {} }));
    writeFileSync(join(inst, 'vars.json'), JSON.stringify({ scopes: { root: { variables: { weekly_report: '周报但数字错了' } } } }));
    const runDir = join(dir, '.hoplog', 'run-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'main.yaml'), 'execution:\n  "1":\n    hitl:\n      decision: ok\nstatus: completed\nverdict: v\nreport_ok: true\n');
    const r = runGuard(root);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('27600');
  });

  it('反例：standalone-parallel 归档账面破坏（在飞残留）→ 守卫红（委托 parallel 冒烟账面部分生效——原真空绿版本同测不出）', () => {
    const root = mkdtempSync(join(tmpdir(), 'e2e-replay-sap-'));
    const dir = join(root, 'passes', 'codex-standalone-parallel-2026-08-12T00-00-00-000Z');
    const inst = join(dir, '.hopstate', 'inst-1');
    mkdirSync(inst, { recursive: true });
    writeFileSync(join(inst, 'state.json'), JSON.stringify({
      format_version: 1, step_states: { '1': 'done' }, retry_counters: {}, loop_counters: {},
      inflight: [{ child: '1.1.1', status: 'inflight' }],   // 在飞残留=账面破坏
    }));
    writeFileSync(join(inst, 'vars.json'), JSON.stringify({ scopes: { root: { variables: { doubled_list: [6400, 5600, 8200], summary: 'collected=3' } } } }));
    const runDir = join(dir, '.hoplog', 'run-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'main.yaml'), ['dispatch:', 'dispatch:', 'dispatch:', 'status: completed'].join('\n'));
    const r = runGuard(root);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('在飞');
  });

  it('正例：归档缺席 → 跳过明说、零退出（新 clone 无归档不红）', () => {
    const root = mkdtempSync(join(tmpdir(), 'e2e-replay-empty-'));
    const r = runGuard(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('跳过');
  });

  // 凭证指针核验（2026-08-12 归档蒸发实撞后加固——滚动保留曾误删刚落盘归档,凭证挂空指针无人知）
  it('反例：凭证 evidence_archive 指向不存在目录 → 守卫红（"通过可抽查"承诺已空）', () => {
    const root = mkdtempSync(join(tmpdir(), 'e2e-replay-deadptr-'));
    makeArchive(root);   // 归档面正常
    writeFileSync(join(root, 'cc-call.json'), JSON.stringify({
      scenario: 'cc:call', evidence_archive: join(root, 'passes', 'cc-call-2026-08-12T99-99-99-999Z'),
    }));
    const r = runGuard(root);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('悬空');
  });

  it('正例：凭证无 evidence_archive 字段（旧格式）→ 跳过不红；指针在场 → 绿', () => {
    const root = mkdtempSync(join(tmpdir(), 'e2e-replay-ptr-ok-'));
    const dir = makeArchive(root);
    writeFileSync(join(root, 'cc-parallel-partial.json'), JSON.stringify({ scenario: 'cc:parallel-partial', evidence_archive: dir }));
    writeFileSync(join(root, 'codex-inline.json'), JSON.stringify({ scenario: 'codex:inline' }));   // 无指针字段
    const r = runGuard(root);
    expect(r.code).toBe(0);
  });
});
