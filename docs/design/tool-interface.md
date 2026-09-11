%% @trace
	id: hopjit-tool-interface
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-08-18T00:08+0800
	note: 工具接口标准（typed request-response 第一层）与绑定机制（第二层）的正式设计——概念上游=核心规范工具签名契约（^anc-step-act-body-lang 段）；推演与实测证据链在 rounds/atomic-io-tools-草案 + rounds/mcp-调研。归 tools 模块（tools.md 是内置实现层，本文是接口标准层）
%%

# 工具接口标准与绑定机制

## 文档结构与内容分级

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【决策】** | 人拍板的关键选择 | 改动需作者确认 |
| **【契约】** | 带 `^anc-*` 锚点的技术约定 | 代码/测试必须对齐，anchor-audit 全量审查 |
| **【说明】** | 示例、背景 | 与契约一致即可 |

| 章节                       | 分级  | 锚点                               |
| ------------------------ | --- | -------------------------------- |
| 定位与分层                    | 契约  | `anc-struct-tool-interface`      |
| 关键决策                     | 决策  | —                                |
| 工具声明两面（设计承接总纲）      | 契约  | `anc-tool-two-faces`             |
| ToolSpec（第一层类型面）         | 契约  | `anc-type-tool-spec`             |
| params/notes 语义面           | 契约  | `anc-tool-params-notes`          |
| 外部工具注册（tool_servers 节）  | 契约  | `anc-config-tool-registry`       |
| output_schema 语法                     | 契约  | `anc-type-output-schema-syntax`      |
| 双端校验                     | 契约  | `anc-exec-tool-shape-check`      |
| 绑定机制（第二层）                | 契约  | `anc-type-tool-binding`          |
| 装配：CompositeToolProvider | 契约  | `anc-exec-tool-composite`        |
| McpBinding 实装            | 契约  | `anc-exec-mcp-binding`           |
| InProcessBinding 实装      | 契约  | `anc-exec-inprocess-binding`     |
| 工具 server 生命周期总图         | 契约  | `anc-exec-tool-server-lifecycle` |

> **模块版本**：tool-interface `v0.6.2`（2026-09-02）。本版回填算法重写为 params 节窗口+序位配对（review 批四缺陷:错配/防线失效/池污染/引号数组丢弃）。上版补装 params 短形态行尾 # 说明回填（todo/0050,enrichParamsComments 三读入口）并修 PARAM_TYPES 词表漂移（number 除名与 output_schema 同表）。0.x 未承诺稳定。上版新增**工具分档字段 `category: basic | special`**（0054,作者定——基础文件读写族恒 basic 零声明可用;spec 树编辑族与外挂注册件恒 special 须节点 `- 工具:` 声明才对无 body 的 act 可用;缺省=special——收紧安全默认,新注册件不声明分档即须授权;in-process 内建九件文件工具在代码内标 basic,机械判据不靠名字猜）。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。

## 定位与分层【契约】 ^anc-struct-tool-interface

