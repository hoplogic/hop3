#!/usr/bin/env node
// @a: anc-meta-ci-baseline
// 测试覆盖率基线比对（与 check-anchor-baseline 同一"基线锁定"语义，原 G7）。
// 读 vitest --coverage 的 json-summary 产物；缺产物显式 exit 2（^anc-meta-guard-trust）。
// 阈值取整数位留 0.2% 抖动余量——覆盖率随代码增删有小数位波动，锁死两位小数会误红。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(ROOT, 'audits', 'baselines', 'coverage-baseline.json');
const summaryPath = join(ROOT, 'coverage', 'coverage-summary.json');

if (!existsSync(baselinePath)) { console.error('缺 audits/baselines/coverage-baseline.json。不静默跳过。'); process.exit(2); }
if (!existsSync(summaryPath)) {
  console.error('缺 coverage/coverage-summary.json——先跑 npx vitest run --coverage（reporter 须含 json-summary）。不静默跳过。');
  process.exit(2);
}

const base = JSON.parse(readFileSync(baselinePath, 'utf-8'));
const sum = JSON.parse(readFileSync(summaryPath, 'utf-8'));

// 只算 src/ 下文件的汇总（total 含 scripts/examples 的 0% 会失真）
let lines = { covered: 0, total: 0 }, branches = { covered: 0, total: 0 };
for (const [file, v] of Object.entries(sum)) {
  if (file === 'total' || !file.includes('/src/')) continue;
  lines.covered += v.lines.covered; lines.total += v.lines.total;
  branches.covered += v.branches.covered; branches.total += v.branches.total;
}
if (!lines.total) { console.error('coverage-summary 中未找到 src/ 文件——产物结构变了？'); process.exit(2); }

const linePct = 100 * lines.covered / lines.total;
const branchPct = 100 * branches.covered / branches.total;
const fmt = (x) => x.toFixed(2) + '%';

let worse = [];
if (linePct < base.src_lines_min) worse.push(`src 行覆盖 ${fmt(linePct)} < 基线下限 ${base.src_lines_min}%`);
if (branchPct < base.src_branches_min) worse.push(`src 分支覆盖 ${fmt(branchPct)} < 基线下限 ${base.src_branches_min}%`);

if (worse.length) {
  console.error('❌ 测试覆盖率跌破基线：');
  for (const w of worse) console.error('   ' + w);
  process.exit(1);
}
console.log(`✅ 覆盖率不低于基线：src 行 ${fmt(linePct)}（≥${base.src_lines_min}%）、分支 ${fmt(branchPct)}（≥${base.src_branches_min}%）`);
process.exit(0);
