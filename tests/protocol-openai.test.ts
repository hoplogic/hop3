// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: step-dispatcher ^anc-struct-step-dispatcher
// OpenAI 协议适配器判据回归——IR 双向映射/错误分类/工具循环 fail-fast。
// 见 design/step-dispatcher.md ^anc-exec-protocol-adapter
import { describe, it, expect, vi } from 'vitest';

const createMock = vi.fn();
const responsesCreateMock = vi.fn();
vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: createMock } },
    responses: { create: responsesCreateMock },
  }));
  for (const k of ['RateLimitError', 'InternalServerError', 'APIConnectionTimeoutError', 'APIConnectionError', 'AuthenticationError', 'BadRequestError', 'APIError']) {
    (MockOpenAI as unknown as Record<string, unknown>)[k] = class extends Error { };
  }
  return { default: MockOpenAI };
});

import OpenAI from 'openai';
import { makeOpenAiClient, makeOpenAiResponsesClient, wrapAnthropicClient } from '../src/protocol-openai.js';

const OPENAI_RESP = {
  id: 'chatcmpl-1',
  model: 'qwen-max',
  choices: [{ message: { role: 'assistant', content: 'result: 42' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

// @v: anc-exec-protocol-adapter
describe('OpenAI 协议适配器（IR 双向映射）', () => {
  it('正例：IR 请求 system 顶层字段转首条 system 消息，文本消息直映', async () => {
    createMock.mockResolvedValueOnce(OPENAI_RESP);
    const c = makeOpenAiClient({ apiKey: 'k', baseURL: 'https://example.com/v1' });
    await c.create({
      model: 'qwen-max',
      system: '你是执行者',
      messages: [{ role: 'user', content: '[当前任务]算数' }],
      max_tokens: 4096,
      temperature: 0,
    });
    const sent = createMock.mock.calls[0][0];
    expect(sent.messages[0]).toEqual({ role: 'system', content: '你是执行者' });
    expect(sent.messages[1]).toEqual({ role: 'user', content: '[当前任务]算数' });
    expect(sent.model).toBe('qwen-max');
    expect(sent.max_tokens).toBe(4096);
    expect(sent.temperature).toBe(0);
  });

  it('正例：响应映射回 IR——content 文本块 + usage 字段名转换（prompt/completion → input/output）', async () => {
    createMock.mockResolvedValueOnce(OPENAI_RESP);
    const c = makeOpenAiClient({ apiKey: 'k' });
    const resp = await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 });
    expect(resp.content).toEqual([{ type: 'text', text: 'result: 42', citations: null }]);
    expect(resp.usage.input_tokens).toBe(10);
    expect(resp.usage.output_tokens).toBe(5);
    expect(resp.stop_reason).toBe('end_turn');
  });

  it('正例：IR block 数组 content 拍平为纯文本（多 text block 换行拼接）', async () => {
    createMock.mockResolvedValueOnce(OPENAI_RESP);
    const c = makeOpenAiClient({ apiKey: 'k' });
    await c.create({
      model: 'm', max_tokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] }],
    });
    expect(createMock.mock.calls[createMock.mock.calls.length - 1][0].messages[0].content).toBe('第一段\n第二段');
  });

  it('反例：finish_reason=length → stop_reason 映射 max_tokens（截断可感知）', async () => {
    createMock.mockResolvedValueOnce({ ...OPENAI_RESP, choices: [{ message: { content: '半截' }, finish_reason: 'length' }] });
    const c = makeOpenAiClient({ apiKey: 'k' });
    const resp = await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10 });
    expect(resp.stop_reason).toBe('max_tokens');
  });

  it('反例：请求带 tools → PROTOCOL_TOOL_LOOP_UNSUPPORTED（当下边界防御性兜底，报文指路）', async () => {
    const c = makeOpenAiClient({ apiKey: 'k' });
    await expect(c.create({
      model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 't', description: '', input_schema: { type: 'object' as const } }],
    })).rejects.toThrow(/PROTOCOL_TOOL_LOOP_UNSUPPORTED.*hop_python body.*anthropic/s);
    expect(createMock).not.toHaveBeenCalledWith(expect.objectContaining({ tools: expect.anything() }));
  });

  it('正例：temperature 未定义时不传字段（兼容拒收 temperature 的端点剥除路径）', async () => {
    createMock.mockResolvedValueOnce(OPENAI_RESP);
    const c = makeOpenAiClient({ apiKey: 'k' });
    await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 });
    expect('temperature' in createMock.mock.calls[createMock.mock.calls.length - 1][0]).toBe(false);
  });
});

