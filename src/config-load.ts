// config-load：两级配置读取、文法核、合并、引用核——独立模式（mcp-server）与复用模式（cli）共用的唯一一份实现。
// 设计 [[config-load]]（todo/0131,作者 2026-09-30 拍形态 1 新建模块）。parseConfigFile / mergeConfigs / validateMergedRefs
// 与两个类型原样自 mcp-server.ts 搬入（搬家探针：只搬不改全量绿后才加复用模式消费面）。
// 模块不读进程状态：家目录与项目根由组合根算好传入（^anc-run-isolation）。
// @module: config-load ^anc-struct-config-load
import { load as yamlLoad } from 'js-yaml';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { parseModelRef } from './dispatcher.js';
import { enrichParamsComments, parseToolServers, type ToolServerEntry } from './tools-registry.js';
import { credentialLikeHopEnvKey, ROUTING_CATEGORIES, type HostConfig } from './provider-types.js';
import { isAbsolute } from 'node:path';

// ── HopConfig（原名 StandaloneConfig——两种模式共用后改名;schema 权威：shared-providers ^anc-config-standalone-schema）──

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
  // 声明"这个端点的思考关不掉"（todo/0118——glm-5.3-flash 收到 thinking disabled 报 400）。
  // true 时五级链算出"关"的请求改发 output_config {effort: low}、不带 thinking 键;只认布尔,
  // 只对 anthropic 协议有意义。env 键 {SERVICE_ID}_THINKING_DISABLE_UNSUPPORTED=true 只在 true 时披。
  // 设计 [[shared-providers#^anc-config-standalone-schema]] 同名行。// @a: anc-exec-thinking-disable-unsupported
  thinking_disable_unsupported?: boolean;
}

/** HopConfig：两级配置合并后的完整形态（独立模式与复用模式共用;原名 StandaloneConfig）。见 [[shared-providers#^anc-config-standalone-schema]] // @a: anc-struct-config-load */
// 一份（或合并后的一份）配置的 TS 形态（设计 HopSchema HopConfig,字段语义权威 shared-providers）// @a: anc-struct-config-load-types
export interface HopConfig {
  providers: ProviderEntry[];
  default_model?: string;
  // 系统层按类别路由（两层配置的系统半边——spec 层 Config.models 逐类别继承本层）。
  // 见 shared-providers ^anc-config-standalone-schema / step-dispatcher ^anc-exec-model-resolve。
  // @a: anc-exec-model-routing
  routing_rules?: Array<{ step_type: string; model: string; thinking?: 'enabled' | 'disabled' }>;
  // spec 环境参数（hop_env_* 命名空间,概念 ^anc-config-hop-env——非密可落盘,凭证禁入）// @a: anc-config-hop-env
  env?: Record<string, string>;
  // 生成物语言（项目级 hopjit.yaml language: zh|en,缺省跟随系统语言 detectSystemLanguage,^anc-i18n-language-config——
  // 序列化/read_spec_tree 读回/hopbuild2 生成面消费;注入 hop_env_language）// @a: anc-i18n-serialize-lang
  language?: 'en' | 'zh';
  // 本机归属标识 `<用户>-<主机>`（HopAnt 适配戳与谱系用;打包分享时明示并问要不要改、答过写回本键,之后恒用——
  // design/hopant.md 决策 8,shared-providers ^anc-config-standalone-schema 同名行）。只在系统级有意义,不进 mergeConfigs。
  // @a: anc-config-standalone-schema
  owner_id?: string;
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
  // HopLog 记录级别（缺省 info——2026-09-30 todo/0127 作者定,对外分发防塞爆硬盘;2026-08-22 曾定 debug。
  // 排障经此口升 debug）。合并项目级赢;非法值加载期拒。见 design mcp-server HopLog 恒开条。
  // @a: anc-config-standalone-schema
  log_level?: 'debug' | 'info' | 'warn';
  // 日志保留上限（todo/0127 作者定——对外分发防塞爆硬盘,只此一个旋钮,缺省 max_runs=3）。合并项目级赢;非正整数加载期拒。
  // 见 [[spec-observability#^anc-obs-log-retention]] // @a: anc-obs-log-retention
  log_retention?: { max_runs: number };
}

