#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: mcp-server ^anc-struct-mcp-server
// hopjit MCP server 协议壳：独立模式六工具（start_run/run_status/resume_run/list_runs/stop_run/run_approved_command）
// 薄壳包 StepDispatcher 进程内 API;另有复用模式驱动七件（实现在 reuse-driver.ts）、approve_commit、server_status（todo/0146）。常驻进程——run 状态活在注册表内存，HITL resume 同进程注入。
// 见 design/mcp-server.md ^anc-struct-mcp-server。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parseToolServers } from './tools-registry.js';
// 两级配置读取/合并/引用核归 config-load 模块（todo/0131,[[config-load]]）;StandaloneConfig 为 HopConfig 别名再导出一版供既有测试 import // @a: anc-struct-config-load
import { parseConfigFile, mergeConfigs, validateMergedRefs, loadHopConfig, configPaths, loadToolRegistry, effectiveLanguage, type HopConfig, type ProviderEntry } from './config-load.js';
export { mergeConfigs, type ProviderEntry };
/** StandaloneConfig：HopConfig 的别名（两种模式共用后改名,本别名再导出一版供既有测试 import——[[config-load#^anc-struct-config-load]]）。 */
export type StandaloneConfig = HopConfig;
import { readFileSync, writeFileSync, existsSync, realpathSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, isAbsolute, join, dirname } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ExecutionEngine, getEngineVersion, commitNotApprovedMessage } from './engine.js';
import { StepDispatcher, DirSpecProvider, parseModelRef, childNotInQueueMessage, makeCommitAnalyzer, type RunResult, type CommitAnalyzerProvider } from './dispatcher.js';
import { antRoots, resolveCalleeSpecPath, commitApprovalStorePath } from './hopant.js';
import { resolveInstance, driverRun, driverSubmit, driverReap, driverStatus, driverResume, driverAbort, driverValidate, driverErrorOf, type ReuseDriverContext } from './reuse-driver.js';
import { runDoctor, antList, antInstall, antAdapt, antRemove, antBootstrap, antPack, antShare, type AdminContext } from './hop-admin.js';   // 管理工具面八件的业务体（hop-cli 模块出口文件,^anc-mcp-admin-tools） // @a: anc-mcp-admin-tools
import { parseSpec } from './parser.js';
import { validateSpec } from './validator.js';
import { CompositeToolProvider, makeEngineToolProviderFactory } from './tools-composite.js';

// 引擎自有工具执行体工厂注册（执行主体原则 2026-09-05——mcp-server 组合根同 CLI 对称;
// 0076 起同带注册件现读:本进程 standalone dispatcher 自持 provider 不经此工厂,注册保持
// 两组合根一致,将来 mcp 引入消化路径不埋雷。^anc-exec-tool-request）
// @a: anc-exec-tool-request
ExecutionEngine.setEngineToolProviderFactory(
  makeEngineToolProviderFactory(hc => loadToolRegistry(configPaths(homedir(), hc.workspace_dir, process.env['HOPJIT_CONFIG'] || undefined), hc.workspace_dir)),   // 项目根=本 run 的 workspace_dir（复用模式 run 可显式传,与 server cwd 不同）;home/HOPJIT_CONFIG 读在组合根;两级（todo/0131） // @a: anc-config-reuse-consume
);
// 复用驱动工具建的 run 同样烘焙 callee 路径进 call_protocol——与 cli 组合根同一注册（两级寻址,家目录读在组合根）。
// ^anc-exec-callee-resolver // @a: anc-exec-callee-resolver
ExecutionEngine.setCalleeSpecResolver((callerSpecPath, calleeId, workspaceDir) => resolveCalleeSpecPath(dirname(callerSpecPath), antRoots(homedir(), workspaceDir), calleeId));   // 两级 HopAnt 根：项目级取本 run 工作区;不做 process.cwd 兜底（exec-engine ^anc-exec-callee-resolver）
// commit 批准账位置（^anc-exec-commit-approval）：spec 在 HopAnt 目录下记 <HopAnt>/inner_store/,其余记 run 根上一级
//（即 .hopstate/commit_approvals.json）。规则实现在 hopant.commitApprovalStorePath,与 cli 组合根同调。// @a: anc-exec-commit-approval
ExecutionEngine.setCommitApprovalStoreResolver((specPath, instanceDir, workspaceDir) => commitApprovalStorePath(antRoots(homedir(), workspaceDir), specPath, dirname(findRunRoot(instanceDir))));
import { ACT_BUILTIN_NAMES } from './act-builtins.js';
import { hasChildren, getChildren } from './ast-helpers.js';
import type { StepNode, ActBody, ActExpr, ActStatement } from './ast-types.js';
import type { HostConfig, RoutingCategory } from './provider-types.js';
import { credentialLikeHopEnvKey, hopEnvCredentialError, RUN_APPROVED_COMMAND_TOOL, APPROVE_COMMIT_TOOL, APPROVE_DIRS_TOOL } from './provider-types.js';
import { sendDingtalk, composeRunCard } from './tools-notify.js';
import { readSpec, readState, stateExists, readStateSeq, findRunRoot } from './persistence.js';   // 0093 快照兜底读 spec——唯一合法读口（内容寻址引用形态,^anc-provider-spec-content-addressed）;run_approved_command 纯读盘取清单（^anc-mcp-run-command）
import { runWhitelistedCommand } from './command-exec.js';
import { HopLog } from './hoplog.js';
import { appendFileSync } from 'node:fs';
import type { ExecutionPaused } from './cli-types.js';



/** commit 安全分析用哪个模型:跟着 commit 的路由走（routing_rules 里 step_type=commit 那条）,没配就用默认模型。
 * 凭证缺失到不了这里——serve 第 2.2 步 preflightProviderKeys 已判成 configError。见 [[mcp-server]] resolveCommitAnalyzerProvider HopSop。
 * // @a: anc-exec-commit-analyzer */
export function resolveCommitAnalyzerProvider(config: StandaloneConfig): CommitAnalyzerProvider {
  const rule = (config.routing_rules ?? []).find(r => r.step_type === 'commit');
  const ref = rule ? parseModelRef(rule.model) : resolveStandaloneDefaultModel(config);
  const p = (ref.service_id === 'default' ? config.providers[0] : undefined)
    ?? config.providers.find(x => x.service_id.toUpperCase() === ref.service_id.toUpperCase());
  if (!p) throw new Error(`STANDALONE_CONFIG_INVALID: commit 安全分析模型引用的 service '${ref.service_id}' 不在 providers 内`);
  return {
    service_id: p.service_id,
    protocol: p.protocol,
    base_url: p.base_url ?? null,
    api_key: process.env[p.api_key_env] ?? '',
    auth: p.auth === 'bearer' ? 'bearer' : null,
    model: ref.model,
  };
}

