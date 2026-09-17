%% @trace
	id: hopjit-release-engineering
	source: [[chain-enforcement]]
	source_id: hopjit-chain-enforcement
	type: intent
	last_sync: 2026-09-04T17:45+0800
	note: 发版工程设计——快照制（release 启动冻结 commit，全部检查与发布对着快照 worktree 跑）。G5 检查单（scripts/release.sh）的行为权威；chain-enforcement §8 的 release 闸行是其守卫映射。
%%

# 发版工程——快照制（release snapshot）

**给谁**：改 `scripts/release.sh` 的人（agent 或维护者）。逐次操作归维护者操作手册（内部维护面,不随快照分发,人每次发版照走）；本文是行为权威——脚本怎么改、为什么这么定，冲突以本文为准。

## 文档结构与内容分级

| 分级 | 节 |
|---|---|
| 【决策】 | 为什么要快照制（实撞史与作者对焦） |
| 【契约】 | 快照制五条款（^anc-release-snapshot）/ 发布防线四断言（^anc-release-boundary-guards） |
| 【说明】 | 守卫断言组 / 与既有闸的关系 |

## 为什么要快照制【决策】

**实撞史（2026-09-04，0.12.2 发版三连拦）**：一次发版被连续拦下三回——① E2E 凭证过期（13 分钟 live:core 测试期间，HEAD 被并行会话推走，凭证 commit 永远追不上移动的 HEAD）；② dist 陈旧导致 18 个测试红（dist 是旧 HEAD 构建的，源码已被并行推进）；③ timeout 偶发（另案，不混入本批）。前两拦是同一个病根：**发版的靶子（HEAD）在发版过程中一直动**。

作者对焦三轮定调：先问"可以在测试之前就先测一遍么，或者是锁定当前版本？"——先测一遍治不了本（测完靶子又动了），锁定版本才对。关键点破："**实际上，我们往往是多 agent 并发的，很难保证（静默）**"——任何依赖"发版期间大家都别动库"的方案都不成立，多 agent 并发是本库的常态工作方式。快照制的成立本质恰是**不需要任何人静默**：release 启动即冻结 commit，独立 worktree 跑全程，主区物理脱钩随便动。

这也是成熟发版工程的通用形态（release branch / tag-based release 同思想）：发的是"测过的那个提交"，验证与发布之间零窗口，晚到的提交进下一个版本周期——它们本来就该在那。

## 快照制五条款【契约】 ^anc-release-snapshot

### 条款 1：快照语义

发的是**测过的那个提交**，不是"此刻的 HEAD"。release 启动即冻结 `SNAP=$(git rev-parse HEAD)`（全脚本唯一一处读 HEAD——这是守卫断言点），此后全部检查（工作区、全量检查、覆盖率、审计节奏、tarball 资产、E2E 凭证闸、breaking 闸）与升版本、publish 都对着**快照 worktree** 跑。主区并行推进不拦发版：原"有新改动"类检查在快照语义下没有存在意义——新改动不在发的内容里。①工作区检查从"拦"降为"警告列出"，附一句"并行改动不在本次发版内"。

### 条款 2：快照区生命周期

- **落位**：容器目录 `.release-wt/`（仓库根下，gitignore），worktree 在 `.release-wt/wt`。**worktree 必须比容器深一层**：`npm run check` 内含 hopissues 开工扫描，它按"仓库根的上一级找 `hopissues/`"解析——worktree 直接落仓库根下一级时，它的上一级是主仓库根，`hopissues` 找不到即红。容器目录里放一个指向真 `../hopissues` 的软链解决（源缺席则跳过软链，与主区同病同症不装绿）。
- **记录文件**：`.release-snapshot`（仓库根，gitignore），内容一行=SNAP 完整 sha。
- **断点分诊（重跑时最先判：旧快照续不续）**：判据=**快照是否已过不可逆点**，不可逆点=升版本提交已产生（快照区 HEAD 已前进离开 SNAP，或某 v* tag 的父提交==SNAP——后者兜 worktree 缺损时版本提交只剩 tag 引用的形态）。**未过** → 再看主区动没动：SNAP==当前主区 HEAD（纯重试，环境抖动类）→ 续用原区照旧（重冻结也是同一提交，弃了白弃一次 build）；SNAP≠当前主区 HEAD → 自动废弃旧快照（弃区+删记录），落到"记录缺席"分支按当前主区重新冻结，打印一行"旧快照未过升版本点且主区已推进——重新冻结"，人零动作。为什么：升版本之前快照里没有任何需要保护的内容（没 bump 没 tag 没 publish），而检查阶段失败的修复提交多半已进主区——续用旧快照会在同一处再红，还得人手工报废（2026-09-04 快照制首发实撞：审计红的修复收编进主区后，旧快照追不上修复，作者抓"这个能智能点么"）。**已过** → 恒续同一快照（防重复 bump、防 tag 撞名、防重复 publish——这正是断点续发要保护的东西）。已知边界：分诊不防并发 release（两个终端同时跑 release 会互拆快照区——旧形态同样不防，发版是人工触发的串行操作，并发跑属操作错误不设防）。
- **启动分派（分诊之后）**：记录文件在场且 worktree 完好 → 断点续发，沿用同一快照；记录在场但 worktree 缺损 → 按记录的 SNAP 重建 worktree（配已 bump 恢复：扫 v* tag 找父==SNAP 的版本提交前进过去）；记录缺席 → 新发版：冻结 SNAP、写记录、`git worktree add --detach .release-wt/wt $SNAP`、挂 node_modules 软链、快照区 `npm run build`（**dist 恒由快照源码构建**——"dist 陈旧 18 红"在快照制下结构性消失）。记录缺席但残留旧 worktree → 先弃残区再新建。经分诊后，走到续发分支的必然已 bump——重冻结的浪费面只剩"主区没动的纯重试"（环境抖动类）也重建一次区+build，约一分钟，换取单一冻结路径不再多读主区提交。
- **弃区**：⑪ 收编完成后 `git worktree remove --force` + 删记录文件（快照区里的版本提交已被 tag 引用、已 cherry-pick 回主区，不丢东西）。

