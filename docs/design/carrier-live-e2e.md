%% @trace
	id: hopjit-carrier-live-e2e
	source: [[codex-driver-carrier]], [[reuse-mode-prompt-flow]], [[chain-enforcement]]
	source_id: hopjit-codex-driver-carrier, hopjit-reuse-mode-prompt-flow, hopjit-chain-enforcement
	type: extend
	last_sync: 2026-09-17T15:34+0800
	note: CC/Codex 真实载体 E2E 契约——隔离工作区、事件归一、执行体归属断言、凭证不落盘、显式失败与 opt-in CI 边界。2026-08-09 扩失败路径场景组（作者定 12345）：repair/uncaught/parallel-partial/paused/call-fail 五场景,确定性失败触发,单列入口不进硬闸。同日作者指正补 G11 过程核验：失败场景必须读 main.yaml 轨迹（轮次键/warn+failed 块/join 清单/confirm 无 hitl/CalleeFailure 入轨）,只看 state 终态=假绿。
%%

# Carrier Live E2E 设计

> 本文只定义真实 Claude Code / Codex 进程如何验收 HopSpec driver carrier。引擎内部测试仍归现有 Vitest；carrier 文案静态纪律仍归 `check-driver-carriers.mjs`。三者不可互相冒充。

## 文档结构与内容分级

| 章节 | 分级 | 锚点 |
|---|---|---|
| 定位与验收边界 | 契约 | `anc-driver-live-e2e` |
| 隔离与凭证安全 | 契约 | `anc-driver-live-e2e-isolation` |
| 终点凭证与发版硬闸 | 契约 | `anc-driver-live-e2e-evidence` |
| 事件归一与执行体证明 | 契约 | `anc-driver-live-e2e-events` |
| 场景矩阵与退出语义 | 契约 | `anc-driver-live-e2e-scenarios` |
| 自动化入口与 CI 时机 | 契约 | `anc-driver-live-e2e-entry` |
| 断言在链与存档重放 | 契约 | `anc-driver-live-e2e-assertions` |
| 沙箱等价台账 | 契约 | `anc-driver-live-e2e-equivalence` |

## 1. 定位与验收边界【契约】 ^anc-driver-live-e2e

