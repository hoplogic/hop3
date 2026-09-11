#!/bin/bash
# 触发档（design ^anc-driver-live-e2e-entry 三档表）：LLM 质量面——audit 深核 / buildtest hopbuild 自跑 / flash 弱模型长程。
# 贵且不随引擎小改回归,按触发条款跑（改 prompt 组装/doc-ref→audit;改 primer/hopbuild spec/语法→buildtest;改能力门/弱模型协议→flash）。
# 三件并发（2026-08-15 作者拍——共享面复核:三件各自独立 workspace,flash 走 --ephemeral 非 standalone
# 不写全局 config.toml,零共享可变面;总时长≈audit 瓶颈）。可传参选跑: live-deep.sh audit buildtest flash
set -u
cd "$(dirname "$0")/.."
LOGDIR=".e2e-evidence/logs"; mkdir -p "$LOGDIR"
PICK="${*:-audit buildtest flash}"
echo "═══ live:deep 触发档（$PICK;并发;日志→$LOGDIR/）═══"
npm run -s build || exit 1
# 覆盖率测量（作者 2026-08-15"所有的真机测试应该度量总覆盖率"）：HOPJIT_COVERAGE=1 开启——
# NODE_V8_COVERAGE 经 env 传播到全部 node 子进程（CLI/server/子实例各落一份,报告器合并）。
if [ -n "${HOPJIT_COVERAGE:-}" ]; then
  # 覆盖目录必须在系统临时区——codex 沙箱内子进程写不了仓库路径（0.4.0 发版实撞:
  # EPERM 写 .coverage-live-core 混进 stdout 污染 subtask 输出流,demo/delegated 双红）
  export NODE_V8_COVERAGE="$(mktemp -d "${TMPDIR:-/tmp}/hopjit-cov-deep.XXXXXX")"
  echo "── 覆盖率测量开启 → $NODE_V8_COVERAGE"
fi

run_one() {
  local S="$1" CODE
  case "$S" in
    audit)  node scripts/carrier-live-e2e.mjs cc:anchor-audit --launcher claude-ds --credential-env DEEPSEEK_API_KEY >"$LOGDIR/cc-anchor-audit.log" 2>&1;;
    buildtest) node scripts/hopbuild-selftest.mjs >"$LOGDIR/buildtest.log" 2>&1;;
    flash)  node scripts/carrier-live-e2e.mjs codex:flash --profile "${HOPSPEC_E2E_CODEX_FLASH_PROFILE:-deepseek-v4-flash}" >"$LOGDIR/codex-flash.log" 2>&1;;
    *) echo "未知项 $S（可选 audit/buildtest/flash）"; echo "$S" >>"$LOGDIR/.fail.$$"; return;;
  esac
  CODE=$?
  case $CODE in
    0) echo "✅ $S";;
    2) echo "⏭  $S 前置缺失";;
    *) echo "❌ $S (exit $CODE) → $LOGDIR/"; echo "$S" >>"$LOGDIR/.fail.$$";;
  esac
}
rm -f "$LOGDIR/.fail.$$"
for S in $PICK; do
  run_one "$S" &
done
wait
FAIL=$(cat "$LOGDIR/.fail.$$" 2>/dev/null | tr '\n' ' ')
rm -f "$LOGDIR/.fail.$$"
[ -n "$FAIL" ] && { echo "❌ 失败: $FAIL"; exit $(echo $FAIL | wc -w); }
echo "═══ deep 全绿 ═══"

# 覆盖率报告（HOPJIT_COVERAGE=1 时）
if [ -n "${HOPJIT_COVERAGE:-}" ] && [ -d "$NODE_V8_COVERAGE" ]; then
  node scripts/coverage-report.mjs "$NODE_V8_COVERAGE"
fi
