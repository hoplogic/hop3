# Spec: 文档事实核查与推演审查
<!-- 改本文件的能力面(步骤/词表/交付)需同步 examples/README.md 对应行——README 已两次滞后实撞 -->
标识: hop-fact-check

## 任务

目标: 从文档提取所有事实点与推演点，逐条核查——事实点搜索外部依据并对来源可信度打标，推演点做前提溯源+推理有效性审查，汇聚成核查报告
> 读文档 → 提取事实点(可查证断言)+推演点(基于事实的结论)并分类 → 逐条并行核查(事实点走搜索+来源打标，推演点走前提溯源+推理审查) → 汇聚二维判定报告。

约束:
- 事实点 = 可独立查证的客观断言（数据、事件、时间、引述、因果陈述）；推演点 = 文档从事实推出的结论/预测/评价（含隐含假设）。分类以"能否直接搜到外部依据"为界。
- 来源可信度四级：authoritative（官方/学术/一手原始）/ reliable（主流媒体/行业权威二手）/ questionable（自媒体/匿名/立场性来源）/ not_found（搜不到支撑）。
- 推演有效性四级：sound（前提真且逻辑严密）/ mostly（大体成立、小跳跃）/ leap（有明显逻辑跳转或隐藏假设）/ invalid（前提不成立或推理谬误）。
- 每条核查须标注证据来源（URL 或出处），不得凭记忆断言；搜不到就标 not_found，不编造。
- 推演点核查是二维判定：前提可信度 × 推理有效性——两者皆高才可信；前提真但推理跳=结论存疑；前提假=结论不成立。

类型:
- CheckPoint:  # 一个待核查点
  - id: line  # 点编号（P1/P2…）
  - type: line  # fact（事实点）或 inference（推演点）
  - line_ref: line  # 断言在带行号分析物中的位置（如 L23 或 L23-L25）——照抄行号前缀，不自数
  - quote: text  # 断言的原文片段摘抄（一两句为限）——与 line_ref 互相印证，报告离开原文也可读
  - claim: text  # 待核查的断言，从 quote 提炼成中性、可独立检索的一句话——掐掉口语和修辞（"根本不算事"没法搜），补全省略的主语宾语（脱离上下文单看也知道在说什么）；后续搜索关键词、报告表格都用它。与 quote 的分工见步骤 2.3 示例
  - premises: text  # 推演点专用；fact 点留空。该结论依赖的事实前提，每个前提把内容写全、不能只写编号——完整正反示例见步骤 2.3

- Evidence:  # 一条外部依据（检索步的产出单元——来源可信度在检索时当场标，判定步直接消费等级）
  - source: line  # 来源名称——网站/机构/媒体名（从检索结果条目的 hostname/标题取，如 "FDA 官网"/"新华网"/"百度百科"）
  - url: line  # 来源链接——照抄检索结果条目的 URL，禁编造禁凭记忆补
  - tier: enum(authoritative,reliable,questionable)  # 来源可信度——看到条目当场按域名/机构身份标：官网/政府/学术库/一手统计 authoritative；主流媒体/行业权威二手 reliable；自媒体/百科/匿名/立场性 questionable。词表与 examples/hop-deep-research 选源 tier 同一套——改一处须同步改彼处
  - summary: text  # 该来源说了什么（与断言/前提的关系：支持什么、反驳什么、口径差异在哪）
  - about: text  # 本条依据针对的对象——事实点路径留空；前提溯源路径写对应前提的凝练（一条依据挂一个前提）

- CheckResult:  # 单点核查结论（4.1 各 worker 的统一产出结构——等级字段 enum 引擎强制校验，写错级别当场打回）
  - id: line  # 对应 CheckPoint.id（照抄）
  - line_ref: line  # 照抄本点字段——汇总表"位置"列直取
  - claim: text  # 照抄本点断言（报告表格直取，免回查）
  - verdict: enum(supported,partially_supported,refuted,no_evidence)  # 依据对断言的支持关系：支持/部分支持/反驳/无依据。推演点此字段装前提整体判定。词表与 examples/hop-deep-research VerifyResult.verdict 同一套——改一处须同步改彼处
  - credibility: enum(authoritative,reliable,questionable,not_found)  # 事实点=断言可信度（取最强支持来源等级）；推演点=前提整体可信度
  - validity: line  # 推演点专用：推理有效性 sound/mostly/leap/invalid + 谬误类型；fact 点留空
  - evidence_summary: text  # 依据摘要：逐条 来源标题+URL+一句话说明（URL 取自检索结果，禁编造）；与来源矛盾时在此写明
  - conclusion: text  # 综合结论一句话（存疑/成立/不成立及原因）

