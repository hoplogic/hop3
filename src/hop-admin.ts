// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: hop-cli ^anc-struct-hop-cli
// hop 自身管理面的业务体（todo/0154）：doctor 八问与 ant 七动作,外加它们与 setup 共用的载体探测 / 归属标识助手。
// 原在 cli.ts 里;搬出来是为了让 mcp-server 组合根也能把它们挂成 MCP 工具（doctor / ant_*）而不 import cli.ts。
// 本文件不是组合根：不读 process.env / process.cwd / homedir / hostname / userInfo / process.execPath——机器侧事实
// 由 cli.ts 或 mcp-server.ts 读一次装进 AdminContext 传入（run 隔离不变量 ^anc-run-isolation）;出错一律抛
// `大写码:` 前缀的 Error,不写 stdout、不退出进程——退出码与输出分流是两个薄壳各自的事。
// 语义权威 design/hop-cli.md ^anc-cli-doctor / ^anc-cli-ant;MCP 面 design/mcp-server.md ^anc-mcp-admin-tools。// @a: anc-mcp-admin-tools
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, isAbsolute, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getEngineVersion } from './engine.js';
import { parseSpec } from './parser.js';
import { ENGINE_DEFAULT_MODEL, HOPJIT_ALLOWED_TOOLS, YAML_DUMP_OPTS, STANDARD_TOOL_NAMES } from './provider-types.js';
import { loadTwoLevelRegistry } from './tools-registry.js';
import { configPaths, loadReuseConfig } from './config-load.js';
import { listAnts, resolveAnt, planInstall, applyInstall, removeAnt, adapt, adaptState, ownerId, writeStamp, headerHash, specTitle, hopantError, packAnt, shareAnts, type AdaptEnv, type AntRoots, type AntScope } from './hopant.js';

/** 管理面函数的机器侧事实——组合根每次调用现读后传入（设计 HopSchema AdminContext,[[mcp-server#^anc-mcp-admin-tools]]）。 */ // @a: anc-mcp-admin-tools
export interface AdminContext {
  home: string;                                   // 用户主目录绝对路径——HopAnt 根、~/.hopjit/config.yaml、载体 home 的基准
  cwd: string;                                    // 工作区根绝对路径——CC 项目级配置文件与相对路径参数的解析基准
  env: Record<string, string | undefined>;        // 环境变量只读视图（载体 home 重定向变量 / PATH / ANTHROPIC_* / HOPJIT_CONFIG / api_key_env 在场判定）
  exec_path: string;                              // node 可执行文件路径——握手子进程与 ant bootstrap 脚本都用它起
  login: string;                                  // 登录名,取不到为空串——归属标识缺省值的一项
  hostname: string;                               // 主机名——归属标识缺省值的一项
  roots: AntRoots;                                // 两级 HopAnt 根 antRoots(home, cwd)——项目级 <cwd>/hop_tasks/ants、用户级 <home>/.hopjit/ants（hopant 决策 1 / 9）
}

// @a: anc-cli-carrier-home-resolution
/** 五种载体名。 */
export type Carrier = 'cc' | 'codex' | 'cfuse-cc' | 'cfuse-codex' | 'opencode';
type DriverFamily = 'cc' | 'codex';
/** 载体名全集（setup 的 --carrier 校验与陈旧扫描用）。 */
export const CARRIER_VALUES: Carrier[] = ['cc', 'codex', 'cfuse-cc', 'cfuse-codex', 'opencode'];
/** 载体所属 driver 族：codex / cfuse-codex 归 codex,其余归 cc（含 opencode——只是包装模板选型语义）。 */
export function carrierFamily(c: Carrier): DriverFamily {
  return c === 'codex' || c === 'cfuse-codex' ? 'codex' : 'cc';
}
/** 载体 home 解析（^anc-cli-carrier-home-resolution）：cc/codex 读 CLAUDE_CONFIG_DIR / CODEX_HOME,cfuse-* 固定 ~/.codefuse/engine/*,opencode 读 OPENCODE_CONFIG_DIR 回落 XDG。2026-10-09 doctor 批改为导出。 */ // @a: anc-cli-carrier-home-resolution
export function resolveCarrierHome(ctx: Pick<AdminContext, 'home' | 'env'>, c: Carrier): string {
  const h = ctx.home;
  switch (c) {
    case 'cc':          return ctx.env.CLAUDE_CONFIG_DIR || join(h, '.claude');
    case 'codex':       return ctx.env.CODEX_HOME       || join(h, '.codex');
    case 'cfuse-cc':    return join(h, '.codefuse', 'engine', 'cc');
    case 'cfuse-codex': return join(h, '.codefuse', 'engine', 'codex');
    // opencode 用 XDG：OPENCODE_CONFIG_DIR 重定向 config 目录,缺席回落 $XDG_CONFIG_HOME/opencode（默认 ~/.config/opencode,非 ~/.opencode）。
    case 'opencode':    return ctx.env.OPENCODE_CONFIG_DIR || join(ctx.env.XDG_CONFIG_HOME || join(h, '.config'), 'opencode');
  }
}
// 载体自动探测：home 目录在场=用户至少启动过一次该载体。按解析后的 home 去重（cfuse 会话里
// CLAUDE_CONFIG_DIR 把 cc 重定向到 ~/.codefuse/engine/cc,与 cfuse-cc 同目录只装一次,名取先探到的）。
// 零探到返回空数组,由调用方回落 cc。见 hop-cli ^anc-cli-carrier-autodetect。// @a: anc-cli-carrier-autodetect
export function detectCarriers(ctx: Pick<AdminContext, 'home' | 'env'>): Carrier[] {
  const seen = new Set<string>();
  const found: Carrier[] = [];
  for (const c of ['cc', 'codex', 'opencode', 'cfuse-cc', 'cfuse-codex'] as Carrier[]) {
    const home = resolve(resolveCarrierHome(ctx, c));
    if (!existsSync(home) || seen.has(home)) continue;
    seen.add(home);
    found.push(c);
  }
  return found;
}


/** 读某载体用户级 hop skill 的版本戳（SKILL.md 前几行 `<!-- driver: @hoplogic/hopjit vX.Y.Z … -->`）;缺文件/缺戳/读失败返 null 按"未装"。 */ // @a: anc-cli-first-run-hint
export function installedHopDriverVersion(ctx: Pick<AdminContext, 'home' | 'env'>, c: Carrier): string | null {
  try {
    const head = readFileSync(join(resolveCarrierHome(ctx, c), 'skills', 'hop', 'SKILL.md'), 'utf-8').split('\n', 12).join('\n');
    const m = /<!-- driver: @hoplogic\/hopjit v(\d+\.\d+\.\d+[^\s)]*)/.exec(head);
    return m ? m[1] : null;
  } catch { return null; }
}

// opencode 配置文件:跟随 opencode globalConfigFile,candidates [opencode.jsonc, opencode.json],
// 第一个存在;都不存在用 opencode.jsonc（opencode 标准,首次启动生成它）。见 ^anc-cli-install-skill opencode 载体。
function resolveOcConfigPath(ctx: Pick<AdminContext, 'home' | 'env'>, carrier: Carrier): string {
  const home = resolveCarrierHome(ctx, carrier);
  for (const f of ['opencode.jsonc', 'opencode.json', 'config.json']) {   // 对齐 opencode globalConfigFile 三候选
    const p = join(home, f);
    if (existsSync(p)) return p;
  }
  return join(home, 'opencode.jsonc');
}

