%% @trace
	id: hopjit-tutorial-mcp-tools
	source: [[../design/tool-interface]]
	source_id: hopjit-tool-interface
	type: compact
	last_sync: 2026-09-01T20:26+0800
	note: 用户教程 08——把 MCP 服务接成 spec 可调用的工具：配置文件 tool_servers 节注册（云端/本地两形态）→ body 里按名调用 → 安全与故障语义。对外文法权威在 reference/配置参考 ^anc-ref-tool-servers
%%

# 教程 8 · 接入 MCP 服务：让 spec 调外面的工具

**目标**：把一个 MCP 服务（云端 API 或本地 server）注册成你的 spec 里可以按名调用的工具——搜索、知识库、任何生态里现成的 MCP 能力。
**前提**：完成 [[D10-hop_python计算体]]（body 里调工具的语法在那篇）；使用独立模式（standalone——入口是 `/hopspec-mcp` 命令，配置见 `USAGE.md` §6；外部工具注册当前走 standalone 配置面）。

## 一分钟看懂机制

spec 的 body 里只写**工具名**：

```markdown
1. [act] 检索资料
  - ← topic
  + → pages: [yaml]
  > ```hop_python
  > pages = web_search(query: topic)
  > ```
```

`web_search` 是谁、怎么连、凭证在哪——**全部在环境配置里**。这是有意设计：工具的实现细节（端点/凭证/签名权威）是工具的固有属性，注册一处，所有 spec 按名用。

spec 侧可以（不强制）在文件头加一个 **`Tools:` 段**声明"本 spec 假定环境里有这些工具"——它是 import 声明不是签名复制：

```markdown
Tools:
- web_search(query) -> pages: [yaml]  # 检索外部资料
  - query: text  # 检索词——完整问题句,不是关键词堆砌
```

写了它的好处：spec 自包含（拿到一份 spec 读文件头就知道它依赖什么）、**起跑前对账**（引擎 init 时把 Tools 段与环境注册面比对——环境缺这个工具、或参数名对不上，当场报错不起跑，不是跑到一半才炸）、执行 LLM 拿到逐参数语义不望词生义。不写也完全合法——引擎跳过对账，跑到调用时才发现缺工具。

## `[act free]` 步骤要多写一行：工具授权

上面的例子是带 body 的步骤——body 里写了工具名，调用关系静态可查，注册了就能用。但 `[act free]` 步骤（没有 body、让 LLM 自己决定怎么干的自由任务档）不一样：**引擎按步骤声明下发工具面，你要在步骤体里写一行授权，这一步的 LLM 才拿得到这个工具**：

```markdown
2. [act free] 搜集外部依据
  - ← claim
  + → evidence: [yaml]  # 依据清单
  - 工具: web_search  # 就 claim 检索外部依据
  > 用 web_search 检索至少 2 组关键词……
```

格式：`- 工具: 工具名  # 本步用它做什么`，位置在输入输出声明之后、`>` 执行说明之前；一行一个工具，用两个就写两行。**不写的后果很隐蔽**：不报错——执行 LLM 只是拿不到这个工具，只能"合规空转"，产出一个看起来完整、实际没有检索支撑的结果。为什么这样设计：free 步骤是 LLM 自由发挥的窗口，哪一步能碰哪些外部工具由 spec 作者逐步点名，而不是注册了就全程敞开。

两类不用写：引擎内置文件工具（read/write/edit_file/search_file 等十一件）恒可用；带 body 的步骤在 body 里直接调用（本节开头的形态）。

`reason` 步骤同样可以带 `- 工具:` 授权行——推理过程需要查资料时（比如就着方案检索一下佐证），写法与上面完全一样。standalone 下 reason 的工具面是：基础文件工具恒可用，特殊工具（如 `web_search`）按声明下发，不可逆工具（`requires_commit: true` 的）恒拒——推理步骤不许留下不可逆后果。复用模式下 caller 本来就自带全部工具，这行授权就当意图注记读。唯一没有工具面的是 `check` 步骤：判官只做纯判定，不碰任何工具。

## 注册：配置文件 `tool_servers:` 节的两种常见形态

工具注册就是配置文件里的一节 `tool_servers:`——写在**项目级 `<项目根>/hopjit.yaml`**（跟项目走、可进仓库，推荐）或系统级 `~/.hopjit/config.yaml`（所有项目通用的工具）都行，两级取并集（全部配置字段与两级合并规则见 `docs/reference/配置参考.md`）。

**形态一：云端 MCP 服务**（如阿里百炼的 WebSearch——进程在别人手里，只管连接）：

```yaml
tool_servers:
  - name: bailian_search            # server 逻辑名（日志记账用）
    binding:
      kind: mcp
      transport: http
      url: "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp"
      auth_env: DASHSCOPE_API_KEY   # 环境变量名——文件不含秘密
    tools:                          # 白名单：声明即启用，没声明的工具不进引擎
      - name: bailian_web_search
        tool_id: web_search         # body 里的调用名——全局唯一（原名已合法时可省）
        requires_commit: false
        params:                     # 可选但推荐:逐参数语义（执行 LLM 靠它不望词生义）
          - query: text             # 检索词——完整问题句,不是关键词堆砌
        output_schema:              # 出参形状（HopSpec 类型词汇）
          pages: [yaml]
        unwrap: json-in-text        # 响应解包指示（见下方说明）
```

