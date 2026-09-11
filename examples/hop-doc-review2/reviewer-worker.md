# Spec: 审查员子实例
Id: reviewer-worker
> 档位: hop（doc-review 主 spec 的 call 对象——审查员与汇聚分析员共用:一份自包含审查指令+一份审查材料,产报告写盘）

## Goal
按完整自包含的审查指令对审查材料执行单视角审查,产出达标报告并写盘到指定位置

## Constraints
- 报告每分析章节 ≤ 200 字、总字数 ≤ 1500 字（汇聚分析员报告 ≤ 3000 字——指令内写明何种角色即按对应上限）
- 报告须含至少 1 处对审查材料具体内容的引用、至少 1 项独立发现、至少 1 项量化判断或可验证建议
- 只审查不修改材料;不与用户交互

## Inputs
- reviewer_prompt: text  # 完整自包含审查指令（角色/立场/推理策略/审查重点/审查问题/输出格式,不依赖上下文）
- review_material: text  # 审查材料全文（审查员=待评审文档;汇聚分析员=全部审查报告拼合）
- report_dir: line  # 报告落盘目录（如 rounds/r001）
- report_file: line  # 报告文件名（如 reviewer_xxx.md 或 synthesis.md）

## Outputs
- report_md: markdown  # 报告全文
- report_receipt: line  # 落盘回执（完整路径）

## Steps
1. [subtask retry=2] 审查与把关
  + → report_md: markdown  # 达标报告
  1.1. [act free] 按 reviewer_prompt 的角色与要求审查 review_material,产出报告全文
    - ← reviewer_prompt, review_material
    + → report_md: markdown  # 报告（格式按指令内输出格式要求）
  1.2. [check final] 报告达标核验
    - ← report_md, reviewer_prompt
    + → ok: bool  # 判定
    + → note: text  # 缺口
    > 三核:①报告含至少 1 处对审查材料具体内容的引用（章节名/段落/数据均可）;②至少 1 项独立发现与 1 项量化判断或可验证建议;③结构与字数符合 reviewer_prompt 内的输出格式要求（章节≤200字;审查员总≤1500字/汇聚≤3000字,按指令内角色判）。任一不满足即 false 打回重做。
2. [commit] 报告写盘
  - ← report_md, report_dir, report_file
  + → report_receipt: line  # 落盘回执
  > ```hop_python
  > makedirs(path: report_dir)
  > write(path: report_dir + "/" + report_file, content: report_md)
  > report_receipt = report_dir + "/" + report_file
  > ```
