%% @trace
	id: hopjit-release-engineering
	source: [[chain-enforcement]]
	source_id: hopjit-chain-enforcement
	type: intent
	last_sync: 2026-09-26T04:09+0800
	note: 发版工程设计——快照制（release 启动冻结 commit，全部检查与发布对着快照 worktree 跑）。G5 检查单（scripts/release.sh）与 GitHub 公开快照发布（scripts/github-publish.sh）的行为权威；chain-enforcement §8 的 release 闸行是其守卫映射。
%%

# 发版工程——快照制（release snapshot）

**给谁**：改 `scripts/release.sh` 的人（agent 或维护者）。逐次操作归维护者操作手册（内部维护面,不随快照分发,人每次发版照走）；本文是行为权威——脚本怎么改、为什么这么定，冲突以本文为准。

## 文档结构与内容分级

| 分级 | 节 |
|---|---|
| 【决策】 | 为什么要快照制（实撞史与作者对焦） |
| 【契约】 | 快照制五条款（^anc-release-snapshot）/ 发布防线四断言（^anc-release-boundary-guards）/ GitHub 公开快照发布（^anc-release-github-snapshot） |
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

## 版本兼容性原则【契约】 ^anc-release-version-compat

（todo/0093,作者定 2026-09-15"应该开始执行版本兼容性原则"——0092 修复后作者追问"spec 和引擎版本不一致怎么办"暴露两方向都无系统防线;方案三轮对焦撤 migrate CLI〔太重〕与 /hop 批量〔用户错位〕两案,终形=零新装置三小件）

**兼容方向承诺**：新引擎必须能跑旧 spec（向后兼容优先）。破坏性收严（既有规则改档升严同算）三义务缺一不可：

1. **决策交代**——实撞驱动的作者拍板或概念层决策,账面可溯（spec-parser 版本行条款 2026-09-15 已扩"改档升严须决策交代"）;
2. **validate 报文带修法**——**报文质量即迁移承诺**:本产品用户形态是"人在 CC/Codex 会话里用",agent 读报文照改是第一迁移路径,报文必须让 agent 零背景照改（既有报文纪律的升格表述）;
3. **迁移知识登记**——旧写法→新写法对照进 hopfix 知识供给面（`/hopfix` 以"新引擎 validate error 清单"为工单即批量迁移通道——三层把关/人批写回/快照回滚全复用,见 [[hopfix]]）+ release note 迁移段（人查半边）。

**版本号语义（0.x 阶段）**：patch=纯修复零行为破坏（release.sh breaking 闸在执行）;minor=可含破坏性收严但必须带齐三义务;1.0 后转正式 semver 承诺。

**spec 声明面**：Config 段 `engine_min_version` 键+引擎 init 闸,契约权威 [[exec-engine#^anc-exec-engine-min-version-gate]];pack 注入面归 [[hop-cli#^anc-cli-pack]]。**反方向不设闸**：不加"最高兼容版本"声明——每次发版都要维护所有存量 spec,成本失衡;该半边由三义务守。

**义务③的机检提醒**：release.sh breaking 闸命中破坏性标记词时,提示文案加一行"若确为破坏性收严:hopfix 迁移知识与 release note 迁移段是发版义务（本节）"——不硬闸（义务完成与否机器判不了）,提醒挂在必经点。
