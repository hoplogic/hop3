# Spec: hopbuild2 — 递归等价分拆构建器（主流程）
Id: hopbuild2

## Task

Goal: 把一个自然语言 skill 翻译为 HopSpec 规约：对齐头部契约 → 根节点交给 split-node 递归等价分拆 → 整文四关核验 → 作者终审 → 写盘交付（产物带档位:hop=全结构化,双模式皆稳;mixed=含未尽原子——standalone 由引擎带工具面的 LLM 循环执行,所需引擎外能力须经 Tools 段声明,声明齐即可跑;复用模式 caller 能力面开放天然宽容）
> 壳形态沿用 v1 实战验证的介入点编排（对齐门/构建循环/终审意见闸）,心脏换 split-node 判定序递归。设计权威 docs/design/hopbuild2.md ^anc-build-main-flow。

Constraints:
- 循环内不问人：能从已对齐契约与原文推演的直接定,实质性新增决策点记研判点台账随终审呈裁
- 终态两档都合法：mixed（含未尽原子）不是打回理由——档位+台账呈作者知情裁定
- 全局知识（spec 级 doc-ref,对所有步骤注入）：[[split-patterns#HOP 全局认知（目标语言与产物是什么）]]

Inputs:
- input_skill_path: line  # 待翻译的自然语言 skill 文件路径,或 hopbuild2 产的 mixed 档 spec.md 路径(二轮展开——同目录须有成套 source.md,分型机械判见 1.3)
- max_depth: int  # 产物 spec 嵌套深度上限（缺省 3——步骤号最多三段如 3.2.1;语料确实巨大时显式传更大值放宽。值为空/0 时步骤 3 归一到 3）
- target_profile: line  # 目标执行档——产物给哪个模型档跑（空=通用形态零变化;非空=已支持档名,当前仅 qwen3.8-27b。非空时成文步按「目标执行档规则」节出产物:把关步封闭化/步骤尺寸压坍塌点下。值为空时步骤 3 归一为空串）

Outputs:
- generated_spec_path: line  # 交付的 spec.md 写盘路径
- tier: line  # 产物档位（hop / mixed）

## Steps

### 1. [subtask retry=2] 确认待翻译的自然语言 skill（路径形态进闸）
- ← input_skill_path
+ → skill_path: line  # 确认后的自然语言 skill 文件路径（workspace 相对形态,已过机械体检）

#### 1.1. [ask] 收路径
- ← input_skill_path
+ → skill_path: line  # 用户确认的路径

若 input_skill_path 已指向存在的自然语言 skill,采用它作默认值（无歧义直接采用不必强问）;否则请用户给出路径。default_value = input_skill_path。**请给 workspace 相对路径**——绝对路径（/ 开头）与含 .. 的路径沙箱会拒:后续读原文（步骤 2）与交付写盘（步骤 7 以 skill_path 派生交付路径）两处都过不去。重问轮按体检说明改形态再给。

#### 1.2. [check] 路径形态机械体检（含目标执行档词表核）
- ← skill_path, target_profile
+ → path_ok: bool  # 判定
+ → path_note: text  # 说明（拒因——重问轮呈给用户照改）

机械四判零 LLM：绝对路径拒、含 .. 拒、文件不在场拒（拼错路径当场抓,不带毒进构建）、目标执行档名不在支持词表内拒（未知档名响亮拒,不静默按通用形态构建——拼错档名的人以为拿到了适配产物,实际拿到的是通用产物,静默回落比报错贵）。exists 返回 JSON 文本,parse_json 取 .exists（4.1 同款）;形态坏时不碰 exists（绝对路径进读侧工具会被沙箱拒成工具失败,先判形态再探在场）：
> ```hop_python
> bad_abs = startswith(skill_path, "/")
> bad_dots = ".." in skill_path
> on_disk = parse_json(exists(path: skill_path)).exists if (not bad_abs) and (not bad_dots) else false
> known_profiles = ["", "qwen3.8-27b"]
> bad_profile = (target_profile if target_profile else "") not in known_profiles
> path_ok = on_disk and (not bad_profile)
> path_note = "" if path_ok else ("绝对路径沙箱会拒,请改成 workspace 相对路径（去掉开头的 /,从工作目录起算）: " + skill_path if bad_abs else "") + ("路径含 .. 越界形态沙箱会拒,请给工作目录内的直连相对路径: " + skill_path if bad_dots else "") + ("文件不存在（按 workspace 相对解析）: " + skill_path if (not bad_abs) and (not bad_dots) and (not on_disk) else "") + ("目标执行档不支持: " + target_profile + "（当前支持: qwen3.8-27b;留空=通用形态）" if bad_profile else "")
> ```

#### 1.3. [act] 输入分型（mixed 产物二轮展开进同一入口,分流在 hopspec 层做）
- ← skill_path
+ → is_expand: bool  # 输入是 mixed 产物(二轮展开)还是 NL 原文(首轮)

纯机械判零 LLM(文件头两特征都中才 true:`# Spec:` 开头且含行级档位标 `档位: mixed`——原子串判 `"mixed" in head` 会把 hop 档产物误判进二轮,因为档位行图例文字恒含"mixed"四字母〔`hop=双模式可跑;mixed=含未尽原子`〕;行级特征只有 mixed 档产物才有。误判兜底=expand 步骤 1 成套核 source.md 缺席即拒):
> ```hop_python
> # @a: anc-build-expand —— 输入分型:mixed 产物与 NL 原文同一入口,机械判分流(D91,作者拍"hopspec 层做分支不留散文层";档位判 D93 行级化)
> head = read(path: skill_path, start_line: 1, end_line: 6)
> is_expand = startswith(head, "# Spec:") and ("档位: mixed" in head)
> ```

#### 1.4. [branch] 构建路由:mixed 产物走二轮展开,NL 原文走首轮全链

##### 1.4.1. [case(is_expand)] 二轮展开——call expand 后直接交付
###### 1.4.1.1. [call hopbuild2-expand(mixed_spec_path: skill_path, max_depth, target_profile)] 展开未尽原子
+ → generated_spec_path: generated_spec_path  # expand 交付路径
+ → tier: tier  # 展开后档位

（expand=同目录 hopbuild2-expand.md:成套核→抽原子对位→范围确认→逐原子 call split-node→拼装+骨架保真核→终审→交付。设计 ^anc-build-expand。）

###### 1.4.1.2. [exit] 二轮展开交付完成
- ← generated_spec_path, tier

二轮路径在此终结——expand 内部已含终审与交付 commit,不进首轮全链。

##### 1.4.2. [case(else)] 首轮——NL 原文照旧走全链
###### 1.4.2.1. [act] 首轮放行记录
+ → first_round: bool  # 恒 true(首轮路径标记)

纯机械零 LLM:
> ```hop_python
> # @a: anc-build-expand
> first_round = true
> ```

### 2. [subtask retry=2] 读取原文、附属文件盘点与构建基准落盘（多文件保真）
- ← skill_path
+ → skill_content: text  # 构建基准编号版全文——本体+流程性与混合附属同序拼接后每行行首加 `L<行号>: `（L1..Ln,全局行号,构建全程唯一原文基准;分拆链的范围标记按行首号引用,切片与覆盖对账都按它机械做;基准是冻结输入,行号全程稳定）
+ → aux_ledger: yaml  # 附属文件台账（每件三键:path/定性/处置——定性四值:流程性/参考性/混合/未引用;单文件 skill 恒空列表）
+ → ref_assets: [line]  # 参考性附属路径清单（交付随包登记——产物落原 skill 目录时附属天然在场,pack 分发按它逐件带走）

#### 2.1. [act] 读原文本体
- ← skill_path
+ → raw_body: text  # 原文本体全文（未编号——构建基准的拼接原料）

纯机械读取,body 引擎直执零 LLM：
> ```hop_python
> raw_body = read(path: skill_path)
> ```

#### 2.2. [act free] 扫包内引用并逐件二分（分拆视野扩到附属文件——只翻本体不读引用,产物把关面就只有本体摘要的粒度）
- ← skill_path, raw_body
+ → aux_ledger: yaml  # 附属文件台账——每件三键:path=包内相对路径（照原文引用的形态写,如 references/x.md——相对 skill 目录;2.4 拼接时机械补 skill 目录前缀再读,你不用换算）/定性=流程性|参考性|混合|未引用/处置=一句话理由

扫 raw_body 正文里引用的包内文件（references/、scripts/、数据 YAML 这类相对路径——markdown 链接、反引号、散文提及都算）,逐件读内容定性。**读附属文件时把 skill 所在目录拼在包内路径前面**（skill_path 去掉文件名就是 skill 目录——原文引用 references/x.md,实际读 <skill目录>/references/x.md;台账 path 键仍写包内相对形态）。二分判据（权威=hopbuild v1 设计的多文件自包含契约,此处按判据用）：**错过会导致纪律失守（门禁跳过/闸门蒸发/顺序乱）的内容是流程性,只影响执行细节对错的是参考性**;定性对象是内容不是文件——混合文件（主体是参考性字段表、尾部却有一节退出门禁）按其中最严内容定"混合",整件并入构建基准;本体未引用但同目录存在的附属定"未引用"（不进翻译不进包,台账呈终审人裁——它可能是给别的消费者的,翻译者无权替裁）。**未引用附属靠盘点发现不靠扫引用**：对 skill 目录（含子目录）listdir 一遍,存在但不在引用清单里的逐件入账定"未引用"——只扫 raw_body 引用永远看不见没被提到的文件。可执行脚本（scripts/ 下 .py/.sh/.js）恒参考性——产物步骤按路径调用它,不把代码翻进 spec。大文件不必通读：读开头知性质,再搜索门禁语汇（必须/不得/才能/方可/门禁/gate）确认有无纪律句,即可定性。方法论类语料（本体没有现成执行流程,"错过会不会导致纪律失守"无从判）先依 frontmatter 的使用说明立出任务面并记研判点台账,二分才有基准。单文件 skill（零包内引用）交空列表,零仪式。拿不准的定性记研判点台账呈终审。引擎已自动注入（doc-ref）：
[[split-patterns#附属文件二分（多文件保真必读）]]


**alignment-notes.md 恒流程性**：skill 目录下若有 alignment-notes.md（上轮构建作者在对齐门拍定的修订口径,一条一款带日期原话）,恒判流程性并入构建基准——它是人拍过的板,错过即本轮复犯（实撞:同语料两轮,五件拍定口径三件复犯）。**其中指向附属文件定性的历史口径,本轮定性直接按口径执行**（如上轮作者拍"references/x.md 是流程性",本件不再自判,定性照口径落,处置键注明"依对齐口径 <日期>"——定性意见的生效通道就是这里,上轮对齐门只记录不改当轮台账,你不落实它就永远没人落实）。

#### 2.3. [check] 台账形态机械核
- ← aux_ledger
+ → ledger_ok: bool  # 判定槽
+ → ledger_note: text  # 说明槽（坏条目清单回填,重跑轮定向修正）

纯机械判定,body 引擎直执零 LLM（每件必须有 path/定性 两键且定性在四值法内——形态坏的台账进 2.4 拼接会静默漏并,门禁原话进不了构建视野）：
> ```hop_python
> legal_kinds = ["流程性", "参考性", "混合", "未引用"]
> bad = [e for e in aux_ledger if not (get(e, "path") and get(e, "定性") and get(e, "处置") and str(e.定性) in legal_kinds)]
> ledger_ok = len(bad) == 0
> ledger_note = "" if ledger_ok else "台账条目形态错(每件须 path/定性/处置 三键,定性只许 流程性/参考性/混合/未引用): " + str(bad)
> ```

#### 2.4. [act] 构建基准拼接、编号与落盘（行号基准的多文件形态）
- ← skill_path, raw_body, aux_ledger
+ → skill_content: text  # 构建基准编号版全文（L1..Ln 全局行号）
+ → ref_assets: [line]  # 参考性附属路径清单

纯机械拼接、编号与落盘,body 引擎直执零 LLM。**source.md=构建基准纯副本（不带行号）**：本体在前,流程性与混合附属按台账顺序拼接在后,每件之间加分隔行标注来源路径——终审对读与修错步按行号取段的物理基准,交付时随 spec 同目录分发;**行号全局续排**：切片/覆盖对账/修错工单全按这一套全局行号工作,source.md 第 N 行=编号版 L N,一一对应零偏移：
> ```hop_python
> parts = split(skill_path, "/")
> n = len(parts) - 1
> skill_dir = join([parts[i] for i in range(n)], "/")
> dir_prefix = skill_dir + "/" if skill_dir else ""
> raw_flow = [str(e.path) for e in aux_ledger if str(e.定性) == "流程性" or str(e.定性) == "混合"]
> flow_files = [p if startswith(p, dir_prefix) else dir_prefix + p for p in raw_flow]
> flow_kinds = [str(e.定性) for e in aux_ledger if str(e.定性) == "流程性" or str(e.定性) == "混合"]
> flow_blocks = ["\n\n<<<<< 附属文件(" + flow_kinds[i] + ",并入构建基准): " + flow_files[i] + " >>>>>\n\n" + read(path: flow_files[i]) for i in range(len(flow_files))]
> raw_content = raw_body + join(flow_blocks, "")
> write(path: work_zone_path("source.md"), content: raw_content)
> src_lines = split(raw_content, "\n")
> numbered = ["L" + str(i + 1) + ": " + src_lines[i] for i in range(len(src_lines))]
> skill_content = join(numbered, "\n")
> raw_ref = [str(e.path) for e in aux_ledger if str(e.定性) == "参考性"]
> ref_assets = [p if startswith(p, dir_prefix) else dir_prefix + p for p in raw_ref]
> ```

### 3. [act] 初始化递归入参
- ← max_depth, target_profile
+ → root_task: text = "把整个 NL skill 的执行流程翻译为 HopSpec Steps"  # 根节点任务描述
+ → empty_context: text = ""  # 根节点父上下文（根节点无父层骨架）
+ → no_vars: [line]  # 根节点父层变量清单（空——根节点无父层产出）
+ → max_depth: int  # 归一后的产物嵌套深度上限（调用方传空/0 时落缺省 3;根 call 传给分拆器,递归逐层透传）
+ → target_profile: line  # 归一后的目标执行档（空值归空串;根 call 传给分拆器,递归逐层透传——分拆器成文步按它选把关形态与步骤尺寸）
+ → judgement_log: line  # 研判点台账的文件路径（值是路径不是内容;台账内容由分拆各层 append 写入该文件,全树共写一份。路径落引擎涂鸦区——work_zone 是绝对路径禁令唯一豁免,跨 call 实例可共享）

纯初始化零推理（max_depth 归一:非正/空值一律落缺省 3——引擎无 Inputs 缺省值语义,缺省在此机械补;target_profile 空值归空串）：
> ```hop_python
> root_task = "把整个 NL skill 的执行流程翻译为 HopSpec Steps"
> empty_context = ""
> no_vars = []
> md_parsed = int(max_depth) if max_depth else 3
> max_depth = md_parsed if md_parsed else 3
> target_profile = target_profile if target_profile else ""
> tier = ""
> judgement_log = work_zone_path("judgement-log.md")
> ```

### 4. [subtask retry=3] 头部契约核查（对齐门）
- ← skill_content, aux_ledger
+ → header_final: yaml  # 对齐后的头部契约（本子任务完成 = 契约已经用户确认）

#### 4.1. [act] 读上一版 header 快照（重跑轮的修订基准）
+ → prev_header: text  # 上一轮呈审过的 header 原文（首轮快照不存在时为空串）

纯机械读取零 LLM。快照由 4.3 机械核每轮落盘,work_zone 跨重试轮存活（subtask 回滚只回滚变量,不清涂鸦区）——重跑轮靠它把"上一版"带回给 4.2 做定向修订。注意 exists 返回的是 JSON 文本,必须 parse_json 取 .exists 字段才能当条件（裸用=非空字符串恒真,首轮文件不存在时 read 必炸 ENOENT——dr11 实撞秒死）：
> ```hop_python
> probe = parse_json(exists(path: work_zone_path("header-last.yaml")))
> prev_header = read(path: work_zone_path("header-last.yaml")) if probe.exists else ""
> ```

#### 4.2. [reason] 生成/修订头部契约
- ← skill_content, prev_header
+ → header_final: yaml  # 头部契约（形态与判据见下方执行说明）

**prev_header 非空时是修订不是重写**：prev_header 就是上一轮呈审过的 header 原文,是本轮的基准——按重试反馈**定向修订**：意见提到的地方改,未提到的原样保留,变量名、类型、条目一律不得无故变动（没有基准在手的"修订"是凭空重生成,会把用户没提过的输入删掉、把变量改名——用户已看过的内容不许悄悄变）。prev_header 为空（首轮）才从原文生成。

**头部契约**是产物 spec 的对外接口,也是后续整个分拆过程的共同基准——分拆器逐节点引用它选变量名、对类型,写错一处全树跟着错。它是平面七键的 yaml 对象,完整形态照抄（内容按原文填）：

```yaml
title: 收件箱分诊
spec_id: inbox-triage
goal: 对收件箱每封未读邮件判断是否紧急,汇总紧急清单发送值班群
inputs:
  - name: unread_emails
    type: "[yaml]"
    说明: 全部未读邮件,每项含发件人、主题、正文
outputs:
  - name: digest
    type: markdown
    说明: 发送给值班群的紧急邮件清单
constraints:
  - 发送动作不可撤销
tools_available:
  - name: group_messaging
    source: 原文提到的值班群发送
    status: 待确认
    params:
      - channel: line   # 目标群标识——从原文"值班群"推演,取值来源待确认
      - content: text   # 发送的清单正文
    output: "message_id: line"   # 发送凭据（平台返回）
    rendered: |
      - group_messaging(channel, content) -> message_id: line  # 值班群发送（原文,待确认）
        - channel: line  # 目标群标识——从原文"值班群"推演,取值来源待确认
        - content: text  # 发送的清单正文
```

（样例注：原文的"读收件箱"落 hop_python 内置 read,不进工具面——tools_available 只剩真外部服务 group_messaging 一项。）

**title 与 spec_id**：产物 spec 的标题（中文可）与 Id（英文 kebab-case）——从 skill 名/原文标题取,这是唯一的取名点,后面文件头由代码直接拼接不再过 LLM。

**inputs 与 outputs 的每一项是 name/type/说明 三键对象**（如上例）。不要把名字直接当键（❌ `- unread_emails: [yaml]`）——下游机械核按 name/type 两键取值,其他形态一律核不过。type 值加引号,防 `[yaml]` 这类列表型被 YAML 解析成真列表。

**type 只用 HopSpec 类型**：bool / int / float / line（单行文本;必须非空的槽可标 line(非空)）/ text（多行文本）/ markdown / yaml(结构化数据) / [T]（列表,如 [yaml]）/ enum(a,b,c)。number 已除名（数字只有 int/float）。不自造类型名（message、list[X] 都不合法）。原文语义是"每个/每封/一批/清单"的输入,type 用列表型 [yaml]——标成单值型,下游循环遍历它时必被拒。

抽取判据逐条：

- **goal**：一句话;
- **inputs**：只收任务的业务输入——原文需要外部提供的数据,不漏不添（执行设施如引擎、文件系统不是业务输入）;**同一份材料只收一种形态**——收了文件路径（如 doc_path）就不再把它的全文另立一个输入:全文由执行步骤按路径 read 取得,体量检查（如"超 3 万字报错"）随读取步做,路径与全文双收=同物两份,修订/传参两头都要维护;**原文含多种互斥用法时,inputs 要承载模式判定所需的输入**——如"生成新文档/修改已有文档"两用法,须收可选的 existing_doc（修改模式才有值,允许空）,只收单一模式的输入=另一种用法在产物里无法到达;
- **outputs**：只放原文承诺的交付物,中间产物不进;**每个 output 必须在所有执行路径上都有产出**——"某模式下才有的产物"不单列成 output（校验规则要求每个声明的 output 都有产出步骤,条件产物会在没走那条路的执行里悬空报错;合并进一个统一的交付物,或在各分支给同一个名字赋值）;
- **constraints**：翻译原文的"必须/不可"条款。**含宿主驱动语汇的条款必须翻成业务语义再进契约**——原文条款里出现执行载体的机制名与参数名（Agent 工具/Task 工具/subagent/run_in_background/AskUserQuestion/发射 agent 这类）时,提炼它约束的业务行为、驱动细节不进契约。正例：原文"同轮无依赖的审查员必须并行发射（run_in_background: true）"→ 契约写"同轮无依赖的审查员必须并行执行,不得串行"。反例（实撞后果）：契约照抄"必须并行发射（run_in_background: true）"——载体机制名进了契约,下游分拆器按"忠于契约"把它贯穿进步骤说明和 check 判据,产物绑死单一执行载体,该拆成引擎原生并行结构的段落拆不动。这与下方工具面的处理是同一个动作（原文 WebSearch 不照抄、提炼成 web_search 工具声明——约束面同款翻译）;4.3 机械核有词表兜底,命中会打回重提。**条目是纯文字字符串,文字里含英文冒号的必须整条加引号**——条目里出现 `xxx: yyy` 字样（参数名、键值对、比例）时,YAML 解析会把冒号前后劈成键值对,条目从字符串变成畸形对象,下游取值即坏（实撞:`- 并行发射（run_in_background: true）` 被解析成 `{"并行发射（run_in_background": "true）"}`——两轮打回都没修好,因为不知道劈裂机制）。写法两选一：整条引号包裹 `- "并行发射（run_in_background: true）"`,或改写避开英文冒号（全角冒号/破折号）。inputs/outputs 的 `说明` 字段同为散文位,同雷同规;
- **tools_available**：**只登记真正的外部服务**（搜索/发送/专有 API 这类引擎语言之外的依赖）,拿不准的标"待确认"留给用户裁定。**三类"假工具"一概不进工具面**——它们是 HopSpec 语言自带的能力,登记成工具就是把语言原生的东西外置了：①**文件读写**（原文的读文件/写文件/检查存在）→ 产物里是 hop_python 内置函数（read/write/exists/append/move 等）,act 步骤 body 直接调用,不是工具、不需要声明;②**并行发射 agent/子任务**（原文的 Agent 工具、run_in_background、spawn 子代理）→ 产物里是 parallel 标注的 loop/call 结构,引擎原生管派发;③**问人交互**（原文的 AskUserQuestion、人工确认、审批）→ 产物里是 ask/confirm 步骤,引擎原生暂停呈审。这三类动作照常在 goal/constraints 里保留**翻译后的业务语义**（"读演示数据""并行评审""须用户确认"——是业务行为的说法,不是宿主机制的说法;上方 constraints 判据的翻译条款同此）,只是不出现在 tools_available。**原文只用到语言自带能力时,tools_available 就是空列表 `[]`——空是正常形态,不要硬凑条目**。**第四判据:可选工具不硬声明（同一类误判被人工在对齐门纠正四次后落成的判据）**。原文以条件句式引入的外部能力（"If X is connected"/"若提供 X"/"仅当配置了 X"/"用户要求时才用 X"——共同点是原文自己就预期它可能缺席,缺席时核心功能照常工作）不进 tools_available：引擎起跑对 Tools 段硬对账,声明了没注册的工具当场拒载,硬声明等于把原文的"锦上添花"翻译成"没有就不让干活"。处置两步——条件语义写进消费步骤的说明文字（"有它时怎么做、没它时怎么做"都写清,例:"运行环境连接了聊天服务时经它发送状态通报;未连接时通报文档照常生成由用户自行分发"）;能力真身是包内脚本的随参考性附属登记。**判"该硬声明"的方法**:假设环境里没有这个工具,问"Goal 还能交付吗?"——能交付=可选不声明（例:事故响应 skill 的监控/聊天服务,没有它们通报文档照常写得出来）;不能交付=必需要声明,让缺失环境尽早失败（例:测试驱动开发的"运行测试"能力、远程部署的 SSH——拿掉它们整个 skill 无法工作）。对照示例（incident-response 实案,原文"If ~~chat is connected: post status updates"）——❌ 错:tools_available 里登记 `chat(channel, message) -> post_id`（没注册 chat 的环境起跑即拒,而用户可能只想写复盘文档）;✅ 对:tools_available 不含 chat,消费步骤的说明写"运行环境连接了聊天服务时把通报发到事故频道;未连接时通报文档照常生成,由用户自行分发——文档是交付物,分发是旁路"。**每个工具带 params 逐参数条目与 rendered 预渲染块**：params=`- 参数名: 类型  # 说明`（名字与类型从原文用法推演,说明写清值语义与取值来源,推演暂定的注明;可有 output 单输出）;rendered=按产物 Tools 段行格式预渲染好的多行文本（签名行 `- 工具名(参数, …) -> 输出名: 类型  # 用途` + 缩进参数子条目——5.1.2 机械拼接直接取它,hop_python 推导嵌套深度≤2、拼不出这种多层文本结构,文本组装归本步 LLM 期做）。只有 name/source 渲染不出参数子条目。

重试反馈非空时=上一轮没过（机械核回填的问题清单,或用户的修订意见原话）——按上方规矩以 prev_header 为基准定向修订,不整篇重来。引擎已自动注入（doc-ref）：
[[split-patterns#HopSpec 片段语法速查（骨架成文必读）]]

#### 4.3. [check] 机械核对头部契约的形态与类型（每项是 name/type 三键对象,类型是 HopSpec 合法类型）
- ← header_final, prev_header
+ → types_ok: bool  # 判定槽
+ → types_note: text  # 说明槽（坏类型清单回填,重跑轮定向修正）

纯机械判定,body 由引擎直接执行、不经 LLM。核五面：**形态**——每项必须有 name/type 键,名字直接当键的写法在此拦下并回填"该写成什么形态"的说明;**类型**——头部类型是全树的源头,错误类型一旦进入构建循环,分拆器会照着它生成步骤、到最终整文校验才批量报错,代价远高于在这里拦下;**constraints 条目形态**——每条必须是文字字符串,被 YAML 劈成对象的（散文含英文冒号所致）当场拒并回填改法——畸形对象一旦经确认冻结,下游拼文件头会渲染成 `[object Object]` 乱码,终检才发现时已烧掉整棵构建树（dr11 实撞）;**载体语汇（词表兜底）**——constraints 条目含宿主驱动语汇（run_in_background/subagent/Task 工具/Agent 工具/AskUserQuestion/发射 Agent,大小写不敏感）当场拒并回填翻译指引——载体机制名一旦进契约,分拆器按"忠于契约"把它贯穿全树,split-node 的载体边界教条翻不了契约的案（0035 实撞:run_in_background 经契约合法化,产物并行段绑死 CC 载体）;词表窄集零误伤,WebSearch 类工具名归工具面与终审人眼;**修订空转**——重跑轮（prev_header 非空）产出的 header 与上一版逐字相同=修订意见一条都没落实,当场拒（真机三轮实证:dr12/dr13/dr15 修订轮反馈通道/收尾位置/快照基准三样全到位,LLM 仍极高概率原样交卷——语义引导治不了锚定,只有机械对比拦得住;反馈直说"逐条执行修改要求",不许再交同一份）。核对之余把本轮 header 快照落盘（`header-last.yaml`,write 对结构值自动序列化为 YAML 文本）——重跑轮的 4.1 读它、4.2 以它为基准做定向修订。快照落盘在**全部体检算完之后**（body 末行）——两个理由:①先比后写,否则空转对比永远在和自己比;②体检中途炸时坏形态不落盘,失败轮不污染修订基准（coffee3 实撞:炸点前已写快照,坏基准被 4.1 读回喂给修订轮）。对比可直接文本比:快照由 write 落盘（结构值自动 YAML 序列化）,str(header_final) 走同一序列化器,两者只差尾部换行,strip 后逐字可比：
> ```hop_python
> unchanged = len(prev_header) > 0 and strip(prev_header) == str(header_final)
> missing_keys = [k for k in ["title", "spec_id", "goal"] if not get(header_final, k)]
> hf_ins = header_final.inputs if header_final.inputs else []
> hf_outs = header_final.outputs if header_final.outputs else []
> shapeless = [x for x in hf_ins + hf_outs if not (get(x, "name") and get(x, "type"))]
> legal = ["bool", "int", "float", "line", "text", "markdown", "yaml", "prompt", "line(nonempty)", "line(非空)"]
> ok_type = [x for x in hf_ins + hf_outs if get(x, "type") and (str(x.type) in legal or startswith(str(x.type), "[") or startswith(str(x.type), "enum("))]
> bad = [x for x in hf_ins + hf_outs if x not in shapeless and x not in ok_type]
> split_cons = [c for c in header_final.constraints if c != str(c)]
> carrier_cons = [c for c in header_final.constraints if c == str(c) and ("run_in_background" in lower(str(c)) or "subagent" in lower(str(c)) or "task 工具" in lower(str(c)) or "task工具" in lower(str(c)) or "agent 工具" in lower(str(c)) or "agent工具" in lower(str(c)) or "askuserquestion" in lower(str(c)) or "发射 agent" in lower(str(c)) or "发射agent" in lower(str(c)))]
> types_ok = len(missing_keys) == 0 and len(shapeless) == 0 and len(bad) == 0 and len(split_cons) == 0 and len(carrier_cons) == 0 and not unchanged
> types_note = "" if types_ok else ("缺顶层键(title/spec_id/goal 必填): " + str(missing_keys) if missing_keys else "") + ("形态错(每项必须是 name/type/说明 三键对象,如 - name: xs 换行 type: \"[yaml]\"): " + str(shapeless) if shapeless else "") + ("非法类型(不是 HopSpec 类型——改用 yaml/[yaml]/text 等合法类型;必须非空的单行槽可用 line(非空)): " + str(bad) if bad else "") + ("constraints 有条目被 YAML 解析劈成了对象(文字里含英文冒号所致)——该条整条加引号或改写避开英文冒号,重写成纯文字: " + str(split_cons) if split_cons else "") + ("constraints 有条目含宿主驱动语汇(Agent 工具/subagent/run_in_background/AskUserQuestion 这类执行载体的机制名)——契约只写业务语义,把这些条目翻译成业务行为的说法重提(如'并行发射(run_in_background: true)'改写成'并行执行,不得串行'),驱动细节不进契约: " + str(carrier_cons) if carrier_cons else "") + ("修订空转:本轮 header 与上一版逐字相同,修订意见一条都没落实——重试反馈里的每条'请补/请改'都是必改项,先把反馈拆成清单逐条执行,不许再交同一份" if unchanged else "")
> write(path: work_zone_path("header-last.yaml"), content: header_final)
> ```

#### 4.4. [ask present_inputs=header_final,aux_ledger] 呈审头部契约收修订意见
- ← header_final, aux_ledger
+ → header_feedback: text  # 用户修订意见（目标/交付物/业务输入/工具面各面）;确认无误则置空

完整呈现 header_final 与 aux_ledger（附属文件台账——哪些文件并入了构建视野、哪些留档按需读、哪些未引用呈裁）,请用户核查：目标对不对、交付物是不是要的、业务输入有无多缺、工具面有无漏（"待确认"项在此裁定）、附属文件定性有无错判（流程性文件漏判成参考性=它里面的门禁原话进不了构建视野,产物把关面直接缺一块——这是最值得人看一眼的定性）、**原文的结构性设计意图有没有被简化**（原文对执行结构有设计的——分几轮、什么顺序、后面的做法依赖前面的产出——产物做了简化就逐处列出:简化了什么、为什么,请用户批方向;用户批了才算数,不批就保住原文结构。与数值禁软化同一条原则:设计意图不许静默降级）。有修订意见 → 原话记入;确认无误 → 置空。（台账定性意见与 header 意见走同一条记录通道,生效时点不同——对齐门重试回路只对 header 定向修订;定性意见在此如实记入原话后,经口径日志落盘进产物同目录 alignment-notes.md,**下一轮构建时步骤 2 按该口径定性、构建基准随之重拼**——当轮不改台账:台账定性的下游〔source.md 拼接〕本轮已冻结,只改定性字段不重拼基准,把关面照缺、账面反而假绿。收到定性意见时把这个生效时点告诉用户。）

#### 4.5. [check final] 对齐门：修订意见清空才放行
- ← header_feedback
+ → aligned: bool  # 判定槽
+ → align_note: text  # 说明槽（装用户的修订意见原话——判定不过时,引擎把它作为失败反馈带给下一轮 4.2 定向修订）

纯机械判空+意见转运,body 引擎直执零 LLM（意见非空时顺手累积进 work_zone 口径日志——交付 commit 从此文件收割落 alignment-notes.md;为什么在本步累积:放行判据恰是意见为空,走到交付步时 header_feedback 恒空串,不在此累积历轮意见就随重问轮覆盖蒸发）：
> ```hop_python
> aligned = not strip(header_feedback)
> align_note = "" if aligned else header_feedback
> logged = append(path: work_zone_path("alignment-feedback-log.txt"), content: "- " + str(today()) + " " + strip(header_feedback) + "\n") if strip(header_feedback) else ""
> ```

对齐门管方向,终审管收口。此后进入构建循环——循环内不再问人。

### 5. [loop max=10] 意见轮循环（构建→质检→终审→按意见分流;意见轮次乘循环迭代,不烧事务重试）
+ → review_outcome: line = "init"  # 圈信号（值语义:"init"=本圈未走到分流;"revise"=有修订意见,续圈消化;"approved"=终审意见为空;"accepted"=意见轮耗尽人裁接受现状;"out_of_scope"=意见指向头部契约,超本流程修复范围）
+ → build_directive: line = "build"  # 构建路由指令（值语义:"build"=整树构建;"fix"=沿用盘上现稿定向修）
+ → pending_feedback: text = ""  # 待消化的终审意见原话（跨圈携带——loop 迭代没有重试反馈通道,意见走变量进修错工单与任务书）
+ → tier: line  # 产物档位（每圈经 5.1 产出;声明进循环输出——不声明则值困在循环内,首轮主路收口时头部 Outputs 的 tier 无值,完备闸在整树构建+质检+终审全部干完之后判 failed,最贵的失败位）
+ → spec_text: text  # 当前产物全文（同 tier——步骤 7/8 跨圈消费,声明出循环边界）

（**为什么是循环不是重试**（实撞:dr21 两条局部意见〔补一个写盘步/两个 commit 换形态〕烧 10 小时整树重建,重建树与上版大同小异）：重试形态下意见闸一失败整层重跑=整树重建（小时级）,而质检环现成的修错机械（分钟级）就干得动局部意见。循环形态把"意见轮次"与"机械失败重试"解耦：每圈=构建或定向修→质检→终审→分诊,意见经变量进入下一圈,build_directive 路由定这圈是重建还是修现稿;内层事务的 retry 只兜机械失败。max=10 圈封顶——十轮意见都不收敛,出圈由意见闸如实判败。）

#### 5.1. [subtask retry=3] 意见轮事务（一圈一轮:组任务书→构建或修稿→质检→终审→分诊;retry 只兜机械失败〔构建崩溃/质检耗尽人裁重建〕,不烧意见轮次;耗尽不立毁,呈现场问人）
- ← skill_content, header_final, root_task, empty_context, no_vars, max_depth, judgement_log, aux_ledger
+ → spec_text: text  # 完整 spec.md 文本（质检双关通过,或耗尽人裁接受现状）
+ → tier: line  # 产物档位（hop / mixed）

##### 5.1.1. [act] 组装本轮任务书（意见并入——指向整段拆法的意见经它进入重拆）
- ← root_task, pending_feedback
+ → effective_task: text  # 本轮构建任务书（=root_task;有待消化意见时拼接修订要求段——分拆器整树重建时照此改拆法）

纯机械,body 引擎直执零 LLM：
> ```hop_python
> effective_task = root_task
> if len(pending_feedback) > 0:
>     effective_task = root_task + "\n\n【终审修订要求（作者意见,最高优先,逐条落实）】\n" + pending_feedback
> ```

##### 5.1.2. [branch] 构建路由：fix=沿用盘上现稿交质检定向修,build=整树构建
- ← build_directive
+ → draft_path: line  # 草稿文件路径（统一接口——两支路同名赋值）
+ → tier: line  # 档位
+ → log_text: text  # 研判点台账内容

###### 5.1.2.1. [case(build_directive == "fix")] 定向修路——现稿就是工作稿,零重建成本（修复本体在 5.1.3 质检环的修错步,工单=pending_feedback）
####### 5.1.2.1.1. [act] 沿用现稿（变量自传递,盘上草稿不动）
- ← draft_path, tier, log_text
+ → draft_path: line  # 同值传递
+ → tier: line  # 同值传递
+ → log_text: text  # 同值传递
> ```hop_python
> draft_path = draft_path
> tier = tier
> log_text = log_text
> ```

###### 5.1.2.2. [case(else)] 整树构建路——首圈、意见指向整段拆法、或质检耗尽人裁重建

####### 5.1.2.2.1. [subtask retry=2] 构建（只管建出来——检与修归 5.1.3 质检环）
- ← skill_content, header_final, effective_task, empty_context, no_vars, max_depth, judgement_log
+ → draft_path: line  # 草稿文件路径（涂鸦区 spec-draft.md——后续检修都对着这个文件干活）
+ → tier: line  # 档位
+ → log_text: text  # 研判点台账内容（终审备料消费）

（构建事务,retry=2 只兜构建自身的偶发崩溃〔递归 call 死/拼装炸〕——带反馈重跑重 call 即可;产物质量问题不在本层打回——归 5.1.3 修错环节定向修,不整树重建。深层子树的失败由分拆器逐层降档消化,通常到不了本层。）

######## 5.1.2.2.1.1. [call split-node(node_task: effective_task, node_source: skill_content, parent_context: empty_context, parent_vars: no_vars, depth: 1, iteration: 1, max_depth, target_profile, header_final, judgement_log)] 递归分拆整个 skill
+ → spec_body_path: fragment_path  # 产物 Steps 全文的文件路径（work_zone 涂鸦区文件——值是路径不是内容,片段全文不过变量通道;内容=分拆器递归返回的完整片段,编号已机械重刷,拼装整验已跑）
+ → tier: tier  # 子树档位（hop / mixed）

（分拆器=同目录 split-node.md 判定序:顺序→分支→循环→原子,命中即 call split-structure 执行结构分拆并递归。调用栈即分拆树。）

######## 5.1.2.2.1.2. [act] 拼接文件头
- ← header_final, tier
+ → header_text: text  # 文件头文本本体（`# Spec:` 起头到 Outputs 节止,不含 `## Steps`）

纯机械拼接,body 由引擎直接执行、不经 LLM——header_final 的字段在 4.x 已定稿并经用户确认,文件头就是它的确定性排版,没有任何需要 LLM 裁量的成分。**tools_available 非空时渲染成产物 Tools 段**（HopSpec 语言的工具需求声明——每工具一条签名行 `- 工具名(参数, …) -> 输出名: 类型  # 用途`,参数子条目 `- 参数名: 类型  # 说明` 逐个展开,复杂语义放 `> 扩展`;引擎 init 会对环境注册面对账,这正是对齐收集工具面的产物落点;空列表不渲染该段）。条目容错：constraints 与说明字段是散文位,可能被 YAML 解析劈成对象（源头 4.3 已拦,此处纵深兜底）——非字符串条目机械序列化成单行文字,绝不让对象进字符串拼接（`"- " + dict` 的默认序列化是字面量 `[object Object]`,直接毒进产物文件头,dr11 实撞烧掉整棵树）：
> ```hop_python
> in_lines = ["- " + i.name + ": " + str(i.type) + "  # " + str(i.说明) for i in header_final.inputs]
> out_lines = ["- " + o.name + ": " + str(o.type) + "  # " + str(o.说明) for o in header_final.outputs]
> con_lines = ["- " + (c if c == str(c) else str(c)) for c in header_final.constraints]
> tool_blocks = [str(t.rendered) for t in header_final.tools_available] if header_final.tools_available else []
> tools_section = "\nTools:\n" + join(tool_blocks, "\n") + "\n" if tool_blocks else ""
> zh = hop_env_language == "zh"
> id_w = "标识" if zh else "Id"
> goal_w = "目标" if zh else "Goal"
> cons_w = "约束" if zh else "Constraints"
> in_w = "输入" if zh else "Inputs"
> out_w = "输出" if zh else "Outputs"
> header_text = "# Spec: " + header_final.title + "\n" + id_w + ": " + header_final.spec_id + "\n> 档位: " + tier + "（hop=全结构化,双模式皆稳;mixed=含未尽原子——standalone 由引擎带工具面的 LLM 循环执行,所需引擎外能力须经 Tools 段声明,声明齐即可跑;复用模式 caller 能力面开放天然宽容）\n\n" + goal_w + ": " + header_final.goal + "\n\n" + cons_w + ":\n" + join(con_lines, "\n") + "\n\n" + in_w + ":\n" + join(in_lines, "\n") + "\n\n" + out_w + ":\n" + join(out_lines, "\n") + tools_section + "\n"
> ```

######## 5.1.2.2.1.3. [act] 拼接落盘
- ← header_text, spec_body_path, judgement_log
+ → draft_path: line  # 草稿文件路径（涂鸦区 spec-draft.md 固定名——检修事务对着它干活）
+ → log_text: text  # 研判点台账内容（读自 judgement_log 文件;不存在=零研判点——合理关与终审备料共用）

纯机械拼接落盘,body 由引擎直接执行、不经 LLM（覆盖写幂等;spec_body_path 是路径,产物 Steps 全文按它机械读回——片段全文只在 body 手里流转,不过 LLM）：
> ```hop_python
> spec_body = read(path: spec_body_path)
> write(path: work_zone_path("spec-draft.md"), content: header_text + "\n## Steps\n\n" + spec_body)
> draft_path = work_zone_path("spec-draft.md")
> log_probe = parse_json(exists(path: judgement_log))
> log_text = read(path: judgement_log) if log_probe.exists else "（零研判点——全程无暂定决策）"
> ```

##### 5.1.3. [loop max=10] 终检修错循环（一圈=一个修检事务;烧尽经人裁"继续修"则开下一圈,以全新额度接着修）
+ → qc_outcome: line = "init"  # 圈信号槽（值语义:"init"=本圈没走到烧尽问人;"continue"=人裁继续修,别出圈;"accept"=人裁接受现状）

（循环只为承载"继续修"——用户可以决定继续完成一个暂时耗尽暂停的任务：正常局面一圈就出——修检通过出圈、人裁接受现状出圈、人裁放弃则失败上浮交外层重建;只有烧尽问人时人选"继续修"才进下一圈。引擎对循环新迭代自动重置圈内事务的重试预算与兜底标记（新迭代=全新事务,既有语义零引擎改动）,修检以全新 10 轮额度接着盘上草稿现场继续——新一圈重新体检、重新出工单,不依赖上一圈的反馈通道。max=10 是安全上限:每进一圈都要人亲手选"继续修",不会空转。）

###### 5.1.3.1. [subtask retry=10] 修检事务（错在产物上就地修,不整树重建;烧尽不立毁,呈现场问人）
+ → spec_text: text  # 终稿全文（合法关+合理关双过,聚合输出;烧尽走"接受现状"路径时=当前草稿全文,剩余缺陷清单随审阅文件修检遗留节呈终审）

（**为什么是修错不是打回重建**：走到这里,构建产物 99% 是好的——终检抓到的多是机械可修的局部缺陷。打回 5.1 重建=重拆整棵树（小时级）,且病根若在冻结输入里,重建一万次同病依旧;定向修产物文本（分钟级）当场断根。本 subtask retry=10（原 3 次——实撞:质量明明每轮在收敛〔缺陷从 5 条重级降到 2 条轻级〕却恰好耗尽 3 次额度整树作废,收敛型迭代要给足跑道）:合理关问题清单经重试反馈喂给下一轮修错步,正好是"按清单定向修"的工单。**烧尽不再自动升级重建**——尾部 [on fail] 兜底:当前产物与评估意见落盘成文件,问人裁"继续修 / 接受现状交终审 / 放弃走重建"三选一——选继续修则外层循环开下一圈,修检以全新额度接着盘上草稿修;几小时成果要不要作废是人的决定,不是机器的。）

####### 5.1.3.1.1. [act] 机械体检（含动作句台账抽取、修检工单台账预创建与指针闭合机械核）
- ← draft_path, skill_content, aux_ledger
+ → spec_text: text  # 草稿全文（读回盘面真身）
+ → health_report: text  # 体检单：validate JSON + 形态扫描结果（构建期标记残留/序列化乱码）
+ → action_ledger: text  # 动作句台账——构建基准里含交付动词/门禁语汇/通知语汇的行（带 L 行号原样列出;机械扫描只抽不判,判定归合理关逐句过账——行覆盖对账查"行有归属",本台账查"动作有落点",两账互补）
+ → issue_ledger_path: line  # 修检工单台账文件路径（work_zone,跨 retry 轮存活——历轮合理关工单在此累积,判官销项底册的物理载体;本步只保证文件在场,落账归修错步,读回归复验步）
+ → pointer_report: text  # 指针闭合机械核报告（产物反引号包内路径 × aux_ledger 台账集合比对;"闭合:N 条全可达"或逐条列悬空;机械只比对,悬空真伪与打回判定归合理关子面 7 表态）

纯机械,body 引擎直执零 LLM（形态扫描抓两类已实撞的毒形态：`[object Object]`=对象误入字符串拼接;`待展开——`=构建期占位标记泄漏进成品。动作句抽取是关键词行扫描——宁多勿漏,误抽的行合理关一句"非动作句"过账即可,漏抽的动作蒸发就没人查了）：
> ```hop_python
> spec_text = read(path: draft_path)
> v = validate_spec(text: spec_text)
> leaks = [l for l in split(spec_text, "\n") if "[object Object]" in l or "待展开——" in l]
> health_report = v + ("" if len(leaks) == 0 else " | 形态残留 " + str(len(leaks)) + " 行: " + join(leaks, " ;; "))
> issue_ledger_path = work_zone_path("issue-ledger.md")
> ledger_probe = parse_json(exists(path: issue_ledger_path))
> created = write(path: issue_ledger_path, content: "# 修检工单台账（新轮在上,历史在下）\n") if not ledger_probe.exists else ""
> deliver_words = ["写入", "保存", "落盘", "发送", "提交", "部署", "删除", "发布", "输出到", "write", "save", "send", "submit", "deploy", "delete", "publish", "commit", "create the file", "output to"]
> gate_words = ["必须", "不得", "才能", "方可", "禁止", "之前不", "must", "never", "only after", "do not", "don't", "required before", "cannot", "forbidden"]
> notify_words = ["通知", "告知", "上报", "notify", "alert", "report to", "escalate"]
> src_rows = split(skill_content, "\n")
> hit_rows = [l for l in src_rows if len([w for w in deliver_words + gate_words + notify_words if w in lower(l)]) > 0]
> action_ledger = join(hit_rows, "\n")
> ticks = [t for t in split(spec_text, "`") if ("/" in t and " " not in t and "\n" not in t and ("references/" in t or "scripts/" in t or "assets/" in t or startswith(t, "./")))]
> known_paths = [str(e.path) for e in aux_ledger]
> unref_paths = [str(e.path) for e in aux_ledger if str(e.定性) == "未引用"]
> dangling = sorted([t for t in ticks if len([k for k in known_paths if k in t or t in k]) == 0])
> ref_unref = sorted([t for t in ticks if len([k for k in unref_paths if k in t or t in k]) > 0])
> pointer_report = ("指针闭合: 产物含包内路径引用 " + str(len(ticks)) + " 处,台账外悬空 " + str(len(dangling)) + " 条" + ("" if len(dangling) == 0 else ": " + join(dangling, " ;; ")) + ("" if len(ref_unref) == 0 else " | 引用了'未引用'定性文件 " + str(len(ref_unref)) + " 条: " + join(ref_unref, " ;; "))) if len(ticks) > 0 else "指针闭合: 产物无包内路径引用（零仪式）"
> ```

####### 5.1.3.1.2. [act free] 定向修错（无错不动——修的是产物文本,只修清单所列）
- ← draft_path, health_report, pending_feedback, issue_ledger_path
+ → fix_note: line  # 一句话修错记录（"无错未动"或"修了 N 处:…"）
- 工具: validate_spec  # 交卷自检的工具真身（实撞:教学写了自跑 validate_spec 但工具面没授权,执行体降级人肉分段核——教了没授权=工具对执行体静默不可见）
- 禁工具: write  # 修错步禁整文件覆盖——0038b 实测 37KB 草稿 7 轮全文回写 ≈17 万 tokens,最大输出浪费源
- 禁工具: append  # 堵分块重建全文的旁门（0038b 实撞:create+8 次 append+move 重建整文件）
- 禁工具: create  # 同上旁门的另一半——create 新路径写全文再 move 覆盖,照样是整篇重建,照撞单次回复长度上限

**动手修之前先落账（判官的销项底册靠你记,漏记=判官下一轮失忆重开旧单多烧一轮）**：重试反馈非空时,先用一次 edit_file 把它的工单原话记入 issue_ledger_path 台账（old_text=固定头行"# 修检工单台账（新轮在上,历史在下）",new_text=头行+本轮工单原话+分隔行"---"——新工单恒插头行之后,零 read 前置）;重试反馈为空（首轮）则跳过落账。

按三份工单定向修草稿文件：**health_report**（机械体检的 error 清单与形态残留行）+ **重试反馈**（非空时=上一轮合理关的问题清单原话）+ **pending_feedback**（非空时=作者终审的定向修订意见原话——最高优先,逐条定向落实;这是定向修路的修复本体:意见指向的每一处按意见改,与机械工单同一套定向编辑纪律）。规矩：只修工单所列,不重写、不顺手润色——读 draft_path 定位问题行,直接改文本写回（结构性改动用 read_spec_tree 定位、replace_node/insert_node 定向替换或插入;文件头/散文行直接文本替换）。**禁止整篇重写草稿**——就算工单有五六条也要一处一处定向改,不许"一次全文重写落实全部修错"：草稿几万字,整篇重写的输出会撞上单次回复的长度上限被硬生生掐断,引擎判残缺输出不收、重试还是同样被掐,几轮下来修错步就死在这堵墙上（实撞:工单 5 条,修错步选整篇重写,输出打满上限被掐断两次,修检额度整段烧光）。定向改每处只输出改动那几行,永远撞不上这堵墙。定向文本改动用 edit_file（old_text 带足上下文保唯一,new_text 只含改后形态;零/多匹配会报错带计数,按报错补上下文重试即可。**三种编辑同一原语**:替换=new_text 写改后文本;删除=new_text 空串;插入=old_text 取插入点的锚文本、new_text=锚文本+新内容——如在某句后补一行:old_text="那一句。" new_text="那一句。\n补的这一行。"）;结构性改动（整步骤增删换）仍用 read_spec_tree 定位+replace_node/insert_node——**注意这族工具是纯函数:内容进内容出,不碰盘面文件**,它们返回的改后文本要落盘仍然走 edit_file（old_text=待改节的盘上原文,new_text=工具返回的改后节文本,一次整节替换——不逐行改）;write 与 append 本步已禁用——引擎给你的工具清单里没有它们,这不是故障是设计。**供给面同样定向——本步不再直喂草稿全文与原文全文,按工单定位读盘**：草稿侧,工单点名哪处读哪处（结构性缺陷用 read_spec_tree node 档按步骤号取那一节;文本缺陷 read draft_path 后按工单引用的原句定位）——工单没点名的地方不需要看;原文侧,工单条目带 L 行号引用（如"原文 L419-425"）时用 `read(path: source.md 路径, start_line: 起, end_line: 止)` 直接取那一段,不整读全文再自己找——**行号对应事实：source.md 第 N 行就是构建期编号版的 L N,一一对应零偏移**（source.md 是构建基准的纯副本——本体+流程性与混合附属同序拼接,编号版是对同一份拼接产物逐行加 `L<n>: ` 前缀,两者行号同一套全局续排,read 的行号参数放心按号填;工单行号指向附属文件段落时同样按全局号读 source.md,不去读附属原件——附属原件的文件内行号与全局号有偏移）;工单没带行号的原文引用,用 `search_file(path: source.md 路径, pattern: 关键词)` 定位（返回命中行清单带行号,零命中空清单）,再按行号段读——不整读后人肉扫。草稿侧文本缺陷同理:先 search_file 找工单引用的原句行号,read 行号段核上下文;edit_file 动手前可拿 search_file 命中数自证 old_text 唯一性（1 处=直接改,多处=补上下文,0 处=引句有出入先核对）。**工具轮预算纪律（引擎给本步的工具循环上限是 20 轮,撞满整步作废重来,当轮已花的定位轮全部白烧;实撞:两份语料各 4+ 次撞墙,都是长工单一轮贪多）**：每处缺陷的预算≈1 次定位读+1 次 edit_file（工单条目带行号的直接 read 行号段,不 search_file——定位信息工单已给,再搜索是浪费）;**工单超过 8 条时只修前 8 条**,fix_note 如实写"修了 K/N 处,余 N-K 处未动"——复验关会把余下缺陷重新开进下一轮工单,你修过的部分在盘上累积,下一轮从第 9 条接着修;这不是偷懒是活下来:强行一轮修完必撞 20 轮墙,盘面成果虽在但当轮全部定位成本白付,还多烧一次 retry。**修复新增的步骤同守全部纪律**——补"无落点"缺陷时新写的步骤含交付写盘的须当场拆 act+check+commit 三段、含闸门的落 ask/confirm（实撞:修"冷启动闭环无落点"新增单步 [act free] 把写盘塞进探索段,下一轮就被打回"写盘无 commit 承载"——修 A 病引出 B 病,多烧一轮）。两份工单都空 → 一个字不动,fix_note="无错未动"。**交卷前自检（你新写的每一行都要过下一步的机械 validate,写坏=整事务多烧一轮 retry,当轮全部定位成本白付;实撞:两份语料 20 轮修检里 10 轮是修复新写内容撞机械关）**：全部工单修完后,read(draft_path) 读回全文,validate_spec(text: 全文) 自跑一遍——errors 非空按报错定位当场再修（报错带行号与规则名,与工单同一套 edit_file 定向改法）,直到零 error 才写 fix_note 交卷;此两轮（1 read+1 validate）不占工具轮预算纪律的缺陷预算,是固定交卷税,比撞机械关便宜二十倍。修完写回 draft_path。引擎已自动注入（doc-ref）：
[[split-patterns#hop_python 文法速查（写 body 必读）]]
[[split-patterns#HopSpec 片段语法速查（骨架成文必读）]]

####### 5.1.3.1.3. [act] 复验读回
- ← draft_path, fix_note, issue_ledger_path
+ → spec_text: text  # 修后全文（读回盘面真身——下游各关与交付都用它）
+ → recheck_result: text  # 修后 validate JSON
+ → leak_count: int  # 修后形态残留行数
+ → free_warns: int  # B7 act 无 body 未标 free 警告数（hopissues/0062——合法关按缺陷拦）
+ → issue_history: text  # 历轮修检工单全史（issue-ledger.md 读回——修错步刚落完账,此刻读含最近一轮;判官的销项底册）

纯机械,body 引擎直执零 LLM。free_warns=validate warning 里 B7 'act 无 body 也未标 free' 形态的计数（hopissues/0062——引擎 B7 分级不动:warn 对手写 spec 是合理提示;构建器产物标准只高不低,交付闸自己收紧,构建器自己是 LLM 交付前修掉零成本）：
> ```hop_python
> spec_text = read(path: draft_path)
> recheck_result = validate_spec(text: spec_text)
> leak_count = len([l for l in split(spec_text, "\n") if "[object Object]" in l or "待展开——" in l])
> free_warns = len([1 for seg in split(recheck_result, "message") if "也未标 free" in seg])
> issue_history = read(path: issue_ledger_path)
> ```

####### 5.1.3.1.4. [check] 整体合法关：validate 零 error 且形态残留清零且 act-free 警告清零
- ← recheck_result, leak_count, free_warns
+ → legal_ok: bool  # 判定槽
+ → legal_note: text  # 说明槽（error 清单回填,重试轮定向修正）

纯机械判定,body 引擎直执零 LLM。act-free 类 B7 warning 在本闸按缺陷拦（hopissues/0062 实撞:icd10-cm 产 [act] 无 body 未标 free,合法关只吃 error 放行,交付 spec 文法不合格——警告不是可选建议,是构建器漏标的确定性信号）：
> ```hop_python
> legal_ok = ('"errors":[]' in recheck_result) and leak_count == 0 and free_warns == 0
> legal_note = "" if legal_ok else recheck_result + (" | 形态残留未清零: " + str(leak_count) + " 行" if leak_count > 0 else "") + (" | " + str(free_warns) + " 个 act 步无 body 也未标 free——LLM 裁量步（选工具/解释结果/生成措辞）标 [act free] 承认自由任务档;纯机械动作补 hop_python body。逐个改后重交" if free_warns > 0 else "")
> ```

####### 5.1.3.1.5. [check final] 整体合理关：首要原则四条（审毕清单制）
- ← spec_text, skill_content, log_text, header_final, recheck_result, action_ledger, aux_ledger, issue_history, pointer_report
+ → sensible_ok: bool  # 判定槽
+ → sensible_note: text  # 说明槽（审查面逐项过账+问题清单回填——本清单是下一轮修错步的工单,一次列全）

对照七份材料复核：**spec_text**（被审对象）、**skill_content**（构建基准——本体+流程性与混合附属拼接后的编号版,忠实性的对照基准）、**log_text**（研判点台账——已记档的暂定处置清单）、**recheck_result**（修错后复验的 validate JSON——warning 是白送的缺陷线索,逐条表态;这是修错**之后**的单子,与你手上的 spec_text 同一时点——修错前的旧体检单已修掉的 error 不在其中,别把不存在的 error 写进工单〔实撞:两路各一条幻影条目,修错步为已不存在的 error 空转定位〕）、**action_ledger**（动作句台账——机械抽出的交付/门禁/通知行,逐句过账用）、**aux_ledger**（附属文件台账——指针闭合核对照用）、**issue_history**（历轮修检工单全史——你的销项底册,用法见下）、**pointer_report**（指针闭合机械核报告——子面 7 对它表态,不用自己扫）。

**销项底册（你是本轮新起的判官,没有前几轮的记忆,issue_history 就是你的记忆）**：issue_history 里除头行外还有内容=本事务已有前轮,**禁止自称"首轮/首圈/无上轮工单"**（实撞:两路判官各一次自称首轮,存量缺陷重开新单多烧轮次）。过账三则:历史工单列过且已修好的条目,一句"已落实"带过;列过但检查发现仍在的,标"**复现**"重新入单（复现条目=修错步上轮修法无效的信号,工单里给出与上轮不同的修法指引）;上轮你（前任判官）判过"非实质"的条目,本轮不改口升格——判据没变结论就不变,要升格必须写明"升格理由=什么新事实"（实撞:三处非实质→实质无理由改口,修错步白白多修）。核首要原则四条（分拆器逐节点核过同样四条,这里整文再核一遍,防拼装后的整体语义漂移）：

1. **忠于原始语义**——逐段对照 skill_content:原文的步骤在 spec_text 里全有落点、spec_text 没有原文之外杜撰的业务步骤;原文的交互闸门（问人确认/审批）逐个落成了 ask/confirm 或占位。原文没给的判据不算缺陷:log_text 里已记档的暂定处置是正当形态,不打回;
2. **探索-检验-提交分离**——commit 前面有针对交付物的 check,commit 没混进探索步骤中间;**判"无需 commit"之前必须先对照 skill_content 扫交付动词**（"保存为/写入/落盘/输出到文件/发送/提交"）——原文有交付写盘/外发动作而产物无 commit 步=交付语义蒸发,打回（实撞两轮:ppt 原文明写"保存为 presentation.html",产物交付做成 text 输出变量,判定器两次判"原文无写盘动作"通过——不回原文扫动词,"无"是猜的不是查的）;
3. **渐进合理**——未尽原子（以自然语言描述落定的步骤）是正当形态,不是缺陷;
4. **可读可解释**——全文结构讲得出为什么这样拆。

**审毕清单制（"一次列全"的机械可核形态——实撞:四轮打回条目零重叠,判官视野逐轮下钻,每轮都自称列全实际只列当轮视野内的,同一文本的存量缺陷分三轮放出烧穿预算）**：sensible_note 必须按下面七个审查子面**逐项过账**,每个子面写"查了,结论 X"或"查出缺陷 N 条:…"——静默跳过任何子面=审查不完整,不许交卷：

1. **原文动作落点**——skill_content 的每个规定动作/交付物在 spec_text 有步骤承载（含"何时不用"边界、异常降级路径这类容易漏的段落）;**判据/定义/模板类内容的承载标准=定义能在产物里读出来**（分档判据每档的分界文字在场、公式的阈值数字在场、模板的字段齐全——名目提及不算承载,判据的定义必须能在产物里读出来;实撞 0039:产物描述写"严重度锚点 1-5、优先级公式 P0-P1-P2"五档分界与阈值全没落,当轮自查把名目当覆盖放行了）。细则全文可在步骤描述、产物内容章节或占位行号任一处——不强制形态,只核在场;
2. **闸门落位**——原文交互闸门逐个落成 ask/confirm,且条件闸门带条件结构（不是无条件执行）;
3. **commit 承载**——交付写盘动词扫过（正典词表=5.1.3.1.1 机械体检的交付动词表——action_ledger 里的交付动词行就是本子面的扫描底册）,每个都有 commit 步;
4. **commit 可执行性**——每个 commit 步有 hop_python body 或明确执行说明、← 输入声明齐（写盘内容与路径变量都接上了）——**recheck_result 的每条 warning 在此表态**："采纳为缺陷"或"不构成缺陷因为 X"（B7"commit 无 body"类 warning 是机械层白送的线索,前形态两头都不管:合法关只吃 error、语义关又不引用,最后回马枪杀全容器）;
5. **变量断链**——逐个 commit/check 步核 ← 声明与其**任务描述所需**的数据是否对得上,要抓的病形态是"该引未引"：步骤说明写着要产出文档,← 里却没有 doc_path（实撞:19.5 只声明 ← decision_record 漏 doc_path,首轮判官反宣布"未发现断链"）。另一半"← 引了但产出者不存在"的形式断链**不用查**——机械校验已经核过（结果就在你手里的 recheck_result 里）,再查一遍纯属白烧你的输出预算;
6. **动作落点逐句过账**——action_ledger 逐句问"产物哪一步承接这个动作",答得出步骤号即过,答不出=落点缺席打回（confirm 批完必须有执行步、ask 收的值必须有消费步、结果变量必须有下游——行被行号对账"覆盖"不等于动作被承接:teardown confirm 批完无执行步/通知 ask 收了无消费者/结果变量断流,三处实撞全是"行有归属、动作无落点"）。非动作句（关键词误抽的行）一句"非动作句"带过;多句同指一个动作的合并过账;
7. **指针闭合与随包清单**——对 pointer_report（机械体检已做完"产物路径引用 × 台账"的比对,报告在手,不用自己扫全文）逐条表态：报告列的"台账外悬空"条目逐条判真伪——真悬空（执行者按指针取流程真身时两手空空,流程随依赖丢失,保真缺陷）打回,机械误抽（比对是子串匹配宁多勿漏,示例文字/外部 URL 可能被带进来）一句"误抽"带过;报告列的"引用了'未引用'定性文件"条目同判——真引用=要么改定性要么去引用,打回;报告说零悬空则一句"闭合"过账。
8. **数值对账**——从 skill_content（你手里的编号版）机械视角抽数字 token（百分比/阈值/枚举值/份数/版本号/时间量,带上下文短窗防裸数值误配）,逐个问产物在场性（**只抽业务数值**——L 行号前缀/列表序号这类定位性数字不是业务数值,不入对账;判据:这个数字改了会不会改变执行行为,会=业务数值）：原值在场或语义等价形态=过账;**缺席/软化（数值变形容词——原文"80%"产物只剩"达标"）/分支丢失（原文按条件给不同值——如"集群 3 副本/单点 1 副本"——产物只留一支）= [实质] 缺陷打回**（实撞:整卷审计抓两处失真,阈值软化+单点副本分支丢失,单点场景照残支门禁必误判——翻译改写数值此前零机械核对,对齐门只核头部罩不住步骤说明里的数字）。

**缺陷分级与放行判据（治"只剩轻毛病仍零容忍烧穿额度"）**：问题清单每条标 `[实质]` 或 `[非实质]`——**实质**=影响执行语义的缺陷（原文动作无落点、交付蒸发、闸门缺失、变量断链、commit 不可执行、判据定义蒸发〔原文的分档标准/阈值/模板在产物只剩名词——不修则执行期判定必然失准〕——不修的话 spec 跑起来行为就是错的）;**非实质**=纯文本瑕疵（措辞、注释表述、格式——修不修都不改变 spec 的执行行为）。**过关判据=实质缺陷清零**：实质清零、只剩非实质残留 → sensible_ok=true 放行,残留逐条写进 sensible_note 开头并标『放行残留』——记录在案不漏账（5.1.4 会把 sensible_note 拼进审阅文件,终审随产物呈作者）,不为文本瑕疵烧修检轮次;有任何实质缺陷 → 照旧打回。

**销项克制**：重跑轮对上轮工单的落实核验一句"已落实"/"残余:X"带过——销项是复核不是审查,逐条长篇核验会挤掉本轮的全面审查（实测判官单轮 29K tokens 大半花在销项上,当轮新缺陷审查被挤薄）。**打回时问题清单一次列全**（七个子面查出的全部缺陷逐条进 sensible_note——它就是下一轮修错步的完整工单,挤牙膏=多烧一轮）;**工单条目带定位引用（修错步已不再收原文全文,你的工单是它唯一的原文窗口）**：凡指向原文的条目必带 L 行号引用（你手里的 skill_content 就是编号版,引用零成本——如"[实质] 原文 L419-425 的异常处置在产物无落点";修错步按行号读 source.md 对应段,不带引用它只能盲猜或通读,供给瘦身收益直接蒸发）;凡指向产物的条目带步骤号或原句短引用（产物无行号,步骤号是它的定位系——如"[实质] 5.2.3 的 ← 漏 doc_path"）;**缺陷分型**：病根在 header_final 形态本身（而非产物文本可修）的,点名"[源头缺陷] header_final 第 N 项——修错步只能治产物文本症状,断根须重开对齐门",供上浮路径知情。引擎已自动注入（doc-ref）：
[[split-patterns#subtask 探索范式（步骤定型与事务形态）]]

####### 5.1.3.1.6. [on fail] 额度烧尽兜底：呈现场问人,不自动作废

######## 5.1.3.1.6.1. [reason] 烧尽现场判断件（判断归本步,草稿全文与写盘归下一步 body——act free 教 work_zone_path 取不到路径、几万字草稿亲手转写必撞输出上限,两病一并治）
+ → exhaust_brief: text  # 现场判断件（改善对比行+最后工单+历轮简史+评估意见——原料全部来自重试反馈,草稿全文不进本步）
+ → exhaust_headline: line  # 纲要短句（剩余缺陷条数与分级/收敛趋势一句话——组装步拼上文件路径后呈人）

原料就是本步收到的重试反馈（历史行全在场）,零工具需求。exhaust_brief 按序四段成文：**开头第一行是改善对比**「上一轮缺陷 M 条 → 最后一轮 N 条」（M/N 从重试反馈的历史行整理;数不出就如实写"历史不可得"）——人判断还在不在收敛,先看这一行;然后 ②最后一轮合理关的完整问题清单（从重试反馈里取——那就是最后一轮的工单原话）;③修检历轮简史（每轮修了什么、还剩什么,一轮一行）;④你的评估意见——缺陷是否在收敛（每轮变少变轻=是）、剩余缺陷按影响分级（哪些影响运行、哪些只是文本瑕疵）、若继续修预计还要几轮。

######## 5.1.3.1.6.2. [act] 机械组装烧尽现场文件（body 引擎直执——草稿全文直接拼变量,零 LLM 转写）
- ← draft_path, exhaust_brief, exhaust_headline
+ → exhaust_path: line  # 现场文件绝对路径（work_zone 下固定名 exhaust-report.md）
+ → exhaust_note: text  # 呈人纲要（短文本:纲要短句+文件路径——问人时呈它,现场载荷走文件不内联终端）

exists 返回 JSON 文本,parse_json 取 .exists 才能当条件（4.1 同款,草稿读不到如实拼"草稿缺失"）：
> ```hop_python
> probe_exists = parse_json(exists(path: draft_path)).exists if draft_path else false
> draft_body = read(path: draft_path) if probe_exists else "（草稿缺失——构建环未产出草稿即耗尽时 draft_path 为空,exists 不吃空路径,先判值再探盘）"
> write(path: work_zone_path("exhaust-report.md"), content: exhaust_brief + "\n\n## 当前草稿全文\n\n" + draft_body)
> exhaust_path = work_zone_path("exhaust-report.md")
> exhaust_note = exhaust_headline + " | 现场文件:" + exhaust_path
> ```

######## 5.1.3.1.6.3. [ask require_human present_inputs=exhaust_note] 修检额度用完,问人怎么办
- ← exhaust_note, exhaust_path, draft_path
+ → exhaust_decision: enum(continue, accept, rebuild)  # 人的裁决:continue=继续修,下一圈以全新修检额度接着盘上草稿修;accept=接受现状交终审（剩余缺陷清单写进审阅文件修检遗留节,随终审呈裁）;rebuild=放弃本轮产物,走整树重建

呈 exhaust_note（纲要——完整现场按 exhaust_path 打开看:改善对比行+当前产物全文+最后工单+历轮简史+评估意见）。问人：修检额度已用完,当前产物还有上述剩余缺陷。选 continue=再开一轮修检额度接着修（草稿现场原地保留,新一圈重新体检、重新出工单——适合"明明在收敛只是额度不够"的局面,现场文件开头的改善对比行就是判断依据）;选 accept=带着这些缺陷交作者终审（剩余缺陷清单会写进终审审阅文件的修检遗留节,终审时一并裁）;选 rebuild=作废本轮产物,整树重建再来。不急着答也行——任务停在这里等人,现场都在盘上,隔天回来接着裁也不丢。

######## 5.1.3.1.6.4. [branch] 按裁决分流

######## 5.1.3.1.6.4.1. [case(exhaust_decision == "continue")] 继续修——置圈信号,交外层循环开下一圈
######### 5.1.3.1.6.4.1.1. [act] 置圈信号
- ← exhaust_decision
+ → qc_outcome: line  # 圈信号置 "continue"——外层循环圈末分流看它决定不出圈
> ```hop_python
> qc_outcome = "continue"
> ```

######## 5.1.3.1.6.4.2. [case(exhaust_decision == "accept")] 接受现状——当前草稿升格为终稿
######### 5.1.3.1.6.4.2.1. [act] 读回当前草稿作终稿,剩余缺陷写进修检遗留
- ← draft_path, exhaust_brief, exhaust_path
+ → spec_text: text  # 终稿全文（带已知剩余缺陷,清单随审阅文件修检遗留节呈终审）
+ → sensible_note: text  # 修检遗留呈审内容（人裁接受现状说明+烧尽现场判断件全文+现场文件路径——5.1.4 拼进审阅文件修检遗留节;本路径上合理关每轮判 false,引擎不写它的说明槽,必须在这里赋值,否则审阅文件渲染出字面 undefined）
+ → qc_outcome: line  # 圈信号置 "accept"——出圈交终审
> ```hop_python
> spec_text = read(path: draft_path)
> sensible_note = "人裁接受现状：修检额度耗尽,带以下剩余缺陷升格终审（草稿全文与完整现场见 " + exhaust_path + "）\n\n" + exhaust_brief
> qc_outcome = "accept"
> ```

######## 5.1.3.1.6.4.3. [case(else)] 放弃——本兜底块以失败收场,失败照旧上浮交外层重建
######### 5.1.3.1.6.4.3.1. [act] 置整树构建指令（人裁重建——上浮重试的那一圈必须走构建路,防被残留的定向修指令带偏）
- ← exhaust_decision
+ → build_directive: line  # 置 "build"
> ```hop_python
> build_directive = "build"
> ```
######### 5.1.3.1.6.4.3.2. [check] 按人的裁决放弃:机械判失败,让修错事务的失败沿原路上浮
- ← exhaust_decision
+ → rebuild_ok: bool  # 判定槽（恒 false——人裁了 rebuild,本兜底块以失败收场）
+ → rebuild_note: text  # 说明槽
> 机械编码人的裁决:兜底块自身失败不再兜、照旧上浮（on fail 既有语义）——修错事务失败上浮后,外层循环不拦失败,再上浮到意见轮事务按既有升级路径整树重建。
> ```hop_python
> rebuild_ok = false
> rebuild_note = "人裁 rebuild:放弃本轮产物,交外层重建（额度烧尽现场见 exhaust-report.md）"
> ```

###### 5.1.3.2. [branch] 圈末分流：人裁"继续修"进下一圈,其余出循环
####### 5.1.3.2.1. [case(qc_outcome == "continue")] 继续修——复位圈信号,让循环开下一圈
######## 5.1.3.2.1.1. [act] 复位圈信号
- ← qc_outcome
+ → qc_outcome: line  # 复位回 "init"——不复位的话下一圈修检通过后本分流还会误判"继续修",永不出圈
> ```hop_python
> qc_outcome = "init"
> ```

####### 5.1.3.2.2. [case(else)] 修检有果（通过或接受现状）——出循环,交 5.1.4 终审备料
######## 5.1.3.2.2.1. [break]

##### 5.1.4. [act] 组装审阅文件（终审备料）
- ← spec_text, tier, log_text, sensible_note
+ → review_path: line  # 涂鸦区审阅文件绝对路径（固定名 review.md）
+ → review_note: text  # 审阅纲要（短文本:档位/研判点条数/review_path——终审呈它,人按路径开文件审）

盘上引用汇编,body 由引擎直接执行、不经 LLM（log_text 已由构建路支路 5.1.2.2.1.3 拼接落盘读好（定向修圈由 5.1.2.1.1 自传递在场））：
> ```hop_python
> write(path: work_zone_path("review.md"), content: "# 审阅\n\n档位: " + tier + "\n\n## spec 全文\n\n" + spec_text + "\n\n## 研判点台账\n\n" + log_text + "\n\n## 修检遗留（放行残留与最后一轮过账;人裁接受现状时为剩余缺陷清单;空=修检干净通过）\n\n" + sensible_note)
> review_path = work_zone_path("review.md")
> review_note = "档位:" + tier + " | 研判点:" + str(len([l for l in split(log_text, "\n") if l])) + " | 审阅文件:" + review_path
> ```

##### 5.1.5. [ask require_human=true present_inputs=review_note] 作者终审收意见（审阅走文件）
- ← review_note, review_path
+ → author_feedback: text  # 作者终审意见原话回填;审阅通过则置空

呈现 review_note（纲要——审阅载荷走文件不内联终端,人按 review_path 打开:spec 全文+研判点台账〔新增决策点终裁:暂采答案对不对、该落 ask/confirm 的有无漏、mixed 档的未尽原子接不接受〕）。通过 → 置空;有修订意见 → 原话记入。


##### 5.1.6. [reason] 意见分诊：按意见指向定路由,不改写意见
- ← author_feedback, header_final
+ → review_outcome: line  # 圈信号（"approved"/"revise"/"out_of_scope"）
+ → build_directive: line  # 下一圈构建路由（"fix"/"build";approved/out_of_scope 无下一圈,置 "build" 即可）
+ → pending_feedback: text  # 待消化意见（=author_feedback 原话不改写;意见为空时置空串）

分诊判据四档（只定路由——意见原话恒进 pending_feedback,消化在下一圈）：
- **意见为空** → review_outcome="approved",build_directive="build",pending_feedback=""——放行,出圈过闸;
- **意见指向产物文本可修的局部点**（补步骤/换执行形态/改措辞/加输入声明/修变量链这类——用定向编辑就落实得了）→ review_outcome="revise",build_directive="fix",pending_feedback=意见原话——下一圈沿用现稿,质检环修错步按意见定向修,改完自然重走合法关+合理关+终审,把关一道不少;
- **意见指向整段拆法**（某段整体重拆/推翻分拆策略/新增大环节——产物文本上修不动,须分拆器重来）→ review_outcome="revise",build_directive="build",pending_feedback=意见原话——下一圈整树构建,意见经任务书组装步拼进 effective_task 交分拆器;
- **意见指向头部契约**（目标/交付物/业务输入/工具面——对齐门定稿冻结,本流程无权改）→ review_outcome="out_of_scope",build_directive="build",pending_feedback=意见原话——超修复范围,出圈由意见闸如实判败,人按意见重发起。
拿不准局部还是结构时倾向 fix——修错步修不动会经质检失败路径自然升级,选错 build 则白烧一次整树重建（小时级）不可逆。

##### 5.1.7. [on fail] 意见轮耗尽兜底：呈现场问人,不自动判死

###### 5.1.7.1. [reason] 耗尽现场判断件（判断归本步,草稿全文与写盘归下一步 body——act free 教 work_zone_path 取不到路径、几万字草稿亲手转写必撞输出上限,两病一并治）
+ → wornout_brief: text  # 现场判断件（机械死因简史+评估意见——原料全部来自重试反馈,草稿全文与意见原话由组装步拼变量）
+ → wornout_headline: line  # 纲要短句（耗尽原因一句话/当前产物状态——组装步拼上文件路径后呈人）

意见轮事务的机械重试额度（构建崩溃/质检耗尽人裁重建,3 次）用完了。原料就是本步收到的重试反馈,零工具需求。wornout_brief 两段成文：③本轮机械死因简史（从重试反馈整理,一轮一行）;④你的评估意见——产物离可交付还差多远、再开一轮的胜算如何、还是该接受现状或放弃。（①当前草稿全文与②待消化意见原话由下一步 body 直接拼变量,不经你转写。）

###### 5.1.7.2. [act] 机械组装耗尽现场文件（body 引擎直执——草稿全文与意见原话直接拼变量,零 LLM 转写）
- ← draft_path, pending_feedback, wornout_brief, wornout_headline
+ → wornout_path: line  # 现场文件绝对路径（work_zone 下固定名 review-exhaust.md）
+ → wornout_note: text  # 呈人纲要（短文本:纲要短句+文件路径——问人时呈它,现场载荷走文件不内联终端）

exists 返回 JSON 文本,parse_json 取 .exists 才能当条件（4.1 同款,草稿读不到如实拼"草稿缺失";意见为空如实拼"无未消化意见"）：
> ```hop_python
> probe_exists = parse_json(exists(path: draft_path)).exists if draft_path else false
> draft_body = read(path: draft_path) if probe_exists else "（草稿缺失——构建环未产出草稿即耗尽时 draft_path 为空,exists 不吃空路径,先判值再探盘）"
> fb_body = pending_feedback if pending_feedback else "无未消化意见"
> write(path: work_zone_path("review-exhaust.md"), content: wornout_brief + "\n\n## 待消化的终审意见原话\n\n" + fb_body + "\n\n## 当前草稿全文\n\n" + draft_body)
> wornout_path = work_zone_path("review-exhaust.md")
> wornout_note = wornout_headline + " | 现场文件:" + wornout_path
> ```

###### 5.1.7.3. [ask require_human present_inputs=wornout_note] 意见轮机械额度用完,问人怎么办
- ← wornout_note, wornout_path, draft_path
+ → wornout_decision: enum(continue, accept, abandon)  # 人的裁决:continue=再开一轮（循环新圈,机械额度全新重置,接着盘上现场干）;accept=接受现状交付（当前草稿升格终稿,剩余问题记档）;abandon=放弃,任务失败终结

呈 wornout_note（纲要——完整现场按 wornout_path 打开看:当前草稿+未消化意见+死因简史+评估意见）。问人：意见轮的机械重试额度已用完。选 continue=再开一轮（额度全新重置）;选 accept=带着现状交付;选 abandon=任务失败终结。不急着答也行——任务停在这里等人,现场都在盘上,隔天回来接着裁也不丢。

###### 5.1.7.4. [branch] 按裁决分流

####### 5.1.7.4.1. [case(wornout_decision == "continue")] 再开一轮——置圈信号,循环新圈自动重置机械额度（新迭代=全新事务,引擎既有语义零改动）
######## 5.1.7.4.1.1. [act] 置续圈信号
- ← wornout_decision
+ → review_outcome: line  # 置 "revise"——圈末分流见它不出圈,循环开下一圈
> ```hop_python
> review_outcome = "revise"
> ```

####### 5.1.7.4.2. [case(wornout_decision == "accept")] 接受现状——当前草稿升格为终稿
######## 5.1.7.4.2.1. [act] 读回当前草稿作终稿,剩余问题记档
- ← draft_path
+ → spec_text: text  # 终稿全文（带已知剩余问题,现场文件有档）
+ → review_outcome: line  # 置 "accepted"——出圈,意见闸对 accepted 放行
> ```hop_python
> spec_text = read(path: draft_path)
> review_outcome = "accepted"
> ```

####### 5.1.7.4.3. [case(else)] 放弃——兜底自身失败照旧上浮,任务终结
######## 5.1.7.4.3.1. [check] 按人的裁决放弃:机械判失败
- ← wornout_decision
+ → giveup_ok: bool  # 判定槽（恒 false——人裁了放弃,兜底以失败收场）
+ → giveup_note: text  # 说明槽
> 机械编码人的裁决:on fail 兜底自身失败不再兜、照旧上浮——外层循环不拦失败,任务以失败终结（现场文件留盘可查）。
> ```hop_python
> giveup_ok = false
> giveup_note = "人裁 abandon:放弃交付,任务终结（耗尽现场见 review-exhaust.md）"
> ```

#### 5.2. [branch] 圈末分流：有修订意见（或人裁再来一轮）进下一圈,其余出循环
##### 5.2.1. [case(review_outcome == "revise")] 续圈——复位圈信号,让循环开下一圈
###### 5.2.1.1. [act] 复位圈信号
- ← review_outcome
+ → review_outcome: line  # 复位回 "init"——不复位的话下一圈的分流会拿着旧信号误判
> ```hop_python
> review_outcome = "init"
> ```

##### 5.2.2. [case(else)] 意见轮有果（放行/接受/超范围）——出循环,交意见闸裁决
###### 5.2.2.1. [break]

### 6. [subtask] 意见闸（出圈才过闸——把关不拆只挪位,仍站在交付 commit 之前）
- ← review_outcome, pending_feedback
+ → approved: bool  # 闸判定（聚合输出）

#### 6.1. [check final] 意见闸：终审放行或人裁接受才许交付
- ← review_outcome, pending_feedback
+ → approved: bool  # 判定槽
+ → final_note: text  # 说明槽

机械闸,body 引擎直执零 LLM（放行两态=终审意见为空 approved / 耗尽人裁接受 accepted;其余如实判败——out_of_scope=意见指向头部契约,人按意见重发起;revise=十轮意见都没收敛）：
> ```hop_python
> approved = review_outcome == "approved" or review_outcome == "accepted"
> final_note = "" if approved else "意见轮未收敛终态: " + review_outcome + ("" if len(pending_feedback) == 0 else " | 未消化意见: " + pending_feedback)
> ```

### 7. [commit] 写盘交付 spec 与构建基准副本
- ← spec_text, skill_path, ref_assets
+ → generated_spec_path: line  # 最终写盘路径（body 纯计算产出）

交付写盘,body 引擎直执零 LLM（把关在前:终审真人已审+意见闸放行+合理关指针闭合核已过）。**同名旧文件先备份再覆盖**：spec.md/source.md 目标位已有旧版时,先 move 成带时间戳的 .bak 留原目录再写新版——旧版可能被用户改过或正被引用,直接覆盖=替用户销毁其资产;交付说明点名备份文件名。**随包清单落盘**:参考性附属清单写 assets-manifest.txt 随 spec 同目录——pack 分发按它逐件带走。**对齐口径落盘**:对齐门历轮修订意见由 4.5 累积在 work_zone 口径日志（alignment-feedback-log.txt——放行时对齐门意见变量恒空,变量通道拿不到历轮意见,故走文件通道）,交付时该文件在场即把内容 append 到 skill 目录 alignment-notes.md——人拍过的板落成语料包资产,下轮构建步骤 2 恒判流程性读入,复犯即在对齐门自曝;日志缺席（一次过审零意见）不落盘不造空文件。**交付自包含**：source.md=构建基准纯副本（本体+流程性与混合附属同序拼接——终审与日后对读的物理基准,行号与构建期全局号同一套）;参考性附属（ref_assets 清单）产物落原 skill 目录时天然在场,pack 分发时按清单逐件带走——spec 步骤正文引用的每个包内路径交付目录里必须真有那个文件。落位规则:产物恒落输入文件同目录的 spec.md 与 source.md（目录级成套,**不依赖输入文件名**——原形态 replace(skill_path,"SKILL.md",...) 写死输入名假设,输入不叫 SKILL.md 时 replace 不命中,spec 与 source 落同一路径且 source 后写,成品 spec 被覆盖丢失;场景卡 0033 实测输入 topic-research-skill.md 实撞,产物全程只在 work_zone 抢救回）：
> ```hop_python
> parts = split(skill_path, "/")
> n = len(parts) - 1
> skill_dir = join([parts[i] for i in range(n)], "/")
> prefix = skill_dir + "/" if skill_dir else ""
> generated_spec_path = prefix + "spec.md"
> stamp = replace(replace(str(now()), ":", ""), " ", "-")
> spec_probe = parse_json(exists(path: generated_spec_path))
> spec_bak = generated_spec_path + ".bak." + stamp if spec_probe.exists else ""
> moved1 = move(from: generated_spec_path, to: spec_bak) if spec_probe.exists else ""
> write(path: generated_spec_path, content: spec_text)
> src_dest = prefix + "source.md"
> src_probe = parse_json(exists(path: src_dest))
> src_bak = src_dest + ".bak." + stamp if src_probe.exists else ""
> moved2 = move(from: src_dest, to: src_bak) if src_probe.exists else ""
> source_copy = read(path: work_zone_path("source.md"))
> write(path: src_dest, content: source_copy)
> manifest = join(ref_assets, "\n") if ref_assets else "（零参考性附属）"
> write(path: prefix + "assets-manifest.txt", content: manifest)
> fb_probe = parse_json(exists(path: work_zone_path("alignment-feedback-log.txt")))
> fb_log = read(path: work_zone_path("alignment-feedback-log.txt")) if fb_probe.exists else ""
> appended = append(path: prefix + "alignment-notes.md", content: fb_log) if strip(fb_log) else ""
> ```

### 8. [exit] 交付翻译结果

返回 generated_spec_path 与 tier。
