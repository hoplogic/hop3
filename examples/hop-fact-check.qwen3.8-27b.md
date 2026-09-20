# Spec: 文档事实核查与推演审查
<!-- 改本文件的能力面(步骤/词表/交付)需同步 examples/README.md 对应行——README 已两次滞后实撞 ;2026-09-19 增补:分块提取(2.3-2.5,每块 6 行——执行模型一次调用只能可靠处理 2~4 个要点,块按这条实测线切)+微判定小题 @model 路由 deepseek(五轮打磨实证:断言拆分粒度是小题里的开放裁量面,27b 每发裁量不同致判官抓行每轮漂移——粒度裁量归强模型,27b 保留提取与机械面,弱执行+强把关的微判定内化形态) -->
<!-- 【模型变体】源母本=examples/hop-fact-check.md;生成 2026-09-18(手工降档,生成器未实装——0095 2d 首个范本);目标 profile=qwen3.8-27b(check_judge: closed-questions-only);降档动作=2.4 开放式验收拆成微判定三件(机械分组 act→逐行封闭小题 loop→机械汇总 check final);5.6 保持母本开放式(v1 只验提取关,汇总关表现留作数据;5.x 编号 2026-09-20 报告机械化批重排)。母本改动后本变体须重新生成 -->
Id: hop-fact-check

## Task

Goal: 从文档提取所有事实点与推演点，逐条核查——事实点搜索外部依据并对来源可信度打标，推演点做前提溯源+推理有效性审查，汇聚成核查报告
> 读文档 → 提取事实点(可查证断言)+推演点(基于事实的结论)并分类 → 逐条并行核查(事实点走搜索+来源打标，推演点走前提溯源+推理审查) → 汇聚二维判定报告。

Constraints:
- 事实点 = 可独立查证的客观断言（数据、事件、时间、引述、因果陈述）；推演点 = 文档从事实推出的结论/预测/评价（含隐含假设）。分类以"能否直接搜到外部依据"为界。
- 来源可信度四级：authoritative（官方/学术/一手原始）/ reliable（主流媒体/行业权威二手）/ questionable（自媒体/匿名/立场性来源）/ not_found（搜不到支撑）。
- 推演有效性四级：sound（前提真且逻辑严密）/ mostly（大体成立、小跳跃）/ leap（有明显逻辑跳转或隐藏假设）/ invalid（前提不成立或推理谬误）。
- 每条核查须标注证据来源（URL 或出处），不得凭记忆断言；搜不到就标 not_found，不编造。
- 推演点核查是二维判定：前提可信度 × 推理有效性——两者皆高才可信；前提真但推理跳=结论存疑；前提假=结论不成立。

Types:
- CheckPoint:  # 一个待核查点
  - id: line  # 点编号（P1/P2…）
  - type: line  # fact（事实点）或 inference（推演点）
  - line_ref: line  # 断言在带行号分析物中的位置（如 L23 或 L23-L25）——照抄行号前缀，不自数
  - quote: text  # 断言的原文片段摘抄（一两句为限）——与 line_ref 互相印证，报告离开原文也可读
  - claim: text  # 待核查的断言，从 quote 提炼成中性、可独立检索的一句话——掐掉口语和修辞（"根本不算事"没法搜），补全省略的主语宾语（脱离上下文单看也知道在说什么）；后续搜索关键词、报告表格都用它。与 quote 的分工见步骤 2.3 示例
  - premises: text  # 推演点专用；fact 点留空。该结论依赖的事实前提，每个前提把内容写全、不能只写编号——完整正反示例见步骤 2.3
- LineJob:  # 微判定分组件——一行一件（变体专用:2.4 机械产出,2.5 循环逐件消费）
  - line_id: line  # 行号（L1/L2…照抄分析物前缀）
  - line_text: text  # 该行原文全文（含行号前缀）
  - claims: text  # 清单里 line_ref=该行的全部 claim,分号连接;空串=该行没有任何点
- LineVerdict:  # 单行覆盖判定结论（2.7 循环每件产出,2.8 机械汇总消费）
  - line_id: line  # 照抄 job 的行号
  - covered: enum(yes,no)  # 该行全部可查证断言/结论是否都被 claims 覆盖
  - missing: text  # covered=no 时写漏了哪个断言（内容写全）;yes 时留空

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

Inputs:
- doc_path: line  # 待核查文档路径（.md 或纯文本）——**相对工作目录**（standalone 沙箱拒绝绝对路径;文件须在运行工作区内或先拷入）

Outputs:
- points: [CheckPoint]  # 核查点清单（微判定验收 2.4-2.6 后的定稿——确认停点已撤,速览呈现代之,作者定 2026-08-27）
- factcheck_report: markdown  # 核查报告（逐点：类型/依据/来源/可信度或有效性判定）

## Steps

