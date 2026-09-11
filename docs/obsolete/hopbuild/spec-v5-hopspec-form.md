# Spec: hopbuild — 自然语言 skill 翻译为 HopSpec 规约
Id: hopbuild

## Task

Goal: 把一个自然语言 skill 翻译成合规的 HopSpec 规约（hopskill）——头部契约单事务对齐后，call expand-node 递归展开整个 skill（展开器逐节点:分解→升格→核查,复合子步骤子 call 下钻,调用栈即展开树），过整体合法/合理/实测关，作者终审意见即迭代，忠实门放行后写盘交付
> 构建三则：注意力经济（生成期零 ask,人触点只有前置对齐门与收口终审,新增决策点记档呈终审）；单轮作业（展开器内分解→补 I/O 与步骤约束→结构语义核查）；递归展开（复合子步骤经 call 逐层下钻至触底,深度上限 max_call_depth）。
> 本 spec 由 hopbuild 经元翻译自举而来——递归展开的遍历由引擎 call 机制保障（宪法支柱『循环遍历不漏』自守）。

Constraints:
- 纪律不可降级（宪法两支柱）：循环遍历不漏（保障策略二选一须真有闭环）；探索-核验-提交三段式（探索可逆入沙盒/核验不跳/提交把关+尽量幂等）（违反=翻译错误，非风格）
- 忠实翻译：只做 自然语言→spec 结构化映射，不擅自增删业务步骤；原文某类纪律句无触发则对账报告如实记零不强造；原文意图不清记档呈终审,不中途打断人
- 生成即校验：产出 spec 必须过各机器关 + 作者终审，全过才写盘
- 渐进输出：每轮只展开一个节点、逐轮落盘——不一口产完整 spec
- 全局知识（spec 级 doc-ref,对所有步骤注入）：[[hopbuild-primer#HopSpec 全局知识（你在造什么东西）]]

Inputs:
- input_skill_path: line  # 待翻译的自然语言 skill 文件路径（.claude/skills/xxx/SKILL.md）；为空则列出候选供选

Outputs:
- generated_spec_path: line  # 生成的 hopskill spec.md 最终写盘路径
- test_report: text  # 实测报告（构造案例的核证结果与覆盖说明）

## Steps

### 1. [ask] 确认待翻译的自然语言 skill
- ← input_skill_path
+ → skill_path: line  # 确认后的自然语言 skill 文件路径

若 input_skill_path 已指向存在的自然语言 skill，采用它作为默认值（无歧义可直接采用、不必强问）；否则列出 `.claude/skills/` 下的自然语言 skill（跳过已有对应 spec 的）供作者选一个。default_value = input_skill_path。

### 2. [act] 读取原文并落 source.md（原文副本）
- ← skill_path
+ → skill_content: text  # 自然语言 skill 全文（原文本体逐字——body 直读零 LLM,值污染面根除）

纯机械读取与落盘,body 引擎直执零 LLM（原 LLM 工具循环形态实录两病:值带围栏壳+说明尾巴/值被进度回声顶替——机械搬运不走 LLM 输出面;referenced 文件的合并语义后置,首个带 references 的真实样本出现再迭代。落盘走 `work_zone_path()` 引擎涂鸦区——相对路径 `work_zone/…` 会落到用户工作区根下裸目录:污染工作区且父目录不存在时 body 直执 ENOENT 秒败）：
> ```hop_python
> skill_content = read(path: skill_path)
> write(path: work_zone_path("source.md"), content: skill_content)
> ```

（source.md=原文纯副本,终审与日后对读的物理基准;交付时随 spec 同目录分发。）

### 3. [act] 初始化反馈通道与递归入参
+ → iter_feedback: text = ""  # 构建循环反馈通道：init 空；各关失败详情与作者终审意见回填,重跑轮定向修正
+ → root_task: text = "把整个 NL skill 的执行流程翻译为 HopSpec Steps"  # 根节点任务描述（call expand-node 首参）
+ → empty_context: text = ""  # 根节点父上下文（空——根节点无父层骨架）
+ → work_zone_root: line  # 引擎涂鸦区绝对路径（LLM 步落中间产物用它拼路径——写侧工具对涂鸦区绝对路径放行）
+ → judgement_log: line  # 研判点台账绝对路径（跨实例共享通道:expand-node 递归子实例 append、5.7 read——经 call 参数逐层透传,全树共写一份）

纯初始化零推理：
> ```hop_python
> iter_feedback = ""
> root_task = "把整个 NL skill 的执行流程翻译为 HopSpec Steps"
> empty_context = ""
> work_zone_root = work_zone_path()
> judgement_log = work_zone_path("judgement-log.md")
> ```

### 4. [subtask] 头部契约核查（①）
- ← skill_content
+ → header_final: yaml  # 对齐后的头部契约（子任务聚合输出——出事务即已过对齐门）
+ → task_weight: enum(light, heavy)  # 任务档位（对齐后定档——实测组数依据;展开粒度由展开器逐节点自然判断）

#### 4.1. [reason] 生成/修订头部契约（含可用工具面与档位评估）
- ← skill_content
+ → header_final: yaml  # 头部契约（平面五键:goal 一行/inputs 每项 name·type·说明/outputs 同/constraints 每条一行/tools_available 可用工具与可 call 的 spec 清单——执行环境内置工具组+原文提到的外部服务逐条列明来源;每轮修订重赋值,过对齐门的那版即对齐版）
+ → task_weight: enum(light, heavy)  # 档位评估:light=简单任务（能一眼看清、直接做规划——段落少/无嵌套遍历/纪律句稀）,heavy=复杂任务（需遵循步骤分解执行做规划）;评估理由并入 header_final 随呈审;此档只定实测组数——展开粒度由展开器逐节点自然判断（一眼看清直达叶子,看不清拆一层递归）

从原文抽头部契约：goal（一句话）；I/O 判归属——inputs 只收**任务的业务输入**（原文需要外部提供的数据,一个不漏、不添；执行设施不是业务输入），outputs 只放**原文承诺的交付物**（一个不漏、不添、中间产物不进）；constraints 翻原文"必须/不可"；**tools_available**——盘点产物能调什么（引擎内置文件/目录工具组、原文提到的外部工具/服务、可 call 的既有 spec），逐条注明来源与用途，拿不准的标"待确认"（呈审裁定,不入循环内决策）；**档位评估**——按原文长度/结构复杂度/纪律句密度判。**重试反馈非空（『上次尝试失败』区块——对齐门经引擎注入的用户修订意见原话）=按意见定向修订上轮契约（含改档;修订是推理活归本步,不整篇重来）。**

#### 4.2. [ask present_inputs=header_final,task_weight] 呈审头部契约收修订意见
- ← header_final, task_weight
+ → header_feedback: text  # 更新模式：用户修订意见（目标/交付物/业务输入/工具面/档位各面）;确认无误则置空

完整呈现 header_final 与 task_weight（present_inputs 硬约束——用户须看全才能答），请用户核查：目标对不对、交付物是不是要的、业务输入有无多缺、工具面有无漏（"待确认"项在此裁定）、档位是否合适。有修订意见 → 原话记入 header_feedback；确认无误 → header_feedback 置空。

#### 4.3. [check final] 对齐门：修订意见清空才放行
- ← header_feedback
+ → aligned: bool  # 判定槽（引擎消费:false→容器 retry——check 双槽是 P11 封闭签名,非变量流）
+ → align_note: text  # 说明槽=修订意见转运（fail 时引擎经重试反馈注入重跑轮——4.1 收到的『上次尝试失败:…』即意见原话,唯一反馈通道）

纯机械判空+意见转运,body 引擎直执零 LLM：
> ```hop_python
> aligned = len(header_feedback) == 0
> align_note = "" if aligned else header_feedback
> ```

aligned=false 即 fail——subtask retry 回 4.1,修订意见经 align_note→引擎重试反馈直达重跑轮（不对齐不出事务）。对齐门管方向，终审管收口。此后进入构建循环——**循环内不再问人**（注意力经济）：能从已对齐的头部契约与原文推演的直接定,实质性新增决策点记入研判点台账随终审呈裁。

### 5. [subtask adaptive retry=6] 迭代构建循环主体（②）
- ← skill_content, header_final, task_weight, work_zone_root, judgement_log
+ → spec_text: text  # 完整 spec.md 文本（全关通过+作者终审放行,子任务聚合输出）
+ → test_report: text  # 实测报告

（构建循环事务,retry=6：终审意见轮与各关重跑共享次数——给作者多轮修订余地。**中间产物一律落引擎涂鸦区**（路径经 work_zone_root/judgement_log 变量,不写相对 `work_zone/…`——那会落到用户工作区）：全文 spec-draft.md〔5.3 落盘〕/研判点台账 judgement-log.md〔展开器分解步 append,经 call 参数透传全树共写〕/测试文件与状态目录〔5.6.2 落〕/审阅文件 review.md〔5.7 汇〕——探索段产物入沙盒。重跑=重 call expand-node（iter_feedback 含节点路径即定向）。retry 耗尽 fail 上浮,adaptive 重规划——交付契约与各验收关不可改。）

#### 5.1. [call expand-node(node_task: root_task, parent_context: empty_context, skill_content, header_final, judgement_log)] 递归展开整个 skill
+ → spec_body: fragment  # 产物 Steps 全文（展开器递归返回的完整片段——编号已按树位置机械重刷,零占位残留）

（展开器=同目录 expand-node.md：单轮作业四拍展开一个节点,仍复合的子步骤逐个 call 自身递归下钻,子片段经 edit_spec_tree 拼装。调用栈即展开树——父上下文经参数天然传递,深度上限 max_call_depth=10。）

#### 5.2. [act] 渲染文件头
- ← header_final
+ → header_text: text  # 文件头文本（Spec 标题/Id/Goal/Constraints/Types/Inputs/Outputs 各节,不含 `## Steps`;末行后不带多余空行）。**值=文件头本体逐字:首字符即 `#`（`# Spec:` 顶格）,不加代码围栏不加键前缀不加缩进**——本值经 5.3 机械拼接直写盘面,任何包裹都会逐字节落盘（首行非顶格标题即 validate parse 错）

按 header_final 渲染文件头文本：标题与 Id 从 skill 名组合、Goal/Constraints/Inputs/Outputs 逐项按 HopSpec 头部语法成行、复用结构提炼 Types、tools_available 是呈审信息不入文件头。只渲染头部——步骤正文大文本不过本步（大文本逐字复制过 LLM 输出面必漂移,拼接归下一步机械做）。

#### 5.3. [act] 拼接落盘、读回并跑 validate
- ← header_text, spec_body
+ → spec_text: text  # 草稿全文（写盘后读回——验的是盘面真身）
+ → validate_result: yaml  # validate 结构化结果（对象:{status, errors[], warnings[]}——工具 content_type=json,引擎解析成对象非字符串）

纯机械拼接与调用,代码执行零 LLM（写入涂鸦区 **spec-draft.md** 固定名,后续各关与交付读它;覆盖写幂等,每轮构建循环重跑即复验）：
> ```hop_python
> write(path: work_zone_path("spec-draft.md"), content: header_text + "\n## Steps\n\n" + spec_body)
> spec_text = read(path: work_zone_path("spec-draft.md"))
> validate_result = validate_spec(text: spec_text)
> ```

#### 5.4. [check] 整体合法关：validate 零 error
- ← validate_result, iter_feedback
+ → legal_ok: bool  # 判定槽：validate errors 为空
+ → iter_feedback: text  # 更新模式：error 清单回填（构建循环重跑按它定向入队问题节点）；通过置空

纯机械判定,body 引擎直执零 LLM（validate_result 是对象——`in` 在对象上是 Python key 检查,子串匹配写法判恒 False,0024 实撞;按字段访问判）：
> ```hop_python
> legal_ok = len(validate_result["errors"]) == 0
> iter_feedback = "" if legal_ok else str(validate_result)
> ```

legal_ok=false 即 fail（构建循环 retry:5.1 重 call 展开器,iter_feedback 的 error 清单定向修正）。

#### 5.5. [check] 整体合理关（失败回填 iter_feedback）
- ← spec_text, header_final, iter_feedback
+ → sensible_ok: bool  # 判定槽：整体合理
+ → iter_feedback: text  # 更新模式：问题清单回填；通过置空

全局只核**首要原则四条**（渐进展开+可读可解释——不按大而全判据拦,判据越全弱模型越到不了终点）：①**忠于原始语义**——原文步骤全覆盖、无杜撰业务步骤;**原文没给的判据/阈值/字段名不算缺陷**（暂定+研判点台账=正当处置,终审呈作者终裁,不在本关打回——实撞:本关曾反复打回『紧急判据缺失』直至 replan 耗尽,而原文本来就没给）;②**探索-核验-提交分离**——不可逆步骤（commit）前有把关、没混进探索段;③**渐进合理**——留任务描述待迭代的占位型步骤是正当形态不是缺陷;④**可读可解释**——全文结构能讲出为什么这样拆。跨节点隐式指代（某步引用不存在的变量名）顺手报,其余细则（retry 闭环/结构从简/步骤自足逐条核）**不在本关**——归展开层与终审。通过 → sensible_ok=true;有问题 → 清单回填 → fail（构建循环 retry 定向重展开）。

#### 5.6. [subtask retry=3] 实测（构造案例轻档核证）
- ← spec_text, header_final, task_weight, iter_feedback
+ → test_report: text  # 实测报告（案例/核证结果/覆盖说明）

##### 5.6.1. [reason] 构造测试案例（组数按档位）
- ← spec_text, header_final, task_weight, iter_feedback
+ → test_params: yaml  # 按 header_final.inputs 构造的实参（light=单组典型值;heavy=按各 branch 分支命中构造多组,平面列表;loop 输入给 2-3 元素小列表）

按 inputs 构造贴近真实的实参,组数按档位：light 单组;heavy 按各 case 命中条件多组（覆盖各分支）。**iter_feedback 非空=按上轮失败针对性重构造。**

##### 5.6.2. [act] 轻档核证：init + 首步推进
- ← spec_text, test_params, work_zone_root
+ → probe_result: text  # 核证结果（逐组:init 响应+首个 step_ready/介入点载荷,或错误输出;测试文件与各组状态目录落 {work_zone_root} 涂鸦区——盘上产物非本变量携带）

轻档核证（执行环境工具面=文件九件+validate_spec,无 shell/run 工具——核证在此工具面内做,不臆想跑 CLI）：把 spec_text 落 {work_zone_root} 下测试文件（涂鸦区绝对路径写侧放行——不写相对 `work_zone/…`,那会落到用户工作区）;**对 test_params 每一组**做两件:①validate_spec 整文验（结构合法=init 可建的机械前提）;②按该组实参对步骤树做**首步静态推演**——首个可执行步是谁、它的 ← 在该组实参下是否全部可满足、首个介入点（ask/confirm）在哪。逐组记录结论。全部盘上产物入 {work_zone_root} 涂鸦区,可安全重跑。

##### 5.6.3. [reason] 成文实测报告（含覆盖检查）
- ← probe_result, test_params, spec_text
+ → test_report: text  # 实测报告（案例/核证结果/覆盖说明——各分支是否有对应案例组、loop 是否有列表案例、介入点是否在可达路径上,不足注明补测建议）

按核证结果与案例组成文报告：init 与首步结果、覆盖盘点（branch 各分支/loop/介入点）、不足处的补测建议。

##### 5.6.4. [check final] 实测关（失败回填 iter_feedback）
- ← probe_result, test_report, iter_feedback
+ → test_ok: bool  # 判定槽：实测通过
+ → iter_feedback: text  # 更新模式：失败详情回填；通过置空

核证：逐组 validate 零 error、首步静态推演成立（首个可执行步的 ← 可满足、介入点可达）、test_report 覆盖盘点无硬缺口。通过 → test_ok=true、iter_feedback="";失败 → 详情回填：案例构造问题 → 本 subtask retry 回 5.6.1 重构造;**spec 自身问题**（超出案例面）→ 如实写入 iter_feedback 并 fail（构建循环 retry 定向重展开,不在实测级越权修 spec）。

#### 5.7. [act] 组装审阅文件（终审备料）
- ← spec_text, judgement_log, test_report, work_zone_root
+ → review_path: line  # 涂鸦区下审阅文件绝对路径（固定名 review.md——三节:spec 全文/研判点台账/实测报告,一个文件人一次打开全看）
+ → review_summary: text  # 审阅纲要（短文本:步骤数/研判点条数/实测结论一句话/review_path——终审 ask 呈它,人按路径开文件审）

盘上引用汇编,零推理文本组装：读 judgement_log 路径的台账（文件不存在=零研判点,一句注明）,把 spec 全文+研判点台账+test_report 三节写入 {work_zone_root}/review.md,review_path=该绝对路径,产出纲要。可安全重跑（覆盖写幂等）。

#### 5.8. [ask require_human=true present_inputs=review_summary] 作者终审收意见（审阅走文件）
- ← review_summary, review_path
+ → author_feedback: text  # 作者终审意见：修订意见原话回填（含具体指向）;审阅通过则置空

呈现 review_summary（纲要:计数+结论+文件路径——**审阅载荷几十 K 走文件不内联终端**,人按 review_path 打开审阅文件:spec 全文/研判点台账〔新增决策点终裁:暂采答案对不对、该落 ask/confirm 的有无漏〕/实测报告三节全在）,请作者按文件审阅功能一致性（忠实映射原文、无遗漏无杜撰、I/O 与控制流保留——source.md 原文副本随产物在,供对读核实）。**通过 → author_feedback 置空;有修订意见 → 原话记入（意见即下一轮迭代的驱动）。**

#### 5.9. [check final] 意见闸：终审意见清空才放行（机械闸,非二次审查）
- ← author_feedback
+ → approved: bool  # 判定槽：作者终审放行
+ → iter_feedback: text  # 更新模式：终审意见回填,构建循环重跑定向重展开后再走各关与终审；放行置空

机械闸,body 引擎直执零 LLM（忠实审查本体在 5.8 的真人——本步只把意见转成流控信号:引擎的重跑回路由 check final fail 驱动,判的是 ask 产出故必在其后）：
> ```hop_python
> approved = len(author_feedback) == 0
> iter_feedback = "" if approved else author_feedback
> ```

approved=false 即 fail（构建循环 retry:按 iter_feedback 里的意见重 call 展开器定向修正 → 重过各关 → 再呈终审——review 意见即迭代,不一票废弃）。意见指向头部契约（目标/交付物/业务输入/档位）时超出本事务修复范围,如实说明并 fail——人按意见重发起;作者要中止=run 层中止,意见通道只管修订。

### 6. [commit] 写盘交付 spec 与原文副本
- ← spec_text, skill_path
+ → generated_spec_path: line  # 最终写盘路径（body 纯计算产出）

交付写盘,body 引擎直执零 LLM（把关在前：终审 require_human 真人已审 + 忠实门 check final 放行;幂等——同名覆盖写,重跑结果一致）：
> ```hop_python
> generated_spec_path = replace(skill_path, "SKILL.md", "spec.md")
> write(path: generated_spec_path, content: spec_text)
> source_copy = read(path: work_zone_path("source.md"))
> write(path: replace(skill_path, "SKILL.md", "source.md"), content: source_copy)
> ```

（source.md=原文纯副本,终审与日后对读的物理基准,随 spec 同目录交付。）

### 7. [exit] 交付翻译结果

返回 generated_spec_path 与 test_report。
