%% @trace
	id: hopbuild-knowledge
	source: [[hopbuild 散文版 SKILL.md（已退役,见 git log）]], [[../../docs/design/hopbuild]]
	type: extend
	last_sync: 2026-08-17T10:52+0800
	note: hopbuild 翻译判据知识件——spec 各步 doc-ref 注入源。宪法投影+四类纪律落点细则+body/知识外置判据;语法面在 hopbuild-primer.md（统一知识源）。
%%

# hopbuild 翻译判据（知识件）


## 宪法级原则（纪律不可降级，违反 = 翻译错误）

> 原则**权威在设计**（docs/design/hopbuild.md ^anc-build-principles 七则全集）——本节是注入投影,两处冲突以设计为准。

翻译的正确性底线=宪法两支柱+人机面，拆开恰是四类纪律落点（遍历 traverse／核验 verify／提交 commit／研判 hitl——细则各见「四类纪律落点翻译规则」对应节）。不是风格偏好，违反即错误：

1. **遍历点 traverse——循环遍历不漏（支柱①）**：自然语言原文里每个"对每一个/逐个/遍历"都必须翻成 `loop for-each` 容器（`[loop for-each x in xs]`，引擎驱动游标；各项独立时加 `, parallel` 并行遍历、全部完成才 join）。**禁止**翻成 act body 里的 `for` 循环或 reason"逐个分析"——那把遍历完整性又交回 LLM 记忆。**唯一例外=嵌套遍历的内层**（渐进原则『一次只拆一层』,见下）：外层已 for-each 时,内层第一版留任务描述合法——此例外只对内层成立,最外层遍历无任何豁免。

2. **核验点 verify + 研判点 hitl——核验不跳（支柱②核验段）,真人拍板（人机面）**（原文常混说"审核/把关/确认",翻译必须分辨——机器能核验的落 check〔verify〕,原文真要人拍板的才落 confirm/ask〔hitl〕）：
   - **产出核验**（"验证达标"/"确保满足约束"/自然语言原文的每条 Constraints）→ `check`，关键验收放 `subtask + check final`（不可被 adaptive 跳过）。**禁止**丢失原 自然语言原文里的任何约束验收。
   - **人来把关**（原文明确要求审批/授权/"让用户确认"时）→ `confirm`（paused/HITL，driver 不得替答，reject 全局中止）。**禁止**翻成 reason"判断是否该批准"（架空外部决策者）；也**禁止**把原文没有的人审擅自加进来——机器能核验的用 check。**与研判点新立项的边界**：原文『视情况/酌情』等**人裁量语义**处新立 ask/confirm 不算擅自加（那是原文隐含的研判点,只是没写成显式审批句——记入研判点台账,终审呈作者过目）;真正的擅自加=原文**通篇无该裁量语义**、纯凭『感觉该问一下』添的人审。

3. **提交点 commit——提交把关（支柱②提交段）**：不可逆操作（发送/支付/写生产/删除/提交）必翻成 `commit`，且其**前序须有把关闸门**——confirm（人审）**或**足够的 check（验证放行条件满足）**或**环境预授权（能执行到即已授权）三选一；试错/中间产物用 `act`（可安全重跑）。**禁止**把不可逆操作放进 act、让 commit **无任何前序把关**、或在 retry 容器内把 commit 放在把关步骤（confirm/check）之前（"探索→验收→提交"同容器合法且是正统形态）。

> 四类落点的概念层权威锚点、识别信号、生成模板、反例，全在本文件「四类纪律落点翻译规则」四节——升格成文时逐落点对照。

**用户注意力原则（产物定位约束）**：翻出的 hopskill 是**给非程序员用户**用的——spec 的 ask/confirm 问题措辞、present_inputs 呈现、输出说明都要按"业务用户能懂"写，**零行话**（不说 AST/引擎/步骤类型，说用户语言）；spec 不该指望用户看得懂命令行。**注意力是最宝贵的资源,守双向红线**：能推断的别问（default_value 给足）、必须问的一次问清、暂停点只留业务上真需要人拍板的——**但反向同罪**：该请人研判的不得合并进别的问题一笔带过、不得给个 default 就悄悄溜过（真研判点给 default=引导用户闭眼确认,比多问一次更伤）。颗粒度判据：**一个 ask=一个用户能独立作答的决策**——两个独立决策合进一问=用户被迫打包拍板;一个决策拆成三问=碎问耗散。

