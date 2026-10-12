%% @trace
	id: hopjit-shared-errors
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-10-08T23:22+0800
	note: shared-errors 模块设计——ErrorCode 错误码 + SpecError/ParseError/ValidationError 错误类型契约。2026-07-02 从 shared-types.md 抽出(被 parser/validator/engine/cli 多方调,应独立模块独立文档)。
%%

# shared-errors 模块设计

> **模块版本**：shared-errors `v0.7.2`（2026-10-08 COMMIT_NOT_APPROVED 说明改为 body 指纹——commit 批准改为安全分析后指纹只覆盖 body,[[exec-engine#^anc-exec-commit-approval]]）。上版 v0.7.1（2026-10-08 发版前八项修复批工程链 review 修复：OUTPUT_ABORTED 行改按步级瞬态说明;机检条款的括注改说真分界——"登不登本表",不是"抛出形态是前缀字符串还是枚举"（OUTPUT_ABORTED 既以前缀字符串抛出又登表入枚举,旧括注与 v0.6.1 句自相矛盾）;v0.6.1 句里"前缀字符串形态不入枚举"删除）。上版 v0.7.0（2026-10-08 todo/0129：枚举补 ADVANCE_ORDER_VIOLATION（B10）与 OUTPUT_ABORTED,本表补 DIRS_NOT_APPROVED 行,表与枚举集合一致改机检——新锚 ^anc-error-code-table-sync,tests/errors.test.ts 专属）。上版 v0.6.2（2026-10-08。本版=COMMIT_NOT_APPROVED 的说明从 body 哈希改为内容指纹（commit 批准改为自动研判优先）。上版 v0.6.1（2026-10-08）=错误码表加 OUTPUT_ABORTED 行（端点非正常停止,todo/0121）。上版 v0.6.0（2026-10-07）=ErrorCode 加 COMMIT_NOT_APPROVED 与 COMMIT_BODY_ENGINE_ONLY（todo/0146,commit 批准闸）。0.x 未承诺稳定；错误类型是 parser/validator/engine/cli 多方共用契约，破坏性变更须概念层决策）。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。

错误码枚举 + 错误类型契约（`errors.ts`）。被 parser/validator（产出 ParseError/ValidationError）、engine/dispatcher/cli（消费 ErrorCode 程序化决策）多方依赖。

## 关键决策【决策】

**ErrorCode 三分类（致命 / 可重试 / 幂等）**：错误码按 agent 的程序化处置方式分三类——致命（不可重试，停止执行）、可重试（退避后重试）、幂等命中（非真正错误，继续）。这让 agent 无需逐码硬编码判断逻辑，按分类即可决策。分类边界是人为拍板：如 `STEP_TIMEOUT` 归致命（不重试单步）但可触发上层 subtask retry，`TOOL_TIMEOUT` 归可重试。

---

## 错误类型【契约】 ^anc-error-types

**shared-errors 对外接口清单【封闭】** ^anc-error-error-code-exports：

> shared-errors 模块（`errors.ts`）= 错误码 + 错误类型契约。出口文件 = `errors.ts`。表外即内部。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `ErrorCode` | 枚举 | errors.ts | 错误码枚举（engine/dispatcher/cli 消费） | stable |
| `SpecError` | 类型 | errors.ts | 错误联合类型（parser/validator 产出） | stable |
| `ParseError` | 类型 | errors.ts | 解析错误（parser 产出） | stable |
| `ValidationError` | 类型 | errors.ts | 校验错误（validator 产出，engine 消费） | stable |
| `ValidationSeverity` | 类型 | errors.ts | error/warn/info 严重度（validator/engine 消费；info=提示性冗余/优化，2026-08-07 随 V9 翻转新增，engine/cli 均不阻塞） | stable |

### ErrorCode ^anc-error-error-code

枚举值（三组：致命/可重试/幂等命中）：

| 错误码 | 组 | 说明 |
|---|---|---|
| `INVALID_STEP_ID` | 致命错误（不可重试） |  |
| `INVALID_STATE` | 致命错误（不可重试） | 步骤不在预期状态 |
| `SCHEMA_MISMATCH` | 致命错误（不可重试） | output 类型不匹配 |
| `DEPTH_EXCEEDED` | 致命错误（不可重试） | call 深度超限 |
| `CYCLE_DETECTED` | 致命错误（不可重试） | call 环路检测 |
| `AUTH_FAILURE` | 致命错误（不可重试） | API 密钥无效或过期 |
| `CONTEXT_OVERFLOW` | 致命错误（不可重试） | prompt 超出模型上下文窗口 |
| `OUTPUT_ABORTED` | 步级瞬态（API 层不重试,步骤级 retry 首撞免扣） | 端点以非正常原因停止输出（stop_reason 既非正常收尾也非 max_tokens——refusal / content_filter 等）,半截产出不收;以 `OUTPUT_ABORTED:` 前缀字符串抛出,引擎按步级瞬态清单处理（下轮带"换措辞"反馈重跑,复发照扣预算）——权威 [[step-dispatcher#^anc-exec-output-abort-loud]] 与 [[exec-engine#^anc-exec-deterministic-no-retry]] 口袋归类表（todo/0121;档次 2026-10-08 review 修复改定） |
| `MISSING_INPUT` | 致命错误（不可重试） | 【废弃保留】None 闸已删（2026-08-09 fail 即异常定稿）——枚举值保留防旧状态文件反序列化断裂，引擎不再发出 |
| `MAX_TOOL_ITERATIONS` | 致命错误（不可重试） | act 步骤 tool_use 超过迭代上限 |
| `BUDGET_EXCEEDED` | 致命错误（不可重试） | 全局 token 预算耗尽 |
| `COMMIT_REQUIRED` | 致命错误（不可重试） | act 步骤调用了 requires_commit=true 的工具 |
| `ADVANCE_ORDER_VIOLATION` | 致命错误（不可重试） | commit 执行入口动态核发现前序步骤未终态（独立模式,failure_reason 前缀码;复用模式同判定折 WAITING_WRITEBACK 拒不 finalize——权威 [[exec-engine#^anc-exec-advance-order-invariant]],2026-09-06 review 补登） |
| `REPLAN_LIMIT_EXCEEDED` | 致命错误（不可重试） | subtask adaptive replan 超过 max_replan_attempts 上限 |
| `REPLAN_DUPLICATE` | 致命错误（不可重试） | replan 新计划与前次高度重复（Jaccard 相似度检测） |
| `STEP_TIMEOUT` | 致命错误（不可重试） | 单步执行超时（ResourceLimits.timeout_seconds），不可重试但可触发 subtask retry |
| `CORRUPT_STATE_FILE` | 致命错误（不可重试） | 状态文件损坏/版本不符（join 读子实例时校验）——语义收纯（2026-09-01）：实例目录在而文件缺/坏才是它,目录整个不存在归 INSTANCE_NOT_FOUND |
| `INSTANCE_NOT_FOUND` | 致命错误（不可重试） | 显式 --instance 的实例目录在 state_dir 下不存在（典型=实例号手抄错——报文列真实存在的实例号指路,契约 [[hop-cli#^anc-cli-instance-resolve]]） |
| `STATE_STALE` | 致命错误（不可重试） | 写 state.json 前回读发现盘上写入序号比本进程内存里的大——同一实例目录已被另一个进程推进过,本进程的账过时,拒绝覆盖（以 `STATE_STALE:` 前缀字符串抛出;MCP resume_run/stop_run 预检命中返回结构化错误 code=STATE_STALE）。不可重试:重试同一份过时的账只会再被拒,正路是丢弃本进程的账从盘上重新加载。权威 [[exec-engine#^anc-exec-state-seq-guard]] |
| `COMMIT_NOT_APPROVED` | 致命错误（不可重试） | commit 批准关卡拒收：approve_commit 传入的 body 指纹与当前不一致（body 已变,报文给出当前指纹）,或独立模式 resume_run 续跑一个尚未批准的 commit 转人工停点。不可重试:同样的请求再发一次结果相同,正路是按报文拿当前指纹、按人的选择重新批准。权威 [[exec-engine#^anc-exec-commit-approval]] |
| `DIRS_NOT_APPROVED` | 致命错误（不可重试） | Config.dirs 清单批准关卡拒收：approve_dirs 传入的清单哈希与当前清单不一致（声明或 Inputs 变了,报文给出当前哈希）。不可重试:正路是按报文拿当前哈希重新批准。权威 [[exec-engine#^anc-exec-dirs-grant]]（枚举 2026-10-07 todo/0148 已加,本表 2026-10-08 todo/0129 补登） |
| `COMMIT_BODY_ENGINE_ONLY` | 致命错误（不可重试） | driver 试图用 submit 递交一个带 body 的 commit 步骤的产出。这类步骤只能由引擎执行 body 得到产出,递交被拒——否则递交产出就能绕过 commit 批准闸。权威 [[exec-engine#^anc-exec-commit-approval]] |
| `PARSE_ERROR` | 可重试错误 | replan markdown 解析失败 |
| `VALIDATION_ERROR` | 可重试错误 | replan 验证失败 |
| `IO_ERROR` | 可重试错误 | 文件系统错误（含 iCloud EPERM） |
| `RATE_LIMITED` | 可重试错误 | API 429 限流，可退避重试 |
| `API_TIMEOUT` | 可重试错误 | API 请求超时，可退避重试 |
| `API_NETWORK_ERROR` | 可重试错误 | 网络层错误（DNS/TCP/TLS），可退避重试 |
| `API_SERVER_ERROR` | 可重试错误 | 服务端错误（5xx/529），可退避重试 |
| `TOOL_TIMEOUT` | 可重试错误 | 工具执行超时（ToolProvider.execute 挂死），可退避重试 |
| `TOOL_EXEC_ERROR` | 可重试错误 | 工具运行时错误（工具执行非零退出、调用方报错等），可重试 |
| `ALREADY_DONE` | 幂等命中（非真正错误） |  |
| `ALREADY_FAILED` | 幂等命中（非真正错误） |  |

（TS 形态是代码层投影，在 src/errors.ts `enum ErrorCode`——设计以本表为准，代码与本表集合必须一致。**一致性由机检守**（2026-10-08 todo/0129 A 组落 a 案：tests/errors.test.ts 读本表第一列与枚举逐员比对,两边任一多出即红点名——2026-09-06 本表加 ADVANCE_ORDER_VIOLATION 枚举漏加、2026-10-07 枚举加 DIRS_NOT_APPROVED 本表漏登,两向各漏过一次,语义审计 ❌ 才抓到;分界是**登不登本表**,不是抛出形态：OUTPUT_TRUNCATED / THINKING_EXHAUSTED / ENDPOINT_UNREACHABLE 等只以前缀字符串抛出、没登本表也没入枚举,不受本核;OUTPUT_ABORTED 同样以前缀字符串抛出,但登了表入了枚举,就受本核）） ^anc-error-code-table-sync

Agent 根据 `code` 程序化决策：致命 → 停止，可重试 → 重试，幂等 → 继续。

### SpecError ^anc-error-spec-error

SpecError = ParseError | ValidationError（二选一联合）。

```
HopType: ParseError
  Id: parse-error
  Fields:
    - kind % line     # 恒为 'parse'
    - line % number   # markdown 行号定位
    - message % line  # 错误说明

HopType: ValidationError
  Id: validation-error
  Fields:
    - kind % line      # 恒为 'validate'
    - rule % line      # 验证规则 ID（S1-S12/C1-C7/V1-V7/P1-P9，共 35 条），必填
    - severity % line  # 枚举 error/warn/info——error 阻塞级、warn 建议级、info 提示性
    - step_id % line   # 可选。违规步骤
    - line % number    # 可选。行号
    - message % line   # 违规说明
```

（TS 形态是代码层投影，在 src/errors.ts——设计以本 HopType 为准。）
