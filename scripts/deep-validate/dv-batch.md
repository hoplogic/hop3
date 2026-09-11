# Spec: deep-validate 批量体检
Id: dv-batch
Goal: 对一批 spec 逐份并行跑 deep-validate 跑前体检,收割各份风险报告归总

## Inputs
- spec_paths: [line]  # 被审 spec 路径列表(workspace 相对)
- exec_mode: line  # 目标执行模式(standalone/driver),全批同一口径

## Outputs
- reports: [text]  # 各份风险报告(与 spec_paths 同序)

## Steps
1. [loop for-each sp in spec_paths, collect risk_report into reports] 逐份体检
  + → reports: [text]  # 收集
  1.1. [call deep-validate(spec_path: sp, exec_mode) parallel] 单份体检
    + → risk_report
