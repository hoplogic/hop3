# Spec: 订单金额汇总（adaptive 重规划触发器）
Id: e2e-adaptive
Goal: 汇总订单清单的金额合计。原计划按旧导出格式写（amount 是数字）——上游导出格式已升级为嵌套对象（amount 变 {value, currency}），旧计划对新数据必然计算异常；两次确定性失败后升级 adaptive 重规划，新结构须取 amount 内层数值再累加

## Inputs
- orders: yaml  # 订单列表。历史格式 amount 是数字；当前上游导出已改为 {value: int, currency: line}

## Outputs
- total: int  # 金额合计

## Constraints
- 合计必须来自输入清单的确定性计算，不得估算

## Steps
1. [subtask retry=2 adaptive] 汇总金额
  + → total: int  # 合计
  1.1. [act] 按旧格式累加
    - ← orders
    + → total: int  # 合计
    > 本步按旧导出格式写（amount 直接是数字可相加）。上游格式升级后 amount 变嵌套对象，
    > 对象参与加法即计算异常——同结构重跑必然再败（数据格式不会自己变回去）。
    > 失败记录里就有新格式的真身，归因线索一眼可见。
    > ```hop_python
    > total = orders[0]["amount"] + orders[1]["amount"] + orders[2]["amount"]
    > ```
  1.2. [check final] 合计核验
    - ← total, orders
    + → total_ok: bool  # 是否合格
    + → check_note: text  # 说明
    > 验收门（replan 不可改写跳过——换计划不换验收标准）：total 必须是正数、
    > 且与逐条清点订单金额的结果一致。不合格说明差在哪。
2. [exit] 交付