### 1. [act] 初始化完备性反馈通道
+ → extract_gap: text  # 提取完备性反馈：空=首轮/已完备，非空=上轮漏项清单（重提取据此补）
+ → report_gap: text  # 汇总完备性反馈：空=首轮/已完备，非空=上轮遗漏清单（重汇据此补）
+ → prior_points: [CheckPoint]  # 跨轮点清单存根：上一重试轮的定稿点（首轮空;2.5 每轮回写——重试轮与上轮取并集,漏项每轮随机不同,并起来就齐）
+ → covered_lines: [line]  # 覆盖销项底册：已判"覆盖齐"的行号（首轮空;2.8 每轮把新过关的行记入——过了关的行下轮不再重审,判官没有机会翻旧账）

> ```hop_python
> extract_gap = ""
> report_gap = ""
> prior_points = []
> covered_lines = []
> ```

置空两个完备性反馈通道与跨轮存根（root scope 声明，subtask 内 check/reason 读写命中同一 scope——重试轮不清,这正是跨轮通道的载体）。纯赋值零推理。

### 2. [subtask retry=5] 提取核查点并验收完备性
- ← doc_path
+ → points: [CheckPoint]  # 提取的核查点清单（每元素 CheckPoint 六字段：id/type/line_ref/quote/claim/premises）

先读文档并机械分块（块要切小：执行模型一次调用只能可靠处理 2~4 个要点，每块 6 行原文正好在这条线内），逐块提取后机械合并，再过微判定验收（机械分组→逐行封闭小题→机械汇总）——漏项则据 extract_gap 反馈定向重提（首轮 + 4 次重试;跨轮并集+销项底册下重试轮只对红行做,每轮很便宜——余量给足,真随机漏项靠轮数收敛）。

#### 2.1. [act] 读取文档并生成带行号分析物
- ← doc_path
+ → doc_content: text  # 带行号的文档全文（每行前缀 L<行号>: ——提取与核查全程用这份，点位引用照抄行号即可）
+ → doc_len: int  # 原文字数（供长度闸判定，不含行号前缀）
+ → numbered_path: line  # 带行号分析物的落盘路径（work_zone 内——报告读者对着此文件核行号）

> ```hop_python
> raw = read(path: doc_path)
> doc_len = len(raw)
> broken = replace(replace(replace(raw, "。", "。\n"), "！", "！\n"), "？", "？\n")
> broken = replace(broken, "；", "；\n")
> broken = replace(replace(replace(broken, ". ", ".\n"), "! ", "!\n"), "? ", "?\n")
> raw_lines = [strip(seg) for seg in split(broken, "\n") if strip(seg) != ""]
> doc_content = join([f"L{i + 1}: {raw_lines[i]}" for i in range(len(raw_lines))], "\n")
> numbered_path = work_zone_path("numbered-doc.md")
> write(path: numbered_path, content: doc_content)
> ```

读原文→**先按句末标点断行**（中文。！？后补换行;**分号也断**——政企通稿的百字排比句靠分号串三五个动宾段,不切开就是一行七八个断言,提取端漏中段、判官端核销失焦都在这种行上高发〔真机实撞:178 字排比行的"夯实国内算力底座"分句三轮三路全漏〕;英文按"句点/叹号/问号+空格"断——不带空格的 . 不动,3.5、URL 这类不误断;U.S. 这种缩写会多断一刀,无害——跨行断言本有 L23-L25 区间写法）→逐行机械编号→落盘 work_zone 作分析物。行号是分析物自己的坐标（报告对照 numbered_path,不对照原文件）;编号确定性归引擎,后续提取与核查**行号照抄不自数**。

#### 2.2. [check] 文档长度闸
- ← doc_len
+ → len_ok: bool  # 判定槽：≤30000 字才放行提取
+ → len_msg: text  # 说明槽：超长时的分拆指引

> ```hop_python
> len_ok = doc_len <= 30000
> len_msg = "" if len_ok else f"文档 {doc_len} 字超上限 30000——请先按章节拆成多个文件分别核查，或裁剪到核心部分再跑"
> ```

带 body 的机械判定（引擎直执零 LLM）。超长判 false 拦在提取之前——昂贵的 LLM 提取步不会对超长文档白跑；重试轮也只重跑 2.1/2.2 两个零成本 body 步，耗尽后 run 以 len_msg 指引失败。

#### 2.3. [act] 机械分块（每块切小，小到执行模型处理一块不会漏）
- ← doc_content, covered_lines
+ → doc_chunks: [text]  # 文档分块清单（每块≤6 个带行号原文行,行号全局连续不重编。为什么是 6 行:执行模型一次调用只能可靠处理 2~4 个要点,再多就开始漏,6 行原文的断言量正好在这条实测线内）

> ```hop_python
> all_lines = [l for l in split(doc_content, "\n") if strip(l) != "" and not (split(l, ":")[0] in covered_lines)]
> n = len(all_lines)
> size = 6
> starts = [k for k in range(n) if k % size == 0]
> doc_chunks = [join(all_lines[s:s + size], "\n") for s in starts]
> ```

