%% @trace
	id: hopjit-ci-pipeline
	source: [[../concepts/工程实现链规范]]
	source_id: engineering-chain-spec
	type: extend
	last_sync: 2026-08-06T15:20+0800
	note: CI/CD 流程设计——三关口（pre-commit / GitHub Actions / prepublishOnly）× 检查分级 × 基线锁定策略；补充带凭证、带费用的 carrier live E2E opt-in 关口。
%%

# CI/CD 流程设计（自动化载体选型）

> **⚠️ 本文是从属文档，不是主线**。主线是 [[chain-enforcement]]——它按**实现链的结构**组织全部守卫（链的每一环由谁守、三类守卫的性质差异、空白清单、该在什么时机守什么）。本文只回答一个更窄的问题：**那张"时机→守什么"表用什么自动化载体执行**（本地 hooks / GitHub Actions / npm 生命周期）。
>
> 先读 [[chain-enforcement]] 建立全局，再读本文选载体。**若只读本文会得到倒置的图景**——把"有哪些工具、怎么分配到关口"当成问题本身，而真问题是"这条链凭什么不腐坏"。
>
> **状态：决策 3/4 已拍板（2026-08-03），基线锁定与 hooks 已实施**；决策 1（GitHub 可见性与仓库名）已定案（2026-09-11:仓 hoplogic/hop3,private 起步核对后转 public,全新快照史——决策档案 todo/decision/20260911）。

## 文档结构与内容分级

| 分级 | 含义 |
|---|---|
| **【决策】** | 需作者拍板的选择（本文 §1 集中列出，含备选与倾向） |
| **【契约】** | 拍板后即固定的规则，带 `^anc-*` 锚点 |
| **【说明】** | 配置示例、命令清单 |

| 章节 | 分级 | 锚点 |
|---|---|---|
| 待拍板决策点 | 决策 | — |
| 三关口分工 | 契约 | `anc-meta-ci-gates` |
| 检查清单与分级 | 契约 | `anc-meta-ci-checks` |
| 基线锁定策略 | 决策+契约 | `anc-meta-ci-baseline` |
| 实施阶段 | 说明 | — |
| 待补：发版流程收口 | 说明 | — |

---

## 1. 待拍板决策点【决策】

### 决策 1·仓库位置与可见性【决策：原则性——2026-09-04 作者裁延拍】

> **延拍（2026-09-04 /hop 决策会话,作者选"不拍,需求出现再议"）**：决策前提（要上 GitHub Actions）尚未成为现实需求——内网仓库无 CI 也运转正常（本地 pre-commit+npm run check 兜底）,外向难收回的决策不提前拍。**触发条件：真要上 GitHub CI 时重开本决策,重开时以 todo/decision/20260904-GitHub仓库可见性延拍.md 为底**（含当年没有的新变量:决策档案机制公开面）。下方原文留档。



npm 包已是 `@hoplogic/hopjit`，scope 与组织名对齐。仓库位置顺理成章是 `github.com/hoplogic/<repo>`，剩可见性一项：

| 备选 | 后果 |
|---|---|
| **private**（原倾向，独立建库后需重估） | Actions 免费额度 2000 分钟/月（本工程单次 ~1 分钟，绰绰有余）；设计文档、v1 偏差、踩坑记录不公开 |
| **public** | Actions 无限；npm 包用户可读源码/设计/examples，issue 与 PR 通道打开 |

**独立建库改变了权衡**：本库（113 个 md）已按"可发布"标准收拾过——概念层只放受控快照（×10），无意图稿、无未发布稿件、无私有工作区回引。原先"半成品与资产混杂、公开无法收回"的顾虑大部分已被库边界消解；剩下的实质差异是**设计文档与踩坑记录是否示人**。**待作者定**。

### 决策 2·推送范围【已被独立建库消解，留档】

原问题是"从私有工作区推哪个子集"——只推引擎会丢概念层、废掉 S→D 机检；推整个工作区又混入无关内容。**2026-08-02 独立建库后此问题不复存在**：本库本身就是推送单元，概念→设计→代码→测试四层齐全，anchor-audit 全维度可跑，无需再选。

### 决策 3·anchor-audit 门槛【已拍板 2026-08-03：基线锁定】

**拍板结果**：基线锁定（作者确认）。同时确立后续路线：扫描器多落点扩展 + 无效引用清零为独立专项，清零后基线降 0——严格门槛是基线锁定的终点形态，不是替代品。

**拍板时现状**（2026-08-03 实测，锚定 822b031）：

