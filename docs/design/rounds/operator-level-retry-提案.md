# 设计方案：输出 schema 校验 + 算子级重试（定稿，含 author 决策）

> 状态：**author 决策已收齐，待落地确认**。本稿不直接改 design/，过目后再落入概念层 + exec-engine.md / step-dispatcher.md / shared-types.md。
> 起因：审计 E（SCHEMA_MISMATCH 缺失）→ 拆分锚点 → 发现本质是"LLM 输出不匹配→立即重试" → 牵出 act 概念矛盾与双模式一致性。

---

## ★ act 概念定稿（本轮最核心产出，author 拍板）

**act = 无推理、无循环的计算和工具调用逻辑**

- **身份：无推理**。execute 期不做判断/分析（那是 reason 的职责）。这是 104 行 `^anc-step-act`「不需要 LLM 推理」的真意——指**执行期无推理**，不是说 act 与 LLM 无关。
- **body = 无推理编排**：「纯计算 + 工具调用 + 无推理分支」的编排。
  - 纯计算：表达式
  - 工具调用：`local = provider_tool(args)`
  - **无推理分支**：`if 确定性条件 { 动作块 } else { 动作块 }`——条件须确定性可求值（变量比较/存在性/真值），**不得让 LLM 判断走哪支**
  - **禁止循环**：for/while 不进 body，升 HopSpec `loop`（要 max_iterations 保护、迭代历史、变量作用域）
  - 数据流：从 act 的 `←` 输入取，局部变量顺序传递，写 act 的 `+→` 输出
  - **act body 分支 vs HopSpec branch**：影响"本步输出值怎么算"→ act body 分支（值层面分流，无可被后继引用的中间产出）；影响"执行哪一串业务动作"→ 升 HopSpec branch（业务路径，case 产出进上下文、可见可追溯）
- **生成期 vs 执行期**（消解 104/38 矛盾的关键）：
  - 生成期：body 由 LLM 在规划 / adaptive 重规划时产出（act 内容是 LLM 生成的）
  - 执行期：**严格照 body 执行，不得擅自改变**（独立=引擎按序执行；复用=CC 按序执行）
- **可被 TS / Python 表达且不违"环境无关"**：因 body 无循环、分支条件确定性，TS/Python 在「计算+调用+确定性分支」上几乎同形，宿主用哪种语言执行都能照做。环境无关性由"无循环 + 确定性条件"保证，而非禁止具体语法。

**act / commit 同源（统一定义）**：commit 的 body 与 act 完全同构——同样是「无推理、无循环的计算 + 工具调用逻辑」，复用本节全部 body 定义。**唯一区别**：act 副作用可逆/可安全重试；commit 有不可逆副作用、不可重试，且 ⚠️ **推荐幂等操作**（重复执行结果一致，防崩溃重放导致重复副作用）。下游差异（commit 不可进 retry、授权由前序 confirm 建立）均由"不可逆"这一条派生。

**三层职责划分（复杂度永远在 HopSpec 层可见，不沉进黑盒）：**

| 层 | 管什么 | 形式 |
|---|---|---|
| HopSpec 步骤层 | **控制流**（业务路径分支/循环/重试） | branch / loop / subtask |
| act / commit body | **无推理编排**（计算+调用+无推理分支） | 无循环、确定性条件 |
| ToolProvider | **只碰外部世界**（薄执行器，不含业务逻辑） | execute(tool, args) |

> ⚠️ 纠偏记录：曾误写"复杂逻辑外包给 ToolProvider"——错。tool 只是执行工具/API 的薄接口，复杂逻辑必须在 HopSpec 层用步骤结构展现（概念 19 行：业务逻辑结构化、可见、可编排），不得塞进 tool 变回硬编码黑盒。

**对 act 当前实现的影响**：`executeActWithTools`（dispatcher.ts）现在是 LLM 多轮 tool-use 循环——把 act 做成了"执行期推理的小 agent"，违背"执行期无推理"。应重构为"按 body 顺序执行"。**影响大，本轮标 v1 偏差、另立任务**。