机械分块零 LLM：每块 6 行原文（行号前缀自带全局坐标,跨块引用无歧义）。为什么分块：能力档案实测该模型一次调用只能可靠处理 2~4 个要点——整篇几十个要点一把穷举必漏,切成小块后每块的量它能处理完整。**重试轮聚焦火力**：已销项的行（covered_lines,判官判过关的）不再进块——重提取只对着红行做,块少了、每块与 extract_gap 意见的对应也直接了（真机实撞:全量重提九发,判官点名的 L14 仍漏——火力摊在全篇,红行的意见被稀释）。首轮 covered_lines 空,全篇照切。跨轮并集（2.5）保证已提的点不丢。

#### 2.4. [loop for-each chunk in doc_chunks] 逐块三路并发提取
+ → flat_points: [CheckPoint] = []  # 跨块累加的全量点清单（容器头累加器,每块由 2.4.3 机械并入——不用 collect 是为边收边平铺,免嵌套拼平）

每块同时派三个独立提取实例（同题三做）,产出取并集：单实例每发仍有小概率漏 1-2 个点且三份漏的通常是不同的点——并集覆盖率恒不低于最好的单份（标定实测:单发均值约 99%,三路并集恒 100%）。成本约三倍单发,换来完备性闸一次过、省掉整轮重试。

##### 2.4.1. [subtask] 三路并发提取本块
- ← chunk, extract_gap
+ → pts_a: [CheckPoint]  # 甲路提取结果
+ → pts_b: [CheckPoint]  # 乙路提取结果
+ → pts_c: [CheckPoint]  # 丙路提取结果

三个并行实例的收拢容器：parallel 步骤的产出只能在其容器完结后消费（S12 规则）——三路装进本容器,边界导出三份清单,2.4.2 在容器外做并集。

###### 2.4.1.1. [subtask retry=2 parallel] 提取实例甲
- ← chunk, extract_gap
+ → pts_a: [CheckPoint]  # 甲路提取结果

####### 2.4.1.1.1. [reason] 提取本块的事实点与推演点
- ← chunk, extract_gap
+ → pts_a: [CheckPoint]  # 本块核查点清单（id 先写块内临时号 T1/T2…,全局编号归 2.5 机械重排）

只处理 chunk 里的这几行,穷举两类点：
- **事实点**（type=fact）：可独立查证的客观断言——具体数据、发生的事件、时间节点、直接引述、明确的因果陈述。claim 写断言凝练，premises 留空。
- **推演点**（type=inference）：文档从事实推出的结论/预测/评价/判断——含"因此/说明/意味着/预计/将会"等推理跳转,或未言明的隐含假设。claim 写结论,premises 写它依赖的事实前提（每个前提把内容写全,不能只写编号）。

规矩：一行多个独立断言就拆成多个点（宁细勿漏）;line_ref 照抄行首的 L 号;quote 抄原句;**claim 与 quote 的值不要在外面再包一层引号**（原文里的引号照抄即可,外层引号会造成转义嵌套,下游机械匹配失效）;标题行（# 开头）与裸名词短语不算断言,整块无断言交空列表 []。extract_gap 非空且点名本块行号时,按意见定向补齐。

###### 2.4.1.2. [subtask retry=2 parallel] 提取实例乙
- ← chunk, extract_gap
+ → pts_b: [CheckPoint]  # 乙路提取结果

####### 2.4.1.2.1. [reason] 提取本块的事实点与推演点
- ← chunk, extract_gap
+ → pts_b: [CheckPoint]  # 本块核查点清单（id 块内临时号,规矩与甲路同）

任务与规矩同甲路（同题独立再做一遍——不知道也不需要知道其他实例的产出）：只处理 chunk 里的这几行,穷举事实点（type=fact,claim 写断言凝练,premises 留空）与推演点（type=inference,claim 写结论,premises 写依赖的事实前提,内容写全不写编号）;一行多断言拆多点宁细勿漏;line_ref 照抄 L 号;quote 抄原句;claim 与 quote 不外包引号;标题行与裸名词短语不算断言;整块无断言交 [];extract_gap 点名本块行号时按意见补齐。

###### 2.4.1.3. [subtask retry=2 parallel] 提取实例丙
- ← chunk, extract_gap
+ → pts_c: [CheckPoint]  # 丙路提取结果

####### 2.4.1.3.1. [reason] 提取本块的事实点与推演点
- ← chunk, extract_gap
+ → pts_c: [CheckPoint]  # 本块核查点清单（id 块内临时号,规矩与甲路同）

任务与规矩同甲路（同题独立再做一遍）：穷举事实点与推演点,一行多断言拆多点宁细勿漏,line_ref 照抄 L 号,quote 抄原句,claim 与 quote 不外包引号,标题行与裸名词短语不算断言,整块无断言交 [],extract_gap 点名本块行号时按意见补齐。

##### 2.4.2. [act] 三路并集去重
- ← pts_a, pts_b, pts_c
+ → chunk_points: [CheckPoint]  # 本块三路合并去重后的点清单

