#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: mcp-server ^anc-struct-mcp-server
// standalone 执行的 MCP server 协议壳：五工具（start_run/run_status/resume_run/list_runs/stop_run）
// 薄壳包 StepDispatcher 进程内 API。常驻进程——run 状态活在注册表内存，HITL resume 同进程注入。
// 见 design/mcp-server.md ^anc-struct-mcp-server。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { load as yamlLoad } from 'js-yaml';
import { parseToolServers, enrichParamsComments, loadProjectToolRegistry } from './tools-registry.js';
import { readFileSync, writeFileSync, existsSync, realpathSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, isAbsolute, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ExecutionEngine } from './engine.js';
import { StepDispatcher, DirSpecProvider, parseModelRef, childNotInQueueMessage, type RunResult } from './dispatcher.js';
import { parseSpec } from './parser.js';
import { validateSpec } from './validator.js';
import { CompositeToolProvider, makeEngineToolProviderFactory } from './tools-composite.js';

// 引擎自有工具执行体工厂注册（执行主体原则 2026-09-05——mcp-server 组合根同 CLI 对称;
// 0076 起同带注册件现读:本进程 standalone dispatcher 自持 provider 不经此工厂,注册保持
// 两组合根一致,将来 mcp 引入消化路径不埋雷。^anc-exec-tool-request）
// @a: anc-exec-tool-request
ExecutionEngine.setEngineToolProviderFactory(
  makeEngineToolProviderFactory(() => loadProjectToolRegistry(process.cwd())),   // cwd 读在组合根（run 隔离不变量）
);
import { ACT_BUILTIN_NAMES } from './act-builtins.js';
import { hasChildren, getChildren } from './ast-helpers.js';
import type { StepNode, ActBody, ActExpr, ActStatement } from './ast-types.js';
import type { HostConfig, RoutingCategory } from './provider-types.js';
import { credentialLikeHopEnvKey, hopEnvCredentialError, ROUTING_CATEGORIES } from './provider-types.js';
import { sendDingtalk, composeRunCard } from './tools-notify.js';
import type { ExecutionPaused } from './cli-types.js';

// ── StandaloneConfig 加载（schema 权威：shared-providers ^anc-config-standalone-schema）──

/** ProviderEntry：standalone 单 provider 条目。配置只保存 api_key_env 名称，不允许明文 key。 */
export interface ProviderEntry {
  service_id: string;
  protocol: 'anthropic' | 'openai-chat' | 'openai-responses';
  base_url: string;
  model: string;
  api_key_env: string;
  auth?: 'api-key' | 'bearer';   // 鉴权头档,缺省 api-key（x-api-key 头）;bearer=Authorization: Bearer（只认此形态的网关——实测百炼 claude-code-proxy 对 x-api-key 报 InvalidApiKey） // @a: anc-config-standalone-schema
  // 可选。该 provider 模型的输出上限（作者定"按 LLM 的上限去设置"——缺省按模型能力发满,
  // 产出约束归 spec 输出声明;经 {SID}_MAX_OUTPUT_TOKENS 快照键透传 dispatcher 解析链第3级）。
  // @a: anc-exec-output-budget
  max_output_tokens?: number;
  // provider 级思考缺省（五级链第 4 级——逐模型矫正档:antchat 类"端点缺省关"的服务配 disabled
  // 压回第 5 级步骤类型缺省的 reason 恒开;设计 [[shared-providers#^anc-config-standalone-schema]]
  // thinking 行）。env 键 {SERVICE_ID}_THINKING 与 _AUTH 同披。// @a: anc-exec-thinking-provider-default
  thinking?: 'enabled' | 'disabled';
}

