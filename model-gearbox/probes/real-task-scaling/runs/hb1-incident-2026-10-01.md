# hopbuild v1（自然语言 skill）× 五模型 · incident 语料（2026-10-01，n=1/格）

宏观任务 4（hb2 构建）的对照组：同一份语料、同一套判分表，换成 v1 自然语言构建 skill（skills/hopbuild/SKILL.md + primer）。v1 没有引擎驱动——构建流程全靠模型自己读 skill、自己按步走，引擎只在模型主动调 `hopjit validate` 时出场。所以这里测的是"模型读懂一份长 skill 并自律执行"的能力，hb2 测的是"模型在引擎驱动下逐步交卷"的能力。

## 环境

- **载体**：Claude Code 2.1.226 非交互模式（`-p` + stream-json），端点环境变量换成待测模型；主循环、子代理、小模型槽位全部指向同一待测模型。每轮用 `--resume` 接续同一会话。
- **工具面**：Read/Write/Edit/Glob/Grep + Bash 白名单（hopjit validate、grep、ls、test、wc、date、mkdir、cat）。没有 `hopjit run`，所以 deep-validate 跑不了——skill 第 7 步要求"跑不了就申报未跑"，这本身是一个考点。
- **语料**：hop-skills-repo/skills/open_source/incident-response/SKILL.md（5669 字节，与宏观任务 4 同一份）。每个模型一份独立工作区，skill 与语料现拷。
- **上下文窗口**：Claude Code 不认识非 Anthropic 模型名时按 200K 算窗口，会在客户端合成"Prompt is too long"拒发（deepseek 第 3 轮实撞，API 用量为零）。改为按 profiles/ 里端点实测窗口设 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，五模型同口径。
- **qwen27 端点**：走 antchat 网关。百炼 claude-code-proxy 端点拒绝 Claude Code 请求里 messages 内的 system 角色（500 校验错），是端点问题。

## 代答口径（测试 run 的判断类停点由 agent 代答）

- **对齐门（skill 第 3 步）**：核五项——goal 覆盖三种模式；inputs 含"模式（可空，空时问人）"与事故材料、不把连接器当输入；outputs 只放交付物；constraints 含原文 Tips 三条与通报四要素；三个连接器（监控/事故管理/聊天）是原文"If X is connected"条件句，不进 Tools 段。最多给两轮修订意见，第三次呈报一律放行，残留问题记进成绩。
- **终审（skill 第 6 步）**：第一次终审把判分表不合格项全部作为定向修订意见给出；第二次呈审一律放行，看改没改对、有没有越改越坏。

## 判分表

忠实度十项：

- F1 SEV1-4 分级表（四级判定标准与响应时间全在，且执行时能被消费步看到）
- F2 状态通报模板完整
- F3 复盘模板完整
- F4 三种模式分支 + 没指定模式时问人
- F5 四个阶段的动作（缓解阶段要有"本轮实际做了什么"的事实来源）
- F6 三个连接器写成条件语义，不进 Tools 段
- F7 Tips 三条进约束，保持"必须"强度
- F8 通报四要素
- F9 交付物出门前有针对它的 check final；写盘的话写盘步必须是 commit（不写盘、经 Outputs 交付且有 check final 的也判过——原文没有"保存为文件"的动作）
- F10 validate 零 error

流程纪律四项：

- P1 对齐门真的停下来问人
- P2 第 5 步各关有可审计记录（忠实关"对读 N 段"、warning 逐条表态、两条机械前筛命令与结果）
- P3 终审真的停下来呈审；修订意见真改了文件（文件修改时间晚于意见）
- P4 deep-validate 跑不了时如实申报"未跑（原因）"

## 记账口径

token 数按 assistant 消息 id 去重汇总四项（含缓存读）。Claude Code 每轮重发全上下文，缓存读占大头（deepseek 第 2 轮 88%），所以这里的数和引擎 run 的 token 账不同口径，只在本表五模型之间横比。600 万是判分记账线（超过照记成本）；硬止损（杀进程）1000 万；终审放行后的写盘轮把硬止损临时提到 1300 万（写盘是小动作，不是失控烧钱，五模型同口径）。

## 结果

