// vitest 面配置：editors/ 的插件测试走各自目录内 node:test（依赖面隔离,design obsidian-plugin
// ^anc-viz-plugin-layout）——vitest 缺省 include 会把它误当 vitest 套件收（No test suite 红）。
// 只排 editors/ 不收窄其余（examples/e2e-audit-fixture/tests 是审计判据回归面,保持在根测试内）。
// @a: anc-viz-plugin-layout
import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // .release-wt/ 是发版断点续发的冻结快照区（.gitignore 长住）——缺省 include 会把快照里的
    // tests/ 整棵重复收进全量（2026-09-06 review 实锤:仓库根裸跑 5593=主区 2852+快照 2741,
    // 凭证数字失真一倍且快照区将来假红干扰判读）。
    exclude: [...configDefaults.exclude, 'editors/**', '.release-wt/**'],
    // 超时线 5s→20s（2026-09-04 作者定"改timeout吧"——发版全量当日五撞偶发超时：
    // cli.test/guard-scripts/tools-mcp-binding 三套件起真子进程（fork+加载完整 CLI/守卫脚本），
    // 多 agent 并发是本库常态工作方式，负载高峰下 fork 挤过 5s 线纯环境抖动——2732 用例全绿
    // 仍被单个 timeout 拦发版。20s 只兜子进程启动抖动，真死锁类用例仍会红（原 5s 下它们
    // 本就毫秒级完成，放宽不掩真病）。
    testTimeout: 20000,
    // 收尾钩子超时同线放宽。注意它管不到工作进程回报进度的通信超时（vitest 内置 60 秒,不可配）——
    // 那个报错的真因是同步起子进程的用例把事件循环占住,由下面的 setupFiles 治。
    teardownTimeout: 20000,
    // 每个用例后让出一次事件循环,防 onTaskUpdate 回报排队超时（测试全过却退出码 1）。
    // 设计权威 docs/design/chain-enforcement.md ^anc-meta-guard-trust 第 5 条。
    setupFiles: ['tests/setup/yield-event-loop.ts'],
    // 覆盖率分母同排 editors/——插件源在自己目录内测（node:test），根 vitest 不跑它，
    // 留在分母=以 0% 计入拉低引擎覆盖率（0.4.0 发版实撞:基线闸误红,引擎本体实际在基线上）
    coverage: {
      exclude: [...(configDefaults.coverage.exclude ?? []), 'editors/**'],
    },
  },
});