由 [[reuse-mode-prompt-flow#^anc-exec-reuse-subagent-driver]] 推演：driver carrier 的关键行为发生在宿主进程和 subagent 运行时，单测 HopJIT engine 无法证明“谁执行了 `hopjit run`”。由 [[codex-driver-carrier#^anc-driver-codex-capability-gate]] 推演：Codex delegated/inline 的选择依赖当次 effective config，必须真实启动 Codex 才能验收。

Live E2E 固定验证四层事实：

1. **宿主事实**：真实 `claude` / `codex exec` 进程能加载已安装 skill，并形成可解析事件流。
2. **执行体事实**：delegated 场景确有正式 subagent，且 HopJIT 写命令归 subagent；inline 场景能力握手失败后不派生正式 segment，HopJIT 写命令只在 main 执行一次。
3. **业务终态事实**：`examples/coffee-week.md` 完成，终态 YAML 为 `status: completed`，`weekly_report` 含 `周营业额：27600 元`。
4. **执行过程事实**：读取真实 `.hoplog/*/main.yaml`，经 HopLog 的 `extractHopLogStepKeys` 单一格式解析器核验 `state.step_states` 中每个 done 步骤都有精确 YAMLL 块键记录。
   - 日志真实格式是 `execution:` 下的 `"1":`/`"1.1":` 块键，不存在 `step: '1'` 字段；fixture 必须由 `HopLog` 真写，禁止手捏另一套格式。步骤匹配须精确，`1` 不得命中 `10`。
   - **深核（2026-08-09 补，块键在场≠过程真）**：①run 终态行 `status: completed` 入轨（执行走到 close）；②**LLM 交互步骤的产物入轨**——coffee-week 步骤 2 reason 的 `verdict:`、3.2 check 的 `report_ok:` 必须出现在 outputs 块（块键只证明 start 过；outputs 是"LLM 真跑且结果入轨"的唯一产物侧证据）。
   - 失败路径场景组的对应深核见 §4 场景表（轮次键/warn+failed 块/join 清单/confirm 无 hitl/CalleeFailure）。

Live E2E 不替代：

- parser/engine/CLI 的确定性 Vitest；
- carrier 文案 token/parity 静态 lint；
- standalone fallback（尚未实现，见 [[../../TODO#^todo-codex-standalone-fallback]]）。

## 2. 隔离与凭证安全【契约】 ^anc-driver-live-e2e-isolation

每次运行创建独立临时工作区，并只放入：

- coffee-week spec 与演示数据；
- 指向当前仓库构建产物的本地 `hopjit` 入口；
- 由当前 `install-skill` 生成的目标 carrier skill；
- 测试专用最小配置。

工作区生命周期按结果分路（2026-08-08 增补——codex:inline 失败后现场被无差别焚毁，弃实例重跑的根因证据全失，实撞教训）：

- **通过**：`finally` 删除临时工作区（跑完即焚，防真凭证调用残留）；
- **失败（exit 1，carrier 已启动）**：删除前**必须先归档失败现场**到 `.e2e-evidence/failures/<scenario>-<UTC时间戳>/`——内容为 `.hopstate/`（全部实例 state/vars/params）、`.hoplog/`（全部 run 轨迹）、完整 stdout/stderr（不截断——诊断尾部 8000 字符窗口常滚掉早期根因）、归一事件 JSON。
  - **归档前逐文件做 key 脱敏**（§凭证规则 4 同款判据：secret 原文替换为 `[REDACTED]`），脱敏失败的文件宁可不归档也不落原文。归档路径打到 stderr 供人直达；
- **前置缺失（exit 2）**：工作区尚未产生执行内容，直接删除，不归档。

**codex 载体环境自包含（todo/0061,2026-09-02 补）**：起 codex（全场景）前构造临时 CODEX_HOME,spawn env 带 `CODEX_HOME` 指过去,宿主 `~/.codex` 真身全程零接触。

- 实撞出处（2026-09-01 发版前）:宿主 curated 插件包默认全开,未登录 slack 插件令 codex 每次起动连 mcp.slack.com 撞 AuthRequired、rmcp worker 反复 fatal,codex:delegated 业务推进正常却在协作等待挂死、codex:demo 近乎冻结,双双超时——e2e 结论掺宿主环境噪声;
- 构造分三件：
  - 宿主 config.toml 按段过滤复制（`filterCodexConfigForIsolation` 纯函数——剔除 `[plugins.*]`/`[marketplaces.*]`/`[mcp_servers.*]` 三族段与顶层 `notify` 数组〔插件/外部 MCP/桌面通知是宿主噪声〕;model/model_providers/sandbox_mode/projects 信任等按段原样保留——过滤法优于白名单重建,保留面不逐键枚举漏项）;
  - 复制宿主 profile 文件族（`*.config.toml`,flash 档 `-p` 消费）;
  - auth.json 若在（codex 自身登录态保守带上）;
- **codex:standalone 的 hopjit MCP 注册块直写临时 home 的 config.toml**——原宿主文件四机制（append/remove 锚定块、用户 hopjit 段 mask/unmask 避让）随隔离退役:临时 config 已滤掉宿主 `[mcp_servers.*]`,无同名撞块可防,复用场景工具面天然干净（原 mask 防的正是常驻注册漏进工具面）;
- 临时 home 随 run 在 finally 整目录删除（只有配置无执行产物,失败归档不含它;凭证扫描面照罩——auth.json 在内）;
- CC 侧不动:项目级 `.claude/skills` + `--strict-mcp-config` 钉工具面,配置面窄;
- 真机 probe（宿主故意开未登录外连插件跑 codex:demo 应照常绿）待真机批复验。

超时必须终止整个子进程组，不能留下 carrier 或 subagent 后台进程。

> 失败归档是观测链的最后一环：HopLog 每步流式落轨迹（观测层无洞），但取证脚本若在失败路径同样焚毁工作区，轨迹等于从未存在——"失败要能事后归因"须有产物侧信号，与 §5 诞生实撞同一守卫原则。`.e2e-evidence/failures/` 入 `.gitignore`（现场含业务输出，只供本机排障，不入库）。

凭证规则：

1. key 只通过父进程继承环境传给 carrier，不写 prompt、参数、配置文件或测试 fixture。
2. live 命令必须明确指定凭证环境变量名；变量不存在或值为空时，测试以 **exit 2** 失败，不得 skip 或退化为假绿。
3. 测试结束前递归扫描 stdout、stderr、事件、`.hopstate`、`.hoplog` 与其余临时产物；出现 key 原文即失败。
4. 报错只显示环境变量名，不显示值；归档事件前先做 key 脱敏。

## 3. 事件归一与执行体证明【契约】 ^anc-driver-live-e2e-events

共享 runner 只负责进程、隔离、安全和通用断言；CC/Codex adapter 把各自 JSONL 归一为：

```text
carrier_start
subagent_start(role, id)
subagent_stop(role, id)
command(actor, command)
message(actor, text)
carrier_stop
```

`actor` 只取 `main | subagent | unknown`。原始事件保留在内存用于诊断，断言只依赖归一事件，避免把 carrier 私有 JSON 字段扩散到测试主体。

**终态文本断言统一吃 `mainText`（全部主消息聚合），不吃 `finalText`（最后一条）**：载体的 task-notification 补话会后到覆盖最后一条消息——主 agent 先报 completed YAML、补话垫底，看 finalText 即误红。语义断言（该说过什么）与顺序断言（最后说什么）分开。新增场景断言一律 `mainText ?? finalText`。

- 三撞成律：2026-08-10 failure 场景组、2026-08-12 parallel 冒烟（前次修复时该函数漏配）、2026-08-17 cc:delegated（0.4.0 发版档实撞——主 agent 先贴完整 YAML 块、又补发一条『终态 YAML 如上』的收尾消息把块挤出终位；红的两处 delegated 通用路径+anchor-audit 正是本律定形时漏迁移的存量直吃 finalText,本次销清,全部 8 场景归一）。

执行体证明采用**正反两组证据**。**main 写禁令统一豁免 `--answer`**（介入点注入按 skill 协议归 main 本职——paused 的 ask/confirm 应答，subagent 无权问真人；禁的是 main 抢执行链：run 与执行步 submit。豁免同时作用于直接判据与闭合证据两个消费点——只改一处的豁免会外溢/漏放）：

- delegated：优先使用正式 segment start/stop + actor=subagent 的 HopJIT 写命令作直接证据。若 Codex `--json` 不转发 worker 内部事件，则允许等价的闭合证据：main 明确进入 segment wait、actor=main 的**非 `--answer`** HopJIT 写命令数量为 0、隔离工作区却产生且完成唯一 HopJIT instance。
- Codex flash：断言模式自适应三分支——出现正式 segment 时按 delegated 判据验 main 零写命令（同一豁免）；无 segment 但有 wait+main 零非 answer 写命令=闭合证据 delegated；两者皆无时验 inline 判据（actor=main 的 `hopjit run` 恰为 1）。实际演练模式随凭证 `exercised_mode` 上报（delegated/delegated-closed/inline）。
  - 闭合证据分支的出处：codex collab 流只转发 wait 不转发 spawn_agent 的转发缺口形态,2026-08-13 实撞——业务账面已由前置 readTerminalEvidence 核过,证据链完整。
- CC delegated：subagent 事件或带 `parent_tool_use_id` 的 forwarded subagent 内容可证明执行段存在；`hopjit run` 必须归 subagent。

仅有最终业务输出不足以证明 delegated。直接证据和上述 Codex 闭合证据均不成立时，测试失败并报告“观测协议不足”。

## 4. 场景矩阵与退出语义【契约】 ^anc-driver-live-e2e-scenarios

**Codex 委派工具的暴露位置**：复用场景使用 `features.multi_agent_v2.non_code_mode_only=true`，让委派工具直接出现在模型工具面；`tool_namespace="agents"` 保持不变。`codex:flash` 与 delegated 共用这项装配，是否成功派生仍由真实能力决定；standalone 两场景继续禁用多 agent，不注入这项复用配置。

此要求来自载体调用契约：Codex 的多 agent 指令要求直接调用委派工具，禁止把调用放进 `functions.exec`。在 Codex 0.154.0 的本地请求对照中，旧值 `false` 将委派工具只放进 `functions.exec` 的 `tools.agents__*` 声明，直接工具面没有 `agents`，形成互相冲突的调用要求；改为 `true` 后直接出现 `agents` 命名空间的六个委派工具，且不再嵌入 `functions.exec`。配置开关启用不等于工具暴露位置正确，真实 delegated 验收仍是最终判据。

```text
HopType CodexDelegationExposure:
  non_code_mode_only: bool  # true=委派工具直接暴露给模型，不作为 exec 内嵌工具
  tool_namespace: text     # 直接工具的命名空间，复用场景固定为 agents

HopTrait BuildCodexCarrierCommand:
  requires: 场景已通过前置检查
  ensures: 复用场景的委派工具直接可调用；standalone 不启用委派
  preserves: delegated 的 main 写命令禁令与真实委派证据判据

HopSop:
  1. standalone 场景写入多 agent 禁用配置。
  2. 其余 Codex 场景启用多 agent，并指定 non_code_mode_only=true。
  3. 启动真实载体，按原有事件与实例证据验收，不用配置声明代替通过证据。
```

| 场景 | 必须成立 |
|---|---|
| `cc:delegated` | CC 创建 driver subagent；run 归 subagent；引擎 JSON 原样回 main；业务终态通过 |
| `codex:delegated` | spawn 直发成功；正式 segment 被派生；main 不写 HopJIT；业务终态通过 |
| `codex:flash` | **弱模型长程命题场景**（2026-08-08 作者定命题反转：验的是 ds4flash 跑长程任务，不是降级路径）：deepseek-v4-flash 驱动完整业务，工具面与 delegated 一致（不压制不诱导）；**断言模式自适应**——spawn 起得来验 delegated 判据（main 零写命令），起不来验 inline 判据（main 恰 run 一次）；业务终态必须通过；凭证记 `exercised_mode` 供人核实际路径 |
| `codex:demo` | `install-skill --carrier codex --demo` 生成 `$coffee-week`；直接显式调用后进入 hopspec driver 并完成同一业务终态 |
| `cc:call` | **正向 call 场景**（2026-08-11 作者定"做"——call 机制单测已覆盖三层链，缺真机载体端到端信心）：driver 按 call 协议起子实例（`init --parent --step`）驱动子 spec（text-normalize）到 completed，`--child-instance` 回填；父继续消费回填值到 completed 终态。必须成立：父终态 completed + 父实例有 `calls/` 子实例目录 + 回填值真实流转（父 vars 的 `clean_doc` 来自子 spec 的 normalized，summary 基于它生成）+ G11 过程核验（父 HopLog call 步骤 done 块在轨 + 子实例自有 hoplog 完整 completed）。spec fixture 复用教学样例对 `examples/syntax/call-parent-summarize.md` + `call-child-normalize.md`（教学件即测试件——正向场景无需专用失败触发器）。载体 cc（与失败组同 launcher claude-ds）；入 live:core 批（2026-08-14 三档收敛）,不进发版硬闸 |
| `codex:standalone` | 当前固定 exit 2，说明能力尚未实现并指向 TODO；禁止伪装成 inline 通过 |

**失败路径场景组**（2026-08-09 作者定 12345 全做；原单列批量入口,2026-08-14 三档收敛并入 live:core——近期稳定性已与快乐路径持平;**不进发版硬闸**（凭证仍只看双 delegated）；载体统一 cc（driver 协议最全，与 delegated 同 launcher claude-ds）。设计原则：**失败触发全部确定性**（hop_python body 计算异常 / 确定性 check 判据），不依赖"劝 LLM 犯错"——那不可复现）：

| 场景 | spec fixture | 必须成立 |
|---|---|---|
| `cc:repair` | `e2e-repair.md`（coffee-week 变体：组装步 `← last_err` 按其有无加"数据复核"区块；`[check final]` 判据=区块在场，失败时更新模式回填 `last_err`） | 首跑 check 必 fail（last_err 空→无区块）；retry 边界接住；重跑轮组装步读到 last_err 非空→加区块→check 过→completed。核证：终态 completed + HopLog 有 step_failed 与 retry 记录 + 周报含复核区块（反馈流真实流转的产物侧证据） |
| `cc:uncaught` | `e2e-uncaught.md`（平铺 spec：步骤 2 body 对文本输入做数值运算=确定性计算异常；步骤 3 声明在后） | 步骤 2 fail 且无事务边界→实例终止。核证：driver 按契约输出 failed YAML（reason 原文含"计算异常"，不粉饰不重试）；state 里步骤 3 为 skipped（未捕获失败=后续不执行）；步骤 1 产出仍在 vars（fail 不碰值空间） |
| `cc:parallel-partial` | `e2e-parallel-partial.md`（for-each parallel 3 项，child body 对 "bad" 项确定性计算异常） | fan-out 3 worker、1 失败不打断兄弟；join 后收集列表**长度 2**（失败 child 不贡献元素）；下游消费步骤照常拿部分列表（summary=collected=2）；**实例终态 completed**（消费步骤接受部分结果即正常完成——parallel 例外语义的全貌；失败 child 的 FailRecord 在 state 记账可查） |
| `cc:paused` | `e2e-paused.md`（算周营业额→confirm require_human 批准发布） | driver 到 confirm 介入点**停下不替答**：最终输出不含 completed 终态；state 里 confirm 步非终态（done 之外）、published 变量未落值；事件流无 `--answer` 提交命令（负向证据：无头环境下没有真人，任何 answer 都是替答违规） |
| `cc:call-fail` | `e2e-call-parent.md` + `e2e-call-child.md`（子 spec body 确定性计算异常必失败） | driver 按 call 协议起子实例（`init --parent --step`）；子实例 failed 后用 `--failure-child`（机器通道，非 `--failure` 自由文本）回报；父终态 failed 且 reason 含 CalleeFailure 结构（callee spec id/失败步骤/原 reason/fail_kind——内核原封的产物侧证据） |
| `cc:adaptive` | `e2e-adaptive.md`（订单金额汇总——动态格式实撞形态 2026-08-13 作者定：原计划按旧导出格式写 amount 是数字〔合理假设〕,上游格式升级为 {value,currency} 嵌套对象,旧计划对新数据计算异常确定性 fail 两次→adaptive_needed；失败记录里就有新格式真身,新结构取内层 value 再累加） | 修复升级阶梯第 3/4 档的真机端到端（此前零覆盖——第 1 档 cc:repair 已有）。driver 收 adaptive_needed 按契约生成新 children 经 --replan 提交；断言锚协议轨迹不锚计划内容（replan 是真 LLM 生成,"新计划长什么样"有概率性——判据从真实轨迹校准原则）：①HopLog replan_audit 块入轨 ②候选文件 <spec基名>.replan/1.v1.md 落盘且含 @trace ③新 children 有自己的执行块键（真执行过） ④终态 completed（LLM 正解剥单位）或预算耗尽 failed——两收口都合法,轨迹必须完整；⑤终态 completed 时 total=9600（3200+2800+3600,业务侧证据） |

**失败场景同样必须核真过程**（G11 `^anc-meta-layer-test`，2026-08-09 作者指正——首版只查 state/vars 终态即绿，违反守卫链）：每个场景在终态断言之外必须读真实 `.hoplog/*/main.yaml` 核过程轨迹，**尤其 LLM 交互步骤**（check/reason 是 driver LLM 真跑的，轨迹是唯一核真通道）：

- `cc:repair`：`3.2` 失败块在场（reason 含 CHECK_FAILED——LLM 判定入轨）+ **`3.1#2`/`3.2#2` 轮次键在场**（重试真实重跑并二次交互，不是一次跑就绿）+ 尾部 `status: completed`；
- `cc:uncaught`：`2` 的 warn 块（计算异常留痕）+ failed 块（fail_kind/reason）在场；**`3` 无任何块键**（实例终止后未启动）；尾部 `status: failed`；
- `cc:parallel-partial`：父 main.yaml 的 `join:` 块在场，children 清单恰 1 个 failed、2 个 completed（fan-out 真发生且失败已入轨）；
- `cc:paused`：`type: confirm` 起始块在场（走到了介入点）+ **无 `hitl:` 决策块**（没人替答）+ 无 `status: completed` 终态；
- `cc:call-fail`：父 main.yaml 的 call 步骤 failed 块 reason 含 CalleeFailure（跨界失败入轨非仅入 state）。

失败路径场景的凭证同样落 `.e2e-evidence/<scenario>.json`，但 release.sh 硬闸清单不含它们（硬闸仍只看 cc-delegated + codex-delegated 两份）。

**复杂流程场景 `cc:anchor-audit`**（2026-08-09 作者定——coffee-week 太简单，LLM 交互深核需要真复杂度）。**单列命令，不进 e2e:all 默认清单**（LLM 交互点 6-8 次，分钟级+费用高于快乐路径）：

  - 载体选 anchor-audit 而非新造的理由：真业务（G3 语义审计本体，跑坏是真损失）、9 步全类型覆盖（branch/loop+break/parallel collect/subtask retry×3/ask×2/commit/doc-ref 注入）、prompt 判据可从库内真实轨迹校准（.hoplog/anchor-audit-*）；

- **审计对象 = 小 fixture 工程**（`examples/e2e-audit-fixture/`：2 模块 alpha/beta、十来个锚点），不审 hoplogic3 本身（14 模块全量太贵）。2 模块 → 并行恰 2 批。**fixture 埋确定性结构缺陷**（设计锚点无 @a 落点 + @a 引用不存在锚点各 ≥1），审计报告必须抓到——审计工具自身的召回率断言；
- **被测 spec/脚本 = scripts/audit/ 活工具直用**（2026-08-09 作者纠正——"冻结拷贝"是对"避免工具变化影响测试基线"的错误解读，语法演进时工具与样例必须跟着变，双份拷贝只造成同步维护与旧语法豁免口子）：测试判据的稳定性靠**断言只锁不变量**（产物落点 fixture/.anchor-audit、批文件按模块名、埋设缺陷召回、hitl 数量、并行批隔离——全部由 spec 结构决定，工具文案怎么改都不动摇）；工具的结构性改动令 e2e 红了正是守卫在工作，修断言是显式动作；
- **ask 介入点处置**：步骤 2（确认范围，无 require_human）允许 driver 代答 approve；步骤 7 经 prompt 嘱咐选 report_only——e2e 只读，不进 anchor-fix 写路径（commit/loop 修复段不在本场景覆盖内，spec 静态面由 validate 兜底）；
- **终态断言**：completed + report.md 与 semantic_audit_summary.yaml 落盘 + batch_alpha/beta_results.yaml 按模块名在场 + report 含全部埋设缺陷（召回）；
- **prompt 深核**（LLM 交互正确性第 2 层——引擎喂给 LLM 的东西对不对；判据从真轨迹校准，形态见 main.yaml debug 级 llm.prompt 块）：
  1. **并行批隔离**：worker 子日志（`parallel/5.2.N/log/*/main.yaml`）的 prompt 里 batch 只含本模块名，**不得出现另一模块名**（隔离声明真落实）；
  2. **doc-ref 注入在场**：语义审计步 prompt 含 `═══ L2d` 段与 `（命中标题：语义审计维度判据）` 等命中标记——知识切片真进了上下文；
  3. **数据流正确**：4.2 reason 的 prompt 含 cross_compare_results.yaml 路径（前序产物真传导）；
  4. ask 代答入轨：main.yaml 步骤 2 有 hitl 决策块（决策可审计）。

**通过场景轨迹归档（passes/）**（2026-08-09 作者质疑"都没留档，谁核对的"——runner 焚毁前核过，但核对不可事后复核=审计链断最后一环）：**所有场景**通过时，焚毁 workspace 前把 `.hoplog/`+`state.json`（key 脱敏，同失败归档判据）归档到 `.e2e-evidence/passes/<scenario>-<UTC时间戳>/`。

- 每场景保留最近 3 份，旧的删——兄弟判定=slug 后紧跟时间戳，不得裸前缀匹配（实撞 2026-08-12 真机：cc-call 裸匹配会把 cc-call-fail-* 算兄弟,数字排字母前,新归档被当最旧当场删除,凭证指向空目录）；
- 凭证 JSON 增 `evidence_archive` 字段指向归档路径。"通过"由此可抽查——人随时能看任何一次绿背后的真实轨迹；
- passes/ 入 .gitignore（同 failures/）。

退出码固定：

- `0`：所有协议、安全与业务断言通过；
- `1`：carrier 已启动，但进程、事件、终态或泄露断言失败；
- `2`：运行前置不满足（命令不存在、构建产物缺失、凭证缺失、standalone 尚未实现、参数无效）。

## 5. 终点凭证与发版硬闸【契约】 ^anc-driver-live-e2e-evidence

上游原则：[[../concepts/工程实现链-守卫规范#^anc-guard-e2e-primacy]]（守卫链终点=e2e 实测+hoplog 分析确认；终点凭证是 release 硬性准入闸）。本库落地：

- **凭证落盘**：场景通过（协议+安全+业务+HopLog 轨迹断言全绿）时，runner 自动写 `.e2e-evidence/<scenario>.json`——含通过时 HEAD commit、时间戳、凭证环境变量名。只有通过动作能写出凭证，人工不可伪造"通过"；
- **release 硬闸**：`release.sh` ④ 无条件核验 `cc-delegated` + `codex-delegated` 两份凭证**在场且指向当前 HEAD**——缺失/过期（实测后有新提交）即中断，续发/半截态同样不豁免（publish 是不可逆点，闸必须无条件站它前面）；
- **诞生实撞**（2026-08-08）：RELEASING 手册写着"发版前双绿"，但 release.sh 十一步里没有这一步——agents frontmatter 缺失导致的 provider 400 真回归差点带版发出。手册纪律无机检=会被跳过（守卫规范原则 2"行为纪律必须有产物侧信号"的范例）。

## 6. 自动化入口与 CI 时机【契约】 ^anc-driver-live-e2e-entry

**真机覆盖率测量（2026-08-15 作者令"所有的真机测试应该度量总覆盖率"）**：三档 shell 统一开关 `HOPJIT_COVERAGE=1`——设 `NODE_V8_COVERAGE=$(mktemp -d …/hopjit-cov-<tier>.XXXXXX)`（V8 原生,零新依赖）,env 自动传播到该档拉起的**全部 node 进程**（CLI/mcp-server/parallel worker 子实例——真机档是多进程拓扑,逐进程各落一份覆盖 JSON）。
档尾 `scripts/coverage-report.mjs` 合并报告 dist/*.js 行覆盖（任一进程触达即算,按覆盖率升序列文件）。

- **覆盖目录必须在系统临时区**——codex 沙箱内子进程写不了仓库路径。实撞出处（0.4.0 发版）:EPERM 写仓库内覆盖目录混进 stdout 污染 subtask 输出流,demo/delegated 双红——env 传播是特性,传进沙箱就要用沙箱可写面;
- **语义=「这一档真机跑触达了引擎多少行」,未触达行=该档测试面的盲区清单,不是质量分**——与 vitest 单测覆盖率（check:coverage 基线闸）测的面不同不可比,亦不设阈值闸（真机档场景驱动,钉阈值=逼人塞场景凑数;盲区消化按报告分诊）;
- 缺省关闭零开销（不设 env 即原行为）。

统一入口是 `scripts/carrier-live-e2e.mjs`。npm 提供命名场景与**三档批量**（2026-08-14 作者拍三档,对齐守卫规范 5c 成本分档 `^anc-guard-e2e-tiering`——原 e2e-all/failure/audit 按内容分批与 5c 成本维度打架,收敛为单一维度）：

| 档 | 入口 | 内容 | 成本/时机 |
|---|---|---|---|
| **例行档** | `test:live:smoke` | 四 smoke（tools/mcp-binding/multi-run/biginput——零/单 LLM） | ~2min,改引擎后随手跑,天天跑得起 |
| **发版档** | `test:live:core` | 9 快乐路径 + 6 失败路径（15 场景,两波:13 并发 5+standalone 系串行） | ~13min,发版前必跑;凭证判据不变（硬闸仍只看双 delegated） |
| **触发档** | `test:live:deep` | audit 深核 + buildtest hopbuild 自跑 + flash 弱模型长程（三件并发——各自独立 workspace/flash 走 --ephemeral 非 standalone 不写全局配置,零共享可变面;总时长≈audit 瓶颈;可传参选跑单件） | 贵;测 LLM 质量面非引擎正确性——改 prompt 组装/doc-ref/parallel worker 上下文→audit;改 primer/hopbuild spec/语法→buildtest;改能力门/弱模型协议→flash |

**分档判据**：smoke=引擎-工具-server 真机面（无载体进程）；core=载体协议与执行链**正确性**（含失败语义——failure 组并入 core:近期稳定性已与快乐路径持平,分居两入口造成"发版前跑了 all 忘了 failure"漏格面）；deep=**LLM 质量面**（深核判定/文档教学力/弱模型长程可靠性——不随引擎小改回归,按触发条款跑）。flash 从原 all 批迁 deep（它测的是 ds4flash 命题非协议正确性;不在硬闸,迁移零凭证影响）。

**deep 档成员协议注记——hopbuild 自跑（buildtest,2026-08-18 作者定"替换"盲测）** ^anc-driver-live-e2e-primer

**被测物=hopbuild 全链**：spec.md 流程机器 × hopbuild-primer 统一知识源在**真实消费形态**下——引擎驱动、doc-ref 切片注入、validate 工具自校验、retry 闭环全在场。触发条件：改 primer/spec.md/语法后跑。

前身 primer 盲测退役（scripts/primer-blindtest.mjs → docs/obsolete/）。退役理由：盲测=零先验 agent 整包通读 primer 徒手翻译——该消费形态在单源汇聚后不存在（41KB 知识库是切片消费件非自包含教程,真实执行链每步只经 doc-ref 锚取所需节）,测法失真:超时与 error 分不清是教学缺陷还是整包灌造成;语法演进回归由自跑天然覆盖——primer 教错写法→构建循环产物就错→validate/对账红。

核心协议五条：
1. **驱动=无头 mcp**：scripts/hopbuild-selftest.mjs 直驱 HopjitMcpCore——startRun(skills/hopbuild/spec.md)→轮询 run_status→paused 逐个注入（skill_path 答样本路径/头部呈审答通过/终审 ask 答放行;require_human 在测试语境由 harness 作答,测翻译质量非人审环节）。
   - **模型分档路由**：routing_rules 只把 commit 路由快档 deepseek-chat,其余留强档 v4-pro;
   - 实撞收回（初版 act 也入快档）:act 双形态——带 hop_python body 的引擎直执零 LLM 调用路由无关;无 body 的 act 是工具循环文本加工〔读原文/植锚/并入草稿/组装审阅件〕恰需能力,chat 档把说明散文塞进 draft_path 值→下游 read 报 Path traversal 毒值;真机械且走 LLM 的只有 commit 写盘。教训:"机械步"要按有无 body 分,不按步骤类型分;
2. **样本=三例轻档并行**（作者定 2026-08-18）：mini 遍历+不可逆（for-each/commit）/branch 分档+人审（branch/case/confirm 把关链）/verify 核验闭环+裁量（check final/retry/ask）——各覆盖一组要素,轻档单轮直达量级几分钟。
   - 并行=子进程隔离,每例 spawn 自身 --fixture 单跑（doc-ref 按 run 组合根 cwd 解析,进程内并行 chdir 必串台）;ticket 三焦点全踩重档题留 --fixture 手动深跑,fixtures 全入 scripts/fixtures/;
   - **短档入口 `test:buildtest:mini`**=单跑 mini 例 30min 上限——迭代修复期先验通不通再上三例,不替代三例档作触发凭证;
3. **判分两件**（不采信 agent 自评;锚点对账判分随缓装退役 2026-08-20,见 [[hopbuild]] 锚点体系缓装条款）：产物 spec validate 零 error + source.md 纯副本真落盘（内容与 fixture 原文对得上）;
4. 退出码服从 0/1/2 契约;
5. 轮次历史归档沿用（.e2e-evidence/ 时间戳惯例）。

**旧入口处置**：`test:e2e:all` 转别名=live:core（发版场景批——flash 迁 deep 是明载语义变化,凭证面零影响）；`test:e2e:failure` **删除**（失败组已并入 core,保留假别名会把 6 场景语义骗成 16——文档指路 live:core）；`test:e2e:audit` 原样（=deep 的 audit 单项）。单场景入口全部不变。旧批量脚本 e2e-all.sh/e2e-failure.sh 删除,历史归 git。

原始清单（单场景与历史注记）：

```text
test:e2e:all              # 批量全场景：构建一次,任务池并发 5（HOPSPEC_E2E_CONCURRENCY 可调,
                          # 完成即报无稳定顺序;并发条款 ^anc-driver-live-e2e-concurrency）,
                          # 全量日志→.e2e-evidence/logs/，汇总落 run-*.summary.txt，
                          # 末尾报两份发版硬闸凭证状态；退出码=失败场景数
test:e2e:cc:delegated     # cc 场景在 e2e-all 中固定 --launcher claude-ds（zenmux 环境
test:e2e:cc:delegated:ds  # 由 shell 函数配置，裸 claude 会 401——2026-08-08 实撞）
test:e2e:codex:delegated
test:e2e:codex:flash      # 弱模型长程命题：ds4flash 完整业务，模式自适应
test:e2e:codex:demo       # （2026-08-08 命题反转，原 codex:inline 场景废除）
test:e2e:codex:standalone
test:e2e:standalone:biginput  # standalone 大输入内联核证（BUG-H mock 盲区格,1 次 LLM 例行档——
                           # 哨兵事实回读+input_tokens 量级+prompt 面零 $file）
test:smoke:tools           # 工具三通道统一冒烟（内置组/in-process 扩展/mcp 真百炼——
                           # 零 LLM,mcp 面缺凭证跳过明说;改引擎后快验全部工具通道）
test:e2e:cc:parallel       # 并行冒烟单跑（cc 走 claude-ds;三个 parallel 场景单跑入口
test:e2e:codex:parallel    # 2026-08-12 补——此前只在 e2e:all 批量内可跑,单场景重跑无入口）
test:e2e:codex:standalone-parallel
（test:e2e:failure 已删——失败六场景并入 live:core,2026-08-14 三档收敛）
test:e2e:audit             # 复杂流程场景 cc:anchor-audit（LLM 交互深核主载体，费用高，
                           # 改 prompt 组装/doc-ref 注入/parallel worker 上下文后必跑）
```

由 [[chain-enforcement#^anc-meta-guard-trust]] 推演，runner 自身必须有确定性测试，至少覆盖 JSONL 容错、事件归一、执行体断言、**真实 HopLog YAMLL 过程轨迹的正/负向核验**、缺 key exit 2、key 泄露红灯、超时清理和失败诊断脱敏。

**批量并发（2026-08-14 作者定并发度 5）** ^anc-driver-live-e2e-concurrency

批量入口（e2e-all/e2e-failure）按**任务池并发 5** 跑场景——串行 14 场景 ~25min 是纯等待浪费,各场景隔离面已足：工作区独立 mkdtemp/凭证 JSON 与 pass 归档文件名带场景 slug 零撞/codex `--strict-mcp-config` 隔离全局配置。**共享面与约束**：

1. 构建一次前置（各场景 runner 不再各自 build——并发重建 dist 互踩是唯一硬冲突源之一,批量脚本负责先 build,场景命令去 build 化）；
2. provider 限速共担（并发 5 是费用/限速的经验平衡,撞 429 时降并发重跑）；
3. 屏幕输出改"完成即报"（并发下无稳定顺序,每场景完成时打一行,汇总不变）；
4. **发版硬闸凭证判据不变**（写盘原子,凭证 commit 核对与并发无关）；
5. **codex 全局配置面互斥波次（2026-08-14 并发首跑实撞）**——codex:standalone 系场景经锚定块**持久注册 hopjit MCP 到用户 ~/.codex/config.toml**（codex exec 不为 -c 注入 server 起进程,持久注册是唯一通路;跑完删块）。
   - 实撞形态:与其并发的 codex:delegated/flash 会看见邻居的临时注册,skill §0 第一判定'list_runs 调通=STANDALONE 锁定'**正确地**走薄协议→delegated 断言红（driver 零责任——全局配置就是 codex 场景绕不开的共享可变状态,codex 无 --strict-mcp-config 等价物）。
   - 修法=调度层互斥：批量脚本分两波,波 1=全部非 codex-standalone 场景并发,波 2=codex:standalone 系**串行**（两 standalone 场景的 register 先 remove 再 append 同一锚定块——同波并发时 A 的注册被 B 覆盖,HOPJIT_CONFIG 指向对方临时配置,同波也互斥）；cc 场景有 --strict-mcp-config 隔离不受影响。单场景入口不变仍串行语义。

Live E2E 有外部网络、模型费用与 provider 波动，故不进入默认 `check`。它在以下时机显式运行：

- 修改 `driver/**`、carrier adapter、能力门或 install-skill 后，本地至少跑受影响场景；
- 发布前跑 CC delegated + Codex delegated；若改 fallback 或弱模型协议，再跑 Codex flash；
- CI 仅在带凭证的手动 workflow / protected environment 中 opt-in，缺 secret 必须让该 job 失败，不得标 skipped。

## 7. 断言在链与存档重放【契约】 ^anc-driver-live-e2e-assertions

上游原则：[[../concepts/工程实现链-守卫规范#^anc-guard-assertion-on-chain]]（5a 判卷者也在链上——断言是契约消费者，须挂锚可收链、可离线重跑）。诞生实撞（2026-08-11，G13 立账）：cc:parallel-partial 断言存旧通道账面形状假设"父 step_states 恰 1 failed"，统一模型迁移改遍全库唯它幸免——零锚点收链收不到、不进 vitest 改漏不红，潜伏到作者手工真机才暴露。

**断言挂锚（HopType）**：`carrier-live-e2e-lib.mjs` 每个场景断言函数头注释挂 `@v: <其消费的契约锚点>`——改哪个契约，grep 该锚点即命中对应真机断言（与 vitest 测试同一收链通道）。语义审计扫描面：scan.py `--aux-test-dirs scripts`（@v: 扫描面扩到 scripts/，与 @a: 的 aux-src-dirs 对称）。

**存档重放守卫（HopSop）** `check:e2e-assertions`：

```
# Spec: e2e 断言存档重放
Id: e2e-assertion-replay
Goal: 契约演进改动账面形状时,真机断言的陈旧假设离线即红,不潜伏到下次真机
Steps:
1. [act] 收集 .e2e-evidence/passes/ 归档（脱敏 .hopstate+.hoplog,通过时真实形状）
2. [loop for-each 归档] 按场景名调用对应断言中可离线重放的部分
  2.1. [act] 以归档目录为 workspace 干跑断言函数
  2.2. [branch] 断言抛错
    2.2.1. [case(旧形状假设失效)] 红——断言与契约漂移,修断言或确认契约回归
3. [exit] 全绿=断言与当前代码的账面形状仍一致
```

- **重放面=账面断言**（state/vars/HopLog 形状——归档里有的）；事件流断言（normalized/finalText 依赖 carrier 进程）不在重放面，缺席跳过该部分不装通过；**业务工作区面同不在重放面**（passes/ 归档只收 .hopstate/.hoplog——cc:adaptive 的候选文件检查在 workspace/examples/ 下,offline 分支跳过;2026-08-14 补 adaptive 入重放清单实撞:三份归档全红在此子断言,跳过后其余账面断言〔replan_audit/块键/终态〕非空,不违『真空绿』禁令）；
- **每场景断言必须含非空账面部分**——全部判据都是事件流/终态文本的断言，offline 重放必真空通过=装通过（诞生实撞 2026-08-12 review：standalone/standalone-parallel 两断言零盘面读取，重放 39 份归档"全绿"里六份是真空绿）；新增场景断言时账面部分与事件流部分成对；
- **归档缺席=跳过并明说**（本地新 clone 无归档不红——归档是 gitignore 的本地资产；有归档才有重放义务）；
- **凭证指针核验**：每份凭证 JSON 的 `evidence_archive` 指针必须指向在场目录——归档被误删时凭证还挂着"可抽查"的空承诺,离线即红（2026-08-12 归档蒸发实撞后加固）；指针字段缺席=旧格式凭证,跳过不红；
- **时机**：入 `check`（≈秒级,纯本地读盘）；不入 `check:fast`。

## 8. 沙箱等价台账【契约】 ^anc-driver-live-e2e-equivalence

> **mock 盲区反向义务的本库落点** ^anc-guard-mock-blindspot：概念权威 [[../concepts/工程实现链-守卫规范#^anc-guard-mock-blindspot]]（5b-2 五步作业协议）。本表"真机不可替代环"列即失明面登记处——每引入 mock 时把它对什么失明写进对应行；指不到真机场景的失明面=矩阵缺格,补场景或立账。首例=standalone-biginput 行（BUG-H:mock LLM 不消费 prompt,指针/真值不辨）。

上游原则：[[../concepts/工程实现链-守卫规范#^anc-guard-sandbox-equivalence]]（5b 真机只留不可替代的那一环）。逐 live 场景登记其可沙箱化语义的 vitest 等价用例；**新增 live 场景必须同步登记本表**（G14 销账落点）。不可替代环=载体进程行为/真凭证/真模型交互。

| live 场景 | vitest 等价（沙箱侧已覆盖的语义） | 真机不可替代环 |
|---|---|---|
| cc:delegated / codex:delegated | engine/cli 全链（engine.test/cli.test）、prompt 组装（prompt-assembler.test） | 载体真实驱动协议（谁执行了 hopjit run）、真模型交互 |
| codex:flash | 同上;心跳判死即行动指令判据 = guard-scripts.test 三反例（禁再wait/空真短路/言行自检 token 丢失即红） | 弱模型长程可靠性（HOP 核心命题,无沙箱等价物）——含对判死即行动指令的真实遵循 |
| codex:standalone / cc:standalone | mcp-server.test（startRun/status/resume 全链）、dispatcher.test（独立模式步骤执行） | 载体 MCP 注册与薄协议驱动、真模型 |
| codex:standalone-parallel | dispatcher/engine 并行语义组、mcp-server 并行视图 | 同上叠加 server 进程内真并发 |
| cc:parallel / cc:parallel-partial | engine.test 退化失败集合语义组+统一模型 reap 记账、cli.test 跨进程闭环 | 载体多 worker 真实驱动 |
| cc:repair / cc:uncaught / cc:paused / cc:call-fail | engine.test 失败语义组（retry/terminal/confirm/CalleeFailure）;续接交接契约 = guard-scripts.test 判据回归（<PENDING> token 正1反2） | 载体面对失败信号的真实行为（不粉饰/不替答/不绕协议）;续接 subagent 拿 <PENDING> 直接执行不盲驱（2026-08-13 实撞后 cc:adaptive/cc:paused 是续接形态的真机核证） |
| cc:call | engine/cli call 协议组（auto-map/depth/回填） | 载体驱动子实例的真实过程 |
| cc:anchor-audit | scan/cross_compare 确定性测试 | LLM 语义判定质量（无沙箱等价物） |
| tools-smoke（零 LLM,三通道统一入口） | 同下两行的 vitest 等价并集 | mcp 面同 mcp-binding-smoke;内置/in-process 面无真机不可替代环（本地快验入口价值,非新增覆盖） |
| mcp-binding-smoke（零 LLM） | tools-mcp-binding.test 30 例（InMemory 真协议+stdio 真 spawn+HopjitMcpCore 缝+InProcessBinding 全链——in-process 通道无网络无凭证,vitest 即完整覆盖无真机不可替代环） | 真百炼服务的 wire 形状（json-in-text/未开通形态/顶层值类型与真实返回相容） |
| multi-run-smoke（零载体,真 server+真 LLM） | mcp-server.test 崩溃回归+串台回归（core 对象层:故障 run 隔离/快照互不可见/深拷贝） | 真 stdio server 进程的多 run 并发生存性——单进程同时两 run 到各自终态/进程存活/stderr 零漏网标记（2026-08-14 实撞形态的直接真机对应物;vitest 是 core 对象层,压不到真进程边界与真异步派发交错） |
| standalone-biginput-live-e2e（零工具,1 次 LLM,例行档） | dispatcher.test BUG-H 注入面三例（prompt 文本含真值零 $file——mock 能验注入面） | **mock 盲区格**（^anc-guard-mock-blindspot 首例）：mock LLM 不消费 prompt 内容,指针/真值不辨——真 LLM 对大输入的真实消费（哨兵事实回读+input_tokens 量级+HopLog prompt 面零 $file;BUG-H 实撞时全测试面零覆盖的"standalone×超阈"格） |
| standalone-tools-live-e2e | 同上缝测试（config→startRun→body→completed）;分级路由/软偏好落级/Config 段 dash 体例 = dispatcher.test 路由组+软偏好 5 例、parser.test dash 归一 3 例、mcp-server.test 两级合并+文法组 | LLM×外部工具同 run 真协同;分级路由+软偏好在真 run 全链的激活（spec 偏好 ghost service→warn 落系统分档,run 照常 completed——2026-08-13 扩,首跑即抓出 reason 步 warn 不落盘 bug） |
