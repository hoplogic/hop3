// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: spec-ast ^anc-struct-spec-ast
// AST 类型契约——最稳的契约层（语言身份）。SpecAST/14 步骤类型/ActBody 表达式/DocRef + 共享辅助类型。
// 拆自原 types.ts（按稳定性，见 design/spec-ast.md ^anc-struct-spec-ast）；types.ts 保留为 barrel re-export。

export interface SpecAST { // @a: anc-ast-spec-ast, anc-ast-spec-structure
  header: SpecHeader;
  steps?: StepNode[];
}

/** SpecHeader：Spec 头部字段结构——title/id/goal/constraints/types/inputs/outputs/config/doc_refs。见 [[spec-ast#^anc-ast-spec-header]] */
export interface SpecHeader { // @a: anc-ast-spec-header
  title: string;
  id?: string;
  // Id 行可选函数签名原文 `func(in...) -> out...`——S14 按名对应 Inputs/Outputs,serializer 原样回写。// @a: anc-rule-s14
  signature?: string;
  goal?: string;
  constraints?: string[];
  types?: TypeDecl[];
  inputs?: VarDecl[];
  outputs?: OutputDecl[];
  tools?: ToolNeed[];   // Tools 段工具需求声明（^anc-rule-tools-section,概念 ^anc-tool-two-faces——init 对环境注册面对账）// @a: anc-rule-tools-section
  config?: SpecConfig;
  doc_refs?: DocRef[]; // doc-ref [[doc#章节]] 从 Constraints 提取（spec 级）， // @a: anc-rule-doc-ref-extract
  // 内容章节（^anc-rule-narrative-sections 2026-08-27 作者定"写在spec文件的内容章节就是缺省要供给的内容"）：
  // 非关键字##节且无步骤行,原文字节收集;带(不供给)/(private)标记的不收;供给面=L2-spec 稳定面
  narrative_sections?: Array<{ title: string; content: string }>;
  // 声明区孤儿行（^anc-rule-decl-zone-warn,todo/0016 全角冒号一刀）：四声明段+Id 行内不匹配
  // 文法的非空非注释行——parser 只收集零报错,validator W1 出 warn（写错的行不再无声蒸发）。
  // @a: anc-rule-decl-zone-warn
  decl_zone_orphans?: Array<{ line: number; text: string; section: string }>;
}

/** ToolNeed：spec Tools 段单条工具需求声明——本 spec 假定的工具签名（需求面;实现权威在环境注册面）。
 * 见 [[spec-parser#^anc-rule-tools-section]]。// @a: anc-rule-tools-section, anc-tool-two-faces */
export interface ToolNeed {
  name: string;                       // 工具名（合法标识符或注册面 tool_id）
  params: { name: string; type: string; description?: string }[];   // 逐参数（签名行括号与子条目按名对应,说明入结构）
  output?: { name: string; type: string };   // -> 后单输出声明（v1 单输出）
  description?: string;               // 签名行行尾 # 一句话用途
  notes?: string;                     // > 扩展多行（跨参数复杂语义）
}

/** TypeDecl：Types 段复用结构体（名称+字段字典），v1 仅校验字段名存在性。见 [[spec-ast#^anc-type-type-decl]] */
export interface TypeDecl { // @a: anc-type-type-decl
  name: string;
  fields: Record<string, string>;
  // 字段 # 注释（2026-08-27 作者定"jit 不需要注释,llm 需要"——LLM 消费面渲染带注释,
  // body 解释器/validator 机器判定照旧只认 fields 类型词。缺注释的字段缺席本字典）。
  // @a: anc-type-type-decl
  description?: string;                          // 类型级注释（TypeName: 行尾 #）
  field_descriptions?: Record<string, string>;   // 字段名→注释原文
}

/** VarDecl：变量声明（Inputs 段等），含名称、类型与描述。见 [[spec-ast#^anc-ast-spec-header]] */
export interface VarDecl {
  name: string;
  type: ValueTypeString | string;
  description?: string;
}

