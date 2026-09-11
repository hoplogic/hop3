#!/usr/bin/env node
// @a: anc-meta-ci-baseline
// 锚点审计基线比对——check:audit 的挡线（ci-pipeline §4，2026-08-03 决策 3 拍板"基线锁定"）。
// 语义：变差 exit 1（报出恶化项）；变好 exit 0 + 提示人工更新基线（不自动放松，防"悄悄放松"）；
// 持平 exit 0。依赖 run-audit.mjs 先产出 .anchor-audit/cross_compare_results.yaml——
// 缺产物按 ^anc-meta-guard-trust 显式失败（exit 2），不静默跳过。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const yaml = require('js-yaml');

const baselinePath = join(ROOT, 'audits', 'baselines', 'anchor-baseline.json');
const resultsPath = join(ROOT, '.anchor-audit', 'cross_compare_results.yaml');

if (!existsSync(baselinePath)) {
  console.error('缺 audits/baselines/anchor-baseline.json——基线文件必须入库。不静默跳过。');
  process.exit(2);
}
if (!existsSync(resultsPath)) {
  console.error('缺 .anchor-audit/cross_compare_results.yaml——先跑 run-audit.mjs 产出扫描结果。不静默跳过。');
  process.exit(2);
}

const base = JSON.parse(readFileSync(baselinePath, 'utf-8'));
const d = yaml.load(readFileSync(resultsPath, 'utf-8'));

const current = {
  naming_violations: (d.naming_violations ?? []).length,
  invalid_refs: (d.invalid_refs ?? []).length,
  status_issues: (d.status_check ?? []).length,
  module_deps_mismatch: (d.module_deps_mismatch ?? []).length,
  // 边界零容忍（2026-08-12 作者定"立刻强化"——出口表滞后曾累积至17违规,清零后钉死:新增跨模块
  // import 必须同一次改动登记出口表,不再有"缓慢变差"空间）
  module_boundary_violations: (d.module_boundary_violations?.violations ?? []).length,
  export_comment_violations: (d.export_comment_violations?.violations ?? []).length,
  // 反向核（todo/0034,2026-08-30）:代码/测试锚点落点未入卡的差集——存量作基线起点只降不升
  card_missing_code_refs: (d.card_missing_code_refs ?? []).length,
  card_missing_test_refs: (d.card_missing_test_refs ?? []).length,
  design_to_code_covered_min: d.design_to_code?.covered ?? 0,
  code_to_test_covered_min: d.code_to_test?.covered ?? 0,
  code_to_traceability_covered_min: d.code_to_traceability?.covered ?? 0,
};

// *_covered_min 是"分子下限"（越大越好）；其余是违规计数（越小越好）
const isFloor = (k) => k.endsWith('_covered_min');

let worse = [], better = [];
for (const [k, baseVal] of Object.entries(base)) {
  if (k.startsWith('_')) continue;
  const cur = current[k];
  if (cur === undefined) { console.error(`基线字段 ${k} 在扫描结果中无对应值——脚本与基线字段脱节`); process.exit(2); }
  const degraded = isFloor(k) ? cur < baseVal : cur > baseVal;
  const improved = isFloor(k) ? cur > baseVal : cur < baseVal;
  if (degraded) worse.push(`${k}: 基线 ${baseVal} → 当前 ${cur}`);
  else if (improved) better.push(`${k}: 基线 ${baseVal} → 当前 ${cur}`);
}

if (worse.length) {
  console.error('❌ 锚点审计相比基线变差（新增违规见 run-audit 输出明细）：');
  for (const w of worse) console.error('   ' + w);
  process.exit(1);
}
if (better.length) {
  console.log('✅ 未变差，且有改善——请人工确认后更新 audits/baselines/anchor-baseline.json（不自动改，防悄悄放松）：');
  for (const b of better) console.log('   ' + b);
} else {
  console.log('✅ 锚点审计与基线持平。');
}
process.exit(0);
