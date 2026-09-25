%% @trace
	id: hopjit-llm-error-handling
	source: [[../ARCHITECTURE]]
	source_id: hopjit-design
	type: extract
	last_sync: 2026-09-26T00:02+0800
	note: LLM 节点错误处理机制总览（2026-08-31 作者要求"应该有汇总的 design doc,设计上要考虑到 subtask-retry 完整的生命周期,以及 llm prompt 组装"——lack_of_info 死路等三路排查实证:教条面/解析面/承接面三份文档各自为政,没有一张图画出失败信号从模型嘴里到 failStep 的完整旅程,每一环的作者都以为别的环接住了）。枢纽文档:各机制权威留原锚点原位,本文只汇总。体例同 tool-channels。
%%

# LLM 节点错误处理机制总览

> **模块版本**：llm-error-handling `v0.2.1`（2026-09-26）。本版=旅程表第 4 关补"正文疑似工具调用"附加提示一句（todo/0110 probe 3）。枢纽文档——本文只汇总不定义，各环节条款权威在原锚点；冲突以权威为准。**逐版演进史归 git log**。

## 文档结构与内容分级

| 分级 | 含义 | 审计要求 |
|------|------|---------|
| **【契约】** | 带 `^anc-*` 锚点的技术约定 | 代码/测试必须对齐 |
| **【说明】** | 汇总表、旅程图、对照 | 与各权威一致即可 |

| 章节 | 分级 | 锚点 |
|------|------|------|
| 失败信号的完整旅程（一张表） | 说明（权威在各锚） | — |
| lack_of_info 通道全链 | 契约 | `anc-exec-lack-of-info-chain` |
| subtask-retry 生命周期与供给面 | 说明（权威在各锚） | — |
| fail_kind 语义表 | 说明 | — |
| 已知雷区台账 | 说明 | — |

## 为什么要这份文档【说明】

2026-08-31 三路排查（reason/commit/ask-confirm-call）实证的结构性病根：**一个失败信号要活着走完"模型输出 → 解析 → 分流 → 承接 → 记账 → 重试供给"六站，每一站的条款住在不同文档里**（prompt-assembler 管教条、step-dispatcher 管解析与算子重试、exec-engine 管校验与升级链、shared-errors 管错误码），没有任何一份文档对整条旅程负责。

- 实锤形态：lack_of_info 教学在发（prompt-assembler）、承接在场（exec-engine 早判+dispatcher 分流），但**解析站把键杀了**（parseStepOutput 按声明 schema 收键，设计写了"自动追加可选字段"没人实装）——三份文档各自都"对"，链条整体是死的；
- 本文的职责：把六站画在一张表上，每站标权威锚，新增/修改任何一站时先来这里看上下游。

## 失败信号的完整旅程【说明——each 站权威在锚】

LLM 响应从收到到定稿，按序过以下关卡。**每一关只有三种出口：放行到下一关 / 触发重试（算子级或容器级）/ 定稿失败（failStep 带 fail_kind）**——不存在第四种"静默消失"（任何吞信号的行为都是缺陷）。