### 条款 3：E2E 凭证闸新判据

凭证 commit 的合格判据从"==HEAD 或为 HEAD 祖先且差集全落黑名单"改为：**凭证 commit == SNAP，或为 SNAP 祖先且差集 diff 路径全部落发版无关黑名单**（`NONRELEASE_RE` 宽容面原样保留——黑名单枚举确认不影响发版产物的路径，名单外一切缺省拦）。凭证生产侧（`test:live:core` 落盘 `.e2e-evidence/*.json` 记跑时 HEAD）本批不动；建议今后对快照区跑 live:core，则凭证天然==SNAP。凭证文件与 `.anchor-audit` 审计台账都是主区的不入库产物，快照区不携带——闸从主区路径读文件、对 SNAP 判 commit。

### 条款 4：收编协议

版本提交（package.json+package-lock.json 双文件）与 tag 在**快照区**产生，以 SNAP 为父（`npm version --no-git-tag-version` + 手工 commit + tag，形态沿旧例）。⑪ 改三拍，各拍独立执行各看输出（**不用 `||` 单行连写——该形态吞输出，两连撞实录**）：

1. **主区 cherry-pick 版本提交**：`git cherry-pick <快照区版本提交>`——撞冲突（并行改动碰了 package.json/package-lock.json）响亮失败，带手工处置指引（解决冲突 → `git cherry-pick --continue` → 重跑 release 续收编）；
2. **push 主分支**（`/usr/bin/git push`——系统 git，homebrew git 缺 keychain helper）；
3. **push tag**（`/usr/bin/git push origin v<版本>`）。

tag 指向快照区那个提交（父=SNAP），主分支上是它的 cherry-pick 副本——两个 sha 不同是快照制的正常形态（release branch 同款拓扑），tag 可达的历史全在远端。

### 条款 5：dry-run 演练模式

`RELEASE_DRY_RUN=1 npm run release` 走通：冻结 → 建区 → 全检（①-④b、④凭证闸、⑥a breaking 闸）→ 升版本（快照区内真 bump 真 commit）→ tarball 核对；**跳过**真 publish 与 ⑧⑨⑩（登录预检 ⑤ 一并跳过——弹浏览器不适合演练）；⑪ 只报不推（打印将要 cherry-pick 的提交与将要 push 的 tag）；**不建真 tag**（tag 是仓库全局的，跨 worktree 可见，演练残留会污染主区——只报"将打 v<版本>"）；尾部无论成败自动弃区删记录，主区零残留，可反复演练。防呆：启动时若发现在途真发版（记录文件在场），拒绝演练不弃他人的区。

## 与既有闸的关系【说明】

- 十一步检查单的步骤集合不变，变的是**作业对象**：①主区（降级为警告）；②③④a④b⑥⑥a⑦ 对快照区；④ 凭证判据对 SNAP；⑤⑦b⑧⑨⑩ 与作业目录无关照旧；⑪ 由"push 主区自身提交"改为三拍收编。
- ④a 语义审计节奏读主区 `.anchor-audit/`（不入库的环境级台账，快照不携带、也无需携带——它本来就是提示不拦）。
- 断点续发/幂等模式的判定基准从"主区 HEAD 是否在 tag 上"改为"**快照内容与已发 tag 内容是否零差异**"（`git -C <快照区> diff --quiet v<版本>`）。为什么不能沿用"HEAD 在 tag 上"：收编后主区 HEAD 是版本提交的 cherry-pick 副本，sha 与 tag 指向的快照区提交**不同**——发完重跑 release 时按 sha 判永远判不出"已发完"，会误开一轮无内容的新发版；按内容判则"发完零新增重跑"正确落幂等收尾模式，有真新内容才开新发版。半截态（tag 已打未上 npm）判定沿旧形态（tag 在场 + 快照区 HEAD 在 tag 上）。
- breaking 闸的 commit 范围从 `LASTTAG..HEAD` 改为 `LASTTAG..SNAP`。**基线 tag 的找法必须按版本号排序取最大者**（`git tag -l 'v*' --sort=-v:refname | head -1`），不许用 `git describe --tags <SNAP>`——describe 只沿祖先链找，而快照制下版本提交在侧线（tag 指向"父=当时快照"的侧线提交，不是主分支的祖先），describe 会越过全部快照制 tag 落到最后一个旧形态 tag 上，闸从此扫的是几个版本周期的累积提交（2026-09-09 0.14.1 发版实撞：describe 找到 v0.12.1，把三个早已随 v0.13.0/v0.14.0 发过的含"退役/废除"字样提交误拦，被迫走 HOPJIT_RELEASE_ALLOW_PATCH=1 豁免——豁免通道被误报消耗，真 breaking 混在旧账里反而看不见）。范围写 `LASTTAG..SNAP` 语义正确：`git log A..B` 排除 A 可达的全部提交，侧线 tag 的父正是上一版快照，其祖先链恰好盖住已发内容。

