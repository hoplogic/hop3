# Spec: hop-deep-research(scope gate + fan-out 搜索 + 对抗式验证(独立性 check) + 引用报告)
<!-- 改本文件的能力面(步骤/词表/交付)需同步 examples/README.md 对应行——README 已两次滞后实撞 -->
<!-- 【模型变体】源母本=examples/hop-deep-research/hop-deep-research.md;生成 2026-09-29(手工降档);目标 profile=qwen-flash。降档动作四处:
     ①检索机械化(5.x、13.1.x):母本让模型在 act free 步自己调 web_search 再交出 URL。qwen-flash 实跑全程只真检索 6 次,其余编 example.com 网址和数字;交叉核对步凭自身知识判"2026 年是未来日期无公开报道"。变体改成:模型只拟检索词→程序逐条检索、去重、给结果编号→模型只按编号挑选→程序按编号照抄 URL/标题/来源。模型碰不到 URL,编造无从发生;母本 9.1.2 按标题重搜核验随之撤掉;
     ②独立性机械化(13.1.3):交叉核对的候选清单里,程序先剔掉与断言原来源同一网址的条目——模型挑到的一定是另一个来源,13.1.6 独立性闸保留作防线;
     ③抓取腿撤掉(母本 5、6):claim 从检索结果摘要与本地材料里提取(与 examples/hop-fact-check.qwen-flash.md 同一做法)。本地材料读取改成程序直读(变体 8-10;母本 7 是 act free);claim 提取拆成网络结果、本地材料各一步(变体 11.1/11.2——合在一步时本地材料一条没被提取);
     ④报告机械化(14.x):Findings/冲突与存疑/未能验证/逐子问题覆盖数/来源清单全部由程序按 verdict 字段分节拼装,模型只写综述与对照评估。母本实跑 qwen-flash 把口径不同的两个数(计划募资 60 亿 vs 按发行价算的 61.19 亿)判成矛盾并称"应以 60 亿为准"——变体在判定步写明口径差异的处理,报告节归属归程序。
     母本改动后本变体须重新生成 -->
Id: hop-deep-research

## Task

Goal: 对一个问题做深度多源研究——scope gate(不具体→问 2-3 澄清题)→拆子问题→fan-out web_search(广度)→从检索结果与本地材料提取 claim→对抗式验证(每条 claim 独立第二来源交叉核对 + 独立性 check,核心回路)→综合带引用报告(source 分层 + no-silent-supplement + 完备性验收)。
> scope gate → 拆子问题 → loop 拟检索词 + 程序检索编号 → 读本地材料 → 按编号提取 claim → loop 对抗验证(拟检索词 + 程序检索并剔除同源 + 按编号挑交叉来源 + 独立性 check)→ 程序拼报告机械段 + 模型写综述 + 验收 → 交付。

Constraints:
- scope gate 在研究前:question 不具体才问 2-3 澄清题;具体则直接用
- fan-out 广度:每子问题多条检索词,中英文都发
- 检索全部由程序执行:模型只拟检索词、按编号挑选;所有 URL/标题/来源名都是程序从检索结果照抄的原文
- 对抗式验证是核心回路:每条 claim 用**独立第二来源**(cross_source ≠ claim.source_url——候选清单里程序已剔除同一网址,13.1.6 check 再兜底)交叉核对(supported/partially_supported/refuted/no_evidence——与 fact-check 同一 verdict 词表,改一处须同步改彼处);单源 claim 非发现;冲突双面呈现不静默选边
- source attribution:verify(claim 来自网络检索结果)+ web-search-verify(cross_source 来自 web_search)+ local(本地材料提取的 claim),永不合并/strip。标签值恒写裸词(如 `source_tag: verify`),不带方括号
- no silent supplement:子问题检索薄(少或无结果)→ flag 不填 model knowledge
- 不编造引用:未验证 claim 标 low-confidence 不当事实陈述
- 完备性验收:每条 claim 须有 verify_result;无 claim 提取 → coverage notes flag

Types:
- SubQ:  # 一个编号子问题(程序给子问题编号)
  - no % line  # 子问题编号 Q1/Q2…
  - text % text  # 子问题原文
- SearchQuery:  # 一条检索词(模型拟定,程序照着检索)
  - query % line  # 检索查询词(实体+关系词,去疑问语气)
- Candidate:  # 一条候选检索结果(程序从 web_search 返回的结果页清单里逐条取出——标题、链接、来源名都是检索服务原文,没经过模型)
  - no % line  # 候选编号(子问题检索的全局清单用 S1/S2…;交叉核对的清单用 X1/X2…)
  - sq % line  # 产出这条结果的子问题编号(Q1…;交叉核对清单留空)
  - title % line  # 页面标题(检索结果原文)
  - url % line  # 页面链接(检索结果原文)
  - source % line  # 来源名(检索结果的 hostname 字段原文)
  - snippet % text  # 结果摘要(检索结果原文,截前 300 字)
- LocalDoc:  # 一份本地材料(程序直读)
  - no % line  # 材料编号 M1/M2…
  - path % line  # 材料路径
  - content % text  # 材料全文(读失败 → "READ FAILED: <原因>")
