// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: spec-ast ^anc-struct-spec-ast
// AST 谓词函数 + 跨模块常量——非类型的运行时逻辑（从原 types.ts 剥离，回归 types 纯类型契约）。
// 见 design/spec-ast.md ^anc-struct-spec-ast（拆分动机：类型文件不应混逻辑）。

import type {
  StepType, StepNode, SubtaskStep, ParallelStep, LoopStep, BranchStep, CaseStep, TypeDecl,
} from './ast-types.js';

/** 7 种可执行步骤类型集合（reason/act/check/confirm/ask/commit/call），供 parser/validator/engine 判类。见 [[spec-ast#^anc-struct-spec-ast-exports]]。 */
export const EXECUTABLE_STEP_TYPES: ReadonlySet<StepType> = new Set<StepType>([
  'reason', 'act', 'check', 'confirm', 'ask', 'commit', 'call',
]);

/** 7 种结构/控制流步骤类型集合（subtask/loop/branch/case/break/continue/exit——parallel 已降为属性），由引擎内部展开而非交 LLM 执行。见 [[spec-ast#^anc-struct-spec-ast-exports]]。 */
export const STRUCTURAL_STEP_TYPES: ReadonlySet<StepType> = new Set<StepType>([
  'subtask', 'loop', 'branch', 'case', 'break', 'continue', 'exit',   // parallel 类型已退役（属性化）
  'on_fail',   // 失败兜底块（^anc-step-on-fail,2026-08-21）
]);

/** 持有 children 的容器步骤类型集合（subtask/parallel/loop/branch/case），isContainerStep 据此判定。见 [[spec-ast#^anc-struct-spec-ast-exports]]。 */
export const CONTAINER_STEP_TYPES: ReadonlySet<StepType> = new Set<StepType>([
  'subtask', 'loop', 'branch', 'case',
  'on_fail',   // 失败兜底块（^anc-step-on-fail）——容器:children 走级联;非 scope 创建（children 写宿主 subtask scope,兜底值直达容器输出）
]);

/** 全部 15 种步骤类型集合（7 可执行 ∪ 8 结构/控制流），全类型判类的并集。见 [[spec-ast#^anc-struct-spec-ast-exports]]。 */
export const ALL_STEP_TYPES: ReadonlySet<StepType> = new Set<StepType>([
  ...EXECUTABLE_STEP_TYPES, ...STRUCTURAL_STEP_TYPES,
]);

// 大内容阈值(agent 通道):NextResponse 中 inputs/outputs/params_for_child 等
// record 的单个值 JSON.stringify().length 超此阈值时,引擎自动写入 work_zone/vars/<key>.json,
// 响应中替换为 {$file: abs_path} 指针。driver/LLM 遇 $file 时 Read 取真实值。
// 见 design/shared-types.md ^anc-exec-deflate。// @a: anc-exec-deflate
export const DEFLATE_THRESHOLD = 4096;

// inline 通道（standalone 裸 API LLM）单值宽松限额（2026-08-25 作者定"独立模式用类似 yaml
// 缩进方式引用+相对宽松限额",适用面=L4 输入变量+doc-ref 大节——dr16 普查变量 p90=2502 的
// 8 倍,常态全量内联,只把 40K 级病态尾巴转成预览条目:值位真内容节选+明示全文落盘路径,
// 非 $file 死引用,无工具模型不被逼编造）。// @a: anc-exec-llm-inline-context
export const INLINE_PREVIEW_MAX = 20000;

// 人通道预览阈值:paused.presented_data.context(给 user 看的)单值超此字符数时,
// 引擎返 {$file, preview} 复合格式:preview = 头 5K 字符 + "...[完整内容见文件]",
// driver 完整 dump preview 给 user 看,$file 让 user 知完整在哪。
// 见 design/shared-types.md ^anc-exec-deflate / 概念 ^anc-exec-audience-routing。
// @a: anc-exec-deflate, anc-exec-audience-routing
export const HUMAN_PREVIEW_THRESHOLD = 5000;

// ===== Type guards =====

/** 带 parallel 属性的容器判定（2026-08-07 重构核心谓词）：subtask parallel（静态并行组）
 * 或 loop forEach+parallel（并行遍历）。引擎并行执行路径（fan-out/join/批收集）统一以此
 * 判定触发，取代旧 step_type === 'parallel' 判等。// @a: anc-step-parallel */
export function isParallelContainer(step: StepNode): step is ParallelStep {
  return step.step_type === 'subtask' && (step as SubtaskStep).parallel === true;
}

/** for-each 绑定读取：loop 的 forEach 字段（旧 ParallelStep.forEach 的迁移落点）。 */
export function getForEach(step: StepNode): { listVar: string; itemVar: string } | undefined {
  return step.step_type === 'loop' ? (step as LoopStep).forEach : undefined;
}

/** 容器步骤谓词（subtask/parallel/loop/branch/case——可拥有 children 的步骤类）。engine/validator 递归遍历消费。见 [[spec-ast#^anc-struct-spec-ast]] */
export function isContainerStep(step: StepNode): step is SubtaskStep | ParallelStep | LoopStep | BranchStep | CaseStep {
  return CONTAINER_STEP_TYPES.has(step.step_type);
}

