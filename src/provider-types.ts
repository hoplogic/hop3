// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: shared-providers ^anc-struct-shared-providers — 宿主契约：Provider 三件套 + HostConfig/Sandbox/ResourceLimits/ModelEngine。
// 拆自原 types.ts（见 design/spec-ast.md ^anc-struct-spec-ast 拆分表）。Provider 接口定位见 shared-types.md。

import type { SpecAST } from './ast-types.js';
import type { EngineSnapshot } from './runtime-types.js';

/** PersistenceProvider：引擎状态快照存取接口——引擎经此持久化/恢复执行状态，支撑复用/独立双模式驱动。
 * 见 [[shared-providers#^anc-provider-persistence-iface]]。 // @a: anc-provider-persistence-iface */
export interface PersistenceProvider { // @a: anc-provider-persistence
  init(instanceId: string, spec: SpecAST): void;
  saveSnapshot(snapshot: EngineSnapshot): void;
  loadSnapshot(): EngineSnapshot;
  exists(): boolean;
  // work_zone 工作区绝对路径(driver @file 临时文件 + deflate $file 指针存放)。
  // FilePersistence 返回 <instanceDir>/work_zone;MemoryPersistence 返回空串(独立模式不暴露给外部 driver)。
  // 见 design/exec-engine.md ^anc-exec-work-zone。// @a: anc-exec-work-zone
  getWorkZone(): string;
}

/** 内置文件工具写域（2026-08-28 作者定分域,权威 [[tools/file-tools#^anc-exec-builtin-file-tools]]）：
 * 'work_zone'=act/check 语境（探索段中间产物区）；'workspace'=commit 语境（交付写盘全域）。
 * 仅 DefaultToolProvider 写侧六件消费；外部工具（MCP/in-process）不接收此信号——其资源
 * 边界由 requires_commit 与自身实现管。// @a: anc-exec-write-scope */
export type WriteScope = 'work_zone' | 'workspace';

/** ToolProvider：工具能力接口——引擎经此调用宿主注入的工具（execute 执行、list 列举）。
 * write_scope 可选第三参=调用方步骤语境的写域声明（缺省按窄域 work_zone 处理——信号缺席
 * 不静默放宽,见 ^anc-exec-write-scope）；非文件写工具实现自然忽略。见 [[shared-providers#^anc-provider-tool]] */
export interface ToolProvider { // @a: anc-provider-tool
  execute(tool_name: string, tool_args: Record<string, unknown>, write_scope?: WriteScope): Promise<ToolResult>;
  list(): ToolDef[];
}

/** ToolResult：工具执行结果——承载返回值、内容类型（text/json）与成功标志。见 [[shared-providers#^anc-provider-tool]] */
export interface ToolResult {
  result: string | Record<string, unknown>;
  content_type?: 'text' | 'json';
  success: boolean;
  // 审计元信息（外部工具归属与延迟——装配层填,tool: 审计块消费;内置工具缺省缺席）
  // discarded_text_blocks:多 text 块取首块时的丢弃计数（0006 留痕——declared-or-flagged,
  // 审计读出"server 发了 N+1 块引擎取了首块"）。见 spec-observability ^anc-obs-audit。// @a: anc-obs-audit
  audit?: { server?: string; duration_ms?: number; discarded_text_blocks?: number };
}

/** ToolDef：工具定义——声明名称、描述、input_schema 及 requires_commit 副作用级别（用于 act 步骤拦截）。见 [[shared-providers#^anc-provider-tool]] */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  requires_commit: boolean; // @a: anc-exec-requires-commit
  // 工具分档（0054 ^anc-step-tool-grant）:basic=零声明恒可用(文件读写族);special=须节点
  // `- 工具:` 声明才对无 body 的 act 可用。缺省 special——收紧安全默认,新件不标即须授权。
  category?: 'basic' | 'special';
  // 返回值形状一句话人读描述（L4 清单"返回:"行料源——内置件逐件如实写;外挂件不用此字段,
  // 形状归注册面 output_schema。^anc-exec-tool-manifest-supply）
  returns?: string;
}

/** 唯一语义源族名单——复用模式 L4 通道指引档按它分道:名单内恒教 hopjit tool-call
 * （HopSpec 的树编辑与校验语义只活在引擎实现里,caller 用自己的工具模仿=语义漂移）,
 * 名单外教 caller 原生能力优先（^anc-exec-tool-manifest-source 第 4 条）。住共享层供
 * prompt(层1) 消费（tools.ts 在层2,层1 不得反向 import）。
 * 分族判据是"引擎实现是不是这件事的唯一语义源",不是"是不是内建件"——2026-09-22 随
 * run_script 落地收窄:它是内建件却该走原生优先（跑 .py 不是 HopSpec 专有语义）。 */