- ClaimDraft:  # 模型提取的一条 claim 草稿(来源只给编号)
  - statement % text  # claim 内容——一句可独立查证的断言
  - source_no % line  # 出处编号:检索候选的 S 编号或本地材料的 M 编号,照抄清单里的编号
  - source_tier % enum(authoritative,reliable,questionable)  # 出处可信度:官网/政府/学术库/一手统计 authoritative;主流媒体/行业权威二手 reliable;自媒体/百科/匿名/立场性 questionable。本地材料按其身份标(不明就标 questionable)。词表与 fact-check Evidence.tier 同一套
  - sq_no % line  # 归属子问题编号(Q1…),照抄子问题清单里的编号
- Claim:  # 一条待验证的 claim(程序按草稿的编号组装)
  - id % line  # C1/C2… 编号(程序编)
  - statement % text  # claim 内容(照抄草稿)
  - source_url % line  # claim 来源 URL(本地材料 claim 填本地路径)——程序按 source_no 照抄
  - source_name % line  # 来源名与页面标题——程序按 source_no 照抄
  - source_tier % line  # 出处可信度(照抄草稿)
  - source_tag % line  # verify(检索结果)或 local(本地材料)——程序按编号前缀定
  - sub_question % text  # 归属子问题原文——程序按 sq_no 照抄
- CrossJudgement:  # 模型对一条 claim 的交叉核对判定(来源只给编号)
  - cross_no % line  # 挑中的交叉来源编号(照抄候选清单里的 X 编号);没有可用的 → 空串
  - same_caliber % bool  # 先答这一问:交叉来源与 claim 说的是不是同一口径的同一件事(同一指标、同一时点/阶段、同一统计范围)?口径不同或拿不准 → false
  - verdict % enum(supported,partially_supported,refuted,no_evidence)  # 四态判定
  - evidence % text  # 交叉来源说了什么(与 claim 的关系:支持什么、反驳什么、口径差异在哪)
  - conflict % text  # 冲突双面描述(claim 说什么 vs 交叉来源说什么);无冲突 → 空串
- VerifyResult:  # 一条 claim 的验证结果(13.1 产出单元,程序组装)
  - id % line  # 对应 Claim.id
  - verdict % enum(supported,partially_supported,refuted,no_evidence)  # 四态判定(与 fact-check CheckResult.verdict 同一词表——改一处须同步改 examples/hop-fact-check.md)
  - cross_source % line  # 独立第二来源 URL(无 → 空串)——程序按编号照抄
  - cross_source_name % line  # 交叉来源名与页面标题——程序按编号照抄
  - cross_source_tag % line  # 交叉来源标签,裸词(有交叉来源时 web-search-verify,无 → 空串)
  - evidence % text  # 交叉来源说了什么(照抄判定)
  - conflict % text  # 冲突双面描述(无冲突 → 空串)
  - rejected % text  # 判定步挑了候选清单里没有的编号时的记录(该挑选已作废,本条落 no_evidence);正常 → 空串

Tools:
- web_search(query) -> result % yaml  # 网页检索:查询词→结果页清单(每条含标题/URL/摘要)。standalone 注册见 examples/hoptools-websearch.yaml
  - query % text  # 检索查询词

Inputs:
- research_question % text  # 研究问题(可能宽泛,scope gate 判)
- local_materials % [line]  # 可选参数。工作目录下的本地对照材料相对路径列表,一条一个路径——由步骤 8-10 读入,与网络检索结果同列供 claim 提取与对照。可不传:未传时值为 None,None 与 [] 都按"无本地材料"处理
- report_path % line  # 可选参数。报告落盘路径(工作目录相对)——未传(None)或空串时步骤 15 问用户要

Outputs:
- research_report % markdown  # 引用报告(refined question / sub-questions / 综述 / findings 逐 claim 引用+验证状态 / conflicts 双面 / coverage notes / sources)
- saved_report_path % line  # 报告实际落盘路径(步骤 15.2 commit 写盘)

## Steps

### 1. [reason] scope gate:判 question 是否具体 + 起草澄清题
- ← research_question
+ → is_specific % bool  # question 是否足够具体可直接研究
+ → clarifying_questions % text  # 若不具体,2-3 个澄清题(具体则空)
> 判 research_question 是否足够具体(有明确 scope/region/use-case/timeframe)。具体 → is_specific=true、clarifying_questions="";不具体 → is_specific=false、clarifying_questions 列 2-3 个澄清题(缩窄 scope 用)。

### 2. [branch] scope gate 分流
- ← is_specific, research_question, clarifying_questions
+ → refined_question % text  # 缩窄后的研究问题
> is_specific=true → refined_question=research_question;false → 问澄清题据答案缩窄。

#### 2.1. [case(is_specific)] 具体直用
+ → refined_question % text
##### 2.1.1. [act] 直用原问题
- ← research_question
+ → refined_question % text  # = research_question
> question 具体 → 直接用。
> ```hop_python
> refined_question = research_question
> ```

#### 2.2. [case(else)] 不具体问澄清
+ → refined_question % text
##### 2.2.1. [ask require_human] 问 2-3 澄清题
- ← clarifying_questions
+ → clarifying_answers % text  # 用户对澄清题的回答
> 呈 clarifying_questions 请用户答(缩窄 scope)。driver 无权替答。
##### 2.2.2. [reason] 据答案缩窄问题
- ← research_question, clarifying_answers
+ → refined_question % text  # 据 research_question + clarifying_answers 缩窄后的问题
> 综合 research_question + clarifying_answers 重述缩窄后的研究问题(refined question 是后续研究的契约)。