Tools:
- web_search(query) -> result: yaml  # 网页检索：查询词→结果页清单（每条含标题/URL/摘要）
  - query: text  # 检索查询词

输入:
- doc_path: line  # 待核查文档路径（.md 或纯文本）——**相对工作目录**（standalone 沙箱拒绝绝对路径;文件须在运行工作区内或先拷入）

输出:
- points: [CheckPoint]  # 核查点清单（2.4 完备性闸验收后的定稿——确认停点已撤,速览呈现代之,作者定 2026-08-27）
- factcheck_report: markdown  # 核查报告（逐点：类型/依据/来源/可信度或有效性判定）

## 步骤

### 1. [探索] 初始化完备性反馈通道
+ → extract_gap: text  # 提取完备性反馈：空=首轮/已完备，非空=上轮漏项清单（重提取据此补）
+ → report_gap: text  # 汇总完备性反馈：空=首轮/已完备，非空=上轮遗漏清单（重汇据此补）

> ```hop_python
> extract_gap = ""
> report_gap = ""
> ```

置空两个完备性反馈通道（root scope 声明，subtask 内 check/reason 读写命中同一 scope）。纯赋值零推理。

### 2. [子任务 重试=2] 提取核查点并验收完备性
- ← doc_path
+ → points: [CheckPoint]  # 提取的核查点清单（每元素 CheckPoint 六字段：id/type/line_ref/quote/claim/premises）

先读文档，穷举提取两类核查点，再自查完备性——漏项则据 extract_gap 反馈定向重提（引擎 retry 上限即轮数上限：首轮 + 2 次重试）。

#### 2.1. [探索] 读取文档并生成带行号分析物
- ← doc_path
+ → doc_content: text  # 带行号的文档全文（每行前缀 L<行号>: ——提取与核查全程用这份，点位引用照抄行号即可）
+ → doc_len: int  # 原文字数（供长度闸判定，不含行号前缀）
+ → numbered_path: line  # 带行号分析物的落盘路径（work_zone 内——报告读者对着此文件核行号）

> ```hop_python
> raw = read(path: doc_path)
> doc_len = len(raw)
> broken = replace(replace(replace(raw, "。", "。\n"), "！", "！\n"), "？", "？\n")
> broken = replace(replace(replace(broken, ". ", ".\n"), "! ", "!\n"), "? ", "?\n")
> raw_lines = [strip(seg) for seg in split(broken, "\n") if strip(seg) != ""]
> doc_content = join([f"L{i + 1}: {raw_lines[i]}" for i in range(len(raw_lines))], "\n")
> numbered_path = work_zone_path("numbered-doc.md")
> write(path: numbered_path, content: doc_content)
> ```

读原文→**先按句末标点断行**（中文。！？后补换行;英文按"句点/叹号/问号+空格"断——不带空格的 . 不动,3.5、URL 这类不误断;U.S. 这种缩写会多断一刀,无害——跨行断言本有 L23-L25 区间写法）→逐行机械编号→落盘 work_zone 作分析物。行号是分析物自己的坐标（报告对照 numbered_path,不对照原文件）;编号确定性归引擎,后续提取与核查**行号照抄不自数**。

#### 2.2. [检查] 文档长度闸
- ← doc_len
+ → len_ok: bool  # 判定槽：≤30000 字才放行提取
+ → len_msg: text  # 说明槽：超长时的分拆指引

> ```hop_python
> len_ok = doc_len <= 30000
> len_msg = "" if len_ok else f"文档 {doc_len} 字超上限 30000——请先按章节拆成多个文件分别核查，或裁剪到核心部分再跑"
> ```

带 body 的机械判定（引擎直执零 LLM）。超长判 false 拦在提取之前——昂贵的 LLM 提取步不会对超长文档白跑；重试轮也只重跑 2.1/2.2 两个零成本 body 步，耗尽后 run 以 len_msg 指引失败。