> ```hop_python
> pa = pts_a if pts_a else []
> pb = pts_b if pts_b else []
> pc = pts_c if pts_c else []
> merged = pa + pb + pc
> norm_keys = [replace(replace(replace(replace(f"{merged[k]['line_ref']}|{merged[k]['claim']}", " ", ""), "，", ","), "\"", ""), "。", "") for k in range(len(merged))]
> keep = [k for k in range(len(merged)) if not (norm_keys[k] in norm_keys[:k])]
> chunk_points = [merged[k] for k in keep]
> ```

机械并集零 LLM（在 2.4.1 容器边界后消费三路产出——S12 合规位）：三路拼接后按"行号+归一化断言文本"（剥空白/引号/句读）判重,同键首见保留;单路失败值缺席时按空清单并入（三路冗余的容错本义——两路在场并集仍成立）。三路对同一断言的措辞差异会产生近重复条目——无害：下游微判定按"覆盖看内容不看措辞"核销,重复条目只是多一条核查,不产生假阴性;真正要防的是漏,并集恰好治漏。

##### 2.4.3. [act] 本块点并入累加器
- ← flat_points, chunk_points
+ → flat_points: [CheckPoint]  # 并入本块后的累计清单

> ```hop_python
> flat_points = flat_points + chunk_points
> ```

机械并入零 LLM（+ 拼接;循环语义由 loop 容器承载——act body 禁 for 语句的文法下,跨块累加的正形=容器头累加器+体内拼接步）。

#### 2.5. [act] 跨轮并集与机械全局编号
- ← flat_points, prior_points
+ → points: [CheckPoint]  # 全清单（P1/P2… 全局连续编号;本轮提取 ∪ 上轮定稿）
+ → prior_points: [CheckPoint]  # 本轮定稿回写存根（root scope——下一重试轮的并集基底）

> ```hop_python
> pool = flat_points + prior_points
> healthy = [p for p in pool if p["type"] != "inference" or strip(str(p["premises"] if p["premises"] else ""))]
> sick_raw = [p for p in pool if p["type"] == "inference" and not strip(str(p["premises"] if p["premises"] else ""))]
> sick = [{"id": p["id"], "type": "fact", "line_ref": p["line_ref"], "quote": p["quote"], "claim": p["claim"], "premises": ""} for p in sick_raw]
> merged = healthy + sick
> norm_keys = [replace(replace(replace(replace(f"{merged[k]['line_ref']}|{merged[k]['claim']}", " ", ""), "，", ","), "\"", ""), "。", "") for k in range(len(merged))]
> keep = [k for k in range(len(merged)) if not (norm_keys[k] in norm_keys[:k])]
> points = [{"id": f"P{n + 1}", "type": merged[keep[n]]["type"], "line_ref": merged[keep[n]]["line_ref"], "quote": merged[keep[n]]["quote"], "claim": merged[keep[n]]["claim"], "premises": merged[keep[n]]["premises"]} for n in range(len(keep))]
> prior_points = points
> ```

机械并集与重编零 LLM：两轮拼接后**健康条目排前**（premises 非空的推演点与全部事实点在前,空 premises 的在后）再按"行号+归一化断言"去重首见保留;**去重后仍是空 premises 的推演点机械改类为事实点**——文档没写前提的段首论断（如"开放共赢的算力生态是核心支撑"）,提多少轮前提都是空（真机:九发全空连红三轮）;它没有可溯源的前提,前提溯源路径无料可走,按事实点外部检索求证是唯一可行的核查路径（查出来 no_evidence/questionable 就是它应得的判定,如实）——同一断言任何一轮的健康版恒顶掉带病版（真机四轮实撞:首版"本轮在前"让本轮新犯的空 premises 顶掉上轮修好的版,同一条 L28 premises 空连红三轮——优先序按健康度不按轮次）;本轮漏的条目由上轮存根补位。为什么跨轮并集：完备性闸的实测形态是**每轮漏的行完全不同**（漏项随机,三轮漏项交集为空）——全量重提是重新掷骰子,并集让每轮命中都被留下。首轮 prior_points 为空,行为与单轮提取全同。

#### 2.6. [act] 机械分组与机械面预检
- ← doc_content, points, covered_lines
+ → line_jobs: [LineJob]  # 每行一件:行文本+该行 claims（微判定的作业单）
+ → mech_gap: text  # 机械面缺陷清单（推演点 premises 空等——机械可判的不烧 LLM）

> ```hop_python
> doc_lines = [l for l in split(doc_content, "\n") if strip(l) != "" and not (split(l, ":")[0] in covered_lines)]
> line_jobs = [{"line_id": split(l, ":")[0], "line_text": l, "claims": join([p["claim"] for p in points if p["line_ref"] == split(l, ":")[0]], "；")} for l in doc_lines]
> bad_prem = [p for p in points if p["type"] == "inference" and not strip(str(p["premises"] if p["premises"] else ""))]
> mech_gap = join([f"{p['line_ref']} 行的推演点「{p['claim']}」premises 为空——把该结论依赖的前提内容写全,不能留空" for p in bad_prem], "\n")
> ```

