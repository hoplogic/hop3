---
id: sql-streak
lang: sql
level: 复杂
---

# sql-streak — 每个用户的最长连续登录段（SQL · 复杂）

> 发给模型的是下面「题目正文」一节的原文，加上「表结构」一节代码块里的建表语句；跑批脚本 `../run-code-generation.mjs` 再给它套上固定外框，并在末尾附上 `public/` 下的公开样例。这段说明不发给模型。

## 表结构

```sql
CREATE TABLE logins (user_id INTEGER, login_date TEXT);
```

## 题目正文

login_date 存的是 'YYYY-MM-DD' 格式的文本;同一个用户同一天可能有多条登录记录;表里的行没有任何顺序保证。
取数需求:找出最长连续登录天数达到 3 天的用户。
规则细节:
- 连续登录 = 按日历日相邻的日子都有登录(跨月、跨年、闰年 2 月 29 日都照日历算,如 2025-12-31 与 2026-01-01 相邻);
  同一天多条登录只算一天;
- 每个用户算出他的最长一段连续登录的天数 longest_streak,以及这一段的第一天 streak_start;
  同一用户有多段一样长的最长段时,streak_start 取其中最早的那一段的第一天;
- 只输出 longest_streak 大于等于 3 的用户;
- 结果列按顺序是:user_id, longest_streak, streak_start;
- 按 longest_streak 从大到小排,相同的按 user_id 从小到大排。