#### 2.3. [推理] 提取事实点与推演点
- ← doc_content, points, extract_gap
+ → points: [CheckPoint]  # 核查点清单（数组，每元素 CheckPoint 结构）

通读文档，穷举两类点，逐条编号（P1/P2…）：
- **事实点**（type=fact）：可独立查证的客观断言——具体数据、发生的事件、时间节点、直接引述、明确的因果陈述。claim 写断言凝练，premises 留空。
- **推演点**（type=inference）：文档从事实推出的结论/预测/评价/判断——含"因此/说明/意味着/预计/将会"等推理跳转，或未言明的隐含假设。claim 写结论，premises 写它依赖的事实前提。

**各字段怎么写——完整示例**。设编号文中有两句：

```
L23: 连 FDA 都说了，健康成人一天 400 毫克咖啡因（也就四五杯的量）根本不算事。
L24: 所以说，只要别超过四杯，谁喝都放心。
```

提取出：

```yaml
- id: P5
  type: fact
  line_ref: L23
  quote: 连 FDA 都说了，健康成人一天 400 毫克咖啡因（也就四五杯的量）根本不算事
  claim: FDA 建议健康成人每日咖啡因摄入上限为 400 毫克
  premises: ""
- id: P9
  type: inference
  line_ref: L24
  quote: 只要别超过四杯，谁喝都放心
  claim: 每天四杯以内，喝咖啡对所有人都安全
  premises: |-
    ① FDA 建议健康成人每日咖啡因上限 400 毫克（即 P5）；
    ② 400 毫克约合四到五杯咖啡（L23 括号内换算）；
    隐含假设：健康成人的上限适用于所有人
```

两字段分工：**quote 原样摘**（保留口语和修辞——它是"原文确实这么说"的凭据，读者拿它回原文对得上）；**claim 掐掉修辞提炼成可检索的中性断言**（"根本不算事"没法搜，"上限 400 毫克"能搜）。line_ref 照抄行首 L 号（跨行断言写 L23-L25）。

❌ 错误写法：`premises: P5+P6`——后续每个点由独立的执行者核查，它手里只有本点这一条，P5/P6 的内容它看不到，只写编号等于什么都没给它。✅ 正确写法如上：每个前提的**内容**写进来，编号只作附注；文档没明说的隐含假设也算前提，一并写出。

分类以"能否直接搜到外部依据"为界：能→fact，需要逻辑推理才能评判→inference。宁细勿漏，一句话含多个断言拆成多点——但**以"能独立成断言的陈述"为单位**：依附主句的括号插语、修饰成分不单独成点（如上例"约四五杯咖啡"是换算附注，不拆成点，作为推演点的前提写进 premises 即可）。输出 CheckPoint 列表（YAML 形态，如上例）。

**首轮**（points 为 None、extract_gap 空）= 全新提取；**重试轮**（points 是上轮产物、extract_gap 非空）= 在上轮 points 基础上按 extract_gap 定向补齐（补漏项、修正误分类），已对的点原样保留不推翻。

#### 2.4. [检查 终检] 验收提取完备性
- ← doc_content, points
+ → extract_ok: bool  # 判定槽：提取是否完备
+ → extract_gap: text  # 说明槽：漏项清单（通过时置空）

逐段扫 doc_content，核对 points 是否穷尽——是否有可查证断言未列为 fact、有结论/预测/评价未列为 inference、有断言被误分类、推演点前提缺失。每轮对着当前 points 独立重判，不参考上轮判词——输入里不给 extract_gap 是刻意的：判官读到自己上轮写的判词会照抄交卷，已改对的产出被原判词二次打回（真机实撞：三轮判词逐字节相同，修订全部落实仍烧尽）。

**打回门槛——只有严重问题才打回，一次列全**：严重问题=漏了可查证断言（文档里有、points 里没有）、分类错到核查路径走错（fact 标成 inference 或反之，导致后续按错误路径核查）、推演点前提缺到没法核查。**拆分方式的裁量偏好不是打回理由**——同一句话合成一点还是拆成两点，只要断言内容都被覆盖、类型不影响核查路径，两种处理都算完备（真机实撞：三轮判官对同一句话先要求合并、再要求拆分、再换第三个角度，每轮换标准永不收敛）。打回时把全部严重问题一次列全，不分批挤牙膏。

