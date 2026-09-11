%% @trace
	id: hopjit-tools-spectree
	source: [[../tools]]
	source_id: hopjit-tools
	type: extract
	last_sync: 2026-08-31T00:10+0800
	note: spec 内容工具族模块设计（读/写/验三面+族总览）——2026-08-31 自 tools.md 拆出（作者定"文件工具、spectree工具，都应该成为模块"）。四锚原名随迁不改（^anc-exec-spec-tools-family / ^anc-exec-builtin-edit-tree-tool / ^anc-exec-builtin-read-tree-tool / ^anc-exec-builtin-validate-tool）。AST 核心 spec-tree-edit.ts 归 spec-ast 模块（2026-08-30 cd8c4d1 定——纯 AST 操作与 ast-helpers 同性质,出口登记在 spec-ast.md）,此处是工具壳契约。
%%

# spec 内容工具族（读/写/验）

> **模块版本**：随 tools 模块（[[../tools]] v0.14.0,2026-08-31 行级手术改造——树编辑四工具文本产出弃全文重建,见下 ^anc-exec-tree-edit-line-surgery;拆分时点 v0.13.1,同日三修——归类修正批+族总览伪签名清理+TS 问号记法清尾〔返回形状 work_items?/参数注释 node_path?——0723ea9 点名'?后缀是 TS 记法'但当批只修了入参位,返回位与注释位漏网;条件字段语义改散文写明〕）。本文件是 tools 模块的组成部分,不独立计版——契约变更升 tools 模块版本号。

tools 模块的 spec 内容工具组（装配层本体见 [[../tools]]——本文管这一族六件工具的契约）。实现文件 `src/tools.ts`（工具壳）+ `src/spec-tree-edit.ts`（AST 核心,spec-ast 模块归属）。

## spec 内容工具族总览【说明】 ^anc-exec-spec-tools-family

维护 spec 文本的六件内置工具是一族（读/写/验三面——写面四件+验一件+读一件,全部纯函数——内容进内容出,零文件访问;文件读写归内置文件工具组,职责分立）,配 hop_python 的 parse_json 解码内置构成完整闭环：

