# Spec: 事实核查（演示版）
标识: fact-check-demo
目标: 从文档提取可查证的事实断言，逐条并行搜索外部依据并给来源打可信度标，汇总成核查表——演示版只核一级事实，不做推演审查（完整版见 fact-check.md）

约束:
- 事实断言 = 可独立查证的客观陈述（数据、事件、时间、引述）；观点/预测/推论不在本版核查范围，提取时直接跳过
- 来源可信度三级：authoritative（官方/学术/一手）/ reliable（主流媒体/权威二手）/ not_found（搜不到支撑）
- 每条核查须注明来源（URL 或出处）；搜不到就标 not_found，不编造

类型:
- FactPoint:  # 一条待核查的事实断言
  - id: line  # 编号（F1/F2…）
  - claim: text  # 断言原文/凝练

输入:
- doc_path: line  # 待核查文档路径（.md 或纯文本）

输出:
- report: markdown  # 核查表（逐条：断言/依据/来源/可信度）

## 步骤

1. [探索] 读取文档
  - ← doc_path
  + → doc_content: text  # 文档全文
  > 读取 doc_path 指定的文件全文。若 > 20000 字，报错要求先分拆。

2. [推理] 提取事实断言
  - ← doc_content
  + → points: [FactPoint]  # 事实断言清单
  > 通读文档，穷举**可独立查证的客观断言**（具体数据、发生的事件、时间节点、直接引述），
  > 逐条编号（F1/F2…）。观点、预测、推论跳过不收。一句话含多个断言拆成多点。

3. [询问 present_inputs=points] 确认核查清单
  - ← points
  + → confirmed_points: [FactPoint]  # 确认后的清单
  > 完整展示 points 清单，请 caller 确认或修正（有无漏、有无该删的观点混入）。确认后定稿。

4. [循环 遍历 point 于 confirmed_points, 收集 check_item 入 check_result] 逐条并行核查
  + → check_result: [text]  # 各条核查结论（乱序收集，条目自含编号）
  4.1. [子任务 重试=3 并行] 核查单条断言
    - ← point
    + → check_item: text  # 该条结论：断言/依据摘要/来源/可信度标
    4.1.1. [探索] 搜索外部依据
      - ← point
      + → evidence: text  # 依据（内容摘要 + 来源 URL/出处）
      - 工具: web_search  # 就 point.claim 检索外部依据
      > 用 web_search 就 point.claim 检索。收集支持或反驳的依据，每条记：摘要 + 来源。
      > 搜不到如实记"未找到支撑"，不编造。
    4.1.2. [推理] 评估依据并打可信度标
      - ← point, evidence
      + → check_item: text
      > 判定：依据是否支持断言（支持/部分支持/反驳/无依据）；来源可信度三级打标
      > （见 Constraints）。输出结论文本，**开头带 point.id**（并行乱序收集，靠编号对号）。

5. [推理] 汇总核查表
  - ← check_result, confirmed_points
  + → report: markdown  # 核查表
  > 汇总全部结论成 Markdown 表：`| 编号 | 断言 | 依据摘要 | 来源 | 可信度 |`，
  > 表后给一句总评（几条可信/几条存疑/几条无支撑）。不做新核查。
