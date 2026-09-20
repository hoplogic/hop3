# Spec: hop-deep-research(scope gate + fan-out 搜索 + 抓取 + 对抗式验证(独立性 check) + 引用报告)
<!-- 改本文件的能力面(步骤/词表/交付)需同步 examples/README.md 对应行——README 已两次滞后实撞 -->
Id: hop-deep-research

## Task

Goal: 对一个问题做深度多源研究——scope gate(不具体→问 2-3 澄清题)→拆子问题→fan-out web_search(广度)→选源+抓取页面→对抗式验证(每条 claim 独立第二来源交叉核对 + 独立性 check,核心回路)→综合带引用报告(source 三层分层 + no-silent-supplement + 完备性验收)。
> scope gate → 拆子问题 → loop fan-out web_search → 选源 → loop 抓取 → 提取 claim → loop 对抗验证(交叉核对 + 独立性 check)→ 综合引用报告 + 完备性验收 → 交付。

Constraints:
- scope gate 在研究前:question 不具体才问 2-3 澄清题;具体则直接用
- fan-out 广度:每子问题多查询 web_search
- 对抗式验证是核心回路:每条 claim 用**独立第二来源**(cross_source ≠ claim.source_url,9.1.3 check 强制)交叉核对(supported/partially_supported/refuted/no_evidence——与 fact-check 同一 verdict 词表,改一处须同步改彼处);单源 claim 非发现;冲突双面呈现不静默选边
- source attribution 三层:[settled]/[verify]/[verify-pinpoint] + [web search — verify](cross_source 来自 web_search,标 [web search — verify]) + [local](本地材料提取的 claim),永不合并/strip
- no silent supplement:子问题检索薄(少或无结果)→ flag 不填 model knowledge
- 不编造引用:未验证 claim 标 low-confidence 不当事实陈述
- 完备性验收:每条 claim 须有 verify_result;无 claim 提取 → coverage notes flag

Types:
- Claim:  # 一条待验证的 claim
  - id: line  # C1/C2… 编号
  - statement: text  # claim 内容
  - source_url: line  # claim 来源 URL(本地材料 claim 填本地路径)
  - source_tag: line  # [settled]/[verify]/[verify-pinpoint]/[web search — verify]/[local](本地材料提取的)
  - sub_question: text  # 该 claim 归属的子问题(照抄 sub_questions 对应条目开头一句)——覆盖对齐与逐子问题记账的机械依据
- VerifyResult:  # 一条 claim 的验证结果(9.1 产出单元)
  - id: line  # 对应 Claim.id
  - verdict: enum(supported,partially_supported,refuted,no_evidence)  # 四态判定(与 fact-check CheckResult.verdict 同一词表——改一处须同步改 examples/hop-fact-check.md):独立二源全面支持/部分口径支持或部分过时/被反驳/无独立佐证
  - cross_source: line  # 独立第二来源 URL(无 → 空串)
  - cross_source_tag: line  # 交叉来源标签(通常 [web search — verify])
  - conflict: text  # 冲突双面描述(无冲突 → 空串)

Tools:
- web_search(query) -> result: yaml  # fan-out 检索 + 对抗交叉核对。standalone 注册见 examples/hoptools-websearch.yaml（provider 中立,tool_id 解耦）;复用模式零注册——执行 agent 用自带网页搜索落实
  - query: text  # 检索查询词
- browser_navigate(url) -> result: text  # 抓取源页面(导航)。注册见 examples/hoptools-playwright.yaml
  - url: text  # 页面 URL
- browser_snapshot() -> result: text  # 抓取源页面(快照)。注册见 examples/hoptools-playwright.yaml