/** SpecConfig：Config 段配置项——引擎真消费键的全清单=ENGINE_CONFIG_KEYS（同文件下方,单一事实源）;max_depth/max_retries 已声明但运行时零消费（call 盘点判"随将来需求再接",教学面勿列——2026-08-13 配置参考实撞）。允许扩展键。见 [[spec-ast#^anc-ast-spec-header]] */
export interface SpecConfig {
  max_depth?: number;
  max_retries?: number;
  model?: string; // Spec 级默认模型（格式: service/model 或 model_name）
  expansion_max?: number; // subtask free 展开总数熔断上限（实例级,缺省 DEFAULT_EXPANSION_MAX;^anc-exec-subtask-free-expand 契约7） // @a: anc-exec-subtask-free-expand
  [key: string]: unknown;
}

/** 引擎真消费的 Config 键全清单（单一事实源——概念层记载面守卫据此比对,设计权威
 * [[spec-ast]] ^anc-ast-config-keys-doc-sync）。新增引擎消费键三件同批：入本清单、
 * 概念层语法参考 Config 区记载、消费点用 config?.['键'] 索引形态（守卫的代码扫描面）。
 * 声明在场但零消费的键（max_depth/max_retries）不入列。 */ // @a: anc-ast-config-keys-doc-sync
export const ENGINE_CONFIG_KEYS = ['model', 'models', 'expansion_max', 'engine_min_version', 'requires_commands'] as const;

/** subtask free 展开总数熔断缺省（Config expansion_max 可调——缺省 20:作者定 2026-08-29
 * "实例级 10 可能少了",渐进细化多洞多轮要给跑道）。与类型同居本文件:engine 消费、validator
 * 报文引用,两侧同源防字面脱钩（review 抓 validator 写死"20"）。 */ // @a: anc-exec-subtask-free-expand
export const DEFAULT_EXPANSION_MAX = 20;

// --- Step types ---

export type ExecutableStepType = 'reason' | 'act' | 'check' | 'confirm' | 'ask' | 'commit' | 'call'; // @a: anc-ast-step-type
/** StructuralStepType：7 种结构/控制流步骤类型字面量（parallel 已降为属性）——由 ExecutionEngine 内部展开，不直接交 LLM。见 [[spec-ast#^anc-ast-step-type]] */
export type StructuralStepType = 'subtask' | 'loop' | 'branch' | 'case' | 'break' | 'continue' | 'exit' | 'on_fail';   // 'parallel' 类型 2026-08-07 退役（降为属性）;on_fail=失败兜底块（2026-08-21 作者立,^anc-step-on-fail）
/** StepType：全部 15 种步骤类型联合（可执行 ∪ 结构），BaseStep.step_type 的判别基座。见 [[spec-ast#^anc-ast-step-type]] */
export type StepType = ExecutableStepType | StructuralStepType;

/** VarBinding：← 输入绑定（变量名与引用来源，二者同值）。见 [[spec-ast#^anc-ast-base-step]] */
export interface VarBinding {
  name: string;
  source: string;
  // for-each 子句自动合成的 listVar 消费边（parser 合成，非作者显式书写）——V9 据此
  // 区分"显式冗余行"(info)与合成边；V1/S12 对二者一视同仁。见 [[spec-ast#^anc-ast-base-step]]
  synthesized?: boolean;
}

/** SourceLocation：markdown 原文行位置（错误报告与定位用）。见 [[spec-ast#^anc-ast-base-step]] */
export interface SourceLocation {
  line_start: number;
  line_end: number;
}

/** ParamMapping：call 步骤的父子变量搬运映射（from=来源变量名, to=目标变量名），v1 不做类型匹配。见 [[spec-ast#^anc-step-call]] */
export interface ParamMapping {
  from: string;  // 来源（字面量项=作者原文,如 `"seq"`——序列化回写用）
  to: string;    // 目标
  // 在场即字面量项（param_mapping 值位写常量,2026-08-27 hopissues/0044）：解析后的运行时值
  // （字符串/数字/bool/null）,引擎直传不查父变量。缺席=变量映射。仅 param_mapping 有此语义。
  // @a: anc-step-call-literal
  literal_value?: unknown;
}

