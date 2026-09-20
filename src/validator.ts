// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: spec-parser ^anc-struct-spec-parser
// 54-rule validator for SpecAST (from design/spec-parser.md appendix), 5 dimensions:
// S1-S16 structure (S14 空号,S13/S15/S16 后增——S16 并行收集断链检测 2026-09-04), C1-C8 control flow,
// V1-V13 variables (V3 废除,V13 callee 插值断供核 2026-09-05), P1-P15 special steps (P2 已废除), B1-B10 act/commit body (B3 并入 B2, 编号位保留).
// 与设计规则总表(design/spec-parser.md 附录)对齐——头注曾长期漏登 S13/S15/V12/B9/B10,本次随 S16 补齐.

import type { SpecAST, StepNode, StepType, OutputDecl, VarBinding, TypeDecl, SubtaskStep, ParallelStep, LoopStep, BranchStep, CaseStep, CallStep, CommitStep, ConfirmStep, ExitStep, CheckStep, AskStep, DocRef, ActStep, ActBody, ActStatement, ActExpr, IfStmt, AssignStmt, CallStmt, CallExpr, BinaryExpr } from './ast-types.js';
import { DEFAULT_EXPANSION_MAX } from './ast-types.js';   // @a: anc-exec-subtask-free-expand
import type { ValidationError, ValidationSeverity, ParseError } from './errors.js';
import type { SandboxConfig } from './provider-types.js';
import { ROUTING_CATEGORIES } from './provider-types.js';
import { ALL_STEP_TYPES, CONTAINER_STEP_TYPES, EXECUTABLE_STEP_TYPES, hasChildren, getChildren, isUpdateModeOutput, isParallelContainer, getForEach, formatTypeDecl, collectTypeDeclClosure } from './ast-helpers.js';
import { ACT_BUILTINS, ACT_BUILTIN_NAMES } from './act-builtins.js';
import { load as yamlLoad } from 'js-yaml';
import { parseExpression, findNonPureCallWith, exprChildren } from './act-body-parser.js';
import { checkDocRefExists } from './doc-ref.js';

// P15 doc-ref 静态校验需要文件访问能力（workspace + sandbox）。纯 AST 校验场景缺省，跳过 P15。
export interface DocRefCheckCtx { workspace_dir: string; sandbox: SandboxConfig; hop_env?: Record<string, string>; spec_dir?: string; lenient_cross_dir?: boolean; }   // hop_env: P15 两档展开用;spec_dir: 两级基准第一级（与注入期同判）;lenient_cross_dir: validate 档跨目录"文件未找到"降 warn（validate 时点 cwd 是猜测非运行期权威） // @a: anc-exec-doc-ref-hop-env, anc-rule-p15

// branch 声明聚合输出（统一接口名），各 case 同名填充（同一个东西）。
// branch + case 都开作用域。见 ^anc-exec-container-output
const SCOPE_CREATING_CONTAINERS: ReadonlySet<StepType> = new Set<StepType>(['subtask', 'loop', 'branch', 'case']);   // parallel 已属性化

/** @model 可路由步骤类型（reason/act/check/commit）——ROUTING_CATEGORIES 去 replan（元编程档不是步骤类型,
 * spec 里写不出）。与加载闸/ModelRoute 类型同源（0008②）。// @a: anc-rule-p9 */
const MODEL_ROUTABLE_STEP_TYPES: ReadonlySet<StepType> = new Set<StepType>(
  ROUTING_CATEGORIES.filter((c): c is StepType & typeof c => c !== 'replan'));

/** Leaf step types — cannot have children */
const LEAF_STEP_TYPES: ReadonlySet<StepType> = new Set<StepType>([
  'reason', 'act', 'check', 'confirm', 'ask', 'commit', 'call', 'break', 'continue', 'exit',
]);

/** 片段验证选项——validate --fragment 的引擎面：豁免整文完备性规则,knownVars 注入 V1 来源。见 [[spec-parser#^anc-rule-fragment-mode]] */
export interface FragmentOptions { // @a: anc-rule-fragment-mode
  fragment: true;
  knownVars?: string[];   // 上层已知变量名——注入 V1 可追溯来源（类型未知按通配,类型核对归整文验）
}

/** Spec 校验入口——对 SpecAST 执行结构/控制流/变量/特殊步骤全部校验规则（规则集与条数权威归 [[spec-parser]]，此处不复记数字），返回违规列表（放行前闸门）；fragmentOpts 启用片段模式。见 [[spec-parser#^anc-rule-all]]。 */
export function validateSpec(ast: SpecAST, docRefCtx?: DocRefCheckCtx, fragmentOpts?: FragmentOptions): ValidationError[] { // @a: anc-rule-all, anc-rule-v3-all
  const errors: ValidationError[] = [];

  // 片段模式：knownVars 以合成 Inputs 声明注入（V1 来源扩展的最小实现——变量规则
  // 本就认 header.inputs 为合法来源;类型通配=不声明具体类型,V2 同名异型不误伤）。
  // 豁免面显式列举（S8/S10/exit 交付/P10）,其余规则全量。// @a: anc-rule-fragment-mode
  const existingInputs = new Set((ast.header.inputs ?? []).map(i => i.name));
  const dedupedKnown = [...new Set(fragmentOpts?.knownVars ?? [])].filter(n => n && !existingInputs.has(n));
  const effectiveAst = dedupedKnown.length
    ? { ...ast, header: { ...ast.header, inputs: [
        ...(ast.header.inputs ?? []),
        // 类型=空串通配——V8/类型核对对空类型天然放行,类型核对归整文验（设计条款'类型未知按通配匹配';
        // 首版写死 'text' 违约:片段引用上层列表变量做 for-each 被 V8 误拒——重档实测案例A实撞）。
        ...dedupedKnown.map(n => ({ name: n, type: '', description: '(fragment known-var,类型归整文验)', synthesized: true })),
      ] } }
    : ast;

  if (!fragmentOpts) structuralRuleS10(effectiveAst, errors);
  // Config expansion_max 合法性（契约7——非法值运行时静默回缺省,validate 时点提前可见;
  // warn 不 error:配置钝感,写错不炸 spec）// @a: anc-exec-subtask-free-expand
  {
    const raw = ast.header.config?.['expansion_max'];
    if (raw !== undefined) {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        errors.push({ kind: 'validate', rule: 'config', severity: 'warn', message: `Config expansion_max=${JSON.stringify(raw)} 非法（须正整数）——运行时将按缺省 ${DEFAULT_EXPANSION_MAX} 执行` });
      }
    }
  }
  // W1 声明区孤儿行（^anc-rule-decl-zone-warn,todo/0016 作者定"做吧"）：parser 收集的
  // 不匹配文法非空非注释行逐条出 warn——写错的声明不再无声蒸发。全角标点（：（），；）
  // 是中文输入法第一坑（全库 121 站点实测）,行内含即点名改半角。warn 不 error:宽容面
  // 收紧到"可见",不收紧到"拒收"——Steps 区文法另有守卫,本规则只管声明区。
  // @a: anc-rule-decl-zone-warn
  for (const o of ast.header.decl_zone_orphans ?? []) {
    const fullwidth = /[：（），；]/.test(o.text) ? '——行内有全角标点,疑似该用半角（: ( ) , ;）' : '';
    errors.push({ kind: 'validate', rule: 'W1', severity: 'warn', message: `${o.section} 段第 ${o.line} 行不合本段文法,已被忽略: '${o.text}'${fullwidth}` });
  }
  structuralRules(effectiveAst, errors);
  controlFlowRules(effectiveAst, errors);
  variableRules(effectiveAst, errors, !!fragmentOpts);
  specialStepRules(effectiveAst, errors);
  if (!fragmentOpts) toolDeclConsumptionV14(effectiveAst, errors);   // 片段无 header 声明面,V14 不适用 // @a: anc-rule-v14
  checkSelfVerdictV15(effectiveAst, errors);   // 判定材料=步骤自身声明,片段可判照验 // @a: anc-rule-v15
  if (docRefCtx) docRefRuleP15(effectiveAst, errors, docRefCtx); // 仅当有 workspace 访问能力时校验

  if (fragmentOpts) {
    // 豁免过滤:S8(goal)/S10(头部结构)/P4(exit 交付完备)/P10(输出无产出 warn)——片段天然不完整。
    // 豁免显式列举,默认全验（漏豁免=误报可见,误豁免=漏检不可见,宁可前者）。
    // V7 豁免限定合成变量:knownVars 空类型通配是片段模式自身构造——但作者真写的 Inputs 坏类型仍拦,
    // 故不整类豁免,过滤时只放行 synthesized 声明产生的 V7（按变量名匹配 dedupedKnown）。
    const EXEMPT = new Set(['S8', 'S10', 'P4', 'P10']);
    const knownSet = new Set(dedupedKnown);
    // C3/C6 祖先缺席形态豁免（buildtest 实撞:片段=循环体子树时 loop/subtask 容器住父上下文,
    // 片段本地无祖先——continue/check 合法却被拒,反馈教 LLM 删掉合法流控）。只豁免"无祖先"
    // 消息形态:片段内真有容器但类型/位置错的（如 check 嵌在 loop 下）照拦——祖先在场即本地可判。
    // P4 豁免收窄到交付完备形态（片段天然缺 header.outputs 对照面才豁免）;死代码闸（流控/
    // 容器带 hop_python body,报文含"死代码"）片段内完全可判,照拦——hopbuild 片段核查正是
    // 该反馈的第一消费场（29 轮 review 抓:整码豁免让 expand-node 对死代码盲,拼装后整文验
    // 才报,离产出点隔一层）。// @a: anc-rule-p4, anc-rule-fragment-mode
    return errors.filter(e => (!EXEMPT.has(e.rule) || (e.rule === 'P4' && e.message.includes('死代码')))
      && !(e.rule === 'V7' && [...knownSet].some(n => e.message.includes(`"${n}"`)))
      && !(e.rule === 'C3' && e.message.includes('is not inside a loop'))
      && !(e.rule === 'C6' && e.message.includes('must be inside a subtask or case'))
      && !(e.rule === 'C7' && e.message.includes('must be inside a subtask')));
  }
  return errors;
}

// V14: Tools 段声明-授权行消费对账（D94 批,作者拍"validate 应该加验证"——声明零消费=工具对
// 所有步骤静默不可见,LLM 只能空转不报错,split-patterns 教的"最难发现的失效形态"。三消费形态
// 全认:节点授权行(tool_grants,含 * 通配)/body 内 CallExpr 直调/授权通配。warn 不 error:复用
// 模式 caller 可按 Tools 段自行注册消费,清单对 caller 有信息价值。反向(授权未声明名)不查——
// 授权开的是环境注册面,Tools 段只是需求声明子集。// @a: anc-rule-v14
function toolDeclConsumptionV14(ast: SpecAST, errors: ValidationError[]): void {
  const declared = (ast.header.tools ?? []).map(t => t.name).filter(Boolean);
  if (declared.length === 0) return;
  const granted = new Set<string>();
  let wildcard = false;
  const bodyCalled = new Set<string>();
  const collectExpr = (e: ActExpr | undefined): void => {
    if (!e) return;
    if (e.type === 'call') {
      const c = e as CallExpr;
      bodyCalled.add(c.callee);
      for (const a of c.args) collectExpr(a.value);
      return;
    }
    if (e.type === 'binary') { collectExpr((e as BinaryExpr).left); collectExpr((e as BinaryExpr).right); return; }
    // 其余复合形态(三元/推导/字典)的工具调用嵌深罕见,V14 是 warn 档宽容规则——漏认最多多一条
    // 可澄清的 warn,不做全形态递归(与 B2 的严格递归不同权重)。
  };
  const walk = (nodes: StepNode[] | undefined): void => {
    for (const n of nodes ?? []) {
      const grants = (n as ActStep).tool_grants ?? [];
      for (const g of grants) {
        if (g.name === '*') wildcard = true;
        else granted.add(g.name);
      }
      const body = (n as ActStep).body;
      if (body) for (const stmt of body.statements ?? []) {
        if (stmt.type === 'assign') collectExpr((stmt as AssignStmt).value);
        else if (stmt.type === 'call') collectExpr((stmt as CallStmt).call);
        else if (stmt.type === 'if') {
          const ifs = stmt as IfStmt;
          collectExpr(ifs.condition);
          for (const s of [...(ifs.then_body ?? []), ...(ifs.else_body ?? [])]) {
            if (s.type === 'assign') collectExpr((s as AssignStmt).value);
            else if (s.type === 'call') collectExpr((s as CallStmt).call);
          }
        }
      }
      walk((n as SubtaskStep).children);
    }
  };
  walk(ast.steps);
  if (wildcard) return;   // 通配授权在场=全部声明视为已消费
  for (const name of declared) {
    if (!granted.has(name) && !bodyCalled.has(name)) {
      errors.push({ kind: 'validate', rule: 'V14', severity: 'warn',
        message: `V14: Tools 段声明的工具 "${name}" 未被任何步骤授权或调用——standalone 下它对所有步骤不可见,声明即空转;要用它给消费步加 "- 工具: ${name}" 授权行,不用它删声明` });
    }
  }
}

// V15: check 步输入声明禁含自己的输出变量（^anc-rule-v15,概念权威 ^anc-step-check-criteria
// 判官不吃自产判词条——实撞:验收步输入含自己上轮判词,重试轮判官照抄旧判词交卷不重判,修订
// 全部落实仍三轮同词烧尽;引擎"check 不吃 L5 重试反馈"防线只罩引擎通道,spec 变量通道从输入
// 声明正门进。warn 档:自读自写的确定性 body check（累积计数器类）零 LLM 无锚定风险属边缘
// 合法,同形态照 warn 提示作者自证意图不误伤。）// @a: anc-rule-v15
function checkSelfVerdictV15(ast: SpecAST, errors: ValidationError[]): void {
  const walk = (nodes: StepNode[] | undefined): void => {
    for (const n of nodes ?? []) {
      if (n.step_type === 'check') {
        const outs = new Set((n.outputs ?? []).map(o => o.name));
        for (const b of n.inputs ?? []) {
          if (outs.has(b.source)) {
            errors.push({ kind: 'validate', rule: 'V15', severity: 'warn',
              message: `V15: check 步骤 "${n.step_id}" 的输入含自己的输出变量 "${b.source}"——判官会读到自己上轮的判词并照抄交卷,不重判;判官每轮应对着当前产出独立判,反馈变量只喂给重做的执行步,从本步输入删除它` });
          }
        }
      }
      walk((n as SubtaskStep).children);
    }
  };
  walk(ast.steps);
}

// P15: doc-ref [[doc#章节]] 静态存在性校验 // @a: anc-rule-p15
function docRefRuleP15(ast: SpecAST, errors: ValidationError[], ctx: DocRefCheckCtx) {
  const check = (refs: DocRef[] | undefined, step_id?: string, line?: number) => {
    for (const ref of refs ?? []) {
      // 含 {hop_env_*} 且表缺席=推迟注入期核——info 注记留痕（不假绿也不误拒,设计 P15 两档
      // "报文注明"条款,review 抓静默跳过）。// @a: anc-exec-doc-ref-hop-env
      if (/\{hop_env_[a-z0-9_]+\}/.test(ref.doc) && (!ctx.hop_env || Object.keys(ctx.hop_env).length === 0)) {
        errors.push(ve('P15', 'info', `doc-ref [[${ref.doc}#${ref.section}]] 含环境参数,配置缺席——注入期核`, step_id, line));
        continue;
      }
      const err = checkDocRefExists(ctx.workspace_dir, ctx.sandbox, ref, ctx.hop_env, ctx.spec_dir);
      if (err) {
        // validate 档跨目录降警：含路径分隔符的引用按 workspace 解析,而 validate 时点 cwd 是
        // 猜测非运行期权威（vault 材料 spec 从库内 validate 必找不到）——"文件未找到"降 warn
        // 留痕;裸名/同目录=静态权威照旧 error;章节未匹配（文件在）恒 error。// @a: anc-rule-p15
        const lenient = ctx.lenient_cross_dir === true && ref.doc.includes('/') && err.startsWith('文件未找到');
        errors.push(ve('P15', lenient ? 'warn' : 'error', `doc-ref [[${ref.doc}#${ref.section}]] 校验失败: ${err}${lenient ? '（跨目录引用,运行期核）' : ''}`, step_id, line));
      }
    }
  };
  check(ast.header.doc_refs); // spec 级（Constraints）
  for (const step of ast.steps ? flattenSteps(ast.steps) : []) {
    check(step.doc_refs, step.step_id, step.source_location?.line_start);
  }
}

// 内置类型名全局保留（作者拍板 A 2026-08-14,概念规则 27 ^anc-rule-type-reserved）：类型词与
// 变量位同槽竞争的语法位（call 映射等）会静默错读,类型词做变量名无真实需求——同 else 先例。
// '[line]' 属 BUILTIN_TYPES 但含括号不可能是标识符,无需排除。// @a: anc-rule-type-reserved
function typeReservedError(name: string, where: string, stepId?: string, line?: number): ValidationError | null {
  // number 已从合法类型除名（2026-08-31 作者定与 Python 一致）但仍占保留字位——
  // 废词占位:防旧写法 `x: number` 的 number 被静默读成变量引用。
  if (!BUILTIN_TYPES.has(name) && name !== 'number') return null;
  return ve('V2', 'error', `${where} "${name}" 是内置类型名（全局保留字）——类型词不得作变量名（概念规则 27）。类型名全表: ${builtinTypeList()};语言关键词（outputs/steps 等）同禁——详见语法参考「变量与数据流」节`, stepId, line);
}

// 语言关键词保留字族（2026-08-15 作者定,i18n 方案 B 同批——概念 ^anc-i18n-keywords-bilingual,
// 设计 [[i18n#^anc-i18n-keyword-reserved]]）：段头/步骤类型/属性子句词不得作变量名。
// 中文关键词随术语表拍定同批入此集。// @a: anc-i18n-keyword-reserved
const LANG_KEYWORDS = new Set([
  'id', 'goal', 'constraints', 'types', 'inputs', 'outputs', 'config', 'steps',
  'reason', 'act', 'check', 'confirm', 'ask', 'commit', 'call', 'branch', 'case',
  'subtask', 'loop', 'parallel', 'break', 'continue', 'exit',
  'retry', 'max', 'adaptive', 'final', 'escalatable', 'free', 'collect', 'into', 'in', 'require_human',
  'tools',   // 节点工具授权条目键（0054 ^anc-step-tool-grant——中文词 工具 经条目解析归一,同族保留）
  'deny_tools',   // 节点工具禁用条目键（^anc-step-tool-deny——禁用半边 2026-09-05,中文词 禁工具 同族保留） // @a: anc-step-tool-deny
  // 中文关键词（术语表拍定 2026-08-15,design/i18n.md ^anc-i18n-glossary——双语同为保留字）
  '标识', '目标', '约束', '类型', '输入', '输出', '配置', '步骤',
  '推理', '探索', '检查', '确认', '询问', '提交', '调用', '分支', '条件',
  '子任务', '循环', '并行', '跳出循环', '继续循环', '结束',
  '重试', '上限', '自适应', '终检', '可上升', '开放', '收集', '遍历', '于', '入', '必须真人确认',
]);
// 报文清单从 Set 现生成（单一事实源防漂移——0029:原只点名撞到的词,作者无先验避用每撞才知）
const EN_KEYWORD_LIST = [...LANG_KEYWORDS].filter(k => /^[a-z_]+$/.test(k)).join(', ');
function keywordReservedError(name: string, where: string, stepId?: string, line?: number): ValidationError | null {
  // else/其他（[case(else)] 统配位保留字）收编本闸——单闸即六位恒同位（27 轮 review 抓:
  // 原散点只拦产出位,Inputs/for-each/collect/call 映射四位放行,与文档"禁作变量名"承诺不符）。
  if (name === 'else' || name === '其他') {
    return ve('V2', 'error', `${where} "${name}" 是条件统配保留字（[case(else)] 统配语法,中文别名 其他）——不得作变量名`, stepId, line);
  }
  if (!LANG_KEYWORDS.has(name)) return null;
  return ve('V2', 'error',
    `${where} "${name}" 是语言关键词（保留字）——关键词不得作变量名。完整保留字清单: ${EN_KEYWORD_LIST}（各词的中文关键词同为保留字）;内置类型名（text/line/yaml 等）与条件统配词 else/其他 同禁——详见语法参考「变量与数据流」节`,
    stepId, line);
}

// 变量名标识符文法闸（V2b,2026-08-15 primer trap 实撞——`+ →` 行写赋值表达式整串被静默收作
// 变量名,B4/B5 间接报错指错方向）：Unicode 标识符 Python 3 同款（作者两轮裁定终形——中文名
// 一等公民,与 hop_python tokenizer 字符集 \p{L}\p{N}_ 精确一致:能声明必能引用,连字符/=/空格
// 等表达式字符天然出局）。// @a: anc-rule-v2b
const IDENT_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;
function identGateError(name: string, where: string, stepId?: string, line?: number): ValidationError | null {
  if (IDENT_RE.test(name)) return null;
  const hint = /[\s=+\[\]]/.test(name)
    ? '——`+ →` 行只声明名字（`name: type` 或裸名）,累加/表达式写法进 hop_python body'
    : '——变量名须为标识符（字母〔含中文〕或下划线开头,后续字母/数字/下划线——Python 同款）';
  return ve('V2b', 'error', `${where} "${name}" 不是合法变量名${hint}`, stepId, line);
}

// ===== Helpers =====

function ve(
  rule: string, severity: ValidationSeverity, message: string,
  step_id?: string, line?: number,
): ValidationError {
  return { kind: 'validate', rule, severity, message, step_id, line };
}

