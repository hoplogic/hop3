#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// i18n 译本滞后报告（design [[i18n#^anc-i18n-translation-discipline]] 第 3 条）。
// 判据复用 last_sync 守卫（^anc-driver-lint-last-sync 同款,日粒度）：译本 @trace 的
// last_sync vs 其中文源文件的 git 最后改动日期——源比译本新即滞后。
// 初期降档为报告不拦（exit 恒 0）;译本量上来后再议升红（升红须走守卫准入四步）。
// 源解析：译本 @trace 的 source: [[wiki-link]] 相对译本所在目录解析;.md 后缀可省。
// git 不可用→显式说明不装绿（^anc-meta-guard-trust）。
// @a: anc-i18n-translation-discipline

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = process.env.HOPJIT_CHECK_ROOT
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const i18nRoot = join(projectRoot, 'docs', 'i18n');

if (!existsSync(i18nRoot)) {
  console.log('i18n 滞后报告：docs/i18n/ 不存在,无译本可查。');
  process.exit(0);
}

const files = [];
const collect = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p);
    else if (e.name.endsWith('.md')) files.push(p);
  }
};
collect(i18nRoot);

let gitOk = true;
try { execSync('git rev-parse --git-dir', { cwd: projectRoot, stdio: 'pipe' }); }
catch { gitOk = false; }
if (!gitOk) {
  console.log('⏭  i18n 滞后报告跳过（git 不可用）,不装绿。');
  process.exit(0);
}

const stale = [];
const problems = [];
let fresh = 0;

for (const f of files) {
  const rel = relative(projectRoot, f);
  const content = readFileSync(f, 'utf-8');
  const traceM = /%%\s*@trace[\s\S]*?%%/.exec(content);
  if (!traceM || !/type:\s*translation/.test(traceM[0])) {
    problems.push(`${rel}: 缺 @trace type: translation 头（翻译三纪律第 1 条——翻译即派生,无 @trace 的译本不可追溯）`);
    continue;
  }
  const syncM = /last_sync:\s*(\d{4}-\d{2}-\d{2})/.exec(traceM[0]);
  if (!syncM) { problems.push(`${rel}: @trace 缺 last_sync`); continue; }
  const srcM = /source:\s*\[\[([^\]]+)\]\]/.exec(traceM[0]);
  if (!srcM) { problems.push(`${rel}: @trace 缺 source 链接`); continue; }

  let srcPath = resolve(dirname(f), srcM[1]);
  if (!existsSync(srcPath) && existsSync(srcPath + '.md')) srcPath += '.md';
  if (!existsSync(srcPath)) {
    problems.push(`${rel}: source [[${srcM[1]}]] 解析不到文件（死链）`);
    continue;
  }
  const srcRel = relative(projectRoot, srcPath);
  let srcDate = '';
  try {
    srcDate = execSync(`git log -1 --format=%ad --date=short -- "${srcRel}"`,
      { cwd: projectRoot, encoding: 'utf-8' }).trim();
  } catch { /* 源无 git 史按未滞后处理 */ }
  if (srcDate && srcDate > syncM[1]) {
    stale.push(`${rel}: 源 ${srcRel} 改于 ${srcDate} > last_sync ${syncM[1]}——源演进后须重刷译本`);
  } else {
    fresh++;
  }

  // 链接规则"不留死链"机检（design ^anc-i18n-docs-tree 链接规则——译本互链指译本兄弟/
  // 未翻译文档指回中文原文,两式都必须在盘。markdown 与 wiki 双式全核）。
  // 代码位不是链接面：围栏块与行内反引号内的 [[...]]/](...) 是示意字面非真链接
  // （实撞:D1 教程 \`[[双链]]\` 示意 token 译作 \`[[wiki-links]]\` 被误报死链）。
  const body = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const targets = [
    ...[...body.matchAll(/\]\(([^)#\s]+?\.md)/g)].map(m2 => m2[1]),
    ...[...body.matchAll(/\[\[([^\]|#]+?)\]\]/g)].map(m2 => m2[1] + '.md'),
  ];
  for (const t of targets) {
    if (t.startsWith('http')) continue;
    const full = resolve(dirname(f), t);
    if (!existsSync(full)) problems.push(`${rel}: 死链 ${t}`);
  }
}

console.log(`i18n 滞后报告：译本 ${files.length} 份,新鲜 ${fresh},滞后 ${stale.length},结构问题 ${problems.length}。`);
for (const s of stale) console.log(`  ⏳ ${s}`);
for (const p of problems) console.log(`  ⚠️  ${p}`);
if (stale.length + problems.length === 0 && files.length > 0) console.log('  全部新鲜。');
// 报告不拦（设计降档条款）——升红须走守卫准入四步
process.exit(0);
