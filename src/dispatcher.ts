// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: step-dispatcher ^anc-struct-step-dispatcher
import Anthropic from '@anthropic-ai/sdk';
import { wrapAnthropicClient, makeOpenAiClient, type ProtocolClient } from './protocol-openai.js';
import { load as yamlLoad } from 'js-yaml';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExecutionEngine } from './engine.js';
import { PromptAssembler, injectKnowledgeContext, actRoleKind, roleGuideText, renderPromptParts, SCHEMA_KICK_MARKER } from './prompt.js';
import { DefaultToolProvider } from './tools.js';
import { CompositeToolProvider } from './tools-composite.js';
import { BodyInterpreter, evalExprSync } from './act-body-interpreter.js';
import { getWriteScope } from './ast-runtime.js';   // callee 插值解引用取变量 scope（^anc-step-call-dynamic-callee）
import { repairQuotedPrefixScalars } from './validator.js';
import { deleteNodeAt, insertNodeAt, replaceNodeAt, renumberSteps } from './spec-tree-edit.js';
import { serializeFragment, parseFragment , flattenFragmentNumbering } from './parser.js';
import type { ExecutableStepType, OutputDecl, StepNode, ActStep, CallStep, CheckStep, CommitStep, ConfirmStep } from './ast-types.js';
import type { NextResponse, StepReady, AdaptiveNeeded, ExecutionPaused, ExecutionCompleted, ExecutionFailed, DrainWait, DispatchReady } from './cli-types.js';
import type { HostConfig, ToolProvider, ToolDef, KnowledgeProvider, ModelEngine, ModelRoute, SpecProvider, SpecSource } from './provider-types.js';
import { ENGINE_DEFAULT_MODEL } from './provider-types.js';
import type { AssembledContext } from './runtime-types.js';
import { ErrorCode } from './errors.js';

/** StepDispatcher 构造配置（tool 迭代上限、全局 token 预算、单步超时等成本护栏参数）。见 [[step-dispatcher#^anc-exec-cost-guardrails]] */
export interface DispatcherConfig {
  maxToolIterations?: number;
  tokenBudget?: number;
  timeoutSeconds?: number;
  callDepth?: number;  // call 嵌套深度（内部递归用,宿主不设；顶层 0）。见 [[step-dispatcher#^anc-exec-call-recursion]] // @a: anc-exec-call-recursion
  worker?: boolean;    // parallel worker 子 Dispatcher（内部用,宿主不设）：不启用引擎 fan-out——嵌套 parallel 退化串行（一层并行）。见 [[step-dispatcher#^anc-exec-standalone-parallel]] // @a: anc-exec-standalone-parallel
  // 子实例 worker 复用父 ToolProvider（内部用,宿主不设——hopissues/0021:每 worker 自建 Composite
  // 各 spawn stdio mcp 子进程且无人 close,30 子实例 run 后 30 僵尸〔hopkb 实撞 218×600MB≈6.8GB〕;
  // 工具面同源共享安全,provider 生命周期归顶层三收点）。// @a: anc-exec-tool-composite
  sharedToolProvider?: import('./provider-types.js').ToolProvider;
}

/** DirSpecProvider：缺省 SpecProvider——调用方 spec 同目录寻址（<基准目录>/<callee_spec_id>.md）。
 * 决策与安全约束（id 含路径分隔符/`..` 拒绝）见 [[shared-providers#^anc-provider-spec-default]]。
 * // @a: anc-provider-spec-default */
export class DirSpecProvider implements SpecProvider {
  constructor(private baseDir: string) {}
  /** callee spec 的文件路径推导（doc-ref 两级基准继承用——子实例要 specDir,接口 SpecSource
   * 不带路径,仅目录型 provider 有此概念）。// @a: anc-exec-doc-ref-resolve */
  pathOf(spec_id: string): string | null {
    if (spec_id.includes('/') || spec_id.includes('\\') || spec_id.includes('..')) return null;
    const path = join(this.baseDir, `${spec_id}.md`);
    return existsSync(path) ? path : null;
  }

  async resolve(spec_id: string): Promise<SpecSource | null> {
    // 名字就是名字，不是路径——含分隔符或 .. 一律拒（防穿越）
    if (spec_id.includes('/') || spec_id.includes('\\') || spec_id.includes('..')) return null;
    const path = join(this.baseDir, `${spec_id}.md`);
    if (!existsSync(path)) return null;
    return { spec_id, source: readFileSync(path, 'utf-8') };
  }
}

/** 进程内 call 边界的 $file 指针解引用（D59——deflateValues 面向 agent 受众,进程内确定性
 * 消费方必须拿真值;递归下钻数组元素/对象字段,形状契约同 act-body derefFilePointer:恰单键
 * {$file: string} 才解,{$file,preview} 双键豁免。同步读:settle 路径是同步函数,deflate 文件
 * 是本进程刚写的本地盘,读失败即抛响亮报错）。见 [[shared-types#^anc-exec-deflate]] 进程内边界条款。
 * // @a: anc-exec-deflate */
function inflateFilePointers(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(inflateFilePointers);
  if (v !== null && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length === 1 && keys[0] === '$file' && typeof rec.$file === 'string') {
      return JSON.parse(readFileSync(rec.$file, 'utf-8'));
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec)) out[k] = inflateFilePointers(val);
    return out;
  }
  return v;
}

// call 递归的挂起帧：paused 的子调用存活于父 Dispatcher，resume 经 call_path 剥头直达。
// 见 design/step-dispatcher.md ^anc-exec-call-recursion。// @a: anc-exec-call-recursion
interface CallFrame {
  dispatcher: StepDispatcher;
  engine: ExecutionEngine;
  reported_tokens: number;  // 已计入父累计的子 token 数（增量记账防跨 resume 重复计）
}

/** runSpec/resume 的返回结果：终态（completed/failed）或暂停信号（paused 携带 ExecutionPaused）。见 [[step-dispatcher#^anc-struct-step-dispatcher]] */
export interface RunResult {
  status: 'completed' | 'failed' | 'paused';
  outputs?: Record<string, unknown>;
  failure?: { step_id: string; reason: string };
  pause?: ExecutionPaused;
  // resume 注入被 completeStep 拒收（0016）：结构化错误原样上传,run 停在 paused 可修正重试
  //（与 CLI submit_and_fetch_next '出错不推进'同语义）。见 [[step-dispatcher]] SCHEMA_MISMATCH 重试节。
  rejected?: { code: string; message: string };
  cumulative_tokens?: number;
}

/** `service/model` / 裸 model 的单一解析入口。引用形态两片必须非空；首个 `/` 后内容完整保留。
 * // @a: anc-exec-model-resolve */
/** in-band 反刍重复度判据（^anc-exec-thinking-exhausted 二批——零成本纯字符串统计,非 LLM）:
 * 尾窗 4000 字符按 32 字符切片步进 32,统计切片在其之前文本里已出现的比率,>50% 判高重复。
 * 阈值保守（实录形态"让我重新审视"1330 次是数量级越阈）,长排版正文不误触（反例钉）。 */
// @a: anc-exec-thinking-exhausted
export function isHighlyRepetitive(text: string): boolean {
  const WINDOW = 4000, SLICE = 32, THRESHOLD = 0.5;
  if (text.length < WINDOW) return false;   // 短文不判——反刍烧穿必是长文
  const tailStart = text.length - WINDOW;
  let hits = 0, total = 0;
  for (let i = 0; i + SLICE <= WINDOW; i += SLICE) {
    const chunk = text.slice(tailStart + i, tailStart + i + SLICE);
    total++;
    const firstAt = text.indexOf(chunk);
    if (firstAt >= 0 && firstAt < tailStart + i) hits++;   // 首现位置在本切片之前=重复
  }
  return total > 0 && hits / total > THRESHOLD;
}

