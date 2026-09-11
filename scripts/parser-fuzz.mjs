#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// parser-fuzz 穷举守卫——三不变量机检（design [[spec-parser#^anc-meta-parser-fuzz]]）：
//   ① 删行等价（无静默吞）：删任一非空行 AST+errors 双双不变 = 惰性行,须命中白名单;
//   ② 双语等价：关键词英→中逐 token 替换（独立实现,不复用 parser 别名表——同表核同表=自证）,AST 相等;
//   ③ 往返投影稳定：parse → serializeSpec → parse,语义投影相等（排版豁免,投影字段不豁免）;
//   ④ 全半角变异等价：结构字符位半角→全角逐个替换,报错或结构不变——静默劣化即缺陷;
//   ⑤ 崩溃安全 no-throw：任意变异体 parseSpec 只报错不 throw（throw 即红,不入基线不豁免）。
// 发现分级：白名单外惰性/双语不等价/投影漂移=红;已知未修盲区走基线台账（只许变好,同 anchor-baseline 棘轮）。
// 用法：node scripts/parser-fuzz.mjs [--update-baseline]
// @a: anc-meta-parser-fuzz

import { parseSpec, serializeSpec } from '../dist/parser.js';
import { validateSpec } from '../dist/validator.js';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = process.env.HOPJIT_CHECK_ROOT
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(projectRoot, 'audits', 'baselines', 'parser-fuzz-known.json');
const updateBaseline = process.argv.includes('--update-baseline');

// ── 语料：examples/ 可执行 spec（有 Id + Steps 的 .md）+ 合成种子 ──
function collectCorpus() {
  const corpus = [];
  const scan = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.name.endsWith('.md')) {
        const text = readFileSync(p, 'utf-8');
        // 可执行 spec 判据：Id 行 + Steps 段（对齐 chain-health G1 的 list 语义,不引 CLI 保持独立可跑）
        if (/^(?:Id|标识)\s*:/m.test(text) && /^#{0,6}\s*(?:##\s*(?:Steps|步骤)|Steps\s*:)/m.test(text)) {
          const r = safeParse(text, `corpus:${p}`);
          if (r.ast && (r.ast.steps?.length ?? 0) > 0) corpus.push({ name: relative(projectRoot, p), text });
        }
      }
    }
  };
  scan(join(projectRoot, 'examples'));
  scan(join(projectRoot, 'skills'));   // 分发 skill 的 spec（hopbuild 权威住 skills/,2026-08-15 作者纠偏'这么重要的东西还放在 example'）
  // 合成种子：全中文 spec（双语面）+ 全特性英文 spec（子句/属性/case/call 面）
  corpus.push({
    name: '<seed:zh-full>',
    text: `# Spec: 客户检查
标识: kehu-check
## 目标
逐个检查客户并收集预警
## 输入
- 客户列表: [line]  # 全部客户
## 输出
- 预警名单: [line]  # 收集结果
## 步骤
1. [循环 遍历 客户 于 客户列表, 收集 预警 入 预警名单] 逐个检查
  + → 预警名单: [line]  # 收集端
  1.1. [子任务 重试=2] 检查单个客户
    - ← 客户
    + → 预警: line  # 单项
    1.1.1. [推理] 判断活跃度
      - ← 客户
      + → 预警: line  # 判定
2. [结束] 交付
`,
  });
  corpus.push({
    name: '<seed:en-features>',
    text: `# Spec: feature sweep
Id: feature-sweep
## Goal
exercise clause and attr surfaces
## Inputs
- items: [line]  # in
## Outputs
- results: [line]  # out
- verdict: line  # v
## Steps
1. [loop for-each item in items, collect result into results] per item
  + → results: [line]  # sink
  1.1. [subtask retry=2 parallel] handle one
    - ← item
    + → result: line  # unit
    1.1.1. [reason] judge
      - ← item
      + → result: line  # r
2. [branch] route
  + → verdict: line  # v
  2.1. [case(len(results) > 0)] found
    + → verdict: line  # v
    2.1.1. [reason] summarize
      - ← results
      + → verdict: line  # v
  2.2. [case(else)] nothing
    + → verdict: line  # v
    2.2.1. [reason] empty note
      + → verdict: line  # v
3. [exit] deliver
`,
  });
  // 六探底形态变异种子（2026-08-15 立项探底实证的已知盲区——常驻复现件进基线钉住,
  // 修一格销一格;见 design ^anc-meta-parser-fuzz 语料条 + ^todo-parser-fuzz-triage）
  const probeBase = `# T
Id: probe-mutations
## Goal
g
## Inputs
- xs: [line]  # in
## Outputs
- r: line  # r
## Steps
1. [reason] R
  - ← xs
  + → r: line  # r
`;
  corpus.push({
    name: '<seed:probe-mutations>',
    text: probeBase
      .replace('- xs: [line]  # in', '- xs: [line]  # in\n- 无冒号坏行\nbareword-line')
      .replace('- r: line  # r\n## Steps', '- r: line  # r\n+ → wrong-arrow: line\n## Steps')
      .replace('  + → r: line  # r\n', '  + → r: line  # r\n流浪散文行\n2 [act] 坏编号缺点号\n'),
  });
  return corpus;
}

