# Spec: split-node — 递归等价分拆一个 NL 节点
Id: split-node

## Task

Goal: 对一个 NL 节点按优先级逐个判定（顺序→分支→循环），判完一个返回一个——命中即产出片段并 exit；三结构判全不中即叶子,不做单步认领判定,一律按内容三档分型落定为探索-核验-提交三件套（含不可逆→剥 commit;含闸门→保 ask/confirm;其余→act free 探索+check 核验成对,纯推理的探索半边落 reason）。结构分拆委托 split-structure
> 每遍语义等价只改表示形态。"明确"是硬门槛：每个判定只回答一个问题,拿不准=false 落下一判。能走到判定 N 说明前面判全没中——顺序即逻辑,零短路传参。终态两档都合法：hop（全结构化,双模式皆稳）/ mixed（含未尽原子——所需引擎外能力经 Tools 段声明即可跑,拆解不了的最终态也有价值,不硬拆）。

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
- iteration: int  # 分拆迭代序数（根拆=1,子节点拆=2;迭代闸:≥3 时三结构判恒不命中直接落叶——渐进的粗粒度上界,与 depth 深度闸各拦各的:深度管产物嵌套形态,迭代管构建轮数）
- max_depth: int  # 产物嵌套深度上限（缺省 3——split-structure 1.3 深度闸按它机械拦,本 spec 原样透传）
- target_profile: line  # 目标执行档（空串=通用形态;qwen3.8-27b=产物给该档模型跑——步骤 7/8 按「目标执行档规则」选把关形态与步骤尺寸,递归原样透传）
- header_final: yaml  # 已对齐的头部契约（goal/inputs/outputs/constraints/tools_available——工具引用只许在其面内）
- judgement_log: line  # 研判点台账路径（workspace 相对路径,或引擎涂鸦区绝对路径〔work_zone 是绝对路径禁令唯一豁免〕;其余绝对路径工具面拒;全树共写一份,append 契约文件不存在则创建）

Outputs:
- fragment_path: line  # 本节点子树 HopSpec 片段的文件路径（work_zone 涂鸦区文件——值是路径不是内容,片段全文不过变量通道;内容=编号相对从 1 起的片段,NL 子节点已被递归结果替换）
- tier: enum(hop, mixed)  # 子树档位：hop=全 hop 化;mixed=含未尽原子（工具面依赖档——standalone 声明齐即可跑）

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
- **一次拆分不超过 5 个子节点,范围内尽量当场拆到位**——能定型的子节点直接写类型,不切成两半留 NL 等下一层;**本节点原文少于约 800 字的,不再分拆**（整节点判 false 落叶,走叶子分型按三件套落定——小节点再递归一层的成本比直接写完还高;这是主动停拆判据不只是防切香肠下限,详见知识库"拆分粒度四条硬规则"）;**本节点 depth 距 max_depth 只剩一层时,倾向当场全部定型、不留 NL 占位**——留了占位,子层片段的顶层步骤就落在超限层,会被 split-structure 1.3 深度闸机械打回（教学在此,硬闸在机械检;定型不了的直接落自然语言步骤,不再递归）;
- **只切流程,材料不拆**——流程=要执行的动作序列;材料=被动作使用的内容（规格/示例/模板/清单）,不进子节点清单但不丢,随所属步骤的执行说明引用走;一段里两种成分并存时,只把动作切出来（概念与实例见注入的知识库节）;**材料段与附属文件里的门禁句例外**——"必须…才能/不得…除非/通过…后方可"这类有过/不过语义的句子是流程性内容,所在段落再像材料也要让它有行号归属、后续拎成显式 check 落点（细节留材料,拎的只是把关句）。**门禁与排障心法分得开**：同是文件尾清单,有过/不过语义的是门禁要拎;"遇到 X 可以试试 Y"的经验心法是参考材料,随执行说明引用即可不拎——按语义分不按位置分;
- **计划条目点名具体外部工具时,先对照 header_final.tools_available**——工具在清单内才可写进计划;不在清单内（含清单为空）,这段动作就是作者在对齐门裁掉的能力,按"header_final 盖过原文"跳过该段,记 log_notes 一条"原文含 X,已按对齐契约裁剪"（实撞:tools_available 已被作者清空,计划仍写"用 Puppeteer 导出"——下游骨架照计划成文无权自裁,被裁能力一路活进最终产物）;
- 含不可逆动作/达标要求的段落：commit 段单列、放在验收段之后（形态细则归 split-structure,此处只管切段）;**门禁+补救动作的复合句**（"抽查发现系统性错误后重跑同类全部记录"这类判定与补救连写的句子）——判定半边拎成 check,补救半边优先落 retry 容器回路（check 不过带反馈整组重跑,补救语义由重跑承载）;容器粒度粗于原文动作粒度时如实记研判点台账,不硬造步骤也不静默丢弃;
- 子节点"当场可定型写类型"从紧：一步一动作、描述一两句装得下、无内部交互闸门,才直接写类型;**阶段级段落（含多个规定子步骤/问人闸门/复合序）必标 NL** 交给递归——标单个类型等于把一章压成一行;拿不准标 NL。

