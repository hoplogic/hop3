# Spec: 文档事实核查与推演审查
<!-- 改本文件的能力面(步骤/词表/交付)需同步 examples/README.md 对应行——README 已两次滞后实撞 -->
<!-- 【模型变体】源母本=examples/hop-fact-check.md;生成 2026-09-29(手工降档);目标 profile=qwen-flash。降档动作两处:
     ①检索与核验机械化(4.1.1.x):母本让模型在 act free 步自己调 web_search 再交出 title/url、之后按标题重搜核验。qwen-flash 实测两个病:开思考时认定"工具是模拟的"不调工具直接编(首发调工具 14/36);按标题重搜核验把真证据误剔(to-fc-s 实跑 8 条被剔依据全在检索步自己的检索结果里——检索服务对同一标题两次返回不同结果页)。变体改成:模型只拟检索词→程序逐条检索并给结果编号→模型只按编号挑选并打可信度→程序按编号照抄标题/URL/来源。模型碰不到 URL,编造与误剔同时消失,核验步随之撤掉;
     ②报告机械化(5.x):照 examples/hop-fact-check.qwen3.8-27b.md 的 5.x——一览表/依据明细由程序拼,模型只写总评;逐点结论里的 id/line_ref/claim 由程序从核查点照抄(母本实跑 qwen-flash 把"燧原"写成"燕原"并传进报告全篇)。
     母本改动后本变体须重新生成 -->
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
  - id % line  # 点编号（P1/P2…）
  - type % line  # fact（事实点）或 inference（推演点）
  - line_ref % line  # 断言在带行号分析物中的位置（如 L23 或 L23-L25）——照抄行号前缀，不自数
  - quote % text  # 断言的原文片段摘抄（一两句为限）——与 line_ref 互相印证，报告离开原文也可读
  - claim % text  # 待核查的断言，从 quote 提炼成中性、可独立检索的一句话——掐掉口语和修辞（"根本不算事"没法搜），补全省略的主语宾语（脱离上下文单看也知道在说什么）；后续搜索关键词、报告表格都用它。与 quote 的分工见步骤 2.3 示例
  - premises % text  # 推演点专用；fact 点留空。该结论依赖的事实前提，每个前提把内容写全、不能只写编号——完整正反示例见步骤 2.3

- SearchQuery:  # 一条检索词（模型拟定，程序照着检索）
  - about % text  # 这条检索词针对的对象——事实点路径留空；前提溯源路径写对应前提的凝练
  - query % line  # 检索查询词（实体+关系词，去疑问语气）

- Candidate:  # 一条候选检索结果（程序从 web_search 返回的结果页清单里逐条取出并编号——标题、链接、来源名都是检索服务原文，没经过模型）
  - no % line  # 候选编号（C1/C2…，本核查点内唯一）
  - about % text  # 产出这条结果的检索词针对的对象（从 SearchQuery.about 带过来）
  - title % line  # 页面标题（检索结果原文）
  - url % line  # 页面链接（检索结果原文）
  - source % line  # 来源名（检索结果的 hostname 字段原文，如"第一财经网""百度百科"）
  - snippet % text  # 结果摘要（检索结果原文，截前 300 字）

- Pick:  # 模型从候选清单里挑中的一条依据
  - no % line  # 挑中的候选编号，照抄候选清单里的 no（如 C3）
  - tier % enum(authoritative,reliable,questionable)  # 来源可信度——按域名/机构身份标：官网/政府/学术库/一手统计 authoritative；主流媒体/行业权威二手 reliable；自媒体/百科/匿名/立场性 questionable。词表与 examples/hop-deep-research 选源 tier 同一套——改一处须同步改彼处
  - summary % text  # 该来源说了什么（与断言/前提的关系：支持什么、反驳什么、口径差异在哪）

- Evidence:  # 一条外部依据（程序按 Pick 的编号从候选清单照抄 source/title/url/about，tier 与 summary 取自 Pick）
  - source % line  # 来源名称（候选条目原文）
  - title % line  # 页面标题（候选条目原文）
  - url % line  # 来源链接（候选条目原文）
  - tier % enum(authoritative,reliable,questionable)  # 来源可信度（取自 Pick）
  - summary % text  # 该来源说了什么（取自 Pick）
  - about % text  # 本条依据针对的对象——事实点路径为空；前提溯源路径是对应前提的凝练

- Judgement:  # 模型对一个核查点的判定（程序再把它和核查点字段、依据清单拼成 CheckResult）
  - verdict % enum(supported,partially_supported,refuted,no_evidence)  # 依据对断言的支持关系（推演点装前提整体判定）
  - credibility % enum(authoritative,reliable,questionable,not_found)  # 事实点=断言可信度（取最强支持来源等级）；推演点=前提整体可信度
  - validity % line  # 推演点专用：推理有效性 sound/mostly/leap/invalid + 谬误类型；事实点留空
  - conclusion % text  # 综合结论一句话（存疑/成立/不成立及原因）
  - remark % text  # 补充说明：来源之间口径打架、依据与断言矛盾、tier 标错纠正等写在这里；没有就留空

- CheckResult:  # 单点核查结论（4.1 各 worker 的统一产出结构——等级字段 enum 引擎强制校验，写错级别当场打回）
  - id % line  # 对应 CheckPoint.id（照抄）
  - line_ref % line  # 照抄本点字段——汇总表"位置"列直取
  - claim % text  # 照抄本点断言（报告表格直取，免回查）
  - verdict % enum(supported,partially_supported,refuted,no_evidence)  # 依据对断言的支持关系：支持/部分支持/反驳/无依据。推演点此字段装前提整体判定。词表与 examples/hop-deep-research VerifyResult.verdict 同一套——改一处须同步改彼处
  - credibility % enum(authoritative,reliable,questionable,not_found)  # 事实点=断言可信度（取最强支持来源等级）；推演点=前提整体可信度
  - validity % line  # 推演点专用：推理有效性 sound/mostly/leap/invalid + 谬误类型；fact 点留空
  - evidence_summary % text  # 依据清单：每条一行"来源名（tier）：说了什么 — URL"——程序按候选编号从检索结果照抄来源名与 URL
  - conclusion % text  # 综合结论一句话（存疑/成立/不成立及原因）
  - remark % text  # 补充说明（来源口径打架、依据与断言矛盾在哪等）；没有就留空

