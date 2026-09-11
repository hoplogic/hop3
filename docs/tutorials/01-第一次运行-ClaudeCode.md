%% @trace
	id: hopjit-tutorial-first-run
	source: [[../../USAGE]]
	source_id: hopjit-usage
	type: extend
	last_sync: 2026-08-30T13:41+0800
	note: 新手教程 1——从安装到在 CC 里跑通第一个 example spec 的完整实操（USAGE 是速查，本文是带预期输出的手把手版）
%%

# 教程 1（Claude Code 版）· 第一次运行

> 用 Codex 的读平行版 [[01-第一次运行-Codex]]。之后的教程 02-07 两个载体通用——凡涉载体命令处都并排给出"Claude Code 命令"与"Codex 命令"两个代码框，抄你自己那个。

**目标**：30 分钟内，从零安装到亲眼看着一个 spec 在 Claude Code 里被引擎驱动执行完。
**前提**：装有 Node.js ≥ 18 和 Claude Code；**不需要任何 API key**（复用模式下 Claude Code 自己就是推理引擎）。

## 第 1 步：安装引擎

```bash
npm install -g @hoplogic/hopjit
hopjit --version
```

看到版本号即成功。记住三层命名：**包**叫 `@hoplogic/hopjit`（安装用），**命令**叫 `hopjit`（执行用），它跑的是包内 `dist/cli.js`。

## 第 2 步：装 skill

```bash
hopjit install-skill --demo
```

输出 `status: ok`（YAML 格式——CLI 缺省输出给人看的 YAML；机器/脚本用 `--json`）。**重启 Claude Code**（或新开会话），输入 `/` 应能看到三个 skill 补全：

- `/demo-coffee-week` —— `--demo` 附装的演示 skill（下一步就用它；不想装 demo 就去掉 `--demo`。demo 件统一 `demo-` 前缀，好认也好整批删）
- `/hopspec` —— 驱动引擎执行任意 spec（通用驱动，本篇后半主角）
- `/hopbuild` —— 把自然语言 skill 翻译成 HopSpec（见 [[07-升级你的自然语言skill]]）

> 进阶：`--plus` 会另装两个真正干活的研究件 `/hop-fact-check`（事实核查）与 `/hop-deep-research`（深度研究），并自动把它们要用的检索/浏览器工具配置并入 `~/.hopjit/config.yaml`——装完只差一个 `export DASHSCOPE_API_KEY=<百炼key>`。首跑先不用管它，跑通 demo 后想上真活再回来加。

## 第 3 步：最短首跑——对话里说 `/demo-coffee-week`

什么都不用准备（演示数据已打包在 skill 里），直接输入：

```
/demo-coffee-week
```

它会向你确认两个参数（演示数据与周目标都有现成默认，一路确认即可），然后交给引擎执行，最后给你一份咖啡店周报。**这就是 hopskill 的产品形态**：用户拿到的是一个具名能力，spec、引擎、驱动协议全是实现细节——你刚才没看到它们，这是有意的。

下面转入技术视角：这个能力是怎么由一份 spec 定义、怎么被引擎驱动的。

## 第 4 步：拿一个现成的 spec（技术视角）

克隆本仓库（examples 未随 npm 包发布）：

```bash
git clone <本仓库地址> hoplogic && cd hoplogic
```

先用 CLI 看看哪些 spec 可执行：

```bash
hopjit list examples
```

本篇用 `examples/coffee-week.md`（npm 包内随发同路径副本——没 clone 仓库、任意目录也能跑，演示数据 `examples/coffee-sales.json` 同包）——一家咖啡店的周报：统计一周营业数字 → 判断经营状态 → 组装周报 → 核验。先花两分钟读一下它，注意三样东西：