### 3. [reason] 拆子问题
- ← refined_question
+ → sub_questions % [text]  # 子问题清单(各自可独立研究,合起来答全;含外延角度)
> 把 refined_question 拆成子问题——合起来答全,各自独立可研究。**拆完做一次外延检查**:问题字面之外,下面四类外延角度哪些对答好这个问题有用——有用的补成子问题(通常 1-3 个),没用的不硬凑:
> - **横向先例**:同类事件/方案此前发生过吗,业界怎么处理的;
> - **各方反应**:当事方之外的第三方(社区专家/监管/同行)怎么评论;
> - **后续发展**:事件/决策之后有什么跟进动作;
> - **对照口径**:同一事实是否存在不同统计口径/立场版本。
> 只按字面拆＝研究只有一个平面,外延角度是深度研究区别于问答检索的地方。子问题总数控制在 4-7 个。

### 4. [act] 子问题编号
- ← sub_questions
+ → sq_list % [SubQ]  # 编号后的子问题清单(Q1/Q2…)
> ```hop_python
> sq_list = [{"no": f"Q{i + 1}", "text": str(sub_questions[i])} for i in range(len(sub_questions))]
> ```
> 纯机械编号(引擎直执,零 LLM)。后续提取与记账都按编号对子问题,不靠模型抄写子问题原文。

### 5. [loop for-each sq in sq_list, collect sub_search into all_searches] fan-out 检索(广度)
+ → all_searches % [yaml]  # 各子问题检索结果 {sq_no, sq_text, results:[Candidate], thin: bool}
> 对每个子问题拟检索词、程序检索,收集结果。结果少于 3 条标 thin。

#### 5.1. [subtask retry=3 parallel] 检索单个子问题
- ← sq
+ → sub_search % yaml  # {sq_no, sq_text, results, thin}

##### 5.1.1. [reason] 拟定检索词
- ← sq, refined_question
+ → queries % [SearchQuery]  # 3~4 条检索词(至少一条中文、一条英文)
> @thinking off

为子问题 sq.text 拟 3~4 条检索词,交给程序去检索(你不用、也不能自己检索——下一步由程序逐条调检索服务,把结果编好号供后面挑选)。拟法:

- 检索词 = 子问题里的核心实体 + 关系词/数据项,去掉疑问语气(如子问题"燧原科技的发行价与募资总额是多少?"→ `燧原科技 发行价 募资总额`);
- **中英文都发**:至少一条中文、一条英文(英文查官方原始名称——机构名/报告编号/人名用原文)。检索后端普遍有语言偏向,单语言检索会整面漏掉另一语言圈的独立来源;
- 可加一条冲着一手信源构造(公告、招股书、官方报告的正式名称)。

实体名照抄 sq.text 与 refined_question 原文的字,不改写、不换同音字。

**本步不许拒绝、不许报"缺信息"**:子问题宽泛、涉及你不了解的事件、日期看起来在"未来",都照样拿关键词拟检索词——你的知识有截止日期,检索服务里有你不知道的新近报道。搜不到会如实标 thin,这是合法结论。

##### 5.1.2. [loop for-each q in queries] 逐条检索
+ → pool % [Candidate] = []  # 全部检索词的结果合并清单(尚未去重编号)

对每条检索词调一次 web_search,把返回的结果页逐条追加进 pool。

###### 5.1.2.1. [act] 检索并追加候选
- ← q, pool, sq
+ → pool % [Candidate]  # 追加本条检索结果后的清单
> ```hop_python
> r = web_search(query: q["query"])
> pages = get(r, "pages", []) if r else []
> pool = pool + [{"no": "", "sq": sq["no"], "title": str(get(pg, "title", "") or ""), "url": str(get(pg, "url", "") or ""), "source": str(get(pg, "hostname", "") or ""), "snippet": str(get(pg, "snippet", "") or "")[:300]} for pg in pages]
> ```
> 纯机械检索(引擎直执,零 LLM):结果页的标题、链接、来源名、摘要都是检索服务返回的原文。检索服务本身出错(网络断、限流)时本步失败,由 5.1 的重试把这个子问题整个重做。

##### 5.1.3. [act] 本子问题结果去重截断
- ← pool, sq
+ → sub_search % yaml  # {sq_no, sq_text, results, thin}
> ```hop_python
> keys = [lower(strip(c["url"])) for c in pool]
> keep = [k for k in range(len(pool)) if keys[k] and not (keys[k] in keys[:k])]
> results = [pool[k] for k in keep][:10]
> sub_search = {"sq_no": sq["no"], "sq_text": sq["text"], "results": results, "thin": len(results) < 3}
> ```
> 纯机械去重(按 URL,只留第一次出现的)并截到前 10 条——控制后面提取步的候选清单长度。无 URL 的条目丢弃。

### 6. [loop for-each s in all_searches] 合并全部子问题的检索结果
+ → merged % [Candidate] = []  # 各子问题结果顺次合并(尚未全局去重编号)

#### 6.1. [act] 追加本子问题结果
- ← s, merged
+ → merged % [Candidate]
> ```hop_python
> merged = merged + get(s, "results", [])
> ```