/** BaseStep：所有步骤共享的公共字段基座（step_id/step_type/summary/inputs/outputs/instruction 等）。见 [[spec-ast#^anc-ast-base-step]] */
export interface BaseStep { // @a: anc-ast-base-step
  step_id: string;
  step_type: StepType;
  summary: string;
  inputs?: VarBinding[];
  outputs?: OutputDecl[];
  instruction?: string;
  model_override?: string; // @a: anc-exec-model-annotation
  // @thinking 步骤标注——单步思考开关（五级优先链第 2 级,记名册强制项恒压过它）。
  // serialize 往返保留。// @a: anc-exec-thinking-step-annotation
  thinking_override?: 'on' | 'off';
  // @src 源锚点——本步翻译自上游文档（NL skill）哪一处。纯追溯元数据零执行语义:不进执行 prompt/
  // 不参与校验;serialize 往返保留（锚随产物持久化,原文演进后翻译工具链增量对账）。// @a: anc-step-src-annotation
  src_ref?: string;
  doc_refs?: DocRef[]; // doc-ref [[doc#章节]] 从 instruction 提取（步骤级）， // @a: anc-rule-doc-ref-extract
  source_location?: SourceLocation;
}

// doc-ref 文档引用类型（见 design/step-dispatcher.md ^anc-struct-doc-ref）
export interface DocRef { // @a: anc-rule-doc-ref-extract
  doc: string;      // workspace 相对文档路径（Obsidian 省 .md 时引擎补全兜底）
  section: string;  // 章节名（匹配 markdown 标题，不含 # 前缀）
}

/** DocRefFragment：engine 运行期解析出的 doc-ref 章节内容（命中标题/正文/匹配级别），注入前的中间形态。
 * 见 [[spec-ast#^anc-type-doc-ref]]。 // @a: anc-type-doc-ref */
export interface DocRefFragment { // @a: anc-exec-doc-ref-resolve
  doc: string;
  section: string;
  heading: string;                              // 实际命中的标题原文
  content: string;                              // 切出的章节正文
  matched: 'exact' | 'normalized' | 'fuzzy';    // 匹配级别
  file_path?: string;                           // 大节 deflate 后的 $file 绝对路径（小节内联时缺省）
  preview?: string;                             // inline 预览通道:超限大节的头部节选（^anc-exec-llm-inline-context v2——值位真内容非死引用,file_path 此时=全文落盘路径）
  full_chars?: number;                          // inline 预览通道:全文字符数（预览条目"体量"行渲染用）
}

// 7 executable step types

export interface ReasonStep extends BaseStep { // @a: anc-step-reason
  step_type: 'reason';
  // 节点工具授权（^anc-step-tool-grant 2026-09-01 作者拍"等同于 act 的能力,不能 commit 写"扩员
  // reason）：special 工具须声明才对 standalone reason 可用;basic 恒可用。与 ActStep 同形态。
  // @a: anc-exec-reason-tools
  tool_grants?: { name: string; note?: string }[];
  // 节点工具禁用（^anc-step-tool-deny 2026-09-05）：`- 禁工具: 名  # 为什么禁` 条目行——被禁
  // 工具（含 basic 族）从本步下发清单整体剔除。与 ActStep 同形态。// @a: anc-step-tool-deny
  tool_denies?: { name: string; note?: string }[];
}