// 跨节引用校验（合并后统一做——^anc-config-standalone-schema 校验时点条款,2026-08-13 BUG-E 实撞：
// 项目级文件合法形态=只有 routing_rules+tool_servers,providers 归系统级;逐文件核引用必把合法形态
// 误拒〔实撞 providers undefined 崩 server 启动〕。文法核〔step_type 枚举/形状/明文 key〕仍逐文件）。
// @a: anc-mcp-config, anc-config-standalone-schema
export function validateMergedRefs(config: HopConfig, resolveDefault?: (config: HopConfig) => unknown): void {   // @a: anc-struct-config-load-exports
  const providers = config.providers ?? [];
  for (const [i, r] of (config.routing_rules ?? []).entries()) {
    const ref = parseModelRef(r.model);
    if (ref.service_id !== 'default' && !providers.some(p => p.service_id.toUpperCase() === ref.service_id.toUpperCase())) {
      throw new Error(`STANDALONE_CONFIG_INVALID: routing_rules[${i}].model 引用的 service '${ref.service_id}' 不在合并后 providers 内`);
    }
  }
  resolveDefault?.(config);   // default_model 引用核（独立模式传 resolveStandaloneDefaultModel;复用模式不用 providers 不传）
}

// 逐节合并（项目级赢）：providers 按 service_id、routing_rules 按 step_type 覆盖同键,其余项目级在场即赢。
// tool_servers 取并集（同 server 名项目级赢;工具名跨级判重归装配层既有 fail-fast）。// @a: anc-config-standalone-schema
export function mergeConfigs(sys: HopConfig, proj: HopConfig): HopConfig {   // 逐键规则权威 [[config-load#^anc-config-two-level-merge]] // @a: anc-config-two-level-merge
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
    ...((proj.log_retention ?? sys.log_retention) ? { log_retention: proj.log_retention ?? sys.log_retention } : {}),   // 项目级赢 // @a: anc-obs-log-retention
    ...((proj.language ?? sys.language) ? { language: proj.language ?? sys.language } : {}),   // 项目级赢（todo/0084 M2——本键曾漏合并:项目级 zh 在 MCP 侧静默蒸发落 en 与 CLI 劈叉,恰是上一行 commands 前车注警告的同型复发;新顶层键必须同步本函数+补合并测试钉） // @a: anc-i18n-serialize-lang
    ...((proj.revision_prompt ?? sys.revision_prompt) ? { revision_prompt: proj.revision_prompt ?? sys.revision_prompt } : {}),   // 项目级赢（^anc-exec-revision-short-weak;新顶层键必须同步本函数——0084 M2 前车） // @a: anc-exec-revision-short-weak
  };
}

/** 读一份配置文件 + 逐文件文法核（各节形状 / step_type 枚举 / 明文 api_key 拒 / hop_env_ 前缀与凭证形态键拒 / ~ 按 homeDir 归一）;
 * required=false 且文件缺席返 {providers: []};tool_servers 各项打 _base_dir=该文件所在目录。原 mcp-server 同名函数原样搬入。 */ // @a: anc-struct-config-load-exports
