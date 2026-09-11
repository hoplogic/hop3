#!/bin/bash
# 发版档（design ^anc-driver-live-e2e-entry 三档表）：10 快乐路径 + 6 失败路径,并发 5,~10min。
# 凭证判据不变（硬闸仍只看 cc/codex delegated 双绿且指向 HEAD）。flash 已迁 deep（LLM 质量面）。
set -u
cd "$(dirname "$0")/.."
LOGDIR=".e2e-evidence/logs"; mkdir -p "$LOGDIR"
RUNLOG="$LOGDIR/run-$(date +%Y%m%dT%H%M%S).summary.txt"
CONC="${HOPSPEC_E2E_CONCURRENCY:-5}"
echo "═══ live:core 发版档（16 场景,并发 $CONC;日志→$LOGDIR/）═══"
npm run -s build || exit 1
# 覆盖率测量（作者 2026-08-15"所有的真机测试应该度量总覆盖率"）：HOPJIT_COVERAGE=1 开启——
# NODE_V8_COVERAGE 经 env 传播到全部 node 子进程（CLI/server/子实例各落一份,报告器合并）。
if [ -n "${HOPJIT_COVERAGE:-}" ]; then
  # 覆盖目录必须在系统临时区——codex 沙箱内子进程写不了仓库路径（0.4.0 发版实撞:
  # EPERM 写 .coverage-live-core 混进 stdout 污染 subtask 输出流,demo/delegated 双红）
  export NODE_V8_COVERAGE="$(mktemp -d "${TMPDIR:-/tmp}/hopjit-cov-core.XXXXXX")"
  echo "── 覆盖率测量开启 → $NODE_V8_COVERAGE"
fi

# 两波互斥（^anc-driver-live-e2e-concurrency ⑤,2026-08-14 并发首跑实撞）：codex:standalone 系
# 持久注册 hopjit MCP 到用户全局 config.toml——并发的 codex:delegated 看见邻居注册按 skill §0
# 正确锁 STANDALONE→delegated 断言红。波 1=非 standalone 系并发,波 2=standalone 系。
WAVE1="cc:delegated codex:delegated codex:demo cc:standalone cc:parallel codex:parallel cc:call cc:repair cc:adaptive cc:uncaught cc:parallel-partial cc:paused cc:call-fail"
WAVE2="codex:standalone codex:standalone-parallel"

run_one() {
  local S="$1"
  local SLOG="$LOGDIR/$(echo "$S" | tr ':' '-').log"
  case "$S" in
    cc:*)   # 全部 cc 场景走 claude-ds（zenmux 环境裸 claude 401——2026-08-08 实撞,作者定）
      node scripts/carrier-live-e2e.mjs "$S" --launcher claude-ds --credential-env DEEPSEEK_API_KEY >"$SLOG" 2>&1;;
    codex:standalone)
      node scripts/carrier-live-e2e.mjs "$S" --profile "${HOPSPEC_E2E_CODEX_FLASH_PROFILE:-deepseek-v4-flash}" --credential-env DEEPSEEK_API_KEY >"$SLOG" 2>&1;;
    *)
      node scripts/carrier-live-e2e.mjs "$S" >"$SLOG" 2>&1;;
  esac
  local CODE=$?
  case $CODE in
    0) echo "✅ $S"; echo "$S" >>"$LOGDIR/.pass.$$";;
    2) echo "⏭  $S 前置缺失（$(tail -1 "$SLOG" | head -c 80)）"; echo "$S" >>"$LOGDIR/.skip.$$";;
    *) echo "❌ $S 失败 (exit $CODE) → 详情 $SLOG"; echo "$S" >>"$LOGDIR/.fail.$$";;
  esac
}
rm -f "$LOGDIR/.pass.$$" "$LOGDIR/.skip.$$" "$LOGDIR/.fail.$$"
for S in $WAVE1; do
  while [ "$(jobs -rp | wc -l)" -ge "$CONC" ]; do sleep 1; done
  run_one "$S" &
done
wait
# 波 2 串行（两 standalone 场景各自 register(先 remove 再 append)同一锚定块——并发时 A 的注册
# 被 B 覆盖,HOPJIT_CONFIG 指向对方临时配置;同波也互斥,串行跑）:
for S in $WAVE2; do
  run_one "$S"
done
PASS=$(cat "$LOGDIR/.pass.$$" 2>/dev/null | tr '\n' ' ')
SKIP=$(cat "$LOGDIR/.skip.$$" 2>/dev/null | tr '\n' ' ')
FAIL=$(cat "$LOGDIR/.fail.$$" 2>/dev/null | tr '\n' ' ')
rm -f "$LOGDIR/.pass.$$" "$LOGDIR/.skip.$$" "$LOGDIR/.fail.$$"
{
echo ""
echo "═══ 汇总 ═══"
[ -n "$PASS" ] && echo "✅ 通过: $PASS"
[ -n "$SKIP" ] && echo "⏭  前置缺失(exit 2): $SKIP"
[ -n "$FAIL" ] && echo "❌ 失败: $FAIL"
echo ""
echo "发版硬闸凭证状态（release.sh ④ 只看这两个）："
for EV in cc-delegated codex-delegated; do
  F=".e2e-evidence/$EV.json"
  if [ -f "$F" ]; then
    echo "  $EV: $(node -e "const e=require('./$F');console.log(e.commit.slice(0,8)+' @ '+e.passed_at)")"
  else
    echo "  $EV: 无凭证"
  fi
done
} | tee "$RUNLOG"
exit $(echo $FAIL | wc -w)

# 覆盖率报告（HOPJIT_COVERAGE=1 时）
if [ -n "${HOPJIT_COVERAGE:-}" ] && [ -d "$NODE_V8_COVERAGE" ]; then
  node scripts/coverage-report.mjs "$NODE_V8_COVERAGE"
fi