### 7. [act] 全局去重编号
- ← merged
+ → candidates % [Candidate]  # 全局去重后编号 S1/S2… 的检索候选清单
> ```hop_python
> keys = [lower(strip(c["url"])) for c in merged]
> keep = [k for k in range(len(merged)) if keys[k] and not (keys[k] in keys[:k])]
> candidates = [{"no": f"S{n + 1}", "sq": merged[keep[n]]["sq"], "title": merged[keep[n]]["title"], "url": merged[keep[n]]["url"], "source": merged[keep[n]]["source"], "snippet": merged[keep[n]]["snippet"]} for n in range(len(keep))]
> ```
> 纯机械编号:同一网址被几个子问题都搜到时只留第一次出现的条目(sq 记最先搜到它的子问题,提取步可按内容把 claim 归到别的子问题)。

### 8. [act] 规范本地材料清单
- ← local_materials
+ → mats % [line]  # 本地材料路径清单(未传 → 空列表)
> ```hop_python
> mats = local_materials if local_materials else []
> ```

### 9. [loop for-each p in mats, collect doc into raw_docs] 逐个读入本地材料
+ → raw_docs % [yaml]  # [{path, content}]

#### 9.1. [act] 读一份材料
- ← p
+ → doc % yaml  # {path, content}
> ```hop_python
> e = parse_json(exists(path: p))
> content = ""
> if get(e, "exists", False):
>     content = read(path: p)
> else:
>     content = "READ FAILED: 文件不存在"
> doc = {"path": p, "content": str(content)}
> ```
> 纯机械读入(引擎直执,零 LLM):超长材料如实全读不摘要;文件不存在的条目如实带出 READ FAILED,不静默丢。

### 10. [act] 本地材料编号
- ← raw_docs
+ → local_docs % [LocalDoc]  # 编号 M1/M2… 的本地材料
> ```hop_python
> local_docs = [{"no": f"M{i + 1}", "path": raw_docs[i]["path"], "content": raw_docs[i]["content"]} for i in range(len(raw_docs))]
> ```

### 11. [subtask] 按编号提取 claim(网络结果与本地材料各提一次)
+ → drafts % [ClaimDraft]  # 网络结果里提出的 claim 草稿(出处填 S 编号)
+ → local_drafts % [ClaimDraft]  # 本地材料里提出的 claim 草稿(出处填 M 编号;无本地材料 → [])

(本地材料单独一步提:真机实撞——网络结果与本地材料放在同一步里提,qwen-flash 60 多条网络结果看完就收手,本地材料一条没提,"本地材料是研究对象的一部分"整段落空。)

#### 11.1. [reason] 从网络结果提取 claim
- ← candidates, sq_list, refined_question
+ → drafts % [ClaimDraft]  # claim 草稿清单(出处与子问题都只填编号)

candidates 是程序从检索服务取回的真实结果(编号 S1/S2…,带子问题编号 sq、标题、链接、来源名、摘要)。从中提取与 refined_question 相关的 load-bearing claim(关键断言),每条填一个 ClaimDraft:

- statement:一句可独立查证的断言,补全主语(脱离上下文单看也知道在说什么)。数字、日期、名称照抄出处原文的字,不换算、不改写;
- source_no:这条断言出自哪一条——照抄 candidates 的 S 编号。**只能填清单里有的编号**,断言内容必须能在该条的摘要里找到;
- source_tier:按出处的来源名/域名身份标;
- sq_no:归属哪个子问题——照抄 sq_list 的编号。

**claim 必须是关于研究对象本身的断言**,不写关于检索过程的话——"检索结果中未提供 X 的数据"不是 claim(它没法拿另一个来源去核对,实撞:这样一条被交叉核对判成"被反驳",白占一个名额);某子问题查不到就让它零条,覆盖数会如实显示。

**提取覆盖对齐子问题(硬纪律)**:提完按 sq_list 逐个自查——每个子问题至少有 1 条 claim 落在它上面;某子问题的检索结果里确实没有可验证断言时才允许零条。**对照/缺失型 claim 也是合法形态**(对照评估类子问题的承载体):"本材料未包含 X,而公认实践普遍包含 X"。总数控制在 8-20 条;同一事实多个出处都写了的只提一条(选可信度最高的出处)。无可提 → []。

#### 11.2. [reason] 从本地材料提取 claim
- ← local_docs, sq_list, refined_question
+ → local_drafts % [ClaimDraft]  # 本地材料 claim 草稿(出处填 M 编号)

local_docs 是用户给的本地材料(编号 M1/M2…,content 是材料全文;content 以 "READ FAILED" 开头的是没读到的材料,跳过)。local_docs 为空 → 直接交 []。

本地材料是研究对象的一部分——用户给它就是要拿它和网络上的报道对照。从每份读到的材料里提出与 refined_question 相关的关键断言,**每份材料至少 3 条**(材料里的日期、金额、比例、项目名称、盈亏状况这类硬事实优先),每条填一个 ClaimDraft:

- statement:一句可独立查证的断言,补全主语;数字、日期、名称照抄材料原文的字,不换算、不改写。原文用"分别"把几个项目和几个金额按顺序对应起来时(如"三个项目分别拟投入 15.03 亿元、11.97 亿元和 33 亿元"),写成"第一个项目 15.03 亿元、第二个项目 11.97 亿元……"逐一配对,核对顺序后再写——配错一个金额,整条断言就是错的(实撞:把第二个金额配给了第三个项目);
- source_no:照抄该材料的 M 编号;
- source_tier:本地材料一律标 questionable(出处身份不明,要靠后面的网络核对来定);
- sq_no:归属哪个子问题——照抄 sq_list 的编号。

总数 3-10 条。