| # | 关卡 | 拦什么 | 拦住后走哪 | 权威 |
|---|---|---|---|---|
| 1 | **截断闸** | stop_reason=max_tokens（thinking 烧穿/工具参数半截） | 抛 OUTPUT_TRUNCATED → 算子级重试 | [[step-dispatcher#^anc-exec-output-truncation-loud]] |
| 2 | **解析阶梯**（parseStepOutput） | 形态噪声：围栏包裹/散文导语+围栏/散文+裸 YAML 尾部键块/思考散文+尾部自标签；**全空响应**（第四形态,方向相反——内容真缺不放行） | 全空 → 抛 EMPTY_OUTPUT 算子级重试（`^anc-exec-output-empty-loud`）；形态噪声三档单解+单输出尾部收窄，解出即放行（内容完好提取层不判死）；解不出回退逐行，仍无 → 键落 null 进 4 | [[step-dispatcher#^anc-exec-output-fence-content-retry]] / `^anc-exec-output-tail-yaml-retry` / 单输出自标注 `^anc-exec-output-parse-self-labeled` |
| 3 | **语义性自报分流**（两通道：lack_of_info 仅 reason / tool_failure 归 reason+无 body act） | 模型自报"信息不足无法推理"（lack_of_info：材料本来就缺）或"工具故障无法完成本步"（tool_failure：取材料/干活的手段坏了——语义分界，两键不互替） | lack_of_info——standalone：有 knowledge_provider → 补充检索重跑一次，仍缺 → failStep(kind='lack_of_info')；无 provider → 直接 failStep(kind='lack_of_info')。tool_failure——两模式恒 failStep(kind='tool_failure')（承接=容器缺省重试治瞬时故障，无检索半边）。两通道同点：standalone 解析前置探测（extractSelfReportKey 公共体，键活过解析站）+ engine.completeStep 早判（先于 schema 校验）→ failStep 携各自 kind | lack_of_info：本文 `^anc-exec-lack-of-info-chain`；tool_failure：[[step-dispatcher#^anc-exec-tool-failure-report]]（五站同构，站位对照见 lack_of_info 链节尾注）；早判 [[exec-engine#^anc-exec-none-propagation]] |
| 4 | **schema 校验+恢复阶梯+归一**（validateOutputValues/recoverOutputValues/coerceOutputValues 不动点循环） | 缺键/null/类型谎报/自嵌套壳/跨类型值 | 恢复得出真值 → 放行留痕（warn）；恢复不了 → SCHEMA_MISMATCH → 算子级重试（注入形态反馈）；耗尽 → failStep(kind='error')。被拒且本步终轮正文里有疑似工具调用文字（如 `<tool_call>bash`）时，重做反馈与耗尽原因各在原文后追加一段条件式提示（工具在不在本步可用清单、可用的有哪些），通过校验的产出不碰 | [[exec-engine#^anc-exec-output-fence-recovery]] / `^anc-exec-output-coerce` / 附加提示 [[step-dispatcher#^anc-exec-text-toolcall-hint]] |
| 5 | **check 判定**（业务把关） | 判 false | failStep(reason='CHECK_FAILED: '+说明槽) → 容器升级链 | [[exec-engine]] check 节 |
| 6 | **容器升级链**（failStep → 最近 subtask/case retry） | 一切 failStep | 预算内 → 带反馈重跑（反馈进 L5，见下节）；耗尽 → adaptive 重规划 / 传播 / on fail 兜底 | [[exec-engine#^anc-exec-retry-adaptive]] |
| 旁 | **API 层错误**（限流/网络/超时/认证） | 传输层故障，非产出问题 | 分类重试（网络 6 次退避）；网络耗尽 → paused(network) 不 fail（步骤回置） | [[step-dispatcher#^anc-exec-api-retry]] / `^anc-exec-network-pause` |

**跨关不变量**：
- 关 2 与关 4 的形态宽容共同哲学=**内容完好时提取层不判死**；但**宽容形态不宽容内容**（真散文/真缺失照拒）；
- 每次恢复/归一必留痕（declared-or-flagged——静默改值不可无痕）；
- fail_kind 从 failStep 起全链携带（HopLog 步骤字段+state.json step_fail_reasons）——语义在关 6 分流（见 fail_kind 表）。

## lack_of_info 通道全链【契约】 ^anc-exec-lack-of-info-chain

承接面仅 reason（0053 作者定——act 缺信息该失败就失败，check 判不了走如实 false/escalatable gap）。全链五站，**任何一站断链即全链死**（2026-08-31 排查实锤：解析站曾杀键——单输出把 `lack_of_info: 缺X` 整段当声明变量的值收下静默 completed 毒值入库，多输出键蒸发三轮白烧后以 kind='error' 收场；根因=下述第 2 站设计写了未实装，测试直喂 completeStep 绕过解析层假绿）：

1. **教条站**（prompt 组装，[[prompt-assembler#^anc-exec-l0-worldview-impl]] reason 角色档）：教出口形态（单键 YAML）+**如实交代后果不承诺不存在的机制**——措辞"输出此键后本步按缺信息处理（引擎可能补充知识重试，或如实记为失败）；一旦输出此键，其他字段不会被采用"（末句封"顺嘴带一句"的混合形态：键在场即整步按缺信息走，正常字段弃——自报缺信息的产出整体不可信）；
2. **探测站**（standalone 实装形态=解析前前置探测，非 schema 追加）：reason 路径在 parseStepOutput 之前先对响应全文探一次 `lack_of_info:` 顶格键行（extractSelfReportKey 公共体，与 tool_failure 探测同一原语；键行判据=顶格+键名+冒号，思考散文在前合法），命中即短路返回单键对象、不进声明 schema 解析。原案"output_schema 追加可选字段"在实装时被否——追加会把单输出 reason 推进多输出解析路径，破坏"全文即值"合法形态（3264c28 记录）；
3. **解析站**（[[step-dispatcher]] parseStepOutput）：探测未命中的响应照常走声明 schema 三档提取阶梯——本站不认 lack_of_info 键（键不在声明 schema 里），这正是前置探测必须站在它前面的原因（不探则单输出把自报段当声明值收下毒值 completed、多输出键蒸发白烧重试，R1 死路实锤形态）；
4. **分流站**（[[step-dispatcher]] executionLoop）：hasLackOfInfo 判定 → 有 provider 检索重跑一次/无 provider 直接 failStep——**先于 schema 校验**（该形态天然缺声明槽，后判必被 SCHEMA_MISMATCH 白烧，0053 顺序契约）；
5. **承接站**（[[exec-engine#^anc-exec-none-propagation]] completeStep 早判）：复用模式 CLI submit 与 standalone 漏网形态的公共兜底 → failStep(kind='lack_of_info') 进容器升级链，driver/容器可据 kind 分流（知识补充/上传父层）。

**复用模式教学半边**：driver 执行规则（driver/references/step-execution-rules.md）reason 段教提交形态 `--output '{"lack_of_info": "缺什么"}'`——通道在 engine 早判恒在，教学此前缺席（排查 R2：通而不教）。

**全链测试契约**：必须有从**响应文本**起步的全链钉（文本 → parseStepOutput → hasLackOfInfo → failStep 且 fail_kind='lack_of_info'），单/多输出各一，含"思考散文+lack_of_info 尾键"形态；直喂 completeStep 的钉只护第 5 站，护不住 2-4 站。

**tool_failure 通道的五站对照**（[[step-dispatcher#^anc-exec-tool-failure-report]] 2026-09-01——与本链同构，站位逐一对应）：

- 教条站=L4 工具清单教条句（[[prompt-assembler#^anc-exec-tool-manifest-supply]] 第 4 面——真身档渲染，实际只有无 body act 组清单）+ driver 执行规则 reason 段与无 body act 段；
- 解析站=extractSelfReportKey 前置探测（与 extractLackOfInfo 同一公共体——reason 路径与工具循环终轮各探一次）；
- 分流站=无检索半边，探中即返 `{tool_failure: 值}`；
- 承接站=completeStep 早判（reason + 无 body act；commit 不设——作者定"commit必须通过body"，B7 error 级下无 body commit 进不了引擎，通道天然够不着）；
- 语义分界教学：缺信息（材料本来就没有）走 lack_of_info、工具故障（取材料的手段坏了）走 tool_failure——driver 教条明写两出口不互替。

## subtask-retry 生命周期与 prompt 供给面【说明——权威在各锚】

一次完整的"打回-重跑"循环，引擎侧账本与 prompt 侧供给逐拍对照（作者点名主线——每一拍谁记了什么账、下一拍谁消费）：

| 拍 | 引擎侧（账） | prompt 侧（供给） | 权威 |
|---|---|---|---|
| ① 步骤失败 | failStep：fail_kind 入 step_fail_reasons；CHECK_FAILED 时说明槽原文入 reason | —（check 的说明槽此刻是唯一物证——其质量由 check 角色档"说明槽下游消费指引"在**上一拍**保障） | [[exec-engine]] fail_step / check 角色档 [[prompt-assembler]] |
| ② 容器决策 | 最近 subtask/case 查 retryCounters：预算内 → 反馈入 retryHistory（最近全文+此前压缩行，5 条封顶）；耗尽 → adaptive/传播/on fail | — | [[exec-engine#^anc-exec-retry-adaptive]] |
| ③ 回滚 | resetSubtaskForRetry：children 置 pending；**变量不清**（留存缺省——正是下一拍基准的料源）；内层 retry 预算/兜底标记清；tool_journal 清 | — | [[exec-engine#^anc-exec-loop-var-scope]] / `^anc-exec-retry-output-retention` |
| ④ 重跑轮组装 | getActiveRetryFeedback 供数 | **L5 修正指令垫尾**（近因效应）四件：打回来源点名+核对象清单（容器围栏两道核对：事件属当前重试容器子树+CHECK_FAILED 起因——R3 已销）/上一版产出基准（当前步骤输出留存值逐条，≤500 字 inline 超阈卸载）/意见原文（剥记账框架；机械错误与判定打回分层措辞；网络类不当产出缺陷引导）/逐条落实框架+冲突裁决规则（"以核验要求为准——闸门优先于作业指引"） | [[prompt-assembler#^anc-exec-l2c-retry-feedback]] |
| ④′ 受众分道 | — | **check 步恒不吃 L5**（A 案——判官每轮独立判定，历史判词纯锚定毒药）；**check 与 commit 恒不吃 L5**（check=A 案判官独立;commit=S2 已销——虚构历史掐口）；**upstream 同掐**（H1 已销——callee 判官不吃父层意见,受众分道 retry/upstream 两半边对齐） | [[prompt-assembler]] A 案条款 |
| ⑤ 重跑执行 | 新一轮走完整旅程（关 1-6） | 教条/格式例/工具清单照常 | 各锚 |
| ⑥ 复判 | check 对新产出判——供给面=判据+新产出+说明槽消费指引，零历史 | 同 ④′ | [[prompt-assembler]] |

**call 边界的同构循环**（D41）：父层反馈经 upstreamFeedback 传 callee——standalone 进程内注入/复用模式经 init_command 的 --upstream-feedback 参数（H2 已销,两模式汇同一注入口）；callee 内部自循环独立记账。

## fail_kind 语义表【说明】

| kind | 谁产 | 容器升级链分流差异 | 消费方 |
|---|---|---|---|
| `error`（缺省） | 一切未分类失败（SCHEMA_MISMATCH 耗尽/机械错误/CHECK_FAILED） | 标准阶梯：带反馈重跑 → adaptive | 引擎自动 |
| `lack_of_info` | reason 自报（本文全链契约） | driver/容器可机检分流：知识补充/上传父层（升级链先走知识补充——exec-engine 消费点） | driver + 引擎 |
| `deterministic` | 引擎确定性错误产生点（重跑必然同因的枚举形态） | 掐容器重试直达兜底（^anc-exec-deterministic-no-retry——不烧预算）；不掐 on fail | 引擎自动 |
| `tool_failure` | reason/无 body act 自报工具故障（[[step-dispatcher#^anc-exec-tool-failure-report]]） | 走缺省重试路径（瞬时故障重试即愈，正确语义零新分支）；跨 call 界原样继承；审计面可对账谎报（报了此 kind 但该步 tool 块零 failure=谎报） | 引擎自动 + 审计面 |

（表随新增 kind 扩行——新增 kind 必须同批补本表+升级链分流实现，只发不接=死信号。deterministic 行 2026-09-01 补登——立卷时漏收的存量 kind，非新增。）

## 已知雷区台账【说明——2026-08-31 三路排查存量，修哪个销哪行】

| 雷 | 一句话 | 修理去向 |
|---|---|---|
| R1 lack_of_info 死路 | 解析站杀键 | **已销**（前置探测实装+全链三钉+真机 probe 端到端活） |
| R2 复用模式通而不教 | driver 零教学 | **已销**（driver 两载体 reason 段补提交形态教学） |
| R3 打回点名全局尾扫 | 机械失败重试误点名无关 check | **已销**（容器围栏+CHECK_FAILED 起因两道核对,任一不满足不点名——宁缺毋滥） |
| S1/S1b commit 零清单+工具不可达 | 渲染条件写死 act；requires_commit 件物理断路 | **已销**（2026-08-31 作者拍 B7 升 error——无 body commit 不复存在,消费面归零;存量三件补 body〔confirm-commit 改 loop 内 commit 正形/两审计 spec subprocess.run body 化〕） |
| S2/S2b commit 虚构历史+重放窗口 | L5 未掐 commit；算子重试重放不可逆动作 | **已销**（S2=L5 掐口补 commit 防御纵深;S2b=B7 升 error 后无 body commit 不复存在,算子重试重放窗口随之关闭〔带 body commit 走引擎直执不经 SCHEMA_MISMATCH 重试〕） |
| H1 callee 判官吃父层意见 | A 案漏 upstream 半边 | **已销**（upstream 掐口对齐 retry 半边:check/commit 恒不吃,重放变异钉红） |
| H2 复用模式 call 零反馈 | D41 只实装 standalone | **已销**（作者拍 A 案:init_command 追加 --upstream-feedback 汇入 EngineOptions 同一注入口——两模式同通路,driver 照抄零改动;重放变异钉红） |
| H3 check body 步记假 prompt | hasBody 豁免漏 check | **已销**（豁免面补齐 act/commit/check 三类,probe 同款场景钉零假 prompt） |
| S3 commit 角色档悬空引用 | "与 act 完全相同"引用 LLM 看不到的档 | **已销**（角色档自足化改写——B7 升 error 后理论不可达,防御性修文） |
| 新·models.commit 死配置 | B7 升 error 后 commit 恒 body 直执零 LLM,Config.models.commit 与 resolveModel commit 档无消费面 | 挂账（待处置:删配置项或留作将来 commit 前置 LLM 步路由——不静默） |
| H5-H13/S4/R4-R5 | 中低位群 | 攒批 |