// ── 不变量⑤：崩溃安全包装——任何 parseSpec 调用一律经此;throw 即记 crash 发现（红,不入基线） ──
const crashes = [];
function safeParse(text, origin) {
  try { return parseSpec(text); }
  catch (err) {
    crashes.push({ invariant: 'no-throw', origin, err: String(err?.message ?? err).slice(0, 100) });
    return { ast: null, errors: [{ kind: 'crash', message: String(err) }] };
  }
}

// ── 归一：剥 source_location 后的稳定序列化 ──
function normalizeAst(ast) {
  return JSON.stringify(ast, (k, v) => (k === 'source_location' ? undefined : v));
}
function normalizeErrors(errors) {
  return JSON.stringify(errors.map(e => `${e.kind}:${e.rule ?? ''}:${e.message}`).sort());
}

// ── 不变量①：删行等价（无静默吞）。惰性行白名单（台账——每条挂设计出处） ──
// - @trace 块内行：%% 包裹的元数据非 spec 内容
// - 围栏标记与围栏内行的删除会改 body → 天然非惰性,无需白名单
// - 非关键字 depth-2 标题及其分区散文：^anc-rule-surface-heading-flavor 设计明文放行（## Task 契约分区=纯人读）
// - 注释/分隔线：markdown 排版件
function classifyLazyLine(lines, idx) {
  const line = lines[idx].trim();
  // @trace 块（%% ... %%）:
  let inTrace = false;
  for (let i = 0; i <= idx; i++) {
    if (lines[i].trim().startsWith('%%')) inTrace = !inTrace;
  }
  if (inTrace || line.startsWith('%%')) return 'trace-block';
  if (/^---+$/.test(line) || /^>\s*$/.test(line)) return 'separator';
  // 纯 # 注释行（非 ## 标题）：概念层明文豁免面——声明区 W1 与 Steps 区孤儿收集都不收注释
  // （^anc-rule-decl-zone-warn"豁免:空行、纯 # 注释行"）,惰性是设计行为非漏网。0016 分诊定案:
  // 白名单挂出处,不升 warn（注释本就是给人读的自由面,call-parent-summarize 顶层散文注释实用形态）
  if (/^#(?!#)/.test(line)) return 'comment';
  // 非关键字 depth-2 分区（## Task 等）及其散文：从行往上找最近 section 标题
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(/^##\s+(.+)$/);
    if (m) {
      const key = m[1].trim().toLowerCase().replace(/\s+/g, '');
      const KNOWN = new Set(['goal', 'constraints', 'types', 'inputs', 'outputs', 'config', 'steps',
        '目标', '约束', '类型', '输入', '输出', '配置', '步骤']);
      if (!KNOWN.has(key)) return 'nonkeyword-section';
      break;
    }
    if (/^#\s/.test(lines[i])) break;
  }
  return null;   // 白名单外
}

function checkDeleteLine(name, text, findings) {
  const base = safeParse(text, `base:${name}`);
  const baseAst = normalizeAst(base.ast);
  const baseErr = normalizeErrors(base.errors);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const mutated = lines.slice(0, i).concat(lines.slice(i + 1)).join('\n');
    const r = safeParse(mutated, `del:${name}:${i + 1}`);
    if (normalizeAst(r.ast) === baseAst && normalizeErrors(r.errors) === baseErr) {
      const cls = classifyLazyLine(lines, i);
      if (cls) findings.whitelisted.push({ spec: name, line: i + 1, class: cls });
      else findings.swallowed.push({ invariant: 'delete-line', spec: name, line: i + 1, text: lines[i].trim().slice(0, 80) });
    }
  }
}

// ── 不变量②：双语等价。替换器独立实现（术语表照抄 design/i18n.md ^anc-i18n-glossary,禁 import parser 表） ──
const ZH = {
  sections: [['## Goal', '## 目标'], ['## Constraints', '## 约束'], ['## Types', '## 类型'],
    ['## Inputs', '## 输入'], ['## Outputs', '## 输出'], ['## Config', '## 配置'], ['## Steps', '## 步骤']],
  idLine: [/^Id(\s*:)/m, '标识$1'],
  stepTypes: [['reason', '推理'], ['act', '探索'], ['check', '检查'], ['confirm', '确认'], ['ask', '询问'],
    ['commit', '提交'], ['call', '调用'], ['branch', '分支'], ['case', '条件'], ['subtask', '子任务'],
    ['loop', '循环'], ['break', '跳出循环'], ['continue', '继续循环'], ['exit', '结束']],
  attrs: [[/retry=/g, '重试='], [/max=/g, '上限='], [/\badaptive\b/g, '自适应'], [/\bfinal\b/g, '终检'],
    [/\bparallel\b/g, '并行'], [/\brequire_human\b/g, '必须真人确认'], [/\bfree\b/g, '开放']],   // free=开放（2026-08-27 三轮review抓:EN→ZH面对free盲——双语等价不变量漏形态）
};
function toZh(text) {
  const lines = text.split('\n');
  let inFence = false;
  const out = lines.map(line => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;   // body 是 hop_python 面,不翻
    let l = line;
    for (const [en, zh] of ZH.sections) if (l.trim() === en) return l.replace(en, zh);
    if (ZH.idLine[0].test(l)) return l.replace(ZH.idLine[0], ZH.idLine[1]);
    // 步骤行：只动方括号机器面（类型位+属性位）,摘要/条件按作者字面不动
    const sm = l.match(/^(\s*\d+(?:\.\d+)*\.\s*\[)([a-z-]+)([^\]]*)(\].*)$/);
    if (sm) {
      let [, pre, type, attrs, rest] = sm;
      const hit = ZH.stepTypes.find(([en]) => en === type);
      if (hit) type = hit[1];
      // case(条件) 内条件不动——else 统配单独换:
      attrs = attrs.replace(/^\(else\)/, '(其他)');
      if (!attrs.startsWith('(')) {
        attrs = attrs.replace(/for-each\s+(\S+)\s+in\s+(\S+)/, '遍历 $1 于 $2')
                     .replace(/collect\s+(\S+)\s+into\s+(\S+)/, '收集 $1 入 $2');
        for (const [re, zh] of ZH.attrs) attrs = attrs.replace(re, zh);
      }
      return pre + type + attrs + rest;
    }
    return l;
  });
  return out.join('\n');
}

