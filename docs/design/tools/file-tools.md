%% @trace
	id: hopjit-tools-file
	source: [[../tools]]
	source_id: hopjit-tools
	type: extract
	last_sync: 2026-08-31T00:10+0800
	note: 内置文件/目录工具组模块设计——2026-08-31 自 tools.md 拆出（作者定"设计文档应该有归口""docs/design 下有一个 tools/ 子目录,里面放各个 tool 模块"）。锚点原名随迁不改（^anc-exec-builtin-file-tools / ^anc-exec-write-scope 全库引用面零波动靠的是名不变、目标文件名全量随改）。装配层本体与出口边界仍归 [[../tools]]。
%%

# 内置文件/目录工具组

> **模块版本**：随 tools 模块（[[../tools]] v0.17.1,2026-09-07 条目类型字段正名批——listdir/exists 返回加 type 正名字段（行业惯例）,kind 留作同值兼容别名（作者拍乙案,承诺非过渡）。上一扩员=v0.16.0 search_file+read 行号段。本文件是 tools 模块的组成部分,不独立计版——契约变更升 tools 模块版本号。

tools 模块的第一个内置工具组（装配层本体见 [[../tools]]——本文只管这一组工具的契约）。实现文件 `src/tools.ts`（`DefaultToolProvider`）。

## 内置文件/目录工具组【契约】 ^anc-exec-builtin-file-tools

概念权威 [[../../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]] 工具面。全部 `requires_commit=false`：**不可逆的分界是"是否出沙箱"，不是操作类型**——沙箱是探索区、整体可重建；`requires_commit=true` 的工具（发送/支付/写生产库这类不可逆动作）不在本组——不可逆工具或由宿主注册，或是独立的内置通道模块（第一例=[[dingtalk-notify]]，2026-08-31 起"内置恒 false"改为"按声明逐件定"——权威在各组自己的声明，装配层不设全局假设）。

**能力契约（HopSpec 契约）**：

```
# Spec: 内置文件/目录工具组
Id: builtin_file_tools
Goal: 为 act/commit body 提供沙箱内文件与目录操作的受控工具面
Constraints:
- 全部工具 requires_commit=false（沙箱内无不可逆——分界是"动作是否出沙箱造成不可逆后果"，非操作类型）
- 写侧（write/create/append/edit_file/makedirs/move/remove）按步骤权限分域（概念 ^anc-step-act-body-lang 工具组条款,作者定 2026-08-28）：**act/check 限 work_zone**（探索段写的都是中间产物,越界即拒 WORK_ZONE_ONLY,free 与否无关——free 不放大权限）；**commit 限 workspace**（持久写盘=交付动作）+ 禁 .hopstate/（引擎状态区,work_zone 是该禁令唯一豁免——isWorkZonePath 判定,work_zone_path() 产物放行;**判定必须覆盖子实例形态**:parallel/call 子实例的 work_zone 路径是三段 `.hopstate/<父>/parallel|calls/<cid>/work_zone/`——2026-08-30 语义审计实抓正则只吃一段致 standalone 子实例写自身 work_zone 被误拒,修后判定=.hopstate 内任意深度以 work_zone 结尾的段;判定第二支=MemoryPersistence 的 tmpdir 形态 hopjit-workzone-* 目录;**判定第三支=注册根前缀**（hopissues/0066 实撞后补,2026-09-03——`--state-dir` 接受任意名,state-dir 名不含 `.hopstate` 字面〔如 hopkb 的 `runtime/hopstate` 不带点〕时 work_zone_path() 产物两支全不中,被 resolvePath 的绝对路径禁令拒:引擎一手发路径一手拒路径。修法=判定向发出侧对齐:persistence 创建/取用 work_zone 时把真实根经 registerWorkZoneRoot 注册进 tools 判定面〔根过 resolveReal 防 /tmp 软链失配〕,isWorkZonePath 加注册根前缀命中支——发出侧是事实源,字面名不再是唯一判据;前两支保留存量兼容〔跨进程场景注册未发生时 .hopstate 惯例名仍通〕。备选"强制 state-dir 命名 .hopstate"不取:拆"接受任意 --state-dir"既有承诺拦存量用户。三支正反例成对钉,反例=未注册的裸自定义路径照拒） ^anc-exec-write-scope
- 写域信号=既有 allowCommit 通道（execute 的 write_scope 参数由调用方按步骤类别传入:allowCommit=true→workspace,false→work_zone;缺省 work_zone——信号缺席按窄域拒,不静默放宽）——不新增步骤类别感知,分域与 requires_commit 同一根开关
- 读侧（read/listdir/exists/search_file）走三级读权限链（denied → confirm_required → workspace/allowed）
- 路径一律 workspace 相对（禁绝对路径、禁 ..）——**唯一豁免:work_zone 绝对路径放行**（isWorkZonePath 判定命中的实例涂鸦区路径——work_zone_path() 产物就是绝对形态,拒之即内置函数产物喂不回工具面;2026-08-31 review 抓重铸面漏记此豁免,契约与代码 tools.ts 实况矛盾半日）
- OS 原子语义透传不降级：create 用排他标志（检查+创建一步完成,无 TOCTOU 窗口）,move 用 rename（同文件系统内原子替换）
- 失败显式：remove 目标不存在、create 目标已存在、move 源不存在——均报错不静默
- **实参名进闸核对**（2026-09-16 作者拍,决策页 todo/decision/20260916-内置工具参数名写时校验.md——`move(src:, dst:)` 笔误 undefined 穿透到 Node fs 报"path argument must be of type string"而 move 无 path 参,误导排查）：DefaultToolProvider.execute 分派前按该工具 ToolDef input_schema 核对实参名——未知参数名报错点名该工具全部合法参数名（"move 没有 src 参数,它的参数是 from/to"）,必填参数缺席报错点名缺谁;两判都走既有 ToolResult 失败通道（success=false）不抛异常。这是"响亮失败"守卫原则（^anc-meta-guard-trust）在工具入参面的落实——静态闸（spec-parser B2 参数名核对,写时拦）与本闸（运行期兜底,对动态拼参与宿主注入调用同样生效）两层防线不互替 ^anc-exec-tool-arg-gate
```

