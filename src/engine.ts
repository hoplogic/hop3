// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: exec-engine ^anc-struct-exec-engine
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, realpathSync, unlinkSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec, serializeSpec } from './parser.js';
import { validateSpec, validateOutputValues, coerceOutputValues, recoverOutputValues, recoverFencedValue, normalizeOutputsToFixpoint, formatSchemaMismatch } from './validator.js';
import { VariableStore, getWriteScope, isTerminalStatus, type StepStatus } from './ast-runtime.js';
import {
  dfsNextStep, propagateCompletion, finalizeForEachCollect,
  collectDescendants, findNonTerminalBefore,
  type TraversalState, getCollectPairs, getAsyncUnitVars } from './engine-traverse.js';
import { FilePersistence, MemoryPersistence, writeChildParams, readChildParams, stateExists, readState, readVars, flattenVars } from './persistence.js';
import { HopLog, timestamp, type LogLevel } from './hoplog.js';
import { resolveDocRefs, formatDocRefContext, DocRefError } from './doc-ref.js';
import { getParentStepId, isParallelContainer, getForEach } from './ast-helpers.js';
import type { PersistenceProvider, HostConfig, ToolProvider } from './provider-types.js';
import { credentialLikeHopEnvKey, hopEnvCredentialError } from './provider-types.js';
import type { ExecEvent, FailKind, StepFailRecord, StateFile, AssembledContext, RetryRecord, InflightCall } from './runtime-types.js';
import { PromptAssembler, formatPromptText, formatHumanContext, actRoleKind } from './prompt.js';
import type { SpecAST, StepNode, ExecutableStepType, SubtaskStep, CaseStep, StepSummary, BranchStep, CheckStep, CallStep, ConfirmStep, AskStep, ResponseOption, ActStep, CommitStep, ParallelStep , LoopStep, OutputDecl } from './ast-types.js';
import { DEFAULT_EXPANSION_MAX } from './ast-types.js';   // @a: anc-exec-subtask-free-expand
import type { InitResponse, NextResponse, CommandResponse, StatusResponse, VarsResponse, ReplanResponse, StepReady, AbortResponse, AdaptiveNeeded } from './cli-types.js';
import type { ValidationError } from './errors.js';
import { EXECUTABLE_STEP_TYPES, CONTAINER_STEP_TYPES, hasChildren, getChildren, DEFLATE_THRESHOLD, isUpdateModeOutput } from './ast-helpers.js';
import { ErrorCode } from './errors.js';
import { bodyHasToolCall } from './act-body-parser.js';
import { BodyInterpreter, ToolCallPending, makeReplayToolProvider, evalExprSync } from './act-body-interpreter.js';

// 重试容器：subtask 或 case（case 就是 branch 下的 subtask，retry/adaptive 语义相同）
type RetryContainer = SubtaskStep | CaseStep;

// confirm 拒绝类决策值（小写匹配）→ failStep。见 ^anc-exec-confirm-answer
const CONFIRM_REJECT_VALUES = new Set(['reject', 'rejected', 'deny', 'denied', 'no']);


// 哑 ToolProvider：引擎消化纯计算 body 时用——无工具 body 不会调 execute（bodyHasToolCall 已保证）；
// 若误调说明 isCallerActionPoint 判定漏了工具，抛错暴露 bug。见 ^anc-exec-advance-to-caller
const ENGINE_NOOP_TOOL_PROVIDER: ToolProvider = {
  list: () => [],
  execute: async (name: string) => {
    throw new Error(`TOOL_EXEC_ERROR: 引擎消化纯计算 body 不应调工具 "${name}"——isCallerActionPoint 判定遗漏`);
  },
};

/** ExecutionEngine 构造/初始化选项——状态目录、持久化、日志、Inputs 实参、call/parallel 子实例参数等。见 [[exec-engine#^anc-struct-exec-engine]] */
// 派发启动宽限期（§U2 dispatch-lost 判据）：账面已入而子实例目录未建的允许时长——
// 覆盖复用模式后台 worker 启动延迟；超此才判 dispatch-lost。// @a: anc-exec-parallel-inflight-reconcile
const DISPATCH_GRACE_SECONDS = 60;

/** ExecutionEngine 构造选项（stateDir 持久化根/父子实例关联/trace 继承）——cli/mcp-server/dispatcher 建实例消费。见 [[exec-engine#^anc-struct-exec-engine]] */
export interface EngineOptions {
  stateDir?: string;
  persistence?: PersistenceProvider;
  logDir?: string;
  logLevel?: LogLevel;
  // Spec Inputs 的实参（init 时注入初始变量；覆盖 Inputs 声明的 default）。
  // 必须在 init 内注入——init 内部 persist 一次，事后从外部 write 不会落盘（跨进程丢失）
  params?: Record<string, unknown>;
  // call 子实例（复用模式）：子实例 id 用 callStepId，状态落 .hopstate/<parent>/calls/<callStepId>/
  parentInstanceId?: string;
  callStepId?: string;
  traceId?: string;
  // call 边界反馈传递（D41 ^anc-exec-l2c-retry-feedback L2b 条）：父层重试反馈跨 call 传入——
  // 子实例 PromptAssembler 渲染 L2b 上游反馈区块全步骤可见;递归下传逐层拼接,截断衰减。
  upstreamFeedback?: string;
  // 驱动通道（双执行硬闸——建 run 入口声明,init 内部 persist 前置入,落盘即有账）。
  // @a: anc-exec-driver-channel
  driverChannel?: 'cli' | 'mcp';
  // canFanout：现行 agent 环境门——dispatcher 顶层置 true（dispatcher.ts 非 worker 时 setCanFanout(true)），
  // CLI 侧以 getCanFanout 作 unifiedDispatch 门的上游（cli.ts advance 路径）。
  // worker 子实例置 false（已在并行分支内，内层 parallel 退化串行）。持久化进 StateFile。
  canFanout?: boolean;
  // parallel worker 子实例：执行 scope 收窄到此 child 子树根（其余步骤预标 skipped）
  subtreeRoot?: string;
  // spec 文件路径（CLI 传入，用于 parallel prompt 组装 worker 启动命令）
  specPath?: string;
  // CLI 入口绝对路径（CLI 传入，parallel prompt 里的命令用）
  cliAbsPath?: string;
  // context 精简档（run 时定，持久化进 StateFile；env HOPJIT_CONTEXT_MODE 每命令可覆盖）。见 ^anc-exec-context-mode
  contextMode?: 'full' | 'minimal';
}

/** HopJIT 执行状态机——驱动 HopSpec 从初始化到终态，管理步骤状态机/树状变量作用域/retry-adaptive 配额/None 传播。见 [[exec-engine#^anc-struct-exec-engine]] */
export class ExecutionEngine { // @a: anc-struct-exec-engine
  private instanceId: string = '';
  private spec: SpecAST | null = null;
  private hostConfig: HostConfig | null = null;
  private stepStates: Map<string, StepStatus> = new Map();
  private variables: VariableStore = new VariableStore();
  private loopCounters: Map<string, number> = new Map();
  private retryCounters: Map<string, number> = new Map();
  private retryHistory: Map<string, RetryRecord[]> = new Map();
  private replanCounters: Map<string, number> = new Map();
  private lastReplanChildren: Map<string, StepSummary[]> = new Map();
  // 累计 token 消耗——Dispatcher 累计后经 setCumulativeTokens 同步,随快照落盘,resume 回填。
  // 预算护栏不被进程重启绕过。见 design/step-dispatcher.md ^anc-exec-cost-guardrails。// @a: anc-exec-cost-guardrails
  private cumulativeTokens = 0;
  private adaptiveNeededSubtask: string | null = null;
  // proactive 编辑独立计数（熔断分池,^anc-exec-replan-proactive 第4条——不占 adaptive 3 次救命额度）
  private proactiveReplanCounters = new Map<string, number>();
  // 未捕获失败=实例终止（2026-08-09 函数级 fail）：升级链到顶无边界时置位,nextStep 短路返回 failed。
  // 持久化（terminal_failure）——跨进程稳定,防容器 done 级联吞失败后误判 completed。
  private terminalFailure: { stepId: string; reason: string } | null = null;
  // 终态标记（0043 终局有据）：completed/failed 出口经 finalizeTerminal 置位+persist——
  // 跨进程读快照可判终局（原四出口零 persist,dfs 状态转移只活在内存,快照恒"差最后一步"）。
  // aborted=实例主动中止（^anc-exec-abort,2026-08-26）——abort() 置位,同 persist 路径跨进程稳定。
  private terminalState: 'completed' | 'failed' | 'aborted' | null = null;
  // 驱动通道（双执行硬闸——run 建立时入口写入,推进类入口核对;缺席=旧 run 首个推进入口认领）。
  // @a: anc-exec-driver-channel
  private driverChannel: 'cli' | 'mcp' | null = null;
  // 复用模式通知渠道（run --notify <渠道> 置值持久;子实例不继承——通知归顶层 run,worker 不发。
  // 存渠道名不存布尔:字段装的是"用哪个渠道"（命名忠实,2026-08-31 作者定渠道随话语走零配置文件）。
  // ^anc-cli-notify-reuse EngineSnapshotNotifyExt） // @a: anc-cli-notify-reuse
  notifyChannel: string | null = null;
  private abortReason: string | null = null;   // 中止原因（仅 aborted 在场——意图入账,与 terminalFailure 的失败区分）// @a: anc-exec-abort
  // 全实例累计展开次数（^anc-exec-subtask-free-expand 契约7——嵌套 free 各池独立使 3 次熔断失效,上限=Config expansion_max 可调,
  // 独立总计数,上限=Config expansion_max（缺省 DEFAULT_EXPANSION_MAX）;持久化跨进程〔/hop 逐命令新进程,不落盘=熔断空炮,proactive 批同病先例〕）
  private expansionCount = 0;
  private execEvents: ExecEvent[] = [];
  private stepFailReasons: Map<string, StepFailRecord> = new Map();
  private stateDir: string | null = null;
  private instanceDir: string | null = null;
  private persistence: PersistenceProvider | null = null;
  private logDir: string | null = null;
  private hoplog: HopLog | null = null;
  // call 边界上游反馈（D41——L2b 区块数据源;持久化进 state.json（saveState 写 upstream_feedback、
  // load 回填）——init 与 advance 是两个进程,不落盘则跨进程断链）。// @a: anc-exec-l2c-retry-feedback
  private upstreamFeedback: string | null = null;
  getUpstreamFeedback(): string | null { return this.upstreamFeedback; }
  private canFanout = false;       // @a: anc-exec-parallel-canfanout — 顶层 true / worker 子实例 false。持久化进 StateFile
  private subtreeRoot: string | null = null;  // @a: anc-exec-parallel-subinstance — worker 子实例执行 scope 收窄到的 child 子树根
  private rawSource: string | null = null;  // spec 原文（initExecution 留存;独立模式 worker/call 重建子引擎用——serializeSpec 单向有损禁用于重建）
  private specPath: string | null = null;     // spec 文件路径（CLI 传入，parallel prompt 组装用）
  private cliAbsPath: string | null = null;   // CLI 入口绝对路径
  // 本步已获工具结果序列（确定性重放记忆），随 state 持久化。// @a: anc-exec-tool-request
  private toolJournal: Record<string, unknown[]> = {};
  // commit 退火标记集：已执行过的 commit 步 id（含 call 子实例含 commit 时的 call 步 id）。
  // 随 state.json 持久化——不能用 step_states 判（loop 迭代复位 pending 会漏判）。
  // 见 [[exec-engine#^anc-exec-retry-adaptive]] commit 退火跳级条。// @a: anc-exec-commit-anneal
  // commit 退火记账（^anc-exec-commit-anneal 2026-09-02 判据重构）：stepId → 该 commit 执行
  // 时刻其全部祖先 loop 的轮次快照（{loopId: iter}）。同 stepId 多轮 commit 最新覆盖（轮内
  // 判定只需最新,外层判定存在即中——最新对两判定都充分）。记录永续不随迭代清除——退火失效
  // 由轮次比对承担（一份无轮次记录背两职责的旧形态,清除与否都顾此失彼:v1 只增不清焊死新轮
  // 〔0061〕,v2 按轮清除外层重放〔CA-1〕）。
  private committedSteps = new Map<string, Record<string, number>>();
  // on_fail 已激活集（^anc-step-on-fail）：宿主 retry 耗尽激活兜底登记,持久化随 state.json。
  // // @a: anc-exec-on-fail
  private onFailActive = new Set<string>();
  // 兜底消耗集（2026-09-04 激活/消耗分离——激活=执行流转入,消耗=兜底子树真实走完;0037 死法②:
  // 单集身兼两职,"已激活未执行"被当"已用过"拒绝再激活直接上浮）// @a: anc-exec-on-fail
  private onFailConsumed = new Set<string>();
  // 确定性失败免预算记账（2026-09-04 乙案有界化——step_id+'|'+前缀 → 已免过;首次免扣复发照扣,
  // 防"预算永不减兜底永不到"的无限循环）// @a: anc-exec-deterministic-no-retry
  private deterministicWaived = new Set<string>();
  // 续链失败投递的待喂账（^anc-exec-parallel-reap-chain）：失败投回壳后,壳的兜底要经正常驱动
  // 走完才有边界产出——那时收割上下文（iter）已不在场。投递时记账,壳完结时（completeStep 后
  // 扫账）按记录的 iter 喂 collect 缓冲。随快照持久（兜底可能跨进程走完）。
  private pendingChainFeeds: { chain_child_id: string; loop_id: string; iter: number; unit_var: string; list_var: string }[] = [];   // 按收集对记账（复阅实抓:不分 unitVar 的账在双收集对形态下双重喂送——元素翻倍/幻影 null）
  // time 内置重放记值（now/today）——与 toolJournal 同生命周期（持久化/恢复/清理逐点同步）。
  // 见 design/act-body.md ^anc-exec-time-builtins。// @a: anc-exec-time-builtins
  private timeJournal: Record<string, string[]> = {};
  // subprocess.run 命令结果重放账（^anc-exec-subprocess-run——与 timeJournal 同款三时机:
  // 注入持久数组/完成清/重试清;跨进程随 state.json cmd_journal 键）// @a: anc-exec-subprocess-run
  private cmdJournal: Record<string, Array<{ stdout: string; stderr: string; returncode: number }>> = {};
  // fan-out CLI 调度顾问：parallel_step_id → 已派发 child_step_id 列表。CLI 派发即原子记入（防重复派发）。
  // 见 design/parallel-execution.md ^anc-exec-parallel-fanout-advisor。// @a: anc-exec-parallel-fanout-advisor
  private dispatched = new Map<string, string[]>();
  private joinStartedAt: string | null = null;  // join 单进程内瞬态：进入 joinParallel 的时刻，join 块 started_at（不持久化）
  // fan-out 窗口上限，跨进程持久化（host_context 不含 resource_limits，load 后 hostConfig 丢失窗口值）。
  private maxConcurrent: number | null = null;
  private contextMode: 'full' | 'minimal' = 'full';  // @a: anc-exec-context-mode — context 精简档；run 时定、持久化，env 可覆盖
  // 统一模型在飞记账（call parallel 渐进派发）：派发即入账落盘（防重），收割即出账；
  // killed 项保留（不复活凭据）。见 design/parallel-execution.md §U2。// @a: anc-exec-parallel-inflight
  private inflight: InflightCall[] = [];
  // 统一模型派发门：独立模式 dispatcher 置位；复用模式恒关（subtask parallel 串行下钻=退化窗口）。
  // @a: anc-exec-parallel-dispatch-model
  private unifiedDispatch = false;

  initExecution(specMarkdown: string, hostConfig: HostConfig, options?: EngineOptions): InitResponse {
    this.rawSource = specMarkdown;  // 留存原文供独立模式 worker/call 重建子引擎（serializeSpec 单向有损,不可用于重建）// @a: anc-exec-standalone-parallel
    const { ast, errors: parseErrors } = parseSpec(specMarkdown);
    if (parseErrors.length > 0) {
      return { status: 'error', errors: parseErrors };
    }

    // spec 目录读授权（随 spec 引用即授权,与 hop_env"写参即授权"同款——doc-ref 两级基准的
    // 第一级候选可在 workspace 外,如全局装的 skill 目录;denied 基线仍优先拦）。
    // 见 [[doc-ref#^anc-exec-doc-ref-resolve]] 解析基准条。// @a: anc-exec-doc-ref-resolve
    const specDir = options?.specPath ? dirname(resolve(options.specPath)) : undefined;
    if (specDir && !hostConfig.sandbox.filesystem.read_access.allowed.includes(specDir)) {
      hostConfig.sandbox.filesystem.read_access.allowed.push(specDir);
    }
    // P15 doc-ref 静态校验需 workspace + sandbox（hostConfig 提供）;specDir 随传（两级基准与注入期同判）。// @a: anc-rule-p15
    const validationErrors = validateSpec(ast,
      hostConfig.workspace_dir ? { workspace_dir: hostConfig.workspace_dir, sandbox: hostConfig.sandbox, hop_env: hostConfig.hop_env, spec_dir: specDir } : undefined);
    const fatalErrors = validationErrors.filter((e: ValidationError) => e.severity === 'error');
    if (fatalErrors.length > 0) {
      return { status: 'error', errors: fatalErrors };
    }
    // warn 级不阻断，透传到 InitSuccess.warnings（警告被吞掉等于不存在）
    const warnings = validationErrors.filter((e: ValidationError) => e.severity === 'warn');

    // Tools 段对账（^anc-exec-tools-reconcile——spec 需求声明 vs 环境工具面三判:
    // 工具名在清单/参数名子集容忍超集报错/requires_commit 一致性。早失败——不让缺工具的
    // spec 跑到调用步才死。两次调用点:①init 内(hostConfig.tool_provider 在场时——直注入
    // provider 的测试/嵌入场景);②dispatcher runSpec 入口(装配后 CompositeToolProvider
    // 全集——生产主通道:MCP standalone 外部工具走 tool_registry 装配在 dispatcher,init
    // 看不见,只在 init 对账=生产通道零对账+双源误报,review D1 实抓）。
    // requires_commit 判据=结构化标记(description/notes 里独立 token 'requires_commit',
    // 前后非中文非字母数字——否定语境'并非 requires_commit'仍会误中,故 v1 收窄为:仅当
    // 该 token 独立成注记(如'(requires_commit)'/'requires_commit'开头)才判注明;
    // 完整机读形态(Tools 段布尔属性)归后续演进,review D4)。// @a: anc-exec-tools-reconcile
    if (ast.header.tools?.length && hostConfig.tool_provider) {
      const r = ExecutionEngine.reconcileTools(ast.header.tools, hostConfig.tool_provider.list());
      warnings.push(...r.warnings);
      if (r.errors.length) return { status: 'error', errors: r.errors };
    }

    this.spec = ast;
    this.hostConfig = hostConfig;
    this.canFanout = options?.canFanout ?? false;
    if (options?.driverChannel) this.driverChannel = options.driverChannel;   // @a: anc-exec-driver-channel
    this.subtreeRoot = options?.subtreeRoot ?? null;
    this.specPath = options?.specPath ?? null;
    this.cliAbsPath = options?.cliAbsPath ?? null;
    this.contextMode = options?.contextMode ?? 'full';
    // call 子实例用 callStepId 作 instanceId（落 .hopstate/<parent>/calls/<callStepId>/）；否则随机 UUID
    this.instanceId = options?.callStepId ?? randomUUID();
    // 子实例 re-init 净室（hopissues/0047）：串行 for-each loop 体内的 [call] 无迭代命名,
    // 各迭代复用同一 calls/<步骤号>/ 目录——原 init 只覆盖顶层三文件不清 calls/ 嵌套子目录,
    // 上一迭代的嵌套 call 残留被下一迭代静默读到。迭代账（collect/loopCounters/元素绑定）全在
    // 父实例账上（completeCallStep loop 级联）,子目录只是单轮已收割的作业本——整目录重建零语义
    // 影响,串行执行保持 Python for 循环语义。触发面=call 子实例与 parallel worker 都生效
    // （有意行为:stale 重建=重新 init 从头跑,清残留正确;review 面二抓账实差后明写）。
    // 次序锁死:先读取父引擎备料（writeChildParams 落盘的 params.json——0020 修复的盘面通道,
    // rmSync 之后再读恒 null,worker 参数被自己吞掉）再整目录删除。顶层实例 init 不触发。
    // @a: anc-exec-call-reinit-clean
    let preReadChildParams: Record<string, unknown> | null = null;
    if (options?.parentInstanceId && options?.callStepId && options?.stateDir) {
      const reinitDir = join(options.stateDir, this.instanceId);
      preReadChildParams = readChildParams(reinitDir);   // 先读——净室清盘前取走备料
      if (existsSync(reinitDir)) rmSync(reinitDir, { recursive: true, force: true });
    }

    this.setSubtreePending(ast.steps ?? []);

    // parallel worker 子实例：scope 收窄到 child 子树（子树外预标 skipped）
    if (this.subtreeRoot) {
      this.executeSubtreeOnly(this.subtreeRoot, ast.steps ?? []);
    }

    const inputs: Record<string, unknown> = {};
    if (ast.header.inputs) {
      for (const decl of ast.header.inputs) {
        inputs[decl.name] = undefined;
      }
    }
    // params 实参覆盖 Inputs 声明的 default（在此注入，确保随下方 persist 一并落盘）
    if (options?.params) {
      for (const [k, v] of Object.entries(options.params)) {
        inputs[k] = v;
      }
    }
    // parallel worker 完整入参：引擎单一权威，fan-out 落盘 + worker init 按 cid 回填（driver 零参与）。
    // 显式 --params 键优先；params.json 只补缺失键。静态 child 外部依赖与 for-each itemVar 统一走此通道。
    // 回填只读自己那份（cid 定位），不翻父/兄弟 vars。for-each itemVar 仍缺 → 响亮失败。
    // 见 design/parallel-execution.md §9e ^anc-exec-parallel-foreach-worker。// @a: anc-exec-parallel-foreach-worker
    if (this.subtreeRoot) {
      // worker instance 目录 = <stateDir>/<cid>（cli 已把 stateDir 解析到 <parent>/parallel）。
      // 该目录由父引擎 fan-out 时 writeChildParams 创建并写入完整 params_for_child。
      const childParams = preReadChildParams ?? (options?.stateDir
        ? readChildParams(join(options.stateDir, this.instanceId)) : null);
      if (childParams) {
        for (const [k, v] of Object.entries(childParams)) {
          // 只保护 caller 真正显式传入的键；Inputs 声明会预先放入 undefined/default，
          // 不能把“已声明但未赋实参”误判成覆盖。child 实参应覆盖声明默认值。
          if (!options?.params || !(k in options.params)) inputs[k] = v;
        }
      }

      const parentId = getParentStepId(this.subtreeRoot);
      const parentParallel = parentId ? this.findStepById(parentId, ast.steps ?? []) : null;
      const forEach = parentParallel ? getForEach(parentParallel) : undefined;
      if (forEach && !(forEach.itemVar in inputs)) {
        return { status: 'error', errors: [{
          kind: 'validate', rule: 'MISSING_INPUT', severity: 'error',
          message: `for-each worker '${this.subtreeRoot}' 缺 itemVar '${forEach.itemVar}'——引擎未按 cid 备料 params_for_child（fan-out 落盘缺失或 worker 被手工错启动，见 ^anc-exec-parallel-foreach-worker）`,
        }] };
      }
    }
    // call 子实例必填闸（2026-09-01 账实差实装——"子 init 校验必填缺失即拒"三处设计承诺
    // 〔本文件 resolveCallParams 注释/exec-engine ^anc-exec-call-auto-map〕自 2026-08-27 立约
    // 以来码内无此闸:缺失 Inputs 预放 undefined 照跑,dr21 十六撞子实例 reviewer_prompt=None
    // 不自报缺信息自造角色跑完审查。闸只落 call 子实例创建链（parentInstanceId+callStepId
    // 在场——与净室判据同源;subtreeRoot 在场=parallel worker 子实例,不受此闸——worker 执行
    // 同 spec 子树,Inputs 靠 params_for_child 部分回填是常态,itemVar 缺失有 MISSING_INPUT
    // 专闸〕,顶层 run 缺参照旧宽容;VarDecl 无 default 载体,全部 Inputs 视为必填。
    // @a: anc-exec-call-auto-map
    if (options?.parentInstanceId && options?.callStepId && !options?.subtreeRoot && ast.header.inputs) {
      const missing = ast.header.inputs.filter(d => inputs[d.name] === undefined).map(d => d.name);
      if (missing.length > 0) {
        return { status: 'error', errors: [{
          kind: 'validate', rule: 'INIT_FAILED', severity: 'error',
          message: `INIT_FAILED: call 子实例必填 Inputs 缺失: ${missing.join(', ')}——父层映射未注入（悬空来源/点路径被拒?）,子实例不许拿 undefined 起跑（缺指令自造角色的实撞防线）`,
        }] };
      }
    }
    // 顶层 run 必填 Inputs 闸（2026-09-01 deep-validate 批立规——call 子实例闸的孪生半边,
    // 原"顶层缺参照旧宽容"的另一决策本日作者拍定收紧:九坑之坑 3 漏传 scripts_dir 起 run,
    // None 静默灌下游到 subprocess.run 拼坏 argv 才炸,病灶离症状隔几步。判据/错误码与
    // 子实例闸同源,报文按受众分:逐参点名带类型说明（照抄 VarDecl,补参零翻查）,指向起 run
    // 的调用方。CLI init/MCP start_run/dispatcher runSpec 三入口同经本处,引擎单点实装。
    // parallel worker（subtreeRoot 在场）照旧不受闸——params_for_child 部分回填是常态。
    // 见 exec-engine ^anc-exec-init-required-inputs。// @a: anc-exec-init-required-inputs
    if (!options?.parentInstanceId && !options?.subtreeRoot && ast.header.inputs) {
      const missingDecls = ast.header.inputs.filter(d => inputs[d.name] === undefined);
      if (missingDecls.length > 0) {
        const detail = missingDecls
          .map(d => `${d.name}: ${d.type}${d.description ? `  # ${d.description}` : ''}`)
          .join('; ');
        return { status: 'error', errors: [{
          kind: 'validate', rule: 'INIT_FAILED', severity: 'error',
          message: `INIT_FAILED: 顶层 run 必填 Inputs 缺失——start_run/init 的 params 须提供: ${detail}`,
        }] };
      }
    }
    // 入口边界归一（^anc-exec-output-coerce 同族——yaml 声明收 YAML 文本 parse 成结构、
    // int/bool/line 同规;传结构原样。声明类型是权威,入口与产出边界同一值模型）。
    // @a: anc-type-yaml-structured
    if (ast.header.inputs) {
      const coerced = coerceOutputValues(ast.header.inputs as OutputDecl[], inputs, ast.header.types);
      for (const k of Object.keys(coerced)) inputs[k] = coerced[k];
    }
    inputs['instance_id'] = this.instanceId;
    inputs['parent_instance_id'] = options?.parentInstanceId;
    this.variables = new VariableStore(inputs);

    if (options?.upstreamFeedback) this.upstreamFeedback = options.upstreamFeedback;   // @a: anc-exec-l2c-retry-feedback
    if (options?.logDir) {
      this.logDir = options.logDir;
      this.hoplog = new HopLog({
        specId: ast.header.id ?? 'unnamed',
        logDir: options.logDir,
        level: options.logLevel,
        title: ast.header.title,
        goal: ast.header.goal ?? '',
        inputs: inputs,
        traceId: options.traceId ?? this.instanceId,  // 顶层用 instanceId,worker 继承父的 instanceId → 父子 trace_id 一致
      });
    }

    // Persistence: explicit provider > stateDir→FilePersistence > MemoryPersistence (standalone default)
    if (options?.persistence) {
      this.persistence = options.persistence;
    } else if (options?.stateDir) {
      this.stateDir = options.stateDir;
      this.persistence = new FilePersistence(options.stateDir);
    } else {
      this.persistence = new MemoryPersistence();
    }
    this.persistence.init(this.instanceId, ast);
    if (this.persistence instanceof FilePersistence) {
      this.instanceDir = this.persistence.getInstanceDir();
    }
    this.persist();

    return {
      status: 'ok',
      instance_id: this.instanceId,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  getSpec(): SpecAST | null { return this.spec; }
  /** commit 执行序动态核公开面（^anc-exec-advance-order-invariant 防线二——两模式两入口共用
   * 判定公共件 findNonTerminalBefore 的引擎门面:engine-traverse 是模块私有非出口文件,
   * dispatcher 经本方法取判定,不深入私有件）。返回文档序先于目标步的第一个未终态步骤 id,
   * 全终态返回 null。// @a: anc-exec-advance-order-invariant */
  findNonTerminalBeforeStep(stepId: string): string | null {
    return findNonTerminalBefore(stepId, this.spec?.steps ?? [], this.stepStates);
  }

  /** 展开总数上限解析：Config expansion_max 正整数生效,非法值（0/负/非数/缺席）按缺省——
   * 配置钝感:写错不炸 spec,静默回缺省（契约7）。 */ // @a: anc-exec-subtask-free-expand
  private resolveExpansionMax(): number {
    const raw = this.spec?.header.config?.['expansion_max'];
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_EXPANSION_MAX;
  }
  getInstanceId(): string { return this.instanceId; }
  getStepStates(): Map<string, StepStatus> { return this.stepStates; }
  getVariableStore(): VariableStore { return this.variables; }
  getExecEvents(): ExecEvent[] { return this.execEvents; }
  getLoopCounters(): Map<string, number> { return this.loopCounters; }
  getHopLog(): HopLog | null { return this.hoplog; }
  setCanFanout(on: boolean): void { this.canFanout = on; }
  getCanFanout(): boolean { return this.canFanout; }

  // 双执行硬闸（^anc-exec-driver-channel）：claim=建 run/首个推进入口认领（已有值且不符时抛——
  // 认领即核对,同名幂等）;缺席宽容归 claim 的"无值即写"分支。推进类入口调,只读入口不调。
  // @a: anc-exec-driver-channel
  claimDriverChannel(channel: 'cli' | 'mcp'): void {
    if (this.driverChannel === null) { this.driverChannel = channel; return; }
    if (this.driverChannel !== channel) {
      const hint = this.driverChannel === 'mcp'
        ? '该 run 由 MCP server 建立/驱动——用 mcp__hopjit__resume_run / run_status 继续,不要用 hopjit CLI'
        : '该 run 由 hopjit CLI 建立/驱动——用 hopjit submit_and_fetch_next 等 CLI 命令继续,不要经 MCP server';
      throw new Error(`DRIVER_CHANNEL_MISMATCH: run 属 '${this.driverChannel}' 通道,本入口是 '${channel}'——双执行防线拒绝跨通道推进。${hint}`);
    }
  }
  getDriverChannel(): 'cli' | 'mcp' | null { return this.driverChannel; }
  getSubtreeRoot(): string | null { return this.subtreeRoot; }
  getRawSource(): string | null { return this.rawSource; }  // spec 原文（load 恢复的实例无原文,返回 null）
  // Dispatcher 每次 API 调用后同步累计值（引擎负责落盘,resume 时 Dispatcher 经 getCumulativeTokens 回填）
  setCumulativeTokens(total: number): void { this.cumulativeTokens = total; }
  getCumulativeTokens(): number { return this.cumulativeTokens; }
  getSpecPath(): string | null { return this.specPath; }
  /** load 恢复的 hop_env 表（host_context 持久化——含原 run params 覆盖与 ask 回填,比配置重合成新）。
   * server 重启恢复时组合根据此合并,见 mcp-server restoreRun。// @a: anc-config-hop-env */
  getRestoredHopEnv(): Record<string, string> | undefined { return this.hostConfig?.hop_env; }
  // commit 退火跨界读写（call 同界记账——子实例含已执行 commit 时父侧把 call 步登记退火,
  // 重跑 call=重跑整个子 spec,子内 commit 必重放）。// @a: anc-exec-commit-anneal
  hasCommittedSteps(): boolean { return this.committedSteps.size > 0; }
  // snapshotOverride:并行收割路径传派发时刻的宿主 loop 轮次（review B1-1——收割是异步的,
  // 渐进派发下宿主 loop 派发即推进,收割时刻的 loopCounters 可能已走到后面的轮;在飞账
  // entry.iter 是派发时刻真值。串行路径缺省自取当前轮次（call 步 running 期父 loop 不可推进,时序一致）。
  markCommitted(stepId: string, snapshotOverride?: Record<string, number>): void {
    this.committedSteps.set(stepId, snapshotOverride ?? this.ancestorLoopIters(stepId));
  }
  /** 步骤全部祖先 loop 的当前轮次快照（markCommitted 内部取——调用方签名零改动）。 // @a: anc-exec-commit-anneal */
  private ancestorLoopIters(stepId: string): Record<string, number> {
    const iters: Record<string, number> = {};
    let cur = getParentStepId(stepId);
    while (cur) {
      const node = this.findStepById(cur);
      if (node?.step_type === 'loop') iters[cur] = this.loopCounters.get(cur) ?? 1;
      cur = getParentStepId(cur);
    }
    return iters;
  }
  /** load 恢复的配置读取根（host_context 持久化——BUG-I:server 重启恢复据此重读项目级配置）。// @a: anc-mcp-run-restore */
  getRestoredConfigProjectDir(): string | undefined { return this.hostConfig?.config_project_dir; }  // spec 文件路径（load 从 state.json 恢复,server 重启恢复据此重建 DirSpecProvider）// @a: anc-mcp-run-restore
  getRestoredWorkspaceDir(): string | undefined { return this.hostConfig?.workspace_dir; }  // 作业对象根随快照钉住（显式 workspace_dir 的 run 重启恢复不漂回 server cwd）// @a: anc-mcp-run-restore
  // 完整 HostConfig 重接（server 重启恢复用）：load 只恢复 host_context 非敏感子集,
  // Provider/凭证由宿主 resume 时重新注入——运行时对象不落盘。见 design/mcp-server.md ^anc-mcp-run-restore
  setHostConfig(hostConfig: HostConfig): void { this.hostConfig = hostConfig; } // @a: anc-mcp-run-restore

  /** L4 工具清单料源（prompt-assembler ^anc-exec-tool-manifest-source——独立模式 Dispatcher
   * 构造完 CompositeToolProvider 后经本通路交注册面,清单才渲染真身档;复用模式无人调用,
   * getToolDefs 返 undefined→manifest 走通道指引档。不回写 hostConfig.tool_provider——
   * mcp-server 两处拿同一 hostConfig 重建 composite,回写=composite 当宿主件再并入,同名 fail-fast 炸）。 */
  private toolDefsSource: ToolProvider | null = null;
  setToolDefsSource(provider: ToolProvider): void { this.toolDefsSource = provider; } // @a: anc-exec-tool-manifest-source

  /** 引擎自有工具执行体（执行主体原则,2026-09-05——body 是引擎执行的,provider 命中的工具
   * 就引擎直执,不再中途交 caller。lazy:多数实例不撞含工具 body,首次消化时才构造。
   * 当前 CLI 复用模式的直执面=内置两成员（builtin-file+builtin-notify）——run/submit 的
   * buildHostConfig 不注入 tool_registry,注册件在消化路径仍走 tool_request（安全退化;
   * 扩面待议,见设计分派判据条款）;caller 会话专属工具天然不在 list,恒走 tool_request。
   * 见 [[exec-engine#^anc-exec-tool-request]] 分派判据。
   * 构造经静态工厂注入（组合根 CLI/mcp-server 注册——engine 层1 不 import tools-composite 层2,
   * 分层守卫 module-principles §2;工厂缺席=全挂起旧形态,嵌入/测试场景零破坏）。 */
  // @a: anc-exec-tool-request
  private static engineToolProviderFactory: ((hostConfig: HostConfig) => ToolProvider) | null = null;
  static setEngineToolProviderFactory(f: (hostConfig: HostConfig) => ToolProvider): void { ExecutionEngine.engineToolProviderFactory = f; }
  /** 测试专用注销（静态位跨测试组泄漏的对治——注册后不注销会让同进程后续测试组带着工厂跑） */
  static resetEngineToolProviderFactory(): void { ExecutionEngine.engineToolProviderFactory = null; }
  private engineToolProvider: ToolProvider | null = null;
  private getEngineToolProvider(): ToolProvider | null {
    if (!this.hostConfig || !ExecutionEngine.engineToolProviderFactory) return null;   // 工厂/配置缺席——退回全挂起旧形态
    if (!this.engineToolProvider) this.engineToolProvider = ExecutionEngine.engineToolProviderFactory(this.hostConfig);
    return this.engineToolProvider;
  }
  getToolDefs(): { name: string; description: string; input_schema: Record<string, unknown>; category?: 'basic' | 'special'; requires_commit?: boolean; returns?: string }[] | undefined {
    const tp = this.toolDefsSource ?? this.hostConfig?.tool_provider;
    if (!tp) return undefined;
    return tp.list().map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema, category: t.category, requires_commit: t.requires_commit, returns: t.returns }));
  }
  getWorkspaceDir(): string { return this.hostConfig?.workspace_dir ?? ''; }  // L4 清单 work_zone 相对化基准 // @a: anc-exec-tool-manifest-supply
  setContextMode(mode: 'full' | 'minimal'): void { this.contextMode = mode; }  // env 覆盖用
  getContextMode(): 'full' | 'minimal' { return this.contextMode; }  // @a: anc-exec-context-mode

  // 分层压缩契约:max_context_tokens 覆盖告警线（EngineAccessor 扩展,2026-08-09）。// @a: anc-exec-token-budget
  getMaxContextTokens(): number | undefined {
    return this.hostConfig?.resource_limits?.max_context_tokens;
  }
  // minimal 且非首步（已有 step done/failed）→ 砍 L1 静态段 + L2 spec 级。见 ^anc-exec-context-mode
  private isMinimalNonFirst(): boolean {
    if (this.contextMode !== 'minimal') return false;
    return [...this.stepStates.values()].some(s => s === 'done' || s === 'failed');
  }
  getInstanceDir(): string | null { return this.instanceDir; }