function checkBilingual(name, text, findings) {
  const en = safeParse(text, `bi-en:${name}`);
  if (en.errors.length > 0) return;   // 只对合法 spec 核等价（坏 spec 的报错文案按字面回显,双语必不同——非缺陷）
  const zh = safeParse(toZh(text), `bi-zh:${name}`);
  if (normalizeAst(en.ast) !== normalizeAst(zh.ast) || zh.errors.length !== 0) {
    findings.bilingual.push({ invariant: 'bilingual', spec: name,
      detail: zh.errors.length ? `zh 侧 ${zh.errors.length} err: ${zh.errors[0].message.slice(0, 60)}` : 'AST 不等' });
    return;
  }
  // validate 面双语等价（覆盖率测量揭盲:validator 原 0% 在面——AST 恒英文规范形则 validate 结果
  // 理论必等,但保留字闸/名位判定吃的是 AST 里的作者字面,双语面必须实核）。比规则码+severity
  // 多重集（报错文案含作者字面,双语合法地不同——只比规则面）。No-throw 同罩。
  let ev, zv;
  try { ev = validateSpec(en.ast); } catch (err) { crashes.push({ invariant: 'no-throw', origin: `val-en:${name}`, err: String(err?.message ?? err).slice(0, 100) }); return; }
  try { zv = validateSpec(zh.ast); } catch (err) { crashes.push({ invariant: 'no-throw', origin: `val-zh:${name}`, err: String(err?.message ?? err).slice(0, 100) }); return; }
  const ruleSet = (v) => JSON.stringify(v.map(e => `${e.rule}:${e.severity}`).sort());
  if (ruleSet(ev) !== ruleSet(zv)) {
    findings.bilingual.push({ invariant: 'bilingual', spec: name,
      detail: `validate 规则面不等: en=${ruleSet(ev).slice(0, 60)} zh=${ruleSet(zv).slice(0, 60)}` });
  }
}