Tools:
- web_search(query) -> result % yaml  # 网页检索：查询词→结果页清单（每条含标题/URL/摘要）
  - query % text  # 检索查询词

输入:
- doc_path % line  # 待核查文档路径（.md 或纯文本）——**相对工作目录**,或落在工作目录内的绝对路径（standalone 沙箱拒绝工作目录外的绝对路径;文件须在运行工作区内或先拷入）

输出:
- points % [CheckPoint]  # 核查点清单（2.4 完备性闸验收后的定稿——确认停点已撤,速览呈现代之,作者定 2026-08-27）
- factcheck_report % markdown  # 核查报告（逐点：类型/依据/来源/可信度或有效性判定）

## 步骤

### 1. [探索] 初始化完备性反馈通道
+ → extract_gap % text  # 提取完备性反馈：空=首轮/已完备，非空=上轮漏项清单（重提取据此补）
+ → report_gap % text  # 汇总完备性反馈：空=首轮/已完备，非空=上轮遗漏清单（重汇据此补）

> ```hop_python
> extract_gap = ""
> report_gap = ""
> ```

置空两个完备性反馈通道（root scope 声明，subtask 内 check/reason 读写命中同一 scope）。纯赋值零推理。

### 2. [子任务 重试=2] 提取核查点并验收完备性
- ← doc_path
+ → points % [CheckPoint]  # 提取的核查点清单（每元素 CheckPoint 六字段：id/type/line_ref/quote/claim/premises）

先读文档，穷举提取两类核查点，再自查完备性——漏项则据 extract_gap 反馈定向重提（引擎 retry 上限即轮数上限：首轮 + 2 次重试）。

#### 2.1. [探索] 读取文档并生成带行号分析物
- ← doc_path
+ → doc_content % text  # 带行号的文档全文（每行前缀 L<行号>: ——提取与核查全程用这份，点位引用照抄行号即可）
+ → doc_len % int  # 原文字数（供长度闸判定，不含行号前缀）
+ → numbered_path % line  # 带行号分析物的落盘路径（work_zone 内——报告读者对着此文件核行号）

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
+ → len_ok % bool  # 判定槽：≤30000 字才放行提取
+ → len_msg % text  # 说明槽：超长时的分拆指引

> ```hop_python
> len_ok = doc_len <= 30000
> len_msg = "" if len_ok else f"文档 {doc_len} 字超上限 30000——请先按章节拆成多个文件分别核查，或裁剪到核心部分再跑"
> ```

带 body 的机械判定（引擎直执零 LLM）。超长判 false 拦在提取之前——昂贵的 LLM 提取步不会对超长文档白跑；重试轮也只重跑 2.1/2.2 两个零成本 body 步，耗尽后 run 以 len_msg 指引失败。

#### 2.3. [推理] 提取事实点与推演点
- ← doc_content, points, extract_gap
+ → points % [CheckPoint]  # 核查点清单（数组，每元素 CheckPoint 结构）

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

两字段分工：**quote 原样摘**（保留口语和修辞——它是"原文确实这么说"的凭据，读者拿它回原文对得上）；**claim 掐掉修辞提炼成可检索的中性断言**（"根本不算事"没法搜，"上限 400 毫克"能搜）。claim 里的公司名、人名、机构名、产品名一个字都不许改，照原文的字抄——后面检索全靠这些名字，写错一个字就搜不到。line_ref 照抄行首 L 号（跨行断言写 L23-L25）。

❌ 错误写法：`premises: P5+P6`——后续每个点由独立的执行者核查，它手里只有本点这一条，P5/P6 的内容它看不到，只写编号等于什么都没给它。✅ 正确写法如上：每个前提的**内容**写进来，编号只作附注；文档没明说的隐含假设也算前提，一并写出。

**"分别"句式先配对再拆点**：原文写"A、B 和 C 三个项目分别投入 x、y、z"这类句子时，先把项目清单和数值清单各自按原文顺序列出来，数清两边个数相等，再按位置一一配对（第 1 个项目配第 1 个数……），每一对拆成一个点。项目名里自带"和""及"的（如"第五代和第六代 AI 芯片"）要对照数值个数判断它算一个还是两个项目——原文说"三个项目"就必须配出三对：名字个数少于数值个数时，说明某个带"和""及"的名字要拆成两个项目（"第五代和第六代 X 项目"拆成"第五代 X 项目""第六代 X 项目"），**绝不许编出原文没有的项目**（如"第三个未命名项目"）。配错对的点，核查会拿到与断言对不上的依据，被误判为不成立。

分类以"能否直接搜到外部依据"为界：能→fact，需要逻辑推理才能评判→inference。宁细勿漏，一句话含多个断言拆成多点——但**以"能独立成断言的陈述"为单位**：依附主句的括号插语、修饰成分不单独成点（如上例"约四五杯咖啡"是换算附注，不拆成点，作为推演点的前提写进 premises 即可）。输出 CheckPoint 列表（YAML 形态，如上例）。

**首轮**（points 为 None、extract_gap 空）= 全新提取；**重试轮**（points 是上轮产物、extract_gap 非空）= 在上轮 points 基础上按 extract_gap 定向补齐（补漏项、修正误分类），已对的点原样保留不推翻。

