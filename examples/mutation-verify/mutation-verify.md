# Spec: mutation-verify(变异核证——worktree 隔离逐点位改坏代码,验证测试真能变红)
Id: mutation-verify
Goal: 对一个 git 仓库的若干"变异点位"逐个核证:把代码故意改坏后目标测试必须变红——全绿即实锤该行为面没有测试锁着,记入缺口清单;全程在独立 worktree 里进行,主工作区零接触

Constraints:
- 变异全部发生在 worktree 内——主工作区物理未被碰,弃区即零后果(act 可逆语义的物理兑现,^anc-exec-reuse-worktree-act)
- 每个点位先核基线绿再看变异红——基线就有红的点位判读作废,如实记 baseline_dirty 不硬判
- 变异后目标测试全绿=该点位无测试锁定,记 no_pin(这正是本 spec 要抓的缺口,不是失败)
- 每点位四拍记录齐:基线态/变异态/判定/恢复态——缺任一拍该点位记录不完整
- 命令全走 subprocess.run 白名单(需 hopjit.yaml 声明 commands: [git, npx, uv])——零 Bash 零 shell,引擎逐行执行零裁量
- 运行前提(硬要求):目标项目 hopjit.yaml 的 commands 白名单须含 npx——npx 是跑 vitest 的唯一通道,白名单现值内无等价替身;未补 npx 则步骤 2.1.1 首跑即被引擎拒(TOOL_EXEC_ERROR 点名不在白名单),属环境配置面跑前准备项

Types:
- MutationPoint:  # 一个变异点位
  - file: line       # 仓库相对路径(要改坏的文件)
  - old_text: text   # 原文片段(精确匹配,唯一命中)
  - new_text: text   # 改坏后的片段
  - test_file: line  # 目标测试文件(仓库相对路径)
  - expect_red: line # 期望变红的测试名片段(记录用,判定看整文件红绿)

Inputs:
- repo_dir: line       # 被核证仓库的绝对路径
- base_commit: line    # 基线 commit(worktree 检出的起点;不可用当前已检出的分支名——git 会拒)
- points: [MutationPoint]  # 变异点位清单(选点是人/主对话的裁量,本 spec 只管机械执行)

Outputs:
- 核证报告: yaml  # 逐点位:{file, expect_red, 判定: pinned|no_pin|baseline_dirty, 四拍}

## Steps
1. [act] 建隔离区并准备测试环境
  - ← repo_dir, base_commit
  + → wt_dir: line  # worktree 绝对路径(后续步骤全在此目录内操作)
> 在本实例涂鸦区建 worktree(从 base_commit 检出,detached 形态),把主仓库的 node_modules 软链进来(测试要依赖,软链零拷贝——ln 不在白名单,软链经白名单 uv 承载 python os.symlink 等价落地)。两步任一失败(returncode 非 0)即用必炸类型转换如实报错,不带病下行——worktree/软链失败静默继续会让后续每个点位在坏现场上空转。主工作区从此步起零接触。
> ```hop_python
> wt_dir = work_zone_path("wt")
> r1 = subprocess.run(["git", "worktree", "add", "--detach", wt_dir, base_commit], cwd=repo_dir, timeout=60)
> if r1.returncode != 0:
>     wt_error = int("建 worktree 失败: " + r1.stderr)
> r2 = subprocess.run(["uv", "run", "python3", "-c", "import os,sys; os.symlink(sys.argv[1], sys.argv[2])", repo_dir + "/node_modules", wt_dir + "/node_modules"], timeout=30)
> if r2.returncode != 0:
>     link_error = int("软链 node_modules 失败: " + r2.stderr)
> ```

2. [loop for-each point in points, collect 点位记录 into 点位记录集] 逐点位核证
  - ← points, wt_dir
  + → 点位记录集: [yaml]  # 每点位 {file, expect_red, 判定, 基线, 变异后, 恢复后porcelain}

  2.1. [subtask] 单点位四拍
    - ← point, wt_dir
    + → 点位记录: yaml

    2.1.1. [act] 基线:先跑一次目标测试记录红绿
      - ← point, wt_dir
      + → 基线态: yaml  # {returncode}
> 变异前先在 worktree 里跑一次目标测试文件,只记退出码(输出体不留——判定只看红绿)——基线就有红的点位,后面"变异后红"说明不了任何事。
> ```hop_python
> rb = subprocess.run(["npx", "vitest", "run", point.test_file], cwd=wt_dir, timeout=600)
> 基线态 = {"returncode": rb.returncode}
> ```

    2.1.2. [act] 注入变异并重跑
      - ← point, wt_dir, 基线态
      + → 变异态: yaml  # {returncode, applied: bool}