function resolveStandaloneDefaultModel(config: StandaloneConfig): { service_id: string; model: string } { // @a: anc-mcp-config
  // providers 可缺席（两级形态项目级文件可只有 tool_servers——至少1条的校验在合并后)；缺席时跳过默认解析
  if (!config.providers?.length) return { service_id: 'default', model: config.default_model ?? '' };
  const first = config.providers[0];
  if (!config.default_model) return { service_id: first.service_id, model: first.model };
  let ref: { service_id: string; model: string };
  try {
    ref = parseModelRef(config.default_model);
  } catch (error) {
    throw new Error(`STANDALONE_CONFIG_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (ref.service_id === 'default') return { service_id: first.service_id, model: ref.model };
  const provider = config.providers.find(p => p.service_id.toUpperCase() === ref.service_id.toUpperCase());
  if (!provider) {
    throw new Error(`STANDALONE_CONFIG_INVALID: default_model 引用的 service '${ref.service_id}' 不在 providers 内——拼写错误会请求错误后端`);
  }
  return { service_id: provider.service_id, model: ref.model };
}

/** 一次性读取全部 key，随后调用方才可写派生路由 env——防源变量被前序写入覆盖。// @a: anc-mcp-config */
function snapshotProviderKeys(config: StandaloneConfig): Map<ProviderEntry, string> {
  const values = new Map<ProviderEntry, string>();
  for (const p of config.providers) {
    const value = process.env[p.api_key_env];
    if (!value || !value.trim()) {
      throw new Error(`STANDALONE_KEY_MISSING: 环境变量 ${p.api_key_env} 未设置（provider '${p.service_id}'）——独立模式不可用`);
    }
    values.set(p, value);
  }
  return values;
}

// run 级 env 快照构造（run 隔离不变量——快照是封闭集:dispatcher envOf 有快照就不回退 process.env,
// 漏键=用户设了环境变量静默失效〔0008③实撞:HOPJIT_MAX_OUTPUT_TOKENS 恒 undefined〕。
// startRun/restore 同一函数——快照键集是单一语义,禁两处手写〔十四审'同一语义多路径'教训同款〕）。
// 键集两类：providers 派生三键（API_KEY/BASE_URL/PROTOCOL,getClientForService 消费）+
// 固定透传键（dispatcher envOf 全部固定键消费点——resolveCredential 默认链/ANTHROPIC_MODEL 第6级/
// 输出 token 上限;新增 envOf 固定键消费点必须同步此表,否则 standalone 下该键恒失效）。
// @a: anc-run-isolation
const SNAPSHOT_PASSTHROUGH_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'HOPJIT_ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'HOPJIT_MAX_OUTPUT_TOKENS',
  // CLAUDE_CODE_MAX_OUTPUT_TOKENS 已摘（^anc-exec-output-budget——解析链不再读,快照带着=死键;
  // 该 env 归 CC 宿主管自己 agent,引擎零消费点）。
] as const;
/** run 级 env 快照构造单点（startRun/restore 同函数;键集=providers 派生三键+固定透传六键——封闭集下键集即契约。导出供测试直测键集契约,0008③——mergeConfigs 同先例）。 */
export function buildEnvSnapshot(config: StandaloneConfig, providerKeys: Map<ProviderEntry, string>): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const p of config.providers) {
    snap[`${p.service_id.toUpperCase()}_API_KEY`] = providerKeys.get(p)!;
    snap[`${p.service_id.toUpperCase()}_BASE_URL`] = p.base_url;
    snap[`${p.service_id.toUpperCase()}_PROTOCOL`] = p.protocol;   // getClientForService 按此选适配器
    if (p.auth === 'bearer') snap[`${p.service_id.toUpperCase()}_AUTH`] = 'bearer';   // 鉴权头档（^anc-config-standalone-schema auth 字段——只认 Bearer 的网关实测百炼 claude-code-proxy）
    if (p.thinking !== undefined) snap[`${p.service_id.toUpperCase()}_THINKING`] = p.thinking;   // provider 级思考缺省（五级链第 4 级,^anc-exec-thinking-provider-default——dispatcher envOf 消费） // @a: anc-exec-thinking-provider-default
    if (p.thinking_disable_unsupported === true) snap[`${p.service_id.toUpperCase()}_THINKING_DISABLE_UNSUPPORTED`] = 'true';   // 端点思考关不掉的声明（只在 true 时披——dispatcher 五级链结果为关时改发 effort low）// @a: anc-exec-thinking-disable-unsupported
    if (p.max_output_tokens !== undefined) snap[`${p.service_id.toUpperCase()}_MAX_OUTPUT_TOKENS`] = String(p.max_output_tokens);   // 输出预算解析链第3级 // @a: anc-exec-output-budget
  }
  for (const k of SNAPSHOT_PASSTHROUGH_KEYS) {
    if (process.env[k] !== undefined) snap[k] = process.env[k];
  }
  return snap;
}

/** 配置加载：fail-fast——文件缺失/schema 非法/出现明文 key 均抛错。
 * 格式 YAML（config.yaml 唯一；YAML 是 JSON 超集，误写 JSON 语法仍可解析）。// @a: anc-config-standalone-schema */
// standalone 整体约束落点（design/standalone-mode.md ^anc-exec-standalone-invariants）：第1条 key 永不
// 落盘（明文即拒）、第4条问题拦在门口（schema 非法启动即拒）、第5条配置文件只有一个。// @a: anc-exec-standalone-invariants
// 统一配置两级形态（作者定 2026-08-13）：系统级 ~/.hopjit/config.yaml + 项目级 <cwd>/hopjit.yaml,
// 同一 schema 逐节合并项目级赢（providers 按 service_id/routing_rules 按 step_type/tool_servers 并集
// 判重在装配层/default_model 项目级在场即赢）。configPath 显式指定（HOPJIT_CONFIG）=只用它不合并（e2e 语义不变）。
export function loadStandaloneConfig(configPath?: string, projectDir?: string): StandaloneConfig {
  // 薄包装（todo/0131）：算路径 → config-load 两级加载,独立模式 requireProviders 且 default_model 引用核经回调注入 // @a: anc-struct-config-load
  return loadHopConfig(configPaths(homedir(), projectDir ?? process.cwd(), configPath), { requireProviders: true, resolveDefault: resolveStandaloneDefaultModel });
}





// 项目级配置每 run 重读（0007②+0012;十四审收敛为单一函数——startRun/restore 原各手写一份,
// 三审四审接连在'另一份'上撞同型缺陷〔catch 吞闸/providers 未剥〕,同一语义多路径实现是缺陷温床）。
// 语义四条：①HOPJIT_CONFIG 显式指定=单文件语义不重读;②文件缺席跳过（回退启动期配置不拦 run）,
// 在场但非法响亮拒（静默回退=吞 0004 凭证闸+用户编辑被无声忽略）;③providers 恒启动期快照
//（凭证解引用在 serve 启动期,重读换 provider=凭证链重走;项目级 providers 节在启动期两级合并
// 时生效,server 已跑后改文件不生效——语义分层见 design shared-providers 项目根条款）;
// ④合并后过 validateMergedRefs（十四审:重读合并的 routing_rules 引用拼错 service 原漂到
// 运行期才炸,BUG-E'加载期核'承诺在重读路径缺位——引用核对合并后 providers=启动期快照）。
// @a: anc-mcp-config
function reloadProjectConfig(startupConfig: StandaloneConfig, projectDir: string):
  { config: StandaloneConfig } | { error: { code: string; message: string } } {
  if (process.env['HOPJIT_CONFIG']) return { config: startupConfig };
  const projPath = join(projectDir, 'hopjit.yaml');
  if (!existsSync(projPath)) return { config: startupConfig };
  try {
    const projCfg = parseConfigFile(projPath, false, homedir());
    const merged = mergeConfigs(startupConfig, { ...projCfg, providers: [] } as StandaloneConfig);
    const config = { ...merged, providers: startupConfig.providers };   // providers 恒启动期快照
    validateMergedRefs(config, resolveStandaloneDefaultModel);
    return { config };
  } catch (err: unknown) {
    return { error: { code: 'CONFIG_INVALID', message: `项目级配置 ${projPath} 非法——${err instanceof Error ? err.message : String(err)}` } };
  }
}



/** provider → HostConfig：api_key_env 解引用（env 缺失即报变量名不报值——key 安全纪律）。
 * // @a: anc-mcp-key-isolation */
export function providerToHostConfig(p: ProviderEntry, workspaceDir: string, commands?: string[]): HostConfig {
  const apiKey = process.env[p.api_key_env];
  if (!apiKey || !apiKey.trim()) {
    throw new Error(`STANDALONE_KEY_MISSING: 环境变量 ${p.api_key_env} 未设置（provider '${p.service_id}'）`);
  }
  return {
    workspace_dir: workspaceDir,
    sandbox: {
      // 沙箱锚=本 run 作业根的绝对路径（原 '.' 相对进程 cwd——workspace_dir 参数引入后两者可
      // 分离,'.' 会把沙箱错锚到 server cwd 而非 run 作业根）// @a: anc-mcp-config
      filesystem: { workspace_dir: workspaceDir, read_access: { allowed: [workspaceDir],
        // 默认拒读基线：密钥/凭证类即使在 workspace 内也拦（sandbox.md 读权限优先级
        // denied > allowed；2026-08-08 语义审计 ❌ 实抓：设计一贯示例含 .env/*.key,
        // 代码 denied=[] 致默认部署下凭证文件对 LLM read 工具可读）。// @a: anc-config-sandbox-filesystem
        denied: ['.env', '.env.*', '*.key', '*.pem', '.hopstate/**', '.hoplog/**'], confirm_required: [] } },   // .hoplog（#50:LLM 逛日志树 read 巨型 main.yaml 灌爆上下文,dr19 实撞）
      network: { trusted_hosts: [] },
      runtime: { available: commands ?? [] },   // 配置通路（^anc-exec-subprocess-run） // @a: anc-exec-subprocess-run
    },
    api_key: apiKey,
    ...(p.base_url ? { base_url: p.base_url } : {}),
    model: p.model,
    protocol: p.protocol,   // wire 协议贯穿到 Dispatcher 构造分派 // @a: anc-exec-protocol-adapter
    ...(p.auth ? { auth: p.auth } : {}),   // 鉴权头档贯穿到 defaultClient 构造（缺省 provider 路径生效面——2026-09-18 review 补） // @a: anc-config-standalone-schema
  };
}

// ── 工具面预检：spec 所需非内置工具 ⊆ 装配后工具面（内置∪宿主注入并集）──

function collectExprTools(e: ActExpr, out: Set<string>): void {
  switch (e.type) {
    case 'call':
      if (!ACT_BUILTIN_NAMES.has(e.callee)) out.add(e.callee);
      for (const a of e.args) collectExprTools(a.value, out);
      break;
    case 'binary': collectExprTools(e.left, out); collectExprTools(e.right, out); break;
    case 'unary': collectExprTools(e.operand, out); break;
    // field 链下钻：tool(...).field 的调用藏在 object 里——漏此分支曾绕过预检（review P2）
    case 'field': collectExprTools(e.object, out); break;
    default: break;
  }
}

function collectBodyTools(body: ActBody | undefined, out: Set<string>): void {
  if (!body) return;
  const walkStmts = (stmts: ActStatement[]): void => {
    for (const s of stmts) {
      if (s.type === 'assign') collectExprTools(s.value, out);
      else if (s.type === 'call') collectExprTools({ type: 'call', callee: s.call.callee, args: s.call.args }, out);
      else if (s.type === 'if') {
        collectExprTools(s.condition, out);
        walkStmts(s.then_body);
        if (s.else_body) walkStmts(s.else_body);
      }
    }
  };
  walkStmts(body.statements);
}

/** 收集 spec 全树 act/commit body 引用的非内置工具名。standalone 切换前预检用——
 * 不满足即拒启动，不能只凭 key 存在（TODO 安全约束）。// @a: anc-mcp-tools */
export function collectSpecTools(steps: StepNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: StepNode[]): void => {
    for (const n of nodes) {
      const body = (n as { body?: ActBody }).body;
      collectBodyTools(body, out);
      if (hasChildren(n)) walk(getChildren(n));
    }
  };
  walk(steps);
  return out;
}

// ── run 注册表 ──

interface RunEntry {
  runId: string;
  specPath: string;
  // aborted=stop_run 主动中止的终态（2026-08-22 作者定"hopjit 应该能自己杀自己的子任务"——
  // 此前失控 run 只能杀 server 止损）。见 [[mcp-server#^anc-mcp-tools]] stop_run 行。
  // @a: anc-mcp-stop-run
  state: 'running' | 'paused' | 'completed' | 'failed' | 'aborted';
  dispatcher: StepDispatcher;
  paused?: ExecutionPaused;
  outputs?: Record<string, unknown>;
  failure?: { step_id: string; reason: string };
  startedAt: string;
  notifyRequested?: boolean;   // per-run 通知开关（startRun 从 params 摘 hop_notify——用户要了才发,^anc-mcp-notify-hook 三与门第一门） // @a: anc-mcp-notify-hook
}

const DEFAULT_MAX_CONCURRENT_RUNS = 4;   // 并发 run 上限缺省——防失控烧费的保守默认;resource_limits.max_concurrent_runs 可调（todo/0084 M1 配置化:原裸常量任何途径改不了,批量验证第 5 run 被拒实撞;server 级判定读启动期合并后配置,与 providers 快照同理由不入每 run 重读面） // @a: anc-mcp-config

/** start_run 响应里随返回的 dirs 对账提示——按 init warnings 的 rule 字段挑（引擎 Config.dirs 对账的 warning 恒 rule=CONFIG,^anc-exec-dirs-grant）,不按报文文字。// @a: anc-mcp-dirs-approve */
export const DIRS_WARNING_RULES: ReadonlySet<string> = new Set(['CONFIG']);

/** run_approved_command 超时缺省秒数（^anc-mcp-run-command 步 6;inputSchema describe 与设计同源——review 抓五处字面量）。 */
export const RUN_COMMAND_TIMEOUT_DEFAULT_SEC = 300;
/** run_approved_command 超时上限秒数——spawnSync 阻塞 server 事件循环,上限失守=一条命令锁死 server;且须恒小于 Claude Code 对一次 MCP 工具调用的
 * 1800 秒静默上限（期间无响应无 progress 即被载体单方面中止,本工具执行期间发不了 progress）,留 300 秒给 4MB 截断、序列化与传输——超限传入按此截断照跑,
 * 更长的等待由调用方分段（^anc-mcp-run-command;hopissues/0128 cloudflash 3500 秒等待实撞）。 */
export const RUN_COMMAND_TIMEOUT_MAX_SEC = 1500;

/** 进程存活判定（stop_run 快照兜底的"另一个活进程持有"判据,^anc-mcp-stop-run 第 6 条 HopType）——
 * process.kill(pid, 0) 不抛=活;抛 EPERM=活（进程在,只是无权发信号）;抛 ESRCH 或其他=已死。// @a: anc-mcp-stop-run */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err: unknown) { return (err as { code?: unknown })?.code === 'EPERM'; }
}

/** run 注册表 + 工具 handler 核心。与 transport 分离（HTTP 演进出口留在 serve() 层）。
 * // @a: anc-struct-mcp-server */
export class HopjitMcpCore {
  private runs = new Map<string, RunEntry>();

  // config=null 表示独立模式不可用（配置缺失/非法/凭证缺失）,configError 记原因与修法;复用驱动工具不依赖它。
  // 见 [[mcp-server#^anc-mcp-server-status]]。// @a: anc-mcp-server-status
  constructor(private config: StandaloneConfig | null, private configError: { reason: string; fix: string } | null = null, private configPath = '') {}

  /** 独立模式入口的能力闸：config 为 null 时返回 STANDALONE_UNAVAILABLE 错误体,否则 null。// @a: anc-mcp-server-status */
  private standaloneUnavailable(): Record<string, unknown> | null {
    if (this.config) return null;
    const ce = this.configError ?? { reason: '独立模式配置未加载', fix: '创建 ~/.hopjit/config.yaml（只写 api_key_env 名,不写 key）,或设 HOPJIT_CONFIG 指向配置文件' };
    return { error: { code: 'STANDALONE_UNAVAILABLE', message: `独立模式不可用:${ce.reason}——复用模式驱动工具不受影响`, reason: ce.reason, fix: ce.fix } };
  }

  /** server_status 工具:版本、独立模式能力状态、注册工具清单（只读）。// @a: anc-mcp-server-status */
  serverStatus(tools: string[]): Record<string, unknown> {
    return {
      version: getEngineVersion() ?? 'unknown',
      standalone: {
        available: this.config !== null,
        ...(this.config ? {} : { reason: this.configError?.reason ?? '独立模式配置未加载', fix: this.configError?.fix ?? '' }),
        config_path: this.configPath,
      },
      reuse_tools_available: true,
      tools,
    };
  }

  // run 生命周期状态机：running → (completed|failed|paused)，paused → resume → running（可多次）。
  // paused 非终态；终态 run 保留在注册表至 server 退出。见 [[mcp-server#^anc-mcp-run-lifecycle]]。
  // @a: anc-mcp-run-lifecycle
  private applyResult(entry: RunEntry, r: RunResult): void {
    // aborted 终局钉死（stop_run 竞态防线）：中止后 executionLoop 步间返回 failed('(aborted)'),
    // 该迟到结果不得把 aborted 改写回 failed——中止意图先于执行结果。// @a: anc-mcp-stop-run
    if (entry.state === 'aborted') {
      const tp = entry.dispatcher?.getToolProvider?.() as { close?: () => Promise<void> } | undefined;
      if (typeof tp?.close === 'function') void tp.close();
      return;
    }
    if (r.status === 'paused') {
      entry.state = 'paused';
      entry.paused = r.pause;
      entry.failure = undefined;   // 上一轮拒收残留清除（0016——合法 resume 推进到新暂停点后不再展示旧拒因）
    } else {
      entry.state = r.status;
      entry.outputs = r.outputs;
      entry.failure = r.failure;
      entry.paused = undefined;
      // run 终态：收外部工具 server（mcp 成员三段收——尽力而为不拦终态）// @a: anc-exec-mcp-binding
      const tp = entry.dispatcher?.getToolProvider?.() as { close?: () => Promise<void> } | undefined;
      if (typeof tp?.close === 'function') void tp.close();
    }
    this.maybeNotify(entry);   // 通知挂点（^anc-mcp-notify-hook——唯一收口,终态与 paused 都过此处） // @a: anc-mcp-notify-hook
  }

  /** 通知挂点（^anc-mcp-notify-hook,todo/0052）：三与门——①per-run 要了（hop_notify）
   * ②config notify.channel 声明了通道 ③通道凭证环境变量在场（sendDingtalk 自查,缺席回失败值）。
   * 缺任一静默跳过：没被要求的通知=替用户做主（作者 2026-08-30"你都没说钉钉通知,为啥会通知"）。
   * 卡片渲染归本挂点（作者抓"内容很丑"——工具只收文本）;发送失败吞掉记日志,通知是旁路
   * 恒不拖垮 run。发送经 sendDingtalk 进程内直调——挂点是引擎自身行为不是 spec 步骤,
   * requires_commit 的 commit 语境约束不适用。 // @a: anc-mcp-notify-hook */
  private maybeNotify(entry: RunEntry): void {
    if (!entry.notifyRequested) return;                       // 门① 用户要了才发
    if (this.config?.notify?.channel !== 'dingtalk') return;   // 门② 配置声明了通道（config 为 null=独立模式不可用,无通道）
    const specTitle = entry.dispatcher.getEngine().getSpec()?.header.title
      ?? entry.specPath.split('/').pop()?.replace(/\.md$/, '') ?? entry.runId;
    let completed = 0, total = 0, currentStep: string | undefined;
    try {
      const st = entry.dispatcher.getEngine().getStatus();
      completed = st.completed; total = st.total_steps; currentStep = st.current_step;
    } catch { /* 状态读取失败不拦通知 */ }
    const q = (entry.paused as { presented_data?: { question?: string } } | undefined)?.presented_data?.question;
    // 卡片组装共享 composeRunCard（^anc-cli-notify-reuse——两挂点同源,消两处组装漂移面） // @a: anc-mcp-notify-hook
    const card = composeRunCard({
      spec_title: specTitle,
      state: entry.state === 'paused' ? 'paused' : entry.state === 'completed' ? 'completed' : 'failed',
      completed_steps: completed, total_steps: total,
      ...(entry.state === 'failed' && entry.failure ? { current_step: `${entry.failure.step_id}: ${entry.failure.reason.slice(0, 160)}` } : currentStep ? { current_step: currentStep } : {}),
      ...(q ? { paused_question: String(q) } : {}),
      run_id_tail: entry.runId.slice(-8),
    });
    // 门③ 凭证在 sendDingtalk 内自查;发送失败吞掉记日志——通知旁路恒不拖垮 run
    void sendDingtalk({ title: card.title, text: card.text })
      .then(r => { if (!r.success) console.error(`[notify] 发送失败: ${String(r.result).slice(0, 160)}`); })
      .catch(err => console.error(`[notify] 发送异常: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** model_engine 构造单点（todo/0084 M3——startRun 与 restoreRun 同调:原 restore 漏装,
   * server 重启恢复的 run 模型路由静默回落 providers[0].model,烧错钱且无提示;
   * shared-providers "startRun/restore 同一套判定"承诺由公共化兑现,不留漂移副本）。
   * // @a: anc-exec-model-routing */
  private buildModelEngine(config: StandaloneConfig): NonNullable<HostConfig['model_engine']> {
    const defaultModel = resolveStandaloneDefaultModel(config);   // default_model 数据面可项目覆;providers 已恒快照
    return {
      default_service_id: defaultModel.service_id,
      default_model: defaultModel.model,
      // 系统层类别路由入 ModelEngine（dispatcher resolveModel Priority 4 消费）// @a: anc-exec-model-routing
      ...(config.routing_rules?.length ? {
        routing_rules: config.routing_rules.map(r => {
          const ref = parseModelRef(r.model);
          return { match: { step_type: r.step_type as RoutingCategory }, service_id: ref.service_id === 'default' ? defaultModel.service_id : ref.service_id, model: ref.model, ...(r.thinking ? { thinking: r.thinking } : {}) };   // 加载闸已核 step_type∈ROUTING_CATEGORIES,此断言是闸后收窄非谎言（0008①——原强转到 ExecutableStepType:replan 根本不在该类型内）// @a: anc-exec-thinking-routing
        }),
      } : {}),
    };
  }

  async startRun(specPathArg: string, params?: Record<string, unknown>, stateDir?: string, workspaceDirArg?: string, dirsArg?: { read?: string[]; readwrite?: string[] }): Promise<Record<string, unknown>> { // @a: anc-mcp-config
    const unavailable = this.standaloneUnavailable();   // 独立模式能力闸 // @a: anc-mcp-server-status
    if (unavailable) return unavailable;
    const config = this.config!;
    const providerKeys = snapshotProviderKeys(config);
    const active = [...this.runs.values()].filter(e => e.state === 'running' || e.state === 'paused').length;
    const maxRuns = config.resource_limits?.max_concurrent_runs ?? DEFAULT_MAX_CONCURRENT_RUNS;
    if (active >= maxRuns) {
      return { error: { code: 'RUN_LIMIT', message: `并发 run 已达上限 ${maxRuns}——等现有 run 终态或另起 server（上限可调:配置 resource_limits.max_concurrent_runs,server 启动期生效）` } };
    }
    // spec_path 只接显式路径，不搜索不猜（design ^anc-mcp-key-isolation 焊死条）
    // 组合根一次读取（run 隔离,ARCHITECTURE ^anc-run-isolation）：cwd 折进本 run。
    // workspace_dir 参数=作业对象根显式化（2026-08-20 作者定目录三层归位——server cwd 由注册时
    // 会话定、常≠作业对象,MCP 无 cd 通道故开参数;与 spec_path 同款焊死:显式路径,不存在即拒）。
    // @a: anc-run-isolation, anc-mcp-config
    const serverCwd = process.cwd();
    const runCwd = workspaceDirArg
      ? (isAbsolute(workspaceDirArg) ? workspaceDirArg : resolve(serverCwd, workspaceDirArg))
      : serverCwd;
    if (workspaceDirArg && !existsSync(runCwd)) {
      return { error: { code: 'WORKSPACE_NOT_FOUND', message: `workspace_dir 不存在（${runCwd}）——只接受显式路径，不做搜索` } };
    }
    // 项目级配置每 run 装配期重读（0007②+0012——项目根=本 run 组合根 cwd,与 restore 钉根
    // 重读对称同一函数;语义四条见 reloadProjectConfig 注）// @a: anc-mcp-config
    const reloaded = reloadProjectConfig(config, runCwd);
    if ('error' in reloaded) return { error: reloaded.error };
    const effectiveConfig = reloaded.config;
    const specPath = isAbsolute(specPathArg) ? specPathArg : resolve(runCwd, specPathArg);
    if (!existsSync(specPath)) {
      return { error: { code: 'SPEC_NOT_FOUND', message: `spec 文件不存在（${specPath}）——只接受显式路径，不做搜索` } };
    }
    const raw = readFileSync(specPath, 'utf-8');
    const { ast, errors: parseErrors } = parseSpec(raw);
    if (parseErrors.length > 0) {
      return { error: { code: 'SPEC_INVALID', message: `spec 解析失败: ${parseErrors.map(e => e.message).join('; ')}` } };
    }
    const errors = validateSpec(ast).filter(e => e.severity === 'error');
    if (errors.length > 0) {
      return { error: { code: 'SPEC_INVALID', message: `spec 未过校验闸门: ${errors.map(e => `${e.rule}: ${e.message}`).join('; ')}` } };
    }

    // 多 provider v1 语义（design v0.3.1 review P1）：providers[0] 为默认执行 provider；
    // 全部条目注入本进程路由 env（{SERVICE_ID}_API_KEY/_BASE_URL，即 dispatcher
    // getClientForService 的既有多服务约定）+ ModelEngine——service/model 引用按
    // service_id 命中对应后端，不静默回退默认 client（错后端=烧错钱）。
    const provider = config.providers[0];
    const hostConfig = providerToHostConfig(provider, runCwd, effectiveConfig.commands);   // effectiveConfig 每 run 重读——项目级 commands 生效(review F2:原读启动期快照,项目级无通路) // @a: anc-exec-subprocess-run
    hostConfig.config_project_dir = runCwd;   // 配置读取根随快照钉住（BUG-I——重启恢复据此重读项目级配置）// @a: anc-mcp-run-restore
    // resource_limits 节装配（每 run 重读数据面——effectiveConfig 已两级合并;env 优先序归 dispatcher 解析链）// @a: anc-config-standalone-schema
    if (effectiveConfig.resource_limits) {
      hostConfig.resource_limits = { ...(hostConfig.resource_limits ?? {}), ...effectiveConfig.resource_limits } as typeof hostConfig.resource_limits;
    }
    // 外部工具注册（批次二）：tools_file 加载进宿主契约——装配/预检同源消费。
    // 加载失败=结构化 error 不裸抛（TOOLS_UNAVAILABLE 同约定,design ^anc-config-tool-registry 加载 fail-fast 条）。
    // @a: anc-config-tool-registry
    if (effectiveConfig.tool_servers?.length) {
      try {
        hostConfig.tool_registry = parseToolServers(structuredClone(effectiveConfig.tool_servers), runCwd);   // 深拷贝分发（run 隔离）;effectiveConfig=每 run 重读的数据面（0012） // @a: anc-run-isolation
      } catch (err: unknown) {
        return { error: { code: 'TOOLS_FILE_INVALID', message: err instanceof Error ? err.message : String(err) } };
      }
    }
    // 缺省 SpecProvider：宿主未注入时按 spec 文件所在目录构造 DirSpecProvider（[call callee] 同目录
    // 寻址，design ^anc-provider-spec-default）——独立模式 call 递归的解析源。// @a: anc-provider-spec-default
    hostConfig.spec_provider ??= new DirSpecProvider(dirname(specPath), antRoots(homedir(), hostConfig.workspace_dir));
    // 凭证/端点/协议改走 run 级 env 快照（run 隔离不变量,ARCHITECTURE ^anc-run-isolation——
    // 原实现写 process.env 把进程环境当全局注册表:多 run 共享可变槽的反模式实例,且外部
    // 观察者〔子进程/诊断〕会看到凭证泄进进程环境）。dispatcher envOf 只查快照。
    // 键集与构造单点 buildEnvSnapshot（0008③——原手写只冻 providers 三键,固定透传键漏冻,
    // 封闭集下 HOPJIT_MAX_OUTPUT_TOKENS 等用户环境变量静默失效）。
    // @a: anc-run-isolation, anc-exec-protocol-adapter
    hostConfig.env_snapshot = buildEnvSnapshot(config, providerKeys);
    hostConfig.language = effectiveLanguage(effectiveConfig.language);   // 生成物语言：键缺席跟随系统语言,与复用模式同一判定（todo/0160;^anc-i18n-language-config） // @a: anc-i18n-serialize-lang
    // hop_env 覆盖链合成（组合根,^anc-config-hop-env）：配置 env 节（已两级合并）→ params 里
    // hop_env_* 键覆盖（覆盖项从业务 params 中摘出——它是环境参数不是 spec 输入）。
    // @a: anc-config-hop-env
    // hop_env_language 打底注入（^anc-i18n-language-config——language 是项目属性恒在表,
    // hopbuild2 拼头 body 直接引用零判存;env 节/params 显式写 hop_env_language 者按覆盖链后到覆盖）。// @a: anc-i18n-serialize-lang
    const hopEnv: Record<string, string> = { hop_env_language: hostConfig.language, ...(effectiveConfig.env ?? {}) };   // env 数据面同重读（0012）
    let notifyRequested = false;   // per-run 通知开关（^anc-mcp-notify-hook） // @a: anc-mcp-notify-hook
    if (params) {
      for (const k of Object.keys(params)) {
        if (k === 'hop_notify') {
          // per-run 通知开关摘取（^anc-mcp-notify-hook——与 hop_env_* 同位同款:旁路键不透传
          // 给 spec Inputs;真值即置,发送判定在 applyResult 三与门） // @a: anc-mcp-notify-hook
          notifyRequested = params[k] === true || params[k] === 'true';
          delete params[k];
          continue;
        }
        if (k.startsWith('hop_env_')) {
          // 凭证禁入三级闸之 params 级（0004——原零检查,凭证随 host_context 落盘进日志）。
          // 结构化 error 非 throw——startRun 错误面契约（0005 同病不再犯:裸抛炸壳）
          if (credentialLikeHopEnvKey(k)) {
            return { error: { code: 'HOP_ENV_CREDENTIAL_REJECTED', message: hopEnvCredentialError(k, 'params') } };
          }
          if (typeof params[k] === 'string') hopEnv[k] = params[k] as string;
          delete params[k];
        }
      }
    }
    if (Object.keys(hopEnv).length) {
      hostConfig.hop_env = hopEnv;
      // 写配置即授权：hop_env 声明的绝对路径根自动入 sandbox read allowed——授权面与声明面
      // 同一动作不分叉（doc-ref 展开值 workspace 外时按 read_access 判,声明根放行未声明照拒）。
      // @a: anc-exec-doc-ref-hop-env
      for (const v of Object.values(hopEnv)) {
        if (isAbsolute(v) && !hostConfig.sandbox.filesystem.read_access.allowed.includes(v)) {
          hostConfig.sandbox.filesystem.read_access.allowed.push(v);
        }
      }
    }
    hostConfig.model_engine = this.buildModelEngine(effectiveConfig);   // 构造单点（todo/0084 M3——startRun/restore 同调真同源,原 restore 漏装本件模型路由静默回落 providers[0]） // @a: anc-exec-model-routing

    // 工具面预检：所需工具 ⊆ 装配后工具面（内置组∪宿主注入并集；tools_file 声明的外部工具
    // 待批次二 McpBinding 实装后进此并集,先声明先不放行=不承诺跑不动的能力）。// @a: anc-exec-tool-composite
    const needed = collectSpecTools(ast.steps ?? []);
    // 装配点包裹（0005——TOOLS_NAME_CONFLICT 原从构造点裸抛,SDK 兜成无 code 文本;
    // 与 TOOLS_FILE_INVALID 同款结构化,design tool-interface 加载 fail-fast 条款）
    let available: Set<string>;
    try {
      available = new Set(new CompositeToolProvider(hostConfig).list().map(t => t.name));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.startsWith('TOOLS_NAME_CONFLICT') ? 'TOOLS_NAME_CONFLICT' : 'TOOLS_ASSEMBLY_FAILED';
      return { error: { code, message: msg } };
    }
    const missing = [...needed].filter(t => !available.has(t));
    if (missing.length > 0) {
      return { error: { code: 'TOOLS_UNAVAILABLE', message: `standalone 工具面不足，缺: ${missing.join(', ')}——该 spec 请用复用模式跑` } };
    }

    const engine = new ExecutionEngine();
    // HopLog 恒开（design ^anc-struct-mcp-server HopLog 恒开条，G11 落实）：standalone 执行内幕
    // 全在 server 进程内，日志是外部核验过程轨迹的唯一通道——不开则 standalone 成黑箱。
    // state_dir 锚 workspace_dir（runCwd）——与 spec_path 同款解析规则。原实现相对路径原样
    // 下传:快照 mkdir 按 server 进程 cwd 落盘,act body 的 write 按 workspace_dir 锚解析同一
    // 相对路径,work_zone 目录两头对不上 ENOENT（coffee/ppt 首发两 run 同死,任务 #28）。
    // 快照/hoplog/work_zone 三产物单一基准=workspace_dir。// @a: anc-mcp-config
    const resolvedStateDir = isAbsolute(stateDir ?? '.hopstate')
      ? (stateDir as string)
      : resolve(runCwd, stateDir ?? '.hopstate');
    const init = engine.initExecution(raw, hostConfig, {
      stateDir: resolvedStateDir,
      logDir: join(resolvedStateDir, '..', '.hoplog'),
      // 缺省 info（todo/0127 作者定——对外分发防塞爆硬盘;2026-08-22 曾定 debug）。排障经 log_level: debug 升级。
      // 见 design mcp-server HopLog 恒开条。// @a: anc-config-standalone-schema
      logLevel: effectiveConfig.log_level ?? 'info',   // 缺省 info（todo/0127）
      ...(effectiveConfig.log_retention ? { maxRuns: effectiveConfig.log_retention.max_runs } : {}),   // @a: anc-obs-log-retention
      ...(params ? { params } : {}),
      specPath,
      dirsGrant: dirsArg ?? {},   // 独立模式 Config.dirs 唯一授权面——没传也要对账（spec 有 workspace 外声明即缺）,引擎 init 内判,缺即不建实例 // @a: anc-mcp-dirs-approve
      driverChannel: 'mcp',   // 双执行硬闸落账 // @a: anc-exec-driver-channel
    });
    if (init.status !== 'ok') {
      return { error: { code: 'INIT_FAILED', message: ('errors' in init ? init.errors : []).map(e => e.message).join('; ') || 'init 失败' } };
    }
    // Config.dirs 对账已在 engine.initExecution 内完成（dirsGrant,^anc-exec-dirs-grant）——多传不授的提示在 init.warnings 里,
    // 按 warning 的 rule 字段挑出（引擎 dirs 对账产生的 warning 恒 rule=CONFIG）随本返回的 warnings 送出,不按报文文字筛。// @a: anc-mcp-dirs-approve
    const dirsWarn = ('warnings' in init ? (init.warnings ?? []) : []).filter(w => w.kind === 'validate' && DIRS_WARNING_RULES.has(w.rule)).map(w => w.message);
    // 修订供给档装配（^anc-exec-revision-short-weak）:精度 env > 项目配置 > 缺省 standard。
    // env 读进程环境属组合根一次读取（与 HOPJIT_CONTEXT_MODE 同款豁免——低危调档开关,
    // 不碰凭证/解析根）。// @a: anc-exec-revision-short-weak
    const envRp = process.env['HOPJIT_REVISION_PROMPT']?.toLowerCase();
    const rpMode = (envRp === 'short' || envRp === 'standard') ? envRp : (effectiveConfig.revision_prompt ?? 'standard');
    engine.setRevisionPromptMode(rpMode);

    const dispatcher = new StepDispatcher(engine, hostConfig);
    const entry: RunEntry = {
      runId: init.instance_id, specPath, state: 'running',
      dispatcher, startedAt: new Date().toISOString(),
      ...(notifyRequested ? { notifyRequested: true } : {}),   // @a: anc-mcp-notify-hook
    };
    this.runs.set(entry.runId, entry);

    // job 式异步：不 await——完成/暂停/失败时更新注册表（design ^anc-mcp-run-lifecycle）
    void dispatcher.runSpec()
      .then(r => this.applyResult(entry, r))
      .catch(err => {
        // aborted 钉住（^anc-mcp-stop-run 第2条）：stop_run 已置终局,迟到异常不得改写
        // aborted→failed（终态间失真）——只收工具 server 即返回。close 幂等可重入。
        if (entry.state === 'aborted') {
          const tpA = entry.dispatcher?.getToolProvider?.() as { close?: () => Promise<void> } | undefined;
          if (typeof tpA?.close === 'function') void tpA.close();
          return;   // @a: anc-mcp-stop-run
        }
        entry.state = 'failed';
        entry.failure = { step_id: '?', reason: err instanceof Error ? err.message : String(err) };
        // failed-via-throw 同样收工具 server（0007①——原 close 只挂 then 路径,异常失败
        // stdio 子进程滞留到 server 退出;design tool-interface 生命周期④含 failed 全终态）
        const tp = entry.dispatcher?.getToolProvider?.() as { close?: () => Promise<void> } | undefined;
        if (typeof tp?.close === 'function') void tp.close();
        this.maybeNotify(entry);   // 异常失败路径同挂（阅卷缺口 B——"failed 恒发"不豁免 throw 终态） // @a: anc-mcp-notify-hook
      });

    // state_dir 解析后绝对路径随返回——server 重启后 run_status/resume_run 快照兜底据此传参;dirs 多传不授的提示随 warnings 送出（^anc-mcp-dirs-approve）
    return { run_id: entry.runId, status: 'running', state_dir: resolvedStateDir, ...(dirsWarn.length ? { warnings: dirsWarn } : {}) };
  }

  runStatus(runId?: string, stateDir?: string): Record<string, unknown> {
    const entry = this.resolveRun(runId);
    if (!entry) {
      // 快照兜底（0028,detach 场景跨进程取问题卡）：注册表不中时纯读盘——不建 RunEntry/
      // 不构造 Dispatcher/零凭证需求（readOnlyHint 忠实;与 resume_run 的完整恢复分工:
      // 看卡零成本,注入答案才走 restoreRun）。见 design ^anc-mcp-tools run_status 行。
      // @a: anc-mcp-run-restore
      if (runId) {
        const instDir = resolve(stateDir ?? '.hopstate', runId);
        if (existsSync(join(instDir, 'aborted.json'))) {
          return { run_id: runId, status: 'aborted', restored_from_snapshot: true };
        }
        // 终态优先于卡（40 轮 review 探针实抓分支序缺陷:completed 快照+残留死卡并存时,
        // 卡分支先行→陈卡对账返回 NOT_FOUND,把盘上明明在场的 terminal_state 挡住——
        // 删卡与 persist 非原子,残卡窗口真实存在;状态权威序=墓碑>终态>等人卡）。
        if (existsSync(join(instDir, 'state.json'))) {
          // 终态直读（0043"终局有据"——terminal_state 随快照落盘后,completed/failed 跨进程
          // 零成本可判;completed 的 outputs=header.outputs 声明变量按 vars.json 现值收集,
          // 与进程内 collectOutputs 同判据。此前"快照不存 run 级终态"的注记随 0043 作废）。
          // @a: anc-exec-state-persistence
          try {
            const st = JSON.parse(readFileSync(join(instDir, 'state.json'), 'utf-8')) as { terminal_state?: string; terminal_failure?: { stepId: string; reason: string }; cumulative_tokens?: number };
            // 快照兜底带 token 账（盘上 cumulative_tokens——跨进程恢复态不归零,^anc-mcp-run-status-inflight token 条）
            const snapTokens = typeof st.cumulative_tokens === 'number' && st.cumulative_tokens > 0 ? { cumulative_tokens: st.cumulative_tokens } : {};
            if (st.terminal_state === 'completed') {
              let outputs: Record<string, unknown> | undefined;
              // completed 标记与步骤态一致性核（hopissues/0093 快照兜底半边——probe 实走通路:
              // 注册表 miss 纯读盘时同样不留静默通道;判据与 engine.detectCompletedInconsistency
              // 同构:顶层步存在 pending/running 非终态即病态,报告不擅改。exec-engine
              // ^anc-exec-completed-consistency）。// @a: anc-exec-completed-consistency
              let inconsistency: string | undefined;
              try {
                const specData = readSpec(instDir) as { header?: { outputs?: Array<{ name: string }> }; steps?: Array<{ step_id: string }> };   // 经 readSpec——spec.json 可能是内容寻址引用形态（^anc-provider-spec-content-addressed）// @a: anc-provider-spec-content-addressed
                const varsData = JSON.parse(readFileSync(join(instDir, 'vars.json'), 'utf-8')) as { scopes?: Record<string, { variables?: Record<string, unknown> }>; variables?: Record<string, unknown> };
                const rootVars = varsData.scopes?.['root']?.variables ?? varsData.variables ?? {};   // v2 scopes=对象键即 scope id;v1 扁平 variables
                outputs = {};
                for (const o of specData.header?.outputs ?? []) {
                  if (o.name in rootVars) outputs[o.name] = rootVars[o.name];
                }
                const states = (JSON.parse(readFileSync(join(instDir, 'state.json'), 'utf-8')) as { step_states?: Record<string, string> }).step_states ?? {};
                const nonTerminal = (specData.steps ?? [])
                  .filter(t => !['done', 'failed', 'skipped'].includes(states[t.step_id] ?? 'pending'))
                  .map(t => t.step_id);
                if (nonTerminal.length > 0) {
                  inconsistency = `terminal_state=completed 但顶层步 ${nonTerminal.join(', ')} 仍未终态——完成标记与步骤态不一致：疑快照被盘外改写或回放重建,产出可能不完整,建议人工核对步骤集与交付物后处置（引擎不擅自清标记——自动翻 running 会重派已清账的步骤）`;
                }
              } catch { /* outputs/一致性核失败不遮终态——status 仍如实 */ }
              return { run_id: runId, status: 'completed', ...snapTokens, ...(outputs ? { outputs } : {}), ...(inconsistency ? { inconsistency } : {}), restored_from_snapshot: true };
            }
            if (st.terminal_state === 'failed') {
              return { run_id: runId, status: 'failed', ...snapTokens, ...(st.terminal_failure ? { failure: { step_id: st.terminal_failure.stepId, reason: st.terminal_failure.reason } } : {}), restored_from_snapshot: true };
            }
          } catch { /* state.json 损坏——落到下方既有分支报 NOT_FOUND */ }
        }
        const cardPath = join(instDir, 'paused.json');
        if (existsSync(cardPath)) {
          try {
            const card = JSON.parse(readFileSync(cardPath, 'utf-8')) as Record<string, unknown>;
            // 陈卡对账（31 轮 review 抓假绿窗口:删卡与 persist 间崩溃/异常路径残留时,盘上
            // 卡与 state.json 可能失配——卡说等人而该步已终态）。卡的 step_id 在 state.json
            // 里必须仍是 running（暂停态的编码判据,^anc-exec-pause-persist"卡是递送件非状态
            // 源"——状态源说了算）;失配即陈卡,不报 paused,如实指路完整恢复。
            const statePath = join(instDir, 'state.json');
            if (existsSync(statePath)) {
              const st = JSON.parse(readFileSync(statePath, 'utf-8')) as { step_states?: Record<string, string> };
              const cardStep = String(card['step_id'] ?? '');
              // dirs 卡（step_id 空）与引擎 getStatus 源⑥同判：账已批即陈卡（approveDirs 会删卡,此支只在删卡与进程退出之间崩溃时命中）// @a: anc-exec-dirs-grant
              if (card['pause_reason'] === 'dirs') {
                try {
                  const eng = ExecutionEngine.load(instDir);
                  const g = eng.checkDirsApproval();
                  if (!g || g.approved) return { error: { code: 'RUN_NOT_FOUND', message: `run '${runId}' 不在注册表;快照有 dirs 问题卡但清单已批准（陈卡,批准账为准）——用 resume_run 续跑` } };
                } catch { /* 载不起引擎就按卡报 */ }
              }
              if (cardStep && st.step_states?.[cardStep] !== 'running') {
                return { error: { code: 'RUN_NOT_FOUND', message: `run '${runId}' 不在注册表;快照有问题卡但其步骤 '${cardStep}' 已非等待态（陈卡,状态源 state.json 为准）——完整恢复用 resume_run` } };
              }
            }
            return { run_id: runId, status: 'paused', paused: card, restored_from_snapshot: true };
          } catch {
            return { error: { code: 'RESTORE_FAILED', message: `问题卡损坏或不可读（${cardPath}）——用 resume_run 走完整恢复,或人工检视快照` } };
          }
        }
        if (existsSync(join(instDir, 'state.json'))) {
          // 嵌套子实例卡下钻（32 轮 review——嵌套 call/parallel 的暂停卡落子实例目录,顶层
          // 无卡时点名它们:人能找到卡看问题;不冒充顶层 paused——恢复边界照旧（CallFrame 不随
          // 快照恢复,嵌套暂停经 resume_run 重跑整个 call,见 ^anc-mcp-run-restore 恢复边界）。
          const nestedCards: string[] = [];
          for (const sub of ['calls', 'parallel']) {
            const subDir = join(instDir, sub);
            if (!existsSync(subDir)) continue;
            try {
              for (const child of readdirSync(subDir)) {
                if (existsSync(join(subDir, child, 'paused.json'))) nestedCards.push(`${sub}/${child}/paused.json`);
              }
            } catch { /* 目录读失败不阻塞兜底报文 */ }
          }
          if (nestedCards.length > 0) {
            return { error: { code: 'RUN_NOT_FOUND', message: `run '${runId}' 不在注册表;顶层无问题卡但嵌套子实例有卡（${instDir} 下: ${nestedCards.join(', ')}）——嵌套暂停不可按顶层直接注入,resume_run 恢复后重跑该 call/子实例（恢复边界）;卡文件可直接读看问题` } };
          }
          // 快照不存 run 级终态,状态推导归引擎不塞兜底——兜底只做零成本读,不做半个恢复
          return { error: { code: 'RUN_NOT_FOUND', message: `run '${runId}' 不在注册表;快照在场（${instDir}）但无问题卡——非 HITL 暂停（运行中崩溃/网络暂停/旧版产物）,完整恢复用 resume_run` } };
        }
      }
      return { error: { code: 'RUN_NOT_FOUND', message: runId ? `run '${runId}' 不在注册表` : '省略 run_id 仅在恰有一个活跃（running/paused）run 时可用——用 list_runs 查全部' } };
    }
    // 在飞视图（统一模型收口 ^anc-mcp-run-status-inflight）：running 且账面有在飞时附
    // current_step + inflight 投影——纯读账面（不触发对账/收割/超时判定,readOnlyHint 忠实）；
    // 无并行 run 字段缺席（响应形状向后兼容）。// @a: anc-mcp-run-status-inflight
    let inflightView: Record<string, unknown> = {};
    if (entry.state === 'running' && typeof entry.dispatcher?.getEngine === 'function') {
      const account = entry.dispatcher.getEngine().getInflight();
      if (account.length > 0) {
        inflightView = {
          current_step: entry.dispatcher.getEngine().getStatus().current_step,
          inflight: account.map(f => ({ child: f.child_instance, step: f.step_id, status: f.status, dispatched_at: f.dispatched_at })),
        };
      }
    }
    // 子实例 HITL 待答队列（U4b 方案 A 全量呈现,0013）：全部待答卡数组,每张携 child_instance
    // 寻址;running（主线还在推进）与 paused（只剩等人）都附带。// @a: anc-exec-parallel-hitl-queue
    const pq = entry.dispatcher?.getPausedChildren?.();
    const queueView = pq && pq.size > 0
      ? { paused_queue: [...pq.values()].map(x => x.pause) }
      : {};
    // token 统计透出（^anc-mcp-run-status-inflight token 条,todo/0023）：纯暴露引擎内存账,
    // 0 值缺席不出字段（向后兼容）。// @a: anc-mcp-run-status-inflight
    const tokens = typeof entry.dispatcher?.getEngine === 'function' ? entry.dispatcher.getEngine().getCumulativeTokens() : 0;
    // 串行 call 链投影（^anc-mcp-run-status-inflight call_chain 条,todo/0011①）：running 且
    // 有在飞 call 时附全链——递归子树烧到哪层哪步实时可见;无在飞 call 缺席（向后兼容）。
    // @a: anc-mcp-run-status-inflight
    const callChain = entry.state === 'running' && typeof entry.dispatcher?.getCallChain === 'function' ? entry.dispatcher.getCallChain() : [];
    // completed 一致性核（hopissues/0093 注册表命中半边——与快照兜底路径同判据同字段;
    // engine 在场直调检测器）。// @a: anc-exec-completed-consistency
    const liveInconsistency = entry.state === 'completed' && typeof entry.dispatcher?.getEngine === 'function'
      ? entry.dispatcher.getEngine().detectCompletedInconsistency?.() ?? null : null;
    // 实例峰值上下文水位透出（^anc-exec-ctx-watermark——0095 看护与人一眼可见"往墙上走"）
    // @a: anc-exec-ctx-watermark
    const ctxWatermark = typeof entry.dispatcher?.getCtxWatermark === 'function' ? entry.dispatcher.getCtxWatermark() : 0;
    return {
      run_id: entry.runId,
      status: entry.state,
      ...(tokens > 0 ? { cumulative_tokens: tokens } : {}),
      ...(ctxWatermark > 0 ? { ctx_watermark: ctxWatermark } : {}),
      ...(callChain.length > 0 ? { call_chain: callChain } : {}),
      ...inflightView,
      ...queueView,
      ...(entry.paused ? { paused: entry.paused } : {}),
      ...(entry.outputs ? { outputs: entry.outputs } : {}),
      ...(entry.failure ? { failure: entry.failure } : {}),
      ...(liveInconsistency ? { inconsistency: liveInconsistency } : {}),
    };
  }

  // server 重启后 paused run 恢复：runId 不在内存注册表时从 .hopstate/<runId>/ 快照重建。
  // Provider 是运行时对象不可序列化——完整 HostConfig 恢复=用 server 当前 config 重新注入
  // （凭证链在新 Dispatcher 构造时重走）；paused 载荷由首次 nextStep 重算（^anc-exec-pause-persist）。
  // 见 design/mcp-server.md ^anc-mcp-run-restore。// @a: anc-mcp-run-restore
  private restoreRun(runId: string, stateDir?: string): RunEntry | { error: Record<string, unknown> } {
    const instanceDir = resolve(stateDir ?? '.hopstate', runId);
    if (!existsSync(join(instanceDir, 'state.json'))) {
      return { error: { code: 'RUN_NOT_FOUND', message: `run '${runId}' 不在注册表且无快照（${instanceDir}）` } };
    }
    // aborted 墓碑门（^anc-mcp-stop-run 第4条）：stop_run 中止过的 run 拒绝复活——中止是
    // 跨重启的终局,快照仅供人工检视。无此门则重启后 resume_run 会把 aborted run 恢复成
    // paused 一路跑到自然终态含 commit 不可逆操作。// @a: anc-mcp-stop-run
    if (existsSync(join(instanceDir, 'aborted.json'))) {
      return { error: { code: 'RUN_ABORTED', message: `run '${runId}' 已被 stop_run 主动中止（终局,不可恢复）——快照在 ${instanceDir} 仅供人工检视` } };
    }
    // 恢复要用 provider 构造 Dispatcher——独立模式不可用时拒,快照不动（^anc-mcp-server-status）// @a: anc-mcp-server-status
    const unavailable = this.standaloneUnavailable();
    if (unavailable) return unavailable as { error: Record<string, unknown> };
    const config = this.config!;
    let engine: ExecutionEngine;
    try {
      engine = ExecutionEngine.load(instanceDir);   // load 保留 running（paused 的 confirm/ask 即 running 态）
    } catch (err: unknown) {
      return { error: { code: 'RESTORE_FAILED', message: `快照损坏或不可读: ${err instanceof Error ? err.message : String(err)}` } };
    }
    let dispatcher: StepDispatcher;
    let specPath: string | null;
    try {
      // BUG-I 修（A 案）：配置读取根随快照钉住——run 启动时的项目根从 host_context 读回,
      // 以它为 projectDir 重读两级配置（server 启动配置的 cwd 可能≠run 的项目根:MCP server 的
      // cwd 由宿主会话定,重启后漂移则项目级 hopjit.yaml 整节丢,工具面装空——hopkb tidy 实撞,
      // 2026-08-15 现场认领嫌疑①）。配置仍是活的:改 hopjit.yaml 恢复即生效。HOPJIT_CONFIG
      // 显式指定时维持单文件语义不重读。pinnedDir 缺席（旧快照）回退 server 当前配置。
      // @a: anc-mcp-run-restore
      const pinnedDir = engine.getRestoredConfigProjectDir();
      // 重读面=项目级 hopjit.yaml（按钉住根,与 startRun 对称同一函数——语义四条见
      // reloadProjectConfig 注）。pinnedDir 缺席（旧快照）回退 server 当前配置。
      let restoreConfig = config;
      if (pinnedDir) {
        const reloaded = reloadProjectConfig(config, pinnedDir);
        if ('error' in reloaded) return { error: reloaded.error };
        restoreConfig = reloaded.config;
      }
      const provider = restoreConfig.providers[0];
      // 作业对象根随快照钉住（与 config_project_dir 钉根同款——显式 workspace_dir 的 run
      // 重启恢复不漂回 server cwd）;旧快照缺席回退 server cwd。// @a: anc-mcp-run-restore
      const restoreCwd = engine.getRestoredWorkspaceDir() ?? process.cwd();   // 组合根一次读取 // @a: anc-run-isolation
      const hostConfig = providerToHostConfig(provider, restoreCwd, restoreConfig.commands);   // restoreConfig 已按 pinnedDir 重读——项目级 commands 生效(review F2 同修) // @a: anc-exec-subprocess-run
      if (restoreConfig.resource_limits) {
        hostConfig.resource_limits = { ...(hostConfig.resource_limits ?? {}), ...restoreConfig.resource_limits } as typeof hostConfig.resource_limits;   // @a: anc-config-standalone-schema
      }
      hostConfig.config_project_dir = pinnedDir ?? restoreCwd;
    // 外部工具注册（批次二）：tools_file 加载进宿主契约——装配/预检同源消费。加载失败同 startRun 结构化 error。
    // @a: anc-config-tool-registry
    if (restoreConfig.tool_servers?.length) {
      try {
        hostConfig.tool_registry = parseToolServers(structuredClone(restoreConfig.tool_servers), pinnedDir ?? restoreCwd);   // 深拷贝分发 // @a: anc-run-isolation
      } catch (err: unknown) {
        return { error: { code: 'TOOLS_FILE_INVALID', message: err instanceof Error ? err.message : String(err) } };
      }
    }
    // BUG-I 修（B 闸,与 A 叠加）：恢复后工具面预检——spec 所需 ⊆ 装配面,缺了响亮拒绝恢复
    // （快照未动,配好 tool_servers 可重试）,不再让残废 run 活到下一次工具调用才 TOOL_EXEC_ERROR。
    // @a: anc-mcp-run-restore
    {
      const restoredAst = engine.getSpec();
      if (restoredAst) {
        const needed = collectSpecTools(restoredAst.steps ?? []);
        let available: Set<string>;
        try {
          available = new Set(new CompositeToolProvider(hostConfig).list().map(t => t.name));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = msg.startsWith('TOOLS_NAME_CONFLICT') ? 'TOOLS_NAME_CONFLICT' : 'TOOLS_ASSEMBLY_FAILED';
          return { error: { code, message: msg } };   // 恢复路径同款（0005——两构造点同批包裹）
        }
        const missing = [...needed].filter(t => !available.has(t));
        if (missing.length > 0) {
          return { error: { code: 'TOOLS_UNAVAILABLE', message: `恢复后工具面不足,缺: ${missing.join(', ')}——run 启动时的项目根 ${pinnedDir ?? '(旧快照未记)'} 下 tool_servers 配置是否在位?（快照未动,配好可重试 resume）` } };
        }
      }
    }
      specPath = engine.getSpecPath();
      if (specPath) {
        hostConfig.spec_provider ??= new DirSpecProvider(dirname(specPath), antRoots(homedir(), hostConfig.workspace_dir));
        // spec 目录读授权恢复（init 组合点同款——setHostConfig 用新构造沙箱盖掉快照恢复的,
        // 不重加则恢复后 doc-ref 第一级候选拒读）。// @a: anc-exec-doc-ref-resolve
        const specDir = dirname(resolve(specPath));
        if (!hostConfig.sandbox.filesystem.read_access.allowed.includes(specDir)) {
          hostConfig.sandbox.filesystem.read_access.allowed.push(specDir);
        }
      }
      // restore 同构造 env 快照（run 隔离——顺带修隐性依赖 bug:旧实现 restore 不写 env,
      // 非默认 service 凭证依赖"此前某 startRun 写过进程 env"的残留,server 重启直 restore 即缺）。
      // 构造同 startRun 单点 buildEnvSnapshot（0008③键集单一语义）。// @a: anc-run-isolation
      hostConfig.env_snapshot = buildEnvSnapshot(config, snapshotProviderKeys(config));
      // 模型路由随恢复同装（todo/0084 M3——原 restore 漏装 model_engine,恢复的 run 路由静默
      // 回落 providers[0];构造单点 buildModelEngine 与 startRun 同调,用重读合并后配置）。
      // @a: anc-exec-model-routing
      hostConfig.model_engine = this.buildModelEngine(restoreConfig);
      // 修订供给档随恢复同装（^anc-exec-revision-short-weak——原 restore 漏装,恢复的 short 档
      // run 静默回落 standard;0084 M3 restore 漏装 model_engine 同型前车。恢复档位跟随盘上
      // 配置现值,env 覆盖同 startRun 精度链）。// @a: anc-exec-revision-short-weak
      {
        const envRp = process.env['HOPJIT_REVISION_PROMPT']?.toLowerCase();
        engine.setRevisionPromptMode((envRp === 'short' || envRp === 'standard') ? envRp : (restoreConfig.revision_prompt ?? 'standard'));
      }
      hostConfig.language = effectiveLanguage(restoreConfig.language);   // 与 startRun 对齐（M4 随批;键缺席跟随系统语言 todo/0160） // @a: anc-i18n-serialize-lang
      // hop_env restore 合成：配置 env 节打底,快照恢复表覆盖（host_context 持久化了原 run 的
      // params 覆盖与 ask 回填——它是覆盖链更下游产物,配置重合成会丢）。声明根同扩读白名单。
      // env 打底换重读面（todo/0084 M4——原用启动期 config.env,同函数内 tool_servers/
      // commands/resource_limits 皆重读面唯 env 启动快照,三节两种口径;并补 hop_env_language
      // 打底与 startRun 对齐）。// @a: anc-config-hop-env, anc-exec-doc-ref-hop-env
      const restoredHopEnv = { hop_env_language: hostConfig.language, ...(restoreConfig.env ?? {}), ...(engine.getRestoredHopEnv() ?? {}) };
      if (Object.keys(restoredHopEnv).length) {
        hostConfig.hop_env = restoredHopEnv;
        for (const v of Object.values(restoredHopEnv)) {
          if (isAbsolute(v) && !hostConfig.sandbox.filesystem.read_access.allowed.includes(v)) {
            hostConfig.sandbox.filesystem.read_access.allowed.push(v);
          }
        }
      }
      // 引擎重建后需重接 hostConfig（load 只恢复 host_context 子集）
      engine.setHostConfig(hostConfig);
      // Config.dirs 两白名单随恢复重建（新构造沙箱没有 write_access,read_access 也缺并入的目录——不重建则恢复后 commit 写 readwrite 被拒）。// @a: anc-exec-dirs-grant
      const dd = engine.getDeclaredDirs();
      if (dd) {
        for (const d of [...dd.read, ...dd.readwrite]) if (!hostConfig.sandbox.filesystem.read_access.allowed.includes(d)) hostConfig.sandbox.filesystem.read_access.allowed.push(d);
        if (dd.readwrite.length) hostConfig.sandbox.filesystem.write_access = { allowed: [...new Set([...(hostConfig.sandbox.filesystem.write_access?.allowed ?? []), ...dd.readwrite])] };
      }
      dispatcher = new StepDispatcher(engine, hostConfig);   // 构造时回填 cumulative_tokens（预算延续）
    } catch (err: unknown) {
      // 凭证缺失/Dispatcher 构造失败——结构化返回,不炸 server（快照未动,配好凭证可重试）
      return { error: { code: 'RESTORE_FAILED', message: err instanceof Error ? err.message : String(err) } };
    }
    // paused 的 confirm/ask 步骤在快照里即 running 态——resume 注入答案时 completeStep 直接消化
    // （^anc-exec-pause-persist 恢复路①），无需重算载荷（caller 手里留着暂停响应的 step_id）
    const entry: RunEntry = {
      runId, specPath: specPath ?? '(restored)', state: 'paused',
      dispatcher, startedAt: new Date().toISOString(),
    };
    this.runs.set(runId, entry);
    return entry;
  }

  // 过时账预检（^anc-exec-state-seq-guard MCP 侧接线）:本进程注册项的引擎账已被另一个进程写得更新 →
  // 返回 STATE_STALE 结构化错误、不改任何状态。非 running 的注册项移出注册表——同一进程下一次
  // resume_run 走 restoreRun 从盘上重新加载（兑现报文指路）;running 的不移出,在飞 dispatcher
  // 下次写盘自己撞 STATE_STALE 转 failed。// @a: anc-exec-state-seq-guard
  private rejectIfStale(runId: string, entry: RunEntry): Record<string, unknown> | null {
    try { entry.dispatcher?.getEngine?.()?.assertStateFresh?.(); return null; }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.startsWith('STATE_STALE:')) throw err;
      if (entry.state !== 'running') this.runs.delete(runId);
      return { error: { code: 'STATE_STALE', message } };
    }
  }

  resumeRun(runId: string, stepId: string, answer: Record<string, unknown>, stateDir?: string, childInstance?: string): Record<string, unknown> {
    let entry = this.runs.get(runId);
    if (!entry) {
      const restored = this.restoreRun(runId, stateDir);
      if ('error' in restored) return restored as Record<string, unknown>;
      entry = restored as RunEntry;
    }
    // 独立模式 run 的续跑要用 provider——config 为 null 时拒（^anc-mcp-server-status）。// @a: anc-mcp-server-status
    const unavailableOnResume = this.standaloneUnavailable();
    if (unavailableOnResume) return unavailableOnResume;
    // 同通道两进程的过时账预检（todo/0114）:在通道核对（会认领）与一切状态翻转之前。// @a: anc-exec-state-seq-guard
    const staleOnResume = this.rejectIfStale(runId, entry);
    if (staleOnResume) return staleOnResume;
    // 双执行硬闸:跨通道推进拒（restore 的 cli 建 run 在此被拦;旧 run 缺席即认领）
    // @a: anc-exec-driver-channel
    try { entry.dispatcher?.getEngine?.()?.claimDriverChannel?.('mcp'); }
    catch (err) { return { error: { code: 'DRIVER_CHANNEL_MISMATCH', message: err instanceof Error ? err.message : String(err) } }; }
    const hasQueue = (entry.dispatcher?.getPausedChildren?.()?.size ?? 0) > 0;
    if (entry.state !== 'paused' && !(childInstance && hasQueue)) {
      // U4b:主线还在跑（running）但队列有待答卡时,child_instance 路由照答——等主线停下
      // 才能答=队列白建。非 child 路由维持原判。// @a: anc-exec-parallel-hitl-queue
      return { error: { code: 'INVALID_STATE', message: `run '${runId}' 状态 ${entry.state}，非 paused${childInstance ? ' 且待答队列无此卡' : ''}——不能 resume` } };
    }
    // child_instance 同步核对在状态翻转之前（todo/0105 缺陷 B,兑现 hopissues/0094 期望行为第 ② 条）：
    // 待答队列无此卡、在飞账上也无该 child 的 paused 项（跨进程恢复路）→ 当场拒,run 原样 paused。
    // 此前先置 running 同步回 {status:'running'},dispatcher 异步拒收后才复原——调用方只见假 running。
    // 拒因文字与 dispatcher 异步拒收分支同源（childNotInQueueMessage）。// @a: anc-exec-parallel-hitl-queue
    if (childInstance) {
      const inQueue = entry.dispatcher?.getPausedChildren?.()?.has(childInstance) ?? false;
      const inAcct = (entry.dispatcher?.getEngine?.()?.getInflight?.() ?? []).some(f => f.child_instance === childInstance && f.status === 'paused');
      if (!inQueue && !inAcct) {
        return { error: { code: 'CHILD_NOT_IN_QUEUE', message: childNotInQueueMessage(childInstance) } };
      }
    }
    // step_id 校验在状态变更前（design v0.3.1 review P1）：不一致即拒且保持 paused——
    // 坏输入不毁可恢复态（实撞：错误 step_id 曾先回 running 随后永久 failed）。
    // child_instance 路由（U4b 队列应答）跳过本预检——目标卡在队列里,step_id 一致性由
    // dispatcher 按队列句柄判（卡不在队即结构化拒）。// @a: anc-exec-parallel-hitl-queue
    const pausedStepId = entry.paused?.step_id;
    if (!childInstance && pausedStepId !== undefined && stepId !== pausedStepId) {
      return { error: { code: 'INVALID_STATE', message: `step_id '${stepId}' 与暂停点 '${pausedStepId}' 不一致——run 保持 paused，用 run_status 取正确 step_id` } };
    }
    // 恢复的 run 无 paused 载荷（重启后内存丢失）——改按 spec 校验 step_id 指向真实的 confirm/ask，
    // 同一原则：坏输入拒于状态变更前。嵌套 call 内的暂停不可按 stepId 直达（CallFrame 未随快照
    // 恢复，^anc-mcp-run-restore 恢复边界）——父 spec 找不到该步即拒，提示重跑 call。
    if (entry.paused === undefined) {
      const findStep = (steps: StepNode[]): StepNode | null => {
        for (const s of steps) {
          if (s.step_id === stepId) return s;
          const found = findStep(getChildren(s));
          if (found) return found;
        }
        return null;
      };
      const node = findStep(entry.dispatcher.getEngine().getSpec()?.steps ?? []);
      // 网络暂停步放行（33 轮 review 探针实抓:pause_reason:'network' 的步是普通步〔reason/act〕,
      // 预检只认 confirm/ask 把它拒死——detach 断网暂停的 run 跨进程永远续不了跑;dispatcher.resume
      // 的免答通道判据〔network_pause 事件+pending〕本就齐备,预检按同判据放行即可。
      // ^anc-exec-network-pause 三通路的跨进程一路）。// @a: anc-exec-network-pause
      const eng = entry.dispatcher.getEngine();
      const isNetworkPaused = node && eng.getExecEvents().some(e => e.step_id === stepId && e.event === 'network_pause')
        && eng.getStepStates().get(stepId) === 'pending';
      // 崩溃恢复分支（#52,dr20 实撞:server 死时 run 正在 call 推进,原三停点预检拒死纯崩溃态
      // ——MCP run 只能弃而 CLI resume 本有同语义,通道能力不对称）：step_id 在快照里为
      // running（悬空崩溃步——机械判据）→ 悬空重置+resumeSpec 异步续跑,answer 忽略
      //（崩溃恢复无问题在答）。design ^anc-mcp-run-restore 运行中崩溃恢复条款。
      // @a: anc-mcp-run-restore, anc-exec-crash-recovery
      const isEscalatePaused = node && eng.getEscalatePending?.() === stepId;   // 升层待答跨进程放行 // @a: anc-exec-check-escalate
      // commit 批准停点先于崩溃悬空判:running 的 commit 步骤放行给下方批准核对与 dispatcher.resume 的 commit 分支,
      // 不当悬空步重置（^anc-mcp-run-restore 恢复分支,todo/0146）。// @a: anc-exec-commit-approval
      const isCommitPause = node && node.step_type === 'commit' && eng.getStepStates().get(stepId) === 'running';
      const isCrashDangling = node && eng.getStepStates().get(stepId) === 'running'
        && node.step_type !== 'confirm' && node.step_type !== 'ask' && !isEscalatePaused && !isCommitPause;
      if (isCrashDangling) {
        eng.recoverDanglingRunning();
        entry.state = 'running';
        entry.paused = undefined;
        void entry.dispatcher.resumeSpec()
          .then(r => this.applyResult(entry, r))
          .catch(err => {
            if (entry.state === 'aborted') return;
            entry.state = 'failed';
            entry.failure = { step_id: '?', reason: err instanceof Error ? err.message : String(err) };
            this.maybeNotify(entry);   // 崩溃恢复失败同挂（阅卷缺口 B） // @a: anc-mcp-notify-hook
          });
        return { run_id: runId, status: 'running', recovered_from_crash: true };
      }
      if (!node || (node.step_type !== 'confirm' && node.step_type !== 'ask' && !isNetworkPaused && !isEscalatePaused && !isCommitPause)) {
        return { error: { code: 'INVALID_STATE', message: `step_id '${stepId}' 不是本 spec 的 confirm/ask 步骤,也非网络暂停步,也非悬空崩溃步——恢复的 run 只支持顶层暂停点注入或崩溃步重跑（嵌套 call 的暂停随恢复重跑整个 call）` } };
      }
    }
    // commit 批准停点的同步核对:未批准即当场拒,run 保持 paused（不翻 running 再异步回滚——调用方要看到明确错误）。
    // ^anc-mcp-commit-approve / ^anc-exec-commit-approval。// @a: anc-exec-commit-approval
    if (!childInstance) {
      const eng = entry.dispatcher?.getEngine?.();
      const approval = eng?.getStepStates?.().get(stepId) === 'running' ? eng.checkCommitApproval?.(stepId) : null;
      if (approval && !approval.approved) {
        return { error: { code: 'COMMIT_NOT_APPROVED', message: commitNotApprovedMessage(stepId, approval.fingerprint, runId), step_id: stepId, fingerprint: approval.fingerprint } };
      }
    }
    // 嵌套 call 的暂停帧：call_path 由 server 从暂停载荷原样回传（caller 无需感知调用链），
    // dispatcher 剥头下钻直达挂起帧。见 design ^anc-exec-call-recursion。// @a: anc-exec-call-recursion
    const callPath = entry.paused?.call_path;
    const prevPaused = entry.paused;   // 拒收时恢复原暂停载荷（0016——run 回 paused 可修正重试）
    entry.state = 'running';
    entry.paused = undefined;
    // 与 start_run 同为 job 式异步：resume 后是多次 LLM 调用（分钟级），同步等待
    // 必顶爆 MCP 工具超时（真机验收实撞）。注入后立即返回，进度轮询 run_status。
    void entry.dispatcher.resume(stepId, answer, callPath, childInstance)
      .then(r => {
        // answer 被拒（0016）：run 回 paused（原载荷恢复,仍在等注入）+failure 携原始错误码与
        // 指路——run_status 呈现 paused+failure 组合='答案被拒,原因在此,可修正重试'
        //（修前:结构化错误被吞,run 被錘 failed 终态且 reason 恒'No executable step found'）。
        if (r.rejected) {
          // aborted 钉住（^anc-mcp-stop-run 第2条第四口）：rejected 回调虽为微任务级（与下一条
          // stdio 消息的 stop_run 理论无交叠）,同 applyResult 姿态守一道不依赖时序论证;
          // 与另三口同律只做资源收尾——收 tool provider（0156 B5 补,此前此口漏 close）。
          if (entry.state === 'aborted') {   // @a: anc-mcp-stop-run
            const tpR = entry.dispatcher?.getToolProvider?.() as { close?: () => Promise<void> } | undefined;
            if (typeof tpR?.close === 'function') void tpR.close();
            return;
          }
          entry.state = 'paused';
          entry.paused = prevPaused;
          entry.failure = { step_id: stepId, reason: `${r.rejected.code}: ${r.rejected.message}` };
          return;
        }
        this.applyResult(entry, r);
      })
      .catch(err => {
        // aborted 钉住（^anc-mcp-stop-run 第2条）：迟到异常不改写终局,只收工具 server。
        if (entry.state === 'aborted') {
          const tpA = entry.dispatcher?.getToolProvider?.() as { close?: () => Promise<void> } | undefined;
          if (typeof tpA?.close === 'function') void tpA.close();
          return;   // @a: anc-mcp-stop-run
        }
        entry.state = 'failed';
        entry.failure = { step_id: stepId, reason: err instanceof Error ? err.message : String(err) };
        // failed-via-throw 收 server（0007①——resume 路径同病同修）
        const tp = entry.dispatcher?.getToolProvider?.() as { close?: () => Promise<void> } | undefined;
        if (typeof tp?.close === 'function') void tp.close();
        this.maybeNotify(entry);   // resume 异常失败同挂（阅卷缺口 B） // @a: anc-mcp-notify-hook
      });
    return { run_id: runId, status: 'running' };
  }

  // 在某个 run 的上下文里执行一条**任务卡已批准**的命令（todo/0132 承接 hopissues/0114——/hop 复用模式下
  // driver 每条命令过载体权限闸,同类动作反复弹窗;作者定"根据任务来批准,而不是放开一个大口子"）。
  // 不认 hopjit.yaml commands:（那是引擎自己执行 body 时的项目级白名单,本入口是外部 agent 发起的,粒度
  // 必须到任务）;不重建 engine/hostConfig/注册表——纯 readState + readSpec + spawnSync + append（作者定
  // "就是执行一步而已"）。人工闸不放宽:只替代"载体逐条弹窗"这一层。八步契约见 [[mcp-server#^anc-mcp-run-command]]。
  // @a: anc-mcp-run-command
  runCommand(args: { state_dir?: string; instance_id: string; argv: string[]; cwd?: string; timeout_sec?: number; caller_step?: string }): Record<string, unknown> {
    const instDir = resolve(args.state_dir ?? '.hopstate', args.instance_id);
    if (!stateExists(instDir)) return { error: { code: 'INSTANCE_NOT_FOUND', message: `实例 '${args.instance_id}' 在 ${instDir} 下没有快照——state_dir 要传该 run 起跑时用的目录（start_run 返回值里有绝对路径）` } };
    let approved: string[][];
    let state: ReturnType<typeof readState>;
    try {
      const spec = readSpec(instDir) as { header?: { approved_commands?: string[][] } };
      approved = spec.header?.approved_commands ?? [];
      state = readState(instDir);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: { code: 'CORRUPT_STATE_FILE', message: msg } };   // readSpec/readState 对不可读/非 JSON/非对象一律抛 CORRUPT_STATE_FILE 前缀（persistence parseChecked）——review 面三补钉时发现原 STATE_READ_FAILED 分支是死代码,删
    }
    const argv = args.argv;
    if (!Array.isArray(argv) || argv.length === 0) return { error: { code: 'APPROVAL_REQUIRED', message: 'argv 为空——命令写成 argv 列表（不拼 shell 字符串）,首项是命令名' } };
    if (argv[0] === 'hopjit' || argv[0].split('/').pop() === 'hopjit') {   // 恒拒先于匹配——否则拒绝报文会教人把 hopjit 写进卡（parser 又会拒）
      return { error: { code: 'COMMAND_FAILED', message: `${RUN_APPROVED_COMMAND_TOOL} 不得执行 hopjit——步骤内容不驱动引擎（自嵌套执行会破坏状态账）;写进《已批准命令》也无效（解析期即拒）。跑别的 spec 用 [call <Id>] 步骤` } };
    }
    const hit = approved.some(p => p.length > 0 && p.length <= argv.length && p.every((t, i) => t === argv[i]));
    if (!hit) {
      const shown = argv.slice(0, 3).join(' ') + (argv.length > 3 ? ' …' : '');
      const listed = approved.length ? approved.map(p => '  - ' + p.join(' ')).join('\n') : '  （本任务卡没有《已批准命令》节或节为空）';
      return { error: { code: 'APPROVAL_REQUIRED', message: `命令 "${shown}" 不在本任务卡《已批准命令》里。卡上现有前缀:\n${listed}\n这是任务授权范围要不要扩的问题,请停下问用户：批则在任务卡的 \`## 已批准命令\` 节加一行 \`- ${argv.slice(0, Math.min(argv.length, 2)).join(' ')}\`（一行一个 argv 前缀,逐项相等地以它开头的命令放行）后重起 run;不批则这一条走载体自己的审批。不要自己把命令加进卡,不要换通道绕过` } };   // 报文与 description、/hop skill 同口径（review 面二抓首版并列'改走 Bash'无'归人决定'）
    }
    const ws = (state as { host_context?: { workspace_dir?: string } }).host_context?.workspace_dir;
    // cwd 只做绝对化不判越界——授权本体是上面的 argv 前缀匹配,worktree / 临时区都是正当工作面（2026-10-09 todo/0152 撤越界闸,理由见设计 ^anc-mcp-run-command「撤闸记录」）
    const cwdEff = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(ws ?? process.cwd(), args.cwd)) : (ws ?? process.cwd());
    const timeoutSec = Math.min(Math.max(1, Math.floor(args.timeout_sec ?? RUN_COMMAND_TIMEOUT_DEFAULT_SEC)), RUN_COMMAND_TIMEOUT_MAX_SEC);
    const t0 = Date.now();
    let r: { stdout: string; stderr: string; returncode: number };
    try {
      r = runWhitelistedCommand(argv, { whitelist: [argv[0]], cwd: cwdEff, timeoutSec, maxBuffer: 4 * 1024 * 1024, label: RUN_APPROVED_COMMAND_TOOL });
    } catch (e) {
      return { error: { code: 'COMMAND_FAILED', message: e instanceof Error ? e.message : String(e) } };
    }
    const duration_ms = Date.now() - t0;
    const LIMIT = 64 * 1024;
    const stdoutBytes = Buffer.byteLength(r.stdout, 'utf-8');
    const stderrBytes = Buffer.byteLength(r.stderr, 'utf-8');
    const cut = (s: string, bytes: number) => bytes > LIMIT ? Buffer.from(s, 'utf-8').subarray(0, LIMIT).toString('utf-8') + `\n…[已截断:原 ${bytes} 字节,回给调用方上限 ${LIMIT} 字节;账里记原字节数]` : s;
    const truncated = { stdout: stdoutBytes > LIMIT, stderr: stderrBytes > LIMIT };
    const rec = { argv, cwd: cwdEff, returncode: r.returncode, duration_ms, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, truncated, ...(args.caller_step ? { caller_step: args.caller_step } : {}) };
    const hoplogDir = (state as { hoplog_run_dir?: string }).hoplog_run_dir;
    let account_error: string | undefined;
    try {
      if (hoplogDir && existsSync(hoplogDir)) {
        HopLog.resume(hoplogDir).recordCommand(rec);   // 跨进程续写,先冲 resume marker 再落顶层 command: 块（^anc-obs-command-block）
      } else {
        appendFileSync(join(instDir, 'commands.log'), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');   // hoplog 关着或目录已被轮转删掉时的兜底账
      }
    } catch (e) {
      account_error = `记账失败（命令已执行,结果如下;账未落盘）: ${e instanceof Error ? e.message : String(e)}`;   // 不抛——调用方必须拿到已执行命令的结果
    }
    return { returncode: r.returncode, stdout: cut(r.stdout, stdoutBytes), stderr: cut(r.stderr, stderrBytes), duration_ms, truncated, ...(account_error ? { account_error } : {}) };
  }

  /** approve_commit:安全分析转人工后,把人的选择（once 只批准这一次 / task 这一步以后都通过）记入批准账,不推进 run。
   * 本进程注册表里的独立模式 run 用其内存引擎,否则从快照 load（不认领通道）。见 [[mcp-server#^anc-mcp-commit-approve]]。
   * // @a: anc-mcp-commit-approve */
  approveCommit(args: { instance_id: string; step_id: string; fingerprint: string; scope: string; state_dir?: string; workspace_dir?: string; child_instance?: string }): Record<string, unknown> {
    if (args.scope !== 'once' && args.scope !== 'task') return { error: { code: 'INVALID_ARG', message: 'scope 只能是 once 或 task' } };
    try {
      const ws = driverContext(args.workspace_dir).workspace_dir;   // 与驱动工具同一规则:显式传了但不存在 → WORKSPACE_NOT_FOUND
      const instanceDir = resolveInstance(resolve(ws, args.state_dir ?? '.hopstate'), args.instance_id);
      const entry = this.runs.get(args.instance_id);
      let engine: ExecutionEngine;
      if (args.child_instance) {
        // 子实例的指纹按子实例作用域里的输入算,只能在子实例引擎上批;队列里的内存引擎优先——
        // 另 load 一份来批会推进盘上写入序号,内存那份续跑落盘撞 STATE_STALE // @a: anc-mcp-commit-approve
        const cid = args.child_instance;
        const queued = entry?.dispatcher?.getPausedChildren?.()?.get(cid)?.engine;
        if (queued) engine = queued;
        else {
          const childDir = ['parallel', 'calls'].map(d => join(instanceDir, d, cid)).find(p => existsSync(join(p, 'state.json')));
          if (!childDir) throw new Error(`INSTANCE_NOT_FOUND: 实例 ${args.instance_id} 下没有子实例 ${cid}（查过 parallel/ 与 calls/）——child_instance 取 run_status 的 paused_queue 里那张卡的值`);
          engine = ExecutionEngine.load(childDir);
        }
      } else {
        engine = entry?.dispatcher?.getEngine?.() ?? ExecutionEngine.load(instanceDir);
      }
      const r = engine.approveCommit(args.step_id, args.fingerprint, args.scope);
      if (r.status === 'error') return { error: { code: r.code, message: r.message } };
      return r as unknown as Record<string, unknown>;
    } catch (err) {
      return driverErrorOf(err);
    }
  }

  /** approve_dirs:把某 run 的 Config.dirs 清单记入批准账,不推进 run。与 approveCommit 同形。见 [[mcp-server#^anc-mcp-dirs-approve]]。
   * // @a: anc-mcp-dirs-approve */
  approveDirs(args: { instance_id: string; dirs_hash: string; state_dir?: string; workspace_dir?: string }): Record<string, unknown> {
    try {
      const ws = driverContext(args.workspace_dir).workspace_dir;   // 与驱动工具同一规则:显式传了但不存在 → WORKSPACE_NOT_FOUND
      const instanceDir = resolveInstance(resolve(ws, args.state_dir ?? '.hopstate'), args.instance_id);
      const live = this.runs.get(args.instance_id)?.dispatcher?.getEngine?.();
      const engine = live ?? ExecutionEngine.load(instanceDir);
      const r = engine.approveDirs(args.dirs_hash);
      if (r.status === 'error') return { error: { code: r.code, message: r.message } };
      return r as unknown as Record<string, unknown>;
    } catch (err) {
      return driverErrorOf(err);
    }
  }

  listRuns(): Record<string, unknown> {
    return {
      runs: [...this.runs.values()].map(e => ({
        run_id: e.runId, status: e.state, spec_path: e.specPath, started_at: e.startedAt,
      })),
    };
  }

  // 主动中止 run（2026-08-22 作者定"hopjit 应该能自己杀自己的子任务"——此前失控 run 只能
  // 杀 server 重启会话止损）。running → 级联协作 abort（步间生效,不打断执行中单步）;
  // paused → 直接终局（无在飞活动）;终态 → 幂等返回现状。中止是终局不是暂停——不支持 resume,
  // 快照保留可人工检视。六条实施契约见 [[mcp-server#^anc-mcp-stop-run]]——注册表查不到时按
  // state_dir 快照兜底（第 6 条,hopissues/0117）。// @a: anc-mcp-stop-run
  stopRun(runId: string, stateDir?: string): Record<string, unknown> {
    const entry = this.runs.get(runId);
    if (!entry) return this.stopFromSnapshot(runId, stateDir);
    if (entry.state === 'completed' || entry.state === 'failed' || entry.state === 'aborted') {
      return { run_id: entry.runId, status: entry.state };   // 终态幂等
    }
    // 同通道两进程的过时账预检（todo/0114）:在通道核对与 requestAbortCascade/aborted.json 之前。// @a: anc-exec-state-seq-guard
    const staleOnStop = this.rejectIfStale(runId, entry);
    if (staleOnStop) return staleOnStop;
    // 双执行硬闸:跨通道中止拒（cli 建的 run 该经 hopjit abort）// @a: anc-exec-driver-channel
    try { entry.dispatcher?.getEngine?.()?.claimDriverChannel?.('mcp'); }
    catch (err) { return { error: { code: 'DRIVER_CHANNEL_MISMATCH', message: err instanceof Error ? err.message : String(err) } }; }
    const wasPaused = entry.state === 'paused';
    entry.dispatcher.requestAbortCascade();
    entry.state = 'aborted';
    entry.paused = undefined;
    entry.failure = { step_id: '(stop_run)', reason: 'aborted: caller 经 stop_run 主动中止' };
    // aborted 落盘（契约第4条,跨重启终局）：实例目录写墓碑标记 aborted.json——server 协议层
    // 标记,不改引擎 state.json 语义。不落盘则重启后 restoreRun 会把本 run 从快照复活成 paused
    // 一路跑到自然终态含 commit。写失败不阻塞中止（停内存执行是主职责,落盘是加固）。
    const instDir = entry.dispatcher?.getEngine?.()?.getInstanceDir?.();
    if (instDir) {
      try {
        writeFileSync(join(instDir, 'aborted.json'), JSON.stringify({ aborted_at: new Date().toISOString(), reason: 'caller 经 stop_run 主动中止' }, null, 2));
        // 问题卡随中止清除（34 轮 review——stop_run 是从 paused 到终局的唯一转移,等人窗口
        // 随之关闭;方案 B 下卡是一等实物、消费方可直接读文件,残卡会误导文件级消费方
        //〔API 面有墓碑优先兜着,文件面没有〕。^anc-exec-pause-persist 卡生命周期=等人窗口）。
        const cardPath = join(instDir, 'paused.json');
        if (existsSync(cardPath)) unlinkSync(cardPath);
      } catch (err: unknown) {
        console.error(`[hopjit-mcp] aborted 墓碑写入失败（${instDir}）: ${err instanceof Error ? err.message : String(err)}——中止仅内存生效,重启后该 run 或可被 resume`);
      }
    }
    // 工具通道收口分道（契约第5条）：paused run 无在飞循环,不会再有回调收尾——此处直接收;
    // running run 在飞那步可能还要用工具（"在飞的那步会跑完"承诺）,收口归钉住回调
    //（applyResult / startRun catch / resumeRun catch 的 aborted 分支,迟到结果到达时收）。
    if (wasPaused) {
      const tp = entry.dispatcher?.getToolProvider?.() as { close?: () => Promise<void> } | undefined;
      if (typeof tp?.close === 'function') void tp.close();
    }
    return { run_id: entry.runId, status: 'aborted' };
  }

  // stop_run 快照兜底（^anc-mcp-stop-run 第 6 条,hopissues/0117）：MCP server 重启后注册表清空,
  // 重启前停在 paused 的 run 只剩盘上快照。纯盘操作——不建注册项、不加载引擎、不读凭证;不做
  // STATE_STALE 预检（没有内存账可比）。别的活进程持有时拒,否则本进程写的墓碑停不了那边的执行。
  // 墓碑写失败如实报 STOP_WRITE_FAILED（快照路径墓碑就是中止的全部效果）。// @a: anc-mcp-stop-run
  private stopFromSnapshot(runId: string, stateDir?: string): Record<string, unknown> {
    const dir = resolve(stateDir ?? '.hopstate', runId);
    if (!existsSync(join(dir, 'state.json'))) {
      return { error: { code: 'RUN_NOT_FOUND', message: `run '${runId}' 不在注册表,快照目录 ${dir} 下也没有 state.json——run 以 workspace_dir 启动时须传 start_run 返回的 state_dir 绝对路径` } };
    }
    if (existsSync(join(dir, 'aborted.json'))) {
      return { run_id: runId, status: 'aborted', restored_from_snapshot: true };
    }
    let st: { terminal_state?: string; driver_channel?: string };
    try {
      st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')) as typeof st;
    } catch (err: unknown) {
      return { error: { code: 'RUN_NOT_FOUND', message: `run '${runId}' 的快照 ${join(dir, 'state.json')} 解析失败: ${err instanceof Error ? err.message : String(err)}` } };
    }
    if (st.terminal_state === 'completed' || st.terminal_state === 'failed' || st.terminal_state === 'aborted') {
      return { run_id: runId, status: st.terminal_state, restored_from_snapshot: true };   // 终态幂等,不写墓碑
    }
    const lw = readStateSeq(dir).last_writer;
    if (lw && lw.pid !== process.pid && pidAlive(lw.pid)) {
      return { error: { code: 'RUN_OWNED_ELSEWHERE', message: `run '${runId}' 的快照最后由进程 ${lw.pid} 写入（${lw.at}）,该进程仍存活——run 可能正在那个 hopjit 进程的注册表里执行,本进程写墓碑停不了那边的执行循环。请到那个进程所在的会话里调 stop_run;若确认 pid ${lw.pid} 已不是 hopjit 进程（pid 被系统复用）,结束该进程或等它退出后重试` } };
    }
    if (st.driver_channel != null && st.driver_channel !== 'mcp') {
      return { error: { code: 'DRIVER_CHANNEL_MISMATCH', message: `DRIVER_CHANNEL_MISMATCH: run 属 '${st.driver_channel}' 通道,本入口是 'mcp'——双执行防线拒绝跨通道推进。该 run 由 hopjit CLI 建立/驱动——用 hopjit abort 中止,不要经 MCP server` } };
    }
    try {
      writeFileSync(join(dir, 'aborted.json'), JSON.stringify({ aborted_at: new Date().toISOString(), reason: 'caller 经 stop_run 主动中止（注册表外,按快照兜底）' }, null, 2));
    } catch (err: unknown) {
      return { error: { code: 'STOP_WRITE_FAILED', message: `run '${runId}' 墓碑 ${join(dir, 'aborted.json')} 写入失败,中止没有生效: ${err instanceof Error ? err.message : String(err)}` } };
    }
    // 问题卡随墓碑清除;删不掉不算失败——墓碑优先,残卡不会被当成等人
    const cardPath = join(dir, 'paused.json');
    try { if (existsSync(cardPath)) unlinkSync(cardPath); }
    catch (err: unknown) { console.error(`[hopjit-mcp] 问题卡删除失败（${cardPath}）: ${err instanceof Error ? err.message : String(err)}——墓碑已落,不影响中止`); }
    return { run_id: runId, status: 'aborted', restored_from_snapshot: true };
  }

  private resolveRun(runId?: string): RunEntry | undefined {
    if (runId) return this.runs.get(runId);
    // 简写按活跃（running/paused）run 计数（design v0.3.1 review P2）：终态永久保留在
    // 注册表，按全部历史计数会让简写在首个 run 终态后即失效
    const active = [...this.runs.values()].filter(e => e.state === 'running' || e.state === 'paused');
    return active.length === 1 ? active[0] : undefined;
  }
}

