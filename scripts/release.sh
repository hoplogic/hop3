#!/bin/sh
# G5 发版检查单——快照制（设计权威 docs/design/release-engineering.md ^anc-release-snapshot,2026-09-04）
# + 历史坑固化（0.1.2 四坑 / 0.1.5 资产时点 / 0.1.6 登录态+半截状态 / 0.12.2 三连拦→快照制）。
# 用法：npm run release                      （缺省 patch bump；minor/major 传参）
#      RELEASE_DRY_RUN=1 npm run release     （演练：不 publish 不打 tag 不推送,尾部自动弃区,可反复）
# 快照制要点：
#   - 启动即冻结 SNAP=当时的主区提交,全部检查/升版本/publish 对快照 worktree（.release-wt/wt）跑
#   - 主区并行推进不拦发版——发的是"测过的那个提交",晚到提交进下一版本周期（多 agent 并发常态下
#     任何依赖"发版期间别动库"的方案都不成立,快照制不需要任何人静默）
#   - 断点续跑：.release-snapshot 记录快照号,任何一步挂掉直接重跑本脚本——沿用同一快照续发,绝不重复 bump
#   - 幂等：npm 上已存在且快照内容与 tag 零差异 → 判定已发完,只补装置/推送收编
#   - 收编三拍：主区 cherry-pick 版本提交 → push → push tag（各拍独立执行各看输出——|| 单行连写吞输出,禁）
set -e
cd "$(dirname "$0")/.."

RWT_DIR=".release-wt"
WT="$RWT_DIR/wt"
in_wt() ( cd "$WT" && "$@" )   # 在快照区执行（守卫断言 publish 走此前缀——防漏改跑回主区）

dry_cleanup() {
  [ -n "$RELEASE_DRY_RUN" ] || return 0
  [ -n "$DRY_OWNS_WT" ] || return 0   # 只弃自己建的区——dry-run 拒启时区是在途真发版的,不许碰
  [ -e "$WT" ] || return 0
  echo "◦ dry-run 收尾：弃快照区+删记录文件（主区零残留,可反复演练）"
  git worktree remove --force "$WT" 2>/dev/null || true
  git worktree prune 2>/dev/null || true
  rm -f .release-snapshot
  rm -rf "$RWT_DIR"
}

STEP="启动"
trap 'code=$?; if [ $code -ne 0 ]; then echo ""; echo "❌ 发版中断于【${STEP}】(exit $code)"; echo "   处置：解决上述报错后【直接重跑 npm run release】——脚本按 .release-snapshot 沿用同一快照续发，不会重复升版本。"; fi; dry_cleanup' EXIT

# ── 快照区就位：分诊 → 冻结 or 断点续用 ──
STEP="快照区就位"
CURR=$(git rev-parse HEAD)   # ← 主区提交唯一读取点（守卫钉死单处——冻结与断点分诊共用本读,防漏改回移动靶语义）
if [ -n "$RELEASE_DRY_RUN" ] && [ -f .release-snapshot ]; then
  echo "❌ dry-run 拒启：.release-snapshot 在场——疑似有在途真发版（演练不弃他人的区）。"
  echo "   确认无在途发版后手工清理：git worktree remove --force $WT && rm .release-snapshot && rm -rf $RWT_DIR"
  exit 1
