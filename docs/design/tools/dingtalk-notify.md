%% @trace
	id: hopjit-tools-dingtalk
	source: [[../tools]]
	source_id: hopjit-tools
	type: extend
	last_sync: 2026-08-31T00:10+0800
	note: 钉钉通知内置通道模块设计——todo/0052 通知半边正式形态（2026-08-30 作者三连纠收口"tools 不再直接通过 hopjit cli 外露"后按工具模块重做;前身 hopjit notify CLI 命令当日立当日撤,史见 [[../hop-cli#^anc-cli-notify]] 退役注记）。
%%

# 钉钉通知工具模块（dingtalk-notify）

> **模块版本**：随 tools 模块（[[../tools]] v0.13.0,2026-08-31 新建时点）。本文件是 tools 模块的组成部分,不独立计版——契约变更升 tools 模块版本号。

tools 模块的第一个**不可逆动作的内置通道**（装配层本体见 [[../tools]]）。实现文件 `src/tools-notify.ts`。todo/0052 通知半边的正式形态：spec 内 `[commit]` 步骤可调的注册工具 + 引擎终态/停点挂点的发送执行体，一份实现两个消费口。

## 定位与已拍口径【决策】 ^anc-tool-dingtalk-position

2026-08-30 作者逐条拍定（原话入档）：

- **不经 CLI 外露**（"hopjit 阉割=tools 不再直接通过 hopjit cli 外露"）——工具能力恒经工具面（ToolProvider 装配），CLI 无 notify 命令；
- **配置驱动不塞 LLM**（"执行时也应该是可以配置的，不要一股脑塞给 llm"）——引擎挂点发通知时 LLM 不参与"发不发"判断（挂点契约见 [[../mcp-server#^anc-mcp-notify-hook]]）；
- **用户要了才发**（"你都没说钉钉通知，为啥会通知？"）——发送触发以 per-run 参数为主，config 只声明通道与凭证指向；环境变量在场也不擅自发；
- **渠道中立**：`tool_id: notify`——spec 侧恒用 notify 调用名，换渠道（企业微信/邮件）只改配置零改 spec（与 web_search 的 provider 中立同款套路）；
- **不可逆=requires_commit=true**：钉钉消息发出即收不回，spec 内只许 `[commit]` 步骤调（act/check 语境被 COMMIT_REQUIRED 拒——requires_commit 既有三处检查位天然覆盖，本模块零新增拦截代码）；
- **builtin 装配形态**：引擎自带通道不走 `tool_servers` 的 in-process 注册（那要用户填包内 module 路径，体验错误）——进 CompositeToolProvider 的内置成员表（见 [[../tools]] 装配节 2026-08-31 内置成员表改造），config 只做开关与凭证环境变量名指向。

## 能力契约【契约】 ^anc-tool-dingtalk-notify

```
trait: DingtalkNotify
  Id: dingtalk-notify
  Provides:
    - notify   # 发一条钉钉消息（tool_id;wire 名 dingtalk_notify）
  Constraints:
    - requires_commit=true（发出即收不回——spec 内只许 commit 步骤调,act/check 被既有 COMMIT_REQUIRED 闸拒）
    - 凭证恒环境变量：DINGTALK_WEBHOOK（群机器人 webhook 完整地址,必）/ DINGTALK_SECRET（SEC 加签密钥,可选——在场自动走加签:timestamp+"\n"+secret 做 HmacSHA256,base64 后 urlencode 拼 URL;缺席=机器人用关键词/IP 白名单档）。凭证不进库不进配置文件明文——config 里只写环境变量名,不写值
    - 失败是值不炸步骤链：webhook 缺席/钉钉拒收(errcode≠0)/网络失败均归一 ToolResult{success:false, result:错误说明+常见原因指引}——通知失败不该拖垮业务流程,处置归调用方
    - 纯发送口:不读引擎状态不渲染卡片（卡片渲染归引擎挂点侧组装,见 [[../mcp-server#^anc-mcp-notify-hook]]——工具只管"收文本,发出去"）
```

## 类型约定【契约】 ^anc-tool-dingtalk-types

```
struct: NotifyArgs
  Id: dingtalk-notify-args
  Fields:
    - text: text        # 消息正文（title 在场时作 markdown 正文,支持 markdown 文法）
    - title: line       # 可选。给了走 markdown 消息（手机通知栏显示标题）,缺席纯 text 消息
    - at_mobiles: [line] # 可选。@人手机号列表（消息在对方会话里标红——等人停点的提档手段）

struct: NotifyResult    # ToolResult.result 的 JSON 内容（content_type: json）
  Id: dingtalk-notify-result
  Fields:
    - sent: bool        # true=钉钉受理（errcode=0）
    - msgtype: line     # 实发类型 text | markdown
```

## 关键逻辑【契约】 ^anc-tool-dingtalk-sop

```
execute('dingtalk_notify', args):
1. 读环境变量 DINGTALK_WEBHOOK;缺席 → ToolResult{success:false, result:'DINGTALK_WEBHOOK 未设置——建法:钉钉群→群设置→机器人→自定义机器人（安全设置选加签,密钥放 DINGTALK_SECRET）'}
2. [条件(DINGTALK_SECRET 在场)] 算加签拼 URL（timestamp+"\n"+secret HmacSHA256 → base64 → urlencode → &timestamp=&sign=）
3. 组报文: title 在场 → {msgtype:'markdown', markdown:{title, text}} / 缺席 → {msgtype:'text', text:{content}};at_mobiles 在场附 {at:{atMobiles, isAtAll:false}}
4. POST webhook（fetch,Content-Type: application/json）;网络异常（连接失败/超时/非 JSON 响应）→ catch 归一 ToolResult{success:false, result:'钉钉发送网络失败: …'}——Trait"失败是值"承诺的第三分叉（review 面一抓 Sop 缺此分叉后补画）
5. [分支] 结果归一
   5.1 [条件(errcode=0)] ToolResult{success:true, result:'{"sent":true,"msgtype":…}', content_type:'json'}
   5.2 [条件(其他)] ToolResult{success:false, result:'钉钉拒收 errcode=… errmsg=…。常见原因:关键词档消息没带设定关键词/加签密钥不对/token 失效'}
```

**测试正反例**：反例——act 语境（allowCommit=false）调 notify 被 COMMIT_REQUIRED 拒（口径 7 点名的必备反例）；DINGTALK_WEBHOOK 缺席 success:false 带建法指引；正例——commit 语境+假 webhook 环境变量下报文拼装正确（fetch 打桩：markdown/text 分型、at 注入、加签 URL 含 timestamp+sign、token 不入日志）。真发送面归真机 probe（0052 卡，作者机器人链路已通）不进 vitest。

**技术资产出处**：加签算法与报文形态 2026-08-30 真机验证过（scripts/dingtalk-notify.mjs 试跑件→hopjit notify 命令，均已退役，实现史归 git log）；已知坑=webhook 粘贴带脏字符致钉钉报 token is not exist。

## composeRunCard 归置注记【说明】

运行状态卡片组装函数 `composeRunCard(RunCardInput) → {title, text}` 住本模块实现文件（src/tools-notify.ts,与 sendDingtalk 并列）——**代码归置,不改变职责分工**：渲染的调用责任仍在引擎挂点侧（standalone=mcp-server maybeNotify / 复用模式=cli outputWithNotify,契约各归 [[../mcp-server#^anc-mcp-notify-hook]] 与 [[../hop-cli#^anc-cli-notify-reuse]]）,sendDingtalk 仍只收文本。抽共享的理由：两挂点各自组装=同一张卡两份实现,改徽记/加字段必漂移（2026-08-31 复用模式挂点落地时抽出,RunCardInput 类型契约在 hop-cli 节）。

## 将来扩渠道【说明】

企业微信/邮件等第二渠道=本目录再添一个模块文件+内置成员表加一行+config 通道枚举扩一员；`tool_id: notify` 不变，spec 零改。企业微信备选盘点（2026-08-30）：通知 webhook 更省（无签名仪式）且可经"微信插件"推普通微信；其命令接收面无钉钉 Stream 同类通道（须公网回调），故命令半边（todo/0052 ②）恒钉钉。
