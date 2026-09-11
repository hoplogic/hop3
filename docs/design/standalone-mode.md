%% @trace
	id: hopjit-standalone-mode
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-08-11T21:50+0800
	note: standalone（独立模式对外整体）的统一设计（2026-08-11 作者定：standalone 本质上是一个统一接口端，需要统一的设计和审查）。此前配置 schema、凭证解析、模式选定、MCP 工具面分别写在 shared-providers/step-dispatcher/codex-driver-carrier/mcp-server 四份文档里——各自都对，但"合在一起必须守住什么"没人写。本文补这一层：各部分的条款权威仍在原文档原锚点（下游引用不断链），本文写跨文档的整体约束与审查办法
%%

# standalone 统一设计

## 文档结构与内容分级

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【决策】** | 人拍板的关键选择 | 改动需作者确认 |
| **【契约】** | 带 `^anc-*` 锚点的技术约定 | 代码/测试必须对齐，anchor-audit 全量审查 |
| **【说明】** | 示例、背景 | 与契约一致即可 |

| 章节 | 分级 | 锚点 |
|------|------|------|
| standalone 是什么 | 契约 | `anc-struct-standalone-endpoint` |
| 四份文档各管哪块 | 契约 | `anc-struct-standalone-facets` |
| 整体必须守住的五件事 | 契约 | `anc-exec-standalone-invariants` |
| 改动时怎么审查 | 契约 | `anc-meta-standalone-review` |
| 排队中的扩展 | 说明 | — |

---

## standalone 是什么【契约】 ^anc-struct-standalone-endpoint

HopJIT 有两种用法（概念上游 [[../docs/concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-dual-mode]]）：

- **复用模式**：CC/Codex 这类 agent 自己当执行者，逐步调 `hopjit` CLI 驱动 spec——LLM 能力"复用"宿主 agent 的，HopJIT 不直接调模型，也就不需要自己的配置文件（参数和凭证都来自 caller 进程环境）；
- **standalone（独立模式）**：HopJIT **自己调 LLM 执行整个 spec**。宿主（CC/Codex/任何支持 MCP 的工具）只负责发起和接收结果，执行过程中的模型调用、凭证、路由全由 HopJIT 自己解决。

对用户来说 standalone 就是三步：装 `hopjit-mcp`、写一份 `~/.hopjit/config.yaml`（声明用哪家模型服务、key 在哪个环境变量）、在宿主里注册这个 MCP server。之后宿主里的 agent 通过五个 MCP 工具（start_run / run_status / resume_run / list_runs / stop_run）发起、跟进和中止执行。

**这一整套——一份配置文件、一次注册动作、四个工具、一条凭证链——用户视角是一个东西**。所以它需要一份统一的设计：任何一块单独改动都可能破坏整体的约束（比如凭证只要在某一个环节泄漏一次，整体的"key 不落盘"就破了）。这正是本文存在的原因。