## 守卫断言组【说明】

`tests/guard-scripts.test.ts` 对 `scripts/release.sh` 的静态断言（@v: anc-release-snapshot）：SNAP 冻结行在场；裸 `git rev-parse HEAD` 全文只出现一处（冻结点——防将来改动漏改、悄悄回到 HEAD 语义）；`git worktree add --detach` 行在场；publish 行带快照区上下文（`in_wt` 前缀）；`RELEASE_DRY_RUN` 分支在场。准入负向验证：删冻结行断言红、恢复绿（实录在 TRACEABILITY 卡）。

## 发布防线四断言【契约】 ^anc-release-boundary-guards

maintainers/ 目录（涉内部源的维护者文档，2026-09-13 建）的"不出公开面"承诺由四处独立声明共同兑现，任何一处静默漂移其余三处不报警——第九轮工程链 review 变异核证实锤三处全穿透（把 maintainers 偷加进快照白名单/删 verify 验证项/删发版黑名单项，全库零机检变红）。守卫形态沿用本文档"守卫断言组"同款静态文本断言（发布脚本不被 vitest 跑，钉脚本文本是既有成例），四断言：

1. `scripts/github-publish.sh` 的 `INCLUDE_DIRS=(...)` 行**不含** maintainers（出闸白名单——误配即整目录进公开快照，且净度词表对 maintainers/ 现内容零命中，白名单是唯一有效防线）；
2. `scripts/github-verify.sh` 的 `MISS_EXPECTED=(...)` 行**含** maintainers（验闸清单——删项后 verify 照报全过，验闸静默退化）；
3. `scripts/release.sh` 的 `NONRELEASE_RE` 正则**含** `maintainers/`（发版凭证差集闸——删项后果是误拦方向，轻于前两条但同为防线声明点）；
4. `package.json` 的 `files` 数组**不含** maintainers 与 RELEASING（npm tarball 出口负向断言——白名单天然挡，断言防将来误加）。

变异重放判据（准入负向验证）：INCLUDE_DIRS 偷加 maintainers → 断言 1 红；MISS_EXPECTED 删 maintainers → 断言 2 红；NONRELEASE_RE 删 maintainers/ → 断言 3 红；恢复全绿。

## 版本兼容性原则【契约】 ^anc-release-version-compat

（todo/0093,作者定 2026-09-15"应该开始执行版本兼容性原则"——0092 修复后作者追问"spec 和引擎版本不一致怎么办"暴露两方向都无系统防线;方案三轮对焦撤 migrate CLI〔太重〕与 /hop 批量〔用户错位〕两案,终形=零新装置三小件）

**兼容方向承诺**：新引擎必须能跑旧 spec（向后兼容优先）。破坏性收严（既有规则改档升严同算）三义务缺一不可：

1. **决策交代**——实撞驱动的作者拍板或概念层决策,账面可溯（spec-parser 版本行条款 2026-09-15 已扩"改档升严须决策交代"）;
2. **validate 报文带修法**——**报文质量即迁移承诺**:本产品用户形态是"人在 CC/Codex 会话里用",agent 读报文照改是第一迁移路径,报文必须让 agent 零背景照改（既有报文纪律的升格表述）;
3. **迁移知识登记**——旧写法→新写法对照进 hopfix 知识供给面（`/hopfix` 以"新引擎 validate error 清单"为工单即批量迁移通道——三层把关/人批写回/快照回滚全复用,见 [[hopfix]]）+ release note 迁移段（人查半边）。

**版本号语义（0.x 阶段）**：patch=纯修复零行为破坏（release.sh breaking 闸在执行）;minor=可含破坏性收严但必须带齐三义务;1.0 后转正式 semver 承诺。

**spec 声明面**：Config 段 `engine_min_version` 键+引擎 init 闸,契约权威 [[exec-engine#^anc-exec-engine-min-version-gate]];pack 注入面归 [[hop-cli#^anc-cli-pack]]。**反方向不设闸**：不加"最高兼容版本"声明——每次发版都要维护所有存量 spec,成本失衡;该半边由三义务守。

**义务③的机检提醒**：release.sh breaking 闸命中破坏性标记词时,提示文案加一行"若确为破坏性收严:hopfix 迁移知识与 release note 迁移段是发版义务（本节）"——不硬闸（义务完成与否机器判不了）,提醒挂在必经点。
