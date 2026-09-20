// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: exec-engine ^anc-struct-exec-engine
// 引擎内部运行时类型——随实现演进（非对外稳定面）：事件流/快照/状态文件/组装上下文。
// 拆自原 types.ts（见 design/spec-ast.md ^anc-struct-spec-ast 拆分表）。

import type { SpecAST, OutputDecl, ResponseOption, StepSummary } from './ast-types.js';
import type { SandboxConfig } from './provider-types.js';

// Engine 内存事件流——L3 上下文和失败原因查询用，非持久化日志
export interface ExecEvent {
  at: string;
  step_id: string;
  event: string;
  detail?: string;
}

/** 步骤失败的结构化分类——`lack_of_info`（缺信息，driver 可补充知识或上传父层）或 `error`（一般错误，走 retry/adaptive）。见 [[exec-engine#^anc-struct-exec-engine-exports]] */
// deterministic：重跑必然同因的失败（深度墙/子层已耗尽等）——升级链跳过重试档直达兜底/上浮
// （^anc-exec-deterministic-no-retry;存量经 reason 前缀口袋兜住,新错误产生点用本枚举）。
// @a: anc-exec-deterministic-no-retry
// tool_failure：reason+无 body act 步工具故障自报（^anc-exec-tool-failure-report——容器阶梯
// 走缺省重试路径,瞬时故障重试即愈;不入 deterministic 掐重试名单）。// @a: anc-exec-tool-failure-report
export type FailKind = 'lack_of_info' | 'error' | 'deterministic' | 'tool_failure';

/** 单个步骤的失败记录——人类可读原因加失败分类，按 step_id 存入 state.json 供 get_failure_reason 跨进程直读。见 [[exec-engine#^anc-exec-state-persistence]] */
export interface StepFailRecord {
  reason: string;
  fail_kind: FailKind;
}

/** subtask 一次重试尝试的档案——尝试轮次、失败原因与已试步骤摘要，供 adaptive replan 与 L2c 带反馈重跑消费。见 [[shared-types#^anc-type-auxiliary]] */
export interface RetryRecord {
  attempt: number;
  failure_reason: string;
  steps_tried: StepSummary[];
}

/** PromptAssembler 组装后的六层执行上下文——任务契约、知识注入、进度摘要、输入、指令与输出约束，随 StepReady 交给 driver。见 [[exec-engine#^anc-exec-prompt-assembly]] */
export interface AssembledContext { // @a: anc-exec-prompt-assembly
  task_context: string;           // L1 任务契约: Goal + Constraints + Types + Outputs + 骨架（跨步恒定——缓存亲和稳定面）// @a: anc-exec-cache-affinity
  position_context?: string;      // L3 位置半边: 容器链 + 当前步骤本体行（逐步变化;渲染进 L3 区块——旧独立"当前位置"区块废除）// @a: anc-exec-l3-position
  spec_knowledge_context?: string; // L2-spec: spec 级知识（Spec @knowledge 预检索——跨步恒定入稳定面）// @a: anc-exec-cache-affinity
  knowledge_context?: string;     // L2-step: 步骤级知识（步骤 @knowledge + 补充 + 动态检索——随步变）
  tool_manifest?: string;         // L4 工具清单（0054 ^anc-step-tool-grant——无 body act 的实发工具面:每件从注册面取真身〔名/语义/params/output_schema〕+作者意图注释;渲染进 L4 当前节点区块）
  doc_ref_context?: string;       // L2: doc-ref [[doc#章节]] 确定性精确引用（渲染进 L2 区块,yaml 条目化）// @a: anc-exec-doc-ref-injection
  hop_env_table?: string;         // L2: hop_env 值表（spec 引用了 hop_env_* 时随 prompt 注入,执行 LLM 自行指代——instruction 不做引擎展开）// @a: anc-exec-hop-env-table
  progress_summary: string;       // L3 轨迹半边: 执行链上下文（已完成步骤摘要）
  iteration_history?: string;     // L3 续: loop 迭代历史（拆分自执行链）
  upstream_feedback?: string;     // L6: 上游反馈（call 边界传入的父层重试反馈——子实例全步骤可见,D41;先于重试反馈渲染）// @a: anc-exec-l2c-retry-feedback
  retry_feedback?: string;        // L6: 重试反馈（带反馈重跑时的修正指令——人话工单形态在渲染层,本字段装意见文本）
  // L5 打回轮恒供给（2026-08-31 作者抓两缺:"是上轮的什么输出有问题——不一定只有一个 act/reason"
  // /"输出值可否让查"。rejected_by=来源 check 点名+其 ← 核对象清单（AST 机械事实,多产出对号）;
  // prior_outputs=当前步骤输出声明的留存值逐条（重试回滚不清变量——留存缺省半边实装;
  // 值分档:≤2000 chars inline / 超阈 $file 卸载路径+预览 / 卸载不可用如实全文）。
  // @a: anc-exec-l2c-retry-feedback
  retry_context?: { rejected_by?: { step_id: string; summary?: string; checked_inputs: string[] }; check_failed_origin?: boolean; prior_outputs?: { name: string; type: string; rendered: string; offloaded?: boolean; offload_path?: string; full_chars?: number }[] };   // offload_path/full_chars:卸载档中性事实（指路措辞归渲染层按工具面分叉——^anc-exec-inputs-deflate 普遍规则） // @a: anc-exec-inputs-deflate
  fail_context?: string;          // L3 尾: on fail 兜底步的失败上下文（哪步/第几轮/原因文本,人话渲染——仅激活态 on_fail 子树内步骤供给;措辞对善后者,不落 L6 修正指令语义）// @a: anc-exec-onfail-context
  inputs: Record<string, unknown>; // L4: 输入材料——← var 实际值字典
  // L4: 输入元信息（组装期从声明处预计算——渲染层保持纯函数）。type_closure=该变量声明类型
  // 牵出的 TypeDecl 闭包（类型名→字段类型表,0064 递归 HopSchema 渲染的字段类型料源——声明
  // 优先于运行时推断）。// @a: anc-exec-inputs-render
  input_meta?: Record<string, { type?: string; description?: string; type_closure?: Record<string, Record<string, string>> }>;
  node_decl?: { step_id: string; step_type: string; summary: string; input_names: string[] }; // L5: 当前节点声明形态（渲染层拼节点行与 ← 清单）// @a: anc-exec-l5-node-impl
  instruction: string;            // L5: 执行说明正文
  output_schema: OutputDecl[];    // L5: 输出声明（渲染进 L5 节点内,不再独立成层）
  // 弱模型档修订短 prompt（^anc-exec-revision-short-weak——revision_prompt: short 档且打回重试轮
  // 时组装期置位;渲染层见此标志走短分支:命令整体替换为修订祈使句,从头教学框架全撤。
  // constraints_text=L1 Constraints 单独抽出（安全红线保留,其余 L1 撤下）。
  // @a: anc-exec-revision-short-weak
  revision_short?: boolean;
  constraints_text?: string;
}

