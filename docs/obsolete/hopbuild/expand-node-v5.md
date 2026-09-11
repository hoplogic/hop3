# Spec: expand-node — 递归展开一个翻译节点
Id: expand-node

## Task

Goal: 把 NL skill 的一个节点（任务描述所指的原文范围）展开成完整的 HopSpec 片段——分解→升格→核查一轮到位；仍复合的子步骤递归调用自身展开，子片段拼进本层骨架后整体返回
> 递归语义：本 spec 由 hopbuild 主流程（或上层 expand-node 自身）经 call 调用。一次调用负责一个节点的完整子树——能一眼拆到叶子就直接成文；拆不完的子步骤留占位、逐个子 call、拼装返回。调用栈就是展开树。

Constraints:
- 忠实翻译：只做本节点原文范围的结构化映射，不擅自增删业务步骤；翻译对象恒=原文业务流程（上下文可见的构建流程自身步骤不是翻译对象）
- 全局知识（spec 级 doc-ref,对所有步骤注入）：[[hopbuild-primer#HopSpec 全局知识（你在造什么东西）]]

Inputs:
- node_task: text  # 本节点任务描述（要展开的原文范围一句话概括）
- parent_context: text  # 父层骨架片段+可用变量清单（根节点调用时为空串——父层已定的结构是边界:不重拆不越位;上游变量从这里选真名,不凭任务描述造名）
- skill_content: text  # NL skill 原文全文（忠实性的对照基准）
- header_final: yaml  # 已对齐的头部契约（goal/inputs/outputs/constraints/tools_available——工具引用只许在其 tools_available 面内）
- judgement_log: line  # 研判点台账绝对路径（主实例涂鸦区下,全树共写一份——递归逐层透传;append 契约文件不存在则创建）

Outputs:
- fragment: text  # 本节点子树的完整 spec 片段（编号相对从 1 起,全部占位已被子 call 结果替换,片段 validate 零 error）

## Steps

### 1. [subtask retry=3] 单轮作业：分解 → 升格 → 核查
- ← node_task, parent_context, skill_content, header_final
+ → work_note: text = ""  # 单轮内反馈通道（1.4 核查不过回填,1.1/1.2 ← 它定向修正;init 空）
+ → node_sop: text  # 本节点 HopSop 分解（英文词汇版,仍复合的子步骤留占位叶子）
+ → draft_fragment: text  # 升格后的 spec 片段（占位叶子保留,待子 call 替换）
+ → sub_tasks: [line]  # 仍复合的子步骤清单,每项"占位步骤号 | 子任务描述"（如"2.1 | 逐张工单核对与判定"）;全部触底则空 []

#### 1.1. [reason] 分解本节点
- ← node_task, parent_context, skill_content, header_final, work_note, judgement_log
+ → node_sop: text  # HopSop 大纲：一眼能拆到叶子就直达叶子;拆不完的子步骤=容器行+占位叶子（`[reason] 待展开——<子任务描述>`,满足 S5）
+ → sub_tasks: [line]  # 每个占位对应一项"占位步骤号 | 子任务描述";直达叶子则空 []

按注入的 HopSop 记法分解本节点（parent_context 非空时先读它——父骨架已定的结构是边界,本节点只做自己那段）。**渐进展开,顺序优先**：先把本节点范围内**明确的顺序步骤**拆开——这是本层的主要工作;拆出的某一步内含循环/分支/复合逻辑时,**不在本层展开它**——那一步写成占位叶子留给下层递归（到那一层再自然展开成 loop/branch）。一眼就能定形的简单循环/分支本层直接写也行,拿不准就留占位——**宁可多一层递归,不可本层硬展开**。忠实 node_task 所指的原文范围;探索/核验/提交分离,工具点按 tools_available 落步;容器行必挂子步。占位叶子同时记入 sub_tasks（"占位步骤号 | 子任务描述"——步骤号=占位叶子在本片段里的编号）。**量级硬线：本层 node_sop 超 ~30 行必须拆层留占位,不许硬写**（渐进生成不要一次太多——大输出正文+推理易顶满预算,已产出内容全丢）。原文裁量/意图不清/判据缺席处按最合理推演暂定,追加记入 judgement_log 路径的台账（append,文件不存在则创建——绝对路径,全树共写一份;**原文没给的东西不是缺陷,暂定+记档即正当处置**）。**work_note 非空=按其清单定向修正。**引擎已自动注入（doc-ref）：
[[hopbuild-primer#HopSop 流程草稿记法]]
[[hopbuild-primer#宪法级原则（纪律不可降级，违反 = 翻译错误）]]
[[hopbuild-primer#构建循环全局观（你在流水线的哪一环）]]

#### 1.2. [reason] 升格为 spec 片段
- ← node_sop, node_task, parent_context, header_final, work_note
+ → draft_fragment: text  # spec 片段:每步 ←/→（名字+类型+# 说明）齐全,`>` 执行说明自足,act/commit 纯机械时配 hop_python body;编号相对从 1 起;**裸步骤序列直出——值首字符即 `1`,不加 ``` 围栏不加 `draft_fragment:` 键前缀不写前言后语**;占位叶子原样保留

给 node_sop 逐步补 I/O 与细节并升格（约束先行,简单直出——I/O 契约/原文要求/动作性质/失败语义先定,细节基于约束构造）：**上游变量名从 parent_context 的可用变量清单里选真名**,清单里没有的名字不许引（header_final.inputs 除外）——凭任务描述造名=跨节点断链;每步输出受控、结构从简、判定输出 enum 化;命名与说明齐全;大段判据外置 doc-ref 不内联。**本层出现哪类节点,用注入的「四类纪律句怎么翻」对应小节的生成模板成文**（loop→遍历句/check→核验句/ask·confirm→研判句/commit→提交句——模板照抄结构,别自由发挥;本层没有的类别跳过不读）。成文前过五条高频错:① `- ←` 只写变量名不带类型 ② check/check final 恰两输出 bool+text ③ 占位叶子用 `[reason]` 不用容器类型 ④ 类型只用内置面（结构化数据用 yaml/[yaml],不自造具名复合类型）⑤ 变量名避开语言关键词与类型名。**work_note 非空=定向修正。**引擎已自动注入（doc-ref）：
[[hopbuild-primer#step 类型选型]]
[[hopbuild-primer#四类纪律句怎么翻]]
[[hopbuild-primer#执行时每步能看到什么（写步骤的自足性判据）]]
[[hopbuild-primer#act / commit 的 hop_python body]]
[[hopbuild-primer#高频验证规则（生成后自查，避免 validate error）]]

#### 1.3. [act] 片段机械验证
- ← draft_fragment, node_sop, sub_tasks, header_final
+ → frag_validate: yaml  # 片段 validate 结构化结果（对象:{status,errors[],warnings[]}——工具 content_type=json 引擎解析成对象,声明如实防下游字符串假设〔0024〕）
+ → oversize: bool  # 量级硬线判定：node_sop 超 ~30 行且未留占位（sub_tasks 空）=硬写违规

纯机械,body 引擎直执零 LLM（known_vars 经列表推导从头部契约提取——上游变量的完整可见面归 1.4 语义核,此处管机械结构验;量级线机械可查不靠 LLM 自律;strip_fence 先机械剥壳再验——LLM 产片段的围栏壳/键前缀是机械可剥的稳定病灶,不烧重跑轮,剥不掉的真格式错照旧红）：
> ```hop_python
> draft_fragment = strip_fence(draft_fragment, "draft_fragment")
> known_names = [i.name for i in header_final.inputs]
> frag_validate = validate_spec(text: draft_fragment, fragment: true, known_vars: known_names)
> oversize = len(split(node_sop, "\n")) > 30 and len(sub_tasks) == 0
> ```

#### 1.4. [check final] 单轮核查：机械结果判读 + 语义面
- ← frag_validate, oversize, draft_fragment, node_sop, sub_tasks, node_task, skill_content, header_final, work_note
+ → node_ok: bool  # 判定槽：本节点展开合格
+ → work_note: text  # 更新模式：问题清单回填供本轮重跑；通过置空

两面核：**结构面**——frag_validate errors 空=机械项过,非空逐条入清单;**oversize=true 当场拒**（量级硬线:本层超 ~30 行必须拆层留占位——回填"超量级硬写:把复合段收敛为容器行+占位叶子,只立骨架"）;占位叶子是"拆不完留待递归"的正当形态,但每个占位必须在 sub_tasks 有登记（占位没登记=丢活,当场拒）;**语义面只核四条（首要原则——不按大而全判据拦）**：①**忠于原始语义**——node_task 所指范围覆盖无遗漏、不添业务步骤、不是构建流程自身的复述（骨架回声当场拒）;**原文没给的判据/阈值/字段不算缺陷**（已记研判点台账的暂定=正当处置,不打回）;②**探索-核验-提交分开了没**（不可逆动作混在探索段才拒）;③**渐进**——复合逻辑该留占位的硬展开了才拒（展开克制不是缺陷）;④**可读可解释**——结构讲不出"为什么这样拆"才拒。工具引用都在 tools_available 内。**判权边界（硬约束）**：步骤类型/属性/文法的合法性**只归结构面**——frag_validate 没报的类型不许在语义面翻案,不得凭记忆自创"某类型不存在/不支持"一类规则（实撞:核查步曾凭全局总览句臆断 ask 非法,把正确翻译反复打回至 retry 耗尽）;四条之外的关注点（retry 闭环/步骤自足细则/结构从简）**不在本关**——那些归各自展开层与终审。通过 → node_ok=true、work_note="";有问题 → 清单回填,retry 回 1.1 定向修正。引擎已自动注入（doc-ref）：
[[hopbuild-primer#step 类型选型]]
[[hopbuild-primer#失败反馈怎么流转（引擎语义,你不建通道）]]

### 2. [loop for-each sub in sub_tasks, collect child_fragment into child_fragments] 递归展开各复合子步骤
- ← sub_tasks
+ → child_fragments: [text]  # 各子任务的完整展开片段（与 sub_tasks 同序）

sub_tasks 空则零迭代直接过（叶子触底——递归的天然退化）。

#### 2.1. [reason] 备子调用上下文
- ← sub, draft_fragment, header_final
+ → sub_task_desc: text  # 子任务描述（sub 的第二段）
+ → sub_context: text  # 传给子调用的 parent_context：本层 draft_fragment（子节点的结构边界）+ 可用变量清单（本层各步 `+ →` 的名字+类型+说明,含 header_final.inputs——子片段升格时从这里选真名）

从 sub（"占位步骤号 | 子任务描述"）取出描述;组装 sub_context：draft_fragment 全文 + 按行列出本层全部 `+ →` 变量（名字: 类型  # 说明）与 header_final.inputs——这是子调用能看到的全部上游面。

#### 2.2. [call expand-node(node_task: sub_task_desc, parent_context: sub_context, skill_content, header_final, judgement_log)] 递归展开子节点
+ → child_fragment: fragment  # 收取子 spec 的 fragment 输出（映射:父变量 ← 子输出名）

### 3. [subtask retry=2] 拼装与出口核查
- ← draft_fragment, sub_tasks, child_fragments
+ → fragment: text  # 本节点子树完整片段（全部占位已替换,编号已按树位置重刷）

#### 3.1. [branch] 拼装分派
- ← draft_fragment, sub_tasks, child_fragments
+ → fragment: text  # 拼装结果（**值=裸步骤序列,不加围栏不加键前缀**）

##### 3.1.1. [case(len(sub_tasks) == 0)] 无占位直通
###### 3.1.1.1. [act] 直通搬运
- ← draft_fragment
+ → fragment: text  # =draft_fragment 原样

纯直通零 LLM（直通值过 LLM 输出面必被包围栏/加说明散文——机械搬运归 body）：
> ```hop_python
> fragment = draft_fragment
> ```

##### 3.1.2. [case(else)] 有占位逐对替换
###### 3.1.2.1. [act] 工具替换
- ← draft_fragment, sub_tasks, child_fragments
+ → fragment: text  # 全部占位已替换的片段

编号维护全归工具：逐对（sub_tasks[i] 的占位步骤号, child_fragments[i]）调 `edit_spec_tree`（op="replace_children", node_path=占位步骤号所在容器行号, fragment=child_fragments[i], spec_text=当前片段——片段无头部时按工具契约包临时头再剥）,每次替换后以返回的 spec_text 继续下一对;全部替换完,fragment=最终 spec_text（**工具返回值原样,不转述不加围栏**）。工具返回 error 即本步 fail（不静默）。

#### 3.2. [check final] 出口核查：无占位残留
- ← fragment
+ → done_ok: bool  # 判定槽：全部占位已替换
+ → residue_note: text  # 说明槽（残留占位说明;通过置空）

纯机械判定,body 引擎直执零 LLM：
> ```hop_python
> done_ok = not ("待展开" in fragment)
> residue_note = "" if done_ok else "片段仍含'待展开'占位——子调用清单与占位不齐"
> ```

### 4. [exit] 返回片段
