---
id: sql-join
lang: sql
level: 普通
---

# sql-join — 左连接 + 分组聚合（SQL · 普通）

> 发给模型的是下面「题目正文」一节的原文，加上「表结构」一节代码块里的建表语句；跑批脚本 `../run-code-generation.mjs` 再给它套上固定外框，并在末尾附上 `public/` 下的公开样例。这段说明不发给模型。

## 表结构

```sql
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, region TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount INTEGER, status TEXT, created_at TEXT);
```

## 题目正文

取数需求:按地区汇总客户数与已支付订单情况。
规则细节:
- 每个在 customers 表里出现过的地区(region)输出一行;没有任何已支付订单的地区也要输出;
- 结果列按顺序是:region, customer_count, paid_order_count, paid_amount;
- customer_count = 该地区 customers 表里的客户个数(不管这些客户有没有订单、有几单);
- paid_order_count = 该地区客户的已支付订单(status 恰好等于 'paid')的单数;amount 为 NULL 的已支付订单也计入单数;
- paid_amount = 这些已支付订单的 amount 之和,NULL 金额按 0 计;没有已支付订单的地区,paid_order_count 与 paid_amount 都输出 0(不是 NULL);
- orders 里 customer_id 在 customers 表中找不到的订单不计入任何地区;
- 按 paid_amount 从大到小排,相同的按 region 字母顺序从小到大排。
