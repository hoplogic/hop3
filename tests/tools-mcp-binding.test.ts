// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: tools ^anc-struct-tools
// McpBinding 判据回归——真 MCP server（SDK InMemory 传输）+ 四服务实测形态 fixture。
// 见 design/tool-interface.md ^anc-exec-mcp-binding。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { McpBindingMember } from '../src/tools-mcp-binding.js';
import { CompositeToolProvider } from '../src/tools-composite.js';
import { resolve as pathResolve } from 'node:path';
import type { ToolServerEntry } from '../src/tools-registry.js';
import type { HostConfig } from '../src/provider-types.js';

const HOST: HostConfig = {
  workspace_dir: '/tmp',
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'k',
};

// 真 server（SDK 实现）经 InMemory 传输——协议全链真跑（initialize/tools/list/tools/call），
// 只有网络层是内存管道。百炼系形态 fixture：text 块内嵌 JSON（四服务一致惯例）。
async function makeLiveServer(): Promise<{ member: McpBindingMember; warns: string[] }> {
  const server = new McpServer({ name: 'fixture-server', version: '1.0.0' });
  server.tool('search', { query: z.string(), count: z.number().optional() }, async ({ query }) => ({
    content: [{ type: 'text', text: JSON.stringify({ pages: [{ title: `关于${query}`, url: 'https://x' }], request_id: 'r1', status: 200 }) }],
  }));
  server.tool('boom', { q: z.string() }, async () => ({
    isError: true,
    content: [{ type: 'text', text: '{"_headers":{":status":"404"},"detail":"' + 'x'.repeat(1200) + '"}' }],
  }));
  // 多 text 块形态（0006）：首块=合法 JSON,次块=说明文字（分段输出型 server）
  server.tool('multi', { q: z.string() }, async () => ({
    content: [
      { type: 'text', text: JSON.stringify({ pages: [{ title: '首块' }] }) },
      { type: 'text', text: '以上结果来自缓存,更新于 5 分钟前。' },
    ],
  }));
  server.tool('multiboom', { q: z.string() }, async () => ({
    isError: true,
    content: [
      { type: 'text', text: '错误概要: 上游 502' },
      { type: 'text', text: '详情: gateway unreachable' },
    ],
  }));

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);

  const entry: ToolServerEntry = {
    name: 'fixture',
    binding: { kind: 'mcp', transport: 'http', url: 'https://unused.example/mcp' },
    tools: [
      { name: 'search', requires_commit: false, output_schema: { pages: ['yaml'] }, unwrap: 'json-in-text' },
      { name: 'boom', requires_commit: false },
      { name: 'multi', requires_commit: false, output_schema: { pages: ['yaml'] }, unwrap: 'json-in-text' },
      { name: 'multiboom', requires_commit: false },
      { name: 'ghost_tool', requires_commit: false },   // 白名单声明但 server 实况没有——漂移 warn
    ],
  };
  const warns: string[] = [];
  const member = new McpBindingMember(entry, { warn: m => warns.push(m) });
  // 测试注入：绕过网络传输，直接用 linked pair 的 client 侧（连接+发现走真协议）
  const client = new Client({ name: 'hopjit-test', version: '0.0.0' });
  await client.connect(clientT);
  (member as unknown as { client: Client }).client = client;
  const listed = await client.listTools();
  const discovered = (member as unknown as { discovered: Map<string, { inputSchema?: Record<string, unknown> }> }).discovered;
  for (const t of listed.tools ?? []) discovered.set(t.name, { inputSchema: t.inputSchema as Record<string, unknown> });
  for (const d of entry.tools) if (!discovered.has(d.name)) warns.push(`工具声明漂移: "${d.name}" 在 hoptools.yaml 白名单但 server 'fixture' 实况未提供`);
  return { member, warns };
}

