%% @trace
	id: hopjit-tutorial-cfuse
	source: [[../design/hop-cli]]
	source_id: hopjit-hop-cli
	type: compact
	last_sync: 2026-09-19T11:20+0800
	note: 教程 1 cfuse 版——第三载体入口,与 CC/Codex 版平列（作者定 2026-09-19"cfuse 应该单独列出来,不能作为 codex 附庸"）。载体解析机制源=hop-cli ^anc-cli-carrier-home-resolution（cfuse-cc/cfuse-codex carrier 与环境变量自动适配）
%%

# 教程 1（cfuse 版）· 第一次运行

> 用原生 Claude Code 的读 [[01-第一次运行-ClaudeCode]]，用原生 Codex 的读 [[01-第一次运行-Codex]]，用 opencode 的读 [[01-第一次运行-opencode]]。之后的教程 02-07 三个载体通用。

**目标**：在 cfuse（CodeFuse）里从零装到跑通一个 spec。
**前提**：装有 Node.js ≥ 18 和 cfuse；先 `npm install -g @hoplogic/hopjit` 装引擎。

## 先搞清楚一件事：cfuse 的三个形态，你在哪个里

cfuse 有三种会话形态：

1. **cfuse 自有 agent**——cfuse 自己的对话引擎；
2. **内置 Claude Code**（下称"内置 cc"）——cfuse 里嵌的 Claude Code 引擎；
3. **内置 Codex**（下称"内置 codex"）——cfuse 里嵌的 Codex 引擎。

**hopjit 的驱动 skill 目前适配的是后两个**（内置 cc / 内置 codex）——这两个形态里，命令、触发方式、执行体验与原生 Claude Code / Codex 完全一致，本篇教你把 skill 装对位置。**cfuse 自有 agent 形态尚未适配**（没有对应的驱动 skill 载体）——在自有 agent 窗口里用不了 `/hopspec`，要跑 spec 请切到内置 cc 或内置 codex 窗口。

内置形态与原生版不一样的只有一件事：**文件住的地方**。原生 Claude Code 的 skill 装在 `~/.claude/`，原生 Codex 装在 `~/.codex/`；而 cfuse 给内置引擎划了自己的家——内置 cc 读 `~/.codefuse/engine/cc/`，内置 codex 读 `~/.codefuse/engine/codex/`。装错了家，cfuse 窗口里就看不到 skill——这是 cfuse 用户撞到的第一大坑，本篇的安装步骤就是围绕"装对家"展开的。

## 第 1 步：安装 skill（两种场景，先判断你在哪）

### 场景一：你正在 cfuse 内置窗口里跑命令

直接用原生命令，**不用加任何 carrier 参数**：

```bash
cd <你的项目>
hopjit install-skill --demo            # 内置 cc 窗口
hopjit install-skill --carrier codex --demo   # 内置 codex 窗口
```

为什么不用指定 cfuse：cfuse 启动内置引擎时会设好环境变量（内置 cc 设 `CLAUDE_CONFIG_DIR`、内置 codex 设 `CODEX_HOME`，都指向 `~/.codefuse/engine/` 下对应目录），install-skill 读这两个官方变量自动装到正确的家。

### 场景二：你在普通终端里预装（cfuse 还没启动）

这时环境变量不在场，**必须显式声明装给谁**：

```bash
cd <你的项目>
hopjit install-skill --carrier cfuse-cc --demo      # 装给 cfuse 内置 cc
hopjit install-skill --carrier cfuse-codex --demo   # 装给 cfuse 内置 codex
```

**不加 carrier 的后果**：会装到原生的 `~/.claude/`，cfuse 内置 cc 读不到——命令显示成功、cfuse 里却找不到 skill，这是最容易白忙一场的错法。

生成布局（以 cfuse-cc 为例）：

```
~/.codefuse/engine/cc/skills/hopspec/     ← 驱动 skill（cfuse 内置 cc 读取）
<项目根>/.claude/skills/demo-coffee-week/  ← demo 恒项目级（演示材料跟项目走）
```

## 第 2 步：触发（与原生完全一致）

打开 cfuse 的引擎窗口，触发方式跟原生一模一样：

- 内置 cc 窗口：`/demo-coffee-week` 或 `/hopspec run examples/data-quality.md`
- 内置 codex 窗口：`$demo-coffee-week` 或 `$hopspec run examples/data-quality.md`

你看到的执行节奏也一样：参数确认 → 执行 → 介入点问人 → 终态报告。spec 文件三个载体通用，不用改一个字。

## 第 3 步（可选）：独立模式的 MCP 注册

任务跑得久、想换轻量 API 模型省成本时，可以配独立模式（执行搬进 server 进程）。注册命令：

```bash
hopjit install-skill --mcp                        # 内置窗口里跑,自动落对位置
hopjit install-skill --mcp --carrier cfuse-cc     # 普通终端预配,显式声明
hopjit install-skill --mcp --carrier cfuse-codex
```

落点规则与第 1 步同理：

- **cfuse 内置 cc**：写项目根 `.mcp.json`（与原生 CC 完全一致——cfuse-cc 是 CC 套壳，项目级注册两边通用）；
- **cfuse 内置 codex**：写 `~/.codefuse/engine/codex/config.toml`（**不是** `~/.codex/config.toml`——普通终端预配时尤其注意，写错文件 cfuse 读不到）。

配置详情（providers/凭证/模型分档）见 `USAGE.md` §6——cfuse 两段专门说明就在 Claude Code 与 Codex 注册格式之后。

## 常见问题

| 症状 | 处置 |
|---|---|
| 窗口里 `/hopspec`、`$hopspec` 都不认 | 先确认你在哪个形态：cfuse 自有 agent 窗口**尚未适配**，切到内置 cc 或内置 codex 窗口再试 |
| cfuse 窗口里找不到 skill | 十有八九装错了家：普通终端装的时候没加 `--carrier cfuse-*`，装到 `~/.claude/` 或 `~/.codex/` 去了。用 `--carrier cfuse-cc`（或 `cfuse-codex`）`--force` 重装，然后重启 cfuse 窗口 |
| 分不清窗口里该用 `/` 还是 `$` | 看引擎：内置 cc 用 `/hopspec`，内置 codex 用 `$hopspec`。触发前缀跟引擎走，不跟 cfuse 走 |
| MCP server 注册了但窗口里不可用 | 内置 codex 检查写的是不是 `~/.codefuse/engine/codex/config.toml`（不是 `~/.codex/`）；内置 cc 检查项目根 `.mcp.json` 有没有 hopjit 条目；改完重启窗口 |
| 找不到引擎 | `npm i -g @hoplogic/hopjit`；确认全局 bin 目录在 PATH 里 |
| 想确认到底装到哪了 | `ls ~/.codefuse/engine/cc/skills/`（或 `codex/skills/`）看 hopspec 目录在不在——在哪个家一目了然 |

## 下一步

主线顺序读（与 CC/Codex 用户同一条线）：[[02-读懂一份spec]] → [[03-探索与提交]] → [[D10-hop_python计算体]] → [[05-并行与遍历]] → [[06-实战-事实核查器]] → [[07-升级你的自然语言skill]]。凡教程里出现"Claude Code 命令 / Codex 命令"并排代码框的地方，按你的内置引擎抄对应那个即可。