**spec Inputs 判归属（恰如其分,双向红线）**（2026-08-15 作者两轮定形:Inputs 就是 spec 的 Inputs——**任务的业务输入**,运行时由发起方提供的数据,判据只用 spec 语义不掺执行层词汇）：
1. **只收业务输入**：原文任务需要外部提供的业务数据**一个不漏、不添**（漏=任务盲跑,添=忠实翻译违约）;
2. **执行/驱动设施不是业务输入**：CLI 路径/状态目录/工作区/当前时间这类设施事实**不进 Inputs**——它们属于运行环境,spec 步骤描述直接说『用执行环境的 X』即可（实撞:cli_path 是散文版遗迹——原文任务根本不需要用户告诉它 CLI 在哪）。

**spec Outputs 判归属（对称面,2026-08-15 作者补抓'输出不用管的么'）**：
1. **原文承诺的交付物一个不漏**（每个交付物有 Output 承接——漏=翻译丢失交付契约）;
2. **不添原文没有的交付物**（忠实翻译在输出面的投影）;
3. **中间产物不进 Outputs**：草稿/中间清单/内部判定是流程内务,交付出去=把工作台摆进交付箱——中间产物在步骤间流转即可,Outputs 只放原文真承诺给用户的东西。

（用户填/agent 自供的区分、包装参数表怎么列——那是**壳层**（pack 薄包装）的事,原则单立于 pack 契约 ^anc-cli-pack-shell,不在翻译判据内。）

**另四条原则**：
- **渐进翻译，不一次做深（仅重档任务采用——轻档已单轮直译到叶子,不适用本条）**：一次翻译只做**结构最小集**——把原文里"对每一个"拆成 for-each、把关键验收落成 check、把不可逆隔离进 commit，**到此为止**；其余（细分支展开/并行标注/知识外置/call 拆分等增强）留给后续迭代按实跑反馈逐步加。**循环一次只拆一层**：原文嵌套遍历（『对每个 X 的每个 Y』）第一版只把**最外层**翻成 for-each,内层留在子步骤的任务描述里交执行 LLM（`[reason] 逐个核对该客户的订单` 合法——内层完整性此时还不是引擎强制,这正是渐进的代价与自觉,后续迭代按实跑反馈再拆内层）;**用户额外要求**（点名『内层也要不漏』/原文把内层遍历标为关键纪律）才一次拆到位。**关注点分步不并做**：结构（SOP 分解+落点标注）是第一步;**I/O 与 ask 面是第二步**（结构定了再补数据面与研判点）;**retry 归约束环与细节环**（该不该有在失败语义约束定,值在细节构造定）;知识外置与 enum 化是升格时随手做的执行细节。每步一个关注点——并做=哪个都做不透。一次翻到"最完备形态"= 用户拿到一份看不懂也改不动的复杂 spec，首跑失败面大、定位难、信任崩——**宁可第一版简单能跑，不要第一版完备难懂**。判据：第一版 spec 的步骤数量级应与原 NL skill 的自然段落量级相当，膨胀超 ~2 倍即该反省"是否一次做深了"。
- **LLM 节点输出必须简单**：每个 reason/act（无 body）步骤的 `+ →` 输出**首选单值或平面字段**（line/bool/enum/int），**避免嵌套 yaml/复杂结构**——输出格式越复杂,LLM 格式错误率越高,轻量级模型（flash 档路由）尤甚,量大必错。要结构化大产出时**拆步骤**：一步一个简单输出,或"reason 出平面字段 → act body 机械组装结构"（组装是确定性代码不是 LLM 格式赌运气）。复合输出就地展开（`+ → report:` 缩进子行）是给**确有需要**的场景,不是缺省姿势。
- **忠实翻译，不增删业务逻辑**：只做 自然语言→spec 的结构化映射，不擅自加/减工作流步骤（核心观点归原 skill 作者）。原文意图不清 → §4 问作者，不臆断。
- **生成即校验**：产出的 spec 必须过 `validate`（语法）+ 作者过目（语义忠实），双门都过才交付。交付时**附 pack 指引**：`hopjit pack <spec.md>` 可把该 spec 打包成独立具名 skill（非技术用户用自然语言触发、无需知道 /hopspec）——自然语言 skill → spec → 具名 skill 的升级闭环。


