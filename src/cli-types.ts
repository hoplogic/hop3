// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: hop-cli ^anc-struct-hop-cli
// CLI 响应/请求类型——**包级对外稳定面**（driver 依赖的 JSON 结构，破坏即破坏 driver，包级 MAJOR）。
// 拆自原 types.ts（见 design/spec-ast.md ^anc-struct-spec-ast 拆分表）。

import type { OutputDecl, StepSummary, ExecutableStepType, ResponseOption } from './ast-types.js';
import type { AssembledContext, RetryRecord } from './runtime-types.js';
import type { SpecError, ErrorCode } from './errors.js';

/** hopjit init 响应联合：成功创建实例或校验失败。见 [[hop-cli#^anc-cli-init-response]] */
export type InitResponse = InitSuccess | InitError; // @a: anc-cli-init-response

/** init 成功：实例已创建，warn 级校验结果透传供作者修复。见 [[hop-cli#^anc-cli-init-response]] */
export interface InitSuccess {
  status: 'ok';
  instance_id: string;
  warnings?: SpecError[];          // warn 级校验结果（不阻断 init，透传供修复）
}

/** init 失败：error 级解析或校验违规阻断，不创建实例。见 [[hop-cli#^anc-cli-init-response]] */
export interface InitError {
  status: 'error';
  errors: SpecError[];
}

// 执行前独立合法性校验——只读，不创建实例 // @a: anc-cli-validate-response
export interface ValidateResponse {
  status: 'ok' | 'error';          // error = 存在 error 级违规（不可执行）；ok = 无 error（可能有 warn）
  errors: SpecError[];             // error 级违规（空 = 结构合法）
  warnings: SpecError[];           // warn 级违规（建议修复）
}

// hopjit list 响应：扫目录列可执行 spec（无状态纯函数）。见 [[hop-cli#^anc-cli-list]] // @a: anc-cli-list-response
export interface ListResponse {
  status: 'ok';
  dir: string;                     // 被扫描的目录
  specs: Array<{
    file: string;                  // 文件名（非全路径）
    id: string;                    // ast.header.id，缺省用 title
    goal: string;                  // Goal 首句
  }>;
}

/** hopjit next 推进响应联合，8 形态由 status 区分（drain_wait/dispatch_ready 为统一模型信号——
 * 派发/收齐两介入形态两模式共用；旧通道 parallel_ready 已随 P1 清理删除）。见 [[hop-cli#^anc-cli-next-response]] */
export type NextResponse = // @a: anc-cli-next-response
  | StepReady | AdaptiveNeeded
  | ExecutionCompleted | ExecutionFailed | ExecutionPaused | ToolRequest | DrainWait | DispatchReady;

/** DispatchReady：统一模型派发信号——主线走到标注 parallel 的 subtask，该子树应异步派发为子实例
 * （同 spec 子树收窄），主线随即继续。call parallel 不经此形态（独立模式 dispatcher 直派）。
 * 见 [[parallel-execution#^anc-exec-parallel-reap-drain]] subtask parallel 派发门。 */
export interface DispatchReady { // @a: anc-exec-parallel-dispatch-model, anc-exec-parallel-reuse-protocol
  status: 'dispatch_ready';
  instance_id: string;
  step_id: string;                       // 标注步骤 step_id（subtask 或 call）
  dispatch_kind: 'subtask' | 'call';     // 派发单位——driver 据此选 worker 形态（子树收窄 vs callee spec）
  child_instance: string;                // 子实例 id：<step_id>.<iter>
  host_container: string;                // 收齐点容器
  params_for_child: Record<string, unknown>;   // 派发时快照的子树外部入参
  // 复用模式：引擎拼好的 worker 启动命令（cd/--json/子实例定位参数全带——防漏参,同
  // ^anc-exec-parallel-launch-path 哲学）；独立模式缺省（dispatcher 进程内直起）。
  launch_command?: string;
  work_zone?: string;
  stale?: string[];   // 对账后待 driver 自查的在飞项（没起过就起/起过就等/确认死了显式报败——2026-08-13 dispatch-lost 降级,与 DrainWait.stale 同语义）
  stale_launch?: Record<string, string>;   // childInstance→launch_command（引擎按账面重拼——driver 对"没起过"的 stale 项原样执行零手拼）
}

