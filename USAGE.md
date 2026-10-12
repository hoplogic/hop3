%% @trace
	id: hopjit-usage
	source: [[docs/design/hop-cli]]
	source_id: hopjit-hop-cli
	type: compact
	last_sync: 2026-10-10T00:21+0800
	note: hopjit 命令行手册——供 agent 在 hopjit MCP 工具不可用时按命令行回退,供人在 /hop 出问题时排查;日常用户走 /hop,不读本页。命令清单与 hop-cli.md 命令表同源（增删改同批改,以 `hopjit --help` 实况为准）;/hop 话语→命令→MCP 工具的对应表抄自 driver/hop-skill.md §2 与 mcp-server.md 工具面表。2026-10-10 作者定位（此前是 8 月立的工具手册,三个时代叠加后无定位,整篇重写）
%%

# `hopjit` 命令行手册

供两种读者用：**AI agent** 在 hopjit 的 MCP 工具不可用时按本页命令行推进；**人**在 `/hop` 出问题时按本页排查。日常使用请走 `/hop`（Codex 里是 `$hop`），不需要读本页。

## 0. 本页给谁看

- **用户日常只用 /hop**。装好之后对 `/hop` 说你要干的事就行，它背后调的命令你不需要知道。
- **agent 的命令行回退**。`/hop` 推进任务优先用 hopjit 的 MCP 工具（`mcp__hopjit__run` 这一组）。本会话这些工具不可用时（项目还没注册、server 起不来），agent 改用本页的 `hopjit` 子命令——每条命令对应一个同名 MCP 工具，同一套引擎调用、同一份响应。
- **人的排查**。`/hop` 不在菜单、任务卡住、想看中间变量——第 5 节几条路。

## 1. 全局约定

- `--json`：强制单行 JSON 输出，给机器读；缺省是 YAML，给人读。agent 回退时一律带它。
- `--state-dir <目录>`：运行状态目录，缺省项目根下 `.hopstate`。
- `--instance <id>`：实例 id；省略取该状态目录下最新的一个。同时开着几个活时显式传。
- `--workspace <目录>`：显式指定项目根（起跑与批准类命令带）；不传取进程 cwd。
- 退出码：0 正常；1 命令出错。`doctor` 例外——任一体检项 fail 退 1，这是它的正常报告形态。

## 2. 你对 /hop 说的话，背后是哪条命令

| 你对 /hop 说的 | /hop 背后跑的命令 | 对应的 MCP 工具 |
|---|---|---|
| 装好 / 升级 / 刷新 | `hopjit setup` | 无（终端命令） |
| 体检一下 / 为什么用不了 | `hopjit doctor` | `doctor`（同一份报告；"MCP 工具调不到"那一支本身就是工具不可达，所以 /hop 在那里走命令行） |
| 任何多步骤的活（升格成任务卡；**执行在主对话**，agent 自己干每一步） | `run` 起跑 → `submit_and_fetch_next` 逐步提交 → 终态；中断后 `resume` | `run` / `submit_and_fetch_next` / `resume` |
| 跑 `examples/x.md` 或已装的 HopAnt（**hopspec 协议**：主 agent 只做编排，执行段外包给 subagent） | 同一组命令，spec 换成那份文件 | 同上 |
| 并行步的子实例收割 | `reap_and_fetch_next <子实例> --status completed\|failed` | `reap_and_fetch_next` |
| 批准这一步（commit 停点，对话里问过你） | `approve_commit <步骤号> --fingerprint <指纹> --scope once\|task` → `resume` | `approve_commit` |
| 同意碰这些目录（dirs 停点） | `approve_dirs <清单哈希>` → `resume` | `approve_dirs` |
| 到哪了 | `status` | `status` |
| 不要了 | `abort --reason "<你的话>"` | `abort` |
| 这份 spec 合法吗 | `validate <spec>` | `validate` |
| 任务卡上批过的命令（act 步骤里探索性执行） | 无命令行对应——回退期间走载体自己的 Bash，逐条弹窗 | `run_approved_command` |
| 走 MCP 独立模式跑 | 无命令行对应——在 hopjit server 进程里执行 | `start_run` / `run_status` / `resume_run` / `stop_run` / `list_runs` |
| 总结成可复用的流程元件（HopAnt）/ 分享 / 装 HopAnt | `ant pack --out hop_tasks/ants`（总结落项目级）/ `ant share` / `ant install [--scope user\|project]` / `ant adapt` / `ant list` / `ant remove [--scope]` / `ant bootstrap` | `ant_pack` / `ant_share` / `ant_install` / `ant_adapt` / `ant_list` / `ant_remove` / `ant_bootstrap`（参数与命令行同名，下划线连写；装与分享写 `~/.hopjit/` 由 server 进程做，不经载体文件沙盒） |
| 把自然语言 skill 翻译成 spec | 不是单条命令——由 hopbuild skill 驱动 | 无 |