// ── 不变量③：往返投影稳定。投影=语义字段集（design 条款列举,排版豁免） ──
function project(ast) {
  const step = (s) => ({
    id: s.step_id, type: s.step_type, retry: s.retry, adaptive: s.adaptive, parallel: s.parallel, free: s.free,   // free 入投影（往返丢 free=降级撞 S5,三轮review抓投影盲区）
    condition: s.condition, forEach: s.forEach, collect: s.collect, max: s.max_iterations,
    final: s.is_finally, callee: s.callee_spec_id,
    ins: (s.inputs ?? []).map(i => i.name),
    // fields 必须入投影——就地展开复合输出的子行是语义声明,serializer 丢了即投影违约（判据回归负例当场抓的判据洞）
    outs: (s.outputs ?? []).map(o => `${o.name}:${o.type ?? ''}:${JSON.stringify(o.fields ?? null)}`),
    body: s.act_body?.source ?? null,
    children: (s.children ?? []).map(step),
  });
  return JSON.stringify({
    id: ast.header.id, goal: ast.header.goal,
    inputs: (ast.header.inputs ?? []).map(v => `${v.name}:${v.type}`),
    outputs: (ast.header.outputs ?? []).map(v => `${v.name}:${v.type}`),
    types: (ast.header.types ?? []).map(t => `${t.name}:${JSON.stringify(t.fields)}`),
    steps: (ast.steps ?? []).map(step),
  });
}

function checkRoundtrip(name, text, findings) {
  const r1 = safeParse(text, `rt1:${name}`);
  if (r1.errors.length > 0) return;
  const r2 = safeParse(serializeSpec(r1.ast), `rt2:${name}`);
  if (r2.errors.length > 0 || project(r1.ast) !== project(r2.ast)) {
    findings.roundtrip.push({ invariant: 'roundtrip', spec: name,
      detail: r2.errors.length ? `re-parse ${r2.errors.length} err: ${r2.errors[0].message.slice(0, 60)}` : '投影漂移' });
  }
}

// ── 不变量④：全半角变异等价——结构字符位逐个替换,报错或结构不变;静默劣化即缺陷 ──
const FW = [['(', '（'], [')', '）'], [':', '：'], [',', '，']];
function structuralShape(ast) {
  // 劣化判据形状：步骤数+各步类型+header 声明数（比全 AST 粗——全角替换合法地进入摘要/描述文本时 AST 文本字段会变,只盯结构消失）
  const walk = (ss) => (ss ?? []).flatMap(st => [st.step_type, ...walk(st.children)]);
  return JSON.stringify({
    steps: walk(ast?.steps), id: ast?.header?.id ?? null,
    decls: (ast?.header?.inputs?.length ?? 0) + (ast?.header?.outputs?.length ?? 0) + (ast?.header?.types?.length ?? 0),
  });
}
function checkFullwidth(name, text, findings) {
  const base = safeParse(text, `fw-base:${name}`);
  if (base.errors.length > 0) return;
  const baseShape = structuralShape(base.ast);
  for (const [half, full] of FW) {
    let idx = -1;
    while ((idx = text.indexOf(half, idx + 1)) !== -1) {
      const mutated = text.slice(0, idx) + full + text.slice(idx + half.length);
      const r = safeParse(mutated, `fw:${name}:${idx}`);
      if (r.errors.length === 0 && structuralShape(r.ast) !== baseShape) {
        const line = text.slice(0, idx).split('\n').length;
        // 按形态归组（字符对级指纹）——同一全角字符的劣化是一个根因,台账记形态不记站点
        // （124 站点淹没台账;修一个形态〔如全角冒号响亮报错〕销一组）。首例带定位,计数聚合。
        const key = `${half}→${full}`;
        const g = findings.fullwidth.find(f => f.text === key);
        if (g) { g.sites++; }
        else findings.fullwidth.push({ invariant: 'fullwidth', spec: '<form>', line: 0, text: key,
          sites: 1, first: `${name}:${line}` });
      }
    }
  }
}