机械分组零 LLM：按行号把 points 的 claim 归到各行,产出微判定作业单——**已在销项底册（covered_lines）里的行不再出作业单**：那些行上一轮已判"覆盖齐",重审只给判官翻旧账的机会（真机实撞:同一行前两轮判过关、第三轮突然揪出更细的数量断言——判官逐轮加码,重审面不收窄闸就永不收敛）;推演点 premises 判空这类机械可判项就地出结论,不占后续 LLM 判定的题面。**反馈里点名用行号+claim 原文,不用 P 号**——重试轮全量重提后编号全变,拿上一轮的 P 号找点必然对不上（真机实撞:三轮各报一个不同 P 号的空 premises,每轮都是新犯不是旧账没修——P 号反馈让定向修复失效）。本变体 line_ref 只认单行形态（L2）;区间形态（L23-L25）的点不会归入任何行的 claims——本档语料无跨行断言,区间支持留待母本级需求。

#### 2.7. [loop for-each job in line_jobs, collect line_verdict into line_verdicts] 逐行覆盖微判定
+ → line_verdicts: [LineVerdict]  # 各行覆盖判定（collect 显式收集 line_verdict;并行乱序,条目自含 line_id 可归位）

##### 2.7.1. [subtask parallel] 判定单行覆盖
- ← job
+ → line_verdict: LineVerdict  # 本行的覆盖判定

###### 2.7.1.1. [reason] 单行覆盖判定
> @model deepseek/deepseek-flash
- ← job
+ → line_verdict: LineVerdict  # 本行的覆盖判定（line_id 照抄 job）

按核销清单作业,不做整行印象判断。job.line_text 是文档的一行原文;job.claims 是提取清单里挂在这一行的断言提炼（分号分隔;空串=这行没有任何提取点）。

三步核销（一行里有多个断言时,隐式的整行比对会失焦漏判——先拆清单再逐条对,把比对变显式）：

1. 把 line_text 里的可查证断言逐条列出（数据、事件、时间、引述、因果各算一条）。**标题行（# 开头）与裸名词短语不算断言**——"某某大会:某产品与某技术"这种标题是导航件,没有陈述任何可核查的事实;标题行列不出断言就直接 covered=yes（正文里同一事实自有其陈述行,在那里核）;
2. 每条断言在 claims 里找覆盖它的那一条,逐条写"断言 → 覆盖它的 claim 开头几个字"或"断言 → 无覆盖"。**覆盖判定看内容不看措辞**：claim 提到该断言的内容就算覆盖——说话人前缀（"汪涛指出"）、语气词、句式差异都不影响覆盖成立;断言"某人指出 X"与 claim"X"是同一内容（谁说的不是独立断言,X 才是）;
3. 核销全齐 → covered=yes,missing 留空;有"无覆盖"条目 → covered=no,missing 写清漏的断言内容（写全内容,不写"后半句"这类指代）;这行有实质断言但 claims 是空串 → 必然 covered=no。

禁止评价提炼措辞好坏、禁止评价拆分方式、禁止回答问题之外的任何内容。核销过程写在思考里,交付只有声明的字段。line_id 照抄 job.line_id。

#### 2.8. [act] 机械汇总与销项记账
- ← line_verdicts, mech_gap, line_jobs, covered_lines
+ → gate_red_count: int  # 未过关缺陷数（覆盖缺口数 + 机械面缺陷有无）
+ → gate_gap_text: text  # 缺陷清单草稿（2.9 判红时原样交 extract_gap）
+ → covered_lines: [line]  # 销项底册回写（root scope——本轮判"覆盖齐"的行号并入,下轮 2.6 跳过它们）

> ```hop_python
> norm_all = replace(replace(replace(replace(replace(join([j["claims"] for j in line_jobs], "；"), " ", ""), "，", ","), "\\", ""), "\"", ""), "”", "")
> all_claims_norm = replace(norm_all, "“", "")
> verdicts_n = [{"line_id": v["line_id"], "covered": v["covered"], "missing": str(v["missing"]) if v["missing"] else ""} for v in line_verdicts]
> neg_ids = [v["line_id"] for v in verdicts_n if v["covered"] != "yes" and strip(v["missing"]) and replace(replace(replace(replace(replace(replace(v["missing"], " ", ""), "，", ","), "\\", ""), "\"", ""), "”", ""), "“", "") in all_claims_norm]
> uncovered = [v for v in verdicts_n if v["covered"] != "yes" and not (v["line_id"] in neg_ids)]
> cover_gap = join([f"{v['line_id']} 行有断言未被提取覆盖:{v['missing']}" for v in uncovered], "\n")
> new_ok_lines = [v["line_id"] for v in verdicts_n if v["covered"] == "yes" or (v["line_id"] in neg_ids)]
> covered_lines = covered_lines + [lid for lid in new_ok_lines if not (lid in covered_lines)]
> gate_red_count = len(uncovered) + (0 if strip(mech_gap) == "" else 1)
> gate_gap_text = strip(join([cover_gap, mech_gap], "\n"))
> ```

