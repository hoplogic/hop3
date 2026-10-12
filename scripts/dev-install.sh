#!/bin/sh
# 开发期一条命令：重建 dist + 从本库源同步刷新 CC 与 Codex 两套用户级 skill（--force）。
# 引擎（dist）与两套 driver 一起刷新，消除"源码新、安装副本旧"撕裂。
# 用法：npm run dev:install                    （默认装到 ~/.claude/skills）
#      ./scripts/dev-install.sh [目标skills目录]
# 演示件已改为 HopAnt（2026-10-06）：setup 缺省装进 ~/.hopjit/ants/,已装的不覆盖。
# --demo 仍接受但不起作用（与 setup 的隐藏兼容别名同口径,保留一个版本周期）。
set -e
cd "$(dirname "$0")/.."
TARGET="$HOME/.claude/skills"
for arg in "$@"; do
  case "$arg" in
    --demo) : ;;
    --*)    echo "❌ 未知参数: $arg -- 只支持目标目录"; exit 2 ;;
    \#*)
      # 防呆：终端复制文档命令时行尾 '# 注释' 被 zsh 当参数传入（zsh 交互式默认不认注释），
      # '#' 曾被当目标目录建出 'hoplogic3/#/'（2026-08-06 实撞）。拒绝并给出提示。
      echo "❌ 收到 '#' 开头的参数: $arg -- 像是复制命令时把行尾注释一起带上了，去掉 '# ...' 部分重跑"; exit 2 ;;
    *)      TARGET="$arg" ;;
  esac
done

# 自愈初始化：缺什么补什么（幂等，日常跑零开销）
if [ ! -d node_modules ]; then
  echo "◦ node_modules 缺失，npm install ..."
  npm install
fi

echo "① 重建 dist ..."
npm run -s build

# 全局命令软链到本库（探测命中即开发版引擎）；已 link 到本库则跳过
# readlink -f 解到底（bin 软链是两级：bin/hopjit → lib 包目录 → 本库；单级 readlink 拿到
# 相对路径恒不匹配 → 每次都误判"未链"重跑 npm link → link 删旧建新窗口反复打开,并发时
# bin 软链短暂消失——2026-08-09 实撞:\$coffee-week 误报"未安装",重装后恢复）
LINKED=$(readlink -f "$(command -v hopjit 2>/dev/null)" 2>/dev/null || true)
case "$LINKED" in
  "$(pwd -P)"/*) : ;;  # 已指向本库（物理路径比对）
  *)
    echo "◦ 全局 hopjit 未链到本库（当前指向: ${LINKED:-无}），npm link ..."
    npm link || echo "  ⚠️ link 失败（权限/环境）——不影响 skill 安装；skill 的 cli-discovery 会探测到全局 npm 版引擎，想用开发版引擎请手动在本仓库跑一次 npm link"
    ;;
esac

echo "② 装 skill（源=本库最新 driver/）..."
# 给人看的输出用 CLI 缺省 YAML（--json 只给机器消费方，2026-08-09 作者指正）
# 演示 HopAnt 由 setup 缺省装（已装的跳过——要刷新演示件先 hopjit ant remove <id>）
# 不带 --carrier / --dir：setup 自动探测本机在场的全部载体逐个装（cc / codex / opencode / cfuse-cc / cfuse-codex,
# ^anc-cli-carrier-autodetect）——原先只跑 cc 与 codex 两条,cfuse 与 opencode 的 skill 与 MCP 注册从没刷过（todo/0158 第一块,2026-10-11）。
# 显式传了目标目录（TARGET 非缺省）才按旧形态只装到那个目录。
if [ "$TARGET" = "$HOME/.claude/skills" ]; then
  node dist/cli.js setup --force
else
  node dist/cli.js setup --dir "$TARGET" --force
fi

# ③ 版本核对（自动比对，人不用再敲 hopjit --version）
PKGV=$(node -p "require('./package.json').version")
BINV=$(hopjit --version 2>/dev/null || echo "不可用")
echo ""
echo "═══ 版本核对 ═══"
echo "  本库 package.json : $PKGV"
echo "  全局 hopjit       : $BINV"
# 每个在场载体的 skill 版本戳各读一行（载体 home 与 setup 同一解析:cc ~/.claude、codex ~/.codex、opencode ~/.config/opencode、cfuse ~/.codefuse/engine/{cc,codex}）
for pair in "cc:$TARGET" "codex:$HOME/.codex/skills" "opencode:$HOME/.config/opencode/skills" "cfuse-cc:$HOME/.codefuse/engine/cc/skills" "cfuse-codex:$HOME/.codefuse/engine/codex/skills"; do
  name="${pair%%:*}"; dir="${pair#*:}"
  [ -d "$dir/hop" ] || continue
  stamp=$(grep -m1 -- '<!-- driver:' "$dir/hop/SKILL.md" 2>/dev/null || echo "（未找到版本戳）")
  printf '  %-11s skill 版本戳 : %s\n' "$name" "$stamp"
done
if [ "$BINV" != "$PKGV" ]; then
  echo "  ⚠️ 全局 hopjit ($BINV) ≠ 本库 ($PKGV) —— 先跑 hash -r 再重查；仍不一致则 npm link"
  exit 1
fi
echo "✅ 引擎(dist)与本机在场载体的 skill 已同步到库内最新 v${PKGV}（载体清单见上方版本戳行）。新开会话生效;MCP 注册状态用 /hop 体检（doctor）核。"
