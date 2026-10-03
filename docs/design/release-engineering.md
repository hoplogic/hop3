%% @trace
	id: hopjit-release-engineering
	source: [[chain-enforcement]]
	source_id: hopjit-chain-enforcement
	type: intent
	last_sync: 2026-10-02T02:30+0800
	note: 发版工程设计——快照制（release 启动冻结 commit，全部检查与发布对着快照 worktree 跑）。G5 检查单（scripts/release.sh）与 GitHub 公开快照发布（scripts/github-publish.sh）的行为权威；chain-enforcement §8 的 release 闸行是其守卫映射。2026-10-02 增 ^anc-release-tarball-self-contained（npm 包文档自足——用户面文档随包分发,不靠 GitHub 兜底）。
%%

# 发版工程——快照制（release snapshot）

> **模块版本**：release-engineering `v0.3.1`（2026-10-03 工程链 review 修复：HopTrait PkgDocsLifecycle 从散文改写成 trait 块〔三模式 Inputs/Outputs/失败条件 + ensures/preserves——preserves 钉 prepack 恒经 build 与 driver 指路路径恒在清单〕;净度验收散文区改用与清洗同一把 CommonMark 尺并加 NUL 第八样;词表缺席分叉明示;分项计数 14 份;守卫条目补七条反例;⑤ 删未兑现子句、⑥ 改三条）。上版 v0.3.0（2026-10-02 ^anc-release-tarball-self-contained 定形：进包的是打包期清洗后的发布件〔prepack 原地替换/postpack 备份恢复〕,清单权威 scripts/pkgdocs-manifest.json,D 系列/工程实现链/ARCHITECTURE 不进;同日 v0.2.0 首稿曾按整目录进包,作者抓'发布版本不应留内部信息'后改定形）。上版 v0.1.0（2026-09-04 快照制立文,此前无版本行——本行首立）。逐版演进史归 git log。

**给谁**：改 `scripts/release.sh` 的人（agent 或维护者）。逐次操作归维护者操作手册（内部维护面,不随快照分发,人每次发版照走）；本文是行为权威——脚本怎么改、为什么这么定，冲突以本文为准。

## 文档结构与内容分级

| 分级 | 节 |
|---|---|
| 【决策】 | 为什么要快照制（实撞史与作者对焦） |
| 【契约】 | 快照制五条款（^anc-release-snapshot）/ 发布防线四断言（^anc-release-boundary-guards）/ GitHub 公开快照发布（^anc-release-github-snapshot）/ npm 包文档自足（^anc-release-tarball-self-contained）/ 版本兼容性原则（^anc-release-version-compat） |
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
- **断点分诊（重跑时最先判：旧快照续不续）**：判据=**快照是否已过不可逆点**，不可逆点=升版本提交已产生（快照区 HEAD 已前进离开 SNAP，或某 v* tag 的父提交==SNAP——后者兜 worktree 缺损时版本提交只剩 tag 引用的形态）。
  - **未过** → 再看主区动没动：SNAP==当前主区 HEAD（纯重试，环境抖动类）→ 续用原区照旧（重冻结也是同一提交，弃了白弃一次 build）；SNAP≠当前主区 HEAD → 自动废弃旧快照（弃区+删记录），落到"记录缺席"分支按当前主区重新冻结，打印一行"旧快照未过升版本点且主区已推进——重新冻结"，人零动作；
    - 为什么：升版本之前快照里没有任何需要保护的内容（没 bump 没 tag 没 publish），而检查阶段失败的修复提交多半已进主区——续用旧快照会在同一处再红，还得人手工报废（2026-09-04 快照制首发实撞：审计红的修复收编进主区后，旧快照追不上修复，作者抓"这个能智能点么"）；
  - **已过** → 恒续同一快照（防重复 bump、防 tag 撞名、防重复 publish——这正是断点续发要保护的东西）；
  - 已知边界：分诊不防并发 release（两个终端同时跑 release 会互拆快照区——旧形态同样不防，发版是人工触发的串行操作，并发跑属操作错误不设防）。
- **启动分派（分诊之后）**：
  - 记录文件在场且 worktree 完好 → 断点续发，沿用同一快照；
  - 记录在场但 worktree 缺损 → 按记录的 SNAP 重建 worktree（配已 bump 恢复：扫 v* tag 找父==SNAP 的版本提交前进过去）；
  - 记录缺席 → 新发版：冻结 SNAP、写记录、`git worktree add --detach .release-wt/wt $SNAP`、挂 node_modules 软链、快照区 `npm run build`（**dist 恒由快照源码构建**——"dist 陈旧 18 红"在快照制下结构性消失）；
  - 记录缺席但残留旧 worktree → 先弃残区再新建；
  - 经分诊后，走到续发分支的必然已 bump——重冻结的浪费面只剩"主区没动的纯重试"（环境抖动类）也重建一次区+build，约一分钟，换取单一冻结路径不再多读主区提交。
- **弃区**：⑪ 收编完成后 `git worktree remove --force` + 删记录文件（快照区里的版本提交已被 tag 引用、已 cherry-pick 回主区，不丢东西）。

