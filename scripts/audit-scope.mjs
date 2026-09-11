// 语义审计增量范围推导：按模块台账（semantic_audit_summary.yaml module_ledger）× git diff
// 自动算"哪些模块自上次审计后动过 src"，输出可直接粘贴的按模块跑命令。// @a: anc-meta-guard-trust
// 用法：node scripts/audit-scope.mjs
// 判定：每模块取台账里的 audited_commit（无台账/无记录=从未审过→入范围）；
//       git diff <audited_commit>..HEAD -- src/ 里该模块文件有改动→入范围。
// 只读工具零副作用；范围为空时明确说"无需增量审计"。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, globSync } from 'node:fs';

const ROOT = process.env['HOPJIT_CHECK_ROOT'] ?? new URL('..', import.meta.url).pathname;
const SUMMARY = `${ROOT}/.anchor-audit/semantic_audit_summary.yaml`;

function git(...args) {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf-8', stdio: 'pipe' }).trim();
}

// src 文件 → @module 映射（与 scan.py 同源判据：文件头 @module: 标注）
const fileModule = new Map();
for (const f of globSync(`${ROOT}/src/**/*.ts`)) {
  const head = readFileSync(f, 'utf-8').slice(0, 2000);
  const m = head.match(/@module:\s*([a-z0-9-]+)/);
  if (m) fileModule.set(f.slice(ROOT.length).replace(/^\/+/, ''), m[1]);
}
if (fileModule.size === 0) {
  console.error('audit-scope FAILED: src/ 未发现任何 @module: 标注——扫描面异常，不静默空转。');
  process.exit(2);
}
const allModules = new Set(fileModule.values());

// 台账：模块 → 上次审于哪个 commit（简易 YAML 读取——只取 module_ledger 下的 "name: {audited_commit: xxx}" 形）
const ledger = new Map();
if (existsSync(SUMMARY)) {
  const text = readFileSync(SUMMARY, 'utf-8');
  const sec = text.split(/^module_ledger:/m)[1] ?? '';
  for (const m of sec.matchAll(/^ {2}([a-z0-9-]+):\s*\n(?: {4}.*\n)*? {4}audited_commit:\s*"?([0-9a-f]{7,40})"?/gm)) {
    ledger.set(m[1], m[2]);
  }
}

const HEAD = git('rev-parse', 'HEAD');
const stale = [];   // [module, reason]
for (const mod of [...allModules].sort()) {
  const base = ledger.get(mod);
  if (!base) { stale.push([mod, '台账无记录（从未审过或旧产物无台账）']); continue; }
  let changed;
  try {
    changed = git('diff', '--name-only', `${base}..HEAD`, '--', 'src/')
      .split('\n').filter(Boolean).filter(f => fileModule.get(f) === mod);
  } catch {
    stale.push([mod, `台账 commit ${base.slice(0, 8)} 不在本仓库（rebase/浅克隆?）——保守入范围`]);
    continue;
  }
  if (changed.length > 0) stale.push([mod, `${changed.length} 文件改动 since ${base.slice(0, 8)}`]);
}

if (stale.length === 0) {
  console.log(`✅ 增量范围为空：全部 ${allModules.size} 个模块自上次审计（台账）以来 src 零改动，无需增量语义审计。HEAD=${HEAD.slice(0, 8)}`);
  process.exit(0);
}
console.log(`语义审计增量范围（HEAD=${HEAD.slice(0, 8)}，${stale.length}/${allModules.size} 模块）：`);
for (const [mod, why] of stale) console.log(`  ${mod}  ← ${why}`);
console.log('\n按模块跑命令（hopskill）：');
console.log(`/hopspec run scripts/audit/anchor-audit.md --params '{"modules": "${stale.map(([m]) => m).join(' ')}"}'`);