/** `service/model` 与裸 model 引用的单一解析入口（dispatcher 路由与 mcp-server 配置核对共同消费）。 */
export function parseModelRef(ref: string): { service_id: string; model: string } {
  if (!ref || ref !== ref.trim()) {
    throw new Error(`INVALID_MODEL_REF: model 引用须为非空且首尾无空白（收到 '${ref}'）`);
  }
  const slash = ref.indexOf('/');
  if (slash < 0) return { service_id: 'default', model: ref };
  if (slash === 0 || slash === ref.length - 1) {
    throw new Error(`INVALID_MODEL_REF: '${ref}' 须为非空 service/model 或裸 model`);
  }
  return { service_id: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

// 算子级重试：SCHEMA_MISMATCH 缺省重做次数（与 subtask retry 缺省值对齐）
// 见 design/step-dispatcher.md ^anc-exec-operator-retry
const SCHEMA_RETRY_MAX = 3;

// EMPTY_OUTPUT 步级重发上限（^anc-exec-output-empty-loud 步级重发半边,hopissues/0072）：
// 瞬时空响应曾直落 failStep 点燃容器,好实例自激死锁（G244:check 步一次空喷烧掉整个 42 步 run）。
// 首发+重发共 EMPTY_RETRY_MAX+1 次,与 SCHEMA_RETRY_MAX 同水位对齐。// @a: anc-exec-output-empty-loud
const EMPTY_RETRY_MAX = 2;

// API 输出 token 上限缺省值（env / resource_limits 都未指定时）。
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;   // 2026-08-27 从 16384 抬升（^anc-exec-output-budget——推理型模型 thinking+正文共池,旧值两头紧;上限是物理防线非产出配额,产出归 spec 输出声明约束）

/** 独立模式的驱动适配层：跑调度循环（init→next→execute→done）并直调 Anthropic API 完成单步推理与工具调用。见 [[step-dispatcher#^anc-struct-step-dispatcher]] */
export class StepDispatcher { // @a: anc-struct-step-dispatcher
  private clients = new Map<string, ProtocolClient>(); // @a: anc-exec-model-routing
  private defaultClient: ProtocolClient;
  private toolProvider: ToolProvider;
  private cumulativeTokens = 0;
  // 实例级上下文峰值水位（^anc-exec-ctx-watermark,0095——input+cache 读写三项合计取历史 max;
  // 观测态非执行态,不入快照,resume 从零重累）。// @a: anc-exec-ctx-watermark
  private ctxWatermark = 0;
  private ctxWarnedTier = 0;   // 已告警档位（1=越 75%,2=越 100%）——每档只告警一次,水位单调重复告警是噪声
  private replanAttempts = new Map<string, number>();
  private maxToolIterations: number;
  private tokenBudget: number | undefined;
  private timeoutSeconds: number | undefined;
  private pendingPause: ExecutionPaused | null = null;  // confirm/commit 暂停信号，executionLoop 读取后返回
  // 展开续批授权账（^anc-exec-subtask-free-expand 契约7 standalone 半边）：resume 侧收 guidance
  // 时记,handleAdaptive 重生成时消费（喂 prompt+携 extendExpansion）即清。进程内存活——跨进程
  // 快照恢复丢账的形态=下轮撞限重新问人（重问不破坏,可接受）。// @a: anc-exec-subtask-free-expand
  private expansionExtendGranted = new Map<string, string>();
  private isWorker = false;   // parallel worker 子 Dispatcher（网络暂停门 v1 不对 worker 开——^anc-exec-network-pause 范围注记）
  // call 递归：暂停中的子帧（call_step_id → CallFrame，子终态即删）+ 本层调用深度。
  // 见 design/step-dispatcher.md ^anc-exec-call-recursion。// @a: anc-exec-call-recursion
  private callFrames = new Map<string, CallFrame>();
  // 统一模型在飞 Promise 池（call parallel 渐进派发，独立模式 P0）：child_instance → 执行中 Promise。
  // 引擎 inflight 是账面权威（落盘），本表是进程内等待句柄——满名额/收齐都 Promise.race 它。
  // @a: anc-exec-parallel-reap-drain
  private inflightPromises = new Map<string, Promise<void>>();
  private inflightDispatchers = new Map<string, StepDispatcher>();   // 协作中断句柄（P1 §U4）
  // 协作式杀活中断（P1 §U4）：父杀活置位，子 executionLoop 步间检查——不打断执行中的单步。
  // @a: anc-exec-parallel-abort
  private aborted = false;
  requestAbort(): void { this.aborted = true; }
  // 执行中的串行 call 子层（call_step_id → 子 dispatcher）：handleCallStep 在 await 子
  // runSpec() 期间子既不在 inflightDispatchers（那是 parallel）也不在 callFrames（那只收
  // 暂停帧）——无此表则级联够不着执行期 call 子树,子层烧到自然终态（review 实抓）。
  // 进 await 前登记,结算时注销。// @a: anc-mcp-stop-run
  private activeCallChildren = new Map<string, StepDispatcher>();
  // 子实例 HITL 队列（U4b ^anc-exec-parallel-hitl-queue,0013）：paused 子实例句柄存活等应答
  //（与 callFrames 同哲学:挂起帧不销毁）。child_instance → {暂停载荷,子dispatcher,子引擎,形态}。
  // @a: anc-exec-parallel-hitl-queue-dispatch
  private pausedChildren = new Map<string, { pause: ExecutionPaused; dispatcher: StepDispatcher; engine: ExecutionEngine; kind: 'subtask' | 'call'; calleeId?: string }>();
  getPausedChildren(): ReadonlyMap<string, { pause: ExecutionPaused }> { return this.pausedChildren; }

  /** 串行 call 链投影（^anc-mcp-run-status-inflight call_chain 条,todo/0011①）：逐层下钻
   * activeCallChildren——每层记 call 步 id+子 spec id+子当前步;纯读账面零写动作。深度由
   * call depth 上限天然封顶,无环。// @a: anc-mcp-run-status-inflight */
  getCallChain(): Array<{ step: string; spec: string; current_step?: string }> {
    const chain: Array<{ step: string; spec: string; current_step?: string }> = [];
    // 本层至多一个在飞串行 call(串行语义);多个时按登记序取首个,其余是 parallel call 归 inflight 视图
    for (const [stepId, child] of this.activeCallChildren) {
      const eng = child.getEngine();
      const st = eng.getStatus();
      chain.push({ step: stepId, spec: eng.getSpec()?.header.id ?? '?', ...(st.current_step ? { current_step: st.current_step } : {}) });
      chain.push(...child.getCallChain());
      break;
    }
    return chain;
  }
  /** 级联中止：自身 + 四张在飞表（parallel worker / 暂停 call 帧 / 执行中串行 call 子层 /
   * HITL 队列 paused 子实例——U4b 杀活连坐:主线死了答案无处安放,卡随杀清除）。
   * stop_run 消费（^anc-mcp-stop-run）——单点 requestAbort 只停本层,深递归/并行在飞的子层
   * 各自持独立 aborted 位,不级联则子实例继续烧到自然终态。协作式:步间生效,不打断执行中单步。
   * // @a: anc-mcp-stop-run, anc-exec-parallel-hitl-queue */
  requestAbortCascade(): void {
    this.aborted = true;
    for (const d of this.inflightDispatchers.values()) d.requestAbortCascade();
    for (const f of this.callFrames.values()) f.dispatcher.requestAbortCascade();
    for (const c of this.activeCallChildren.values()) c.requestAbortCascade();
    for (const pc of this.pausedChildren.values()) { pc.dispatcher.requestAbortCascade(); pc.engine.removePausedCard(); }
    this.pausedChildren.clear();
  }

  // call 边界上游反馈组装（D41）：父层对本 call 步的重试反馈 + 本实例自己收到的上游反馈
  // 逐层拼接（递归下传通路）。体量纪律（v0.7.1 作者两定:"2000 也太少"+"800 也太少,
  // input context 很大根本用不完"）：当前打回意见零截断（子层作业的完整依据）;历史行单条
  // 4000（dr16 实测工单全文最大 3101——切行即丢意见正文,体量靠条数封顶不靠切行）;
  // 24000 累积保护线尾部截留（护栏防深递归逐层拼接无界增长,非单份工单预算——
  // ≈6K tokens,对百 K 级窗口九牛一毛）。
  // @a: anc-exec-l2c-retry-feedback
  // callee specPath 推导（仅 DirSpecProvider 有目录概念;其他 provider 返 null 子实例跳过
  // spec 目录基准——doc-ref 条款"specPath 缺席跳过本级"的合法降级）。// @a: anc-exec-doc-ref-resolve
  private resolveCalleeSpecPath(specId: string): string | null {
    const sp = this.hostConfig.spec_provider;
    return sp instanceof DirSpecProvider ? sp.pathOf(specId) : null;
  }

  private buildCallUpstreamFeedback(callStepId: string): string | undefined {
    return this.engine.buildUpstreamFeedbackPayload(callStepId);   // 公共体归 engine——复用模式 init_command 同经它,两模式载荷同构
  }
  private callDepth: number;
  private pendingToolWarns: string[] = [];   // 装配器横切 warn 暂存（flushToolLog 随步落账）

  // env 统一读取（run 隔离不变量,ARCHITECTURE ^anc-run-isolation）：快照在场只查快照
  //（构造期冻结,外部/它 run 改 env 不影响本 run）;快照缺席回退直读（存量兼容——组合根
  // 逐个收编后 CLI/mcp 两入口都供快照,回退支路留给宿主直构 HostConfig 的嵌入场景）。
  // @a: anc-run-isolation
  private envOf(key: string): string | undefined {
    const snap = this.hostConfig.env_snapshot;
    return snap ? snap[key] : process.env[key];
  }

  constructor(
    private engine: ExecutionEngine,
    private hostConfig: HostConfig,
    config: DispatcherConfig = {},
  ) {
    const { apiKey, baseURL } = this.resolveCredential();
    // authToken: null 切断 SDK 隐式读 env.ANTHROPIC_AUTH_TOKEN——SDK 的 authToken(Bearer 头)
    // 优先于显式 apiKey 发出,宿主 token 会盖掉解析出的配对凭证(2026-08-10 真机实抓 401)。
    // 见 design ^anc-exec-model-resolve 加载顺序"SDK 隐式 env 读取必须切断"。
    // 协议分派（^anc-exec-protocol-adapter）：openai 走适配器（IR 双向转换）；anthropic 直通包装
    if ((hostConfig.protocol ?? 'anthropic') === 'openai-chat') {
      this.defaultClient = makeOpenAiClient({ apiKey, ...(baseURL ? { baseURL } : {}) });
    } else {
      // client 级 timeout 显式给——SDK 非流式预检只看 _options.timeout,未设且 max_tokens
      // 换算超 10min 即拒发"Streaming is required"（per-request 第二参不进预检,首修修错层实证）。
      // 见 design ^anc-exec-nonstreaming-timeout。// @a: anc-exec-nonstreaming-timeout
      const timeout = this.nonstreamingTimeoutMs();
      // 鉴权头档按 HostConfig.auth 分双臂（^anc-config-standalone-schema——2026-09-18 review 抓
      // 缺省 provider 路径漏装:唯一 provider 配 bearer 不写显式路由时 resolveModel 落 'default'
      // 直取本 client,原硬编码 x-api-key 恰撞回该档要治的 InvalidApiKey）。// @a: anc-config-standalone-schema
      const defaultOpts = this.hostConfig.auth === 'bearer'
        ? { apiKey: null, authToken: apiKey, timeout }
        : { apiKey, authToken: null, timeout };
      this.defaultClient = wrapAnthropicClient(
        baseURL ? new Anthropic({ ...defaultOpts, baseURL }) : new Anthropic(defaultOpts),
        Anthropic);
    }
    this.clients.set('default', this.defaultClient);
    // 工具装配（tool-interface ^anc-exec-tool-composite）：宿主注入并入成员而非整体替换——
    // file 十件恒在场,宿主工具增量叠加,同名 fail-fast。// @a: anc-exec-tool-composite
    // 装配器 warn（裸奔/发现漂移）缓存——发生在工具调用内但装配器不知 stepId,
    // flushToolLog 时随当步落 HopLog（declared-or-flagged:无声明放行必留痕）。// @a: anc-exec-tool-shape-check
    this.toolProvider = config.sharedToolProvider ?? new CompositeToolProvider(hostConfig, {
      warn: m => this.pendingToolWarns.push(m),
    });   // 注入=worker 复用父 provider（不自建不自收,生命周期归顶层——0021 僵尸进程修）
    // 工具清单料源接线（^anc-exec-tool-manifest-source）：注册面交引擎,L4 清单渲染真身档——
    // 漏接=独立模式恒落复用模式通道指引档（2026-08-31 真机实抓）。// @a: anc-exec-tool-manifest-source
    engine.setToolDefsSource(this.toolProvider);
    // LLM 注入面内联真值（BUG-H ^anc-exec-llm-inline-context）：本 dispatcher 驱动的 LLM 是
    // 裸 API（无文件工具）,$file 指针=死引用→就地编造。组装期一处关阀,三注入面同治。
    engine.setInlineLlmContext(true);
    this.maxToolIterations = config.maxToolIterations
      ?? hostConfig.resource_limits?.max_tool_iterations ?? 20;
    this.tokenBudget = config.tokenBudget;
    this.timeoutSeconds = config.timeoutSeconds
      ?? hostConfig.resource_limits?.timeout_seconds;
    this.callDepth = config.callDepth ?? 0;
    // 跨进程 resume：引擎快照里的历史累计回填,预算护栏不因进程重启归零 // @a: anc-exec-cost-guardrails
    this.cumulativeTokens = engine.getCumulativeTokens();
    // 独立模式真并行：顶层/call 子 Dispatcher 启用引擎 fan-out 探测；parallel worker 不启用
    // （嵌套 parallel 退化串行,一层并行原则）。见 ^anc-exec-standalone-parallel。// @a: anc-exec-standalone-parallel
    if (!config.worker) engine.setCanFanout(true);
    // 统一模型派发门（P0.5）：独立模式开启 subtask parallel 异步派发；worker 子实例不开
    // （嵌套退化串行）。复用模式无 dispatcher，门恒关=退化窗口。// @a: anc-exec-parallel-dispatch-model
    if (!config.worker) engine.setUnifiedDispatch(true);
    this.isWorker = config.worker === true;
  }

  async runSpec(): Promise<RunResult> {
    // Tools 段装配后对账（^anc-exec-tools-reconcile 第二调用点——生产主通道:MCP standalone
    // 外部工具经 tool_registry 装配进 CompositeToolProvider,init 期 hostConfig.tool_provider
    // 缺席看不见;此处对装配后全集再核,review D1 实抓'init 对账在生产通道不生效'）。
    // @a: anc-exec-tools-reconcile
    const needs = this.engine.getSpec()?.header.tools;
    if (needs?.length) {
      const r = ExecutionEngine.reconcileTools(needs, this.toolProvider.list());
      if (r.errors.length) {
        const reason = r.errors.map(e => e.message).join('; ');
        // init 后失败终态落盘（todo/0058——原直接 return 零落账,快照恒 running 蒙住看护;
        // 落终态后 CLI status/跨进程消费者与本响应一致）。// @a: anc-exec-state-persistence
        this.engine.markInitFailed(reason);
        return { status: 'failed', failure: { step_id: '(init)', reason }, cumulative_tokens: this.cumulativeTokens };
      }
      for (const w of r.warnings) this.engine.getHopLog()?.recordWarn('', w.message);
    }
    return this.executionLoop();
  }

  /**
   * 同实例恢复：注入 caller 对 confirm 暂停步骤的决策，继续执行循环。 // @a: anc-exec-resume-semantics
   * confirm 是唯一的暂停点（鉴权/决策环节）：answer 作为步骤输出注入 → completeStep（audit hitl_decision）。
   * commit 不暂停（授权在前序完成），故 resume 不处理 commit。
   */
  async resume(stepId: string, answer: Record<string, unknown>, callPath?: string[], childInstance?: string): Promise<RunResult> {
    // 子实例 HITL 队列应答路由（U4b,0013——携 childInstance=答队列里那张卡）：取句柄二次占
    // 名额续跑;子终态照常收割出队;仍 paused（子内多暂停点）更新队列。答完回执行循环——
    // 主线继续推进/等下一张卡/收齐。// @a: anc-exec-parallel-hitl-queue-dispatch
    if (childInstance) {
      let pc = this.pausedChildren.get(childInstance);
      if (!pc) {
        // 跨进程恢复（37 轮 review——server 重启后 restoreRun 恢复的 dispatcher 队列是空的,
        // caller 拿旧卡 child_instance 来答）：账上该 child 为 paused → 先 resumeSpec 走对账
        // 重派发（36 轮恢复路）——子实例重跑到暂停点重新入队,child_instance 确定性同名
        //（<step_id>.<iter>）,新卡入队后按原答继续。重派发后仍无同名卡（结构变了/多卡先到
        // 别张）→ 返回 rejected 让 caller 重看队列——结构化拒不 throw:throw 会被 mcp catch
        // 錘成 failed 终态,可修正错误毁掉可恢复态（0016 同哲学）。// @a: anc-exec-parallel-hitl-queue
        const acct = this.engine.getInflight().find(f => f.child_instance === childInstance && f.status === 'paused');
        if (acct) {
          const rr = await this.resumeSpec();
          pc = this.pausedChildren.get(childInstance);
          if (!pc) return rr.status === 'paused'
            ? { ...rr, rejected: { code: 'CHILD_NOT_IN_QUEUE', message: `子实例 '${childInstance}' 重派发后未回到同名卡——用 run_status 重看 paused_queue 按新卡应答` } }
            : rr;
        } else {
          // 结构化拒不 throw（0016 哲学,hopissues/0094——原 throw 被 mcp catch 锤成 failed 终态:
          // 串行 call 停点被误带 child_instance〔其挂起帧走 call_path 路由本就不入本队列,且卡面
          // call_path/child_instance 字段对此形态均空,caller 无从判别〕,一次可修正参数错毁掉
          // 可恢复 run。三 miss 形态同拒同指引:已答过/已终态清场/串行停点误带参。）
          // @a: anc-exec-parallel-hitl-queue
          return { status: 'paused', rejected: { code: 'CHILD_NOT_IN_QUEUE', message: `子实例 '${childInstance}' 不在待答队列（已答过/已终态/杀活清场;或这是串行 call 停点——其应答走 call_path 路由,去掉 child_instance 参数重答。run_status 的 paused_queue 是现存卡权威）` } } as RunResult;
        }
      }
      this.pausedChildren.delete(childInstance);
      this.engine.markInflightResumed(childInstance);
      const childResult = await pc.dispatcher.resume(stepId, answer, callPath);
      if (childResult.rejected) {
        // 拒收:子未推进仍挂起——回队列回 paused 账,caller 修正重试（0016 同款不毁可恢复态）
        this.pausedChildren.set(childInstance, pc);
        this.engine.markInflightPaused(childInstance);
        return childResult;
      }
      this.cumulativeTokens += pc.dispatcher.getCumulativeTokens();
      const committed = pc.engine.hasCommittedSteps();   // @a: anc-exec-commit-anneal
      const reap = pc.kind === 'call' ? this.engine.reapParallelCall.bind(this.engine) : this.engine.reapParallelSubtask.bind(this.engine);
      if (childResult.status === 'completed') {
        reap(childInstance, { vars: pc.engine.getVars().variables, committed });
      } else if (childResult.status === 'paused') {
        // 子内下一个暂停点——回队列（新载荷),账回 paused
        this.pausedChildren.set(childInstance, { ...pc, pause: { ...childResult.pause!, child_instance: childInstance } });
        this.engine.markInflightPaused(childInstance);
        return this.executionLoop();
      } else {
        reap(childInstance, { failure: pc.engine.exportFailState(), committed });
      }
      return this.executionLoop();
    }
    // call_path 非空 → 暂停帧在子调用里：剥头取帧，递归下钻直达挂起帧（概念"完整调用链 key
    // 直达有权决策者"，中间 call 层只是挂起帧）。子帧回到 settleCallResult 分派。
    // 见 design/step-dispatcher.md ^anc-exec-call-recursion。// @a: anc-exec-call-recursion
    if (callPath && callPath.length > 0) {
      const frameId = callPath[0];
      const frame = this.callFrames.get(frameId);
      if (!frame) {
        throw new Error(`resume: call frame '${frameId}' 不存在（call_path 与挂起帧不符——用暂停响应携带的 call_path 原样回传）`);
      }
      const childResult = await frame.dispatcher.resume(stepId, answer, callPath.slice(1));
      // 子帧拒收透传（0016）：answer 被拒=子实例未推进仍挂起,不 settle 帧——原样上传让 caller 修正重试
      if (childResult.rejected) return childResult;
      return this.settleCallResult(frameId, frame, childResult);
    }

    const node = this.findStepInSpec(stepId);
    if (!node) {
      throw new Error(`resume: step ${stepId} not found`);
    }
    // 网络暂停恢复：步骤已回置 pending,不需要 answer——直接回执行循环,next_step 自然重派
    // 该步（网络恢复即续跑;answer 载荷忽略）。判据=事件流里该步有 network_pause 记录且当前
    // pending（只认真暂停过的步,防"resume 一个从未跑过的普通步"误入免答通道——那是误用,
    // 照抛 not a pausable step）。// @a: anc-exec-network-pause
    const wasNetworkPaused = this.engine.getExecEvents()
      .some(e => e.step_id === stepId && e.event === 'network_pause');
    if (wasNetworkPaused && this.engine.getStepStates().get(stepId) === 'pending') {
      return this.executionLoop();
    }
    // 升层应答（^anc-exec-check-escalate 专用消化路——不走 mapAskOutputs:guidance 键永远配
    // 不上 check 双槽声明,朴素复用会灌满双槽污染判定）：guidance 回注发起层反馈通道后回执行
    // 循环,发起步已回 pending 自然重跑。answer 取 guidance 键,缺席取 value 兜底（driver 可能
    // 按 ask 惯性交 value 键——语义同为指引文本,宽容收下不逼重试）。// @a: anc-exec-check-escalate
    if (this.engine.getEscalatePending() === stepId) {
      const guidance = String((answer['guidance'] ?? answer['value']) ?? '');
      const r = this.engine.resumeFromEscalation(stepId, guidance);
      if (r.status === 'error') throw new Error(r.message ?? 'escalate resume failed');
      // 展开续批形态（待答步=subtask free 容器）：应答分两路——收手=失败收口（不入授权账,
      // failStep 走既有阶梯:容器有 retry 可换路,耗尽如实 failed——review 抓灰区:原任何应答
      // 都变授权,人明确说收手系统仍多烧一次展开,收手语义全押在重生成 LLM 自觉上）;其余=批
      // 继续,guidance 入授权账,循环下轮再吐 initial_plan 时 handleAdaptive 消费。判据=收手
      // 词面精确短语（收手/停止/不继续/stop/abort——短语判定非嗅探:问题本身就是二选一,答案
      // 语面是协议面）。// @a: anc-exec-subtask-free-expand
      if (node.step_type === 'subtask') {
        const g = guidance.trim().toLowerCase();
        const isStop = ['收手', '停止', '不继续', '不要了', 'stop', 'abort'].some(w => g === w || g.startsWith(w));
        if (isStop) {
          // deterministic:人说收手=确定性收口——普通 fail 会进 retry 阶梯重展开再问一遍
          // "继续还是收手"（刚说过收手又被问,骚扰;fail_kind 既有语义:确定性失败不重试直达兜底）
          this.engine.failStep(stepId, `展开续批被人收手: ${guidance}`, 'deterministic');
        } else {
          this.expansionExtendGranted.set(stepId, guidance);
        }
      }
      return this.executionLoop();
    }
    if (node.step_type !== 'confirm' && node.step_type !== 'ask') {
      throw new Error(`resume: step ${stepId} is ${node.step_type}, not a pausable step (only confirm/ask pause)`);
    }

    // confirm/ask answer 规范化统一在 engine.completeStep（^anc-exec-confirm-answer / ^anc-exec-hitl-presentation，
    // 模式无关）。dispatcher 仅透传 answer，不自行判定，避免两模式逻辑分叉。审计由 completeStep 记录。
    // 返回值必须判读（0016——原无条件继续循环:被拒的步骤保持 running 被 dfs 跳过直奔终态,
    // SCHEMA_MISMATCH/INVALID_STATE/HOP_ENV_CREDENTIAL_REJECTED 全吞成'No executable step found'
    // 且 run 被錘 failed 终态;与 CLI submit_and_fetch_next '出错不推进'对齐,^anc-exec-advance-to-caller）。
    const wr = this.engine.completeStep(stepId, answer);
    if (wr.status !== 'ok') {
      return {
        status: 'paused',
        rejected: { code: String(wr.code ?? 'ERROR'), message: wr.message ?? 'answer 被拒' },
        cumulative_tokens: this.cumulativeTokens,
      };
    }

    return this.executionLoop();
  }

  async resumeSpec(): Promise<RunResult> {
    await this.reconcileAndRebuild();
    return this.executionLoop();
  }

  // crash-resume 在飞重建（P1 §U2，独立模式）：对账补收割后，对未终态的在飞子实例
  // 重起子 Dispatcher 续跑（子实例自身恢复走 ExecutionEngine.load+resumeSpec；worker 门不开）。
  // 无持久化子实例目录（内存态实例）时对账即空转——不误伤纯内存单测。
  // @a: anc-exec-parallel-inflight-reconcile
  private async reconcileAndRebuild(): Promise<void> {
    const { stale } = this.engine.reconcileInflight();
    const instDir = this.engine.getInstanceDir();
    if (!instDir || stale.length === 0) return;
    for (const childInstance of stale) {
      if (this.inflightPromises.has(childInstance)) continue;
      const entry = this.engine.getInflight().find(f => f.child_instance === childInstance);
      if (!entry) continue;
      const node = this.findStepInSpec(entry.step_id);
      const isCall = node?.step_type === 'call';
      const childDir = join(instDir, isCall ? 'calls' : 'parallel', childInstance);
      const p = (async () => {
        try {
          const childEngine = ExecutionEngine.load(childDir);
          // 复位悬空态（0830 review 实锤:盘上暂停中的 ask/confirm 是 running 态,不复位则
          // runSpec 撞 WAITING_WRITEBACK 防线直接 failed——下方 paused 分支成死代码,子实例
          // 被失败收割,恰是本批要修的洞没通电）。// @a: anc-exec-call-child-persist
          childEngine.recoverDanglingRunning();
          const worker = new StepDispatcher(childEngine, this.hostConfig, {
            sharedToolProvider: this.toolProvider,
            worker: true,
            callDepth: this.callDepth,
            maxToolIterations: this.maxToolIterations,
            ...(this.timeoutSeconds !== undefined ? { timeoutSeconds: this.timeoutSeconds } : {}),
          });
          const r = await worker.runSpec();
          this.cumulativeTokens += worker.getCumulativeTokens();
          this.engine.setCumulativeTokens(this.cumulativeTokens);
          const reap = isCall ? this.engine.reapParallelCall.bind(this.engine) : this.engine.reapParallelSubtask.bind(this.engine);
          const committed = childEngine.hasCommittedSteps();   // 退火凭据（三形态全传播）// @a: anc-exec-commit-anneal
          if (r.status === 'completed') reap(childInstance, { vars: childEngine.getVars().variables, committed });
          else if (r.status === 'paused') {
            // 文件态 paused 子实例重建后到暂停点=重新入队等应答（U4b"文件态走 stale 重建"的
            // 后半句——原只兜 completed/failed,paused 被 else 当失败收割;此路径在子实例纯内存
            // 时代对 standalone 不可达（崩即无目录）,落盘随父批〔^anc-exec-call-child-persist〕
            // 使其通电,洞当场露头:U4b 重启钉 vals=[] 实锤）。与 launchParallelSubtask 的
            // paused 分支同款。// @a: anc-exec-parallel-hitl-queue, anc-exec-call-child-persist
            this.engine.markInflightPaused(childInstance);
            this.pausedChildren.set(childInstance, { pause: { ...r.pause!, child_instance: childInstance }, dispatcher: worker, engine: childEngine, kind: isCall ? 'call' : 'subtask' });
          }
          else reap(childInstance, { failure: childEngine.exportFailState(), committed });
        } catch (err: unknown) {
          const reap = isCall ? this.engine.reapParallelCall.bind(this.engine) : this.engine.reapParallelSubtask.bind(this.engine);
          reap(childInstance, { failure: { specId: 'child', childInstanceId: childInstance, stepFailReasons: { rebuild: { reason: err instanceof Error ? err.message : String(err), fail_kind: 'error' } }, stepStates: { rebuild: 'failed' } } });
        } finally {
          this.inflightPromises.delete(childInstance);
        }
      })();
      this.inflightPromises.set(childInstance, p);
    }
  }

  getEngine(): ExecutionEngine { return this.engine; }  // server 重启恢复的 step_id 预校验用（^anc-mcp-run-restore）
  /** 工具装配器访问（run 终态收工具 server 用——tool-interface ^anc-exec-mcp-binding）。 */
  getToolProvider(): import('./provider-types.js').ToolProvider { return this.toolProvider; }

  getCumulativeTokens(): number {
    return this.cumulativeTokens;
  }

  private async executionLoop(): Promise<RunResult> {
    while (true) {
      // 协作式中断检查点（P1 §U4）：每轮取介入点前查 abort——父杀活后本子实例步间止损。
      // @a: anc-exec-parallel-abort
      if (this.aborted) {
        return { status: 'failed', failure: { step_id: '(aborted)', reason: 'aborted: 父实例杀活（主线失败清场），子实例步间协作中止' }, cumulative_tokens: this.cumulativeTokens };
      }
      const next = this.engine.nextStep();

      // 统一模型派发（dispatch_ready）：subtask parallel 子树异步起子实例，主线继续。
      // @a: anc-exec-parallel-dispatch-model
      if (next.status === 'dispatch_ready') {
        const dr = next as DispatchReady;
        if (dr.dispatch_kind === 'call') await this.launchParallelCallChild(dr);
        else await this.launchParallelSubtask(dr);
        continue;
      }
      // 收齐等待（drain_wait）：主线走完但仍有在飞——等任一收割后重进循环
      // （收割回调会在全部收好时触发引擎终态化级联）。// @a: anc-exec-parallel-reap-drain
      if (next.status === 'drain_wait') {
        if (this.inflightPromises.size === 0) {
          // 只剩等人（U4b）:队列非空=不是死循环,是 run 级 paused——返回队首卡等应答
          //（主线让位;caller 逐张答,答完回本循环继续收齐）。// @a: anc-exec-parallel-hitl-queue
          if (this.pausedChildren.size > 0) {
            const first = this.pausedChildren.values().next().value!;
            return { status: 'paused', pause: first.pause, cumulative_tokens: this.cumulativeTokens };
          }
          // 账面有在飞但进程内无句柄且对账未能重建（子实例目录尚未落成等窄窗口）——防死循环显式失败
          return { status: 'failed', failure: { step_id: (next as DrainWait).loop_step_id, reason: 'drain_wait 但进程内无在飞句柄（对账无可重建项）' }, cumulative_tokens: this.cumulativeTokens };
        }
        // 配置了单活超时则带轮询等待（卡死的活句柄永不 settle,race 永等——timer 让惰性判定
        // 有机会跑,下轮 nextStep 的 sweep 收割它）。缺省无超时=纯 race,行为不变。// @a: anc-exec-parallel-timeout
        const timeoutSec = this.hostConfig.resource_limits?.parallel_child_timeout_seconds;
        if (timeoutSec && timeoutSec > 0) {
          await Promise.race([...this.inflightPromises.values(), new Promise(res => setTimeout(res, Math.min(timeoutSec, 5) * 1000))]);
        } else {
          await Promise.race(this.inflightPromises.values());
        }
        continue;
      }

      switch (next.status) {
        case 'completed':
          return { status: 'completed', outputs: (next as ExecutionCompleted).outputs, cumulative_tokens: this.cumulativeTokens };
        case 'failed': {
          const f = next as ExecutionFailed;
          // 主线失败杀活（P1 §U4）：账面 killed 已由引擎记，此处对在飞子 Dispatcher 置协作中断标志
          for (const ci of f.kill_list ?? []) {
            this.inflightDispatchers.get(ci)?.requestAbort();
          }
          return { status: 'failed', failure: { step_id: f.failed_step_id, reason: f.failure_reason }, cumulative_tokens: this.cumulativeTokens };
        }
        case 'paused':
          return { status: 'paused', pause: next as ExecutionPaused, cumulative_tokens: this.cumulativeTokens };
        case 'adaptive_needed':
          await this.handleAdaptive(next as AdaptiveNeeded);
          break;
        case 'step_ready':
          await this.handleStepReady(next as StepReady);
          // confirm/commit 步骤暂停：步骤保持 running，返回暂停信号等待 caller 决策（CITL）
          if (this.pendingPause) {
            const pause = this.pendingPause;
            this.pendingPause = null;
            return { status: 'paused', pause, cumulative_tokens: this.cumulativeTokens };
          }
          break;
      }
    }
  }

  // EMPTY_OUTPUT 步级重发包装（^anc-exec-output-empty-loud 全口径半边——0072:瞬时空喷曾直落
  // failStep 点燃容器,好实例自激死锁;先自救 EMPTY_RETRY_MAX 次,耗尽才转容器。闸本体不动:
  // 空一个不收,变的是收不下之后先重发。paused 原样穿透。2026-09-07 作者拍"全口径罩"抽成
  // 方法:首发/SCHEMA 重做/lack_of_info 补检索三个调用口全包——原形态只包首发,另两口撞空
  // 响应仍一发点燃容器（0072-review 面二实抓两扇留窗）。计数口径=每次调用独立（每口各自
  // EMPTY_RETRY_MAX——空响应是瞬时抖动,与外层第几轮 schema 重试无关;共享池会让先撞口吃光
  // 后撞口的自救额度）。）// @a: anc-exec-output-empty-loud
  private async execWithEmptyRetry(step: StepReady): Promise<Record<string, unknown> | 'paused'> {
    const baseInstr = step.context.instruction;
    for (let emptyTry = 0; ; emptyTry++) {
      try {
        const r = await this.executeStepWithTimeout(step);
        step.context.instruction = baseInstr;   // 自愈后复原——提醒残留会成为后续重试轮的
        // 错误归因基线（"上一次响应为空"对 schema 不匹配轮是假话,0072-review 面二实抓）
        return r;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.startsWith('EMPTY_OUTPUT:') || emptyTry >= EMPTY_RETRY_MAX) { step.context.instruction = baseInstr; throw e; }
        this.engine.getHopLog()?.recordWarn(step.step_id, `[empty-retry] 空响应第 ${emptyTry + 1} 次,步级重发（${msg.slice(0, 80)}）`);
        step.context.instruction = `${baseInstr}\n\n[上一次响应为空——请完整产出声明的输出,不要返回空内容]`;
      }
    }
  }

  private async handleStepReady(step: StepReady): Promise<void> {
    // call 步骤走嵌套递归专线（不经 LLM/知识注入/SCHEMA 重试——结算语义是引擎 API 不是算子产出）。
    // 见 design/step-dispatcher.md ^anc-exec-call-recursion。// @a: anc-exec-call-recursion
    if (step.step_type === 'call') {
      // call parallel 不会到达这里——引擎 nextStep 在 unifiedDispatch 下先拦为 dispatch_ready
      // （名额满则 drain_wait），见 ^anc-exec-parallel-reuse-protocol。
      await this.handleCallStep(step);
      return;
    }

    // None 闸已删（2026-08-09 "fail 即异常"定稿）：None 输入照常交执行体——
    // 干不出达标结果由执行体报告失败/check 拦，引擎不连坐。// @a: anc-exec-none-propagation

    // L2 Knowledge injection: enrich context if KnowledgeProvider is available
    await this.injectKnowledge(step);
    // 注：L2d doc-ref 解析已下沉到 engine.assembleBasicContext（两模式共享），
    // 不在 dispatcher——见 design/step-dispatcher.md ^anc-exec-doc-ref-resolve（架构修正）

    try {
      let result = await this.execWithEmptyRetry(step);
      if (result === 'paused') return;

      // 承接面仅 reason（0053,2026-08-31 作者定"只应该给 reason"——act 确定性/工具执行缺
      // 信息该失败就失败,check 判不了走如实 false/escalatable gap 正形,均不入本路径）。
      if (step.step_type === 'reason' && this.hasLackOfInfo(result) && !this.hostConfig.knowledge_provider) {
        // 无知识后端=无补充能力,直接如实失败(fail_kind 携语义进容器升级链;原实装漏过本判定
        // 掉进 schema 校验被当格式错重试——lack_of_info 形态天然缺声明槽,烧 3 轮必败,白烧)。
        const query = typeof result.lack_of_info === 'string' ? result.lack_of_info : step.summary;
        this.engine.failStep(step.step_id, `${query} (no knowledge provider)`, 'lack_of_info');
        return;
      }
      if (step.step_type === 'reason' && this.hasLackOfInfo(result) && this.hostConfig.knowledge_provider) {
        const query = typeof result.lack_of_info === 'string' ? result.lack_of_info : step.summary;
        const fragments = await this.hostConfig.knowledge_provider.retrieve(query, 5);
        if (fragments.length > 0) {
          const supplementary = fragments.map(f => f.content).join('\n\n');
          step.context.knowledge_context = (step.context.knowledge_context ?? '')
            + `\n\n### 补充检索（由步骤 ${step.step_id} 的 lack_of_info 触发）\n${supplementary}`;
          const retryResult = await this.execWithEmptyRetry(step);   // 全口径罩:补检索重发口同享空响应自救 // @a: anc-exec-output-empty-loud
          if (retryResult === 'paused') return;
          if (this.hasLackOfInfo(retryResult)) {
            this.engine.failStep(step.step_id, `${query} (supplementary retrieval exhausted)`, 'lack_of_info');
            return;
          }
          result = retryResult;
        } else {
          this.engine.failStep(step.step_id, `${query} (no knowledge available)`, 'lack_of_info');
          return;
        }
      }

      // 算子级重试：completeStep 校验输出 schema，不匹配则拼反馈重做（缺省 3 次），
      // 耗尽 failStep（转入容器级 retry）。复用模式无此循环——done 直接返回 SCHEMA_MISMATCH
      // 由 caller 重试。见 design/step-dispatcher.md ^anc-exec-operator-retry
      // @a: anc-exec-operator-retry
      // body 步骤跳过 SCHEMA_MISMATCH 重试：该重试是为 LLM「改 prompt 重做」设计的，body 不是
      // LLM 且确定性——同 body 重跑产出一样的不匹配，重做无意义。schema 不匹配直接 failStep
      // 转容器级 retry。（注：工具瞬时失败的重试归 ToolProvider 内部，与本层无关。）// @a: anc-exec-act-body-interp
      const bodyNode = this.findStepInSpec(step.step_id) as ActStep | CommitStep | null;
      const isBodyStep = !!bodyNode?.body;
      const baseInstruction = step.context.instruction;
      let attempt = 1;
      while (true) {
        const resp = this.engine.completeStep(step.step_id, result);
        if (resp.code !== ErrorCode.SCHEMA_MISMATCH) break;  // 通过或其他响应 → 交回主循环
        if (isBodyStep || attempt >= SCHEMA_RETRY_MAX) {
          this.engine.failStep(step.step_id, isBodyStep
            ? `${resp.message}（act body 确定性，schema 不匹配不改 prompt 重做，转容器级 retry）`
            : `${resp.message} (after ${SCHEMA_RETRY_MAX} attempts)`);
          return;
        }
        attempt++;
        // 把校验反馈拼回 instruction，重做该算子
        step.context.instruction = `${baseInstruction}\n\n${SCHEMA_KICK_MARKER}\n${resp.message}`;
        const retry = await this.execWithEmptyRetry(step);   // 全口径罩:SCHEMA 重做口同享空响应自救（计数每口独立） // @a: anc-exec-output-empty-loud
        if (retry === 'paused') return;
        result = retry;
      }
      step.context.instruction = baseInstruction;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      // 网络暂停（B 半边——dr17 实撞:NETWORK_ERROR 当普通失败吃容器内容重试预算,43 秒烧穿
      // 整树;网络类失败'必活'〔等一等就好〕,不 fail、步骤回置 pending、run 转 paused 等
      // resume）。worker 内仍走 failStep（暂停-恢复门未开,父层 stale 对账兜底）。
      // @a: anc-exec-network-pause
      if (reason.startsWith('NETWORK_ERROR:') && !this.isWorker) {
        this.engine.resetStepForNetworkPause(step.step_id);
        this.pendingPause = {
          status: 'paused',
          instance_id: this.engine.getInstanceId(),
          step_id: step.step_id,
          pause_reason: 'network',
          presented_data: {
            summary: '网络中断暂停（非人工介入点）',
            instruction: '网络恢复后 resume 本 run 即从断点续跑——步骤已回置待执行,无需提供任何应答数据。',
            context: { network_error: reason },
          },
          response_options: [],
          work_zone: this.engine.getWorkZone(),
        };
        return;
      }
      this.engine.failStep(step.step_id, reason);
    }
  }

  // 旧通道泳道池 runParallelBatch 已删（P0.5）——统一通道见 launchParallelSubtask/dispatchParallelCall。

  // ===== 统一模型 call parallel 异步派发（design §U1-U4）===== // @a: anc-exec-parallel-dispatch-model

  // subtask parallel 子实例启动（P0.5）：同 spec 子树收窄（subtreeRoot），与 call 派发共用
  // 名额等待/收割/杀活。引擎已入账并快照入参（dispatch_ready 载荷）。
  // @a: anc-exec-parallel-dispatch-model, anc-exec-parallel-reap-drain
  private async launchParallelSubtask(d: DispatchReady): Promise<void> {
    // 名额检查在派发信号之后（引擎入账不占名额判定——账面已经入了；此处控制的是实际并发执行数）
    while (!this.engine.hasFreeSlot() && this.inflightPromises.size > 0) {
      await Promise.race(this.inflightPromises.values());
    }
    if (this.inflightPromises.has(d.child_instance)) return;
    const specSource = this.engine.getRawSource();
    if (!specSource) {
      this.engine.reapParallelSubtask(d.child_instance, { failure: { specId: 'self', childInstanceId: d.child_instance, stepFailReasons: { init: { reason: '独立模式 subtask parallel 需 spec 原文重建子实例（load 恢复的实例无原文）', fail_kind: 'error' } }, stepStates: { init: 'failed' } } });
      return;
    }
    const parentRunDir = this.engine.getHopLogRunDir();
    const childEngine = new ExecutionEngine();
    // 子实例状态落盘随父（^anc-exec-call-child-persist——父有 instanceDir 子落 parallel/<cid>/,
    // 与复用模式 worker 布局同构;父纯内存子随之,"无跨进程"假设在纯内存宿主真成立）
    // @a: anc-exec-call-child-persist
    const parentDirP = this.engine.getInstanceDir();
    // specPath 继承父（doc-ref 两级基准的子实例半边——第九跑实撞:漏传则子实例 specDir 缺席,
    // 与 spec 同目录的知识文档全找不到,11 个语义批 init 全灭;parallel subtask 跑的就是父的
    // spec,路径同一份）。// @a: anc-exec-doc-ref-resolve
    const parentSpecPathP = this.engine.getSpecPath();
    const initResp = childEngine.initExecution(specSource, this.hostConfig, {
      params: d.params_for_child,
      subtreeRoot: d.step_id,
      ...(parentSpecPathP ? { specPath: parentSpecPathP } : {}),



      parentInstanceId: this.engine.getInstanceId(),
      callStepId: d.child_instance,
      traceId: this.engine.getInstanceId(),
      ...(parentDirP ? { stateDir: join(parentDirP, 'parallel') } : {}),
      ...(parentRunDir ? { logDir: join(parentRunDir, 'parallel', d.child_instance, 'log'), logLevel: this.engine.getHopLog()?.getLevel() } : {}),   // 级别继承父 // @a: anc-obs-log-levels
    });
    if (initResp.status === 'error') {
      this.engine.reapParallelSubtask(d.child_instance, { failure: { specId: 'self', childInstanceId: d.child_instance, stepFailReasons: { init: { reason: `子实例 init 失败: ${initResp.errors.map(e => e.message).join('; ')}`, fail_kind: 'error' } }, stepStates: { init: 'failed' } } });
      return;
    }
    const worker = new StepDispatcher(childEngine, this.hostConfig, {
            sharedToolProvider: this.toolProvider,
      worker: true,
      callDepth: this.callDepth,
      maxToolIterations: this.maxToolIterations,
      ...(this.timeoutSeconds !== undefined ? { timeoutSeconds: this.timeoutSeconds } : {}),
    });
    this.inflightDispatchers.set(d.child_instance, worker);   // 协作中断句柄 // @a: anc-exec-parallel-abort
    const p = (async () => {
      try {
        const r = await worker.runSpec();
        this.cumulativeTokens += worker.getCumulativeTokens();
        this.engine.setCumulativeTokens(this.cumulativeTokens);
        // 退火凭据（独立模式）：worker 终态回调时读子引擎——三形态全传播（含 killed 后迟到回调,
        // reap 入口先传播再按账面早返回）。// @a: anc-exec-commit-anneal
        const committed = childEngine.hasCommittedSteps();
        if (r.status === 'completed') {
          this.engine.reapParallelSubtask(d.child_instance, { vars: childEngine.getVars().variables, committed });
        } else if (r.status === 'paused') {
          // U4b HITL 队列（0013,PARALLEL_HITL_TODO 判 failed 退役）：paused 让名额入队等应答,
          // 不 reap（子实例未终态,收齐门照等）。载荷补 child_instance 寻址。
          // @a: anc-exec-parallel-hitl-queue, anc-exec-parallel-hitl-queue-dispatch
          this.engine.markInflightPaused(d.child_instance);
          this.pausedChildren.set(d.child_instance, { pause: { ...r.pause!, child_instance: d.child_instance }, dispatcher: worker, engine: childEngine, kind: 'subtask' });
        } else {
          this.engine.reapParallelSubtask(d.child_instance, { failure: childEngine.exportFailState(), committed });
        }
      } catch (err: unknown) {
        this.engine.reapParallelSubtask(d.child_instance, { failure: { specId: 'self', childInstanceId: d.child_instance, stepFailReasons: { run: { reason: err instanceof Error ? err.message : String(err), fail_kind: 'error' } }, stepStates: { run: 'failed' }, }, committed: childEngine.hasCommittedSteps() });
      } finally {
        this.inflightPromises.delete(d.child_instance);
        this.inflightDispatchers.delete(d.child_instance);
      }
    })().catch(err => {
      // 池尾终极 catch（run 隔离不变量结构防线,ARCHITECTURE ^anc-run-isolation——两形态共用）：
      // 上方 catch 体自身（reapParallelSubtask/Call 收割链:persist 写盘/收割即 fail 递归）再抛
      // = async IIFE reject 且池中无人 await = unhandledRejection = 进程崩全船沉（机制已复现证实）。
      // 收割自身失败只留痕不再抛——该子实例账面由超时/对账兜底,不值一条船。// @a: anc-run-isolation
      // 文档级 warn（stepId ''——run 级异常非步骤级;步骤此刻多已 done/skipped,步骤级会被孤儿门拦）
      this.engine.getHopLog()?.recordWarn('', `收割自身失败（池尾兜住,不沉船;child=${d.child_instance}）: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.inflightPromises.set(d.child_instance, p);
  }

  // call parallel 子实例启动（引擎已入账+快照入参——dispatch_ready 载荷；名额判定在引擎
  // nextStep：满员吐 drain_wait 不入账）。子实例 paused（HITL）→ 判 failed 报 PARALLEL_HITL_TODO。
  // @a: anc-exec-gather, anc-exec-parallel-dispatch-model, anc-exec-parallel-reap-drain, anc-exec-parallel-kill
  private async launchParallelCallChild(d: DispatchReady): Promise<void> {
    if (this.inflightPromises.has(d.child_instance)) return;   // resume 重放已在跑
    const node = this.findStepInSpec(d.step_id) as CallStep | null;
    // callee 解引用（静态直返/插值求值,^anc-step-call-dynamic-callee）——三消费点之二,失败走
    // 既有 reapParallelCall 失败形态带明细。// @a: anc-step-call-dynamic-callee
    const resolvedP = node ? this.resolveCalleeId(node) : { error: `call parallel 步骤 '${d.step_id}' 不在 spec 树中` };
    if ('error' in resolvedP) {
      this.engine.reapParallelCall(d.child_instance, { failure: { specId: 'unknown', childInstanceId: d.child_instance, stepFailReasons: { init: { reason: resolvedP.error, fail_kind: 'error' } }, stepStates: { init: 'failed' } } });
      return;
    }
    const calleeId = resolvedP.id;
    const provider = this.hostConfig.spec_provider;
    if (!provider) {
      this.engine.reapParallelCall(d.child_instance, { failure: { specId: calleeId, childInstanceId: d.child_instance, stepFailReasons: { init: { reason: 'UNKNOWN_SPEC: call parallel 需 callee_spec_id 与 SpecProvider', fail_kind: 'error' } }, stepStates: { init: 'failed' } } });
      return;
    }
    const maxDepth = this.hostConfig.resource_limits?.max_call_depth ?? 10;
    if (this.callDepth + 1 > maxDepth) {
      this.engine.reapParallelCall(d.child_instance, { failure: { specId: calleeId, childInstanceId: d.child_instance, stepFailReasons: { init: { reason: `DEPTH_EXCEEDED: call 深度 ${this.callDepth + 1} 超上限 ${maxDepth}`, fail_kind: 'error' } }, stepStates: { init: 'failed' } } });
      return;
    }
    const specSource = await provider.resolve(calleeId);
    if (!specSource) {
      this.engine.reapParallelCall(d.child_instance, { failure: { specId: calleeId, childInstanceId: d.child_instance, stepFailReasons: { init: { reason: `UNKNOWN_SPEC: SpecProvider 未解析到 '${calleeId}'`, fail_kind: 'error' } }, stepStates: { init: 'failed' } } });
      return;
    }
    const parentRunDir = this.engine.getHopLogRunDir();
    const childEngine = new ExecutionEngine();
    // call 边界反馈同款接线（parallel call 形态——派发步重试反馈按 d.step_id 取）// @a: anc-exec-l2c-retry-feedback
    const upstreamP = this.buildCallUpstreamFeedback(d.step_id);
    // 子实例状态落盘随父（^anc-exec-call-child-persist）// @a: anc-exec-call-child-persist
    const parentDirPC = this.engine.getInstanceDir();
    const calleeSpecPathP = this.resolveCalleeSpecPath(specSource.spec_id);
    const initResp = childEngine.initExecution(specSource.source, this.hostConfig, {
      params: d.params_for_child,
      parentInstanceId: this.engine.getInstanceId(),
      callStepId: d.child_instance,
      traceId: this.engine.getInstanceId(),
      ...(calleeSpecPathP ? { specPath: calleeSpecPathP } : {}),   // doc-ref 基准继承（callee 自己的目录）// @a: anc-exec-doc-ref-resolve
      ...(upstreamP ? { upstreamFeedback: upstreamP } : {}),
      ...(parentDirPC ? { stateDir: join(parentDirPC, 'calls') } : {}),
      ...(parentRunDir ? { logDir: join(parentRunDir, 'calls', d.child_instance, 'log'), logLevel: this.engine.getHopLog()?.getLevel() } : {}),   // 级别继承父 // @a: anc-obs-log-levels
    });
    if (initResp.status === 'error') {
      this.engine.reapParallelCall(d.child_instance, { failure: { specId: calleeId, childInstanceId: d.child_instance, stepFailReasons: { init: { reason: `callee 解析/校验失败: ${initResp.errors.map(e => e.message).join('; ')}`, fail_kind: 'error' } }, stepStates: { init: 'failed' } } });
      return;
    }
    const childDispatcher = new StepDispatcher(childEngine, this.hostConfig, {
            sharedToolProvider: this.toolProvider,
      callDepth: this.callDepth + 1,
      maxToolIterations: this.maxToolIterations,
      ...(this.timeoutSeconds !== undefined ? { timeoutSeconds: this.timeoutSeconds } : {}),
    });
    this.inflightDispatchers.set(d.child_instance, childDispatcher);   // 协作中断句柄 // @a: anc-exec-parallel-abort
    const p = (async () => {
      try {
        const r = await childDispatcher.runSpec();
        this.cumulativeTokens += childDispatcher.getCumulativeTokens();
        this.engine.setCumulativeTokens(this.cumulativeTokens);
        // 退火凭据（独立模式）：worker 终态回调读子引擎——三形态全传播（含 killed 迟到回调,
        // reap 入口先传播再按账面早返回）。// @a: anc-exec-commit-anneal
        const committed = childEngine.hasCommittedSteps();
        if (r.status === 'completed') {
          this.engine.reapParallelCall(d.child_instance, { vars: childEngine.getVars().variables, committed });
        } else if (r.status === 'paused') {
          // 同 subtask 侧——U4b 入队（0013）。// @a: anc-exec-parallel-hitl-queue
          this.engine.markInflightPaused(d.child_instance);
          this.pausedChildren.set(d.child_instance, { pause: { ...r.pause!, child_instance: d.child_instance }, dispatcher: childDispatcher, engine: childEngine, kind: 'call', calleeId });
        } else {
          this.engine.reapParallelCall(d.child_instance, { failure: childEngine.exportFailState(), committed });
        }
      } catch (err: unknown) {
        this.engine.reapParallelCall(d.child_instance, { failure: { specId: calleeId, childInstanceId: d.child_instance, stepFailReasons: { run: { reason: err instanceof Error ? err.message : String(err), fail_kind: 'error' } }, stepStates: { run: 'failed' } }, committed: childEngine.hasCommittedSteps() });
      } finally {
        this.inflightPromises.delete(d.child_instance);
        this.inflightDispatchers.delete(d.child_instance);
      }
    })().catch(err => {
      // 池尾终极 catch（run 隔离不变量结构防线,ARCHITECTURE ^anc-run-isolation——两形态共用）：
      // 上方 catch 体自身（reapParallelSubtask/Call 收割链:persist 写盘/收割即 fail 递归）再抛
      // = async IIFE reject 且池中无人 await = unhandledRejection = 进程崩全船沉（机制已复现证实）。
      // 收割自身失败只留痕不再抛——该子实例账面由超时/对账兜底,不值一条船。// @a: anc-run-isolation
      // 文档级 warn（stepId ''——run 级异常非步骤级;步骤此刻多已 done/skipped,步骤级会被孤儿门拦）
      this.engine.getHopLog()?.recordWarn('', `收割自身失败（池尾兜住,不沉船;child=${d.child_instance}）: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.inflightPromises.set(d.child_instance, p);
  }

  // ===== 独立模式 call 递归（design ^anc-exec-call-recursion）===== // @a: anc-exec-call-recursion

  // executeCall：解析 callee → 建子引擎（内存态）+ 子 Dispatcher（depth+1）→ 递归 runSpec → 结算。
  // 结算三分派：completed 回填 / failed 组装 CalleeFailure / paused 存帧上抛（call_path 头插本步）。
  // 工具 call 退化形态（^anc-exec-call-tool——单次调用即完成:无子实例/无递归深度/无 callFrames 帧。
  // requires_commit 工具在 call 位与 act 同权拦截;结果按 output_mapping 落父变量;
  // journal 重放归 completeStep 输出通道——重试即重调工具,与 body 工具调用同语义）。
  // @a: anc-exec-call-tool
  private async executeCallTool(step: StepReady, node: CallStep, tool: { name: string; requires_commit: boolean }): Promise<void> {
    if (tool.requires_commit) {
      this.engine.failStep(step.step_id, `COMMIT_REQUIRED: 工具 '${node.callee_spec_id}' 标记 requires_commit——call 位与 act 同受语境拦截,请包进 [commit] 步骤的 body 调用`);
      return;
    }
    try {
      const args = this.engine.resolveCallParams(step.step_id);
      // 不传 write_scope=缺省 work_zone 窄域（有意）：call 位工具与 act 同受语境拦截
      // （requires_commit 拦截同判据）,写域同窄。// @a: anc-exec-write-scope
      const r = await this.toolProvider.execute(tool.name, args);
      if (!r.success) {
        this.engine.failStep(step.step_id, `工具 call '${node.callee_spec_id}' 执行失败: ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}`);
        return;
      }
      // 结果回填按 output_mapping：单映射时整值直落;响应为对象且映射名是其字段时取字段
      const value = r.content_type === 'json' && typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
      const outputs: Record<string, unknown> = {};
      const mappings = node.output_mapping ?? [];
      const isObj = value !== null && typeof value === 'object';
      for (const m of mappings) {
        if (isObj && m.from in (value as Record<string, unknown>)) {
          outputs[m.to] = (value as Record<string, unknown>)[m.from];
        } else if (!isObj && mappings.length === 1) {
          outputs[m.to] = value;   // 标量响应+单映射:整值直落（唯一合法兜底形态）
        } else {
          // 对象响应字段 miss / 多映射兜底=灌错值温床（review D5 实抓:from 名打错零报错、
          // 同值重复灌多变量）——响亮失败点名
          this.engine.failStep(step.step_id, `工具 call '${node.callee_spec_id}' 响应${isObj ? `无字段 '${m.from}'（响应字段: ${Object.keys(value as Record<string, unknown>).join(', ')}）` : `为标量而输出映射有 ${mappings.length} 条`}——output_mapping 的 from 须对准工具响应字段名`);
          return;
        }
      }
      const done = this.engine.completeStep(step.step_id, outputs);
      if (done.status !== 'ok') {
        this.engine.failStep(step.step_id, `工具 call '${node.callee_spec_id}' 结果不合输出声明: ${done.message ?? done.code}`);
      }
    } catch (err: unknown) {
      this.engine.failStep(step.step_id, err instanceof Error ? err.message : String(err));
    }
  }

  // callee 位插值解引用（^anc-step-call-dynamic-callee——静态 Id 直返;插值经 evalExprSync 求值,
  // 结果必须非空字符串:callee 是标识符不是文本,对象值=上游产出形态错,响亮报错不做 JSON 静默兜底）
  // @a: anc-step-call-dynamic-callee
  private resolveCalleeId(node: CallStep): { id: string } | { error: string } {
    if (node.callee_spec_id?.trim()) return { id: node.callee_spec_id };   // 静态形态直返,存量零回归
    if (!node.callee_expr) return { error: `call step '${node.step_id}' 缺 callee_spec_id` };
    const exprSrc = node.callee_expr_src ?? '(表达式原文缺失)';
    let value: unknown;
    try {
      // readVar 闭包接引擎变量空间（与 param_mapping 求值同源——VariableStore.read 沿 scope 链,
      // 与 engine-traverse 条件求值同一读法）
      const store = this.engine.getVariableStore();
      value = evalExprSync(node.callee_expr, name => store.read(name, getWriteScope(node.step_id, this.engine.getSpec()!)));
    } catch (err: unknown) {
      return { error: `call 步骤 '${node.step_id}' callee 表达式 {${exprSrc}} 求值异常: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (typeof value !== 'string' || value.trim() === '') {
      const preview = String(value === undefined ? 'undefined' : typeof value === 'object' ? JSON.stringify(value) : value).slice(0, 80);
      return { error: `call 步骤 '${node.step_id}' callee 表达式 {${exprSrc}} 求值结果非字符串（callee 是 spec 标识符,须为非空字符串）——typeof=${typeof value},值预览: ${preview}` };
    }
    return { id: value };
  }

  private async handleCallStep(step: StepReady): Promise<void> {
    const node = this.findStepInSpec(step.step_id) as CallStep | null;
    if (!node) {
      this.engine.failStep(step.step_id, `call step '${step.step_id}' 缺 callee_spec_id`);
      return;
    }
    // callee 解引用（静态直返/插值求值,^anc-step-call-dynamic-callee）——失败=步骤失败带明细,
    // 与 UNKNOWN_SPEC 同款处置进既有升级阶梯。// @a: anc-step-call-dynamic-callee
    const resolved = this.resolveCalleeId(node);
    if ('error' in resolved) {
      this.engine.failStep(step.step_id, resolved.error);
      return;
    }
    const calleeId = resolved.id;
    // 运行时 depth 检查：子帧深度 = 本层+1，超限不建子实例。// @a: anc-exec-call-depth-check
    const maxDepth = this.hostConfig.resource_limits?.max_call_depth ?? 10;
    if (this.callDepth + 1 > maxDepth) {
      this.engine.failStep(step.step_id, `DEPTH_EXCEEDED: call 深度 ${this.callDepth + 1} 超上限 ${maxDepth}（resource_limits.max_call_depth）`);
      return;
    }
    // callee 决议两段（^anc-exec-call-tool——概念 ^anc-step-call 扩义"call 统一 spec 与工具"）：
    // 先查 SpecProvider（命中=子 spec 走既有递归）;未命中查 ToolProvider（按 name/tool_id 命中=
    // 工具 call 退化形态:单次 execute 零递归零子实例）;双不中 fail UNKNOWN_SPEC。
    const provider = this.hostConfig.spec_provider;
    // resolve 异常≠未命中（review D10:provider 抖动抛错会穿透炸整树,工具决议不可达）——
    // 包住转 null 走两段决议,原因留 HopLog（工具面兜得住就兜,兜不住 UNKNOWN_SPEC 报文带原因）
    let specSource: SpecSource | null = null;
    let resolveErr: string | undefined;
    try { specSource = provider ? await provider.resolve(calleeId) : null; }
    catch (e: unknown) { resolveErr = e instanceof Error ? e.message : String(e); this.engine.getHopLog()?.recordWarn(step.step_id, `SpecProvider.resolve('${calleeId}') 抛错（按未命中处理,继续工具决议）: ${resolveErr}`); }
    if (!specSource) {
      const toolImpl = this.toolProvider.list().find(d => d.name === calleeId || (d as { tool_id?: string }).tool_id === calleeId);
      if (toolImpl) {
        await this.executeCallTool(step, node, toolImpl);
        return;
      }
      this.engine.failStep(step.step_id, provider
        ? `UNKNOWN_SPEC: 未解析到 spec 或工具 '${calleeId}'（SpecProvider 与 ToolProvider 清单均未命中${resolveErr ? `;resolve 曾抛错: ${resolveErr}` : ''}）`
        : `UNKNOWN_SPEC: 无 SpecProvider 且工具清单未命中 '${calleeId}'——spec callee 需宿主注入 spec_provider`);
      return;
    }

    // 建子引擎：Inputs 自动映射取值方是引擎（^anc-exec-call-auto-map）；状态落盘随父
    // （^anc-exec-call-child-persist——原 MemoryPersistence 缺省 2026-08-29 翻案:四坑=deflate
    // 无 work_zone/暂停卡蒸发/崩溃全重跑/commit 退火标记随内存死）；子实例 id=callStepId、
    // trace 继承父（与复用模式子实例约定同一套）// @a: anc-exec-call-child-persist
    const params = this.engine.resolveCallParams(step.step_id);
    const childEngine = new ExecutionEngine();
    const parentDirC = this.engine.getInstanceDir();
    const parentRunDir = this.engine.getHopLogRunDir();
    // call 边界反馈传递（D41 ^anc-exec-call-recursion 反馈条）：父层重试反馈 + 本实例收到的
    // 上游反馈逐层拼接下传（子实例 L5 上游修正意见条目,除 check/commit 外可见;累积 24000 尾部截留）。
    // 不传则外层意见轮重跑时 call 子树全盲——作者修订意见到不了重拆现场（dr8 实撞）。
    // @a: anc-exec-l2c-retry-feedback
    const upstream = this.buildCallUpstreamFeedback(step.step_id);
    const calleeSpecPathC = this.resolveCalleeSpecPath(specSource.spec_id);
    const initResp = childEngine.initExecution(specSource.source, this.hostConfig, {
      params,
      parentInstanceId: this.engine.getInstanceId(),
      callStepId: step.step_id,
      traceId: this.engine.getInstanceId(),
      ...(calleeSpecPathC ? { specPath: calleeSpecPathC } : {}),   // doc-ref 基准继承 // @a: anc-exec-doc-ref-resolve
      ...(parentDirC ? { stateDir: join(parentDirC, 'calls') } : {}),
      ...(upstream ? { upstreamFeedback: upstream } : {}),
      // 卫星目录：父 run 目录下 calls/<step>/log（与 parallel/<cid>/log 同构）;级别继承父
      //（作者定缺省全 debug 同批——原不传则子实例落缺省,父显式降级时子不跟,两向都要继承）
      // @a: anc-obs-log-levels
      ...(parentRunDir ? { logDir: join(parentRunDir, 'calls', step.step_id, 'log'), logLevel: this.engine.getHopLog()?.getLevel() } : {}),
    });
    if (initResp.status === 'error') {
      this.engine.failStep(step.step_id, `callee '${calleeId}' 解析/校验失败: ${initResp.errors.map(e => e.message).join('; ')}`);
      return;
    }

    const childDispatcher = new StepDispatcher(childEngine, this.hostConfig, {
            sharedToolProvider: this.toolProvider,
      callDepth: this.callDepth + 1,
      ...(this.tokenBudget !== undefined ? { tokenBudget: Math.max(0, this.tokenBudget - this.cumulativeTokens) } : {}),
      ...(this.timeoutSeconds !== undefined ? { timeoutSeconds: this.timeoutSeconds } : {}),
      maxToolIterations: this.maxToolIterations,
    });

    const frame: CallFrame = { dispatcher: childDispatcher, engine: childEngine, reported_tokens: 0 };
    // 执行期登记（^anc-mcp-stop-run 第1条）：await 期间级联经 activeCallChildren 够到本子层;
    // 登记后立查父位——cascade 可能在构造与登记之间已扫过表,漏扫窗口由此补平。
    this.activeCallChildren.set(step.step_id, childDispatcher);
    if (this.aborted) childDispatcher.requestAbortCascade();
    try {
      const childResult = await childDispatcher.runSpec();
      this.settleCallOutcome(step.step_id, frame, childResult);
    } finally {
      this.activeCallChildren.delete(step.step_id);   // @a: anc-mcp-stop-run
    }
  }

  // 子 RunResult 三分派结算（executeCall 首跑与 resume 下钻共用）：
  // completed/failed → 引擎 API 收帧；paused → 帧存活 + pendingPause 上抛（call_path 头插本 call step_id）。
  private settleCallOutcome(callStepId: string, frame: CallFrame, childResult: RunResult): void {
    // token 增量记账（防跨 resume 重复计）
    const childTotal = frame.dispatcher.getCumulativeTokens();
    this.cumulativeTokens += Math.max(0, childTotal - frame.reported_tokens);
    this.engine.setCumulativeTokens(this.cumulativeTokens);
    frame.reported_tokens = childTotal;

    // call 同界记账（终态两分支同点——失败的子实例内 commit 也已发生,父边界同守）：
    // 子含已执行 commit → 父登记本 call 步退火。// @a: anc-exec-commit-anneal
    if (childResult.status !== 'paused' && frame.engine.hasCommittedSteps()) {
      this.engine.markCommitted(callStepId);
    }
    if (childResult.status === 'completed') {
      this.callFrames.delete(callStepId);
      // 进程内 call 边界解引用（D59,2026-08-24）：子 RunResult.outputs 经 deflateValues
      // 面向 agent 受众（LLM 看指针可 Read）,但本消费方是确定性代码——指针对象写进父变量
      // 空间会顺 collect 流进下游机械 body（dr13 实撞:fragment 超阈成 {$file} 指针,
      // 机械拼装喂 edit_spec_tree 拒,4 攻同败烧死）。进程内传值恒真值。
      // // @a: anc-exec-deflate
      this.engine.completeCallStep(callStepId, inflateFilePointers(childResult.outputs ?? {}) as Record<string, unknown>);
      return;
    }
    if (childResult.status === 'failed') {
      this.callFrames.delete(callStepId);
      // FailRecord 内核原封加壳 CalleeFailure，fail_kind 跨界继承（同复用模式 --failure-child 通道）
      this.engine.failCallStep(callStepId, frame.engine.exportFailState());
      return;
    }
    // paused：帧挂起，暂停信号直达顶层 caller——call_path 头插本 call step_id 后上抛
    this.callFrames.set(callStepId, frame);
    const childPause = childResult.pause!;
    this.pendingPause = {
      ...childPause,
      call_path: [callStepId, ...(childPause.call_path ?? [])],
    };
  }

  // resume 下钻后的父层续跑：子帧终态则收帧继续父循环；子帧又暂停则重新上抛。
  private async settleCallResult(callStepId: string, frame: CallFrame, childResult: RunResult): Promise<RunResult> {
    this.settleCallOutcome(callStepId, frame, childResult);
    if (this.pendingPause) {
      const pause = this.pendingPause;
      this.pendingPause = null;
      return { status: 'paused', pause, cumulative_tokens: this.cumulativeTokens };
    }
    return this.executionLoop();
  }

  private async injectKnowledge(step: StepReady): Promise<void> { // @a: anc-exec-knowledge-retrieval
    const provider = this.hostConfig.knowledge_provider;
    if (!provider) return;

    const spec = this.engine.getSpec();
    if (!spec) return;

    const stepNode = this.findStepInSpec(step.step_id);
    if (!stepNode) return;

    const { sources, failures } = await injectKnowledgeContext(step.context, provider, spec, stepNode);
    // knowledge 流控字段（info 级）：记录本步检索到的知识来源 // @a: anc-obs-step-mapping
    if (sources.length > 0) {
      const at = new Date().toISOString();
      this.engine.getHopLog()?.recordStepMeta(step.step_id, {
        knowledge: sources.map(source_id => ({ source_id, at })),
      });
    }
    // 知识注入降级：provider 抛错 → 该 query 的 L2 留空。不静默——HopLog.recordWarn
    // （设计契约）+ stderr 诊断,让排障能区分「provider 真没返回」与「provider 抛异常」。
    for (const failure of failures) {
      this.engine.getHopLog()?.recordWarn(step.step_id, `knowledge-degraded: ${failure}`);
      process.stderr.write(`[knowledge-degraded] step ${step.step_id}: provider error, L2 empty — ${failure}\n`);
    }
  }

  private async handleAdaptive(resp: AdaptiveNeeded): Promise<void> {
    const subtaskId = resp.subtask_id;
    const attempts = this.replanAttempts.get(subtaskId) ?? 0;
    const maxReplanAttempts = this.hostConfig.resource_limits?.max_replan_attempts ?? 3;

    if (attempts >= maxReplanAttempts) {
      this.engine.failStep(subtaskId, `Replan circuit breaker: ${maxReplanAttempts} attempts exhausted`);
      return;
    }

    const hasKnowledge = !!this.hostConfig.knowledge_provider;
    const assembler = new PromptAssembler(this.engine, hasKnowledge);
    const ctx = assembler.assembleAdaptiveContext(subtaskId);

    // 三段流水线（^anc-exec-adaptive-pipeline,作者裁 A 档 2026-08-13）：失败分析→改动策略→生成——
    // 每段独立调用后段吃前段产物,中间产物入 HopLog（离线审核候选文件时对照"当时怎么想的"）。
    // 三段任一失败=该次 replan 尝试失败走既有预算,零新通道。// @a: anc-exec-adaptive-pipeline
    // initial_plan 分流（^anc-exec-subtask-free-expand——三轮 review:handleAdaptive 原不读 reason,
    // 三段流水线第一段强制归因不存在的失败）：首规划直接按 ctx 指令+expansion_context 单段生成。
    // @a: anc-exec-subtask-free-expand
    if (resp.reason === 'initial_plan') {
      try {
        const ctxNote = resp.expansion_context && Object.keys(resp.expansion_context).length
          ? `

[运行时输入实际值]
${JSON.stringify(resp.expansion_context, null, 2)}${resp.missing_inputs?.length ? `
（缺值输入: ${resp.missing_inputs.join(', ')}——计划里须安排取数或按缺失处理）` : ''}`
          : '';
        // 展开续批授权（^anc-exec-subtask-free-expand 契约7 standalone 半边——resume 侧应答时
        // 记的授权在此消费:guidance 喂进重生成 prompt〔人给的方向新计划要吸收〕,提交携
        // extendExpansion 放行一次,消费即清）。// @a: anc-exec-subtask-free-expand
        const extendGuidance = this.expansionExtendGranted.get(subtaskId);
        const guidanceNote = extendGuidance !== undefined
          ? `\n\n[展开续批指引（人已批继续）]\n${extendGuidance || '(人未给方向,按原契约继续)'}`
          : '';
        const planMd = await this.pipelineCall(ctx, 'replan', ctx.instruction + ctxNote + guidanceNote);
        const result = this.engine.submitReplan(subtaskId, flattenFragmentNumbering(planMd),
          extendGuidance !== undefined ? { extendExpansion: true } : undefined);
        // 授权消费=展开真放行才算（review 抓:原提交后立即清,携授权的计划被其它拒因拒〔生成物
        // 踩 EXPANSION_HAS_COMMIT/validate 等〕即浪费授权,下轮再撞限再问刚批过的人）。ok 清=
        // 消费;其它拒因保留授权重生成再试;EXPANSION_LIMIT 分支不可达（携授权不会撞它）。
        if (result.status === 'ok') {
          this.expansionExtendGranted.delete(subtaskId);
          this.replanAttempts.set(subtaskId, attempts + 1); return;
        }
        // 拒因留痕（与失败驱动路径同款 0030 纪律——结构化错误不许中转层蒸发）
        const rejMsgs = (result.errors ?? []).map(e => e.message);
        this.engine.getHopLog()?.recordStepMeta(subtaskId, {
          submit_rejected: rejMsgs.length ? rejMsgs : [String(result.code ?? 'unknown')],
        });
        // EXPANSION_LIMIT → 升层问人不烧熔断（作者定 2026-08-29"关键特性不应该等真需求再补"——
        // 耗尽不硬烧的 standalone 半边:复用 escalate 暂停设施〔卡落盘/nextStep 短路重放,循环
        // 下一轮 nextStep 自然吐 paused 上浮,不置 pendingPause——那是 step_ready 分支的信号位,
        // 混用会泄漏误消费〕;应答续批经 resume 侧记授权,下一轮携 extendExpansion 重生成。
        // 判据=结构化 rule+message 前缀,不嗅探自由文本）。// @a: anc-exec-subtask-free-expand
        if ((result.errors ?? []).some(e => e.kind === 'validate' && e.rule === 'expansion' && e.message.startsWith('EXPANSION_LIMIT'))) {
          this.engine.pauseForExpansionExtend(subtaskId, planMd);
          return;
        }
        this.replanAttempts.set(subtaskId, attempts + 1);   // 拒收也计攻——熔断照走防无限重试
        return;
      } catch (err: unknown) {
        this.expansionExtendGranted.delete(subtaskId);   // 实例失败授权账随清（残账不洁,review 抓）
        this.engine.failStep(subtaskId, `Initial plan generation failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    try {
      // 段产物纪律+体量闸（D40 精确化——实锤:失败分析段把 spec 全文抄进"证据",小 spec 无症状,
      // dr8 大素材下第一段即撞 16384 三攻全灭;分析/策略是结构化短文本,超长=素材混入的确定性信号）
      const clipGate = (label: string, text: string): string => {
        if (text.length > 2000) throw new Error(`ADAPTIVE_STAGE_OVERSIZE: ${label}段产物 ${text.length} 字超 2000 字闸——结构化短文本超长即素材混入,禁止复制 spec 正文/失败原文进产物（证据只写步骤号与一句话引用）`);
        return text;
      };
      const analysis = clipGate('失败分析', await this.pipelineCall(ctx, 'replan',
        `失败分析。基于下方失败信息与重试历史,输出结构化归因（不要生成新计划）：\n`
        + `归因: <数据问题|结构问题|工具问题 三选一>\n定位: <步骤号、为什么失败>\n证据: <步骤号/行号级一句话引用>\n`
        + `产物纪律：禁止复制 spec 正文或失败记录原文进产物——素材在后续环节的输入里本就在场,抄写只会撑爆输出。`));
      // 策略段产编辑序列 JSON（D44 定型,作者三连裁定——去 keep〔未提及=保留,编辑器缺省语义〕/
      // 补 delete〔编辑代数完备:删换增三原子〕/insert 用 before 锚〔引用原 step_id 定位,与
      // <<EDIT k>> 序号对位各司其职〕。产物是纯改动清单,输出量正比改动量）
      const strategy = clipGate('改动策略', await this.pipelineCall(ctx, 'replan',
        `改动策略。基于失败分析与 subtask 契约,输出编辑序列 JSON（不要生成步骤正文,不要围栏外文字）：\n`
        + `{"edits": [{"op": "replace", "step_id": "<原step_id>", "why": "<一句话>"}, {"op": "delete", "step_id": "<原step_id>", "why": "<一句话>"}, {"op": "insert", "before": "<插在哪个原step_id之前,末尾用END>", "intent": "<新步骤一句话意图>"}]}\n`
        + `只列要改动的步骤——没提到的步骤自动原样保留。删除必须给理由。\n`
        + `\n[失败分析]\n${analysis}`));

      // 定向编辑（D43/D44,作者定"对 spec 指定章节的改动应该有工具支持,而不是全量输出"）：
      // 生成段只产 replace/insert 项片段（<<EDIT k>> 按序对位）;replace 项机械附目标步原文
      // ——改写非凭空重写（D40 读面兑现:输入量=被改步骤体量）。策略坏/引用悬空/片段缺位 →
      // 回退全量生成（零新失败通道）。// @a: anc-exec-adaptive-pipeline
      const edits = this.parseReplanEdits(strategy, subtaskId);
      let newStepsMd: string;
      if (edits) {
        const subtaskNode = this.findStepInSpec(subtaskId);
        const childMap = new Map((subtaskNode && 'children' in subtaskNode ? (subtaskNode as { children: StepNode[] }).children : []).map(c => [c.step_id, c]));
        const changeItems = edits.map((e, k) => ({ e, k })).filter(x => x.e.op !== 'delete');
        const patchMd = await this.pipelineCall(ctx, 'replan',
          ctx.instruction + `\n\n只生成下列改动项的步骤片段（未提到的步骤由机器原样保留,不要输出）。`
          + `每个改动项的片段前面加一行分隔标记 <<EDIT k>>（k=下列项号）,片段可含多个步骤：\n`
          + changeItems.map(x => {
              if (x.e.op === 'replace') {
                const orig = childMap.get(x.e.step_id ?? '');
                return `<<EDIT ${x.k}>> 替换原步骤 ${x.e.step_id}（${x.e.why ?? ''}）。原文（作改写参照,IO 声明与对的部分沿用）：\n${orig ? serializeFragment([orig]) : ''}`;
              }
              return `<<EDIT ${x.k}>> 新增（插在 ${x.e.before ?? 'END'} 之前）：${x.e.intent ?? ''}`;
            }).join('\n')
          + `\n素材纪律：步骤描述只写"做什么"与 I/O 声明——不内联大段业务素材/模板/清单正文;`
          + `原步骤里经文件流转的内容保持文件引用形态（路径),不展开成正文。\n[改动策略]\n${strategy}`);
        const assembled = this.assembleReplanEdits(edits, patchMd, subtaskId);
        if (assembled !== null) {
          newStepsMd = assembled;
        } else {
          newStepsMd = await this.pipelineCall(ctx, 'replan',
            ctx.instruction + `\n\n严格按下方改动策略生成 children markdown（只输出步骤,无解释文字）。`
            + `素材纪律：步骤描述只写"做什么"与 I/O 声明——不内联大段业务素材/模板/清单正文。\n[改动策略]\n${strategy}`);
        }
      } else {
        newStepsMd = await this.pipelineCall(ctx, 'replan',
          ctx.instruction + `\n\n严格按下方改动策略生成 children markdown（只输出步骤,无解释文字）。`
          + `素材纪律：步骤描述只写"做什么"与 I/O 声明——不内联大段业务素材/模板/清单正文;`
          + `原步骤里经文件流转的内容保持文件引用形态（路径),不展开成正文;`
          + `执行说明超过一两句的写"细则见 <文件路径>"。\n[改动策略]\n${strategy}`);
      }

      this.engine.getHopLog()?.recordStepMeta(subtaskId, {
        // 段级留痕含定向/全量形态与产物体量（dr8 观测盲区补——原三攻烧完只有一行终态错误,死在哪段无账）
        replan_pipeline: { failure_analysis: analysis.slice(0, 2000), replan_strategy: strategy.slice(0, 2000) + ` [形态:${edits ? '定向编辑' : '全量生成'},产物${newStepsMd.length}字]` },
      });
      const replanResult = this.engine.submitReplan(subtaskId, flattenFragmentNumbering(newStepsMd));

      if (replanResult.status === 'error') {
        // 拒因留痕（0030,^anc-exec-adaptive-pipeline HopSop 第7条）：errors 明细随轮次入
        // HopLog,终态 reason 携末轮拒因摘要——修前只记死文案,三轮各败在哪零留痕（结构化
        // 错误不许中转层蒸发,0016 同哲学）
        const rejMsgs = (replanResult.errors ?? []).map(e => e.message);
        this.engine.getHopLog()?.recordStepMeta(subtaskId, {
          submit_rejected: rejMsgs.length ? rejMsgs : [String(replanResult.code ?? 'unknown')],   // 审计通道恒写（P2 归类裁定）
        });
        this.recordReplanFailure(subtaskId, attempts, maxReplanAttempts,
          `Replan failed after ${maxReplanAttempts} attempts; last: ${rejMsgs[0] ?? replanResult.code ?? 'unknown'}`);
      } else {
        this.replanAttempts.set(subtaskId, 0);
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.recordReplanFailure(subtaskId, attempts, maxReplanAttempts, `Replan API error after ${maxReplanAttempts} attempts: ${reason}`);
    } finally {
      // 落账通道不变量的 replan 半边：三段管线经 resolveModel('replan') 同样会产生软偏好落级
      // warn——不 flush 就错挂到下一个执行步（run 尾 replan 则彻底丢）,随 subtask 落账
      this.flushPendingWarns(subtaskId);
    }
  }

  // 编辑序列解析（D44 定型,作者三连裁定——delete/replace/insert 三原子+未提及=保留:编辑代数
  // 完备,产物是纯改动清单）：围栏剥壳→JSON.parse→引用核（replace/delete 的 step_id 与
  // insert.before〔非 END〕必须指向现行 children 真实步骤;同一步骤被多次 replace/delete=
  // 次序歧义拒;全删光拒〔防极端输出〕）。解析不动/引用坏返回 null=回退全量,零新失败通道。
  // @a: anc-exec-adaptive-pipeline
  private parseReplanEdits(strategy: string, subtaskId: string): { op: 'replace' | 'delete' | 'insert'; step_id?: string; why?: string; before?: string; intent?: string }[] | null {
    try {
      const m = strategy.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]) as { edits?: unknown };
      if (!Array.isArray(parsed.edits) || parsed.edits.length === 0) return null;
      const edits = parsed.edits.filter((x): x is { op: string; step_id?: string; why?: string; before?: string; intent?: string } =>
        !!x && typeof (x as { op?: unknown }).op === 'string');
      if (edits.length !== parsed.edits.length) return null;
      if (!edits.every(e => e.op === 'replace' || e.op === 'delete' || e.op === 'insert')) return null;
      const subtask = this.findStepInSpec(subtaskId);
      const children = (subtask && 'children' in subtask ? (subtask as { children: StepNode[] }).children : []);
      const childIds = new Set(children.map(c => c.step_id));
      const touched = new Set<string>();
      let deletions = 0;
      for (const e of edits) {
        if (e.op === 'insert') {
          if (e.before !== 'END' && !childIds.has(e.before ?? '')) return null;   // 插入锚悬空
          continue;
        }
        const id = e.step_id ?? '';
        if (!childIds.has(id) || touched.has(id)) return null;   // 引用悬空/同步骤重复操作
        touched.add(id);
        if (e.op === 'delete') deletions++;
      }
      // 全删光且无插入/替换补位（产物零步骤）→ 拒（防极端输出）
      const inserts = edits.filter(e => e.op === 'insert').length;
      const replaces = edits.filter(e => e.op === 'replace').length;
      if (deletions >= children.length && inserts + replaces === 0) return null;
      return edits as { op: 'replace' | 'delete' | 'insert'; step_id?: string; why?: string; before?: string; intent?: string }[];
    } catch { return null; }
  }

  // 编辑序列拼装（D44 机械半边,零 LLM,AST 层——自动重编号）：按原 children 文档序逐步走——
  // 被 delete 跳过;被 replace 取 <<EDIT k>> 对位片段;有 insert.before 指向本步先插其片段;
  // 未提及取现行 AST 深拷贝（编辑器缺省=保留）;insert.before="END" 最后追加。逐节点重写
  // step_id 为顶层连号（children 递归带前缀）。片段缺位/parse 不过返回 null=回退全量。
  // @a: anc-exec-adaptive-pipeline
  // 片段编号归一已迁 parser.ts 共享出口（P2-2 裁定 A——replan 提交两入口共用:本管线+CLI --replan）。

  private assembleReplanEdits(edits: { op: 'replace' | 'delete' | 'insert'; step_id?: string; before?: string }[], patchMd: string, subtaskId: string): string | null {
    const subtask = this.findStepInSpec(subtaskId);
    const children = (subtask && 'children' in subtask ? (subtask as { children: StepNode[] }).children : []);
    // <<EDIT k>> 切片:k → 片段文本（replan 协议特有,不属树编辑）
    const patches = new Map<number, string>();
    const re = /<<EDIT (\d+)>>[^\n]*\n?/g;
    const marks: { k: number; end: number }[] = [];
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(patchMd)) !== null) marks.push({ k: Number(mm[1]), end: re.lastIndex });
    for (let i = 0; i < marks.length; i++) {
      const upTo = i + 1 < marks.length ? patchMd.indexOf(`<<EDIT ${marks[i + 1].k}>>`, marks[i].end) : patchMd.length;
      patches.set(marks[i].k, patchMd.slice(marks[i].end, upTo < 0 ? patchMd.length : upTo).trim());
    }
    const fragOf = (k: number): StepNode[] | null => {
      const frag = patches.get(k);
      if (!frag) return null;
      const parsed = parseFragment(flattenFragmentNumbering(frag));
      if (parsed.errors.length > 0 || !parsed.ast.steps?.length) return null;
      return parsed.ast.steps;
    };
    // D44 三原子翻译成 spec-tree-edit 核心函数调用序（2026-08-30 作者拍 B 案统一——原自有拼装
    // 与树编辑工具各写一遍"按序拼装+重编号+序列化";协议语义零变,实现一处。翻译次序=按原
    // children 文档序:insert.before 先于其锚步生效,delete/replace 按步,END 最后追加——在工作
    // 副本上逐条调函数,before 锚以"目标步对象在当前副本中的实时位置"定位,与旧实现的文档序
    // 语义一致）。见 [[step-dispatcher]] D44 条目拼装段。// @a: anc-exec-adaptive-pipeline
    const work: StepNode[] = children.map(c => structuredClone(c));
    // 原 children step_id → 工作副本节点（克隆后对象引用变,按 step_id 对齐——编辑期间不重编号,id 稳定）
    const byId = new Map<string, StepNode>(work.map(n => [n.step_id, n]));
    const posOf = (id: string): number => work.findIndex(n => n === byId.get(id));
    // 按文档序翻译:先做全部 insert.before（锚步现存位置插入,原位者后移=insertNodeAt 语义）,
    // 同锚多 insert 保持清单序;再做 replace/delete;END 追加收尾。
    // 插入片段自带 1..n 相对号,会与原步骤 step_id 撞号——插入时先打临时唯一号（最终
    // renumberSteps 统一重写,临时号只为保住后续按 id 定位 delete/replace 的唯一性）。
    const tagTemp = (nodes: StepNode[], tag: string): StepNode[] => {
      const walk = (list: StepNode[], prefix: string) => {
        list.forEach((n, i) => {
          (n as { step_id: string }).step_id = `${prefix}.${i + 1}`;
          const kids = (n as { children?: StepNode[] }).children;
          if (kids?.length) walk(kids, (n as { step_id: string }).step_id);
        });
      };
      walk(nodes, tag);
      return nodes;
    };
    for (const c of children) {
      const insertsHere = edits.filter(e => e.op === 'insert' && e.before === c.step_id);
      for (const e of insertsHere) {
        const k = edits.indexOf(e);
        const nodes = fragOf(k);
        if (!nodes) return null;
        if (posOf(c.step_id) < 0) return null;
        // before 锚=锚步现存 step_id 即落位号（insertNodeAt 语义:原位者后移）——id 全树唯一,编辑期不重编号故恒可定位
        const r = insertNodeAt(work, byId.get(c.step_id)!.step_id, tagTemp(nodes.map(n => structuredClone(n)), `__ins${k}`));
        if (!r.ok) return null;
      }
    }
    for (const [k, e] of edits.entries()) {
      if (e.op === 'insert') continue;
      const target = byId.get(e.step_id ?? '');
      if (!target) return null;
      if (e.op === 'delete') {
        const r = deleteNodeAt(work, target.step_id);
        if (!r.ok) return null;
      } else {
        const nodes = fragOf(k);
        if (!nodes) return null;
        const r = replaceNodeAt(work, [{ nodePath: target.step_id, fragSteps: tagTemp(nodes.map(n => structuredClone(n)), `__rep${k}`) }]);
        if (!r.ok) return null;
      }
    }
    for (const [k, e] of edits.entries()) {
      if (e.op === 'insert' && e.before === 'END') {
        const nodes = fragOf(k);
        if (!nodes) return null;
        // END=末位+1 唯一越界位(insertNodeAt 追加语义)——临时号非连号,按当前长度+1 直给
        const r = insertNodeAt(work, String(work.length + 1), tagTemp(nodes.map(n => structuredClone(n)), `__ins${k}`));
        if (!r.ok) return null;
      }
    }
    if (work.length === 0) return null;
    renumberSteps(work);   // 编号权威一处（与工具壳同源——顶层连号,children 递归带前缀）
    return serializeFragment(work);
  }

  private async pipelineCall(ctx: AssembledContext, category: ExecutableStepType | 'replan', instruction: string): Promise<string> {
    const { request, client } = this.buildApiRequest({ ...ctx, instruction }, category);
    const response = await this.callLlmWithRetry(request, client);
    // 截断闸同覆盖（二十五审对读抓:本路径绕过 parseStepOutput——截断的部分产出会被静默收进
    // replan 三段,正是"残值=毒值"要拦的形态）。// @a: anc-exec-output-truncation-loud
    if (response.stop_reason === 'max_tokens') {
      const rumR = this.checkThinkingExhausted(response, 'replan-pipeline');   // @a: anc-exec-thinking-exhausted
      if (rumR) throw new Error(rumR);
      throw new Error(`OUTPUT_TRUNCATED: replan 流水线段输出被 max_tokens 掐断（output_tokens=${response.usage?.output_tokens ?? '?'}）——调大 HOPJIT_MAX_OUTPUT_TOKENS 或 resource_limits.max_output_tokens`);
    }
    const text = this.extractTextContent(response);
    if (!text.trim()) throw new Error('ADAPTIVE_PIPELINE_EMPTY: 流水线段产物为空');
    return text;
  }

  private async executeStepWithTimeout(step: StepReady): Promise<Record<string, unknown> | 'paused'> {
    if (!this.timeoutSeconds) {
      return this.executeStep(step);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);

    try {
      const result = await Promise.race([
        this.executeStep(step),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new Error(`STEP_TIMEOUT: exceeded ${this.timeoutSeconds}s`)));
        }),
      ]);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async executeStep(step: StepReady): Promise<Record<string, unknown> | 'paused'> {
    const stepType = step.step_type;   // StepReady.step_type 已是 ExecutableStepType,原 as 同型冗余（0008① review 顺手清）

    switch (stepType) {
      case 'reason':
        // reason 工具面（^anc-exec-reason-tools 2026-09-01 作者拍"等同于 act 的能力,不能 commit 写"）:
        // anthropic 协议走工具循环（与 act 共用循环体）;openai 协议保持原单发零工具。// @a: anc-exec-reason-tools
        return this.executeReason(step);
      case 'check': {
        // 带 body 的 check 归解释器（纯机械判定零 LLM——概念 ^anc-step-check-body『与 act 同文法
        // 同解释器』;四十一审 flash 实录抓漏:原分派一律 LLM 判,check body 在独立模式整个失效——
        // LLM 对着 body 文本猜输出,flash 交 null 双槽 SCHEMA_MISMATCH 假失败）。executeActBody
        // 对无 body 步骤自回退 executeActWithTools 不适用 check——显式按 body 有无分派。
        // @a: anc-step-check-body
        const node = this.findStepInSpec(step.step_id) as CheckStep | null;
        return node?.body ? this.executeActBody(step, false) : this.executeReasonOrCheck(step);
      }
      case 'act':
        return this.executeActBody(step, false);
      case 'confirm':
        return this.executeConfirm(step);
      case 'commit':
        return this.executeCommit(step);
      case 'call':
        // call 在 handleStepReady 入口即分流到 handleCallStep（嵌套递归专线），不会到这里
        throw new Error(`call step '${step.step_id}' 未被 handleCallStep 拦截——handleStepReady 分流逻辑被破坏`);
      default:
        throw new Error(`Unknown executable step type: ${stepType}`);
    }
  }

  /** reason 步执行入口（^anc-exec-reason-tools 2026-09-01 作者拍"所以应该给 reason 提供文件工具"
   * "等同于 act 的能力，不能 commit 写"）——协议分派（HopSop 第 2 步）：
   * anthropic 协议走工具循环（与 act 共用 executeActWithTools 循环体,不复制第二份循环）;
   * openai 协议无工具循环（^todo-openai-tool-loop 既有账）退回单发零工具形态——与改造前
   * 行为逐字节一致,不 fail-fast（reason 不同于 act:它总能纯推理产出,工具只是增强）。 */
  // @a: anc-exec-reason-tools
  private async executeReason(step: StepReady): Promise<Record<string, unknown>> {
    const resolved = this.resolveModel('reason', step);
    const client = this.getClientForService(resolved.service_id);
    if (client.protocol === 'openai-chat') return this.executeReasonOrCheck(step);
    // reason 工具面全按声明下发（^anc-exec-reason-tools 2026-09-18 修订——原 basic 恒下发
    // 废除:救"少数 reason 要读盘"的决策给了全部 reason 无条件十一件,弱模型实撞七轮全灭
    // 20 轮工具空转,闲置工具面是行为吸引子。零声明=零工具面走单发纯推理——弱模型物理
    // 无可着魔按钮;有声明才进工具循环）。// @a: anc-exec-reason-tools
    const reasonNode = this.findStepInSpec(step.step_id) as (StepNode & { tool_grants?: { name: string }[] }) | null;
    if (!reasonNode?.tool_grants?.length) return this.executeReasonOrCheck(step);
    return this.executeActWithTools(step, false);
  }

  private async executeReasonOrCheck(step: StepReady): Promise<Record<string, unknown>> {
    const { request, client } = this.buildApiRequest(step.context, step.step_type, step);

    let response: Anthropic.Message;
    try {
      response = await this.callLlmWithRetry(request, client);
    } catch (err: unknown) {
      // 分类器必须跟发请求的 client（review 探针抓漏 2026-08-12：routing_rules 把本步路由到
      // openai service 时,defaultClient 可能是 anthropic——错协议的 instanceof 全不命中,
      // 溢出被判 other,reassembleAggressive 降级重组永不触发）。// @a: anc-exec-protocol-adapter
      if (client.classifyError(err) === 'context_overflow') {
        const hasKnowledge = !!this.hostConfig.knowledge_provider;
        const assembler = new PromptAssembler(this.engine, hasKnowledge);
        const stepNode = this.findStepInSpec(step.step_id);
        if (stepNode) {
          const aggressiveCtx = assembler.reassembleAggressive(stepNode);
          const { request: retryRequest, client: retryClient } = this.buildApiRequest(aggressiveCtx, step.step_type, step);
          try {
            response = await this.callLlmWithRetry(retryRequest, retryClient);
          } catch (err2: unknown) {
            // 激进重组后二次撞墙=确定性失败（^anc-exec-toolloop-ctx-degrade 归一口袋入口——
            // 原裸 throw err2,容器 retry 原样重跑必然同因更大）。// @a: anc-exec-toolloop-ctx-degrade
            if (retryClient.classifyError(err2) === 'context_overflow') {
              throw new Error('CONTEXT_OVERFLOW: 激进重组后仍超模型窗——单步材料量超出模型能力，拆步骤（for-each 逐份）或换更大窗的模型');
            }
            throw err2;
          }
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    const hopLog = this.engine.getHopLog();
    if (hopLog) {
      // 独立模式执行内幕（LLM/tool）由 Dispatcher 写入 HopLog；复用模式归 caller 生态 // @a: anc-obs-mode-boundary
      hopLog.recordStepMeta(step.step_id, {
        llm: {
          model: request.model, max_tokens: request.max_tokens,   // 发送口抄实际上限（^anc-exec-output-budget 观测条——烧穿排障不再翻代码答"上限是多少"）
          // thinking 实发参数摘要（发送口抄请求对象——0100 真机 probe 实撞:五级链装配后 hoplog 无 thinking 字段,probe '核 llm.request' 无从核）// @a: anc-exec-thinking-routing
          thinking: (request as { thinking?: { type: string; budget_tokens?: number } }).thinking
            ? ((request as { thinking?: { type: string; budget_tokens?: number } }).thinking!.type === 'enabled'
              ? `enabled:budget=${(request as { thinking?: { type: string; budget_tokens?: number } }).thinking!.budget_tokens}`
              : 'disabled')
            : 'absent',
          input_tokens: response.usage?.input_tokens, output_tokens: response.usage?.output_tokens,
          // 缓存观测（C）:命中率=cache_read/(input+cache_read);openai 协议恒 null 如实记 // @a: anc-exec-cache-control
          cache_read_input_tokens: response.usage?.cache_read_input_tokens ?? null,
          cache_creation_input_tokens: response.usage?.cache_creation_input_tokens ?? null,
          // 当次请求实际输入体量三项合计（^anc-exec-ctx-watermark——单看 input_tokens 被缓存命中掩住真实体量）// @a: anc-exec-ctx-watermark
          ctx_input_total: (response.usage?.input_tokens ?? 0) + (response.usage?.cache_read_input_tokens ?? 0) + (response.usage?.cache_creation_input_tokens ?? 0),
          // 发送边界成对落账（^anc-obs-record-at-boundary）：prompt 从实际 request 对象序列化
          // （旧形态只在 engine recordStepStart 记 formatPromptText 渲染件——意图层记录与实发
          // 内容分叉,假 prompt 骗过十几轮走查）;response 从实际返回抄录（DEBT-09,每轮尝试
          // 独立落账丢弃轮保痕）。级别裁剪在 recordStepMeta 内（debug 全文/info 剥离）。
          // @a: anc-obs-llm-response, anc-obs-record-at-boundary
          prompt: this.serializeRequestPrompt(request),
          response: this.extractTextContent(response),
        },
        tokens_used: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      });
    }
    // 横切 warn（软偏好落级等）随当步落账——warn 通道覆盖全部可执行路径,
    // 不只工具循环半边（真机实撞 2026-08-13:reason 步的落级 warn 悬在内存到 run 结束被丢）
    this.flushPendingWarns(step.step_id);

    // lack_of_info schema 供给站（llm-error-handling ^anc-exec-lack-of-info-chain 第2站——
    // 解析按声明收键,不前置探测则键被杀:单输出整段当声明值收下静默 completed 毒值入库/
    // 多输出键蒸发三轮白烧,2026-08-31 排查 probe 实锤。实装形态=解析前先探而非改 schema:
    // 追加进 schema 会把单输出 reason 推进多输出路径,破坏"全文即值"合法形态——前置探测
    // 零侵入,命中即短路返回,未命中原路解析）。// @a: anc-exec-lack-of-info-chain
    if (step.step_type === 'reason') {
      const loiValue = this.extractLackOfInfo(this.extractTextContent(response));
      if (loiValue !== undefined) return { lack_of_info: loiValue };
      // tool_failure 同站位探测（^anc-exec-tool-failure-report——reason 也用工具〔作者补定
      // "reason也需要用tool,特别是web search"〕;standalone reason 无工具环,自报面主要在
      // 复用模式,此处兜 standalone 漏网形态——解析层不杀键,承接归 completeStep 早判）。
      const tfValue = this.extractSelfReportKey(this.extractTextContent(response), 'tool_failure', '（未说明故障）');
      if (tfValue !== undefined) return { tool_failure: tfValue };
    }
    return this.parseStepOutput(response, step.context.output_schema, step.step_id);
  }

  /** lack_of_info 前置探测（^anc-exec-lack-of-info-chain 第2/3站——仅 reason 消费）:
   * 认"顶格 lack_of_info: " 行（与三档提取阶梯同款键行判据——思考散文在前合法,尾部键收）;
   * 值=该行冒号后 + 后续缩进延续行。声明字段名恰为 lack_of_info 的病态 spec 不冲突——
   * reason 交此键语义恒为自报缺信息（0053:该名对 reason 是保留语义）。 */
  private extractLackOfInfo(text: string): string | undefined {
    return this.extractSelfReportKey(text, 'lack_of_info', '（未说明缺什么）');
  }

  /** 语义性自报键前置探测公共体（lack_of_info/tool_failure 两通道同款站位——解析按声明收键,
   * 不前置探测则键被杀:单输出整段当声明值收下毒值 completed/多输出键蒸发白烧。
   * ^anc-exec-lack-of-info-chain 第2/3站 + ^anc-exec-tool-failure-report standalone 解析站）。 */
  private extractSelfReportKey(text: string, key: string, emptyFallback: string): string | undefined {
    const lines = text.split('\n');
    const re = new RegExp(`^${key}\\s*:\\s*(.*)$`);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      let val = m[1].trim().replace(/^\|-?$/, '');
      const rest: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+\S/.test(lines[j])) rest.push(lines[j].trim());
        else if (lines[j].trim() === '') continue;
        else break;   // 顶格新内容=键块结束
      }
      if (!val && rest.length) val = rest.join(' ');
      return val || emptyFallback;
    }
    return undefined;
  }

  // act 步骤中 LLM 仅能从预注册工具列表选择调用——无任意代码执行 // @a: anc-exec-sandbox-principle, anc-config-sandbox-step-mapping
  private async executeActWithTools(step: StepReady, allowCommit = false): Promise<Record<string, unknown>> {
    // 工具分档下发（0054 ^anc-step-tool-grant——basic 恒下发;special 须节点 `- 工具:` 声明:
    // 声明 * 全量,具名逐件,零声明零 special。缺省 category=special 收紧安全默认）。
    const nodeForGrants = this.findStepInSpec(step.step_id) as (StepNode & { tool_grants?: { name: string; note?: string }[]; tool_denies?: { name: string; note?: string }[] }) | null;
    const grants = nodeForGrants?.tool_grants ?? [];
    const grantAll = grants.some(g => g.name === '*');
    const grantedNames = new Set(grants.map(g => g.name));
    const deniedNames = new Set((nodeForGrants?.tool_denies ?? []).map(d => d.name));
    // reason 步 basic 不再豁免（^anc-exec-reason-tools 2026-09-18 修订——reason 全按声明,
    // basic 与 special 同一文法;act/commit 的 basic 恒下发照旧）。// @a: anc-exec-reason-tools
    const isReasonStep = nodeForGrants?.step_type === 'reason';
    const tools = this.toolProvider.list()
      .filter(t => !deniedNames.has(t.name))   // 禁用优先——被禁件（含 basic 族）从清单整体剔除,LLM 根本看不到（^anc-step-tool-deny） // @a: anc-step-tool-deny
      .filter(t => (!isReasonStep && (t.category ?? 'special') === 'basic') || grantAll || grantedNames.has(t.name))
      // requires_commit 件在 list 期过滤（^anc-exec-reason-tools "不能 commit 写"——reason 与
      // act free 同一条不可逆红线:非 commit 步这类工具恒不下发,LLM 根本看不到;运行期
      // COMMIT_REQUIRED 拦截保留作纵深防御——LLM 可能幻觉调用未下发的工具名）。
      // @a: anc-exec-reason-tools
      .filter(t => allowCommit || !t.requires_commit)
      .map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      }));

    // 角色档分道先算（^anc-exec-act-free-role——free act 收"任务执行"档,非 free act/commit
    // 收"确定性执行禁推理"档）。reason 步走本循环时角色档=reason 档（^anc-exec-reason-tools
    // HopSop 2.1——推理身份不变,工具只是增强;act/commit 分道照旧）。// @a: anc-exec-reason-tools
    const node = this.findStepInSpec(step.step_id) as ActStep | null;
    const roleKind = step.step_type === 'commit' ? 'commit'
      : step.step_type === 'reason' ? 'reason'
      : actRoleKind(node?.free);
    // roleKind 传入渲染源——L4"本步操作指引"子块按档就地渲染（L0 恒定化半边,
    // ^anc-exec-l0-worldview-impl:free act 的 node_decl.step_type 是裸 'act',须传分道后的档名）。
    let messages: Anthropic.MessageParam[] = this.buildMessages(step.context, roleKind);
    const systemPrompt = this.buildSystemPrompt(step.context);
    // 角色档 system 尾块注入线保持（^anc-exec-act-free-role 两线同源契约——review 实抓:角色
    // 前缀原只进 hoplog 记录线,standalone 真实请求零角色指引;注入易变尾块,不碰稳定块缓存前缀）。
    systemPrompt.push({ type: 'text', text: roleGuideText(roleKind) });
    // 调用点类别忠实（^anc-exec-model-resolve,0003）：commit 步按 'commit' 解析——原硬编码 'act'
    // 让 Config.models.commit/routing_rules[commit] 永不生效静默降配;共档回落在解析函数内。
    // reason 步同理按 'reason' 解析（^anc-exec-reason-tools——models.reason/routing_rules[reason]
    // 在工具循环形态下照常生效,不因换执行通道静默改按 act 档选模型）。
    const category = step.step_type === 'commit' ? 'commit' : step.step_type === 'reason' ? 'reason' : 'act';
    const resolved = this.resolveModel(category, step);
    const actClient = this.getClientForService(resolved.service_id);
    const maxOutputBudget = this.resolveMaxOutputTokens(resolved.service_id);   // 循环外解析一次（^anc-exec-output-budget）
    // openai 协议当下不支持 LLM 工具循环（作者定 2026-08-12，^todo-openai-tool-loop 观察账）——
    // 入口 fail-fast 指路，不带病进循环。带 body 的 act 不经此路径（body 工具走引擎白名单通道）。
    // @a: anc-exec-protocol-adapter
    if (actClient.protocol === 'openai-chat' && tools.length > 0) {
      throw new Error('PROTOCOL_TOOL_LOOP_UNSUPPORTED: openai-chat 协议 provider 不支持无 body 的 act 工具循环——给 act 写 hop_python body（工具走引擎白名单通道），或该步 @model 路由到 anthropic 协议 provider');
    }
    const toolCallLog: Array<{ name: string; result: 'success' | 'failure'; at: string; args_preview?: string; result_preview?: string }> = [];
    let lastSignature = '';   // 同签名断路器状态（^anc-exec-toolloop-repeat-break） // @a: anc-exec-toolloop-repeat-break
    let repeatCount = 0;

    let iteration = 0;
    // 本步是否已做过压缩降级（^anc-exec-toolloop-ctx-degrade——补救档只重试一次,
    // 二次撞墙=确定性失败,不陷 0070 的四连撞泥潭）。// @a: anc-exec-toolloop-ctx-degrade
    let ctxCompressed = false;
    while (iteration < this.maxToolIterations) {
      this.checkBudget();

      // 预检档（^anc-exec-toolloop-ctx-degrade 触发两档之一）：max_context_tokens 有配置时,
      // 粗估 messages 总字符 ÷4 超其 0.8 倍即先压缩再发——不配则跳过预检（向后兼容,
      // 只保留撞墙补救档）。// @a: anc-exec-toolloop-ctx-degrade
      const ctxLimit = this.hostConfig.resource_limits?.max_context_tokens;
      if (typeof ctxLimit === 'number' && ctxLimit > 0) {
        const approxTokens = this.estimateMessagesChars(messages) / 4;
        if (approxTokens > ctxLimit * 0.8) {
          // 每轮都预检——后续轮会把新脱离保护窗的长块继续压缩（已压缩块变短,天然不重压）
          const changed = await this.compressToolLoopMessages(messages, step, resolved.model, actClient);
          if (changed) ctxCompressed = true;
        }
      }

      const loopRequest: Anthropic.MessageCreateParamsNonStreaming = {
        model: resolved.model,
        system: systemPrompt,
        messages,
        max_tokens: maxOutputBudget,
        // 温度按步骤类型忠实（^anc-exec-reason-tools——reason 走本循环仍是推理步 0.3,
        // act/commit 照旧 0;与单发路径 buildApiRequest 的 selectTemperature 同源）。
        temperature: this.selectTemperature(step.step_type),
        tools,
        // thinking 五级链同装（review 批 F1 修——工具循环原零 thinking 键,act free/带工具 reason
        // 整级旁路"恒显式"承诺;与单发路径同一 resolveThinkingParam 单点,级1 记名册降档、
        // 级2 @thinking、级5 act free 恒开自此对工具循环步真实生效）。
        // @a: anc-exec-thinking-routing
        ...this.resolveThinkingParam(step.step_type, step, resolved, maxOutputBudget),
      };
      let response: Anthropic.Message;
      try {
        response = await this.callLlmWithRetry(loopRequest, actClient);
      } catch (err: unknown) {
        // 补救档（^anc-exec-toolloop-ctx-degrade——0070 实撞主形态:tool_result 累积撞模型窗,
        // 原工具循环零捕获直死;首撞压缩重试一次,二次撞墙=确定性失败,CONTEXT_OVERFLOW:
        // 前缀入 exec-engine 确定性口袋,容器 retry 不原样重跑）。// @a: anc-exec-toolloop-ctx-degrade
        if (actClient.classifyError(err) !== 'context_overflow') throw err;
        const changed = ctxCompressed ? false
          : await this.compressToolLoopMessages(messages, step, resolved.model, actClient);
        if (!changed) {
          throw new Error('CONTEXT_OVERFLOW: 工具循环压缩降级后仍超模型窗——单步材料量超出模型能力，拆步骤（for-each 逐份）或换更大窗的模型');
        }
        ctxCompressed = true;
        try {
          response = await this.callLlmWithRetry({ ...loopRequest, messages }, actClient);
        } catch (err2: unknown) {
          if (actClient.classifyError(err2) === 'context_overflow') {
            throw new Error('CONTEXT_OVERFLOW: 工具循环压缩降级后仍超模型窗——单步材料量超出模型能力，拆步骤（for-each 逐份）或换更大窗的模型');
          }
          throw err2;
        }
      }

      // 工具循环逐轮 llm 落账（DEBT-09 兑现:act free 步此前零 llm 块——coffee 修错步三轮
      // "无错未动"的推理文本无从对证;response 含本轮 text 推理与 tool_use 意图摘要,
      // 级别裁剪在 recordStepMeta 内）。// @a: anc-obs-llm-response
      // 首轮同时记 prompt——发送口抄实际 request,与
      // reason/check 路径同源（^anc-obs-llm-response 2026-08-31 补:此前 act 路径零 prompt,
      // "L4 工具清单有没有真进请求"hoplog 无从对证;后续轮不重复——首轮已含组装上下文全文,
      // 逐轮全文是 20 倍冗余,增量可由 tool: 块与各轮 response 复原）。
      this.engine.getHopLog()?.recordStepMeta(step.step_id, {
        llm: {
          model: resolved.model, max_tokens: maxOutputBudget,   // 同上,工具循环轮 // @a: anc-exec-output-budget
          // thinking 实发摘要（工具循环轮,发送口抄 loopRequest——与单发路径同款观测,F1 修后本路径真有此参数）// @a: anc-exec-thinking-routing
          thinking: (loopRequest as { thinking?: { type: string; budget_tokens?: number } }).thinking
            ? ((loopRequest as { thinking?: { type: string; budget_tokens?: number } }).thinking!.type === 'enabled'
              ? `enabled:budget=${(loopRequest as { thinking?: { type: string; budget_tokens?: number } }).thinking!.budget_tokens}`
              : 'disabled')
            : 'absent',
          input_tokens: response.usage?.input_tokens, output_tokens: response.usage?.output_tokens,
          cache_read_input_tokens: response.usage?.cache_read_input_tokens ?? null,
          cache_creation_input_tokens: response.usage?.cache_creation_input_tokens ?? null,
          // 当次请求实际输入体量三项合计（^anc-exec-ctx-watermark——单看 input_tokens 被缓存命中掩住真实体量）// @a: anc-exec-ctx-watermark
          ctx_input_total: (response.usage?.input_tokens ?? 0) + (response.usage?.cache_read_input_tokens ?? 0) + (response.usage?.cache_creation_input_tokens ?? 0),
          ...(iteration === 0 ? { prompt: this.serializeRequestPrompt(loopRequest) } : {}),
          response: response.content.map(b => b.type === 'text' ? b.text : (b.type === 'tool_use' ? `[tool_use ${b.name}] ${JSON.stringify(b.input)}` : `[${b.type}]`)).join('\n'),
        },
        tokens_used: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      });

      const hasToolUse = response.content.some(b => b.type === 'tool_use');
      // 中间轮截断闸（二十六审对读抓:掐在工具参数生成中途时,半截参数会被直接拿去执行工具——
      // write 类工具吃残缺参数比收残值更危险;终轮无 tool_use 走 parseStepOutput 已有闸,
      // 本判补上带 tool_use 的轮次）。// @a: anc-exec-output-truncation-loud
      if (hasToolUse && response.stop_reason === 'max_tokens') {
        // 反刍分流不设本站（^anc-exec-thinking-exhausted 二批删——本分支前提 hasToolUse=true,
        // 而分流函数对 tool_use 恒不碰〔产工具参数被掐非反刍〕,调用结构性空转;终轮无 tool_use
        // 的响应归 parseStepOutput 闸接住,覆盖面无洞）。
        throw new Error(`OUTPUT_TRUNCATED: 工具循环轮输出被 max_tokens 掐断（output_tokens=${response.usage?.output_tokens ?? '?'}）——工具参数可能残缺,不执行。调大 HOPJIT_MAX_OUTPUT_TOKENS 或 resource_limits.max_output_tokens`);
      }
      if (!hasToolUse) {
        this.flushToolLog(step.step_id, toolCallLog);
        // C 案机械兜底（^anc-exec-tool-failure-report——本步用了工具且全部失败却即将交正常
        // 产出:可能是"检索故障伪装成搜不到"的静默退化形态。warn 留痕不拦截——LLM 可能合法
        // 地在工具全挂后如实交了降级说明,判决归审计面,tool 块可对账）。// @a: anc-exec-tool-failure-report
        if (toolCallLog.length > 0 && toolCallLog.every(t => t.result === 'failure')) {
          this.engine.getHopLog()?.recordWarn(step.step_id,
            `本步全部 ${toolCallLog.length} 次工具调用均失败,产出可能建立在零工具成果上（tool 块可对账）`);
        }
        // lack_of_info 终轮前置探测（^anc-exec-reason-tools HopSop 第 3 步——reason 走工具循环后
        // 自报出口位置不变:仅 reason 消费,act 无此语义通道〔0053 承接面裁定〕）。
        // @a: anc-exec-reason-tools, anc-exec-lack-of-info-chain
        if (step.step_type === 'reason') {
          const loiValue = this.extractLackOfInfo(this.extractTextContent(response));
          if (loiValue !== undefined) return { lack_of_info: loiValue };
        }
        // tool_failure 自报前置探测（^anc-exec-tool-failure-report 解析站——与 lack_of_info
        // 同款站位:解析按声明收键,不前置探测则单输出把自报段当声明值收下毒值 completed。
        // 无 body act 与 reason 经本循环;commit 同经但 B7 error 后不可达）。// @a: anc-exec-tool-failure-report
        const tfValue = this.extractSelfReportKey(this.extractTextContent(response), 'tool_failure', '（未说明故障）');
        if (tfValue !== undefined) return { tool_failure: tfValue };
        return this.parseStepOutput(response, step.context.output_schema, step.step_id);
      }

      const assistantContent = response.content;
      messages = [...messages, { role: 'assistant', content: assistantContent }];

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of assistantContent) {
        if (block.type === 'tool_use') {
          // act 步骤拦截 requires_commit=true 的工具；commit 步骤是授权执行点，放行 // @a: anc-exec-requires-commit
          const toolDef = this.toolProvider.list().find(t => t.name === block.name);
          if (!allowCommit && toolDef?.requires_commit) {
            throw new Error('COMMIT_REQUIRED: tool "' + block.name + '" requires commit step');
          }
          // 同签名断路器（^anc-exec-toolloop-repeat-break——连续 3 次同名同参即断:同输入
          // 重发结果不会不同,复读是形态病不是总量病〔实撞:14 连扫同一空目录,总量闸第 20 轮
          // 才拦〕;同名不同参不触发——合法逐文件遍历形态）。// @a: anc-exec-toolloop-repeat-break
          const signature = `${block.name}|${JSON.stringify(block.input)}`;
          repeatCount = signature === lastSignature ? repeatCount + 1 : 1;
          lastSignature = signature;
          if (repeatCount >= 3) {
            this.flushToolLog(step.step_id, toolCallLog);
            throw new Error(`TOOL_LOOP_REPEAT: 工具调用 "${block.name}" 以完全相同的参数连续重复 ${repeatCount} 次——同一调用的结果不会不同,这是复读循环不是探索（明细已落 HopLog tool 块）`);
          }
          // 写域随 allowCommit 分派（同 body 解释器）：act free 的 LLM 临场写文件同受 work_zone
          // 收窄——free 只影响行为可预期性,不放大权限（2026-08-28 作者定）。// @a: anc-exec-write-scope
          const result = await this.toolProvider.execute(block.name, block.input as Record<string, unknown>, allowCommit ? 'workspace' : 'work_zone');
          // tool 审计性字段，步骤完成时经 recordStepMeta 写入 // @a: anc-obs-audit
          // args/result 截断预览入账（^anc-obs-audit——tool_result 是模型每轮决策的直接输入,
          // 不在账上=验尸只能猜模型看见了什么〔Qwen 复读循环实撞:空目录注记送没送到靠 dist
          // grep 旁证〕;500 字符短结果全文在账,大文件 read 只留头部;debug 级才记）。
          const isDebug = this.engine.getHopLog()?.getLevel?.() === 'debug';
          const preview = (s: string) => s.length <= 500 ? s : `${s.slice(0, 500)}…[截断,原长${s.length}]`;
          const renderedForLog = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
          toolCallLog.push({
            name: block.name, result: result.success ? 'success' : 'failure', at: new Date().toISOString(),
            ...(isDebug ? { args_preview: preview(JSON.stringify(block.input)), result_preview: preview(renderedForLog) } : {}),
            ...(result.audit ?? {}),
          });
          // 对象结果（Composite unwrap/裁剪通过面）序列化为 JSON 文本——String() 直转对象
          // 产 "[object Object]"，LLM 只能报"结果不可解析"（fact-check 实撞:工具全 success
          // 而 8 事实点全 not_found）。// @a: anc-exec-tool-result-render
          const rendered = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.success ? rendered : `Error: ${rendered}`,
            is_error: !result.success,
          });
        }
      }

      // 滚动断点（B）:最新 user 消息打 cache_control——N 轮循环逐轮增量复用（上一轮已缓存
      // 前缀由 API 最长前缀匹配自然接续）。滚动=移动不是累加:打新断点前先清 messages 内
      // 既有 tool_result 块上的 cache_control（system 稳定块断点在 system 数组不在此,不动）,
      // 保证 messages 内恒最多 1 个断点——初版只打不清,5 轮循环累积 6 断点超 Anthropic 官方
      // 上限 4,API 400 拒收长循环必死（2026-09-04 review 面二 D1 实锤）。openai 协议不走
      // 本循环（入口已拦）。// @a: anc-exec-cache-control
      for (const m of messages) {
        if (m.role !== 'user' || typeof m.content === 'string') continue;
        for (const b of m.content) {
          if (b.type === 'tool_result') delete (b as Anthropic.ToolResultBlockParam & { cache_control?: unknown }).cache_control;
        }
      }
      const lastResult = toolResults[toolResults.length - 1];
      if (lastResult) (lastResult as Anthropic.ToolResultBlockParam & { cache_control?: { type: 'ephemeral' } }).cache_control = { type: 'ephemeral' };
      messages = [...messages, { role: 'user', content: toolResults }];
      iteration++;
    }

    // 耗尽路径先落工具明细再抛（三十一审续:原 throw 前不 flush,20 轮工具调用账全丢——
    // MAX_TOOL_ITERATIONS 的归因〔在打转什么〕只能瞎猜;观测层无洞原则）。// @a: anc-obs-audit
    this.flushToolLog(step.step_id, toolCallLog);
    throw new Error(`MAX_TOOL_ITERATIONS: exceeded tool use iteration limit（${this.maxToolIterations} 轮;明细已落 HopLog tool 块）`);
  }

  /** 工具循环 messages 总字符量粗估（预检档折算料——÷4 换算 token 在调用侧）。
   * ^anc-exec-toolloop-ctx-degrade */ // @a: anc-exec-toolloop-ctx-degrade
  private estimateMessagesChars(messages: Anthropic.MessageParam[]): number {
    let total = 0;
    for (const m of messages) {
      if (typeof m.content === 'string') { total += m.content.length; continue; }
      for (const b of m.content) {
        if (b.type === 'text') total += b.text.length;
        else if (b.type === 'tool_result' && typeof (b as Anthropic.ToolResultBlockParam).content === 'string') {
          total += ((b as Anthropic.ToolResultBlockParam).content as string).length;
        } else if (b.type === 'tool_use') total += JSON.stringify((b as Anthropic.ToolUseBlockParam).input).length;
      }
    }
    return total;
  }

  /** 工具循环上下文压缩降级（^anc-exec-toolloop-ctx-degrade,hopissues/0070）——把早轮超长
   * tool_result 的原文替换为任务相关摘要（作者拍板:"换成一句已读过没意义,不在 prompt 里的
   * 对 LLM 就是没看过,应该换成和本任务相关的摘要,其他的在文件里"）。规则:跳过最近 2 轮
   * user 消息（近轮是 LLM 正在操作的现场）;只压 content 为字符串且超 16000 字符（≈4000 token）
   * 的块;摘要调用用当前步骤 resolved 模型;单块压缩失败退化头部节选 8000 字符（逐块独立
   * try/catch,一块失败不连坐——不因压缩本身再死）。原地改写 messages,返回是否有块被改写。
   * 已知代价:cache_control 前缀断点从改写点失效——墙内生存权>缓存费（设计条款随记）。 */
  // @a: anc-exec-toolloop-ctx-degrade
  private async compressToolLoopMessages(
    messages: Anthropic.MessageParam[],
    step: StepReady,
    model: string,
    client: ProtocolClient,
  ): Promise<boolean> {
    const COMPRESS_THRESHOLD = 16000;   // 字符（≈4000 token）——短块压缩收益低于一次压缩调用的成本
    const FALLBACK_EXCERPT = 8000;      // 压缩调用失败时的头部节选字符数
    // 定位最近 2 个 user 消息（最近 2 轮工作现场,不动）
    const userIndexes: number[] = [];
    for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') userIndexes.push(i);
    const protectedIdx = new Set(userIndexes.slice(-2));

    let changed = false;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'user' || protectedIdx.has(i) || typeof m.content === 'string') continue;
      for (const block of m.content) {
        if (block.type !== 'tool_result') continue;
        const tr = block as Anthropic.ToolResultBlockParam;
        if (typeof tr.content !== 'string' || tr.content.length <= COMPRESS_THRESHOLD) continue;
        const originalLen = tr.content.length;
        let summary: string;
        let degraded = false;   // 退化件标记——节选不冒充摘要,标注与留痕文案随之分流（设计条款分立两款）
        try {
          // 经 callLlmWithRetry 发——压缩调用同样入 token 记账与错误分类重试
          const resp = await this.callLlmWithRetry({
            model,
            max_tokens: 2048,
            system: '你是上下文压缩助手。把给定材料压缩成与当前任务相关的要点,只保留对完成任务有用的信息（结论/数据/关键引文与其位置）,不复述无关内容。',
            messages: [{
              role: 'user',
              content: `当前任务说明:\n${step.context.instruction}\n\n待压缩材料（早前工具调用的返回原文）:\n${tr.content}\n\n请输出与当前任务相关的要点摘要。`,
            }],
          }, client);
          const text = resp.content.filter(b => b.type === 'text').map(b => (b as Anthropic.TextBlock).text).join('\n').trim();
          if (!text) throw new Error('压缩调用返回空文本');
          summary = text;
        } catch {
          // 退化路径:头部节选——压缩调用自身失败不连坐,更不因压缩再死
          summary = tr.content.slice(0, FALLBACK_EXCERPT);
          degraded = true;
        }
        // 标注分立两款（对下游 LLM 如实——节选不冒充摘要:冒充会让 LLM 把"恰好截在头部的
        // 片段"当"已提炼的任务要点"用,判断建立在假前提上）。// @a: anc-exec-toolloop-ctx-degrade
        tr.content = degraded
          ? `${summary}\n\n[原文 ${originalLen} 字符；压缩调用失败，以下为头部节选；完整内容可重新调用工具获取]`
          : `${summary}\n\n[原文 ${originalLen} 字符已压缩为任务相关摘要；完整内容可重新调用工具获取]`;
        changed = true;
        this.engine.getHopLog()?.recordWarn(step.step_id,
          `[ctx-compress] 早轮 tool_result 原文 ${originalLen} 字符→压缩后 ${tr.content.length} 字符（${degraded ? '头部节选（压缩调用失败退化）' : '任务相关摘要'},^anc-exec-toolloop-ctx-degrade）`);
      }
    }
    return changed;
  }

  private executeConfirm(step: StepReady): 'paused' { // @a: anc-exec-paused-resume
    // confirm 暂停：构造 ExecutionPaused 信号，步骤保持 running 等待 caller 决策
    const node = this.findStepInSpec(step.step_id) as ConfirmStep | null;
    const options: { value: string; label: string }[] = node?.response_options
      ?? [
        { value: 'approve', label: '批准' },
        { value: 'reject', label: '拒绝' },
      ];
    this.pendingPause = {
      status: 'paused',
      instance_id: this.engine.getInstanceId(),
      step_id: step.step_id,
      pause_reason: node?.require_human ? 'waiting_human' : 'confirm',
      presented_data: {
        summary: step.summary,
        instruction: step.context.instruction,
        context: step.context.inputs,
      },
      response_options: options,
      work_zone: '',  // 独立模式不暴露 work_zone 给外部 driver, 见 anc-exec-work-zone
    };
    return 'paused';
  }

  // commit 直接执行不可逆操作——授权已在前序完成（环境预授权或前置 confirm），commit 本身不暂停鉴权
  // 如同 git commit：能执行到此即已授权，直接执行写入。audit 记录执行内幕。 // @a: anc-step-commit
  private async executeCommit(step: StepReady): Promise<Record<string, unknown>> {
    // commit 执行入口动态核（^anc-exec-advance-order-invariant 防线二,独立模式入口）：
    // 不可逆操作执行前核"文档序先于本步的全部步骤已终态"——存在 pending/running 即抛,
    // executeStep 的 catch 统一 failStep 带明细走升级链（与复用模式入口同一判定公共件,
    // 经引擎门面 findNonTerminalBeforeStep 取判定——engine-traverse 是引擎私有非出口文件,
    // 不跨模块深入;拒的载体形态按模式分:那边 WAITING_WRITEBACK 同族响应等回写,
    // 这边执行流单线程走到这=真乱序,失败响亮）。// @a: anc-exec-advance-order-invariant
    {
      const blocking = this.engine.findNonTerminalBeforeStep(step.step_id);
      if (blocking) {
        throw new Error(`ADVANCE_ORDER_VIOLATION: commit 步 '${step.step_id}' 之前的步骤 '${blocking}' 尚未终态——不可逆操作拒绝越序执行（^anc-exec-advance-order-invariant）`);
      }
    }
    const node = this.findStepInSpec(step.step_id) as CommitStep | null;
    const target = node?.irreversible_action ?? step.summary;
    const hopLog = this.engine.getHopLog();
    // commit 走 body 执行器（allowCommit=true 放行 requires_commit 工具）；无 body 回退 LLM 循环
    const result = await this.executeActBody(step, true);
    // commit_audit 审计性字段：记录不可逆操作执行 // @a: anc-obs-audit
    // authorized_by='policy'：授权由前序流程（confirm 或环境策略）建立，非 commit 自身索取
    if (hopLog) {
      hopLog.recordStepMeta(step.step_id, {
        commit_audit: { target, authorized_by: 'policy', result: 'success', at: new Date().toISOString() },
      });
    }
    return result;
  }

  // act/commit 执行：有 hop_python body 走 BodyInterpreter（确定性、无 LLM）；
  // 无 body 回退 executeActWithTools（LLM 循环，存量 spec 零回归）。工具通道选路点——
  // 五通道地图见 design/tool-channels.md。// @a: anc-exec-act-body-interp, anc-exec-tool-channels
  private async executeActBody(step: StepReady, allowCommit: boolean): Promise<Record<string, unknown>> {
    const node = this.findStepInSpec(step.step_id) as ActStep | CommitStep | null;
    if (!node?.body) {
      return this.executeActWithTools(step, allowCommit);   // fallback
    }
    const toolCallLog: Array<{ name: string; result: 'success' | 'failure'; at: string; args_preview?: string; result_preview?: string }> = [];
    const warnLog: string[] = [];
    const interp = new BodyInterpreter({
      inputs: step.context.inputs,
      toolProvider: this.toolProvider,
      allowCommit,
      workZone: this.engine.getWorkZone(),
      toolCallLog,
      warnLog,
      hopEnv: this.hostConfig.hop_env,   // @a: anc-exec-body-hop-env
      // 独立模式 body 单遍执行无重放——传新数组即可用；重试=新尝试取新时间是预期语义,不落盘。
      // 见 design/act-body.md ^anc-exec-time-builtins。// @a: anc-exec-time-builtins
      timeJournal: [],
      // subprocess.run 双模式接线（^anc-exec-subprocess-run——review 抓 standalone 恒关死:
      // 原不注入 commandWhitelist 必撞"未配置白名单";白名单同源 hostConfig,journal 经引擎
      // 同一账跨进程持久）。// @a: anc-exec-subprocess-run
      commandWhitelist: this.hostConfig.sandbox?.runtime?.available,
      cmdJournal: this.engine.getCmdJournalFor(step.step_id),
    });
    const outputs = await interp.run(node.body, step.context.output_schema);
    // 计算异常也是 fail（2026-08-09 定稿）：warnLog 非空=body 算错=本步 fail,
    // warn 先入 HopLog 留痕再抛——executeStep 的 catch 统一 failStep 走升级链。
    for (const w of warnLog) this.engine.getHopLog()?.recordWarn(step.step_id, w);
    if (warnLog.length > 0) {
      throw new Error(warnLog.join('; '));
    }
    // tool 审计字段：步骤完成时写入 HopLog（与 executeActWithTools 一致）// @a: anc-obs-audit
    this.flushToolLog(step.step_id, toolCallLog);
    return outputs;
  }

  /** thinking 五级优先链装配单点（0100 批;review 批 F1 修提为公共件——buildApiRequest 单发路径
   * 与 executeActWithTools 工具循环路径同一条链,"恒显式"承诺两路径同兑现）。
   * 五级:记名册 > 步骤 @thinking > routing_rules > provider 缺省 > 引擎内建步骤类型缺省
   * （act 无 body 未标 free/commit 关;act free/reason/check/replan 开——作者拍分类表 2026-09-20）。
   * 级4 缺省 provider 回退:service_id 为 default 时读首 provider 的 {SID}_THINKING
   * （与 auth defaultClient 补装同构——缺省路径不补则唯一 provider 配键不写路由时静默失效）。 */
  // @a: anc-exec-thinking-routing, anc-exec-thinking-exhausted, anc-exec-thinking-step-annotation, anc-exec-thinking-provider-default
  private resolveThinkingParam(stepType: ExecutableStepType | 'replan', step: StepReady | undefined, resolved: { service_id: string; thinking?: 'enabled' | 'disabled' }, maxOutput: number): { thinking?: { type: 'disabled' } | { type: 'enabled'; budget_tokens: number } } {
    // budget=预算半,下限夹 1024（anthropic 协议最低值——小预算+enabled 组合原发 750 违约 400;
    // 四十六审探针抓）。budget≥maxOutput 时端点自拒,夹上限 maxOutput-1 防倒挂
    const enabledParam = { type: 'enabled' as const, budget_tokens: Math.min(Math.max(Math.floor(maxOutput / 2), 1024), Math.max(maxOutput - 1, 1024)) };
    // 级1 记名册（止血恒最高——该步已实证烧穿,标 on 也压不回）
    if (step && this.thinkingExhaustedSteps.has(step.step_id)) return { thinking: { type: 'disabled' } };
    // 级2 步骤 @thinking 标注（步骤节点查不到时短路——replan 场景无 step 天然走此路）
    const stepNode = step ? this.findStepInSpec(step.step_id) : undefined;
    if (stepNode?.thinking_override === 'off') return { thinking: { type: 'disabled' } };
    if (stepNode?.thinking_override === 'on') return { thinking: enabledParam };
    // 级3 routing_rules（resolveModel 带出）
    if (resolved.thinking === 'disabled') return { thinking: { type: 'disabled' } };
    if (resolved.thinking === 'enabled') return { thinking: enabledParam };
    // 级4 provider 缺省（{SERVICE_ID}_THINKING——buildEnvSnapshot 披发;缺省 provider 路径回退首
    // provider 的键,与 auth defaultClient 同构）
    let provDefault = this.envOf(`${resolved.service_id.toUpperCase()}_THINKING`);
    if (provDefault === undefined && resolved.service_id === 'default') {
      const firstSid = this.hostConfig.model_engine?.routing_rules?.[0]?.service_id
        ?? this.hostConfig.model_engine?.default_service_id;
      if (firstSid && firstSid !== 'default') provDefault = this.envOf(`${firstSid.toUpperCase()}_THINKING`);
    }
    if (provDefault === 'disabled') return { thinking: { type: 'disabled' } };
    if (provDefault === 'enabled') return { thinking: enabledParam };
    // 级5 引擎内建步骤类型缺省（作者拍分类表:act 无 body 未标 free/commit → 关;
    // act free/reason/check/replan → 开。带 body 步骤引擎直执不经本函数;
    // 步骤节点查不到时 act 按非 free 关——设计 1390 落空分叉句）
    const isActFree = stepType === 'act' && stepNode?.step_type === 'act' && (stepNode as { free?: boolean }).free === true;
    const off = (stepType === 'act' && !isActFree) || stepType === 'commit';
    return { thinking: off ? { type: 'disabled' } : enabledParam };
  }

  private buildApiRequest(context: AssembledContext, stepType: ExecutableStepType | 'replan', step?: StepReady): { request: Anthropic.MessageCreateParamsNonStreaming; client: ProtocolClient } {
    const system = this.buildSystemPrompt(context, stepType);
    const messages = this.buildMessages(context, stepType);
    const resolved = this.resolveModel(stepType, step);
    const client = this.getClientForService(resolved.service_id);
    const maxOutput = this.resolveMaxOutputTokens(resolved.service_id);

    return {
      request: {
        model: resolved.model,
        system,
        messages,
        max_tokens: maxOutput,
        temperature: this.selectTemperature(stepType),
        // thinking 五级优先链——单点 resolveThinkingParam(工具循环 loopRequest 同用;
        // review 批 F1 修:原 IIFE 只装单发路径,act free/无 body act/带工具 reason 整级旁路)。
        // @a: anc-exec-thinking-routing
        ...this.resolveThinkingParam(stepType, step, resolved, maxOutput),
      },
      client,
    };
  }

  // 两线合一（^anc-obs-record-at-boundary / ^anc-exec-cache-affinity）：standalone 请求与
  // hoplog 记录共用 renderPromptParts 单一渲染源——旧形态 dispatcher 自拼四段消息（[执行进度]/
  // [步骤输入]/[当前任务]/[输出要求]）,不含 L0 角色/世界观、不含 L6 修正指令,与 engine 记的
  // formatPromptText 渲染件内容分叉:假 prompt 记录骗过十几轮走查,三次"模型锚定"定罪建立在
  // 模型从未收到的 prompt 上（作者定 2026-08-24"不能再犯那么蠢的问题"）。
  // system 分稳定/易变两块:稳定块尾打 cache_control 断点（anthropic 生效;openai 适配器剥除）。
  // @a: anc-exec-cache-control, anc-exec-cache-affinity, anc-obs-record-at-boundary, anc-exec-doc-ref-injection, anc-exec-hop-env-table
  private buildSystemPrompt(context: AssembledContext, stepType?: string): Anthropic.TextBlockParam[] {
    const parts = renderPromptParts(context, stepType);
    const stableText = `Working directory: ${this.hostConfig.workspace_dir}\n\n` + parts.stableSections.join('\n\n');
    return [{ type: 'text', text: stableText, cache_control: { type: 'ephemeral' } }];
  }

  private buildMessages(context: AssembledContext, stepType?: string): Anthropic.MessageParam[] {
    const parts = renderPromptParts(context, stepType);
    // 易变面整体作单条 user 消息（L6 修正指令天然垫尾——渲染源已按层序排好,不再自拼）
    return [{ role: 'user', content: parts.volatileSections.join('\n\n') }];
  }

  /** 发送边界的 prompt 序列化——llm.prompt 从实际 request 对象抄录（与 response 同点成对,
   * ^anc-obs-record-at-boundary:记"实际发送的字节"而非上游渲染意图）。 */
  private serializeRequestPrompt(request: Anthropic.MessageCreateParamsNonStreaming): string {
    const sys = Array.isArray(request.system)
      ? request.system.map(b => (typeof b === 'string' ? b : b.text)).join('\n\n')
      : (request.system ?? '');
    const msgs = (request.messages ?? []).map(m =>
      typeof m.content === 'string' ? m.content
        : m.content.map(b => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
    ).join('\n\n');
    return `${sys}\n\n${msgs}`;
  }

  formatInputs(inputs: Record<string, unknown>): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(inputs)) {
      if (value === null || value === undefined) {
        lines.push(`${key}: None`);
      } else if (typeof value === 'string') {
        // 截断废除（BUG-H 同批）：截断=另一种信息损毁——大输入吃 token 是正确性的代价,
        // token 压力归预算裁剪链治理,不由静默截断治理。// @a: anc-exec-llm-inline-context
        lines.push(`${key}: ${value}`);
      } else {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : '(none)';
  }

  formatOutputSchema(schema: OutputDecl[]): string {
    return schema.map(o => {
      let line = `- ${o.name}: ${o.type}`;
      if (o.description) line += ` # ${o.description}`;
      return line;
    }).join('\n');
  }

  private selectTemperature(stepType: ExecutableStepType | 'replan'): number {
    switch (stepType) {
      case 'reason': return 0.3;
      case 'act': return 0;
      case 'check': return 0;
      case 'commit': return 0;
      default: return 0.3;
    }
  }

  // 端点拒收 temperature 的 per-client 标记：命中一次后该 client 整个 run 期免传（防每步 400 一次）
  private tempRejectedClients = new WeakSet<ProtocolClient>();

  // 部分兼容端点新模型拒收 temperature（DeepSeek 400 "`temperature` is deprecated"，2026-08-06 真机实撞）。
  // 见 design/step-dispatcher.md「temperature 拒收自适应」。
  private isTemperatureRejected(err: unknown): boolean {
    return err instanceof Anthropic.APIError && err.status === 400
      && /temperature/i.test(err.message);
  }

  private async callLlmWithRetry(request: Anthropic.MessageCreateParamsNonStreaming, client?: ProtocolClient): Promise<Anthropic.Message> { // @a: anc-exec-api-retry
    const maxRetries = 6;   // 外层护栏=各错误档最大值（网络档 v0.14.1 扩到 6——外层小于档位则耗尽分支永不触发,裸错漏出）
    let lastError: unknown;
    const c = client ?? this.defaultClient;
    if (this.tempRejectedClients.has(c)) delete (request as { temperature?: number }).temperature;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await c.create(request);
        this.cumulativeTokens += resp.usage.input_tokens + resp.usage.output_tokens;
        this.engine.setCumulativeTokens(this.cumulativeTokens);  // 引擎随快照落盘,resume 回填 // @a: anc-exec-cost-guardrails
        this.trackCtxWatermark(resp);   // 水位观测在发送口事实边界（成功侧）// @a: anc-exec-ctx-watermark
        this.checkBudget();
        return resp;
      } catch (err: unknown) {
        lastError = err;

        const kind = c.classifyError(err);   // 类别分派（双协议归一）// @a: anc-exec-protocol-adapter

        // temperature 拒收：剥除后立即重试（不计退避次数），并标记该 client 免传
        if (request.temperature !== undefined && kind === 'temperature_rejected') {
          this.tempRejectedClients.add(c);
          delete (request as { temperature?: number }).temperature;
          attempt--;
          continue;
        }

        if (kind === 'auth') throw err;
        if (kind === 'context_overflow') throw err;

        const retriesForError = this.getMaxRetries(kind);
        if (attempt >= retriesForError) {
          // 网络类耗尽:裸文案挂可读前缀再上传（2026-08-23 作者定——dr10 实撞 undici 断流
          // 原文案 `terminated` 直落 FailRecord,经 L2c 给下一轮 LLM 零信息量,LLM 会试图
          // "修正"一个网络故障;走查者也分不清内容失败与环境失败。前缀是 L2c 渲染侧
          // "非内容问题"分流的判据）。// @a: anc-exec-api-retry
          if (kind === 'network' || kind === 'timeout') {
            // message 优先取字段——SDK 错误对象可能非 Error 子类,String() 得 [object Object]
            const raw = (err as { message?: unknown })?.message != null ? String((err as { message?: unknown }).message) : String(err);
            // 超时且水位已越 75% 线:文案追加体量提示（^anc-exec-ctx-watermark ③——超时与
            // 体量相关时重试大概率同因;网络瞬断无水位嫌疑照旧安静文案）。// @a: anc-exec-ctx-watermark
            const ctxLimit = this.hostConfig.resource_limits?.max_context_tokens;
            const ctxHint = (kind === 'timeout' && typeof ctxLimit === 'number' && ctxLimit > 0 && this.ctxWatermark > ctxLimit * 0.75)
              ? `;实例上下文水位 ${Math.round(this.ctxWatermark / 1000)}K 已近告警线——超时与体量相关的概率高,重试大概率同因,考虑拆步骤（0095）`
              : '';
            throw new Error(`NETWORK_ERROR: 网络中断（非内容问题——与产出质量无关,原文: ${raw}${ctxHint}）`);
          }
          throw err;
        }

        const delay = Math.min(1000 * Math.pow(2, attempt), 60_000) + Math.random() * 100;   // 封顶 60s（v0.14.1——网络 6 次档 1s→2s→4s→8s→16s→32s） // @a: anc-exec-api-retry
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  // 重试预算按错误类别（原 7 个 instanceof 判定收编进 ProtocolClient.classifyError——
  // 双协议归一，逐类别行为不变）。// @a: anc-exec-protocol-adapter, anc-exec-api-retry
  private getMaxRetries(kind: import('./protocol-openai.js').LlmErrorKind): number {
    if (kind === 'rate_limited') return 4;
    if (kind === 'server_error') return 3;
    // 网络/超时 6 次×退避封顶 60s,总耐受约 2 分钟（v0.14.1 A 半边——dr17 实撞:旧 2 次
    // 总耐受 3 秒,1 分钟网络中断 43 秒烧穿全树;网络恢复时间分布与限流同级甚至更长,
    // 只给 2 次没道理）。耗尽后走网络暂停不 fail step（B 半边 ^anc-exec-network-pause）。
    if (kind === 'timeout' || kind === 'network') return 6;
    return 0;
  }

  private checkBudget(): void { // @a: anc-exec-cost-guardrails
    if (this.tokenBudget && this.cumulativeTokens >= this.tokenBudget) {
      throw new Error('BUDGET_EXCEEDED: token budget exhausted');
    }
  }

  private parseStepOutput(response: Anthropic.Message, schema: OutputDecl[], stepId?: string): Record<string, unknown> {
    // 截断响亮失败——max_tokens 掐断的输出是残值（thinking 型可把预算全烧推理,text 空）,
    // 收下=毒值下游+重试反馈错误归因"你没产出"（buildtest 实撞:16384 全 thinking,node_result=""
    // 同因必死）。见 design ^anc-exec-output-truncation-loud。// @a: anc-exec-output-truncation-loud
    if (response.stop_reason === 'max_tokens') {
      const rum = this.checkThinkingExhausted(response, 'parseStepOutput', stepId);   // @a: anc-exec-thinking-exhausted
      if (rum) throw new Error(rum);
      const used = response.usage?.output_tokens ?? '?';
      throw new Error(`OUTPUT_TRUNCATED: 输出被 max_tokens 上限掐断（output_tokens=${used}）——产出不完整不可用。调大 HOPJIT_MAX_OUTPUT_TOKENS 或 resource_limits.max_output_tokens`);
    }
    const text = this.extractTextContent(response);
    // 空响应响亮失败——正常收尾但全空的响应没有任何闸(doc-review 第十二次实撞:步 20 推定
    // 领域名 response="" output_tokens=9,单输出收空串 completed 零重试,空 domain_name 灌
    // 下游拼出 DocReviewers//reviewers 残路径。截断闸只认 max_tokens,管不到正常收尾的空)。
    // 提取病族第四形态:前三形态内容完好被判死,本形态内容真缺被放行——对称补闸。
    // 见 design ^anc-exec-output-empty-loud。// @a: anc-exec-output-empty-loud
    if (!text.trim()) {
      const used = response.usage?.output_tokens ?? '?';
      throw new Error(`EMPTY_OUTPUT: 响应文本全空（output_tokens=${used}）——没有产出任何内容,不能当作有效值收下`);
    }
    const outputs: Record<string, unknown> = {};

    if (schema.length === 1) {
      outputs[schema[0].name] = this.unwrapSelfLabeled(text.trim(), schema[0].name);
      return outputs;
    }

    // 多输出：先按 YAML 文档解析（LLM 天然倾向 YAML 风格；块标量 `key: |` 必须取到正文——
    // 旧逐行正则把 '|' 当值，DeepSeek coffee-week 实撞）。见 design「多输出步骤的输出解析」。
    // 围栏剥除认任意语言标签（coffee4 实撞:旧正则只认 yaml|yml,flash 交 ```json 剥不掉——
    // yamlLoad 对围栏行抛错走回退,回退正则又不认带引号键,内容完好三轮全落 null 烧尽;
    // 与 validator parseYamlStructure 同口径 [a-zA-Z]*）。// @a: anc-exec-output-fence-recovery
    const stripped = text.replace(/^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```\s*$/m, '$1');
    try {
      const doc = StepDispatcher.yamlLoadWithRepairImpl(stripped);
      if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
        const obj = doc as Record<string, unknown>;
        if (schema.some(d => d.name in obj)) {
          for (const decl of schema) {
            outputs[decl.name] = decl.name in obj ? obj[decl.name] : null;
          }
          return outputs;
        }
      }
    } catch { /* 非合法 YAML → 先试围栏内容单解,再回退逐行正则 */ }

    // 散文导语+围栏形态的围栏内容单解（doc-review 首跑实撞:围栏剥除是原地去标记,散文残留
    // 炸 yamlLoad → 回退逐行不认嵌套映射键 → 内容完好三连 null 烧尽。围栏=「这块是值」的
    // 声明,散文是评注——取首个围栏块内容单独再试;多块拼合不做跨块猜测照旧回退）。
    // 见 design ^anc-exec-output-fence-content-retry。// @a: anc-exec-output-fence-content-retry
    const fenceOnly = text.match(/```[a-zA-Z]*[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/);
    // 多围栏判据修正（工程链 review 实证:旧判据 fenceOnly[1].includes('```') 在懒惰非锚定
    // 正则下恒假——两个规整围栏块时捕获组只含首块,守卫空转,首块含声明键的多围栏被单解
    // 采纳其余键 null 劣于回退。新判据=剥除首个围栏块后剩余文本仍含围栏开栏标记。
    // // @a: anc-exec-output-fence-content-retry
    const restAfterFirstFence = fenceOnly ? text.slice((fenceOnly.index ?? 0) + fenceOnly[0].length) : '';
    if (fenceOnly && !/```/.test(restAfterFirstFence)) {
      try {
        const doc2 = StepDispatcher.yamlLoadWithRepairImpl(fenceOnly[1]);
        if (doc2 !== null && typeof doc2 === 'object' && !Array.isArray(doc2)) {
          const obj2 = doc2 as Record<string, unknown>;
          if (schema.some(d => d.name in obj2)) {
            for (const decl of schema) {
              outputs[decl.name] = decl.name in obj2 ? obj2[decl.name] : null;
            }
            return outputs;
          }
        }
      } catch { /* 围栏内容也非 YAML → 回退逐行 */ }
    }

    // 散文导语+裸 YAML（无围栏）的尾部键块单解（提取病族第三形态——doc-review 第十次验证
    // 实撞:[thinking] 散文+裸 YAML 键值块,整文 yamlLoad 被散文炸、无围栏跳过单解、回退逐行
    // 不认嵌套映射键→null 归一空列表,9 条对标成果业务面静默空转。契约:找首个顶格声明键行,
    // 从该行截到文末单独再试 yamlLoad——与单输出"尾部自标签收窄"同一形态契约（思考可以写在
    // 前面,产出必须以 YAML 键值收尾）。见 design ^anc-exec-output-tail-yaml-retry。
    // @a: anc-exec-output-tail-yaml-retry
    {
      const tailLines = text.split('\n');
      const keyLineRe = new RegExp(`^(?:${schema.map(d => d.name).join('|')})\\s*:`);
      const tailIdx = tailLines.findIndex(l => keyLineRe.test(l));
      if (tailIdx >= 0) {
        try {
          const doc3 = StepDispatcher.yamlLoadWithRepairImpl(tailLines.slice(tailIdx).join('\n'));
          if (doc3 !== null && typeof doc3 === 'object' && !Array.isArray(doc3)) {
            const obj3 = doc3 as Record<string, unknown>;
            if (schema.some(d => d.name in obj3)) {
              for (const decl of schema) {
                outputs[decl.name] = decl.name in obj3 ? obj3[decl.name] : null;
              }
              return outputs;
            }
          }
        } catch { /* 尾部键块也非 YAML → 回退逐行 */ }
      }
    }

    // 回退逐行正则——值恰为块标量指示符时收块（顶格正文致整文非法 YAML 走到这,'|' 当值
    // =毒值污染下游整链:buildtest 实撞 skill_content='|' → header 全 __UNKNOWN__ 空转。
    // 收到下一个声明键行或文末,剥公共缩进。见 design「多输出步骤的输出解析」回退兜接条款。
    // @a: anc-exec-output-parse-fallback-block
    const lines = text.split('\n');
    const keySet = new Set(schema.map(d => d.name));
    for (const decl of schema) {
      // 键名容忍 JSON 引号形态与行首缩进（coffee4 实撞:thinking 模型 text 被截断成残 JSON,
      // yamlLoad 炸走本回退,而 '"seq_hit": true' 带引号键+缩进,裸 startsWith 不认→null）。
      const keyRe = new RegExp(`^\\s*"?${decl.name}"?\\s*:`);
      const idx = lines.findIndex(l => keyRe.test(l));
      if (idx < 0) { outputs[decl.name] = null; continue; }
      // 值取键匹配段之后（带引号键/缩进下 slice(name.length+1) 会切错——按正则命中长度切）
      const keyMatch = lines[idx].match(keyRe)!;
      const inline = lines[idx].slice(keyMatch[0].length).trim().replace(/^"(.*)",?$/s, '$1');
      if (!/^(\|[+-]?|>[+-]?)$/.test(inline)) {
        outputs[decl.name] = inline || null;
        continue;
      }
      const block: string[] = [];
      for (let i = idx + 1; i < lines.length; i++) {
        const m = lines[i].match(/^(\S+):/);
        if (m && keySet.has(m[1])) break;
        block.push(lines[i]);
      }
      while (block.length && !block[block.length - 1].trim()) block.pop();
      const indents = block.filter(l => l.trim()).map(l => l.match(/^\s*/)![0].length);
      const common = indents.length ? Math.min(...indents) : 0;
      outputs[decl.name] = block.map(l => l.slice(common)).join('\n');
    }

    return outputs;
  }

  // 引号前缀行修复后的 yamlLoad（三处解析点一个修复原语——^anc-exec-output-quoted-prefix-repair:
  // 直载失败→修复命中行→重载;修复无命中原样抛,调用方 catch 走回退）。// @a: anc-exec-output-quoted-prefix-repair
  private static yamlLoadWithRepairImpl(t: string): unknown {
    try { return yamlLoad(t); } catch (e) {
      const repaired = repairQuotedPrefixScalars(t);
      if (repaired === t) throw e;
      return yamlLoad(repaired);
    }
  }

  // 单输出自标注剥壳——LLM 把单输出 echo 成 `\`\`\`yaml + <输出名>: |` 包裹形态（deepseek 系
  // 高频,buildtest 实撞:node_result 带壳进 validate 工具 parse 错）。只认"首行 echo 了输出名"
  // 的无歧义签名,业务围栏/含糊形态原样不碰。见 design ^anc-exec-output-parse-self-labeled。
  // @a: anc-exec-output-parse-self-labeled
  private unwrapSelfLabeled(text: string, name: string): string {
    let t = text;
    const fence = t.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
    // 单一整包围栏才剥——捕获组内再现 ``` 说明是多块拼合（自标注块+散文+第二个围栏收尾),
    // 首尾正则会跨块误捕,把中间散文与围栏标记全收进值（二十五审探针抓）。多块=形态含糊原样。
    if (fence && !fence[1].includes('```')) t = fence[1];
    else {
      // 签名围栏块+散文（三十八审 flash 实撞收窄,三十九审扩导语位）：围栏内首行 echo 了输出名
      // =无歧义签名（"这块是值"的声明）,收该围栏内为值、块外散文（尾巴评注/前导语）弃——
      // 原"围栏须包整文"放弃剥壳,壳连散文逐字节落盘,5.4 反馈准确但 flash 输出习惯治不住,
      // 重试打转到超时。无签名的多块拼合仍原样（二十五审钉:不做跨块猜测）。
      const sigRe = new RegExp('(?:^|\\n)```[\\w-]*\\n(' + name + ':[\\s\\S]*?)\\n```(?:\\n|$)');
      const signed = t.match(sigRe);
      if (signed && !signed[1].includes('```')) t = signed[1];
    }
    const lines = t.split('\n');
    // 尾部自标签收窄（^anc-exec-output-parse-self-labeled 2026-08-31 补——deepseek 思考散文+
    // 尾部 `名: 值` 形态,首行匹配不中走全文即值,思考整段污染变量〔打回轮基准实抓〕。形态契约
    // "产出以 YAML 键值收尾":存在顶格自标签行时从最后一个收起,前导散文弃;不存在照旧全文）。
    const labelRe = new RegExp(`^${name}:\\s*(.*)$`);
    let labelIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (labelRe.test(lines[i])) { labelIdx = i; break; }
    }
    if (labelIdx > 0) {
      const sub = lines.slice(labelIdx);
      const subHead = sub[0].match(labelRe)!;
      if (/^(\|[+-]?|>[+-]?)$/.test(subHead[1].trim())) {
        const rest = sub.slice(1);
        while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
        const indents = rest.filter(l => l.trim()).map(l => l.match(/^\s*/)![0].length);
        const common = indents.length ? Math.min(...indents) : 0;
        return rest.map(l => l.slice(common)).join('\n');
      }
      // 行内值:标签行后无正文(或全空行)才收——标签行后还有非空内容说明形态含糊,交给下方首行逻辑/原样
      if (sub.slice(1).every(l => !l.trim())) return subHead[1].trim();
      // 空值键行+全缩进子结构（第三形态,doc-review 第十四次实撞:`键:` 空值行下挂嵌套列表——
      // 旧收窄只认上两形态,嵌套子结构判含糊原样,散文进值 coerce 必炸灌列表校验判非数组。
      // 收子结构行剥公共缩进,字符串交 coerce yamlLoad 成结构;标签行后出现顶格非空行仍判
      // 含糊原样——顶格=子结构已终结。见 design 单输出收窄三形态条款。
      // @a: anc-exec-output-parse-self-labeled
      if (!subHead[1].trim()) {
        const rest = sub.slice(1);
        while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
        if (rest.length && rest.every(l => !l.trim() || /^\s/.test(l))) {
          const indents = rest.filter(l => l.trim()).map(l => l.match(/^\s*/)![0].length);
          const common = indents.length ? Math.min(...indents) : 0;
          return rest.map(l => l.slice(common)).join('\n');
        }
      }
    }
    const head = lines[0].match(new RegExp(`^${name}:\\s*(.*)$`));
    if (head) {
      const rest = lines.slice(1);
      if (/^(\|[+-]?|>[+-]?)$/.test(head[1].trim())) {
        while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
        const indents = rest.filter(l => l.trim()).map(l => l.match(/^\s*/)![0].length);
        const common = indents.length ? Math.min(...indents) : 0;
        return rest.map(l => l.slice(common)).join('\n');
      }
      if (rest.every(l => !l.trim())) return head[1].trim();
      // 空值键行+全缩进子结构——首行位同罩（与上方尾部位同一第三形态契约）
      // @a: anc-exec-output-parse-self-labeled
      if (!head[1].trim()) {
        const rest2 = lines.slice(1);
        while (rest2.length && !rest2[rest2.length - 1].trim()) rest2.pop();
        if (rest2.length && rest2.every(l => !l.trim() || /^\s/.test(l))) {
          const indents = rest2.filter(l => l.trim()).map(l => l.match(/^\s*/)![0].length);
          const common = indents.length ? Math.min(...indents) : 0;
          return rest2.map(l => l.slice(common)).join('\n');
        }
      }
    }
    return text;   // 无自标注签名/含糊形态 → 原样零变化（围栏可能是业务内容）
  }

  private extractTextContent(response: Anthropic.Message): string {
    return response.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('\n');
  }

  /** 烧穿疑似反刍分流（^anc-exec-thinking-exhausted,hopissues/0060 两批——作者定轻量案
   * "thinking 爆了直接报 thinking 异常,可能是反刍,留档线下分析即可",不做引擎侧自动反刍判定,
   * "是不是反刍"归人判。两形态（二批扩,reopen 主诉）：
   * ①正文全空=thinking 通道烧穿（预算全烧推理块,零可见产出）;
   * ②正文非空但尾窗高重复=in-band 反刍（非思考模式模型把循环写在可见正文——hopkb r21 实录
   *   "让我重新审视"1330 次灌满 65536,首批只判①把它放走照旧教"调大上限",报告方 reopen 实抓）。
   * 重复度判据=零成本纯字符串统计:尾窗 4000 字符按 32 字符切片,统计切片在其前文已出现的
   * 比率,>50% 判反刍（实录形态数量级越阈,阈值保守宁漏勿误伤——长排版正文不误触有反例钉）。
   * 有 tool_use 块=产工具参数被掐非反刍,恒不碰。
   * 命中→返回 THINKING_EXHAUSTED 报文;全文经 HopLog.recordRuminationSuspect 落文档级顶层块
   * （二批修——首批经 recordStepMeta('') 被孤儿守卫拒收,留档静默失效而报文谎称已留档,
   * mock 测试无守卫假绿未抓）。留档每 dispatcher 实例 5 份封顶（父与 parallel 各子实例
   * 各自计——子实例写各自 hoplog,按文件计;超出只记一行计数 warn 不存全文）。 */
  // @a: anc-exec-thinking-exhausted
  private ruminationArchived = 0;
  /** THINKING_EXHAUSTED 记名册（变招重试——检出即记名,该步后续重试轮 thinking 强制 disabled:
   * 反刍绑定该步的输入形态,重试请求与首跑参数同源则同型反复撞〔R4 实撞:同 run 13 次烧满
   * 65535 正文全空〕;sticky 到实例生命周期,check 判官步重跑逐字节同输入尤其必须变招。
   * 见 design ^anc-exec-thinking-exhausted 三批。） */ // @a: anc-exec-thinking-exhausted
  private thinkingExhaustedSteps = new Set<string>();
  private checkThinkingExhausted(response: Anthropic.Message, where: string, stepId?: string): string | null {
    // 有 tool_use 块=模型在产工具参数被掐,不是反刍——照旧 OUTPUT_TRUNCATED
    if (response.content.some(b => b.type === 'tool_use')) return null;
    const text = this.extractTextContent(response);
    const emptyBody = text.trim() === '';
    const inBand = !emptyBody && isHighlyRepetitive(text);
    if (!emptyBody && !inBand) return null;
    const used = response.usage?.output_tokens ?? '?';
    // 留档实况三分支,报文尾句如实跟随（阅卷实抓——首批"报文谎称已留档"病曾在封顶分支残留:
    // 第 6 次起只计数不存全文、hoplog 缺席整段跳过,报文却无条件说"已留档"）
    const hopLog = this.engine.getHopLog();
    let archiveNote: string;
    if (hopLog && this.ruminationArchived < 5) {
      this.ruminationArchived++;
      // 全文=响应全部块的可见序列化(thinking 块 provider 回传则含——留档给线下,不筛不判)
      const full = response.content.map(b => JSON.stringify(b)).join('\n');
      hopLog.recordRuminationSuspect(where, used, `${emptyBody ? '正文空' : '正文高重复(in-band)'},响应全文:\n${full}`);
      archiveNote = '全文已留档 hoplog 供线下分析';
    } else if (hopLog) {
      hopLog.recordWarn('', `疑似反刍第 ${++this.ruminationArchived} 次（${where},output_tokens=${used}）——本实例留档已达 5 份上限,本次只计数不存全文`);
      archiveNote = '本实例留档已达上限,本次未存全文（前 5 份实录在 hoplog）';
    } else {
      archiveNote = '本次运行未开启 hoplog,全文未留档';
    }
    // 变招记名（^anc-exec-thinking-exhausted 三批）:命中且有步号即记名,该步后续重试轮
    // buildApiRequest 强制 thinking disabled——降档保底拿正文;replan 段无步号不记名。
    let retuneNote = '';
    if (stepId) {
      this.thinkingExhaustedSteps.add(stepId);
      retuneNote = ';本步已记名,重试轮将禁用推理通道（thinking disabled）降档保底';
    }
    return emptyBody
      ? `THINKING_EXHAUSTED: 推理通道烧满输出上限且正文为空（output_tokens=${used}）——可能是思维反刍循环（常见诱因:本步判据/约束互相矛盾制造两难）,${archiveNote};调大输出上限对反刍无效只会烧更多${retuneNote}`
      : `THINKING_EXHAUSTED: 输出烧满上限且正文被高度重复的循环文本填满（output_tokens=${used}）——可能是思维反刍循环写进了正文（in-band 形态,常见诱因:本步判据/约束互相矛盾制造两难）,${archiveNote};调大输出上限对反刍无效只会烧更多${retuneNote}`;
  }

  private findStepNode(steps: any[], stepId: string): any {
    for (const s of steps) {
      if (s.step_id === stepId) return s;
      if (s.children) {
        const found = this.findStepNode(s.children, stepId);
        if (found) return found;
      }
    }
    return null;
  }

  private resolveCredential(): { apiKey: string; baseURL?: string } { // @a: anc-exec-model-resolve, anc-exec-standalone-invariants
    // 级 0：base_url+api_key 成对显式提供（StandaloneConfig 解引用注入即此形态）→ 用该配对,
    // 不看环境变量——显式选了后端就用配对凭证,宿主 ANTHROPIC_AUTH_TOKEN 对别家 endpoint 无效
    //（2026-08-10 实撞:CC 宿主 token 被拿去配 DeepSeek endpoint → 401 错配;与模型路由
    // v0.3.0"显式默认>宿主环境"同一原则,凭证侧补齐）。复用模式 buildHostConfig 不设
    // base_url,本级不命中,环境继承主路径照旧。见 design ^anc-exec-model-resolve 加载顺序。
    if (this.hostConfig.base_url && this.hostConfig.api_key && this.hostConfig.api_key.trim()) {
      return { apiKey: this.hostConfig.api_key, baseURL: this.hostConfig.base_url };
    }

    const baseURL = this.hostConfig.base_url || this.envOf('ANTHROPIC_BASE_URL') || undefined;

    const authToken = this.envOf('ANTHROPIC_AUTH_TOKEN');
    if (authToken && authToken.trim()) {
      return { apiKey: authToken, baseURL };
    }

    const envKey = this.envOf('ANTHROPIC_API_KEY')
      ?? this.envOf('HOPJIT_ANTHROPIC_API_KEY');
    if (envKey && envKey.trim()) return { apiKey: envKey, baseURL };

    if (this.hostConfig.api_key && this.hostConfig.api_key.trim()) {
      return { apiKey: this.hostConfig.api_key, baseURL };
    }

    throw new Error('No API key found. Set ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, or provide via HostConfig.');
  }

  // category: 路由类别=步骤类型 ∪ 'replan'（元编程档,2026-08-13 作者定升独立类别——须会 HopSpec 的模型）。
  // 两层配置逐类别继承（作者定形）：spec Config.models[类别] > spec Config.model > 系统 routing_rules[类别] > 系统默认。
  // spec 面三级=软偏好（作者定 2026-08-13"有这个模型就用,否则用缺省"——Constraints 同哲学:
  // spec 是分发面对环境零控制权,service 缺席是环境差异非笔误→warn 后跳过该级沿链向下直到命中,
  // 链尾缺省恒有值必有归宿）。系统面（Priority 4-5）解析时不查在场性——不是不检查,是加载期
  // 已逐条核过"引用必须在 providers 内"不在即拒启动,能活到运行期的引用一定有效,再查是重复劳动。
  resolveModel(category: ExecutableStepType | 'replan', step?: StepReady): { service_id: string; model: string; thinking?: 'enabled' | 'disabled' } { // @a: anc-exec-model-resolve, anc-exec-model-routing, anc-exec-thinking-routing
    if (step) {
      const stepNode = this.findStepInSpec(step.step_id);
      if (stepNode?.model_override && this.preferIfAvailable(stepNode.model_override, `步骤 ${step.step_id} @model`)) {
        return parseModelRef(stepNode.model_override);
      }
    }

    const specConfig = this.engine.getSpec()?.header?.config;
    // spec 层类别映射（act 档含 commit,显式 commit 键可分——执行类共档）
    const models = specConfig?.['models'] as Record<string, unknown> | undefined;
    if (models && typeof models === 'object') {
      const key = category === 'commit' && typeof models['commit'] !== 'string' ? 'act' : category;
      const ref = models[key];
      if (typeof ref === 'string' && this.preferIfAvailable(ref, `Config.models.${key}`)) return parseModelRef(ref);
    }
    if (specConfig?.model && this.preferIfAvailable(specConfig.model as string, 'Config.model')) {
      return parseModelRef(specConfig.model as string);
    }

    const me = this.hostConfig.model_engine;
    if (me?.routing_rules) {
      for (const rule of me.routing_rules) {
        if (rule.match.step_type === category) return { service_id: rule.service_id, model: rule.model, ...(rule.thinking ? { thinking: rule.thinking } : {}) };
      }
      // 系统层同款共档回退：commit 无专条时吃 act 条
      if (category === 'commit') {
        const actRule = me.routing_rules.find(r => r.match.step_type === 'act');
        if (actRule) return { service_id: actRule.service_id, model: actRule.model, ...(actRule.thinking ? { thinking: actRule.thinking } : {}) };
      }
    }

    if (me?.default_model) return { service_id: me.default_service_id ?? 'default', model: me.default_model };
    const envModel = this.envOf('ANTHROPIC_MODEL');
    if (envModel) return { service_id: 'default', model: envModel };
    if (this.hostConfig.model) return { service_id: 'default', model: this.hostConfig.model };
    return { service_id: 'default', model: ENGINE_DEFAULT_MODEL };
  }

  // spec 面软偏好的在场性判定（^anc-exec-model-resolve spec 面条款）：service 在 providers 内
  // （clients 池——standalone 注入面）或环境有 {SERVICE}_API_KEY（getClientForService 第二通道）;
  // 裸模型名/default 恒在场。缺席→HopLog warn 留痕（运营者补配 provider 的信号）,调用方落下一级。
  private preferIfAvailable(ref: string, source: string): boolean {
    let parsed: { service_id: string; model: string };
    try { parsed = parseModelRef(ref); } catch {
      this.warnModelFallback(`模型偏好 '${ref}'（${source}）引用格式非法——忽略,落下一级`);
      return false;   // 引用格式坏=同缺席落级（spec 面不炸——分发面的坏引用也按偏好未满足处理）
    }
    if (parsed.service_id === 'default') return true;   // 裸模型名/显式 default 恒在场（走默认后端）
    if (this.clients.has(parsed.service_id)) return true;
    if (this.envOf(`${parsed.service_id.toUpperCase()}_API_KEY`)) return true;
    this.warnModelFallback(`spec 偏好 ${ref}（${source}）,环境无 service '${parsed.service_id}'——落下一级`);
    return false;
  }

  // 偏好落级 warn 去重（同一 ref 每 run 一次——多步骤重复解析不刷屏）
  private modelFallbackWarned = new Set<string>();
  private warnModelFallback(msg: string): void {
    if (this.modelFallbackWarned.has(msg)) return;
    this.modelFallbackWarned.add(msg);
    this.pendingToolWarns.push(msg);   // 复用装配器 warn 通道——flushToolLog 随步落 HopLog
  }

  private findStepInSpec(stepId: string): StepNode | null {
    const steps = this.engine.getSpec()?.steps;
    if (!steps) return null;
    return this.findStepNode(steps, stepId);
  }

  /** 解析 API 输出 token 上限：env → resource_limits → provider 声明 → 缺省。单点定义（原两处逐字复制）。
   * 环境变量 HOPJIT_MAX_OUTPUT_TOKENS 最高优先；CLAUDE_CODE_MAX_OUTPUT_TOKENS 已摘除不再读取（与下方注释及 envOf 实装一致）。 */
  // 解析链（^anc-exec-output-budget）:HOPJIT env > resource_limits > provider 声明（当次请求
  // 路由的 service,经 {SID}_MAX_OUTPUT_TOKENS 快照键）> 缺省 32768。CLAUDE_CODE_MAX_OUTPUT_TOKENS
  // 已摘除——该 env 语义是 CC 宿主管自己 agent 的输出,引擎捡它=主对话设置泄漏给引擎（作者抓 2026-08-27）。
  private resolveMaxOutputTokens(serviceId?: string): number {
    const envGlobal = this.envOf('HOPJIT_MAX_OUTPUT_TOKENS');
    if (envGlobal !== undefined) return Number(envGlobal);
    if (this.hostConfig.resource_limits?.max_output_tokens !== undefined) return Number(this.hostConfig.resource_limits.max_output_tokens);
    if (serviceId) {
      const perService = this.envOf(`${serviceId.toUpperCase()}_MAX_OUTPUT_TOKENS`);
      if (perService !== undefined) return Number(perService);
    }
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }

  /** client 级非流式超时——SDK 预检只看构造期 _options.timeout,按本 run 输出上限换算给足
   * （max(10min, tokens/128k×60min),与 SDK 估算同式;缺省 16384 恒 10min 零变化）。
   * 见 design ^anc-exec-nonstreaming-timeout。 */ // @a: anc-exec-nonstreaming-timeout
  private nonstreamingTimeoutMs(): number {
    return Math.max(10 * 60_000, Math.ceil((this.resolveMaxOutputTokens() / 128_000) * 60 * 60_000));
  }

  /** replan 失败收尾：attempts+1 写回，达上限则 failStep。error 分支与 catch 分支共用。 */
  private recordReplanFailure(subtaskId: string, attempts: number, maxReplanAttempts: number, reasonText: string): void {
    this.replanAttempts.set(subtaskId, attempts + 1);
    if (attempts + 1 >= maxReplanAttempts) {
      this.engine.failStep(subtaskId, reasonText);
    }
  }

  /** 步骤完成时把工具调用日志写入 HopLog（非空才写）。executeActWithTools / executeActBody 共用。 */
  private flushToolLog(stepId: string, toolCallLog: Array<{ name: string; result: 'success' | 'failure'; at: string; args_preview?: string; result_preview?: string }>): void {
    const hopLog = this.engine.getHopLog();
    if (hopLog && toolCallLog.length > 0) {
      hopLog.recordStepMeta(stepId, { tool: toolCallLog });
    }
    // 装配器横切 warn（裸奔/漂移）随当步落账——declared-or-flagged 契约的留痕半边
    this.flushPendingWarns(stepId);
  }

  private flushPendingWarns(stepId: string): void {
    const hopLog = this.engine.getHopLog();
    if (hopLog) for (const w of this.pendingToolWarns.splice(0)) hopLog.recordWarn(stepId, w);
    else this.pendingToolWarns.length = 0;
  }

  // 实例级上下文水位观测（^anc-exec-ctx-watermark,0095——150K+ 单轮延迟超线性恶化撞超时墙
  // 全程零观测。三项合计=模型真实吃进的上下文:单看 input_tokens 会被缓存命中掩住真实体量。
  // 双档告警各一次,阈值挂 max_context_tokens 既有键零新配置——不配则静默同预检档哲学）。
  // @a: anc-exec-ctx-watermark
  private trackCtxWatermark(resp: Anthropic.Message): void {
    const u = resp.usage as { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    if (total > this.ctxWatermark) this.ctxWatermark = total;
    const ctxLimit = this.hostConfig.resource_limits?.max_context_tokens;
    if (typeof ctxLimit !== 'number' || ctxLimit <= 0) return;
    const kb = Math.round(this.ctxWatermark / 1000);
    if (this.ctxWarnedTier < 2 && this.ctxWatermark > ctxLimit) {
      this.ctxWarnedTier = 2;
      this.pendingToolWarns.push(`实例上下文水位 ${kb}K 已越 max_context_tokens（${Math.round(ctxLimit / 1000)}K）——单轮延迟超线性恶化区,服务端超时风险高（0095 实测曲线）,拆步骤或收敛材料`);
    } else if (this.ctxWarnedTier < 1 && this.ctxWatermark > ctxLimit * 0.75) {
      this.ctxWarnedTier = 1;
      this.pendingToolWarns.push(`实例上下文水位 ${kb}K 已越 max_context_tokens 的 75%（阈值 ${Math.round(ctxLimit / 1000)}K）——长转录延迟将超线性恶化,考虑拆步或收敛材料（0095 实测曲线）`);
    }
  }

  /** 实例峰值上下文水位（run_status/终态透出——观测态,resume 从零重累,峰值账 hoplog 恒可溯）。// @a: anc-exec-ctx-watermark */
  getCtxWatermark(): number { return this.ctxWatermark; }

  // 未知 service fail-fast（design v0.2.1，mcp-server v0.4.0 联动）：非 default 且无凭证的
  // service_id 抛错而非静默回退默认 client——spec 的 service/model 引用拼错曾请求默认后端烧错钱。
  private getClientForService(service_id: string): ProtocolClient {
    if (this.clients.has(service_id)) return this.clients.get(service_id)!;
    const envKey = this.envOf(`${service_id.toUpperCase()}_API_KEY`);
    const envUrl = this.envOf(`${service_id.toUpperCase()}_BASE_URL`);
    if (envKey) {
      // {SERVICE_ID}_PROTOCOL env 决定协议（standalone provider 注入面；缺省 anthropic）// @a: anc-exec-protocol-adapter
      const envProto = this.envOf(`${service_id.toUpperCase()}_PROTOCOL`);
      const timeout = this.nonstreamingTimeoutMs();   // client 级预检解锁,同 defaultClient // @a: anc-exec-nonstreaming-timeout
      // 鉴权头档（^anc-config-standalone-schema auth 字段——bearer=走 SDK authToken 通道发
      // Authorization: Bearer,apiKey 置 null 防双头;缺省 api-key 形态与既有逐字节同）。
      const envAuth = this.envOf(`${service_id.toUpperCase()}_AUTH`);
      const anthropicOpts = envAuth === 'bearer'
        ? { apiKey: null, authToken: envKey, timeout }
        : { apiKey: envKey, authToken: null, timeout };
      const client: ProtocolClient = envProto === 'openai-chat'
        ? makeOpenAiClient({ apiKey: envKey, ...(envUrl ? { baseURL: envUrl } : {}) })
        : wrapAnthropicClient(
            envUrl ? new Anthropic({ ...anthropicOpts, baseURL: envUrl }) : new Anthropic(anthropicOpts),
            Anthropic);
      this.clients.set(service_id, client);
      return client;
    }
    if (service_id !== 'default') {
      throw new Error(`UNKNOWN_SERVICE: service '${service_id}' 无客户端且环境无 ${service_id.toUpperCase()}_API_KEY——检查 service/model 引用拼写（不静默回退默认后端）`);
    }
    return this.defaultClient;
  }

  private hasLackOfInfo(result: Record<string, unknown>): boolean {
    return result.lack_of_info !== undefined && result.lack_of_info !== null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