**对 schema 重试的影响**：act body 执行期无 LLM 推理 → 独立模式 act 本身不产生"LLM 输出不匹配"；schema 重试主要落在 reason/check（LLM 产出）和复用模式（CC 产出）。但 act body 改造本身是更大的工程，本轮不做。

---

## 〇、author 已拍板的决策（本稿据此固化）

1. **act 概念定性**：见上方「act 概念定稿」。104 行权威；38 行「LLM 只能调工具」是复用模式执行策略的不严谨表述 → **修正 38 行**。
2. **双模式纲领（贯穿全设计）**：**需要分模式，但语法语义应尽量一致**。模式差异藏在执行机制层，**不泄漏到 Spec 语法 / 引擎契约 / 校验语义层**。
3. **schema 校验落点**：**统一在引擎 `completeStep`**（两模式必经的回写口），同一套 type 校验规则。
4. **重试机制**：**分模式**——独立=引擎内重调；复用=`done` 返回 SCHEMA_MISMATCH 由 CC 重试。
5. **重试次数**：缺省 **3 次**，耗尽 → failStep（触发所在容器的容器级 retry）。
6. **反馈提示**：重试时必须把"哪个字段 / 声明什么类型 / 实际给了什么 / 为何不匹配"讲清楚——否则重试无意义。
7. **校验严格度**：沿用 exec-engine.md:325 已声明的 v1 策略（内置类型查值、自定义 TypeDecl 仅查字段名存在性）。

---

## 一、概念层：act 身份澄清 + 算子级重试

### 1a. act 身份（修正概念矛盾）

- **104 行不动**（权威）：act = 不需要 LLM 推理的确定性动作。
- **38 行重述**（去掉"act 自带 LLM"的误读）。建议改为：
  > act 步骤执行确定性动作，只能调用宿主预注册的受控工具、无任意代码执行——安全由工具接口保障。**执行体随模式而定**：独立模式由引擎按执行说明直接调用工具（无 LLM 推理）；复用模式由 caller（如 CC）用自身工具执行。无论哪种模式，act 不做自由推理，其语法与输出契约一致。
- **连带**：独立模式 `executeActWithTools` 的 LLM tool-use 循环与 104 行矛盾（把 act 做成了小 agent）→ **标记为待重构（v1 偏差）**，本轮不动代码，另立任务。

### 1b. 输出 schema 校验是双模式一致的语义【新概念点】

每个算子步骤（reason/check/act）的 `+→` 声明即输出契约。**产出回写时按声明校验类型**，不匹配 → 重做该算子。这是**模式无关的语义**（`^anc-exec-mode-invariants` 的新增条目候选），与 confirm 暂停点一致、沙箱语义一致并列。

### 1c. 算子级重试 vs 容器级重试（边界，防止与 subtask retry 混指）

| | 容器级 retry（subtask/case） | 算子级 retry（reason/check/act 产出不达标） |
|---|---|---|
| 粒度 | 整个 children 子树 | 单个步骤的一次产出 |
| 触发 | children fail / check finally 不过 | 产出不匹配 schema（或 lack_of_info / context overflow） |
| 动作 | 重跑 children（adaptive 可改子步骤） | 重做**同一步**（不改步骤结构） |
| 次数 | `retry=N`（缺省 3，可配） | 固定缺省 3（不引入新语法） |
| 耗尽 | 容器 fail → 上报 caller | 步骤 failStep → **触发所在容器的容器级 retry** |
| 与 adaptive | adaptive 是容器级的事 | **算子级不触发 adaptive** |

算子级重试已有先例：`lack_of_info`、`CONTEXT_OVERFLOW`。SCHEMA_MISMATCH 是第三个。三者同属"算子级重试"类（概念立锚 `^anc-exec-operator-retry` 候选）。

---

## 二、设计层：校验统一、重试分模式

### 2a. 校验逻辑（统一，引擎层）