// --- Persistence snapshot types ---

/** 在飞子实例记账（parallel 统一模型 P0：call parallel 渐进派发）——随 StateFile 原子落盘，
 * resume 恢复收齐语义。killed=主线失败清场终态（结果丢弃、不复活）。
 * 见 [[parallel-execution#^anc-exec-parallel-inflight]] */
export interface InflightCall { // @a: anc-exec-parallel-inflight
  step_id: string;         // 标注 parallel 的步骤 id（call 或 subtask，P0.5 起共用本账）
  iter: number;            // loop 体内派发时迭代序号（1 起）——子实例目录后缀、collect 序；兄弟位恒 1
  child_instance: string;  // 子实例 id：<step_id>.<iter>
  host_container: string;  // 收齐点/杀活域：宿主 loop 或父容器（兄弟位）
  dispatched_at: string;
  status: 'inflight' | 'killed' | 'paused';   // paused=子实例等人（让名额不占并发,收齐门照等——U4b HITL 队列,^anc-exec-parallel-hitl-queue）
  params?: Record<string, unknown>;   // 派发时入参快照（stale_launch 重拼用——loop 已推进后 itemVar 现值≠派发时值,现算必错;2026-08-13 review 抓漏）
}

/** state.json 持久化结构——步骤状态/计数器/事件流/窗口调度/在飞记账等执行态全集，
 * writeAtomic 原子落盘、load 全量恢复。见 [[exec-engine#^anc-exec-state-persistence]] */
