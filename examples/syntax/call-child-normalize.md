# Spec: 文本规整
Id: text-normalize
Goal: 把含噪声的原始文本规整为干净文本——可被多个父 spec 复用的子流程

## Inputs
- raw_text: text  # 原始文本（含多余空行、格式噪声）

## Outputs
- normalized: text  # 规整后文本

## Steps
1. [act] 去噪规整
  - ← raw_text
  + → normalized: text  # 规整后文本
  > 确定性文本变换由 body 引擎直执（零 LLM 零转写）：统一换行符（\r\n/\r → \n）、
  > tab 归一为空格、折叠行内连续空格为单个（多轮减半折叠，常规噪声尺度内收敛）、
  > 逐行 trim 首尾空白、折叠连续空行为单个空行、trim 全文首尾空白。不改语义、不做内容判断。
  > ```hop_python
  > unified = replace(replace(raw_text, "\r\n", "\n"), "\r", "\n")
  > no_tab = replace(unified, "\t", " ")
  > s1 = replace(replace(no_tab, "        ", " "), "    ", " ")
  > s2 = replace(replace(s1, "   ", " "), "  ", " ")
  > one_space = replace(s2, "  ", " ")
  > stripped_lines = [strip(ln) for ln in split(one_space, "\n")]
  > rejoined = join(stripped_lines, "\n")
  > b1 = replace(replace(rejoined, "\n\n\n\n", "\n\n"), "\n\n\n", "\n\n")
  > b2 = replace(b1, "\n\n\n", "\n\n")
  > normalized = strip(b2)
  > ```
