# Spec: 方案评审方法论（hop-doc-review2）
Id: hop-doc-review2
> 档位: mixed（hop=全结构化,双模式皆稳;mixed=含未尽原子——standalone 由引擎带工具面的 LLM 循环执行,所需引擎外能力须经 Tools 段声明,声明齐即可跑;复用模式 caller 能力面开放天然宽容）

## Goal
对建设方案/规划文档进行多角度专家评审——从文档特征推导评审视角、设计审查员角色，分轮并行评审并交叉验证，输出优先问题清单并逐一对焦决策

## Constraints
- 审查员视角最少 3 个、最多 6 个，另加 1 个汇聚分析员；视角须从文档脆弱点推导而非套固定模板
- 审查员统一使用当前会话可用最强模型、最大努力级别，同轮无依赖的审查员必须并行发射
- 审查员 prompt 必须自包含（角色、立场、推理策略、审查重点、输出格式），不可依赖"前面说过了"
- 汇聚分析员启动前须逐一验证审查报告存在且可用报告 ≥ 3 份，不足则跳过汇聚直接汇总
- 待评审文档超过 30,000 字时报错，要求用户分拆后重新提交
- 阶段一不可跳过：文档定位类型确认、行业对标、评审模式确认、审查员设计各有完成检查点
- 审查员报告每分析章节 ≤ 200 字、总字数 ≤ 1500 字，汇聚报告 ≤ 3000 字
- 人工确认模式下对焦阶段不得直接编辑源文档，先写对焦决策记录、确认后再修改
- 用户交互全部经由 orchestrator 的问答步骤完成，审查员与汇聚分析员不直接与用户对话
- 文档定位类型必须与用户确认后作为评审基准，不可自行判定
- 人工确认模式下对焦决策记录必须去敏感化——用角色描述而非真实人名/单位名
- 用户不在场时等待；须用户确认的步骤不可跳过，不设置默认策略
- 模板复用前检查版本兼容性——模板头部的 version 与当前方法论主版本号不一致时必须从零设计
- 自动修复模式下审查员报告末尾必须附'建议修改清单'章节（每条含源文档位置、问题、修改建议）
- 行业对标搜索结果必须整理为风险点清单并经用户逐项确认（相关/不相关/不确定逐项勾选）；搜索结果中至少 1 条须来自权威来源（政府/学术域名或公认行业媒体）；风险点清单须标注每条风险的来源 URL 及采纳/丢弃原因

## Inputs
- doc_path: line  # 待评审文档路径（评审对象；自动修复模式下同为目标修改文件；超过 30,000 字时报错要求分拆）

## Outputs
- review_result: markdown  # 评审交付物——优先问题清单、对焦决策记录与评审总结（自动修复模式下含实际修改摘要；人工确认模式下含对焦决策记录）

## Tools
- web_search(query) -> results: [yaml]  # 行业实践对标（原文必执行，至少调用 2 次、每次一个关键词）；输出条目结构: title, url, summary——每条结果含来源 URL 及摘要，供下游逐条标注采纳/丢弃原因
  - query: line  # 单次搜索关键词——每个关键词单独调用一次本工具（至少 2 次），格式如「[文档类型] [行业] 方案 失败 案例」与「[文档类型] [行业] 最佳实践」

## Steps
1. [act] 按 doc_path 读取待评审文档全文，产出全文候选文本
  - ← doc_path
  + → doc_candidate: text  # 全文候选文本（待长度与适用性检查通过后定稿为 doc_text）
  > ```hop_python
  > doc_candidate = read(path: doc_path)
  > ```
2. [act] 检查文档长度：全文超过 30,000 字判定为超限
  - ← doc_candidate
  + → len_ok: bool  # 长度检查是否通过（全文不超过 30,000 字为通过）
  > ```hop_python
  > len_ok = len(doc_candidate) <= 30000
  > ```
3. [branch] 按长度检查结果分流：超限则终止本轮
  - ← len_ok
  3.1. [case(not len_ok)] 文档超限
    3.1.1. [exit] 报错终止本轮——文档超过 30,000 字，提示用户自行分拆后再提交评审
4. [reason] 判定是否命中"何时不应使用本技能"场景
  - ← doc_candidate
  + → applicable: bool  # 本评审流程是否适用（未命中禁用场景为 true）
  > 判定依据（原文"何时不应使用本技能"）：命中以下任一场景即不适用、终止本轮——代码/实现评审、单段文字审校、纯事实核查、文档<500字、作者不在场且需人工确认模式。以原文"与 agent-review-panel 的区别"表为背景理解适用边界（背景材料随原文引用，不展开）。
5. [branch] 命中禁用场景则终止本轮
  - ← applicable
  5.1. [case(not applicable)] 不适用
    5.1.1. [exit] 终止本轮——命中"何时不应使用本技能"场景，本流程不适用
6. [act] 定稿并交付 doc_text
  - ← doc_candidate
  + → doc_text: text  # 待评审文档全文（已通过长度与适用性检查，最终交付）
  > ```hop_python
  > doc_text = doc_candidate
  > ```
7. [act free] 通读 doc_text 分析文档特征与脆弱点：回答 4 问（核心判断/主张、架构、推动谁做什么产出什么、时间跨度），遵循核心理念（从文档本身推导脆弱点，不套固定模板）；判定文档领域（业务领域+文档类型，按领域命名规则与判定优先级：先精确匹配 DocReviewers/ 下已有领域目录，再关键词匹配，仍未确定则列出相近领域目录作为候选）；识别脆弱点（从文档类型推导最可能出问题的地方），产出定位类型判定初稿与 4 问回答
  - ← doc_text
  + → doc_type_proposal: line  # 文档定位类型判定（初稿，含领域；待用户确认领域后定稿）
  + → doc_analysis: yaml  # 文档特征与脆弱点分析（4问回答+脆弱点，评审视角推导依据）
  + → domain_candidates: [line]  # 相近领域目录候选（与判定结果一并提交用户确认）
8. [ask require_human present_inputs=doc_type_proposal,domain_candidates] 与用户确认文档领域归属（选项：确认新领域 / 归入已有领域（列相近领域名）/ 换一个领域；用户自定义以用户为准；领域确认后作为定位类型的一部分）
  - ← doc_type_proposal, domain_candidates
  + → doc_type_proposal: line  # 文档定位类型判定（领域已与用户确认，作为评审基准待步骤 3 最终确认）

9. [ask require_human present_inputs=doc_type_proposal] 与用户确认文档定位类型（不可自行判定；用户自定义以用户为准；确认后作为评审基准）
  - ← doc_type_proposal
  + → doc_type: line  # 文档定位类型（已与用户确认，作为评审基准）

10. [act free] 按已确认 doc_type 用 WebSearch 搜索行业实践（至少 2 个关键词）；无结果换词重试（至少 3 次），产出搜索结果供整理
  - ← doc_type, doc_analysis
  - 工具: web_search  # 行业实践对标检索——本步核心动作,须联网搜索
  + → search_results: [yaml]  # 行业实践搜索结果（条目含 title、url、summary）
  + → search_degraded: bool  # 搜索是否降级（重试后仍无结果则为 true，需标注"未经行业对标"）
  > 关键词格式如"[文档类型] [行业] 方案 失败 案例"与"[文档类型] [行业] 最佳实践"，至少 2 个——行业维度取自 doc_analysis（文档领域，步骤 7 产出）；无结果时换词重试至少 3 次；仍无结果则降级并标注"未经行业对标"（本子节点不做用户交互，降级提示随 risk_draft 在父层步骤 12 用户确认时带出）。
11. [reason] 将搜索结果整理为风险点清单草稿 risk_draft（逐条标注来源 URL 与采纳/丢弃原因，含权威来源评估）
  - ← search_results, search_degraded
  + → risk_draft: [yaml]  # 风险点清单草稿（每条含来源 URL 与采纳/丢弃原因，待步骤 12 勾选确认）
  > search_degraded 为 true 时整体标注"未经行业对标"。对照搜索三目的：发现方案类型特有风险点、为后续审查员设计提供检查清单、避免审查结论空泛。每条标注来源 URL 与采纳/丢弃原因（如"来源为个人博客，仅作参考"/"来源为政府白皮书，采纳"）。权威来源评估：至少 1 条须来自 .gov/.edu 域名或公认行业媒体/研究机构；无权威来源则标注缺权威来源并随父层步骤 12 提示用户。本子节点不进行用户交互，逐项勾选确认由父层步骤 12 承接。
12. [subtask retry=3] 与用户确认风险点清单与评审模式，将确认后的风险点清单写入 rounds 目录
  + → risk_points: [yaml]  # 风险点清单（已确认，每条含来源 URL 与采纳/丢弃原因）
  + → review_mode: enum(manual, auto)  # 评审模式（已与用户确认，人工确认/自动修复）