#### 2.35. [探索] 机械找出断言与前提里原文没有的字
- ← doc_content, points
+ → claim_novel % text  # 每行"编号：claim 或 premises 里有原文没出现过的字「…」"；claim 与 premises 的汉字都在原文里出现过 → 空串

> ```hop_python
> pairs = [{"id": p["id"], "chars": join([ch for ch in split(str(p["claim"]) + str(p["premises"]), "") if ch >= "一" and ch <= "鿿" and not (ch in doc_content)], "")} for p in points]
> claim_novel = join([f"{x['id']}：claim 或 premises 里有原文没出现过的字「{x['chars']}」" for x in pairs if x["chars"]], "\n")
> ```

纯机械比对（引擎直执，零 LLM）：逐条把 claim 和 premises 的汉字取出来，挑出原文里一次都没出现过的字。premises 是推演点的前提复述，同样会抄错名字（真机实撞：claim 抄对了，premises 里又把"燧原科技"写成"燕原科技"），所以一起查。claim 是提炼改写的，出现"包括""被"这类改写用字是正常的；但如果挑出来的字落在公司名、人名、机构名、产品名里，就是抄写错了（真机实撞：qwen-flash 把原文的"燧原科技"写成"燕原科技"，quote 照抄是对的、claim 错了，后面检索全按错字搜，报告还据此虚构出"名称混淆"问题）。判断交给 2.4。

#### 2.4. [检查 终检] 验收提取完备性
- ← doc_content, points, claim_novel
+ → extract_ok % bool  # 判定槽：提取是否完备
+ → extract_gap % text  # 说明槽：漏项清单（通过时置空）

**先看 claim_novel**：它是程序挑出的"claim 或 premises 里有、原文里没有"的字。逐行看这些字落在哪个词里——落在公司名、人名、机构名、产品名这类专有名词里的，是抄写错误，算严重问题，在 extract_gap 里写明"P编号 的 claim（或 premises）把原文的「正确名称」写成了「错误名称」"；落在"包括""被""其"这类普通改写用词里的，不是问题，不要打回。还有一种也算严重问题：这些字组成了原文根本没有的对象（如"未命名项目"——原文没有这个项目，是提取时为凑数编出来的），在 extract_gap 里写明"P编号 编出了原文没有的「…」，应按原文重新配对拆点"。claim_novel 为空就跳过这一项。

再逐段扫 doc_content，核对 points 是否穷尽——是否有可查证断言未列为 fact、有结论/预测/评价未列为 inference、有断言被误分类、推演点前提缺失。每轮对着当前 points 独立重判，不参考上轮判词——输入里不给 extract_gap 是刻意的：判官读到自己上轮写的判词会照抄交卷，已改对的产出被原判词二次打回（真机实撞：三轮判词逐字节相同，修订全部落实仍烧尽）。

**打回门槛——只有严重问题才打回，一次列全**：严重问题=漏了可查证断言（文档里有、points 里没有）、claim 或 premises 里的专有名词抄错字（见上）、推演点前提缺到没法核查。**fact 与 inference 的分类争议不是打回理由**——本变体里两条核查路径都会检索外部依据、都会给出判定，分错类只影响检索词从 claim 拟还是从 premises 拟，不影响结论能否产出（真机实撞：L 格三轮判官每轮挑一批不同的点要求改分类，改了又翻回来，重试烧光整个 run 失败在提取阶段）。**拆分方式的裁量偏好不是打回理由**——同一句话合成一点还是拆成两点，只要断言内容都被覆盖、类型不影响核查路径，两种处理都算完备（真机实撞：三轮判官对同一句话先要求合并、再要求拆分、再换第三个角度，每轮换标准永不收敛）。打回时把全部严重问题一次列全，不分批挤牙膏。

完备 → extract_ok=true、extract_gap=""；有严重问题 → extract_ok=false、extract_gap 逐条列出（触发 subtask retry，2.3 据 extract_gap 补齐重提）。

#### 2.5. [失败兜底] 三轮验收都没通过 → 沿用末轮提取结果继续核查
+ → points % [CheckPoint]

##### 2.5.1. [探索] 沿用末轮核查点
- ← points
+ → points % [CheckPoint]  # 末轮 2.3 产出的核查点原样沿用

> ```hop_python
> points = points
> ```

走到这里说明首轮加两次重试，判官每轮都还有意见。末轮的核查点清单绝大部分是可用的——为几条遗漏或争议让整个核查报废不划算。失败不清理变量（末轮 2.3 的 points 和末轮 2.4 的 extract_gap 都还在），本步原样沿用 points；extract_gap 保留判官最后一轮的意见，5.1 机械写进报告的"提取阶段未收敛的意见"节，读报告的人知道哪些地方可能漏提或分错类。

### 3. [探索] 生成核查点速览与统计
- ← points
+ → points_digest % text  # 速览：首行统计值（总数/事实/推演），后接每点一行（编号｜类型｜行号｜断言）——供 driver 展示给用户过目（信息性呈现，不阻塞执行；用户看到不对可随时中止 run）

> ```hop_python
> n_fact = count([p for p in points if p['type'] == 'fact'])
> n_inf = count([p for p in points if p['type'] == 'inference'])
> digest_lines = [f"{p['id']}｜{'事实' if p['type'] == 'fact' else '推演'}｜{p['line_ref']}｜{p['claim']}" for p in points]
> points_digest = f"共 {count(points)} 个核查点（事实 {n_fact}｜推演 {n_inf}）\n" + join(digest_lines, "\n")
> ```

机械拼速览零 LLM。设计取舍（2026-08-27 作者定"这一波让人审意义不大，先给人看一下列表和统计值就行"）：不设确认停点——提取质量已有 2.4 完备性闸把关，人工逐点确认的边际价值低而中断成本高（run 挂起等人）；速览给人**知情**而非**审批**，看到跑偏随时中止即可。

