#!/usr/bin/env node
// @a: anc-meta-chain-health
// 链健康度单一入口——跑全部确定性守卫，按 chain-enforcement §1 的结构（层内/跃迁/宪法/特性）
// 输出结构化报告；空白项照 §3 台账诚实标注"已知未守"；尾部固定提示本报告不覆盖的
// 语义审计与行为纪律两类守卫（防止把机检报告误读为全链体检，见 ^anc-meta-guard-kinds）。
// 退出码：任何红 → 1；全绿或仅黄（基线内欠账）→ 0。
// 契约见 design/chain-enforcement.md ^anc-meta-chain-health。
//
// 用法：node scripts/chain-health.mjs

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];   // { section, name, status: 'green'|'red'|'yellow', detail }
let hasRed = false;

function run(section, name, fn) {
  try {
    const detail = fn();
    results.push({ section, name, status: 'green', detail: detail ?? '' });
  } catch (e) {
    hasRed = true;
    results.push({ section, name, status: 'red', detail: String(e.message ?? e).slice(0, 400) });
  }
}
function yellow(section, name, detail) {
  results.push({ section, name, status: 'yellow', detail });
}
function gap(section, name, ledger) {
  results.push({ section, name, status: 'gap', detail: ledger });
}

// 找带 pyyaml 的 python（同 anchor-scan.test.ts 的教训：shell alias 在子进程不存在，
// 逐候选实测，找不到则显式红——不静默跳过）。见 ^anc-meta-guard-trust 禁止静默跳过。
function findPython() {
  const candidates = [
    process.env.HOPJIT_TEST_PYTHON,
    join(process.env.HOME ?? '', '.venv', 'bin', 'python3'),
    'python3', 'python',
  ].filter(Boolean);
  for (const py of candidates) {
    try { execFileSync(py, ['-c', 'import yaml'], { stdio: 'ignore', timeout: 10000 }); return py; }
    catch { /* next */ }
  }
  return null;
}

// ───────────────────────────── 层内守卫 ─────────────────────────────
run('层内', 'tsc --noEmit（代码层类型）', () => {
  execSync('npx tsc --noEmit', { cwd: ROOT, stdio: 'pipe', timeout: 120000 });
});
run('层内', 'check-anchor-format（锚点前空格）', () => {
  execFileSync('node', [join(ROOT, 'scripts/check-anchor-format.mjs')], { stdio: 'pipe', timeout: 30000 });
});
run('层内', 'vitest（测试层 872+ 例，附覆盖率产物）', () => {
  // 不依赖 reporter 文本格式（曾因 tail 截错行误报）——vitest 失败时非零退出即抛，
  // 通过则从完整输出解析计数（解析不到不算失败，只是少了计数信息）。
  // --coverage 顺产 json-summary 供下方 C→T 覆盖率基线比对（一次跑测试两用）。
  const out = execSync('npm run -s build && npx vitest run --coverage --coverage.reporter=text --coverage.reporter=json-summary 2>&1', { cwd: ROOT, encoding: 'utf-8', timeout: 300000, shell: '/bin/sh' });
  const m = out.match(/Tests\s+(\d+) passed/);
  return m ? `${m[1]} passed` : 'passed（未解析到计数）';
});
run('跃迁', 'coverage 基线（C→T 行/分支不许变差，原 G7）', () => {
  const out = execFileSync('node', [join(ROOT, 'scripts/check-coverage-baseline.mjs')], { encoding: 'utf-8', timeout: 30000 });
  return out.trim().split('\n').pop();
});

// ───────────────────── 跃迁守卫 + 追溯（scan/cross_compare）─────────────────────
const py = findPython();
if (!py) {
  hasRed = true;
  results.push({ section: '跃迁', name: 'anchor-audit（scan+cross_compare）', status: 'red',
    detail: '未找到装 pyyaml 的 python——uv pip install pyyaml 或 HOPJIT_TEST_PYTHON=<路径>。不静默跳过。' });
} else {
  run('跃迁', 'scan.py（锚点采集+命名+模块归属）', () => {
    try { execFileSync(py, [join(ROOT, 'scripts/audit/scan.py'), ROOT], { stdio: 'pipe', timeout: 60000 }); }
    catch (e) { if (e.status !== 1) throw e; /* exit 1 = 有发现，交下一步比对基线 */ }
  });
  run('跃迁', 'cross_compare.py（覆盖/引用/状态/边界）', () => {
    try { execFileSync(py, [join(ROOT, 'scripts/audit/cross_compare.py'), ROOT], { stdio: 'pipe', timeout: 60000 }); }
    catch (e) { if (e.status !== 1) throw e; }
    // 读结果，硬指标（已归零项）红线 + 欠账项黄牌
    const y = readFileSync(join(ROOT, '.anchor-audit/cross_compare_results.yaml'), 'utf-8');
    const num = (k) => { const m = y.match(new RegExp(`^\\s*${k}: (\\d+)`, 'm')); return m ? +m[1] : null; };
    const zeroLocked = { naming_violations: num('naming_violations'), invalid: null };
    // summary 块里的计数
    const nv = num('naming_violations');
    if (nv > 0) throw new Error(`命名违规回升到 ${nv}（基线 0，已锁定）`);
    const mb = (y.match(/module_boundary[\s\S]{0,200}?violations:\s*\[\]/) || y.match(/boundary_violations: 0/)) ? 0 : null;
    const inv = num('invalid_refs');
    const st = num('status_issues');
    if (inv !== null && inv > 0) yellow('跃迁', `无效引用（已知欠账）`, `${inv} 处（基线管理见 ci-pipeline ^anc-meta-ci-baseline）`);
    if (st !== null && st > 0) yellow('跃迁', `状态标记问题（已知欠账）`, `${st} 处`);
    return `命名违规 ${nv ?? '?'}`;
  });
}