完备 → extract_ok=true、extract_gap=""；有严重问题 → extract_ok=false、extract_gap 逐条列出（触发 subtask retry，2.3 据 extract_gap 补齐重提）。

### 3. [探索] 生成核查点速览与统计
- ← points
+ → points_digest: text  # 速览：首行统计值（总数/事实/推演），后接每点一行（编号｜类型｜行号｜断言）——供 driver 展示给用户过目（信息性呈现，不阻塞执行；用户看到不对可随时中止 run）

> ```hop_python
> n_fact = count([p for p in points if p['type'] == 'fact'])
> n_inf = count([p for p in points if p['type'] == 'inference'])
> digest_lines = [f"{p['id']}｜{'事实' if p['type'] == 'fact' else '推演'}｜{p['line_ref']}｜{p['claim']}" for p in points]
> points_digest = f"共 {count(points)} 个核查点（事实 {n_fact}｜推演 {n_inf}）\n" + join(digest_lines, "\n")
> ```

机械拼速览零 LLM。设计取舍（2026-08-27 作者定"这一波让人审意义不大，先给人看一下列表和统计值就行"）：不设确认停点——提取质量已有 2.4 完备性闸把关，人工逐点确认的边际价值低而中断成本高（run 挂起等人）；速览给人**知情**而非**审批**，看到跑偏随时中止即可。

### 4. [循环 遍历 point 于 points, 收集 check_item 入 check_result] 逐点并行核查
+ → check_result: [CheckResult]  # 各点核查结论（collect 显式收集 check_item；并行乱序，条目自含 id 可归位）

对每个核查点独立核查，按类型分流（事实点/推演点核查路径不同），结果收集为列表。

#### 4.1. [子任务 重试=5 并行] 核查单个点
- ← point
+ → check_item: CheckResult  # 该点的核查结论（结构化，字段见 Types）

按 point.type 分流：事实点走"搜索→来源打标"，推演点走"前提溯源→推理审查"。

##### 4.1.1. [分支] 按点类型分流核查
- ← point
+ → check_item: CheckResult

###### 4.1.1.1. [条件] 事实点核查 (point.type == "fact")
+ → check_item: CheckResult

####### 4.1.1.1.1. [探索 开放] 搜索外部依据
- ← point
+ → evidence: [Evidence]  # 依据清单（每条自带来源名+URL——下游按来源身份打可信度标，无 URL 的条目不收）
- 工具: web_search  # 就 point.claim 检索外部依据

用 web_search 工具就 point.claim 检索至少 2 个关键词组合（每组一次调用,关键词提炼归你裁量——实体+关系词,去疑问语气;首选能命中官方/学术来源的词形,如机构名+数据名）。从返回的结果页清单**择优收集**：每条填一个 Evidence（source/url 照抄结果条目、tier 当场按域名/机构身份标、summary 该来源说了什么、about 留空）。**择优纪律**：同一信息点有 authoritative/reliable 来源就不收 questionable 重复条目；仅当高等级来源覆盖不到该断言（或与断言相关的只有低等级来源）时才收 questionable 兜底——低等级来源不是垃圾，是"仅此一家"时的如实记录。首轮全是低等级时补一次定向检索（限定官方域名/换机构名词形）再收。只收检索结果里真实存在的条目；确实搜不到则输出空列表 []，不编造。

####### 4.1.1.1.2. [探索 开放] 评估依据并对来源可信度打标
- ← point, evidence
+ → check_item: CheckResult  # 本点核查结论（id/line_ref/claim 照抄 point 对应字段）

据 evidence 判定该事实点，逐字段填 CheckResult（id/line_ref/claim 照抄 point 对应字段）：
- verdict：依据对断言的支持关系——全面支持 supported；仅部分口径/部分来源支持 partially_supported；依据与断言相反 refuted；无可用依据 no_evidence。
- credibility：断言可信度=**支持本断言各条中最强的 tier**（等级检索时已标好，直接取——发现某条 tier 明显标错可纠正并在 evidence_summary 注明）；evidence 为空列表 → not_found。
- evidence_summary：从 evidence 逐条转录"source+url+summary"（URL 照抄 Evidence 条目，禁另行编造）；refuted 时在此写明矛盾所在。
- conclusion：一句话综合（如"成立，权威口径一致"/"存疑：与 ICO 官方口径矛盾"）。validity 留空。