### 4. [循环 遍历 point 于 points, 收集 check_item 入 check_result] 逐点并行核查
+ → check_result % [CheckResult]  # 各点核查结论（collect 显式收集 check_item；并行乱序，条目自含 id 可归位）

对每个核查点独立核查，按类型分流（事实点/推演点核查路径不同），结果收集为列表。

#### 4.1. [子任务 重试=5 并行] 核查单个点
- ← point
+ → check_item % CheckResult  # 该点的核查结论（结构化，字段见 Types）

按 point.type 分流：事实点走"拟检索词→程序检索→挑依据并判定"，推演点走"为前提拟检索词→程序检索→挑前提依据并做推理审查"。检索由程序做、URL 由程序照抄，模型只拟检索词和按编号挑选。

##### 4.1.1. [分支] 按点类型分流核查
- ← point
+ → check_item % CheckResult

###### 4.1.1.1. [条件] 事实点核查 (point.type == "fact")
+ → check_item % CheckResult

####### 4.1.1.1.1. [推理] 拟定检索词
- ← point
+ → queries % [SearchQuery]  # 2~3 条检索词（about 一律留空）
> @thinking off

为 point.claim 拟 2~3 条检索词，交给程序去检索（你不用、也不能自己检索——下一步由程序逐条调检索服务，把结果编好号给你挑）。拟法：

- 第一条：断言里的核心实体 + 关系词/数据项，去掉疑问语气和修辞（如断言"FDA 建议健康成人每日咖啡因摄入上限为 400 毫克"→ `FDA 健康成人 每日咖啡因 400 毫克`）；
- 第二条：冲着一手信源构造——机构官方名、公告/报告的正式名称、领域标准术语（如 `FDA caffeine 400 mg per day healthy adults`，中文断言可换英文搜原始机构）；
- 断言含多个要素（日期+板块+金额这类）时，可加第三条专搜容易被漏掉的那个要素。

about 一律留空（事实点路径不挂前提）。实体名照抄 point.claim 原文的字，不改写、不换同音字。

**本步不许拒绝、不许报"缺信息"**：断言看起来像观点、表述宽泛、缺具体数字，都照样拿断言里的关键词拟检索词（如断言"行业竞争将加剧"→ `芯片行业 竞争加剧 2026`）——搜不搜得到依据是后面判定步的事，搜不到会如实落为"无依据"，这是合法结论。拒绝产出会让这个点整个没有核查结果（真机实撞：qwen-flash 以"观点陈述不是事实点"为由拒绝拟词，重试 23 次全部烧光）。

####### 4.1.1.1.2. [循环 遍历 q 于 queries] 逐条检索
+ → pool % [Candidate] = []  # 全部检索词的结果合并清单（尚未编号，no 为空）

对每条检索词调一次 web_search，把返回的结果页逐条追加进 pool。queries 为空列表时本循环零轮。

######## 4.1.1.1.2.1. [探索] 检索并追加候选
- ← q, pool
+ → pool % [Candidate]  # 追加本条检索结果后的清单

> ```hop_python
> r = web_search(query: q["query"])
> pages = get(r, "pages", []) if r else []
> pool = pool + [{"no": "", "about": str(get(q, "about", "") or ""), "title": str(get(pg, "title", "") or ""), "url": str(get(pg, "url", "") or ""), "source": str(get(pg, "hostname", "") or ""), "snippet": str(get(pg, "snippet", "") or "")[:300]} for pg in pages]
> ```

纯机械检索（引擎直执，零 LLM）：结果页的标题、链接、来源名、摘要都是检索服务返回的原文，原样装进候选条目——模型全程碰不到 URL，也就无从编造。检索服务本身出错（网络断、限流）时本步失败，由外层按事实点的重试（4.1 的 retry）整点重做。

####### 4.1.1.1.3. [探索] 候选去重编号
- ← pool
+ → candidates % [Candidate]  # 去重（按 URL）后逐条编号 C1/C2… 的候选清单

> ```hop_python
> keys = [lower(strip(c["url"])) for c in pool]
> keep = [k for k in range(len(pool)) if keys[k] and not (keys[k] in keys[:k])]
> candidates = [{"no": f"C{n + 1}", "about": pool[keep[n]]["about"], "title": pool[keep[n]]["title"], "url": pool[keep[n]]["url"], "source": pool[keep[n]]["source"], "snippet": pool[keep[n]]["snippet"]} for n in range(len(keep))]
> ```

纯机械去重与编号（引擎直执，零 LLM）：同一 URL 被几条检索词都搜到时只留第一次出现的条目；无 URL 的条目丢弃（没有链接就没法当依据）。

####### 4.1.1.1.4. [推理] 挑选依据并判定
- ← point, candidates
+ → picks % [Pick]  # 挑中的依据（按候选编号）
+ → judgement % Judgement  # 本点判定

candidates 是程序刚从检索服务取回的真实结果，每条带编号（C1/C2…）、标题、链接、来源名和摘要。做两件事：

**一、挑依据**：从 candidates 里挑出与 point.claim 相关的条目，每条填一个 Pick——no 照抄候选的编号，tier 按该条的来源名/域名身份标，summary 写该来源说了什么（支持什么、反驳什么、口径差异在哪，依据是候选的 snippet）。**只能挑清单里有的编号**；清单里没有相关条目就交空列表 []。**择优纪律**：同一信息点有 authoritative/reliable 来源就不再收 questionable 的重复条目；只有高等级来源覆盖不到时才收 questionable 兜底——低等级来源不是垃圾，是"仅此一家"时的如实记录。