  // 问题卡落盘/删除（^anc-exec-pause-persist,0028 作者拍板 B）：暂停即产卡 paused.json——
  // 与返回 caller 的载荷同源同一份,跨进程可取（detach 场景 runStatus 快照兜底读它）;
  // 答案成功消化即删（卡生命周期=等人窗口）。无 instanceDir（纯内存实例）静默跳过——
  // 卡是递送件非状态源,缺席只影响跨进程取载荷,不影响恢复路①。
  private writePausedCard(payload: Record<string, unknown>): void {
    if (!this.instanceDir) return;
    try {
      writeFileSync(join(this.instanceDir, 'paused.json'), JSON.stringify(payload, null, 2), 'utf-8');
    } catch { /* 落卡失败不阻塞暂停返回——递送件尽力而为,状态源(state.json)另有 persist */ }
  }
  /** 问题卡清除（public——dispatcher 在 PARALLEL_HITL_TODO 判 failed 时清子实例死卡;
   * 引擎内部消化/reject/recover 三路径也走此点。^anc-exec-pause-persist）。 */
  /** 升层暂停（^anc-exec-check-escalate——check 判 false 且 gap.escalate===true 的分派终点）：
   * 步骤保持 running（与 confirm/ask 暂停同态——running 即"等外部应答"的持久编码）,组装
   * escalate 暂停卡落盘并返回 paused。question←gap.need,context←gap 全文+retry_history,
   * output_schema←guidance:text。接收端由拓扑定（人/上层 caller——谁消费这张卡谁答）。
   * // @a: anc-exec-check-escalate */
  private pauseForEscalation(stepId: string, node: CheckStep, gap: Record<string, unknown>): CommandResponse {
    const need = typeof gap['need'] === 'string' ? gap['need'] : JSON.stringify(gap['need'] ?? '(未声明 need)');
    const history = this.retryHistory.get(this.nearestRetryContainerId(stepId) ?? '') ?? [];
    const response = {
      status: 'paused' as const,
      instance_id: this.instanceId,
      step_id: stepId,
      pause_reason: 'escalate' as const,
      presented_data: {
        summary: node.summary,
        question: need,
        instruction: node.instruction ?? '',
        context: { gap, retry_history: history },
        output_schema: [{ name: 'guidance', type: 'text', description: '方向指引——回注发起层的重试反馈,下一轮重跑可见' }],
      },
      response_options: [],
      work_zone: this.getWorkZone(),
    };
    this.escalatePending = stepId;   // 消化路判据（resume 侧按它走专用通道不撞 mapAskOutputs）
    this.escalateCardMemo = response as unknown as Record<string, unknown>;
    this.recordEvent(stepId, 'escalate', `升层问路: ${need.slice(0, 200)}`);
    this.hoplog?.recordStepMeta(stepId, { taken: `escalate: ${need.slice(0, 120)}` });
    this.writePausedCard(response);
    this.persist();
    return response as unknown as CommandResponse;
  }

  // 最近祖先重试容器（subtask/case）——升层反馈的挂账位（与 getActiveRetryFeedback 的
  // chain 收集同判据）。无容器返回 null。// @a: anc-exec-check-escalate
  private nearestRetryContainerId(stepId: string): string | null {
    let id = stepId;
    while (id.includes('.')) {
      id = id.slice(0, id.lastIndexOf('.'));
      const node = this.findStepById(id);
      if (node && (node.step_type === 'subtask' || node.step_type === 'case')) return id;
    }
    return null;
  }

  // 升层待答步（快照持久化——跨进程 resume 仍走专用消化路）。// @a: anc-exec-check-escalate
  private escalatePending: string | null = null;
  getEscalatePending(): string | null { return this.escalatePending; }

  /** subprocess.run 命令 journal 步骤级持久数组（独立模式 dispatcher 注入用——两模式同一账,
   * 跨进程随 state.json cmd_journal;^anc-exec-subprocess-run 双模式条款）。 */ // @a: anc-exec-subprocess-run
  getCmdJournalFor(stepId: string): Array<{ stdout: string; stderr: string; returncode: number }> {
    return (this.cmdJournal[stepId] ??= []);
  }
  // 升层卡内存副本（纯内存实例的短路重放兜底——盘卡缺席时 nextStep 仍能吐 paused 不跌落;
  // 跨进程场景盘卡恒在,本副本只救进程内无盘形态）。// @a: anc-exec-subtask-free-expand
  private escalateCardMemo: Record<string, unknown> | null = null;

  /** standalone 展开续批暂停（^anc-exec-subtask-free-expand 契约7 standalone 半边——作者定
   * 2026-08-29"关键特性不应该等真需求再补"）：dispatcher 的 initial_plan 提交撞 EXPANSION_LIMIT
   * 时调本方法转升层问人——复用 escalate 暂停全套设施（卡落盘/escalatePending 持久化/nextStep
   * 短路重放/三通道消化路）,问的不是 check 缺口而是展开预算："继续还是收手"。应答 guidance 回注
   * 后容器仍处 initial_plan 等待态,dispatcher 下一轮重新生成并携 extendExpansion 提交。
   * // @a: anc-exec-subtask-free-expand */
  pauseForExpansionExtend(subtaskId: string, rejectedPlanMd: string): CommandResponse {
    const node = this.findStepById(subtaskId);
    const expansionMax = this.resolveExpansionMax();
    const response = {
      status: 'paused' as const,
      instance_id: this.instanceId,
      step_id: subtaskId,
      pause_reason: 'escalate' as const,
      presented_data: {
        summary: node?.summary ?? subtaskId,
        question: `已展开 ${this.expansionCount} 次达上限 ${expansionMax}（Config expansion_max 可调）——任务还要继续展开,继续还是收手?`,
        instruction: node?.instruction ?? '',
        context: { expansion_count: this.expansionCount, expansion_max: expansionMax, rejected_plan: rejectedPlanMd },
        output_schema: [{ name: 'guidance', type: 'text', description: '续批与方向合一——答"继续"或给方向即授权再展开一次;要收手就说收手（driver 无权替答:预算是人给的,追加须人批）' }],
      },
      response_options: [],
      work_zone: this.getWorkZone(),
    };
    this.escalatePending = subtaskId;
    this.escalateCardMemo = response as unknown as Record<string, unknown>;
    this.recordEvent(subtaskId, 'escalate', `展开续批问路: 已 ${this.expansionCount}/${expansionMax} 次`);
    this.hoplog?.recordStepMeta(subtaskId, { taken: `escalate: 展开续批 ${this.expansionCount}/${expansionMax}` });
    this.writePausedCard(response);
    this.persist();
    return response as unknown as CommandResponse;
  }

  /** 升层应答消化（^anc-exec-check-escalate 应答回注条款）：guidance 直写发起层所在重试容器的
   * 反馈通道（借 retryHistory 载体但**不扣 retry 预算**——问路不是失败,不动 retryCounters）,
   * 步骤回 pending 重跑,gap 比较基线重置由下一轮 check 自理（人给了新方向旧"无进展"计数作废）。
   * 不走 mapAskOutputs（guidance 键永远配不上 check 双槽声明——朴素复用会把 guidance 灌满
   * 双槽污染判定）。// @a: anc-exec-check-escalate */
  resumeFromEscalation(stepId: string, guidance: string): CommandResponse {
    if (this.escalatePending !== stepId) {
      return { status: 'error', code: ErrorCode.INVALID_STATE, message: `步骤 '${stepId}' 不在升层待答态（当前待答: ${this.escalatePending ?? '无'}）` };
    }
    // 展开续批形态（待答步是 subtask free 容器,非 check——pauseForExpansionExtend 所置）：
    // 只清待答态放行等待循环,不碰 retryHistory/stepStates——容器仍在 adaptiveNeededSubtask
    // 等待态,下一轮 nextStep 自然再吐 initial_plan;guidance 的消费归 dispatcher（喂重生成
    // prompt+携 extendExpansion 提交）。// @a: anc-exec-subtask-free-expand
    const pendingNode = this.findStepById(stepId);
    if (pendingNode?.step_type === 'subtask') {
      this.escalatePending = null;
      this.escalateCardMemo = null;
      this.removePausedCard();
      this.recordEvent(stepId, 'escalate_resume', `展开续批: ${guidance.slice(0, 200)}`);
      this.persist();
      return { status: 'ok' };
    }
    // 反馈挂最近祖先重试容器（getActiveRetryFeedback 的 chain 收集按 subtask/case 祖先找,
    // 挂错位置反馈不可见——getWriteScope 是变量作用域函数不是容器定位,首版误用当场测红）
    const containerId = this.nearestRetryContainerId(stepId) ?? stepId;
    const history = this.retryHistory.get(containerId) ?? [];
    history.push({
      attempt: history.length + 1,
      failure_reason: `【升层指引】${guidance}`,
      steps_tried: [],
    });
    this.retryHistory.set(containerId, history);
    this.escalatePending = null;
    this.escalateCardMemo = null;
    this.stepStates.set(stepId, 'pending');   // 发起步重跑（新指引经 L2c/L7 反馈通道可见）
    this.removePausedCard();
    this.recordEvent(stepId, 'escalate_resume', `指引回注: ${guidance.slice(0, 200)}`);
    this.persist();
    return { status: 'ok' };
  }

