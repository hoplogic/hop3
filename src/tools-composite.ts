// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: tools ^anc-struct-tools
// CompositeToolProvider——工具装配器：内置组+外部注册+宿主注入并入成员，按名路由，
// 同名 fail-fast，双端校验包住成员真实调用。见 design/tool-interface.md ^anc-exec-tool-composite。

import type { ToolProvider, ToolResult, ToolDef, HostConfig } from './provider-types.js';
import type { ToolSpec, ToolServerEntry } from './tools-registry.js';
import { DefaultToolProvider } from './tools.js';
import { McpBindingMember } from './tools-mcp-binding.js';
import { InProcessBindingMember } from './tools-inprocess-binding.js';
import { NotifyToolProvider } from './tools-notify.js';

/** 成员：一个 ToolProvider + 其工具的声明面（ToolSpec 按名索引——shape/unwrap/tool_id 消费源）。 */
interface Member {
  label: string;                       // 来源标签（错误与 HopLog 记账用：builtin-file / server:<name> / host-injected）
  provider: ToolProvider;
  specs: Map<string, ToolSpec>;        // wire name → spec（内置组与宿主注入无声明条目=空表）
}

/** CompositeToolProvider：按名路由到成员；list()=并集；同名冲突装配期 fail-fast。
 * 双端校验（输入 schema 拦发/输出 shape 偏差入升级链/多余裁剪/unwrap 解包）见
 * [[tool-interface#^anc-exec-tool-shape-check]]。 // @a: anc-exec-tool-composite */
/** 引擎直执面工厂构造体——单一权威（0076 阅卷抓三份同构副本〔cli/mcp-server/测试各抄一份
 * 读 yaml+构造闭包〕是漂移温床后归一:组合根与测试同 import 本函数,测试真锁生产件）。
 * 语义:构造 CompositeToolProvider 前经 loadRegistry 现读注册表（缺省=进程 cwd 的 hopjit.yaml
 * tool_servers 节,经 parseToolServers 同链解析;无文件/无节 undefined 即纯内置面）——每进程
 * 装配期现读,与模型路由每 run 重读同款;解析/撞名错误任其抛出,由消化路径 catch 折步骤 fail
 * （^anc-exec-tool-request 注册件装配条款③）。 */
// @a: anc-exec-tool-request
export function makeEngineToolProviderFactory(
  loadRegistry: () => ToolServerEntry[] | undefined,
): (hostConfig: HostConfig) => ToolProvider {
  return (hc: HostConfig) => {
    const reg = loadRegistry();
    return new CompositeToolProvider(reg ? ({ ...hc, tool_registry: reg } as HostConfig) : hc);
  };
}

/** 组合工具执行体——内置成员表（builtin-file/builtin-notify）∪ 外部注册件（hostConfig.tool_registry,
 * hopjit.yaml tool_servers 解析产物:mcp/in-process 两 binding）统一装配与按名路由;同名 fail-fast
 * （TOOLS_NAME_CONFLICT——同名=配置错误不做覆盖）。（本注释 2026-09-06 review 抓 0076 批插工厂函数
 * 把原 docstring 顶开后补回。） */
export class CompositeToolProvider implements ToolProvider {
  private members: Member[] = [];
  private routeByName = new Map<string, Member>();    // wire name → member
  private toolIdToName = new Map<string, string>();   // tool_id（语言面标识符）→ wire name
  private warnSink?: (msg: string) => void;
  private bareWarned = new Set<string>();             // 裸奔 warn 每工具一次（不逐调用刷屏）

  constructor(hostConfig: HostConfig, options?: { registry?: ToolServerEntry[]; externalProviderFor?: (entry: ToolServerEntry) => ToolProvider; warn?: (msg: string) => void }) {
    this.warnSink = options?.warn;
    // ① 内置成员表遍历装配（^anc-exec-builtin-member-table,2026-08-31 随 dingtalk-notify 改造
    // ——原硬编码单成员 builtin-file 改表驱动:新增内置通道=表里添一行,构造器零改动。内置不是
    // 特权成员:判重/路由/双端校验/write_scope/requires_commit 与其它成员零特殊分支。
    // notify 的 tool_id 渠道中立映射经 specs 表承载——spec 恒用 notify,换渠道只改表项）
    // @a: anc-exec-builtin-member-table
    const BUILTIN_MEMBERS: Member[] = [
      { label: 'builtin-file', provider: new DefaultToolProvider(hostConfig), specs: new Map() },
      { label: 'builtin-notify', provider: new NotifyToolProvider(), specs: new Map([
        ['dingtalk_notify', { name: 'dingtalk_notify', tool_id: 'notify', requires_commit: true }],
      ]) },
    ];
    for (const m of BUILTIN_MEMBERS) this.addMember(m);
    // ② 外部注册：options.registry 显式传入 > hostConfig.tool_registry（tool_servers 节加载产物经
    // 宿主契约贯穿）;缺省 McpBindingMember,externalProviderFor 注入口保留（测试替身）
    const registry = options?.registry ?? (hostConfig.tool_registry as ToolServerEntry[] | undefined);
    for (const entry of registry ?? []) {
      const provider = options?.externalProviderFor?.(entry)
        ?? (entry.binding.kind === 'in-process'
          ? new InProcessBindingMember(entry)   // 隔离模块装载 // @a: anc-exec-inprocess-binding
          : new McpBindingMember(entry, options?.warn ? { warn: options.warn } : {}));
      this.addMember({ label: `server:${entry.name}`, provider, specs: new Map(entry.tools.map(t => [t.name, t])) });
    }
    // ③ 宿主 programmatic 注入：并入成员（原"整体替换"语义废——tool-interface ^anc-exec-tool-composite）
    if (hostConfig.tool_provider) {
      this.addMember({ label: 'host-injected', provider: hostConfig.tool_provider, specs: new Map() });
    }
  }

