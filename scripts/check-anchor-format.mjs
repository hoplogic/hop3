#!/usr/bin/env node
// @a: anc-meta-anchor-space, anc-meta-anchor-unique, anc-meta-anchor-head
// 锚点格式机检两职责：① `^anc-*` 之前必须是半角空格；② 同文件禁重复锚定义（影子契约——
// 0830 review 实锤:设计条款整段重复粘贴,两段各自演化必漂移,audit naming_violation 才报红,
// 本检把它提前到提交前;跨文件同锚不检——卡与设计本就同锚互指）。
//
// 为什么需要：机检正则是 ' \^(anc-...)\s*$'（要求空格，以区分正文里偶然出现的 ^anc- 行内引用）。
// 缺空格 → 锚点不被采集 → 设计层"查无此锚点" → 连锁误判（卡片标 ✅ 却报无设计锚点、
// 覆盖率虚低）。中文标点尤其易犯：`）^anc-x` / `。^anc-x` 视觉上像有分隔，实则不是空格。
// 2026-08-01 全库扫出 9 处，致 15 张 TRACEABILITY 卡片被误判。
// 契约见 design/concept-anchor-rules.md ^anc-meta-anchor-space。
//
// 用法：node scripts/check-anchor-format.mjs [根目录]（默认包根）
// 退出码：0 = 全部合格；1 = 有违规

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', '.anchor-audit', 'coverage',
  '.hopstate', '.hoplog', 'obsolete', 'reviews', 'rounds',
  '.claude',   // 宿主工作区（含并行会话 worktrees/——第三职责收 ts 后首撞:扫进别人 worktree 的历史粘连误红）
]);

/** 行尾锚点，但前一个字符不是空格 → 违规。捕获前字符便于报告。 */
const BAD_ANCHOR_RE = /(\S)\^(anc-[a-z][a-z0-9-]*)\s*$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.hop')) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.name.endsWith('.md')) {
      out.push(join(dir, entry.name));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(join(dir, entry.name));   // 第三职责:@a:/@v: 行首注释形态检(^anc-meta-anchor-head)
    }
  }
  return out;
}

/** 合法锚定义（前空格+行尾）——重复检采集用。TRACEABILITY.md 排除:卡标题行 `### anc-x` 非 ^ 形态本就不撞,但卡内会引用同锚,故只检行尾 ^ 定义形态。 */
const GOOD_ANCHOR_RE = / \^(anc-[a-z][a-z0-9-]*)\s*$/;

// 第三职责（^anc-meta-anchor-head,todo/0057 G-采集——@a:/@v: 句尾粘连形态审计采集正则
// `(?://|#)\s*@a:` 收不到,锚点隐形链上断环;判据:标注出现在注释里但注释符与标注之间夹了
// 正文字符〔非空白〕=粘连。合法形态:`// @a: anc-x` 或 `代码;   // @a: anc-x`）。
const HEAD_OK_RE = /\/\/\s*@(a|v):/;
// 块注释形态同拦（review 面二实抓双盲活体 8 处:` * @a: anc-x */` 星号行 scan 采集正则
// (?://|#) 与本钉行注释判据都收不到——契约收敛书写为行首 // 形态,块注释内不放标注）
const BLOCK_FORM_RE = /^\s*(\/\*|\*)[^/]*@(a|v): *anc-/;
const headViolations = [];

