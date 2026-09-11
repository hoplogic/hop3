// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: act-body ^anc-struct-act-body
// act body 内置函数白名单：纯函数、无副作用、确定性。
// 设计见 design/spec-parser.md ^anc-rule-b2；概念 ^anc-step-act-body-lang「能力边界=白名单」。
// 刻意排除 IO/随机/时间/网络——这些走 ToolProvider 工具（受沙箱约束）。
// @a: anc-rule-b2

import { dump as yamlDump } from 'js-yaml';

/** 内置函数条目：名字 + arity 上下界 + 实现体（parser B2 校验与 interpreter 执行共用）。 */
export interface BuiltinFn {
  name: string;
  arity: { min: number; max: number };
  fn: (args: unknown[]) => unknown;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) throw new Error(`期望数字，实际: ${JSON.stringify(v)}`);
  return n;
}
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  // 结构值（yaml 型变量等）序列化为 YAML 文本——概念 ^anc-type-yaml-structured 文本化条款
  //（String(obj) 产 "[object Object]" 是丢数据,三十六审探针实抓）。// @a: anc-type-yaml-structured
  if (v !== null && typeof v === 'object') return yamlDump(v).trimEnd();
  return String(v);
}
function elemTruthy(x: unknown): boolean {
  if (x === null || x === undefined || x === false || x === '' || x === 0) return false;
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === 'object') return Object.keys(x as object).length > 0;
  return true;
}
function arr(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  throw new Error(`期望数组，实际: ${JSON.stringify(v)}`);
}