**工具类型约定（本组十一件）**：

| 工具                 | 入参                                                               | 返回                                                    | 语义与关键约束                                                            |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `read`             | `path, start_line?, end_line?`                                    | 文件内容 text（全文或行号段）                              | 三级读权限;两参均缺=全文（存量零回归）;带参按行号段取,越界两态与行号口径见 search_file 契约节（本文末）的 read 扩参条款 |
| `search_file`      | `path, pattern, context_lines?`                                   | 命中清单 JSON 文本 `[{line, text}]`                    | 读权限同 read;纯子串非正则;零命中空清单不报错（探测语义同 exists）;契约见 search_file 契约节（本文末） |
| `listdir`          | `path`                                                           | `[{name, type, kind}]`（type: file/dir——正名;kind 同值兼容别名） | 读权限同 read                                                          |
| `exists`           | `path`                                                           | `{exists: bool, type, kind: file/dir/none}`（type 正名;kind 兼容别名） | 读权限同 read；不存在返回 false 不报错（探测语义）                                    |
| `write`            | `path, content`                                                  | 写入确认                                                  | 新建或覆盖                                                              |
| `create`           | `path, content`                                                  | 创建确认                                                  | **排他新建**——已存在即失败；多 worker 并发抢占/幂等哨兵文件的正确原语                         |
| `append`           | `path, content`                                                  | 追加确认                                                  | 文件不存在则创建                                                           |
| `edit_file`        | `path, old_text, new_text`                                       | 替换确认（含替换处字节偏移）                                | **局部精确替换**——old_text 恰匹配一处才替换;零匹配/多匹配报错带计数（见 ^anc-exec-builtin-edit-file-tool） |
| `makedirs`         | `path`                                                           | 创建确认                                                  | 含中间层（recursive）；已存在即成功（幂等）                                         |
| `move`             | `from, to`                                                       | 移动确认                                                  | 源与目标都限 workspace 内                                                 |
| `remove`           | `path`                                                           | 删除确认                                                  | 仅文件（目录不删——最重操作不进 v1）；不存在即失败                                        |