12.1. [ask require_human present_inputs=risk_draft] 逐项勾选确认风险点清单
  - ← risk_draft
  + → risk_points: [yaml]  # 风险点清单（已确认，每条含来源 URL 与采纳/丢弃原因）
  > 将 risk_draft 各条逐项呈给用户勾选（相关/不相关/不确定），按用户勾选结果产出已确认的风险点清单（相关项保留、不相关项剔除、不确定项与用户再确认定夺）；用户不在场时等待，不跳过、不设默认策略。

  12.2. [ask require_human] 按模式表格与用户确认评审模式
    + → review_mode: enum(manual, auto)  # 评审模式（已与用户确认，人工确认/自动修复）
    > 按模式表格向用户呈现两种评审模式选项请其选择：自动修复（auto，对焦阶段可直接修改源文档、审查员报告末尾附建议修改清单）、人工确认（manual，对焦阶段不直接编辑源文档、先写对焦决策记录经确认后再修改、记录须去敏感化）；用户不在场时等待，不跳过。
  12.3. [check] 完成检查点：风险点清单与评审模式均已确认，未完成不得进入下一步
    - ← risk_points, review_mode
    + → confirm_ok: bool  # 判定槽：风险点清单与评审模式是否均已确认
    + → confirm_note: text  # 说明槽：不过时列明未确认/缺失项
    > 核验两轮 ask 均已获用户明确选择：risk_points 各条均已勾选、review_mode 已取得 manual/auto 之一；任一缺失即判 false，阻断进入提交。
  12.4. [commit] 将已确认的风险点清单写入 doc_path 所在目录的 rounds/风险点清单.md（创建 rounds 子目录、将 risk_points 序列化为 markdown 清单〔每条含来源 URL 与采纳/丢弃原因〕写盘；阶段二创建轮次目录后移入对应轮次目录）
    - ← risk_points, doc_path
    > ```hop_python
    > parts = split(doc_path, "/")
    > n = len(parts) - 1
    > doc_dir = join([parts[i] for i in range(n)], "/")
    > doc_dir = doc_dir if doc_dir else "."
    > rounds_dir = doc_dir + "/rounds"
    > makedirs(path: rounds_dir)
    > item_lines = ["- " + get(x, "title", "") + "\n  来源: " + get(x, "url", "") + "\n  采纳/丢弃原因: " + get(x, "reason", "") for x in risk_points]
    > content = join(["# 风险点清单", ""] + item_lines, "\n")
    > write(path: rounds_dir + "/风险点清单.md", content: content)
    > ```
13. [act free] 查看 DocReviewers/{领域}/reviewers/ 下是否已有该领域审查员模板，列出模板清单（含头部 version 字段）；无模板时说明"无"
  - ← doc_type_proposal
  + → templates_info: text  # 模板清单：模板位置与头部 version 字段（无模板时说明"无"）
  > {领域} 取 doc_type_proposal（步骤 8 已与用户确认的领域归属，doc_type_proposal 含领域信息）；在 DocReviewers/{领域}/reviewers/ 下列出全部模板文件并记录各文件头部 version 字段。
14. [reason] 版本兼容性判定：比对模板头部 version 与当前方法论主版本号 v2.1.0，主版本不同视为不兼容须从零设计；次版本/修订号向后兼容可复用（约束 10 版本规则）
  - ← templates_info
  + → version_compat: line  # 版本兼容性结论（兼容可复用/不兼容须从零设计）
15. [act free] 查看历史 rounds/ 汇聚报告，提炼该领域常见 P0 问题清单；无历史报告时说明"无"
  - ← doc_path
  + → common_p0: text  # 该领域历史常见 P0 问题清单（无历史时说明"无"）
16. [reason] 三态决策：综合模板存在性、版本兼容性与常见 P0，按"直接复用/基于已有微调/从零设计"决策；跨域复用保留元结构（立场/推理策略/输出格式）但审查问题按当前领域重新生成
  - ← templates_info, version_compat, common_p0
  + → template_decision: line  # 模板复用决策（直接复用/基于已有微调/从零设计）
17. [subtask retry=2] 确定评审视角数量与类型并通过完成检查点
  + → perspectives: [yaml]  # 评审视角列表（数量与类型，供审查员角色设计使用）
  17.1. [reason] 综合脆弱点分析、行业对标风险点与模板复用决策确定评审视角的数量与类型
    - ← doc_analysis, risk_points, template_decision
    + → perspectives: [yaml]  # 评审视角列表（数量与类型，供审查员角色设计使用）
    > 综合 doc_analysis（脆弱点分析）、risk_points（行业对标结果）与 template_decision（模板复用决策）确定评审视角：审查员视角最少 3 个、最多 6 个，另加 1 个汇聚分析员（约束 1）；已有专业审查员模板可沉淀复用、避免从零设计；视角不是越多越好——过多低质量审查员增加汇聚噪音，每个视角须从文档脆弱点推导而非套固定模板；perspectives 按列表产出（每项含视角名、类型〔审查员/汇聚分析员〕、关注点，供审查员角色设计使用）。
  17.2. [check final] 核验完成检查点：评审模式已记录、视角列表已确定且数量满足约束 1；未通过不得进入下一步
    - ← perspectives
    + → checkpoint_ok: bool  # 判定槽：完成检查点是否全部通过
    + → checkpoint_note: text  # 说明槽：不过时逐条列缺口
    > 核验判据：perspectives 已产出且为非空列表；审查员视角数量在 3–6 之间且恰含 1 个汇聚分析员（总条目 4–7），视角类型与数量满足约束 1；"评审模式已记录"以前置完成状态为准——本节点无该记录变量则视为已满足（见台账）；判 false 时由本 subtask 的重试语义自动重跑本段。
18. [subtask retry=2] 设计审查员角色（五要素与审查问题）并完成检查点验收
  + → reviewer_parts: [yaml]  # 各审查员角色定义（review_roles 的审查员部分，含审查问题与输出格式）
  18.1. [loop for-each perspective in perspectives, collect role_draft into role_drafts] 为每个视角设计审查员五要素
    - ← perspectives
    + → role_drafts: [yaml]  # 各审查员五要素定义草稿（角色名称/审查立场/推理策略/审查重点/输出格式）
18.1.1. [reason] 为当前视角设计审查员五要素：唯一角色名称、审查立场（怀疑强度三档递进）、推理策略（参考表选取或组合）、审查重点（3-10 条具体审查项）、模板化输出格式——五要素必须完整设计，不可只给视角名称
  - ← perspective
  + → role_draft: yaml  # 本视角审查员五要素定义草稿（role_name/stance/strategies/focus_items/output_format）
  > 五要素设计判据（按下述规格执行）：
  > 1. 审查立场按怀疑强度递进三档任选其一定档：
  >    - 审慎：适合治理、可持续类——关注"如果出问题会怎样"，不假设一定会出问题
  >    - 偏向怀疑：适合逻辑、可行性类——预设"方案说的不一定对"，主动寻找反例
  >    - 主动质疑：适合差异化、利益相关方类——举证责任在方案方，方案证明自己正确前均视为可疑
  > 2. 推理策略从参考表选取或组合（不要求全部使用）：
  >    - 逆向推理：从方案结论反向追问"前提是什么、是否被论证"，适合发现逻辑跳跃和未证明的假设
  >    - 角色代入：站到每个关键参与方立场问"第一个疑问是什么、利益是否被充分考虑"，适合利益相关方分析和治理方案
  >    - 失败模式压力测试：收集同类型方案已知失败案例，逐一检验当前方案是否落入相同陷阱，适合运营/执行类方案
  >    - FMEA：把方案拆成关键组件，逐个问"怎么坏/影响多大/概率多高/有无备用方案"，适合技术架构和多组件耦合方案
  >    - 时间线推演：沿时间轴逐阶段推演"此步延迟或失败下游怎么办"，适合有明确阶段性交付的方案
  >    - 约束分析：围绕人/钱/时间三个硬约束问"某约束收紧 30% 哪部分先崩"，适合任何需要资源投入的方案
  >    - 竞争格局映射：放入竞品/替代方案坐标系问"差异化是否可持续、更强对手 6 个月内跟进怎么办"，适合有市场竞争维度的方案
  > 3. 要素规格：角色名称须唯一标识（用于文件名和报告标题）；审查重点列 3-10 条该视角下的具体审查项；输出格式为模板化报告框架
  > 4. 约束落实：本视角为 3-6 个审查员视角之一（约束1）；本定义供最强模型最大努力级别审查员使用，prompt 须自包含角色/立场/策略/重点/输出格式全部信息，不可依赖"前面说过了"（约束2/6）；角色边界作背景引用：审查员作为独立子流程派发、专注单一视角评审，不直接与用户交互（交互全由 orchestrator 完成）
  > 5. role_draft 为 yaml 结构化对象：{role_name: 唯一角色名, stance: 审慎|偏向怀疑|主动质疑, strategies: [策略名列表], focus_items: [3-10 条具体审查项], output_format: 模板化报告框架}

  18.2. [subtask retry=1] 读取待评审文档全文并核验长度（审查问题须针对文档具体内容生成）
    + → doc_content: text  # 待评审文档全文（审查问题生成的材料）
    18.2.1. [act] 读取文档全文
      - ← doc_path
      + → doc_content: text  # 待评审文档全文
      > ```hop_python
      > doc_content = read(path: doc_path)
      > ```
    18.2.2. [check final] 核验文档长度不超 30,000 字（header 约束5：超出报错要求分拆重交）
      - ← doc_content
      + → doc_len_ok: bool  # 判定槽:文档长度 ≤ 30,000 字
      + → doc_len_note: text  # 说明槽:超长时提示用户分拆后重新提交
      > ```hop_python
      > doc_len_ok = len(doc_content) <= 30000
      > doc_len_note = "待评审文档超过 30,000 字，要求用户分拆后重新提交" if not doc_len_ok else ""
      > ```
  18.3. [loop for-each draft in role_drafts, collect review_draft into reviewer_drafts] 为每个视角设计审查员五要素
    - ← role_drafts
    + → reviewer_drafts: [yaml]  # 各审查员五要素定义草稿（角色名称/审查立场/推理策略/审查重点/输出格式）
    18.3.1. [reason] 依据该审查员五要素草稿与待评审文档具体内容，生成 3-10 条具体审查问题（完整问句或可验证陈述，针对当前文档具体内容，不可将视角名称直接当作审查问题；可参考推理策略问题模板表按需选用/组合或自行设计，策略可组合使用）
      - ← draft, doc_content
      + → review_questions: [line]  # 3-10 条具体审查问题（完整问句或可验证陈述，面向当前文档具体内容）
      > 结合 draft 中的审查视角、立场与推理策略，针对 doc_content 的具体内容设计 3-10 条审查问题；推理策略问题模板表为本步材料随执行整段供给，可按需选用/组合或自行设计，策略可组合使用；不得将视角名称直接当作审查问题
    18.3.2. [reason] 结合该审查员的输出格式（取自 draft）组装审查员角色定义草稿，交付本项草稿
      - ← draft, review_questions
      + → review_draft: yaml  # 本审查员角色定义草稿（collect 单项，含 3-10 条具体审查问题与输出格式组装）
      > 以 draft 声明的输出格式为骨架，填入 review_questions 组装角色定义草稿；草稿须自包含（角色、立场、推理策略、审查重点、审查问题、输出格式六要素齐全），不依赖"前面说过了"；输出格式定义符合 header 契约的审查员输出限制（每分析章节 ≤ 200 字、总字数 ≤ 1500 字）
  18.4. [act] 沿用步骤 12 已确认的评审模式（用户已在 12.2 拍板，不重复询问——重复问一次既是多余摩擦，两次回答不一致时后值还会静默覆盖已确认值）
    - ← review_mode
    + → review_mode_effective: enum(manual, auto)  # 生效评审模式（=12.2 确认值原样沿用；自动修复时审查员输出附"### 建议修改清单"章节）
    > ```hop_python
    > review_mode_effective = review_mode
    > ```
  18.5. [branch] 按评审模式分流产出最终 reviewer_parts
    - ← review_mode_effective
    + → reviewer_parts: [yaml]  # 各审查员角色定义定稿（自动修复模式下含"### 建议修改清单"章节）
    18.5.1. [case(review_mode_effective == "auto")] 自动修复模式：附加"### 建议修改清单"章节
      18.5.1.1. [act free] 将"### 建议修改清单"章节规格组装后附加进 reviewer_drafts 各角色的输出格式定义，产出最终 reviewer_parts
        - ← reviewer_drafts
        + → reviewer_parts: [yaml]  # 各审查员角色定义定稿（自动修复模式下含"### 建议修改清单"章节）
        > 清单章节规格：标题"### 建议修改清单"；每条含编号（P0-1/P1-3，与汇聚阶段一致）、位置、问题、建议、理由（≤30 字）；附加位置为各审查员角色定义的输出格式（报告框架模板）末尾
    18.5.2. [case(else)] 非自动修复模式：直接沿用 reviewer_drafts 作为 reviewer_parts
      18.5.2.1. [act] 原样传递 reviewer_drafts 作为 reviewer_parts（不加清单章节）
        - ← reviewer_drafts
        + → reviewer_parts: [yaml]  # 各审查员角色定义定稿（原样传递，不加清单章节）
        > ```hop_python
        > reviewer_parts = reviewer_drafts
        > ```
  18.6. [check final] 完成检查点：五要素完整不可留空、审查问题已生成具体问句——未完成不得进入下一步
    - ← reviewer_parts
    + → parts_ok: bool  # 判定槽:五要素完整且审查问题为具体问句
    + → parts_note: text  # 说明槽:不达标时逐条列缺口
