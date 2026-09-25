%% @trace
	id: hopjit-opencode-driver-carrier
	source: [[../concepts/HopSpec V3配套HopJIT运行时能力]]
	source_id: hopjit-runtime
	type: extend
	last_sync: 2026-09-19T15:20+0800
	note: opencode 载体驱动设计（2026-09-19 作者抓"完全不考虑 agent 适配的架构设计?"+"opencode 完全复用 cc 的?"后立——0089 批只做了安装路径与配置面适配,driver 内容层逐字节搭 CC 车零验证;本批立 driver/opencode/ 目录+原语适配+真机 E2E）。结构参照 [[codex-driver-carrier]] 但大幅精简：opencode 与 CC 的同构度远高于 Codex（skill 发现机制同构+question 工具+subagent 机制原生在场）,适配是原语映射级不是角色重拆级。
%%

# OpenCode Driver Carrier 设计

> **模块版本**：opencode-driver-carrier `v0.1.0`（2026-09-19）。首版：三层复用判据+原语映射表七行+安装布局+载体准入两档。0.x 未承诺稳定。**逐版演进史归 git log**（本行只记现行版本,升版只改号）。

## 文档结构与内容分级

| 节 | 分级 | 锚点 |
|---|---|---|
| 定位与复用判据 | 决策：依赖驱动 | `anc-driver-opencode-carrier` |
| 原语映射表 | 契约 | `anc-driver-opencode-primitive-map` |
| 安装布局 | 契约 | `anc-driver-opencode-install-layout` |
| 载体准入规则 | 契约 | `anc-driver-carrier-admission` |

## 定位与复用判据【决策：依赖驱动】 ^anc-driver-opencode-carrier

opencode（sst/opencode,npm `opencode-ai`）是独立的开源 agent 家族——**不是 CC 的分发形态**（cfuse 内置 cc 才是），故不适用"纯路径适配"档（见下载体准入规则），必须有自己的 driver 内容层。

**复用判据（三层各自裁定,2026-09-19 真机核实 v1.18.31）**：

