// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: step-dispatcher ^anc-struct-step-dispatcher
// OpenAI wire 协议适配器——Anthropic 消息形状是引擎内部 IR，本文件做双向转换；
// LLM 工具循环当下不做（作者定 2026-08-12，观察实际需求 TODO ^todo-openai-tool-loop）。
// 见 design/step-dispatcher.md ^anc-exec-protocol-adapter

import OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';

/** LLM 调用错误类别——dispatcher 重试策略按类别分派，不 instanceof SDK 错误类（双协议归一）。
 * 见 [[step-dispatcher#^anc-exec-protocol-adapter]] */
export type LlmErrorKind = // @a: anc-exec-protocol-adapter
  | 'rate_limited' | 'server_error' | 'timeout' | 'network'
  | 'auth' | 'context_overflow' | 'temperature_rejected' | 'other';

/** ProtocolClient：LLM 调用协议句柄——create 收发内部 IR（Anthropic 消息形状），classifyError 归一错误类别。
 * anthropic 协议直通零转换；openai 协议经本文件适配器。见 [[step-dispatcher#^anc-exec-protocol-adapter]] */
export interface ProtocolClient { // @a: anc-exec-protocol-adapter
  protocol: 'anthropic' | 'openai-chat';   // responses 枚举预留,实装时扩
  create(request: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  classifyError(err: unknown): LlmErrorKind;
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
    messages: client.messages,
    // 非流式长请求超时随 max_tokens 缩放——SDK 按 max_tokens/128k×60min 估算,超 10min 且无显式
    // timeout 即预检拒发"Streaming is required"（buildtest 实撞:预算升 32768 后请求没出网就 fail）。
    // 显式给与 SDK 同式的值即跳过预检;小预算恒 10min 行为不变。见 design
    // ^anc-exec-nonstreaming-timeout。// @a: anc-exec-nonstreaming-timeout
    create: (request) => client.messages.create(request, {
      timeout: Math.max(10 * 60_000, Math.ceil((request.max_tokens / 128_000) * 60 * 60_000)),
    }) as Promise<Anthropic.Message>,
    classifyError(err: unknown): LlmErrorKind {
      if (err instanceof AnthropicCtor.RateLimitError) return 'rate_limited';
      if (err instanceof AnthropicCtor.InternalServerError) return 'server_error';
      if (err instanceof AnthropicCtor.APIConnectionTimeoutError) return 'timeout';
      if (err instanceof AnthropicCtor.APIConnectionError) return 'network';
      if (err instanceof AnthropicCtor.AuthenticationError) return 'auth';
      if (err instanceof AnthropicCtor.APIError && (err as { status?: number }).status === 400
          && /temperature/i.test(String((err as Error).message))) return 'temperature_rejected';
      if (err instanceof AnthropicCtor.BadRequestError
          && isOverflowMessage(String((err as Error).message))) return 'context_overflow';
      if (isBareNetworkMessage(String((err as Error)?.message ?? err))) return 'network';   // 裸网络异常兜底（D61）// @a: anc-exec-api-retry
      return 'other';
    },
  };
}

/** OpenAI 协议适配器：IR 请求 → chat/completions；响应 → IR。工具字段在场即抛
 * PROTOCOL_TOOL_LOOP_UNSUPPORTED（当下边界——上游 executeActWithTools 入口已先拦，此处防御性兜底）。 */
export function makeOpenAiClient(opts: { apiKey: string; baseURL?: string }): ProtocolClient { // @a: anc-exec-protocol-adapter
  // 显式传 key 构造——切断 openai SDK 自读 OPENAI_API_KEY 的隐式通道
  //（standalone 不变量 2"显式压过隐式"，anthropic authToken:null 同型预防）
  const client = new OpenAI({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });

  return {
    protocol: 'openai-chat',
    async create(request: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
      if (request.tools && request.tools.length > 0) {
        throw new Error('PROTOCOL_TOOL_LOOP_UNSUPPORTED: openai-chat 协议当下不支持 LLM 工具循环——给 act 写 hop_python body（工具走引擎白名单通道），或该步 @model 路由到 anthropic 协议 provider');
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
      });
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
    classifyError(err: unknown): LlmErrorKind {
      if (err instanceof OpenAI.RateLimitError) return 'rate_limited';
      if (err instanceof OpenAI.InternalServerError) return 'server_error';
      if (err instanceof OpenAI.APIConnectionTimeoutError) return 'timeout';
      if (err instanceof OpenAI.APIConnectionError) return 'network';
      if (err instanceof OpenAI.AuthenticationError) return 'auth';
      if (err instanceof OpenAI.BadRequestError) {
        const msg = String((err as Error).message);
        if (/temperature/i.test(msg)) return 'temperature_rejected';
        if (isOverflowMessage(msg)) return 'context_overflow';
      }
      if (isBareNetworkMessage(String((err as Error)?.message ?? err))) return 'network';   // 裸网络异常兜底（D61）// @a: anc-exec-api-retry
      return 'other';
    },
  };
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