  // 装配期名字检查：wire name 与 tool_id 合并判重——冲突=配置错误 fail-fast // @a: anc-exec-tool-composite
  private addMember(m: Member): void {
    for (const def of m.provider.list()) {
      const clash = this.routeByName.get(def.name);
      if (clash) throw new Error(`TOOLS_NAME_CONFLICT: 工具名 "${def.name}" 冲突（${clash.label} vs ${m.label}）——同名=配置错误，不做覆盖`);
      if (this.toolIdToName.has(def.name)) throw new Error(`TOOLS_NAME_CONFLICT: 工具名 "${def.name}"（${m.label}）与既有 tool_id 冲突`);
      this.routeByName.set(def.name, m);
      const spec = m.specs.get(def.name);
      if (spec?.tool_id) {
        if (this.routeByName.has(spec.tool_id) || this.toolIdToName.has(spec.tool_id)) {
          throw new Error(`TOOLS_NAME_CONFLICT: tool_id "${spec.tool_id}"（工具 "${def.name}"，${m.label}）与既有名冲突`);
        }
        this.toolIdToName.set(spec.tool_id, def.name);
      }
    }
    this.members.push(m);
  }

  list(): ToolDef[] {
    return this.members.flatMap(m => m.provider.list().flatMap(def => {
      const spec = m.specs.get(def.name);
      const base = { ...def, ...(spec ? { requires_commit: spec.requires_commit } : {}) };
      // tool_id 独立成清单条目（body 解释器按 list() 名单查名与 requires_commit 拦截——不进
      // 清单则中文名工具经语言面 ID 调用被判未知工具,review 探针实撞 2026-08-12）。同 requires_commit。
      return spec?.tool_id ? [base, { ...base, name: spec.tool_id, description: `${base.description}（tool_id→${def.name}）` }] : [base];
    }));
  }

  /** run 终态收：逐成员 close（仅 mcp 成员有实义——tool-interface ^anc-exec-mcp-binding 三段收）。
   * 清理尽力而为，失败不抛（run 已终态）。 // @a: anc-exec-mcp-binding */
  async close(): Promise<void> {
    for (const m of this.members) {
      const c = (m.provider as { close?: () => Promise<void> }).close;
      if (typeof c === 'function') await c.call(m.provider);
    }
  }