/** StandaloneConfig：standalone 执行的完整配置。见 [[shared-providers#^anc-config-standalone-schema]] */
export interface StandaloneConfig {
  providers: ProviderEntry[];
  default_model?: string;
  // 系统层按类别路由（两层配置的系统半边——spec 层 Config.models 逐类别继承本层）。
  // 见 shared-providers ^anc-config-standalone-schema / step-dispatcher ^anc-exec-model-resolve。
  // @a: anc-exec-model-routing
  routing_rules?: Array<{ step_type: string; model: string; thinking?: 'enabled' | 'disabled' }>;
  // spec 环境参数（hop_env_* 命名空间,概念 ^anc-config-hop-env——非密可落盘,凭证禁入）// @a: anc-config-hop-env
  env?: Record<string, string>;
  // 生成物语言（项目级 hopjit.yaml language: zh|en 缺省 en,^anc-i18n-language-config——
  // 序列化/read_spec_tree 读回/hopbuild2 生成面消费;注入 hop_env_language）// @a: anc-i18n-serialize-lang
  language?: 'en' | 'zh';
  // 修订供给档（^anc-exec-revision-short-weak——short=弱模型档打回重试轮换短 prompt;缺省
  // standard 全模型零变化。最终户口=model-gearbox 档案 adapt.revision_prompt,档案消费链落地
  // 前本键即人工开关位;env HOPJIT_REVISION_PROMPT 每 run 可覆盖）// @a: anc-exec-revision-short-weak
  revision_prompt?: 'standard' | 'short';
  // 外部工具注册节（原独立 hoptools.yaml 收编,tools_file 指针退役——统一配置 2026-08-13 作者定;
  // 文法权威 tool-interface ^anc-config-tool-registry 不变）。加载器给每项打 _base_dir（声明所在
  // 配置文件目录——in-process module 相对路径解析基准,项目级声明相对项目根）。
  tool_servers?: unknown[];
  // 单步资源上限（四十四审补节——重档步 OUTPUT_TRUNCATED 于 16384 缺省而 MCP 主模式无配置通道;
  // 逐键可选,合并项目级赢,装配进 hostConfig.resource_limits;env HOPJIT_MAX_OUTPUT_TOKENS 仍最高优先）。
  // @a: anc-config-standalone-schema
  resource_limits?: Partial<import('./provider-types.js').ResourceLimits>;
  // subprocess.run 命令白名单（人话名——操作者视角"允许哪些命令";装入 sandbox.runtime.available,
  // 两级合并=并集与 tool_servers 同律。^anc-exec-subprocess-run 配置通路条款）// @a: anc-exec-subprocess-run
  commands?: string[];
  // 通知挂点通道声明（^anc-mcp-notify-hook,todo/0052——config 只声明"用哪个通道",凭证归通道
  // 约定环境变量不进配置;发不发以 per-run 参数 hop_notify 为主,三与门见 applyResult 挂点）
  // @a: anc-mcp-notify-hook
  notify?: { channel: 'dingtalk' };
  // HopLog 记录级别（2026-08-22 作者定方案③——standalone 缺省 debug:执行日志是唯一核验通道,
  // info 不记 prompt 正文即黑箱〔实撞:L2c 反馈在不在外部无从核验,走查误判"重试无记忆"〕;
  // 嫌大经此口降级）。合并项目级赢;非法值加载期拒。见 design mcp-server HopLog 恒开条。
  // @a: anc-config-standalone-schema
  log_level?: 'debug' | 'info' | 'warn';
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
      throw new Error(`STANDALONE_KEY_MISSING: 环境变量 ${p.api_key_env} 未设置（provider '${p.service_id}'）——server 拒绝启动`);
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
    if (p.thinking !== undefined) snap[`${p.service_id.toUpperCase()}_THINKING`] = p.thinking;   // provider 级思考缺省（五级链第 4 级,^anc-exec-thinking-provider-default——dispatcher envOf 消费）
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
  if (configPath) {
    const c = parseConfigFile(configPath, /*required*/ true);
    if (!c.providers?.length) throw new Error(`STANDALONE_CONFIG_INVALID: ${configPath} 缺 providers[]（至少 1 条）`);
    validateMergedRefs(c);   // 单文件=合并结果本身,过同一核
    return c;
  }
  const sysPath = join(homedir(), '.hopjit', 'config.yaml');
  const projPath = join(projectDir ?? process.cwd(), 'hopjit.yaml');
  const sys = existsSync(sysPath) ? parseConfigFile(sysPath, true) : null;
  const proj = existsSync(projPath) ? parseConfigFile(projPath, false) : null;
  if (!sys && !proj) {
    throw new Error(`STANDALONE_CONFIG_MISSING: 配置文件不存在（${sysPath} 与 ${projPath} 均缺席）。standalone 需要 providers 配置（YAML），`
      + `格式见 docs/design/shared-providers.md ^anc-config-standalone-schema`);
  }
  const merged = !proj ? sys! : (!sys ? proj : mergeConfigs(sys, proj));
  if (!merged.providers?.length) {
    throw new Error(`STANDALONE_CONFIG_MISSING_PROVIDERS: 两级配置合并后 providers 为空（至少 1 条——通常在系统级 ${sysPath}）`);
  }
  validateMergedRefs(merged);
  return merged;
}

// 跨节引用校验（合并后统一做——^anc-config-standalone-schema 校验时点条款,2026-08-13 BUG-E 实撞：
// 项目级文件合法形态=只有 routing_rules+tool_servers,providers 归系统级;逐文件核引用必把合法形态
// 误拒〔实撞 providers undefined 崩 server 启动〕。文法核〔step_type 枚举/形状/明文 key〕仍逐文件）。
// @a: anc-mcp-config, anc-config-standalone-schema
function validateMergedRefs(config: StandaloneConfig): void {
  const providers = config.providers ?? [];
  for (const [i, r] of (config.routing_rules ?? []).entries()) {
    const ref = parseModelRef(r.model);
    if (ref.service_id !== 'default' && !providers.some(p => p.service_id.toUpperCase() === ref.service_id.toUpperCase())) {
      throw new Error(`STANDALONE_CONFIG_INVALID: routing_rules[${i}].model 引用的 service '${ref.service_id}' 不在合并后 providers 内`);
    }
  }
  resolveStandaloneDefaultModel(config);   // default_model 引用核（原逐文件时点同病同迁）
}