function flattenSteps(steps: StepNode[]): StepNode[] {
  const result: StepNode[] = [];
  function walk(nodes: StepNode[]) {
    for (const n of nodes) {
      result.push(n);
      for (const c of getChildren(n)) walk([c]);
    }
  }
  walk(steps);
  return result;
}

function findAncestor(
  stepId: string, allSteps: Map<string, StepNode>,
  predicate: (s: StepNode) => boolean,
): StepNode | undefined {
  let id = stepId;
  while (id.includes('.')) {
    id = id.slice(0, id.lastIndexOf('.'));
    const parent = allSteps.get(id);
    if (parent && predicate(parent)) return parent;
  }
  return undefined;
}

// ===== S1-S9: Structural rules =====

function structuralRules(ast: SpecAST, errors: ValidationError[]) {
  // S1: title non-empty // @a: anc-rule-s1
  if (!ast.header.title?.trim()) {
    errors.push(ve('S1', 'error', 'Spec must have a non-empty title'));
  }

  // S8: goal non-empty // @a: anc-rule-s8
  if (!ast.header.goal?.trim()) {
    errors.push(ve('S8', 'error', 'Spec must have a non-empty goal'));
  }

  if (!ast.steps) return;
  const allFlat = flattenSteps(ast.steps);
  const idSet = new Set<string>();

  for (const step of allFlat) {
    const loc = step.source_location?.line_start;

    // S2: step_id format // @a: anc-rule-s2
    if (!/^\d+(\.\d+)*$/.test(step.step_id) || step.step_id.split('.').some(n => Number(n) < 1)) {
      errors.push(ve('S2', 'error', `Invalid step_id format: "${step.step_id}"`, step.step_id, loc));
    }

    // S3: step_id uniqueness // @a: anc-rule-s3
    if (idSet.has(step.step_id)) {
      errors.push(ve('S3', 'error', `Duplicate step_id: "${step.step_id}"`, step.step_id, loc));
    }
    idSet.add(step.step_id);

    // S4: valid step_type // @a: anc-rule-s4
    if (!ALL_STEP_TYPES.has(step.step_type)) {
      errors.push(ve('S4', 'error', `Invalid step_type: "${step.step_type}"`, step.step_id, loc));
    }

    // S5: container steps must have ≥1 child（含 case≡subtask）。
    // 豁免:[subtask free] 到步展开档 children 可空（^anc-step-subtask-free——写卡只声明契约,
    // children 由执行到步索计划补齐;free 非空=合法预填,到步不触发）。// @a: anc-rule-s5, anc-step-subtask-free
    if (CONTAINER_STEP_TYPES.has(step.step_type)) {
      const children = getChildren(step);
      const freeExpand = step.step_type === 'subtask' && (step as SubtaskStep).free === true;
      if (children.length === 0 && !freeExpand) {
        errors.push(ve('S5', 'error', `Container step "${step.step_id}" (${step.step_type}) has no children`, step.step_id, loc));
      }
    }

    // S15: on_fail 失败兜底块位置约束（^anc-step-on-fail,2026-08-21）：宿主须 subtask/case、
    // 必居末位、一容器至多一个。// @a: anc-rule-s15
    if (step.step_type === 'on_fail') {
      const parentId = step.step_id.split('.').slice(0, -1).join('.');
      const parent = parentId ? allFlat.find(f => f.step_id === parentId) : undefined;
      if (!parent || (parent.step_type !== 'subtask' && parent.step_type !== 'case')) {
        errors.push(ve('S15', 'error', `[on fail] 失败兜底块 "${step.step_id}" 必须直属 subtask/case 容器（retry 耗尽才有兜底语义——${parent ? `当前宿主 ${parent.step_type}` : '当前在顶层'}）`, step.step_id, loc));
      } else {
        const siblings = getChildren(parent);
        if (siblings.length && siblings[siblings.length - 1].step_id !== step.step_id) {
          errors.push(ve('S15', 'error', `[on fail] 失败兜底块 "${step.step_id}" 必须是容器最后一个子节点（check final 之后）`, step.step_id, loc));
        }
        if (siblings.filter(c => c.step_type === 'on_fail').length > 1) {
          errors.push(ve('S15', 'error', `容器 "${parentId}" 声明了多个 [on fail] 兜底块——一容器至多一个`, step.step_id, loc));
        }
      }
    }

    // S9: container with outputs referenced downstream must declare them // @a: anc-rule-s9, anc-exec-container-output
    // branch 声明聚合输出（统一接口名），case 同名填充（同一个东西），都受 S9 约束
    if (CONTAINER_STEP_TYPES.has(step.step_type)) {
      if (!step.outputs || step.outputs.length === 0) {
        const prefix = step.step_id + '.';
        const isReferenced = allFlat.some(other =>
          other.inputs?.some(b => b.source.includes(prefix))
        );
        if (isReferenced) {
          errors.push(ve('S9', 'error', `Container step "${step.step_id}" (${step.step_type}) outputs are referenced but not declared`, step.step_id, loc));
        }
      }
    }

    // S6: child step_id must inherit parent step_id as prefix // @a: anc-rule-s6
    const children = getChildren(step);
    for (const child of children) {
      if (!child.step_id.startsWith(step.step_id + '.')) {
        errors.push(ve('S6', 'error',
          `Child step_id "${child.step_id}" does not start with parent "${step.step_id}."`,
          child.step_id, child.source_location?.line_start));
      }
    }
  }

  // S7: top-level step IDs must be single numbers // @a: anc-rule-s7
  for (const step of ast.steps) {
    if (step.step_id.includes('.')) {
      errors.push(ve('S7', 'error',
        `Top-level step_id "${step.step_id}" must be a single number`,
        step.step_id, step.source_location?.line_start));
    }
  }

  // S11: leaf steps cannot have children // @a: anc-rule-s11
  for (const step of allFlat) {
    if (LEAF_STEP_TYPES.has(step.step_type) && 'children' in step) {
      const children = (step as any).children;
      if (Array.isArray(children) && children.length > 0) {
        const loc = step.source_location?.line_start;
        errors.push(ve('S11', 'error',
          `叶子步骤 "${step.step_id}" (${step.step_type}) 不能有 children`,
          step.step_id, loc));
      }
    }
  }

  // S12 统一模型（P0.5 泛化到 subtask parallel）：异步派发的依赖边界。// @a: anc-rule-s12
  // call parallel：①只准 loop 体内 ②输出宿主容器内不可消费（无 Future）；
  // subtask parallel：宿主任意（loop 体内=渐进派发/兄弟位=并发），②同查。
  // 旧通道互斥子条已随 loop 头 parallel 文法废除退役（parser 报错，无容器域可查）。
  // 见 design/parallel-execution.md §U1 / 概念 ^anc-exec-gather。
  validateAsyncParallel(ast, allFlat, errors);

  // S16 并行收集产出链完整（2026-09-04 作者补拍"在 validate 工具这边应该有这种循环收集断链
  // 的检测"——决策档案 todo/decision/20260904-parallel收割须兑现声明产出链.md;D80 实撞:
  // loop>壳>call parallel 三层形态壳漏声明边界产出时收割链静默断,18 小时后丢产物账面 completed）。
  // 两半:①collect 供给核——loop 头 collect 点名的单项变量须由循环体直接子级边界产出提供;
  // ②链条逐环核——parallel 标注步骤到收集边界间每层中间容器须把被收集变量声明为边界产出。
  // 写时抓"spec 真断链",与引擎续链收割（"链齐必须走通"）两半合拢消灭静默地带。error。
  // // @a: anc-rule-s16
  validateCollectChain(ast, allFlat, errors);

  // S12 旧子条已退役（2026-08-11 统一模型 P0.5）：
  // ①"loop parallel 须 for-each"——loop 头 parallel 文法已废除，parser 层拒绝；
  // ②"parallel 容器 children 无依赖"——静态组读法废除：subtask parallel 子树是子实例内部
  //   串行执行，children 间依赖合法；异步边界由 validateAsyncParallel 把守。// @a: anc-rule-s12
}

// 统一模型异步派发依赖边界（S12 子条，P0.5 泛化）：call/subtask 标注步骤共用。// @a: anc-rule-s12
// 概念 ^anc-exec-gather 无 Future 铁律：标注步骤输出只经容器边界导出（loop collect 列表/
// 容器头具名 +→ 收齐后可读），宿主容器内消费=在半路等单个结果=变相暴露 Future。
// S16 并行收集产出链完整（^anc-rule-s16,2026-09-04）：见调用点注释。
// 判定材料全在 AST:collect 对（loop 头）/各层容器 outputs 声明/parallel 标注位置——纯静态。
function validateCollectChain(ast: SpecAST, allFlat: StepNode[], errors: ValidationError[]) {
  const findById = (id: string) => allFlat.find(s => s.step_id === id);
  const parentOf = (id: string): string | null => { const i = id.lastIndexOf('.'); return i < 0 ? null : id.slice(0, i); };
  for (const step of allFlat) {
    if (step.step_type !== 'loop') continue;
    const loop = step as LoopStep;
    const pairs = loop.collect ?? [];
    if (pairs.length === 0) continue;
    const directChildren = getChildren(loop);
    for (const pair of pairs) {
      // ②链条逐环核（先跑——诊断更精准）：循环体内 parallel 标注步骤若产出该变量,
      // 它到 loop 之间每层中间容器都须声明之;漏声明=断链 error 点名断层
      let chainBroken = false;
      const walk = (nodes: StepNode[]) => {
        for (const n of nodes) {
          const isParallelStep = (n.step_type === 'call' && (n as CallStep).parallel) || (n.step_type === 'subtask' && (n as SubtaskStep).parallel);
          const produces = isParallelStep && (
            (n.outputs ?? []).some(o => o.name === pair.unitVar)
            || (n.step_type === 'call' && ((n as CallStep).output_mapping ?? []).some(m => m.to === pair.unitVar)));
          if (produces) {
            // 从 n 往上走到 loop,途经每层容器核声明
            let cur = parentOf(n.step_id);
            while (cur && cur !== loop.step_id) {
              const mid = findById(cur);
              if (mid && CONTAINER_STEP_TYPES.has(mid.step_type) && mid.step_type !== 'branch') {
                const declares = (mid.outputs ?? []).some(o => o.name === pair.unitVar);
                if (!declares) {
                  chainBroken = true;
                  errors.push({ kind: 'validate', rule: 'S16', severity: 'error',
                    message: `collect 变量 "${pair.unitVar}" 在容器 "${cur}" 断链——并行步骤 "${n.step_id}" 的产出要经该容器边界上行到 loop "${loop.step_id}" 的收集清单,该容器未声明 + → ${pair.unitVar},子层产出到不了收集边界（收割链静默断,运行期丢产物账面不响）`,
                    step_id: cur });
                }
              }
              cur = parentOf(cur);
            }
          }
          if (hasChildren(n)) walk(getChildren(n));
        }
      };
      walk(directChildren);
      if (chainBroken) continue;   // 断链已点名——无人供必然也真,不再叠报模糊版
      // ①collect 供给核（全树面——串行收集走轮末传送带,深层步骤产出写 root 即合法供给,
      // 不要求直接子级边界声明;首版误伤嵌套 loop 深层产出的合法形态,当场收窄）：
      // 循环体全树内没有任何步骤产出该单项变量=点名无人供,收集清单恒空
      let suppliedAnywhere = false;
      const scan = (nodes: StepNode[]) => {
        for (const n of nodes) {
          if ((n.outputs ?? []).some(o => o.name === pair.unitVar)
            || (n.step_type === 'call' && ((n as CallStep).output_mapping ?? []).some(m => m.to === pair.unitVar))) { suppliedAnywhere = true; return; }
          if (hasChildren(n)) { scan(getChildren(n)); if (suppliedAnywhere) return; }
        }
      };
      scan(directChildren);
      if (!suppliedAnywhere) {
        errors.push({ kind: 'validate', rule: 'S16', severity: 'error',
          message: `loop "${loop.step_id}" collect 点名的变量 "${pair.unitVar}" 无人供给——循环体内没有任何步骤把它声明为产出（+ → ${pair.unitVar}）;点名无人供=收集清单恒空,产物静默丢失`,
          step_id: loop.step_id });
      }
    }
  }
}

function validateAsyncParallel(ast: SpecAST, allFlat: StepNode[], errors: ValidationError[]) {
  if (!ast.steps) return;
  const findAncestors = (stepId: string): StepNode[] => {
    const out: StepNode[] = [];
    const segs = stepId.split('.');
    for (let i = 1; i < segs.length; i++) {
      const aid = segs.slice(0, i).join('.');
      const a = allFlat.find(st => st.step_id === aid);
      if (a) out.push(a);
    }
    return out;
  };
  for (const step of allFlat) {
    const isAsyncCall = step.step_type === 'call' && (step as CallStep).parallel;
    // case 就是 branch 下的 subtask——parallel 宿主三型（2026-08-13 作者定）// @a: anc-step-parallel
    const isAsyncSubtask = (step.step_type === 'subtask' || step.step_type === 'case')
      && (step as SubtaskStep).parallel;
    if (!isAsyncCall && !isAsyncSubtask) continue;
    const loc = step.source_location?.line_start;
    const ancestors = findAncestors(step.step_id);
    const hostLoop = [...ancestors].reverse().find(a => a.step_type === 'loop') as LoopStep | undefined;
    // ① call parallel 宿主限定：必须 loop 体内（收齐点=宿主循环边界；兄弟位并发用 subtask parallel 包一层）
    if (isAsyncCall && !hostLoop) {
      errors.push(ve('S12', 'error',
        `call parallel "${step.step_id}" 不在 loop 体内——异步派发的收齐点是宿主循环容器边界；兄弟位并发把 call 包进 [subtask parallel]`,
        step.step_id, loc));
      continue;
    }
    // 宿主容器 = 最近任务容器（subtask/case/loop）祖先（2026-08-13 作者定形）：case 就是
    // branch 下的 subtask 自身即边界;branch 是唯一透明结构;loop 无远程特权（最近者即边界——
    // 推演根据:失败走边界 retry,越过更近事务则 retry 归属抖动）。
    const hostContainer = [...ancestors].reverse().find(a =>
      a.step_type === 'subtask' || a.step_type === 'case' || a.step_type === 'loop');
    // ④ 收敛边界必须存在：顶层裸挂或只有 branch 祖先都算无收敛边界——原"顶层平铺=实例边界"读法作废。
    if (!hostContainer) {
      const inBranch = ancestors.some(a => a.step_type === 'branch');
      errors.push(ve('S12', 'error',
        `parallel 标注步骤 "${step.step_id}" 无收敛边界（${inBranch ? 'branch 是选择结构不作收齐边界' : '顶层裸挂'}）——收敛边界=最近任务容器,把它包进一层 [subtask]（兄弟并发）或 [loop for-each ... collect]（遍历派发）`,
        step.step_id, loc));
      continue;
    }
    // S13 宿主侧：容器头为标注步骤的输出声明累加器（= 初值）非法——值经收割写入，
    // 累加器语义无从成立（改用 collect 收集列表）。// @a: anc-rule-s13
    {
      const stepOutNames = new Set((step.outputs ?? []).map(o => o.name));
      for (const out of hostContainer.outputs ?? []) {
        if (out.default !== undefined && stepOutNames.has(out.name)) {
          errors.push(ve('S13', 'error',
            `容器 "${hostContainer.step_id}" 的输出 "${out.name}" 声明累加器初值，但它由 parallel 标注步骤 "${step.step_id}" 异步产出——无共享空间可累加，改用 collect 收集列表`,
            hostContainer.step_id, hostContainer.source_location?.line_start));
        }
      }
    }
    // ② 无 Future：标注步骤输出在宿主容器域内不可被其他步骤消费
    const outNames = new Set<string>([
      ...(isAsyncCall ? ((step as CallStep).output_mapping ?? []).map(m => m.to) : []),
      ...(step.outputs ?? []).map(o => o.name),
    ]);
    if (outNames.size === 0) continue;
    const subtreeIds = new Set([step.step_id, ...flattenSteps(hasChildren(step) ? getChildren(step) : []).map(st => st.step_id)]);
    const hostBody = getChildren(hostContainer).flatMap(c => [c, ...flattenSteps(hasChildren(c) ? getChildren(c) : [])]);
    for (const other of hostBody) {
      if (subtreeIds.has(other.step_id)) continue;   // 自身子树内部消费是子实例内事
      for (const binding of other.inputs ?? []) {
        if (outNames.has(binding.source)) {
          errors.push(ve('S12', 'error',
            `步骤 "${other.step_id}" 在容器内消费了 parallel 标注步骤 "${step.step_id}" 的输出 "${binding.source}"——值可能未回（无 Future），只可在容器边界后消费`,
            other.step_id, other.source_location?.line_start));
        }
      }
      if (other.step_type === 'call') {
        for (const m of (other as CallStep).param_mapping ?? []) {
          if ('literal_value' in m) continue;   // 字面量项非变量消费边（0044）// @a: anc-step-call-literal
          if (outNames.has(m.from)) {
            errors.push(ve('S12', 'error',
              `call "${other.step_id}" 在容器内以 "${m.from}" 为入参消费了 parallel 标注步骤 "${step.step_id}" 的输出——值可能未回（无 Future）`,
              other.step_id, other.source_location?.line_start));
          }
        }
      }
    }
  }
}

// S10: spec with steps must have ≥1 step; spec without steps must have goal+outputs // @a: anc-rule-s10
function structuralRuleS10(ast: SpecAST, errors: ValidationError[]) {
  if (ast.steps !== undefined) {
    // Has Steps section — must contain at least one step
    if (ast.steps.length === 0) {
      errors.push(ve('S10', 'error', '有 Steps 的 Spec 至少包含一个步骤'));
    }
  } else {
    // No Steps — capability declaration must have Goal and Outputs
    if (!ast.header.goal?.trim()) {
      errors.push(ve('S10', 'error', '无 Steps 的 Spec（能力声明）必须有 Goal'));
    }
    if (!ast.header.outputs || ast.header.outputs.length === 0) {
      errors.push(ve('S10', 'error', '无 Steps 的 Spec（能力声明）必须有 Outputs'));
    }
  }
}

// ===== C1-C6: Control flow rules =====

