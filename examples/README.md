# HopJIT 示例 Spec

> **npm 包内用户注意**：包内随发入门件（coffee-week / data-quality / doc-review / fact-check-demo / fact-check-sample / 两份演示数据 / GETTING-STARTED.md），下表其余范本在项目仓库。首跑看 [GETTING-STARTED](./GETTING-STARTED.md)。

本目录是 HopJIT 的可执行示例集，每个 `.md` 是一份 HopSpec V3 规约，各自示范一个执行特性。示例同时是**新概念的正确范本**——尤其 act 步骤遵循「无推理、无循环的计算和工具调用逻辑」（推理归 `reason`，控制流归 HopSpec 步骤结构）。

## 目录分类（2026-08-09 重排）

**根目录 = 有真实业务意义的完整范本**（能当活教材读、也能真跑出有用产物）；**syntax/ = 纯语法示例**（各示范一个语言特性，业务是道具）；**e2e-* = 测试基线**（e2e 专用，勿当学习材料）。

### 业务范本（根目录）

| 文件 | 业务 | 示范面 |
|------|------|--------|
| `coffee-week.md` + `coffee-sales.json` | 咖啡店周报 | e2e 主场景同款；hop_python 纯计算 + reason 判断 + subtask 核验 |
| `data-quality.md` + `demo-data.json` | 数据质量修复 | 入门四件之一（随 npm 包）；subtask + check final + adaptive |
| `doc-review.md` | 文档评审 | 入门四件之一（随 npm 包） |
| `hop-fact-check.md` + `fact-check-sample.md` | 事实核查完整版（sample=示范输入，埋了待抓的推理跳跃） | for-each 并行 + collect 子句 + branch 两路分流 + 行号分析物溯源 + 补搜纪律 + 双自查回路（两类缺失验收） |
| `hop-fact-check.qwen3.8-27b.md` | 上行的模型变体（目标 profile=qwen3.8-27b,check_judge: closed-questions-only——头部注记含源母本/降档动作;母本改动后须重新生成） | check 步微判定展开范本：开放式验收拆成"机械分组 act → 逐行封闭小题 loop → 机械汇总 check final"（弱模型判官只答原子 yes/no,门槛与汇总归程序——判官摇摆无处发生） |
| `fact-check-demo.md` | 事实核查演示版（--demo 附装为 `demo-fact-check`；随 npm 包） | 完整版的适度简化：只核一级事实（可直接查证的断言），无推演审查/自查回路 |
| `hop-deep-research/`（spec + sample） | 主题深度研究（sample=模糊问题，触发 scope gate）。hop- 前缀区隔 Claude Code 内置同名 workflow /deep-research | scope gate 澄清分流 + 子问题外延检查 + 双语 fan-out 检索 + 本地材料对照（local_materials）+ 对抗式验证（独立二源/换语言圈/enum 四态）+ 机械完备性核对 + 对照评估节 + ask/commit 落盘交付 |
| `contract-review/`（3 spec + 各自 params） | 合同评审：路由 + NDA triage + DPA review | call 编排（标题映射路由）+ 确定性 triage（hop_python 读 playbook 阈值零 LLM）+ 注入隔离（untrusted 正文只进 reason）+ destination/signing gate |
| `mutation-verify/`（spec + sample params） | 变异核证：worktree 隔离逐点位改坏代码验证测试真能变红（no_pin=行为面无测试锁定的缺口产出） | subprocess.run 白名单命令行（git/npx/ln 全走 act body 引擎直执零 Bash）+ worktree 建弃 act 可逆物理兑现 + loop for-each 四拍记录 + 说明与 body 一致条款示范 |
| `standard-decompose-codify/`（spec + sample） | 标准拆解与代码化：把标准/规范文档拆成条款清单，逐条判可码性（可码/需人裁/纯散文），可码的生成可执行校验并跑通验证，不可码如实留人，交付条款→产物映射表（覆盖率可核） | 3 档可码性判定（唯一正确答案/语义审计/行为纪律）+ loop for-each 逐条 + subtask retry 可逆试错（跑不通降档不硬码）+ check final 如实记录核 + confirm 闸整体一次验收 + commit 幂等写盘 |
| `hopbuild.md` + `hopspec-v3-syntax.md` | 自然语言 skill → HopSpec 翻译器 | doc-ref 知识外置（陪伴文档模式）：spec 留编排骨架，V3 判据沉入知识文档 |
| `webpage-extract.md` | 网页内容提取（配 hoptools-playwright） | 外部工具模块经 tool_servers 注册进 act body 直调（浏览器自动化最小闭环） |
| `websearch-brief.md` | 检索简报（配 hoptools-websearch） | websearch 工具检索 + reason 汇总的最小闭环 |

