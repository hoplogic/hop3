# spec 发现与前置：list / recent-dirs / spec 定位 / params 组装

> **🔴 定位纪律（2026-08-04 晚间收紧：焊死，禁猜）**：`run <spec>` 的 spec 定位是**确定性解析，不是搜索**——与 doc-ref"找不到即响亮失败"同一原则。只认两级：①参数是现成可读路径（绝对或相对 cwd）→ 用；②相对 `<PKG>`（探测到的引擎包根）可读 → 用（引擎自家 examples）。**两级都不中 → 停下问用户要确切路径**（可列 `<PKG>/examples/` 清单供选），**禁止** recent-dirs 猜测、禁止 glob 全库搜、禁止按描述模糊匹配——历史记忆可能指向过时副本（实证：2026-08-04 recent-dirs 把 run 引到已迁移库的旧 vault 副本，还连带加载了旧库的 CLAUDE.md）。recent-dirs 仅服务 `list` 的目录排序，**不参与 run 定位**。定位静默完成，一行结论后进参数确认。

> **Glob 工具失败时**（如 ripgrep 不可用——未装且自动下载失败，多见于无公网环境——报 `ripgrep execution failed`）：不降级 `find /` 或 `find ~` 全库搜（超时且违反禁全库搜）——照两级定位（现成路径 / `<PKG>/examples/`），不中即停问用户。

> hopspec skill 的抽出片段——`list` 的呈现流程、`recent-dirs` LRU（list 与 run 前置共用）、`run` 前的 spec 定位与 params 组装。主体按需引用，不常驻。

## recent-dirs LRU（list 与 run 共用底座）

`.hopspec/recent-dirs.json` = 当前项目下最近用过的 spec 目录 LRU 列表（最多 10 个）。格式：
```json
{ "dirs": ["<最近用的 spec 目录>", "<更早的>", "..."] }
```
- **位置**：`.hopspec/` 在项目根下（相对 cwd，sandbox 默认可写），与 `.hopstate/`（状态）/`.hoplog/`（日志）同族，应一并 `.gitignore`。
- **维护（成功定位/选定目录后）**：把本次目录提到列表最前（已存在则移队首，不存在则插队首），保留最多 10；`.hopspec/` 不存在则 `mkdir -p .hopspec`。
- **按项目隔离**、**不写死任何目录**——首次无文件走全库搜，用过自动进 LRU 下次优先命中，换项目/新 spec 库自适应。

## `list [目录]` — 列出可执行 spec

供用户挑选后 `run`。流程：

1. **确定搜索范围**：
   - 显式给了 `<目录>` → 用它（并记入 recent-dirs）。
   - 否则读 recent-dirs.json：**有记录** → 用这些近期目录（常态，不全库扫）；**空/不存在（首次）** → 用 `question 工具` 问用户（不可用时用普通文本消息问，等用户下条消息回答）：(a) 指定一个 spec 目录（推荐，之后记入 recent-dirs）/ (b) 全库扫一遍（慢）。
2. **对每个范围目录调引擎扫描**：`node <CLI> --json list <目录>` → 返回 `{status,dir,specs:[{file,id,goal}]}`。扫描/parseSpec/判定可执行 spec 全由引擎确定性完成，你不手动 glob/grep。
3. **合并各目录 `specs`**，表格列出 `文件名 [Id] — Goal`，recent-dirs 命中的目录优先排前标「最近」。
4. 提示：`用 run <文件名> 执行`。

> **可执行 spec 判定归引擎**（`hopjit list` 内部，见 [[../design/hop-cli#^anc-cli-list]]）：goal 非空 + steps 非空 + 排除设计文档（`%% @trace` / `design/` 路径 / `## impl`）。你只消费引擎吐的 `specs`。
> **全库扫**（用户选 b）：对全库相关目录分别调 `hopjit list`，或先 `find` 出候选目录再逐个 list。
> 输出只列清单，不展开分析（遵循输出纪律）。

## `run` 前置：spec 定位（确定性，禁猜——见顶部定位纪律）

按序**只做两级解析**，每级是确定性文件存在性检查：
1. 参数按现成路径解析（绝对，或相对 cwd）→ 可读即用。
2. 相对 `<PKG>`（cli-discovery 探测到的包根）解析 → 可读即用。npm 包内随发入门件于 `examples/` 根（data-quality/doc-review+演示数据），仓库路径与包内路径**同形**——`run examples/data-quality.md` 两种环境一次命中；全量范本仍只在仓库。
3. 两级都不中 → **停：报"未找到 <参数>"，列出 `<PKG>/examples/` 下可执行 spec 清单，请用户给确切路径或从清单选**。不搜索、不猜、不用历史记忆。

模糊描述（"跑那个数据质量的"）不属于 run 的输入——引导用户先 `list` 再 run。定位成功后维护 recent-dirs（仅供 list 排序用）。

## `run` 前置：params 组装

- 用户已给 `--params '<json>'` → 直接用。
- **未给或不全** → 读 spec 的 `## Inputs` 段（变量名 + 类型 + `#` 注释），据此：① **注释指到现成数据文件的（如"演示数据在同目录 X"）→ 读该文件为拟用值——演示材料是固定资产，禁止现场编造数据代替**；② 其余从对话上下文推断；③ 推断不出的给合理默认；④ 用 `question 工具` 把组装出的参数提交用户确认（展示每个 Input 名/类型/拟用值，有现成数据文件的默认即选它），确认或修正后再 `run`。**question 工具不可用时（如服务端拒收该工具）用普通文本消息呈现参数表（每个 Input 名/类型/拟用值），等用户下条消息确认或修正后再 `run`**——禁止自己替用户拍板参数。首跑体验以"零决策"为准绳——能一次确认通过就不该让用户做选择题。
- 无 `## Inputs` 段 → 无需 params，直接 run。

> spec/params 前置是 run 的**必要交互**，不属"自主展开"（见主体输出纪律的例外）。
