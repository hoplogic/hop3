%% @trace
	id: hopjit-sandbox
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-09-27T20:38+0800
	note: SandboxConfig 四维度安全模型——act 步骤的资源边界定义与拦截规则。内容分级（决策/契约/说明）+ 6 个配置锚点 + 1 个执行模型锚点
%%

# SandboxConfig 四维度安全模型

> **模块版本**：sandbox `v0.3.2`（2026-10-11 todo/0161：步骤映射表 check 行从"不调用工具"改为"按声明进工具循环,只读工具面,与 reason 同一套规则;零声明单发纯判定"——作者定 check 可能要读文件留口子）。上版 v0.3.1（2026-10-11 语义审计 0156 A3：步骤映射表 reason/check 一行拆两行——reason 按声明进工具循环与 act 同能力面（^anc-exec-reason-tools 2026-09-01 放开后本表未更新,审计 ❌）,check 仍不调工具;DefaultToolProvider "仅两件"改为 18 件并指向 tools 索引）。上版 v0.3.0（2026-10-07 todo/0148：FilesystemSandbox 加可选 `write_access.allowed`（commit 可写的 workspace 外目录,唯一来源 Config.dirs.readwrite 经授权）;read_access.allowed 写明三类来源;加四档边界表;写操作拦截规则加 write_access 一行。上版 v0.2.1（2026-10-04 workspace_dir 持久化形态契约——恒绝对路径,run 起跑定一次,不随后续命令进程 cwd 漂移;英文文档批一实撞）。上版 v0.2.0（2026-08-29）。0.x 未承诺稳定；四维度沙箱是 act 步骤安全边界的多方消费契约。**逐版演进史归 git log**（本行只记现行版本）。

## 文档结构与内容分级

本文档内容分三级，审计要求不同：

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【决策】** | 人拍板的关键选择 | 改动需作者确认 |
| **【契约】** | 带 `^anc-*` 锚点的技术约定 | 代码/测试必须对齐，anchor-audit 全量审查 |
| **【说明】** | 示例、配置演示、典型场景 | 与契约一致即可，无独立锚点 |

| 章节 | 分级 | 锚点 |
|------|------|------|
| 定位（四要素） | 契约 | `anc-config-sandbox-model` |
| 关键决策 | 决策 | — |
| ① filesystem | 契约 | `anc-config-sandbox-filesystem` |
| ① filesystem · 工作区根的生命周期 | 契约 | `anc-config-sandbox-workspace-root` |
| ② network | 契约 | `anc-config-sandbox-network` |
| ③ runtime | 契约 | `anc-config-sandbox-runtime` |
| ④ database | 契约 | `anc-config-sandbox-database` |
| 工具执行模型 | 契约 | `anc-exec-sandbox-principle` |
| 与 HopSpec 步骤类型的映射 | 契约 | `anc-config-sandbox-step-mapping` |
| 宿主配置示例 | 说明 | — |

## 定位【契约】 ^anc-config-sandbox-model

**① 自身定位**：SandboxConfig 是 act 步骤的**四维度资源边界定义**——声明式描述 act 步骤能安全触及的 filesystem / network / runtime / database 四类资源边界。核心原则：**act 步骤内一切操作可安全重做**——失败时 subtask retry 不会产生不可逆后果。四种资源类型各有独立的拦截规则，共同保证：可逆操作（试算、草稿、查询）在 act 步骤中自由执行，不可逆操作（发邮件、写生产库、支付）必须经过 commit 步骤。

**② 与其他 HopType 的关系**：
- **HostConfig 持有**——宿主环境在实例化时注入 `HostConfig.sandbox`（定义见 [[shared-types]] `^anc-config-sandbox`），run 期间不变
- **DefaultToolProvider / 宿主 ToolProvider 执行拦截**——SandboxConfig 本身只是声明，实际拦截由工具实现：每个工具内部按本文档拦截规则做路径/域名/表名/运行时检查；`requires_commit: true` 的工具在 act 步骤被 StepDispatcher 拦截
- **与 ActStep 沙箱约束对应**——SpecAST 的 ActStep 声明"无不可逆副作用，操作范围限于 SandboxConfig"（见 [[spec-ast]] `^anc-step-act-sandbox-constraint`），SandboxConfig 给出该约束的具体边界

