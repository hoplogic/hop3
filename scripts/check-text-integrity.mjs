#!/usr/bin/env node
// @a: anc-meta-guard-text-integrity
// 文本完整性机检：src/tests/driver/docs/scripts/examples 的文本文件禁含 NUL 等控制字节。
//
// 为什么需要（2026-08-13 实撞）：shell 写入把字面 NUL 字节带进 src/parser.ts——tsc 照常编译、
// 测试照常绿，但 grep 判文件为二进制后所有基于 grep 的工具链（人工排查/守卫脚本/审计扫描）
// 对该文件集体失明：`grep -c` 返回 0、`grep -n` 报 "Binary file matches"。工程链 review 时
// 差点把"代码在场"误判成"代码缺失"。文本源文件含 NUL 没有任何合法用途（JS 字符串里应写
//  转义），一律拒。
//
// 用法：node scripts/check-text-integrity.mjs [根目录]（默认包根；HOPJIT_CHECK_ROOT 可覆盖）
// 退出码：0 = 干净；1 = 有违规；2 = 扫描面空转（防假绿）

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.HOPJIT_CHECK_ROOT ?? process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'tests', 'driver', 'docs', 'scripts', 'examples'];
const TEXT_EXTS = new Set(['.ts', '.mjs', '.js', '.md', '.json', '.yaml', '.yml', '.sh']);
// NUL 与除 \t \n \r 外的 C0 控制字节
const BAD_BYTES = new Set([...Array(32).keys()].filter(b => b !== 9 && b !== 10 && b !== 13));

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(join(dir, entry.name), out);
    } else if (TEXT_EXTS.has(extname(entry.name))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const files = SCAN_DIRS.flatMap(d => walk(join(ROOT, d)));
if (files.length === 0) {
  console.error('check-text-integrity: 扫描面空转（0 个文本文件）——目录结构异常，显式失败不假绿');
  process.exit(2);
}

const violations = [];
for (const file of files) {
  const buf = readFileSync(file);
  for (let i = 0; i < buf.length; i++) {
    if (BAD_BYTES.has(buf[i])) {
      violations.push({ file: relative(ROOT, file), offset: i, byte: buf[i] });
      break;   // 每文件报一处即可
    }
  }
}

if (violations.length > 0) {
  console.error('Text integrity check failed（文本文件含控制字节——grep 会判二进制,全工具链对其失明）:');
  for (const v of violations) {
    console.error(`- ${v.file} @byte ${v.offset}: 0x${v.byte.toString(16).padStart(2, '0')}（字符串里应写 \\u00${v.byte.toString(16).padStart(2, '0')} 转义）`);
  }
  process.exit(1);
}
console.log(`Text integrity check passed. (${files.length} files)`);
