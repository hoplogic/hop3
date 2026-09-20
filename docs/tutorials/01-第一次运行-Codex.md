%% @trace
	id: hopjit-tutorial-codex
	source: [[../design/codex-driver-carrier]]
	source_id: hopjit-codex-driver-carrier
	type: compact
	last_sync: 2026-08-30T13:41+0800
	note: 教程 1 Codex 版——双载体入口之一,与 CC 版平行（安装发现+delegated 全程 E2E 已真机验证 2026-08-05；inline 待配置修正后重验）
%%

# 教程 1（Codex 版）· 第一次运行

> 用 Claude Code 的读平行版 [[01-第一次运行-ClaudeCode]]，用 cfuse（CodeFuse）的读 [[01-第一次运行-cfuse]]，用 opencode 的读 [[01-第一次运行-opencode]]。之后的教程 02-07 各载体通用——凡涉载体命令处都并排给出"Claude Code 命令"与"Codex 命令"两个代码框，抄你自己那个（cfuse 用户按内置引擎选）。

**目标**：在 Codex CLI 里从零装到跑通一个 spec。
**前提**：装有 Node.js ≥ 18 和 Codex CLI。先 `npm install -g @hoplogic/hopjit` 装引擎、`git clone` 本仓库（同 CC 版第 1、4 步——那两步载体无关）。

> ✅ 状态（2026-08-10）：Codex 载体全部执行路径真机 E2E 通过——delegated（subagent 交接）、inline（弱模型直驱）、独立模式（MCP server）三路全绿，含 HITL 介入闭环。验收凭证见 `.e2e-evidence/`。

## 与 Claude Code 版的差异：同语义、分载体

两个载体驱动的是**同一个引擎、同一份 spec、同一组执行语义**——spec 文件不用改一个字。不同的只是载体侧的编排原语：

| | Claude Code 载体 | Codex 载体 |
|---|---|---|
| 安装位置 | `~/.claude/skills/hopspec/` | `~/.codex/skills/hopspec/`（用户级,装一次全项目可用） |
| 触发前缀 | `/hopspec` | `$hopspec` |
| 执行段承载 | driver subagent（外包执行循环） | 有 subagent 能力时同构外包；没有时 Main 自己跑（inline），语义不变 |
| 问人 | AskUserQuestion 组件 | Codex 对话内直接问答 |

## 第 1 步：安装

装到你要跑 spec 的项目根：

```bash
cd <你的项目>
hopjit install-skill --carrier codex --demo
```

生成布局：

```
~/.codex/skills/hopspec/
├── SKILL.md                    # main orchestrator：启动交互/介入点/终态
├── agents/
│   └── segment-driver.md       # 执行段（连续 reason/act/check 循环）
└── references/                 # discovery / execution-rules 等执行细则

<项目根>/.agents/skills/demo-coffee-week/   ← demo 恒项目级(演示材料跟项目走)
├── SKILL.md                    # $demo-coffee-week 具名演示入口
├── spec.md
└── coffee-sales.json
```

> 进阶：`--plus` 另装两个研究件 `$hop-fact-check` / `$hop-deep-research`（同为项目级），并把所需检索/浏览器工具配置并入 `~/.hopjit/config.yaml`——之后只差 `export DASHSCOPE_API_KEY=<百炼key>`。首跑先跳过。

## 第 2 步：触发

Codex 按 skill 的 description 隐式触发，也可用 `$` 显式调用：

```text
$demo-coffee-week
```

这条是最短首跑。通用驱动入口仍是：

```
$hopspec run examples/data-quality.md
```

main orchestrator 会先定位 hopjit CLI（`command -v hopjit` 一条命令，找不到即报错），再按当前环境自动选择执行方式（有 subagent 能力就外包执行段，没有就自己跑；注册了 hopjit MCP server 则整体转独立模式——见下）。无论哪种，你看到的节奏都一样：参数确认 → 执行 → 介入点问人 → 终态报告。

## 第 3 步：知道差异在哪（免得误判为 bug）

- **空 stdout 不猜**：推进型 CLI 命令若没有返回可解析 JSON，driver 立即停止并报告 `DRIVER_PROTOCOL_ERROR`，不会根据 spec 或文件名猜下一步；
- **resume 仅用于崩溃恢复**：正常介入点续接走 main 与执行 agent 之间的结构化交接，不走 resume——别在正常流程里手动 resume；
- **载体内文档是自包含的**：`~/.codex/skills/hopspec/` 里没有任何 Claude Code 术语（AskUserQuestion、task-notification 等），如果你在里面看到了，说明装到了错的载体，用 `--carrier codex` 重装。

## 常见问题

| 症状 | 处置 |
|---|---|
| Codex 不触发 skill | 确认 `~/.codex/skills/hopspec/SKILL.md` 存在且第一行是 `---`（旧项目级 `.agents/skills/hopspec/` 残留会盖住用户级——同名项目级优先,确认后删除残留）；显式调用 `$hopspec run …`，仍未出现时重启 Codex |
| `$demo-coffee-week` 不出现 | 用 `hopjit install-skill --carrier codex --demo --force` 重装；也可输入 `/skills` 从列表选择 |
| 找不到引擎 | `npm i -g @hoplogic/hopjit`；或项目内 `npm i @hoplogic/hopjit` |
| parallel 好像"卡住" | 对话驱动模式下并行步骤当前按顺序执行（结果一致），多个活依次完成后才继续——等它跑完即可 |

## 可选：独立模式（长任务转它）

任务跑得久、跑得频、或想换轻量模型省成本时，配置一次独立模式：执行搬进独立 server 进程（不占你对话上下文），推理换成你指定的 API 模型（如 deepseek-chat）。配置步骤与两模式取舍详表见 `USAGE.md` §6；**Codex + DeepSeek 模型用户须先看 `docs/WORKAROUNDS.md` W-1**（上游 bug 补丁）。同一份 spec 两种模式通用，零修改。

## 下一步

主线顺序读（与 CC 用户同一条线）：[[02-读懂一份spec]] → [[03-探索与提交]] → [[D10-hop_python计算体]] → [[05-并行与遍历]] → [[06-实战-事实核查器]] → [[07-升级你的自然语言skill]]（注：07 的翻译器 /hopbuild 目前仅 CC 载体提供，Codex 用户可在 CC 里翻译、产物两载体通用）。

- 载体内部机制（角色拆分、交接协议）：`docs/design/codex-driver-carrier.md`（开发者向）。