---

# 四类纪律落点翻译规则（hopbuild 的正确性核心）

> 每类落点给：**识别信号**（自然语言原文里怎么认出它）→ **生成模板**（翻成什么 HopSpec 结构）→ **反例**（翻错长什么样）。落点定义权威在设计语义面「纪律落点标注可核」条；本四节是升格成文时的操作细则。概念层权威锚点在每节标注。

---

## 遍历点 traverse：循环遍历不漏 → for-each 容器

**概念层**：`^anc-step-parallel`（`HopSpec V3核心规范.md`）。引擎按列表驱动逐项执行、体内标注 parallel 的步骤异步派发（渐进并发）、**容器结束前引擎收齐全部派出的活**、`collect` 子句声明的单项输出由引擎收进列表——遍历完整性由引擎收齐语义保证，不靠 LLM 记着"还有几个没处理"。

**识别信号**（自然语言原文里）：
- "对每一个 X…"、"逐个处理"、"遍历所有…"、"针对列表中每项…"、"批量地对每个…"
- 隐式循环：原文说"处理这些文件/模块/记录"且数量运行时才定。

**生成模板**：
```markdown
5. [loop for-each item in items, collect result into results] 逐项处理（体内步骤标 parallel 即并发）
  + → results: [text]            # collect 子句的列表端（容器头声明类型）

  5.1. [subtask retry=2] 处理单项
    - ← item
    + → result: text             # collect 子句的单项端（每轮产出，引擎轮末收进列表）
    > 对单个 item 做处理…
```
关键：**取放成镜像**——`for-each <单项> in <列表>` 取的一端、`collect <单项> into <列表>` 放的一端，单项与列表是**两个名字两个变量**；**循环体只写一个 child**（引擎按列表驱动）；`item` 在 child 及后代可作输入引用；列表变量先由前序步骤产出 `[T]` 类型。

**反例（翻错）**：
- ❌ 翻成 `[act] 循环处理所有项` 并在 hop_python body 里写 `for item in items:` —— act body **禁止循环**，且把遍历塞进一步 = LLM 执行期可能漏项，正是要消除的失效。
- ❌ 翻成 `[reason] 逐个分析每项` **且无核验闭环**——遍历完整性交回 LLM 记忆,无任何屏障。两种情况下非 for-each 合法（原则是『不漏』,for-each 只是保障策略之一——设计策略章「遍历保障两策略」）：①**嵌套内层**（外层已 for-each,内层第一版留任务描述——渐进策略『一次只拆一层』,用户点名才拆到位）;②**生成-核验-迭代**（大面生成+后续核验步查完整性+缺口反馈补——须真有核验闭环,无核验的大面生成=裸赌不算此策略）。最外层遍历若两者都不占,必须 for-each。
- ❌ for-each 下写多个不同 child 模板 —— 只允许一个（引擎按列表驱动）。多种互不相同的并发分支各自 `[subtask parallel]` 兄弟并列，或用 branch。

**单步产出规模上限（不要一口吃个胖子）**：设计 spec 时，凡一个 reason/check 步骤要对**大量条目**逐一产出结果（判定清单、审计结果、逐项报告），必须掂量单步输出规模——LLM 单次超大输出（几十条 × 每条几行 yaml ≈ 上万 token）极易死在产出阶段且已产出内容全丢（2026-08-10 实撞：97 条目的审计批连挂两次）。两种结构化解法（优先前者）：
- **切小 for-each 的元素粒度**：让每个 child 只管 ~20-30 条（前序步骤把大列表切段成 `[[T]]`，for-each 遍历段而非条目）——引擎级并行 + 每 child 输出天然有界；
- **步骤内分段落盘**：单步确实要处理大清单时，`>` 指令里明确"逐段判定、每段完成立即 Write 追加到 work_zone 分段文件、全部段落盘后读回组装最终输出"——中断后可从分段文件续，不重做。
判据：预估单步输出 > ~30 条结构化条目就必须用上述之一，禁止指望执行 LLM 一口气产完。