### 12. [act] 按编号组装 claim
- ← drafts, local_drafts, candidates, local_docs, sq_list
+ → claims % [Claim]  # 组装后的 claim 清单(来源、子问题都由程序按编号照抄)
+ → dropped_drafts % text  # 出处编号不在清单里而被丢弃的草稿记录(无 → 空串)
+ → report_gap % text  # 综述验收反馈通道(本步置空;root scope 声明,14 号子任务内 14.2/14.4 读写命中同一 scope)
> ```hop_python
> dd = (drafts if drafts else []) + (local_drafts if local_drafts else [])
> sn = [c["no"] for c in candidates]
> mn = [d["no"] for d in local_docs]
> refs = [{"d": d, "s": strip(str(get(d, "source_no", "") or "")), "q": strip(str(get(d, "sq_no", "") or ""))} for d in dd]
> ok = [r for r in refs if r["s"] in sn or r["s"] in mn]
> dropped_drafts = join([f"「{str(get(r['d'], 'statement', ''))}」标的出处编号 {r['s']} 不在清单里,已丢弃" for r in refs if not (r["s"] in sn or r["s"] in mn)], "\n")
> srcs = [candidates[int(r["s"][1:]) - 1] if startswith(r["s"], "S") else {"url": local_docs[int(r["s"][1:]) - 1]["path"], "title": local_docs[int(r["s"][1:]) - 1]["path"], "source": "本地材料"} for r in ok]
> claims = [{"id": f"C{i + 1}", "statement": str(get(ok[i]["d"], "statement", "")), "source_url": srcs[i]["url"], "source_name": f"{srcs[i]['source']}《{srcs[i]['title']}》", "source_tier": str(get(ok[i]["d"], "source_tier", "")), "source_tag": "verify" if startswith(ok[i]["s"], "S") else "local", "sub_question": ([s["text"] for s in sq_list if s["no"] == ok[i]["q"]] + ["(未标子问题)"])[0]} for i in range(len(ok))]
> report_gap = ""
> ```
> 纯机械组装(引擎直执,零 LLM):claim 编号程序编;来源 URL、来源名、标题按 source_no 从候选清单或本地材料照抄;子问题原文按 sq_no 照抄。出处编号不在清单里的草稿丢弃并记入 dropped_drafts(报告 Coverage notes 列出)。顺带置空综述验收的反馈通道 report_gap。

### 13. [loop for-each claim in claims, collect verify_result into verify_results] 对抗式验证(核心回路 + 独立性 check)
- ← claims
+ → verify_results % [VerifyResult]  # 各 claim 验证结果(enum 强制 verdict 四态)
> 对每条 claim 用独立第二来源交叉核对,独立性 check 强制 cross_source ≠ claim.source_url,冲突双面呈现。核心回路。

#### 13.1. [subtask retry=3 parallel] 验证单条 claim
- ← claim
+ → verify_result % VerifyResult  # 本 claim 验证结果

##### 13.1.1. [subtask retry=1] 拟定交叉核对检索词(拟不出就用断言原文兜底)
+ → queries % [SearchQuery]  # 2~3 条检索词

###### 13.1.1.1. [reason] 拟定交叉核对检索词
- ← claim
+ → queries % [SearchQuery]  # 2~3 条检索词
> @thinking off

为 claim.statement 拟 2~3 条检索词,交给程序去检索独立第二来源(你不用、也不能自己检索)。**只看 claim.statement 拟词**:claim 的出处(source_name、source_url)与本步无关——出处标题看起来和断言对不上(如百科人物词条的摘要里写了公司财务数据)也照样拟,出处可不可靠正是后面独立核对要判的事。拟法:

- 第一条:断言里的核心实体 + 数据项/关系词(如 `燧原科技 发行价 142.18元`);
- **换语言圈再拟一条**:claim 是中文就加一条英文检索词,反之亦然——同语言圈的"独立网址"常是同一份一手材料的转述链,换语言圈更容易命中真正独立的报道;
- 可加一条冲着一手信源(公告、官方报告名称)。

实体名照抄 claim.statement 原文的字,不改写、不换同音字。**本步不许拒绝、不许报"缺信息"**:断言涉及你不了解的事件、日期看起来在"未来",都照样拟——你的知识有截止日期,检索服务里有你不知道的新近报道;搜不到后面会如实判 no_evidence。

###### 13.1.1.2. [on fail] 两次都没拟出检索词 → 用断言原文当检索词
+ → queries % [SearchQuery]

####### 13.1.1.2.1. [act] 断言原文截成一条检索词
- ← claim
+ → queries % [SearchQuery]  # 只有一条:断言原文前 60 字
> ```hop_python
> queries = [{"query": str(claim["statement"])[:60]}]
> ```
> 纯机械兜底(引擎直执,零 LLM):真机实撞(C4 财务数据断言,出处是百科人物词条)拟词步四次拒绝,整条 claim 掉进"验证未完成";断言原文本身就是可用的检索词,拒绝不该让核对腿断掉。

##### 13.1.2. [loop for-each q in queries] 逐条检索
+ → pool % [Candidate] = []  # 全部检索词的结果合并清单

###### 13.1.2.1. [act] 检索并追加候选
- ← q, pool
+ → pool % [Candidate]
> ```hop_python
> r = web_search(query: q["query"])
> pages = get(r, "pages", []) if r else []
> pool = pool + [{"no": "", "sq": "", "title": str(get(pg, "title", "") or ""), "url": str(get(pg, "url", "") or ""), "source": str(get(pg, "hostname", "") or ""), "snippet": str(get(pg, "snippet", "") or "")[:300]} for pg in pages]
> ```
> 纯机械检索,同 5.1.2.1。检索服务出错时本步失败,由 13.1 的重试整条重做。

