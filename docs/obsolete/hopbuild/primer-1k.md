# hopskill 构建 · 1k 指针卡

**hopskill** = 把自然语言 skill 翻译成 HopSpec 规约，让引擎强制执行纪律（不再靠 LLM 记住）。写好后 `hopjit validate <spec>` 校验、`/hopspec run` 执行。

## 三条正确性底线（违反=翻译错误）

1. **遍历不漏**：原文每个"对每一个/逐个/遍历" → `[loop for-each x in xs]`（各项独立时体内步骤标 `parallel`）。禁止翻成 act body 循环或 reason"逐个分析"。
2. **审核不跳**：核心是核验——产出核验/每条 Constraints → `check`（关键验收 `subtask` 末尾放 `check final`，不可被跳过）；原文真要人拍板处才用 `confirm`（引擎暂停等真人，LLM 无权替答），人审只是核验的一种形式。
3. **试错不 commit**：不可逆操作（发送/支付/删除/写生产）→ `commit`，前序必有把关（confirm 人审／足够 check／环境预授权，三选一）；可安全重跑的用 `act`。入 retry 容器时把关步骤必须在 commit 之前（探索→验收→提交是正统形态）。

## 选型速查（自然语言措辞 → step 类型）

| 原文说… | 用 |
|---|---|
| 分析/判断/评估 | `reason` |
| 计算/提取/跑脚本（可重跑） | `act` |
| 发送/支付/删除（不可逆） | `commit` |
| 验证/检查/确保 | `check` |
| 让用户确认/审批 | `confirm` |
| 问用户要数据 | `ask` |
| 对每个 X | `loop for-each` |
| 重复直到 | `loop max=N` |
| 如果…否则… | `branch` + `case` |
| 分几步、可能重试 | `subtask retry=N` |
| 调用另一个 spec | `call` |

## 最小骨架

```markdown
# Spec: 标题
Goal: 一句话目标
Inputs:
- name: type  # 一句话说明
Outputs:
- name: type  # 一句话说明
## Steps
1. [reason] 一句话任务
  - ← 输入变量
  + → 输出变量: type  # 首现标类型 + 一句话说明
  > 执行说明
```

## 深入按需拉取（权威判据，构建时必读）

- 三焦点识别信号/模板/反例：`skills/hopbuild/references/three-focus-rules.md`
- 完整骨架+变量语义（累加器等坑）：`references/spec-skeleton.md`
- 13 类型详表：`references/step-type-cheatsheet.md`
- 完整流程协议（含自校验四门）：`skills/hopbuild/SKILL.md`
- 真实样本：`scripts/audit/anchor-audit.md`