**二、判定**（填 Judgement，只依据你挑中的条目）：
- verdict：全面支持 supported；仅部分口径/部分要素支持 partially_supported；依据与断言相反 refuted；没有可用依据 no_evidence；
- credibility：支持本断言的各条里最强的 tier；picks 为空 → not_found；
- validity 留空；
- conclusion：一句话综合（如"成立，权威口径一致"/"存疑：与交易所公告口径矛盾"）；
- remark：来源之间口径打架、依据与断言矛盾在哪，写在这里；没有就留空。

**断言含多个要素时逐个要素对**（日期、板块、金额、数量各算一个要素）：全部要素都有依据支持才算 supported；有要素被依据说成别的值 → refuted 并在 remark 写明哪个要素、依据怎么说；有要素找不到依据、其余都对 → partially_supported。

**判 refuted 前先过两道关**（真机实撞：L 格 9 个"不成立"里有一半是这两种错）：

- **说的是不是同一个对象**：依据讲的主体、范围必须和断言一致才能拿来反驳。反例：断言"AI 芯片贡献了半导体行业约一半收入"，依据是"百度公司 AI 业务占其收入 52%"——一个是行业、一个是单家公司的业务线，不相干，不能当依据（不挑它）；断言讲芯片行业，依据讲全 A 股上市公司营收，同样不相干。
- **口径是否相同**：不同机构、不同年份、不同统计范围的数字不一样是常态，不是反驳。反例：断言"2026 年存储器收入预计 2000 亿美元"（某机构的预测），依据是另一家机构对另一年份、另一口径的统计——判 partially_supported，在 remark 里把两边的数字、机构、年份并排写出，不判哪边对。只有依据明确说的是**同一机构、同一年份、同一口径**的同一个数且数值不同，才判 refuted。

预测类断言（"预计""将""可能"）的依据只能是别的预测或该预测的原始出处；拿当下的实际数据去"反驳"一个对未来的预测不成立。

####### 4.1.1.1.5. [探索] 机械组装本点结论
- ← point, candidates, picks, judgement
+ → check_item % CheckResult  # 本点核查结论

> ```hop_python
> nos = [c["no"] for c in candidates]
> pk = picks if picks else []
> good = [p for p in pk if strip(str(get(p, "no", ""))) in nos]
> bad = [strip(str(get(p, "no", ""))) for p in pk if not (strip(str(get(p, "no", ""))) in nos)]
> ev = [{"c": candidates[int(strip(str(p["no"]))[1:]) - 1], "tier": str(get(p, "tier", "")), "summary": str(get(p, "summary", ""))} for p in good]
> evidence_summary = join([f"- {e['c']['source']}（{e['tier']}）：{e['summary']} — {e['c']['url']}" for e in ev], "\n") if len(ev) > 0 else "（无可用依据）"
> empty = len(ev) == 0
> bad_note = "" if len(bad) == 0 else f"（判定步挑了候选清单里没有的编号 {join(bad, '、')}，已忽略）"
> remark = strip(str(get(judgement, "remark", "") or "") + bad_note)
> check_item = {"id": point["id"], "line_ref": point["line_ref"], "claim": point["claim"], "verdict": "no_evidence" if empty else judgement["verdict"], "credibility": "not_found" if empty else judgement["credibility"], "validity": "", "evidence_summary": evidence_summary, "conclusion": "检索结果里没有可用依据" if empty else judgement["conclusion"], "remark": remark}
> ```

纯机械组装（引擎直执，零 LLM）：id/line_ref/claim 从核查点照抄（不经模型转写，断言原文的字不会被改错）；依据的来源名与 URL 按编号从候选清单照抄；挑了清单外编号的条目丢弃并在 remark 注明；一条有效依据都没有时判定机械落为"无依据"。

###### 4.1.1.2. [条件] 推演点核查 (point.type == "inference")
+ → check_item % CheckResult

####### 4.1.1.2.1. [推理] 为每个前提拟定检索词
- ← point
+ → queries % [SearchQuery]  # 每个前提 1~2 条检索词（about=该前提的凝练）
> @thinking off

point.premises 列出了这个推演依赖的事实前提。为每个前提拟 1~2 条检索词，交给程序去检索（你不用、也不能自己检索——下一步由程序逐条调检索服务，把结果编好号给你挑）。每条填一个 SearchQuery：about=该前提的凝练（一句话，同一前提的几条检索词 about 写成一样的字），query=前提里的实体+数据/关系词（去疑问语气；前提提到机构就用"机构名+数据项"，提到研究结论就用学术术语/报告名）。实体名照抄原文的字，不改写、不换同音字。

"隐含假设"类前提（文档没写、推理成立所必需的命题）通常搜不到直接依据，不必为它拟检索词——它在判定步的推理审查里处理。

**本步不许拒绝、不许报"缺信息"**。常见的三种情形这样处理：

- 前提表述宽泛（"需求增长""各地区差异""巨头推进垂直整合"这类，没有具体数字和机构名）：照样拿前提里的关键词拟检索词，再补上 point.claim 里的主题词和年份（如前提"消费级内存短缺"→ `消费级内存 短缺 2026`）；
- premises 为空：从 point.claim 本身拟 1~2 条检索词，about 写 point.claim；
- 所有前提都是隐含假设、确实没有可搜的：交空列表 []。

交空列表是合法产出——判定步照样做推理审查，前提可信度机械落为 not_found。拒绝产出则会让这个点整个没有核查结果（真机实撞：L 格 82 个点里 8 个点的拟词步以"前提太宽泛无法拟定检索词""premises 字段为空"为由报缺信息，每个点重试 23 次全部烧光，报告里成了"未完成核查"）。

####### 4.1.1.2.2. [循环 遍历 q 于 queries] 逐条检索
+ → pool % [Candidate] = []  # 全部检索词的结果合并清单（尚未编号，no 为空）