##### 13.1.3. [act] 剔除同源、去重编号
- ← pool, claim
+ → cross_candidates % [Candidate]  # 剔除与 claim 原来源同一网址的条目后,去重编号 X1/X2… 的交叉候选清单
> ```hop_python
> own = lower(strip(str(claim["source_url"])))
> keys = [lower(strip(c["url"])) for c in pool]
> keep = [k for k in range(len(pool)) if keys[k] and keys[k] != own and not (keys[k] in keys[:k])]
> cross_candidates = [{"no": f"X{n + 1}", "sq": "", "title": pool[keep[n]]["title"], "url": pool[keep[n]]["url"], "source": pool[keep[n]]["source"], "snippet": pool[keep[n]]["snippet"]} for n in range(len(keep))][:12]
> ```
> 纯机械处理(引擎直执,零 LLM):与 claim 原来源同一网址的结果先剔掉(独立性在清单层面就保证了),再按网址去重、编号,截前 12 条。

##### 13.1.4. [reason] 按编号挑交叉来源并判定
- ← claim, cross_candidates
+ → judgement % CrossJudgement  # 交叉核对判定

cross_candidates 是程序刚为这条 claim 检索回来的真实结果(已剔除 claim 原来源那个网址),每条带编号(X1/X2…)、标题、链接、来源名和摘要。

**挑交叉来源**:从 cross_candidates 里挑最能说明 claim 真假的一条,cross_no 照抄它的编号。**只能挑清单里有的编号**;清单为空或没有相关条目 → cross_no="" 并判 no_evidence。优先挑与 claim 原来源(claim.source_name)不是同一家机构、同一篇稿件转载的条目。

**判定**(只依据挑中那条的摘要):
- supported:交叉来源全面确认 claim 的每个要素(日期、金额、数量、名称各算一个要素);
- partially_supported:部分要素确认、其余没提到,或说法大体一致但口径不同;
- refuted:交叉来源把某个要素说成了别的值,且两者说的是同一口径的同一件事;
- no_evidence:没有挑中来源,或挑中那条与 claim 无关。

**口径不同不是反驳**:两个数字说的不是同一回事时(如"计划募资"与"实际募资"、"含税"与"不含税"、不同统计时点),判 partially_supported,在 conflict 里把两边原话并排写出、说明口径差异,**不判哪边对、不写"应以某某为准"**。真正同一口径却说法打架才判 refuted,conflict 同样两边并排写。

**same_caliber 先于 verdict 回答**:先想清楚两边是不是同一口径——例:claim 说"拟募集资金 60 亿元"(招股书里的计划数),交叉来源说"募集资金总额 61.19 亿元"(按实际发行价算出的数),这是计划数与实际数两个口径,same_caliber=false;两家媒体都报"发行价",一家说 142.18 元、一家说 124.18 元,这是同一口径,same_caliber=true。same_caliber=false 时判了 refuted,程序会把它改成 partially_supported。

evidence 写交叉来源说了什么(依据是该条摘要);conflict 无冲突留空串。**不许凭自身知识判定**——你的知识有截止日期,摘要里写了的就是检索服务里的现实。

##### 13.1.5. [act] 按编号组装验证结果
- ← claim, cross_candidates, judgement
+ → verify_result % VerifyResult  # 本 claim 验证结果
+ → cross_source % line  # 交叉来源 URL(供 13.1.6 独立性闸)
> ```hop_python
> nos = [c["no"] for c in cross_candidates]
> pick = strip(str(get(judgement, "cross_no", "") or ""))
> valid = pick in nos
> rejected = f"判定步挑了候选清单里没有的编号 {pick},已作废" if pick and not valid else ""
> hit = cross_candidates[int(pick[1:]) - 1] if valid else None
> cross_source = hit["url"] if hit else ""
> raw_verdict = judgement["verdict"] if hit else "no_evidence"
> verdict = "partially_supported" if raw_verdict == "refuted" and not get(judgement, "same_caliber", False) else raw_verdict
> verify_result = {"id": claim["id"], "verdict": verdict, "cross_source": cross_source, "cross_source_name": f"{hit['source']}《{hit['title']}》" if hit else "", "cross_source_tag": "web-search-verify" if hit else "", "evidence": str(get(judgement, "evidence", "") or "") if hit else "没有可用的独立第二来源", "conflict": str(get(judgement, "conflict", "") or ""), "rejected": rejected}
> ```
> 纯机械组装(引擎直执,零 LLM):交叉来源的 URL、来源名、标题按编号从候选清单照抄;没挑中或挑了清单外编号 → verdict 机械落为 no_evidence(挑了清单外编号的记入 rejected,报告单独列出);判了 refuted 但自己答 same_caliber=false(两边不是同一口径)→ 机械改为 partially_supported,冲突双面照留。

##### 13.1.6. [check final] 独立性 gate(核心纪律,不可跳)
- ← cross_source, claim
+ → independent_ok % bool  # cross_source != claim.source_url(独立)
+ → independent_note % text  # 通过置空;失败写"cross_source 与原来源相同——非独立核对"
> 核心纪律 gate:cross_source 必须独立于 claim 原来源。13.1.3 已在候选清单里剔掉同一网址,本闸是防线——正常情况下恒通过;空 cross_source(no_evidence)也通过。
> ```hop_python
> independent_ok = lower(strip(str(cross_source))) != lower(strip(str(claim["source_url"]))) or not strip(str(cross_source))
> independent_note = "" if independent_ok else "cross_source same as original source - not independent"
> ```