/** DrainWait：收齐（gather）等待信号——宿主循环主线走完但仍有在飞子实例，caller/dispatcher
 * 等任一在飞终态收割后再推进；全部收好引擎自动完成循环容器。
 * 见 [[parallel-execution#^anc-exec-parallel-reap-drain]]。 */
export interface DrainWait { // @a: anc-exec-parallel-reap-drain, anc-exec-parallel-inflight-reconcile
  status: 'drain_wait';
  instance_id: string;
  loop_step_id: string;   // 收齐点=宿主 loop 容器
  inflight: string[];     // 在飞子实例 id（<step-id>.<iter>）
  // crash-resume 对账后仍未终态的在飞（P1 §U2）：复用模式 driver 应对这些项重起 worker
  //（子实例目录已有状态，run 子实例入口撞已有目录即续跑）。缺省缺席=无需重建。
  stale?: string[];
  stale_launch?: Record<string, string>;   // 同 DispatchReady.stale_launch
}

/** ToolRequest：act/commit body 引擎解释中撞到非内置工具调用——caller 只执行这一个工具并以
 * --tool-result 交回。args 已由引擎求值（变量代入后的实际值）。body 编排不外露。
 * 见 [[exec-engine#^anc-exec-tool-request]]。 */
export interface ToolRequest { // @a: anc-exec-tool-request
  status: 'tool_request';
  instance_id?: string;
  step_id: string;
  step_type: 'act' | 'commit' | 'check';   // check body 含工具时同权挂起 // @a: anc-step-check-body
  tool: string;                        // 工具名（body 里的 callee）
  args: Record<string, unknown>;       // 已求值命名参数
  tool_call_seq: number;               // 本步内第几个工具调用（1 起）——重放定位
  output_path?: string;                // 工具结果建议落盘路径（work_zone 内）
  work_zone?: string;
}

/** agent 主循环的正常推进信号：返回待执行步骤及其装配上下文。见 [[hop-cli#^anc-cli-step-ready]] */
export interface StepReady { // @a: anc-cli-step-ready, anc-exec-work-zone
  status: 'step_ready';
  instance_id: string;
  step_id: string;
  step_type: ExecutableStepType;
  summary: string;
  context: AssembledContext;
  work_zone: string;  // 实例 work_zone 工作区绝对路径(driver 写 @file 临时文件用), 见 anc-exec-work-zone
  output_path: string;  // 本步 output 文件确切路径(<work_zone>/out_<step_id>.json)——worker 照此写、--output "@<output_path>" 提交,零拼名自由度, 见 anc-exec-work-zone
  call_protocol?: CallProtocol;  // 仅 step_type=call 且复用模式 CLI 通道——命令拼装权归引擎,driver 照抄零手拼 // @a: anc-exec-call-protocol-payload
}

/** call 协议载荷（step_ready 附件,复用模式专属）：init/两回报命令引擎拼好——driver 照抄零手拼,
 * 消除手拼 init 参数的误用面（cc:call-fail 实撞根治,与 DispatchReady.launch_command 同纪律）。
 * 见 [[exec-engine#^anc-exec-call-protocol-payload]] */
export interface CallProtocol { // @a: anc-exec-call-protocol-payload
  init_command: string;      // callee 路径 <CALLEE_SPEC_PATH:id> 占位(寻址归 caller);params/trace/log 已折入
  child_state_dir: string;   // 子实例驱动循环的 --state-dir 值
  child_instance: string;    // 子实例 ID(=call step id)
  child_advance: string;     // 循环起步命令(init 后子实例未推进,advance 领首步——cc:call 实撞:未给则 driver 翻源码反推)
  report_completed: string;  // 成功回报命令全文(--child-instance)
  report_failed: string;     // 失败回报命令全文(--failure-child)
}

// 旧通道类型 ParallelReady/ParallelChildSpec/FanoutScheduleResult/FanoutWorker 已删（P1 清理，
// P2 承诺兑现——通道代码 P0.5 已删，类型面随 driver 面归零后清除）。

