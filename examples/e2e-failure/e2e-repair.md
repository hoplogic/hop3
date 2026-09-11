# Spec: 周报组装（带反馈修复回路）
Id: e2e-repair
Goal: 组装咖啡店周报并强制核验"数据复核"区块——首跑必缺、反馈重跑必补，验证 retry 边界的 last_err 反馈流

## Inputs
- daily_sales: yaml  # 7 天每日营业额列表（数字数组）
- weekly_target: int  # 本周营业目标（元）

## Outputs
- weekly_report: markdown  # 含"数据复核"区块的周报

## Constraints
- 统计数字必须来自输入数据的确定性计算，不得估算

## Steps
1. [act] 统计一周数字
  - ← daily_sales
  + → total: int  # 周营业额
  + → daily_avg: int  # 日均
  > 纯计算
  > ```hop_python
  > total = sum(daily_sales)
  > daily_avg = round(total / count(daily_sales))
  > ```

2. [act] 初始化反馈槽
  + → last_err: text = ""
  > 反馈流起点：首跑为空
  > ```hop_python
  > last_err = ""
  > ```

3. [subtask retry=2] 组装并核验周报
  + → weekly_report: markdown  # 周报
  3.1. [act] 组装周报
    - ← total, daily_avg, last_err
    + → weekly_report: markdown  # 周报
    > 确定性分支：last_err 为空 → 基础版（无复核区块）；非空 → 按反馈补"数据复核"区块。
    > 这是刻意设计——首跑必然缺区块（last_err 空），核验必然失败，重跑轮 last_err
    > 非空才会补上。验证的就是反馈流真实流转。
    > ```hop_python
    > base = "# 本周经营周报\n\n- 周营业额：" + str(total) + " 元\n- 平均每天卖：" + str(daily_avg) + " 元\n"
    > if last_err == "":
    >   weekly_report = base
    > else:
    >   weekly_report = base + "\n## 数据复核\n\n- 周营业额 = 每日营业额之和，已复核：" + str(total) + " 元\n- 复核原因：" + last_err
    > ```
  3.2. [check final] 核验周报含数据复核区块
    - ← weekly_report, last_err
    + → report_ok: bool  # 是否合格
    + → last_err: text  # 不合格时回填缺口说明（更新模式，跨重试反馈）
    > 确定性判据：weekly_report 含"## 数据复核"字样 → report_ok=true、last_err 置空串；
    > 不含 → report_ok=false、last_err 回填"周报缺少数据复核区块，须补上"。
    > 判据机械，不做主观质量评价。