/** ActStep：act 步骤 AST 节点——执行可逆副作用（限 SandboxConfig 沙箱内），可选 ActBody 结构化 body。见 [[spec-ast#^anc-step-act]] */
export interface ActStep extends BaseStep { // @a: anc-step-act, anc-step-act-sandbox-constraint
  step_type: 'act';
  body?: ActBody; // ```hop_python 围栏解析所得结构化 body；省略=回退自然语言 instruction。 // @a: anc-ast-act-body
  // [act free] 自由任务档（概念 ^anc-step-act free 条款）：拆不开的复杂任务承认现状——
  // 执行者可推理可用受控工具。与 body 互斥（B7）;无 free 无 body=warn 促简化。 // @a: anc-rule-b7
  free?: boolean;
  // 节点工具授权（0054 ^anc-step-tool-grant）：`- 工具: 名  # 意图` 条目行——特殊工具须声明
  // 才对无 body 的 act 可用;{name:'*'} 表全量。装的是声明清单不是签名(签名真身在注册面)。
  tool_grants?: { name: string; note?: string }[];
  // 节点工具禁用（^anc-step-tool-deny 2026-09-05）：`- 禁工具: 名  # 为什么禁` 条目行——被禁
  // 工具（含 basic 族）从本步下发清单整体剔除,执行者根本看不到。// @a: anc-step-tool-deny
  tool_denies?: { name: string; note?: string }[];
  // 沙箱约束：操作范围限于 SandboxConfig，不走 authorize。不可逆操作必须用 commit。
}

/** CheckStep：check 步骤 AST 节点——验证判定（is_finally 为 Constraints 可执行化身），固定 bool+text 输出签名。见 [[spec-ast#^anc-step-check]] */
export interface CheckStep extends BaseStep { // @a: anc-step-check
  step_type: 'check';
  is_finally?: boolean; // @a: anc-step-check-finally
  body?: ActBody; // 纯机械判定 hop_python body（与 act 同文法,引擎消化零 LLM;省略=LLM 判）。 // @a: anc-step-check-body
  // 升层声明（概念 ^anc-step-check-escalatable,设计 ^anc-exec-check-escalate——作者授权本判定点
  // 可把"本层够不着的缺口"上交,接收端由拓扑定;声明时说明槽须 yaml〔结构化缺口〕）。
  // @a: anc-exec-check-escalate
  escalatable?: boolean;
}

/** ConfirmStep：confirm 步骤 AST 节点——纯审批闸门（+→ 仅 bool），可配 require_human 与 response_options。见 [[spec-ast#^anc-step-confirm]] */
export interface ConfirmStep extends BaseStep { // @a: anc-step-confirm
  step_type: 'confirm';
  require_human?: boolean;
  response_options?: ResponseOption[];
  // 纯审批闸门：+→ 仅 bool（approve→true / reject→全局中止）。数据收集用 AskStep
}

/** AskStep：ask 步骤 AST 节点——CITL 数据收集（answer 落到 +→ 变量），present_inputs 声明必须完整展示的输入子集。见 [[spec-ast#^anc-step-ask]] */
export interface AskStep extends BaseStep { // @a: anc-step-ask
  step_type: 'ask';
  require_human?: boolean;
  // 必须完整展示给 user 的变量名子集（必须 ⊆ ← inputs.name,P14 校验）。
  // driver 收到 paused 响应时,据此完整 dump 这些 context 字段(禁缩略),再问决定。
  // 见概念 ^anc-step-ask 呈交语义条款 / 设计 ^anc-exec-hitl-presentation。// @a: anc-rule-p14
  present_inputs?: string[];
  // CITL 数据收集：- ← 候选/推断来源，+→ caller 提供的数据（任意类型）。与 confirm 正交
}

/** CommitStep：commit 步骤 AST 节点——不可逆动作（irreversible_action），与 act 同源复用 ActBody，requires_commit 放行且不可重试。见 [[spec-ast#^anc-step-commit]] */
export interface CommitStep extends BaseStep { // @a: anc-step-commit
  step_type: 'commit';
  irreversible_action: string;
  body?: ActBody; // 与 act 同源，复用 ActBody；执行差别仅 requires_commit 放行 + 不可逆不可重试。 // @a: anc-ast-act-body
}