// 逐节合并（项目级赢）：providers 按 service_id、routing_rules 按 step_type 覆盖同键,其余项目级在场即赢。
// tool_servers 取并集（同 server 名项目级赢;工具名跨级判重归装配层既有 fail-fast）。// @a: anc-config-standalone-schema
export function mergeConfigs(sys: StandaloneConfig, proj: StandaloneConfig): StandaloneConfig {   // 导出供测试直测合并语义（0005——server 同名替换语义著文配套钉测）
  const byKey = <T>(base: T[] | undefined, over: T[] | undefined, key: (t: T) => string): T[] | undefined => {
    if (!base?.length) return over;
    if (!over?.length) return base;
    const m = new Map(base.map(t => [key(t), t]));
    for (const t of over) m.set(key(t), t);
    return [...m.values()];
  };
  return {
    providers: byKey(sys.providers, proj.providers, p => p.service_id.toUpperCase()) ?? [],
    ...(proj.default_model ?? sys.default_model ? { default_model: proj.default_model ?? sys.default_model } : {}),
    ...((sys.env || proj.env) ? { env: { ...(sys.env ?? {}), ...(proj.env ?? {}) } } : {}),   // env 逐键合并项目级赢 // @a: anc-config-hop-env
    // commands 并集去重（review F1 三面独立实锤:原返回体无此键,双文件部署 commands 整键蒸发
    // 恒关死——'两级合并=并集与 tool_servers 同律'设计条款首次兑现）// @a: anc-exec-subprocess-run
    ...((sys.commands?.length || proj.commands?.length) ? { commands: [...new Set([...(sys.commands ?? []), ...(proj.commands ?? [])])] } : {}),
    ...((proj.notify ?? sys.notify) ? { notify: proj.notify ?? sys.notify } : {}),   // 项目级赢（^anc-mcp-notify-hook——新顶层键必须同步本函数,commands 漏写合并整键蒸发的前车） // @a: anc-mcp-notify-hook
    ...(byKey(sys.routing_rules, proj.routing_rules, r => r.step_type)?.length ? { routing_rules: byKey(sys.routing_rules, proj.routing_rules, r => r.step_type) } : {}),
    ...(byKey(sys.tool_servers, proj.tool_servers, t => (t as { name: string }).name)?.length ? { tool_servers: byKey(sys.tool_servers, proj.tool_servers, t => (t as { name: string }).name) } : {}),
    ...((sys.resource_limits || proj.resource_limits) ? { resource_limits: { ...(sys.resource_limits ?? {}), ...(proj.resource_limits ?? {}) } } : {}),   // 逐键合并项目级赢（env 节同法）
    ...((proj.log_level ?? sys.log_level) ? { log_level: proj.log_level ?? sys.log_level } : {}),   // 项目级赢 // @a: anc-config-standalone-schema
    ...((proj.language ?? sys.language) ? { language: proj.language ?? sys.language } : {}),   // 项目级赢（todo/0084 M2——本键曾漏合并:项目级 zh 在 MCP 侧静默蒸发落 en 与 CLI 劈叉,恰是上一行 commands 前车注警告的同型复发;新顶层键必须同步本函数+补合并测试钉） // @a: anc-i18n-serialize-lang
    ...((proj.revision_prompt ?? sys.revision_prompt) ? { revision_prompt: proj.revision_prompt ?? sys.revision_prompt } : {}),   // 项目级赢（^anc-exec-revision-short-weak;新顶层键必须同步本函数——0084 M2 前车） // @a: anc-exec-revision-short-weak
  };
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
    const projCfg = parseConfigFile(projPath, false);
    const merged = mergeConfigs(startupConfig, { ...projCfg, providers: [] } as StandaloneConfig);
    const config = { ...merged, providers: startupConfig.providers };   // providers 恒启动期快照
    validateMergedRefs(config);
    return { config };
  } catch (err: unknown) {
    return { error: { code: 'CONFIG_INVALID', message: `项目级配置 ${projPath} 非法——${err instanceof Error ? err.message : String(err)}` } };
  }
}