**信源不足时可补搜**（触发从手头 evidence 自判：各来源口径打架，或支撑关键断言的条目全是 questionable）。补搜怎么搜：
- **查询词冲着能解决问题的信源构造**：几个来源数据打架时，直接搜发布这个数据的权威机构（如 "ICO 咖啡消费量 2023 统计"——拿一手数据判谁对谁错）；手头只有自媒体、百科这类低等级来源时，把断言里的口语说法换成正式名称再搜一次——比如断言说"咖啡因摄入上限"，就搜 "FDA 咖啡因 每日建议摄入量"：机构的官方名、报告的正式标题、领域的标准术语，都比口语词更容易命中官网和学术库；
- **每个缺口至多 2 次调用**：第一次不中，第二次换信源方向（换机构名/换语种——中文断言可搜英文原始机构），仍不中就接受现状定级，不无底洞；
- **补搜所得怎么收**：每条按 Evidence 的填法收——source/url 照抄检索结果条目（禁编造）、tier 当场按域名/机构身份标（口径见 Evidence 类型的 tier 注释）、已有高等级命中就不再收低等级重复条目；收好的条目转录进 evidence_summary（source+url+summary），据合并后的全部依据定级。
补搜不是必经步骤，依据已充分时直接判。

###### 4.1.1.2. [条件] 推演点核查 (point.type == "inference")
+ → check_item: CheckResult

####### 4.1.1.2.1. [探索 开放] 前提溯源搜索
- ← point
+ → premise_evidence: [Evidence]  # 各前提的依据清单（每条自带来源名+URL，about=挂靠的前提——下游按来源身份判前提可信度）
- 工具: web_search  # 逐个前提检索依据来源

就 point.premises（该推演依赖的事实前提）用 web_search 工具逐个前提检索，**每条依据填一个 Evidence**：about=该依据对应的前提凝练（一条挂一个前提）、source/url 照抄结果条目（禁编造）、tier 当场按域名/机构身份标、summary=该来源对此前提说了什么。**择优纪律**：优先收 authoritative/reliable，questionable 仅作"高等级覆盖不到"时的兜底（低等级来源不是垃圾，是"仅此一家"时的如实记录）；首轮全低等级补一次定向检索（限定官方域名/换机构名词形）。某前提确实搜不到依据就不为它产条目（下游按"该前提零条目"判 not_found）。不核查推理本身，只核前提真假。

####### 4.1.1.2.2. [探索 开放] 推理审查与二维判定
- ← point, premise_evidence
+ → check_item: CheckResult  # 二维判定装入结构（verdict/credibility=前提维,validity=推理维）

二维评估该推演点，逐字段填 CheckResult（id/line_ref/claim 照抄 point 对应字段）：
- **维度一·前提**：按 about 把 premise_evidence 分组到各前提，逐前提取其条目中最强的 tier（等级检索时已标好；标错可纠正并注明），零条目的前提计 not_found；verdict 装前提整体被支持的程度（supported/partially_supported/refuted/no_evidence），credibility 装各前提的最强等级中最弱的一档（前提链的强度由最弱前提决定）。
- **维度二·推理（validity 字段）**：**假设前提全为真**（前提真假归维度一，这里只审"推得出推不出"），按下面方法审查：
  1. **摆链**：把推理写成"前提 → (隐含假设) → 结论"的显式链条——隐含假设是文档没写但结论成立所必需的命题（如"健康成人的上限适用于所有人"），**每个隐含假设都是链上一环，须逐个挖出摆上台面**；
  2. **逐跳审**：链上每一跳问"前件为真时后件必然/大概率成立吗"，重点核对四类常见跳跃——
     - **范围偷换**：前提限定的人群/时间/条件在结论里被扩大（"健康成人"→"所有人"、"未列入致癌清单"→"安全"）；
     - **程度拔高**：从"无害/未证伪"跳到"有益/已证实"——缺失正向证据的环节；
     - **因果误置**：相关当因果、时序当因果、因果倒置、遗漏共同原因；
     - **以偏概全族**：个例/单来源推普遍结论、幸存者偏差、滑坡推演；
  3. **定级**：全链每跳都成立 → sound；仅措辞简化/近似换算这类无害小跳 → mostly；有明显跳跃或依赖未证实的隐含假设 → leap；某跳依赖的假设为假、或存在确定谬误 → invalid。**分界锚**：mostly 与 leap 的界=补上跳跃后结论是否基本不变（不变=mostly，变=leap）；leap 与 invalid 的界=隐含假设是"未证实"还是"已知为假"。
  4. validity 字段格式：`等级：谬误类型清单`（如 "leap：范围偷换（健康成人→所有人）+程度拔高（无害→有益）"）；sound/mostly 也要写一句链条摘要（审过的凭据，不是空标）。
