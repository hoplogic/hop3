#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// V8 原生覆盖率报告器（零新依赖）——读 NODE_V8_COVERAGE 目录（多进程多文件自动合并:
// 真机档的 CLI/server/子实例全是 node 进程,env 自动传播,各自落一份 JSON）,报告 dist/*.js
// 逐文件行覆盖率。语义=「该次运行触达了引擎多少行」,未触达行=该测量面的盲区清单,
// 不是质量分（vitest 单测覆盖率另有 check:coverage 基线,两者测的面不同不可比）。
// 用法：node scripts/coverage-report.mjs <coverage-dir> [--min-lines 50] [--top 15]
// 挂法：NODE_V8_COVERAGE=<dir> <任意 fuzz/真机命令> && node scripts/coverage-report.mjs <dir>
// design [[chain-enforcement]] 时机表 / [[spec-parser#^anc-meta-parser-fuzz]] 覆盖率条款。
// @a: anc-meta-parser-fuzz, anc-driver-live-e2e-entry

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// --face <manifest.json>：目标面清单模式（parser-fuzz 用）——target/partial/out 三档定性,
// 分母=target;partial/out 打 vitest 单测真实数字（现场读 coverage/coverage-summary.json,
// 产物缺席明示不打陈数）;加载链出现清单外新文件=红（防分母静默漂移）。
const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error(`用法: node scripts/coverage-report.mjs <coverage-dir>（目录不存在: ${dir ?? '(缺参)'}）`);
  process.exit(2);
}
const topN = Number(process.argv[process.argv.indexOf('--top') + 1]) || 15;

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const distPrefix = 'dist/';

// 逐进程覆盖文件合并：同 URL 的 ranges 取并（count>0 即覆盖——报告面不需要计数精度）
const files = readdirSync(dir).filter(f => f.startsWith('coverage-') && f.endsWith('.json'));
if (files.length === 0) {
  console.error(`coverage 目录空（${dir}）——运行时未设 NODE_V8_COVERAGE 或进程未退出落盘。`);
  process.exit(2);
}

const byUrl = new Map();   // url -> { covered: Set<line>, uncovered: Set<line> 聚合前的 ranges }
for (const f of files) {
  let cov;
  try { cov = JSON.parse(readFileSync(join(dir, f), 'utf-8')); } catch { continue; }
  for (const r of cov.result ?? []) {
    if (!r.url.startsWith('file://')) continue;
    const p = fileURLToPath(r.url);
    if (!p.startsWith(join(projectRoot, distPrefix))) continue;
    if (!byUrl.has(r.url)) byUrl.set(r.url, []);
    byUrl.get(r.url).push(r.functions);
  }
}
if (byUrl.size === 0) {
  console.error(`coverage 数据里无 ${distPrefix} 文件——被测进程未加载引擎产物?（${files.length} 份进程覆盖文件已读）`);
  process.exit(2);
}

// 面清单模式:
const faceIdx = process.argv.indexOf('--face');
const face = faceIdx > 0 ? JSON.parse(readFileSync(process.argv[faceIdx + 1], 'utf-8')) : null;
const vitestSummaryPath = join(projectRoot, 'coverage', 'coverage-summary.json');
const vitestPct = (distFile) => {
  if (!existsSync(vitestSummaryPath)) return null;
  const sum = JSON.parse(readFileSync(vitestSummaryPath, 'utf-8'));
  const srcName = distFile.replace(/\.js$/, '.ts');
  const hit = Object.entries(sum).find(([k]) => k.endsWith(`/src/${srcName}`));
  return hit ? hit[1].lines.pct : null;
};