// @v: anc-exec-mcp-binding, anc-exec-tool-server-lifecycle —— 惰性连接/调用/close 即生命周期②③④的判据
describe('McpBinding（真 server 经 InMemory 传输）', () => {
  it('正例：tools/call 全链——text 块取回（unwrap/shape 归 Composite 层，本层零形状语义）', async () => {
    const { member } = await makeLiveServer();
    const r = await member.execute('search', { query: 'HopSpec' });
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain('"pages"');
  });

  // 多 text 块=取首块+丢弃留痕（0006——原 join 全部块与设计'首块'文字矛盾:join 破坏
  // unwrap json-in-text,首块合法 JSON 被次块说明污染 parse 必炸误入 SCHEMA_DEVIATION）。
  // @v: anc-exec-mcp-binding
  it('正例：多 text 块取首块——首块 JSON 完好可解,次块说明不污染;丢弃留痕 audit（0006）', async () => {
    const { member } = await makeLiveServer();
    const r = await member.execute('multi', { q: 'x' });
    expect(r.success).toBe(true);
    expect(JSON.parse(r.result as string)).toEqual({ pages: [{ title: '首块' }] });   // 首块完好非 join 污染
    expect(r.audit?.discarded_text_blocks).toBe(1);                                    // 留痕
  });

  it('正例：单 text 块无丢弃 → audit 不带 discarded 字段（零噪声回归）', async () => {
    const { member } = await makeLiveServer();
    const r = await member.execute('search', { query: 'x' });
    expect(r.success).toBe(true);
    expect(r.audit?.discarded_text_blocks).toBeUndefined();
  });

  it('反例：isError 多块 → 错误文本仍 join 全部块（排查信息增益,0006 例外条款）', async () => {
    const { member } = await makeLiveServer();
    const r = await member.execute('multiboom', { q: 'x' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('上游 502');
    expect(String(r.result)).toContain('gateway unreachable');   // 两块都在
  });

  it('正例：发现比对——白名单声明的 ghost_tool 不在 server 实况 → warn 漂移不拦', async () => {
    const { warns } = await makeLiveServer();
    expect(warns.some(w => w.includes('ghost_tool') && w.includes('漂移'))).toBe(true);
  });

  it('反例：发端校验——required 缺失不发请求（INPUT_SCHEMA_MISMATCH，发现所得 schema 生效）', async () => {
    const { member } = await makeLiveServer();
    const r = await member.execute('search', {});   // query 必填缺失
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/INPUT_SCHEMA_MISMATCH.*必填缺失: query.*未发请求/);
  });

  it('反例：发端校验——类型不合不发请求', async () => {
    const { member } = await makeLiveServer();
    const r = await member.execute('search', { query: 'x', count: 'not-a-number' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/count.*类型不合/);
  });

  it('反例：server 报 isError → MCP_TOOL_ERROR 原始信息截断进错误（供 replan 消费——上游网关报文实测形态）', async () => {
    const { member } = await makeLiveServer();
    const r = await member.execute('boom', { q: 'x' });
    expect(r.success).toBe(false);
    const msg = String(r.result);
    expect(msg).toMatch(/MCP_TOOL_ERROR.*_headers/s);   // 原始报文头进错误
    expect(msg).toContain('截断');                        // 超长被截
    expect(msg.length).toBeLessThan(700);
  });

  it('反例：白名单外工具 → 拒（server 实况有也不放行——声明即启用边界）', async () => {
    const { member } = await makeLiveServer();
    const r = await member.execute('undeclared_tool', {});
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/不在 server 'fixture' 白名单/);
  });

  it('正例：list() = 注册白名单（ghost 也在——工具面由声明定义,server 实况不缩它）', async () => {
    const { member } = await makeLiveServer();
    expect(member.list().map(t => t.name).sort()).toEqual(['boom', 'ghost_tool', 'multi', 'multiboom', 'search']);   // multi 两件随 0006 fixture 扩
  });

  it('正例：close 幂等——未连接/已关闭调用不炸（run 终态收尽力而为）', async () => {
    const entry: ToolServerEntry = { name: 's', binding: { kind: 'mcp', transport: 'http', url: 'https://x' }, tools: [{ name: 't', requires_commit: false }] };
    const m = new McpBindingMember(entry);
    await expect(m.close()).resolves.toBeUndefined();
    await expect(m.close()).resolves.toBeUndefined();
  });

  // list() 第三级兜底（发现前/发现缺席）——连接是惰性的,list() 在首次 execute 前就被 LLM
  // 通道消费:零参声明工具此时无声明 schema 也无发现 schema,兜底必须自身合法
  // （裸 {} 经 OpenAI 门面端点 400 "got type null",设计 3.2 兜底条款）。// @v: anc-exec-mcp-binding
  it('正例：未连接时零参工具 list() 兜底=最小合法对象 schema,非裸 {}', () => {
    const entry: ToolServerEntry = { name: 's', binding: { kind: 'mcp', transport: 'http', url: 'https://x' }, tools: [{ name: 'zero_param_tool', requires_commit: false }] };
    const m = new McpBindingMember(entry);
    const def = m.list().find(t => t.name === 'zero_param_tool')!;
    expect(def.input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('反例：声明了 input_schema 的工具 list() 不被兜底覆盖（声明优先于发现与兜底）', () => {
    const declared = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    const entry: ToolServerEntry = { name: 's', binding: { kind: 'mcp', transport: 'http', url: 'https://x' }, tools: [{ name: 'declared_tool', requires_commit: false, input_schema: declared }] };
    const m = new McpBindingMember(entry);
    const def = m.list().find(t => t.name === 'declared_tool')!;
    expect(def.input_schema).toEqual(declared);
  });
});

// @v: anc-exec-mcp-binding
describe('连接失败语义', () => {
  it('反例：auth_env 未设置 → MCP_AUTH_MISSING 报变量名不报值', async () => {
    const entry: ToolServerEntry = {
      name: 'needs-key',
      binding: { kind: 'mcp', transport: 'http', url: 'https://example.invalid/mcp', auth_env: 'HOPJIT_TEST_NONEXISTENT_KEY' },
      tools: [{ name: 't', requires_commit: false }],
    };
    const m = new McpBindingMember(entry);
    const r = await m.execute('t', {});
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/MCP_CONNECT_FAILED.*HOPJIT_TEST_NONEXISTENT_KEY 未设置/);
  });

  it('反例：百炼"未开通"文案 → 错误附开通指路提示（实测故障形态识别）', async () => {
    const entry: ToolServerEntry = {
      name: 'bailian-x',
      binding: { kind: 'mcp', transport: 'http', url: 'https://example.invalid/mcp' },
      tools: [{ name: 't', requires_commit: false }],
    };
    const m = new McpBindingMember(entry);
    // 私有注入连接失败文案（模拟百炼 404 业务响应经 SDK 抛出）
    vi.spyOn(m as unknown as { ensureConnected: () => Promise<void> }, 'ensureConnected')
      .mockRejectedValue(new Error('HTTP 404: 未开通该MCP或非可用开通状态'));
    const r = await m.execute('t', {});
    expect(String(r.result)).toMatch(/MCP_CONNECT_FAILED.*未开通.*MCP 广场.*逐服务单独开通/s);
  });
});

// @v: anc-exec-mcp-binding —— stdio 传输分支（spawn/env 白名单——review 探针补:此前测试全走 http/InMemory,stdio 零覆盖）
describe('stdio 传输分支', () => {
  it('反例：command 不存在 → MCP_CONNECT_FAILED（spawn 失败面）', async () => {
    const entry: ToolServerEntry = {
      name: 'bad-cmd',
      binding: { kind: 'mcp', transport: 'stdio', command: '/nonexistent/hopjit-test-no-such-cmd' },
      tools: [{ name: 't', requires_commit: false }],
    };
    const m = new McpBindingMember(entry);
    const r = await m.execute('t', {});
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/MCP_CONNECT_FAILED/);
  });

  // @v: anc-exec-mcp-binding （失败即收尸,38轮review/hopdoc e2e实撞——server起来了但initialize
  // 不应答:connect超时抛错后不close即子进程泄漏持锁,一次失败滚成永久失败〔实录4个僵尸uv〕）
  it('反例：server 起来但 initialize 不应答 → 连接失败且子进程被收尸(不泄漏)', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'mcp-zombie-'));
    const pidFile = join(dir, 'server.pid');
    // 假 server:落 pid 后死读 stdin 永不应答——initialize 必超时;被 SIGTERM/管道关即退出
    const script = join(dir, 'dead-server.mjs');
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "process.stdin.resume();",   // 保持存活,永不写 stdout
    ].join('\n'));
    const entry: ToolServerEntry = {
      name: 'zombie',
      binding: { kind: 'mcp', transport: 'stdio', command: process.execPath, args: [script] },
      tools: [{ name: 't', requires_commit: false }],
    };
    const m = new McpBindingMember(entry);
    const r = await m.execute('t', {});
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/MCP_CONNECT_FAILED/);
    // 子进程已被收尸：pid 落过盘（server 真起过）,现在必须已死
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    await new Promise(res => setTimeout(res, 300));   // 收尸信号传递窗口
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  }, 90000);

  it('正例：env_passthrough 白名单——只透传声明的变量（不整包漏环境）', async () => {
    // 单行 stdio MCP server：initialize/initialized/tools/list/tools/call(回显环境变量在场性)
    const serverJs = [
      "const seen = { WANTED: process.env.HOPJIT_T_WANTED ?? null, SECRET: process.env.HOPJIT_T_SECRET ?? null };",
      "let buf = '';",
      "process.stdin.on('data', d => {",
      "  buf += d;",
      "  let i;",
      "  while ((i = buf.indexOf('\\n')) >= 0) {",
      "    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
      "    if (!line.trim()) continue;",
      "    let m; try { m = JSON.parse(line); } catch { continue; }",
      "    if (m.id === undefined) continue;",
      "    const reply = o => process.stdout.write(JSON.stringify(o) + '\\n');",
      "    if (m.method === 'initialize') reply({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 't', version: '0' } } });",
      "    else if (m.method === 'tools/list') reply({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'env_probe', inputSchema: { type: 'object' } }] } });",
      "    else if (m.method === 'tools/call') reply({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(seen) }] } });",
      "    else reply({ jsonrpc: '2.0', id: m.id, result: {} });",
      "  }",
      "});",
    ].join('\n');
    process.env['HOPJIT_T_WANTED'] = 'yes';
    process.env['HOPJIT_T_SECRET'] = 'leak-me-not';
    try {
      const entry: ToolServerEntry = {
        name: 'env-probe',
        binding: { kind: 'mcp', transport: 'stdio', command: process.execPath, args: ['-e', serverJs], env_passthrough: ['HOPJIT_T_WANTED'] },
        tools: [{ name: 'env_probe', requires_commit: false }],
      };
      const m = new McpBindingMember(entry);
      const r = await m.execute('env_probe', {});
      expect(r.success).toBe(true);
      const seen = JSON.parse(String(r.result));
      expect(seen.WANTED).toBe('yes');       // 白名单内透传
      expect(seen.SECRET).toBeNull();        // 白名单外不漏
      await m.close();
    } finally {
      delete process.env['HOPJIT_T_WANTED'];
      delete process.env['HOPJIT_T_SECRET'];
    }
  });
});