Inputs:
- research_question: text  # 研究问题(可能宽泛,scope gate 判)
- local_materials: [line]  # 可选参数。工作目录下的本地对照材料相对路径列表,一条一个路径(如用户给的待核查文章/翻译件/内部文档)——由步骤 7 读入,与网络源同列供 claim 提取与对照。可不传:未传时值为 None(引擎无 Inputs 缺省值语义),None 与 [] 都按"无本地材料"处理(步骤 7 明文)
- report_path: line  # 可选参数。报告落盘路径(工作目录相对,如 reports/aisi-核查.md)——未传(None)或空串时步骤 11 问用户要;报告是研究交付物,不落盘=散在临时变量里随 run 蒸发

Outputs:
- research_report: markdown  # 引用报告(refined question+scope / sub-questions / findings 逐 claim 引用+验证状态 / conflicts 双面 / coverage notes / sources)
- saved_report_path: line  # 报告实际落盘路径(步骤 11.2 commit 写盘)

## Steps

### 1. [reason] scope gate:判 question 是否具体 + 起草澄清题
- ← research_question
+ → is_specific: bool  # question 是否足够具体可直接研究
+ → clarifying_questions: text  # 若不具体,2-3 个澄清题(具体则空)
> 判 research_question 是否足够具体(有明确 scope/region/use-case/timeframe)。具体 → is_specific=true、clarifying_questions="";不具体 → is_specific=false、clarifying_questions 列 2-3 个澄清题(缩窄 scope 用)。

### 2. [branch] scope gate 分流
- ← is_specific, research_question, clarifying_questions
+ → refined_question: text  # 缩窄后的研究问题
> is_specific=true → refined_question=research_question;false → 问澄清题据答案缩窄。

#### 2.1. [case(is_specific)] 具体直用
+ → refined_question: text
##### 2.1.1. [act] 直用原问题
- ← research_question
+ → refined_question: text  # = research_question
> question 具体 → 直接用。
> ```hop_python
> refined_question = research_question
> ```

#### 2.2. [case(else)] 不具体问澄清
+ → refined_question: text
##### 2.2.1. [ask require_human] 问 2-3 澄清题
- ← clarifying_questions
+ → clarifying_answers: text  # 用户对澄清题的回答
> 呈 clarifying_questions 请用户答(缩窄 scope)。driver 无权替答。
##### 2.2.2. [reason] 据答案缩窄问题
- ← research_question, clarifying_answers
+ → refined_question: text  # 据 research_question + clarifying_answers 缩窄后的问题
> 综合 research_question + clarifying_answers 重述缩窄后的研究问题(refined question 是后续研究的契约)。

### 3. [reason] 拆子问题
- ← refined_question
+ → sub_questions: [text]  # 子问题清单(各自可独立研究,合起来答全;含外延角度)
> 把 refined_question 拆成子问题——合起来答全,各自独立可研究。**拆完做一次外延检查**：问题字面之外,下面四类外延角度哪些对答好这个问题有用——有用的补成子问题(通常 1-3 个),没用的不硬凑：
> - **横向先例**：同类事件/方案此前发生过吗,业界怎么处理的；
> - **各方反应**：当事方之外的第三方(社区专家/监管/同行)怎么评论；
> - **后续发展**：事件/决策之后有什么跟进动作；
> - **对照口径**：同一事实是否存在不同统计口径/立场版本。
> 只按字面拆＝研究只有一个平面,外延角度是深度研究区别于问答检索的地方。

### 4. [loop for-each sub_question in sub_questions, collect sub_search into all_searches] fan-out web_search(广度)
- ← sub_questions
+ → all_searches: [yaml]  # 各子问题检索结果 {sub_question, results:[{title,url,abstract}], thin: bool}
> 对每子问题 fan-out web_search(多查询),收集结果。thin(少或无结果)标记。