**③ 四维度结构**：

```
HopType: SandboxConfig
  Id: sandbox-config
  Fields:
    - filesystem % FilesystemSandbox  # 详见下文 ① filesystem
    - network % NetworkSandbox        # 详见下文 ② network
    - runtime % RuntimeSandbox        # 详见下文 ③ runtime
    - database % DatabaseSandbox      # 可选。详见下文 ④ database
```

（TS 形态是代码层投影，在 src/provider-types.ts——设计以本 HopType 为准。）

- `filesystem`——工作区写边界 + 分级读权限（denied / confirm_required / workspace / allowed）
- `network`——可信域名白名单，只读出站约束
- `runtime`——可用运行时声明，本地计算边界
- `database`（可选）——临时库（act 可读写）与只读库（act 只查询）划分

**④ 拦截规则 impl 逻辑**：四维度的拦截统一遵循"可逆即放行、不可逆即拦截到 commit"。每个维度的拦截在对应工具内部实现（DefaultToolProvider 的 18 件内置工具各在工具内部做路径级检查；宿主 ToolProvider 注册更多工具时在工具内部做参数级解析）。act 步骤的完备性来自：所有操作都经过受控工具接口，每个工具自守边界，无任意代码执行逃逸口（见工具执行模型 `^anc-exec-sandbox-principle`）。

---

## 关键决策【决策】

以下是必须人拍板、无法从更上层概念推演的关键选择：

