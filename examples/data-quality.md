# Spec: 数据质量评估与修复

> **定位：第二课（tool_request 特性演示）**。step 1 的四个工具（count_nulls 等）库内无实现——引擎逐个发 tool_request 交执行 LLM 语义实现，**数值随执行 LLM 会有差异**。这是"工具语义交给 LLM"特性的教学演示，不是数值回归基线（首跑教材是纯确定性的 coffee-week.md）。
> **双模式运行前提**：步骤 1 节点已写工具授权行（`- 工具: 名`）声明这四个工具。复用模式：引擎执行 body 撞到这四个非内置调用时逐个吐 tool_request 交 caller 智能体语义实现，不需要注册。standalone 模式：没有 caller 承接 tool_request，环境须先注册这四个工具的实现（tool_registry/MCP 均可），未注册则步骤 1 首个工具调用即报 TOOL_EXEC_ERROR: act body 调用未知工具/函数 失败——与 probe_callee 的 ToolProvider 注册前提同款。
Id: data-quality
Goal: 评估输入数据集的质量问题，自动修复并生成质量报告

## Inputs
- raw_data: yaml  # 原始数据集（JSON 数组）。演示数据在同目录 demo-data.json（12 条：含缺失/离群/跨字段矛盾）——首跑直接读它传入，不要现场编造数据
- quality_threshold: float  # 质量达标阈值（0-1）。演示跑用 0.8

## Outputs
- quality_report: markdown  # 质量报告

## Constraints
- 修复后数据行数保留率 ≥ 90%
- 不可篡改原始业务字段含义

## Types
- DataRecord:  # 与 demo-data.json 及 3.2 判定公式同一形状（扁平五字段）
  - id: line  # 记录标识
  - amount: float  # 金额
  - qty: int  # 数量
  - unit_price: float  # 单价
  - region: line  # 地区

## Steps
1. [act] 统计数据质量指标（缺失率、异常分布、跨字段一致性）
  - ← raw_data
  - 工具: count_nulls  # 缺失统计
  - 工具: count_outliers  # 离群值统计
  - 工具: count_rule_violations  # 跨字段规则违例统计
  - 工具: build_profile  # 汇总质量画像
  + → profile: yaml  # 数据质量画像
  > 无推理计算：对 raw_data 逐字段统计（缺失率/Z-score异常/跨字段一致性），纯统计不做语义判断
  > ```hop_python
  > total = len(raw_data)
  > missing = count_nulls(data: raw_data)
  > outliers = count_outliers(data: raw_data, z_threshold: 3)
  > violations = count_rule_violations(data: raw_data)
  > profile = build_profile(total: total, missing: missing, outliers: outliers, violations: violations)
  > ```

2. [reason] 解读质量画像，制定修复策略
  - ← profile
  + → fix_strategy: text  # 修复策略
  > 权衡数据保留率与质量，选择合适的缺失值处理和异常值处理方案。
  > 策略应具体到每个问题字段的处理方式。