run('跃迁', 'check-design-first（设计先行·时序）', () => {
  execSync('./scripts/check-design-first.sh HEAD~1..HEAD', { cwd: ROOT, stdio: 'pipe', timeout: 30000, shell: '/bin/sh' });
});
run('跃迁', 'check-version-lock（版本-接口互锁，G9）', () => {
  execFileSync('node', [join(ROOT, 'scripts/check-version-lock.mjs')], { stdio: 'pipe', timeout: 30000 });
});

// ───────────────────────────── 特性专属守卫 ─────────────────────────────
run('特性', 'check-driver-carriers（Codex 纪律 + CC/Codex parity）', () => {
  execFileSync('node', [join(ROOT, 'scripts/check-driver-carriers.mjs')], { stdio: 'pipe', timeout: 30000 });
});

// G1 守卫：examples + audit 两目录 spec 全量校验（hopjit list 判可执行 → 逐个 validate）
// 实证必要性：2026-08-02 发现 V8 规则加入后 examples/doc-review.md 失效无人知。
// audit/ 于 2026-08-08 自 examples/ 迁出（审计工具链是基础设施非演示），校验覆盖随迁。
run('特性', 'examples+audit spec 校验（G1 守卫）', () => {
  const cli = join(ROOT, 'dist/cli.js');
  if (!existsSync(cli)) throw new Error('dist/cli.js 不存在——先 npm run build');
  let total = 0;
  const bad = [];
  for (const dir of ['examples', 'scripts/audit']) {
    const listOut = execFileSync('node', [cli, '--json', 'list', dir], { cwd: ROOT, encoding: 'utf-8', timeout: 30000 });
    const specs = JSON.parse(listOut).specs ?? [];
    if (dir === 'examples' && specs.length === 0) throw new Error('list 未发现任何可执行 spec——list 判据可能被改坏');
    total += specs.length;
    for (const s of specs) {
      const out = execFileSync('node', [cli, '--json', 'validate', join(dir, s.file)], { cwd: ROOT, encoding: 'utf-8', timeout: 30000 });
      const r = JSON.parse(out);
      if (r.status !== 'ok') bad.push(`${dir}/${s.file}: ${(r.errors ?? []).map(e => e.rule).join(',')}`);
    }
  }
  if (bad.length) throw new Error(`失效 spec ${bad.length}/${total}：\n  ${bad.join('\n  ')}`);
  return `${total} 个可执行 spec 全部合法（examples+audit）`;
});

// ───────────────────────────── 终点凭证状态（守卫规范 §六：闭环制品）─────────────────────────────
// 终点=e2e 实测+hoplog 分析（^anc-guard-e2e-primacy）。本段只报状态不判红绿——
// 凭证过期在日常是常态（每次提交都会推陈），只有 release 闸才把过期判死。// @a: anc-driver-live-e2e-evidence
run('终点', 'e2e 终点凭证（.e2e-evidence/，release 硬闸原料）', () => {
  const head = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  const parts = [];
  for (const scen of ['cc-delegated', 'codex-delegated']) {
    const f = `.e2e-evidence/${scen}.json`;
    if (!existsSync(f)) { parts.push(`${scen}: 无凭证`); continue; }
    const ev = JSON.parse(readFileSync(f, 'utf-8'));
    const fresh = ev.commit === head;
    parts.push(`${scen}: ${ev.commit.slice(0, 8)}${fresh ? '（=HEAD ✓）' : '（≠HEAD，发版前需重跑）'}`);
  }
  return parts.join('；');
});

// ───────────────────────────── 空白台账呈现 ─────────────────────────────
gap('空白', '设计承诺未实现类（pause-timeout 类）', 'G2·接受不守（机检层）——归语义审计');
gap('空白', 'S→D 语义审计节奏', 'G3·补节奏——里程碑必跑 anchor-audit skill');
gap('空白', '比喻不指代/推演链显式', 'G4·接受不守（机检层）——纯语义靠评审');
// G5/G6 已销账（G5=release.sh 2026-08-04；G6=concepts 快照建库 2026-08-03）——已从台账移除，此处同步
gap('空白', 'e2e 核真过程元守卫（lint 执行类 e2e 含日志断言）', 'G11 余量·待定（截止：执行类 e2e 达 5 处）');

// ───────────────────────────── 报告 ─────────────────────────────
const ICON = { green: '✅', red: '❌', yellow: '🟡', gap: '⬜' };
let cur = '';
console.log('═══ 链健康度报告（chain-enforcement §1 结构）═══\n');
for (const r of results) {
  if (r.section !== cur) { cur = r.section; console.log(`【${cur}】`); }
  console.log(`  ${ICON[r.status]} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
}
console.log(`
─── 本报告不覆盖（见 chain-enforcement ^anc-meta-guard-kinds）───
  · 语义审计（S→D 忠实性、实现符合契约意图）→ 跑 anchor-audit skill（LLM 读源文件）
  · 行为纪律（收链前置、默认动手问是例外）→ 人评审；唯一机检例外是上方"设计先行"
  ⚠️ 机检全绿 ≠ 实现链健康——那只是第一类守卫的结论。`);
process.exit(hasRed ? 1 : 0);