19. [reason] 创建汇聚分析员角色定义——不做新审查：设计质量评估（三条件）→交叉验证/矛盾裁决/排序输出/整体裁定工作法，内嵌严重度锚点、优先级公式、对焦策略，与 reviewer_parts 汇总为完整 review_roles
  - ← reviewer_parts
  + → review_roles: [yaml]  # N+1 个审查员与汇聚分析员角色定义（含审查问题与输出格式）
  > 设计汇聚分析员（Synthesis Agent）角色定义，保留 reviewer_parts 全部审查员定义并追加汇聚分析员，合成为完整 review_roles。角色定位写入定义：独立 Agent，读取全部审查报告，不做新审查，不负责流程编排，不直接编辑源文档。工作方法完整内嵌：
  > 1) 质量评估：每份报告须同时满足三条件为有效——有引文（至少引用 1 处源文档具体段落/行号/章节名）、有独立发现（至少 1 项非共识发现）、有量化判断（至少 1 项严重度评估或可验证的具体建议）；否则标记低质量，权重 0.3，不参与共识计算，仅在报告中列出其发现。
  > 2) 执行流程：交叉验证（找共识信号——多个审查员从不同角度指向同一问题）→ 矛盾裁决（结论冲突时论据更扎实者胜）→ 排序输出（按严重度×共识强度排优先处理清单）→ 整体裁定（方案成熟度判断 + 改进路线图）。
  > 3) 严重度锚点 1-5：5=阻塞（不改则方案不可行）、4=重大缺口（可绕过但代价极大或风险不可控）、3=显著缺陷（影响方案质量或可靠性但短期可容忍）、2=轻微问题（措辞不清、术语不一致、文档不完整）、1=优化建议（锦上添花不影响可用性）。
  > 4) 优先级公式（仅计入有效报告）：P0=严重度 5，或严重度 4 且 ≥3 个审查员独立指出；P1=严重度 3-4（不够 P0），或严重度 2 且 ≥4 个审查员独立指出（系统性盲区）；P2=其余。
  > 5) 对焦策略：按 P0→P1→P2 依次处理；某级问题数量 >5 时先展示全量列表让用户标注优先项，再逐条确认；P1 不可因 P0 全部驳回而自动升级——驳回逐条，严重度不因排序位置改变。
20. [reason] 从 doc_type_proposal 推定领域名 domain_name（领域名取自用户已确认的领域归属——步骤 8 确认后 doc_type_proposal 含领域信息，以用户确认结果为准；供模板写入与 DocTree 索引消费）
  - ← doc_type_proposal
  + → domain_name: line(非空)  # 领域名（目录名，由已确认的领域归属推定；供模板写入与 DocTree 索引消费——非空约束:空串会拼出畸形路径,0043 实撞正是此槽）
21. [act] 检查领域 README 是否已存在（首轮判定数据源；只读探测——目录创建是持久写盘动作,归后续 commit 步骤承载,act 步骤不建目录）
  - ← domain_name
  + → readme_exists: bool  # 领域 README 是否已存在（false=首轮冷启动，22.1.1 落 bootstrapping README；true=复用场景，README 不动）
  > 探测 DocReviewers/{domain_name}/README.md 是否存在且非空——先用 exists 探测路径（目录尚未创建时探测结果自然为不存在,即首轮冷启动）,存在再读内容判非空,产出 readme_exists 供步骤 22 分流与步骤 36 回填判定。本步骤不创建任何目录：DocReviewers 目录树的创建随首个写盘动作在 commit 步骤内完成（22.1.1.3 写 README / 23.3 写模板时先 makedirs 幂等建目录再写文件）。
  > ```hop_python
  > probe = parse_json(exists(path: "DocReviewers/" + domain_name + "/README.md"))
  > readme_exists = False
  > if probe["exists"]:
  >     readme_exists = len(read(path: "DocReviewers/" + domain_name + "/README.md")) > 0
  > ```
22. [subtask retry=2] README 落盘事务：按领域 README 是否存在分流——首轮冷启动组装 bootstrapping README 并 commit 写入；复用场景跳过写入直接放行（原文"后续同领域评审复用同一目录"）
  + → readme_written: line  # 交付物：README 落盘回执（首轮=已写入路径；复用="复用已有 README，不覆盖"）
  22.1. [branch] 按领域 README 是否存在分流
    - ← readme_exists
    22.1.1. [case(not readme_exists)] 首轮冷启动：领域目录无 README，组装并写入 bootstrapping README
      22.1.1.1. [reason] 从 doc_analysis/risk_points 提取领域特征与风险点，组装 README.md 内容（标注 status: bootstrapping；预留高频脆弱点字段——首轮评审完成后从 synthesis.md 回填并将 status 更新为 active，本轮仅预留不执行回填）
        - ← doc_analysis, risk_points
        + → readme_content: text  # README.md 内容（status: bootstrapping；含领域特征、风险点、高频脆弱点预留字段）
      22.1.1.2. [check final] 核验 README 内容齐全达标（status: bootstrapping、领域特征、风险点、高频脆弱点预留字段均已填入）
        - ← readme_content
        + → readme_ok: bool  # 判定槽：README 是否齐全达标
        + → readme_note: text  # 说明槽：不达标时逐条列缺口
      22.1.1.3. [commit] 将 README.md 写入 DocReviewers/{domain_name}/（仅首轮评审创建领域目录时写入；后续同领域复用同一目录不覆盖）
        - ← readme_content, domain_name
        + → readme_written: line  # 提交回执
        > ```hop_python
        > makedirs(path: "DocReviewers/" + domain_name + "/reviewers")
        > write(path: "DocReviewers/" + domain_name + "/README.md", content: readme_content)
        > readme_written = "DocReviewers/" + domain_name + "/README.md"
        > ```
    22.1.2. [case(else)] 复用场景：领域 README 已存在（已 active），跳过写入直接放行——不覆盖历史领域沉淀
      22.1.2.1. [act] 置 readme_written="复用已有 README，不覆盖" 放行（不走组装/核验/写盘）
        + → readme_written: line  # 回执："复用已有 README，不覆盖"
        > ```hop_python
        > readme_written = "复用已有 README，不覆盖"
        > ```