---

## 核验点 verify 与研判点 hitl：核验不跳 → check；真人拍板 → confirm/ask

**核心是核验**：人审只是核验的一种形式，视需求决定。审核有两种，自然语言原文里常混在一起说"审核/把关/确认"，翻译时**必须分辨**——机器能核验的用 check，原文真要人拍板的才用 confirm：

### 核验点 verify：产出核验 → check / check final

**概念层**：`^anc-step-check`。check 验证产出是否达标，固定输出 `bool + text`；失败触发容器 retry。**`check final`** 位于全部探索性步骤之后（其后只允许 commit/exit 提交性收尾）、**不可被 adaptive 改写或跳过**——是 Constraints 的可执行化身，最强的"验收不能跳"保证。

**识别信号**："验证…是否达标"、"检查…对不对"、"确保满足约束"、"质量达标才…"、自然语言原文的 Constraints 里每条硬约束。

**生成模板**（关键验收）：
```markdown
3. [subtask retry=2] 执行并验证
  + → summary: text
  3.1. [act] 执行操作
    - ← input
    + → output: yaml
    > …
  3.2. [check final] 验证 output 满足约束        # 必在探索步骤之后（其后只可 commit/exit）
    - ← output, threshold
    + → ok: bool                 # 判定槽
    + → note: text               # 说明槽（未达标时的缺口）
    > 检查 output 是否达标，输出 true/false。
```
Constraints 里每条可执行的硬约束，都应对应一个 check（关键的用 check final）。

### 研判点 hitl：人来把关 → confirm/ask（仅当原文真要人拍板或含裁量语义）

**概念层**：`^anc-step-confirm` + `^anc-exec-hitl-presentation`。confirm = paused 介入点，driver **必须**问外部决策者、**不得替答**；`require_human: true` 时必须真人；**reject 全局中止**（后续步骤全 skipped、终态 failed）——所以放在 commit 前的 confirm 是"拒绝即停、不可逆操作绝不发生"的硬闸门。

**识别信号**："让用户确认"、"人工审批"、"等待批准"、"需要授权"、"经同意后再…"。**注意**：原文只说"验证/检查/确保"没有点名要人 → 用 check，不要擅自升级成 confirm（把机器核验降级成打扰人）。**但『视情况/酌情/根据实际』等人裁量语义处例外**——那是原文隐含的研判点,新立 ask/confirm 不算擅自加（研判点台账记档,终审呈作者终裁）;裁量语义与核验语义的区分：前者无客观判据（人偏好/权衡）,后者有(格式/阈值/规则)。

**生成模板**：
```markdown
6. [confirm require_human] 请批准执行修复
  - ← fix_plan                   # 给决策者看的依据
  + → approved: bool             # approve→true；reject→全局中止
  > 展示 fix_plan，请决策者批准是否执行。
```
`require_human` 修饰：涉及不可逆/高风险 → 加（强制真人）；一般确认 → 可省（允许上层 agent 代答，但默认倾向问人）。

**反例（翻错）**：
- ❌ 人工审批翻成 `[reason] 判断是否该批准` —— reason 是 LLM 自己推理，**架空了外部决策者**，违反 CITL 语义。审批必须 confirm。
- ❌ 产出核验翻成 `[act] 检查质量` 且不放容器 —— 孤立 check 违反 c6；且 act 无 retry 兜底，达标失败无法重试。
- ❌ 关键验收用普通 check（非 final）放 subtask 中间 —— 可能被 adaptive 跳过。硬约束验收用 **check final** 钉在探索段末（其后只做提交性收尾）。
- ❌ 原文"最多试 N 次/不通过就重做"翻成 `loop max=N` + `branch` 判是否通过的手搭重试 —— loop 无事务语义（不整组重跑、无失败注入、check 进不了 loop〔C6〕），正确形态恒为 `[subtask retry=N]` + 尾部 `[check final]`（引擎自带次数上限/反馈注入/耗尽升级）。
- ❌ 自然语言原文里明明说"确保 X"却在 spec 里没有任何 check —— 约束丢失，翻译不忠实。

---

## 提交点 commit：提交把关 → act（可逆）vs commit（不可逆）