// ── MCP 装配（stdio transport；工具响应 = 单 JSON text content）──

function jsonContent(data: Record<string, unknown>): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], ...(data['error'] ? { isError: true } : {}) };
}

/** 复用驱动工具 handler 的工作区根与上下文:workspace_dir 参数在场须是已存在目录,缺席取 server cwd;
 * 环境变量值在此（组合根）读一次传入。见 [[mcp-server#^anc-mcp-reuse-driver-tools]]。// @a: anc-mcp-reuse-driver-tools */
function driverContext(workspaceDir?: string): ReuseDriverContext {
  const ws = workspaceDir ? resolve(process.cwd(), workspaceDir) : process.cwd();
  if (workspaceDir && !existsSync(ws)) throw new Error(`WORKSPACE_NOT_FOUND: workspace_dir 不存在: ${ws}`);
  return {
    workspace_dir: ws,
    cli_abs_path: join(dirname(fileURLToPath(import.meta.url)), 'cli.js'),
    home: homedir(),
    api_key: process.env['HOPJIT_ANTHROPIC_API_KEY'] ?? '',
    hopjit_config: process.env['HOPJIT_CONFIG'] ?? '',
    context_mode_env: process.env['HOPJIT_CONTEXT_MODE'] ?? '',
  };
}

/** 复用驱动工具 handler 的统一外壳:组上下文 → 调驱动函数 → 结果或抛错都转成 JSON 文本内容（错误经 driverErrorOf 结构化,不炸 server）。
 * // @a: anc-mcp-reuse-driver-tools */
