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
import { longWaitFetchOptions, makeOpenAiClient, wrapAnthropicClient, nonstreamingWaitMs, createCachingLookup } from '../src/protocol-openai.js';
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

// DNS 缓存（hopissues/0118,^anc-exec-network-pause "曾经连通过的端点不按死端点判"）——解析成功的地址
// 进缓存,之后同名解析撞 ENOTFOUND/EAI_AGAIN 用缓存地址顶上;从没解析成功过的主机名错误照传。
// 用假的底层解析函数驱动,不碰真 DNS。
// @v: anc-exec-network-pause
describe('DNS 缓存解析（hopissues/0118）', () => {
  type Addr = { address: string; family: number };
  const dnsErr = (code: string) => Object.assign(new Error(`getaddrinfo ${code} h`), { code });
  /** 假底层解析:按 script 顺序逐次给结果（地址数组或错误码字符串）,并记下每次收到的 options。 */
  function scriptedLookup(script: Array<Addr[] | string>) {
    const seen: Array<Record<string, unknown>> = [];
    const fn = ((_host: string, opts: Record<string, unknown>, cb: (e: Error | null, a?: Addr[]) => void) => {
      seen.push(opts);
      const next = script.shift();
      if (typeof next === 'string') cb(dnsErr(next));
      else cb(null, next);
    }) as never;
    return { fn, seen };
  }
  const call = (lk: ReturnType<typeof createCachingLookup>, host: string, opts: Record<string, unknown>) =>
    new Promise<{ err: (Error & { code?: string }) | null; a?: unknown; f?: unknown }>(res =>
      lk(host, opts as never, ((err: Error | null, a?: unknown, f?: unknown) => res({ err, a, f })) as never));
  const V4: Addr = { address: '10.0.0.1', family: 4 };
  const V6: Addr = { address: 'fd00::1', family: 6 };

  it('正例：先解析成功,之后 ENOTFOUND → 用缓存地址回调（all:true 回数组,非 all 回首个地址与地址族）', async () => {
    const { fn, seen } = scriptedLookup([[V4, V6], 'ENOTFOUND', 'ENOTFOUND']);
    const lk = createCachingLookup(fn);
    const first = await call(lk, 'api.x', { all: true });
    expect(first.err).toBeNull();
    expect(first.a).toEqual([V4, V6]);
    const all = await call(lk, 'api.x', { all: true });
    expect(all.err).toBeNull();
    expect(all.a).toEqual([V4, V6]);
    const single = await call(lk, 'api.x', {});
    expect(single.err).toBeNull();
    expect(single.a).toBe('10.0.0.1');
    expect(single.f).toBe(4);
    // 底层恒以 all:true 取全部地址——缓存里存的是完整地址表,与调用方本次要不要 all 无关
    expect(seen.every(o => o.all === true)).toBe(true);
  });

  it('正例：EAI_AGAIN（解析服务器暂时答不上）同样用缓存', async () => {
    const { fn } = scriptedLookup([[V4], 'EAI_AGAIN']);
    const lk = createCachingLookup(fn);
    await call(lk, 'api.y', {});
    const r = await call(lk, 'api.y', {});
    expect(r.err).toBeNull();
    expect(r.a).toBe('10.0.0.1');
  });

  it('正例：按调用方要的地址族过滤缓存（family:6 只给 IPv6;"IPv4" 字符串形态同认）', async () => {
    const { fn } = scriptedLookup([[V4, V6], 'ENOTFOUND', 'ENOTFOUND']);
    const lk = createCachingLookup(fn);
    await call(lk, 'api.z', { all: true });
    const v6 = await call(lk, 'api.z', { all: true, family: 6 });
    expect(v6.a).toEqual([V6]);
    const v4 = await call(lk, 'api.z', { family: 'IPv4' });
    expect(v4.a).toBe('10.0.0.1');
    expect(v4.f).toBe(4);
  });

  it('反例：从没解析成功过的主机名 ENOTFOUND → 原错误照传（不凭空造地址;0106 死端点判据不受影响）', async () => {
    const { fn } = scriptedLookup(['ENOTFOUND']);
    const lk = createCachingLookup(fn);
    const r = await call(lk, 'never.resolved', {});
    expect(r.err?.code).toBe('ENOTFOUND');
  });

  it('反例：缓存过但这次是非解析类错误码（如 EINVAL）→ 原错误照传,不拿缓存顶', async () => {
    const { fn } = scriptedLookup([[V4], 'EINVAL']);
    const lk = createCachingLookup(fn);
    await call(lk, 'api.w', {});
    const r = await call(lk, 'api.w', {});
    expect(r.err?.code).toBe('EINVAL');
  });

  it('反例：缓存里没有调用方要的地址族（只缓存过 IPv4,要 family:6）→ 原错误照传', async () => {
    const { fn } = scriptedLookup([[V4], 'ENOTFOUND']);
    const lk = createCachingLookup(fn);
    await call(lk, 'api.v', {});
    const r = await call(lk, 'api.v', { family: 6 });
    expect(r.err?.code).toBe('ENOTFOUND');
  });

  it('正例：缓存按主机名分开——A 解析成功不替 B 兜底', async () => {
    const { fn } = scriptedLookup([[V4], 'ENOTFOUND']);
    const lk = createCachingLookup(fn);
    await call(lk, 'a.host', {});
    const r = await call(lk, 'b.host', {});
    expect(r.err?.code).toBe('ENOTFOUND');
  });

  // 接线:longWaitFetchOptions 产出的 undici Agent 的 connect 设置里带上缓存解析函数。
  // 读 Agent 存放构造参数的内部 Symbol(options)——undici 没有公开读口,这是唯一能直接看到接线的地方
  const agentConnect = (fetchOptions: { dispatcher?: unknown }) => {
    const d = fetchOptions.dispatcher as Record<symbol, unknown>;
    const sym = Object.getOwnPropertySymbols(d).find(s => s.description === 'options');
    expect(sym).toBeDefined();
    return (d[sym as symbol] as { connect?: unknown }).connect;
  };

  it('接线正例：connect 缺席或是普通对象 → 合入缓存解析函数,普通对象里的其他设置保留', () => {
    const bare = agentConnect(longWaitFetchOptions(1000) as never) as Record<string, unknown>;
    expect(typeof bare.lookup).toBe('function');
    const merged = agentConnect(longWaitFetchOptions(1000, { connect: { timeout: 5 } }) as never) as Record<string, unknown>;
    expect(typeof merged.lookup).toBe('function');
    expect(merged.timeout).toBe(5);
  });

  it('接线反例：调用方自带 lookup 时以调用方的为准;connect 是函数（自定义建连）时原样不动', () => {
    const mine = () => undefined;
    const own = agentConnect(longWaitFetchOptions(1000, { connect: { lookup: mine } }) as never) as Record<string, unknown>;
    expect(own.lookup).toBe(mine);
    const fnConnect = fakeConnect(ANTHROPIC_BODY, 0);
    expect(agentConnect(longWaitFetchOptions(1000, { connect: fnConnect }) as never)).toBe(fnConnect);
  });
});