// 递归 deep-merge(对齐 opencode mergeDeep):object 递归合并(后者覆盖同名),数组/原始值后者覆盖。
// 用于 opencode 自举 deep-merge provider——options 内部(baseURL/apiKey)也合并,而非浅 merge 整体覆盖。
function deepMerge<T>(a: T, b: unknown): T {
  if (typeof a === 'object' && a !== null && !Array.isArray(a) && typeof b === 'object' && b !== null && !Array.isArray(b)) {
    const result: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
      result[k] = deepMerge(result[k], v);
    }
    return result as T;
  }
  return (b ?? a) as T;
}

// --mcp 配置自举：两级 standalone 配置全缺席时,按载体学习宿主 LLM 后端写系统级配置。
// CC=ANTHROPIC_* 环境变量族;Codex=~/.codex/config.toml 的 model_provider 链。只写凭证名不写值。
// 学习源缺失→不写文件,note 明示需自建。见 design/hop-cli.md ^anc-cli-install-skill --mcp 配置自举子条。
// @a: anc-cli-install-skill
/** 自举学到的一条 provider（与 ~/.hopjit/config.yaml providers[] 同形,只含凭证变量名）。 */
export type StandaloneEntry = { service_id: string; protocol: string; base_url: string; model: string; api_key_env: string };

/** 从宿主 agent 学一条 standalone provider 配置——只读不写（设计 ^anc-cli-doctor learnStandaloneEntry;从 bootstrapStandaloneConfig 抽出的学习半边,
 * 三载体分支与失败 note 文案原样）。bootstrapStandaloneConfig 调它再写文件;doctor 问 7 调它取"没学到"的原因。 */ // @a: anc-cli-doctor, anc-cli-install-skill
export function learnStandaloneEntry(ctx: Pick<AdminContext, 'home' | 'env' | 'cwd'>, carrier: Carrier): { entry: StandaloneEntry; note?: undefined } | { entry?: undefined; note: string } {
  let entry: StandaloneEntry;
  if (carrier === 'opencode') {
    // opencode 自举：deep-merge 三文件（opencode 加载顺序 config.json → opencode.json → opencode.jsonc,
    // 后者覆盖、.jsonc 优先,与 opencode 加载一致）取 model + provider.<id>.options.baseURL + env[0]（凭证名）。
    // protocol 忠实照抄 provider.<id>.npm 字段（0020 批改定——npm 字段=opencode 的 wire_api 等价物:
    // 声明该 provider 用哪个 AI SDK,官方文档明定 @ai-sdk/openai→/v1/responses、
    // @ai-sdk/openai-compatible→chat/completions、@ai-sdk/anthropic→Anthropic 原生）;
    // npm 缺席（内置 provider 协议定义在 opencode 内置注册表,配置文件里抄不到）回退 id 推断:
    // 含 anthropic→anthropic,否则保守取 openai-chat（猜 responses 撞无此面端点=启动即炸,不猜）。
    // 只写凭证名不写值。学习源缺失→不写文件,note 明示。见 design/hop-cli.md ^anc-cli-install-skill opencode 载体 LLM 自举子条。
    // @a: anc-cli-install-skill
    const home = resolveCarrierHome(ctx, carrier);
    const ocFiles = ['config.json', 'opencode.json', 'opencode.jsonc'].map(f => join(home, f));   // opencode 加载顺序
    let model: string | undefined;
    const provider: Record<string, { options?: { baseURL?: string }; env?: string[]; npm?: string }> = {};
    let anyExists = false;
    for (const f of ocFiles) {
      if (!existsSync(f)) continue;
      anyExists = true;
      const errs: ParseError[] = [];
      const c = parseJsonc(readFileSync(f, 'utf-8'), errs) as { model?: string; provider?: Record<string, { options?: { baseURL?: string }; env?: string[]; npm?: string }> };
      if (errs.length > 0) continue;   // 坏文件跳过(best-effort,不阻断 deep-merge 其他文件)
      if (c.model) model = c.model;   // 后者覆盖(.jsonc 优先)
      if (c.provider) {
        for (const [id, p] of Object.entries(c.provider)) {
          provider[id] = deepMerge(provider[id], p);   // 递归 deep-merge provider.<id>(对齐 opencode mergeDeep,options 内部也合并)
        }
      }
    }
    if (!anyExists) {
      return { note: `未自举 standalone 配置：${resolveOcConfigPath(ctx, carrier)} 不存在——请自建 ~/.hopjit/config.yaml` };
    }
    if (!model || !model.includes('/')) {
      return { note: `未自举 standalone 配置：opencode 配置缺 model（"provider/model-id" 格式）——请自建 ~/.hopjit/config.yaml` };
    }
    const slashIdx = model.indexOf('/');
    const providerId = model.slice(0, slashIdx);
    const modelId = model.slice(slashIdx + 1);
    const prov = provider[providerId];
    const baseUrl = prov?.options?.baseURL;
    const envKey = prov?.env?.[0];
    if (!baseUrl) {
      return { note: `未自举 standalone 配置：provider.${providerId} 缺 options.baseURL——请自建 ~/.hopjit/config.yaml` };
    }
    entry = {
      service_id: 'opencode_host',
      protocol: prov?.npm === '@ai-sdk/anthropic' ? 'anthropic'
        : prov?.npm === '@ai-sdk/openai' ? 'openai-responses'
        : prov?.npm ? 'openai-chat'   // @ai-sdk/openai-compatible 及其余 SDK 包一律 chat
        : providerId.toLowerCase().includes('anthropic') ? 'anthropic' : 'openai-chat',
      base_url: baseUrl,
      model: modelId,
      api_key_env: envKey ?? 'OPENAI_API_KEY',
    };
  } else if (carrierFamily(carrier) === 'cc') {
    // 两级学习链：①进程环境 ANTHROPIC_* ②CC settings 文件族 env 块+顶层 model（项目级>用户级——
    // 覆盖"普通终端跑装配"形态:settings env 块只在 CC 会话内注入子进程;运行期 server 由 CC 拉起
    // 必继承 env 块,凭证名引用仍有效）。只取"哪个名字被配了"不抄值（standalone 不变量第 1 条）。
    // 用户级 settings 路径按 carrier home 解析（^anc-cli-carrier-home-resolution——cfuse-cc 读 ~/.codefuse/engine/cc）。
    const settingsEnv: Record<string, string> = {};
    let settingsModel: string | undefined;
    for (const sp of [
      join(resolveCarrierHome(ctx, carrier), 'settings.json'),
      resolve(ctx.cwd, '.claude', 'settings.json'),
      resolve(ctx.cwd, '.claude', 'settings.local.json'),   // 后读者赢=项目级>用户级
    ]) {
      if (!existsSync(sp)) continue;
      try {
        const s = JSON.parse(readFileSync(sp, 'utf-8')) as { env?: Record<string, string>; model?: string };
        for (const [k, v] of Object.entries(s.env ?? {})) if (typeof v === 'string') settingsEnv[k] = v;
        if (typeof s.model === 'string' && s.model.trim()) settingsModel = s.model;
      } catch { /* 坏 settings 不阻塞自举——学习链落下一级 */ }
    }
    const has = (name: string) => !!(ctx.env[name]?.trim() || settingsEnv[name]?.trim());
    const val = (name: string) => ctx.env[name]?.trim() || settingsEnv[name]?.trim() || '';
    const keyEnv = has('ANTHROPIC_AUTH_TOKEN') ? 'ANTHROPIC_AUTH_TOKEN'
      : has('ANTHROPIC_API_KEY') ? 'ANTHROPIC_API_KEY' : null;
    if (!keyEnv) {
      // 两级链都空（如 OAuth 订阅登录——凭证在 keychain 无 env 名,且订阅凭证本不可复用给独立 server）
      return { note: '未自举 standalone 配置：进程环境与 CC settings 文件均无 ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY（OAuth 订阅登录的凭证不可复用给独立 server）——请自建 ~/.hopjit/config.yaml 并配 API key（格式见 docs/reference/配置参考）' };
    }
    entry = {
      service_id: 'cc_host',
      protocol: 'anthropic',
      base_url: val('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com',
      model: val('ANTHROPIC_MODEL') || settingsModel || ENGINE_DEFAULT_MODEL,   // 缺省=引擎缺省模型同源常量（0086 续账修:原字面量第二真值）
      api_key_env: keyEnv,
    };
  } else {
    const tomlPath = join(resolveCarrierHome(ctx, carrier), 'config.toml');
    if (!existsSync(tomlPath)) {
      return { note: `未自举 standalone 配置：${tomlPath} 不存在——请自建 ~/.hopjit/config.yaml` };
    }
    const toml = readFileSync(tomlPath, 'utf-8');
    const model = toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    const providerId = toml.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1];
    // provider 表：providerId 命中 [model_providers.<id>] 节内取 base_url/env_key（节界=下一个 [ 行）
    let baseUrl: string | undefined; let envKey: string | undefined; let wireApi: string | undefined;
    if (providerId) {
      const section = toml.split(new RegExp(`\\[model_providers\\.${providerId}\\]`))[1]?.split(/\n\[/)[0];
      baseUrl = section?.match(/base_url\s*=\s*"([^"]+)"/)?.[1];
      envKey = section?.match(/env_key\s*=\s*"([^"]+)"/)?.[1];
      wireApi = section?.match(/wire_api\s*=\s*"([^"]+)"/)?.[1];
    }
    if (!model || !baseUrl) {
      return { note: `未自举 standalone 配置：${tomlPath} 缺 model/model_provider 的 base_url——请自建 ~/.hopjit/config.yaml` };
    }
    entry = {
      service_id: 'codex_host',
      // protocol 忠实照抄宿主 wire_api（0020 批撤强制降级——responses 适配器实装后照抄即忠实,
      // 原"一律学 openai-chat"防的是预留枚举启动即炸,前提已消;缺省 chat 与 Codex 同）
      protocol: wireApi === 'responses' ? 'openai-responses' : 'openai-chat',
      base_url: baseUrl,
      model,
      api_key_env: envKey ?? 'OPENAI_API_KEY',
    };
  }

  return { entry };
}