**归属判据**：一个配置项如果需要"用户在会话外预先写好、跨会话生效"，它就属于 standalone 的配置文件（schema 在 [[shared-providers#^anc-config-standalone-schema]]）——不允许出现第二个配置文件。反之，随每次调用传的参数属于复用模式的 CLI 面。

## 四份文档各管哪块【契约】 ^anc-struct-standalone-facets

standalone 的具体条款分写在四份文档里（各自的锚点是权威，本表只是地图——**改哪块先去对应文档改定，再回本文核对下节的整体约束**）：

| 管什么             | 具体内容                                                                              | 权威位置                                                                                | 代码位置                                 |
| --------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------ |
| 配置文件            | `config.yaml` 的字段定义、"key 只许写环境变量名"、默认模型怎么解析                           | [[shared-providers#^anc-config-standalone-schema]]                                  | mcp-server.ts `loadStandaloneConfig` |
| 运行期凭证           | 配置里选了后端就用配对的 key（不再看环境变量）、Anthropic SDK 会自己捡环境 token 的通道必须掐断、resume 时 key 从当前环境重取 | [[step-dispatcher#^anc-exec-model-resolve]]                                         | dispatcher.ts `resolveCredential`    |
| 怎么进入 standalone | 注册 MCP server 这个动作本身就是选定（没有额外的配置开关）；确认 server 在场靠发一次真调用（list_runs），不靠看工具列表        | [[codex-driver-carrier#^anc-driver-codex-standalone-dispatch]]                      | driver/codex SKILL.md STANDALONE 段   |
| MCP 工具          | 四个工具的行为、异步启动（start_run 立即返回）、启动时的配置校验、一个 server 管多个 run、重启后恢复                     | [[mcp-server#^anc-struct-mcp-server]] 及其工具锚点                                        | mcp-server.ts `HopjitMcpCore`        |
| 执行参数组装          | 配置文件怎么变成引擎吃的 HostConfig/ModelEngine（含默认禁读 .env/*.key 的沙箱基线）、按步骤类型路由模型             | [[shared-providers#^anc-config-host]] + [[step-dispatcher#^anc-exec-model-resolve]] | mcp-server.ts `providerToHostConfig` |

## 整体必须守住的五件事【契约】 ^anc-exec-standalone-invariants

以下约束跨越上表多块，**只看任何一块都推不出来**——这是分文档写法的盲区，也是本文的核心内容。改动任何一块都要逐条对照：

1. **key 永远不落盘**。配置文件里禁止明文 key（写了直接启动失败）；state 快照、HopLog、e2e 归档也都不含 key；resume 恢复时从当前进程环境重新取 key，不从任何存档里恢复。**每次新增一种落盘产物，第一件事就是核对这条**；
2. **用户明说的永远压过环境里碰巧有的**。用户在配置里选了 DeepSeek 后端，就用配套的 key——哪怕宿主环境里有 Anthropic 的 token 也不能拿去用（2026-08-10 两次真机 401 都是这么错的：宿主 token 被拿去配别家 endpoint，其中一次是 SDK 自己从环境捡的）。新增任何"自动从环境取值"的便利逻辑前，先回答：它会不会盖掉用户的显式声明；
3. **进不进 standalone，看用户动作，不看软信号**。判定依据只有两个：用户注册了 MCP server（这是显式操作，不会误触）+ 发一次 list_runs 真调用确认在场。不用配置开关、不看工具列表、不做探测——这些信号都可能因环境差异漂移（实撞：Codex 延迟加载工具，注册成功了列表里也看不到，靠看列表判定必然误判）；
4. **问题拦在门口，不带进执行**。配置文件格式错、key 环境变量没设、spec 要用的工具不支持——全部在 server 启动或 start_run 时报错拒绝，不允许跑到一半才炸。报错说变量名、字段名、缺什么，不说 key 的值；
5. **配置 schema 只有一个**（2026-08-13 随两级形态措辞校准——本条真意从来是"不另开新 schema 文件"：原 tools_file 指向独立 hoptools.yaml 正是本条反对的分裂,已收编为 tool_servers 节归位）。今后任何新配置需求都扩进现有 schema，不另开新文件。同一 schema 两个作用域实例（系统级 ~/.hopjit/config.yaml + 项目级 <项目根>/hopjit.yaml,逐节合并项目级赢）不违反本条——文件数是作用域的事,schema 唯一才是本条守的东西。

## 改动时怎么审查【契约】 ^anc-meta-standalone-review

改动触及上表任何一块时，除了该块自己的常规过链审查，**加跑下面六问**（都是"这块改完，整体还成立吗"）：

- [ ] 是否新增了落盘的东西？→ 对照第 1 条，逐个产物确认无 key；
- [ ] 是否新读了环境变量，或依赖了 SDK 的默认行为？→ 对照第 2 条，写出"什么用户显式声明可能被它盖掉"；
- [ ] 是否改了"怎么进入 standalone"？→ 对照第 3 条，判定依据必须仍是用户动作+真调用；
- [ ] 是否有校验从启动/入口挪到了执行期？→ 对照第 4 条；
- [ ] 是否新增配置项？→ 对照第 5 条，进现有 schema 并同步 `loadStandaloneConfig` 校验+正反例；
- [ ] 受影响的权威文档是否已先改定？本文的"四份文档各管哪块"表是否仍与实际一致？

## 排队中的扩展【说明】

- ~~routing_rules~~ 已交付（2026-08-13 随分级模型路由整体交付——系统层 routing_rules+spec Config 段+软偏好落级,见 [[shared-providers#^anc-config-standalone-schema]]）；
- ~~protocol 枚举扩 `openai`~~：✅ 2026-08-12 交付（[[step-dispatcher#^anc-exec-protocol-adapter]]）——第 2 条审查已过：openai SDK 自读 OPENAI_API_KEY 的隐式通道在适配器构造时显式传 key 切断（与 anthropic authToken:null 同型）；LLM 工具循环当下不做（作者定，实际需求出现再议）；
- ~~独立模式 resume 时完整 HostConfig 重建~~ 已收口（原 DEBT-05——mcp-server restoreRun 用当前 config.yaml 重建注入,凭证链新 Dispatcher 构造时重走,见 [[mcp-server#^anc-mcp-run-restore]]）。