### 14. [subtask retry=2] 综合引用报告 + 完备性验收
+ → research_report % markdown  # 引用报告

#### 14.1. [act] 机械渲染报告机械段
- ← claims, verify_results, sq_list, all_searches, dropped_drafts
+ → report_body % markdown  # Findings/冲突与存疑/未能验证/Coverage notes/Sources 五节(零 LLM)
+ → nonsupported_ids % text  # verdict 非 supported 的编号清单(综述里不得当事实陈述)
+ → finding_digest % text  # 每条 claim 一行"编号｜verdict｜statement｜冲突"——供综述引用
> ```hop_python
> vmap = {"supported": "成立", "partially_supported": "部分成立", "refuted": "被反驳", "no_evidence": "无独立佐证"}
> pairs = [{"c": c, "v": ([v for v in verify_results if v["id"] == c["id"]] + [None])[0]} for c in claims]
> sup = [p for p in pairs if p["v"] and p["v"]["verdict"] == "supported"]
> weak = [p for p in pairs if p["v"] and p["v"]["verdict"] != "supported"]
> unv = [p for p in pairs if not p["v"]]
> findings = join([f"- **{p['c']['id']}** {p['c']['statement']}\n  - 来源:{p['c']['source_name']}({p['c']['source_tag']}｜{p['c']['source_tier']})— {p['c']['source_url']}\n  - 交叉来源:{p['v']['cross_source_name']}({p['v']['cross_source_tag']})— {p['v']['cross_source']}\n  - 交叉证据:{p['v']['evidence']}" for p in sup], "\n") if len(sup) > 0 else "(没有经独立第二来源全面确认的 claim)"
> weak_txt = join([f"- **{p['c']['id']}**({get(vmap, p['v']['verdict'], p['v']['verdict'])}｜low-confidence){p['c']['statement']}\n  - 来源:{p['c']['source_name']}({p['c']['source_tag']}｜{p['c']['source_tier']})— {p['c']['source_url']}\n  - 交叉来源:{p['v']['cross_source_name'] if p['v']['cross_source'] else '无'}{(' — ' + p['v']['cross_source']) if p['v']['cross_source'] else ''}\n  - 交叉证据:{p['v']['evidence']}" + (f"\n  - 冲突双面:{p['v']['conflict']}" if strip(str(p['v']['conflict'])) else "") for p in weak], "\n") if len(weak) > 0 else "(无)"
> rej = [p for p in pairs if p["v"] and strip(str(p["v"]["rejected"]))]
> rej_txt = "" if len(rej) == 0 else ("\n\n## 交叉核对挑选作废\n\n" + join([f"- {p['c']['id']}:{p['v']['rejected']}" for p in rej], "\n"))
> unv_txt = "" if len(unv) == 0 else ("\n\n## 未能验证的 claim\n\n" + join([f"- {p['c']['id']} {p['c']['statement']}——验证未完成(low-confidence)" for p in unv], "\n"))
> cov_rows = [f"- {s['no']} {s['text']}:claim {count([c for c in claims if c['sub_question'] == s['text']])} 条" + ("｜检索结果少于 3 条(thin),没有用模型知识补" if ([x["thin"] for x in all_searches if x["sq_no"] == s["no"]] + [False])[0] else "") for s in sq_list]
> cov_extra = ("\n- 没有提取到任何 claim" if len(claims) == 0 else "") + (("\n- 提取步有草稿因出处编号不在清单里被丢弃:\n" + dropped_drafts) if strip(str(dropped_drafts or "")) else "")
> src_rows = [f"- {p['c']['id']} 来源:{p['c']['source_name']}({p['c']['source_tag']})— {p['c']['source_url']}" + (f";交叉来源:{p['v']['cross_source_name']}(web-search-verify)— {p['v']['cross_source']}" if p["v"] and p["v"]["cross_source"] else "") for p in pairs]
> report_body = f"## Findings(经独立第二来源全面确认)\n\n{findings}\n\n## 冲突与存疑(部分成立 / 被反驳 / 无独立佐证,均为 low-confidence)\n\n{weak_txt}{rej_txt}{unv_txt}\n\n## Coverage notes(逐子问题 claim 覆盖数)\n\n" + join(cov_rows, "\n") + cov_extra + "\n\n## Sources\n\n" + join(src_rows, "\n")
> nonsupported_ids = join([p["c"]["id"] for p in weak] + [p["c"]["id"] for p in unv], ", ")
> finding_digest = join([f"{p['c']['id']}｜{p['v']['verdict'] if p['v'] else '未验证'}｜{p['c']['statement']}" + (f"｜冲突:{p['v']['conflict']}" if p["v"] and strip(str(p["v"]["conflict"])) else "") for p in pairs], "\n")
> ```
> 纯机械渲染(引擎直执,零 LLM):哪条 claim 进 Findings、哪条进冲突与存疑,全按 verdict 字段分——supported 才进 Findings,其余一律 low-confidence;无验证结果的进"未能验证"节。逐子问题覆盖数、thin 标记、来源清单都由程序数、程序拼。