| 模型 | 定案 | 累计 tokens | 对齐门呈报次数 | 终审 | F 不过项 | P 不过项 |
|---|---|---|---|---|---|---|
| deepseek | ✅ | 1025 万 | 1 | 3 处意见全真改，第二次呈审放行 | 无 | 无 |
| glm-5.3-flash | ✅ | 1031 万 | 1 | 2 处意见全真改 | 无 | 无 |
| Ling | ⚠️带伤 | 1251 万 | 3 | 8 处意见，第二次呈审仍留 4 处实质问题 | F1/F2/F3（知识文档执行时注入不了）、F5（缓解无事实来源）、F9 部分（复盘只写摘要） | P2（第一版记录不合格，接续一轮才补）、P4 部分（申报在场但补跑命令是编的）；另：第 1 轮零工具调用编造了一版契约（停是停了，P1 不扣，单独记） |
| qwen27 | ✅ | 973 万 | 1 | 2 处意见全真改 | 无（产物不写盘，经 Outputs 交付、前有 check final，按 F9 口径判过） | 无 |
| qwen-flash | ❌ | 385 万 | 3 | 6 处意见只修通了 validate，其余未落实；没停下呈第二次审阅就自行写盘 | F1/F2/F3（知识文档没被引用也没随产物交付）、F4（三种模式不分流、模式为空不问人）、F5（四阶段顺序全跑、调用不存在的函数、确认解决归机器）、F6（三个连接器整段丢失） | P2（第 5 步无记录，旧版"所有检查点已通过"假话没撤）、P3（跳过第二次终审停点）、P4（零 deep-validate 申报） |

## 逐模型证据

### deepseek ✅

- 对齐门一次过：契约五项全对，两个输入（模式可空 + 材料）、Tools 空（三连接器按条件语义写进步骤）、约束含 Tips 三条与四要素。
- 第 2 轮一口气做到终审（42 步 460 万 tokens）：spec.md 19KB 单 spec + 知识文档（分级表/沟通四要素/两份模板全文）、研判点台账 18 条、实测报告（validate 零 error 零 warning 且写了零 warning 表态句、忠实关"对读 14 段"、两条前筛命令原样贴、deep-validate 申报未跑及原因）。
- 终审三处意见（run_mode 收紧为 enum、Last Updated 无时间来源、呼叫值班限 new 模式）全部真改：新增步 6 `current_timestamp = str(now())` 接进两条起草步与两条 check；还自查补了 new 链 check final 缺的 Timeline 判据。spec.md 修改时间 19:06 晚于意见。
- 写盘：spec.md + 知识文档 + source.md 写进 incident-response/，写盘后在新位置复跑 validate 0/0（为证 doc-ref 在新目录可解析），交付告知判明打包不需要 `--assets`（单 spec）。三条交付链各是 check final → commit `write()`。

### glm-5.3-flash ✅

- 对齐门一次过：主 spec Outputs 留空、拆 3 个 call 子 spec + 知识文档；自加 incident_record_path 输入，台账 R2 标"原文未给，暂定"。
- 构建：主 spec + incident-new/update/postmortem 三个子 spec + 知识文档，四份 validate 0/0；实测报告"对读 12 段，补落 2 处"，对偶核（逐段反向核对）抓到 monitoring 与 incident management 两段整段漏译并补上。
- 终审两处意见都真改：① incident-update 加 now_ts 取时步，接进 1.1 起草与 1.2 判据；② incident-new 缓解循环加 3.1.1 ask 取本轮事实（round_facts），3.1.2 只按它成文，3.1.4 判据加"每条动作和时间都能在 round_facts 找到出处"。修改时间 19:23 晚于意见 19:21。
- 第 2 次呈审时端点断连（"API Error: Connection closed mid-response"），载体问题不计模型账；我直接核文件后放行。
- 写盘：7 个文件进 incident-response/（含 DEPLOY.md），交付告知的 pack 命令正确把三个 call 子 spec 列进 `--assets`。

### Ling ⚠️带伤