export function parseConfigFile(path: string, required: boolean, homeDir: string): HopConfig {
  if (!existsSync(path)) {
    if (required) {
      throw new Error(`STANDALONE_CONFIG_MISSING: 配置文件不存在（${path}）。standalone 需要 providers 配置（YAML），`
        + `格式见 docs/design/shared-providers.md ^anc-config-standalone-schema`);
    }
    return { providers: [] };
  }
  const content = readFileSync(path, 'utf-8');
  // 空文件 / 纯注释文件按零配置（`hopjit init` 生成的项目级模板全是注释行,是常见形态;与 tools-registry loadTwoLevelRegistry 同判）
  // ——此前当"顶层不是映射"拒,复用模式分文件容错把它当坏文件连系统级一起丢（review 面二 E 回归）。// @a: anc-config-reuse-consume
  if (content.split('\n').every(l => !l.trim() || l.trim().startsWith('#'))) return { providers: [] };
  const parsed = yamlLoad(content);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`STANDALONE_CONFIG_INVALID: ${path} 不是 YAML 映射（顶层须是 key: value 结构）`);
  }
  const raw = parsed as Record<string, unknown>;
  // D7: tool_servers 须是数组且各项是映射——null / 标量条目在合并 byKey 取 .name 时会崩成 TypeError,
  // 这里按文法核点名下标响亮拒（设计出口表 parseConfigFile 行;复用模式 loadReuseConfig 对 tool_servers 错不吞）。// @a: anc-config-reuse-consume
  if (raw['tool_servers'] !== undefined) {
    if (!Array.isArray(raw['tool_servers'])) throw new Error(`STANDALONE_CONFIG_INVALID: ${path} tool_servers 须为数组`);
    (raw['tool_servers'] as unknown[]).forEach((sv, i) => {
      if (sv === null || typeof sv !== 'object' || Array.isArray(sv)) {
        throw new Error(`STANDALONE_CONFIG_INVALID: ${path} tool_servers[${i}] 须为映射（name/kind/… 键值）,实际: ${JSON.stringify(sv)}`);
      }
    });
  }
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
  // log_retention 文法核（同姿势——max_runs 非正整数静默当缺省=用户以为限了实际没限）。// @a: anc-obs-log-retention
  const lr = raw['log_retention'];
  if (lr !== undefined) {
    const mr = (lr as { max_runs?: unknown } | null)?.max_runs;
    if (typeof lr !== 'object' || lr === null || !Number.isInteger(mr) || (mr as number) < 1) {
      throw new Error(`STANDALONE_CONFIG_INVALID: log_retention.max_runs 须为正整数（实际: ${JSON.stringify(lr)}）`);
    }
  }
  // 至少 1 条的校验在两级合并后统一做（项目级文件可只有 tool_servers 节）——见 loadHopConfig 尾部
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
    // thinking_disable_unsupported 文法核（todo/0118）:只认 YAML 布尔——字符串 "true"/数字 1 静默当真或当假
    // 都是配置悄悄错档;非 anthropic 协议写 true 拒——openai-responses 适配器本就把 disabled 映成
    // reasoning.effort low,openai-chat 不透传思考参数,写了等于静默失效。// @a: anc-exec-thinking-disable-unsupported
    const tdu = p['thinking_disable_unsupported'];
    if (tdu !== undefined && typeof tdu !== 'boolean') {
      throw new Error(`STANDALONE_CONFIG_INVALID: providers[${i}].thinking_disable_unsupported 须为布尔 true 或 false（实际: ${JSON.stringify(tdu)}）——声明该端点思考关不掉,写 true 后引擎要关思考时改发 output_config effort low`);
    }
    if (tdu === true && p['protocol'] !== 'anthropic') {
      throw new Error(`STANDALONE_CONFIG_INVALID: providers[${i}].thinking_disable_unsupported 只对 protocol: anthropic 有效（实际 protocol: ${String(p['protocol'])}）——openai-responses 已把关思考映成 reasoning.effort low,openai-chat 不发思考参数,写了不会产生任何效果`);
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
      if (v.startsWith('~/')) (raw['env'] as Record<string, unknown>)[k] = join(homeDir, v.slice(2));
    }
  }
  // default_model/routing_rules 的"引用 service 在 providers 内"核 → loadHopConfig 合并后统一做
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
  return raw as unknown as HopConfig;
}

/** 两级配置路径（^anc-struct-config-load-exports）：显式路径（HOPJIT_CONFIG）在场=单文件语义 projPath null;否则系统级 <home>/.hopjit/config.yaml + 项目级 <projectDir>/hopjit.yaml。
 * 组合根算好 homeDir / projectDir / explicitPath 后调它——"路径怎么来"的唯一一处。 */ // @a: anc-struct-config-load-exports
// 两级配置文件位置（设计 HopSchema ConfigPaths,[[config-load#^anc-struct-config-load-types]]）// @a: anc-struct-config-load-types
export interface ConfigPaths { sysPath: string; projPath: string | null; homeDir: string }
/** 算两级路径（见上 ConfigPaths 说明）。 */ // @a: anc-struct-config-load-exports
export function configPaths(homeDir: string, projectDir: string, explicitPath?: string): ConfigPaths {
  if (explicitPath) return { sysPath: resolve(explicitPath), projPath: null, homeDir };
  return { sysPath: join(homeDir, '.hopjit', 'config.yaml'), projPath: join(projectDir, 'hopjit.yaml'), homeDir };
}