### 条款 3：E2E 凭证闸新判据

凭证 commit 的合格判据从"==HEAD 或为 HEAD 祖先且差集全落黑名单"改为：**凭证 commit == SNAP，或为 SNAP 祖先且差集 diff 路径全部落发版无关黑名单**（`NONRELEASE_RE` 宽容面原样保留——黑名单枚举确认不影响发版产物的路径，名单外一切缺省拦）。

- 凭证生产侧（`test:live:core` 落盘 `.e2e-evidence/*.json` 记跑时 HEAD）本批不动；建议今后对快照区跑 live:core，则凭证天然==SNAP；
- 凭证文件与 `.anchor-audit` 审计台账都是主区的不入库产物，快照区不携带——闸从主区路径读文件、对 SNAP 判 commit。

### 条款 4：收编协议

版本提交（package.json+package-lock.json 双文件）与 tag 在**快照区**产生，以 SNAP 为父（`npm version --no-git-tag-version` + 手工 commit + tag，形态沿旧例）。⑪ 改三拍，各拍独立执行各看输出（**不用 `||` 单行连写——该形态吞输出，两连撞实录**）：

1. **主区 cherry-pick 版本提交**：`git cherry-pick <快照区版本提交>`——撞冲突（并行改动碰了 package.json/package-lock.json）响亮失败，带手工处置指引（解决冲突 → `git cherry-pick --continue` → 重跑 release 续收编）；
2. **push 主分支**（`/usr/bin/git push`——系统 git，homebrew git 缺 keychain helper）；
3. **push tag**（`/usr/bin/git push origin v<版本>`）。

tag 指向快照区那个提交（父=SNAP），主分支上是它的 cherry-pick 副本——两个 sha 不同是快照制的正常形态（release branch 同款拓扑），tag 可达的历史全在远端。

### 条款 5：dry-run 演练模式

`RELEASE_DRY_RUN=1 npm run release` 走通：冻结 → 建区 → 全检（①-④b、④凭证闸、⑥a breaking 闸）→ 升版本（快照区内真 bump 真 commit）→ tarball 核对。

- **跳过**真 publish 与 ⑧⑨⑩（登录预检 ⑤ 一并跳过——弹浏览器不适合演练）；⑪ 只报不推（打印将要 cherry-pick 的提交与将要 push 的 tag）；
- **不建真 tag**（tag 是仓库全局的，跨 worktree 可见，演练残留会污染主区——只报"将打 v<版本>"）；
- 尾部无论成败自动弃区删记录，主区零残留，可反复演练。防呆：启动时若发现在途真发版（记录文件在场），拒绝演练不弃他人的区。

## 与既有闸的关系【说明】

- 十一步检查单的步骤集合不变，变的是**作业对象**：①主区（降级为警告）；②③④a④b⑥⑥a⑦ 对快照区；④ 凭证判据对 SNAP；⑤⑦b⑧⑨⑩ 与作业目录无关照旧；⑪ 由"push 主区自身提交"改为三拍收编。
- ④a 语义审计节奏读主区 `.anchor-audit/`（不入库的环境级台账，快照不携带、也无需携带——它本来就是提示不拦）。
- 断点续发/幂等模式的判定基准从"主区 HEAD 是否在 tag 上"改为"**快照内容与已发 tag 内容是否零差异**"（`git -C <快照区> diff --quiet v<版本>`）。
  - 为什么不能沿用"HEAD 在 tag 上"：收编后主区 HEAD 是版本提交的 cherry-pick 副本，sha 与 tag 指向的快照区提交**不同**——发完重跑 release 时按 sha 判永远判不出"已发完"，会误开一轮无内容的新发版；按内容判则"发完零新增重跑"正确落幂等收尾模式，有真新内容才开新发版；
  - 半截态（tag 已打未上 npm）判定沿旧形态（tag 在场 + 快照区 HEAD 在 tag 上）。
- breaking 闸的 commit 范围从 `LASTTAG..HEAD` 改为 `LASTTAG..SNAP`。**基线 tag 的找法必须按版本号排序取最大者**（`git tag -l 'v*' --sort=-v:refname | head -1`），不许用 `git describe --tags <SNAP>`。
  - 为什么禁 describe：describe 只沿祖先链找，而快照制下版本提交在侧线（tag 指向"父=当时快照"的侧线提交，不是主分支的祖先），describe 会越过全部快照制 tag 落到最后一个旧形态 tag 上，闸从此扫的是几个版本周期的累积提交；
  - 实撞出处（2026-09-09 0.14.1 发版）：describe 找到 v0.12.1，把三个早已随 v0.13.0/v0.14.0 发过的含"退役/废除"字样提交误拦，被迫走 HOPJIT_RELEASE_ALLOW_PATCH=1 豁免——豁免通道被误报消耗，真 breaking 混在旧账里反而看不见；
  - 范围写 `LASTTAG..SNAP` 语义正确：`git log A..B` 排除 A 可达的全部提交，侧线 tag 的父正是上一版快照，其祖先链恰好盖住已发内容。
