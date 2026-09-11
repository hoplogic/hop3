# HopSpec Obsidian 插件

HopSpec 可视化：任意深度步骤折叠（markdown 6 级标题上限之上）、步骤大纲、纪律落点四色高亮。含 `# Spec:` 头的文件自动激活，普通 markdown 零打扰。设计权威 `docs/design/obsidian-plugin.md`。

## 安装 / 更新 / 卸载（唯一入口，build 已内含）

```bash
cd editors/obsidian
npm install                            # 首次一次
npm run install-vault -- <vault路径>     # 安装或更新（自动 build + 三件拷入）
npm run uninstall-vault -- <vault路径>   # 卸载（只删本插件目录）
```

- vault 路径可用环境变量 `HOPSPEC_VAULT` 替代；
- 首次安装后需在 Obsidian **设置 → 第三方插件** 启用 HopSpec；
- **更新后需重载插件**（开关关开一次，或重启 Obsidian）——运行中的是加载时的旧构建。

## 三能力（视图归属）

| 能力 | 编辑视图（实时预览/源码） | 阅读视图 |
|---|---|---|
| 任意深度折叠 | ✅ 行号槽折叠箭头（含 7/8 级） | —（阅读视图无行折叠 UI 位） |
| 步骤大纲 | ✅ 右侧栏自动出现，点击跳行 | ✅ 同 |
| 落点高亮 | ✅ 行内四色 | ✅ 重塑步骤行内着色 |
| 7+ 级步骤显示 | 原文形态 | ✅ 字面 `#######` 重塑为分级缩进步骤行 |

落点色：`→ traverse` 蓝 / `→ verify` 绿 / `→ commit` 橙（不可逆警示）/ `→ hitl` 紫——CSS 变量可被主题覆盖。

## 测试

```bash
npm test        # node:test，独立于仓库根 vitest
```