**条目类型字段正名 type、kind 留作兼容（2026-09-07 作者拍"乙,kind 留作兼容"）**：listdir 条目与 exists 返回的"文件还是目录"字段,正名为 `type`——跨生态主流用词是 type/file_type（VS Code FileType/LSP type/Go DirEntry.Type/Rust file_type）,原 `kind` 属少数派命名,执行 LLM 按行业直觉写 `e.type` 必踩缺键坑（R9 实撞:demo-rename 步 1 过滤器 e.type 缺键恒假,文件清单恒空,真机产出必坏而 validate 全绿——deep-validate 抓获）。两字段同值并存:文档与教学只教 `type`,`kind` 不再出现在示例里但引擎照发（存量 spec 消费 kind 的零破坏,不设移除时间表——兼容别名是承诺不是过渡）。

> spec 内容族六件（validate_spec/树编辑四件/read_spec_tree）**不属本组**——同住 `DefaultToolProvider` 承载（HopSop 的纯函数分支路由它们）,但入参/返回/语义契约**全部归 [[spec-tree-tools]]**,本文不复表（双表=双权威漂移面——2026-08-31 作者抓归类错误后收口:一件工具的契约恒只在一份文档）。

**关键逻辑（HopSop）**：

```
execute(tool_name, args):
1. 路径解析: resolveWorkspacePath(workspace_dir, path)——拒绝绝对路径与 ..
2. [分支] 按工具类别校验
   2.1 [条件(读侧: read/listdir/exists/search_file)] validateReadAccess 三级链
   2.2 [条件(写侧: write/create/append/edit_file/makedirs/move/remove 七件)] 逐路径校验（move 的
       from/to 两个路径都过本校验）: work_zone 内→放行;work_zone 外→按 write_scope 分派——
       'workspace'（commit 语境）: realpath 限 workspace 内 + 禁 .hopstate/;
       'work_zone'（act/check 语境,缺省档——信号缺席按窄域拒,禁静默放宽）: 拒 WORK_ZONE_ONLY
   2.3 [条件(纯函数: validate_spec/树编辑四件(insert_node/replace_node/replace_children/
       renumber_steps)/read_spec_tree 共六件)] 零路径校验——内容进内容出,不触文件系统,
       路径校验链不适用
3. 执行对应 fs 原语（create→'wx' 排他 / move→rename / makedirs→recursive / append→appendFile / edit_file→read+计数+条件写回,详见 ^anc-exec-builtin-edit-file-tool HopSop）
4. [分支] 结果归一
   4.1 [条件(成功)] ToolResult{success: true, result: 内容或确认文本}
   4.2 [条件(其他)] ToolResult{success: false, result: 错误信息}——不抛出,错误经工具结果通道回执行方
```

## edit_file 局部精确替换【契约】 ^anc-exec-builtin-edit-file-tool

**缘起（2026-09-05 作者拍甲案）**：0038b 轮（2026-09-04,run 468463d7）hoplog 逐条定量：hopbuild2 修错步每轮用 write 把 37KB 草稿全文回写——7 轮约 17 万 output tokens、约 20 分钟墙钟，占顶层输出量 58%；铁证是某轮 thinking 自述"三处微编辑，把全文写回"，另一轮用 create+8 次 append+move 分块重建全文。"禁止整篇重写"教学禁令（[[../hopbuild2]] D68）管住了内容（确实只做定向改动）没管住传输（改 3 处也要整文件吐一遍）——**根因是工具面缺口：文件工具组只有 write（整文件覆盖）与 append，没有局部替换原语**。作者呈报甲（补工具）/乙（只改 spec 引导）两案后拍"甲，而且是不是可以在指定节点禁止 write tool?"——工具与禁用半边（[[../step-dispatcher]] ^anc-step-tool-deny 消费面）同批落地。

**能力契约（HopSpec 契约）**：