/** 判定步骤是否实际持有 children 数组的类型守卫（结构存在性检查，收窄为容器步骤类型）。见 [[spec-ast#^anc-struct-spec-ast-exports]]。 */
export function hasChildren(step: StepNode): step is SubtaskStep | ParallelStep | LoopStep | BranchStep | CaseStep | import('./ast-types.js').OnFailStep {
  return 'children' in step && Array.isArray((step as SubtaskStep).children);
}

/** 取步骤的子步骤列表，非容器或无 children 时返回空数组。见 [[spec-ast#^anc-struct-spec-ast-exports]]。 */
export function getChildren(step: StepNode): StepNode[] {
  if (hasChildren(step)) return step.children;
  return [];
}

// ===== step_id 寻址 =====

// 取父 step_id：纯字符串操作（"1.2.3" → "1.2"，"1" → null）。
// 无状态 AST 寻址，非执行调度职责——归 spec-ast（从 engine-traverse 迁入）。
export function getParentStepId(stepId: string): string | null {
  const lastDot = stepId.lastIndexOf('.');
  return lastDot >= 0 ? stepId.slice(0, lastDot) : null;
}

/** 判某输出名是否为该步的"更新模式"输出——步骤同时 `← outName` 且 `+ → outName`（读入即输出，
 * 在既有变量基础上更新而非新产出）。三处共用同一判据：engine failStep 跳过 null 化 / check 失败
 * 写回 / validator V3 放行遮蔽。抽此消除重复、保判据一致。见 ^anc-exec-failstep-skip-update / ^anc-rule-v3。
 */
// @a: anc-exec-failstep-skip-update
export function isUpdateModeOutput(step: { inputs?: { source: string }[] }, outName: string): boolean {
  return step.inputs?.some(b => b.source === outName) ?? false;
}

// ===== TypeDecl 序列化（0017:字段级定义单源——prompt L1 Types 段与 SCHEMA_MISMATCH 反馈
// 两消费点同一份序列化,校验层 checkValue 看同一份 AST:生成/反馈/校验三面一份契约） =====

/** 单个 TypeDecl 序列化为 `名={字段:类型, …}` 一行。fields 空时输出 `名={}`（如实——空定义也是定义）。
 * 见 [[spec-ast#^anc-type-type-decl]]。// @a: anc-type-type-decl */
export function formatTypeDecl(t: TypeDecl): string {
  // 字段注释进 LLM 消费面（prompt L1/子树闭包/SCHEMA_MISMATCH 反馈三点同源——作者定 2026-08-27
  // "jit 不需要注释,llm 需要":有注释换多行条目式,无注释保持单行紧凑零变化）。// @a: anc-type-type-decl
  const hasDesc = t.description || (t.field_descriptions && Object.keys(t.field_descriptions).length > 0);
  if (!hasDesc) return `${t.name}={${Object.entries(t.fields).map(([k, v]) => `${k}:${v}`).join(', ')}}`;
  // 多行形态零外部缩进假设：头行 0 格、字段 2 格（相对缩进封闭在本函数内）——调用方要垫
  // 前缀必须用 indentBlock 垫全部行,禁模板 \`  \${...}\` 只垫首行（review 实抓塌层:原字段
  // 2 格与被垫头行同深,CheckPoint 与字段拍平成八个平行键;手拼多行+模板首行前缀是 ARCHITECTURE
  // ^anc-string-escape'禁手拼'纪律要防的形态,缩进一律交 indentBlock 现成封装）。
  const head = `${t.name}:${t.description ? `  # ${t.description}` : ''}`;
  const fieldLines = Object.entries(t.fields).map(([k, v]) => {
    const d = t.field_descriptions?.[k];
    return `  ${k}: ${v}${d ? `  # ${d}` : ''}`;
  });
  return [head, ...fieldLines].join('\n');
}

/** 从若干起点类型名收集 TypeDecl 闭包（嵌套字段类型/[T] 元素类型递归收集,声明序稳定输出去重）。
 * 起点名可含 [T] 包裹与内置类型（非 TypeDecl 名自然不命中,零特判）。// @a: anc-type-type-decl */
export function collectTypeDeclClosure(names: string[], decls: TypeDecl[] | undefined): TypeDecl[] {
  if (!decls?.length) return [];
  const byName = new Map(decls.map(t => [t.name, t]));
  const bare = (n: string) => n.replace(/^\[/, '').replace(/\]$/, '').trim();   // [T] → T
  const seen = new Set<string>();
  const queue = names.map(bare);
  while (queue.length) {
    const n = queue.shift()!;
    const t = byName.get(n);
    if (!t || seen.has(n)) continue;
    seen.add(n);
    for (const ft of Object.values(t.fields)) queue.push(bare(ft));
  }
  return decls.filter(t => seen.has(t.name));   // 声明序稳定（Map 迭代序=插入序,但按 decls 原序更直观）
}
