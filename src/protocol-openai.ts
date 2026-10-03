// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: step-dispatcher ^anc-struct-step-dispatcher
// OpenAI wire 协议适配器——Anthropic 消息形状是引擎内部 IR，本文件做双向转换。
// 两适配器：openai-chat（chat/completions,无工具循环——0025 兜底定位）与
// openai-responses（/v1/responses,工具循环原生映射——OpenAI 官方生态正路,0020 批 2026-09-20）。
// 见 design/step-dispatcher.md ^anc-exec-protocol-adapter

import OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent } from 'undici';

/** 非流式请求的等待上限（毫秒）——按输出上限换算:max(10min, ceil(maxTokens/128000×60min)),与 SDK
 * 预检估算同式。全库唯一一处公式:client 级上限（按 service 解析的输出上限）与单次请求上限
 * （request.max_tokens）都从这里算,客户端等待超时的判定与报错文案也用它。
 * 见 [[step-dispatcher#^anc-exec-nonstreaming-timeout]] */
export function nonstreamingWaitMs(maxTokens: number): number { // @a: anc-exec-nonstreaming-timeout
  // 取不到数（缺席/非数）按 0 算,落 10 分钟下限——不让 NaN 进 SDK timeout 与超时判定
  const tokens = Number.isFinite(maxTokens) ? maxTokens : 0;
  return Math.max(10 * 60_000, Math.ceil((tokens / 128_000) * 60 * 60_000));
}

/** 长等待连接设置——node 内建 fetch（undici）对"等响应头"和"两次收到数据的间隔"各有缺省 300 秒
 * 时限,非流式请求要等整段生成完才回响应头,超过 300 秒的一律被掐断,给 SDK 的长 timeout 轮不到生效
 * （todo/0117）。这里建一个 undici Agent,两个时限都取引擎的 client 级等待上限,经 SDK 构造选项
 * fetchOptions 传入。extra 只给测试注入假连接（connect）用;同名时限键被 waitMs 盖掉。
 * 见 [[step-dispatcher#^anc-exec-nonstreaming-timeout]] "连接设置"段 */
export function longWaitFetchOptions(waitMs: number, extra: Agent.Options = {}): { dispatcher: Agent } { // @a: anc-exec-nonstreaming-timeout
  return { dispatcher: new Agent({ ...extra, headersTimeout: waitMs, bodyTimeout: waitMs }) };
}

// undici 等待超时错误码——等响应头超时 / 等数据超时。数据中途停满 bodyTimeout 时 SDK 抛的是裸
// TypeError('terminated'),cause 才是 BodyTimeoutError;按 D61 文案兜底会被当网络断流。所以先顺着
// cause 链认错误码归 timeout（最多看 5 层防环）,再走文案兜底。
// 见 [[step-dispatcher#^anc-exec-api-retry]] D61 条 v0.36.0 补充 // @a: anc-exec-api-retry
const UNDICI_WAIT_TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
// 端点不可达判据——错误本体或 cause 链带 ECONNREFUSED（端口无进程监听）/ ENOTFOUND（主机名解析
// 不到）:两者都是确定性死端点（配置指向错了/服务没起）,不是"等一等就好"的瞬时网络故障。
// 与 isUndiciWaitTimeout 同法看 5 层 cause。见 [[step-dispatcher#^anc-exec-network-pause]] 末条
//（hopissues/0106）。// @a: anc-exec-network-pause
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EPERM']);
/** 判一个 LLM 调用错误是否"端点不可达"（连接被拒/主机名解析不到/系统策略拒绝连接）——两 classifyError 先于 network
 * 兜底调用;dispatcher 据此首次即抛 ENDPOINT_UNREACHABLE 不进网络暂停门。导出供测试直钉判据。 */
