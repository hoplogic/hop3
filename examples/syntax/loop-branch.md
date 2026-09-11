# Spec: 文本片段逐条审查
Id: loop-branch
Goal: 逐条审查文本片段，按严重度分流；遇致命问题立即中止审查并汇总上报

## Inputs
- segments: [yaml]  # 待审查的文本片段列表（for-each 的遍历对象须是列表类型）

## Outputs
- review_report: text  # 审查报告

## Steps
1. [act] 初始化审查上下文
  - ← segments
  + → seg_count: int  # 待审片段总数
  > 统计 segments 总数（findings 由下方 loop 声明为延续变量，初值空列表）
  > ```hop_python
  > seg_count = len(segments)
  > ```

2. [loop for-each seg in segments] 逐条审查
  + → findings: yaml = []  # 延续变量：跨迭代累积的发现列表（更新模式）
  2.1. [reason] 判当前片段严重度
    - ← seg, findings
    + → severity: line  # 当轮变量：fatal / suspect / clean
    > 判当前片段 seg 的严重度：fatal（致命）/ suspect（可疑）/ clean（无问题）
    > （遍历与退出由 for-each 引擎驱动，无需自判"审完没有"）

  2.2. [branch] 按严重度分流
    2.2.1. [case] severity == 'fatal'
      2.2.1.1. [act] 记录致命发现
        - ← seg, severity, findings
        + → findings  # 更新延续变量：追加致命发现
        > 把当前片段与其严重度组装成 finding 条目机械追加进 findings 数组（引擎直执零 LLM）
        > ```hop_python
        > findings = findings + [{"seg": seg, "severity": severity}]
        > ```
      2.2.1.2. [break]

    2.2.2. [case] severity == 'clean'
      2.2.2.1. [continue]

    2.2.3. [case] default
      2.2.3.1. [act] 记录可疑发现
        - ← seg, severity, findings
        + → findings  # 更新延续变量：追加可疑发现
        > 把当前片段与其严重度组装成 finding 条目机械追加进 findings 数组（引擎直执零 LLM）
        > ```hop_python
        > findings = findings + [{"seg": seg, "severity": severity}]
        > ```

3. [subtask retry=2] 汇总并验证报告
  + → review_report: text  # 审查报告
  3.1. [reason] 生成审查报告
    - ← seg_count, findings
    + → review_report
    > 汇总 findings 生成审查报告，注明已审片段数与各严重度统计
  3.2. [check final] 验证报告完整性
    - ← review_report, findings
    + → report_ok: bool  # 判定槽：报告是否覆盖所有发现
    + → report_gap: text  # 说明槽：遗漏的发现（通过时不被查看）
    > 检查 review_report 是否覆盖 findings 中的每一条发现