// @a: anc-exec-tool-manifest-source
export const ENGINE_BUILTIN_SPECIAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'validate_spec', 'insert_node', 'replace_node', 'replace_children', 'renumber_steps', 'read_spec_tree',
]);

/** 原生优先族里的**内建**成员名单——语义通用、caller 自己的等价能力跑出来结果一样的内建件。
 * 现只 run_script 一员:caller 的 Bash 跑 `python3 <脚本>` 与引擎跑它等价,且教 tool-call 为主
 * 会把 caller 指向一条依赖它那侧 hopjit.yaml commands 白名单（复用模式多半没配）的路。
 * 渲染上本名单不参与判定（buildToolManifest 的 else 分支本就兜住非唯一语义源件）——它存在
 * 是为了守卫的牙:同源钉判"两族并集 == 注册面 special 全集",新增 special 内建件不登记任一族
 * 即红,迫使加件的人显式做一次分族判断（单名单+隐式兜底会让新件静默全绿,分道被替他做了）。 */
// @a: anc-exec-tool-manifest-source
export const NATIVE_FIRST_BUILTIN_SPECIAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'run_script',
]);

/** KnowledgeProvider：知识检索接口——引擎经此按 query 检索宿主知识片段供 prompt 注入。见 [[shared-providers#^anc-provider-knowledge]] */
export interface KnowledgeProvider { // @a: anc-provider-knowledge
  retrieve(query: string, max_results: number): Promise<KnowledgeFragment[]>;
}

/** KnowledgeFragment：知识片段——检索返回的单条结果，含来源 id、内容与相关度。见 [[shared-providers#^anc-provider-knowledge]] */
export interface KnowledgeFragment {
  source_id: string;
  content: string;
  relevance: 'high' | 'medium' | 'low';
}

/** IdentityProvider：身份凭证接口——为外部服务调用提供凭证（get_credential/list_services），v1 仅定义形状未实装。见 [[shared-providers#^anc-provider-identity]] */
export interface IdentityProvider { // @a: anc-provider-identity
  get_credential(service_id: string): Promise<Credential | null>;
  list_services(): ServiceEntry[];
}

/** Credential：外部服务凭证——含类型（api_key/ak_sk/bearer_token/oauth）与键值对。见 [[shared-providers#^anc-provider-identity]] */
export interface Credential {
  type: 'api_key' | 'ak_sk' | 'bearer_token' | 'oauth';
  values: Record<string, string>;
}

/** ServiceEntry：可用服务条目——list_services 返回的单项，含 service_id 与描述。见 [[shared-providers#^anc-provider-identity]] */
export interface ServiceEntry {
  service_id: string;
  description: string;
}

// SpecProvider：为 call 步骤解析被调子 spec（callee_spec_id → spec 源）。// @a: anc-provider-spec
// 独立模式 call 递归的前置件（dispatcher executeCall 消费,null → UNKNOWN_SPEC fail）；
// 复用模式不依赖（CC 自行解析 callee）。缺省实现 DirSpecProvider（调用方 spec 同目录寻址）
// 在 dispatcher.ts。寻址逻辑（版本/来源/消歧）归宿主，引擎不硬编码。见 design/shared-providers.md ^anc-provider-spec
export interface SpecProvider {
  resolve(spec_id: string): Promise<SpecSource | null>;
  list?(): SpecEntry[];
}

/** SpecSource：被调子 spec 源——resolve 返回的 HopSpec markdown 全文及可选版本（引擎只透传/审计）。见 [[shared-providers#^anc-provider-spec]] */
export interface SpecSource {
  spec_id: string;
  source: string;        // HopSpec markdown 全文
  version?: string;      // 可选版本；引擎只透传/审计，不内置版本解析
}

/** SpecEntry：可用 spec 条目——可选 list() 返回的单项，含 spec_id 与描述。见 [[shared-providers#^anc-provider-spec]] */
export interface SpecEntry {
  spec_id: string;
  description: string;
}

/** ModelEngine：多模型路由配置——由 IdentityLayer 持有，定义默认服务/模型及按步骤类型的路由规则。见 [[shared-providers#^anc-config-model-engine]] */
export interface ModelEngine { // @a: anc-config-model-engine
  default_service_id: string;
  default_model: string;
  routing_rules?: ModelRoute[];
}

/** RoutingCategory：模型路由类别——可执行步骤类别 ∪ 'replan' 元编程档（act/commit/reason/check/replan）。
 * confirm/ask 是介入点无 LLM、call 是引擎递归,均不路由。类型与 StandaloneConfig 加载闸同源（0008①——
 * 原 ModelRoute.step_type 声明 ExecutableStepType:太窄〔replan 不在,消费点 as 强转〕又太宽〔confirm/ask/call
 * 类型合法但永不匹配〕）。宿主直注由本类型编译期约束,JS 绕过类型面时责任在宿主。
 * 见 [[shared-providers#^anc-config-model-engine]] // @a: anc-exec-model-routing */