### 纯语法示例（syntax/）

| 文件 | 示范特性 | 要点 |
|------|---------|------|
| `syntax/code-review.md` | 线性 reason/act | 最简范本：act 取 diff → reason 分析 → act 组装报告 |
| `syntax/act-body.md` | act 结构化 body（hop_python） | 报销单核算：金额账引擎算零 LLM——赋值 + 内置函数 + 无推理 if 分支 |
| `syntax/confirm-commit.md` | 探索提交分离（confirm/commit） | reason 方案 → confirm 人审 → commit 不可逆（幂等设计） |
| `syntax/adaptive-replan.md` | subtask retry + adaptive | check final 不过 → adaptive 重规划 children |
| `syntax/parallel-aggregate.md` | parallel 并行 + 聚合 | 三维度打包一个并行活 → 聚合 → check 验证 |
| `syntax/sibling-parallel.md` | 兄弟并发 | 两个独立 subtask 各标 parallel，父容器边界收齐（教程 05 写法二的可跑样例） |
| `syntax/loop-branch.md` | loop + branch + break/continue | reason 判级 → branch 分流；fatal→break、clean→continue |
| `syntax/call-parent-summarize.md` + `call-child-normalize.md` | call 子 spec 调用 | 双向冒号映射，子实例状态隔离 |

### 工具注册样例（.yaml——不是 HopSpec 规约,是 tool_servers 注册配置）

| 文件 | 注册什么 | 配套 |
|------|---------|------|
| `hoptools-websearch.yaml` | websearch 检索工具（bailian 后端） | `websearch-brief.md` 消费;教程 D7 引用 |
| `hoptools-playwright.yaml` | playwright 浏览器自动化工具 | `webpage-extract.md` 消费;教程 D7 引用 |
| `hoptools-bailian.yaml` | bailian 模型服务工具 | 教程 D7 引用 |
| `ext-tools/word-stats.mjs` | 外部工具脚本样例（in-process 扩展模块的实现件） | 上列 yaml 的 module 指向形态参考 |

### 测试探针（复现特定行为的测试 spec,非学习材料）

| 文件 | 探什么 |
|------|--------|
| `probe_caller.md` + `probe_callee.md` | call 边界行为探针（父子实例参数与输出映射） |
| `probe-mindmaps.md` | 思维导图场景探针 |

### 测试基线（e2e 专用，勿改）

| 目录 | 用途 |
|------|------|
| `e2e-failure/` | 失败路径六场景的确定性失败触发 spec（并入 test:live:core；见 design carrier-live-e2e） |
| `e2e-audit-fixture/` | 复杂流程 e2e 的**被审小工程**（alpha/beta 两模块，埋确定性锚点缺陷供审计召回断言）。被测的审计工具本体在 `scripts/audit/`（活工具直用） |
| `e2e-parallel-smoke.md` | 并行冒烟测试 spec（统一模型渐进派发的最小验证件） |

> 已迁出：`anchor-audit.md` → `scripts/audit/`（审计工具链是工程基础设施非演示样例，2026-08-08）。

## 运行方式

### 完整执行（独立模式，需 LLM API）

```bash
# 设置 API（任一）
export ANTHROPIC_AUTH_TOKEN=...   # 或 ANTHROPIC_API_KEY

# 跑单个 spec（带 debug 日志，状态写 .hopstate/、日志写 .hoplog/）
npx tsx examples/run-e2e.ts examples/syntax/code-review.md --params '{"target_dir":"."}'
```

### 复用模式（CC 驱动，零额外 LLM 费用）

由 CC 通过 `/hopspec run` Skill 驱动 `hopjit` CLI（run 启动 → submit_and_fetch_next 应答循环，节奏归引擎），CC 自身作为推理智能与工具执行体。call 示例需复用模式：CC 读父 spec 的 call 步骤后，`hopjit init <子spec> --parent ...` 建子实例并驱动子循环。

## act 范本约定

所有示例的 act 步骤 body 都明示「无推理」性质，作为正确范本：
- **纯计算**：统计、格式化、数组操作（如 data-quality 步骤 1 的 Z-score 统计）
- **工具调用**：git diff、文件操作（如 code-review 步骤 1）
- **按既定策略机械执行**：决策已在前置 reason 完成（如 data-quality 步骤 3.1 按 fix_strategy 执行）

凡需要分析判断的，一律用 `reason`；凡需要分支循环的，用 HopSpec 步骤结构（branch/loop），不写进 act body。
