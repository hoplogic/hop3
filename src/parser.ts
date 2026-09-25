// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: spec-parser ^anc-struct-spec-parser
// Hand-written line-by-line parser for HopSpec v3 markdown.
// Remark was evaluated and rejected (nesting, +→ outputs, blockquotes all break).

import { load as yamlLoad } from 'js-yaml';
import type { SpecAST, SpecHeader, ToolNeed, SpecConfig, TypeDecl, VarDecl, StepNode, StepType, VarBinding, OutputDecl, ParamMapping, SourceLocation, ActBody, ActExpr, SubtaskStep, ParallelStep, LoopStep, CallStep, CommitStep, CaseStep, ExitStep, CheckStep, ConfirmStep, AskStep, ActStep , BreakStep, ContinueStep } from './ast-types.js';
import type { ParseError } from './errors.js';
import { ALL_STEP_TYPES, CONTAINER_STEP_TYPES } from './ast-helpers.js';
import { extractHopPythonFence, parseActBody, serializeActBody, parseExpression } from './act-body-parser.js';
import { extractDocRefs } from './doc-ref.js';

const MAX_INPUT_SIZE = 1024 * 1024;   // 1MB——异常输入防护非业务约束(hopissues/0080:100KB 被真实业务 spec 触顶上调;design spec-parser.md 输入防护条款) // @a: anc-rule-input-guard
const MAX_NESTING_DEPTH = 64;  // 异常输入防护量级,非业务约束（call 链深度 10 层是 max_call_depth 的正交闸——2026-08-17 作者判定修正,hopkb 实撞:合法规约条件密度 10 层轻易触顶）

// ===== Regex patterns =====
const RE_HEADING = /^(#{1,6})\s+(.*\S)/;
const RE_STEP = /^(\d+(?:\.\d+)*)(?:\.\s*|\s+)\[([\w\u4e00-\u9fff]+)(?:\s+([^\]]*))?\]\s*(.*)/;   // 类型位收中文（i18n 双语,归一见 STEP_TYPE_ALIASES）;编号尾点可选——`1.1 [reason]` 缺尾点原被静默丢弃,父容器 S5 报错指错方向（buildtest 实撞,^anc-rule-surface-heading-flavor 尾点条款）// @a: anc-i18n-keyword-impl, anc-rule-step-number-dot-optional
const RE_INPUT = /^-\s*←\s*(.+)/;
const RE_TOOL_GRANT = /^-\s*(?:工具|tools)\s*[:：]\s*(.+)/;   // 节点工具授权条目（0054 ^anc-step-tool-grant——每行恰一名或 *,# 意图注释;全半角冒号同收〔全角是中文输入法第一手滑〕）
const RE_TOOL_DENY = /^-\s*(?:禁工具|deny_tools)\s*[:：]\s*(.+)/;   // 节点工具禁用条目（^anc-step-tool-deny——授权行对称半边,每行恰一名,禁 *;# 原因注释）// @a: anc-step-tool-deny
const RE_OUTPUT = /^\+\s*→\s*(.+)/;
const RE_INSTRUCTION = /^>\s?(.*)/;
const RE_VAR_DECL = /^-\s*([^\s:=]+)\s*:\s*(\S+(?:\([^)]*\))?\]?)\s*(?:#\s*(.*))?$/;   // 名位宽一档收中文（原 \w+ 只认 ASCII,中文名整行被静默吞——^todo-parser-silent-swallow 同因;合法性归 V2b;类型位尾 \]? 收 [enum(a, b)] 列表元素含参形——括号内逗号带空格时 \S+ 停在空格前吞不到闭括号后的 ],整行跌出文法静默消失,^todo-parser-silent-swallow 同族 28 轮 review 抓;三站点同修,类型合法性归 V4/V7）// @a: anc-i18n-keyword-impl, anc-rule-v2b
const RE_LIST_ITEM = /^-\s+(.*)/;
const RE_ID_LINE = /^(?:Id|标识)\s*:\s*(\S+)/;   // Id 中文别名 标识（术语表 ^anc-i18n-glossary）// @a: anc-i18n-keyword-impl
const RE_FENCE = /^```/;

// ===== Section identification =====

type SectionKind = 'title' | 'id' | 'goal' | 'constraints' | 'types' | 'inputs' | 'outputs' | 'tools' | 'config' | 'steps';

interface Section {
  kind: SectionKind;
  startLine: number; // inclusive, 0-based
  endLine: number;   // exclusive, 0-based
}

const SECTION_KEYWORDS: Record<string, SectionKind> = {
  goal: 'goal',
  constraints: 'constraints',
  types: 'types',
  inputs: 'inputs',
  outputs: 'outputs',
  tools: 'tools',
  config: 'config',
  steps: 'steps',
  // 中文段头（i18n 方案 B 直通等价,术语表权威 design/i18n.md ^anc-i18n-glossary）// @a: anc-i18n-keyword-impl
  '目标': 'goal',
  '约束': 'constraints',
  '类型': 'types',
  '输入': 'inputs',
  '输出': 'outputs',
  '工具': 'tools',
  '配置': 'config',
  '步骤': 'steps',
};

// 节点体条目行关键词双语映射（工具授权/禁用行——lang 转换通道消费;禁用半边随
// ^anc-step-tool-deny 扩员 2026-09-05）。// @a: anc-step-tool-deny
const ENTRY_KEY_ZH2EN: Record<string, string> = { '工具': 'tools', '禁工具': 'deny_tools' };
const ENTRY_KEY_EN2ZH: Record<string, string> = Object.fromEntries(Object.entries(ENTRY_KEY_ZH2EN).map(([z, e]) => [e, z]));

// 惯例不供给节名（A 案排除双轨的名单轨——精确等于即排除,标题免带 (不供给) 标记;
// 现只一员:处置记录=任务卡跨载体惯例的追加式流水账。扩员须作者拍板,不是白名单机制
// 回潮——供给面仍"全部内容章节缺省供给",名单只管排除侧。// @a: anc-rule-narrative-sections
const PRIVATE_SECTION_NAMES = new Set(['处置记录']);

// 类型位约束标注双语归一（^anc-type-constraint-annotation,2026-09-02 作者拍 B 案——line(非空)
// 与 line(nonempty) 等价,AST 存英文规范形;与步骤类型中文别名同站同律。本批只有非空一个
// 约束参数,不开通用约束语言。// @a: anc-type-constraint-annotation
function normalizeTypeToken(t: string): string {
  // 括号组内逗号周边空白归一（^anc-rule-v7-header-types ④,2026-09-05 作者拍"validate 修"——0069
  // 两路语料独立撞 enum(high, low) 带空格在 Types 字段位炸而 Inputs 位合法:病根是两处分词器不
  // 一致。只归一逗号周边（enum 参数分隔的自然书写形）,AST 恒存规范形 enum(high,low),serialize
  // 往返稳定,三类型位行为一致;括号内其余空白不豁免——line( 非空 ) 仍是非法形态,0064 响亮拒
  // 的拍板不动,拒点在 Types 字段行整串核）。
  const stripped = t.replace(/\(([^)]*)\)/, (_m, inner: string) => `(${inner.replace(/\s*,\s*/g, ',')})`);
  if (stripped === 'line(非空)') return 'line(nonempty)';
  if (stripped === '[line(非空)]') return '[line(nonempty)]';   // 列表元素形同归一（review B-4:元素递归校验使英文形天然生效,中文形必须同享——双语不对称=英文暗通中文暗哑）
  return stripped;
}

// 步骤类型中文别名（parser 入口归一为英文规范形入 AST——引擎/validator 全链零感知;
// 术语表权威 design/i18n.md ^anc-i18n-glossary,act=探索 作者三轮裁定）。// @a: anc-i18n-keyword-impl
const STEP_TYPE_ALIASES: Record<string, string> = {
  '推理': 'reason', '探索': 'act', '检查': 'check', '确认': 'confirm', '询问': 'ask',
  '提交': 'commit', '调用': 'call', '分支': 'branch', '条件': 'case', '子任务': 'subtask',
  '循环': 'loop', '并行': 'parallel', '跳出循环': 'break', '继续循环': 'continue', '结束': 'exit',
  '失败兜底': 'on_fail',
};
// 属性词中文别名（retry=重试 等;并行作属性尾巴时同表归一）
const ATTR_ALIASES: Record<string, string> = {
  '重试': 'retry', '上限': 'max', '自适应': 'adaptive', '终检': 'final', '可上升': 'escalatable',
  '并行': 'parallel', '必须真人确认': 'require_human', '开放': 'free',
};

// ── 序列化反向映射（英→中,由正向别名表程序化反转——单一事实源禁手抄第二份,^anc-i18n-language-config）。
// AST 恒英文规范形,语言只活在文本面:serialize 按 lang 查此表出中文。// @a: anc-i18n-serialize-lang
export type SpecLang = 'en' | 'zh';
function invertAliases(fwd: Record<string, string>): Record<string, string> {
  const rev: Record<string, string> = {};
  for (const [zh, en] of Object.entries(fwd)) if (!(en in rev)) rev[en] = zh;   // 首见胜(表本一一对应,防御性)
  return rev;
}
const STEP_TYPE_ZH = invertAliases(STEP_TYPE_ALIASES);           // reason→推理 …
const ATTR_ZH = invertAliases(ATTR_ALIASES);                     // retry→重试 …
const SECTION_ZH: Record<string, string> = (() => {              // goal→目标 …(段头表值域是 kind,取中文键侧反转)
  const rev: Record<string, string> = {};
  for (const [key, kind] of Object.entries(SECTION_KEYWORDS)) {
    if (/[\u4e00-\u9fff]/.test(key)) rev[kind] = key;
  }
  return rev;
})();
const SECTION_EN: Record<string, string> = { goal: 'Goal', constraints: 'Constraints', types: 'Types', inputs: 'Inputs', outputs: 'Outputs', tools: 'Tools', config: 'Config', steps: 'Steps' };
// 段头出词:zh 查中文表,en 用英文首大写形——单一取词点,serializeSpec 八节共用
function sectionWord(kind: string, lang: SpecLang): string {
  return lang === 'zh' ? (SECTION_ZH[kind] ?? SECTION_EN[kind] ?? kind) : (SECTION_EN[kind] ?? kind);
}
function stepTypeWord(t: string, lang: SpecLang): string {
  if (t === 'on_fail' || t === 'on fail') return lang === 'zh' ? (STEP_TYPE_ZH['on_fail'] ?? 'on fail') : 'on fail';
  return lang === 'zh' ? (STEP_TYPE_ZH[t] ?? t) : t;
}
function attrWord(a: string, lang: SpecLang): string { return lang === 'zh' ? (ATTR_ZH[a] ?? a) : a; }

// ── 关键词转换（lang 命令的手术核,^anc-i18n-language-config 转换工具条款）。
// 行级手术:只改关键词 token,变量名/说明文字/body/叙事节字节不动——serializeSpec 单向有损
// 禁用于整文重建。识别面对齐 parser 接受面(^anc-i18n-convert-surface):段头行/首段 Id 行/
// 裸键段头行/步骤行(含标题形态) [] 内 token/工具授权行;围栏内跳过;
// 括号组内容整体跳过（case 条件/call 映射是表达式面,唯 (else)/(其他) 整组转换）。// @a: anc-i18n-language-config
// 段种类查 SECTION_KEYWORDS(键名小写,与 parser 同表)、出词走 sectionWord——单一事实源,不另抄转换表
const CLAUSE_EN2ZH: Record<string, string> = { 'for-each': '遍历', in: '于', collect: '收集', into: '入' };
const CLAUSE_ZH2EN: Record<string, string> = Object.fromEntries(Object.entries(CLAUSE_EN2ZH).map(([e, z]) => [z, e]));

function convertBracketContent(content: string, to: SpecLang): string {
  // 括号组摘出为占位（第一层平衡扫描）——组内是表达式/映射面不转换,唯 (else)/(其他) 例外
  const groups: string[] = [];
  let out = '';
  let depth = 0, start = -1;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '(') { if (depth === 0) start = i; depth++; }
    else if (ch === ')') { depth--; if (depth === 0) { groups.push(content.slice(start, i + 1)); out += `\u0000${groups.length - 1}\u0000`; start = -1; continue; } }
    if (depth === 0) out += ch;
  }
  if (depth !== 0) return content;   // 括号不平衡——不动,交给 validate 报
  // on fail / 失败兜底 双词形态先整体处理
  out = to === 'zh' ? out.replace(/^on fail\b/, '失败兜底') : out.replace(/^失败兜底/, 'on fail');
  const toks = out.split(/(\s+|\u0000\d+\u0000)/);
  const mapped = toks.map((t, idx) => {
    if (/^\s*$/.test(t) || /^\u0000\d+\u0000$/.test(t)) return t;
    const eqm = t.match(/^([A-Za-z_\u4e00-\u9fff]+)=(.*)$/);
    if (eqm) {   // retry=2 / 重试=2 / max=5 / 上限=5;present_inputs= 无中文词原样
      const key = eqm[1];
      const en = ATTR_ALIASES[key] ?? key;
      const word = to === 'zh' ? (ATTR_ZH[en] ?? en) : en;
      return `${word}=${eqm[2]}`;
    }
    const isFirst = toks.slice(0, idx).every(x => /^\s*$/.test(x));
    if (isFirst) {   // 类型词位
      const en = STEP_TYPE_ALIASES[t] ?? t;
      return to === 'zh' ? (STEP_TYPE_ZH[en] ?? t) : (STEP_TYPE_ALIASES[t] ?? t);
    }
    // 属性词与子句词（保留字保证:变量名不可能撞这些词,词元级安全）
    const enA = ATTR_ALIASES[t] ?? (CLAUSE_ZH2EN[t] !== undefined ? CLAUSE_ZH2EN[t] : t);
    if (to === 'zh') {
      if (ATTR_ZH[enA]) return ATTR_ZH[enA];
      if (CLAUSE_EN2ZH[enA]) return CLAUSE_EN2ZH[enA];
      return t;
    }
    if (ATTR_ALIASES[t]) return ATTR_ALIASES[t];
    if (CLAUSE_ZH2EN[t]) return CLAUSE_ZH2EN[t];
    return t;
  });
  let res = mapped.join('');
  // 占位还原;(else)/(其他) 整组转换
  res = res.replace(/\u0000(\d+)\u0000/g, (_, n) => {
    const g = groups[Number(n)];
    if (to === 'zh' && g === '(else)') return '(其他)';
    if (to === 'en' && g === '(其他)') return '(else)';
    return g;
  });
  return res;
}

/** 关键词语言转换（行级手术）——lang 命令消费。to='zh' 英转中,'en' 中转英;
 * 双向可逆（词表一一对应+括号组不动）。见 [[i18n#^anc-i18n-language-config]]。// @a: anc-i18n-language-config */
export function convertSpecKeywords(text: string, to: SpecLang): string {
  const lines = text.split('\n');
  let inFence = false;
  let seenHeading = false;     // 见过任一段头行——Id 行只在此前转换
  let sectionsOpen = false;    // 段区已开启(一级标题/关键字二级段头/Id 行)——parser 此前不看内联标签
  let stepsStarted = false;    // 已进入步骤段——之后裸键不转(叙事节 Goal: 字样不误伤)
  const seenKinds = new Set<SectionKind>();   // 已出现的段种类——同种类只转第一次,## 与裸键两形态共用
  const out = lines.map(line => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    if (/^#\s+\S/.test(line)) sectionsOpen = true;               // 一级标题(多词亦算,parser 的 title 段)
    if (RE_ID_LINE.test(line)) sectionsOpen = true;              // Id 行不论位置都开启段区 // @a: anc-i18n-convert-surface
    // 段头行 ## Word——词转小写查表,出规范形(作者拍甲案:大小写不敏感、一律规范形)
    const hm = line.match(/^(#{1,6})(\s+)([A-Za-z\u4e00-\u9fff]+)(\s*)$/);
    if (hm) {
      seenHeading = true;
      const kind = SECTION_KEYWORDS[hm[3].toLowerCase()];
      if (!kind) return line;
      if (hm[1].length === 2) {
        sectionsOpen = true;
        seenKinds.add(kind);
        if (kind === 'steps') stepsStarted = true;
      }
      return hm[1] + hm[2] + sectionWord(kind, to) + hm[4];
    }
    // Id 行（首个段头之前——叙事节里的 Id: 字样不误伤）
    if (!seenHeading) {
      const im = line.match(/^(Id|标识)(\s*:\s*)(.*)$/);
      if (im) return (to === 'zh' ? '标识' : 'Id') + im[2] + im[3];
    }
    // 工具授权/禁用行 - tools: / - 工具: / - deny_tools: / - 禁工具:（^anc-step-tool-deny 禁用半边随扩） // @a: anc-step-tool-deny
    const tm = line.match(/^(\s*-\s*)(tools|工具|deny_tools|禁工具)(\s*[:：].*)$/);
    if (tm) {
      const en = ENTRY_KEY_ZH2EN[tm[2]] ?? tm[2];
      return tm[1] + (to === 'zh' ? (ENTRY_KEY_EN2ZH[en] ?? en) : en) + tm[3];
    }
    // 裸键段头行 Goal: / 目标:——对齐 identifySections 内联标签分支(半角冒号/行首无缩进无 "- "/同类只认第一次),
    // 只在步骤段之前(比 parser 窄:步骤段后首见关键字裸键会截断步骤段,属写错不跟)。// @a: anc-i18n-convert-surface
    if (sectionsOpen && !stepsStarted) {
      const bm = line.match(/^([\w\u4e00-\u9fff]+)(\s*:.*)$/);
      const kind = bm ? SECTION_KEYWORDS[bm[1].toLowerCase()] : undefined;
      if (bm && kind) {
        if (seenKinds.has(kind)) return line;
        seenKinds.add(kind);
        if (kind === 'steps') stepsStarted = true;
        return sectionWord(kind, to) + bm[2];
      }
    }
    // 步骤行 [] 内转换——行首可带任意个 # 加空白(标题形态,对齐 parseStepSection 剥前缀) // @a: anc-i18n-convert-surface
    const sm = line.match(/^(\s*(?:#+\s+)?\d+(?:\.\d+)*\.?\s+\[)([^\]]*)(\].*)$/);
    if (sm) return sm[1] + convertBracketContent(sm[2], to) + sm[3];
    return line;
  });
  return out.join('\n');
}

function identifySections(lines: string[], errors?: ParseError[]): Section[] {
  const sections: Section[] = [];
  let inFence = false;
  let fenceOpenLine = -1;   // 未闭合围栏响亮拒（^anc-rule-unclosed-fence）——记开栏行供报错

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (RE_FENCE.test(line.trim())) { inFence = !inFence; if (inFence) fenceOpenLine = i + 1; continue; }
    if (inFence) continue;

    const hm = line.match(RE_HEADING);
    if (hm) {
      const depth = hm[1].length;
      const text = hm[2].trim();
      if (depth === 1 && sections.length === 0) {
        sections.push({ kind: 'title', startLine: i, endLine: i + 1 });
      } else if (depth === 2) {
        const key = text.toLowerCase().replace(/\s+/g, '');
        const kind = SECTION_KEYWORDS[key];
        // 非关键字的 depth-2 标题（如标题风的 `## Task` 契约分区）静默忽略——不产生 section、
        // 零解析影响。这是有意支持的 Obsidian 折叠分区惯例，非漏网 bug，勿加报错。
        // 见 design ^anc-rule-surface-heading-flavor。// @a: anc-rule-surface-heading-flavor
        if (kind) sections.push({ kind, startLine: i, endLine: i + 1 });
      }
      continue;
    }

    // Inline label format: "Goal: text", "Inputs:", etc.
    if (sections.length > 0) {
      const labelMatch = line.match(/^([\w\u4e00-\u9fff]+)\s*:/);   // 内联标签双语（目标:/输入: 同 Goal:/Inputs:——独立面,漏收=中文内联形静默失效）// @a: anc-i18n-keyword-impl
      if (labelMatch) {
        const key = labelMatch[1].toLowerCase();
        const kind = SECTION_KEYWORDS[key];
        if (kind && !sections.some(s => s.kind === kind)) {
          sections.push({ kind, startLine: i, endLine: i + 1 });
        }
      }
    }

    // Id: line (special case, not a section heading)
    if (RE_ID_LINE.test(line) && !sections.some(s => s.kind === 'id')) {
      sections.push({ kind: 'id', startLine: i, endLine: i + 1 });
    }
  }

  // 未闭合围栏响亮拒（^anc-rule-unclosed-fence）——扫描结束仍在围栏内=其后内容已被静默吞
  if (inFence && errors) {
    errors.push({ kind: 'parse', line: fenceOpenLine, message: '围栏未闭合（``` 开于第 ' + fenceOpenLine + ' 行）——其后内容被围栏吞掉,检查产物是否被截断' });
  }

  // Set endLine for each section to next section's start (or EOF)
  for (let i = 0; i < sections.length; i++) {
    const next = sections[i + 1];
    sections[i].endLine = next ? next.startLine : lines.length;
  }

  return sections;
}

