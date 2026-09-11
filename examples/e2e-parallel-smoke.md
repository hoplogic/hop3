# 并行冒烟（渐进派发最小闭环）
Id: e2e-parallel-smoke

## Goal
三门店销售额并行翻倍后汇总——统一模型渐进派发的最小真机验证件（dispatch_ready→worker→reap 闭环）。

## Inputs
- store_sales: [int]  # 各门店销售额

## Outputs
- doubled_list: [int]  # 翻倍列表（按派发序）
- summary: text  # 汇总说明

## Steps
1. [loop for-each sale in store_sales, collect doubled into doubled_list] 逐店翻倍
  + → doubled_list: [int]  # 收集列表
  1.1. [subtask parallel] 单店翻倍（异步派发）
    + → doubled: int  # 翻倍值
    1.1.1. [act] 翻倍
      - ← sale
      + → doubled: int  # 翻倍值
      > 纯计算
      > ```hop_python
      > doubled = sale * 2
      > ```
2. [act] 汇总
  - ← doubled_list
  + → summary: text  # 例："collected=3"
  > 收齐后消费列表
  > ```hop_python
  > summary = "collected=" + str(count(doubled_list))
  > ```
