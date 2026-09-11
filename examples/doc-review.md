# Spec: 多角度文档评审
Id: doc-review
Goal: 对文档进行多角度专家评审，输出优先问题清单和对焦决策
> 从文档本身推导评审视角（匹配脆弱点），设计审查员角色，并行评审，交叉验证，对焦决策。
> 运行前提：standalone 模式须环境注册 web_search 工具实现（MCP/tool_registry 均可），未注册时步骤 1.4 工具不下发、检索动作无从落实；复用模式由 caller 用自身检索能力承接，无需注册。

Constraints:
- 审查员视角 3-6 个，匹配文档脆弱点而非固定模板
- 审查员报告每章 ≤ 200 字，总 ≤ 1500 字
- 汇聚报告 ≤ 3000 字
- 文档 > 30000 字须先分拆

Types:
- ReviewerDesign:  # 审查员设计
  - name: line  # 角色名称
  - slug: line  # 文件名用 kebab-case
  - stance: line  # 审查立场
  - strategy: line  # 推理策略
  - focus_items: [line]  # 审查重点（3-10 条）
  - output_sections: [line]  # 报告章节

Inputs:
- document_path: line  # 待评审文档路径

Outputs:
- synthesis: text  # 汇聚报告
- decision_output: text  # 对焦决策或修改摘要

## Steps

1. [subtask retry=2] 阶段一：视角设计
  - ← document_path
  + → doc_content: text  # 文档全文
  + → doc_type: line  # 文档定位类型
  + → doc_analysis: text  # 文档分析
  + → reviewers: [text]  # 审查员设计列表（子步骤 1.6 产出；for-each 的 listVar 必须是 [T]，V8）
  + → confirmed_mode: line  # 评审模式

  1.1. [act] 读取待评审文档
    - ← document_path
    + → doc_content: text
    > 读取 document_path 指定的文件全文并核长度：超过 30000 字时用一行必然失败的类型转换制造计算异常，使本步失败（异常信息里带着分拆提示）；不超限时不触发。
    > ```hop_python
    > doc_content = read(path: document_path)
    > if len(doc_content) > 30000:
    >     oversize_error = int("文档超过 30000 字，请分拆后重新提交")
    > ```

  1.2. [reason] 分析文档特征
    - ← doc_content
    + → doc_analysis: text  # 核心主张/架构/推动什么/时间跨度/领域/脆弱点
    > 通读文档回答：核心判断是什么？架构几层几组件？推动谁做什么？时间跨度？领域和文档类型？
    > 从文档类型推导脆弱点（逻辑断裂/资源不足/权力真空/激励错位等）

  1.3. [ask] 确认文档定位类型
    - ← doc_analysis
    + → doc_type: line
    > 基于 doc_analysis 的类型推断，请 caller 确认文档定位类型（市场宣传文/政务新闻稿/技术白皮书/内部方案）。默认采用推断值，可修正。

  1.4. [act free] 行业实践对标
    - ← doc_analysis, doc_type
    - 工具: web_search  # 行业实践检索
    + → risk_points: text  # 行业对标风险点清单
    > 用 web_search 工具检索至少 2 个关键词。整理为风险点清单，标注来源和采纳原因。

  1.5. [ask] 选择评审模式
    - ← risk_points
    + → confirmed_mode: line  # manual_confirm 或 auto_fix
    > 展示风险点清单供 caller 参考，请 caller 选择评审模式：manual_confirm（人工确认）或 auto_fix（自动修复）。

  1.6. [reason] 设计审查员角色
    - ← doc_analysis, risk_points, doc_type
    + → reviewers: [text]  # 审查员设计列表（每个元素是一个审查员的完整角色描述文本）
    > 确定 3-6 个视角。每个五要素：名称/立场/推理策略/审查重点(具体问句)/输出格式。
    > 立场：审慎→偏向怀疑→主动质疑。策略：逆向推理/角色代入/FMEA/时间线推演/约束分析/竞争格局映射。

2. [loop for-each reviewer in reviewers, collect report_item into report] 阶段二：审查员并行评审
  - ← doc_content, doc_type, confirmed_mode
  + → report: [text]  # 各审查员报告（for-each 收集为列表）

  2.1. [subtask retry=1 parallel] 审查员评审
    - ← reviewer, doc_content, doc_type, confirmed_mode
    + → report_item: text  # 该审查员的评审报告
    2.1.1. [reason] 执行评审
      - ← reviewer, doc_content, doc_type, confirmed_mode
      + → report_item: text
      > 以 reviewer 描述的角色、立场、推理策略执行评审。
      > 评审基准 = doc_type。报告：总体评估→各章节(≤200字)→核心关切(严重度1-5)→优点。
      > 自动修复模式附建议修改清单。总 ≤ 1500 字。

3. [reason] 汇聚分析
  - ← report, doc_type
  + → synthesis: text  # 汇聚报告
  + → p0_issues: text  # P0 问题列表
  + → p1_issues: text  # P1 问题列表
  > 不做新审查。读取 reports 列表中全部审查员报告，交叉验证（共识信号+矛盾裁决）→排序→整体裁定。
  > 质量评估：有引文+有独立发现+有量化判断→有效，否则降权。
  > P0=严重度5或严重度4且≥3人指出。P1=严重度3-4。≤ 3000 字。

4. [branch] 按评审模式决策
  - ← confirmed_mode
  + → decision_output: text

  4.1. [case] 人工确认 (confirmed_mode == "manual_confirm")
    + → decision_output: text
    4.1.1. [reason] 生成对焦决策文档
      - ← synthesis, p0_issues, p1_issues
      + → decision_output: text
      > P0→P1 逐条对焦格式：问题 + 三选项（确认真缺口/已有但未写/驳回）。

  4.2. [case] 自动修复 (confirmed_mode == "auto_fix")
    + → decision_output: text
    4.2.1. [reason] 汇总修改建议
      - ← synthesis, p0_issues, report
      + → decision_output: text
      > 提取各报告修改清单，去重合并，按结构性→局部→措辞排序，输出修改摘要。

5. [exit] 交付评审结果