function parseConfigFile(path: string, required: boolean): StandaloneConfig {
  if (!existsSync(path)) {
    if (required) {
      throw new Error(`STANDALONE_CONFIG_MISSING: 配置文件不存在（${path}）。standalone 需要 providers 配置（YAML），`
        + `格式见 docs/design/shared-providers.md ^anc-config-standalone-schema`);
    }
    return { providers: [] };
  }
  const content = readFileSync(path, 'utf-8');
  const parsed = yamlLoad(content);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`STANDALONE_CONFIG_INVALID: ${path} 不是 YAML 映射（顶层须是 key: value 结构）`);
  }
  const raw = parsed as Record<string, unknown>;
  // params 短形态行尾 # 说明回填（唯一有原始文本的时点——yamlLoad 丢裸注释）// @a: anc-tool-params-notes
  if (Array.isArray(raw['tool_servers'])) enrichParamsComments(content, raw['tool_servers'] as unknown[]);

  if ('api_key' in raw) {
    throw new Error('STANDALONE_CONFIG_PLAINTEXT_KEY: 顶层 api_key 禁止写入配置文件，请改用 providers[].api_key_env');
  }

  const providers = raw['providers'];
  if (providers !== undefined && !Array.isArray(providers)) {
    throw new Error(`STANDALONE_CONFIG_INVALID: ${path} providers 须为列表`);
  }
  // resource_limits 文法核（四十五审——原零核:'not-a-map'/数字串静默漂到装配,max_tokens NaN 发 API 400
  // 离病灶两层;逐键数字核,未知键拒——键集即契约,拼错静默失效正是 0008③ 要治的病）。
  // @a: anc-config-standalone-schema
  const rl = raw['resource_limits'];
  if (rl !== undefined) {
    if (rl === null || typeof rl !== 'object' || Array.isArray(rl)) {
      throw new Error(`STANDALONE_CONFIG_INVALID: ${path} resource_limits 须为映射（max_output_tokens: 65536 形）`);
    }
    const RL_KEYS = new Set(['max_tool_iterations', 'max_context_tokens', 'max_output_tokens', 'max_replan_attempts', 'max_concurrent_workers', 'max_call_depth', 'timeout_seconds', 'parallel_child_timeout_seconds', 'max_concurrent_runs']);
    for (const [k, v] of Object.entries(rl as Record<string, unknown>)) {
      if (!RL_KEYS.has(k)) {
        throw new Error(`STANDALONE_CONFIG_INVALID: resource_limits.${k} 不是合法键（合法: ${[...RL_KEYS].join(', ')}）`);
      }
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new Error(`STANDALONE_CONFIG_INVALID: resource_limits.${k} 须为正数（实际: ${JSON.stringify(v)}）`);
      }
    }
  }
  // commands 文法核（review F4——零核时标量串一路灌到 commandWhitelist,includes 对字符串退化
  // 子串匹配:whitelist='github-echo-tools' 时 echo 放行,白名单形同虚设;与 CLI 侧
  // readProjectCommands 形状核对齐,mcp 侧按 fail-fast 惯例拒不静默）。// @a: anc-exec-subprocess-run
  const cmds = raw['commands'];
  if (cmds !== undefined) {
    if (!Array.isArray(cmds) || !cmds.every(c => typeof c === 'string' && c.trim())) {
      throw new Error(`STANDALONE_CONFIG_INVALID: ${path} commands 须为非空字符串列表（commands:\n  - git 形）——标量/混型会使白名单判定失真`);
    }
    // hopjit 恒拒名单配置面（^anc-exec-subprocess-deny-hopjit——白名单管"哪些外部命令可用",
    // hopjit 不是外部命令是执行语境本身;写进来即配置错,加载即拒早于运行期）
    // @a: anc-exec-subprocess-deny-hopjit
    if (cmds.some(c => c === 'hopjit' || c.split('/').pop() === 'hopjit')) {
      throw new Error(`STANDALONE_CONFIG_INVALID: ${path} commands 白名单不得含 hopjit——act/commit 步骤不驱动引擎（跑别的 spec 用 [call],不可逆动作走注册工具）`);
    }
  }
  // notify 节文法闸（^anc-mcp-notify-hook——channel 枚举现只 dingtalk;非法值加载即拒不静默漂过）
  // @a: anc-mcp-notify-hook
  const ntf = raw['notify'];
  if (ntf !== undefined) {
    const ch = (ntf as Record<string, unknown> | null)?.['channel'];
    if (typeof ntf !== 'object' || ntf === null || ch !== 'dingtalk') {
      throw new Error(`STANDALONE_CONFIG_INVALID: ${path} notify 节须为 {channel: dingtalk} 形（channel 枚举现只 dingtalk）——凭证不进配置,通道读约定环境变量 DINGTALK_WEBHOOK/DINGTALK_SECRET`);
    }
  }
  // log_level 文法核（同 resource_limits 姿势——非法值静默漂过=级别悄悄错档,核验通道无声变窄）。
  // @a: anc-config-standalone-schema
  const ll = raw['log_level'];
  if (ll !== undefined && ll !== 'debug' && ll !== 'info' && ll !== 'warn') {
    throw new Error(`STANDALONE_CONFIG_INVALID: log_level 须为 debug|info|warn（实际: ${JSON.stringify(ll)}）`);
  }
  // 至少 1 条的校验在两级合并后统一做（项目级文件可只有 tool_servers 节）——见 loadStandaloneConfig 尾部
  for (const [i, p] of ((providers ?? []) as Record<string, unknown>[]).entries()) {
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      throw new Error(`STANDALONE_CONFIG_INVALID: providers[${i}] 须为映射`);
    }
    if ('api_key' in p) {
      throw new Error(`STANDALONE_CONFIG_PLAINTEXT_KEY: providers[${i}].api_key 禁止写入配置文件，请改用 api_key_env`);
    }
    for (const field of ['service_id', 'protocol', 'base_url', 'model'] as const) {
      if (typeof p[field] !== 'string' || !(p[field] as string).trim()) {
        throw new Error(`STANDALONE_CONFIG_INVALID: providers[${i}].${field} 缺失或为空`);
      }
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p['service_id'] as string)) {
      throw new Error(`STANDALONE_CONFIG_INVALID: providers[${i}].service_id '${String(p['service_id'])}' 非法——须匹配 [A-Za-z_][A-Za-z0-9_]*`);
    }
    // protocol 三枚举校验（^anc-exec-protocol-adapter 配置准入面）// @a: anc-exec-protocol-adapter
    if (p['protocol'] !== 'anthropic' && p['protocol'] !== 'openai-chat' && p['protocol'] !== 'openai-responses') {
      throw new Error(`STANDALONE_CONFIG_INVALID: providers[${i}].protocol '${String(p['protocol'])}' 不支持（anthropic | openai-chat | openai-responses）`);
    }
    if (typeof p['api_key_env'] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p['api_key_env'])) {
      throw new Error(`STANDALONE_CONFIG_INVALID: providers[${i}].api_key_env '${String(p['api_key_env'] ?? '')}' 非法——须匹配 [A-Za-z_][A-Za-z0-9_]*`);
    }
    // auth 鉴权头档文法核（可选枚举——拼错静默漂过=运行期 InvalidApiKey 才暴露,病灶离症状两步）// @a: anc-config-standalone-schema
    // provider 级 thinking 文法核（0100 批,^anc-exec-thinking-provider-default——枚举外值加载期
    // 响亮拒,静默失效是 0008③ 同病）// @a: anc-exec-thinking-provider-default
    if (p['thinking'] !== undefined && p['thinking'] !== 'enabled' && p['thinking'] !== 'disabled') {
      throw new Error(`STANDALONE_CONFIG_INVALID: providers[${i}].thinking '${String(p['thinking'])}' 非法（enabled | disabled;缺省落引擎内建步骤类型缺省——五级链第 5 级）`);
    }
    if (p['auth'] !== undefined && p['auth'] !== 'api-key' && p['auth'] !== 'bearer') {
      throw new Error(`STANDALONE_CONFIG_INVALID: providers[${i}].auth '${String(p['auth'])}' 不支持（api-key | bearer;缺省 api-key 发 x-api-key 头）`);
    }
    // max_output_tokens 文法核（可选正整数——静默漂过=预算悄悄错档,同 resource_limits 姿势）// @a: anc-exec-output-budget
    const mot = p['max_output_tokens'];
    if (mot !== undefined && (typeof mot !== 'number' || !Number.isInteger(mot) || mot <= 0)) {
      throw new Error(`STANDALONE_CONFIG_INVALID: providers[${i}].max_output_tokens 须为正整数（实际: ${JSON.stringify(mot)}）`);
    }
  }
  // service_id 归一校验（design v0.3.2）：路由 env 键取大写，大小写歧义会覆盖同一变量；
  // 'default' 是 dispatcher 客户端池保留键，禁用作 service_id
  const seen = new Map<string, string>();
  for (const p of (providers ?? []) as { service_id: string }[]) {
    const upper = p.service_id.toUpperCase();
    if (upper === 'DEFAULT') {
      throw new Error(`STANDALONE_CONFIG_INVALID: service_id '${p.service_id}' 是保留名（dispatcher 缺省客户端键），换一个`);
    }
    const prev = seen.get(upper);
    if (prev !== undefined) {
      throw new Error(`STANDALONE_CONFIG_INVALID: service_id '${prev}' 与 '${p.service_id}' 大小写归一后冲突（路由 env 键 ${upper}_API_KEY 会互相覆盖）`);
    }
    seen.set(upper, p.service_id);
  }
  if (raw['default_model'] !== undefined && typeof raw['default_model'] !== 'string') {
    throw new Error(`STANDALONE_CONFIG_INVALID: default_model 须为字符串（'service/model' 引用或裸模型名）`);
  }
  // 系统层路由规则文法（^anc-exec-model-routing）：step_type 枚举封闭+model 引用可解析,
  // 引用的 service 必须在 providers 内（拼错=请求错后端,default_model 同纪律）
  if (raw['routing_rules'] !== undefined) {
    if (!Array.isArray(raw['routing_rules'])) throw new Error(`STANDALONE_CONFIG_INVALID: routing_rules 须为列表`);
    const CATEGORIES = new Set<string>(ROUTING_CATEGORIES);   // 类型与闸同源单点（0008①——原字面量复写,与 ModelRoute 类型两处漂移）
    for (const [i, r] of (raw['routing_rules'] as Record<string, unknown>[]).entries()) {
      if (r === null || typeof r !== 'object' || typeof r['step_type'] !== 'string' || typeof r['model'] !== 'string') {
        throw new Error(`STANDALONE_CONFIG_INVALID: routing_rules[${i}] 须为 {step_type, model}`);
      }
      if (!CATEGORIES.has(r['step_type'])) {
        throw new Error(`STANDALONE_CONFIG_INVALID: routing_rules[${i}].step_type '${r['step_type']}' 不在类别表（act/commit/reason/check/replan——confirm/ask 是介入点无 LLM 不路由）`);
      }
      // thinking 枚举核（形态 B 2026-08-20——非法值静默失效是 0008③ 同病）// @a: anc-exec-thinking-routing
      if (r['thinking'] !== undefined && r['thinking'] !== 'enabled' && r['thinking'] !== 'disabled') {
        throw new Error(`STANDALONE_CONFIG_INVALID: routing_rules[${i}].thinking '${String(r['thinking'])}' 非法（enabled | disabled;缺省落 provider 级 thinking 或引擎内建步骤类型缺省——五级链见设计 ^anc-exec-thinking-routing）`);
      }
      parseModelRef(r['model'] as string);   // 文法核（两段式合法性）——引用在场核延后到合并后（BUG-E:项目级合法形态就是无 providers,逐文件核引用必误拒）
    }
  }
  // env 节文法闸（hop_env_* 命名空间,^anc-config-hop-env）：键必须 hop_env_ 前缀（防业务配置混入）;
  // 键名含凭证形态即拒（hop_env_* 可落盘入日志——凭证只许 api_key_env 名引用纪律）。// @a: anc-config-hop-env
  if (raw['env'] !== undefined) {
    if (raw['env'] === null || typeof raw['env'] !== 'object' || Array.isArray(raw['env'])) {
      throw new Error(`STANDALONE_CONFIG_INVALID: env 须为键值映射`);
    }
    for (const [k, v] of Object.entries(raw['env'] as Record<string, unknown>)) {
      if (!k.startsWith('hop_env_')) {
        throw new Error(`STANDALONE_CONFIG_INVALID: env 节键 '${k}' 缺 hop_env_ 前缀——spec 环境参数统一命名空间（业务配置勿入此节）`);
      }
      if (credentialLikeHopEnvKey(k)) {   // 三级共用闸（0004,^anc-config-hop-env）
        throw new Error(`STANDALONE_CONFIG_INVALID: env 节键 '${k}' 形似凭证——hop_env_* 会落盘入日志,凭证只许走 providers[].api_key_env（环境变量名引用）`);
      }
      if (typeof v !== 'string') {
        throw new Error(`STANDALONE_CONFIG_INVALID: env 节 '${k}' 值须为字符串`);
      }
      // ~ 前缀归一为 home 绝对路径（YAML 不经 shell,~ 不会被展开——按 workspace 相对解析必错;
      // 配置参考样例即 ~ 写法）。// @a: anc-config-hop-env
      if (v.startsWith('~/')) (raw['env'] as Record<string, unknown>)[k] = join(homedir(), v.slice(2));
    }
  }
  // default_model/routing_rules 的"引用 service 在 providers 内"核 → loadStandaloneConfig 合并后统一做
  // （^anc-config-standalone-schema 校验时点条款,2026-08-13 BUG-E）。此处不再调 resolveStandaloneDefaultModel。
  // tool_servers 各项打 _base_dir（声明所在文件目录——module 相对路径按声明处解析）
  if (Array.isArray(raw['tool_servers'])) {
    const base = dirname(resolve(path));
    for (const sv of raw['tool_servers'] as Record<string, unknown>[]) {
      if (sv && typeof sv === 'object' && !('_base_dir' in sv)) sv['_base_dir'] = base;
    }
  }
  // language 文法核（todo/0084 M2 随合并补齐——原零核,坏值静默当 en:与 log_level 同姿势响亮拒）。
  const lg = raw['language'];
  if (lg !== undefined && lg !== 'en' && lg !== 'zh') {
    throw new Error(`STANDALONE_CONFIG_INVALID: language 须为 en|zh（实际: ${JSON.stringify(lg)}）`);
  }
  // revision_prompt 文法核（^anc-exec-revision-short-weak——坏值静默当 standard=开关悄悄失效,响亮拒）。// @a: anc-exec-revision-short-weak
  const rp = raw['revision_prompt'];
  if (rp !== undefined && rp !== 'standard' && rp !== 'short') {
    throw new Error(`STANDALONE_CONFIG_INVALID: revision_prompt 须为 standard|short（实际: ${JSON.stringify(rp)}）`);
  }
  return raw as unknown as StandaloneConfig;
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