**概念层**：`^anc-step-act` vs `^anc-step-commit`。act **必无不可逆副作用、可安全重做**；commit 有不可逆副作用、**不可重试、需幂等**，且**能执行到 commit 说明授权/放行已在前序完成**——概念层原文：「前置 confirm 步骤 **或** 环境预授权」。即 commit 要的是**前序有把关闸门**，不是硬绑 confirm。把关闸门三选一：**confirm**（人来批）／**足够的 check**（验证放行条件已满足，如"质量达标才落库"）／**环境预授权**（能跑到即已授权，无需额外步）。试错/探索阶段的所有操作都应是 act（可反复重跑不留后果），不可逆动作隔离到 commit。

**识别信号**（不可逆 → commit）：
- "发送邮件/消息"、"支付/扣款"、"写入生产数据库"、"删除文件"、"提交 git"、"调用写语义的外部 API"、"发布"。
- 判据：**这个操作做完能不能安全地再做一遍 / 撤销？** 不能 → commit。

**生成模板 A（人审把关：confirm + commit）**——需人拍板放行时：
```markdown
7. [confirm require_human] 批准发送
  - ← draft
  + → approved: bool
  > 展示 draft，请批准是否发送。

8. [commit] 发送邮件
  - ← draft, approved
  + → sent: line
  > 不可逆操作（发送后不可撤回，前序 confirm 已放行）：调用邮件工具发送 draft。
  > 幂等设计：按 message_id 去重，避免重复发送。
```

**生成模板 B（验证把关：check + commit）**——放行条件可自动验证时（无需人）：
```markdown
5. [subtask retry=2] 校验后落库
  5.1. [check final] 校验记录满足入库约束
    - ← record
    + → valid: bool
    + → valid_note: text
    > 检查 record 满足入库约束（必填齐全、无冲突键），输出 true/false。
5b. [commit] 写入生产库
  - ← record, valid
  > 不可逆操作（前序 check 已验证放行条件）：valid 为 true 时按业务键 upsert record（幂等）。
```
> 环境预授权场景则无需前序步——能执行到 commit 即已授权（如 CLI 已登录态下的 git commit）。

试错/中间产物用 act：
```markdown
4. [act] 生成候选草稿                # 可反复重跑，不留外部后果
  - ← input
  + → draft: text
  > 生成草稿，纯产出无副作用。
```

**反例（翻错）**：
- ❌ 把"发送/写库/删除"翻成 `[act]` —— act 契约是"可安全重做"，不可逆操作放 act = 崩溃重跑会重复扣款/重复发送。
- ❌ commit 前**无任何前序把关**（既无 confirm、也无验证 check、也非环境预授权）—— 不可逆操作无把关直接执行，违反"试错不 commit"精神。（有 confirm **或** 足够 check **或** 环境预授权，任一即可，不必都要 confirm。）
- ❌ retry 容器内 commit 前无任何把关步骤（confirm/check 均无，或把关跟在 commit 后面）——把关必须在提交之前；"act 探索 → check final 验收 → commit 提交"同容器是合法且正统的事务形态（验收不过 retry 重跑探索段，commit 只在通过后执行）。
- ❌ 试错/探索步骤用 commit —— 试错就该可反复重来，用 act；commit 只留给"最终真的要落地"的那一下。

---

## 四类落点串起来的典型形态

一个"遍历 + 审核 + 落地"流程翻完通常长这样：
```
loop for-each … + 体内 subtask parallel（traverse 遍历所有项，引擎保证不漏）
  └ subtask
      ├ act（试错/生成，可逆）
      └ check final（verify 产出核验，不可跳）
confirm require_human（hitl 人工把关）
commit（commit 不可逆落地，前序有把关闸门：confirm / 足够 check / 环境预授权）
```
翻译完对照原 skill 文本 自查：**每个遍历都成了 for-each（traverse）？每个核验都落在 check（verify）、原文真要人拍板处才有 confirm/ask（hitl）？每个不可逆操作都成了 commit 且前序有把关闸门（任一即可）？** 逐落点 yes 才算忠实——与草稿行尾标记逐一对上。


---

# HopSpec 文件骨架 + 语法速查

> hopbuild §3 生成 spec.md 时的骨架模板与语法参考。权威在概念层 HopSpec V3 核心规范文档（`^anc-ast-spec-structure` 文件结构、`^anc-rule-v3-all` 27 条验证规则）——本文件是速查，拿不准回权威。

