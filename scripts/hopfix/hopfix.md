# Spec: hopfix——HopSpec 定向修正
Id: hopfix
Goal: 按工单对既有 HopSpec 做节点级定向修正——分诊定档、树编辑落改、三层把关（改动外零变化机械闸/局部合理关/deep-validate 复验指引）、呈人确认后快照写回；结构性与契约面工单如实拒并指路，不硬修

> 设计权威 docs/design/hopfix.md（^anc-meta-hopfix-contract / ^anc-meta-hopfix-sop / ^anc-meta-hopfix-triage）。
> 定位：查-修闭环的修半边——validate/deep-validate 查出缺陷后的分钟级定向修，替代"整树重构或人肉裸改"两条烂路。

Constraints:
- 只修产物文本可定向编辑的局部缺陷（改说明/改 body/补步骤/删步骤）；结构性拆法与头部契约（Goal/Inputs/Outputs 契约面）超范围——分诊判出即拒并指路，拒是正确交付不是失败
- 分诊拿不准局部还是结构时倾向试修——修不动经把关失败路径如实上浮；选错"拒"则把可修的推去重烧小时级重构
- 定向编辑禁全文重写——每处只输出改动节点（整篇重写撞单次回复输出上限被硬掐）
- 改动清单外的节点必须逐字节不变——机械闸不过当场拒，不许"顺手优化"工单外的地方
- 写回前必须快照原件到 work_zone（回滚面）；写回失败路径写进产出值不静默
- 工单全拒时零改动零快照，直接出报告终止

Inputs:
- spec_path: line  # 待修 spec 的 workspace 相对路径（绝对路径与含 .. 的路径沙箱会拒）
- fix_order: text  # 修正工单——自然语言意见原话，或结构化报告全文（deep-validate risk_report / 合理关缺陷清单）均可

Outputs:
- fix_report: markdown  # 修了什么（逐项:节点/动作/依据）/拒了什么（逐项拒因与指路）/三层把关结论/快照路径

## Steps

### 1. [subtask retry=2] 收件与体检（路径形态进闸）
- ← spec_path
+ → spec_text: text  # 待修 spec 全文（体检通过后的内容）
+ → baseline_note: line  # validate 基线（error 数/warning 族分布——修后对照）

#### 1.1. [check] 路径形态机械体检
- ← spec_path
+ → path_ok: bool  # 判定
+ → path_note: text  # 拒因（重问轮呈给调用方照改）

机械三判零 LLM（D72② 同款形态）。exists 返回 JSON 文本须 parse_json 取 .exists；形态坏不碰 exists（绝对路径进读侧工具被沙箱拒成工具失败，先判形态再探在场）：
> ```hop_python
> bad_abs = startswith(spec_path, "/")
> bad_dots = ".." in spec_path
> on_disk = parse_json(exists(path: spec_path)).exists if (not bad_abs) and (not bad_dots) else false
> path_ok = on_disk
> path_note = "" if path_ok else ("绝对路径沙箱会拒,请改 workspace 相对路径: " + spec_path if bad_abs else "") + ("路径含 .. 越界形态: " + spec_path if bad_dots else "") + ("文件不存在（按 workspace 相对解析）: " + spec_path if (not bad_abs) and (not bad_dots) else "")
> ```

#### 1.2. [act] 读原件+validate 基线
- ← spec_path
+ → spec_text: text  # 原件全文
+ → baseline_note: line  # 基线一行（如 "1 error[V4@20] / warnings:B2,V11"——error 带规则码@步号明细键,层一按键对照）

纯机械读取与体检落账，body 引擎直执零 LLM。validate_spec 是内容进内容出的纯函数，返回 JSON 文本须 parse_json：
基线含 error 时不拒收但明细留痕（作者拍 A 案 2026-09-02——工单本身可能就是"修掉这个 error",拒收恰拒掉正当场景;error 键=规则码@步号,进基线串供层一对照、进报告供人读）：
> ```hop_python
> spec_text = read(path: spec_path)
> v = parse_json(validate_spec(text: spec_text))
> errs = get(v, "errors", [])
> err_keys = sorted([get(e, "rule", "?") + "@" + str(get(e, "step_id", "?")) for e in errs])
> warn_rules = sorted([get(w, "rule", "?") for w in get(v, "warnings", [])])
> baseline_note = str(len(errs)) + " error" + ("[" + join(err_keys, ";") + "]" if len(errs) > 0 else "") + " / warnings:" + join(warn_rules, ",")
> write(path: work_zone_path("baseline.txt"), content: baseline_note)
> ```

### 2. [reason] 分诊：工单拆解为节点级修正项，逐项定档
- ← fix_order, spec_text
+ → triage_items: [yaml]  # 每项 {node_id, action, order_quote, reject_reason}——字段语义见下
+ → fixable_count: int  # 可修项数（action ∈ edit_text/edit_body/add_step/remove_step）
+ → triage_note: text  # 分诊摘要（可修 N 项/拒 M 项各一句话）

