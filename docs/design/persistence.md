%% @trace
	id: hopjit-persistence
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-07-02T11:43+0800
	note: persistence 模块设计——FilePersistence/MemoryPersistence 状态快照落盘/恢复(PersistenceProvider 契约的实现层)。2026-07-02 从 shared-types.md 抽出独立成文。
%%

# persistence 模块设计

shared-providers 的 `PersistenceProvider` 契约（见 [[shared-providers#^anc-provider-persistence]]）的**实现层**——`FilePersistence`（复用模式，快照 ↔ `.hopstate/` 文件）/ `MemoryPersistence`（独立模式，进程内快照）+ 状态文件读取。被 exec-engine（注入 persistence）、hop-cli（查询/恢复）依赖。

## persistence 模块定位【契约】 ^anc-provider-persistence

> **模块版本**：persistence 模块（`persistence.ts`：FilePersistence/MemoryPersistence + readState/readVars/writeAtomic） `v0.3.0`（2026-08-20）。0.x 未承诺稳定。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。
>
> **vars.json format_version=2（2026-07-04）**：vars.json 从扁平变量字典（v1）升级为**完整 scope 树**（v2，结构与迁移见 [[exec-engine#^anc-exec-vars-scope-persist]]）——修复扁平序列化下兄弟 scope 同名变量跨进程互覆盖的静默数据损坏。`readVars`/`fromJSON` 按 `format_version` 分支兼容旧 v1（扁平塞 root）。scope 树的序列化/重建逻辑在 `ast-runtime.ts` VariableStore.toJSON/fromJSON，persistence 层只透传读写。

**对外接口清单【封闭】** ^anc-provider-persistence-exports：

> 出口文件 = `persistence.ts`。表外即内部。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。`PersistenceProvider` 接口类型本身归 shared-providers（见 [[shared-providers#^anc-provider-persistence]]），本模块是其实现。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `FilePersistence` | 类 | persistence.ts | 文件快照实现（engine 复用模式默认） | stable |
| `MemoryPersistence` | 类 | persistence.ts | 内存快照实现（engine 独立模式默认） | stable |
| `readState` | 函数 | persistence.ts | 读 state.json（cli 查询/恢复） | stable |
| `readVars` | 函数 | persistence.ts | 读 vars.json（cli 查询） | stable |
| `stateExists` | 函数 | persistence.ts | 判实例状态是否存在（cli 定位实例） | stable |
| `flattenVars` | 函数 | persistence.ts | VarsFile（v1 扁平 / v2 scope 树）摊平为 name→value 字典，供按名读取的 cli 场景（call 回填、for-each 列表长度、join merge） | stable |
| `writeChildParams` | 函数 | persistence.ts | fan-out 时落盘某 child 的 params_for_child 到其子实例目录（engine 写，for-each worker 参数通道，见 [[parallel-execution#^anc-exec-parallel-foreach-worker]]；+kind 第四参 parallel/calls——call 子实例落 calls/<cid>,0020 修:原写死 parallel 且 engine 侧 dead import 从未调用） | stable |
| `readSpec` | 函数 | persistence.ts | 读实例目录 spec.json 重建 AST（cli 跨进程恢复面——load 之外的轻量读取口） | stable |
| `readChildParams` | 函数 | persistence.ts | worker init 按 cid 回读自己那份 params（engine 调，同上通道的读侧） | stable |

> **内部（表外即内部）**：`writeAtomic`（原子写，被 FilePersistence 内部调）、`ensureStateDir` / `writeState` / `writeVars` / `writeSpec` / `readSpec`（快照读写细节，仅 FilePersistence 内部调用）。
>
> **2026-08-01 清单补登**：`flattenVars` / `writeChildParams` / `readChildParams` 三者早已被 cli/engine 跨模块使用（各有完整注释与用途），但清单未登记 → anchor-audit 报 `symbol_not_public` 边界违规。核实为**清单滞后于实现**（清单增量引入时只列了主要符号），非代码越界，故补登记为公开接口。

**实现要点**：
- **FilePersistence**（复用模式）：快照 ↔ `.hopstate/<instance_id>/` 文件。CLI 每个命令是独立进程，状态必须外置存活
- **MemoryPersistence**（纯内存宿主兜底）：进程内快照。~~独立模式默认~~——原"Dispatcher 驱动完整生命周期无需跨进程"论证 2026-08-29 翻案（四坑:deflate 无 work_zone/暂停卡蒸发/崩溃全重跑/commit 退火标记随内存死,权威 [[step-dispatcher#^anc-exec-call-child-persist]]）;现仅存于宿主自身无 instanceDir 的场景（测试/程序内嵌入——"无跨进程"假设真成立处）,standalone call/parallel 子实例已改落盘随父
- 职责边界：只管快照存取。crash recovery 的状态修复逻辑（running→pending 重置、branch 选择保留）属 Engine 业务，留在 `ExecutionEngine.resume()`。

> **实装状态（2026-06-13）**：接口族已实装。`FilePersistence`/`MemoryPersistence` 于 persistence.ts，ExecutionEngine 经 `EngineOptions.persistence` 注入（不传则 stateDir→FilePersistence，再无则 MemoryPersistence 默认）。
> **已登记债**：saveSnapshot 当前分 writeVars+writeState+writeSpec 三次 writeAtomic，相邻写之间崩溃窗口存在（合并单文件快照，见 [[todo/0002_DEBT-06-saveSnapshot双写崩溃窗口_open|DEBT-06]]）。HostConfig 完整恢复不经持久化——Provider 是运行时对象，由宿主 resume 时重新注入（DEBT-05,早期债——锚已随 TODO.md 退役,相关语境见 [[todo/0002_DEBT-06-saveSnapshot双写崩溃窗口_open|DEBT-06 卡]]触发条件）。