// @v: anc-exec-mcp-binding, anc-exec-tool-composite
describe('Composite × McpBinding 全链（unwrap+shape 在 Composite 层收口）', () => {
  it('正例：经 Composite 调 mcp 成员——json-in-text 解包+shape 校验+多余裁剪全链', async () => {
    const { member } = await makeLiveServer();
    const entry: ToolServerEntry = {
      name: 'fixture',
      binding: { kind: 'mcp', transport: 'http', url: 'https://unused.example/mcp' },
      tools: [{ name: 'search', requires_commit: false, output_schema: { pages: ['yaml'] }, unwrap: 'json-in-text' }],
    };
    const c = new CompositeToolProvider(HOST, { registry: [entry], externalProviderFor: () => member });
    const r = await c.execute('search', { query: 'HopSpec' });
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ pages: [{ title: '关于HopSpec', url: 'https://x' }] });   // request_id/status 被裁
  });

  // 0006 核心收益全链钉：多块 server + unwrap json-in-text——binding 取首块交上,
  // Composite 解包成功且留痕字段存活（audit spread 合并修复的端到端证明）。 // @v: anc-exec-mcp-binding
  it('正例：多 text 块 × unwrap 全链——首块解包成功,audit 三字段并存（留痕不被 server/duration 覆盖）', async () => {
    const { member } = await makeLiveServer();
    const entry: ToolServerEntry = {
      name: 'fixture',
      binding: { kind: 'mcp', transport: 'http', url: 'https://unused.example/mcp' },
      tools: [{ name: 'multi', requires_commit: false, output_schema: { pages: ['yaml'] }, unwrap: 'json-in-text' }],
    };
    const c = new CompositeToolProvider(HOST, { registry: [entry], externalProviderFor: () => member });
    const r = await c.execute('multi', { q: 'x' });
    expect(r.success).toBe(true);                                   // 修前:join 污染 parse 必炸 SCHEMA_DEVIATION
    expect(r.result).toEqual({ pages: [{ title: '首块' }] });
    expect(r.audit?.discarded_text_blocks).toBe(1);                 // binding 层留痕
    expect(r.audit?.server).toBe('fixture');                        // composite 层归属——spread 并存
    expect(typeof r.audit?.duration_ms).toBe('number');
  });

  it('正例：run 终态 Composite.close 传导到 mcp 成员', async () => {
    const { member } = await makeLiveServer();
    const closeSpy = vi.spyOn(member, 'close');
    const entry: ToolServerEntry = {
      name: 'fixture', binding: { kind: 'mcp', transport: 'http', url: 'https://x' },
      tools: [{ name: 'search', requires_commit: false }],
    };
    const c = new CompositeToolProvider(HOST, { registry: [entry], externalProviderFor: () => member });
    await c.close();
    expect(closeSpy).toHaveBeenCalled();
  });
});

