// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: act-body ^anc-struct-act-body
// 内置函数表四消费位同源钉（设计权威 [[act-body#^anc-exec-builtins-doc-sync]]；
// 先例=tools.test.ts 的 ENGINE_BUILTIN_SPECIAL_TOOL_NAMES 同源钉）。
// 病灶：ACT_BUILTINS 扩员后文档面漏抄——0067 实撞:any/all 入引擎,concepts 快照与教程恒漏,
// 三个函数（any/all、strip_fence、parse_json）三次同形漂移。本钉把"新增内置函数四位必改"
// 从纪律变成机检：从 src/act-builtins.ts 源文本正则提取名单（黑盒读文本,不 import 构建产物——
// 名单在 .ts 源里,audit-scripts.test.ts 同款黑盒形态）,对四个文档逐员断言"全文含反引号包裹
// 的函数名"。判据故意从宽到全文级——各文件行文形态不同（表内/专节标题/调用示例带参数形如
// `work_zone_path(rel?)`）,精确匹配某行会被正当行文调整误伤；从宽守"该文档有记载",记载质量
// 归语义审计。subprocess.run 特例：它常以裸名出现在围栏代码块内（反引号包裹不稳定）,判据
// 放宽为"全文含 subprocess.run 字样"。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');

/** 引擎真表：从 act-builtins.ts 源文本提取 BUILTINS 成员名（单一事实源）。 */
function extractBuiltinNames(): string[] {
  const src = readFileSync(join(REPO, 'src', 'act-builtins.ts'), 'utf-8');
  const names: string[] = [];
  for (const m of src.matchAll(/\{ name: '([^']+)'/g)) names.push(m[1]);
  return names;
}

/** 四个固定文档消费位（设计条款 ^anc-exec-builtins-doc-sync 的编号 1-4）。 */
const DOC_FACES: ReadonlyArray<{ label: string; relPath: string }> = [
  { label: '核心规范', relPath: 'docs/concepts/HopSpec V3核心规范.md' },
  { label: '语法参考', relPath: 'docs/concepts/HopSpec V3语法参考.md' },
  { label: 'D10教程', relPath: 'docs/tutorials/D10-hop_python计算体.md' },
  { label: 'split-patterns', relPath: 'skills/hopbuild2/split-patterns.md' },
];

/** 单员在场判据（从宽,防形态误伤）：
 *  - 一般员：全文存在反引号包裹、以函数名起头且名字边界干净的片段——
 *    `count`、`count(xs)`、`work_zone_path(rel?)` 都算在场；`strip` 不会被 `strip_fence`
 *    误判在场（名字后必须是非标识符字符）。
 *  - subprocess.run：裸名在场即可（围栏代码块内反引号包裹不稳定）。 */
function memberPresent(docText: string, name: string): boolean {
  if (name === 'subprocess.run') return docText.includes('subprocess.run');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('`' + escaped + '(?![A-Za-z0-9_])[^`]*`');
  return re.test(docText);
}

// @v: anc-exec-builtins-doc-sync —— 内置函数名单与文档四消费位同源（名单唯一事实源=
// src/act-builtins.ts,四文档面是誊抄消费位——扩员漏改任一面即红点名文件与函数）
describe('ACT_BUILTINS 与文档四消费位同源（^anc-exec-builtins-doc-sync）', () => {
  const names = extractBuiltinNames();

  it('前提自检：名单提取非空且含已知成员（正则失配时响亮,不静默空跑装绿）', () => {
    expect(names.length).toBeGreaterThanOrEqual(30);
    for (const known of ['len', 'any', 'strip_fence', 'parse_json', 'work_zone_path', 'subprocess.run']) {
      expect(names, `名单提取应含 ${known}`).toContain(known);
    }
  });

  for (const face of DOC_FACES) {
    it(`正例：${face.label}（${face.relPath}）逐员记载齐全——缺员即红点名`, () => {
      const docText = readFileSync(join(REPO, face.relPath), 'utf-8');
      const missing = names.filter(n => !memberPresent(docText, n));
      expect(missing, `${face.relPath} 缺内置函数记载: ${missing.join(', ')}——新增内置函数须四位同改（docs/design/act-body.md ^anc-exec-builtins-doc-sync）`).toEqual([]);
    });
  }

  it('反例：判据自身能抓缺员——去掉某员记载的文本必被点名（防判据退化恒绿）', () => {
    const doc = '白名单：`len` `sum` `count(xs)` 与 `parse_json(text)`，另有 subprocess.run。';
    expect(memberPresent(doc, 'len')).toBe(true);
    expect(memberPresent(doc, 'count')).toBe(true);          // 带参数形态在场
    expect(memberPresent(doc, 'parse_json')).toBe(true);
    expect(memberPresent(doc, 'subprocess.run')).toBe(true); // 裸名特例
    expect(memberPresent(doc, 'any')).toBe(false);           // 缺员即假
    expect(memberPresent(doc, 'strip')).toBe(false);         // 名字边界:不被 strip_fence/其他词吞并
    expect(memberPresent('这里只有裸文本 len 没有反引号', 'len')).toBe(false); // 反引号形态是判据的一部分
  });
});
