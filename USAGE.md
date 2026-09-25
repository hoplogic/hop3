# HopJIT 上手指南

从零到在 Claude Code 里跑通第一个 HopSpec。

> 本页是速查版；想要带预期输出的手把手教程（含 Codex、自然语言 skill 升级），看 `docs/tutorials/`（从 01 开始）。

> **HopJIT 是什么**：HopSpec v3 的执行运行时。你用结构化 markdown（HopSpec）声明任务的步骤/数据流/循环分支/人机介入点，HopJIT 管执行状态、变量、retry/自适应修复、并行调度。外层 LLM（Claude Code / Codex）当推理引擎——**复用模式下不需要 API key**。

---

## 1. 安装

```bash
npm install -g @hoplogic/hopjit
hopjit --help          # 确认命令可用
```

三层命名（避免困惑）：装的**包**叫 `@hoplogic/hopjit`，得到的**命令**叫 `hopjit`，它执行包内的 `dist/cli.js`。

## 2. 装 skill 进 Claude Code

复用模式靠 skill 驱动。零参数即装到用户级（所有项目可用）：

```bash
hopjit install-skill
```

输出 `status: ok`（YAML，人可读；脚本化用 `--json` 得单行 JSON）即成功，`~/.claude/skills/` 下生成：

```
~/.claude/skills/
├── hopspec/
│   ├── SKILL.md          # 主 skill（/hopspec）
│   └── references/       # 驱动细则（自举探测、并行 worker 等）
└── skills/hopbuild/       # /hopbuild：自然语言 skill → HopSpec
    └── SKILL.md
```

**重启 Claude Code**（或新开会话），`/hopspec` 和 `/hopbuild` 就在 skill 列表里了。

> 只想给单个项目装：`hopjit install-skill --dir .claude/skills`（写当前项目）。
> Codex 载体：`hopjit install-skill --carrier codex`（缺省装用户级 `~/.codex/skills/`，装一次全项目可用——与 CC 对称）；要装项目级用 `--dir <项目根>/.agents/skills`（--dir 语义=skills 根目录）。注意 Codex 同名 skill 项目级优先于用户级——旧项目级残留会盖住用户级新版，装置器会检测并提示。
> cfuse 内置载体：cfuse 内置窗口表现为原生 Claude Code 或 Codex,按该载体的原生命令跑即可（环境变量 `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 自动装到 `~/.codefuse/engine/{cc,codex}/skills/`）。裸终端预装（目标 agent 未启动）用显式 carrier:
>   - `hopjit install-skill --carrier cfuse-cc`（装到 `~/.codefuse/engine/cc/skills/`——cfuse 内置 cc 读取的目录）
>   - `hopjit install-skill --carrier cfuse-codex`（装到 `~/.codefuse/engine/codex/skills/`——cfuse 内置 codex 读取的目录）
> OpenCode 载体：`hopjit install-skill --carrier opencode`（装到 `~/.config/opencode/skills/`——opencode 原生发现路径,`OPENCODE_CONFIG_DIR` 在场则优先;驱动件为 `driver/opencode/` 适配版——question 工具问人/subagent 外包,非 CC 原文,2026-09-19 真适配批起）。`--mcp` 注册写用户级 `~/.config/opencode/opencode.jsonc`（缺省;已有 opencode.json/config.json 则写检测到的那份）的 `mcp.hopjit`（`type:"local"` + `command` 数组 + `environment` 留空靠进程环境透传凭证）。装出的条目**默认 `enabled: false`**（防模型在复用模式下误调独立模式工具）——要走 standalone,先把该值改 `true` 再用。
> 想覆盖已装的：加 `--force`。
> 想要开箱演示：加 `--demo`——附装全部演示 skill（统一 `demo-` 前缀防撞名）：CC 为 `/demo-coffee-week`（入门周报）与 `/demo-fact-check`（事实核查，只核一级事实的简化版），Codex 为 `$demo-*` 同名；演示数据均打包在 skill 内。

## 3. 跑通第一个 spec

### 3a. 先校验 spec 合法

任何 spec 执行前都该过校验闸门：

```bash
hopjit validate my-spec.md
# → status: ok / errors: [] / warnings: [...]（YAML；--json 可切单行 JSON）
```

`errors` 非空则不可执行——按提示修（规则覆盖结构/控制流/变量/步骤四类）。

### 3b. 在 Claude Code 里驱动执行

```
/hopspec run my-spec.md
```

Claude Code 作为主 agent 会：
1. **定位 spec + 组装参数**——读 spec 的 `## Inputs`，推断参数值，问你确认。
2. **驱动执行**——把执行段外包给 subagent 跑，主对话只在**介入点**停：
   - `ask`/`confirm`（spec 里的人机介入点）→ 停下问你
   - `parallel`（并行步）→ 起多个 worker 并发跑
   - 完成/失败 → 报终态
3. 全程状态存在 `.hopstate/`，可 `/hopspec status` 查、`/hopspec resume` 从中断恢复。

带参数直接跑：

```
/hopspec run my-spec.md --params '{"raw_data": "...", "quality_threshold": 0.8}'
```

## 4. 把现有自然语言 skill 转成 HopSpec

如果你有自然语言写的 skill（靠 LLM "记住"纪律，易漏步/跳审核），转成 HopSpec 让引擎强制这些纪律：

```
/hopbuild
```

它按三个正确性焦点翻译：循环遍历不漏（for-each）、审核不跳过（confirm/check）、试错不做不可逆操作（act 可逆 / commit 隔离）。产出的 `.md` 可直接 `/hopspec run`。

## 5. CLI 命令速查

