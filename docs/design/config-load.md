%% @trace
	id: hopjit-config-load
	source: [[shared-providers]]
	source_id: hopjit-shared-providers
	type: extract
	last_sync: 2026-10-08T19:21+0800
	note: 两级配置加载模块——从 mcp-server 挪出的 parseConfigFile / mergeConfigs / validateMergedRefs / 类型（todo/0131,作者 2026-09-30 拍形态 1 新建模块）。schema 语义权威仍在 [[shared-providers#^anc-config-standalone-schema]],本文定加载、合并、容错与两种模式的消费面。
%%

# config-load 模块设计规范

> **模块版本**：config-load `v0.1.2`（2026-10-11 todo/0160：新增出口 detectSystemLanguage / effectiveLanguage,消费表 language 行缺省从 en 改为跟随系统语言,applyReuseConfig 与 mcp-server 两路都经它）。上版 v0.1.1（2026-10-08 发版前八项修复批工程链 review 修复：补 HopType 签名块（八出口）、HopConfig / ConfigPaths / ReuseConfigResult 三个 HopSchema、根锚点继承声明;两段 HopSop 去掉引擎步骤类型标;边界句改实（复用模式消费面的装配集中在本模块,cli / reuse-driver 两组合根共用）;`configPaths` 真做成"路径怎么来"的唯一一处（cli adaptConfigPaths / reuse-driver runDepsGate 改调它）;parseConfigFile 对空文件与纯注释文件按零配置、tool_servers 条目须为映射;loadReuseConfig 容错从"整体忽略"改为**分文件容错**（坏的那份回空并点名,好的那份保留）;复用模式工具面（cli 工具工厂 / tool-call / runDepsGate、mcp-server 复用工具工厂）的项目根改按 HostConfig.workspace_dir 取,不再读进程 cwd）。上版 v0.1.0（2026-10-08 todo/0131 新建：复用模式与独立模式共用一份两级配置读取合并实现;复用模式开始吃系统级 `~/.hopjit/config.yaml` 的 commands / language / env / resource_limits / tool_servers——此前复用模式只读项目级三个单键,系统级一个键都不读,`setup --plus` 写进系统级的 websearch / playwright 在复用模式用不上。作者 2026-09-30 定旧口径"复用模式不做配置合并"是 agent 自拟不是作者决定）。0.x 未承诺稳定。**逐版演进史归 git log**。

## 文档结构与内容分级

| 章节 | 分级 | 锚点 |
|------|------|------|
| 定位（边界、出口清单） | 契约 | `anc-struct-config-load` / `anc-struct-config-load-exports` |
| 两级合并规则（逐键表） | 契约 | `anc-config-two-level-merge` |
| 复用模式消费面与容错两档 | 契约 | `anc-config-reuse-consume` |
| 接口签名与数据形状（HopType / HopSchema） | 契约 | `anc-struct-config-load-types` |
| 与独立模式的分工 | 说明 | — |

## 定位【契约】 ^anc-struct-config-load

> **根锚点继承**（`^anc-meta-module-design-artifacts` 必备件①）：
> - 概念前提：[[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-dual-mode]]（双模式驱动——两种模式读同一份两级配置,本模块是"只留一份实现"的落点）;[[../concepts/HopSpec V3核心规范#^anc-config-hop-env]]（hop_env_* 环境参数的概念面——env 键的合并与装入须守它的凭证禁入规则）
> - 元规范义务：[[../concepts/工程实现链规范#^anc-meta-module-design-artifacts]]（四必备件）;[[../concepts/工程实现链规范#^anc-meta-guard-self-trust]]（fail-fast / 禁静默跳过——容错两档里"哪些错必须响亮"的依据）
> - 配置事实权威：[[shared-providers#^anc-config-standalone-schema]]（两级配置文件 schema 的唯一定义处——本文所有键名与形状表述是其投影,冲突以彼为准）
> - 运行隔离：[[../ARCHITECTURE#^anc-run-isolation]]（模块不读进程状态,家目录 / 项目根 / HOPJIT_CONFIG 由组合根算好传入）

**① 自身定位**：config-load 是驱动适配层的一个模块,负责把系统级 `~/.hopjit/config.yaml` 与项目级 `<项目根>/hopjit.yaml` 两份文件读进来、逐文件做文法核、按逐键规则合并成一份 `HopConfig`,再对合并结果做跨节引用核。它是**两种执行模式共用的唯一一份实现**——独立模式（mcp-server）启动期与每 run 重读、复用模式（cli 组合根 `buildHostConfig` / 工具工厂 / `tool-call`）都从这里拿配置。同一套合并规则两份实现是 commands、language 先后漏合并的病根（todo/0084 M2、review F1）,本模块的存在理由就是只留一份。

**边界**：模块只读文件、不读进程状态——家目录与项目根由组合根算好以参数传入（run 隔离不变量 `^anc-run-isolation`,守卫 `check-process-state.mjs`）;不解引用凭证（`api_key_env` 的环境变量读取归 mcp-server 的 `snapshotProviderKeys`）;复用模式消费面的装配**集中在本模块**（`applyReuseConfig`——cli 与 reuse-driver 两个复用模式组合根共用,"哪个键装 HostConfig 哪个字段"只写一份）;独立模式的装配归 mcp-server（startRun 自己从合并结果取键,凭证快照也在那边）。`StandaloneConfig` 改名 `HopConfig`——它不再只属于 standalone;mcp-server 保留 `StandaloneConfig` 为同一类型的别名一版过渡,测试与外部 import 零改。

**② 与其他模块的关系**：
- 读 `service/model` 引用用 [[step-dispatcher]] 的 `parseModelRef`（同层,既有出口）;读 tool_servers 行尾 `#` 说明用 [[tools]] 的 `enrichParamsComments`（同层）;`ROUTING_CATEGORIES` / `credentialLikeHopEnvKey` / `ResourceLimits` 来自 [[shared-providers]]（共享层）;
- [[mcp-server]] 从本模块 import 加载与合并,自身只保留 `resolveStandaloneDefaultModel`（独立模式的缺省模型解析,引用核经回调注入,见出口表）、凭证快照、HostConfig 装配;
- [[hop-cli]] 的 `buildHostConfig` 从本模块取合并结果装 `sandbox.runtime.available` / `language` / `hop_env` 底层 / `resource_limits`;引擎工具工厂与 `tool-call` 取合并后的 `tool_servers`（[[tools]] 的 `loadProjectToolRegistry` 退役,由本模块的 `loadToolRegistry` 接替——两级）。**工具面的项目根取 HostConfig.workspace_dir**（工厂回调拿到的就是本 run 的 HostConfig;`run --workspace WS` 从别的目录起跑时 WS 的 hopjit.yaml 才是项目级文件,[[hop-cli#^anc-cli-workspace-arg]]）,不读进程 cwd——cli 的工具工厂 / `tool-call` / `runDepsGate` 与 mcp-server 的复用工具工厂四处同口径。

**②b 对外接口清单【封闭】** ^anc-struct-config-load-exports

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `HopConfig` / `ProviderEntry` / `ConfigPaths` | 类型 | config-load.ts | 两级配置的 TS 形态（schema 语义权威 [[shared-providers#^anc-config-standalone-schema]]）;mcp-server / cli / 测试 | stable |
| `configPaths` | 函数 | config-load.ts | `configPaths(homeDir, projectDir, explicitPath?)` 算两级路径：`explicitPath`（HOPJIT_CONFIG）在场 → `{sysPath: 它, projPath: null}` 单文件语义;否则 `{sysPath: <home>/.hopjit/config.yaml, projPath: <projectDir>/hopjit.yaml}`。组合根算 home / 工作区根后调它,是"路径怎么来"的唯一一处——cli 的 `reuseConfigPaths` / `adaptConfigPaths`、reuse-driver 的 `runDepsGate`、mcp-server 的 `loadStandaloneConfig` 与复用工具工厂都经它,不再各自拼 `<home>/.hopjit/config.yaml` | stable |
| `parseConfigFile` | 函数 | config-load.ts | `parseConfigFile(path, required, homeDir)` 读一份文件 + 逐文件文法核（`~/` 前缀按传入 homeDir 归一——模块不读进程状态）（原 mcp-server 同名函数原样搬入,行为零变化）;`required=false` 且文件缺席返 `{providers: []}`;**文件在场但空或只有注释也返 `{providers: []}`**（与 tools-registry 的 loadTwoLevelRegistry 同判——`hopjit init` 生成的模板文件全是注释行,是常见形态）;tool_servers 须是数组且各项须是映射（null / 标量条目抛 STANDALONE_CONFIG_INVALID 点名下标）,各项打 `_base_dir`=该文件所在目录 | stable |
| `mergeConfigs` | 函数 | config-load.ts | `mergeConfigs(sys, proj)` 逐键合并,规则见 ^anc-config-two-level-merge（原 mcp-server 同名函数原样搬入） | stable |
| `validateMergedRefs` | 函数 | config-load.ts | `validateMergedRefs(config, resolveDefault?)` 合并后跨节引用核：routing_rules 引用的 service 须在合并后 providers 内;`resolveDefault` 是 default_model 引用核回调（mcp-server 传 `resolveStandaloneDefaultModel`,复用模式不传——复用模式不用 providers） | stable |
| `loadHopConfig` | 函数 | config-load.ts | `loadHopConfig(paths, opts)` 两级加载主入口（HopSop 见下）。`paths` 来自 `configPaths`;`opts.requireProviders`（独立模式 true：合并后 providers 空即 STANDALONE_CONFIG_MISSING_PROVIDERS;复用模式 false）;`opts.resolveDefault` 透传给 validateMergedRefs。两级全缺席：独立模式抛 STANDALONE_CONFIG_MISSING,复用模式返空配置 `{providers: []}` | stable |
| `loadReuseConfig` | 函数 | config-load.ts | `loadReuseConfig(paths)` 复用模式容错包装（^anc-config-reuse-consume）：**分文件**读两级（每份各自 parseConfigFile）,坏的那份按零配置并记一条 warning 点名文件与原因,好的那份保留,再合并;commands 含 hopjit 与 tool_servers 节文法错两类响亮抛 CONFIG_ERROR;返回 `ReuseConfigResult {config, warnings}` | stable |
| `applyReuseConfig` | 函数 | config-load.ts | `applyReuseConfig(hostConfig, config)` 复用模式消费面：把 commands / language / env / resource_limits 四样装进 HostConfig（^anc-config-reuse-consume 表）;cli 与 reuse-driver 两个复用模式组合根共用 | stable |
| `detectSystemLanguage` | 函数 | config-load.ts | `detectSystemLanguage(env?)` 系统语言探测（[[i18n#^anc-i18n-language-config]] 探测函数 HopSop）：LC_ALL → LC_MESSAGES → LANG → Intl 兜底,zh 前缀判 'zh' 其余 'en';env 参数缺省 process.env,留给测试注入 | stable |
| `effectiveLanguage` | 函数 | config-load.ts | `effectiveLanguage(configured)` language 键 → 生效语言：合法值（en / zh）用键值,缺席或坏值调 detectSystemLanguage;applyReuseConfig 与 mcp-server startRun / restoreRun 共用的单一判定 | stable |
| `loadToolRegistry` | 函数 | config-load.ts | `loadToolRegistry(paths, projectDir)` 两级 tool_servers 注册表：`loadReuseConfig` 后 `parseToolServers(config.tool_servers, projectDir)`（各项 `_base_dir` 已由 parseConfigFile 打好——系统级条目相对 `~/.hopjit/`,项目级相对项目根）;无任何注册返 `undefined`。接替 tools 的 `loadProjectToolRegistry`（项目级单读）——消费者 cli 工具工厂与 `tool-call`,以及 mcp-server 给复用模式 run 装的工具工厂（独立模式 startRun 不经它——经 loadHopConfig 直接拿 tool_servers） | stable |

## 两级合并规则（逐键表）【契约】 ^anc-config-two-level-merge

两份文件同一 schema,全部键可选。合并方向恒"项目级赢"——项目只写差异。逐键：

| 键 | 规则 | 为什么 |
|---|---|---|
| `providers` | 按 `service_id`（大写比）合并,同名项目级整条替换 | 项目可加私有后端或覆盖同名;复用模式不消费本键但合并照做（函数只有一份） |
| `routing_rules` | 按 `step_type` 合并,同类别项目级整条替换 | 同上 |
| `default_model` / `notify` / `log_level` / `log_retention` / `language` / `revision_prompt` | 单值键,项目级在场即赢 | 单值无"并"的语义 |
| `env` | 逐键合并,同键项目级赢 | hop_env_* 是一张表,项目补几项不该把系统级整表顶掉 |
| `resource_limits` | 逐键合并,同键项目级赢 | 同 env |
| `commands` | 两级并集去重 | 白名单是"允许哪些",系统级允许的项目级没理由收回（要收回改系统级） |
| `tool_servers` | 按 `name` 合并,同名项目级整条替换;条目相对路径基准=声明所在文件目录（parseConfigFile 打的 `_base_dir`） | 系统级注册的 websearch / playwright 项目级天然可见——本卡要治的病 |
| `owner_id` | 不合并,只在系统级有意义 | 本机归属标识 |

HOPJIT_CONFIG 指向单文件时只用它、不合并（`configPaths` 的 projPath 为 null）——独立模式既有语义,复用模式同。

```
# impl loadHopConfig(paths, opts)
1. 按 paths.projPath 分派
  1.1. [条件(projPath == null)] 单文件：parseConfigFile(sysPath, required=true) → 若 opts.requireProviders 核 providers 非空 → validateMergedRefs → 返回
  1.2. [其他] 两级 → 2
2. sys = 文件在场 ? parseConfigFile(sysPath, true) : null;proj = 文件在场 ? parseConfigFile(projPath, false) : null
   > 逐文件文法核在 parseConfigFile 内（各节形状 / step_type 枚举 / 明文 api_key 拒 / hop_env_ 前缀与凭证形态键拒 / tool_servers 条目须为映射 / ~ 归一;空文件与纯注释文件按零配置）;单文件自含的错当场拒
3. 两级全缺席
  3.1. [条件(sys == null 且 proj == null 且 opts.requireProviders)] 抛 STANDALONE_CONFIG_MISSING
  3.2. [条件(sys == null 且 proj == null)] 返回 {providers: []}
   > 复用模式零配置是合法状态（内置工具面 + 空白名单 + en）
4. merged = 只有一份 ? 那一份 : mergeConfigs(sys, proj)
5. [条件(opts.requireProviders 且 merged.providers 为空)] 抛 STANDALONE_CONFIG_MISSING_PROVIDERS
6. validateMergedRefs(merged, opts.resolveDefault) → 返回 merged
   > 引用核只能对合并后 providers 做（BUG-E 2026-08-13：项目级合法形态就是没有 providers）
```

## 复用模式消费面与容错两档【契约】 ^anc-config-reuse-consume

复用模式的两个组合根（cli.ts 的 `buildHostConfig`、reuse-driver 的 `driverRun`）都经本模块的 `applyReuseConfig` 把合并结果的四样装进 HostConfig,取法与独立模式 startRun 一致：

| 配置键 | 装进 | 说明 |
|---|---|---|
| `commands` | `sandbox.runtime.available` | subprocess.run 白名单（[[act-body#^anc-exec-subprocess-run]]）;`hopjit` 恒拒在 parseConfigFile 内 |
| `language` | `language` 与 `hop_env.hop_env_language` | 生成物语言（[[i18n#^anc-i18n-language-config]]）;键缺席或读坏时跟随系统语言（`detectSystemLanguage`,2026-10-11 todo/0160——原"缺省 en"撤） |
| `env` | `hop_env` 底层 | hop_env_* 环境参数;params 显式传的同名键按覆盖链后到覆盖（[[shared-providers#^anc-config-hop-env]]）;值为绝对路径的同扩 read allowed（与 params 级同款） |
| `resource_limits` | `resource_limits` | 此前复用模式只能拿代码缺省;cli init/run 读 max_call_depth、引擎读 max_concurrent_workers 等消费点既有 |
| `tool_servers` | 引擎工具工厂 / `tool-call` 的 `tool_registry` | 经 `loadToolRegistry`;装配期现读语义不变（[[exec-engine]] 工具注册件装配条款②） |

不消费：`providers` / `routing_rules` / `default_model`（推理 LLM 就是 caller 自己）、`revision_prompt`（只 standalone 实装）、`notify`（复用模式通知随话语走 `--notify`,[[hop-cli#^anc-cli-notify-reuse]]）、`log_level` / `log_retention`（复用模式 hoplog 由 caller 侧既有通道定）。

**容错两档,按文件分别判**（分档沿用 2026-09-11 review 勘正;2026-10-08 review 修复从"任一坏则整体忽略"改为分文件——实撞：项目级 hopjit.yaml 是 `hopjit init` 生成的纯注释模板,原实现把它当坏文件,连系统级 `~/.hopjit/config.yaml` 的 language: zh 与 commands 一起丢掉,复用模式退成零配置而用户只看到一行 warning）：

```
# impl loadReuseConfig(paths)
1. [条件(paths.projPath == null)] 单文件：r = readOne(paths.sysPath) → 返回 {config: r.config ?? {providers: []}, warnings: r.warnings}
2. sysR = readOne(paths.sysPath);projR = readOne(paths.projPath)
   > readOne 是本函数内的分文件读法,分支见 3
3. readOne(path) 对一份文件的分支
  3.1. [条件(文件缺席)] {config: null, warnings: []}
  3.2. [条件(parseConfigFile(path, false, homeDir) 成功)] {config: 结果, warnings: []}
  3.3. [条件(抛错 且 报文含 "commands 白名单不得含 hopjit")] 抛 CONFIG_ERROR（报文点名文件）
     > hopjit 恒拒是明确的越层配置,静默剔除会让作者误以为生效
  3.4. [条件(抛错 且 报文含 "tool_servers")] 抛 CONFIG_ERROR（报文点名文件）
     > 工具注册错配静默回空会让声明的工具悄然缺席,拒载好过带病跑;parseConfigFile 对 tool_servers 只核"是数组、各项是映射",条目内部文法归 parseToolServers（loadToolRegistry 阶段才跑,同样响亮抛）
  3.5. [其他（坏 YAML / 顶层非映射 / commands、language、env、resource_limits 形状不符 / providers 节文法错）] {config: null, warnings: ["[config] <path> 读取失败,这份文件按零配置处理（另一级照常生效）：<原因>"]}
     > 能力关死是安全侧;warn 经 stderr 一行让人看见,不炸 CLI
4. merged = 两份都有 ? mergeConfigs(sysR.config, projR.config) : 有的那份 : 都没有则 {providers: []}
5. validateMergedRefs(merged)（复用模式不传 resolveDefault）;抛错按 3.5 同款降级为一条 warning（routing_rules 引用错在复用模式不消费,不值得炸）
6. 返回 {config: merged, warnings: sysR.warnings ++ projR.warnings ++ 第 5 步的 warning}
```

两档的判据只有一条：**错的是会让声明的能力悄然缺席、或让越层配置看似生效的,响亮抛;错的是让能力关得更死的,降级带 warning。** 分文件的意义是 warning 能点名哪份文件坏了,而且一份坏不连累另一份。

## 接口签名与数据形状【契约】 ^anc-struct-config-load-types

```
HopType: ConfigLoader
  # 两级配置加载模块 src/config-load.ts 的能力面:八个出口函数,没有自持状态（Fields 空）——每次调用都现读文件,不缓存
  # 约束:不读 process.cwd() / process.env / os.homedir()——homeDir / projectDir / explicitPath 全由组合根传入（^anc-run-isolation）
  # 约束:抛错报文以大写码开头（STANDALONE_CONFIG_MISSING / STANDALONE_CONFIG_MISSING_PROVIDERS / STANDALONE_CONFIG_INVALID / CONFIG_ERROR）,码表归 [[shared-errors]]
  Specs:
    configPaths(
      homeDir % line,        # 用户主目录绝对路径
      projectDir % line,     # 项目根（复用模式=HostConfig.workspace_dir;独立模式=run 的 projectDir）
      explicitPath % line    # HOPJIT_CONFIG 的值,可空——在场即单文件语义
    ) -> paths % ConfigPaths

    parseConfigFile(
      path % line,           # 一份配置文件的绝对路径
      required % bool,       # true=文件缺席抛 STANDALONE_CONFIG_MISSING;false=缺席返 {providers: []}
      homeDir % line         # `~/` 前缀归一的基准
    ) -> config % HopConfig  # 逐文件文法核过的一份;空文件 / 纯注释文件返 {providers: []};tool_servers 各项已打 _base_dir

    mergeConfigs(
      sys % HopConfig,       # 系统级
      proj % HopConfig       # 项目级
    ) -> merged % HopConfig  # 逐键规则见「两级合并规则」节（anc-config-two-level-merge）

    validateMergedRefs(
      config % HopConfig,            # 合并后的一份
      resolveDefault % yaml          # 可空;default_model 引用核回调（独立模式传 resolveStandaloneDefaultModel）
    ) -> none % bool                 # 过核返回,不过抛 STANDALONE_CONFIG_INVALID

    loadHopConfig(
      paths % ConfigPaths,
      opts % yaml            # {requireProviders % bool, resolveDefault % yaml 可空}
    ) -> merged % HopConfig  # HopSop 见「两级合并规则」节（anc-config-two-level-merge）

    loadReuseConfig(
      paths % ConfigPaths
    ) -> result % ReuseConfigResult  # HopSop 见「复用模式消费面与容错两档」节（anc-config-reuse-consume）

    loadToolRegistry(
      paths % ConfigPaths,
      projectDir % line      # 项目级条目 module 相对路径的解析基准=工作区根
    ) -> registry % yaml     # ToolServerEntry[]（[[tool-interface#^anc-config-tool-registry]]）;无任何注册返 undefined;坏条目响亮抛

    applyReuseConfig(
      hostConfig % yaml,     # 本 run 的 HostConfig,就地改四个字段
      config % HopConfig
    ) -> none % bool         # 装入表见「复用模式消费面与容错两档」节（anc-config-reuse-consume）
```

```
HopSchema: ConfigPaths
  # 两级配置文件的位置,组合根经 configPaths 求得后一路传下去
    - sysPath % line        # 系统级文件绝对路径;HOPJIT_CONFIG 在场时就是它
    - projPath % line       # 项目级文件绝对路径;HOPJIT_CONFIG 在场时为 null（单文件语义,不合并）
    - homeDir % line        # 用户主目录,parseConfigFile 的 ~ 归一基准
```

```
HopSchema: HopConfig
  # 一份（或合并后的一份）配置的 TS 形态;键的语义与文法权威是 [[shared-providers#^anc-config-standalone-schema]],这里只列字段与值形态
    - providers % yaml          # ProviderEntry[]——LLM 后端;复用模式不消费但合并照做
    - default_model % line      # 可空;"service/model" 引用
    - routing_rules % yaml      # 可空;[{step_type, model, thinking?}]
    - env % yaml                # 可空;hop_env_* 键 → 字符串值
    - language % line           # 可空;en | zh
    - owner_id % line           # 可空;本机归属标识,只在系统级有意义
    - revision_prompt % line    # 可空;standard | short
    - tool_servers % yaml       # 可空;注册条目数组,各项是映射且加载器打了 _base_dir
    - resource_limits % yaml    # 可空;ResourceLimits 的子集
    - commands % list           # 可空;subprocess.run 白名单
    - notify % yaml             # 可空;通知渠道配置
    - log_level % line          # 可空;debug | info | warn
    - log_retention % yaml      # 可空
```

```
HopSchema: ReuseConfigResult
  # loadReuseConfig 的返回:合并结果 + 降级说明
    - config % HopConfig        # 合并后的配置;两级都坏或都缺席时是 {providers: []}
    - warnings % list           # 每份被按零配置处理的文件一条,点名文件与原因;组合根经 stderr 逐行输出
```

## 与独立模式的分工【说明】

独立模式的 `loadStandaloneConfig(configPath?, projectDir?)` 保留在 mcp-server 作薄包装：算路径（`configPaths(homedir(), projectDir ?? cwd, configPath)`）→ `loadHopConfig(paths, {requireProviders: true, resolveDefault: resolveStandaloneDefaultModel})`;每 run 重读 `reloadProjectConfig` 照旧调本模块的 `parseConfigFile` + `mergeConfigs` + `validateMergedRefs`。独立模式行为零变化——搬家探针（先只搬不改跑全量）是本批第一步。

## 测试面

专属 `tests/config-load.test.ts`（假 HOME + 临时项目目录,不碰开发者真实 `~/.hopjit`）：只系统级在场各键生效 / 项目级覆盖单值键 / env、resource_limits 逐键合并 / commands 并集去重 / tool_servers 同名替换 + 系统级条目 `_base_dir` 为 `~/.hopjit` / HOPJIT_CONFIG 单文件不合并 / 两级全缺席复用模式返空、独立模式抛 / 容错两档按文件（项目级纯注释模板 + 系统级 zh/[git] → zh 与 [git] 仍生效且零 warning;系统级坏 YAML + 项目级好 → 项目级保留、warning 点名系统级文件;commands 含 hopjit 抛;tool_servers 条目为 null 抛 STANDALONE_CONFIG_INVALID 点名下标;tool_servers 坏条目经 loadToolRegistry 抛）。`tests/cli.test.ts` 组 `复用模式两级配置合并`：卡 probe 1–4 测试化（系统级 in-process 工具 `tool-call` 能调 / commands 并集进 `sandbox.runtime.available` / language 系统级 zh 项目不写 → zh、项目 en → en / env 系统级 hop_env_x 进 hop_env 且 params 覆盖）;`run --workspace WS` 从别的 cwd 起跑,WS 的 hopjit.yaml 注册的 in-process 工具在 act 步骤可见（工具面按工作区根读）。`tests/mcp-server.test.ts` 复用驱动组：假 HOME 写 config.yaml（commands / language）,经 `run` 驱动工具起跑后 state.json 的 host_context 带 available 与 hop_env_language。
