# Spec: 自适应问题解决
Id: adaptive-solve
Goal: 尝试解决给定问题，首次失败时自适应重新规划方案

## Inputs
- problem: text  # 问题描述

## Outputs
- final_summary: text  # 最终解决方案总结

## Steps
1. [reason] 分析问题
  - ← problem
  + → analysis: text  # 问题分析
  > 深入分析问题的根因和约束条件

2. [subtask retry=2 adaptive] 执行解决方案
  + → solution: text  # 解决结果
  2.1. [act free] 执行解决方案
    - ← analysis
    + → solution: text  # 解决结果（subtask 聚合此输出）
    > 按 analysis 给出的方案实施（工具编排/计算），输出解决结果
    > （方案的决策在步骤 1 reason 完成；实施本就依赖临场编排，故 free；
    >  adaptive 重规划时由引擎调整本 subtask 的 children，而非本 act 内部重新决策方案）
  2.2. [check final] 验证方案有效性
    - ← solution, problem, analysis
    + → effective: bool  # 判定槽：方案是否有效
    + → effective_note: text  # 说明槽：无效时的具体原因（通过时不被查看）
    > 对照 problem 原始问题与 analysis 的根因约束，检验 solution 是否真正解决了问题

3. [reason] 总结
  - ← solution, analysis
  + → final_summary: text  # 最终输出
  > 总结问题分析和解决过程