fi
# 断点分诊：旧快照续不续？判据=是否已过不可逆点（升版本提交已产生）。未过且主区已推进 →
# 自动废弃重冻结（升版本前快照里没有需要保护的内容,而检查失败的修复多半已进主区——续旧快照
# 只会在同一处再红,2026-09-04 首发实撞:审计红修复收编后旧快照追不上,作者抓"这个能智能点么"）。
# 已过 → 恒续同一快照（防重复 bump/tag 撞名/重复 publish）。纯重试（主区没动）→ 续原区省一次 build。
if [ -f .release-snapshot ]; then
  OLDSNAP=$(cat .release-snapshot)
  BUMPED=""
  WTHEAD=$(git -C "$WT" log -1 --format=%H 2>/dev/null || echo "")
  [ -n "$WTHEAD" ] && [ "$WTHEAD" != "$OLDSNAP" ] && BUMPED=1        # 快照区已前进=版本提交在区内
  if [ -z "$BUMPED" ]; then
    for T in $(git tag -l 'v*'); do                                   # 兜 worktree 缺损:版本提交只剩 tag 引用
      [ "$(git rev-parse "$T^{commit}^" 2>/dev/null)" = "$OLDSNAP" ] && BUMPED=1
    done
  fi
  if [ -z "$BUMPED" ] && [ "$OLDSNAP" != "$CURR" ]; then
    echo "◦ 断点分诊：旧快照 ${OLDSNAP} 未过升版本点且主区已推进——自动重新冻结（旧快照无内容可丢）"
    git worktree remove --force "$WT" 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    rm -f .release-snapshot
  fi
fi
if [ -f .release-snapshot ]; then
  SNAP=$(cat .release-snapshot)
  if git -C "$WT" log -1 --format=%H >/dev/null 2>&1; then
    echo "◦ 断点续发：沿用快照 ${SNAP}（$WT 完好）"
  else
    echo "◦ 断点续发：快照记录在场但 worktree 缺损——按 $SNAP 重建"
    git worktree remove --force "$WT" 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    git worktree add --detach "$WT" "$SNAP"
    # 缺损前若已 bump（版本提交只活在 worktree 里,重建回 SNAP 会丢它）：版本提交被 tag 引用不丢——
    # 扫 v* tag 找"父=快照"的版本提交,找到即前进过去,防重复 bump 撞已有 tag
    RECOVER=""
    for T in $(git tag -l 'v*'); do
      if [ "$(git rev-parse "$T^{commit}^" 2>/dev/null)" = "$SNAP" ]; then RECOVER="$T"; fi
    done
    if [ -n "$RECOVER" ]; then
      echo "◦ 检测到已存在的版本提交（$RECOVER,父=快照）——快照区前进到它续发,不重复升版本"
      git -C "$WT" reset --hard "$RECOVER^{commit}"
    fi
  fi
else
  SNAP=$CURR   # ← 冻结点：取启动时读定的主区提交（唯一读取点在上方 CURR 行）
  echo "$SNAP" > .release-snapshot
  git worktree remove --force "$WT" 2>/dev/null || true
  git worktree prune 2>/dev/null || true
  git worktree add --detach "$WT" "$SNAP"
  [ -z "$RELEASE_DRY_RUN" ] || DRY_OWNS_WT=1   # 演练自建的区,尾部收尾只弃它（拒启路径到不了这里）
  echo "◦ 快照冻结：$SNAP —— 全部检查与发布对快照区（${WT}）跑,主区并行推进不影响本次发版内容"
fi
[ -e "$WT/node_modules" ] || ln -s "$(pwd)/node_modules" "$WT/node_modules"
# hopissues 议题库软链：快照区 npm run check 内含开工扫描,按"仓库根的上一级"找 hopissues——
# 快照区的上一级是容器目录 $RWT_DIR,补软链指真库;源缺席则不补（扫描显式失败,与主区同病同症不装绿）
if [ -d ../hopissues ] && [ ! -e "$RWT_DIR/hopissues" ]; then
  ln -s "$(cd ../hopissues && pwd)" "$RWT_DIR/hopissues"
fi

STEP="快照区构建"
echo "◦ 快照区构建（dist 恒由快照源码构建——主区 dist 陈旧不再影响发版）..."
in_wt npm run -s build

PKGV=$(node -e "console.log(require('./$WT/package.json').version)")
NPMV=$(npm view "@hoplogic/hopjit@$PKGV" version 2>/dev/null || echo "")   # 精确查本版是否已发（latest 有传播延迟）

