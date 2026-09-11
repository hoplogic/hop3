%% @trace
	id: hopjit-obsidian-plugin
	source: [[../concepts/HopSpec V3核心规范]]
	source_id: hopspec-v3-core
	type: extend
	last_sync: 2026-08-16T23:57+0800
	note: HopSpec 可视化 Obsidian 插件设计（作者拍板方案 C,Obsidian 优先）——markdown 6 级标题上限之上的步骤折叠/大纲/落点高亮,按步骤编号识别与表面形态解耦。
%%

# HopSpec 可视化 Obsidian 插件设计

> **模块版本**：obsidian-plugin `v0.6.0`（2026-08-16）。0.x 未承诺稳定。**逐版演进史归 git log**（本行只记现行版本,升版只改号,演进论证归 commit message）。
## 文档结构与内容分级

| 分级 | 含义 |
|---|---|
| 【决策】 | 人拍板的关键选择 |
| 【契约】 | 带 `^anc-*` 锚点的技术约定 |
| 【说明】 | 示例与解释 |

| 章节 | 分级 | 锚点 |
|---|---|---|
| 定位 | 契约 | `anc-viz-obsidian-plugin` |
| 步骤行识别器 | 契约 | `anc-viz-step-recognizer` |
| 折叠域 | 契约 | `anc-viz-obsidian-fold` |
| 大纲视图 | 契约 | `anc-viz-outline` |
| 落点高亮 | 契约 | `anc-viz-mark-highlight` |
| 阅读视图支持 | 契约 | `anc-viz-reading-view` |
| 分发布局 | 契约 | `anc-viz-plugin-layout` |

## 定位【契约】 ^anc-viz-obsidian-plugin

**① 自身定位**：Obsidian 插件（TypeScript，目录 `editors/obsidian/`）——为 HopSpec 文件提供**与表面形态解耦**的可视化：任意深度折叠、步骤大纲、纪律落点高亮。存在理由：markdown 规范标题止于 6 级，`#######` 起编辑器不再识别为标题——深层步骤（hopbuild 自身 8 级）失去折叠与大纲；插件按**步骤编号**识别层级，标题风/缩进风/7 级+全部一视同仁。

**② 与引擎的关系**：**零依赖**——插件不 import `@hoplogic/hopjit`（Obsidian 插件是独立分发件，捆引擎包=版本锁死+体积暴涨）；步骤行识别器按概念层表面文法**独立实现**（正则级，见下节），以概念层语法参考为共同权威。识别器与引擎 parser 的一致性由测试对齐（同一组样例两边跑），不由代码共享保证——文法演进时两处同步改，语法参考是仲裁。

**③ 激活条件**：文件含 `# Spec:` 头（引擎同判据）才启用三能力——普通 markdown 文件零打扰。

**④ 边界（不做）**：不做 validate 诊断（须引擎逻辑，违零依赖——留给将来 LSP 形态统一供 VS Code/Obsidian）；不做编辑辅助/补全；不做执行发起。

## 步骤行识别器【契约】 ^anc-viz-step-recognizer

三能力共用的唯一识别层。**行匹配**（与引擎 RE_STEP 同语义的正则子集）：

```
行 = 可选前缀 + 步骤编号 + '. [' + 类型词 + 可选属性 + ']' + 摘要
可选前缀 = '#'{1,∞} + 空格（标题风,7+ 个 # 也认——正是本插件存在的理由） | 空白缩进（缩进风）
步骤编号 = \d+(\.\d+)*
类型词 = [\w一-鿿]+（双语——与引擎 STEP_TYPE_ALIASES 同面,插件不验类型合法性只认形状）
```