// ── 主流程 ──
const corpus = collectCorpus();
// 空转判据打在 examples 扫描面（种子恒在,总数永不为零——glob 空转要单独看,^anc-meta-guard-trust）
if (corpus.filter(c => !c.name.startsWith('<seed:')).length === 0) {
  console.error('parser-fuzz: examples/ 扫描面为空（无可执行 spec）——显式失败不装绿。');
  process.exit(2);
}

const findings = { swallowed: [], bilingual: [], roundtrip: [], fullwidth: [], whitelisted: [] };
for (const { name, text } of corpus) {
  checkDeleteLine(name, text, findings);
  checkBilingual(name, text, findings);
  checkRoundtrip(name, text, findings);
  checkFullwidth(name, text, findings);
}

// 已知未修基线（探底盲区台账——修一格销一格,新增即红）：按 (invariant + 行文本前缀) 指纹
const fingerprint = (f) => `${f.invariant}|${f.spec}|${(f.text ?? f.detail ?? '').slice(0, 60)}`;
const known = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf-8')) : { _note: '', known: [] };
const knownSet = new Set(known.known.map(k => k.fingerprint));
const all = [...findings.swallowed, ...findings.bilingual, ...findings.roundtrip, ...findings.fullwidth];
const fresh = all.filter(f => !knownSet.has(fingerprint(f)));
const cured = [...knownSet].filter(fp => !all.some(f => fingerprint(f) === fp));

const seedCount = corpus.filter(c => c.name.startsWith('<seed:')).length;
console.log(`parser-fuzz：语料 ${corpus.length} 份（examples ${corpus.length - seedCount} + 种子 ${seedCount}）。`);
console.log(`  不变量①删行等价：静默吞 ${findings.swallowed.length}（白名单命中 ${findings.whitelisted.length} 不计）`);
console.log(`  不变量②双语等价：违约 ${findings.bilingual.length}`);
console.log(`  不变量③往返投影：漂移 ${findings.roundtrip.length}`);
console.log(`  不变量④全半角变异：劣化形态 ${findings.fullwidth.length}（站点计数见明细）`);
console.log(`  不变量⑤崩溃安全：throw ${crashes.length}`);
for (const f of all) {
  const mark = knownSet.has(fingerprint(f)) ? '📒 已知' : '🆕 新增';
  const extra = f.sites ? `（${f.sites} 站点,首例 ${f.first}）` : '';
  console.log(`  ${mark} [${f.invariant}] ${f.spec}${f.line ? ':' + f.line : ''} ${f.text ?? f.detail ?? ''}${extra}`);
}
if (cured.length) console.log(`  🎉 基线中 ${cured.length} 条已消失——请人工确认后收缩基线（--update-baseline）。`);

if (updateBaseline) {
  writeFileSync(BASELINE, JSON.stringify({
    _note: 'parser-fuzz 已知未修盲区台账——修一格销一格,新增即红（同 anchor-baseline 棘轮,只许变好）。--update-baseline 重写须人工确认。',
    _measured_at: new Date().toISOString().slice(0, 10),
    known: all.map(f => ({ fingerprint: fingerprint(f), ...f })),
  }, null, 2) + '\n');
  console.log(`基线已重写：${relative(projectRoot, BASELINE)}（${all.length} 条）。`);
  process.exit(0);
}

if (crashes.length > 0) {
  console.error(`\n💥 no-throw 违约 ${crashes.length} 处——parser 对变异输入 throw（不入基线不豁免）:`);
  for (const c of crashes.slice(0, 10)) console.error(`  ${c.origin}: ${c.err}`);
  process.exit(1);
}
if (fresh.length > 0) {
  console.error(`\n❌ 基线外新增 ${fresh.length} 条——parser 新改动引入静默吞/等价破坏，不得入库。`);
  process.exit(1);
}
console.log(cured.length ? '✅ 无新增（且有改善——见上）。' : '✅ 无新增,与基线持平。');
process.exit(0);
