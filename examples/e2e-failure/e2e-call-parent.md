# Spec: 调用规整子流程（跨界失败传播）
Id: e2e-call-parent
Goal: call 一个必失败的子 spec——验证子实例 failed 经 --failure-child 机器通道回报、CalleeFailure 内核原封到父终态

## Inputs
- raw_value: text  # 传给子 spec 的销售值（e2e 传 "not-a-number"）

## Outputs
- clean_value: int  # 规整结果（必然缺席——子必失败）

## Steps
1. [call e2e-call-child(raw_value)] 调用销售数据规整子流程
  + → clean_value: normalized # 输出映射：父 clean_value ← 子 normalized（输入同名简写在方括号内）
  > 复用模式：driver 经 init --parent 建子实例、驱动子循环；子实例 failed 后必须用
  > --failure-child <子实例ID> 回报（机器通道，引擎读子实例失败记录组装 CalleeFailure），
  > 禁止用 --failure 自由文本转述。
  > 配套子 spec：同目录 e2e-call-child.md（callee_spec_id=e2e-call-child）