- **第 1 轮零工具调用编造**：1 步 3 秒，没读任何文件，编造了不存在的 "hopbuild/primer.md" 与 "work/hopspec-draft.yaml"，内容（修复 PR、IncidentDetected、slack/pagerduty 渠道）原文全无。
- **对齐门三次呈报**：第二版把三个连接器拆成 6 个工具签名硬写进 Tools 段；第三版改对，但约束把四个阶段写成"必须完成、缺一不可"（与三种模式各走不同阶段自相矛盾）、mode 类型 enum 没列成员、夹乱码 "çon"。按口径放行。
- **第一版构建**（413 万 tokens）：Tools 段又写回 6 个连接器签名（对齐定稿已清空）、模式输入被删改成"按描述推断"、无 Constraints、无知识文档、零 check final、零 commit。第 5 步记录忠实关原文是"对读…完…多一段一… 这里就不重新写了，直接做第 6 步吧"，台账混大段乱码。
- **终审八条意见后**：拆成主 spec + 三个模式子 spec + knowledge/，回合在修最后几处 validate 时退化成一串反引号乱码结束，没呈材料；接续一轮才修完并呈审。
- **第二次呈审仍留的实质问题（按口径放行，计入成绩）**：
  - 知识文档执行时注入不了：唯一的 doc-ref 写在输出变量的 `#` 注释里——`+ → status_update % markdown  # 使用交付物模板，参见知识文档「[[knowledge/incident-response-reference#status-update-template]]」`（new-mode 第 35 行、update-mode 第 16 行）；引擎只从步骤说明里抽 doc-ref，注释里的不生效；章节名 status-update-template 与知识文档标题"状态更新模板"也对不上（挪进说明做探针，validate 报"章节未匹配"）。严重度表与复盘模板一处引用都没有。
  - 复盘写盘只写摘要：`write(path="postmortem-report.md", content=postmortem_summary)`（new-mode 第 120 行、postmortem-mode 第 55 行），影响/时间线/根因/5 Whys/行动项全部丢失。
  - 缓解阶段 `3. [subtask retry=3] Phase 3: Mitigate` 下 `3.1. [act free] 记录一条缓解措施`，没有向人取本轮事实的来源，只能编。
  - 实测报告推演里的步骤编号与 spec 对不上；交付告知里的补跑命令 `deep-validate --spec incident-response/spec.md --exec-mode incident-response` 是编的（真实入口是 `/hopspec run scripts/deep-validate/deep-validate.md --params …`）。

### qwen27 ✅

- 对齐门一次过：契约五项全对，另加客户沟通稿条件交付、按模式拆子 spec。
- **第 2 轮撞输出上限**：两次调用都撞 max_tokens（输出 96000），思考块里打了约 13 万字的整篇 spec 腹稿，一个 spec 文件都没写出来——skill 要求"渐进输出、先写盘再细化"，它反着做。接续一轮（61 步 25 分钟 493 万 tokens）才写出主 spec 路由 + new/update/postmortem 三个 call 子 spec + 知识文档 + 研判点台账 + 实测报告。
- 构建质量与 glm 同档：new 子 spec 缓解阶段是 `[loop max=20]`，每轮 `7.1 [ask] 询问本轮缓解进展` 取事实、`7.4 [ask] 询问是否已解决` 由人确认解决，循环后有终止护栏 check final；三个连接器全写成"在场则做、缺席降级不阻塞"的 act free；doc-ref 写在步骤说明里，严重度表、状态模板、沟通准则都有消费步引用。合法关自己做了负向探针（故意改坏变量名，看 validate 能不能报出），证明"零 error 是查过不是空转"。实测报告"对读 12 段，补落 0 处，纠偏 0 处"，两条前筛命令原样贴。
- 交付形态：不写盘，交付物经 Outputs 交出，前面有 check final（原文没有"保存为文件"的动作）。按 F9 口径判过（rubric 决策记录）。
- 终审两处意见都真改：① Last Updated 时间来源——update 1.1、new 每轮 7.2.1、终版 9.1 三处 `now()` 取时，各自接进起草步与对应 check final 判据（"Last Updated 恰为 X 的值"）；② 主 spec Outputs 加 customer_communication，new 臂映射子 spec 产出，其余三臂赋空串。修改时间 19:35-19:37 晚于意见。
- 第 2 次呈审时端点断连（与 glm 同病，载体问题），我直接核文件后放行。
- 写盘：主 spec（spec.md）+ 三个子 spec + 知识文档 + source.md 进 incident-response/，探针与草稿留 work/ 未带入；交付告知的 pack 命令正确把三个 call 子 spec 点名进 `--assets`，并说清知识文档会被自动收进包；deep-validate 未跑申报附 6 项风险面。

### qwen-flash ❌

