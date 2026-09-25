%% @trace
	id: hopjit-deep-validate
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-09-01T15:42+0800
	note: deep-validate 跑前深检设计——validate 的深化档（2026-09-01 作者两拍立项：缘起 anchor-audit spec standalone 化十跑九坑）。载体=hopskill spec（scripts/deep-validate/），判据台账=知识文档活资产。
%%

# deep-validate 跑前深检（validate 深化档）

> **模块版本**：deep-validate `v0.1.0`（2026-09-01）。首版：三层分工定位 + 能力契约（fast 三硬约束/不阻断）+ 备料→推理→齐格三步 HopSop + 判据台账初版五面。0.x 未承诺稳定。**逐版演进史归 git log**（本行只记现行版本，升版只改号，演进论证归 commit message）。

## 文档结构与内容分级

本文档内容分三级，审计要求不同：

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【决策】** | 人拍板的关键选择 | 改动需作者确认 |
| **【契约】** | 带 `^anc-*` 锚点的技术约定 | 代码/测试必须对齐，anchor-audit 全量审查 |
| **【说明】** | 示例、辅助理解 | 与契约一致即可，无独立锚点 |

| 章节 | 分级 | 锚点 |
|------|------|------|
| 定位与三层分工 | 决策+契约 | `anc-meta-deep-validate-position` |
| 能力契约 | 契约 | `anc-meta-deep-validate-contract` |
| 关键逻辑（备料→推理→齐格） | 契约 | `anc-meta-deep-validate-sop` |
| 判据台账管理 | 契约 | `anc-meta-deep-validate-ledger` |
| 作者拍板与否决案 | 决策 | — |
| 静态半边归属指针 | 说明 | — |

## 为什么要这个工具【决策】

缘起：anchor-audit spec 做 standalone 化时连跑十趟、撞出九个坑（详见任务卡与 git log 9cd982eb/27c78b33），作者问"怎么这么多问题""validate都没用么"。

九坑归类后发现一半的坑**静态文法根本判不了**——它们的病理是"步骤说明文字教的动作 × 目标执行环境的真实能力面"对不上：说明教 standalone 判官"用 test -s 判文件"（判官没有文件工具）、说明教 LLM 亲手转写 395 条锚点清单（必烧穿 max_tokens）、body 里的命令依赖环境里没有的库。这些都要**理解说明的语义、对照执行环境的能力面**才能判——是推理活，不是文法活。

作者拍板（2026-09-01，两拍逐字）：

1. "validate该补的补，确定性检查不能做的，应该有推理工具来辅助检查，不能等跑趟雷"
2. "preflight不对，deep validate倒是对的，但要fast"（第二拍同时正名与定约束——工具叫 deep-validate，是 validate 的深化档，且必须快）

## 定位与三层分工【决策+契约】 ^anc-meta-deep-validate-position

deep-validate 是 **validate 的深化档**：validate 管静态文法（51+ 条规则，机械可判），deep-validate 管"静态判不了的运行期假设"（说明语义 × 执行环境对照）。它**不是审计**——不是 anchor-audit 那种几十分钟逐锚点量级的活。三层分工：

| 层 | 管什么 | 判定手段 | 量级 | 载体 |
|---|---|---|---|---|
| **validate** | 静态文法——从 spec 文本+规则就能判的（结构/控制流/变量/body 形态） | 确定性规则（validator.ts） | 秒级 | `hopjit validate` / validate_spec 内置工具 |
| **deep-validate** | 运行期假设快检——要理解说明语义、对照执行环境能力面才能判的 | LLM 推理（判据台账约束判定面） | 分钟级 | `scripts/deep-validate/` hopskill spec |
| **anchor-audit** | 逐锚点全量语义审计——概念→设计→代码→测试五层链忠实性 | LLM 分批读源 | 几十分钟 | `scripts/audit/` hopskill spec |

**产物性质：建议性风险报告，不阻断**——deep-validate 不设强制闸，报告呈人，采不采纳归人（作者未拍强制闸；validate 的 error 拦执行照旧，两层不混）。

## 能力契约【契约】 ^anc-meta-deep-validate-contract

```
# Spec: 跑前深检
Id: deep-validate
Goal: 对一份 HopSpec 做跑前运行期假设检查——把每个步骤说明教的动作与
  目标执行模式的真实能力面对照,产出建议性风险报告
Inputs:
- spec_path: line     # 被审 spec 文件路径（workspace 相对）
- exec_mode: enum(standalone, driver)  # 目标执行模式
Outputs:
- risk_report: markdown  # 风险清单（每条:坑位/病理/修法建议/严重度;五面逐面表态）
Constraints:
- fast 硬约束一:LLM 调用次数恒定,不随被审 spec 规模增长——单 reason 步
  一次过全部判据面,不分批不分模块（分批是审计的形态,不是快检的）
- fast 硬约束二:输入控量三件=被审 spec 全文+validate 机械体检单+环境事实
  （项目 hopjit.yaml+知识文档里的能力面教材）,零源码翻查——判定所需的
  引擎能力面事实预先沉在知识文档里作教材,不许运行期去翻引擎源码
- fast 硬约束三:整体分钟级时延
- 不阻断:产出建议性风险报告,不设强制闸
```