机械汇总与记账零 LLM：本轮判"覆盖齐"的行（含机械兜底翻正的）并入销项底册回写 root scope——重试轮 2.6 只把未过关的行发给判官,重审面每轮只减不增,判官逐轮加码无处落笔（真机实撞:同一行前两轮判过关、第三轮突然揪出更细的数量断言）。**假阴性机械兜底**：判官报"缺 X"而 X 归一化（剥空白/标点/引号/转义）后逐字在该行 claims 里,是机器可裁决的自相矛盾——机械改判不算缺口。前缀差异型假阴性（missing 比 claim 只多"某某指出"）归小题判据治（"覆盖看内容不看措辞"句）,不进机械兜底——机械匹配做不了语义等价,做复杂启发式反而误伤（真机撞:"成立近8年来"逐字在场判缺→兜底救;"汪涛指出+claim 全文"判缺→判据句治）。

#### 2.9. [check final] 完备性判定
- ← gate_red_count, gate_gap_text
+ → extract_ok: bool  # 判定槽：提取是否完备
+ → extract_gap: text  # 说明槽：漏项清单（通过时置空）

> ```hop_python
> extract_ok = gate_red_count == 0
> extract_gap = "" if extract_ok else gate_gap_text
> ```

带 body 机械判定零 LLM（P11 双槽契约:check 只留判定与说明,记账归 2.8 act 步）：缺陷数为零即过;否则 extract_gap 携缺陷清单触发 subtask retry,2.4 据之补齐重提。判定确定性归引擎——微判定形态里 LLM 只出过原子事实（每行 yes/no）,汇总与门槛全在程序里,判官摇摆无处发生。

### 3. [act] 生成核查点速览与统计
- ← points
+ → points_digest: text  # 速览：首行统计值（总数/事实/推演），后接每点一行（编号｜类型｜行号｜断言）——供 driver 展示给用户过目（信息性呈现，不阻塞执行；用户看到不对可随时中止 run）

> ```hop_python
> n_fact = count([p for p in points if p['type'] == 'fact'])
> n_inf = count([p for p in points if p['type'] == 'inference'])
> digest_lines = [f"{p['id']}｜{'事实' if p['type'] == 'fact' else '推演'}｜{p['line_ref']}｜{p['claim']}" for p in points]
> points_digest = f"共 {count(points)} 个核查点（事实 {n_fact}｜推演 {n_inf}）\n" + join(digest_lines, "\n")
> ```

机械拼速览零 LLM。设计取舍（2026-08-27 作者定"这一波让人审意义不大，先给人看一下列表和统计值就行"）：不设确认停点——提取质量已有 2.4 完备性闸把关，人工逐点确认的边际价值低而中断成本高（run 挂起等人）；速览给人**知情**而非**审批**，看到跑偏随时中止即可。

### 4. [loop for-each point in points, collect check_item into check_result] 逐点并行核查
+ → check_result: [CheckResult]  # 各点核查结论（collect 显式收集 check_item；并行乱序，条目自含 id 可归位）

对每个核查点独立核查，按类型分流（事实点/推演点核查路径不同），结果收集为列表。

#### 4.1. [subtask retry=5 parallel] 核查单个点
- ← point
+ → check_item: CheckResult  # 该点的核查结论（结构化，字段见 Types）

按 point.type 分流：事实点走"搜索→来源打标"，推演点走"前提溯源→推理审查"。

##### 4.1.1. [branch] 按点类型分流核查
- ← point
+ → check_item: CheckResult

###### 4.1.1.1. [case] 事实点核查 (point.type == "fact")
+ → check_item: CheckResult

####### 4.1.1.1.1. [act free] 搜索外部依据
- ← point
+ → evidence: [Evidence]  # 依据清单（每条自带来源名+URL——下游按来源身份打可信度标，无 URL 的条目不收）
- 工具: web_search  # 就 point.claim 检索外部依据

用 web_search 工具就 point.claim 检索至少 2 个关键词组合（每组一次调用,关键词提炼归你裁量——实体+关系词,去疑问语气;首选能命中官方/学术来源的词形,如机构名+数据名）。从返回的结果页清单**择优收集**：每条填一个 Evidence（source/url 照抄结果条目、tier 当场按域名/机构身份标、summary 该来源说了什么、about 留空）。**择优纪律**：同一信息点有 authoritative/reliable 来源就不收 questionable 重复条目；仅当高等级来源覆盖不到该断言（或与断言相关的只有低等级来源）时才收 questionable 兜底——低等级来源不是垃圾，是"仅此一家"时的如实记录。首轮全是低等级时补一次定向检索（限定官方域名/换机构名词形）再收。只收检索结果里真实存在的条目；确实搜不到则输出空列表 []，不编造。

####### 4.1.1.1.2. [act free] 评估依据并对来源可信度打标
- ← point, evidence
+ → check_item: CheckResult  # 本点核查结论（id/line_ref/claim 照抄 point 对应字段）
- 工具: web_search  # 补搜通道（说明里的"信源不足时可补搜"要用——不声明则运行期无此工具）

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