23. [subtask retry=2] 将设计好的 N+1 个模板文件写入 DocReviewers/{领域}/reviewers/
  + → templates_written: [line]  # 交付物：已落盘模板文件路径清单
  23.1. [act free] 按阶段一 8 文件结构生成 N+1 个模板文件内容（每文件=YAML 头部 version 取当前 v2.1.0 + 可读角色说明 + Agent 调用模板代码块；prompt 完整自包含并遵守四条关键约束：自包含/具体问题/精确输出格式/否定清单；章节 ≤200 字、总 ≤1500 字；可参考 r001 实例 DocReviewers/政务-数据局/reviewers/ 下模板）
    - ← review_roles, doc_type
    + → templates_content: [yaml]  # 模板文件清单（每条含 file_name、content，供 23.2/23.3 消费）
    > 每个审查员模板的 Agent prompt 必须写入"**文档定位类型：{doc_type}**——这是你的评审基准线"基准段（原文 §2 强制动作：定位类型确定后必须写入每个审查员的 prompt 作为评审基准；同一段文字在不同定位类型下严重度判定完全不同——如宣传语体在"政务新闻稿"中是 P1、在"市场宣传文"中不构成问题）；doc_type 为步骤 9 已与用户确认的定位类型（header 约束"文档定位类型必须与用户确认后作为评审基准"的执行落点）；其余要素按原文 §8 文件结构组装。
  23.2. [check final] 核验模板内容齐全达标（与 review_roles 一一对应、version=v2.1.0、prompt 自包含且遵守四条关键约束、章节 ≤200 字/总 ≤1500 字）
    - ← templates_content, review_roles
    + → tmpl_ok: bool  # 判定槽：模板是否齐全达标
    + → tmpl_note: text  # 说明槽：不达标时逐条列缺口
  23.3. [commit] 将 N+1 个模板文件按 23.1 生成内容写入 DocReviewers/{领域}/reviewers/（交付落盘）
    - ← templates_content, domain_name, review_roles
    + → templates_written: [line]  # 提交回执：已落盘模板文件路径清单
    > 写盘规则（机械定死，执行期零裁量）：先创建目标目录 DocReviewers/{domain_name}/reviewers/（makedirs 幂等,已存在不报错——复用场景 22 步可能跳过了建目录）；然后逐条取 templates_content——目标路径 = "DocReviewers/" + domain_name + "/reviewers/" + 该条 file_name；写盘内容 = 该条 content 字段原文（完整落盘，不加工、不概括、不重排）。
    > ```hop_python
    > tpl_dir = "DocReviewers/" + domain_name + "/reviewers"
    > makedirs(path: tpl_dir)
    > written = [write(path: tpl_dir + "/" + get(item, "file_name", ""), content: get(item, "content", "")) for item in templates_content]
    > templates_written = [tpl_dir + "/" + get(item, "file_name", "") for item in templates_content]
    > ```
24. [subtask retry=2] 所有模板写入完成后一次性更新 DocReviewers/DocTree.md（不存在则新建）
  + → doc_tree_updated: line  # 交付物：DocTree 更新回执
  24.1. [act free] 按"评审库索引"格式组装 DocTree 索引条目（列出领域及其审查员模板清单，条目与 templates_written 一一对应）
    - ← templates_written, domain_name
    + → doc_tree_entries: [line]  # 索引条目清单（每行一条：领域+模板文件名）
  24.2. [check final] 核验索引条目与落盘模板一一对应（条目数量与模板文件名均与 templates_written 一致）
    - ← doc_tree_entries, templates_written
    + → idx_ok: bool  # 判定槽：索引是否与落盘模板一一对应
    + → idx_note: text  # 说明槽：不一致时逐条列缺口
  24.3. [commit] 更新 DocReviewers/DocTree.md（不存在则新建；读旧内容并入新条目后一次性写回，不覆盖其他领域条目）
    - ← doc_tree_entries, domain_name
    + → doc_tree_updated: line  # 提交回执
    > 机械并入（body 引擎直执零裁量——旧内容全部保留：本领域章节标题已存在则条目插到该标题行之后（章节标题在索引文件中唯一，replace 精确命中），不存在则文末追加新章节；绝不整文件重写他域条目）：
    > ```hop_python
    > tree_path = "DocReviewers/DocTree.md"
    > probe = parse_json(exists(path: tree_path))
    > old_text = ""
    > if probe["exists"]:
    >     old_text = read(path: tree_path)
    > section = "## " + domain_name
    > entry_block = join(doc_tree_entries, "\n")
    > new_text = old_text + "\n" + section + "\n" + entry_block + "\n"
    > if section in old_text:
    >     new_text = replace(old_text, section, section + "\n" + entry_block)
    > write(path: tree_path, content: new_text)
    > doc_tree_updated = "DocTree.md 已并入 " + domain_name + " 章节 " + str(len(doc_tree_entries)) + " 条"
    > ```
25. [reason] 规划评审轮次：按分轮原则将审查员排序分组为 2-3 轮，每轮 1-3 个审查员并行，标记并行/串行并生成轮次 ID
  - ← review_roles
  + → round_plan: [yaml]  # 轮次计划：每轮含 round_id、审查员清单、并行/串行标记
  > 审查员清单取自 review_roles（N+1 项：N 个审查员 + 1 个汇聚分析员，汇聚分析员固定收尾）。分轮原则：逻辑类+利益相关方类优先（暴露结构性问题）→执行类次之（在结构框架上检验可行性）→差异化最后（依赖前几轮的发现做竞争判断）→汇聚分析员收尾（读取全部报告做交叉验证）。每轮 1-3 个审查员并行，共 2-3 轮；同轮内无依赖关系的审查员并行执行，有依赖关系的审查员串行（后续审查员需参考前序报告）。轮次 ID 用 r+三位序号（r001、r002…）。

26. [act free] 为每个审查员组装派发材料清单（完整自包含 prompt+报告路径,供逐个 call 派发）
  - ← round_plan, templates_content, doc_text
  + → launch_items: [yaml]  # 派发材料清单,每项 {role_name, reviewer_prompt, report_dir, report_file}——不含汇聚分析员（汇聚在步骤 31 单独 call）
  > 按 round_plan 的轮次顺序展开全部审查员（汇聚分析员除外——它在步骤 31 读齐报告后单独派发）;每项组装:reviewer_prompt = templates_content 中对应模板完整内容（替换 {round_id} 为该审查员所在轮次 ID）——模板须完整放入不概括不缩写;report_dir = "rounds/" + 该审查员所在 round_id;report_file = "reviewer_" + 角色名转文件名 + ".md"（转文件名规则:去空格,保留中文与连字符）。字数限制已在模板内,不另加。

27. [loop for-each item in launch_items, collect receipt into launch_receipts] 逐个派发审查员子实例（parallel 并发,引擎收齐才出循环）
  - ← launch_items, doc_text
  + → launch_receipts: [line]  # 各审查员报告落盘回执清单
27.1. [act] 拆本轮派发材料为平变量（call 参数映射只认整名变量,字段路径不进映射）
  - ← item
  + → cur_prompt: text  # 本审查员完整自包含指令
  + → cur_dir: line  # 报告落盘目录
  + → cur_file: line  # 报告文件名
  > ```hop_python
  > cur_prompt = get(item, "reviewer_prompt", "")
  > cur_dir = get(item, "report_dir", "")
  > cur_file = get(item, "report_file", "")
  > ```

  27.2. [call reviewer-worker(reviewer_prompt: cur_prompt, review_material: doc_text, report_dir: cur_dir, report_file: cur_file) parallel] 审查员子实例
    + → receipt: report_receipt  # collect 单项端（映射子实例输出 report_receipt）
28. [act free] 逐一验证审查员报告文件存在且内容 >100 字
  - ← launch_receipts, round_plan
  + → reports_check: [yaml]  # 逐文件验证结果：每项 {path, ok}，ok=true 表示文件存在且内容 >100 字
  > 报告路径定位基准：launch_receipts（步骤 27 各审查员子实例落盘回执,每条即报告完整路径）与 round_plan（轮次 ID）；逐一读取验证文件存在且内容长度 >100 字（子实例失败不产回执时该视角自然缺席——按 round_plan 全量对照,缺席的按 ok=false 计入）；全部计入 reports_check。
29. [act] 统计可用报告数（成功数）
  - ← reports_check
  + → available_count: int  # 可用报告数（ok=true 的条数）
  > ```hop_python
  > available_count = len([x for x in reports_check if x["ok"]])
  > ```
30. [branch] 按可用报告数分流
  - ← available_count
  + → synthesis_required: bool  # 是否启动汇聚分析员（父层第 4 步据此条件执行）
  + → direct_summary: bool  # 是否由 orchestrator 直接汇总核心发现（父层第 5 步接力）
  + → missing_views: [line]  # ≥3 路径：缺失视角（无可用报告）清单，标注"未覆盖"；<3 路径为空列表
  + → insufficient_note: line  # <3 路径："审查员样本不足，未进行汇聚分析"；≥3 路径为空串
  30.1. [case(available_count >= 3)] 可用报告 ≥3：正常启动汇聚分析员
    30.1.1. [act] 标注缺失视角"未覆盖"并置启动/直汇标志
      - ← reports_check
      + → missing_views: [line]  # 缺失视角清单（无可用报告的报告文件，逐条"<文件名>: 未覆盖"）
      + → synthesis_required: bool  # true——正常启动汇聚分析员
      + → direct_summary: bool  # false——由汇聚分析员汇总，orchestrator 不直接汇总
      + → insufficient_note: line  # 空串——无样本不足标注
      > ```hop_python
      > missing_views = [split(p["path"], "/")[-1] + ": 未覆盖" for p in reports_check if not p["ok"]]
      > synthesis_required = true
      > direct_summary = false
      > insufficient_note = ""
      > ```
  30.2. [case(else)] 可用报告 <3：不启动汇聚，orchestrator 直接汇总核心发现
    30.2.1. [act] 置跳过汇聚标志、直接汇总标志与样本不足标注
      + → synthesis_required: bool  # false——不启动汇聚分析员
      + → direct_summary: bool  # true——orchestrator 直接汇总已完成报告核心发现
      + → insufficient_note: line  # 样本不足标注
      + → missing_views: [line]  # 空列表——无汇聚、无缺失视角标注
      > ```hop_python
      > synthesis_required = false
      > direct_summary = true
      > insufficient_note = "审查员样本不足，未进行汇聚分析"
      > missing_views = []
      > ```
