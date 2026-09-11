# Spec: 销售数据规整（必失败子流程）
Id: e2e-call-child
Goal: 对传入的销售值做数值规整——传入文本时确定性计算异常，作为 call 跨界失败的固定触发器

## Inputs
- raw_value: text  # 待规整的销售值（e2e 传文本 "not-a-number"，减法必炸）

## Outputs
- normalized: int  # 规整后数值（不会产出）

## Steps
1. [act] 数值规整
  - ← raw_value
  + → normalized: int  # 规整值
  > raw_value 为文本时减法必须转数字 → 计算异常 → 本步 fail → 无边界 → 子实例终止 failed
  > （不要用 * ——Python 语义下 str*int 是合法字符串重复，不是异常）
  > ```hop_python
  > normalized = raw_value - 0
  > ```
