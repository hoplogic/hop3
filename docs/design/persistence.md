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

> **模块版本**：persistence 模块（`persistence.ts`：FilePersistence/MemoryPersistence + readState/readVars/readSpec/readStateSeq/writeAtomic） `v0.6.1`（2026-10-07 `findRunRoot` 从内部转公开——todo/0146 commit 批准账按 run 根上一级定位,cli 与 mcp-server 两个组合根调用;函数行为不变）。上版 v0.6.0（2026-09-30。本版=spec 运行时快照改为**内容寻址**——真身按 sha256 在 run 根 `specs/` 存一份,各实例 `spec.json` 只存引用,同内容跨实例跨步骤零重写;读侧兼容旧内联形态并按哈希缓存;契约 ^anc-provider-spec-content-addressed（todo/0130 承接 hopissues/0115：hopkb 单批 2309 份 spec.json 1.62G 只有 3 种内容）。上版 v0.5.0（2026-09-26）公开面加 readStateSeq——只读 state.json 的写入序号与最后写入者,供 engine 写盘前核对,todo/0114）。0.x 未承诺稳定。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。
>
> **vars.json format_version=2（2026-07-04）**：vars.json 从扁平变量字典（v1）升级为**完整 scope 树**（v2，结构与迁移见 [[exec-engine#^anc-exec-vars-scope-persist]]）——修复扁平序列化下兄弟 scope 同名变量跨进程互覆盖的静默数据损坏。
>
> `readVars`/`fromJSON` 按 `format_version` 分支兼容旧 v1（扁平塞 root）。scope 树的序列化/重建逻辑在 `ast-runtime.ts` VariableStore.toJSON/fromJSON，persistence 层只透传读写。

**对外接口清单【封闭】** ^anc-provider-persistence-exports：

> 出口文件 = `persistence.ts`。表外即内部。校验见 [[anchor-audit-knowledge#模块边界接口校验]]。`PersistenceProvider` 接口类型本身归 shared-providers（见 [[shared-providers#^anc-provider-persistence]]），本模块是其实现。

| 符号 | 种类 | 出口文件 | 用途（谁依赖） | 稳定性 |
|---|---|---|---|---|
| `FilePersistence` | 类 | persistence.ts | 文件快照实现（engine 复用模式默认） | stable |
| `MemoryPersistence` | 类 | persistence.ts | 内存快照实现（engine 独立模式默认） | stable |
| `readState` | 函数 | persistence.ts | 读 state.json（cli 查询/恢复） | stable |
| `readVars` | 函数 | persistence.ts | 读 vars.json（cli 查询） | stable |
| `readStateSeq` | 函数 | persistence.ts | 只读 state.json 的 `state_seq` 与 `last_writer` 两个字段,返回 `{ seq, last_writer? }`;文件不在、读不出、解析失败、字段缺席都返回 `seq: 0`,不抛。engine 写盘前核对与 MCP 预检用（经 engine.assertStateFresh）,判据与字段语义权威 [[exec-engine#^anc-exec-state-seq-guard]] | stable |
| `stateExists` | 函数 | persistence.ts | 判实例状态是否存在（cli 定位实例） | stable |
| `flattenVars` | 函数 | persistence.ts | VarsFile（v1 扁平 / v2 scope 树）摊平为 name→value 字典，供按名读取的 cli 场景（call 回填、for-each 列表长度、join merge） | stable |
| `writeChildParams` | 函数 | persistence.ts | fan-out 时落盘某 child 的 params_for_child 到其子实例目录（engine 写，for-each worker 参数通道，见 [[parallel-execution#^anc-exec-parallel-foreach-worker]]；+kind 第四参 parallel/calls——call 子实例落 calls/<cid>,0020 修:原写死 parallel 且 engine 侧 dead import 从未调用） | stable |
| `readSpec` | 函数 | persistence.ts | 读实例目录 spec.json 重建 AST（cli 跨进程恢复面——load 之外的轻量读取口;**唯一合法读口**——spec.json 自 v0.6.0 起可能是引用形态 `{$spec_ref}`,裸 JSON.parse 拿不到 AST,mcp-server 0093 兜底读盘处随改;双形态与缓存见 ^anc-provider-spec-content-addressed） | stable |
| `readChildParams` | 函数 | persistence.ts | worker init 按 cid 回读自己那份 params（engine 调，同上通道的读侧） | stable |
| `findRunRoot` | 函数 | persistence.ts | 实例目录沿 parallel/calls 布局上溯到顶层实例目录（run 根）;cli 与 mcp-server 组合根据它定位 commit 批准账 `<run 根上一级>/commit_approvals.json`（[[exec-engine#^anc-exec-commit-approval]]） | stable |
| `writeAtomic` | 函数 | persistence.ts | 原子写文件（先写 .tmp、fsync、再 rename 覆盖）。FilePersistence 内部落快照用;engine 写命令参数文件也用它（`<父实例目录>/cmd_args/`,每次拼命令都覆盖,见 [[exec-engine#^anc-exec-cmd-args-file]]——hopissues/0097） | stable |

> **内部（表外即内部）**：`ensureStateDir` / `writeState` / `writeVars` / `writeSpec`（快照读写细节，仅 FilePersistence 内部调用;v0.6.0 起写侧做内容寻址去重）（`findRunRoot` 2026-10-07 起转公开,见上表）。readSpec 不在此列——它在上表公开面,cli 跨进程恢复消费;2026-09-12 0088 批清双登矛盾,原文两处同时把它记成公开与内部）。
>
> **测试可达面口径**：内部件带 export 供 tests/ 直测（writeState 被 persistence.test.ts import 属正当测试消费,不算越出内部边界——与 hop-cli 出口清单"测试可达面"同款口径,2026-09-12 补记）。
>
> **2026-08-01 清单补登**：`flattenVars` / `writeChildParams` / `readChildParams` 三者早已被 cli/engine 跨模块使用（各有完整注释与用途），但清单未登记 → anchor-audit 报 `symbol_not_public` 边界违规。核实为**清单滞后于实现**（清单增量引入时只列了主要符号），非代码越界，故补登记为公开接口。

**实现要点**：
- **state.json 的 `state_seq` / `last_writer` 字段归引擎账**：由 engine 的 buildStateFile 写出、load 读回,本模块只透传写盘、只提供 readStateSeq 这个只读口;写盘前的新鲜度核对在 engine.persist 里做,FilePersistence.saveSnapshot 不改（权威 [[exec-engine#^anc-exec-state-seq-guard]]）
- **FilePersistence**（复用模式）：快照 ↔ `.hopstate/<instance_id>/` 文件。CLI 每个命令是独立进程，状态必须外置存活
- **MemoryPersistence**（纯内存宿主兜底）：进程内快照。~~独立模式默认~~——原"Dispatcher 驱动完整生命周期无需跨进程"论证 2026-08-29 翻案（四坑:deflate 无 work_zone/暂停卡蒸发/崩溃全重跑/commit 退火标记随内存死,权威 [[step-dispatcher#^anc-exec-call-child-persist]]）;现仅存于宿主自身无 instanceDir 的场景（测试/程序内嵌入——"无跨进程"假设真成立处）,standalone call/parallel 子实例已改落盘随父
- 职责边界：只管快照存取。crash recovery 的状态修复逻辑（running→pending 重置、branch 选择保留）属 Engine 业务，留在 `ExecutionEngine.resume()`。

> **实装状态（2026-06-13）**：接口族已实装。`FilePersistence`/`MemoryPersistence` 于 persistence.ts，ExecutionEngine 经 `EngineOptions.persistence` 注入（不传则 stateDir→FilePersistence，再无则 MemoryPersistence 默认）。
> **已登记债**：saveSnapshot 当前分 writeVars+writeState+writeSpec 三次 writeAtomic，相邻写之间崩溃窗口存在（合并单文件快照，见 [[todo/0002_DEBT-06-saveSnapshot双写崩溃窗口_open|DEBT-06]]）。
>
> HostConfig 完整恢复不经持久化——Provider 是运行时对象，由宿主 resume 时重新注入（DEBT-05,早期债——锚已随 TODO.md 退役,相关语境见 [[todo/0002_DEBT-06-saveSnapshot双写崩溃窗口_open|DEBT-06 卡]]触发条件）。

## spec 快照内容寻址【契约】 ^anc-provider-spec-content-addressed

2026-09-30 todo/0130 立,承接 hopissues/0115（hopkb 报）。**来由**：v1 `saveSnapshot` 每次把整棵 AST `JSON.stringify(spec, null, 2)` 写到本实例目录——按实例复制（每个 call/parallel 子实例各一份）× 按步重写（每步整份序列化）。前提"spec 通常不大"在 hopkb batch-construct 这类展开后 700KB 的规约上不成立：122 份材料的一批 2309 份 spec.json 合计 1.62G **只有 3 种内容**,resume 加载 ~850MB,同机当日 ENOSPC 崩两批。只做 v2 脏标记消得掉"按步重写"消不掉"每实例一份"（落盘字节几乎不降）,故改内容寻址：同内容只落一份真身,实例目录只存引用。

```
contract: SpecContentAddressed
  Id: persist-spec-cas
  Goal: 运行时 AST 快照按内容哈希在 run 根存一份真身,各实例 spec.json 只存引用——同内容跨实例跨步骤零重写;读侧对引用与旧内联两种形态都认,并按哈希缓存解析结果
  Constraints:
  - 真身位置=顶层实例目录（run 根）下 `specs/<sha256>.json`。run 根由实例目录沿 <父>/parallel|calls/<cid>/ 布局上溯到"上一级无 state.json 或目录名非 parallel|calls"为止（findRunRoot,与 getWorkZoneRoots 同一套上溯——[[exec-engine#^anc-exec-work-zone]] 目录不变量）。放顶层实例目录下而不是 state-dir 根下,是让 specs/ 随 run 整目录删（清理粒度=run,与 .hoplog max_runs 同律）
  - 哈希=sha256(JSON.stringify(spec)) 十六进制。真身文件内容就是这个无缩进序列化串——机器账不为人读,不再缩进（700KB→约 450KB）;同 AST 恒同字节恒同哈希
  - 实例目录 spec.json 沿用文件名,内容=引用 `{"format_version": 1, "$spec_ref": "<sha>"}`。沿用文件名是为了"三件在场"判定（stateExists、测试、观测脚本）零波动;靠 `$spec_ref` 键判形态
  - 写侧两层幂等：真身文件已存在（同内容已落盘）则不写;实例 spec.json 已是同 sha 引用则不写。replan 改了 AST → 新 sha 新真身,旧真身不删（天然留作版本史;恢复语义不变——引用指向的永远是当前 AST）
  - 读侧双形态：spec.json 有 `$spec_ref` → 去 run 根 specs/ 取真身;无 → 旧内联形态,原样返回不迁移不改写。旧 run 目录可直接 resume;它的第一次 persist 会自然转成引用+真身（自动迁移,零工具零命令）
  - 读侧缓存：进程内 Map<sha, 序列化串>,命中不再读盘;返回值每次独立 JSON.parse（不共享可变对象——engine.load 把结果当 this.spec 原地改,共享会串实例）。2309 份只读 3 次盘
  - 真身缺失或损坏、引用文件非合法 JSON → CORRUPT_STATE_FILE,报文点名引用文件与真身两条路径（与 state/vars 同错误语义）
  - saveSnapshot 三件恒写的契约不变（[[exec-engine#^anc-exec-state-persistence]]）——本条改的是 spec 那一件"写到哪、怎么去重",不改"必写"
  - MemoryPersistence 零变化（内存快照无落盘）
```

**类型约定（HopType）**：

- 引用文件 `spec.json`：`{ format_version: 1, $spec_ref: string }`——`$spec_ref` 装真身文件名去掉 `.json` 的 sha256 十六进制串（64 字符）;
- `findRunRoot(instanceDir: string): string`——公开（2026-10-07 起,原模块内部）;入参实例目录绝对路径,返回顶层实例目录绝对路径（自身即顶层时返回自身）;
- `writeSpec(dir: string, spec: object): void`——模块内部,签名不变;`readSpec(dir: string): object`——公开,签名不变,返回值是独立的 AST 对象。

**关键逻辑（HopSop）**：

```
writeSpec(dir, spec):
1. body = JSON.stringify(spec); sha = sha256(body); root = findRunRoot(dir)
2. target = join(root, 'specs', sha + '.json')
3. [条件(target 不存在)] mkdir -p join(root,'specs'); writeAtomic(target, body)
4. ref = join(dir, 'spec.json'); [条件(ref 已存在 且 其 $spec_ref == sha)] 返回
5. writeAtomic(ref, JSON.stringify({format_version: 1, $spec_ref: sha}))

readSpec(dir):
1. raw = 读 join(dir,'spec.json'); 不可读/非 JSON/非对象 → CORRUPT_STATE_FILE
2. [条件(raw 无 $spec_ref)] 返回 raw（旧内联形态）
3. sha = raw.$spec_ref; [条件(缓存有 sha)] 返回 JSON.parse(缓存串)
4. body = 读 join(findRunRoot(dir), 'specs', sha+'.json'); 不可读/非 JSON/非对象 → CORRUPT_STATE_FILE（点名引用文件与真身路径）
5. 缓存[sha] = body; 返回 JSON.parse(body)

findRunRoot(instanceDir):
1. dir = instanceDir
2. [循环] 当 basename(dirname(dir)) ∈ {parallel, calls} 且 dirname(dirname(dir)) 下存在 state.json：dir = dirname(dirname(dir))
3. 返回 dir
```

**消费侧**：FilePersistence.init / saveSnapshot / loadSnapshot;ExecutionEngine.load;cli 跨进程恢复面（readSpec）;mcp-server 0093 快照兜底读盘（改走 readSpec）;getWorkZoneRoots 改基于 findRunRoot（行为不变）。

**不做**：.hopstate 保留期清理（另立卡,与 .hoplog max_runs 对称）;vars.json / state.json 不压（每实例内容真不同,量级低一档）;不提供迁移工具（旧目录首次 persist 自动转）。
