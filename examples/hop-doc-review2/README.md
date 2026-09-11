# hop-doc-review2 — 多角度文档评审（完整版）

对建设方案/规划/技术评论类文档做多角度专家评审：从文档特征推导评审视角 → 设计审查员角色 → 并行子实例评审 → 交叉验证汇聚 → 优先问题清单逐条对焦 → 定向修改。

## 与 examples/doc-review.md（入门版）的关系

同一场景的两个档位，**并存不替换**：

- `doc-review.md`（111 行）：入门示意件——5 个顶层步展示"视角设计→并行评审→汇聚→对焦"骨架，审查员是本实例内的 reason 步，评审完不留沉淀；
- `hop-doc-review2/`（本件，799 行 + 子 spec）：全功能生产件——hopbuild2 从 doc-review NL skill（76KB）翻译构建，经十七轮真机验证修缮，2026-09-01 首次全程走通后收编。

## 本件比入门版多什么

1. **领域库沉淀**（`DocReviewers/`）：领域判定优先精确匹配已有目录；审查员模板落盘可跨文档复用（版本兼容判定 + 直接复用/微调/从零设计三态决策）；README 记领域高频脆弱点，首轮评审后回填；DocTree.md 全库索引；
2. **审查员独立子实例**（`reviewer-worker.md`，[call ... parallel] 派发）：每个审查员独立上下文互不污染，内部 check final 三核达标（有引文/有独立发现/有量化判断，不达标打回重写），报告 commit 写盘；
3. **真人把关面**：领域归属/定位类型/风险点清单逐项勾选/评审模式四停点全部 require_human；manual 模式下 P0/P1 逐条 a-b-c 对焦裁决，修改先记对焦决策记录（去敏感化）经确认再动文档；
4. **行业对标检索**：`## Tools` 段显性声明 web_search，风险点清单逐条标注来源 URL 与权威度评估；
5. **收尾事务**：轮次目录归档、README 高频脆弱点回填、DocTree 对账修正。

## 运行

```
/hopspec run examples/hop-doc-review2/hop-doc-review2.md --params '{"doc_path": "<待评审文档路径>"}'
```

- 待评审文档放 workspace 目录下,doc_path 传相对路径；超过 30,000 字会被门禁要求分拆；
- 聊天记录、短笔记等非成文文档会被适用性门禁拒绝（设计内行为）；
- standalone（MCP）模式运行时须配置具备 web_search 的模型服务；四个确认停点须真人应答。

## 文件

- `hop-doc-review2.md` — 主 spec（37 个顶层步，mixed 档:含 act free 未尽原子，复用模式与 standalone 均可跑）
- `reviewer-worker.md` — 审查员子 spec（审查员与汇聚分析员共用；call 同目录寻址，勿改名）