/** CallStep：call 步骤 AST 节点——调用子 Spec（callee_spec_id），param_mapping/output_mapping 搬运父子变量。见 [[spec-ast#^anc-step-call]] */
export interface CallStep extends BaseStep { // @a: anc-step-call, anc-step-parallel
  step_type: 'call';
  callee_spec_id?: string;
  callee_expr?: ActExpr;            // callee 位插值（晚绑定 [call {expr}]）——与 callee_spec_id 互斥恰一（P1 校验）// @a: anc-step-call-dynamic-callee
  callee_expr_src?: string;         // 插值表达式原文（serializer 往返回写 {原文} 用;解引用失败报文回显）// @a: anc-step-call-dynamic-callee
  param_mapping?: ParamMapping[];   // 输入映射：from=父变量, to=子 Input 名
  output_mapping?: ParamMapping[];  // 输出映射：from=子 Output 名, to=父变量名
  parallel?: boolean;               // callee 并发申报转述：异步派发、容器边界收齐（^anc-exec-gather）
}

// 8 structural/control flow step types

export interface BranchStep extends BaseStep { // @a: anc-step-branch
  step_type: 'branch';
  children: CaseStep[];
}

/** SubtaskStep：subtask 结构步骤 AST 节点——容器（children），支持 retry 与 adaptive replan。见 [[spec-ast#^anc-step-subtask]] */
export interface SubtaskStep extends BaseStep { // @a: anc-step-subtask, anc-step-parallel, anc-step-subtask-free
  step_type: 'subtask';
  retry?: number;                                  // retry 仅属 subtask/case（事务边界）——loop 无
  adaptive?: boolean;
  parallel?: boolean;                              // callee 并发申报（统一模型：异步派发、容器边界收齐 ^anc-exec-gather）
  free?: boolean;                                  // 到步展开档（^anc-step-subtask-free）——children 可空,到步引擎索计划;S5 豁免
  children: StepNode[];
}

/** OnFailStep：失败兜底块（[on fail]/[失败兜底]——subtask/case 末位子节点,retry 耗尽后激活,
 * 正常走完=失败被消化容器 done 收场不上浮;概念 ^anc-step-on-fail,2026-08-21 作者立）。
 * // @a: anc-step-on-fail */
export interface OnFailStep extends BaseStep {
  step_type: 'on_fail';
  children: StepNode[];
}

/** ParallelStep：parallel 标注 subtask 的类型收窄别名（统一模型 P0.5：LoopStep.parallel 已随
 * loop 头文法废除删除，宿主只剩 subtask/call；call 侧直接读 CallStep.parallel）。 */
export type ParallelStep = SubtaskStep & { parallel: true };

/** LoopStep：loop 结构步骤 AST 节点——循环容器（children），max_iterations 限迭代，靠 break/continue/exit 终止。见 [[spec-ast#^anc-step-loop]] */
export interface LoopStep extends BaseStep { // @a: anc-step-loop
  step_type: 'loop';
  max_iterations?: number;                         // 条件循环形态
  forEach?: { listVar: string; itemVar: string };  // for-each 遍历形态（引擎驱动游标；2026-08-07 自原 ParallelStep 迁入）
  // collect 收集子句（仅 for-each 形态；可多个）：children 每轮产出 unitVar(T)，引擎轮末
  // 收进 listVar([T]) 并复位单项槽——显式收集端，取代旧"同名输出自动收集"（同名异型是
  // "同名=同一变量"原则唯一裂缝，2026-08-09 作者定）。// @a: anc-rule-v10
  collect?: { unitVar: string; listVar: string }[];
  children: StepNode[];
}

/** CaseStep：case 结构步骤 AST 节点——branch 下的分支子任务（condition 条件，空为 default），继承 subtask 重试语义。见 [[spec-ast#^anc-step-case]] */
export interface CaseStep extends BaseStep { // @a: anc-step-case
  step_type: 'case';
  condition?: string;
  retry?: number;      // case 就是 branch 下的 subtask，语义同 SubtaskStep.retry（默认 3）
  adaptive?: boolean;  // 语义同 SubtaskStep.adaptive
  parallel?: boolean;  // 语义同 SubtaskStep.parallel（2026-08-13 作者定：parallel 宿主=subtask/call/case）// @a: anc-step-parallel
  children: StepNode[];
}