// ===== Header parsing =====

function parseHeaderSections(
  lines: string[],
  sections: Section[],
  errors: ParseError[],
): SpecHeader {
  const header: SpecHeader = { title: '' };
  // 声明区孤儿行收集容器（^anc-rule-decl-zone-warn）——Inputs/Outputs/Types/Constraints/Config
  // 五段+Id 行,parser 零报错只收集,validator W1 判定（Tools 段自身响亮报错,不入此道）
  const declOrphans: Array<{ line: number; text: string; section: string }> = [];

  const titleSec = sections.find(s => s.kind === 'title');
  if (titleSec) {
    const hm = lines[titleSec.startLine].match(RE_HEADING);
    if (hm) header.title = hm[2].trim();
  } else {
    errors.push({ kind: 'parse', line: 1, message: 'Missing spec title (# heading)' });
  }

  const idSec = sections.find(s => s.kind === 'id');
  if (idSec) {
    // Id 行两形态（S14,2026-08-09 作者定）：纯标识符 `Id: x` / 函数签名 `Id: f(a, b) -> c, d`。
    // 签名时 id=func 名（call 寻址不变）,签名原文存 header.signature(serializer 原样回写)。
    // @a: anc-rule-s14
    const idRaw = lines[idSec.startLine].replace(/^(?:Id|标识)\s*:\s*/, '').trim();   // 前缀双语同 RE_ID_LINE // @a: anc-i18n-keyword-impl
    const sigM = idRaw.match(/^([\w\u4e00-\u9fff][\w\u4e00-\u9fff-]*)\s*\(/);   // 签名函数名收中文（变量名=Unicode 标识符同款）
    if (sigM) {
      header.id = sigM[1];
      header.signature = idRaw;
    } else {
      const m = lines[idSec.startLine].match(RE_ID_LINE);
      if (m) header.id = m[1].trim();
    }
  }

  const goalSec = sections.find(s => s.kind === 'goal');
  if (goalSec) header.goal = parsePlainTextSection(lines, goalSec);

  const conSec = sections.find(s => s.kind === 'constraints');
  if (conSec) {
    header.constraints = parseListSection(lines, conSec);
    collectDeclZoneOrphans(lines, conSec, 'Constraints',
      t => RE_LIST_ITEM.test(t), declOrphans);
    const conDocRefs = extractDocRefs(header.constraints.join('\n')); // @a: anc-rule-doc-ref-extract
    if (conDocRefs.length > 0) header.doc_refs = conDocRefs;
  }

  const typesSec = sections.find(s => s.kind === 'types');
  if (typesSec) header.types = parseTypesSection(lines, typesSec, errors, declOrphans);

  const inputsSec = sections.find(s => s.kind === 'inputs');
  if (inputsSec) {
    header.inputs = parseVarDeclSection(lines, inputsSec);
    collectDeclZoneOrphans(lines, inputsSec, 'Inputs',
      t => RE_VAR_DECL.test(t), declOrphans);
  }

  const outputsSec = sections.find(s => s.kind === 'outputs');
  if (outputsSec) {
    header.outputs = parseOutputDeclSection(lines, outputsSec);
    collectDeclZoneOrphans(lines, outputsSec, 'Outputs',
      t => RE_VAR_DECL.test(t), declOrphans);
  }

  const toolsSec = sections.find(s => s.kind === 'tools');
  if (toolsSec) header.tools = parseToolsSection(lines, toolsSec, errors);   // Tools 段自身已响亮报错（三分支外皆 parse error）,无静默吞行面,不入孤儿收集

  const configSec = sections.find(s => s.kind === 'config');
  if (configSec) {
    header.config = parseConfigSection(lines, configSec);
    // Config 键行判据=半角冒号的 `-? 键: 值` 形态（整段 YAML 与逐行回退都只认它;
    // 全角冒号 `expansion_max：20` 两条路都吃不进——与 Inputs 同款静默丢,同罩）
    collectDeclZoneOrphans(lines, configSec, 'Config',
      t => /^-?\s*[^\s:]+\s*:/.test(t), declOrphans);
  }

  // Id 行全角冒号网（^anc-rule-decl-zone-warn）：`Id：xxx` 半角正则不认,整份 spec 无 id
  // ——静默面比声明行更痛（call 寻址/register 直接失联）。头区内发现全角形态且 id 缺席即记孤儿。
  if (!header.id) {
    const stepsStart = sections.find(sc => sc.kind === 'steps')?.startLine ?? lines.length;
    for (let i = 0; i < stepsStart; i++) {
      if (/^(?:Id|标识)：/.test(lines[i].trim())) {
        declOrphans.push({ line: i + 1, text: lines[i].trim().slice(0, 60), section: 'Id' });
        break;
      }
    }
  }
  if (declOrphans.length > 0) header.decl_zone_orphans = declOrphans;

  return header;
}

// Tools 段解析（^anc-rule-tools-section,概念 ^anc-tool-two-faces spec 需求声明半边）：
// 签名行 `- tool(p1, p2) -> out: type  # 用途` + 参数子条目 `  - p: type  # 说明` + `  > 扩展`。
// 校验:签名括号参数与子条目按名一致（多/漏/错名 error）;同名工具重复 error。
// 类型词汇表核对归 validator（T 组规则）——parser 只收结构。// @a: anc-rule-tools-section
const RE_TOOL_SIG = /^-\s+([\w\u4e00-\u9fff][\w\u4e00-\u9fff-]*)\s*\(([^)]*)\)\s*(?:->\s*([\w\u4e00-\u9fff][\w\u4e00-\u9fff_-]*)\s*:\s*(\S+))?\s*(?:#\s*(.*))?$/;
const RE_TOOL_PARAM = /^-\s+([\w\u4e00-\u9fff][\w\u4e00-\u9fff_-]*)\s*:\s*(\S+)\s*(?:#\s*(.*))?$/;

function parseToolsSection(lines: string[], sec: Section, errors: ParseError[]): ToolNeed[] {
  const tools: ToolNeed[] = [];
  let cur: (ToolNeed & { sigParams: string[] }) | null = null;
  const flush = () => {
    if (!cur) return;
    const declared = cur.params.map(p => p.name);
    const sig = cur.sigParams;
    const missing = sig.filter(n => !declared.includes(n));
    const extra = declared.filter(n => !sig.includes(n));
    if (missing.length || extra.length) {
      errors.push({ kind: 'parse', line: sec.startLine + 1, message: `Tools 段 '${cur.name}' 签名参数与子条目不一致${missing.length ? `——签名有而子条目缺: ${missing.join(', ')}` : ''}${extra.length ? `——子条目多出: ${extra.join(', ')}` : ''}（签名括号列参数名,每个参数一条 '- 名: 类型  # 说明' 子条目按名对应）` });
    }
    if (tools.some(t => t.name === cur!.name)) {
      errors.push({ kind: 'parse', line: sec.startLine + 1, message: `Tools 段工具 '${cur.name}' 重复声明` });
    } else {
      const { sigParams: _sp, ...rest } = cur;
      tools.push(rest);
    }
    cur = null;
  };
  const bodyStart = sec.startLine + (RE_HEADING.test(lines[sec.startLine]) ? 1 : 0) + (lines[sec.startLine].trim().match(/^(Tools|工具)\s*:/) ? 1 : 0);
  for (let li = bodyStart; li < sec.endLine; li++) {
    const line = lines[li].replace(/\s+$/, '');
    if (!line.trim()) continue;
    const lineNo = li + 1;   // 真实 1-based 行号（review D7:原恒报段头行,定位失效）
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (indent === 0 && t.startsWith('- ')) {
      const m = t.match(RE_TOOL_SIG);
      if (!m) { errors.push({ kind: 'parse', line: lineNo, message: `Tools 段签名行不合文法: '${t}'——形态 '- 工具名(参数, …) -> 输出名: 类型  # 用途'` }); continue; }
      flush();
      cur = {
        name: m[1],
        sigParams: m[2].split(',').map(x => x.trim()).filter(Boolean),
        params: [],
        ...(m[3] ? { output: { name: m[3], type: normalizeTypeToken(m[4]) } } : {}),
        ...(m[5] ? { description: m[5].trim() } : {}),
      };
    } else if (indent >= 2 && t.startsWith('- ') && cur) {
      const m = t.match(RE_TOOL_PARAM);
      if (!m) { errors.push({ kind: 'parse', line: lineNo, message: `Tools 段参数条目不合文法: '${t}'——形态 '- 参数名: 类型  # 说明'` }); continue; }
      cur.params.push({ name: m[1], type: normalizeTypeToken(m[2]), ...(m[3] ? { description: m[3].trim() } : {}) });
    } else if (indent >= 2 && t.startsWith('>') && cur) {
      const noteLine = t.replace(/^>\s?/, '');
      cur.notes = cur.notes ? cur.notes + '\n' + noteLine : noteLine;
    } else {
      // 三分支外一律响亮报错（review D7:缩进 2 格的签名行整段静默丢——interim 拦截防的
      // "静默吞"在段内复发;Tools 段内不存在合法的第四种行形态）
      errors.push({ kind: 'parse', line: lineNo, message: `Tools 段行形态不合文法: '${t}'——合法形态三种:顶格签名行 '- 工具名(…)'/缩进参数条目 '- 名: 类型'/缩进 '> 扩展'${cur ? '' : '（参数条目须在签名行之后）'}` });
    }
  }
  flush();
  return tools;
}

function sectionBodyLines(lines: string[], sec: Section): string[] {
  const start = sec.startLine;
  const firstLine = lines[start];
  // Skip the heading/label line itself; for inline label with content, handle separately
  const isHeading = RE_HEADING.test(firstLine);
  const bodyStart = isHeading ? start + 1 : start;

  // For inline label format "Goal: text", the text after ":" is part of content
  const result: string[] = [];
  for (let i = bodyStart; i < sec.endLine; i++) {
    const line = lines[i];
    if (i === start && !isHeading) {
      // Inline label: extract text after ":"
      const colonIdx = line.indexOf(':');
      if (colonIdx >= 0) {
        const rest = line.slice(colonIdx + 1).trim();
        if (rest) result.push(rest);
        continue;
      }
    }
    result.push(line);
  }
  return result;
}

function parsePlainTextSection(lines: string[], sec: Section): string {
  return sectionBodyLines(lines, sec)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n');
}

function parseListSection(lines: string[], sec: Section): string[] {
  const items: string[] = [];
  for (const line of sectionBodyLines(lines, sec)) {
    const m = line.trim().match(RE_LIST_ITEM);
    if (m) items.push(m[1].trim());
  }
  return items;
}

function parseTypesSection(lines: string[], sec: Section, errors: ParseError[], orphans?: Array<{ line: number; text: string; section: string }>): TypeDecl[] {
  const types: TypeDecl[] = [];
  const bodyLines = sectionBodyLines(lines, sec);
  // 孤儿上报（^anc-rule-decl-zone-warn）：Types 段文法有状态（字段行仅在类型声明下合法）,
  // 静默丢点在段内三处,收集只能做在这里。bodyLines 丢了原始行号,报段起始行+段内偏移近似定位。
  const headOffset = RE_HEADING.test(lines[sec.startLine]) ? 1 : 0;
  let orphanStopped = false;   // 撞 ## 标题（叙事节起点）后停止上报——同 collectDeclZoneOrphans 的 break
  const orphan = (i: number, trimmed: string) => {
    if (/^##\s/.test(trimmed)) { orphanStopped = true; return; }
    if (!orphanStopped && orphans && trimmed && !trimmed.startsWith('#')) orphans.push({ line: sec.startLine + headOffset + i + 1, text: trimmed.slice(0, 60), section: 'Types' });
  };
  let current: TypeDecl | null = null;
  let typeIndent = -1;

  for (let i = 0; i < bodyLines.length; i++) {
    const raw = bodyLines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // New type declaration: "- TypeName:" or "TypeName:"（容忍尾部 `# 注释`）
    const typeMatch = trimmed.match(/^-?\s*([\w\u4e00-\u9fff]+)\s*:\s*(?:#\s*(.*))?$/);   // 类型名收中文（变量名 Unicode 同族——原 \w+ 中文类型声明整块静默丢,review 全谱表驱动抓漏）// @a: anc-i18n-keyword-impl
    if (typeMatch) {
      if (current) types.push(current);
      // 类型级 # 注释随声明入 AST（LLM 消费面渲染,JIT 面零消费——作者定 2026-08-27）// @a: anc-type-type-decl
      current = { name: typeMatch[1], fields: {}, ...(typeMatch[2]?.trim() ? { description: typeMatch[2].trim() } : {}) };
      typeIndent = raw.search(/\S/);
      continue;
    }

    // Field line (indented under type): "fieldName: typeString"
    if (current) {
      const lineIndent = raw.search(/\S/);
      if (lineIndent > typeIndent) {
        // 容忍字段行首的 `- ` 列表前缀（`- id: line` 与 `id: line` 均可，与 TypeName 行 `-?` 一致）。
        // 旧正则漏了 `-?\s*`，致 `- field: type` 写法的字段被整体丢弃、fields 空（C8 字段校验落空）。
        const fieldMatch = trimmed.match(/^-?\s*([\w\u4e00-\u9fff]+)\s*:\s*([^\s(]+(?:\([^)]*\))?\]?)/);   // 字段名同族收中文;类型串分词=先收标识符（[^\s(]+——不吞括号）再整收括号组（括号内容容空格,enum(high, low) 一次收全——原 \S+ 贪婪在空格断截出 enum(high, 触发余料闸,与 Inputs 位行为劈叉,^anc-rule-v7-header-types ④） // @a: anc-i18n-keyword-impl
        // 整串核余料（todo/0064——前缀匹配曾把 line( 非空 ) 截成 line( 静默入 fields:
        // 类型串之后只许空白或 # 注释,余料非空=非法形态响亮报错不静默切值）// @a: anc-type-constraint-annotation
        if (fieldMatch) {
          // 余料起点=整段匹配的结束位（不许 indexOf 类型串——"line" 会先在字段名 "line_ref" 里命中,存量扫描实撞误伤）
          const rest = trimmed.slice((fieldMatch.index ?? 0) + fieldMatch[0].length);
          if (rest.trim() !== '' && !rest.trimStart().startsWith('#')) {
            errors.push({ kind: 'parse', line: i + 1, message: `Types 节字段 "${fieldMatch[1]}" 的类型 "${fieldMatch[2]}${rest.split('#')[0].trimEnd()}" 不合类型文法（类型串之后只许 # 注释）。非空约束的正确写法: line(非空) 或 line(nonempty)（括号内不带空格）` });
            continue;
          }
          // 括号组整收后残余空白核（^anc-rule-v7-header-types ④——分词容空格是为 enum 逗号形,
          // 逗号归一后仍含空白的括号组〔line( 非空 )〕是 0064 拍板的非法形态,拒点从余料闸移
          // 至此,消息不变钉不动）。
          if (/\s/.test(normalizeTypeToken(fieldMatch[2]))) {
            errors.push({ kind: 'parse', line: i + 1, message: `Types 节字段 "${fieldMatch[1]}" 的类型 "${fieldMatch[2]}" 不合类型文法（类型串之后只许 # 注释）。非空约束的正确写法: line(非空) 或 line(nonempty)（括号内不带空格）` });
            continue;
          }
        }
        if (fieldMatch) {
          current.fields[fieldMatch[1]] = normalizeTypeToken(fieldMatch[2]);   // 第七收取点——头部 Types 节字段（review 实抓:漏归一的 line(非空) 在此位静默零保护,0043 形态复刻）// @a: anc-type-constraint-annotation
          // 字段 # 注释入 field_descriptions（原样保留不截断）// @a: anc-type-type-decl
          const hashIdx = trimmed.indexOf('#');
          if (hashIdx >= 0) {
            const desc = trimmed.slice(hashIdx + 1).trim();
            if (desc) (current.field_descriptions ??= {})[fieldMatch[1]] = desc;
          }
        } else {
          orphan(i, trimmed);   // 缩进在类型下但不合字段文法（如全角冒号）——原静默 continue
        }
        continue;
      }
      // Not indented under type — finalize current TypeDecl
      types.push(current);
      current = null;
    }
    orphan(i, trimmed);   // 走到此处=既非类型声明也非字段行——原静默掉出循环
  }
  if (current) types.push(current);
  return types;
}

// 声明区孤儿行收集（^anc-rule-decl-zone-warn,todo/0016）：段体内未被文法消费的非空非注释行
// ——parser 只收集零报错,validator W1 出 warn。matched=该行是否被本段文法认领的判据回调。
// @a: anc-rule-decl-zone-warn
function collectDeclZoneOrphans(
  lines: string[], sec: Section, sectionName: string,
  matched: (trimmed: string) => boolean,
  sink: Array<{ line: number; text: string; section: string }>,
): void {
  const bodyStart = sec.startLine + 1;   // 段头行自身不查（Inputs: 同行内容归段头）
  for (let i = bodyStart; i < sec.endLine; i++) {
    const trimmed = lines[i].trim();
    // 撞到 ## 标题即停：非关键字节（叙事节）不打断 section 范围（identifySections 只认关键字）,
    // 其散文若继续收集会被误算进前一个声明段挨 W1——叙事节内容是合法自由文本（^anc-rule-narrative-sections）
    if (/^##\s/.test(trimmed)) break;
    if (!trimmed || trimmed.startsWith('#')) continue;   // 空行/纯注释豁免
    if (matched(trimmed)) continue;
    sink.push({ line: i + 1, text: trimmed.slice(0, 60), section: sectionName });
  }
}

function parseVarDeclSection(lines: string[], sec: Section): VarDecl[] {
  const vars: VarDecl[] = [];
  for (const line of sectionBodyLines(lines, sec)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(RE_VAR_DECL);
    if (m) {
      vars.push({ name: m[1], type: normalizeTypeToken(m[2]), description: m[3]?.trim() });
    }
  }
  return vars;
}

function parseOutputDeclSection(lines: string[], sec: Section): OutputDecl[] {
  const outputs: OutputDecl[] = [];
  for (const line of sectionBodyLines(lines, sec)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(RE_VAR_DECL);
    if (m) {
      outputs.push({ name: m[1], type: normalizeTypeToken(m[2]), description: m[3]?.trim() ?? '' });
    }
  }
  return outputs;
}

// 条目列表递归归一：单键映射列表 → merge 为映射;值本身又是单键映射列表 → 递归。
// 非"全部为单键映射"的列表（如将来真列表值）原样保留不误伤。
function normalizeEntryList(list: unknown[]): Record<string, unknown> | unknown[] {
  const allSingleKeyMaps = list.length > 0 && list.every(it =>
    it !== null && typeof it === 'object' && !Array.isArray(it) && Object.keys(it as object).length >= 1);
  if (!allSingleKeyMaps) return list;
  const merged: Record<string, unknown> = {};
  for (const item of list) {
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      merged[k] = Array.isArray(v) ? normalizeEntryList(v) : v;
    }
  }
  return merged;
}

function parseConfigSection(lines: string[], sec: Section): SpecConfig {
  // Config 段按 YAML 整段解析（2026-08-13 随 models 类别映射引入——原逐行正则把嵌套键拍平:
  // models: 下的 replan: 被误当顶层键。段本就是 YAML 语义,整段解析是归位非扩展）。
  // 解析失败回退逐行（旧行为兜底——config 段草率缩进的存量 spec 不因此炸）。
  const body = sectionBodyLines(lines, sec).join('\n');
  try {
    const parsed = yamlLoad(body);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SpecConfig;
    }
    // '-' 分项体例（与 Inputs/Outputs 一致——2026-08-13 作者定用户心智一致优先,内外层同体例）：
    // YAML 解析为单键映射列表,归一 merge 为配置映射;嵌套值（如 models 的类别条目）同为
    // 单键映射列表时递归归一——'- reason: x' 内层条目与外层一种写法。重复键后者赢（同 YAML 映射语义）
    if (Array.isArray(parsed)) {
      return normalizeEntryList(parsed) as SpecConfig;
    }
  } catch { /* 回退逐行 */ }
  const config: SpecConfig = {};
  for (const line of sectionBodyLines(lines, sec)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^-?\s*(\w+)\s*:\s*(.+)/);
    if (m) {
      const val = m[2].trim();
      const num = Number(val);
      config[m[1]] = Number.isFinite(num) ? num : val;
    }
  }
  return config;
}

// ===== Step parsing =====

interface FlatStep {
  step_id: string;
  step_type: string;
  summary: string;
  attrs: Record<string, string | boolean>;
  inputs: VarBinding[];
  outputs: OutputDecl[];
  rawOutputs: string[];  // 原始 + → 文本（call 步骤据此解析 output_mapping）
  instruction: string[];
  forEach?: { listVar: string; itemVar: string };  // for-each: X → Y
  headingFlavor?: boolean;  // 标题风步骤（step 行带 `#` 前缀）——启用段落吸收进 instruction。内部字段，不入 AST。 // @a: anc-rule-surface-heading-flavor
  source_location: SourceLocation;
}

function parseStepSection(
  lines: string[],
  sec: Section,
  errors: ParseError[],
  orphans?: Array<{ line: number; text: string; section: string }>,
): StepNode[] {
  const flatSteps: FlatStep[] = [];
  let current: FlatStep | null = null;
  // 复合输出 YAML 展开的收集状态：非空时后续缩进子行归入其 fields（规则权威 anc-rule-compound-output——散文引用,标注在真落点行;2026-09-04 review 抓 60 处批修时本行引用被误转标注且句残,复原引用语义）
  let pendingCompound: { decl: OutputDecl; indent: number } | null = null;
  let inFence = false;
  let stepFenceOpenLine = -1;   // 未闭合围栏响亮拒（^anc-rule-unclosed-fence）
  // 标题风裸 fence 捕获态：进入裸 ```hop_python 且属 heading-flavor 步骤时置真，
  // fence 开/闭行与 body 行捕获进 current.instruction（body 按开栏缩进 de-indent）。
  // 见 design ^anc-rule-surface-heading-flavor。
  let captureFence = false;
  let fenceIndent = 0;
  // 孤儿停收闸（^anc-rule-decl-zone-warn Steps 扩围）：Steps 后的叙事节（## 使用说明 等非关键字
  // 标题）不产生 section,Steps 区间一直伸到文件尾——撞到 ## 标题即停收孤儿,叙事散文是合法自由文本
  let orphanStop = false;

  for (let i = sec.startLine + 1; i < sec.endLine; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (RE_FENCE.test(trimmed)) {
      // heading-flavor 步骤的裸 fence：捕获而非丢弃。开栏进捕获态、记缩进；闭栏出捕获态。
      // 开/闭行归一（无缩进）推入 instruction，供 extractHopPythonFence 提取。
      if (!inFence && current?.headingFlavor && !captureFence) {
        captureFence = true;
        fenceIndent = line.length - line.trimStart().length;
        current.instruction.push(trimmed);
        continue;
      }
      if (captureFence) {
        current!.instruction.push(trimmed);
        captureFence = false;
        continue;
      }
      inFence = !inFence;
      if (inFence) stepFenceOpenLine = i + 1;
      continue;
    }
    if (captureFence) {
      // body 行：按开栏缩进 de-indent（act body 缩进敏感），不足则整体 trimStart 兜底。
      current!.instruction.push(line.length >= fenceIndent ? line.slice(fenceIndent) : line.trimStart());
      continue;
    }
    if (inFence) continue;
    if (!trimmed) continue;
    if (trimmed.startsWith('%%')) continue;
    if (/^##\s/.test(trimmed)) orphanStop = true;   // 叙事节起点,之后不再收孤儿

    // Try step line。标题风：先剥行首 `#` 前缀（`### 1. [reason] …`），再匹配 RE_STEP。
    // 剥掉过前缀 = heading-flavor 步骤，启用下方段落吸收。`#` 个数不参与树构建（树由 step ID
    // 数字编码），故深过 h6 的 `#######` 照常解析。见 design ^anc-rule-surface-heading-flavor。
    const stepBody = trimmed.replace(/^#+\s+/, '');
    const isHeadingFlavor = stepBody !== trimmed;
    // [case(条件)] 结构化逻辑标准写法特判（2026-08-09 作者定:机读入 [],与 loop 属性同构）——条件可含
    // ]（items[0]）与嵌套括号,RE_STEP 的 [^\]]* 会误截,须括号平衡扫描。// @a: anc-rule-case-condition
    let stepMatch = (stepBody.match(/^(\d+(?:\.\d+)*)(?:\.\s*|\s+)\[(?:case|条件)\(/) || stepBody.match(/^(\d+(?:\.\d+)*)(?:\.\s*|\s+)\[(?:call|调用)\s+[A-Za-z_][\w-]*\(/) || stepBody.match(/^(\d+(?:\.\d+)*)(?:\.\s*|\s+)\[(?:call|调用)\s+\{/)) ? null : stepBody.match(RE_STEP);
    if (!stepMatch) {
      const caseM = stepBody.match(/^(\d+(?:\.\d+)*)(?:\.\s*|\s+)\[(case|条件)\(/);
      if (caseM) {
        const openIdx = stepBody.indexOf(`[${caseM[2]}(`) + caseM[2].length + 1;   // 指向 (
        let depth = 0, closeIdx = -1;
        for (let k = openIdx; k < stepBody.length; k++) {
          if (stepBody[k] === '(') depth++;
          else if (stepBody[k] === ')') { depth--; if (depth === 0) { closeIdx = k; break; } }
        }
        if (closeIdx > 0) {
          // `)` 与 `]` 间允许属性尾巴（[case(cond) retry=2 parallel]——case 就是 branch 下的
          // subtask,可带 retry/adaptive/parallel;2026-08-13 随属性总闸补通道,此前尾巴无路
          // 导致 [case parallel] 被静默吞）。尾巴经 \u0000 第二段传递,对齐 __callee 通道模式。
          // @a: anc-rule-case-condition, anc-rule-attr-gate
          const closeBr = stepBody.indexOf(']', closeIdx + 1);
          if (closeBr > 0 && stepBody.slice(closeIdx + 1, closeBr).trim().match(/^[\w\u4e00-\u9fff=,\s-]*$/)) {
            const cond = stepBody.slice(openIdx + 1, closeIdx).trim();
            const tail = stepBody.slice(closeIdx + 1, closeBr).trim();
            const desc = stepBody.slice(closeBr + 1).trim();
            // 合成 RE_STEP 形状的 match:[id, id, type, attrs, summary]——条件经 attrs 通道传递
            stepMatch = [stepBody, caseM[1], 'case', `__cond=${cond}${tail ? '\u0000' + tail : ''}`, desc] as unknown as RegExpMatchArray;
          }
        }
      }
    }
    // [call <Id>(输入映射)] 结构化逻辑标准写法特判（2026-08-09 作者裁决:机读全入 [],与 case/loop 同构——
    // primer 盲测实撞:agent 把"方括号=机器面"泛化到 call 被 P1 拒,结构化逻辑标准写法不一致的债）。
    // 映射值可含引号/嵌套括号 → 括号平衡扫描;id 与映射串经 attrs 内部通道传递。
    // 无括号形态 [call id] 由 RE_STEP 常规命中（attrs='id'）,在 buildStep 处理。// @a: anc-rule-call-orthography
    if (!stepMatch) {
      const callM = stepBody.match(/^(\d+(?:\.\d+)*)(?:\.\s*|\s+)\[(?:call|调用)\s+([A-Za-z_][\w-]*)\(/);
      if (callM) {
        const openIdx = stepBody.indexOf('(', stepBody.search(/\[(?:call|调用)/));
        let depth = 0, closeIdx = -1;
        for (let k = openIdx; k < stepBody.length; k++) {
          if (stepBody[k] === '(') depth++;
          else if (stepBody[k] === ')') { depth--; if (depth === 0) { closeIdx = k; break; } }
        }
        // ) 与 ] 之间允许属性尾巴（[call id(...) parallel]，统一模型 call 标注形态）——尾巴限
        // 单词/空白/逗号/= 字符集（防吞误写的映射残段），经 \\u0000 第三段传递。// @a: anc-step-parallel
        if (closeIdx > 0) {
          const bracketEnd = stepBody.indexOf(']', closeIdx + 1);
          const attrsTail = bracketEnd > closeIdx ? stepBody.slice(closeIdx + 1, bracketEnd).trim() : null;
          if (attrsTail !== null && /^[\w\u4e00-\u9fff\s,=-]*$/.test(attrsTail)) {
            const mapStr = stepBody.slice(openIdx + 1, closeIdx).trim();
            const desc = stepBody.slice(bracketEnd + 1).trim();
            stepMatch = [stepBody, callM[1], 'call', `__callee=${callM[2]}\u0000${mapStr}\u0000${attrsTail}`, desc] as unknown as RegExpMatchArray;
          }
        }
      }
    }
    // [call {表达式}(映射)] callee 位插值形态（晚绑定,^anc-step-call-dynamic-callee）——花括号
    // 平衡扫描切出表达式串（表达式内可含下标 [0] 等,按 {} 配对扫）,随后照静态形态括号平衡扫描
    // 映射段;无映射形态 [call {expr}] 也认。表达式串带花括号原样入 __callee 通道——静态 Id 首
    // 字符限字母/下划线,`{` 开头即插值形态,buildStep 据此分流。// @a: anc-step-call-dynamic-callee
    if (!stepMatch) {
      const dynM = stepBody.match(/^(\d+(?:\.\d+)*)(?:\.\s*|\s+)\[(?:call|调用)\s+\{/);
      if (dynM) {
        const braceOpen = stepBody.indexOf('{', stepBody.search(/\[(?:call|调用)/));
        let bdepth = 0, braceClose = -1;
        for (let k = braceOpen; k < stepBody.length; k++) {
          if (stepBody[k] === '{') bdepth++;
          else if (stepBody[k] === '}') { bdepth--; if (bdepth === 0) { braceClose = k; break; } }
        }
        if (braceClose > 0) {
          const exprSrc = stepBody.slice(braceOpen + 1, braceClose).trim();
          // `}` 后两形态：紧跟 `(` 映射段（括号平衡扫描,与静态形态同规）或直达 `]`（无映射）。
          let mapStr = '';
          let tailStart = braceClose + 1;
          if (/^\s*\(/.test(stepBody.slice(braceClose + 1))) {
            const openIdx = stepBody.indexOf('(', braceClose + 1);
            let depth = 0, closeIdx = -1;
            for (let k = openIdx; k < stepBody.length; k++) {
              if (stepBody[k] === '(') depth++;
              else if (stepBody[k] === ')') { depth--; if (depth === 0) { closeIdx = k; break; } }
            }
            if (closeIdx > 0) { mapStr = stepBody.slice(openIdx + 1, closeIdx).trim(); tailStart = closeIdx + 1; }
            else tailStart = -1;   // 映射括号不闭合——不认作步骤行,与静态形态同款落空
          }
          if (tailStart > 0) {
            // `]` 前允许属性尾巴（[call {expr}(...) parallel]）——字符集限制与静态形态同款
            const bracketEnd = stepBody.indexOf(']', tailStart);
            const attrsTail = bracketEnd >= tailStart ? stepBody.slice(tailStart, bracketEnd).trim() : null;
            if (attrsTail !== null && /^[\w\u4e00-\u9fff\s,=-]*$/.test(attrsTail)) {
              const desc = stepBody.slice(bracketEnd + 1).trim();
              stepMatch = [stepBody, dynM[1], 'call', `__callee={${exprSrc}}\u0000${mapStr}\u0000${attrsTail}`, desc] as unknown as RegExpMatchArray;
            }
          }
        }
      }
    }
    if (stepMatch) {
      if (current) {
        current.source_location.line_end = i;
        flatSteps.push(current);
      }
      const [, stepId, stepTypeRaw, attrStr, summaryRaw] = stepMatch;
      // 中文步骤类型归一为英文规范形（i18n 直通,AST 恒英文——报错回显作者写的字面）
      // @a: anc-i18n-keyword-impl
      // [on fail] 双词类型归一（英文形态唯一双词——RE_STEP 切成 type='on' attrs='fail',此处合并;
      // 中文 [失败兜底] 单词走别名表）。见 ^anc-step-on-fail。// @a: anc-step-on-fail
      const isOnFail = stepTypeRaw === 'on' && (attrStr ?? '').trim() === 'fail';
      const stepType = isOnFail ? 'on_fail' : (STEP_TYPE_ALIASES[stepTypeRaw] ?? stepTypeRaw);
      const attrs = (attrStr && !isOnFail) ? parseStepAttrs(attrStr) : {};

      if (!ALL_STEP_TYPES.has(stepType as StepType)) {
        errors.push({ kind: 'parse', line: i + 1, message: `Unknown step type: ${stepTypeRaw}` });
      }

      current = {
        step_id: stepId,
        step_type: stepType,
        summary: summaryRaw.trim(),
        attrs,
        inputs: [],
        outputs: [],
        rawOutputs: [],
        instruction: [],
        ...(isHeadingFlavor ? { headingFlavor: true } : {}),
        source_location: { line_start: i + 1, line_end: i + 1 },
      };
      continue;
    }

    if (!current) {
      // 首步之前的非空非注释行（## Steps 与第一个步骤行之间的流浪文字）——同收孤儿
      if (orphans && !orphanStop && !trimmed.startsWith('#')) {
        orphans.push({ line: i + 1, text: trimmed.slice(0, 60), section: 'Steps' });
      }
      continue;
    }

    // 工具授权行: - 工具: 名  # 意图（0054 ^anc-step-tool-grant——先于 RE_LIST_ITEM 族判,
    // 防被复合展开条目收编静默变类型行）。
    // @a: anc-step-tool-grant
    const toolGrantMatch = trimmed.match(RE_TOOL_GRANT);
    if (toolGrantMatch) {
      const raw = toolGrantMatch[1].trim();
      const hashIdx = raw.indexOf('#');
      const namePart = (hashIdx >= 0 ? raw.slice(0, hashIdx) : raw).trim();
      const note = hashIdx >= 0 ? raw.slice(hashIdx + 1).trim() : undefined;
      if (namePart.includes(',') || namePart.includes('，')) {
        errors.push({ kind: 'parse', line: i + 1,
          message: `工具授权行每行恰一个工具名（收到 "${namePart}"）——多工具每个一行,便于逐件写意图注释` });
        continue;
      }
      if (!namePart) {
        errors.push({ kind: 'parse', line: i + 1, message: `工具授权行缺工具名——写 \`- 工具: 名  # 本步用它做什么\` 或 \`- 工具: *\`（全量）` });
        continue;
      }
      const cur = current as FlatStep & { tool_grants?: { name: string; note?: string }[] };
      cur.tool_grants = cur.tool_grants ?? [];
      cur.tool_grants.push({ name: namePart, ...(note ? { note } : {}) });
      continue;
    }

    // 工具禁用行: - 禁工具: 名  # 为什么禁（^anc-step-tool-deny——授权行对称半边,与授权行
    // 同位纪律:先于 RE_LIST_ITEM 族判,防被复合展开条目收编静默变类型行）。
    // @a: anc-step-tool-deny
    const toolDenyMatch = trimmed.match(RE_TOOL_DENY);
    if (toolDenyMatch) {
      const raw = toolDenyMatch[1].trim();
      const hashIdx = raw.indexOf('#');
      const namePart = (hashIdx >= 0 ? raw.slice(0, hashIdx) : raw).trim();
      const note = hashIdx >= 0 ? raw.slice(hashIdx + 1).trim() : undefined;
      if (namePart.includes(',') || namePart.includes('，')) {
        errors.push({ kind: 'parse', line: i + 1,
          message: `工具禁用行每行恰一个工具名（收到 "${namePart}"）——多工具每个一行,便于逐件写原因注释` });
        continue;
      }
      if (namePart === '*') {
        errors.push({ kind: 'parse', line: i + 1,
          message: `工具禁用行不接受 *（全量禁=本步零工具面,真要如此请逐件列名）——防一行废掉整个工具面` });
        continue;
      }
      if (!namePart) {
        errors.push({ kind: 'parse', line: i + 1, message: `工具禁用行缺工具名——写 \`- 禁工具: 名  # 为什么禁\`` });
        continue;
      }
      const cur = current as FlatStep & { tool_denies?: { name: string; note?: string }[] };
      cur.tool_denies = cur.tool_denies ?? [];
      cur.tool_denies.push({ name: namePart, ...(note ? { note } : {}) });
      continue;
    }

    // Input line: - ← var1, var2
    const inputMatch = trimmed.match(RE_INPUT);
    if (inputMatch) {
      current.inputs.push(...parseInputExpr(inputMatch[1].trim()));
      continue;
    }

    // Output line: + → ...
    const outputMatch = trimmed.match(RE_OUTPUT);
    if (outputMatch) {
      const outBody = outputMatch[1].trim();
      // 旧伪输出行文法 `+ → <item> : for-each <list>` 已废除（2026-08-07 重构——元素绑定
      // 伪装成输出声明违反命名忠实）。残留即友好报错指向新文法。// @a: anc-exec-parallel-foreach
      const staleFeInline = outBody.match(/^(.*?)\s*:\s*for-each\s+(\S+)\s*$/);
      if (staleFeInline) {
        errors.push({ kind: 'parse', message:
          `步骤 ${current.step_id}：'+ → item : for-each list' 伪输出行文法已废除——改用步骤头 [loop for-each ${staleFeInline[1].trim().split(':')[0].trim()} in ${staleFeInline[2]}]（元素绑定在步骤头声明，children 同名输出自动收集）`,
          line: i + 1 });
        continue;
      }
      // 复合输出 YAML 展开声明头（概念 ^anc-type-system"复合类型用 YAML 展开"）：
      // `+ → name:  # 说明`（冒号后无类型 token）——变量名剥冒号、type 记 yaml（复合结构
      // 运行值形态）、后续缩进子行是字段说明（进 fields，不注册变量）。原实现把整串
      // "name:" 当变量名，下游 ← name 全 V1 假错（2026-08-09 通读实测，概念示例集体撞上）。
      // 见 design ^anc-rule-compound-output。// @a: anc-rule-compound-output
      const compoundHead = outBody.match(/^(\w+)\s*:\s*(?:#\s*(.*))?$/);
      if (compoundHead) {
        const decl: OutputDecl = {
          name: compoundHead[1],
          type: 'yaml',
          description: compoundHead[2]?.trim() ?? '',
          fields: [],
        };
        current.outputs.push(decl);
        current.rawOutputs.push(outBody);
        pendingCompound = { decl, indent: line.length - line.trimStart().length };
        continue;
      }
      pendingCompound = null;
      current.outputs.push(...parseOutputExpr(outBody,
        msg => errors.push({ kind: 'parse', line: i + 1, message: msg })));   // 初值坏 JSON 响亮（0002）
      current.rawOutputs.push(outBody);
      continue;
    }

    // 复合输出的缩进子行（`- field: type  # 说明`，缩进深于声明头行）→ fields 字段说明
    if (pendingCompound && line.length - line.trimStart().length > pendingCompound.indent) {
      const fieldMatch = trimmed.match(/^-\s*(\w+)\s*:\s*(\S*?)\s*(?:#\s*(.*))?$/);
      if (fieldMatch) {
        pendingCompound.decl.fields!.push({
          name: fieldMatch[1],
          type: fieldMatch[2] ? normalizeTypeToken(fieldMatch[2]) : '',
          description: fieldMatch[3]?.trim() ?? '',
        });
        continue;
      }
    }
    pendingCompound = null;

    // 旧两行式 for-each 已废弃（硬替换）：残留独立 `for-each X → Y` 行 → 友好报错，提示改单行式。
    const staleForEach = trimmed.match(/^for-each\s+(\S+)\s*(?:→|->)\s*(\S+)$/);
    if (staleForEach) {
      errors.push({
        kind: 'parse',
        line: i + 1,
        message: `for-each 已移到步骤头，请写 \`[loop for-each ${staleForEach[2]} in ${staleForEach[1]}]\`（旧的独立 \`for-each X → Y\` 行已废弃）`,
      });
      continue;
    }

    // Instruction line: > text
    const instrMatch = trimmed.match(RE_INSTRUCTION);
    if (instrMatch) {
      current.instruction.push(instrMatch[1]);
      continue;
    }

    // 字母后缀伪步骤行响亮拒（三十审实撞,静默吞家族最痛一例：`5.2b. [act] …` 编号不合文法,
    // 整步连同 ←/→/body 被吸进前一步——body 挂错宿主,前一步被引擎当纯计算直执,真正的 LLM 活
    // 整个跳过且 validate 全绿。步骤形态的行绝不静默吸收。// @a: anc-rule-step-number-dot-optional
    if (/^#*\s*\d[\w]*(?:\.[\w]+)*\.?\s+\[[\w一-鿿]+/.test(trimmed) && !stepBody.match(RE_STEP)) {
      errors.push({ kind: 'parse', line: i + 1, message: `步骤形态的行编号不合文法（"${trimmed.slice(0, 40)}…"）——步骤号只许数字与点（如 5.2.1），字母后缀/其它形态不收；该行不会被静默并入前一步` });
      continue;
    }

    // 末尾兜底：标题风步骤的纯文本行（标题下自然段落）吸收进 instruction，等价内联风 `>` 指令。
    // 见 design ^anc-rule-surface-heading-flavor。// @a: anc-rule-surface-heading-flavor
    if (current.headingFlavor) {
      current.instruction.push(trimmed);
      continue;
    }
    // 内联风孤儿行收集（^anc-rule-decl-zone-warn Steps 扩围,2026-08-30 作者令"这个也修掉"）：
    // 掉到此处=不匹配任何步骤区文法（流浪散文/`+ ->` ASCII 箭头误写等）,原静默丢弃。
    // 豁免纯 # 注释行（Steps 区顶层散文注释是惯用形态——语料 call-parent-summarize 实用）。
    // @a: anc-rule-decl-zone-warn
    if (orphans && !orphanStop && !trimmed.startsWith('#')) {
      orphans.push({ line: i + 1, text: trimmed.slice(0, 60), section: 'Steps' });
    }
  }

  if (current) {
    current.source_location.line_end = sec.endLine;
    flatSteps.push(current);
  }

  // 未闭合围栏响亮拒（^anc-rule-unclosed-fence）——其后步骤已被 fence-skip 静默吞
  if (inFence) {
    errors.push({ kind: 'parse', line: stepFenceOpenLine, message: '围栏未闭合（``` 开于第 ' + stepFenceOpenLine + ' 行）——其后步骤被围栏吞掉,检查产物是否被截断' });
  }

  return buildStepTree(flatSteps, errors);
}

// 属性键词元级归一（完整 token 查 ATTR_ALIASES——子串替换禁用,见 design [[i18n#^anc-i18n-keyword-impl]] 归一纪律）
function normAttrKey(key: string): string {
  return ATTR_ALIASES[key] ?? key;
}

function parseStepAttrs(attrStr: string): Record<string, string | boolean> {
  const attrs: Record<string, string | boolean> = {};
  let rest = attrStr.trim();
  // 中文子句/属性归一为英文规范形（i18n 直通;术语表权威 design/i18n.md ^anc-i18n-glossary）。
  // 归一纪律（design [[i18n#^anc-i18n-keyword-impl]]）：词元级匹配,禁子串替换——变量名含
  // 关键词字串（重试次数/并行度）不得被腐蚀;__cond/__callmap 内部通道是表达式面,不归一。
  // @a: anc-i18n-keyword-impl
  if (!rest.startsWith('__cond=') && !rest.startsWith('__callee=')) {
    rest = rest
      .replace(/遍历\s+(\S+)\s+于\s+([^\s,]+)/g, 'for-each $1 in $2')
      .replace(/收集\s+(\S+?)\s+入\s+([^\s,]+)/g, 'collect $1 into $2')
      .replace(/必须真人确认/g, 'require_human');
    // 属性词归一（重试=2 → retry=2;终检/自适应/并行/上限同表）——词元级:词边界=串端/空白/
    // 逗号/等号,前后邻非标识符字符才算命中（中文无 \b,手工边界）。
    rest = rest.replace(/(^|[\s,])([一-鿿]+)(?==|[\s,]|$)/g, (m, pre, word) =>
      ATTR_ALIASES[word] !== undefined ? `${pre}${ATTR_ALIASES[word]}` : m);
  }
  // for-each 短语先摘（含空格，逐词切分会碎）：`for-each <item> in <list>`
  // → attrs['for-each'] = "<item> in <list>"。见 design/spec-parser.md v0.2.0 文法。// @a: anc-step-parallel
  const fe = rest.match(/for-each\s+(\S+)\s+in\s+([^\s,]+)/);
  if (fe) {
    attrs['for-each'] = `${fe[1]} in ${fe[2]}`;
    rest = (rest.slice(0, fe.index) + rest.slice((fe.index ?? 0) + fe[0].length)).trim();
  }
  // collect 子句（可多个）：`collect <unit> into <list>`——收集端显式声明（2026-08-09）。
  // 摘成分号拼接串存 attrs['collect']，装配处 split。// @a: anc-rule-v10
  const collects: string[] = [];
  let cm;
  while ((cm = rest.match(/collect\s+(\S+?)\s+into\s+([^\s,]+)/))) {
    collects.push(`${cm[1].replace(/,$/, '')} into ${cm[2]}`);
    rest = (rest.slice(0, cm.index) + rest.slice((cm.index ?? 0) + cm[0].length)).trim();
  }
  if (collects.length > 0) attrs['collect'] = collects.join(';');
  // 其余属性：空白分隔；属性间允许逗号风（[loop for-each x in xs, parallel]）——只剥
  // "词边界上的逗号"（前后邻空白/串端），不碰属性值内部逗号（present_inputs=a,b 不能切碎）
  // __cond=... 内部通道（[case(条件)] 平衡扫描的传递位,非公开属性文法）——条件段直取不切分;
  // \u0000 第二段为 ) ] 间属性尾巴（retry/adaptive/parallel）,走通用属性切分（对齐 __callee 通道）
  if (rest.startsWith('__cond=')) {
    const payload = rest.slice('__cond='.length);
    const nul = payload.indexOf('\u0000');
    attrs['__cond'] = nul >= 0 ? payload.slice(0, nul) : payload;   // 条件=表达式面,按作者字面原样保留（不归一）
    const tail = nul >= 0 ? payload.slice(nul + 1).trim() : '';
    for (const part of tail.split(/\s+/).map(t => t.replace(/^,+|,+$/g, '')).filter(Boolean)) {
      const eq = part.indexOf('=');
      // 属性尾巴键词元级归一（[条件(x>0) 重试=2 并行]——键是完整 token,查表安全）// @a: anc-i18n-keyword-impl
      if (eq >= 0) attrs[normAttrKey(part.slice(0, eq))] = part.slice(eq + 1);
      else attrs[normAttrKey(part)] = true;
    }
    return attrs;
  }
  // __callee=<id>\u0000<映射串>[\u0000<属性尾巴>] 内部通道（[call id(...)] 平衡扫描传递位）——
  // \u0000 分隔防映射串撞 =；第三段为 ) 后属性尾巴（如 parallel），走通用属性切分。// @a: anc-step-parallel
  if (rest.startsWith('__callee=')) {
    const payload = rest.slice('__callee='.length);
    const segs = payload.split('\u0000');
    attrs['__callee'] = segs[0];
    attrs['__callmap'] = segs[1] ?? '';   // 映射=变量名面,按作者字面原样保留（不归一）
    const tail = (segs[2] ?? '').trim();
    if (tail) {
      for (const part of tail.split(/\s+/).map(t => t.replace(/^,+|,+$/g, '')).filter(Boolean)) {
        const eq = part.indexOf('=');
        // 属性尾巴键词元级归一（同 __cond 通道）// @a: anc-i18n-keyword-impl
        if (eq >= 0) attrs[normAttrKey(part.slice(0, eq))] = part.slice(eq + 1);
        else attrs[normAttrKey(part)] = true;
      }
    }
    return attrs;
  }
  const parts = rest.split(/\s+/).map(t => t.replace(/^,+|,+$/g, '')).filter(Boolean);
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx >= 0) {
      attrs[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
    } else {
      attrs[part] = true;
    }
  }
  return attrs;
}

function parseInputExpr(text: string): VarBinding[] {
  // 先剥行尾 `# 就近注释`（标题风建议输入加 # 说明，见 design ^anc-rule-surface-heading-flavor）——
  // 引号内 # 不剥（call 旧形态行字面量可含 #,如 `- ← tag: "#1"`——review 实抓盲 indexOf 截断）。
  // @a: anc-rule-surface-heading-flavor
  let hashIdx = -1, q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '#') { hashIdx = i; break; }
  }
  const body = hashIdx >= 0 ? text.slice(0, hashIdx) : text;
  // 支持冒号映射 "target: source"（call 输入映射 子参数: 父变量）；无冒号则 name=source 同名。
  // 逗号切分引号感知（与 __callmap 入口同一 splitMappingSegments——旧形态行字面量含逗号不切碎,
  // review 实抓初版只接了行内入口,TRACEABILITY"双入口"陈述落空）。// @a: anc-step-call-literal
  return splitMappingSegments(body).map(s => s.trim()).filter(Boolean).map(item => {
    const colonIdx = item.indexOf(':');
    if (colonIdx > 0) {
      const name = item.slice(0, colonIdx).trim();
      const source = item.slice(colonIdx + 1).trim();
      return { name, source };
    }
    return { name: item, source: item };
  });
}

/** 解析 `= 初值` 字面量为运行时值：Null/None/null→null；[]→空数组；{}→空对象；true/false→bool；
 * 数字→number；带引号或裸文本→字符串。按字面量形态解析，不依赖声明 type。见 exec-engine
 * ^anc-exec-output-init。 // @a: anc-exec-output-init */
// onError：非空对象/列表字面量 JSON 解析失败的响亮通道（0002——静默存串是"两头都不占":
// 既没支持又没拒绝,运行期 x["k"] 炸"非对象取下标"离病灶隔一层）。// @a: anc-rule-init-value
function parseInitValue(raw: string, onError?: (msg: string) => void): unknown {
  const s = raw.trim();
  if (/^(null|none)$/i.test(s)) return null;
  if (s === '[]') return [];
  if (s === '{}') return {};
  // 非空对象/列表字面量按 JSON 解析（概念层初值条款 2026-08-17 扩——{"committed": 0} 得对象非字符串）
  if (/^[{[]/.test(s)) {
    try { return JSON.parse(s); }
    catch (e) {
      onError?.(`初值 ${s.slice(0, 50)} 形似对象/列表但不是合法 JSON（${e instanceof Error ? e.message.slice(0, 60) : e}）——键与字符串值用双引号,或改在首个步骤里构造`);
      return s;   // 报错后按原样存串（error 已拦执行,此值不会被运行期消费）
    }
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // 带引号字符串剥引号；裸文本原样作字符串
  const q = s.match(/^["'](.*)["']$/);
  return q ? q[1] : s;
}

function parseOutputExpr(text: string, onError?: (msg: string) => void): OutputDecl[] {
  if (text.toLowerCase() === 'none') return [];

  // Single output with type + optional init: "name: type = 初值  # description"
  // 名字符集=Unicode 标识符 Python 3 同款（2026-08-15 作者两轮裁定——原 \w+ 只认 ASCII,
  // 中文名整行跌进裸名分支,'name: type'连型都切不出）。合法性归 V2b（此处只切分,宽一档:
  // 非法名也切出来让 V2b 报准确错,不静默跌裸名分支）。
  const singleMatch = text.match(/^([^\s:=]+)\s*:\s*(\S+(?:\([^)]*\))?\]?)\s*(?:=\s*([^#]*?))?\s*(?:#\s*(.*))?$/u);
  if (singleMatch) {
    const decl: OutputDecl = {
      name: singleMatch[1],
      type: normalizeTypeToken(singleMatch[2]),
      description: singleMatch[4]?.trim() ?? '',
    };
    if (singleMatch[3] !== undefined && singleMatch[3].trim() !== '') {
      decl.default = parseInitValue(singleMatch[3], onError);
    }
    return [decl];
  }

  // Comma-separated names (简写引用，无类型): "var1, var2  # 注释"
  // 先剥离行尾 # 注释——更新模式 `+ → findings  # 更新...` 走此分支，注释不剥离会污染变量名
  const hashIdx = text.indexOf('#');
  const namesPart = hashIdx >= 0 ? text.slice(0, hashIdx) : text;
  // 裸名简写=引用/更新已有变量（更新模式 `+ → acc`），不携带类型主张——type 记空串,
  // V2 的类型一致性判定跳过空型（否则裸名默认 'text' 与首声明如 yaml 撞出假阳性,
  // 2026-08-09 扁平命名空间重构实测）。
  return namesPart.split(',').map(s => s.trim()).filter(Boolean).map(name => ({
    name,
    type: '',
    description: '',
  }));
}

// ===== Tree building =====

function getParentId(stepId: string): string | null {
  const lastDot = stepId.lastIndexOf('.');
  return lastDot >= 0 ? stepId.slice(0, lastDot) : null;
}

function buildStepTree(flatSteps: FlatStep[], errors: ParseError[]): StepNode[] {
  const nodeMap = new Map<string, StepNode>();
  const topLevel: StepNode[] = [];

  // First pass: create all nodes
  for (const flat of flatSteps) {
    const node = flatToStepNode(flat, errors);
    nodeMap.set(flat.step_id, node);
  }

  // Second pass: establish parent-child relationships
  for (const flat of flatSteps) {
    const parentId = getParentId(flat.step_id);
    if (!parentId) {
      topLevel.push(nodeMap.get(flat.step_id)!);
      continue;
    }

    const parent = nodeMap.get(parentId);
    if (!parent) {
      errors.push({
        kind: 'parse',
        line: flat.source_location.line_start,
        message: `Step ${flat.step_id} references non-existent parent ${parentId}`,
      });
      topLevel.push(nodeMap.get(flat.step_id)!);
      continue;
    }

    if (CONTAINER_STEP_TYPES.has(parent.step_type)) {
      const container = parent as { children: StepNode[] };
      if (!container.children) container.children = [];
      container.children.push(nodeMap.get(flat.step_id)!);
    } else {
      errors.push({
        kind: 'parse',
        line: flat.source_location.line_start,
        message: `Step ${flat.step_id} is nested under non-container step ${parentId} (type: ${parent.step_type})`,
      });
    }
  }

  return topLevel;
}

const MODEL_RE = /^@model\s+(\S+)$/;
// @thinking 步骤标注（0100,^anc-exec-thinking-step-annotation——B 案独立标注不与 @model 耦合;
// off/on 两值,其它值响亮拒不静默）// @a: anc-exec-thinking-step-annotation
const THINKING_RE = /^@thinking\s+(\S+)$/;
const SRC_RE = /^@src\s+(.+)$/;   // 源锚点——出处记法自由(段落号/短引文/章节名),整行余下全收 // @a: anc-step-src-annotation

function extractModelAnnotation(lines: string[]): { instruction: string[]; model_override?: string; src_ref?: string; thinking_override?: 'on' | 'off'; thinking_bad_value?: string } {
  let model_override: string | undefined;
  let src_ref: string | undefined;
  let thinking_override: 'on' | 'off' | undefined;
  let thinking_bad_value: string | undefined;
  const filtered: string[] = [];
  for (const line of lines) {
    const m = MODEL_RE.exec(line.trim());
    const s = SRC_RE.exec(line.trim());
    const th = THINKING_RE.exec(line.trim());
    if (m) {
      model_override = m[1];
    } else if (th) {
      // @thinking 同通道剥出不进执行 prompt;off/on 之外的值经 thinking_bad_value 带出,
      // 调用点落 errors 响亮拒（静默失效是 0008③ 同病;本函数无 errors 通道,不在此抛）
      if (th[1] === 'on' || th[1] === 'off') thinking_override = th[1];
      else thinking_bad_value = th[1];
    } else if (s) {
      src_ref = s[1].trim();   // 剥出不进 instruction=不进执行 prompt（零执行语义,概念 ^anc-step-src-annotation）
    } else {
      filtered.push(line);
    }
  }
  return { instruction: filtered, model_override, src_ref, thinking_override, thinking_bad_value };
}

/** 取布尔修饰属性（true / 'true' 都算真）。adaptive/finally/require_human 共用，消 5 处复制。 */
function boolAttr(attrs: Record<string, string | boolean>, key: string): boolean {
  const v = attrs[key];
  return v === true || v === 'true';
}

/** 解析 subtask/case 共有的 retry/adaptive 修饰符（两分支原逐字复制）。 */
function parseRetryAdaptive(attrs: Record<string, string | boolean>): { retry?: number; adaptive: boolean } {
  return {
    retry: attrs['retry'] ? Number(attrs['retry']) : undefined,
    adaptive: boolAttr(attrs, 'adaptive'),
  };
}

// 属性总闸（2026-08-13 作者定,概念 ^anc-step-parallel;实撞:[case parallel] 静默吞且旧形态下被
// 解析成 default 统配——分支语义被无声改写;[reason retry=2]/[act parallel] 全族同病,P9 因
// parser 先丢属性成死代码）：每类步骤声明自己消费的属性键,解析收尾剩余未消费键一律 parse error。
// 内部通道键（__cond/__callee/__callmap）与结构键（for-each/collect/max）随各类型消费面登记;
// call 的无括号裸 callee 键在其分支内已消费,总闸对 call 只查已知属性错位。// @a: anc-rule-attr-gate
const CONSUMED_ATTRS: Record<string, ReadonlySet<string>> = {
  subtask: new Set(['retry', 'adaptive', 'parallel', 'free']),
  case: new Set(['retry', 'adaptive', 'parallel', '__cond']),
  call: new Set(['parallel', '__callee', '__callmap']),   // 无括号裸 callee 键在 checkAttrGate 内放行
  loop: new Set(['max', 'max_iterations', 'for-each', 'collect', 'parallel']),   // loop 头 parallel 已有专项报错,不落总闸重复报
  check: new Set(['final', 'finally', 'escalatable']),
  confirm: new Set(['require_human']),
  ask: new Set(['require_human', 'present_inputs']),
  reason: new Set([]), act: new Set(['free']), commit: new Set([]),
  branch: new Set([]), exit: new Set([]),
  // break/continue 消费可选目标步骤号（[break 5.2]——裸 `数字(.数字)*` 键,checkAttrGate 放行,flatToStepNode 入 target_loop;与 HopSop 流控目标对偶）// @a: anc-step-break, anc-step-continue
  break: new Set([]), continue: new Set([]),
};
// 已知属性全集——call 分支把非属性裸键当 callee id 消费,总闸只拦"known 属性用错宿主"
const KNOWN_ATTRS = new Set(['retry', 'adaptive', 'parallel', 'max', 'max_iterations', 'for-each', 'collect', 'final', 'finally', 'require_human', 'present_inputs', 'free', 'escalatable']);
const ATTR_HOST_HINT: Record<string, string> = {
  parallel: 'subtask/call/case', retry: 'subtask/case', adaptive: 'subtask/case',
  max: 'loop', max_iterations: 'loop', 'for-each': 'loop', collect: 'loop',
  final: 'check', finally: 'check', require_human: 'confirm/ask', present_inputs: 'ask',
  free: 'act/subtask',   // 两宿主（2026-08-27 subtask free 批——原单写 act 报文教错半边）
};

function checkAttrGate(flat: FlatStep, errors: ParseError[]): void {
  // 工具授权条目仅 act 步合法（0054 ^anc-step-tool-grant——其余类型报错指路,防静默无效声明）
  // 工具授权宿主扩员 reason（^anc-step-tool-grant 2026-09-01 作者拍"等同于 act 的能力,
  // 不能 commit 写"——standalone reason 消费声明;check 维持无工具面判官纯判定）。
  // @a: anc-exec-reason-tools
  const tg = (flat as FlatStep & { tool_grants?: unknown[] }).tool_grants;
  if (tg?.length && flat.step_type !== 'act' && flat.step_type !== 'reason') {
    errors.push({ kind: 'parse', line: flat.source_location?.line_start ?? 0,
      message: `步骤 "${flat.step_id}" [${flat.step_type}] 带工具授权行（- 工具:）——该条目仅 act/reason 步骤可用（check 无工具面判官纯判定;带 body 的 act 工具走白名单通道声明可省）` });
  }
  // 工具禁用条目同闸（^anc-step-tool-deny——消费面与授权行同族:仅 act/reason;
  // 同名既授又禁=笔误或想不清,写时红点名,不做运行期静默偏一边）。// @a: anc-step-tool-deny
  const td = (flat as FlatStep & { tool_denies?: { name: string }[] }).tool_denies;
  if (td?.length && flat.step_type !== 'act' && flat.step_type !== 'reason') {
    errors.push({ kind: 'parse', line: flat.source_location?.line_start ?? 0,
      message: `步骤 "${flat.step_id}" [${flat.step_type}] 带工具禁用行（- 禁工具:）——该条目仅 act/reason 步骤可用` });
  }
  if (td?.length && (tg as { name: string }[] | undefined)?.length) {
    const grantNames = new Set((tg as { name: string }[]).map(g => g.name));
    for (const d of td) {
      if (grantNames.has(d.name)) {
        errors.push({ kind: 'parse', line: flat.source_location?.line_start ?? 0,
          message: `步骤 "${flat.step_id}" 工具 "${d.name}" 同时出现在授权行与禁用行——冲突即笔误,请删其一` });
      }
    }
  }

  const consumed = CONSUMED_ATTRS[flat.step_type];
  if (!consumed) return;   // 未知类型归 S4
  for (const key of Object.keys(flat.attrs)) {
    if (consumed.has(key)) continue;
    // break/continue 的裸步骤号目标（[break 5.2]）——形如 数字(.数字)* 的裸键放行,flatToStepNode 消费入 target_loop
    if ((flat.step_type === 'break' || flat.step_type === 'continue')
      && flat.attrs[key] === true && /^\d+(?:\.\d+)*$/.test(key)) continue;
    if (flat.step_type === 'call') {
      // call：__callee/__callmap 通道键 + 无括号裸 callee 键(非 known 属性)都合法
      if (key === '__callee' || key === '__callmap' || key === 'parallel') continue;
      if (!KNOWN_ATTRS.has(key)) continue;   // 裸 callee id
    } else if (!KNOWN_ATTRS.has(key)) {
      // 未知词(如 [subtask bogus])——同报:不存在的属性比错位属性更该拦
      errors.push({ kind: 'parse', line: flat.source_location?.line_start ?? 0,
        message: `步骤 "${flat.step_id}" [${flat.step_type}] 带未知属性 "${key}"——不是任何步骤类型的合法属性（属性总闸:未消费属性即错,不静默丢弃）`
          // collect 子句带类型标注是高频误写形（四十四审重档实录:flash 反复写 `collect result into results: [yaml]`,
          // ': [yaml]' 被切成未知属性,原报文不指路正解——报错指路必须给存在的替代（append 文案先例）
          + (flat.step_type === 'loop' && (key.startsWith('[') || key.startsWith(':') || /^ya?ml/.test(key))
            ? `。若本意是 collect 子句:into 后只写列表变量名（\`collect result into results\`）,类型声明归循环头 \`+ → results: [T]\` 行,不写进子句` : '') });
      continue;
    }
    if (KNOWN_ATTRS.has(key) && !consumed.has(key)) {
      errors.push({ kind: 'parse', line: flat.source_location?.line_start ?? 0,
        message: `步骤 "${flat.step_id}" [${flat.step_type}] 不消费属性 "${key}"——该属性仅适用于 ${ATTR_HOST_HINT[key] ?? '其他步骤类型'}（属性总闸:错位属性即错,不静默丢弃）` });
    }
  }
}

function flatToStepNode(flat: FlatStep, errors: ParseError[]): StepNode {
  checkAttrGate(flat, errors);
  const { instruction: rawInstruction, model_override, src_ref, thinking_override, thinking_bad_value } = extractModelAnnotation(flat.instruction);
  if (thinking_bad_value !== undefined) {
    errors.push({ kind: 'parse', line: flat.source_location?.line_start ?? 0, message: `步骤 "${flat.step_id}" 的 @thinking 值 '${thinking_bad_value}' 非法——只收 on | off` });
  }
  const instructionText = rawInstruction.length > 0 ? rawInstruction.join('\n') : undefined;
  const docRefs = instructionText ? extractDocRefs(instructionText) : []; // @a: anc-rule-doc-ref-extract
  const base = {
    step_id: flat.step_id,
    step_type: flat.step_type as StepType,
    summary: flat.summary,
    inputs: flat.inputs.length > 0 ? flat.inputs : undefined,
    outputs: flat.outputs.length > 0 ? flat.outputs : undefined,
    instruction: instructionText,
    ...(docRefs.length > 0 ? { doc_refs: docRefs } : {}),
    ...(model_override ? { model_override } : {}),
    ...(thinking_override ? { thinking_override } : {}),
    ...(src_ref ? { src_ref } : {}),
    source_location: flat.source_location,
  };

  switch (flat.step_type) {
    case 'subtask': {
      const { retry, adaptive } = parseRetryAdaptive(flat.attrs);
      const parallel = boolAttr(flat.attrs, 'parallel');   // callee 并发申报（统一模型：异步派发、容器边界收齐）// @a: anc-step-parallel
      const free = boolAttr(flat.attrs, 'free');   // 到步展开档（^anc-step-subtask-free——children 可空,S5 豁免归 validator）// @a: anc-step-subtask-free
      return { ...base, step_type: 'subtask', retry, adaptive, ...(parallel ? { parallel } : {}), ...(free ? { free: true } : {}), children: [] } as SubtaskStep;
    }
    // 'parallel' 步骤类型已退役（2026-08-07 重构）——S4 将its报为非法类型；
    // 静态并行=subtask parallel，动态并行=loop for-each + parallel
    case 'branch':
      return { ...base, children: [] } as StepNode;

    case 'break': case 'continue': {
      // 可选目标步骤号（[break 5.2]）：attrs 里恰形如 数字(.数字)* 的裸键（checkAttrGate 已放行同形键）
      // 多个目标号=写法错误——报错不静默取首（属性总闸精神:不确定语义不猜）// @a: anc-step-break, anc-step-continue
      const targets = Object.keys(flat.attrs).filter(k => flat.attrs[k] === true && /^\d+(?:\.\d+)*$/.test(k));
      if (targets.length > 1) {
        errors.push({ kind: 'parse', line: flat.source_location?.line_start ?? 0,
          message: `步骤 "${flat.step_id}" [${flat.step_type}] 带多个目标步骤号（${targets.join(', ')}）——目标至多一个` });
      }
      return { ...base, ...(targets.length === 1 ? { target_loop: targets[0] } : {}) } as StepNode;
    }

    case 'loop': {
      // max=N 标准写法(2026-08-09 认知三改);max_iterations=N 过渡期兼容读,将废止
      const maxAttr = flat.attrs['max'] ?? flat.attrs['max_iterations'];
      const maxIter = maxAttr ? Number(maxAttr) : undefined;
      // loop 头 parallel 已废除（2026-08-11 统一模型 P0.5，概念 ^anc-step-parallel）：并发是
      // 体内步骤的性质——报错并给迁移提示，不静默忽略（矩阵行 8）。// @a: anc-step-parallel
      if (boolAttr(flat.attrs, 'parallel')) {
        errors.push({
          kind: 'parse',
          line: flat.source_location.line_start,
          message: `loop "${flat.step_id}" 头部 parallel 属性已废除（统一模型）——并发申报落在体内步骤：把循环体包为 [subtask parallel]（或体内 [call ... parallel]），循环头去掉 parallel`,
        });
      }
      // for-each 遍历形态（v0.2.0 自原 parallel 类型迁入）：`[loop for-each <item> in <list>]`
      let forEach: { listVar: string; itemVar: string } | undefined;
      const feAttr = flat.attrs['for-each'];
      if (typeof feAttr === 'string') {
        const m = feAttr.match(/^(\S+)\s+in\s+(\S+)$/);
        if (m) forEach = { itemVar: m[1], listVar: m[2] };
      }
      // for-each 的 listVar 消费边由子句自动合成入 inputs（V9 翻转，2026-08-07 作者拍板
      // "头部子句即声明"）——V1/S12 从变量流图照常看到该边，作者不必也不应重复写 ← 行。
      // @a: anc-rule-v9
      let loopInputs = base.inputs;
      if (forEach && !(loopInputs ?? []).some(b => b.source === forEach!.listVar)) {
        loopInputs = [...(loopInputs ?? []), { name: forEach.listVar, source: forEach.listVar, synthesized: true }];
      }
      // collect 子句装配：`collect <unit> into <list>`（attrs 已摘为分号串）。// @a: anc-rule-v10
      let collect: { unitVar: string; listVar: string }[] | undefined;
      const colAttr = flat.attrs['collect'];
      if (typeof colAttr === 'string') {
        collect = colAttr.split(';').map(seg => {
          const m = seg.match(/^(\S+)\s+into\s+(\S+)$/);
          return m ? { unitVar: m[1], listVar: m[2] } : null;
        }).filter((x): x is { unitVar: string; listVar: string } => x !== null);
        if (collect.length === 0) collect = undefined;
      }
      return { ...base, inputs: loopInputs, step_type: 'loop', max_iterations: maxIter,
        ...(forEach ? { forEach } : {}), ...(collect ? { collect } : {}), children: [] } as LoopStep;
    }
    case 'case': {
      // case 条件（见 design ^anc-rule-case-condition）：结构化逻辑标准写法 [case(条件)] 描述——机读入 []
      // （2026-08-09 作者定,与 loop 属性同构）;旧 [case] 描述 (条件) 兼容读。两路径归一:
      // summary=纯人读描述,condition=条件——serializer 统一写新结构化逻辑标准写法。
      // @a: anc-rule-case-condition
      let condition: string;
      let summary = flat.summary;
      const condAttr = flat.attrs['__cond'];
      if (typeof condAttr === 'string') {
        // 统配 [case(else)] 标准写法（2026-08-09 认知三改,作者定"直接改"——旧统配 [case(...)] 不留兼容:
        // '...' 不再归一,落到条件表达式解析即 C8 报错,提示改写 else）。空串/default 同废——
        // 'default' 恰与内部统配标记同拼写,放行即静默复活旧写法,须显式拒。
        const ct = condAttr.trim();
        if (/^default$/i.test(ct)) {
          errors.push({ kind: 'parse', line: flat.source_location?.line_start ?? 0,
            message: `Case "${flat.step_id}" 统配写法 [case(default)] 已废止——改写 [case(else)]` });
        }
        // [case()] 空串同废（设计明文;2026-08-30 审计实抓放行——引擎 isDefault 认空串=事实第二 default,
        // 放中间静默吞其后全部 case,C8 又只认 'default' 字面拦不住）。// @a: anc-rule-case-condition
        if (ct === '') {
          errors.push({ kind: 'parse', line: flat.source_location?.line_start ?? 0,
            message: `Case "${flat.step_id}" 统配写法 [case()] 空条件已废止——统配改写 [case(else)],无条件兜底用裸 [case]` });
        }
        // 中文统配别名 其他（i18n 术语表 2026-08-15 第五轮,与 HopSop [条件(其他)] 对齐——design/i18n.md ^anc-i18n-glossary）与 else 恒等价
        condition = (/^else$/i.test(ct) || ct === '其他') ? 'default' : ct;
      } else {
        condition = extractCaseCondition(flat.summary);
        // 旧形态 summary 剥条件尾括号（归一到"summary=纯描述"）;纯条件写法剥后为空
        if (condition !== 'default' && summary.endsWith(')')) {
          const idx = summary.lastIndexOf('(');
          if (idx >= 0 && summary.slice(idx + 1, -1).trim() === condition) summary = summary.slice(0, idx).trim();
        } else if (summary.trim() === condition) {
          summary = '';
        }
      }
      const { retry: caseRetry, adaptive: caseAdaptive } = parseRetryAdaptive(flat.attrs);
      // case 就是 branch 下的 subtask——parallel 宿主三型之一（2026-08-13 作者定）// @a: anc-step-parallel
      const caseParallel = boolAttr(flat.attrs, 'parallel');
      return { ...base, summary, step_type: 'case', condition, retry: caseRetry, adaptive: caseAdaptive, ...(caseParallel ? { parallel: true } : {}), children: [] } as CaseStep;
    }
    case 'call': {
      // 三形态归一（结构化逻辑标准写法 2026-08-09,见 ^anc-rule-call-orthography）:
      // ① 结构化逻辑标准写法带映射 [call id(a: b, c)] 描述——__callee/__callmap 通道;
      // ② 结构化逻辑标准写法无输入 [call id] 描述——RE_STEP 常规命中,attrs 里 id 是裸布尔键;
      // ③ 旧形态 [call] id : 描述 + - ← 映射行——兼容读。
      let callee_spec_id: string | undefined;
      let callee_expr: ActExpr | undefined;
      let callee_expr_src: string | undefined;
      let summary = flat.summary;
      let param_mapping: ParamMapping[] | undefined;
      const calleeAttr = flat.attrs['__callee'];
      if (typeof calleeAttr === 'string') {
        // ① 结构化逻辑标准写法:映射串逐项解析 `to: from` / 裸名同名简写。
        // callee 位插值形态（^anc-step-call-dynamic-callee）：__callee 值 `{表达式}` 开头即
        // 插值——表达式经 parseExpression（f-string 同一解析器,能力面全集）解析成 ActExpr
        // 存 callee_expr,原文存 callee_expr_src（serializer 往返回写）;解析失败写时 error 教形态。
        // @a: anc-step-call-dynamic-callee
        if (calleeAttr.startsWith('{') && calleeAttr.endsWith('}')) {
          const exprSrc = calleeAttr.slice(1, -1).trim();
          const exprErrs: ParseError[] = [];
          const parsed = exprSrc ? parseExpression(exprSrc, exprErrs) : null;
          if (!parsed) {
            errors.push({ kind: 'parse', line: flat.source_location.line_start, message: `call callee 位插值表达式非法——{} 内写变量或字段取（如 {issue.analyzer_spec}）: {${exprSrc}}${exprErrs.length ? `（${exprErrs.map(e => e.message).join('; ')}）` : ''}` });
          } else {
            callee_expr = parsed;
            callee_expr_src = exprSrc;
          }
        } else {
          callee_spec_id = calleeAttr;
        }
        const mapStr = String(flat.attrs['__callmap'] ?? '').trim();
        if (mapStr) {
          // 引号感知切分+字面量判定（2026-08-27 0044——`split_kind: "seq"` 的 "seq" 落 literal_value）// @a: anc-step-call-literal
          param_mapping = splitMappingSegments(mapStr).map(seg => {
            const s = seg.trim();
            const ci = s.indexOf(':');
            if (ci >= 0) return paramMappingEntry(s.slice(0, ci).trim(), s.slice(ci + 1).trim());
            return { from: s, to: s };   // 同名省略:裸名 (doc) ≡ (doc: doc)——裸名恒变量,不过字面量判定
          }).filter(m => m.to.length > 0);
          if (param_mapping.length === 0) param_mapping = undefined;
        }
        // 结构化逻辑标准写法下若还写了 - ← 映射行:并入(结构化逻辑标准写法括号优先,行补充——过渡期双写不冲突)
        const rowMapping = buildParamMapping(flat.inputs);
        if (rowMapping) param_mapping = [...(param_mapping ?? []), ...rowMapping];
      } else {
        // ② 无输入结构化逻辑标准写法:[call id] → attrs 恰一个裸布尔键(排除已知属性名)
        const bareKeys = Object.keys(flat.attrs).filter(k => flat.attrs[k] === true && !['parallel', 'adaptive', 'finally', 'final'].includes(k));
        if (bareKeys.length === 1 && !flat.summary.includes(' : ')) {
          callee_spec_id = bareKeys[0];
        } else {
          // ③ 旧形态:summary 内 `id : 描述`
          const colonIdx = summary.indexOf(' : ');
          if (colonIdx >= 0) {
            callee_spec_id = summary.slice(0, colonIdx).trim();
            summary = summary.slice(colonIdx + 3).trim();
          }
        }
        param_mapping = buildParamMapping(flat.inputs);
      }
      const output_mapping = buildOutputMapping(flat.rawOutputs);
      // parallel 标注（callee 并发申报转述，异步派发）：标准写法经 __callee 属性尾巴、
      // 无括号形态 [call id parallel] 经常规属性通道，两路都落 flat.attrs。// @a: anc-step-parallel
      const callParallel = boolAttr(flat.attrs, 'parallel');
      // call 的 - ←/+ → 是双向映射，不是 VarBinding/OutputDecl——清除 base.inputs/outputs 避免 V4 把映射当类型校验
      return { ...base, step_type: 'call', summary, inputs: undefined, outputs: undefined, callee_spec_id, ...(callee_expr ? { callee_expr, callee_expr_src } : {}), param_mapping, output_mapping, ...(callParallel ? { parallel: true } : {}) } as CallStep;
    }
    case 'act': {
      const { body, instruction } = parseActBodyFromFlat(flat, errors);
      // [act free] 自由任务档（概念 ^anc-step-act free 条款;与 body 互斥归 B7 校验）// @a: anc-rule-b7
      const free = boolAttr(flat.attrs, 'free');
      const grants = (flat as FlatStep & { tool_grants?: { name: string; note?: string }[] }).tool_grants;
      // 工具授权 act/reason 消费(概念 ^anc-step-tool-grant,reason 扩员 2026-09-01);带 body 时
      // 声明冗余但不拒——静态白名单通道另行推导,声明当作者意图注记保留。
      // @a: anc-step-tool-grant
      // 工具禁用同批落地（^anc-step-tool-deny）。// @a: anc-step-tool-deny
      const denies = (flat as FlatStep & { tool_denies?: { name: string; note?: string }[] }).tool_denies;
      return { ...base, step_type: 'act', instruction, ...(body ? { body } : {}), ...(free ? { free: true } : {}), ...(grants?.length ? { tool_grants: grants } : {}), ...(denies?.length ? { tool_denies: denies } : {}) } as ActStep;
    }
    case 'commit': {
      const { body, instruction } = parseActBodyFromFlat(flat, errors);
      const irreversible_action = instruction || flat.summary;
      return { ...base, step_type: 'commit', irreversible_action, instruction, ...(body ? { body } : {}) } as CommitStep;
    }
    case 'check': {
      // final 标准写法(2026-08-09 认知三改);finally 过渡期兼容读,将废止
      const is_finally = boolAttr(flat.attrs, 'final') || boolAttr(flat.attrs, 'finally');
      const escalatable = boolAttr(flat.attrs, 'escalatable');   // @a: anc-exec-check-escalate
      // 纯机械判定 body（2026-08-19 作者拍板 A,概念 ^anc-step-check-body）——与 act 同解析;
      // 原静默面收口:此前围栏滑进 instruction 变提示词。// @a: anc-step-check-body
      const { body, instruction } = parseActBodyFromFlat(flat, errors);
      return { ...base, step_type: 'check', instruction, ...(is_finally ? { is_finally: true } : {}), ...(escalatable ? { escalatable: true } : {}), ...(body ? { body } : {}) } as CheckStep;
    }
    case 'confirm': {
      const require_human = boolAttr(flat.attrs, 'require_human');
      return { ...base, step_type: 'confirm', ...(require_human ? { require_human: true } : {}) } as ConfirmStep;
    }
    case 'ask': { // @a: anc-step-ask
      const require_human = boolAttr(flat.attrs, 'require_human');
      // present_inputs: 逗号分隔的变量名列表,如 [ask present_inputs=raw_outline,other]。
      // 见 design/spec-parser.md ^anc-rule-p14。// @a: anc-rule-p14
      const piRaw = flat.attrs['present_inputs'];
      const present_inputs = typeof piRaw === 'string' && piRaw.length > 0
        ? piRaw.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      return { ...base, step_type: 'ask',
        ...(require_human ? { require_human: true } : {}),
        ...(present_inputs ? { present_inputs } : {}),
      } as AskStep;
    }
    case 'reason': {
      // 工具授权随节点落 AST（^anc-step-tool-grant reason 扩员——standalone reason 消费,
      // 复用模式 caller 自带工具面声明当意图注记）。// @a: anc-exec-reason-tools
      const grants = (flat as FlatStep & { tool_grants?: { name: string; note?: string }[] }).tool_grants;
      // 工具禁用同形并排（^anc-step-tool-deny）。// @a: anc-step-tool-deny
      const denies = (flat as FlatStep & { tool_denies?: { name: string; note?: string }[] }).tool_denies;
      return { ...base, step_type: 'reason', ...(grants?.length ? { tool_grants: grants } : {}), ...(denies?.length ? { tool_denies: denies } : {}) } as StepNode;
    }
    case 'exit': {
      return { ...base, step_type: 'exit' } as ExitStep;
    }
    case 'on_fail': {   // 失败兜底块（^anc-step-on-fail）// @a: anc-step-on-fail
      return { ...base, step_type: 'on_fail', children: [] } as import('./ast-types.js').OnFailStep;
    }
    default:
      return base as StepNode;
  }
}

// act/commit：从 instruction 行提取 ```hop_python 围栏 body，剩余自然语言行（去 @model）作 instruction。
function parseActBodyFromFlat(flat: FlatStep, errors: ParseError[]): { body?: ActBody; instruction?: string } {
  const { bodyLines, bodyStartIndex, narrative, unclosed } = extractHopPythonFence(flat.instruction);
  // 指令级围栏未闭合响亮拒（^anc-rule-unclosed-fence 同族——文档级已拒,指令级原静默接受:
  // 闭栏行删掉 body 照样提取,产物截断不可见）// @a: anc-rule-unclosed-fence
  if (unclosed) {
    errors.push({ kind: 'parse', line: (flat.source_location?.line_start ?? 0) + bodyStartIndex - 1,
      message: '步骤 ' + flat.step_id + ' 的 hop_python 围栏未闭合（```hop_python 开了没关）——补 "> ```" 闭栏行,检查产物是否被截断' });
  }
  const { instruction: narrativeNoModel } = extractModelAnnotation(narrative);
  const instruction = narrativeNoModel.length > 0 ? narrativeNoModel.join('\n') : undefined;
  if (!bodyLines) return { instruction };
  // 围栏行在原文的绝对行号：步骤起始 + body 在 instruction 中的偏移（近似，错误定位用）
  const baseLine = (flat.source_location?.line_start ?? 0) + bodyStartIndex;
  const body = parseActBody(bodyLines, baseLine, errors) ?? undefined;
  return { body, instruction };
}

function buildParamMapping(inputs: VarBinding[]): ParamMapping[] | undefined { // @a: anc-step-call
  if (inputs.length === 0) return undefined;
  // 输入映射：from=来源(父变量=source), to=目标(子 Input 名=name)
  return inputs.map(b => paramMappingEntry(b.name, b.source));
}

// param_mapping 值位字面量判定（2026-08-27 hopissues/0044,概念 ^anc-step-call 字面量条款）：
// 判定面=封闭枚举：同型引号成对字符串/数字/true/false/null（严格小写）——命中项的值解析
// 复用 parseInitValue 单点。枚举外裸词恒为变量名（`True`/`None` 也是裸词——review 实抓初版
// /i 宽容:isLiteralForm 认 True 而 parseInitValue 只认小写跌字符串分支,literal_value 得
// 字符串 "True",静默转字符串正是本条款明令禁止的病形）。// @a: anc-step-call-literal
function paramMappingEntry(to: string, fromRaw: string): ParamMapping {
  const s = fromRaw.trim();
  const isLiteralForm = /^(".*"|'.*')$/.test(s) || /^-?\d+(\.\d+)?$/.test(s) || /^(true|false|null)$/.test(s);
  if (isLiteralForm) return { from: fromRaw, to, literal_value: parseInitValue(s) };
  return { from: fromRaw, to };
}

// 顶层逗号切分（引号内逗号不切——`mode: "a,b"` 是一项字面量,盲 split 会切碎）。
// @a: anc-step-call-literal
function splitMappingSegments(mapStr: string): string[] {
  const segs: string[] = [];
  let cur = '', quote: string | null = null;
  for (const ch of mapStr) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ',') { segs.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) segs.push(cur);
  return segs;
}

// case 条件提取（见 design/spec-parser.md ^anc-rule-case-condition）。
// 仅行尾最后一对半角括号 (...) 内是机器求值的 condition；括号前文字为人读描述、丢弃。
// 无尾括号则整行作 condition（兼容 `[case] severity == 'fatal'` 纯条件写法）。
// 结果为空或 'default' → 'default'（默认 case，与 engine-traverse 的 isDefault 判定对齐）。
// 取**最后一对**括号而非首个，避免描述里的括号（如全角「（含未知）」+ 半角条件）误截。
// @a: anc-rule-case-condition
function extractCaseCondition(summary: string | undefined): string {
  const s = (summary ?? '').trim();
  if (!s) return 'default';
  // 裸 [case] + 无括号文本的消歧（2026-08-09 结构化逻辑标准写法改版配套）：整行当条件仅当它像表达式
  // （含比较/逻辑运算符特征——兼容旧"[case] severity == 'fatal'"纯条件写法）；否则是纯人读
  // 描述 = default 兜底（`[case] 兜底`）。新结构化逻辑标准写法 [case(条件)] 不经此路径,无歧义。
  if (!s.endsWith(')') && !/[=<>!{]|\b(and|or|not)\b/.test(s) && !/^[a-z_][a-z0-9_]*$/.test(s)) return 'default';
  // 尾部最后一个**平衡**括号组（条件升表达式后可含嵌套括号:`(not (x <= 0))`,
  // 旧正则 [^()]* 不认嵌套——2026-08-09 实测撞出）。从尾扫平衡配对。
  let raw = s;
  if (s.endsWith(')')) {
    let depth = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] === ')') depth++;
      else if (s[i] === '(') {
        depth--;
        if (depth === 0) { raw = s.slice(i + 1, s.length - 1); break; }
      }
    }
  }
  raw = raw.trim();
  if (!raw || raw.toLowerCase() === 'default') return 'default';
  return raw;
}

// call 输出映射：+ → parent_var: callee_output（目标父变量: 来源子输出）。同名省略。
function buildOutputMapping(rawOutputs: string[]): ParamMapping[] | undefined {
  // 先剥 # 注释再按逗号切（三十三审实撞:原先切后剥——注释里的半角逗号把注释尾巴切成幽灵映射,
  // '零占位残留）'成 from/to,运行期 CALL_OUTPUT_MISSING 响亮但病灶离源头一步）。// @a: anc-step-call
  const items = rawOutputs.flatMap(raw => raw.split('#')[0].split(',').map(s => s.trim()).filter(Boolean));
  if (items.length === 0) return undefined;
  if (items.length === 1 && items[0].toLowerCase() === 'none') return undefined;
  return items.map(item => {
    const noComment = item;
    const colonIdx = noComment.indexOf(':');
    if (colonIdx > 0) {
      const to = noComment.slice(0, colonIdx).trim();       // 父变量（目标）
      const from = noComment.slice(colonIdx + 1).trim();    // 子输出（来源）
      return { from, to };
    }
    return { from: noComment, to: noComment };  // 同名
  });
}

// ===== Depth check =====

function getMaxNesting(steps: StepNode[]): number {
  let max = 0;
  for (const step of steps) {
    const depth = step.step_id.split('.').length;
    if (depth > max) max = depth;
    if ('children' in step && Array.isArray((step as SubtaskStep).children)) {
      const childMax = getMaxNesting((step as SubtaskStep).children);
      if (childMax > max) max = childMax;
    }
  }
  return max;
}

// ===== Main export =====

/** 片段编号归一（parse 前预处理,replan 提交两入口共用——standalone 管线+CLI --replan;
 * P2-2 裁定 A 两模式同一宽容度）：LLM 沿用原步骤号的自然形态（replace 1.1 就写 1.1.）规整为
 * 顶层连号;子行（缩进与零缩进两形态）按"父前缀已在场"判子随父整树改写,树关系保持;父不在场
 * 的缩进行原样保留交 parse 报错（不猜不吞）;已连号输入幂等。机械文本变换零 LLM。
 * 见 [[step-dispatcher#^anc-exec-adaptive-pipeline]] 归一附则。 // @a: anc-rule-fragment-mode */
export function flattenFragmentNumbering(md: string): string {
  let n = 0;
  let inFence = false;   // 围栏感知（P2-4）：围栏内行跳过不改不计数——形似编号的注释/素材行不受染
  const idMap = new Map<string, string>();   // 旧号→新号（含改写过的每一级,深嵌套逐级查父）
  return md.split('\n').map(line => {
    if (RE_FENCE.test(line.trim())) { inFence = !inFence; return line; }
    if (inFence) return line;
    const m = /^(\s*)(\d+(?:\.\d+)*)\. (.*)$/.exec(line);
    if (!m) return line;
    const [, indent, oldId, rest] = m;
    const lastDot = oldId.lastIndexOf('.');
    const parentOld = lastDot >= 0 ? oldId.slice(0, lastDot) : null;
    let newId: string;
    if (parentOld !== null && idMap.has(parentOld)) {
      newId = `${idMap.get(parentOld)!}${oldId.slice(lastDot)}`;   // 子随父,末段保留
    } else if (indent === '') {
      n += 1;
      newId = String(n);                                           // 顶层分配连号
    } else {
      return line;                                                 // 缩进行父不在场:原样交 parse 报错
    }
    idMap.set(oldId, newId);
    return `${indent}${newId}. ${rest}`;
  }).join('\n');
}

/** 片段原生解析：裸步骤序列（无 # 标题/## Steps 节头）直接过全套步骤文法——
 * hopbuild 单轮核查用。不经拼头,报错行号=片段文件真实行。头部字段全空,
 * 完备性规则由 validateSpec options.fragment 豁免。见 [[spec-parser#^anc-rule-fragment-mode]] */

export function parseFragment(markdown: string): { ast: SpecAST; errors: ParseError[] } { // @a: anc-rule-fragment-mode
  const errors: ParseError[] = [];
  if (new TextEncoder().encode(markdown).length > MAX_INPUT_SIZE) {
    errors.push({ kind: 'parse', line: 0, message: `Input exceeds ${MAX_INPUT_SIZE / 1024}KB limit (actual: ${new TextEncoder().encode(markdown).length} bytes)` });
    return { ast: { header: { title: '' } }, errors };
  }
  const lines = markdown.split('\n');
  // 整个输入当 steps 节（Section 行号 0 基,parseStepSection 内部 +1 得真实行号）
  const sec: Section = { kind: 'steps', startLine: -1, endLine: lines.length };
  const steps = parseStepSection(lines, sec, errors);
  if (steps.length === 0) {
    errors.push({ kind: 'parse', line: 1, message: '片段内无可解析步骤行（片段=裸步骤序列,如 `1. [reason] …`）' });
  }
  const maxDepth = getMaxNesting(steps);
  if (maxDepth > MAX_NESTING_DEPTH) {
    errors.push({ kind: 'parse', line: 1, message: `Step nesting depth ${maxDepth} exceeds limit of ${MAX_NESTING_DEPTH}` });
  }
  return { ast: { header: { title: '(fragment)' }, steps }, errors };
}

/** 主解析入口：HopSpec markdown 全文 → SpecAST + 解析错误（engine/cli init 调）。见 [[spec-parser#^anc-struct-spec-parser]] */
// 内容章节收集（^anc-rule-narrative-sections 2026-08-27 作者定"写在 spec 文件的内容章节就是缺省
// 要供给的内容,也是 /hop 写成一个文件的原因"）：非关键字 ## 节且无步骤行→原文字节收集;
// 含步骤行=标题风分区（^anc-rule-surface-heading-flavor 既有契约,照旧跳过）;带 (不供给)/(private)
// 尾标的不收（作者显式留人——通用标记非硬编码节名:'处置记录'是 driver 层惯例,引擎不认 driver 私有词）。
// @a: anc-rule-narrative-sections
function collectNarrativeSections(lines: string[]): Array<{ title: string; content: string }> {
  const out: Array<{ title: string; content: string }> = [];
  let inFence = false;
  let inTrace = false;   // %% 块感知（阅卷附注1实锤:@trace 注释块内 ## 曾被误收成伪节）
  let cur: { title: string; start: number } | null = null;
  const flush = (endLine: number) => {
    if (!cur) return;
    const body = lines.slice(cur.start, endLine);
    // 节内含步骤行=标题风分区,不是内容章节
    if (body.some(l => RE_STEP.test(l))) { cur = null; return; }
    const content = body.join('\n').trim();
    if (content) out.push({ title: cur.title, content });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 围栏先判（阅卷复判实锤:%% 先判时围栏内的 %% 行翻转注释块状态机——任务卡背景里引用
    // @trace 头示例即截断+往返产未闭合围栏硬错;identifySections 同为围栏先判既有范式:
    // 围栏内一切都是字面内容）。// @a: anc-rule-narrative-sections
    if (RE_FENCE.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^%%\s*$/.test(line.trim())) { flush(i); inTrace = !inTrace; continue; }
    if (inTrace) continue;
    const hm = line.match(RE_HEADING);
    if (hm) {
      // 阅卷漂移一实锤:###+ 是节内内容不是节边界——只有 #/## 结束当前节
      //（原任意深度 flush,## 背景 里的 ### 子节被掐断且内容蒸发,违背"写进文件的就是要供给的"）
      if (hm[1].length > 2) continue;   // 留在 cur 节体内(slice 会带上)
      flush(i);
      if (hm[1].length === 2) {
        const raw = hm[2].trim();
        const key = raw.toLowerCase().replace(/\s+/g, '');
        const isKeyword = SECTION_KEYWORDS[key] !== undefined;
        // 排除双轨（A 案,2026-08-29 作者拍——实物落地后抓"(不供给)进标题很蠢"）：
        // ①惯例名单精确命中(去空白)——标题保持干净的 ## 处置记录,引擎认惯例与 git 认
        // .gitignore 同理;②通用标记宽容匹配(既有——作者抓模板行标记后跟注释列:尾匹配下
        // 照抄带尾巴即静默失效,排除标记的失效模式恰是垃圾被供给)。// @a: anc-rule-narrative-sections
        const isConventionPrivate = PRIVATE_SECTION_NAMES.has(raw.replace(/\s+/g, ''));
        const isPrivate = isConventionPrivate || /[(（](?:不供给|private)[)）]/.test(raw);
        if (!isKeyword && !isPrivate) cur = { title: raw, start: i + 1 };
      }
      continue;
    }
  }
  flush(lines.length);
  return out;
}

/** spec 全文解析入口——markdown → SpecAST + 解析错误集（容错收集不首错即停）。见 [[spec-parser#^anc-struct-spec-parser]]。 */
export function parseSpec(markdown: string): { ast: SpecAST; errors: ParseError[] } { // @a: anc-struct-spec-parser
  const errors: ParseError[] = [];

  if (new TextEncoder().encode(markdown).length > MAX_INPUT_SIZE) {
    errors.push({ kind: 'parse', line: 0, message: `Input exceeds ${MAX_INPUT_SIZE / 1024}KB limit (actual: ${new TextEncoder().encode(markdown).length} bytes)` });
    return { ast: { header: { title: '' } }, errors };
  }

  const lines = markdown.split('\n');
  const sections = identifySections(lines, errors);
  const header = parseHeaderSections(lines, sections, errors);
  const narratives = collectNarrativeSections(lines);   // @a: anc-rule-narrative-sections
  if (narratives.length > 0) header.narrative_sections = narratives;

  const stepsSec = sections.find(s => s.kind === 'steps');
  let steps: StepNode[] | undefined;
  if (stepsSec) {
    // Steps 区孤儿并入同一容器同走 W1（^anc-rule-decl-zone-warn Steps 扩围）
    const stepOrphans: Array<{ line: number; text: string; section: string }> = [];
    steps = parseStepSection(lines, stepsSec, errors, stepOrphans);
    if (stepOrphans.length > 0) {
      header.decl_zone_orphans = [...(header.decl_zone_orphans ?? []), ...stepOrphans];
    }
    const maxDepth = getMaxNesting(steps);
    if (maxDepth > MAX_NESTING_DEPTH) {
      errors.push({
        kind: 'parse', line: stepsSec.startLine + 1,
        message: `Step nesting depth ${maxDepth} exceeds limit of ${MAX_NESTING_DEPTH}`,
      });
    }
  }

  return { ast: { header, steps }, errors };
}

// ===== Serializer =====

export function serializeSpec(ast: SpecAST, opts?: { lang?: SpecLang }): string {
  const lang: SpecLang = opts?.lang ?? 'en';
  const lines: string[] = [];

  lines.push(`# ${ast.header.title}`);
  const idWord = lang === 'zh' ? '标识' : 'Id';
  if (ast.header.signature) lines.push(`${idWord}: ${ast.header.signature}`);
  else if (ast.header.id) lines.push(`${idWord}: ${ast.header.id}`);
  lines.push('');

  if (ast.header.goal) {
    lines.push('## ' + sectionWord('goal', lang));
    lines.push(ast.header.goal);
    lines.push('');
  }

  if (ast.header.constraints?.length) {
    lines.push('## ' + sectionWord('constraints', lang));
    for (const c of ast.header.constraints) lines.push(`- ${c}`);
    lines.push('');
  }

  if (ast.header.types?.length) {
    lines.push('## ' + sectionWord('types', lang));
    for (const t of ast.header.types) {
      lines.push(`- ${t.name}:${t.description ? `  # ${t.description}` : ''}`);
      for (const [field, type] of Object.entries(t.fields)) {
        const d = t.field_descriptions?.[field];
        lines.push(`    ${field}: ${type}${d ? `  # ${d}` : ''}`);   // 注释是声明的一部分,往返不丢 // @a: anc-type-type-decl
      }
    }
    lines.push('');
  }

  if (ast.header.inputs?.length) {
    lines.push('## ' + sectionWord('inputs', lang));
    for (const v of ast.header.inputs) {
      let line = `- ${v.name}: ${v.type}`;
      if (v.description) line += `  # ${v.description}`;
      lines.push(line);
    }
    lines.push('');
  }

  if (ast.header.outputs?.length) {
    lines.push('## ' + sectionWord('outputs', lang));
    for (const o of ast.header.outputs) {
      let line = `- ${o.name}: ${o.type}`;
      if (o.description) line += `  # ${o.description}`;
      lines.push(line);
    }
    lines.push('');
  }

  if (ast.header.tools?.length) {
    // Tools 段回写（往返保留——^anc-rule-tools-section）
    lines.push('## ' + sectionWord('tools', lang));
    for (const t of ast.header.tools) {
      let sig = `- ${t.name}(${t.params.map(p => p.name).join(', ')})`;
      if (t.output) sig += ` -> ${t.output.name}: ${t.output.type}`;
      if (t.description) sig += `  # ${t.description}`;
      lines.push(sig);
      for (const p of t.params) {
        let pl = `  - ${p.name}: ${p.type}`;
        if (p.description) pl += `  # ${p.description}`;
        lines.push(pl);
      }
      if (t.notes) for (const nl of t.notes.split('\n')) lines.push(`  > ${nl}`);
    }
    lines.push('');
  }

  if (ast.header.config) {
    lines.push('## ' + sectionWord('config', lang));
    for (const [key, val] of Object.entries(ast.header.config)) {
      lines.push(`- ${key}: ${val}`);
    }
    lines.push('');
  }

  if (ast.steps?.length) {
    lines.push('## ' + sectionWord('steps', lang));
    serializeSteps(ast.steps, lines, lang);
  }

  // 内容章节原文回写（^anc-rule-narrative-sections——节序纪律:spec 段在前叙事段在后;
  // 丢写=任务卡镜像写回时语境蒸发）。(不供给) 标记节不在 AST 里,镜像写回由节边界替换
  // 保它字节原样(^anc-exec-specfile-writeback),本 serializer 只回写收集到的。// @a: anc-rule-narrative-sections
  for (const ns of ast.header.narrative_sections ?? []) {
    lines.push('');
    lines.push(`## ${ns.title}`);
    lines.push(ns.content);
  }

  return lines.join('\n') + '\n';
}

/** 片段序列化：裸步骤序列直出（无 # 头无 ## Steps 节标题,首字符即步骤号）——parseFragment 的
 * 对称逆操作,树编辑函数组 spec_is_fragment 模式消费。见 [[spec-parser#^anc-rule-fragment-mode]] */
export function serializeFragment(steps: StepNode[], opts?: { lang?: SpecLang }): string { // @a: anc-rule-fragment-mode
  const lines: string[] = [];
  serializeSteps(steps, lines, opts?.lang ?? 'en');
  return lines.join('\n') + '\n';
}

function serializeSteps(steps: StepNode[], lines: string[], lang: SpecLang = 'en'): void {
  for (const step of steps) {
    const depth = step.step_id.split('.').length - 1;
    const indent = '  '.repeat(depth);

    let stepLine = `${indent}${step.step_id}. [${stepTypeWord(step.step_type, lang)}`;   // on_fail 写回标准形 [on fail]（^anc-step-on-fail）
    if (step.step_type === 'subtask') {
      const st = step as SubtaskStep;
      if (st.retry !== undefined) stepLine += ` ${attrWord('retry', lang)}=${st.retry}`;
      if (st.adaptive) stepLine += ' ' + attrWord('adaptive', lang);
      if (st.parallel) stepLine += ' ' + attrWord('parallel', lang);   // 异步派发标注——丢写=候选文件固化回 spec 变串行（review 抓漏 2026-08-13）// @a: anc-step-parallel
      if (st.free) stepLine += ' ' + attrWord('free', lang);   // 到步展开档写回——丢写=free 档降级普通 subtask,空 children 撞 S5 // @a: anc-step-subtask-free
    }
    if (step.step_type === 'loop') {
      const lt = step as LoopStep;
      // for-each/collect 子句必须写回——丢写=L2e 引用检测降级源漏列表变量引用（v0.7.6 抓漏）
      if (lt.forEach) stepLine += lang === 'zh' ? ` ${CLAUSE_EN2ZH['for-each']} ${lt.forEach.itemVar} ${CLAUSE_EN2ZH['in']} ${lt.forEach.listVar}` : ` for-each ${lt.forEach.itemVar} in ${lt.forEach.listVar}`;
      if (lt.collect?.length) stepLine += `, ${lt.collect.map(c => lang === 'zh' ? `${CLAUSE_EN2ZH['collect']} ${c.unitVar} ${CLAUSE_EN2ZH['into']} ${c.listVar}` : `collect ${c.unitVar} into ${c.listVar}`).join(', ')}`;
      if (lt.max_iterations !== undefined) stepLine += ` ${attrWord('max', lang)}=${lt.max_iterations}`;   // 标准写法 max=N（AST 字段名不变）
    }
    if (step.step_type === 'check' && (step as CheckStep).is_finally) {
      stepLine += ' ' + attrWord('final', lang);   // 标准写法 final（2026-08-09 认知三改;AST 字段名 is_finally 不变）
    }
    if (step.step_type === 'check' && (step as CheckStep).escalatable) {
      stepLine += ' ' + attrWord('escalatable', lang);   // 升层声明回写（^anc-exec-check-escalate）
    }
    if (step.step_type === 'act' && (step as ActStep).free) {
      stepLine += ' ' + attrWord('free', lang);   // [act free] 自由任务档写回——丢写=free 档降级为无标注 act（B7 warn 误报）// @a: anc-rule-b7
    }
    if (step.step_type === 'case') {
      const cs = step as CaseStep;
      // 结构化逻辑标准写法 [case(条件)] 描述——机读入 []（统配写 (else)——2026-08-09 认知三改）。// @a: anc-rule-case-condition
      if (cs.condition && cs.condition !== 'default') stepLine += `(${cs.condition})`;
      else if (cs.condition === 'default') stepLine += lang === 'zh' ? '(其他)' : '(else)';
      if (cs.retry !== undefined) stepLine += ` ${attrWord('retry', lang)}=${cs.retry}`;
      if (cs.adaptive) stepLine += ' ' + attrWord('adaptive', lang);
      if (cs.parallel) stepLine += ' ' + attrWord('parallel', lang);   // case=parallel 宿主三型之一,同 subtask 丢写即语义丢失 // @a: anc-step-parallel
    } else if (step.step_type === 'ask') {
      // ask 属性写回（三十二审自家狗粮实撞:renumber_only 经 serializer 往返把 present_inputs/
      // require_human 全丢——present_inputs 是呈交硬约束、require_human 是真人闸,丢失即 HITL
      // 语义降级;与 for-each/初值/body 丢失同族第 4 例）。// @a: anc-step-ask
      const as = step as AskStep;
      if (as.require_human) stepLine += ' ' + attrWord('require_human', lang);
      if (as.present_inputs?.length) stepLine += ` present_inputs=${as.present_inputs.join(',')}`;
    } else if (step.step_type === 'confirm') {
      const cf = step as ConfirmStep;
      if (cf.require_human) stepLine += ' ' + attrWord('require_human', lang);   // @a: anc-step-confirm
    }
    if (step.step_type === 'break' || step.step_type === 'continue') {
      // 目标回写（往返投影不变量:target_loop 丢写=多层跳出语义静默降级为最近循环）// @a: anc-step-break, anc-step-continue
      const tl = (step as BreakStep | ContinueStep).target_loop;
      if (tl) stepLine += ` ${tl}`;
    }
    if (step.step_type === 'call') {
      const cl = step as CallStep;
      // 结构化逻辑标准写法 [call id(映射)] 描述——机读入 [];同名映射缩裸名;无输入无括号。// @a: anc-rule-call-orthography
      // callee 位插值形态回写 {表达式原文}（callee_expr_src 解析时原样存留,往返一致）// @a: anc-step-call-dynamic-callee
      const calleeToken = cl.callee_spec_id ?? (cl.callee_expr_src !== undefined ? `{${cl.callee_expr_src}}` : undefined);
      if (calleeToken) {
        stepLine += ` ${calleeToken}`;
        if (cl.param_mapping?.length) {
          stepLine += `(${cl.param_mapping.map(m => m.from === m.to ? m.to : `${m.to}: ${m.from}`).join(', ')})`;
        }
        if (cl.parallel) stepLine += ' ' + attrWord('parallel', lang);   // 异步派发标注（统一模型）// @a: anc-step-parallel
      }
    }
    stepLine += `] ${step.summary}`;
    lines.push(stepLine);

    const bodyIndent = '  '.repeat(depth + 1);
    if (step.inputs?.length) {
      lines.push(`${bodyIndent}- ← ${step.inputs.map(i => i.name).join(', ')}`);
    }
    if (step.outputs?.length) {
      for (const o of step.outputs) {
        // 三形态分写（^anc-rule-serialize-output-forms,todo/0016 投影漂移修）：// @a: anc-rule-serialize-output-forms
        // ①复合输出（fields 非空）→ 展开头 `name:` + 缩进字段子行（原写 `name: yaml` 丢 fields）;
        // ②裸名引用（type 空串=更新/引用既有变量）→ 裸名不写冒号（原写 `name: ` 尾空型,
        //   re-parse 误认复合头得 type=yaml——投影漂移实锤形态）;
        // ③常规声明 → `name: type` 照旧。
        if (o.fields?.length) {
          lines.push(`${bodyIndent}+ → ${o.name}:${o.description ? `  # ${o.description}` : ''}`);
          for (const f of o.fields) {
            lines.push(`${bodyIndent}  - ${f.name}: ${f.type}${f.description ? `  # ${f.description}` : ''}`);
          }
          continue;
        }
        let outLine = o.type === ''
          ? `${bodyIndent}+ → ${o.name}`
          : `${bodyIndent}+ → ${o.name}: ${o.type}`;
        // = 初值写回（v0.10.2——原全丢:初值是语义子句〔累加器 init/每轮重置〕,丢失后 re-parse
        // 语义不同,超出"格式不保真"豁免;JSON 形态经 parseInitValue 往返稳定）// @a: anc-rule-init-value
        if (o.default !== undefined) {
          outLine += ` = ${o.default === null ? 'Null' : JSON.stringify(o.default)}`;
        }
        if (o.description) outLine += `  # ${o.description}`;
        lines.push(outLine);
      }
    }
    // call 输出映射行（outputs 被清成 undefined,映射在 output_mapping）:+ → parent: callee_out,同名裸名
    if (step.step_type === 'call') {
      const om = (step as CallStep).output_mapping;
      if (om?.length) {
        for (const m of om) {
          lines.push(`${bodyIndent}+ → ${m.from === m.to ? m.to : `${m.to}: ${m.from}`}`);
        }
      }
    }
    // @model/@src 标注写回（提取时剥出 instruction,写回须补——@model 序列化丢失系存量缺口
    // v0.11.0 顺带修:标注是语义子句,丢失后 re-parse 路由/锚点漂移）。// @a: anc-exec-model-annotation, anc-step-src-annotation
    if (step.model_override) lines.push(`${bodyIndent}> @model ${step.model_override}`);
    if (step.thinking_override) lines.push(`${bodyIndent}> @thinking ${step.thinking_override}`);   // serialize 往返保留（与 @model 同款纪律）// @a: anc-exec-thinking-step-annotation
    if (step.src_ref) lines.push(`${bodyIndent}> @src ${step.src_ref}`);
    if (step.instruction) {
      for (const iline of step.instruction.split('\n')) {
        lines.push(`${bodyIndent}> ${iline}`);
      }
    }
    // hop_python body 写回（check body 批顺带修存量缺口:act/commit body 序列化全丢——与
    // for-each 子句/初值丢失同族且面更大:body 是执行语义本体,丢失后 re-parse 的步骤从引擎
    // 直执退化为 LLM 自由发挥,L2e 降级源也漏 body 引用）。// @a: anc-step-check-body
    const bodyOf = (step as ActStep | CommitStep | CheckStep).body;
    if (bodyOf) {
      lines.push(`${bodyIndent}> \`\`\`hop_python`);
      for (const bline of serializeActBody(bodyOf).split('\n')) {
        lines.push(`${bodyIndent}> ${bline}`);
      }
      lines.push(`${bodyIndent}> \`\`\``);
    }

    if ('children' in step && Array.isArray((step as SubtaskStep).children)) {
      serializeSteps((step as SubtaskStep).children, lines, lang);   // lang 递归透传——漏传=子层恒英文,zh 序列化只有顶层中文(测试实抓)
    }
  }
}
