%% @trace
	id: hopjit-tutorial-spec-tools
	source: [[../design/tools]]
	source_id: hopjit-tools
	type: compact
	last_sync: 2026-09-01T20:26+0800
	note: D 系列 11（2026-08-30 作者令"把这套工具总体收拢一下,归集到同一个design和D系列tutorial文档里"）——spec 内容工具族教学：读/写/验三件+parse_json 解码,一处讲全。契约权威 tools.md ^anc-exec-spec-tools-family 总览 + 三件各自契约节;insert 语义同日作者纠偏（对齐 D44 编辑代数,废 insert_after）
%%

# D11 · 维护 spec 的内置工具：读、改、验一族

**给谁**：要用程序方式维护 HopSpec 文本的人——写构建类 spec（如 hopbuild2）、写修复流程、或者只是想安全地改一份几百步的大 spec 而不想手工对编号。
**权威**：契约在 `docs/design/tools.md`（族总览 + 三件各自的契约节）；本篇是教学面，讲怎么用、为什么这样设计、哪里容易踩坑。

## 为什么需要这族工具

一份 HopSpec 的步骤号（1、1.1、2.3.1……）**就是树结构本身**——引擎按编号建树。这带来一个维护难题：在第 2 步前面插一个新步骤，原来的 2 要变 3、2.1 要变 3.1、后面所有引用这些号的地方全要跟着改。靠人（或 LLM）手工改编号，任何一处手滑就是树结构静默错位——validate 只能报表层症状，真正的病（步骤挂错了爹）看不见。

这族工具把"改结构"变成 AST 级操作：你说"把这个片段插到 2 号位"，编号连锁调整由工具机械完成，零手滑面。

## 三件工具 + 一个解码函数

| 名字 | 干什么 | 什么时候用 |
|---|---|---|
| `read_spec_tree` | 选择性读取——不用整文读 | 定位要改哪里 |
| `insert_node` / `replace_node` / `replace_children` / `renumber_steps` | AST 级编辑＋自动重编号（四件独立函数） | 改结构（插步/换步/换子树/重刷编号） |
| `validate_spec` | 合法性验证 | 改完必验（编辑器自己不验） |
| `parse_json`（hop_python 函数） | 工具返回的 JSON 文本 → 结构值 | body 里接工具输出 |

三件工具都是**纯函数**：内容进、内容出，不碰文件系统。读文件和写文件用内置的 `read`/`write`——先读进来、交给工具、结果写回去，职责分立。

## read_spec_tree：先看清再动手

两档读法：

- **`mode: "skeleton"`**——只出结构树：每步一行（步骤号＋类型＋摘要），加输入输出声明行，**不含**执行说明和 hop_python 代码。一份几万字的 spec 骨架可能只有几十行——审阅、规划、定位都用这档，别整文灌 prompt；
- **`mode: "node"`**——指定步骤号，取该节点的**完整子树**（含执行说明和代码）。定位到目标后下钻用。

```
skel = read_spec_tree(spec_text: full_text, mode: "skeleton")
node = read_spec_tree(spec_text: full_text, mode: "node", node_path: "5.2")
```

## 树编辑四件：各自独立的函数

（2026-08-30 作者拍板函数化："那些都是应该被调用的函数干的事情"——原来四个操作挤在一个 edit_spec_tree 工具里靠 op 参数分发，现在是四个独立函数，各自直接按名调用。）

- **`replace_children`**——换掉某节点的全部子步骤，节点行自身保留（容器展开场景）。`node_path: "root"` 时替换整个 Steps 节；
- **`replace_node`**——目标节点**连行带子树整个消失**，片段接进原位置（占位叶子替换场景——构建流程里 `[reason] 待展开——…` 这种脚手架行就该用它换掉，用 replace_children 会把脚手架行本体留在树里）。支持批量：`replacements: [{node_path, fragment}]` 数组一次换多个占位，各目标按**调用前**的步骤号定位，全部换完统一重编号；
- **`insert_node`**——片段插到 `node_path` 写定的序号位置，**该位置原有步骤（及后继兄弟连同子树）自动后移**。"插到 2"= 新片段成为第 2 步，原第 2 步起全部顺延。插到末尾就写"最后一步的下一号"（顶层有 4 步想追加第 5 步就写 `5`）——这是唯一允许的越界号，其他不存在的号会被响亮拒绝；
- **`renumber_steps`**——不改结构，只按树位置重刷全部编号（修复已经错位的草稿）。

