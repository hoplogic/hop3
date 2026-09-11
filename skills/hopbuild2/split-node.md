# Spec: split-node — 递归等价分拆一个 NL 节点
Id: split-node

## Task

Goal: 对一个 NL 节点按优先级逐个判定（顺序→分支→循环→原子），判完一个返回一个——命中即产出片段并 exit；三结构判不中做原子判定（认领类型,纯机械的带 hop_python body 落定,其余无 body 落定）,原子也不过则按内容分型落定为未尽原子（含不可逆→探索三件套剥 commit;含闸门→保 ask/confirm;其余→act free;纯推理→reason）。结构分拆委托 split-structure
> 每遍语义等价只改表示形态。"明确"是硬门槛：每个判定只回答一个问题,拿不准=false 落下一判。能走到判定 N 说明前面判全没中——顺序即逻辑,零短路传参。终态两档都合法：hop（双模式可跑）/ mixed（含未尽原子,复用模式可跑——拆解不了的最终态也有价值,不硬拆）。

Constraints:
- 语义等价：不添不漏；原文没给的判据/阈值不算缺陷（暂定+记研判点台账）
- 一次一判,判完即走：命中路径产出后当场 exit,不合并判定不预判后续
- 可读可解释：命中理由一句话讲得清
- 全局知识（spec 级 doc-ref,对所有步骤注入）：[[split-patterns#HOP 全局认知（目标语言与产物是什么）]] 与 [[split-patterns#节点两型与判定序（你在做什么）]]

Inputs:
- node_task: text  # 本 NL 节点的任务描述（原文一段明确范围的一句话概括;根节点=整个 NL skill 的目标句。就是一句概括——动作细节的权威在 node_source,不在这里）
- node_source: text  # 本节点对应的原文范围全文,**每行行首带全局行号 `L<数字>: `**（忠实性对照基准;根节点=NL skill 原文编号版全文,子节点=按行号段机械切出的切片——行号是原文全程唯一基准,不逐层重编,分拆方案里的范围标记按行首号直接引用）
- parent_context: text  # 父层已定骨架+可用变量清单（根节点为空串——父骨架是边界:不重拆不越位,上游变量从清单选真名）
- parent_vars: [line]  # 父层可用变量名清单（与 parent_context 第二段清单同名同源;根节点=空清单 []——片段机械验证的 known_vars 供给）
- depth: int  # 本节点绝对层深（根节点=1;值=本节点片段顶层步骤在最终产物里的嵌套层数,按步骤号段数计——'3'=1层/'3.2'=2层/'3.2.1'=3层）
- max_depth: int  # 产物嵌套深度上限（缺省 3——split-structure 1.3 深度闸按它机械拦,本 spec 原样透传;D75）
- header_final: yaml  # 已对齐的头部契约（goal/inputs/outputs/constraints/tools_available——工具引用只许在其面内）
- judgement_log: line  # 研判点台账路径（workspace 相对路径,或引擎涂鸦区绝对路径〔work_zone 是绝对路径禁令唯一豁免〕;其余绝对路径工具面拒;全树共写一份,append 契约文件不存在则创建）

Outputs:
- fragment_path: line  # 本节点子树 HopSpec 片段的文件路径（work_zone 涂鸦区文件——值是路径不是内容,片段全文不过变量通道〔D78〕;内容=编号相对从 1 起的片段,NL 子节点已被递归结果替换）
- tier: enum(hop, mixed)  # 子树档位：hop=全 hop 化;mixed=含未尽原子（复用模式可跑档）

## Steps

### 1. [subtask retry=2] 判定：顺序——能不能按明确的先后段落拆（判定+行号覆盖机械核同一事务,漏行打回重产计划）
+ → seq_hit: bool  # 顺序判定命中与否（判据见 1.1 执行说明）
+ → seq_plan: text  # 命中时=子节点清单,每行"任务描述 | 原文行号段 | 类型或 NL"（任务描述=一句概括;行号段从 node_source 行首号直接读,形如 L120-L185,不连续用 + 连接）;未命中时=一句为什么不明确

#### 1.1. [reason] 顺序判定并产分拆计划
- ← node_task, node_source, parent_context, depth, max_depth, header_final
+ → seq_hit: bool  # 顺序判定命中与否（判据见下方执行说明）
+ → seq_plan: text  # 同容器头声明——命中=计划清单,未命中=一句理由

只回答"能不能按明确的先后段落拆"这一个问题。判据逐条：

- **命中**：原文有明确的先后段落序——"先…再…"的显式衔接,或段落天然承接;
- **"做X并核验,不合格就重做"也算命中**：切成干活段+验收段（这是 subtask-check-retry 的事务形态,不算含糊）;
- **不命中**：段落边界含糊、先后顺序有歧义;
- **零进展不算命中**：方案里只剩一个 NL 子节点、且它的范围和本节点几乎一样大——这样递归会对同一段落无限重拆,判 false 落下一个判定。

切段规矩：

- **计划必须覆盖原文全部行——行号段并集当场对账**：把清单各条的行号段并起来,对照 node_source 的行号全集做减法——每一行都要有归属条目,漏行=那段流程执行时不会发生。对账是行号算术不是语义搜检：范围标记就是行号段,并集盖没盖住全部行一算便知（下游机械对账还会再算一遍同一道减法,漏行/越界当场打回——你在产计划时先自己算,省一轮打回）。**任务描述只写一句概括**,动作细节不抄进描述——切片按行号机械提取逐字保真,子层拿到的切片里动作清单完整在场,子层骨架对照切片自查覆盖（历史沿革:旧形态曾要求"每个规定动作单独确认落进某条计划的任务描述",清单膨胀成几百字点名清单;行号化后覆盖性由行号并集保证,动作级对账下移子层——子层有权修自己骨架,查出漏项当场补,不存在"无权修计划"的死锁）。有缺口当场补条目或并入邻条,**不许带缺口交出去**。材料节（表格/清单/模板）也要有行号归属——归属形式是并入消费它的条目的行号段;
- **一次拆分不超过 5 个子节点,范围内尽量当场拆到位**——能定型的子节点直接写类型,不切成两半留 NL 等下一层;**本节点原文少于约 800 字的,不再留任何 NL 占位**（要么全部当场定型,要么整节点判 false 走原子判定落定——小节点再递归一层的成本比直接写完还高,详见知识库"拆分粒度四条硬规则"）;**本节点 depth 距 max_depth 只剩一层时,倾向当场全部定型、不留 NL 占位**——留了占位,子层片段的顶层步骤就落在超限层,会被 split-structure 1.3 深度闸机械打回（教学在此,硬闸在机械检;定型不了的直接落自然语言步骤,不再递归）;
- **只切流程,材料不拆**——流程=要执行的动作序列;材料=被动作使用的内容（规格/示例/模板/清单）,不进子节点清单但不丢,随所属步骤的执行说明引用走;一段里两种成分并存时,只把动作切出来（概念与实例见注入的知识库节）;**材料段与附属文件里的门禁句例外**——"必须…才能/不得…除非/通过…后方可"这类有过/不过语义的句子是流程性内容,所在段落再像材料也要让它有行号归属、后续拎成显式 check 落点（细节留材料,拎的只是把关句）。**门禁与排障心法分得开**：同是文件尾清单,有过/不过语义的是门禁要拎;"遇到 X 可以试试 Y"的经验心法是参考材料,随执行说明引用即可不拎——按语义分不按位置分;
- **计划条目点名具体外部工具时,先对照 header_final.tools_available**——工具在清单内才可写进计划;不在清单内（含清单为空）,这段动作就是作者在对齐门裁掉的能力,按"header_final 盖过原文"跳过该段,记 log_notes 一条"原文含 X,已按对齐契约裁剪"（实撞:tools_available 已被作者清空,计划仍写"用 Puppeteer 导出"——下游骨架照计划成文无权自裁,被裁能力一路活进最终产物）;
- 含不可逆动作/达标要求的段落：commit 段单列、放在验收段之后（形态细则归 split-structure,此处只管切段）;**门禁+补救动作的复合句**（"抽查发现系统性错误后重跑同类全部记录"这类判定与补救连写的句子）——判定半边拎成 check,补救半边优先落 retry 容器回路（check 不过带反馈整组重跑,补救语义由重跑承载）;容器粒度粗于原文动作粒度时如实记研判点台账,不硬造步骤也不静默丢弃;
- 子节点"当场可定型写类型"从紧：一步一动作、描述一两句装得下、无内部交互闸门,才直接写类型;**阶段级段落（含多个规定子步骤/问人闸门/复合序）必标 NL** 交给递归——标单个类型等于把一章压成一行;拿不准标 NL。

引擎已自动注入（doc-ref）：
[[split-patterns#subtask 探索范式（步骤定型与事务形态）]]

#### 1.2. [check] 行号覆盖机械对账（D76④——漏行/越界当场打回,有权修计划的层自己重产计划,缺口不下发）
- ← seq_hit, seq_plan, node_source
+ → seq_cov_ok: bool  # 判定槽（未命中恒过——无计划即无对账对象）
+ → seq_cov_note: text  # 说明槽（坏段/漏行/越界清单回填,重跑轮重产计划）

纯机械判定,body 由引擎直接执行、不经 LLM。计划各条行号段并集必须盖住 node_source 全部行：从计划文本扫出全部 `L<起>-L<止>` 形态的行号段,与 node_source 各行行首号做减法——漏行=那段原文没有归属条目,下游那段流程不会被翻译;越界=引用了本节点原文里不存在的行号,切片会切空。命中却扫不出任何行号段、或段格式坏（非 L数字-L数字）同判不过：
> ```hop_python
> toks = [strip(t) for t in split(replace(replace(seq_plan, "|", " "), "\n", " "), " ")]
> raw_segs = [t for t in toks if startswith(t, "L") and "-L" in t]
> stripped = [replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(s, "0", ""), "1", ""), "2", ""), "3", ""), "4", ""), "5", ""), "6", ""), "7", ""), "8", ""), "9", "") for s in raw_segs]
> segs = [raw_segs[i] for i in range(len(raw_segs)) if stripped[i] == "L-L"]
> bad_segs = [raw_segs[i] for i in range(len(raw_segs)) if stripped[i] != "L-L"]
> src_nums = [int(split(split(l, ":")[0], "L")[1]) for l in split(node_source, "\n") if startswith(l, "L") and ":" in l]
> seg_starts = [int(split(split(s, "-")[0], "L")[1]) for s in segs]
> seg_ends = [int(split(split(s, "-")[1], "L")[1]) for s in segs]
> missing = [n for n in src_nums if not any([(seg_starts[i] <= n) and (n <= seg_ends[i]) for i in range(len(segs))])]
> alien = [segs[i] for i in range(len(segs)) if (seg_starts[i] not in src_nums) or (seg_ends[i] not in src_nums)]
> seq_cov_ok = (not seq_hit) or (len(raw_segs) > 0 and len(bad_segs) == 0 and len(missing) == 0 and len(alien) == 0)
> seq_cov_note = "" if seq_cov_ok else ("计划里扫不出任何行号段——每条计划的范围位必须写 L<起>-L<止> 形态,行号从 node_source 行首直接读" if len(raw_segs) == 0 else "") + (" | 格式坏的行号段(须 L数字-L数字 形态): " + join(bad_segs, ", ") if bad_segs else "") + (" | 无归属的原文行号(漏行——补条目或并入邻条): " + str(missing) if missing else "") + (" | 越界行号段(引用了本节点原文没有的行): " + join(alien, ", ") if alien else "")
> ```

### 2. [branch] 顺序命中 → 分拆并返回
+ → fragment_path: line  # 命中时由 case 赋值——子树片段的文件路径（未命中静默跳过,不写值）
+ → tier: enum(hop, mixed)  # 同上

#### 2.1. [case(seq_hit)] 委托结构执行机,产出即返回
##### 2.1.1. [call split-structure(split_kind: "seq", split_plan: seq_plan, node_task, node_source, parent_context, parent_vars, depth, max_depth, header_final, judgement_log)] 顺序骨架→三检→递归→拼装
+ → fragment_path: fragment_path  # 收取子树片段的文件路径（值是路径不是内容——D78）
+ → tier: tier  # 收取档位
##### 2.1.2. [exit] 判完即返回

### 3. [subtask retry=2] 判定：分支——能不能按明确的条件路径拆（判定+行号覆盖机械核同一事务）
+ → branch_hit: bool  # **原文存在互斥的多条路径即 true**——条件路径（如果…否则…）、并列可选用法（方式一/方式二）、多种任务模式（生成/修改）都算;条件现不现成不是判定门槛,取值技法（输入判空/ask 收选择/前置 reason）归成文期,见注入的分支与循环判据。确实不进产物的路径（如纯手工用法）可以不翻译,但必须在 log_notes 记一条"什么路径没翻译、为什么",留给作者终审时决定——不许悄悄判 false 吞掉
+ → branch_plan: text  # true：case 清单,每行"条件表达式 | 任务描述 | 原文行号段 | 类型或 NL"（任务描述=一句概括;行号段从 node_source 行首号直接读）;false：一句理由

#### 3.1. [reason] 分支判定并产 case 清单
- ← node_task, node_source, parent_context, header_final
+ → branch_hit: bool  # 同容器头声明
+ → branch_plan: text  # 同容器头声明

只回答这一个问题。case 清单里的"类型"按探索范式的步骤定型认领,拿不准标 NL。**产完清单同样当场对账覆盖**（各 case 行号段并起来+分支公共前置,对照 node_source 行号全集算减法——缺口不下发,规矩同判定 1 切段规矩首条;1.2 同款机械对账在 3.2 再算一遍,漏行当场打回）。引擎已自动注入（doc-ref）：
[[split-patterns#分支与循环判据]]
[[split-patterns#subtask 探索范式（步骤定型与事务形态）]]

#### 3.2. [check] 行号覆盖机械对账（D76④,与 1.2 同款）
- ← branch_hit, branch_plan, node_source
+ → br_cov_ok: bool  # 判定槽（未命中恒过）
+ → br_cov_note: text  # 说明槽（坏段/漏行/越界清单回填）

纯机械判定,body 由引擎直接执行、不经 LLM（判定逻辑与 1.2 逐行同款,输入换 branch_hit/branch_plan）：
> ```hop_python
> toks = [strip(t) for t in split(replace(replace(branch_plan, "|", " "), "\n", " "), " ")]
> raw_segs = [t for t in toks if startswith(t, "L") and "-L" in t]
> stripped = [replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(s, "0", ""), "1", ""), "2", ""), "3", ""), "4", ""), "5", ""), "6", ""), "7", ""), "8", ""), "9", "") for s in raw_segs]
> segs = [raw_segs[i] for i in range(len(raw_segs)) if stripped[i] == "L-L"]
> bad_segs = [raw_segs[i] for i in range(len(raw_segs)) if stripped[i] != "L-L"]
> src_nums = [int(split(split(l, ":")[0], "L")[1]) for l in split(node_source, "\n") if startswith(l, "L") and ":" in l]
> seg_starts = [int(split(split(s, "-")[0], "L")[1]) for s in segs]
> seg_ends = [int(split(split(s, "-")[1], "L")[1]) for s in segs]
> missing = [n for n in src_nums if not any([(seg_starts[i] <= n) and (n <= seg_ends[i]) for i in range(len(segs))])]
> alien = [segs[i] for i in range(len(segs)) if (seg_starts[i] not in src_nums) or (seg_ends[i] not in src_nums)]
> br_cov_ok = (not branch_hit) or (len(raw_segs) > 0 and len(bad_segs) == 0 and len(missing) == 0 and len(alien) == 0)
> br_cov_note = "" if br_cov_ok else ("计划里扫不出任何行号段——每条计划的范围位必须写 L<起>-L<止> 形态,行号从 node_source 行首直接读" if len(raw_segs) == 0 else "") + (" | 格式坏的行号段(须 L数字-L数字 形态): " + join(bad_segs, ", ") if bad_segs else "") + (" | 无归属的原文行号(漏行——补条目或并入邻条): " + str(missing) if missing else "") + (" | 越界行号段(引用了本节点原文没有的行): " + join(alien, ", ") if alien else "")
> ```

### 4. [branch] 分支命中 → 分拆并返回
+ → fragment_path: line  # 同 2——子树片段的文件路径
+ → tier: enum(hop, mixed)  # 同 2

#### 4.1. [case(branch_hit)] 委托结构执行机,产出即返回
##### 4.1.1. [call split-structure(split_kind: "branch", split_plan: branch_plan, node_task, node_source, parent_context, parent_vars, depth, max_depth, header_final, judgement_log)] 分支骨架→三检→递归→拼装
+ → fragment_path: fragment_path  # 收取（值是路径——D78）
+ → tier: tier  # 收取
##### 4.1.2. [exit] 判完即返回

### 5. [subtask retry=2] 判定：循环——原文有没有"重复的模式"（判定+行号覆盖机械核同一事务）
+ → loop_hit: bool  # **重复的模式都是循环,判 true**（"做X并核验,不合格重做"的失败重试形态已在判定 1 被顺序判收编成干活段+验收段,走不到这里——本判不必再排除它）。两种成文形态：①**逐条处理**——有一批同类条目、每条走同一套处理（"每封邮件/逐个文件/按大纲各页"）,落 loop for-each;列表在两处找:原文语义,或 header inputs 里的 `[T]` 列表型输入（原文"按 X 处理各部分"而 X 声明为列表,逐项语义已在契约里——只扫原文找"每个"字样会漏,实撞:content_outline [yaml] 逐页生成被判无列表）;②**重复推进**——做多轮直到条件满足或到轮数上限（"分轮评审直到无新发现""迭代改进最多三轮""持续监控直到风险降级"）,落 loop max=N,体内 check 判条件、满足即 break
+ → loop_plan: text  # true 时首行标形态:"for-each | 遍历对象 | 列表来源（不明则注明需前置取数步）"或"repeat | 继续/停止条件 | 轮数上限",次行循环体"任务描述 | 原文行号段"（任务描述=一句概括;行号段从 node_source 行首号直接读）;false：一句理由

#### 5.1. [reason] 循环判定并产计划
- ← node_task, node_source, parent_context, header_final
+ → loop_hit: bool  # 同容器头声明
+ → loop_plan: text  # 同容器头声明

只回答这一个问题。限定词（"所有/未处理的/本周的"）落到列表来源,不落体内过滤。**结构替代排除（遍历被下层确定性代码承载时不判循环）**：原文"逐个处理 X 族成员"的遍历若由被引代码结构在进程内完成（原文点名"由 registry/总入口统一调度""新增成员只需注册"这类信号）,判 false——产物该落一步 act 调那个总入口,硬拆成 loop 是杜撰不是忠实（拆出来的成员清单是代码某一刻的快照,代码侧增删成员后 spec 即失真;实撞:检测器族语料的遍历由 registry.js 承载,正确产物是一步 act 调总入口,判 false 理由写"遍历被 <入口> 结构承载"并记研判点台账）。**产完计划同样当场对账覆盖**（遍历对象+循环体行号段对照 node_source 行号全集算减法——缺口不下发,规矩同判定 1 切段规矩首条;5.2 机械对账再算一遍,漏行当场打回）。引擎已自动注入（doc-ref）：
[[split-patterns#分支与循环判据]]

#### 5.2. [check] 行号覆盖机械对账（D76④,与 1.2 同款）
- ← loop_hit, loop_plan, node_source
+ → lp_cov_ok: bool  # 判定槽（未命中恒过）
+ → lp_cov_note: text  # 说明槽（坏段/漏行/越界清单回填）

纯机械判定,body 由引擎直接执行、不经 LLM（判定逻辑与 1.2 逐行同款,输入换 loop_hit/loop_plan）：
> ```hop_python
> toks = [strip(t) for t in split(replace(replace(loop_plan, "|", " "), "\n", " "), " ")]
> raw_segs = [t for t in toks if startswith(t, "L") and "-L" in t]
> stripped = [replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(s, "0", ""), "1", ""), "2", ""), "3", ""), "4", ""), "5", ""), "6", ""), "7", ""), "8", ""), "9", "") for s in raw_segs]
> segs = [raw_segs[i] for i in range(len(raw_segs)) if stripped[i] == "L-L"]
> bad_segs = [raw_segs[i] for i in range(len(raw_segs)) if stripped[i] != "L-L"]
> src_nums = [int(split(split(l, ":")[0], "L")[1]) for l in split(node_source, "\n") if startswith(l, "L") and ":" in l]
> seg_starts = [int(split(split(s, "-")[0], "L")[1]) for s in segs]
> seg_ends = [int(split(split(s, "-")[1], "L")[1]) for s in segs]
> missing = [n for n in src_nums if not any([(seg_starts[i] <= n) and (n <= seg_ends[i]) for i in range(len(segs))])]
> alien = [segs[i] for i in range(len(segs)) if (seg_starts[i] not in src_nums) or (seg_ends[i] not in src_nums)]
> lp_cov_ok = (not loop_hit) or (len(raw_segs) > 0 and len(bad_segs) == 0 and len(missing) == 0 and len(alien) == 0)
> lp_cov_note = "" if lp_cov_ok else ("计划里扫不出任何行号段——每条计划的范围位必须写 L<起>-L<止> 形态,行号从 node_source 行首直接读" if len(raw_segs) == 0 else "") + (" | 格式坏的行号段(须 L数字-L数字 形态): " + join(bad_segs, ", ") if bad_segs else "") + (" | 无归属的原文行号(漏行——补条目或并入邻条): " + str(missing) if missing else "") + (" | 越界行号段(引用了本节点原文没有的行): " + join(alien, ", ") if alien else "")
> ```

### 6. [branch] 循环命中 → 分拆并返回
+ → fragment_path: line  # 同 2——子树片段的文件路径
+ → tier: enum(hop, mixed)  # 同 2

#### 6.1. [case(loop_hit)] 委托结构执行机,产出即返回
##### 6.1.1. [call split-structure(split_kind: "loop", split_plan: loop_plan, node_task, node_source, parent_context, parent_vars, depth, max_depth, header_final, judgement_log)] 循环骨架→三检→递归→拼装
+ → fragment_path: fragment_path  # 收取（值是路径——D78）
+ → tier: tier  # 收取
##### 6.1.2. [exit] 判完即返回

### 7. [reason] 原子判定与未尽分型：是不是自足单步?类型?可否带 body?不中落哪档?
- ← node_task, node_source, parent_context, header_final
+ → atomic_hit: bool  # 是否自足可执行的单步（四条判据见下方执行说明）
+ → atomic_type: line  # 命中时=认领的类型（reason/act/act free/commit/check/confirm/ask 之一——"act free"=工具操作与推理搅在一起拆不开的自由任务档,写进片段就是 `[act free]`）;未命中时=一句说明哪条判据没过
+ → body_fit: bool  # 能否带 hop_python 代码 body（判据见下方执行说明）
+ → fallback_plan: text  # atomic_hit=false 时的未尽原子分型方案（首行"档位:1|2|3";档1/档2 必须列出要剥出单独成步的动作原句——"剥出commit: <原文那句>"/"剥出ask: <原文那句>";再一行说明其余部分落什么形态）;atomic_hit=true 时固定写 "-"

一次判四问,前三问是同一判别面的三个切面（"是否纯机械"既决定 act/reason 认领又决定能否带 body,分开判必重复）;第四问（不中落哪档）也在本步一并出——**分型与判定同一次解剖,不留给后步重判**（实撞:旧形态判定与分型分两步各自独立分析,本步明写"含不可逆写盘须剥 commit",分型步重新判断时却交了无 commit 的单步 [act free]——同一实例前后自相矛盾;解剖只做一次,矛盾在结构上就不会发生）。

**fallback_plan 三档分型判据**（atomic_hit=false 时按内容定档,自上而下第一个命中即是——档位判据的细节与成文模板见步骤 9,本步只出方案）：档1=含不可逆动作或交付写盘（header 约束点名"不可撤销",或原文点名发送/支付/写生产/删除,**或原文承诺把交付物保存为文件**）→ 剥 commit;**判"本节点无需 commit"之前必须先回 node_source 扫交付动词**（正典词表=主流程机械体检的交付动词表,举例:写入/保存/落盘/发送/提交/部署/删除/发布/输出到）——不回原文扫,"无"是猜的不是查的（实撞两轮:原文明写"保存为 presentation.html",判定器两次判"原文无写盘动作"放行,交付语义蒸发到终检才现形）;扫到动词而交付确实由兄弟/父层节点承接的,记研判点台账点名承接处,不许静默判无;**剥出的 commit 命令生成期定不死时**（哪台机器/跑什么要看现场）,方案写备料/提交分离形态——备料段产精确执行清单文件（交付路径变量）,剥出行写「剥出commit: 按人批清单执行 <原文那句>」并加一行「剥出confirm: 呈清单人批」（confirm 前置机械读步把清单文件读入文本变量作 confirm 输入——present_inputs 是 ask 专属属性 confirm 不收,confirm 呈人的就是它声明的输入值）（形态样板见 split-patterns「备料/提交分离」节——commit body 仍静态定死为读清单逐条执行,不许因定不死就把提交语义留在 free 的描述里）;**范围含门禁句时**（「必须 X 才能 Y」形态,动作句台账的门禁语汇行为底册——D87）,方案加写证据契约：原子交付物加结构化门禁证据（检查名/PASS-FAIL/证据路径,体量大走 work_zone 文件交付路径变量）,并写明「骨架需补 [check] 步消费证据判定」——门禁判定回引擎强制,执行细节留原子后延（形态样板见 split-patterns「门禁证据分离」节）;档2=含交互闸门（AskUserQuestion/人工确认/问人要值）→ 剥 ask/confirm;档3=其余（先试 body 再落 free,纯推理才 reason）。

**atomic_hit 四条判据,全过才 true**：

- 类型按动词可认领（分析→reason,取放→act,发送→commit…按探索范式的步骤定型）;
- 一步一动作——数的是**执行动作**不是产出个数（一次推理给出多个结论仍是一步;"给人过目并确认"是一个 ask,不是"展示+确认"两步）;
- 输入输出可声明;
- 描述一两句话装得下。

**body_fit 判据**：atomic_hit 为 true、类型是 act/commit/check、且动作纯机械（零推理零裁量）才 true。**"纯机械"与"写不出签名"之间有一个容易漏判的中间档——半确定性操作**（hopissues/0088 实撞:SDD 迁移 workflow 实测 19 个字段断裂点,95% 本质确定却被误落 act free）：字段本身确定（要取哪些字段客观存在）,只是原文散文散落没给清单——这类**先提炼字段清单再写 act body 机械组装**,不落 free;确需落 free 的（取什么要看现场）,说明里必须显式列出下游要消费的全部字段名（硬纪律:下游 body 的每个 get 字段名必须能回溯到原文或上游说明的显式出处,凭空构造=下游按固定名校验、上游 AI 猜名,一猜错整链 blocked）。**写 body 时的返回值形态规矩**：body 里调 exists/listdir/树编辑件这类**速查表标注"返回 JSON 文本"的工具**,拿到的是 JSON 字符串不是结构值——必须 `parse_json(...)` 包裹后再取字段（`probe = parse_json(exists(path: p))` 然后 `probe["exists"]`;裸取下标是在字符串上取下标,运行期直接炸——实撞:构建产物裸用 exists 取 ["exists"],真机一击即死;速查表工具行逐件标注了哪些返回 JSON 文本）。统计/求和/取最值/读写文件/拼接这类白名单一行操作,一律 true——写成代码 body 后引擎直接执行、不再调 LLM,这正是机械步的价值;含语义裁量（措辞生成、内容判断）才 false。**commit 尤其要带 body**：不可逆动作正是最不能交给 LLM 现场发挥的动作——发送什么、写到哪,都该在生成期定死。**判 true 的前提是 body 写得出真签名**（工具名/参数/次数生成期能定死）——工具时机次数要看现场的（搜索/发射 Agent/逐个验证不定数量的文件）,judged false 落 free,不要为了凑 body_fit 写假赋值（假 body 判据见知识库降格判据条）。

**禁令与义务句的落型（定型时消费——两类句子的产物形态不同,混落即语义降档）**：原文的**禁令**（"绝不/永远不要/Never"）按强度三档认领——最强=结构性禁止（产物形态上写不出违规,如不给那一步声明工具面/不设那条路径——引擎跳不过的结构强于任何提醒）;次强=check 判据（违规产出过不了验收）;最弱=步骤说明里的强语气提醒（仅当前两档形态上落不了才用,并记研判点台账）。**义务句与门禁句分开双落点**：义务句（"必须做 X"——规定一个动作要发生）落执行步,门禁句（"必须 X 才能 Y"——规定一个前置条件）落 check 判据——义务句错落成 check 就变成了"查有没有做"而不是"做",门禁句错落成执行步就变成了"无条件做 Y"。

**载体能力边界——原文写"发 subagent"时的强制转译（2026-09-01 dr21 十七连跑实撞立规）**：原文出现 "launch agents"、"派 subagent"、"Task 工具"、"run_in_background" 这类**宿主 agent 能力**的说法时,不许照原文直译成"写指令卡、等带 Agent 工具的执行者去发射"——产物 spec 的执行者可能是纯 API 调用的 standalone 载体,没有 Agent 工具,指令卡永远不会变成真实子实例（实撞:审查员发射段照原文翻成四层递进强制触发发射卡,执行到"等待全部审查员完成"一步空等 20 轮工具循环耗尽,整个 run 终局失败）。正确翻法是 HopSpec 原生的跨实例形态,与载体无关：**并行成员**（原文说同时发 N 个）→ 每个成员一份独立子 spec,主 spec 里循环体内 `[call 子spec(参数映射) parallel]` 逐个派发（引擎原生并行子实例,循环出口自动收齐）;**汇聚类成员**（要读全部前序成员产出的,如汇总/交叉验证角色）→ 前序收齐后串行 `[call 子spec(...)]`。子 spec 的形态样板见 examples/hop-doc-review2/reviewer-worker.md（自包含指令+审查材料+落盘目录+文件名四输入,内部 check 把关+commit 写盘出回执——一份子 spec 可被不同角色复用,角色差异全在指令参数里）。本节点原文含此类语义时,原子判定不认领单步——按结构分拆走,把"每个成员干什么"剥成子 spec 的输入参数。

引擎已自动注入（doc-ref）：
[[split-patterns#subtask 探索范式（步骤定型与事务形态）]]
[[split-patterns#hop_python 降格判据]]

### 8. [branch] 原子命中 → 按 body_fit 细分落定并返回
+ → fragment_path: line  # 同 2——单步片段的文件路径
+ → tier: enum(hop, mixed)  # 同 2

#### 8.1. [case(atomic_hit and body_fit)] 带 body 落定（纯机械——执行期零 LLM）
##### 8.1.1. [subtask retry=2] 写 body 并验证
- ← node_task, node_source, parent_context, header_final, judgement_log
+ → fragment: text  # 单步片段（带 body;验证耗尽兜底=无 body 原子步）

###### 8.1.1.1. [reason] 写出带 hop_python body 的单步
- ← node_task, node_source, parent_context, header_final, atomic_type
+ → fragment: text  # `1. [<atomic_type>] <描述>` + hop_python body（白名单内置+已声明工具;中间产物路径经 work_zone_path();裸片段直出——首字符即 `1`,不加围栏不写前言后语）

body 每一行对得上 node_source 的动作,无添漏（check 型=bool/text 双槽判定逻辑与原文判据一致）;`- ←`/`+ →` 声明按片段语法速查成文,IO 变量从 parent_context 清单选真名。引擎已自动注入（doc-ref）：
[[split-patterns#hop_python 文法速查（写 body 必读）]]
[[split-patterns#HopSpec 片段语法速查（骨架成文必读）]]
[[split-patterns#hop_python 降格判据]]
[[split-patterns#骨架成文纪律（占位/编号/裸片段直出）]]

###### 8.1.1.2. [act] 语法机械核
- ← fragment, header_final, parent_vars
+ → fragment: text  # 剥壳后片段
+ → body_syntax: text  # validate JSON 输出

纯机械,body 由引擎直接执行、不经 LLM。known_vars 必须并入 parent_vars——片段里引用父层骨架产出的变量是正常形态,漏了它们,校验会把合法引用误报成"未定义变量"：
> ```hop_python
> fragment = strip_fence(fragment, "fragment")
> known_names = [i.name for i in header_final.inputs] + parent_vars
> body_syntax = validate_spec(text: fragment, fragment: true, known_vars: known_names)
> ```

###### 8.1.1.3. [check final] 语法与语义等价关
- ← body_syntax, fragment, node_source
+ → lower_ok: bool  # 判定槽
+ → lower_note: text  # 说明槽（不过回填 retry 重写）

三面核：validate errors 空;body 与 node_source 描述等价（每行对得上原文动作,无添漏——判据见注入的降格判据末条:不等价就该撤销,诚实的 NL 好过错误的 body）;**禁假 body**——遮住步骤描述只看 body,它真做了那件事吗?把任务描述赋成字符串字面量、凑假状态对象冒充产出的,打回（假 body 能骗过语法关,但产出假数据流给下游——判据见降格判据"禁假 body"条）。引擎已自动注入（doc-ref）：
[[split-patterns#hop_python 降格判据]]

###### 8.1.1.4. [on fail] 撤销带 body 落定
####### 8.1.1.4.1. [act] 落定为无 body 原子步
- ← node_task, judgement_log
+ → fragment: text  # 无 body 的原子步（该动作没想象中机械——记档撤销,描述用原文;诚实的 NL 描述好过错误的 body）

纯机械,body 由引擎直接执行、不经 LLM：
> ```hop_python
> append(path: judgement_log, content: "撤销带body落定:" + node_task + "\n")
> fragment = "1. [act] " + node_task
> ```

##### 8.1.2. [act] 片段落盘定档并返回
- ← fragment
+ → fragment_path: line  # 片段文件路径（本实例 work_zone 涂鸦区——值是路径,父层按它机械读,片段全文不过变量通道〔D78〕）
+ → tier: enum(hop, mixed)  # 固定为 hop（类型已认领,是完全结构化的步骤）

纯机械,body 由引擎直接执行、不经 LLM：
> ```hop_python
> write(path: work_zone_path("fragment.md"), content: fragment)
> fragment_path = work_zone_path("fragment.md")
> tier = "hop"
> ```

##### 8.1.3. [exit] 判完即返回

#### 8.2. [case(atomic_hit)] 无 body 落定（reason/confirm/ask 型,或 act 族含裁量）
##### 8.2.1. [subtask retry=2] 成文单步并机械核
- ← node_task, node_source, parent_context, parent_vars, atomic_type, header_final
+ → fragment: text  # 通过语法核的单步片段

###### 8.2.1.1. [reason] 成文单步
- ← node_task, node_source, parent_context, atomic_type
+ → fragment: text  # 单步片段：`1. [<atomic_type>] <一句任务描述>` + `- ←`/`+ →` 声明 + 必要执行说明（atomic_type 是 "act free" 时步骤行写 `1. [act free] …`）。变量名从 parent_context 清单里选真名（杜撰的名字、自造的类型过不了下一步机械核）;reason 型步骤没有工具,它需要的材料要在 `- ←` 里全部声明进来;裸片段直出（首字符即 `1`,不加围栏）

引擎已自动注入（doc-ref）：
[[split-patterns#HopSpec 片段语法速查（骨架成文必读）]]
[[split-patterns#骨架成文纪律（占位/编号/裸片段直出）]]

###### 8.2.1.2. [act] 语法机械核
- ← fragment, header_final, parent_vars
+ → fragment: text  # 剥壳后片段
+ → atom_syntax: text  # validate JSON 输出

纯机械,body 由引擎直接执行、不经 LLM（与 8.1 带 body 路径同一道校验——没有这道核,单步里杜撰的变量名、不合法的类型会一路漏进最终产物）：
> ```hop_python
> fragment = strip_fence(fragment, "fragment")
> known_names = [i.name for i in header_final.inputs] + parent_vars
> atom_syntax = validate_spec(text: fragment, fragment: true, known_vars: known_names)
> ```

###### 8.2.1.3. [check final] 语法关
- ← atom_syntax
+ → atom_ok: bool  # 判定槽
+ → atom_note: text  # 说明槽（error 清单回填,重跑轮定向修正）

纯机械判定,body 引擎直执零 LLM：
> ```hop_python
> atom_ok = '"errors":[]' in atom_syntax
> atom_note = "" if atom_ok else atom_syntax
> ```

##### 8.2.2. [act] 片段落盘定档
- ← fragment
+ → fragment_path: line  # 片段文件路径（本实例 work_zone 涂鸦区——值是路径,父层按它机械读〔D78〕）
+ → tier: enum(hop, mixed)  # 固定为 hop（类型已认领,是完全结构化的步骤）

纯机械,body 由引擎直接执行、不经 LLM：
> ```hop_python
> write(path: work_zone_path("fragment.md"), content: fragment)
> fragment_path = work_zone_path("fragment.md")
> tier = "hop"
> ```

##### 8.2.3. [exit] 判完即返回

### 9. [reason] 全不中 → 按步骤 7 的分型方案成文（合法交付档非缺陷——复用模式可跑）
- ← node_task, node_source, parent_context, header_final, fallback_plan
+ → fragment: text  # 未尽原子片段（裸片段直出——首字符即 `1`,不加围栏）

**照 fallback_plan 成文,不重新判档**：档位与要剥出的动作句步骤 7 已定,你的活是按方案套对应模板写出片段——方案说"剥出commit: <某句>",片段里就必须有以那句为描述的 [commit] 步;方案说剥 ask 同理（实撞:旧形态本步独立重判,前判明写"须剥 commit"本步却交无 commit 的单步——判断只在步骤 7 做一次,本步照方案渲染,矛盾在结构上灭绝）。方案与你读到的 node_source 明显冲突时（如方案要剥的句子原文里不存在）,按原文修正并在片段成文后继续——不空转不打回。**fallback_plan 是 "-" 或空**（占位符,正常执行不该出现——重跑轮变量留存可能带进来）：不把 "-" 当方案,按步骤 7 写明的三档判据对 node_source 现判现写,判出哪档就套哪档的模板成文。

拆不动的节点以自然语言步骤落定,但**落成什么类型要看节点内容,不是一律 [reason]**（把含工具操作/外部影响的任务落成 reason,等于把它的工具面全部吞掉——reason 无工具,执行期干不了活）。三档成文模板：

1. **含不可逆动作或交付写盘**（header 约束点名"不可撤销/不可修改",或原文点名发送/支付/写生产/删除类动作;**或原文承诺把交付物保存为文件**——"保存为 xxx.html/写入 xxx 文件"这类交付写盘动作同归此档:交付落盘是对外交付的提交语义,落在 [act free] 里=执行期要么违反角色档禁令写盘、要么不写盘违反原文,两头堵）→ 探索范式三件套,**commit 从描述里剥出来单独成步**（[act free] 不得承载提交语义——不可逆归 commit,这是红线）：

```
1. [subtask retry=2] <节点任务描述（不含提交动作的部分）>
  + → <交付变量>: <类型>  # <说明>
  1.1. [act free] <探索与准备:原描述中提交之前的全部工作>
    - ← <所需输入>
    + → <中间产物>: <类型>  # <说明>
  1.2. [check final] 验收<交付物达标条款,按原文/约束写判据>
    + → ok: bool  # 过没过
    + → note: text  # 没过在哪
  1.3. [commit] <原描述中的不可逆动作那一句>
    - ← <中间产物>
    + → <交付变量>: <类型>  # <说明>
```

2. **含交互闸门**（原文有 AskUserQuestion/人工确认/问人要值——见知识库"交互闸门"条目）→ **ask/confirm 步剥出来保留**,其余工作落 [act free]（闸门落成别的类型=把"问人"偷换成"机器替人答",语义蒸发最重的一种——不因兜底豁免）：

```
1. [act free] <闸门之前的准备工作描述>
  + → <呈审材料>: <类型>  # <说明>
2. [ask] <原文的问人内容>（或 [confirm],按"给值/放行"判——细则见知识库交互闸门条目）
  - ← <呈审材料>
  + → <用户应答>: <类型>  # <说明>
3. [act free] <闸门之后的工作描述>（无后续工作则省略本步）
  - ← <用户应答>
  + → <交付变量>: <类型>  # <说明>
```

3. **其余先试 body 再落 free**：动作确定、签名写得出来（文件读写/复制/文本替换/拼接/按固定参数调已声明工具——read/write/edit_file 十件是 hop_python 内置函数恒可用）→ `1. [act] <描述>` 带 hop_python body,执行期零 LLM;真写不出确定签名（要用哪些工具得看现场）→ 单步 `1. [act free] <节点任务描述>`;**纯推理**（不碰工具不碰外部,只分析判断生成）→ 才是 `1. [reason] <节点任务描述>`。三选一判据与 body 写法见注入的文法速查——"涉及文件 IO"不是落 free 的理由。

**[act free] 步用到 tools_available 里的外部工具时,必须给该步写工具授权行** `- 工具: 工具名  # 本步用它做什么`（每工具一行,位置在 `- ←`/`+ →` 之后、执行说明之前）——引擎按节点声明下发工具面,不写这行该工具执行期就不在本步可用面里,执行 LLM 合规空转（静默产空结果,不报错）。带 body 的 act 不需要（body 直接调用）;引擎内置文件十件不需要（恒可用）。格式与边界细则见注入的片段语法速查"工具授权行"条。

各步 `- ←`/`+ →` 从 parent_context 变量清单选真名;占位行带 `+ →` 声明的,交付变量名照占位契约不换名。引擎已自动注入（doc-ref）：
[[split-patterns#hop_python 文法速查（写 body 必读）]]

### 10. [act] 片段落盘、记台账并定档
- ← fragment, node_task, atomic_type, judgement_log
+ → fragment_path: line  # 片段文件路径（本实例 work_zone 涂鸦区——值是路径,父层按它机械读〔D78〕）
+ → tier: enum(hop, mixed)  # 固定为 mixed（本节点以自然语言步骤落定,产物含未完全结构化的部分）

纯机械,body 由引擎直接执行、不经 LLM（台账会随终审呈给作者知情,不是请求修复）：
> ```hop_python
> write(path: work_zone_path("fragment.md"), content: fragment)
> fragment_path = work_zone_path("fragment.md")
> append(path: judgement_log, content: "未尽原子:" + node_task + "|" + atomic_type + "\n")
> tier = "mixed"
> ```

### 11. [exit] 返回片段路径与档位