| 工具                                    | 面    | 输入 → 输出（入参恒命名传,`[]`=可省略——权威见下"调用形态"条,此列是速览）                                                                        | 一句话                                             | 契约节                              |
| ------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------- |
| `read_spec_tree`                      | 读    | `read_spec_tree(spec_text: …, mode: …[, node_path: …])` → `{status, text}`                                         | 按步骤树选择性读取——skeleton 读骨干 / node 下钻子树,不整文灌 prompt | ^anc-exec-builtin-read-tree-tool |
| `insert_node`                         | 写    | `insert_node(spec_text: …, node_path: …, fragment: …)` → `{status, spec_text, renumber_map}`（传了 work_items 则返回里多一个改写后的 work_items） | 片段插到写定序号位,原位者及后继后移;插尾=末位+1                      | ^anc-exec-builtin-edit-tree-tool |
| `replace_node`                        | 写    | 单项 `replace_node(spec_text: …, node_path: …, fragment: …)` / 批量 `replace_node(spec_text: …, replacements: …)` → 同上 | 目标连行带子树消失,片段接原位（占位替换）;批量按调用前号定位                 | 同上                               |
| `replace_children`                    | 写    | `replace_children(spec_text: …, node_path: …, fragment: …)` → 同上                                                   | 子树换血节点行保留;node_path='root' 替换整个 Steps           | 同上                               |
| `renumber_steps`                      | 写    | `renumber_steps(spec_text: …)` → 同上                                                                                | 不改结构只按树位置重刷编号（修错位草稿）                            | 同上                               |
| `validate_spec`                       | 验    | `validate_spec(text: …[, fragment: …][, known_vars: …])` → `{status, errors, warnings}`                            | 合法性验证（与 CLI validate 同一实现）——编辑完必验,编辑器自己不验       | ^anc-exec-builtin-validate-tool  |
| `parse_json`（hop_python 内置函数,非工具）     | 解码   | 工具返回的 JSON 文本→结构值,body 里接工具输出用                                                                                     | [[../act-body#^anc-exec-parse-json]]            |                                  |
| `subprocess.run`（hop_python 内置函数,非工具） | 外部命令 | 白名单命令行调用（argv 结构化,sandbox.runtime.available 白名单强制）——不属 spec 内容族,此处只给指针防找错文档                                        | [[../act-body#^anc-exec-subprocess-run]]        |                                  |

**典型用法链**（hopbuild2 拼装步实战形态）：`read_spec_tree(skeleton)` 定位 → `replace_node`/`insert_node` 定向改 → `parse_json` 取回 spec_text → `validate_spec` 验 → write 落盘。编辑代数的上层裁定权威在 D44（[[../step-dispatcher]] replan 编辑序列条目——delete/replace/insert 三原子,未提及=保留;本工具的 insert 语义即其裁定①的兑现）;教学面见 [[../../tutorials/D11-维护spec的内置工具]]。

## 内置 spec 树编辑函数组【契约】 ^anc-exec-builtin-edit-tree-tool

**函数化重构（2026-08-30 作者两连拍板）**：①"edit_spec_tree 的逻辑不成立，那些都是应该被调用的函数干的事情，而不是这么丑陋的挤在一起"——原单工具四操作靠 op 参数分发的形态废除，拆成**四个独立注册工具**（insert_node / replace_node / replace_children / renumber_steps），各自签名各自文档各自可调；②replan 编辑序列的机械拼装统一到同一组树编辑核心（见下"两层结构"与 [[../step-dispatcher]] D44 条目拼装段）——库内一套编辑代数一处实现。旧 `edit_spec_tree` 入口**废除不留兼容壳**（唯一真实调用点 hopbuild2 拼装步 body 随批迁移，0.x 未承诺稳定；留兼容壳=被否形态换门牌活着）。

**两层结构**：

1. **AST 级树编辑核心**（`src/spec-tree-edit.ts`，spec-ast 模块归属〔纯 AST 操作与 ast-helpers 同性质;契约留在本文档不改变代码归属〕——AST 进 AST 出，零文本零工具壳，dispatcher 的 replan 拼装直接调它，不绕"AST→文本→再 parse"）：
   - `insertNodeAt(steps, nodePath, fragSteps)`——落位号写定，原位者及后继后移；插尾=该层末位号+1（唯一越界位）；其余不存在的号响亮拒；
   - `replaceNodeAt(steps, replacements)`——原位拼接替换（节点连行带子树消失，片段接进原位）；入参恒为 `[{nodePath, fragSteps}]` 数组（单项=长度 1），两阶段执行（先全部按调用前号解引用，再逐个 splice——边拼边查会撞先拼入片段的相对号）；
   - `replaceChildrenAt(steps, nodePath, fragSteps)`——子树换血，节点行自身保留；nodePath='root' 替换整树；
   - `deleteNodeAt(steps, nodePath)`——节点连行带子树移除（D44 三原子的 delete——原工具面从来没有它，replan 统一时补齐编辑代数第四原子；工具入口暂不暴露 delete：spec body 场景无删步需求，需要时另立）；
   - `renumberSteps(steps)`——全树按位置重编号，返回旧号→新号全映射。**四个编辑函数不自动重编号，原因是定位协议**：批量 replacements 与 replan 编辑序列都按**调用前的步骤号**定位目标（D44 协议语义——编辑清单引用的是改动前的号），一个编辑序列里做多处编辑时，中途重编号会让后面还没执行的目标号全部失效。所以重编号只能等全部编辑落完后做一次——renumberSteps 就是这个『最后统一重编』的执行点。对外不暴露未重编状态：工具壳每次返回前必调它，调用方拿到的 spec_text 恒为已重编的成品；
   - `syncWorkItems(workItems, renumberMap)`——队列引用同步。

     **work_items 是什么**：构建类流程（如 hopbuild2 增量展开）维护的待办清单——『哪些步骤还要继续加工』。它是一个字符串数组，每行一条待办，行格式固定三段、用 `|` 分隔：`<步骤路径> | <这条待办要干什么的一句话> | <权重>`。第一段是这条待办**指向的步骤**，写法有两种：带 `root.` 前缀的路径（`root.2.1` = 全文第 2 步的第 1 子步；单写 `root` = 指整棵树）或裸步骤号（`2.1`）——两种都合法，来自不同调用方的书写习惯。后两段是业务信息，本函数不理解也不碰。

     **为什么需要同步**：步骤号就是树位置——编辑（插入/替换/删除）之后 renumberSteps 把全树重编，原来的『第 2 步』可能变成『第 3 步』。队列里的行还写着旧号，不改写就全部指错对象（待办『展开 2.1』实际指向了一个无关步骤）。调用方自己改写要逐行解析、对映射、拼回去，手写必错——所以工具壳在重编号后自动替调用方做掉。

     **改写规则逐条**：
     - 取每行第一段，剥掉 `root.` 前缀（若有）得到裸步骤号，拿它查 renumberMap；
     - 查到（该步骤被重编了）→ 第一段换成新号（原来带 `root.` 前缀的，新号仍带前缀），后两段原文保留；
     - 查不到（该步骤没被这次编辑波及，或第一段是 `root` 整树指针）→ 整行原样保留；
     - 命中改写的行，三段间分隔符统一重排为 ` | `（空格竖线空格）；未命中的行连分隔符都不动。

     **一个走完整场景的实例**。spec 现在长这样，待办清单里记着『汇总容器还没展开，回头要展开它』：

     ```
     ## Steps                                 work_items 待办清单:
     1. [act] 取数                             root.2 | 展开汇总容器 | heavy   ←指着第 2 步
     2. [subtask] 汇总（容器,还没展开）
     3. [commit] 存档
     ```

     现在调 `insert_node(node_path: "2", fragment: 清洗步片段, work_items: 上面的清单)`，在 2 号位插一个『清洗』步。插入并重编号后树变成：

     ```
     ## Steps
     1. [act] 取数
     2. [act] 清洗          ← 新插入的,占了 2 号
     3. [subtask] 汇总      ← 就是原来的 2——步骤本身没动,编号被顶成了 3
     4. [commit] 存档       ← 原来的 3,顶成 4
     ```

     renumberMap = `{"2":"3","3":"4"}`（旧号→新号）。此刻看待办清单：那条 `root.2` 若原样不动，顺着它找到的是**新插进来的『清洗』步**——后续流程会去展开一个根本不需要展开的步骤，而真正没写完的『汇总』（现在的 3 号）永远没人管。syncWorkItems 按映射把这行改成：

     ```
     root.2 | 展开汇总容器 | heavy   →   root.3 | 展开汇总容器 | heavy
     ```

     **待办跟着它指的那个步骤走，不被中间插队的新步骤带偏。**同一份清单里若还有 `1 | 补充输入说明 | light`（指『取数』——它在插入点之前，编号没变，映射里没有 `"1"` 键）和 `root | 终检整棵树 | light`（`root` 指整棵树不指具体步骤），这两行原样保留。
2. **工具入口**（src/tools.ts，四个独立注册工具）——各自薄文本壳，**行级手术形态**（hopissues/0048 作者拍定方案 A，契约细则见下"行级手术"节）：parse（全文或 spec_is_fragment 裸片段,**只用于定位与记账,不用于产出文本**）→ **片段节点打临时唯一号**（`__frag` 前缀——片段自带 1..n 相对号会与原树 step_id 撞号,撞号会把『片段相对号→最终号』污染进 renumber_map,进而让 syncWorkItems 误改写指向未移动步骤的队列项;与 dispatcher replan 拼装的 tagTemp 同法,2026-08-30 review 面二/面三同源实证后补）→ 调核心函数（AST 结构编辑,供重编号记账与合法性判定）→ renumberSteps → **从返回映射剔除临时键**（renumber_map 只含真实旧树号,『旧号→新号全映射』语义才成立）→ syncWorkItems → **在原文行数组上做行级手术产出文本**（不走 serializeSpec/serializeFragment 全文重建）。四工具返回形态一致 `{status, spec_text, renumber_map}`（传了 work_items 则多返回改写后的 work_items——TreeEditResult 四字段见下 HopType,work_items 是"传入才出现"的条件字段）。

**四工具各自契约**：

- `insert_node(spec_text: …, node_path: …, fragment: …[, spec_is_fragment: …][, work_items: …])`——片段插到 node_path 写定的序号位置，该位置原有步骤（及后继兄弟连同子树）自动后移，全局连锁重编号；嵌套层同法（如 2 的子层现有 2.1-2.3，插尾写 node_path="2.4"）。（insert 语义 2026-08-30 作者定："insert 直接写定序号就行"——原 insert_before/insert_after 双操作系未经拍板复活 D44 裁定①否掉的"add after"语义，已废；名字与 replace_node 对齐定 insert_node。）
- `replace_node(spec_text: …[, node_path: …, fragment: …][, replacements: …][, spec_is_fragment: …][, work_items: …])`——占位叶子替换（2026-08-21 hopbuild2 压测补：replace_children 会把脚手架行本体留在树里）。批量 `replacements: [{node_path, fragment}]` 与单项二选一（批量在场忽略单项）——各目标按**调用前**步骤号定位，全部替换后统一重编号，目标须互不嵌套不重复（违约响亮拒不裸崩——嵌套判定是**主动的双向检查**:第一阶段解引用后对目标两两判祖先-后代关系,任一方向嵌套即拒;不靠『外层先执行内层恰好离树』的次序巧合,[内,外] 次序同样拒〔2026-08-30 review 实证该次序原静默吞掉内层编辑〕）。
- `replace_children(spec_text: …, node_path: …, fragment: …[, spec_is_fragment: …][, work_items: …])`——容器展开：节点行保留子树换血；node_path='root' 替换整个 Steps。
- `renumber_steps(spec_text: …[, spec_is_fragment: …][, work_items: …])`——不改结构只重刷编号（修复错位草稿）。

### 行级手术：编辑落在原文行数组上,不做全文重建【契约】 ^anc-exec-tree-edit-line-surgery

**为什么（hopissues/0048,2026-08-31 作者拍定方案 A）**：原形态"parse→改 AST→serializeSpec 全文重建"结构性有损——parser 在建 AST 前就丢弃了四类载体（`%% @trace %%` 头块 / `<!-- @a: anc-* -->` HTML 注释锚 / 声明行的多行续行注释 / `Goal:`·`Constraints:` 行式头形态），serialize 无从回写。实测对 hopkb 891 行真规约干跑一次 renumber_steps（理论零 diff 操作）丢 213 行。工具立项本意是"维护序号一致性"，修一处伤全文等于不可用于存量规约维护。

**手术底账（HopType）**——parse 后立的行级手术工作台账,四字段是契约四条的落地骨架：

```
struct: TreeEditSurgeryLedger        # 实现载体 src/tools.ts TreeEditParsed(在 AST 定位三元组之外扩的四个手术字段)
  Id: tree-edit-surgery-ledger
  Fields:
    - lines: [line]           # spec_text 原文行数组——手术的字节权威,一切产出行从这里切
    - src_lines_of: yaml      # 节点→其源行数组的映射(主文节点→lines;片段节点→各自片段的行数组)——搬移时每个节点从自己的源取字节
    - prefix_end: int         # 0-based 排他:首步行之前的原文行全属前缀,原样进出
    - suffix_start: int       # 0-based:末步范围(尾部叙事节钳位后)之后的原文行全属后缀,原样进出——钳位语义的直接承载者
```

**契约四条**：

1. **parse 只做定位与记账**：AST 用于三件事——节点定位（node_path 解引用）、结构合法性判定（响亮拒的判据面不变）、重编号记账（renumber_map/工作队列同步）。**产出文本不经 serialize**。
2. **文本产出=原文行数组上的三种手术**，靠 parser 已有的 `source_location`（每步的行区间——步骤自有行不含子步骤行,平铺步区间在 Steps 区内连续铺满）：
   - **段落搬移**：按编辑后树的先序遍历重排各步骤的原文行段（插入=片段行段落进目标位;替换=目标行段弃用、片段行段接位;子树换血=保节点自有行段、换子步骤行段）；
   - **编号改写**：重编号只改步骤行**行首编号 token**（含标题风 `### N.` 前缀形态），行内其余字节一律不碰；
   - **首尾原样**：Steps 区之前的全部行（标题/声明区/`%%` 块/任何东西）与 Steps 区之后的行原样进出，字节不动。
3. **片段按原文字节插入**：fragment 的行进树时同样只改编号 token（相对号→最终号），缩进与注释原样保留（树结构由编号决定，缩进纯外观——parser 不看缩进建树）。
4. **尾部叙事节钳位**：Steps 区之后的非关键字 `##` 节（任务卡的 `## 背景`/`## 处置记录` 等）在 parser 账面上归入末步行区间（section 边界所致），行级手术**把末步区间钳在第一个尾部 `##` 标题行之前**。节头判据两条与 parser 侧同构：①行内容 trim 后以 `## ` 开头才算节头（带前导空格的 `  ## 背景` 同判——parser 的节切分同样按 trim 后判,两侧不同构会让缩进的尾部标题钳不住）;②代码围栏内的 `## ` 行不判节头（逐行翻转围栏态,围栏内是内容不是结构）。编辑末步不得把叙事节一起搬走或删除。已知边界：末步自带的标题风契约分区（`## Task` 类,与叙事节文法不可分辨）同受钳位，此形态与树编辑工具混用时分区行留在原地不随步搬移，属接受的取舍（任务卡叙事节不丢权重更高）。

**正反例**：无错位 spec 干跑 `renumber_steps` → 输出与输入**逐字节相同**（幂等是本契约的机检形态）＝正；往返后 `%% @trace` 块/HTML 注释锚/续行注释/行式 `Goal:` 任一蒸发＝反（回到重建病）；replace 末步后 `## 背景` 节消失＝反（钳位失效）。

**engine 侧不适用**：`serializeSpec` 单向有损的既有警示不因此解除——engine 留存 rawSource 供重建的纪律照旧（本契约只管四件树编辑工具的文本产出通道）。dispatcher replan 的内存路径（AST 进 AST 出经 serializeFragment 生成展开片段）不在本契约面内——replan 产出的是**新生成**的步骤文本,无"保存量字节"命题。

> **调用形态**：hop_python body 里工具调用**恒用命名参数**——每个实参带参数名（`insert_node(spec_text: full_text, node_path: "2", fragment: new_step)`；`name=value` 的 Python kwargs 形态等价）。裸位置传参会被解释器拒（报错文案"调用须用命名参数"——2026-08-31 review 核实况:该报错无 TOOL_EXEC_ERROR 前缀,文案自身可辨识,设计随实况改文不动代码）。上面签名里的方括号表示『可省略的参数』——省略就整个不写，写就带名字，没有裸传位置实参这个选项。

**入参/返回（HopType）**：

```
struct: TreeEditCommonArgs        # 四工具共有参数
  Id: tree-edit-common-args
  Fields:
    - spec_text: text         # 待编辑 spec 全文（或 spec_is_fragment=true 时为裸步骤片段——内容直传,工具不读文件）
    - spec_is_fragment: bool  # 可选,缺省 false——true 时进出同为裸片段（parseFragment 解析,serializeFragment 直出;hopbuild2 拼装步的骨架片段形态）
    - work_items: [line]      # 可选,待同步的队列（三段式首段是节点路径的行,随重编号改写后返回;非字符串数组的畸形值静默忽略不拒;命中改写的行分隔符统一重排为 ' | ',未命中的行原样保留）

struct: TreeEditResult            # 四工具统一返回
  Id: tree-edit-result
  Fields:
    - status: line            # ok | error
    - spec_text: text         # 编辑并全局重编号后的全文（或裸片段）
    - work_items: [line]      # 条件字段——调用传了 work_items 才出现,值为随编号改写后的清单;没传则返回里无此键
    - renumber_map: yaml      # 旧号→新号全映射（供调用方核账）

# 各工具专有参数:insert_node/replace_children 加 node_path: line 与 fragment: text（片段编号相对从 1 起）;
# replace_node 加单项形态的 node_path: line 与 fragment: text（可省略——批量 replacements: [yaml]
# （[{node_path, fragment}]）在场时忽略单项,二选一）;renumber_steps 无专有参数。
```

- **行为**：parse（定位与记账）→ 核心函数树操作 → renumberSteps（`N.M` 层级号恒等于树位置——step ID 是唯一树结构权威的机械兑现）→ syncWorkItems → 原文行级手术产出文本（^anc-exec-tree-edit-line-surgery）。
- **错误面**：parse error 原样返回不编辑；node_path 不存在响亮拒；编辑后结果**不做 validate**（编辑器管结构不管语义——validate 归调用方下一步，职责分立）；失败不抛归一 ToolResult。
- **谁消费**：hopbuild2 拼装步 body（`replace_node(spec_text:..., spec_is_fragment: True, replacements: reps)` 直调）；修错步定向编辑；dispatcher replan 拼装（经 AST 核心层，不经文本工具壳）；人工修复错位草稿。

## 内置 spec 树读取工具【契约】 ^anc-exec-builtin-read-tree-tool

`read_spec_tree`（2026-08-23 作者立项『需要有按章节读内容或者读骨干的功能』——树编辑函数组的**读面对偶**：写面已有定向编辑,读面此前只有整文 read 一档,"要么全文灌 prompt、要么什么都看不见"两个极端;D40"素材/知识/步骤分开+正确使用文件"的读面兑现:大 spec 住文件,消费方先读骨干、按需下钻节点）：**AST 级选择性读取**的纯函数工具（与 validate_spec/树编辑四件同族:内容进内容出,零文件访问）。

- **输入**：`read_spec_tree(spec_text: …, mode: …[, node_path: …][, spec_is_fragment: …])`——spec_text=全文（或 spec_is_fragment=true 时裸步骤片段）;mode=读取档;node_path 在 mode=node 时必填（目标步骤号）;spec_is_fragment 缺省 false。入参恒命名传（见树编辑节"调用形态"条,同律）。
- **两档**：
  - `skeleton`——只出结构树：每步一行 `step_id. [type+属性] summary`,加 `- ←`/`+ →` IO 声明行;**不含执行说明（`>` 行）与 hop_python body**——结构与接口可见,素材不出（读骨干档:审阅/规划/定位用,体量正比步数与素材无关）;
  - `node`——指定 step_id 的**子树全文**（serializeFragment 单树切片,含执行说明与 body）——按需下钻档（"按章节读":定位到目标后取该节点完整内容,不带兄弟不带全文）。
- **与 doc-ref 的分工**：doc-ref 按**文档章节标题**切片（知识供给面——`[[doc#节]]` 注入 prompt）;read_spec_tree 按**步骤树**切片（结构操作面——编辑 spec 的 agent 的读工具）。两者正交,不互替。
- **行为**：parse 全文/片段 → mode 分派（skeleton=全树walk产结构行;node=定位子树 serializeFragment）→ 返回 `{status, text}` JSON。
- **错误面**：parse error 原样返回;mode=node 且 node_path 不存在响亮拒（`{status:"error", errors:[...]}`——不静默空串）。
- **谁消费**：编辑 spec 的 act body（目标形态:hopbuild2 审阅备料/定向修订先读骨干再下钻,不整文进变量——**四件套现文尚未接线,属后续优化项非本批交付**,如实标注防审计误判承诺空转）;人工调试。dispatcher 的 replan 生成段不经本工具（它在引擎进程内直接 serializeFragment 切片——工具面服务 spec body,进程内代码直用函数）。

**入参/返回（HopType）**：

```
struct: ReadSpecTreeArgs
  Id: read-spec-tree-args
  Fields:
    - spec_text: text          # 全文或裸片段
    - mode: line               # 枚举 skeleton | node
    - node_path: line          # mode=node 必填——目标步骤号（如 "2.1"）
    - spec_is_fragment: bool   # 缺省 false;true 时 spec_text 经 parseFragment 解析

struct: ReadSpecTreeResult
  Id: read-spec-tree-result
  Fields:
    - status: line   # ok | error
    - text: text     # skeleton=结构树文本;node=子树全文（serializeFragment 形态）
    - errors: yaml   # status=error 时的结构化错误（parse error 原样/NODE_NOT_FOUND）
```

## 内置 spec 验证工具【契约】 ^anc-exec-builtin-validate-tool

**为什么 in-process**（作者定 2026-08-16）：hopbuild 等构建类 spec 的验证步此前 shell 出 `hopjit validate` 子进程——而 parseSpec/validateSpec 就在引擎进程里。in-process 三利：与引擎**同版本**（"skill 新引擎旧"撕裂面在验证环消失）、零进程开销（大循环每轮至少一验）、结果结构化直达（不经 stdout 文本再解析）。CLI `validate --fragment` 不撤——人工调试与外部调用入口，两通道同一实现。

**能力契约（HopTrait）**：

```
trait: BuiltinValidateSpec
  Id: builtin-validate-spec
  Provides:
    - validate_spec   # spec/片段合法性验证（对 LLM 与 body 可见的工具面）
  Constraints:
    - 纯函数：只读入参文本,零文件系统访问（十件文件组的路径校验链不适用）,requires_commit=false
    - 与 CLI validate 同一实现（parseSpec/parseFragment + validateSpec）——两通道零语义分叉
    - 解析错误与验证错误同槽归一（parse error 也入 errors 数组,status 恒 error/ok 二值——调用方单一判读点）
    - 失败不抛：任何内部异常归一 ToolResult{success:false}（工具结果通道回执行方,与十件组同约）
```

**入参/返回（HopType）**：

```
struct: ValidateSpecArgs
  Id: validate-spec-args
  Fields:
    - text: text              # 待验 spec 或片段全文（内容直传——不是路径,工具不读文件）
    - fragment: bool          # 可选,缺省 false。true=片段模式（parseFragment,豁免面见 [[../spec-parser#^anc-rule-fragment-mode]]）
    - known_vars: [line]      # 可选,片段模式的上层已知变量名（入 V1 来源）
```

返回 `content_type: 'json'`，result 为 `{status: ok|error, errors: [...], warnings: [...]}`——与 CLI ValidateResponse（[[../hop-cli#^anc-cli-validate-response]]）同形，字段逐一对应。

**关键逻辑（HopSop）**：

```
validate_spec(args):
1. [branch] 按 fragment 选解析器
   1.1 [case(fragment == true)] parseFragment(text)
   1.2 [case(else)] parseSpec(text)
2. [branch] 解析错误在场?
   2.1 [case(有 parse error)] 返回 {status: error, errors: parse errors, warnings: []}——与 CLI 同序:解析错误即 error 级,不再跑规则
3. validateSpec(ast, undefined, fragment ? {fragment: true, knownVars: known_vars} : undefined)
4. 按 severity 分桶（error → errors / 其余 → warnings）,status = errors 空 ? ok : error
```

**正反例**：整文合法 spec → ok/裸片段+known_vars → ok/片段缺 known_vars → V1 error/整文模式吃裸片段 → parse error（Missing spec title）/fragment 传非 bool、known_vars 传非数组 → success:false 报参数错不吞。
