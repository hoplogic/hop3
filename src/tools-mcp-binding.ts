// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: tools ^anc-struct-tools
// McpBinding——mcp 绑定成员：MCP client 最小子集（initialize+tools/call，会话流 SDK 自动），
// 惰性连接、发现比对与 schema 补全、发端校验、run 终态三段收。
// 见 design/tool-interface.md ^anc-exec-mcp-binding。

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpError, ErrorCode as McpErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolProvider, ToolResult, ToolDef } from './provider-types.js';
import type { ToolServerEntry } from './tools-registry.js';

const ERROR_SAMPLE_LIMIT = 500;

/** mcp 绑定成员：ToolServerEntry → ToolProvider（Composite 的 externalProviderFor 消费）。
 * 惰性连接：首次 execute 时 connect+发现——失败=该次调用 fail 不重试（下次调用再试即自然重连）。
 * 生命周期五阶段（注册/惰性连接/调用/终态收/崩溃面）见 [[tool-interface#^anc-exec-tool-server-lifecycle]]。
 * 见 [[tool-interface#^anc-exec-mcp-binding]]。 // @a: anc-exec-mcp-binding, anc-exec-tool-server-lifecycle */
export class McpBindingMember implements ToolProvider {
  private client: Client | null = null;
  private closed = false;   // 终态闸（四十九审——close 后惰性重连会 spawn 新进程且 run 已终态无人再收=复活泄漏;共享 provider 下被杀 worker 的末次工具调用可踩此竞态）// @a: anc-exec-tool-server-lifecycle
  private discovered = new Map<string, { inputSchema?: Record<string, unknown> }>();
  private warnSink?: (msg: string) => void;

  constructor(private entry: ToolServerEntry, options?: { warn?: (msg: string) => void }) {
    this.warnSink = options?.warn;
  }