#### 14.2. [reason] 撰写综述与对照评估
- ← refined_question, sq_list, finding_digest, nonsupported_ids, report_gap
+ → report_head % markdown  # 报告开头:研究问题与范围 + 逐子问题综述 + 对照评估(有评估类子问题时)

只写报告开头这几节,下面的 Findings/冲突与存疑/Coverage notes/Sources 由程序另拼,不要复述:

- **研究问题与范围**:refined_question 原文 + 一两句范围说明;
- **逐子问题综述**:按 sq_list 顺序,每个子问题一小段,回答该子问题。每句事实陈述后面用方括号标 claim 编号(如"发行价为 142.18 元/股 [C3]")。**nonsupported_ids 里的编号只能写成"存疑""未经独立来源确认"的口吻**,不许当确定事实陈述;某子问题没有 claim 的,写明"本次检索未找到可验证的断言",不用自身知识补;
- **冲突的呈现**:finding_digest 里带"冲突"的条目,两边说法并排写出、说明口径差异,不判哪边对、不写"应以某某为准";
- **对照评估**(子问题里有评估/对照类问题时):基于上述 claim 回答"缺失什么/优点是什么",逐条带 claim 编号,节首标明"本节是评估性综合,非逐条验证的 Finding"。

只引用 finding_digest 里有的编号。report_gap 非空时按意见修上一版。

#### 14.3. [act] 机械拼装与编号核对
- ← report_head, report_body, claims
+ → research_report % markdown  # 完整报告(综述在前,机械段在后)
+ → bad_refs % text  # 综述里引用了、但 claim 清单里没有的编号(无 → 空串)
> ```hop_python
> research_report = report_head + "\n\n" + report_body
> ids = [c["id"] for c in claims]
> sep = replace(replace(replace(replace(replace(replace(report_head, "[", " "), "]", " "), ",", " "), "，", " "), "、", " "), "\n", " ")
> toks = [w for w in split(sep, " ") if startswith(w, "C") and len(w) > 1 and all([ch in "0123456789" for ch in split(w[1:], "")])]
> bad_refs = join([w for w in toks if not (w in ids)], ", ")
> ```
> 纯机械拼接与核对(引擎直执,零 LLM):综述里出现的 C 编号逐个比对 claim 清单,引用了不存在的编号记入 bad_refs。

#### 14.4. [check final] 综述验收
- ← report_head, nonsupported_ids, finding_digest, bad_refs, sq_list
+ → report_ok % bool  # 综述是否合格
+ → report_gap % text  # 通过置空;失败写缺口

只审 report_head(综述),机械段由程序拼、不在审查范围。合格条件:① bad_refs 为空(非空=引用了不存在的编号,直接不合格,把编号列进 report_gap);② sq_list 里每个子问题在综述里都有一段(有 claim 的作答、没有的写明未找到);③ nonsupported_ids 里的编号在综述里没被当确定事实陈述(对着 finding_digest 看该编号的 verdict);④ 带冲突的条目两边都呈现了,没有"应以某某为准"之类的选边。行文措辞、排版偏好不是打回理由。全满足 → report_ok=true、report_gap="";否则 false,report_gap 逐条列出(触发 retry,14.2 据此修)。

#### 14.5. [on fail] 三轮验收都没通过 → 沿用末轮报告并标注
+ → research_report % markdown

##### 14.5.1. [act] 末轮报告加验收未通过说明
- ← report_head, report_body, report_gap
+ → research_report % markdown
> ```hop_python
> research_report = report_head + "\n\n> 注:综述节三轮验收未通过,最后一轮的意见如下,阅读综述时请以下方 Findings 与冲突节为准:\n> " + replace(str(report_gap or ""), "\n", "\n> ") + "\n\n" + report_body
> ```
> 综述验收烧尽不让整个研究报废——机械段(Findings/冲突/覆盖/来源)不经模型、本身可靠;把判官最后一轮意见写在综述下方,读者知道综述哪里可能不准。

### 15. [subtask] 报告落盘交付
- ← research_report, report_path, refined_question
+ → saved_report_path % line  # 实际写盘路径

#### 15.1. [branch] 落盘路径来源分流
- ← report_path
+ → final_path % line  # 定下来的落盘路径

##### 15.1.1. [case(report_path)] 参数已给——直接用
+ → final_path % line
###### 15.1.1.1. [act] 采用参数路径
- ← report_path
+ → final_path % line
> ```hop_python
> final_path = report_path
> ```

##### 15.1.2. [case(else)] 未给——问用户存哪
+ → final_path % line
###### 15.1.2.1. [ask] 问报告保存路径
- ← refined_question
+ → final_path % line  # 用户给的落盘路径(工作目录相对)
> 报告已生成,问用户存到哪(给一个据 refined_question 起的缺省建议名,如 reports/<主题短语>-研究报告.md,用户可改可采纳)。要的是路径值。

#### 15.2. [commit] 写盘报告
- ← research_report, final_path
+ → saved_report_path % line  # 写盘确认路径
> 交付写盘(持久产物归 commit——写盘前 final_path 已经参数或 ask 定值,人已知情):
> ```hop_python
> write(path: final_path, content: research_report)
> saved_report_path = final_path
> ```

### 16. [exit] 交付
- ← research_report, saved_report_path
> 交付 research_report(全文)+ saved_report_path(落盘位置)。对抗验证(独立性 check)+ 完备性验收 + 落盘交付已完成。