- ⑦b registry 轮询：两次查询之间的等待秒数写成一个数组 `POLL_SLEEPS`，合计不少于 9 分钟（现值 570 秒，共查 13 次）。
  - 为什么：npm 新版本在 registry 上可见的延迟波动很大。0.1.7 实测 3 秒仍读到旧版；0.18.0 发版时 publish 成功约 5 分钟后 `npm view` 才返回新版本，原先 6 次共 210 秒的轮询先判了失败，人只好重跑 release 走续发模式补完后半程。轮询判失败的代价是人多跑一轮，轮询多等几分钟的代价是零，所以宁长勿短；
  - 写成数组是为了让总时长可以被静态断言钉住（守卫断言组读数组求和）。
- 收尾指路：`✅ 发版完成` 那行之后打印下一步——同步 GitHub 公开快照（`./scripts/github-publish.sh`，流程见维护者操作手册的 GitHub 快照节，推送归人）。快照同步本身不挂进 release.sh 自动执行：它有一步外向推送，按仓库拓扑规定归人手敲；挂一行指路是为了让这一步不再靠人记得。

## 守卫断言组【说明】

`tests/guard-scripts.test.ts` 对 `scripts/release.sh` 的静态断言（@v: anc-release-snapshot）：SNAP 冻结行在场；裸 `git rev-parse HEAD` 全文只出现一处（冻结点——防将来改动漏改、悄悄回到 HEAD 语义）；`git worktree add --detach` 行在场；publish 行带快照区上下文（`in_wt` 前缀）；`RELEASE_DRY_RUN` 分支在场。准入负向验证：删冻结行断言红、恢复绿（实录在 TRACEABILITY 卡）。

## 发布防线四断言【契约】 ^anc-release-boundary-guards

maintainers/ 目录（涉内部源的维护者文档，2026-09-13 建）的"不出公开面"承诺由四处独立声明共同兑现，任何一处静默漂移其余三处不报警——第九轮工程链 review 变异核证实锤三处全穿透（把 maintainers 偷加进快照白名单/删 verify 验证项/删发版黑名单项，全库零机检变红）。守卫形态沿用本文档"守卫断言组"同款静态文本断言（发布脚本不被 vitest 跑，钉脚本文本是既有成例），四断言：

1. `scripts/github-publish.sh` 的 `INCLUDE_DIRS=(...)` 行**不含** maintainers（出闸白名单——误配即整目录进公开快照，且净度词表对 maintainers/ 现内容零命中，白名单是唯一有效防线）；
2. `scripts/github-verify.sh` 的 `MISS_EXPECTED=(...)` 行**含** maintainers（验闸清单——删项后 verify 照报全过，验闸静默退化）；
3. `scripts/release.sh` 的 `NONRELEASE_RE` 正则**含** `maintainers/`（发版凭证差集闸——删项后果是误拦方向，轻于前两条但同为防线声明点）；
4. `package.json` 的 `files` 数组**不含** maintainers 与 RELEASING（npm tarball 出口负向断言——白名单天然挡，断言防将来误加）。

变异重放判据（准入负向验证）：INCLUDE_DIRS 偷加 maintainers → 断言 1 红；MISS_EXPECTED 删 maintainers → 断言 2 红；NONRELEASE_RE 删 maintainers/ → 断言 3 红；恢复全绿。

## GitHub 公开快照发布【契约】 ^anc-release-github-snapshot

（todo/0094。npm 发版之后，`scripts/github-publish.sh` 把内网源按白名单导出成净化快照，在一个本地快照仓里追加一个提交，再由人推到 GitHub 公开仓；推完跑 `scripts/github-verify.sh` 验证。公开仓的历史是"一版一个快照提交"逐版累积，不 force。）

**问题怎么来的**：快照仓缺省落在系统临时目录 `$TMPDIR/hop3-github-snapshot`。旧脚本判断"首次还是追加"只看本地 `.git` 目录在不在——在就追加，不在就 `git init` 新建。临时目录会被系统周期清理，清掉之后脚本新建出一条与远端毫无关系的孤立历史（一个没有父提交的提交），推送时才被 GitHub 的 fast-forward 保护拒绝，而脚本前面全程报绿。

实撞记录：0.16.0 发版撞上了：推送被拒后手工 `git fetch github main` 再 `git reset --hard github/main` 救回；0.17.0 发版时事先发现快照区已被清空，手工先 ls-remote 探远端、再 clone 远端立基，推送才没被拒。

0.18.0 发版时撞到的是另一种形态：`.git` 目录还在，但系统只清掉了其中的 HEAD 等文件，只剩 objects/refs/logs——git 已经不认它是仓库，旧脚本的"目录在不在"却判它在，会直接在坏仓上执行 `git add` 报错。

**病根**：本地 `.git` 在不在，与"远端有没有历史"是两个独立的事实，旧脚本用前者推断后者。

### 立基规则

**远端是权威，本地快照仓是纯派生物**。快照仓的内容恒可以从内网源按白名单重新导出，它的本地历史里没有任何只存在于本地的东西（唯一例外是"上次导出了但还没推"的那个提交，见下表第 4 行）。所以本地历史与远端对不上时，一律丢掉本地、按远端 main 重新立基，丢掉的东西下一步导出时会原样再生。