// @v: anc-exec-protocol-adapter
describe('OpenAI 错误分类（类别归一）', () => {
  const c = makeOpenAiClient({ apiKey: 'k' });

  it('正例：SDK 错误类逐一映射类别（重试策略与 anthropic 路径同表）', () => {
    expect(c.classifyError(new (OpenAI as any).RateLimitError('429'))).toBe('rate_limited');
    expect(c.classifyError(new (OpenAI as any).InternalServerError('500'))).toBe('server_error');
    expect(c.classifyError(new (OpenAI as any).APIConnectionTimeoutError('t'))).toBe('timeout');
    expect(c.classifyError(new (OpenAI as any).APIConnectionError('n'))).toBe('network');
    expect(c.classifyError(new (OpenAI as any).AuthenticationError('401'))).toBe('auth');
  });

  it('正例：BadRequest 溢出文案 → context_overflow；temperature 文案 → temperature_rejected', () => {
    expect(c.classifyError(new (OpenAI as any).BadRequestError("This model's maximum context length is 8192 tokens"))).toBe('context_overflow');
    expect(c.classifyError(new (OpenAI as any).BadRequestError('temperature is not supported'))).toBe('temperature_rejected');
  });

  it('反例：BadRequest 裸含 token 子串（invalid token 鉴权类文案）→ 不误判溢出（收紧判据不回退）', () => {
    expect(c.classifyError(new (OpenAI as any).BadRequestError('invalid token provided'))).toBe('other');
  });

  it('反例：未知错误 → other（零重试，不冒充可重试类别）', () => {
    expect(c.classifyError(new Error('boom'))).toBe('other');
  });
});