```
# Spec: edit_file 局部精确替换
Id: builtin_edit_file
Goal: 对沙箱内文件做一处精确子串替换——改哪几行只传哪几行,消灭"小改动整文件重写"的输出浪费
Constraints:
- 精确子串匹配,恰一处才替换：old_text 在文件中匹配 0 次 → 报错"未找到匹配"并回显 old_text 头 80 字符;匹配 ≥2 次 → 报错"匹配 N 处,请提供更长的唯一上下文";恰 1 次 → 替换写回。宁拒不猜——两种失败都是可修复的定向反馈,调用方补上下文重试即可
- old_text 禁空串（空串匹配无意义,报错）;new_text 可为空串（= 删除 old_text 那一段）
- **插入用包含式表达**（2026-09-05 作者问"这个设计无法插入或删除啊"后补明——删除有 schema 明文,插入的惯用法原四处教学面全缺,执行 LLM 撞到"补一句"工单会不知所措）：old_text 取插入点的锚文本,new_text = 锚文本 + 新内容（如在某句后插一行:old_text="那一句。" new_text="那一句。\n新的一行。"）——两参代数与 Claude Code 自家 Edit 工具同形,替换/删除/插入三种编辑全靠这一个原语,不另开 insert 参数（参数面窄=误用面窄;整步骤级的结构性插入另有 insert_node 归树编辑族）
- requires_commit=false（write 同档——edit_file 是 write 的窄化形态,能力只小不大,权限不升）;category='basic'（文件读写族恒 basic,0054 口径）
- 写侧路径闸与 write 完全同链（resolvePath → validateFileAccess('write', write_scope)——act/check 限 work_zone,commit 限 workspace,禁 .hopstate/,work_zone 绝对路径豁免,全部沿用 ^anc-exec-write-scope 零新分支）
- 目标文件不存在 → 报错不静默（编辑语义预设文件在场,与 write 的"新建或覆盖"语义有意不同）
```

**类型约定（HopType）**：

- `path: string`（必填）——待编辑文件路径,workspace 相对（work_zone 绝对路径豁免同 write）
- `old_text: string`（必填,禁空串）——要被替换的原文子串,须在文件中唯一;装的是文件内容的字面片段,不是正则
- `new_text: string`（必填,可空串）——替换后的新文本;空串=删除
- 返回：替换确认一句话,含替换处的字符偏移(UTF-16 码元——JS 字符串 indexOf 的天然单位,中文内容下≠字节数;用途是调用方自证进度,单位如实标注)（如 `Replaced 1 occurrence at char 1234 in <path>`）

**关键逻辑（HopSop）**：

```
executeEditFile(path, old_text, new_text, write_scope):
1. old_text 空串 → 报错"old_text 不可为空"
2. resolvePath → validateFileAccess('write', write_scope)（与 executeWrite 同链同序）
3. 文件不存在 → 报错"文件不存在:<path>"
4. readFileSync → 以 old_text 切分计数 n = split(old_text).length - 1
5. [分支] 按 n 三态
   5.1 [条件(n == 0)] 报错"未找到匹配（old_text 头 80 字符:...）"
   5.2 [条件(n >= 2)] 报错"匹配 N 处,请提供更长的唯一上下文"
   5.3 [条件(n == 1)] 替换写回 writeFileSync,回执含字符偏移
6. 全部失败经 ToolResult{success:false} 通道回执行方,不抛出（与本组其余工具同形）
```

**消费侧接线（同批）**：hopbuild2 修错步 5.1.3.1.2 挂 `- 禁工具: write` `- 禁工具: append`（禁用行,[[../step-dispatcher]] ^anc-step-tool-deny）强制定向文本改动走本工具;结构性改动（整步骤增删换）仍走 [[spec-tree-tools]] 树编辑四件——两族分工:文本层局部改动归 edit_file,步骤树结构改动归树编辑。

## search_file 单文件搜索与 read 行号段【契约】 ^anc-exec-builtin-search-file

**缘起（2026-09-05 作者问"是否要提供 rg 或类似 tool"后拍"rg 类工具两件立todo",todo/0070）**：D81 供给瘦身教了"按工单定向读盘",但读侧工具面只有整文件 read——0039 轮实测三处打折：①"按工单 L 行号读 source.md 对应段"实际只能整读 35KB 再自己找（实账:单块 16,154 output tokens 的"定向读原文"就是整读形态）;②"按关键词定位"同样整读后人肉扫;③edit_file 动手前无工具自证 old_text 唯一性,只能靠报错重试（零/多匹配报错带计数是兜底不是正路）。两件落地后 D81 的定向读盘正路才足额兑现。

**能力契约（HopSpec 契约）**：