/** 放行缺口只读半边（设计 ^anc-cli-doctor ccPermissionMissing）：读 <cwd>/.claude/settings.local.json,算 HOPJIT_ALLOWED_TOOLS 映射后缺哪些;
 * 文件结构不合法时 invalid 带原因（四形态：坏 JSON / 顶层非对象 / permissions 非对象 / allow 非数组）,cfg 回传给 ensureCcPermission 续写。 */ // @a: anc-cli-doctor, anc-cli-install-skill-permission
export function ccPermissionMissing(cwd: string): { path: string; missing: string[]; invalid?: string; cfg: Record<string, unknown>; allow: unknown[] } {
  const entries = HOPJIT_ALLOWED_TOOLS.map(t => `mcp__hopjit__${t}`);
  const hint = `permissions.allow 加 hopjit 工具 ${entries.join(', ')}`;
  const p = resolve(cwd, '.claude', 'settings.local.json');
  let cfg: Record<string, unknown> = {};
  if (existsSync(p)) {
    try { cfg = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>; }
    catch { return { path: p, missing: entries, cfg: {}, allow: [], invalid: `${p} 不是合法 JSON——未写放行（不覆盖用户配置,请修复后重跑 hopjit setup,或手动在 ${hint}）` }; }
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) return { path: p, missing: entries, cfg: {}, allow: [], invalid: `${p} 顶层不是对象——未写放行` };
  }
  // ⑥⑦：permissions / allow 在场但形态非法——不覆盖用户原值,只 note（首版静默替换成 {}/[] 后写盘,review 实抓）
  if (cfg['permissions'] !== undefined && (typeof cfg['permissions'] !== 'object' || cfg['permissions'] === null || Array.isArray(cfg['permissions']))) return { path: p, missing: entries, cfg, allow: [], invalid: `${p} 的 permissions 不是对象——未写放行（不覆盖用户配置,请手动在 ${hint}）` };
  const perms = (cfg['permissions'] as Record<string, unknown> | undefined) ?? {};
  if (perms['allow'] !== undefined && !Array.isArray(perms['allow'])) return { path: p, missing: entries, cfg, allow: [], invalid: `${p} 的 permissions.allow 不是数组——未写放行（不覆盖用户配置,请手动改成数组并${hint.replace('permissions.allow ', '')}）` };
  const allow = (perms['allow'] as unknown[] | undefined) ?? [];
  return { path: p, missing: entries.filter(e => !allow.includes(e)), cfg, allow };
}

/** MCP 注册已注册判定只读半边（设计 ^anc-cli-doctor readMcpRegistration;从 setup 第 4 项三载体分支抽出）：
 * CC 系查 <cwd>/.mcp.json 的 mcpServers.hopjit 与 detectCcHopjitRegistration 的 user/local 两级,任一即 registered;
 * Codex 查 <home>/config.toml 的 [mcp_servers.hopjit];opencode 查三候选配置的 mcp.hopjit 与其 enabled。
 * setup 调它决定"跳过还是写";doctor 问 4 调它判注册、问 5 取 command。坏文件不算已注册,note 带原因。 */ // @a: anc-cli-doctor, anc-cli-install-skill