31. [branch] 按 synthesis_required 分流：true→启动汇聚分析员；false→跳过汇聚，orchestrator 直接汇总核心发现（header 约束 4"不足则跳过汇聚直接汇总"）
  - ← synthesis_required
  + → synthesis_report: markdown  # 汇聚报告或 orchestrator 直接汇总稿（供步骤 33/34 与公共收尾消费）
  31.1. [case(synthesis_required)] 启动汇聚分析员
31.1.1. [act free] 组装汇聚分析员派发材料：完整模板 prompt+全部可用报告拼合+落盘路径
  - ← reports_check, templates_content, round_plan
  + → synth_prompt: text  # 汇聚分析员完整自包含指令（模板完整内容,替换 {round_id}）
  + → synth_material: text  # 审查材料=全部可用审查报告全文拼合（reports_check 中 ok=true 各条,每份前加"## 报告:<文件名>"分隔头）
  + → synth_dir: line  # 落盘目录 = "rounds/" + 汇聚分析员所在 round_id
  > round_id 取 round_plan 中汇聚分析员所在轮条目（r+三位序号）;模板取 templates_content 中汇聚分析员条目完整内容不概括。

    31.1.2. [call reviewer-worker(reviewer_prompt: synth_prompt, review_material: synth_material, report_dir: synth_dir, report_file: "synthesis.md")] 汇聚分析员子实例（串行——须读齐全部报告后运行）
      + → synthesis_report: report_md  # 汇聚报告（映射子实例输出 report_md;≤3000 字,无法裁决的矛盾标注"待作者裁定"）
      > 写盘由子实例 commit 承载（rounds/{round_id}/synthesis.md）——33 步据此读盘、34 步 priority_issues 以汇聚分析员排序输出为输入;样本不足直汇路径（31.2）不产生 synthesis.md,33 步跳过该文件不报错。
  31.2. [case(else)] 样本不足（可用报告 <3）：跳过汇聚，orchestrator 直接汇总已完成报告的核心发现
    31.2.1. [act free] 直接汇总已完成报告的核心发现为 synthesis_report（标注样本不足与缺失视角，整体标注"未经汇聚分析"）
      - ← reports_check, missing_views, insufficient_note, direct_summary
      + → synthesis_report: markdown  # orchestrator 直接汇总稿（标注"审查员样本不足，未进行汇聚分析"与缺失视角清单）
      > 执行期按 reports_check 各条 path 读取 ok=true 报告全文（文件存在且内容 >100 字）后，汇总各报告核心发现为 synthesis_report——仅汇总不重评，不执行交叉验证/矛盾裁决（样本不足路径无汇聚）；整体标注"审查员样本不足，未进行汇聚分析"（insufficient_note），并列缺失视角（missing_views 逐条）。
32. [subtask retry=2] 轮次归档事务:创建 rounds/{round_id}/ 并移入风险点清单（持久写盘归 commit 承载）
  + → archive_receipt: line  # 归档回执
  32.1. [act] 备归档参数（轮次 ID 与源/目标路径）
    - ← round_plan
    + → arch_round_id: line  # 本轮轮次 ID（r+三位序号,取 round_plan 首轮条目）
    > 从 round_plan 提取首轮 round_id（r+三位序号格式）产出 arch_round_id——供 32.3 commit 机械消费。
  32.2. [check final] 归档参数合规
    - ← arch_round_id
    + → arch_ok: bool  # 判定
    + → arch_note: text  # 缺口
    > 核验 arch_round_id 为 r+三位序号形态（如 r001）非空非占位——不合规打回重取。
  32.3. [commit] 建轮次目录并移入风险点清单
    - ← arch_round_id
    + → archive_receipt: line  # 归档回执
    > ```hop_python
    > makedirs(path: "rounds/" + arch_round_id)
    > src_text = read(path: "rounds/风险点清单.md")
    > write(path: "rounds/" + arch_round_id + "/风险点清单.md", content: src_text)
    > archive_receipt = "rounds/" + arch_round_id + "/风险点清单.md"
    > ```
33. [act free] 读取本轮全部评审报告内容
  - ← round_plan
  + → report_contents: [yaml]  # 本轮评审报告列表：每项含文件名与全文内容
  > 从 rounds/{round_id}/ 目录读取本轮全部 reviewer_{slug}.md 与 synthesis.md 文件内容（round_id 取 round_plan 中汇聚分析员所在轮条目；文件由前序审查/汇聚步骤写入；样本不足直汇路径无 synthesis.md 文件时跳过该文件不报错）
34. [reason] 汇总评审结果，产出 priority_issues 优先问题清单（P0/P1，标注来源并按优先级排序，供对焦与修改）
  - ← report_contents
  + → priority_issues: [yaml]  # 优先问题清单（P0/P1，含来源与排序，供对焦与修改）