function controlFlowRules(ast: SpecAST, errors: ValidationError[]) {
  if (!ast.steps) return;
  const allFlat = flattenSteps(ast.steps);
  const stepMap = new Map(allFlat.map(s => [s.step_id, s]));

  for (const step of allFlat) {
    const loc = step.source_location?.line_start;

    // C1: case only as direct child of branch // @a: anc-rule-c1
    if (step.step_type === 'case') {
      const parentId = step.step_id.includes('.') ? step.step_id.slice(0, step.step_id.lastIndexOf('.')) : null;
      const parent = parentId ? stepMap.get(parentId) : undefined;
      if (!parent || parent.step_type !== 'branch') {
        errors.push(ve('C1', 'error', `Case step "${step.step_id}" is not a direct child of a branch`, step.step_id, loc));
      }
    }

    // C2: branch children must all be case, ≥1 (single case = if-then) // @a: anc-rule-c2
    if (step.step_type === 'branch') {
      const children = getChildren(step);
      const nonCaseChildren = children.filter(c => c.step_type !== 'case');
      if (nonCaseChildren.length > 0) {
        errors.push(ve('C2', 'error', `Branch "${step.step_id}" children must all be case steps`, step.step_id, loc));
      }
      if (children.length < 1) {
        errors.push(ve('C2', 'error', `Branch "${step.step_id}" must have at least 1 case child`, step.step_id, loc));
      }
    }

    // C3: break/continue only inside loop；带目标时目标必须是自身祖先循环 // @a: anc-rule-c3
    if (step.step_type === 'break' || step.step_type === 'continue') {
      const loopAncestor = findAncestor(step.step_id, stepMap, s => s.step_type === 'loop');
      if (!loopAncestor) {
        errors.push(ve('C3', 'error', `${step.step_type} step "${step.step_id}" is not inside a loop`, step.step_id, loc));
      }
      const target = (step as import('./ast-types.js').BreakStep | import('./ast-types.js').ContinueStep).target_loop;
      if (target !== undefined) {
        const targetNode = stepMap.get(target);
        if (!targetNode) {
          errors.push(ve('C3', 'error', `${step.step_type} step "${step.step_id}" target "${target}" does not exist（目标步骤号不存在）`, step.step_id, loc));
        } else if (targetNode.step_type !== 'loop') {
          errors.push(ve('C3', 'error', `${step.step_type} step "${step.step_id}" target "${target}" is not a loop（目标须是 loop 步骤）`, step.step_id, loc));
        } else if (!(step.step_id.startsWith(target + '.'))) {
          // 祖先判定=步骤号前缀（分层编号即层级关系）——非祖先循环不可指（跨层跳转禁,与 HopSop 流控目标契约同构）
          errors.push(ve('C3', 'error', `${step.step_type} step "${step.step_id}" target "${target}" is not an ancestor loop（目标须是自身的祖先循环——不可指向同级/未来/无包含关系的循环）`, step.step_id, loc));
        }
      }
    }

    // C6: check must be inside subtask or case // @a: anc-rule-c6
    if (step.step_type === 'check') {
      const containerAncestor = findAncestor(step.step_id, stepMap, s => s.step_type === 'subtask' || s.step_type === 'case');
      if (!containerAncestor) {
        errors.push(ve('C6', 'error', `Check step "${step.step_id}" must be inside a subtask or case`, step.step_id, loc));
      }
    }

    // P11: check fixed signature — exactly one bool slot + one text|yaml slot // @a: anc-rule-p11
    // check 是内置验证算子，固定输出签名（封闭）：恰好 bool（判定槽）+ text（说明槽），
    // 引擎按类型定位（[[exec-engine#^anc-exec-check-verdict]]）。不能多/少/换类型。
    // 说明槽双档（^anc-exec-check-escalate 升格半边）:text（缺省档）| yaml（结构化缺口——
    // escalatable 的进展指纹载体）。E1/E2 两规则正反成对:
    // E1 escalatable 而说明槽非 yaml → error 指路;
    // E2 非 escalatable 的 check 说明槽为 yaml → 合法（结构化说明不专属升层）,但 gap 里写
    //    escalate:true 无效——运行期 warn（declared-or-flagged,引擎分派侧管）。
    if (step.step_type === 'check') {
      const outs = step.outputs ?? [];
      const boolCount = outs.filter(o => o.type === 'bool').length;
      const noteCount = outs.filter(o => o.type === 'text' || o.type === 'yaml').length;
      if (!(outs.length === 2 && boolCount === 1 && noteCount === 1)) {
        errors.push(ve('P11', 'error',
          `Check step "${step.step_id}" must declare exactly two outputs: one bool (verdict) + one text|yaml (explanation), got [${outs.map(o => o.type).join(', ') || 'none'}]`,
          step.step_id, loc));
      }
      // E1: escalatable 授权前提——说明槽必须 yaml（结构化缺口才有 escalate/need 保留字段可写）
      // @a: anc-exec-check-escalate
      if ((step as CheckStep).escalatable && !outs.some(o => o.type === 'yaml')) {
        errors.push(ve('E1', 'error',
          `Check step "${step.step_id}" declares escalatable but explanation slot is not yaml — 升层缺口须结构化（说明槽改 yaml,escalate/need 为保留字段）`,
          step.step_id, loc));
      }
    }

    // C5: loop must have reachable termination path // @a: anc-rule-c5
    // for-each 形态豁免——列表耗尽即结构性终止,不需要 break/exit(此前 5 个 for-each 示例全被误报)。
    if (step.step_type === 'loop' && !getForEach(step)) {
      if (!hasTerminationPath(step as LoopStep)) {
        errors.push(ve('C5', 'warn', `Loop "${step.step_id}" has no reachable termination path (break/exit)`, step.step_id, loc));
      }
    }
  }

  // C4: warn about unreachable steps after exit/break // @a: anc-rule-c4
  checkUnreachableAfterExit(ast.steps, errors);

  // C7: check final must follow all exploratory steps; after it only commit-phase
  // steps (commit/exit/other check final) are allowed — "explore→verify→commit" in one
  // container is the canonical transaction shape (2026-08-10 作者改判). // @a: anc-rule-c7
  const isCheckFinal = (s: StepNode) => s.step_type === 'check' && (s as CheckStep).is_finally;
  // on_fail 入提交段白名单（^anc-step-on-fail 位置约束=check final 之后容器末位——S15 与 C7
  // 两规则钦定同一形态,不入名单则标准形态 validate 必红,四次复审实抓互斥矛盾）。
  // 兜底块非探索步骤:只在失败路径执行,不破'check final 后无探索'语义。// @a: anc-rule-s15
  const isCommitPhase = (s: StepNode) => isCheckFinal(s) || s.step_type === 'commit' || s.step_type === 'exit' || s.step_type === 'on_fail';
  for (const step of allFlat) {
    if (isCheckFinal(step)) {
      const loc = step.source_location?.line_start;
      // Must be inside a subtask
      const subtaskAncestor = findAncestor(step.step_id, stepMap, s => s.step_type === 'subtask');
      if (!subtaskAncestor) {
        errors.push(ve('C7', 'error',
          `Check final step "${step.step_id}" must be inside a subtask`,
          step.step_id, loc));
        continue;
      }
      // After the first check final, only commit-phase steps may follow
      const parentId = step.step_id.includes('.') ? step.step_id.slice(0, step.step_id.lastIndexOf('.')) : null;
      const parent = parentId ? stepMap.get(parentId) : undefined;
      if (parent && CONTAINER_STEP_TYPES.has(parent.step_type)) {
        const siblings = getChildren(parent);
        const idx = siblings.findIndex(s => s.step_id === step.step_id);
        for (let i = idx + 1; i < siblings.length; i++) {
          const sib = siblings[i];
          if (!isCommitPhase(sib)) {
            errors.push(ve('C7', 'error',
              `Check final step "${step.step_id}" marks the end of exploratory work — only commit/exit/check final may follow, but exploratory step "${sib.step_id}" (${sib.step_type}) does`,
              step.step_id, loc));
            break;
          }
        }
      }
    }
  }
}

function checkUnreachableAfterExit(steps: StepNode[], errors: ValidationError[]) {
  scanSiblingList(steps, errors);

  for (const step of steps) {
    const children = getChildren(step);
    if (children.length > 0) {
      if (step.step_type === 'branch') {
        for (const c of children) {
          checkUnreachableAfterExit(getChildren(c), errors);
        }
      } else {
        checkUnreachableAfterExit(children, errors);
      }
    }
  }
}

function scanSiblingList(siblings: StepNode[], errors: ValidationError[]) {
  for (let i = 0; i < siblings.length - 1; i++) {
    const step = siblings[i];
    if (step.step_type === 'exit' || step.step_type === 'break') {
      const next = siblings[i + 1];
      const loc = next.source_location?.line_start;
      errors.push(ve('C4', 'warn', `Step "${next.step_id}" is unreachable after ${step.step_type} step "${step.step_id}"`, next.step_id, loc));
      break;
    }
  }
}

function hasTerminationPath(loop: LoopStep): boolean {
  function scan(nodes: StepNode[] | undefined): boolean {
    if (!nodes) return false;
    for (const n of nodes) {
      if (n.step_type === 'break' || n.step_type === 'exit') return true;
      if (n.step_type === 'loop') continue; // nested loop's break doesn't terminate outer
      const children = getChildren(n);
      if (children.length > 0 && scan(children)) return true;
    }
    return false;
  }
  return loop.max_iterations !== undefined || scan(loop.children);
}

// ===== V1-V6: Variable rules =====

interface Scope {
  // 变量名 → 声明类型字符串（概念层本有类型，scope 忠实保留供 V8/C8 类型感知；类型未知记 ''）。
  declared: Map<string, string>;
  parent?: Scope;
}

// enum 成员台账（28 轮 review:设计明文"变量名不得与作用域内任何 enum 成员重名",原实现只在
// 产出位做单向检查——反向〔后声明的 enum 成员撞已有变量〕与 Inputs/for-each/call 映射位全放行。
// 扁平命名空间下声明顺序无语义:预扫全 spec 建台账,六变量位同闸查询即天然覆盖双向）。
// 类型形态两种:enum(...) 与 [enum(...)]（列表元素 enum 经 itemVar 剥括号入作用域,成员同参与
// C8 裸字消歧）。// @a: anc-rule-v2
function collectEnumMembers(ast: SpecAST): Map<string, string> {
  const ledger = new Map<string, string>();   // 成员名 → 声明处描述（首见者胜,报文用）
  const scan = (typeStr: string | undefined, owner: string) => {
    const t = (typeStr ?? '').trim();
    const m = /^enum\((.+)\)$/.exec(t) ?? /^\[enum\((.+)\)\]$/.exec(t);
    if (!m) return;
    for (const member of m[1].split(',').map(x => x.trim())) {
      if (member && !ledger.has(member)) ledger.set(member, owner);
    }
  };
  for (const v of ast.header.inputs ?? []) scan(v.type, `Inputs 变量 "${v.name}"`);
  const walk = (nodes: StepNode[]) => {
    for (const s of nodes) {
      for (const out of s.outputs ?? []) scan(out.type, `变量 "${out.name}"`);
      if (hasChildren(s)) walk(getChildren(s));
    }
  };
  if (ast.steps) walk(ast.steps);
  return ledger;
}
function enumMemberCollisionError(ledger: Map<string, string>, name: string, where: string, stepId?: string, line?: number): ValidationError | null {
  const owner = ledger.get(name);
  if (owner === undefined) return null;
  return ve('V2', 'error',
    `${where} "${name}" 与 ${owner} 的 enum 成员重名——变量名不得与枚举成员同名（条件裸字消歧依赖二者不混淆）`,
    stepId, line);
}