  /** 工具面 = 注册白名单（声明即启用——server 实况不扩权）。 */
  list(): ToolDef[] {
    return this.entry.tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      // 兜底=最小合法对象 schema（发现是惰性的,list() 可先于首次 connect 被 LLM 通道消费——
      // 裸 {} 经 OpenAI 门面端点 400"got type null",设计 3.2 兜底条款）。// @a: anc-exec-mcp-binding
      input_schema: t.input_schema ?? this.discovered.get(t.name)?.inputSchema ?? { type: 'object', properties: {} },
      requires_commit: t.requires_commit,
    }));
  }

  async execute(tool_name: string, tool_args: Record<string, unknown>): Promise<ToolResult> {
    const spec = this.entry.tools.find(t => t.name === tool_name);
    if (!spec) return { result: `Unknown tool: ${tool_name}（不在 server '${this.entry.name}' 白名单）`, success: false, content_type: 'text' };

    // 惰性连接+发现（首次调用；失败=本次 fail，错误带原始信息供 replan 消费——作者定严格解析）
    if (this.closed) {
      return { result: `TOOL_EXEC_ERROR: server '${this.entry.name}' 已随 run 终态关停——终态后调用拒绝重连（防复活泄漏;此调用多半来自被杀 worker 的收尾,结果本会被丢弃）`, success: false, content_type: 'text' };
    }
    try {
      await this.ensureConnected();
    } catch (err: unknown) {
      return connectFailure(this.entry.name, err);
    }

    // 发端校验：args vs input_schema（声明优先，发现补全）——required 缺失/类型不合=fail 不发
    // @a: anc-exec-mcp-binding, anc-exec-tool-shape-check
    const schema = spec.input_schema ?? this.discovered.get(tool_name)?.inputSchema;
    if (schema) {
      const problem = checkArgsShallow(schema, tool_args);
      if (problem) {
        return { result: `INPUT_SCHEMA_MISMATCH: 工具 "${tool_name}" 实参不合 input_schema——${problem}（未发请求）`, success: false, content_type: 'text' };
      }
    }

    const timeoutMs = this.entry.call_timeout_ms ?? 60_000;
    const started = Date.now();
    try {
      // 单调用超时硬闸（design HopSop 第 2 步）：SDK requestTimeout——挂死的外部 call 不吊死步骤
      const resp = await this.client!.callTool({ name: tool_name, arguments: tool_args }, undefined, { timeout: timeoutMs });
      const content = Array.isArray(resp.content) ? resp.content : [];
      const textBlocks = content.filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text');
      if (resp.isError) {
        // 错误面同样 untyped（实测:上游网关原始报文可整段塞进 text）——截断进错误，原始信息供 replan。
        // 错误文本仍 join 全部块（多块拼接是排查信息增益,无解析语义——0006 例外条款）
        const errText2 = textBlocks.map(b => b.text).join('\n');
        return { result: `MCP_TOOL_ERROR: server '${this.entry.name}' 工具 "${tool_name}" 报错——${truncate(errText2 || '(空错误文本)', ERROR_SAMPLE_LIMIT)}`, success: false, content_type: 'text' };
      }
      // 多 text 块=取首块（0006——设计/教程双文字'首块',原 join 破坏 unwrap json-in-text:
      // 首块合法 JSON 被次块说明污染 parse 必炸误入 SCHEMA_DEVIATION）;丢弃留痕入 audit
      const text = textBlocks[0]?.text ?? '';
      const discarded = Math.max(0, textBlocks.length - 1);
      return {
        result: text, success: true, content_type: 'text',   // unwrap/shape 校验在 Composite 层
        ...(discarded > 0 ? { audit: { discarded_text_blocks: discarded } } : {}),
      };
    } catch (err: unknown) {
      const raw = errText(err);
      // 超时判定按 McpError.code（RequestTimeout=-32001）,不按错误文本——server 业务错误
      // 含 'timeout' 字样会被文本匹配误归超时（review 探针抓 2026-08-12）
      if (err instanceof McpError && err.code === McpErrorCode.RequestTimeout) {
        return { result: `MCP_CALL_TIMEOUT: server '${this.entry.name}' 工具 "${tool_name}" 超过单调用硬闸 ${timeoutMs}ms（${Date.now() - started}ms 后放弃）——外部 server 无响应`, success: false, content_type: 'text' };
      }
      return { result: `MCP_CALL_FAILED: server '${this.entry.name}' 调用 "${tool_name}" 失败——${truncate(raw, ERROR_SAMPLE_LIMIT)}`, success: false, content_type: 'text' };
    }
  }

  /** 审计归属：本成员的 server 逻辑名（Composite 组装 ToolCallRecord 的 server 字段源）。 */
  get serverName(): string { return this.entry.name; }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    const b = this.entry.binding;
    const client = new Client({ name: 'hopjit', version: '0.0.0' });
    try {
      await this.doConnect(client, b);
    } catch (err) {
      // 失败即收尸（hopdoc e2e 实撞 2026-08-26——stdio connect 已 spawn 子进程,initialize
      // 超时抛错后不 close 即泄漏:僵尸 server 存活持锁〔实录 4 个 uv 中间层占 .venv/.lock,
      // 后续连接全排队超时,一次失败滚成永久失败〕。close 尽力而为,主报文仍是连接失败）。
      // @a: anc-exec-mcp-binding
      try { await client.close(); } catch { /* 收尸失败不遮主因 */ }
      throw err;
    }
    this.client = client;
    await this.discover(client);
  }

  private async doConnect(client: Client, b: import('./tools-registry.js').ToolServerEntry['binding']): Promise<void> {
    if (b.transport === 'http') {
      const headers: Record<string, string> = {};
      if (b.auth_env) {
        const key = process.env[b.auth_env];
        if (!key || !key.trim()) throw new Error(`MCP_AUTH_MISSING: 环境变量 ${b.auth_env} 未设置（server '${this.entry.name}'）`);
        headers['Authorization'] = `Bearer ${key}`;   // 凭证只在内存，构造显式传入
      }
      await client.connect(new StreamableHTTPClientTransport(new URL(b.url!), { requestInit: { headers } }));
    } else {
      const env: Record<string, string> = {};
      for (const name of b.env_passthrough ?? []) {   // 白名单透传——不整包漏环境（含各家 key）
        if (process.env[name] !== undefined) env[name] = process.env[name]!;
      }
      if (b.auth_env && process.env[b.auth_env] !== undefined) env[b.auth_env] = process.env[b.auth_env]!;
      await client.connect(new StdioClientTransport({ command: b.command!, args: b.args ?? [], env }));
    }
  }

  /** 发现比对：白名单内工具缺席于 server 实况 → warn 不拦（声明与实况漂移，调用时自然 fail）;
   * 声明无 input_schema 的从发现补全（发端校验 schema 源）。// @a: anc-exec-mcp-binding */
  private async discover(client: Client): Promise<void> {
    try {
      const listed = await client.listTools();
      for (const t of listed.tools ?? []) {
        this.discovered.set(t.name, { inputSchema: t.inputSchema as Record<string, unknown> | undefined });
      }
      for (const declared of this.entry.tools) {
        if (!this.discovered.has(declared.name)) {
          this.warnSink?.(`工具声明漂移: "${declared.name}" 在 tool_servers 白名单但 server '${this.entry.name}' 实况未提供`);
        }
      }
    } catch {
      // tools/list 失败不拦（发现是比对与补全用途，非授权前提——最小子集哲学）
      this.warnSink?.(`server '${this.entry.name}' tools/list 失败——跳过发现比对（调用面不受影响）`);
    }
  }

  /** run 终态收：stdio 三段礼貌关停（close→SIGTERM→SIGKILL 由 SDK transport close 承载首段）；
   * http 断连即可。收割失败只 warn 不拦终态（清理尽力而为）。 // @a: anc-exec-mcp-binding */
  async close(): Promise<void> {
    this.closed = true;   // 先置闸再关——闸与关停之间的新调用也被拒
    if (!this.client) return;
    try {
      await this.client.close();
    } catch (err: unknown) {
      this.warnSink?.(`server '${this.entry.name}' 关停异常（run 已终态,清理尽力而为）: ${errText(err).slice(0, 120)}`);
    } finally {
      this.client = null;
    }
  }
}