export const ROUTING_CATEGORIES = ['act', 'commit', 'reason', 'check', 'replan'] as const;

/** 引擎缺省模型——单一事实源（0086 续账修:原 dispatcher 路由兜底与 install-skill CC 缺省两处
 * 各写死字面量,引擎升缺省时 install 侧静默旧值;设计口径'缺省引擎缺省模型'要求同源）。 */
export const ENGINE_DEFAULT_MODEL = 'claude-sonnet-4-6';
/** RoutingCategory：模型路由类别字面量联合（自 ROUTING_CATEGORIES 推导——类型与运行期闸同源单点）。 */
export type RoutingCategory = typeof ROUTING_CATEGORIES[number];

/** ModelRoute：单条模型路由规则——按路由类别匹配到目标 service_id 与 model。见 [[shared-providers#^anc-config-model-engine]] */
export interface ModelRoute {
  match: { step_type?: RoutingCategory };
  service_id: string;
  model: string;
  // thinking 路由（2026-08-20 作者拍板形态 B——与模型分档同维度的第二旋钮:推理型端点缺省开
  // thinking,机械含量高的步骤边际价值远低于烧掉的预算与延迟〔flash 重档 90% 输出是 thinking,
  // 三轮 OUTPUT_TRUNCATED 第一凶手〕）。缺省 undefined=落五级链下级（provider 缺省/引擎内建步骤类型缺省——0100 批后思考恒显式,见 ^anc-exec-thinking-routing）。
  // @a: anc-exec-thinking-routing
  thinking?: 'enabled' | 'disabled';
}

/** HostConfig：宿主环境配置——实例化时由宿主注入，贯穿执行生命周期，聚合 workspace/sandbox/三件套 Provider/模型与资源上限。见 [[shared-providers#^anc-config-host]] */
export interface HostConfig { // @a: anc-config-host
  workspace_dir: string;
  sandbox: SandboxConfig;
  // run 启动时的项目根（组合根一次读取的 cwd）——随 host_context 入快照,server 重启恢复时
  // 以它为 projectDir 重读项目级配置（BUG-I:重启后 cwd 漂移致 hopjit.yaml 读不到,工具面装空）。
  // 见 [[exec-engine#^anc-exec-host-context-persist]]。// @a: anc-mcp-run-restore
  config_project_dir?: string;
  tool_provider?: ToolProvider;
  knowledge_provider?: KnowledgeProvider;
  identity_provider?: IdentityProvider;
  spec_provider?: SpecProvider;   // call 子 spec 解析（独立模式 call 递归消费；缺省实现 DirSpecProvider 见 dispatcher）
  // LLM wire 协议（缺省 anthropic——复用模式与存量注入零变化；standalone 由 provider 条目带入）。
  // 见 [[step-dispatcher#^anc-exec-protocol-adapter]]。// @a: anc-exec-protocol-adapter
  protocol?: 'anthropic' | 'openai-chat' | 'openai-responses';
  // 鉴权头档（^anc-config-standalone-schema auth 字段——standalone 由 provider 条目带入,
  // defaultClient 构造按此分双臂;缺省 api-key 与既有逐字节同。2026-09-18 review 抓缺省
  // provider 路径漏装:原只有显式 service 路由消费 {SID}_AUTH,唯一 provider 配 bearer 不写
  // 路由时 defaultClient 硬编码 x-api-key 恰撞回该档要治的 InvalidApiKey）。// @a: anc-config-standalone-schema
  auth?: 'api-key' | 'bearer';
  // 外部工具注册条目（配置 tool_servers 节加载产物）——CompositeToolProvider 装配消费。
  // 类型在 tools-registry.ts（避免共享层反向依赖 tools 层,此处用结构化弱类型）。
  // 见 [[tool-interface#^anc-config-tool-registry]]。// @a: anc-config-tool-registry
  tool_registry?: unknown[];
  api_key: string;
  base_url?: string;
  model?: string;
  // run 隔离不变量（ARCHITECTURE ^anc-run-isolation）：组合根构造时冻结的进程环境快照——
  // 内核运行期只查快照禁直读 process.env（外部/它 run 改 env 不影响在飞 run）。
  // 缺省未提供时内核回退直读（存量兼容）。// @a: anc-run-isolation
  env_snapshot?: Record<string, string | undefined>;
  // spec 环境参数表（hop_env_* 命名空间,概念 ^anc-config-hop-env——组合根按覆盖链合成:
  // 配置两级→params 覆盖;ask 回填运行时并入。doc-ref 展开/body 只读注入/prompt 值表三消费面。
  // 与 env_snapshot 分立:那是进程环境快照〔含凭证不落盘〕,这是 spec 环境参数〔非密可落盘〕）
  // @a: anc-config-hop-env
  hop_env?: Record<string, string>;
  // 生成物语言（项目级 hopjit.yaml language 键,zh|en 缺省 en——序列化/树编辑工具/hopbuild2
  // 生成面消费;AST 恒英文规范形不受影响。^anc-i18n-language-config）// @a: anc-i18n-serialize-lang
  language?: 'en' | 'zh';
  model_engine?: ModelEngine;
  resource_limits?: ResourceLimits;
}

