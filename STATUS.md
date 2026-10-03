%% @trace
	id: hoplogic-status
	type: intent
	note: 当前状态快照。本文件是唯一"允许并预期会过期"的文档——每个数字都标注测量时间与再生成命令，读者应视其为"上次体检报告"而非实时真值。更新时机：发版前必须、里程碑后应该、日常改动不强求。
%%

# 当前状态 — hoplogic（HOP 官方项目，语言版本 HOP 3.0）

> **快照时间：2026-10-02 01:27 +0800** · 本文件的每个数字都可用旁注的命令**当场再生成**——不确定是否过期时，跑命令为准，别信文件。

## 一句话现状

引擎（HopJIT）双模式稳定可用，npm 已发到 0.18.0;0.19.0 待发——自 0.18.0 起 136 个提交，主线是「/hop 成为唯一用户入口 + 已批准命令按任务卡授权经 MCP 执行」（install-skill 缺省注册 MCP、自动放行、斜杠菜单只留 /hop）,外加 HopSchema 分隔符 `%` 正式写法、spec 快照内容寻址去重、work_zone 沙箱按实例树收口、hoplog 保留上限、非流式长请求不再被 300 秒掐断、模型变速箱五档案（deepseek/qwen/glm/ling flash + qwen3.8-27b）与 hopbuild v1 五模型对照成绩。GitHub 公开快照仓 hoplogic/hop3 逐版同步中。

## 版本

| 项 | 值 | 说明 |
|---|---|---|
| npm 包 | `@hoplogic/hopjit` **0.18.0**（latest,2026-09-26） | `npm view @hoplogic/hopjit version` |
| 本库 package.json | 0.18.0（**0.19.0 待发**——档位 minor:两处破坏性标记词命中〔todo/0124 work_zone 豁免"字面正则退役"〕,且 install-skill 缺省行为变了〔原须 --mcp 才注册,现缺省注册并写项目 `.claude/settings.local.json`〕;patch 档会被 ⑥a breaking 闸拒） | 发版走 `npm run release -- minor`（作者终端） |
| CLI 自报 | 与 package.json 单一事实源（有测试锁住） | `hopjit --version` |

## 链健康度（`npm run check:health` 再生成,2026-10-02 实跑全绿）

| 维度 | 状态 |
|---|---|
| 层内（tsc / 锚点格式 / scripts 语法门 / 3625 测试） | ✅ 全绿 |
| 跃迁（scan + cross_compare + 设计先行 + 版本互锁 + 覆盖率基线） | ✅ 全绿（锚点基线锁 465/445/369,实测 469/448/374 待作者确认上调;src 行 95.33% / 分支 89.52%,基线 92.5% / 87%） |
| 特性（carrier parity / 可执行 spec 16 份） | ✅ 全绿 |
| 真机 e2e | ⏳ 双 delegated 凭证指向 03698453（2026-09-26,0.18.0 发版时）——此后 src/driver 动了 32 个文件,**发版前作者终端重跑 `npm run test:live:core`** 刷凭证,否则 release ④ 步中断 |
| 语义审计 | 全量 15 模块审于 a67d595e（2026-09-30,50 ❌ 已分诊入 todo/0129）;增量范围 11 模块（`node scripts/audit-scope.mjs` 给命令）——发版前按模块跑一轮为宜,不是硬闸 |
| 空白台账 | 见 [[chain-enforcement]] §3 |

## 进行中 / 待决

| 事项 | 状态 | 卡在哪 |
|---|---|---|
| 0.19.0 发版 | README/STATUS 已刷;check:health 全绿 | **作者终端**:①`npm run test:live:core` 刷双凭证 ②`npm run release -- minor` ③接 §6 同步 GitHub 快照 |
| 锚点基线上调 469/448/374 | 机检"未变差且有改善" | 作者确认后改 `audits/baselines/anchor-baseline.json` |
| todo/0134 opencode MCP 注册缺省 enabled:false | run_approved_command 在 opencode 上不可达 | 待作者拍缺省改不改 |
| todo/0131 复用模式配置两级合并 | 作者已拍形态 1（新建配置模块） | 下一批开工 |
| todo/0133 anchor-audit 基线只比 11 个数字 | 孤儿锚/缺卡明细增量不入比对 | 排期 |
| todo/0135 hopbuild2 终审意见含头部契约项整份判败 | 无识别回问机制 | 排期 |
| hopissues 待修 | 0069（skillsrepo 语料优化 hopbuild 保真）/ 0113（hopbuild2 拆步派生语义悬空） | open,无 high |
| 活跃 todo 卡 | 38 张（`ls todo/*_open.md \| wc -l`） | — |

## 明确的 v1 偏差（设计承诺未实现，已显式标注）

- **pause-timeout 整节**：`timeout_seconds` 写在 spec 里会被 parser 静默忽略；paused 永久有效（此为正确默认行为）。补全涉及 AST 字段 + `paused_at` + `cancelled` 终态（包级破坏性变更须人拍板）。详见 `docs/design/step-dispatcher.md` v1 偏差块。
- **HopSchema 冒号分隔符**：仍被接受但出 W2 弃用告警,1.0 起报错（决策档 todo/decision/20260927-冒号弃用时间表.md）;迁移命令 `hopjit schema-sep <spec>`。
- 其余技术债见 `todo/` 目录。

## 本库与上下游

```
维护者工作区（库外，概念层与工程演进的源）
   │  单向同步（概念快照 → docs/concepts/；工程演进 → 本库）
   ▼
hoplogic3（本库，内网唯一真源，全新历史 2026-08-02 起）
   │  npm publish                    │  scripts/github-publish.sh（一版一快照提交）
   ▼                                 ▼
@hoplogic/hopjit（npm registry）    github.com/hoplogic/hop3（公开快照）
```

## 更新本文件的时机

- **必须**：每次发版前（数字全部重测）；
- **应该**：里程碑收口后;
- **不强求**：日常提交。过期不是罪——**冒充最新才是**（所以每个数字都带再生成命令）。