###### 4.1.1.2. [case] 推演点核查 (point.type == "inference")
+ → check_item: CheckResult

####### 4.1.1.2.1. [act free] 前提溯源搜索
- ← point
+ → premise_evidence: [Evidence]  # 各前提的依据清单（每条自带来源名+URL，about=挂靠的前提——下游按来源身份判前提可信度）
- 工具: web_search  # 逐个前提检索依据来源

就 point.premises（该推演依赖的事实前提）用 web_search 工具逐个前提检索，**每条依据填一个 Evidence**：about=该依据对应的前提凝练（一条挂一个前提）、source/url 照抄结果条目（禁编造）、tier 当场按域名/机构身份标、summary=该来源对此前提说了什么。**择优纪律**：优先收 authoritative/reliable，questionable 仅作"高等级覆盖不到"时的兜底（低等级来源不是垃圾，是"仅此一家"时的如实记录）；首轮全低等级补一次定向检索（限定官方域名/换机构名词形）。某前提确实搜不到依据就不为它产条目（下游按"该前提零条目"判 not_found）。不核查推理本身，只核前提真假。

####### 4.1.1.2.2. [act free] 推理审查与二维判定
- ← point, premise_evidence
+ → check_item: CheckResult  # 二维判定装入结构（verdict/credibility=前提维,validity=推理维）
- 工具: web_search  # 补搜通道（前提溯源段的"每前提至多 2 次调用"要用——不声明则运行期无此工具）

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

### 5. [subtask retry=2] 汇聚核查报告并验收完备性
- ← check_result, points
+ → factcheck_report: markdown  # 核查报告

汇聚所有核查结论成报告，再自查完备性——漏点/漏结论则据 report_gap 反馈定向重汇（引擎 retry 上限即轮数上限：首轮 + 2 次重试）。

#### 5.1. [act] 机械渲染逐点章节
- ← check_result, points, numbered_path
+ → report_body: markdown  # 报告机械段：全点判定一览表+依据明细+未核查点清单（零 LLM——体量随点数线性,交给程序拼,输出上限管不到程序）
+ → stats_line: text  # 机械统计行：总点数与各判定档计数（程序数的,总评散文照抄——27b 数不动一百多个点,自己数必错）
+ → problem_ids: text  # 问题点编号清单（refuted/no_evidence/questionable/not_found/leap/invalid 的点,逗号连接;空串=无问题点）——总评的问题清单按此写,不自己扫

> ```hop_python
> vmap = {"supported": "成立", "partially_supported": "部分成立", "refuted": "不成立", "no_evidence": "无依据"}
> rows = [f"| {r['id']} | {r['line_ref']} | {r['claim'][:30] + ('…' if len(r['claim']) > 30 else '')} | {get(vmap, r['verdict'], r['verdict'])} | {r['validity'] if strip(str(r['validity'] if r['validity'] else '')) else r['credibility']} |" for r in check_result]
> table = join(["| 编号 | 行号 | 断言 | 判定 | 等级 |", "|---|---|---|---|---|"] + rows, "\n")
> details = join([f"### {r['id']} {r['claim']}\n\n- 判定：{get(vmap, r['verdict'], r['verdict'])}｜{r['credibility']}{('｜' + str(r['validity'])) if strip(str(r['validity'] if r['validity'] else '')) else ''}｜{r['conclusion']}\n- 依据：{r['evidence_summary']}" for r in check_result], "\n\n")
> checked_ids = [r["id"] for r in check_result]
> unchecked = [p for p in points if not (p["id"] in checked_ids)]
> tail = "" if len(unchecked) == 0 else ("\n\n## 未能核查的点\n\n" + join([f"- {p['id']}（{p['line_ref']}）{p['claim']}——核查未完成" for p in unchecked], "\n"))
> report_body = f"## 全点判定一览\n\n{table}\n\n## 依据明细\n\n{details}{tail}\n\n---\n行号对照文件：{numbered_path}"
> n_sup = count([r for r in check_result if r["verdict"] == "supported"])
> n_part = count([r for r in check_result if r["verdict"] == "partially_supported"])
> n_ref = count([r for r in check_result if r["verdict"] == "refuted"])
> n_noev = count([r for r in check_result if r["verdict"] == "no_evidence"])
> stats_line = f"共核查 {count(check_result)} 个点：成立 {n_sup}｜部分成立 {n_part}｜不成立 {n_ref}｜无依据 {n_noev}；未完成核查 {len(unchecked)} 个"
> prob = [r for r in check_result if r["verdict"] == "refuted" or r["verdict"] == "no_evidence" or r["credibility"] == "questionable" or r["credibility"] == "not_found" or ("leap" in str(r["validity"] if r["validity"] else "")) or ("invalid" in str(r["validity"] if r["validity"] else ""))]
> problem_ids = join([r["id"] for r in prob], ", ")
> ```