/** BreakStep：break 控制流步骤 AST 节点——仅 loop 内合法，Engine 检测后终止目标循环（target_loop 缺省=最近祖先循环）。见 [[spec-ast#^anc-step-break]] */
export interface BreakStep extends BaseStep { // @a: anc-step-break
  step_type: 'break';
  target_loop?: string;   // 可选目标循环步骤号（[break 5.2]）——须是自身祖先循环（C3 扩展判）;与 HopSop [退出循环 <序号>] 对偶
}

/** ContinueStep：continue 控制流步骤 AST 节点——仅 loop 内合法，Engine 检测后跳过目标循环当前迭代（target_loop 缺省=最近祖先循环）。见 [[spec-ast#^anc-step-continue]] */
export interface ContinueStep extends BaseStep { // @a: anc-step-continue
  step_type: 'continue';
  target_loop?: string;   // 可选目标循环步骤号——须是自身祖先循环;与 HopSop [继续循环 <序号>] 对偶
}

/** ExitStep：exit 控制流步骤 AST 节点——任意位置合法，Engine 检测后终止整个 Spec，exit_outputs 为提前退出的输出值。见 [[spec-ast#^anc-step-exit]] */
export interface ExitStep extends BaseStep { // @a: anc-step-exit
  step_type: 'exit';
  exit_outputs?: Record<string, unknown>;
}

/** StepNode：14 个步骤接口的判别联合（按 step_type 编译期收窄），AST steps 树的节点类型。见 [[spec-ast#^anc-ast-step-type]] */
export type StepNode =
  | ReasonStep | ActStep | CheckStep | ConfirmStep | AskStep | CommitStep
  | CallStep | BranchStep
  | SubtaskStep | ParallelStep | LoopStep
  | CaseStep | BreakStep | ContinueStep | ExitStep | OnFailStep;

/** ValueTypeString：HopSpec 内置值类型字符串字面量集合（text/bool/number/enum(...)/列表/元组等）。见 [[spec-ast#^anc-ast-spec-header]] */
export type ValueTypeString = // @a: anc-type-value-types
  | 'text' | 'bool' | 'line' | 'number' | 'int' | 'float'
  | 'markdown' | 'yaml' | 'prompt' | 'HopSpec'
  | '[line]' | `[${string}]` | `(${string})` | `enum(${string})`;

/** OutputDecl：+→ 输出声明（名称、类型、描述、可选初值），用于 SpecHeader.outputs 与 BaseStep.outputs。见 [[spec-ast#^anc-type-output-decl]] */
export interface OutputDecl { // @a: anc-type-output-decl
  name: string;
  type: ValueTypeString | string;
  description: string;
  default?: unknown;  // `+ → x: type = 初值` 的初值；容器节点=init 一次、叶子=每次执行重置。见 exec-engine ^anc-exec-output-init。// @a: anc-exec-output-init
  // 复合类型 YAML 展开（`+ → name:` 声明头下的缩进子行）的字段说明——仅人读与 L6 输出约束
  // 渲染，不注册为独立变量、不入变量流图。见 [[shared-types#^anc-type-output-decl]]。
  fields?: { name: string; type: string; description: string }[];
}

// ===== act body AST（```hop_python 围栏解析所得的无推理编排）===== // @a: anc-ast-act-body
// 概念见 HopSpec V3核心规范 ^anc-step-act；设计见 design/spec-ast.md ^anc-ast-act-body。
// act/commit 同源，共用 ActBody，执行差别仅 allowCommit + 不可逆不可重试。

export interface ActBody {
  statements: ActStatement[];
  source_location?: SourceLocation;
}