// @v: anc-exec-protocol-adapter
describe('Anthropic 直通包装（IR 即原生形状）', () => {
  it('正例：create 直通 messages.create，请求对象原样传递（零转换）', async () => {
    const inner = { messages: { create: vi.fn().mockResolvedValue({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }) } };
    const FakeCtor = Object.assign(function () { /* ctor */ }, {
      RateLimitError: class extends Error { }, InternalServerError: class extends Error { },
      APIConnectionTimeoutError: class extends Error { }, APIConnectionError: class extends Error { },
      AuthenticationError: class extends Error { }, BadRequestError: class extends Error { },
      APIError: class extends Error { status?: number },
    });
    const c = wrapAnthropicClient(inner as never, FakeCtor as never);
    const req = { model: 'm', messages: [], max_tokens: 1 } as never;
    await c.create(req);
    // 请求对象原样第一参;第二参=超时选项（^anc-exec-nonstreaming-timeout,小预算恒 10min）
    expect(inner.messages.create).toHaveBeenCalledWith(req, { timeout: 10 * 60_000 });
    expect(c.messages).toBe(inner.messages);   // 底层引用透传（测试抓 mock 的通道）
  });

  // 非流式长请求超时随 max_tokens 缩放（buildtest 实撞:32768 预算 SDK 预检拒发
  // "Streaming is required"——显式给与 SDK 同式的 timeout 跳过预检）。
  // @v: anc-exec-nonstreaming-timeout
  it('正例：大 max_tokens 按 SDK 同式放宽 timeout（32768→≈15.4min>10min）', async () => {
    const inner = { messages: { create: vi.fn().mockResolvedValue({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }) } };
    const FakeCtor = Object.assign(function () { /* ctor */ }, {
      RateLimitError: class extends Error { }, InternalServerError: class extends Error { },
      APIConnectionTimeoutError: class extends Error { }, APIConnectionError: class extends Error { },
      AuthenticationError: class extends Error { }, BadRequestError: class extends Error { },
      APIError: class extends Error { status?: number },
    });
    const c = wrapAnthropicClient(inner as never, FakeCtor as never);
    await c.create({ model: 'm', messages: [], max_tokens: 32768 } as never);
    const opts = inner.messages.create.mock.calls[0][1] as { timeout: number };
    expect(opts.timeout).toBe(Math.ceil((32768 / 128_000) * 60 * 60_000));
    expect(opts.timeout).toBeGreaterThan(10 * 60_000);
  });

  // 反例：小预算不缩水——恒下限 10min（与 SDK 缺省一致,不因换算变短）
  it('反例：小 max_tokens 的 timeout 恒为 10min 下限', async () => {
    const inner = { messages: { create: vi.fn().mockResolvedValue({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }) } };
    const FakeCtor = Object.assign(function () { /* ctor */ }, {
      RateLimitError: class extends Error { }, InternalServerError: class extends Error { },
      APIConnectionTimeoutError: class extends Error { }, APIConnectionError: class extends Error { },
      AuthenticationError: class extends Error { }, BadRequestError: class extends Error { },
      APIError: class extends Error { status?: number },
    });
    const c = wrapAnthropicClient(inner as never, FakeCtor as never);
    await c.create({ model: 'm', messages: [], max_tokens: 4096 } as never);
    expect((inner.messages.create.mock.calls[0][1] as { timeout: number }).timeout).toBe(10 * 60_000);
  });

  it('正例：错误分类与 dispatcher 旧 instanceof 行为逐类别一致', () => {
    class RL extends Error { } class ISE extends Error { } class TO extends Error { }
    class NE extends Error { } class AF extends Error { } class BR extends Error { }
    class AE extends Error { status?: number }
    const FakeCtor = Object.assign(function () { /* ctor */ }, {
      RateLimitError: RL, InternalServerError: ISE, APIConnectionTimeoutError: TO,
      APIConnectionError: NE, AuthenticationError: AF, BadRequestError: BR, APIError: AE,
    });
    const c = wrapAnthropicClient({ messages: { create: vi.fn() } } as never, FakeCtor as never);
    expect(c.classifyError(new RL('x'))).toBe('rate_limited');
    expect(c.classifyError(new ISE('x'))).toBe('server_error');
    expect(c.classifyError(new TO('x'))).toBe('timeout');
    expect(c.classifyError(new NE('x'))).toBe('network');
    expect(c.classifyError(new AF('x'))).toBe('auth');
    expect(c.classifyError(new BR('prompt is too long: 200000 tokens'))).toBe('context_overflow');
  });

  it('反例：BadRequest 裸 token 子串不判溢出（既有收紧判据在包装层不回退）', () => {
    class BR extends Error { }
    const FakeCtor = Object.assign(function () { /* ctor */ }, {
      RateLimitError: class extends Error { }, InternalServerError: class extends Error { },
      APIConnectionTimeoutError: class extends Error { }, APIConnectionError: class extends Error { },
      AuthenticationError: class extends Error { }, BadRequestError: BR, APIError: class extends Error { },
    });
    const c = wrapAnthropicClient({ messages: { create: vi.fn() } } as never, FakeCtor as never);
    expect(c.classifyError(new BR('invalid token provided'))).toBe('other');
  });
});

// @v: anc-exec-protocol-adapter
// openai-responses 适配器（0020 批）——IR↔Responses typed items 双向映射与工具循环原生承载。
const RESPONSES_TEXT_RESP = {
  id: 'resp-1',
  model: 'deepseek-chat',
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案是 42' }] }],
  usage: { input_tokens: 20, output_tokens: 7, input_tokens_details: { cached_tokens: 12 } },
};