机械渲染零 LLM（dv 预审 R7 的修法落地——真机实撞:198 点逐点转写首轮 OUTPUT_TRUNCATED 4096 掐断、重汇轮整段合并写法漏汇 198/198）：check_result 已是结构化字段,一览表/依据明细/未核查清单全部程序拼——**体量随点数线性的段永远不走 LLM 输出通道**。LLM 只写体量近似恒定的总评（5.1）。

#### 5.2. [reason] 撰写总评与问题清单
- ← check_result, stats_line, problem_ids, report_gap
+ → report_head: markdown  # 报告头：总评散文+按严重度降序的问题点清单（体量随问题点数缓增,与总点数无关）

不做新核查、不做任何计数。写报告的开头一节：

- 先一段总评散文,**统计数字逐字照抄 stats_line**（那是程序数的,一个字不改;禁止自己数 check_result——上百个点人肉计数必错）,再补一两句整体可靠性的定性评价;
- 接着按严重度降序逐条列**问题点**——**problem_ids 里列出的每个编号一条,不多不少**（空串=写"未发现问题"）。每条小标题 `P编号（行号）——问题定性`,下面两三句散文：原文断言是什么、问题在哪、关键依据一句（含来源名,从 check_result 对应条目取）。

只写这一节。全点一览表与依据明细已由程序另拼,不要复述任何"成立"点的细节。report_gap 非空时按意见修上一版的总评。

#### 5.3. [act] 机械拼装完整报告
- ← report_head, report_body
+ → factcheck_report: markdown  # 核查报告（总评在前,机械段在后）

> ```hop_python
> factcheck_report = report_head + "\n\n" + report_body
> ```

机械拼接零 LLM。

#### 5.4. [act] 机械核对存在性与降级项
- ← points, check_result, factcheck_report
+ → missing_in_report: text  # 有核查结论但报告漏汇的点编号（真漏汇——重汇能修）
+ → unchecked_ids: text  # 无核查结论的点编号（核查失败——重汇不可能补出结论,只能如实交代）
+ → flagged_items: text  # 被降级/存疑的结论清单（供后继 LLM 审合理性）

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

#### 5.5. [reason] 审查降级项的合理性
- ← flagged_items, check_result, points
+ → downgrade_review: text  # 逐个降级项的合理性复核结论

逐一审查 flagged_items 里每个被降级/存疑的结论（每行=编号+verdict/credibility/validity+结论；需看完整依据时按编号回 check_result 取该条 evidence_summary）——降级是否合理：
- 判断降级判定站得住吗（如标 not_found 是否确实搜过、标 questionable 的来源是否真属立场性、判 leap 的推理跳转是否确有其事）。
- 逐条给复核结论：**降级合理**（维持）或 **降级过苛/误判**（指出应上调，并说明理由）。

输出逐点复核清单（含 point.id、原降级、复核结论）。flagged_items 为空则记"无降级项"。

#### 5.6. [check final] 验收汇总完备性
> @model deepseek/deepseek-flash
- ← missing_in_report, unchecked_ids, downgrade_review, factcheck_report, points
+ → report_ok: bool  # 判定槽：汇总是否完备
+ → report_gap: text  # 说明槽：遗漏清单（通过时置空）

综合判定报告完备性（两类缺失 doctrine 与 examples/hop-deep-research 10.2 是同一条规矩的两处落点——改这边须同步看彼处）。**分工前提**：一览表/依据明细/未核查清单三节由程序机械渲染（5.1），逐点在场性已由 5.4 机核把关（missing_in_report）——判官不逐点数表，只审 LLM 写的总评节与机核报数：① **missing_in_report 必须为空**（机核报数直读——非空即红，不自己重数）；② **unchecked_ids 非空时报告须有"未能核查的点"节**（该节程序拼,一般恒在——只查节存在性）；③ downgrade_review 中标为"误判/过苛"的降级项须已在总评的问题清单体现（未体现=总评失真）；④ 总评散文里的统计数字与 report_body 头部的机械统计行逐字一致（5.1 程序数的,总评只许照抄——不一致=LLM 又自己数了）；⑤ 所有问题点（refuted/no_evidence/questionable/not_found/leap/invalid）都进了总评的问题清单，**且每条的断言描述与 check_result 对应条目的 claim/verdict 内容一致**——编号对但描述文不对题（写成另一件事、判定词与实际不符）=失真，逐条点名打回（真机实撞:P34 实际是智能体工作周期断言,总评写成"市场地位推演";P35 实际 refuted,总评写"questionable"——编号从机械清单抄的所以对,描述是编的）。

全部满足 → report_ok=true、report_gap=""；否则 → report_ok=false，report_gap 逐条列出缺项（触发 subtask retry，5.2 据 report_gap 修总评重拼——机械段不重做）。每轮对着当前报告独立重判，不参考上轮判词——输入里不给 report_gap 与 2.4 同一条规矩（判官读到自己上轮判词会照抄交卷）。打回门槛也同 2.4：只有上列①-⑤的实质缺失才打回且一次列全，行文措辞、排版形态的裁量偏好不是打回理由。

### 6. [exit] 交付核查结果