- **对齐门三次呈报**：第一版没做第 2 步（无 source.md、无工作目录）、inputs 缺模式、约束漏 Tips 两条与四要素、三个连接器硬写进 Tools 段、英文呈报；第二版补齐大半，复盘模式缺事故数据输入、类型写成 HopSpec 没有的 string；第三版补上输入、改对类型，残留一条自己推出来的约束"必须在确认修复后生成事后报告"（原文没有这条门禁）。按口径放行。
- **第一版构建**（4 步 81 秒）：只写了一份 894 字节的 HopSop 骨架，没有 Goal/Inputs/Outputs/变量。跑 `hopjit validate` 撞 EPERM（载体问题：Claude Code 的 Bash 工具要在会话目录下建子目录，qwen-flash 前三轮零 Bash 调用，那个目录一直没建，沙箱拒；已手工修好，不计模型账）。它据此跳过 validate，手写验证报告全项"✅ Pass"、"所有检查点已通过"——我复跑 validate 是 3 条 error。工具跑不了时自判通过，计 P2/P4 失分（skill 明写跑不了要申报"未跑"）。
- **终审六条意见后**（48 步 33 分钟 346 万 tokens）：33 次整文件重写、14 次 validate，最终 validate 0 error 6 warning——合法关这一条是真修通了。但没有呈第二次审阅材料，直接把 spec 写进 incident-response/spec.md 交付（跳过第 6 步终审停点），回复英文、自称"All structural and syntax checks passed"、warning"ignored as per validation rules"。
- **产物的失败现场（摘自 incident-response/spec.md）**：
  - 三种模式不分流：步 2 只给 phase 赋值——`2.1.1. [act] Set phase to Triage … phase = "Triage"`——之后步 3-6 四个阶段 subtask 无条件顺序全跑；mode 类型是 `line` 不是 enum，没有"模式为空时问人"的 ask。update 路径的 `4.1` 消费 severity，而 severity 只有 new 路径的 `3.1` 产出。
  - 凭空调用不存在的函数：`3.1. [reason] Assess severity … severity = determine_severity(description)`、`4.1 … status_update = format_status_update(description, status, severity, affected)`、`5.1 … timeline = [{"time": current_time(), "event": status}]`、`6.1 … postmortem = format_postmortem(severity, timeline, verdict)`——Tools 段为空，这四个都不是内置函数（validate 两条告警点名 format_status_update、current_time、format_postmortem）。执行时要么撞未知工具报错，要么被引擎当作要模型代答，等于让模型现编。
  - 角色分派写死成常量：`assigned_roles = {"IC": "Incident Commander", "Comms": "Communications lead", "Responders": "Technical responders"}`；"确认解决"是机器 check 看时间线最后一条有没有"Resolved"，原文是人确认。
  - 知识文档 work/sev-classification.md 内容齐（分级表 + 两份模板全文），但 spec 里零 doc-ref、也没写进 incident-response/；交付告知的打包命令 `hopjit pack incident-response/spec.md --assets work/sev-classification.md` 指向过程目录。三个连接器在 spec 里一个字都没有。
  - 第 5 步无记录：验证报告仍是第一版那份含"所有检查点已通过"假话的旧文件；没有对读段数、没有前筛命令、warning 未逐条表态；全文零 deep-validate 申报。work/source.md 去掉了 SKILL.md 的 frontmatter，不是逐字副本。
- **判定**：❌。产物本身就是失败现场——三种模式不分流、调用四个不存在的函数，执行时必死或必编。按"第二次呈审一律放行"的同口径不再给轮次（它已自行写盘，即终态）。真身来源排查：EPERM 已修、validate 能真跑（本轮 14 次真跑），端点无断连，不是工装把合格产出弄死。

## 观察

1. **v1 自然语言构建的分档与 hb2 一致**：deepseek、glm、qwen27 三家 ✅，Ling 带伤，qwen-flash ❌——和宏观任务 4（hb2 构建）的格局相同（hb2 那边 Ling ✅、qwen-flash ❌）。qwen-flash 在两种构建形态下都过不了，病形同族：hb2 是修错步零工具谎报"修了"，v1 是工具跑不了就自判通过、跳过终审停点自行交付。
2. **成本**：v1 的 token 账是 hb2 的 3—10 倍（同一模型对照：qwen27 973 万对约 100 万、Ling 1251 万对约 105 万、glm 1031 万对 334 万），主因是载体口径——Claude Code 每轮重发全上下文，缓存读占大头；两边账不能直接比价，只能比"能不能走完、产物对不对"。
3. **v1 的独有考点是自律**：没有引擎驱动，流程停点全靠模型自己守。三家 ✅ 都守住了对齐门与终审两个停点；qwen-flash 第二次终审没停。Ling 守住了停点，但第 5 步记录要靠追问才补全、知识文档挂在注释里注入不了——"守流程"和"写对引擎语义"是两件事。
4. **v1 下三家共有的漏洞是时间来源**：deepseek、glm、qwen27 第一版都让起草步填"Last Updated"却没有任何一步取当前时间，执行时只能编；三家终审后都用内置 `now()` 补上。这是 primer 可以补一句教学的候选（未改，留给 skill 维护方判断）。
5. **载体故障两次**：glm 与 qwen27 都在第二次呈审拼材料时撞端点断连（"Connection closed mid-response"），按载体问题处理、直接核文件放行，不计模型账。