describe('OpenAI Responses 协议适配器（IR 双向映射 + 工具循环）', () => {
  it('正例：请求映射——system→instructions、max_tokens→max_output_tokens、恒 store:false、不发 previous_response_id', async () => {
    responsesCreateMock.mockResolvedValueOnce(RESPONSES_TEXT_RESP);
    const c = makeOpenAiResponsesClient({ apiKey: 'k', baseURL: 'https://api.deepseek.com/v1' });
    expect(c.protocol).toBe('openai-responses');
    expect(c.supportsToolLoop).toBe(true);
    await c.create({
      model: 'deepseek-chat',
      system: '你是执行者',
      messages: [{ role: 'user', content: '算数' }],
      max_tokens: 4096,
      temperature: 0,
    });
    const sent = responsesCreateMock.mock.calls[0][0];
    expect(sent.instructions).toBe('你是执行者');
    expect(sent.input).toEqual([{ role: 'user', content: '算数' }]);
    expect(sent.max_output_tokens).toBe(4096);
    expect(sent.temperature).toBe(0);
    expect(sent.store).toBe(false);
    expect('previous_response_id' in sent).toBe(false);
    expect('max_tokens' in sent).toBe(false);
  });

  it('正例：temperature 缺席不发字段（responses 侧,与 chat 侧同口径）', async () => {
    responsesCreateMock.mockResolvedValueOnce(RESPONSES_TEXT_RESP);
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 });
    expect('temperature' in responsesCreateMock.mock.calls.at(-1)![0]).toBe(false);
  });

  it('正例：tool_result content 为块数组形态 → 拍平为文本入 function_call_output', async () => {
    responsesCreateMock.mockResolvedValueOnce(RESPONSES_TEXT_RESP);
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    await c.create({ model: 'm', max_tokens: 100,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] }] },
      ] });
    const sent = responsesCreateMock.mock.calls.at(-1)![0];
    const out = sent.input.find((i: any) => i.type === 'function_call_output');
    expect(out.output).toBe('第一段\n第二段');
  });

  it('正例：IR tools（Anthropic 形）→ Responses 工具形顶层平铺（不包 chat 的 function 壳）', async () => {
    responsesCreateMock.mockResolvedValueOnce(RESPONSES_TEXT_RESP);
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    await c.create({
      model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object' as const, properties: { city: { type: 'string' } } } }],
    });
    const sent = responsesCreateMock.mock.calls[responsesCreateMock.mock.calls.length - 1][0];
    expect(sent.tools[0]).toMatchObject({
      type: 'function',
      name: 'get_weather',
      description: '查天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    });
    expect('function' in sent.tools[0]).toBe(false);
    expect(sent.tools[0].strict).toBe(false);   // strict:true 会拒(引擎工具 schema 非全字段 required)——review 批变异6存活后钉死
  });

  it('正例：IR 工具往返消息 → function_call / function_call_output typed items（工具循环第二轮请求形）', async () => {
    responsesCreateMock.mockResolvedValueOnce(RESPONSES_TEXT_RESP);
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    await c.create({
      model: 'm', max_tokens: 100,
      messages: [
        { role: 'user', content: '查北京天气' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"weather":"晴"}' }] },
      ],
    });
    const sent = responsesCreateMock.mock.calls[responsesCreateMock.mock.calls.length - 1][0];
    expect(sent.input).toEqual([
      { role: 'user', content: '查北京天气' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"weather":"晴"}' },
    ]);
  });

  it('正例：响应映射——message→text 块、usage 同名直取、cached_tokens 入 cache_read_input_tokens', async () => {
    responsesCreateMock.mockResolvedValueOnce(RESPONSES_TEXT_RESP);
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    const resp = await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 });
    expect(resp.content).toEqual([{ type: 'text', text: '答案是 42', citations: null }]);
    expect(resp.usage.input_tokens).toBe(20);
    expect(resp.usage.output_tokens).toBe(7);
    expect(resp.usage.cache_read_input_tokens).toBe(12);
    expect(resp.stop_reason).toBe('end_turn');
  });

  it('正例：响应 function_call item → IR tool_use 块（arguments JSON 解析），stop_reason=tool_use', async () => {
    responsesCreateMock.mockResolvedValueOnce({
      ...RESPONSES_TEXT_RESP,
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'function_call', call_id: 'call_9', name: 'get_weather', arguments: '{"city":"北京"}' },
      ],
    });
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    const resp = await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 });
    expect(resp.content).toEqual([{ type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: '北京' } }]);
    expect(resp.stop_reason).toBe('tool_use');
  });

  it('反例：function_call arguments 坏 JSON → 响亮抛 RESPONSES_BAD_FUNCTION_ARGS 不静默吞', async () => {
    responsesCreateMock.mockResolvedValueOnce({
      ...RESPONSES_TEXT_RESP,
      output: [{ type: 'function_call', call_id: 'c', name: 't', arguments: '{broken' }],
    });
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    await expect(c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 }))
      .rejects.toThrow(/RESPONSES_BAD_FUNCTION_ARGS/);
  });

  it('反例：status=incomplete + reason=max_output_tokens → stop_reason 映射 max_tokens（截断可感知）', async () => {
    responsesCreateMock.mockResolvedValueOnce({
      ...RESPONSES_TEXT_RESP,
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '半截' }] }],
    });
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    const resp = await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10 });
    expect(resp.stop_reason).toBe('max_tokens');
  });

  it('正例：reasoning item 丢弃不进 IR（引擎不消费思考正文）', async () => {
    responsesCreateMock.mockResolvedValueOnce({
      ...RESPONSES_TEXT_RESP,
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '想了想' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '结论' }] },
      ],
    });
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    const resp = await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 });
    expect(resp.content).toEqual([{ type: 'text', text: '结论', citations: null }]);
  });

  it('正例：错误分类与 chat 适配器共用同一判据（SDK 错误类逐映射）', () => {
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    expect(c.classifyError(new (OpenAI as any).RateLimitError('429'))).toBe('rate_limited');
    expect(c.classifyError(new (OpenAI as any).AuthenticationError('401'))).toBe('auth');
    const br = new (OpenAI as any).BadRequestError('prompt is too long: 300000 tokens');
    expect(c.classifyError(br)).toBe('context_overflow');
    expect(c.classifyError(new (OpenAI as any).BadRequestError('invalid token provided'))).toBe('other');
  });
});