| 指标 | 当前 |
|---|---|
| 命名违规 | 0 ✅ |
| 模块边界违规 / 出口注释违规 | 0 / 0 ✅ |
| 无效引用 | **27** |
| 状态标记问题 | **36** |
| 设计→代码覆盖 | 185/207 |
| 代码→测试覆盖 | 189/204 |
| 代码→追溯覆盖 | 181/204 |

| 备选 | 后果 |
|---|---|
| 只报告不挡（warning） | 最宽松，但等于无约束——正是当前"检查存在不执行"的等价物 |
| **基线锁定：不许变差**（倾向） | 记下上表数字入库，CI 比对：新增违规即红，修好则更新基线。既不阻塞当下，又杜绝继续腐坏 |
| 严格挡（必须全 0） | 需先修完 27+32 处才能启用 CI——**会阻塞数天**，且其中多数已定性为"落点性质差异"非真缺陷 |

**理由**：27 处无效引用里已定性的部分（driver 层落点、模块锚点走 `@module:`、类型声明）不是真缺陷，强制立即归零会诱发**为指标而改代码**；且结构性误报（scripts/、driver/ 落点不在扫描模型内）不扩展扫描器修不掉。基线锁定守住"不再变差"底线，真缺陷（新增断链）照样红。

### 决策 4·hooks 强制力【已拍板 2026-08-03：按倾向执行】

本地 hook 可被 `--no-verify` 绕过，这是 git 的既定行为。

| 备选 | 说明 |
|---|---|
| **hooks 只跑快检查（≤3s），慢检查交 CI**（倾向） | pre-commit 跑 tsc + 2 lint（实测 2s + <1s）；测试与 anchor-audit 交 Actions。**慢 hook 必被绕过**——人烦到 `--no-verify` 就全废 |
| pre-commit 跑全套 | 每次提交等 ~15s，实践中会被绕过 |

**拍板结果**：按倾向执行——pre-commit 只跑 `check:fast`（≤3s），慢检查交 CI。

---

## 2. 三关口分工【契约】 ^anc-meta-ci-gates

同一批检查按**耗时与阻断成本**分配到三个关口，不重复也不遗漏：

| 关口 | 触发时机 | 跑什么 | 目标耗时 | 阻断力 |
|---|---|---|---|---|
| **pre-commit**（本地 hook） | 每次 `git commit` | `tsc --noEmit` + `check-anchor-format` + `check-driver-carriers` | ≤3s | 可 `--no-verify` 绕过（接受） |
| **GitHub Actions** | push / PR | 全套（见 §3） | ≤2min | **硬挡**（PR 红灯不合并） |
| **prepublishOnly** | `npm publish` | 全套 + `npm pack` 清单核对 | ≤2min | **硬挡**（发版失败） |

**为何 prepublishOnly 也要跑全套**：发版是**不可逆外向操作**（npm 版本号不可复用）。0.1.1 那次 CLI 自报版本号错就是从这个关口漏出去的——当时 `prepublishOnly` 只跑 `clean && tsc`，测不到版本号脱节（那时也没有 `--version` 测试）。

**为何 hooks 用 `core.hooksPath` 入库**：`.git/hooks/` 不随仓库分发，换机器/他人 clone 即失效。改用入库目录 + `git config core.hooksPath .githooks`，hook 脚本进版本管理、可审计、可演进。

## 3. 检查清单与分级【契约】 ^anc-meta-ci-checks

| # | 检查 | 命令 | 耗时 | 关口 | 现状 |
|---|---|---|---|---|---|
| 1 | 类型检查 | `npx tsc --noEmit` | ~2s | 全部 | ✅ 绿 |
| 2 | 锚点格式（前必须空格） | `node scripts/check-anchor-format.mjs` | <1s | 全部 | ✅ 绿 |
| 3 | Codex carrier 静态纪律 | `node scripts/check-driver-carriers.mjs` | <1s | 全部 | ✅ 绿 |
| 4 | 单元/集成测试 | `npx vitest run` | ~8s | CI + 发版 | ✅ 872/872 |
| 5 | 设计先行 | `./scripts/check-design-first.sh <range>` | <1s | CI（PR 的 commit 范围） | ✅ 绿（2026-08-01 修了路径假阴性） |
| 6 | 锚点全量审计 | `scan.py` + `cross_compare.py` | ~3s | CI（基线比对） | ⚠️ 27 无效引用 / 32 状态问题 |
| 7 | 包清单核对 | `npm pack --dry-run` | ~5s | 发版 | 待接入 |

