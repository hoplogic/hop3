#!/usr/bin/env node
// @a: anc-meta-module-versioning
// G9 守卫：模块版本-接口互锁（module-principles §4——"改版本必改出口表"的反向机检：
// 改了出口表/命令表/响应类型区块，同文档"模块版本"行必须同 diff 变动）。
// 用法：node scripts/check-version-lock.mjs [<commit-range>]   缺省 HEAD~1..HEAD
// 判据：git diff 中某设计文档的改动行落在接口区（出口表行"| `符号` |"、命令表行、响应类型段）
// 而该文档的"> **模块版本**"行不在改动中 → exit 1 列出文档。
// 语义级判断（该 MINOR 还是 PATCH、是否真属接口兼容性变化）归人——本守卫只拦"接口区动了版本纹丝不动"。
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// HOPJIT_CHECK_ROOT：判据回归测试注入 fixture 仓库根（chain-enforcement §5 硬要求 2——守卫判据自身要有测试）；生产恒缺省
const ROOT = process.env['HOPJIT_CHECK_ROOT'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2] ?? 'HEAD~1..HEAD';
const staged = arg === '--staged';
const range = staged ? '（暂存区 vs HEAD）' : arg;

let diff;
try {
  const diffArgs = staged
    ? ['diff', '--cached', '--unified=0', '--', 'docs/design/*.md']
    : ['diff', '--unified=0', arg, '--', 'docs/design/*.md'];
  diff = execFileSync('git', diffArgs, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
} catch (e) {
  console.error(`git diff 失败（range=${range}）：${e.message?.slice(0, 200)}`);
  process.exit(2);
}

const perFile = new Map();
let cur = null;
for (const line of diff.split('\n')) {
  const mf = line.match(/^\+\+\+ b\/(docs\/design\/[\w./-]+\.md)$/);
  if (mf) { cur = { iface: false, version: false }; perFile.set(mf[1], cur); continue; }
  if (!cur) continue;
  if (!line.startsWith('+') && !line.startsWith('-')) continue;
  const body = line.slice(1);
  // 接口区特征：出口表数据行（| `Symbol` | 种类…）、命令表行（| `hopjit …`）、响应类型契约行（**输出 XxxResponse** / interface Xxx）
  if (/^\|\s*`[A-Za-z_][\w.]*`\s*\|/.test(body) || /^\|\s*`hopjit /.test(body) || /\*\*输出 \w+Response\*\*/.test(body) || /^(export )?interface \w+/.test(body)) cur.iface = true;
  if (/\*\*模块版本\*\*/.test(body)) cur.version = true;
}

const offenders = [...perFile.entries()].filter(([, v]) => v.iface && !v.version).map(([f]) => f);
if (offenders.length) {
  console.error(`❌ 接口区变动但模块版本未动（module-principles §4 互锁，range=${range}）：`);
  for (const f of offenders) console.error(`   ${f} —— 出口表/命令表/响应类型有 diff，"> **模块版本**"行无 diff。升版本（演进记录归 git log）或说明为何非接口变化。`);
  process.exit(1);
}
console.log(`Version-lock check passed.（range=${range}，${perFile.size} 份设计文档 diff 无互锁违规）`);
