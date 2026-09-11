%% @trace
	id: hopjit-roadmap
	source: [[../concepts/HopSpec V3配套HopJIT运行时能力]]
	source_id: hopjit-runtime
	type: extend
	last_sync: 2026-07-04T18:23+0800
	note: HopJIT 里程碑路线图——v1/v2/v3 具体特性清单。判据（里程碑是什么、当前 v0、偏差三义）权威在概念层 ^anc-exec-milestone，本文件是"义1 里程碑分期"的集中落点（与 TODO.md DEBT 台账对称）。特性随实现演进，随时更新。
%%

# HopJIT 里程碑路线图

> **判据权威在概念层** [[../concepts/HopSpec V3配套HopJIT运行时能力#^anc-exec-milestone]]：里程碑是什么、与 semver 正交、偏差三义分流，都在那里。本文件只列**各里程碑的具体特性清单**（"义1 里程碑分期"的家，与 todo/ 卡目录的 DEBT-* 台账对称）。
>
> **当前状态：v0（开发中）**，semver `0.1.0`。复用模式已端到端跑通，正朝 **v1（第一个可发布里程碑）** 推进。

## 版本轴速览

| 里程碑 | 一句话定位 | semver 关系 |
|---|---|---|
| **v0（当前）** | 复用模式跑通，能力补完中 | `0.x`（未发布、接口未承诺稳定） |
| **v1** | 把复用模式做扎实——能力完整可对外用 + 接口稳定 | 达成即升 `1.0.0` |
| **v2** | 独立模式 + 能力上台阶 | `1.x` |
| **v3** | 生态层（多 HopAnt / HopType 协作） | `2.x+` |

---

## v1 — 把复用模式做扎实（第一个可发布里程碑）

**定位**：复用模式（CC 作推理 LLM + 提供工具，引擎纯流控）端到端**可靠可用**，接口稳定到敢升 `1.0.0`。独立模式整体推 v2。v1 的工作 = 补完当前欠的债（`TODO.md` DEBT-01~10）+ 收尾，**不引入独立模式新架构**。

### v1-1 持久化健壮性
- ~~checkpoint.json~~ **已撤销**（2026-08-10 作者裁决：重进暂停机制即正式契约，重算优于快照——[[exec-engine#^anc-exec-pause-persist]]）。
- **单文件原子快照**（[[todo/0002_DEBT-06-saveSnapshot双写崩溃窗口_open|DEBT-06]]）：消除 saveSnapshot 双写崩溃窗口。
- **host_context 子集恢复**（原 DEBT-05 的 v1 部分，已收口）：doc-ref 必需的 `workspace_dir`+`sandbox` 非敏感子集已进 state.json；复用模式完整凭证由 caller 环境提供，故 v1 无需完整 HostConfig 恢复。**完整 HostConfig 恢复归 v2**（独立模式 Provider 绑定，见 v2-1）。
- ~~paused_at 超时机制~~ **已取消**（作者定 2026-08-10：暂停超时概念彻底取消——超时自动处理=替 caller 决策，且 CC/Codex 载体无后台计时者；paused 永久有效，实例终结归部署层 GC。见 [[step-dispatcher#^anc-exec-pause-timeout]]）。

### v1-2 观测完整（HopLog）
整体进 v1（[[todo/0003_DEBT-09-HopLog-llm-response未记录_open|DEBT-09]]）——复用模式可用性要求审计能重建全貌：
- 嵌套执行树（容器 children/iterations 结构化，不再平铺）
- 卫星文件（parallel/call 并发分支独立 yaml）
- `llm:` 完整交互记录（system/prompt/response）
- `knowledge:` 流控字段（reason 知识访问）

### v1-3 上下文与校验收尾
- **L1 完整执行树**（[[todo/0004_DEBT-10-L1-执行树选择性展示_open|DEBT-10]]）：按 token 预算渐进展开，补上"综合全局型"推理所需的非依赖步骤产出。
- **init 前置校验**（[[todo/0001_DEBT-01-init期resource_limits前置校验未实现_open|DEBT-01]]）：加载期静态估算 token，超模型窗口即拒，不跑到中途才 BUDGET_EXCEEDED。

### v1 达成判据
复用模式跑真实多步 spec（含 parallel、call、HITL、doc-ref）稳定可靠；审计日志可完整重建执行；接口面（CLI 命令 + JSON 响应 + `.hopstate` 格式）冻结到敢承诺兼容 → 升 `1.0.0`。

---

## v2 — 独立模式 + 能力上台阶

**定位**：引擎从"复用模式流控器"升级为"可自驱的完整执行器"，并补上单引擎能力短板。

### v2-1 独立模式（引擎自驱）
- ~~**独立模式真并行**~~ ✅ 2026-08-10 落地（dispatcher Promise 满额滑动窗口池，复用引擎批收集/join 三机制，`^anc-exec-standalone-parallel`；暂停点排除谓词随动补 ask）。
- ~~**独立模式 call 递归**~~ ✅ 2026-08-10 落地（Dispatcher 嵌套递归 + confirm 经 call_path 直达 + engine 侧 Inputs 自动映射 + 运行时 call-depth 检查，`^anc-exec-call-recursion` / `^anc-exec-call-auto-map` / `^anc-exec-call-depth-check`）。
- ~~**SpecProvider 实装**~~ ✅ 2026-08-10 落地（缺省 DirSpecProvider 调用方同目录寻址，`^anc-provider-spec-default`）。
- **IdentityProvider 实装**（`^anc-provider-identity`）：外部命名服务调用的凭证管理（get_credential/list_services + 多服务环境变量扫描）。
- ~~**完整 HostConfig 恢复链**~~ ✅ 2026-08-10 落地（宿主 resume 时重新注入，`^anc-mcp-run-restore`——Provider 不落盘）。
- ~~**token 跨进程持久化**~~ ✅ 2026-08-10 落地（cumulative_tokens 入 state.json，resume 回填）。
- ~~**last_replan_children 持久化**~~ ✅ 2026-08-10 落地（入 state.json——复用模式每命令独立进程本就跨进程，检测两模式生效）。

### v2-2 HopAnt 第四维度
- **DataProvider**：HopAnt Data 维度从 vars.json 隐式承担中拆为独立 Provider。

### v2-3 运行时基础设施
- **验证环境**：act 步骤的沙箱执行方案（容器化 / 进程隔离 / 虚拟执行）。
- **知识库索引与检索策略**：KnowledgeProvider 的向量/关键词/混合检索落地。
- **token 预算管理策略**：从当前保守固定值（4000）升级为按模型窗口动态管理（配 prompt-assembler 调参项）。

---

## v3 — 生态层（多 HopAnt / 协作）

**定位**：从"执行单个 Spec/单个 HopAnt"升级为"多个有身份的 Agent 组件协作"。依赖上游概念层三块阻塞先解（见 [[HopAnt概念-双态组件模型]] / [[../concepts/HopType体系]]）。

### v3-1 HopAnt 完整实例化
- **实例化机制**：把四个 Layer（Knowledge/Capability/Data/Identity）绑成可运行 HopAnt 实例——配置驱动（YAML 声明）vs 代码构造，倾向配置驱动（[[HopAnt概念-双态组件模型]] 阻塞项）。
- **call 寻址扩展**：`call` 目标从 Spec Id 扩为 HopAnt 实例的 Spec（`call cyant_id.spec_id` 点号语法，需 SpecParser 扩展）。
- **Layer 间错误传播**：credential null / retrieve 失败降级 / Layer 初始化失败 fail-fast 的统一语义。

### v3-2 HopType 协作与 Spec 库
- **HopType 协作模式**：协商 / 竞争 / 委托（[[../concepts/HopType体系]]）。
- **能力发现与匹配**：Agent 按能力被发现、被编排。
- **Spec 库存储与检索协议**：Spec 的存储格式、版本演进、检索协议（配有序思考渐进固化闭环）。

### v3-3 有序思考渐进固化闭环
- 候选 → 验证 → 沉淀的自动化判定（多少次成功算"验证通过"）、介入记录结构化存储、spec 版本演进（[[../concepts/HopSpec V3扩展-有序思考与渐进固化]]）。

---

## 作者体验工具（跨里程碑，非引擎能力）

- **hopbuild skill**（自身为自然语言 skill，`.claude/skills/hopbuild/`）：把一个自然语言 skill 翻译成 HopSpec 规约（hopskill）。价值 = 把自然语言原文里"靠 LLM 记住"的纪律升级为引擎结构化强制，三焦点：循环不漏（for-each）、审核不跳（confirm 人审 + check 产出核验）、试错不 commit（act 可逆 / commit 隔离）。**纯 skill 层、零引擎改动**，故不占里程碑特性槽——它是**创作侧作者体验工具**，与 anchor-audit / hopspec 同层。golden sample：`scripts/audit/test-coverage-audit.md`（由 test-coverage-audit 自然语言 skill 经 /hopbuild 翻译，validate 通过）。

## 归属存疑项（待随实现确认）

以下特性归档时有边界模糊，实现推进到时复审：
- **token 预算动态管理**：v1 用保守固定值够跑，动态管理归 v2；但若 v1 真实 spec 频繁触窗口上限，可能提前。

> 已定归属（2026-07-02）：**host_config 完整恢复**（DEBT-05）、**last_replan_children 持久化**（DEBT-03）经作者判定为纯独立模式/跨进程关切，复用模式（v1）用不到，已明确归 **v2**。判据：复用模式凭证由 caller 环境提供、replan 全程同进程——两项在 v1 无触发场景。

> 归属调整时，同步更新对应 DEBT 条目的"触发条件"与本文件；判据不变（仍按 `^anc-exec-milestone` 三义分流）。