/** 两级加载主入口（HopSop 见 [[config-load#^anc-config-two-level-merge]]）。
 * requireProviders=true 是独立模式：两级全缺席抛 STANDALONE_CONFIG_MISSING,合并后 providers 空抛 STANDALONE_CONFIG_MISSING_PROVIDERS;
 * false 是复用模式：零配置返 {providers: []}。resolveDefault 透传给 validateMergedRefs 做 default_model 引用核。 */ // @a: anc-config-two-level-merge
export function loadHopConfig(paths: ConfigPaths, opts: { requireProviders: boolean; resolveDefault?: (config: HopConfig) => unknown }): HopConfig {
  const { sysPath, projPath, homeDir } = paths;
  if (projPath === null) {
    const c = parseConfigFile(sysPath, /*required*/ true, homeDir);
    if (opts.requireProviders && !c.providers?.length) throw new Error(`STANDALONE_CONFIG_INVALID: ${sysPath} 缺 providers[]（至少 1 条）`);
    validateMergedRefs(c, opts.resolveDefault);   // 单文件=合并结果本身,过同一核
    return c;
  }
  const sys = existsSync(sysPath) ? parseConfigFile(sysPath, true, homeDir) : null;
  const proj = existsSync(projPath) ? parseConfigFile(projPath, false, homeDir) : null;
  if (!sys && !proj) {
    if (opts.requireProviders) {
      throw new Error(`STANDALONE_CONFIG_MISSING: 配置文件不存在（${sysPath} 与 ${projPath} 均缺席）。standalone 需要 providers 配置（YAML），`
        + `格式见 docs/design/shared-providers.md ^anc-config-standalone-schema`);
    }
    return { providers: [] };   // 复用模式零配置是合法状态
  }
  const merged = !proj ? sys! : (!sys ? proj : mergeConfigs(sys, proj));
  if (opts.requireProviders && !merged.providers?.length) {
    throw new Error(`STANDALONE_CONFIG_MISSING_PROVIDERS: 两级配置合并后 providers 为空（至少 1 条——通常在系统级 ${sysPath}）`);
  }
  validateMergedRefs(merged, opts.resolveDefault);
  return merged;
}

/** 复用模式容错包装（^anc-config-reuse-consume HopSop 四分支）：commands 含 hopjit 的 CONFIG_ERROR 原样抛;其余加载错误
 * （坏 YAML / 顶层非映射 / 各节形状不符 / providers 节文法错）回空配置并带一条 warning——能力关死是安全侧,不炸 CLI。
 * tool_servers 坏条目在 loadToolRegistry 调 parseToolServers 时才响亮抛,本函数不吞它。 */ // @a: anc-config-reuse-consume
export function loadReuseConfig(paths: ConfigPaths): { config: HopConfig; warnings: string[] } {
  // 分文件容错（设计 ^anc-config-reuse-consume HopSop readOne 六步）：坏的那份按零配置并点名,好的那份保留——
  // 原形态对合并整体 try/catch,项目级纯注释模板一坏连系统级 zh / commands 一起丢（review 面二 E 回归）。
  const readOne = (path: string | null): { config: HopConfig | null; warnings: string[] } => {
    if (path === null || !existsSync(path)) return { config: null, warnings: [] };
    try {
      return { config: parseConfigFile(path, false, paths.homeDir), warnings: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/commands 白名单不得含 hopjit/.test(msg)) {
        throw new Error(`CONFIG_ERROR: ${path} commands 白名单不得含 hopjit——act/commit 步骤不驱动引擎（跑别的 spec 用 [call],不可逆动作走注册工具）`);
      }
      if (/tool_servers/.test(msg)) {
        throw new Error(`CONFIG_ERROR: ${path} tool_servers 节读坏（声明的工具会悄然缺席,拒载好过带病跑）：${msg}`);
      }
      return { config: null, warnings: [`[config] ${path} 读取失败,这份文件按零配置处理（另一级照常生效）：${msg}`] };
    }
  };
  if (paths.projPath === null) {
    const r = readOne(paths.sysPath);
    return { config: r.config ?? { providers: [] }, warnings: r.warnings };
  }
  const sysR = readOne(paths.sysPath);
  const projR = readOne(paths.projPath);
  const merged = sysR.config && projR.config ? mergeConfigs(sysR.config, projR.config) : (sysR.config ?? projR.config ?? { providers: [] });
  const warnings = [...sysR.warnings, ...projR.warnings];
  try {
    validateMergedRefs(merged);
  } catch (err) {
    warnings.push(`[config] 合并后引用核不过,复用模式不消费 providers / routing_rules,忽略：${err instanceof Error ? err.message : String(err)}`);
  }
  return { config: merged, warnings };
}

