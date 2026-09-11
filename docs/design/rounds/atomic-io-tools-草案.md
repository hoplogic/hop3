# 工具接口标准与绑定机制分层设计草案（对齐稿 v2）

> 状态：**草案·决策点②已拍**（2026-08-12 作者定：in-process+mcp 两档，exec 挂起，进入落地规划；余③个决策点见 §五）（v4+参考设计；v4 作者裁 A 方案：长驻通道收敛 MCP wire+版本钉固,exec-daemon 撤；v3 双侧定位+双角色图+信任分档；v2——作者定分层："核心是接口标准先明确，基本上这是一个 typed-request-response 接口标准，机制可以是进程内、进程间、mcp 或其他方式"）。v1 的"工具组+组合器"与"MCP vs exec 之争"在本版收编为绑定层内部事务。对齐后按模块八件单落地。

## 一、分层总纲（作者定形）

```
┌─────────────────────────────────────────────────────────┐
│ 第一层：typed request-response 接口标准（本体，先明确）      │
│   工具 = name + input_schema + output_shape + effect      │
│   引擎只认这一层：按 schema 发请求、按 shape 校验响应、       │
│   按 effect 过探索/提交闸——与怎么送达完全无关               │
├─────────────────────────────────────────────────────────┤
│ 第二层：绑定机制（可插拔，各有适用场景，随时增种）             │
│   in-process | mcp（exec 挂起备用）| …（未来形态按需增）     │
└─────────────────────────────────────────────────────────┘
```

**分层的力量**：安全（effect）、契约（shape 校验）、审计（HopLog）、重放（journal）全部钉在第一层——**换绑定机制不换任何保障**。

**MCP 在此分层下的精确定性**（作者点破 2026-08-12）：MCP 本质是一个 **untyped-request-response 的进程间/远程调用机制**——严格说请求侧半 typed（有 inputSchema）、**响应侧 untyped**（content blocks 数组，无输出类型；后补的 outputSchema 可选且生态几乎不实现），effect 语义只是 untrusted hint。所以它只配做第二层的一种绑定：**类型与信任不从 MCP 来，从第一层来**——MCP 的粗糙被分层隔离，生态复用价值保留。

**双侧定位（作者终裁 2026-08-12，本轮讨论收口）**：
- **CC/Codex 侧：MCP 是最好的伴生出沙箱形态**——"随主 agent 进程启停、不在沙箱内的 daemon"这个位置（长驻状态+出箱授权+宿主托管监护）只有 MCP 一个入口，宿主的沙箱与授权体系决定了没有更好的选择。hopkb-mcp v0 照做；
- **独立模式侧：有更好的用法**（v4 随 A 方案定形——"更好的选择"不是另立协议，是**只用 MCP 的传输半、语义半换成第一层**）：引擎作为 client 只消费 initialize+tools/call 最小子集，发现跳过（清单在 hoptools.yaml）、annotations 不信（effect 在第一层）、content blocks 解出即过 shape 校验——MCP 替陌生宿主设计的防护面被裁剪到零，传输半（stdio 长驻+JSON-RPC 配对）保留复用。自家插件与第三方现成 server 由此同走一条 mcp 绑定。

## 二、第一层：工具接口标准【核心，先明确】

### ToolSpec（typed request-response 的类型面）

```
struct: ToolSpec
  Id: tool-spec
  Fields:
    - name: line          # 全局唯一（同名冲突=配置错误 fail-fast，作者既裁）
    - description: line
    - input_schema: yaml  # 请求类型（JSON Schema）——引擎发调用前校验实参
    - output_shape: yaml  # 响应类型——引擎收结果后校验：缺字段拒收（同 SCHEMA_MISMATCH 语义）、多字段裁剪
    - effect: line        # 枚举 pure/read/write——副作用分级，权威在此不在实现侧申报
    - binding: ToolBinding # 怎么送达（第二层，见下）
```

要点：

