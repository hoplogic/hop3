# Spec: 多维度并行分析
Id: parallel-aggregate
Goal: 从三个独立维度并行分析数据，聚合结果后验证

## Inputs
- dataset: yaml  # 待分析数据集

## Outputs
- final_report: text  # 聚合分析报告

## Steps
1. [act] 准备分析数据
  - ← dataset
  + → prepared: yaml  # 预处理后的数据
  > 无推理计算：对 dataset 做确定性清洗与格式化（去空行、字段归一、类型转换），不做分析判断

2. [subtask] 多维度分析（边界容器：三路并行在此收齐）
  + → stats_report: text  # 统计维度结果
  + → trend_report: text  # 趋势维度结果
  + → anomaly_report: text  # 异常维度结果
  2.1. [subtask parallel] 统计维度分析
    + → stats_report: text
    2.1.1. [reason] 计算描述性统计
      - ← prepared
      + → stats_report: text  # 统计分析结果
      > 计算描述性统计量（均值、方差、分布）
  2.2. [subtask parallel] 趋势维度分析
    + → trend_report: text
    2.2.1. [reason] 分析时序趋势
      - ← prepared
      + → trend_report: text  # 趋势分析结果
      > 分析数据的时序趋势和变化方向
  2.3. [subtask parallel] 异常维度分析
    + → anomaly_report: text
    2.3.1. [reason] 检测异常
      - ← prepared
      + → anomaly_report: text  # 异常分析结果
      > 检测数据中的异常值和离群点

3. [reason] 聚合三维度结果
  - ← stats_report, trend_report, anomaly_report
  + → aggregated: text  # 聚合分析
  > 综合三个维度的分析结果，生成整体评估

4. [subtask retry=2] 验证聚合质量
  + → final_report: text  # 验证通过的报告
  4.1. [act] 透传聚合结果为报告
    - ← aggregated
    + → final_report: text  # 验证通过的报告（subtask 聚合此输出）
    > 无推理计算：将 aggregated 原样透传为 final_report（验证由下方 check 把关）
  4.2. [check] 验证三个维度都有有效结论
    - ← aggregated
    + → coverage_ok: bool  # 判定槽：覆盖率是否达标
    + → coverage_note: text  # 说明槽：缺失的维度（通过时不被查看）
    > 检查聚合结果是否涵盖了统计、趋势、异常三个维度
  4.3. [check final] 验证结论一致性
    - ← aggregated
    + → consistent: bool  # 判定槽：是否一致
    + → consistent_note: text  # 说明槽：矛盾点（通过时不被查看）
    > 检查三个维度的结论是否互相矛盾
