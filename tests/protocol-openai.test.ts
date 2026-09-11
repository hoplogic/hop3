// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: step-dispatcher ^anc-struct-step-dispatcher
// OpenAI 协议适配器判据回归——IR 双向映射/错误分类/工具循环 fail-fast。
// 见 design/step-dispatcher.md ^anc-exec-protocol-adapter
import { describe, it, expect, vi } from 'vitest';

const createMock = vi.fn();
vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: createMock } },
  }));
  for (const k of ['RateLimitError', 'InternalServerError', 'APIConnectionTimeoutError', 'APIConnectionError', 'AuthenticationError', 'BadRequestError', 'APIError']) {
    (MockOpenAI as unknown as Record<string, unknown>)[k] = class extends Error { };
  }
  return { default: MockOpenAI };
});

import OpenAI from 'openai';
import { makeOpenAiClient, wrapAnthropicClient } from '../src/protocol-openai.js';

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
