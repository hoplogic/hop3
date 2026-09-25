%% @trace
	id: hopjit-shared-types
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-07-02T15:21+0800
	note: 跨模块共享类型层——不属任一单一模块的公共类型：大内容阈值卸载协议（deflate）、值类型系统与执行辅助结构（辅助类型）、命令幂等契约。2026-07-02 拆分：CLI 响应类型→hop-cli，Provider 三件套+Config→shared-providers，ErrorCode/SpecError→shared-errors，DocRef→spec-ast。本文件退化为纯跨模块共享层（类比 sandbox.md 只承载跨模块契约）。
%%

# 共享类型定义

> **模块版本**：shared-types `v0.3.0`（2026-09-24——RetryRecord 加可选位置戳 event_seq、ExecEvent 加 loop_iter 事件,todo/0107 重试反馈按轮生效）。v0.2.0（2026-09-01——幂等契约 ALREADY_DONE 回执即终点条款,hopissues/0056）。v0.1.0（2026-08-11）——立版（此前无版本行）：值类型/OutputDecl/StepSummary/RetryRecord/ExecEvent 表达从 TS 块转 HopType（语义零变化，与 ast-types/runtime-types 逐字段核对一致）。

跨多个组件引用、**不专属任一模块**的公共类型，集中定义避免散落。各组件文件仅保留该组件独有的类型，共享类型统一引用本文件。