async function driverCall(workspaceDir: string | undefined, fn: (ctx: ReuseDriverContext) => unknown): Promise<ReturnType<typeof jsonContent>> {
  try {
    return jsonContent(await fn(driverContext(workspaceDir)) as Record<string, unknown>);
  } catch (err) {
    return jsonContent(driverErrorOf(err));
  }
}

/** 管理工具 handler 的机器侧事实（设计 HopSchema AdminContext,^anc-mcp-admin-tools）：workspace_dir 在场须是已存在目录,缺席取 server cwd;
 * home / env / exec_path / login / hostname 在此（组合根）读一次传入。// @a: anc-mcp-admin-tools */
function adminContext(workspaceDir?: string): AdminContext {
  const cwd = workspaceDir ? resolve(process.cwd(), workspaceDir) : process.cwd();
  if (workspaceDir && !existsSync(cwd)) throw new Error(`WORKSPACE_NOT_FOUND: workspace_dir 不存在: ${cwd}`);
  let login = '';
  try { login = userInfo().username; } catch { /* 容器里可能取不到 */ }
  const home = homedir();
  return { home, cwd, env: process.env, exec_path: process.execPath, login, hostname: hostname(), roots: antRoots(home, cwd) };
}

/** 管理工具 handler 的统一外壳：组上下文 → 调 hop-admin 函数 → 结果或抛错都转成 JSON 文本内容（错误经 driverErrorOf 结构化：HOPANT_* / PACK_ERROR / WORKSPACE_NOT_FOUND）。
 * // @a: anc-mcp-admin-tools */