与事实点路径的 4.1.1.1.2 同一套机械检索。queries 为空列表时本循环零轮。

######## 4.1.1.2.2.1. [探索] 检索并追加候选
- ← q, pool
+ → pool % [Candidate]  # 追加本条检索结果后的清单

> ```hop_python
> r = web_search(query: q["query"])
> pages = get(r, "pages", []) if r else []
> pool = pool + [{"no": "", "about": str(get(q, "about", "") or ""), "title": str(get(pg, "title", "") or ""), "url": str(get(pg, "url", "") or ""), "source": str(get(pg, "hostname", "") or ""), "snippet": str(get(pg, "snippet", "") or "")[:300]} for pg in pages]
> ```

纯机械检索（引擎直执，零 LLM），做法与 4.1.1.1.2.1 相同；候选条目的 about 带上检索词的 about，判定步据此知道每条结果是为哪个前提搜的。

####### 4.1.1.2.3. [探索] 候选去重编号
- ← pool
+ → candidates % [Candidate]  # 去重（按 URL）后逐条编号 C1/C2… 的候选清单

> ```hop_python
> keys = [lower(strip(c["url"])) for c in pool]
> keep = [k for k in range(len(pool)) if keys[k] and not (keys[k] in keys[:k])]
> candidates = [{"no": f"C{n + 1}", "about": pool[keep[n]]["about"], "title": pool[keep[n]]["title"], "url": pool[keep[n]]["url"], "source": pool[keep[n]]["source"], "snippet": pool[keep[n]]["snippet"]} for n in range(len(keep))]
> ```

纯机械去重与编号，与 4.1.1.1.3 相同。

####### 4.1.1.2.4. [推理] 挑选前提依据并做二维判定
- ← point, candidates
+ → picks % [Pick]  # 挑中的前提依据（按候选编号）
+ → judgement % Judgement  # 二维判定（verdict/credibility=前提维，validity=推理维）

candidates 是程序刚从检索服务取回的真实结果，每条带编号（C1/C2…）、为哪个前提搜的（about）、标题、链接、来源名和摘要。做两件事：

**一、挑前提依据**：从 candidates 里挑出能说明某个前提真假的条目，每条填一个 Pick——no 照抄候选编号，tier 按来源名/域名身份标，summary 写该来源对此前提说了什么。**只能挑清单里有的编号**；某前提没有相关条目就不为它挑。择优：优先 authoritative/reliable，questionable 只在高等级覆盖不到时兜底。

**二、二维判定**（填 Judgement）：
- **维度一·前提**（verdict/credibility）：按前提分组看挑中的条目，逐前提取其中最强的 tier，没有条目的前提计 not_found；verdict 装前提整体被支持的程度（supported/partially_supported/refuted/no_evidence），credibility 装各前提最强等级中**最弱**的一档（前提链的强度由最弱的前提决定）。
- **维度二·推理**（validity）：**假设前提全为真**，审"推得出推不出"：
  1. **摆链**：把推理写成"前提 → (隐含假设) → 结论"的链条，文档没写但结论成立所必需的隐含假设逐个挖出来摆上；
  2. **逐跳审**，重点核对四类常见跳跃——范围偷换（"健康成人"→"所有人"）、程度拔高（"无害"→"有益"）、因果误置（相关当因果、时序当因果）、以偏概全（个例推普遍）；
  3. **定级**：每跳都成立 → sound；只有措辞简化、近似换算这类无害小跳 → mostly；有明显跳跃或依赖未证实的隐含假设 → leap；某跳依赖的假设为假或存在确定谬误 → invalid。mostly 与 leap 的分界＝补上跳跃后结论是否基本不变；leap 与 invalid 的分界＝隐含假设是"未证实"还是"已知为假"；
  4. validity 写成 `等级：谬误类型清单`（如 "leap：范围偷换（健康成人→所有人）"）；sound/mostly 也写一句链条摘要。
- conclusion：前提可信且 sound/mostly → 成立；前提真但 leap/invalid → 存疑（指出跳在哪）；前提不成立 → 不成立。

**判某前提被反驳之前先过两道关**，与事实点路径 4.1.1.1.4 的规矩相同：依据讲的主体、范围必须和前提一致（单家公司的数据不能反驳行业层面的前提，全 A 股的数据不能反驳芯片行业的前提）；不同机构、年份、口径的数字不一样不算反驳，写进 remark 并排呈现。**建议、倡议类结论**（"高管应评估…""企业应考虑…"）不是事实断言，不存在被依据"反驳"的问题——前提维按前提本身判，推理维审"前提推不推得出这条建议"。
- remark：来源口径打架、某前提被依据否定等写在这里；没有就留空。

推理审查不需要信源——隐含假设搜不到依据是正常的，不因此把维度二判低。

####### 4.1.1.2.5. [探索] 机械组装本点结论
- ← point, candidates, picks, judgement
+ → check_item % CheckResult  # 本点核查结论

> ```hop_python
> nos = [c["no"] for c in candidates]
> pk = picks if picks else []
> good = [p for p in pk if strip(str(get(p, "no", ""))) in nos]
> bad = [strip(str(get(p, "no", ""))) for p in pk if not (strip(str(get(p, "no", ""))) in nos)]
> ev = [{"c": candidates[int(strip(str(p["no"]))[1:]) - 1], "tier": str(get(p, "tier", "")), "summary": str(get(p, "summary", ""))} for p in good]
> evidence_summary = join([f"- 前提「{e['c']['about']}」｜{e['c']['source']}（{e['tier']}）：{e['summary']} — {e['c']['url']}" for e in ev], "\n") if len(ev) > 0 else "（各前提都没有可用依据）"
> bad_note = "" if len(bad) == 0 else f"（判定步挑了候选清单里没有的编号 {join(bad, '、')}，已忽略）"
> remark = strip(str(get(judgement, "remark", "") or "") + bad_note)
> check_item = {"id": point["id"], "line_ref": point["line_ref"], "claim": point["claim"], "verdict": judgement["verdict"], "credibility": "not_found" if len(ev) == 0 else judgement["credibility"], "validity": str(get(judgement, "validity", "") or ""), "evidence_summary": evidence_summary, "conclusion": judgement["conclusion"], "remark": remark}
> ```

