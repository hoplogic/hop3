# 测试覆盖率审计判据知识

> `examples/test-coverage-audit.md` 的陪伴知识文档：大段判据/分类标准/评估维度外置于此，spec 各步 `>` 用 doc-ref `[[test-coverage-audit-knowledge#章节]]` 引用，引擎运行期自动切片注入。spec 只留编排骨架，判据沉于此。示范 hopbuild 的「知识抽取与 doc-ref」模式。

## 覆盖缺口严重度分类

对一个低覆盖文件的每个未覆盖区域，按下列标准分类并**按严重度排序**（非按覆盖率百分比）：

- **CRITICAL**：错误处理、安全检查、数据校验、核心业务逻辑——未测意味着最危险的路径无保护。
- **IMPORTANT**：非平凡分支、状态转换、边界条件——正常逻辑的重要变体。
- **LOW**：日志、toString、简单 getter、类型守卫——低风险样板代码。

判断视角：独立测试覆盖率审计员，对项目无背景知识、无开发者偏好，纯代码质量角度。对每个未覆盖区域读源码与对应测试文件后再定级，不凭覆盖率数字臆断。

## mock FLAG 判据

对每个 mock，按下列规则判定应否 FLAG：

**应 FLAG（问题 mock）**：
- mock 内部模块（target 是 `./` 或 `../`）——内部行为该用集成测试覆盖真实实现。
- mock 纯函数（无副作用无 I/O）——应直接用真实实现测。
- mock 代码行数 > 被替代代码行数——mock 本身成了维护负担。
- 模块级 `vi.mock`/`jest.mock` 遮蔽所有测试的真实行为——应缩小 mock 作用域。
- mock 被测对象自身（mock 正在测的类/模块的方法）——测的是 mock 不是代码。

**不应 FLAG（合理 mock）**：
- mock 外部 API/服务（SDK、HTTP client、数据库）——避免真实网络/外部调用。
- mock 文件系统操作——单元测试合理隔离。
- mock 定时器/日期——确定性测试的标准做法。

对每个 flagged mock 须解释：什么被 mock 了、为何有问题、更好的测试方式是什么、隐藏了多少真实行为。

## 测试架构评估维度

评估整体测试质量，覆盖四个维度：
- **测试金字塔比例**：单元 / 集成 / e2e 测试的数量与比例是否健康。
- **复杂度对齐**：高复杂度文件是否有对应的充分测试。
- **测行为 vs 测实现**：测试断言的是外部行为契约，还是内部实现细节（后者脆弱）。
- **命名对应**：测试文件命名/结构是否跟源文件结构对应。

## 审计报告格式模板

结构化报告 `audit_report.yaml` 章节：`coverage_summary`（total_files / files_below_80_line / files_below_70_branch / overall_line_pct / overall_branch_pct）、`critical_gaps`（逐文件 line_pct/branch_pct + uncovered_critical[] + uncovered_important[]）、`mock_audit`（total_mocks / flagged / flags[] / acceptable[]）、`test_architecture`（unit_count / integration_count / e2e_count / assessment）、`overall_verdict`（GOOD/ADEQUATE/NEEDS_IMPROVEMENT/POOR）、`priority_actions`（P0/P1 行动项）。

自然语言摘要 `audit_summary.md` 章节：Overall Verdict + 2-3 句总结、Key Findings（Coverage Gaps N critical/M important、Mock Quality N flagged/M total、Test Architecture 评估段）、Priority Actions 编号列表。