/** ActStatement：act body 语句联合——赋值/调用/if 分支（禁循环）。见 [[spec-ast#^anc-ast-act-body]] */
export type ActStatement = AssignStmt | CallStmt | IfStmt;

/** AssignStmt：act body 赋值语句——target（body 局部或 +→ 输出名）= value 表达式。见 [[spec-ast#^anc-ast-act-body]] */
export interface AssignStmt {
  type: 'assign';
  target: string;   // 变量名（body 局部 or +→ 输出名）
  value: ActExpr;
  line?: number;
}

/** CallStmt：act body 调用语句——把工具/内置调用作为独立副作用语句（如 write）。见 [[spec-ast#^anc-ast-act-body]] */
export interface CallStmt {
  type: 'call';
  call: CallExpr;
  line?: number;
}

/** IfStmt：act body 无推理分支语句——condition 须确定性可求值，elif 展开为 else_body 嵌套。见 [[spec-ast#^anc-ast-act-body]] */
export interface IfStmt {
  type: 'if';
  condition: ActExpr;
  then_body: ActStatement[];
  else_body?: ActStatement[];   // elif 在 parser 层展开为 else_body:[IfStmt] 嵌套
  line?: number;
}

/** ActExpr：act body 表达式联合——字面量/变量引用/字段访问/二元/一元/调用。见 [[spec-ast#^anc-ast-act-body]] */
export type ActExpr =
  | LiteralExpr | VarRefExpr | FieldAccessExpr | IndexExpr | SliceExpr | BinaryExpr | UnaryExpr | CallExpr
  | ListLiteralExpr | DictLiteralExpr | FStringExpr | TernaryExpr | ComprehensionExpr;

/** TernaryExpr：条件表达式 `a if c else b`（2026-08-17 作者定改判转正式支持——拒收报错会让生成 LLM
 * 错误泛化为"hop_python 不支持 if/else"；惰性求值只算命中分支）。见 [[spec-ast#^anc-ast-act-body]] */
export interface TernaryExpr {
  type: 'ternary';
  condition: ActExpr;
  then: ActExpr;
  else: ActExpr;
}

/** ComprehensionExpr：列表推导 `[expr for x in xs]` / 带滤 `[expr for x in xs if cond]`（2026-08-19 作者拍板——
 * 纯映射/过滤,迭代有界零跨迭代状态,不违禁循环本意;体内禁工具调用,嵌套深度≤2（2026-09-03 作者拍板放宽原禁嵌套）。@a: anc-step-act-body-comprehension */
export interface ComprehensionExpr {
  type: 'comprehension';
  element: ActExpr;       // 产出表达式（含迭代变量）
  itemVar: string;        // 迭代变量名
  source: ActExpr;        // 被遍历列表表达式
  filter?: ActExpr;       // 可选 if 过滤条件
}

/** ListLiteralExpr：列表字面量 `[1, "a", x]`（Python 对齐，2026-08-10）。见 [[spec-ast#^anc-ast-act-body]] */
export interface ListLiteralExpr {
  type: 'list_literal';
  elements: ActExpr[];
}

/** DictLiteralExpr：对象字面量 `{"k": v}` / `{key_var: v}`——键=表达式,Python 同义（2026-08-20 作者定
 * 『与 python 一致』,原『键限字符串字面量』人为收紧废;求值后 str 归一为字符串键）。 */
// @a: anc-step-act-body-dict-key
export interface DictLiteralExpr {
  type: 'dict_literal';
  entries: Array<{ key: ActExpr; value: ActExpr }>;
}

/** FStringExpr：f-string `f"x={v}"`——parts 为文本段与插值表达式交替（Python 对齐，2026-08-10）。见 [[spec-ast#^anc-ast-act-body]] */
export interface FStringExpr {
  type: 'fstring';
  parts: Array<{ kind: 'text'; text: string } | { kind: 'expr'; expr: ActExpr }>;
}

/** IndexExpr：下标访问 `items[i]`——index 为任意可求值表达式（动态下标,2026-08-09 作者定 A:
 * 对标 Python 到底,下标位置单独禁变量是人为不对称）。见 [[spec-ast#^anc-ast-act-body]] */