# 发版无关面黑名单（④E2E 凭证闸用——2026-08-26 作者定"走黑名单,安全点"：
# 只枚举确认不影响发版产物的路径,名单外一切〔含未来新增未知路径〕缺省按影响发版拦。
# scripts/release.sh 自身入名单：检查单不被 E2E 测,其验证=当次发版执行本身。契约 chain-enforcement §8）
# @a: anc-release-boundary-guards —— 凭证差集闸:maintainers/ 恒在黑名单(被钉 tests/guard-scripts.test.ts)
NONRELEASE_RE='^(todo/|docs/|hop_tasks/|audits/|maintainers/|tests/|scripts/audit/|model-gearbox/|\.playwright-mcp/|TRACEABILITY\.md|Doctree\.md|ARCHITECTURE\.md|AGENTS\.md|CLAUDE\.md|\.gitignore|scripts/release\.sh|vitest\.config\.ts)'   # model-gearbox/ 2026-09-20 补员:不在 package.json files 白名单,不进 tarball,度量档案与探针产物对发版产物无影响(0.17.1 实拦后核实)

echo "═══ 发版检查单（G5·快照制）═══"
echo "快照 package.json: $PKGV / npm 上该版本: ${NPMV:-未发布} / 快照 $SNAP"

# ── 状态判定：全新发版 or 半截续发 or 已发完 ──
# 幂等判据按内容不按 sha（快照制下主区 HEAD 是版本提交的 cherry-pick 副本,sha 恒不等于 tag 指向的
# 快照区提交——按 sha 判永远判不出"已发完"；按内容判:零新增重跑正确落幂等收尾,有真新内容才开新发版）
RESUME=""
if [ "$PKGV" = "$NPMV" ] && git rev-parse "v$PKGV" >/dev/null 2>&1 && git -C "$WT" diff --quiet "v$PKGV" 2>/dev/null; then
  echo "◦ npm 上已存在 $PKGV 且快照内容与 v$PKGV tag 零差异 —— 上次发版收尾（幂等模式：只补装置与推送收编）。"
  RESUME="published"
elif [ "$PKGV" = "$NPMV" ]; then
  echo "◦ npm 上已有 $PKGV 且快照含新内容 —— 走全新发版（将 bump 新版本号）。"
  : # RESUME 留空 → 完整流程含 ⑥ 升版本（0.1.8 实撞：幂等误判吞掉了新发版）
elif git rev-parse "v$PKGV" >/dev/null 2>&1 && git -C "$WT" tag --points-at HEAD | grep -qx "v$PKGV"; then
  echo "◦ 检测到半截状态: v$PKGV tag 已打但该版未上 npm -- 跳过升版本, 直接续发 $PKGV"
  RESUME="bumped"
fi

if [ -z "$RESUME" ]; then
  STEP="步骤1-主区脏区盘点"
  echo "① 主区脏区盘点（快照制下警告不拦——发的是快照 $SNAP,并行改动不在本次发版内）..."
  DIRTY_ALL=$(git status --porcelain)
  if [ -n "$DIRTY_ALL" ]; then
    echo "⚠️  主区有未提交改动（并行改动不在本次发版内,列出留痕）："
    echo "$DIRTY_ALL" | sed 's/^/     /'
  fi

  STEP="步骤2-全量检查"
  echo "② 全量检查（fast+测试+audit+version-lock+spec-syntax,对快照区跑）..."
  in_wt npm run -s check

  STEP="步骤3-覆盖率基线"
  echo "③ 覆盖率基线（快照区）..."
  in_wt npm run -s check:coverage >/dev/null 2>&1 || { echo "❌ 覆盖率跌破基线"; exit 1; }
  echo "   覆盖率 OK"

  STEP="步骤4a-语义审计节奏"
  echo "④a 语义审计节奏（台账 G3，提示不拦——2026-08-11 作者裁决降级：语义审计非发版闸，终点凭证〔④〕才是硬闸。台账在主区 .anchor-audit/,不入库快照区不携带）..."
  SEM="./.anchor-audit/semantic_audit_summary.yaml"
  if [ ! -f "$SEM" ]; then
    echo "   ⚠️ 提示：无语义审计产物（$SEM 不存在——.anchor-audit 不入库，隔离跑的 e2e:audit 产物不落仓库根）。"
    echo "   建议节奏：/hopspec run scripts/audit/anchor-audit.md 全量跑至步骤 6 落盘。本次发版继续。"
  else
    AUDIT_TS=$(stat -f "%m" "$SEM" 2>/dev/null || echo 0)
    NOW=$(date +%s); AGE_D=$(( (NOW - AUDIT_TS) / 86400 ))
    echo "   语义审计产物最近更新：$AGE_D 天前（${SEM}）"
    if [ "$AGE_D" -gt 14 ]; then
      echo "   ⚠️ 提示：已超 14 天，建议近期安排一轮全量语义审计。本次发版继续。"
    fi
  fi

  STEP="步骤4b-tarball资产核对"
  echo "④b tarball 资产核对（快照区打包,缺一即停——0.1.5 实坑：发版早于资产入库）..."
  PACKLIST=$(in_wt npm pack --dry-run 2>&1)
  for MUST in "driver/hopspec-skill.md" "examples/coffee-week.md" "coffee-sales.json" "examples/data-quality.md" "demo-data.json" "examples/e2e-failure/e2e-adaptive.md"; do
    echo "$PACKLIST" | grep -q "$MUST" || { echo "❌ tarball 缺 $MUST"; exit 1; }
  done
  echo "   tarball 内容 OK"
