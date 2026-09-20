%% @trace
	id: hopspec-v3-core
	type: intent
%%

> HopSpec 核心规范 v3.0

## 定位

HopSpec 是双态通用编程语言：代码逻辑与 LLM 推理在同一套语法中无缝混合，供人对齐意图，供机编排执行，供业务持续演进。

当前自主 Agent 处理任务面临两个核心痛点：
+ **生产型任务不可靠**——当前纯自然语言 skill 缺乏双态融合支持，子任务执行完整比例普遍不到 85%，LLM 步骤静默失败、结果无核验、异常无修复路径；
+ **探索型任务不安全**——可逆操作（试算、草稿）与不可逆操作（发邮件、写库、支付）不加区分，agent 尝试探索过程中往往导致不可逆的严重后果，删邮件、删代码、删库时有发生。

HopSpec 从三个维度解决这一问题：
- **供人对齐——结构化逻辑、显性控制** ：HopSpec 用自然语言描述任务逻辑，不需要编程背景就能审查、确认和参与迭代。人机对齐的门槛从"能写代码"降到"能读懂意图"，显式控制点确保关键决策不失控
- **供机执行——双态验证、探索提交分离、自适应修复** ： HopJIT 将代码骨干与智能节点双态融合执行，核验内置，确保 LLM 执行正确可靠。**探索提交分离**（act/commit）将不可逆副作用隔离到显式 commit 节点，act 步骤可安全重做——异常时自适应修复，无需人工重编程即可适应变化
- **供业务演进——自主探索、放心尝试、渐进固化** ： 业务逻辑从硬编码走向结构化编排，从程序员独占走向业务方可参与。新场景下只需给出目标和约束，探索提交分离确保探索过程无不可逆后果——agent 自主规划探索路径，并在 HopSpec 框架下放心尝试、安全重试，成功经验**渐进固化**为可复用的最佳实践——系统越用越聪明

**语言设计第一原则：普通人易于理解，不必要不增加复杂度**——HopSpec 的读者与作者是业务方而非程序员，每一个语法构造都要过这道门：它让普通人更容易表达和读懂意图吗？凡是程序员习惯里有、但普通人不需要的能力（语法糖、便利特性、第二种写法），一律不进语言——复杂度是持续成本，加上去就要被每个读 spec 的人付一遍。

总体方向：**锁定目标，守住边界，放开路径**——WHAT（目标、约束、交付）不可变，HOW（步骤、策略）在契约边界内可自适应。边界由结构化逻辑控制、探索提交分离、双态验证等机制守住。

在具体应用时，HopSpec 往往由 LLM Agent 基于自然语言 Skill 转换而形成 HopSkill，由 HopJIT 引擎执行并管控执行状态（进度、产出、失败处理）。

### 两层架构分离

HopSpec/HopJIT 体系严格分为两层：

**控制层（环境无关）**——HopSpec 语法、AST、验证规则、执行状态机、变量作用域、Prompt 组装、retry/adaptive、失败升级。纯逻辑，不关心执行环境是 TypeScript/Python/Rust，不关心 LLM 是 Claude/DeepSeek/GPT，不关心文件系统是本地/云端。

**宿主适配层（环境绑定）**——工具实现（ToolProvider）、沙箱执行（SandboxConfig）、LLM 客户端（ModelEngine）、凭证管理（IdentityProvider）、知识检索（KnowledgeProvider）。和部署环境强绑定——CC 宿主用 TypeScript + Anthropic SDK，Python 宿主用 httpx + 本地库，容器宿主用 Docker 隔离。

两层之间的契约边界是 **Provider 接口**：ToolProvider / KnowledgeProvider / IdentityProvider。控制层只通过这些接口和外界交互，不直接碰文件系统、网络、数据库、LLM API。