- 位置：`engine.completeStep(stepId, outputs)` 内，写 vars 之前。
- 规则（复用 validator 的 `isValidTypeWithDecls` + `BUILTIN_TYPES`，v1 策略）：
  - 取该步 `+→` 的 `OutputDecl[]`，逐字段校验 `outputs` 的值：
    - 内置类型（bool/number/int/float/enum/[line]…）→ 值类型检查
    - 自定义 TypeDecl → 仅字段名存在性（Record.keys 子集）
  - 任一字段不匹配 → 不写 vars、不标 done，返回 `{ status:'error', code:SCHEMA_MISMATCH, message: <逐字段不匹配详情> }`
- message 必须含：字段名 + 声明类型 + 实际值（截断）+ 不匹配原因。（决策⑥）

### 2b. 重试机制（分模式）

- **独立模式**（dispatcher 在）：dispatcher 调 `completeStep` 收到 SCHEMA_MISMATCH → 把 message 作为反馈拼进 prompt → 重做该算子（reason/check：重调 LLM；act 见 1a 注）→ 缺省 3 次 → 耗尽 `failStep`。
- **复用模式**（无 dispatcher）：`hopjit done` 直接返回 SCHEMA_MISMATCH（含 message）→ CC 读到后自行修正重新 `done`（步骤仍 running，无需重走 next）→ CC 侧自己计次，引擎不强制次数（引擎够不到 CC 的重试循环）。
  - 注：复用模式"缺省 3 次"是**对 CC 的契约建议**（写进 message/文档），非引擎强制——符合"复用模式信任 caller"（`^anc-exec-mode-invariants` 第4条沙箱同理）。

### 2c. 锚点归置（落实"拆分锚点"）

- `^anc-cli-idempotency`（shared-types.md）：**已删** SCHEMA_MISMATCH 第三条，只留 ALREADY_DONE/ALREADY_FAILED 两条真幂等。✅ 本轮已落地。
- SCHEMA_MISMATCH 新归属：exec-engine.md complete_step 段，立 `^anc-exec-output-schema-check`（校验契约）。
- 算子级重试：step-dispatcher.md 立 `^anc-exec-operator-retry`（机制，注明分模式）。

---

## 三、落地链（概念→设计→代码→测试）

| 层 | 改动 | 锚点 |
|---|---|---|
| 概念 | 38 行重述；可加"输出校验"模式不变量条目；act 重构标 v1 偏差 | `^anc-step-act` 语境 / `^anc-exec-mode-invariants` |
| 设计 exec-engine | complete_step 段补 schema 校验契约 + SCHEMA_MISMATCH | `^anc-exec-output-schema-check` |
| 设计 step-dispatcher | 算子级重试骨架（分模式，缺省3，反馈构造） | `^anc-exec-operator-retry` |
| 代码 engine.ts | completeStep 加校验，不匹配返回 SCHEMA_MISMATCH | `@a: anc-exec-output-schema-check` |
| 代码 dispatcher.ts | 独立模式收到 SCHEMA_MISMATCH → 反馈重做（缺省3） | `@a: anc-exec-operator-retry` |
| 代码 validator.ts | 抽出/复用 isValidTypeWithDecls 供 engine 调用（value 级校验） | — |
| 测试 | 校验：各内置类型匹配/不匹配；重试：独立模式重做成功/耗尽fail触发容器retry；复用模式 done 返回 SCHEMA_MISMATCH | `@v:` 对应 |

**注**：独立模式 act 的 LLM 循环重构（1a）**不在本轮**，另立任务，本轮标 v1 偏差。本轮范围 = schema 校验（统一）+ reason/check 的算子级重试 + 复用模式 done 打回 + 锚点归置。

---

## 四、范围确认（本轮做 vs 另立任务）

- ✅ 本轮：completeStep schema 校验（双模式统一）；SCHEMA_MISMATCH 返回；独立模式 reason/check 算子级重试（缺省3+反馈）；复用模式 done 打回契约；概念 38 行重述；锚点归置（output-schema-check / operator-retry）；补测试。
- ⏭ 另立任务：独立模式 act 去 LLM 循环、改纯工具执行（act 概念重构）——影响大，单独走完整链。本轮在概念层标 v1 偏差。