/** subtask 重试耗尽需重规划信号：携交付契约、原 children 与重试历史供 replan。见 [[hop-cli#^anc-cli-next-response]] */
export interface AdaptiveNeeded {
  status: 'adaptive_needed';
  instance_id: string;
  spec_id: string;              // 所属 spec Id（提报沉淀绑定，见 ReplanAudit）
  subtask_id: string;
  // 分辨字段（^anc-exec-subtask-free-expand F2 复用通道）：缺席=既有失败驱动语义（向后兼容,
  // 老 driver 零感知）;'initial_plan'=subtask free 到步首次规划——failure 置空形态,携 expansion_context
  reason?: 'initial_plan';
  // 执行时上下文（仅 initial_plan 在场）：容器 ← 输入名 → 变量实际值（deflate 大值卸载与 ask 人通道同律）
  // ——到步展开的价值本体=拿真产出定计划,不喂=盲规划（2026-08-27 作者点名条款）。
  // 缺值输入显式 null 占位（三轮 review:静默缺席使规划方分不清"值缺失"与"没这个输入"）
  expansion_context?: Record<string, unknown>;
  // 缺值输入名清单（仅 initial_plan 且有缺值时在场——与 expansion_context 的 null 占位配对）
  missing_inputs?: string[];
  failure: {
    step_id: string;
    reason: string;
    attempt: number;
    max_retries: number;
  };
  subtask_contract: {
    outputs: OutputDecl[];
    constraints: string[];
  };
  original_children: StepSummary[];
  retry_history: RetryRecord[];
}

// replan 提报记录:运行时生成(降级阶梯第3/4档)产物绑定,供离线沉淀为预声明备用链路。
// 见 design/spec-observability.md ^anc-obs-replan-audit。// @a: anc-obs-replan-audit
export interface ReplanAudit {
  spec_id: string;              // 哪个 spec(沉淀落点)
  step_id: string;              // 哪个 subtask
  error_reason: string;         // 触发 replan 的错误原因(未来备用链路的匹配键)
  generated_children: StepSummary[];  // 这次生成的 children(候选备用链路内容)
  base: 'scratch' | 'fallback'; // 从零(第4档)/ 基于备用链路改(第3档)
  at: string;                   // 时间戳
}

/** 执行成功终态：返回全部 outputs（大值可能为 $file 指针）。见 [[hop-cli#^anc-cli-next-response]] */
export interface ExecutionCompleted {
  status: 'completed';
  instance_id: string;
  outputs: Record<string, unknown>;    // 大值可能是 $file 指针(>4KB), 见 anc-exec-deflate
  work_zone: string;
}

/** 执行失败终态：给出失败步骤、原因与含 null 的部分产物。见 [[hop-cli#^anc-cli-next-response]] */
export interface ExecutionFailed {
  status: 'failed';
  instance_id: string;
  failed_step_id: string;
  failure_reason: string;
  partial_outputs: Record<string, unknown>;  // 含 null 值; 大值可能是 $file 指针
  work_zone: string;
  // 主线失败杀活清单（统一模型 §U4/§U8）：在飞被记 killed 的子实例 id——复用模式 driver
  // 尽力终止对应外部会话（停不掉不损语义,账面 killed 已保证 reap 短路）。
  kill_list?: string[];
}