function variableRules(ast: SpecAST, errors: ValidationError[], isFragment?: boolean) {
  const enumLedger = collectEnumMembers(ast);   // @a: anc-rule-v2
  // S14: Id 函数签名按名对应 Inputs/Outputs（写了就必须对——签名错误比没有更误导,
  // 同 P4 半写即错原则）。签名只列名字,类型归 Inputs/Outputs 展开块。// @a: anc-rule-s14
  if (ast.header.signature) {
    // 签名函数名名位=Unicode 名位（与 parser.ts 签名收名正则同宽——2026-08-30 审计实抓两侧撕裂:
    // parser 收中文、本侧只认 ASCII,设计明文合法的中文签名被误拒）。// @a: anc-rule-s14
    const sm = ast.header.signature.match(/^[\w\u4e00-\u9fff][\w\u4e00-\u9fff-]*\s*\(([^)]*)\)\s*(?:->\s*(.*))?$/);
    if (!sm) {
      errors.push(ve('S14', 'error',
        `Id 签名格式非法: "${ast.header.signature}"——应为 func(in1, in2) -> out1, out2`, undefined, undefined));
    } else {
      const names = (segRaw: string | undefined) => (segRaw ?? '').split(',').map(x => x.trim()).filter(Boolean);
      const sigIns = names(sm[1]);
      const sigOuts = names(sm[2]);
      const declIns = (ast.header.inputs ?? []).map(v2 => v2.name);
      const declOuts = (ast.header.outputs ?? []).map(o => o.name);
      const diff = (a: string[], b: string[], what: string, side: string) => {
        for (const n of a) if (!b.includes(n)) {
          errors.push(ve('S14', 'error', `Id 签名${side} "${n}" 不在 ${what} 声明中（签名与展开块必须按名对应）`, undefined, undefined));
        }
        for (const n of b) if (!a.includes(n)) {
          errors.push(ve('S14', 'error', `${what} 声明 "${n}" 未出现在 Id 签名${side}（写了签名就必须完整对应）`, undefined, undefined));
        }
      };
      diff(sigIns, declIns, 'Inputs', '参数');
      diff(sigOuts, declOuts, 'Outputs', '返回');
    }
  }

  // V5: input names unique (header-level, no steps needed) // @a: anc-rule-v5
  if (ast.header.inputs) {
    const seen = new Set<string>();
    for (const v of ast.header.inputs) {
      if (seen.has(v.name)) {
        errors.push(ve('V5', 'error', `Duplicate input variable: "${v.name}"`));
      }
      seen.add(v.name);
      const tr = typeReservedError(v.name, 'Inputs 变量');   // @a: anc-rule-type-reserved
      if (tr) errors.push(tr);
      const ig = identGateError(v.name, 'Inputs 变量名');   // @a: anc-rule-v2b
      if (ig) errors.push(ig);
      const kr = keywordReservedError(v.name, 'Inputs 变量');   // @a: anc-i18n-keyword-reserved
      if (kr) errors.push(kr);
      const ec = enumMemberCollisionError(enumLedger, v.name, 'Inputs 变量');   // @a: anc-rule-v2
      if (ec) errors.push(ec);
    }
  }

  // V7: input variable types must be valid (ValueTypeString or declared TypeDecl) // @a: anc-rule-v7
  if (ast.header.inputs) {
    const declaredTypes = new Set<string>();
    if (ast.header.types) {
      for (const t of ast.header.types) declaredTypes.add(t.name);
    }
    for (const v of ast.header.inputs) {
      if (!isValidTypeWithDecls(v.type, declaredTypes)) {
        // line( 形态指路与 V4 同式（review D-4——blank-2 只装了 V4,V7 位同病同治）// @a: anc-type-constraint-annotation
        const hint7 = /^\[?line\s*\(/.test(v.type) ? '。非空约束的正确写法: line(非空) 或 line(nonempty)（括号内不带空格,只认非空一个参数）' : '';
        errors.push(ve('V7', 'error',
          `Inputs 段变量 "${v.name}" 的类型 "${v.type}" 无效（须为 ValueTypeString 或已声明 TypeDecl）${hint7}`));
      }
    }

  }
  // 头部 Outputs 节与 Types 字段位类型核（todo/0064——不依赖 Inputs 节在场:原插位在
  // if (ast.header.inputs) 内,无 Inputs 的 spec 整块跳过,首轮测试当场抓）// @a: anc-rule-v7, anc-type-constraint-annotation
  {
    const declaredTypes = new Set<string>();
    for (const t of ast.header.types ?? []) declaredTypes.add(t.name);
      // 头部 Outputs 节类型核（todo/0064——历来零校验:- r: foo 静默入 AST 运行期落存在性分支;
      // V7 扩面与 Inputs 对称,同函数同指路）// @a: anc-rule-v7, anc-type-constraint-annotation
      for (const v of ast.header.outputs ?? []) {
        if (v.type === '') continue;
        if (!isValidTypeWithDecls(v.type, declaredTypes)) {
          const hintO = /^\[?line\s*\(/.test(v.type) ? '。非空约束的正确写法: line(非空) 或 line(nonempty)（括号内不带空格,只认非空一个参数）' : '';
          errors.push(ve('V7', 'error',
            `Outputs 段变量 "${v.name}" 的类型 "${v.type}" 无效（须为 ValueTypeString 或已声明 TypeDecl）${hintO}`));
        }
      }
      // 头部 Types 节字段位类型核（todo/0064——B-3 批接入归一但校验半边空白,归一与校验不齐:
      // 非法字段类型静默入 AST,C8 的 typeDecls 消费在坏类型上工作）// @a: anc-rule-v7, anc-type-constraint-annotation
      for (const td of ast.header.types ?? []) {
        for (const [fname, ftype] of Object.entries(td.fields ?? {})) {
          if (ftype === '' || typeof ftype !== 'string') continue;
          if (!isValidTypeWithDecls(ftype, declaredTypes)) {
            const hintT = /^\[?line\s*\(/.test(ftype) ? '。非空约束的正确写法: line(非空) 或 line(nonempty)（括号内不带空格,只认非空一个参数）' : '';
            errors.push(ve('V7', 'error',
              `Types 节 "${td.name}" 的字段 "${fname}" 类型 "${ftype}" 无效（须为 ValueTypeString 或已声明 TypeDecl）${hintT}`));
          }
        }
      }
  }

  if (!ast.steps) return;

  const rootScope: Scope = { declared: new Map() };
  if (ast.header.inputs) {
    for (const v of ast.header.inputs) rootScope.declared.set(v.name, v.type);
  }

  const declaredTypes = new Set<string>();
  const typeDecls = new Map<string, TypeDecl>();  // C8 dotted 下钻用（带 fields）
  if (ast.header.types) {
    for (const t of ast.header.types) {
      // 自定义类型名遮蔽内置类型名=同族歧义（'x: line' 两义:内置还是自定义?）——同闸。
      // @a: anc-rule-type-reserved
      if (BUILTIN_TYPES.has(t.name)) {
        errors.push(ve('V2', 'error', `Types 段类型 "${t.name}" 遮蔽内置类型名（全局保留字）——自定义类型不得与内置类型同名（概念规则 27）`));
      }
      declaredTypes.add(t.name); typeDecls.set(t.name, t);
    }
  }
  walkVariableScope(ast.steps, rootScope, errors, declaredTypes, typeDecls, enumLedger, undefined, new Set((ast.header.tools ?? []).map(t => t.name)), isFragment);
}

// 扁平命名空间遍历（2026-08-09 概念层裁决:块级作用域废除,对标 Python 函数级作用域）。
// declared: 实例唯一命名空间的 名字→类型 表——嵌套容器不再建子 scope（容器是控制流块）。
// itemVar 例外:for-each 子句绑定只在其子树内可见（进入注册/退出移除——它语义上属"块参数"，
// Python for 的循环变量虽外泄,但 HopSpec itemVar 由引擎逐轮绑定,块外无定义时点,保持子树限定）。
// V3 废除（无嵌套作用域即无遮蔽）;V2 重定义:同名同型=同一变量多次赋值(合法)/异型=error;
// 接口填充两端（for-each 收集 T/[T]、case 填充 branch 同名）不属重名。见 design ^anc-rule-v2。
function walkVariableScope(steps: StepNode[], parentScope: Scope, errors: ValidationError[], declaredTypes: Set<string>, typeDecls: Map<string, TypeDecl>, enumLedger: Map<string, string>, containerCtx?: { branchOut?: Map<string, string> }, declaredTools?: Set<string>, isFragment?: boolean) {
  const scope = parentScope;   // 扁平:全部读写同一张表(保留 Scope 形参名减少调用面改动)

  for (const step of steps) {
    const loc = step.source_location?.line_start;

    // V11: 叶子输入声明完备性——散文引用档（2026-08-13 作者定"叶子用到的输入变量必须在节点声明"）。
    // 机判三档如实分层:body 引用=B4 error(精确)/ask present_inputs=P14 error(精确)/instruction
    // 散文=本档 warn——文本命中≠消费(实测两处命中全是提及型误报),warn 提示人核,终审归语义审计。
    // L4 只喂声明的变量:引用未声明→LLM 拿缺料上下文静默出垃圾,是本规则的为什么。// @a: anc-rule-v11
    if (EXECUTABLE_STEP_TYPES.has(step.step_type) && step.instruction) {
      const declared = new Set((step.inputs ?? []).map(b => b.source));
      const own = new Set((step.outputs ?? []).map(o => o.name));
      for (const varName of scope.declared.keys()) {
        if (declared.has(varName) || own.has(varName)) continue;
        if (varName.length < 3) continue;   // 短名(x/n)散文撞词率过高,warn 无信噪
        if (new RegExp(`(?<![\\w])${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(step.instruction)) {
          errors.push(ve('V11', 'warn',
            `步骤 "${step.step_id}" instruction 提到变量 "${varName}" 但未在 - ← 声明——是消费就补声明（L4 只喂声明的变量,缺料上下文静默出垃圾）,是散文提及可忽略`,
            step.step_id, loc));
        }
      }
    }

    // V1: input bindings reference existing variables // @a: anc-rule-v1
    if (step.inputs) {
      for (const binding of step.inputs) {
        if (!isVarVisible(binding.source, scope)) {
          errors.push(ve('V1', 'error',
            `Step "${step.step_id}" references undefined variable "${binding.source}"`,
            step.step_id, loc));
        }
      }
    }

    // V4: output type validity // @a: anc-rule-v4
    // 裸名简写（更新模式 `+ → acc`）type 为空串——引用无类型主张，V4 跳过（类型一致性归 V2）。
    if (step.outputs) {
      for (const out of step.outputs) {
        if (out.type === '') continue;
        if (!isValidTypeWithDecls(out.type, declaredTypes)) {
          // line( 开头的非法变体（含空格/错参）指路正确形态——响亮但不指路=烧一轮重试（review blank-2）// @a: anc-type-constraint-annotation
          const hint = /^\[?line\s*\(/.test(out.type) ? '。非空约束的正确写法: line(非空) 或 line(nonempty)（括号内不带空格,只认非空一个参数）' : '';
          errors.push(ve('V4', 'error',
            `Step "${step.step_id}" output "${out.name}" has invalid type: "${out.type}"${hint}`,
            step.step_id, loc));
        }
      }
    }

    // 输出注册 + V2（扁平重定义:同名同型=同一变量再赋值合法/异型=error）// @a: anc-rule-v2
    if (step.outputs) {
      for (const out of step.outputs) {
        // 内置类型名全局保留（同 else 先例同位）。// @a: anc-rule-type-reserved
        {
          const tr = typeReservedError(out.name, `Step "${step.step_id}" 产出`, step.step_id, loc);
          if (tr) errors.push(tr);
          const ig = identGateError(out.name, `Step "${step.step_id}" 产出名`, step.step_id, loc);   // @a: anc-rule-v2b
          if (ig) errors.push(ig);
          const kr = keywordReservedError(out.name, `Step "${step.step_id}" 产出`, step.step_id, loc);   // @a: anc-i18n-keyword-reserved
          if (kr) errors.push(kr);
        }
        // hop_env_ 保留命名空间：环境参数只读,业务产出禁入;ask 输出放行（覆盖链合法末级——
        // 运行时问人补值是设计内,非 spec 自改）。// @a: anc-rule-hop-env-readonly
        if (out.name.startsWith('hop_env_') && step.step_type !== 'ask') {
          errors.push(ve('V2', 'error',
            `Step "${step.step_id}" 产出 "${out.name}" 使用保留命名空间 hop_env_（spec 环境参数只读,仅 ask 步骤可输出到该命名空间）`,
            step.step_id, loc));
        }
        // else/其他 变量名判已收编 keywordReservedError 单闸（六位恒同位,27 轮 review）——
        // 本处只留 enum 成员判（成员位不在六变量位内,语义独立）。// @a: anc-rule-v2
        // enum 成员不得含 else（保留字,[case(else)] 统配——成员 else 与统配语法两义）。// @a: anc-rule-v2
        {
          const selfEm = /^enum\((.+)\)$/.exec((out.type ?? '').trim());
          if (selfEm && selfEm[1].split(',').map(x => x.trim()).some(m => m === 'else' || m === '其他')) {
            errors.push(ve('V2', 'error',
              `Variable "${out.name}" 的 enum 成员含保留字 else（[case(else)] 统配语法）(step "${step.step_id}")`,
              step.step_id, loc));
          }
        }
        // 变量名不得与任何 enum 成员重名（作者定 2026-08-09——重名会让条件裸字消歧两义:
        // `x == high` 的 high 既是变量又是枚举成员时语义不可判）。28 轮 review 改台账查询:
        // 原地扫 scope.declared 是单向的（只见已注册声明,后声明的 enum 成员撞已有变量放行）,
        // 预扫台账双向覆盖。// @a: anc-rule-v2
        {
          const ec = enumMemberCollisionError(enumLedger, out.name, `Step "${step.step_id}" 产出`, step.step_id, loc);
          if (ec) errors.push(ec);
        }
        const prior = scope.declared.get(out.name);
        if (prior !== undefined && prior !== '' && out.type && out.type !== '') {
          // 唯一同名特例:case 填充 branch 统一接口（同一变量,同型要求照常）
          const brType = containerCtx?.branchOut?.get(out.name);
          const isBranchFill = brType !== undefined && out.type.trim() === brType.trim();
          if (!isBranchFill && prior.trim() !== out.type.trim()) {
            // T vs [T] 撞名大概率是旧"同名输出自动收集"写法残留——指路 collect 子句（2026-08-09 废除旧文法）
            const looksLikeOldCollect = `[${out.type.trim()}]` === prior.trim() || `[${prior.trim()}]` === out.type.trim();
            errors.push(ve('V2', 'error',
              `Variable "${out.name}" redeclared with conflicting type "${out.type}" (was "${prior}") — 同名 = 同一变量,类型必须一致 (step "${step.step_id}")`
              + (looksLikeOldCollect ? `。若意图是 for-each 收集：旧"同名输出自动收集"文法已废除，改用 collect 子句——[loop for-each x in xs, collect <单项名> into ${out.name}]，child 写单项名` : ''),
              step.step_id, loc));
          }
        }
        // 同名同型:同一变量再赋值,不覆盖首个类型记录（保留最初声明形态,收集列表 [T] 不被单项 T 覆写）
        if (prior === undefined || prior === '') scope.declared.set(out.name, out.type);
      }
    }

    // V3 已废除（2026-08-09 扁平命名空间——无嵌套作用域即无遮蔽,同名判定全归 V2）。
    // 编号保留仅作规则史锚。// @a: anc-rule-v3

    // V9（2026-08-08 作者终定：宽容双写法）：for-each 头部子句即 listVar 的消费声明——parser
    // 自动合成消费边入 inputs（V1/S12 照常可见），不写 ← 行不缺边；作者显式再写也**完全合法、
    // 零提示**（"写了也行，不写也没错"）。V9 编号保留仅作规则史锚，无运行时检查。// @a: anc-rule-v9

    // V8: for-each 的 listVar 声明类型必须是列表 [T]（error）。// @a: anc-rule-v8
    if (getForEach(step)) {
      const listVar = getForEach(step)!.listVar;
      const declType = scope.declared.get(listVar);
      if (declType !== undefined && declType !== '' && !/^\[.+\]$/.test(declType.trim())) {
        errors.push(ve('V8', 'error',
          `loop for-each "${step.step_id}" 的 listVar "${listVar}" 声明类型为 "${declType}"，必须是列表 [T]（否则引擎把整值当单元素、只展开 1 个 child）`,
          step.step_id, loc));
      }
    }

    // V10: collect 子句静态校验（2026-08-09 随 collect 子句新增）。// @a: anc-rule-v10
    const loopCollect = step.step_type === 'loop' ? (step as LoopStep).collect : undefined;
    if (loopCollect) {
      if (!getForEach(step)) {
        errors.push(ve('V10', 'error',
          `loop "${step.step_id}" 声明 collect 子句但非 for-each 形态——collect 仅可用于 for-each 遍历`,
          step.step_id, loc));
      }
      for (const c of loopCollect) {
        // 子条①：unitVar 须有产出方（loop 体内任一后代的 + → 声明,或 call 步 output_mapping
        // 目标——两种声明形态都算）,且声明非列表型（单项端是 T）。扫全部后代=运行时语义的
        // 如实映射（unitVar 注册在 root 槽,任意深度后代写它都直落该槽——B1 等价重写正是孙辈产出）。
        // 缺产出方的运行时后果:传送带每轮读到哨兵 null,静默收出 [null,null,…]。
        const producers: { type?: string }[] = [];
        const descendants: typeof step[] = [];
        const walk = (n: typeof step) => { for (const ch of getChildren(n)) { descendants.push(ch); walk(ch); } };
        walk(step);
        for (const d of descendants) {
          for (const o of d.outputs ?? []) {
            if (o.name === c.unitVar) producers.push({ type: o.type });
          }
          if (d.step_type === 'call') {
            for (const m of (d as import('./ast-types.js').CallStep).output_mapping ?? []) {
              if (m.to === c.unitVar) producers.push({});
            }
          }
        }
        if (producers.length === 0) {
          errors.push(ve('V10', 'error',
            `loop "${step.step_id}" 的 collect 单项端 "${c.unitVar}" 无产出方——loop 体内须有步骤以 + → 声明产出它（或 call 步输出映射到它）,否则每轮收进的都是空值,收集列表会静默变成一串 null`,
            step.step_id, loc));
        } else if (producers.some(pr => pr.type && /^\[.+\]$/.test(pr.type.trim()))) {
          errors.push(ve('V10', 'error',
            `loop "${step.step_id}" 的 collect 单项端 "${c.unitVar}" 被 child 声明为列表型——单项端是每轮的单个值 T,列表由引擎收集而成,child 应声明元素类型`,
            step.step_id, loc));
        }
        const headDecl = (step.outputs ?? []).find(o => o.name === c.listVar);
        if (!headDecl) {
          errors.push(ve('V10', 'error',
            `loop "${step.step_id}" 的 collect 列表端 "${c.listVar}" 未在容器头 + → 声明`,
            step.step_id, loc));
        } else if (headDecl.type && headDecl.type !== '' && !/^\[.+\]$/.test(headDecl.type.trim())) {
          errors.push(ve('V10', 'error',
            `loop "${step.step_id}" 的 collect 列表端 "${c.listVar}" 声明类型 "${headDecl.type}" 非列表 [T]`,
            step.step_id, loc));
        }
      }
    }

    // S13: parallel 标注步骤输出禁累加器（统一模型 P0.5 改写判定对象：容器头→标注步骤）——
    // 派出去的活无共享空间可累加，其输出只走收集列表/容器边界具名导出。判定：标注步骤
    // 自身或其输出在宿主容器头声明了 = 初值。// @a: anc-rule-s13
    {
      const isAsync = (step.step_type === 'subtask' && (step as SubtaskStep).parallel)
        || (step.step_type === 'call' && (step as CallStep).parallel);
      if (isAsync) {
        const asyncOutNames = new Set((step.outputs ?? []).map(o => o.name));
        for (const out of step.outputs ?? []) {
          if (out.default !== undefined) {
            errors.push(ve('S13', 'error',
              `parallel 标注步骤 "${step.step_id}" 的输出 "${out.name}" 声明了累加器初值（= 初值）——派出去的活无共享空间可累加，要 reduce 在收齐后的步骤写`,
              step.step_id, loc));
          }
        }
        void asyncOutNames;   // 宿主容器头同名累加器检查在 validateAsyncParallel（有 allFlat 视野）
      }
    }

    // C8: branch case 条件引用的变量路径必须合法（error）。// @a: anc-rule-c8
    if (step.step_type === 'branch') {
      const cases = getChildren(step);
      for (const caseStep of cases) {
        const cond = (caseStep as CaseStep).condition;
        checkCaseCondition(cond, caseStep, scope, typeDecls, errors);
      }
      // 统配（default）case 只能放最后（[case(else)] 统配,2026-08-09 认知三改）——
      // 顺序命中语义下,统配放中间会吞掉其后全部 case,是结构错误非风格问题。// @a: anc-rule-c8
      for (let ci = 0; ci < cases.length - 1; ci++) {
        if ((cases[ci] as CaseStep).condition === 'default') {
          errors.push(ve('C8', 'error',
            `Case "${cases[ci].step_id}" 是统配（default/(...)）但不在末位——统配会吞掉其后全部 case,只能放最后`,
            cases[ci].step_id, cases[ci].source_location?.line_start));
        }
      }
    }

    // V13: call callee 插值表达式的根变量须由前序步骤产出或来自 Inputs（V1 同族核——
    // 断供=执行期解引用必然 undefined,写时红）。^anc-step-call-dynamic-callee // @a: anc-rule-v13, anc-step-call-dynamic-callee
    if (step.step_type === 'call' && (step as CallStep).callee_expr) {
      for (const rootName of collectExprRootVars((step as CallStep).callee_expr!)) {
        if (!isVarVisible(rootName, scope)) {
          errors.push(ve('V13', 'error',
            `V13: call 步骤 "${step.step_id}" 的 callee 插值表达式引用变量 "${rootName}" 无产出方——前序步骤 + → 或 Inputs 须先声明它`,
            step.step_id, loc));
        }
      }
    }

    // call 输出映射注册进命名空间。// @a: anc-rule-v1, anc-step-call
    if (step.step_type === 'call') {
      for (const om of (step as CallStep).output_mapping ?? []) {
        if (om.to) scope.declared.set(om.to, '');
      }
    }

    // act/commit/check body 校验（B4 可见集=仅 ← 输入,与运行时 BodyInterpreter 对齐;
    // check body 同文法同解释器即同受 B 系列——三十五审抓漏:ghost 变量 validate 绿运行期才炸）。// @a: anc-rule-b-all
    if ((step.step_type === 'act' || step.step_type === 'commit' || step.step_type === 'check') && (step as ActStep).body) {
      const visible = new Set<string>();
      for (const b of step.inputs ?? []) visible.add(b.name);
      // declaredTools 经 walkVariableScope 走链自顶层 ast.header.tools 传入（0089——commit 步未知函数按声明与否分档）// @a: anc-rule-b2
      checkActBodyScope((step as ActStep).body!, visible, step, errors, declaredTools, isFragment);
    }

    // B7 act/commit 形态完备（概念 ^anc-step-act free 档条款 + ^anc-step-commit body 条款）：
    // act:有 free 又带 body=error（两档互斥——标 free 说明拆不开,又给 body 说明拆得开）;
    // 无 free 无 body=warn（形态欠账:补 body 或标 free 承认现状——warn 非 error,存量平滑过渡）。
    // commit:无 body=error（作者两拍 2026-08-22 立"必须带 body",过渡期 warn;2026-08-31 到期
    // 升 error——过渡期观察实证无 body commit 的 LLM 通道四缺陷叠加,通道废止。不可逆动作
    // 最不能交给 LLM 现场发挥:循环执行的 commit 每次重放动作可能不同,幂等无从谈起）。// @a: anc-rule-b7
    if (step.step_type === 'act') {
      const act = step as ActStep;
      if (act.free && act.body) {
        errors.push(ve('B7', 'error',
          `步骤 "${step.step_id}" [act free] 不得带 hop_python body——free=拆不开的自由任务档,带 body=机械档,两档互斥（去掉 free 或去掉 body）`,
          step.step_id));
      } else if (!act.free && !act.body) {
        errors.push(ve('B7', 'warn',
          `步骤 "${step.step_id}" [act] 无 body 也未标 free——纯机械动作请补 hop_python body（执行期零 LLM）;实在拆不开的复杂任务标 [act free] 承认现状`,
          step.step_id));
      }
    }
    // free×parallel 互斥（B7 面,^anc-step-subtask-free 契约8——三轮 review 实锤:traverse dispatch
    // 门先于 expand 门,空 free parallel 被整棵派发成子实例,索计划请求落到孙进程 worker,规划方
    // 收不到;规划请求必须到达有规划权的 caller,worker 是哑执行者）。// @a: anc-rule-b7, anc-exec-subtask-free-expand
    if (step.step_type === 'subtask' && (step as SubtaskStep).free === true && (step as SubtaskStep).parallel === true) {
      errors.push(ve('B7', 'error',
        `步骤 "${step.step_id}" [subtask free parallel] 两属性互斥——free 的索计划请求必须到达有规划权的 caller,parallel 派发后的 worker 是哑执行者收不到;去掉其一（要并行,先展开成普通 subtask 再标 parallel）`,
        step.step_id));
    }
    if (step.step_type === 'commit' && !(step as CommitStep).body) {
      // 2026-08-31 作者宣布 warn→error（22 日两拍的到期兑现——过渡期观察结果=无 body commit
      // 的 LLM 通道四缺陷叠加〔零清单供给/requires_commit 件物理不可达/L5 虚构历史/算子重试
      // 重放窗口〕,升 error 使该通道消费面归零。原则:不可逆动作最不能交给 LLM 现场发挥）。
      errors.push(ve('B7', 'error',
        `步骤 "${step.step_id}" [commit] 无 hop_python body——不可逆动作必须在生成期由 body 定死（发送什么/写到哪）,执行期零裁量;参数复杂就前置步骤备好参数,body 只做最后一调`,
        step.step_id));
    }

    // 容器递归:同一张扁平表下钻（无子 scope）。itemVar 进入注册/退出移除（块参数语义）。
    if (CONTAINER_STEP_TYPES.has(step.step_type)) {
      const children = getChildren(step);
      if (children.length > 0) {
        const fe = getForEach(step);
        let itemVarShadowed: string | undefined;
        let hadItemVar = false;
        if (fe) {
          // itemVar 元素类型 = listVar 声明类型 [T] 剥括号（供 case 条件 C8 dotted 下钻）。// @a: anc-exec-parallel-foreach
          const listType = scope.declared.get(fe.listVar) ?? '';
          const elemType = /^\[(.+)\]$/.exec(listType.trim())?.[1] ?? '';
          hadItemVar = scope.declared.has(fe.itemVar);
          itemVarShadowed = scope.declared.get(fe.itemVar);
          scope.declared.set(fe.itemVar, elemType);
          // itemVar 是变量引入位——保留字同受闸（review 全谱探测抓漏:四检查位漏了 for-each 子句）。
          // @a: anc-rule-type-reserved
          const tr = typeReservedError(fe.itemVar, `Loop "${step.step_id}" for-each 变量`, step.step_id, step.source_location?.line_start);
          if (tr) errors.push(tr);
          const kr = keywordReservedError(fe.itemVar, `Loop "${step.step_id}" for-each 变量`, step.step_id, step.source_location?.line_start);   // @a: anc-i18n-keyword-reserved
          if (kr) errors.push(kr);
          const ec = enumMemberCollisionError(enumLedger, fe.itemVar, `Loop "${step.step_id}" for-each 变量`, step.step_id, step.source_location?.line_start);   // @a: anc-rule-v2
          if (ec) errors.push(ec);
        }
        // collect unitVar 同为变量引入位（listVar 经产出注册已有闸;unitVar 若无对应产出注册可漏）。
        // @a: anc-rule-type-reserved
        for (const c of (step.step_type === 'loop' ? (step as LoopStep).collect : undefined) ?? []) {
          const tr = typeReservedError(c.unitVar, `Loop "${step.step_id}" collect 单项变量`, step.step_id, step.source_location?.line_start);
          if (tr) errors.push(tr);
          const kr = keywordReservedError(c.unitVar, `Loop "${step.step_id}" collect 单项变量`, step.step_id, step.source_location?.line_start);   // @a: anc-i18n-keyword-reserved
          if (kr) errors.push(kr);
          const ec = enumMemberCollisionError(enumLedger, c.unitVar, `Loop "${step.step_id}" collect 单项变量`, step.step_id, step.source_location?.line_start);   // @a: anc-rule-v2
          if (ec) errors.push(ec);
        }
        // collect unitVar 注册：定义点=子句（同 itemVar），children 以 + → unitVar 产出单项。
        // 元素类型 = listVar 声明 [T] 剥括号。// @a: anc-rule-v10
        const loopCol = step.step_type === 'loop' ? (step as LoopStep).collect : undefined;
        const colRestore: { name: string; had: boolean; prev?: string }[] = [];
        for (const c of loopCol ?? []) {
          const listType = (step.outputs ?? []).find(o => o.name === c.listVar)?.type ?? '';
          const elemType = /^\[(.+)\]$/.exec(listType.trim())?.[1] ?? '';
          colRestore.push({ name: c.unitVar, had: scope.declared.has(c.unitVar), prev: scope.declared.get(c.unitVar) });
          scope.declared.set(c.unitVar, elemType);
        }
        // branch 统一接口上下文（唯一保留的同名特例——case 填 branch 是同一变量）。
        // for-each 收集豁免已随 collect 子句删除（unitVar/listVar 异名，无同名问题）。
        const ctx: { branchOut?: Map<string, string> } = { branchOut: containerCtx?.branchOut };
        if (step.step_type === 'branch') {
          ctx.branchOut = new Map();
          for (const out of step.outputs ?? []) ctx.branchOut.set(out.name, out.type ?? '');
        }
        walkVariableScope(children, scope, errors, declaredTypes, typeDecls, enumLedger, ctx, declaredTools, isFragment);
        if (fe) {
          if (hadItemVar) scope.declared.set(fe.itemVar, itemVarShadowed ?? '');
          else scope.declared.delete(fe.itemVar);
        }
        for (const r of colRestore) {
          if (r.had) scope.declared.set(r.name, r.prev ?? '');
          else scope.declared.delete(r.name);
        }
      }
    }
  }
}

function isVarVisible(name: string, scope: Scope): boolean {
  return scope.declared.has(name);
}

/** 收集表达式引用的全部变量名（var 节点——字段取 issue.analyzer_spec 的根 issue、下标位变量都在内）。
 * V13 callee 插值断供核用。^anc-step-call-dynamic-callee // @a: anc-rule-v13 */
function collectExprRootVars(expr: ActExpr): string[] {
  const names: string[] = [];
  const walk = (e: ActExpr): void => {
    if (e.type === 'var') names.push((e as { name: string }).name);
    for (const c of exprChildren(e)) walk(c);
  };
  walk(expr);
  return [...new Set(names)];
}

// C8: 校验 branch case 条件引用的变量路径合法。// @a: anc-rule-c8
// cond 形态：`{var} == literal` / `var != literal` / 裸 `var`（truthy）；var 可含 dotted path。
// 只校验 == / != 左侧或裸条件的变量路径，不校验右侧 literal。default（空/`default`）跳过。
function checkCaseCondition(cond: string | undefined, caseStep: StepNode, scope: Scope, typeDecls: Map<string, TypeDecl>, errors: ValidationError[]): void {
  if (cond === undefined) return;
  const t = cond.trim();
  if (t === '' || t === 'default') return;   // default case
  const loc = caseStep.source_location?.line_start;

  // ===== 段①:表达式合法性（2026-08-09 升 hop_python 表达式子集,作者裁决"一套文法两个宿主"）=====
  // {var} 花括号形态剥除（与运行时 evaluateCondition 同规则）
  const normalized = t.replace(/\{([\w.[\]]+)\}/g, '$1');   // [N] 归一化已撤——方括号下标是原生文法（IndexExpr,2026-08-09）
  const parseErrs: ParseError[] = [];
  const expr = parseExpression(normalized, parseErrs);
  if (!expr) {
    // 报准确错因（K 题实撞教训:原实现只认 ==/!= ,`count > 10` 被误报"未定义变量"——指错方向）
    const why = parseErrs.map(e => e.message.replace(/^act body: /, '')).join('; ') || '非法表达式';
    errors.push(ve('C8', 'error',
      `Case "${caseStep.step_id}" 条件不是合法的 hop_python 表达式（条件: ${t}）——${why}`, caseStep.step_id, loc));
    return;
  }
  // 条件允许内置 pure 函数（2026-08-10 作者定——零副作用可反复求值,如 len(items) > 0）；
  // 禁工具调用（有副作用）——赋值天然不可达（parseExpression 只走表达式链）
  const nonPure = findNonPureCallWith(expr, name => ACT_BUILTIN_NAMES.has(name));
  if (nonPure) {
    errors.push(ve('C8', 'error',
      `Case "${caseStep.step_id}" 条件调用非 pure 函数 "${nonPure}"（条件: ${t}）——条件只可调内置 pure 函数,工具调用前置到 act 步骤产出变量`, caseStep.step_id, loc));
    return;
  }

  // B6 判空 lint 同规覆盖 case 条件（十九审——0015 教学面写了'case 条件与 act body 同规',
  // 实装只挂 body walker:case 条件走本独立路径 lint 不触发,教学与实装脱节。同一口径同一报文）。
  // @a: anc-rule-b6
  const lintEmptyCmp = (e: ActExpr): void => {
    if (e.type === 'binary') {
      const b = e as BinaryExpr;
      if ((b.op === '!=' || b.op === '==')
          && [b.left, b.right].some(x => x.type === 'literal' && (x as { value: unknown }).value === '')) {
        errors.push(ve('B6', 'info',
          `case 条件用 ${b.op} "" 判空——字段为 null 时 None ${b.op} "" 求值 ${b.op === '!=' ? 'True(误入非空分支)' : 'False(漏判空)'}，判空建议裸真值或 len(x)==0（case "${caseStep.step_id}"）`,
          caseStep.step_id, loc));
      }
    }
    for (const c of exprChildren(e)) lintEmptyCmp(c);
  };
  lintEmptyCmp(expr);

  // ===== 段②:变量路径校验（遍历 AST 全部 var/field 链,dotted 规则不变）=====
  // 比较位置裸字兼容（作者选 C）:== / != 操作数位置的未声明裸标识符按字符串字面量,不报未定义。
  const isDeclaredRef = (e: ActExpr): boolean => {
    let cur: ActExpr = e;
    while (cur.type === 'field') cur = cur.object;
    return cur.type === 'var' && scope.declared.has(cur.name);
  };
  // 另一侧的声明类型（enum 成员校验用）:var 直取;field 链下钻此处从简不解析,返回 ''
  const declTypeOf = (e: ActExpr): string => e.type === 'var' ? (scope.declared.get(e.name) ?? '') : '';
  const walk = (e: ActExpr, inCmpOperand: boolean, otherType = ''): void => {
    if (e.type === 'binary') {
      // 裸字兼容仅限"一侧是已声明变量/字段链"的比较——另一侧裸字按字面量;
      // 两侧都未声明(nope == "a" / a == b)不兼容,照报未定义（C 方案边界,2026-08-09）。
      // enum 强化（作者定"enum 反而没必要加引号——是声明过的"）：另一侧是 enum 型时,
      // 裸字须 ∈ 枚举成员,不在列举内=写错值,当场报（比放行到运行时不匹配强）。
      const cmp = e.op === '==' || e.op === '!=';
      walk(e.left, cmp && isDeclaredRef(e.right), declTypeOf(e.right));
      walk(e.right, cmp && isDeclaredRef(e.left), declTypeOf(e.left));
      return;
    }
    if (e.type === 'unary') { walk(e.operand, false); return; }
    if (e.type === 'field' || e.type === 'index' || e.type === 'slice') {
      // 收集 field/静态数字 index 混合链:根部是 var。动态 index(非字面数字)止住类型下钻,
      // 其 index 子表达式独立走 walk 校验变量。
      const segs: string[] = [];
      let cur: ActExpr = e;
      let dynamic = false;
      while (cur.type === 'field' || cur.type === 'index' || cur.type === 'slice') {
        if (cur.type === 'field') { segs.unshift(cur.field); cur = cur.object; }
        else if (cur.type === 'slice') {
          // 切片:结果类型=对象序列本身的窄化,不入 segs 类型下钻;端点子表达式独立走 walk 校验变量。
          // @a: anc-step-act-body-slice
          if (cur.start) walk(cur.start, false);
          if (cur.stop) walk(cur.stop, false);
          dynamic = true; segs.length = 0;
          cur = cur.object;
        }
        else {
          const ie = cur.index;
          if (ie.type === 'literal' && typeof ie.value === 'number') { segs.unshift(String(ie.value)); }
          else { dynamic = true; walk(ie, false); segs.length = 0; }   // 动态下标:链校验退化为根变量存在性
          cur = cur.object;
        }
      }
      if (cur.type !== 'var') { walk(cur, false); return; }
      if (dynamic || segs.length === 0) {
        if (!scope.declared.has(cur.name)) {
          errors.push(ve('C8', 'error',
            `Case "${caseStep.step_id}" 条件引用未定义变量 "${cur.name}"（条件: ${t}）`, caseStep.step_id, loc));
        }
        return;
      }
      segs.unshift(cur.name);
      checkDottedPath(segs, t, caseStep, scope, typeDecls, errors, loc);
      return;
    }
    if (e.type === 'var') {
      if (inCmpOperand && !scope.declared.has(e.name)) {
        // enum 成员校验:另一侧是 enum 型 → 裸字必须在列举内
        const em = /^enum\((.+)\)$/.exec(otherType.trim());
        if (em) {
          const members = em[1].split(',').map(x => x.trim());
          if (!members.includes(e.name)) {
            errors.push(ve('C8', 'error',
              `Case "${caseStep.step_id}" 条件裸字 "${e.name}" 不是 ${otherType} 的成员（合法值: ${members.join(', ')}）（条件: ${t}）`, caseStep.step_id, loc));
          }
        }
        return;   // 裸字字面量兼容（enum 成员或普通字面量）
      }
      if (!scope.declared.has(e.name)) {
        errors.push(ve('C8', 'error',
          `Case "${caseStep.step_id}" 条件引用未定义变量 "${e.name}"（条件: ${t}）`, caseStep.step_id, loc));
      }
      return;
    }
    if (e.type === 'call') {
      // pure 函数调用（非 pure 已在段①拒）：实参照常走变量校验
      for (const a of e.args) walk(a.value, false);
      return;
    }
    // 推导:itemVar 绑定变量——source 原 scope 核,element/filter 在 itemVar 临时入表下核
    //（凡按"已声明与否"判断的消费面必须显式接绑定语义——盲下钻把 itemVar 报未定义,三十四审探针实抓）。
    // @a: anc-step-act-body-comprehension
    if (e.type === 'comprehension') {
      walk(e.source, false);
      const shadowed = scope.declared.get(e.itemVar);
      const had = scope.declared.has(e.itemVar);
      scope.declared.set(e.itemVar, '');
      walk(e.element, false);
      if (e.filter) walk(e.filter, false);
      if (had) scope.declared.set(e.itemVar, shadowed!); else scope.declared.delete(e.itemVar);
      return;
    }
    // 其余复合节点（ternary/list/dict/fstring…）:子表达式下钻经 exprChildren
    //（^anc-struct-expr-walk——二审实抓三字面量从未进本 walker 后,v0.10.0 收编公共遍历,新节点自动覆盖）
    for (const c of exprChildren(e)) walk(c, false);
  };
  walk(expr, false);
}

// dotted path 逐段类型下钻（原 checkCaseCondition 核心,提取复用;规则不变）。// @a: anc-rule-c8
function checkDottedPath(segs: string[], cond: string, caseStep: StepNode, scope: Scope, typeDecls: Map<string, TypeDecl>, errors: ValidationError[], loc: number | undefined): void {
  const root = segs[0];
  if (!scope.declared.has(root)) {
    errors.push(ve('C8', 'error',
      `Case "${caseStep.step_id}" 条件引用未定义变量 "${root}"（条件: ${cond}）`, caseStep.step_id, loc));
    return;
  }
  let curType = (scope.declared.get(root) ?? '').trim();
  const varExpr = segs.join('.');
  for (let i = 1; i < segs.length; i++) {
    if (curType === '') return;
    const arrM = /^\[(.+)\]$/.exec(curType);
    if (arrM) {
      if (!/^\d+$/.test(segs[i])) {
        errors.push(ve('C8', 'error',
          `Case "${caseStep.step_id}" 条件路径 "${varExpr}" 段 "${segs[i]}" 对列表类型 "${curType}" 非法（列表须数字下标）`, caseStep.step_id, loc));
        return;
      }
      curType = arrM[1].trim();
      continue;
    }
    const decl = typeDecls.get(curType);
    if (!decl) return;
    if (!(segs[i] in decl.fields)) {
      errors.push(ve('C8', 'error',
        `Case "${caseStep.step_id}" 条件路径 "${varExpr}" 中 "${segs[i]}" 不是类型 "${curType}" 的字段（合法字段: ${Object.keys(decl.fields).join(', ')}）`, caseStep.step_id, loc));
      return;
    }
    curType = decl.fields[segs[i]].trim();
  }
}

// ===== B 系列：act/commit body 校验（hop_python）===== // @a: anc-rule-b-all
// visible：进入 body 时可见的变量集（步骤 ← 输入名 ∪ 当前 scope 已声明）。
// 顺序遍历语句：赋值 target 加入 visible；if 分支各拷贝 visible（分支局部不泄漏）。
/** 步骤声明输出里结构化类型（yaml/[T]）的名字→类型表——B8 判据面。// @a: anc-rule-b8 */
function structuralOutputTypes(step: StepNode): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of step.outputs ?? []) {
    const t = o.type?.trim() ?? '';
    if (t === 'yaml' || (t.startsWith('[') && t.endsWith(']'))) m.set(o.name, t);
  }
  return m;
}

function checkActBodyScope(body: ActBody, visible: Set<string>, step: StepNode, errors: ValidationError[], declaredTools?: Set<string>, isFragment?: boolean): void {
  const loc = step.source_location?.line_start;
  const writtenOutputs = new Set<string>();
  walkActStatements(body.statements, visible, step, errors, writtenOutputs, declaredTools, isFragment);

  // B5：声明的 +→ 输出，body 应有对应赋值；缺则 warn // @a: anc-rule-b5
  for (const out of step.outputs ?? []) {
    if (!writtenOutputs.has(out.name)) {
      errors.push(ve('B5', 'warn',
        `act body 声明输出 "${out.name}" 但 body 中无对应赋值（step "${step.step_id}"）`,
        step.step_id, loc));
    }
  }
}

// B9 判据面:act/check 步 body 写侧工具的 path 实参静态形态检（2026-09-01 dr21 双撞立规——
// act 建持久目录构建期全绿真机撞 WORK_ZONE_ONLY 各烧一轮。静态拦字面形态:string literal 或
// 最左叶为 string literal 的拼接,且未被 work_zone_path() 包裹;var/复杂表达式静态不求值留
// 运行时闸,两层防线不互替。名单与 tools.ts 受控写侧同源。commit 步豁免(写 workspace 本职)。
// // @a: anc-rule-b9
export const B9_WRITE_TOOLS = new Set(['write', 'append', 'create', 'edit_file', 'makedirs', 'move', 'remove']);   // 与 tools.ts 受控写侧七件同源(删除件注册名是 remove,无 delete;edit_file 2026-09-06 review 补员——edit_file 批漏刷姊妹条;同源一致性由对账钉机检)

// B2 判据面:内置文件/编辑工具名单——引擎恒注册零声明,B2 认得不报"视为工具"warn
// (文件件此前漏列,body 调 write/read 误报——2026-09-06 R3 抽测两路独立撞)。
// 名单与 tools.ts 文件工具组同源(B9 同款先例:validator 属核心层不得 import 适配层 tools)。// @a: anc-rule-b2
// 内建通知件名单（与 tools-notify.ts 注册面同源——0089 批 commit 档新档需认它们:恒注册零声明,
// requires_commit 恒真,commit body 直执合法）。// @a: anc-rule-b2
export const B2_BUILTIN_NOTIFY_TOOLS = new Set(['dingtalk_notify', 'notify']);
/** B2 内置文件/编辑工具名单——引擎恒注册零声明,静态已知认得不报（与 tools.ts 文件工具组同源,B9 同款先例:validator 核心层不 import 适配层）。// @a: anc-rule-b2 */
export const B2_BUILTIN_FILE_TOOLS = new Set([
  'read', 'write', 'append', 'edit_file', 'search_file', 'exists', 'listdir',
  'create', 'makedirs', 'move', 'remove',
  'validate_spec', 'insert_node', 'replace_node', 'replace_children', 'renumber_steps', 'read_spec_tree',
]);
/** B2 内置工具签名表:合法参数名集+必填集——与 tools.ts 各 ToolDef input_schema 的 properties/
 * required 同源（对账钉参数名级机检,tools.test.ts——名单同源三姊妹的纵深半边）。2026-09-16 作者拍
 * 升档（决策页 todo/decision/20260916-内置工具参数名写时校验.md——move(src:/dst:) 笔误五层防线
 * 全漏烧真机一轮:原"参数错留运行期报"实况是运行期同样零校验,undefined 穿透 Node fs 报误导错,
 * 且毒行躲在条件分支后 selftest 零通电）。// @a: anc-rule-b2 */
export const B2_BUILTIN_TOOL_SIGS: ReadonlyMap<string, { props: readonly string[]; required: readonly string[] }> = new Map([
  ['read', { props: ['path', 'start_line', 'end_line'], required: ['path'] }],
  ['write', { props: ['path', 'content'], required: ['path', 'content'] }],
  ['listdir', { props: ['path'], required: ['path'] }],
  ['exists', { props: ['path'], required: ['path'] }],
  ['create', { props: ['path', 'content'], required: ['path', 'content'] }],
  ['append', { props: ['path', 'content'], required: ['path', 'content'] }],
  ['edit_file', { props: ['path', 'old_text', 'new_text'], required: ['path', 'old_text', 'new_text'] }],
  ['search_file', { props: ['path', 'pattern', 'context_lines'], required: ['path', 'pattern'] }],
  ['makedirs', { props: ['path'], required: ['path'] }],
  ['move', { props: ['from', 'to'], required: ['from', 'to'] }],
  ['remove', { props: ['path'], required: ['path'] }],
  ['validate_spec', { props: ['text', 'fragment', 'known_vars'], required: ['text'] }],
  ['insert_node', { props: ['spec_text', 'spec_is_fragment', 'work_items', 'node_path', 'fragment'], required: ['spec_text', 'node_path', 'fragment'] }],
  ['replace_node', { props: ['spec_text', 'spec_is_fragment', 'work_items', 'node_path', 'fragment', 'replacements'], required: ['spec_text'] }],
  ['replace_children', { props: ['spec_text', 'spec_is_fragment', 'work_items', 'node_path', 'fragment'], required: ['spec_text', 'node_path', 'fragment'] }],
  ['renumber_steps', { props: ['spec_text', 'spec_is_fragment', 'work_items'], required: ['spec_text'] }],
  ['read_spec_tree', { props: ['spec_text', 'mode', 'node_path', 'spec_is_fragment'], required: ['spec_text', 'mode'] }],
]);
function b9LeftmostLiteral(e: ActExpr): boolean {
  if (e.type === 'literal') return (e as { literal_kind?: string }).literal_kind === 'string';   // LiteralExpr 系 spec-ast 表外内部符号,经 ActExpr 联合暴露不单独 import——内联收窄
  if (e.type === 'binary') return b9LeftmostLiteral((e as BinaryExpr).left);
  return false;
}
function checkB9WriteScope(call: CallExpr, step: StepNode, errors: ValidationError[]): void {
  if (step.step_type !== 'act' && step.step_type !== 'check') return;
  if (!B9_WRITE_TOOLS.has(call.callee)) return;
  const pathArg = call.args.find(a => a.name === 'path');
  if (!pathArg) return;
  const v = pathArg.value;
  if (v.type === 'call' && (v as CallExpr).callee === 'work_zone_path') return;   // 包裹豁免
  if (b9LeftmostLiteral(v)) {
    errors.push(ve('B9', 'error',
      `act/check 步 body 的持久写盘归 [commit] 步骤承载,中间产物用 work_zone_path() 取路径——"${call.callee}" 的 path 是字面路径形态（step "${step.step_id}"）`,
      step.step_id, step.source_location?.line_start));
  }
}

// B10 判据面:body 读侧工具的 path 实参字面绝对路径静态检（2026-09-01 deep-validate 批立规——
// 九坑之坑 6 读侧半边:body 文件工具字面绝对路径构建期全绿,真机撞沙箱"禁绝对路径"拒,0042 卡
// 同款实撞十一次。B9 同形姊妹条:判定件收窄"字面量且以 / 开头"——B9 拦一切字面路径〔写域语义〕,
// B10 只拦绝对形态〔相对路径读侧完全合法〕。commit 不豁免——读侧无"写 workspace 本职"对应物。
// work_zone_path() 包裹豁免同 B9（其产物是合法绝对形态）。变量/复杂表达式静态不求值留运行时闸。
// // @a: anc-rule-b10
export const B10_READ_TOOLS = new Set(['read', 'exists', 'listdir', 'search_file']);   // 与运行时三级读权限链受控读侧四件同源(search_file 2026-09-06 review 补员——0070 批漏刷姊妹条;同源一致性由对账钉机检)
function b10LeftmostAbsoluteLiteral(e: ActExpr): boolean {
  if (e.type === 'literal') {
    const lit = e as { literal_kind?: string; value?: unknown };
    return lit.literal_kind === 'string' && typeof lit.value === 'string' && lit.value.startsWith('/');
  }
  if (e.type === 'binary') return b10LeftmostAbsoluteLiteral((e as BinaryExpr).left);
  return false;
}
function checkB10ReadAbsolutePath(call: CallExpr, step: StepNode, errors: ValidationError[]): void {
  if (!B10_READ_TOOLS.has(call.callee)) return;
  const pathArg = call.args.find(a => a.name === 'path');
  if (!pathArg) return;
  const v = pathArg.value;
  if (v.type === 'call' && (v as CallExpr).callee === 'work_zone_path') return;   // 包裹豁免
  if (b10LeftmostAbsoluteLiteral(v)) {
    errors.push(ve('B10', 'error',
      `文件工具路径一律 workspace 相对（沙箱禁绝对路径）——"${call.callee}" 的 path 写相对路径,实例涂鸦区用 work_zone_path() 取路径（step "${step.step_id}"）`,
      step.step_id, step.source_location?.line_start));
  }
}

function walkActStatements(
  stmts: ActStatement[], visible: Set<string>, step: StepNode,
  errors: ValidationError[], writtenOutputs: Set<string>, declaredTools?: Set<string>, isFragment?: boolean,
): void {
  const loc = step.source_location?.line_start;
  const declaredOutputs = new Set((step.outputs ?? []).map(o => o.name));
  const structTypes = structuralOutputTypes(step);
  for (const stmt of stmts) {
    if (stmt.type === 'assign') {
      checkActExpr((stmt as AssignStmt).value, visible, step, errors, declaredTools, isFragment);
      if ((stmt as AssignStmt).value.type === 'call') {
        checkB9WriteScope((stmt as AssignStmt).value as CallExpr, step, errors);   // @a: anc-rule-b9
        checkB10ReadAbsolutePath((stmt as AssignStmt).value as CallExpr, step, errors);   // @a: anc-rule-b10
      }

      const target = (stmt as AssignStmt).target;
      // B8：yaml/[T] 声明输出 ← 标量字面量 = error（0023——body 确定性,字面量必然违反运行期
      // checkValue〔^anc-type-yaml-structured〕,漏到运行期被容器 retry 乘法放大:11 子实例 39 万
      // token 白烧。只判字面量直赋,表达式/变量归运行期）。// @a: anc-rule-b8
      const declType = structTypes.get(target);
      const assignVal = (stmt as AssignStmt).value;
      if (declType && assignVal.type === 'literal') {
        errors.push(ve('B8', 'error',
          `act body 给声明为 ${declType} 的输出 "${target}" 赋标量字面量（${JSON.stringify(assignVal.value)}）——结构化声明拒标量,空态写 {} 或 []（step "${step.step_id}"${(stmt as AssignStmt).line ? `,body 第 ${(stmt as AssignStmt).line} 行` : ''}）`,
          step.step_id, loc));
      }
      // hop_env_ 保留命名空间：body 赋值目标带前缀=error（环境参数只读,B 规则族扩——body 是
      // 确定性文本静态可查）。// @a: anc-rule-hop-env-readonly
      if (target.startsWith('hop_env_')) {
        errors.push(ve('B1', 'error',
          `act body 赋值目标 "${target}" 使用保留命名空间 hop_env_（spec 环境参数只读）（step "${step.step_id}"）`,
          step.step_id, loc));
      }
      visible.add(target);                          // 赋值后该名可见
      if (declaredOutputs.has(target)) writtenOutputs.add(target);
    } else if (stmt.type === 'call') {
      checkActExpr((stmt as CallStmt).call, visible, step, errors, declaredTools, isFragment);
      checkB9WriteScope((stmt as CallStmt).call, step, errors);   // @a: anc-rule-b9
      checkB10ReadAbsolutePath((stmt as CallStmt).call, step, errors);   // @a: anc-rule-b10
    } else if (stmt.type === 'if') {
      const ifs = stmt as IfStmt;
      checkActExpr(ifs.condition, visible, step, errors, declaredTools, isFragment);
      // 分支各拷贝可见集校验；分支内新赋值的变量默认不泄漏到分支外。
      // 例外——汇合赋值：若某变量在 then 与 else 两分支都被赋值，分支后必然有值，提升到外层可见
      // （Python/TS 同样行为；否则 if/else 双分支赋值同名变量、分支后引用会被误判未定义）。
      const thenVis = new Set(visible);
      walkActStatements(ifs.then_body, thenVis, step, errors, writtenOutputs, declaredTools, isFragment);
      if (ifs.else_body) {
        const elseVis = new Set(visible);
        walkActStatements(ifs.else_body, elseVis, step, errors, writtenOutputs, declaredTools, isFragment);
        for (const v of thenVis) {
          if (!visible.has(v) && elseVis.has(v)) visible.add(v);   // then ∩ else 新增 → 提升
        }
      }
    } else {
      // B1 兜底：理论上 parser 已拒循环，AST 不应出现其他语句类型 // @a: anc-rule-b1
      errors.push(ve('B1', 'error', `act body 含非法语句类型（step "${step.step_id}"）`, step.step_id, loc));
    }
  }
}

function checkActExpr(expr: ActExpr, visible: Set<string>, step: StepNode, errors: ValidationError[], declaredTools?: Set<string>, isFragment?: boolean): void {
  const loc = step.source_location?.line_start;
  switch (expr.type) {
    case 'literal': return;
    case 'var':
      // B4：变量引用须可见；hop_env_* 前缀放行（运行时注入的只读环境参数,静态不可知具体键——
      // 未定义键运行期响亮 fail）。// @a: anc-rule-b4, anc-rule-hop-env-readonly
      if (expr.name.startsWith('hop_env_')) return;
      if (!visible.has(expr.name)) {
        errors.push(ve('B4', 'error',
          `act body 引用未定义变量 "${expr.name}"（step "${step.step_id}"）`,
          step.step_id, loc));
      }
      return;
    case 'call': {
      // B2：callee 须 ∈ 内置白名单 ∪ ToolProvider 工具（运行期）。内置则校验 arity，非内置 warn。 // @a: anc-rule-b2
      const call = expr as CallExpr;
      if (ACT_BUILTIN_NAMES.has(call.callee)) {
        const def = ACT_BUILTINS.get(call.callee)!;
        const n = call.args.length;
        if (n < def.arity.min || n > def.arity.max) {
          const range = def.arity.max === Infinity ? `≥${def.arity.min}` : `${def.arity.min}-${def.arity.max}`;
          errors.push(ve('B2', 'error',
            `act body 内置函数 "${call.callee}" 参数个数 ${n} 不符（期望 ${range}）（step "${step.step_id}"）`,
            step.step_id, loc));
        }
        // subprocess.run 具名参数专项（^anc-exec-subprocess-run——参数名是字面 validate 期可查;
        // review 抓设计"validate 拒"未实装,arity≤4 的 env=/check= 曾全绿到运行期才死）。
        // @a: anc-exec-subprocess-run
        if (call.callee === 'subprocess.run') {
          const KNOWN = new Set(['input', 'timeout', 'cwd']);
          for (const a of call.args) {
            if (a.name && !KNOWN.has(a.name)) {
              errors.push(ve('B2', 'error',
                `subprocess.run 不支持参数 "${a.name}"——只认 input=/timeout=/cwd=;check= 恒拒(失败是值,returncode 的处置写 check 步或分支),shell= 恒拒(把 shell 走私进来白名单管控全失),capture_output 不需要(输出恒捕获)（step "${step.step_id}"）`,
                step.step_id, loc));
            }
          }
          const positional = call.args.filter(a => !a.name).length;
          if (positional !== 1) {
            errors.push(ve('B2', 'error',
              `subprocess.run 只接受一个位置参数（argv 列表,命令是第一个元素）——收到 ${positional} 个（step "${step.step_id}"）`,
              step.step_id, loc));
          }
        }
      } else if (B2_BUILTIN_FILE_TOOLS.has(call.callee)) {
        // 内置文件/编辑工具：引擎恒注册零声明,静态已知——具名参数名按签名表核对
        //（2026-09-16 作者拍升档,原"认得不报,参数错留运行期报"废止——move(src:/dst:) 笔误
        // 五层防线全漏烧真机一轮。三判:未知参数名/缺必填/位置参数,报文带合法参数名集指路）。
        // @a: anc-rule-b2
        const sig = B2_BUILTIN_TOOL_SIGS.get(call.callee);
        if (sig) {
          const givenNames = call.args.filter(a => a.name).map(a => a.name!);
          const unknownArgs = givenNames.filter(n => !sig.props.includes(n));
          if (unknownArgs.length > 0) {
            errors.push(ve('B2', 'error',
              `内置工具 "${call.callee}" 没有参数 ${unknownArgs.map(n => `"${n}"`).join('/')}——它的参数是 ${sig.props.join('/')}（step "${step.step_id}"）`,
              step.step_id, loc));
          }
          const missingReq = sig.required.filter(n => !givenNames.includes(n));
          const positional = call.args.filter(a => !a.name).length;
          if (positional > 0) {
            errors.push(ve('B2', 'error',
              `内置工具 "${call.callee}" 须用具名参数（如 ${call.callee}(${sig.required.map(n => `${n}: ...`).join(', ')})）——收到 ${positional} 个位置参数（step "${step.step_id}"）`,
              step.step_id, loc));
          } else if (missingReq.length > 0) {
            errors.push(ve('B2', 'error',
              `内置工具 "${call.callee}" 缺必填参数 ${missingReq.map(n => `"${n}"`).join('/')}（参数全集 ${sig.props.join('/')}）（step "${step.step_id}"）`,
              step.step_id, loc));
          }
        }
      } else if (B2_BUILTIN_NOTIFY_TOOLS.has(call.callee)) {
        // 引擎恒注册的内建通知件（builtin-notify provider:dingtalk_notify/notify——requires_commit
        // 恒真,commit body 直执是既定形态）:认得不报,与文件件同律。名单本地维护注明与
        // tools-notify.ts 同源（B9 同款先例——validator 核心层不 import 适配层）。// @a: anc-rule-b2
      } else if (step.step_type === 'commit' && !(declaredTools?.has(call.callee)) && isFragment) {
        // fragment 模式 commit 档降 warn（R10——parseFragment 合成 header 恒无 tools,片段看不见
        // 整文声明面,error 判据材料缺失;非 free 容器 replan 合法含 commit 且全走 fragment 校验,
        // error 会误杀合法 replan。^anc-rule-fragment-mode 豁免面已登记）。// @a: anc-rule-b2, anc-rule-fragment-mode
        errors.push(ve('B2', 'warn',
          `commit 步 body 调用 "${call.callee}"——片段模式无 header 声明面,无法核对 Tools 段;整文 validate 为准（未声明的未知函数在整文验会 error）（step "${step.step_id}"）`,
          step.step_id, loc));
      } else if (step.step_type === 'commit' && !(declaredTools?.has(call.callee))) {
        // commit 步未声明的未知函数=error 拒载（0089 三批连撞:野函数名〔run_shell 之类〕静默走
        // tool_request 外包,driver 回执未真执行,引擎 completed 谎报——不可逆步动作真实性写时拦）。
        // Tools 段声明过的走下方 warn 档（standalone 有 init 对账;复用模式=作者显式声明知情——放行论据分模式见设计）。
        // @a: anc-rule-b2
        errors.push(ve('B2', 'error',
          `commit 步 body 调用 "${call.callee}"——既非内置函数也未在 Tools 段声明。不可逆步骤不接受未知函数名（静默外包给驱动方=动作真实性无闸）。要跑命令用 subprocess.run(argv列表, cwd:...);要用外部工具先在 Tools 段声明（step "${step.step_id}"）`,
          step.step_id, loc));
      } else {
        errors.push(ve('B2', 'warn',
          `act body 调用 "${call.callee}" 非内置函数——视为工具，运行期对照 ToolProvider 清单确认（step "${step.step_id}"）`,
          step.step_id, loc));
      }
      for (const arg of call.args) checkActExpr(arg.value, visible, step, errors, declaredTools, isFragment);
      return;
    }
    // B6 判空 lint（0015,info 非阻断——口径最窄:仅 `!= ""`/`== ""` 空串字面量比较两形态,
    // `!= ""` 是合法运算符组合不拒;None != "" 为 True,null 字段误入非空分支,gl-recon 归因
    // 静默全错实撞。判空钦定惯用形=裸真值/len(x)==0,概念规范 :225）。// @a: anc-rule-b6
    case 'binary': {
      const b = expr as BinaryExpr;
      if ((b.op === '!=' || b.op === '==')
          && [b.left, b.right].some(e => e.type === 'literal' && (e as { value: unknown }).value === '')) {
        errors.push(ve('B6', 'info',
          `act body 用 ${b.op} "" 判空——字段为 null 时 None ${b.op} "" 求值 ${b.op === '!=' ? 'True(误入非空分支)' : 'False(漏判空)'}，判空建议裸真值 if x: 或 len(x)==0（step "${step.step_id}"）`,
          step.step_id, loc));
      }
      for (const c of exprChildren(expr)) checkActExpr(c, visible, step, errors, declaredTools, isFragment);   // R10:补透传(0089 批漏)// @a: anc-rule-b2
      return;
    }
    // dict 键位（Python 对齐 2026-08-20——裸名键=变量引用,未定义时 JS 心智的意图多半是字面量键,
    // 专属报文指路两改法,静态期即断不漂运行期）。 // @a: anc-step-act-body-dict-key
    case 'dict_literal': {
      for (const en of expr.entries) {
        if (en.key.type === 'var' && !en.key.name.startsWith('hop_env_') && !visible.has(en.key.name)) {
          errors.push(ve('B4', 'error',
            `act body 对象字面量键 "${en.key.name}" 未定义——键写字符串加引号（{"${en.key.name}": …}）,或先给该变量赋值（变量键求值作键名,Python 同义）（step "${step.step_id}"）`,
            step.step_id, loc));
        } else {
          checkActExpr(en.key, visible, step, errors, declaredTools, isFragment);
        }
        checkActExpr(en.value, visible, step, errors, declaredTools, isFragment);   // R10:补透传 // @a: anc-rule-b2
      }
      return;
    }
    // 推导：itemVar 是绑定变量——element/filter 在扩展可见集下核,source 用原集
    // @a: anc-step-act-body-comprehension
    case 'comprehension': {
      checkActExpr(expr.source, visible, step, errors, declaredTools, isFragment);
      const inner = new Set(visible); inner.add(expr.itemVar);
      checkActExpr(expr.element, inner, step, errors, declaredTools, isFragment);   // R10:补透传 // @a: anc-rule-b2
      if (expr.filter) checkActExpr(expr.filter, inner, step, errors, declaredTools, isFragment);
      return;
    }
    // 其余节点无位置语义——扫描类下钻经 exprChildren（^anc-struct-expr-walk,新节点自动覆盖）
    default:
      for (const c of exprChildren(expr)) checkActExpr(c, visible, step, errors, declaredTools, isFragment);   // R10:补透传 // @a: anc-rule-b2
      return;
  }
}

function isVarInAncestorScope(name: string, scope: Scope): boolean {
  let s: Scope | undefined = scope;
  while (s) {
    if (s.declared.has(name)) return true;
    s = s.parent;
  }
  return false;
}

const BUILTIN_TYPES = new Set([
  // number 已除名（2026-08-31 作者定'和python一致'——数字类型只有 int/float;number 曾事实流通无概念层户口,拒收报文经 BUILTIN_TYPES 现生清单自然指路）
  'text', 'bool', 'line', 'int', 'float', 'markdown', 'yaml', 'prompt', 'HopSpec', '[line]',
]);
// 报文清单从 Set 现生成（与关键词闸 EN_KEYWORD_LIST 同纪律,单一事实源防漂移——26 轮 review 抓:
// 手写清单已含不存在的 fragment、漏 HopSpec 大小写形,首版即漂移实证）;滤 '[line]' 列表简写形。
function builtinTypeList(): string {
  return [...BUILTIN_TYPES].filter(t => !t.startsWith('[')).join('/');
}

/** Strict type check: valid only if builtin, enum, list, tuple, or explicitly declared TypeDecl */
function isValidTypeWithDecls(type: string, declaredTypes: Set<string>): boolean {
  if (BUILTIN_TYPES.has(type)) return true;
  if (type === 'line(nonempty)') return true;   // 非空约束标注（^anc-type-constraint-annotation——精确匹配,不开 line(任意参);中文形 line(非空) 在 parser 已归一）// @a: anc-type-constraint-annotation
  if (/^enum\(.+\)$/.test(type)) return true;
  // 列表形剥元素串递归核（review D-1——原通配 /^\[.+\]$/ 放行任意元素串:带空格中文变体
  // [line( 非空 )] 三层静默失效〔blank-2 指路正则的 \[? 前缀对列表形永远死代码——整串先被
  // 通配放行轮不到指路〕;[number] 废词形态端到端全静默。元素递归与 checkValue 列表分支
  // 同律,非法元素在 V4 响亮拒且经既有 hint 指路。）// @a: anc-type-constraint-annotation
  const listMatch = /^\[(.+)\]$/.exec(type);
  if (listMatch) return isValidTypeWithDecls(listMatch[1].trim(), declaredTypes);
  if (/^\(.+\)$/.test(type)) return true;    // (Type, Type) tuple syntax
  if (declaredTypes.has(type)) return true;
  return false;
}

// ===== P1-P7: Special step rules =====

function specialStepRules(ast: SpecAST, errors: ValidationError[]) {
  if (!ast.steps) return;
  const specialEnumLedger = collectEnumMembers(ast);   // call 映射位同闸（六位恒同位）// @a: anc-rule-v2
  const allFlat = flattenSteps(ast.steps);

  for (const step of allFlat) {
    const loc = step.source_location?.line_start;

    // P1: call must have callee_spec_id or callee_expr（插值形态 ^anc-step-call-dynamic-callee 放行）// @a: anc-rule-p1, anc-step-call-dynamic-callee
    if (step.step_type === 'call') {
      const cs = step as CallStep;
      if (!cs.callee_spec_id?.trim() && !cs.callee_expr) {
        errors.push(ve('P1', 'error', `Call step "${step.step_id}" is missing callee_spec_id`, step.step_id, loc));
      }
    }

    // P2【已废除】：旧 commit 语义（commit 自带审批/输出 approval）残留。新概念下授权前置到
    // confirm，commit 不自带审批，不再要求声明 approval。规则不再生效，编号位保留不重编。
    // 见 design/spec-parser.md ^anc-rule-p2 废除说明、概念 ^anc-step-commit。

    // P3: confirm response_options must have ≥1 if specified // @a: anc-rule-p3
    if (step.step_type === 'confirm') {
      const cs = step as ConfirmStep;
      if (cs.response_options && cs.response_options.length === 0) {
        errors.push(ve('P3', 'warn', `Confirm step "${step.step_id}" has empty response_options`, step.step_id, loc));
      }
      // P12: confirm 纯审批闸门——+→ 仅允许 bool（数据收集用 ask）// @a: anc-rule-p12, anc-step-confirm
      for (const out of step.outputs ?? []) {
        if (out.type !== 'bool') {
          errors.push(ve('P12', 'error',
            `Confirm step "${step.step_id}" output "${out.name}" must be bool (confirm 是纯审批闸门，数据收集用 ask 步骤)`,
            step.step_id, loc));
        }
      }
    }

    // P13: ask 步骤须声明 +→ 输出（数据收集的目标变量）// @a: anc-rule-p13, anc-step-ask
    if (step.step_type === 'ask') {
      if (!step.outputs || step.outputs.length === 0) {
        errors.push(ve('P13', 'error',
          `Ask step "${step.step_id}" must declare at least one +→ output (要 caller 提供的数据)`,
          step.step_id, loc));
      }
      // P14: ask present_inputs 必须是 ← inputs 的子集 // @a: anc-rule-p14, anc-step-ask
      const askStep = step as AskStep;
      if (askStep.present_inputs && askStep.present_inputs.length > 0) {
        const inputNames = new Set((askStep.inputs ?? []).map(b => b.name));
        for (const name of askStep.present_inputs) {
          if (!inputNames.has(name)) {
            errors.push(ve('P14', 'error',
              `Ask step "${step.step_id}" present_inputs="${name}" not declared in ← inputs (present_inputs 必须是 ← inputs 子集,driver 无值可呈现)`,
              step.step_id, loc));
          }
        }
      }
    }

    // P4 扩:流控/容器步带 hop_python body = error（2026-08-25 作者拍板 B,hopissues 0027 真病灶——
    // 引擎只执行 act/commit/check 三型的 body。流控步（exit/break/continue）与容器步
    // （subtask/loop/branch/case/on_fail）的围栏留在 instruction 成死代码零执行,而 validate
    // 全绿:作者以为计算会跑,run 必然完备性违约 failed,必死假绿。29 轮 review 扩容器五型——
    // 容器 instruction 无任何执行通道（prompt 骨架只渲染 summary+attr）,同族同闸。
    // reason/confirm/ask 不拦:instruction 进 LLM prompt/问人文本,围栏是给读者的材料非死代码。
    // // @a: anc-rule-p4
    {
      const DEAD_BODY_TYPES: Record<string, string> = {
        exit: 'exit 裸交付', break: 'break 步只写摘要行', continue: 'continue 步只写摘要行',
        subtask: '容器只组织子步——计算下沉为容器内 [act] 子步', loop: '容器只组织子步——计算下沉为循环体 [act] 子步',
        branch: '容器只组织子步——计算下沉为 case 内 [act] 子步', case: '容器只组织子步——计算下沉为 case 内 [act] 子步',
        on_fail: '容器只组织子步——计算下沉为兜底块内 [act] 子步',
      };
      const fixHint = DEAD_BODY_TYPES[step.step_type];
      if (fixHint && step.instruction && step.instruction.includes('```hop_python')) {
        errors.push(ve('P4', 'error',
          `${step.step_type} 步 "${step.step_id}" 带 hop_python body——该类型不执行计算,body 是死代码（引擎只认 act/commit/check 的 body）。${fixHint}`,
          step.step_id, loc));
      }
    }
    // P4: exit exit_outputs keys must exactly match header.outputs // @a: anc-rule-p4
    if (step.step_type === 'exit') {
      const es = step as ExitStep;
      // bare exit（无 + → 声明）= 合法简写，隐式交付 header 全部 Outputs——2026-08-09
      // 作者定（B 放宽）：Outputs 段是交付契约权威声明，exit 重抄冗余；运行时终态照读
      // 命名空间兜底（仍 None 的输出触发 warning）。半写（有声明但多/漏）仍全查。
      // 校验对象=step.outputs（exit 的 + → 经通用输出行解析；原查 es.exit_outputs 是
      // 死代码——parser 从不填该字段，它只承载 replan/运行时注入的提前退出值，
      // 2026-08-09 落定 bare-exit 语义时实测抓出）。见概念 ^anc-step-exit / design ^anc-rule-p4。
      const exitDecls = es.outputs ?? [];
      if (exitDecls.length > 0 && ast.header.outputs && ast.header.outputs.length > 0) {
        const headerOutputNames = new Set(ast.header.outputs.map(o => o.name));
        const exitKeys = new Set(exitDecls.map(o => o.name));
        for (const key of exitKeys) {
          if (!headerOutputNames.has(key)) {
            errors.push(ve('P4', 'error', `Exit step "${step.step_id}" output "${key}" is not in header outputs`, step.step_id, loc));
          }
        }
        for (const name of headerOutputNames) {
          if (!exitKeys.has(name)) {
            errors.push(ve('P4', 'error', `Exit step "${step.step_id}" is missing required output "${name}"`, step.step_id, loc));
          }
        }
      }
    }

    // P5: commit must have non-empty irreversible_action // @a: anc-rule-p5
    if (step.step_type === 'commit') {
      const cs = step as CommitStep;
      if (!cs.irreversible_action?.trim()) {
        errors.push(ve('P5', 'error', `Commit step "${step.step_id}" is missing irreversible_action description`, step.step_id, loc));
      }
    }

    // P6: subtask.retry ≥ 1, loop.max_iterations ≥ 1 // @a: anc-rule-p6
    if (step.step_type === 'subtask') {
      const st = step as SubtaskStep;
      if (st.retry !== undefined && st.retry < 1) {
        // retry=0 + [on fail] 兜底 = "失败不盲重跑直落兜底"的正当写法（引擎语义:retry 耗尽先看
        // on_fail 激活,retry=0 即立即直落）——不告警;无兜底的 retry=0 照警。见 ^anc-rule-p6。
        const hasOnFail = (st.children ?? []).some(c => c.step_type === 'on_fail');
        if (!hasOnFail) {
          errors.push(ve('P6', 'warn', `Subtask "${step.step_id}" retry=${st.retry} should be ≥ 1（按语义二选一:失败后还有事要做〔清理/降级/上报〕→ 加 [on fail] 兜底子步即不再告警;语义是"失败即整体停下"→ retry=0 无 on fail 即正确形态,本告警带理由忽略——别为消警加 on fail,兜底会把失败吞掉变成继续）`, step.step_id, loc));
        }
      }
    }
    if (step.step_type === 'loop') {
      const lt = step as LoopStep;
      if (lt.max_iterations !== undefined && lt.max_iterations < 1) {
        errors.push(ve('P6', 'warn', `Loop "${step.step_id}" max_iterations=${lt.max_iterations} should be ≥ 1`, step.step_id, loc));
      }
    }

    // P7: ResponseOption values and labels non-empty // @a: anc-rule-p7
    if (step.step_type === 'confirm') {
      const cs = step as ConfirmStep;
      if (cs.response_options) {
        for (const opt of cs.response_options) {
          if (!opt.value?.trim() || !opt.label?.trim()) {
            errors.push(ve('P7', 'warn', `Confirm step "${step.step_id}" has response_option with empty value or label`, step.step_id, loc));
          }
        }
      }
    }

    // P9: retry and adaptive only allowed on subtask and case steps // @a: anc-rule-p9
    // case 就是 branch 下的 subtask，继承 retry/adaptive 语义（见 anc-step-case）
    if (step.step_type !== 'subtask' && step.step_type !== 'case') {
      const anyStep = step as any;
      if (anyStep.retry !== undefined) {
        errors.push(ve('P9', 'error',
          `retry 属性仅适用于 subtask/case 步骤，当前步骤 "${step.step_id}" 类型为 ${step.step_type}`,
          step.step_id, loc));
      }
      if (anyStep.adaptive !== undefined) {
        errors.push(ve('P9', 'error',
          `adaptive 属性仅适用于 subtask/case 步骤，当前步骤 "${step.step_id}" 类型为 ${step.step_type}`,
          step.step_id, loc));
      }
    }

    // @model 仅路由类别步骤有效（reason/act/check/commit——与 RoutingCategory/对外契约同源;0008②:
    // 原按 EXECUTABLE_STEP_TYPES 判含 confirm/ask/call,@model 写在这三类上通过校验零提示、运行期
    // 永不消费——confirm/ask 是介入点无 LLM,call 的模型路由归子 spec 自己）。// @a: anc-rule-p9
    if (step.model_override && !MODEL_ROUTABLE_STEP_TYPES.has(step.step_type)) {
      const hint = step.step_type === 'call' ? '——call 步骤的模型路由归子 spec 自己配置'
        : (step.step_type === 'confirm' || step.step_type === 'ask') ? '——confirm/ask 是人工介入点,不调用 LLM'
        : '';
      errors.push(ve('P9', 'warn',
        `@model 标注在步骤 "${step.step_id}"（类型 ${step.step_type}）上无效果${hint}`,
        step.step_id, loc));
    }

    // P8: commit in retry/adaptive subtask requires a preceding guard step —
    // confirm OR check/check final, in document order before the commit（把关三选一
    // 教义对齐，2026-08-10 作者改判：原"仅 confirm 兜底"收窄过度；判序不判位——
    // 跟在 commit 后面的 check 不算把关）. // @a: anc-rule-p8
    if (step.step_type === 'subtask') {
      const st = step as SubtaskStep;
      if ((st.retry !== undefined && st.retry > 0) || st.adaptive === true) {
        const descendants = flattenSteps(st.children);  // document order
        // 空 [subtask free] 视作把关点（^anc-step-subtask-free/^anc-rule-p8 2026-08-27——其展开物
        // 被引擎强制含 check〔EXPANSION_NO_CHECK 运行时闸〕,静态图看不见但运行时必在;不认则
        // "commit 写在 free 外面消费交付物"的教法与本闸正面冲突,三轮 review 实锤照文档写必撞）
        const isGuard = (d: StepNode) => d.step_type === 'confirm' || d.step_type === 'check'
          || (d.step_type === 'subtask' && (d as SubtaskStep).free === true && getChildren(d).length === 0);
        let guardSeen = false;
        let hasGuardAnywhere = false;
        for (const d of descendants) if (isGuard(d)) { hasGuardAnywhere = true; break; }
        for (const d of descendants) {
          if (isGuard(d)) guardSeen = true;
          if (d.step_type === 'commit' && !guardSeen) {
            errors.push(ve('P8', 'error',
              `Subtask "${step.step_id}" has retry/adaptive but commit "${d.step_id}" has no preceding guard step (confirm or check/check final before it)`,
              step.step_id, loc));
            break;
          }
        }
        const hasCall = descendants.some(d => d.step_type === 'call');
        if (hasCall && !hasGuardAnywhere) {
          errors.push(ve('P8', 'warn',
            `Subtask "${step.step_id}" has retry/adaptive and contains call — cannot verify callee has no unguarded commit (v2+ runtime check)`,
            step.step_id, loc));
        }
      }
    }
  }

  // V6: call param_mapping + output_mapping validity (placed here with special step rules) // @a: anc-rule-v6
  for (const step of allFlat) {
    if (step.step_type !== 'call') continue;
    const cs = step as CallStep;
    const loc = step.source_location?.line_start;

    for (const pm of cs.param_mapping ?? []) {
      if (!pm.from?.trim()) {
        errors.push(ve('V6', 'error', `Call step "${step.step_id}" param_mapping has empty 'from'`, step.step_id, loc));
      }
      if (!pm.to?.trim()) {
        errors.push(ve('V6', 'error', `Call step "${step.step_id}" param_mapping has empty 'to'`, step.step_id, loc));
      }
      // V12: 映射来源禁点路径（2026-09-01 dr21 十六撞立规,作者拍 A 案响亮拒——resolveCallParams
      // 按整名查父变量,item.x 查不到静默跳过,5/5 子实例拿 undefined 全灭;字面量项豁免:"a.b"
      // 字符串含点是合法值）。// @a: anc-rule-v12
      if (!('literal_value' in pm) && pm.from?.includes('.')) {
        errors.push(ve('V12', 'error', `Call step "${step.step_id}" param_mapping 来源 "${pm.from}" 含点路径——参数映射只认整名变量,对象字段先在循环体内拆平（act body: cur_x = get(item, "x", "") 逐字段）再传`, step.step_id, loc));
      }
      const tr = typeReservedError(pm.to, `Call step "${step.step_id}" 输入映射目标`, step.step_id, loc);   // @a: anc-rule-type-reserved
      if (tr) errors.push(tr);
      const kr = keywordReservedError(pm.to, `Call step "${step.step_id}" 输入映射目标`, step.step_id, loc);   // @a: anc-i18n-keyword-reserved
      if (kr) errors.push(kr);
      const ec = enumMemberCollisionError(specialEnumLedger, pm.to, `Call step "${step.step_id}" 输入映射目标`, step.step_id, loc);   // @a: anc-rule-v2
      if (ec) errors.push(ec);
    }
    for (const om of cs.output_mapping ?? []) {
      if (!om.from?.trim()) {
        errors.push(ve('V6', 'error', `Call step "${step.step_id}" output_mapping has empty 'from'`, step.step_id, loc));
      }
      if (!om.to?.trim()) {
        errors.push(ve('V6', 'error', `Call step "${step.step_id}" output_mapping has empty 'to'`, step.step_id, loc));
      }
      {
        const tr = typeReservedError(om.to, `Call step "${step.step_id}" 输出映射目标`, step.step_id, loc);   // @a: anc-rule-type-reserved
        if (tr) errors.push(tr);
        const kr = keywordReservedError(om.to, `Call step "${step.step_id}" 输出映射目标`, step.step_id, loc);   // @a: anc-i18n-keyword-reserved
        if (kr) errors.push(kr);
        const ec = enumMemberCollisionError(specialEnumLedger, om.to, `Call step "${step.step_id}" 输出映射目标`, step.step_id, loc);   // @a: anc-rule-v2
        if (ec) errors.push(ec);
      }
      // 映射/类型声明文法歧义闸（BUG-G 实撞）：from 撞内置类型 token = 作者按类型声明习惯写了
      // `+ → domain: line`（其他步骤同形态合法）,call 行被读成"domain ← 子输出 line"静默错映射,
      // 运行期 collect 收 [null]。类型 token 做子输出名的真实场景不存在。// @a: anc-rule-v6
      if (om.from && BUILTIN_TYPES.has(om.from)) {
        errors.push(ve('V6', 'error',
          `Call step "${step.step_id}" 输出映射 "${om.to}: ${om.from}" 的来源撞类型名——call 步骤的 + → 行是输出映射（父变量: 子输出名）不是类型声明。同名直取写 "+ → ${om.to}"（裸名）,真映射写子 spec 的输出真名`,
          step.step_id, loc));
      }
      // 输出映射值位写字面量 = error（0044 随字面量入文法的另半闸）：输出映射值位是子输出名,
      // "接收一个常量"无意义,多半是方向写反。判定面与 parser paramMappingEntry 三正则逐字同
      // （同型引号成对/数字/小写 true|false|null——review 抓两闸判定面漂移）。// @a: anc-step-call-literal
      if (om.from && (/^(".*"|'.*')$/.test(om.from.trim()) || /^-?\d+(\.\d+)?$/.test(om.from.trim()) || /^(true|false|null)$/.test(om.from.trim()))) {
        errors.push(ve('V6', 'error',
          `Call step "${step.step_id}" 输出映射 "${om.to}: ${om.from}" 的值位是字面量——+ → 行是"父变量: 子输出名"（接收子 spec 的输出）,常量无处可收。字面量只在输入映射（括号内）合法,是否方向写反？`,
          step.step_id, loc));
      }
    }
  }

  // P10: declared output should have a producer (static reachability) // @a: anc-rule-p10
  // 递归遍历子树，返回该子树产出的变量名集合（+→ 输出 + exit 交付）。
  // 顺带就地检查容器：scope-creating 容器声明的 +→ 须由其子树产出，否则 warn。
  function collectProduced(node: StepNode): Set<string> {
    const produced = new Set<string>();
    // exit 交付经步骤 +→ 声明承载(下方 outputs 循环计入)——exit_outputs 专用语法 parser 未支持,
    // 原专用分支是死代码,2026-09-11 review 修复批删除
    // call 输出映射 to 侧=父变量产出（v0.10.0 修盲区:call 产出 Outputs 的合法形态原被漏计误杀）
    if (node.step_type === 'call') {
      for (const om of (node as CallStep).output_mapping ?? []) if (om.to) produced.add(om.to);
    }
    if (hasChildren(node)) {
      const childProduced = new Set<string>();
      for (const child of getChildren(node)) {
        for (const name of collectProduced(child)) childProduced.add(name);
      }
      // 容器自身的 +→ 须由子树产出（否则可能漏写产出步骤）。
      // 空 [subtask free] 豁免（^anc-step-subtask-free 2026-08-27——契约要求声明交付物而产出点
      // 天然在未来的展开物里,不豁免则合规写法必然误报;运行时 replan-outputs 闸兜住交付）
      if (SCOPE_CREATING_CONTAINERS.has(node.step_type)
        && !(node.step_type === 'subtask' && (node as SubtaskStep).free === true && getChildren(node).length === 0)) {
        // for-each parallel 的 itemVar 是引擎运行时注入的元素绑定，非子树产出 → 豁免 // @a: anc-exec-parallel-foreach
        const forEachItemVar = getForEach(node)?.itemVar;
        // collect listVar 由引擎收集产出（children 产 unitVar）→ 豁免（2026-08-09 随 collect 子句）// @a: anc-rule-v10
        const collectLists = new Set((node.step_type === 'loop' ? (node as LoopStep).collect : undefined)?.map(c => c.listVar) ?? []);
        for (const out of node.outputs ?? []) {
          if (out.name === forEachItemVar) continue;
          if (collectLists.has(out.name)) continue;
          if (!childProduced.has(out.name)) {
            errors.push(ve('P10', 'warn',
              `Container "${node.step_id}" declares output "${out.name}" but no descendant step produces it`,
              node.step_id, node.source_location?.line_start));
          }
        }
      }
      for (const name of childProduced) produced.add(name);
    }
    // 叶子/自身的 +→ 也是产出
    for (const o of node.outputs ?? []) produced.add(o.name);
    return produced;
  }

  const allProduced = new Set<string>();
  for (const top of ast.steps) {
    for (const name of collectProduced(top)) allProduced.add(name);
  }
  // Spec Outputs：声明的交付物无任何产出点（步骤 +→/call 映射/exit）→ error（2026-08-17 升档,
  // hopissues/hoplogic3/0001——hopkb 截断 spec〔产出步被误删〕过 validate 直接跑,completed 假绿
  // 到父层 reap 才炸;P4 只在 exit 在场才触发=闸挂在被删的门上,本档不依赖 exit 在场）。
  // 无 Steps 的能力声明 spec（HopTrait 形态）天然豁免——本函数仅在 ast.steps 非空时被调。
  for (const out of ast.header.outputs ?? []) {
    if (!allProduced.has(out.name)) {
      errors.push(ve('P10', 'error',
        `Declared output "${out.name}" has no producing step (no '+→', call mapping, or exit produces it)——交付契约无兑现点,漏写产出步骤或误删`,
        undefined, undefined));
    }
  }

  // P10 第三档：条件产出 warn（hopissues/0084,2026-09-10——Outputs 变量只在 branch 一臂产出,
  // 既有档全树并集判"∃ 产出点"绿,用户跑另一臂运行时完备闸才 failed;0001 显式留开的静态警告半边。
  // 必然性四规则:顺序任一子步必然即必然/branch 全臂必然才必然且须 else 臂/loop 保守不必然(max 可零迭代)/
  // 容器自声明不计必然(子树说了算;loop 头槽与空 free 豁免;on_fail 兜底块跳过——失败路径产出非必然);
  // exit 交付与 call 映射 to 侧算必然;warning 非 error——多路径交付不同物是合法设计,只提醒不拦。
  // 与 collectProduced 并存不合并:并集语义供 error 档,交集语义供本档。设计 ^anc-rule-p10 第三档。
  // @a: anc-rule-p10
  function collectAlwaysProduced(node: StepNode): Set<string> {
    const produced = new Set<string>();
    // exit 交付经步骤 +→ 声明承载(叶子路径计入)——exit_outputs 专用语法 parser 未支持,
    // 原专用分支是死代码,2026-09-11 review 修复批删除(设计 ^anc-rule-p10 第四规则段记述)
    if (node.step_type === 'call') {
      for (const om of (node as CallStep).output_mapping ?? []) if (om.to) produced.add(om.to);
    }
    if (node.step_type === 'loop') {
      // 循环体产出不计入必然（零迭代可达）——只计自身 +→ 声明（loop 头槽/collect 由引擎通道兜底交付,
      // 是自声明计必然的两处豁免之一）
      for (const o of node.outputs ?? []) produced.add(o.name);
      return produced;
    }
    if (node.step_type === 'branch') {
      const arms = getChildren(node).filter(c => c.step_type === 'case');
      if (arms.length > 0) {
        // 全臂交集——且必须存在 else 臂才有"全路径覆盖"可言:无 else 时条件全不中即跳过整个 branch,
        // 任何臂内产出都不必然
        const hasElse = arms.some(a => { const c = (a as CaseStep).condition; const t = String(c ?? '').trim().toLowerCase(); return c == null || t === '' || t === 'else' || t === 'default'; });   // parser 把 case(else) 归一存成 condition='default'
        if (hasElse) {
          let inter: Set<string> | null = null;
          for (const arm of arms) {
            const armSet = collectAlwaysProduced(arm);
            if (inter === null) { inter = armSet; }
            else { const prev: Set<string> = inter; inter = new Set([...prev].filter(x => armSet.has(x))); }
          }
          if (inter) { for (const x of inter) produced.add(x); }
        }
      }
      // branch 自声明不计必然(第四规则)——交付什么由臂交集说了算
      return produced;
    }
    if (hasChildren(node) && getChildren(node).length > 0) {
      // 第四规则(2026-09-11 review 修复批——变异复核实锤 0084 原型包一层自声明容器即穿闸):
      // 有子步的容器自声明不计必然,子树必然性说了算;on_fail 兜底块只在失败路径执行,跳过。
      // 判据带 length>0:空容器(children=[] 的空 [subtask free])落到下方叶子路径计自声明——豁免所依
      for (const child of getChildren(node)) {
        if (child.step_type === 'on_fail') continue;
        for (const name of collectAlwaysProduced(child)) produced.add(name);
      }
      return produced;
    }
    // 叶子步骤(含 exit/act/reason 等)与无子步容器(含空 [subtask free]——豁免:交付物产出点
    // 天然在未来展开物里)的自声明 +→ 计必然
    for (const o of node.outputs ?? []) produced.add(o.name);
    return produced;
  }
  const alwaysProduced = new Set<string>();
  for (const top of ast.steps) {
    for (const name of collectAlwaysProduced(top)) alwaysProduced.add(name);
  }
  for (const out of ast.header.outputs ?? []) {
    if (allProduced.has(out.name) && !alwaysProduced.has(out.name)) {
      errors.push(ve('P10', 'warn',
        `Output "${out.name}" 仅在部分完成路径产出（条件产出）——存在一条可达完成路径沿途未赋值,跑到该路径运行时完备闸将 failed。建议:按交付路径拆 call 子 spec 各带本路径 Outputs,或确保每条可达终态前都赋值`,
        undefined, undefined));
    }
  }
}

// ===== 输出值校验（value 级，供 engine.completeStep 调用）=====
// 注意：与 isValidTypeWithDecls（校验类型「声明」是否合法，解析期 V7 用）不同——
// 本函数校验运行期「值」是否匹配声明类型。v1 策略见 design/exec-engine.md ^anc-exec-output-schema-check

export interface SchemaMismatch {
  field: string;
  declared_type: string;
  actual: string;   // 实际值的截断字符串表示
  reason: string;
}

const VALUE_TRUNC = 60;

function truncateValue(v: unknown): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  return s.length > VALUE_TRUNC ? s.slice(0, VALUE_TRUNC) + '…' : s;
}

/** 校验单个值是否匹配声明类型。匹配返回 null，不匹配返回原因字符串。
 * typeDecls：自定义 TypeDecl 表（header.types）——递归字段核用（0014,缺席时退回非空检查）。 */
function checkValue(type: string, value: unknown, typeDecls?: TypeDecl[]): string | null {
  // yaml=结构化数据（2026-08-20 值模型改判,概念 ^anc-type-yaml-structured）：值须是结构
  // （对象/列表）或可 parse 成结构的字符串——归一层（coerceOutputValues）把合格字符串 parse
  // 成结构入变量空间;纯散文/parse 出标量=拒（SCHEMA_MISMATCH 反馈重做,不静默存文本——
  // 实撞:hop_python 对文本型 yaml 取字段 undefined 确定性死）。// @a: anc-type-yaml-structured
  if (type === 'yaml') {
    if (value !== null && typeof value === 'object') return null;   // 结构（对象/列表）即合格
    if (typeof value === 'string') {
      return parseYamlStructure(value) !== undefined ? null
        : '期望 yaml（结构化数据:对象/列表），实际是散文文本——直接返回结构本身（YAML/JSON 均可,不要说明散文）';
    }
    return '期望 yaml（结构化数据:对象/列表），实际是标量';
  }
  // line 多行不再拒（v2 2026-08-25——旧口径校验拒多行靠反馈自愈,dr16 实撞:修错步 fix_note
  // 两轮多行 markdown 小结重试 6 次仍多行,一个记账字段烧掉容器两条命;模型对"总结一句"天然
  // 爱写多行,语义引导治不住的交确定性归一——coerce 层换行折叠空格,内容零丢失）。
  // line 拒结构值（review 抓:旧宽松族对象/数组也放行,对象住进 line 流向字符串拼接即
  // [object Object] 毒形态;标量〔数字/bool〕归一层 String 化无害不拒）。// @a: anc-exec-line-single
  if (type === 'line' && value !== null && typeof value === 'object') {
    return '期望 line（单行字符串），实际是结构值（对象/列表）——只返回文本值本身';
  }
  if (['text', 'line', 'markdown', 'yaml', 'prompt', 'HopSpec'].includes(type)) {
    return null;
  }
  if (type === 'bool') {
    if (typeof value === 'boolean') return null;
    if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return null;
    return '期望 bool（true/false），实际非布尔值';
  }
  if (type === 'int' || type === 'float') {
    if (typeof value === 'number' && !Number.isNaN(value)) return null;
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return null;
    return `期望 ${type}（可转为数字），实际无法转为数字`;
  }
  // line(nonempty)：非空约束标注（^anc-type-constraint-annotation,2026-09-02 作者拍 B 案——
  // 约束是声明处 opt-in 的步骤级要求,裸 line 空串恒合法;标注槽空串/全空白打回,
  // 报文教执行 LLM 答不出走失败通道不交空串）。// @a: anc-type-constraint-annotation
  if (type === 'line(nonempty)') {
    if (typeof value !== 'string') return '期望 line(非空)（非空单行文本），实际非字符串';
    if (value.trim() === '') return '该槽位声明了非空约束 line(非空)——空串/全空白不合格。答得出就给实际内容;确实答不出（材料里没有/查不到）走失败通道如实上报,不要交空串或占位字样充数';
    return null;
  }
  // enum(a,b,c)：值须在列举内
  const enumMatch = /^enum\((.+)\)$/.exec(type);
  if (enumMatch) {
    const allowed = enumMatch[1].split(',').map(s => s.trim());
    if (allowed.includes(String(value).trim())) return null;
    return `期望 enum 之一 [${allowed.join(', ')}]，实际不在列举内`;
  }
  // [Type] 列表：严格要求数组，字符串一律拒绝（列表语义=数组，字符串=类型谎报）。
  // 曾"宽松接受非空字符串"是静默容错：谎报值（如 @file 指针字符串）漂过校验、污染下游，
  // 到 for-each join 才 Array.isArray 失败、聚合全空、故障漂离源头两步。契约违反须当场炸——
  // SCHEMA_MISMATCH 触发带反馈重试，driver 自然改出真数组。见 design ^anc-exec-output-schema-check。
  if (/^\[.+\]$/.test(type)) {
    if (!Array.isArray(value)) return '期望列表 [Type]，实际非数组';
    // 元素级核（0014——"逐项查值"设计承诺兑现:原只查数组在场,缺字段占位元素全过,
    // 十八讲 78 候选跑成占位+null 弃点潮）。reason 带下标供算子重试定向修正。
    const elemType = type.slice(1, -1).trim();
    for (let i = 0; i < value.length; i++) {
      const r = checkValue(elemType, value[i], typeDecls);
      if (r) return `元素[${i}] ${r}`;
    }
    return null;
  }
  // 自定义 TypeDecl：递归字段核（0014——原只查非空,占位对象全过）。
  // 声明字段全部在场且非 null/undefined（空串合法——"空串=占位无效点下游过滤"是 spec 作者
  // 显式设计,不越权拒）;字段值按字段类型递归;多余键容忍（LLM 附注无害,拒了反催重试浪费）。
  const decl = typeDecls?.find(t => t.name === type);
  if (decl) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `期望 ${type}（对象），实际${value === null || value === undefined ? '为空' : Array.isArray(value) ? '是数组' : '非对象'}`;
    }
    const obj = value as Record<string, unknown>;
    for (const [fname, ftype] of Object.entries(decl.fields)) {
      if (!(fname in obj) || obj[fname] === null || obj[fname] === undefined) {
        return `缺字段 ${fname}（${type} 声明要求）`;
      }
      const fr = checkValue(ftype, obj[fname], typeDecls);
      if (fr) return `字段 ${fname} ${fr}`;
    }
    return null;
  }
  // 未声明的自定义类型 / 元组 / 其他：仅做存在性（非空）
  if (value === null || value === undefined) {
    return `期望 ${type}，实际为空`;
  }
  return null;
}

/**
 * 校验一组输出值是否匹配步骤的 +→ 声明（OutputDecl[]）。
 * 返回不匹配项列表（空数组 = 全部通过）。
 */
// @a: anc-exec-output-schema-check
/** 围栏值恢复原语：剥围栏→YAML 解析→（可选）单键嵌套剥层。解不出返回原值。
 * recoverOutputValues 的无声明档——call 边界输出映射用（子实例值跨边界,父侧无逐字段类型声明
 * 可依,只剥壳不做类型终审;BUG-D 2026-08-13）。// @a: anc-exec-output-fence-recovery */
export function recoverFencedValue(value: unknown, expectKey?: string): unknown {
  if (typeof value !== 'string') return value;
  let s2 = value.trim();
  const fence = s2.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?\s*```$/);
  if (!fence) return value;   // 无围栏不碰（合法文本值原样）
  s2 = fence[1];
  let parsed: unknown;
  try { parsed = yamlLoad(s2); } catch { return value; }
  if (parsed === null || parsed === undefined) return value;
  if (expectKey && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === expectKey) return (parsed as Record<string, unknown>)[expectKey];
  }
  return parsed;
}

// HopSchema 赋值形态回声剥壳（家族第 6 马甲,2026-09-19 real-task-scaling 实撞——deepseek 把
// 输入渲染语法 `名: 类型 = 值` 逐字回声进输出:交付值字面成 "line = 'P4'"/"text = '原文'"。
// 毒值过校验不炸〔line 收任意字符串〕,炸在下游机械对账:污染 id 与干净 id 算集合,同一点
// 同时落进两个互斥清单——矛盾靠改产物修不平,重试必死〔单 run 355 处全污染〕。
// 判据从紧:字符串**整串**匹配 `内建类型词 = 值`（` = ` 空格形态与渲染器逐字一致）才剥,
// 引号包裹去引号;递归进结构（对象字段/列表元素——毒住在嵌套字段里,顶层档够不着）。
// 整串匹配是安全闸:text 字段装的代码恰好整串形如 `text = '...'` 会误剥——特异形态×整串
// 把误伤面压到可忽略。// @a: anc-exec-output-fence-recovery
const ECHO_TYPE_WORDS = ['bool', 'int', 'float', 'line', 'text', 'markdown', 'yaml', 'prompt', 'HopSpec', 'enum'];
const ECHO_RE = new RegExp(`^(?:${ECHO_TYPE_WORDS.join('|')})(?:\\([^)]*\\))? = ([\\s\\S]*)$`);
function stripSchemaEcho(value: unknown): unknown {
  if (typeof value === 'string') {
    const m = value.match(ECHO_RE);
    if (!m) return value;
    let inner = m[1];
    // 引号包裹去引号（渲染器值位常见 'v' 或 "v" 形态;成对才剥）
    if (inner.length >= 2 && ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"')))) {
      inner = inner.slice(1, -1);
    }
    return inner;
  }
  // 结构档保引用同一性——零污染时返回原引用（既有阶梯测试以 toBe 钉"不碰即原对象",
  // 新建等值副本会假触发"恢复留痕"）。// @a: anc-exec-output-fence-recovery
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(el => {
      const nv = stripSchemaEcho(el);
      if (nv !== el) changed = true;
      return nv;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      const nv = stripSchemaEcho(val);
      if (nv !== val) changed = true;
      out[k] = nv;
    }
    return changed ? out : value;
  }
  return value;
}

/** 围栏输出恢复阶梯（BUG-C 修 2026-08-13,deepseek/qwen/glm 系把结构化输出写成围栏文本塞字段值——
 * 盲重试同因必死,hopkb 级二 3 实例全灭实撞）：字段值为字符串且过不了声明类型检查时，
 * ①剥代码围栏 ②YAML 解析（JSON 是子集）③单键嵌套 {字段名: 值} 再剥一层——解出的值必须
 * 重过类型检查才采用,解不出原值原样进校验照常 SCHEMA_MISMATCH（@file 指针串解析后仍是
 * 字符串,照拒——与"禁止宽松接受"不冲突:这里解出真值才放行,不是放行待解析字符串）。
 * 三函数分立:恢复改值形态/校验纯判定/归一转换。见 exec-engine ^anc-exec-output-fence-recovery。
 * // @a: anc-exec-output-fence-recovery */
export function recoverOutputValues(
  decls: OutputDecl[] | undefined,
  outputs: Record<string, unknown>,
  typeDecls?: TypeDecl[],
): Record<string, unknown> {
  if (!decls || decls.length === 0) return outputs;
  const result = { ...outputs };
  for (const decl of decls) {
    // 回声剥壳最先跑（家族第 6 马甲——回声可与其他壳组合,先剥回声再走既有阶梯;
    // 不动点循环 normalizeOutputsToFixpoint 会把组合壳自然吃净）。// @a: anc-exec-output-fence-recovery
    if (decl.name in result) {
      const stripped = stripSchemaEcho(result[decl.name]);
      if (stripped !== result[decl.name]) result[decl.name] = stripped;
    }
    const v = result[decl.name];
    // 列表型显式 null 归一空列表（2026-08-23 作者定"要有宽容度"——dr10 实撞:骨架步两个列表
    // 产出本轮恰好无条目,flash 连交三轮 null 烧尽算子重试,内容全对败在空值形态。null 与 []
    // 对"没有条目"是同一语义的两种表示法。边界从紧:仅 [T] 且键在场——键整个缺失=可能忘了
    // 整个产出照拒;yaml/标量 null 照拒〔对象缺失无"空对象=没有"天然语义〕）。
    // // @a: anc-exec-output-schema-check
    if (/^\[.+\]$/.test(decl.type) && decl.name in result && (v === null || v === undefined)) {
      result[decl.name] = [];
      continue;
    }
    // 列表元素位的单键自嵌套剥壳（hopissues/0053——家族第 5 马甲:壳长在元素位非值顶层。
    // [line] 声明收到 [{"字段名": ["真值"]}]:值是列表过了"是结构"关,顶层剥不触发,元素内的壳
    // 无人剥,SCHEMA_MISMATCH 三轮同因盲死〔hopkb r15 批 8/32 灭〕。判据同源收紧:每个元素都是
    // "恰单键对象且键名=字段名"才动;剥出物数组拼平、标量就地替换;任一元素键名≠字段名整列表
    // 不碰——混合形态说明列表语义真是对象列表不是壳,照拒不救。元素循环剥至不动点(多层同病);
    // 剥后无类型终审,细节归校验层。// @a: anc-exec-output-fence-recovery
    if (Array.isArray(v) && v.length > 0 && v.every(el => {
      if (el === null || typeof el !== 'object' || Array.isArray(el)) return false;
      const ks = Object.keys(el as Record<string, unknown>);
      return ks.length === 1 && ks[0] === decl.name;
    })) {
      const flat: unknown[] = [];
      for (const el of v) {
        let inner: unknown = (el as Record<string, unknown>)[decl.name];
        // 元素内多层同键自嵌套剥至不动点
        while (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
          const ks = Object.keys(inner as Record<string, unknown>);
          if (ks.length === 1 && ks[0] === decl.name) inner = (inner as Record<string, unknown>)[decl.name];
          else break;
        }
        if (Array.isArray(inner)) flat.push(...inner);   // [{f:["a","b"]}] → ["a","b"] 拼平
        else flat.push(inner);                            // [{f:"a"},{f:"b"}] → ["a","b"] 就地替换
      }
      result[decl.name] = flat;
      continue;
    }
    // 结构值的单键自嵌套剥层（四十三审 flash 实录——LLM 直接交结构 {字段名:{真值}} 时值已是
    // 结构直过校验,自嵌套壳原样入库,下游字段访问多包一层取不到;与字符串档③同判据,结构档
    // 无需类型终审——结构已在,细节归校验层）。// @a: anc-exec-output-fence-recovery
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // 循环剥至不动点（LLM 会交多层同键自嵌套——剥一次剩 N-1 层原样入库,下游取值恒空;
      // 同键自嵌套无合法语义,剥净为止）。// @a: anc-exec-output-fence-recovery
      let cur: unknown = v;
      while (cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
        const keys = Object.keys(cur as Record<string, unknown>);
        if (keys.length === 1 && keys[0] === decl.name) cur = (cur as Record<string, unknown>)[decl.name];
        else break;
      }
      if (cur !== v) result[decl.name] = cur;
      continue;
    }
    if (typeof v !== 'string') continue;
    if (!checkValue(decl.type, v, typeDecls)) continue;   // 字符串已过检查（text/markdown 等标量）——合法围栏内容不碰。typeDecls 与终审门同判据面（0014 八审:不穿则 TypeDecl 声明的围栏串被'未声明类型非空即过'挡在阶梯外,自愈失效）
    // ① 剥代码围栏（```yaml/```json 头尾;容忍围栏前后空白）
    let s = v.trim();
    const fence = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?\s*```$/);
    if (fence) s = fence[1];
    // ② YAML 解析（失败先试引号前缀行修复 ^anc-exec-output-quoted-prefix-repair,再试散文前置
    // 截断〔壳 8〕,全炸=真散文放弃）
    let parsed: unknown;
    try { parsed = yamlLoad(s); } catch {
      const repaired = repairQuotedPrefixScalars(s);
      let ok = false;
      if (repaired !== s) {
        try { parsed = yamlLoad(repaired); ok = true; } catch { /* 落壳 8 */ }
      }
      // 壳 8: 散文前置+字段名键尾随（27b 值位先写整段分析散文再以 `字段名:` 键行挂出完好列表——
      // 整体解析炸而真值在场;找最后一个行首 `字段名:` 键行截断重解析,解出物走下方单键剥层+终审门。
      // fc M 档二轮三路 SCHEMA 三连败 88 万 tokens 实撞。设计=恢复阶梯表 8。
      // @a: anc-exec-output-fence-recovery
      if (!ok) {
        const keyIdx = s.lastIndexOf(`\n${decl.name}:`);
        if (keyIdx < 0) continue;
        try { parsed = yamlLoad(s.slice(keyIdx + 1)); } catch { continue; }
      }
    }
    if (parsed === null || parsed === undefined) continue;
    // 解析结果为字符串不预先放弃——终审门(下方 checkValue)是唯一必要守卫:进阶梯前提=原值
    // 已过不了检查,采用前提=解析结果过检查。[T] 声明字符串永过不了(@file 指针回归不破);
    // enum 声明剥围栏后的合法枚举值该恢复(review 抓漏 2026-08-13:'字符串即弃'把它误挡)。
    // ③ 单键嵌套 {字段名: 值} 剥层（模型爱把变量名写成顶键;循环剥至不动点——多层同键自嵌套同病）
    while (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed as Record<string, unknown>);
      if (keys.length === 1 && keys[0] === decl.name) parsed = (parsed as Record<string, unknown>)[decl.name];
      else break;
    }
    // 解出的值必须重过类型检查才采用;结构已解出档（0014 八审）——解析结果为对象/数组而终审
    // 拒于字段/元素细节时仍采用:类型细节交校验层报字段级明细（否则原围栏串进校验报"非对象"
    // 指错方向,弱模型会改形态而不是补字段）。纯串/标量解出物维持不采用（@file 指针回归钉）。
    if (!checkValue(decl.type, parsed, typeDecls) || (typeof parsed === 'object' && parsed !== null)) {
      result[decl.name] = parsed;
    }
  }
  return result;
}

