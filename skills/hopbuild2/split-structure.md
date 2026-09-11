# Spec: split-structure — 按已定分拆方案生成骨架并递归
Id: split-structure

## Task

Goal: 拿到 split-node 判定命中的分拆方案（顺序/分支/循环之一），生成骨架 → 三检 → 对仍是 NL 的子节点 call split-node 递归 → 拼装，返回本节点子树片段与档位
> 三种结构分拆共用本执行机（骨架成文的差异全在 split_plan 里）——split-node 只管判定,本 spec 只管执行,各自单薄易读。

Constraints:
- 语义等价：骨架+子节点并集=node_source 范围,不添不漏
- 凡有 commit,前序必须有针对交付物的 check（原文没写验收则补一个并记档）
- 全局知识（spec 级 doc-ref,对所有步骤注入）：[[split-patterns#HOP 全局认知（目标语言与产物是什么）]] 与 [[split-patterns#节点两型与判定序（你在做什么）]]

Inputs:
- split_kind: enum(seq, branch, loop)  # 命中的分拆种类
- split_plan: text  # 判定步给出的分拆方案（子节点清单:任务描述|原文行号段|当场可定型的写类型,拆不完的标 NL——任务描述是一句概括,行号段形如 L120-L185）
- node_task: text  # 本节点任务描述（一句明确范围的概括）
- node_source: text  # 本节点原文范围全文,每行行首带全局行号 `L<数字>: `（忠实性对照基准;行号是原文全程唯一基准,不逐层重编——切子节点切片、算覆盖对账都按行首号机械做）
- parent_context: text  # 父层骨架+可用变量清单
- parent_vars: [line]  # 父层可用变量名清单（与 parent_context 第二段同名同源——片段机械验证的 known_vars 供给）
- depth: int  # 本节点绝对层深（根节点=1;值=本节点片段顶层步骤在最终产物里的嵌套层数,按步骤号段数计——'3'=1层/'3.2'=2层/'3.2.1'=3层,容器与叶子同算）
- max_depth: int  # 产物嵌套深度上限（缺省 3;1.3 深度闸按它机械拦超深行——D75）
- header_final: yaml  # 头部契约
- judgement_log: line  # 研判点台账路径（workspace 相对路径,或引擎涂鸦区绝对路径〔work_zone 豁免〕;其余绝对路径工具面拒;全树共写）

Outputs:
- fragment_path: line  # 本节点子树完整片段的文件路径（work_zone 涂鸦区文件,内容=占位已被递归结果替换、编号已重刷的片段——值是路径不是内容,父层拼装按路径机械读,片段全文不过变量通道〔D78〕）
- tier: enum(hop, mixed)  # 子树档位

## Steps

### 1. [subtask retry=2] 生成骨架并三检
- ← split_kind, split_plan, node_task, node_source, parent_context, parent_vars, depth, max_depth, header_final
+ → skeleton: text  # 骨架片段（拆不完的子节点为占位叶子,编号相对从 1 起）
+ → sub_nodes: [line]  # 仍是 NL 的子节点清单,每项"占位步骤号 | 任务描述 | 原文行号段"（由 1.2 从骨架占位行机械提取——单一权威源;全部当场定型则空 []）
+ → log_notes: [line]  # 本轮研判点条目（补 check/case(else)/暂定判据各一行;无则空 []——由后续步骤统一落台账,reason/check 无工具面不自己写盘）

#### 1.1. [reason] 按 split_plan 写出骨架
- ← split_kind, split_plan, node_task, parent_context, header_final
+ → skeleton: text  # 裸步骤序列直出（首字符即 `1`,不加围栏不加键前缀不写前言后语）;**内容=node_task 业务流程的步骤**（照 split_plan 各行成文——不是抄本规约自己的步骤）;上游变量从 parent_context 清单选真名;占位行自带 ⟦范围:⟧ 标记（占位清单由 1.2 机械提取,你不写清单）
+ → log_notes: [line]  # 研判点条目（每行"<处置>:<一句说明>";无则空 []）

照 split_plan 逐行成文。骨架形态按 split_kind 选：

- **seq**：平铺子步骤;
- **branch**：branch+case——条件写 hop_python 纯表达式;条件不穷尽时补 `[case(else)]` 兜底并记 log_notes;各分支公共的前置取数上提到 branch 之前;下游要用分支产出时,各 case 给同一个变量名赋值;
- **loop**：按 split_plan 首行标的形态成文。**for-each**（逐条处理）：`[loop for-each item in list_var, collect unit into results]`——遍历列表须是 `[T]` 类型;collect 子句用两个变量名（单项一个、汇总列表一个）;循环体只写单项的事。**repeat**（重复推进）：`[loop max=N] 描述`——体内干活步骤 + `[check]` 判继续/停止条件 + 条件满足支路 `[break]`;跨轮累积用容器头累加器 `+ → acc: 类型 = 初值`。

成文规矩逐条：

- **顶层编号从 1 开始**（1、2、3…）——本片段是独立子树,编号不接着父层排。写成 `1.1` 起头,解析器会报"找不到父步骤 1"直接拒;
- **大节点只搭框架,一条计划恰好一行**：split_plan 多于一条、或某条对应大段原文（阶段级/章级）时,每条落一行（定型步骤或 NL 占位）,**禁止就地展开任何一条的内部**——展开归递归层;扎进第一条写细节,后面的条目会被挤出注意力整段丢失（真机实撞:三条计划只消化第一条,语义关打回重来）;
- **当场可定型的子节点直接写成步骤**（类型按探索范式的步骤定型认领——本条适用于小块收尾,大块起步按上条只落一行）;
- **骨架阶段只写单行 body**：一行赋值（如 `x = sum(xs)`）直接带上;需要多行代码的不写 body、留 NL 占位交给递归——递归里有专门的"写 body+三重验证"流程一次写一个,骨架一轮写多个复杂 body 出错率高（实测结论）;
- **拆不完的留占位叶子** `N. [reason] 待展开——<任务描述> ⟦范围: L<起>-L<止>⟧`——行号段内嵌行尾（行号从 node_source 行首直接读,多段以 ` + ` 连接;下游按它机械切原文切片,漏写或格式坏=子层拿不到对的原文,机械关当场拒;任务描述一句概括,不抄动作清单——动作细节的权威在行号段所指的切片里）;
- **含 commit 的段落**：commit 单列;它前面必须有针对交付物的 check——产出步骤、check、commit 三段同套一个 subtask（形如 `[subtask retry=K]`(产出步骤… + `[check final]` 验收 + `[commit]` 提交)）。验收不过的轮次走不到 commit;commit 一旦执行,该 subtask 停止 retry,引擎防重复提交。check 直接平铺在顶层是不合法的（校验规则要求 check 必须在 subtask/case 内——片段单独校验时暂不报,拼成全文一定报）。原文没写验收也要补,并记 log_notes。
- **横切动作抽子 spec,各落点一行 call**：同一套动作在多个落点重复出现（每阶段通知/逐段落盘/分级验收——原文"每个阶段完成后都要 X"即此形态）时,不逐处复制同构步骤块——该动作抽成独立子 spec（登记 log_notes 呈上层,子 spec 全步带 body 引擎直执零 LLM 最佳）,各落点一行 `[call 子spec(参数)]`（实撞:每阶段通知 ×5 阶段=60 行同构样板,抽子 spec 后每处一行,改逻辑只改一处）。自查判据不变:漏写某处 call 与漏抄样板同为动作蒸发;
- **跨轮依赖的多轮派发**：原文"分多轮、后轮依据前轮发现差异化"的形态,成文=外层 `[loop max=N]` 串行承载轮次（体内 reason 按前轮发现设计本轮成员,容器头累加器变量承载跨轮依赖）+轮内 for-each `[call … parallel]` 并发派发。两条纪律:跨轮依赖合法（经变量流动）;同轮成员必须独立（同批并行不可能依赖彼此未产出的东西——原文写同批内依赖=原文不自洽,记 log_notes）。降级成单批全并发=丢跨轮语义,是保真缺陷不是简化。

**关键词语言**：环境参数 hop_env_language 为 "zh" 时,骨架步骤行用中文关键词书写（`[推理]`/`[探索 开放]`/`[子任务 重试=2]`/`[循环 遍历 x 于 xs, 收集 r 入 rs]`——完整对照表在语法速查）;为 "en" 或缺席时用英文关键词。两种语言引擎恒等价（双语直通,写错语言不报错只是与项目缺省不一致——机械关不拦语言,存量归一交 hopjit lang 工具）。

**交付前自查三条**（写完骨架先自己过一遍再交,每条都是语义关必打回的实撞高频项——自查一分钟,省一整轮重试）：

1. **计划覆盖**：split_plan 每一条在骨架里有对应的步骤或占位。逐条对照,不是"大体都有"——漏一条,那段流程执行时就不会发生（实撞:三条计划只消化第一条,两个阶段整段丢失）;
2. **材料落地**：node_source 里的表格、清单、模板、公式、判据集,逐个确认已**整段落入**某个步骤的执行说明——材料不丢也不拆,随消费它的步骤供给。只在描述里提一句"按某某表筛选"而表内容不在场,执行期那一步无表可查,只能漏判或臆造（实撞:定位类型四型表两轮才落进去）;**把判据/公式/分档定义压成名词提及同属材料缺席**（实撞 0039:步骤描述写"严重度锚点 1-5、优先级公式 P0-P1-P2"而五档分界与阈值全没落——名词在定义失,执行期判定必然瞎判;正形按《细则章三选一落点》纪律:内联全文/产物内容章节/占位行号）;
3. **数据流对账**：每步执行说明里提到的判定依据,必须能从该步 `- ←` 声明的输入取到。说明书写"结合标题/行文风格/发布渠道推断",而 ← 里唯一输入的声明字段没有这三样——执行期无据可依,等于没供材料（实撞原样）。顺带核 body：body 里每个"原文未给、按最合理推演具体化"的处置（如把模糊指称写死成过滤表达式）,log_notes 对应有一行。

引擎已自动注入（doc-ref）：
[[split-patterns#HopSpec 片段语法速查（骨架成文必读）]]
[[split-patterns#hop_python 文法速查（写 body 必读）]]
[[split-patterns#subtask 探索范式（步骤定型与事务形态）]]
[[split-patterns#分支与循环判据]]
[[split-patterns#骨架成文纪律（占位/编号/裸片段直出）]]

#### 1.2. [act] 语法机械核+占位清单机械提取
- ← skeleton, header_final, parent_vars
+ → skeleton: text  # 剥壳后骨架（机械剥围栏,幂等）
+ → syntax_result: text  # validate JSON 输出
+ → sub_nodes: [line]  # 占位清单——从骨架"待展开"行机械提取,每行"步骤号 | 任务描述 | 原文行号段"（单一权威源=骨架占位行,LLM 不维护第二份,漏登记/错步骤号/杂项混入整族缺陷从结构上消灭）

纯机械,body 由引擎直接执行、不经 LLM。known_vars 必须并入 parent_vars——骨架里引用父层产出的变量是正常形态,漏了它们,校验会把合法引用误报成"未定义变量"。占位清单三段全部从占位行机械切出（行形态 `N. [reason] 待展开——<描述> ⟦范围: <范围>⟧`）：
> ```hop_python
> skeleton = strip_fence(skeleton, "skeleton")
> known_names = [i.name for i in header_final.inputs] + parent_vars
> syntax_result = validate_spec(text: skeleton, fragment: true, known_vars: known_names)
> ph_lines = [strip(l) for l in split(skeleton, "\n") if "待展开——" in l]
> ph_toks = [split(l, " ")[0] for l in ph_lines]
> ph_nums = [replace(replace(tok + "#", ".#", ""), "#", "") for tok in ph_toks]
> ph_descs = [strip(split(split(l, "待展开——")[1], "⟦范围:")[0]) for l in ph_lines]
> ph_ranges = [strip(split(split(l, "⟦范围:")[1], "⟧")[0]) if "⟦范围:" in l else "" for l in ph_lines]
> sub_nodes = [ph_nums[i] + " | " + ph_descs[i] + " | " + ph_ranges[i] for i in range(len(ph_lines))]
> ```

#### 1.3. [check] 语法关
- ← syntax_result, skeleton, node_source, depth, max_depth
+ → syntax_ok: bool  # 判定槽
+ → syntax_note: text  # 说明槽（error 清单回填,重跑轮定向修正）

纯机械判定,body 由引擎直接执行、不经 LLM。核七面（占位登记对账已废——sub_nodes 由 1.2 从骨架机械提取,单一权威源,漏登记/错步骤号从结构上不可能;换核**范围标记完整**）：**语法**——validate 无 error;**范围标记完整**——每个"待展开"占位行必须带 `⟦范围:` 标记（范围是占位行唯一不可机械推导的信息,漏写=下游备料无从切原文切片,子层拿不到对的原文）;**自我抄写拦截**——骨架里出现本规约自己的步骤名,说明执行者把正在执行的规约误当成了产物内容;**小节点禁再拆**——原文少于 800 字还留 NL 占位=切香肠（真机实撞:一条 4 行原文被逐层各切两半,5 层只消化一句话撞递归深度上限,16 实例全灭——小节点必须当场写完,定型不了的直接落自然语言步骤）;**占位数上限**——一次拆分超过 5 个 NL 占位=切得太碎,合并成更大的块或当场定型一部分;**载体语汇拦截（hopissues/0065,D73 同构双防线的分拆通道半边——载体能力边界教条〔split-node 步骤 7〕是教学供给,35KB 语料两轮实测〔0035/0036〕分拆 LLM 被原文强势发射教学带走教条零生效,毒素从原文正文直接流进骨架步骤;词表与对齐门 4.3 carrier_cons 九子串同源,全 lower 比对——两处 body 各自内联,同源纪律由 check-spec-syntax 回归锁双盯）**——骨架行含宿主载体机制语汇即判不过,反馈指路按教条转译成 call parallel 形态;**深度上限（D75,作者定 2026-09-02"拆的太细了"）**——对骨架每个步骤行（占位行与已定型子步骤行同查）机械提取行首步骤号,算绝对深度=depth+步骤号段数-1（子片段原位拼接:骨架顶层行就落在本节点 depth 层,行每多一段号即深一层）,超 max_depth（缺省 3）即判不过,反馈指路"该占位合并进父步骤当场定型,或落自然语言步骤（不再递归）"——与占位上限面同款打回形态：
> ```hop_python
> ph_all = [l for l in split(skeleton, "\n") if "待展开——" in l]
> no_range = [l for l in ph_all if "⟦范围:" not in l]
> ph_rng = [strip(split(split(l, "⟦范围:")[1], "⟧")[0]) for l in ph_all if "⟦范围:" in l]
> rng_toks = [strip(t) for t in split(join(ph_rng, " + "), "+") if strip(t)]
> rng_stripped = [replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(t, "0", ""), "1", ""), "2", ""), "3", ""), "4", ""), "5", ""), "6", ""), "7", ""), "8", ""), "9", "") for t in rng_toks]
> bad_rng = [rng_toks[i] for i in range(len(rng_toks)) if rng_stripped[i] != "L-L"]
> ok_toks = [rng_toks[i] for i in range(len(rng_toks)) if rng_stripped[i] == "L-L"]
> t_starts = [int(split(split(t, "-")[0], "L")[1]) for t in ok_toks]
> t_ends = [int(split(split(t, "-")[1], "L")[1]) for t in ok_toks]
> src_nums_sk = [int(split(split(l, ":")[0], "L")[1]) for l in split(node_source, "\n") if startswith(l, "L") and ":" in l]
> oob_rng = [ok_toks[i] for i in range(len(ok_toks)) if (t_starts[i] not in src_nums_sk) or (t_ends[i] not in src_nums_sk)]
> bar_descs = [l for l in ph_all if "|" in split(split(l, "待展开——")[1], "⟦范围:")[0]]
> self_echo = ("按 split_plan 写出骨架" in skeleton) or ("生成骨架并三检" in skeleton) or ("递归分拆各 NL 子节点" in skeleton)
> small_node_split = len(node_source) < 800 and len(ph_all) > 0
> too_many_subs = len(ph_all) > 5
> sk_lines = [strip(l) for l in split(skeleton, "\n") if len(strip(l)) > 0]
> cand = [l for l in sk_lines if " [" in l]
> cand_nums = [replace(replace(split(l, " ")[0] + "#", ".#", ""), "#", "") for l in cand]
> num_ok = [len(n) > 0 and len(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(n, "0", ""), "1", ""), "2", ""), "3", ""), "4", ""), "5", ""), "6", ""), "7", ""), "8", ""), "9", ""), ".", "")) == 0 for n in cand_nums]
> deep_lines = [cand[i] for i in range(len(cand)) if num_ok[i] and depth + len(split(cand_nums[i], ".")) - 1 > max_depth]
> carrier_lines = [l for l in split(skeleton, "\n") if "run_in_background" in lower(l) or "subagent" in lower(l) or "task 工具" in lower(l) or "task工具" in lower(l) or "agent 工具" in lower(l) or "agent工具" in lower(l) or "askuserquestion" in lower(l) or "发射 agent" in lower(l) or "发射agent" in lower(l)]
> syntax_ok = ('"errors":[]' in syntax_result) and len(no_range) == 0 and len(bad_rng) == 0 and len(oob_rng) == 0 and len(bar_descs) == 0 and not self_echo and not small_node_split and not too_many_subs and len(deep_lines) == 0 and len(carrier_lines) == 0
> syntax_note = "" if syntax_ok else syntax_result + (" | " + str(len(no_range)) + " 个占位行缺 ⟦范围: L<起>-L<止>⟧ 标记——行号段写在占位行尾,下游按它机械切原文切片,漏写子层拿不到对的原文: " + join(no_range, " ;; ") if no_range else "") + (" | 范围标记里格式坏的行号段(须 L数字-L数字,多段以 + 连接;行号从 node_source 行首直接读): " + join(bad_rng, ", ") if bad_rng else "") + (" | 越界行号段——端点不是 node_source 里存在的行号,切片会切空,子层拿空原文跑等于失明,从你面前的 node_source 行首重抄: " + join(oob_rng, ", ") if oob_rng else "") + (" | 占位行任务描述含竖线 |——竖线是占位清单的字段分隔符,描述里出现会让下游机械解析错位,改成别的标点: " + join(bar_descs, " ;; ") if bar_descs else "") + (" | 骨架抄了本执行机自己的步骤——你的产物是 node_source 业务流程的骨架,照 split_plan 写业务步骤,不是抄你正在执行的规约" if self_echo else "") + (" | 本节点原文不足800字,不许再留NL占位递归——全部子步骤当场写成成品,定型不了的直接写成自然语言描述的步骤;若步骤实为成品(IO与描述已齐),删去'待展开——'前缀即可——该前缀是机器识别的占位标记,成品不得携带" if small_node_split else "") + (" | NL占位超过5个,切得太碎——合并成更大的块,或把能定型的当场写成步骤" if too_many_subs else "") + (" | " + str(len(deep_lines)) + " 行步骤超出产物嵌套深度上限:第 " + str(max_depth) + " 层已达深度上限（缺省3——作者定'拆的太细了'）——该占位合并进父步骤当场定型,或落自然语言步骤（不再递归）;本节点已在第 " + str(depth) + " 层,骨架行绝对深度=本层深+行步骤号段数-1: " + join(deep_lines, " ;; ") if deep_lines else "") + (" | " + str(len(carrier_lines)) + " 行含宿主载体机制语汇(run_in_background/subagent/Task 工具/Agent 工具/AskUserQuestion/发射 agent)——产物 spec 的执行者可能没有这些能力,按载体能力边界教条转译:并行成员=每个成员独立子 spec+主流程 [call 子spec(参数映射) parallel] 逐个派发;汇聚成员=前序收齐后串行 [call 子spec(...)];载体机制名不进产物步骤。逐行改写后重交: " + join(carrier_lines, " ;; ") if carrier_lines else "")
> ```

#### 1.4. [check final] 语义与知识关
- ← skeleton, sub_nodes, log_notes, node_task, node_source, header_final, split_plan
+ → semantic_ok: bool  # 判定槽
+ → semantic_note: text  # 说明槽（问题清单回填）

只核五条,五条之外不在本关。**打回前先做缺口定位（诊断分型,决定反馈打给谁）**：发现缺失项（丢动作/丢闸门/丢交付物）时,先对照 split_plan——缺失项若**不在任何一条计划的范围内**,这是**计划缺口不是骨架缺陷**：骨架被"照 split_plan 成文"铁律捆着,无权自补计划外的动作,把"请补入"反馈发给它只会让它在"听反馈"与"照计划"之间摇摆到烧尽（实撞:README 写入不在三条计划任何一条里,三轮反馈都喊"补入 README",执行者三轮都无法合法落笔,烧尽降档）。计划缺口照样判 false 打回,但 semantic_note 开头必须写明"**[计划缺口] X 不在 split_plan 任何条目内——骨架层无权自补,须上层重产计划**"——这行是给容器重试和上浮路径的诊断书,让有权修计划的层知道该修什么;缺失项在计划范围内而骨架没写,才是骨架缺陷,照常反馈"请补入"。**多余项同理分型**：骨架里点名清单外工具/落了被裁能力的步骤,若正是 split_plan 某条计划要求的（计划本身就规划了做不到的事）,semantic_note 开头写"**[计划越界] split_plan 第 X 条要求使用 header 之外的能力——骨架层照计划成文无权自裁,须上层重产计划剔除该条**"——把反馈发给骨架只会让它在"删掉这步"与"照计划"之间烧尽;骨架自己加戏点名了计划没写的工具,才照常反馈"请删除或改写"。**修法建议要守机械关的边界**：给"留 NL 占位"这个修法选项前,先看 node_source 体量——不足约 800 字的节点,1.3 语法关的切香肠判据会机械拒占位,这条路根本走不通,只能给"当场定型（或落自然语言步骤）"单选（实撞:333 字节点被给了"定型或占位"二选一,执行者选占位,下一轮被 1.3 拒——两道闸判据不一致,把执行者夹在中间烧两轮）。

1. **忠实**——skeleton 与 sub_nodes 并集覆盖 node_source 全部内容,无遗漏、无杜撰业务步骤;**原文的交互闸门（问人确认/审批）逐个有 ask/confirm 或 NL 占位落点;原文的"必须执行/不得省略"清单逐条有落点**——丢闸门、丢清单项都打回（把含多个规定动作的段落压成一个步骤,同样算丢）。**本条正是覆盖对账的子层自查落点（D77）**：本层 node_source 就是父层按行号机械切出的保真切片,动作清单完整在场——对着它逐条核落点,查出漏项由本事务重试补进骨架（本层有权修自己的骨架,不存在"无权修计划"的死锁;行级覆盖性父层已机械对账过,你核的是语义半边:条目有没有真落成步骤）;原文没给的判据不算缺陷——log_notes 已记档的暂定处置是正当形态,不打回;**header_final 的 constraints/inputs/outputs 是作者已确认的判据,骨架引用它们不算"原文未给的推演"**——node_source 只是原文的一个切片,切片里没有 ≠ 没给过：判"杜撰/越权推演"前先对照 header_final（实撞:骨架写"视角最少 3 个"被误判为原文未给,实际 header constraints 明载,冤枉打回白烧一轮——生成者拿着 header 写,核查者也要拿着 header 判）;**header 的权威是双向的——它补进来的算数,它裁掉的也算数**：骨架步骤点名的具体外部工具必须在 header_final.tools_available 清单内,点名了清单外的工具（如"用 Puppeteer 导出"而 tools_available 为空）,判 false——工具不在可用面,这个步骤执行时就是无米之炊,落成诚实的 act free 也一样跑不通,不许放进产物（实撞:对齐门删了 Puppeteer,深层骨架照 split_plan 落 "[act free] 用 Puppeteer 导出 PDF",忠实关因"照计划成文无权自裁"放行,被裁能力活着进了最终产物）;同理,骨架里与 header goal/outputs 明确裁掉的能力对应的整支(如 header 已明载不做 PDF 而骨架有导出支),判 false;
1b. **禁假 body**——骨架里每个带 hop_python body 的步骤,遮住步骤描述只看 body:它真做了描述里那件事吗?**把任务描述赋成字符串字面量、凑假状态对象（`x = {"status": "done"}` 这类）冒充产出的,是假 body,打回**——改法要么写真 body（真工具调用/真计算）,要么去掉 body 标 [act free]（实撞:步骤声称调 WebSearch,body 却是 `industry_findings = "行业实践对标结果（…）"`——零工具零推理,假数据直接流给下游,比 NL 占位更恶劣:占位诚实说没做,假 body 谎称做了）;
2. **三段分离**——commit 没混进探索步骤中间、它前面有针对交付物的 check;**header 约束或原文说"不可修改/撤不回"的动作必须是 commit 类型**——写成 act 的话,它所在容器重试时这个不可逆动作会被重复执行,打回;
2b. **数据链接通**——两个方向核：①每个 reason/check 步的描述说"通读/分析/对照 X"时,输入 `- ←` 里必须有承载 X **内容**的变量,只接路径变量不接内容变量=断链,打回并点名该接哪个变量（实撞:步骤"通读待评审文档做五问梳理"输入仅 ← doc_path,内容变量前步已产出没接——整步执行期空转）;②骨架内前步产出的计划/清单类变量,后续照它行事的步骤必须真接进 `- ←`——**产而不用即打回**（实撞:第 1 段产 round_plan 轮次计划,第 2 段发射步没接它,"分轮"节奏语义整个蒸发,产物只剩"一次全发"）;
3. **渐进**——留占位待递归是正当形态,不是缺陷;
4. **可读可解释**——骨架讲得出为什么这样拆。

你只判定不修复、不写盘——发现该记档而 log_notes 漏记的,回填 semantic_note 打回补记。**打回时问题清单一次列全**：本轮发现的全部缺陷逐条进 semantic_note,不许只点最重的一条留着其余下轮再说——每轮挤一条,重试轮次就随缺陷数线性增长（实撞:首轮只点"关键词格式丢失"、落型错误按"通过"放过,第二轮才打落型,同一份骨架多烧一轮）。已核过且通过的条目简要列出（"其余 X 项通过"),让修复者知道改动范围就是清单本身。引擎已自动注入（doc-ref）：
[[split-patterns#HopSpec 片段语法速查（骨架成文必读）]]

### 2. [act] 研判点落台账
- ← log_notes, node_task, judgement_log
+ → log_flushed: bool  # 固定为 true（表示条目已写入台账文件;log_notes 为空时不写、直接过,重复执行安全）

纯机械,body 由引擎直接执行、不经 LLM（reason/check 步骤没有文件工具,写盘统一归本步）：
> ```hop_python
> if log_notes:
>     append(path: judgement_log, content: node_task + ":" + join(log_notes, "\n" + node_task + ":") + "\n")
> log_flushed = True
> ```

### 3. [loop for-each sub in sub_nodes, collect child_frag_path into child_frag_paths, collect child_tier into child_tiers] 递归分拆各 NL 子节点
- ← sub_nodes
+ → child_frag_paths: [line]  # 各子树片段的文件路径（与 sub_nodes 同序;值是路径不是内容——片段全文不过变量通道〔D78〕;空清单零迭代直接过——全部当场定型的天然退化）
+ → child_tiers: [line]  # 各子树档位

#### 3.1. [reason] 备子任务描述（只产判断件——切片与上下文组装归 3.2 机械 body,D79）
- ← sub, skeleton, header_final
+ → sub_task: text  # 子任务描述——**一句明确范围的概括**（sub 第二段照抄或润成一句;**不逐条抄原文动作清单**——动作细节的权威在行号段所指的原文切片里,子层按行号拿到的是逐字保真切片,你抄一遍是冗余且会把描述膨胀成小型全文〔D77——历史沿革:旧形态"发现漏列当场补进 sub_task"条款已删,覆盖性由计划层行号对账与子层切片自查接管〕）。**占位行带 `+ →` 声明的,原样附上并注明"必须以这些名字交付"**——占位输出是子节点对父层的接线契约,子片段换名=下游引用断链

#### 3.2. [act] 机械备料：切片、上下文、变量清单、层深（D76③切片机械化+D79 组装机械化）
- ← skeleton, node_source, header_final, parent_vars, sub, depth
+ → sub_source: text  # 子节点原文切片（按 sub 第三段行号段从 node_source 机械提取——零 LLM 转写零抄错,行首号保留:全局行号不逐层重编,子层的范围标记继续指向同一基准）
+ → sub_context: text  # 传给子调用的 parent_context：本层 skeleton 全文 + 可用变量清单（按行"名字: 类型  # 说明"——机械拼接,skeleton 本就在变量空间,不劳 LLM 抄写〔D79〕;双侧同一格式,子调用才解读得动）
+ → sub_vars: [line]  # 祖先链变量 + header inputs + 本层骨架各步 + → 名字（子调用的 parent_vars——机械可导,不劳 LLM）
+ → sub_depth: int  # 子节点绝对层深（=depth+占位行步骤号段数-1——子片段原位替换占位行,顶层步骤落在占位行所在层;D75 深度闸的递归传递值）

纯机械,body 由引擎直接执行、不经 LLM。切片按 sub 第三段行号段（`L<起>-L<止>`,多段以 ` + ` 连接）从 node_source 逐段取行拼接——1.3 已核过每个占位行必带合法行号段,此处直取。变量清单三条实测教训不变：**必须并入本层收到的 parent_vars**（只取本层骨架的变量,祖父层的变量传到第三层递归就丢了,深层片段引用祖先变量会被校验误报"未定义"）;**只认 `+ →` 声明行,不能凡是带 `→` 的行都抓**（正文说明里的"P0→P1→P2"这类箭头会被误抓成假变量名——假名混进 known_vars 白名单让"未定义变量"核查变松。清单允许重复,消费方只做成员判定,重复无害）;**必须并入 loop 头部的单项变量**（`for-each X in …` 的 X 声明在 loop 步骤行里、不在任何 `+ →` 行——只抓 `+ →` 就漏它;loop 体内留占位递归时,子节点的任务天然要引用"当前项"变量,漏了它子层写对也被 V1 拒,写对必拒+不写违反语义=死锁,真机实撞:原子成文 12 轮同败烧死实例）：
> ```hop_python
> rng = strip(split(sub, "|")[2])
> seg_list = [strip(s) for s in split(rng, "+")]
> starts = [int(split(split(s, "-")[0], "L")[1]) for s in seg_list]
> ends = [int(split(split(s, "-")[1], "L")[1]) for s in seg_list]
> src_lines = split(node_source, "\n")
> line_nums = [int(split(split(l, ":")[0], "L")[1]) if startswith(l, "L") and ":" in l else -1 for l in src_lines]
> picked = [src_lines[j] for j in range(len(src_lines)) if line_nums[j] >= 0 and any([(starts[i] <= line_nums[j]) and (line_nums[j] <= ends[i]) for i in range(len(seg_list))])]
> sub_source = join(picked, "\n")
> decl_lines = [l for l in split(skeleton, "\n") if "+ →" in l]
> skel_names = [strip(split(split(split(l, "+ →")[1], ":")[0], "#")[0]) for l in decl_lines]
> loop_lines = [l for l in split(skeleton, "\n") if "for-each " in l]
> loop_vars = [strip(split(split(l, "for-each ")[1], " in ")[0]) for l in loop_lines]
> sub_vars = parent_vars + [i.name for i in header_final.inputs] + skel_names + loop_vars
> hdr_lines = [i.name + ": " + str(i.type) + "  # " + str(i.说明) for i in header_final.inputs]
> ctx_lines = [strip(split(l, "+ →")[1]) for l in decl_lines]
> sub_context = skeleton + "\n\n可用变量清单:\n" + join(hdr_lines + ctx_lines, "\n")
> sub_num = strip(split(sub, "|")[0])
> sub_depth = depth + len(split(sub_num, ".")) - 1
> ```

#### 3.3. [subtask retry=0 parallel] 递归分拆子节点（失败降档兜底——子拆不动不炸层;并行派发单元=整个壳——D80 修订〔决策档案 20260904-并行标注挪壳〕:标注在 call 上时收齐点落壳,壳等自己孩子收割才完结,loop 无法轮进,并行度锁死 1〔0038 实测 96 分钟在飞恒 1〕;挪壳后派发即壳标 done,loop 立刻轮进派下一壳,收齐点自然落 loop——渐进派发原生形态,壳内 call 与兜底随壳进 worker 内部串行,事务语义完整。共享台账 judgement_log 并发 append 行序交错属知情接受,行自带 node_task 前缀可归组）
+ → child_frag_path: line  # 子树片段的文件路径（递归成功=子调用产物路径;子层烧尽=兜底片段落盘后的路径）
+ → child_tier: line  # 子树档位（兜底路径固定 mixed）

##### 3.3.1. [call split-node(node_task: sub_task, node_source: sub_source, parent_context: sub_context, parent_vars: sub_vars, depth: sub_depth, max_depth, header_final, judgement_log)] 递归分拆（壳内串行——并行度由外层壳承载,一层并行原则）
+ → child_frag_path: fragment_path  # 收取子调用的 fragment_path（值是路径——D78）
+ → child_tier: tier  # 收取子调用的 tier

##### 3.3.2. [on fail] 子层烧尽 → 分型降档落定（保住兄弟成果,不炸本层）

子调用自己的 retry 已经烧完才会走到这里——本层再重试整个子调用是对同一失败盲赌,所以 retry=0 首败即进本兜底。该子节点放弃结构化,以自然语言步骤落定为未尽原子（合法交付档,复用模式可跑）,本层其余子节点的成果照常保留、照常拼装。

###### 3.3.2.1. [subtask retry=2] 兜底成文并机械核（兜底产物与正路产物同闸同权）
- ← sub_task, sub_source, sub_context, sub_vars, header_final
+ → child_fragment: text  # 未尽原子片段（已剥壳、已过 validate）

（为什么兜底也要过核：主流程所有 LLM 产出片段都过机械核,原先唯独兜底片段写完直接流进拼装口——而兜底执行者处境最差〔拿着刚失败的任务写补救产物〕,最需要核。真机实撞:兜底重试轮产出整个包在 ```yaml 围栏里,直接喂拼装工具 parse 拒,四轮同败烧死实例。兜底内三攻仍不过=本块失败=3.3 上浮,比放行垃圾片段炸拼装口正确。）

####### 3.3.2.1.1. [reason] 按内容分型写未尽原子片段
- ← sub_task, sub_source, sub_context, header_final
+ → fallback_draft: text  # 未尽原子片段草稿（裸片段直出,首字符即 `1`）

落成什么类型看子任务内容,不是一律一种（落错型会吞掉工具面或蒸发闸门语义）。自上而下第一个命中即形态——①**含不可逆动作或交付写盘**（header 约束/原文点名不可撤销、发送/支付/写生产/删除;或原文承诺交付物保存为文件——交付落盘是提交语义,不得落 [act free]）：探索范式三件套,commit 从描述剥出单列（`1. [subtask retry=2]`( `1.1 [act free]` 探索准备 + `1.2 [check final]` 验收 + `1.3 [commit]` 不可逆那一句)——[act free] 不得承载提交语义;**commit 命令生成期定不死时**〔哪台机器/跑什么要看现场〕改备料/提交分离形态：1.1 备料产精确执行清单文件交付路径变量,1.2 换机械读步+[confirm]（读清单入文本变量作 confirm 输入——confirm 呈人的是它声明的输入值,present_inputs 属 ask 专属）,1.3 commit body 静态定死为读清单逐条执行——形态样板见 split-patterns「备料/提交分离」节,不许因定不死把提交语义留在 free 描述里）;②**含交互闸门**（AskUserQuestion/人工确认/问人要值）：ask/confirm 步剥出保留,其余工作落 [act free]（闸门落成别的类型=把"问人"偷换成"机器替人答"——不因兜底豁免）;**范围含门禁句**（「必须 X 才能 Y」）时加写证据契约:原子交付结构化门禁证据+骨架补 [check] 步消费判定（D87,样板见 split-patterns「门禁证据分离」节）;③**其余先试 body 再落 free**：动作确定、签名写得出来（文件读写/文本替换/拼接——read/write/edit_file 十件是 hop_python 内置恒可用）→ `1. [act] <描述>` 带 hop_python body;真写不出确定签名 → 单步 `1. [act free] <子任务描述>`;纯推理才 `1. [reason] <子任务描述>`。各步 IO 从 sub_context 变量清单选真名;占位行带 `+ →` 声明的,交付变量名照占位契约不换名。引擎已自动注入（doc-ref）：
[[split-patterns#subtask 探索范式（步骤定型与事务形态）]]
[[split-patterns#HopSpec 片段语法速查（骨架成文必读）]]
[[split-patterns#hop_python 文法速查（写 body 必读）]]

####### 3.3.2.1.2. [act] 剥壳并 validate
- ← fallback_draft, sub_vars
+ → child_fragment: text  # 剥壳后片段
+ → fallback_syntax: text  # validate JSON 输出

纯机械,body 由引擎直接执行、不经 LLM（与 1.2 骨架核同族——known_vars 用 sub_vars:本子节点视角的完整白名单,含祖先链变量与 loop 单项变量）：
> ```hop_python
> child_fragment = strip_fence(fallback_draft, "child_fragment")
> fallback_syntax = validate_spec(text: child_fragment, fragment: true, known_vars: sub_vars)
> ```

####### 3.3.2.1.3. [check final] 语法关
- ← fallback_syntax
+ → fallback_ok: bool  # 判定槽
+ → fallback_note: text  # 说明槽（error 清单回填,重试反馈定向修正）

纯机械判定,body 引擎直执零 LLM：
> ```hop_python
> fallback_ok = '"errors":[]' in fallback_syntax
> fallback_note = "" if fallback_ok else fallback_syntax
> ```

###### 3.3.2.2. [act] 兜底片段落盘、记台账并定档
- ← child_fragment, sub, sub_task, judgement_log
+ → child_frag_path: line  # 兜底片段的文件路径（本层 work_zone 涂鸦区,文件名带占位步骤号防同层多占位互覆——值是路径〔D78〕）
+ → child_tier: line  # 固定 mixed

纯机械,body 由引擎直接执行、不经 LLM：
> ```hop_python
> sub_num = strip(split(sub, "|")[0])
> child_frag_path = work_zone_path("fallback-frag-" + replace(sub_num, ".", "_") + ".md")
> write(path: child_frag_path, content: child_fragment)
> append(path: judgement_log, content: "子层降档(递归烧尽,未尽原子落定):" + sub_task + "\n")
> child_tier = "mixed"
> ```

### 4. [subtask retry=2] 拼装与就地修错（子树成果只拼不重拆——拼装口出错就修拼装口）
- ← skeleton, sub_nodes, child_frag_paths
+ → fragment_path: line  # 拼装成品的文件路径（占位已替换、编号已重刷的完整片段——值是路径,内容只在机械 body 手里流转〔D78〕）

（**为什么包事务**：走到本步,loop 已把全部子树拆完——child_frag_paths 指向的文件是数小时递归的成果,产在本事务**外**,本 subtask 重试只重跑拼装段,**子树绝不重拆**。实撞:原拼装是裸平铺步,一处机械失败实例直接终态——手里 5 棵已完成子树全部陪葬,死链再上传炸掉整棵大树,"子节点都到手了、父层拼装没过、动不动全树烧"是历轮最大浪费源。拼装口的错多是局部小问题〔个别片段形态畸形/壳没剥净/步骤号错位〕,局部修复即可;两轮修不动才实例失败上传。）

#### 4.1. [act] 子片段落工作台（每轮重写原始件,幂等）
- ← skeleton, sub_nodes, child_frag_paths
+ → frag_sep: line  # 片段分隔符（读回时按它切割）

纯机械,body 引擎直执零 LLM。骨架与全部子片段落成两个工作台文件——修错步对着文件干活（文件操作"不动"是天然形态,变量通道则要 LLM 复述大文本,又慢又易抄坏）。子片段按 child_frag_paths 逐个从子实例文件机械读入（跨实例路径来自 call 返回值——D78 文件通道,全文零 LLM 过手）。每轮重试都从原始件重写:上一轮的修补被清掉,修错步按累计反馈史从原始件重修——修的基准永远干净：
> ```hop_python
> frag_sep = "<<<HB2-FRAG-BOUNDARY>>>"
> child_frags = [read(path: p) for p in child_frag_paths]
> write(path: work_zone_path("assembly-skeleton.md"), content: skeleton)
> write(path: work_zone_path("assembly-frags.md"), content: join(child_frags, "\n" + frag_sep + "\n"))
> ```

#### 4.2. [act free] 定向修错（无错不动）
- ← sub_nodes, frag_sep
+ → fix_note: line  # 一句话修错记录（"无错未动"或"修了:…"）

重试反馈非空时=上一轮拼装失败的错误原文（replace_node 的拒收明细,含哪个片段/哪一行的问题）——按它定位工作台文件（`assembly-skeleton.md` 骨架 / `assembly-frags.md` 全部子片段,片段间以 frag_sep 行分隔、顺序与 sub_nodes 一致）,**只修反馈所指的那一处**：剥掉没剥净的壳、修坏掉的步骤行形态、把畸形片段修成合法步骤序列——改完写回原文件。不重写其他片段、不顺手润色、不增删片段数量（分隔符行数不得变——数量变了拼装按位对应即错）。反馈为空（首轮）一字不动,fix_note="无错未动"。

#### 4.3. [act] 读回并机械拼装
- ← sub_nodes, frag_sep
+ → fragment_path: line  # 拼装成品的文件路径（占位节点被子树片段原位替换后的完整片段落盘于此——值是路径〔D78〕）

纯机械,body 由引擎直接执行、不经 LLM（replace_node 操作=占位行本体消失、子树片段接进原位置;批量 replacements 里各目标都按替换前的步骤号定位,工具在全部替换完成后统一重编号;拼装成品直接落盘,全文不出 body）。每份子片段先机械剥壳再喂工具——子片段来自 LLM,可能带围栏包裹,带壳直接喂 replace_node 会 parse 拒"片段内无可解析步骤行"（真机实撞:降档兜底片段包了 ```yaml 围栏,拼装四轮全灭烧死子实例——形态纪律不能只赌上游守约,机械口自己剥,幂等裸值原样过）：
> ```hop_python
> skeleton_w = read(path: work_zone_path("assembly-skeleton.md"))
> if len(sub_nodes) == 0:
>   fragment = skeleton_w
> else:
>   frags_all = read(path: work_zone_path("assembly-frags.md"))
>   frags_w = split(frags_all, frag_sep)
>   reps = [{"node_path": strip(split(sub_nodes[i], "|")[0]), "fragment": strip_fence(strip(frags_w[i]), "child_fragment")} for i in range(len(sub_nodes))]
>   r = parse_json(replace_node(spec_text: skeleton_w, spec_is_fragment: True, replacements: reps))
>   fragment = r.spec_text
> write(path: work_zone_path("fragment.md"), content: fragment)
> fragment_path = work_zone_path("fragment.md")
> ```

### 5. [act] 剥壳终核定档
- ← fragment_path, child_tiers, header_final, parent_vars, node_task, judgement_log
+ → fragment_path: line  # 成品片段的文件路径（剥壳后回写同一文件——值是路径,本 spec 的最终交付〔D78〕）
+ → tier: enum(hop, mixed)  # 含未替换占位/任何子树 mixed/拼装后整验不过 → mixed;否则 hop

纯机械,body 由引擎直接执行、不经 LLM（按路径读盘核验,全文只在 body 手里流转）。拼装后对整个片段再做一次完整校验——各子片段单独校验通过,不代表拼起来也通过（比如 A 子树引用了 B 子树改了名的变量,只有整体校验能发现）;不通过就降档为 mixed 并记台账,如实交付,不掩盖问题：
> ```hop_python
> fragment = strip_fence(read(path: fragment_path), "fragment")
> write(path: fragment_path, content: fragment)
> known_names = [i.name for i in header_final.inputs] + parent_vars
> whole_check = validate_spec(text: fragment, fragment: true, known_vars: known_names)
> whole_ok = '"errors":[]' in whole_check
> if not whole_ok:
>     append(path: judgement_log, content: "拼装整验不过(降档mixed):" + node_task + "|" + whole_check + "\n")
> tier = "mixed" if ("待展开——" in fragment or "mixed" in child_tiers or not whole_ok) else "hop"
> ```

### 6. [exit] 返回片段路径与档位