35. [branch] 按已确认评审模式分流收尾（人工确认/自动修复），两模式共用公共收尾
  - ← review_mode
  + → review_result: markdown  # 评审交付物——优先问题清单、对焦决策记录与评审总结（自动修复模式含实际修改摘要）
  35.1. [case(review_mode == "manual")] 人工确认模式收尾：逐条对焦 P0/P1 问题并确认，产出去敏感化的对焦决策记录写盘，按结构化编辑清单机械核对精确替换补全源文档
    35.1.1. [act free] 统计 P0/P1 问题数量并确定问题清单来源——P0/P1 清单取自步骤 34 的 priority_issues（含问题编号与排序），按严重级别分类、统计数量，产出 p0_count/p1_count/p0_list/p1_list 四变量供父层 branch 分流与逐条对焦遍历
      - ← doc_path, priority_issues
      + → p0_count: int  # P0 问题数量（分流条件）
      + → p1_count: int  # P1 问题数量（分流条件）
      + → p0_list: [yaml]  # P0 问题清单（逐条对焦的遍历来源）
      + → p1_list: [yaml]  # P1 问题清单（逐条对焦的遍历来源）
    35.1.2. [branch] 按 P0 数量分流对焦
      - ← p0_count
      + → focus_p0: yaml  # P0 对焦结果（各问题编号、判定结论 a/b/c、处理状态）
      35.1.2.1. [case(p0_count <= 5)] P0 数量≤5：逐条对焦确认
        35.1.2.1.1. [loop for-each p0_item in p0_list, collect focus_entry into focus_entries] 逐条对焦确认 P0 问题（≤5 条）
          - ← p0_list
          + → focus_entries: [yaml]  # 逐条对焦结果条目（collect 汇总：各问题编号、判定结论 a/b/c、处理状态）
          35.1.2.1.1.1. [ask require_human present_inputs=p0_item] 呈示本 P0 问题，请用户按 a/b/c 三选项确认处理方式
            - ← p0_item
            + → p0_choice: enum(a,b,c)  # 用户选择：a 确认真缺口需修改 / b 已有方案未写需补充 / c 非真问题驳回
            + → p0_answer: text  # 用户随选择给出的说明（选 b 时为已有方案内容及应补充章节；选 a/c 可为空）
            > 向用户呈示本 P0 问题与 a/b/c 三选项含义；执行时可引用对焦原则与常见高估场景材料辅助判断，以用户选择为准。
          35.1.2.1.1.2. [branch] 按用户选择分流处理本问题
            - ← p0_choice
            + → focus_entry: yaml  # 本问题对焦结果条目（collect 单项槽）
            35.1.2.1.1.2.1. [case(p0_choice == "a")] 确认真缺口：追问修改方向
              35.1.2.1.1.2.1.1. [ask require_human present_inputs=p0_item] 追问本问题的具体修改方向
                - ← p0_item
                + → modify_direction: text  # 用户给出的修改方向
              35.1.2.1.1.2.1.2. [reason] 汇总本问题信息与修改方向，生成判定 a 的对焦结果条目
                - ← p0_item, modify_direction
                + → focus_entry: yaml  # 判定 a：确认真缺口需修改，含修改方向
            35.1.2.1.1.2.2. [case(p0_choice == "b")] 已有方案未写：记录答案并标注补充位置
              35.1.2.1.1.2.2.1. [reason] 记录用户答案，确定"方案需补充到第X章"标注并生成对焦结果条目
                - ← p0_item, p0_answer
                + → focus_entry: yaml  # 判定 b：已有方案未写需补充（含应补充章节标注）
            35.1.2.1.1.2.3. [case(p0_choice == "c")] 非真问题：驳回并移出待修改清单
              35.1.2.1.1.2.3.1. [reason] 标注"已驳回"并移出待修改清单，生成对焦结果条目
                - ← p0_item
                + → focus_entry: yaml  # 判定 c：非真问题已驳回
          35.1.2.1.1.3. [act] 将本条对焦结果追加到对焦决策进度记录（work_zone 过程记录）
            - ← focus_entry
            > ```hop_python
            > append(path: work_zone_path("focus_decision_progress.md"), content: str(focus_entry) + "\n")
            > ```
        35.1.2.1.2. [reason] 合并全部 P0 对焦结果条目，统一问题编号、判定结论与处理状态，产出 focus_p0
          - ← focus_entries
          + → focus_p0: yaml  # P0 逐条对焦确认结果（各问题编号、判定结论 a/b/c、处理状态）
      35.1.2.2. [case(p0_count > 5)] P0 数量>5：先标注优先对焦项再逐条确认
        35.1.2.2.1. [ask require_human present_inputs=p0_list] 展示全量 P0 列表，经 orchestrator 问答请用户标注"优先对焦"的问题
          - ← p0_list
          + → p0_priority_items: [yaml]  # 用户标注的优先对焦项清单（含问题编号，供下一块逐条遍历）
        35.1.2.2.2. [subtask retry=2] 逐条对焦确认（对焦决策.md 写盘统一由 35.1.6.3 承载，本子节点不写盘）
          + → focus_p0: yaml  # 交付契约名——P0 标注项逐条对焦确认结果（各问题编号、判定结论 a/b/c、处理状态；含 formal_content 字段=去敏感化正式版正文）
          35.1.2.2.2.1. [loop for-each item in p0_priority_items, collect focus_item into focus_items] 逐条对焦确认：经问答对每条 P0 优先对焦项按 a/b/c 三选项处理
            - ← p0_priority_items
            + → focus_items: [yaml]  # 逐条对焦确认结果（每条含问题编号、判定结论 a/b/c、处理状态）
            > 单条对焦格式为原文材料，随本条循环执行说明引用——每条按该格式组织询问话术与记录结构
            35.1.2.2.2.1.1. [ask require_human present_inputs=item] 呈现本条 P0 对焦项，按 a/b/c 三选项询问处理方式
              - ← item
              + → choice: enum(a,b,c)  # 用户选择：a=追问修改方向；b=记录答案并标注补充章节；c=驳回移出
              + → answer: text  # 用户本次问答给出的内容（选 b 时即待记录答案）
            35.1.2.2.2.1.2. [branch] 按用户选择分流处理
              - ← choice
              35.1.2.2.2.1.2.1. [case(choice == "a")] 追问修改方向
                35.1.2.2.2.1.2.1.1. [ask require_human present_inputs=item] 追问本条的具体修改方向
                  - ← item
                  + → direction: text  # 用户给出的修改方向
                35.1.2.2.2.1.2.1.2. [reason] 按单条对焦格式整理本条对焦结果（判定 a）
                  - ← item, direction
                  + → focus_item: yaml  # 本条对焦结果（含问题编号、判定结论 a、修改方向、处理状态）
              35.1.2.2.2.1.2.2. [case(choice == "b")] 记录答案并标注补充章节
                35.1.2.2.2.1.2.2.1. [reason] 按单条对焦格式记录用户答案并标注"方案需补充到第X章"
                  - ← item, answer
                  + → focus_item: yaml  # 本条对焦结果（含问题编号、判定结论 b、记录答案、补充章节标注、处理状态）
              35.1.2.2.2.1.2.3. [case(choice == "c")] 驳回并移出待修改清单
                35.1.2.2.2.1.2.3.1. [reason] 按单条对焦格式标注"已驳回"并移出待修改清单
                  - ← item
                  + → focus_item: yaml  # 本条对焦结果（含问题编号、判定结论 c、处理状态=已驳回）
          35.1.2.2.2.2. [loop for-each item in focus_items] 逐条将 P0 对焦确认结果追加过程记录到 work_zone
            - ← focus_items
            35.1.2.2.2.2.1. [act] 将当前 P0 对焦确认结果追加为一条过程记录到 work_zone 对焦决策.md
              - ← item
              > ```hop_python
              > id_str = str(get(item, "id", ""))
              > concl = str(get(item, "conclusion", ""))
              > stat = str(get(item, "status", ""))
              > rec_line = f"- P0 {id_str}：对焦结论 {concl}，处理状态 {stat}"
              > append(path: work_zone_path("对焦决策.md"), content: rec_line + "\n")
              > ```
          35.1.2.2.2.3. [subtask retry=2] 汇总对焦确认结果（对焦决策.md 写盘统一由 35.1.6.3 承载，本子节点不写盘）
            + → focus_p0: yaml  # P0 标注项逐条对焦确认结果（含 formal_content 字段=去敏感化正式版正文）
            35.1.2.2.2.3.1. [reason] 汇总全部处理完的对焦确认结果，产出 focus_p0（含问题编号、判定结论 a/b/c、处理状态与 formal_content 字段=去敏感化后的正式版 markdown 正文）
              - ← focus_items
              + → focus_p0: yaml  # P0 标注项逐条对焦确认结果（含 formal_content 字段=去敏感化正式版正文）
              > 引用对焦原则（先判断真实性、可被推翻、先记录后修改、去敏感化）与常见高估场景（均材料，随本条执行说明引用）；formal_content 做去敏感化处理——角色描述替代真实人名/单位名
            35.1.2.2.2.3.2. [check final] 验收 focus_p0 就绪：含各问题编号、判定结论 a/b/c、处理状态字段，formal_content 非空且已去敏感化（角色描述替代真实人名/单位名）
              - ← focus_p0
              + → focus_ok: bool  # 判定槽：focus_p0 是否就绪（结构完整且 formal_content 已去敏感化）
              + → focus_note: text  # 说明槽：不过时逐条列缺口
    35.1.3. [branch] 按 P1 数量分流对焦
      - ← p1_count
      + → focus_p1: yaml  # P1 对焦结果（各问题编号、判定结论 a/b/c、处理状态）
      35.1.3.1. [case(p1_count <= 5)] P1 数量≤5：逐条对焦确认
        35.1.3.1.1. [loop for-each p1 in p1_list, collect focus_item into focus_items] 逐条对焦确认 P1 问题（≤5）：每条按 a/b/c 三选项询问确认、按选择处理、同步更新对焦决策记录
          - ← p1_list
          + → focus_items: [yaml]  # 逐轮对焦结果槽值列表（未命中轮为 null）
          35.1.3.1.1.1. [ask require_human present_inputs=p1] 向用户呈现当前 P1 问题，按 (a) 确认真缺口需修改 / (b) 已有方案未写需补充 / (c) 非真问题驳回 三选项询问确认（交互经 orchestrator 问答步骤）
            - ← p1
            + → p1_choice: enum(a, b, c)  # 用户判定选项：a 真缺口 / b 需补充 / c 驳回
            > 按对焦原则与常见高估场景材料，向用户完整呈现当前 P1 问题的定位依据与判定三选项含义
          35.1.3.1.1.2. [branch] 按用户判定分流处理
            - ← p1_choice
            + → focus_item: yaml  # 本条对焦结果（collect 单项槽）
            35.1.3.1.1.2.1. [case(p1_choice == "a")] 确认真缺口需修改：追问修改方向
              35.1.3.1.1.2.1.1. [ask require_human present_inputs=p1] 追问本问题的修改方向与具体建议（经 orchestrator 问答步骤）
                - ← p1
                + → fix_direction: text  # 用户给出的修改方向说明
              35.1.3.1.1.2.1.2. [act] 组装 a 判定结果（待修改，含修改方向）
                - ← p1, fix_direction
                + → focus_item: yaml  # 判定结论 a：待修改 + 修改方向
                > ```hop_python
                > focus_item = {"id": p1["id"], "judgement": "a", "status": "待修改", "direction": fix_direction}
                > ```
            35.1.3.1.1.2.2. [case(p1_choice == "b")] 已有方案未写需补充：记录答案与补充章节
              35.1.3.1.1.2.2.1. [ask require_human present_inputs=p1] 请用户提供已有方案内容并标注需补充到的章节（经 orchestrator 问答步骤）
                - ← p1
                + → solution_text: text  # 用户提供的已有方案内容
                + → target_chapter: line  # 需补充到的章节（如"第3章"）
              35.1.3.1.1.2.2.2. [act] 组装 b 判定结果（需补充，含方案内容与章节）
                - ← p1, solution_text, target_chapter
                + → focus_item: yaml  # 判定结论 b：需补充 + 方案内容 + 章节
                > ```hop_python
                > focus_item = {"id": p1["id"], "judgement": "b", "status": "需补充", "solution": solution_text, "chapter": target_chapter}
                > ```
            35.1.3.1.1.2.3. [case(p1_choice == "c")] 非真问题驳回：标注已驳回并移出待修改清单
              35.1.3.1.1.2.3.1. [act] 组装 c 判定结果（已驳回，不入待修改清单）
                - ← p1
                + → focus_item: yaml  # 判定结论 c：已驳回
                > ```hop_python
                > focus_item = {"id": p1["id"], "judgement": "c", "status": "已驳回"}
                > ```
          35.1.3.1.1.3. [act] 追加本条对焦结果到对焦决策过程记录（work_zone 过程件，非最终交付写盘）
            - ← focus_item
            > ```hop_python
            > rec = "## " + str(focus_item["id"]) + "\n判定: " + focus_item["judgement"] + "\n状态: " + focus_item["status"] + "\n"
            > append(path: work_zone_path("focus_p1_progress.md"), content: rec)
            > ```
        35.1.3.1.2. [act] 汇聚逐条对焦结果为 focus_p1
          - ← focus_items
          + → focus_p1: yaml  # P1 逐条对焦确认结果（各问题编号、判定结论 a/b/c、处理状态）
          > ```hop_python
          > focus_p1 = [x for x in focus_items if x]
          > ```
      35.1.3.2. [case(p1_count > 5)] P1 数量>5：先标注优先对焦项再逐条确认
        35.1.3.2.1. [ask require_human present_inputs=p1_list] 展示全量 P1 列表，经 orchestrator 问答步骤让用户标注"优先对焦"的问题
          - ← p1_list
          + → p1_focused_list: [yaml]  # 用户标注的优先对焦 P1 问题清单（供后续逐条对焦）
        35.1.3.2.2. [loop for-each item in p1_focused_list, collect item_record into focus_items] 逐条对焦确认 P1 项：经 orchestrator 问答步骤询问用户选择 a/b/c，按选择处理并记录
          - ← p1_focused_list
          + → focus_items: [yaml]  # 逐条对焦确认结果（各问题编号、判定结论 a/b/c、处理状态）
          35.1.3.2.2.1. [ask require_human present_inputs=item] 经 orchestrator 问答步骤呈现单条对焦格式（问题+选项 a/b/c）并询问用户选择
            - ← item
            + → choice: enum(a,b,c)  # 用户选择的判定结论
            + → user_answer: text  # 用户给出的答案（选 b 时填写）
            + → chapter_no: line  # 用户所指需补充的章节号（选 b 时填写）
            > 呈现单条对焦格式：本项问题编号与问题描述 + 选项 a（追问修改方向）/ b（记录答案并标注"方案需补充到第X章"）/ c（标注"已驳回"移出待修改清单）；选 b 时请用户一并给出答案与所指章节号。对焦原则 4 条、常见高估场景 3 条为参考材料随本步供给。
          35.1.3.2.2.2. [branch] 按用户选择分流处理
            - ← choice
            + → item_record: yaml  # 本条对焦确认结果（collect 单项：问题编号+判定结论+处理状态）
            35.1.3.2.2.2.1. [case(choice == "a")] 追问修改方向
              35.1.3.2.2.2.1.1. [ask require_human present_inputs=item] 追问修改方向，请用户给出拟修改方向意见
                - ← item
                + → modify_direction: text  # 用户给出的拟修改方向意见（供下游确认后修改）
              35.1.3.2.2.2.1.2. [act] 组装本条对焦记录（判定结论 a）
                - ← item, modify_direction
                + → item_record: yaml  # 本条对焦确认结果
                > ```hop_python
                > item_record = {"问题编号": item["问题编号"], "判定结论": "a", "处理状态": "已记录拟修改方向", "拟修改方向": modify_direction}
                > ```
            35.1.3.2.2.2.2. [case(choice == "b")] 记录答案并标注需补充章节
              35.1.3.2.2.2.2.1. [act] 记录用户答案，标注"方案需补充到第X章"
                - ← item, user_answer, chapter_no
                + → item_record: yaml  # 本条对焦确认结果
                > ```hop_python
                > item_record = {"问题编号": item["问题编号"], "判定结论": "b", "处理状态": "已记录答案，方案需补充到第" + chapter_no + "章", "答案": user_answer}
                > ```
            35.1.3.2.2.2.3. [case(choice == "c")] 标注已驳回并移出待修改清单
              35.1.3.2.2.2.3.1. [act] 标注"已驳回"，将该条移出待修改清单
                - ← item
                + → item_record: yaml  # 本条对焦确认结果
                > ```hop_python
                > item_record = {"问题编号": item["问题编号"], "判定结论": "c", "处理状态": "已驳回，移出待修改清单"}
                > ```
        35.1.3.2.3. [subtask retry=2] 汇总各条对焦结果为 focus_p1（对焦决策.md 写盘统一由 35.1.6.3 承载，本子节点不写盘）
          + → focus_p1: yaml  # P1 标注项逐条对焦确认结果（各问题编号、判定结论 a/b/c、处理状态）
          35.1.3.2.3.1. [reason] 汇总 focus_items 为 focus_p1（各问题编号、判定结论 a/b/c、处理状态）
            - ← focus_items
            + → focus_p1: yaml  # P1 标注项逐条对焦确认结果（各问题编号、判定结论 a/b/c、处理状态）
          35.1.3.2.3.2. [check final] 验收 focus_p1 完整（各问题编号/判定结论/处理状态无遗漏）
            - ← focus_p1
            + → record_ok: bool  # 判定槽：各问题编号/判定结论/处理状态无遗漏
            + → record_note: text  # 说明槽：不达标时的缺口清单
    35.1.4. [reason] 合并 P0/P1 对焦结果，统一问题编号、判定结论与处理状态，产出完整 focus_draft
      - ← focus_p0, focus_p1
      + → focus_draft: yaml  # 完整对焦确认结果（各问题编号、判定结论 a/b/c、处理状态，供生成决策记录与终判）
    35.1.5. [act] 确定当前评审轮次标识 round_id（取 round_plan 末轮——汇聚分析员固定收尾所在轮，对焦决策与其同轮；与评审报告/汇聚报告的目录取号同源，多轮运行不劈叉）
      - ← round_plan
      + → round_id: line  # 评审轮次标识，写盘目录与决策记录标题用
      > ```hop_python
      > last_round = round_plan[len(round_plan) - 1]
      > round_id = last_round["round_id"]
      > ```
    35.1.6. [subtask retry=2] 生成去敏感化对焦决策记录、核验达标后 commit 写盘至 rounds/{round_id}/对焦决策.md（写盘须先于后续源文档修改，约束 9）
      + → focus_record: markdown  # 去敏感化完整对焦决策记录（交付物，已 commit 写盘）
      35.1.6.1. [reason] 汇总 focus_draft 产出去敏感化的完整对焦决策记录 focus_record
        - ← focus_draft, round_id
        + → focus_record: markdown  # 去敏感化完整对焦决策记录
        > 组织依据（材料随本步引用）：按原文《决策文档结构》组织——文档含标题（形如"# r001 评审对焦决策"，r 后接当前轮次 round_id）、按 P0 主题分类的决策章、待对焦问题节三部分；真实人名/单位名一律替换为角色描述（header_final 约束 11）；内容以 focus_draft 各问题的编号、判定结论 a/b/c 与处理状态为准汇总，不添不漏。
      35.1.6.2. [check final] 核验 focus_record 达标：结构完整（含标题、按 P0 主题分类的决策章、待对焦问题节）且已去敏感化（无真实人名/单位名，用角色描述替代）
        - ← focus_record
        + → record_ok: bool  # 判定槽：结构完整且已去敏感化
        + → record_note: text  # 说明槽：不达标时逐条列缺口
      35.1.6.3. [commit] 写盘 focus_record 至 rounds/{round_id}/对焦决策.md（hop_python 机械落盘；目标目录已存在则复用，README 初始化不在本节点动线内；约束 9 要求先于后续源文档修改）
        - ← focus_record, round_id
        > ```hop_python
        > makedirs(path: "rounds/" + round_id)
        > target = "rounds/" + round_id + "/对焦决策.md"
        > write(path: target, content: focus_record)
        > ```
    35.1.7. [subtask retry=2] 按结构化编辑清单机械核对精确替换补全源文档（对焦决策确认后执行）
      + → edit_report: markdown  # 结构化编辑清单执行结果（替换条数、未命中报错、修改后结构与原文对照状态）
      35.1.7.1. [act] 读取源文档全文并落涂鸦区作替换累计稿副本
        - ← doc_path
        + → doc_content: text  # 源文档全文（供清单生成与逐条核对）
        > ```hop_python
        > doc_content = read(path: doc_path)
        > write(path: work_zone_path("cur_doc.md"), content: doc_content)
        > ```
      35.1.7.2. [reason] 依据对焦决策记录与源文档全文化成结构化编辑清单
        - ← focus_record, doc_content
        + → edit_plan: [yaml]  # 结构化编辑清单：每条含 原文片段 与 替换片段 两字段；原文片段带足上下文保证全文唯一；补全而非重写、不替换原文思路
      35.1.7.3. [check] 核验编辑清单全部原文片段在源文档中唯一存在
        - ← edit_plan, doc_content
        + → plan_ok: bool  # 判定槽：全部原文片段唯一命中为真
        + → plan_note: text  # 说明槽：未命中或非唯一时逐条列清单
        > ```hop_python
        > bad = [e["原文片段"] for e in edit_plan if len(split(doc_content, e["原文片段"])) != 2]
        > plan_ok = len(bad) == 0
        > plan_note = "全部原文片段唯一命中" if plan_ok else "未命中或非唯一: " + join(bad, "; ")
        > ```
      35.1.7.4. [loop for-each edit in edit_plan, collect item into applied_list] 逐条核对原文片段存在并精确替换（涂鸦区累计成稿,不落源文档）
        - ← edit_plan
        + → applied_list: [yaml]  # 各条执行结果（状态：已替换/未命中）
        35.1.7.4.1. [act] 读取累计稿、核对该条原文片段、替换后写回涂鸦区
          - ← edit
          + → item: yaml  # 本条执行结果
          > ```hop_python
          > prev_doc = read(path: work_zone_path("cur_doc.md"))
          > if edit["原文片段"] in prev_doc:
          >     new_doc = replace(prev_doc, edit["原文片段"], edit["替换片段"])
          >     write(path: work_zone_path("cur_doc.md"), content: new_doc)
          >     item = {"原文片段": edit["原文片段"], "状态": "已替换"}
          > else:
          >     item = {"原文片段": edit["原文片段"], "状态": "未命中"}
          > ```
      35.1.7.5. [commit] 机械写回源文档并产出编辑执行报告
        - ← doc_path, applied_list
        + → edit_report: markdown  # 替换条数、未命中报错、修改后结构与原文对照状态
        > ```hop_python
        > final_doc = read(path: work_zone_path("cur_doc.md"))
        > missed = [i["原文片段"] for i in applied_list if i["状态"] == "未命中"]
        > if missed:
        >     edit_report = "未命中报错, 未写回源文档: " + join(missed, "; ")
        > else:
        >     write(path: doc_path, content: final_doc)
        >     edit_report = join(["替换条数: " + str(len(applied_list)), "未命中: 无", "修改状态: 已机械精确替换并写回, 未整文档重写"], "\n")
        > ```
    35.1.8. [reason] 判断是否需新一轮评审并产出终版评审交付物：P0 全解决且 P1 基本覆盖则评审结束；修改引入新的结构性问题则启动下一轮（r002）
      - ← focus_record, edit_report, priority_issues
      + → review_result: markdown  # 人工确认模式评审交付物（含优先问题清单、对焦决策记录与评审总结，内附是否启动下一轮判断）
      > 判定判据（原文异常处理"全部 P0 被对焦确认为非真问题"）：P0/P1 按严重度分类、非排名——即使全部 P0 被对焦确认为"非真问题"（P0 清零），P1 也不自动升级；直接检查 P1 是否有阻塞项（严重度 4-5）——严重度/优先级分布数据取 priority_issues（步骤 34 优先问题清单，含问题编号与排序、P0/P1 分类与来源，本步 - ← 已声明接入），按实际严重度分布判定评审结论：P0 全解决且 P1 基本覆盖→评审结束；修改引入新的结构性问题→启动下一轮（r002）。
      > 交付物组装（header_final.outputs 契约 review_result=优先问题清单+对焦决策记录+评审总结）：优先问题清单取 priority_issues（步骤 34 产出）；对焦决策记录取 focus_record（35.1.6 已写盘）；评审总结含是否启动下一轮判断。
  35.2. [case(review_mode == "auto")] 自动修复模式收尾：读取汇聚报告提取 P0/P1 修改建议，去重合并为结构化编辑清单，机械核对精确替换源文档并输出修改摘要
    35.2.1. [reason] 依据 priority_issues 提取 P0/P1 问题清单
      - ← priority_issues
      + → p0p1_issues: [yaml]  # P0/P1 问题清单（自 priority_issues 提取，含问题编号）
      > 自 priority_issues（步骤 34 优先问题清单，含问题编号与排序）中提取 P0 级与 P1 级问题，整理为结构化清单；不再从汇聚报告文件现场读取。
    35.2.2. [act free] 逐一读取各审查员报告的"建议修改清单"章节，汇总各建议条目
      - ← reports_check
      + → raw_suggestions: [yaml]  # 各审查员报告建议修改清单条目（源文档位置、问题、修改建议;尚未关联编号）
      > 报告路径取自 reports_check（步骤 28 逐文件验证结果，每项含 path）；逐一读取可用报告（ok=true）的"### 建议修改清单"章节，汇总各条建议条目；报告无该章节时跳过。
    35.2.3. [reason] 按问题编号将各建议关联到 P0/P1 问题（对照 p0p1_issues），产出 linked_suggestions
      - ← p0p1_issues, raw_suggestions
      + → linked_suggestions: [yaml]  # 按问题编号关联后的建议清单（审查员建议→问题映射）
    35.2.4. [reason] 按判同一问题规则（引用同一段落/行号，或关键词重叠≥50%）去重合并为结构化编辑清单，每条含【原文片段】与【替换片段】
      - ← linked_suggestions
      + → edit_list: [yaml]  # 结构化编辑清单（每条含【原文片段】与【替换片段】）
      > 对 linked_suggestions 按以下规则去重合并：
      > - 判"同一问题"：满足任一条件——(a) 引用同一段落/行号；(b) 问题描述关键词重叠 ≥ 50%
      > - 同一段落的不同建议：合并为一条，取各建议的并集
      > - 同一问题的不同方案：选覆盖范围更大的（修改行数多者 > 影响章节数多者 > 修改更彻底者），丢弃更保守的方案
      > - 覆盖范围相当且方案互斥（如同一处"术语改 A"与"术语改 C"）：合并为一条并标注待确认，保留候选方案注明交作者决定
      > 每条 edit_list 项必含两个字段：
      > - 【原文片段】：带足上下文保证在源文档中全文唯一（供后续机械替换精确定位）
      > - 【替换片段】：合并后的最终文本；待确认条目保留各候选方案并注明"待确认"
    35.2.5. [check] 核验编辑清单全部原文片段在源文档中唯一存在
      - ← edit_list, doc_path
      + → edit_ok: bool  # 判定槽：全部原文片段唯一命中为真
      + → edit_note: text  # 说明槽：未命中或非唯一时逐条列清单
      > ```hop_python
      > doc = read(path: doc_path)
      > bad = [get(e, "原文片段") for e in edit_list if len(split(doc, get(e, "原文片段"))) != 2]
      > edit_ok = len(bad) == 0
      > edit_note = "全部原文片段唯一命中" if edit_ok else "未命中或非唯一: " + join(bad, "; ")
      > ```
    35.2.6. [act] 读取源文档全文并落涂鸦区作替换累计稿副本
      - ← doc_path
      > ```hop_python
      > doc_content = read(path: doc_path)
      > write(path: work_zone_path("auto_cur_doc.md"), content: doc_content)
      > ```
    35.2.7. [loop for-each edit in edit_list, collect item into applied_items] 逐条核对原文片段存在并精确替换（涂鸦区累计成稿,不落源文档）
      - ← edit_list
      + → applied_items: [yaml]  # 各条执行结果（状态：已替换/未命中）
      35.2.7.1. [act] 读取累计稿、核对该条原文片段、替换后写回涂鸦区
        - ← edit
        + → item: yaml  # 本条执行结果
        > ```hop_python
        > prev_doc = read(path: work_zone_path("auto_cur_doc.md"))
        > if get(edit, "原文片段") in prev_doc:
        >     new_doc = replace(prev_doc, get(edit, "原文片段"), get(edit, "替换片段"))
        >     write(path: work_zone_path("auto_cur_doc.md"), content: new_doc)
        >     item = {"原文片段": get(edit, "原文片段"), "状态": "已替换"}
        > else:
        >     item = {"原文片段": get(edit, "原文片段"), "状态": "未命中"}
        > ```
    35.2.8. [commit] 机械写回源文档并产出修改清单（read→逐条核对原文片段存在→replace→write，不存在即报错不写回，禁整文件重写式修改；编辑顺序已由 35.2.4 合并清单排定：先结构性调整、再局部修正、最后措辞优化——避免行号因前序编辑漂移）
      - ← doc_path, applied_items
      + → applied_changes: [yaml]  # 实际执行的修改清单（位置+改动内容）
      > ```hop_python
      > final_doc = read(path: work_zone_path("auto_cur_doc.md"))
      > missed = [i["原文片段"] for i in applied_items if i["状态"] == "未命中"]
      > if missed:
      >     applied_changes = [{"position": "未命中报错", "content": "未写回源文档: " + join(missed, "; ")}]
      > else:
      >     write(path: doc_path, content: final_doc)
      >     applied_changes = [{"position": i["原文片段"], "content": "已替换"} for i in applied_items]
      > ```
    35.2.9. [reason] 汇总实际执行的修改清单（位置+改动内容）生成修改摘要（不逐条确认），产出 review_result
      - ← applied_changes, p0p1_issues
      + → review_result: markdown  # 自动修复模式评审交付物（含实际修改摘要）
      > 交付物组装（header_final.outputs 契约 review_result=优先问题清单+评审总结+实际修改摘要）：优先问题清单取 p0p1_issues（35.2.1 自 priority_issues 提取的 P0/P1 清单，含问题编号与来源，与本步同处 case 35.2 顺序链内）；实际修改摘要取 applied_changes（35.2.8 实际执行清单，位置+改动内容）；不逐条确认。
