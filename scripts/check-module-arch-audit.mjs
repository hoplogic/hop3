#!/usr/bin/env node
// G10 守卫：模块架构工程链审计（^anc-meta-module-design-artifacts 必备件④——作者定名 2026-08-06）。
// 审的是"模块在架构层全局视图中的在场性"：代码里存在的模块必须在全库架构图上可见。
// 判据：src @module: 声明的模块名集合，必须全部出现在三处全局视图——
//   Doctree.md「模块索引」、ARCHITECTURE.md、docs/design/module-principles.md §7 盘点。
// 实撞背景：2026-08-06 mcp-server 代码/纵向锚点全齐，三处视图滞后数轮提交无红灯，靠人盘出。
// 见 design/chain-enforcement.md §1a、module-principles ^anc-meta-module-arch-audit（三落点判据权威）。// @a: anc-meta-module-arch-audit
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// HOPJIT_CHECK_ROOT：判据回归测试注入 fixture 仓库根（chain-enforcement §5 硬要求 2——守卫判据自身要有测试）；生产恒缺省
const ROOT = process.env['HOPJIT_CHECK_ROOT'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');

// 源 = 代码里的 @module: 声明（与 scan.py 模块归属同源事实）
const modules = new Set();
for (const f of readdirSync(join(ROOT, 'src')).filter(f => f.endsWith('.ts'))) {
  const m = readFileSync(join(ROOT, 'src', f), 'utf-8').match(/@module:\s*([\w-]+)/);
  if (m) modules.add(m[1]);
}
if (modules.size === 0) {
  console.error('check-module-views: src 未发现任何 @module: 声明——判据源异常，显式失败（不静默跳过）');
  process.exit(2);
}

const VIEWS = [
  ['Doctree.md', join(ROOT, 'Doctree.md')],
  ['ARCHITECTURE.md', join(ROOT, 'ARCHITECTURE.md')],
  ['module-principles.md §7 盘点', join(ROOT, 'docs', 'design', 'module-principles.md')],
];

const violations = [];
for (const [label, path] of VIEWS) {
  const content = readFileSync(path, 'utf-8');
  for (const mod of modules) {
    if (!content.includes(mod)) violations.push(`${label} 缺模块 '${mod}'——新建/改名模块须同一次改动更新架构视图（必备件④）`);
  }
}

if (violations.length > 0) {
  console.error('❌ 模块架构工程链审计违规（G10）：');
  for (const v of violations) console.error('   ' + v);
  process.exit(1);
}
console.log(`Module arch-audit passed.（${modules.size} 模块在 Doctree/ARCHITECTURE/盘点三处架构视图全在场）`);