export function isEndpointUnreachable(err: unknown): boolean { // @a: anc-exec-network-pause
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur != null && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return true;
    // undici 聚合错（AggregateError.errors[]——双栈地址各拒一次）
    const errs = (cur as { errors?: unknown }).errors;
    if (Array.isArray(errs) && errs.some(e => typeof (e as { code?: unknown })?.code === 'string' && UNREACHABLE_CODES.has((e as { code: string }).code))) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function isUndiciWaitTimeout(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur != null && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && UNDICI_WAIT_TIMEOUT_CODES.has(code)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** LLM 调用错误类别——dispatcher 重试策略按类别分派，不 instanceof SDK 错误类（双协议归一）。
 * 见 [[step-dispatcher#^anc-exec-protocol-adapter]] */
export type LlmErrorKind = // @a: anc-exec-protocol-adapter
  | 'rate_limited' | 'server_error' | 'timeout' | 'network' | 'unreachable'
  | 'auth' | 'context_overflow' | 'temperature_rejected' | 'other';

/** ProtocolClient：LLM 调用协议句柄——create 收发内部 IR（Anthropic 消息形状），classifyError 归一错误类别。
 * anthropic 协议直通零转换；openai 协议经本文件适配器。见 [[step-dispatcher#^anc-exec-protocol-adapter]] */
export interface ProtocolClient { // @a: anc-exec-protocol-adapter
  protocol: 'anthropic' | 'openai-chat' | 'openai-responses';
  // 该协议能否承载 LLM 工具循环——dispatcher 工具循环闸与 reason 降级道判它,不比对
  // 协议枚举名（能力谓词:新协议接入改一处,枚举比对散点会漏。0020 批立）。
  supportsToolLoop: boolean;
  create(request: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  classifyError(err: unknown): LlmErrorKind;
  // 端点身份（service_id+base_url）——端点不可达 fail-fast 报文用（hopissues/0106,
  // ^anc-exec-network-pause 末条:"配了哪个后端、指向哪、为什么连不上"三样让用户一眼定位）。
  // dispatcher 构造后盖章;缺省 provider 的 service_id 记 'default'。// @a: anc-exec-network-pause
  endpoint?: { service_id: string; base_url?: string };
  // anthropic 直通包装保留底层 messages 引用（测试经 defaultClient.messages.create 抓 mock——
  // 全量既有测试零改动即"IR 不变"的守卫物证）；openai 侧无此字段。
  messages?: Anthropic['messages'];
}

// context overflow 的 BadRequest 文案判据——收紧到上下文超长的实际文案（与 dispatcher
// isContextOverflow 同判据：裸命中 token/context 子串会把 'invalid token' 鉴权错误误判为
// 溢出、触发降级重组,既有实撞收紧不得回退）。
// 裸网络异常文案判据（D61,2026-08-24 dr14 实抓——SDK 错误类只包装"请求发起阶段"的失败,
// 流读取中途断的 undici 裸 TypeError〔terminated〕不经包装穿透 instanceof 链落 other 档:
// 0 重试+裸文案进 FailRecord,D58 前缀被绕过。词/错误码形态精确匹配,不裸含子串防误伤。
// // @a: anc-exec-api-retry
function isBareNetworkMessage(raw: string): boolean {
  const msg = raw.toLowerCase();
  if (/\b(terminated|fetch failed|socket hang up)\b/.test(msg)) return true;
  return /\b(econnreset|econnrefused|etimedout|epipe|enetunreach|eai_again)\b/.test(msg);
}

function isOverflowMessage(raw: string): boolean {
  const msg = raw.toLowerCase();
  return msg.includes('prompt is too long')
    || msg.includes('context_length')
    || msg.includes('context length exceeded')
    || msg.includes('maximum context')
    || msg.includes('too many tokens')
    || (msg.includes('too long') && msg.includes('token'));
}

/** Anthropic 客户端包一层 ProtocolClient（直通——IR 即其原生形状）。错误分类沿用既有 instanceof 判定。 */
export function wrapAnthropicClient(client: Anthropic, AnthropicCtor: typeof Anthropic): ProtocolClient { // @a: anc-exec-protocol-adapter
  return {
    protocol: 'anthropic',
    supportsToolLoop: true,
    messages: client.messages,
    // 非流式长请求超时随 max_tokens 缩放——SDK 按 max_tokens/128k×60min 估算,超 10min 且无显式
    // timeout 即预检拒发"Streaming is required"（buildtest 实撞:预算升 32768 后请求没出网就 fail）。
    // 显式给与 SDK 同式的值即跳过预检;小预算恒 10min 行为不变。见 design
    // ^anc-exec-nonstreaming-timeout。// @a: anc-exec-nonstreaming-timeout
    create: (request) => client.messages.create(request, {
      timeout: nonstreamingWaitMs(request.max_tokens),
    }) as Promise<Anthropic.Message>,
    classifyError(err: unknown): LlmErrorKind {
      if (err instanceof AnthropicCtor.RateLimitError) return 'rate_limited';
      if (err instanceof AnthropicCtor.InternalServerError) return 'server_error';
      if (err instanceof AnthropicCtor.APIConnectionTimeoutError) return 'timeout';
      if (isEndpointUnreachable(err)) return 'unreachable';   // 先于 network 兜底——确定性死端点不入暂停门（0106）// @a: anc-exec-network-pause
      if (err instanceof AnthropicCtor.APIConnectionError) return 'network';
      if (err instanceof AnthropicCtor.AuthenticationError) return 'auth';
      if (isUndiciWaitTimeout(err)) return 'timeout';   // 先于文案兜底（bodyTimeout 形态是裸 terminated）// @a: anc-exec-api-retry
      if (err instanceof AnthropicCtor.APIError && (err as { status?: number }).status === 400
          && /temperature/i.test(String((err as Error).message))) return 'temperature_rejected';
      if (err instanceof AnthropicCtor.BadRequestError
          && isOverflowMessage(String((err as Error).message))) return 'context_overflow';
      if (isBareNetworkMessage(String((err as Error)?.message ?? err))) return 'network';   // 裸网络异常兜底（D61）// @a: anc-exec-api-retry
      return 'other';
    },
  };
}

/** openai 两个构造函数的入参。waitMs=client 级等待上限（毫秒,dispatcher 传 nonstreamingTimeoutMs(serviceId)）,
 * 缺省按最小 10 分钟;fetchExtra 只给测试注入假连接。 */
export interface OpenAiClientOpts { apiKey: string; baseURL?: string; waitMs?: number; fetchExtra?: Agent.Options }

// openai SDK 构造选项:显式 key + 等待上限 + 长等待连接设置 + 关掉 SDK 内部重试（重试全部归引擎
// callLlmWithRetry——SDK 缺省重试 2 次会叠在引擎次数上,等满上限的请求也会被 SDK 自己再等两轮）。
// 见 [[step-dispatcher#^anc-exec-nonstreaming-timeout]] 与 ^anc-exec-api-retry "SDK 内部重试关掉"条
// @a: anc-exec-nonstreaming-timeout
function openAiCtorOpts(opts: OpenAiClientOpts): ConstructorParameters<typeof OpenAI>[0] {
  const waitMs = opts.waitMs ?? 10 * 60_000;
  return {
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    timeout: waitMs,
    maxRetries: 0,
    fetchOptions: longWaitFetchOptions(waitMs, opts.fetchExtra) as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetchOptions'],
  };
}

/** OpenAI 协议适配器：IR 请求 → chat/completions；响应 → IR。工具字段在场即抛
 * PROTOCOL_TOOL_LOOP_UNSUPPORTED（当下边界——上游 executeActWithTools 入口已先拦，此处防御性兜底）。 */
export function makeOpenAiClient(opts: OpenAiClientOpts): ProtocolClient { // @a: anc-exec-protocol-adapter
  // 显式传 key 构造——切断 openai SDK 自读 OPENAI_API_KEY 的隐式通道
  //（standalone 不变量 2"显式压过隐式"，anthropic authToken:null 同型预防）
  const client = new OpenAI(openAiCtorOpts(opts));

  return {
    protocol: 'openai-chat',
    supportsToolLoop: false,
    async create(request: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
      if (request.tools && request.tools.length > 0) {
        throw new Error('PROTOCOL_TOOL_LOOP_UNSUPPORTED: openai-chat 协议不支持 LLM 工具循环——给 act 写 hop_python body（工具走引擎白名单通道），或该步 @model 路由到 anthropic 协议 provider，或端点有 /v1/responses 面时 provider 改配 protocol: openai-responses');
      }
      // IR → chat/completions：system 顶层字段转首条 system 消息；文本消息直映。
      // system 块数组形态拍平并剥除 cache_control（OpenAI 自动前缀缓存,显式断点无对应物——
      // 分区重排已让它受益,见 ^anc-exec-cache-control）。// @a: anc-exec-cache-control
      const messages: OpenAI.ChatCompletionMessageParam[] = [];
      if (request.system) {
        const sysText = typeof request.system === 'string'
          ? request.system
          : request.system.map(b => b.text).join('\n\n---\n\n');
        messages.push({ role: 'system', content: sysText });
      }
      for (const m of request.messages) {
        messages.push({ role: m.role, content: irContentToText(m.content) });
      }
      const resp = await client.chat.completions.create({
        model: request.model,
        messages,
        max_tokens: request.max_tokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      }, { timeout: nonstreamingWaitMs(request.max_tokens) });   // 单次请求等待上限 // @a: anc-exec-nonstreaming-timeout
      // chat/completions → IR
      const text = resp.choices[0]?.message?.content ?? '';
      return {
        id: resp.id,
        type: 'message',
        role: 'assistant',
        model: resp.model,
        content: [{ type: 'text', text, citations: null }],
        stop_reason: resp.choices[0]?.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: resp.usage?.prompt_tokens ?? 0,
          output_tokens: resp.usage?.completion_tokens ?? 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          cache_creation: null,
          server_tool_use: null,
          service_tier: null,
        },
      } as Anthropic.Message;
    },
    // chat 与 responses 共用同一判据函数（同 SDK 同错误类,单一判据源）
    classifyError: classifyOpenAiError,
  };
}

/** OpenAI Responses 协议适配器：IR 请求 → /v1/responses；响应 → IR。工具循环原生映射——
 * IR tool_use/tool_result 块与 Responses function_call/function_call_output typed items
 * 一一对应（0020 批 2026-09-20,OpenAI 官方生态工具循环正路）。经 SDK client.responses.create
 * 调用,只写双向转换不写传输层。见 design ^anc-exec-protocol-adapter openai-responses 转换规则。 */
export function makeOpenAiResponsesClient(opts: OpenAiClientOpts): ProtocolClient { // @a: anc-exec-protocol-adapter
  // 显式传 key 构造——切断 openai SDK 自读 OPENAI_API_KEY 的隐式通道（同 chat 适配器）;
  // 等待上限、连接设置、关 SDK 重试同 chat 适配器（openAiCtorOpts）
  const client = new OpenAI(openAiCtorOpts(opts));
  // reasoning 参数被拒记名——OpenAI 官方对非推理模型发 reasoning/include 参数 400 拒;记名后该
  // client 免传（与 dispatcher temperature 剥除重试同模式;reasoning 是本协议私有参数,生命周期
  // 归适配器闭包,不进 dispatcher 重试表）。
  let reasoningRejected = false;
  // 工具轮回显缓存（阅卷抓高危后补——OpenAI 官方推理模型 store:false 工具循环要求 function_call
  // 随其前导 reasoning items〔含 encrypted_content〕一起回显,缺席即二轮 400。响应侧按 call_id
  // 缓存 {function_call item id, 前导 reasoning items 原样};请求侧转 tool_use 命中即回显。
  // reasoning 仍不进 IR,引擎零感知;缓存丢失〔跨进程恢复〕未命中照旧只发 call_id——宽松端点照走,
  // 严格端点该轮拒走重试链。封顶 128 键 FIFO 防长循环无界增长。真机实证面=DeepSeek（宽松端点）;
  // OpenAI 官方推理端点无凭证未实证,机制按官方文档形态实装——边界申报见设计条款。
  const toolTurnCache = new Map<string, { fcItemId?: string; reasoningItems: unknown[] }>();

  return {
    protocol: 'openai-responses',
    supportsToolLoop: true,
    async create(request: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
      // IR → Responses：system 顶层字段 → instructions（块数组拍平剥 cache_control,与 chat 侧同型转换）
      const instructions = request.system === undefined ? undefined
        : typeof request.system === 'string'
          ? request.system
          : request.system.map(b => b.text).join('\n\n---\n\n');
      // IR messages → input typed items：text 块聚成 message item;tool_use → function_call;
      // tool_result → function_call_output（IR 工具往返与 Responses typed items 一一对应）
      const input: OpenAI.Responses.ResponseInput = [];
      for (const m of request.messages) {
        if (typeof m.content === 'string') {
          input.push({ role: m.role, content: m.content });
          continue;
        }
        // text 缓冲遇非 text 块先 flush——保持块间原序（阅卷抓:聚合尾部 push 会把同轮
        // assistant 文本排到 function_call 之后,与原消息顺序颠倒）
        let texts: string[] = [];
        const flushTexts = () => {
          if (texts.length > 0) { input.push({ role: m.role, content: texts.join('\n') }); texts = []; }
        };
        for (const b of m.content) {
          if (b.type === 'text' && typeof (b as { text?: string }).text === 'string') {
            texts.push((b as { text: string }).text);
          } else if (b.type === 'tool_use') {
            flushTexts();
            const tu = b as Anthropic.ToolUseBlockParam;
            // 工具轮回显：命中缓存先按序回显前导 reasoning items 原样,function_call 带原 item id
            const cached = toolTurnCache.get(tu.id);
            if (cached) {
              for (const ri of cached.reasoningItems) input.push(ri as OpenAI.Responses.ResponseInputItem);
              input.push({ type: 'function_call', call_id: tu.id, name: tu.name, arguments: JSON.stringify(tu.input ?? {}), ...(cached.fcItemId ? { id: cached.fcItemId } : {}) });
            } else {
              input.push({ type: 'function_call', call_id: tu.id, name: tu.name, arguments: JSON.stringify(tu.input ?? {}) });
            }
          } else if (b.type === 'tool_result') {
            flushTexts();
            const tr = b as Anthropic.ToolResultBlockParam;
            const out = typeof tr.content === 'string'
              ? tr.content
              : (tr.content ?? []).map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
            // is_error 无独立通道——dispatcher 组 tool_result 时已把失败渲染为 "Error: ..." 前缀
            // 文本,output 原样携带即错误可见
            input.push({ type: 'function_call_output', call_id: tr.tool_use_id, output: out });
          }
          // 其余块类型（thinking 等）防御性忽略,与 chat 侧 irContentToText 同口径
        }
        flushTexts();
      }
      // IR tools（Anthropic 形）→ Responses 工具形:顶层平铺,不包 chat 的 function 壳
      //（DeepSeek /v1/responses 真机四拍探针实证 2026-09-20）。strict:false=不启用 OpenAI 结构化
      // 输出严格模式（引擎工具 schema 非全字段 required,strict:true 会拒）。
      const tools: OpenAI.Responses.FunctionTool[] | undefined = request.tools?.length
        ? (request.tools as Anthropic.Tool[]).map(t => ({
            type: 'function' as const,
            name: t.name,
            description: t.description ?? null,
            parameters: t.input_schema as unknown as Record<string, unknown>,
            strict: false,
          }))
        : undefined;
      // IR thinking → reasoning.effort 两点映射（作者拍 2026-09-20:disabled→low〔普遍可用最低档,
      // minimal/none 部分模型不认〕/enabled→high〔enabled 语义即重投入档,medium=端点缺省映了白映〕;
      // budget_tokens 丢弃不换算——只翻译开关不发明"预算数→档位"规则;IR 无 thinking 键不发吃端点缺省）
      const irThinking = (request as { thinking?: { type: string } }).thinking;
      const reasoningParam = (!reasoningRejected && irThinking)
        ? { reasoning: { effort: (irThinking.type === 'enabled' ? 'high' : 'low') as 'high' | 'low' } }
        : {};
      // store:false 下取加密思考链的官方通道——带工具且 reasoning 未被拒时随发
      const includeParam = (!reasoningRejected && tools)
        ? { include: ['reasoning.encrypted_content' as const] }
        : {};
      const buildParams = () => ({
        model: request.model,
        input,
        ...(instructions !== undefined ? { instructions } : {}),
        max_output_tokens: request.max_tokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(tools ? { tools } : {}),
        ...(reasoningRejected ? {} : reasoningParam),
        ...(reasoningRejected ? {} : includeParam),
        // 无状态最小公共面：恒显式 store:false（OpenAI 官方缺省 true 会留服务端存档——显式压过
        // 隐式;DeepSeek 本就无状态照发无害）,不发 previous_response_id,全量 input 重发
        store: false,
      });
      let resp: OpenAI.Responses.Response;
      const reqOpts = { timeout: nonstreamingWaitMs(request.max_tokens) };
      try {
        resp = await client.responses.create(buildParams(), reqOpts);   // 单次请求等待上限 // @a: anc-exec-nonstreaming-timeout
      } catch (err) {
        // reasoning/include 被拒剥除重试（非推理模型 400 拒这两参——剥除记名当场重发一次,
        // 与 dispatcher temperature 剥除同模式;其余错误原样穿透归 classifyError 重试链）
        const msg = String((err as Error)?.message ?? '');
        if (!reasoningRejected && err instanceof OpenAI.BadRequestError && /reasoning|include/i.test(msg)) {
          reasoningRejected = true;
          resp = await client.responses.create(buildParams(), reqOpts);
        } else {
          throw err;
        }
      }
      // Responses output typed items → IR content 块
      const content: Anthropic.ContentBlock[] = [];
      let pendingReasoning: unknown[] = [];   // function_call 的前导 reasoning items（回显缓存原料）
      for (const item of resp.output ?? []) {
        if (item.type === 'message') {
          pendingReasoning = [];
          for (const c of item.content) {
            if (c.type === 'output_text') content.push({ type: 'text', text: c.text, citations: null });
          }
        } else if (item.type === 'reasoning') {
          // reasoning 不进 IR（引擎不消费思考正文）,但原样暂存——下一个 function_call 的回显前导
          pendingReasoning.push(item);
        } else if (item.type === 'function_call') {
          let parsed: unknown;
          try {
            parsed = item.arguments ? JSON.parse(item.arguments) : {};
          } catch {
            // arguments 坏 JSON 不静默吞——响亮抛出走 classifyError→other 档重试
            throw new Error(`RESPONSES_BAD_FUNCTION_ARGS: function_call '${item.name}' arguments 非合法 JSON: ${String(item.arguments).slice(0, 200)}`);
          }
          // 入工具轮回显缓存（FIFO 封顶 128 键）
          if (toolTurnCache.size >= 128) {
            const oldest = toolTurnCache.keys().next().value;
            if (oldest !== undefined) toolTurnCache.delete(oldest);
          }
          toolTurnCache.set(item.call_id, { fcItemId: item.id, reasoningItems: pendingReasoning });
          pendingReasoning = [];
          content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: parsed } as Anthropic.ToolUseBlock);
        }
      }
      const hasToolCall = content.some(b => b.type === 'tool_use');
      return {
        id: resp.id,
        type: 'message',
        role: 'assistant',
        model: resp.model,
        content,
        stop_reason: resp.status === 'incomplete' && resp.incomplete_details?.reason === 'max_output_tokens'
          ? 'max_tokens'
          : hasToolCall ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
          // Responses usage 顶层同名直取（input_tokens/output_tokens 与 IR 零转名）;
          // cached_tokens 是 Responses 比 chat 多给的缓存事实,如实入账
          input_tokens: resp.usage?.input_tokens ?? 0,
          output_tokens: resp.usage?.output_tokens ?? 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: resp.usage?.input_tokens_details?.cached_tokens ?? null,
          cache_creation: null,
          server_tool_use: null,
          service_tier: null,
        },
      } as Anthropic.Message;
    },
    // 与 chat 适配器同 SDK 同错误类同文案判据,零分叉
    classifyError: classifyOpenAiError,
  };
}

// openai SDK 错误 → 类别枚举（chat 与 responses 两适配器共用——同 SDK 同错误类,单一判据源）
function classifyOpenAiError(err: unknown): LlmErrorKind { // @a: anc-exec-protocol-adapter
  if (err instanceof OpenAI.RateLimitError) return 'rate_limited';
  if (err instanceof OpenAI.InternalServerError) return 'server_error';
  if (err instanceof OpenAI.APIConnectionTimeoutError) return 'timeout';
  if (isEndpointUnreachable(err)) return 'unreachable';   // 先于 network 兜底（0106）// @a: anc-exec-network-pause
  if (err instanceof OpenAI.APIConnectionError) return 'network';
  if (err instanceof OpenAI.AuthenticationError) return 'auth';
  if (isUndiciWaitTimeout(err)) return 'timeout';   // 先于文案兜底（bodyTimeout 形态是裸 terminated）// @a: anc-exec-api-retry
  if (err instanceof OpenAI.BadRequestError) {
    const msg = String((err as Error).message);
    if (/temperature/i.test(msg)) return 'temperature_rejected';
    if (isOverflowMessage(msg)) return 'context_overflow';
  }
  if (isBareNetworkMessage(String((err as Error)?.message ?? err))) return 'network';   // 裸网络异常兜底（D61）// @a: anc-exec-api-retry
  return 'other';
}

// IR content（string 或 block 数组）拍平为纯文本——openai 侧无 block 概念。
// tool_use/tool_result block 不可达（工具请求已在 create 入口拦截），防御性忽略非 text block。
function irContentToText(content: string | Anthropic.ContentBlockParam[] | Anthropic.ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return (content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n');
}
