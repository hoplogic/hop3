# Spec: hopbuild2-expand — mixed 产物二轮展开
Id: hopbuild2-expand
Goal: 拿 hopbuild2 产的 mixed 档产物包(spec.md+source.md 同目录成套)只展开未尽原子——既有骨架 diff 零变,复用 split-node 判定器,交付升档账(设计权威 docs/design/hopbuild2.md ^anc-build-expand)

Constraints:
- 骨架保真不变量:二轮只展开未尽原子,拼装后与原产物逐行 diff,差异行必须全部落在被展开原子的替换范围内——范围外任何一行变动=[实质] 缺陷打回
- 展开对象=降档账上的未尽原子,不是全部 act free(act free 本身合法)
- header 契约以产物现头部为准(用户交付后改过就按改过的来——产物是资产,现状即契约)
- 原子再烧尽合法(渐进语义,tier 不保证升 hop——账如实记"本轮展开 N/剩 M")
- 全局知识(spec 级 doc-ref,对所有步骤注入):[[split-patterns#HOP 全局认知（目标语言与产物是什么）]]

Inputs:
- mixed_spec_path: line  # mixed 档产物 spec.md 路径(workspace 相对;同目录须有成套 source.md)
- max_depth: int  # 产物嵌套深度上限(同主 spec 语义,空/0 归一缺省 3)
- target_profile: line  # 目标执行档(同主 spec 语义,空=通用形态;展开出的新结构按 split-node「目标执行档规则」节走,经递归 call 透传)

Outputs:
- generated_spec_path: line  # 交付写盘路径
- tier: line  # 展开后档位(hop / mixed)

## Steps

### 1. [subtask retry=2] 产物包成套核(机械进闸)
- ← mixed_spec_path
+ → source_path: line  # 同目录 source.md 路径(构建基准,行号与首轮同一套)
+ → spec_original: text  # 原产物 spec.md 全文(骨架保真核的对照基准,冻结不再改)
+ → history_notes: text  # alignment-notes.md 内容(历史口径先验;缺席=空串)
+ → depth_cap: int  # 归一后的深度上限
+ → profile_norm: line  # 归一后的目标执行档(空值归空串)
+ → expand_log: line  # 二轮研判点台账文件路径(work_zone,对位结果与展开决策全记这里)

#### 1.1. [act] 读产物包并归一入参
- ← mixed_spec_path, max_depth, target_profile
+ → source_path: line  # source.md 路径
+ → spec_original: text  # 原产物全文
+ → history_notes: text  # 历史口径(缺席空串)
+ → depth_cap: int  # 归一后深度上限
+ → profile_norm: line  # 归一后目标执行档
+ → expand_log: line  # 台账路径
+ → pkg_ok: bool  # 成套与档位判定
+ → pkg_note: text  # 不齐时的拒因

纯机械,body 引擎直执零 LLM(成套三判:source.md 在场/spec 头部含"档位: mixed"/alignment-notes 有则读):
> ```hop_python
> # @a: anc-build-expand —— 成套核:mixed 产物包进闸,hop 档或缺 source.md 响亮拒
> parts = split(mixed_spec_path, "/")
> n = len(parts) - 1
> pkg_dir = join([parts[i] for i in range(n)], "/")
> prefix = pkg_dir + "/" if pkg_dir else ""
> source_path = prefix + "source.md"
> spec_original = read(path: mixed_spec_path)
> src_probe = parse_json(exists(path: source_path))
> head = join([l for l in split(spec_original, "\n")][:6], "\n")
> is_mixed = "档位: mixed" in head
> pkg_ok = src_probe.exists and is_mixed
> pkg_note = "" if pkg_ok else ("同目录缺 source.md(构建基准)——mixed 产物包须成套,首轮交付条款保证过,缺=包被拆散或路径给错: " + source_path if not src_probe.exists else "") + ("spec 头部无 mixed 档位标——hop 档产物没有未尽原子,二轮展开没活可干" if not is_mixed else "")
> notes_probe = parse_json(exists(path: prefix + "alignment-notes.md"))
> history_notes = read(path: prefix + "alignment-notes.md") if notes_probe.exists else ""
> dc_parsed = int(max_depth) if max_depth else 3
> depth_cap = dc_parsed if dc_parsed and dc_parsed > 0 else 3
> profile_norm = target_profile if target_profile else ""
> expand_log = work_zone_path("expand-judgement-log.txt")
> ```

#### 1.2. [check] 成套判定
- ← pkg_ok, pkg_note
+ → gate_ok: bool  # 判定
+ → gate_note: text  # 拒因(呈用户照改)

机械转账零 LLM(pkg_ok 即判定,拒因带处置指引):
> ```hop_python
> # @a: anc-build-expand
> gate_ok = pkg_ok
> gate_note = pkg_note
> ```

### 2. [act free] 抽未尽原子清单+原文对位
- ← spec_original, source_path, expand_log
+ → expand_ledger: yaml  # 原子清单,每项 {步骤号, 任务描述, 原文行号段, 判定理由}——对位不确定的项在判定理由里如实标注

扫 spec_original 全部 [act free] 步(含子层),从中甄别**降档账上的未尽原子**——判据(满足任一):①步骤说明尾部有 ⟦源:L<a>-L<b>⟧ 注记(B0 新产物形态);②说明内容是"整段生命周期/多动作混载"的降档形态(对照原文有一段范围明显未被结构化展开)。**不是每个 act free 都要展开**——单一自由动作的 act free(如"记录授权通过并继续")是合法终态形态,不入清单。逐项对位原文范围(两档):有 ⟦源⟧ 注记→直接读行号段;无注记→LLM 对位(拿任务描述与说明关键句 search_file(path: source_path, pattern: 关键词) 定位,返回命中行清单带行号,按命中聚集段定范围)。**每项对位结果 append 进 expand_log**(格式"对位:<步骤号>|<行号段>|<机械读|LLM对位>|<依据一句>")——LLM 对位档的结果作者在步骤 3 可纠。产出 expand_ledger,零候选时空列表(如实交,步骤 3 呈现后自然走空展开收尾)。

### 3. [ask require_human=true present_inputs=expand_ledger] 展开范围确认(可追加点名任意步下钻)
- ← expand_ledger
+ → confirm_note: text  # 作者裁定原话:全展开/点名只展开哪几个(按步骤号)/纠正某项对位范围/**追加点名清单外的任意步下钻**(含已定型步骤或容器——格式"下钻:<步骤号>[,提示词]",如"下钻:4.2,按三个场景分支拆");空串=按清单全展开

呈 expand_ledger 全文。为什么这道门 require_human:LLM 对位档有错判可能,且"哪些原子值得烧展开费用"是人的裁量(部分原子人可能就想留 free)——费用授权语义,与首轮终审同级。**追加点名的语义**:细化=对已结构化步骤再下钻一层,顺序/分支/循环都可产出——被点名步在 4.1 对位原文范围后与清单项同等进 confirmed_list,照 call split-node(判定序本会判结构,命中即产容器子树),骨架保真核照管(差异只许落被点名步的替换范围)。

### 4. [subtask retry=2] 按裁定定稿展开清单并抽 header 契约
- ← expand_ledger, confirm_note, spec_original, source_path, expand_log
+ → confirmed_list: [yaml]  # 定稿展开清单(每项 {步骤号, 任务描述, 原文行号段})
+ → header_contract: yaml  # 从产物现头部机械抽取的契约(goal/inputs/outputs/constraints/tools_available)

#### 4.1. [reason] 按裁定定稿清单
- ← expand_ledger, confirm_note, spec_original, source_path, expand_log
- 工具: read  # 追加下钻项按 ⟦源⟧ 注记行号段读 source.md
- 工具: search_file  # 无注记时按说明关键句进 source.md 定位
- 工具: append  # 对位依据记入 expand 台账
+ → confirmed_list: [yaml]  # 定稿清单

confirm_note 空=照 expand_ledger 全收;点名步骤号=只留点名项;纠正对位范围=按纠正值改该项行号段;**"下钻:<步骤号>"追加项**=清单外新增条目——从 spec_original 取该步说明全文作任务描述,对位原文范围(说明尾 ⟦源⟧ 注记有则机械读,无则按说明关键句 search_file 进 source.md 定位,对位依据 append 进 expand 台账),带提示词的把提示词并进任务描述(如"按三个场景分支拆"——split-node 判定序据此有倾向地判结构)。逐项落成 {步骤号, 任务描述, 原文行号段} 三键形态。

#### 4.2. [act free] 抽产物现头部为契约
- ← spec_original
+ → header_contract: yaml  # goal/inputs/outputs/constraints/tools_available 五键

从 spec_original 头部(Steps 节之前)抽取 Goal/Constraints/Inputs/Outputs/Tools 段落成结构化契约——**以产物现头部为契约**(设计 ^anc-build-expand:expand 不承诺首轮契约原样,用户交付后改过头部就按改过的来,产物是资产现状即契约)。Tools 段缺席=tools_available 空列表。

### 5. [loop for-each 展开项 in confirmed_list, collect 展开件 into 展开件集] 逐原子展开(心脏——复用 split-node 零拷贝)
- ← source_path, header_contract, depth_cap, expand_log
+ → 展开件集: [yaml]  # 每项 {步骤号, 片段路径, 子档位}——片段路径指 work_zone 文件,全文不过变量通道

#### 5.1. [subtask retry=2 parallel] 单原子展开
- ← 展开项, source_path, header_contract, depth_cap, expand_log
+ → 展开件: yaml  # {步骤号, 片段路径, 子档位}

##### 5.1.1. [act] 备切片与入参
- ← 展开项, source_path
+ → 原子任务: text  # 本原子任务描述
+ → 原子切片: text  # source.md 对应行号段切片(行首自带全局行号 L 前缀,切片保留)
+ → 原子步骤号: line  # 在产物里的步骤号(拼装定位用)
+ → 空上下文: text  # 二轮展开原子独立成树,无父层骨架
+ → 空变量清单: [line]  # 同上

纯机械,body 引擎直执零 LLM(行号段解析:L<a>-L<b> 取 a/b 作 read 参数——source.md 第 N 行即全局 L N,一一对应零偏移。**切片逐行带全局行号前缀 `L<n>: `**——实撞:split-node 的行号段核验器按行首 `L<n>:` 读号,纯原文切片全篇无一行带号,判定器 lack_of_info 拒判烧尽。**`L?` 兜底段响亮拒**——写入侧对空源写 `L?-L?` 兜底,int("?") 在推导里静默折 None 产垃圾切片,进闸先核):
> ```hop_python
> # @a: anc-build-expand —— 切片备料:按 ledger 行号段机械切 source.md（多段逐段读;逐行加全局行号前缀——判定器行号段核验依赖行首号,D93;L? 兜底段进闸拒,D93）
> seg = 展开项["原文行号段"]
> pieces = [strip(s) for s in split(seg, "+")]
> seg_bounds = [split(replace(piece, "L", ""), "-") for piece in pieces]
> bad_bounds = [ab for ab in seg_bounds if len(ab) != 2 or not strip(ab[0]) or not strip(ab[1]) or "?" in ab[0] or "?" in ab[1]]
> parts = [read(path: source_path, start_line: int(strip(ab[0])), end_line: int(strip(ab[1]))) for ab in seg_bounds] if len(bad_bounds) == 0 else []
> starts = [int(strip(ab[0])) for ab in seg_bounds] if len(bad_bounds) == 0 else []
> numbered = [join(["L" + str(starts[i] + j) + ": " + split(parts[i], "\n")[j] for j in range(len(split(parts[i], "\n")))], "\n") for i in range(len(parts))]
> 原子切片 = join(numbered, "\n")
> 缺口提示 = "（本切片行号不连续,合法段=" + seg + "——计划行号段不得跨缺口,端点必须取切片里真实存在的行号）" if len(pieces) > 1 else ""
> 原子任务 = 展开项["任务描述"] + 缺口提示
> 原子步骤号 = 展开项["步骤号"]
> 空上下文 = ""
> 空变量清单 = []
> ```

（`bad_bounds` 非空时 parts 为空列表、原子切片为空串——split-node 成套核对空 node_source 响亮拒,失败带拒因浮出;不静默把 `L?` 喂给 int 炸出难读的 None 链。）

##### 5.1.2. [call split-node(node_task: 原子任务, node_source: 原子切片, parent_context: 空上下文, parent_vars: 空变量清单, depth: 1, iteration: 2, max_depth: depth_cap, target_profile: profile_norm, header_final: header_contract, judgement_log: expand_log)] 展开本原子
+ → 片段路径: fragment_path  # 展开子树片段的文件路径
+ → 子档位: tier  # 本原子展开后档位(hop=全结构化;mixed=再烧尽仍含未尽——渐进语义合法)

(判定器=同目录 split-node.md,判定序与首轮完全一致——expand 场景下 node_source 是切片不是全文,行号仍全局号,知识供给见 split-patterns 二轮展开节。)

##### 5.1.3. [act] 组装展开件
- ← 原子步骤号, 片段路径, 子档位
+ → 展开件: yaml  # 三键组装

纯机械转账零 LLM:
> ```hop_python
> # @a: anc-build-expand
> 展开件 = {"步骤号": 原子步骤号, "片段路径": 片段路径, "子档位": 子档位}
> ```

### 6. [subtask retry=2] 拼装+骨架保真核+裁剪版质检
- ← spec_original, 展开件集, confirmed_list, source_path, history_notes
+ → assembled_text: text  # 拼装后全文(质检三面全过)
+ → diff_evidence: text  # 骨架保真核证据(差异行清单与替换范围对照)

#### 6.1. [act free] 拼装
- ← spec_original, 展开件集
+ → assembled_path: line  # 拼装稿文件路径(work_zone)
+ → replaced_path: line  # 被替换的原稿行原文文件(work_zone——拼装时机械截取,骨架保真核的机械底册:实撞后从散文范围描述改为原文行集合,账机械可信)
+ → replace_ranges: text  # 每处替换的原步骤号与新子树步骤号范围(人读账,终审呈现用)

**工具轮预算纪律(真机两撞 MAX_TOOL_ITERATIONS=20 后立)**:本步的活在 20 轮工具调用内必须完——每份片段恰读一次(read 全文,不回读)、拼装稿恰写一次(在头脑里完成全部替换与重刷后一次 write 成稿,不许写了再 edit 逐处修)、replaced.md 恰写一次;spec_original 已在 ← 值里不需要 read。预算账:N 份片段=N 读+2 写,四原子场景 6 轮封顶,超预算即结构性做错了。按展开件集逐项:读各项的"片段路径"键取展开子树,在 spec_original 里定位原子步位置(按步骤号),原子步整体(含其说明与 body)替换为展开子树,子树步骤号按落位重刷(片段编号相对从 1 起,拼装时按原子步的号段翻算——如原子步 3.2 展开出三步则成 3.2/3.3/3.4 或 3.2.1-3.2.3 按子树层级定,后续兄弟步骤号顺延重刷,引用这些步骤号的行同步改)。**只动被替换范围与因顺延而变号的步骤号引用,其余行一字不动**。拼装稿写 work_zone 文件（路径用 work_zone_path("assembled.md") 取——dv 抓"教写 work_zone 却不给取径办法"供给缺口后补;replaced.md 同用 work_zone_path("replaced.md")）;**replaced.md 底册收两类行**(6.2 机械判据依赖此账,漏记哪类哪类就假红):①被替换的原稿行原文（每处原子步的整段,含说明与 body）;②**因兄弟顺延而改步骤号的行的原形态**（改号前那一行的原文——重刷只改行首号,但 strip 后整行文本已变,不入底册会被 6.2 判成非法消失行）。两类逐行拼接写 work_zone 的 replaced.md——这是骨架保真核的机械底册(6.2 按行集合判,不再靠范围描述);replace_ranges 记每处替换的步骤号对照(人读账,终审呈现)。

#### 6.2. [act] 骨架保真核(机械 diff)
- ← spec_original, assembled_path, replaced_path, 展开件集
+ → diff_evidence: text  # 差异行与替换范围对照结论
+ → skeleton_ok: bool  # 差异全落替换范围内与否

纯机械,body 引擎直执零 LLM(机械判据=原稿消失行 ⊆ 被替换行集合〔replaced.md 由拼装步机械截取〕——不在集合内的消失行=骨架被动逐行点名。实撞:原形态拿 LLM 自由格式范围文本数行数当账,三轮计数漂移口径互斥;步骤号重刷行天然不撞——重刷只改行首号,strip 后整行文本变了会进 missing,故重刷行也须进 replaced 底册:拼装步把因顺延改号的行的原形态一并记入 replaced.md):
> ```hop_python
> # @a: anc-build-expand —— 骨架保真核:差异行必须全落替换范围,范围外一行动=骨架被动(设计不变量;D93 补第二侧——单侧消失行判不住范围外纯新增,新稿多出的行须⊆片段行∪重刷后形态;归一=剥数字+点号+井号——第九跑实撞:步骤号点数随嵌套层级变,只剥数字则 1.1. 与 2.1.1. 形态仍不等,17 条合法展开行被误判来路不明)
> assembled = read(path: assembled_path)
> replaced = read(path: replaced_path)
> frag_texts = [read(path: e["片段路径"]) for e in 展开件集]
> frag_lines = [strip(l) for l in split(join(frag_texts, "\n"), "\n") if strip(l)]
> orig_stripped = [strip(l) for l in split(spec_original, "\n") if strip(l)]
> new_stripped = [strip(l) for l in split(assembled, "\n") if strip(l)]
> replaced_set = [strip(l) for l in split(replaced, "\n") if strip(l)]
> missing_lines = [l for l in orig_stripped if l not in new_stripped]
> illegal_lines = [l for l in missing_lines if l not in replaced_set]
> added_lines = [l for l in new_stripped if l not in orig_stripped]
> nodigit_orig = [replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(l, "0", ""), "1", ""), "2", ""), "3", ""), "4", ""), "5", ""), "6", ""), "7", ""), "8", ""), "9", ""), ".", ""), "#", "") for l in orig_stripped]
> nodigit_frag = [replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(l, "0", ""), "1", ""), "2", ""), "3", ""), "4", ""), "5", ""), "6", ""), "7", ""), "8", ""), "9", ""), ".", ""), "#", "") for l in frag_lines]
> added_nodigit = [replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(l, "0", ""), "1", ""), "2", ""), "3", ""), "4", ""), "5", ""), "6", ""), "7", ""), "8", ""), "9", ""), ".", ""), "#", "") for l in added_lines]
> alien_added = [added_lines[i] for i in range(len(added_lines)) if (added_nodigit[i] not in nodigit_frag) and (added_nodigit[i] not in nodigit_orig)]
> skeleton_ok = len(illegal_lines) == 0 and len(alien_added) == 0
> diff_evidence = "消失行 " + str(len(missing_lines)) + " 条(" + str(len(illegal_lines)) + " 条非法)/新增行 " + str(len(added_lines)) + " 条(" + str(len(alien_added)) + " 条来路不明——既不在展开片段里也不是重刷形态行)" + ("——骨架被动,非法消失: " + join(illegal_lines[:5], " ⏎ ") + " | 来路不明新增: " + join(alien_added[:5], " ⏎ ") if not skeleton_ok else "——差异全落替换范围,骨架保真机械判过(双侧)")
> ```

(本步 skeleton_ok 即机械终判——骨架面 6.3 只转账不再裁量;6.3 的 LLM 裁量收窄到指针闭合与数值对账两面。)

#### 6.3. [act] 质检备料与定稿转账
- ← assembled_path, source_path
+ → assembled_text: text  # 拼装稿全文(质检判料+定稿转账双用)
+ → source_text: text  # 构建基准原文全文(数值对账面的判料)

纯机械零 LLM(check 判官零工具面,判料必须经 ← 喂值——实撞:6.3 原只喂 assembled_path 路径,判官读不到正文,指针闭合与数值对账两面无料可核,模型忠实拒判三轮烧尽):
> ```hop_python
> # @a: anc-build-expand —— 质检备料:路径换成值,判官只吃 ← 不动手
> assembled_text = read(path: assembled_path)
> source_text = read(path: source_path)
> ```

#### 6.4. [check] 裁剪版质检三面
- ← assembled_text, source_text, diff_evidence, skeleton_ok, confirmed_list, history_notes
+ → quality_ok: bool  # 三面全过与否
+ → quality_note: text  # 工单(缺陷清单带定位,打回 6.1 定向修)

三面逐项过账(静默跳面=审查不完整不许交卷;判料已全量在 ←——assembled_text 是拼装稿全文,source_text 是构建基准原文,不需要也不能去读文件):①**骨架保真**——机械终判已在 6.2(skeleton_ok),false 即 [实质] 打回带 illegal 行清单(diff_evidence 内),本面零裁量转账;②**指针闭合**——assembled_text 里展开新增文字的包内路径引用(references/xxx 形态),confirmed_list 与 source_text 可证其真伪(收割审计三实例病灶,二轮不许复犯);③**数值对账**——收窄口径:对 confirmed_list 各项的原文行号段,从 source_text 对应行段抽业务数值 token,逐个问 assembled_text 展开子树在场性,缺席/软化/分支丢失=[实质] 打回。history_notes 非空时加核:历史口径有无复犯。实质缺陷清零才 quality_ok=true,非实质残留标『放行残留』记 quality_note 开头。

### 7. [act] tier 判定与升档账
- ← assembled_text, spec_original, 展开件集, expand_ledger, confirmed_list
+ → tier: line  # hop / mixed
+ → upgrade_note: text  # 升档账:本轮展开 N/剩 M/check 与 commit 数前后对比

纯机械,body 引擎直执零 LLM(剩余未尽=展开件集里子档位仍 mixed 的项数 **+ 清单未入选原子数**——注意:部分展开时未入选项不在展开件集,只数展开件集会谎报 tier=hop,违反"剩 M>0 仍交付 mixed"契约;未入选数=按步骤号集合差集计（ledger 里步骤号不在 confirmed_list 步骤号集合的项数——长度差近似在"部分点名+追加下钻"组合下漏计:点名 3+追加 1 时长度差为 0 而真实未入选 1）):
> ```hop_python
> # @a: anc-build-expand —— 升档账:0083 probe 判据"tier 升 hop 或 check/commit 数上升"的观测面;剩 M 计未入选(D93)
> expanded_n = len(展开件集)
> still_mixed = len([e for e in 展开件集 if e["子档位"] == "mixed"])
> confirmed_nums = [c["步骤号"] for c in confirmed_list]
> unselected = len([e for e in expand_ledger if e["步骤号"] not in confirmed_nums])
> tier = "hop" if still_mixed == 0 and unselected == 0 else "mixed"
> old_checks = len([l for l in split(spec_original, "\n") if "[check" in l])
> new_checks = len([l for l in split(assembled_text, "\n") if "[check" in l])
> old_commits = len([l for l in split(spec_original, "\n") if "[commit]" in l])
> new_commits = len([l for l in split(assembled_text, "\n") if "[commit]" in l])
> upgrade_note = "本轮展开 " + str(expanded_n) + " 个原子/其中 " + str(still_mixed) + " 个再烧尽仍 mixed/清单未入选 " + str(unselected) + " 个 | check 数 " + str(old_checks) + "→" + str(new_checks) + " | commit 数 " + str(old_commits) + "→" + str(new_commits)
> ```

### 8. [subtask retry=2] 终审与交付
- ← assembled_text, diff_evidence, upgrade_note, expand_log, mixed_spec_path, tier
+ → generated_spec_path: line  # 交付写盘路径

#### 8.1. [act] 组装终审文件
- ← assembled_text, diff_evidence, upgrade_note, expand_log
+ → review_pack: text  # 终审纲要(升档账+骨架 diff 摘要+台账指引;全文走文件)
+ → review_file: line  # 终审文件路径

纯机械,body 引擎直执零 LLM(审的是增量不是整卷——纲要给结论,全文落文件人按路径打开):
> ```hop_python
> # @a: anc-build-expand
> log_probe = parse_json(exists(path: expand_log))
> log_text = read(path: expand_log) if log_probe.exists else "（零台账记录）"
> review_file = work_zone_path("expand-review.md")
> write(path: review_file, content: "# 二轮展开终审\n\n## 升档账\n" + upgrade_note + "\n\n## 骨架保真证据\n" + diff_evidence + "\n\n## 研判点台账\n" + log_text + "\n\n## 拼装稿全文\n\n" + assembled_text)
> review_pack = "升档账:" + upgrade_note + " | 审阅文件:" + review_file
> ```

#### 8.2. [ask require_human=true present_inputs=review_pack] 作者终审收意见
- ← review_pack, review_file
+ → expand_feedback: text  # 意见原话;通过置空

呈 review_pack(纲要——全文按 review_file 打开:升档账/骨架 diff 证据/台账/拼装稿全文)。通过 → 置空;有修订意见 → 原话记入,8.3 意见闸判败、run 以意见原话为失败面浮出(本 subtask 的 retry 只重跑 8.1-8.3 组装与再呈,结构上到不了已完结的步骤 6,意见没有消化点;真要按意见改产物:小修对交付物走 hopfix 定向修,大改修 expand 输入后重起二轮)。

#### 8.3. [check] 意见闸
- ← expand_feedback
+ → pass_ok: bool  # 意见空=放行
+ → pass_note: text  # 意见非空时=意见原话(打回工单)

机械判零 LLM:
> ```hop_python
> # @a: anc-build-expand
> pass_ok = not strip(expand_feedback)
> pass_note = expand_feedback
> ```

#### 8.4. [commit] 交付写盘
- ← assembled_text, mixed_spec_path, upgrade_note
+ → generated_spec_path: line  # 交付路径

交付写盘,body 引擎直执零 LLM(同名旧文件先备份再覆盖——首轮交付同款纪律;source.md 不动:构建基准未变,二轮只改 spec;升档账 append 进 alignment-notes——展开决策是口径资产,下轮同读):
> ```hop_python
> # @a: anc-build-expand —— 交付:备份覆盖+升档账落口径文件,同首轮 commit 纪律
> parts = split(mixed_spec_path, "/")
> n = len(parts) - 1
> pkg_dir = join([parts[i] for i in range(n)], "/")
> prefix = pkg_dir + "/" if pkg_dir else ""
> generated_spec_path = prefix + "spec.md"
> stamp = replace(replace(str(now()), ":", ""), " ", "-")
> old_probe = parse_json(exists(path: generated_spec_path))
> bak = generated_spec_path + ".bak." + stamp if old_probe.exists else ""
> moved = move(from: generated_spec_path, to: bak) if old_probe.exists else ""
> write(path: generated_spec_path, content: assembled_text)
> appended = append(path: prefix + "alignment-notes.md", content: "\n## 二轮展开(expand) " + stamp + "\n" + upgrade_note + "\n")
> ```

### 9. [exit] 交付展开结果
- ← generated_spec_path, tier

返回交付路径与档位。