把工单（自然语言或结构化报告均按同法拆）拆解为逐项修正清单。每项四字段：node_id=受影响节点步号（对照 spec_text 定位，定位不到即拒，拒因写明"工单指涉位置找不到"）；action 六档——edit_text（改说明文字）/edit_body（改 hop_python body）/add_step（补步骤）/remove_step（删步骤）前四档可修，restructure（整段拆法要变）=结构性拒，out_of_scope（动 Goal/Inputs/Outputs 契约面）=契约面拒；order_quote=工单原话切片（本项依据）；reject_reason=拒项必填、可修项空串。分档判据（D70 四档同源）：用定向编辑落实得了的是局部；产物文本上修不动、须重新分拆的是结构性；拿不准倾向可修档——试修修不动会经把关失败如实上浮，误判拒则把可修的推去重烧小时级。列表型产出没有内容时交付空列表不交付 null。**YAML 交付纪律**：order_quote/reject_reason 是自由文本值位（工单原话天然含方括号/冒号/引号这类 YAML 定界符）——每项按块风格逐字段成行交付，自由文本字段一律 `字段: |` 块标量，禁 flow 行内映射（`{...}` 单行形态裸值含定界符会把整份列表炸成解析失败），原话里的引号是语法必需件照抄保留。

### 3. [branch] 按可修项数分流
+ → fix_report: markdown  # 两路同名赋值

#### 3.1. [case(fixable_count == 0)] 全拒——零改动出报告终止
##### 3.1.1. [act free] 组装全拒报告
- ← triage_items, triage_note
+ → fix_report: markdown  # 全拒报告：逐项拒因与指路（结构性→hopbuild2 重构或人工；契约面→重发起），零改动零快照如实注明

按 triage_items 逐项写拒因与指路成文。报告开头一句话明示"本次零改动"。

#### 3.2. [case(else)] 有可修项——修正主线
##### 3.2.1. [subtask retry=2] 定向编辑与三层把关（修检事务——把关不过带反馈重修）
- ← triage_items, spec_text, fix_order, baseline_note
+ → fixed_text: text  # 修正后全文（三层把关通过版）
+ → guard_note: text  # 三层把关逐层结论（层一机械闸/层二局部合理关/层三复验指引判定）

###### 3.2.1.1. [act free] 逐项定向编辑——只产编辑清单,全文拼装归下一步 body（LLM 永不吐全文）
- ← triage_items, spec_text
+ → edits: [yaml]  # 编辑清单,每项 {node_path, fragment}——node_path=受影响节点步号,fragment=该节点的完整新片段（replace_node 的 replacements 原生形态）
+ → edited_nodes: [line]  # 声明改动的节点步号清单（层一机械闸的白名单——只许这些节点变;含重编号波及的节点）

对 spec_text 逐可修项（action 前四档）产出编辑项，**不产出全文**（被修 spec 数万字级时全文经回复吐出必撞输出上限——全文拼装由下一步 body 引擎直执）。四档动作统一归一 replace 形态：edit_text/edit_body=写出该节点的完整新片段;add_step=以落位处兄弟节点为 node_path,fragment 写"原节点原文+新步骤"两段;remove_step=以父容器为 node_path,fragment 写去掉该子步后的父容器全片段。用 read_spec_tree（mode=skeleton 看结构 / mode=node 取单节点原文）定位与取材,fragment 基于节点原文定向改,**每处只改工单所指**。fragment 是自由文本值位——每项块风格逐字段成行,fragment 用 `fragment: |` 块标量交付,禁 flow 行内映射。**fragment 内步号自洽从 "1." 起编号**——replace_node 按片段内相对结构解析,子步写 "1.1."、孙步写 "1.1.1.",不写原文真实点分步号（写 "18.1.1." 这类会撞 "references non-existent parent" 解析拒——首实战约半数重试轮烧在此）;node_path 才是原文真实步号,两者分工别混。add_step/remove_step 引起步号变化时,把受重编号波及的节点也计入 edited_nodes（机械闸按最终步号比对）。重试反馈非空时=上一轮把关没过,按反馈定向补修编辑清单,不推倒重来。

###### 3.2.1.2. [act] 机械拼装修正草稿（body 引擎直执,一次批量替换零 LLM 转写）
- ← spec_text, edits
+ → draft_text: text  # 修正草稿全文（引擎拼装,LLM 未经手全文）

