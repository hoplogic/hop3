# Spec: 周报发布授权闸门
Id: e2e-paused
Goal: 算完周营业额后请人批准发布——验证 driver 到 confirm 介入点停下问人、不替答

## Inputs
- daily_sales: yaml  # 7 天每日营业额列表（数字数组）

## Outputs
- published: bool  # 是否已发布

## Steps
1. [act] 统计周营业额
  - ← daily_sales
  + → total: int  # 周营业额
  > 纯计算
  > ```hop_python
  > total = sum(daily_sales)
  > ```

2. [confirm require_human=true] 批准发布周报
  - ← total
  + → published: bool  # 批准与否
  > 展示周营业额，请真人批准发布。require_human=true：必须真人拍板，
  > driver（含无头模式）不得替答——到此介入点停下如实报告，就是本 spec 的正确终点。
