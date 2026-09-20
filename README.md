# hoplogic — HOP 3.0

> **HOP** is a dual-mode language & runtime for LLM agents: declare tasks as structured markdown specs (HopSpec), execute them with engine-enforced discipline (HopJIT) — loops that don't skip, gates that don't yield, and human checkpoints that can't be bypassed. Docs are currently in Chinese; an English translation is planned.

**hoplogic** 是 HOP 的官方项目。**HOP** 是一套面向 LLM Agent 的双态融合语言/概念体系，当前为 **3.0** 版。

**锁定目标，守住边界，放开路径。** HOP 让人和 Agent 先对齐目标、约束与交付，用代码逻辑承载规则与核验，让模型在边界内推理、探索和修复；经过验证的有效做法，还可以沉淀为可复用的流程。

[快速开始](#quickstart) · [教程](./docs/tutorials/00-新人导读.md) · [示例](./examples/) · [文档导航](./Doctree.md) · [架构](./ARCHITECTURE.md)

> **仓库形态**：本仓是 hoplogic 项目的**发布快照**（单向同步自维护者工作仓）。包含引擎源码（src/tests）、全部概念/设计/教程文档、驱动 skill 与示例；**不含**内部工程过程账（事项卡、审计存档、发版手册等——文中标〔内部开发面〕的引用即指这些，后继逐步开放）。想贡献：欢迎提 issue；PR 会由维护者搬运进工作仓验证后随下一版快照带回（署名保留在 release note）。

## 你想做什么

不必先写一份 HopSpec 才能开始：把手头的任务交给 `/hop`，也可以运行现成规约，或将已有 Skill 中的经验整理为可复用流程。

| 你的目标 | HOP 提供的帮助 | 从这里开始 |
|---|---|---|
| 把调研、报告、核对等多步骤工作交给 Agent，能查进度、中断后能接着做 | `/hop` 将目标或已有计划转成任务规约；步骤、检查与进度由引擎管理，不只靠对话记忆 | [快速开始](#quickstart) → [日常任务教程](./docs/tutorials/04-日常活交给hop.md) |
| 让现成业务流程按要求执行，而不是每次重新解释 | `/hopspec` 运行已有规约，复用输入、步骤与核验要求，在声明的介入点交由人或调用者决策 | [示例](./examples/) → [读懂一份 spec](./docs/tutorials/02-读懂一份spec.md) |
| 把现有自然语言 Skill 里的"不能漏、必须查、先确认"落实到执行结构 | `/hopbuild` 将流程翻译为 HopSpec，由作者核对原意，再校验和打包复用 | [升级你的 Skill](./docs/tutorials/07-升级你的自然语言skill.md) |
| 把一次探索中的有效做法留下来，下次少从头摸索 | `/hop distill` 提炼参数、流程与检查要求；经人确认后复用，未验证分支仍明确标注 | [提纯：干完一次，以后直接跑](./docs/tutorials/04-日常活交给hop.md#提纯干完一次以后直接跑) |
| 接入自己的工具，或参与引擎与生态开发 | 从概念、架构到实现与测试沿同一条链定位，明确扩展边界和验证依据 | [开发者导读](./docs/tutorials/D0-生态开发者导读.md) · [工具开发](./docs/tutorials/D7-开发自己的工具.md) |

项目内三个名字各司其职：

| 名字          | 是什么                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HOP 3.0** | HOP 语言/概念层的 v3.0 版本。概念规范：[核心规范](./docs/concepts/HopSpec%20V3核心规范.md)（语言权威）· [核心创新](./docs/concepts/HopSpec核心创新.md)（定位）；全部 13 份见 [Doctree](./Doctree.md)「概念层」表 |
| **HopSpec** | HOP 的任务规约语言——用 markdown 声明任务结构（步骤类型、数据流、循环/分支/并行、人机介入点）                                                                                                     |
| **HopJIT**  | hoplogic 项目里的 HopSpec 执行引擎（npm 包 `@hoplogic/hopjit`、命令 `hopjit`）——负责执行状态管理、变量存储、retry/adaptive 修复、None 传播等流控                                                |

## 想深入理解？（理念→工程，七站）

⚖️ [工程实现链规范](./docs/concepts/工程实现链规范.md)（元规范，一切组织规则）→ [核心创新](./docs/concepts/HopSpec核心创新.md)（定位）→ [HopType 体系](./docs/concepts/HopType体系.md)（架构语言 struct/trait/impl）→ [ARCHITECTURE](./ARCHITECTURE.md)（架构分层）→ [模块规范](./docs/design/module-principles.md) → [Doctree·模块索引](./Doctree.md)（14 模块收链入口）→ [chain-enforcement](./docs/design/chain-enforcement.md)（机检守卫与人的职责）。生态开发者（要动 src/design/driver 的）从 [D0-生态开发者导读](./docs/tutorials/D0-生态开发者导读.md) 进（十站主线）。

两种驱动模式：

- **复用模式（reuse）**：外层 LLM（如 Claude Code）当推理引擎，HopJIT 只做纯流控——**不需要 API key**。配套 `hopspec` skill 驱动。
- **独立模式（standalone）**：HopJIT 引擎直调 LLM API 执行（MCP server 形态）——可换轻量模型省成本、不占对话上下文；一次性配置 `~/.hopjit/config.yaml` + 载体注册，见 `USAGE.md` §6。

<a id="quickstart"></a>
## 第一步：安装 HopJIT 引擎

<details>
<summary>首次使用？展开环境准备（Node.js 与 Claude Code / Codex）</summary>

以下安装与检查命令都在**终端**执行。

**检查 Node.js 与 npm**（Node.js 须 20 或更高，推荐 [官方下载页](https://nodejs.org/en/download) 的 LTS 版本）：

```bash
node --version
npm --version
```

**准备 Claude Code 或 Codex（二选一）**：

- **Claude Code**：`claude --version` 检查；未装见 [官方快速开始](https://code.claude.com/docs/en/quickstart)，装后执行 `claude` 按提示登录。
- **Codex CLI**：`codex --version` 检查；未装 `npm install -g @openai/codex`，装后执行 `codex` 按提示登录。

确认所选工具能正常回复消息即可。HOP 复用模式直接使用该工具已配置的模型，**不需要**再为 HopJIT 单独配置 API key（这不代表模型使用免费）。

</details>

**一切从这条命令开始**——没装引擎，后面的 skill、demo、spec 都无从谈起：

```bash
npm install -g @hoplogic/hopjit
```

装完 `hopjit --version` 能出版本号即成功。三层命名一句话理清：装的**包**叫 `@hoplogic/hopjit`，得到的**命令**叫 `hopjit`，它执行包内的 `dist/cli.js`。

```bash
# 不想装全局？也可以只装进你的项目（在你的项目根目录）
npm install @hoplogic/hopjit
```

> 开发者（clone 本仓库改代码）：安装与刷新走 `npm run dev:install`，见下方「开发与发版」。

## 第二步：装 skill，在对话里驱动

**日常入口不是命令行，是 skill**——Claude Code 用 `/hopspec run <spec>`，Codex 用 `$hopspec run <spec>`；hopjit 命令行主要是驱动层的协议接口，人只在三处直接碰它（装 skill / 校验 spec / 打包 skill，见下节）。

**一条命令安装**（自动把包内 `driver/` 源展开到正确布局，免手动 cp）：

```bash
# Claude Code（默认，装到 .claude/skills/）
hopjit install-skill

# 想要一个开箱演示：--demo 附装 /coffee-week 具名 skill（含演示数据，装完对话里说 /coffee-week 即收一份咖啡店周报）
hopjit install-skill --demo

# Codex（默认装到用户级 ~/.codex/skills/——装一次全项目可用;与 CC 对称）
hopjit install-skill --carrier codex

# Codex 开箱演示：demo 装当前项目 .agents/skills/（演示材料跟项目走），对话里用 $demo-coffee-week
hopjit install-skill --carrier codex --demo

# 覆盖已存在的 Codex skill（改过 skill 想重置时）
hopjit install-skill --carrier codex --force

# 裸终端预装给 cfuse 内置 Claude Code（装到 cfuse 内置 cc 读取的目录）
hopjit install-skill --carrier cfuse-cc

# 裸终端预装给 cfuse 内置 Codex（装到 cfuse 内置 codex 读取的目录）
hopjit install-skill --carrier cfuse-codex

# 装给 opencode（装到 ~/.config/opencode/skills/,OPENCODE_CONFIG_DIR 在场则优先）
hopjit install-skill --carrier opencode
```

> **cfuse 用户**：cfuse 内置窗口表现为原生 Claude Code 或 Codex,按该载体的原生命令跑即可——环境变量自动装到 cfuse 目录;`--carrier cfuse-cc`/`cfuse-codex` 仅用于裸终端预装（目标 agent 未启动时显式指定 cfuse 目录）。完整入门走 `docs/tutorials/01-第一次运行-cfuse.md`（三形态分辨/装对家/MCP 注册落点/排错）。
>
> **opencode 用户**：skill 隐式触发（直接说"用 hopspec 执行某某 spec"，无斜杠命令）；驱动件为 opencode 适配版（question 工具问人/subagent 外包执行段）。完整入门走 `docs/tutorials/01-第一次运行-opencode.md`。

`install-skill` 装出的 skill（CC）：

```
.claude/skills/
├── hopspec/              # /hopspec —— 驱动执行现成 spec
│   ├── SKILL.md
│   └── references/       # 载体中立共享（cli-discovery / driver-subagent / …）
├── hop/                  # /hop —— 日常任务管护（意图表第一行的入口就是它）
│   └── SKILL.md
├── hopbuild/             # /hopbuild —— 自然语言 skill 翻译为 HopSpec
│   ├── SKILL.md
│   └── hopbuild-primer.md
└── hopbuild2/            # 实验性构建器（日常翻译用 /hopbuild，此件仅显式点名时使用）
    └── …
```

skill 启动时**自举探测** hopjit 位置（全局命令 → 项目 node_modules → 包内 dist → 开发期 fallback），无需硬编码路径——见 `references/cli-discovery.md`。

之后在 Claude Code 里：

```
/hopspec run <spec.md>          # 驱动执行一个 spec
/hopspec list [dir]             # 列出可执行 spec
/hop 查一下X,写成报告            # 日常活交给引擎管护(进度可查、中断可续)
/hopbuild                       # 把自然语言 skill 翻译成 hopskill
```

Codex 载体见 `driver/codex/SKILL.md`。安装后可由描述隐式触发，也可显式调用 `$hopspec run examples/data-quality.md`；带 `--demo` 时直接用 `$coffee-week`。两个载体功能等价：并行步骤在 Claude Code 里由后台子任务同时跑，在不支持后台子任务的环境里自动改为逐个执行——执行结果、检查点和"需要你确认"的停点行为完全一致。

> 入门演示随包发布：`install-skill --demo` 安装载体对应的具名 skill——CC 输入 `/coffee-week`，Codex 输入 `$coffee-week`，都使用打包演示数据直接产出周报。技术用户仍可经通用 hopspec driver 运行任意 spec。

## CLI 是驱动层协议接口，不是人的入口

人需要敲的命令只有安装那一次（`npm install` + `hopjit install-skill`，见上）。其余子命令——`validate` / `lang` / `list` / `init` / `run` / `submit_and_fetch_next` / `reap_and_fetch_next` / `advance` / `debug_step` / `abort` / `status` / `tool-call` / `vars` / `resume` / `pack`——都由 agent（skill / dispatcher）调用：校验由 `/hopbuild` 在生成时自动过闸，打包由它在交付时代跑，执行状态由 `/hopspec` 驱动。机器消费统一带 `--json`（缺省输出面向人的 YAML，供 agent 转述或人排查时读）。全表见 [USAGE.md](./USAGE.md) §5「CLI 命令速查」。

## 问题反馈（两条通道，按你是谁分流）

- **人类用户**：直接在 [GitHub Issues](https://github.com/hoplogic/hop3/issues) 报——正常的 bug 报告/提问入口；
- **AI agent**：走 [hoplogic/hopissues](https://github.com/hoplogic/hopissues) 协议仓（PR 即开卡）——那是为 agent 之间协作设计的强纪律通道：议题卡必须带可执行的闭环判据（probe），修复方标 fixed 不算完，报告方在自己环境实跑 probe 转绿才 closed。协议全文见该仓 README。

## 开发与发版（维护者）

```bash
# 克隆后一切在本仓库根目录执行（npm run 读当前目录 package.json，目录不对报 ENOENT）
git clone <本仓库> hoplogic && cd hoplogic

# 开发用一条命令（自愈：首跑自动 npm install/npm link，之后每次改完代码/driver 重跑即可）
# 做四件事：补依赖(缺才装) → 重建 dist → 补全局软链(未链才链) → 装最新 skill 到 ~/.claude/skills
npm run dev:install
npm run dev:install -- --demo    # 同步附装演示 skill：CC 用 /coffee-week，Codex 用 $coffee-week

# 发版：十一步检查单（全检/tarball 资产核对/version/publish/全局更新/装 skill/推 tag），一步不过即停
npm run release
```

每次提交/发版的完整操作手册（分诊、手工验收断言、坑速查）见 maintainers/RELEASING.md〔维护者内部面〕。

## 依赖说明

- **运行时依赖**：`commander`（CLI）+ `@anthropic-ai/sdk`（仅独立模式的 StepDispatcher 用；复用模式不触发）。
- 复用模式（skill 驱动）**不需要 API key**——推理由外层 LLM 承担。

## 根目录重要文件

| 文件 | 干什么 | 谁用、什么时候 |
|---|---|---|
| [Doctree.md](./Doctree.md) | 全库文档索引的根——有什么文档、谁派生自谁 | 找任何文档从这里进 |
| [USAGE.md](./USAGE.md) | 上手速查（一页看完装和跑） | 使用者，装完想快速回查时 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构总览——分层/桥接点/组件交互/双态分布 | 读懂系统前必读（主线第 4 站） |
| maintainers/RELEASING.md〔维护者内部面〕 | **维护者操作手册**——提交/发版前的分诊、手工验收断言、自动 E2E 时机、坑速查 | 维护者，**每次提交/发版都走**（教程读一次，这份每次用） |
| [STATUS.md](./STATUS.md) | 当前状态快照——版本/健康度/在做什么/欠账 | 想知道项目现在什么样（唯一允许过期的文档） |
| todo/〔内部开发面，快照暂不含〕 | 活待办与技术债卡目录（文件名即状态机） | 接手干活前 `ls todo/` 挑 open 卡 |
| [TRACEABILITY.md](./TRACEABILITY.md) | 锚点五层追溯卡片（概念→设计→代码→测试） | 查某特性全链落点时搜锚点 |
| audits/〔内部开发面，快照暂不含〕 + [scripts/audit/](./scripts/audit/) | **审计工具链**——anchor-audit（锚点链语义审计 spec，三块：scan 机检/语义审计/修复）+ test-coverage-audit + scan.py/cross_compare.py | 维护者，里程碑/发版前跑语义审计（release ④a 闸核其产物） |
| CLAUDE.md〔内部开发面，快照暂不含〕 | Agent 工程约定（实现链纪律、机检入口） | agent 动手前的规矩 |

## 深入文档

- 入门演示随 npm 包（coffee-week 首跑 → data-quality → doc-review + 各自演示数据 + GETTING-STARTED）；项目仓库 `examples/` — 全量端到端范本。
- HopSpec v3 语法与执行语义：[核心规范](./docs/concepts/HopSpec%20V3核心规范.md) · [语法参考](./docs/concepts/HopSpec%20V3语法参考.md) · [配套运行时能力](./docs/concepts/HopSpec%20V3配套HopJIT运行时能力.md)。

## License

MPL-2.0（Mozilla Public License 2.0）——文件级 copyleft：修改本项目源文件须以同许可开放该文件，但可与闭源代码组合使用、可商用。全文见 [LICENSE](./LICENSE)。
