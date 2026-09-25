#!/usr/bin/env node
// 设计文档行长守卫——docs/design/ 散文区单行 >300 字 warn(不拦)。
// 判据来源: todo/0098(作者拍"300字,一行啊!" 2026-09-21);排除面=代码围栏块/表格行(| 开头)。
// warn 档理由: 拆行是纪律不是正确性,红档会把顺手小改逼成大批次;量回涨时升红须重走准入四步。
// @a: anc-meta-line-length-guard
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 300;   // 与 chain-enforcement ^anc-meta-line-length-guard 条款同源
const root = 'docs/design';

function* mdFiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* mdFiles(p);
    else if (e.endsWith('.md')) yield p;
  }
}

let hits = [];
for (const f of mdFiles(root)) {
  const lines = readFileSync(f, 'utf-8').split('\n');
  let inCode = false;
  lines.forEach((l, i) => {
    if (l.trim().startsWith('```')) { inCode = !inCode; return; }
    if (inCode || l.trimStart().startsWith('|')) return;
    if (l.length > LIMIT) hits.push(`${f}:${i + 1} ${l.length} 字`);
  });
}
if (hits.length) {
  console.log(`[check:line-length] warn: ${hits.length} 处散文单行超 ${LIMIT} 字（拆行纪律见 todo/0098 口径——主句留原行,长括注拆缩进子条）:`);
  for (const h of hits.slice(0, 20)) console.log('  ' + h);
  if (hits.length > 20) console.log(`  ...共 ${hits.length} 处`);
} else {
  console.log(`Line length check passed.（docs/design 散文区无 >${LIMIT} 字单行）`);
}
process.exit(0);   // warn 档恒 0——升红须重走准入四步