三个通用点：

- **片段编号从 1 起写**：`fragment` 参数里的步骤自带相对编号（1、2、1.1……），落进全文后工具统一重编号——你不用算它最终是几号；
- **`spec_is_fragment: true`**：编辑对象本身是裸步骤片段（没有 `# Spec:` 头）时用，进出同为裸片段——构建流程的骨架拼装就是这个形态；
- **`work_items` 队列同步**：如果你维护着一个按步骤号引用的待办队列，把它一起传进去，编号变动后队列里的引用自动改写。返回值里的 `renumber_map` 是旧号→新号的全映射，供核账。

一个真实的插入例子（在第 2 步前补一个核验步）：

```
r = parse_json(insert_node(
  spec_text: full_text,
  node_path: "2",
  fragment: "1. [check] 核验产出\n  - ← draft\n  + → ok: bool  # 判定\n  + → note: text  # 说明\n"
))
new_text = r.spec_text
```

原第 2 步自动变第 3 步，它的子步 2.1 变 3.1，`renumber_map` 里都有账。

> **insert 的语义演进**（读到旧材料时注意）：早期实装曾有 `insert_before` / `insert_after` 两个操作——2026-08-30 作者纠偏对齐 D44 编辑代数（"add after 语义很混乱，应该是 insert 语义"），收敛为单一 `insert_node`（落位号写定、原位者后移，无歧义;后与 replace_node 命名对齐定名 insert_node）。

## validate_spec：改完必验

编辑器管结构不管语义——树编辑函数改完的文本**不保证语义合法**（变量链断了、check 槽位错了它不管）。所以改完必接一步验证：

```
v = parse_json(validate_spec(text: new_text))
# v.status == "ok" 且 v.errors 为空才算改完
```

片段模式验证加 `fragment: true`（上层已知变量经 `known_vars` 供给，防误报未定义变量）。

## 串起来：一次安全修改的完整链

```
> ```hop_python
> full_text = read(path: draft_path)
> skel = read_spec_tree(spec_text: full_text, mode: "skeleton")     # ① 看骨架定位
> r = parse_json(insert_node(spec_text: full_text, node_path: "2", fragment: new_step))   # ② 定向改
> v = parse_json(validate_spec(text: r.spec_text))                  # ③ 验
> write(path: draft_path, content: r.spec_text)                     # ④ 落盘（验过才写）
> ```
```

这条链全程零 LLM 裁量——每一环都是机械动作，正是"探索归 LLM、机械归工具"的分工：**哪里要改**由推理步决定，**怎么改不出错**交给工具。

## 常见坑

- **带围栏的片段直接喂工具**：片段若来自 LLM 输出，可能包着 ```` ```yaml ```` 围栏——带壳喂树编辑函数会被拒"片段内无可解析步骤行"。机械口自己先剥壳（实撞：兜底片段带围栏，拼装四轮全灭）；
- **拿 replace_children 换占位叶子**：占位行本体会留在树里成为残骸，档位永远升不上去——占位替换用 `replace_node`；
- **批量 replacements 里用改动后的号定位**：各目标一律写**调用前**的步骤号，工具最后统一重编号——边改边算新号必错；
- **改完不验就落盘**：编辑器不验语义是设计分工不是疏忽，验证那一步省不得。

## 下一步

- 想看这族工具在真实构建流程里的用法：库内 `skills/hopbuild2/split-structure.md` 的拼装步有批量 replace_node 实战（注：hopbuild2 是实验性构建器，日常翻译用 /hopbuild——这里只借它的代码作工具用法示例）；
- 要给引擎添自己的工具：[[D7-开发自己的工具]]；
- hop_python 受限子集的完整文法：[[D10-hop_python计算体]]。