> 读点位文件,把 old_text 精确替换为 new_text(改坏代码),写回,再跑同一测试文件记退出码。old_text 在文件里找不到时 applied=false 不空跑测试。
> ```hop_python
> src_text = read(path: wt_dir + "/" + point.file)
> applied = point.old_text in src_text
> if applied:
>     mutated = replace(src_text, point.old_text, point.new_text)
>     w = write(path: wt_dir + "/" + point.file, content: mutated)
>     rm = subprocess.run(["npx", "vitest", "run", point.test_file], cwd=wt_dir, timeout=600)
>     变异态 = {"returncode": rm.returncode, "applied": True}
> else:
>     变异态 = {"returncode": -1, "applied": False}
> ```

    2.1.3. [act] 恢复并判定
      - ← point, wt_dir, 基线态, 变异态
      + → 点位记录: yaml
> 单文件 git checkout 恢复该文件,复核 porcelain 干净。然后按三态判定:基线非绿=baseline_dirty(判读作废);基线绿且变异后红=pinned(测试真锁着这个行为);基线绿且变异后仍绿=no_pin(缺口——改坏了没人知道)。old_text 未命中=point_invalid。
> ```hop_python
> rr = subprocess.run(["git", "checkout", "--", point.file], cwd=wt_dir, timeout=30)
> rp = subprocess.run(["git", "status", "--porcelain", "--", point.file], cwd=wt_dir, timeout=30)
> if 变异态["applied"] == False:
>     判定 = "point_invalid"
> elif 基线态["returncode"] != 0:
>     判定 = "baseline_dirty"
> elif 变异态["returncode"] != 0:
>     判定 = "pinned"
> else:
>     判定 = "no_pin"
> 点位记录 = {"file": point.file, "expect_red": point.expect_red, "判定": 判定, "基线": 基线态["returncode"], "变异后": 变异态["returncode"], "恢复后porcelain": rp.stdout}
> ```

3. [subtask] 弃区收口与验收
  - ← 点位记录集, wt_dir, repo_dir, points
  + → 核证报告: yaml

  3.1. [act] 弃隔离区并组装报告
    - ← 点位记录集, wt_dir, repo_dir
    + → 核证报告: yaml
> 强制移除 worktree(变异不保留,弃区即回滚——路径用步骤 1 产的同一变量,不手打),然后把点位记录集原样组装成报告。
> ```hop_python
> rd = subprocess.run(["git", "worktree", "remove", "--force", wt_dir], cwd=repo_dir, timeout=30)
> 核证报告 = {"点位": 点位记录集, "弃区": rd.returncode}
> ```

  3.2. [check final] 核证完备验收
    - ← 核证报告, points
    + → ok: bool  # 判定
    + → note: text  # 缺口
> 四条确定性布尔核对由 body 引擎直执(零 LLM):①报告点位数=输入点位数(不许静默漏点);②每点位四拍在场(基线/变异后/判定/恢复后porcelain 四键都在);③恢复后 porcelain 全部为空串(现场干净);④弃区 returncode=0。任一不满足 ok=false,note 列出缺项。
> ```hop_python
> recs = 核证报告["点位"]
> c1 = len(recs) == len(points)
> four_keys = [("基线" in r) and ("变异后" in r) and ("判定" in r) and ("恢复后porcelain" in r) for r in recs]
> c2 = all(four_keys) if len(recs) > 0 else True
> porcelain_clean = [len(strip(str(r["恢复后porcelain"]))) == 0 for r in recs]
> c3 = all(porcelain_clean) if len(recs) > 0 else True
> c4 = 核证报告["弃区"] == 0
> ok = c1 and c2 and c3 and c4
> m1 = "" if c1 else f"点位数不符:报告 {len(recs)} vs 输入 {len(points)};"
> m2 = "" if c2 else "存在点位四拍不全;"
> m3 = "" if c3 else "存在恢复后 porcelain 非空(现场不干净);"
> m4 = "" if c4 else "弃区 returncode 非 0;"
> note = m1 + m2 + m3 + m4
> ```

## 使用说明

本范本是"变异核证"策略的引擎强制形态——把"测试真的锁住了行为吗"这个问题从人肉/subagent 自由发挥固化为机械可跑的 spec。选点位(哪里的缺省值/哪个分支值得核)是人的裁量,写进 points 输入;spec 只管逐点位机械执行四拍并如实分类(pinned/no_pin/baseline_dirty/point_invalid)。no_pin 不是失败——它正是本 spec 要抓的产出:该行为面没有测试锁着,改坏了没人知道。

运行前提(硬要求):被核证仓库所在项目的 hopjit.yaml 声明 `commands:` 含 git、npx、uv——npx 是跑 vitest 的唯一通道(白名单现值内无等价替身),未补则步骤 2.1.1 首跑即被引擎拒;uv 承载软链动作(python os.symlink,ln 不在白名单)。测试框架 vitest(换框架改 2.1.1/2.1.2 的命令行即可)。示范输入见同目录 mutation-verify-sample-params.json(以本仓库自身为靶,两个点位:一个已知有钉、一个故意选无钉面)。