- **层级 = 编号段数**（`5.3.3.1` = 4 层），与 `#` 个数、缩进量无关——这就是"与表面形态解耦"的实现；
- **围栏内不识别**（``` 块内的步骤形状文本是示例不是步骤——状态机跟踪围栏开合，引擎 identifySections 同规则）；
- 识别器纯函数：`recognizeSteps(lines) → {lineNo, stepId, depth, stepType, summary, marks}[]`，marks = 行尾四类落点标记（`→ traverse|verify|commit|hitl`，供高亮）。

## 折叠域【契约】 ^anc-viz-obsidian-fold

CM6 `foldService` 注册：步骤行的折叠域 = 该行行尾 → 下一个**编号非其后代**的步骤行之前（后代判定=编号前缀，`5.3.1` 是 `5.3` 后代非 `5.4` 的）。节点体行（`- ←`/`+ →`/`>`/说明段/围栏 body）随属主步骤折叠。Spec 头部区（Goal/Constraints/…）按既有 markdown 标题折叠不接管——插件只管标题机制够不着的步骤树。

## 大纲视图【契约】 ^anc-viz-outline

右侧栏视图（`ItemView`）：步骤树全层级渲染——每项 `编号 [类型] 摘要`，落点标记项带色点；点击跳转对应行；随文件切换/编辑刷新（编辑防抖 ~300ms）。深度不限——7 级+步骤与 1 级同等在场，这是 Obsidian 原生 outline 给不了的。

## 落点高亮【契约】 ^anc-viz-mark-highlight

CM6 装饰（`ViewPlugin` + `Decoration.mark`）：行尾 `→ traverse`/`→ verify`/`→ commit`/`→ hitl` 四标记着色（遍历=蓝/核验=绿/提交=橙/研判=紫——commit 用警示暖色:不可逆落点一眼可辨）。同色点复用于大纲项。**语法元素分族上色**（v0.5.0 扩）：步骤类型词五语义族——动脑（reason）蓝紫/动手可逆（act）青/把关族（check/confirm/ask）绿与 verify 落点同系/不可逆（commit）警示橙与落点同色/结构流控（subtask/loop/branch/case/call/break/continue/exit）灰蓝，双语词同族同色；数据流行前缀 `- ←` 青（入）/`+ →` 蓝紫（出）；头部关键字（Goal:/Constraints:/Inputs:/Outputs:/Types:/Id: 双语）洋红加粗——契约区一眼可辨；类型位（声明行 `name: type` 的 type 段）暗金——类型是接口承诺,与说明绿区分,按位置着色（Types 自定义类型词汇开放,词表白名单必漏）,限定声明上下文防普通列表误着；行内 `#` 说明**独立着色不淡化**（作者纠 v0.5.1——`#` 说明是写给后继执行 LLM 的接口文档、语义面契约要件『新定义变量的说明必选』,不是可有可无的注释;淡化斜体=把承重件当装饰,视觉语言撒谎）。颜色全部经 CSS 变量暴露（用户主题可覆盖）。

## 阅读视图支持【契约】 ^anc-viz-reading-view

编辑视图三能力归 CM6 扩展（含 **7+ 级井号前缀隐藏**——Live Preview 惯例:光标不在该行时 Decoration.replace 隐藏字面 `#######`,光标进入即显示可编辑性不丢;真机实撞:7+ 级不是 markdown 标题,渲染器不吃井号编辑视图照露）；**阅读视图走 markdown post-processor 管线**（另一条渲染路径，CM6 扩展不生效——真机首用实撞：7+ 级步骤在阅读视图渲染为字面 `#######` 段落+节点体圆点列表）。post-processor 把字面井号段落重塑为分级步骤行：隐藏井号前缀、按深度（编号段数）缩进、类型词与落点标记着色（同一 MARK_CLASS 色系）。大纲跳转在阅读视图同样工作（openFile eState.line 视图中立）。折叠不做进阅读视图（阅读视图无行折叠 UI 位——编辑视图专属能力，如实边界）。

## 分发布局【契约】 ^anc-viz-plugin-layout

`editors/obsidian/` 目录：`manifest.json` + `main.ts` + `styles.css` + 独立 `package.json`/`esbuild` 构建（Obsidian 插件生态标准形态；不入引擎包 workspace——发布通道不同:引擎走 npm,插件走 Obsidian 社区插件目录/手动安装）。安装/卸载做进命令（作者定——手工拷贝/删目录=易错手工活）：`npm run install-vault -- <vault路径>`（build+三件拷入 `<vault>/.obsidian/plugins/hopspec/`）/`npm run uninstall-vault -- <vault路径>`（只删本插件目录——受管边界,vault 其余零触碰）;路径可经 `HOPSPEC_VAULT` 环境变量;非 vault 目标（无 .obsidian/）拒。识别器单测随目录自带，`npm test` 于该目录内跑——不并入根 vitest（依赖面隔离,根面 vitest.config 测试与覆盖率分母双排 editors/**——插件源留在覆盖率分母=以 0% 计入拉低引擎覆盖基线,0.4.0 发版闸实撞）。
