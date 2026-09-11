#!/usr/bin/env node
// check:e2e-assertions——e2e 断言存档重放守卫（G13②,design carrier-live-e2e ^anc-driver-live-e2e-assertions）。
// 对 .e2e-evidence/passes/ 的脱敏归档（.hopstate+.hoplog,通过时真实形状）干跑各场景断言的账面部分
// （offline 模式:事件流/终态文本判据跳过）——契约演进改动账面形状时,断言的陈旧假设离线即红,
// 不潜伏到下次真机（诞生实撞 2026-08-11:parallel-partial 断言存旧通道形状,统一模型迁移唯它漏改）。
// 归档缺席=跳过并明说（归档是 gitignore 本地资产,新 clone 无归档不红）。
// @a: anc-driver-live-e2e-assertions
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertScenario } from './carrier-live-e2e-lib.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
// HOPJIT_E2E_EVIDENCE_ROOT：负向验证/测试用归档根覆盖（默认库内 .e2e-evidence）
const evidenceRoot = process.env.HOPJIT_E2E_EVIDENCE_ROOT ?? join(repo, '.e2e-evidence');
const passesRoot = join(evidenceRoot, 'passes');

// 归档目录名 slug → 场景名（归档时 ':' 替换为 '-',还原需按已知场景表匹配——slug 不可逆解析）
const SCENARIOS = [
  'cc:delegated', 'codex:delegated', 'codex:flash', 'codex:demo',
  'codex:standalone', 'cc:standalone', 'codex:standalone-parallel',
  'cc:parallel', 'codex:parallel',
  'cc:repair', 'cc:adaptive', 'cc:uncaught', 'cc:parallel-partial', 'cc:paused', 'cc:call-fail',
  'cc:call', 'cc:anchor-audit',
];
const bySlug = new Map(SCENARIOS.map(s => [s.replace(/:/g, '-'), s]));

if (!existsSync(passesRoot)) {
  console.log('check:e2e-assertions —— 无 .e2e-evidence/passes/ 归档（本地未跑过真机）,跳过。');
  process.exit(0);
}

const dirs = readdirSync(passesRoot).filter(d => !d.startsWith('.'));
let ran = 0, failed = 0;
const skipped = [];
for (const name of dirs) {
  // 目录名形如 <slug>-<ISO时间戳>——按最长前缀匹配场景 slug
  const slug = [...bySlug.keys()].filter(k => name.startsWith(`${k}-2`)).sort((a, b) => b.length - a.length)[0];
  if (!slug) { skipped.push(name); continue; }
  const scenario = bySlug.get(slug);
  const workspace = join(passesRoot, name);
  if (!existsSync(join(workspace, '.hopstate'))) { skipped.push(name); continue; }
  try {
    assertScenario({ scenario, normalized: [], finalText: '', mainText: '', workspace, offline: true });
    ran++;
    console.log(`✅ ${scenario}  (${name})`);
  } catch (err) {
    failed++;
    console.error(`❌ ${scenario}  (${name}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (skipped.length) console.log(`⏭  跳过 ${skipped.length} 份（未知场景 slug 或缺 .hopstate）: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}`);

// 凭证指针核验（2026-08-12 归档蒸发实撞后加固）：每份凭证 JSON 的 evidence_archive 指针
// 必须指向在场目录——归档被误删/手滑清掉时凭证还挂着"可抽查"的空承诺,离线即红。
// 指针字段缺席=旧格式凭证（场景废除/早于字段引入）,跳过不红。
let deadPointers = 0;
for (const f of readdirSync(evidenceRoot).filter(n => n.endsWith('.json'))) {
  let cred;
  try { cred = JSON.parse(readFileSync(join(evidenceRoot, f), 'utf-8')); } catch { continue; }
  const arch = cred.evidence_archive;
  if (typeof arch !== 'string' || !arch) continue;
  if (!existsSync(arch)) {
    deadPointers++;
    console.error(`❌ 凭证指针悬空: ${f} → ${arch}（归档不在场——"通过可抽查"承诺已空）`);
  }
}
failed += deadPointers;
console.log(failed === 0
  ? `═══ e2e 断言存档重放通过（${ran} 份归档）═══`
  : `═══ ${failed} 份归档断言失败——契约与断言漂移,修断言或核契约回归 ═══`);
process.exit(failed === 0 ? 0 : 1);
