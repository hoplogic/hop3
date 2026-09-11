# hopskill 构建 · 全链装配单（~25k）

> 专职构建 agent 的完整知识注入清单。按序读，总量约 25k token。轻量场景改用 `primer-1k.md`（指针卡）或 `primer-8k.md`（自包含）。

| # | 材料 | 角色 | 约 token |
|---|---|---|---|
| 1 | `SKILL.md`（跳过 %% @trace 块） | 作业协议：流程 §0-§5、宪法级三焦点、自校验四门、Bash 纪律 | ~4k |
| 2 | `references/three-focus-rules.md` | 三焦点权威判据：识别信号/生成模板/反例 | ~5k |
| 3 | `references/step-type-cheatsheet.md` | 13 类型详表 + NL→step 选型映射 + 选型注意 | ~2k |
| 4 | `references/spec-skeleton.md` | 骨架/语法/变量语义/高频验证规则/知识外置 doc-ref | ~4k |
| 5 | `scripts/audit/anchor-audit.md` + 其 knowledge 文档 | golden sample：全步骤类型+知识外置的真实范本 | ~8k |
| 6 | `scripts/audit/test-coverage-audit.md` 与其自然语言原文对照 | 翻译前后对照样本（选读） | ~4k |

**读序原则**：1 给流程框架 → 2-4 给判据 → 5-6 给案例锚定。执行时按 SKILL.md 协议走，判据文件在对应环节（§1 选型查 3、§2 三关查 2、§3 生成查 4）按需重查，不必常驻窗口。

**注意**：SKILL.md 的 `%% @trace %%` 块是演进史记录（~2k token），对构建零贡献，注入时剔除。