> **`unwrap` 是什么**：MCP 协议规定工具返回的是"内容块"（content blocks——text/image 等），而很多服务商（百炼系四个服务都这样）把真正的结构化结果**以 JSON 字符串塞在 text 块里**返回——引擎拿到的是一段"长得像 JSON 的文本"，不解包就没法按 `output_schema` 校验、也没法让 body 里 `pages[0]` 这样取字段。`unwrap: json-in-text` 告诉引擎：取首个 text 块做 `JSON.parse`，解析出的对象才是真结果。**缺省不解包**（server 直接返回结构化内容时不用写）；解析失败按"形状偏差"处理（入 adaptive 阶梯，原文进失败记录）。怎么知道该不该写？跑一次看失败记录里的原始响应——内容是转义的 JSON 字符串就加这行。

**形态二：本地 MCP server**（stdio——引擎替你起子进程、run 结束替你收）：

```yaml
  - name: hopkb
    binding:
      kind: mcp
      transport: stdio
      command: hopkb-mcp            # 启动命令（PATH 可达或绝对路径）
      args: ["--kb", "./kb"]
      env_passthrough: [HOPKB_HOME] # 白名单透传环境变量——不整包漏环境
    tools:
      - name: kb_search
        requires_commit: false
        output_schema:
          hits: [yaml]
      - name: kb_write
        requires_commit: true       # 不可逆写操作——act 里调用直接拒，只许 commit 步骤
```

## 顺带：spec 要的"路径参数"写在 env: 节

有的 spec 会引用你机器上的材料（知识库、判据文档），它的说明里会列出需要哪些 `hop_env_*` 参数。跟工具注册同一个配置文件，多写一节 `env:` 即可：

```yaml
env:
  hop_env_kb_root: ~/vaults/判据库   # spec 里 [[{hop_env_kb_root}/入库判据#完备性]] 引到这里
```

填好后从任何目录启动都能找到材料——不需要关心"从哪个目录跑"。三条硬规则（只读/凭证禁入/未定义即报错）与覆盖链见 `docs/reference/配置参考.md` 二b 节。

## 六条你该知道的规矩（都是保护你的）

1. **白名单语义**：server 说它有 20 个工具没用——你声明了哪几个，引擎只放行哪几个。server 的工具面不被整包背书；
2. **调用名全局唯一**：`tool_id`（没写则用 `name`）在**全部已注册工具 + 内置工具（read/write 等）**范围内不得重名——两个 server 都想叫 `search`？给至少一个起 `tool_id` 区分。冲突不会静默覆盖或遮蔽，**起 run 时即拒**（`start_run` 装配工具面时返回结构化错误，报冲突名与两个来源）——宁可装不上，不可调错人；
3. **凭证不落盘**：`auth_env` 只写环境变量**名**，key 永远只在环境与内存；
4. **`requires_commit` 权威在你的声明侧**——不信 server 自报（实测会标错）。标了 `true` 的工具在 act 步骤调用直接拒，只有 commit 步骤放行（教程 03 的把关语义延伸到外部工具）；
5. **执行主权单向**：引擎调工具、工具永远不能反向影响引擎的执行流（不订阅、不接回调）——接一个第三方 server 不会让它"住进"你的执行；
6. **故障就是步骤失败，没有新通道**：server 起不来、超时（单调用缺省 60 秒硬闸）、返回坏东西——一律等于该步 fail，走你熟悉的 retry/升级链（D4 那套）。挂死的 server 吊不死你的步骤。错误原文会进失败记录——比如百炼"服务未开通"的 404 文案会原样带出来，并提示去 MCP 广场开通。

## 改了注册什么时候生效

MCP server 常驻场景下，`hopjit.yaml` 里的工具注册（连同 `env:` 节）**每次 `start_run` 时重读**——加个工具、改个白名单，下一个 run 就生效，**不用重启 server**。例外是 `providers` 节（模型后端与凭证）：改它要重启。文件写错（文法/凭证违规）当次 run 直接拒，不会静默用旧配置。细则见 `docs/reference/配置参考.md` 零章"改配置什么时候生效"。

## 跑一遍的体感

注册好后正常 `start_run` 你的 spec：首次调用该工具时引擎才连接 server（惰性）；调用结果按 `output_schema` 校验后进变量空间（形状不对 = 偏差入 adaptive 阶梯，原始报文在失败记录里供重规划参考）；run 到终态时本地 server 被礼貌关停（EOF→SIGTERM→SIGKILL 三段收）——你不用管进程。

## 常见问题

| 症状 | 处置 |
|---|---|
| 调用报"未开通"类 404 | 云端服务要先在服务商控制台逐个开通（失败记录里有原文与提示） |
| 工具名冲突起 run 即拒 | `tool_id` 换一个语言面名字（与内置工具如 `read`/`write` 撞名同拒） |
| server 报的工具比声明多 | 正常——白名单外的不放行；声明的工具不在 server 实况里会 warn（声明与实况漂移） |
| 想看调了什么、回了什么 | HopLog 里每次工具调用在案（开发者深挖见 [[D6-用HopLog诊断]]） |

## 下一步

- 想**自己写**一个工具（而不是接现成服务）：开发者篇 [[D7-开发自己的工具]]；
- 注册文法权威（全部字段/校验规则/in-process 第三形态）：`docs/reference/配置参考.md` 工具面一章。