const rows = [];
for (const [url, fnSets] of byUrl) {
  const src = readFileSync(fileURLToPath(url), 'utf-8');
  const lineOf = []; let pos = 0;
  for (const l of src.split('\n')) { lineOf.push([pos, pos + l.length]); pos += l.length + 1; }
  const lineAt = (off) => {
    let lo = 0, hi = lineOf.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (lineOf[m][1] < off) lo = m + 1; else hi = m; }
    return lo;
  };
  // 合并语义：任一进程覆盖即覆盖（并集）；行属于"在面"=被任一 range 触及
  const all = new Set(), covered = new Set();
  for (const fns of fnSets) {
    for (const fn of fns) for (const r of fn.ranges) {
      const s = lineAt(r.startOffset), e = lineAt(r.endOffset);
      for (let i = s; i <= e; i++) { all.add(i); if (r.count > 0) covered.add(i); }
    }
  }
  // count=0 范围压覆盖行：逐进程内未覆盖优先,跨进程并集补回
  const uncovPerProc = fnSets.map(fns => {
    const u = new Set();
    for (const fn of fns) for (const r of fn.ranges) if (r.count === 0) {
      const s = lineAt(r.startOffset), e = lineAt(r.endOffset);
      for (let i = s; i <= e; i++) u.add(i);
    }
    return u;
  });
  // 行未覆盖 = 所有进程都未覆盖（有一个进程跑到即算到）
  const uncovered = [...all].filter(i => !covered.has(i) || uncovPerProc.every(u => u.has(i)));
  const covCount = all.size - uncovered.length;
  rows.push({ file: basename(fileURLToPath(url)), cov: covCount, all: all.size,
    pct: covCount / all.size * 100, uncovered });
}

rows.sort((a, b) => a.pct - b.pct);
if (!face) {
  // 全面模式（真机档）：全部 dist 文件平铺——真机是全引擎在面,无定性区分
  console.log(`覆盖率报告（${files.length} 进程覆盖文件合并,面=dist/*.js 行级,任一进程触达即算）：`);
  let tc = 0, ta = 0;
  for (const r of rows) { tc += r.cov; ta += r.all; }
  console.log(`  总计: ${tc}/${ta} 行 = ${(tc / ta * 100).toFixed(1)}%`);
  for (const r of rows.slice(0, topN)) {
    console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${r.file}  (${r.cov}/${r.all})`);
  }
  if (rows.length > topN) console.log(`  …其余 ${rows.length - topN} 个文件（按覆盖率升序截断,--top 调整）`);
  process.exit(0);
}

// 面清单模式：分母=target;partial/out 注记归属并打 vitest 实数
const known = new Set([...Object.keys(face.target), ...Object.keys(face.partial), ...Object.keys(face.out)]);
const drift = rows.filter(r => !known.has(r.file));
const tgt = rows.filter(r => face.target[r.file]);
let tc = 0, ta = 0;
for (const r of tgt) { tc += r.cov; ta += r.all; }
console.log(`覆盖率报告（面清单模式,${files.length} 进程合并;分母=target ${tgt.length} 文件——清单 scripts/parser-fuzz-face.json）：`);
console.log(`  fuzz 目标面: ${tc}/${ta} 行 = ${(tc / ta * 100).toFixed(1)}%`);
for (const r of tgt) console.log(`    ${r.pct.toFixed(1).padStart(5)}%  ${r.file}  (${r.cov}/${r.all})  ${face.target[r.file]}`);
console.log('  部分在面（fuzz 数字只算静态半边,面外半边归属见注）:');
for (const r of rows.filter(x => face.partial[x.file])) {
  const vp = vitestPct(r.file);
  console.log(`    ${r.pct.toFixed(1).padStart(5)}%  ${r.file}  — ${face.partial[r.file]}${vp !== null ? `〔vitest 实测 ${vp}%〕` : '〔vitest 数字缺——跑 check:coverage 取数〕'}`);
}
console.log('  面外（被动加载,fuzz 数字无语义——覆盖归属核验如下）:');
for (const r of rows.filter(x => face.out[x.file])) {
  const vp = vitestPct(r.file);
  console.log(`    （fuzz ${r.pct.toFixed(1)}% 不作数）${r.file} — ${face.out[r.file]}${vp !== null ? `〔vitest 实测 ${vp}%〕` : '〔vitest 数字缺——跑 check:coverage 取数〕'}`);
}
if (drift.length > 0) {
  console.error(`\n❌ 加载链出现面清单外新文件（分母漂移——import 链变了,须重定性入清单）: ${drift.map(d => d.file).join(', ')}`);
  process.exit(1);
}
process.exit(0);
