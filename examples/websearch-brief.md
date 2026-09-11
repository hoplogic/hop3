# Spec: 检索简报
Id: websearch-brief
Goal: 对给定问题做一轮网页检索并产出带来源的简报——web search 工具端到端最小样例
Inputs:
- question: text  # 要调研的问题（自然语言）
Outputs:
- brief: markdown  # 简报（要点+逐条来源 URL）

## Tools
- web_search(query) -> result: yaml  # 网页检索:查询词→结果页清单（注册见 examples/hoptools-websearch.yaml——provider 中立,tool_id 解耦）
  - query: text  # 检索查询词

## Steps

1. [reason] 提炼检索词
  - ← question
  + → search_query: line  # 检索查询词（问题→精准检索词）
  > 把问题提炼成一条高命中检索词：保留核心实体与关系词，去掉疑问语气词。

2. [act] 检索
  - ← search_query
  + → search_result: yaml  # 检索结果（pages 清单:标题/URL/摘要）
  > ```hop_python
  > search_result = web_search(query: search_query)
  > ```

3. [reason] 成文简报
  - ← question, search_result
  + → brief: markdown  # 简报
  > 按 search_result.pages 逐条消化：与 question 相关的要点归纳成简报，
  > 每个要点后附来源 URL（引用来自哪条结果就用哪条的 URL，不得编造来源）；
  > 结果与问题无关时如实说"本轮检索未命中"，不硬凑。

4. [exit] 交付
  + → brief