const BUILTINS: BuiltinFn[] = [
  // 数值
  { name: 'len', arity: { min: 1, max: 1 }, fn: (a) => {
      const v = a[0];
      if (Array.isArray(v)) return v.length;
      if (typeof v === 'string') return v.length;
      if (v && typeof v === 'object') return Object.keys(v).length;
      throw new Error('len 期望数组/字符串/对象');
    } },
  // 单数组参数形态与 sum(list) 对齐（v0.2.1）：max(list) ≡ max(...list)。变参形态不变。
  { name: 'min', arity: { min: 1, max: Infinity }, fn: (a) => { const xs = a.length === 1 && Array.isArray(a[0]) ? a[0] : a; if (xs.length === 0) throw new Error('min 空列表'); return Math.min(...xs.map(num)); } },
  { name: 'max', arity: { min: 1, max: Infinity }, fn: (a) => { const xs = a.length === 1 && Array.isArray(a[0]) ? a[0] : a; if (xs.length === 0) throw new Error('max 空列表'); return Math.max(...xs.map(num)); } },
  { name: 'round', arity: { min: 1, max: 2 }, fn: (a) => {
      const n = num(a[0]); const d = a.length > 1 ? num(a[1]) : 0;
      const f = Math.pow(10, d); return Math.round(n * f) / f;
    } },
  { name: 'abs', arity: { min: 1, max: 1 }, fn: (a) => Math.abs(num(a[0])) },
  { name: 'sum', arity: { min: 1, max: 1 }, fn: (a) => arr(a[0]).reduce((s: number, x) => s + num(x), 0) },
  // 字符串（与 Python str 方法同名同义——2026-08-10 作者定 Python 对齐：代码面向 agent/程序员）
  { name: 'lower', arity: { min: 1, max: 1 }, fn: (a) => str(a[0]).toLowerCase() },
  { name: 'upper', arity: { min: 1, max: 1 }, fn: (a) => str(a[0]).toUpperCase() },
  { name: 'strip', arity: { min: 1, max: 1 }, fn: (a) => str(a[0]).trim() },
  { name: 'split', arity: { min: 2, max: 2 }, fn: (a) => str(a[0]).split(str(a[1])) },
  { name: 'join', arity: { min: 2, max: 2 }, fn: (a) => arr(a[0]).map(str).join(str(a[1])) },
  { name: 'replace', arity: { min: 3, max: 3 }, fn: (a) => str(a[0]).split(str(a[1])).join(str(a[2])) },
  // 结构
  { name: 'count', arity: { min: 1, max: 1 }, fn: (a) => arr(a[0]).length },
  { name: 'keys', arity: { min: 1, max: 1 }, fn: (a) => {
      const v = a[0]; if (v && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v);
      throw new Error('keys 期望对象');
    } },
  { name: 'values', arity: { min: 1, max: 1 }, fn: (a) => {
      const v = a[0]; if (v && typeof v === 'object' && !Array.isArray(v)) return Object.values(v);
      throw new Error('values 期望对象');
    } },
  { name: 'get', arity: { min: 2, max: 3 }, fn: (a) => {
      const obj = a[0]; const key = str(a[1]); const def = a.length > 2 ? a[2] : null;
      if (obj && typeof obj === 'object' && key in obj) return (obj as Record<string, unknown>)[key];
      return def;
    } },
  // 类型转换（与 Python 内置同名：int/float/str/bool）
  { name: 'int', arity: { min: 1, max: 1 }, fn: (a) => Math.trunc(num(a[0])) },
  { name: 'float', arity: { min: 1, max: 1 }, fn: (a) => num(a[0]) },
  { name: 'str', arity: { min: 1, max: 1 }, fn: (a) => str(a[0]) },
  { name: 'bool', arity: { min: 1, max: 1 }, fn: (a) => {
      const v = a[0];
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') return /^(true|yes|1)$/i.test(v.trim());
      return elemTruthy(v);   // Python bool():空结构 False（2026-08-20 真值对齐同批——Boolean([]) 是 JS 语义）
    } },
  // 序列/文本补齐（Python 对齐 2026-08-10 A 档）
  { name: 'sorted', arity: { min: 1, max: 1 }, fn: (a) => {
      const xs = [...arr(a[0])];
      const allNum = xs.every(x => typeof x === 'number' || (typeof x === 'string' && !Number.isNaN(Number(x))));
      return allNum ? xs.sort((x, y) => Number(x) - Number(y)) : xs.sort((x, y) => str(x) < str(y) ? -1 : str(x) > str(y) ? 1 : 0);
    } },
  // reversed 双收列表与字符串（字符串返翻转后字符串——切片 step 报错与文档指的"反转正路"对两类序列
  // 都成立;2026-09-05 review 抓:原只收数组,写 s[::-1] 的人按指路改写 reversed(s) 会再撞计算异常,
  // 与切片契约"字符串与列表同语义"冲突。^anc-step-act-body-slice） // @a: anc-step-act-body-slice
  { name: 'reversed', arity: { min: 1, max: 1 }, fn: (a) => typeof a[0] === 'string' ? [...(a[0] as string)].reverse().join('') : [...arr(a[0])].reverse() },
  { name: 'range', arity: { min: 1, max: 3 }, fn: (a) => {
      const start = a.length > 1 ? num(a[0]) : 0;
      const stop = a.length > 1 ? num(a[1]) : num(a[0]);
      const step = a.length > 2 ? num(a[2]) : 1;
      if (step === 0) throw new Error('range step 不可为 0');
      const out: number[] = [];
      if (step > 0) for (let v = start; v < stop; v += step) out.push(v);
      else for (let v = start; v > stop; v += step) out.push(v);
      if (out.length > 100_000) throw new Error('range 结果超 100000 项');
      return out;
    } },
  // any/all 元素真值与 isTruthy 同一口径（Python 对齐含空结构为假——2026-08-20 随真值改判同批,原内联旧口径空列表元素算真）
  // @a: anc-exec-none-propagation
  { name: 'any', arity: { min: 1, max: 1 }, fn: (a) => arr(a[0]).some(elemTruthy) },
  { name: 'all', arity: { min: 1, max: 1 }, fn: (a) => arr(a[0]).every(elemTruthy) },
  { name: 'startswith', arity: { min: 2, max: 2 }, fn: (a) => str(a[0]).startsWith(str(a[1])) },
  { name: 'endswith', arity: { min: 2, max: 2 }, fn: (a) => str(a[0]).endsWith(str(a[1])) },
  // strip_fence(text, key?)：机械剥 LLM 文本值外层围栏壳与自标记键前缀——消费侧防线,
  // 不依赖产出侧自律（buildtest 实录:机械可剥的壳反复烧 LLM 重跑轮）。纯文本零 parse
  //（recoverFencedValue 是结构档——文本片段 parse 成 YAML 即碎,两者分工）。
  // 判据从紧:整值单围栏包裹才剥;key 给出且剥后首行逐字 `key:`/`key: |` 才剥前缀。
  // 见 [[act-body#^anc-exec-strip-fence]]。// @a: anc-exec-strip-fence
  { name: 'strip_fence', arity: { min: 1, max: 2 }, fn: (a) => {
      const v = a[0];
      if (typeof v !== 'string') return v;
      let s2 = v.trim();
      const fence = s2.match(/^```[\w-]*\s*\n([\s\S]*?)\n?\s*```$/);
      if (!fence) return v;   // 非单围栏包裹不碰（正文内嵌围栏/无壳原样）
      s2 = fence[1];
      const key = a[1] === undefined ? undefined : str(a[1]);
      if (key) {
        const lines = s2.split('\n');
        const first = lines[0].trim();
        if (first === `${key}:` || first === `${key}: |` || first === `${key}: |-`) {
          const rest = lines.slice(1);
          // 剥键行引入的统一前导缩进（取剩余非空行的最小缩进）
          const indents = rest.filter(l => l.trim()).map(l => l.match(/^\s*/)![0].length);
          const cut = indents.length ? Math.min(...indents) : 0;
          s2 = rest.map(l => l.slice(cut)).join('\n');
        }
      }
      return s2;
    } },
  // parse_json(text)：JSON 文本→结构值——内置工具族（validate_spec/树编辑四件）返回
  // json 字符串,body 取字段的机械解码半边（缺它=机械编排被迫升 LLM 步,test11 实撞
  // 推理独白进产物）。解析失败抛计算异常折本步 fail（响亮,与引用未定义变量同族）。
  // 幂等容错（2026-09-05 作者定"parse_json 应该需要有容错能力",0075 批）：入参已是
  // 结构值（对象/数组）/数字/布尔/null → 原样返回——上游通道把文本提前解析成对象时
  // body 不因二次解析炸。undefined 照旧抛（不是 JSON 值域成员——引用未定义变量的信号
  // 不许静默吞）。见 [[act-body#^anc-exec-parse-json]]。// @a: anc-exec-parse-json
  { name: 'parse_json', arity: { min: 1, max: 1 }, fn: (a) => {
      const v = a[0];
      if (typeof v !== 'string') {
        if (v === undefined) throw new Error('parse_json 期望 JSON 文本,实际: undefined');
        return v;   // 对象/数组/数字/布尔/null——已是结构值,幂等原样返回
      }
      try { return JSON.parse(v); } catch (e) {
        throw new Error(`parse_json 解析失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    } },
  // 判空无专用函数：None 检测用 x == None，空集合检测用裸真值/len(x) == 0（Python 惯用形）
  // 成员测试无 contains 函数：用 in / not in 运算符（Python 惯用形，2026-08-10 文法升格）
  // 实例上下文函数（白名单占位——真实现由 BodyInterpreter 按实例注入，见 act-body-interpreter）
  { name: 'work_zone_path', arity: { min: 0, max: 1 }, fn: () => {
      throw new Error('work_zone_path 需要实例上下文——仅 act/commit body 内可用（case 条件不涉路径）');
    } },
  // time 实例上下文内置（now/today）：白名单占位——真实现需 journal 记值保重放，
  // 在 BodyInterpreter 专路（design/act-body.md）。条件路径拒调。// @a: anc-exec-time-builtins
  { name: 'now', arity: { min: 0, max: 0 }, fn: () => {
      throw new Error('now 需要实例上下文——仅 act/commit body 内可用（条件反复求值,时间不稳定）');
    } },
  { name: 'today', arity: { min: 0, max: 0 }, fn: () => {
      throw new Error('today 需要实例上下文——仅 act/commit body 内可用（条件反复求值,时间不稳定）');
    } },
  // subprocess.run 命令行白名单调用（^anc-exec-subprocess-run,2026-08-29）：白名单占位——
  // 真实现在 BodyInterpreter 专路（spawnSync+cmdJournal 重放+sandbox.runtime.available 白名单）。
  // 条件路径拒调（非纯——外部进程有副作用）。// @a: anc-exec-subprocess-run
  { name: 'subprocess.run', arity: { min: 1, max: 4 }, fn: () => {
      throw new Error('subprocess.run 需要实例上下文——仅 act/commit body 内可用（外部命令非纯,条件里禁调）');
    } },
];

/** hop_python 内置函数白名单：函数名 → 实现（含 arity），parser 校验 B2 与 interpreter 执行共用。见 [[act-body#^anc-exec-act-body-interp]] */
export const ACT_BUILTINS: ReadonlyMap<string, BuiltinFn> = new Map(BUILTINS.map(b => [b.name, b]));
/** 内置函数名集合，供 validator/parser 快速查白名单成员。见 [[act-body#^anc-exec-act-body-interp]] */
export const ACT_BUILTIN_NAMES: ReadonlySet<string> = new Set(BUILTINS.map(b => b.name));