/** 输出值级 schema 校验（engine completeStep 写 vars 前调）：按 +→ 声明逐字段核值形态，
 * 返回不匹配清单（空=通过）。纯判定零副作用——恢复归 recoverOutputValues、转换归
 * coerceOutputValues（三函数分立）。见 exec-engine ^anc-exec-output-schema-check。 */
export function validateOutputValues(
  decls: OutputDecl[] | undefined,
  outputs: Record<string, unknown>,
  typeDecls?: TypeDecl[],
): SchemaMismatch[] {
  if (!decls || decls.length === 0) return [];
  const mismatches: SchemaMismatch[] = [];
  for (const decl of decls) {
    // 声明的字段缺失或为 null（未产出）——null 与缺键同判（二十九审实撞:LLM 答
    // 'header_final: null' 原全类型放行,毒值直通呈审与下游〔4.2 人看到 null/5.1 拿 null 规划〕;
    // 合法 null 面核尽:confirm/ask 豁免 schema、叶子 +→=Null 走 default 通道、branch 未命中不写,
    // 无'LLM 交 null'的合法形态）。// @a: anc-exec-output-schema-check
    if (!(decl.name in outputs) || outputs[decl.name] === null || outputs[decl.name] === undefined) {
      mismatches.push({
        field: decl.name, declared_type: decl.type,
        actual: decl.name in outputs ? 'null' : '(缺失)', reason: '声明的输出未产出——每个 + → 声明都必须给出真值,不要输出 null',
      });
      continue;
    }
    const reason = checkValue(decl.type, outputs[decl.name], typeDecls);
    if (reason) {
      mismatches.push({
        field: decl.name, declared_type: decl.type,
        actual: truncateValue(outputs[decl.name]), reason,
      });
    }
  }
  return mismatches;
}