两条路的执行姿态不同，别混：**升格任务卡**（hop-skill §2）的每一步由主对话的 agent 自己干；**跑现成 spec / HopAnt**（hopspec-skill §1）主 agent 只做编排，执行段外包给 subagent。命令相同，谁在干活不同。

## 3. 命令分组速查

每条：用途 · 关键参数 · 人什么时候会手敲。全部参数以 `hopjit <命令> --help` 为准。

**安装与体检**

- `setup [--carrier cc|codex|cfuse-cc|cfuse-codex|opencode] [--dir <目录>] [--plus] [--force]` · 探测本机 coding agent，装 /hop 全家、注册 hopjit MCP server、写放行、从宿主学 LLM 配置、装三个演示 HopAnt；可重复运行 · 装包后敲一次，引擎升级后再敲一次。
- `doctor` · 装完能不能用的八问（skill 在场 / 版本 / 菜单可见 / MCP 注册 / 握手 / 放行 / MCP server 模型配置 / 独立模式凭证），每项一行 ok、warn、fail 或 n/a 加补法；只报不改 · /hop 不在菜单、用不了的时候。

**驱动一个 run**（agent 回退时用，人一般不碰）

- `run <spec> [--workspace <目录>] [--params <json>|@file] [--approve-dirs] [--notify dingtalk]` · 起跑并推进到第一个要你干活的点。
- `submit_and_fetch_next <步骤号> --output|--answer|--child-instance|--failure-child|--failure|--replan|--tool-result <值>` · 提交当前步的结果，拿下一步；七种提交形态一次只给一个；大产出 `--output @<work_zone 内路径>`。
- `resume [--instance <id>]` · 从崩溃或停点续跑 · 任务卡住时。
- `status [--instance <id>]` · 看进度与停在哪 · 想知道到哪了。
- `vars [--instance <id>]` · 看全部变量值 · 想看某步产出了什么。
- `abort [--instance <id>] [--reason <文本>]` · 中止，不可撤销，快照保留。
- `approve_commit <步骤号> --fingerprint <指纹> --scope once|task [--workspace <目录>]` · 记下人对 commit 步的批准；之后 `resume`。
- `approve_dirs <清单哈希> [--instance <id>]` · 记下人对项目外目录清单的同意；之后 `resume`。

**并行与派发**（agent 用，人几乎不碰）

- `reap_and_fetch_next <子实例> --status completed|failed` · 收割一个 parallel 子实例的结果并领下一介入点。
- `advance [--instance <id>]` · 渐进派发场景下续推主线。
- `init <spec> [--params ...] [--parent <id> --step <步>] [--parallel-parent <id> --parallel-child <步>]` · 只建实例不推进（run = init + 推进）。

**spec 文件工具**（写 spec 的人会用）

- `validate <spec> [--fragment] [--known-vars a,b]` · 校验合法性，不建实例；`errors` 非空不可执行。
- `lang <spec> --to zh|en` · 关键词中英互转，原地改写，先备份。
- `schema-sep <spec>` · HopSchema 分隔符 `:` 迁 ` % `，原地改写，先备份。
- `list <目录>` · 列目录下可执行的 spec。
- `pack <spec> [--carrier ...] [--dir <目录>] [--name <名>] [--assets a,b] [--force]` · 把一份 hopskill spec 打成独立具名 skill（不是 HopAnt，那是下面 `ant pack`）。

**HopAnt**（现成的 HopSpec 工具，两级：项目级 `<项目>/hop_tasks/ants/<id>/`〔这个项目总结出的〕与用户级 `~/.hopjit/ants/<id>/`〔装进来的〕，按 id 找时项目级先）

- `ant install <目录> [--dry-run] [--scope user|project]` · 装一个 HopAnt 目录或 HopAnt 包；缺省装用户级 `~/.hopjit/ants/`，`--scope project` 装进本项目 `hop_tasks/ants/`。
- `ant adapt <id>` · 核本机对这个 HopAnt 的依赖（工具注册、凭证、命令）齐不齐，齐则写适配戳。
- `ant list` · 列两级已装 HopAnt 与适配状态（每行带 scope，项目级在前，同 id 两行都在）。
- `ant remove <id> [--keep-store] [--scope user|project]` · 卸载；不带 `--scope` 删按 id 找到的那一级（项目级先）。
- `ant bootstrap <id> [--dry-run]` · 跑该 HopAnt 自带的安装脚本。
- `ant pack <spec> [--out <目录>] [--id <id>] [--assets ...]` · 把一份 spec 封成 HopAnt（归位目录、核齐入口头）。
- `ant share <id>... [--out <目录>] [--name <包名>] [--pkg-version <v>] [--owner <标识>] [--yes]` · 把若干已装 HopAnt 装进一个可分发的包。