这意味着：
- HopSpec 规约本身是跨语言、跨平台的——同一份 Spec 可以被 TypeScript 引擎执行，也可以被 Python 引擎执行
- 沙箱、工具、模型路由都是宿主的职责——控制层只管"调什么工具、传什么参数"，不管工具怎么实现
- act 步骤只能调用宿主预注册的受控工具，没有任意代码执行能力——安全由工具接口保障。act 执行期不做推理（见 [[#^anc-step-act]]），其工具调用是 body 既定内容、按序执行；具体执行体随驱动模式而定（独立模式由引擎执行、复用模式由 caller 执行），但语法与安全边界一致

具体特色详见 [[HopSpec核心创新]]。

---

## HopSpec规约结构 ^anc-ast-spec-structure

```
# Spec: <标题>                          # 必选
Id: <标识符>                            # 可选，供 call 引用
Goal: <一句话目标>                      # 必选
> <补充说明>                            # 可选多行，展开说明
Constraints:                            # 可选多项，任务约束
- <约束>
Types:                                  # 可选多项，复用类型定义
- <TypeName>:  # 说明
  - <field>: <type>  # 说明
Inputs:                                 # 可选多项，Spec 级输入声明
- <var>: <type>  # 说明
Outputs:                                # 可选多项，Spec 级输出声明
- <var>: <type>  # 说明
Tools:                                  # 可选多项，工具需求声明（本 spec 假定的外部工具面——见「工具声明两面」）
- <tool>(<param>, …) -> <out>: <type>  # 一句话用途（requires_commit 者注明）
  - <param>: <type>  # 逐参数说明——写到杜绝望词生义（值语义/取值来源/错用后果）
  > 可选扩展：跨参数的复杂语义（幂等性/上限/调用纪律）
Config:                                 # 可选，Spec 级运行时配置
  model: <service/model>                # Spec 默认模型（覆盖全局配置）
## Steps                                # 有 Steps → 具体实现；无 Steps → HopTrait（Hop契约，见下方说明）
N. [type] <一句话任务描述>
  - ← <var>                             # 可选多项，输入变量
  + → <var>: <type>  # 说明             # 可选多项，输出变量
  > <执行说明>                          # 可选多行，Step 展开说明
  N.N. [type] <子步骤描述>
    - ← <var>
    + → <var>: <type>  # 说明
    > <执行说明>
```

| 区域             | 必选    | 说明                                                                                                                                                                                                                                              |
| -------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `# Spec: <标题>` | **是** | 规约标题                                                                                                                                                                                                                                            |
| `Id: <标识符>`    | 否     | Spec 标识符，供其他 spec 通过 `[call]` 引用<br>含 `[commit]` 步骤的 spec，id 应以 `_commit` 为后缀<br>**可选函数签名形式** `Id: func(in1, in2) -> out1, out2`——一眼读懂调用面；id 仍=func 名；签名只列**名字**（类型归 Inputs/Outputs 展开块，权威仍是展开块，签名是索引）；写了签名就必须与 Inputs/Outputs 按名完全对应（多/漏/错名报错） |
| `Goal: <目标>`   | **是** | 一句话目标                                                                                                                                                                                                                                           |
| `> <补充说明>`     | 否     | Goal 的展开说明                                                                                                                                                                                                                                      |
| `Constraints:` | 否     | 约束条件列表，包括预期目标（如行数保留率 ≥ 90%）和硬性限制                                                                                                                                                                                                                |
| `Types:`       | 否     | 复用类型定义，首字母大写，步骤中直接引用                                                                                                                                                                                                                            |
| `Inputs:`      | 否     | Spec 级输入变量声明，供 `[call]` 调用时传参映射                                                                                                                                                                                                                 |
| `Outputs:`     | 否     | Spec 级输出变量声明，定义交付物=**完备性契约**。初始为 `None`，执行过程中应由步骤赋值；执行结束时仍为 `None` 的输出变量=完备性违约，run 判 **failed**（failure_reason 指明缺哪个输出——"completed 零产出"是假绿,下游信号链每层都被骗;2026-08-17 hopkb 实撞改判,原 warning 档废）。静态侧配对闸：声明输出在全 spec 无任何产出点（步骤 `+ →`/call 输出映射/exit 交付）时 validate 即 error（无 Steps 的能力声明 spec 天然豁免）                                                                                                                                                                |
| `Tools:`       | 否     | 工具需求声明（本 spec 假定的外部工具面）——逐参数 HopSchema 条目+`>` 扩展；引擎 init 与环境注册面对账，缺工具/签名不兼容当场报错。两面关系见「工具声明两面」（^anc-tool-two-faces）                                                                                                                             |
| `Config:`      | 否     | Spec 级运行时配置。`model: service/model` 设置默认模型                                                                                                                                                                                                       |
| `## Steps`     | 条件    | 有 Steps：具体实现，至少一个步骤。无 Steps：**HopTrait（Hop契约）**——仅由 Goal/Constraints/Inputs/Outputs 定义接口契约，由 HopJIT 有序思考生成执行路径或从 Spec 库匹配（见 [[HopType体系#^anc-hoptype-hoptrait]]）                                                                                                                                       |

### 内容章节：写进文件的就是要供给的 ^anc-ast-narrative-sections

规约结构之外，spec 文件里还可以写**内容章节**——任何非关键字的 `##` 节（如 `## 背景`、`## 参考`），只要节内没有步骤行，就是给执行 LLM 的**缺省供给**（2026-08-27 作者定："写在 spec 文件的内容章节，就是缺省要供给的内容"——一文件即一供给单元，任务的语境与计划同住同供，不需要标记、不需要引用）。执行期这些章节全文注入 spec 级知识通道（全程恒定）。两个例外：**不供给的节**——节名带 `(不供给)` 或 `(private)` 标注的，以及**惯例名单命中的**（现只 `处置记录` 一个：任务卡跨载体惯例的追加式流水账，标题免带标记保持干净——2026-08-29 作者定，实物落地后"(不供给)进标题"太丑，引擎认惯例名与 git 认 .gitignore 同理），留给人读、不喂执行 LLM；节内含步骤行的是标题风分区（Obsidian 折叠惯例），不是内容章节。

### Spec 的两种形态

- **有 Steps 的 Spec**（具体实现）：完整定义执行路径，HopJIT 按步骤执行
- **无 Steps 的 Spec = HopTrait（Hop契约）**：只定义 Goal、Constraints、Inputs、Outputs——接口契约（定名见 [[HopType体系#^anc-hoptype-hoptrait]]）。HopJIT 收到后启动有序思考，自主生成执行路径并验证，或从 Spec 库匹配已沉淀的实现。调用方通过 `call` 调用时无需区分对方是哪种形态

这是 HopSpec"锁定目标，放开路径"的极致体现：连 Steps 都可以不写，由 HopJIT 从零探索。详见 [[HopSpec V3扩展-有序思考与渐进固化]]。

---

## 步骤类型

15 种步骤类型，分三组：

### 工作节点（叶子）

- `reason`：需要 LLM 推理的分析、判断、决策，产出新知识；关键产出后应安排 check ^anc-step-reason
	- 描述+执行说明+规约层信息整合后应足以构建可用 prompt；单个 reason 平铺推理，分支/循环升 HopSpec 结构表达；引擎可内部拆环节执行（≤5 步），Spec 层面仍为单步
- `act`：**无推理、无循环**的计算与工具调用（推理归 reason、循环归 loop）；必须无不可逆副作用，可安全重做 ^anc-step-act
	- **body=无推理编排**：纯计算表达式 + 预注册受控工具调用 + 无推理分支（`if 确定性条件`——条件确定性求值，不得让 LLM 判断）；数据 `←` 入、局部顺传、`+ →` 出。语言载体 = **hop_python**（见 [[#^anc-step-act-body-lang]]：受限子集/白名单/工具命名空间）
	- **`[act free]` 自由任务档（2026-08-22 作者定形："act 应该努力简化,但如果实在拆不开,也可以承认现状"→显式修饰落地）**：构建时应**努力简化**——纯机械动作写成 body（执行期零 LLM）,复合任务按结构分拆;**实在拆不开的复杂任务,标 `free` 修饰承载**（中文词 `开放`,2026-08-26 作者定——`[探索 开放]` ≡ `[act free]`,术语表 [[../design/i18n#^anc-i18n-glossary]]）——描述即任务,执行者可推理、可调用受控工具（复用模式由 caller 智能体执行,独立模式由引擎带工具面的 LLM 循环执行）。**没有 free 修饰的 act 就应当带 hop_python body**（无 free 无 body=形态欠账,validate 警告督促:要么补 body 要么标 free 承认现状）。free 合法化的是承载形态不是免纪律：无不可逆副作用/可安全重做的本约不变（不可逆归 commit,free 不可作提交载体）;含 free 步骤的 spec 属"含自由节点"形态,产物定档按此如实标注
	- **禁循环语句**（for/while 需 max 上限保护与迭代作用域管理，必须升 loop 步骤）；**列表推导可用**（2026-08-19 作者拍板）：`[expr for x in xs]` 与带滤 `[expr for x in xs if cond]`——纯映射/过滤,迭代次数=列表长度天然有界、零跨迭代状态,不违禁循环本意（典型:`[i.name for i in inputs]` 从对象列表提字段名单——此前此类构造只能靠 LLM 动脑,工具参数拼装被迫走转述面）;体内 expr/cond 同普通表达式文法（可字段下钻/调 pure 内置,禁工具调用;推导嵌套深度≤2——外层过滤+内层聚合谓词是典型合法形态,如 `[x for x in xs if any([startswith(x, g) for g in gs])]`,三层以上升 loop 步骤或拆中间变量〔2026-09-03 作者拍板放宽原禁嵌套:全面放开太危险、仅限 any/all 实参位又太复杂,深度≤2 一句话可判定〕）；body 分支管"本步输出值怎么算"，业务路径分流升 HopSpec branch（case 产出可被后继引用）
	- **生成期 vs 执行期**：body 由 LLM 规划/重规划时生成，执行期严格照 body 执行零推理
- `commit`：**有不可逆外部副作用**的计算与工具调用（发送/支付/写生产库） ^anc-step-commit
	- body 定义与语言载体同 act（hop_python，无推理/禁循环/确定性分支，见 [[#^anc-step-act-body-lang]]），差别有三：①副作用不可逆、不可重试；②**工具面更开放**——标 `requires_commit` 的不可逆工具（发送/支付/写库类）只有 commit body 能调，act 内调用即拒（COMMIT_REQUIRED）；③**写域更宽**——内置文件工具的写侧 act 限 work_zone、commit 才可写整个 workspace（见 [[#^anc-step-act-body-lang]] 工具组条款，作者定 2026-08-28）：持久产物写盘是交付动作，归 commit 承载。**推荐幂等设计**（按业务键 upsert 而非无条件 insert——崩溃重放不重复扣款）
	- 出现在 `subtask retry/adaptive` 内时**前序必须有把关步骤**（同容器内位于其前的 `confirm` 或 `check`/`check final` 任一）
	- **commit 执行后祖先事务退火（2026-08-20 作者定）**：一个 commit 成功执行后，**重跑范围盖到它的全部祖先 subtask/case 边界不再能 retry**——此后任何失败触发到这些边界的 retry 时**立刻升格为 fail**（不重跑,继续沿升级链上报），防止 commit 被整组重跑再次执行。不可逆动作是事务的单向阀：commit 前是可重试的探索区,commit 后整条祖先链只能向前走或如实失败——**幂等设计是补充防线不是替代**（幂等管"崩溃重放不加害",退火管"引擎不制造重放"）。**退火判据=重跑范围**（2026-09-02 定,治两向失准:前轮记录焊死新轮=假阳性,外层边界失明重放=假阴性）：一个边界退不退火,看它 retry 的重跑范围会不会盖到某次已执行的 commit——**loop 体内的边界只被本轮的 commit 退火**（前轮的工作不在它的重跑范围内,新轮的重试机会不被前轮焊死）;**包住 loop 的外层边界被任何轮的 commit 退火**（外层重跑把 loop 从头再走,前轮的 commit 必被重放）;同轮内 commit 后失败,重试照旧被拦
	- **自身不带授权**（如 git commit 不重新鉴权）：能执行到即授权已在前序完成——需人工把关时在 commit **前**放 confirm，而非 commit 自己暂停
	- **commit 必须带 hop_python body（2026-08-22 作者定,2026-08-31 过渡期结束升 error）**：不可逆动作最不能交给 LLM 现场发挥——发送什么、写到哪,在生成期由 body 定死,执行期零裁量;参数来自复杂组合时前置步骤备好参数,commit body 只做最后一调。LLM 循环执行的 commit 每次重放实际动作可能不同,幂等设计无从落实（过渡期观察实证:无 body commit 的 LLM 通道四缺陷叠加——零工具知情/requires_commit 件反而物理不可达/重试轮吃虚构历史/格式重试即动作重放窗口——通道废止,升级依据详见设计层 llm-error-handling 台账）
- `check`：验证已有产出是否达标，仅输出通过/失败判定（不做分析推理）；必须在 subtask/case 内，失败触发所在容器 retry ^anc-step-check
	- **固定输出签名（封闭双槽）**：槽1 `bool` 判定（引擎按类型定位，false→触发容器升级阶梯）；槽2 `text` 失败说明（仅失败时被读）。`+ →` 把两槽映射到用户变量名
	- **纯机械判定可带 body**（2026-08-19 作者拍板 A）：check 可带 hop_python body（与 act 同文法同解释器,见 [[#^anc-step-act-body-lang]]）——判定是确定性计算时（判空/比阈值/核数组长度）body 直赋两槽变量,引擎解释执行**零 LLM 调用**（给不动脑的判定烧 LLM=浪费且 LLM 判空真会错）;无 body 照旧 LLM 判（语义面核验的正当形态）。双槽签名不变——body 只是两槽的产出方式;check body 工具面同 act（受控工具、requires_commit 拒、写域同限 work_zone） ^anc-step-check-body
	- **升层声明 `escalatable`**（2026-08-26 作者定,loop engineering 批;**HOP 高级扩展特性——除非特需,普通 spec 编写不必展示**:缺省语义〔fail 恒入容器 retry〕覆盖绝大多数场景,升层是探索循环级需求〔策略 spec 的收敛判定步是首个消费方〕）：check 可声明 `escalatable` 属性（中文词 `可上升`,2026-08-26 作者定——术语表 [[../design/i18n#^anc-i18n-glossary]]）——**作者授权该判定点把"本层能力够不着的缺口"上交**（升层是把本层缺口上交给上层注意力——接收端是人还是上层 caller 由拓扑定〔见下"谁来给由拓扑定"条〕,哪里允许上交由作者显式设计,与 confirm/ask 介入点同哲学）。 ^anc-step-check-escalatable
		- **判定槽零动**：仍是 bool 双槽——升层不是第三种判定值,是**失败说明的结构声明**（判定归判定〔成/败〕,说明归说明〔败在哪、缺什么、谁能给〕）;
		- **说明槽升格**：escalatable 的 check 说明槽须为 `yaml`（结构化缺口清单）;`escalate: true` + `need`（要什么:信息/权限/更强判断）为保留字段。**说明槽自此双档**：`text`（既有,缺省档）| `yaml`（结构化档,探索循环的进展指纹载体）;
		- **执行语义**：fail 且 `escalate: true` → 不入容器 retry,**升层问路**——引擎组装暂停卡走 ask 冒泡链（人或上层 caller 应答方向）,应答注入下一轮重跑,**不扣 retry 预算**（问路不是失败）;
		- **要什么由判定者说,谁来给由拓扑定**：check 只声明缺口与所需,接收端（人 / 父层 adaptive / 批量壳 deferred 汇总）由容器拓扑决定——spec 不预判自己被谁调用（与模型偏好语义同理,可移植性）。引擎面细则 [[../design/exec-engine#^anc-exec-check-escalate]]
	- **判据写法两条纪律（2026-09-18 作者定,弱模型真机三轮迭代立据）** ^anc-step-check-criteria：
		- **判官不吃自产判词**：check 步的输入声明**禁含自己的输出变量**——打回意见/缺口清单类反馈通道只喂给重做的执行步,不喂回判官自己。判官每轮对着当前产出独立重判,判据恒在步骤说明里,不需要自己上轮写了什么（实撞:验收步输入含自己上轮的缺口清单,判官照抄输入里的旧判词交卷不重判,修订全部落实仍三轮同词烧尽——引擎侧"check 不吃重试反馈"的防线只罩引擎通道,spec 自设变量通道从输入声明正门进,须 spec 侧同守）;
		- **打回门槛分级,严重问题一次列全**：判据须写明什么算**严重问题**（漏了必要件/错到影响下游路径/缺到没法用）——只有严重问题才打回,且**首轮把全部严重问题一次列全**,不分批挤牙膏;**裁量偏好不是打回理由**（同一内容的两可处理方式、措辞、排版——每轮换一个裁量标准的判官会让重试永不收敛;实撞:判官对同一句话的拆分先要求合并、再要求拆分、再换第三角度,三轮三个标准,执行者每轮都落实了意见仍烧尽。裁量摇摆超出判据可治范围时,把关步按模型能力路由到更强模型——变速箱的正用）。
	- `final` 修饰符：`[check final]` = `Constraints:` 的可执行化身——最终验收门，任何成功路径必经、adaptive 不可改写跳过；必须位于全部探索性步骤之后，**其后只允许提交性收尾**（`commit`/`exit`/其他 `check final`——"探索→验收→提交"同容器是正统事务形态）；retry 耗尽直接 fail 不再执行 final ^anc-step-check-finally
	- ⚠️ 旧修饰 `check finally`：**过渡期兼容读，将废止**——新写一律用 `final`
- `confirm`：**纯审批闸门**——暂停等有权决策者 approve/reject（CITL 介入点；caller=人或上层 Agent） ^anc-step-confirm
	- 单一职责=审批（收数据值用 ask）；`←` 展示待审数据，`+ →` 仅允许 bool
	- **answer 规范化**：reject 类 → **全局中止**（授权否决非局部失败——未终态步骤标 skipped、终态 failed，保证后续 commit 绝不执行）；approve 类 → bool 槽写 true
	- `require_human` 强制真人；"有权"由宿主身份层裁定（部署期 policy），Spec 只声明介入点
- `ask`：**CITL 数据收集**——暂停向 caller 请求业务数据值，落到 `+ →` 声明变量 ^anc-step-ask
	- 与 confirm 正交（confirm 答"批不批"，ask 答"值是什么"）；无 reject 全局中止语义
	- paused 返回自包含介入请求（question/output_schema/default_value/options，见 [[#^anc-exec-hitl-presentation]]）
	- `present_inputs`（可选）：列出必须**完整呈现**给 user 才能作答的 `←` 变量子集——driver 必须原文完整 dump（禁标签/省略号/摘要代呈），保"看全文才拍板"场景；省略时可缩略。支持 `require_human`
- `call`：调用外部能力单元——**spec 或工具，同一语法**：`N. [call <Id>(输入映射)] 任务描述`——机读（callee id 与输入映射）全在 `[]` 内，与其余结构步骤同构。callee 名运行期决议：先查 SpecProvider（子 spec），再查 ToolProvider（工具）——spec 与 tool 都是"带签名的外部能力单元"，call 统一二者（2026-08-25 作者定"工具应该可以被 call 并且被 hop_python 调用"；工具 call=单次调用即完成的退化形态：无子实例生命周期、结果直接落 `+ →`，requires_commit 工具在 call 位同受 act 语境拦截——等价于单工具调用的 body 步，供"一次工具调用即一个步骤"的表达）。静态核两档：环境注册表可得即核名字与签名，不可得留运行期（与 doc-ref 环境参数的两档校验同款哲学——配置在场即静态核、缺席留运行期，规则编号归设计层）。**callee 位插值形态（2026-09-05 作者三拍定形,todo/0066 落地 2026-09-05）**：callee 位允许写 `{变量}` 晚绑定——`[call {analyzer_spec}(doc: x)]`，执行期把变量求值成 spec Id 或路径再走完全既有的 call 链路（子实例/参数校验/把关/收割/parallel 一概不变）。花括号即 HopSpec 的插值主语义（f-string 同源），callee 位直接用无需引号壳。**动态派发归 call 不另造工具**（作者定"run_spec 这个不就是 call 么"）：这是 call 的晚绑定形态而非新能力——调用点仍钉在步骤树上（结构管次数、变量管对象，执行 LLM 只能定"调谁"不能定"调几次"），变量装的必须是盘上已存在的 spec，执行期解析不到响亮报错；生成期能枚举的场景恒优先静态 Id 与 for-each+call，本形态只服务"连调哪个子 spec 都要现场定"的场景。执行 LLM 的心智模型：call=你的 subagent 派发通道——探索步备好清单（每项含 callee 标识与参数），派发/等待/收割全归引擎，不许自己在上下文里逐个扮演子任务（上下文污染/撞窗口/零并行） ^anc-step-call
	- **输入映射入括号（callee 参数名: caller 变量名或字面量，同名只写名）**：`[call data_cleaning(source_data: order_text, mode)]`——`source_data` 是 callee（data_cleaning）Inputs 声明的参数名，`order_text` 是 caller（本 spec）的变量；同名省略成裸名（`mode` ≡ `mode: mode`）；无输入写 `[call id]`。等价 Python 具名传参：`data_cleaning(source_data=order_text, mode=mode)`。工具 callee 同款映射（参数名=注册面 params 声明名）
	- **映射值位可写字面量（2026-08-27 作者拍板 A——调用方定常量档位是普通人自然预期，Python `f(mode="seq")` 本就合法）**：`[call split_structure(split_kind: "seq", split_plan: seq_plan)]`——`"seq"` 直接作为 callee 的 `split_kind` 实参传入，不查 caller 变量。字面量形态是封闭枚举：带引号字符串（`"seq"`/`'seq'`，同型引号成对）、数字（`3`/`0.5`/`-2`）、小写 `true`/`false`/`null`——就这三类，对象/列表不入映射字面量（前置步骤装配后传变量）。**枚举外的裸词恒为变量名**——`mode: seq` 是"取 caller 变量 seq"，`True`/`None` 这类大写变体也是裸词，写常量必须用上面的形态；变量不存在按既有缺失语义走（不注入，子 Inputs 必填缺失即拒），不会静默变成字符串
	- **输出 `+ →` 行收取（caller 变量名: callee 输出名，同名省略）**：`+ → clean_result: cleaned`——caller 的 clean_result 接收 callee 的 Outputs cleaned，引擎自动搬运
	- **`parallel` 可加**：`[call <Id>(映射) parallel]`——转述 callee 的并发申报，执行语义=异步派发（执行到即派出、主线不等它完成），输出只经容器边界收取（loop 体内即 collect 列表端）。派发/收齐全套语义见「`parallel` 属性」
	- ⚠️ 旧形态 `[call] <Id> : 描述` + `- ←` 映射行：**过渡期兼容读，将废止**——新写一律用标准写法，序列化只写标准写法
	- **跨调用层上升语义** ^anc-exec-call-escalation：confirm 暂停**不逐层上传**——"有权"是全局属性，runtime 以完整调用链 step_id 为 key 直达有权决策者、决策直接寻址注入（中间 call 层只是挂起帧）；lack_of_info **逐层自治上升**——知识源是栈属性，子层先用自己的 KnowledgeProvider 补，补不了才上传父层，顶层仍缺才 fail
	- **失败跨界（call = 函数调用的异常边界）**：子 spec 实例 failed → call 步骤 fail，**子实例的失败记录加壳随界传递**（原封失败记录 + 跨界壳：callee spec 标识、子实例引用）——不是驱动方的自由文本转述（成功走机器通道回填 Outputs，失败同样走机器通道回填失败记录，对称）。`fail_kind` 跨界继承使 lack_of_info 的逐层自治上升真正接通；call 步骤 fail 后走 caller 侧标准升级链——重跑 call = 重新调用整个子 spec

### 结构节点（容器）

- `branch`：条件决策，children 必须全部是 case；同层级互斥步骤必须放在同一个 branch 的 case 下 ^anc-step-branch
	- I/O：branch 头 `+ →` 声明**统一接口名**，各 case 同名填充、命中者透传（详见下方「容器的输入与输出」）
- `case`：branch 下的分支。**case 就是 branch 下的 subtask**——除"被 branch 按条件选中激活"外，执行语义与 subtask 完全相同（check/check final、case 粒度 retry 缺省 3、可带 `retry=N`/`adaptive`；选中 case 的 retry 耗尽即 branch 失败）。I/O 同 subtask，但输出名必须与 branch 接口**同名**（见下节） ^anc-step-case
	- 条件文法（结构化逻辑标准写法）：`N. [case(条件)] 人读描述`——**机读全在 `[]` 内**（与 `[loop for-each …]`、`[subtask retry=N]` 同构：方括号=机器面，其后=人读面）；描述纯人读不参与求值。**统配（else）写 `[case(else)]`**——else 即"其余全部"，日常英语直觉；**只能放最后**——顺序命中语义下统配在中间会吞掉其后全部 case，校验器拦截。else 是条件位保留字（变量/枚举成员不得取名 else）
	- ⚠️ 旧形态 `[case] 描述 (条件)`：**过渡期兼容读，将废止**——新写一律用标准写法
	- **条件 = hop_python 纯表达式**（与 act body 同一文法，见 [[#^anc-step-act-body-lang]]），能力面四段：
		- **字面量**：数字（`10`、`0.5`）、字符串（单/双引号皆可）、布尔 `true`/`false`（Python 惯性大写 `True`/`False` 兼容归一，文档只教小写）、**`None`**（`null` 同义）——`x is None` 即概念层"检测 None 走降级"的条件写法（`is`/`is not` **仅限 None 判定**，解析层归一为 `== None`/`!= None`，其他右操作数报错指路；None 与未赋值同判，声明未产出的变量也命中）
		- **引用**：变量（snake_case）、字段访问 `point.type`（可链式）、**下标 `items[0]`**（Python 结构化逻辑标准写法；下标为任意表达式含负数）、**切片 `items[start:stop]`**（两端点可省可负数，越界钳位宽容——`l[2:]`/`l[:5]`/`l[-3:]`；不含步长三段形态——反转用 `reversed(l)`，隔位取用推导式 `[l[i] for i in range(0, len(l), 2)]`）
		- **运算符**：等值 `==`/`!=` **Python 严格语义**（跨类型不相等不异常——`"3" == 3` 假；数字与 bool 互比按数、`True == 1` 真；列表/对象深比较逐元素；None 与未赋值同视为"无值"互等）；`is`/`is not` **仅限 None 判定**（`x is None` 与 `x == None` 同义）；序比较 `< > <= >=` **Python 语义，同类型才可比**（数字与 bool 互比按数；字符串×字符串字典序——日期串 `"2026-08-01" < "2026-08-02"` 可写；列表×列表逐元素字典序；其余组合含 None 参比=计算异常→None+log，条件整体按不命中）；布尔 `and`/`or`/`not`（短路）；**成员测试 `in`/`not in`**（`x in items`——数组查元素/字符串查子串/对象查键，Python 惯用形）；算术 `+ - * / % // **` 与一元负号（`**` 右结合、`-2**2 == -4` Python 优先级）；括号分组；裸变量真值 **Python 语义**（None/false/空串/0/**空列表/空对象** 为假,其余为真——2026-08-20 作者拍板对齐:空结构原判真是真值面唯一未对齐 Python 处,yaml 值模型改结构后空列表形态大增,`if xs:` 判空按教学写会静默走错分支）
		- **pure 函数可用**：内置纯函数（`len`、`strip` 等，全表见 [[#^anc-step-act-body-lang]]）在条件里照常可调——纯函数零副作用，条件反复求值安全（如 `len(items) > 0`）
		- **排除（各有原则依据）**：工具调用（有副作用，条件零副作用）、赋值（条件只读）、方法调用形（hop_python 无方法语法，一律函数化——`lower(s)` 非 `s.lower()`）
	- **enum 成员裸写是结构化逻辑标准写法**（作者定）：`risk_level == high` 中 high 是 `enum(high, medium, low)` 声明过的成员，**不需要也不建议加引号**——校验器核对裸字 ∈ 枚举成员（写错值当场报）；**变量名禁止与枚举成员重名**（否则裸字两义，V2 拦截）。**自由文本字符串字面量建议加引号**（`mode == "doc"`）；比较位置的裸标识符无同名变量时兼容为字面量。仅比较位置有此消歧；裸真值/算术/逻辑位置的未声明名仍按未定义处理
- `subtask`：任务分解的**分组与事务单元**（缺省顺序执行） ^anc-step-subtask
	- I/O：容器头 `+ →` = 导出契约（声明本块对外交付什么，见下方「容器的输入与输出」）；无 `- ←` 行（子步骤自带消费边）
	- `retry=N`（缺省 3）整组重跑；`adaptive` 允许重试时重规划 children——交付契约（`+ →`）与 `[check final]` 不可改（改策略不改目标）。**retry 仅属 subtask/case**（事务边界属性）
	- `parallel`：本 subtask 可被并行调用的申报（自包含/无共享写），执行语义=异步派发——见「`parallel` 属性」
	- **`[subtask free]` 到步展开档（2026-08-27 作者定形："本质上是到这步以后,做一个本步的 plan-do-check-retry-pass 展开"——free 家族第二成员,与 [[#^anc-step-act]] 的 act free 对称：act free=执行自由〔怎么干不细说〕,subtask free=规划自由〔干什么到步再定〕;中文词 `开放`,`[子任务 开放]` ≡ `[subtask free]`）**：children **可空**——写卡时只声明契约（`- ←` 输入、容器头 `+ →` 交付、描述），执行**到步时引擎停下向 caller 索计划**（plan）——**索计划请求携执行时上下文**（容器声明的 `- ←` 输入的实际值+容器描述+全局目标约束,2026-08-27 作者点"replan 可以基于执行时的上下文来构建,这个输入要 feed 给 replan"——到步展开的价值本体就是拿着真产出定计划,不喂上下文=盲规划）,caller 据此出 children 提交,引擎接续执行（do）。展开物纪律两条：①**必须含 check**（到步展开的计划是运行时产物、无人预审,check 是它唯一的把关——作者定 F1）;②**禁 commit**（与动态 spec 准入门同律：不可逆动作必须写卡时显式声明被人看见,不能藏在到步才出的计划里——free 家族统一约束"自由不含不可逆",act free 的"不可作提交载体"同源;要 commit 写在 subtask free 之外消费其交付物）。retry/adaptive 照常可挂（retry=展开物失败整组重跑,adaptive=重试时重规划——恰合 plan-do-check-**retry**-pass 全环）。与 HopTrait（spec 级无 Steps 由引擎索计划）同一思想在步骤级的落地。 ^anc-step-subtask-free
- `loop`：重复执行 children，驱动源两形态：**条件循环**（`max=N` 安全上限）与 **for-each 列表遍历**（`[loop for-each <item> in <list_var>]`——游标归引擎，禁止用 reason 步骤数游标） ^anc-step-loop
	- **for-each 子句声明取的一端**：`<item>` 定义点=子句本身（类型=`<list_var>` 的 `[T]` 剥括号，语义承接其 `#` 注释）；`<list_var>` 的消费边由引擎**从子句自动合成**进变量流图（S12 依赖分析照常可见）——`- ← <list_var>` 行**写不写都合法**（不写不缺边、显式写零提示），消费边不可能因漏写而悬空
	- **collect 子句声明放的一端**：`collect <单项> into <列表>`——"对每个 item，把单项收进列表"，与 for-each 一取一放成镜像。`<单项>` 每轮由 children 产出（`T`），引擎轮末收进 `<列表>`（`[T]`）并复位单项槽（传送带：児产出放上、引擎运走）；`<列表>` 在容器头 `+ →` 声明类型与说明。**两个名字、两个变量**——单项与列表各自单一类型单一含义，同名=同一变量原则零例外。break/失败中断时列表为已完成部分。无 collect 子句 = 纯副作用循环或用普通末值/累加器导出
	- 变量跨迭代自然保留；累加器 `+ → acc: type = 初值` 容器入口 init 一次——详见「变量语义：Python 函数级作用域 + 自然保留」
	- **无 retry**（失败单元=单次迭代，整循环重跑=重复已成功迭代的成本与副作用）；单次迭代要事务性时 children 内嵌 `[subtask retry=N]`；循环头**不带 parallel 属性**——并发是体内步骤的性质（体内 subtask/call 标注 parallel 即渐进并发各迭代），见「`parallel` 属性」
	- ⚠️ 旧属性 `max_iterations=N`：**过渡期兼容读，将废止**——新写一律用 `max=N`
	- 示例（完整节点）：
```
2. [loop for-each reviewer in reviewers, collect note into reports] 并行评审
  + → reports: [text]    # 全部评审报告（collect 子句的列表端）
  2.1. [subtask parallel] 执行评审   # parallel=本子任务可被并行调用——每迭代异步派出一个
    + → note: text       # 本轮报告（collect 子句的单项端）
    2.1.1. [reason] 按该审查员视角评审
      - ← reviewer       # 元素绑定直接引用，无需声明行
      + → note
3. [loop max=20] 逐轮修复   # 条件循环形态
```
- **`parallel` 属性**（非步骤类型）：**callee 的并发性质申报 + 步骤级异步派发语义**，可标注 subtask / call / case（case 就是 branch 下的 subtask，2026-08-13 作者定）——其余节点标 parallel 是文法错误。**属性总闸**（同日作者定，根除静默吞）：任何步骤行上未被该步骤类型消费的属性一律 parse error（如 `[reason retry=2]`、`[act parallel]`——错位属性被无声丢弃是最隐蔽的失控：作者以为申报了，引擎什么都没做） ^anc-step-parallel
	- **申报（写的一面）**：标 `parallel` = 声明主体承诺"本任务自包含、无共享写、可安全多实例并行"——与 `requires_commit` 同构的 callee 侧自我申报。能否并发由被调用方的内部实现决定，只有它的作者知道，所以声明落在它身上；调用侧零调度语义（并发路数是部署配置，不进 spec）。**申报属实由依赖分析把关**（S12，两条边界）：标注步骤的输出容器内不可被消费（值可能未回）；标注步骤不可消费其他标注步骤的输出（对方在飞）。未标注主线步骤的输出照常可用——主线串行保证派发时值已就绪（快照传入），这正是流水线形态成立的前提
	- **执行（跑的一面）——全局统一一条**：主线执行到标注 parallel 的步骤 → **派出去跑，不等它完成，主线继续推进下一兄弟/下一迭代**；容器要收工时，必须先把本容器里派出去的活全部等完收好（**收齐**，见「并发执行模型」）。未标注的步骤主线自己同步做（缺省即串行，无需任何声明）
	- **一个模型覆盖全部并发形态**：循环体内标注 → 各迭代渐进派发（第 N+1 轮生产与第 N 轮的活重叠——流水线）；兄弟并列多个标注 → 兄弟并发（中间夹未标注步骤照常同步做，已派出的活不受影响）；兄弟全标注 → 同时全部在跑

### 控制流节点（叶子）

- `break`：跳出 loop——`[break]` 跳出最近祖先循环；`[break <循环步骤号>]` 跳出指定祖先循环（多层嵌套从内层直接跳出外层用；与 HopSop `[退出循环 <序号>]` 对偶,升级映射零改写） ^anc-step-break
	- ⚠️ 只能在 loop 容器内（任意嵌套深度）；带目标时目标必须是自身的祖先循环，否则报错
- `continue`：跳过当前迭代进入下一轮——`[continue]` 作用最近祖先循环；`[continue <循环步骤号>]` 作用指定祖先循环（与 HopSop `[继续循环 <序号>]` 对偶） ^anc-step-continue
	- ⚠️ 只能在 loop 容器内（任意嵌套深度）；带目标时目标必须是自身的祖先循环，否则报错
- `exit`：结束整个 spec，用 `+ →` 标记交付的变量名（类型已在 `Outputs:` 或前序步骤声明）。若无输出，显式写 `+ → none`。若 `Outputs:` 非空，exit 交付所有声明的输出变量——**bare exit（不写任何 `+ →`）是合法简写 = 隐式交付 header 全部 Outputs**（`Outputs:` 段本就是交付契约的权威声明，exit 重抄一遍是冗余；简写引用精神的极限形态）。**半写即错**：写了 `+ →` 但与 Outputs 不完全一致（多/漏）仍报错——显式声明必须完整，要么全写要么不写 ^anc-step-exit
- `on fail`（**失败兜底**,2026-08-21 作者立;**HOP 高级扩展特性——除非特需,普通 spec 编写不必展示**:缺省语义〔耗尽上浮逐层升级〕覆盖绝大多数场景,兜底是元编程/构建器级需求〔hopbuild2 '试 N 遍再放弃'即首个消费方〕;面向普通作者的教学材料不教本原语,语言参考单独成节）：subtask/case 的失败兜底块——所在容器 **retry 耗尽后**执行其 children（不是每次失败都进:每次失败归 retry 重跑,耗尽才轮到兜底）。此前 retry 耗尽只能被动上浮,作者无法声明"放弃之后先做什么"（记档/降级/给兜底值）——本原语是升级链的 except 位 ^anc-step-on-fail
	- **接住语义**：兜底块正常走完 → 失败被消化、容器按 done 收场、主线继续;块内 `+ →` 给容器输出赋兜底值（补上失败路径容器输出悬空的坑）。**兜底块自身失败 → 不再兜**,容器 fail 照旧上浮（无嵌套 catch——except 里再抛的对应物）
	- **位置约束**：必须是 subtask/case 的**最后一个子节点**（check final 之后）,一容器至多一个;正常路径整块 skipped（零成本）
	- **与 commit 退火正交**：退火边界 retry 失效（防不可逆重放）,但**兜底块照样执行**——退火拦的是"重跑重放",兜底是"善后",不重放任何东西;退火后失败直达兜底（跳过 retry 阶梯）
	- 识别信号（原文里）："实在不行就…"、"失败的话就记下来跳过"、"不行就用默认值"——这类句子翻成失败兜底块

### 容器的输入与输出 ^anc-exec-container-output

标记体系的对称形态：**`- ←` 是叶子的消费边，`+ →` 是叶子的定义点 + 容器的导出契约；容器不写 `- ←`**（子步骤自带消费边、for-each 的 listVar 由子句合成，容器层无独立消费需求）。

**输出侧通则——容器头 `+ →` = 导出契约**：
- 回答"本容器对外交付什么"，**不是汇聚操作**（机械收集/透传/搬运全归引擎，spec 不写怎么汇聚）
- **意图声明非访问控制**：块内变量块外照常可读（见「变量语义」），没有隔离；`+ →` 声明的是"本块对外交付什么"，供读者抓重点、供校验器提醒"声明了却没人产出"。纯控制流容器可省略，隐含 `+ → none`
- **必须显式、不从 children 推导**，三个理由：①意图显影（推导=产出什么算什么，交付意图不可辨）；②adaptive 不动锚（children 可改写、契约钉死目标——契约随 children 漂移则"改策略不改目标"落空）；③branch 接口纪律（接口先声明、case 向接口对齐，而非"产出什么算什么"）

**各容器的导出形态**：

| 容器             | 头部 `+ →` 写法                                                                                                                                                    | 引擎行为                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| subtask / case | `out: T`（与 children 产出同名同型）                                                                                                                                    | 同名即同一变量，块内产出即对外可读（声明只标交付意图）                               |
| loop（for-each） | 三种导出：**收集列表**（`collect <单项> into <列表>` 子句声明，头部 `+ → <列表>: [T]`，体内串/并步骤同）；**普通末值** `out: T`（同 subtask，块内写、末值即导出）；**累加器** `acc: type = 初值`（后两种要求体内无 parallel 标注步骤产出它们；parallel 标注步骤的输出只走收集列表，见 S13） | 收集列表由引擎收单项进列表（同步步骤轮末收、parallel 步骤收完即收），break 时为已完成部分；末值/累加器是命名空间普通变量，引擎零动作 |
| loop（条件循环）     | `acc: type = 初值`（累加器）或末值导出                                                                                                                                     | 累加器 init 一次、跨迭代自然保留                                       |
| branch         | `out: T`——**统一接口名**                                                                                                                                            | 命中 case 的同名输出透传（见下）                                       |

**parallel 与累加器互斥、归约接在收齐后**：parallel 标注步骤的输出只有收集列表一个去向——派出去的活无共享空间可累加（也不可被容器内消费，见「并发执行模型」无 Future 铁律），产出它的累加器声明（带 `= 初值` 的输出）为静态错误。要在并发结果上做归约（汇总/拼接/统计），写法是**收集列表 + 容器后的一个步骤消费列表**：

```
1. [loop for-each file in file_list, collect issue into issues] 并行审查
  + → issues: [yaml]        # 收集列表：引擎把各活的 issue 收进来（失败的活不贡献元素）
  1.1. [subtask parallel] 审查单个文件   # 标注 parallel：每迭代派出一个
    + → issue: yaml         # 本文件的问题（collect 单项端）
    1.1.1. [reason] 审查
      - ← file
      + → issue
2. [act] 汇总                # 收齐之后的归约步：整列表进、归约值出
  - ← issues
  + → total_count: int      # 例：数一下
  + → summary: text         # 例：拼一份
```

归约步拿到的是收集列表（部分活失败时列表变短，可否接受由本步裁量），归约逻辑写在这一步里——确定性计算用 act（hop_python body），需要判断归纳用 reason。

**branch 的统一接口语义**：branch 头 `+ →` 声明接口名，各 case 用**同名** `+ →` 填充——互斥 case 的同名变量天生是同一个东西（"同名 = 同一个东西"原则：不同分支对同一语义角色的取值，V2 不视为重名冲突）。同名即同一变量——无论命中哪个 case，后续步骤 `←` 引用的始终是 branch 声明的那一个名字，路径无关。无 case 命中 → branch 静默跳过，**引擎不写任何值**（与 case/loop 某轮未产出同构）。执行链上下文（L3）中 branch 展示命中了哪个 case 及其聚合输出。

### hop_python：act / commit / check 的 body 语言 ^anc-step-act-body-lang

`act`、`commit` 与纯机械判定的 `check`（见 [[#^anc-step-check-body]]）的执行体（body）用 **hop_python** 表达——HopSpec 的一种**受限编排语言**，写在步骤 `>` 指令区内的 ` ```hop_python ` 代码围栏里。它是「无推理编排」概念（见 [[#^anc-step-act]]）的语言载体。

- **HopSpec 受限子集，非真 Python**：`hop_python` 名字里的 `python` 指**语法风格**（缩进块、`if cond:` / `elif` / `else:`、无花括号），不是真 Python 运行时。引擎把它解析为 **HopSpec 中立 AST**，由任意宿主语言引擎（TS/Python/Rust）解释执行——这是宪法级**环境无关原则**（见 [[#^anc-exec-mode-invariants]]）的直接落地：body 不绑定任何具体宿主语言。`hop_` 前缀即"HopSpec 方言、非宿主语言"的命名忠实标记；未来可对称扩 `hop_ts`（同一中立子集的 TS 风格皮肤）。
- **能力边界 = 白名单**：body 只能做四类事——①基础运算（算术 `+ - * / % // **`、字符串拼接与重复、比较 `== != < >`、布尔 `and/or/not`、成员测试 `in`/`not in`、字段取 `obj.field`、下标含负数、切片 `seq[start:stop]`（端点可省可负，钳位宽容）、**字面量构造** `[1, x]`/`{"k": v}`（对象键=表达式,Python 同义——2026-08-20 作者定『与 python 一致』:`{"k": v}` 字面量键/`{key_var: v}` 变量键求值;裸名键即变量引用,未定义静态拦〔B4〕并指路两改法——原『键限字符串字面量』人为收紧废）、**f-string** `f"共{n}条"`）；②**白名单调用**（内置 pure 函数 ∪ 宿主 `ToolProvider` 注册的工具）；③赋值（局部变量与 `+→` 输出）；④无推理分支（`if`/`elif`/`else`）。调白名单外的任何东西 = 非法。白名单即能力边界，天然实现"无任意代码执行"。**白名单按步骤类型分级**：`ToolProvider` 工具可标 `requires_commit`（有不可逆副作用），此类工具 act body 调用即拒（COMMIT_REQUIRED）、仅 commit body 放行——act/commit 共用同一语言，探索提交分离由工具面分级落实。
- **内置 pure 函数全表**（零副作用纯计算，body 与 case 条件通用；**与 Python 同名同义**——代码面向 agent/程序员，Python 一致降心智负担，2026-08-10 作者定）：数值 `len` `min` `max` `round` `abs` `sum`｜文本 `lower` `upper` `strip` `split` `join` `replace` `startswith` `endswith`｜文本剥壳与解码 `strip_fence`（剥 LLM 产文本值外层的代码围栏壳与自标记键前缀，第二参 key 可选——给出时连剥 `key:` 首行前缀）`parse_json`（JSON 文本 → 结构值，解析失败按计算异常折本步失败，不静默；**入参已是结构值/数字/布尔/null 时原样返回**——幂等容错，2026-09-05 作者定"parse_json 应该需要有容错能力"：上游通道把文本提前解析成对象时 body 不因二次解析炸）｜序列 `sorted` `reversed` `range` `count`（**单参列表计数**——`count(xs)` 返回列表元素个数；字符串入参报"期望数组"，Python `str.count` 的双参子串计数形态引擎没有）｜聚合谓词 `any` `all`（接受列表；`any([])` 为 False、`all([])` 为 True——元素真值与引擎统一真值口径同源，空结构为假）｜结构 `keys` `values` `get`｜类型转换 `int` `float` `str` `bool`。**成员测试用 `in` / `not in` 运算符**（`x in items`，Python 惯用形——数组查元素/字符串查子串/对象查键）；**None 检测用 `x is None`（Python 惯用形）或 `x == None`**（同义——`is` 仅限 None 判定）；判空用裸真值或 `len(x) == 0`。可调用的名字分两类，按**有无副作用**划界：**pure 函数**（本表，零副作用）body 与 case 条件都可调；**工具**（文件读写、外部调用等，有副作用）只能在 act/commit body 里调——case 条件可能被反复求值，出现副作用就不安全，故条件里调工具是静态错误
- **内置文件/目录工具组**（引擎默认提供，全部限沙箱 workspace 内、全部 `requires_commit=false`——**不可逆的分界是"是否出沙箱"，不是操作类型**：沙箱是探索区、整体可重建，箱内删写移都可重来；`requires_commit=true` 留给触及沙箱外生产资源的工具——宿主注册的，或引擎内置的不可逆工具通道〔第一例：钉钉通知 dingtalk_notify，2026-08-31〕）：读 `read`（全文,或带 `start_line`/`end_line` 取行号段——行号 1 起,end 越界截到文件尾;定向读盘取代整读,2026-09-05 作者定 todo/0070） `listdir` `exists` `search_file`（**单文件子串搜索**——`search_file(path, pattern)` 返回命中行清单带 1 起行号;纯子串不是正则,零命中返回空清单不报错;按关键词定位行号后配 read 行号段取段,2026-09-05 作者定同批）｜写 `write`（新建或覆盖）`create`（**排他新建**——目标已存在即失败，透传 OS 原子语义，多 worker 并发抢占/幂等哨兵文件用它）`append`（追加）`edit_file`（**局部精确替换**——`edit_file(path, old_text, new_text)`，old_text 在文件中恰匹配一处才替换；零匹配或多处匹配都响亮报错带计数，宁拒不猜。改大文件的几行用它，不整文件重写——2026-09-05 作者拍甲案：37KB 草稿改三处却 write 全文回写是实测最大输出浪费源）｜组织 `makedirs`（含中间层，幂等——即 Python `os.makedirs(exist_ok=True)` 语义）`move`（移动/改名，透传 rename 原子性）`remove`（删文件）。命名与 Python os/shutil 对齐（listdir/exists/makedirs/remove/move）。写侧按步骤权限分域（作者定 2026-08-28）：**act 与 check 的写域=work_zone 涂鸦区**——act 是探索段，它写的一切都是中间产物，中间产物归 work_zone（body 内 `work_zone_path(rel?)` 返回本实例独占工作区下的路径，无参返回根，禁 `..`；作者定 2026-08-10），越界写即拒（WORK_ZONE_ONLY），free 与否无关——free 只影响行为可预期性，不放大权限；**commit 的写域=整个 workspace**（`.hopstate/` 引擎状态区除外，work_zone 是该禁令的唯一豁免）——持久产物写盘是交付动作，归 commit 承载
- **实例上下文内置**（非纯函数但非 IO——依赖实例环境、零副作用；条件里调用为静态错误）：`work_zone_path(rel?)`（见上）；**`now()`**（ISO 8601 当前时刻）与 **`today()`**（当前日期，YYYY-MM-DD）——时间戳供产物落款/日期计算（作者定 2026-08-12 纳入 hop_python，不走工具通道）。**重放确定性**：首次求值入本步 journal，重试/崩溃恢复重放取记录值不取新值——与工具结果重放同一通道同一哲学
- **`subprocess.run(argv, input=?, timeout=?, cwd=?)`：白名单命令行调用**（2026-08-29 作者定"写是按 python 写"——写法完全对齐 Python `subprocess.run`，这是 hop_python 唯一的 `x.y(...)` 形态名，引擎认此字面为内置、不开模块系统）。body 里可执行外部命令行程序，前提是命令名在宿主 sandbox 配置的命令白名单（`runtime.available`）里——**名单空 = 此能力关死**，引擎不内置任何命令。命令与参数写成一个列表（无 shell 解释整串命令行），结果是结构体（`returncode`/`stdout`/`stderr`，字段名同 Python），命令失败不炸——returncode 的处置写 check 步或分支。非纯（外部进程有副作用），仅 act/commit body 可调、条件里调用为静态错误。完整写法与正反例见语法参考 subprocess.run 专节（`HopSpec V3语法参考.md` ^anc-step-subprocess-run）
- **工具声明两面：环境注册面=实现权威，spec Tools 段=需求声明**（2026-08-25 作者定，收窄 2026-08-06/08-12"不进 spec 本体"原裁决——原裁决防签名复制漂移，代价是 spec 作为自包含分发单元读不出自己的工具依赖、对齐收集的工具面在产物里蒸发、init 无从核环境够不够跑；实撞:NL 构建测试收集了 tools_available 却无处声明只能塞步骤描述里猜着写）： ^anc-tool-two-faces
  - **环境注册面（实现权威，全量讲清）**：每个工具的真实契约=逐参数条目式声明（`- 参数名: 类型 # 说明`——说明入结构非注释废话，写到杜绝望词生义：值语义/取值来源/错用后果）+输出形状（output_schema）+不可逆标记（requires_commit）+ `notes` 多行扩展块（跨参数复杂语义:幂等性/上限/调用纪律）。内置工具随引擎、外部工具在环境配置的 tool_servers 节（文法权威=设计层 tool-interface 注册面条款）。同一工具全环境一份实现签名；
  - **spec Tools 段（需求声明，可选）**：spec 文件头可声明本 spec 假定的工具面（形态见规约结构 Tools 段）——它是"import 声明"不是签名复制：买来 spec 自包含（读 spec 即知能力依赖）、init 早失败（引擎对账两面，环境缺工具或签名不兼容当场报错不起跑）、prompt 有据（执行 LLM 从 Tools 段拿到逐参数语义，不望词生义）。原裁决防的漂移由 init 对账转为显式错误；
  - **执行侧按实现签名双端把关**（维持 2026-08-12）：实参不合输入 schema 不发；结果不合 output_schema 视为预期与现实的偏差——步骤 fail 入既有升级阶梯（带偏差明细供 adaptive 重规划适配），并记录偏差凭据
- **工具命名空间 = `ToolProvider.list()`（唯一权威名字源）**：body 里的工具调用名必须 ∈ `ToolProvider` 清单（见 [[#^anc-exec-mode-invariants]]：控制层只管"调什么工具"，宿主负责实现）。两种模式对齐**同一个名字空间**，差别只在谁执行：
  - **独立模式**：引擎直接 `ToolProvider.execute(name, args)`，name 即清单里的工具名。
  - **复用模式（CC / Codex 等 caller 驱动）**：**caller 必须按 `ToolProvider` 清单注册同名工具**——把自身能力（CC 的 Read/Write/Bash、Codex 的对应工具）包装成清单声明的工具名与签名。body 只认这个统一名字空间，不关心 caller 内部如何实现。即"caller 适配到清单"，而非"body 适配 caller"。
  - 引擎据此在 prompt 把 body + 可用工具清单（名+签名）一并交付 caller，caller 按名调用、回写输出。
- **禁循环**：body 不含 `for`/`while`——循环须升 HopSpec `loop` 步骤（要 `max` 上限保护、迭代历史、变量作用域）。词法即拒绝循环关键字。**同理排除的 Python 隐式循环面**：`map`/`filter`/`lambda`/`enumerate`/`zip`（循环语义归 loop/for-each，引擎驱动）。**条件表达式 `a if c else b` 支持**：惰性求值只算命中分支,与 `if cond:` 语句形等价可互换。**有替代写法不进语言的**（第二种写法违语言第一原则，parser 定向报错指路）：链式比较 `a < b < c`（用 and 拆）、增强赋值 `+=`（写全）、多重赋值 `a = b = 1`（拆两行）、`pass`（空分支不写）。
- **词法契约**：缩进**只接受空格、禁止 tab**（避免缩进列数歧义）；行尾 `#` 注释；数据从 `←` 输入取、局部变量顺序传递、写入 `+→` 输出。
- **生成期 vs 执行期**：body 由 LLM 在规划 / adaptive 重规划时生成；执行期被严格解释、不再推理——两种模式都由引擎内置解释器执行（求值 + 调白名单工具——2026-08-04 收紧；工具分派按执行主体原则 2026-09-05：引擎自有 provider 命中直执，caller 会话专属工具经 tool_request 单工具介入，强制力分级同沙箱）。
- **body 在场即唯一执行体**：act/commit 带 hop_python body 时**仅执行 body**——任务描述与 `>` 说明不参与执行，只作人读与生成期依据。因此**描述语义与 body 语义必须一致**，一致性由生成方（hop build）保证：描述说的就是 body 做的，不一致即翻译错误。**无 body 的 act/commit** 按任务描述执行——一般路由给轻量级 LLM（flash 档），任务描述要写到轻量模型也能照做。

示例（数据修复 act 的 body）：
```hop_python
filled = fill_missing(data: raw_data, strategy: fix_strategy)
if fix_strategy.clip_enabled:
    cleaned = clip_outliers(data: filled, threshold: fix_strategy.z_threshold)
else:
    cleaned = filled
clean_data = cleaned
repair_summary = fix_strategy.actions
```

---

## 变量类型系统 ^anc-type-system

输出变量（`+ → var`）首次出现时必须标注类型和 `#` 注释。已声明过的变量再次出现时只写变量名。

**原子类型**：

| 类型         | 含义              | 示例               |
| ---------- | --------------- | ---------------- |
| `bool`     | 布尔              | `true` / `false` |
| `int`      | 整数              | `42`             |
| `float`    | 浮点数             | `0.85`           |
| `line`     | 单行字符串           | `"模型训练完成"`       |
| `text`     | 多行纯文本（默认）       | 对话回复、诊断文本        |
| `markdown` | 结构化 markdown 文档 | API 文档、分析报告      |
| `yaml`     | 结构化数据（对象/列表）  | 结构化输出            |
| `prompt`   | 组装好的 LLM prompt | system prompt    |

> **数字类型与 Python 一致**（2026-08-31 作者定"和python一致"）：只有 `int`/`float` 两个数字类型，**`number` 不是合法类型词**——它曾在 validator 与部分范本中事实流通（无概念层户口），本批除名：validator 拒收指路 int/float，范本改写。`number` 仍留在保留字表（废词占位——不得作变量名，防旧写法静默变身变量引用）。

**领域特化类型**（在文本类上叠加领域语义）：

| 类型        | 基础类型     | 含义                        |
| --------- | -------- | ------------------------- |
| `HopSpec` | markdown | 符合 HopSpec 格式规范的 markdown |

💡 传统 `str` 按语义细分为 line/text/markdown/prompt/HopSpec，帮助 LLM 明确输出格式意图。

**`yaml` = 结构化数据类型（2026-08-20 作者定，值模型改判）**：`yaml` 声明的变量在变量空间里是**结构**（对象/列表），不是文本——名字里的 "yaml" 指书写与展示语法，不指存储形态。各边界自动转换，spec 作者与 hop_python 零手动 parse： ^anc-type-yaml-structured
- **LLM 产出边界**（`+ →` 声明 `yaml`）：LLM 写 YAML/JSON 文本，引擎 parse 成结构入变量空间（边界归一家族——与 int 收数字串、bool 收 "true" 同族）；parse 不出结构 = SCHEMA_MISMATCH 带反馈重做，不静默存文本；
- **LLM 消费边界**（`←` 引用 yaml 变量）：结构序列化回 YAML 文本进 prompt——LLM 两头看到的都是 YAML 文本，心智不变；
- **hop_python 内**：字段访问/下标/推导直接可用（`header.inputs`、`[i.name for i in header.inputs]`）；`len(x)`=元素/键数、`in`=查元素/键、等值=深比较（结构语义）；文本化显式转——`str(x)` = YAML 块式序列化（多行）、f-string 插值 = 紧凑单行（YAML 流式,即 JSON 形——插值位多行会毁排版）、`write(content: x)` 落盘 = YAML 块式文本；
- **入口边界**（params/工具结果）：传结构原样进；传 YAML 文本按声明 parse（同产出边界）。

**容器类型**：

| 语法 | 含义 | 示例 |
|------|------|------|
| `[Type]` | 列表 | `[line]`、`[ChatMessage]` |
| `(Type, Type)` | 元组 | `(int, text)` |
| `enum(v1, v2, ...)` | 有限值枚举 | `enum(high, medium, low)` |
| `line(非空)` / `line(nonempty)` | 带非空约束的单行字符串 | `domain_name: line(非空)` |

**约束标注（2026-09-02 作者定 B 案——"step 约束里说明,否则这个概念是分裂的"）** ^anc-type-constraint-annotation：`line(非空)`（英文 `line(nonempty)`,双语等价、AST 存英文规范形——关键词双语直通惯例）声明**该槽位的产出必须是非空单行文本**——空串/全空白按产出不合格打回（执行 LLM 答不出应走失败通道如实上报,不交空串充数）。三条边界：
- **约束是声明处 opt-in 的步骤级要求,不是类型语义**——`line` 本身恒为"单行字符串",空串是合法值（类型概念完整;引擎对裸 `line` 不设任何空值闸）。哪个槽位必须非空,由 spec 作者在声明处标注——谁声明谁被保护;
- **裸 `line` 槽的缺席约定归注释**——业务上可缺的槽（如"独立第二来源,无则空串"）写在字段 `#` 注释里,执行 LLM 照注释办;要硬把关再上 `check`;
- **本条只定义非空一个约束参数**——与 `enum(...)` 同构（类型位带参收窄值域）,但不开放通用约束语言（`int(>0)` 等形态撞到真实需求再议,防滑向重型 schema 语言）;
- **约束只管产出面,输入侧不拦**——Inputs 声明 `line(非空)` 合法但引擎不对传入参数做空判（输入是 caller 给的,把关归 caller 或用 ask 步向人要;约束的执行力落在"执行 LLM 的产出被打回重答"这一环,对已经给定的输入打回没有重答方）;
- **列表元素形 `[line(非空)]`/`[line(nonempty)]` 同享约束**——元素逐个过非空核（双语同归一,与单值形一致）。

**HopSchema**：HopSpec 的结构化声明语法——`字段名 → 值` 的条目式映射，凡"用一张结构声明数据形状或配置"处统一用它（使用处：Outputs 复合类型展开、HopType struct Fields、工具 output_schema、spec Config 段——Config 就是一个 HopSchema 字段，作者定 2026-08-13）。**逻辑形状=映射**（键唯一）；**表面体例随宿主**——spec 内条目用 `-` 分项（与 Inputs/Outputs 同款，全篇一种分项心智），配置文件内为纯 YAML 映射。**值位语义由使用处定**：类型声明三处（Outputs/Fields/output_schema）值位=本节类型词汇（原子 + `[原子]`，可收窄不可扩）；Config 处值位=配置值（模型引用等）。 ^anc-type-hopschema

**复合类型用 YAML 展开**（HopSchema 使用处之一）：结构在节点体中用 YAML 缩进 + `#` 注释展开：

```
  + → generation_ctx:  # LLM 生成所需的完整上下文
    - task_desc: text  # 要实现什么：完整的任务目标
    - constraints: [line]  # 不可违反的硬性约束
    - io_schema: yaml  # 输入/输出数据结构
```

**复用类型**：跨步骤复用的结构体在文档级 `Types:` 区域定义，首字母大写，步骤中直接引用：

```
Types:
- ChatMessage:  # 对话消息
  - role: line  # 角色标识（system/user/assistant）
  - content: text  # 消息正文

## Steps
1. [act] 收集对话历史
  + → messages: [ChatMessage]  # 对话历史
```

仅单步骤使用的复合类型直接在节点体中 YAML 展开，不需要放入 `Types:`。

**命名约束**：
- **关键词双语直通（i18n,2026-08-15 作者拍板方案 B）** ^anc-i18n-keywords-bilingual：全部语言关键词中英**恒等价、同时被认、零声明**——spec 里写 `## 目标` 与 `## Goal`、`[推理]` 与 `[reason]` 完全同义,无模式开关（头部声明方案否决:模式状态会渗漏进 replan 片段/--steps 提交块等无头碎片,每个入口都得传语言状态;直通无状态,碎片自解释）。三条配套：①**AST 恒存英文规范形**——引擎/validator/CLI 零感知,中文词在 parser 入口即归一;②**序列化归一**——serializer 按 spec 主导语言写规范形（Null 三写归一先例同款）,关键词语言混用出 lint 提示（warn 不 error）;③**hop_python 内置函数不翻**（len/strip 等——对齐 Python 心智,Python 生态本身即英文函数名）。**中文术语表已拍定**（2026-08-15 作者三轮裁定:act=探索〔与教程『探索与提交』主线一致〕/for-each…in=遍历…于〔轮询撞 polling 语义否〕/collect…into=收集…入/require_human=必须真人确认;全表权威在 [[../design/i18n#^anc-i18n-glossary]]）;中文关键词同为保留字。
- **变量名 = Unicode 标识符（Python 3 同款,2026-08-15 作者定）**：首字符为字母（含中文等 Unicode 字母）或下划线,后续为字母/数字/下划线——`risk_level`、`风险等级`、`客户_名单` 皆合法（Python/JS/Java 9+ 均支持 Unicode 标识符,中文名是一等公民）；**与 hop_python 表达式文法精确一致**（tokenizer 标识符字符集同为 `\p{L}\p{N}_`——名字能声明就必然能在 body/条件里引用,零冲突面）；英文名建议 snake_case（风格建议非硬闸）,与类型名（PascalCase）视觉分层。**语言关键词全部是保留字**（2026-08-15 作者定,随 i18n 双语关键词同批）：段头词（goal/constraints/types/inputs/outputs/config/steps/id）、步骤类型词（reason/act/check/confirm/ask/commit/call/branch/case/subtask/loop/parallel/break/continue/exit/on fail 之 on、fail）、属性与子句词（retry/max/adaptive/final/escalatable/free/collect/into/in/require_human）及其**中文对应词**（术语表见 ^anc-i18n-keywords-bilingual）不得作变量名——关键词与变量在多个语法位同槽出现,保留整族一劳永逸（else/类型名保留字先例的完整化）。**内置类型名是全局保留字**（2026-08-14 作者拍板 A）：`text/bool/line/number/int/float/markdown/yaml/prompt/HopSpec` 不得作变量名——类型词在多处语法位与变量位同槽竞争（call 输出映射 `+ → to: from` 冒号后是变量位,`domain: line` 会被读成"domain ← 名叫 line 的变量"而非类型声明,实撞产 null），类型词做变量名无真实表达需求，整类保留一劳永逸（同 `else` 保留字先例）
- **命名禁止产生望词生义的混乱**——名称读出来的含义必须与实际所指一致，是宪法级要求
	- 错误命名的代价与锚点不对齐同源：每个读者（人或 LLM）都按名称字面理解，一个误导性名称在每次被阅读时都注入一次错误假设，沿调用链指数放大
	- 往往一个词组也无法解释清楚具体的概念，所以每个类型、变量在定义或引入时，都需要有 # 或其他机制来做一句话的解释，可以追溯对齐语义
- PascalCase，必须用**词组**（≥2 词），不用单词（`PolicyRecord` 而非 `Record`）
- 避免与原子类型（`text`、`int`、`float` 等）冲突
- 名称应自解释所属领域（`ParamAdjustment` 而非 `Adjustment`，`ChatMessage` 而非 `Message`）

---

## 变量语义：Python 函数级作用域 + 自然保留 ^anc-exec-loop-var-scope

HopSpec 变量对标 **Python 函数级作用域**：**一份 spec 的一次执行 = 一次函数调用 = 一个扁平命名空间**。subtask/loop/branch/case 是**控制流块，不是作用域**——同 Python 的 `for`/`if`/`try` 块，块内赋值就是写函数命名空间里的那一个变量，嵌套多少层容器都不改变这一点。**同名 = 同一个变量**（V2 禁重名保护的正是这个唯一性），不存在"深层写产生局部副本"。

真正的作用域边界只有两处，都对应 Python 的既有概念：
- **`call` 子 spec = 函数调用**——独立命名空间，param_mapping 传参、output_mapping 接返回值；
- **`parallel` 派出去的活 = 独立进程**——子实例隔离，入参在派发时显式传入（快照当时值），收齐时收结果。

变量一律**自然保留**——跨迭代（loop）、跨重试（subtask retry）都不自动清空，引擎不做隐式清空。**retry 就是 Python 循环的简化写法**（`for attempt in range(N)` 的语法糖）：重跑在同一命名空间上自然覆写，未显式声明初值的变量残留可读——利用上次的错误经验（读残留、带反馈重做）是 spec 作者的表达空间。两个例外，都源于作者自己的显式声明或结构声明：**写了 `= 初值` 的变量在容器重新进入时回初值**（重试重跑、重新规划后重跑、外层轮进重入都算重新进入——写初值即声明"每次从头跑都从初值开始"，见下方 `= 初值` 语法）；**collect 收集列表随 loop 进入清空**（loop 每次进入执行，收集账从空开始——首跑、重试重跑、重新规划后重跑、外层轮进重入，一律如此，不区分从哪条路进来的。收集是引擎按结构代管的账：进入即清、逐轮收、收口才写回目标变量，旧轮条目永不混入，否则重复累加逐轮翻倍）。

**容器头 `+ →` 是意图声明，不是访问控制**（详见「容器的输入与输出」）：块内变量块外照常可读，同 Python 函数内的变量。并发结果的汇聚语义只有收集列表一种（累加器是主线串行语义，parallel 标注步骤的输出声明为累加器是静态错误），归约写法亦见该节。

**累加器**——跨迭代累积（如逐轮追加的 findings、逐次拼接的 error_log）：在 loop 或其上层容器节点声明 `+ → acc: type = 初值`，初值在**容器进入时求值并写入一次**（非每轮）。子步骤以更新模式（`← acc … + → acc`）读取并累加。

**显式重置**——需要每轮/每次清空某变量：在子步骤显式声明 `+ → x: type = Null`（或其它初值）。该声明所在步骤**每次执行时写入初值**——loop 内每轮该步都执行，即每轮重置。**重置是 spec 里可见的一步，不再是引擎背后的魔法。**

**`= 初值` 语法** ^anc-exec-output-init：`+ → x: type = 初值 # 说明`。
- 声明在**容器节点**（loop/subtask 自身的 `+ →`）→ **每次进入 init 一次**：容器进入时写入，同一次进入内跨迭代保留（累加器）；容器**重新进入**（外层轮进重入、subtask retry 重跑、重新规划后重跑）时重新写入初值——"进入时执行"按字面兑现，重跑轮从初值开始不背上一轮的累积。
- 声明在**叶子步骤**的 `+ →` → 该步**每次执行时**重置为初值（每轮清零）。
- `Null`/`None`/`null` 归一为空值；其余按 type 解析字面量（`[]` 空列表、`{}` 空对象、`0`、`false`、`""`、裸文本为字符串）。
- 与 `← ` 带入的关系：`= 初值` 是显式声明，**优先**——若作者想沿用上游带入值，就不写 `= 初值`。

**计算异常 = 步骤 fail（HopSpec 没有异常语法）**：语言层无 try/catch、无异常值——错误的原子单位是**步骤**，不是表达式。纯计算错误（文本参与数值比较、None 上取字段、非法下标）就是程序错了：body 算错 → 本步 fail，条件算错 → branch fail，走标准升级链（重试阶梯→逐层上报）——计算错误与步骤失败共用同一条错误干线。宿主异常（如工具执行失败）只在引擎内部承载，出口统一折为步骤 fail，绝不穿出语言面。详见 [[HopSpec V3错误模型]]（失败语义权威见 [[#^anc-exec-none-propagation]]）。

**残留由作者负责**（同 Python）：若某变量某轮/某分支未被产出，`← ` 会读到它上一次的值（不是 undefined）。这不是 bug——要避免就显式 `= Null` 重置，或确保每轮必产出。validator 只校验"变量名已声明"（静态存在性），不追踪运行时是否本轮产出。

```
2. [loop max=20] 逐条审查
  + → findings: yaml = []   # 累加器：容器进入 init 一次为空列表，跨迭代累积
  2.1. [reason] 取下一片段判严重度
    + → severity: line      # 每轮被本步重新产出，自然覆盖上轮值（无需显式重置）
  2.2. [act] 追加本轮发现
    - ← findings, severity  # 读累加器 findings + 本轮 severity
    + → findings            # 更新累加器（更新模式，非重名）
```

---

## 执行模型

HopSpec 定义任务结构和数据流，执行细节由 HopJIT 引擎按以下语义契约处理。

### Prompt 组装 ^anc-exec-prompt-assembly

HopJIT 为 `reason`/`check` 步骤组装 prompt 时，按 6 层构建 context：

| 层级               | 来源                                                          | 内容                                                                                            |
| ---------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| L1. Spec 契约 + 骨架 | `Goal:` + `Constraints:` + `Types:` + `Outputs:` + Steps 骨架 | 不随步骤变化的全局背景——目标、约束、类型定义、输出声明，加 Steps 骨架（静态步骤树，见下文「L1 骨架定义」）让 LLM 看到完整计划与自身位置                  |
| L2. 知识上下文        | KnowledgeLayer.retrieve                                     | 领域知识（Spec `@knowledge` 全局预检索 + `lack_of_info` 补充检索 + 步骤 `@knowledge` + 动态检索）。可选               |
| L2d. 文档引用        | doc-ref `[[文档路径#章节名]]` 解析                                   | 作者用 `[[文档路径#章节名]]` 钉定的**确定性精确引用**——引擎读该文件、切出该章节注入。区别于 L2 的模糊语义检索（见 [[#^anc-exec-doc-ref]]）。可选 |
| L3. 执行链上下文       | 执行树                                                         | 从根到当前步骤的完整执行上下文——容器结构、已完成步骤产出、loop 迭代状态、branch 命中哪个 case                                      |
| L4. 步骤输入         | `- ←` 变量                                                    | 当前步骤依赖的实际数据                                                                                   |
| L5. 步骤指令         | 摘要行 + `>`                                                   | 任务目标和执行指导                                                                                     |
| L6. 输出约束         | `+ →` 类型结构                                                  | 期望的输出格式和字段                                                                                    |

**L1 骨架定义** ^anc-exec-l1-skeleton：L1 除契约（Goal/Constraints/Types/Outputs）外，附 Spec 的**静态步骤骨架**——给 LLM 全局计划视图与自身位置感，与 L3 动态执行链互补（骨架是静态地图，L3 是动态轨迹，不重叠）。骨架的精确边界：

- **含**：每步的 `step_id` + `[step_type]` + summary（摘要行那一句）；树形嵌套结构；步骤关键属性（`loop max`、**`loop for-each <item> in <list>` 子句**、`parallel`（subtask/call 的异步派发标注）、`subtask retry/adaptive`、`case condition`）——让控制流意图可见。**for-each 与 collect 子句必须入骨架**：二者都站在控制流与数据流交界（for-each 是重复驱动源 + `<item>` 定义点；collect 是收集关系 + `<单项>` 的归宿声明），按定义纪律名字的定义点就是子句——骨架是它们对执行 LLM 的**唯一声明**，不渲染则 children 的 `← <item>` 来历不明、`+ → <单项>` 去向不明。这不违反"不展示数据流"：子句声明的是**绑定关系**（控制流如何驱动命名），不是变量的值与流向
- **不含**：执行状态（done/running/skipped，属 L3）；产出值与变量数据（属 L3/L4）；节点体 `← / + → / >`（数据流与指令属 L4/L5/L6，骨架不重复）
- **不展示数据流**（`← / + →`）：骨架是"控制流计划地图"，保持轻量；数据契约由 L4（当前输入）/L6（输出约束）/L3（已产出）承担

示例（6 步骨架）：

```
1. [act] 扫描目标目录文件列表
2. [reason] 生成重命名方案
3. [confirm require_human] 用户确认重命名方案
4. [act] 准备重命名（生成可逆备份）
5. [commit] 执行批量重命名（不可逆）
6. [reason] 生成执行报告
```

**知识注入（L2）四来源**：

全局作用域（每步都有）：
- **Spec @knowledge**：`Constraints:` 中声明 `@knowledge 关键词`，预检索一次，全程可用
- **补充检索**：reason/check 步骤返回 `lack_of_info` 时，以描述为 query 检索，标注"由步骤 N 的 lack_of_info 触发，前序步骤未参考此知识"。触发后对后续步骤全局可见

步骤作用域（仅当前步骤及其子步骤）：
- **步骤 @knowledge**：步骤 `>` 指令区声明 `@knowledge 关键词`，执行该步骤（及子步骤）时检索注入
- **动态检索**：从当前步骤的摘要 + 指令自动提取关键词检索，无需显式声明

四来源互补——Spec @knowledge 覆盖全局知识需求，步骤 @knowledge 精确到步骤，动态检索自动补充背景，补充检索兜底信息不足

**文档引用（L2d）——`[[文档路径#章节名]]` 确定性精确引用** ^anc-exec-doc-ref

`@knowledge`（L2 四来源）是**模糊语义检索**：给关键词，由 KnowledgeProvider 自行判断哪些片段相关、按相关性排序。但很多场景作者**确切知道**要注入哪份文档的哪一节（如"生成 HTML 时必须遵循品牌规范的『组件库』一节"），不需要也不应该让检索后端来猜。doc-ref 为此而设：

- **语法**：在步骤 `>` 指令区或 `Constraints:` 中写 Obsidian 风格的 `[[文档路径#章节名]]`。引擎读该文件、按 markdown 标题切出该章节、注入到 context 的 L2d 层。目标文件是 YAML（`.yaml`/`.yml`）时锚点按**键**切：`#键名` 或 `#外层键.内层键` 点路径，切出该键及其下子树（原文行区间，注释保留）——结构化规则表存 YAML 是常见形态，按键精准注入与按标题切章节同一语义。
- **确定性**：作者钉死"注入这一节"，无相关性排序、无 provider、无语义匹配。`[[]]` 本身也是 Obsidian 原生可点链接——人读 spec 时直接点开，与引擎为 agent 解析是同一个锚点的两种消费方式。
- **与 @knowledge 正交共存**：doc-ref 是确定性精确引用，@knowledge 是模糊语义检索；同一步骤可并用。doc-ref **不依赖 KnowledgeProvider**——文件读取是引擎自带能力（受 SandboxConfig 约束，只读 workspace 内、走读权限链）。
- **仅 agent 通道**：引擎只为 reason/check/act 等步骤给执行 LLM 的 context 解析 `[[]]`。confirm/ask 等面向人的暂停通道**不解析**——人靠 Obsidian 原生点击。
- **章节级精度**：引用锚点是知识文档现有的 markdown 标题（`## 二、色板` / `### 4.7 统计框`），不要求知识文档为此改造或加段落锚点。强制要求 `#章节`——不支持 `[[doc]]` 整文档引用（易爆 token，违背"精确"初衷）。
- **环境参数展开（2026-08-14）**：路径位支持 `{hop_env_xxx}` 展开——`[[{hop_env_kb_root}/判据/规范#节]]`，值取自 [[#^anc-config-hop-env]] 覆盖链，展开发生在注入期。只认 `{hop_env_*}` 形态，其余字符原样；路径中要写字面 `{`/`}` 用反斜杠转义 `\{`/`\}`（极罕见但文法必须完备）。引用了未定义的 hop_env 键=该步注入失败响亮报错（不静默空串——空串拼路径是找错文件的温床）。静态校验分档：字面路径照旧 validate 期查存在性（P15）；含变量的引用在配置可解析时 validate 期展开后查，配置缺席则推迟注入期。
- **找不到即响亮失败**：引用的文件或章节不存在 = spec 与知识文档不同步。校验在 spec 加载期静态执行（见 [[#^anc-rule-p15]]），不静默降级——静默会让作者误以为知识已注入实则没有。
- **大节自动卸载**：切出的章节超阈值时走大内容传递协议（写 work_zone 文件 + `$file` 指针，见 [[#^anc-exec-prompt-assembly]] 的 agent 通道处理），driver 按需 Read，不撑爆 prompt。

doc-ref 让 spec 保持"编排逻辑简明"——大段领域知识外置到知识文档，spec 只用 `[[]]` 精确引用。引用的精度即约束的强度：作者通过引用把执行 LLM 的注意力钉在确切章节，而非放手让它在整份文档里漫游。

**执行链上下文（L3）**：从根到当前步骤的完整执行树。展开的步骤显示输入（`←`）、执行说明（`>`）以及产出值（已完成）或输出声明（未完成）；产出值的变量名附 `# 说明`（与 Spec 中首次声明一致）；已完成容器展示聚合产出，子步骤折叠；loop 容器内嵌迭代状态。将进度、迭代历史、当前位置整合在同一棵树上。 ^anc-exec-l3-display-rules

L3 对控制流容器的展示规则（**可验行为点，各自可被审计**）。原则：L3 是给后继步骤提供"可引用的产出"，不是复现执行过程——故容器折叠到聚合输出，不展开内部、不显示未走路径：
- **branch 命中**：branch 折叠为单行，**标注命中了哪个 case + 展开 branch 的聚合输出**（供后继 `←` 引用），如 `✓ 2.2 [branch] ◀ 命中 2.2.1 → findings: [...]`。命中 case 的内部步骤**不展开**（后继不关心怎么走的，只关心产出了什么）；未命中的 case **不显示**（无产出、对后继无价值）。命中标记是必须的——它说明该输出由哪条分支产生。无 case 命中 → branch 静默跳过、不写任何值（见 [[#^anc-exec-container-output]] 无命中语义）。branch 聚合输出即命中 case 写入的同一变量 ^anc-exec-l3-branch
- **loop 迭代**：每轮标注迭代序号（第 N 轮 / 当前轮）+ 该轮关键产出 ^anc-exec-l3-loop

**信息不足退出**：`reason` 步骤的输出约束中内置 `lack_of_info` 退出选项——LLM 可声明无法基于当前输入完成任务，触发知识补充检索后重试，仍不足则走正常 fail 错误链。避免因无退路而幻觉。

**工具故障退出** ^anc-step-tool-failure-exit：`reason` 与无 body 的 `act` 步骤同款内置 `tool_failure` 退出选项——执行 LLM 的工具调用实际失败（报错/超时）且没有它就无法完成本步时，以单键 `tool_failure: 故障说明` 代替正常产出，引擎按工具故障处置（fail_kind='tool_failure'，走重试阶梯——瞬时故障重试即愈）。避免工具坏了硬凑产出：检索类工具故障与"检索成功但确实搜不到"在产出面不可区分，无退路时故障会伪装成"无结果"静默污染下游。与 lack_of_info 的分界：**缺信息（材料本来就没有）走 lack_of_info，工具故障（取材料的手段坏了）走 tool_failure**——两键语义不同不互替，修复路径不同（前者补充知识，后者重试）。有 body 的步骤不设此出口（body 的工具失败由引擎确定性承载，不经 LLM 产出面）；`check` 不设（判不了的正形＝如实判 false 并说明）。

**完整示例**——Spec 及执行到步骤 4（branch 已命中执行完）时 PromptAssembler 组装的 6 层：

```
# Spec: 多渠道舆情监控与预警
Goal: 监控社交媒体和新闻渠道的舆情风险，超阈值时生成预警报告
Constraints:
- 每轮采集覆盖所有已注册渠道
- @knowledge 舆情风险评级标准
Inputs:
- target_domain: line  # 目标领域
Outputs:
- alert_report: markdown  # 预警报告
- actions: [line]  # 应对行动项

## Steps
1. [subtask] 初始化监控配置
  - ← target_domain
  + → channels: [line]  # 监控渠道列表
  + → keywords: [line]  # 监控关键词
  > 根据目标领域确定监控渠道和关键词
  1.1. [reason] 确定监控渠道
    + → channels
  1.2. [reason] 确定关键词
    + → keywords
2. [loop max=5] 每轮监控直到风险降至低级或满 5 轮
  - ← channels, keywords
  + → risk_level: enum(low, medium, high)  # 当前风险等级
  + → trend: line  # 风险变化趋势
  > 循环监控各渠道舆情，每轮采集+分析，直到风险降至低级或满 5 轮
  2.1. [subtask] 并行采集各渠道数据   # 容器边界=收齐点：2.2 消费前两路必已收好
    + → social_data: yaml  # 社交媒体采集数据
    + → news_data: yaml  # 新闻媒体采集数据
    2.1.1. [subtask parallel] 采集社交媒体舆情   # parallel：派出去跑
      + → social_data
      2.1.1.1. [act] 调用社交渠道接口
        - ← channels, keywords
        + → social_data
        > 调用 social_api.search(keywords)，返回最近 24h 的帖子
    2.1.2. [subtask parallel] 采集新闻舆情   # 与 2.1.1 并发在跑
      + → news_data
      2.1.2.1. [act] 调用新闻渠道接口
        - ← channels, keywords
        + → news_data
  2.2. [reason] 分析舆情风险
    - ← channels, keywords, social_data, news_data
    + → risk_level, trend
    > 综合各渠道数据，评估当前舆情风险等级和趋势
3. [branch] 按风险等级决定响应策略
  - ← risk_level
  + → alert_report: markdown  # 预警报告（branch 聚合输出：统一接口名）
  + → actions: [line]  # 应对行动项
  3.1. [case(risk_level == high)] 高风险
    + → alert_report: markdown  # 同名填充（同一个东西）
    + → actions: [line]
    3.1.1. [reason] 生成详细预警与应急方案
      - ← risk_level, trend
      + → alert_report, actions
  3.2. [case(else)] 低/中风险
    + → alert_report: markdown  # 同名填充（同一个东西）
    + → actions: [line]
    3.2.1. [reason] 生成常规监控小结
      - ← risk_level, trend
      + → alert_report, actions
4. [reason] 复核预警报告完整性        ← 当前执行到这里
  - ← alert_report, actions
  + → review_note: line  # 复核意见
  > 检查预警报告是否覆盖所有识别的风险点
5. [exit] 交付预警报告和应对方案
  + → alert_report, actions
```

```
═══ L1. Spec 契约 ═══
Goal: 监控社交媒体和新闻渠道的舆情风险，超阈值时生成预警报告
Constraints:
- 每轮采集覆盖所有已注册渠道
- @knowledge 舆情风险评级标准
Types: —
Outputs: alert_report: markdown, actions: [line]

步骤骨架（静态计划地图）：
1. [subtask] 初始化监控配置
  1.1. [reason] 确定监控渠道
  1.2. [reason] 确定关键词
2. [loop max=5] 每轮监控直到风险降至低级或满 5 轮
  2.1. [subtask] 并行采集各渠道数据
    2.1.1. [subtask parallel] 采集社交媒体舆情
    2.1.2. [subtask parallel] 采集新闻舆情
  2.2. [reason] 分析舆情风险
3. [branch] 按风险等级决定响应策略
  3.1. [case(risk_level == high)] 高风险
    3.1.1. [reason] 生成详细预警与应急方案
  3.2. [case(else)] 低/中风险
    3.2.1. [reason] 生成常规监控小结
4. [reason] 复核预警报告完整性
5. [exit] 交付预警报告和应对方案

═══ L2. 知识上下文 ═══
### Spec @knowledge（全程可用）
- 舆情风险评级标准：低=提及量<100且无负面热搜，中=...，高=...（来源：内部SOP）

═══ L3. 执行链上下文（已发生轨迹 + 当前步骤位置锚点；未来步骤见 L1 骨架，不重复）═══
Spec: 多渠道舆情监控与预警
├─ 1. [subtask] 初始化监控配置 → done
│    产出：
│      channels: [微博, 抖音]  # 监控渠道列表
│      keywords: [产品召回, 安全隐患]  # 监控关键词
├─ 2. [loop] 每轮监控直到风险降至低级或满 5 轮 → done（共 2 轮）
│    + → risk_level, trend
│    第 1 轮：risk_level=high, trend=上升
│    第 2 轮：risk_level=high, trend=持平
│    最终聚合：risk_level=high, trend=持平
├─ 3. [branch] 按风险等级决定响应策略 → done ◀ 命中 3.1（高风险）
│    聚合产出（由命中 case 3.1 同名填充，branch 透传）：
│      alert_report: "## 高风险预警\n微博「产品召回」提及量激增..."  # 预警报告
│      actions: [立即成立应急小组, 24h 内发布官方声明]  # 应对行动项
├─ 4. [reason] 复核预警报告完整性 ◀ 当前步骤
     （契约见 L4/L5/L6，此处仅标位置，不重复 ←/>/+→）

═══ L4. 步骤输入 ═══
alert_report: "## 高风险预警\n微博「产品召回」提及量激增..."  # 预警报告（来自 case 3.1）
actions:  # 应对行动项（来自 case 3.1）
  - 立即成立应急小组
  - 24h 内发布官方声明

═══ L5. 步骤指令 ═══
复核预警报告完整性
> 检查预警报告是否覆盖所有识别的风险点

═══ L6. 输出约束 ═══
+ → review_note: line  # 复核意见
```

注：L3 中 branch（步骤 3）折叠为单行 + **命中标记 ◀ 命中 3.1** + 展开 branch 的聚合输出（`alert_report`/`actions`，变量名附 `#` 说明防望词生义）——命中 case 内部步骤（3.1.1）不展开、未命中 case（3.2）不显示。聚合输出由 **branch 声明**（统一接口名）、命中 **case 同名填充**（同一个东西）、branch 透传到外层，故当前步骤 4 能直接 `← alert_report, actions`。当前步骤 4 在 L3 中**仅作位置锚点**（标 ◀ 当前步骤），其 `←/>/+→` 契约不在 L3 重复——交由 L4/L5/L6 承载；未来步骤 5 由 L1 骨架承载（三层不重叠，见 [[#^anc-exec-l1-skeleton]] / [[#^anc-exec-l3-branch]]）。

spec 作者通过节点体（`>`）自然表达 prompt 意图，HopJIT 负责组装和 token 管理。`>` 中可指定角色视角（如"以精算师视角分析"）、关注维度、方法论等 prompt 指导。`>` 中还支持两种特殊标注：

**`@knowledge` 标注**——知识检索注入（详见 Prompt 组装 L2 知识上下文）

**`@src` 标注**——步骤级源锚点（可选,翻译工具链元数据） ^anc-step-src-annotation

格式：`@src <原文出处>`（出处记法自由——段落号/原句短引文/章节名）,在 `>` 指令区声明,任何步骤类型可标。语义：本步骤翻译自上游文档（自然语言 skill 等）的哪一处——**纯追溯元数据,零执行语义**：解析期从指令区剥出存 AST（`src_ref` 字段,与 `@model` 同通道）,**不进执行 LLM 的 prompt**、不参与校验判定、不影响任何执行行为;serialize 写回（往返保留——锚随产物持久化,原文演进后翻译工具链据它做增量对账）。消费方=hopbuild（对账/重审）与人工审阅,引擎只负责运载。

**`@model` 标注**——步骤级模型路由覆盖（详见 [[HopAnt概念-双态组件模型#^anc-config-model-engine]]） ^anc-exec-model-annotation

格式：`@model service_id/model_name`，在 `>` 指令区声明。仅对可执行步骤（reason/act/check/commit）有效。

```
2. [reason] 分析舆情风险
  - ← social_data, news_data
  + → risk_level: enum(low, medium, high)
  > @model deepseek/deepseek-v4-pro
  > 综合各渠道数据，评估当前舆情风险等级和趋势
3. [check final] 验证风险评级合理性
  - ← risk_level, social_data
  + → rating_ok: bool   # 判定槽：评级是否合理
  + → rating_note: text # 说明槽：不合理时的具体偏差（通过时不被查看）
  > @model anthropic/claude-sonnet-4-6
  > 独立核验风险评级是否与原始数据一致（交叉验证）
```

Spec 级模型配置在 `Config:` 段声明，两种形态：

- **类别映射 `models:`**（推荐）——按步骤类别分档，与"步骤类型即认知强度声明"同构：act/commit 执行类轻量档、reason 推理中强档、check 核验档（宜换一家交叉验证）、replan 元编程档（须会写 HopSpec 的模型）：

```
Config:
- models:                               # Config 段就是一个 HopSchema 字段（^anc-type-hopschema）——内外层条目同用 - 分项
  - act: deepseek/deepseek-v4-flash     # 执行类（含 commit;另写 commit: 键可分档）
  - reason: deepseek/deepseek-v4-pro
  - check: bailian/qwen3.7-plus         # 核验换一家交叉验证
  - replan: zhipu/glm-5.2               # 元编程档
```

- **单默认 `- model:`**——全类别同值的简写。
- **Config 段就是一个 HopSchema 字段**（[[#^anc-type-hopschema]]）：条目内外层都用 `-` 分项（与 Inputs/Outputs 复合展开同款——spec 全篇一种分项心智），引擎递归归一为配置映射。

**`@thinking` 标注**——步骤级思考开关（2026-09-20 新增,0100 批） ^anc-exec-thinking-annotation

格式：`@thinking on` 或 `@thinking off`，在 `>` 指令区声明，一步至多一条。语义：单独控制本步骤的模型思考通道——机械性步骤（提取、格式转换、照单填表）标 `off` 省费用（思考型模型实测 8-9 倍），重推理步骤标 `on` 让缺省不开思考的模型拿到推理档能力。不标时按引擎的思考缺省链决定（从高到低：思考烧穿记名册 > 本标注 > 系统层 routing_rules 的 thinking > provider 级缺省 > 步骤类型缺省——act/commit 关，act free/reason/check/replan 开）。仅对可执行步骤有效；带 `hop_python` body 的步骤引擎直执不调模型，标了无效果也不报错。与 `@model` 可同步共存。写法示例与完整缺省链见语法参考与配置参考。

**spec 面模型引用是软偏好**（作者定 2026-08-13）：`@model`/`Config.models`/`Config.model` 写的是偏好——环境里有这个 service 就用，没有则落下一级并留痕（HopLog warn），**不报错**。与 Constraints 同哲学：spec 声明意图，环境尽力满足——spec 由此天然可移植（写了 `zhipu/glm-5.2` 的 spec 在没有智谱的环境照常跑，该档落环境缺省）。系统层引用（routing_rules/default_model）维持硬校验——运营者配自己的环境，拼错启动即拒。

**两层配置逐类别继承，层层可缺省**：spec 层没配的类别继承系统层（环境 routing_rules）；系统层也可不配——落环境默认模型（一个模型跑全部类别照样合法，分档是优化不是义务）。spec 只声明自己在意的差异。完整优先级：步骤 `@model` > `Config.models[类别]` > `Config.model` > 系统层 routing_rules[类别] > 系统层默认 > 环境缺省。confirm/ask 是介入点无 LLM 不路由；call 用子 spec 自己的 Config。 ^anc-config-models-tier

**spec 环境参数（`hop_env_*` 命名空间）** ^anc-config-hop-env

spec 消费的环境配置参数（材料库路径、知识库位置等**非密**环境值）统一住 `hop_env_` 前缀命名空间，**与系统环境变量彻底脱钩**——来源只有两条显式路，spec 世界零隐式进程状态：

- **覆盖链（后者覆盖前者，逐键非整块）**：系统级 config.yaml `env:` 节 → 项目级 hopjit.yaml `env:` 节 → 调用方 params 传入 → `ask` 运行时问人。配置里写全名（`hop_env_kb_root: /path`——所写即所引）；
- **只读**：hopspec 不可修改 hop_env_* ——它是环境配置不是业务状态。`hop_env_` 是保留命名空间：步骤 `+ →` 产出名、act body 赋值目标带此前缀一律报错；**ask 输出到 hop_env_* 放行**（ask 是覆盖链的合法末级——运行时问人补值是设计内，不是 spec 自改）。可写（spec 内派生环境值）留真需求再议；
- **引用（面最小）**：`{hop_env_xxx}` 引擎侧展开**仅在 doc-ref 路径位**（见 [[#^anc-exec-doc-ref]]）；hop_python body 中作只读变量注入、插值走 Python 自身 f-string；instruction 散文**不展开**——hop_env 值表随 prompt 注入，执行 LLM 自行指代（散文花括号歧义面大，引擎猜哪个该展开是误伤温床）；
- **凭证禁入**：key/token 类**严禁**写进 env 节、经 params 传入**或经 ask 回填**——hop_env_* 是可落盘可入日志的数据；覆盖链**三级同一道闸**（凭证形态键名=以 _key/_token/_secret/_password 结尾,任一级收到即响亮拒并指路 api_key_env——ask 级尤要:人现场输入最容易顺手贴 token）。凭证只走 `api_key_env` 名引用纪律（环境→内存快照，全链不落盘）。位置是数据，凭证是秘密；
- **依赖显式化**：spec 需要哪些环境参数，在自身说明/Inputs 注记中写明——调用方一看便知要备什么，缺了用 ask 问。

### HITL 介入点统一表达 ^anc-exec-hitl-presentation

CITL/HITL 介入点（`confirm` 审批、`ask` 数据收集）暂停时，引擎返回给 caller 的是**自包含介入请求**——caller（人或上层 Agent）拿到就知道"要我看什么、给什么、怎么给"，无需查阅 spec 或外部上下文。这与 reason/check 的 6 层 prompt（给 LLM 的自包含输入）、parallel 标注步骤的派活指令（给 driver 的自包含派活单）同源：**引擎对外的每种介入请求都自包含**。

暂停返回（`paused`）按介入类型组织，共用骨架：

| 字段 | confirm（审批） | ask（数据收集） |
|------|----------------|----------------|
| `question` | 自包含问题：要审批什么动作 + 影响 | 自包含问题：要 caller 提供什么数据 |
| `presented`（`←` 数据） | 待审批的内容（供决策者看） | 候选来源 / 推断依据 |
| `output_schema` | bool 审批槽 | 要 caller 填的变量名+类型 |
| `default_value` | — | 前序推断的默认值（caller 可直接采用） |
| `options` | approve / reject | 结构化候选 `[{value, description}]`（来自 `←`，可选） |

**核心区别**：confirm 的 caller 答"批/不批"（approve/reject）；ask 的 caller 答"值是什么"（具体数据，或采用 default，或选 option）。引擎据介入类型解析 answer——confirm 走审批决策（approve→bool true / reject→全局中止），ask 走数据落值（直接写 `+→` 声明的变量名）。

**决策权归外部决策者，driver 不得替答**：paused 是 spec 作者**显式**声明的介入点——作者特意放 confirm/ask，就是要**外部决策者**（人/上层 agent）来定，与 reason/check（执行 LLM 自己推理产出）本质不同。驱动适配层（driver）收到 paused **必须**把介入请求展示给决策者、等其回答，**不得**自己推理出答案直接 submit。`require_human: true` 时决策者**必须是真人**，零例外；未强制时可由上层 agent 代答（CITL），但 driver 默认倾向问人——拿不准就问。这是介入点的语义底线：把人/决策者留在环里。

confirm 与 ask 分立的理由：审批信号（approve/reject）与业务数据值走同一通道必然互相污染，介入类型化让 caller 不会答错；driver 对 paused 的"必须问人、禁止替答"契约（见 driver SKILL.md）守住介入点语义。

### 并发执行模型：异步派发 + 容器边界收齐 ^anc-exec-gather

**主线串行推进是执行的唯一骨架**，并发不是另一种执行形态，只是标注步骤的派出方式：

- **派发**：主线执行到 `parallel` 标注步骤（subtask/call）→ 派出去跑，不等它完成，主线继续下一兄弟/下一迭代。未标注步骤主线自己同步做（做的时候已派出的活照常在跑——未标注 ≠ 等待屏障）
- **名额**：同时在跑的总路数由系统配置定（`max_concurrent_workers`，缺省 5），**主线自己也算一路**——配置 N = 主线 1 路 + 最多 N−1 个在跑的活；**配 1 = 名额全归主线，parallel 标注全部退化为同步执行**（全串行调试口子，零附加机制）。名额不进 spec——能否并发是 callee 的性质（申报），用几路并发是部署的资源（配置），各归其位。名额满时主线停在派发点，等任一活收完腾出名额再派
- **随到随收**：哪个活跑完，引擎当场收——成功的取输出、失败的记 FailRecord，名额立刻腾出。这是引擎内部的连续动作，作者无感
- **收齐（gather）**：任何容器的完成条件 = **主线走完（兄弟序列走完/迭代耗尽/break）∧ 本容器派出去的活全部收好**。主线走完后剩下在跑的活未收完 → 容器显示"还在跑"直到收齐（收尾等待）——这是作者唯一感知到的"等"。收齐没有语法：收在哪（容器边界）、收什么（本容器派出的全部活），引擎自知，作者无凭据可弄丢——结构化并发，无游离 Future。**收敛边界 = 最近的任务容器（subtask/case/loop）祖先**（2026-08-13 作者定）：case 是 branch 下的事务单元（就是 subtask），自身即边界；**branch 是唯一的透明结构**（选择结构不是任务单元，不欠收齐承诺）——`[case parallel]` 被派发时其边界穿过 branch 落上层任务容器；loop 无远程特权（中间隔着 subtask/case 时边界收窄到最近那层）。**边界必须是最近事务**的推演根据：并行活的失败沿边界上报、走边界的 `retry=N`——若边界可越过更近的事务容器，失败归属就随远处结构漂移，"这只活失败了谁的 retry 预算管它"不再恒定（retry 归属抖动），事务语义失效
- **并行失败与值**（2026-08-13 作者定）：本该由并行活交付的具名输出，活重试耗尽终败后**值空间不存在任何形态**——无占位符、无哨兵 None（None 不携带错误语义的既有铁律）。处置=**收割即 fail**：失败的活收割那一刻，收敛边界当场把该派发步骤记 fail、杀掉域内其余在飞活（失败=停的既有清场），走边界自己的 retry/升级链——下游要么看到边界修复后的真值，要么根本不运行（与"不存在失败了还继续跑的第三态"同一条铁律）。loop collect 的部分失败=列表变短，仍是唯一的部分失败例外（作者选用集合语义时显式接受）。**全灭不属部分失败**：一轮派发（派发数>0）的活全部失败时，例外条款不适用——宿主 loop 按 fail 处置走边界升级链，失败原因携带派发数与各活失败摘要。集合语义容忍的是"少了几个"，不是"一个都没有"：全灭后的空列表若被放行，下游按空输入正常跑完，整次执行以 completed 收场——全部失败被伪装成成功，违背"无第三态"铁律
- **无 Future 铁律（数据面）**：parallel 标注步骤的输出**在其所在容器内不可被消费**（值可能未回，S12 静态拦），只经容器边界导出——loop 经 collect 列表（失败活不贡献元素），subtask 容器经头部具名 `+ →`（收齐后可读）。容器内确需消费其输出 → 把两者包进同一子 subtask（依赖显式化为串行结构）
- **失败**：**主线步骤 fail → 引擎立即杀死本容器全部在跑的活，不留幻影**（失败=停，被杀的活记 killed 终态：不算 failed、不产出、恢复时不复活）——这是引擎失败路径的内部清场，作者面没有 cancel 语法。派出的活自己 fail → 部分失败集合语义（见「容器失败语义」），主线与其余活不受影响。break 是正常路径：照常收齐、不杀活（结果还是要的）
- **HITL**：派出的活内 confirm/ask 暂停 → 冒泡语义不变（confirm 全局直达、ask 逐层自治，见 [[#^anc-exec-call-escalation]]）；收尾等待包含等人（无限期，无超时哲学）；多个活同时暂停可并存呈现

### 失败语义：fail 即异常（无异常语法） ^anc-exec-none-propagation

HopSpec 取**异常的语义**、弃**异常的语法**——失败自动上报、由有更大上下文的一层决定怎么办（人类组织处理失败的天然方式），但语言里没有 try/catch：失败处理不写在流程里，而是挂在结构上（`[subtask retry=N]` = 这摊事这个组负责、给 N 次机会）。两条线：

**错误线（步骤状态机）**：每个步骤有隐式状态 `hop_status`：`ok` | `fail`。fail 的入口四类——执行体报告失败、check 判 false、**计算异常**（body/条件里的类型错、非法下标——程序错了就是这一步失败，条件里算错即 branch 失败）、引擎守卫（超时/预算）。fail 信息的承载体是**失败记录（FailRecord）**（四字段：失败步骤 / reason 真因 / fail_kind 分类 / 轮次，逐轮累积随实例留存——升级链、修复阶梯、跨 call 传递用的都是它，详见 [[HopSpec V3错误模型]]）；fail_kind 路由修复路径（`error`→重试阶梯 / `lack_of_info`→知识补充路径 / `tool_failure`→重试阶梯〔工具故障退出条款,瞬时故障重试即愈;与 error 同路但语义可审计——自报故障与 hoplog 工具账可对账〕 / `deterministic`→跳过重试直达兜底〔重跑必然同因的失败,不烧重试预算〕）。失败沿事务边界逐层升级（见「分层重试与自适应」），耗尽到顶 = 实例 failed 上报 caller。**没有第二条错误通道**：宿主异常（工具失败等）只在引擎内部承载，出口统一折为步骤 fail，绝不穿出语言面。**fail 不碰值空间**：引擎在 fail 时不清理、不回滚——失败步骤及同轮前序步骤已写下的变量原样保留（重试轮的修复素材），残留的处置归 spec 作者（初值 `= Null` 重置、重跑覆盖、rollback 扩展），引擎只记账与调度。

**值线（None 是普通值）**：`None` 不携带错误语义——来源只有两种：显式重置（`= Null`）、声明未产出（分支未走）。**引擎不设"消费 None 自动 fail"的闸**：下游拿到 None 是业务情形不是错误——条件探测 None 走降级、或执行 LLM 看着 None 输入自行斟酌、或 check 拦住不合格产出。**fail 是函数级的，与异常同构**：一次 fail 只有两个去向——被某层事务边界接住修复（重试阶梯），或穿透全部边界**终止整个 spec 实例**（未捕获异常终止函数）。不存在"失败了还继续往下跑"的第三态，"失败影响下游"在语义上不存在：下游要么看到修复后的正常产出，要么根本不运行。唯一显式例外是 parallel 的部分失败（见「容器失败语义」）——作者选用 parallel 结构时显式选择的集合语义，非引擎缺省。

**未捕获失败 = 实例终止**：一次 fail 再也找不到事务边界接手时（一开始就没边界——祖先无任何 subtask/case，如平铺 spec；或耗尽到顶——最外层边界预算烧完），实例**立即终止、判 failed、上报 caller**——后续步骤不再执行，与未捕获异常终止函数完全同构。终止时值空间不清理（fail 不碰值空间）：交付给 caller 的是"failed + 失败记录 + 失败点之前的部分产出"（失败点之后承诺的 Outputs 缺席），caller 读失败记录与部分结果自行裁量。**失败中断执行是缺省**，作者不需要做任何事；要**容忍**失败才需要动结构——包事务边界（给修复机会）、用 parallel（集合的部分失败语义）、或把可能失败的探测降为业务分支。

### 容器失败语义

- 容器内 child fail 且 retry 耗尽 → 容器整体 `fail`
- **派出去的活（parallel 标注步骤的运行实例）fail → 部分失败集合语义**：主线与其余在跑的活不受影响，失败的活不贡献收集元素（收集列表本就乱序、槽位无归属，填 None 也不知道是谁的——部分失败 = 列表变短），FailRecord 随附，由收齐后的消费步骤决定是否可接受部分结果。这是"fail 是函数级"总则的**唯一显式例外**：集合操作天然尽力而为，作者标注 parallel 即选择了这份语义
- **主线步骤 fail → 本容器在跑的活全部被杀（killed，不留幻影）**，容器整体 fail——见「并发执行模型」失败条

### 分层重试与自适应 ^anc-exec-retry-adaptive

失败处理由 `subtask` 的 `retry` 和 `adaptive` 属性限定，范围明确。**`retry=N` 是总失败预算**——N 次失败容忍，耗尽则 subtask `fail`：

1. **retry（无 adaptive）** — 每次失败都重跑相同子步骤，逻辑不变，最多 N 次（适用于非确定性操作，如网络超时、LLM 随机性）
2. **retry + adaptive — 降级阶梯**（总预算 N 内，**按可信度由高到低逐级降级**）：
	1. **第 1 档·带反馈重跑**（首次失败）：重跑**相同 children 结构**，但把上次的失败说明（check 的 `text` 槽 / 失败步骤原因）注入重跑上下文——执行者知道"上次错在哪"，**非机械盲跑**。便宜、最可信（结构是 spec 作者写定、测过的），先试一轮（多数失败是偶发或局部偏差）
	2. **第 2 档·选预声明备用链路**（带反馈重跑仍失败、且有匹配备用链路时）：按失败的错误信息查**预声明的备用链路库**（按 `(spec_id, step_id, 错误模式)` 索引，见 [[#^anc-exec-adaptive-fallback]]）。命中则选那条**预先写好、测过的**备用 children 执行。**高可信——这不是生成，是选择**：备用链路和主链路一样是作者/运维预声明、经审的
	3. **第 3 档·基于备用链路重规划**（选了备用链路仍不对）：以该备用链路为脚手架 + 新错误信息，LLM 重规划。**中可信——有基础地改**，非从零
	4. **第 4 档·从零重规划**（无任何匹配备用链路）：LLM 从零分析失败、重规划 children。**低可信、兜底**——这是阶梯最末档，仅当前几档都不可用时
	5. 💡 **运行时只选不生成是常态，生成是降级兜底**：能选预备链路（第 2 档）就不生成；第 3/4 档的运行时生成都是"临时撑过这次"的产物，**必须经 HopLog 提报沉淀**（见下「运行时生成必沉淀」），学习发生在离线经审迭代、不在运行时——这是"控制流不归 LLM"的延伸：连应对没预备的新情况都不让运行时 LLM 自由发挥，而升级成给运维的提报信号
	6. ⚠️ 无论哪一档，范围都限定在当前 subtask 的 children 内，subtask 交付契约（`+ →`）与 `[check final]` 不可变——改策略不改目标、不改验收标准
3. **预算耗尽 → fail** — N 次失败后 subtask 整体 `fail`，上报 caller
4. **逐层上报 → HITL** — 每层 caller 在自己的 retry/adaptive 范围内尝试，耗尽继续上报；调用链顶端的人类是终极决策（重试 / 跳过 / 终止）
5. **commit 退火先于一切档位（2026-08-20 作者定,权威 [[#^anc-step-commit]] 退火条）** — 事务边界内（含任意深度后代,跨 call 同界）已有 commit 成功执行的，该边界的 retry/adaptive 全部档位**不再可用**：失败触发到它时立刻 `fail` 上报（不重跑、不降级重规划）——防止 commit 随整组重跑再次执行。标记随 commit 执行即打上、沿祖先链全程有效不清零（重跑无法撤销已发生的不可逆动作,故不存在"新轮次重新可试"）

**运行时生成必沉淀（渐进固化）**：第 3/4 档的运行时生成产物，绑定 `(spec_id, step_id, 错误原因, 生成的 children)` 经 HopLog 审计提报，并落 spec 源同目录候选文件。运维离线审核后，晋升为预声明备用链路库新条目——下次同 `(spec_id, step_id, 错误)` 即命中第 2 档（不再生成）。这接入 [[HopSpec V3扩展-有序思考与渐进固化]] 的"动态→候选→沉淀"：系统越用，预备链路越全、越少走低可信的运行时生成。

**check 失败如何接入此阶梯**：check 判定 `false` 即触发所在容器的失败处理——首档带反馈重跑（check `text` 槽即反馈源），逐级降级。

**spec 源 vs 运行时 AST 快照（replan 的持久化基础）** ^anc-exec-adaptive-fallback：replan 改的是引擎内存里**当前执行的 AST**——它必须反映当前执行逻辑，故跨进程时随实例快照持久化（`.hopstate/<inst>/spec.json` 是**可变的运行时 AST 快照**，随 replan 演化）。这与 **spec 源文件不可变**（SSR DocTree 权威，只离线经审迭代）是两回事：运行时 AST 快照该随执行演化，spec 源不被任何一次运行篡改。预声明备用链路库是独立于主 spec 的外部资产（不内嵌主 spec，保持主 spec 只写主链路），按 `(spec_id, step_id, 错误模式)` 索引——它属 Spec 库的一种，沉淀就是往库加条目。

### 完整性约束 ^anc-exec-completeness

重试和自适应改的是**策略**（怎么做），不能改**目标**（做到什么）。目标由两重机制守护：

1. **`[check final]`** — `Constraints:` 的可执行化身。subtask 的成功路径必须经过 finally check，adaptive 不可改写或跳过。验"质"——约束条件是否满足
2. **Output schema** — `Outputs:` 声明不可降级。Engine 在 adaptive 重规划时验证新 children 覆盖所有 `+ →` 声明。验"全"——交付物是否完整

普通 `[check]` 可被 adaptive 改写（调整验证策略以适配新的执行步骤），`[check final]` 不可——它是契约边界的运行时守卫。

### HopLog——执行可观测性 ^anc-obs-hoplog

HopLog 是 HopJIT 的执行轨迹日志——只追加、实时落盘的完整执行历史，**给人和 agent 排查深层次 bug 用的**，不是应付式的日志文件。（解释性类比：类似飞行记录仪，事后复盘用、不参与飞行控制——文中一律以 HopLog 本名指代。）

当 Spec 执行出现预期外的结果时（LLM 幻觉、数据异常、策略失败、retry 耗尽），HopLog 必须提供足够的信息让人或 agent 能**还原完整的决策链路**：每一步看到了什么 context、做了什么推理、产出了什么、为什么失败、retry 时策略如何调整。

**核心要求**：

- **实时性**：严格按时序实时写入文件，禁止事后补写
- **完整性**：每个步骤的输入、输出、LLM 交互（model/tokens）、工具调用（name/result）、失败原因全部记录
- **可追溯**：事件按时间顺序排列，step_start/step_done/step_failed 配对，容器完成级联可见
- **安全审计**：audit 事件（tool_call/commit/hitl_decision）始终记录，不受日志级别限制——即使 level=warn 也能追溯所有不可逆操作
- **分级控制**：debug 记录完整值（含 LLM prompt/response），info 记录脱敏+截断值（真实值截 200 字符、密钥 pattern 抹除），warn 只记录异常
- **resume 支持**：跨进程恢复时从 HopLog 的已有记录继续追加，不丢失历史

**不是什么**：
- 不是给终端用户看的进度条——进度展示由 CLI/Skill 层负责
- 不是运行时状态文件——状态由独立机制管理，HopLog 是只追加的审计日志
- 不是性能监控——token 用量等数据附带记录但不是主要用途

**文件格式作为通用标准**：HopLog 的落盘格式（**YAMLL**——只追加、块级独立、人机兼读）被立为可观测性的通用标准，任何 runtime 载体（复用模式 CC、独立模式 dispatcher、将来的 Codex 等）都应遵循同一套格式不变量与保证属性——载体可换、观测契约不变。见 [[HopSpec V3扩展-可观测性与YAMLL日志格式]]。

---

## HopSpec步骤格式

### 摘要行

每步一行：

```
N. [type attrs?] description
```

| 部分 | 必选 | 说明 |
|------|------|------|
| `N.` | **是** | 编号，支持多级（`1.`, `2.1.`, `2.1.3.`） |
| `[type attrs?]` | **是** | 步骤类型（15 种）+ 可选容器属性（文法见下） |
| `description` | 否 | 一句话任务说明（建议 80-130 字符，语义完整） |

**容器属性文法**：

```
attrs        ::= attr ((","? WS) attr)*          -- 空白分隔；属性间允许逗号（可读性）
attr         ::= for-each-clause | flag | kv
for-each-clause ::= "for-each" WS item WS "in" WS list_var    -- 仅 loop；item=元素绑定名，list_var=列表变量
collect-clause  ::= "collect" WS unit WS "into" WS list_out    -- 仅 for-each loop；unit=单项变量（children 每轮产出 T），list_out=收集列表（容器头 + → 声明 [T]）
flag         ::= "parallel" | "adaptive" | "final" | "require_human"
kv           ::= key "=" value                    -- 如 retry=3、max=20
```

各属性的宿主与语义：`for-each`/`max` 仅 loop（互斥，两形态）；`collect` 仅 for-each loop（收集端声明，可多个）；`parallel` 属 subtask/call（callee 并发申报+异步派发）；`retry`/`adaptive` 仅 subtask/case；`final` 仅 check；`require_human` 仅 confirm/ask。属性顺序不限；歧义处（如 for-each/collect 子句含空格）由子句关键字定界。示例：

```
2. [loop for-each reviewer in reviewers, collect note into reports] 并行评审
3. [subtask retry=3 adaptive] 清洗并验证
4. [subtask parallel] 独立审计一路
5. [call construct(src: confirmed) parallel] 派发构建
6. [loop max=20] 逐轮修复
```

摘要行只用一句话描述意图，不声明输入输出（for-each 子句声明的是元素**绑定关系**，非数据流——见 loop 词条"两个名字的定义纪律"）。

### 节点体

摘要行之后是节点体，由三种前缀标记不同关注点：

| 前缀    | 含义   | 说明                          |
| ----- | ---- | --------------------------- |
| `- ←` | 输入   | 输入变量，只写变量名（类型和说明已在源头声明）；**建议**就近加 `# 说明`（`- ← items  # 待处理清单`），免读者回溯源头，非强制 |
| `+ →` | 输出   | 输出变量，必须标注类型和 `#` 含义说明       |
| `- 工具:` | 工具授权 | 特殊工具的节点级授权声明（`- tools:` 同义,2026-08-31 作者定）——每工具一行 `- 工具: 工具名  # 本步用它做什么`,放 ← → 之后 > 之前;`- 工具: *` 表全量授权。**只写名字与意图**——工具的参数签名与输出形状是环境注册面的事实,渲染期引擎从注册面取真身展开供给执行者(作者抄签名=必漂移)。**分档语义**:基础工具(文件读写族)零声明恒可用;特殊工具(spec 树编辑/外挂 MCP 件如 pdf/ocr)须声明才对本步可用,未声明=不可用。无 body 的 act 与 reason 消费此声明(带 body 的 act 工具调用静态可查走白名单通道;reason 2026-09-01 作者定"等同于 act 的能力,不能 commit 写"——独立执行时 reason 常需读盘上产物再推理,工具面=基础工具恒可用+特殊工具按声明,不可逆动作类工具恒拒;check 无工具面——判官纯判定,不动)。禁用半边（关掉本步某件工具,含基础族）见下行 `- 禁工具:` ^anc-step-tool-grant |
| `- 禁工具:` | 工具禁用 | 工具的节点级禁用声明（`- deny_tools:` 同义,2026-09-05 作者定"是不是可以在指定节点禁止 write tool"）——每工具一行 `- 禁工具: 工具名  # 为什么禁`,位置与授权行同带（← → 之后 > 之前）。**授权行的对称半边,管辖面更宽**:授权行只能开特殊工具,禁用行能关任意工具——**含零声明恒可用的基础族**（如 write）。被禁工具从本步执行者的工具清单里整体剔除（执行者根本看不到它,结构性根除——不是运行期拦截;standalone 的 API tools 字段与复用模式的 L4 工具清单同一语义）。**禁 `*` 不合法**（全量禁=本步零工具面,真要如此逐件列名——防手滑一行废掉整个工具面;授权行的 `*` 有"全量开"的正当场景,禁用行没有,有意不对称）。**同名既授又禁=写时报错**（冲突就是笔误或想不清,当场打回,不做运行期静默偏一边）。消费面与授权行同族:无 body 的 act 与 reason 消费,check/commit 不收。典型场景:修错类步骤禁 write/append 强制走局部编辑工具,防"改三处却全文重写"的输出浪费（2026-09-04 实测:37KB 草稿 7 轮全文回写 ≈17 万 tokens） ^anc-step-tool-deny |
| `>`   | 执行说明 | 约束、方法、关注点、`@model`、`@thinking`、`@knowledge`、`@src`（可选，段落级，放在 ← → 之后） |

```
1. [reason] 解读质量画像，制定修复策略
  - ← profile
  + → fix_plan:  # 修复方案
    - strategy: text  # 整体修复策略
    - missing_handling: [line]  # 各列缺失值处理方式
    - outlier_handling: [line]  # 异常值处理方式
  > 权衡数据保留率与质量，选择合适的处理方案
```

**变量名全局唯一**：不同数据不能使用同一个变量名，保证引用无歧义。变量一律**自然保留**（Python 语义），同名再次 `+ →` 是**更新**（在现有值上重写）而非重声明、不触发重名校验。一份 spec 的一次执行是一个扁平命名空间（容器是控制流块，见「变量语义：Python 函数级作用域 + 自然保留」），累加器与显式重置亦见该节。

**首次声明 vs 简写引用**：变量首次作为输出（`+ →`）出现时，必须标注类型和 `#` 说明。后续再次出现的变量——无论是输入还是输出——只写变量名即可，可逗号合并为一行：

```
  - ← data_profile, clean_suggestions
  + → cleaning_plan, cleaned_data
```

只有**新增**的输出变量才需要展开类型和说明。特别注意：每个变量、成员变量均必须用 # 通过一句话来解释含义，避免后继误用。

**简单类型**（原子/列表）一行写完：

```
  - ← threshold
  + → is_valid: bool  # 是否通过验证
  + → errors: [line]  # 错误信息列表
```

**复合类型**用 YAML 缩进展开：

```
  + → report:  # 精算分析报告
    - summary: text  # 执行摘要
    - metrics:  # 模型评估指标
      - gini: float  # 基尼系数
      - auc: float  # ROC 曲线下面积
    - recommendations: [line]  # 业务建议列表
```

### 树结构

嵌套层级由 step ID 编码：`2.1` 是 `2` 的子步骤。缩进仅为视觉辅助，解析器依据 step ID 构建树。

### 表层表述变种：内联紧凑风 / 标题风 ^anc-surface-heading-flavor

step ID 是唯一的树结构权威（见上「树结构」），表层排版对机器无意义——**同一套 AST 因此允许多个表层表述变种**，各变种解析出结构相同的 AST、语义等价。作者按场景挑风味：紧凑速览用内联风，人读审计用标题风。

**内联紧凑风**（默认，serializer 输出的权威形式）：步骤 `N.M. [type] 描述` 顶格平铺，节点体用 `- ←` / `+ →` / `> 指令` 前缀，如上文各例。信息密度高，适合速览与机器往返。

**标题风**（人读审计变种）：把痛点"控制流不能折叠、大段编排说明无处安放、输入变量易忘义"一并解决——借 Markdown 标题的原生折叠（Obsidian 可收起 step 子树、outline 面板即 step 导航器）。四条规则：

1. **步骤编号加 `#` 前缀，逐级加一**：顶层 `N.` 前加 `###`（`## Steps` 用了 `##`，步骤从 `###` 起），子步每深一层多一个 `#`（`N.N.`→`####`、`N.N.N.`→`#####`…）。深过 h6 继续加 `#`（`#######`+）——Obsidian 不渲染第 7 级标题、失去那几层折叠粒度，但解析器认 step ID 数字、不认 `#` 个数，照常构树。
2. **meta 紧贴标题、正文在后**：节点体 `- ←` / `+ →` 数据契约紧接步骤标题**下一行、不留空行**——契约先亮明；随后空一行写自然段落正文（= 执行说明，替代内联风 `>` 前缀，`>` 可省）。段落即指令，进 agent 执行上下文（与 `>` 等价）。`←/→` 与正文段落**顺序不敏感**（解析器各归各的桶），但约定 meta 在前、说明在后，读者先看契约再看展开。
3. **`hop_python` 代码体直挂标题下**：act/commit 的 ` ```hop_python ``` ` 确定性代码块作标题下的 fenced code block（代码是代码，不被自然语言段落吸收）。
4. **`## Task` 契约分区（可选）**：标题风可在 `Id:` 后、`## Steps` 前插一个 `## Task` 分组标题，把 Goal/Constraints/Types/Inputs/Outputs 归入"契约区"，与 `## Steps`"实现区"对称、各自可折叠——审计时一键收起契约块直奔步骤。`## Task` 不是 section 关键字，解析器静默忽略、零解析影响，纯为 Obsidian 折叠分区服务。

`- ←` / `+ →` 数据契约两种风味写法一致——它们从"headline 的附庸"降为**章节的 metainfo**，人先读到契约、再读自然语言描述，机器契约与人读说明各安其位。

> **v1 只读**：解析器**双读**两种风味，序列化器（serializer）仍**只写**内联紧凑风（`>` 在内联风里保留，否则序列化无载体写指令）。标题风是手写/审计时的输入便利；反向"吐标题风"留待后续。

```
# Spec: 示例
Id: demo

## Task

Goal: 一句话目标
Inputs:
- items: [text]  # 待处理清单

## Steps

### 1. [loop for-each item in items, collect result into processed] 逐个处理每个待办项
+ → processed: [text]  # 各项处理结果（collect 列表端）

这批 items 来自上游清洗阶段，可能混入已处理项。本循环对每项独立
执行「起草 → 校验 → 审批 → 落库」，任一项失败不阻断其余项。

#### 1.1. [reason] 为当前项起草处理方案
- ← item           # 当前遍历到的单个待办项
+ → result: text   # 本项处理结果（collect 单项端）

依据 item 类型选择处理模板，输出可供后续校验的结构化草案。
```

---

## 验证规则 ^anc-rule-v3-all

| #   | 检查项                            | 级别  |
| --- | ------------------------------ | --- |
| 1   | 有 Steps 的 Spec 至少一个步骤；无 Steps 的 Spec 必须有 Goal + Outputs | 错误  | ^anc-rule-s10
| 2   | 步骤类型合法（15 种）                   | 错误  | ^anc-rule-s4
| 3   | step_id 全局唯一                    | 错误  | ^anc-rule-s3
| 4   | 叶子类型不能有 children               | 错误  | ^anc-rule-s11
| 5   | parallel 依赖边界：标注步骤的输出在容器内不可被后续步骤消费（值可能未回，只经容器边界导出）；标注步骤不得消费其他标注步骤的输出（对方在飞）；未标注主线步骤的输出照常可用（派发时快照）；parallel 只可标 subtask/call/case（case 就是 branch 下的 subtask——其余节点标 parallel 是文法错误，parser 拒）；**标注步骤必须有任务容器（subtask/case/loop）祖先**——收敛边界=最近任务容器（2026-08-13 作者定）：branch 是唯一透明结构，边界穿过它落上层；顶层裸挂或只有 branch 祖先都算无收敛边界，即错（包一层任务容器即可） | 错误  | ^anc-rule-s12
| 6   | parallel 标注步骤的输出不得声明为累加器（带 `= 初值` 的输出）——派出去的活无共享空间可累加，其输出只走收集列表（见「变量语义」） | 错误  | ^anc-rule-s13
| 6b  | Id 函数签名（可选）与 Inputs/Outputs 按名对应——参数名集合=Inputs、返回名集合=Outputs，多/漏/错名均错（写了签名就必须对应） | 错误  | ^anc-rule-s14
| 7   | goal 非空                        | 错误  | ^anc-rule-s8
| 8   | 容器类型必须有 children               | 错误  | ^anc-rule-s5
| 9   | branch 的 children 必须全部是 case   | 错误  | ^anc-rule-c2
| 10   | case 只能出现在 branch 的 children 中 | 错误  | ^anc-rule-c1
| 11   | 有数据产出的容器必须声明 `+ →` 聚合输出；纯控制流容器可省略（隐含 none） | 错误  | ^anc-rule-s9
| 12   | exit 显式声明 `+ →` 时必须与 `Outputs:` 完全一致（多/漏均错）；bare exit（无 `+ →`）= 隐式交付全部 Outputs，合法 | 错误  | ^anc-rule-p4
| 13   | retry、adaptive 仅适用于 subtask 和 case（case 就是 branch 下的 subtask） | 错误  | ^anc-rule-p9
| 14   | call 引用的 Id 必须存在               | 错误  | ^anc-rule-p1
| 15   | Inputs 声明的变量类型合法              | 错误  | ^anc-rule-v7
| 16   | 步骤输入（`← var`）必须来自前序步骤输出或 `Inputs:` 声明 | 错误  | ^anc-rule-v1
| 17   | 变量名全局唯一：同名同类型 = 同一变量多次赋值（合法）；同名异类型 = 错误。case 填充 branch 统一接口的同名是同一变量（非重名）；for-each 收集经 collect 子句两名分离，无同名问题 | 错误  | ^anc-rule-v2
| 18   | Outputs 声明的变量类型合法 | 错误  | ^anc-rule-v4
| 19   | `subtask retry/adaptive` 内的 `[commit]` 前序（同容器文档序在其前）必须有把关步骤（`confirm` 或 `check`/`check final` 任一）；`call` 要求被调用 spec 不含 `[commit]` 或已有把关保护 | 错误  | ^anc-rule-p8
| 20   | `check` 必须出现在 `subtask` 或 `case` 容器内（case 语义为 branch 下的分支 subtask，check 失败触发所在容器粒度的 retry） | 错误  | ^anc-rule-c6
| 21   | `break`/`continue` 只能在 `loop` 容器内（任意嵌套深度）；带目标步骤号时目标必须存在且是自身的**祖先循环**（非祖先/非 loop/不存在均报错） | 错误  | ^anc-rule-c3
| 22   | `[check final]` 必须在 `subtask` 容器内且位于全部探索性步骤之后——其后只允许 `commit`/`exit`/其他 `check final`（提交性收尾），出现其余步骤类型报错 | 错误  | ^anc-rule-c7
| 23   | 声明的输出变量（Spec `Outputs:` 或容器 `+ →`）应有步骤产出——其作用域内无任何步骤（含子孙）以 `+ →` 产出它时 warn | 警告  | ^anc-rule-p10
| 24   | `check` 步骤必须恰好声明两个输出：一个 `bool`（判定槽）+ 一个 `text`（说明槽），不能多/少/换类型（固定签名） | 错误  | ^anc-rule-p11
| 25   | doc-ref `[[文档路径#章节名]]` 引用的文件必须存在、章节必须可在该文件标题中匹配（静态存在性校验，见 [[#^anc-exec-doc-ref]]） | 错误  | ^anc-rule-p15
| 26   | **hop_env_ 保留命名空间**（2026-08-14）：步骤 `+ →` 产出名/act body 赋值目标带 `hop_env_` 前缀一律错误——环境参数只读,来源恒为覆盖链;ask 输出到 hop_env_* 放行（覆盖链合法末级） | 错误  | ^anc-rule-hop-env-readonly
| 27   | **内置类型名全局保留**（2026-08-14 作者拍板）：`text/bool/line/number/int/float/markdown/yaml/prompt/HopSpec` 不得作变量名（Inputs/产出/映射目标/for-each·collect 子句绑定）,自定义类型亦不得与内置同名——类型词与变量位同槽竞争的语法位（call 映射等）会静默错读,类型词做变量名无真实需求（同 else 先例） | 错误  | ^anc-rule-type-reserved
| 26b   | **叶子输入声明完备性**（2026-08-13 作者定）：叶子节点用到的输入变量必须在节点 `- ←` 声明——prompt 组装只喂声明的变量，引用未声明=LLM 拿缺料上下文静默出垃圾。机检三档如实分层：act/commit body 引用精确判（B3 族 error）；ask present_inputs 精确判（规则 13，error）；**instruction 散文引用不可精确判定**（文本命中≠消费）——已定义变量名出现在 instruction 而未声明时提示"是消费就补声明，是散文提及可忽略"，散文消费的终审归语义审计 | 警告  | ^anc-rule-v11

> 规则 23 是**静态可达性**检查（执行前）：只在作用域内**完全无产出者**时报 warn，任一分支产出即不报（避免误杀 branch 场景）。它与 `Outputs:` 段的**运行时** warning（执行结束仍为 None）互补——静态版提前提醒"可能漏写产出步骤"，运行时版报告"实际未赋值"。**声明而不产出可能是合法的 impl 情况**（能力声明 Spec、产出留给被 call 的子 spec、exit_outputs 运行时给、有序思考动态生成），故判 warn 不阻断。

---

## 完整示例

```
# Spec: 数据质量评估与修复
Goal: 评估输入数据集的质量问题，自动修复并生成质量报告

Inputs:
- raw_data: [DataRecord]  # 原始数据集
- quality_threshold: float  # 质量达标阈值

Outputs:
- clean_data: [DataRecord]  # 修复后数据
- quality_report: markdown  # 质量报告

Constraints:
- 修复后数据行数保留率 ≥ 90%
- 不可篡改原始业务字段含义

Types:
- DataRecord:  # 数据记录
  - id: line  # 记录标识
  - fields: yaml  # 业务字段
  - source: line  # 数据来源

## Steps
1. [act] 统计数据质量指标（缺失率、异常分布、跨字段一致性）
  - ← raw_data
  + → profile:  # 数据质量画像
    - missing_rates: [float]  # 各列缺失率
    - anomaly_count: int  # 异常记录数
    - issues: [line]  # 质量问题列表
2. [reason] 解读质量画像，制定修复策略
  - ← profile
  + → fix_strategy: text  # 修复策略
  > 权衡数据保留率与质量，选择合适的缺失值处理和异常值处理方案
3. [subtask retry=3 adaptive] 执行修复并验证质量达标
  + → clean_data
  3.1. [act] 按策略修复数据
    - ← raw_data, fix_strategy
    + → clean_data
  3.2. [check final] 验证修复后质量 ≥ threshold 且行数保留率 ≥ 90%
    - ← clean_data, quality_threshold
    + → quality_ok: bool  # 判定槽：是否达标
    + → quality_note: text # 说明槽：未达标时缺口（通过时不被查看）
4. [act] 生成质量报告（含修复前后对比）
  - ← profile, clean_data, raw_data
  + → quality_report
5. [exit] 交付修复数据和质量报告
  + → clean_data, quality_report
```

```
# Spec: 舆情监控与预警响应
Goal: 监控多渠道舆情，评估风险等级，生成预警报告和应对方案

Inputs:
- channels: [line]  # 监控渠道列表
- keywords: [line]  # 监控关键词

Outputs:
- alert_report: markdown  # 预警报告
- actions: [line]  # 应对行动项

Constraints:
- 最多 5 轮监控
- 风险降至低级即终止

## Steps
1. [act] 初始化监控配置和数据采集接口
  - ← channels, keywords
  + → config: yaml  # 采集配置
2. [loop max=5] 每轮监控直到风险降至低级或满 5 轮
  + → risk_level: line  # 最终风险等级
  + → trend: [line] = []  # 各轮风险变化（累加器：容器进入 init 一次）
  + → analysis: text  # 最新舆情分析
  2.1. [subtask] 并行采集各渠道数据   # 容器边界=收齐点，2.2 消费前必已收好
    + → social_data: text  # 社交媒体数据
    + → news_data: text  # 新闻媒体数据
    2.1.1. [subtask parallel] 采集社交媒体舆情   # 派出去跑
      + → social_data
      2.1.1.1. [act] 调用社交渠道接口
        - ← config
        + → social_data
    2.1.2. [subtask parallel] 采集新闻媒体报道   # 与 2.1.1 并发在跑
      + → news_data
      2.1.2.1. [act] 调用新闻渠道接口
        - ← config
        + → news_data
  2.2. [reason] 综合分析舆情态势，评估风险等级
    - ← social_data, news_data
    + → analysis
    + → risk_level
    > 关注负面情绪占比、传播速度、意见领袖参与度
  2.3. [act] 记录本轮风险趋势
    - ← risk_level, trend
    + → trend  # 追加本轮风险等级（更新模式）
  2.4. [branch] 风险等级判断
    + → none
    2.4.1. [case(risk_level == 高)] 高风险
      2.4.1.1. [continue]
    2.4.2. [case(else)] 低风险
      2.4.2.1. [break]
3. [subtask retry=2] 生成预警报告并验证
  + → alert_report, actions
  3.1. [reason] 基于监控结果制定应对方案
    - ← analysis, risk_level, trend
    + → actions
  3.2. [act] 生成预警报告
    - ← analysis, trend, risk_level, actions
    + → alert_report
  3.3. [check final] 验证报告覆盖所有识别的风险点
    - ← alert_report, analysis
    + → report_ok: bool   # 判定槽：是否完整覆盖
    + → report_gap: text  # 说明槽：遗漏的风险点（通过时不被查看）
4. [exit] 交付预警报告和应对方案
  + → alert_report, actions
```

---

## 修订记录

> 正文只写现行语义；演进史与废除决策集中于此，防史注淹没正文（2026-08-09 作者定）。

- **2026-08-28 内置文件工具写侧分域（作者定）**：原"写侧一律限 workspace"改为按步骤权限分域——act/check 写域收窄 work_zone（探索段产物皆中间产物），commit 保持 workspace 全域（持久写盘=交付动作）。触发：fact-check 真机跑 act free 步临场把中间 yaml 写到 workspace 根——权限上合法但污染工作区、且 free 步能 read/listdir 工作区一切,散落物会被后续步与并行兄弟读到（自污染,与 dr16 观测污染同族）。free 与否无关——free 只影响行为可预期性，不放大权限。
- **2026-08-25 工具一等公民三件（作者三连裁定，收窄 2026-08-06/08-12"不进 spec 本体"）**：①工具声明两面（^anc-tool-two-faces）——环境注册面=实现权威（逐参数条目式声明+notes 扩展块，说明写到杜绝望词生义），spec Tools 段=需求声明（import 声明非签名复制：spec 自包含/init 对账早失败/prompt 逐参数语义三收益；原裁决防的漂移由 init 对账转显式错误）；②规约结构新增 Tools 段（HopSchema 条目+`>` 扩展）；③call 扩义统一 spec 与工具（同为"带签名的外部能力单元"，callee 名运行期决议先 Spec 后 Tool；工具 call=单次调用退化形态，requires_commit 同受语境拦截）。触发：NL 构建测试实撞 tools_available 无产物落点、对齐收集的工具面在产物里蒸发。原裁决三论据中"安全属性钉工具定义"与"实现签名单一事实源"仍成立。

- **2026-08-12 工具签名契约 + time 实例上下文内置（作者定，工具接口标准第一层随批落地）**：工具签名（输入 schema/输出形状/requires_commit）定性为工具内在属性、归环境配置级注册——spec 只写工具名，签名单一事实源防 N 份副本漂移（2026-08-06 方向裁决的落地）；输出形状校验的异常语义定为"预期与现实的偏差"——入既有升级阶梯带偏差明细供 adaptive 适配并记录，非终局硬失败。`now()`/`today()` 纳入 hop_python 实例上下文内置档（work_zone_path 先例）——非纯函数但非 IO，重放走 journal 记值保确定性；曾议"time 归工具"否决（复用模式为一个时间戳付一次跨进程往返不成比例）。同批裁决：effect 三级枚举（pure/read/write）不引入——read/write 与"不可逆"不同轴（沙箱内写可逆、只读也可有配额消耗），requires_commit 语义独立保留；pure 工具是自相矛盾的分类（纯计算归 builtin）。

- **2026-08-11 等值严格化 + is None（作者定，续"心智用 python 一致"）**：等值 `==`/`!=` 从宽松语义（数字与数字串相等）改为 **Python 严格语义**——跨类型不相等不异常（`"3" == 3` 假）、列表/对象深比较补齐；`in` 元素查找同步严格。None 与未赋值互等保留（两者同为"无值"，是值模型事实非宽松特例）。**`is`/`is not` 实装但仅限 None 判定**（`x is None`——LLM 肌肉记忆惯用形，解析层归一为 `== None`；其他右操作数报错指路 `==`，hop_python 值模型无对象身份概念，不开通用 is）。宽松等值原为输出边界数字串（schema 校验放行不转换）打的补丁——同批改为**边界归一**：声明 int/float/number 的输出收数字串当场转数字入变量空间、bool 收 "true"/"false" 转布尔（声明类型是权威），语言内部零特例。
- **2026-08-11 序比较 Python 对齐（作者定"心智用 python 一致最简单，否则解释成本过高"）**：`< > <= >=` 从"数值语义+可转数字即强转"改为**同类型才可比**——数字/bool 互比按数、字符串×字符串字典序、列表×列表逐元素字典序，其余组合（含数字×数字串 `"3" < 5`、None/对象参比）一律计算异常。堵掉强转兜底的两个事故行为：None 被静默当 0（`None < 5` 曾为真）、列表经 Number() 强转出垃圾语义。等值 `==` 的宽松语义不动（`"3" == 3` 仍真——LLM 产出鲁棒性特例，只在等值层）。

- **2026-08-10 parallel 统一模型（语义翻转+执行模型统一，作者五项拍板）**：parallel 从 caller 调度指令翻转为 **callee 并发性质申报**（自包含/无共享写/可安全多实例，与 requires_commit 同构的被调方自我申报），执行语义全局统一为**步骤级异步派发**——主线执行到标注步骤即派出去跑不等完成，容器完成条件扩展为"主线走完 ∧ 派出的活全部收好"（收齐/gather，零新文法零凭据暴露——结构化并发无游离 Future）。原"静态并行组"（subtask parallel+children 同启同 join）与 `loop for-each ... parallel` 静态批 fan-out 两形态**归约为统一模型特例并废除旧语义**：循环头 parallel 属性废止（并发是体内步骤的性质，体内标注即渐进流水线），parallel 宿主从 subtask/loop 改为 **subtask/call**（call 标注形态新增）。配套裁决：并发名额走系统配置缺省 5 且**主线自算一路**（配 1=全串行调试口子）；**主线步骤 fail → 在跑的活全部杀死不留幻影**（killed 终态，"失败=停"心智模型优先；作者面仍无 cancel 语法，break 正常路径照常收齐不杀）；未标注=主线同步执行（缺省即串行，无独立默认规则）。S12 改写为"申报属实+容器内无 Future 消费"，S13 改写为"标注步骤输出禁累加器"。设计推演与决策记录见 docs/design/rounds/call-parallel-草案。

- **2026-08-09 Id 函数签名**：Id 行新增可选函数形式 `Id: func(in1, in2) -> out1, out2`——一眼读懂调用面。签名只列名字（类型归 Inputs/Outputs 展开块，签名是索引非替代）；id 仍=func 名（call 寻址不变）；写了签名必须与 Inputs/Outputs 按名完全对应（规则 6b/S14，多/漏/错名均错）。
- **2026-08-09 错误模型定稿（fail 即异常）**：同日"计算异常=None+log"中间态被推翻重定——**计算异常也是 fail**（程序错了就是这一步失败，body 算错→本步 fail、条件算错→branch fail；"折 None 继续跑"是教义外的第三通道，废）；**None 闸删除**（"消费 None 自动 fail"废——None 是普通值，失败传播由真实依赖驱动非引擎连坐；`= Null` 重置与 None 闸的自相矛盾消解，"消费"概念、MISSING_INPUT 歧义一并消失）；subtask 总内置 retry（缺省 3，实现原 ??1 与概念不符修正）；**retry 耗尽 = 标准 fail 继续升级**（容器作为一个步骤找外层事务边界扣预算重跑，嵌套内层计数随外层重跑复位——原实现只级联记账，外层 retry 形同虚设）；裸失败=定格记账执行不停（部分失败容忍）；call 失败跨界结构化（fail_kind 继承、机器通道对称）。哲学定调：取异常语义（授权与上报）弃异常语法（无 try/catch，失败处理挂在结构上）。同日两连追加裁决：**fail 不碰值空间**——fail 时输出不置 None（只擦失败节点、前序残留照旧是半吊子清理，比不保证更糟；更新模式豁免随规则一并消失；残留处置归 spec 作者，与 retry 不回滚、rollback 归作者同哲学，引擎只记账与调度），None 来源随之收为两种（`= Null` / 声明未产出）；**parallel 失败槽不填 None**——收集列表本就乱序、None 无归属，失败 child 不贡献元素、部分失败=列表变短；**函数级 fail**（作者三改定稿）——"裸失败=定格记账执行不停"废：未捕获失败即**实例终止**（与未捕获异常终止函数同构，失败被边界接住修复或穿透到顶终止实例，无"失败后继续跑"第三态；失败中断执行是缺省，容忍失败才需作者动结构；parallel 部分失败是唯一显式例外——集合语义、作者选用即选择）。承载体正名 **FailRecord**（失败步骤/reason/fail_kind/轮次四字段，逐轮累积随实例留存，跨 call 加壳内核原封）。
- **2026-08-09 认知复杂度通查三改**（语言设计第一原则的首次全面应用，作者定 A1/A2/A3）：①统配 `[case(...)]`→`[case(else)]`（`...` 是符号谜语，else 是日常英语；else 成条件位保留字）；②`check finally`→`check final`（finally 是 try/finally 程序员词汇，final=最终的是日常词）；③`max_iterations=N`→`max=N`（长蛇下划线词普通人拼不出）。统配旧写法（`...`/default/空/裸 case）**直接废止不留过渡**（作者定）；finally/max_iterations 过渡期兼容读、将废止。序列化一律写标准写法。文档示例 Null 三写统一用 `Null`（宽容解析不变）。
- **2026-08-09 语言设计第一原则立项 + Inputs 缺省值当日回滚**（作者定）：定位节立"普通人易于理解，不必要不增加复杂度"为语言设计第一原则——每个语法构造都要过"让普通人更容易表达/读懂吗"这道门，程序员便利特性不进语言。同日按此原则回滚当天上午实装的 Inputs 缺省值（`= 默认值`）：它是程序员的缺省参数习惯，普通人场景下 caller/driver 问一次参数更直白（discovery 流程已覆盖），属不必要复杂度。设计层 VarDecl.default 悬空字段一并删除（该字段自始无概念依据）。
- **2026-08-09 call 结构化逻辑标准写法统一**：`[call <Id>(输入映射)] 描述`——机读全进方括号，与 `[case(条件)]`/`[loop for-each …]` 同构"方括号=机器面"、也与 Id 行函数签名 `func(in...)` 的调用面表达同构（primer 盲测实撞：agent 把 case/loop/subtask 已立的"方括号=机器面"规则合理泛化到 call 被 P1 拒，根因是语言自身标准写法不一致，call 的 id 还在括号外）。输入映射入括号（`param: source` 逗号分隔、同名裸名简写、无输入 `[call id]`），输出仍 `+ →` 行收取；旧形态兼容读、序列化写标准写法（同 case 迁移策略）。
- **2026-08-09 case 结构化逻辑标准写法改版**：`[case(条件)] 人读描述`——机读全入 `[]`（与 loop/subtask 属性同构，方括号=机器面）；裸 `[case]`=default。旧 `[case] 描述 (条件)` 兼容读、序列化写新形态，存量零迁移。配套：旧形态"无括号整行即条件"收窄为"像表达式才当条件"（含运算符/花括号/裸 snake_case 变量名），`[case] 中文描述` 不再被误当条件；表达式 tokenizer 标识符收 Unicode 字母（中文 enum 成员 `risk == 高` 可写）。
- **2026-08-09 条件能力面补齐**（描述完备性审查撞出）：`None` 字面量补入（`null` 同义；None 与未赋值等值同判）——概念自己推荐的"检测 None 走降级"模式此前在条件里无结构化逻辑标准写法可写；`items[0]` 方括号下标进正式文法（Python 结构化逻辑标准写法，此前仅预处理兼容、act body 写不了；`.0` dotted 降为兼容）；等值/序比较语义分开明示（等值宽松、序比较数值且不可转不报错）。
- **2026-08-09 case 条件升表达式**：条件从"仅 ==/!=/裸真值（字符串比较）"升格为 hop_python 纯表达式子集（与 act body 同一文法）——比较数值语义、and/or/not 短路、算术、括号、字段/下标；仅禁工具调用（零副作用）与赋值（只读）。**enum 成员裸写是结构化逻辑标准写法**（`risk == high` 不加引号，校验器核对成员在场）；变量名禁与枚举成员重名；自由文本建议加引号，比较位置裸字无同名变量时兼容为字面量。变量命名约定同批补 snake_case。动因：8k primer 盲测 K 题实撞——`(count > 10)` 被误报"未定义变量"（旧实现只认等值且报错指错方向）。
- **2026-08-09 bare exit 语义落定**：exit 不写任何 `+ →` = 合法简写，隐式交付 header 全部 Outputs（Outputs 段是交付契约权威，exit 重抄冗余；简写引用精神的极限形态）；半写（声明但多/漏）仍报错。此前"完全无声明不查"是实现的未定义边界，本次升格为定义行为。
- **2026-08-09 collect 子句**：for-each 收集从"children 同名输出自动收集"（隐式，头 `[T]`/child `T` 同名异型——同名=同一变量原则的唯一裂缝）改为显式 `collect <单项> into <列表>` 子句——两名分离、各自单一类型，V2 接口填充豁免随之删除（case 填 branch 是真同一变量，保留）。旧同名填充写法废除。
- **2026-08-09 扁平命名空间**：变量语义改 Python 函数级作用域（一次执行=一个扁平命名空间，容器是控制流块；同名=同一变量）。此前引擎按容器建块级作用域、写落最近容器，制造"隐式影子变量"，三份实跑报告同源撞上后裁决重构。V3（遮蔽）废除，V2 重定义（同型=再赋值合法/异型=错误），S13 新增（parallel 容器头禁累加器）。
- **2026-08-08 for-each 消费边终定**：`- ← <list_var>` 写不写都合法（"写了也行，不写也没错"）。演进：08-07 立规缺行报错 → 同日翻转为显式行提示冗余 → 08-08 终定双写法等价零提示。
- **2026-08-07 parallel 降属性**：原 `[parallel]` 步骤类型废除，降为 subtask/loop 的正交属性；`+ → item : for-each list` 伪输出行文法同批废除（元素绑定伪装成输出声明违反命名忠实），改为步骤头 for-each 子句。步骤类型 15→14。
- **2026-07-04 变量自然保留统一**：废除早期"延续变量/当轮变量"二分（loop 节点输出跨迭代保留、子步骤输出每轮引擎 deleteVar 清空）。废因：①要求作者懂引擎隐式清空规则；②"残留=bug"前提不成立（Python 中残留是 feature）；③loop 与 subtask retry 语义不对称。统一为自然保留 + `= 初值` 显式管理。
- **早期 confirm 拆分**：confirm 原混用审批+数据收集，数据型 confirm 被诱导答成 approve、审批信号污染业务值——拆出 `ask` 步骤，confirm 收窄纯审批。
