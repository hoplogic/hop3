#!/usr/bin/env bash
# 设计先行机检：检查 git diff 中 src/ 改了但 design/ 没动的跳层嫌疑。
# 用法：./scripts/check-design-first.sh [<commit-range>]
#   无参数：检查 HEAD 与上一次 commit 的 diff（git diff HEAD~1）
#   有参数：检查指定范围（如 HEAD~3..HEAD）
# 返回码：0=通过或无 src 改动，1=跳层嫌疑（src 改了 design 没动）

set -euo pipefail
cd "$(git rev-parse --show-toplevel)" 2>/dev/null || { echo "ERROR: not in a git repo"; exit 2; }

RANGE="${1:-HEAD~1..HEAD}"

# 收集改动文件
CHANGED=$(git diff --name-only "$RANGE" 2>/dev/null || git diff --name-only HEAD 2>/dev/null || echo "")
if [ -z "$CHANGED" ]; then
  echo "✓ 无改动"
  exit 0
fi

# 检查 src/*.ts 是否有改动
# 路径匹配用 (^|/) 前缀而非枚举具体前缀——本脚本可能在不同仓库根深度下运行
# （本库根是 src/，被嵌入更深目录时是 <前缀>/src/）。历史上枚举法曾漏掉一种
# 前缀形态导致所有改动假阴性（2026-07-31 发现），故一律用 (^|/) 免疫根差异。
SRC_CHANGED=$(echo "$CHANGED" | grep -E '(^|/)src/[^/]*\.ts$' || true)
if [ -z "$SRC_CHANGED" ]; then
  echo "✓ src/ 无 .ts 改动，跳过检查"
  exit 0
fi

# 检查 design/ 是否有改动（同上，用 (^|/) 免疫仓库根差异）
DESIGN_CHANGED=$(echo "$CHANGED" | grep -E '(^|/)(docs/)?design/[^/]*\.md$' || true)
if [ -z "$DESIGN_CHANGED" ]; then
  echo "⚠️  跳层嫌疑：src/*.ts 有改动但 design/*.md 未动"
  echo ""
  echo "改动的 src 文件："
  echo "$SRC_CHANGED" | sed 's/^/  /'
  echo ""
  echo "行为宪法红线：改 src/*.ts 前，对应 design/*.md 必须先改定。"
  echo "合理例外：纯测试文件改动、纯重构（不改接口语义）、紧急 hotfix。"
  exit 1
fi

echo "✓ src/ 和 design/ 都有改动"
echo "  src:    $(echo "$SRC_CHANGED" | wc -l | tr -d ' ') 文件"
echo "  design: $(echo "$DESIGN_CHANGED" | wc -l | tr -d ' ') 文件"
exit 0