概念上游 [[../docs/concepts/HopSpec V3核心规范#^anc-step-act-body-lang]]（工具签名=工具内在属性，归环境配置级注册）。两层：

- **第一层：typed request-response 接口标准（本文主体）**——工具 = name + 输入 schema + 输出形状 + requires_commit。引擎只认这一层：按 schema 发请求、按 shape 校验响应、按 requires_commit 过探索/提交闸——与怎么送达无关；
- **第二层：绑定机制（可插拔）**——in-process / mcp 两档（作者定 2026-08-12；exec 挂起备用）。安全、契约、审计、重放全钉第一层，换绑定不换保障。

家族分工（接口标准/通道地图/装配层/具体工具四切面）的权威论述见 [[tools]] 开头"工具设计面地图"节——本文只管接口标准这一面,不复述分工（原分工句"tools 是内置实现层（file 九件等工具实体）"在 2026-08-31 拆迁后失实——分工描述多处复述必漂移,收口单处）。

## 关键决策【决策】

1. **requires_commit 原样保留，不引入 effect 三级枚举**（作者裁 2026-08-12）：read/write 与"不可逆"不同轴——沙箱内写可逆（不需要 commit）、只读也可有配额消耗；pure 工具是自相矛盾的分类（纯计算归 hop_python builtin）。缓存等将来需求是工具的独立属性（如 cache_ttl），与安全分级无关，本版不做；
2. **output_schema 异常 = 预期与现实的偏差，入 adaptive 阶梯**（作者裁 2026-08-12；mcp 一期补充裁决：**先按严格接口解析，出错后原始信息放在错误信息里，供后继 replan 消费即可**——不做容错解析/模糊匹配，偏差原文进 FailRecord 是唯一的适配素材通道）：按已知查，异常触发既有升级链（重试→adaptive 重规划适配）并记录——非终局硬失败。详见双端校验节；
3. **绑定两档收敛**（作者裁 2026-08-12）：in-process（引擎内，凭工程链审计资格）+ mcp（引擎外单通道，最小子集+版本钉固）；exec 挂起备用（复活触发=单调用即弃隔离的真实需求；设计留档在 [[rounds/atomic-io-tools-草案]]）；
4. **工具名允许任意 Unicode，body 调用经 tool_id**（实测驱动——百炼企业工商服务 19 个中文工具名）：ToolSpec.name 按字符串等值判全局唯一；非法标识符名的工具须声明 `tool_id`（语言面标识符）供 hop_python body 调用。

## 工具声明两面（设计承接总纲）【契约】 ^anc-tool-two-faces

概念权威 [[../concepts/HopSpec V3核心规范#^anc-tool-two-faces]]。设计层四件承接：**注册面语义**=本文 params/notes（^anc-tool-params-notes）;**spec Tools 段文法**=[[spec-parser#^anc-rule-tools-section]];**init 对账**=[[exec-engine#^anc-exec-tools-reconcile]];**call 工具决议**=[[step-dispatcher#^anc-exec-call-tool]]。权威关系：环境注册面=实现权威（安全语义 requires_commit 钉此),spec Tools 段=需求声明（init 对账两面,不兼容当场报错）。

## ToolSpec（第一层类型面）【契约】 ^anc-type-tool-spec

```
struct: ToolSpec
  Id: tool-spec
  Fields:
    - name: line             # wire 上的工具名，全局唯一（字符串等值判；同名冲突=配置错误 fail-fast）。允许任意 Unicode
    - tool_id: line          # 可选。hop_python body 的调用名=工具在 HopSpec 语言面的标识符（须合法标识符）——name 非法标识符时必填,缺省=name;与全体 name/tool_id 集合同判唯一
    - description: line
    - input_schema: yaml     # 请求类型（JSON Schema）。内置工具内嵌代码；外部工具可省略——从绑定侧发现（mcp tools/list）并做一致性比对
    - params: yaml           # 可选（v0.5.0 ^anc-tool-params-notes）。逐参数语义声明——条目式 `- 参数名: 类型  # 说明`,说明入结构;与 input_schema 的分工:input_schema=机器校验面(JSON Schema),params=人与 LLM 的语义面(值语义/取值来源/错用后果)。两面并存时引擎核参数名集合一致(不一致=TOOLS_FILE_INVALID fail-fast——防两面漂移);仅有 params 时 input_schema 由其机械生成(类型词映射 JSON Schema 基础类型)
    - notes: text            # 可选（v0.5.0 同批）。跨参数复杂语义多行扩展块——幂等性/上限/调用纪律/取值约定;进 prompt 工具语义供给面,不参与机器校验
    - output_schema: yaml     # 可选。响应形状声明（HopSchema——语法与收窄见 ^anc-type-output-schema-syntax）；声明即硬校验（见双端校验）；无声明=放行+warn
    - requires_commit: bool  # 不可逆标记（act 拦截/commit 放行）——权威在本声明，不信绑定侧自报（mcp annotations 实测会标错）
    - unwrap: line           # 可选。响应解包指示，枚举 json-in-text（text 块内嵌 JSON 字符串——百炼系四服务一致惯例）；缺省不解包
```

**params/notes 语义面（v0.5.0,概念权威 [[../concepts/HopSpec V3核心规范#^anc-tool-two-faces]] 环境注册面半边——2026-08-25 作者定"每个 tools 下面应该用 hop schema 方式来展开介绍每一个参数的意义,避免望词生义"）** ^anc-tool-params-notes：

```yaml
tools:
  - name: send_message
    description: 把消息发送到值班群（发送后撤不回）
    requires_commit: true
    params:
      - channel: line     # 目标频道标识——值班群的群 ID（形如 "oc_a1b2c3"）,不是群名称;错传群名平台报 404
      - content: text     # 消息正文全文——发送即所见,无二次确认
    output_schema:
      message_id: line    # 平台返回的消息 ID（平台幂等键）
    notes: |
      channel 取值从环境配置 duty_channel 读,spec 不硬编码群 ID;
      单条上限 4000 字符,超长须 spec 侧分批;
      网络失败可安全重发（平台按内容摘要幂等,重放不加害）。
```

- **params 条目形态**：`- 参数名: 类型` 行 + 行尾 `# 说明`——parser 收说明入结构（与 spec Inputs 的 `#` 说明同款处理,YAML 裸注释会丢故须 tools-registry 自行按行解析 params 节）。实现形态=注释回填（v0.6.1 todo/0050 补装;v0.6.2 review 批算法重写——首版全文候选池按名+型顺序消费四处实证缺陷:同名同型无注释条目偷说明/工具名恰为词表词错配/notes 自由文本污染池/带引号数组类型静默丢弃）：`enrichParamsComments` 在各读入口（tools 独立文件/standalone 两级配置/CLI tool-call 的 hopjit.yaml）yamlLoad 之后拿原始文本回填,算法=**params 节窗口定位+节内序位配对**——只扫每个 `params:` 行下方的连续列表项行块（tools 数组行/notes 块天然在窗口外）,窗口内第 i 行配 params 数组第 i 条目（YAML 保序）;配对安全门=短形态核行键行值一致（值剥缠绕引号——`"[line]"` 数组类型形态照常配）、长形态核行键为 name,任一不合弃整窗口（宁漏勿错配——错说明比丢说明更害）;类型词汇=HopSpec 原子类型 + `[原子]`（与 output_schema 同词汇表——int/float 唯二数字型,number 已随全库除名,v0.6.1 同批修词表漂移）;
- **消费面三处**：①prompt 工具语义供给（执行 LLM 每参数拿到"是什么/怎么取值/错了什么后果"——act free 工具循环与 body 生成期都吃）;②spec Tools 段 init 对账的实现侧对照物;③人读注册文件即知全貌;
- **params 缺席向后兼容**：既有注册文件（只有 input_schema）照常工作,params 是增量语义面非破坏性改动。

binding 挂在 ToolServerEntry 层（一个 server 一个绑定，其下工具共享——见注册文件节），不在单工具上。ToolDef（shared-providers 既有契约）与 ToolSpec 的关系：ToolDef 是 ToolProvider 接口的运行时投影（name/description/input_schema/requires_commit），ToolSpec 是其声明态超集（+tool_id/output_schema/unwrap）。既有 ToolProvider 消费方零改动。tool_id 独立成 list() 清单条目（body 解释器按名单查名与 requires_commit 拦截——语言面 ID 不豁免安全闸）。

## output_schema 语法【契约】 ^anc-type-output-schema-syntax

**语法 = HopSchema**（概念权威 [[../concepts/HopSpec V3核心规范#^anc-type-hopschema]]——HopSpec 类型词汇的 YAML 映射,与 Outputs 声明、HopType struct Fields 同一门类型语言）。本使用处的收窄语义：

```yaml
output_schema:          # HopSchema：字段名 → HopSpec 类型名
  pages: [yaml]        # 列表——元素为结构化对象（元素内部结构不在语法内,需说明写 # 注释）
  total: int
  request_id: line
```

- **值位合法词汇**：原子 `bool/int/float/line/text/markdown/yaml/prompt` + 列表 `[原子]`——即 HopSpec 值类型的映射子集；**不提供嵌套映射写法**（`pages: [{...}]` 非法——深层结构无校验消费方,语法不提供写不出假承诺的形态）；
- **校验分级（实装准绳）**：v1 = 顶层键在场性 + **顶层值类型核对**（声明 `int` 来了字符串=偏差;`[…]` 核是否数组;`line/text/markdown/prompt` 核字符串;`yaml` 核对象或数组——结构化容器语义）；深层下钻**显式不做**（实测偏差形态全是字段级缺失/换名,无一例"字段在但内层错"——真需求出现再扩,MINOR）；
- **加载期文法校验**：值位写了词汇表外的东西（如嵌套映射/未知类型名）→ TOOLS_FILE_INVALID 启动即拒（fail-fast 同族——语法错误不进运行期）。

## 外部工具注册（统一配置 tool_servers 节）【契约】 ^anc-config-tool-registry

外部工具的环境配置级注册。**宿主文件=统一配置的 `tool_servers:` 节**（作者定 2026-08-13——原独立 hoptools.yaml 文件形态退役）。**对外文法权威已迁 [[../reference/配置参考#^anc-ref-tool-servers]]**（对外契约的权威属对外文档）;本节管实现行为契约（加载 fail-fast/装配/双端校验语义）：系统级 `~/.hopjit/config.yaml` 与项目级 `<项目根>/hopjit.yaml` 均可声明,两级并集、工具名跨级判重 fail-fast（合并语义权威 [[shared-providers#^anc-config-standalone-schema]]）。工具面通常放项目级（跟项目走可进仓库;in-process `module:` 相对**所在配置文件**目录解析）。复用模式外部工具经 caller 自身工具面已可达（tool-channels ③）;引擎侧注册件已入直执面（0076 批实装——注册件经 loadProjectToolRegistry 进 CompositeToolProvider,body 内直执;原"CLI 入口待真需求再加"句 0084 批三销账）。

三种绑定形态各一例（云端 mcp / 本地 mcp / in-process 扩展模块——`tool_servers:` 节,写在系统级或项目级配置皆可）：

```yaml
tool_servers:
  # ① 云端 MCP server（http 传输——进程在别人手里,只管连接与断开）
  - name: bailian_search       # server 逻辑名（HopLog 记账用）
    binding:
      kind: mcp
      transport: http
      url: "…/mcps/WebSearch/mcp"
      auth_env: DASHSCOPE_API_KEY   # 环境变量名引用——文件不含秘密
    tools:                     # 白名单语义：声明即启用——server 报 N 个工具只放行声明过的
      - name: bailian_web_search
        tool_id: web_search    # 语言面标识符（body 调用名;name 已是合法标识符时可省）
        requires_commit: false
        # input_schema 省略——mcp 绑定从 tools/list 发现补全（发端校验照常生效）
        output_schema:         # HopSchema（语法 ^anc-type-output-schema-syntax）
          pages: [yaml]
        unwrap: json-in-text   # 百炼系惯例:JSON 塞在 text 块里

  # ② 本地 MCP server（stdio 传输——引擎 spawn 子进程,监护全套三段收;hopkb-mcp 即此形态）
  - name: hopkb
    binding:
      kind: mcp
      transport: stdio
      command: hopkb-mcp       # 启动命令（PATH 可达或绝对路径）
      args: ["--kb", "./kb"]
      env_passthrough: [HOPKB_HOME]   # 白名单透传的环境变量——不整包漏环境
    call_timeout_ms: 120000    # 可选:该 server 单调用硬闸覆盖（缺省 60s）
    tools:
      - name: kb_search
        requires_commit: false
        input_schema:          # 显式声明则压过发现（JSON Schema——MCP wire 标准,与 output_schema 的 HopSchema 分属两界:入参走 wire 出参进变量空间）
          type: object
          properties:
            query:
              type: string
          required: [query]
        output_schema:
          hits: [yaml]
      - name: kb_write         # 不可逆写操作——act 内调用即拒,只许 commit 步骤
        requires_commit: true

  # ③ in-process 扩展模块（隔离工具库装载进引擎进程——零序列化;声明装载=操作者对审计状态的断言）
  - name: word_stats_lib
    binding:
      kind: in-process
      module: ./ext-tools/word-stats.mjs   # 模块路径,相对本文件所在目录（接口契约见 ^anc-exec-inprocess-binding）
    tools:
      - name: word_stats
        requires_commit: false
        input_schema:          # in-process 无发现源——声明即唯一发端校验源,不声明=发端放行
          type: object
          properties:
            text:
              type: string
          required: [text]
        output_schema:
          words: int
          chars: int
```

- **白名单语义**：`tools` 子表声明即启用，未声明的工具不进引擎工具面（server 的工具面我们不整包背书）；
- **凭证纪律**：`auth_env` 只写环境变量名（api_key_env 同纪律，文件不含秘密——standalone 整体约束第 1 条）；
- **单调用超时**：server 条目可选 `call_timeout_ms`（缺省 60000）——该 server 全部工具的单调用硬闸（超时语义见 McpBinding HopSop 第 2 步）；
- **加载 fail-fast**：文件语法错/字段缺失/name 或 tool_id 冲突（含与内置工具冲突）→ **startRun/resume 装配期即拒**（判重发生在装配期非 server 启动期——serve 只加载配置不装配工具面,2026-08-17 hopissues/0005 时点措辞校准），报字段与冲突名（loadStandaloneConfig 同先例）。拒的形态=startRun/resume 返回结构化 `error: { code: TOOLS_FILE_INVALID | TOOLS_NAME_CONFLICT, message }`（与 TOOLS_UNAVAILABLE 同约定）——不裸抛到 MCP handler、不崩 server（0005 实抓:CompositeToolProvider 构造点 throw 未包裹,SDK 兜成无 code 的 isError 文本,调用方无法程序化识别——mcp-server 两构造点〔startRun 预检/restore 预检〕补 try 包裹转结构化,与 TOOLS_FILE_INVALID 同款）。
- **server 同名=整体替换（0005 附带发现补著文）**：项目级与系统级 `tool_servers` 条目 **server name 同名**时按合并规则整体替换（项目级赢——byKey by name,与 providers 同律）,同名 server 下的工具集随之整体换掉、**不做工具级判重**（替换语义:项目级声明就是该 server 的完整意图）;跨级判重只作用于**不同名 server 之间**的工具名撞车。

## 双端校验【契约】 ^anc-exec-tool-shape-check

**能力契约（HopTrait）**：

```
# Spec: 工具调用双端校验
Id: tool-shape-check
Goal: 引擎与工具之间的契约执行器——凡进变量空间的工具结果必先过声明核对,凡发出的请求必先过实参核对
Outputs:
- 通过面: 与声明相合的结果（多余字段已裁剪）——进 body/变量空间的值形状可信
- 偏差面: FailRecord（期望形状+实际截断样本）——replan 的适配素材,不静默不粉饰
Constraints:
- declared-or-flagged: 有声明必核死,无声明放行必留痕（warn"裸奔"）——不存在既不核也不记的第三态
- 偏差非终局: 入既有升级阶梯（重跑→adaptive）,零新失败通道
- 通道绑定无关: 任何绑定（in-process/mcp/宿主注入）的结果同一套校验——换绑定不换保障的执行点
- 校验深度=顶层键在场性+顶层值类型（语法与准绳见 ^anc-type-output-schema-syntax;深层显式不做）
```

**关键逻辑（HopSop）**：

```
工具调用（任何通道任何绑定）:
1. [act] 发端校验：实参 vs input_schema——不合即本步 fail（不发请求，省一次外部往返）。
   批次一范围注：外部工具的 input_schema 多为发现而来（tools/list），发端校验随批次二
   McpBinding 的发现比对一起实装；批次一先行的是收端校验（3-4 步）与 body 命名参数静态面（B2）
2. [act] 经绑定送达，取回原始响应
3. [act] unwrap 在场则解包（json-in-text：取首个 text 块 JSON.parse；解析失败=偏差，入 4.2）
4. [branch] 收端校验：结果 vs output_schema
  4.1. [case(无 output_schema 声明)] 原样放行 + HopLog warn 一条（"该工具裸奔"留痕）
  4.2. [case(声明在场且不合——缺字段/解包失败)] 预期与现实的偏差：
       本步 fail，FailRecord 带偏差明细（期望形状 + 实际返回的截断样本）→ 入既有升级阶梯
       （首次带反馈重跑〔偶发抖动重跑即愈〕→ adaptive 重规划适配〔改字段取法/换工具〕）；
       HopLog warn 记偏差（工具名+期望+实际摘要）——人工修声明的凭据
  4.3. [case(声明在场且相合)] 多余字段裁剪（防变量空间膨胀）→ 结果进 body/变量空间
```

- 校验的形状语义 = ^anc-type-output-schema-syntax 校验分级条款（顶层键在场性+顶层值类型核对+按声明键裁剪;深层显式不做）——单一权威不复述；
- 错误摘要截断（实测：百炼错误响应会塞上游网关原始报文全套 headers——FailRecord/HopLog 中实际样本截断至固定上限）。

## 绑定机制（第二层）【契约】 ^anc-type-tool-binding

```
struct: ToolBinding
  Id: tool-binding
  Fields:
    - kind: line   # 枚举 in-process/mcp（exec 挂起备用；未来形态 MINOR 加枚举）
```

| kind | 机制 | 生命周期 | 适用 |
|---|---|---|---|
| **in-process** | 引擎内函数调用 | 无 | 两类成员，代码归属截然不同：①**内置组**（file/net/time…）——引擎自有能力，代码在本库；②**经审计的外部扩展模块**——领域逻辑（如 hopkb 工具组）**住自己的库、走自己库的工程链，一行不进本库**（引擎保持领域无关），仅**运行形态**是装载进引擎进程（零序列化换失去进程隔离——它崩=引擎崩，故资格卡审计状态）。装载机制见 [[#^anc-exec-inprocess-binding]]，参考例=examples/ext-tools/word-stats.mjs（隔离模块形态样板）。审计闸的个人版形态：引擎机检不了外部库的审计状态，声明装载=操作者对审计状态的断言，责任随声明走 |
| **mcp** | MCP client **最小子集**：initialize（+会话流：server 返回 Mcp-Session-Id 则后续请求携带+发 initialized 通知）+ tools/call。跳过 tools/list 作授权（仅用于与声明做一致性比对，不符 warn）；annotations 不信（requires_commit 在声明侧）；content blocks 经 unwrap/shape 校验 typed 化；**会话性能力零消费**（不订阅/不收 list_changed/不接 sampling）——工具 server 永远不能反向影响引擎执行流，执行主权单向（引擎调工具、工具不调引擎）是最小子集白拿的安全性质 | 随 run 起停（spawn/连接 → run 终态收：stdio 三段礼貌关停 EOF→SIGTERM→SIGKILL；HTTP 无进程仅断连）。不做健康检查/自动重启/热更新——server 中途死=调用失败=步骤 fail 走升级链 | 引擎外单通道：自家有状态插件与第三方现成 server 同走 |

- **版本钉固**：lockfile 钉 SDK 包=版本管理的全部（协商在 stdio 下无运行时后果——SDK 源码核实，见 [[rounds/mcp-调研]]）；SDK 抛"版本不支持"=升包信号；
- **故障语义**：起不来/未开通（百炼 404+业务文案形态须识别并指路"MCP 广场逐服务开通"）/超时/坏响应——一律=步骤 fail，零新失败通道；
- **传输**：stdio（本地 server）与 Streamable HTTP（百炼系云端）双支持——SDK 现成，binding 字段 `transport: stdio|http` 区分。

**McpBinding 实装（批次二）**： ^anc-exec-mcp-binding

```
# Spec: mcp 绑定成员
Id: mcp-binding-member-trait
Goal: 把一个 MCP server（本地子进程或云端）接成引擎的工具成员——引擎侧零协议感知,server 侧零引擎感知
Outputs:
- 工具面: 注册白名单的 ToolDef 清单（server 实况不扩权）
- 调用面: 白名单内工具的 ToolResult（成功=text 内容;失败=带原始信息的错误文本,供 replan）
Constraints:
- 最小子集: 只消费 initialize+tools/call;会话性能力零消费——server 永远不能反向影响引擎（执行主权单向）
- 零信任: annotations 不信/名单不从发现来/requires_commit 恒声明侧
- 单调用硬闸: 超时（缺省 60s 整体墙钟）放弃该次调用——挂死的 server 吊不死步骤
- 故障=调用失败: 连接/超时/isError/协议错一律该次 fail 走既有阶梯,不重试不自愈不新通道
```

```
struct: McpBindingMember
  Id: mcp-binding-member
  Fields:
    - entry: ToolServerEntry   # 注册条目（binding+tools 白名单）
    - client: yaml             # SDK Client 句柄——惰性连接（首次调用时 connect,失败=该次调用 fail 不重试——下次调用再试即自然重连面）
    - discovered: yaml         # tools/list 发现结果缓存（连接时一次）——input_schema 补全源与一致性比对
```

**关键逻辑（HopSop）**：

```
连接（惰性，首次 execute 时）:
1. [act] 按 transport 构造 SDK client（stdio: spawn command+args+env_passthrough 白名单环境;
   http: URL+auth_env 解引用为 Authorization 头）——凭证只在内存,构造显式传入
2. [act] connect（SDK 内完成 initialize+会话流——Mcp-Session-Id/initialized 通知全自动）
3. [act] tools/list 发现 → 缓存 discovered:
   3.1 白名单内工具缺席于发现清单 → HopLog warn（声明与实况漂移——不拦,调用时自然 fail）
   3.2 声明无 input_schema 的工具 → 从发现补全（发端校验的 schema 源）。**发现前/发现缺席的
       list() 兜底=最小合法对象 schema `{type:"object", properties:{}}`，禁裸 `{}`**（2026-08-28
       实撞：发现惰性〔首次 execute 才 connect〕而 list() 在首次 LLM 调用前就组装工具清单，零参
       工具兜底 `{}` 经 OpenAI 门面型 Anthropic 兼容端点〔DeepSeek〕校验 400 "schema must be a
       JSON Schema of type object, got type null"，fan-out 六子实例全灭；真 Anthropic 端点宽容
       `{}` 故此前未暴露——发出的 schema 必须自身合法，不赌端点宽容度）
4. 连接失败 → 该次调用 fail：错误报文含原始响应片段（截断）——百炼"未开通"404 文案原样进
   FailRecord 并附提示"检查 MCP 广场该服务开通状态"（严格解析——出错原始信息供 replan 消费）;
   **失败即收尸**（2026-08-26 hopdoc e2e 实撞——stdio connect 已 spawn 子进程,initialize 超时
   抛错后不 close 即泄漏:僵尸 server 存活持锁〔实录 4 个 uv 中间层进程占 .venv/.lock,后续
   连接全部排队超时,一次失败滚成永久失败〕）：connect 抛错路径 close client（尽力而为——
   close 自身出错吞掉,主报文仍是连接失败）

execute(name, args) 经 mcp 成员:
1. [act] 发端校验：args vs input_schema（声明或发现所得）——必填缺失/类型不合=fail 不发（批次二兑现批次一范围注）
2. [act] client.callTool(name, args) → 响应。**单调用超时硬闸**（缺省 60s,ToolServerEntry 可选
   `call_timeout_ms` 覆盖）：超时 → MCP_CALL_TIMEOUT=该次调用 fail（外部 server 是新暴露面——
   挂死的 MCP call 会吊死整个步骤,内置工具进程内无此风险;超时即 fail 走既有升级阶梯,零新通道。
   hopkb 五点需求⑤"外部调用计入步骤超时"的兑现形态：步骤无独立超时钟,单调用硬闸即闸）。
   超时判定按 McpError.code（RequestTimeout）不按错误文本——server 业务错误含 'timeout' 字样
   不得误归超时。**计时语义=整体墙钟**（SDK 源码核实 2026-08-12）：从请求发出起计,收到最终响应
   才停表——不是"无网络活动 N 秒"的空闲计时;流式响应传一半到点同样切,超时值按"完整拿到结果"配。
   MCP progress 通知可重置计时（resetTimeoutOnProgress）但缺省关闭且本库不开——百炼系无一家发
   进度通知,真出现分钟级重工具时再评估（届时 maxTotalTimeout 钉总上限）。连接/发现面
   （initialize/tools/list）不另设钟：SDK 缺省 60s 请求超时罩全部
   request（DEFAULT_REQUEST_TIMEOUT_MSEC）,挂死的 connect 同样 60s 内放弃=MCP_CONNECT_FAILED
3. [act] isError:true → fail：content 文本截断进错误（原始信息供 replan）
4. [act] content **首个 text 块**交上层（unwrap/shape 校验在 Composite 层,本层零形状语义）。**多 text 块=取首块+丢弃留痕**（2026-08-17 hopissues/0006——原实装 join 全部块与本行文字矛盾:join 破坏 unwrap json-in-text〔首块合法 JSON 被次块说明文字污染,parse 必炸误入 SCHEMA_DEVIATION,用户看到'工具返回形状不对'真身却是引擎拼接〕;裁定按设计文字取首块——推演非决策:设计+教程双文字一致且 join 无任何设计论据。丢弃非静默:ToolResult.audit +discarded_text_blocks 计数,dispatcher toolCallLog 随带进 HopLog tool: 审计块——declared-or-flagged,审计读出'server 发了 N 块引擎取了首块'）。**isError 例外**:错误文本仍 join 全部块（错误面本就 untyped 截断进错误,多块拼接是排查信息增益无解析语义）
5. 每次调用的 server 逻辑名+耗时随 ToolCallRecord 进 HopLog tool: 审计块（[[spec-observability#^anc-obs-audit]]）

run 终态收（引擎/mcp-server 生命周期钩子——**含 failed-via-throw**:runSpec 抛异常置 failed 的 catch 路径与正常终态同样传导 close,2026-08-17 hopissues/0007①——原 close 只挂 then 路径,异常失败 stdio 子进程滞留到 server 退出仅靠 EPIPE 兜底）:
1. [act] stdio: client.close()（SDK 关管道触发 server EOF 退出）→ 进程未退 SIGTERM → SIGKILL（三段礼貌收——parallel worker 监护同款纪律。**测试口径（0011 记录在案）**：首段经 close 传导测试覆盖;2/3 段是 SDK transport 内部行为,自建验证需真 spawn 不听话进程属 e2e 级成本,依 SDK 自证不设自动化钉——若 SDK 升级破坏此语义,泄漏进程由 live 档观察面兜底）
2. [act] http: client.close()（断连即可,无进程）
3. 收割失败只 warn 不拦终态（run 已完,清理尽力而为——孤儿风险与宿主侧同水位,如实接受）
4. [act] **终态闸**（四十九审——close 后惰性重连会 spawn 新进程且 run 已终态无人再收=复活泄漏;
   共享 provider〔0021〕下被杀 worker 的末次工具调用可踩此竞态〔协作杀不打断执行中单步〕）:
   close() 先置 closed 位再关停;此后 execute 一律拒(响亮 fail 指明"终态后拒绝重连",不 ensureConnected)
```

**发端校验语义**（兑现双端校验 HopSop 第 1 步）：JSON Schema 的 required+type 浅检（复用既有校验哲学:声明写多深查多深,不做 $ref/组合子——外部 schema 常残缺,过度实现校验器反而拒真）；无 schema（声明与发现都无）→ 放行（与收端"无声明放行"对称）。

**InProcessBinding 实装**： ^anc-exec-inprocess-binding

```
struct: InProcessBindingMember
  Id: inprocess-binding-member
  Fields:
    - entry: ToolServerEntry   # 注册条目（binding.module 模块路径 + tools 白名单——声明面与 mcp 完全同构）
    - mod: yaml                # 装载的模块句柄——惰性 import（首次调用时装载,失败=该次调用 fail）
```

**注册文法**：`binding` 下 `kind: in-process` + `module: <路径>`——module 为模块文件路径（相对声明所在配置文件目录或绝对路径），加载期解析为绝对路径；写 url/command=文法错误 fail-fast。声明装载=操作者对该模块审计状态的断言（个人版审计闸——引擎机检不了外部库工程链,责任随声明走）。

**模块接口契约（隔离模块侧须导出）**：

```
# Spec: in-process 扩展模块接口
Id: ext-module-iface
Goal: 隔离工具库向引擎交出的最小执行面——契约（名单/requires_commit/shape）留在声明侧,模块只管执行
Constraints:
- 必须命名导出 execute(name: line, args: yaml) → {result, success, content_type?}（async 可）
- 可选命名导出 close()——run 终态收时调用（有资源要还的模块用;无则跳过）
- 不导出工具名单——白名单/requires_commit/output_schema 权威恒在 tool_servers 声明侧（与 mcp 同构:实现侧自报不可信原则对内同样成立,声明单一事实源）
```

**关键逻辑（HopSop）**：

```
execute(name, args) 经 in-process 成员:
1. [branch] 白名单查（同 mcp:不在 entry.tools 即拒）
2. [act] 发端校验：args vs 声明 input_schema（required+type 浅检,与 mcp 同一校验器）——
   in-process 无发现源,声明即唯一 schema 源;不声明=发端放行（收端 output_schema 照常）
3. [act] 惰性装载：首次调用 dynamic import(module 绝对路径)
  3.1. [case(import 失败/缺 execute 导出)] EXT_MODULE_LOAD_FAILED=该次调用 fail（错误带模块路径+原因）
4. [act] mod.execute(name, args) → 结果归一（非 ToolResult 形状=EXT_TOOL_BAD_RESULT fail）
  4.1. [case(模块抛异常)] EXT_TOOL_ERROR=该次调用 fail（截断进错误——引擎进程存活:同步异常被 catch 罩住;
       进程级破坏〔process.exit/段错误〕不设防——失去进程隔离正是本档的代价,资格卡审计状态的原因）
5. unwrap/shape/audit 归 Composite 层（与 mcp 成员完全同构——server 归属+耗时照记）
run 终态收: mod.close?.() 尽力而为（与 mcp close 同语义）
```

无超时钟（区别于 mcp）：进程内函数调用无网络挂死面；经审计代码的死循环=引擎 bug 同级事件，不设运行时防护（防了也防不住——同进程无法安全中断）。

## 工具 server 生命周期总图【契约】 ^anc-exec-tool-server-lifecycle

一次 standalone 运行中，外部工具 server 的完整生命线——stdio 与 http 同一骨架，差别只在"进程在谁手里"：

```
宿主会话（CC/Codex）
   │ spawn hopjit-mcp（会话建立/首调用时——宿主定策）
   ▼
hopjit-mcp server ──────────────────────────────────────── 生命线：随宿主会话（stdin EOF 即退）
   │ start_run
   ▼
run（状态机，真身在 .hopstate 盘上）───────────────────────── 生命线：跨进程存活（快照恢复）
   │
   │ ①注册期（run 启动）：loadToolRegistry(tools_file) → 装配 CompositeToolProvider
   │    - 只做声明加载与名字判重（fail-fast）——不连接、不 spawn（server 零感知）
   │
   │ ②惰性连接（首次调用该 server 的工具时才发生；后续调用复用连接）：
   │    ┌─ stdio：spawn(command, args, env=白名单)──→ 本地子进程 ─┐
   │    │         初始化握手（SDK：initialize+会话流自动）          │ 工具 server
   │    └─ http： 连接 url（Authorization: Bearer <auth_env 解引用>）┘ 生命线：见④
   │    连接后一次 tools/list 发现：白名单缺席→warn 漂移；无 schema 声明→补全（发端校验源）
   │    连接失败=该次调用 fail（错误带原始信息+未开通指路）——不重试，下次调用自然重连
   │
   │ ③调用期（每次工具调用）：
   │    发端校验（required+type 浅检，不合不发）→ tools/call → isError 截断进错误
   │    → Composite 层 unwrap 解包 → output_schema 校验（缺字段=SCHEMA_DEVIATION 入升级链）→ 裁剪
   │
   │ ④run 终态（completed/failed；paused 不收——连接随暂停闲置，resume 后续用）：
   │    Composite.close() 传导逐成员
   │    ┌─ stdio：SDK 三段收——stdin end →(2s)→ SIGTERM →(2s)→ SIGKILL（子进程必被收走）
   │    └─ http： 断开连接（无进程，远端 server 是别人的，不归我们收）
   │    收割失败只 warn 不拦终态（清理尽力而为）
   │
   │ ⑤崩溃面（任何一层进程死）：
   │    - 引擎进程死：stdio 子进程因管道破裂 EPIPE 自灭（兜底）；残留孤儿风险与宿主侧同水位
   │    - 工具 server 死：下次调用 MCP_CALL_FAILED=步骤 fail 走升级链（不做健康检查/自动重启）
   │    - run 状态不受任何工具 server 死活影响——工具结果已入 journal 的照常重放，
   │      未入的重跑该步（run 真身在盘上，工具 server 是无状态代理的哲学延伸）
   ▼
（下一个 run：从①重新开始——工具 server 状态是 run 级的，跨 run 不保留）
```

**stdio 与 http 的差别一句话**：stdio 的工具 server 进程**在我们手里**（spawn 起、三段收、白名单喂环境——监护全套是我们的责任与能力）；http 的进程**在别人手里**（我们只管连接与断开，"未开通/服务下线"等生死问题只能作为调用失败感知）。**net 内置组（批次三 http_get）沿同一骨架**：无连接态（每调用独立请求），生命周期图退化为只有③——注册期声明、调用期校验、无②④⑤（这正是"内置组 in-process"与"外部 server"的生命线差异：内置组根本没有独立生命线）。

**in-process 扩展成员的生命线（同骨架第三形态，2026-08-12 实装随补）**——没有进程与连接，②④⑤全部退化为模块装载语义：

```
①注册期：与 mcp 同（声明加载+判重——module 路径解析为绝对,不 import）
②惰性装载（代替惰性连接）：首次调用 dynamic import(module)——失败=该次调用 fail
   （EXT_MODULE_LOAD_FAILED 带路径+原因;无发现步——名单权威恒在声明侧,模块不自报）
③调用期：白名单查 → mod.execute 直调（无发端 schema 校验源可发现,声明有 input_schema 则
   Composite 层照常;无超时钟——进程内无网络挂死面）→ 结果归一（非 ToolResult 形状=
   EXT_TOOL_BAD_RESULT）→ unwrap/shape/audit 归 Composite（与 mcp 完全同构）
④run 终态：mod.close?.() 尽力而为（模块句柄置空;无进程可收）
⑤崩溃面：模块同步异常被 catch 罩住=该次调用 fail,引擎进程存活;
   进程级破坏（process.exit/段错误/失控死循环）不设防——与引擎共生死,
   这正是失去进程隔离的代价、资格卡审计状态的原因（对照:mcp 成员死=一次调用失败,引擎无恙）
（跨 run：模块句柄 run 级,下一 run 重新装载——与 mcp"工具 server 状态是 run 级"同则）
```

## 装配：CompositeToolProvider【契约】 ^anc-exec-tool-composite

```
# Spec: 工具装配器
Id: tool-composite-trait
Goal: 三来源工具（内置组/外部注册/宿主注入）合成一张工具面——消费方（body 解释器/LLM 循环/预检）只见统一 ToolProvider,不见来源差异
Outputs:
- list(): 全成员并集清单（tool_id 独立成条目,继承声明 requires_commit——语言面 ID 不豁免安全闸）
- execute(): 按名路由到成员 → 双端校验包住 → 带 audit 元信息（外部成员记 server 归属+耗时）的结果
Constraints:
- 同名即拒: 装配期全体 name/tool_id 判重,冲突=配置错误 fail-fast——不覆盖不遮蔽
- 装配期零连接: 构造只做声明与判重,外部 server 零感知（惰性连接归成员）
- close 传导: run 终态逐成员收,失败不拦终态

struct: CompositeToolProvider
  Id: tool-composite
  Fields:
    - members: [yaml]  # 成员清单：file 内置组（恒在）+ tool_servers 各 server + 宿主注入 ToolProvider（并入成员，不再整体替换）
```

**关键逻辑（HopSop）**：

```
装配（构造时一次）:
1. [act] 收集全部成员的工具清单（内置组 ToolDef + 注册文件 ToolSpec + 宿主注入 list()）
2. [act] 全局名字检查：name/tool_id 合并判重——冲突=配置错误 fail-fast（报冲突名与两来源）
3. [act] list() = 并集（mcp-server 工具面预检自动放宽为并集——hopkb 需求②在此兑现）

execute(name, args)（运行期逐调用）:
1. [act] 按 name（或 tool_id 反查 name）路由到成员
2. [act] 双端校验流程（见 ^anc-exec-tool-shape-check）包住成员的真实调用
```

- 消费面零变化：dispatcher 注入位 `hostConfig.tool_provider` 语义升级为"并入成员"（原整体替换语义废——宿主想加一个工具不再需要重实现文件十件）；四条工具通道（[[tool-channels]]）零感知；
- doc-ref 借用的沙箱校验三函数不经本装配，原样不动。

## 正反例要求【说明】

加载（合法/语法错/名冲突/凭证明文拒）、装配（并集/同名 fail-fast/宿主并入）、双端校验（发端拦/无声明 warn 放行/缺字段入升级链带明细/多余裁剪/unwrap 解包与解析失败）、语言面 ID（中文名经 tool_id 调用/tool_id 冲突拒）、time 内置（now/today 求值/journal 重放取记录值/条件里调用静态错误）——各正反成对。