/** 输出边界归一转换（2026-08-11 作者定，配套 hop_python 等值严格化——声明类型是权威）：
 * 校验通过后调用，声明 int/float/number 的数字串转数字（int 截断）、声明 bool 的
 * "true"/"false" 转布尔，其余不动。校验/转换分立（validateOutputValues 保持纯判定）。
 * 变量空间由此不存跨类型值，语言内 ==/< >/in 零特例。见 design/exec-engine.md
 * ^anc-exec-output-schema-check 边界归一条款。// @a: anc-exec-output-coerce */
/** 不动点归一（2026-08-24 作者定"又是 json-yaml,这个还不能自动解决么"——恢复链结构病:
 * recover→coerce 三段接力各管一种壳〔围栏/嵌套/字符串解析〕一次穿越,LLM 的包裹会嵌套组合
 * （JSON 壳装 YAML 串/围栏装 JSON/同键嵌套装围栏……),剥出的新值不回炉就漏。历史四马甲:
 * dr9 围栏、BUG-C 单键嵌套、ppt 轮三层自嵌套、coffee3 "JSON 包 YAML 串"〔coerce 解 JSON 壳
 * →recover 剥同键嵌套→露出的 YAML 串无人再看,字符串入库,下游 .inputs 得 null 机械关炸,
 * 引擎错误灌 L6 四轮烧尽〕。
 * 不变式：只要值能通过有限次确定性变换（剥围栏/parse/剥同键壳/类型转换）到达声明类型,
 * 引擎必达之;到不了才 SCHEMA_MISMATCH。每轮 recover+coerce 后值仍变化就再来一轮,稳定即出;
 * 上限防御性 8 轮（正常 2-3 轮收敛;循环体确定性无震荡可能,上限只防未知病态输入）。
 * 宽容形态不宽容内容照旧：纯散文 parse 不出结构照拒。// @a: anc-exec-output-fence-recovery */
