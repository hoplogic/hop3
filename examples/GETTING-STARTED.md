# 入门演示（随 npm 包分发）

按顺序跑三个，每个演示一层能力：

| 顺序 | spec | 演示什么 |
|---|---|---|
| ① | `coffee-week.md` | **第一次跑用它**——咖啡店周报：纯内置函数计算（引擎全程确定性消化，跑一万次数字一样）+ 一个 reason 步（LLM 只做该做的判断）+ check 核验。演示数据 `coffee-sales.json` 同目录备好，零决策首跑 |
| ② | `data-quality.md` | 数据质检修复：体验 **tool_request**——body 里的工具（count_nulls 等）库内无实现，引擎逐个发给 LLM 语义执行。⚠️ 数值随执行 LLM 会有差异，这是特性演示不是回归基线 |
| ③ | `doc-review.md` | 人机介入点——执行到 `[ask]` 引擎必停问你（多角度文档评审，含并行） |

在 Claude Code 里：`/hopspec run examples/coffee-week.md`（装了包后任意目录可跑——驱动会相对包根解析）。

> 全量 22+ 个 spec 范本在项目仓库 `examples/`（多为引擎自测范本，未随包发布）。