  async execute(tool_name: string, tool_args: Record<string, unknown>, write_scope?: import('./provider-types.js').WriteScope): Promise<ToolResult> {
    const wireName = this.toolIdToName.get(tool_name) ?? tool_name;
    const member = this.routeByName.get(wireName);
    if (!member) return { result: `Unknown tool: ${tool_name}`, success: false, content_type: 'text' };
    const spec = member.specs.get(wireName);

    const started = Date.now();
    // write_scope 原样透传成员（内置组消费写侧分域;外部/宿主成员签名无第三参自然忽略）
    const raw = await member.provider.execute(wireName, tool_args, write_scope);
    // 审计元信息：外部 server 成员记归属+耗时（HopLog tool: 块消费——五点需求⑤;内置/宿主注入不记 server）
    // @a: anc-obs-audit
    if (member.label.startsWith('server:')) {
      raw.audit = { ...(raw.audit ?? {}), server: member.label.slice('server:'.length), duration_ms: Date.now() - started };   // 保留 binding 层已填字段（0006 discarded_text_blocks 留痕不被覆盖）
    }
    if (!raw.success || !spec) return raw;   // 失败原样上抛（走既有步骤 fail）；无声明成员直通

    // unwrap: json-in-text——text 结果解 JSON；解析失败=偏差（同 shape 缺字段语义）
    // @a: anc-exec-tool-shape-check
    let value: unknown = raw.result;
    if (spec.unwrap === 'json-in-text') {
      try {
        value = JSON.parse(typeof raw.result === 'string' ? raw.result : JSON.stringify(raw.result));
      } catch {
        return schemaDeviation(spec, raw.result, 'unwrap json-in-text 解析失败（非合法 JSON）', raw.audit);
      }
    }
    // output_schema 校验：无声明放行+warn 留痕（declared-or-flagged——不存在既不核也不记的第三态；
    // 每工具一次不逐调用刷屏。builtin/宿主注入无 spec 条目不算裸奔——wire 面才有形状漂移议题）
    if (!spec.output_schema) {
      if (!this.bareWarned.has(spec.name)) {
        this.bareWarned.add(spec.name);
        this.warnSink?.(`工具 "${spec.name}"（${member.label}）无 output_schema 声明——结果未经形状核对进变量空间（裸奔留痕,建议补声明）`);
      }
      return { result: asResult(value), success: true, content_type: 'json', ...(raw.audit ? { audit: raw.audit } : {}) };
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return schemaDeviation(spec, value, `期望对象形状，实际 ${Array.isArray(value) ? 'array' : typeof value}`, raw.audit);
    }
    const obj = value as Record<string, unknown>;
    const missing = Object.keys(spec.output_schema).filter(k => !(k in obj));
    if (missing.length > 0) {
      return schemaDeviation(spec, value, `缺字段: ${missing.join(', ')}`, raw.audit);
    }
    // 顶层值类型核对（^anc-type-output-schema-syntax 校验分级 v1 第二级;深层显式不做）
    for (const [k, declared] of Object.entries(spec.output_schema)) {
      const problem = checkSchemaType(declared, obj[k]);
      if (problem) return schemaDeviation(spec, value, `字段 "${k}" ${problem}`, raw.audit);
    }
    const trimmed: Record<string, unknown> = {};
    for (const k of Object.keys(spec.output_schema)) trimmed[k] = obj[k];   // 多余字段裁剪（防变量空间膨胀）
    return { result: trimmed, success: true, content_type: 'json', ...(raw.audit ? { audit: raw.audit } : {}) };
  }
}

// 偏差结果：success:false + SCHEMA_DEVIATION 前缀——上游按既有失败语义入升级阶梯
// （FailRecord 带期望+实际截断样本,供 adaptive 重规划适配。作者定 2026-08-12"异常触发内置
// replan 去适配并记录"）。// @a: anc-exec-tool-shape-check
const DEVIATION_SAMPLE_LIMIT = 500;
function schemaDeviation(spec: ToolSpec, actual: unknown, why: string, audit?: { server?: string; duration_ms?: number }): ToolResult {
  const sample = truncate(typeof actual === 'string' ? actual : JSON.stringify(actual), DEVIATION_SAMPLE_LIMIT);
  return {
    result: `SCHEMA_DEVIATION: 工具 "${spec.name}" 返回与声明 output_schema 不合——${why}。期望形状: ${JSON.stringify(spec.output_schema ?? {})}；实际样本(截断): ${sample}`,
    success: false,
    content_type: 'text',
    ...(audit ? { audit } : {}),   // 偏差失败保留 server 归属——失败记账恰恰最需要归属（review 补）
  };
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + `…[截断,原长${s.length}]` : s; }

// 顶层值类型核对（^anc-type-output-schema-syntax）：HopSpec 类型名 → JS 值判定。
// yaml=结构化容器（对象或数组）;字符串族（line/text/markdown/prompt）核 string;深层不下钻。
// @a: anc-type-output-schema-syntax
function checkSchemaType(declared: unknown, actual: unknown): string | null {
  const kind = Array.isArray(declared) ? 'list' : String(declared);
  if (kind === 'list') return Array.isArray(actual) ? null : `声明列表,实际 ${typeof actual}`;
  switch (kind) {
    case 'bool': return typeof actual === 'boolean' ? null : `声明 bool,实际 ${typeof actual}`;
    case 'int': return typeof actual === 'number' && Number.isInteger(actual) ? null : `声明 int,实际 ${typeof actual === 'number' ? '非整数' : typeof actual}`;
    case 'float': return typeof actual === 'number' ? null : `声明 float,实际 ${typeof actual}`;
    case 'line': case 'text': case 'markdown': case 'prompt':
      return typeof actual === 'string' ? null : `声明 ${kind},实际 ${typeof actual}`;
    case 'yaml': return (actual !== null && typeof actual === 'object') ? null : `声明 yaml（结构化容器）,实际 ${typeof actual}`;
    default: return null;   // 词汇表外已被加载期文法闸拒——运行期防御性放行不二次拒
  }
}
function asResult(v: unknown): string | Record<string, unknown> {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return typeof v === 'string' ? v : JSON.stringify(v);
}