export function normalizeOutputsToFixpoint(
  decls: OutputDecl[],
  outputs: Record<string, unknown>,
  typeDecls?: TypeDecl[],
): Record<string, unknown> {
  let cur = outputs;
  for (let i = 0; i < 8; i++) {
    const next = coerceOutputValues(decls, recoverOutputValues(decls, cur, typeDecls), typeDecls);
    if (JSON.stringify(next) === JSON.stringify(cur)) return next;
    cur = next;
  }
  return cur;
}

/** 边界归一转换：按声明类型归一值形态（数字串→数字/bool 串→布尔/line trim/yaml 串 parse 成结构）,
 * 递归进 [T] 元素与 TypeDecl 字段。校验纯判定与转换分立。见 ^anc-exec-output-coerce。 */
export function coerceOutputValues(
  decls: OutputDecl[] | undefined,
  outputs: Record<string, unknown>,
  typeDecls?: TypeDecl[],
): Record<string, unknown> {
  if (!decls || decls.length === 0) return outputs;
  const result = { ...outputs };
  for (const decl of decls) {
    result[decl.name] = coerceValue(decl.type, result[decl.name], typeDecls);
  }
  return result;
}

/** 单值按声明类型归一（与 checkValue 同判据面递归——[T] 元素/TypeDecl 字段下钻,三十七审抓
 * 归一层不递归:校验层元素级核过的 [yaml] 元素仍以字符串入库,"变量空间存结构"不变量嵌套位破防）。 */