#### 4.1. [subtask retry=3 parallel] 检索单个子问题
- ← sub_question
+ → sub_search: yaml  # {sub_question, results, thin}
##### 4.1.1. [act free] web_search fan-out
- ← sub_question
+ → sub_search: yaml  # {sub_question, results:[{title,url,abstract}], thin: bool}
- 工具: web_search  # 就 sub_question 多查询检索
> 用 web_search 工具就 sub_question 检索多查询(实体+关系词,去疑问语气)。**中英文查询都发**：同一子问题至少一组中文查询+一组英文查询(主题涉外时英文查官方原始名称——机构名/报告编号/人名用原文)。检索后端普遍有语言偏向(中文后端喂中文词只回中文源),单语言检索会整面漏掉另一语言圈的独立来源——交叉验证要的独立性首先是语言圈独立。收集结果页(title/url/abstract)。结果少或无 → thin=true(no silent supplement,不填 model knowledge)。结果筛选/摘要归 LLM 裁量,故 act free。

### 5. [reason] 选源
- ← all_searches
+ → selected_sources: [yaml]  # 选定的源 {url, title, tier}(tier 词表=authoritative/reliable/questionable,与 fact-check Evidence.tier 同一套——改一处须同步改彼处)
> 从 all_searches 选最相关+权威的源,tier 当场按域名/机构身份标(authoritative=官网/政府/学术库/一手统计;reliable=主流媒体/行业权威二手;questionable=自媒体/百科/匿名/立场性——与 fact-check 同一分级口径),择优 authoritative > reliable > questionable。**官方一手源必选**：检索结果里有当事机构官网/官方报告 PDF 的必须入选;**没命中的不能就此放过**——从已有结果推断官方域名(如机构名→官网域),把"官方源候补"记进该条目(url 填推断的官网入口,tier 标 authoritative 并注"待验证",交 step 6 直接导航验证——验证不实即弃)。一手源缺席的研究,全部 Findings 都悬在转述链上。**选 3-5 个最相关源(不要超过 5——控制 step 6 browser fetch 负载,源多则慢且易失败)**。thin 子问题的源少则如实(coverage notes 由 step 10.1 据 all_searches.thin 写)。**直接返回 selected_sources 的 yaml 列表值本身,不要用 ```yaml 代码围栏包裹、不要在值外再套变量名键**——引擎要的是列表值,围栏包裹会触发 SCHEMA_MISMATCH。

### 6. [loop for-each source in selected_sources, collect fetched into fetched_sources] 抓取源页面
- ← selected_sources
+ → fetched_sources: [yaml]  # 各源抓取内容 {url, content}
> 抓取选定源的全内容供验证。

#### 6.1. [subtask retry=2 parallel] 抓取单个源
- ← source
+ → fetched: yaml  # {url, content}
##### 6.1.1. [act free] browser 抓取+提取
- ← source
+ → fetched: yaml  # {url, content}
- 工具: browser_navigate  # 导航到 source.url
- 工具: browser_snapshot  # 取页面快照提取内容
> 用 browser_navigate(source.url) + browser_snapshot() 抓取页面,提取相关内容。抓取+提取归 LLM 裁量,故 act free。

### 7. [act free] 读入本地对照材料
- ← local_materials
+ → local_docs: [yaml]  # 本地材料内容 [{path, content}](local_materials 空 → [])
> 逐个路径 read(local_materials 是路径列表),每个产 {path, content}(超长材料如实全读,不摘要——对照要原文);读失败的条目产 {path, content: "READ FAILED: <错误>"}如实带出,不静默丢。local_materials 为 None(未传)或 [] → local_docs=[](两种形态都是"无本地材料",不 fail)。本步只读不写。

### 8. [reason] 提取 claim
- ← fetched_sources, local_docs, sub_questions
+ → claims: [Claim]  # 提取的 load-bearing claim 清单(每元素 Claim 五字段全填:id/statement/source_url/source_tag/sub_question)
> 从 fetched_sources 提取 load-bearing claim(关键断言),逐条编号 C1/C2…,标 source_url + source_tag(三层分层),**每条填 sub_question=该 claim 归属的子问题(照抄 sub_questions 对应条目原文——10.05 机械核对按此字段算逐子问题覆盖账,缺填则机械账出垃圾)**。**local_docs 非空时它是研究对象的一部分**:任务要求对本地材料做的核查/对照(如翻译忠实度抽查),从中提取对应 claim(source_url 填本地路径,source_tag 标 [local]),与网络 claim 同列进验证回路。
> **提取覆盖对齐子问题(硬纪律)**：提完按 sub_questions 逐个自查——每个子问题至少有 1 条 claim 落在它上面;某子问题确实提不出可验证断言(如纯规划类内容)才允许零条,但必须能说出为什么。**只挑好验证的数字断言、绕开难验证的方案设定=覆盖失衡**——方案设定同样能提成可验证 claim(如"三阶段渐进结构与 ACSM 渐进原则一致"/"每周 150 分钟中强度设定符合 WHO 2020 指南"——把设定与权威口径的符合性作为 statement)。**对照/缺失型 claim 也是合法形态**(对照评估类子问题的承载体):"本材料未包含 X,而公认实践普遍包含 X"——前半句对本地材料可查证,后半句对外部源可查证,两半都可验;评估类子问题不要因为"不是数字断言"就零提取。无 claim 提取 → claims=[](step 10.1 coverage notes flag)。

### 9. [loop for-each claim in claims, collect verify_result into verify_results] 对抗式验证(核心回路 + 独立性 check)
- ← claims
+ → verify_results: [VerifyResult]  # 各 claim 验证结果(enum 强制 verdict 四态)
> 对每条 claim 用独立第二来源交叉核对(supported/partially_supported/refuted/no_evidence 四态),独立性 check 强制 cross_source ≠ claim.source_url,冲突双面呈现。核心回路。

#### 9.1. [subtask retry=3 parallel] 验证单条 claim
- ← claim
+ → verify_result: VerifyResult  # 本 claim 验证结果(verdict enum 四态引擎强制)
##### 9.1.1. [act free] web_search 交叉核对
- ← claim
- 工具: web_search  # 独立第二来源交叉检索(不写授权行引擎不下发——实撞:16 条 claim 全 no_evidence,执行者自救叙述"可用工具清单中未注册 web_search")
+ → cross_source: line  # 独立第二来源 URL(非 claim 原来源)
+ → cross_evidence: text  # 交叉核对证据(支持/反驳/无佐证)
> 用 web_search 工具就 claim.statement 检索**独立第二来源**(非 claim.source_url),取其 URL 作 cross_source + 收集证据。**找独立来源优先换语言圈检索**(claim 源是中文就用英文查询再搜一次,反之亦然)——同语言圈的"独立 URL"常是同一份一手材料的转述链(URL 独立≠独立测量),换语言圈更容易命中真正独立的报道与评论。**检索有硬上限：至多 6 次 web_search 调用(两语言圈各至多 3 次)**,用完仍无独立来源就接受现状——cross_source="" 判 no_evidence 是完全合法的结论,meta 型/细节型 claim 常常就是没有独立二源,无底洞检索只会烧掉工具轮次配额(引擎 20 轮硬闸,超限本 child 直接死,连 no_evidence 都产不出)。cross_source 来自 web_search → 标 [web search — verify](9.1.2 写入 cross_source_tag)。无独立来源 → cross_source=""(9.1.2 判 no_evidence)。**web_search 工具调用失败(连接错/超时/无结果)不得 fail 本步/本 child——产 cross_source="" + cross_evidence="web_search failed: <错误>"**,claim 按 no_evidence(无独立佐证)处理。**确保每条 claim 都产 verify_result(失败也产,标 no_evidence),不缺席**——这是"每条 claim 须有 verify_result"的保障(10.2 check 核)。
##### 9.1.2. [reason] 四态判定 + 冲突
- ← claim, cross_source, cross_evidence
+ → verify_result: VerifyResult  # 本 claim 验证结果(9.1.2 组装,verdict enum 引擎强制)
> 据 cross_evidence 判:supported(第二来源全面确认)→ keep;partially_supported(部分口径支持/部分过时——证据打架但没到反驳)→ flag 双面;refuted(第二来源反驳)→ flag 冲突;no_evidence(cross_source 空或所得与断言无关)→ flag low-confidence。冲突双面呈现(claim 来源 vs 交叉来源),不静默选边。cross_source_tag="[web search — verify]"(cross_source 来自 web_search)。输出 verify_result。
##### 9.1.3. [check final] 独立性 gate(核心纪律,不可跳)
- ← cross_source, claim
+ → independent_ok: bool  # cross_source != claim.source_url(独立)
+ → independent_note: text  # 通过置空;失败写"cross_source 与原来源相同——非独立核对"
> 核心纪律 gate:cross_source 必须独立于 claim 原来源(cross_source != claim.source_url)。相同 → independent_ok=false(触发 retry,9.1.1 重检找独立源);空 cross_source(no_evidence)→ independent_ok=true(空 ≠ source_url,非同源,允许 no_evidence verdict)。此 check 强制"独立第二来源"纪律(源"a single-source claim is not a finding"的结构屏障)。
> ```hop_python
> independent_ok = cross_source != claim.source_url
> independent_note = "" if independent_ok else "cross_source same as original source - not independent"
> ```

### 10. [subtask retry=2] 综合引用报告 + 完备性验收
+ → research_report: markdown  # 引用报告

#### 10.05. [act] 机械核对验证完备性
- ← claims, verify_results, sub_questions
+ → unverified_ids: text  # 无 verify_result 的 claim 编号(验证失败点——报告"未能验证"节的机械依据)
+ → sq_coverage: text  # claim→子问题归属清单(每行"编号 ← 子问题"——逐子问题计数由消费方按此机械清单数,零 claim 子问题=清单里不出现的)
+ → nonsupported_ids: text  # verdict 非 supported 的编号清单(Findings 准入负面名单)
> ```hop_python
> claim_ids = [c["id"] for c in claims]
> verified_ids = [v["id"] for v in verify_results]
> unverified_ids = join([cid for cid in claim_ids if not (cid in verified_ids)], ", ")
> claim_sq_pairs = [f"{c['id']} ← {c['sub_question']}" for c in claims]
> sq_coverage = join(claim_sq_pairs, "\n")
> nonsupported_ids = join([v["id"] for v in verify_results if v["verdict"] != "supported"], ", ")
> ```

#### 10.1. [reason] 综合引用报告
- ← refined_question, sub_questions, all_searches, verify_results, claims, local_docs, unverified_ids, sq_coverage, nonsupported_ids
+ → research_report: markdown  # 引用报告
> 汇聚成 Markdown 报告(**三份机械账直接用,不自算**:unverified_ids=未能验证节名单、sq_coverage=Coverage notes 逐子问题计数、nonsupported_ids=Findings 准入负面名单——机械账与你的逐条判断冲突时以机械账为准):
> - Refined question + scope
> - Sub-questions addressed
> - Findings(**仅含 verify_result.verdict==supported 的 claim**:statement + source_url + source_tag + verdict + cross_source + cross_source_tag)。**verdict==partially_supported/refuted/no_evidence 或无 verify_result(缺失/未验证)的 claim 进 conflicts/low-confidence 节,绝不进 Findings**(partially_supported 双面呈现)——单源/未验证 claim 非发现(核心纪律)。无 verify_result 的 claim = 未验证,标 low-confidence,**不得给它 verdict 放 Findings**。
> - Conflicts(双面:claim 来源 vs 交叉来源 + tier 注)
> - **未能验证的 claim**(仅在有时):claims 里有、verify_results 里没有对应记录的(验证子任务重试耗尽的失败点)——逐条列 id+statement+"验证未完成",归 low-confidence。**如实交代即算完备**,不猜测其 verdict——重汇变不出失败 child 的验证结果。
> - **对照评估**(任务含评估/对照类问题时):基于已验证 claim 与检索所得源,回答"缺失什么/独特优点是什么"类评估问题——逐条带来源引用,节首明标"本节是评估性综合,非逐条验证的 Finding"。评估结论只许建立在上方 Findings 与检索实得源上,不引入无源的 model knowledge。没有这个家,评估类子问题的答案会被 Findings-only 结构静默挤出交付物(实撞:最佳实践对照检索了却零字进正文)。
> - Coverage notes(thin 子问题 flag,不静默填;无 claim 提取 → flag;**逐子问题列 claim 覆盖数**——某子问题零 claim 的写明原因,检索有料但没提成 claim 的如实标"检索覆盖但未提取验证",不许用"检索覆盖充分"掩盖验证缺口)
> - Sources(全列表 + tag)
> 不编造引用;未验证 claim 标 low-confidence 不当事实陈述。

#### 10.2. [check final] 完备性验收(核心回路验收门,不可跳)
- ← claims, verify_results, all_searches, research_report, sub_questions, unverified_ids, sq_coverage, nonsupported_ids
+ → report_ok: bool  # 每条 claim 有 verify_result + 无单源 claim 作发现 + thin flag + 空 claim flag
+ → report_note: text  # 通过置空;失败写缺口
> 核心回路验收门(两类缺失 doctrine 与 examples/hop-fact-check.md 5.4 是同一条规矩的两处落点——改这边须同步看彼处)——**判据以 10.05 机械账为准,缺失分两类,索要的东西必须是 10.1 重汇补得出的**:① 有 verify_result 的 claim 报告里都要有落点(Findings 或 Conflicts/low-confidence——真漏汇,重汇能修);①' unverified_ids 里的编号(验证子任务失败点)在"未能验证"节如实列出即可——**不得要求补验证结果**(重汇变不出失败 child 的 verdict,索要不可能的东西=retry 烧光 run 报废在最后一步);② nonsupported_ids 里的编号不得出现在 Findings 节(单源/存疑/被反驳 claim 非发现);③ thin 子问题在 Coverage notes flag;④ 无 claim 提取时 Coverage notes flag;⑤ sq_coverage 清单里未出现的子问题(零 claim)在 Coverage notes 有逐个交代(为什么没提出可验证断言——交代即过,索要的是说明不是补提取)。全满足 → report_ok=true、report_note="";否则 false + note 写缺口(触发 retry,10.1 据缺口补)。

### 11. [subtask] 报告落盘交付
- ← research_report, report_path, refined_question
+ → saved_report_path: line  # 实际写盘路径

#### 11.1. [branch] 落盘路径来源分流
- ← report_path
+ → final_path: line  # 定下来的落盘路径

##### 11.1.1. [case(report_path)] 参数已给——直接用
+ → final_path: line
###### 11.1.1.1. [act] 采用参数路径
- ← report_path
+ → final_path: line
> ```hop_python
> final_path = report_path
> ```

##### 11.1.2. [case(else)] 未给——问用户存哪
+ → final_path: line
###### 11.1.2.1. [ask] 问报告保存路径
- ← refined_question
+ → final_path: line  # 用户给的落盘路径(工作目录相对)
> 报告已生成,问用户存到哪(给一个据 refined_question 起的缺省建议名,如 reports/<主题短语>-研究报告.md,用户可改可采纳)。要的是路径值。

#### 11.2. [commit] 写盘报告
- ← research_report, final_path
+ → saved_report_path: line  # 写盘确认路径
> 交付写盘(持久产物归 commit——写盘前 final_path 已经参数或 ask 定值,人已知情):
> ```hop_python
> write(path: final_path, content: research_report)
> saved_report_path = final_path
> ```

### 12. [exit] 交付
- ← research_report, saved_report_path
> 交付 research_report(全文)+ saved_report_path(落盘位置)。对抗验证(独立性 check)+ 完备性验收 + 落盘交付已完成。