立基放在导出之前：先探远端，探测结果决定本地仓怎么处理，处理完才清空工作区、导出内容。**远端探测失败时退出非零，不创建 `.git`、不写任何快照内容**——禁止静默跳过（[[chain-enforcement#^anc-meta-guard-trust]] 同款纪律），更不许退回盲建。

远端探测用 `git ls-remote <远端> refs/heads/main refs/tags/v<版本>`：只交换引用列表不传对象，秒级返回，不受大对象传输通道慢的影响；返回成功即说明网络与远端地址都通。

| # | 远端 main | 本地仓状态 | 处理 |
|---|---|---|---|
| 1 | 探测失败 | 任意 | 退出非零，报"远端探测失败"与原始报错，不动本地 |
| 2 | 不存在（空仓） | 无有效仓 | 真首建：`git init -b main`，打印"远端没有 main，首次发布" |
| 3 | 不存在（空仓） | 有效仓 | 沿用本地（首次发布已导出、还没推） |
| 4 | 存在 | 有效仓，且远端 main 是本地 HEAD 的祖先（含相等） | 沿用本地（上次导出了还没推，或已推过） |
| 5 | 存在 | `.git` 不存在 | 按远端 main 立基 |
| 6 | 存在 | `.git` 存在但无效（没有 HEAD 等，git 不认） | 删掉坏 `.git`，按远端 main 立基 |
| 7 | 存在 | 有效仓，但远端 main 不是本地 HEAD 的祖先（分叉，或本地根本没有远端那个提交） | 按远端 main 立基 |

- **"有效仓"的判法**：用 `git --git-dir=<快照目录>/.git rev-parse --verify -q HEAD` 能取到提交号。必须显式指定 `--git-dir`——不指定时 git 会沿父目录向上找仓库，快照目录若恰好位于别的仓库里，会误判成那个仓库；
- **"按远端 main 立基"的动作**：本地没有有效仓就先 `git init -b main`；然后 `git fetch --depth 1 <远端> main` 只取远端最新那一个提交（浅取：公开仓每版一个提交，只需要头一个当父提交，浅取把传输量压到一份快照的大小），把 HEAD 指向 main 分支并 `git reset <取到的提交>`——工作区不动（马上会被导出内容整体覆盖），索引对齐远端那一版，这样随后的 `git add -A` 算出的就是"这一版相对上一版"的真实差异；
- 从浅仓推送是 git 支持的形态：远端已经有父提交，推送只需要传新提交本身。

**远端地址可覆盖**：环境变量 `HOP3_GITHUB_URL` 缺省为公开仓地址；测试用本地裸仓替代，不碰网络。**只立基不导出**：环境变量 `HOP3_PUBLISH_BASE_ONLY=1` 时立基完成即打印本地 HEAD 并退出——供测试单独验立基逻辑，不依赖当前源码是否净度合格。

### 导出之后

- 净度闸照旧：白名单导出面对 `scripts/github-purity-words.txt` 零命中才往下走。**命中时修内网源头**（把措辞改成中性说法并提交，再重跑脚本），不改快照里的文件——改快照的结果下次导出会被覆盖回来；词表本身的扩缩要作者批；
- 与上一版有差异才提交，提交说明形态 `hoplogic <版本> (snapshot of internal <内网短提交号>)` 不变（verify 的 probe1 按 `snapshot of internal` 认快照提交）；
- **本地 tag `v<版本>` 恒指向本次的快照提交（HEAD）**：不存在就打；已存在但指向别的提交，就用 `git tag -f` 移到 HEAD，并打印原来指向哪个提交。为什么不能"已存在不重打"：本地 tag 和本地历史一样是派生物，立基（规则表第 5、6、7 行）丢掉旧历史后，上一轮导出时打的旧 tag 还悬在那个孤立提交上——照脚本打印的命令推 tag，会把一条与公开历史无关的孤立提交推上公开仓（远端还没有这个 tag 时推送不会被拒）。同理，第 4 行"导出了还没推"之后源码又变、再导出一次，旧 tag 会停在上一次那个提交上；
- 远端 tag 的提醒分两种：远端已有 `v<版本>` 且与 HEAD 是同一个提交，打印"远端已有同一 tag，无需推 tag"；远端已有但指向别的提交，打印"本版已同步过，本次产生了不同的快照提交，推 tag 会被远端拒"——同一版本号内容又变了，属于需要人判断的情形，脚本不自动处理（不删远端、不改版本号）；
- 本地仓的远端名 `github` 由脚本配置好（`git remote add`，已存在则 `set-url`）——这是本地配置，不是外向动作；
- **推送归人**：脚本只打印推送 main 与推送 tag 两条命令和随后的 verify 命令，自己不推（仓库拓扑规定 hop3 快照仓的例行发版推送随 release 流程归人）。

### 公开快照自洽

公开快照必须能让外部用户 clone 后 `npm test` 全绿。剔除清单拿掉的发布工装（`github-publish.sh`、`github-verify.sh` 等）在公开快照里不存在，而守卫测试要读它们的文本做静态断言——0.17.1 公开仓实测 `npm test` 3121 过 2 败，败的正是这两例（读文件报 ENOENT）。

- 规则：**凡读被剔除文件的测试，在公开快照里跳过**。判断"当前是公开快照"的标记是 `scripts/check-hopissues.mjs` 不存在——它在剔除清单里，而内网恒在（`check:fast` 要调它）；
- 为什么不直接按被读文件在不在判：那样内网里误删了被测脚本，测试会跟着静默跳过，防线就退化了。按标记判，内网里标记恒不成立、测试不跳过，误删被测脚本照样读文件报红；
- 跳过在 vitest 计数里可见（skipped），不是静默装绿。

```text
HopType RemoteProbe:
  probe_ok: bool        # git ls-remote 是否成功返回（false=网络或地址不通，脚本退出）
  remote_main: text     # 远端 main 的提交号；空串=远端没有 main（空仓）
  remote_tag: text      # 远端 v<版本> tag 指向的提交号；空串=远端还没有这个 tag

HopType LocalRepoState:
  local_head: text      # 本地快照仓 HEAD 提交号；空串=.git 不存在或无效
  contains_remote: bool # 远端 main 是否为本地 HEAD 的祖先（含相等）；remote_main 为空时恒 false

HopTrait PublishGithubSnapshot:
  requires: 内网主区 HEAD 是已发 npm 版本（或其后的发版无关提交）；快照目录可写
  ensures: 快照仓 main 的新提交以远端 main 为父（远端空仓时为根提交）；本地 tag v<版本> 恒指向本次快照提交（旧 tag 指向别处时移过来）；远端探测失败时退出非零且快照目录零改动
  preserves: 推送恒归人；净度闸与白名单剔除清单语义不变；公开历史只追加不改写

HopSop:
  1. 用 git ls-remote 取 RemoteProbe；失败则打印"远端探测失败"与原始报错，退出非零。
  2. 用显式 --git-dir 取 LocalRepoState。
  3. 按立基规则表处理本地仓：沿用、真首建、或按远端 main 立基（坏 .git 先删；浅取远端 main；HEAD 指 main；reset 到取到的提交）。
  4. HOP3_PUBLISH_BASE_ONLY=1 时打印本地 HEAD 退出。
  5. 清空快照目录里 .git 以外的一切，按白名单导出、执行剔除清单与快照版配置改写。
  6. 净度闸：词表命中则列出命中文件并退出非零（修法是改内网源头）。
  7. git add -A；与上一版有差异才提交。
  8. 本地 tag v<版本> 指向 HEAD：不存在就打，指向别处就 git tag -f 移过来并打印原指向；远端已有同名 tag 时按是否与 HEAD 同一提交打印两种提醒之一。
  9. 配置远端名 github；打印推送 main、推送 tag、运行 verify 三条命令，交人执行。
```

守卫（@v: anc-release-github-snapshot，`tests/guard-scripts.test.ts`）：用本地裸仓当远端的行为测试覆盖立基规则表第 1、2、4、5、6、7 行（第 3 行是第 2 行跑完后的续跑形态，逻辑与第 4 行同一分支）。

另有一例全流程行为测试：在临时替身仓库里放一份脚本副本与最小白名单文件，远端用本地裸仓，快照目录预置一个与远端分叉、且带旧 tag `v<版本>` 的本地仓，跑完整发布后断言新提交的父提交是远端 main、本地 tag 指向新提交。

release.sh 静态断言两条——`POLL_SLEEPS` 求和不少于 540 秒、`✅ 发版完成` 之后有指向 `github-publish.sh` 的一行。读 `github-publish.sh` 与 `github-verify.sh` 的测试一律带公开快照标记跳过。

## npm 包文档自足【契约】 ^anc-release-tarball-self-contained

（作者定 2026-10-02 三轮对焦："仅用 npm 安装 hop 的 agent 要能自给自足地理解和使用 hop"→"要考虑到国内访问 GitHub 不方便"→"vault 里的链接是做工程链用的,npm 包是发布版本,不应该留这些内部信息;D 系列是开发 hop 本身用的,不打进 npm"→"HopSop、HopType 需要吧"。合起来：用户面文档随包分发、不靠 GitHub 兜底;进包的是**清洗后的发布件**,不是仓库文件原样拷贝）

**承诺**：只装了 `@hoplogic/hopjit` 包、拿不到仓库的读者（人或 agent）,从包内文件出发能走完"装 → 用 /hop → 写 spec → 配独立模式 → 排错"全程;包内文档不含工程链内部信息（`@trace` 头、`^anc-*` 锚点、设计层链接、Obsidian 双链、todo/hopissues 卡号、"内部开发面"标注）。

### 两个分发面的边界【决策】

仓库（含 GitHub 公开快照）里的文档带工程链标记,因为它们是审计的一环——锚点反查、源-派生追溯都靠这些。npm 包的读者是用户与替用户干活的 agent,这些标记对他们是噪声,还把内部结构暴露出去。所以**源文档在仓库里一个字不改,打包期生成清洗后的发布件进包**——手工维护两份必然漂移,不选。

### 进包清单（HopType PkgDocsManifest）

权威在 `scripts/pkgdocs-manifest.json`（脚本与守卫同读一份,不在两处各写一遍）,结构：

```yaml
PkgDocsManifest:
  files % list[path]        # 进包的源文件相对路径,35 项——
    # 入口五件：README.md / USAGE.md / docs/AGENT-GUIDE.md / docs/WORKAROUNDS.md / docs/reference/配置参考.md
    # 概念层 15 份：语法参考 / 核心规范 / 配套HopJIT运行时能力 / 错误模型 / 五份扩展（事务与补偿、可观测性与YAMLL、有序思考与渐进固化、Python语法沙箱、模型变速箱适配）/ Prompt组装参考 / prompt-author / 核心创新 / HopSop标准作业流程 / HopType体系 / HopAnt概念-双态组件模型
    # 教程用户系列 14 份：00-新人导读、01-第一次运行 ×4（ClaudeCode/Codex/cfuse/opencode 四载体各一份）、02-读懂一份spec … 10-钉钉通知 共 9 份
    # 例外 1 份：D10-hop_python计算体——挂 D 系列名但是用户写 act body 的必需知识（用户系列引用 12 次,教程 03 '下一篇 D10 讲'、08 列为前提）,随包;其余 D 篇不进
  excluded_prefixes % list[path]   # 守卫用：files 白名单里不许出现的源路径前缀——docs/design/ TRACEABILITY.md Doctree.md docs/i18n/ docs/obsolete/ ARCHITECTURE.md docs/tutorials/D docs/concepts/工程实现链
```

**不进包与理由**：D0-D12（开发 hop 引擎本身用的）、三份工程实现链（"怎么用 AI 做工程"的方法论,读者同 D 系列）、`ARCHITECTURE.md`（开发者读物）、`docs/design/`、`TRACEABILITY.md`、`Doctree.md`（指向全库,进包满页死链）、`docs/i18n/`（译本滞后源,进包等于分发过期件）。HopSop/HopType/HopAnt 三份进（作者追认）：HopSop 是教程 02 的地基,HopType 是翻译器引用的类型体系,HopAnt 是 HopType 的上位概念,三份一组。

### 打包期替换机制（HopTrait PkgDocsLifecycle）

npm 的 `files` 白名单不能改路径,生成到别的目录会让包内路径带前缀——而 `/hop` skill 指路的是 `docs/concepts/HopSpec V3语法参考.md` 这个真实路径。所以采用**原地替换、事后恢复**。契约按三种模式写：

```yaml
trait: PkgDocsLifecycle
  # 三种模式共用：清单读 scripts/pkgdocs-manifest.json;清洗规则见下节 HopSop;净度验收不过即整次失败退出非零
  mode --out <目录>:
    Inputs:  目录 % path          # 任意可写目录
    Outputs: 发布件 % list[file]   # 与清单一一对应,写到 <目录>/<清单相对路径>
    失败条件: 清单项源缺失 / 任一发布件净度未过 → 退出 1,一个文件都不写
    ensures: 源文件字节不变
  mode --in-place:
    Inputs:  无（源=仓库清单文件;前置：.pkgdocs-backup/ 不存在）
    Outputs: 源路径被发布件覆盖;.pkgdocs-backup/ 下留全部源原件
    失败条件: .pkgdocs-backup/ 已存在 → 退出 1 并指路 --restore（上一次中断未恢复）;净度未过 → 退出 1
    ensures: 先全量清洗验收再动盘——验收失败时源一字未动、不建备份目录
  mode --restore:
    Inputs:  无
    Outputs: 备份逐文件字节级拷回源路径;删 .pkgdocs-backup/
    失败条件: 无（备份目录不存在 → 空操作退出 0,恢复 0 份——postpack 每次 pack 后都跑,这个缺省必须是安全的）
    ensures: 不走 git checkout,不碰备份外任何文件（工作区未提交改动随备份原样回来）
  preserves:
    - prepack 恒以 `npm run -s build` 开头再串 `--in-place`——build 带 chmod +x dist/cli.js dist/mcp-server.js,作者 eb81fa6b 定"三处共用一个带 chmod 的构建入口";prepack 写成 clean && tsc 会让主区每次 npm pack 后 dist 丢执行位,Codex 下 command -v hopjit 找不到命令（本批首稿实撞）
    - postpack 恒为 `node scripts/build-pkgdocs.mjs --restore`
    - driver 三载体 hop-skill.md 指路的包内路径（`@hoplogic/hopjit/docs/concepts/HopSpec V3语法参考.md`）恒在 manifest.files 内——清单改名/移位时 driver 指路同改
    - 发版在一次性快照 worktree 里打包,主区零影响;本地 npm pack 靠备份恢复。中断残留的处置=手动跑一次 --restore
```

### 清洗规则（HopSop CleanPkgDoc）

**先定两个判据**，后面各步都用：

- **真锚名**：`^anc-` 后至少两段（`^anc-step-call`）。`^anc-*`、`^anc-xxx`、`^anc-x` 这类单段形态是文档在讲锚点语法本身,一律放过;
- **真引用双链 vs 语法示例**：目标带 `#^anc-` 片段、或目标按文件名能在进包清单里找到 → 真引用;目标含 `{…}` 模板占位、或名为 `文档路径`/`doc`/`双链`、或是 `.yaml` 键示例（`[[faults.yaml#键名]]`）、或空 `[[]]` → 语法示例,原样保留。

**代码区的处理原则**：围栏代码块与行内代码里的语法示例不动,但**真引用与真锚名不分散文/代码一律处理**（实撞：HopAnt 的 struct 代码块注释里写着 `^anc-config-model-engine` 锚点定义）。所以第 2 步在遮蔽代码之前做,第 3-5 步在遮蔽之后只碰散文。围栏识别按 CommonMark：只认行首（允许缩进与 `> ` 引用前缀）3 个以上同种反引号或波浪线开栏,同种且数量不少于开栏的行关栏;**行内出现的 ``` 是普通文本**（实撞：核心规范正文里 "` ```hop_python `" 翻转了正则状态机,其后半篇全未清洗）。行内代码按反引号串配对（支持 ``含 ` 的 code``）。遮蔽用占位符,还原后断言无残留 NUL,否则整次失败（实撞：四反引号包三反引号的示例让占位符留在了发布件里）。

逐文件步骤,顺序固定：

1. **去 `@trace` 头块**——文件首个 `%% @trace … %%` 块整段删除,连同其后紧随的空行;
2. **全局处理真引用与真锚名**（不分散文/代码）：真引用双链按三分——目标在清单内 → 相对路径普通 markdown 链接（片段丢弃,显示文字=别名或目标文件名）;目标不在清单内（设计层/Doctree/TODO/D 篇/HopKB 等）→ 退成纯文字;自引用 `[[#^anc-…]]` → "本文相关节"。真锚名按位置——锚点定义位（标题/粗体后、行尾或冒号前）直接删;"按/见/详见/权威见 `^anc-x`" → "按相关规范"/"见本文相关节";"（`^anc-x`）"括注整删;其余裸写删。反引号包的 `docs/design/x.md`：所在行若是旁注形态（行首 `>`/`-`/`|`/缩进且句含"开发者向/权威/详见/见"）整行删,其余改"源码仓设计文档";
3. **遮蔽代码区**,以下只碰散文;
4. **去设计层残余引用**——markdown 链接形态 `[文字](…docs/design/…)` 退成文字;裸路径改"源码仓设计文档";
5. **去卡号与内部标注**——`todo/NNNN`、`hopissues/[项目/]NNNN`、`内部开发面`、`维护者内部面`：所在的全角/方头/半角括注整个删;裸出现改"内部事项卡"。"作者定 YYYY-MM-DD"署期**保留**——那是决策出处,不是内部结构。不随包的内部文件名 `TODO.md`/`CLAUDE.md`/`roadmap` 改"内部待办清单"/"内部工程约定"/"路线图";"本锚点"改"本节";"原 锚点在…原位保留；"整句删;
6. **残句收尾**——空括注 `（见）`/`（）`、"（与 等…）"、相邻删除项之间的孤立 ` / ` 分隔符、"见 本文相关节"的空格、"路线图 路线图"叠词;
7. **还原代码区**;
8. **专项**——`00-新人导读`：开发者系列整段收成一句"开发者系列教程 D0-D12 随源码仓分发,不在本包内";`README`：删"仓库形态"引用块与其后孤立 `>` 行、删根目录表里 todo/、audits/、CLAUDE.md、maintainers/、RELEASING 行、删"开发与发版（维护者）"整节;
9. **净度验收**——每份发布件的**散文区**断言 `@trace`、真锚名、`docs/design/`、真双链、`todo/NNNN`、`hopissues/…/NNNN`、`内部开发面` 七样零命中,第八样全文无 NUL 字节,且净度词表（`scripts/github-purity-words.txt`）零命中;任一命中生成失败退出非零、已写的发布件不留,**不许静默放行**（`^anc-meta-guard-trust`）。**散文区用与第 3 步同一把尺**（同一个 CommonMark 围栏/行内代码剥离函数,脚本内只有一份实现）——两把尺对"行内 ```"判法相反时,验收侧会把半篇正文当代码放过（review 实测三份概念文档 685 行散文从未被检）。词表文件缺席（GitHub 公开快照剔除了内网工装文件）→ 明示一行 warn 后只跑八样,不静默。

**替换词表**（读者会在发布件里看到的,统一口径）：`见本文相关节`（原指本文锚点）/ `按相关规范`（原指他文锚点）/ `源码仓设计文档`（原指 docs/design/ 文件）/ `内部事项卡`（原 todo/hopissues 卡号）/ `本节`（原"本锚点"）/ `内部待办清单`、`内部工程约定`、`路线图`（原 TODO.md、CLAUDE.md、roadmap 文件名）。本文锚与他文锚的分流依据是**写法惯例**：概念层文档引本文锚裸写、引他文锚包反引号——脚本按有无反引号分流,不按锚定义位反查（反查要为全库锚建索引,收益只是把当前 35 份零错从惯例保证改成机制保证,本版不做）。

**不清的**：普通相对路径 markdown 链接（清单内互指两边都通）;`{hop_env_kb_root}` 一类模板占位是语法参考正文的一部分;"作者定 YYYY-MM-DD"署期。

### 链接写法原则

包内文档互指用相对路径（仓库与包内目录结构同形）。**不把任何链接改成 GitHub 绝对地址**——国内读者多半打不开,改绝对地址只是把"文件不存在"换成"网络超时"。

### 守卫

- `tests/guard-scripts.test.ts`：①清单每一项在仓库存在,`files` 与 manifest 等长（不是 ≥ 下限）,driver 三载体 hop-skill 指路的包内路径在清单内;②`package.json` `files` 包含清单每一项,且不含 `excluded_prefixes` 任一前缀;③实跑 `build-pkgdocs.mjs --out <临时目录>`,输出与清单一一对应,净度零命中,另用**独立实现**（测试自己按 CommonMark 逐行剥代码区,不复用脚本函数）核散文无 @trace 头/无真双链/无行尾锚点/无 NUL/词表零命中;README 发布件不含"仓库形态""开发与发版（维护者）""maintainers/",导读发布件含"随源码仓分发,不在本包内"且不含 D1 篇名;④反例：构造一份注入了 `%% @trace %%` 头、行尾 `^anc-top`、`` `^anc-step-call` ``、`[[Doctree]]`、`[[02-读懂一份spec]]`、`（todo/0108）`、`` `docs/design/x.md` `` 旁注行、行内 "` ```hop_python `" 之后的 `todo/0070`、行内代码 `` `execute_tool()` ``、反引号包的清单外双链 `` `[[step-dispatcher]]` `` 的临时源,经同一清洗函数,断言：七样清掉、清单内双链转相对链接、`` `[[]]` ``/`` `^anc-*` ``/`` `[[文档路径#章节名]]` `` 示例原样保留、反引号里的真引用照转链接、行内 ``` 不翻转围栏（其后的卡号仍被清）、行内代码的括号原样、不留"内部事项卡）"残句与"（开发者向）"残行、反引号清单外双链退成 `` `step-dispatcher` ``;⑤前半：`.pkgdocs-backup/` 已存在时 `--in-place` 退出非零且报文指路 --restore,源不变;后半：`--in-place` 后 `--restore` 字节级还原,备份目录不留;⑥`release.sh` ④b MUST 列表含语法参考/教程分流页/HopSop 三条;`prepack` 以 `npm run -s build` 开头且串 `--in-place`,`postpack` 恒等于 `--restore` 命令;⑦反例（临时仓+临时清单含一份注入 @trace 的源）：`--out` 退出非零且目录空;`--in-place` 退出非零且源字节不变、无备份目录;`purityViolations` 对含 NUL 的文本返回非空。
- `prepack` 串 `build-pkgdocs --in-place`,`postpack` 串 `--restore`——漏跑等于发不出。

## 版本兼容性原则【契约】 ^anc-release-version-compat

（todo/0093,作者定 2026-09-15"应该开始执行版本兼容性原则"——0092 修复后作者追问"spec 和引擎版本不一致怎么办"暴露两方向都无系统防线;方案三轮对焦撤 migrate CLI〔太重〕与 /hop 批量〔用户错位〕两案,终形=零新装置三小件）

**兼容方向承诺**：新引擎必须能跑旧 spec（向后兼容优先）。破坏性收严（既有规则改档升严同算）三义务缺一不可：

1. **决策交代**——实撞驱动的作者拍板或概念层决策,账面可溯（spec-parser 版本行条款 2026-09-15 已扩"改档升严须决策交代"）;
2. **validate 报文带修法**——**报文质量即迁移承诺**:本产品用户形态是"人在 CC/Codex 会话里用",agent 读报文照改是第一迁移路径,报文必须让 agent 零背景照改（既有报文纪律的升格表述）;
3. **迁移知识登记**——旧写法→新写法对照进 hopfix 知识供给面（`/hopfix` 以"新引擎 validate error 清单"为工单即批量迁移通道——三层把关/人批写回/快照回滚全复用,见 [[hopfix]]）+ release note 迁移段（人查半边）。

**版本号语义（0.x 阶段）**：patch=纯修复零行为破坏（release.sh breaking 闸在执行）;minor=可含破坏性收严但必须带齐三义务;1.0 后转正式 semver 承诺。

**spec 声明面**：Config 段 `engine_min_version` 键+引擎 init 闸,契约权威 [[exec-engine#^anc-exec-engine-min-version-gate]];pack 注入面归 [[hop-cli#^anc-cli-pack]]。**反方向不设闸**：不加"最高兼容版本"声明——每次发版都要维护所有存量 spec,成本失衡;该半边由三义务守。

**义务③的机检提醒**：release.sh breaking 闸命中破坏性标记词时,提示文案加一行"若确为破坏性收严:hopfix 迁移知识与 release note 迁移段是发版义务（本节）"——不硬闸（义务完成与否机器判不了）,提醒挂在必经点。
