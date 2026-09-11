%% @trace
	id: hopjit-workarounds
%%

# 外部环境 Workaround 登记

> 本文档登记**外部载体/工具链的缺陷**及我们采取的绕行措施——问题不在 HopJIT 自身，修复主权在上游。每条记录：症状 → 根因 → workaround → 撤销条件。换机、升级载体版本、或新人接手时先读本文。
>
> 与设计文档的分工：设计契约（`docs/design/`）记录**协议层如何适配**（那是我们自己的形态决策）；本文记录**环境层打了什么补丁**（上游修复后应撤销的东西）。

---

## W-1 Codex + DeepSeek catalog：MCP 工具静默不可达

**登记**：2026-08-10 · **载体版本**：codex-cli 0.146.0 · **上游 issue**：[openai/codex#36382](https://github.com/openai/codex/issues/36382)（Open，无官方修复）

### 症状

- 用 `-p deepseek-v4-flash`（或任何经 `model_catalog_json` 注册的 DeepSeek 模型）起 codex 会话时，**所有已注册 MCP server 的工具都不在模型工具面**——`mcp__hopjit__*`、`mcp__deepwiki__*` 一律不可调；
- 无任何报错：server 正常启动、`codex mcp list` 显示 enabled、`/mcp` 看得到连接——只有模型侧调不着；
- 同一注册块换默认模型（openai/gpt-5.6-sol）立即可调。

**误导性极强**：模型如实报告"工具列表里没有它"，极易误判为注册失败、skill 失效或模型幻觉（本库排查时曾三轮修错层——先怀疑 NL skill、再怀疑注册通道，最后才定位到 catalog）。

### 根因（三层联动）

DeepSeek 官方脚本生成的 `~/.codex/deepseek-models.json` 中：

| 字段 | 值 | 效果 |
|---|---|---|
| `supports_search_tool` | `true` | codex 把全部 MCP 工具注册为 **Deferred**（延迟加载，藏在 `tool_search` 后） |
| `tool_mode` | `null` | 无 code-mode 容器 → `tool_search` 入口本身不存在 |

发给模型的工具清单只含 Direct 工具 → Deferred 工具被排除，而唤出它们的钥匙（`tool_search`）又没有——**工具被藏起来了，钥匙没给**。

### `supports_search_tool` 究竟是什么、改 false 意味着什么

该字段声明的是：**这个模型是否支持 `tool_search` 内建工具**。`tool_search` 与 `web_search` 是两个并列的不同工具（codex 内部工具命名空间中两者分列）：

- **`web_search`** = 搜互联网，由 catalog 的 `web_search_tool_type` 字段管（flash 该字段为 `"text"`，本补丁不动它，网页搜索不受影响）；
- **`tool_search`** = 搜**工具目录**——会话里可用工具很多时（尤其装了大量 MCP server 的场景），codex 不把全部工具 schema 塞进模型上下文，只给一个 `tool_search` 入口，模型按需搜"有没有干 X 的工具"、搜到再加载调用。这是**上下文优化机制**（工具清单占 token）。

codex 对 MCP 工具的暴露方式由此二选一：

| `supports_search_tool` | MCP 工具的处境 |
|---|---|
| `true` | 全部 **Deferred**（延迟）——不进模型工具清单，等模型用 `tool_search` 搜索加载 |
| `false` | 全部 **Direct**（直接）——启动时直接列进模型工具清单 |

**改 false = 从"按需搜索加载"切到"全部直接给"——功能零损失**，所有 MCP 工具照样可用，只是从"藏在搜索后面"变成"摆在明面上"。`true` 的形态要能工作，前提是 `tool_search` 入口真的存在；而 flash 的 `tool_mode: null` 让入口不存在（即上表三层联动），所以 `true` 在此 catalog 上是坏的。

**真实代价只有一条**：MCP 工具 schema 常驻模型上下文。本机当前 = hopjit 4 工具 + deepwiki 3 工具，约几百 token，可忽略；只有装几十个 MCP server、数百工具的会话，`true`（配上能工作的 `tool_search`）才开始有价值。一句话：**这是给"工具很多的会话"准备的省上下文开关，DeepSeek 官方脚本默认开了它，但它在自定义 catalog 模型上是坏的（上游 bug）；关掉 = 回到最朴素可靠的"工具直接列出"形态。**

### Workaround（本机已打）

`~/.codex/deepseek-models.json` 全部模型条目 `supports_search_tool` 改为 `false` → MCP 工具以 Direct 注册、直接进工具面：

```bash
cp ~/.codex/deepseek-models.json ~/.codex/deepseek-models.json.bak
python3 -c "
import json
p = '$HOME/.codex/deepseek-models.json'
d = json.load(open(p))
for m in d['models']:
    m['supports_search_tool'] = False
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
"
```

**备份**：`~/.codex/deepseek-models.json.bak`（同目录）。

### 撤销条件

上游 issue #36382 修复（Deferred 工具有可用的 tool_search 入口，或 codex 对 `tool_mode: null` 的模型自动降级为 Direct）后，还原 `.bak` 即可。**DeepSeek 官方脚本重新生成 catalog 会覆盖本补丁**——重生成后需重打。

---

## W-2 Codex exec：MCP stdio server 的三条注册纪律

**登记**：2026-08-10 · **载体版本**：codex-cli 0.146.0 · 三条均为真机判定实验定形

这三条不算严格意义的"上游 bug"（可能是设计行为），但均无文档明示、且失败形态极具误导性，登记为使用纪律：

### W-2a `-c mcp_servers.*` 命令行注入不启动 server

`codex exec -c 'mcp_servers.x.command=...'` 形式注入的 server：`codex mcp list` 认它（显示 enabled），但 **exec 运行时不为它起 stdio 进程**，调用报 `unsupported call` / `not a function`。

**纪律**：临时注册用**持久注册**（直接写 `~/.codex/config.toml` 的 `[mcp_servers.<name>]` 块），用完删除。本库 e2e 的做法：锚定注释块成对增删（见 `scripts/carrier-live-e2e.mjs` 的 `registerCodexMcpBlock`）。

### W-2b codex 以干净环境启动 stdio server

server 子进程只拿到注册块 `env` 表内的显式值，**不继承 shell 环境**。凭证类环境变量（如 `DEEPSEEK_API_KEY`）必须用 **`env_vars = ["VAR_NAME"]`** 按名从 codex 父环境转发（值不落盘，只写名字）。否则依赖环境凭证的 server 启动即死，codex 报 `MCP server 'x' was not ready for this step`。

### W-2c exec 非交互下 MCP 工具调用默认送审批

无人可批 → 自动取消，模型收到 `user cancelled MCP tool call`（极易被误读为用户/权限问题）。**两侧都要做**：

- server 侧：工具带 **ToolAnnotations**（只读工具 `readOnlyHint: true`；写入工具如实标 `destructiveHint`/`openWorldHint`）——无注解按最坏情况对待，`auto` 也救不回；
- 注册块：`default_tools_approval_mode = "auto"`。

本库 e2e 注册块的完整形态（含 `required = true` 让启动失败显式报错、`startup_timeout_sec = 30` 放宽默认 10s）：

```toml
[mcp_servers.hopjit]
command = "node"
args = ["<abs>/dist/mcp-server.js"]
env = { HOPJIT_CONFIG = "<StandaloneConfig 路径>" }
env_vars = ["DEEPSEEK_API_KEY"]
required = true
startup_timeout_sec = 30
default_tools_approval_mode = "auto"
```

### 撤销条件

W-2 三条随 codex 版本演进复核：升级 codex 后若 `-c` 注入可用/环境继承变化/审批策略变化，更新本节。协议层的对应契约在 [[codex-driver-carrier#^anc-driver-codex-standalone-dispatch]]（注册通道条）与 [[mcp-server#^anc-mcp-tools]]（注解条款）。
