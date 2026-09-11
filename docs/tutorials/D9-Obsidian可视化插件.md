%% @trace
	id: hopjit-tutorial-dev-obsidian-viz
	source: [[../design/obsidian-plugin]]
	source_id: hopjit-obsidian-plugin
	type: compact
	last_sync: 2026-08-30T15:28+0800
	note: D 系列 8——Obsidian 可视化插件安装与使用：为什么需要（markdown 6 级标题上限截断深层步骤）→ 三步装进 vault → 三能力速览 → 更新/卸载与常见问题。安装命令权威 editors/obsidian/README,设计权威 design/obsidian-plugin
%%

# D9 · Obsidian 可视化插件：让深层 spec 看得清

**给谁**：在 Obsidian 里读写 HopSpec 的开发者——尤其是要读 hopbuild 这类**步骤嵌套到七八级**的 spec 的人。
**权威**：安装命令以 `editors/obsidian/README.md` 为准；设计契约在 `docs/design/obsidian-plugin.md`。本篇是引导版。

## 为什么需要它

markdown 规范的标题只到 6 级——`#######`（7 个井号）起，Obsidian 不再把它当标题：**深层步骤失去折叠和大纲**，一份 8 级嵌套的 spec 展开就是一面墙。

插件按**步骤编号**（`1.2.3.` 的段数）识别层级，与表面形态解耦——标题风、缩进风、7 级以上，一视同仁。且与引擎**零依赖**：它是独立分发件，不 import `@hoplogic/hopjit`，识别器按语法参考独立实现。

**零打扰承诺**：只有含 `# Spec:` 头的文件才激活（与引擎同判据），普通 markdown 文件插件完全沉默。

## 安装：三步进 vault

```bash
cd <hoplogic3仓库根>/editors/obsidian   # 插件源随本库分发,从你 clone 的仓库出发
npm install                          # 首次一次（装构建依赖）
npm run install-vault -- <vault路径>   # 自动 build + 拷入插件三件
```

然后在 Obsidian 里**启用**：设置 → 第三方插件 → 打开 HopSpec。

- vault 路径也可用环境变量 `HOPSPEC_VAULT` 代替命令行参数；
- 装完打开任意一份带 `# Spec:` 头的文件（比如 `examples/` 里随便一份），右侧栏出现步骤大纲即装好了。

## 三能力速览

| 能力 | 编辑视图 | 阅读视图 |
|---|---|---|
| **任意深度折叠** | ✅ 行号槽折叠箭头（含 7/8 级） | —（阅读视图无行折叠 UI 位） |
| **步骤大纲** | ✅ 右侧栏自动出现，点击跳行 | ✅ 同 |
| **落点高亮** | ✅ 行内四色 | ✅ 步骤行重塑着色 |

外加两组着色，读 spec 时最有感：

- **落点四色**：`→ traverse` 蓝 / `→ verify` 绿 / `→ commit` **橙**（不可逆警示——扫一眼就知道哪些步骤碰真实世界）/ `→ hitl` 紫；
- **语法分族**：步骤类型词按语义族着色（动脑蓝紫 / 动手青 / 把关绿 / commit 警示橙 / 结构流控灰蓝，双语同族同色）、数据流前缀（`- ←` 青入 / `+ →` 蓝紫出）、头部关键字与类型位——一份 spec 的"谁动脑、谁动手、哪里不可逆"直接成为视觉结构。

全部颜色是 CSS 变量，你的主题可覆盖。

## 更新与卸载

```bash
npm run install-vault -- <vault路径>     # 更新=重跑安装（自动 build 覆盖）
npm run uninstall-vault -- <vault路径>   # 卸载（只删本插件目录，不碰 vault 其他内容）
```

⚠️ **更新后要重载插件**——运行中的是加载时的旧构建：设置里把 HopSpec 开关关开一次，或重启 Obsidian。

## 常见问题

| 症状 | 处置 |
|---|---|
| 装了没反应 | 先核文件有没有 `# Spec:` 头（激活判据）；再核第三方插件里 HopSpec 已启用 |
| 更新了但行为没变 | 重载插件（关开一次）——见上 |
| 大纲没自动出现 | 打开的是普通 markdown（零打扰是有意的）；HopSpec 文件会自动挂大纲 |
| 想验证插件自身 | `cd editors/obsidian && npm test`（独立 node:test，不依赖仓库根 vitest） |

## 边界（它不做什么）

不做 validate 诊断（那需要引擎逻辑，违零依赖原则——留给将来的 LSP 形态）、不做补全、不做执行发起。**看得清**是它的全部职责；要跑 spec 还是 `/hopspec run`（教程 01）。

## 下一步

- 深层 spec 哪来的：[[D1-用AI做工程-从概念到设计]]（hopbuild 产出的 spec 就是典型深嵌套）；
- 识别器契约与三能力设计：`docs/design/obsidian-plugin.md`；
- 装好后读什么：[[02-读懂一份spec]]（用户系列的读 spec 方法论，配上高亮效果更佳）。