1. **effect 三级取代 requires_commit 成为分级源**（requires_commit 保留为 `effect == 'write'` 的派生投影，ToolProvider 契约不破）：pure=纯计算、read=只读 IO、write=不可逆出箱（act 拦截、commit 放行）。**分级写在引擎侧声明，不信实现侧自报**——MCP server 的 destructiveHint 只能收紧不能放宽；
2. **output_shape 是新增硬契约**：这正是签名注册表单（[[../../TODO#^todo-tool-contract-registry]]）的核心语义——该单就此并入本设计（其"注册表文件"=本设计 ToolSpec 集合的文件形态）。响应侧 typed 是对 MCP untyped 缺口的直接补位；
3. **请求-响应双端校验**：实参不合 schema 不发（省一次外部往返），结果不合 shape 不收（膨胀/漂移无处落地——data-quality 34vs36 口径漂移同型问题的根治位）。

### 与四条工具通道的关系

通道 ②③④（[[../tool-channels]]）消费面不变：②独立模式引擎直调、③复用模式 tool_request 外发（**附 ToolSpec 签名**——执行方照契约实现不再猜）、④ LLM 循环 tools 注入。变化只有一处：通道出入口挂 schema/shape 双校验。

### 工具的声明位

- **内置工具**：ToolSpec 内嵌代码（file 九件补 effect/output_shape——存量语义不变；effect 全 read，作者 2026-08-10 既裁"不可逆分界=出箱与否"）；
- **外部工具**：环境配置级注册文件 `hoptools.yaml`（ToolSpec 列表；定位沿"焊死"原则——`--tools <file>` 显式 > 工作区固定路径，不搜不猜）；
- **宿主 programmatic 注入**：ToolProvider 注入位不变，ToolDef 按最小集映射 ToolSpec（无 shape 声明按向后兼容语义：warn+自由形状）。

### 双角色总图（作者定形 2026-08-12）

独立模式下 hopjit 同时站在 MCP 的两端，姿势不同：

```
角色一：hopjit 作为 daemon（被 CC/Codex 调起——对上）
  CC/Codex ──MCP──▶ hopjit-mcp（伴生出沙箱 daemon，四工具面；姿势随宿主，MCP 唯一入口）

角色二：hopjit 作为主（自己的宿主——对下，插件机制自主定义）
  hopjit 引擎 ──ToolSpec+绑定──▶ 工具插件们（本设计即 hopjit 的插件标准）
```

库内命名纪律：mcp-server 模块恒指角色一（上行协议壳）；mcp 绑定指角色二收编第三方的下行通道——同协议反方向，正式稿显式区分不混称。

## 三、第二层：绑定机制【可插拔】

```
struct: ToolBinding
  Id: tool-binding
  Fields:
    - kind: line   # 枚举 in-process/mcp（作者定 2026-08-12 两档收敛；exec 挂起备用——真出现'单调用即弃隔离'需求时以 mcp 的 restart_per_call 选项或复活 exec 覆盖）
```

| kind | 机制 | 附加字段 | 生命周期 | 适用 |
|---|---|---|---|---|
| **in-process** | 引擎内函数调用 | —（注册名） | 无 | **内置组 + 经审计的内部扩展模块**（资格=在库内工程链上：设计三件套/锚点/正反例/模块盘点齐备——机检可查不新发明守卫）。未审计代码不得入内（作者定 2026-08-12）：进程边界是崩溃安全模型的地基——真相在盘上的前提=故障以进程为单位 |
<!-- 勘误 2026-08-12：上行"在库内工程链上"措辞有歧义（曾被误读为并入主库）——作者纠正：扩展模块=与主代码库隔离的独立工具库,走自己库的工程链,一行不进本库;in-process 仅指运行形态。现行权威见 tool-interface.md 绑定机制节。 -->
| ~~exec~~（挂起） | 每调用一进程 stdin/stdout JSON——设计留档，首批不实现 | — | — | 挂起理由：无状态工具同样可走 mcp（server 一次调用即收）；免握手省毫秒级；留两 driver=双倍维护。复活触发=单调用即弃隔离的真实需求 |
| **mcp** | 长驻子进程，MCP wire 最小子集（作者裁 A 2026-08-12：**传输半复用 MCP、语义半用第一层**——引擎只消费 initialize+tools/call 两方法，跳过 tools/list 发现〔清单在 hoptools.yaml〕，content blocks 解出即过 output_shape 校验〔untyped 在边界 typed 化〕，annotations 不信〔effect 在第一层〕） | command/args/env_passthrough | 随 run 起停（spawn→EOF→SIGTERM→SIGKILL；不做健康检查/重启/热更新——hopkb 单既定边界） | **长驻统一通道**：自家有状态插件与第三方现成 server 同走此道——自家的带 shape/effect 声明，第三方靠引擎侧声明收紧。hopkb 一个 server 两侧通吃（对上挂宿主/对下接引擎） |

**选型判据（两个属性定绑定）**：

选型判据一句话（两档收敛后）：**引擎内 in-process（凭审计资格），引擎外 mcp（最小子集+版本钉固）**——无状态/有状态、自家/第三方全走 mcp 单通道。

（CC/Codex 宿主侧的工具选型不在此表——那是宿主的沙箱与 MCP 体系，引擎不参与；hopkb 形态随 A 方案再简化：**一个 hopkb-mcp server 两侧通吃**——对上挂 CC/Codex、对下接 hopjit mcp 绑定，连双入口都不需要了。）

**信任升级通道（作者定 2026-08-12）**：绑定档位=信任分档——mcp 是零门槛起步档（隔离兜底，ToolSpec 门口校验即全部要求）；插件用出真价值、性能确有需要时，**过库内工程链审计升格 in-process**（换零序列化与进程内共享位）。语言不是分界（exec 家族本就语言无关——stdin/stdout JSON 对任何语言一视同仁），**审计状态才是**；MCP 的不可替代域相应收敛为"代码不归我们改的现成 server"一项。

要点：

1. **绑定层零信任**：无论哪种 kind，effect/shape 都在第一层判——mcp 的 tools/list 申报只用于发现（比对注册声明一致性），不用于授权；响应 content blocks 解出后**同样过 output_shape 校验**（untyped 通道的产物在边界被 typed 化）；
2. **hopkb 形态**：一个 hopkb-mcp server 两侧通吃（对上挂宿主/对下接引擎 mcp 绑定）；
3. **故障语义统一**：绑定失败（起不来/超时/坏 JSON/shape 不合）=步骤 fail 走既有升级链，零新失败通道（hopkb 需求③既裁）；
4. **MCP 版本钉固三层锁**（作者问"能锁定版本么"——能，且场景好锁）：①npm lockfile 钉 SDK；②initialize 握手显式钉协商版本不追 LATEST（自家插件两端约定恒用钉固版）；③使用面只取 initialize+tools/call 最小子集——历次协议演进（SSE→Streamable HTTP/outputSchema/annotations）全落在不用的面上。追新只发生在"要接的第三方 server 只支持新版本"时——要新能力付新成本的正常交易，非被动税；
5. **exec-daemon 独立协议撤销**（A 方案推论）：其论证的三优势在"MCP 最小子集"下逐个消解（content blocks 解一层≈零成本且 shape 校验横竖要做/监护同套/MCP SDK 各语言成熟）；NDJSON 方言设计留讨论记录不进正式稿。exec（无状态即弃型）保留——它真没有握手需求。

## 四、引擎侧装配（v1 收敛的实现件）

- `CompositeToolProvider`：按 name 路由到绑定实现，list()=全部 ToolSpec 并集，同名 fail-fast——通道 ②③④ 消费它，透明；
- `ExecBinding` / `McpBinding` 两个绑定 driver（in-process 即现有工具组，零新件）；
- StandaloneConfig 扩展：`tools_file?: line` 指向 hoptools.yaml（hopkb 单的 `tool_servers` 字段被 hoptools.yaml 的 binding 吸收——配置单一入口不变量保持）；
- sandbox 门控归工具实现层：net 组过 NetworkSandbox、file 组过 FilesystemSandbox——绑定与沙箱正交。

## 参考设计：百炼 WebSearch/amap 两真实样本（2026-08-12 实测，作者定为参考件）

**实测档案**（同一把通用 key，逐服务在 MCP 广场单独开通）：

| 服务 | protocolVersion | 工具面 | 返回形态 |
|---|---|---|---|
| WebSearch（`/api/v1/mcps/WebSearch/mcp`） | 2024-11-05 | 1 工具，**零 outputSchema 零 annotations** | text 块内嵌 JSON 字符串：`{pages:[{snippet,hostname,hostlogo,title,url}],request_id,tools,status}` |
| amap-maps（`/api/v1/mcps/amap-maps/mcp`） | 2025-03-26 | 15 工具，**同样全裸** | 同形态（text 块内嵌 JSON） |
| 法律/deli-mcp-server（服务名=市场 ID `market-cmgjmcp00074976`） | **2025-06-18** | 2 工具（类案/法规检索），无 outputSchema 但 **annotations 在场且标错**（见实证④） | 同形态；**强制会话流**（无 Mcp-Session-Id 即 400——须 initialize+initialized 通知后调用，前两家无此要求） |
| 企业工商/天眼启信（服务名=市场 ID `market-cmapi029030`） | 2025-06-18 | **19 工具全裸**；**工具名是中文**（"企业工商数据模糊查询"等）；server 名是营销文案（"【八年老店】…"） | 同形态；错参调用时 isError:true 且 text 里塞**上游网关 404 原始报文**（headers 全套）——错误也是 untyped |

六条实证（每条一个生产服务背书，直接进第一层设计依据）：

1. **多版本共存**：同平台三个服务三个协议版本（2024-11-05 / 2025-03-26 / 2025-06-18）——server 说了算，SDK 5 版本支持列表全兜住；
2. **untyped 是生态常态**：37 工具零个带 outputSchema；
3. **"未开通"是真实故障形态**：404 + 中文业务文案（非 JSON-RPC），另有 ~30s"开通中"过渡态——mcp 绑定的 fail-fast 报错须识别并指路"MCP 广场逐服务开通"；
4. **annotations 不仅缺失还会标错（实锤非推测）**：法律服务的纯只读检索标 `readOnlyHint:false, destructiveHint:true`（把只读搜索标成破坏性写）——照信它则 act 步骤全拦、工具废掉。第一层 effect 由我们声明是唯一可信来源；
5. **工具名可以是任意 Unicode**：企业工商服务 19 个中文工具名。ToolSpec.name 的全局唯一按字符串等值判即可，但 hop_python body 调用名须是合法标识符——**中文名工具须在声明里起别名**（`alias` 字段，转正式稿补进 ToolSpec 文法）；
6. **错误响应同样 untyped**：错参调用返回 isError:true + text 里塞上游网关 404 原始报文——绑定层错误摘要须截断防日志爆炸。

**hoptools.yaml 参考声明**（第一层文法首份实例——shape/effect 全部由我们声明，server 一概没给）：

```yaml
tool_servers:
  - name: bailian_search
    binding: { kind: mcp, transport: http, url: "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp", auth_env: DASHSCOPE_API_KEY }
    tools:
      - name: bailian_web_search
        effect: read                      # 我们声明——server 无 annotations
        # input_schema 可省：server 的 tools/list 有（query 必填/count 默认 5），引擎发现时比对一致性
        output_shape:                     # 我们声明——server 无 outputSchema；照实测返回定
          pages: [{ snippet: text, title: line, url: line, hostname: line }]
        unwrap: json-in-text              # 百炼系惯例：text 块内嵌 JSON 字符串,解开再过 shape 校验
  - name: amap
    binding: { kind: mcp, transport: http, url: "https://dashscope.aliyuncs.com/api/v1/mcps/amap-maps/mcp", auth_env: DASHSCOPE_API_KEY }
    tools:
      - name: maps_geo
        effect: read
        output_shape: { results: [{ country: line, province: line, city: line, location: line }] }
        unwrap: json-in-text
      - name: maps_text_search
        effect: read
        output_shape: { pois: [yaml] }    # 粗粒度声明也合法——校验只查声明了的字段
        unwrap: json-in-text
      # 其余 12 工具未声明=不进本引擎工具面（白名单语义:声明即启用,不整包放行）
      # 注:maps_schema_take_taxi/navi 生成唤端 URI——效果 read 但语义上是"引导外部动作",
      # 启用前逐个斟酌 effect 定级,这正是逐工具声明的价值
  - name: law
    binding: { kind: mcp, transport: http, url: "https://dashscope.aliyuncs.com/api/v1/mcps/market-cmgjmcp00074976/mcp", auth_env: DASHSCOPE_API_KEY }
    # 服务名=市场 ID（百炼第三方托管服务的命名惯例）;该 server 强制会话流（SDK 自动处理）
    tools:
      - name: ali-case-list
        effect: read      # 我们声明 read——server 自报 destructiveHint:true 是错的（只读检索标破坏性写）,实锤"声明权在引擎侧"
        output_shape: { success: bool, data: yaml }
        unwrap: json-in-text
      - name: ali-law-list
        effect: read
        output_shape: { success: bool, data: yaml }
        unwrap: json-in-text
  - name: biz_registry
    binding: { kind: mcp, transport: http, url: "https://dashscope.aliyuncs.com/api/v1/mcps/market-cmapi029030/mcp", auth_env: DASHSCOPE_API_KEY }
    tools:
      - name: 企业工商数据模糊查询
        alias: company_search       # 中文工具名在 hop_python body 不可直接调用——别名进 body 通道,原名走 wire
        effect: read
        output_shape: { status: line, data: yaml }
        unwrap: json-in-text
      # 其余 18 工具(年报/失信/诉讼/画像等)按需逐个启用——白名单语义
```

参考声明带出的四个文法细节（转正式稿时定形）：①`tools` 子表=白名单（server 报 15 个我们只放行声明过的）；②`unwrap: json-in-text` 处理百炼系"text 块套 JSON"惯例——解开后过 shape 校验（untyped 在边界 typed 化的具体机构）；③`auth_env` 沿 api_key_env 同纪律（名字引用不存值）；④input_schema 缺省从 server 发现+一致性比对，output_shape 无处发现必须声明。

## 五、决策点（请拍板）

1. **effect 三级枚举与 requires_commit 关系**：requires_commit 降为派生投影（=write），ToolProvider 契约字段保留但不再是声明源。认不认；
2. ~~首批交付范围~~：**已拍（作者定 2026-08-12）**——in-process + mcp 两档；exec 挂起。范围=第一层标准 + CompositeToolProvider + mcp 绑定 + net/time 内置组（见文末落地规划）；
3. **output_shape 校验松紧**：有 shape 声明即硬校验（缺字段拒收+多字段裁剪）；无声明（宿主注入/过渡期）warn+自由形状。认不认；
4. **time 归工具**：now() 破"builtin 环境无关"概念锁，走工具通道 journal 记值保重放。认不认。

## 六、与既有账的合并关系

- `^todo-tool-contract-registry` → **升格为本设计第一层**（in/out/effect 核心语义全数落位），原单销、锚保留指向本设计；
- `^todo-standalone-external-tools`（hopkb 五点）→ ①配置入口改 hoptools.yaml 承载、②同名 fail-fast+预检并集进 CompositeToolProvider、③失败语义/④effect 分级/⑤超时日志全数保留——形态从"MCP 唯一"放宽为"绑定之一"（须作者确认改注）；
- [[../tool-channels]]：五通道表不动，新增"接口标准层"一节挂本设计正式稿。

## 七、落地规划（决策点②已拍后的批次划分）

> 前置：§五余下三决策点（①effect 三级 ③shape 校验松紧 ④time 归工具）随批一拍即开工——三者都只影响批次一的细节，不阻塞规划本身。

**批次一：第一层标准 + 装配骨架**（纯引擎内，零外部依赖，可独立交付）
- 概念层：核心规范 act 工具调用节补"工具签名"契约（签名两模式同源）；
- 设计正式稿：新 `tool-interface.md`（ToolSpec/ToolBinding HopType 全文法：name/alias/input_schema/output_shape/effect/unwrap + hoptools.yaml 文件格式 + 双端校验语义 + 白名单启用语义）——吸收本草案第一二层；tools.md/shared-providers.md/tool-channels.md 联动改定；
- 代码：ToolSpec 类型 + hoptools.yaml 加载（fail-fast 校验，沿 loadStandaloneConfig 先例）+ CompositeToolProvider（并集/同名 fail-fast/按名路由）+ 双端校验（输入 schema 拦发/输出 shape 拒收裁剪）+ file 九件补 effect 声明（存量语义零变化）；
- 测试：正反例按既有密度（加载/组合/校验/别名各正反）；
- 交付判据：既有全量测试零回归 + 新面正反例全绿。

**批次二：mcp 绑定**（依赖批次一的 ToolSpec 消费面）
- 设计：mcp 绑定条款进 tool-interface.md（最小子集 initialize+tools/call/会话流/unwrap/错误截断/未开通指路/监护三段收）+ mcp-server.md 命名纪律注记（上行壳 vs 下行绑定）；
- 代码：McpBinding（SDK client 复用现有依赖）+ 生命周期监护（随 run 起停）+ {发现比对：server tools/list vs 声明一致性 warn}；
- 测试：mock server 正反例 + 四服务实测形态回归 fixture（json-in-text/中文名/错误截断/未开通文案）；
- 联测：hoptools.yaml 配 WebSearch+amap 真机冒烟（standalone 跑含工具 spec 到 completed）。

**批次三：net/time 内置组**（与批次二并行可做，互不依赖）
- net：http_get（NetworkSandbox trusted_hosts 白名单，空=全拒；effect read）；
- time：now/today（journal 记值保重放；决策点④拍"归工具"即做，拍"归 builtin"则移出本单）；
- sandbox.md network 节从"设计已定无实现"转实装对齐。

**批次四（后置，非本单）**：hopkb-mcp 联测（hopkb 侧交付后）、经审计内部扩展首例（真需求出现时）、exec 复活评估（单调用隔离需求出现时）。
