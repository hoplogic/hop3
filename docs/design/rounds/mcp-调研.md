# MCP 调研（协议评估 + 百炼四服务实测）

> 定位：**调研记录**（2026-08-12，作者与 agent 整轮对谈的事实与裁决存档）。设计消费方=[[atomic-io-tools-草案]]（结论已并入其分层设计与参考声明）；本文保完整证据链与推理过程，正式稿落地后本文只作历史参考。

## 一、协议本质定性（作者点破）

**MCP = untyped-request-response 的进程间/远程调用机制**：

- 请求侧**半 typed**：tools/list 带 inputSchema（JSON Schema）；
- 响应侧 **untyped**：返回 content blocks 数组（text/image/resource），无输出类型；后补的 outputSchema 可选、生态几乎不实现（四服务实测 0/37 工具带）；
- 副作用语义（annotations.readOnlyHint/destructiveHint）规范自标 untrusted，实测更糟——**会标错**（见四、实证④）；
- 拆开看是两半：**传输半**（stdio/HTTP 长驻 + JSON-RPC 配对）成熟可复用；**语义半**（握手仪式/capabilities 协商/content blocks 包装/工具发现）是替"陌生宿主对陌生 server"设计的防护。

## 二、双侧定位（作者终裁）

- **CC/Codex 侧：MCP 是最好的伴生出沙箱形态**。精确定性（作者）："随主 agent 进程启停、不在沙箱内的 daemon"——长驻状态 + 出箱授权（注册=授权，agent 不能自己给自己开通道：改 mcp 配置文件撞 agent 自身的文件沙箱）+ 宿主托管监护（spawn/管道命脉/EOF 收；CC 启动即 spawn，Codex 工具面延迟加载、进程时机未实测）。这个位置**只有 MCP 一个入口**，无更优选择；
- **独立模式侧：更好的用法是只取 MCP 传输半、语义半换成第一层**（作者裁 A 方案）：引擎作为 client 只消费 initialize + tools/call 最小子集——发现跳过（清单在 hoptools.yaml）、annotations 不信（effect 引擎侧声明）、content blocks 解出即过 output_shape 校验（untyped 在边界 typed 化）。自家插件与第三方现成 server 同走一条 mcp 绑定；曾议的 exec-daemon 独立 NDJSON 协议撤销（三优势在最小子集下逐个消解）。

**双角色总图**：hopjit 对上是宿主的 MCP daemon（hopjit-mcp，姿势随宿主）、对下是自己的插件宿主（ToolSpec+绑定=hopjit 插件标准）。命名纪律：mcp-server 模块=上行壳，mcp 绑定=下行通道，不混称。

## 三、生命周期与版本（逐问核实）

