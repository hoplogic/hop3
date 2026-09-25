%% @trace
	id: hopjit-tutorial-opencode
	source: [[../design/opencode-driver-carrier]]
	source_id: hopjit-opencode-driver-carrier
	type: compact
	last_sync: 2026-09-20T10:40+0800
	note: 教程 1 opencode 版——第四载体入口,与 CC/Codex/cfuse 版平列（opencode 真适配批+hop 补装批后补引导链:教程/README/USAGE 三面此前零覆盖或口径过时,作者抓"tutorial 还没写?"）。安装与驱动机制源=opencode-driver-carrier（原语映射/装载布局）;真机 E2E 两轮已验（v1.18.31+deepseek,coffee-week 全链）。
%%

# 教程 1（opencode 版）· 第一次运行

> 用 Claude Code 的读 [[01-第一次运行-ClaudeCode]]，用 Codex 的读 [[01-第一次运行-Codex]]，用 cfuse 的读 [[01-第一次运行-cfuse]]。之后的教程 02-07 各载体通用。

**目标**：在 opencode 里从零装到跑通一个 spec。
**前提**：装有 Node.js ≥ 18 和 opencode（`npm i -g opencode-ai`，或官方安装脚本），且 opencode 已配好可用的模型（`opencode run "hi"` 能答就行）。

> ✅ 状态（2026-09-20）：opencode 载体复用模式真机 E2E 通过（v1.18.31，coffee-week 全链含 ask 介入点闭环）。MCP 独立模式壳已装载、真机验证待补。

## 与 Claude Code 版的差异：同语义、分载体

三个载体驱动的是**同一个引擎、同一份 spec、同一组执行语义**——spec 文件不用改一个字。不同的只是载体侧的交互原语：

| | Claude Code 载体 | opencode 载体 |
|---|---|---|
| 安装位置 | `~/.claude/skills/` | `~/.config/opencode/skills/`（XDG 规范；`OPENCODE_CONFIG_DIR` 在场则优先） |
| 触发方式 | `/hopspec` 斜杠命令 | 隐式触发——直接说"用 hopspec 执行某某 spec"，opencode 按 skill 描述自动装载 |
| 问人 | AskUserQuestion 组件 | `question` 内置工具（同样是选项列表+可自由输入） |
| 执行段承载 | driver subagent 外包 | 内置 subagent（General）外包；无 subagent 能力时主对话自己跑，语义不变 |

## 第 1 步：安装引擎与 skill

```bash
npm install -g @hoplogic/hopjit
hopjit install-skill --carrier opencode --demo
```

装出六件 skill 到 `~/.config/opencode/skills/`：`hopspec`（跑 spec 的缺省入口）、`hopspec-mcp`（独立模式薄壳）、`hop`（日常任务管护）、`hopbuild`/`hopbuild2`（自然语言 skill 翻译器）、`hopfix`（定向修正器）；`--demo` 另装演示件到项目 `.claude/skills/`（opencode 主动兼容该路径，演示材料跟项目走）。

验证装载：

```bash
opencode run "列出你可用的全部 skill 名字,一行一个"
```

清单里出现 hopspec/hop/hopbuild 即成功。

## 第 2 步：跑第一个 spec

把引擎自带的示例拷到工作目录（或用你自己的 spec）：

```bash
cd <你的项目>
cp "$(npm root -g)/@hoplogic/hopjit/examples/coffee-week.md" .
cp "$(npm root -g)/@hoplogic/hopjit/examples/coffee-sales.json" .
opencode run "用 hopspec skill 执行 coffee-week.md,参数 sales_data_path=coffee-sales.json"
```

你会看到的节奏：参数确认 → 执行段交给 subagent 跑 → 执行到 spec 里的 `[ask]` 步骤时**停下来问你**（本例会让你确认周营业目标）→ 你回答后继续 → 终态输出一个 `status: completed` 的 YAML 块（全部交付物原样在内）。

停下来问你不是礼貌，是 **spec 作者用 `[ask]`/`[confirm]` 显式声明的**——作者说这里必须人拍板，引擎就强制停，模型无权替答。这就是"人机协同写进结构"。

多轮对答用 opencode 的会话续接：`opencode run -c "你的回答"`（`-c` 继续上一会话）。

## 第 3 步：知道差异在哪（免得误判为 bug）

- **没有斜杠命令**：opencode 的 skill 靠描述隐式触发——不用敲 `/hopspec`，直接说"执行这份 spec""跑一下 coffee-week"即可；显式点名 skill 名（"用 hopspec skill…"）触发更稳；
- **装出的 skill 文档是 opencode 自包含的**：`~/.config/opencode/skills/` 里的驱动指令写的是 question 工具、subagent 这些 opencode 原生机制——如果你在里面看到 AskUserQuestion、task-notification 这类 Claude Code 术语，说明装的是旧版（0.16.0 及以前的版本装的是未适配件），升级 hopjit 后 `--carrier opencode --force` 重装；
- **并行步骤按顺序执行**：spec 里的 parallel 标注在 opencode 上当前按顺序跑（结果与并行一致），多个活依次完成——不是卡住，等它跑完。

## 常见问题

| 症状 | 处置 |
|---|---|
| opencode 不认 skill | `ls ~/.config/opencode/skills/hopspec/SKILL.md` 确认在场；设过 `OPENCODE_CONFIG_DIR` 的确认装到了它指的目录（install-skill 读同一变量，两边一致才对上） |
| 找不到引擎 | `npm i -g @hoplogic/hopjit`；确认全局 bin 在 PATH 里 |
| 执行中它自己回答了该问你的问题 | 确认装的是适配版（见第 3 步第二条）——旧版驱动件对问人协议无保证 |
| validate 报 errors | 按提示修 spec——errors 挡执行，warnings 不挡 |
| 想干净重跑 | 不要 `rm -rf .hopstate`——每次 run 自建独立实例目录；要隔离就换 `--state-dir` 名 |

## 可选：独立模式（长任务转它）

任务跑得久、想换轻量 API 模型省成本时，配置一次独立模式（执行搬进 hopjit MCP server 进程）：

```bash
hopjit install-skill --mcp --carrier opencode
```

这一条做两件事：把 hopjit MCP server 注册进 `~/.config/opencode/opencode.jsonc`（保留你文件里的注释与格式）；并从 opencode 的配置里学习你的模型设置自举 standalone 缺省配置（只记凭证的环境变量名，不抄值）。配置详情见 `USAGE.md` §6。同一份 spec 两种模式通用，零修改。

注意：装出来的 `mcp.hopjit` 条目**默认是 `enabled: false`**——这是有意的：防止模型在复用模式（hopspec skill）下看到 hopjit 的 MCP 工具就自作主张去调独立模式工具，劫持本该走复用协议的执行。所以要真走独立模式，先打开 `~/.config/opencode/opencode.jsonc`，把 `mcp.hopjit.enabled` 改成 `true`，再对 opencode 说"用 hopspec-mcp 跑某某 spec"。

## 下一步

主线顺序读（与其他载体用户同一条线）：[[02-读懂一份spec]] → [[03-探索与提交]] → [[D10-hop_python计算体]] → [[05-并行与遍历]] → [[06-实战-事实核查器]] → [[07-升级你的自然语言skill]]。凡教程里"Claude Code 命令 / Codex 命令"并排代码框处，opencode 用户按 CC 那框的语义换成对 opencode 说话即可（斜杠命令换成直接描述）。

- 载体内部机制（原语映射、复用判据、准入规则）：`docs/design/opencode-driver-carrier.md`（开发者向）。
