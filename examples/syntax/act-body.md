# Spec: 报销单核算
Id: expense-check
Goal: 核算一批报销金额——合计、找最大单笔、按公司规则判定审批级别，全程确定性计算（金额计算绝不交给 LLM 心算）

## Inputs
- expenses: yaml  # 报销金额列表（元），如 [120, 88, 1500, 260]
- auto_limit: int  # 免审批上限（元）——合计不超过它则自动通过

## Outputs
- summary: text  # 核算结论

## Steps
1. [act] 合计与找最大单笔
  - ← expenses
  + → total: int  # 合计金额
  + → biggest: int  # 最大单笔
  + → item_count: int  # 笔数
  > 纯计算：金额账引擎算，零 LLM——同样输入永远同样结果
  > ```hop_python
  > total = sum(expenses)
  > biggest = max(expenses)
  > item_count = len(expenses)
  > ```

2. [act] 按公司规则判定审批级别
  - ← total, biggest, item_count, auto_limit
  + → summary: text  # 核算结论
  > 无推理分支：规则是死的（超上限走人工审批、单笔超上限一半要附发票说明），确定性条件分流
  > ```hop_python
  > if total > auto_limit:
  >     level = "人工审批"
  > else:
  >     level = "自动通过"
  > if biggest > auto_limit / 2:
  >     note = "，最大单笔 " + str(biggest) + " 元需附发票说明"
  > else:
  >     note = ""
  > summary = str(item_count) + " 笔共 " + str(total) + " 元，" + level + note
  > ```
