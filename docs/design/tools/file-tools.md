%% @trace
	id: hopjit-tools-file
	source: [[../tools]]
	source_id: hopjit-tools
	type: extract
	last_sync: 2026-09-30T00:59+0800
	note: 内置文件/目录工具组模块设计——2026-08-31 自 tools.md 拆出（作者定"设计文档应该有归口""docs/design 下有一个 tools/ 子目录,里面放各个 tool 模块"）。锚点原名随迁不改（^anc-exec-builtin-file-tools / ^anc-exec-write-scope 全库引用面零波动靠的是名不变、目标文件名全量随改）。装配层本体与出口边界仍归 [[../tools]]。
%%

# 内置文件/目录工具组

> **模块版本**：随 tools 模块（[[../tools]] v0.23.0 work_zone 豁免读写分权——写只认当前实例、读对实例树开放;v0.22.0 work_zone 豁免只认本 run 自己的涂鸦区集合,见 ^anc-exec-work-zone-registry;v0.21.0 路径解析认 workspace 内绝对路径+目录边界判定补分隔符与祖先软链解析,见 ^anc-exec-tool-path-resolve;v0.20.3 edit_file 返回说明改正为字符偏移、零匹配报错结构与最接近行算法写全;v0.20.2 edit_file 零匹配报错附最接近行;更早 v0.17.1,2026-09-07 条目类型字段正名批——listdir/exists 返回加 type 正名字段（行业惯例）,kind 留作同值兼容别名（作者拍乙案,承诺非过渡）。上一扩员=v0.16.0 search_file+read 行号段。本文件是 tools 模块的组成部分,不独立计版——契约变更升 tools 模块版本号。

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
- 写侧（write/create/append/edit_file/makedirs/move/remove）按步骤权限分域（概念 ^anc-step-act-body-lang 工具组条款,作者定 2026-08-28）：**act/check 限 work_zone**（探索段写的都是中间产物,越界即拒 WORK_ZONE_ONLY,free 与否无关——free 不放大权限）；**commit 限 workspace**（持久写盘=交付动作）+ 禁 .hopstate/（引擎状态区,work_zone 是该禁令唯一豁免——判定=路径落在**本次运行自己的涂鸦区集合**内（权威 [[#^anc-exec-work-zone-registry]],2026-09-30 todo/0124 起;work_zone_path() 产物天然在集合内）。演进史：2026-08-30 语义审计实抓正则只吃一段致 standalone 子实例写自身 work_zone 被误拒,当时修为".hopstate 内任意深度以 work_zone 结尾的段";2026-09-03 hopissues/0066 实撞 `--state-dir` 名不含 `.hopstate` 字面〔hopkb 的 `runtime/hopstate`〕时字面判全不中、引擎一手发路径一手拒路径,当时加了注册根前缀第三支、字面两支保留;2026-09-30 todo/0124 阅卷实证字面两支让 workspace 外任何含惯例名的路径都能读写、模块级注册表让同进程别的 run 互相可读写,三支整体退役,改为提供者按 run 持有集合。"接受任意 --state-dir"的既有承诺不变（0066 时否掉的"强制命名 .hopstate"仍不取）——集合判定不看目录名,自定义 state-dir 天然合法） ^anc-exec-write-scope
- 写域信号=既有 allowCommit 通道（execute 的 write_scope 参数由调用方按步骤类别传入:allowCommit=true→workspace,false→work_zone;缺省 work_zone——信号缺席按窄域拒,不静默放宽）——不新增步骤类别感知,分域与 requires_commit 同一根开关
- 读侧（read/listdir/exists/search_file）走三级读权限链（denied → confirm_required → workspace/allowed）
- 路径入参三种合法形态（2026-09-30 hopissues/0112 改,原条款是"一律 workspace 相对、禁绝对路径"）：① workspace 相对路径;② **落在 workspace 内的绝对路径**——按去掉 workspace 前缀后的相对路径处理,与相对写法落同一处、过同一条读写校验链;③ 本 run 涂鸦区内的绝对路径（提供者按 run 持有的 work_zone 根集合命中,[[#^anc-exec-work-zone-registry]]——work_zone_path() 产物就是绝对形态,且 work_zone 可以在 workspace 外）。workspace 外的其余绝对路径拒,报文点名"在 workspace 外"并带出 workspace 根;含 `..` 一律拒。解析与"是否落在目录内"的判定细则见 [[#^anc-exec-tool-path-resolve]]
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
| `edit_file`        | `path, old_text, new_text`                                       | 替换确认（含替换处字符偏移）                                | **局部精确替换**——old_text 恰匹配一处才替换;多匹配报错带计数,零匹配报错附最接近行（见 ^anc-exec-builtin-edit-file-tool） |
| `makedirs`         | `path`                                                           | 创建确认                                                  | 含中间层（recursive）；已存在即成功（幂等）                                         |
| `move`             | `from, to`                                                       | 移动确认                                                  | 源与目标都限 workspace 内                                                 |
| `remove`           | `path`                                                           | 删除确认                                                  | 仅文件（目录不删——最重操作不进 v1）；不存在即失败                                        |

**条目类型字段正名 type、kind 留作兼容（2026-09-07 作者拍"乙,kind 留作兼容"）**：listdir 条目与 exists 返回的"文件还是目录"字段,正名为 `type`——跨生态主流用词是 type/file_type（VS Code FileType/LSP type/Go DirEntry.Type/Rust file_type）,原 `kind` 属少数派命名,执行 LLM 按行业直觉写 `e.type` 必踩缺键坑。
R9 实撞:demo-rename 步 1 过滤器 e.type 缺键恒假,文件清单恒空,真机产出必坏而 validate 全绿——deep-validate 抓获。

两字段同值并存:文档与教学只教 `type`,`kind` 不再出现在示例里但引擎照发（存量 spec 消费 kind 的零破坏,不设移除时间表——兼容别名是承诺不是过渡）。

> spec 内容族六件（validate_spec/树编辑四件/read_spec_tree）**不属本组**——同住 `DefaultToolProvider` 承载（HopSop 的纯函数分支路由它们）,但入参/返回/语义契约**全部归 [[spec-tree-tools]]**,本文不复表（双表=双权威漂移面——2026-08-31 作者抓归类错误后收口:一件工具的契约恒只在一份文档）。

**关键逻辑（HopSop）**：

```
execute(tool_name, args):
1. 路径解析: resolvePath(path)——三种合法形态换算成宿主机绝对路径,workspace 外的绝对路径与含 .. 的路径拒（细则 ^anc-exec-tool-path-resolve HopSop）
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

## 路径解析与目录边界判定【契约】 ^anc-exec-tool-path-resolve

2026-09-30 hopissues/0112 立。**来由**：翻译产物的 commit 步用 `split(<用户给的绝对路径>)` 派生落盘路径,文件工具一律拒绝绝对路径,交付物写不下去（真机实撞,R6 读侧同病:用户给的知识库根是绝对路径）。概念层只要求文件工具"限沙箱 workspace 内"（[[../../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]]）,从未要求"必须写成相对形态"——"禁绝对路径"是设计层自加的形态禁令,拦下的恰是"在 workspace 内、只是写成绝对形态"的合法目标。改后的判据只问**落点在不在 workspace 内**,不问写法。

同批修两处既有逃逸（改前 probe 实证,都是代码没做到 sandbox 设计"symlink 逃逸 → reject"的既有要求 [[../sandbox#^anc-config-sandbox-filesystem]]）：

- **前缀判定缺路径分隔符边界**：`realPath.startsWith(wsDir)` 把 workspace `/x/proj` 的兄弟目录 `/x/proj2` 也当成"在内"。实证:workspace 里放一条指向 `/x/proj2` 的软链,commit 步即可覆盖 proj2 下的已有文件、读侧也能读到;
- **新建文件不解析父目录软链**：目标文件不存在时 realpath 失败,旧实现退回未解析路径,于是"经软链父目录新建文件"逃出 workspace。实证:workspace 里 `lfar → /x/other`,写 `lfar/new.txt` 成功落到 /x/other 下（写已有文件则被正确拒绝——两种情况结论不一致正是缺陷形态）。

```
contract: ToolPathResolve
  Id: tool-path-resolve
  Goal: 把文件工具的 path 入参换算成宿主机绝对路径,并判定落点是否在某个目录内——供读写校验链使用
  Constraints:
  - 三种合法入参形态：workspace 相对路径 / 落在 workspace 内的绝对路径 / 本 run 涂鸦区内的绝对路径（work_zone 分支在 DefaultToolProvider.resolvePath 先判——判据见 [[#^anc-exec-work-zone-registry]],本契约管其余两种）
  - 含 `..` 的路径一律拒（相对与绝对形态同拒——穿越判定不做语义化简,宁拒不猜）
  - "落在 workspace 内"两路任一命中即算：字面判（规范化后的路径在 workspace 根之下）或真实路径判（两边都取真实路径后在其下——macOS 上 /tmp 是 /private/tmp 的软链,用户给字面 /tmp/… 而 workspace 根已取真实路径时,字面判不中、真实路径判中）
  - 解析阶段只管形态与落区,不替代校验链：解析返回的路径照走 validateFileAccess / validateReadAccess 的真实路径校验（软链逃逸在那里拦——绝对写法与相对写法过同一条链,结论必须一致）
  - "p 在目录 root 内"的判定恒带路径分隔符边界：p 等于 root,或 p 以"root + 分隔符"开头;root 本身以分隔符结尾（文件系统根）时不再补。workspace 写域判定、workspace 读域判定、read allowed 清单判定三个使用点全部走这一个判定
  - 校验链取目标的真实路径时,目标不存在也要解析到底：取离它最近的已存在祖先的真实路径再拼回剩余段;末段是悬空软链时顺着链接目标继续解析（悬空软链写入会在链接目标处建文件,不解析就是逃逸）,**相对形态的链接目标以软链所在目录的真实路径为基准拼接**——操作系统就是这么解析的;以字面父目录为基准,经别名目录访问的悬空软链会被算到错误位置而放行（独立阅卷实证:`deep/er/a → workspace 根` 的别名下写 `deep/er/a/d`,`d → ../外部文件`,字面基准判在内,实际写到 workspace 外）
  - 解析失败即拒（fail-closed）：只有"跟随一次软链"计入跳数,上溯祖先不计（上溯到文件系统根自然终止,不需要计数）;跳数超过上限（40,与 Linux 内核 MAXSYMLINKS 同值）即抛错"软链层数超限或成环",不返回任何路径。独立阅卷实证过旧形态的两个缝:上溯也计数导致 41 层新目录耗尽计数、截断返回的未解析路径字面在 workspace 内被放行,makedirs 经软链父目录在外部建出目录
  - 拒绝报文分清两种情况：workspace 外的绝对路径报"绝对路径在 workspace 外",并带出 workspace 根与"相对写法或 workspace 内的绝对写法均可"的指路;含 .. 报穿越
```

**类型约定（HopType）**：

- `resolveWorkspacePath(workspaceDir: string, filePath: string): string`——workspaceDir 装 workspace 根的**路径**（DefaultToolProvider 传已取真实路径的根;doc-ref 传引擎持有的原始根,两种都要正确工作——真实路径判那一路就是为此设的）;filePath 装工具入参的原样路径文本;返回宿主机绝对路径（相对形态=按 workspace 根拼接;绝对形态=规范化后的原路径,**不改写成真实路径**——真实路径换算归校验链,保持解析与校验分工）;不合法抛 Error（消费方 execute 转成 ToolResult 失败,doc-ref 转成 DocRefError/P15 报文）;
- `isWithinDir(p: string, root: string): boolean`——两参都装绝对路径,调用方负责先把两边统一成同一形态（都取真实路径或都取字面）;模块出口（2026-09-30 起,mcp-server run_approved_command 复用,登 [[../tools]] 出口表）;
- `resolveRealDeep(p: string, hops = 0): string`——p 装绝对路径,hops 装已跟随的软链跳数（外部调用不传）;返回真实路径,目标不存在时按上面的规则解析到最近已存在祖先;跳数超限抛 Error;模块出口（2026-09-30 起,同上）,用于"目标路径"的真实路径换算（校验链三个使用点 + resolveWorkspacePath 真实路径判那一路）,配置项里的模式与清单根仍用原 resolveReal（它们可能是相对的 glob 片段,不适用祖先解析）。

**关键逻辑（HopSop）**：

```
resolveWorkspacePath(workspaceDir, filePath):
1. [条件(filePath 含 ..)] 抛"Path traversal (..) is forbidden"
2. [分支] 按形态
   2.1 [条件(相对路径)] 返回 resolve(workspaceDir, filePath)
   2.2 [条件(绝对路径)]
       p = normalize(filePath)
       [条件(isWithinDir(p, workspaceDir) 或 isWithinDir(resolveRealDeep(p), resolveReal(workspaceDir)))] 返回 p
       [否则] 抛"绝对路径在 workspace 外: <filePath>（workspace 根: <workspaceDir>）"+ 指路

resolveRealDeep(p, hops=0):
1. [条件(realpath(p) 成功)] 返回它
2. [条件(p 是软链)]
   2.1 [条件(hops >= 40)] 抛"软链层数超限或成环"（失败即拒,不返回未解析形态）
   2.2 返回 resolveRealDeep(resolve(resolveRealDeep(dirname(p), hops), readlink(p)), hops+1)
       ——链接目标以软链所在目录的真实路径为基准
3. [条件(p 已是文件系统根)] 返回 p
4. 返回 join(resolveRealDeep(dirname(p), hops), basename(p))——上溯祖先不计跳数

校验链三个使用点（写域 workspace 判定 / 读域 workspace 判定 / 读 allowed 清单判定）:
  realPath = resolveRealDeep(解析后的路径);判"在内"一律 isWithinDir(realPath, 已取真实路径的根)
```

**消费侧**：DefaultToolProvider.resolvePath（文件组十一件 + run_script 脚本路径）、doc-ref resolveDocFile 的 workspace 一级（[[../doc-ref#^anc-exec-doc-ref-resolve]]——字面绝对路径 doc-ref 同受本规则:workspace 内认、外拒;spec 目录一级仍只吃相对形态）、readSandboxedFile。静态侧 B10 不随之放宽（[[../spec-parser#^anc-rule-b10]]——规约里的字面绝对路径把某台机器的目录布局写死,换机即失效,理由由"运行时必拒"改为"不可移植"）。

**暂不做的一项：路径语义变量名的静态 warn**（hopissues/0112 期望行为第 3 项,卡上标"可选"）。提案是 validate 对"文件工具 path 实参是变量、且变量名像路径（`*_target`/`*_path`/`*dir`）"的形态发 warn,把运行期死点前移到构建期。本批次不做,理由：

- 这个 warn 要前移的死点已经被主修消掉了——0112 的死点是"变量装的是 workspace 内的绝对路径,运行时被一律拒";本条款改后这类路径直接认,变量路径不管装相对还是 workspace 内绝对形态都合法,warn 没有真缺陷可指;
- 剩下的真问题只有"变量装的是 workspace 外的路径",而这个静态判不出来（变量值运行期才有）;运行时拒绝报文已经点名"在 workspace 外"并带出 workspace 根,失败是响亮的;语义半边（用户给的路径会不会落在外面）归 deep-validate 判据面五的运行期推演;
- 误报面实测：2026-09-30 对 examples/、skills/、scripts/ 下的 spec 数了一遍,文件工具 path 实参写成这种变量名的有 182 处、分布在 26 份文件里,全部合法——warn 只会是噪声,把 warn 通道的信号淹掉。

**重启条件**：出现"变量路径落在 workspace 外、构建期全绿、真机才撞运行时拒"的实撞,且 deep-validate 在那次构建里没拦住——届时按实撞形态设计判据（按变量来源判,不按变量名猜）,不照搬本提案的变量名形态。

## work_zone 豁免只认本 run 自己的涂鸦区【契约】 ^anc-exec-work-zone-registry

2026-09-30 todo/0124 立（hopissues/0112 修复批次独立阅卷第二、三轮抓出的旧缺口,severity high;方向作者定："为什么不用自己这个任务的注册 work_zone 路径？这个任务就应该直接把 work_zone 目录记下来"）。**来由**：work_zone 是沙箱的豁免区——也是".hopstate 禁写"与"workspace 外绝对路径拒"两条规矩的唯一例外。改造前判"是不是 work_zone"靠三支：字面正则 `.hopstate/<任意段>/work_zone`、字面正则 `hopjit-workzone-*`、模块级全局注册表的根前缀。前两支只看路径写法不问位置,workspace 之外任何路径只要中间含那段写法就能读、写、列目录——不需要软链,一次 `write(path: "/任意外部目录/.hopstate/a/work_zone/x")` 就写到 workspace 外,act 与 commit 两种写域都放行,别的项目的涂鸦区也能读能列（阅卷人在修复前后两份构建上各跑一遍,结果一致）。第三支的注册表是模块级 Set,不按 run 区分,MCP server 一进程多 run 时 A 登记的根 B 也能读写。

前两支当初保留的理由"跨进程场景注册未发生时惯例名仍通"经核不成立：任何文件工具执行之前,同一 engine 的 `getWorkZone()` 必已被调过（body 直执构造解释器时取 workZone;LLM 工具环组 prompt 时取 work_zone;每种 NextResponse 组装都取）,跨进程恢复重建 persistence 后第一次组响应即重新登记。所以判据可以、也应当只问"这条路径落不落在本次运行的涂鸦区里"。

**读写分权（2026-09-30 todo/0126,作者定）**：0124 首版把"本实例+全部祖先"整个当成读写全放行的集合,后代实例能写祖先的涂鸦区——为的是保 hopbuild2 "父生成台账路径、子实例 append" 的形态。作者裁定这是错的："自己只应该在自己的 work_zone 里尝试,不应该去干扰别人,祖先也不应该,否则就乱了. 可以读,但不应该能写";"祖先、兄弟这些都是避免文件的重复 copy,读是可以的,但不能写"。概念层"本实例独占工作区"（[[../../concepts/HopSpec V3核心规范#^anc-step-act-body-lang]]）说的就是写权独占,是对的;错的是设计。于是：**写只认本实例自己的 work_zone;读对本 run 整个实例树开放（祖先、兄弟、后代的涂鸦区都可读——父或兄弟产出的材料直接读,不用一份份拷进自己的 work_zone）;别的 run、别的项目一律不可见。** hopbuild2 的台账通道随之改为"各实例写自己的、父读各子合并"（[[../hopbuild2]] 执行面三约束②）。

```
contract: WorkZoneRegistry
  Id: work-zone-registry
  Goal: 文件工具提供者按 run 持有本次运行的涂鸦区范围,写豁免只对当前实例自己的 work_zone 生效,读豁免对本 run 整个实例树的 work_zone 生效
  Constraints:
  - 范围归 DefaultToolProvider 实例持有。一个 run 的同进程实例树共用同一个 DefaultToolProvider（CompositeToolProvider 构造时建一次;串行 call 子实例直接共享父的组合提供者;parallel 子实例的派生视图对内置文件成员原样复用）,所以"一个 run 一份范围"由对象图保证,不靠任何全局态。模块级正则与模块级注册表全部退役,不留兜底
  - **写豁免=当前实例的 work_zone**（own）。因为 standalone 下父子兄弟共用同一个提供者,"谁在写"不能用集合表达（父根与子根都在集合里就分不清）,只能用时序信号——engine 每次 getWorkZone() 推送时把"当前实例的根"告诉提供者,提供者以它为写根。任何文件工具执行前 getWorkZone() 必已被调过的不变量（下）保证写根随执行实例切换。命中 own 之外的任何 work_zone（祖先、兄弟、后代、别的 run）写侧一律不豁免,回落常规校验链（act/check 拒 WORK_ZONE_ONLY;commit 因 .hopstate 禁写同样拒）
  - **读豁免=本 run 实例树内任意 work_zone**（tree）。判据按目录布局：真实路径落在本 run 顶层实例目录之内、且路径段里有 `work_zone`。顶层实例目录由 persistence 报的祖先链末端取（[[../exec-engine#^anc-exec-work-zone]] 目录不变量:子实例目录恒为 <父实例目录>/parallel|calls/<cid>/,work_zone 恒为实例目录下固定名）。按布局判而不是枚举登记的根,是因为后代在父执行期间动态创建、兄弟在复用模式下不同进程——枚举必然滞后或缺席,布局判零滞后且把祖先/兄弟/后代一网打尽。登记进来的根集合（readableRoots）只作 tree 缺席时（MemoryPersistence 无实例目录布局）的兜底。注意 tree 分支的真正用武之地是 **state-dir 在 workspace 外**（自定义 `--state-dir`）：state-dir 在 workspace 内时,tree 内的 work_zone 本就在 workspace 读链之内,读侧不靠豁免也放行——测试锁 tree 分支必须把 state-dir 放 workspace 外（review 首轮变异存活抓出）
  - 登记路由：persistence 发出 work_zone 根,engine 在 getWorkZone() 里把 persistence 报出的根集合（自身首位、祖先在后）推给它持有的提供者引用（dispatcher 注入的工具清单料源 toolDefsSource,以及复用模式 lazy 自建的 engineToolProvider——两者可空、可同一）：每条根经 registerWorkZoneRoot 进 readableRoots;再经 setWorkZoneScope({ own: 自身根, tree: 顶层实例目录 }) 设当前写根与读树。persistence 不 import tools,tools 不知道 persistence;engine 是唯一同时持有两者引用的对象
  - 登记两形态：原始路径与真实路径都要认（两个消费点各吃一种形态——resolvePath 吃 work_zone_path() 的原始产物,validateFileAccess 吃解析后的真实路径;0066 probe 实证只认一种另一点失配）。own 与 tree 各存两形态;真实路径用 resolveRealDeep 取,解析失败（软链超限/成环）只存原始形态不抛（todo/0125 条目 2）
  - 判定："p 在某根内"用带路径分隔符边界的目录判定（[[#^anc-exec-tool-path-resolve]] 的 isWithinDir）;"路径段里有 work_zone"按分隔符切段后整段全等,`work_zonefake` 不算
  - 两个生效点：resolvePath 对"绝对路径且不含 .. 且命中读范围"的入参原样放行（读写都要先过解析,写的拒落在下一处）;validateFileAccess 读侧命中读范围即跳过读权限链,写侧只在命中 own 时跳过写域闸——只改一处另一处照样放行,是本条款明写的失效形态
  - 登记时机不变量：任何文件工具执行之前,同一 engine 的 getWorkZone() 必已被调过。三条保证路径写在 HopSop 里;新增"不经 getWorkZone 就调文件工具"的执行路径即破坏此不变量,须同批补登记。**已知的例外通道**：`hopjit tool-call`（[[../tool-channels]] 通道⑥,复用模式 caller 直调）自建提供者不经 engine、无 persistence,范围恒空——工具面对它只剩常规校验链;该通道只该调纯函数族
  - 不在范围里的一律不豁免：别的 run 的涂鸦区、别的项目的 .hopstate、workspace 外凑出惯例名的路径、经软链落到外部的路径——全部回落到常规校验链
```

**类型约定（HopType）**：

- `ToolProvider.registerWorkZoneRoot?(root: string): void`——接口可选方法（provider-types,[[../shared-providers#^anc-provider-tool]]）。root 装一条 work_zone 目录的绝对**路径**（原始形态,由提供者自己再取真实路径;绝对性由 persistence 构造方保证——cli/mcp-server 入口对 state-dir 恒 resolve 绝对化）;进读集合兜底。不实现的提供者（外部 MCP 成员、宿主注入件、测试替身）忽略;CompositeToolProvider 转发给所有实现了它的成员;
- `ToolProvider.setWorkZoneScope?(scope: { own: string; tree?: string }): void`——接口可选方法（2026-09-30 todo/0126）。own 装当前实例 work_zone 的绝对路径（写根）;tree 装本 run 顶层实例目录的绝对路径（读树;MemoryPersistence 等无目录布局的形态缺席）。每次 engine.getWorkZone() 都调,后调覆盖先调——写根随当前执行实例切换。Composite 同款转发;
- `DefaultToolProvider.readableRoots: Set<string>` / `ownRoots: Set<string>` / `treeRoots: Set<string>`——实例私有,各存原始与真实两形态;`isReadableWorkZone(p)`=命中 treeRoots 内且含 work_zone 段,或命中 readableRoots;`isOwnWorkZone(p)`=命中 ownRoots;
- `PersistenceProvider.getWorkZoneRoots?(): string[]`——接口可选方法（[[../shared-providers#^anc-provider-persistence-iface]]）。返回本实例 work_zone 加全部祖先实例 work_zone 的绝对路径清单,自身在首位、顶层在末位。FilePersistence 按目录布局上溯（下面 SOP）;MemoryPersistence 返回 [tmpdir 根]。缺席时 engine 只推 getWorkZone() 一条且 tree 缺席——缺席分支为外部 PersistenceProvider 实现预留,两个内置实现恒实现。

**关键逻辑（HopSop）**：

```
engine.getWorkZone():
1. wz = persistence.getWorkZone()（空串=无持久化,直接返回）
2. roots = persistence.getWorkZoneRoots?.() ?? [wz]
3. tree = persistence 有实例目录（FilePersistence,engine.instanceDir 非空）? dirname(roots[roots.length-1]) : undefined
   （顶层实例目录=祖先链末端 work_zone 的父目录;MemoryPersistence 无实例目录 → tree 缺席）
4. 对 [toolDefsSource, engineToolProvider] 里每个非空提供者 pv：
   4.1 对 roots 逐条 pv.registerWorkZoneRoot?.(root)
   4.2 pv.setWorkZoneScope?.({ own: roots[0], tree })
   （每次都推,不缓存——提供者可能在 engine 生命周期中途才接上;own 必须随当前执行实例切换）
5. 返回 wz

FilePersistence.getWorkZoneRoots():
1. roots = [join(instanceDir, 'work_zone')]; dir = instanceDir
2. [循环] 当 basename(dirname(dir)) ∈ {parallel, calls} 且 dirname(dirname(dir)) 下存在 state.json：
     dir = dirname(dirname(dir)); roots.push(join(dir, 'work_zone'))
   （state.json 在场判定防 `--state-dir calls` 这类碰巧同名的顶层目录把上一级误当祖先;到达文件系统根即止——前两条件先截断,数学不可达,代码留防御）
3. 返回 roots

MemoryPersistence.getWorkZoneRoots():
1. 返回 [getWorkZone()]（内存形态无祖先布局,集合就是自己的 tmpdir 根）

DefaultToolProvider.registerWorkZoneRoot(root):
1. [条件(root 空)] 返回
2. readableRoots.add(normalize(root)); [条件(resolveRealDeep(root) 成功)] readableRoots.add(其结果)

DefaultToolProvider.setWorkZoneScope({ own, tree }):
1. ownRoots = {normalize(own), resolveRealDeep(own) 若成功}（整体替换,不累加——写根只有当前一条）
2. treeRoots = tree ? {normalize(tree), resolveRealDeep(tree) 若成功} : ∅

DefaultToolProvider.isOwnWorkZone(p):
1. 对 ownRoots 每个 root：[条件(isWithinDir(p, root))] 返回 true
2. 返回 false

DefaultToolProvider.isReadableWorkZone(p):
1. [条件(isOwnWorkZone(p))] 返回 true
2. 对 treeRoots 每个 root：[条件(isWithinDir(p, root) 且 p 相对 root 的路径按分隔符切段后含整段 work_zone)] 返回 true
3. 对 readableRoots 每个 root：[条件(isWithinDir(p, root))] 返回 true
4. 返回 false

两个生效点:
  resolvePath(filePath): [条件(绝对 且 不含 .. 且 isReadableWorkZone(normalize(filePath)))] 原样返回;否则 resolveWorkspacePath
  validateFileAccess(resolved, op, scope):
    realPath = resolveRealDeep(resolved)
    [条件(op == 'read' 且 isReadableWorkZone(realPath))] 放行
    [条件(op == 'write' 且 isOwnWorkZone(realPath))] 放行
    其余走常规链（写域闸 / workspace 落区 / .hopstate 禁写 / 读权限链）

登记时机的三条保证路径（任一在文件工具执行之前必经）:
  a. body 直执：dispatcher.executeActBody / engine 复用模式消化路径构造 BodyInterpreter 时取 engine.getWorkZone() 作 workZone
  b. LLM 工具环：prompt 组装 assembleFullContext / buildRetryContext / resolveInputs 取 engine.getWorkZone()
  c. 每种 NextResponse 组装（step_ready/paused/completed…）取 engine.getWorkZone()——跨进程恢复后第一次 nextStep 即登记
```

**两模式差异（如实记）**：standalone 下父子兄弟共用一个提供者,own 随当前执行实例切换（串行 call 父子交替、parallel 子实例在 worker 内各自 engine 各自 getWorkZone）;复用模式每实例独立进程独立提供者,own 恒是自己。读侧两模式都按 tree 判,行为一致。写侧 standalone 有一个理论窗口：父 body 执行中若同步调到子实例（不存在这种路径——call 子实例在父步骤完成后才派发）,own 会被子覆盖;当前无此形态,记为不变量而非缺陷。

**消费侧**：DefaultToolProvider.resolvePath 与 validateFileAccess（两个生效点）;engine.getWorkZone（登记路由）;FilePersistence / MemoryPersistence.getWorkZoneRoots（根集合来源）;CompositeToolProvider.registerWorkZoneRoot / setWorkZoneScope（转发）。测试判据经 execute 走完整链,不暴露模块级判定函数。

## edit_file 局部精确替换【契约】 ^anc-exec-builtin-edit-file-tool

**缘起（2026-09-05 作者拍甲案）**：0038b 轮（2026-09-04,run 468463d7）hoplog 逐条定量：hopbuild2 修错步每轮用 write 把 37KB 草稿全文回写——7 轮约 17 万 output tokens、约 20 分钟墙钟，占顶层输出量 58%；铁证是某轮 thinking 自述"三处微编辑，把全文写回"，另一轮用 create+8 次 append+move 分块重建全文。

- "禁止整篇重写"教学禁令（[[../hopbuild2]] D68）管住了内容（确实只做定向改动）没管住传输（改 3 处也要整文件吐一遍）——**根因是工具面缺口：文件工具组只有 write（整文件覆盖）与 append，没有局部替换原语**;
- 作者呈报甲（补工具）/乙（只改 spec 引导）两案后拍"甲，而且是不是可以在指定节点禁止 write tool?"——工具与禁用半边（[[../step-dispatcher]] ^anc-step-tool-deny 消费面）同批落地。

**能力契约（HopSpec 契约）**：

```
# Spec: edit_file 局部精确替换
Id: builtin_edit_file
Goal: 对沙箱内文件做一处精确子串替换——改哪几行只传哪几行,消灭"小改动整文件重写"的输出浪费
Constraints:
- 精确子串匹配,恰一处才替换：old_text 在文件中匹配 0 次 → 报错"未找到匹配"并回显 old_text 头 80 字符（另附最接近行提示,见本块末条）;匹配 ≥2 次 → 报错"匹配 N 处,请提供更长的唯一上下文";恰 1 次 → 替换写回。宁拒不猜——两种失败都是可修复的定向反馈,调用方补上下文重试即可
- old_text 禁空串（空串匹配无意义,报错）;new_text 可为空串（= 删除 old_text 那一段）
- **插入用包含式表达**（2026-09-05 作者问"这个设计无法插入或删除啊"后补明——删除有 schema 明文,插入的惯用法原四处教学面全缺,执行 LLM 撞到"补一句"工单会不知所措）：old_text 取插入点的锚文本,new_text = 锚文本 + 新内容（如在某句后插一行:old_text="那一句。" new_text="那一句。\n新的一行。"）——两参代数与 Claude Code 自家 Edit 工具同形,替换/删除/插入三种编辑全靠这一个原语,不另开 insert 参数（参数面窄=误用面窄;整步骤级的结构性插入另有 insert_node 归树编辑族）
- requires_commit=false（write 同档——edit_file 是 write 的窄化形态,能力只小不大,权限不升）;category='basic'（文件读写族恒 basic,0054 口径）
- 写侧路径闸与 write 完全同链（resolvePath → validateFileAccess('write', write_scope)——act/check 限 work_zone,commit 限 workspace,禁 .hopstate/,work_zone 豁免（本 run 集合判定,^anc-exec-work-zone-registry）,全部沿用 ^anc-exec-write-scope 零新分支）
- 目标文件不存在 → 报错不静默（编辑语义预设文件在场,与 write 的"新建或覆盖"语义有意不同）
- 零匹配报错附最接近行提示：取 old_text 首个非空行,与文件逐行比对,报错里附最多 3 条最接近的文件行（行号 + 该行原文,原文用 JSON 引号包住让行首空格可见）,并说明"old_text 须逐字照抄文件原文"。仍然拒绝、不替调用方改写 old_text——提示只是定向反馈的一部分;一条都够不上相似门槛就不附
```

**零匹配附最接近行（2026-09-29 hb2 qwen-flash 修错步实撞）**：qwen-flash 修错步连续十几轮 edit_file 零匹配,草稿一个字没改。每次 old_text 都是凭记忆写的——草稿里的真实行是 `    2.1.3. [reason] Document mitigation steps`（四个空格缩进）,模型写成 `### 2.1.3 [act] Document mitigation steps`：多加了 `###`、步骤类型记错、行首空格丢了。search_file 已经把原文带行号返回给它,它就是不照抄。原先的报错只回显 old_text 自己的头 80 字符,模型看不出错在哪儿,下一轮换一种错写法再试。报错改为同时给出文件里最接近的那一行原文,模型下一次调用直接照抄即可。

- 相似度口径：两边各自去掉行首的空白与 `#`、去掉 `[...]` 方括号段、空白压成一个空格后比较。规范化后完全相等的行排最前;其余按字符二元组 Dice 系数排序,门槛 0.5——门槛以下的行给了只会误导;
- 为什么只比首行：多行 old_text 的错误几乎都出在第一行（标题行前缀）,首行对上后模型自然会带出后面几行;逐行全比代价高、提示也更乱;
- 为什么不自动纠正：宁拒不猜是本工具的根本约束。自动改用最接近行替换,等于替调用方决定改哪一处——两处相似时会改错地方。

**类型约定（HopType）**：

- `path: string`（必填）——待编辑文件路径,三种合法形态同 write（workspace 相对 / 落在 workspace 内的绝对路径 / work_zone 绝对路径,^anc-exec-tool-path-resolve）
- `old_text: string`（必填,禁空串）——要被替换的原文子串,须在文件中唯一;装的是文件内容的字面片段,不是正则
- `new_text: string`（必填,可空串）——替换后的新文本;空串=删除
- 返回：替换确认一句话,含替换处的字符偏移(UTF-16 码元——JS 字符串 indexOf 的天然单位,中文内容下≠字节数;用途是调用方自证进度,单位如实标注)（如 `Replaced 1 occurrence at char 1234 in <path>`）。工具清单里给模型看的返回说明（ToolDef.returns）必须写同一个单位"字符偏移""at char",不许写成字节
- 零匹配报错（ToolResult.success=false,error 文本）的结构,按先后两段：
  1. 恒在：`未找到匹配（old_text 头 80 字符: <old_text 前 80 字符>）`;
  2. 有最接近行时追加：一句说明"文件里最接近的行（old_text 须逐字照抄原文,含行首空格与 # 号）"，后接至多 3 条候选,每条形如 `第 <行号> 行 "<该行原文>"`——行号从 1 起数,原文用 JSON 字符串形态包住（行首空格、制表符可见）;
  - 候选排序：规范化后与目标相等的行在前,其余按 Dice 系数从高到低;分数相同按行号从小到大;
  - 不附第 2 段的情形：old_text 没有非空行、首个非空行规范化后为空串（如整行只有 `###`）、文件里没有一行达到门槛。空白行不参与比对

**关键逻辑（HopSop）**：

```
executeEditFile(path, old_text, new_text, write_scope):
1. old_text 空串 → 报错"old_text 不可为空"
2. resolvePath → validateFileAccess('write', write_scope)（与 executeWrite 同链同序）
3. 文件不存在 → 报错"文件不存在:<path>"
4. readFileSync → 以 old_text 切分计数 n = split(old_text).length - 1
5. [分支] 按 n 三态
   5.1 [条件(n == 0)] 报错"未找到匹配（old_text 头 80 字符:...）",再按下面算最接近行:
       5.1.1 target = old_text 首个非空行的规范化结果（规范化:去行首空白与 #、去 [...] 段、空白压成一个空格、去首尾空白）
       5.1.2 [分支] target 为空串（old_text 没有非空行,或首行只剩符号）→ 不附,报错到此为止
       5.1.3 对文件每一行:空白行跳过;规范化后等于 target 记 2 分,否则记与 target 的字符二元组 Dice 系数
       5.1.4 留下分数 ≥0.5 的行,按分数降序、同分按行号升序排,取前 3 条
       5.1.5 [分支] 一条都没有 → 不附;有 → 追加"文件里最接近的行（old_text 须逐字照抄原文,含行首空格与 # 号）: 第 N 行 \"<原文>\"…"
   5.2 [条件(n >= 2)] 报错"匹配 N 处,请提供更长的唯一上下文"
   5.3 [条件(n == 1)] 替换写回 writeFileSync,回执含字符偏移
6. 全部失败经 ToolResult{success:false} 通道回执行方,不抛出（与本组其余工具同形）
```

**消费侧接线（同批）**：hopbuild2 修错步 5.1.3.1.2 挂 `- 禁工具: write` `- 禁工具: append`（禁用行,[[../step-dispatcher]] ^anc-step-tool-deny）强制定向文本改动走本工具;结构性改动（整步骤增删换）仍走 [[spec-tree-tools]] 树编辑四件——两族分工:文本层局部改动归 edit_file,步骤树结构改动归树编辑。

## search_file 单文件搜索与 read 行号段【契约】 ^anc-exec-builtin-search-file

**缘起（2026-09-05 作者问"是否要提供 rg 或类似 tool"后拍"rg 类工具两件立todo",todo/0070）**：D81 供给瘦身教了"按工单定向读盘",但读侧工具面只有整文件 read——0039 轮实测三处打折：

- ①"按工单 L 行号读 source.md 对应段"实际只能整读 35KB 再自己找（实账:单块 16,154 output tokens 的"定向读原文"就是整读形态）;
- ②"按关键词定位"同样整读后人肉扫;
- ③edit_file 动手前无工具自证 old_text 唯一性,只能靠报错重试（零/多匹配报错带计数是兜底不是正路）。

两件落地后 D81 的定向读盘正路才足额兑现。

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
  - `path: string`（必填）——待搜索文件路径,三种合法形态同 read（workspace 相对 / 落在 workspace 内的绝对路径 / work_zone 绝对路径,^anc-exec-tool-path-resolve）
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
