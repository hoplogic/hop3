// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: spec-ast ^anc-struct-spec-ast
// Config 引擎消费键与概念层记载面同源钉（设计权威 [[spec-ast#^anc-ast-config-keys-doc-sync]]；
// 先例=builtins-doc-sync.test.ts 的 ACT_BUILTINS 四消费位同源钉）。
// 病灶：Config 扩展键经索引签名消费,加键零编译约束,概念层是否记载纯靠人自觉——
// expansion_max(2026-08-29)/engine_min_version(0093 批)/requires_commands(0090 批)三个键
// 先后落到设计+代码+测试三层而概念层零条款,半个多月无人发现(作者抓"工程链严重脱节")。
// 双向核：①清单→文档(每键在语法参考 Config 记载面在场,缺即红点名);②代码→清单(扫 src
// 索引消费形态 config?.['键'],提取键不在清单即红——新加消费键不登清单+不写概念层过不了机检)。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ENGINE_CONFIG_KEYS } from '../src/ast-types.js';

const REPO = resolve(import.meta.dirname, '..');
const SYNTAX_REF = join(REPO, 'docs', 'concepts', 'HopSpec V3语法参考.md');

/** 代码消费面扫描：src/*.ts 里 Config 对象的索引取键形态。判据锚在两个惯用接收名
 *  （header.config?.['键'] 与 specConfig?.['键']）——这是扩展键消费的唯一通道
 *  （接口具名字段走属性访问有 tsc 管,不需要本钉）。键名限 ASCII 标识符——注释/文档里的
 *  中文示例字样（如「config?.['键']」）不是真键,不入扫描面。 */
function scanConsumedIndexKeys(): string[] {
  const keys = new Set<string>();
  for (const f of readdirSync(join(REPO, 'src'))) {
    if (!f.endsWith('.ts')) continue;
    const src = readFileSync(join(REPO, 'src', f), 'utf-8');
    for (const m of src.matchAll(/(?:config|specConfig)\?\.\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\]/g)) keys.add(m[1]);
  }
  return [...keys];
}

/** 记载在场判据（名字边界,防前缀碰撞）：键名前后都不是标识符字符才算在场——
 *  清单里恰有 model/models 这对前缀碰撞键,裸 includes('model') 会被 models 的记载吞并假绿
 *  （独立阅卷实验:删光 model 记载 includes 仍 true）。从宽面保留:不限定出现位置与包裹形态,
 *  记载质量归语义审计。 */
function keyPresent(docText: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(docText);
}

// @v: anc-ast-config-keys-doc-sync —— Config 引擎消费键清单与概念层记载面同源
//（清单唯一事实源=src/ast-types.ts ENGINE_CONFIG_KEYS;新增消费键漏登清单或漏写概念层即红）
describe('Config 引擎消费键与概念层同源（^anc-ast-config-keys-doc-sync）', () => {
  it('前提自检：清单非空且含已知键（清单被清空/改坏时响亮,不静默空跑装绿）', () => {
    expect(ENGINE_CONFIG_KEYS.length).toBeGreaterThanOrEqual(5);
    for (const known of ['model', 'models', 'expansion_max', 'engine_min_version', 'requires_commands']) {
      expect(ENGINE_CONFIG_KEYS, `清单应含 ${known}`).toContain(known);
    }
  });

  it('正例①清单→文档：每个引擎消费键在概念层语法参考里有记载——缺键即红点名（名字边界判,防 model 被 models 子串吞并假绿——builtins 同源钉先例同哲学）', () => {
    const docText = readFileSync(SYNTAX_REF, 'utf-8');
    const missing = ENGINE_CONFIG_KEYS.filter(k => !keyPresent(docText, k));
    expect(missing, `概念层语法参考缺 Config 键记载: ${missing.join(', ')}——新增引擎消费键须同批写进语法参考 Config 区并回写 vault（docs/design/spec-ast.md ^anc-ast-config-keys-doc-sync）`).toEqual([]);
  });

  it('正例②代码→清单：src 索引形态消费的 Config 键全部在 ENGINE_CONFIG_KEYS 清单里——漏登即红点名', () => {
    const consumed = scanConsumedIndexKeys();
    expect(consumed.length, '消费面扫描应非空（正则失配时响亮——现存至少 expansion_max/engine_min_version/requires_commands 三键走索引形态,断言取 >=3 下界）').toBeGreaterThanOrEqual(3);
    const unregistered = consumed.filter(k => !(ENGINE_CONFIG_KEYS as readonly string[]).includes(k));
    expect(unregistered, `src 消费了未登记的 Config 键: ${unregistered.join(', ')}——新增引擎消费键须入 ENGINE_CONFIG_KEYS 清单并写概念层（docs/design/spec-ast.md ^anc-ast-config-keys-doc-sync）`).toEqual([]);
  });

  it('反例：扫描判据自身能抓索引消费形态（防正则退化恒空扫）', () => {
    const sample = `const a = ast.header.config?.['brand_new_key']; const b = specConfig?.['models'];`;
    const keys = [...sample.matchAll(/(?:config|specConfig)\?\.\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\]/g)].map(m => m[1]);
    expect(keys).toContain('brand_new_key');
    expect(keys).toContain('models');
  });

  it('反例：记载判据名字边界——model 不被 models 记载吞并,models 不被 model 记载吞并（前缀碰撞双向）', () => {
    expect(keyPresent('这里只记载了 models: 分档路由', 'model')).toBe(false);
    expect(keyPresent('这里只记载了 model: 默认模型', 'models')).toBe(false);
    expect(keyPresent('两个都有 model: 与 models: 记载', 'model')).toBe(true);
    expect(keyPresent('`expansion_max: 20` 反引号包裹也算在场', 'expansion_max')).toBe(true);
  });
});