> **2026-07-02 拆分归位**：本文档原是装 4 模块的 god 文档。按"被多方调→独立模块独立文档"判据拆出——
> - **CLI 响应类型**（Init/Next/Command/Vars/Status/Replan/Branch）→ [[hop-cli#^anc-cli-response-types]]（CLI 命令的对外 JSON 契约，属 hop-cli 模块）
> - **Provider 三件套 + Config/Sandbox 类型** → [[shared-providers]]（引擎内核↔宿主契约边界，`provider-types.ts`）
> - **ErrorCode + SpecError/ParseError/ValidationError** → [[shared-errors]]（`errors.ts`，被 parser/validator/engine/cli 多方调）
> - **DocRef / DocRefFragment** → [[spec-ast#^anc-type-doc-ref]]（doc-ref 的 AST 契约类型，`ast-types.ts`）
>
> 本文件保留的是**真正跨模块、无单一归属**的公共类型：大内容阈值卸载协议、值类型系统与执行辅助结构、命令幂等契约。

## 文档结构与内容分级

本文档内容分三级，审计要求不同：

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【决策】** | 人拍板的关键选择 | 改动需作者确认 |
| **【契约】** | 带 `^anc-*` 锚点的技术约定 | 代码/测试必须对齐，anchor-audit 全量审查 |
| **【说明】** | 示例、格式演示、辅助理解 | 与契约一致即可，无独立锚点 |

| 章节 | 分级 | 锚点 |
|------|------|------|
| 大内容阈值传递与 work_zone 工作区 | 契约 | `anc-exec-deflate` |
| 辅助类型 | 契约 | `anc-type-auxiliary`（组标题）/ `anc-type-system` / `anc-type-value-types` / `anc-type-output-decl` |
| 幂等性保证 | 契约 | `anc-cli-idempotency` |

---

## 大内容阈值传递与 work_zone 工作区【契约】 ^anc-exec-deflate

**受众分流原则**（概念上游 [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-audience-routing]]）：引擎对外传值面对三类受众，单一阈值无法兼顾，按出口类型走不同通道。 ^anc-exec-audience-routing

**消费端能力前提（2026-08-14 BUG-H 补定,实撞后显式化）**：agent 通道的 `$file` 指针语义隐含前提=**消费端有文件工具**（复用模式 driver=Claude 会 Read）。**standalone 的 reason/check/act-LLM 是裸 API 调用（deepseek/qwen 无文件工具），指针=死引用——LLM 面对读不了的指针会就地编造**（实撞:48KB 真材料被换成指针,input_tokens 仅 583,deepseek 编造假分片跑完全程 1 条幻觉落盘真库）。

- 故 **LLM-facing 注入面在 standalone 下一律内联真值**：StepDispatcher 构造时对引擎声明 `setInlineLlmContext(true)`,三个注入面（L4 inputs/L2 doc-ref/hop_env 表）在该标志下不产 $file 指针——中小值真值内联;
  - 超 INLINE_PREVIEW_MAX（20000 chars）的大值,对下发面含 read 工具的步骤转诚实预览条目（值位真内容截头+明示全文落盘路径,v2 2026-08-25 宽松限额）;没有 read 的步骤全量内联（v3 2026-09-23 todo/0115——节选的指路语对读不了文件的步骤是死路）;权威 [[step-dispatcher#^anc-exec-llm-inline-context]]——"LLM 见到的值位必是真内容（全文或明示的节选）"跨模式不变量;
- deflate 保留为复用模式的传输优化;两次静默漂移教训（MemoryPersistence workzone 从空串实化+BUG-F 补 vars/ 目录,各自合理却联手打开本缺口）=跨模式机制的模式假设必须写成显式条款。哨兵信号:input_tokens 远小于输入量级。

**阈值常量**：
- `DEFLATE_THRESHOLD = 4096`（4KB）—— **agent 通道**单值阈：超阈写文件传 `$file` 指针（前提见上——消费端有文件工具）。**指针形状契约**：agent 通道指针**恰为单键对象 `{$file: abs_path}`**（生产侧 `resolveInputs`/`deflateValues` 只产此形状）；确定性消费方（act-body 解释器）按"恰单键且值为字符串"精确匹配解引用——用户数据对象即便含 `$file` 键、只要还有其他键即不视为指针（收窄误判面；人通道 `{$file, preview}` 复合结构不进确定性消费路径）。
- `HUMAN_PREVIEW_THRESHOLD = 5000`（5K 字符）—— **人通道**预览阈：超阈返 `{$file, preview}` 复合结构（preview 是头 5000 字符 + "...[完整内容见文件]"），driver 完整 dump preview 给 user 看，附带文件路径让 user 知道完整在哪。

**两类格式**：

| 格式 | 用途 | 形态 |
|---|---|---|
| `$file` 指针（agent） | LLM 看到指针决定要不要 Read | `{"$file": "/abs/path/work_zone/vars/<name>.json"}` |
| `preview + $file`（人） | user 立即可读 + 完整可达 | `{"$file": "/abs/path/...", "preview": "头 5K 内容...[完整内容见文件]"}` |

文件内容统一是该变量的完整 JSON 值（直接 `JSON.parse` 得原始值，不再套层）。

**⚠️ 多 child 命名空间隔离**（`parallel_ready.children[].params_for_child` 专属）：for-each 动态展开的 N 个 child **共享同一父实例 work_zone/vars/**，且它们的 `params_for_child` **共享同一变量名**（如 for-each itemVar `batch`）。

- 若 deflate 文件名只按变量名（`vars/<name>.json`），多个超阈 child 会写同一路径互相覆盖、后写覆先写——child 的 `$file` 指针张冠李戴（实证 bug：13 模块审计中 exec-engine 批被 spec-parser 批覆盖）。故 **params_for_child 的 deflate 路径必须按 child_step_id 命名空间隔离**：`vars/<child_step_id>/<name>.json`（child_step_id 唯一，天然无碰撞）；
- **tool_request args 同族第二员**（2026-09-04 0040 批兑现卸载承诺时同律引入——同一步骤内 body 可多次调工具,参数名跨调用可重名〔两次 write 都叫 content〕,只按参数名必互踩）：namespace=`tool_<step_id>_<seq>`,路径 `vars/tool_<step_id>_<seq>/<参数名>.json`；
- 其余通道（outputs/inputs/context）单实例内变量名唯一，仍用 `vars/<name>.json`。

**⚠️ 进程内 call 边界不是 agent 通道——消费前必须解引用（2026-08-24 D59,dr13 实撞）**：`completed.outputs` 的 deflate 面向 agent 受众（driver/caller 是 LLM,看到指针可决定 Read）;但独立模式**进程内 call 递归**的父层 `settleCallOutcome` 直接消费子 RunResult.outputs——父层是确定性代码不是 LLM,指针对象一旦经 `completeCallStep` 写进父变量空间,会顺着 collect 数组流进下游机械 body。

- 实撞形态:子 run 的 fragment 输出 4630 字节超阈变 `{$file}` 指针,漂进父 collect 的 child_fragments 数组,机械拼装步喂 edit_spec_tree 拒"需要非空 fragment",纯机械步 4 攻同败子实例烧死——毒形态与围栏包裹同族,但源头是引擎自动 deflate,spec 作者无感知无从防御;
- 修复双层：**边界侧**——settleCallOutcome 消费子 outputs 前逐值递归解引用（inflate,进程内传值恒真值）;**解释器侧纵深**——act-body 的 `derefFilePointer` 从"顶层值精确匹配"升级为**递归下钻**（数组逐元素、对象逐字段;形状契约不变:恰单键 `{$file: string}` 才解引用,人通道 `{$file, preview}` 双键天然豁免）——"解释器必须拿到真值"的承诺覆盖嵌套位。

**$preview 预览对象同须解引用（2026-08-26,dr18 第 3 攻实撞）**：BUG-H v2 的 inline 预览通道（^anc-exec-llm-inline-context）把超 INLINE_PREVIEW_MAX 的字符串输入换成 `{$preview, full_chars, full_file?}` 三键对象——受众是裸 API LLM（值位真内容节选）,但 BodyInterpreter 消费同一份 context.inputs,不识别该形态即把整个对象喂工具。

- 实撞形态:fragment 31834 字符成预览对象,机械 body 调 validate_spec(text:fragment) 报"text 参数必须是字符串",确定性错误重试必死,split-node 2.1 耗尽 → 5.1#3 耗尽 7.3 小时白烧。

- 形状契约:恰含 `$preview`(string)+`full_chars`(number) 两键、可选 `full_file`(string) → 指针,读 full_file JSON.parse 取全文真值;
- full_file **存在但非 string** 的对象不匹配形状——原样保留走普通对象递归分支,不误抛"缺 full_file"（二审抓权威段比从属文档 act-body 缺此分支）;
- `full_file` 缺席（无 workZone 场景）**响亮抛错不静默用节选**——节选替真值=静默截断,毒性等同旧 [TRUNCATED];
- 撞脸风险接受论证:用户真数据恰为该形状的概率与 `{$file}` 单键同档;两键无 full_file 的撞脸命中响亮抛（比 $file 撞脸读 ENOENT 同级且更早暴露）,可接受。

**影响出口与所属受众**：
- `step_ready.context.inputs`：**agent** 通道（LLM 看），用 DEFLATE_THRESHOLD + `$file` 指针格式
- `step_ready.context.doc_ref_context`：**agent** 通道（LLM 看），doc-ref 大章节用 DEFLATE_THRESHOLD + `$file` 指针格式（见 [[prompt-assembler#^anc-exec-doc-ref-injection]]）
- `parallel_ready.children[].params_for_child`：**agent** 通道（worker LLM 看），同上
- `completed.outputs` / `failed.partial_outputs`：**agent** 通道（driver/caller 看），同上
- `tool_request.args`：**agent** 通道（caller 执行工具时看），DEFLATE_THRESHOLD + `$file` 指针格式,namespace 按 tool_<step_id>_<seq> 隔离（2026-09-04 0040 批入清单——此前实现越出清单,面一 review 实抓契约冲突后补行）
- `paused.presented_data.context`（confirm/ask）：**人** 通道（user 看），用 HUMAN_PREVIEW_THRESHOLD + `preview+$file` 格式

**work_zone 工作区**（见 [[exec-engine#^anc-exec-work-zone]]）：**vars/ 与 work_zone 同生命周期**（deflate 写点在 vars/ 下,分离创建=ENOENT 窗口,BUG-F 实撞）——FilePersistence 在 `init` 时于实例目录下创建 `work_zone/` 和 `work_zone/vars/`。

- MemoryPersistence（仅存于宿主自身无 instanceDir 的场景——测试/程序内嵌入;原括注"独立模式,含 call parallel 子实例"系 2026-08-29 翻案前旧口径,standalone call/parallel 子实例已改落盘随父,现行权威见 [[persistence]] 存在场景条款——2026-09-12 0088 批清两文矛盾）无实例目录,`getWorkZone` 首调 tmpdir 惰性自建时**同建 vars/**（两实现对称,persistence v0.2.2）;
- 所有 `NextResponse` 携带 `work_zone`（绝对路径），driver/worker 写临时文件统一用此目录（不污染项目目录、不依赖 cwd）。

**变更记录（已修正）**：早期 PromptAssembler 对 step inputs 一刀截断到 2000 字符加 `[TRUNCATED]` 标记，违反受众分流（user 看截断版无法决策、agent 看含损值无法基于真值推理）。已替换为本节"按受众阈值卸载到 work_zone"。此为历史沿革（非待办债）。

---

## 辅助类型【契约】 ^anc-type-auxiliary

本节定义 HopSpec 的值类型系统与执行辅助结构 ^anc-type-system

ValueTypeString 定义值类型枚举（text, bool, line 等），供变量和输出声明使用 ^anc-type-value-types

OutputDecl 定义步骤输出变量的名称、类型和描述 ^anc-type-output-decl

**ValueTypeString（值类型字符串，VarDecl.type / OutputDecl.type 共用）**——合法取值枚举：

| 取值 | 说明 |
|---|---|
| `text` / `bool` / `line` | 基础标量 |
| `number` / `int` / `float` | 数值（int/float v1 校验统一当 number 处理） |
| `markdown` / `yaml` / `prompt` | 结构化文本 |
| `HopSpec` | 领域特化类型（基础类型 markdown） |
| `[<元素类型>]` | 通用列表，如 `[line]`、`[ChatMessage]` |
| `(<成员类型串>)` | 元组，如 `(int, text)` |
| `enum(<取值串>)` | 枚举 |

```
struct: OutputDecl
  Id: output-decl
  Fields:
    - name: line         # 输出变量名
    - type: line         # ValueTypeString 或自定义 TypeDecl 名；复合 YAML 展开声明头记 'yaml'
    - description: line  # `#` 注释
    - default: yaml      # 可选。`+ → x: type = 初值` 的初值（parser 解析）——容器节点=init 一次、叶子=每次执行重置。见 [[exec-engine#^anc-exec-output-init]]
    - fields: [yaml]     # 可选。复合类型 YAML 展开的字段说明（每项 name/type/description）——仅供人读与 L6 输出约束渲染，不注册为独立变量（见 [[spec-parser]] 复合输出解析）

struct: StepSummary
  Id: step-summary
  Fields:
    - step_id: line
    - step_type: line    # 全部 15 种 StepType（见 [[spec-ast]]），非仅 ExecutableStepType
    - summary: line
    - outputs: [line]    # 变量名列表

struct: RetryRecord
  Id: retry-record
  Fields:
    - attempt: number
    - failure_reason: line
    - steps_tried: [StepSummary]
    - event_seq: number   # 可选（v0.3.0,todo/0107）。记账那一刻执行事件流的长度（位置戳）;L2c 注入只取位置在容器本轮起点（祖先 loop 最晚一条轮进事件）之后的记录,缺席按本轮处理（旧状态文件）。权威 [[exec-engine#^anc-exec-retry-feedback-iter-scope]]

struct: ExecEvent
  Id: exec-event
  Fields:
    - at: line       # ISO 8601 时刻
    - step_id: line  # 触发事件的步骤 ID
    - event: line    # step_start | step_done | step_failed | retry | replan | branch_select | loop_iter 等（loop_iter:loop 轮次被设定时记,step_id=loop id,detail=新轮次号;detail 为 '1' 是入口,其余是轮进,只有轮进划本轮起点——v0.3.0,todo/0107）
    - detail: line   # 可选。失败原因、选择理由等
```

ExecEvent 是 Engine 执行事件流条目（执行历史原料，供 L3 上下文重建；持久化到 state.json 的 exec_events，跨进程续上 loop 迭代时序与子步状态。与 HopLog 分工见 exec-engine「执行历史进 state.json」）。

（TS 形态是代码层投影，在 src/ast-types.ts（ValueTypeString/OutputDecl/StepSummary）与 src/runtime-types.ts（RetryRecord/ExecEvent）——设计以本 HopType 为准。）

> `OutputDecl`/`StepSummary`/`RetryRecord`/`ExecEvent` 被 hop-cli 响应类型（[[hop-cli#^anc-cli-next-response]]）、shared-providers 的 EngineSnapshot（[[shared-providers#^anc-provider-persistence-iface]]）等多模块引用，是典型跨模块辅助类型，故留本文件。

---

## 幂等性保证【契约】 ^anc-cli-idempotency

- `hopjit done` 对已完成步骤：
  - **不带 outputs、或 outputs 与已存值（归一后）相同**时返回 `{ status: 'ok', code: 'ALREADY_DONE' }`，不重复写入——真幂等重发安全照旧，**且回执即终点不再推进**（completeAndAdvance 撞 ALREADY_DONE 直接返回结构化成功报文〔含"引擎在等步 Y"指引〕，不调 advanceToCaller——hopissues/0056 作者拍 B 案：幂等重发零状态变化，推进无从谈起；原借道 WAITING_WRITEBACK 的 failed 壳回执自相矛盾且会被 driver 按终态误伤）;
  - **带不同内容**时返回 `{ status: 'error', code: 'INVALID_STATE' }`（STALE_RESUBMIT 拒收——那不是重发,是打在错误步号上的新内容,静默吞会毁账,分流细则见 [[exec-engine#^anc-exec-stale-resubmit]]，hopissues/0049）
- `hopjit fail` 对已失败步骤：返回 `{ status: 'ok', code: 'ALREADY_FAILED' }`，不重复处理

> 幂等只管「重复命令」的安全（按步骤状态判定，让 CC 崩溃/超时后可安全重发）。输出值是否匹配 `output_schema` 是**输出校验**（按输出内容判定），属不同关注点——见 [[exec-engine#impl complete_step]] 的 `SCHEMA_MISMATCH`，不在本锚点范围。