## act / commit 的 hop_python body

act / commit 步骤可带 ` ```hop_python ` 围栏（无推理编排：纯计算 + 工具调用 + 确定性分支，**禁 for/while 循环**、禁 LLM 判断分支）：

```markdown
1. [act] 统计指标
  - ← raw_data
  + → profile: yaml  # 字段统计概览
  > 无推理计算：逐字段统计缺失率/异常
  > ```hop_python
  > total = len(raw_data)
  > missing = count_nulls(data: raw_data)
  > profile = build_profile(total: total, missing: missing)
  > ```
```

**确定性分支 body 里直接写**——`if cond:` / `elif` / `else:` 语句（Python 同款缩进块）与条件表达式 `x = a if c else b` 都支持,按确定性条件赋不同值不必升 branch 步骤：

```markdown
> ```hop_python
> if score >= 90:
>     grade = "A"
> elif score >= 60:
>     grade = "B"
> else:
>     grade = "C"
> label = "达标" if score >= 60 else "不达标"
> ```
```

branch/case 步骤留给**影响后续步骤走向**的分叉（不同 case 走不同子步骤序列）；只是算个值的分支塌进 body 更省结构。

无 body 时按 `>` 自然语言描述执行（用宿主工具）。循环必须升为 HopSpec `loop` 步骤，不写进 body；工具调用用命名参数（`tool(arg: value)` 冒号形态）。

## 知识抽取与 doc-ref（大段判据外置）

**问题**：内容丰富的自然语言 skill 常在某步塞大段**判据知识**——评分规则、FLAG 清单、分类标准、方法论、报告模板。若原样全塞进 spec 步骤的 `>`，spec 会臃肿（编排骨架被判据淹没）、且判据无法复用。

**做法**（照 `scripts/audit/anchor-audit.md` 模式）：把大段判据抽成**陪伴 knowledge 文档**，spec 步骤的 `>` 用 doc-ref `[[knowledge文件#章节名]]` 引用，**引擎运行期自动切片注入**该步 agent 上下文（小节内联，超阈值转 `$file` 指针）——spec 只留编排骨架，判据沉于知识文档、引用即注入。

**何时抽**（判据）：某个 act/reason/check 步的 `>` 满足任一 → 抽：
- 承载**可复用判定规则**（如"应 FLAG / 不应 FLAG"清单、严重度分类标准、评分区间）；
- 大段**方法论/执行协议**（分几步、读哪些文件、±行号范围）；
- **报告/输出格式模板**（章节结构、统计表格式）；
- 纯经验：`>` 超过约 5-6 行且非"这一步具体做什么"的一次性指令。

**🔴 目录约束（硬）**：knowledge 文档必须与 spec **同置目标 skill 目录**，doc-ref 用目录内相对引用（裸文件名）。**禁引用 skill 目录外文件**——doc-ref 按运行时 `workspace_dir`(cwd) 解析且禁 `..`，跨目录/向上引用运行期必 P15 失败（validate 按 spec 所在目录校验、与运行 cwd 未必一致，故可能 validate 过、run 挂）。hopskill + knowledge 是自包含可分发单元。

**怎么抽**：
1. 建陪伴文档 `<spec-id>-knowledge.md`（**与 spec 同一 skill 目录**），按判据主题分 `## 章节`（章节名即 doc-ref 锚点，须真实存在——validate p15 会校验）。遵循渐进展开：一个章节一个自足判据块。
2. spec 步骤 `>` 里保留**一句话意图** + doc-ref 引用：
   ```markdown
   6. [reason] 审计 mock 质量
     - ← mock_patterns
     + → mock_audit: yaml
     > 对每个 mock 按注入的判据判定应否 FLAG，产出审计结果。引擎已自动注入（doc-ref）：
     > [[test-coverage-audit-knowledge#mock FLAG 判据]]
   ```
3. Constraints 里也可引用（如"判据权威见 `[[…-knowledge#…]]`，禁止自创判据"）。

**不抽的**：一次性的"这一步具体干什么"（如"用 Write 把 X 写入 Y"）留 `>` 即可，别为抽而抽。