// JSON Schema 浅检：required 在场 + properties 声明的类型相符（声明写多深查多深——
// 不做 $ref/组合子，外部 schema 常残缺，过度实现校验器反而拒真）。返回 null=通过。
// @a: anc-exec-mcp-binding
export function checkArgsShallow(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const required = Array.isArray(schema['required']) ? schema['required'] as string[] : [];
  const missing = required.filter(k => !(k in args) || args[k] === undefined || args[k] === null);
  if (missing.length > 0) return `必填缺失: ${missing.join(', ')}`;
  const props = (schema['properties'] ?? {}) as Record<string, { type?: string }>;
  for (const [k, v] of Object.entries(args)) {
    const declared = props[k]?.type;
    if (!declared) continue;
    const actual = Array.isArray(v) ? 'array' : typeof v;
    const ok = declared === actual
      || (declared === 'integer' && typeof v === 'number' && Number.isInteger(v))
      || (declared === 'number' && typeof v === 'number')
      || (declared === 'object' && actual === 'object');
    if (!ok) return `字段 "${k}" 类型不合: 声明 ${declared}, 实际 ${actual}`;
  }
  return null;
}

function connectFailure(server: string, err: unknown): ToolResult {
  const raw = truncate(errText(err), ERROR_SAMPLE_LIMIT);
  // 百炼"未开通"形态识别指路（实测:404+中文业务文案非 JSON-RPC）
  const hint = /未开通|开通中/.test(raw) ? '——提示: 检查百炼 MCP 广场该服务的开通状态（逐服务单独开通）' : '';
  return { result: `MCP_CONNECT_FAILED: server '${server}' 连接失败——${raw}${hint}`, success: false, content_type: 'text' };
}

function errText(err: unknown): string { return err instanceof Error ? err.message : String(err); }
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + `…[截断,原长${s.length}]` : s; }