**环境事实的供给方式**（硬约束二的实现细节）：

- 执行模式工具面与写域规则**写死在知识文档里作为教材**（`scripts/deep-validate/deep-validate-knowledge.md` 环境事实教材节——standalone 十件工具清单照 DefaultToolProvider 形态抄、写域规则条款照 [[tools/file-tools#^anc-exec-write-scope]] 抄）；
- 命令白名单是项目级事实，经备料步 read 项目 `hopjit.yaml` 取（文件可缺席，缺席=零白名单如实入料）；
- 教材是**快照**，引擎工具面演进后须刷新（刷新义务见判据台账管理节）。

## 关键逻辑（HopSop）【契约】 ^anc-meta-deep-validate-sop

```
# 备料 → 推理 → 齐格 三步（spec 本体 scripts/deep-validate/deep-validate.md）
1. [act] 机械备料（body 引擎直执零 LLM）:
   read 被审 spec 全文 + validate_spec 内置工具出机械体检单 +
   exists 探测后 read 项目 hopjit.yaml（缺席=空串）
2. [subtask retry] 推理检查与齐格（检查与齐格同事务——齐格打回时
   带缺口反馈重跑推理步,定向补而非重来）
   2.1 [reason] 单步过全部判据面:doc-ref 注入判据台账五面+环境事实教材,
       逐面审毕表态,产出风险清单 markdown（每条=坑位/病理/修法建议/严重度）
   2.2 [check final] 报告齐格:五面各有表态（不许静默跳面）+每条建议
       可执行（指到具体改法,不是"注意一下"）
3. [exit] 交付风险报告
```

结构借 hopbuild2 合理关骨架（skills/hopbuild2/spec.md 5.1.3.1.4-5.1.3.1.6 实战验证的三件）：**机械体检单前置**（机械可判的先跑完，warning 是白送的缺陷线索喂给推理步逐条表态）+ **审毕清单制**（逐面表态不许静默跳过——治"判官视野逐轮下钻，每轮自称列全实际只列当轮视野内的"实撞病）+ **缺陷分级**（严重度随条目走，报告可按级取舍）。

## 判据台账管理【契约】 ^anc-meta-deep-validate-ledger

判据台账（`scripts/deep-validate/deep-validate-knowledge.md`）是**活资产**——与 anchor-audit-knowledge 台账同款演进纪律：

- **初版五面**（每面带实撞例——撞例就是判据的证据，全部取自 anchor-audit standalone 化十跑）：①执行模式能力面矛盾 ②确定性步骤形态 ③体量模式 ④环境依赖 ⑤写域与路径；
- **撞新坑补条款**：真机跑出新的"validate 全绿但运行期死"形态 → 归入既有面或立新面，条款必带实撞例（无实撞例的推测性判据不入台账——判据面涨噪声比漏判更伤：误报驱动作者改写合法 spec）；
- **章节标题是 doc-ref 锚点**：spec 按 `[[deep-validate-knowledge#章节名]]` 切片注入，改标题会断引用——新增判据优先在既有面内补，不轻易增删/重命名章节；
- **教材刷新义务**：环境事实教材节是引擎能力面的快照（工具清单/写域规则/白名单机制），引擎侧对应契约（[[tools/file-tools#^anc-exec-builtin-file-tools]] / [[tools/file-tools#^anc-exec-write-scope]] / [[act-body#^anc-exec-subprocess-run]] / [[step-dispatcher#^anc-exec-reason-tools]]）变更时须同批刷新教材——教材过时=判据面对着幻影环境判，产出误导性报告。

## 作者拍板与否决案【决策】

**载体选型三案**（2026-09-01 主对话步骤 2 上报，作者拍 B）：

- **A 案 CLI 子命令内嵌 LLM**（`hopjit deep-validate` 内部调 LLM）——**否决**。cli.ts 现状零 LLM 依赖（dispatcher 仅被 mcp-server import，validate 命令纯静态），内嵌 LLM 破坏这条分层线；且判据面长在代码字符串里，演进要改码发版；
- **B 案 hopskill spec**（scripts/deep-validate/ 下 spec+知识文档）——**采纳**。三条理由：判据台账要文档形态演进（撞坑补条款不动代码）+ 零引擎改动 + 吃自己狗粮（deep-validate 本身就是 HopSpec 跑在 HopJIT 上）；
- **C 案 validate --deep 档**（validator 加深检档位）——**否决**。validator 是引擎核心层纯静态组件（51+ 条规则的确定性是稳定契约），混入 LLM 判定破坏其"同一份 markdown 解析结果确定且可重复"的定位。

**命名**：作者原话"preflight不对，deep validate倒是对的，但要fast"——preflight 一名废弃，正名 deep-validate。

## 静态半边归属指针【说明】

九坑归类的静态可判半边**不在本模块**，随本批落在各自权威处（本节只留指针）：

- **B10 body 读侧字面绝对路径静态检**——归 [[spec-parser#^anc-rule-b10]]（B9 写域检的读侧同形姊妹条）；
- **顶层 run 必填 Inputs init 闸**——归 [[exec-engine#^anc-exec-call-auto-map]]（call 子实例必填闸的孪生半边，同节追加条款）。