```
# Spec: search_file 单文件搜索与 read 行号段
Id: builtin_search_and_ranged_read
Goal: 按关键词在单文件内定位（返回行号+行内容）,按行号段取文件片段——定向读盘取代整读,读几行只传几行
Constraints:
- search_file 纯子串匹配,不开正则（宁窄勿宽,与 edit_file"宁拒不猜"同哲学——正则的转义与方言歧义面大,LLM 写错正则静默漏配比子串匹配不到更难排查;真有正则需求另议再扩）
- search_file 零命中返回空清单不报错（探测语义,与 exists"不存在返回 false 不报错"同款）;pattern 禁空串（空串匹配无意义,报错——与 edit_file old_text 禁空串同哲学）
- read 两个行号参数均缺席时行为与扩参前逐字节一致（存量零回归——input_schema 可选参数,老调用零感知）
- 行号 1 起,与 D76 编号版 L1..Ln 同口径（source.md 第 N 行=编号版 L N 一一对应零偏移——[[../hopbuild2]] D81 已写死的行号对应事实直接消费）
- 越界处置两态：start_line 超文件总行数 → 报错带总行数（宁拒不猜——调用方拿总行数即知边界）;end_line 超总行数 → 截到文件尾不报错（读到尾是自然语义）;start_line > end_line → 报错（无效区间宁拒）
- 读侧路径权限走 read 同款三级链（denied → confirm_required → allowed）,零新分支
- 不做跨文件目录级搜索（rg 的目录递归形态）——修错步的定位需求恒是单文件;跨文件是另一个能力档,没有实需不开,开了反而给执行 LLM 逛盘自由度（dr19 实撞:工具环逛 .hoplog 读巨型 main.yaml 灌爆上下文——读侧自由度宜窄）
- 两件均 requires_commit=false、category='basic'（文件读写族恒 basic,0054 口径——零声明恒可用）
```

**类型约定（HopType）**：

- `search_file(path, pattern, context_lines?)`：
  - `path: string`（必填）——待搜索文件路径,workspace 相对（work_zone 绝对路径豁免同 read）
  - `pattern: string`（必填,禁空串）——搜索子串,字面匹配不解释正则
  - `context_lines: integer`（可选,缺省 0）——每处命中附带上下各 N 行上下文
  - 返回：命中清单 JSON 文本 `[{line, text}]`（line=1 起行号,text=该行原文;context_lines>0 时成员另带 `context` 字段装上下文行拼接文本）——JSON 文本形态与 listdir/exists 同款,消费侧 parse_json 取用（parse_json 已幂等,复用模式回传链提前解析也安全）;零命中=`[]`
- `read(path, start_line?, end_line?)`：
  - `start_line: integer`（可选,1 起）——起始行号,缺省 1;超总行数报错带总行数
  - `end_line: integer`（可选,1 起,含端）——结束行号,缺省文件尾;超总行数截尾
  - 返回：该行号段文本（两参均缺=全文,与扩参前逐字节一致）

**关键逻辑（HopSop）**：

```
executeSearchFile(path, pattern, context_lines):
1. pattern 空串 → 报错"pattern 不可为空"
2. resolvePath → validateFileAccess('read')（与 read 同链同序）
3. readFileSync → 按行 split,逐行 indexOf(pattern) 子串判
4. [分支] 按命中数
   4.1 [条件(零命中)] 返回 '[]'（success:true——探测语义,不是失败）
   4.2 [条件(有命中)] 组 [{line, text}(, context)] JSON 返回,content_type json

executeRead(path, start_line?, end_line?):
1. resolvePath → validateFileAccess('read')（既有链不动）
2. [分支] 两行号参数均缺席 → 全文返回（存量路径,扩参前逐字节同）
3. [分支] 带行号参数
   3.1 start_line > 总行数 → 报错"start_line N 超出文件总行数 M"
   3.2 start_line > end_line → 报错"无效区间"
   3.3 其余 → 取 [start_line, min(end_line, 总行数)] 段（含两端）join 返回
4. 全部失败经 ToolResult{success:false} 通道回执行方,不抛出（与本组其余工具同形）
```

**消费侧接线（同批）**：hopbuild2 修错步 5.1.3.1.2 定向读盘正路升级——工单带 L 行号时 `read(path, start_line, end_line)` 直取那一段（原教法"read 整文件按物理行号自己找"退位）;工单只有关键词时 `search_file` 定位行号再按段读;edit_file 动手前可先 `search_file` 自证 old_text 唯一性（命中数一目了然,一次调用替代报错重试）。三个消费点全部是 D81 定向读盘的足额兑现形态。