1. **skill 发现层=同构复用**：opencode 的 skill 机制按 CC 设计（`<name>/SKILL.md`+YAML frontmatter,只校验 name+description,`user_invocable` 忽略不报错;甚至主动扫 `~/.claude/skills/`）——0089 批已核,维持；
2. **driver 正文层=派生适配**（本批新立）：CC 正文含 CC 专属原语（AskUserQuestion/driver subagent/task-notification 等,hopspec-skill.md 计 30 处），opencode **有原生等价物**（见原语映射表）但名字与调用形态不同。
   - 真机 E2E 实证:装 CC 原文 opencode 也能跑通 coffee-week 全链——但通靠的是模型自由发挥（transcript 自述"我没有 AskUserQuestion 工具,改为直接问"）,不是协议。**协议不能靠模型每次现场翻译**（[[codex-driver-carrier#^anc-driver-codex-rule-parity]] 同一裁定:载体必须自包含）;
   - 故 `driver/opencode/` 持有派生自 CC 源的适配版正文——只做原语映射与措辞替换,执行语义/CLI 协议/介入点纪律与 CC 版逐条同构（语义签名表同 codex 文档该节）；
3. **引擎协议层=零适配**：hopjit CLI 的 JSON 协议载体中立,opencode 跑 bash 与 CC 跑 Bash 无异。

**维护纪律**：CC 源改协议面（新介入点/新命令/纪律变更）时 opencode 版同批随改——与 codex rule-parity 同款"接受两份"决策,不规定 CC 文本是上游,但改动核对面把 opencode 版列进 driver 载体清单（check-driver-carriers 守卫扩员见安装布局节）。

## 原语映射表【契约】 ^anc-driver-opencode-primitive-map

CC 原语 → opencode 等价物（适配正文的替换依据,2026-09-19 对 opencode v1.18.31 官方文档与真机核实）：

| CC 原语 | opencode 等价物 | 映射说明 |
|---|---|---|
| `AskUserQuestion` 组件 | **`question` 内置工具** | 语义同构：header+问题+选项列表,用户可选可自由输入,多问题可导航——HITL 呈交纪律（present_inputs 先 dump 后问）原样保留。question 工具不可用时（部分 OpenAI 兼容服务端拒收该工具——hopissues/0103 theta 实撞）降级普通文本消息问人,等下条消息回答 |
| `Agent` 工具起 driver subagent | **subagent 机制**（内置 general,或 Task 派发） | 执行段外包语义同构;opencode 真机已实证 General agent 承接执行段跑到终态。无 subagent 能力形态降级为主对话自跑（inline）——与 Codex 载体同款降级语义 |
| `task-notification`（后台任务完成通知） | 无直接等价（不依赖） | CC 版仅 /hop 的后台看护 subagent 场景用;opencode 版 /hop 照 codex 先例按 subagent 能力降级（有 subagent 外移阅卷与翻查,无后台通知就同步等或自驱）,不依赖此原语 |
| `run_in_background` | 无（同上,v1 不依赖） | parallel fan-out 的后台 worker 场景,opencode 版首版按串行退化口径（引擎顺序等价保证在场） |
| `/skill` 斜杠触发 | 隐式触发或直接说 skill 名 | opencode 按 description 触发 skill 工具装载;正文中"用户说 /hopspec run"改"用户要求执行 spec" |
| `--notify dingtalk` 意图翻译 | 原样保留（载体中立） | 通知是引擎挂点,driver 只翻译意图——非 CC 原语,不删（阅卷抓首版误删,补回） |
| dispatch_ready 的 call 占位符 | 原样保留（协议件） | `<CALLEE_SPEC_PATH:id>` 解析是引擎协议不是 CC 原语——串行退化只改执行形态不改协议（阅卷抓首版丢失,补回） |

**Glob 失败纪律【契约】**（hopissues/0102,本条为权威源;`driver/opencode/references/discovery.md` 头部条款是其落地件）：opencode 的 Glob 工具依赖 ripgrep（未装则自动下载,无公网环境下载失败即报 `ripgrep execution failed`）。Glob 失败时**不降级 `find /`、`find ~` 之类全库搜**——全库搜会超时且违反 spec 定位的禁全库搜纪律；照 spec 两级定位走（现成路径 / `<PKG>/examples/`），两级都不中即停下问用户,不自行扩大搜索面。

## 安装布局【契约】 ^anc-driver-opencode-install-layout

```
driver/opencode/
├── SKILL.md          # hopspec 复用模式主件（派生自 driver/hopspec-skill.md,原语映射适配）
├── SKILL-mcp.md      # hopspec-mcp 薄壳（派生自 driver/hopspec-skill-mcp.md）
└── references/       # 自包含执行细则（cli-discovery/discovery/step-execution-rules 适配版;
                      #  driver-subagent.md 的 CC 派发模板改 subagent 派发说明）
```

install-skill `--carrier opencode` 装载面：

- `driver/opencode/SKILL.md` → `<home>/skills/hopspec/SKILL.md`（home=XDG 解析,^anc-cli-carrier-home-resolution）
- `driver/opencode/SKILL-mcp.md` → `<home>/skills/hopspec-mcp/SKILL.md`（+discovery.md）
- `driver/opencode/references/` → `<home>/skills/hopspec/references/`
- hopbuild/hopbuild2/hopfix 照旧整目录拷（构建工具件载体中立度高——正文以 spec 编写知识为主,CC 原语密度低;如实记:未逐件适配,v1 接受,撞到原语问题按增量修）
- **`hop`（日常任务管理件）照装**——`driver/opencode/hop-skill.md` → `<home>/skills/hop/SKILL.md`。
  - 撤销沿革（2026-09-20 作者抓"在 codex /hop 都能用,为什么在 opencode 不装?"撤销首版"v1 不装"裁定）:该裁定把"原语密度高"误当"适配成本高",而 Codex 先例〔driver/codex/hop-skill.md,type: adapt〕已证 /hop 适配=三处载体差异——触发前缀/问人形态/spawn 能力降级,全部降级路径 Codex 版已铺好;opencode 能力面〔question 工具+内置 subagent〕只强不弱;
  - opencode 版以 codex 版为适配基准,载体差异:隐式触发/question 工具问人/subagent 降级判据同 codex。首版的 stale 清理与 carrier_note 随撤——hop 现为正装件
- MCP 注册与配置自举照旧（0089 批产物,jsonc 写法与 deep-merge 面零变化,权威 [[hop-cli#^anc-cli-install-skill]] opencode 条款）

**守卫**：check-driver-carriers.mjs 载体清单扩 opencode（CC/Codex 双载体断言面扩三载体——判据 token 表同源,opencode 版丢关键纪律句即红）。

## 载体准入规则【契约】 ^anc-driver-carrier-admission

新增 carrier 时按宿主性质分两档（2026-09-19 作者抓"cfuse 和 opencode 都放哪儿了"后立——此前判据散在 cli.ts 注释,cfuse 折 cc 有理与 opencode 折 cc 没底两件事账面同形,必须显式分档）：

1. **纯路径适配档**（不建 driver 目录）：宿主的执行引擎**就是**既有载体本体（先例:cfuse-cc/cfuse-codex——cfuse 内置引擎是真的 CC/Codex,装原生件语义完全成立）。判据:宿主厂商自己声明其为 CC/Codex 的嵌入分发,且 skill 由该引擎本体消费。此档只动 `resolveCarrierHome`+注册/自举面；
2. **内容适配档**（必须 `driver/<carrier>/` 目录+真机 E2E）：宿主是独立 agent 家族（先例:codex/opencode）。**发现层兼容≠执行层可用**——即使宿主主动兼容 CC 的 skill 格式,driver 正文的载体原语必须映射为宿主原生等价物,且**至少一条真机 E2E（装载→发现→驱动 demo spec 到 completed）作为"支持该载体"的宣称门槛**。0089 批实撞:opencode 按档 1 处理装 CC 原文,真机能通靠模型自由发挥,协议无保证。

拿不准归档 2——档 1 是显式豁免不是缺省。