引擎已自动注入（doc-ref）：
[[split-patterns#subtask 探索范式（步骤定型与事务形态）]]

#### 1.2. [check] 行号覆盖机械对账（漏行/越界当场打回,有权修计划的层自己重产计划,缺口不下发）
- ← seq_hit, seq_plan, node_source, iteration
+ → seq_cov_ok: bool  # 判定槽（未命中恒过——无计划即无对账对象）
+ → seq_cov_note: text  # 说明槽（坏段/漏行/越界清单回填,重跑轮重产计划）

纯机械判定,body 由引擎直接执行、不经 LLM。计划各条行号段并集必须盖住 node_source 全部行：从计划文本扫出全部 `L<起>-L<止>` 形态的行号段,与 node_source 各行行首号做减法——漏行=那段原文没有归属条目,下游那段流程不会被翻译;越界=引用了本节点原文里不存在的行号,切片会切空。命中却扫不出任何行号段、或段格式坏（非 L数字-L数字）同判不过：
> ```hop_python
> toks = [strip(t) for t in split(replace(replace(seq_plan, "|", " "), "\n", " "), " ")]
> raw_segs = [t for t in toks if startswith(t, "L") and "-L" in t]
> stripped = [replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(s, "0", ""), "1", ""), "2", ""), "3", ""), "4", ""), "5", ""), "6", ""), "7", ""), "8", ""), "9", "") for s in raw_segs]
> halves = [split(s, "-") for s in raw_segs]
> well_formed = [len(h) == 2 and len(strip(replace(h[0], "L", ""))) > 0 and len(strip(replace(h[1], "L", ""))) > 0 for h in halves]
> segs = [raw_segs[i] for i in range(len(raw_segs)) if stripped[i] == "L-L" and well_formed[i]]
> bad_segs = [raw_segs[i] for i in range(len(raw_segs)) if stripped[i] != "L-L" or not well_formed[i]]
> src_nums = [int(split(split(l, ":")[0], "L")[1]) for l in split(node_source, "\n") if startswith(l, "L") and ":" in l]
> seg_starts = [int(split(split(s, "-")[0], "L")[1]) for s in segs]
> seg_ends = [int(split(split(s, "-")[1], "L")[1]) for s in segs]
> missing = [n for n in src_nums if not any([(seg_starts[i] <= n) and (n <= seg_ends[i]) for i in range(len(segs))])]
> alien = [segs[i] for i in range(len(segs)) if (seg_starts[i] not in src_nums) or (seg_ends[i] not in src_nums)]
> # @a: anc-build-shallow-split —— D92 迭代闸豁免判(D93 勘误:原对 seq_hit 的赋值是死写——check 步只收割声明输出,变量空间不回写;闸真身在 case 条件位,此处仅算覆盖对账豁免——闸压住的轮次结构路不走,计划质量无对账义务)
> gated_seq_hit = seq_hit and (iteration <= 2)
> seq_cov_ok = (not gated_seq_hit) or (len(raw_segs) > 0 and len(bad_segs) == 0 and len(missing) == 0 and len(alien) == 0)
> seq_cov_note = "" if seq_cov_ok else ("计划里扫不出任何行号段——每条计划的范围位必须写 L<起>-L<止> 形态,行号从 node_source 行首直接读" if len(raw_segs) == 0 else "") + (" | 格式坏的行号段(须 L数字-L数字 形态): " + join(bad_segs, ", ") if bad_segs else "") + (" | 无归属的原文行号(漏行——补条目或并入邻条): " + str(missing) if missing else "") + (" | 越界行号段(引用了本节点原文没有的行): " + join(alien, ", ") if alien else "")
> ```

### 2. [branch] 顺序命中 → 分拆并返回
+ → fragment_path: line  # 命中时由 case 赋值——子树片段的文件路径（未命中静默跳过,不写值）
+ → tier: enum(hop, mixed)  # 同上

#### 2.1. [case(seq_hit and iteration <= 2)] 委托结构执行机,产出即返回（迭代闸真身在条件位——第 3 迭代结构判恒不命中直接落叶）
##### 2.1.1. [call split-structure(split_kind: "seq", split_plan: seq_plan, node_task, node_source, parent_context, parent_vars, depth, max_depth, iteration, target_profile, header_final, judgement_log)] 顺序骨架→三检→递归→拼装
+ → fragment_path: fragment_path  # 收取子树片段的文件路径（值是路径不是内容）
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

#### 3.2. [check] 行号覆盖机械对账（与 1.2 同款）
- ← branch_hit, branch_plan, node_source, iteration
+ → br_cov_ok: bool  # 判定槽（未命中恒过）
+ → br_cov_note: text  # 说明槽（坏段/漏行/越界清单回填）

纯机械判定,body 由引擎直接执行、不经 LLM（判定逻辑与 1.2 逐行同款,输入换 branch_hit/branch_plan）：
> ```hop_python
> toks = [strip(t) for t in split(replace(replace(branch_plan, "|", " "), "\n", " "), " ")]
> raw_segs = [t for t in toks if startswith(t, "L") and "-L" in t]
> stripped = [replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(s, "0", ""), "1", ""), "2", ""), "3", ""), "4", ""), "5", ""), "6", ""), "7", ""), "8", ""), "9", "") for s in raw_segs]
> halves = [split(s, "-") for s in raw_segs]
> well_formed = [len(h) == 2 and len(strip(replace(h[0], "L", ""))) > 0 and len(strip(replace(h[1], "L", ""))) > 0 for h in halves]
> segs = [raw_segs[i] for i in range(len(raw_segs)) if stripped[i] == "L-L" and well_formed[i]]
> bad_segs = [raw_segs[i] for i in range(len(raw_segs)) if stripped[i] != "L-L" or not well_formed[i]]
> src_nums = [int(split(split(l, ":")[0], "L")[1]) for l in split(node_source, "\n") if startswith(l, "L") and ":" in l]
> seg_starts = [int(split(split(s, "-")[0], "L")[1]) for s in segs]
> seg_ends = [int(split(split(s, "-")[1], "L")[1]) for s in segs]
> missing = [n for n in src_nums if not any([(seg_starts[i] <= n) and (n <= seg_ends[i]) for i in range(len(segs))])]
> alien = [segs[i] for i in range(len(segs)) if (seg_starts[i] not in src_nums) or (seg_ends[i] not in src_nums)]
> # @a: anc-build-shallow-split —— D92 迭代闸豁免判(D93 勘误:原对 branch_hit 的赋值是死写——check 步只收割声明输出,变量空间不回写;闸真身在 case 条件位,此处仅算覆盖对账豁免——闸压住的轮次结构路不走,计划质量无对账义务)
> gated_branch_hit = branch_hit and (iteration <= 2)
> br_cov_ok = (not gated_branch_hit) or (len(raw_segs) > 0 and len(bad_segs) == 0 and len(missing) == 0 and len(alien) == 0)
> br_cov_note = "" if br_cov_ok else ("计划里扫不出任何行号段——每条计划的范围位必须写 L<起>-L<止> 形态,行号从 node_source 行首直接读" if len(raw_segs) == 0 else "") + (" | 格式坏的行号段(须 L数字-L数字 形态): " + join(bad_segs, ", ") if bad_segs else "") + (" | 无归属的原文行号(漏行——补条目或并入邻条): " + str(missing) if missing else "") + (" | 越界行号段(引用了本节点原文没有的行): " + join(alien, ", ") if alien else "")
> ```

### 4. [branch] 分支命中 → 分拆并返回
+ → fragment_path: line  # 同 2——子树片段的文件路径
+ → tier: enum(hop, mixed)  # 同 2

#### 4.1. [case(branch_hit and iteration <= 2)] 委托结构执行机,产出即返回（迭代闸真身在条件位——第 3 迭代结构判恒不命中直接落叶）
##### 4.1.1. [call split-structure(split_kind: "branch", split_plan: branch_plan, node_task, node_source, parent_context, parent_vars, depth, max_depth, iteration, target_profile, header_final, judgement_log)] 分支骨架→三检→递归→拼装
+ → fragment_path: fragment_path  # 收取（值是路径）
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

#### 5.2. [check] 行号覆盖机械对账（与 1.2 同款）
- ← loop_hit, loop_plan, node_source, iteration
+ → lp_cov_ok: bool  # 判定槽（未命中恒过）
+ → lp_cov_note: text  # 说明槽（坏段/漏行/越界清单回填）

纯机械判定,body 由引擎直接执行、不经 LLM（判定逻辑与 1.2 逐行同款,输入换 loop_hit/loop_plan）：
> ```hop_python
> toks = [strip(t) for t in split(replace(replace(loop_plan, "|", " "), "\n", " "), " ")]
> raw_segs = [t for t in toks if startswith(t, "L") and "-L" in t]
> stripped = [replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(s, "0", ""), "1", ""), "2", ""), "3", ""), "4", ""), "5", ""), "6", ""), "7", ""), "8", ""), "9", "") for s in raw_segs]
> halves = [split(s, "-") for s in raw_segs]
> well_formed = [len(h) == 2 and len(strip(replace(h[0], "L", ""))) > 0 and len(strip(replace(h[1], "L", ""))) > 0 for h in halves]
> segs = [raw_segs[i] for i in range(len(raw_segs)) if stripped[i] == "L-L" and well_formed[i]]
> bad_segs = [raw_segs[i] for i in range(len(raw_segs)) if stripped[i] != "L-L" or not well_formed[i]]
> src_nums = [int(split(split(l, ":")[0], "L")[1]) for l in split(node_source, "\n") if startswith(l, "L") and ":" in l]
> seg_starts = [int(split(split(s, "-")[0], "L")[1]) for s in segs]
> seg_ends = [int(split(split(s, "-")[1], "L")[1]) for s in segs]
> missing = [n for n in src_nums if not any([(seg_starts[i] <= n) and (n <= seg_ends[i]) for i in range(len(segs))])]
> alien = [segs[i] for i in range(len(segs)) if (seg_starts[i] not in src_nums) or (seg_ends[i] not in src_nums)]
> # @a: anc-build-shallow-split —— D92 迭代闸豁免判(D93 勘误:原对 loop_hit 的赋值是死写——check 步只收割声明输出,变量空间不回写;闸真身在 case 条件位,此处仅算覆盖对账豁免——闸压住的轮次结构路不走,计划质量无对账义务)
> gated_loop_hit = loop_hit and (iteration <= 2)
> lp_cov_ok = (not gated_loop_hit) or (len(raw_segs) > 0 and len(bad_segs) == 0 and len(missing) == 0 and len(alien) == 0)
> lp_cov_note = "" if lp_cov_ok else ("计划里扫不出任何行号段——每条计划的范围位必须写 L<起>-L<止> 形态,行号从 node_source 行首直接读" if len(raw_segs) == 0 else "") + (" | 格式坏的行号段(须 L数字-L数字 形态): " + join(bad_segs, ", ") if bad_segs else "") + (" | 无归属的原文行号(漏行——补条目或并入邻条): " + str(missing) if missing else "") + (" | 越界行号段(引用了本节点原文没有的行): " + join(alien, ", ") if alien else "")
> ```

### 6. [branch] 循环命中 → 分拆并返回
+ → fragment_path: line  # 同 2——子树片段的文件路径
+ → tier: enum(hop, mixed)  # 同 2

#### 6.1. [case(loop_hit and iteration <= 2)] 委托结构执行机,产出即返回（迭代闸真身在条件位——第 3 迭代结构判恒不命中直接落叶）
##### 6.1.1. [call split-structure(split_kind: "loop", split_plan: loop_plan, node_task, node_source, parent_context, parent_vars, depth, max_depth, iteration, target_profile, header_final, judgement_log)] 循环骨架→三检→递归→拼装
+ → fragment_path: fragment_path  # 收取（值是路径）
+ → tier: tier  # 收取
##### 6.1.2. [exit] 判完即返回

### 7. [reason] 叶子分型：按内容定三档成文方案（三结构判全不中即叶子,一律三件套落定——不做单步认领判定 ^anc-build-shallow-split）
- ← node_task, node_source, parent_context, target_profile, header_final
+ → leaf_plan: text  # 叶子分型方案（首行"档位:1|2|3";档1/档2 必须列出要剥出单独成步的动作原句——"剥出commit: <原文那句>"/"剥出ask: <原文那句>";再一行说明其余部分落什么形态——探索半边落 act free 还是纯推理 reason、核验 check 的判据要点;target_profile 非空时按「目标执行档规则」节加写该节要求的方案行）

三结构判全不中的节点就是**叶子**——本步不再问"是不是自足单步"（不做单步认领判定:那种形态四问过了就产裸 [reason]/[act] 单步零核验,门禁 check 数低的结构性病根在此）,只做一件事:按内容出三档分型方案。每个叶子一律走步骤 8 的三件套成文（探索-核验-提交/闸门形态——每个叶子天然带把关）。**分型与成文分两步,但判断只在本步做一次**:档位与要剥出的动作句本步定死,步骤 8 照方案渲染不重判（实撞:旧形态判定与分型分两步各自独立分析,前步明写"含不可逆写盘须剥 commit",后步重新判断时却交了无 commit 的单步 [act free]——同一实例前后自相矛盾;解剖只做一次,矛盾在结构上就不会发生）。

**leaf_plan 三档分型判据**（按内容定档,自上而下第一个命中即是——档位判据的细节与成文模板见步骤 8,本步只出方案）：档1=含不可逆动作或交付写盘（header 约束点名"不可撤销",或原文点名发送/支付/写生产/删除,**或原文承诺把交付物保存为文件**）→ 剥 commit;**判"本节点无需 commit"之前必须先回 node_source 扫交付动词**（正典词表=主流程机械体检的交付动词表,举例:写入/保存/落盘/发送/提交/部署/删除/发布/输出到）——不回原文扫,"无"是猜的不是查的（实撞两轮:原文明写"保存为 presentation.html",判定器两次判"原文无写盘动作"放行,交付语义蒸发到终检才现形）;扫到动词而交付确实由兄弟/父层节点承接的,记研判点台账点名承接处,不许静默判无;**剥出的 commit 命令生成期定不死时**（哪台机器/跑什么要看现场）,方案写备料/提交分离形态——备料段产精确执行清单文件（交付路径变量）,剥出行写「剥出commit: 按人批清单执行 <原文那句>」并加一行「剥出confirm: 呈清单人批」（confirm 前置机械读步把清单文件读入文本变量作 confirm 输入——present_inputs 是 ask 专属属性 confirm 不收,confirm 呈人的就是它声明的输入值）（形态样板见 split-patterns「备料/提交分离」节——commit body 仍静态定死为读清单逐条执行,不许因定不死就把提交语义留在 free 的描述里;**原文命令会中途停下来问人的**,按 split-patterns「交互式命令的三分处置」节办:机械确认预喂应答/中途真决策拆步走 ask 停点/拆不开的呈报用户不硬编）;**范围含门禁句时**（「必须 X 才能 Y」形态,动作句台账的门禁语汇行为底册）,方案加写证据契约：原子交付物加结构化门禁证据（检查名/PASS-FAIL/证据路径,体量大走 work_zone 文件交付路径变量）,并写明「骨架需补 [check] 步消费证据判定」——门禁判定回引擎强制,执行细节留原子后延（形态样板见 split-patterns「门禁证据分离」节）;档2=含交互闸门（AskUserQuestion/人工确认/问人要值）→ 剥 ask/confirm;档3=其余（探索 act free+核验 check 成对,纯推理的探索半边才落 reason——首轮探索半边不写 body,body 写作归定向优化轮;commit 例外必带 body,见步骤 8 档1）。

**禁令与义务句的落型（定型时消费——两类句子的产物形态不同,混落即语义降档）**：原文的**禁令**（"绝不/永远不要/Never"）按强度三档认领——最强=结构性禁止（产物形态上写不出违规,如不给那一步声明工具面/不设那条路径——引擎跳不过的结构强于任何提醒）;次强=check 判据（违规产出过不了验收）;最弱=步骤说明里的强语气提醒（仅当前两档形态上落不了才用,并记研判点台账）。**义务句与门禁句分开双落点**：义务句（"必须做 X"——规定一个动作要发生）落执行步,门禁句（"必须 X 才能 Y"——规定一个前置条件）落 check 判据——义务句错落成 check 就变成了"查有没有做"而不是"做",门禁句错落成执行步就变成了"无条件做 Y"。

**载体能力边界——原文写"发 subagent"时的强制转译（真机十七连跑实撞立规）**：原文出现 "launch agents"、"派 subagent"、"Task 工具"、"run_in_background" 这类**宿主 agent 能力**的说法时,不许照原文直译成"写指令卡、等带 Agent 工具的执行者去发射"——产物 spec 的执行者可能是纯 API 调用的 standalone 载体,没有 Agent 工具,指令卡永远不会变成真实子实例（实撞:审查员发射段照原文翻成四层递进强制触发发射卡,执行到"等待全部审查员完成"一步空等 20 轮工具循环耗尽,整个 run 终局失败）。正确翻法是 HopSpec 原生的跨实例形态,与载体无关：**并行成员**（原文说同时发 N 个）→ 每个成员一份独立子 spec,主 spec 里循环体内 `[call 子spec(参数映射) parallel]` 逐个派发（引擎原生并行子实例,循环出口自动收齐）;**汇聚类成员**（要读全部前序成员产出的,如汇总/交叉验证角色）→ 前序收齐后串行 `[call 子spec(...)]`。子 spec 的形态样板见 examples/hop-doc-review2/reviewer-worker.md（自包含指令+审查材料+落盘目录+文件名四输入,内部 check 把关+commit 写盘出回执——一份子 spec 可被不同角色复用,角色差异全在指令参数里）。本节点原文含此类语义时,不落叶——分型方案里写明按结构分拆走（发射语义本质是循环/并行结构,叶子三件套装不下）,把"每个成员干什么"剥成子 spec 的输入参数。

引擎已自动注入（doc-ref）：
[[split-patterns#subtask 探索范式（步骤定型与事务形态）]]

**目标执行档规则（target_profile 非空时叠加生效——通用规矩全部照守,本节只加不减）**：产物是给目标档模型跑的,规则按该档实测能力边界定,当前支持一档:

**qwen3.8-27b 档**（能力依据=该模型能力档案:核验能力仅单点核验可靠〔开放式自审跨轮标准漂移,按清单核验定位废〕;一次调用可靠处理的要素数上界约 4 点;到步展开会收成空壳）：

1. **把关步封闭化**：check 判据写成**逐条封闭小题**形态——判据不写"验收内容完整、结构合理"这类开放句,写成一组只答 yes/no 的具体问题（"交付变量 X 是否含字段 A？原文 L 行的动作 B 是否有对应步骤？"）,判定=全部小题过才 true,说明槽逐题记没过的哪几题。判定对象多于约 4 项时不写单个大 check——拆成"机械归组（hop_python 零 LLM 把对象按可判单元分组）→ loop 逐单元单点核验（每轮只判一个单元,可包 [subtask parallel]）→ 机械汇总（body 收集各单元结论出判定+说明）"三段形态（范本=examples/hop-fact-check.qwen3.8-27b.md 步骤 2.4/2.5/2.6 与其 LineJob/LineVerdict 类型对）;
2. **步骤任务尺寸压小**：提取/枚举/逐项处理类步骤,每步要交付的要素数不超过 4——原文一段要提 9 个要点,不写一个"提取全部要点"的大步,拆成 loop 按分组多轮小步;一步里揉不下的多个动作拆成序列小步（一步一个动作,与"当场可定型从紧"同向但门槛更低）;
3. **交互与提交形态照通用规矩**（commit/ask/confirm 的剥离红线不因目标档变——弱模型档只影响把关形态与步骤尺寸,不影响不可逆与闸门语义的落位）。

（工具件数不设限——该档工具节制实测正常;此处规则值导出自能力档案,档案实测值更新后本节同批跟改。）

### 8. [reason] 按步骤 7 的分型方案成文（叶子唯一落定路——三件套成型逻辑;mixed 是设计常态非缺陷）
- ← node_task, node_source, parent_context, target_profile, header_final, leaf_plan
+ → fragment: text  # 叶子片段（裸片段直出——首字符即 `1`,不加围栏）

**照 leaf_plan 成文,不重新判档**：档位与要剥出的动作句步骤 7 已定,你的活是按方案套对应模板写出片段——方案说"剥出commit: <某句>",片段里就必须有以那句为描述的 [commit] 步;方案说剥 ask 同理（实撞:旧形态本步独立重判,前判明写"须剥 commit"本步却交无 commit 的单步——判断只在步骤 7 做一次,本步照方案渲染,矛盾在结构上灭绝）。**target_profile 非空时,check 步的判据文本与步骤尺寸按上方「目标执行档规则」节写**——判据写成逐条封闭小题,超过 4 项判定对象的把关按该节三段形态展开;方案里已写的档规则行照办不重判。方案与你读到的 node_source 明显冲突时（如方案要剥的句子原文里不存在）,按原文修正并在片段成文后继续——不空转不打回。**leaf_plan 是空或占位符**（正常执行不该出现——重跑轮变量留存可能带进来）：不把占位符当方案,按步骤 7 写明的三档判据对 node_source 现判现写,判出哪档就套哪档的模板成文。

拆不动的节点以自然语言步骤落定,但**落成什么类型要看节点内容,不是一律 [reason]**（把含工具操作/外部影响的任务落成 reason,等于把它的工具面全部吞掉——reason 无工具,执行期干不了活）。**范围注记通则（B0,设计 ^anc-build-expand）**：三档任一模板成文时,片段顶层步骤（subtask 或单步）的说明末尾加一行 `⟦源:L<a>-L<b>⟧`——a/b 取 node_source 首末行的行号（行首 L 前缀直接读）。注记是构建期材料非执行语义（执行 LLM 零消费,与研判点台账同性质）,二轮展开 expand 按它机械定位本原子对应的原文范围。三档成文模板：

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

3. **其余探索+核验成对**（无不可逆无闸门的叶子也不落裸单步——每个叶子天然带把关 ^anc-build-shallow-split）：探索半边落 `[act free]`（含工具操作/外部影响的活——落成 reason 等于把工具面全部吞掉）;**纯推理**（不碰工具不碰外部,只分析判断生成）探索半边才落 `[reason]`;核验半边 `[check final]` 按原文/约束写交付物达标判据。**探索半边首轮不写 hop_python body**（body 写作归定向优化轮,人点名要精化的地方才烧这个费用;commit 必带 body 的红线只管档 1,不受此条影响）：

```
1. [subtask retry=2] <节点任务描述>
  + → <交付变量>: <类型>  # <说明>
  1.1. [act free] <探索与产出:节点的全部工作>（纯推理节点本步落 [reason]）
    - ← <所需输入>
    + → <交付变量>: <类型>  # <说明>
  1.2. [check final] 验收<交付物达标条款,按原文/约束写判据>
    + → ok: bool  # 过没过
    + → note: text  # 没过在哪
```

**[act free] 步用到 tools_available 里的外部工具时,必须给该步写工具授权行** `- 工具: 工具名  # 本步用它做什么`（每工具一行,位置在 `- ←`/`+ →` 之后、执行说明之前）——引擎按节点声明下发工具面,不写这行该工具执行期就不在本步可用面里,执行 LLM 合规空转（静默产空结果,不报错）。带 body 的 act 不需要（body 直接调用）;引擎内置文件十件不需要（恒可用）。格式与边界细则见注入的片段语法速查"工具授权行"条。

各步 `- ←`/`+ →` 从 parent_context 变量清单选真名;占位行带 `+ →` 声明的,交付变量名照占位契约不换名。引擎已自动注入（doc-ref）：
[[split-patterns#hop_python 文法速查（写 body 必读）]]

### 9. [act] 片段落盘、记台账（带原文范围行号段——B0）并定档
- ← fragment, node_task, leaf_plan, node_source, judgement_log
+ → fragment_path: line  # 片段文件路径（本实例 work_zone 涂鸦区——值是路径,父层按它机械读）
+ → tier: enum(hop, mixed)  # 固定为 mixed（本节点以自然语言步骤落定,产物含未完全结构化的部分）

纯机械,body 由引擎直接执行、不经 LLM（台账会随终审呈给作者知情,不是请求修复）。台账行追加本节点原文范围行号段（B0——二轮展开 expand 按它机械对位,设计 ^anc-build-expand B0 注记契约;范围=node_source 首末行的 L 前缀号,切片行首自带全局行号,首末即范围;类型位记 leaf_plan 首行的档位标——档位标就是叶子的类型账）：
> ```hop_python
> # @a: anc-build-expand —— B0 台账行号段:降档落定时把原文范围写进账,二轮 expand 机械对位
> # @a: anc-build-shallow-split —— 台账类型位随单步认领判定拆除改记 leaf_plan 档位首行
> src_lines = [l for l in split(node_source, "\n") if startswith(strip(l), "L")]
> first_ln = split(strip(src_lines[0]), ":")[0] if src_lines else "L?"
> last_ln = split(strip(src_lines[-1]), ":")[0] if src_lines else "L?"
> plan_tag = strip(split(leaf_plan, "\n")[0]) if leaf_plan else "档位:?"
> write(path: work_zone_path("fragment.md"), content: fragment)
> fragment_path = work_zone_path("fragment.md")
> append(path: judgement_log, content: "未尽原子:" + node_task + "|" + plan_tag + "|" + first_ln + "-" + last_ln + "\n")
> tier = "mixed"
> ```

### 10. [exit] 返回片段路径与档位
