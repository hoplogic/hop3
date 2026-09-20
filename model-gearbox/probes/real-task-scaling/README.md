# real-task-scaling — 真实任务复杂度阶梯（层四标准工作卷的尺寸化）

作者定 2026-09-19：合成语料的提取阶梯（extract-scaling）量的是裸提取覆盖力，真实任务的复杂度还叠着检索、交叉验证、多步协调——**用真实任务 × 真实尺寸阶梯来度量任务复杂度**。三条阶梯，每条用同一份 spec（仓库原件）跑不同尺寸的真实材料，记各档完成质量的坍塌点。

## 阶梯一 + 二：新闻稿 × fact-check / deep-research

语料在 `news/`，四档真实新闻（原文抓取零改写，出处与抓取日在文件头）：

| 档 | 文件 | 字符数 | 内容 |
|---|---|---|---|
| S | s-suiyuan-ipo.md | ~0.7K | 燧原科技上市短讯（单事件，事实点少而密） |
| M | m-huawei-connect.md | ~1.9K | 华为全联接大会报道（单事件多指标，数字密集） |
| L | l-semi-trillion.md | ~5.1K | 半导体行业趋势分析（多论点，事实+推演混排） |
| XL | xl-dram-deep.md | ~28.4K | DRAM 技术深度长文（技术论证链长，推演点多层依赖） |

跑法（spec 恒从仓库原件现拷进工作区）：

- **fact-check 卷**：`examples/hop-fact-check.md`（强模型）/ `examples/hop-fact-check.qwen3.8-27b.md`（弱模型档，同功能面）。document_path 指向语料档；
- **deep-research 卷**：`examples/hop-deep-research/hop-deep-research.md`，语料作 local_materials 传入，research_question 按语料主题拟（如"燧原科技上市的关键财务事实核查"）——考"本地材料 + 网络二源交叉"的全链。

观测量（按维度归因入档案，不记总分）：

- **G2 面**：提取完备率随档位的衰减（S 档漏点是能力问题，XL 档漏点看漏在哪——尾部截断是窗口问题、中部漏是覆盖力问题）；首轮 SCHEMA/完备性打回次数；
- **G1 面**：推演点判定质量随档位变化（XL 档的长推理链上 leap/invalid 判得准不准——对照人工抽查）；
- **G4 面**：检索轮数与命中质量（fan-out 是否随子问题数合理增长、有没有空转）；
- **止损纪律**：单档单模型烧尽 100 万 tokens 即止损记"该档不可用"，不无限烧。

## 阶梯三：skill 尺寸 × deep-validate

deep-validate 判官卷用真实的不同大小 spec 当被审对象（全部仓库原件，audit 时效跟随仓库现状）：

| 档 | 被审 spec | 字符数 |
|---|---|---|
| S | examples/coffee-week.md | ~2.8K |
| M | examples/doc-review.md | ~5.7K |
| L | examples/contract-review/dpa-review.md | ~20K |
| XL | examples/hop-fact-check.md | ~30K |
| XXL | examples/hop-doc-review2/hop-doc-review2.md | ~78K |

跑法：`scripts/deep-validate/deep-validate.md`，params={spec_path: 被审件, exec_mode: standalone}。观测量：报告风险条目的**查准**（抽查条目真伪——编造坑位一票否决，Ling 前科）、**查全**（对照强模型基线报告的检出差集）、做功量（tokens）随档位的斜率、XXL 档是否撞上下文墙。

## 判分与记档纪律

- 与探针族同源四条：每档 n≥（预算许可的最大值，至少 1，横比结论至少 n=3）；实测与推断分标；模型身份取响应体；spec 恒从仓库原件现拷；
- 真实任务卷没有合成答案键——判分靠三样：机械面（完备率对语料要点清单、SCHEMA 计数、tokens 账）+ 强模型基线对照（deepseek 同档产物当参照系）+ 人工抽查（推演判定与风险条目真伪）。要点清单首次人工建，之后复用；
- 结果入 `runs/` 子目录（run-<service>-<卷>-<档>-<日期>/），档案只收归因后的维度结论。