/** run 注册表 + 工具 handler 核心。与 transport 分离（HTTP 演进出口留在 serve() 层）。
 * // @a: anc-struct-mcp-server */
export class HopjitMcpCore {
  private runs = new Map<string, RunEntry>();

  constructor(private config: StandaloneConfig) {}

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
    if (this.config.notify?.channel !== 'dingtalk') return;   // 门② 配置声明了通道
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

  async startRun(specPathArg: string, params?: Record<string, unknown>, stateDir?: string, workspaceDirArg?: string): Promise<Record<string, unknown>> { // @a: anc-mcp-config
    const providerKeys = snapshotProviderKeys(this.config);
    const active = [...this.runs.values()].filter(e => e.state === 'running' || e.state === 'paused').length;
    const maxRuns = this.config.resource_limits?.max_concurrent_runs ?? DEFAULT_MAX_CONCURRENT_RUNS;
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
    const reloaded = reloadProjectConfig(this.config, runCwd);
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
    const provider = this.config.providers[0];
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
    hostConfig.spec_provider ??= new DirSpecProvider(dirname(specPath));
    // 凭证/端点/协议改走 run 级 env 快照（run 隔离不变量,ARCHITECTURE ^anc-run-isolation——
    // 原实现写 process.env 把进程环境当全局注册表:多 run 共享可变槽的反模式实例,且外部
    // 观察者〔子进程/诊断〕会看到凭证泄进进程环境）。dispatcher envOf 只查快照。
    // 键集与构造单点 buildEnvSnapshot（0008③——原手写只冻 providers 三键,固定透传键漏冻,
    // 封闭集下 HOPJIT_MAX_OUTPUT_TOKENS 等用户环境变量静默失效）。
    // @a: anc-run-isolation, anc-exec-protocol-adapter
    hostConfig.env_snapshot = buildEnvSnapshot(this.config, providerKeys);
    hostConfig.language = effectiveConfig.language === 'zh' ? 'zh' : 'en';   // 生成物语言（^anc-i18n-language-config） // @a: anc-i18n-serialize-lang
    // hop_env 覆盖链合成（组合根,^anc-config-hop-env）：配置 env 节（已两级合并）→ params 里
    // hop_env_* 键覆盖（覆盖项从业务 params 中摘出——它是环境参数不是 spec 输入）。
    // @a: anc-config-hop-env
    // hop_env_language 打底注入（^anc-i18n-language-config——language 是项目属性恒在表,
    // hopbuild2 拼头 body 直接引用零判存;env 节/params 显式写 hop_env_language 者按覆盖链后到覆盖）。// @a: anc-i18n-serialize-lang
    const hopEnv: Record<string, string> = { hop_env_language: effectiveConfig.language === 'zh' ? 'zh' : 'en', ...(effectiveConfig.env ?? {}) };   // env 数据面同重读（0012）
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
      // standalone 缺省 debug（2026-08-22 作者定方案③）：日志是唯一核验通道,info 不记 prompt
      // 正文即黑箱;log_level 配置口可降级。见 design mcp-server HopLog 恒开条。// @a: anc-config-standalone-schema
      logLevel: effectiveConfig.log_level ?? 'debug',
      ...(params ? { params } : {}),
      specPath,
      driverChannel: 'mcp',   // 双执行硬闸落账 // @a: anc-exec-driver-channel
    });
    if (init.status !== 'ok') {
      return { error: { code: 'INIT_FAILED', message: ('errors' in init ? init.errors : []).map(e => e.message).join('; ') || 'init 失败' } };
    }
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

    // state_dir 解析后绝对路径随返回——server 重启后 run_status/resume_run 快照兜底据此传参
    return { run_id: entry.runId, status: 'running', state_dir: resolvedStateDir };
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
                const specData = JSON.parse(readFileSync(join(instDir, 'spec.json'), 'utf-8')) as { header?: { outputs?: Array<{ name: string }> }; steps?: Array<{ step_id: string }> };
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
      let restoreConfig = this.config;
      if (pinnedDir) {
        const reloaded = reloadProjectConfig(this.config, pinnedDir);
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
        hostConfig.spec_provider ??= new DirSpecProvider(dirname(specPath));
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
      hostConfig.env_snapshot = buildEnvSnapshot(this.config, snapshotProviderKeys(this.config));
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
      hostConfig.language = restoreConfig.language === 'zh' ? 'zh' : 'en';   // 与 startRun 对齐（M4 随批） // @a: anc-i18n-serialize-lang
      // hop_env restore 合成：配置 env 节打底,快照恢复表覆盖（host_context 持久化了原 run 的
      // params 覆盖与 ask 回填——它是覆盖链更下游产物,配置重合成会丢）。声明根同扩读白名单。
      // env 打底换重读面（todo/0084 M4——原用启动期 this.config.env,同函数内 tool_servers/
      // commands/resource_limits 皆重读面唯 env 启动快照,三节两种口径;并补 hop_env_language
      // 打底与 startRun 对齐）。// @a: anc-config-hop-env, anc-exec-doc-ref-hop-env
      const restoredHopEnv = { hop_env_language: restoreConfig.language === 'zh' ? 'zh' : 'en', ...(restoreConfig.env ?? {}), ...(engine.getRestoredHopEnv() ?? {}) };
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

  resumeRun(runId: string, stepId: string, answer: Record<string, unknown>, stateDir?: string, childInstance?: string): Record<string, unknown> {
    let entry = this.runs.get(runId);
    if (!entry) {
      const restored = this.restoreRun(runId, stateDir);
      if ('error' in restored) return restored as Record<string, unknown>;
      entry = restored as RunEntry;
    }
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
      const isCrashDangling = node && eng.getStepStates().get(stepId) === 'running'
        && node.step_type !== 'confirm' && node.step_type !== 'ask' && !isEscalatePaused;
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
      if (!node || (node.step_type !== 'confirm' && node.step_type !== 'ask' && !isNetworkPaused && !isEscalatePaused)) {
        return { error: { code: 'INVALID_STATE', message: `step_id '${stepId}' 不是本 spec 的 confirm/ask 步骤,也非网络暂停步,也非悬空崩溃步——恢复的 run 只支持顶层暂停点注入或崩溃步重跑（嵌套 call 的暂停随恢复重跑整个 call）` } };
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
          // aborted 钉住（^anc-mcp-stop-run 第2条）：rejected 回调虽为微任务级（与下一条
          // stdio 消息的 stop_run 理论无交叠）,同 applyResult 姿态守一道不依赖时序论证。
          if (entry.state === 'aborted') return;   // @a: anc-mcp-stop-run
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
  // 快照保留可人工检视。五条实施契约见 [[mcp-server#^anc-mcp-stop-run]]。// @a: anc-mcp-stop-run
  stopRun(runId: string): Record<string, unknown> {
    const entry = this.runs.get(runId);
    if (!entry) return { error: { code: 'RUN_NOT_FOUND', message: `run '${runId}' 不在注册表` } };
    if (entry.state === 'completed' || entry.state === 'failed' || entry.state === 'aborted') {
      return { run_id: entry.runId, status: entry.state };   // 终态幂等
    }
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

/** server 装配：五工具注册。core 与 transport 分离（决策注记：HTTP transport 演进出口）。
 * // @a: anc-mcp-tools */
// standalone 的全部对外形态在此装配（design/standalone-mode.md ^anc-struct-standalone-endpoint）：
// 一份 config + 一次注册 + 五个 MCP 工具。// @a: anc-struct-standalone-endpoint
export function buildServer(core: HopjitMcpCore): McpServer {
  const server = new McpServer({ name: 'hopjit', version: '0.1.0' });

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
    },
  }, async ({ spec_path, params, state_dir, workspace_dir }) => jsonContent(await core.startRun(spec_path, params, state_dir, workspace_dir)));

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
    description: '主动中止一个 run（协作式:步间生效,不打断执行中的单步;级联中止全部在飞子实例）。中止是终局不是暂停——不支持 resume;快照保留可检视。已终态的 run 幂等返回现状。',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: { run_id: z.string().describe('要中止的 run') },
  }, async ({ run_id }) => jsonContent(core.stopRun(run_id)));

  return server;
}

/** fail-fast 启动预检（design v0.3.1 review P2）：逐 provider 解引用 api_key_env——
 * 任一缺失即抛错报变量名（原首次 start_run 才暴露，违反 fail-fast 契约）。
 * 从 serve 提取为可测函数：stdio connect 段进程内测不了，预检逻辑不该陪葬在覆盖盲区。
 * // @a: anc-mcp-config */
export function preflightProviderKeys(config: StandaloneConfig): void {
  snapshotProviderKeys(config);
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
  // fail-fast：配置缺失/非法即启动失败并说明修法（design 核心要求 3）
  const config = loadStandaloneConfig(process.env['HOPJIT_CONFIG'] || undefined);
  preflightProviderKeys(config);
  const core = new HopjitMcpCore(config);
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
  process.stderr.write(`hopjit-mcp: standalone server 就绪（provider: ${config.providers[0].service_id}）\n`);
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