纯机械组装（引擎直执，零 LLM），与 4.1.1.1.5 同法；推演点没有有效依据时只把前提可信度机械落为 not_found，推理有效性（validity）照模型的审查结论保留——推理审查不依赖信源。

### 5. [子任务 重试=2] 汇聚核查报告并验收完备性
- ← check_result, points
+ → factcheck_report % markdown  # 核查报告

汇聚所有核查结论成报告，再自查完备性——漏点/漏结论则据 report_gap 反馈定向重汇（引擎 retry 上限即轮数上限：首轮 + 2 次重试）。

#### 5.1. [探索] 机械渲染逐点章节
- ← check_result, points, numbered_path, extract_gap
+ → report_body % markdown  # 报告机械段：全点判定一览表+依据明细+未核查点清单（零 LLM——体量随点数线性,交给程序拼,输出上限管不到程序）
+ → stats_line % text  # 机械统计行：总点数与各判定档计数（程序数的,总评散文照抄——执行模型数不动一百多个点,自己数必错）
+ → problem_ids % text  # 问题点编号清单（refuted/no_evidence/questionable/not_found/leap/invalid 的点,逗号连接;空串=无问题点）——总评的问题清单按此写,不自己扫

> ```hop_python
> vmap = {"supported": "成立", "partially_supported": "部分成立", "refuted": "不成立", "no_evidence": "无依据"}
> rows = [f"| {r['id']} | {r['line_ref']} | {r['claim'][:30] + ('…' if len(r['claim']) > 30 else '')} | {get(vmap, r['verdict'], r['verdict'])} | {r['validity'] if strip(str(r['validity'] if r['validity'] else '')) else r['credibility']} |" for r in check_result]
> table = join(["| 编号 | 行号 | 断言 | 判定 | 等级 |", "|---|---|---|---|---|"] + rows, "\n")
> details = join([f"### {r['id']} {r['claim']}\n\n- 判定：{get(vmap, r['verdict'], r['verdict'])}｜{r['credibility']}{('｜' + str(r['validity'])) if strip(str(r['validity'] if r['validity'] else '')) else ''}｜{r['conclusion']}\n- 依据：\n{r['evidence_summary']}" + ("\n- 补充说明：" + str(r['remark']) if strip(str(get(r, 'remark', '') or '')) else "") for r in check_result], "\n\n")
> checked_ids = [r["id"] for r in check_result]
> unchecked = [p for p in points if not (p["id"] in checked_ids)]
> tail = "" if len(unchecked) == 0 else ("\n\n## 未能核查的点\n\n" + join([f"- {p['id']}（{p['line_ref']}）{p['claim']}——核查未完成" for p in unchecked], "\n"))
> gap_note = "" if not strip(str(extract_gap or "")) else ("\n\n## 提取阶段未收敛的意见\n\n提取完备性验收三轮未通过，以下是验收最后一轮的意见（核查照末轮提取结果进行，这些地方可能有漏提或分类争议）：\n\n" + str(extract_gap))
> report_body = f"## 全点判定一览\n\n{table}\n\n## 依据明细\n\n{details}{tail}{gap_note}\n\n---\n行号对照文件：{numbered_path}"
> n_sup = count([r for r in check_result if r["verdict"] == "supported"])
> n_part = count([r for r in check_result if r["verdict"] == "partially_supported"])
> n_ref = count([r for r in check_result if r["verdict"] == "refuted"])
> n_noev = count([r for r in check_result if r["verdict"] == "no_evidence"])
> stats_line = f"共核查 {count(check_result)} 个点：成立 {n_sup}｜部分成立 {n_part}｜不成立 {n_ref}｜无依据 {n_noev}；未完成核查 {len(unchecked)} 个"
> prob = [r for r in check_result if r["verdict"] == "refuted" or r["verdict"] == "no_evidence" or r["credibility"] == "questionable" or r["credibility"] == "not_found" or ("leap" in str(r["validity"] if r["validity"] else "")) or ("invalid" in str(r["validity"] if r["validity"] else ""))]
> problem_ids = join([r["id"] for r in prob], ", ")
> ```

机械渲染零 LLM（dv 预审 R7 的修法落地——真机实撞:198 点逐点转写首轮 OUTPUT_TRUNCATED 4096 掐断、重汇轮整段合并写法漏汇 198/198）：check_result 已是结构化字段,一览表/依据明细/未核查清单全部程序拼——**体量随点数线性的段永远不走 LLM 输出通道**。LLM 只写体量近似恒定的总评（5.2）。

#### 5.2. [推理] 撰写总评与问题清单
- ← check_result, stats_line, problem_ids, report_gap
+ → report_head % markdown  # 报告头：总评散文+按严重度降序的问题点清单（体量随问题点数缓增,与总点数无关）

不做新核查、不做任何计数。写报告的开头一节：

- 先一段总评散文,**统计数字逐字照抄 stats_line**（那是程序数的,一个字不改;禁止自己数 check_result——上百个点人肉计数必错）,再补一两句整体可靠性的定性评价;
- 接着按严重度降序逐条列**问题点**——**problem_ids 里列出的每个编号一条,不多不少**（空串=写"未发现问题"）。每条小标题 `P编号（行号）——问题定性`,下面两三句散文：原文断言是什么、问题在哪、关键依据一句（含来源名,从 check_result 对应条目取）。

