# Spec: 探针callee
Id: probe_callee
Goal: call 子实例内 act 取域视图后 reason 消费
> 运行前提：环境须注册提供 get_domain_indexes 的 ToolProvider（本探针面向带 KB 工具的环境）。
Inputs:
- target_kb: line
Outputs:
- domain: line

## Steps
1. [subtask] 包一层(模拟construct的case嵌套)
  + → domain: line

  1.1. [act] 取候选领域结构视图
    - ← target_kb
    - 工具: get_domain_indexes  # 取 KB 域视图
    + → mindmaps: [yaml]
    > ```hop_python
    > got = get_domain_indexes(kb: target_kb, hint: "排队论 数学理论")
    > mindmaps = got.indexes
    > ```

  1.2. [reason] 定主领域
    - ← mindmaps
    + → domain: line
    > 从候选域视图中选一个最合适的领域路径；没有合适的返回 "通识/-待归类-"。
2. [exit]