// 终态闸（四十九审——close 后惰性重连 spawn 新进程且 run 已终态无人再收=复活泄漏;
// 共享 provider〔0021〕下被杀 worker 的末次工具调用可踩此竞态）
// @v: anc-exec-tool-server-lifecycle
describe('McpBindingMember 终态闸', () => {
  it('反例：close 后 execute → 拒绝重连（响亮 fail 不 spawn 新进程）', async () => {
    const { McpBindingMember } = await import('../src/tools-mcp-binding.js');
    const m = new McpBindingMember({
      name: 'gate-test',
      binding: { kind: 'mcp', transport: 'stdio', command: process.execPath, args: ['-e', 'setInterval(()=>{},1e6)'] },
      tools: [{ name: 't', requires_commit: false }],
    } as any);
    await m.close();
    const r = await m.execute('t', {});
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('终态');
    expect(String(r.result)).toContain('拒绝重连');
  });
});

// @v: anc-config-tool-registry, anc-exec-mcp-binding —— tool_servers 节经 mcp-server 全链（原 tools_file 指针 2026-08-13 退役收编统一配置）
//（review 缝隙:config→startRun→装配→body 调用此前零覆盖——批次一"接缝测试"教训同型预防）
describe('tool_servers 节经 standalone 全链（HopjitMcpCore）', () => {
  // 密闭化：startRun 每 run 重读 <cwd>/hopjit.yaml（0007/0012 契约）——仓库根常驻项目级配置后,
  // 本组假 provider 会被真配置搅局（CONFIG_INVALID/default_model 被覆盖）。HOPJIT_CONFIG 在场
  // 即跳过项目级重读（reloadProjectConfig 首行既有开关）,测试环境与开发者盘面解耦。
  beforeEach(() => { process.env['HOPJIT_CONFIG'] = '/hermetic/no-project-reload.yaml'; });
  afterEach(() => { delete process.env['HOPJIT_CONFIG']; });
  it('正例：config.tool_servers → startRun 装配含外部工具 → spec body 经 tool_id 调用到 completed', async () => {
    const { HopjitMcpCore } = await import('../src/mcp-server.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const dir = mkdtempSync(join(tmpdir(), 'mcp-chain-'));
    // 单行 stdio server（与 stdio 分支测试同款——回显固定 JSON）
    const serverLines = [
      "let buf = '';",
      "process.stdin.on('data', d => {",
      "  buf += d;",
      "  let i;",
      "  while ((i = buf.indexOf('\\n')) >= 0) {",
      "    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
      "    if (!line.trim()) continue;",
      "    let m; try { m = JSON.parse(line); } catch { continue; }",
      "    if (m.id === undefined) continue;",
      "    const reply = o => process.stdout.write(JSON.stringify(o) + '\\n');",
      "    if (m.method === 'initialize') reply({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 't', version: '0' } } });",
      "    else if (m.method === 'tools/list') reply({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: '知识检索', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }] } });",
      "    else if (m.method === 'tools/call') reply({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ hits: [{ t: '条目' }], extra: 1 }) }] } });",
      "    else reply({ jsonrpc: '2.0', id: m.id, result: {} });",
      "  }",
      "});",
    ].join('\n');
    const serverPath = join(dir, 'mini-server.js');
    writeFileSync(serverPath, serverLines);

    const toolsYaml = join(dir, 'hoptools.yaml');
    writeFileSync(toolsYaml, [
      'tool_servers:',
      '  - name: kb',
      '    binding: { kind: mcp, transport: stdio, command: ' + JSON.stringify(process.execPath) + ', args: [' + JSON.stringify(serverPath) + '] }',
      '    tools:',
      '      - name: 知识检索',
      '        tool_id: kb_search',
      '        requires_commit: false',
      '        output_schema: { hits: [yaml] }',
      '        unwrap: json-in-text',
    ].join('\n'));

    const specPath = join(dir, 'probe.md');
    writeFileSync(specPath, [
      '# Probe', 'Id: probe', '', '## Goal', '外部工具全链', '',
      '## Outputs', '- found: yaml  # 检索结果', '',
      '## Steps',
      '1. [act] 查知识库',
      '  + → found: yaml  # 结果',
      '  > 纯计算',
      '  > ```hop_python',
      '  > found = kb_search(q: "锚点")',
      '  > ```',
      '2. [exit] 交付',
    ].join('\n'));

    const core = new HopjitMcpCore({
      providers: [{ service_id: 'stub', protocol: 'anthropic', base_url: 'https://unused.invalid', model: 'x', api_key_env: 'HOPJIT_CHAIN_TEST_KEY' }],
      tool_servers: (await import('js-yaml')).load((await import('node:fs')).readFileSync(toolsYaml, 'utf-8'))['tool_servers'],
    });
    process.env['HOPJIT_CHAIN_TEST_KEY'] = 'test-key';
    try {
      const started = await core.startRun(specPath, undefined, join(dir, '.hopstate')) as { run_id?: string; error?: unknown };
      expect(started.error).toBeUndefined();
      // 轮询到终态（纯 body spec 零 LLM 调用——不会打 unused.invalid）
      let status = '';
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 50));
        const st = core.runStatus(started.run_id) as { status?: string; outputs?: Record<string, unknown> };
        status = String(st.status ?? '');
        if (status === 'completed' || status === 'failed') {
          if (status === 'completed') {
            expect(st.outputs?.['found']).toEqual({ hits: [{ t: '条目' }] });   // unwrap+shape+裁剪全链
          }
          break;
        }
      }
      expect(status).toBe('completed');
    } finally {
      delete process.env['HOPJIT_CHAIN_TEST_KEY'];
    }
  }, 15000);

  it('正例：in-process 扩展模块经 startRun 全链——真实隔离模块（examples/ext-tools）装载执行到 completed（作者令实测 2026-08-12）', async () => {
    const { HopjitMcpCore } = await import('../src/mcp-server.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'mcp-inproc-'));
    const modPath = resolve('examples/ext-tools/word-stats.mjs');   // 真参考例——住 examples/ 不在 src/
    writeFileSync(join(dir, 'tools.yaml'), [
      'tool_servers:', '  - name: word_stats_lib',
      `    binding: { kind: in-process, module: ${JSON.stringify(modPath)} }`,
      '    tools:', '      - name: word_stats', '        requires_commit: false',
      '        output_schema: { words: int, chars: int }',   // longest 会被裁——shape 框架对 in-process 同样生效
    ].join('\n'));
    writeFileSync(join(dir, 'p.md'), [
      '# P', 'Id: p', '## Goal', 'g', '## Outputs', '- stats: yaml  # 统计', '## Steps',
      '1. [act] 统计', '  + → stats: yaml  # 统计', '  > 纯计算', '  > ```hop_python',
      '  > stats = word_stats(text: "hello brave new world")', '  > ```', '2. [exit] 完',
    ].join('\n'));
    process.env['HOPJIT_CHAIN_TEST_KEY'] = 'k';
    try {
      const core = new HopjitMcpCore({
        providers: [{ service_id: 'stub', protocol: 'anthropic', base_url: 'https://unused.invalid', model: 'x', api_key_env: 'HOPJIT_CHAIN_TEST_KEY' }],
        tool_servers: (await import('js-yaml')).load((await import('node:fs')).readFileSync(join(dir, 'tools.yaml'), 'utf-8'))['tool_servers'],
      });
      const started = await core.startRun(join(dir, 'p.md'), undefined, join(dir, '.hopstate')) as { run_id?: string; error?: unknown };
      expect(started.error).toBeUndefined();
      let st: { status?: string; outputs?: Record<string, unknown> } = {};
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 50));
        st = await core.runStatus(started.run_id) as typeof st;
        if (st.status === 'completed' || st.status === 'failed') break;
      }
      expect(st.status).toBe('completed');
      expect(st.outputs?.['stats']).toEqual({ words: 4, chars: 21 });   // longest 被 shape 裁剪
    } finally {
      delete process.env['HOPJIT_CHAIN_TEST_KEY'];
    }
  }, 15000);

  it('反例：tool_servers 节损坏 → startRun 返回结构化 error 不裸抛（server 不崩,CC/Codex 侧拿到 code+message）', async () => {
    const { HopjitMcpCore } = await import('../src/mcp-server.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'mcp-badtools-'));
    writeFileSync(join(dir, 'p.md'), '# P\nId: p\n## Goal\ng\n## Steps\n1. [exit] 完');
    process.env['HOPJIT_CHAIN_TEST_KEY'] = 'k';
    try {
      const core = new HopjitMcpCore({
        providers: [{ service_id: 'stub', protocol: 'anthropic', base_url: 'https://unused.invalid', model: 'x', api_key_env: 'HOPJIT_CHAIN_TEST_KEY' }],
        tool_servers: [{ name: 'bad', binding: { kind: 'mcp', transport: 'stdio', command: '/bin/cat' }, tools: [{ name: 't' }] }],   // 缺 requires_commit=文法违例
      });
      const r = await core.startRun(join(dir, 'p.md'), undefined, join(dir, '.hopstate')) as { error?: { code?: string; message?: string } };
      expect(r.error?.code).toBe('TOOLS_FILE_INVALID');
      expect(r.error?.message).toContain('requires_commit');
    } finally {
      delete process.env['HOPJIT_CHAIN_TEST_KEY'];
    }
  });
});

