# Spec: 并行部分失败的集合语义
Id: e2e-parallel-partial
Goal: 三路并行处理门店日销数据，其中一路必然计算异常——验证 child fail 不打断兄弟、失败者不贡献收集元素（列表变短）、下游照常消费部分列表

## Inputs
- store_sales: [yaml]  # 三家门店的日销值列表，刻意混入一个文本项（如 [3200, "bad-data", 4100]）

## Outputs
- doubled_list: yaml  # 翻倍结果收集列表（预期长度 2——失败路不贡献元素）
- summary: text  # 下游对部分列表的消费产出

## Steps
1. [loop for-each sale in store_sales, collect doubled into doubled_list] 并行翻倍
  + → doubled_list: [int]  # 收集列表（部分失败=列表变短）
  1.1. [subtask parallel] 单店翻倍（异步派发）
    + → doubled: int  # 翻倍值
    1.1.1. [act] 翻倍
      - ← sale
      + → doubled: int  # 翻倍值
      > 先 int 转换再翻倍：数字项照常；文本项 "bad-data" int 转换必然计算异常 → 该活 fail，不打断兄弟
      > （不要写裸 sale * 2 或 sale + 0——Python 语义下 str*int 是合法字符串重复、str+数在
      > 本引擎按字符串拼接折算，都不炸；int(非数字串) 才是确定性计算异常）
      > ```hop_python
      > doubled = int(sale) * 2
      > ```

2. [act] 汇总部分结果
  - ← doubled_list
  + → summary: text  # 例："collected=2"
  > 收齐后消费步骤：拿到部分列表照常干活（部分结果可否接受由本步裁量——这里选择接受）
  > ```hop_python
  > summary = "collected=" + str(count(doubled_list))
  > ```