export interface McpRegistration { registered: boolean; where?: string; command?: string; enabled?: boolean; note?: string; config_path: string }
/** 已注册判定（见上方 McpRegistration 说明）：三载体各自的注册文件与键;setup 与 doctor 同一判法。 */ // @a: anc-cli-doctor
export function readMcpRegistration(ctx: Pick<AdminContext, 'home' | 'env' | 'cwd'>, carrier: Carrier): McpRegistration {
  if (carrier === 'opencode') {
    const home = resolveCarrierHome(ctx, carrier);
    const candidates = [join(home, 'opencode.jsonc'), join(home, 'opencode.json'), join(home, 'config.json')];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      const errs: ParseError[] = [];
      const c = parseJsonc(readFileSync(p, 'utf-8'), errs) as { mcp?: Record<string, { command?: unknown; enabled?: unknown }> };
      if (errs.length > 0) continue;   // 坏 JSON 不算已配（与 setup 同律）
      const h = c.mcp?.['hopjit'];
      if (h) {
        const cmd = Array.isArray(h.command) ? String(h.command[0] ?? '') : typeof h.command === 'string' ? h.command : undefined;
        return { registered: true, where: `${p} mcp.hopjit`, command: cmd, enabled: h.enabled !== false, config_path: p };
      }
    }
    return { registered: false, config_path: candidates.find(p => existsSync(p)) ?? candidates[0] };
  }
  if (carrierFamily(carrier) === 'codex') {
    const configPath = join(resolveCarrierHome(ctx, carrier), 'config.toml');
    const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
    if (/\[mcp_servers\.hopjit\]/.test(existing)) {
      const section = existing.split(/\[mcp_servers\.hopjit\]/)[1]?.split(/\n\[/)[0] ?? '';
      return { registered: true, where: `${configPath} [mcp_servers.hopjit]`, command: section.match(/command\s*=\s*"([^"]+)"/)?.[1], config_path: configPath };
    }
    return { registered: false, config_path: configPath };
  }
  const configPath = resolve(ctx.cwd, '.mcp.json');
  const scope = detectCcHopjitRegistration(ctx, carrier as 'cc' | 'cfuse-cc');
  if (scope) return { registered: true, where: scope, config_path: configPath };
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as { mcpServers?: Record<string, { command?: unknown }> };
      const h = cfg.mcpServers?.['hopjit'];
      if (h) return { registered: true, where: `${configPath} mcpServers.hopjit`, command: typeof h.command === 'string' ? h.command : undefined, config_path: configPath };
    } catch { return { registered: false, config_path: configPath, note: `${configPath} 不是合法 JSON` }; }
  }
  return { registered: false, config_path: configPath };
}


/** setup 注册后的握手自检结果（^anc-cli-install-skill-handshake）：ok / 工具清单 / 独立模式是否可用 / 失败原因与修法。 */
export interface McpHandshake { ok: boolean; tools?: string[]; standalone_available?: boolean; reason?: string; fix?: string }

// 握手子脚本:拉起 server、发 initialize → notifications/initialized → tools/list → tools/call server_status,
// 打印一行 JSON 后关 stdin。放进独立 node 进程跑,外层用 spawnSync 带超时——setup 流程是同步的,
// 而 server 对 stdin 关闭是立即退出,直接 spawnSync 喂 stdin 会在响应写出前退出。
// 脚本正文整体缩进一格：它是子进程的源码文本,里面的 `let` 不是本模块的顶层可变状态;check-process-state 按列首 let 判,缩进后不误报（cli.ts 是组合根原本豁免,搬到这里不豁免）。
const HANDSHAKE_SCRIPT = `
 const cp = require('node:child_process');
 const c = cp.spawn(process.execPath, [process.argv[1]], { stdio: ['pipe', 'pipe', 'pipe'] });
 let out = '', err = '', tools = null, finished = false;
 const send = m => c.stdin.write(JSON.stringify(m) + '\\n');
 const done = r => { if (finished) return; finished = true; process.stdout.write(JSON.stringify(r)); try { c.stdin.end(); } catch {} setTimeout(() => { try { c.kill(); } catch {} process.exit(0); }, 200); };
 c.stderr.on('data', d => { err += d; });
 c.on('error', e => done({ ok: false, stderr: String(e && e.message || e) }));
 c.on('exit', code => done({ ok: false, stderr: err, exit: code }));
 c.stdout.on('data', d => {
   out += d; let i;
   while ((i = out.indexOf('\\n')) >= 0) {
     const line = out.slice(0, i); out = out.slice(i + 1);
     let m; try { m = JSON.parse(line); } catch { continue; }
     if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
     else if (m.id === 2) { tools = ((m.result && m.result.tools) || []).map(t => t.name); send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'server_status', arguments: {} } }); }
     else if (m.id === 3) { let st = null; try { st = JSON.parse(m.result.content[0].text); } catch {} done({ ok: true, tools, status: st }); }
   }
 });
 send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hopjit-setup', version: '0' } } });
`;

/** 注册后的握手自检（^anc-cli-install-skill-handshake）：以当前 node 跑包内 server 走一遍 MCP 握手,另查注册 command 在 PATH 上
 * 能否找到。只报告不修改注册;失败不抛。 */
// @a: anc-cli-install-skill-handshake
export function mcpHandshake(execPath: string, serverJs: string, command: string, pathEnv: string): McpHandshake {
  const reinstallFix = '按 reason 排查后重跑 hopjit setup;包文件不完整时重装 npm install -g @hoplogic/hopjit';
  if (!existsSync(serverJs)) return { ok: false, reason: `包内 server 文件不存在: ${serverJs}`, fix: reinstallFix };
  const r = spawnSync(execPath, ['-e', HANDSHAKE_SCRIPT, serverJs], { encoding: 'utf-8', timeout: 10_000 });
  if (r.error || r.signal) {
    return { ok: false, reason: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal ? 'MCP 握手超时（10 秒内没有完成 initialize → tools/list）' : `握手子进程起不来: ${r.error?.message}`, fix: reinstallFix };
  }
  let res: { ok?: boolean; tools?: string[]; status?: { standalone?: { available?: boolean; reason?: string; fix?: string } } | null; stderr?: string; exit?: number } = {};
  try { res = JSON.parse(r.stdout); } catch { return { ok: false, reason: `握手输出无法解析: ${(r.stdout || r.stderr).slice(-400)}`, fix: reinstallFix }; }
  if (!res.ok) {
    const tail = (res.stderr ?? '').trim().split('\n').slice(-5).join('\n');
    return { ok: false, reason: `server 启动后退出（exit ${String(res.exit)}）${tail ? ':' + tail : ''}`, fix: reinstallFix };
  }
  const onPath = isAbsolute(command) ? existsSync(command)
    : pathEnv.split(delimiter).some(d => d && existsSync(join(d, command)));
  if (!onPath) {
    return { ok: false, tools: res.tools ?? [], reason: `注册里的 command '${command}' 在 PATH 上找不到——载体拉不起 server`,
      fix: `把 npm 全局 bin 目录加进 PATH,或把注册里的 command 改为 "${execPath} ${serverJs}"` };
  }
  const st = res.status?.standalone;
  return {
    ok: true, tools: res.tools ?? [],
    ...(st ? { standalone_available: st.available === true } : {}),
    ...(st && st.available !== true ? { reason: st.reason ?? '', fix: st.fix ?? '' } : {}),
  };
}

// CC 跨 scope 已注册感知：user 级（<CC home>/.claude.json 顶层 mcpServers）与 local 级（projects["<cwd>"]
// .mcpServers）任一有 hopjit 即返回所在 scope 描述,均无返回 null。<CC home>/.claude.json 缺席/解析失败
// 一律 null（best-effort——CC 内部格式演进不拦装）。.claude.json 位置按 ^anc-cli-carrier-home-resolution
// 解析:cfuse-cc 固定 ~/.codefuse/engine/cc/.claude.json;cc 载体读 CLAUDE_CONFIG_DIR（设时 .claude.json 在
// 其下,未设在 home 根 ~/.claude.json——.claude.json 原生与 ~/.claude/ 目录不同层,CLAUDE_CONFIG_DIR
// 重定向后才进配置目录）。见 hop-cli ^anc-cli-install-skill 注册条。
// @a: anc-cli-install-skill
export function detectCcHopjitRegistration(ctx: Pick<AdminContext, 'home' | 'env' | 'cwd'>, carrier: 'cc' | 'cfuse-cc' = 'cc'): string | null {
  const ccJsonPath = ccJsonPathOf(ctx, carrier);   // 与 writeCcLocalRegistration 同一路径解析（查法=写法）
  if (!existsSync(ccJsonPath)) return null;
  try {
    const cc = JSON.parse(readFileSync(ccJsonPath, 'utf-8')) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    if (cc.projects?.[ctx.cwd]?.mcpServers?.['hopjit']) return `CC local 级,${ccJsonPath} projects["${ctx.cwd}"]`;
    if (cc.mcpServers?.['hopjit']) return `CC user 级,${ccJsonPath}`;
    return null;
  } catch { return null; }
}