**统一入口**（`package.json` 新增 scripts，供人和 CI 共用同一套命令，杜绝"CI 跑的和本地跑的不一样"）：

```jsonc
"check:fast":  "npm run -s check:types && node scripts/check-anchor-format.mjs && node scripts/check-driver-carriers.mjs",
"check:types": "tsc --noEmit",
"check:audit": "node scripts/check-anchor-baseline.mjs",   // 新建，见 §4
"check":       "npm run -s check:fast && npm test && npm run -s check:audit"
```

## 4. 基线锁定策略【决策+契约】 ^anc-meta-ci-baseline

> 决策 3 已拍板基线锁定（2026-08-03），本节即实施契约。

**机制**：基线数字入库为 `audits/baselines/anchor-baseline.json`，新建 `scripts/check-anchor-baseline.mjs` 跑扫描并比对：

- **变差 → exit 1**（如无效引用 27→28）：报出新增项，红灯；
- **变好 → exit 0 + 提示更新基线**（如 27→25）：不自动改基线文件（避免"悄悄放松"），提示人确认后更新；
- **持平 → exit 0**。

**基线文件**：`audits/baselines/anchor-baseline.json`（2026-08-03 实测，锚定 `_baseline_commit`）。字段：`naming_violations`(0，不许回升)、`invalid_refs`(27)、`status_issues`(36)、`module_deps_mismatch`(1)、三个覆盖分子下限 `*_covered_min`(185/189/181——分母随新锚点变化，故只锁分子下限)。

**已归零项的特殊地位**：命名违规 / 模块边界 / 出口注释三项已修到 0，基线设 0 意味着**任何回升都红**。这是本次审计成果的锁定——防止再次腐坏。

## 5. 实施阶段【说明】

按工程实现链，设计（本文）→ 配置 → 验证 → 上远程：

| 阶段 | 内容 | 产物 |
|---|---|---|
| **A. 本文拍板** | 作者定 §1 决策 1/3/4 | 本文标注决策结果，锚点转【契约】 |
| **B. 本地配置** | `package.json` scripts；`.githooks/pre-commit` + `core.hooksPath`；`scripts/check-anchor-baseline.mjs` + 基线文件 | 本地 `npm run check` 全绿 |
| **C. Actions 配置** | `.github/workflows/ci.yml`（node 20/22 矩阵、npm ci、跑 `npm run check`、PR 范围跑 check-design-first） | 配置文件（未生效，无远程） |
| **D. 上远程**（需作者执行） | `gh repo create` + `git remote add` + `git push`；观察首次 Actions 运行 | 远程仓库 + 首次 CI 结果 |
| **E. 收口** | `prepublishOnly` 扩为跑全套 + pack 核对；README 加 CI 状态徽章（若 public） | 发版关口守住 |

**D 阶段必须由作者执行**：创建远程仓库 + 首次 push 是**不可逆外向操作**（代码离开本机、GitHub 有缓存/爬虫），且需要作者的 GitHub 凭证。Agent 准备命令，作者按下。

## 6. 发版流程收口【说明·已销账】

已固化为 `scripts/release.sh` 检查单（G5 守卫，断点续跑/幂等/远端核验）+ `RELEASING.md` 操作手册——0.1.2 四坑（version 脏区静默跳过/publish 认证中断静默不发/global prefix 漂移需 hash -r/~/.npm root 文件 EPERM）与 0.1.5 资产时点坑、0.1.6 登录态坑全部固化进脚本。2026-08-08 增 ④ E2E 终点凭证硬闸（见 §7）。

## 7. Carrier Live E2E【契约】 ^anc-meta-ci-carrier-live

[[carrier-live-e2e#^anc-driver-live-e2e-entry]] 定义的真实 CC/Codex 测试不进入默认 PR `check`：它依赖外部 provider、消耗模型费用且存在服务波动。自动化载体固定为：

- 本地：开发者显式运行对应 `npm run test:e2e:*`。
- CI：仅手动触发或 protected environment job；secret 只注入进程环境。
- 发版：**机检硬闸而非检查单条目**——release.sh ④ 核验 `.e2e-evidence/` 两份凭证在场且指向 HEAD（[[carrier-live-e2e#^anc-driver-live-e2e-evidence]]），缺/过期即中断；改过 fallback 时另跑 Codex inline。

“opt-in”只控制 job 是否被调度，不改变 job 内语义。job 一旦启动，缺 secret/命令/配置必须 exit 2 失败，禁止 `if: secret != ''` 把缺凭证显示为 skipped 或 success。
