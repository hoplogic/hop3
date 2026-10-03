// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: step-dispatcher ^anc-struct-step-dispatcher
// 长等待连接设置真 SDK 回归（todo/0117）——本文件不 mock 任何 SDK:用真 @anthropic-ai/sdk / openai +
// 真 undici Agent,经 Agent 的 connect 注入一条内存里的假连接（node:stream duplexPair,不开端口——
// 沙箱与 CI 都不必 listen）,假服务器按设定延迟回一条合法响应。时限用毫秒级短值替代 300 秒:
// 验的是"时限由引擎给的连接设置决定、超时后归哪一档",与具体秒数无关。
// 见 design/step-dispatcher.md ^anc-exec-nonstreaming-timeout "连接设置"段与 ^anc-exec-api-retry D61 条
import { describe, it, expect } from 'vitest';
import { duplexPair } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { Agent } from 'undici';
import { longWaitFetchOptions, makeOpenAiClient, wrapAnthropicClient, nonstreamingWaitMs } from '../src/protocol-openai.js';
import { StepDispatcher } from '../src/dispatcher.js';
import { ExecutionEngine } from '../src/engine.js';
import type { HostConfig } from '../src/provider-types.js';

const ANTHROPIC_BODY = { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
const OPENAI_BODY = { id: 'c', object: 'chat.completion', model: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

/** 假连接工厂:收齐一条 HTTP 请求后,headerDelayMs 毫秒才回响应头。stallBody=true 时响应头与半截
 * 响应体先发,剩下的永远不发（造"等数据超时"）。返回 undici Agent 的 connect 选项。 */
function fakeConnect(body: object, headerDelayMs: number, stallBody = false): Agent.Options['connect'] {
  return ((_opts: unknown, cb: (err: Error | null, socket: unknown) => void) => {
    const [client, server] = duplexPair();
    for (const m of ['setKeepAlive', 'setNoDelay', 'ref', 'unref', 'setTimeout']) (client as unknown as Record<string, unknown>)[m] = () => client;
    Object.assign(client, { remoteAddress: '127.0.0.1', remotePort: 80, alpnProtocol: false });
    server.on('error', () => { /* 客户端超时断开后的写入错误不关心 */ });
    let buf = '';
    server.on('data', (d: Buffer) => {
      buf += d.toString();
      const headEnd = buf.indexOf('\r\n\r\n');
      if (headEnd < 0) return;
      const len = Number(/content-length: (\d+)/i.exec(buf)?.[1] ?? 0);
      if (buf.length < headEnd + 4 + len) return;
      buf = '';
      setTimeout(() => {
        if (server.destroyed) return;
        const text = JSON.stringify(body);
        const head = `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\n\r\n`;
        server.write(stallBody ? head + text.slice(0, 10) : head + text);
      }, headerDelayMs);
    });
    queueMicrotask(() => cb(null, client));
  }) as unknown as Agent.Options['connect'];
}

function anthropicWith(waitMs: number, connect: Agent.Options['connect']) {
  // 与 dispatcher 构造点同形:timeout=waitMs、maxRetries 0、连接设置取 waitMs
  const sdk = new Anthropic({ apiKey: 'k', authToken: null, baseURL: 'http://fake.local', timeout: waitMs, maxRetries: 0, fetchOptions: longWaitFetchOptions(waitMs, { connect }) as never });
  return wrapAnthropicClient(sdk, Anthropic);
}
const REQ = { model: 'x', max_tokens: 10, messages: [{ role: 'user' as const, content: 'hi' }] };

// @v: anc-exec-nonstreaming-timeout
describe('长等待连接设置（真 SDK + 假连接,todo/0117）', () => {
  it('正例：dispatcher 构造出的客户端带 undici 连接设置,两个时限与 client 级等待上限同值,SDK 内部重试关掉', () => {
    const engine = new ExecutionEngine();
    const host = { workspace_dir: '/tmp/t', api_key: 'k', env_snapshot: {}, sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } } } as unknown as HostConfig;
    engine.initExecution('# T\nId: t\n\n## Goal\ng\n\n## Outputs\n- r: text  # r\n\n## Steps\n1. [reason] x\n  + → r: text  # r\n  > x\n', host);
    const d = new StepDispatcher(engine, host);
    const opts = (d as any).defaultClient.messages._client._options as { timeout: number; maxRetries: number; fetchOptions: { dispatcher: Agent } };
    const expected = nonstreamingWaitMs(32768);   // 缺省输出上限 32768 → 约 15.4 分钟
    expect(opts.timeout).toBe(expected);
    expect(opts.maxRetries).toBe(0);
    expect(opts.fetchOptions.dispatcher).toBeInstanceOf(Agent);
    const sym = Object.getOwnPropertySymbols(opts.fetchOptions.dispatcher).find(s => s.description === 'options')!;
    const agentOpts = (opts.fetchOptions.dispatcher as unknown as Record<symbol, { headersTimeout: number; bodyTimeout: number }>)[sym];
    expect(agentOpts.headersTimeout).toBe(expected);
    expect(agentOpts.bodyTimeout).toBe(expected);
    expect(expected).toBeGreaterThan(300_000);   // 比 undici 缺省 300 秒长——这正是要治的病
  });

  it('正例：响应头在引擎等待上限之内到达 → 成功（anthropic）', async () => {
    const c = anthropicWith(3000, fakeConnect(ANTHROPIC_BODY, 600));
    const resp = await c.create(REQ as never);
    expect((resp.content[0] as { text: string }).text).toBe('ok');
  });

  it('反例：响应头晚于引擎等待上限 → SDK 超时错误,classify 归 timeout（不归 network）', async () => {
    const c = anthropicWith(300, fakeConnect(ANTHROPIC_BODY, 3000));
    const t0 = Date.now();
    const err = await c.create(REQ as never).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(c.classifyError(err)).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2500);   // 由 300ms 的时限掐断,没等假服务器的 3 秒
  });

  it('反例：响应体中途停满等数据时限 → 裸 terminated 也按 undici 错误码归 timeout,不被文案兜底当成网络断流', async () => {
    const c = anthropicWith(400, fakeConnect(ANTHROPIC_BODY, 0, true));
    const err = await c.create(REQ as never).then(() => undefined, (e: unknown) => e) as Error & { cause?: { code?: string } };
    expect(String(err?.message)).toMatch(/terminated/);
    expect(err.cause?.code).toBe('UND_ERR_BODY_TIMEOUT');
    expect(c.classifyError(err)).toBe('timeout');
  });

  it('正例：openai-chat 协议同样按引擎给的连接设置等待——早于上限成功,晚于上限归 timeout', async () => {
    const ok = makeOpenAiClient({ apiKey: 'k', baseURL: 'http://fake.local/v1', waitMs: 3000, fetchExtra: { connect: fakeConnect(OPENAI_BODY, 600) } });
    const resp = await ok.create(REQ as never);
    expect((resp.content[0] as { text: string }).text).toBe('ok');
    const slow = makeOpenAiClient({ apiKey: 'k', baseURL: 'http://fake.local/v1', waitMs: 300, fetchExtra: { connect: fakeConnect(OPENAI_BODY, 3000) } });
    const err = await slow.create(REQ as never).then(() => undefined, (e: unknown) => e);
    expect(slow.classifyError(err)).toBe('timeout');
  });
});
