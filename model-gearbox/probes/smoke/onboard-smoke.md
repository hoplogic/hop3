# Spec: Ling 接入冒烟
Id: ling-smoke
Goal: 验证 antchat/Ling-3.0-Flash 经引擎 anthropic 协议通道可完成一次推理步与一次带 body 机械步

Inputs:
- topic: line  # 一个词的主题

Outputs:
- summary: text  # 两句话介绍
- word_count: int  # 介绍的字符数

## Steps

### 1. [reason] 用两句话介绍主题
- ← topic
+ → summary: text  # 两句话介绍（中文,不超过 80 字）

### 2. [act] 统计字符数
- ← summary
+ → word_count: int  # summary 的字符长度

纯机械零 LLM：
> ```hop_python
> word_count = len(summary)
> ```