function adminCall(workspaceDir: string | undefined, fn: (ctx: AdminContext) => unknown): ReturnType<typeof jsonContent> {
  try {
    return jsonContent(fn(adminContext(workspaceDir)) as Record<string, unknown>);
  } catch (err) {
    return jsonContent(driverErrorOf(err));
  }
}

/** server 装配：独立模式六工具 + 复用驱动七件 + approve_commit + approve_dirs + 管理八件 + server_status。core 与 transport 分离（决策注记：HTTP transport 演进出口）。
 * // @a: anc-mcp-tools */
// standalone 的全部对外形态在此装配（design/standalone-mode.md ^anc-struct-standalone-endpoint）：
// 一份 config + 一次注册 + 独立模式六个 MCP 工具。// @a: anc-struct-standalone-endpoint
export function buildServer(core: HopjitMcpCore): McpServer {
  const server = new McpServer({ name: 'hopjit', version: getEngineVersion() ?? '0.0.0' });

  server.registerTool('start_run', {
    description: '启动一个 HopSpec 规约的 standalone 执行（HopJIT 引擎直调 LLM API）。异步返回 run_id，用 run_status 查询进度。',
    // 注解=载体审批分级的判据输入：无注解会被 Codex exec 非交互审批层按最坏情况自动取消
    //（2026-08-10 实撞 'user cancelled MCP tool call'）。见 [[mcp-server#^anc-mcp-tools]] 注解条款。
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: {
      spec_path: z.string().describe('spec 文件路径（绝对或相对 server cwd 的显式路径）'),
      params: z.record(z.string(), z.unknown()).optional().describe('spec Inputs 实参'),
      state_dir: z.string().optional().describe('状态目录（默认 .hopstate;相对路径锚 workspace_dir——快照/hoplog/work_zone 三产物单一基准,返回值携带解析后绝对路径）'),
      workspace_dir: z.string().optional().describe('作业对象根（业务材料读+产出写+沙箱锚,默认 server cwd）——server cwd 非作业目录时显式传;显式路径不存在即拒'),
      dirs: z.object({ read: z.array(z.string()).optional(), readwrite: z.array(z.string()).optional() }).optional().describe('独立模式 Config.dirs 的唯一授权面：spec 声明的 workspace 之外目录,调用方显式传同一组绝对路径才算批准（缺即 INIT_FAILED 列缺的;多传的不授权）——^anc-mcp-dirs-approve'),
    },
  }, async ({ spec_path, params, state_dir, workspace_dir, dirs }) => jsonContent(await core.startRun(spec_path, params, state_dir, workspace_dir, dirs)));

  server.registerTool('run_status', {
    description: '查询 run 状态。paused 时携带完整介入载荷（问题/schema/默认值）；completed 携带全部 outputs；running 且有并行在飞时携带 current_step 与 inflight 子实例视图。run 不在注册表（server 重启/跨进程）时按 state_dir 快照兜底：paused run 返回盘上问题卡全文（纯读零凭证）。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      run_id: z.string().optional().describe('省略且仅一个活跃 run 时取之'),
      state_dir: z.string().optional().describe('快照目录（缺省 .hopstate;相对路径按 server cwd 解析——run 以 workspace_dir 启动时传 start_run 返回的绝对路径）——run 不在注册表时纯读快照兜底:paused 返回问题卡全文（0028 detach 场景跨进程取卡）'),
    },
  }, async ({ run_id, state_dir }) => jsonContent(core.runStatus(run_id, state_dir)));

  server.registerTool('resume_run', {
    description: '向 paused 的 run 注入人的回答（confirm 审批 / ask 数据值），继续执行。回答必须来自真人——不得替答。run 不在注册表时自动从 state_dir 快照恢复（server 重启后 paused run 不丢）；运行中崩溃的 run 传悬空步 step_id 即重跑续行（answer 忽略）。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: {
      run_id: z.string(),
      step_id: z.string().describe('paused 载荷里的 step_id'),
      answer: z.record(z.string(), z.unknown()).describe('如 {"value": "approve"} 或业务数据值'),
      state_dir: z.string().optional().describe('快照目录（缺省 .hopstate;相对路径按 server cwd 解析——run 以 workspace_dir 启动时传 start_run 返回的绝对路径）——仅 server 重启后恢复 run 时用到'),
      child_instance: z.string().optional().describe('子实例 HITL 队列应答路由——run_status 的 paused_queue 里那张卡的 child_instance;携=答那张卡（parallel 子实例暂停）,缺省=顶层/call_path 既有路由'),
    },
  }, async ({ run_id, step_id, answer, state_dir, child_instance }) => jsonContent(core.resumeRun(run_id, step_id, answer, state_dir, child_instance)));

  server.registerTool('list_runs', {
    description: '列出本 server 进程内全部 run 及状态。',
    annotations: { readOnlyHint: true },
    inputSchema: {},
  }, async () => jsonContent(core.listRuns()));

  server.registerTool('stop_run', {
    description: '主动中止一个 run（协作式:步间生效,不打断执行中的单步;级联中止全部在飞子实例）。中止是终局不是暂停——不支持 resume;快照保留可检视。已终态的 run 幂等返回现状。run 不在注册表（server 重启后）时按 state_dir 快照兜底:非终态的写墓碑中止,快照正被另一个活着的进程持有时拒 RUN_OWNED_ELSEWHERE。',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: {
      run_id: z.string().describe('要中止的 run'),
      state_dir: z.string().optional().describe('快照目录（缺省 .hopstate;相对路径按 server cwd 解析——run 以 workspace_dir 启动时传 start_run 返回的绝对路径）——仅 server 重启后中止旧 run 时用到'),
    },
  }, async ({ run_id, state_dir }) => jsonContent(core.stopRun(run_id, state_dir)));

  // 已批准命令在 run 上下文里执行（^anc-mcp-run-command,todo/0132）——授权来源是任务卡《已批准命令》节,
  // 不是 hopjit.yaml;openWorldHint 如实为 true（命令可联网,server 进程不在载体 Bash 沙箱里）。// @a: anc-mcp-run-command
  server.registerTool(RUN_APPROVED_COMMAND_TOOL, {
    description: '在某个 run 的上下文里执行一条任务卡已批准的命令。授权三要素：①什么任务——授权绑定 run,从 instance_id 的快照里读该任务卡《已批准命令》节,别的活拿不到;②什么核验——命令级:argv 逐项相等地以卡上某行前缀开头才放行,hopjit 恒拒,不经 shell（cwd 任意目录,缺省该 run 的工作区——授权看的是 argv 不是在哪跑）;任务级:同一条命令在 act 步骤里是探索（可重跑）,在 commit 步骤里由引擎按 body 执行且前面已过 check final 或 confirm——两态由步骤类型定,不由本工具定;③才可以执行——两层都过才跑,每次执行的 argv/cwd/returncode/耗时进该 run 的 hoplog command: 块,事后可查。不认 hopjit.yaml commands:（那是项目级白名单,本工具的授权单位是任务）。被拒时怎么办：APPROVAL_REQUIRED 表示命令不在卡上——这是任务授权范围要不要扩的问题,归人决定;调用方停下来问用户（说清命令干什么、可逆否、为什么需要）,批则在卡上加一行后重起 run,不批则这一条走载体自己的审批;调用方不得自己把命令加进卡、不得改走别的通道绕过。COMMAND_FAILED 按报文修命令或超时再调,不换通道。人工闸（confirm/ask/commit 前置检查）不受本工具影响。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    inputSchema: {
      state_dir: z.string().optional().describe('该 run 的快照目录（缺省 .hopstate;相对路径按 server cwd 解析——start_run 返回值里的绝对路径最稳）'),
      instance_id: z.string().describe('run 的实例 id（快照目录名）——清单从它的 spec 快照里读'),
      argv: z.array(z.string()).min(1).describe('命令的 argv 列表,首项是命令名;不拼 shell 字符串、不支持管道与重定向'),
      cwd: z.string().optional().describe('工作目录,缺省该 run 的 workspace_dir;相对路径按 workspace_dir 解析;任意目录都行（worktree / 临时区）——授权看的是 argv'),
      timeout_sec: z.number().optional().describe(`超时秒数,缺省 ${RUN_COMMAND_TIMEOUT_DEFAULT_SEC},上限 ${RUN_COMMAND_TIMEOUT_MAX_SEC},下限 1`),
      caller_step: z.string().optional().describe('调用方自报的所属步骤号,只写进账供人对账'),
    },
  }, async (args) => jsonContent(core.runCommand(args)));

  // ── 复用模式驱动工具七件（^anc-mcp-reuse-driver-tools,todo/0146）——与 CLI 同名子命令同一引擎调用序、同一响应,
  // 没有 shell。工具本身不调 LLM、不依赖独立模式配置。// @a: anc-mcp-reuse-driver-tools
  const wsArg = z.string().optional().describe('工作区根（缺省 server cwd,即载体拉起 server 的项目根）;state_dir/spec_path/@路径的相对路径都按它解析');
  const stateDirArg = z.string().optional().describe('状态目录,缺省 .hopstate（相对工作区根）');
  const instanceArg = z.string().optional().describe('实例 id;省略取 state_dir 下最新的实例');
  const outputArg = z.union([z.record(z.string(), z.unknown()), z.string()]);

  server.registerTool('run', {
    description: '复用模式起跑一份 spec:初始化实例并推进到第一个需要调用方处理的点（与 `hopjit run` 同）。工具不调 LLM——返回的步骤由调用方自己干完再用 submit_and_fetch_next 提交。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: {
      spec_path: z.string().describe('spec 文件路径（相对工作区根或绝对）'),
      params: z.record(z.string(), z.unknown()).optional().describe('spec Inputs 实参（结构化对象）'),
      state_dir: stateDirArg,
      workspace_dir: wsArg,
      log_dir: z.string().optional().describe('hoplog 目录,缺省 state_dir 同级 .hoplog'),
      log_level: z.string().optional().describe('debug | info | warn'),
      max_runs: z.number().optional().describe('日志目录下最多保留几个 run 的 hoplog 目录（正整数,缺省 3）——起跑前删掉最旧的,与 CLI --max-runs 同义'),
      context_mode: z.string().optional().describe('full | minimal;环境变量 HOPJIT_CONTEXT_MODE 在场时以它为准'),
      notify: z.string().optional().describe('只认 dingtalk——渠道记进实例账;MCP 推进不发通知,改走 CLI 推进时照发'),
      approve_dirs: z.boolean().optional().describe('起跑即批准 Config.dirs 清单、跳过 dirs 停点（与 CLI --approve-dirs 同义,写参数的人就是批准的人）'),
    },
  }, async (args) => driverCall(args.workspace_dir, ctx => driverRun(ctx, args)));

  server.registerTool('submit_and_fetch_next', {
    description: '提交当前步骤的结果并推进到下一个需要调用方处理的点（与 `hopjit submit_and_fetch_next` 同）。七种提交形态恰好给一个:output/answer/child_instance/failure_child/failure/replan/tool_result。output 传与输出槽同名的对象,大产出写进 work_zone 后传 "@<路径>"。带 body 的 commit 步骤由引擎执行,不能用本工具提交输出（COMMIT_BODY_ENGINE_ONLY）。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: {
      step_id: z.string().describe('当前步骤号'),
      instance_id: instanceArg,
      state_dir: stateDirArg,
      workspace_dir: wsArg,
      output: outputArg.optional().describe('输出对象（键=输出槽名）,或 "@<work_zone 内路径>" 指向 JSON 文件'),
      answer: outputArg.optional().describe('confirm/ask 的人类回答,形态同 output'),
      child_instance: z.string().optional().describe('call 子实例完成回填:子实例 id'),
      failure_child: z.string().optional().describe('call 子实例失败回填:子实例 id'),
      failure: z.string().optional().describe('本步失败说明文本,或 "@路径"'),
      replan: z.string().optional().describe('新计划 markdown,或 "@路径"'),
      proactive: z.boolean().optional().describe('replan 为主动改计划'),
      extend_expansion: z.boolean().optional().describe('replan 申请追加展开次数（须人已批）'),
      tool_result: outputArg.optional().describe('tool-call 的工具结果,形态同 output'),
    },
  }, async (args) => driverCall(args.workspace_dir, ctx => driverSubmit(ctx, args)));

  server.registerTool('reap_and_fetch_next', {
    description: '收割一个 parallel 子实例的结果并推进（与 `hopjit reap_and_fetch_next` 同）。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: {
      child_instance: z.string().describe('子实例 id'),
      status: z.string().describe('completed | failed'),
      instance_id: instanceArg,
      state_dir: stateDirArg,
      workspace_dir: wsArg,
    },
  }, async (args) => driverCall(args.workspace_dir, ctx => driverReap(ctx, args)));

  server.registerTool('status', {
    description: '查询复用模式实例的进度（与 `hopjit status` 同,只读）。',
    annotations: { readOnlyHint: true },
    inputSchema: { instance_id: instanceArg, state_dir: stateDirArg, workspace_dir: wsArg },
  }, async (args) => driverCall(args.workspace_dir, ctx => driverStatus(ctx, args)));

  server.registerTool('resume', {
    description: '续跑复用模式实例:重置崩溃留下的悬空步骤并推进到下一个需要调用方处理的点（与 `hopjit resume` 同）。commit 步骤批准后也用它续跑。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: { instance_id: instanceArg, state_dir: stateDirArg, workspace_dir: wsArg },
  }, async (args) => driverCall(args.workspace_dir, ctx => driverResume(ctx, args)));

  server.registerTool('abort', {
    description: '主动中止复用模式实例（与 `hopjit abort` 同）。中止不可撤销,快照与 hoplog 保留。',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: {
      instance_id: instanceArg,
      reason: z.string().optional().describe('中止原因,记进实例账'),
      state_dir: stateDirArg,
      workspace_dir: wsArg,
    },
  }, async (args) => driverCall(args.workspace_dir, ctx => driverAbort(ctx, args)));

  server.registerTool('validate', {
    description: '校验 spec 合法性（与 `hopjit validate` 同,只读）:返回 errors 与 warnings 两组。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      spec_path: z.string().describe('spec 文件路径'),
      fragment: z.boolean().optional().describe('按片段校验（replan 片段）'),
      known_vars: z.array(z.string()).optional().describe('片段校验时视为已存在的变量名'),
      workspace_dir: wsArg,
    },
  }, async (args) => driverCall(args.workspace_dir, ctx => driverValidate(ctx, args)));

  // commit 转人工后的记账入口（^anc-mcp-commit-approve）——人的选择由 driver 在对话里问,用户选了 once/task 才调本工具;
  // 和其他 hopjit 工具一样由 setup 放行,载体弹窗不当批准闸（用户习惯性点过弹窗,弹窗也看不到 body 原文）。
  // @a: anc-mcp-commit-approve
  server.registerTool(APPROVE_COMMIT_TOOL, {
    description: '记录用户对一个 [commit] 步骤的批准。commit 步骤第一次执行前引擎先做安全分析:可逆或低危的动作（新建、追加、移动、写入前已留存旧版本的覆盖与删除）直接执行,不停;有动作销毁内容且找不回、运行命令、发通知或调外部工具时停下转人工（pause_reason=commit,载荷 context 带 step_id、fingerprint、analysis、body）。引擎判过安全、模型判过安全或人批准过的步骤记进批准账,以后同一步（body 没改）先查账、账上有就直接执行,不再扫描与分析。先用不懂代码的人也读得懂的话把 context.analysis 讲给用户:summary、每个需要确认的动作的 consequence、recommendation;代码不先贴,用户要看再给 context.body。然后在对话里给三个选项:只批准这一次（scope=once,本次运行内有效）、这一步以后都通过（scope=task）、不批准。用户选了前两个之一才调本工具,选不批准则不调,不得替用户回答。fingerprint 只覆盖 body,body 改了要重新分析与批准。本工具只记批准,不推进:复用模式接着调 resume,独立模式接着调 resume_run。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: {
      instance_id: z.string().describe('run 的实例 id'),
      step_id: z.string().describe('停下来的 commit 步骤号'),
      fingerprint: z.string().describe('停点载荷 context.fingerprint——body 的指纹,证明批准的是此刻这份 body,body 改了就对不上'),
      scope: z.string().describe('once（只批准这一次,本次运行内有效）或 task（这一步以后都通过）——取自用户在三个选项里的选择'),
      state_dir: stateDirArg,
      workspace_dir: wsArg,
      child_instance: z.string().optional().describe('独立模式 parallel 子实例的 commit 卡:run_status 的 paused_queue 里那张卡的 child_instance;缺省=批顶层实例的 commit'),
    },
  }, async (args) => jsonContent(core.approveCommit(args)));

  server.registerTool(APPROVE_DIRS_TOOL, {
    description: '批准某个 run 的 Config.dirs 目录清单（spec 声明的 workspace 之外的目录）。run 起跑后第一个响应停在 pause_reason=dirs（载荷 context 带 dirs 清单与 dirs_hash）,先把清单（路径 + 只读/读写）给用户看、在对话里问用户同不同意,用户明确同意后才调本工具,不同意则不调;之后同一份清单在重跑、续跑都不再停,声明或 Inputs 变了要重新批准。本工具只记批准,不推进:接着调 resume。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: {
      instance_id: z.string().describe('run 的实例 id'),
      dirs_hash: z.string().describe('停点载荷里的 dirs_hash——证明批准的是此刻这份清单'),
      state_dir: stateDirArg,
      workspace_dir: wsArg,
    },
  }, async (args) => jsonContent(core.approveDirs(args)));

  // ── 管理工具面八件（^anc-mcp-admin-tools,todo/0154）——hop 自己的体检与 HopAnt 生命周期动作,与 CLI `doctor` / `ant *` 同名参数、同一份响应。
  // 由 server 进程写 ~/.hopjit/,不受载体 Bash 文件沙盒约束;setup 不进（它改的是载体配置与放行,server 本身就是它装出来的）。// @a: anc-mcp-admin-tools, anc-cli-doctor, anc-cli-ant
  server.registerTool('doctor', {
    description: '体检：装完 hop 之后一次答"能不能用"的八问（skill 在场 / 版本 / 菜单可见 / MCP 注册 / 握手 / 放行 / MCP server 模型配置 / 独立模式凭证）,每项 ok | warn | fail | n/a 一行加补法;只报不改（修归终端 `hopjit setup`）。与 `hopjit doctor` 同一份报告。读 items 里 status 为 fail 的项：detail 是事实,hint 是补法。',
    annotations: { readOnlyHint: true },
    inputSchema: { workspace_dir: wsArg },
  }, async (args) => adminCall(args.workspace_dir, ctx => runDoctor(ctx)));

  server.registerTool('ant_list', {
    description: '列已装 HopAnt 与各自的适配状态——两级合并：项目级（<workspace_dir>/hop_tasks/ants/,这个项目总结出的）在前、用户级（~/.hopjit/ants/,装进来的）在后,每项带 scope,同 id 两条都在（按 id 找时项目级遮住用户级）。adapt_state：adapted 直接跑 / never 装上后没适配过 / stale 适配后 spec 头变了或目录从别的机器拷来——后两种先 ant_adapt。与 `hopjit ant list` 同。',
    annotations: { readOnlyHint: true },
    inputSchema: { workspace_dir: wsArg },
  }, async (args) => adminCall(args.workspace_dir, ctx => antList(ctx)));

  server.registerTool('ant_install', {
    description: '装一个 HopAnt 目录或 HopAnt 包根（含 ants/<id>/）进 HopAnt 根（与 `hopjit ant install` 同）。scope 缺省 user（~/.hopjit/ants/,装别人的 HopAnt 是给自己用）;用户说"只在这个项目里用"传 project（<workspace_dir>/hop_tasks/ants/）。撞 id 只在目标级内判,整单拒 HOPANT_ID_CONFLICT,不覆盖;不自动跑任何脚本——响应 result.bootstrap_pending 列出带安装脚本的 HopAnt,先 ant_bootstrap dry_run 看计划再决定跑不跑。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: {
      dir: z.string().describe('单 HopAnt 目录或 HopAnt 包根;相对路径按 workspace_dir 解析'),
      scope: z.enum(['user', 'project']).optional().describe('装到哪一级：user=~/.hopjit/ants/（缺省,所有项目可用）;project=<workspace_dir>/hop_tasks/ants/（只给这个项目）'),
      dry_run: z.boolean().optional().describe('只返回安装计划（撞 id / 哪些带 bootstrap.js）,不写盘'),
      workspace_dir: wsArg,
    },
  }, async (args) => adminCall(args.workspace_dir, ctx => antInstall(ctx, args.dir, args.dry_run === true, args.scope ?? 'user')));

  server.registerTool('ant_adapt', {
    description: '核本机对某个已装 HopAnt 的依赖齐不齐（id 两级查找：先 <workspace_dir>/hop_tasks/ants/ 再 ~/.hopjit/ants/）——入口 spec 头声明的工具是否在两级 tool_servers 注册、凭证环境变量是否有值、已批准命令是否在 PATH、引擎版本是否够;全绿写适配戳并返回 report.ok true;有缺口 report.ok false 且 hints 逐条写补法（把 hints 原样告诉用户,补齐之前不跑）。与 `hopjit ant adapt` 同。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: { id: z.string().describe('HopAnt id（~/.hopjit/ants/<id>/）'), workspace_dir: wsArg },
  }, async (args) => adminCall(args.workspace_dir, ctx => antAdapt(ctx, args.id)));

  server.registerTool('ant_remove', {
    description: '卸载一个已装 HopAnt（与 `hopjit ant remove` 同）。不传 scope 删两级查找命中的那一个（项目级在就删项目级）,传了删指定级。keep_store 为 true 时先把它的 inner_store/（跨 run 累积的本机数据）挪到 ~/.hopjit/ants-store-backup/<id>/ 再删;不传则连数据一起删。',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: { id: z.string().describe('HopAnt id'), scope: z.enum(['user', 'project']).optional().describe('删哪一级;缺省=两级查找命中的那一级'), keep_store: z.boolean().optional().describe('保留 inner_store/ 到备份位'), workspace_dir: wsArg },
  }, async (args) => adminCall(args.workspace_dir, ctx => antRemove(ctx, args.id, args.keep_store === true, args.scope)));

  server.registerTool('ant_bootstrap', {
    description: '跑某个 HopAnt 自带的 bootstrap.js（id 两级查找,项目级先;装它自己的运行时依赖,可联网可装系统包——是 HopAnt 作者写的脚本,跑前先 dry_run 看它打算做什么并告诉用户）。没有 bootstrap.js 返回 has_bootstrap false 不报错;脚本退出码进 returncode。与 `hopjit ant bootstrap` 同。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    inputSchema: { id: z.string().describe('HopAnt id'), dry_run: z.boolean().optional().describe('给脚本传 --dry-run,只打印计划'), workspace_dir: wsArg },
  }, async (args) => adminCall(args.workspace_dir, ctx => antBootstrap(ctx, args.id, args.dry_run === true)));

  server.registerTool('ant_pack', {
    description: '把一份 spec 封成可装的 HopAnt 目录 <out>/<id>/（与 `hopjit ant pack` 同）。/hop 总结干完的活时 out 传 <workspace_dir>/hop_tasks/ants——产物就地是活的项目级 HopAnt,不再经 ant_install。它会对账入口 spec 头的 ## Tools 与 ## 已批准命令（从 body 扫出实际使用面,少的补、多的删,增删进 pack.reconciled——读给用户看;tools_added 里的非标准工具是占位签名,装机前要按真实参数改）;spec 同目录被 doc-ref 引用的知识文件随包拷入,另要带的文件走 assets。不覆盖已有目标 HOPANT_TARGET_EXISTS;doc-ref 文件缺 / 越出 spec 目录 / assets 不存在 → HOPANT_DOC_MISSING 不写。产物接着 ant_install。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: {
      spec_path: z.string().describe('spec 文件路径（相对 workspace_dir 或绝对）'),
      out: z.string().optional().describe('输出根目录,缺省 <workspace_dir>/ants'),
      id: z.string().optional().describe('HopAnt id,缺省取 spec 的 Id 行'),
      assets: z.array(z.string()).optional().describe('额外拷进 HopAnt 根的文件（相对 spec 目录或绝对）'),
      workspace_dir: wsArg,
    },
  }, async (args) => adminCall(args.workspace_dir, ctx => antPack(ctx, args.spec_path, { out: args.out, id: args.id, assets: args.assets })));

  server.registerTool('ant_share', {
    description: '把若干已装 HopAnt 的可分发面装进一个 HopAnt 包目录 <out>/<name>/（package.json + ants/<id>/…,与 `hopjit ant share` 同）。四核任一不过即拒不写（入口头与目录一致 / 无凭证字面值 / 本机面不进包 / 谱系）。归属标识：owner 参数 > ~/.hopjit/config.yaml 已有 owner_id（在场即用不问）> yes 时现算 > 都没有 → 不写包,返回 owner_prompt_required true 与 owner_default,在对话里问用户用缺省还是改一个后带 owner 重跑（用户确认缺省也带）。写了包时 credential_scan.warnings 逐条念给用户,disclaimer 原样说一次。',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: {
      ids: z.array(z.string()).min(1).describe('要装进包的 HopAnt id 列表（每个两级查找,项目级先——本项目总结的 HopAnt 不须先装用户级）'),
      out: z.string().optional().describe('输出根目录,缺省 workspace_dir'),
      name: z.string().optional().describe('包名,单个 id 时缺省取该 id;多个时必填'),
      pkg_version: z.string().optional().describe('包版本（运输标签）,缺省 0.1.0'),
      owner: z.string().optional().describe('归属标识;成功后写回 ~/.hopjit/config.yaml 的 owner_id'),
      yes: z.boolean().optional().describe('首机没有 owner_id 时直接用现算的缺省归属标识,不问'),
      workspace_dir: wsArg,
    },
  }, async (args) => adminCall(args.workspace_dir, ctx => antShare(ctx, args.ids, { out: args.out, name: args.name, pkg_version: args.pkg_version, owner: args.owner, yes: args.yes })));

  // 配置能力状态（^anc-mcp-server-status）——只读,不依赖配置。// @a: anc-mcp-server-status
  server.registerTool('server_status', {
    description: '报告 hopjit-mcp 的版本、独立模式是否可用（不可用时给原因与修法）、注册的工具清单。复用模式驱动工具不依赖独立模式配置,恒可用。',
    annotations: { readOnlyHint: true },
    inputSchema: {},
  }, async () => jsonContent(core.serverStatus(registeredToolNames(server))));

  return server;
}