- evidence_summary：从 premise_evidence 逐前提转录"前提｜source+url+summary"（URL 照抄条目，禁另行编造）。
- conclusion：按二维组合下结论——前提可信 × sound → 成立；前提真 × leap/invalid → 存疑（指出跳在哪）；前提不成立 → 不成立。

**信源不足时可补搜**（触发：某前提零条目，或仅有低等级来源、不足以判该前提真假）。补搜怎么搜：
- **查询词从前提文本提炼**：取前提里的实体+数据/关系词（premises 已自含前提原文，直接用它组词，去疑问语气）；首选官方词形——前提提到机构就搜"机构名+数据项"，提到研究结论就搜学术术语/报告名；
- **每前提至多 2 次调用**：第一次不中，第二次换方向（换机构名/换语种搜原始出处），仍不中就让该前提维持 not_found，不无底洞；
- **补搜所得怎么收**：每条按 Evidence 的填法收——source/url 照抄检索结果条目（禁编造）、tier 当场按域名/机构身份标（口径见 Evidence 类型的 tier 注释）、about 挂上该前提、已有高等级命中就不再收低等级重复条目；转录进 evidence_summary（前提｜source+url+summary）后再判维度一。
推理审查（维度二）不需要信源——它是"假设前提为真"的纯逻辑审查，补搜别花在这。

### 5. [子任务 重试=2] 汇聚核查报告并验收完备性
- ← check_result, points
+ → factcheck_report: markdown  # 核查报告

汇聚所有核查结论成报告，再自查完备性——漏点/漏结论则据 report_gap 反馈定向重汇（引擎 retry 上限即轮数上限：首轮 + 2 次重试）。

#### 5.1. [推理] 汇聚核查报告
- ← check_result, points, factcheck_report, report_gap, numbered_path
+ → factcheck_report: markdown  # 核查报告

不做新核查。汇总 check_result 列表全部结论，生成 Markdown 报告。**排版铁律：表格单元格只放短值（编号/行号/等级词/十来个字的短语），成句的解释一律放散文或列表——一格塞三行长句的表没人读得动。结论先行：读者最关心"哪里有问题"，问题放最前，依据明细放最后**。四节结构：

- ① **总评与问题清单**（开门见山）：先一段总评散文（整体可靠性、几个点成立、几个点有问题；有未能核查点时注明覆盖率）。接着按严重度降序逐条列问题点（questionable/not_found/refuted/leap/invalid 的点），每条一个小标题 `P编号（行号）——问题定性`，下面两三句散文：原文断言是什么、问题在哪、关键依据一句（含来源名）。没问题点就写"未发现问题"。
- ② **全点判定一览**：一张紧凑表 `| 编号 | 行号 | 断言 | 判定 | 等级 |`——断言超过 30 字截断加省略号（全文在③和行号对照文件里）；判定=verdict 中文短词（成立/部分成立/不成立/无依据）；等级=事实点填 credibility、推演点填 validity 的等级词。每格一行内读完，不放解释。
- ③ **依据明细**：每点一个小节（`### P编号 断言全文`），先一行判定结论（verdict+等级+conclusion），推演点加一行推理链摘要（validity 内容）；然后依据逐条列表，每条一行 `- 来源名（tier）：一句话说了什么 — URL`。这一节是查证入口，读者按需翻，不追求短。
- ④ **未能核查的点**（仅在有时）：points 里有、check_result 里没有对应结论的点（并行核查重试耗尽的失败点）——逐个列编号+断言+"核查未完成"。**如实交代即算完备**，不猜测其结论。

报告头注明"行号对照文件：{numbered_path}"。

