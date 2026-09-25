#!/usr/bin/env node
// @a: anc-meta-threshold-sync
// 守卫：prompt 供给体量阈值代码-设计同源（todo/0060——四组阈值"设计写死数字+代码写死常量"
// 双写形态,改常量不改文档不会红,文档说谎无声。本脚本按映射表逐条比对两侧数值,不一致红）。
// 映射表设计（误报防治）：不 grep 裸数值——每条钉具体文件 + 含语境词的正则（捕获组=数值），
// 同一数值在文档他处出现不会误配；任一侧配不到也红（条款被改写没跟上、常量被改名，同属失同源）。
// 新增阈值 → 本表加一行 + chain-enforcement §8 登记（^anc-meta-guard-admission 准入四步）。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// HOPJIT_CHECK_ROOT：判据回归测试注入 fixture 仓库根；生产恒缺省
const ROOT = process.env['HOPJIT_CHECK_ROOT'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');

// 映射表：name / 代码侧(文件+捕获正则) / 设计侧(文件+捕获正则)。
// 设计侧 pattern 按文档实际措辞钉（校准记录见 todo/0060 修复批）；文档措辞重写时同步改此表。
const MAP = [
  {
    name: 'EMPTY_RETRY_MAX（EMPTY_OUTPUT 步级重发上限,0072-review 批补登记）',
    code: { file: 'src/dispatcher.ts', re: /const EMPTY_RETRY_MAX = (\d+)/ },
    design: { file: 'docs/design/step-dispatcher.md', re: /至多 EMPTY_RETRY_MAX=(\d+) 次/ },
  },
  {
    name: 'SCHEMA_RETRY_MAX（算子级 schema 重试上限,存量欠账随 0072-review 批同补）',
    code: { file: 'src/dispatcher.ts', re: /const SCHEMA_RETRY_MAX = (\d+)/ },
    design: { file: 'docs/design/step-dispatcher.md', re: /SCHEMA_RETRY_MAX=(\d+)/ },
  },
  {
    name: 'RETRY_BASE_INLINE_CHARS（L5 打回轮基准 inline 小档）',
    code: { file: 'src/prompt.ts', re: /const RETRY_BASE_INLINE_CHARS = (\d+)/ },
    design: { file: 'docs/design/prompt-assembler.md', re: /体量分档 (\d+) chars inline/ },
  },
  {
    name: '历史行单条 clip（L6 修正指令累计史/上游反馈同款）',
    code: { file: 'src/engine.ts', re: /clip\(p, (\d+)\)/ },
    design: { file: 'docs/design/prompt-assembler.md', re: /历史行单条 \d+\/\d+→\*\*(\d+)\*\*/ },
  },
  {
    name: 'UPSTREAM_FEEDBACK_GUARD_CHARS（L6 上游反馈累积保护线）',
    code: { file: 'src/prompt.ts', re: /const UPSTREAM_FEEDBACK_GUARD_CHARS = (\d+)/ },
    design: { file: 'docs/design/prompt-assembler.md', re: /保护线→\*\*(\d+) chars\*\*/ },
  },
  {
    name: 'DEFLATE_THRESHOLD（agent 通道单值卸载阈）',
    code: { file: 'src/ast-helpers.ts', re: /export const DEFLATE_THRESHOLD = (\d+)/ },
    design: { file: 'docs/design/shared-types.md', re: /`DEFLATE_THRESHOLD = (\d+)`/ },
  },
  // 教材面同源（2026-09-04 review 面三实锤:driver 教条'4096'与常量无守卫,改 8192 全部机检
  // 无一响——教材教错 caller 就错;两载体各钉一行,与上一行同一常量三方同源）。// @a: anc-meta-threshold-sync
  {
    name: 'DEFLATE_THRESHOLD（CC driver $file 教条教材面）',
    code: { file: 'src/ast-helpers.ts', re: /export const DEFLATE_THRESHOLD = (\d+)/ },
    design: { file: 'driver/references/step-execution-rules.md', re: /序列化后超 (\d+) 字符/ },
  },
  {
    name: 'DEFLATE_THRESHOLD（Codex driver $file 教条教材面）',
    code: { file: 'src/ast-helpers.ts', re: /export const DEFLATE_THRESHOLD = (\d+)/ },
    design: { file: 'driver/codex/references/execution-rules.md', re: /序列化后超 (\d+) 字符/ },
  },
  {
    name: 'HUMAN_PREVIEW_THRESHOLD（人通道预览阈）',
    code: { file: 'src/ast-helpers.ts', re: /export const HUMAN_PREVIEW_THRESHOLD = (\d+)/ },
    design: { file: 'docs/design/shared-types.md', re: /`HUMAN_PREVIEW_THRESHOLD = (\d+)`/ },
  },
  {
    name: 'INLINE_PREVIEW_MAX（standalone 内联预览上限）',
    code: { file: 'src/ast-helpers.ts', re: /export const INLINE_PREVIEW_MAX = (\d+)/ },
    design: { file: 'docs/design/shared-types.md', re: /INLINE_PREVIEW_MAX（(\d+) chars）/ },
  },
  {
    name: 'line-length（设计文档散文区单行行长线,todo/0098——联审修复批补登记）',
    code: { file: 'scripts/check-line-length.mjs', re: /const LIMIT = (\d+)/ },
    design: { file: 'docs/design/chain-enforcement.md', re: /作者拍 (\d+) 字线/ },
  },
];

function extract(side, entry) {
  const p = join(ROOT, side.file);
  let text;
  try {
    text = readFileSync(p, 'utf-8');
  } catch {
    return { err: `文件读不到: ${side.file}` };
  }
  const m = text.match(side.re);
  if (!m) return { err: `pattern 配不到（条款被改写/常量被改名? 同步更新 check-threshold-sync.mjs 映射表）: ${side.re} @ ${side.file}` };
  return { val: m[1] };
}

const problems = [];
for (const entry of MAP) {
  const c = extract(entry.code, entry);
  const d = extract(entry.design, entry);
  if (c.err) { problems.push(`${entry.name}: 代码侧 ${c.err}`); continue; }
  if (d.err) { problems.push(`${entry.name}: 设计侧 ${d.err}`); continue; }
  if (c.val !== d.val) {
    problems.push(`${entry.name}: 代码=${c.val}（${entry.code.file}） ≠ 设计=${d.val}（${entry.design.file}）——改了哪侧就同步另一侧`);
  }
}

if (problems.length) {
  console.error('❌ 阈值代码-设计失同源（todo/0060 守卫）：');
  for (const p of problems) console.error(`   ${p}`);
  process.exit(1);
}
console.log(`Threshold sync check passed.（${MAP.length} 组阈值代码-设计同源）`);