// @v: anc-exec-protocol-adapter
// reasoning effort 映射 + 被拒剥除重试 + 工具轮回显（0020 批阅卷后补——作者拍两点映射本批就做）
describe('OpenAI Responses reasoning 面（两点映射/剥除重试/工具轮回显）', () => {
  it('正例：IR thinking enabled→reasoning.effort=high、disabled→low、无 thinking 键不发（两点映射,budget 丢弃）', async () => {
    responsesCreateMock.mockResolvedValue(RESPONSES_TEXT_RESP);
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100,
      thinking: { type: 'enabled', budget_tokens: 4096 } } as never);
    expect(responsesCreateMock.mock.calls.at(-1)![0].reasoning).toEqual({ effort: 'high' });
    expect('budget_tokens' in (responsesCreateMock.mock.calls.at(-1)![0].reasoning ?? {})).toBe(false);
    await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100,
      thinking: { type: 'disabled' } } as never);
    expect(responsesCreateMock.mock.calls.at(-1)![0].reasoning).toEqual({ effort: 'low' });
    await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 });
    expect('reasoning' in responsesCreateMock.mock.calls.at(-1)![0]).toBe(false);
  });

  it('正例：带 tools 时随发 include=[reasoning.encrypted_content]（store:false 取加密思考链官方通道）;无 tools 不发', async () => {
    responsesCreateMock.mockResolvedValue(RESPONSES_TEXT_RESP);
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100,
      tools: [{ name: 't', description: '', input_schema: { type: 'object' as const } }] });
    expect(responsesCreateMock.mock.calls.at(-1)![0].include).toEqual(['reasoning.encrypted_content']);
    await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 });
    expect('include' in responsesCreateMock.mock.calls.at(-1)![0]).toBe(false);
  });

  it('反例→自愈：reasoning 参数被 400 拒 → 剥除当场重发一次并记名,后续请求恒免传', async () => {
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    responsesCreateMock
      .mockRejectedValueOnce(new (OpenAI as any).BadRequestError("Unsupported parameter: 'reasoning' is not supported with this model"))
      .mockResolvedValue(RESPONSES_TEXT_RESP);
    const resp = await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100,
      thinking: { type: 'enabled', budget_tokens: 1024 } } as never);
    expect(resp.content[0]).toMatchObject({ type: 'text' });
    // 第一发带 reasoning,重发不带
    const calls = responsesCreateMock.mock.calls.slice(-2);
    expect('reasoning' in calls[0][0]).toBe(true);
    expect('reasoning' in calls[1][0]).toBe(false);
    // 记名后下一请求恒免传
    await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100,
      thinking: { type: 'enabled', budget_tokens: 1024 } } as never);
    expect('reasoning' in responsesCreateMock.mock.calls.at(-1)![0]).toBe(false);
  });

  it('反例→自愈：include 参数被拒（报文不含 reasoning 字样）→ 判据独立命中剥除重发', async () => {
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    responsesCreateMock
      .mockRejectedValueOnce(new (OpenAI as any).BadRequestError("Unknown parameter: 'include'"))
      .mockResolvedValue(RESPONSES_TEXT_RESP);
    const resp = await c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100,
      tools: [{ name: 't', description: '', input_schema: { type: 'object' as const } }] });
    expect(resp).toBeTruthy();
    const calls = responsesCreateMock.mock.calls.slice(-2);
    expect('include' in calls[0][0]).toBe(true);    // 首发带 include
    expect('include' in calls[1][0]).toBe(false);   // 剥除重发不带
  });

  it('正例：工具轮缓存 FIFO——同响应多枚 function_call 各自入缓存独立回显;超 128 逐出最旧键退回 call_id-only', async () => {
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    const rs = { type: 'reasoning', id: 'rs_x', summary: [], encrypted_content: 'opaque' };
    // 一轮:同响应两枚 function_call(共享前导 reasoning)
    responsesCreateMock.mockResolvedValueOnce({ ...RESPONSES_TEXT_RESP,
      output: [rs,
        { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 't', arguments: '{}' },
        { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 't', arguments: '{}' }] });
    await c.create({ model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 't', description: '', input_schema: { type: 'object' as const } }] });
    // 二轮:回显 call_a(第一枚)——应带原 item id。选第一枚是有意的:FIFO 被改成"逐出一切旧键"
    // (如 >=0)时 fc_a 会被同响应的 fc_b 逐出,此断言即红;回显最新键测不出该变体
    responsesCreateMock.mockResolvedValueOnce(RESPONSES_TEXT_RESP);
    await c.create({ model: 'm', max_tokens: 100,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'r' }] },
      ] });
    const sent2 = responsesCreateMock.mock.calls.at(-1)![0];
    const fcA1 = sent2.input.find((i: any) => i.type === 'function_call');
    expect(fcA1.id).toBe('fc_a');   // 两枚各自独立入缓存,旧键在上限内不被逐出(>=0 变体在此必红)
    // 超 128 逐出:灌 130 枚 function_call 后,最早的 call_a 应已逐出——回显退回 call_id-only
    for (let i = 0; i < 65; i++) {
      responsesCreateMock.mockResolvedValueOnce({ ...RESPONSES_TEXT_RESP,
        output: [
          { type: 'function_call', id: `fc_x${i}a`, call_id: `call_x${i}a`, name: 't', arguments: '{}' },
          { type: 'function_call', id: `fc_x${i}b`, call_id: `call_x${i}b`, name: 't', arguments: '{}' }] });
      await c.create({ model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 't', description: '', input_schema: { type: 'object' as const } }] });
    }
    responsesCreateMock.mockResolvedValueOnce(RESPONSES_TEXT_RESP);
    await c.create({ model: 'm', max_tokens: 100,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'r' }] },
      ] });
    const sentOld = responsesCreateMock.mock.calls.at(-1)![0];
    const fcA = sentOld.input.find((i: any) => i.type === 'function_call');
    expect('id' in fcA).toBe(false);   // 已逐出——FIFO 上限语义(>=0 或撤逐出的变体在此必红)
  });

  it('反例：非 reasoning 类 BadRequest 原样穿透不触发剥除重发', async () => {
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    responsesCreateMock.mockRejectedValueOnce(new (OpenAI as any).BadRequestError('invalid input schema'));
    const before = responsesCreateMock.mock.calls.length;
    await expect(c.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100,
      thinking: { type: 'enabled', budget_tokens: 1024 } } as never)).rejects.toThrow(/invalid input schema/);
    expect(responsesCreateMock.mock.calls.length).toBe(before + 1);   // 只发了一次,无重发
  });

  it('正例：工具轮回显——同 client 二轮请求把一轮响应的 reasoning items 与 function_call item id 原样回显', async () => {
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA-opaque' };
    responsesCreateMock
      .mockResolvedValueOnce({ ...RESPONSES_TEXT_RESP,
        output: [reasoningItem, { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'search', arguments: '{"q":"x"}' }] })
      .mockResolvedValueOnce(RESPONSES_TEXT_RESP);
    // 一轮：拿到 tool_use（reasoning 不进 IR）
    const r1 = await c.create({ model: 'm', messages: [{ role: 'user', content: '查' }], max_tokens: 100,
      tools: [{ name: 'search', description: '', input_schema: { type: 'object' as const } }] });
    expect(r1.content).toEqual([{ type: 'tool_use', id: 'call_a', name: 'search', input: { q: 'x' } }]);
    // 二轮：IR 工具往返回发 → input 应含回显的 reasoning item 与带 id 的 function_call
    await c.create({ model: 'm', max_tokens: 100,
      messages: [
        { role: 'user', content: '查' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'search', input: { q: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'ok' }] },
      ],
      tools: [{ name: 'search', description: '', input_schema: { type: 'object' as const } }] });
    const sent = responsesCreateMock.mock.calls.at(-1)![0];
    expect(sent.input).toEqual([
      { role: 'user', content: '查' },
      reasoningItem,
      { type: 'function_call', call_id: 'call_a', name: 'search', arguments: '{"q":"x"}', id: 'fc_1' },
      { type: 'function_call_output', call_id: 'call_a', output: 'ok' },
    ]);
  });

  it('正例：缓存未命中（跨进程恢复形态）→ 不回显 reasoning,function_call 只带 call_id 照旧可发', async () => {
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });   // 新 client=零缓存
    responsesCreateMock.mockResolvedValueOnce(RESPONSES_TEXT_RESP);
    await c.create({ model: 'm', max_tokens: 100,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_gone', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_gone', content: 'r' }] },
      ] });
    const sent = responsesCreateMock.mock.calls.at(-1)![0];
    expect(sent.input[0]).toEqual({ type: 'function_call', call_id: 'call_gone', name: 't', arguments: '{}' });
    expect('id' in sent.input[0]).toBe(false);
  });

  it('正例：text+tool_use 混排保持原序（text flush 先于 function_call,不再聚合尾部颠倒）', async () => {
    responsesCreateMock.mockResolvedValueOnce(RESPONSES_TEXT_RESP);
    const c = makeOpenAiResponsesClient({ apiKey: 'k' });
    await c.create({ model: 'm', max_tokens: 100,
      messages: [{ role: 'assistant', content: [
        { type: 'text', text: '我来查一下' },
        { type: 'tool_use', id: 'call_b', name: 't', input: {} },
      ] }] });
    const sent = responsesCreateMock.mock.calls.at(-1)![0];
    expect(sent.input[0]).toEqual({ role: 'assistant', content: '我来查一下' });
    expect(sent.input[1]).toMatchObject({ type: 'function_call', call_id: 'call_b' });
  });
});