**首轮**（factcheck_report 为 None、report_gap 空）= 全新汇聚；**重试轮**（factcheck_report 是上轮产物、report_gap 非空）= 在上轮报告基础上按 report_gap 补齐（补漏点、修错列），已对内容原样保留不推翻。

#### 5.2. [探索] 机械核对存在性与降级项
- ← points, check_result, factcheck_report
+ → missing_in_report: text  # 有核查结论但报告漏汇的点编号（真漏汇——重汇能修）
+ → unchecked_ids: text  # 无核查结论的点编号（核查失败——重汇不可能补出结论,只能如实交代）
+ → flagged_items: text  # 被降级/存疑的结论清单（供后继 LLM 审合理性）

> ```hop_python
> all_ids = [p["id"] for p in points]
> checked_ids = [r["id"] for r in check_result]
> missing_in_report = join([pid for pid in checked_ids if not (pid in factcheck_report)], ", ")
> unchecked_ids = join([pid for pid in all_ids if not (pid in checked_ids)], ", ")
> flagged = [r for r in check_result if r["credibility"] == "questionable" or r["credibility"] == "not_found" or r["verdict"] == "refuted" or "leap" in r["validity"] or "invalid" in r["validity"]]
> flagged_items = join([f"{r['id']}｜verdict={r['verdict']}｜credibility={r['credibility']}｜validity={r['validity']}｜{r['conclusion']}" for r in flagged], "\n")
> ```

真机械核对（hop_python body 引擎直执，**遍历完整性归程序不归 LLM 记忆**）。CheckResult 结构化后检出全部走**字段直读**——原"questionable 是否在文本里"的子串匹配（散文里顺带提一句'并非 questionable'也会被捞进）随结构化退役，等级判定即字段等值。缺失分两类是关键：**missing_in_report**（有结论、报告没写——重汇可修）与 **unchecked_ids**（无结论——核查失败点，重汇变不出结论，只要求报告"未能核查"节如实列出）。混为一谈会让完备性闸索要不可能的东西，重试烧光后整个 run 报废在最后一步。

#### 5.3. [推理] 审查降级项的合理性
- ← flagged_items, check_result, points
+ → downgrade_review: text  # 逐个降级项的合理性复核结论

逐一审查 flagged_items 里每个被降级/存疑的结论（每行=编号+verdict/credibility/validity+结论；需看完整依据时按编号回 check_result 取该条 evidence_summary）——降级是否合理：
- 判断降级判定站得住吗（如标 not_found 是否确实搜过、标 questionable 的来源是否真属立场性、判 leap 的推理跳转是否确有其事）。
- 逐条给复核结论：**降级合理**（维持）或 **降级过苛/误判**（指出应上调，并说明理由）。

输出逐点复核清单（含 point.id、原降级、复核结论）。flagged_items 为空则记"无降级项"。

#### 5.4. [检查 终检] 验收汇总完备性
- ← missing_in_report, unchecked_ids, downgrade_review, factcheck_report, points
+ → report_ok: bool  # 判定槽：汇总是否完备
+ → report_gap: text  # 说明槽：遗漏清单（通过时置空）

综合判定报告完备性（两类缺失 doctrine 与 examples/hop-deep-research 10.2 是同一条规矩的两处落点——改这边须同步看彼处）：① **missing_in_report 必须为空**（有结论却漏汇=真漏，重汇可修）；② **unchecked_ids 非空时报告须有"未能核查的点"节且逐个列出**（如实交代即完备——不要求变出不存在的结论）；③ downgrade_review 中标为"误判/过苛"的降级项须已在报告体现（未体现=汇总失真）；④ 概览统计数与表格实际条数一致；⑤ 所有问题点都进了问题清单。

全部满足 → report_ok=true、report_gap=""；否则 → report_ok=false，report_gap 逐条列出缺项（漏汇编号/未交代的失败点/失真项，触发 subtask retry，5.1 据 report_gap 补齐重汇）。每轮对着当前报告独立重判，不参考上轮判词——输入里不给 report_gap 与 2.4 同一条规矩（判官读到自己上轮判词会照抄交卷）。打回门槛也同 2.4：只有上列①-⑤的实质缺失才打回且一次列全，行文措辞、排版形态的裁量偏好不是打回理由。

### 6. [结束] 交付核查结果