fi

if [ "$RESUME" != "published" ]; then
  STEP="步骤4-E2E双绿凭证"
  echo "④ E2E 双绿凭证（cc:delegated + codex:delegated 通过——无条件闸，续发模式也不跳过：publish 是不可逆点。凭证允许落后快照当且仅当差集全落发版无关黑名单内）..."
  for SCEN in cc-delegated codex-delegated; do
    EV=".e2e-evidence/$SCEN.json"
    [ -f "$EV" ] || { echo "❌ 缺 $EV —— 先跑 npm run test:live:core（发版档,有模型费用,见 maintainers/RELEASING.md §3）"; exit 1; }
    EVCOMMIT=$(node -e "console.log(require('./$EV').commit)")
    if [ "$EVCOMMIT" != "$SNAP" ]; then
      # 凭证落后快照：须为快照祖先,且差集 diff 路径全部落黑名单内（发版无关）才放行——2026-08-26 作者定
      #（实撞:改 release.sh 自身+设计文档一笔提交使凭证落后,重跑 13min live:core 买到的信息为零）
      git merge-base --is-ancestor "$EVCOMMIT" "$SNAP" 2>/dev/null || { echo "❌ $EV 凭证 commit $EVCOMMIT 不是快照 $SNAP 的祖先（异常拓扑）—— 重跑 npm run test:live:core"; exit 1; }
      # -c core.quotepath=false：中文路径缺省被引号转义（"todo/\350..."），带引号开头匹配不上
      # ^todo/ 等黑名单前缀 → 发版无关的中文名文件会误拦（2026-09-11 实撞：0086 中文卡名误判发版相关）
      DIFF_PATHS=$(git -c core.quotepath=false diff --name-only "$EVCOMMIT" "$SNAP")
      DIFF_BLOCK=$(echo "$DIFF_PATHS" | grep -Ev "$NONRELEASE_RE" || true)
      if [ -n "$DIFF_BLOCK" ]; then
        echo "❌ $EV 凭证指向 ${EVCOMMIT}，快照较其多出发版相关改动（黑名单外缺省拦）—— 重跑 npm run test:live:core："
        echo "$DIFF_BLOCK" | sed 's/^/     /'
        exit 1
      fi
      echo "   $SCEN ⚠️ 凭证落后快照，但差集全为发版无关路径（留痕放行）："
      echo "$DIFF_PATHS" | sed 's/^/       /'
    fi
    echo "   $SCEN ✅ ($(node -e "console.log(require('./$EV').passed_at)"))"
  done

  if [ -z "$RELEASE_DRY_RUN" ]; then
    STEP="步骤5-npm登录态预检"
    echo "⑤ npm 登录态预检（E404≈认证过期——npm 故意 404 防探测；0.1.4/0.1.6 两次实撞）..."
    npm whoami >/dev/null 2>&1 || { echo "   未登录/过期，npm login（弹浏览器）..."; npm login; }
    echo "   登录：$(npm whoami)"
  else
    echo "⑤ [dry-run] 跳过 npm 登录态预检（弹浏览器不适合演练）"
  fi

  if [ -z "$RESUME" ]; then
    STEP="步骤6-升版本"
    # bump 档位可传参：npm run release -- minor（缺省 patch）。0.x 惯例：breaking 变更走 minor
    BUMP="${1:-patch}"
    case "$BUMP" in patch|minor|major) ;; *) echo "❌ 无效 bump 档位 '$BUMP'（patch/minor/major）"; exit 1;; esac

    STEP="步骤6a-breaking检测闸"
    # patch 档 breaking 闸（0.2.6 实撞固化：该发 0.3.0 的 breaking 批被缺省 patch 发成 0.2.6——
    # "这批该发什么档"不能靠人肉记忆）。判据：自上一 tag 到快照的 commit 信息含破坏性标记词
    # （破坏性/breaking/退役/废除/不留兼容/干净改/干净拆）即拒 patch，指路 minor。
    # 显式 minor/major = 人已判断过档位，不拦。误报出口：确认非 breaking 后用
    # HOPJIT_RELEASE_ALLOW_PATCH=1 放行（显式豁免留痕，不是绕闸暗门）。
    if [ "$BUMP" = "patch" ] && [ -z "$HOPJIT_RELEASE_ALLOW_PATCH" ]; then
      # 基线=版本号最大的 v* tag（不许 describe——快照制下版本提交在侧线,describe 沿祖先链
      # 找不到它们,会落到旧形态 tag 扫出几个周期的累积提交;0.14.1 实撞误拦三个已发提交）
      LASTTAG=$(git tag -l 'v*' --sort=-v:refname | head -1)
      if [ -n "$LASTTAG" ]; then
        HITS=$(git log "$LASTTAG".."$SNAP" --format='%h %s' | grep -cE '破坏性|[Bb]reaking|退役|废除|不留兼容|干净改|干净拆' || true)
        if [ "$HITS" -gt 0 ]; then
          echo "❌ patch 档 breaking 闸：$LASTTAG..快照 有 $HITS 个 commit 含破坏性标记——"
          git log "$LASTTAG".."$SNAP" --format='%h %s' | grep -E '破坏性|[Bb]reaking|退役|废除|不留兼容|干净改|干净拆' | head -5 | sed 's/^/     /'
          echo "   0.x 惯例 breaking 走 minor：npm run release -- minor"
          echo "   确认全部标记为误报（非真 breaking）：HOPJIT_RELEASE_ALLOW_PATCH=1 npm run release"
          exit 1
        fi
      fi
    fi

    STEP="步骤6-升版本"
    echo "⑥ 升版本（${BUMP}，在快照区执行——版本提交以快照 $SNAP 为父,只提交版本双文件）..."
    in_wt npm version "$BUMP" --no-git-tag-version
    PKGV=$(node -e "console.log(require('./$WT/package.json').version)")
    git -C "$WT" add package.json package-lock.json
    git -C "$WT" commit -m "$PKGV"
    if [ -n "$RELEASE_DRY_RUN" ]; then
      echo "   [dry-run] 跳过打 tag（tag 是仓库全局的,演练不留痕）——真发版将打 v$PKGV"
    else
      git -C "$WT" tag "v$PKGV"
    fi
  fi

  if [ -z "$RELEASE_DRY_RUN" ]; then
    STEP="步骤7-发布"
    echo "⑦ 发布 ${PKGV}（从快照区 publish;认证中断则静默不发, 下一步实测远端核验）..."
    in_wt npm publish --access public

    STEP="步骤7b-发布核验"
    echo "${STEP}：轮询 registry（传播有延迟——0.1.7 实测 3s 仍读到旧版，假阴性中断过一次）..."
    OK=""
    for i in 1 2 3 4 5 6; do
      NPMV=$(npm view "@hoplogic/hopjit@$PKGV" version 2>/dev/null || echo "")
      [ "$NPMV" = "$PKGV" ] && { OK=1; break; }
      echo "   第 $i 次未见 $PKGV (当前读到 '${NPMV:-空}'), ${i}0s 后重试..."
      sleep $((i*10))
    done
    [ -n "$OK" ] || { echo "❌ 轮询 210s 后 registry 仍无 $PKGV -- 若上方确有 '+ @hoplogic/hopjit@$PKGV' 则是传播极慢，稍后重跑续发即可；否则 publish 未生效。"; exit 1; }
    echo "   registry 确认 $PKGV ✅"
  else
    echo "⑦ [dry-run] 跳过 publish 与 registry 核验（不可逆外向动作,演练不发）"
  fi