/** 某个 CC 系载体的 .claude.json 路径（与 detectCcHopjitRegistration 同一解析——查法=写法的物理保证）。 */
function ccJsonPathOf(ctx: Pick<AdminContext, 'home' | 'env'>, carrier: 'cc' | 'cfuse-cc'): string {
  return carrier === 'cfuse-cc'
    ? join(resolveCarrierHome(ctx, 'cfuse-cc'), '.claude.json')
    : (ctx.env.CLAUDE_CONFIG_DIR ? join(ctx.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(ctx.home, '.claude.json'));
}

/** CC 系载体注册的族内感知（^anc-cli-install-skill 注册条 (a)/(b)）：对传入的 CC 系载体逐个查它自己 .claude.json 的 user / local 两级。
 * 项目级 .mcp.json 是全部 CC 系载体共用的注册点,而各载体的用户级配置是不同文件——cc 在 local 级已注册时 cfuse-cc 再写 .mcp.json 就制造了 cc 的同名双 scope,
 * 所以"写不写 .mcp.json"必须按族而不是按单个载体判。perCarrier 的值是 detectCcHopjitRegistration 的 scope 描述,null=该载体没有 user/local 级注册。
 * 载体 .claude.json 缺席或解析失败一律按 null 计（best-effort,与 detectCcHopjitRegistration 同口径）。setup 与 doctor 共用。// @a: anc-cli-install-skill */
export function ccFamilyRegistration(ctx: Pick<AdminContext, 'home' | 'env' | 'cwd'>, carriers: Array<'cc' | 'cfuse-cc'>): { anyRegistered: boolean; perCarrier: Partial<Record<'cc' | 'cfuse-cc', string | null>> } {
  const perCarrier: Partial<Record<'cc' | 'cfuse-cc', string | null>> = {};
  for (const c of carriers) perCarrier[c] = detectCcHopjitRegistration(ctx, c);
  return { anyRegistered: Object.values(perCarrier).some(v => v !== null), perCarrier };
}

/** 往某个 CC 系载体自己的 .claude.json 写一条 local 级注册 `projects["<cwd>"].mcpServers.hopjit = {command: "hopjit-mcp"}`（^anc-cli-install-skill 注册条 (b)）。
 * 与 `claude mcp add --scope local` 的产物同形。四条纪律：只加这一个键（projects[cwd] / mcpServers 不存在就建,其余键一字不动）;文件不是合法 JSON → 抛 INSTALL_SKILL_ERROR 不覆盖;
 * 文件不存在 → 不建,返回 null（.claude.json 由载体首次启动时自己初始化,不存在=该载体不在场,调用方按 (a) 处理）;写的位置就是 detectCcHopjitRegistration 查的位置。
 * 返回写入的文件路径;已有 hopjit 条目时不改动、同样返回路径（幂等）。// @a: anc-cli-install-skill */
export function writeCcLocalRegistration(ctx: Pick<AdminContext, 'home' | 'env' | 'cwd'>, carrier: 'cc' | 'cfuse-cc'): string | null {
  const ccJsonPath = ccJsonPathOf(ctx, carrier);
  if (!existsSync(ccJsonPath)) return null;
  let cc: { projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
  try {
    const parsed = JSON.parse(readFileSync(ccJsonPath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    cc = parsed as typeof cc;
  } catch {
    throw new Error(`INSTALL_SKILL_ERROR: ${ccJsonPath} 不是合法 JSON——修复后重试（不覆盖载体配置）`);
  }
  cc.projects = cc.projects ?? {};
  const proj = (cc.projects[ctx.cwd] = cc.projects[ctx.cwd] ?? {});
  proj.mcpServers = proj.mcpServers ?? {};
  if (!proj.mcpServers['hopjit']) {
    proj.mcpServers['hopjit'] = { command: 'hopjit-mcp' };
    writeFileSync(ccJsonPath, JSON.stringify(cc, null, 2) + '\n', 'utf-8');
  }
  return ccJsonPath;
}

// setup（旧名 install-skill）：把 hop 接进本机的 coding agent。按序七项——选载体、装六件 skill、自举 ~/.hopjit/config.yaml、
// 注册 MCP server、CC 放行 hopjit 工具清单、扫描陈旧副本、回报并指路;职责表见 design/hop-cli.md ^anc-cli-install-skill。

// spec 原文里第一处行首 `Id:` / `标识:` 行的值改成 id,关键词原样保留;两种都没有原文不变。
// pack 的 Id 改写与演示 HopAnt 生成共用（中文关键词的 fact-check-demo 用 `标识:`,只认 `Id:` 会漏改）。
// @a: anc-cli-pack, anc-cli-install-skill-demo-ants
export function rewriteSpecId(raw: string, id: string): string {
  return raw.replace(/^(Id|标识)(\s*:\s*)\S+.*$/m, (_m, kw: string) => `${kw}: ${id}`);
}

/** `git config user.name` **在工作区目录里跑**,取不到为空串（归属标识缺省值的一项）。cwd 必传：MCP 下 server 进程 cwd 不是工作区,继承进程 cwd 会读到别的仓库的配置（2026-10-10 review 抓;设计 hopant 决策 8 / mcp-server AdminContext 条款的唯一例外）。 */
function gitUserName(cwd: string): string {
  try {
    const r = spawnSync('git', ['config', 'user.name'], { encoding: 'utf-8', cwd });
    return r.status === 0 ? r.stdout.trim() : '';
  } catch { return ''; }
}

/** config.yaml 已落盘的 owner_id（决策 8"一旦有值就恒用它"）;没有或坏文件返回 undefined。 */ // @a: anc-cli-ant
export function savedOwnerId(home: string): string | undefined {
  const cfgPath = join(home, '.hopjit', 'config.yaml');
  if (!existsSync(cfgPath)) return undefined;
  try {
    const raw = yamlLoad(readFileSync(cfgPath, 'utf-8'));
    const saved = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)['owner_id'] : undefined;
    return typeof saved === 'string' && saved.trim() ? saved.trim() : undefined;
  } catch { return undefined; /* 坏配置不在这里报——adapt 的注册面读取会响亮拒 */ }
}
/** 本机归属标识（设计 hopant 决策 8）：config.yaml 已有 owner_id 恒用它,没有才由 git user.name（否则 ctx.login）与 ctx.hostname 现算缺省值;只读不写。 */ // @a: anc-cli-ant
export function localOwnerId(ctx: Pick<AdminContext, 'home' | 'cwd' | 'login' | 'hostname'>): string {
  const saved = savedOwnerId(ctx.home);
  if (saved) return saved;
  return ownerId(gitUserName(ctx.cwd), ctx.login, ctx.hostname);
}

/** 把归属标识写回 ~/.hopjit/config.yaml 的 owner_id（决策 8 写的一侧,2026-10-09 子卡 E）：只动这一键,其余键原样;文件不存在新建只含这一键。 */ // @a: anc-cli-ant, anc-hopant-share
export function writeOwnerId(home: string, owner: string): string {
  const cfgPath = join(home, '.hopjit', 'config.yaml');
  let cfg: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    const raw = yamlLoad(readFileSync(cfgPath, 'utf-8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) cfg = raw as Record<string, unknown>;
    else if (raw !== null && raw !== undefined) throw new Error(`CONFIG_ERROR: ${cfgPath} 顶层不是 YAML 映射,不写 owner_id`);
  }
  cfg['owner_id'] = owner;
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, yamlDump(cfg, YAML_DUMP_OPTS), 'utf-8');   // @a: anc-config-yaml-dump-opts
  return cfgPath;
}

// ---------- hopjit doctor：装完之后一条命令答"能不能用"的八问（设计 hop-cli.md ^anc-cli-doctor;作者定名 doctor——"如果 brew doctor 有惯例,那么继续用 doctor"） ----------

/** 只读 <home>/skills/<name>/SKILL.md 的 frontmatter（--- 到 --- 之间）;文件不在返 null。user-invocable 是连字符键。 */ // @a: anc-cli-doctor
export function readSkillFrontmatter(home: string, name: string): { name?: string; description?: string; user_invocable?: boolean } | null {
  const p = join(home, 'skills', name, 'SKILL.md');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf-8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  // 行级取键,不走严格 YAML：载体自己也是按行读 frontmatter（check-driver-carriers 同法）;description 常是不带引号的长句含 ": ",严格 YAML 会炸（真机实抓）
  const line = (key: string) => m[1].split(/\r?\n/).find(l => l.startsWith(`${key}:`))?.slice(key.length + 1).trim();
  const str = (v: string | undefined) => v && v.length ? v : undefined;
  const ui = line('user-invocable');
  return { name: str(line('name')), description: str(line('description')), user_invocable: ui === 'true' ? true : ui === 'false' ? false : undefined };
}

/** 体检单项的四档状态（设计 HopSchema DoctorItem.status）。 */ // @a: anc-cli-doctor
export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'n/a';
/** 体检单项（设计 HopSchema DoctorItem）：哪一问 / 哪个载体 / 四档 / 事实一句 / 补法一句。 */ // @a: anc-cli-doctor
export interface DoctorItem { id: string; carrier: string; status: DoctorStatus; detail: string; hint?: string }
/** 体检报告（设计 HopSchema DoctorReport）：--json 整体输出;exit_code 任一 fail → 1。 */ // @a: anc-cli-doctor
export interface DoctorReport {
  status: 'ok'; action: 'doctor'; engine_version: string; carriers: Carrier[]; items: DoctorItem[];
  summary: { ok: number; warn: number; fail: number; na: number }; exit_code: 0 | 1;
}

/** 八问体检（设计 runDoctor 九步 HopSop）。只读不写;每问调 setup 同一个探测函数。 */ // @a: anc-cli-doctor
export function runDoctor(ctx: AdminContext, opts: { serverJs?: string; handshake?: typeof mcpHandshake } = {}): DoctorReport {
  const { cwd, env } = ctx;
  const items: DoctorItem[] = [];
  const push = (id: string, carrier: string, status: DoctorStatus, detail: string, hint?: string) => { items.push(hint ? { id, carrier, status, detail, hint } : { id, carrier, status, detail }); };
  const carriers = detectCarriers(ctx);
  const engine = getEngineVersion() ?? '0.0.0';
  const isCc = (c: Carrier) => carrierFamily(c) === 'cc' && c !== 'opencode';
  if (carriers.length === 0) {
    // 步 2：零载体——问 1-6 各出一项 fail
    const d = '本机没探到任何 coding agent 的配置目录（~/.claude / ~/.codex / ~/.config/opencode）';
    const h = '装好 Claude Code / Codex / opencode 之一后重跑 hopjit setup';
    for (const id of ['skill_installed', 'skill_version', 'skill_visible', 'mcp_registered', 'mcp_handshake', 'permissions']) push(id, 'none', 'fail', d, h);
  } else {
    // 步 3：问 1-3 逐载体
    for (const c of carriers) {
      const home = resolveCarrierHome(ctx, c);
      const v = installedHopDriverVersion(ctx, c);
      if (v === null) {
        push('skill_installed', c, 'fail', `${join(home, 'skills', 'hop', 'SKILL.md')} 不在`, '运行 hopjit setup');
        push('skill_version', c, 'n/a', 'skill 没装,无从比版本');
        push('skill_visible', c, 'n/a', 'skill 没装,无从判可见');
        continue;
      }
      push('skill_installed', c, 'ok', `${join(home, 'skills', 'hop')}（v${v}）`);
      if (v !== engine) push('skill_version', c, 'warn', `装于 v${v},当前引擎 v${engine}`, '重跑 hopjit setup 刷新');
      else push('skill_version', c, 'ok', `v${v} 与引擎同版`);
      const fm = readSkillFrontmatter(home, 'hop');
      if (!fm || !fm.name || !fm.description) push('skill_visible', c, 'fail', 'SKILL.md frontmatter 缺 name/description,载体不会把它列进菜单', '重跑 hopjit setup --force');
      else if (isCc(c) && fm.user_invocable !== true) push('skill_visible', c, 'fail', 'SKILL.md frontmatter 的 user-invocable 不是 true,/hop 不会出现在菜单', '重跑 hopjit setup --force');
      else push('skill_visible', c, 'ok', isCc(c) ? 'frontmatter name/description 在场且 user-invocable: true' : 'frontmatter name/description 在场（该载体忽略 user-invocable）');
    }
    // 步 4：问 4 逐载体
    const regs = new Map<Carrier, McpRegistration>();
    for (const c of carriers) {
      const reg = readMcpRegistration(ctx, c);
      regs.set(c, reg);
      if (!reg.registered) push('mcp_registered', c, 'fail', `没注册（看了 ${reg.config_path}${reg.note ? `;${reg.note}` : ''}）`, isCc(c) ? '在项目根运行 hopjit setup（CC 的注册是项目级 .mcp.json）' : `运行 hopjit setup --carrier ${c}`);
      else if (c === 'opencode' && reg.enabled === false) push('mcp_registered', c, 'warn', `已注册但 enabled: false（${reg.where}）`, reg.command === 'hopjit-mcp' ? `重跑 hopjit setup（会把 hopjit 自己写的旧形态条目升级为 enabled:true）后新开会话` : `这是 command 不为 hopjit-mcp 的自配条目,setup 不动它——把 ${reg.config_path} 里 mcp.hopjit.enabled 改回 true 后新开会话`);
      else push('mcp_registered', c, 'ok', reg.where ?? reg.config_path);
    }
    // 步 5：问 5 只做一次
    const first = carriers.find(c => regs.get(c)?.registered);
    if (!first) push('mcp_handshake', '-', 'n/a', '没有任何注册,不拉起 server');
    else {
      const command = regs.get(first)?.command || 'hopjit-mcp';
      const serverJs = opts.serverJs ?? resolve(dirname(fileURLToPath(import.meta.url)), 'mcp-server.js');
      const h = (opts.handshake ?? mcpHandshake)(ctx.exec_path, serverJs, command, env.PATH ?? '');
      if (!h.ok) push('mcp_handshake', first, 'fail', h.reason ?? '握手失败', h.fix);
      else push('mcp_handshake', first, 'ok', `${h.tools?.length ?? 0} 个工具（command: ${command}）`);
    }
    // 步 6：问 6 逐载体,只 cc 系
    for (const c of carriers) {
      if (!isCc(c)) { push('permissions', c, 'n/a', '该载体没有放行清单这一层'); continue; }
      const gap = ccPermissionMissing(cwd);
      if (gap.invalid) push('permissions', c, 'fail', gap.invalid, `修好 ${gap.path} 的 JSON 结构后重跑 hopjit setup`);
      else if (gap.missing.length) push('permissions', c, 'fail', `缺 ${gap.missing.length} 项放行（${gap.path}）`, '在项目根运行 hopjit setup');
      else push('permissions', c, 'ok', `${HOPJIT_ALLOWED_TOOLS.length} 项全在（${gap.path}）`);
    }
  }
  // 步 7：问 7 与载体无关
  const paths = configPaths(ctx.home, cwd, env['HOPJIT_CONFIG'] || undefined);
  const { config } = loadReuseConfig(paths);
  const providers = config.providers ?? [];
  if (providers.length === 0) {
    const c0 = carriers[0];
    const why = c0 ? (learnStandaloneEntry(ctx, c0).note ?? '') : '本机没探到载体,无学习源';
    const reason = why.replace(/^未自举 standalone 配置：/, '').replace(/——请自建.*$/, '');
    push('mcp_llm_config', '-', 'fail', `MCP server 的模型没配置：setup 从 ${c0 ?? '载体'} 没学到 LLM 配置${reason ? `——${reason}` : ''}`,
      `自建 ${paths.sysPath} 写一个 provider（格式见 docs/reference/配置参考.md）,或在能学到配置的载体环境里重跑 hopjit setup`);
    push('standalone_credential', '-', 'n/a', '没有 providers,无凭证可核');
  } else {
    push('mcp_llm_config', '-', 'ok', providers.map(p => `${p.service_id}: ${p.model}`).join('; '));
    const missing = providers.map(p => p.api_key_env).filter(n => typeof n === 'string' && !env[n]?.trim());
    if (missing.length) push('standalone_credential', '-', 'warn', `独立模式凭证变量 ${missing.join(', ')} 未设置`, `只影响 MCP 独立模式（start_run）,主路 /hop 不受影响;要用独立模式先 export ${missing[0]}`);
    else push('standalone_credential', '-', 'ok', '各 provider 的 api_key_env 都有值');
  }
  // 步 9
  const summary = { ok: 0, warn: 0, fail: 0, na: 0 };
  for (const it of items) { if (it.status === 'n/a') summary.na++; else summary[it.status]++; }
  return { status: 'ok', action: 'doctor', engine_version: engine, carriers, items, summary, exit_code: summary.fail > 0 ? 1 : 0 };
}

/** 人读形态（照 brew doctor：每项一行 + 指路 + 末行 summary）。 */ // @a: anc-cli-doctor
export function formatDoctorReport(r: DoctorReport): string {
  const lines = [`hopjit doctor — v${r.engine_version}`];
  for (const it of r.items) {
    const tag = `[${it.status}]`.padEnd(7);
    lines.push(`${tag} ${it.id.padEnd(22)} ${it.carrier.padEnd(12)} ${it.detail}${it.hint ? ` → ${it.hint}` : ''}`);
  }
  lines.push(`summary: ${r.summary.ok} ok / ${r.summary.warn} warn / ${r.summary.fail} fail / ${r.summary.na} n/a`);
  return lines.join('\n') + '\n';
}

// ---------- hopjit ant：HopAnt 七动作的组合根无关业务体（设计 hop-cli.md ^anc-cli-ant「实现落点」;cli `ant` 子命令与 mcp `ant_*` 工具各套薄壳） ----------

/** ant 动作的响应对象（AntResponse,形状见 hop-cli.md ^anc-cli-ant-response）。 */ // @a: anc-cli-ant
export type AntResponse = Record<string, unknown>;

/** 两级配置路径（系统级 ~/.hopjit/config.yaml + 项目级 hopjit.yaml;HOPJIT_CONFIG 在场即单文件语义）——唯一来源 config-load.configPaths。 */ // @a: anc-cli-ant, anc-struct-config-load-exports
function adaptConfigPaths(ctx: Pick<AdminContext, 'home' | 'env' | 'cwd'>): { sysPath: string | null; projPath: string | null } {
  const p = configPaths(ctx.home, ctx.cwd, ctx.env['HOPJIT_CONFIG'] || undefined);
  return { sysPath: p.sysPath, projPath: p.projPath };
}

/** `ant list`：已装 HopAnt 与各自的适配三态（never / stale / adapted 在 hopant.adaptState 里判）。 */ // @a: anc-cli-ant, anc-mcp-admin-tools
export function antList(ctx: AdminContext): AntResponse {
  const owner = localOwnerId(ctx);
  const ants = listAnts(ctx.roots).map(({ id, scope, dir }) => {   // 两级合并,项目级在前,同 id 两条都在（决策 9）
    let title = '';
    try { title = specTitle(parseSpec(readFileSync(join(dir, `${id}.md`), 'utf-8')).ast.header.title); } catch { title = '（入口 spec 解析失败）'; }
    return { id, scope, title, adapt_state: adaptState(dir, owner) };
  });
  return { status: 'ok', action: 'list', ants };
}

/** `ant install <dir> [--dry-run] [--scope user|project]`：单 HopAnt 目录或 HopAnt 包根 → 用户级 ~/.hopjit/ants/（缺省）或项目级 <cwd>/hop_tasks/ants/;撞 id 只在目标级内判,整单拒;不自动跑任何脚本。 */ // @a: anc-cli-ant, anc-mcp-admin-tools
export function antInstall(ctx: AdminContext, dirArg: string, dryRun: boolean, scope: AntScope = 'user'): AntResponse {
  const src = isAbsolute(dirArg) ? dirArg : resolve(ctx.cwd, dirArg);
  const plan = planInstall(src, ctx.roots[scope]);   // 缺省用户级：装别人的 HopAnt 是给自己用;project=只在这个项目里用（决策 1）
  if (dryRun) return { status: 'ok', action: 'install', dry_run: true, scope, plan };
  const result = applyInstall(plan);
  return { status: 'ok', action: 'install', scope, plan, result,
    ...(result.bootstrap_pending.length ? { next_step: `这些 HopAnt 带安装脚本,先看计划再决定跑不跑：${result.bootstrap_pending.map(id => `hopjit ant bootstrap ${id} --dry-run`).join(' ; ')}` } : {}) };
}

/** `ant adapt <id>`：核本机对该 HopAnt 的依赖（工具注册 / 凭证 / 命令 / 引擎版本）,全绿写适配戳;report.ok 为 false 时照常返回（退出码由 cli 薄壳置）。 */ // @a: anc-cli-ant, anc-mcp-admin-tools
export function antAdapt(ctx: AdminContext, id: string): AntResponse {
  const hit = resolveAnt(ctx.roots, id);   // 两级查找,项目级先（决策 9）
  if (!hit) throw hopantError('HOPANT_NOT_FOUND', `没有装过 HopAnt '${id}'（本项目 hop_tasks/ants/ 与 ~/.hopjit/ants/ 都没有）——hopjit ant list 看已装的`);
  const dir = hit.dir;
  const { sysPath, projPath } = adaptConfigPaths(ctx);
  const reg = loadTwoLevelRegistry(sysPath, projPath);
  const env: AdaptEnv = {
    tool_servers: reg.tool_servers, providers: reg.providers,
    env_vars: ctx.env,
    path_dirs: (ctx.env['PATH'] ?? '').split(delimiter).filter(Boolean),
    engine_version: getEngineVersion(),
  };
  const report = adapt(dir, env);
  let stamp_written: string | null = null;
  if (report.ok) {
    const text = readFileSync(join(dir, `${id}.md`), 'utf-8');
    const owner = localOwnerId(ctx);
    const hash = headerHash(text);
    stamp_written = writeStamp(dir, { adapted: `${owner} @ ${hash}`, owner, hash, at: new Date().toISOString(), report });
  }
  return { status: 'ok', action: 'adapt', id, scope: hit.scope, report, stamp_written };
}

/** `ant remove <id> [--keep-store] [--scope]`：卸载——不带 scope 删两级查找命中的那一个（项目级先）;keep_store 先把 inner_store/ 挪到备份位。 */ // @a: anc-cli-ant, anc-mcp-admin-tools
export function antRemove(ctx: AdminContext, id: string, keepStore: boolean, scope?: AntScope): AntResponse {
  const removedScope = removeAnt(ctx.roots, id, keepStore, scope);   // scope 缺省删两级查找命中的那一个（决策 9）
  const removed = removedScope !== null;
  return { status: 'ok', action: 'remove', id, removed, ...(removed ? { scope: removedScope } : {}), kept_store: keepStore && removed };
}

/** `ant bootstrap <id> [--dry-run]`：跑 HopAnt 自带的 bootstrap.js（ctx.exec_path 起,cwd 为 ant 目录,env 用 ctx.env）;没有脚本 has_bootstrap:false 不报错;脚本退出码进 returncode。 */ // @a: anc-cli-ant, anc-mcp-admin-tools
export function antBootstrap(ctx: AdminContext, id: string, dryRun: boolean): AntResponse {
  const hit = resolveAnt(ctx.roots, id);
  if (!hit) throw hopantError('HOPANT_NOT_FOUND', `没有装过 HopAnt '${id}'（本项目 hop_tasks/ants/ 与 ~/.hopjit/ants/ 都没有）——hopjit ant list 看已装的`);
  const dir = hit.dir;
  const script = join(dir, 'bootstrap.js');
  if (!existsSync(script)) return { status: 'ok', action: 'bootstrap', id, scope: hit.scope, has_bootstrap: false };
  const r = spawnSync(ctx.exec_path, [script, ...(dryRun ? ['--dry-run'] : [])], { cwd: dir, encoding: 'utf-8', env: ctx.env as NodeJS.ProcessEnv });
  return { status: 'ok', action: 'bootstrap', id, scope: hit.scope, has_bootstrap: true, dry_run: dryRun,
    returncode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `ant pack <spec> [--out] [--id] [--assets…]`：spec → `<out>/<id>/` 可装目录（头对账增删进 reconciled）;spec 不存在或不可读抛 PACK_ERROR（设计 hop-cli.md ^anc-cli-ant pack 条）。 */ // @a: anc-cli-ant, anc-hopant-pack, anc-mcp-admin-tools
export function antPack(ctx: AdminContext, spec: string, opts: { out?: string; id?: string; assets?: string[] }): AntResponse {
  const specAbs = resolve(ctx.cwd, spec);
  if (!existsSync(specAbs)) throw new Error(`PACK_ERROR: spec 文件不存在: ${specAbs}`);
  // 存在但读不出（权限 000 / 是目录等）也归 PACK_ERROR,不让裸 EACCES 之类系统错误漏到调用方（0156 语义审计）。 // @a: anc-cli-ant, anc-hopant-pack
  try { readFileSync(specAbs, 'utf-8'); }
  catch (e) { throw new Error(`PACK_ERROR: 入口 spec 存在但读不出: ${specAbs}（${e instanceof Error ? e.message : String(e)}）`); }
  const outDir = resolve(ctx.cwd, opts.out ?? 'ants');
  // outDir 就是某级 HopAnt 根（driver 总结时传项目级根）→ 让 packAnt 重建该根索引,产物就地是活的 HopAnt;封到别处是待装目录,索引归 install。// @a: anc-hopant-index
  const indexRoot = [ctx.roots.project, ctx.roots.user].find(root => resolve(root) === outDir);
  const r = packAnt(specAbs, outDir, { id: opts.id, assets: opts.assets, indexRoot, rewriteId: rewriteSpecId });
  return { status: 'ok', action: 'pack', id: r.id, pack: r,
    next_step: `hopjit ant install ${r.dir}（装进本机）;改动见 pack.reconciled——封装对账补/删了入口 spec 头的这些声明${r.reconciled.tools_added.some(t => !STANDARD_TOOL_NAMES.has(t)) ? ';tools_added 里的非标准工具写的是占位签名 (input),装机前要按工具真实参数改签名,否则 adapt 报参数不符' : ''}` };
}

/** `ant share <id>… [--out] [--name] [--pkg-version] [--owner|--yes]`：已装 HopAnt → HopAnt 包目录;归属标识四态（决策 8"答过不再问"）：
 * --owner > config 已落盘 owner_id（在场即用,不问）> --yes 首机现算 > 首机无旗 → 不写包,把缺省值交 driver 在对话里问。成功后 owner 写回 config.yaml。 */ // @a: anc-cli-ant, anc-hopant-share, anc-mcp-admin-tools
export function antShare(ctx: AdminContext, ids: string[], opts: { out?: string; name?: string; pkg_version?: string; owner?: string; yes?: boolean }): AntResponse {
  const owner = opts.owner?.trim() || savedOwnerId(ctx.home) || (opts.yes ? localOwnerId(ctx) : undefined);
  if (!owner) {
    return { status: 'ok', action: 'share', owner_prompt_required: true, owner_default: localOwnerId(ctx),
      next_step: '分享包会带上归属标识——在对话里问用户用缺省还是改一个,然后带 --owner <值> 重跑（用户确认缺省也带 --owner）' };
  }
  const r = shareAnts(ctx.roots, ids, resolve(ctx.cwd, opts.out ?? '.'), { name: opts.name, version: opts.pkg_version ?? '0.1.0', owner });
  const written = writeOwnerId(ctx.home, owner);
  return { status: 'ok', action: 'share', share: r, owner_written: written, credential_scan: r.credential_scan,
    next_step: `包目录 ${r.dir} 可直接 hopjit ant install;要压缩自己 tar czf,要发 git 自己 git init && push${r.credential_scan.warnings.length ? `;凭证扫描有 ${r.credential_scan.warnings.length} 条警告,逐条给用户看` : ''}` };
}
