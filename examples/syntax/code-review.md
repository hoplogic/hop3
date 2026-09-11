# Spec: 代码变更审查
Id: code-review
Goal: 审查当前 git diff 的代码变更，输出结构化审查报告

Inputs:
- target_dir: text  # 要审查的项目目录路径

Outputs:
- review_report: text  # 审查报告（markdown 格式）

Constraints:
- 只审查已暂存或已修改的文件，不审查未跟踪文件
- 关注正确性、安全性、可维护性三个维度
- 每个问题标注严重度（P0/P1/P2）

## Steps
1. [act] 获取代码变更
  - ← target_dir
  + → diff_content: text  # git diff 输出
  + → changed_files: [line]  # 变更文件列表
  > body 引擎直执：在 target_dir 执行 git diff HEAD（含已暂存与已修改）取完整变更内容，
  > 再执行 git diff HEAD --name-only 取变更文件列表（git 在命令白名单；空行剔除）。
  > ```hop_python
  > diff_r = subprocess.run(["git", "diff", "HEAD"], cwd: target_dir, timeout: 60)
  > diff_content = diff_r.stdout
  > files_r = subprocess.run(["git", "diff", "HEAD", "--name-only"], cwd: target_dir, timeout: 60)
  > changed_files = [f for f in split(strip(files_r.stdout), "\n") if len(f) > 0]
  > ```

2. [reason] 分析变更并识别问题
  - ← diff_content, changed_files
  + → findings: [yaml]  # 结构化审查发现列表，每条 {file, severity, issue, suggestion}（severity ∈ P0/P1/P2；无问题的方面用 severity: PASS 记通过项）
  > 逐文件审查变更：
  > - 正确性：逻辑错误、边界条件、类型安全
  > - 安全性：注入风险、敏感数据泄露、权限检查
  > - 可维护性：命名、复杂度、重复代码
  > 每个发现产出一条结构化条目 {file: 文件路径, severity: P0（阻塞）/P1（重要）/P2（建议）, issue: 问题描述, suggestion: 修复建议}；
  > 审查后无问题的方面记 {file, severity: "PASS", issue: 审查过的方面, suggestion: ""} 作通过项。

3. [act] 生成审查报告
  - ← findings, changed_files
  + → review_report: text  # markdown 格式报告
  > 无推理组装由 body 引擎直执：按固定模板机械拼 markdown——概要计数（P0/P1/P2 各多少个、覆盖多少文件）
  > 与各级问题逐条列举全部来自 findings 结构化字段，不重新分析。
  > ```hop_python
  > p0 = [x for x in findings if x["severity"] == "P0"]
  > p1 = [x for x in findings if x["severity"] == "P1"]
  > p2 = [x for x in findings if x["severity"] == "P2"]
  > passes = [x for x in findings if x["severity"] == "PASS"]
  > p0_lines = [f"- **{x['file']}**: {x['issue']}（建议：{x['suggestion']}）" for x in p0]
  > p1_lines = [f"- **{x['file']}**: {x['issue']}（建议：{x['suggestion']}）" for x in p1]
  > p2_lines = [f"- **{x['file']}**: {x['issue']}（建议：{x['suggestion']}）" for x in p2]
  > pass_lines = [f"- {x['file']}: {x['issue']}" for x in passes]
  > head = f"## 概要\n\nP0 {len(p0)} 个 / P1 {len(p1)} 个 / P2 {len(p2)} 个，覆盖 {len(changed_files)} 个文件\n"
  > sec0 = "\n## P0 问题（阻塞合并）\n\n" + (join(p0_lines, "\n") if len(p0) > 0 else "无")
  > sec1 = "\n\n## P1 问题（建议修复）\n\n" + (join(p1_lines, "\n") if len(p1) > 0 else "无")
  > sec2 = "\n\n## P2 建议（可选改进）\n\n" + (join(p2_lines, "\n") if len(p2) > 0 else "无")
  > sec3 = "\n\n## 通过项\n\n" + (join(pass_lines, "\n") if len(passes) > 0 else "无")
  > review_report = head + sec0 + sec1 + sec2 + sec3
  > ```
