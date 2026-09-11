# Spec: 域视图消费探针
Id: probe_mindmaps
Goal: act 取域视图后 reason 消费——复现 3.1.5.1.1→3.1.5.1.2 静默死
> 运行前提：环境须注册提供 get_domain_indexes 的 ToolProvider——工具就位后探针才真正打在 act→reason 消费链上（否则复现到的是"步骤 1 工具缺位死"而非目标"消费链静默死"）。
Inputs:
- target_kb: line
Outputs:
- domain: line

## Steps
1. [act] 取候选领域结构视图
  - ← target_kb
  - 工具: get_domain_indexes  # 取 KB 域视图
  + → mindmaps: [yaml]
  > ```hop_python
  > got = get_domain_indexes(kb: target_kb, hint: "排队论 数学理论")
  > mindmaps = got.indexes
  > ```
2. [reason] 定主领域
  - ← mindmaps
  + → domain: line
  > 从候选域视图中选一个最合适的领域路径；没有合适的返回 "通识/-待归类-"。
3. [exit]
