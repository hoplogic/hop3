# Spec: 文件批量重命名
Id: confirm-commit
Goal: 扫描目录下的文件，生成重命名方案，人工确认后执行不可逆重命名

## Inputs
- target_dir: text  # 目标目录路径（须为 workspace 内相对路径——步骤 5 备份读与步骤 6.1 重命名写均以 workspace 沙箱为界，绝对路径或 workspace 外路径会被拒）

## Outputs
- rename_report: text  # 重命名执行报告

## Steps
1. [act] 扫描目标目录文件列表
  - ← target_dir
  + → file_list: yaml  # 文件列表（listdir 返回 JSON 文本，parse 后是裸列表 [{name, kind}]，kind ∈ file/dir）
  > 列出 target_dir 下的所有条目，body 引擎直执（零 LLM 手写清单）
  > ```hop_python
  > file_list = parse_json(listdir(path: target_dir))
  > ```

2. [reason] 制定统一命名规则
  - ← file_list
  + → naming_rule: yaml  # 统一命名规则，两个键分行的块形态（kind ∈ prefix/suffix）：kind: suffix ／ value: "_v2"——value 值必须带引号（下划线/括号等特殊字符裸写会破坏 YAML 解析）
  > 根据文件列表设计统一的命名规则——只产规则本身（加什么前缀或后缀），不逐文件展开。
  > 产出用块形态（两键分行），value 带引号。
  > （逐条展开归下一步机械生成：文件量大时 LLM 逐条手写清单会撞输出上限，规则+机械展开的形态没有这个封顶）。

3. [act] 按规则机械展开重命名清单
  - ← file_list, naming_rule
  + → rename_plan: [yaml]  # [{old: "a.txt", new: "a.txt_v2"}, ...] 引擎直执生成
  > body 引擎直执：对 file_list 中每个文件（跳过目录），按 naming_rule 生成 {old, new} 条目——
  > suffix 规则加在文件名末尾，prefix 规则加在文件名开头。
  > ```hop_python
  > files = [e["name"] for e in file_list if e["kind"] == "file"]
  > prefixed = [{"old": n, "new": naming_rule["value"] + n} for n in files]
  > suffixed = [{"old": n, "new": n + naming_rule["value"]} for n in files]
  > rename_plan = prefixed if naming_rule["kind"] == "prefix" else suffixed
  > ```
  > （演示形态注：suffix 简化为加在整个文件名末尾——教学重点是"规则+机械展开"的分工形态，扩展名感知的精细拆名须正则，超出内置函数面，真实场景走 subprocess.run uv run python3 形态）

4. [confirm require_human=true] 用户确认重命名方案
  + → approval: bool  # 用户是否批准
  > 展示重命名方案，等待用户确认。
  > 选项：批准 / 拒绝 / 修改后重审

5. [act] 准备重命名（生成可逆备份）
  - ← rename_plan, target_dir
  + → backup_path: text  # 备份路径（work_zone 内——中间产物位，可逆保障归沙箱）
  > body 引擎直执：取 work_zone 下的 backup 路径为备份位（act 写域限 work_zone，备份属可逆保障中间产物），
  > 经白名单 uv 承载 python copytree 把 target_dir 整目录复制到备份位；复制失败（returncode 非 0）时
  > 用一行必然失败的类型转换制造计算异常使本步失败，不带病进入不可逆重命名。
  > ```hop_python
  > backup_path = work_zone_path("backup")
  > r = subprocess.run(["uv", "run", "python3", "-c", "import shutil,sys; shutil.copytree(sys.argv[1], sys.argv[2])", target_dir, backup_path], timeout: 120)
  > if r.returncode != 0:
  >     backup_error = int("备份复制失败: " + r.stderr)
  > ```

6. [loop for-each item in rename_plan, collect moved_flag into moved_flags] 逐项执行重命名
  - ← rename_plan, target_dir
  + → moved_flags: [int]  # 每项 1=本轮真移动 0=幂等跳过

  6.1. [commit] 重命名单项（不可逆）
    - ← item, target_dir
    + → moved_flag: int  # 1=真移动 0=跳过
    > 幂等设计：目标名已存在且源文件已不在则视为本项已完成、跳过——避免崩溃重放时重复重命名或报错。
    > 批量不可逆动作的正形就是 loop 内 commit 逐项：每项一发、各自幂等，body 定死动作零裁量。
    > ```hop_python
    > src = target_dir + "/" + item.old
    > dst = target_dir + "/" + item.new
    > src_probe = parse_json(exists(path: src))
    > dst_probe = parse_json(exists(path: dst))
    > done_already = dst_probe.exists and not src_probe.exists
    > moved = "" if done_already else move(from: src, to: dst)
    > moved_flag = 0 if done_already else 1
    > ```

7. [act] 汇总重命名计数
  - ← moved_flags
  + → renamed_count: int  # 实际重命名数
  > ```hop_python
  > renamed_count = sum(moved_flags)
  > ```

8. [reason] 生成执行报告
  - ← renamed_count, backup_path
  + → rename_report: text  # 最终报告
  > 总结重命名结果和备份位置