只写这一节。全点一览表与依据明细已由程序另拼,不要复述任何"成立"点的细节。report_gap 非空时按意见修上一版的总评。

#### 5.3. [探索] 机械拼装完整报告
- ← report_head, report_body
+ → factcheck_report % markdown  # 核查报告（总评在前,机械段在后）

> ```hop_python
> factcheck_report = report_head + "\n\n" + report_body
> ```

机械拼接零 LLM。

#### 5.4. [探索] 机械核对存在性与降级项
- ← points, check_result, factcheck_report
+ → missing_in_report % text  # 有核查结论但报告漏汇的点编号（真漏汇——重汇能修）
+ → unchecked_ids % text  # 无核查结论的点编号（核查失败——重汇不可能补出结论,只能如实交代）
+ → flagged_items % text  # 被降级/存疑的结论清单（供后继 LLM 审合理性）

> ```hop_python
> all_ids = [p["id"] for p in points]
> checked_ids = [r["id"] for r in check_result]
> sep = replace(replace(replace(replace(replace(replace(factcheck_report, "｜", " "), "|", " "), "（", " "), "(", " "), "\n", " "), "#", " ")
> report_tokens = [w for w in split(sep, " ") if startswith(w, "P")]
> missing_in_report = join([pid for pid in checked_ids if not (pid in report_tokens)], ", ")
> unchecked_ids = join([pid for pid in all_ids if not (pid in checked_ids)], ", ")
> flagged = [r for r in check_result if r["credibility"] == "questionable" or r["credibility"] == "not_found" or r["verdict"] == "refuted" or "leap" in r["validity"] or "invalid" in r["validity"]]
> flagged_items = join([f"{r['id']}｜verdict={r['verdict']}｜credibility={r['credibility']}｜validity={r['validity']}｜{r['conclusion']}" for r in flagged], "\n")
> ```

真机械核对（hop_python body 引擎直执，**遍历完整性归程序不归 LLM 记忆**）。编号在场判定用**词元集合比对**不用子串包含——P1 是 P10 的子串,`"P1" in 报告` 在报告只写了 P10 时也为真,漏汇的前缀编号会被静默放过;把报告按分隔符切成词元后做整词等值,前缀关系不再误判。CheckResult 结构化后检出全部走**字段直读**——原"questionable 是否在文本里"的子串匹配（散文里顺带提一句'并非 questionable'也会被捞进）随结构化退役，等级判定即字段等值。缺失分两类是关键：**missing_in_report**（有结论、报告没写——重汇可修）与 **unchecked_ids**（无结论——核查失败点，重汇变不出结论，只要求报告"未能核查"节如实列出）。混为一谈会让完备性闸索要不可能的东西，重试烧光后整个 run 报废在最后一步。

#### 5.5. [推理] 审查降级项的合理性
- ← flagged_items, check_result, points
+ → downgrade_review % text  # 逐个降级项的合理性复核结论

逐一审查 flagged_items 里每个被降级/存疑的结论（每行=编号+verdict/credibility/validity+结论；需看完整依据时按编号回 check_result 取该条 evidence_summary）——降级是否合理：
- 判断降级判定站得住吗（如标 not_found 是否确实搜过、标 questionable 的来源是否真属立场性、判 leap 的推理跳转是否确有其事）。
- 逐条给复核结论：**降级合理**（维持）或 **降级过苛/误判**（指出应上调，并说明理由）。

输出逐点复核清单（含 point.id、原降级、复核结论）。flagged_items 为空则记"无降级项"。

#### 5.6. [检查 终检] 验收汇总完备性
- ← missing_in_report, unchecked_ids, downgrade_review, factcheck_report, points
+ → report_ok % bool  # 判定槽：汇总是否完备
+ → report_gap % text  # 说明槽：遗漏清单（通过时置空）

综合判定报告完备性（两类缺失 doctrine 与 examples/hop-deep-research 10.2 是同一条规矩的两处落点——改这边须同步看彼处）。**分工前提**：一览表/依据明细/未核查清单三节由程序机械渲染（5.1），逐点在场性已由 5.4 机核把关（missing_in_report）——判官不逐点数表，只审 LLM 写的总评节与机核报数：① **missing_in_report 必须为空**（机核报数直读——非空即红，不自己重数）；② **unchecked_ids 非空时报告须有"未能核查的点"节**（该节程序拼,一般恒在——只查节存在性）；③ downgrade_review 中标为"误判/过苛"的降级项须已在总评的问题清单体现（未体现=总评失真）；④ 总评散文里的统计数字与 report_body 头部的机械统计行逐字一致（5.1 程序数的,总评只许照抄——不一致=LLM 又自己数了）；⑤ 所有问题点（refuted/no_evidence/questionable/not_found/leap/invalid）都进了总评的问题清单，**且每条的断言描述与 check_result 对应条目的 claim/verdict 内容一致**——编号对但描述文不对题（写成另一件事、判定词与实际不符）=失真，逐条点名打回（真机实撞:P34 实际是智能体工作周期断言,总评写成"市场地位推演";P35 实际 refuted,总评写"questionable"——编号从机械清单抄的所以对,描述是编的）。

全部满足 → report_ok=true、report_gap=""；否则 → report_ok=false，report_gap 逐条列出缺项（触发 subtask retry，5.2 据 report_gap 修总评重拼——机械段不重做）。每轮对着当前报告独立重判，不参考上轮判词——输入里不给 report_gap 与 2.4 同一条规矩（判官读到自己上轮判词会照抄交卷）。打回门槛也同 2.4：只有上列①-⑤的实质缺失才打回且一次列全，行文措辞、排版形态的裁量偏好不是打回理由。

### 6. [结束] 交付核查结果
