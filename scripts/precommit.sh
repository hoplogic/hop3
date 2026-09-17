#!/bin/bash
# 提交前一键检查（maintainers/RELEASING.md §1 的傻瓜化收拢，2026-08-09 作者要求）
#   ① 暂存区异常规模机判（大批 D = .git/index 出事,红线) ② check:fast ③ 设计先行机检
set -u
cd "$(dirname "$0")/.."

DEL=$(git status --porcelain | grep -c '^.D\|^D' || true)
TOTAL=$(git status --porcelain | wc -l | tr -d ' ')
if [ "$DEL" -gt 50 ]; then
  echo "🛑 暂存区异常：$DEL 个删除标记（共 $TOTAL 条）——疑似 .git/index 损坏/被 iCloud 改名。"
  echo "   先查：ls -la .git/index*   （若只有 index N 副本没有 index → git reset（不带 --hard）重建）"
  echo "   不要继续 commit。"
  exit 1
fi
echo "① 暂存区规模正常（改动 $TOTAL 条，删除 $DEL 条）"

npm run -s check:fast || exit 1
echo "② check:fast 过"

bash scripts/check-design-first.sh HEAD~1..HEAD || exit 1
echo "③ 设计先行过——可以 commit"