/** CITL 介入暂停信号（confirm 审批 / ask 数据收集）：自包含介入请求，caller 拿到即知看什么给什么。见 [[hop-cli#^anc-cli-execution-paused]] */
export interface ExecutionPaused { // @a: anc-cli-execution-paused, anc-exec-hitl-presentation
  status: 'paused';
  instance_id: string;
  step_id: string;
  pause_reason: 'confirm' | 'commit' | 'waiting_human' | 'ask' | 'network' | 'escalate';  // confirm/commit/waiting_human=审批型；ask=数据收集型；network=网络中断暂停（^anc-exec-network-pause）;escalate=升层问路（^anc-exec-check-escalate——循环在要方向,接收端人/上层caller由拓扑定,应答guidance回注重试反馈不扣预算）
  // 自包含介入请求（见 ^anc-exec-hitl-presentation）——caller 拿到即知"看什么/给什么/怎么给"
  presented_data: {
    summary: string;
    question?: string;            // 自包含问题：confirm=审批什么动作；ask=要 caller 提供什么数据
    instruction: string;
    engine_impact?: string;
    context?: Record<string, unknown>;   // 待审批数据（confirm）/ 候选推断来源（ask）
    output_schema?: OutputDecl[];        // 要 caller 填的变量名+类型（ask）
    default_value?: unknown;             // 前序推断默认值（ask）
    present_inputs?: string[];           // 必须完整展示给 user 的 context 字段名子集（仅 ask）。driver 据此完整 dump 不缩略,见 ^anc-exec-hitl-presentation
  };
  response_options: ResponseOption[];
  work_zone: string;  // 实例 work_zone 工作区(driver 写 @file 临时文件用), 见 anc-exec-work-zone
  // 独立模式 call 递归：暂停帧的调用链（顶层 call step_id → … → 暂停 spec 的直接父 call）。
  // caller resume 时原样带回，runtime 剥头逐帧直达挂起帧（概念"完整调用链 key 直达有权决策者"落点）。
  // 顶层暂停缺省。见 design/step-dispatcher.md ^anc-exec-call-recursion。// @a: anc-exec-call-recursion
  call_path?: string[];
  // 子实例 HITL 队列寻址（U4b ^anc-exec-parallel-hitl-queue,0013）：parallel 子实例的暂停
  // 冒泡入队时携带,resume 按它路由到 pausedChildren 句柄。顶层/call 暂停缺省。
  child_instance?: string;
}

/** done/fail/branch/answer 命令的通用响应：ok 或带错误码的 error。见 [[hop-cli#^anc-cli-command-response]] */
export interface CommandResponse { // @a: anc-cli-command-response
  status: 'ok' | 'error';
  code?: ErrorCode;
  message?: string;
}

/** hopjit vars 响应：实例当前变量表与尚未赋值的 Outputs 变量名。见 [[hop-cli#^anc-cli-vars-response]] */
export interface VarsResponse { // @a: anc-cli-vars-response
  status: 'ok';
  instance_id: string;
  execution_status: 'running' | 'paused' | 'completed' | 'failed' | 'aborted';
  variables: Record<string, unknown>;
  pending_outputs: string[];
}

/** hopjit status 响应：实例执行状态与步骤计数（总/完成/失败/待执行/当前）。见 [[hop-cli#^anc-cli-status-response]]
 * paused 档（todo/0081）：停驻等外部应答时如实转述——此前枚举缺 paused 停驻报 running,
 * 看护方接此通道感知不到"引擎在等人"。pause_reason/paused_step_id 仅 paused 时在场。 */
export interface StatusResponse { // @a: anc-cli-status-response
  status: 'ok';
  instance_id: string;
  execution_status: 'running' | 'paused' | 'completed' | 'failed' | 'aborted';
  total_steps: number;
  completed: number;
  failed: number;
  pending: number;
  current_step?: string;
  pause_reason?: string;
  paused_step_id?: string;
}

import { homedir } from 'node:os';/** hopjit abort 响应：实例主动中止（用户"不要了"的暗管——[[exec-engine#^anc-exec-abort]]）。
 * 幂等重放同形态;completed/failed 实例 abort 走 error 面 ABORT_TERMINAL_CONFLICT。
 * 见 [[hop-cli#^anc-cli-abort-response]] */
export interface AbortResponse { // @a: anc-cli-abort-response, anc-exec-abort
  status: 'ok';
  instance_id: string;
  execution_status: 'aborted';
  abort_reason: string;
}

/** hopjit replan 响应联合：重规划成功或解析/校验失败。见 [[hop-cli#^anc-cli-replan-response]] */
export type ReplanResponse = ReplanSuccess | ReplanError; // @a: anc-cli-replan-response

/** replan 成功：返回替换后的新步骤摘要。见 [[hop-cli#^anc-cli-replan-response]] */
export interface ReplanSuccess {
  status: 'ok';
  new_children: StepSummary[];
}

/** replan 失败：携错误码与解析或校验错误。见 [[hop-cli#^anc-cli-replan-response]] */
export interface ReplanError {
  status: 'error';
  code: ErrorCode;
  errors: SpecError[];
}

/** hopjit branch 请求体：手动覆盖引擎自动条件评估，用于调试或外部 HITL 介入。见 [[hop-cli#^anc-cli-branch-request]] */
export interface BranchRequest { // @a: anc-cli-branch-request
  step_id: string;
  selected_case_id: string;
  reason?: string;
}
