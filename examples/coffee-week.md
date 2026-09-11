# Spec: 咖啡店的一周
Id: coffee-week
Goal: 汇总一家小咖啡店过去 7 天的营业数据，判断经营状态，产出一份给店主看的周报

## Inputs
- daily_sales: yaml  # 7 天每日营业额列表（数字数组）。演示数据在同目录 coffee-sales.json——首跑直接读它传入，不要现场编造数据
- weekly_target: int  # 本周营业目标（元）。演示跑用 26000

## Outputs
- weekly_report: markdown  # 店主周报

## Constraints
- 统计数字必须来自输入数据的确定性计算，不得估算
- 周报用店主能看懂的话写，不用统计术语

## Steps
1. [ask present_inputs=daily_sales require_human=true] 与店主确认本周数据和目标
  - ← daily_sales, weekly_target
  + → target_confirmed: int  # 店主确认（或修正）后的周目标
  > 向店主完整展示七天营业额数据与拟用周目标（weekly_target 作默认值），请确认或改成想考核的数字。
  > 确认后的目标落 target_confirmed——后续判断以它为准。

2. [act] 统计一周数字
  - ← daily_sales
  + → total: int  # 周营业额
  + → best_day: int  # 最好一天
  + → worst_day: int  # 最差一天
  + → daily_avg: int  # 日均
  > 纯计算：全部内置函数，引擎直接算完，无外部工具
  > ```hop_python
  > total = sum(daily_sales)
  > best_day = max(daily_sales)
  > worst_day = min(daily_sales)
  > daily_avg = round(total / count(daily_sales))
  > ```

3. [reason] 判断经营状态
  - ← total, best_day, worst_day, daily_avg, target_confirmed
  + → verdict: text  # 达标结论与一句话原因
  + → advice: text  # 给店主的两三条具体建议
  > 对照 target_confirmed 判断本周达标与否；结合最好/最差天的差距给建议。
  > 建议要具体可操作（如"最差那天是否逢雨天/周一，考虑当日促销"），不要空话。

4. [subtask retry=2] 产出并核验周报
  + → weekly_report: markdown  # 周报
  4.1. [act] 组装周报
    - ← total, best_day, worst_day, daily_avg, verdict, advice
    + → weekly_report: markdown  # 周报
    > 纯拼接：模板填充，无推理
    > ```hop_python
    > weekly_report = "# 本周经营周报\n\n- 周营业额：" + str(total) + " 元\n- 最好一天：" + str(best_day) + " 元\n- 最差一天：" + str(worst_day) + " 元\n- 平均每天卖：" + str(daily_avg) + " 元\n\n## 经营判断\n\n" + verdict + "\n\n## 下周建议\n\n" + advice
    > ```
  4.2. [check final] 周报核验
    - ← weekly_report, total
    + → report_ok: bool  # 是否合格
    + → check_note: text  # 说明
    > 核验：周报里包含周营业额数字（与 total 一致）、有判断有建议、无统计术语。不合格则说明缺口（触发重跑）。