日常主要用 `validate`（校验）；`run`/`status`/`resume` 通常由 skill 在 Claude Code 里驱动，不手敲：

| 命令 | 用途 |
|------|------|
| `hopjit validate <spec>` | 校验 spec 合法性（执行前闸门） |
| `hopjit list <dir>` | 列目录下可执行 spec |
| `hopjit install-skill [--dir] [--carrier cc\|codex\|cfuse-cc\|cfuse-codex\|opencode] [--demo]` | 装驱动 skill 到 Claude Code / Codex / OpenCode（原生或 cfuse 内置;`--demo` 附装演示 skill） |
| `hopjit run <spec> [--params]` | 启动执行（复用模式一般由 skill 调） |
| `hopjit status` / `resume` | 查进度 / 从中断恢复 |

其余（`init`/`submit_and_fetch_next`/`join_parallel`/`fanout-plan`/`fanout-next`/`debug_step`/`vars`）是驱动层内部命令，手工基本用不到。

## 6. 两种模式：先用复用入门，长任务转独立

| | 复用模式（reuse） | 独立模式（standalone） |
|---|---|---|
| 推理谁做 | 外层 LLM（Claude Code / Codex 本身） | HopJIT 引擎直调 LLM API |
| 需要配置 | **零**——装好 skill 即用 | 一份 `~/.hopjit/config.yaml` + 在载体注册 MCP server |
| 成本 | 用你对话模型的额度（模型即对话所用，无从选择） | **可换轻量模型**（如 deepseek-chat）——长任务省一个量级 |
| 沙箱/工具 | 载体的完整工具面（读写文件、跑命令都行） | 引擎内置工具集（受限但独立——不依赖载体沙箱策略） |
| 执行位置 | 你的对话会话里（占上下文；会话断了要 resume） | 独立 server 进程（不占对话；你只在需要确认时被叫回来） |
| 适合 | 入门、调试、需要载体工具的 spec | 跑得久、跑得频、纯推理+计算类任务 |

**路径建议**：从复用模式开始（零配置，`/hopspec run` 即用）；当任务变长、变频、或想换便宜模型时，配一次独立模式——同一份 spec 一个字不用改。

**独立模式配置（一次性）**：

1. 写 `~/.hopjit/config.yaml`（key 不进文件，只写环境变量名；模型分档/工具注册等全部字段见 `docs/reference/配置参考.md`）：

```yaml
providers:
  - service_id: deepseek
    protocol: anthropic
    base_url: https://api.deepseek.com/anthropic
    model: deepseek-chat
    api_key_env: DEEPSEEK_API_KEY
```

2. 在载体注册 hopjit MCP server，并用 `hopjit install-skill --mcp` 装上 MCP 壳——之后**用 `/hopspec-mcp run` 走独立模式**（`/hopspec` 恒复用模式，两命令并存：**名字即模式**，没有运行时自动切换）：

**Claude Code**（项目 `.mcp.json`）：

```json
{ "mcpServers": { "hopjit": { "command": "hopjit-mcp" } } }
```

> 不用指配置路径——server 自动读 `~/.hopjit/config.yaml`（系统级）＋ 项目根 `hopjit.yaml`（项目级，可选）并逐节合并。`HOPJIT_CONFIG` 环境变量是显式覆盖（只用指定文件、**不再合并两级**），留给测试等特殊场景。

> **cfuse 内置 cc**：注册格式与上面 Claude Code 完全一致（cfuse-cc 是 CC 套壳，`.mcp.json` 同为项目级，不用另写）。`hopjit install-skill --mcp` 会自动写入 `.mcp.json`。carrier 规则同 §2：在 cfuse 内置窗口里跑不用加 `--carrier`（`CLAUDE_CONFIG_DIR` 自动适配到 `~/.codefuse/engine/cc/`）；在普通终端里跑要加 `--carrier cfuse-cc`，否则会装到 `~/.claude/` 而 cfuse 读不到。

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.hopjit]
command = "hopjit-mcp"
env_vars = ["DEEPSEEK_API_KEY"]          # codex 不继承 shell 环境,凭证按名转发
required = true
startup_timeout_sec = 30
default_tools_approval_mode = "auto"
```

> ⚠️ Codex + DeepSeek 模型用户：先看 `docs/WORKAROUNDS.md` W-1（上游 bug 会让 MCP 工具静默不可用，需给 model catalog 打一行补丁）。

> **cfuse 内置 codex**：注册格式同上，但 `hopjit install-skill --mcp` 会写到 cfuse-codex 的 home（`~/.codefuse/engine/codex/config.toml`，不是 `~/.codex/`）。carrier 规则同 §2：在 cfuse 内置窗口里跑不用加 `--carrier`（`CODEX_HOME` 自动适配）；在普通终端里跑要加 `--carrier cfuse-codex`。

## 常见问题

- **`hopjit` 命令找不到**：确认 `npm i -g @hoplogic/hopjit` 成功；全局 bin 目录在 PATH 里。
- **`/hopspec` 不在 skill 列表**：确认 `hopjit install-skill` 跑成功（缺省装到 `~/.claude/skills`，全项目可用），并**重启 Claude Code**。
- **skill 找不到引擎**：skill 用 `command -v hopjit` 一条命令定位——找不到即报错，按提示 `npm i -g @hoplogic/hopjit` 装好重试（不做多级目录探测）。
- **spec 范本**：项目仓库 `examples/`（data-quality / doc-review / fact-check / parallel-* 等），未随 npm 包发布，去仓库看。

---

更多：`README.md`（速览）· HopSpec v3 语法权威见项目概念层文档（HopSpec V3 核心规范）。
