%% @trace
	id: hoplogic-status
	type: intent
	note: 当前状态快照。本文件是唯一"允许并预期会过期"的文档——每个数字都标注测量时间与再生成命令，读者应视其为"上次体检报告"而非实时真值。更新时机：发版前必须、里程碑后应该、日常改动不强求。
%%

# 当前状态 — hoplogic（HOP 官方项目，语言版本 HOP 3.0）

> **快照时间：2026-08-15 18:49 +0800** · 本文件的每个数字都可用旁注的命令**当场再生成**——不确定是否过期时，跑命令为准，别信文件。

## 一句话现状

引擎（HopJIT）双模式可用且已发布 npm（0.3.0 已发;0.4.0 待发——i18n 中文关键词双语直通全案+V2b/类型名/关键词三道保留字闸+parser-fuzz 五不变量守卫+覆盖率测量双通道+BUG-F/G/H/I 四修+hopbuild 六原则分步作业序+真机三档收敛+文档译本 en×20）;机检守卫体系持续扩编（新增 parser-fuzz/i18n-staleness/coverage-report 三件）;源码仓库 GitHub 公开发布中（github.com/hoplogic/hop3）。

## 版本

| 项 | 值 | 说明 |
|---|---|---|
| npm 包 | `@hoplogic/hopjit` **0.3.0**（latest,2026-08-14——call 协议收敛/类型保留字/BUG-F/G/H/mock 盲区守卫批） | `npm view @hoplogic/hopjit version` |
| 本库 package.json | 0.3.0（**0.4.0 待发**——档位 minor:V2b/关键词保留字对已发布英文面是行为收紧〔0.3.0 用户写 `+ → reason` 从绿变红〕;中文关键词/i18n 全属纯增量） | 发版走 `npm run release -- minor`（作者终端） |
| CLI 自报 | 与 package.json 单一事实源（有测试锁住） | `hopjit --version` |

## 链健康度（`npm run check:health` 再生成）

| 维度 | 状态 |
|---|---|
| 层内（tsc / 锚点格式 / scripts 语法门 / 1611 测试） | ✅ 全绿 |
| 跃迁（scan + cross_compare + 设计先行 + 版本互锁 + 覆盖率基线） | ✅ 全绿（基线锁 285/275/232） |
| 特性（carrier parity / 可执行 spec / parser-fuzz 五不变量 / i18n 滞后死链） | ✅ 全绿（fuzz 已知盲区 22 条入台账棘轮,双语等价全语料 0 违约） |
| 真机 e2e | ⏳ 0.4.0 发版凭证待刷（凭证指向 0.3.0 期 HEAD 已过期——发版前作者终端跑 `HOPJIT_COVERAGE=1 npm run test:live:core` 刷双 delegated+顺带首份真机覆盖率;smoke+primer failed-only 同批） |
| 空白台账 | 见 [[chain-enforcement]] §3;fuzz 盲区分诊账 ^todo-parser-fuzz-triage（全角冒号形态高优） |
| 覆盖率 | 设计→代码 285 · 代码→测试 275 · 代码→追溯 232（棘轮下限,勿当质量分直读）· src 行 92.65%/分支 87.30% 基线绿 · fuzz 目标面 68.9%（`npm run fuzz:parser:cov`） |

## 进行中 / 待决

| 事项 | 状态 | 卡在哪 |
|---|---|---|
| 0.4.0 发版 | 前置全绿（check 全链/覆盖率基线/spec-syntax/断言重放 51 份）;STATUS 已刷 | **作者终端**:①`HOPJIT_COVERAGE=1 npm run test:live:core` 刷双凭证②`npm run release -- minor` |
| BUG-I 恢复丢工具面 | ✅ A+B 双修入库（config_project_dir 钉根+恢复预检响亮拒） | 真机核证待 hopkb（tidy 类 run 真重启 resume） |
| hopbuild 原则体系 | ✅ 三焦点+六原则+分步作业序（§2b ask/§2c retry 反思闭环五关） | 实效核证:真实 NL skill 翻一次看步骤量级 |
| 上 GitHub 公开发布 | 已定案:仓 hoplogic/hop3,private 起步核对后转 public,全新快照史 | **进行中**（内部协同卡跟踪） |
| 真机 E2E 矩阵 | ✅ 三批全绿（e2e:all 九场景/audit/failure）；语义审计增量机制上线（audit-scope.mjs 台账×diff 自动推范围） | P0-1 错误 envelope 待定型；G13/G14 守卫实装待开工 |
| pre-commit hooks | ✅ 已激活（2026-08-04 core.hooksPath 配置完成，每次 commit 自动跑 check:fast） | — |
| 发版检查单（G5） | ✅ 已销账：`npm run release`（scripts/release.sh 十步——脏区/全检/覆盖率/tarball 资产核对/version/publish/全局更新/版本核验/装 skill/推送+tag） | — |
| 概念层源侧同步 | ✅ 已销账（2026-08-03）：源侧 HopStep 改名/锚点空格/scratch-dir 失效锚点均已 commit，三份快照已重取 | — |

## 明确的 v1 偏差（设计承诺未实现，已显式标注）

- **pause-timeout 整节**：`timeout_seconds` 写在 spec 里会被 parser 静默忽略；paused 永久有效（此为正确默认行为）。补全涉及 AST 字段 + `paused_at` + `cancelled` 终态（包级破坏性变更须人拍板）。详见 `docs/design/step-dispatcher.md` v1 偏差块。
- 其余技术债见 [[TODO]] 九要素债册。

## 本库与上下游

```
维护者工作区（库外，概念层与工程演进的源）
   │  单向同步（概念快照 → docs/concepts/；工程演进 → 本库）
   ▼
hoplogic3（本库，发布库，全新历史 2026-08-02 起）
   │  npm publish
   ▼
@hoplogic/hopjit（npm registry）
```

## 更新本文件的时机

- **必须**：每次发版前（数字全部重测）；
- **应该**：里程碑收口后（如 Codex E2E 通过、上远程完成）;
- **不强求**：日常提交。过期不是罪——**冒充最新才是**（所以每个数字都带再生成命令）。