/** SandboxConfig：沙箱配置——定义 act 步骤能安全触及的资源边界（文件/网络/运行时/数据库四类）。见 [[shared-providers#^anc-config-sandbox]] */
export interface SandboxConfig { // @a: anc-config-sandbox, anc-config-sandbox-model
  filesystem: FilesystemSandbox;
  network: NetworkSandbox;
  runtime: RuntimeSandbox;
  database?: DatabaseSandbox;
}

/** FilesystemSandbox：文件系统沙箱——声明工作区根目录与读取访问控制（allowed/denied/confirm_required）。见 [[shared-providers#^anc-config-sandbox]] */
export interface FilesystemSandbox { // @a: anc-config-sandbox-filesystem
  workspace_dir: string;
  read_access: {
    allowed: string[];
    denied: string[];
    confirm_required: string[];
  };
}

/** NetworkSandbox：网络沙箱——声明可信域名白名单，约束 act 步骤可访问的网络主机。见 [[shared-providers#^anc-config-sandbox]] */
export interface NetworkSandbox { // @a: anc-config-sandbox-network
  trusted_hosts: string[];
}

/** RuntimeSandbox：运行时沙箱——声明可用运行时白名单（如 python/node/uv/pdf/ocr）。见 [[shared-providers#^anc-config-sandbox]] */
export interface RuntimeSandbox { // @a: anc-config-sandbox-runtime
  available: string[];
}

/** DatabaseSandbox：数据库沙箱——区分临时库（act 可读写、可重建）与只读库（act 只查、写需 commit）。见 [[shared-providers#^anc-config-sandbox]] */
export interface DatabaseSandbox { // @a: anc-config-sandbox-database
  temp_databases: string[];
  readonly_databases?: string[];
}

/** ResourceLimits：资源上限——定义单步执行的 token 预算、工具调用上限、replan/并发/超时等约束。见 [[shared-providers#^anc-config-resource-limits]] */
export interface ResourceLimits { // @a: anc-config-resource-limits
  max_tool_iterations: number;
  max_context_tokens: number;         // PromptAssembler 上下文预算；兼作工具循环上下文预检线（×0.8，anc-exec-toolloop-ctx-degrade）
  max_output_tokens: number;
  max_replan_attempts: number;
  max_concurrent_workers?: number;     // parallel 真并行 worker 数上限,默认 5。引擎透传给 driver,排队由 driver 实现
  max_concurrent_runs?: number;        // MCP server 级并发 run 上限,默认 4——防失控烧费的保守缺省,批量场景显式调大=知情授权（todo/0084 M1:原为源码裸常量配置化;server 级判定读启动期合并后配置,不入每 run 重读面） // @a: anc-mcp-config
  max_call_depth?: number;             // call 嵌套深度上限,默认 10。超限 DEPTH_EXCEEDED 不建子实例。见 [[exec-engine#^anc-exec-call-depth-check]] // @a: anc-exec-call-depth-check
  timeout_seconds?: number;
  // 单活超时（P1 §U3）：parallel 在飞子实例的活性上限（秒）。缺省不超时——显式配置才生效
  //（"paused 永久有效"哲学共存：超时管 running 卡死，不管等人）。// @a: anc-exec-parallel-timeout
  parallel_child_timeout_seconds?: number;
}

// hop_env 凭证形态键名闸（0004——覆盖链三级〔配置 env 节/params/ask 回填〕同判共用;
// 尾锚定非"含":hop_env_keyring_path 类键"含"判误杀,凭证键名习惯是后缀位。见
// [[shared-providers#^anc-config-standalone-schema]] env 条款）。// @a: anc-config-hop-env
export function credentialLikeHopEnvKey(key: string): boolean {
  return /_(key|token|secret|password)$/i.test(key);
}

/** 三级共用的拒收报文（响亮+指路 api_key_env——各级来源语境不同,消息体一致）。 */
export function hopEnvCredentialError(key: string, source: '配置 env 节' | 'params' | 'ask 回填'): string {
  return `HOP_ENV_CREDENTIAL_REJECTED: ${source}键 '${key}' 形似凭证——hop_env_* 会落盘入日志,凭证只许走 providers[].api_key_env（环境变量名引用,值不落盘）`;
}