const violations = [];
const dupViolations = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf-8').split('\n');
  const isTs = file.endsWith('.ts');
  const anchorLines = new Map();   // anchor → [行号]
  lines.forEach((line, i) => {
    if (isTs) {
      // ts 文件只做第三职责——找到含 @a:/@v: 的注释,核注释符后是否紧跟标注
      if (/@(a|v): *anc-/.test(line)) {
        if (BLOCK_FORM_RE.test(line)) {
          headViolations.push({ file: relative(ROOT, file), line: i + 1, text: line.trim().slice(0, 80) + '（块注释形态——scan 采集收不到,改行首 // 标注）' });
          return;
        }
        const cIdx = line.indexOf('//');
        if (cIdx >= 0) {
          const comment = line.slice(cIdx);
          if (!HEAD_OK_RE.test(comment)) headViolations.push({ file: relative(ROOT, file), line: i + 1, text: comment.slice(0, 80) });
        }
        // 尾粘检（2026-09-07 两批 review 面四实撞:engine-traverse @a: 锚 id 尾粘全角括号,
        // scan 的格式正则 ^anc-[a-z][a-z0-9-]*$ 判整词不匹配采集为空——收敛后唯一落点隐形,
        // 锚全库代码落点归零而本守卫绿灯。判据:注释段内锚 id 后紧跟的字符必须是空白/行尾/
        // 半角逗号（多锚分隔）/反斜杠（测试数据字符串的 \n 转义,真文件内容不会以 \ 收锚）,其它一律尾粘。只检注释段（cIdx 起）——字符串字面量里的
        // @a: 是测试数据不是标注,scan 同样只采注释,两侧同域。// @a: anc-meta-anchor-head
        if (cIdx >= 0) {
          for (const tm of line.slice(cIdx).matchAll(/@(?:a|v): *(anc-[a-z][a-z0-9-]*)([^\s,\\]?)/g)) {
            if (tm[2]) headViolations.push({ file: relative(ROOT, file), line: i + 1, text: `锚 ${tm[1]} 尾粘字符 '${tm[2]}'——scan 采集为空,链上断环（锚后只许空白/行尾/半角逗号）` });
          }
        }
      }
      return;
    }
    const clean = line.replace(/\r$/, '');
    const m = BAD_ANCHOR_RE.exec(clean);
    if (m) {
      violations.push({
        file: relative(ROOT, file), line: i + 1,
        anchor: m[2], prev: m[1],
      });
    }
    const g = GOOD_ANCHOR_RE.exec(clean);
    if (g) {
      const arr = anchorLines.get(g[1]) ?? [];
      arr.push(i + 1);
      anchorLines.set(g[1], arr);
    }
  });
  for (const [anchor, lns] of anchorLines) {
    if (lns.length >= 2) dupViolations.push({ file: relative(ROOT, file), anchor, lines: lns });
  }
}

if (violations.length === 0 && dupViolations.length === 0 && headViolations.length === 0) {
  console.log('Anchor format check passed.');
  process.exit(0);
}

if (headViolations.length > 0) {
  console.error('Anchor head-form check failed —— @a:/@v: 必须行首注释形态（句尾粘连采集不到,锚点隐形）：');
  for (const v of headViolations) {
    console.error(`- ${v.file}:${v.line}  ${v.text}`);
  }
  console.error('契约见 design/concept-anchor-rules.md ^anc-meta-anchor-head。修法:标注移独立注释或注释起始处。\n');
  if (violations.length === 0 && dupViolations.length === 0) process.exit(1);
}

if (dupViolations.length > 0) {
  console.error('Anchor uniqueness check failed —— 同文件重复锚定义（影子契约）：');
  for (const v of dupViolations) {
    console.error(`- ${v.file}  ^${v.anchor}  出现于行 ${v.lines.join(', ')}——保正身删其余（正身=锚点注册表/引用指向的那段）`);
  }
  console.error('契约见 design/concept-anchor-rules.md ^anc-meta-anchor-unique\n');
  if (violations.length === 0) process.exit(1);   // 只有 dup 违规:此处即终局红
  // 两类都有:继续走下方空格违规报告,最后 exit(1)
}

console.error('Anchor format check failed —— `^anc-*` 之前必须是半角空格：');
for (const v of violations) {
  console.error(`- ${v.file}:${v.line}  ^${v.anchor}  前字符=${JSON.stringify(v.prev)}`);
}
console.error(`\n共 ${violations.length} 处。缺空格的锚点不会被 scan.py 采集，会导致`
  + `"标 ✅ 但无设计锚点"等连锁误判。修法：在标点与 ^anc- 之间插一个半角空格。`);
console.error('契约见 design/concept-anchor-rules.md ^anc-meta-anchor-space');
process.exit(1);
