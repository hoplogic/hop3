# Spec: 多渠道数据采集
Id: sibling-parallel
Goal: 并行采集两个独立渠道的舆情数据，汇总为一份简报
> 运行前提：standalone 模式须环境注册 web_search 工具实现（MCP/tool_registry 均可），未注册时检索步骤工具不下发、检索动作无从落实；复用模式由 caller 用自身检索能力承接，无需注册。

## Inputs
- keywords: text  # 检索关键词（逗号分隔）

## Outputs
- brief: text  # 舆情简报

## Steps
1. [subtask] 采集各渠道数据
  + → social_summary: text  # 社交媒体摘要
  + → news_summary: text  # 新闻媒体摘要
  1.1. [subtask parallel] 采集社交媒体舆情
    + → social_summary: text
    1.1.1. [reason] 检索并摘要社交媒体讨论
      - ← keywords
      - 工具: web_search  # 社交平台舆情检索
      + → social_summary: text  # 社交渠道舆情摘要
      > 用 web_search 工具就 keywords 检索社交平台上的近期讨论（微博/X/Reddit 等），
      > 摘要主要观点与情绪倾向，每条注明来源。搜不到如实记"未找到"，不编造。
  1.2. [subtask parallel] 采集新闻舆情
    + → news_summary: text
    1.2.1. [reason] 检索并摘要新闻报道
      - ← keywords
      - 工具: web_search  # 新闻媒体检索
      + → news_summary: text  # 新闻渠道舆情摘要
      > 用 web_search 工具就 keywords 检索主流媒体近期报道，摘要报道口径与关键事实，
      > 每条注明来源。搜不到如实记"未找到"，不编造。

2. [reason] 汇总两渠道简报
  - ← social_summary, news_summary
  + → brief: text  # 舆情简报
  > 对比两渠道的口径差异（社交情绪 vs 媒体报道），汇总为一页简报：
  > 各渠道要点、共识、分歧、值得关注的信号。
