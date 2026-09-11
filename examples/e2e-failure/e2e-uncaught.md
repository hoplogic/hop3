# Spec: 平铺流程的未捕获失败
Id: e2e-uncaught
Goal: 平铺三步、无任何事务边界——第 2 步确定性计算异常，验证未捕获失败=实例终止（后续不执行、已产出保留）

## Inputs
- label: text  # 一段文本标签（非数字，如 "north-store"）

## Outputs
- doubled: int  # 第 2 步声明的产出（必然缺席）
- note: text  # 第 3 步声明的产出（必然缺席——实例已终止）

## Steps
1. [act] 记录标签长度
  - ← label
  + → label_len: int  # 标签字符数
  > 纯计算，必然成功——它的产出必须在终态后仍在值空间（fail 不碰值空间的证据）
  > ```hop_python
  > label_len = len(label)
  > ```

2. [act] 对标签做数值减法（刻意的确定性计算异常）
  - ← label
  + → doubled: int  # 减法结果（不会产出）
  > label 是非数字文本，减法必须转数字 → 计算异常 → 本步 fail；祖先无 subtask/case → 未捕获 → 实例终止
  > （不要用 label * 2——Python 语义下 str*int 是合法的字符串重复；也没有 to_number 内置——减法是最短的确定性异常触发器）
  > ```hop_python
  > doubled = label - 1
  > ```

3. [act] 写备注（永远轮不到）
  - ← doubled
  + → note: text  # 备注（不会产出）
  > 实例已在第 2 步终止，本步必须是 skipped——若它执行了，说明"未捕获失败=实例终止"被违反
  > ```hop_python
  > note = "doubled=" + str(doubled)
  > ```