export interface IndexExpr {
  type: 'index';
  object: ActExpr;
  index: ActExpr;
}

// @a: anc-step-act-body-slice
/** SliceExpr：序列切片 `seq[start:stop]`——start/stop 各自可缺席（`l[2:]`/`l[:5]`/`l[:]`）,钳位宽容
 * 语义与单下标 None 传播分野,故分立节点不复用 IndexExpr（TS exhaustive check 强制每个消费位表态）。
 * 不含 step（v1 不进,文法层定向报错）。见 [[act-body#^anc-step-act-body-slice]] */
export interface SliceExpr {
  type: 'slice';
  object: ActExpr;
  start?: ActExpr;
  stop?: ActExpr;
}

/** LiteralExpr：act body 字面量表达式——string/number/bool/null 值及其 literal_kind（null=Python None 结构化逻辑标准写法,2026-08-09 补——条件 x == None 检测降级路径此前无法表达）。见 [[spec-ast#^anc-ast-act-body]] */
export interface LiteralExpr {
  type: 'literal';
  value: string | number | boolean | null;
  literal_kind: 'string' | 'number' | 'bool' | 'null';
}

/** VarRefExpr：act body 变量引用表达式（← 输入 / body 局部 / 上文赋值）。见 [[spec-ast#^anc-ast-act-body]] */
export interface VarRefExpr {
  type: 'var';
  name: string;
}

/** FieldAccessExpr：act body 字段访问表达式——object.field，可链式 a.b.c。见 [[spec-ast#^anc-ast-act-body]] */
export interface FieldAccessExpr {
  type: 'field';
  object: ActExpr;
  field: string;
}

/** BinaryOp：act body 二元运算符集合——算术/比较/逻辑/成员测试（+ 按操作数分派数加或串接；in/not in 为 Python 惯用成员测试；% // ** 为 Python 算术补齐，2026-08-10 对齐）。见 [[spec-ast#^anc-ast-act-body]] */
export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%' | '//' | '**' | '==' | '!=' | '<' | '>' | '<=' | '>=' | 'and' | 'or' | 'in' | 'not in';

/** BinaryExpr：act body 二元表达式——op 及左右操作数。见 [[spec-ast#^anc-ast-act-body]] */
export interface BinaryExpr {
  type: 'binary';
  op: BinaryOp;
  left: ActExpr;
  right: ActExpr;
}

/** UnaryExpr：act body 一元表达式——not/取负 作用于 operand。见 [[spec-ast#^anc-ast-act-body]] */
export interface UnaryExpr {
  type: 'unary';
  op: 'not' | '-';
  operand: ActExpr;
}

/** CallExpr：act body 调用表达式——callee 必须 ∈ 白名单（内置函数 ∪ ToolProvider 工具名），args 参数列表。见 [[spec-ast#^anc-ast-act-body]] */
export interface CallExpr {
  type: 'call';
  callee: string;       // 白名单：内置函数名 ∪ ToolProvider 工具名
  args: CallArg[];
}

/** CallArg：act body 调用实参——工具调用用命名参数（name 必填），内置函数用位置参数（name 省略）。见 [[spec-ast#^anc-ast-act-body]] */
export interface CallArg {
  name?: string;        // 工具调用用命名参数（对应 ToolProvider Record args）；内置函数用位置参数（name 省略）
  value: ActExpr;
}

/** StepSummary：步骤精简摘要（step_id/step_type/summary/输出名列表），供 replan 等场景引用。见 [[spec-ast]] */
export interface StepSummary {
  step_id: string;
  step_type: StepType;
  summary: string;
  outputs: string[];
}

// ResponseOption 由 ConfirmStep 引用，属 AST 层（步骤定义的一部分）
export interface ResponseOption {
  value: string;
  label: string;
  description?: string;   // 选项含义/后果（对齐 CC AskUserQuestion options[].description）
}