fi

if [ -z "$RELEASE_DRY_RUN" ]; then
  STEP="步骤8-更新全局安装"
  echo "⑧ 更新全局安装 ..."
  npm i -g "@hoplogic/hopjit@$PKGV"

  STEP="步骤9-版本核验"
  hash -r 2>/dev/null || true
  INSTALLED=$(hopjit --version 2>/dev/null || echo "?")
  echo "⑨ 版本核验：本库 $PKGV / 全局 $INSTALLED"
  [ "$INSTALLED" = "$PKGV" ] || echo "   ⚠️ 不一致——你的终端跑一次 hash -r 后复验（shell 缓存坑）"

  STEP="步骤10-装skill"
  echo "⑩ 装 skill（全局包源=刚发内容）..."
  hopjit install-skill --dir "$HOME/.claude/skills" --force
  head -1 "$HOME/.claude/skills/hopspec/SKILL.md"
else
  echo "⑧⑨⑩ [dry-run] 跳过全局装置与 skill（演练不动全局环境）"
fi

STEP="步骤11-主区收编与推送"
if [ -n "$RELEASE_DRY_RUN" ]; then
  VCOMMIT=$(git -C "$WT" log -1 --format=%H)
  echo "⑪ [dry-run] 收编三拍只报不推："
  echo "   1) 主区将 cherry-pick 版本提交 ${VCOMMIT}（$PKGV,父=快照 ${SNAP}）"
  echo "   2) 将 /usr/bin/git push 主分支"
  echo "   3) 将 /usr/bin/git push origin v$PKGV"
  echo "✅ dry-run 演练完成（快照 $SNAP → ${PKGV}）——未 publish 未打 tag 未推送,尾部自动弃区"
  exit 0
