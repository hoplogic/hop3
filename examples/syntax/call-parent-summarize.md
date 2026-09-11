# Spec: 批量文档摘要（调用复用子流程）
Id: call-parent-summarize
Goal: 对输入文档先调用「文本规整」子 spec 清洗，再生成摘要——示范 call 步骤复用子 spec

## Inputs
- doc: text  # 原始文档（可能含噪声：多余空行、乱码、格式不一）

## Outputs
- summary: text  # 文档摘要

## Steps
1. [call text-normalize(raw_text: doc)] 调用文本规整子流程
  + → clean_doc: normalized   # 输出映射：父 clean_doc ← 子 spec 的 normalized（输入映射在方括号内：子 raw_text ← 父 doc）
  > 复用模式：CC 读此 call StepReady（含 callee_spec_id=text-normalize + 双向映射），
  > 经 hopjit init text-normalize --parent ... 建子实例、驱动子循环、done --child-instance 回填。
  > 子实例状态隔离，仅 Inputs/Outputs 经映射传递。

2. [reason] 基于规整后文档生成摘要
  - ← clean_doc
  + → summary: text  # 摘要
  > 阅读 clean_doc，提炼核心要点生成简洁摘要

# 配套子 spec（独立文件）：examples/call-child-normalize.md
# 父子通过 callee_spec_id 'text-normalize' 关联，由 SpecProvider/CLI 解析定位