function coerceValue(type: string, v: unknown, typeDecls?: TypeDecl[]): unknown {
  // [T] 列表:逐元素递归归一（校验层已核数组在场与元素形态）
  if (/^\[.+\]$/.test(type) && Array.isArray(v)) {
    const elemType = type.slice(1, -1).trim();
    return v.map(x => coerceValue(elemType, x, typeDecls));
  }
  // 自定义 TypeDecl:声明字段递归归一（多余键原样保留——校验层同一容忍口径）
  const decl = typeDecls?.find(t => t.name === type);
  if (decl && v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const obj = { ...(v as Record<string, unknown>) };
    for (const [fname, ftype] of Object.entries(decl.fields)) {
      if (fname in obj) obj[fname] = coerceValue(ftype, obj[fname], typeDecls);
    }
    return obj;
  }
  // line 收标量（数字/bool）String 化归一——校验层只拒结构值,标量转文本无害
  // （类型谎报的温床是结构值,标量转串信息无损）。// @a: anc-exec-line-single
  if (type === 'line' && (typeof v === 'number' || typeof v === 'boolean')) return String(v);
  if (typeof v !== 'string') return v;
  if (type === 'int' || type === 'float') {
    const n = Number(v);
    if (v.trim() !== '' && !Number.isNaN(n)) return type === 'int' ? Math.trunc(n) : n;
  } else if (type === 'bool') {
    if (/^true$/i.test(v.trim())) return true;
    if (/^false$/i.test(v.trim())) return false;
  } else if (type === 'line' || type === 'line(nonempty)') {   // nonempty 同罩折叠归一（约束只管空判,折叠语义与裸 line 一致）// @a: anc-type-constraint-annotation
    // 单行值周边空白无语义,归一 trim;多行折叠为单行（换行→空格,#22 同款宽容哲学——
    // dr16 实撞:修错步交 fix_note 时两轮都写多行 markdown 小结,SCHEMA_MISMATCH 各重试 3 次
    // 仍多行,一个记账字段的格式烧掉 5.2 三条命里的两条;模型对"总结一句"天然爱写多行,
    // 换行折叠内容零丢失,语义引导治不了的交给确定性归一）。归一在校验前跑（fixpoint 链),
    // 折叠后单行必过校验——line 声明自此对多行免疫。// @a: anc-exec-line-single
    return v.trim().replace(/\s*\n\s*/g, ' ');
  } else if (type === 'yaml') {
    // yaml=结构化数据（2026-08-20 值模型改判）：字符串 parse 成结构入变量空间——hop_python
    // 字段访问/推导直接可用。校验层已核"可 parse 成结构",此处必成功;防御性保留原值分支。
    // @a: anc-type-yaml-structured
    const parsed = parseYamlStructure(v);
    if (parsed !== undefined) return parsed;
  }
  return v;
}

/** 值内前置引号片段的标量修复——中文写作高频形态 `键: "引号片段"接裸文` 是非法 YAML 标量
 * （引号开头的值必须整值被引号包住）,一行即炸整文 yamlLoad。逐行找命中形态,把整值重包成
 * 合法带引号标量（内部引号转义）;只动命中行,其余原样。返回修复后文本（无命中返回原文本,
 * 调用方按引用相等跳过二次解析）。doc-review 步 11 实撞:10 条风险点内容完好,两三行此形态
 * 三连 SCHEMA_MISMATCH 烧尽。见 design ^anc-exec-output-quoted-prefix-repair。
 * // @a: anc-exec-output-quoted-prefix-repair */
export function repairQuotedPrefixScalars(text: string): string {
  const lines = text.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    // 命中: <缩进>[- ]<键>: "<片段>"<裸文>（闭合引号后还有非空白字符;键位也容忍列表项前缀）
    const m = lines[i].match(/^(\s*(?:- )?[^:\n"']+:\s*)"([^"]*)"(\S[^\n]*)$/);
    if (!m) continue;
    const value = `"${m[2]}"${m[3]}`;
    lines[i] = m[1] + JSON.stringify(value);
    changed = true;
  }
  return changed ? lines.join('\n') : text;
}

/** yaml 型字符串 → 结构（对象/列表）。剥围栏（复用恢复阶梯同款容忍）→ yamlLoad → 仅结构采用。
 * 解不出结构（parse 失败/解出标量——纯散文 yamlLoad 得字符串）返回 undefined。
 * checkValue 与 coerceOutputValues 共用同一判据面。// @a: anc-type-yaml-structured */
function parseYamlStructure(s: string): unknown {
  let t = s.trim();
  const fence = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?\s*```$/);
  if (fence) t = fence[1];
  let parsed: unknown;
  try { parsed = yamlLoad(t); } catch {
    // 引号前缀行修复重试（^anc-exec-output-quoted-prefix-repair）——修复无命中或仍炸才判真散文
    const repaired = repairQuotedPrefixScalars(t);
    if (repaired === t) return undefined;
    try { parsed = yamlLoad(repaired); } catch { return undefined; }
  }
  return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
}

/** 把不匹配项格式化为 SCHEMA_MISMATCH 的 message（供算子级重试构造反馈）。 */
export function formatSchemaMismatch(mismatches: SchemaMismatch[], typeDecls?: TypeDecl[]): string {
  let msg = 'SCHEMA_MISMATCH: ' + mismatches.map(m =>
    `字段 "${m.field}"（声明 ${m.declared_type}）：${m.reason}（实际：${m.actual}）`
  ).join('；');
  // 失配涉自定义 TypeDecl 时附字段级定义行（0017 反馈半边——原反馈只说'缺 kind_hint'不给完整形,
  // LLM 逐轮微调仍在猜同因全灭;定义行让反馈自包含,闭包收嵌套/[T] 元素类型,与 prompt L1 同一份契约）。
  // @a: anc-exec-output-schema-check
  const involved = collectTypeDeclClosure(mismatches.map(m => m.declared_type), typeDecls);
  if (involved.length) {
    msg += '\n类型定义（输出须严格符合以下字段结构）:\n' + involved.map(t => formatTypeDecl(t).split('\n').map(l => '  ' + l).join('\n')).join('\n');   // 全行垫——模板前缀只垫首行塌层实撞 // @a: anc-type-type-decl
  }
  return msg;
}
