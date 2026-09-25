---
id: sql-filter
lang: sql
level: 简单
---

# sql-filter — 单表按条件筛选排序（SQL · 简单）

> 发给模型的是下面「题目正文」一节的原文，加上「表结构」一节代码块里的建表语句；跑批脚本 `../run-code-generation.mjs` 再给它套上固定外框，并在末尾附上 `public/` 下的公开样例。这段说明不发给模型。

## 表结构

```sql
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount INTEGER, status TEXT, created_at TEXT);
```

## 题目正文

created_at 存的是 'YYYY-MM-DD HH:MM:SS' 格式的文本(带时分秒)。
取数需求:列出 2026 年 3 月的已支付大额订单。
规则细节:
- 已支付 = status 恰好等于 'paid'(大小写与空格都要完全一致,'PAID'、'paid ' 不算);
- 大额 = amount 大于等于 100;amount 为 NULL 的订单不算;
- 2026 年 3 月 = created_at 从 '2026-03-01 00:00:00' 到 '2026-03-31 23:59:59'(两端都包含),3 月 31 日当天全天都算;
- 结果列按顺序是:id, customer_id, amount;
- 按 amount 从大到小排,amount 相同的按 id 从大到小排(新订单在前);没有符合条件的订单时返回空结果。