/** 本 server 注册的全部工具名（server_status 用）。 */
function registeredToolNames(server: McpServer): string[] {
  const reg = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
  return reg ? Object.keys(reg) : [];
}

/** fail-fast 启动预检（design v0.3.1 review P2）：逐 provider 解引用 api_key_env——
 * 任一缺失即抛错报变量名（原首次 start_run 才暴露，违反 fail-fast 契约）。
 * 从 serve 提取为可测函数：stdio connect 段进程内测不了，预检逻辑不该陪葬在覆盖盲区。
 * // @a: anc-mcp-config */
export function preflightProviderKeys(config: StandaloneConfig): void {
  snapshotProviderKeys(config);
}

/** 配置加载/预检的报文 → 能力状态的原因与修法（四类,design ^anc-mcp-server-status）。可测纯函数。
 * // @a: anc-mcp-server-status */
export function classifyConfigError(message: string): { reason: string; fix: string } {
  if (message.startsWith('STANDALONE_CONFIG_MISSING_PROVIDERS') || /缺 providers\[\]/.test(message)) {
    return { reason: message, fix: '在 providers 下至少配一个 provider' };
  }
  if (message.startsWith('STANDALONE_CONFIG_MISSING')) {
    return { reason: message, fix: '创建 ~/.hopjit/config.yaml（只写 api_key_env 名,不写 key）,或设 HOPJIT_CONFIG 指向配置文件' };
  }
  if (message.startsWith('STANDALONE_KEY_MISSING')) {
    const v = /环境变量 (\S+) 未设置/.exec(message)?.[1] ?? '对应的环境变量';
    return { reason: message, fix: `在启动 server 的环境里导出 ${v},然后重开会话` };
  }
  return { reason: message, fix: '按报文改 config.yaml;明文 key 改用 api_key_env' };
}