/** 两级 tool_servers 注册表（接替 tools-registry 的项目级单读 loadProjectToolRegistry）：各条目 _base_dir 已由 parseConfigFile
 * 按声明所在文件目录打好（系统级相对 ~/.hopjit/,项目级相对项目根）;无任何注册返 undefined;坏条目 parseToolServers 响亮抛
 * （TOOLS_FILE_INVALID / TOOLS_NAME_CONFLICT——消费者折 CONFIG_ERROR 或步骤 fail,不静默）。 */ // @a: anc-config-reuse-consume
export function loadToolRegistry(paths: ConfigPaths, projectDir: string): ToolServerEntry[] | undefined {
  const { config } = loadReuseConfig(paths);
  if (!config.tool_servers?.length) return undefined;
  return parseToolServers(structuredClone(config.tool_servers), projectDir);
}

/** 系统语言探测（^anc-i18n-language-config 探测函数,todo/0160 作者定"缺省跟随系统语言,中文就 zh 否则 en"）：
 * LC_ALL → LC_MESSAGES → LANG 取第一个非空（POSIX 优先序）,三个都空用 Intl 的 resolvedOptions().locale 兜底;
 * 以 zh 开头（不分大小写,zh_CN.UTF-8 / zh-Hans / zh_TW 都算）返回 'zh',其余（含 C / POSIX / 空）返回 'en'。
 * 只此一份实现,language 键缺席或复用模式读坏时五个落点都调它,不许各自写死。env 参数留给测试注入。 */ // @a: anc-i18n-language-config
export function detectSystemLanguage(env: Record<string, string | undefined> = process.env): 'en' | 'zh' {
  let locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  if (!locale) {
    try { locale = Intl.DateTimeFormat().resolvedOptions().locale ?? ''; } catch { locale = ''; }
  }
  return /^zh/i.test(locale.trim()) ? 'zh' : 'en';
}

/** language 键 → 生效语言：键是合法值用键值,否则（缺席或复用模式读坏）跟随系统语言。五个落点共用的单一判定（^anc-i18n-language-config）。 */ // @a: anc-i18n-language-config
export function effectiveLanguage(configured: unknown): 'en' | 'zh' {
  return configured === 'zh' || configured === 'en' ? configured : detectSystemLanguage();
}

/** 复用模式消费面（^anc-config-reuse-consume 表）：把合并结果的四样装进 HostConfig——commands → sandbox.runtime.available、
 * language → language 与 hop_env.hop_env_language、env → hop_env 底层（值为绝对路径的同扩 read allowed,与 params 级同款）、
 * resource_limits → resource_limits。cli 与 reuse-driver 两个复用模式组合根共用,"哪个键装哪里"只写一份。 */ // @a: anc-config-reuse-consume
export function applyReuseConfig(hostConfig: HostConfig, config: HopConfig): void {
  hostConfig.sandbox.runtime.available = [...(config.commands ?? [])];
  const lang: 'en' | 'zh' = effectiveLanguage(config.language);   // 缺席/读坏跟随系统语言（todo/0160） // @a: anc-i18n-language-config
  hostConfig.language = lang;
  hostConfig.hop_env = { hop_env_language: lang, ...(config.env ?? {}) };
  for (const v of Object.values(config.env ?? {})) {
    if (isAbsolute(v) && !hostConfig.sandbox.filesystem.read_access.allowed.includes(v)) hostConfig.sandbox.filesystem.read_access.allowed.push(v);
  }
  if (config.resource_limits) hostConfig.resource_limits = { ...(hostConfig.resource_limits ?? {}), ...config.resource_limits } as HostConfig['resource_limits'];
}
