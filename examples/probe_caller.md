# Spec: 探针caller
Id: probe_caller
Goal: 经 call parallel 起 callee 复现 batch 形态
Inputs:
- target_kb: line
- items: [line]
Outputs:
- domains: [line]

## Steps
1. [loop for-each x in items, collect domain into domains] 单迭代循环
  + → domains: [line]

  1.1. [call probe_callee(target_kb) parallel] 起子实例
    + → domain
2. [exit]