fi

# 收编三拍——各拍独立执行各看输出（|| 单行连写吞输出,两连撞后的正形,禁改回）
MAINV=$(node -e "console.log(require('./package.json').version)")
if [ "$MAINV" = "$PKGV" ]; then
  echo "⑪-1 主区已含版本 ${PKGV}（收编已完成）——跳过 cherry-pick"
else
  VCOMMIT=$(git rev-parse "v$PKGV^{commit}")
  echo "⑪-1 主区收编：cherry-pick 版本提交 ${VCOMMIT}（父=快照 ${SNAP}）..."
  if ! git cherry-pick "$VCOMMIT"; then
    echo "❌ cherry-pick 撞冲突（并行改动碰了 package.json/package-lock.json）。手工处置："
    echo "   1) 解决冲突（版本号以已发布的 $PKGV 为准）后 git add 两文件"
    echo "   2) git cherry-pick --continue"
    echo "   3) 重跑 npm run release 续收编（快照记录还在,幂等续发不重复 bump/publish）"
    exit 1
  fi
fi
echo "⑪-2 push 主分支 ..."
/usr/bin/git push
echo "⑪-3 push tag v$PKGV ..."
/usr/bin/git push origin "v$PKGV"

STEP="快照区弃置"
git worktree remove --force "$WT"
git worktree prune 2>/dev/null || true
rm -f .release-snapshot
rm -rf "$RWT_DIR"
echo "◦ 快照区已弃置（版本提交由 tag 与主区 cherry-pick 双持,不丢内容）"

STEP="完成"
echo "✅ 发版完成: @hoplogic/hopjit@$PKGV (引擎+driver+examples 成对分发, 快照 $SNAP)"
