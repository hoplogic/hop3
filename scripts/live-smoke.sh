#!/bin/bash
# 例行档（design ^anc-driver-live-e2e-entry 三档表;守卫规范 5c ^anc-guard-e2e-tiering）：
# 四 smoke 零/单 LLM,~2min——改引擎后随手跑。并发 4（各自独立零共享面）。
set -u
cd "$(dirname "$0")/.."
LOGDIR=".e2e-evidence/logs"; mkdir -p "$LOGDIR"
echo "═══ live:smoke 例行档（四 smoke,并发;日志→$LOGDIR/）═══"
npm run -s build || exit 1
# 覆盖率测量（作者 2026-08-15"所有的真机测试应该度量总覆盖率"）：HOPJIT_COVERAGE=1 开启——
# NODE_V8_COVERAGE 经 env 传播到全部 node 子进程（CLI/server/子实例各落一份,报告器合并）。
if [ -n "${HOPJIT_COVERAGE:-}" ]; then
  # 覆盖目录必须在系统临时区——codex 沙箱内子进程写不了仓库路径（0.4.0 发版实撞:
  # EPERM 写 .coverage-live-core 混进 stdout 污染 subtask 输出流,demo/delegated 双红）
  export NODE_V8_COVERAGE="$(mktemp -d "${TMPDIR:-/tmp}/hopjit-cov-smoke.XXXXXX")"
  echo "── 覆盖率测量开启 → $NODE_V8_COVERAGE"
fi

run_one() {
  local S="$1"; local SLOG="$LOGDIR/$S.log"
  node "scripts/$S.mjs" >"$SLOG" 2>&1
  local CODE=$?
  case $CODE in
    0) echo "✅ $S"; echo "$S" >>"$LOGDIR/.pass.$$";;
    2) echo "⏭  $S 前置缺失（$(tail -1 "$SLOG" | head -c 80)）"; echo "$S" >>"$LOGDIR/.skip.$$";;
    *) echo "❌ $S 失败 (exit $CODE) → 详情 $SLOG"; echo "$S" >>"$LOGDIR/.fail.$$";;
  esac
}
rm -f "$LOGDIR/.pass.$$" "$LOGDIR/.skip.$$" "$LOGDIR/.fail.$$"
for S in tools-smoke mcp-binding-smoke multi-run-smoke standalone-biginput-live-e2e; do
  run_one "$S" &
done
wait
FAIL=$(cat "$LOGDIR/.fail.$$" 2>/dev/null | tr '\n' ' ')
rm -f "$LOGDIR/.pass.$$" "$LOGDIR/.skip.$$" "$LOGDIR/.fail.$$"
[ -n "$FAIL" ] && { echo "❌ 失败: $FAIL"; exit $(echo $FAIL | wc -w); }
echo "═══ smoke 全绿 ═══"

# 覆盖率报告（HOPJIT_COVERAGE=1 时）
if [ -n "${HOPJIT_COVERAGE:-}" ] && [ -d "$NODE_V8_COVERAGE" ]; then
  node scripts/coverage-report.mjs "$NODE_V8_COVERAGE"
fi