// 配置消费入口：加载 StandaloneConfig → 预检 → 构建 core → 装配 transport。schema 权威在
// shared-providers ^anc-config-standalone-schema，本模块只消费。见 [[mcp-server#^anc-mcp-config]]。
// @a: anc-mcp-config
async function serve(): Promise<void> {
  // 进程兜底（run 隔离不变量,ARCHITECTURE ^anc-run-isolation——仅 server 装,CLI 单 run 进程不装）：
  // 漏网异常记 stderr+计数留痕+不 exit,不承诺关联 run（回调无 runId 可依,关联归池尾 catch;
  // 漏网 run 停 running 由超时/对账/观测/重启 restore 兜住）。作者拍板 2026-08-14"活"。
  // 兜底是止血非豁免——每次触发=结构防线漏网,留痕必修。// @a: anc-run-isolation
  let escapedErrors = 0;
  process.on('unhandledRejection', (reason) => {
    escapedErrors++;
    process.stderr.write(`hopjit-mcp: [run-isolation] 漏网 unhandledRejection #${escapedErrors}（结构防线漏网,留痕必修——server 存活,其它 run 不受影响）: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
  });
  process.on('uncaughtException', (err) => {
    escapedErrors++;
    process.stderr.write(`hopjit-mcp: [run-isolation] 漏网 uncaughtException #${escapedErrors}（同上）: ${err.stack ?? err.message}\n`);
  });
  // 配置问题不阻止启动,记为能力状态（design 核心要求 3,2026-10-07 todo/0146 改定;^anc-mcp-server-status）
  const configPath = process.env['HOPJIT_CONFIG'] || join(homedir(), '.hopjit', 'config.yaml');
  let config: StandaloneConfig | null = null;
  let configError: { reason: string; fix: string } | null = null;
  try {
    config = loadStandaloneConfig(process.env['HOPJIT_CONFIG'] || undefined);
    preflightProviderKeys(config);
  } catch (err) {
    config = null;
    configError = classifyConfigError(err instanceof Error ? err.message : String(err));
  }
  // commit 安全分析函数注册（design serve 配置加载第 3a 步）:配置可用才注册,否则需要模型判的动作按模板转人工。
  // @a: anc-exec-commit-analyzer
  if (config) ExecutionEngine.setCommitAnalyzer(makeCommitAnalyzer(resolveCommitAnalyzerProvider(config)));
  const core = new HopjitMcpCore(config, configError, configPath);
  const server = buildServer(core);
  const transport = new StdioServerTransport();
  // 宿主断开即退出（^anc-mcp-shutdown-on-disconnect,四十七审——孤儿 server 实撞:两个历史会话的
  // server 挂两天无人杀。stdio server 生命随宿主:管道关闭后进程零价值〔paused run 有快照,下个
  // server 经 restore 恢复〕;不做优雅收尾——等在飞完成=不确定时长僵尸期,快照落盘由既有 persist
  // 时机保证。直接 process.exit 不经 uncaughtException 兜底——"不 exit"承诺限运行期异常）。
  // @a: anc-mcp-shutdown-on-disconnect
  const exitOnDisconnect = (why: string) => {
    process.stderr.write(`hopjit-mcp: ${why},server 退出（在飞/暂停 run 可经 resume_run 从快照恢复）\n`);
    process.exit(0);
  };
  transport.onclose = () => exitOnDisconnect('宿主断开连接');
  process.stdin.on('end', () => exitOnDisconnect('stdin 关闭'));
  process.stdin.on('close', () => exitOnDisconnect('stdin 关闭'));
  await server.connect(transport);
  process.stderr.write(config
    ? `hopjit-mcp: server 就绪（独立模式可用,provider: ${config.providers[0].service_id}）\n`
    : `hopjit-mcp: server 就绪（复用驱动工具可用;独立模式不可用:${configError?.reason}）\n`);
}

function resolveRealPath(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}
const isMain = process.argv[1] !== undefined
  && resolveRealPath(process.argv[1]) === resolveRealPath(fileURLToPath(import.meta.url));
if (isMain) {
  serve().catch(err => {
    process.stderr.write(`hopjit-mcp 启动失败: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
