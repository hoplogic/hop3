// @module-deps: spec-parser, spec-ast
import { describe, it, expect } from 'vitest';
import { parseSpec, serializeSpec } from '../src/parser.js';
import { validateSpec } from '../src/validator.js';
import type { SpecAST, SubtaskStep, CommitStep } from '../src/ast-types.js';
import { getChildren } from '../src/ast-helpers.js';

function hasRule(errors: { rule: string }[], rule: string) {
  return errors.some(e => e.rule === rule);
}

function flatCount(steps: import('../src/types.js').StepNode[]): number {
  let count = 0;
  for (const s of steps) {
    count++;
    count += flatCount(getChildren(s));
  }
  return count;
}

// doc-review 评审流程骨架——覆盖多种步骤类型（reason/ask/subtask/loop/branch/case/commit/check/break/exit）
const DOC_REVIEW_SPEC = `# 方案评审流程
Id: doc-review

## Goal
对方案文档进行多视角评审，输出优先问题清单和改进建议

## Constraints
- 审查员视角最多 6 个
- 报告每章 ≤ 200 字

## Types
- ReviewerRole:
    name: text
    stance: text
    strategy: text

## Inputs
- document: markdown  # 待评审文档
- mode: enum(auto_fix,manual_confirm)  # 评审模式

## Outputs
- all_reports: yaml  # 全部审查报告
- final_output: yaml  # 最终产出（修改摘要或对焦结果）

## Steps

1. [reason] 分析文档特征与脆弱点
  - ← document
  + → doc_analysis: text  # 文档类型、核心主张、脆弱点
  > 通读文档，识别文档类型（技术/战略/运营/治理），分析核心判断和脆弱点

2. [ask] 确认评审模式和风险点
  - ← doc_analysis
  + → confirmed_mode: line  # 最终确认的模式

3. [subtask retry=2] 设计审查员角色
  + → reviewer_templates: yaml  # 审查员模板列表
  3.1. [reason] 设计审查员五要素
    - ← doc_analysis
    + → role_designs: yaml  # 角色名称/立场/策略/重点/格式
    > 为每个视角设计完整审查员角色
  3.2. [act] 写入审查员模板文件
    - ← role_designs
    + → template_paths: yaml  # 模板文件路径列表

4. [loop max_iterations=3] 评审轮次
  + → all_reports: yaml  # 全部审查报告
  4.1. [subtask] 发射审查员（轮内产出即被 4.2 消费——非异步派发）
    + → round_reports: yaml  # 本轮报告
    4.1.1. [call] reviewer_agent : 发射审查员 Agent
      - ← document
      + → report  # 审查报告（同名裸名——call 行是输出映射非类型声明,V6 歧义闸 BUG-G）
  4.2. [reason] 验证报告完整性
    - ← round_reports
    + → reports_valid: bool  # 报告是否充分
  4.3. [branch] 判断是否需要更多轮次
    4.3.1. [case] reports_valid == true
      4.3.1.1. [break]
    4.3.2. [case] default
      4.3.2.1. [continue]

5. [branch] 根据评审模式分支
  + → final_output: yaml  # 最终产出
  5.1. [case] confirmed_mode == auto_fix
    5.1.1. [subtask] 执行自动修复
      + → fix_result: yaml  # 修改摘要
      5.1.1.1. [reason] 分析修改清单
        - ← all_reports
        + → fix_plan: yaml  # 修改计划
      5.1.1.2. [commit] 编辑源文档
        - ← fix_plan
        + → approval: bool  # 修改确认
        > 根据修改计划逐条编辑源文档
        > \`\`\`hop_python
        > approval = true
        > \`\`\`
  5.2. [case] confirmed_mode == manual_confirm
    5.2.1. [loop max_iterations=10] 逐条对焦
      + → focus_decisions: yaml  # 对焦结果
      5.2.1.1. [ask] 确认问题处理方式
        + → decision: line  # 真缺口/已解决/非真问题
      5.2.1.2. [act] 记录决策
        - ← decision
        + → decision_record: yaml  # 决策记录
      5.2.1.3. [check] 验证全部问题已处理
        + → all_done: bool  # 是否全部完成
        + → all_done_note: text  # 说明槽:未完成原因(通过时不被查看)
      5.2.1.4. [break]

6. [exit]
`;

// ===== 正向 E2E 链路 =====