replace_node 恒批量两阶段解引用替换（先全定位后全替换,序号漂移免疫）,返回 JSON 文本须 parse_json 取 spec_text：
> ```hop_python
> r = parse_json(replace_node(spec_text: spec_text, replacements: edits))
> draft_text = get(r, "spec_text", "")
> guard = int("replace_node 拼装失败:" + str(get(r, "result", r))) if not draft_text else 0
> write(path: work_zone_path("draft.md"), content: draft_text)
> ```
> 拼装失败（node_path 定位不到/片段畸形）时用必然失败的类型转换制造计算异常,本步响亮失败带反馈重试——编辑清单的问题回 3.2.1.1 修清单。

###### 3.2.1.3. [act] 层一：机械闸——拼装确定性复核+validate 对照
- ← draft_text, spec_text, edits, baseline_note
+ → gate1_ok: bool  # 判定（此为过程检非 check 步——事务内机械闸，false 经 3.2.1.5 汇总判定驱动重试）
+ → gate1_note: text  # 不过时列明（重放不一致/validate 出了什么错）

body 引擎直执零 LLM。范围保护由构造保证（LLM 只产 edits 清单,全文经 replace_node 纯函数拼装,只有目标节点会变——"顺手优化工单外"物理不可达）,闸做两件:①拼装确定性复核——同一 edits 对原文重放 replace_node,产物须与 draft_text 逐字节一致;②validate 对照——error 与 warning 同律对照基线不用绝对零（作者拍 A 案 2026-09-02,首实战复盘:原"0 error 绝对闸"在基线带病〔引擎版本错位的假 error〕时结构性死锁,修得再对也永不过;新律=新增即拦、既有不背锅、修掉算改善）,新增 error 的规则码@步号+message 原文进 note——重试轮按明细定向修,不再盲烧：
> ```hop_python
> replay = parse_json(replace_node(spec_text: spec_text, replacements: edits))
> replay_text = get(replay, "spec_text", "")
> v2 = parse_json(validate_spec(text: draft_text))
> new_errs = get(v2, "errors", [])
> base_err_part = split(split(baseline_note, "[")[1], "]")[0] if "[" in baseline_note else ""
> base_err_keys = split(base_err_part, ";") if base_err_part else []
> added_errs = [e for e in new_errs if (get(e, "rule", "?") + "@" + str(get(e, "step_id", "?"))) not in base_err_keys]
> new_rules = sorted([get(w, "rule", "?") for w in get(v2, "warnings", [])])
> base_rules = split(split(baseline_note, "warnings:")[1], ",") if "warnings:" in baseline_note else []
> added_rules = sorted([r for r in new_rules if r not in base_rules])
> gate1_ok = replay_text == draft_text and len(added_errs) == 0 and len(added_rules) == 0
> gate1_note = "" if gate1_ok else ("拼装重放与草稿不一致（draft 被清单外机制改动过）" if replay_text != draft_text else "") + ("新增 error（基线外,逐条明细——按定位与规则码定向修）: " + join([get(e, "rule", "?") + "@" + str(get(e, "step_id", "?")) + " " + get(e, "message", "") for e in added_errs], " ;; ") + " | 基线:" + baseline_note if added_errs else "") + ("warning 新增族（改出新病,基线外的规则码）: " + str(added_rules) if added_rules else "")
> ```

###### 3.2.1.4. [reason] 层二：局部合理关（只审改动波及面——原件与改后件双份在场,判"未破坏"对照改前）
- ← draft_text, spec_text, triage_items, edited_nodes, fix_order
+ → gate2_ok: bool  # 判定（过程检同上——汇总判定在 3.2.1.5）
+ → gate2_note: text  # 不过时逐条列缺口

只审三面（不整文重审——范围由层一机械闸物理保证）：①改动节点逐项对照工单意图——工单要的改到了没有、改的是不是工单要的；②变量链邻居——改动节点的 ← 输入与 + → 产出，其直接上下游步骤的引用是否仍接得上（对照 spec_text 原件看改前形态,改名/删槽会断链）；③说明与 body 一致——带 body 的改动节点，`>` 说明如实说清 body 在干什么。逐面写"查了，结论是"，不许静默跳面。

###### 3.2.1.5. [check] 修检汇总判定
- ← gate1_ok, gate1_note, gate2_ok, gate2_note, draft_text
+ → guards_ok: bool  # 判定槽（两层全过才 true——false 带 note 重跑事务，反馈进 3.2.1.1 定向补修（编辑清单层面））
+ → guards_note: text  # 说明槽（两层缺口原文汇总——重试轮的工单）

纯机械汇总零 LLM：
> ```hop_python
> guards_ok = gate1_ok and gate2_ok
> guards_note = "" if guards_ok else ("[层一机械闸] " + gate1_note + " " if not gate1_ok else "") + ("[层二局部合理关] " + gate2_note if not gate2_ok else "")
> ```