  private readPausedCardRaw(): Record<string, unknown> | null {
    if (!this.instanceDir) return null;
    const p = join(this.instanceDir, 'paused.json');
    try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown> : null; }
    catch { return null; }
  }

  removePausedCard(): void {
    if (!this.instanceDir) return;
    try {
      const p = join(this.instanceDir, 'paused.json');
      if (existsSync(p)) unlinkSync(p);
    } catch { /* 同上 */ }
  }
  getHopLogRunDir(): string | null { return this.hoplog?.getRunDir() ?? null; }

  /** 顶层步骤是否全部终态（done/failed/skipped）。终态判据单点复用 isTerminalStatus。 */
  private allTopLevelTerminal(steps: StepNode[]): boolean {
    return steps.every(s => isTerminalStatus(this.stepStates.get(s.step_id)));
  }

  nextStep(): NextResponse {
    if (!this.spec) {
      return {
        status: 'failed',
        instance_id: this.instanceId,
        failed_step_id: '',
        failure_reason: 'Engine not initialized',
        partial_outputs: {},
        work_zone: this.getWorkZone(),
      };
    }

    // aborted 墓碑门（^anc-exec-abort 第4条）：中止是终局不是暂停——一切推进短路拒,
    // 快照/hoplog 保留仅供检视。nextStep 是推进漏斗,resume/debug_step/advance 全经此。
    if (this.terminalState === 'aborted') {
      return {
        status: 'failed',
        instance_id: this.instanceId,
        failed_step_id: '',
        failure_reason: `RUN_ABORTED: 实例已主动中止（${this.abortReason ?? '(user abort)'}）——终局不可恢复,快照仅供检视`,
        partial_outputs: this.deflateValues(this.collectOutputs()),
        work_zone: this.getWorkZone(),
      };
    }

    // 升层待答短路（^anc-exec-check-escalate）：check 已交卷判 escalate,发起步保持 running
    // 等 guidance——nextStep 不得把它再派一遍（重派=同一 check 双跑,应答后重跑才是语义）。
    // 卡从盘上原样重放（与 confirm/ask 暂停卡同源同格式）;纯内存实例（call 子实例等无
    // instanceDir,卡没落盘）回内存副本——原"盘卡为 null 即跌落"是死循环缝:待答态直通
    // adaptiveNeededSubtask 分支再吐 initial_plan,每轮真 LLM 调用且特意不烧熔断,review
    // 探针 OOM 实锤（活路径=callee 含 subtask free 撞限）。// @a: anc-exec-check-escalate, anc-exec-subtask-free-expand
    if (this.escalatePending) {
      const card = this.readPausedCardRaw() ?? this.escalateCardMemo;
      if (card) return card as unknown as NextResponse;
    }

    const steps = this.spec.steps ?? [];

    // 未捕获失败短路（函数级 fail）：实例已终止,直接返回 failed——不依赖顶层扫描
    // （失败步骤可能深嵌容器内,容器级联标 done 会吞掉它）。
    if (this.terminalFailure) {
      this.hoplog?.close('failed');
      this.finalizeTerminal('failed');   // 0043 // @a: anc-exec-state-persistence
      return {
        status: 'failed',
        instance_id: this.instanceId,
        failed_step_id: this.terminalFailure.stepId,
        failure_reason: this.terminalFailure.reason,
        partial_outputs: this.deflateValues(this.collectOutputs()),
        ...(this.lastKillList.length ? { kill_list: [...this.lastKillList] } : {}),   // §U8 杀活清单 // @a: anc-exec-parallel-reuse-protocol
        work_zone: this.getWorkZone(),
      };
    }

    const allTerminal = this.allTopLevelTerminal(steps);

    if (allTerminal) {
      const hasFailed = this.findFirstFailedStep(steps);
      if (hasFailed) {
        this.hoplog?.close('failed');
        this.finalizeTerminal('failed');   // 0043 // @a: anc-exec-state-persistence
        return {
          status: 'failed',
          instance_id: this.instanceId,
          failed_step_id: hasFailed.step_id,
          failure_reason: this.getFailureReason(hasFailed.step_id),
          partial_outputs: this.deflateValues(this.collectOutputs()),
          ...(this.lastKillList.length ? { kill_list: [...this.lastKillList] } : {}),   // §U8 // @a: anc-exec-parallel-reuse-protocol
          work_zone: this.getWorkZone(),
        };
      }
      {
        // 完备性闸（^anc-exec-output-completeness）：声明输出未赋值=违约,failed 非 completed
        const missing = this.unassignedOutputs();
        if (missing.length > 0) {
          const reason = missing.map(n => `Output "${n}" declared in Outputs but never assigned`).join('; ');
          for (const n of missing) this.recordEvent('', 'step_failed', `Output "${n}" was never assigned (remains None)`);
          this.hoplog?.close('failed');
          this.finalizeTerminal('failed');   // 0043 // @a: anc-exec-state-persistence
          return {
            status: 'failed',
            instance_id: this.instanceId,
            failed_step_id: '',
            failure_reason: reason,
            partial_outputs: this.deflateValues(this.collectOutputs()),
            work_zone: this.getWorkZone(),
          };
        }
      }
      this.hoplog?.close('completed');
      this.finalizeTerminal('completed');   // 0043 终局有据 // @a: anc-exec-state-persistence
      return {
        status: 'completed',
        instance_id: this.instanceId,
        outputs: this.deflateValues(this.collectOutputs()),
        work_zone: this.getWorkZone(),
      };
    }

    if (this.adaptiveNeededSubtask) {
      const subtaskId = this.adaptiveNeededSubtask;
      const subtask = this.findStepById(subtaskId) as SubtaskStep;
      // initial_plan 语义状态化（^anc-exec-subtask-free-expand 契约1——review P0 实锤:本分支原是
      // 失败驱动组装,再吐/resume 重取把首规划退化成 attempt 3/3 空原因的假失败形态=盲规划）：
      // "这是首规划"是可判定状态事实（free 且 children 空）,三出口共用同一组装。
      if (subtask.free === true && (subtask.children ?? []).length === 0) {
        return this.buildInitialPlanRequest(subtask);
      }
      const history = this.retryHistory.get(subtaskId) ?? [];
      const retryMax = subtask.retry ?? 3;   // 概念层缺省 3（subtask 总是内置事务边界,2026-08-09 作者确认——原 ?? 1 与概念不符）
      const remaining = this.retryCounters.get(subtaskId) ?? 0;

      return {
        status: 'adaptive_needed',
        instance_id: this.instanceId,
        spec_id: this.spec?.header.id ?? 'unnamed',
        subtask_id: subtaskId,
        failure: {
          step_id: history.length > 0 ? history[history.length - 1].steps_tried[0]?.step_id ?? '' : '',
          reason: history.length > 0 ? history[history.length - 1].failure_reason : '',
          attempt: retryMax - remaining,
          max_retries: retryMax,
        },
        subtask_contract: {
          outputs: subtask.outputs ?? [],
          constraints: [],
        },
        original_children: subtask.children.map(c => this.toStepSummary(c)),
        retry_history: history,
      };
    }

    const newlyRunning: StepNode[] = [];
    const condWarnings: { stepId: string; message: string }[] = [];
    const state: TraversalState = {
      stepStates: this.stepStates,
      variables: this.variables,
      loopCounters: this.loopCounters,
      newlyRunning,
      condWarnings,
      hasInflightFor: (id: string) => this.hasInflightFor(id),   // 收齐门 // @a: anc-exec-parallel-reap-drain
      onFailActive: this.onFailActive,   // 兜底激活集 // @a: anc-exec-on-fail
      onFailConsumed: this.onFailConsumed,   // 兜底消耗集（激活/消耗分离）// @a: anc-exec-on-fail
      retryCounters: this.retryCounters,   // 串行迭代预算复位 // @a: anc-exec-retry-adaptive
      unifiedDispatch: this.unifiedDispatch,                     // 派发门 // @a: anc-exec-parallel-dispatch-model
    };

    const result = dfsNextStep(steps, state, this.spec);

    // 容器进入 running 时记录骨架（无 context——容器不是执行步骤） // @a: anc-obs-step-start-timing
    for (const container of newlyRunning) {
      this.hoplog?.recordStepStart(container.step_id, container.step_type, container.summary);
    }
    // 条件计算异常留痕（"计算异常=None+log"教义,2026-08-09 作者定）
    for (const w of condWarnings) {
      this.hoplog?.recordWarn(w.stepId, `[cond-eval] ${w.message}`);
    }

    if (result.kind === 'retry') {
      return this.nextStep();
    }

    // subtask free 空容器到步——停下索计划（^anc-exec-subtask-free-expand 契约1/2）：
    // 置 adaptiveNeededSubtask 复用既有等待态,载荷带 reason:'initial_plan'（分辨字段——
    // failure 置空形态:没有失败,是首规划）+ expansion_context（← 输入实际值 deflate——
    // 到步展开价值本体=拿真产出定计划,不喂=盲规划）。// @a: anc-exec-subtask-free-expand
    if (result.kind === 'expand') {
      const st = result.step as SubtaskStep;
      // 单槽挤占纪律（契约9）：槽已被失败驱动占用 → 失败优先（既发事实）,expand 不抢——
      // 本次不置槽直接吐失败方载荷,expand 待失败消化后 DFS 自然重达。
      if (this.adaptiveNeededSubtask && this.adaptiveNeededSubtask !== st.step_id) {
        this.hoplog?.recordWarn(st.step_id, `[expand] 到步索计划让位于失败重规划 '${this.adaptiveNeededSubtask}'（单槽失败优先）`);
        return this.nextStep();
      }
      this.adaptiveNeededSubtask = st.step_id;
      this.persist();
      return this.buildInitialPlanRequest(st);
    }

    // 统一模型派发信号：subtask parallel 派发单元——入账+快照入参，交 dispatcher/driver 异步
    // 起子实例，主线下一次 nextStep 继续推进（本步已标 done）。复用模式附 launch_command
    // （引擎拼好防漏参）。// @a: anc-exec-parallel-dispatch-model, anc-exec-parallel-reuse-protocol
    if (result.kind === 'dispatch') {
      // 名额判定上收引擎（§U8 修正）：满员时不入账，吐 drain_wait=派发点阻塞（等任一收割腾
      // 名额后 caller 重进 advance）——与收齐等待同一介入形态、同一等待机制的对偶触发面。
      const inflightNow0 = this.inflight.filter(f => f.status === 'inflight');
      if (!this.hasFreeSlot() && inflightNow0.length > 0) {
        return {
          status: 'drain_wait',
          instance_id: this.instanceId,
          loop_step_id: inflightNow0[0].host_container,
          inflight: inflightNow0.map(f => f.child_instance),
        };
      }
      // 配 1（名额全归主线）且无在飞可等：同步退化——按普通容器串行下钻（全串行口子，
      // 顺序模拟等价性）。fallthrough 到下方容器路径。
      if (!this.hasFreeSlot()) {
        this.stepStates.set(result.step.step_id, 'running');
        this.recordEvent(result.step.step_id, 'step_start');
        this.persist();
        return this.nextStep();
      }
      const d = this.dispatchParallelSubtask(result.step.step_id);
      return {
        status: 'dispatch_ready',
        instance_id: this.instanceId,
        step_id: result.step.step_id,
        dispatch_kind: 'subtask',
        child_instance: d.childInstance,
        host_container: d.hostContainer,
        params_for_child: d.params,
        ...(this.buildDispatchLaunchCommand('subtask', result.step.step_id, d.childInstance, d.params)
          ? { launch_command: this.buildDispatchLaunchCommand('subtask', result.step.step_id, d.childInstance, d.params)! } : {}),
        work_zone: this.getWorkZone(),
        ...(this.lastStale.length ? (() => {
          const live = this.lastStale.filter(ci => this.inflight.some(f => f.child_instance === ci && f.status === 'inflight'));
          const launch = this.buildStaleLaunch(live);
          return live.length ? { stale: live, ...(launch ? { stale_launch: launch } : {}) } : {};
        })() : {}),   // stale 双载荷+重拼命令（2026-08-13,driver 任一响应见 stale 即自查、没起过原样执行）// @a: anc-exec-parallel-inflight-reconcile
      };
    }

    if (result.kind === 'branch_failed') {
      // 条件计算异常 → branch fail 走标准升级链（外层事务边界扣预算重跑/耗尽上报）
      this.recordStepFailure(result.stepId, result.reason);
      this.hoplog?.recordStepFailed(result.stepId, result.reason);
      this.handleFailStepRetry(result.stepId, result.reason);
      this.persist();
      return this.nextStep();
    }

    if (result.kind === 'exit') {
      {
        // 完备性闸（^anc-exec-output-completeness）：声明输出未赋值=违约,failed 非 completed
        const missing = this.unassignedOutputs();
        if (missing.length > 0) {
          const reason = missing.map(n => `Output "${n}" declared in Outputs but never assigned`).join('; ');
          for (const n of missing) this.recordEvent('', 'step_failed', `Output "${n}" was never assigned (remains None)`);
          this.hoplog?.close('failed');
          this.finalizeTerminal('failed');   // 0043 // @a: anc-exec-state-persistence
          return {
            status: 'failed',
            instance_id: this.instanceId,
            failed_step_id: '',
            failure_reason: reason,
            partial_outputs: this.deflateValues(this.collectOutputs()),
            work_zone: this.getWorkZone(),
          };
        }
      }
      this.hoplog?.close('completed');
      this.finalizeTerminal('completed');   // 0043 终局有据 // @a: anc-exec-state-persistence
      return {
        status: 'completed',
        instance_id: this.instanceId,
        outputs: this.deflateValues(this.collectOutputs()),
        work_zone: this.getWorkZone(),
      };
    }

    if (result.kind === 'none') {
      // 收齐等待（drain）：主线走完但仍有在飞——不是 failed，是等收割。
      // 独立模式 dispatcher await 在飞 Promise；复用模式 caller 轮询（P2）。// @a: anc-exec-parallel-reap-drain
      this.sweepTimedOutInflight();   // 收齐检查点也是活性检查点（§U3 设计两检查点,review 抓漏）// @a: anc-exec-parallel-timeout
      // U4b:paused（等人）也是未完的活——账上有 paused 同样吐 drain_wait（dispatcher 的
      // 队列分支接手:返回队首卡等应答）,否则直落 'No executable step found' 假failed。
      // @a: anc-exec-parallel-hitl-queue
      const inflightNow = this.inflight.filter(f => f.status === 'inflight' || f.status === 'paused');
      if (inflightNow.length > 0) {
        const hostLoop = inflightNow[0].host_container;
        return {
          status: 'drain_wait',
          instance_id: this.instanceId,
          loop_step_id: hostLoop,
          inflight: inflightNow.map(f => f.child_instance),
          ...(this.lastStale.length ? (() => {
            const live = this.lastStale.filter(ci => inflightNow.some(f => f.child_instance === ci));
            const launch = this.buildStaleLaunch(live);
            return live.length ? { stale: live, ...(launch ? { stale_launch: launch } : {}) } : {};
          })() : {}),   // §U2 stale+重拼命令 // @a: anc-exec-parallel-inflight-reconcile
        };
      }
      const terminalNow = this.allTopLevelTerminal(steps);
      if (terminalNow) return this.nextStep();

      // 误终局写侧防线（0043 两防线之一,2026-08-27 狗粮 bc32179f 实撞——乱序回写后 DFS 产 none
      // 时执行类步骤可能正 running 等 caller 交结果:是等待不是死局,不 finalize。容器 running
      // 是结构状态不算在等。// @a: anc-exec-state-persistence
      const waitingWriteback = [...this.stepStates.entries()]
        .filter(([id, st]) => st === 'running')
        .map(([id]) => this.findStepById(id))
        .filter((n): n is StepNode => !!n && EXECUTABLE_STEP_TYPES.has(n.step_type));
      if (waitingWriteback.length > 0) {
        return {
          status: 'failed',   // 载体形态:非终态错误响应(不 finalize 不 close)——driver 按 reason 分辨
          instance_id: this.instanceId,
          failed_step_id: '',
          failure_reason: `WAITING_WRITEBACK: 步骤 ${waitingWriteback.map(n => n.step_id).join(', ')} 正在等待结果交付——用 submit_and_fetch_next 交付它们,不是失败`,
          partial_outputs: this.deflateValues(this.collectOutputs()),
          work_zone: this.getWorkZone(),
        };
      }

      this.hoplog?.close('failed');
      this.finalizeTerminal('failed');   // 0043 // @a: anc-exec-state-persistence
      return {
        status: 'failed',
        instance_id: this.instanceId,
        failed_step_id: '',
        failure_reason: 'No executable step found',
        partial_outputs: this.deflateValues(this.collectOutputs()),
        work_zone: this.getWorkZone(),
      };
    }

    const target = result.step;
    // call parallel 派发（统一模型 §U8）：unifiedDispatch 下 call 标注步骤不交 caller 同步执行，
    // 入账派发吐 dispatch_ready（独立模式 dispatcher 有自己的直派路径,不开门不走此支）。
    // @a: anc-exec-parallel-reuse-protocol
    if (this.unifiedDispatch && target.step_type === 'call' && (target as CallStep).parallel
        && (this.hasFreeSlot() || this.inflight.some(f => f.status === 'inflight'))) {
      if (!this.hasFreeSlot()) {
        const inflightNow = this.inflight.filter(f => f.status === 'inflight');
        return {
          status: 'drain_wait',
          instance_id: this.instanceId,
          loop_step_id: inflightNow[0]?.host_container ?? this.findHostContainerId(target.step_id),
          inflight: inflightNow.map(f => f.child_instance),
        };
      }
      const d = this.dispatchParallelCall(target.step_id);
      // 插值形态先求值再进占位（^anc-step-call-dynamic-callee——漏改则 {表达式} 原文漏进命令静默失败）// @a: anc-step-call-dynamic-callee
      const callee = this.resolveCalleeToken(target as CallStep) ?? '';
      return {
        status: 'dispatch_ready',
        instance_id: this.instanceId,
        step_id: target.step_id,
        dispatch_kind: 'call',
        child_instance: d.childInstance,
        host_container: this.findHostContainerId(target.step_id),
        params_for_child: d.params,
        ...(this.buildDispatchLaunchCommand('call', target.step_id, d.childInstance, d.params, callee)
          ? { launch_command: this.buildDispatchLaunchCommand('call', target.step_id, d.childInstance, d.params, callee)! } : {}),
        work_zone: this.getWorkZone(),
        ...(this.lastStale.length ? (() => {
          const live = this.lastStale.filter(ci => this.inflight.some(f => f.child_instance === ci && f.status === 'inflight'));
          const launch = this.buildStaleLaunch(live);
          return live.length ? { stale: live, ...(launch ? { stale_launch: launch } : {}) } : {};
        })() : {}),   // stale 双载荷+重拼命令（2026-08-13,driver 任一响应见 stale 即自查、没起过原样执行）// @a: anc-exec-parallel-inflight-reconcile
      };
    }
    this.stepStates.set(target.step_id, 'running');
    this.recordEvent(target.step_id, 'step_start');
    // running 状态必须落盘——复用模式下 next 与 done 是独立进程，
    // done 进程 resume 后需读到 running 才能 completeStep（否则误判 pending）
    this.persist();

    let context: AssembledContext;
    try {
      context = this.assembleBasicContext(target);
    } catch (err: unknown) {
      // context 组装失败 → 硬报错。标签忠实分型（BUG-F 实撞：deflate 写点 ENOENT 被误标
      // "doc-ref 解析失败",排障方向全歪）。// @a: anc-exec-doc-ref-resolve
      const reason = err instanceof DocRefError
        ? err.message
        : `context 组装失败（步骤输入 deflate/知识注入/doc-ref）: ${err instanceof Error ? err.message : String(err)}`;
      // fail 不碰值空间（2026-08-09 函数级 fail 定稿）——不置 None
      this.stepStates.set(target.step_id, 'failed');
      // HopLog 留痕（BUG-F 可观测性缺口：本路径在 recordStepStart 之前,不补 start 则 fail
      // 被孤儿门拦,日志零痕迹——"reason 从未 start"排障两小时的真因）。失败必须留痕。
      // @a: anc-exec-doc-ref-resolve
      this.hoplog?.recordStepStart(target.step_id, target.step_type, target.summary);
      this.hoplog?.recordStepFailed(target.step_id, reason);
      this.recordStepFailure(target.step_id, reason);
      this.handleFailStepRetry(target.step_id, reason);
      return this.nextStep();
    }

    // None 闸已删（2026-08-09 作者定"fail 即异常"定稿）：None 是普通值（= Null 重置/
    // 未产出/上游 fail 置的输出都合法），失败传播由真实依赖驱动——下游拿 None 干不出
    // 达标结果时因自身失败（执行体报告/check 判 false）而 fail，引擎不连坐。
    // 原"← 输入含 null 自动 fail(MISSING_INPUT)"废。// @a: anc-exec-none-propagation

    // confirm 是 CITL 审批闸门：返回 paused（approve/reject）。载荷现场组装+落问题卡 paused.json
    //（0028 作者拍板 B——跨进程可取）,暂停态仍由 running 状态编码（^anc-exec-pause-persist）。// @a: anc-cli-execution-paused, anc-exec-hitl-presentation, anc-exec-pause-persist
    if (target.step_type === 'confirm') {
      const confirmNode = target as ConfirmStep;
      const options: ResponseOption[] = confirmNode.response_options ?? [
        { value: 'approve', label: '批准' },
        { value: 'reject', label: '拒绝' },
      ];
      const response = {
        status: 'paused' as const,
        instance_id: this.instanceId,
        step_id: target.step_id,
        pause_reason: (confirmNode.require_human ? 'waiting_human' : 'confirm') as 'waiting_human' | 'confirm',
        presented_data: {
          summary: target.summary,
          // question=给人的问题面,只由 summary 构成;instruction 是驱动侧作业指引,独立字段
          // 不拼进 question（#34 受众分流,^anc-exec-hitl-presentation）
          question: `审批：${target.summary}`,
          instruction: context.instruction,
          // 人通道:直读原值 + formatHumanContext(>5K 走 {$file, preview}),user 看到 preview 完整可读。
          // 不用 context.inputs(已被 PromptAssembler 处理给 LLM 用)。见 ^anc-exec-audience-routing。
          context: formatHumanContext(this.resolveRawInputs(target), this.getWorkZone()),
        },
        response_options: options,
        work_zone: this.getWorkZone(),
      };
      // confirm 是人通道暂停——任何模式都不发生 LLM 调用,不记 llm.prompt（观测不变式
      // "llm 块=真实 LLM 调用",^anc-obs-record-at-boundary;交付物是 presented_data 非 prompt）。
      this.hoplog?.recordStepStart(target.step_id, target.step_type, target.summary, context.inputs);
      this.flushDocRefMeta(target.step_id);
      this.flushRetryFeedbackMeta(target.step_id);
      this.writePausedCard(response);   // 暂停即产卡,先落盘后返回（^anc-exec-pause-persist,0028）
      return response;
    }

    // ask 是 CITL 数据收集：返回自包含介入请求（question + output_schema + default + options）。
    // 见概念 ^anc-step-ask / ^anc-exec-hitl-presentation。// @a: anc-step-ask, anc-exec-hitl-presentation
    if (target.step_type === 'ask') {
      // default_value：取第一个声明输出在 inputs 中的同名推断值（前序产出），无则 undefined
      const firstOut = target.outputs?.[0]?.name;
      const defaultValue = firstOut ? context.inputs[firstOut] : undefined;
      // present_inputs:透传 AskStep 声明,driver 据此完整 dump 这些 context 字段(禁缩略)。
      // 见 design/step-dispatcher.md ^anc-exec-hitl-presentation。// @a: anc-rule-p14, anc-exec-hitl-presentation
      const askNode = target as AskStep;
      // options：从 inputs 里的列表型候选构造（可选，对齐 CC AskUserQuestion）
      const response = {
        status: 'paused' as const,
        instance_id: this.instanceId,
        step_id: target.step_id,
        pause_reason: 'ask' as const,
        presented_data: {
          summary: target.summary,
          // 同 confirm:question 不拼 instruction（#34 受众分流）
          question: `请提供：${target.summary}`,
          instruction: context.instruction,
          // 人通道:直读原值 + formatHumanContext(>5K 走 {$file, preview})。
          // 见 ^anc-exec-audience-routing。
          context: formatHumanContext(this.resolveRawInputs(target), this.getWorkZone()),
          output_schema: target.outputs ?? [],
          ...(defaultValue !== undefined ? { default_value: defaultValue } : {}),
          ...(askNode.present_inputs && askNode.present_inputs.length > 0 ? { present_inputs: askNode.present_inputs } : {}),
        },
        // 结构化候选：← 输入中的字符串列表值转 options（概念 ^anc-step-ask"候选来自 ←，可选"——
        // 2026-08-08 审计 E 类：原恒 [] 与注释意图不符，按设计实现）。非列表/空列表输入不产生候选。
        response_options: Object.entries(context.inputs ?? {})
          .filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string'))
          .flatMap(([, v]) => (v as string[]).slice(0, 8))
          .map(opt => ({ value: opt, label: opt })),
        work_zone: this.getWorkZone(),
      };
      // ask 同 confirm——人通道零 LLM 调用,不记 llm.prompt（^anc-obs-record-at-boundary）。
      this.hoplog?.recordStepStart(target.step_id, target.step_type, target.summary, context.inputs);
      this.flushDocRefMeta(target.step_id);
      this.flushRetryFeedbackMeta(target.step_id);
      this.writePausedCard(response);   // 暂停即产卡（^anc-exec-pause-persist,0028）
      return response;
    }

    const workZone = this.getWorkZone();
    const response = {
      status: 'step_ready' as const,
      instance_id: this.instanceId,
      step_id: target.step_id,
      step_type: target.step_type as ExecutableStepType,
      summary: target.summary,
      // context.inputs 由 PromptAssembler 已截断到 2000 字符(LLM prompt 渲染用),
      // 不做 deflate(deflate 用于原始数据通道:paused.context / outputs / params_for_child)。
      context,
      work_zone: workZone,
      // 本步 output 文件的确切路径——driver/worker 照此写、`--output "@<output_path>"` 提交,零拼名自由度。
      // 消除"parallel 内层 step_id 恒为模板 id、拼名易撞"的串台。见 design ^anc-exec-work-zone。
      output_path: join(workZone, `out_${target.step_id}.json`),
      // call 协议载荷：init/两回报命令引擎拼好,driver 照抄零手拼 // @a: anc-exec-call-protocol-payload
      ...(target.step_type === 'call' ? (() => {
        const cp = this.buildCallProtocol(target as CallStep);
        return cp ? { call_protocol: cp } : {};
      })() : {}),
    };
    // 记录点选址按事实边界（^anc-obs-record-at-boundary,2026-08-24 作者定"hoplog 的位置有
    // 严重问题"）:复用模式的发送边界=本处（step_ready 交付给 caller,formatPromptText 产物即
    // 实际交付物,记录为真）;独立模式的发送边界在 dispatcher API 调用处（llm.prompt 由彼处从
    // 实际 request 对象成对记录）——本处不再预记渲染件,防"意图层记录与实发内容分叉"重演
    // （旧形态假 prompt 骗过十几轮走查）。带 body 的 act/commit 引擎直执零 LLM,任何模式都
    // 不记 prompt（旧形态给 body 步记 "[ACT BODY]" prompt 制造执行通道假象——作者走查实撞）。
    // @a: anc-obs-record-at-boundary, anc-obs-debug-context
    // H3（2026-08-31 排查 probe 实锤——check body 步引擎消化零 LLM,复用模式却被记完整
    // llm.prompt 含判官角色档:走查者误以为发生过 LLM 判定,'body 步记假 prompt'旧病漏 check）。
    const hasBody = (target.step_type === 'act' || target.step_type === 'commit' || target.step_type === 'check') && !!(target as ActStep).body;
    const reusePrompt = !this.inlineLlmContext && !hasBody
      ? formatPromptText(context, target.step_type === 'act' ? actRoleKind((target as ActStep).free) : target.step_type)
      : undefined;
    this.hoplog?.recordStepStart(target.step_id, target.step_type, target.summary, context.inputs, reusePrompt);
    this.flushDocRefMeta(target.step_id);
    this.flushRetryFeedbackMeta(target.step_id);
    return response;
  }

  completeStep(stepId: string, outputs?: Record<string, unknown>): CommandResponse {
    // aborted 墓碑门（^anc-exec-abort 第4条）：回写漏斗同拒——submit 不得给死实例记账。
    if (this.terminalState === 'aborted') {
      return { status: 'error', code: ErrorCode.INVALID_STATE, message: `RUN_ABORTED: 实例已主动中止（${this.abortReason ?? '(user abort)'}）——终局不可恢复` };
    }
    const state = this.stepStates.get(stepId);

    if (state === 'done') {
      // 幂等重发与错位递交分流（hopissues/0049——原恒 ok 使 completeAndAdvance 放行推进:
      // 内容静默丢弃+指针照推+双 running 三害并发,失败点与真因相距任意远。先比内容再定待遇:
      // 无 outputs 或与已存值逐字段相同=真幂等照旧 ok;带不同内容=错位递交,error 拒并指路）
      // @a: anc-cli-idempotency, anc-exec-stale-resubmit
      if (outputs && Object.keys(outputs).length > 0) {
        // 比对在归一后进行（review D1）——已存值是写入侧归一(不动点 recover+coerce)后的形态,
        // 拿原始递交值直比会把"逐字节重发同一响应"误判成不同内容（声明 int/bool/yaml 或围栏
        // 形态下原始串≠归一后结构,真幂等承诺就塌了）。走与写入侧同一套归一再深比对。
        const doneDecl = this.findStepById(stepId);
        let cmp = outputs;
        // HITL 应答映射同律（review F5 钉实撞——confirm 重发 {value:"approve"} 与已存映射值
        // {approved:true} 键名不同,直比误判 STALE_RESUBMIT,幂等承诺对 HITL 应答塌）:比对前
        // 先走与写入侧同一套应答映射。confirm 只映射 approve 形态（reject 打在已 approve 的
        // 步上是冲突递交,照拒）;ask 经 mapAskOutputs（approve 快捷读当前变量值,天然等于已存）。
        // @a: anc-exec-stale-resubmit
        if (doneDecl?.step_type === 'confirm') {
          const decision = this.extractDecision(outputs);
          if (decision !== undefined && !CONFIRM_REJECT_VALUES.has(String(decision).toLowerCase())) {
            cmp = this.mapConfirmOutputs(doneDecl, outputs, decision);
          }
        } else if (doneDecl?.step_type === 'ask') {
          cmp = this.mapAskOutputs(doneDecl, outputs, stepId);
        }
        if (doneDecl?.outputs?.length && doneDecl.step_type !== 'confirm' && doneDecl.step_type !== 'ask') {
          cmp = normalizeOutputsToFixpoint(doneDecl.outputs, recoverOutputValues(doneDecl.outputs, outputs, this.spec?.header.types), this.spec?.header.types);
        }
        const differs = Object.entries(cmp).some(([k, v]) => {
          const stored = this.variables.read(k, 'root');
          return JSON.stringify(stored) !== JSON.stringify(v);
        });
        if (differs) {
          // 报文点名口径（review D2/D3）:running 取叶子（容器 running 时报其内真正等回写的
          // 叶子,容器号对 driver 无纠错价值）;查无 running 报先序第一个 pending——两形态都
          // 点名具体步号（0049 事故形态正是 driver 步号错位,点名即纠错线索）。
          const wt = this.findWritebackTarget();
          const target = wt.kind === 'running' ? `步骤 '${wt.stepId}'` : wt.kind === 'pending' ? `步骤 '${wt.stepId}'（下一个待执行）` : '下一个待执行步骤';
          return { status: 'error', code: ErrorCode.INVALID_STATE,
            message: `STALE_RESUBMIT: 步骤 '${stepId}' 已完成且本次递交内容与已存值不同——递交被拒,变量与指针未动。引擎当前在等${target}的回写,请核对步号后重交` };
        }
      }
      return { status: 'ok', code: ErrorCode.ALREADY_DONE, message: 'Step already completed' }; // @a: anc-cli-idempotency
    }
    if (state !== 'running') {
      return { status: 'error', code: ErrorCode.INVALID_STATE, message: `Step '${stepId}' is ${state ?? 'unknown'}, expected running` };
    }

    // lack_of_info 判定先于 schema 校验（0053 顺序契约——该形态天然缺声明槽,后判则先被
    // SCHEMA_MISMATCH 打回、逃生口永不可达。承接面仅 reason:它是 reason 的缺信息自报通道
    //〔工具故障另走下方 tool_failure 早判〕;act/check 交该键照走 schema 校验〔check 判不了的正形=如实 false/escalatable gap〕。
    // 两模式同点:独立模式 dispatcher 有 provider 时先走补充检索不到此,无 provider 或复用模式
    // CLI submit 在此转 failStep——fail_kind 携语义进容器升级链）。// @a: anc-exec-none-propagation
    const declNodeEarly = this.findStepById(stepId);
    if (declNodeEarly?.step_type === 'reason' && outputs
        && outputs['lack_of_info'] !== undefined && outputs['lack_of_info'] !== null) {
      const why = typeof outputs['lack_of_info'] === 'string' ? outputs['lack_of_info'] : JSON.stringify(outputs['lack_of_info']);
      return this.failStep(stepId, `${why} (lack_of_info)`, 'lack_of_info');
    }
    // 工具故障自报（^anc-exec-tool-failure-report,2026-09-01 作者拍板 A 案;同日补定 reason
    // 入承接面"reason也需要用tool,特别是web search"——复用模式执行者是带工具面的 agent;
    // commit 议过撤回"现在commit必须通过body"——body 通道有 TOOL_EXEC_ERROR 闭环不需自报口）：
    // 单键 tool_failure=执行 LLM 如实认输工具故障——同 lack_of_info 先于 schema 校验（自报
    // 形态天然缺声明槽）;fail_kind 携语义进容器阶梯（缺省重试,瞬时故障重试即愈）。有 body 的
    // act 走解释器闭环不经此;check 不设（判不了的正形=如实 false/escalate）。// @a: anc-exec-tool-failure-report
    const tfEligible = declNodeEarly && (declNodeEarly.step_type === 'reason'
      || (declNodeEarly.step_type === 'act' && !(declNodeEarly as { body?: unknown }).body));
    if (tfEligible && outputs
        && outputs['tool_failure'] !== undefined && outputs['tool_failure'] !== null) {
      const why = typeof outputs['tool_failure'] === 'string' ? outputs['tool_failure'] : JSON.stringify(outputs['tool_failure']);
      return this.failStep(stepId, `${why} (tool_failure)`, 'tool_failure');
    }

    // 输出 schema 校验（值层面，写 vars 前）：不匹配 → 不写不标 done，返回 SCHEMA_MISMATCH。
    // 触发算子级重试（独立模式引擎内重做 / 复用模式 done 打回 CC）。
    // confirm/ask 豁免：其输出是 caller 注入的 answer（审批信号/数据值），规范化在 mapConfirm/mapAskOutputs 做。
    // @a: anc-exec-output-schema-check
    const declNode = this.findStepById(stepId);
    if (declNode && declNode.step_type !== 'confirm' && declNode.step_type !== 'ask' && declNode.outputs?.length) {
      // 围栏输出恢复阶梯（BUG-C 修——校验前解围栏/YAML/单键嵌套,解出真值才采用,解不出照拒）。
      // 恢复即留痕（declared-or-flagged:静默改值不可无痕——审计读出"LLM 给了围栏,引擎剥的"）。
      // // @a: anc-exec-output-fence-recovery
      if (outputs) {
        const before = outputs;
        outputs = recoverOutputValues(declNode.outputs, outputs, this.spec?.header.types);
        for (const k of Object.keys(outputs)) {
          if (outputs[k] !== before[k]) {
            // 留痕分型:null→[] 归一与围栏剥壳是两种恢复,审计措辞如实（declared-or-flagged）
            // // @a: anc-exec-output-schema-check （null 归一 warn 半边——归一动作在 validator,留痕在此）
            const msg = (before[k] === null || before[k] === undefined)
              ? `输出字段 "${k}" 收到 null,按列表型声明归一为空列表 []（LLM 给了 null,引擎归的——作者定宽容度条款）`
              : `输出字段 "${k}" 经围栏恢复阶梯解出（原值为围栏/文本包裹形态,已剥壳采用）`;
            this.hoplog?.recordWarn(stepId, msg);
          }
        }
      }
      const mismatches = validateOutputValues(declNode.outputs, outputs ?? {}, this.spec?.header.types);   // typeDecls:递归字段核（0014）
      // line 空串恒拦已迁约束标注（2026-09-02 作者拍 B 案 ^anc-type-constraint-annotation——
      // 恒拦=类型级非空语义行为化,与 body/初值豁免并存即概念分裂;非空要求归声明处
      // line(nonempty) 标注,判据在 checkValue,本处不再特判。裸 line 空串恒合法。）
      if (mismatches.length > 0) {
        // 重试反馈半边：不匹配值带围栏痕迹时,反馈明说"直接返回值"——盲重试同因必死的对治
        const fenced = mismatches.some(m => typeof m.actual === 'string' && m.actual.includes('```'));
        const hint = fenced ? '\n提示:不要用代码围栏(```)包裹输出、不要在值外再套变量名键——直接返回值本身。' : '';
        return { status: 'error', code: ErrorCode.SCHEMA_MISMATCH, message: formatSchemaMismatch(mismatches, this.spec?.header.types) + hint };   // typeDecls:反馈附定义行（0017）
      }
      // 边界归一转换（校验后、写 vars 前）：声明 int/float/number 的数字串转数字、bool 的
      // "true"/"false" 转布尔——声明类型是权威，变量空间不存跨类型值（配套 hop_python 等值
      // 严格化，宽松等值随之删除）。// @a: anc-exec-output-coerce
      // 不动点归一（2026-08-24 取代单趟 recover(coerce)——单趟对嵌套组合壳必漏:coffee3
      // 实撞 coerce 解 JSON 壳→recover 剥同键嵌套→露出 YAML 串无人再看,字符串入库下游炸。
      // 循环 recover+coerce 至值稳定,任何嵌套组合被自然吃净）。// @a: anc-exec-output-fence-recovery
      if (outputs) outputs = normalizeOutputsToFixpoint(declNode.outputs, outputs, this.spec?.header.types);
    }

    // check 判定：固定双槽签名，引擎按类型定位 bool 槽判通过/失败。false → failStep
    // 接升级阶梯（首次带反馈重跑、再 adaptive）；text 槽作失败说明。
    // 模式无关（复用 CLI done / 独立 dispatcher 共用此处）。// @a: anc-exec-check-verdict
    if (declNode?.step_type === 'check') {
      const boolDecl = declNode.outputs?.find(o => o.type === 'bool');
      const verdict = boolDecl ? outputs?.[boolDecl.name] : undefined;
      if (verdict === false || verdict === 'false') {
        const textDecl = declNode.outputs?.find(o => o.type === 'text' || o.type === 'yaml');
        const explanation = textDecl ? outputs?.[textDecl.name] : undefined;
        // 升层分派（^anc-exec-check-escalate,0006 批次一）：机械四条件——ok=false ∧ 声明
        // escalatable ∧ 说明槽为结构化对象 ∧ escalate===true（严格判,不嗅探文本）→ 不入
        // failStep/retry,走升层暂停（问路不是失败）。任一不满足 → 既有 failStep 路径原样。
        // 非 escalatable 的 check 写了 escalate:true → warn 不生效（declared-or-flagged,
        // 防"判定者诚实被静默吞"——validator E2 静态半边管不了运行期值,此处补运行期半边）。
        // @a: anc-exec-check-escalate
        const gapObj = explanation !== null && typeof explanation === 'object' ? explanation as Record<string, unknown> : null;
        if (gapObj && gapObj['escalate'] === true) {
          if ((declNode as CheckStep).escalatable) {
            return this.pauseForEscalation(stepId, declNode as CheckStep, gapObj);
          }
          this.hoplog?.recordWarn(stepId, `check 说明槽写了 escalate:true 但步骤未声明 escalatable——升层无效,走常规失败路径（声明缺席字段无效,E2）`);
        }
        // check 失败前先写它的**更新模式输出**（← X 且 → X，回填的 last_err 等）——否则显式反馈值
        // 丢失（failStep 直接 return 不经 writeOutputs）。只写更新模式输出，保持"check 失败不落新产出"
        // 语义（bool 判定槽/独立 text 槽仍不落盘）。与概念 ^anc-step-check「text 槽是失败说明」一致。
        // 注:原锚点另一半"failStep 置 None 跳过更新模式"已随函数级 fail 定稿废（fail 不碰值空间,
        // 2026-08-09）——本处 check 主动写回是存续的一半。// @a: anc-exec-failstep-skip-update
        if (outputs) {
          const updateOuts = declNode.outputs?.filter(o => isUpdateModeOutput(declNode, o.name)) ?? [];
          if (updateOuts.length) {
            const scopeId = getWriteScope(stepId, this.spec!);
            for (const o of updateOuts) {
              if (o.name in outputs) this.variables.write(o.name, outputs[o.name], scopeId);
            }
          }
        }
        return this.failStep(stepId, `CHECK_FAILED: ${explanation ?? '(no explanation)'}`);
      }
    }

    // confirm answer 规范化：caller 注入的 answer（原始 key 如 value）不直接写，
    // 而是提取决策值 → reject 走 failStep、approve 按声明输出类型槽映射（bool→true，
    // 非 bool→原值）落到声明的变量名。模式无关（CLI done / dispatcher.resume 共用）。
    // 见概念 ^anc-step-confirm / 设计 step-dispatcher ^anc-exec-confirm-answer。// @a: anc-exec-confirm-answer
    if (declNode?.step_type === 'confirm') {
      const decision = this.extractDecision(outputs);
      if (decision !== undefined && CONFIRM_REJECT_VALUES.has(String(decision).toLowerCase())) {
        // reject = 授权否决 → 全局中止（非局部 None 传播）：fail 本步 + 跳过所有未终态步骤。
        // 见概念 ^anc-step-confirm reject 全局中止 / 设计 ^anc-exec-confirm-answer。
        this.stepStates.set(stepId, 'failed');
        this.recordStepFailure(stepId, `confirm rejected by caller: ${decision}`);
        this.hoplog?.recordStepFailed(stepId, `confirm rejected by caller: ${decision}`);
        this.removePausedCard();   // reject 同样结束等人窗口——卡随窗口关闭（^anc-exec-pause-persist）
        for (const [id, status] of this.stepStates) {
          if (id !== stepId && (status === 'pending' || status === 'running')) {
            this.stepStates.set(id, 'skipped');
          }
        }
        this.persist();
        return { status: 'ok' };
      }
      outputs = this.mapConfirmOutputs(declNode, outputs, decision);
    }

    // ask answer 处理：caller 提供的数据值落到 +→ 声明的变量名。
    // 与 confirm 正交——无 reject 中止，不做 bool 映射。answer 可能是 {声明名:值}、
    // {value:值}（包装）、或 approve（采用 default_value 快捷）。见 ^anc-step-ask / ^anc-exec-hitl-presentation。
    // @a: anc-step-ask, anc-exec-hitl-presentation
    if (declNode?.step_type === 'ask') {
      // 凭证闸判原始 answer 键（十八审抓 0004 ask 级绕闸盲区：单键 {hop_env_gh_token:v} 不匹配
      // 声明名走 mapAskOutputs 单值提取——键名被吃、值落普通声明变量照样落盘,原闸在 map 后判
      // hop_env_ 前缀恒不触发。键名是用户显式意图,形似凭证即拒,无论最终映射到哪）。
      // @a: anc-config-hop-env
      if (outputs) {
        for (const k of Object.keys(outputs)) {
          if (k.startsWith('hop_env_') && credentialLikeHopEnvKey(k)) {
            return { status: 'error', code: ErrorCode.SCHEMA_MISMATCH, message: hopEnvCredentialError(k, 'ask 回填') };
          }
        }
      }
      outputs = this.mapAskOutputs(declNode, outputs, stepId);
      // ask 零映射拒收（0031,^anc-exec-hitl-presentation 零映射条款）：规范化后一个声明输出都
      // 没得到有效值 → 拒收不写表不记 hitl 卡保留（典型:answer={value:'approve'} 而前序无同名
      // 推断值——approve 是 confirm 应答形态,ask 要业务值）。部分映射放行（增量应答合法,
      // 未答的落 None 归 None 传播）——拦的是应答形态整体错误的机械判据。
      const askDecls = declNode.outputs ?? [];
      // 无有效值=undefined 或 null（review 复核抓漏:MCP/CLI answer 走 JSON,JSON 无 undefined、
      // 序列化空值恰产 null——{value:null} 灌满声明输出穿闸,0031 病灶经 null 形态复发）
      if (askDecls.length > 0 && outputs && askDecls.every(d => outputs![d.name] === undefined || outputs![d.name] === null)) {
        const wanted = askDecls.map(d => d.name).join(', ');
        return { status: 'error', code: ErrorCode.SCHEMA_MISMATCH,
          message: `ASK_ANSWER_EMPTY: 应答未提供任何声明输出（${wanted}）——ask 要业务数据值;` +
            `approve 快捷仅在前序已有同名推断值时可用（本步无），请按 output_schema 提供真实值` };
      }
      // ask 输出到 hop_env_* = 覆盖链合法末级（运行时问人补值）——并入 HostConfig.hop_env,
      // doc-ref 展开/后续 body 注入消费同一张表。// @a: anc-config-hop-env
      if (outputs && this.hostConfig) {
        for (const [k, v] of Object.entries(outputs)) {
          if (k.startsWith('hop_env_') && typeof v === 'string') {
            // 凭证禁入三级闸之 ask 级（0004——人现场输入最容易顺手贴 token;拒收不写表,
            // 走 SCHEMA_MISMATCH 通道让 caller 重新问人指路 api_key_env）
            if (credentialLikeHopEnvKey(k)) {
              return { status: 'error', code: ErrorCode.SCHEMA_MISMATCH, message: hopEnvCredentialError(k, 'ask 回填') };
            }
            (this.hostConfig.hop_env ??= {})[k] = v;
            // 授权面随末级并入（与组合根"声明即授权"同款判据——问人补的绝对根不扩读白名单,
            // 随后 doc-ref 展开即被 validateReadAccess 拒,末级形同虚设;review 实抓）。
            // @a: anc-exec-doc-ref-hop-env
            const allowed = this.hostConfig.sandbox.filesystem.read_access.allowed;
            if (isAbsolute(v) && !allowed.includes(v)) allowed.push(v);
          }
        }
      }
    }

    if (outputs) {
      const scopeId = getWriteScope(stepId, this.spec!);
      this.variables.writeOutputs(outputs, scopeId);
    }

    this.stepStates.set(stepId, 'done');
    // 命令/工具/时间三 journal 完成清账（^anc-exec-subprocess-run review F3——原完成清只在
    // advanceToCaller 消化循环〔复用路径〕,standalone 经本函数收尾零清账:for-each 轮末复位
    // 不清 journal,第二轮同 step_id 命中重放返回上一轮 stdout,命令不再执行=静默错数据。
    // 完成即清=两模式同一语义:journal 是步骤内中断续跑设施,步骤 done 即无用;重跑重执行是
    // 预期）。本收尾单点只清 cmdJournal;toolJournal/timeJournal 的完成清账在
    // advanceToCaller 消化循环内(body 跑完处三账同清,那里才是三 journal 的公共完成清点)。
    // // @a: anc-exec-subprocess-run
    delete this.cmdJournal[stepId];
    // 答案成功消化即删问题卡（^anc-exec-pause-persist——卡生命周期=等人窗口;
    // 拒收路径〔SCHEMA_MISMATCH 等,早 return〕不到此处,卡自然保留仍有效）。
    if (declNode?.step_type === 'confirm' || declNode?.step_type === 'ask') this.removePausedCard();
    // commit 退火标记（done 即登记,带祖先 loop 轮次快照——^anc-exec-commit-anneal 判据重构）：此后祖先边界 retry 触发即 fail,防重放。
    // // @a: anc-exec-commit-anneal
    if (declNode?.step_type === 'commit') this.markCommitted(stepId);
    this.recordEvent(stepId, 'step_done');
    // confirm/ask 决策是 CITL 审计点：决策值记成 hitl 审计字段（无视日志级别），
    // 而非随 recordStepDone 被 info 级脱敏成 null。2026-08-09 扩 ask——人给的数据值与
    // 批复同为审计对象（e2e hitl 深核实撞:ask 不入轨=介入审计有洞）。// @a: anc-obs-hitl-record
    if ((declNode?.step_type === 'confirm' || declNode?.step_type === 'ask') && outputs) {
      const vals = Object.values(outputs);
      // response 记应答原文（0031 连带,^anc-obs-hitl-record）：单个已定义值记该值;含 undefined 或
      // 多键走 JSON 原文——原 String(undefined) 记成字面 'undefined',审计块等于没记
      // 单值仅当是原始类型才 String（数组/对象 String() 出 '[object Object]' 同样等于没记）,
      // 其余一律 JSON 原文——设计条款'单值记该值,复杂对象记 JSON 原文'的完整落地
      const decision = vals.length === 1 && vals[0] !== undefined && typeof vals[0] !== 'object'
        ? String(vals[0])
        : JSON.stringify(outputs);
      // shown=展示给决策者的问题面——与 paused 载荷 question 同源（#34 受众分流后 instruction
      // 不进人眼,审计再拼它=记人没看到的内容,"还原人当时看到了什么"失真——review 实抓,
      // 观测记录点必须在事实边界）。instruction 的审计痕在 paused 卡整卡（writePausedCard）。
      // （设计 ^anc-obs-hitl-record 契约字段）。
      const shown = declNode.summary;
      // response_options=呈现给决策者的结构化选项：spec 声明的;confirm 缺省 approve/reject,
      // ask 无缺省选项（自由数据值,候选来自 spec 声明的 options,没有就空)。
      // 复核抓出"接口加字段无写入方=死胎"，补写入（与 paused 响应呈现的同源）。
      const respOptions = (declNode as ConfirmStep).response_options
        ?? (declNode.step_type === 'confirm'
          ? [{ value: 'approve', label: '批准' }, { value: 'reject', label: '拒绝' }]
          : []);
      this.hoplog?.recordStepMeta(stepId, {
        hitl: { shown, response_options: respOptions, response: decision, responder: 'caller', at: new Date().toISOString() },
      });
    }
    this.hoplog?.recordStepDone(stepId, outputs);

    // propagate + 容器 done 记录(branch/case/subtask/loop 级联标 done 时补 recordStepDone)
    this.propagateAndRecord(stepId);

    this.persist();
    return { status: 'ok' };
  }

  // 完成并推进到 caller 介入点：driver 交活 + 领取下一指令的一次原子往返。
  // completeStep 成功 → 推进、消化中间步（纯计算 body）→ 停在下一个 caller 介入点或终态，
  // 返回 NextResponse。completeStep 出错（SCHEMA_MISMATCH 等）→ 原样返回错误码、不推进。
  // 执行节奏归引擎（概念层原则 6）。见设计 ^anc-exec-advance-to-caller。// @a: anc-exec-advance-to-caller
  // 复用模式 act body 工具结果注入：追加到本步 journal 并落盘——下次 advanceToCaller 重放时
  // 代入继续。见设计 ^anc-exec-tool-request。// @a: anc-exec-tool-request
  submitToolResult(stepId: string, toolResult: unknown): CommandResponse {
    const node = this.findStepById(stepId);
    // check 同权（设计 ^anc-step-check-body 明定"含工具 body 同权 tool_request 挂起恢复",
    // ToolRequest.step_type 早含 'check'——本守卫漏扩,呈得出答不了=死锁;hopissues 0041
    // 实撞:hopbuild2 4.3 check body 末行 write 落快照,每 run 必撞 campaign 级阻塞）。
    if (!node || (node.step_type !== 'act' && node.step_type !== 'commit' && node.step_type !== 'check')) {
      return { status: 'error', code: ErrorCode.INVALID_STATE, message: `INVALID_STATE: --tool-result 只应答 act/commit/check 的 tool_request（step "${stepId}"）` };
    }
    (this.toolJournal[stepId] ??= []).push(toolResult);
    this.persistToolJournal();
    return { status: 'ok' };
  }

  async completeAndAdvance(stepId: string, outputs?: Record<string, unknown>): Promise<NextResponse | CommandResponse> {
    const resp = this.completeStep(stepId, outputs);
    if (resp.status !== 'ok') return resp;   // 错误不推进（重做本步也是"下一步指令"）
    // 幂等重发不进 advance（hopissues/0056 作者拍 B 案,^anc-exec-stale-resubmit 收尾半边）：
    // 零状态变化的请求没有"推进"可言——原借道 advanceToCaller 会撞 running 叶子落
    // WAITING_WRITEBACK,status:"failed" 配报文"不是失败"自相矛盾,driver 按"failed=终态"
    // 教条误伤合法重发。status 回答请求自身的结局(ok),"引擎在等步 Y"是指引归报文——
    // 点名口径与 STALE_RESUBMIT 同源(running 叶子优先,查无报先序第一个 pending)。
    // @a: anc-exec-stale-resubmit, anc-cli-idempotency
    if (resp.code === ErrorCode.ALREADY_DONE) {
      const wt = this.findWritebackTarget();
      const target = wt.kind === 'running' ? `引擎当前在等步骤 '${wt.stepId}' 的回写` : wt.kind === 'pending' ? `下一个待执行步骤是 '${wt.stepId}'` : '请查询 status 获取当前进度';
      return { status: 'ok', code: ErrorCode.ALREADY_DONE,
        message: `步骤 '${stepId}' 已完成（本次为幂等重发,未做任何变更）;${target}` };
    }
    return this.advanceToCaller();
  }

  /** 回写欠账点名公共体（^anc-exec-stale-resubmit——STALE_RESUBMIT 拒收报文与 ALREADY_DONE
   * 幂等回执共用:running 叶子优先〔容器 running 是结构状态,报其内真正等回写的叶子〕,
   * 查无报先序第一个 pending,都无=none〔第三兜底,消费方指路查 status〕。抽公共体前两处
   * 逐行复制,review F3 抓"同源承诺靠人工同步"后合一。 */ // @a: anc-exec-stale-resubmit
  private findWritebackTarget(): { kind: 'running' | 'pending' | 'none'; stepId?: string } {
    const states = [...this.stepStates.entries()];
    const waiting = states.find(([sid, st]) => {
      if (st !== 'running') return false;
      const step = this.findStepById(sid);
      return !step || !CONTAINER_STEP_TYPES.has(step.step_type);
    })?.[0];
    if (waiting) return { kind: 'running', stepId: waiting };
    const nextPending = states.find(([, st]) => st === 'pending')?.[0];
    if (nextPending) return { kind: 'pending', stepId: nextPending };
    return { kind: 'none' };
  }

  // 从当前状态推进到下一个 caller 介入点：消化纯计算 body（BodyInterpreter + 哑 ToolProvider），
  // 遇 caller 介入点/终态停。async 因 BodyInterpreter.run 是 async（纯计算 body 实际无 IO）。
  // 统一模型推进：dispatch_ready/drain_wait 由 nextStep 产生（unifiedDispatch 门），advance 只消化纯计算步。
  // @a: anc-exec-advance-to-caller, anc-exec-parallel-batch, anc-exec-parallel-foreach-barrier
  async advanceToCaller(): Promise<NextResponse> {
    // fan-out 优先：探最外层 parallel batch 必须先于 nextStep 树遍历。
    // 否则 dfsNextStep 越过未 join 的 forEach parallel（标 running 后 continue），落到同级
    // 后续步并当作下一个 executable 返回 → nextStep 把它误标 running 并持久化；join 完成后
    // 再遍历时该步既非终态也非 pending → dfsNextStep 跳过 → "No executable step found"。
    // collectParallelBatch 能直接命中 pending 的最外层 parallel 并标 running，无需 nextStep 先行。
    // worker（canFanout=false）不进此分支，照常 nextStep 下钻子树。
    // 见 design/parallel-execution.md §9b' ^anc-exec-parallel-foreach-barrier。
    // 旧通道 fan-out 探测已删（P0.5）：复用模式下 parallel 标注串行下钻=退化窗口，
    // P2 渐进协议（dispatch_ready 交 driver）恢复并行。见 parallel-execution §U7。
    // tool_request 挂起恢复：上个进程解释含工具 body 到一半（步骤已 running、journal 已有结果）。
    // nextStep 不返回 running 步 → 显式找挂起步先续跑（顺序执行下最多一个）。// @a: anc-exec-tool-request
    const suspended = this.findSuspendedBodyStep();
    let result: NextResponse = suspended ?? this.nextStep();
    while (result.status === 'step_ready' && !this.isCallerActionPoint(result.step_id)) {
      const node = this.findStepById(result.step_id) as ActStep | CommitStep | CheckStep | null;
      if (!node?.body) break;   // 防御性二次确认（无 body 本该被 isCallerActionPoint 拦为介入点）
      // commit 执行入口动态核（^anc-exec-advance-order-invariant 防线二,复用模式入口）：
      // commit 不可逆,执行前核"文档序先于本步的全部步骤已终态"——存在 pending/running 即拒,
      // WAITING_WRITEBACK 同族响应带点名,不执行 body（步骤保持 running,前序交付后重放续跑,
      // 本闸每轮重核）。// @a: anc-exec-advance-order-invariant
      if (node.step_type === 'commit') {
        const blocking = findNonTerminalBefore(result.step_id, this.spec?.steps ?? [], this.stepStates);
        if (blocking) {
          return {
            status: 'failed',   // 载体形态:非终态错误响应（不 finalize 不 close）——与 WAITING_WRITEBACK 同族
            instance_id: this.instanceId,
            failed_step_id: '',
            failure_reason: `WAITING_WRITEBACK: commit 步 '${result.step_id}' 之前的步骤 '${blocking}' 尚未终态——不可逆操作拒绝越序执行,先交付前序步骤结果,不是失败`,
            partial_outputs: this.deflateValues(this.collectOutputs()),
            work_zone: this.getWorkZone(),
          };
        }
      }
      // 含工具 body：确定性重放——journal 内结果代入，journal 外挂起转 ToolRequest。
      // 纯计算 body：journal 恒空、永不挂起，行为与旧逻辑一致。// @a: anc-exec-tool-request
      const journal = this.toolJournal[result.step_id] ?? [];
      // 执行主体原则分派（2026-09-05,^anc-exec-tool-request 分派判据）：引擎 provider 命中
      // 的工具直执,结果先入账（追加本步 journal+持久化）再续跑——崩溃重放代入不重执行,
      // 与 --tool-result 回填路径同款账本语义;provider 外（caller 会话专属）才挂起 tool_request。
      const stepIdForJournal = result.step_id;
      // provider 构造受保护（0076——工厂内现读 hopjit.yaml,注册件撞内置名 TOOLS_NAME_CONFLICT/
      // 坏节 TOOLS_FILE_INVALID 在此抛;原裸调在 try 块外,配置错会炸出 advanceToCaller 成进程级
      // 错误〔直执批 review 挂账缺陷转正〕——折步骤 fail 走升级链,报错文案自带修法响亮可处置）
      // @a: anc-exec-tool-request
      let enginePv: ToolProvider | null = null;
      if (bodyHasToolCall(node.body)) {
        try {
          enginePv = this.getEngineToolProvider();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          this.hoplog?.recordWarn(result.step_id, msg);
          this.failStep(result.step_id, `工具注册表装配失败(修 hopjit.yaml 后重试): ${msg}`);
          result = this.nextStep();
          continue;
        }
      }
      const provider = bodyHasToolCall(node.body)
        ? makeReplayToolProvider(journal, enginePv ? {
            fallback: enginePv,
            allowCommit: result.step_type === 'commit',   // 第二道 requires_commit 闸的语境判据（与解释器 allowCommit 同源）
            onDirectResult: (r: unknown) => {
              (this.toolJournal[stepIdForJournal] ??= []).push(r);
              this.persistToolJournal();
            },
          } : undefined)
        : ENGINE_NOOP_TOOL_PROVIDER;
      const bodyWarnLog: string[] = [];
      const interp = new BodyInterpreter({
        inputs: result.context?.inputs ?? {},
        toolProvider: provider,
        allowCommit: result.step_type === 'commit',
        workZone: this.getWorkZone(),
        toolCallLog: [],
        warnLog: bodyWarnLog,
        hopEnv: this.hostConfig?.hop_env,   // @a: anc-exec-body-hop-env
        timeJournal: (this.timeJournal[result.step_id] ??= []),   // 持久数组——重放取记录值 // @a: anc-exec-time-builtins
        commandWhitelist: this.hostConfig?.sandbox?.runtime?.available,   // 白名单注入源(缺席=关死) // @a: anc-exec-subprocess-run
        cmdJournal: (this.cmdJournal[result.step_id] ??= []),   // 命令结果重放——不重执行(命令不幂等) // @a: anc-exec-subprocess-run
      });
      let outputs: Record<string, unknown>;
      try {
        outputs = await interp.run(node.body, node.outputs ?? []);
      } catch (e: unknown) {
        if (e instanceof ToolCallPending) {
          this.persistToolJournal();   // 挂起点落盘（journal 未变也保险持久一次 state）
          return {
            status: 'tool_request',
            instance_id: this.instanceId,
            step_id: result.step_id,
            step_type: result.step_type as 'act' | 'commit' | 'check',
            tool: e.tool,
            // args 超阈值 $file 卸载（0040 第 4 条实证:设计 423 行早承诺"超阈值走 $file 卸载协议",
            // 发射点却恒内联——9000 字符探针实测直灌响应。namespace 按步+序号隔离防同名参数
            // 跨调用互踩;caller 侧 $file 消费协议与 inputs/outputs 卸载同一套。// @a: anc-exec-tool-request
            args: this.deflateValues(e.args, `tool_${result.step_id}_${e.seq}`) as Record<string, unknown>,
            tool_call_seq: e.seq,
            output_path: result.work_zone ? join(result.work_zone, `tool_${result.step_id}_${e.seq}.json`) : undefined,
            work_zone: result.work_zone,
          };
        }
        // 直执工具失败——实际到达形态只有 TOOL_EXEC_ERROR（含被 provider 层折包的 WORK_ZONE_ONLY）
        // 与 COMMIT_REQUIRED 两种;正则保留 WORK_ZONE_ONLY 前缀属防御性冗余（2026-09-05 review
        // 双向变异实锤:该前缀恒被包成 TOOL_EXEC_ERROR 到达,非第三条活路径）。与独立模式同款处置:
        // failStep 走升级链（2026-09-05 直执改造引入的新失败形态:改造前 replay provider 从不
        // 真执行工具,body 异常只有计算类经 warnLog 收口;直执后 provider 真失败会到这里,
        // 任其穿透 advanceToCaller=进程级炸,违反"宿主异常出口统一折为步骤 fail"错误模型）。
        // @a: anc-exec-tool-request
        if (e instanceof Error && /^(TOOL_EXEC_ERROR|COMMIT_REQUIRED|WORK_ZONE_ONLY)/.test(e.message)) {
          this.hoplog?.recordWarn(result.step_id, e.message);
          this.failStep(result.step_id, e.message);
          result = this.nextStep();
          continue;
        }
        throw e;
      }
      delete this.toolJournal[result.step_id];   // 本步跑完清 journal（重试重跑工具是预期语义）
      delete this.timeJournal[result.step_id];    // time 同步清（重跑取新时间是预期语义）// @a: anc-exec-time-builtins
      delete this.cmdJournal[result.step_id];     // 命令 journal 同步清（重跑重执行是预期语义）// @a: anc-exec-subprocess-run
      // 计算异常也是 fail（2026-08-09 定稿）：warnLog 非空=body 算错=本步 fail 走升级链
      if (bodyWarnLog.length > 0) {
        for (const w of bodyWarnLog) this.hoplog?.recordWarn(result.step_id, w);
        this.failStep(result.step_id, bodyWarnLog.join('; '));
        result = this.nextStep();
        continue;
      }
      const r = this.completeStep(result.step_id, outputs);
      if (r.status !== 'ok') {
        // 引擎消化 body 的 SCHEMA_MISMATCH → 直接 failStep 走升级链（与独立模式同一语义）：
        // body 是引擎自己执行的确定性产出,交还 caller 重跑得同一不匹配,只能自由文本转述失败——
        // 违反失败记录机器通道。见 design ^anc-exec-advance-to-caller。// @a: anc-exec-advance-to-caller, anc-exec-output-schema-check
        if (r.code === ErrorCode.SCHEMA_MISMATCH) {
          this.failStep(result.step_id, `${r.message}（body 确定性，schema 不匹配不改 prompt 重做，转容器级 retry）`);
          result = this.nextStep();
          continue;
        }
        return result;   // 其余错误（INVALID_STATE 等）→ 停在该步交 caller（不静默吞）
      }
      result = this.nextStep();
    }
    return result;
  }

  // 旧通道 nextParallelBatch/fan-out 已删（P0.5）——统一通道派发见 dispatchParallelSubtask/dispatchParallelCall。

  // 解析一个 parallel child 容器的入参：收集 child 子树（含自身）所有 ← 输入绑定，
  // 从父 scope 自底向上读 source 值。driver 据此启动 worker 子实例 --params。
  // @a: anc-exec-parallel-child-params
  private resolveChildParams(child: StepNode, parentScope: string): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    const declaredInSubtree = new Set<string>();   // 子树内部产出的名字不算外部入参
    for (const node of [child, ...collectDescendants(child)]) {
      for (const o of node.outputs ?? []) declaredInSubtree.add(o.name);
    }
    for (const node of [child, ...collectDescendants(child)]) {
      for (const b of node.inputs ?? []) {
        if (declaredInSubtree.has(b.source)) continue;   // 来自子树内部步骤，非外部入参
        const val = this.variables.read(b.source, parentScope);
        if (val !== undefined) params[b.source] = val;
      }
    }
    return params;
  }

  // 旧通道 fanoutSchedule 顾问已删（P0.5）——名额窗口见 hasFreeSlot/inflight。

  // 旧通道 joinParallel/isChildTerminal/buildWorkerLaunchCommand 已删（P0.5）——
  // 收割合并见 reapParallelCall/reapParallelSubtask + settleHostAfterReap。

  // caller 介入点判定（引擎语义，唯一权威）：reason/check 需推理、confirm 需决策、
  // 含工具调用的 act/commit 需 caller 工具。其余（纯计算 body、容器推进）引擎自消化。
  // 见设计 ^anc-exec-advance-to-caller。
  // 找 tool_request 挂起中的步骤（running 的含 body act/commit），重建其 step_ready 视图
  // 供消化循环续跑重放。顺序执行下至多一个。// @a: anc-exec-tool-request
  private findSuspendedBodyStep(): NextResponse | null {
    for (const [stepId, st] of this.stepStates) {
      if (st !== 'running') continue;
      const node = this.findStepById(stepId);
      if (!node || (node.step_type !== 'act' && node.step_type !== 'commit' && node.step_type !== 'check')) continue;
      if (!(node as ActStep | CommitStep | CheckStep).body) continue;   // check body:anc-step-check-body
      // 轻量视图：消化循环只消费 step_id/step_type/context.inputs/work_zone——
      // 不重跑 PromptAssembler（挂起步不再需要 LLM prompt）、不重记 hoplog start（首次已记）。
      const workZone = this.getWorkZone();
      return {
        status: 'step_ready' as const,
        instance_id: this.instanceId,
        step_id: stepId,
        step_type: node.step_type as ExecutableStepType,
        summary: node.summary,
        context: { inputs: this.resolveRawInputs(node) } as StepReady['context'],
        work_zone: workZone,
        output_path: join(workZone, `out_${stepId}.json`),
      };
    }
    return null;
  }

  private isCallerActionPoint(stepId: string): boolean {
    const node = this.findStepById(stepId);
    if (!node) return true;   // 未知步骤交 caller 兜底
    if (node.step_type === 'reason' || node.step_type === 'confirm' || node.step_type === 'ask') {
      return true;
    }
    if (node.step_type === 'check') {
      // 带 body 的 check 归引擎消化（纯机械判定零 LLM,2026-08-19 作者拍板 A）;无 body 照旧 LLM 判。
      // @a: anc-step-check-body
      return !(node as CheckStep).body;
    }
    if (node.step_type === 'act' || node.step_type === 'commit') {
      const body = (node as ActStep | CommitStep).body;
      // 仅无 body（自然语言指令）整步交 caller；有 body 一律引擎解释——含工具的经
      // tool_request 单工具介入（概念层原则 6 收紧 2026-08-04）。// @a: anc-exec-tool-request
      return !body;
    }
    return false;   // 其余（控制流/容器）非 caller 介入点
  }

  // call 步骤完成：读子实例输出，按 output_mapping（子output→父var）回填父 call 步骤的 +→ // @a: anc-step-call
  // engine 侧 Inputs 自动映射：param_mapping 的取值方一律是引擎（映射语义不散落各载体 driver）。
  // 有映射项按 from=父变量→to=子 Input 取；无映射项按同名取；父值缺失（声明未产出）不注入——
  // 子 Inputs 缺省语义接管，子 init 必填缺失即拒。两模式共用（独立模式 executeCall /
  // 复用模式 CLI init --parent 自动 merge）。见 design/exec-engine.md ^anc-exec-call-auto-map。
  // @a: anc-exec-call-auto-map
  resolveCallParams(callStepId: string): Record<string, unknown> {
    const step = this.findStepById(callStepId);
    if (!step || step.step_type !== 'call') return {};
    const call = step as CallStep;
    const parentVars = this.variables.getAllVariables();
    const params: Record<string, unknown> = {};
    for (const m of call.param_mapping ?? []) {
      // 字面量项直传（2026-08-27 0044——原实装只走变量分支,`"seq"` 被当不存在的父变量静默丢弃,
      // 子实例拿 None）。// @a: anc-step-call-literal
      if ('literal_value' in m) { params[m.to] = m.literal_value; continue; }
      if (m.from in parentVars && parentVars[m.from] !== undefined) {
        params[m.to] = parentVars[m.from];
      } else {
        // 悬空来源 warn 落账（2026-09-01 补——原纯静默,dr21 十六撞:点路径 from 查不到被无声
        // 跳过,5/5 子实例拿 undefined 全灭后账面无痕;点路径写法本身已由 V12 静态拒,本 warn 兜
        // 静态拦不住的悬空 from）。// @a: anc-exec-call-auto-map
        this.hoplog?.recordWarn(callStepId, `[call-param] 映射来源 '${m.from}' 在父变量空间不存在——该参数未注入子实例（整名变量才可映射,字段路径不解析）`);
      }
    }
    return params;
  }

  // callee 位插值求值（^anc-step-call-dynamic-callee 三消费点之三——复用模式命令占位拼装）：
  // 静态 Id 直返;插值经 evalExprSync 按引擎变量空间求值,结果须非空字符串。求值失败返回 null——
  // 调用方按该处既有错误形态处置（不拼该命令载荷）,决不让 {表达式} 原文漏进命令。
  // @a: anc-step-call-dynamic-callee
  private resolveCalleeToken(step: CallStep): string | null {
    if (step.callee_spec_id?.trim()) return step.callee_spec_id;
    if (!step.callee_expr) return null;
    try {
      const v = evalExprSync(step.callee_expr, name => this.variables.read(name, getWriteScope(step.step_id, this.spec!)));
      if (typeof v === 'string' && v.trim() !== '') return v;
      this.hoplog?.recordWarn(step.step_id, `[call-callee] 插值表达式 {${step.callee_expr_src ?? ''}} 求值结果非字符串（typeof=${typeof v}）——callee 占位无法拼装,该命令载荷缺席`);
      return null;
    } catch (e: unknown) {
      this.hoplog?.recordWarn(step.step_id, `[call-callee] 插值表达式 {${step.callee_expr_src ?? ''}} 求值异常: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  // 输出映射单点（completeCallStep 与独立模式 executeCall 共用）：按 output_mapping 把子实例
  // 输出搬到父变量；无映射则同名透传 call 步骤声明的 +→ 输出。// @a: anc-step-call
  mapCallOutputs(callStepId: string, childVars: Record<string, unknown>): Record<string, unknown> {
    const step = this.findStepById(callStepId);
    if (!step || step.step_type !== 'call') return {};
    const call = step as CallStep;
    const mapped: Record<string, unknown> = {};
    // call 边界围栏恢复（BUG-D,2026-08-13 hopkb 级二实撞——同族最后一处）：子实例输出声明宽松
    // 标量（yaml 过检查,恢复阶梯在子端不触发）时,围栏串跨边界原样漂进父空间——reapParallelCall
    // 喂 collect 不经 completeStep 零恢复,级二 outcomes 收集全丢。逐值经 recoverFencedValue
    // （剥围栏→YAML 解析→按来源键剥单键嵌套;无围栏/解不出原样,幂等）;completeCallStep 路径
    // 经 completeStep 二次覆盖无害。// @a: anc-exec-output-fence-recovery
    // 映射来源缺键=响亮失败（BUG-G:undefined 静默流出经 JSON 变 null 入 collect——"null 元素
    // 两头不靠",部分失败语义是列表变短非 null 占位）。缺键≠null 值:子真产出 None 照常传递。
    // @a: anc-exec-output-fence-recovery
    const requireKey = (from: string): unknown => {
      if (!(from in childVars)) {
        throw new Error(`CALL_OUTPUT_MISSING: 子实例输出无键 '${from}'——映射写错或子 spec 输出面改版。子实例实有键: ${Object.keys(childVars).join(', ') || '(空)'}`);
      }
      return childVars[from];
    };
    if (call.output_mapping && call.output_mapping.length > 0) {
      for (const m of call.output_mapping) {
        mapped[m.to] = recoverFencedValue(requireKey(m.from), m.from);  // 父变量 m.to ← 子输出 m.from
      }
    } else {
      for (const decl of step.outputs ?? []) {
        mapped[decl.name] = recoverFencedValue(requireKey(decl.name), decl.name);
      }
    }
    return mapped;
  }

  completeCallStep(callStepId: string, childVars: Record<string, unknown>): CommandResponse {
    const step = this.findStepById(callStepId);
    if (!step || step.step_type !== 'call') {
      return { status: 'error', code: ErrorCode.INVALID_STEP_ID, message: `Step '${callStepId}' is not a call step` };
    }
    const mapped = this.mapCallOutputs(callStepId, childVars);
    // 同步退化的 call parallel（配 1 无在飞记账）：值先喂 __reaped_ 缓冲再 completeStep——
    // 收集点单一（轮末传送带对异步单项恒跳过）；顺序关键：末轮 completeStep 会级联 finalize
    // 合并缓冲，后喂则末轮值丢失。// @a: anc-exec-parallel-reap-drain
    if ((step as CallStep).parallel && !this.inflight.some(f => f.step_id === callStepId)) {
      // 串行退化同走续链投递（^anc-exec-parallel-reap-chain——旧形态 host 非 loop 零喂送,
      // 隔壳串行驱动下产物同样静默蒸发;调度形态不得改变执行语义〔B 裁决〕,两形态同一条链）。
      const loopAncestor = this.findLoopAncestorId(callStepId);
      const iter = (loopAncestor ? this.loopCounters.get(loopAncestor) : undefined) ?? 1;
      this.deliverReapedOutputsAlongChain(callStepId, iter, mapped);
    }
    return this.completeStep(callStepId, mapped);
  }

  // ===== 统一模型：call parallel 派发/收割/收齐/杀活（P0 独立模式）=====
  // 见 design/parallel-execution.md §U2/§U3/§U4 / 概念 ^anc-exec-gather。

  // 在飞判定（收齐门回调）：loopStepId 子树域内是否仍有 status=inflight 的活。
  // killed 不算在飞（已清场）。// @a: anc-exec-parallel-inflight
  hasInflightFor(loopStepId: string): boolean {
    // 收齐门数 inflight+paused（U4b:等人的活没完,容器不许闭合——paused 只让并发名额
    // 〔hasFreeSlot 只数 inflight〕,不让收齐门）。// @a: anc-exec-parallel-hitl-queue
    return this.inflight.some(f => (f.status === 'inflight' || f.status === 'paused')
      && (f.host_container === loopStepId || f.host_container.startsWith(loopStepId + '.')));
  }

  // 子实例 HITL 队列账面转换（U4b ^anc-exec-parallel-hitl-queue,0013）：
  // paused=让名额等人;resumed=二次占名额续跑。幂等（不在账/已终态零动作）。
  markInflightPaused(childInstance: string): void {   // @a: anc-exec-parallel-hitl-queue
    const f = this.inflight.find(x => x.child_instance === childInstance);
    if (f && f.status === 'inflight') { f.status = 'paused'; this.persist(); }
  }
  markInflightResumed(childInstance: string): void {   // @a: anc-exec-parallel-hitl-queue
    const f = this.inflight.find(x => x.child_instance === childInstance);
    if (f && f.status === 'paused') { f.status = 'inflight'; this.persist(); }
  }

  getInflight(): readonly InflightCall[] { return this.inflight; }

  // 名额判定：主线自算一路（作者定 2026-08-10）——配置 N = 主线 1 + 最多 N−1 在飞；
  // 配 1 = 派不出任何活，call parallel 退化为同步执行（全串行口子）。// @a: anc-exec-parallel-inflight
  hasFreeSlot(): boolean {
    this.sweepTimedOutInflight();   // 惰性超时收割（P1 §U3）——名额检查即活性检查点
    const total = this.hostConfig?.resource_limits?.max_concurrent_workers ?? this.maxConcurrent ?? 5;
    return this.inflight.filter(f => f.status === 'inflight').length < total - 1;
  }

  setUnifiedDispatch(v: boolean): void { this.unifiedDispatch = v; }   // @a: anc-exec-parallel-dispatch-model

  // subtask parallel 派发入账（P0.5，与 call 派发共用 inflight/名额/收齐/杀活）：
  // 子实例=同 spec 子树收窄（parallel/<step>.<iter>/），入参=resolveChildParams 快照。
  // 本步标 done（派发即推进 §U5），收割时兄弟位输出直写扁平命名空间/loop 体内进 collect 缓冲。
  // @a: anc-exec-parallel-dispatch-model
  // 派发即入账+幂等守卫=现行不丢防重承载（§10g 现行形态,fanout 顾问通道已退役——0086 批挂标）// @a: anc-exec-parallel-fanout-concurrency
  dispatchParallelSubtask(stepId: string): { childInstance: string; iter: number; hostContainer: string; params: Record<string, unknown> } {
    const hostContainer = this.findHostContainerId(stepId);
    // 迭代号沿祖先链找 loop 计数器（^anc-exec-parallel-reap-chain,与 dispatchParallelCall 同修——
    // 旧取法只认最近容器,隔壳形态壳无循环计数恒 1 撞名互覆〔阅卷 D2 探针实证〕;兄弟位无 loop
    // 祖先恒 1 合法——每 subtask 步骤号唯一）。
    const loopAncestorS = this.findLoopAncestorId(stepId);
    const iter = loopAncestorS ? (this.loopCounters.get(loopAncestorS) ?? 1) : 1;
    const childInstance = `${stepId}.${iter}`;
    // 防重只认在飞——killed 尸账在重派发时清掉（边界 retry 新轮次合法重用同 childInstance;
    // 2026-08-13 实撞:收割即 fail 后 retry 重派撞 killed 尸账提前返回,早返回路径不置 done,
    // nextStep 永吐 dispatch_ready 死循环）。迟到收割的 killed 短路语义不变（reap 按引用早返回
    // 只对仍在账的 killed 生效,清账后迟到者 findIndex<0 直接丢弃——同一终局）。
    const dupIdx = this.inflight.findIndex(f => f.child_instance === childInstance);
    if (dupIdx >= 0) {
      if (this.inflight[dupIdx].status === 'inflight') {
        const node0 = this.findStepById(stepId)!;
        return { childInstance, iter, hostContainer, params: this.resolveChildParams(node0, getWriteScope(stepId, this.spec!)) };
      }
      this.inflight.splice(dupIdx, 1);   // killed 尸账让位新轮次
    }
    const node = this.findStepById(stepId)!;
    const params = this.resolveChildParams(node, getWriteScope(stepId, this.spec!));   // 派发时快照
    // params_for_child 落盘（hopissues/0020——writeChildParams 自实装起 dead import 从未被调,
    // worker init readChildParams 恒 null 即 MISSING_INPUT,设计『driver 无需透传 --params』契约
    // 全线落空;parallel-execution.md :635 落盘条款实装）。// @a: anc-exec-parallel-child-params
    if (this.instanceDir) writeChildParams(this.instanceDir, childInstance, params);
    this.inflight.push({ step_id: stepId, iter, child_instance: childInstance, host_container: hostContainer, dispatched_at: timestamp(), status: 'inflight', params });   // params 快照落账（stale_launch 重拼源）
    this.recordEvent(stepId, 'parallel_dispatch', childInstance);
    this.hoplog?.recordParallelDispatch(hostContainer, childInstance, '');
    this.stepStates.set(stepId, 'done');   // 派发即推进（结果收割另账）
    for (const d of collectDescendants(node)) {
      if (this.stepStates.get(d.step_id) === 'pending') this.stepStates.set(d.step_id, 'skipped');   // 子树归子实例执行，父账不再推进
    }
    this.propagateAndRecord(stepId);
    this.persist();
    return { childInstance, iter, hostContainer, params };
  }

  // subtask parallel 收割（与 reapParallelCall 对偶）：成功取子实例声明输出——loop 体内进
  // collect 缓冲按 iter 序，兄弟位直写扁平命名空间 root（收齐门保证消费者在容器边界后）。
  // @a: anc-exec-parallel-reap-drain
  reapParallelSubtask(childInstance: string, outcome: { vars?: Record<string, unknown>; failure?: ReturnType<ExecutionEngine['exportFailState']>; committed?: boolean }): void {
    const idx = this.inflight.findIndex(f => f.child_instance === childInstance);
    if (idx < 0) return;
    const entry = this.inflight[idx];
    // 退火传播先于 killed 早返回（三形态全传播——强杀 child 内 commit 同样已发生）。
    // // @a: anc-exec-commit-anneal
    // 快照用派发时刻轮次（review B1-1——收割异步,渐进派发下宿主 loop 可能已推进;
    // entry.iter 是派发时刻真值,宿主 loop 之外的祖先 loop 轮次在子实例在飞期不会推进）
    if (outcome.committed) this.markCommitted(entry.step_id, { ...this.ancestorLoopIters(entry.step_id), ...(entry.host_container ? { [entry.host_container]: entry.iter } : {}) });
    if (entry.status === 'killed') return;
    this.inflight.splice(idx, 1);
    const node = this.findStepById(entry.step_id);
    const host = this.findStepById(entry.host_container);
    if (node && !outcome.failure && outcome.vars) {
      const declared = new Set((node.outputs ?? []).map(o => o.name));
      // 收割喂缓冲的 loop 沿祖先链找（^anc-exec-parallel-reap-chain,与 call 侧同修——旧取
      // host 判 loop,隔壳形态 host=壳非 loop 零喂送产物静默蒸发〔阅卷 D2 探针实证〕。壳边界
      // 产出形态走待喂账,与 call 侧同机制:收割写值+标 done+传播,壳完结时级联内兑现）。
      const loopAncestorR = this.findLoopAncestorId(entry.step_id);
      const hostLoop = (loopAncestorR ? this.findStepById(loopAncestorR) : (host?.step_type === 'loop' ? host : null)) as LoopStep | null;
      const collectUnits = new Map((hostLoop?.collect ?? []).map(p => [p.unitVar, p.listVar]));
      const feedLoopId = loopAncestorR ?? entry.host_container;
      // subtask 收割围栏恢复+边界归一（BUG-D 同族第 4/5 处,review 抓漏 2026-08-13）：收割直写不经
      // completeStep——①子端宽松标量声明下围栏串跨边界,按标注步骤 outputs 声明过带声明档阶梯;
      // ②数字串/'true' 跨边界破"变量空间不存跨类型值"不变量（2026-08-11 等值严格化前提,下游算术
      // 计算异常）,recover 后接 coerce 与 completeStep 同序。// @a: anc-exec-output-fence-recovery, anc-exec-output-coerce
      outcome.vars = normalizeOutputsToFixpoint(node.outputs ?? [], outcome.vars, this.spec?.header.types);
      const isShellForm = loopAncestorR !== null && entry.host_container !== loopAncestorR;   // 隔壳:最近容器≠loop 祖先
      for (const name of declared) {
        if (!(name in outcome.vars)) continue;
        const listVar = collectUnits.get(name);
        if (listVar) {
          const key = `__reaped_${listVar}`;
          const buf = (this.variables.readLocal(key, feedLoopId) as [number, unknown][] | null) ?? [];
          buf.push([entry.iter, outcome.vars[name]]);
          this.variables.write(key, buf, feedLoopId);
        } else if (!isShellForm) {
          this.variables.write(name, outcome.vars[name], 'root');   // 兄弟位：声明输出直写扁平命名空间
        } else {
          this.variables.write(name, outcome.vars[name], getParentStepId(entry.step_id) ?? 'root');   // 隔壳:值写壳作用域,壳完结经边界提升
        }
      }
      // 隔壳形态补完成传播（壳完结边界聚合;壳边界声明的被收集变量走待喂账在级联内兑现——
      // 与 call 侧 deliverReapedOutputsAlongChain 同机制同次序:喂账先记再传播）
      if (isShellForm && hostLoop) {
        const asyncUnitsS = getAsyncUnitVars(hostLoop);
        for (const pair of hostLoop.collect ?? []) {
          if ((outcome.vars ?? {})[pair.unitVar] !== undefined) continue;   // 已直喂
          if (!asyncUnitsS.has(pair.unitVar)) continue;   // 串行兄弟产的对归轮末传送带,不记（复阅实抓双重喂送）
          const shell = this.findStepById(entry.host_container);
          const declares = shell ? (shell.outputs ?? []).some(o => o.name === pair.unitVar) : false;
          if (declares) this.pendingChainFeeds.push({ chain_child_id: entry.host_container, loop_id: feedLoopId, iter: entry.iter, unit_var: pair.unitVar, list_var: pair.listVar });
        }
        this.propagateAndRecord(entry.step_id);
      }
      this.recordEvent(entry.step_id, 'parallel_reap', `${childInstance} ok`);
      this.hoplog?.recordParallelReap(entry.host_container, childInstance, 'completed');   // @a: anc-exec-parallel-reap-log, anc-obs-parallel-reap
    } else if (outcome.failure) {
      const failedStepId = Object.keys(outcome.failure.stepStates).find(id => outcome.failure!.stepStates[id] === 'failed');
      const kernel = (failedStepId ? outcome.failure.stepFailReasons[failedStepId] : undefined)
        ?? { reason: 'child failed', fail_kind: 'error' as FailKind };
      this.recordEvent(entry.step_id, 'parallel_reap', `${childInstance} failed: ${kernel.reason}`);
      this.hoplog?.recordParallelReap(entry.host_container, childInstance, 'failed');   // @a: anc-exec-parallel-reap-log, anc-obs-parallel-reap
      // 失败分两形态（2026-08-13 作者定"收割即 fail"——具名输出无部分可言,值空间零形态）:
      // loop collect 位=部分失败集合语义（不贡献元素,列表变短——作者选集合语义时显式接受）;
      // 兄弟位具名输出=收割即边界步 fail：杀域内其余在飞（兄弟活随边界重跑,跑完白烧）→
      // 走边界 retry/升级链。原"warn 不贡献输出"对兄弟位作废——None 静默流下游比崩溃更隐蔽。
      const hostIsLoop = host?.step_type === 'loop';
      if (hostIsLoop) {
        this.hoplog?.recordWarn(entry.host_container, `subtask parallel 子实例 ${childInstance} 失败（collect 不贡献元素）: ${kernel.reason}`);   // 挂宿主容器——标注步骤在父账无 start,挂步骤 id 成 orphan 行（0018）
      } else {
        this.killInflight(entry.host_container);
        this.stepStates.set(entry.step_id, 'failed');
        this.stepFailReasons.set(entry.step_id, { reason: `parallel 子实例 ${childInstance} 失败: ${kernel.reason}`, fail_kind: kernel.fail_kind });
        this.handleFailStepRetry(entry.step_id, kernel.reason);
      }
    }
    this.settleHostAfterReap(entry.host_container);
    this.persist();
  }

  // 收割后宿主容器终态化检查（call/subtask 两收割路径共用）：主线走完 ∧ 在飞排空 → settle。
  // loop：finalize collect 缓冲；普通容器：children 全终态即随 propagate 正常提升。
  // @a: anc-exec-parallel-reap-drain
  private settleHostAfterReap(hostId: string): void {
    if (this.hasInflightFor(hostId)) return;
    const host = this.findStepById(hostId);
    if (!host || this.stepStates.get(hostId) !== 'running') return;
    const children = getChildren(host);
    const allTerminal = children.every(c => {
      const st = this.stepStates.get(c.step_id);
      return st === 'done' || st === 'failed' || st === 'skipped';
    });
    if (!allTerminal) return;
    if (host.step_type === 'loop') {
      finalizeForEachCollect(host as LoopStep, this.buildTraversalStateForDrain());
      // 全灭 warn（2026-09-01 补,可见性不改行为——集合语义"列表变短"的极端形态是空表,
      // 5/5 全灭与 0 派发在账面上原不可分辨,dr21 十六撞 launch_receipts=[] 静默收编步 27
      // 照记 done。派发数=for-each 输入列表长度,收集数=收口后 listVar 长度）。
      // @a: anc-exec-parallel-reap-log
      const fe = getForEach(host);
      const collects = getCollectPairs(host as LoopStep);
      if (fe && collects.length > 0) {
        const srcList = this.variables.getAllVariables()[fe.listVar];
        const dispatched = Array.isArray(srcList) ? srcList.length : 0;
        for (const c of collects) {
          const collected = this.variables.getAllVariables()[c.listVar];
          const n = Array.isArray(collected) ? collected.length : 0;
          if (dispatched > 0 && n === 0) {
            // 全灭升 fail（2026-09-06 作者令"现在修"——dv-batch 七子实例全灭主线照 completed
            // 空 reports 实撞。概念 :696 澄清:全灭不属部分失败例外——集合语义容忍"少几个"
            // 不容忍"一个没有",空列表放行=全部失败伪装成功,违背无第三态铁律。warn 保留作
            // 观测轨迹（reap-log 契约演进句）,处置=宿主 loop failStep 走既有升级链——祖先
            // retry 整组重跑即重派发,顶层无人接=实例 failed 诚实终态,祖先 on fail 照激活
            // 语义接住善后（兜底步有 ^anc-exec-onfail-context 失败上下文可引）。
            // // @a: anc-exec-parallel-allfail
            this.hoplog?.recordWarn(hostId, `[collect] 派发 ${dispatched} 全部失败,收集列表 '${c.listVar}' 为空——按全灭升 fail 处置`);
            const kernels = (this.execEvents ?? []).filter(ev => ev.event === 'parallel_reap' && (ev.step_id === hostId || ev.step_id.startsWith(hostId + '.')) && (ev.detail ?? '').includes('failed'))
              .map(ev => (ev.detail ?? '').slice(0, 200));
            this.failStep(hostId, `PARALLEL_ALL_FAILED: 派发 ${dispatched} 全部失败,收集列表 '${c.listVar}' 为空——全灭不属部分失败集合语义,按 fail 处置。子实例失败摘要: ${kernels.join(' | ') || '(收割事件无失败明细)'}`);
            return;
          }
        }
      }
    }
    this.stepStates.set(hostId, 'done');
    this.hoplog?.recordParallelSettle(hostId);   // 收齐入轨（P1 §U3）// @a: anc-exec-parallel-reap-log, anc-obs-parallel-reap
    this.hoplog?.recordStepDone(hostId);
    this.propagateAndRecord(hostId);
  }

  // 复用模式 worker 启动命令（§U8）：引擎持有 cli/spec 路径才拼（独立模式/内存实例缺省 undefined）。
  // 路径全双引号包裹（含空格路径防拆参,^anc-string-escape shell 通道）。// @a: anc-exec-parallel-reuse-protocol
  private buildDispatchLaunchCommand(kind: 'subtask' | 'call', stepId: string, childInstance: string, params: Record<string, unknown>, callee?: string): string | undefined {
    if (!this.cliAbsPath || !this.specPath) return undefined;   // 复用模式 CLI run 才注入两路径
    const stateDir = this.instanceDir ? dirname(this.instanceDir) : '.hopstate';
    // hop_env 随派发透传（环境参数对子实例同义——worker/call 子进程各自组合根摘出重建同一张表;
    // 业务 params 优先,防环境键覆盖业务同名——命名空间保留下不可能,防御写法）。// @a: anc-config-hop-env
    if (this.hostConfig?.hop_env) params = { ...this.hostConfig.hop_env, ...params };
    const paramsJson = JSON.stringify(JSON.stringify(params));   // shell 单参双层引：外层 JSON.stringify 加引号+转义
    // 卫星日志约定（^anc-obs-parallel-child-satellite）：worker 日志归父 run 目录
    // parallel/<ci>/log（call→calls/<ci>/log）——缺省会各开顶层 run 目录破坏约定
    //（2026-08-11 真机 audit 实撞：断言找不到 worker 子日志）。
    const parentRunDir = this.hoplog?.getRunDir();
    // 级别继承：父 debug 时 worker 也 debug——知识注入证据（doc-ref 切片）在 worker prompt，
    // info 级不入轨则审计核验断链（2026-08-11 真机 audit 二轮实撞）。
    const levelArg = this.hoplog?.getLevel() === 'debug' ? ' --log-level debug' : '';
    const logArg = (parentRunDir ? ` --log-dir "${join(parentRunDir, kind === 'subtask' ? 'parallel' : 'calls', childInstance, 'log')}"` : '') + levelArg;
    if (kind === 'subtask') {
      // 同 spec 子树收窄 worker：init 沿用 --parallel-parent/--parallel-child 通道（目录 parallel/<ci>/）
      return `node "${this.cliAbsPath}" --json run "${this.specPath}" --parallel-parent ${this.instanceId} --parallel-child ${childInstance} --params ${paramsJson} --state-dir "${stateDir}"${logArg}`;
    }
    // call：callee spec 由 driver 按名解析（复用模式寻址归 caller——SpecProvider 是独立模式件），
    // 命令给 init 骨架，<CALLEE_SPEC_PATH> 占位由 driver 填
    return `node "${this.cliAbsPath}" --json run "<CALLEE_SPEC_PATH:${callee}>" --call-parent ${this.instanceId} --call-step ${childInstance} --params ${paramsJson} --state-dir "${stateDir}"${logArg}`;
  }

  // call 协议载荷（^anc-exec-call-protocol-payload,2026-08-14 立项）：普通 call 的 step_ready
  // 附引擎拼好的 init/两回报命令——driver 照抄零手拼,消除"手拼 init 参数"误用面（cc:call-fail
  // 实撞根治,与 dispatch_ready launch_command 同一纪律）。复用模式 CLI 通道才拼得出
  //（cliAbsPath+specPath）;独立模式 call 走 dispatcher 进程内递归不消费。// @a: anc-exec-call-protocol-payload
  // call 边界上游反馈载荷公共体（D41）：inherited（祖辈反馈原样续传）+ prior 历史行
  // （单条 4000 clip——切行丢意见正文,体量靠 5 条封顶控制）+ 当前打回意见（零截断,
  // 子层作业的完整依据）,拼后 24000 chars 尾部截留（最近反馈优先存活——护栏防深递归
  // 逐层拼接无界增长）。standalone（dispatcher 进程内递归）与复用模式（init_command
  // --upstream-feedback 参数）同经本体,两模式载荷同构不许各写判法。
  // @a: anc-exec-l2c-retry-feedback
  buildUpstreamFeedbackPayload(callStepId: string): string | undefined {
    const clip = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s;
    const parts: string[] = [];
    if (this.upstreamFeedback) parts.push(this.upstreamFeedback);
    const fb = this.getActiveRetryFeedback(callStepId);
    if (fb) {
      const prior = fb.prior?.length ? fb.prior.map(p => clip(p, 4000)).join('\n') + '\n' : '';
      parts.push(`${prior}第 ${fb.attempt} 次打回：${fb.reason}`);
    }
    if (parts.length === 0) return undefined;
    const joined = parts.join('\n——\n');
    return joined.length > 24000 ? joined.slice(joined.length - 24000) : joined;   // 尾部截留:最近反馈优先存活
  }

  private buildCallProtocol(step: CallStep): { init_command: string; child_state_dir: string; child_instance: string; child_advance: string; report_completed: string; report_failed: string } | undefined {
    if (!this.cliAbsPath || !this.specPath) return undefined;
    const stateDir = this.instanceDir ? dirname(this.instanceDir) : '.hopstate';
    const childInstance = step.step_id;   // 协议 A 子实例 ID=call step id（确定性,init --parent 落 calls/<step>/）
    // params=引擎 auto-map 快照（取值方一律引擎 ^anc-exec-call-auto-map）+hop_env 透传（同派发纪律）
    let params = this.resolveCallParams(step.step_id);
    if (this.hostConfig?.hop_env) params = { ...this.hostConfig.hop_env, ...params };
    const paramsJson = JSON.stringify(JSON.stringify(params));
    // 插值形态先求值再进占位（^anc-step-call-dynamic-callee）——求值不出即不拼协议载荷
    // （与 cliAbsPath 缺席同款返回 undefined 形态）,决不让 {表达式} 原文漏进命令。// @a: anc-step-call-dynamic-callee
    const callee = this.resolveCalleeToken(step);
    if (callee === null) return undefined;
    // 卫星日志与级别继承同 buildDispatchLaunchCommand（子实例日志归父 run 目录 calls/<ci>/log）
    const parentRunDir = this.hoplog?.getRunDir();
    const levelArg = this.hoplog?.getLevel() === 'debug' ? ' --log-level debug' : '';
    const logArg = (parentRunDir ? ` --log-dir "${join(parentRunDir, 'calls', childInstance, 'log')}"` : '') + levelArg;
    const base = `node "${this.cliAbsPath}" --json`;
    const childStateDir = join(stateDir, this.instanceId, 'calls');
    // H2 复用半边（D41——2026-08-31 作者拍 A 案）:重跑轮把父层反馈拼进 init_command,
    // CLI init 转 EngineOptions.upstreamFeedback 汇入 standalone 同一注入口。协议命令是
    // 吐 step_ready 时现拼——每次到该步都重拼,重跑轮自然带当轮反馈。转义同 params 先例。
    // 载荷经 buildUpstreamFeedbackPayload 公共体拼装——与 standalone 同构（含 prior 历史行
    // 与 24000 尾部截留;初版只拼当轮 reason,callee 看不到此前打回史,review 面二抓分叉后归一）。
    // @a: anc-exec-l2c-retry-feedback
    const combined = this.buildUpstreamFeedbackPayload(step.step_id);
    const fbArg = combined ? ` --upstream-feedback ${JSON.stringify(JSON.stringify(combined))}` : '';
    return {
      init_command: `${base} init "<CALLEE_SPEC_PATH:${callee}>" --parent ${this.instanceId} --step ${step.step_id} --params ${paramsJson}${fbArg} --state-dir "${stateDir}" --trace ${this.instanceId}${logArg}`,
      child_state_dir: childStateDir,
      child_instance: childInstance,
      // 循环起步命令（cc:call 真机实撞:init 建的子实例是"新建未推进"态,skill 说"走标准循环"
      // 没说怎么起步——driver 读了 8 轮 CLI 源码反推 advance,侧查顶过超时线。照抄纪律补齐）。
      child_advance: `${base} advance --state-dir "${childStateDir}" --instance ${childInstance}`,
      report_completed: `${base} submit_and_fetch_next ${step.step_id} --child-instance ${childInstance} --state-dir "${stateDir}" --instance ${this.instanceId}`,
      report_failed: `${base} submit_and_fetch_next ${step.step_id} --failure-child ${childInstance} --state-dir "${stateDir}" --instance ${this.instanceId}`,
    };
  }

  // 单活超时惰性判定（P1 §U3）：按 dispatched_at 判超时项收割腾名额（缺省不配置=永不超时）。
  // 复用模式语义差（设计如实声明）：引擎无法主动打断外部会话，只在被调用时按账判——
  // 迟到结果 reap 撞已收割账幂等丢弃。// @a: anc-exec-parallel-timeout
  sweepTimedOutInflight(): string[] {
    const timeoutSec = this.hostConfig?.resource_limits?.parallel_child_timeout_seconds;
    if (!timeoutSec || timeoutSec <= 0) return [];
    const now = Date.now();
    const out: string[] = [];
    for (const entry of [...this.inflight]) {
      if (entry.status !== 'inflight') continue;
      const age = (now - new Date(entry.dispatched_at).getTime()) / 1000;
      if (age <= timeoutSec) continue;
      // 启动窗口让位（§U3）：目录未建谈不上 running 卡死——宽限期内归 U2 启动窗口管，
      // 不判超时（timeout<grace 配置下否则误杀启动中的活）。// @a: anc-exec-parallel-timeout
      if (age <= DISPATCH_GRACE_SECONDS) {
        const node0 = this.findStepById(entry.step_id);
        const isCall0 = node0?.step_type === 'call';
        const instDir0 = this.instanceDir;
        if (instDir0 && !stateExists(join(instDir0, isCall0 ? 'calls' : 'parallel', entry.child_instance))) continue;
      }
      const node = this.findStepById(entry.step_id);
      const failure = { specId: this.spec?.header.id ?? 'child', childInstanceId: entry.child_instance,
        stepFailReasons: { timeout: { reason: `timeout: 在飞 ${Math.round(age)}s 超上限 ${timeoutSec}s（parallel_child_timeout_seconds 活性检测）`, fail_kind: 'error' as FailKind } },
        stepStates: { timeout: 'failed' } };
      if (node?.step_type === 'call') this.reapParallelCall(entry.child_instance, { failure });
      else this.reapParallelSubtask(entry.child_instance, { failure });
      out.push(entry.child_instance);
    }
    return out;
  }

  // crash-resume 在飞对账（P1 §U2）：load/resume 后对每笔在飞账读子实例状态判终态——
  // 已终态未收割→补收割（值在盘上纯捡账）；目录不存在→判 failed 收割（dispatch-lost，不留悬账）；
  // 未终态→留账交调用方重建（独立模式重起子 Dispatcher/复用模式 stale 清单交 driver）。
  // killed 恒不复活。两真值源（账面+子实例状态）都已落盘，对账纯读合并零新状态。
  // @a: anc-exec-parallel-inflight-reconcile
  private lastStale: string[] = [];   // 对账后未终态清单——drain_wait 载荷透传（§U2 stale 字段）

  // stale_launch：为在飞 stale 项按账面重拼 launch_command（step_id/iter 在账,params 现算——
  // driver 对"没起过"的项原样执行零手拼,与 dispatch_ready 同纪律;launch_command 不落盘无从重取,
  // review 抓缝 2026-08-13）。// @a: anc-exec-parallel-inflight-reconcile
  private buildStaleLaunch(staleIds: string[]): Record<string, string> | undefined {
    const map: Record<string, string> = {};
    for (const ci of staleIds) {
      const entry = this.inflight.find(f => f.child_instance === ci && f.status === 'inflight');
      if (!entry) continue;
      const node = this.findStepById(entry.step_id);
      if (!node) continue;
      const isCall = node.step_type === 'call';
      // 账面快照优先（loop 推进后 itemVar 现值≠派发时值,现算必错——实测 [21,21]）;老账无快照才现算兜底
      const params = entry.params ?? this.resolveChildParams(node, getWriteScope(entry.step_id, this.spec!));
      const cmd = this.buildDispatchLaunchCommand(isCall ? 'call' : 'subtask', entry.step_id, ci, params,
        isCall ? this.resolveCalleeToken(node as CallStep) ?? '' : undefined);   // 插值形态同款求值（^anc-step-call-dynamic-callee）
      if (cmd) map[ci] = cmd;
    }
    return Object.keys(map).length ? map : undefined;
  }

  reconcileInflight(opts?: { dispatchLostPolicy?: 'fail' | 'stale' }): { reaped: string[]; stale: string[] } {
    // dispatch-lost 处置两模式分道（2026-08-13 作者批准,真机二撞：主 agent 收到 dispatch_ready 后
    // 合法耗时 67s 才起 worker——读文档/思考没有上界,固定宽限必然再撞;引擎单凭墙钟判不了
    // "driver 起没起",只有 driver 自己知道）：'fail'=独立模式（dispatcher 自派自监,60s 判据成立）;
    // 'stale'=复用模式（CLI 通道,启动归外部 driver——降级交 driver 自查:没起就起,起过就等,
    // 真丢了走 reap --status failed 显式报败）。缺省 'fail' 保持独立模式/存量语义。
    const dispatchLostPolicy = opts?.dispatchLostPolicy ?? 'fail';
    const reaped: string[] = [];
    const stale: string[] = [];
    const instDir = this.instanceDir;
    if (!instDir) return { reaped, stale };
    for (const entry of [...this.inflight]) {
      // paused 账恢复（U4b 第6条,36 轮 review 证伪原'队列从账+盘上卡重建'——独立模式子实例
      // 是内存态崩溃即灭,无米之炊）：重派发重跑到暂停点重新入队——账删除+标注步骤回 pending,
      // 下一轮 dfs 重新派发（subtask/call 是事务边界重跑合法,与嵌套 call 暂停'恢复重跑整个
      // call'同哲学;人还没答过,重新暂停零损失）。子目录在场（文件态）仍走 stale 重建。
      // @a: anc-exec-parallel-hitl-queue
      if (entry.status === 'paused') {
        const nodeP = this.findStepById(entry.step_id);
        const childDirP = join(instDir, nodeP?.step_type === 'call' ? 'calls' : 'parallel', entry.child_instance);
        // 分派判据改退火标记（^anc-exec-call-child-persist 随批——子实例落盘后目录恒在,原
        // "目录在=stale 重建"使 U4b 恢复改道未通深水区;人还没答过,重派发重跑零损失仍是正路,
        // 唯一不能重跑的是已执行 commit 的子实例——重派发=commit 重放,恰是落盘要防的第④坑）：
        // 无 commit → 重派发（清残目录防下次误判）;有 commit → stale 续跑(load+resumeSpec)。
        // @a: anc-exec-parallel-hitl-queue, anc-exec-call-child-persist
        const childHasCommit = stateExists(childDirP) && (readState(childDirP).committed_steps ?? []).length > 0;
        if (!childHasCommit) {
          this.inflight = this.inflight.filter(f => f.child_instance !== entry.child_instance);
          this.stepStates.set(entry.step_id, 'pending');
          if (stateExists(childDirP)) rmSync(childDirP, { recursive: true, force: true });   // 残目录清场——重派发建新账,旧盘面留着会误导下轮对账
          this.recordEvent(entry.step_id, 'step_start', `hitl-paused 子实例 ${entry.child_instance} 跨进程恢复——重派发重跑到暂停点重新入队（U4b 恢复路,无 commit 重跑零损失）`);
          this.persist();
          continue;
        }
        stale.push(entry.child_instance);   // 已执行 commit 的 paused 子实例:必须续跑不可重跑
        continue;
      }
      if (entry.status !== 'inflight') continue;
      const node = this.findStepById(entry.step_id);
      const isCall = node?.step_type === 'call';
      const childDir = join(instDir, isCall ? 'calls' : 'parallel', entry.child_instance);
      if (!stateExists(childDir)) {
        // 目录不存在按账龄二分（2026-08-11 真机实撞：复用模式 worker 异步后台起，advance 时
        // 目录未建是常态启动窗口——无宽限期即误杀启动中的活）。账龄新=启动中，保持在飞；
        // 超宽限后按 dispatchLostPolicy 分道（见函数头注）。
        const ageSec = (Date.now() - new Date(entry.dispatched_at).getTime()) / 1000;
        if (ageSec <= DISPATCH_GRACE_SECONDS) continue;   // 启动中——不判死不判 stale
        if (dispatchLostPolicy === 'stale') {
          stale.push(entry.child_instance);   // 复用模式：交 driver 自查,引擎不判死
          continue;
        }
        const failure = { specId: this.spec?.header.id ?? 'child', childInstanceId: entry.child_instance,
          stepFailReasons: { dispatch: { reason: `dispatch-lost: 派发已入账 ${Math.round(ageSec)}s 子实例仍未建立（超启动宽限 ${DISPATCH_GRACE_SECONDS}s——进程崩溃于启动窗口）`, fail_kind: 'error' as FailKind } },
          stepStates: { dispatch: 'failed' } };
        if (isCall) this.reapParallelCall(entry.child_instance, { failure });
        else this.reapParallelSubtask(entry.child_instance, { failure });
        reaped.push(entry.child_instance);
        continue;
      }
      const childState = readState(childDir);
      const states = Object.values(childState.step_states ?? {});
      const anyActive = states.some(st => st === 'running' || st === 'pending');
      const anyFailed = states.some(st => st === 'failed') || !!childState.terminal_failure;
      if (!anyActive || childState.terminal_failure) {
        // 已终态未收割 → 补收割
        this.reapFromChildDir(entry.child_instance, anyFailed ? 'failed' : 'completed');
        reaped.push(entry.child_instance);
      } else {
        stale.push(entry.child_instance);   // 未终态：交调用方重建
      }
    }
    this.lastStale = stale;
    return { reaped, stale };
  }

  // 复用模式收割（§U8）：从子实例目录读终态与 vars——driver 只报告 id+成败，输出走机器通道
  // （对称 --child-instance/--failure-child 先例）。// @a: anc-exec-parallel-reuse-protocol
  reapFromChildDir(childInstance: string, status: 'completed' | 'failed'): void {
    const entry = this.inflight.find(f => f.child_instance === childInstance);
    if (!entry) {
      // 缺席分流（hopissues/0046）：真幂等（该 child 曾在名册——已收割有 parallel_reap 事件,
      // 或 killed 态条目仍挂账）→ 静默 return 保幂等语义（重复 reap 是协议允许的）;
      // 误用（从未进过名册——无 parallel 标注的 [call] 不触发派发,没有在飞账）→ 响亮拒并指路。
      // 原静默 no-op 让误用方以为收割成功实则输出全丢（报告方调试 30 分钟才定位）。
      // @a: anc-exec-reap-misuse-reject
      // killed 条目不会走到这里——killed 态仍挂在 inflight 上,外层 find 找得到,
      // 由 reapParallelCall/Subtask 的 killed 早返回消化。此处只需判"已收割"半边。
      const everReaped = this.execEvents.some(ev => ev.event === 'parallel_reap' && ev.detail?.startsWith(childInstance + ' '));   // 带分隔符边界——'1.1.1 ok' 不得让误用步骤号 '1.1' 被误判幂等（review 面三探针实证）
      if (everReaped) return;   // 真幂等（重复 reap 协议允许）
      throw new Error(`REAP_NOT_PARALLEL: 子实例 '${childInstance}' 不在派发名册——reap_and_fetch_next 只服务带 parallel 标注的派发(dispatch_ready 吐出的 child);无 parallel 标注的 [call] 用 submit_and_fetch_next <步骤号> --child-instance <子实例> 收割`);
    }
    const node = this.findStepById(entry.step_id);
    const isCall = node?.step_type === 'call';
    const instDir = this.instanceDir;
    if (!instDir) return;
    const childDir = join(instDir, isCall ? 'calls' : 'parallel', childInstance);
    // 退火凭据（复用模式）：子 state.json 的 committed_steps 非空即传播（三形态全传播）。
    // // @a: anc-exec-commit-anneal
    const childCommitted = stateExists(childDir) && (readState(childDir).committed_steps ?? []).length > 0;
    if (status === 'completed') {
      const vars = flattenVars(readVars(childDir));
      if (isCall) this.reapParallelCall(childInstance, { vars, committed: childCommitted });
      else this.reapParallelSubtask(childInstance, { vars, committed: childCommitted });
    } else {
      // 失败：读子实例 state 组装 FailRecord 内核（对称 --failure-child 通道）。
      // 目录不存在（worker 从未启动而 driver 显式报败）→ 显式报告对"失败"是权威——
      // 合成 FailRecord 收割，不因缺盘面崩溃（与"completed 报告须盘面为证"不对称是有意的：
      // 谎报成功会捏造产出,谎报失败只是放弃产出——集合语义可容）。
      let failure;
      if (!stateExists(childDir)) {
        failure = { specId: this.spec?.header.id ?? 'child', childInstanceId: childInstance,
          stepFailReasons: { report: { reason: 'driver 报告失败且子实例未建立（worker 未启动/启动即崩溃）', fail_kind: 'error' as FailKind } },
          stepStates: { report: 'failed' } };
      } else {
        const childState = readState(childDir);
        const stepFailReasons: Record<string, StepFailRecord> = {};
        for (const [k, v] of Object.entries(childState.step_fail_reasons ?? {})) {
          stepFailReasons[k] = typeof v === 'string' ? { reason: v, fail_kind: 'error' } : v as StepFailRecord;
        }
        failure = { specId: this.spec?.header.id ?? 'child', childInstanceId: childInstance, stepFailReasons, stepStates: childState.step_states };
      }
      if (isCall) this.reapParallelCall(childInstance, { failure, committed: childCommitted });
      else this.reapParallelSubtask(childInstance, { failure, committed: childCommitted });
    }
  }

  // 派发入账：原子落盘防重（同 dispatched 哲学）。返回子实例 id（<step>.<iter>）。
  // 步骤态推进：call 步骤本轮标 done（"派发即视为主线可继续"——推进条件放宽 §U5，
  // 完成条件由收齐门把住），propagate 推进下轮迭代。// @a: anc-exec-parallel-advance
  dispatchParallelCall(callStepId: string): { childInstance: string; iter: number; params: Record<string, unknown> } {
    const hostLoop = this.findHostContainerId(callStepId);
    // 迭代号沿祖先链找 loop 计数器（^anc-exec-parallel-reap-chain——旧取法用"最近任务容器",
    // 隔壳形态下壳无循环计数恒 1,两轮迭代同 childInstance 目录互覆〔D80 探针坑③〕;收齐点/
    // 杀活域仍用 hostLoop 不动）。无 loop 祖先（兄弟位并发）恒 1 合法——兄弟位每 call 步骤号唯一。
    const loopAncestor = this.findLoopAncestorId(callStepId);
    const iter = (loopAncestor ? this.loopCounters.get(loopAncestor) : this.loopCounters.get(hostLoop)) ?? 1;
    const childInstance = `${callStepId}.${iter}`;
    if (this.inflight.some(f => f.child_instance === childInstance)) {
      // 幂等：同 (step, iter) 已派发（resume 重放路径）——返回既有账目，不重派
      return { childInstance, iter, params: this.resolveCallParams(callStepId) };
    }
    const params = this.resolveCallParams(callStepId);   // 派发时快照当轮值
    // params_for_child 落盘（0020 同批——call 子实例目录 calls/<cid>）// @a: anc-exec-parallel-child-params
    if (this.instanceDir) writeChildParams(this.instanceDir, childInstance, params, 'calls');
    this.inflight.push({ step_id: callStepId, iter, child_instance: childInstance, host_container: hostLoop, dispatched_at: timestamp(), status: 'inflight', params });
    this.recordEvent(callStepId, 'parallel_dispatch', childInstance);
    const runDir2 = this.hoplog?.getRunDir();
    this.hoplog?.recordParallelDispatch(hostLoop, childInstance, runDir2 ? join(runDir2, 'calls', childInstance, 'log') : '');
    this.stepStates.set(callStepId, 'done');   // 本轮派发完成（结果收割另账）
    this.propagateAndRecord(callStepId);
    this.persist();
    return { childInstance, iter, params };
  }

  // 收割（随到随收,2026-09-04 续链投递改造——^anc-exec-parallel-reap-chain,决策档案
  // todo/decision/20260904-parallel收割须兑现声明产出链.md）：产出/失败写到 call 步骤在声明链
  // 上的位置,从那里续走包围容器该走的剩余路——旧形态抄近道直塞"最近任务容器"的 collect 缓冲,
  // call 直挂循环体时侥幸等价,隔事务壳（loop>subtask>call）即断链:壳无 collect 值静默蒸发/
  // 失败不投递壳 on fail 成死代码（D80 探针三坑实证）。
  // 成功:mapped 写 call 作用域→标 done→完成传播逐层走（中间壳完结时边界产出自然聚合）→
  // 链顶帮扶:传播后从"loop 直接子级边界"读被收集变量按 iter 喂缓冲（parallel 输出恒跳轮末
  // 传送带,缓冲是 collect 的唯一进料口——零中间容器时=旧行为,退化等价）。
  // 失败:failStep 投递回 call 步,包围容器事务机制接手（retry/on fail 照常——壳兜底走完照常
  // 聚合;call 直挂 loop 时 failStep 升级链因 loop 无 retry 语义落集合语义,行为不变）。
  // 出账后若宿主已"迭代耗尽等收齐"且在飞排空 → 触发终态化级联。// @a: anc-exec-parallel-reap-drain, anc-exec-parallel-reap-chain
  reapParallelCall(childInstance: string, outcome: { vars?: Record<string, unknown>; failure?: ReturnType<ExecutionEngine['exportFailState']>; committed?: boolean }): void {
    const idx = this.inflight.findIndex(f => f.child_instance === childInstance);
    if (idx < 0) return;   // killed/已收割：结果丢弃（账面权威——那次收割已传播过退火）
    const entry = this.inflight[idx];
    // 退火传播先于 killed 早返回（三形态全传播——强杀 child 内 commit 同样已发生）。
    // // @a: anc-exec-commit-anneal
    // 快照用派发时刻轮次（review B1-1——收割异步,渐进派发下宿主 loop 可能已推进;
    // entry.iter 是派发时刻真值,宿主 loop 之外的祖先 loop 轮次在子实例在飞期不会推进）
    if (outcome.committed) this.markCommitted(entry.step_id, { ...this.ancestorLoopIters(entry.step_id), ...(entry.host_container ? { [entry.host_container]: entry.iter } : {}) });
    if (entry.status === 'killed') return;
    this.inflight.splice(idx, 1);
    const call = this.findStepById(entry.step_id) as CallStep | null;
    if (call && !outcome.failure && outcome.vars) {
      // 映射抛错（CALL_OUTPUT_MISSING 等）就地折失败分支——本函数开头已 splice 出账,
      // 抛出去让调用方重报失败会撞 idx<0 早返回,失败记录反而丢（时序坑,BUG-G 修同批钉）。
      let mapped: Record<string, unknown> | null = null;
      try {
        mapped = this.mapCallOutputs(entry.step_id, outcome.vars);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        this.recordEvent(entry.step_id, 'parallel_reap', `${childInstance} failed: ${reason}`);
        this.hoplog?.recordWarn(entry.host_container, `call parallel 子实例 ${childInstance} 输出映射失败（不贡献收集元素）: ${reason}`);   // 挂宿主容器（0018 orphan 同修）
      }
      if (mapped) {
        this.deliverReapedOutputsAlongChain(entry.step_id, entry.iter, mapped);
        this.recordEvent(entry.step_id, 'parallel_reap', `${childInstance} ok`);
      }
    } else if (outcome.failure) {
      // 失败续链投递（^anc-exec-parallel-reap-chain）：投回 call 步让包围容器事务接手——
      // 隔壳形态:壳 retry/on fail 照常运转,兜底产物照常聚合喂 collect（旧形态只留痕不 fail,
      // 壳兜底永不触发〔D80 探针坑②〕）。call 直挂 loop 形态:call 步此刻是 done（派发即推进）,
      // failStep 的 running 门会拒——沿旧集合语义留痕不贡献元素,行为不变（退化等价）。
      const failedStepId = Object.keys(outcome.failure.stepStates).find(id => outcome.failure!.stepStates[id] === 'failed');
      const kernel = (failedStepId ? outcome.failure.stepFailReasons[failedStepId] : undefined)
        ?? { reason: 'callee failed', fail_kind: 'error' as FailKind };
      this.recordEvent(entry.step_id, 'parallel_reap', `${childInstance} failed: ${kernel.reason}`);
      const chainDelivered = this.deliverReapedFailureAlongChain(entry.step_id, entry.iter, kernel);
      if (!chainDelivered) {
        this.hoplog?.recordWarn(entry.host_container, `call parallel 子实例 ${childInstance} 失败（不贡献收集元素）: ${kernel.reason}`);   // 挂宿主容器（0018 orphan 同修）
      }
    }
    // 收齐检查：宿主 loop 主线已走完（running 且无 pending children 推进）且在飞排空 → 终态化
    this.settleHostAfterReap(entry.host_container);
    this.persist();
  }

  // 续链投递·成功半边（^anc-exec-parallel-reap-chain）：mapped 输出写 call 所在容器作用域→
  // call 标 done→完成传播（中间壳完结时既有边界产出提升机械自然聚合）→链顶从"loop 直接子级
  // 边界"读被收集变量按 iter 喂 __reaped_ 缓冲。call 直挂 loop（零中间容器）时,直接子级即
  // call 自身,mapped 值就是边界值——与旧直塞行为逐值等价（退化等价性,矩阵 2/16 基准）。
  // // @a: anc-exec-parallel-reap-chain
  private deliverReapedOutputsAlongChain(callStepId: string, iter: number, mapped: Record<string, unknown>): void {
    const loopId = this.findLoopAncestorId(callStepId);
    const chainTop = loopId ? this.loopDirectChildOnChain(callStepId, loopId) : null;
    const hasIntermediate = chainTop !== null && chainTop !== callStepId;
    const writeScope = getParentStepId(callStepId) ?? 'root';
    for (const [k, v] of Object.entries(mapped)) this.variables.write(k, v, writeScope);
    // **喂缓冲恒先于传播**（阅卷 D1 实抓——传播级联在末迭代会走到 loop finalize 合并缓冲,
    // 后喂的元素成孤儿恒丢;completeCallStep 旧注释早写过这坑"顺序关键:末轮 completeStep 会
    // 级联 finalize 合并缓冲,后喂则末轮值丢失",直挂路径做对了,隔壳新路径首版做反,晚收割
    // 时序〔主线已 drain_wait〕下恒丢末元素）。两种进料:
    // ①call 自身产出被收集（含直挂形态）——mapped 里直接有值,此刻喂;
    // ②壳边界产出被收集——值要等壳完结聚合才有,走待喂账（与失败半边同一机制:壳完结时
    // propagateCompletion 级联内兑现,那个时点天然在 finalize 之前）。
    if (loopId) {
      const loop = this.findStepById(loopId) as LoopStep | null;
      if (loop?.step_type === 'loop') {
        for (const pair of loop.collect ?? []) {
          if (pair.unitVar in mapped) {
            const key = `__reaped_${pair.listVar}`;
            const buf = (this.variables.readLocal(key, loopId) as [number, unknown][] | null) ?? [];
            buf.push([iter, mapped[pair.unitVar]]);
            this.variables.write(key, buf, loopId);
          } else if (hasIntermediate && chainTop) {
            // 壳边界产出被收集——按对记待喂账,壳完结时级联内按 iter 喂该对（边界声明才算;
            // 只记"值要等壳聚合"的对——本 call 产出的对已直喂,串行兄弟产的对归轮末传送带,
            // 都不记〔复阅实抓双重喂送〕。串行兄弟对的辨识:该 unitVar 不由本 call 产出,
            // 若它也不由壳内其他 parallel 步产出则传送带会收——此处只认"壳声明了且本收割
            // 没直喂"且该对的产出方是 parallel 步（getAsyncUnitVars 同判据面））
            const shell = this.findStepById(chainTop);
            const declares = shell ? (shell.outputs ?? []).some(o => o.name === pair.unitVar) : false;
            const loopNode = this.findStepById(loopId) as LoopStep | null;
            const isAsyncUnit = loopNode ? getAsyncUnitVars(loopNode).has(pair.unitVar) : false;
            if (declares && isAsyncUnit) this.pendingChainFeeds.push({ chain_child_id: chainTop, loop_id: loopId, iter, unit_var: pair.unitVar, list_var: pair.listVar });
          }
        }
      }
    }
    // 隔壳形态补完成传播（让中间容器完结、边界产出沿链提升、待喂账在级联内兑现）——直挂形态
    // 不传播:派发时已 done 并 propagate 过,收割再传播=多余推进错移循环状态（矩阵1/4/5 实抓）。
    if (hasIntermediate) this.propagateAndRecord(callStepId);
  }

  // 续链投递·失败半边（^anc-exec-parallel-reap-chain）：失败投回 call 步走 failStep 升级链——
  // 包围事务容器（壳）的 retry/on fail 接手。返回 true=已投递成功（壳接手,兜底走完会照常
  // 聚合喂 collect）;false=无法投递（call 直挂 loop 无事务壳——failStep 的 running 门拒,
  // 沿旧集合语义留痕,调用方记 warn）。call 派发时标 done,投递前先复位 running 过状态门。
  // // @a: anc-exec-parallel-reap-chain
  private deliverReapedFailureAlongChain(callStepId: string, iter: number, kernel: StepFailRecord): boolean {
    // 找 call 与 loop 之间有无事务容器（subtask/case）——有才值得投递（loop 自身无 retry 语义）
    const loopId = this.findLoopAncestorId(callStepId);
    let cur = getParentStepId(callStepId);
    let hasTransactionalShell = false;
    while (cur && cur !== loopId) {
      const n = this.findStepById(cur);
      if (n && (n.step_type === 'subtask' || n.step_type === 'case')) { hasTransactionalShell = true; break; }
      cur = getParentStepId(cur);
    }
    if (!hasTransactionalShell) return false;
    // 待喂账先记后投（壳兜底要经正常驱动走完才有边界产出,那时收割上下文已不在场——
    // 壳完结时 flushPendingChainFeeds 按此账喂 collect 缓冲）
    if (loopId) {
      const chainChildId = this.loopDirectChildOnChain(callStepId, loopId);
      const loopNode = this.findStepById(loopId) as LoopStep | null;
      if (chainChildId && loopNode?.step_type === 'loop') {
        const shell = this.findStepById(chainChildId);
        const asyncUnits = getAsyncUnitVars(loopNode);
        for (const pair of loopNode.collect ?? []) {
          const declares = shell ? (shell.outputs ?? []).some(o => o.name === pair.unitVar) : false;
          if (declares && asyncUnits.has(pair.unitVar)) this.pendingChainFeeds.push({ chain_child_id: chainChildId, loop_id: loopId, iter, unit_var: pair.unitVar, list_var: pair.listVar });
        }
      }
    }
    this.stepStates.set(callStepId, 'running');   // 派发时标的 done 复位——失败是这次派发的真实终局
    const r = this.failStep(callStepId, `CalleeFailure: ${kernel.reason}`, kernel.fail_kind);
    return r.status === 'ok';
  }


  // call 步骤到 loop 之间链上的"loop 直接子级"（链顶元素——被收集变量的边界声明处）。
  // call 直挂 loop 时返回 call 自身。// @a: anc-exec-parallel-reap-chain
  private loopDirectChildOnChain(callStepId: string, loopId: string): string | null {
    if (!loopId) return null;
    let cur: string | null = callStepId;
    while (cur) {
      const parent = getParentStepId(cur);
      if (parent === loopId) return cur;
      cur = parent;
    }
    return null;
  }

  // 沿祖先链找最近 loop（续链投递与子实例编号两用途——区别于 findHostContainerId 的"最近
  // 任务容器"〔收齐点/杀活域用途,U1 定形不动〕,一处判定两用途拆开防再混）。
  // // @a: anc-exec-parallel-reap-chain
  private findLoopAncestorId(stepId: string): string | null {
    let cur = getParentStepId(stepId);
    while (cur) {
      const n = this.findStepById(cur);
      if (n?.step_type === 'loop') return cur;
      cur = getParentStepId(cur);
    }
    return null;
  }

  // 杀活（主线失败清场，作者拍板 2026-08-10 不留幻影）：域内全部在飞 → killed 账面终态。
  // 独立模式协作式中断归 P1——P0 账面权威（苟活结果到达时 reap 按 killed 丢弃），
  // 语义面无幻影。// @a: anc-exec-parallel-kill
  private lastKillList: string[] = [];   // 主线失败杀活清单——failed 响应附 kill_list 交 driver（§U8）

  killInflight(scopeStepId?: string): string[] {
    const killed: string[] = [];
    for (const f of this.inflight) {
      if (f.status !== 'inflight' && f.status !== 'paused') continue;   // paused 连坐（U4b:主线死了答案无处安放）// @a: anc-exec-parallel-hitl-queue
      if (scopeStepId && f.host_container !== scopeStepId && !f.host_container.startsWith(scopeStepId + '.')) continue;
      f.status = 'killed';
      killed.push(f.child_instance);
      // 强杀退火传播（三形态之三）：killed child 内已执行的 commit 同样已发生——就地读子盘面
      // 登记（复用模式子实例逐步 persist 凭据在盘;独立模式无盘面走 worker 终态回调通道,登记幂等）。
      // // @a: anc-exec-commit-anneal
      if (this.instanceDir) {
        const node = this.findStepById(f.step_id);
        const cDir = join(this.instanceDir, node?.step_type === 'call' ? 'calls' : 'parallel', f.child_instance);
        if (stateExists(cDir) && (readState(cDir).committed_steps ?? []).length > 0) this.markCommitted(f.step_id, { ...this.ancestorLoopIters(f.step_id), ...(f.host_container ? { [f.host_container]: f.iter } : {}) });   // 派发时刻轮次（review B1-1 同律）
      }
      this.recordEvent(f.step_id, 'parallel_kill', f.child_instance);
      this.hoplog?.recordWarn(f.step_id, `主线失败清场：在飞子实例 ${f.child_instance} 判 killed（不产出、不复活）`);
    }
    if (killed.length) { this.lastKillList = [...this.lastKillList, ...killed]; this.persist(); }
    return killed;
  }

  // 收敛边界＝最近的任务容器（subtask/case/loop）祖先（2026-08-13 作者定形）：case 就是
  // branch 下的 subtask,自身即事务即边界;branch 是唯一透明结构（[case parallel] 边界穿过
  // branch 落上层）;loop 无远程特权——中间隔着 subtask/case 时边界收窄到最近那层。
  // 推演根据=并行失败走边界 retry,边界越过更近事务则失败归属随远处结构漂移（retry 归属
  // 抖动）,事务语义失效——"声明驱动穿透边界"候选同据废弃。// @a: anc-exec-parallel-dispatch-model
  private findHostContainerId(stepId: string): string {
    const segs = stepId.split('.');
    for (let i = segs.length - 1; i >= 1; i--) {
      const aid = segs.slice(0, i).join('.');
      const t = this.findStepById(aid)?.step_type;
      if (t === 'loop' || t === 'subtask' || t === 'case') return aid;
    }
    return stepId;
  }

  private buildTraversalStateForDrain(): TraversalState {
    return {
      stepStates: this.stepStates,
      variables: this.variables,
      loopCounters: this.loopCounters,
      hasInflightFor: (id: string) => this.hasInflightFor(id),
      onFailActive: this.onFailActive,   // @a: anc-exec-on-fail
      onFailConsumed: this.onFailConsumed,
      retryCounters: this.retryCounters,
    };
  }

  // call 失败跨界（对称 completeCallStep 的机器通道，2026-08-09 fail 即异常定稿）：
  // 读子实例失败记录（FailRecord），加壳组装 CalleeFailure（内核原封——callee 侧
  // failed_step/reason/fail_kind/attempt 不转述，外加 callee spec_id 与子实例引用），
  // 作为本 call 步骤的失败原因入档；fail_kind 跨界继承（lack_of_info → 父层先走知识补充）。
  // 见 design/exec-engine.md Call 执行模型第 5 步 / 概念 call 词条「失败跨界」。// @a: anc-step-call
  // 子实例失败状态导出（独立模式 executeCall 消费）：复用模式 CLI 从子实例文件读同形状，
  // 独立模式子引擎在内存——由子引擎自导出，父 failCallStep 同一入口消化。// @a: anc-step-call
  exportFailState(): { specId: string; childInstanceId: string; stepFailReasons: Record<string, StepFailRecord>; stepStates: Record<string, string>; retryHistory?: Record<string, RetryRecord[]> } {
    const stepFailReasons: Record<string, StepFailRecord> = {};
    for (const [k, v] of this.stepFailReasons) stepFailReasons[k] = v;
    const stepStates: Record<string, string> = {};
    for (const [k, v] of this.stepStates) stepStates[k] = v;
    const retryHistory: Record<string, RetryRecord[]> = {};
    for (const [k, v] of this.retryHistory) retryHistory[k] = v;
    return {
      specId: this.spec?.header.id ?? 'unnamed',
      childInstanceId: this.instanceId,
      stepFailReasons,
      stepStates,
      ...(Object.keys(retryHistory).length ? { retryHistory } : {}),
    };
  }

  failCallStep(callStepId: string, childState: { specId: string; childInstanceId: string; stepFailReasons: Record<string, StepFailRecord>; stepStates: Record<string, string>; retryHistory?: Record<string, RetryRecord[]> }): CommandResponse {
    const step = this.findStepById(callStepId);
    if (!step || step.step_type !== 'call') {
      return { status: 'error', code: ErrorCode.INVALID_STEP_ID, message: `Step '${callStepId}' is not a call step` };
    }
    // 内核提取：首个**带失败明细**的 failed 步骤,不是文档序首个 failed（^anc-exec-callee-kernel,
    // 2026-08-23 dr7 修——文档序首个常取到容器:容器只有状态位无 stepFailReasons,内核落占位文案,
    // 叶子真根因被丢,深链两层后父层重试决策全盲）。全无记录才回退首个 failed（只剩协议异常形态）。
    // @a: anc-exec-callee-kernel
    const failedIds = Object.keys(childState.stepStates).filter(id => childState.stepStates[id] === 'failed');
    const failedStepId = failedIds.find(id => childState.stepFailReasons[id]) ?? failedIds[0];
    // 无失败记录=拒收不降级（2026-08-14 e2e 实撞：driver 混用 init --parent 与 run --call-parent
    // 两协议致 state-dir 双重嵌套,失败落野目录、官方 calls/<ci>/ 恒 pending——原兜底把协议误用
    // 静默洗成 '(no fail record found)' CalleeFailure,父实例被错误终态化不可恢复。坏输入拒于
    // 状态变更前,与 resume 同一原则）。// @a: anc-step-call
    if (!failedStepId) {
      return {
        status: 'error', code: ErrorCode.INVALID_STATE,
        message: `子实例 '${childState.childInstanceId}' 无任何 failed 步骤——报败被拒（父步保持 running）。自查：①子实例是否真跑过（官方目录 calls/${childState.childInstanceId}/ 的 state.json）；②是否混用了两条协议——init --parent 建的子实例应对 <STATE>/<INST>/calls 走标准循环驱动,不要再用 run --call-parent（那是引擎派发 launch_command 的 worker 入口,会自拼 calls/ 层级）`,
      };
    }
    const kernel: StepFailRecord = childState.stepFailReasons[failedStepId]
      ?? { reason: `callee step '${failedStepId}' failed（子实例 state 缺失败明细,仅状态位）`, fail_kind: 'error' };
    const attempts = Object.values(childState.retryHistory ?? {}).reduce((n, h) => n + h.length, 0);
    // 嵌套失败单跳摘要（D42 ^anc-exec-callee-kernel——作者定"只保留一层":父只认识直接子的
    // 接口面,孙层原文对父是陌生词汇。子实例调孙失败的 kernel 是 CalleeFailure JSON,消化成
    // 一跳可读摘要再以本层视角上升;归纳保证每层 reason 恒为单跳文本。全链细节归 hoplog
    // 卫星目录,上传通道管决策可读。）// @a: anc-exec-callee-kernel
    let kernelReason = kernel.reason;
    if (kernelReason.startsWith('CalleeFailure:')) {
      try {
        const inner = JSON.parse(kernelReason.slice('CalleeFailure:'.length).trim()) as {
          callee_spec_id?: string; failed_step?: string; reason?: string; attempts?: number;
        };
        const innerReason = (inner.reason ?? '').slice(0, 200);
        kernelReason = `调用 '${inner.callee_spec_id ?? '?'}' 失败于其步骤 '${inner.failed_step ?? '?'}'（已试 ${inner.attempts ?? '?'} 次）：${innerReason}`;
      } catch {
        kernelReason = kernelReason.slice(0, 300);   // 解析不动也不透传全文——截断兜底
      }
    }
    const calleeFailure = {
      callee_spec_id: childState.specId,
      child_instance: childState.childInstanceId,
      failed_step: failedStepId,
      reason: kernelReason,
      fail_kind: kernel.fail_kind,
      attempts,
    };
    // 失败路径同语义（B 裁决 2026-08-11,§U3）：同步退化的 call parallel（配 1/退化窗口，无在飞
    // 记账）失败=集合语义就地消化，不贡献元素、主线继续——completeCallStep 同步退化喂缓冲
    // 分支的失败对偶。FailRecord 经 recordStepFailure 入账，凭据不丢。// @a: anc-exec-parallel-reap-drain
    if ((step as CallStep).parallel && !this.inflight.some(f => f.step_id === callStepId && f.status !== 'killed')) {
      // 状态前置检查（review 探针实撞 2026-08-11：绕开 failStep 的 running 检查后，driver 重复
      // 报败同一步会把下一轮 pending 的同 id 步骤再消费一次——loop 双倍推进，未执行的迭代被
      // 静默吃掉）。与 failStep 同一门：非 running 拒收。
      if (this.stepStates.get(callStepId) !== 'running') {
        return { status: 'error', code: ErrorCode.INVALID_STATE, message: `Step '${callStepId}' is ${this.stepStates.get(callStepId) ?? 'unknown'}, expected running` };
      }
      this.recordStepFailure(callStepId, `CalleeFailure: ${JSON.stringify(calleeFailure)}`, kernel.fail_kind);
      this.hoplog?.recordStepFailed(callStepId, `CalleeFailure（串行退化集合语义,不贡献元素）: ${kernel.reason}`, kernel.fail_kind);
      const hostId = this.findHostContainerId(callStepId);
      this.hoplog?.recordParallelReap(hostId, `${callStepId}(serial)`, 'failed');   // @a: anc-obs-parallel-reap
      // 账面形态镜像派发路径（同 markSubtaskFailed 退化分支）：done+FailRecord 凭据，宿主继续推进
      this.stepStates.set(callStepId, 'done');
      this.propagateAndRecord(callStepId);
      this.persist();
      return { status: 'ok' };
    }
    return this.failStep(callStepId, `CalleeFailure: ${JSON.stringify(calleeFailure)}`, kernel.fail_kind);
  }

  failStep(stepId: string, reason: string, failKind: FailKind = 'error'): CommandResponse { // @a: anc-exec-none-propagation
    const state = this.stepStates.get(stepId);

    if (state === 'failed') {
      return { status: 'ok', code: ErrorCode.ALREADY_FAILED, message: 'Step already failed' }; // @a: anc-cli-idempotency
    }
    // initial_plan 等待态容器放行（^anc-exec-subtask-free-expand——空 free 容器在等计划时字面
    // pending 非 running,但它是本实例的活跃焦点:人对续批问路答"收手"须能失败收口。放行同时清
    // 等待槽——不清则 nextStep 再吐 initial_plan,失败被等待态复活）。// @a: anc-exec-subtask-free-expand
    const isAwaitingPlan = this.adaptiveNeededSubtask === stepId && state === 'pending';
    if (isAwaitingPlan) {
      this.adaptiveNeededSubtask = null;
    } else if (state !== 'running') {
      return { status: 'error', code: ErrorCode.INVALID_STATE, message: `Step '${stepId}' is ${state ?? 'unknown'}, expected running` };
    }

    // fail 不碰值空间（2026-08-09 函数级 fail 定稿）：不置 None、不清理——失败步骤与同轮前序
    // 已写下的变量原样保留（重试轮修复素材）；原"输出置 None+更新模式豁免(DEBT-13)"整体废除。
    // 见 design/exec-engine.md ^anc-exec-none-propagation。
    this.stepStates.set(stepId, 'failed');
    this.recordStepFailure(stepId, reason, failKind);
    this.hoplog?.recordStepFailed(stepId, reason, failKind);

    // 主线失败杀活（统一模型 §U4，作者拍板不留幻影）：失败步骤所在域的在飞全部 killed。
    // 域=最近宿主 loop（call parallel 只在 loop 体内）；重试路径同样先清场（重跑轮重新派发）。
    // @a: anc-exec-parallel-kill
    if (this.inflight.some(f => f.status === 'inflight' || f.status === 'paused')) {
      // paused 同为触发面（U4b 杀活连坐——全员等人时主线失败,门只查 inflight 则杀活整个不触发,
      // paused 账永挂）。// @a: anc-exec-parallel-hitl-queue
      this.killInflight(this.findHostContainerId(stepId));
    }

    this.handleFailStepRetry(stepId, reason);

    this.persist();
    return { status: 'ok' };
  }

  submitReplan(subtaskId: string, stepsMd: string, opts?: { proactive?: boolean; extendExpansion?: boolean }): ReplanResponse { // @a: anc-exec-retry-adaptive, anc-exec-completeness, anc-exec-replan-proactive
    // aborted 墓碑门（^anc-exec-abort 契约4 + ^anc-exec-subtask-free-expand 契约9——expand 长驻
    // 等待态使旧家族洞窗口常态化,三轮 review 补）：中止是终局,死实例拒收计划。
    if (this.terminalState === 'aborted') {
      return { status: 'error', code: ErrorCode.INVALID_STATE, errors: [{ kind: 'validate', rule: 'replan', severity: 'error', message: `RUN_ABORTED: 实例已主动中止（${this.abortReason ?? '(user abort)'}）——终局不可恢复` }] };
    }
    const proactive = opts?.proactive === true;
    // 拒因留痕 engine 侧自记（review P1-③,^anc-exec-replan-proactive 第7条——原唯一写点在
    // dispatcher standalone 管线,proactive 从 CLI 直达 engine 不经过;各拒收分支经此收口）。
    const rejectLog = (r: ReplanResponse): ReplanResponse => {
      if (r.status === 'error' && proactive) {
        this.hoplog?.recordStepMeta(subtaskId, { submit_rejected: (r.errors ?? []).map(e => e.message) });
      }
      return r;
    };
    if (!proactive && this.adaptiveNeededSubtask !== subtaskId) {
      return {
        status: 'error',
        code: ErrorCode.INVALID_STATE,
        errors: [{ kind: 'validate', rule: 'replan', severity: 'error', message: `Subtask '${subtaskId}' is not awaiting replan` }],
      };
    }

    const subtask = this.findStepById(subtaskId) as SubtaskStep | null;
    if (!subtask) {
      return {
        status: 'error',
        code: ErrorCode.INVALID_STEP_ID,
        errors: [{ kind: 'validate', rule: 'replan', severity: 'error', message: `Subtask '${subtaskId}' not found` }],
      };
    }

    // 主动 replan A 边界（^anc-exec-replan-proactive,作者拍板 2026-08-26）：只编未执行部分——
    // 容器须在可编辑态（running/pending;终态容器无未执行部分可编）,且已终态/执行中的子步
    // 不可动。此处先核容器态;子步粒度由"整树替换但保留已执行状态"语义收窄——proactive 提交的
    // 新 children 里,已终态子步必须原样保留（step_id+类型+摘要同）,否则结构化拒。
    if (proactive) {
      // 目标核型（review P1-①,^anc-exec-replan-proactive 第5条）：门放开后叶子步目标可达,
      // 核态不核型则 validateCheckPreservation 迭代 undefined 裸崩——非容器结构化拒。
      const targetNode = this.findStepById(subtaskId);
      if (targetNode && targetNode.step_type !== 'subtask' && targetNode.step_type !== 'case') {
        return rejectLog({
          status: 'error',
          code: ErrorCode.INVALID_STEP_ID,
          errors: [{ kind: 'validate', rule: 'replan-proactive', severity: 'error', message: `'${subtaskId}' 是 ${targetNode.step_type} 步骤——主动编辑的目标必须是 subtask/case 容器（要改某个步骤,编辑它所在的容器）` }],
        });
      }
      const containerState = this.stepStates.get(subtaskId);
      if (containerState !== 'running' && containerState !== 'pending') {
        return rejectLog({
          status: 'error',
          code: ErrorCode.INVALID_STATE,
          errors: [{ kind: 'validate', rule: 'replan-proactive', severity: 'error', message: `Subtask '${subtaskId}' is ${containerState ?? 'unknown'}——主动编辑只对未终态容器（已完成/失败的容器没有未执行部分可编）` }],
        });
      }
    }

    // --- P0-2: Circuit breaker — replan attempt limit ---
    // 熔断分池（review P1-④,^anc-exec-replan-proactive 第4条）：proactive 独立计数上限 10
    //（防失控）,不占 adaptive 的 3 次故障恢复额度——人在场的编辑不是故障,不该吃救命预算。
    if (proactive) {
      const pCount = this.proactiveReplanCounters.get(subtaskId) ?? 0;
      if (pCount >= 10) {
        return rejectLog({
          status: 'error',
          code: ErrorCode.REPLAN_LIMIT_EXCEEDED,
          errors: [{ kind: 'validate', rule: 'replan-proactive-limit', severity: 'error', message: `Subtask '${subtaskId}' 主动编辑已达上限 10 次——计划改了十遍还没对,值得停下来想想目标本身` }],
        });
      }
    }
    const currentCount = this.replanCounters.get(subtaskId) ?? 0;
    if (!proactive && currentCount >= 3) {
      return {
        status: 'error',
        code: ErrorCode.REPLAN_LIMIT_EXCEEDED,
        errors: [{ kind: 'validate', rule: 'replan-limit', severity: 'error', message: `Subtask '${subtaskId}' has exceeded maximum replan attempts (3)` }],
      };
    }

    const wrappedMd = `# Replan\nGoal: replan\n\n## Steps\n${stepsMd}`;
    const { ast, errors: parseErrors } = parseSpec(wrappedMd);
    if (parseErrors.length > 0) {
      return { status: 'error', code: ErrorCode.PARSE_ERROR, errors: parseErrors };
    }

    const newSteps = ast.steps ?? [];
    if (newSteps.length === 0) {
      return {
        status: 'error',
        code: ErrorCode.VALIDATION_ERROR,
        errors: [{ kind: 'validate', rule: 'replan', severity: 'error', message: 'Replan must have at least 1 step' }],
      };
    }

    // --- P0-2: Similarity detection (duplicate replan) ---
    const newSummaries: StepSummary[] = newSteps.map(s => this.toStepSummary(s));
    const lastChildren = this.lastReplanChildren.get(subtaskId);
    // 相似度闸语义分派（review P0,^anc-exec-replan-proactive 第3条）：proactive 完全退出——
    // 不读不写基线（不写=防污染 adaptive 基线;不读=重复提交天然幂等,CLI 瞬断重试友好;
    // 处决语义是 adaptive 专属防 LLM 死循环烧钱）。防抖由分池上限兜底。
    if (!proactive && lastChildren && this.isReplanDuplicate(lastChildren, newSummaries)) {
      this.adaptiveNeededSubtask = null;
      this.markSubtaskFailed(subtask);
      this.persist();
      return {
        status: 'error',
        code: ErrorCode.REPLAN_DUPLICATE,
        errors: [{ kind: 'validate', rule: 'replan-duplicate', severity: 'error', message: `Replan for '${subtaskId}' is too similar to previous attempt (duplicate detected)` }],
      };
    }

    const requiredOutputs = new Set((subtask.outputs ?? []).map(o => o.name));
    const providedOutputs = new Set<string>();
    const collectOutputs = (steps: StepNode[]) => {
      for (const s of steps) {
        if (s.outputs) for (const o of s.outputs) providedOutputs.add(o.name);
        if (hasChildren(s)) collectOutputs(getChildren(s));
      }
    };
    collectOutputs(newSteps);

    const missing = [...requiredOutputs].filter(n => !providedOutputs.has(n));
    if (missing.length > 0) {
      return {
        status: 'error',
        code: ErrorCode.VALIDATION_ERROR,
        errors: [{ kind: 'validate', rule: 'replan-outputs', severity: 'error', message: `Replan missing required outputs: ${missing.join(', ')}` }],
      };
    }

    // --- P0-1: check-finally preservation validation ---
    const checkValidationError = this.validateCheckPreservation(subtask.children, newSteps);
    if (checkValidationError) {
      return {
        status: 'error',
        code: ErrorCode.VALIDATION_ERROR,
        errors: [checkValidationError],
      };
    }

    // --- subtask free 展开物两闸（^anc-exec-subtask-free-expand 契约3/4——仅到步展开提交时:
    // free 容器 children 为空即首次展开;非 free 或已有 children 的 replan 不经此闸）---
    const isFreeContainer = (subtask as SubtaskStep).free === true;
    const isFreeExpansion = isFreeContainer && (subtask.children ?? []).length === 0;
    if (isFreeContainer) {
      // free 容器终身闸（契约4扩——三轮 review 实锤:原闸只判首次展开,展开后失败驱动 replan
      // 提交含 commit 曾放行;第二次运行时计划同样无人预审）。首次展开另加三闸。
      const flatten = (ss: StepNode[]): StepNode[] => ss.flatMap(x => [x, ...(hasChildren(x) ? flatten(getChildren(x)) : [])]);
      const flatNew = flatten(newSteps);
      // 禁 commit（与动态 spec 准入门 D2 同律）——free 容器一切 replan 生效,不限首展开
      const commitStep = flatNew.find(st => st.step_type === 'commit');
      if (commitStep) {
        return {
          status: 'error', code: ErrorCode.VALIDATION_ERROR,
          errors: [{ kind: 'validate', rule: 'expansion', severity: 'error', message: `EXPANSION_HAS_COMMIT: 运行时计划含 commit 步 '${commitStep.step_id}'——free 家族"自由不含不可逆",不可逆动作必须写卡时显式声明被人看见;commit 写在 [subtask free] 之外消费其交付物（本闸对 free 容器的一切计划提交生效,不限首次展开）` }],
        };
      }
      if (isFreeExpansion) {
        // 强制 check（F1）且须在主干——埋在 branch 死支里的不算（可能永不执行,review 抓）
        const mainlineHasCheck = (ss: StepNode[]): boolean => ss.some(x =>
          x.step_type === 'check'
          || (x.step_type === 'subtask' && mainlineHasCheck(getChildren(x)))
          || (x.step_type === 'loop' && mainlineHasCheck(getChildren(x))));
        if (!mainlineHasCheck(newSteps)) {
          return {
            status: 'error', code: ErrorCode.VALIDATION_ERROR,
            errors: [{ kind: 'validate', rule: 'expansion', severity: 'error', message: `EXPANSION_NO_CHECK: 到步展开的计划必须在主干含 check 步（branch 分支里的不算——可能永不执行）——运行时生成的计划无人预审,check 是它唯一的把关（[subtask free] 展开物纪律,概念 ^anc-step-subtask-free）` }],
          };
        }
        // 全实例展开总数熔断（契约7——嵌套 free 各池独立计数使 3 次熔断整体失效,review 实锤套娃放行）。
        // 上限可配:Config expansion_max（实例级量纲配实例级位置——容器头属性嵌套时归属不清,retry 是
        // 容器级失败配额且契约5已定"展开不是失败";非法值按缺省并 warn 不拒,配置钝感写错不炸 spec）。
        // 耗尽不硬烧,问人续批（契约7——拒绝报文即介入点:caller 呈情况问真人,人批则携
        // extend_expansion 重交,一次授权放行一次,照常计数下次超限再问;driver 无权替答）。// @a: anc-exec-subtask-free-expand
        const expansionMax = this.resolveExpansionMax();
        if (this.expansionCount >= expansionMax && !opts?.extendExpansion) {
          return {
            status: 'error', code: ErrorCode.VALIDATION_ERROR,
            errors: [{ kind: 'validate', rule: 'expansion', severity: 'error', message: `EXPANSION_LIMIT: 本实例累计展开已达 ${this.expansionCount} 次（上限 ${expansionMax},Config expansion_max 可调,缺省 ${DEFAULT_EXPANSION_MAX}）。不硬拒——把情况呈给真人问"任务还要继续展开,继续还是收手?"（driver 无权替答:预算是人给的,追加须人批）;人批继续 → 同一提交携 --extend-expansion 重交,放行这一次（照常计数,下次超限再问）;人不批 → 改计划收敛或中止` }],
          };
        }
      }
    }
    {
      // 全量 fragment validateSpec 对一切 replan 生效（坏签名 check/P11/坏变量引用等规则面运行时补位）。
      // 原只挂 free 展开分支,普通 replan 是 parse-only——坏变量引用静默落树运行时 MISSING_INPUT 晚炸
      // （2026-09-11 语义审计抓漏,设计 ^anc-exec-completeness 第 3 条实装归位）// @a: anc-exec-completeness
      const knownVars = Object.keys(this.variables.getAllVariables());
      const fragErrors = validateSpec({ header: { title: 'expansion' }, steps: newSteps } as SpecAST, undefined, { fragment: true, knownVars })
        .filter(e => e.severity === 'error');
      if (fragErrors.length > 0) {
        return { status: 'error', code: ErrorCode.VALIDATION_ERROR, errors: fragErrors };
      }
    }

    // --- 主动 replan A 边界子步粒度（^anc-exec-replan-proactive）---
    // 已执行前缀必须原样保留：新 children 的前 K 步（K=已终态子步数）须与现行一致
    //（step_id 序位+类型+摘要同——改历史=造假）;执行中步（running）同前缀铁律。
    // 状态面：前缀不清账不重置（产出仍在变量空间）,只有 K 之后的新计划置 pending。
    if (proactive) {
      const oldChildren = subtask.children ?? [];
      const settled: StepNode[] = [];
      for (const c of oldChildren) {
        const st = this.stepStates.get(c.step_id);
        if (st === 'done' || st === 'failed' || st === 'skipped' || st === 'running') settled.push(c);
        else break;   // 首个未执行步起,后面全部可编辑（顺序执行模型:前缀即已发生面）
      }
      // 前缀比对递归 children（review P1-②,^anc-exec-replan-proactive 第6条——原只核顶层
      // type+summary,running 容器的内部编辑被静默丢弃且响应谎报 ok;v1 递归比对有 diff 即拒点名,
      // 诚实优先;'真放行内层未执行段'是后话）。
      const prefixDiff = (a: StepNode, b: StepNode | undefined): string | null => {
        if (!b || b.step_type !== a.step_type || (b.summary ?? '') !== (a.summary ?? '')) return a.step_id;
        const ak = hasChildren(a) ? getChildren(a) : [];
        const bk = hasChildren(b) ? getChildren(b) : [];
        if (ak.length !== bk.length) return a.step_id;
        for (let j = 0; j < ak.length; j++) {
          const d = prefixDiff(ak[j], bk[j]);
          if (d) return d;
        }
        return null;
      };
      for (let i = 0; i < settled.length; i++) {
        const oldStep = settled[i];
        const oldState = this.stepStates.get(oldStep.step_id);
        const diffAt = prefixDiff(oldStep, newSteps[i]);
        if (diffAt) {
          return rejectLog({
            status: 'error',
            code: ErrorCode.VALIDATION_ERROR,
            errors: [{ kind: 'validate', rule: 'replan-proactive', severity: 'error', message: `主动编辑不可改动已执行/执行中步骤 '${diffAt}'（前缀步 '${oldStep.step_id}' ${oldState} 内）——只能编辑未执行部分,已执行前缀须在提交中原样保留（含其内部子步;改历史=造假;执行中容器的内部编辑待其跑完后再改,或先编辑更外层的未执行部分）` }],
          });
        }
      }
      // 前缀原样:保留原节点对象与状态账;只替换 K 之后
      const reIdAll = this.reIdSteps(newSteps, subtaskId);
      const tail = reIdAll.slice(settled.length);
      for (const c of oldChildren.slice(settled.length)) {
        this.stepStates.delete(c.step_id);
        this.removeChildStates(c);
      }
      (subtask as { children: StepNode[] }).children = [...settled, ...tail];
      this.setSubtreePending(tail);
      this.stepStates.set(subtaskId, 'running');
      // 分池计数;不写 lastReplanChildren（防污染 adaptive 相似度基线——编辑后的真故障重规划
      // 若结构接近现行计划会被误杀,review P0 双向污染半边）。
      this.proactiveReplanCounters.set(subtaskId, (this.proactiveReplanCounters.get(subtaskId) ?? 0) + 1);
      this.recordEvent(subtaskId, 'replan', 'proactive:编辑未执行部分（已执行前缀保留）');
      this.writeReplanCandidate(subtaskId, stepsMd, currentCount + 1, 'proactive edit（不经失败的主动计划编辑）');
      this.persist();
      return { status: 'ok', new_children: newSummaries };
    }

    // --- P0-2: Increment replan counter and store last children ---
    // subtask free 首次展开豁免（^anc-exec-subtask-free-expand 契约5——首规划不是失败重规划:
    // 不吃 adaptive 3 次救命额度,不写相似度基线〔展开后真故障的重规划若结构接近初始计划,
    // 会被 REPLAN_DUPLICATE 误杀——与 proactive 分池同因,阅卷实锤后补〕）。
    if (!isFreeExpansion) {
      this.replanCounters.set(subtaskId, currentCount + 1);
      this.lastReplanChildren.set(subtaskId, newSummaries);
    } else {
      // 首次展开落地：总计数自增（契约7熔断底账）+ hoplog 骨架（原零记录,执行树凭空缺节点——契约9）
      this.expansionCount += 1;
      this.hoplog?.recordStepStart(subtaskId, 'subtask', `${subtask.summary ?? ''}（到步展开,第 ${this.expansionCount} 次）`);
    }

    // replan 换结构重跑=新进入:旧结构退场即整体清场——对旧 children **一律删 scope 不筛
    // default**（^anc-exec-output-init-reentry replan 清场句,两批 review 面二实抓同号残 scope
    // 压制:旧结构不带 default 的容器执行过即有 scope〔ensureScope 建 scope 不看 default〕,
    // reIdSteps 顺序重编号下新旧同位必然同号,若新容器带 = 初值,残 scope 让 init-once 判据
    // 误判"已进入过",初值永不写;残 scope 本无人消费,删了才是干净退场）。在旧 children 摘除
    // 前做（定位靠旧结构）。collect 收集账不在此清——已收敛到 loop 入口进入即清。
    // // @a: anc-exec-output-init-reentry
    const clearOldScopes = (nodes: StepNode[]) => {
      for (const n of nodes) {
        if (n.step_type === 'on_fail') continue;
        if (CONTAINER_STEP_TYPES.has(n.step_type)) {
          this.variables.deleteScope(n.step_id);
        }
        if (hasChildren(n)) clearOldScopes(getChildren(n));
      }
    };
    clearOldScopes(getChildren(subtask));
    this.removeChildStates(subtask);
    const reIdChildren = this.reIdSteps(newSteps, subtaskId);
    (subtask as { children: StepNode[] }).children = reIdChildren;
    this.setSubtreePending(reIdChildren);
    this.stepStates.set(subtaskId, 'running');

    // 扁平命名空间（2026-08-09）：replan 不清变量——Python 语义自然保留，重写的 children
    // 用新产出覆盖旧值；须重置的量由新 children 显式 `= 初值`（原 clearScope 按容器圈变量
    // 的做法随块级作用域废除失去对象）。
    this.adaptiveNeededSubtask = null;
    this.recordEvent(subtaskId, 'replan');

    // 提报沉淀(降级阶梯运行时生成必沉淀):绑定四元组发 HopLog replan_audit 审计事件,
    // 供运维离线提取→审核→晋升为预声明备用链路(渐进固化)。
    // 见 ^anc-exec-retry-adaptive 提报沉淀 / spec-observability ^anc-obs-replan-audit。
    // @a: anc-obs-replan-audit
    const newChildrenSummary = reIdChildren.map(c => this.toStepSummary(c));
    const lastFail = (this.retryHistory.get(subtaskId) ?? []).slice(-1)[0];
    this.hoplog?.recordReplanAudit({
      spec_id: this.spec?.header.id ?? 'unnamed',
      step_id: subtaskId,
      error_reason: lastFail?.failure_reason ?? '',
      generated_children: newChildrenSummary,
      base: 'scratch',   // 档A:运行时从零生成(第4档)。档B 备用链路库就绪后,基于备用改的标 'fallback'
      at: new Date().toISOString(),
    });
    // 候选文件落盘（提报沉淀的文件半边——审计事件"可查",候选文件"可直接审"）：
    // <spec基名>.replan/<step_id>.v<n>.md,内容=提交原文+@trace 头绑四元组。尽力而为不拦 replan
    //（沉淀是离线学习通道非执行链）;specPath 缺席（内存态）跳过。// @a: anc-exec-retry-adaptive
    this.writeReplanCandidate(subtaskId, stepsMd, currentCount + 1, lastFail?.failure_reason ?? '');

    this.persist();
    return {
      status: 'ok',
      new_children: newChildrenSummary,
    };
  }

  // 候选文件写入（replan 提报沉淀文件半边,design exec-engine §replan 步骤 6）。// @a: anc-exec-retry-adaptive
  private writeReplanCandidate(subtaskId: string, stepsMd: string, version: number, errorReason: string): void {
    if (!this.specPath) return;   // 内存态引擎无源目录=无沉淀位
    try {
      const specBase = basename(this.specPath).replace(/\.md$/, '');
      const dir = join(dirname(this.specPath), `${specBase}.replan`);
      mkdirSync(dir, { recursive: true });
      const header = [
        '%% @trace',
        `\tid: replan-${this.spec?.header.id ?? 'unnamed'}-${subtaskId}-v${version}`,
        `\ttype: replan-candidate`,
        `\tspec_id: ${this.spec?.header.id ?? 'unnamed'}`,
        `\tstep_id: ${subtaskId}`,
        `\terror_reason: ${errorReason.replace(/\n/g, ' ').slice(0, 200)}`,
        `\tgenerated_at: ${new Date().toISOString()}`,
        '\tnote: adaptive 运行时生成的候选 children（降级阶梯第3/4档产物）——离线审核后可晋升为预声明备用链路',
        '%%',
        '',
      ].join('\n');
      // 版本号文件探测递增（三轮 review:free 展开豁免计数使版本恒 v1 互相覆盖——首计划是
      // 提报沉淀价值最高的样本;探测到已存在即顺延,任何计数错账都不再覆盖历史）。
      let v = version;
      while (existsSync(join(dir, `${subtaskId}.v${v}.md`))) v += 1;
      writeFileSync(join(dir, `${subtaskId}.v${v}.md`), header + stepsMd, 'utf-8');
    } catch (err: unknown) {
      this.hoplog?.recordWarn(subtaskId, `replan 候选文件写入失败（沉淀通道,不拦 replan）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  selectBranch(stepId: string, selectedCaseId: string, reason?: string): CommandResponse {
    const branch = this.findStepById(stepId) as BranchStep | null;
    if (!branch || branch.step_type !== 'branch') {
      return { status: 'error', code: ErrorCode.INVALID_STEP_ID, message: `Step '${stepId}' is not a branch` };
    }

    const state = this.stepStates.get(stepId);
    if (state !== 'pending' && state !== 'running') {
      return { status: 'error', code: ErrorCode.INVALID_STATE, message: `Branch '${stepId}' is ${state}, expected pending or running` };
    }

    const caseStep = branch.children.find(c => c.step_id === selectedCaseId);
    if (!caseStep) {
      return { status: 'error', code: ErrorCode.INVALID_STEP_ID, message: `Case '${selectedCaseId}' not found in branch '${stepId}'` };
    }

    this.stepStates.set(stepId, 'running');
    this.stepStates.set(caseStep.step_id, 'running');
    for (const c of branch.children) {
      if (c.step_id !== selectedCaseId) {
        this.stepStates.set(c.step_id, 'skipped');
        this.skipAllDescendants(c);
      }
    }

    this.recordEvent(stepId, 'branch_select', reason ?? selectedCaseId);
    this.persist();
    return { status: 'ok' };
  }

  /** initial_plan 请求组装（^anc-exec-subtask-free-expand 契约1/2——三出口〔首吐/再吐/resume〕
   * 共用单点:"这是首规划"由状态判定〔free 且 children 空〕,不是一次性组装。缺值输入显式 null
   * 占位+missing_inputs 清单——规划方须能分辨"值缺失"与"没这个输入"。// @a: anc-exec-subtask-free-expand */
  private buildInitialPlanRequest(st: SubtaskStep): AdaptiveNeeded {
    const ctx: Record<string, unknown> = {};
    const missing: string[] = [];
    const allVars = this.variables.getAllVariables();
    for (const inp of st.inputs ?? []) {
      if (inp.name in allVars && allVars[inp.name] !== undefined && allVars[inp.name] !== null) {
        ctx[inp.name] = allVars[inp.name];
      } else {
        ctx[inp.name] = null;
        missing.push(inp.name);
      }
    }
    return {
      status: 'adaptive_needed',
      instance_id: this.instanceId,
      spec_id: this.spec?.header.id ?? 'unnamed',
      subtask_id: st.step_id,
      reason: 'initial_plan',
      expansion_context: this.deflateValues(ctx),
      ...(missing.length ? { missing_inputs: missing } : {}),
      failure: { step_id: '', reason: '', attempt: 0, max_retries: st.retry ?? 3 },
      subtask_contract: { outputs: st.outputs ?? [], constraints: [] },
      original_children: [],
      retry_history: [],
    };
  }

  getStatus(): StatusResponse {
    let completed = 0, failed = 0, pending = 0;
    let currentStep: string | undefined;

    for (const [id, state] of this.stepStates) {
      if (state === 'done') completed++;
      else if (state === 'failed') failed++;
      else if (state === 'pending') pending++;
      else if (state === 'running') currentStep = id;
    }

    const executionStatus = this.determineExecutionStatus();

    // paused 摘要装配（todo/0081——看护方判"该叫人了"只需 reason+step,卡全文归 resume 通道）
    // // @a: anc-cli-status-response
    let pauseSummary: { pause_reason?: string; paused_step_id?: string } = {};
    if (executionStatus === 'paused') {
      const d = this.detectPausedState();
      if (d) pauseSummary = { pause_reason: d.reason, paused_step_id: d.stepId };
    }

    return {
      status: 'ok',
      instance_id: this.instanceId,
      execution_status: executionStatus,
      total_steps: this.stepStates.size,
      completed,
      failed,
      pending,
      current_step: currentStep,
      ...pauseSummary,
    };
  }

  getVars(): VarsResponse {
    const executionStatus = this.determineExecutionStatus();
    const allVars = this.variables.getAllVariables();
    const declaredOutputs = this.spec?.header.outputs ?? [];
    const pendingOutputs = this.variables.getPendingOutputs(declaredOutputs);

    return {
      status: 'ok',
      instance_id: this.instanceId,
      execution_status: executionStatus,
      variables: allVars,
      pending_outputs: pendingOutputs,
    };
  }

  /** 网络暂停步骤回置（API 层网络重试耗尽,步骤未产生任何效果,回置 pending 后 persist:
   * 与 crash-recovery 的 running→pending 同语义,resume 经 next_step 自然重派,网络恢复即
   * 续跑。只接受 running 态步骤（防误用重置已完成步骤）。// @a: anc-exec-network-pause */
  resetStepForNetworkPause(stepId: string): void {
    if (this.stepStates.get(stepId) !== 'running') return;
    this.stepStates.set(stepId, 'pending');
    this.recordEvent(stepId, 'network_pause', 'API 层网络重试耗尽,步骤回置 pending 等网络恢复');
    this.persist();
  }

  /** 递归把子树所有步骤置 pending（init 时初始化 / retry 时重置——同一操作，单点定义）。 */
  private setSubtreePending(steps: StepNode[]): void {
    for (const step of steps) {
      this.stepStates.set(step.step_id, 'pending');
      if (hasChildren(step)) {
        this.setSubtreePending(getChildren(step));
      }
    }
  }

  // parallel worker 子实例 scope 掩码：目标 child 子树保留 pending，其余全标 skipped。
  // 祖先链标 running（容器已进入），子树内保持 pending（等引擎正常推进）。
  // 见 design/parallel-execution.md §2b executeSubtreeOnly + §9e for-each worker 启动。
  // @a: anc-exec-parallel-subinstance, anc-exec-parallel-foreach-worker
  private executeSubtreeOnly(childStepId: string, steps: StepNode[]): void {
    // 收集子树 step_id 集合（child 自身 + 全部后代）
    const subtreeIds = new Set<string>();
    let target = this.findStepById(childStepId);
    let effectiveRoot = childStepId;

    // for-each 合成 ID 解析：findStepById 命中失败时，检测父 parallel 是否 forEach，
    // 解析回模板 child {P}.1（子树结构相同，只是 step_id 前缀不同）。见 §9e
    if (!target) {
      const parentId = getParentStepId(childStepId);
      const parentStep = parentId ? this.findStepById(parentId) : null;
      if (parentStep && parentStep.step_type === 'loop' && getForEach(parentStep)) {
        const templateId = `${parentId}.1`;
        target = this.findStepById(templateId);
        effectiveRoot = templateId;
      }
    }
    // 统一模型子实例 id `<step_id>.<iter>`（渐进派发,§U8）：剥迭代后缀取标注 subtask 为子树根。
    // ⚠️ iter=1 时 `<step>.1` 可能撞真实步骤 id（如 1.1 的 act 1.1.1）——先判"剥后缀是
    // subtask parallel"再用剥后缀根,防止把子树根错解为体内叶子。// @a: anc-exec-parallel-reuse-protocol
    {
      const strippedId = childStepId.includes('.') ? childStepId.slice(0, childStepId.lastIndexOf('.')) : childStepId;
      const stripped = this.findStepById(strippedId);
      if (stripped && stripped.step_type === 'subtask' && (stripped as SubtaskStep).parallel) {
        target = stripped;
        effectiveRoot = strippedId;
      }
    }
    if (!target) return;
    this.subtreeRoot = effectiveRoot;  // 修正为模板 ID（worker 内部执行用模板 step_id）
    subtreeIds.add(effectiveRoot);
    for (const d of collectDescendants(target)) subtreeIds.add(d.step_id);

    // 收集祖先链 step_id（从 child 到根的容器路径）
    const ancestorIds = new Set<string>();
    let pid = getParentStepId(effectiveRoot);
    while (pid) { ancestorIds.add(pid); pid = getParentStepId(pid); }

    // 遍历全部步骤：子树保留 pending，祖先标 running（容器已进入态），其余标 skipped
    for (const [stepId] of this.stepStates) {
      if (subtreeIds.has(stepId)) continue;  // 子树保持 pending
      if (ancestorIds.has(stepId)) {
        this.stepStates.set(stepId, 'running');  // 祖先容器：running 态让 dfsNextStep 递归进入
      } else {
        this.stepStates.set(stepId, 'skipped');
      }
    }
  }

  private findFirstFailedStep(steps: StepNode[]): StepNode | null {
    for (const step of steps) {
      if (this.stepStates.get(step.step_id) === 'failed') return step;
    }
    return null;
  }

  // propagateCompletion + 容器 done 记录:统一调用点,通过 newlyDone 通道捕获级联标 done 的容器,
  // 逐个 recordStepDone(含容器声明的聚合输出,从父 scope 读)/Failed。
  // 见 design/spec-observability.md ^anc-obs-step-done-timing。// @a: anc-obs-step-done-timing
  private propagateAndRecord(stepId: string): void {
    const newlyDone: { node: StepNode; failed: boolean }[] = [];
    propagateCompletion(stepId, {
      stepStates: this.stepStates,
      variables: this.variables,
      loopCounters: this.loopCounters,
      newlyDone,
      hasInflightFor: (id: string) => this.hasInflightFor(id),   // 收齐门 // @a: anc-exec-parallel-reap-drain
      onFailActive: this.onFailActive,   // @a: anc-exec-on-fail
      onFailConsumed: this.onFailConsumed,
      pendingChainFeeds: this.pendingChainFeeds,   // 续链失败半边待喂账（壳完结即喂）// @a: anc-exec-parallel-reap-chain
      retryCounters: this.retryCounters,
    }, this.spec!);
    if (!this.hoplog) return;
    // worker 掩码祖先豁免（^anc-obs-step-done-timing 豁免条,todo/0022）：subtreeRoot 的真祖先
    // 是 executeSubtreeOnly 设的 scope 掩码——结构状态非执行态,worker 内从未 start;对它们记
    // done/failed 必触发孤儿守卫假标记（"caller sequence bug"指控不成立,误导复盘）。跳过不记;
    // 真孤儿（非掩码祖先）仍由守卫标记,语义不变。// @a: anc-obs-step-done-timing
    const maskAncestors = new Set<string>();
    if (this.subtreeRoot) {
      let pid = getParentStepId(this.subtreeRoot);
      while (pid) { maskAncestors.add(pid); pid = getParentStepId(pid); }
    }
    for (const { node, failed } of newlyDone) {
      if (maskAncestors.has(node.step_id)) continue;
      if (failed) {
        this.hoplog.recordStepFailed(node.step_id, `container '${node.step_id}' failed`);
      } else {
        const outputs: Record<string, unknown> = {};
        if (node.outputs && node.outputs.length > 0) {
          const parentScope = getWriteScope(node.step_id, this.spec!);
          for (const decl of node.outputs) {
            outputs[decl.name] = this.variables.read(decl.name, parentScope);
          }
        }
        this.hoplog.recordStepDone(node.step_id, Object.keys(outputs).length > 0 ? outputs : undefined);
      }
    }
  }

  // 返回 work_zone 工作区绝对路径,从 persistence 透传给 NextResponse 和 PromptAssembler。// @a: anc-exec-work-zone
  // LLM 注入面内联真值标志（BUG-H,^anc-exec-llm-inline-context）：standalone 裸 API LLM 无文件
  // 工具,$file 指针=死引用→就地编造。StepDispatcher 构造时置 true,三注入面（L4 inputs/L2d
  // doc-ref 大节/L2e hop_env 表）跳过 deflate 直接内联。复用模式恒 false 指针语义照旧。
  // @a: anc-exec-llm-inline-context
  private inlineLlmContext = false;
  setInlineLlmContext(v: boolean): void { this.inlineLlmContext = v; }
  getInlineLlmContext(): boolean { return this.inlineLlmContext; }

  getWorkZone(): string {
    return this.persistence?.getWorkZone() ?? '';
  }

  // 直读 step 的 ← inputs 取原始值——绕过 PromptAssembler 截断/deflate,
  // 用于 paused.context 等需要原始数据的人通道场景。// @a: anc-exec-audience-routing
  private resolveRawInputs(step: StepNode): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (!step.inputs || !this.spec) return result;
    const scopeId = getWriteScope(step.step_id, this.spec);
    for (const binding of step.inputs) {
      result[binding.name] = this.variables.read(binding.source, scopeId);
    }
    return result;
  }

  // 大内容阈值传递:遍历 record,单个值 JSON.stringify().length > DEFLATE_THRESHOLD 时
  // 写入 work_zone/vars/<key>.json,响应里替换为 {$file: abs_path} 指针。
  // driver 遇 $file 时 Read 取真实值。见 design/shared-types.md ^anc-exec-deflate。
  // @a: anc-exec-deflate
  // namespace：可选子目录名，用于隔离共享 work_zone/vars 的多写者（见 ^anc-exec-deflate 多 child 命名空间隔离）。
  // for-each 的 N 个 child 共享父 work_zone/vars 且 params_for_child 同名（itemVar），必须按 child_step_id 隔离，
  // 否则超阈值的多个 child 写同一 vars/<name>.json 互相覆盖、$file 指针张冠李戴。
  private deflateValues(record: Record<string, unknown>, namespace?: string): Record<string, unknown> {
    const workZone = this.getWorkZone();
    if (!workZone) return record;  // 独立模式 work_zone 空,不做 deflate
    const varsDir = namespace ? join(workZone, 'vars', namespace) : join(workZone, 'vars');
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value === null || value === undefined) { result[key] = value; continue; }
      const serialized = JSON.stringify(value);
      if (serialized.length > DEFLATE_THRESHOLD) {
        const filePath = join(varsDir, `${key}.json`);
        mkdirSync(varsDir, { recursive: true });  // namespace 子目录按需创建（vars/ 已由 initExecution 建）
        writeFileSync(filePath, serialized, { mode: 0o600 });
        result[key] = { $file: filePath };
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  // steps 缺省用 this.spec（运行期）；init 期 this.spec 未设，可显式传 ast.steps。
  private findStepById(stepId: string, steps?: StepNode[]): StepNode | null {
    const search = (nodes: StepNode[]): StepNode | null => {
      for (const step of nodes) {
        if (step.step_id === stepId) return step;
        if (hasChildren(step)) {
          const found = search(getChildren(step));
          if (found) return found;
        }
      }
      return null;
    };
    return search(steps ?? this.spec?.steps ?? []);
  }

  private collectOutputs(): Record<string, unknown> {
    const declared = this.spec?.header.outputs ?? [];
    const result: Record<string, unknown> = {};
    for (const decl of declared) {
      result[decl.name] = this.variables.read(decl.name, 'root');
    }
    return result;
  }

  /** 未赋值声明输出清单（完备性违约检查——终态收尾调）。worker 子实例(subtreeRoot)豁免：
   * 只负责子树,父 spec 顶层 Outputs 由父实例 join 后检查。见 [[exec-engine]] 完备性违约条款。
   * 2026-08-17 hopissues/hoplogic3/0001:原 warn 照发 completed="completed 零产出"假绿混进
   * 全链强信号,父层 reap 才炸 CALL_OUTPUT_MISSING 离病灶隔一层——升 failed。// @a: anc-exec-output-completeness */
  private unassignedOutputs(): string[] {
    if (this.subtreeRoot) return [];
    // 无 Steps 的能力声明 spec（HopTrait 形态）豁免——没有步骤就没有兑现义务,与静态闸 P10 同律
    if ((this.spec?.steps?.length ?? 0) === 0) return [];
    const missing: string[] = [];
    for (const decl of this.spec?.header.outputs ?? []) {
      const value = this.variables.read(decl.name, 'root');
      if (value === null || value === undefined) missing.push(decl.name);
    }
    return missing;
  }

  private assembleBasicContext(step: StepNode): AssembledContext {
    const hasKnowledge = !!this.hostConfig?.knowledge_provider;
    const assembler = new PromptAssembler(this, hasKnowledge);
    const context = assembler.assembleReasonContext(step);
    this.resolveStepDocRefs(step, context);
    this.attachHopEnvTable(context);
    return context;
  }

  // L2e hop_env 值表注入：spec 文本引用了任一 hop_env_* 键且表非空才渲染（零引用零表,不白占 token）。
  // instruction 不做引擎展开（散文花括号歧义面大）——值表随 prompt 注入,执行 LLM 见表自行指代。
  // 单值超阈走 $file 卸载同款（deflateValues）。// @a: anc-exec-hop-env-table
  private hopEnvReferenced: boolean | null = null;   // 引用检测缓存（每实例判一次）
  // 引用检测不依赖 rawSource——load 恢复的实例无原文（复用模式 next/done 独立进程全经 load,
  // 依赖 rawSource 则值表在跨进程路径永不注入,review 实抓）;降级从 AST 序列化检测
  //（serializeSpec 有损禁用于重建,子串检测是合法用途——instruction/inputs 均在序列化面内）。
  private specReferencesHopEnv(): boolean {
    if (this.hopEnvReferenced !== null) return this.hopEnvReferenced;
    const src = this.rawSource ?? (this.spec ? serializeSpec(this.spec) : '');
    this.hopEnvReferenced = src.includes('hop_env_');
    return this.hopEnvReferenced;
  }
  private attachHopEnvTable(context: AssembledContext): void {
    const table = this.hostConfig?.hop_env;
    if (!table || Object.keys(table).length === 0) return;
    if (!this.specReferencesHopEnv()) return;
    // inline 标志下不卸载（standalone 裸 API LLM 读不了 $file——BUG-H）// @a: anc-exec-llm-inline-context
    const deflated = this.inlineLlmContext ? { ...table } : this.deflateValues({ ...table });
    const lines = Object.entries(deflated).map(([k, v]) =>
      typeof v === 'string' ? `${k}: ${v}` : `${k}: 全文见 $file: ${(v as { $file: string }).$file}（请 Read）`);
    context.hop_env_table = lines.join('\n');
  }

  // doc-ref [[doc#章节]] 解析——两模式共享基座(assembleBasicContext)，复用模式也生效。
  // 找不到文件/章节即抛 DocRefError（caller 在 nextStep 兜底 failStep）。// @a: anc-exec-doc-ref-resolve
  private resolveStepDocRefs(step: StepNode, context: AssembledContext): void {
    const host = this.hostConfig;
    if (!host?.workspace_dir) return; // 无 workspace（如纯 AST 测试）跳过
    // spec 级（Constraints，对所有步骤可见）+ 步骤级，合并去重。
    // minimal 非首步：跳过 spec 级 doc-ref（跨步不变，首步已给），仅保步骤级。见 ^anc-exec-context-mode。
    // @a: anc-exec-context-mode
    const lean = this.isMinimalNonFirst();
    const specRefs = lean ? [] : (this.spec?.header.doc_refs ?? []);
    const refs = [...specRefs, ...(step.doc_refs ?? [])];
    if (refs.length === 0) return;
    const seen = new Set<string>();
    const uniq = refs.filter(r => {
      const k = `${r.doc} ${r.section}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // inline 标志（v2 ^anc-exec-llm-inline-context）:workZone 照传（预览通道要落全文盘）,
    // inlinePreview=true——中小节全文内联,超 INLINE_PREVIEW_MAX 大节转预览条目（真内容节选
    // 非 $file 死引用;旧形态=空串 workZone 一刀切全内联,ppt4 41K 变量 12 处重复内联 57% 超线的病根同族）
    // specDir=两级基准第一级（spec 自带材料随 spec 走）;specPath 缺席（内存态）时 undefined 跳过该级
    // 修订短 prompt 免注入（走查缺陷 B:设计明写短 prompt"不带生成教材",而 doc-ref 注入在
    const fragments = resolveDocRefs(uniq, host.workspace_dir, host.sandbox, this.getWorkZone(), host.hop_env, this.specPath ? dirname(resolve(this.specPath)) : undefined, this.inlineLlmContext);   // hop_env 展开随注入 // @a: anc-exec-doc-ref-hop-env, anc-exec-doc-ref-resolve
    const text = formatDocRefContext(fragments);
    if (text) context.doc_ref_context = text;
    // HopLog 流控字段延后记录——此刻 step 尚未 recordStepStart（在本方法之后），
    // 立即 recordStepMeta 会被 guardOrphan 拦截。暂存，recordStepStart 后由 flushDocRefMeta 落账。
    this.pendingDocRefSources = fragments.map(f => `${f.doc}#${f.section}`);
  }

  private pendingDocRefSources: string[] = [];

  // 在 recordStepStart 之后落 doc-ref 流控字段（绕开 guardOrphan 时序问题）。// @a: anc-exec-doc-ref-resolve
  private flushDocRefMeta(stepId: string): void {
    if (this.pendingDocRefSources.length === 0) return;
    const at = new Date().toISOString();
    this.hoplog?.recordStepMeta(stepId, {
      doc_refs: this.pendingDocRefSources.map(source_id => ({ source_id, at })),
    });
    this.pendingDocRefSources = [];
  }

  // L2c 重试反馈落账（info 级流控字段——数据源与 prompt 装配同一个 getActiveRetryFeedback,
  // 单一语义单一来源;首跑无反馈不落。设计 spec-observability ^anc-obs-log-levels 2026-08-22 补条:
  // 只藏在 debug 级 prompt 全文里时,info 日志让走查者误判"重试无记忆"〔ppt11 实撞〕）。
  // @a: anc-exec-l2c-retry-feedback
  private flushRetryFeedbackMeta(stepId: string): void {
    const fb = this.getActiveRetryFeedback(stepId);
    if (!fb) return;
    this.hoplog?.recordStepMeta(stepId, { retry_feedback: fb });
  }

  private determineExecutionStatus(): 'running' | 'paused' | 'completed' | 'failed' | 'aborted' {
    // aborted 凌驾步骤态推导（^anc-exec-abort 第5条）：步骤还停在 running/pending,
    // 但实例已死——status 如实,账不谎报。
    if (this.terminalState === 'aborted') return 'aborted';
    // failed/completed 终态标记同凌驾（todo/0058——init 后失败〔Tools 对账拒〕时步骤全
    // pending,纯步骤态推导恒 running:就算 markInitFailed 落了盘,load 后 getStatus 照样
    // 谎报。终态标记是 0043 立的权威信号,状态推导必须先消费它——步骤态推导只兜"无标记
    // 的存量快照"）。// @a: anc-exec-state-persistence
    if (this.terminalState === 'failed') return 'failed';
    if (this.terminalState === 'completed') return 'completed';
    // paused 档（todo/0081——终态凌驾之后、步骤态推导之前）：停驻等外部应答如实转述。
    // 此前枚举缺 paused,停驻报 running——看护方接 CLI status 通道感知不到"引擎在等人",
    // 停点挂死（2026-09-09 实撞 30+ 分钟）。判定三源见 detectPausedState。
    // // @a: anc-cli-status-response
    if (this.detectPausedState()) return 'paused';
    const steps = this.spec?.steps ?? [];
    if (steps.length === 0) return 'completed';

    const allTerminal = this.allTopLevelTerminal(steps);

    if (!allTerminal) return 'running';
    if (steps.some(s => this.stepStates.get(s.step_id) === 'failed')) return 'failed';
    return 'completed';
  }

  /** 停驻检测三源（^anc-cli-status-response paused 判定三源——状态源优先,不依赖递送件;
   * todo/0081）：①escalate 停驻=escalatePending 在场（state.json 持久化跨进程可靠）;
   * ②confirm/ask 停驻=某 running 态步骤的 step_type∈{confirm,ask}（暂停态由 running
   * 编码,^anc-exec-pause-persist）;③盘卡 paused.json 在场且经陈卡对账（卡 step_id 在
   * 步骤账里仍 running 才认——卡是递送件非状态源,崩溃路径可残留陈卡;对账纪律与 MCP
   * run_status 兜底路同款）。pause_reason 优先取卡内值,无卡按判源推。已知边界（设计
   * 显式不覆盖）：network 暂停由 dispatcher 内存组装、不落卡、步骤回置 pending——快照
   * 侧结构性判不出,且是非人工停点不在感知痛点面。 // @a: anc-cli-status-response */
  private detectPausedState(): { reason: string; stepId: string } | null {
    // 源③优先读卡（卡有完整 pause_reason）,但必须过陈卡对账
    const card = this.readPausedCardRaw();
    if (card && typeof card['step_id'] === 'string') {
      const cardStep = card['step_id'] as string;
      if (this.stepStates.get(cardStep) === 'running') {
        const reason = typeof card['pause_reason'] === 'string' ? card['pause_reason'] as string : 'unknown';
        return { reason, stepId: cardStep };
      }
      // 陈卡（步已非 running）——不认,落到状态源判据
    }
    // 源①：escalate 停驻（无卡场景的持久信号）
    if (this.escalatePending) return { reason: 'escalate', stepId: this.escalatePending };
    // 源②：running 态的 confirm/ask 步型
    for (const [id, state] of this.stepStates) {
      if (state !== 'running') continue;
      const node = this.findStepById(id);
      if (node && (node.step_type === 'confirm' || node.step_type === 'ask')) {
        return { reason: node.step_type === 'confirm' ? 'confirm' : 'ask', stepId: id };
      }
    }
    return null;
  }

  /** 实例主动中止（^anc-exec-abort——todo/0007 第3项,用户"不要了"的暗管）。
   * 行为契约六条见设计;流程:终态检查→置位→落账→返回。中间步骤不追改（中止那一刻的现场保真）。
   * // @a: anc-exec-abort */
  abort(reason?: string): AbortResponse | CommandResponse {
    // 1. 终态检查：已 aborted 幂等重放;completed/failed 拒改写（事实不被意图覆盖）
    if (this.terminalState === 'aborted') {
      return { status: 'ok', instance_id: this.instanceId, execution_status: 'aborted', abort_reason: this.abortReason ?? '(user abort)' };
    }
    if (this.terminalState === 'completed' || this.terminalState === 'failed') {
      return { status: 'error', code: ErrorCode.INVALID_STATE, message: `ABORT_TERMINAL_CONFLICT: 实例已 ${this.terminalState}——干完的活不能追改成"放弃"（同态重放合法,异态改写非法）` };
    }
    // 2. 置终态 + 3. 落账（persist 带 terminal_state+abort_reason;hoplog 有终章）
    this.terminalState = 'aborted';
    this.abortReason = reason ?? '(user abort)';
    this.recordEvent('', 'execution_aborted', this.abortReason);
    this.persist();
    this.hoplog?.close('aborted');
    this.hoplog?.flush();
    return { status: 'ok', instance_id: this.instanceId, execution_status: 'aborted', abort_reason: this.abortReason };
  }

  private getFailureReason(stepId: string): string {
    return this.stepFailReasons.get(stepId)?.reason ?? 'Unknown failure';
  }

  private handleFailStepRetry(stepId: string, reason: string): void {
    let subtask = this.findNearestSubtaskAncestor(stepId, true);   // 失败路径:退火跳级留痕 // @a: anc-exec-commit-anneal

    // 升级链围栏（0018——worker 越围栏根因）：worker 子实例（subtreeRoot 在场）的失败升级
    // 不得越过子树根——子树外祖先 subtask 是父实例的事务边界,不是本 worker 的。越界取用的
    // 后果链:resetSubtaskForRetry 把 executeSubtreeOnly 预标 skipped 的子树外步骤整树放活,
    // worker 拿空数据重跑全 spec 成假 completed,内祖先 loop 传送带把 unitVar 复位 null 写
    // root,父收割 completed+null 进 collect——hopkb 11 讲批 marked=[null×6] 实录。
    // subtreeRoot 自身/子树内祖先耗尽 → 走下方"无事务边界祖先"终局分支,实例 failed 交父收割。
    // design parallel-execution 升级链围栏条款。// @a: anc-exec-parallel-subinstance
    if (subtask && this.subtreeRoot
        && subtask.step_id !== this.subtreeRoot
        && !subtask.step_id.startsWith(this.subtreeRoot + '.')) {
      subtask = null;
    }

    if (!subtask) {
      // 未捕获失败 = 实例终止（2026-08-09 函数级 fail 定稿）：无事务边界祖先（或耗尽到顶递归至此）
      // → 后续步骤不再执行——所有未终态步骤标 skipped（同 confirm reject 的全局中止形态），
      // 值空间不清理，caller 拿到 failed+FailRecord+部分产出。原"裸失败定格记账执行不停"废。
      // 见 design/exec-engine.md ^anc-exec-none-propagation fail_step 3.1。
      delete this.toolJournal[stepId];
      delete this.timeJournal[stepId];   // @a: anc-exec-time-builtins
      delete this.cmdJournal[stepId];   // @a: anc-exec-subprocess-run
      for (const [id, status] of this.stepStates) {
        if (id !== stepId && (status === 'pending' || status === 'running')) {
          this.stepStates.set(id, 'skipped');
        }
      }
      // 实例级终止标记：容器级联（含 failed child 的祖先链）不允许吞掉这次失败
      this.terminalFailure = { stepId, reason };
      this.propagateAndRecord(stepId);
      return;
    }

    // 退火边界直达兜底（^anc-exec-on-fail 与 ^anc-exec-commit-anneal 交互）：finder 只放行
    // 带未激活兜底的退火边界——不扣预算不重跑,立即激活兜底（防不可逆重放,善后照走）。
    if (this.hasCommitInRetryScope(subtask.step_id)) {
      if (this.activateOnFail(subtask, stepId)) return;
      this.markSubtaskFailed(subtask);   // 兜底已用/意外缺失——照常上浮
      return;
    }

    // 确定性失败分两档（^anc-exec-deterministic-no-retry,2026-08-23 dr7 立;2026-09-04 作者拍
    // 乙案改定〔决策档案 todo/decision/20260904-确定性错误免预算不提前兜底.md〕——0037 实撞:
    // OUTPUT_TRUNCATED 提前激活兜底又被兄弟步正常重试冲掉,两机制打架;关键澄清:确定性分事务级
    // 与步级瞬态,判据=失败根因在"结构/子层"还是"本轮输入"）：
    // **事务级（直达兜底不变）**——DEPTH_EXCEEDED(结构属性重跑不变)/CalleeFailure(子层已烧尽
    // 父层重跑=再赌)/CONTEXT_OVERFLOW(材料总量超窗,重试追加反馈只增不减)/fail_kind 枚举(产错方
    // 显式标记含 SCHEMA_MISMATCH 确定性档)。
    // **步级瞬态（乙案:免扣预算继续重试,兜底问人恒等预算耗尽单入口）**——OUTPUT_TRUNCATED(输出
    // 超长绑定本轮生成选择,下轮反馈工单变了输入就变)/THINKING_EXHAUSTED(反刍绑定本轮输入形态)。
    // 免预算有界化:同步骤同前缀首次免扣,复发照扣(deterministicWaived 记账随快照持久——裸免=
    // 预算永不减兜底 ask 永不到,比旧形态更糟)。adaptive 不豁免。
    // @a: anc-exec-deterministic-no-retry
    const failRec = this.stepFailReasons.get(stepId);
    const transactionalDeterministic = failRec?.fail_kind === 'deterministic'
      || reason.startsWith('DEPTH_EXCEEDED:')
      || reason.startsWith('CalleeFailure:')
      || reason.includes('CONTEXT_OVERFLOW:');   // 压缩降级后仍超模型窗——重发必然同因更大(0070 四连撞实撞)// @a: anc-exec-toolloop-ctx-degrade
    if (transactionalDeterministic) {
      this.recordEvent(subtask.step_id, 'retry', 'skipped: deterministic failure（事务级——重跑必然同因,直达兜底）');
      if (this.activateOnFail(subtask, stepId)) return;   // 兜底照走（善后非重放）
      this.markSubtaskFailed(subtask);
      return;
    }
    const stepTransient = reason.includes('OUTPUT_TRUNCATED:')   // 步级瞬态:下轮带新反馈输入即变（0037 环二 9 轮修过关实证）
      || reason.includes('THINKING_EXHAUSTED:');   // @a: anc-exec-thinking-exhausted
    if (stepTransient) {
      const truncPrefix = reason.includes('OUTPUT_TRUNCATED:') ? 'OUTPUT_TRUNCATED' : 'THINKING_EXHAUSTED';
      const waiveKey = `${stepId}|${truncPrefix}`;
      if (!this.deterministicWaived.has(waiveKey)) {
        this.deterministicWaived.add(waiveKey);
        this.recordEvent(subtask.step_id, 'retry', `deterministic failure—免扣预算（步级瞬态首撞:${truncPrefix},带新反馈重跑;同步骤同前缀复发照扣）`);
        this.resetSubtaskForRetry(subtask);
        this.persist();
        return;
      }
      // 复发——瞬态假设对本事务被证伪,落正常重试路径照扣预算（不 return,继续走下方阶梯）
      this.recordEvent(subtask.step_id, 'retry', `deterministic failure 复发（${truncPrefix} 同步骤二撞——照扣预算走正常阶梯）`);
    }

    const retryMax = subtask.retry ?? 3;   // 概念层缺省 3（subtask 总是内置事务边界,2026-08-09 作者确认——原 ?? 1 与概念不符）
    if (!this.retryCounters.has(subtask.step_id)) {
      this.retryCounters.set(subtask.step_id, retryMax);
    }
    const remaining = this.retryCounters.get(subtask.step_id)!;

    if (remaining <= 0) {
      if (this.activateOnFail(subtask, stepId)) return;   // 耗尽先看兜底（^anc-exec-on-fail）// @a: anc-exec-on-fail
      this.markSubtaskFailed(subtask);
      return;
    }

    this.retryCounters.set(subtask.step_id, remaining - 1);

    // 已用失败次数（含本次）：第 1 次失败 attemptsUsed==1。升级阶梯按此判级。
    const attemptsUsed = retryMax - remaining + 1;

    const history = this.retryHistory.get(subtask.step_id) ?? [];
    history.push({
      attempt: attemptsUsed,
      failure_reason: reason,
      steps_tried: this.summarizeChildren(subtask),
    });
    this.retryHistory.set(subtask.step_id, history);

    this.recordEvent(subtask.step_id, 'retry', `attempt ${attemptsUsed}/${retryMax}`);

    // 升级阶梯（见概念 ^anc-exec-retry-adaptive / 设计 exec-engine fail_step 3.2/3.3）：
    // retry=N 总失败预算。第 1 次失败 → 带反馈重跑（相同结构，失败说明经 L2c 注入，
    // 见 prompt ^anc-exec-l2c-retry-feedback）；adaptive 且第 2 次起 → 重规划结构。
    // 无 adaptive → 每次都机械重跑。 // @a: anc-exec-retry-adaptive
    if (subtask.adaptive && attemptsUsed >= 2) {
      this.adaptiveNeededSubtask = subtask.step_id;
      return;
    }

    this.resetSubtaskForRetry(subtask);
  }

  // L2c 重试反馈源：返回 stepId **祖先链上全部重试容器**的失败史——主反馈=链上最近发生失败的
  // 那个容器的最后一条（按 execEvents retry 事件序判新旧）,此前压缩行 5 条封顶超出丢最旧。
  // 两处升级（2026-08-23）：①原"仅最近一条"废——多约束节点每攻只见最后一条失败,修东墙拆西墙
  // 打地鼠（ppt11 三面墙/dr7 两缺口同型实撞）;②原"仅最近祖先"废——两层事务分层（D39）下外层
  // 意见闸失败重跑,内层步骤只看到内层的旧机械失败,外层的作者意见够不着（探针实抓:主反馈是
  // "机械缺陷A"而非"打回意见X"——意见永远到不了重拆现场,分层白做）。
  // 无重试容器或全链无历史 → undefined（首跑不渲染）。// @a: anc-exec-l2c-retry-feedback
  getActiveRetryFeedback(stepId: string): { attempt: number; reason: string; prior?: string[] } | undefined {
    // 首跑步骤不注入（hopissues/0073——重试反馈的语义是"重做的活要保持已落实的修正",
    // 首次执行的步骤没有旧活可保持,注入祖先容器的打回工单是受众错位:实撞 step 1.1
    // 一次重试成功后,同容器 1.6.1/1.8.1 等首跑步骤 prompt 全带 stale 工单。判据机械=
    // 重跑参与者才注入:本步 step_start 事件≥2 次（失败轮+重跑轮——含容器重置连带重跑的
    // 兄弟步,它们的已落实修正正是要保持的）或本步自己有失败记录（首轮失败当轮反馈）;
    // start 恰 1 次且零失败史且零升层史=纯首跑,不注入（升层豁免:escalate 问路的步骤
    // 无失败记录但人给的指引正是它重跑要吃的——^anc-exec-check-escalate 反馈借道本通道）。
    // @a: anc-exec-l2c-retry-feedback
    const startCount = this.execEvents.filter(e => e.step_id === stepId && e.event === 'step_start').length;
    if (startCount <= 1 && !this.stepFailReasons.has(stepId)
        && !this.execEvents.some(e => e.step_id === stepId && e.event === 'escalate')) return undefined;
    // 祖先链收集（带 worker 子树围栏——与 handleFailStepRetry 同款,不越 subtreeRoot）
    const chain: { id: string; history: RetryRecord[] }[] = [];
    let id = stepId;
    while (id.includes('.')) {
      id = id.slice(0, id.lastIndexOf('.'));
      if (this.subtreeRoot && id !== this.subtreeRoot && !this.subtreeRoot.startsWith(id + '.') && !id.startsWith(this.subtreeRoot + '.') ) break;
      const node = this.findStepById(id);
      if (node && (node.step_type === 'subtask' || node.step_type === 'case')) {
        const h = this.retryHistory.get(id);
        if (h && h.length > 0) chain.push({ id, history: h });
      }
    }
    if (chain.length === 0) return undefined;
    // 主容器=最近发生 retry 事件的那个（事件流从尾扫;无事件命中回退最近祖先）
    let primary = chain[0];
    if (chain.length > 1) {
      for (let i = this.execEvents.length - 1; i >= 0; i--) {
        const ev = this.execEvents[i];
        if (ev.event !== 'retry') continue;
        const hit = chain.find(c => c.id === ev.step_id);
        if (hit) { primary = hit; break; }
      }
    }
    // 历史行单条 4000（v0.7.1 作者定"800 也太少"——dr16 实测工单全文最大 3101 chars,
    // 旧 200 把多项工单切剩开头一截,'一次看全所有已撞过的墙'在历史条目上没兑现;
    // 5 条封顶 ×4000≈4K tokens,对百 K 级窗口九牛一毛,体量靠条数封顶不靠切行）。
    const trunc = (s: string) => s.length > 4000 ? s.slice(0, 4000) + '…' : s;
    const last = primary.history[primary.history.length - 1];
    // 主容器回溯 4 条,外围容器各带最后一条追加尾部;总量 4 条封顶——尾部截留让外围（如外层
    // 作者意见）优先存活,被挤掉的是主容器最旧的。
    const prior = [
      ...primary.history.slice(0, -1).slice(-4).map(h => `第 ${h.attempt} 次:${trunc(h.failure_reason)}`),
      ...chain.filter(c => c !== primary).slice(0, 2)
        .map(c => { const l = c.history[c.history.length - 1]; return `（外围容器 ${c.id} 第 ${l.attempt} 次:${trunc(l.failure_reason)}）`; }),
    ].slice(-4);
    return { attempt: last.attempt, reason: last.failure_reason, ...(prior.length ? { prior } : {}) };
  }

  /** on fail 兜底步失败上下文（^anc-exec-onfail-context,todo/0078）：stepId 的祖先链上有
   * 激活态（onFailActive）on_fail 节点时,收其宿主容器的失败账渲染成人话;否则 undefined
   *（非兜底步零影响零成本）。数据源双形态合并——retryHistory（retry>0 耗尽场景,逐轮）∪
   * stepFailReasons（容器内 failed 子步 reason——retry=0/确定性失败场景 retryHistory 空,
   * 真机探针实证单靠它必漏）;两源皆空给兜底行不静默缺席。措辞对善后者,不越位指挥。
   * // @a: anc-exec-onfail-context */
  getOnFailContext(stepId: string): string | undefined {
    // 祖先链找激活态 on_fail 节点
    let onFailId: string | null = null;
    let id = stepId;
    while (id.includes('.')) {
      id = id.slice(0, id.lastIndexOf('.'));
      // worker 子树围栏——与 getActiveRetryFeedback 同款,不越 subtreeRoot（review 补对称:防御纵深一致）
      if (this.subtreeRoot && id !== this.subtreeRoot && !this.subtreeRoot.startsWith(id + '.') && !id.startsWith(this.subtreeRoot + '.')) break;
      const node = this.findStepById(id);
      if (node?.step_type === 'on_fail' && this.onFailActive.has(id)) { onFailId = id; break; }
    }
    if (!onFailId) return undefined;
    // 宿主容器=on_fail 节点的父级
    const hostId = onFailId.slice(0, onFailId.lastIndexOf('.'));
    const lines: string[] = [];
    // 源①：宿主容器的重试历史（retry>0 耗尽场景——逐轮原因）
    const history = this.retryHistory.get(hostId) ?? [];
    for (const h of history.slice(-4)) {
      // 升层指引记录行首定性跟随记录本性——问路不是失败（review 面二抓:借道 retryHistory 的
      // 【升层指引】记录被渲染成"重试失败",如实转述场景会把人的指引当失败史转述出去）
      const isGuidance = h.failure_reason.startsWith('【升层指引】');
      const label = isGuidance ? '升层指引' : '重试失败';
      lines.push(`- 第 ${h.attempt} 轮${label}:${h.failure_reason.length > 2000 ? h.failure_reason.slice(0, 2000) + '…' : h.failure_reason}`);
    }
    // 源②：宿主容器内 failed 态子步的失败原因（retry=0/确定性失败场景 retryHistory 为空,此源必需）
    const host = this.findStepById(hostId);
    if (host) {
      const walk = (n: StepNode): void => {
        if (n.step_type === 'on_fail') return;   // 兜底子树自身不入账
        if (this.stepStates.get(n.step_id) === 'failed') {
          const rec = this.stepFailReasons.get(n.step_id);
          if (rec) {
            const reason = rec.reason.length > 2000 ? rec.reason.slice(0, 2000) + '…' : rec.reason;
            const line = `- 步骤 ${n.step_id}（${n.summary}）失败:${reason}`;
            if (!lines.some(l => l.includes(reason.slice(0, 80)))) lines.push(line);   // 与重试史同因去重（首 80 字符判重）
          }
        }
        for (const c of getChildren(n)) walk(c);
      };
      for (const c of getChildren(host)) walk(c);
    }
    if (lines.length === 0) lines.push('- （容器失败,无失败详情记录）');
    return `此前失败情况（供你善后引用,如实转述,不要试图修复）:\n${lines.join('\n')}`;
  }

  // confirm answer 决策值提取：从 caller 注入的 answer 取 decision/value/answer 键或单值。
  // 见 ^anc-exec-confirm-answer。
  private extractDecision(answer?: Record<string, unknown>): unknown {
    if (!answer) return undefined;
    if ('decision' in answer) return answer['decision'];
    if ('value' in answer) return answer['value'];
    if ('answer' in answer) return answer['answer'];
    const vals = Object.values(answer);
    return vals.length === 1 ? vals[0] : undefined;
  }

  // confirm approve → bool 槽写 true（纯审批闸门，+→ 仅 bool）。reject 已在调用处全局中止，到此必是 approve。
  // 见 ^anc-exec-confirm-answer。
  private mapConfirmOutputs(
    node: StepNode,
    answer: Record<string, unknown> | undefined,
    decision: unknown,
  ): Record<string, unknown> {
    const decls = node.outputs ?? [];
    if (decls.length === 0) return answer ?? {};
    const mapped: Record<string, unknown> = {};
    for (const d of decls) {
      mapped[d.name] = true;  // approve → bool true（confirm 收窄为纯审批，所有声明输出都是 bool 审批槽）
    }
    return mapped;
  }

  // ask answer → 数据值落到 +→ 声明变量名。caller answer 三种形态：
  // ①{声明名:值} 直接采用 ②{value:值}/单值包装 → 落到首个声明名 ③approve/空 → 采用 default_value（前序推断）
  // 见 ^anc-step-ask / ^anc-exec-hitl-presentation。// @a: anc-step-ask, anc-exec-hitl-presentation
  private mapAskOutputs(
    node: StepNode,
    answer: Record<string, unknown> | undefined,
    stepId: string,
  ): Record<string, unknown> {
    const decls = node.outputs ?? [];
    if (decls.length === 0) return answer ?? {};
    // ① answer 的 key 已匹配声明名 → 直接采用
    if (answer && decls.some(d => d.name in answer)) return answer;
    const raw = this.extractDecision(answer);
    const mapped: Record<string, unknown> = {};
    // ③ approve 快捷：采用 default_value（首个声明在前序产出中的同名推断值）
    const isApproveShortcut = raw !== undefined && String(raw).toLowerCase() === 'approve';
    for (const d of decls) {
      if (isApproveShortcut) {
        // 采用前序推断默认值（从当前 scope 自底向上读同名）
        const scopeId = getWriteScope(stepId, this.spec!);
        mapped[d.name] = this.variables.read(d.name, scopeId);
      } else {
        // ② 用 caller 提供的值
        mapped[d.name] = raw;
      }
    }
    return mapped;
  }

  // 重试容器祖先查找：subtask 或 case（case 就是 branch 下的 subtask，retry 语义相同）。
  // commit 退火跳级（2026-08-20 作者定,概念 ^anc-step-commit 退火条）：候选边界子树内已有
  // commit 执行过（committedSteps 前缀交）→ 该边界退火不入选,继续向上——防 commit 随整组
  // 重跑再次执行。全部退火=null（未捕获失败,实例终止）。// @a: anc-exec-commit-anneal
  private findNearestSubtaskAncestor(stepId: string, recordAnneal = false): RetryContainer | null {
    let current = getParentStepId(stepId);
    while (current) {
      const step = this.findStepById(current);
      if (step && (step.step_type === 'subtask' || step.step_type === 'case')) {
        if (!this.hasCommitInRetryScope(step.step_id)) return step as RetryContainer;
        // 退火边界带未激活兜底块 → 仍入选（失败跳过 retry 阶梯直达兜底激活——退火拦"重跑重放",
        // 兜底是善后不重放;handleFailStepRetry 对退火边界不走 retry 只走 activateOnFail）。
        // // @a: anc-exec-on-fail
        const onFail = getChildren(step).find(c => c.step_type === 'on_fail');
        if (onFail && !this.onFailConsumed.has(onFail.step_id)) return step as RetryContainer;   // 判消耗集非激活集（激活/消耗分离——已激活未消耗=兜底还在路上,边界仍可入选）
        // 留痕只在失败处理路径（getActiveRetryFeedback 等读路径不发事件——读不改状态）
        if (recordAnneal) this.recordEvent(step.step_id, 'retry', '边界退火跳过：子树内 commit 已执行,retry 不可用（防不可逆动作重放）');
      }
      current = getParentStepId(current);
    }
    return null;
  }

  // 候选边界的 retry 重跑范围是否盖到某次已执行 commit（^anc-exec-commit-anneal 判据重构）：
  // ①stepId 前缀匹配（含自身——commit 在边界子树内）;②对边界的每个祖先 loop,记录快照轮次
  // ==当前轮次（前轮的 commit 不在本边界重跑范围——祖先 loop 的 retry 只发生在当前轮内;
  // 边界子树内的 loop 不比对——整组重跑从轮 1 重来,任意轮记录都算盖到）。快照缺键（旧格式
  // 恢复）保守视为相等——宁多拦不重放。// @a: anc-exec-commit-anneal
  private hasCommitInRetryScope(containerId: string): boolean {
    let ancestorLoops: string[] | null = null;   // 懒取:边界的祖先 loop 链
    for (const [id, iters] of this.committedSteps) {
      if (id !== containerId && !id.startsWith(containerId + '.')) continue;
      if (ancestorLoops === null) {
        ancestorLoops = [];
        let cur = getParentStepId(containerId);
        while (cur) {
          const node = this.findStepById(cur);
          if (node?.step_type === 'loop') ancestorLoops.push(cur);
          cur = getParentStepId(cur);
        }
      }
      let inScope = true;
      for (const loopId of ancestorLoops) {
        const snap = iters[loopId];
        if (snap === undefined) continue;   // 缺键保守命中
        if (snap !== (this.loopCounters.get(loopId) ?? 1)) { inScope = false; break; }
      }
      if (inScope) return true;
    }
    return false;
  }

  private resetSubtaskForRetry(subtask: RetryContainer): void {
    // Python 语义：仅重置 children 步骤状态为 pending；child 输出变量**不清空**（自然保留）。
    // 重跑步骤用新产出覆盖旧值；需重跑前清空的量由作者在子步骤显式 `+ → x = Null`。
    // 原"清 subtask scope 所有 child 输出"逻辑已删（与 loop 二分同源，属已废除的引擎隐式清空）。
    // 见 [[exec-engine]] 变量作用域规则 6 / ^anc-exec-loop-var-scope。// @a: anc-exec-loop-var-scope
    this.setSubtreePending(subtask.children);
    // 嵌套事务边界的预算复位（2026-08-09 随"retry 耗尽=标准 fail 升级"补）:外层重跑给子树
    // 全新一轮机会,内层 subtask/case 的已耗预算计数须清——否则内层重跑预算恒 0 立即再耗尽,
    // 外层预算被空转烧光。异常语义对照:外层 catch 重试时内层 try 当然重新计数。
    const clearRetryCounters = (nodes: StepNode[], isTopLevel: boolean) => {
      for (const n of nodes) {
        if (n.step_type === 'subtask' || n.step_type === 'case') this.retryCounters.delete(n.step_id);
        // 外层重跑给子树全新一轮——嵌套边界的兜底激活/消耗标记同批清（与预算复位同法理）。
        // 本容器自身的兜底标记不清（正在处理本容器失败的是外层,本容器兜底状态由本容器的失败
        // 处置链管——顶层遍历跳过直属 on_fail,只清嵌套层。0037 实撞:旧代码从 children 起一视
        // 同仁全删,提前激活的兜底被兄弟步正常重试静默冲掉,注释宣称的豁免从未被实现〔死法①〕）。
        // // @a: anc-exec-on-fail
        if (n.step_type === 'on_fail') {
          if (!isTopLevel) { this.onFailActive.delete(n.step_id); this.onFailConsumed.delete(n.step_id); }
          continue;   // 直属 on_fail 不下钻（其子树状态随激活/重置链管理）
        }
        if (hasChildren(n)) clearRetryCounters(getChildren(n), false);
      }
    };
    clearRetryCounters(subtask.children, true);
    // 收集账清零已收敛到 loop 入口（设计 exec-engine 收集账进入即清条款,2026-09-07——
    // 原 clearCollectLedgers 来路补丁删除:重跑时 loop 重新进入,入口一并置空两本账,
    // 本路径不再重复清。见 engine-traverse 串行 for-each 入口。）
    // 带 = 初值 声明的容器:删 scope 重灌（^anc-exec-output-init-reentry,2026-09-07 作者拍
    // "=初值 就是进入循环时执行"定性修 bug——retry 重跑=重新进入,原特判"重试是同一次进入的
    // 重做"删除。探针实证:retry 内 loop 头 findings=[] 不重灌,第一轮 2 条重跑攒 4 条翻倍。
    // 与外层轮进重入同机制（resetChildrenToPending:deleteScope）:删 scope 后下次进入
    // init-once 判据(hasScope)不成立,重建重灌;不带 default 的容器 scope 不碰。
    // 本容器自身若带 default 不在此清（清的是子树;本容器的重灌归处理它失败的外层管——
    // retry 是容器内部重做,容器自身账本轮不动）。// @a: anc-exec-output-init-reentry
    const refillDefaults = (nodes: StepNode[]) => {
      for (const n of nodes) {
        if (n.step_type === 'on_fail') continue;   // 兜底子树豁免,与聚合账清零同规
        if (CONTAINER_STEP_TYPES.has(n.step_type) && n.outputs?.some(o => o.default !== undefined)) {
          this.variables.deleteScope(n.step_id);
        }
        if (hasChildren(n)) refillDefaults(getChildren(n));
      }
    };
    refillDefaults(subtask.children);
    this.stepStates.set(subtask.step_id, 'running');
    // 重试重跑工具是预期语义——子树全部 tool_journal 必须清，否则重跑轮 act body 重放
    // 陈旧工具结果（2026-08-08 语义审计 ❌ 实抓：设计"完成/失败/重试均清"，代码只清完成路径）。
    // @a: anc-exec-tool-request
    const clearJournal = (nodes: StepNode[]) => {
      for (const n of nodes) {
        delete this.toolJournal[n.step_id];
        delete this.timeJournal[n.step_id];   // @a: anc-exec-time-builtins
        delete this.cmdJournal[n.step_id];   // @a: anc-exec-subprocess-run
        if (hasChildren(n)) clearJournal(getChildren(n));
      }
    };
    clearJournal(subtask.children);
  }

  // on_fail 兜底激活（^anc-step-on-fail;2026-09-04 激活语义三处改定——0037 实撞取证:兜底两次
  // 被"激活"但一步未执行,8h 整树重建）：容器声明兜底块且**尚未消耗**（onFailConsumed 判——
  // 激活≠消耗:激活=执行流转入,消耗=兜底子树真实走完;旧形态单集身兼两职,"已激活未执行"被当
  // "已用过"拒绝再激活〔死法②〕）→ 置子树 pending、登记激活、**on_fail 之前仍 pending 的常规
  // 子步标 skipped**（"执行流转入"的机械兑现——旧形态押在 DFS 顺序上,失败点在中位步时 DFS 先跑
  // 其后 pending 兄弟步,兄弟再败触发正常重试反把激活冲掉〔死法①〕）、容器保持 running。
  // 返回 true=已激活/已在兜底中（幂等）;false=无兜底或已消耗（调用方 fail 上浮）。
  // 兜底自身失败再进来时已在消耗集——不再兜,照常 fail 上浮（无嵌套 catch）。
  // // @a: anc-exec-on-fail
  private activateOnFail(container: RetryContainer, failedStepId?: string): boolean {
    const onFail = getChildren(container).find(c => c.step_type === 'on_fail');
    if (!onFail || this.onFailConsumed.has(onFail.step_id)) return false;
    // 兜底自身失败不再兜（无嵌套 catch）：失败点在兜底子树内=兜底这一次机会已用掉——登记消耗
    // 拒绝再激活,容器照常 fail 上浮。没有这一判,幂等分支会把自败的执行流又送回兜底无限循环。
    if (failedStepId && (failedStepId === onFail.step_id || failedStepId.startsWith(onFail.step_id + '.'))) {
      this.onFailConsumed.add(onFail.step_id);
      return false;
    }
    if (this.onFailActive.has(onFail.step_id)) return true;   // 已激活未消耗——执行流本就该在兜底里,幂等
    this.onFailActive.add(onFail.step_id);
    this.stepStates.set(onFail.step_id, 'pending');
    this.setSubtreePending(getChildren(onFail));
    // 前序 pending 常规子步标 skipped——本轮放弃（容器若后续重试,resetSubtaskForRetry 整树
    // 置 pending 照常复活,与既有重试语义自洽）。失败步自身保持 failed 不动。
    for (const sibling of getChildren(container)) {
      if (sibling.step_id === onFail.step_id) break;
      if (this.stepStates.get(sibling.step_id) === 'pending') {
        this.stepStates.set(sibling.step_id, 'skipped');
        if (hasChildren(sibling)) {
          const skipAll = (nodes: StepNode[]): void => {
            for (const n of nodes) {
              if (this.stepStates.get(n.step_id) === 'pending') this.stepStates.set(n.step_id, 'skipped');
              if (hasChildren(n)) skipAll(getChildren(n));
            }
          };
          skipAll(getChildren(sibling));
        }
      }
    }
    this.stepStates.set(container.step_id, 'running');
    this.recordEvent(container.step_id, 'retry', `retry 耗尽,转入 [on fail] 失败兜底块 ${onFail.step_id}`);
    this.hoplog?.recordWarn(container.step_id, `retry 耗尽——激活失败兜底块 ${onFail.step_id}（走完即消化失败,容器按 done 收场）`);
    this.persist();
    return true;
  }

  private markSubtaskFailed(subtask: RetryContainer): void {
    // fail 不碰值空间（2026-08-09 函数级 fail 定稿）——容器输出不置 None
    this.pendingChainFeeds = this.pendingChainFeeds.filter(f => f.chain_child_id !== subtask.step_id);   // 壳终 failed:续链待喂账销账,失败不贡献元素 // @a: anc-exec-parallel-reap-chain
    this.stepStates.set(subtask.step_id, 'failed');
    this.recordStepFailure(subtask.step_id, 'retry exhausted');
    this.hoplog?.recordStepFailed(subtask.step_id, 'retry exhausted');

    // 失败路径同语义（B 裁决 2026-08-11：调度形态不得改变执行语义,§U3）：退化窗口串行执行的
    // parallel subtask 重试耗尽=部分失败集合语义就地消化——不贡献元素（列表变短/兄弟位缺席走
    // None 传播）、主线继续，不升级宿主。与派发路径失败收割（reapParallelSubtask failure 分支）
    // 同构。worker 子实例执行该步自身（subtreeRoot）不适用——须正常失败交父实例收割。
    // FailRecord 已在本实例账上（recordStepFailure），凭据不丢。// @a: anc-exec-parallel-reap-drain
    if (subtask.step_type === 'subtask' && (subtask as SubtaskStep).parallel
        && this.subtreeRoot !== subtask.step_id
        && !this.inflight.some(f => f.step_id === subtask.step_id && f.status !== 'killed')) {
      this.recordEvent(subtask.step_id, 'parallel_reap', `serial-degraded failed: retry exhausted（集合语义不贡献元素）`);
      const hostId = this.findHostContainerId(subtask.step_id);
      this.hoplog?.recordParallelReap(hostId, `${subtask.step_id}(serial)`, 'failed');   // @a: anc-obs-parallel-reap
      // 挂宿主容器（0018 orphan 同修先例;二审实抓:挂自身则本步已终态,warn 命中 doneSteps
      // 暂存判据被误当新轮组装期告警——不再 start 时 close 兜底前缀撒谎"未start",loop 下轮
      // 再 start 时冲进 #N+1 归错轮。宿主容器仍 running,直写正确归属）
      this.hoplog?.recordWarn(hostId, `subtask parallel 串行退化失败（${subtask.step_id} 不贡献输出，主线继续）: retry exhausted`);
      // 账面形态镜像派发路径：步骤态 done（派发即推进的对应物）+失败凭据在 FailRecord/reap 事件/
      // warn 三处——failed 态会让宿主 loop 提前终态化（后续迭代丢失），与"主线继续"矛盾。
      // 声明输出不喂 collect（getAsyncUnitVars 判异步跳传送带,无 reap 喂缓冲=天然缺席）。
      this.skipAllDescendants(subtask);
      this.stepStates.set(subtask.step_id, 'done');
      // 预算按迭代独立（review 探针实撞 2026-08-11：派发路径每个子实例=全新实例各自预算；
      // 退化窗口同一 subtask 节点跨迭代复用，耗尽计数残留会让下一轮首败即判耗尽——iter2 耗尽
      // 吞掉 iter4 本可重试成功的机会）。就地消化即本迭代终局，计数/历史清零还原。
      this.retryCounters.delete(subtask.step_id);
      this.retryHistory.delete(subtask.step_id);
      this.propagateAndRecord(subtask.step_id);
      return;
    }

    // retry 耗尽 = 标准 fail（2026-08-09 作者定）——容器作为"一个步骤"继续走升级链,
    // 找外层事务边界扣其预算重跑;原实现只 propagateAndRecord(完成级联),外层 retry
    // 形同虚设,"每层 caller 在自己的 retry 范围内尝试"的监督链在第一层就断。
    this.handleFailStepRetry(subtask.step_id, `subtask '${subtask.step_id}' retry exhausted`);
  }


  private removeChildStates(parent: StepNode): void {
    if (!hasChildren(parent)) return;
    for (const child of getChildren(parent)) {
      this.stepStates.delete(child.step_id);
      this.removeChildStates(child);
    }
  }

  private reIdSteps(steps: StepNode[], parentId: string): StepNode[] {
    return steps.map((step, i) => {
      const newId = `${parentId}.${i + 1}`;
      const updated = { ...step, step_id: newId };
      if (hasChildren(updated)) {
        (updated as { children: StepNode[] }).children = this.reIdSteps(getChildren(updated), newId);
      }
      return updated;
    });
  }

  private skipAllDescendants(step: StepNode): void {
    if (!hasChildren(step)) return;
    for (const child of getChildren(step)) {
      this.stepStates.set(child.step_id, 'skipped');
      this.skipAllDescendants(child);
    }
  }

  /** 把步骤节点投影为 StepSummary（step_id/type/summary/输出名）。单点定义——四处（adaptive
   * original_children、replan 两处、summarizeChildren）复用，字段增减只改这里。 */
  private toStepSummary(node: Pick<StepNode, 'step_id' | 'step_type' | 'summary' | 'outputs'>): StepSummary {
    return {
      step_id: node.step_id,
      step_type: node.step_type,
      summary: node.summary,
      outputs: (node.outputs ?? []).map(o => o.name),
    };
  }

  private summarizeChildren(subtask: RetryContainer): StepSummary[] {
    return subtask.children.map(c => this.toStepSummary(c));
  }

  // 执行事件流——执行历史原料（L3 上下文重建用）。持久化到 state.json 的 exec_events，
  // 跨进程续上 loop 迭代时序与子步状态。HopLog 另由 recordStepStart/Done/Failed 独立写入，不互为数据源。
  private recordEvent(stepId: string, event: string, detail?: string): void {
    this.execEvents.push({ at: new Date().toISOString(), step_id: stepId, event, detail });
  }

  // 步骤失败：记事件流 + 存结构化失败原因（getFailureReason 的唯一来源，跨进程稳定）。
  private recordStepFailure(stepId: string, reason: string, failKind: FailKind = 'error'): void {
    this.recordEvent(stepId, 'step_failed', reason);
    this.stepFailReasons.set(stepId, { reason, fail_kind: failKind });
  }

  /** 终态收口（0043——四条终态出口统一走此处:置标记+persist,内存里的最终状态转移
   * 〔exit 步 done/全体 skipped〕随本次 persist 全量落盘）。幂等:标记已在场不重写。
   * // @a: anc-exec-state-persistence */
  private finalizeTerminal(status: 'completed' | 'failed'): void {
    if (this.terminalState === status) return;
    this.terminalState = status;
    this.persist();
  }

  /** init 后失败终态落盘（todo/0058——0043 的漏网半边:dispatcher 装配后 Tools 对账失败原
   * 直接 return failed 零落账,state.json 停在 init persist 的全 pending,快照消费者对死 run
   * 恒见 running〔看护实撞空轮询 12 分钟〕。本方法=置 terminal_failure+finalizeTerminal,
   * 快照与进程内响应一致）。// @a: anc-exec-state-persistence */
  markInitFailed(reason: string): void {
    this.terminalFailure = { stepId: '(init)', reason };
    this.finalizeTerminal('failed');
  }

  private persist(): void {
    if (!this.persistence || !this.spec) return;
    this.persistence.saveSnapshot({
      spec: this.spec,
      state: this.buildStateFile(),
      vars: { format_version: 2, scopes: this.variables.toJSON() },
    });
    this.hoplog?.flush();
  }

  // journal 变更即全量持久化（saveSnapshot 幂等原子写；无 persistence 场景静默跳过——内存模式测试用）
  private persistToolJournal(): void {
    try { this.persist(); } catch { /* 无持久化上下文（纯内存单测）不阻断 */ }
  }

  private buildStateFile(): StateFile {
    const step_states: Record<string, string> = {};
    for (const [k, v] of this.stepStates) step_states[k] = v;
    const retry_counters: Record<string, number> = {};
    for (const [k, v] of this.retryCounters) retry_counters[k] = v;
    const loop_counters: Record<string, number> = {};
    for (const [k, v] of this.loopCounters) loop_counters[k] = v;
    const retry_history: Record<string, RetryRecord[]> = {};
    for (const [k, v] of this.retryHistory) retry_history[k] = v;
    const step_fail_reasons: Record<string, StepFailRecord> = {};
    for (const [k, v] of this.stepFailReasons) step_fail_reasons[k] = v;
    return {
      format_version: 1,
      step_states,
      retry_counters,
      loop_counters,
      ...(Object.keys(retry_history).length ? { retry_history } : {}),
      ...(Object.keys(step_fail_reasons).length ? { step_fail_reasons } : {}),
      ...(this.execEvents.length ? { exec_events: this.execEvents } : {}),
      ...(this.logDir ? { log_dir: this.logDir } : {}),
      ...(this.hoplog ? { hoplog_run_dir: this.hoplog.getRunDir() } : {}),
      ...(this.adaptiveNeededSubtask ? { adaptive_needed_subtask: this.adaptiveNeededSubtask } : {}),
      ...(this.escalatePending ? { escalate_pending: this.escalatePending } : {}),   // 升层待答跨进程 // @a: anc-exec-check-escalate
      ...(this.terminalFailure ? { terminal_failure: this.terminalFailure } : {}),
      ...(this.terminalState ? { terminal_state: this.terminalState } : {}),   // 0043 终局有据 // @a: anc-exec-state-persistence
      ...(this.notifyChannel ? { notify_channel: this.notifyChannel } : {}),   // 复用模式通知渠道跨进程（^anc-cli-notify-reuse——每条 CLI 命令新进程,内存值活不过一条命令） // @a: anc-cli-notify-reuse
      ...(this.upstreamFeedback ? { upstream_feedback: this.upstreamFeedback } : {}),   // 父层修正意见跨进程（D41 复用半边:init 与 advance 是两个进程——同 notify_channel 先例;不落盘则跨进程断链） // @a: anc-exec-l2c-retry-feedback
      ...(this.driverChannel ? { driver_channel: this.driverChannel } : {}),   // 双执行硬闸 // @a: anc-exec-driver-channel
      ...(this.abortReason ? { abort_reason: this.abortReason } : {}),   // 中止原因入账 // @a: anc-exec-abort
      ...(this.expansionCount > 0 ? { expansion_count: this.expansionCount } : {}),   // 展开总数熔断底账（契约7——不落盘=跨进程熔断空炮）// @a: anc-exec-subtask-free-expand
      // @a: anc-exec-retry-adaptive — 重复 replan 检测跨进程稳定（两模式 replan 都跨进程）
      ...(this.lastReplanChildren.size ? { last_replan_children: Object.fromEntries(this.lastReplanChildren) } : {}),
      // @a: anc-exec-cost-guardrails — 预算护栏不被进程重启绕过
      ...(this.cumulativeTokens > 0 ? { cumulative_tokens: this.cumulativeTokens } : {}),
      ...(this.canFanout ? { can_fanout: true } : {}),
      ...(Object.keys(this.toolJournal).length ? { tool_journal: this.toolJournal } : {}),
      ...(Object.keys(this.timeJournal).length ? { time_journal: this.timeJournal } : {}),   // @a: anc-exec-time-builtins
      ...(Object.keys(this.cmdJournal).length ? { cmd_journal: this.cmdJournal } : {}),   // @a: anc-exec-subprocess-run
      ...(this.dispatched.size ? { dispatched: Object.fromEntries(this.dispatched) } : {}),
      ...(this.committedSteps.size ? { committed_steps: [...this.committedSteps].map(([step_id, iters]) => ({ step_id, iters })) } : {}),   // 带祖先 loop 轮次快照 // @a: anc-exec-commit-anneal
      ...(this.onFailActive.size ? { on_fail_active: [...this.onFailActive] } : {}),   // @a: anc-exec-on-fail
      ...(this.onFailConsumed.size ? { on_fail_consumed: [...this.onFailConsumed] } : {}),   // 消耗集持久（激活/消耗分离）// @a: anc-exec-on-fail
      ...(this.deterministicWaived.size ? { deterministic_waived: [...this.deterministicWaived] } : {}),   // 免预算记账持久 // @a: anc-exec-deterministic-no-retry
      ...(this.pendingChainFeeds.length ? { pending_chain_feeds: [...this.pendingChainFeeds] } : {}),   // 续链待喂账持久（兜底可能跨进程走完——复用模式每命令一进程,失败投递与兜底走完必然跨进程）// @a: anc-exec-parallel-reap-chain
      ...(this.inflight.length ? { inflight: [...this.inflight] } : {}),   // @a: anc-exec-parallel-inflight
      ...(this.specPath ? { spec_path: this.specPath } : {}),
      ...(this.cliAbsPath ? { cli_abs_path: this.cliAbsPath } : {}),
      ...(this.hostConfig?.resource_limits?.max_concurrent_workers != null
        ? { max_concurrent: this.hostConfig.resource_limits.max_concurrent_workers }
        : this.maxConcurrent != null ? { max_concurrent: this.maxConcurrent } : {}),
      ...(this.contextMode === 'minimal' ? { context_mode: 'minimal' as const } : {}),
      ...(this.subtreeRoot ? { subtree_root: this.subtreeRoot } : {}),
      // doc-ref/P15 跨进程 resume 需 workspace+sandbox（不落凭证）。// @a: anc-exec-doc-ref-resolve
      ...(this.hostConfig?.workspace_dir
        ? { host_context: { workspace_dir: this.hostConfig.workspace_dir, sandbox: this.hostConfig.sandbox, ...(this.hostConfig.hop_env ? { hop_env: this.hostConfig.hop_env } : {}), ...(this.hostConfig.config_project_dir ? { config_project_dir: this.hostConfig.config_project_dir } : {}) } }
        : {}),
    };
  }

  // 加载续执行：从快照重建引擎，保留 running 状态（已交付 caller、正等回写的合法持久态）。
  // 复用模式日常命令（next/done/fail/status/vars/branch/replan）的入口。
  // 概念见 [[HopSpec V3配套HopJIT运行时能力#^anc-exec-durable-resume]]。
  static load(instanceDir: string): ExecutionEngine { // @a: anc-exec-state-persistence
    const persistence = new FilePersistence(instanceDir, true);
    const snapshot = persistence.loadSnapshot();
    const specData = snapshot.spec;
    const varsData = snapshot.vars;
    const stateData = snapshot.state;

    const engine = new ExecutionEngine();
    engine.spec = specData;
    engine.persistence = persistence;

    // vars.json v2：scope 树重建；v1（或无版本）：扁平变量塞 root（向后兼容）。
    // 见 design/exec-engine.md ^anc-exec-vars-scope-persist。// @a: anc-exec-vars-scope-persist
    engine.variables = varsData.format_version === 2 && varsData.scopes
      ? VariableStore.fromScopes(varsData.scopes)
      : VariableStore.fromJSON(varsData.variables ?? {});

    // 原样重建 step_states——load 不重置 running（区别于 recover）
    for (const [stepId, status] of Object.entries(stateData.step_states)) {
      engine.stepStates.set(stepId, status as StepStatus);
    }

    for (const [k, v] of Object.entries(stateData.retry_counters)) {
      engine.retryCounters.set(k, v);
    }
    for (const [k, v] of Object.entries(stateData.loop_counters)) {
      engine.loopCounters.set(k, v);
    }
    if (stateData.retry_history) {
      for (const [k, v] of Object.entries(stateData.retry_history)) {
        engine.retryHistory.set(k, v);
      }
    }
    if (stateData.step_fail_reasons) {
      for (const [k, v] of Object.entries(stateData.step_fail_reasons)) {
        // 兼容旧格式(string)和新格式(StepFailRecord)
        engine.stepFailReasons.set(k, typeof v === 'string' ? { reason: v, fail_kind: 'error' } : v as StepFailRecord);
      }
    }
    if (stateData.exec_events) {
      engine.execEvents = [...stateData.exec_events];
    }

    if (stateData.last_replan_children) {
      for (const [k, v] of Object.entries(stateData.last_replan_children)) {
        engine.lastReplanChildren.set(k, v);
      }
    }
    if (stateData.cumulative_tokens) {
      engine.cumulativeTokens = stateData.cumulative_tokens;
    }
    if (stateData.terminal_state) engine.terminalState = stateData.terminal_state;
    if (stateData.notify_channel) engine.notifyChannel = stateData.notify_channel;   // @a: anc-cli-notify-reuse
    if (stateData.upstream_feedback) engine.upstreamFeedback = stateData.upstream_feedback;   // D41 复用半边跨进程恢复 // @a: anc-exec-l2c-retry-feedback
    if (stateData.driver_channel) engine.driverChannel = stateData.driver_channel;   // @a: anc-exec-driver-channel
    if (stateData.abort_reason) engine.abortReason = stateData.abort_reason;   // @a: anc-exec-abort
    if (stateData.expansion_count) engine.expansionCount = stateData.expansion_count;   // @a: anc-exec-subtask-free-expand
    if (stateData.terminal_failure) {
      engine.terminalFailure = stateData.terminal_failure;
    }
    if (stateData.escalate_pending) {
      engine.escalatePending = stateData.escalate_pending;   // @a: anc-exec-check-escalate
    }
    if (stateData.adaptive_needed_subtask) {
      engine.adaptiveNeededSubtask = stateData.adaptive_needed_subtask;
    }
    if (stateData.committed_steps) {
      // 退火标记跨进程不丢;旧 string[] 格式（v0.33.x 前）快照置空——判定恒命中=旧只增不清
      // 行为,保守方向正确（宁多拦不重放）。// @a: anc-exec-commit-anneal
      engine.committedSteps = new Map((stateData.committed_steps as (string | { step_id: string; iters?: Record<string, number> })[]).map(e =>
        typeof e === 'string' ? [e, {}] as const : [e.step_id, e.iters ?? {}] as const));
    }
    if (stateData.on_fail_active) {
      engine.onFailActive = new Set(stateData.on_fail_active);   // 兜底激活集跨进程不丢 // @a: anc-exec-on-fail
    }
    if (Array.isArray(stateData.on_fail_consumed)) engine.onFailConsumed = new Set(stateData.on_fail_consumed);   // 消耗集跨进程不丢（激活/消耗分离）// @a: anc-exec-on-fail
    if (Array.isArray(stateData.deterministic_waived)) engine.deterministicWaived = new Set(stateData.deterministic_waived);   // 免预算记账跨进程不丢 // @a: anc-exec-deterministic-no-retry
    if (Array.isArray(stateData.pending_chain_feeds)) engine.pendingChainFeeds = [...stateData.pending_chain_feeds];   // 续链待喂账跨进程不丢 // @a: anc-exec-parallel-reap-chain
    if (stateData.inflight) {
      engine.inflight = [...stateData.inflight];   // 收齐语义 crash-resume 重建 // @a: anc-exec-parallel-inflight
    }
    if (stateData.tool_journal) {
      engine.toolJournal = { ...stateData.tool_journal };  // @a: anc-exec-tool-request
    }
    if (stateData.time_journal) {
      engine.timeJournal = { ...stateData.time_journal };  // @a: anc-exec-time-builtins
    }
    if (stateData.cmd_journal) {
      engine.cmdJournal = { ...stateData.cmd_journal };  // @a: anc-exec-subprocess-run
    }
    if (stateData.can_fanout) {
      engine.canFanout = true;
    }
    if (stateData.dispatched) {
      for (const [k, v] of Object.entries(stateData.dispatched)) engine.dispatched.set(k, [...v]);
    }
    if (stateData.spec_path) {
      engine.specPath = stateData.spec_path;
      // rawSource 尽力回填（36 轮 review——load 恢复后重派发 parallel 子实例需原文重建
      //〔serializeSpec 单向有损禁用〕,原 null 让 U4b paused 账恢复的重派发路径直判 failed;
      // 文件读不到保持 null,消费方按既有'无原文'分支报错,不假装有）。
      // @a: anc-exec-parallel-hitl-queue, anc-exec-standalone-parallel
      try {
        engine.rawSource = readFileSync(stateData.spec_path, 'utf-8');
      } catch { /* 文件已移走/无权限——保持 null */ }
    }
    if (stateData.cli_abs_path) engine.cliAbsPath = stateData.cli_abs_path;
    if (stateData.max_concurrent != null) engine.maxConcurrent = stateData.max_concurrent;
    if (stateData.context_mode === 'minimal') {
      engine.contextMode = 'minimal';
    }
    // env 覆盖持久值：任一 load 命令进程可临时调档（精度 env > state）。见 ^anc-exec-context-mode。
    // run 隔离豁免登记（ARCHITECTURE ^anc-run-isolation）：load 是 CLI 每命令组合根的延伸——
    // CLI 一进程一 run,进程 env 即 run 级;server restore 也经此但 contextMode 是低危调试开关
    // （只影响 prompt 精简档,不碰凭证/解析根）,豁免并登记于守卫白名单。// @a: anc-run-isolation
    const envMode = process.env['HOPJIT_CONTEXT_MODE']?.toLowerCase();
    if (envMode === 'minimal' || envMode === 'full') engine.contextMode = envMode;
    if (stateData.subtree_root) {
      engine.subtreeRoot = stateData.subtree_root;
    }
    // 恢复 host_context（workspace+sandbox），doc-ref/P15 跨进程必需。// @a: anc-exec-doc-ref-resolve
    if (stateData.host_context) {
      engine.hostConfig = {
        workspace_dir: stateData.host_context.workspace_dir,
        sandbox: stateData.host_context.sandbox,
        ...(stateData.host_context.hop_env ? { hop_env: stateData.host_context.hop_env } : {}),   // @a: anc-config-hop-env
        ...(stateData.host_context.config_project_dir ? { config_project_dir: stateData.host_context.config_project_dir } : {}),   // BUG-I 配置读取根 // @a: anc-mcp-run-restore
      } as HostConfig;
    }

    // Rebuild HopLog if persisted // @a: anc-obs-hoplog-resume
    if (stateData.hoplog_run_dir) {
      engine.hoplog = HopLog.resume(stateData.hoplog_run_dir);
      engine.logDir = stateData.log_dir ?? null;
    }

    // 平台 path API 切分——win32 绝对路径无 '/',硬编码 split 拿整条路径当裸 id,
    // 父实例 load 恢复后派 parallel child 时 --parallel-parent 传出整条路径,child 侧 join 出鬼路径 ENOENT（0058）
    const split = splitInstanceDir(instanceDir);
    engine.instanceId = split.id;
    engine.stateDir = split.parent;
    engine.instanceDir = instanceDir;

    return engine;
  }

  // 崩溃恢复：load + 将悬空 running 重置为 pending 幂等重跑。仅 `hopjit resume` 命令使用。
  // 崩溃时的 running 无回写记录，是悬空的；branch 已选 case 的特例保留 running。
  /** Tools 段对账（^anc-exec-tools-reconcile 公共判定面——init 与 dispatcher 装配后两处调用。
   * 三判:名在清单(name/tool_id)/spec 参数 ⊆ 注册面参数/requires_commit 一致性。
   * 类型词表核（D6——spec 侧与注册面同词表,表外 error）。 */
  static reconcileTools(
    needs: import('./ast-types.js').ToolNeed[],
    available: { name: string; input_schema?: Record<string, unknown>; requires_commit: boolean }[],
  ): { errors: ValidationError[]; warnings: ValidationError[] } {
    const errors: string[] = [];
    const warnings: ValidationError[] = [];
    const PARAM_TYPES = new Set(['bool', 'int', 'float', 'line', 'text', 'markdown', 'yaml', 'prompt', 'line(nonempty)']);   // number 除名(2026-08-31 作者定与 Python 一致);line(nonempty) 收编(review B-6——归一了必须用得上)// @a: anc-type-constraint-annotation
    const typeOk = (t: string) => { const m = t.match(/^\[(.+)\]$/); return PARAM_TYPES.has(m ? m[1].trim() : t); };
    for (const need of needs) {
      for (const p of need.params) {
        if (!typeOk(p.type)) errors.push(`工具 '${need.name}' 参数 '${p.name}' 类型 '${p.type}' 不在词汇表（HopSpec 原子 + [原子]）`);
      }
      if (need.output && !typeOk(need.output.type)) errors.push(`工具 '${need.name}' 输出 '${need.output.name}' 类型 '${need.output.type}' 不在词汇表`);
      const impl = available.find(d => d.name === need.name || (d as { tool_id?: string }).tool_id === need.name);
      if (!impl) { errors.push(`工具 '${need.name}' 不在环境工具面（装配后清单）——注册后再跑,或从 Tools 段移除`); continue; }
      const implParams = impl.input_schema && typeof impl.input_schema === 'object' && (impl.input_schema as Record<string, unknown>)['properties']
        ? Object.keys((impl.input_schema as Record<string, unknown>)['properties'] as Record<string, unknown>) : null;
      if (implParams) {
        const extra = need.params.map(p => p.name).filter(n => !implParams.includes(n));
        if (extra.length) errors.push(`工具 '${need.name}' 声明了注册面没有的参数: ${extra.join(', ')}（注册面参数: ${implParams.join(', ')}）`);
      }
      // requires_commit 注明判据（D4 收窄:独立注记 token,排除否定语境的最小防线——
      // '(requires_commit)' 或行首/分号后紧跟;含'并非/不是/非 requires_commit'字样判未注明）
      const txt = `${need.description ?? ''};${need.notes ?? ''}`;
      const negated = /(并非|不是|非|not )\s*requires_commit/.test(txt);
      const needCommit = !negated && /(^|[（(;；,，\s])requires_commit([）);；,，\s]|$)/.test(txt);
      if (needCommit && !impl.requires_commit) errors.push(`工具 '${need.name}' spec 注明 requires_commit 而注册面为 false——声明失实（安全语义权威在注册面）`);
      if (!needCommit && impl.requires_commit) warnings.push({ kind: 'validate', rule: 'T1', severity: 'warn', message: `工具 '${need.name}' 注册面 requires_commit=true 而 Tools 段未注明——建议在用途说明补注（调用位拦截照常生效）` } as ValidationError);
    }
    return { errors: errors.map(m => ({ kind: 'validate' as const, rule: 'T1', severity: 'error' as const, message: `INIT_FAILED Tools 对账: ${m}` })), warnings };
  }

  static recover(instanceDir: string): ExecutionEngine { // @a: anc-exec-crash-recovery
    const engine = ExecutionEngine.load(instanceDir);
    engine.recoverDanglingRunning();
    return engine;
  }

  /** 崩溃恢复的重置半边（load 之后调）：按"崩溃时正在执行的节点重做,落盘的决定不动"极性——
   * 可执行叶子与未做入口决策的容器重置 pending,其余容器保留（详款 ^anc-exec-crash-recovery）。
   * static recover（CLI resume）与 MCP resumeRun 崩溃分支（#52——restoreRun 已
   * load 好引擎,复用本方法不再建第二个实例）共用。// @a: anc-exec-crash-recovery */
  recoverDanglingRunning(): void {
    const engine = this;
    const snapshotStates: Record<string, string> = {};
    for (const [k, v] of engine.stepStates) snapshotStates[k] = v;

    // 极性反转（2026-09-03 作者拍;09-04 纠框架"这些也都是正在执行最后的节点"——重置判据
    // 统一为"崩溃时正在执行的节点":叶子在干活/容器在做入口决策,都重做;已选路 branch、
    // 已进圈 loop 的决策早落盘,running 只剩结构语境,不动。一句话:没落盘的工作重做,
    // 落盘的决定不动。原三豁免全是"决策已落盘的容器",被默认保留天然收编,豁免清单从
    // 机制上消失。见 design ^anc-exec-crash-recovery 极性条款。// @a: anc-exec-crash-recovery
    // worker 子实例 scope 掩码祖先:先于容器两判——掩码祖先可以是 loop/branch,其入口决策
    // 账在父实例,worker 自己账上"无账"恒真会误杀路标（首轮测试实抓）。// @a: anc-exec-crash-recovery
    const maskAncestors = new Set<string>();
    if (engine.subtreeRoot) {
      let pid = getParentStepId(engine.subtreeRoot);
      while (pid) { maskAncestors.add(pid); pid = getParentStepId(pid); }
    }

    for (const [stepId, status] of Object.entries(snapshotStates)) {
      if (status !== 'running') continue;
      if (maskAncestors.has(stepId)) continue;   // 路标恒保留（决策在父账,worker 无从判）
      const step = engine.findStepById(stepId, engine.spec?.steps ?? []);
      if (step && EXECUTABLE_STEP_TYPES.has(step.step_type)) {
        engine.stepStates.set(stepId, 'pending');   // 干活叶子:结果没回写,幂等重跑
        continue;
      }
      if (step && step.step_type === 'branch' && !engine.hasBranchSelection(stepId, snapshotStates)) {
        engine.stepStates.set(stepId, 'pending');   // 未选路 branch:保留会绕过条件评估直落首 case
        continue;
      }
      if (step && step.step_type === 'loop' && !engine.loopCounters.has(stepId)) {
        engine.stepStates.set(stepId, 'pending');   // 未进圈 loop:保留会进体内而 itemVar 未绑定
        continue;
      }
      if (!step || !CONTAINER_STEP_TYPES.has(step.step_type)) {
        // 非容器非叶子（break/continue/exit 残留）或 spec 里已不存在的步 id:持久 running 是
        // 异常残留,保留则 DFS 撞 running 非容器返 none,run 挂死——重置消化
        engine.stepStates.set(stepId, 'pending');
        continue;
      }
      // 其余容器（subtask/case/on_fail/已选路 branch/已进圈 loop,含 worker scope 掩码祖先）:
      // 默认保留 running——体内悬空叶子已被上方分支重置,本轮重做,容器账不动
    }
    // 重置后旧问题卡即陈卡（confirm/ask 的 running 被回置 pending,重看介入请求走"下一次
    // nextStep 重算并重落卡"路径——旧卡不删则 runStatus 兜底的陈卡对账要替它擦屁股;
    // recover 是产生陈卡的已知路径,源头清掉,^anc-exec-pause-persist 重进暂停条款）。
    engine.removePausedCard();
    // 误终局读侧防线（0043 两防线之二）：failed 标记在场而两类凭据全缺席=advance 误判残留。
    // 凭据两类（亲核修正——初版只查 terminalFailure,漏了 allTerminal-hasFailed 与完备性闸两个
    // 真失败出口:它们落 failed 时 terminalFailure 不在场,盘面凭据是 failed 步/全终态缺产出）:
    // ①terminalFailure（函数级 fail）②盘面任一步 failed（hasFailed 路径可再推导)。两者全无
    // 才清——误判形态恰是"全 done/running 无一 failed"（bc32179f 实况）。完备性闸形态
    //（全终态无 failed 缺产出）清了也无害:下次 advance 重走闸再 finalize,自愈。
    // completed/aborted 恒不清。// @a: anc-exec-crash-recovery, anc-exec-state-persistence
    const anyFailedStep = [...engine.stepStates.values()].some(v => v === 'failed');
    if (engine.terminalState === 'failed' && !engine.terminalFailure && !anyFailedStep) {
      engine.terminalState = null;
    }
    engine.persist();
  }

  private hasBranchSelection(branchId: string, states: Record<string, string>): boolean {
    // 判据=任一直接 child 已离开 pending（skipped/running/done/failed 皆决策已发生的凭据）。
    // 不能只认 skipped:C2 明示单 case branch〔if-then〕合法,命中时置 running 无兄弟可 skip——
    // 旧判据恒 false 误判未选路,恢复重评估违"落盘的决定不动"（2026-09-04 review 面二实抓）。
    // 选路在 handleBranchEntry 同步原子完成后 persist,child 非 pending 即决策已落盘。// @a: anc-exec-crash-recovery
    const branch = this.findStepById(branchId, this.spec?.steps ?? []);
    if (!branch || !hasChildren(branch)) return false;
    return getChildren(branch).some(c => states[c.step_id] !== undefined && states[c.step_id] !== 'pending');
  }

  // --- P0-1: Check-finally preservation validation ---

  private validateCheckPreservation(originalChildren: StepNode[], newChildren: StepNode[]): ValidationError | null {
    const originalHasCheck = this.hasCheckStep(originalChildren);
    const originalFinallySteps = this.getCheckFinallySteps(originalChildren);

    // Rule 1: If original has check steps, new must also have at least one check step
    if (originalHasCheck && !this.hasCheckStep(newChildren)) {
      return {
        kind: 'validate',
        rule: 'replan-check-required',
        severity: 'error',
        message: 'Replan must include at least one [check] step (original plan contained check steps)',
      };
    }

    // Rule 2: If original has check-finally steps, new must preserve them at the end
    if (originalFinallySteps.length > 0) {
      const newTopLevel = newChildren;
      if (newTopLevel.length === 0) {
        return {
          kind: 'validate',
          rule: 'replan-check-finally',
          severity: 'error',
          message: 'Replan must preserve [check final] step at the end (check final cannot be removed)',
        };
      }

      // Check that the last step(s) are check-finally
      const lastStep = newTopLevel[newTopLevel.length - 1];
      if (lastStep.step_type !== 'check' || !(lastStep as CheckStep).is_finally) {
        return {
          kind: 'validate',
          rule: 'replan-check-finally',
          severity: 'error',
          message: 'Replan must preserve [check final] step at the end (check final must be the last step)',
        };
      }
    }

    return null;
  }

  private hasCheckStep(steps: StepNode[]): boolean {
    for (const step of steps) {
      if (step.step_type === 'check') return true;
      if (hasChildren(step)) {
        if (this.hasCheckStep(getChildren(step))) return true;
      }
    }
    return false;
  }

  private getCheckFinallySteps(steps: StepNode[]): CheckStep[] {
    const result: CheckStep[] = [];
    for (const step of steps) {
      if (step.step_type === 'check' && (step as CheckStep).is_finally) {
        result.push(step as CheckStep);
      }
      if (hasChildren(step)) {
        result.push(...this.getCheckFinallySteps(getChildren(step)));
      }
    }
    return result;
  }

  // --- P0-2: Replan similarity detection ---

  private isReplanDuplicate(previous: StepSummary[], current: StepSummary[]): boolean {
    // Condition 1: Same number of steps
    if (previous.length !== current.length) return false;

    // Condition 2: Same step type distribution
    const prevTypes = previous.map(s => s.step_type).sort().join(',');
    const currTypes = current.map(s => s.step_type).sort().join(',');
    if (prevTypes !== currTypes) return false;

    // Condition 3: Summary text similarity > 80% (Jaccard on words)
    const prevText = previous.map(s => s.summary).join(' ');
    const currText = current.map(s => s.summary).join(' ');
    const similarity = this.jaccardSimilarity(prevText, currText);
    return similarity > 0.8;
  }

  private jaccardSimilarity(a: string, b: string): number {
    const tokenize = (text: string): Set<string> =>
      new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 0));
    const setA = tokenize(a);
    const setB = tokenize(b);
    if (setA.size === 0 && setB.size === 0) return 1;
    let intersection = 0;
    for (const word of setA) {
      if (setB.has(word)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    if (union === 0) return 1;
    return intersection / union;
  }
}


/** instanceDir 切分纯函数——path 实现可注入供 win32 仿真测试（0058:win32 绝对路径无 '/',
 * 硬编码 split('/') 拿整条路径当裸 id,launch_command 拼出鬼路径 ENOENT;宿主运行时缺省吃平台 path）。
 */
// @a: anc-exec-durable-resume
export function splitInstanceDir(instanceDir: string, p: { basename: (s: string) => string; dirname: (s: string) => string } = { basename, dirname }): { id: string; parent: string } {
  return { id: p.basename(instanceDir), parent: p.dirname(instanceDir) };
}