- **stdio 生命周期=Unix 管道语义**：宿主 spawn、stdin EOF 即退、SIGPIPE 兜底、孤儿是已知残留风险。启停监护谁都逃不掉（作者点破）——MCP 的价值是把监护外包给宿主的现成实现；引擎侧接 server 时自己扛同一套（spawn→EOF→SIGTERM→SIGKILL），与 daemon+CLI 形态的真实差异是"启停有主 vs 无主"；
- **一次 standalone 运行的四层生命线**：会话养 server、server 养 run、run 养工具 server；**run 的真身在盘上不在进程里**（任何一层死、损失以最近落盘为界）→ 推论：.hopstate 完整性是单点（已立账 [[../../TODO#^todo-hopstate-integrity]]）；
- **协议版本**：日期版本号 + initialize 协商，**多版本共存设计**（SDK 单包同时支持 5 版：2024-10-07→2025-11-25）。SDK 源码实况：协商=server 回什么 client 查在不在支持列表（二值判定，非取共同最大）；**stdio 下协商结果无运行时后果**（只存起来+给 HTTP 设 header）——版本机制是"礼貌表态"。
  - 结论：**lockfile 钉 SDK 包=版本管理的全部**；"协议版本追赶困难"是最初的错账（真实撞过的 SSE→Streamable HTTP 是 transport 迁移、Codex 延迟加载是宿主行为，都非协议版本问题）；行业事实标准=用 SDK 默认，显式钉版是零成本的更保守姿势；
- **版本管理只剩自家三面**：hopjit-mcp 工具面版本（mcp-server.md 版本行既管）、ToolSpec 接口标准版本（正式稿立）、各插件自己的版本（hoptools.yaml 声明比对，不符 fail-fast）。

## 四、百炼四服务实测档案（2026-08-12，同一把通用 key，逐服务在 MCP 广场单独开通）

| 服务 | protocolVersion | 工具面 | 关键发现 |
|---|---|---|---|
| WebSearch（`/api/v1/mcps/WebSearch/mcp`） | 2024-11-05 | 1 工具，零 outputSchema 零 annotations | 无会话要求；真调用 ✅（pages 数组） |
| amap-maps | 2025-03-26 | 15 工具全裸 | 真调用 ✅（maps_geo）；唤端类工具（take_taxi/navi）effect 定级需斟酌 |
| 法律/deli-mcp-server（服务名=市场 ID） | 2025-06-18 | 2 工具，**annotations 在场且标错** | **强制会话流**（无 Session-Id 即 400）；真调用 ✅（类案检索 280 条） |
| 企业工商/天眼启信（市场 ID） | 2025-06-18 | **19 工具全裸，工具名中文** | 错参调用 isError:true+text 塞上游网关 404 原始报文；server 名是营销文案；真调用 ✅ |

**六条实证**（每条都有生产服务背书，直接进第一层设计依据）：

1. **多版本共存**：三个协议版本并存于同一平台，server 说了算，SDK 支持列表全兜住；
2. **untyped 是生态常态**：37 工具 0 个带 outputSchema；返回惯例=text 块内嵌 JSON 字符串（四家一致 → hoptools.yaml `unwrap: json-in-text` 机制）；
3. **"未开通"是真实故障形态**：404+中文业务文案（非 JSON-RPC）+ ~30s"开通中"过渡态——mcp 绑定 fail-fast 须识别并指路；
4. **annotations 会标错（实锤）**：法律服务纯只读检索标 `readOnlyHint:false, destructiveHint:true`——照信则工具废掉。effect 引擎侧声明是唯一可信来源；
5. **工具名可任意 Unicode**：中文工具名在 hop_python body 不可直接调用 → ToolSpec 补 `alias` 字段（别名进 body、原名走 wire）；
6. **错误面同样 untyped**：isError:true 的 text 可能塞任意上游原始报文——绑定层错误摘要须截断。

**接入细节备忘**：百炼通用 key 有新旧两种格式（短 `sk-` 32 位 / 新 `sk-ws…` 116 位，均通用）；MCP 服务逐个开通（前 2000 次免费档各自独立）；第三方托管服务名=市场 ID（`market-*`）。

**相关端点旁证**（同轮实测）：

- 百炼 OpenAI 兼容端点 ✅（`compatible-mode/v1`，我们 openai 协议适配器真机路径）；
- Anthropic 兼容端点 ✅（主域名 `dashscope.aliyuncs.com/apps/anthropic`，模型名不带 `[1m]` 后缀；**tool_use 循环可用**，qwen/deepseek 都通）；
- Anthropic 官方 web_search server tool 语法在百炼 anthropic 端点**静默忽略**（不报错不搜索——server-side search 落地须按 provider 区分：百炼走 openai 端点 `enable_search` ✅ 实测通）。

## 五、结论去向

- 分层设计（typed 第一层/绑定第二层）、mcp 绑定最小子集条款、hoptools.yaml 参考声明（四服务实例）→ [[atomic-io-tools-草案]]（待作者拍四决策点后转正式稿）；
- .hopstate 完整性 → [[../../TODO#^todo-hopstate-integrity]]；
- hopkb 形态 → 一个 hopkb-mcp server 两侧通吃（对上挂宿主/对下接引擎 mcp 绑定）。