3. [subtask retry=2 adaptive] 执行修复并验证质量达标
  + → repair_summary: text  # 修复摘要
  + → quality_note: text  # 质量分与验证说明
  3.1. [act free] 按策略修复数据
    - ← raw_data, fix_strategy
    + → clean_data: yaml  # 修复后数据
    + → repair_summary: text  # 修复摘要（subtask 聚合此输出）
    > 严格按 fix_strategy 已定的每字段处理方式施修（按散文策略施修需要理解策略文本，故 free）：
    > - 按策略填充缺失值（策略已指定填充值/方法）
    > - 按策略处理异常值（策略已指定阈值/动作）
    > 输出修复后的数据集 clean_data，并如实记录本次修复动作清单为 repair_summary
    > （不在此处重新决策修复方式——决策已在步骤 2 完成）
    > 输入规模注：本演示数据 12 条，逐条施修可行；大数据集须先把策略结构化再脚本化，不走本形态。
  3.2. [check final] 验证修复后质量 ≥ threshold 且行数保留率 ≥ 90%
    - ← raw_data, clean_data, quality_threshold
    + → quality_ok: bool  # 判定槽：是否达标
    + → quality_note: text  # 固定格式的质量分、评分明细与未达标缺口
    > 固定公式判定由下方 body 引擎直执（零 LLM 手算）：completeness=非 null 单元格比例（按演示数据五字段 id/amount/qty/unit_price/region 逐字段计）、outlier_free=1-离群值占比（各数值字段 |值-均值|>3σ 计离群，标准差为 0 的字段离群数为 0）、consistency=三字段完整记录中 amount=qty*unit_price 的比例（无可评估记录时为 0）、quality_score=三项均值、row_retention=行保留率。仅当 quality_score ≥ quality_threshold 且 row_retention ≥ 0.9 时 quality_ok=true，quality_note 按固定格式拼好。
    > ```hop_python
    > n = len(clean_data)
    > amount_vals = [r["amount"] for r in clean_data if r["amount"] != None]
    > qty_vals = [r["qty"] for r in clean_data if r["qty"] != None]
    > price_vals = [r["unit_price"] for r in clean_data if r["unit_price"] != None]
    > id_nonnull = len([r for r in clean_data if r["id"] != None])
    > region_nonnull = len([r for r in clean_data if r["region"] != None])
    > completeness = (len(amount_vals) + len(qty_vals) + len(price_vals) + id_nonnull + region_nonnull) / (n * 5) if n > 0 else 0
    > a_mean = sum(amount_vals) / len(amount_vals) if len(amount_vals) > 0 else 0
    > a_std = (sum([(v - a_mean) ** 2 for v in amount_vals]) / len(amount_vals)) ** 0.5 if len(amount_vals) > 0 else 0
    > a_out = len([v for v in amount_vals if abs(v - a_mean) > 3 * a_std]) if a_std > 0 else 0
    > q_mean = sum(qty_vals) / len(qty_vals) if len(qty_vals) > 0 else 0
    > q_std = (sum([(v - q_mean) ** 2 for v in qty_vals]) / len(qty_vals)) ** 0.5 if len(qty_vals) > 0 else 0
    > q_out = len([v for v in qty_vals if abs(v - q_mean) > 3 * q_std]) if q_std > 0 else 0
    > p_mean = sum(price_vals) / len(price_vals) if len(price_vals) > 0 else 0
    > p_std = (sum([(v - p_mean) ** 2 for v in price_vals]) / len(price_vals)) ** 0.5 if len(price_vals) > 0 else 0
    > p_out = len([v for v in price_vals if abs(v - p_mean) > 3 * p_std]) if p_std > 0 else 0
    > numeric_nonnull = len(amount_vals) + len(qty_vals) + len(price_vals)
    > outlier_free = 1 - (a_out + q_out + p_out) / numeric_nonnull if numeric_nonnull > 0 else 1
    > full_recs = [r for r in clean_data if r["amount"] != None and r["qty"] != None and r["unit_price"] != None]
    > consistent = len([r for r in full_recs if r["amount"] == r["qty"] * r["unit_price"]])
    > consistency = consistent / len(full_recs) if len(full_recs) > 0 else 0
    > quality_score = (completeness + outlier_free + consistency) / 3
    > row_retention = len(clean_data) / len(raw_data) if len(raw_data) > 0 else 0
    > quality_ok = quality_score >= quality_threshold and row_retention >= 0.9
    > conclusion = "达标" if quality_ok else f"未达标：需 quality_score ≥ {quality_threshold} 且 row_retention ≥ 0.9"
    > quality_note = f"quality_score={round(quality_score, 3)}; completeness={round(completeness, 3)}; outlier_free={round(outlier_free, 3)}; consistency={round(consistency, 3)}; row_retention={round(row_retention, 3)}; conclusion={conclusion}"
    > ```

4. [reason] 生成质量报告
  - ← profile, fix_strategy, repair_summary, quality_note
  + → quality_report: markdown  # 最终质量报告
  > 生成完整质量报告，包含：
  > - 原始数据质量画像摘要
  > - 修复策略说明
  > - 修复摘要
  > - 最终质量分、评分明细与阈值结论