describe('E2E: doc-review spec', () => {
  it('parses without errors', () => {
    const { ast, errors } = parseSpec(DOC_REVIEW_SPEC);
    expect(errors).toHaveLength(0);
    expect(ast.header.title).toBe('方案评审流程');
    expect(ast.header.id).toBe('doc-review');
    expect(ast.header.goal).toContain('多视角评审');
    expect(ast.steps).toBeDefined();
  });

  it('validates with no errors (only expected warns)', () => {
    const { ast, errors: parseErrors } = parseSpec(DOC_REVIEW_SPEC);
    expect(parseErrors).toHaveLength(0);
    const errors = validateSpec(ast);
    const errorLevel = errors.filter(e => e.severity === 'error');
    expect(errorLevel).toHaveLength(0);
  });

  it('has expected AST structure', () => {
    const { ast } = parseSpec(DOC_REVIEW_SPEC);
    const steps = ast.steps!;

    expect(steps).toHaveLength(6);
    expect(steps[0].step_type).toBe('reason');
    expect(steps[1].step_type).toBe('ask');
    expect(steps[2].step_type).toBe('subtask');
    expect(steps[3].step_type).toBe('loop');
    expect(steps[4].step_type).toBe('branch');
    expect(steps[5].step_type).toBe('exit');

    const totalSteps = flatCount(steps);
    expect(totalSteps).toBeGreaterThanOrEqual(20);

    expect(ast.header.inputs).toHaveLength(2);
    expect(ast.header.outputs).toHaveLength(2);
    expect(ast.header.constraints).toHaveLength(2);
    expect(ast.header.types).toHaveLength(1);
    expect(ast.header.types![0].name).toBe('ReviewerRole');
  });

  it('round-trips through serialize and re-parse', () => {
    const { ast: ast1 } = parseSpec(DOC_REVIEW_SPEC);
    const serialized = serializeSpec(ast1);
    const { ast: ast2, errors } = parseSpec(serialized);

    expect(errors).toHaveLength(0);
    expect(ast2.header.title).toBe(ast1.header.title);
    expect(ast2.header.goal).toBe(ast1.header.goal);
    expect(ast2.steps).toHaveLength(ast1.steps!.length);

    const total1 = flatCount(ast1.steps!);
    const total2 = flatCount(ast2.steps!);
    expect(total2).toBe(total1);

    for (let i = 0; i < ast1.steps!.length; i++) {
      expect(ast2.steps![i].step_type).toBe(ast1.steps![i].step_type);
      expect(ast2.steps![i].summary).toBe(ast1.steps![i].summary);
    }
  });
});

// ===== 错误检测 E2E =====

describe('E2E: doc-review error detection', () => {
  it('detects P8 when retry subtask contains commit without confirm', () => {
    const { ast } = parseSpec(DOC_REVIEW_SPEC);

    // Mutate: add retry to the auto-fix subtask (step 5.1.1)
    const branchStep = ast.steps![4];
    const autoFixCase = getChildren(branchStep)[0];
    const subtask = getChildren(autoFixCase)[0] as SubtaskStep;
    subtask.retry = 3;

    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P8')).toBe(true);
    expect(errors.find(e => e.rule === 'P8')!.severity).toBe('error');
  });

  it('detects C6 when check is outside subtask', () => {
    const spec = `# Check Outside Subtask

## Goal
Test C6 detection

## Steps
1. [act] Do something
  + → result: text  # result

2. [check] Verify at top level
  - ← result
  + → ok: bool  # verification
  + → ok_note: text  # 说明槽:验证说明
`;
    const { ast, errors: parseErrors } = parseSpec(spec);
    expect(parseErrors).toHaveLength(0);
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C6')).toBe(true);
    expect(errors.find(e => e.rule === 'C6')!.severity).toBe('error');
  });

  it('detects multiple violations in malformed spec', () => {
    const ast: SpecAST = {
      header: { title: '', goal: '' },
      steps: [
        {
          step_id: '1', step_type: 'branch', summary: 'Only one case',
          children: [
            { step_id: '1.1', step_type: 'case', summary: 'Solo', condition: 'x', children: [] },
          ],
        } as any,
        {
          step_id: '2', step_type: 'commit', summary: 'No irreversible_action',
          irreversible_action: '',
        } as CommitStep,
        {
          step_id: '3', step_type: 'break', summary: 'Break outside loop',
        },
      ],
    };

    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S1')).toBe(true);   // empty title
    expect(hasRule(errors, 'S8')).toBe(true);   // empty goal
    expect(hasRule(errors, 'C2')).toBe(false);  // 1 case is now valid (if-then)
    expect(hasRule(errors, 'P5')).toBe(true);   // commit empty irreversible_action
    expect(hasRule(errors, 'C3')).toBe(true);   // break outside loop
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});