// @v: anc-exec-mcp-binding, anc-obs-audit —— 单调用超时硬闸 + 审计元信息（五点需求⑤收尾 2026-08-12）
describe('单调用超时与审计元信息', () => {
  it('反例：外部 call 挂死 → MCP_CALL_TIMEOUT（不吊死步骤——硬闸放弃并报超时值）', async () => {
    // 单文件 stdio server:initialize/tools/list 正常应答,tools/call 永不回（挂死形态）
    const hangLines = [
      "let buf = '';",
      "process.stdin.on('data', d => {",
      "  buf += d;",
      "  let i;",
      "  while ((i = buf.indexOf('\\n')) >= 0) {",
      "    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
      "    if (!line.trim()) continue;",
      "    let m; try { m = JSON.parse(line); } catch { continue; }",
      "    if (m.id === undefined) continue;",
      "    const reply = o => process.stdout.write(JSON.stringify(o) + '\\n');",
      "    if (m.method === 'initialize') reply({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hang', version: '0' } } });",
      "    else if (m.method === 'tools/list') reply({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'slow', inputSchema: { type: 'object' } }] } });",
      "    // tools/call: 故意不回——挂死",
      "  }",
      "});",
    ].join('\n');
    const entry: ToolServerEntry = {
      name: 'hang-server',
      binding: { kind: 'mcp', transport: 'stdio', command: process.execPath, args: ['-e', hangLines] },
      tools: [{ name: 'slow', requires_commit: false }],
      call_timeout_ms: 300,
    };
    const m = new McpBindingMember(entry);
    const r = await m.execute('slow', {});
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/MCP_CALL_TIMEOUT.*hang-server.*300ms/s);
    await m.close();
  }, 10000);

  it('反例：server 业务错误文本含 timeout 字样 → MCP_TOOL_ERROR 不误归超时（判定按 McpError.code——review 探针抓文本匹配误伤）', async () => {
    const server = new McpServer({ name: 'timeout-word-server', version: '1.0.0' });
    server.tool('flaky', { q: z.string() }, async () => ({
      isError: true,
      content: [{ type: 'text', text: 'upstream gateway timeout: backend read timed out' }],   // 业务错误恰含超时字样
    }));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const entry: ToolServerEntry = {
      name: 'tw', binding: { kind: 'mcp', transport: 'http', url: 'https://unused.example/mcp' },
      tools: [{ name: 'flaky', requires_commit: false }],
    };
    const m = new McpBindingMember(entry);
    const client = new Client({ name: 't', version: '0.0.0' });
    await client.connect(clientT);
    (m as unknown as { client: Client }).client = client;
    const r = await m.execute('flaky', { q: 'x' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/^MCP_TOOL_ERROR/);         // isError 路径,非超时
    expect(String(r.result)).not.toContain('MCP_CALL_TIMEOUT');
  });

  it('正例：shape 偏差失败仍带 audit 元信息（失败记账恰恰最需要 server 归属）', async () => {
    const { member } = await makeLiveServer();
    const entry: ToolServerEntry = {
      name: 'fixture', binding: { kind: 'mcp', transport: 'http', url: 'https://unused.example/mcp' },
      tools: [{ name: 'search', requires_commit: false, output_schema: { nonexistent_field: ['yaml'] }, unwrap: 'json-in-text' }],
    };
    const c = new CompositeToolProvider(HOST, { registry: [entry], externalProviderFor: () => member });
    const r = await c.execute('search', { query: 'x' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('SCHEMA_DEVIATION');
    expect(r.audit?.server).toBe('fixture');                     // 修复前偏差路径丢归属
  });

  it('正例：经 Composite 调 mcp 成员 → 结果带 audit 元信息（server 归属+耗时,HopLog tool: 块消费源）', async () => {
    const { member } = await makeLiveServer();
    const entry: ToolServerEntry = {
      name: 'fixture', binding: { kind: 'mcp', transport: 'http', url: 'https://unused.example/mcp' },
      tools: [{ name: 'search', requires_commit: false, output_schema: { pages: ['yaml'] }, unwrap: 'json-in-text' }],
    };
    const c = new CompositeToolProvider(HOST, { registry: [entry], externalProviderFor: () => member });
    const r = await c.execute('search', { query: 'x' });
    expect(r.success).toBe(true);
    expect(r.audit?.server).toBe('fixture');
    expect(typeof r.audit?.duration_ms).toBe('number');
  });

  it('正例：内置工具不带 audit（server 归属只属外部——内置进程内无延迟归属议题）', async () => {
    const c = new CompositeToolProvider(HOST);
    const r = await c.execute('list_files', { path: '.' });
    expect(r.audit).toBeUndefined();
  });
});

// @v: anc-exec-inprocess-binding —— 隔离模块绑定成员判据（实装 2026-08-12,真参考例 examples/ext-tools）
describe('InProcessBinding（真实隔离模块）', () => {
  const MOD = pathResolve('examples/ext-tools/word-stats.mjs');
  function entryFor(tools: ToolServerEntry['tools']): ToolServerEntry {
    return { name: 'word_stats_lib', binding: { kind: 'in-process', module: MOD }, tools };
  }

  it('正例：装载执行——真模块 execute 结果回流', async () => {
    const { InProcessBindingMember } = await import('../src/tools-inprocess-binding.js');
    const m = new InProcessBindingMember(entryFor([{ name: 'word_stats', requires_commit: false }]));
    const r = await m.execute('word_stats', { text: 'a bb ccc' });
    expect(r.success).toBe(true);
    expect((r.result as Record<string, unknown>)['words']).toBe(3);
    await m.close();
  });

  // list() 兜底与 mcp-binding 同款（in-process 无发现源,零参声明只剩兜底一级）// @v: anc-exec-inprocess-binding
  it('正例：零参声明工具 list() 兜底=最小合法对象 schema,非裸 {}', async () => {
    const { InProcessBindingMember } = await import('../src/tools-inprocess-binding.js');
    const m = new InProcessBindingMember(entryFor([{ name: 'boom', requires_commit: false }]));
    const def = m.list().find(t => t.name === 'boom')!;
    expect(def.input_schema).toEqual({ type: 'object', properties: {} });
    await m.close();
  });

  it('反例：模块抛异常 → EXT_TOOL_ERROR 该次 fail,引擎进程存活（崩溃面判据③——失去进程隔离的代价边界:同步异常罩得住）', async () => {
    const { InProcessBindingMember } = await import('../src/tools-inprocess-binding.js');
    const m = new InProcessBindingMember(entryFor([{ name: 'boom', requires_commit: false }]));
    const r = await m.execute('boom', {});
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/EXT_TOOL_ERROR.*模块内部异常/s);
    const r2 = await m.execute('boom', {});   // 进程存活,可继续调用
    expect(r2.success).toBe(false);
  });

  it('反例：module 路径不存在 → EXT_MODULE_LOAD_FAILED 带路径（装载失败=该次调用 fail 不炸装配期）', async () => {
    const { InProcessBindingMember } = await import('../src/tools-inprocess-binding.js');
    const m = new InProcessBindingMember({ name: 'ghost', binding: { kind: 'in-process', module: '/nonexistent/ghost-tools.mjs' }, tools: [{ name: 't', requires_commit: false }] });
    const r = await m.execute('t', {});
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/EXT_MODULE_LOAD_FAILED.*ghost-tools/s);
  });

  it('反例：模块缺 execute 导出 → EXT_MODULE_LOAD_FAILED 指路接口契约', async () => {
    const { InProcessBindingMember } = await import('../src/tools-inprocess-binding.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'ext-noexec-'));
    const bad = join(dir, 'bad.mjs');
    writeFileSync(bad, 'export const x = 1;\n');
    const m = new InProcessBindingMember({ name: 'bad', binding: { kind: 'in-process', module: bad }, tools: [{ name: 't', requires_commit: false }] });
    const r = await m.execute('t', {});
    expect(String(r.result)).toMatch(/缺 execute 命名导出.*anc-exec-inprocess-binding/s);
  });

  it('反例：声明 input_schema 后实参必填缺失 → INPUT_SCHEMA_MISMATCH 未调用模块（发端校验与 mcp 同构——review 抓 in-process 声明零消费）', async () => {
    const { InProcessBindingMember } = await import('../src/tools-inprocess-binding.js');
    const m = new InProcessBindingMember({
      name: 'word_stats_lib', binding: { kind: 'in-process', module: MOD },
      tools: [{ name: 'word_stats', requires_commit: false,
                input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
    });
    const r = await m.execute('word_stats', {});   // text 必填缺失
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/INPUT_SCHEMA_MISMATCH.*必填缺失: text.*未调用模块/s);
  });

  it('正例：无 input_schema 声明 → 发端放行直达模块（in-process 无发现源,不声明=放行）', async () => {
    const { InProcessBindingMember } = await import('../src/tools-inprocess-binding.js');
    const m = new InProcessBindingMember(entryFor([{ name: 'word_stats', requires_commit: false }]));
    const r = await m.execute('word_stats', {});   // 模块自己兜 text 缺省
    expect(r.success).toBe(true);
  });

  it('反例：白名单外工具 → 拒（模块实况不扩权——与 mcp 成员同构）', async () => {
    const { InProcessBindingMember } = await import('../src/tools-inprocess-binding.js');
    const m = new InProcessBindingMember(entryFor([{ name: 'word_stats', requires_commit: false }]));
    const r = await m.execute('boom', {});   // 模块里有 boom,但白名单没声明
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/不在模块 'word_stats_lib' 白名单/);
  });

  it('正例：经 Composite——audit 元信息照记（server 归属对 in-process 同样成立）', async () => {
    const c = new CompositeToolProvider(HOST, { registry: [entryFor([{ name: 'word_stats', requires_commit: false }])] });
    const r = await c.execute('word_stats', { text: 'x y' });
    expect(r.success).toBe(true);
    expect(r.audit?.server).toBe('word_stats_lib');
  });
});