1. **act 步骤可安全重做原则**——act 步骤内一切操作必须可逆，失败 retry 不产生不可逆副作用。这是整个沙箱模型的总纲：决定了哪些操作能进 act（试算、草稿、查询），哪些必须留给 commit（发邮件、写生产库、支付）。
2. **四维度划分而非扁平结构**——资源边界按 filesystem / network / runtime / database 四个维度独立建模，而非用单一扁平的路径/命令白名单。每个维度有各自的可逆性语义和拦截规则，划分让边界定义更贴合资源本质。
3. **DefaultToolProvider 无 bash**——内置 18 件里没有 shell 工具;唯一的脚本入口 `run_script` 只跑经 Python 语法沙箱核过的 .py 文件（拒 .sh,不能传命令,解释器由扩展名定,[[tools/run-script#^anc-exec-builtin-run-script]]）,与 body 面的 `subprocess.run` 同档 requires_commit=false。宿主注入的 bash 类工具是高危工具，等价于放弃沙箱保护，仅 commit 步骤可用（`requires_commit: true`），且不建议使用。
4. **act 逻辑都是受控代码**——act 步骤中 LLM 的唯一能力是从预注册工具列表选一个调用并传参，不是任意代码执行。沙箱完备性建立在"无任意代码执行"之上。
5. **database 临时库 temp_databases 在 act 可写**——临时库可重建，写入可逆，因此允许 act 步骤自由读写；生产库写入不可逆，必须经 commit。这是"可安全重做"原则在数据库维度的具体落地。
5b. **默认沙箱 denied 基线**（2026-08-08 语义审计 ❌ 后补契约;2026-08-27 #50 扩 .hoplog）：cli/mcp-server 构造的缺省 HostConfig 沙箱，denied 必须含 `['.env', '.env.*', '*.key', '*.pem', '.hopstate/**', '.hoplog/**']`——密钥/凭证/执行状态/执行日志（含变量值与 API 响应）即使在 workspace 内也默认拒读，显式配置可覆盖。
   - 两次实撞：原实现 denied=[] 使默认部署下凭证文件对 LLM read 工具可读；.hoplog 缺席使 act free 工具环的 LLM 可 listdir 逛日志树、read 几 MB 级 main.yaml 把自己上下文灌爆（dr19 实撞：灌到 1096042 tokens 超 1048576 上限 400 确定性死烧尽子树,同型复发 21 处——引擎内务区不是作业材料,LLM 读执行账本=自食尾巴）。

6. **filesystem 读权限优先级 denied > confirm_required > workspace > allowed**——多个读权限规则冲突时，禁止规则优先于放行规则，确保密钥/敏感文件即使落在 workspace 或 allowed 范围内也被拦截。

---

## ① filesystem（文件系统）【契约】 ^anc-config-sandbox-filesystem

```
HopType: FilesystemSandbox
  Id: filesystem-sandbox
  Fields:
    - workspace_dir % line  # 工作区根目录——内部可自由写、删、试验。**恒为绝对路径**（见下「工作区根的生命周期」）
    - read_access % yaml    # 三清单：allowed（可自由读的路径/glob——来源三类：组合根配置、起跑自动加入的 spec 所在目录与 hop_env 声明根、spec `Config.dirs` 的 read ∪ readwrite 展开值）/ denied（绝对禁读——密钥、凭证文件）/ confirm_required（需 confirm 步骤后才能读——敏感配置）
    - write_access % yaml   # 可选。一清单：allowed——commit 步骤可写的 workspace 之外的目录（绝对路径;唯一来源=spec `Config.dirs.readwrite` 展开后经人批准,[[exec-engine#^anc-exec-dirs-grant]]）。字段缺席=无扩展,既有配置零改
```

**四档边界表**（2026-10-07 todo/0148,作者定"完整语义是 read / read-write"）——`Config.dirs` 不引入第五档,只把 workspace 之外的目录归到既有两档里：

| 目录 | act/check 读 | act/check 写 | commit 写 |
|---|---|---|---|
| work_zone | 是 | 是 | 是 |
| workspace | 是 | 否 | 是 |
| `dirs.readwrite`（= write_access.allowed） | 是 | 否 | 是 |
| `dirs.read` / spec 目录 / hop_env 根（= read_access.allowed 的三类来源） | 是 | 否 | 否 |

`denied` 对四行都优先拦——声明读写不等于能读里面的密钥。

### 工作区根的生命周期【契约】 ^anc-config-sandbox-workspace-root

HopSpec 体系里**没有"当前目录"的概念**：没有 chdir 类原语,上一步不改变下一步路径的解释方式。一切相对路径只相对一个 run 级固定基准解释——**工作区根**。两条：

1. **起跑定一次**：工作区根在 run 起跑那一刻取自组合根（CLI 模式=起跑命令的进程 cwd;MCP 模式=start_run 的 workspace_dir 参数,缺省 server cwd）,之后整个 run 不变。`HostConfig.workspace_dir` 与 `sandbox.filesystem.workspace_dir` 是**同一个目录**（前者是相对路径拼接基准,后者是写权限边界——不同一个目录就会出现"路径拼得对却被判越界"）。
2. **持久化恒存绝对路径**：两个字段进 state.json 时都必须已是绝对路径,**禁止存 `'.'` 之类相对写法**。原因：复用模式下一个 run 是几十次独立 `hopjit` 进程串起来的,driver 从哪个目录敲命令是 driver 的事（worker 为了写相对 `--output @文件` 常 cd 进自己的 work_zone）;相对写法存盘后每个进程按自己的 cwd 重新展开,起跑时指仓库根、续推时指 work_zone,写权限边界就随 driver 的 shell 漂了。MCP 侧 2026-08-20 已按此改（[[mcp-server#^anc-mcp-config]] 沙箱锚=绝对路径）,CLI 侧 `buildHostConfig` 当时漏改,2026-10-04 实撞：三个翻译 worker 的 `[commit] write` 全部被 `Write outside workspace sandbox` 拒,目标明明在仓库根之内。

正例：run 在 `/repo` 起跑,driver 后来在 `/repo/.hopstate/x/work_zone` 下敲 `submit_and_fetch_next` 触发 commit 写 `docs/a.md` → 落 `/repo/docs/a.md`,放行。反例：同一 run 的 commit 写 `/tmp/outside.md` → 不在 `/repo` 内,拒绝（边界本身不放松）。

### 拦截规则【契约】

**写操作**（步骤分域见 [[tools/file-tools#^anc-exec-builtin-file-tools]]：act/check 只 work_zone;下列是 commit 的写域）：
- workspace_dir 内 → allow
- `write_access.allowed` 某目录内 → allow（真实路径判、带分隔符边界,与读侧同判据;来源与授权见 [[exec-engine#^anc-exec-dirs-grant]];工具侧实装 [[tools/file-tools#^anc-exec-builtin-file-tools]] 写侧分域句）
- 其余 → reject
- `.hopstate/` 目录 → reject（引擎状态文件不可被步骤修改）

**读操作**（优先级从高到低）：
1. denied 模式匹配 → reject（绝对禁止，如 `~/.ssh/id_rsa`）
2. confirm_required 模式匹配 → reject（act 步骤不能 confirm，需显式 confirm 步骤前置）
3. workspace_dir 内 → allow
4. allowed 模式匹配 → allow
5. 其余 → reject

**安全防护**：
- 绝对路径 → 落在 workspace 内按相对路径同样处理,workspace 外 reject（2026-09-30 hopissues/0112 改,原为"一律 reject"——判据只问落点不问写法;细则 [[tools/file-tools#^anc-exec-tool-path-resolve]]）
- 路径穿越 `..` → reject
- symlink 逃逸（解析后指向 workspace 外且不在 allowed 中）→ reject——"在内"判定带路径分隔符边界（兄弟目录 /x/proj2 不算 /x/proj 之内）,目标文件不存在时解析到最近已存在的祖先目录（经软链父目录新建文件同样拦）

### 典型配置【说明】

```yaml
filesystem:
  workspace_dir: /home/user/project
  read_access:
    allowed:
      - /home/user/project          # workspace 自身
      - /home/user/shared-data      # 共享数据目录
    denied:
      - .env                          # 环境变量文件
      - "*.key"                       # 所有密钥文件
      - ~/.ssh                        # SSH 密钥
    confirm_required:
      - config/production.yaml        # 生产配置需人工确认后读取
```

---

## ② network（网络访问）【契约】 ^anc-config-sandbox-network

```
HopType: NetworkSandbox
  Id: network-sandbox
  Fields:
    - trusted_hosts % [line]  # 可信域名白名单
```

### 拦截规则【契约】

**act 步骤内的网络访问**（由宿主注入的网络工具发起，如 http_get）：
- trusted_hosts 非空 → allow GET/只读请求到白名单域名
- trusted_hosts 为空 → reject（act 步骤完全禁止网络出站）
- POST/PUT/DELETE 等有副作用的请求 → 需 commit 步骤（不论是否在白名单内）
- 白名单外域名 → reject

**实现方式**：
- DefaultToolProvider：**v1 无网络工具**（18 件内置里没有一件发网络请求），network 维度是声明性配置，不产生实际拦截
- 宿主 ToolProvider：注册网络工具（如 http_get）时，在工具内部查 trusted_hosts 做 URL 级别拦截

### 典型配置【说明】

```yaml
network:
  trusted_hosts:
    - api.github.com                  # 代码仓库 API
    - registry.npmjs.org              # 包管理
    - arxiv.org                       # 论文查阅
```

---

## ③ runtime（运行时环境）【契约】 ^anc-config-sandbox-runtime

```
HopType: RuntimeSandbox
  Id: runtime-sandbox
  Fields:
    - available % [line]  # 命令白名单——引擎强制(2026-08-29 语义升格,原"声明性文档"退役)。两个消费口共用:body 的 subprocess.run + 工具面的 run_script(2026-09-22)
```

### 拦截规则【契约】

- **available = 引擎执行本地命令的唯一白名单（2026-08-29 作者定 todo/0033,字段语义升格——原"可用运行时声明,文档性不校验"升为引擎强制;存量零破坏:该字段此前引擎零消费）**：命令名（argv[0]）必须 ∈ available,否则运行期点名拒;**名单空/未配置=能力关死**（缺省安全——引擎不内置任何命令）。
  - **两个消费口共用这一份名单（2026-09-22 随 run_script 批扩）**：① body 里的 `subprocess.run(argv)`——规约作者写死的命令,执行契约权威 [[act-body#^anc-exec-subprocess-run]];② 工具面的 `run_script(path, args?)`——执行步里模型按任务需要跑的脚本,**模型只供给脚本路径,解释器由引擎按扩展名定**（`.py` → `python3`）,契约权威 [[tools/run-script#^anc-exec-builtin-run-script]]。
  - **为什么共用一份名单**：操作者只需在一处表达"这台机器上允许跑什么"。两个口的核对逻辑（含 hopjit 恒拒与两拒报文的配置指路）也是同一份实现,见 [[act-body#^anc-exec-command-primitive]];
  - **run_script 的真实边界要如实认**：白名单管住的是解释器,管不住脚本内容能再 spawn 什么（一个 `.py` 脚本自己可以 `subprocess.call` 任何东西）。它的边界是两道人的授权叠加——操作者放行 `python3` + 规约作者在那一步写 `- 工具: run_script`。这是 spawn 通道的物理边界,与下面工程偏差同性质,不是 run_script 引入的新洞。
- 白名单按命令名收口,参数不设白名单（参数是数据,参数列表制直接 spawn 不经 shell——注入无门）
- 安装新包（pip install / npm install / apt install）→ 需 commit 步骤（操作者不应把包管理器放进白名单供 act 用——放了=自担 act 位可重跑后果,v1 无机器拦,见 act-body 工程偏差①）
- 修改系统级依赖或全局配置 → 需 commit 步骤（同上）

**实现方式**：
- 配置通路：StandaloneConfig 顶层 `commands` 键（standalone config.yaml/项目级 hopjit.yaml,人话名）→ hostConfig.sandbox.runtime.available（见 [[act-body#^anc-exec-subprocess-run]] 配置通路条款）
- 引擎（BodyInterpreter subprocess.run 专路）：运行期强制 argv[0] ∈ available（唯一强制点——validate 期不静态预检:validate 时点的 sandbox 配置未必是运行期那份,静态查易误报）
- 宿主 ToolProvider 的 Bash 类工具：仍可自行实现命令解析对照 available（既有可选形态,不变）

### 典型配置【说明】

```yaml
runtime:
  available:
    - python                          # Python 3.x
    - node                            # Node.js
    - uv                              # uv 包管理器
    - pdf                             # PDF 解析（pymupdf）
    - ocr                             # OCR 能力
```

---

## ④ database（数据库）【契约】 ^anc-config-sandbox-database

```
HopType: DatabaseSandbox
  Id: database-sandbox
  Fields:
    - temp_databases % [line]      # 临时库——act 步骤可读写
    - readonly_databases % [line]  # 可选。只读库——act 步骤只能查询
```

### 拦截规则【契约】

- temp_databases 中的库/表 → act 步骤可自由读写（临时库可重建，重做安全）
- readonly_databases 中的库/表 → act 步骤只读，写入需 commit
- 未声明的数据库 → 全部禁止访问
- schema 变更（CREATE TABLE / DROP TABLE / ALTER TABLE）→ 始终需要 commit

### 设计动机【说明】

探索型任务中，agent 需要数据库做中间计算（如数据清洗、统计分析、临时索引）。临时库的写入是可逆的——失败时清空重来即可。生产库的写入是不可逆的——必须经过 commit 步骤和人工确认。

### 典型配置【说明】

```yaml
database:
  temp_databases:
    - hopjit_temp                     # agent 临时计算库
    - scratch                         # 草稿库
  readonly_databases:
    - analytics                       # 分析数据（只读查询）
    - user_data                       # 用户数据（只读）
```

### 典型场景【说明】

```
1. [act] 从生产库查询原始数据
  > SELECT * FROM readonly_db.orders WHERE ...    ← readonly 允许查询

2. [act] 在临时库创建清洗中间表
  > CREATE TABLE temp_db.cleaned AS SELECT ...    ← temp 允许写入

3. [check] 验证清洗结果质量达标
  > SELECT count(*) FROM temp_db.cleaned WHERE quality < 0.8

4. [commit] 写入生产库
  > INSERT INTO production.clean_orders SELECT * FROM temp_db.cleaned
```

**实现方式**：
- DefaultToolProvider 不含 DB 工具——18 件内置里没有数据库类
- 宿主注入的 ToolProvider 注册 DB 工具（如 `sql_query`、`sql_exec`）时：
  - `sql_query` 设为 `requires_commit: false`，内部根据 DatabaseSandbox 判断表是否可读
  - `sql_exec` 设为 `requires_commit: true`（默认），或内部检查目标表是否在 temp_databases 中动态决定

---

## 工具执行模型【契约】 ^anc-exec-sandbox-principle

act 步骤中 LLM 的唯一能力是**从可用工具列表中选一个调用，传参数，拿结果**。没有任意代码执行能力。

**DefaultToolProvider** 内置 18 件工具（文件工具 11 件 read / write / listdir / exists / create / append / edit_file / search_file / makedirs / move / remove，spec 树编辑 6 件 validate_spec / insert_node / replace_node / replace_children / renumber_steps / read_spec_tree，脚本 1 件 run_script——件数以 `src/tools.ts` `DefaultToolProvider.list()` 为准，逐件契约归 [[tools#^anc-struct-tools-modules]] 索引的子目录文件，本节不复抄清单）。早期只有 read / write 两件，本节原文沿用至 2026-10-11 语义审计才改。

其他能力由宿主通过 ToolProvider 接口注入——`search`、`sql_query`、`http_get`、`parse_pdf` 等。每个工具：
- 有 JSON Schema 定义输入（LLM 只能传合法参数）
- 有 `requires_commit` 声明副作用级别（true = 仅 commit 步骤可调用）
- 实现内部自己做边界检查（路径/域名/表名等）

**bash/script 类工具属于高危工具**：
- 只能在 commit 步骤中使用（`requires_commit: true`）
- 不建议使用——等价于放弃沙箱保护
- 如果宿主确实需要注册 bash 工具，必须标记 `requires_commit: true`

这样沙箱是完备的——act 步骤的所有操作都经过工具接口，每个工具自己守边界，没有逃逸口。

## 与 HopSpec 步骤类型的映射【契约】 ^anc-config-sandbox-step-mapping

| 步骤类型 | 执行能力 | 沙箱约束 |
|---------|---------|---------|
| **act** | 调用受控工具（18 件内置 + 宿主注入） | 四维度沙箱全约束，requires_commit=true 的工具被拦截 |
| **commit** | 调用所有工具（含高危工具） | 无沙箱限制，安全由 Spec 流程保障（confirm 保护） |
| **reason** | 按节点 `- 工具:` 声明进工具循环，与 act 同能力面；零声明=单发纯推理；requires_commit=true 的工具恒不下发（[[step-dispatcher#^anc-exec-reason-tools]]，2026-09-01 作者定"等同于 act 的能力"，2026-09-18 改全按声明） | 同 act：四维度沙箱全约束 |
| **check**（无 body） | 按节点 `- 工具:` 声明进工具循环，与 reason 同一套规则；零声明=单发纯判定；只读工具面——requires_commit=true 的工具恒不下发（[[step-dispatcher#^anc-exec-reason-tools]]，2026-10-11 作者定"check 工具可能要读文件,这个应该留个口子"，todo/0161；原"不调用工具"随之撤）。带 body 的 check 归解释器机械判定，不进本行 | 声明了工具时同 reason：四维度沙箱全约束；零声明无外部资源访问 |
| **confirm** | 暂停等待人工决策 | 不执行操作 |

安全模型的核心：**act 步骤的安全由受控工具 + SandboxConfig 自动保障，commit 步骤的安全由 Spec 作者显式设计**。

---

## 宿主配置示例【说明】

```yaml
# HostConfig.sandbox 完整配置示例
sandbox:
  filesystem:
    workspace_dir: /home/user/project/workspace
    read_access:
      allowed:
        - /home/user/project
        - /home/user/shared-knowledge
      denied:
        - .env
        - "*.pem"
        - ~/.ssh
      confirm_required:
        - config/secrets.yaml
  network:
    trusted_hosts:
      - api.github.com
      - registry.npmjs.org
  runtime:
    available: [python, node, uv, pdf]
  database:
    temp_databases: [hopjit_temp]
    readonly_databases: [analytics, user_data]
```