**工具直调**

- `tool-call <工具名> [--args '<json>'|@file]` · 直接调一件已注册的 hop 工具，无实例无状态；`requires_commit` 的工具拒 · agent 在复用模式下调特殊工具的通道，人排查工具注册时也可用。

**调试**

- `debug_step [--instance <id>]` · 只推进一步，不消化产出、不自动前进 · 排查引擎行为时。

## 4. 命令行背后的运行形态

**先分清"MCP"的两个意思。** 本页和教程里 MCP 出现两种含义，别混：**(a) 把 HopJIT 自己当 MCP server 跑**——就是下面的独立模式，`hopjit setup` 已经把它注册进你的 coding agent；**(b) spec 里调外部 MCP 工具**（搜索、知识库）——那是配置文件的 `tool_servers:` 节，见教程 08。

| | 复用模式（reuse） | 独立模式（standalone） |
|---|---|---|
| 推理谁做 | 外层 LLM（Claude Code / Codex 本身） | HopJIT 引擎直调 LLM API |
| 需要配置 | **零**——装好 skill 即用 | 一份 `~/.hopjit/config.yaml` + 在载体注册 MCP server（`setup` 两样都替你做了） |
| 成本 | 用你对话模型的额度（模型即对话所用，无从选择） | **可换轻量模型**（如 deepseek-chat）——长任务省一个量级 |
| 沙箱/工具 | 载体的完整工具面（读写文件、跑命令都行） | 引擎内置工具集（受限但独立——不依赖载体沙箱策略） |
| 执行位置 | 你的对话会话里（占上下文；会话断了要 resume） | 独立 server 进程（不占对话；你只在需要确认时被叫回来） |
| 适合 | 入门、调试、需要载体工具的 spec | 跑得久、跑得频、纯推理+计算类任务 |

**路径建议**：从复用模式开始（零配置，`/hop 跑 <spec>` 即用）；当任务变长、变频、或想换便宜模型时，对 `/hop` 说"走 MCP 跑 <spec>"——同一份 spec 一个字不用改。

**独立模式的配置。** `hopjit setup` 已经从你的 coding agent 学来了模型配置（写进 `~/.hopjit/config.yaml`，只写凭证的环境变量名，不写值），多数情况不用再配。没学到时（`doctor` 的 `mcp_llm_config` 项会报 fail）手补这份文件，最小形态：

```yaml
providers:
  - service_id: deepseek
    protocol: anthropic
    base_url: https://api.deepseek.com/anthropic
    model: deepseek-chat
    api_key_env: DEEPSEEK_API_KEY
```

全部字段（模型分档、工具注册、路由）见 `docs/reference/配置参考.md`。MCP server 的注册落点（排查时看这里）：Claude Code 与 cfuse 内置 cc 是项目根 `.mcp.json`；Codex 是 `~/.codex/config.toml`（cfuse 内置 codex 是 `~/.codefuse/engine/codex/config.toml`）；opencode 是 `~/.config/opencode/opencode.jsonc`。Codex + DeepSeek 模型的用户先看 `docs/WORKAROUNDS.md` W-1。

**`web_search` 从哪来。** spec 里的 `web_search` 是标准工具名，hop 自己没有搜索能力。**复用模式**：执行你对话的 agent 用它自己的网页搜索落实，零配置——仓库 `examples/` 里的 hop-fact-check 装好就能跑。**独立模式**：server 的模型自己不搜，要在 `tool_servers:` 注册一个外部 MCP 搜索服务（`examples/hoptools-websearch.yaml` 有百炼与另一家 provider 的可抄片段）。复用模式下你的 agent 恰好没有搜索能力时，同样可以注册后由 `hopjit tool-call` 兜底。

## 5. 人 debug 时的几条路

- **`/hop` 不在菜单 / 装完用不了** → 终端 `hopjit doctor`，看哪一项 fail 和它的补法。最常见：没跑 `hopjit setup`，或跑完没新开会话。`hopjit` 命令本身找不到 → 确认 `npm i -g @hoplogic/hopjit` 成功且全局 bin 目录在 PATH 里。
- **任务卡住** → `hopjit status`（看停在哪一步、是不是在等你确认）→ `hopjit resume`。
- **想看某一步产出了什么** → `hopjit vars`。
- **想看过程** → 项目根 `.hoplog/<run>/main.yaml`（每步的 prompt、产出、命令执行账都在）。正常执行不用翻它，复盘时翻。
- **agent 说 MCP 工具不可见** → `hopjit doctor` 的 `mcp_registered` / `mcp_handshake` 两项；handshake 的 hint 会给出 `.mcp.json` 里该改的命令路径。

---

更多：`README.md`（项目入口与 /hop 用法）· 教程从 `docs/tutorials/00-新人导读.md` 进 · 语法权威 `docs/concepts/HopSpec V3语法参考.md`。