export interface StateFile {
  format_version: 1;
  step_states: Record<string, string>;
  retry_counters: Record<string, number>;
  loop_counters: Record<string, number>;
  retry_history?: Record<string, RetryRecord[]>;  // 跨进程保留失败历史，供 L2c 带反馈重跑
  escalate_pending?: string | null;  // 升层待答步（^anc-exec-check-escalate——跨进程 resume 走专用消化路的判据）
  step_fail_reasons?: Record<string, StepFailRecord>;  // step_id → 失败记录(reason+fail_kind)；getFailureReason 直读，跨进程稳定
  exec_events?: ExecEvent[];  // 执行事件流（执行历史原料），供 PromptAssembler 重建 L3 上下文（loop 迭代时序/子步状态）
  log_dir?: string;
  hoplog_run_dir?: string;
  adaptive_needed_subtask?: string;
  terminal_failure?: { stepId: string; reason: string };  // 未捕获失败=实例终止（函数级 fail,2026-08-09）——nextStep 短路 failed,跨进程稳定
  // 终态标记（0043"暂停有卡,终局有据"终局半边）——completed/failed 随快照落盘,跨进程可判;
  // 缺席=run 未终(running/paused 按既有编码判)。runStatus 快照兜底消费。
  // aborted=实例主动中止终态（2026-08-26,[[exec-engine#^anc-exec-abort]]——用户"不要了"的暗管,
  // 复用模式跨进程持久）。// @a: anc-exec-state-persistence, anc-exec-abort
  terminal_state?: 'completed' | 'failed' | 'aborted';
  notify_channel?: string;   // 复用模式通知渠道名（现枚举只 dingtalk;^anc-cli-notify-reuse EngineSnapshotNotifyExt） // @a: anc-cli-notify-reuse
  // 父层修正意见（D41 call 边界）跨进程持久——复用模式 init 与 advance 是两个进程,内存值
  // 活不过 init（同 notify_channel 先例）;不落盘则 init --upstream-feedback 载荷在 advance
  // 进程为空,H2 复用半边断链（2026-09-01 变异核证实锤补账）。// @a: anc-exec-l2c-retry-feedback
  upstream_feedback?: string;
  // 驱动通道落账（2026-08-27 两模式并存三改的安全半边——双执行硬闸:同一 run 被 CLI 与 MCP
  // 两条通道各推一遍是最高危事故。run 建立时入口写入,推进类入口核对不符响亮拒;缺席=旧 run
  // 宽容,首个推进入口认领。见 [[exec-engine#^anc-exec-driver-channel]]）。// @a: anc-exec-driver-channel
  driver_channel?: 'cli' | 'mcp';
  abort_reason?: string;  // 中止原因（仅 aborted 在场;人话入账供追溯——中止是意图不是失败,与 terminal_failure 区分）// @a: anc-exec-abort
  expansion_count?: number;  // 全实例累计展开次数（subtask free 熔断底账,上限=Config expansion_max 缺省20——跨进程持久防空炮）// @a: anc-exec-subtask-free-expand
  // 重复 replan 检测（REPLAN_DUPLICATE）跨进程稳定——两模式的 replan 都跨进程（复用模式每命令
  // 独立进程,独立模式 paused-resume）。见 [[exec-engine]] last_replan_children 字段。// @a: anc-exec-retry-adaptive
  last_replan_children?: Record<string, StepSummary[]>;
  // 累计 token 消耗（Dispatcher 累计→引擎随快照落盘→resume 回填）——预算护栏不被进程重启绕过。
  // token_budget 不落盘（宿主 resume 时重新给定的配置,非执行状态）。见 [[step-dispatcher#^anc-exec-cost-guardrails]]。// @a: anc-exec-cost-guardrails
  cumulative_tokens?: number;
  can_fanout?: boolean;  // @a: anc-exec-parallel-subinstance — agent 环境标识：是否允许 fan-out。顶层 true / parallel worker 子实例 false（已在并行分支内）
  context_mode?: 'full' | 'minimal';  // @a: anc-exec-context-mode — context 精简档（run 时定，env 可覆盖）；缺省 full
  subtree_root?: string; // @a: anc-exec-parallel-subinstance — parallel worker 子实例：执行 scope 收窄到的 child 子树根 step_id（其余预标 skipped）。worker 提示词据此裁 L1 骨架
  // fan-out CLI 调度顾问：CLI 决定派发某 child 时原子记入，供 fanout-plan/fanout-next 无状态复原窗口、防重复派发。
  // 独立于 step_states 的 running（nextParallelBatch 一次性标全部 running）——dispatched 是窗口调度语义。
  // 见 design/parallel-execution.md ^anc-exec-parallel-fanout-advisor / ^anc-exec-parallel-fanout-concurrency。// @a: anc-exec-parallel-fanout-advisor, anc-exec-parallel-fanout-concurrency
  dispatched?: Record<string, string[]>;  // parallel_step_id → 已派发的 child_step_id 列表
  // 统一模型在飞记账（call parallel 渐进派发）：派发即原子落盘防重，收割即移出；
  // crash-resume 据此重建收齐语义。killed 项保留（不复活凭据）。// @a: anc-exec-parallel-inflight
  inflight?: InflightCall[];
  // commit 退火标记集：已执行过的 commit 步 id——重跑范围盖到它的祖先边界 retry 触发即 fail 防重放（^anc-exec-commit-anneal 判据重构:记录带祖先 loop 轮次快照永续不清）。
  // 不能用 step_states 判（loop 迭代复位 pending 漏判）。见 exec-engine ^anc-exec-retry-adaptive
  // commit 退火跳级条。// @a: anc-exec-commit-anneal
  // commit 退火记录（^anc-exec-commit-anneal 判据重构 2026-09-02）:新形态带祖先 loop 轮次
  // 快照;旧 string[]（v0.33.x 前快照缺席）load 时置空快照——判定恒命中,保守兼容。
  committed_steps?: (string | { step_id: string; iters?: Record<string, number> })[];
  // on_fail 兜底激活集（^anc-step-on-fail）：激活即登记,防重入+跨进程恢复。// @a: anc-exec-on-fail
  on_fail_active?: string[];
  on_fail_consumed?: string[];   // 兜底消耗集（激活/消耗分离,2026-09-04）// @a: anc-exec-on-fail
  deterministic_waived?: string[];   // 确定性失败免预算记账（乙案有界化）// @a: anc-exec-deterministic-no-retry
  pending_chain_feeds?: { chain_child_id: string; loop_id: string; iter: number; unit_var: string; list_var: string }[];   // 续链失败/壳边界待喂账,按收集对记（跨进程兑现）// @a: anc-exec-parallel-reap-chain
  // 复用模式 act body 引擎执行：本步已完成的工具结果序列（按 tool_call_seq 顺序）。
  // 确定性重放的记忆：新进程重放 body 撞第 N 个工具调用查 [N-1]，有则代入无则发 tool_request。
  // 步骤完成/失败/重试时清本步条目。见 design/exec-engine.md ^anc-exec-tool-request。// @a: anc-exec-tool-request
  tool_journal?: Record<string, unknown[]>;  // step_id → 工具结果列表（按调用序）
  // time 内置（now/today）重放记值——与 tool_journal 并列独立键（元素类型不同不并入），
  // 持久化/恢复/清理三时机与其逐点同步。见 design/act-body.md ^anc-exec-time-builtins。// @a: anc-exec-time-builtins
  time_journal?: Record<string, string[]>;   // step_id → 时间值列表（按求值序）
  cmd_journal?: Record<string, Array<{ stdout: string; stderr: string; returncode: number }>>;   // step_id → 命令结果列表（subprocess.run 重放,^anc-exec-subprocess-run） // @a: anc-exec-subprocess-run
  spec_path?: string;     // spec 文件绝对路径，供 fanout 顾问跨进程拼 worker launch_command
  cli_abs_path?: string;  // CLI 入口绝对路径，同上
  max_concurrent?: number; // fan-out 窗口上限（来自 resource_limits），持久化供顾问跨进程复原——host_context 不含 resource_limits
  // HostConfig 可序列化最小子集（不含凭证）——doc-ref/P15 跨进程 resume 需 workspace+sandbox。
  // 见 design/exec-engine.md ^anc-exec-host-context-persist。// @a: anc-exec-doc-ref-resolve
  host_context?: { workspace_dir: string; sandbox: SandboxConfig; hop_env?: Record<string, string>; config_project_dir?: string };   // hop_env 随 state 持久化——复用模式 next/done 独立进程,doc-ref 展开/L2e/ask 回填须同表 // @a: anc-config-hop-env ; config_project_dir=配置读取根随快照钉住（BUG-I）// @a: anc-mcp-run-restore
}

/** 单个作用域的持久化数据——父 scope id（root 为 null）+ 本层变量。见 [[exec-engine#^anc-exec-vars-scope-persist]] */
export interface ScopeData {
  parent: string | null;
  variables: Record<string, unknown>;
}

/** vars.json 的持久化结构，先于 state.json 原子写入。见 [[exec-engine#^anc-exec-vars-scope-persist]]
 * - v2（当前）：`scopes` 落盘完整 scope 树（scopeId → {parent, variables}），跨进程 scope 隔离保真。
 * - v1（旧）：`variables` 扁平字典（无 scope 前缀），读时全塞 root 向后兼容。 */
export interface VarsFile {
  format_version: 1 | 2;
  variables?: Record<string, unknown>;  // v1 legacy——扁平变量字典
  scopes?: Record<string, ScopeData>;   // v2——完整 scope 树
}

/** 引擎完整快照——spec AST、状态文件与变量文件三合一，PersistenceProvider save/load 的载荷单元。见 [[shared-providers#^anc-provider-persistence-iface]] */
export interface EngineSnapshot {
  spec: SpecAST;
  state: StateFile;
  vars: VarsFile;
}