###### 3.2.1.6. [act] 落定修正版与层三复验指引判定
- ← draft_text, triage_items
+ → fixed_text: text  # 修正后全文（把关通过版）
+ → guard_note: text  # 三层结论汇总（层一层二已过+层三指引判定）

body 引擎直执。层三判定机械可判：可修项的 action 含形态类动作（edit_body/add_step/remove_step——执行形态变了）则复验必要，纯 edit_text 则非必须：
> ```hop_python
> fixed_text = draft_text
> shape_actions = [t for t in triage_items if not get(t, "reject_reason", "") and get(t, "action", "") in ["edit_body", "add_step", "remove_step"]]
> need_dv = len(shape_actions) > 0
> dv_line = "层三:改动含执行形态类动作(" + str(len(shape_actions)) + " 项)——建议投产前跑 deep-validate 复验: /hopspec run scripts/deep-validate/deep-validate.md --params '{\"spec_path\": \"<本件路径>\", \"exec_mode\": \"standalone\"}'" if need_dv else "层三:改动均为措辞类,deep-validate 复验非必须"
> guard_note = "层一:改动外零变化+validate 通过 | 层二:局部合理关通过 | " + dv_line
> write(path: work_zone_path("fixed-draft.md"), content: fixed_text)
> ```

##### 3.2.2. [act] 组装修正报告与呈审材料
- ← triage_items, guard_note, spec_path, triage_note
+ → fix_report: markdown  # 修正报告（逐项修/拒+三层结论+快照路径预告）
+ → confirm_note: text  # 呈人纲要（短文本：修 N 拒 M/三层结论一句话/报告与草稿文件路径）

body 引擎直执拼变量零转写：
> ```hop_python
> fixed_lines = join(["- " + get(t, "node_id", "?") + " [" + get(t, "action", "?") + "] 依据: " + get(t, "order_quote", "") for t in triage_items if not get(t, "reject_reason", "")], "\n")
> rejected_lines = join(["- " + get(t, "node_id", "?") + " 拒: " + get(t, "reject_reason", "") for t in triage_items if get(t, "reject_reason", "")], "\n")
> fix_report = "# hopfix 修正报告: " + spec_path + "\n\n" + triage_note + "\n\n## 已修\n" + (fixed_lines if fixed_lines else "（无）") + "\n\n## 已拒\n" + (rejected_lines if rejected_lines else "（无）") + "\n\n## 三层把关\n" + guard_note + "\n\n## 回滚\n写回前原件快照于 work_zone 的 pre-fix 副本,回滚=拷回原路径。"
> write(path: work_zone_path("fix-report.md"), content: fix_report)
> confirm_note = triage_note + " | " + guard_note + " | 报告:" + work_zone_path("fix-report.md") + " | 修正稿:" + work_zone_path("fixed-draft.md")
> ```

##### 3.2.3. [ask require_human present_inputs=confirm_note] 呈人确认写回
- ← confirm_note, fix_report
+ → write_approved: line  # "yes"=写回原路径；其它任何回答=不写回（修正稿留 work_zone，人自行取用）

呈纲要（完整改动按修正稿路径打开对读原件）。问：确认把修正版写回原路径吗？答 yes 即写回（写回前自动快照原件可回滚）；答其它则不写回——修正稿与报告都在 work_zone，可自行取用或再来一轮。

##### 3.2.4. [branch] 按确认分流
+ → write_note: line  # 两路同名赋值

###### 3.2.4.1. [case(write_approved == "yes")] 写回
####### 3.2.4.1.1. [commit] 快照+覆盖写回
- ← fixed_text, spec_text, spec_path
+ → write_note: line  # 写回结果（成功含快照路径；失败含失败点）

不可逆动作 body 定死零裁量：先快照原件（回滚面），后覆盖原路径；逐拍判成败，失败路径写进产出值：
> ```hop_python
> snap_path = work_zone_path("pre-fix.md")
> write(path: snap_path, content: spec_text)
> snap_back = read(path: snap_path)
> guard = int("快照读回与原件不一致,拒绝写回") if snap_back != spec_text else 0
> write(path: spec_path, content: fixed_text)
> back = read(path: spec_path)
> write_note = ("已写回 " + spec_path + " | 快照:" + snap_path) if back == fixed_text else ("writeback_mismatch:写回后读回与修正稿不一致,原件快照在 " + snap_path)
> ```
> 快照先落盘并读回核对（不一致时用必然失败的类型转换制造计算异常，本步响亮失败——原件未被碰）；写回后读回核对，失配如实写进产出值。

###### 3.2.4.2. [case(else)] 不写回
####### 3.2.4.2.1. [act] 记录不写回
- ← write_approved
+ → write_note: line

> ```hop_python
> write_note = "未写回（人未确认）:修正稿与报告留存 work_zone,自行取用"
> ```

### 4. [exit] 交付
- ← fix_report