1. **`## Inputs`**：`daily_sales`（7 天营业额）和 `weekly_target`（周目标）——运行时要提供的参数（演示数据已备好，注释里写着）；
2. **步骤类型**：`[act]` 是无推理的确定性计算（带 `hop_python` body，**引擎自己算，连 LLM 都不经过**——sum/max/min 这些数字跑一万次都一样），`[reason]` 是交给 LLM 的推理步（判断经营状态、给建议——这才是该动脑的地方）——**谁推理、谁计算，spec 里写得明明白白**，这就是 HopSpec 的核心：把该锁死的锁死，把该智能的留给智能；
3. **数据流**：`← x` 是读入，`+ → y: type` 是产出——变量怎么在步骤间流动一目了然。

执行前先过校验闸门（任何 spec 都建议先跑这个）：

```bash
hopjit validate examples/coffee-week.md
# → status: ok（YAML；错误时 errors 列表逐条列出）
```

## 第 5 步：用通用驱动跑（`/hopspec run`）

第 3 步的 `/demo-coffee-week` 内部委托的就是这条通用驱动——任何 spec 都能这样跑，不用先 pack 成具名 skill。在仓库目录里打开 Claude Code，输入：

```
/hopspec run examples/coffee-week.md
```

接下来会发生什么（对照着看，别慌）：

1. **参数确认**——skill 读 `## Inputs`，按注释找到同目录演示数据直接采用（零选择题），你只需确认一次；
2. **执行段外包**——主对话会起一个 subagent 去跑执行循环（这是有意设计：机械的逐步执行不污染你的主对话上下文），你看到的是一行行介入点粒度的进度；
3. **终态**——完成后以 YAML 结构化回报（`status: completed` + 完整 `weekly_report`），一份店主能直接看的周报。

执行状态全程落在 `.hopstate/` 目录（已建议 gitignore）。两个随时可用的命令：

```
/hopspec status    # 看进度
/hopspec resume    # 从中断处恢复（比如 Claude Code 会话断了）
```

## 第 6 步：体验人机介入点（HopSpec 的灵魂）

coffee-week 是全自动的。换一个**会停下来问你**的：

```
/hopspec run examples/doc-review.md
```

这个 spec 里有 `[ask]` 步骤（确认文档定位、选评审模式）——执行到那里引擎会**暂停**，Claude Code 把问题和候选项呈给你，你选完才继续。注意两点：

- 停下来问你不是 Claude Code 的礼貌，是 **spec 作者用 `[ask]`/`[confirm]` 显式声明的**——作者说这里必须人拍板，引擎就强制停，LLM 无权替答；
- 这就是"人机协同写进结构"：哪里全自动、哪里必须问人，是 spec 的一部分，不靠运气。

## 常见问题

| 症状 | 处置 |
|---|---|
| `/hopspec` 不在列表 | 确认 install-skill 输出 ok；**重启 Claude Code** |
| skill 说找不到引擎 | `npm i -g @hoplogic/hopjit` 装好重试（skill 用 `command -v hopjit` 一条命令定位，找不到即报错，不做多级探测） |
| validate 报 errors | 按提示修 spec——errors 挡执行，warnings 不挡 |
| 想干净重跑 | 不要 `rm -rf .hopstate`——每次 run 自建独立实例目录，旧实例不干扰；实在想隔离就换 `--state-dir` |

## 下一步

主线顺序读：[[02-读懂一份spec]]（地基：五分钟建立全景）→ [[03-探索与提交]] → [[D10-hop_python计算体]] → [[05-并行与遍历]] → [[06-实战-事实核查器]] → [[07-升级你的自然语言skill]]。

- 任务变长变频后想省对话额度、换轻量模型：独立模式（standalone）——配置一次后用 **`/hopspec-mcp run`** 跑（`/hopspec` 恒复用模式，两命令并存名字即模式），配置步骤见 `USAGE.md` §6、取舍详见 [[D8-模型与工具配置]] 开头；
- 语法完整参考：`docs/concepts/HopSpec V3语法参考.md`；引擎内幕：`ARCHITECTURE.md`。