36. [subtask retry=2] 首轮评审完成后回填 README 高频脆弱点并置 active：读 synthesis_report 提取 P0 分布，更新 DocReviewers/{domain_name}/README.md 的 status 与高频脆弱点字段；非首轮或样本不足直汇路径跳过放行
  + → readme_backfilled: line  # 回填回执（"已回填" / "跳过"）
  36.1. [reason] 判定是否执行回填并组装回填内容：首轮评审且非样本不足直汇路径时，读取 synthesis_report 提取 P0 分布、组装更新后 README 内容；否则置 backfill_needed=false
    - ← domain_name, synthesis_report, insufficient_note, readme_exists
    + → backfill_needed: bool  # 是否需要回填（本领域首轮评审且非样本不足直汇路径为 true）
    + → readme_updated: text  # 更新后 README.md 全文（status: active + 高频脆弱点已按 P0 分布回填；仅回填时产出）
    > 回填判定（首轮判据取步骤 21 产出的 readme_exists）：仅当 readme_exists=false（本领域首轮冷启动，22.1.1 路径写入的 README 为 status: bootstrapping）且非样本不足直汇路径（insufficient_note 非空=orchestrator 直接汇总稿、非汇聚分析员报告、P0 分布不完整）时 backfill_needed=true 并执行回填；否则 backfill_needed=false（readme_exists=true 即复用场景、领域沉淀已 active，原文"后续同领域评审复用同一目录"隐含不回填，README 维持现状）。回填内容组装：P0 分布自 synthesis_report（汇聚报告，≤3000 字）中的优先问题清单统计；高频脆弱点字段按出现频次最高的 P0 主题组织；status 由 bootstrapping 更新为 active。
  36.2. [branch] 按回填判定分流：需要回填→核验后 commit 写回；无需回填→置"跳过"回执直接放行
    - ← backfill_needed
    + → readme_backfilled: line  # 回填回执（本分支产出，供 subtask 聚合）
    36.2.1. [case(not backfill_needed)] 非首轮或样本不足直汇：跳过回填，README 维持现状
      36.2.1.1. [act] 置 readme_backfilled="跳过" 放行（不走 check/commit，直接通过本 subtask）
        + → readme_backfilled: line  # 回填回执："跳过"
        > ```hop_python
        > readme_backfilled = "跳过"
        > ```
    36.2.2. [case(else)] 首轮评审且非直汇：核验回填内容达标后 commit 写回
      36.2.2.1. [check final] 核验回填内容达标：含 status: active 且高频脆弱点字段已按 P0 分布填写
        - ← readme_updated
        + → backfill_ok: bool  # 判定槽：回填内容是否达标
        + → backfill_note: text  # 说明槽：不达标时逐条列缺口
      36.2.2.2. [commit] 将更新后 README 写回 DocReviewers/{domain_name}/README.md
        - ← readme_updated, domain_name
        + → readme_backfilled: line  # 回填回执："已回填"
        > ```hop_python
        > write(path: "DocReviewers/" + domain_name + "/README.md", content: readme_updated)
        > readme_backfilled = "已回填"
        > ```
37. [act free] 公共收尾：比对 DocReviewers/ 实际目录与 DocTree 记录，自动修正不一致