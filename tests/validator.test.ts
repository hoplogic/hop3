// @module: spec-parser ^anc-struct-spec-parser
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSpec, parseFragment, serializeSpec } from '../src/parser.js';
import { validateSpec, repairQuotedPrefixScalars, recoverOutputValues, coerceOutputValues } from '../src/validator.js';
import type { SpecAST, StepNode, SubtaskStep, ParallelStep, LoopStep, BranchStep, CaseStep, CallStep, CommitStep, ExitStep, ConfirmStep } from '../src/ast-types.js';

function validate(md: string) {
  const { ast, errors: parseErrors } = parseSpec(md);
  expect(parseErrors).toHaveLength(0);
  return { ast, errors: validateSpec(ast) };
}

function validateWithParseErrors(md: string) {
  const { ast, errors: parseErrors } = parseSpec(md);
  return { ast, parseErrors, errors: validateSpec(ast) };
}

function hasRule(errors: { rule: string }[], rule: string) {
  return errors.some(e => e.rule === rule);
}

// @v: anc-rule-all, anc-rule-v3-all
// ===== Valid spec baseline =====

const VALID_SPEC = `# Valid Spec

## Goal
Analyze query and route to appropriate handler

## Inputs
- query: text

## Outputs
- result: yaml  # output
- status: line  # status

## Steps
1. [reason] Analyze
  - ← query
  + → analysis: text  # analysis

2. [branch] Route
  2.1. [case] analysis == good
    2.1.1. [act] Process
      - ← analysis
      + → result: yaml  # result
  2.2. [case] default
    2.2.1. [act] Fallback
      + → result: yaml  # fallback result

3. [act] Mark status
  - ← result
  + → status: line  # status
`;

describe('validateSpec — valid spec passes', () => {
  // P10 spec 级两档（2026-08-17 hopissues/hoplogic3/0001——hopkb 截断 spec 过 validate 直接跑;
  // spec 级 Outputs 无产出点升 error,容器级维持 warn）。 // @v: anc-rule-p10
  it('P10 反例：Outputs 声明无任何产出点 → error（截断 spec 静态即拦）', () => {
    const { errors } = validate(`# T
## Goal
g
## Outputs
- outcome: yaml  # o
## Steps
1. [reason] r
  + → x: int  # x
`);
    const hit = errors.filter(e => e.rule === 'P10' && e.severity === 'error');
    expect(hit).toHaveLength(1);
    expect(hit[0].message).toContain('outcome');
  });

  // P10 第三档:条件产出 warn（hopissues/0084,2026-09-10——branch 一臂产出 validate 全绿短路径
  // run 才 failed;必然性三规则=顺序并集/branch 全臂交集/loop 保守不计）。 // @v: anc-rule-p10
  it('P10 第三档正例：Outputs 只在 branch 一臂产出 → warn 点名条件产出（0084 复现件形态）', () => {
    const { errors } = validate(`# CG
## Goal
g
## Inputs
- mode: line  # m
## Outputs
- report: text  # r
## Steps
1. [branch] 分流
  - ← mode
  1.1. [case(mode == "full")] 全量
    1.1.1. [act free] 产报告
      + → report: text  # r
  1.2. [case(else)] 短路
    1.2.1. [act free] 只记日志
      + → short_log: text  # l
2. [exit] 完
`);
    const hit = errors.filter(e => e.rule === 'P10' && e.severity === 'warn' && e.message.includes('report'));
    expect(hit).toHaveLength(1);
    expect(hit[0].message).toContain('条件产出');
  });

  it('P10 第三档反例：全部 case 臂都产出 → 零 warn（交集语义——全臂产出即必然）', () => {
    const { errors } = validate(`# CG2
## Goal
g
## Inputs
- mode: line  # m
## Outputs
- report: text  # r
## Steps
1. [branch] 分流
  - ← mode
  1.1. [case(mode == "full")] 全量
    1.1.1. [act free] 产报告
      + → report: text  # r
  1.2. [case(else)] 短版
    1.2.1. [act free] 产短报告
      + → report: text  # r
2. [exit] 完
`);
    expect(errors.filter(e => e.rule === 'P10' && e.severity === 'warn')).toHaveLength(0);
  });

  it('P10 第三档正例：无 else 臂的 branch 内产出 → warn（条件全不中可跳过整个 branch,任何臂内产出都不必然;原题误标反例,review 修复批更名）', () => {
    const { errors } = validate(`# CG3
## Goal
g
## Inputs
- mode: line  # m
## Outputs
- report: text  # r
## Steps
1. [branch] 分流
  - ← mode
  1.1. [case(mode == "full")] 全量
    1.1.1. [act free] 产报告
      + → report: text  # r
2. [exit] 完
`);
    const hit = errors.filter(e => e.rule === 'P10' && e.severity === 'warn' && e.message.includes('report'));
    expect(hit).toHaveLength(1);
  });

  it('P10 第三档正例：loop 体产出 → warn（保守判不必然——max 允许零迭代）;顺序步产出 → 零 warn', () => {
    const r1 = validate(`# CG4
## Goal
g
## Inputs
- xs: [line]  # x
## Outputs
- out: text  # o
## Steps
1. [loop for-each x in xs] 圈
  1.1. [act free] 产
    + → out: text  # o
2. [exit] 完
`);
    expect(r1.errors.filter(e => e.rule === 'P10' && e.severity === 'warn' && e.message.includes('out'))).toHaveLength(1);
    const r2 = validate(`# CG5
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [act free] 产
  + → out: text  # o
`);
    expect(r2.errors.filter(e => e.rule === 'P10' && e.severity === 'warn')).toHaveLength(0);
  });

  // 第四规则六钉（2026-09-11 review 修复批——变异复核 7 处 3 存活后补严:容器自声明逃逸/on_fail/
  // 触发条件半边/loop collect 零误报/exit 面直测/空 free 豁免显式化）。 // @v: anc-rule-p10
  it('P10 第三档正例：0084 原型包进自声明容器仍 warn（第四规则——容器自声明不短路子树必然性,修复主钉）', () => {
    const { errors } = validate(`# CG6
## Goal
g
## Inputs
- mode: line  # m
## Outputs
- report: markdown  # r
## Steps
1. [subtask] 包一层
  - ← mode
  + → report: markdown  # 聚合出口自声明
  1.1. [branch] 分流
    - ← mode
    1.1.1. [case(mode == "full")] 全
      1.1.1.1. [act free] 产
        + → report: markdown  # r
    1.1.2. [case(else)] 短
      1.1.2.1. [act free] 不产
        + → note: text  # n
2. [exit] 完
`);
    const hit = errors.filter(e => e.rule === 'P10' && e.severity === 'warn' && e.message.includes('report') && e.message.includes('条件产出'));
    expect(hit).toHaveLength(1);
  });

  it('P10 第三档反例：空 [subtask free] 声明交付物 → 零第三档 warn（豁免显式钉——无子步容器自声明计必然）', () => {
    const { errors } = validate(`# CG7
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask free] 后面展开
  + → out: text  # o
`);
    expect(errors.filter(e => e.rule === 'P10' && e.severity === 'warn' && e.message.includes('条件产出'))).toHaveLength(0);
  });

  it('P10 第三档正例：只在 on_fail 兜底块产出 → warn（on_fail 仅失败路径执行,其产出非必然）', () => {
    const { errors } = validate(`# CG8
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=1] 干
  1.1. [act free] 主线不产 out
    + → note: text  # n
  1.2. [on fail] 兜底才产
    1.2.1. [act free] 产
      + → out: text  # o
2. [exit] 完
`);
    const hit = errors.filter(e => e.rule === 'P10' && e.severity === 'warn' && e.message.includes('out') && e.message.includes('条件产出'));
    expect(hit).toHaveLength(1);
  });

  it('P10 第三档反例：loop collect 承接 Outputs → 零第三档 warn（loop 头槽自声明计必然——M6 缺口钉）', () => {
    const { errors } = validate(`# CG9
## Goal
g
## Inputs
- xs: [line]  # x
## Outputs
- rs: [text]  # 收集
## Steps
1. [loop for-each x in xs, collect r into rs] 圈
  + → rs: [text]  # 头槽承接
  1.1. [act free] 产单元
    + → r: text  # u
2. [exit] 完
`);
    expect(errors.filter(e => e.rule === 'P10' && e.severity === 'warn' && e.message.includes('rs') && e.message.includes('条件产出'))).toHaveLength(0);
  });

  it('P10 第三档反例：零产出点变量只吃 error 不叠条件产出 warn（触发条件 allProduced 半边——M3 缺口钉）', () => {
    const { errors } = validate(`# CG10
## Goal
g
## Outputs
- ghost: text  # 无人产出
## Steps
1. [act free] 产别的
  + → other: text  # o
`);
    expect(errors.filter(e => e.rule === 'P10' && e.severity === 'error' && e.message.includes('ghost'))).toHaveLength(1);
    expect(errors.filter(e => e.rule === 'P10' && e.severity === 'warn' && e.message.includes('ghost'))).toHaveLength(0);
  });

  it('P10 第三档反例：exit 前顺序步声明交付 → 零第三档 warn（exit 交付经步骤 +→ 承载——死分支删除后的正门直测）', () => {
    const { errors } = validate(`# CG11
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [act free] 产
  + → out: text  # o
2. [exit] 完
`);
    expect(errors.filter(e => e.rule === 'P10' && e.severity === 'warn' && e.message.includes('out'))).toHaveLength(0);
  });

  it('P10 正例：call 输出映射产出 Outputs → 不误杀（同批修盲区）', () => {
    const { errors } = validate(`# T2
## Goal
g
## Outputs
- result: text  # r
## Steps
1. [call sub(x: "a")] 调
  + → result: sub_out
`);
    expect(errors.filter(e => e.rule === 'P10')).toHaveLength(0);
  });

  it('P10 正例：无 Steps 能力声明 spec 豁免；容器级半边维持 warn 不升 error', () => {
    const { errors: e1 } = validate(`# Trait
## Goal
g
## Outputs
- cap: text  # c
`);
    expect(e1.filter(e => e.rule === 'P10')).toHaveLength(0);
    // 容器 +→ 无子孙产出:warn 档不动（collect/引擎通道产出静态判不死）
    const { errors: e2 } = validate(`# T3
## Goal
g
## Outputs
- final_out: text  # f
## Steps
1. [subtask] s
  + → ghost_out: text  # 无子孙产出
  1.1. [reason] r
    + → final_out: text  # f
    > t
`);
    const containerHit = e2.filter(e => e.rule === 'P10' && e.message.includes('ghost_out'));
    expect(containerHit).toHaveLength(1);
    expect(containerHit[0].severity).toBe('warn');
  });

  it('accepts a well-formed spec with no errors', () => {
    const { errors } = validate(VALID_SPEC);
    const errorLevel = errors.filter(e => e.severity === 'error');
    expect(errorLevel).toHaveLength(0);
  });
});

// ===== S1-S7: Structural rules =====

// @v: anc-rule-s1
describe('S1: title non-empty', () => {
  it('rejects empty title', () => {
    const ast: SpecAST = { header: { title: '' } };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S1')).toBe(true);
  });

  it('accepts non-empty title', () => {
    const ast: SpecAST = { header: { title: 'My Spec' } };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S1')).toBe(false);
  });
});

// @v: anc-rule-s2
describe('S2: step_id format', () => {
  it('rejects step_id containing zero segment', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{ step_id: '0', step_type: 'reason', summary: 'Bad id',
        source_location: { line_start: 3, line_end: 3 } }],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S2')).toBe(true);
  });

  it('accepts valid step_id format', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{ step_id: '1', step_type: 'reason', summary: 'Good id' }],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S2')).toBe(false);
  });
});

// @v: anc-rule-s3
describe('S3: step_id uniqueness', () => {
  it('rejects duplicate step_ids', () => {
    const md = `# Test
## Steps
1. [reason] First
1. [act] Duplicate
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'S3')).toBe(true);
  });
});

// @v: anc-rule-s4
describe('S4: valid step_type', () => {
  it('rejects unknown step_type', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{ step_id: '1', step_type: 'invalid' as any, summary: 'Bad' }],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S4')).toBe(true);
  });

  it('accepts all 13 valid step types; rejects retired parallel type (v0.2.0)', () => {
    const types = ['reason', 'act', 'check', 'confirm', 'commit', 'call',
      'subtask', 'loop', 'branch', 'case', 'break', 'continue', 'exit'];
    for (const t of types) {
      const ast: SpecAST = {
        header: { title: 'Test' },
        steps: [{ step_id: '1', step_type: t as any, summary: 'Step' }],
      };
      const errors = validateSpec(ast);
      expect(hasRule(errors, 'S4')).toBe(false);
    }
    // parallel 类型已退役（降属性）——现在必须被 S4 拒
    const retired = validateSpec({ header: { title: 'T' },
      steps: [{ step_id: '1', step_type: 'parallel' as any, summary: 'S' }] });
    expect(hasRule(retired, 'S4')).toBe(true);
  });
});

// @v: anc-rule-s5
describe('S5: container must have children', () => {
  it('rejects empty subtask', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{ step_id: '1', step_type: 'subtask', summary: 'Empty', children: [] } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S5')).toBe(true);
  });

  it('accepts subtask with children', () => {
    const md = `# Test
## Steps
1. [subtask] Has children
  1.1. [reason] Child
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'S5')).toBe(false);
  });
});

// @v: anc-rule-s6
describe('S6: child step_id prefix', () => {
  it('rejects mismatched child prefix', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Parent',
        children: [{ step_id: '2.1', step_type: 'reason', summary: 'Bad child',
          source_location: { line_start: 5, line_end: 5 } }],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S6')).toBe(true);
  });
});

// @v: anc-rule-s7
describe('S7: top-level step_id must be single number', () => {
  it('rejects nested id at top level', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{ step_id: '1.1', step_type: 'reason', summary: 'Nested at top',
        source_location: { line_start: 3, line_end: 3 } }],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S7')).toBe(true);
  });
});

// ===== C1-C5: Control flow rules =====

// @v: anc-rule-c1
describe('C1: case only in branch', () => {
  it('rejects case outside branch', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Not branch',
        children: [{ step_id: '1.1', step_type: 'case', summary: 'Orphan case', condition: 'x', children: [] } as CaseStep],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C1')).toBe(true);
  });

  it('accepts case inside branch', () => {
    const md = `# Test
## Steps
1. [branch] Route
  1.1. [case] a
    1.1.1. [act] Do a
  1.2. [case] b
    1.2.1. [act] Do b
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'C1')).toBe(false);
  });
});

// @v: anc-rule-c2
describe('C2: branch children all case, ≥1', () => {
  it('accepts branch with 1 case (if-then)', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'branch', summary: 'Single case',
        children: [{ step_id: '1.1', step_type: 'case', summary: 'Only', condition: 'x', children: [] } as CaseStep],
      } as BranchStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C2')).toBe(false);
  });

  it('accepts branch with exactly 2 cases', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'branch', summary: 'Two cases',
        children: [
          { step_id: '1.1', step_type: 'case', summary: 'A', condition: 'x', children: [] } as CaseStep,
          { step_id: '1.2', step_type: 'case', summary: 'B', condition: 'default', children: [] } as CaseStep,
        ],
      } as BranchStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C2')).toBe(false);
  });

  it('rejects branch with a non-case child', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'branch', summary: 'Mixed children',
        children: [
          { step_id: '1.1', step_type: 'case', summary: 'A', condition: 'x', children: [] } as CaseStep,
          { step_id: '1.2', step_type: 'reason', summary: 'Not a case' } as StepNode,
        ],
      } as BranchStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C2')).toBe(true);
  });

  it('rejects branch with zero children', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'branch', summary: 'Empty branch',
        children: [],
      } as BranchStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C2')).toBe(true);
  });
});

// @v: anc-rule-p10
describe('P10: declared output should have a producer (static reachability)', () => {
  it('warns when a container declares +→ output no descendant produces', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Container',
        outputs: [{ name: 'never_produced', type: 'text', description: 'x' }],
        children: [
          { step_id: '1.1', step_type: 'reason', summary: 'Child',
            outputs: [{ name: 'other', type: 'text', description: 'o' }] } as StepNode,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P10')).toBe(true);
  });

  it('warns when a Spec Output has no producing step', () => {
    const ast: SpecAST = {
      header: { title: 'Test', outputs: [{ name: 'orphan_result', type: 'text', description: 'r' }] },
      steps: [{
        step_id: '1', step_type: 'reason', summary: 'Produces something else',
        outputs: [{ name: 'unrelated', type: 'text', description: 'u' }],
      } as StepNode],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P10')).toBe(true);
  });

  it('does not warn when any branch case produces the declared output (branch merge exemption)', () => {
    // 新模型: case≡subtask, 自声明聚合输出 findings, 由子步骤产出; branch 不声明输出。
    // header.findings 由命中 case 的子步骤产出 → 经作用域提升 → P10 不报。
    const ast: SpecAST = {
      header: { title: 'Test', outputs: [{ name: 'findings', type: 'text', description: 'f' }] },
      steps: [{
        step_id: '1', step_type: 'branch', summary: 'Branch produces via one case',
        children: [
          { step_id: '1.1', step_type: 'case', summary: 'A', condition: 'x',
            outputs: [{ name: 'findings', type: 'text', description: 'f' }],
            children: [
              { step_id: '1.1.1', step_type: 'reason', summary: 'produce findings',
                outputs: [{ name: 'findings', type: 'text', description: 'f' }] } as StepNode,
            ] } as CaseStep,
          { step_id: '1.2', step_type: 'case', summary: 'B', condition: 'default',
            outputs: [{ name: 'findings', type: 'text', description: 'f' }],
            children: [
              { step_id: '1.2.1', step_type: 'reason', summary: 'produce findings',
                outputs: [{ name: 'findings', type: 'text', description: 'f' }] } as StepNode,
            ] } as CaseStep,
        ],
      } as BranchStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P10')).toBe(false);
  });
});

// @v: anc-rule-c3
describe('C3: break/continue only in loop', () => {
  it('rejects break outside loop', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Not loop',
        children: [{ step_id: '1.1', step_type: 'break', summary: 'Bad break' }],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C3')).toBe(true);
  });

  it('accepts break inside loop', () => {
    const md = `# Test
## Steps
1. [loop] Repeat
  1.1. [break]
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'C3')).toBe(false);
  });

  it('accepts break inside nested structure within loop', () => {
    const md = `# Test
## Steps
1. [loop] Repeat
  1.1. [branch] Check
    1.1.1. [case] done
      1.1.1.1. [break]
    1.1.2. [case] default
      1.1.2.1. [continue]
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'C3')).toBe(false);
  });

  // 可选目标形态（方案 B 2026-08-16 作者拍板）：[break <步骤号>] 目标须存在+是 loop+是祖先
  it('accepts break with ancestor loop target (multi-level jump-out)', () => {
    const md = `# Test
## Steps
1. [loop max=3] Outer
  1.1. [loop max=3] Inner
    1.1.1. [branch] Check
      1.1.1.1. [case(x == 1)] hit
        1.1.1.1.1. [break 1]
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'C3')).toBe(false);
  });

  it('rejects break target that does not exist', () => {
    const md = `# Test
## Steps
1. [loop max=3] Repeat
  1.1. [break 9]
`;
    const { errors } = validate(md);
    expect(errors.some(e => e.rule === 'C3' && e.message.includes('does not exist'))).toBe(true);
  });

  it('rejects break target that is not a loop', () => {
    const md = `# Test
## Steps
1. [loop max=3] Repeat
  1.1. [subtask] Group
    1.1.1. [break 1.1]
`;
    const { errors } = validate(md);
    expect(errors.some(e => e.rule === 'C3' && e.message.includes('not a loop'))).toBe(true);
  });

  it('rejects continue target that is a non-ancestor loop', () => {
    const md = `# Test
## Steps
1. [loop max=3] First
  1.1. [reason] Work
    + → x: int  # v
2. [loop max=3] Second
  2.1. [continue 1]
`;
    const { errors } = validate(md);
    expect(errors.some(e => e.rule === 'C3' && e.message.includes('not an ancestor'))).toBe(true);
  });
});

// @v: anc-rule-c5
describe('C5: loop termination', () => {
  it('warns about loop without termination path', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'loop', summary: 'Infinite',
        children: [{ step_id: '1.1', step_type: 'act', summary: 'Just act' }],
      } as LoopStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C5')).toBe(true);
    expect(errors.find(e => e.rule === 'C5')!.severity).toBe('warn');
  });

  it('accepts loop with max_iterations', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'loop', summary: 'Bounded', max_iterations: 10,
        children: [{ step_id: '1.1', step_type: 'act', summary: 'Work' }],
      } as LoopStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C5')).toBe(false);
  });

  it('accepts loop with break in branch', () => {
    const md = `# Test
## Steps
1. [loop] With break
  1.1. [branch] Check
    1.1.1. [case] done
      1.1.1.1. [break]
    1.1.2. [case] default
      1.1.2.1. [act] Continue work
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'C5')).toBe(false);
  });
});

// ===== V1-V6: Variable rules =====

// @v: anc-rule-v1
describe('V1: input references exist', () => {
  it('rejects reference to undefined variable', () => {
    const md = `# Test
## Steps
1. [reason] Think
  - ← nonexistent_var
  + → out: text
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'V1')).toBe(true);
  });

  it('accepts reference to header input', () => {
    const md = `# Test
## Inputs
- query: text

## Steps
1. [reason] Think
  - ← query
  + → out: text
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'V1')).toBe(false);
  });

  // @v: anc-exec-parallel-foreach
  it('accepts for-each itemVar reference inside parallel child', () => {
    const md = `# Test
## Inputs
- items: [text]

## Steps
1. [loop for-each item in items, collect result_item into result] Fan out
  + → result: [text]
  1.1. [subtask parallel] One
    - ← item
    + → result_item: text
    1.1.1. [reason] Do
      - ← item
      + → result_item: text
      > do
`;
    const { errors } = validate(md);
    // itemVar "item" 在 child scope 可见，不应报 V1
    expect(hasRule(errors, 'V1')).toBe(false);
  });

  it('accepts reference to preceding step output', () => {
    const md = `# Test
## Steps
1. [reason] Produce
  + → x: text

2. [act] Consume
  - ← x
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'V1')).toBe(false);
  });
});

// @v: anc-rule-v2
describe('V2: 同名=同一变量(2026-08-09 扁平命名空间重定义)', () => {
  it('同名同类型 = 同一变量多次赋值,合法(Python 重新赋值语义)', () => {
    const md = `# Test
## Steps
1. [reason] First
  + → x: text

2. [reason] Second
  + → x: text
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'V2')).toBe(false);
  });

  it('同名异类型 = 两个数据抢一个名字,V2 error', () => {
    const md = `# Test
## Steps
1. [reason] First
  + → x: text

2. [reason] Second
  + → x: int
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'V2')).toBe(true);
    expect(errors.find(e => e.rule === 'V2')!.message).toContain('conflicting type');
  });

  it('allows same output name in different scopes (parent vs child)', () => {
    const md = `# Test
## Steps
1. [reason] Produce x
  + → x: text

2. [subtask] Container
  2.1. [reason] Produce x in child scope
    + → y: text
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'V2')).toBe(false);
  });
});

// @v: anc-rule-v3
describe('V3【已废除 2026-08-09】: 扁平命名空间无遮蔽', () => {
  it('深层同名同型输出 = 同一变量,零 V3/V2(旧遮蔽场景全面合法化)', () => {
    const md = `# Test
## Steps
1. [reason] Outer
  + → data: text

2. [subtask] Container
  + → other: text
  2.1. [reason] Inner writes same var
    + → data: text
  2.2. [reason] use
    - ← data
    + → other: text
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'V3')).toBe(false);
    expect(hasRule(errors, 'V2')).toBe(false);
  });
});

// @v: anc-rule-v4
describe('V4: valid output types', () => {
  it('rejects invalid type string', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'reason', summary: 'Bad type',
        outputs: [{ name: 'x', type: 'invalid type with spaces', description: '' }],
      }],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V4')).toBe(true);
  });

  it('accepts all builtin types', () => {
    const types = ['text', 'bool', 'line', 'int', 'markdown', 'yaml', 'prompt', '[line]'];   // number 除名(2026-08-31 与 Python 一致)
    for (const t of types) {
      const ast: SpecAST = {
        header: { title: 'Test' },
        steps: [{
          step_id: '1', step_type: 'reason', summary: 'OK',
          outputs: [{ name: 'x', type: t, description: '' }],
        }],
      };
      const errors = validateSpec(ast);
      expect(hasRule(errors, 'V4')).toBe(false);
    }
  });

  it('accepts enum type', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'reason', summary: 'OK',
        outputs: [{ name: 'x', type: 'enum(low,medium,high)', description: '' }],
      }],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V4')).toBe(false);
  });

  it('accepts custom TypeDecl name when declared in Types', () => {
    const ast: SpecAST = {
      header: { title: 'Test', types: [{ name: 'SearchResult', fields: { query: 'text' } }] },
      steps: [{
        step_id: '1', step_type: 'reason', summary: 'OK',
        outputs: [{ name: 'x', type: 'SearchResult', description: '' }],
      }],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V4')).toBe(false);
  });

  it('rejects undeclared custom type name', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'reason', summary: 'OK',
        outputs: [{ name: 'x', type: 'UndeclaredType', description: '' }],
      }],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V4')).toBe(true);
  });
});

// @v: anc-rule-v5
describe('V5: input names unique', () => {
  it('rejects duplicate input names', () => {
    const ast: SpecAST = {
      header: {
        title: 'Test',
        inputs: [
          { name: 'x', type: 'text' },
          { name: 'x', type: 'int' },
        ],
      },
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V5')).toBe(true);
  });

  it('accepts unique input names', () => {
    const ast: SpecAST = {
      header: {
        title: 'Test',
        goal: 'Test',
        inputs: [
          { name: 'x', type: 'text' },
          { name: 'y', type: 'int' },
        ],
      },
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V5')).toBe(false);
  });
});

// @v: anc-rule-v6
describe('V6: call param_mapping validity', () => {
  it('rejects empty from in param_mapping', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'call', summary: 'Bad call',
        callee_spec_id: 'child',
        param_mapping: [{ from: '', to: 'input' }],
        source_location: { line_start: 3, line_end: 3 },
      } as CallStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V6')).toBe(true);
  });
});

// ===== P1-P7: Special step rules =====

// @v: anc-rule-p1
describe('P1: call must have callee_spec_id', () => {
  it('rejects call without callee_spec_id', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{ step_id: '1', step_type: 'call', summary: 'No callee' } as CallStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P1')).toBe(true);
  });

  it('accepts call with callee_spec_id', () => {
    const md = `# Test
## Steps
1. [call] child_spec : Do child work
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'P1')).toBe(false);
  });
});

// @v: anc-rule-p2
describe('P2【已废除】commit 不再要求 approval 输出', () => {
  // P2 源于旧 commit 语义（自带审批），新概念授权前置 confirm、commit 不自带审批 → 废除。
  // 回归：commit 不声明 approval 也不应报 P2。
  it('commit 不声明 approval 不报 P2', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'commit', summary: 'Delete',
        irreversible_action: 'delete everything',
      } as CommitStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P2')).toBe(false);
  });
});

// @v: anc-rule-p3
describe('P3: confirm response_options', () => {
  it('warns about empty response_options', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'confirm', summary: 'Confirm',
        response_options: [],
      } as ConfirmStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P3')).toBe(true);
  });

  it('accepts confirm with valid response_options', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'confirm', summary: 'Confirm',
        response_options: [{ value: 'yes', label: 'Approve' }],
      } as ConfirmStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P3')).toBe(false);
  });
});

// @v: anc-rule-p12, anc-step-confirm
describe('P12: confirm output must be bool (纯审批闸门)', () => {
  it('rejects confirm with non-bool output', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'confirm', summary: 'Confirm',
        outputs: [{ name: 'doc_type', type: 'line', description: '类型' }],
      } as ConfirmStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P12')).toBe(true);
  });

  it('accepts confirm with bool output', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'confirm', summary: 'Confirm',
        outputs: [{ name: 'approval', type: 'bool', description: '审批' }],
      } as ConfirmStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P12')).toBe(false);
  });
});

// @v: anc-rule-p11, anc-step-check
// P11 守 check 的**固定双槽签名**（恰好 1 bool 判定槽 + 1 text 说明槽，封闭、不能多/少/换类型）——
// 这是概念层 ^anc-step-check 的核心契约，也是引擎"按类型定位 bool 槽"（^anc-exec-check-verdict）的前提：
// 签名校验失效 → 判定逻辑可能取到错的槽。故违反形态需逐一覆盖，不能只测 happy path。
describe('P11: check fixed two-slot signature', () => {
  const checkWith = (outputs: unknown[]): SpecAST => ({
    header: { title: 'Test' },
    steps: [{
      step_id: '1', step_type: 'subtask', summary: 'Container',
      children: [{ step_id: '1.1', step_type: 'check', summary: 'Verify', outputs } as any],
    } as any],
  });

  it('accepts exactly one bool + one text', () => {
    const errors = validateSpec(checkWith([
      { name: 'ok', type: 'bool', description: '判定槽' },
      { name: 'why', type: 'text', description: '说明槽' },
    ]));
    expect(hasRule(errors, 'P11')).toBe(false);
  });

  // 说明槽双档（^anc-exec-check-escalate 升格半边——yaml=结构化缺口档,text=缺省档）
  it('accepts bool + yaml explanation slot (双档,0006 批)', () => {
    const errors = validateSpec(checkWith([
      { name: 'ok', type: 'bool', description: '判定槽' },
      { name: 'gap', type: 'yaml', description: '缺口槽' },
    ]));
    expect(hasRule(errors, 'P11')).toBe(false);
  });

  // E1: escalatable 授权前提——说明槽须 yaml（正反成对） // @v: anc-exec-check-escalate
  it('E1 反例：escalatable 而说明槽是 text → error 指路', () => {
    const ast: SpecAST = {
      header: { title: 'T' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'C',
        children: [{ step_id: '1.1', step_type: 'check', summary: 'V', escalatable: true, outputs: [
          { name: 'ok', type: 'bool', description: '判' },
          { name: 'why', type: 'text', description: '说' },
        ] } as any],
      } as any],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'E1')).toBe(true);
  });

  it('E1 正例：escalatable + yaml 说明槽 → 零 E1', () => {
    const ast: SpecAST = {
      header: { title: 'T' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'C',
        children: [{ step_id: '1.1', step_type: 'check', summary: 'V', escalatable: true, outputs: [
          { name: 'ok', type: 'bool', description: '判' },
          { name: 'gap', type: 'yaml', description: '缺口' },
        ] } as any],
      } as any],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'E1')).toBe(false);
    expect(hasRule(errors, 'P11')).toBe(false);
  });

  it('rejects missing text slot (only bool)', () => {
    const errors = validateSpec(checkWith([{ name: 'ok', type: 'bool', description: '判定槽' }]));
    expect(hasRule(errors, 'P11')).toBe(true);
  });

  it('rejects missing bool slot (only text)', () => {
    const errors = validateSpec(checkWith([{ name: 'why', type: 'text', description: '说明槽' }]));
    expect(hasRule(errors, 'P11')).toBe(true);
  });

  it('rejects no outputs at all', () => {
    const errors = validateSpec(checkWith([]));
    expect(hasRule(errors, 'P11')).toBe(true);
  });

  it('rejects extra third slot (bool + text + line)', () => {
    const errors = validateSpec(checkWith([
      { name: 'ok', type: 'bool', description: '判定槽' },
      { name: 'why', type: 'text', description: '说明槽' },
      { name: 'extra', type: 'line', description: '多余槽' },
    ]));
    expect(hasRule(errors, 'P11')).toBe(true);
  });

  it('rejects wrong types (two bools — 引擎按类型定位会取到歧义槽)', () => {
    const errors = validateSpec(checkWith([
      { name: 'ok', type: 'bool', description: '判定槽' },
      { name: 'also_ok', type: 'bool', description: '又一个 bool' },
    ]));
    expect(hasRule(errors, 'P11')).toBe(true);
  });
});

// @v: anc-rule-p13, anc-step-ask
describe('P13: ask must declare +→ output', () => {
  it('rejects ask without output', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'ask', summary: 'Ask',
      } as any],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P13')).toBe(true);
  });

  it('accepts ask with output (any type)', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'ask', summary: 'Ask',
        outputs: [{ name: 'doc_type', type: 'line', description: '类型' }],
      } as any],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P13')).toBe(false);
  });
});

// @v: anc-rule-p14, anc-step-ask
describe('P14: ask present_inputs must be subset of ← inputs', () => {
  it('rejects present_inputs name not in ← inputs', () => {
    const ast: SpecAST = {
      header: { title: 'Test', inputs: [{ name: 'foo', type: 'text' }] },
      steps: [{
        step_id: '1', step_type: 'ask', summary: 'Ask',
        inputs: [{ name: 'foo', source: 'foo' }],
        outputs: [{ name: 'out', type: 'text', description: 'o' }],
        present_inputs: ['bar'],  // bar 不在 ← inputs
      } as any],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P14')).toBe(true);
  });

  it('accepts present_inputs ⊆ ← inputs', () => {
    const ast: SpecAST = {
      header: { title: 'Test', inputs: [{ name: 'foo', type: 'text' }, { name: 'baz', type: 'text' }] },
      steps: [{
        step_id: '1', step_type: 'ask', summary: 'Ask',
        inputs: [{ name: 'foo', source: 'foo' }, { name: 'baz', source: 'baz' }],
        outputs: [{ name: 'out', type: 'text', description: 'o' }],
        present_inputs: ['foo', 'baz'],  // 全在 ← inputs
      } as any],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P14')).toBe(false);
  });

  it('accepts ask without present_inputs (backwards compat)', () => {
    const ast: SpecAST = {
      header: { title: 'Test', inputs: [{ name: 'foo', type: 'text' }] },
      steps: [{
        step_id: '1', step_type: 'ask', summary: 'Ask',
        inputs: [{ name: 'foo', source: 'foo' }],
        outputs: [{ name: 'out', type: 'text', description: 'o' }],
      } as any],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P14')).toBe(false);
  });
});

// @v: anc-rule-p4
describe('P4: exit outputs must exactly match header outputs', () => {
  // @v: anc-rule-p4 （流控步body死代码闸,2026-08-25作者拍板B——0027真病灶:exit带hop_python
  // 围栏零执行但validate绿,run必然完备性违约failed,必死假绿）
  it('反例：break/continue 带 hop_python body → P4 error（流控三型全谱）', () => {
    const mk = (flowStep) => `# T

## Goal
G

## Inputs
- xs: [line]

## Outputs
- rs: [line]  # rs

## Steps
1. [loop for-each x in xs, collect r into rs] L
  + → rs: [line]  # rs

  1.1. [act] A
    - ← x
    + → r: line  # r
    > \`\`\`hop_python
    > r = x
    > \`\`\`

  1.2. ${flowStep}
    > \`\`\`hop_python
    > r = "dead"
    > \`\`\`
`;
    for (const fs of ['[break] 跳出', '[continue] 下一轮']) {
      const { errors } = validate(mk(fs));
      expect(errors.some(e => e.rule === 'P4' && /死代码/.test(e.message)), fs).toBe(true);
    }
  });

  it('反例：容器步（subtask/loop/case/on_fail）带 hop_python body → P4 error（29轮扩——容器 instruction 零执行通道,骨架只渲染 summary）', () => {
    const subtaskCase = validate(`# T

## Goal
G

## Inputs
- s: line

## Outputs
- r: text

## Steps
1. [subtask] S
  + → r: text
  > \`\`\`hop_python
  > r = s
  > \`\`\`

  1.1. [act] A
    - ← s
    + → r: text
    > \`\`\`hop_python
    > r = s
    > \`\`\`
`);
    expect(subtaskCase.errors.some(e => e.rule === 'P4' && /subtask 步 "1".*死代码/.test(e.message))).toBe(true);

    const loopCase = validate(`# T

## Goal
G

## Inputs
- xs: [line]

## Outputs
- rs: [line]  # rs

## Steps
1. [loop for-each x in xs, collect r into rs] L
  + → rs: [line]  # rs
  > \`\`\`hop_python
  > rs = []
  > \`\`\`

  1.1. [act] A
    - ← x
    + → r: line  # r
    > \`\`\`hop_python
    > r = x
    > \`\`\`
`);
    expect(loopCase.errors.some(e => e.rule === 'P4' && /loop 步 "1".*死代码/.test(e.message))).toBe(true);
  });

  it('正例：reason/confirm/ask 带围栏零误伤（instruction 进 LLM prompt/问人文本,非死代码）', () => {
    const { errors } = validate(`# T

## Goal
G

## Inputs
- s: line

## Outputs
- r: text

## Steps
1. [reason] R——按下面公式算
  - ← s
  + → r: text
  > 参考公式：
  > \`\`\`hop_python
  > r = "x" + s
  > \`\`\`
`);
    expect(errors.filter(e => e.rule === 'P4' && e.severity === 'error')).toHaveLength(0);
  });

  it('反例：exit/break/continue 带 hop_python body → P4 error 指路前置act', () => {
    const exitCase = validate(`# T

## Goal
G

## Inputs
- seed: line

## Outputs
- result_text: text

## Steps
1. [act] 置值
  - ← seed
  + → answer: text
  > \`\`\`hop_python
  > answer = seed
  > \`\`\`

2. [exit] 交付
  - ← answer
  + → result_text: text
  > \`\`\`hop_python
  > result_text = "got: " + answer
  > \`\`\`
`);
    const hit = exitCase.errors.find(e => e.rule === 'P4' && /死代码/.test(e.message));
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/exit 裸交付/);
  });

  it('正例：exit 裸交付/带散文说明零误伤', () => {
    const { errors } = validate(`# T

## Goal
G

## Inputs
- seed: line

## Outputs
- result_text: text

## Steps
1. [act] 算结果
  - ← seed
  + → result_text: text
  > \`\`\`hop_python
  > result_text = "got: " + seed
  > \`\`\`

2. [exit] 交付
  + → result_text
  > 交付最终结果文本
`);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });


  it('rejects exit output not in header', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test', outputs: [{ name: 'result', type: 'text', description: 'r' }] },
      steps: [{
        step_id: '1', step_type: 'exit', summary: 'Early exit',
        outputs: [{ name: 'result', type: '', description: '' }, { name: 'extra', type: '', description: '' }],
      } as unknown as ExitStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P4')).toBe(true);
  });

  it('rejects exit with missing required output', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test', outputs: [
        { name: 'result', type: 'text', description: 'r' },
        { name: 'status', type: 'line', description: 's' },
      ]},
      steps: [{
        step_id: '1', step_type: 'exit', summary: 'Early exit',
        outputs: [{ name: 'result', type: '', description: '' }],
      } as unknown as ExitStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P4')).toBe(true);
    expect(errors.filter(e => e.rule === 'P4')).toHaveLength(1);
    expect(errors.find(e => e.rule === 'P4')!.message).toContain('missing required output');
  });

  it('accepts exit with exact match of header outputs', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test', outputs: [{ name: 'result', type: 'text', description: 'r' }] },
      steps: [{
        step_id: '1', step_type: 'exit', summary: 'Early exit',
        outputs: [{ name: 'result', type: '', description: '' }],
      } as unknown as ExitStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P4')).toBe(false);
  });

  it('accepts exit without exit_outputs (bare exit)', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test', outputs: [{ name: 'result', type: 'text', description: 'r' }] },
      steps: [{
        step_id: '1', step_type: 'exit', summary: 'Early exit',
      } as ExitStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P4')).toBe(false);
  });
});

// @v: anc-rule-p5
describe('P5: commit irreversible_action non-empty', () => {
  it('rejects commit with empty irreversible_action', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'commit', summary: 'Delete',
        irreversible_action: '',
      } as CommitStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P5')).toBe(true);
  });

  it('rejects commit with undefined irreversible_action', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'commit', summary: 'Delete',
      } as CommitStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P5')).toBe(true);
  });

  it('accepts commit with non-empty irreversible_action', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'commit', summary: 'Delete',
        irreversible_action: 'permanently delete user data',
      } as CommitStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P5')).toBe(false);
  });
});

// @v: anc-rule-p6
describe('P6: retry/max_iterations bounds', () => {
  it('warns about subtask retry < 1', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Bad retry',
        retry: 0, children: [{ step_id: '1.1', step_type: 'act', summary: 'x' }],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P6')).toBe(true);
    expect(errors.find(e => e.rule === 'P6')!.severity).toBe('warn');
  });

  it('warns about loop max_iterations < 1', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'loop', summary: 'Bad loop',
        max_iterations: 0, children: [{ step_id: '1.1', step_type: 'break', summary: 'x' }],
      } as LoopStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P6')).toBe(true);
  });

  // 正例（2026-09-05 作者拍"修"——0069 压力语料实撞:retry=0+on fail="失败不盲重跑直落兜底"
  // 是引擎支持的正当写法,两处主线容器刻意如此仍被 P6 误警）：带 on_fail 兜底的 retry=0 不告警
  it('retry=0 且容器带 [on fail] 兜底 → P6 不告警（失败直落兜底是正当写法）', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: '主线失败即转诊断不盲重跑',
        retry: 0, children: [
          { step_id: '1.1', step_type: 'act', summary: 'x' },
          { step_id: '1.2', step_type: 'on_fail', summary: '兜底交诊断包', children: [{ step_id: '1.2.1', step_type: 'act', summary: '组装诊断包' }] },
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P6')).toBe(false);
  });

  // 反例边界:无 on_fail 的 retry=0 照警（那才是真的"失败无出路"——上面首个正例已钉,此处钉报文指路句）
  it('retry=0 无兜底的告警报文含 [on fail] 指路', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Bad retry',
        retry: 0, children: [{ step_id: '1.1', step_type: 'act', summary: 'x' }],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    const p6 = errors.find(e => e.rule === 'P6');
    expect(p6).toBeDefined();
    expect(p6!.message).toContain('on fail');
  });
});

// @v: anc-rule-p7
describe('P7: response option values', () => {
  it('warns about empty value in response option', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'confirm', summary: 'Confirm',
        response_options: [{ value: '', label: 'OK' }],
      } as ConfirmStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P7')).toBe(true);
  });
});

// ===== Cross-scope variable visibility =====

describe('variable scope — cross-level references', () => {
  it('child can see parent scope outputs', () => {
    const md = `# Test
## Inputs
- query: text

## Steps
1. [reason] Produce
  - ← query
  + → x: text

2. [subtask] Container
  2.1. [act] Use parent output
    - ← x
    + → y: text
`;
    const { errors } = validate(md);
    const v1errors = errors.filter(e => e.rule === 'V1');
    expect(v1errors).toHaveLength(0);
  });

  it('sibling cannot see output from later step', () => {
    const md = `# Test
## Steps
1. [act] Use future output
  - ← future_var

2. [reason] Produce future var
  + → future_var: text
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'V1')).toBe(true);
  });
});

// ===== Coverage: V6 empty 'to' =====

// @v: anc-rule-v6
describe('V6: call param_mapping empty to', () => {
  it('rejects empty to in param_mapping', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'call', summary: 'Bad call',
        callee_spec_id: 'child',
        param_mapping: [{ from: 'input', to: '' }],
      } as CallStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V6')).toBe(true);
    expect(errors.find(e => e.rule === 'V6')!.message).toMatch(/empty.*to/i);
  });
});

// ===== Coverage: P7 empty label (not just value) =====

// @v: anc-rule-p7
describe('P7: empty label in response option', () => {
  it('warns about empty label with non-empty value', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'confirm', summary: 'Confirm',
        response_options: [{ value: 'yes', label: '' }],
      } as ConfirmStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P7')).toBe(true);
  });
});

// ===== Coverage: C5 nested loop — inner break doesn't terminate outer =====

// @v: anc-rule-c5
describe('C5: nested loop termination isolation', () => {
  it('warns when outer loop has no termination but inner loop does', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'loop', summary: 'Outer',
        children: [{
          step_id: '1.1', step_type: 'loop', summary: 'Inner',
          max_iterations: 5,
          children: [{ step_id: '1.1.1', step_type: 'break', summary: 'Break inner' }],
        } as LoopStep],
      } as LoopStep],
    };
    const errors = validateSpec(ast);
    // Outer loop has no break/exit/max_iterations — inner loop's break doesn't count
    expect(errors.some(e => e.rule === 'C5' && e.step_id === '1')).toBe(true);
  });
});

// ===== Coverage: S6 — exercise via parsed markdown with correct children =====

// @v: anc-rule-s6
describe('S6: child prefix — valid parsed spec', () => {
  it('accepts correctly prefixed children from parsed markdown', () => {
    const md = `# Test
## Steps
1. [subtask] Parent
  1.1. [act] Valid child
  1.2. [reason] Another valid child
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'S6')).toBe(false);
  });
});

// ===== Coverage: C3 — continue outside loop =====

// @v: anc-rule-c3
describe('C3: continue outside loop', () => {
  it('rejects continue outside loop', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Not loop',
        children: [{ step_id: '1.1', step_type: 'continue', summary: 'Bad continue' }],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C3')).toBe(true);
  });
});

// ===== Coverage: V6 call with valid param_mapping =====

// @v: anc-rule-v6
describe('V6: valid param_mapping passes', () => {
  it('accepts call with valid from and to', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'call', summary: 'Good call',
        callee_spec_id: 'child',
        param_mapping: [{ from: 'input_var', to: 'callee_input' }],
      } as CallStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V6')).toBe(false);
  });
});

// V12：call param_mapping 映射来源禁点路径（2026-09-01 dr21 十六撞立规,作者拍 A 案响亮拒——
// resolveCallParams 按整名查父变量,item.x 查不到静默跳过,5/5 子实例拿 undefined 全灭）。
// @v: anc-rule-v12
describe('V12: call param_mapping 映射来源禁点路径', () => {
  it('反例：item.x 点路径来源 → V12 error 指路拆平', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'call', summary: 'bad call',
        callee_spec_id: 'child',
        param_mapping: [{ from: 'item.reviewer_prompt', to: 'reviewer_prompt' }],
      } as CallStep],
    };
    const errors = validateSpec(ast);
    const hit = errors.find(e => e.rule === 'V12');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('error');
    expect(hit!.message).toContain('拆平');
  });

  it('正例：整名变量来源放行', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'call', summary: 'good call',
        callee_spec_id: 'child',
        param_mapping: [{ from: 'cur_prompt', to: 'reviewer_prompt' }],
      } as CallStep],
    };
    expect(hasRule(validateSpec(ast), 'V12')).toBe(false);
  });

  it('正例：字面量项含点（"a.b" 字符串）豁免不误拦', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [{
        step_id: '1', step_type: 'call', summary: 'literal call',
        callee_spec_id: 'child',
        param_mapping: [{ from: '"a.b"', to: 'key', literal_value: 'a.b' }],
      } as CallStep],
    };
    expect(hasRule(validateSpec(ast), 'V12')).toBe(false);
  });
});

// ===== S8: goal non-empty =====

// @v: anc-rule-s8
describe('S8: goal non-empty', () => {
  it('errors when goal is missing', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S8')).toBe(true);
    expect(errors.find(e => e.rule === 'S8')!.severity).toBe('error');
  });

  it('accepts spec with goal', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Do something useful' },
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S8')).toBe(false);
  });
});

// ===== S9: container steps should declare outputs =====

// @v: anc-rule-s9
describe('S9: container output declarations', () => {
  it('errors when subtask outputs are referenced but not declared', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [
        {
          step_id: '1', step_type: 'subtask', summary: 'No outputs',
          children: [{ step_id: '1.1', step_type: 'act', summary: 'Do' }],
        } as SubtaskStep,
        {
          step_id: '2', step_type: 'act', summary: 'Use result',
          inputs: [{ name: 'x', source: '${1.result}' }],
        },
      ],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S9')).toBe(true);
    expect(errors.find(e => e.rule === 'S9')!.severity).toBe('error');
  });

  it('accepts subtask without outputs when not referenced downstream', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'No outputs',
        children: [{ step_id: '1.1', step_type: 'act', summary: 'Do' }],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S9')).toBe(false);
  });

  it('accepts subtask with outputs', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Has outputs',
        outputs: [{ name: 'result', type: 'text', description: 'result' }],
        children: [{ step_id: '1.1', step_type: 'act', summary: 'Do' }],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S9')).toBe(false);
  });

  it('does not check case steps for outputs', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'branch', summary: 'Branch',
        outputs: [{ name: 'chosen', type: 'text', description: 'chosen' }],
        children: [
          { step_id: '1.1', step_type: 'case', summary: 'A', condition: 'x', children: [] } as CaseStep,
          { step_id: '1.2', step_type: 'case', summary: 'B', condition: 'y', children: [] } as CaseStep,
        ],
      } as BranchStep],
    };
    const errors = validateSpec(ast);
    expect(errors.filter(e => e.rule === 'S9').every(e => e.step_id !== '1.1' && e.step_id !== '1.2')).toBe(true);
  });
});

// ===== C4: unreachable steps after exit/break =====

// @v: anc-rule-c4
describe('C4: unreachable steps after exit', () => {
  it('warns about step after exit at top level', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [
        { step_id: '1', step_type: 'act', summary: 'Do thing' },
        { step_id: '2', step_type: 'exit', summary: 'Exit early' },
        { step_id: '3', step_type: 'act', summary: 'Unreachable' },
      ],
    };
    const errors = validateSpec(ast);
    const c4 = errors.filter(e => e.rule === 'C4');
    expect(c4).toHaveLength(1);
    expect(c4[0].step_id).toBe('3');
    expect(c4[0].message).toContain('unreachable');
  });

  it('warns about step after break inside loop', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'loop', summary: 'Loop',
        max_iterations: 5,
        children: [
          { step_id: '1.1', step_type: 'break', summary: 'Break' },
          { step_id: '1.2', step_type: 'act', summary: 'Unreachable after break' },
        ],
      }],
    };
    const errors = validateSpec(ast);
    const c4 = errors.filter(e => e.rule === 'C4');
    expect(c4).toHaveLength(1);
    expect(c4[0].step_id).toBe('1.2');
  });

  it('no warning when exit is last step', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [
        { step_id: '1', step_type: 'act', summary: 'Do thing' },
        { step_id: '2', step_type: 'exit', summary: 'Normal exit' },
      ],
    };
    const errors = validateSpec(ast);
    expect(errors.filter(e => e.rule === 'C4')).toHaveLength(0);
  });

  it('no warning for exit inside branch case (conditional exit)', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [
        {
          step_id: '1', step_type: 'branch', summary: 'Branch',
          children: [
            {
              step_id: '1.1', step_type: 'case', summary: 'Error case',
              condition: 'error',
              children: [{ step_id: '1.1.1', step_type: 'exit', summary: 'Early exit' }],
            },
            {
              step_id: '1.2', step_type: 'case', summary: 'OK case',
              condition: 'ok',
              children: [{ step_id: '1.2.1', step_type: 'act', summary: 'Continue' }],
            },
          ],
        } as any,
        { step_id: '2', step_type: 'act', summary: 'Still reachable via 1.2' },
      ],
    };
    const errors = validateSpec(ast);
    expect(errors.filter(e => e.rule === 'C4')).toHaveLength(0);
  });

  it('warns about unreachable inside nested subtask', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Task',
        children: [
          { step_id: '1.1', step_type: 'exit', summary: 'Exit' },
          { step_id: '1.2', step_type: 'act', summary: 'Dead code' },
        ],
      }],
    };
    const errors = validateSpec(ast);
    const c4 = errors.filter(e => e.rule === 'C4');
    expect(c4).toHaveLength(1);
    expect(c4[0].step_id).toBe('1.2');
  });
});

// ===== C6: check must be inside subtask =====

// @v: anc-rule-c6
describe('C6: check inside subtask or case', () => {
  it('errors check at top level', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{ step_id: '1', step_type: 'check', summary: 'Top level check' }],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C6')).toBe(true);
    expect(errors.find(e => e.rule === 'C6')!.severity).toBe('error');
  });

  it('errors check inside loop but not subtask/case', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'loop', summary: 'Loop',
        max_iterations: 3,
        children: [{ step_id: '1.1', step_type: 'check', summary: 'Check in loop' }],
      } as LoopStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C6')).toBe(true);
  });

  it('accepts check inside subtask', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Task',
        children: [{ step_id: '1.1', step_type: 'check', summary: 'Check in subtask' }],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C6')).toBe(false);
  });

  it('accepts check inside case', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'branch', summary: 'Branch',
        children: [
          { step_id: '1.1', step_type: 'case', summary: 'Case A', children: [
            { step_id: '1.1.1', step_type: 'check', summary: 'Check in case' },
          ] } as CaseStep,
          { step_id: '1.2', step_type: 'case', summary: 'Case B', children: [
            { step_id: '1.2.1', step_type: 'act', summary: 'Do' },
          ] } as CaseStep,
        ],
      } as BranchStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C6')).toBe(false);
  });
});

// ===== P8: commit in retry/adaptive subtask requires confirm =====

// @v: anc-rule-p8
describe('P8: commit in retry/adaptive subtask', () => {
  it('rejects commit in retry subtask without confirm', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Retry task',
        retry: 3,
        children: [
          { step_id: '1.1', step_type: 'commit', summary: 'Dangerous', irreversible_action: 'delete data' } as CommitStep,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P8')).toBe(true);
    expect(errors.find(e => e.rule === 'P8')!.severity).toBe('error');
  });

  it('accepts commit in retry subtask with confirm guard', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Retry task',
        retry: 3,
        children: [
          { step_id: '1.1', step_type: 'confirm', summary: 'Approve?', response_options: [{ value: 'yes', label: 'Yes' }] } as ConfirmStep,
          { step_id: '1.2', step_type: 'commit', summary: 'Safe', irreversible_action: 'delete data' } as CommitStep,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P8')).toBe(false);
  });

  it('accepts commit in non-retry subtask', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Normal task',
        children: [
          { step_id: '1.1', step_type: 'commit', summary: 'OK', irreversible_action: 'send email' } as CommitStep,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P8')).toBe(false);
  });

  // 2026-08-10 作者改判：把关兜底从仅 confirm 扩为 confirm 或前序 check/check final 任一
  it('accepts commit in retry subtask with preceding check final guard (探索→验收→提交)', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Retry task',
        retry: 3,
        children: [
          { step_id: '1.1', step_type: 'act', summary: 'Explore' },
          { step_id: '1.2', step_type: 'check', summary: 'Verify', is_finally: true } as any,
          { step_id: '1.3', step_type: 'commit', summary: 'Land it', irreversible_action: 'write prod' } as CommitStep,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P8')).toBe(false);
  });

  it('accepts commit in retry subtask with preceding plain check guard', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Retry task',
        retry: 2,
        children: [
          { step_id: '1.1', step_type: 'check', summary: 'Verify precondition' } as any,
          { step_id: '1.2', step_type: 'commit', summary: 'Land it', irreversible_action: 'write prod' } as CommitStep,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P8')).toBe(false);
  });

  // 反例：判序不判位——把关步骤跟在 commit 后面不算把关（提交完了才验收 = 裸奔提交）
  it('rejects commit whose only check comes after it (guard must precede)', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Retry task',
        retry: 3,
        children: [
          { step_id: '1.1', step_type: 'commit', summary: 'Land first?!', irreversible_action: 'write prod' } as CommitStep,
          { step_id: '1.2', step_type: 'check', summary: 'Verify afterwards', is_finally: true } as any,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P8')).toBe(true);
    expect(errors.find(e => e.rule === 'P8')!.severity).toBe('error');
  });
});

// ===== S10: Spec with steps must have ≥1 step; capability declaration needs goal+outputs =====

// @v: anc-rule-s10
describe('S10: spec step/capability constraints', () => {
  it('rejects spec with empty steps array', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Do something' },
      steps: [],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S10')).toBe(true);
    expect(errors.find(e => e.rule === 'S10')!.severity).toBe('error');
  });

  it('accepts spec with at least one step', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Do something' },
      steps: [{ step_id: '1', step_type: 'reason', summary: 'Think' }],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S10')).toBe(false);
  });

  it('rejects capability declaration (no steps) without goal', () => {
    const ast: SpecAST = {
      header: {
        title: 'Test',
        outputs: [{ name: 'result', type: 'text', description: 'result' }],
      },
    };
    const errors = validateSpec(ast);
    expect(errors.filter(e => e.rule === 'S10').some(e => e.message.includes('Goal'))).toBe(true);
  });

  it('rejects capability declaration (no steps) without outputs', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'A capability' },
    };
    const errors = validateSpec(ast);
    expect(errors.filter(e => e.rule === 'S10').some(e => e.message.includes('Outputs'))).toBe(true);
  });

  it('accepts capability declaration with goal and outputs', () => {
    const ast: SpecAST = {
      header: {
        title: 'Test',
        goal: 'A capability',
        outputs: [{ name: 'result', type: 'text', description: 'result' }],
      },
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S10')).toBe(false);
  });
});

// ===== S11: Leaf steps cannot have children =====

// @v: anc-rule-s11
describe('S11: leaf steps cannot have children', () => {
  it('rejects reason step with children', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'reason', summary: 'Reason with kids',
        children: [{ step_id: '1.1', step_type: 'act', summary: 'Should not be here' }],
      } as any],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S11')).toBe(true);
    expect(errors.find(e => e.rule === 'S11')!.severity).toBe('error');
  });

  it('rejects call step with children', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'call', summary: 'Call with kids',
        callee_spec_id: 'child_spec',
        children: [{ step_id: '1.1', step_type: 'act', summary: 'Bad' }],
      } as any],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S11')).toBe(true);
  });

  it('accepts leaf step without children', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{ step_id: '1', step_type: 'reason', summary: 'Plain reason' }],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S11')).toBe(false);
  });

  it('accepts container step with children (not a leaf)', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Container',
        children: [{ step_id: '1.1', step_type: 'act', summary: 'OK' }],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S11')).toBe(false);
  });
});

// ===== S12: parallel children inter-dependency =====

// @v: anc-rule-s12 —— 旧"parallel 容器 children 无依赖"子条随静态组读法退役（P0.5）：
// subtask parallel 子树是子实例内部串行执行，children 间依赖【合法】——正例锁定语义翻转。
describe('S12 旧子条退役：标注子树内部依赖合法（子实例内串行）', () => {
  it('正例:subtask parallel 子树内后步消费前步输出——不再报 S12', () => {
    // 标注步骤置于边界容器内（子条④后裸挂另报,与本例意图无关——本例锁"子树内部依赖合法"）
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Boundary',
        outputs: [{ name: 'y_data', type: 'text', description: 'y' }],
        children: [{
          step_id: '1.1', step_type: 'subtask', parallel: true, summary: 'Async unit',
          outputs: [{ name: 'y_data', type: 'text', description: 'y' }],
          children: [
            {
              step_id: '1.1.1', step_type: 'reason', summary: 'Produce x',
              outputs: [{ name: 'x_data', type: 'text', description: 'x' }],
            },
            {
              step_id: '1.1.2', step_type: 'act', summary: 'Consume x inside subtree',
              inputs: [{ name: 'input', source: 'x_data' }],
              outputs: [{ name: 'y_data', type: 'text', description: 'y' }],
            },
          ],
        } as SubtaskStep],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'S12')).toBe(false);
  });
});

// ===== V10 collect 子句静态校验（todo/0051 补钉——子条①随本批实装,②③既有行为首次直接钉）=====

// @v: anc-rule-v10
describe('V10 collect 子句静态校验', () => {
  const specWith = (steps: string) => parseSpec(`# T
Id: t
Goal: g
## Steps
${steps}`);
  const v10 = (steps: string) => validateSpec(specWith(steps).ast!).filter(e => e.rule === 'V10' && e.severity === 'error');

  it('正例:child 以 + → 声明产出 unitVar → 零 V10 报错', () => {
    expect(v10(`1. [loop for-each x in xs, collect r into rs] 逐项
  + → rs: [text]
  1.1. [act free] 干活
    - ← x
    + → r: text  # 单项产出`)).toHaveLength(0);
  });

  it('正例:call 步 output_mapping 映射到 unitVar → 零 V10 报错（映射形态同为合法产出方,只认 + → 会误杀现役正形）', () => {
    expect(v10(`1. [loop for-each x in xs, collect r into rs] 逐项派发
  + → rs: [text]
  1.1. [call 子活(参: x) parallel] 派发
    + → r`)).toHaveLength(0);
  });

  it('正例:孙辈步骤产出 unitVar → 零 V10 报错（unitVar 注册在 root 槽,任意深度后代写它都直落——B1 嵌套累加器等价重写正是此形态,首版只扫直接 child 误杀实撞）', () => {
    expect(v10(`1. [loop for-each x in xs, collect r into rs] 逐项
  + → rs: [text]
  1.1. [subtask] 处理
    - ← x
    + → done_flag: text
    1.1.1. [act free] 深处产出单项
      + → r: text  # 孙辈产出
    1.1.2. [reason] 收尾
      + → done_flag: text`)).toHaveLength(0);
  });

  it('反例:体内无任何后代产出 unitVar → V10 error（子条①——缺产出方则轮末每轮收进 null,静默收出一串 null 列表）', () => {
    const errs = v10(`1. [loop for-each x in xs, collect r into rs] 逐项
  + → rs: [text]
  1.1. [act free] 干活但产出别的名字
    - ← x
    + → other: text  # 与 unitVar 无关`);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].message).toContain('无产出方');
    expect(errs[0].message).toContain('null');
  });

  it('反例:child 把 unitVar 声明成列表型 [T] → V10 error（子条①型面——单项端是每轮单值 T,列表由引擎收集而成）', () => {
    const errs = v10(`1. [loop for-each x in xs, collect r into rs] 逐项
  + → rs: [text]
  1.1. [act free] 干活
    - ← x
    + → r: [text]  # 错声明成列表`);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].message).toContain('列表型');
  });

  it('反例:listVar 未在容器头 + → 声明 → V10 error（子条②首次直接钉——此前只经 V9 套间接沾边）', () => {
    const errs = v10(`1. [loop for-each x in xs, collect r into rs] 逐项
  1.1. [act free] 干活
    - ← x
    + → r: text  # 单项`);
    expect(errs.some(e => e.message.includes('未在容器头'))).toBe(true);
  });

  it('反例:collect 挂在非 for-each 的 loop → V10 error（子条③首次直接钉）', () => {
    const errs = v10(`1. [loop max=3, collect r into rs] 非遍历循环
  + → rs: [text]
  1.1. [act free] 干活
    + → r: text  # 单项`);
    expect(errs.some(e => e.message.includes('非 for-each'))).toBe(true);
  });
});

// ===== S12 统一模型子条: call parallel 三查（宿主位置/无 Future/旧通道互斥）=====
// 正反例矩阵行 6/7（design/parallel-execution.md ^anc-exec-parallel-test-matrix）

// @v: anc-rule-s12
describe('S12 call parallel: 异步派发依赖边界', () => {
  const specWith = (steps: string) => parseSpec(`# T
Id: t
Goal: g
## Steps
${steps}`);

  it('正例:loop 体内 call parallel + collect 消费在循环外——零报错', () => {
    const r = specWith(`1. [loop for-each ch in chapters, collect built into results] 逐章
  + → results: [text]
  1.1. [act] 生产
    - ← ch
    + → confirmed: text  # 确认稿
  1.2. [call construct(src: confirmed) parallel] 派发构建
    + → built: text
2. [act] 消费列表
  - ← results
  + → report: text  # 汇总`);
    const errors = validateSpec(r.ast!);
    expect(errors.filter(e => e.rule === 'S12' && e.severity === 'error')).toHaveLength(0);
  });

  it('反例:循环外 call parallel → S12 报错（无收齐点）', () => {
    const r = specWith(`1. [call construct(src: seed) parallel] 循环外派发
  + → built: text`);
    const errors = validateSpec(r.ast!);
    const s12 = errors.filter(e => e.rule === 'S12');
    expect(s12.length).toBeGreaterThan(0);
    expect(s12[0].message).toContain('不在 loop 体内');
  });

  it('反例:循环体内后续步骤消费 call parallel 输出 → S12 报错（无 Future）', () => {
    const r = specWith(`1. [loop for-each ch in chapters, collect built into results] 逐章
  + → results: [text]
  1.1. [call construct(src: ch) parallel] 派发
    + → built: text
  1.2. [act] 体内偷用
    - ← built
    + → wrong: text  # 不该拿到`);
    const errors = validateSpec(r.ast!);
    const hits = errors.filter(e => e.rule === 'S12' && e.message.includes('无 Future'));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].step_id).toBe('1.2');
  });

  it('反例:体内另一 call 以其输出为入参 → S12 报错（映射通道同查）', () => {
    const r = specWith(`1. [loop for-each ch in chapters, collect final into results] 逐章
  + → results: [text]
  1.1. [call construct(src: ch) parallel] 派发
    + → built: text
  1.2. [call polish(draft: built)] 体内接力
    + → final: text`);
    const errors = validateSpec(r.ast!);
    expect(errors.some(e => e.rule === 'S12' && e.step_id === '1.2')).toBe(true);
  });

  it('反例:旧文法 loop 头 parallel → parse 拒绝（互斥子条随文法废除退役为文法级拦截）', () => {
    const r = specWith(`1. [loop for-each ch in chapters, collect built into results, parallel] 旧并行遍历
  + → results: [text]
  1.1. [subtask] 体
    + → built: text
    1.1.1. [call construct(src: ch) parallel] 叠加派发
      + → built: text`);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0].message).toContain('已废除');
  });

  it('正例:体内消费未标注主线步骤的输出照常合法（流水线前提，不误拦）', () => {
    const r = specWith(`1. [loop for-each ch in chapters, collect built into results] 逐章
  + → results: [text]
  1.1. [act] 生产
    - ← ch
    + → confirmed: text  # 确认稿
  1.2. [reason] 主线消费主线
    - ← confirmed
    + → checked: text  # 复核稿
  1.3. [call construct(src: checked) parallel] 派发
    + → built: text`);
    const errors = validateSpec(r.ast!);
    expect(errors.filter(e => e.rule === 'S12' && e.severity === 'error')).toHaveLength(0);
  });
});

// ===== S12 子条④: 收齐边界必须存在（2026-08-13 作者定,examples 实撞:parallel-aggregate 顶层裸挂全绿通过）=====

// @v: anc-rule-s12
describe('S12 收齐边界: parallel 标注步骤不得顶层裸挂', () => {
  const specWith = (steps: string) => parseSpec(`# T
Id: t
Goal: g
## Steps
${steps}`);

  it('反例:顶层裸挂 [subtask parallel] → S12 报错（无边界容器,收齐点无主——实撞形态）', () => {
    const r = specWith(`1. [act] 准备
  + → prepared: yaml  # 预处理
  > 清洗
2. [subtask parallel] 裸挂并行
  + → report: text
  2.1. [reason] 分析
    - ← prepared
    + → report: text  # 结果
    > 分析
3. [act] 消费
  - ← report
  + → out: text  # 汇总
  > 汇总`);
    const errors = validateSpec(r.ast!);
    const hits = errors.filter(e => e.rule === 'S12' && e.message.includes('无收敛边界'));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].step_id).toBe('2');
    expect(hits[0].message).toContain('包进一层');
  });

  it('反例:[case(cond) parallel] 只有 branch 祖先（顶层 branch）→ S12 报"branch 是选择结构不作收齐边界"', () => {
    const r = specWith(`1. [branch] 分流
  1.1. [case(x == 1) parallel] 并行臂
    + → r: text
    1.1.1. [reason] A
      + → r: text  # a
      > a
  1.2. [case(else)] 兜
    1.2.1. [exit]`);
    const errors = validateSpec(r.ast!);
    const hits = errors.filter(e => e.rule === 'S12' && e.message.includes('branch 是选择结构'));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].step_id).toBe('1.1');
  });

  it('正例:case 臂内 [subtask parallel]——case 就是 subtask 自身即边界,零 S12', () => {
    const r = specWith(`1. [branch] 分流
  1.1. [case(x == 1)] 臂（事务边界）
    + → r: text
    1.1.1. [subtask parallel] 活
      + → r: text
      1.1.1.1. [reason] A
        + → r: text  # a
        > a
  1.2. [case(else)] 兜
    1.2.1. [exit]`);
    const errors = validateSpec(r.ast!);
    expect(errors.filter(e => e.rule === 'S12' && e.severity === 'error')).toHaveLength(0);
  });

  it('正例:同结构包进 [subtask] 边界容器 → 零 S12（收齐点=容器边界,输出经头部具名导出）', () => {
    const r = specWith(`1. [act] 准备
  + → prepared: yaml  # 预处理
  > 清洗
2. [subtask] 边界容器
  + → report: text
  2.1. [subtask parallel] 并行分析
    + → report: text
    2.1.1. [reason] 分析
      - ← prepared
      + → report: text  # 结果
      > 分析
3. [act] 消费
  - ← report
  + → out: text  # 汇总
  > 汇总`);
    const errors = validateSpec(r.ast!);
    expect(errors.filter(e => e.rule === 'S12' && e.severity === 'error')).toHaveLength(0);
  });
});

// ===== V11: 叶子输入声明完备性——散文引用 warn 档（2026-08-13 作者定"用到的必须声明";机判三档
// 如实分层:body=B4 error/present_inputs=P14 error/散文=warn+语义审计终审——文本命中≠消费）=====

// @v: anc-rule-v11
// V14: Tools 段声明-授权对账（D94 批,作者拍"validate 应该加验证"——声明零消费=工具静默不可见
// 空转,最难发现的失效形态写时点名。三消费形态全认:授权行/body 直调/通配。） // @v: anc-rule-v14
describe('V14 Tools 段声明-授权消费对账（warn 档）', () => {
  const mkT = (toolsSection: string, steps: string) => parseSpec(`# T
Id: t
Goal: g
${toolsSection}
## Inputs
- x: line  # in
## Steps
${steps}`);
  const TOOLS = `## Tools
- ssh_exec(host: line, command: line) -> r: text  # 远程执行`;

  it('反例：声明 ssh_exec 零授权零调用 → V14 warn 点名（实撞形态——声明即空转）', () => {
    const r = mkT(TOOLS, `1. [act free] 干活
  - ← x
  + → out: text  # o
  > 用 ssh_exec 跑命令`);
    const hits = validateSpec(r.ast!).filter(e => e.rule === 'V14');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('warn');
    expect(hits[0].message).toContain('ssh_exec');
    expect(hits[0].message).toContain('- 工具: ssh_exec');
  });

  it('正例：声明+步骤授权行 → 零 V14', () => {
    const r = mkT(TOOLS, `1. [act free] 干活
  - ← x
  - 工具: ssh_exec  # 远程跑
  + → out: text  # o
  > 用 ssh_exec 跑命令`);
    expect(validateSpec(r.ast!).filter(e => e.rule === 'V14')).toHaveLength(0);
  });

  it('正例：声明+body 直调（无授权行）→ 零 V14（body 消费合法形态）', () => {
    const fence = '```';
    const steps = [
      '1. [act] 干活',
      '  - ← x',
      '  + → out: text  # o',
      `  > ${fence}hop_python`,
      '  > out = ssh_exec(host: x, command: x)',
      `  > ${fence}`,
      '2. [check final] 验',
      '  - ← out',
      '  + → ok: bool  # 判',
      '  + → note: text  # 说',
    ].join('\n');
    const r = mkT(TOOLS, steps);
    expect(validateSpec(r.ast!).filter(e => e.rule === 'V14')).toHaveLength(0);
  });

  it('正例：通配授权 - 工具: * 在场 → 全部声明视为已消费零 V14', () => {
    const r = mkT(TOOLS, `1. [act free] 干活
  - ← x
  - 工具: *  # 全量
  + → out: text  # o
  > 干`);
    expect(validateSpec(r.ast!).filter(e => e.rule === 'V14')).toHaveLength(0);
  });

  it('正例：无 Tools 段 → 规则静默零 V14', () => {
    const r = mkT('', `1. [act free] 干活
  - ← x
  + → out: text  # o
  > 干`);
    expect(validateSpec(r.ast!).filter(e => e.rule === 'V14')).toHaveLength(0);
  });
});

describe('V11 叶子输入声明完备性（散文引用 warn 档）', () => {
  const mk = (steps: string) => parseSpec(`# T
Id: t
Goal: g
## Inputs
- order_data: yaml  # 订单
## Steps
${steps}`);

  it('反例：reason instruction 提到前序变量但未声明 - ← → V11 warn（真消费漏声明的形态）', () => {
    const r = mk(`1. [reason] 想
  - ← order_data
  + → risk_notes: text  # 笔记
  > 分析
2. [reason] 汇总
  + → summary: text  # 总
  > 基于 risk_notes 与 order_data 出汇总`);
    const errors = validateSpec(r.ast!);
    const hits = errors.filter(e => e.rule === 'V11');
    expect(hits.length).toBe(2);   // risk_notes 与 order_data 都命中
    expect(hits.every(e => e.severity === 'warn')).toBe(true);
    expect(hits[0].step_id).toBe('2');
  });

  it('正例：已声明 - ← 的引用零 warn；自产输出（更新模式）不算引用', () => {
    const r = mk(`1. [reason] 想
  - ← order_data
  + → risk_notes: text  # 笔记
  > 基于 order_data 分析,产出 risk_notes`);
    const errors = validateSpec(r.ast!);
    expect(errors.filter(e => e.rule === 'V11')).toHaveLength(0);
  });

  it('边界如实：散文提及型（非消费）同样 warn——机器分不清,报文教人怎么核（误报可忽略是设计内）', () => {
    const r = mk(`1. [reason] 想
  - ← order_data
  + → risk_notes: text  # 笔记
  > 分析
2. [act] 归档说明
  - ← order_data
  + → note: text  # 说明
  > 说明:risk_notes 由上一步维护,本步不消费它`);
    const errors = validateSpec(r.ast!);
    const hits = errors.filter(e => e.rule === 'V11');
    expect(hits.length).toBe(1);
    expect(hits[0].message).toContain('是散文提及可忽略');
  });
});

// ===== V7: Input variable types must be valid =====

// @v: anc-rule-v7
describe('V7: input variable type validity', () => {
  it('rejects input with invalid type', () => {
    const ast: SpecAST = {
      header: {
        title: 'Test', goal: 'Test',
        inputs: [{ name: 'x', type: 'invalid_type' }],
      },
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V7')).toBe(true);
    expect(errors.find(e => e.rule === 'V7')!.severity).toBe('error');
  });

  it('accepts input with builtin ValueTypeString', () => {
    const ast: SpecAST = {
      header: {
        title: 'Test', goal: 'Test',
        inputs: [
          { name: 'a', type: 'text' },
          { name: 'b', type: 'int' },
          { name: 'c', type: '[line]' },
          { name: 'd', type: 'bool' },
        ],
      },
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V7')).toBe(false);
  });

  it('accepts input with enum type', () => {
    const ast: SpecAST = {
      header: {
        title: 'Test', goal: 'Test',
        inputs: [{ name: 'level', type: 'enum(low,medium,high)' }],
      },
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V7')).toBe(false);
  });

  it('accepts input with declared TypeDecl', () => {
    const ast: SpecAST = {
      header: {
        title: 'Test', goal: 'Test',
        types: [{ name: 'SearchResult', fields: { url: 'text', title: 'line' } }],
        inputs: [{ name: 'results', type: 'SearchResult' }],
      },
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V7')).toBe(false);
  });

  it('rejects input with type not in TypeDecl', () => {
    const ast: SpecAST = {
      header: {
        title: 'Test', goal: 'Test',
        types: [{ name: 'SearchResult', fields: { url: 'text', title: 'line' } }],
        inputs: [{ name: 'results', type: 'UndeclaredType' }],
      },
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V7')).toBe(true);
  });
});

// ===== C7: check finally must be in subtask and at end =====

// @v: anc-rule-c7
describe('C7: check finally position', () => {
  it('rejects check finally at top level (not in subtask)', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{ step_id: '1', step_type: 'check', summary: 'Top level finally', is_finally: true } as any],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C7')).toBe(true);
    expect(errors.find(e => e.rule === 'C7')!.severity).toBe('error');
  });

  it('rejects check finally inside loop but not subtask', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'loop', summary: 'Loop',
        max_iterations: 3,
        children: [{ step_id: '1.1', step_type: 'check', summary: 'Finally in loop', is_finally: true } as any],
      } as LoopStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C7')).toBe(true);
  });

  it('accepts check finally at end of subtask children', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Task',
        children: [
          { step_id: '1.1', step_type: 'act', summary: 'Do work' },
          { step_id: '1.2', step_type: 'check', summary: 'Finally check', is_finally: true } as any,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C7')).toBe(false);
  });

  it('accepts multiple check finally steps at end of subtask children', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Task',
        children: [
          { step_id: '1.1', step_type: 'act', summary: 'Do work' },
          { step_id: '1.2', step_type: 'check', summary: 'Finally A', is_finally: true } as any,
          { step_id: '1.3', step_type: 'check', summary: 'Finally B', is_finally: true } as any,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C7')).toBe(false);
  });

  it('rejects check finally followed by non-finally step', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Task',
        children: [
          { step_id: '1.1', step_type: 'check', summary: 'Finally check', is_finally: true } as any,
          { step_id: '1.2', step_type: 'act', summary: 'After finally' },
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C7')).toBe(true);
  });

  it('rejects non-finally step between two finally steps', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Task',
        children: [
          { step_id: '1.1', step_type: 'check', summary: 'Finally A', is_finally: true } as any,
          { step_id: '1.2', step_type: 'act', summary: 'Interrupting' },
          { step_id: '1.3', step_type: 'check', summary: 'Finally B', is_finally: true } as any,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C7')).toBe(true);
  });

  it('allows normal check (not finally) anywhere in subtask', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Task',
        children: [
          { step_id: '1.1', step_type: 'check', summary: 'Normal check' },
          { step_id: '1.2', step_type: 'act', summary: 'Do work' },
          { step_id: '1.3', step_type: 'check', summary: 'Finally check', is_finally: true } as any,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C7')).toBe(false);
  });

  // 2026-08-10 作者改判：check final 后允许提交性收尾（commit/exit/其他 check final）
  it('accepts commit after check final (探索→验收→提交 canonical shape)', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Task',
        retry: 3,
        children: [
          { step_id: '1.1', step_type: 'act', summary: 'Explore' },
          { step_id: '1.2', step_type: 'check', summary: 'Verify', is_finally: true } as any,
          { step_id: '1.3', step_type: 'commit', summary: 'Land it', irreversible_action: 'write prod' } as CommitStep,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C7')).toBe(false);
  });

  it('accepts exit after check final', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Task',
        children: [
          { step_id: '1.1', step_type: 'act', summary: 'Work' },
          { step_id: '1.2', step_type: 'check', summary: 'Verify', is_finally: true } as any,
          { step_id: '1.3', step_type: 'exit', summary: 'Deliver' } as any,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C7')).toBe(false);
  });

  // 反例：验收后再做探索性工作仍然错位（reason/act/ask 等被拒）
  it('rejects exploratory reason after check final', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Task',
        children: [
          { step_id: '1.1', step_type: 'check', summary: 'Verify', is_finally: true } as any,
          { step_id: '1.2', step_type: 'reason', summary: 'More exploring after verification?!' },
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C7')).toBe(true);
    expect(errors.find(e => e.rule === 'C7')!.severity).toBe('error');
  });

  it('rejects exploratory act between check final and commit', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Task',
        children: [
          { step_id: '1.1', step_type: 'check', summary: 'Verify', is_finally: true } as any,
          { step_id: '1.2', step_type: 'act', summary: 'Sneaky rework' },
          { step_id: '1.3', step_type: 'commit', summary: 'Land', irreversible_action: 'write prod' } as CommitStep,
        ],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C7')).toBe(true);
  });
});

// ===== P9: retry/adaptive only on subtask =====

// @v: anc-rule-p9
describe('P9: retry and adaptive only on subtask', () => {
  it('rejects retry on non-subtask step', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'loop', summary: 'Loop with retry',
        max_iterations: 5,
        retry: 3,
        children: [{ step_id: '1.1', step_type: 'act', summary: 'Work' }],
      } as any],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P9')).toBe(true);
    expect(errors.find(e => e.rule === 'P9')!.severity).toBe('error');
  });

  it('rejects adaptive on non-subtask step', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'reason', summary: 'Reason with adaptive',
        adaptive: true,
      } as any],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P9')).toBe(true);
  });

  it('accepts retry on subtask step', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Retry subtask',
        retry: 3,
        children: [{ step_id: '1.1', step_type: 'act', summary: 'Work' }],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P9')).toBe(false);
  });

  it('accepts adaptive on subtask step', () => {
    const ast: SpecAST = {
      header: { title: 'Test', goal: 'Test' },
      steps: [{
        step_id: '1', step_type: 'subtask', summary: 'Adaptive subtask',
        adaptive: true,
        children: [{ step_id: '1.1', step_type: 'act', summary: 'Work' }],
      } as SubtaskStep],
    };
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'P9')).toBe(false);
  });
});

// @model warn 半边（0008②——原按 EXECUTABLE_STEP_TYPES 判含 confirm/ask/call,
// @model 写在这三类上通过校验零提示、运行期永不消费）。 // @v: anc-rule-p9
describe('P9: @model 仅路由类别步骤有效（reason/act/check/commit）', () => {
  const withModel = (step_type: string, extra: Record<string, unknown> = {}): SpecAST => ({
    header: { title: 'Test', goal: 'Test' },
    steps: [{ step_id: '1', step_type, summary: 's', model_override: 'deepseek/deepseek-v4-pro', ...extra } as unknown as StepNode],
  });

  it('反例：@model 在 confirm 步骤 → P9 warn 指路（介入点无 LLM）', () => {
    const errors = validateSpec(withModel('confirm'));
    const w = errors.find(e => e.rule === 'P9');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warn');
    expect(w!.message).toContain('介入点');
  });

  it('反例：@model 在 ask 步骤 → P9 warn', () => {
    const errors = validateSpec(withModel('ask'));
    expect(errors.find(e => e.rule === 'P9')?.severity).toBe('warn');
  });

  it('反例：@model 在 call 步骤 → P9 warn 指路（路由归子 spec）', () => {
    const errors = validateSpec(withModel('call', { callee: 'x' }));
    const w = errors.find(e => e.rule === 'P9');
    expect(w).toBeDefined();
    expect(w!.message).toContain('子 spec');
  });

  it('正例：@model 在 reason/act/check/commit 四类 → 零 P9', () => {
    for (const t of ['reason', 'act', 'check', 'commit']) {
      const errors = validateSpec(withModel(t));
      expect(hasRule(errors, 'P9'), `@model on ${t}`).toBe(false);
    }
  });
});

// @v: anc-rule-p15
describe('P15 doc-ref 静态存在性校验', () => {
  function ctxFor(dir: string) {
    return {
      workspace_dir: dir,
      sandbox: {
        filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } },
        network: { trusted_hosts: [] },
        runtime: { available: [] },
      },
    };
  }

  function setup(): string {
    const dir = mkdtempSync(join(tmpdir(), 'p15-'));
    writeFileSync(join(dir, 'kb.md'), '# KB\n\n## 二、色板\n主色。\n\n## 四、组件库\n组件。\n');
    return dir;
  }

  const specWith = (ref: string) => `# S

## Steps
1. [reason] plan
  + → r: text
  > 参照 ${ref}
`;

  it('文件+章节都存在 → 无 P15 error', () => {
    const dir = setup();
    const { ast } = parseSpec(specWith('[[kb#二、色板]]'));
    const errors = validateSpec(ast, ctxFor(dir));
    expect(hasRule(errors, 'P15')).toBe(false);
  });

  it('文件不存在 → P15 error', () => {
    const dir = setup();
    const { ast } = parseSpec(specWith('[[missing#章节]]'));
    const errors = validateSpec(ast, ctxFor(dir));
    expect(hasRule(errors, 'P15')).toBe(true);
  });

  it('章节不存在 → P15 error', () => {
    const dir = setup();
    const { ast } = parseSpec(specWith('[[kb#幽灵章节]]'));
    const errors = validateSpec(ast, ctxFor(dir));
    expect(hasRule(errors, 'P15')).toBe(true);
  });

  it('无 docRefCtx（纯 AST 校验）→ 跳过 P15', () => {
    const { ast } = parseSpec(specWith('[[missing#章节]]'));
    const errors = validateSpec(ast);  // 不传 ctx
    expect(hasRule(errors, 'P15')).toBe(false);
  });

  it('spec 级 Constraints 的 doc-ref 也校验', () => {
    const dir = setup();
    const md = `# S
Constraints:
- 见 [[kb#不存在的节]]

## Steps
1. [reason] plan
  + → r: text
  > do
`;
    const { ast } = parseSpec(md);
    const errors = validateSpec(ast, ctxFor(dir));
    expect(hasRule(errors, 'P15')).toBe(true);
  });
});

// ===== V8: for-each listVar must be list type [T] =====
// @v: anc-rule-v8
describe('V8: for-each listVar 列表类型', () => {
  const foreachSpec = (itemsType: string) => `# Test
Id: v8t
Goal: G

Inputs:
- doc: line

## Steps
1. [reason] 产清单
  - ← doc
  + → items: ${itemsType}
2. [loop for-each it in items, parallel, collect r_item into r] 遍历
  + → r: [text]
  2.1. [subtask retry=1] 处理
    - ← it
    + → r_item: text
    2.1.1. [reason] 干活
      - ← it
      + → r_item: text
      > do
3. [exit] 交付
  - ← r
`;

  it('rejects listVar declared as non-list (text)', () => {
    const { ast } = parseSpec(foreachSpec('text'));
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V8')).toBe(true);
    expect(errors.find(e => e.rule === 'V8')!.severity).toBe('error');
  });

  it('accepts listVar declared as list [text]', () => {
    const { ast } = parseSpec(foreachSpec('[text]'));
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'V8')).toBe(false);
  });
});

// ===== C8: branch case condition variable path validity =====
// @v: anc-rule-c8
describe('C8: branch case 条件变量路径', () => {
  const branchSpec = (condA: string, condB: string) => `# Test
Id: c8t
Goal: G

Types:
- Item:  # 元素
  - id: line
  - kind: line

Inputs:
- items: [Item]

## Steps
1. [loop for-each item in items, parallel, collect out_item into out] 遍历
  + → out: [text]
  1.1. [subtask retry=1] 处理
    - ← item
    + → out_item: text
    1.1.1. [branch] 按种类
      - ← item
      + → out_item: text
      1.1.1.1. [case] A (${condA})
        + → out_item: text
        1.1.1.1.1. [reason] ra
          - ← item
          + → out_item: text
          > ra
      1.1.1.2. [case] B (${condB})
        + → out_item: text
        1.1.1.2.1. [reason] rb
          - ← item
          + → out_item: text
          > rb
2. [exit] 交付
  - ← out
`;

  it('accepts valid field path (item.kind)', () => {
    const { ast } = parseSpec(branchSpec('item.kind == "a"', 'item.id == "b"'));
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C8')).toBe(false);
  });

  it('rejects nonexistent field (item.flavor)', () => {
    const { ast } = parseSpec(branchSpec('item.kind == "a"', 'item.flavor == "b"'));
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C8')).toBe(true);
    expect(errors.find(e => e.rule === 'C8')!.message).toContain('flavor');
  });

  it('rejects undefined root variable', () => {
    const { ast } = parseSpec(branchSpec('item.kind == "a"', 'nope == "b"'));
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C8')).toBe(true);
    expect(errors.find(e => e.rule === 'C8')!.message).toContain('nope');
  });

  // 条件表达式 a if c else b（2026-08-17 转正式支持）在 case 条件位——纯度闸/变量路径闸须穿透三支
  it('正例：条件位条件表达式合法（三支全为纯表达式）', () => {
    const { ast } = parseSpec(branchSpec('("x" if item.kind == "a" else item.id) == "x"', 'item.id == "b"'));
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C8')).toBe(false);
  });

  it('反例：条件表达式分支里藏工具调用 → C8 拦（纯度闸穿透未命中支）', () => {
    const { ast } = parseSpec(branchSpec('(read(path: "f") if item.kind == "a" else "x") == "x"', 'item.id == "b"'));
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C8')).toBe(true);
  });

  it('反例：条件表达式分支里引用悬空变量 → C8 拦（路径闸穿透三支）', () => {
    const { ast } = parseSpec(branchSpec('("x" if item.kind == "a" else ghost) == "x"', 'item.id == "b"'));
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C8')).toBe(true);
    expect(errors.find(e => e.rule === 'C8')!.message).toContain('ghost');
  });

  // 同族存量盲区（本批 review 实抓）：list/dict/fstring 字面量 2026-08-10 入语言时未进 C8 walker
  it('反例：列表字面量里藏悬空变量 → C8 拦（复合字面量子表达式下钻）', () => {
    const { ast } = parseSpec(branchSpec('item.kind in ["a", spectre]', 'item.id == "b"'));
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C8')).toBe(true);
    expect(errors.find(e => e.rule === 'C8')!.message).toContain('spectre');
  });

  // 条件位 f-string 插值与既有 {var} 花括号剥除兼容互斥（如实钉住现状而非当缺陷）：
  // 条件解析前 {x} 一律剥为 x（历史文法 {point.type} == literal 兼容层）,f"{phantom}" 被剥成
  // f"phantom" 纯文本——validator 与运行时 evaluateCondition 同一剥除,两侧语义一致（都变字面量,
  // 无"validate 绿 run 炸"分叉）。条件里要拼接串应前置 act 步产出变量,不在条件位写 f-string 插值。
  it('现状钉：条件位 f-string 插值被 {var} 剥除层吃掉→按纯文本处理（两侧一致,不报 C8）', () => {
    const { ast } = parseSpec(branchSpec('f"{phantom}" == "x"', 'item.id == "b"'));
    expect(hasRule(validateSpec(ast), 'C8')).toBe(false);
  });
});

// @v: anc-rule-v9 —— for-each listVar 须在 ← 声明（2026-08-07 作者指正"定义缺失"）
describe('V9(终定): for-each 子句即消费声明——合成边入图,双写法等价零提示', () => {
  it('无 ← listVar 行 → 零报错（parser 合成消费边,V1/S12 可见）', () => {
    const md = `# T
## Inputs
- items: [text]

## Steps
1. [loop for-each item in items, collect out_item into out] Go
  + → out: [text]
  1.1. [reason] Do
    - ← item
    + → out_item: text
    > do
`;
    const { errors } = validate(md);
    expect(errors.filter(e => e.rule === 'V9')).toHaveLength(0);
    expect(errors.filter(e => e.rule === 'V1')).toHaveLength(0);   // 合成边引用的 items 可见,itemVar 不报未定义
  });

  it('listVar 本身未定义 → 合成边被 V1 抓到（消费边真实入图的证据）', () => {
    const md = `# T
## Steps
1. [loop for-each item in ghosts, collect out_item into out] Go
  + → out: [text]
  1.1. [reason] Do
    - ← item
    + → out_item: text
    > do
`;
    const { errors } = validate(md);
    expect(errors.some(e => e.rule === 'V1' && e.message.includes('ghosts'))).toBe(true);
  });

  it('显式再写 ← listVar → 完全合法零提示（2026-08-08 作者终定宽容双写法）', () => {
    const md = `# T
## Goal
G

## Inputs
- items: [text]

## Steps
1. [loop for-each item in items, collect out_item into out] Go
  - ← items
  + → out: [text]
  1.1. [reason] Do
    - ← item
    + → out_item: text
    > do
`;
    const { errors } = validate(md);
    expect(errors.filter(e => e.rule === 'V9')).toHaveLength(0);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });
});

// S12 属性判定补条 + V8 串行形态覆盖（review 抓出两处校验缺口）。
// @v: anc-rule-s12, anc-rule-v8
describe('loop 头 parallel 文法废除（原 S12 loop 形态子条，P0.5 升为 parse error）', () => {
  it('[loop max_iterations, parallel] → parse error（文法级拒绝，先于一切校验规则）', () => {
    const md = `# T
## Goal
G

## Steps
1. [loop max_iterations=5, parallel] 循环
  + → out: [text]
  1.1. [reason] Do
    + → out: text
    > do
`;
    const { parseErrors } = validateWithParseErrors(md);
    expect(parseErrors.some(e => e.message.includes('已废除'))).toBe(true);
  });
});

describe('V8: 串行 for-each 的 listVar 同样必须是列表', () => {
  it('串行形态 listVar 声明为 text → V8 error（原先只查 parallel 容器,串行漏网）', () => {
    const md = `# T
## Goal
G

## Inputs
- items: text

## Steps
1. [loop for-each item in items, collect out_item into out] Go
  + → out: [text]
  1.1. [reason] Do
    - ← item
    + → out_item: text
    > do
`;
    const { errors } = validate(md);
    expect(errors.some(e => e.rule === 'V8' && e.severity === 'error')).toBe(true);
  });
});

// ===== F类测试缺口补齐（2026-08-08 语义审计 c2t ⚠️，spec-parser/validator 批）=====

// @v: anc-rule-c5 —— for-each 豁免路径直测（列表耗尽即结构性终止）
describe('C5: for-each 形态豁免', () => {
  it('for-each loop 无 break/exit/max_iterations 不报 C5', () => {
    const md = `# T
## Inputs
- items: [text]

## Steps
1. [loop for-each item in items, collect out_item into out] 遍历
  + → out: [text]
  1.1. [reason] Do
    - ← item
    + → out_item: text
    > do
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'C5')).toBe(false);
  });
});

// @v: anc-rule-v2 —— case 间同名输出是统一接口填充，不是重复声明
describe('V2: branch 双 case 同名输出不误杀', () => {
  it('两 case 各声明同名 +→ 且 branch 头也声明 → 无 V2', () => {
    const md = `# T
## Inputs
- kind: line

## Steps
1. [branch] 分流
  - ← kind
  + → out: text
  1.1. [case] A (kind == "a")
    + → out: text
    1.1.1. [reason] ra
      + → out: text
      > ra
  1.2. [case] B (kind == "b")
    + → out: text
    1.2.1. [reason] rb
      + → out: text
      > rb
`;
    const { errors } = validate(md);
    expect(errors.filter(e => e.rule === 'V2')).toHaveLength(0);
  });
});

// @v: anc-rule-v3 —— V3 废除后:原豁免形态(更新模式/显式初值)成为普通合法写法
describe('V3 废除回归: 原豁免形态照常合法', () => {
  it('更新模式（← X 且 + → X）零报错', () => {
    const md = `# T
## Steps
1. [loop max_iterations=5] 累加
  + → acc: text = ""
  1.1. [reason] 干
    - ← acc
    + → acc: text
    > work
  1.2. [branch] 停判
    1.2.1. [case] acc == "STOP"
      1.2.1.1. [break]
`;
    const { errors } = validate(md);
    expect(errors.filter(e => e.rule === 'V3')).toHaveLength(0);
    expect(errors.filter(e => e.rule === 'V2')).toHaveLength(0);
  });

  it('显式初值重置（+ → X = 初值）零报错', () => {
    const md = `# T
## Inputs
- flag: line

## Steps
1. [reason] 先声明
  + → counter: text
  > init
2. [subtask retry=1] 重置域
  + → counter: text = "0"
  2.1. [reason] 用
    - ← counter
    + → counter: text
    > use
`;
    const { errors } = validate(md);
    expect(errors.filter(e => e.rule === 'V3')).toHaveLength(0);
  });
});

// @v: anc-rule-c8 —— 设计明写的四条分支：数组下标下钻/非数字下标报错/裸 truthy/类型缺失放行
describe('C8: 数组下标与边界分支', () => {
  const mk = (cond: string) => `# T
Id: c8x
Goal: G

Types:
- Item:  # 元素
  - id: line
  - tags: [line]

Inputs:
- item: Item
- blob: yaml

## Steps
1. [branch] 判
  - ← item
  - ← blob
  + → out: text
  1.1. [case] X (${cond})
    + → out: text
    1.1.1. [reason] rx
      + → out: text
      > rx
  1.2. [case] default
    + → out: text
    1.2.1. [reason] rd
      + → out: text
      > rd
`;

  it('方括号下标对列表下钻合法（item.tags[0]——.N dotted 已删）', () => {
    const { ast } = parseSpec(mk('item.tags[0] == "a"'));
    expect(hasRule(validateSpec(ast), 'C8')).toBe(false);
    const dyn = parseSpec(mk('item.tags[0] == "a" and item.id != None'));
    expect(hasRule(validateSpec(dyn.ast), 'C8')).toBe(false);
  });

  it('非数字下标段对列表类型报 C8 error', () => {
    const { ast } = parseSpec(mk('item.tags.first == "a"'));
    const errors = validateSpec(ast);
    const c8 = errors.find(e => e.rule === 'C8');
    expect(c8).toBeDefined();
    expect(c8!.severity).toBe('error');
    expect(c8!.message).toContain('first');
  });

  it('default case 跳过校验（上方 mk 的 1.2 default 恒不报）+ 裸 truthy 条件按变量路径校验', () => {
    const { ast } = parseSpec(mk('item.id'));
    expect(hasRule(validateSpec(ast), 'C8')).toBe(false);
    const bad = parseSpec(mk('item.gone'));
    expect(hasRule(validateSpec(bad.ast), 'C8')).toBe(true);
  });

  it('根类型无字段信息（yaml 标量）→ 止于根放行不误报', () => {
    const { ast } = parseSpec(mk('blob.anything.deep == "x"'));
    expect(hasRule(validateSpec(ast), 'C8')).toBe(false);
  });
});

// @v: anc-rule-v1, anc-step-call —— call output_mapping 产出注册进 scope,下游 ← 引用不报 V1
describe('V1: call output_mapping 产出的下游可见性', () => {
  it('下游 ← 引用 call 映射出的父变量 → 无 V1', () => {
    const ast: SpecAST = {
      header: { title: 'Test' },
      steps: [
        {
          step_id: '1', step_type: 'call', summary: '调子 spec',
          callee_spec_id: 'child-spec',
          param_mapping: [],
          output_mapping: [{ from: 'child_result', to: 'mapped_out' }],
          source_location: { line_start: 3, line_end: 3 },
        } as CallStep,
        {
          step_id: '2', step_type: 'reason', summary: '消费',
          inputs: [{ name: 'mapped_out', source: 'mapped_out' }] as VarBinding[],
          outputs: [{ name: 'fin', type: 'text' }] as OutputDecl[],
          source_location: { line_start: 6, line_end: 6 },
        } as StepNode,
      ],
    };
    const errors = validateSpec(ast);
    expect(errors.filter(e => e.rule === 'V1')).toHaveLength(0);
  });
});

// @v: anc-exec-parallel-foreach —— 无 + → 的 for-each（纯副作用循环）itemVar 仍须注册
// 2026-08-09 实撞：itemVar 注册被锁在 step.outputs 分支,合法省略 + → 时 child ← itemVar 被 V1 误杀
describe('V1: for-each 省略容器 + → 时 itemVar 可见', () => {
  it('纯副作用 for-each（无收集输出）child 引用 itemVar 不报 V1', () => {
    const md = `# T
## Inputs
- high_tickets: [text]

## Steps
1. [loop for-each ht in high_tickets] 逐单催办
  1.1. [act] 发提醒
    - ← ht
    > 给 ht 对应负责人发提醒
`;
    const { errors } = validate(md);
    expect(errors.filter(e => e.rule === 'V1')).toHaveLength(0);
  });
});

// @v: anc-rule-b4 —— B4 可见集与运行时 BodyInterpreter 对齐(2026-08-09 hopkb 实撞 S1)
describe('B4: body 可见集仅 ← 输入(与运行时对齐)', () => {
  it('body 引用祖先 scope 变量但无 ← 声明 → 静态 B4 error(此前放行、运行期才炸)', () => {
    const md = `# T
## Inputs
- target_kb: text
## Steps
1. [act] 写入
  + → done: text
  > \`\`\`hop_python
  > done = upper(target_kb)
  > \`\`\`
`;
    const { errors } = validate(md);
    const b4 = errors.find(e => e.rule === 'B4');
    expect(b4).toBeDefined();
    expect(b4!.message).toContain('target_kb');
  });

  it('同 body 补 ← 声明后放行', () => {
    const md = `# T
## Inputs
- target_kb: text
## Steps
1. [act] 写入
  - ← target_kb
  + → done: text
  > \`\`\`hop_python
  > done = upper(target_kb)
  > \`\`\`
`;
    const { errors } = validate(md);
    expect(errors.filter(e => e.rule === 'B4')).toHaveLength(0);
  });
});

// @v: anc-rule-s13 —— parallel 容器头禁累加器(2026-08-09 扁平命名空间重构新增)
describe('S13: parallel 容器头禁累加器', () => {
  it('标注步骤输出声明为累加器（= 初值）→ S13 error', () => {
    const md = `# T
## Inputs
- items: [text]
## Steps
1. [loop for-each it in items] 循环
  + → acc: yaml = []
  1.1. [subtask parallel] One
    + → acc: yaml
    1.1.1. [reason] r
      - ← it
      + → acc: yaml
      > r
`;
    const { errors } = validate(md);
    expect(hasRule(errors, 'S13')).toBe(true);
  });

  it('串行 for-each 头带 = 初值(累加器)合法;parallel 纯收集列表合法', () => {
    const serial = `# T
## Inputs
- items: [text]
## Steps
1. [loop for-each it in items] 串行
  + → acc: yaml = []
  1.1. [act] 累
    - ← acc, it
    + → acc
    > append
`;
    expect(hasRule(validate(serial).errors, 'S13')).toBe(false);
    const par = `# T
## Inputs
- items: [text]
## Steps
1. [loop for-each it in items, collect out_item into out] 并发
  + → out: [text]
  1.1. [subtask parallel] One
    + → out_item: text
    1.1.1. [reason] r
      - ← it
      + → out_item: text
      > r
`;
    expect(hasRule(validate(par).errors, 'S13')).toBe(false);
  });
});

// @v: anc-rule-p4 —— bare exit 语义落定(2026-08-09 作者选B:合法简写=隐式交付全部 Outputs)
describe('P4: bare exit 合法简写', () => {
  it('bare exit(无 + →)+ header 有 Outputs → 零 P4(隐式交付全部)', () => {
    const md = `# T
## Goal
g
## Outputs
- report: markdown  # r
- count: int  # c
## Steps
1. [reason] 干
  + → report: markdown
  + → count: int
  > work
2. [exit] 交付
`;
    const { errors } = validate(md);
    expect(errors.filter(e => e.rule === 'P4')).toHaveLength(0);
  });

  it('半写(声明但漏)仍 P4 error——显式声明必须完整', () => {
    const md = `# T
## Goal
g
## Outputs
- report: markdown  # r
- count: int  # c
## Steps
1. [reason] 干
  + → report: markdown
  + → count: int
  > work
2. [exit] 交付
  + → report
`;
    const { errors } = validate(md);
    expect(errors.some(e => e.rule === 'P4' && /missing required output "count"/.test(e.message))).toBe(true);
  });
});

// @v: anc-rule-c8 —— case 条件升 hop_python 表达式子集(2026-08-09 作者裁决,8k primer K 题回归)
describe('C8: hop_python 表达式条件', () => {
  const mk = (cond: string) => `# T
## Goal
g
## Inputs
- high_count: int
- mode: line
## Steps
1. [branch] 判
  - ← high_count, mode
  + → out: text
  1.1. [case] X (${cond})
    + → out: text
    1.1.1. [reason] rx
      + → out: text
      > rx
  1.2. [case] default
    + → out: text
    1.2.1. [reason] rd
      + → out: text
      > rd
`;

  // 切片端点在 case 条件里的静态核（2026-09-05 review 变异实锤:validator 链根核删端点 walk 后
  // C8 漏放 items[ghost:2]==[] 形态,580 例全绿存活——本钉即重放该变异的防线）
  // @v: anc-step-act-body-slice
  it('C8：case 条件切片端点藏未定义变量 → error（high_count 已声明作对照）', () => {
    const { ast } = parseSpec(mk('mode[ghost_ep:2] == "x"'));
    const errors = validateSpec(ast);
    expect(errors.some(e => e.rule === 'C8' && e.message.includes('ghost_ep'))).toBe(true);
  });

  it('C8：case 条件切片端点全声明 → 通过（mode[0:1] 常量端点不误报）', () => {
    const { ast } = parseSpec(mk('mode[0:1] == "x"'));
    const errors = validateSpec(ast);
    expect(errors.filter(e => e.rule === 'C8')).toEqual([]);
  });

  it('K 题回归: (high_count > 10) 数值比较合法——原被误报未定义变量', () => {
    const { ast } = parseSpec(mk('high_count > 10'));
    expect(hasRule(validateSpec(ast), 'C8')).toBe(false);
  });

  it('and/or/not/算术/括号全套合法', () => {
    for (const cond of ['high_count > 5 and mode == "doc"', 'not (high_count <= 0)', 'high_count * 2 >= 10', 'mode == "a" or mode == "b"']) {
      const { ast } = parseSpec(mk(cond));
      expect(hasRule(validateSpec(ast), 'C8')).toBe(false);
    }
  });

  // 2026-08-10 作者定：内置 pure 函数条件可用（零副作用可反复求值），工具调用仍拒
  it('内置 pure 函数进条件合法（len 等，实参照常走变量校验）', () => {
    expect(hasRule(validateSpec(parseSpec(mk('len(mode) > 3')).ast), 'C8')).toBe(false);
    expect(hasRule(validateSpec(parseSpec(mk('"a" in mode')).ast), 'C8')).toBe(false);
    // 反例：pure 函数实参引用未定义变量照报
    expect(hasRule(validateSpec(parseSpec(mk('len(nonexistent_var) > 3')).ast), 'C8')).toBe(true);
  });

  it('非 pure（工具/未知名）调用进条件必拒', () => {
    const { ast } = parseSpec(mk('fetch_data(mode) > 3'));
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C8')).toBe(true);
    expect(errors.find(e => e.rule === 'C8')!.message).toContain('pure');
  });

  it('非法表达式报准确错因(不再误报未定义变量)', () => {
    const { ast } = parseSpec(mk('high_count >'));
    const errors = validateSpec(ast);
    expect(hasRule(errors, 'C8')).toBe(true);
    expect(errors.find(e => e.rule === 'C8')!.message).not.toContain('未定义变量');
  });

  it('裸字兼容(C 方案):已声明变量 == 未声明裸字 → 字面量放行;两侧全未声明照报', () => {
    expect(hasRule(validateSpec(parseSpec(mk('mode == fast')).ast), 'C8')).toBe(false);
    expect(hasRule(validateSpec(parseSpec(mk('nope == fast')).ast), 'C8')).toBe(true);
  });

  // 推导 itemVar 绑定语义（三十四审探针实抓:盲下钻把 itemVar 报未定义——C8 walker 第三撞,
  // 凡按"已声明与否"判断的消费面必须显式接绑定语义）。 // @v: anc-step-act-body-comprehension
  it('正例：推导 itemVar 在 element/filter 内可见不误报（含 pure 函数包裹）', () => {
    expect(hasRule(validateSpec(parseSpec(mk('len([x for x in mode if x != "a"]) > 0')).ast), 'C8')).toBe(false);
  });

  it('反例：推导 source 引用未定义变量照报;itemVar 泄漏到推导外照报（退出恢复）', () => {
    expect(hasRule(validateSpec(parseSpec(mk('len([x for x in ghost_list]) > 0')).ast), 'C8')).toBe(true);
    // itemVar 只在推导子树内可见——推导外再引用 x 仍未定义
    expect(hasRule(validateSpec(parseSpec(mk('len([x for x in mode]) > 0 and len(x) > 0')).ast), 'C8')).toBe(true);
  });
});

// @v: anc-rule-c8, anc-rule-v2 —— enum 裸写结构化逻辑标准写法(作者定:声明过的成员不需引号;变量禁与成员重名)
describe('enum 成员裸写', () => {
  const mk = (cond: string, extraStep = '') => `# T
## Goal
g
## Inputs
- risk: enum(high, medium, low)
## Steps
${extraStep}1. [branch] 判
  - ← risk
  + → out: text
  1.1. [case] X (${cond})
    + → out: text
    1.1.1. [reason] rx
      + → out: text
      > rx
  1.2. [case] default
    + → out: text
    1.2.1. [reason] rd
      + → out: text
      > rd
`;

  it('risk == high 裸写合法(high∈枚举成员)', () => {
    expect(hasRule(validateSpec(parseSpec(mk('risk == high')).ast), 'C8')).toBe(false);
  });

  it('risk == hgih 写错成员当场报(合法值列表入消息)', () => {
    const errors = validateSpec(parseSpec(mk('risk == hgih')).ast);
    expect(hasRule(errors, 'C8')).toBe(true);
    expect(errors.find(e => e.rule === 'C8')!.message).toContain('合法值');
  });

  // @v: anc-rule-v2 （28轮review:enum成员重名改预扫台账——原单向扫只拦"新变量撞已有enum",
  // 反向与 Inputs/for-each 位放行;四探针复验全红）
  it('反向：后声明的 enum 成员撞已有变量 → V2 拦截（台账双向）', () => {
    const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → high: text  # 普通变量先声明
  + → r: line  # r

2. [reason] S
  - ← high
  + → lvl: enum(high, medium, low)  # 成员撞已有变量
  + → r: line  # r
`);
    expect(errors.some(e => e.rule === 'V2' && /枚举成员/.test(e.message))).toBe(true);
  });

  it('Inputs 位与 for-each 位撞 enum 成员 → V2 拦截（六位同闸）', () => {
    const inputsCase = validate(`# T

## Goal
G

## Inputs
- lvl: enum(high, medium, low)
- high: text

## Outputs
- r: line  # r

## Steps
1. [reason] R
  - ← lvl, high
  + → r: line  # r
`);
    expect(inputsCase.errors.some(e => e.rule === 'V2' && /Inputs 变量 "high".*枚举成员/.test(e.message))).toBe(true);

    const feCase = validate(`# T

## Goal
G

## Inputs
- lvl: enum(high, medium, low)
- xs: [line]

## Outputs
- rs: [line]  # rs

## Steps
1. [loop for-each high in xs, collect r into rs] L
  + → rs: [line]  # rs

  1.1. [reason] R
    - ← high
    + → r: line  # r
`);
    expect(feCase.errors.some(e => e.rule === 'V2' && /for-each 变量 "high".*枚举成员/.test(e.message))).toBe(true);
  });

  it('正例：[enum(...)] 列表元素形态成员入台账;成员词只在类型位零误伤', () => {
    const listForm = validate(`# T

## Goal
G

## Inputs
- lvls: [enum(high, medium, low)]

## Outputs
- r: line  # r

## Steps
1. [reason] R
  - ← lvls
  + → high: text  # 撞列表元素 enum 成员
  + → r: line  # r
`);
    expect(listForm.errors.some(e => e.rule === 'V2' && /枚举成员/.test(e.message))).toBe(true);

    const clean = validate(`# T

## Goal
G

## Inputs
- lvl: enum(high, medium, low)

## Outputs
- r: line  # r

## Steps
1. [reason] R
  - ← lvl
  + → verdict: text  # 普通名,不撞成员
  + → r: line  # r
`);
    expect(clean.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('变量与枚举成员重名 → V2 拦截(裸字消歧两义)', () => {
    const md = `# T
## Goal
g
## Inputs
- risk: enum(high, medium, low)
## Steps
1. [reason] 产出
  + → high: text  # 与 risk 的枚举成员撞名
  > t
`;
    const { errors } = validate(md);
    expect(errors.some(e => e.rule === 'V2' && /枚举成员/.test(e.message))).toBe(true);
  });
});

// @v: anc-rule-s14 —— Id 函数签名(2026-08-09 作者定:可选,只列名字,按名对应,id=func名)
describe('S14: Id 函数签名', () => {
  const mk = (idLine: string) => `# T
${idLine}
## Goal
g
## Inputs
- raw_data: [text]
- threshold: float
## Outputs
- report: markdown
## Steps
1. [reason] r
  - ← raw_data, threshold
  + → report: markdown
  > t
`;

  it('完整签名合法,id=func 名,serializer 原样回写', () => {
    const { ast, errors: pe } = parseSpec(mk('Id: clean-data(raw_data, threshold) -> report'));
    expect(pe).toHaveLength(0);
    expect(ast.header.id).toBe('clean-data');
    expect(ast.header.signature).toBe('clean-data(raw_data, threshold) -> report');
    expect(validateSpec(ast).filter(e => e.rule === 'S14')).toHaveLength(0);
    // serializer 回写断言归 parser.test.ts(此处 require 在 ESM vitest 不可用)
  });

  it('纯标识符 Id 照旧合法(签名可选)', () => {
    const { ast } = parseSpec(mk('Id: clean-data'));
    expect(ast.header.id).toBe('clean-data');
    expect(ast.header.signature).toBeUndefined();
    expect(validateSpec(ast).filter(e => e.rule === 'S14')).toHaveLength(0);
  });

  it('签名漏参数/多返回 → S14 error(写了就必须对应)', () => {
    const missing = parseSpec(mk('Id: f(raw_data) -> report'));
    expect(validateSpec(missing.ast).some(e => e.rule === 'S14' && /threshold/.test(e.message))).toBe(true);
    const extra = parseSpec(mk('Id: f(raw_data, threshold) -> report, bogus'));
    expect(validateSpec(extra.ast).some(e => e.rule === 'S14' && /bogus/.test(e.message))).toBe(true);
  });

  it('正例：中文签名放行（名位=Unicode 与 parser 同宽——2026-08-30 审计实抓 validator 只认 ASCII 误拒,两侧撕裂修后钉）', () => {
    const src = `# T
Id: 处理(输入) -> 结果
## Goal
g
## Inputs
- 输入: text
## Outputs
- 结果: markdown
## Steps
1. [reason] r
  - ← 输入
  + → 结果: markdown
  > t
`;
    const { ast, errors: pe } = parseSpec(src);
    expect(pe).toHaveLength(0);
    expect(ast.header.id).toBe('处理');
    expect(validateSpec(ast).filter(e => e.rule === 'S14')).toHaveLength(0);
  });

  it('反例：签名缺右括号 → S14 格式非法仍拒（同宽不放大——parser 收前缀后 validator 核全串,后半坏必拒;首字符非法的串 parser 侧就不当签名收,不到本规则）', () => {
    const { ast } = parseSpec(mk('Id: f(raw_data, threshold -> report'));
    expect(ast.header.signature).toBeDefined();
    expect(validateSpec(ast).some(e => e.rule === 'S14' && /签名格式非法/.test(e.message))).toBe(true);
  });

  it('签名错名 → S14 error', () => {
    const { ast } = parseSpec(mk('Id: f(raw_dta, threshold) -> report'));
    const errors = validateSpec(ast).filter(e => e.rule === 'S14');
    expect(errors.length).toBeGreaterThanOrEqual(2);   // raw_dta 不在 Inputs + raw_data 未出现在签名
  });
});

// @v: anc-rule-c8 —— [case(else)] 统配(2026-08-09 认知三改,作者定 else 直改、旧 ... 直接废)
describe('[case(else)] 统配', () => {
  const mk = (c1: string, c2: string) => `# T
## Goal
g
## Inputs
- mode: line
## Steps
1. [branch] 判
  - ← mode
  + → out: text
  1.1. [case(${c1})] A
    + → out: text
    1.1.1. [reason] ra
      + → out: text
      > ra
  1.2. [case(${c2})] B
    + → out: text
    1.2.1. [reason] rb
      + → out: text
      > rb
`;

  it('[case(else)] 解析为统配(等价 default),放末位合法', () => {
    const { ast, errors: pe } = parseSpec(mk('mode == "a"', 'else'));
    expect(pe).toHaveLength(0);
    expect((ast.steps![0] as any).children[1].condition).toBe('default');
    expect(validateSpec(ast).filter(e => e.rule === 'C8')).toHaveLength(0);
  });

  it('统配不在末位 → error(会吞掉其后case)', () => {
    const { ast } = parseSpec(mk('else', 'mode == "a"'));
    const errors = validateSpec(ast);
    expect(errors.some(e => e.rule === 'C8' && /末位/.test(e.message))).toBe(true);
  });

  it('旧统配 [case(...)] 已废——C8 报错不再兼容(作者定直接改)', () => {
    const { ast } = parseSpec(mk('mode == "a"', '...'));
    const errors = validateSpec(ast);
    expect(errors.some(e => e.rule === 'C8')).toBe(true);   // '...' 当条件表达式解析失败
  });

  it('旧统配 [case(default)] 已废——parse error 提示改 else（default 与内部标记同拼写，放行即静默复活）', () => {
    const { errors: pe } = parseSpec(mk('mode == "a"', 'default'));
    expect(pe.some(e => /case\(default\)/.test(e.message) && /else/.test(e.message))).toBe(true);
  });

  it('变量取名 else → V2 保留字拒绝', () => {
    const { ast } = parseSpec(`# T
## Goal
g
## Steps
1. [reason] r
  + → else: text
  > x
`);
    const errors = validateSpec(ast);
    expect(errors.some(e => e.rule === 'V2' && /保留字/.test(e.message))).toBe(true);
  });
});

// ===== hop_env_ 保留命名空间（只读规则）=====
// @v: anc-rule-hop-env-readonly, anc-config-hop-env
describe('hop_env_ 保留命名空间（规则 26 只读）', () => {
  const mk = (steps: string) => `# T

## Goal
G

## Outputs
- r: line  # r

## Steps
${steps}
`;

  it('反例：步骤 + → 产出名带 hop_env_ 前缀 = error', () => {
    const { errors } = validate(mk(`1. [reason] R
  + → hop_env_kb_root: line  # 违规产出

2. [act] A
  - ← hop_env_kb_root
  + → r: line  # r`));
    expect(errors.some(e => e.severity === 'error' && /hop_env_/.test(e.message) && /只读|保留/.test(e.message))).toBe(true);
  });

  it('正例：ask 输出到 hop_env_* 放行（覆盖链合法末级）', () => {
    const { errors } = validate(mk(`1. [ask] 问材料库位置
  + → hop_env_kb_root: line  # 问人补值

2. [act] A
  - ← hop_env_kb_root
  + → r: line  # r`));
    expect(errors.filter(e => e.severity === 'error' && /hop_env_/.test(e.message))).toHaveLength(0);
  });

  it('反例：act body 赋值目标带 hop_env_ 前缀 = B1 error', () => {
    const { errors } = validate(mk(`1. [act] A
  + → r: line  # r
  > \`\`\`hop_python
  > hop_env_root = "/tmp"
  > r = "x"
  > \`\`\``));
    expect(errors.some(e => e.rule === 'B1' && /hop_env_/.test(e.message))).toBe(true);
  });

  it('正例：body 引用 hop_env_* 名 B4 放行（运行时注入,静态不可知具体键）', () => {
    const { errors } = validate(mk(`1. [act] A
  + → r: line  # r
  > \`\`\`hop_python
  > r = hop_env_kb_root + "/x"
  > \`\`\``));
    expect(errors.filter(e => e.rule === 'B4')).toHaveLength(0);
  });

  it('正例：普通变量零误伤（不带前缀的产出与赋值照旧）', () => {
    const { errors } = validate(mk(`1. [act] A
  + → r: line  # r
  > \`\`\`hop_python
  > env_like = "x"
  > r = env_like
  > \`\`\``));
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });
});

// @v: anc-exec-doc-ref-hop-env —— P15 两档的档二注记（表缺席不静默,info 留痕）
describe('P15 hop_env 档二 info 注记', () => {
  it('含 {hop_env_*} 且表缺席 → info 注记"注入期核"（不 error 不静默）', () => {
    const { mkdtempSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'p15-note-'));
    const md = `# T

## Goal
G

## Constraints
- 判据 [[{hop_env_kb}/规范#节]]

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → r: line  # r
`;
    const { ast, errors: pe } = parseSpec(md);
    expect(pe).toHaveLength(0);
    const errs = validateSpec(ast!, {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
    });
    const note = errs.find(e => e.rule === 'P15' && e.severity === 'info');
    expect(note).toBeDefined();
    expect(note!.message).toContain('注入期核');
    expect(errs.filter(e => e.rule === 'P15' && e.severity === 'error')).toHaveLength(0);
  });
});

// ===== V6 映射/类型声明文法歧义闸（BUG-G 实撞）=====
// @v: anc-rule-v6
describe('V6 输出映射来源撞类型名（BUG-G 歧义闸）', () => {
  const mk = (omLine: string) => `# T

## Goal
G

## Inputs
- items: [line]

## Outputs
- domains: [line]

## Steps
1. [loop for-each x in items, collect domain into domains] 循环
  + → domains: [line]

  1.1. [call probe_callee(x) parallel] 起子实例
    ${omLine}
2. [exit]
`;

  it('反例：+ → domain: line（类型声明形态误入 call 行）→ V6 error 指明两种改法', () => {
    const { errors } = validate(mk('+ → domain: line'));
    const hit = errors.find(e => e.rule === 'V6' && e.severity === 'error' && /撞类型名/.test(e.message));
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('裸名');
  });

  it('反例：其他类型 token 同拒（text/yaml/number）', () => {
    for (const t of ['text', 'yaml', 'int']) {   // number 已除名(2026-08-31)——除名后它走 V2 保留字占位不走 V6 撞类型名,V6 面用仍在词表的 int
      const { errors } = validate(mk(`+ → domain: ${t}`));
      expect(errors.some(e => e.rule === 'V6' && /撞类型名/.test(e.message)), t).toBe(true);
    }
  });

  it('正例：同名裸名零误伤', () => {
    const { errors } = validate(mk('+ → domain'));
    expect(errors.filter(e => e.rule === 'V6')).toHaveLength(0);
  });

  it('正例：真映射（来源为普通标识符）零误伤', () => {
    const { errors } = validate(mk('+ → domain: normalized_domain'));
    expect(errors.filter(e => e.rule === 'V6')).toHaveLength(0);
  });
});

// ===== V6 字面量两闸（2026-08-27 hopissues/0044 随字面量入文法）=====
// @v: anc-step-call-literal
describe('call 映射字面量校验（0044）', () => {
  it('正例：param_mapping 字面量项放行（S12 不把 "seq" 当变量消费边）', () => {
    const { errors } = validate(`# T

## Goal
G

## Inputs
- items: [line]

## Outputs
- outs: [line]

## Steps
1. [loop for-each x in items, collect got into outs] 循环
  + → outs: [line]

  1.1. [subtask parallel] 并行产出
    + → made: line
    1.1.1. [reason] 产出
      + → made: line
  1.2. [call probe_callee(kind: "seq", src: x)] 字面量入参
    + → got
2. [exit]
`);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('反例：output_mapping 值位写字面量 → V6 error 指明方向可能写反', () => {
    for (const lit of ['"seq"', '3', 'true']) {
      const { errors } = validate(`# T

## Goal
G

## Outputs
- out: line

## Steps
1. [call probe_callee] 调
  + → out: ${lit}
2. [exit]
`);
      const hit = errors.find(e => e.rule === 'V6' && e.severity === 'error' && /字面量/.test(e.message));
      expect(hit, lit).toBeDefined();
    }
  });
});

// ===== 规则 27：内置类型名全局保留（作者拍板 A,2026-08-14）=====
// @v: anc-rule-type-reserved
describe('内置类型名全局保留字（规则 27）', () => {
  it('反例：Inputs 变量名撞类型 token → V2 error', () => {
    for (const t of ['line', 'text', 'yaml']) {
      const { errors } = validate(`# T

## Goal
G

## Inputs
- ${t}: text

## Outputs
- r: line  # r

## Steps
1. [reason] R
  - ← ${t}
  + → r: line  # r
`);
      expect(errors.some(e => e.rule === 'V2' && /全局保留字/.test(e.message)), t).toBe(true);
    }
  });

  it('反例：步骤产出名撞类型 token → V2 error', () => {
    const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → number: line  # 产出名叫 number

2. [act] A
  - ← number
  + → r: line  # r
`);
    expect(errors.some(e => e.rule === 'V2' && /number.*全局保留字/.test(e.message))).toBe(true);
  });

  it('反例：call 输出映射目标撞类型 token → V2 error（双向都护）', () => {
    const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [call callee] 调
  + → yaml: real_output
2. [exit]
`);
    expect(errors.some(e => e.rule === 'V2' && /输出映射目标.*yaml.*全局保留字/.test(e.message))).toBe(true);
  });

  it('正例：类型位照常合法（+ → x: line 的 line 在类型位）——保留只打变量位', () => {
    const { errors } = validate(`# T

## Goal
G

## Inputs
- doc: text

## Outputs
- r: line  # r

## Steps
1. [reason] R
  - ← doc
  + → r: line  # r
`);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('正例：形近普通名零误伤（lines/text_body/int_count）', () => {
    const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → lines: yaml  # 复数形
  + → text_body: text  # 带后缀

2. [act] A
  - ← lines
  - ← text_body
  + → r: line  # r
`);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });
});

// @v: anc-rule-type-reserved —— review 全谱探测补三检查位（itemVar/collect unitVar/TypeDecl 遮蔽）
describe('规则 27 变量引入位全谱（review 补闸）', () => {
  it('反例：for-each itemVar 叫 line → 拒（变量引入位,body/条件可引用）', () => {
    const { errors } = validate(`# T

## Goal
G

## Inputs
- items: [text]

## Outputs
- outs: [text]

## Steps
1. [loop for-each line in items, collect r into outs] 循环
  + → outs: [text]
  1.1. [reason] R
    - ← line
    + → r: text  # r
2. [exit]
`);
    expect(errors.some(e => e.rule === 'V2' && /for-each 变量.*line.*保留字/.test(e.message))).toBe(true);
  });

  it('反例：collect unitVar 叫 yaml → 拒', () => {
    const { errors } = validate(`# T

## Goal
G

## Inputs
- items: [text]

## Outputs
- outs: [text]

## Steps
1. [loop for-each x in items, collect yaml into outs] 循环
  + → outs: [text]
  1.1. [reason] R
    - ← x
    + → yaml: text  # 单项
2. [exit]
`);
    expect(errors.some(e => e.rule === 'V2' && /保留字/.test(e.message))).toBe(true);
  });

  it('反例：Types 段自定义类型遮蔽内置类型名 → 拒（x: line 两义）', () => {
    const { errors } = validate(`# T

## Goal
G

## Types
- line:
    x: text

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → r: line  # r
`);
    expect(errors.some(e => e.rule === 'V2' && /遮蔽内置类型名/.test(e.message))).toBe(true);
  });

  it('正例：itemVar/unitVar 普通名零误伤', () => {
    const { errors } = validate(`# T

## Goal
G

## Inputs
- items: [text]

## Outputs
- outs: [text]

## Steps
1. [loop for-each item in items, collect unit into outs] 循环
  + → outs: [text]
  1.1. [reason] R
    - ← item
    + → unit: text  # 单项
2. [exit]
`);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });
});

// ===== V2b 变量名标识符文法闸（2026-08-15 primer trap 实撞）=====
// @v: anc-rule-v2b
describe('V2b 变量名标识符文法闸', () => {
  it('反例（实撞形态）：+ → 行写赋值表达式整串 → V2b error 指路 body', () => {
    const { errors } = validate(`# T

## Goal
G

## Inputs
- customer: line

## Outputs
- r: line  # r

## Steps
1. [act] 追加
  - ← customer
  + → alert_list = alert_list + [customer]  # 追加进名单
  > 提交

2. [reason] R
  + → r: line  # r
`);
    const hit = errors.find(e => e.rule === 'V2b');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('hop_python body');
  });

  it('反例：首字符非 [a-z_]（数字开头）→ V2b error', () => {
    const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → 1st_result: line  # 数字开头

2. [act] A
  - ← r
  + → r: line  # r
`);
    expect(errors.some(e => e.rule === 'V2b')).toBe(true);
  });

  it('正例：Unicode 标识符（中文名一等公民,Python 3 同款——作者两轮裁定终形）零误伤', () => {
    const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → 风险等级: line  # 纯中文名
  + → risk_风险: line  # 混合名

2. [act] A
  - ← 风险等级
  - ← risk_风险
  + → r: line  # r
`);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('反例：连字符名拒（Python 同判——下游 tokenizer 会切成减法,能声明必能引用原则）', () => {
    const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → x-alias: line  # 连字符

2. [act] A
  - ← r
  + → r: line  # r
`);
    expect(errors.some(e => e.rule === 'V2b')).toBe(true);
  });
  // 注：Inputs 行 'bad name: line' 被 parser 静默吞行（inputs=[]）,V2b 够不着——parser 静默
  // 吞行是另一形态的洞,已记 TODO 观察账,本批只闸实撞面（+ → 行）。

  it('正例：合法 snake_case（含 hop_env_ 前缀与带初值形态）零误伤', () => {
    const { errors } = validate(`# T

## Goal
G

## Inputs
- items: [line]

## Outputs
- outs: [line]

## Steps
1. [loop for-each x in items, collect u into outs] 循环
  + → outs: [line] = []  # 带初值形态,名段 outs 单独校验
  1.1. [reason] R
    - ← x
    + → u: line  # u
2. [exit]
`);
    expect(errors.filter(e => e.rule === 'V2b')).toHaveLength(0);
  });
});

// ===== 语言关键词保留字族（i18n 方案 B 同批,2026-08-15 作者定"关键词都是保留字"）=====
// @v: anc-i18n-keyword-reserved
describe('语言关键词保留字族', () => {
  it('反例：产出名撞步骤类型词/属性词 → V2 error', () => {
    for (const kw of ['reason', 'final', 'case', 'collect']) {
      const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → ${kw}: line  # 撞关键词

2. [act] A
  - ← ${kw}
  + → r: line  # r
`);
      expect(errors.some(e => e.rule === 'V2' && /语言关键词/.test(e.message)), kw).toBe(true);
    }
  });

  it('反例：产出名撞修饰词双语（free/开放/escalatable/可上升）→ V2 error（2026-08-26 补录同批入族）', () => {
    for (const kw of ['free', '开放', 'escalatable', '可上升']) {
      const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → ${kw}: line  # 撞关键词

2. [act] A
  - ← ${kw}
  + → r: line  # r
`);
      expect(errors.some(e => e.rule === 'V2' && /语言关键词/.test(e.message)), kw).toBe(true);
    }
  });

  it('反例：Inputs 名撞段头词 → V2 error', () => {
    const { errors } = validate(`# T

## Goal
G

## Inputs
- goal: text

## Outputs
- r: line  # r

## Steps
1. [reason] R
  - ← goal
  + → r: line  # r
`);
    expect(errors.some(e => e.rule === 'V2' && /语言关键词/.test(e.message))).toBe(true);
  });

  // @v: anc-rule-v2 + anc-i18n-keyword-reserved（27轮review:else/其他 收编关键词闸——原散点只拦产出位,
  // Inputs/for-each/collect/call映射四位放行,与"禁作变量名"承诺不符;收编后四族同六位）
  it('反例：else/其他 在原四裸奔位全拦（Inputs/for-each/collect/call映射）', () => {
    const inputsCase = validate(`# T

## Goal
G

## Inputs
- else: text

## Outputs
- r: line  # r

## Steps
1. [reason] R
  - ← else
  + → r: line  # r
`);
    expect(inputsCase.errors.some(e => e.rule === 'V2' && /统配保留字/.test(e.message))).toBe(true);

    const feCase = validate(`# T

## Goal
G

## Inputs
- xs: [line]

## Outputs
- rs: [line]  # rs

## Steps
1. [loop for-each 其他 in xs, collect r into rs] L
  + → rs: [line]  # rs

  1.1. [reason] R
    - ← 其他
    + → r: line  # r
`);
    expect(feCase.errors.some(e => e.rule === 'V2' && /for-each 变量.*统配保留字/.test(e.message))).toBe(true);

    const collectCase = validate(`# T

## Goal
G

## Inputs
- xs: [line]

## Outputs
- rs: [line]  # rs

## Steps
1. [loop for-each x in xs, collect else into rs] L
  + → rs: [line]  # rs

  1.1. [reason] R
    - ← x
    + → else: line  # r
`);
    expect(collectCase.errors.some(e => e.rule === 'V2' && /collect 单项变量.*统配保留字/.test(e.message))).toBe(true);
  });

  // @v: anc-i18n-keyword-reserved （0029:报文自带完整清单——只点名撞到的词=作者无先验避用）
  it('报文契约：关键词撞闸报文列英文全清单+中文同禁提示+指路文档', () => {
    const { errors } = validate(`# T

## Goal
G

## Inputs
- outputs: yaml

## Outputs
- r: line  # r

## Steps
1. [reason] R
  - ← outputs
  + → r: line  # r
`);
    const hit = errors.find(e => e.rule === 'V2' && /语言关键词/.test(e.message));
    expect(hit).toBeDefined();
    // 清单完整性抽查:撞到的词之外还列了别的关键词(inputs/steps/subtask/retry 各族抽一)
    for (const kw of ['inputs', 'steps', 'subtask', 'retry']) {
      expect(hit!.message).toContain(kw);
    }
    expect(hit!.message).toMatch(/中文关键词同为保留字/);
    expect(hit!.message).toMatch(/else/);  // 条件统配词是第四族保留字,清单落点须提及
    expect(hit!.message).toMatch(/语法参考/);
    // 清单只列英文形(中文词不逐个入报文,防报文爆长)
    expect(hit!.message).not.toContain('步骤,');
  });

  it('报文契约：类型名撞闸报文列类型全表+指路', () => {
    const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → yaml: yaml  # 撞类型名
  + → r: line  # r
`);
    const hit = errors.find(e => e.rule === 'V2' && /全局保留字/.test(e.message));
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/text\/bool\/line/);
    expect(hit!.message).toContain('HopSpec');       // 全表须含大小写混合形
    expect(hit!.message).not.toContain('fragment');  // 26轮review抓:手写清单曾含不存在的类型词(漂移实证)
    expect(hit!.message).not.toContain('[line]');    // 列表简写形不入清单
    expect(hit!.message).toMatch(/语法参考/);
  });

  it('正例：形近普通名零误伤（reasoning/final_out/checked）', () => {
    const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → reasoning: line  # 形近
  + → final_out: line  # 后缀
  + → checked: bool  # 过去式

2. [act] A
  - ← reasoning
  - ← final_out
  - ← checked
  + → r: line  # r
`);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('反例：全谱六位同闸——for-each 变量/collect 单项/call 两映射目标撞关键词 → V2 error', () => {
    const feCase = validate(`# T

## Goal
G

## Inputs
- xs: [line]

## Outputs
- o: [line]  # o

## Steps
1. [loop for-each reason in xs, collect 遍历 into o] s
  + → o: [line]  # o
  1.1. [act] a
    - ← reason
    + → 遍历: line  # u
`);
    expect(feCase.errors.some(e => e.rule === 'V2' && /for-each 变量 "reason".*保留字|for-each 变量 "reason".*语言关键词/.test(e.message))).toBe(true);
    expect(feCase.errors.some(e => e.rule === 'V2' && /collect 单项变量 "遍历"/.test(e.message))).toBe(true);
    const callCase = validate(`# T

## Goal
G

## Inputs
- src: line

## Outputs
- r: line  # r

## Steps
1. [call helper(loop: src)] 调子
  + → 循环: out_val
  + → r  # r
`);
    expect(callCase.errors.some(e => e.rule === 'V2' && /输入映射目标 "loop".*语言关键词/.test(e.message))).toBe(true);
    expect(callCase.errors.some(e => e.rule === 'V2' && /输出映射目标 "循环".*语言关键词/.test(e.message))).toBe(true);
  });

  it('反例：变量名撞中文关键词（推理/遍历/其他）→ V2 error（双语同为保留字）', () => {
    for (const kw of ['推理', '遍历', '其他']) {
      const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → ${kw}: line  # 撞中文关键词

2. [act] A
  - ← ${kw}
  + → r: line  # r
`);
      expect(errors.some(e => e.rule === 'V2' && /保留字/.test(e.message)), kw).toBe(true);
    }
  });

  it('正例：含关键词字的普通中文名零误伤（推理结果/客户遍历表）', () => {
    const { errors } = validate(`# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → 推理结果: line  # 含字非撞词
  + → 客户遍历表: line  # 含字非撞词

2. [act] A
  - ← 推理结果
  - ← 客户遍历表
  + → r: line  # r
`);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });
});

// @v: anc-rule-fragment-mode — 片段验证:豁免面显式列举,knownVars 入 V1 来源
describe('fragment validation mode', () => {
  const frag = `1. [subtask] 处理
  + → done: bool  # 完成
  1.1. [reason] 判
    - ← upstream_item
    + → done: bool  # 完成
    > 判断
  1.2. [check final] 验
    - ← done
    + → ok: bool  # 判定
    + → why: text  # 说明
    > 核
`;
  // @v: anc-rule-p4 + anc-rule-fragment-mode（29轮review:P4豁免收窄——死代码闸片段内可判照拦,
  // 交付完备形态仍豁免;整码豁免让expand-node对死代码盲,拼装后才报离产出点隔一层）
  it('片段模式死代码闸照拦：exit 带 hop_python body 在片段内即报 P4', () => {
    const fragWithDeadExit = `1. [act] 算
  - ← upstream_item
  + → r: text  # 结果
  > \`\`\`hop_python
  > r = upstream_item
  > \`\`\`
2. [exit] 交付
  + → r: text  # 结果
  > \`\`\`hop_python
  > r = "dead"
  > \`\`\`
`;
    const { ast } = parseFragment(fragWithDeadExit);
    const errs = validateSpec(ast, undefined, { fragment: true, knownVars: ['upstream_item'] });
    expect(errs.some(e => e.rule === 'P4' && /死代码/.test(e.message))).toBe(true);
    // 交付完备形态的 P4 仍豁免（片段无 header.outputs 对照面,不应报多/漏）
    expect(errs.some(e => e.rule === 'P4' && !/死代码/.test(e.message))).toBe(false);
  });

  it('exempts whole-file completeness rules (S8/S10) but keeps step rules', () => {
    const { ast } = parseFragment(frag);
    const errs = validateSpec(ast, undefined, { fragment: true, knownVars: ['upstream_item'] });
    expect(errs.filter(e => e.severity === 'error')).toEqual([]);
  });

  it('knownVars feeds V1 traceability; without it upstream ref errors', () => {
    const { ast } = parseFragment(frag);
    const errs = validateSpec(ast, undefined, { fragment: true });
    expect(errs.some(e => e.rule === 'V1' && e.message.includes('upstream_item'))).toBe(true);
  });

  // C3/C6 祖先缺席豁免（buildtest 实撞:片段=循环体子树时容器住父上下文——continue/check 合法
  // 却被拒,反馈教 LLM 删掉合法流控;契约翻转:原"片段内 C3 照拦"测试随设计改判）
  it('C3 no-ancestor form exempted in fragment (loop may live in parent context)', () => {
    const frag = `1. [subtask] 组
  + → x: bool  # f
  1.1. [break] 循环体子树里合法
`;
    const { ast } = parseFragment(frag);
    const errs = validateSpec(ast, undefined, { fragment: true });
    expect(errs.some(e => e.rule === 'C3')).toBe(false);
  });

  it('C6 no-ancestor form exempted in fragment (check may sit in parent subtask)', () => {
    const frag = `1. [check] 核验
  - ← x
  + → ok: bool  # 判定
  + → why: text  # 说明
  > 核 x
`;
    const { ast } = parseFragment(frag);
    const errs = validateSpec(ast, undefined, { fragment: true, knownVars: ['x'] });
    expect(errs.some(e => e.rule === 'C6')).toBe(false);
  });

  it('C7 no-ancestor form exempted in fragment (check final may close parent subtask)', () => {
    const frag = `1. [check final] 收尾验收
  - ← x
  + → ok: bool  # 判
  + → why: text  # 说明
  > 核 x
`;
    const { ast } = parseFragment(frag);
    const errs = validateSpec(ast, undefined, { fragment: true, knownVars: ['x'] });
    expect(errs.some(e => e.rule === 'C7')).toBe(false);
  });

  it('C7 tail-position check still enforced in fragment (exploratory step after check final → error)', () => {
    const frag = `1. [subtask] 组
  + → ok: bool  # 判
  1.1. [check final] 验收
    - ← x
    + → ok: bool  # 判
    + → why: text  # 说明
  1.2. [reason] 验收后还探索
    - ← x
    + → more: text  # 违规
    > 不该在这
`;
    const { ast } = parseFragment(frag);
    const errs = validateSpec(ast, undefined, { fragment: true, knownVars: ['x'] });
    expect(errs.some(e => e.rule === 'C7' && e.message.includes('may follow'))).toBe(true);
  });

  it('C3 target checks still enforced in fragment (local target not a loop → error)', () => {
    const frag = `1. [subtask] 组
  + → x: bool  # f
  1.1. [break 1] 目标非 loop
`;
    const { ast } = parseFragment(frag);
    const errs = validateSpec(ast, undefined, { fragment: true });
    expect(errs.some(e => e.rule === 'C3' && e.message.includes('is not a loop'))).toBe(true);
  });

  it('knownVars wildcard type: upstream list var usable as for-each source (V8 not misfired)', () => {
    const frag = `1. [loop for-each item in upstream_list, collect out into outs] 遍历
  + → outs: [line]  # 收集
  1.1. [reason] 处理
    - ← item
    + → out: line  # 单项
    > 处理一项
`;
    const { ast } = parseFragment(frag);
    const errs = validateSpec(ast, undefined, { fragment: true, knownVars: ['upstream_list'] });
    expect(errs.filter(e => e.severity === 'error')).toEqual([]);
  });

  it('V7 exemption is scoped to synthesized known-vars only (author-written bad type still caught)', () => {
    const frag = `1. [reason] r
  - ← x
  + → y: bool  # f
  > t
`;
    // knownVars 合成的空类型不报 V7
    const { ast } = parseFragment(frag);
    const ok = validateSpec(ast, undefined, { fragment: true, knownVars: ['x'] });
    expect(ok.some(e => e.rule === 'V7')).toBe(false);
    // 片段自带 Inputs 坏类型仍拦——V7 不整类豁免
    const withBad = parseFragment(frag);
    withBad.ast.header.inputs = [{ name: 'z', type: 'bogus_type', description: 'bad' }];
    const errs = validateSpec(withBad.ast, undefined, { fragment: true, knownVars: ['x'] });
    expect(errs.some(e => e.rule === 'V7' && e.message.includes('z'))).toBe(true);
  });

  it('non-fragment mode unchanged: S8 still fires on missing goal', () => {
    const { ast } = parseFragment(frag);
    const errs = validateSpec(ast);
    expect(errs.some(e => e.rule === 'S8')).toBe(true);
  });
});

// B6 判空 null-safety lint（0015 作者拍板 A+B——info 非阻断,口径最窄仅 `!= ""`/`== ""` 两字面形态;
// gl-recon 实撞:None != "" 为 True,6 breaks 全归因 mapping 静默全错）。
// @v: anc-rule-b6
describe('B6: 判空形态 null-safety lint（info 非阻断）', () => {
  const F = '\u0060\u0060\u0060';
  const mkSpec = (cond: string) => `# T
Id: t
## Goal
g
## Inputs
- item: yaml  # i
## Outputs
- has_tag: bool  # h
## Steps
1. [act] 判
  - ← item
  + → has_tag: bool
  > 纯计算
  > ${F}hop_python
  > if ${cond}:
  >   has_tag = True
  > else:
  >   has_tag = False
  > ${F}
2. [exit] 完
`;

  it('反例：!= "" 判空 → B6 info 提示指路 truthy（probe 形态,不阻断—— status 无 error）', () => {
    const { errors } = validate(mkSpec('item.tag != ""'));
    const b6 = errors.find(e => e.rule === 'B6');
    expect(b6).toBeDefined();
    expect(b6!.severity).toBe('info');                       // 非阻断
    expect(b6!.message).toContain('if x:');                  // 指路钦定惯用形
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('反例：== "" 判空 → B6 info（对偶形态——null 时 False 漏判空）', () => {
    const { errors } = validate(mkSpec('item.tag == ""'));
    expect(errors.find(e => e.rule === 'B6')?.severity).toBe('info');
  });

  it('正例：truthy 判空/is None/与非空串比较/in 成员测试 → 零 B6（最窄口径不误报）', () => {
    for (const cond of ['item.tag', 'item.tag is None', 'item.tag != "done"', '"x" in item.tag']) {
      const { errors } = validate(mkSpec(cond));
      expect(errors.find(e => e.rule === 'B6'), cond).toBeUndefined();
    }
  });

  // case 条件同规（十九审——教学面'case 条件与 act body 同规',初版实装只挂 body walker,
  // case 条件走 checkCaseCondition 独立路径 lint 不触发:教学与实装脱节,行为探针实锤后补）
  const mkBranchSpec = (cond: string) => `# T
Id: t
## Goal
g
## Inputs
- item: yaml  # i
## Outputs
- r: text  # r
## Steps
1. [branch] 分
  + → r: text
  1.1. [case(${cond})] 甲
    + → r: text
    1.1.1. [reason] a
      + → r: text  # r
      > t
  1.2. [case(else)] 乙
    + → r: text
    1.2.1. [reason] b
      + → r: text  # r
      > t
2. [exit] 完
`;

  it('反例：case 条件 != "" 判空 → B6 info（case 与 body 同规——教学承诺的实装面）', () => {
    const { errors } = validate(mkBranchSpec('item.tag != ""'));
    const b6 = errors.find(e => e.rule === 'B6');
    expect(b6).toBeDefined();
    expect(b6!.severity).toBe('info');
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);   // 仍非阻断
  });

  it('正例：case 条件与非空串比较 → 零 B6（case 侧同样不误报）', () => {
    const { errors } = validate(mkBranchSpec('item.tag != "done"'));
    expect(errors.find(e => e.rule === 'B6')).toBeUndefined();
  });
});

// B7: [act free] 自由任务档形态完备（概念 ^anc-step-act free 条款,2026-08-22 作者定
// "act 应该努力简化,但实在拆不开也可以承认现状"→显式修饰;free 与 body 互斥,无 free
// 无 body warn 促简化）// @v: anc-rule-b7
describe('B7: [act free] 自由任务档形态', () => {
  const mk = (stepLine: string, body = '') => `# T
Id: t
## Goal
g
## Inputs
- src: text  # 输入
## Outputs
- out: text  # 输出
## Steps
${stepLine}
  - ← src
  + → out: text  # 产出
${body}`;

  function v(md: string) {
    const { ast, errors: pe } = parseSpec(md);
    expect(pe).toEqual([]);
    return validateSpec(ast);
  }

  it('正例：[act free] 无 body → 零 B7（自由任务档合法形态）', () => {
    const errors = v(mk('1. [act free] 按规范整理输入生成产出'));
    expect(errors.filter(e => e.rule === 'B7')).toEqual([]);
  });

  it('正例：[act] 带 body → 零 B7（机械档合法形态）', () => {
    const errors = v(mk('1. [act] 原样转存', '  > ```hop_python\n  > out = src\n  > ```'));
    expect(errors.filter(e => e.rule === 'B7')).toEqual([]);
  });

  it('反例：[act free] 又带 body → B7 error（两档互斥）', () => {
    const errors = v(mk('1. [act free] 转存', '  > ```hop_python\n  > out = src\n  > ```'));
    const b7 = errors.find(e => e.rule === 'B7');
    expect(b7).toBeDefined();
    expect(b7!.severity).toBe('error');
    expect(b7!.message).toContain('互斥');
  });

  it('反例：[act] 无 free 无 body → B7 warn（形态欠账:补 body 或标 free）', () => {
    const errors = v(mk('1. [act] 整理输入'));
    const b7 = errors.find(e => e.rule === 'B7');
    expect(b7).toBeDefined();
    expect(b7!.severity).toBe('warn');
    expect(b7!.message).toContain('free');
  });

  it('反例：[commit] 无 body → B7 error（2026-08-31 作者宣布升级——22 日两拍到期兑现,过渡期观察=LLM 通道四缺陷叠加）', () => {
    const errors = v(mk('1. [commit] 发送产出'));
    const b7 = errors.find(e => e.rule === 'B7');
    expect(b7).toBeDefined();
    expect(b7!.severity).toBe('error');
    expect(b7!.message).toContain('commit');
  });

  it('正例：[commit] 带 body → 零 B7（生成期定死动作,执行期零裁量）', () => {
    const errors = v(mk('1. [commit] 写盘交付', '  > ```hop_python\n  > write(path: "out.md", content: src)\n  > out = src\n  > ```'));
    expect(errors.filter(e => e.rule === 'B7')).toEqual([]);
  });

  it('反例：free 挂非 act 宿主（[commit free]）→ 属性总闸 parse error', () => {
    const { errors: pe } = parseSpec(mk('1. [commit free] 提交'));
    expect(pe.some(e => e.message.includes('free'))).toBe(true);
  });

  it('serializer 往返：[act free] 写回保留 free（丢写=降级为无标注 act,B7 误报 warn）', () => {
    const { ast } = parseSpec(mk('1. [act free] 自由任务'));
    const out = serializeSpec(ast);
    expect(out).toContain('[act free]');
    const { ast: ast2, errors: pe2 } = parseSpec(out);
    expect(pe2).toEqual([]);
    expect((ast2.steps![0] as { free?: boolean }).free).toBe(true);
  });
});

// S15: on_fail 失败兜底块位置约束（^anc-step-on-fail/^anc-rule-s15,2026-08-21 作者立）
// @v: anc-rule-s15, anc-step-on-fail
describe('S15: [on fail] 失败兜底块位置约束', () => {
  function v(md: string) {
    const { ast, errors: pe } = parseSpec(md);
    expect(pe).toEqual([]);
    return validateSpec(ast);
  }

  it('正例：subtask 末位 on fail（check final 之后）→ 零 S14;中文 [失败兜底] 同判', () => {
    const md = `# T
## Goal
g
## Steps
1. [subtask retry=2] 事务
  + → out: text  # o
  1.1. [act] 干活
    + → out: text  # o
  1.2. [check final] 验收
    - ← out
    + → ok: bool  # 判
    + → note: text  # 说明
  1.3. [on fail] 兜底
    1.3.1. [act] 记档
      + → out: text  # 兜底
`;
    expect(v(md).filter(e => e.rule === 'S15')).toEqual([]);
    expect(v(md.replace('[on fail]', '[失败兜底]')).filter(e => e.rule === 'S15')).toEqual([]);
  });

  it('反例：on fail 不在末位 → S14 error', () => {
    const md = `# T
## Goal
g
## Steps
1. [subtask] 事务
  + → out: text  # o
  1.1. [on fail] 兜底
    1.1.1. [act] 记档
      + → out: text  # 兜底
  1.2. [act] 干活
    + → out: text  # o
`;
    expect(v(md).some(e => e.rule === 'S15' && e.message.includes('最后一个'))).toBe(true);
  });

  it('反例：on fail 宿主非 subtask/case（loop 下/顶层）→ S14 error', () => {
    const inLoop = `# T
## Goal
g
## Inputs
- xs: [text]  # l
## Steps
1. [loop for-each x in xs] 循环
  1.1. [act] 干
    - ← x
    + → y: text  # o
  1.2. [on fail] 兜底
    1.2.1. [act] 记
      + → y: text  # o
`;
    expect(v(inLoop).some(e => e.rule === 'S15')).toBe(true);
    const topLevel = `# T
## Goal
g
## Steps
1. [on fail] 兜底
  1.1. [act] 记
    + → y: text  # o
`;
    expect(v(topLevel).some(e => e.rule === 'S15' && e.message.includes('顶层'))).toBe(true);
  });

  it('反例：一容器两个 on fail → S14 error（至多一个）', () => {
    const md = `# T
## Goal
g
## Steps
1. [subtask] 事务
  + → out: text  # o
  1.1. [act] 干活
    + → out: text  # o
  1.2. [on fail] 兜底A
    1.2.1. [act] 记
      + → out: text  # o
  1.3. [on fail] 兜底B
    1.3.1. [act] 记
      + → out: text  # o
`;
    expect(v(md).some(e => e.rule === 'S15' && e.message.includes('至多一个'))).toBe(true);
  });

  it('正例：check final 之后接 on fail——S15 与 C7 两规则钦定的同一标准形态零冲突（四次复审实抓互斥矛盾:C7 提交段白名单原不含 on_fail,标准形态必红）', () => {
    const md = `# T
## Goal
g
## Steps
1. [subtask retry=1] 事务
  + → out: text  # o
  1.1. [act] 干活
    + → out: text  # o
  1.2. [check final] 验收
    - ← out
    + → ok: bool  # 判
    + → note: text  # 说明
  1.3. [on fail] 兜底
    1.3.1. [act] 记档
      + → out: text  # 兜底
`;
    const all = v(md);
    expect(all.filter(e => e.rule === 'S15')).toEqual([]);
    expect(all.filter(e => e.rule === 'C7')).toEqual([]);
  });

  it('正例：serializer 往返——on_fail 写回 [on fail] 标准形再 parse 同型', () => {
    const md = `# T
## Goal
g
## Steps
1. [subtask] 事务
  + → out: text  # o
  1.1. [act] 干活
    + → out: text  # o
  1.2. [on fail] 兜底
    1.2.1. [act] 记档
      + → out: text  # o
`;
    const { ast } = parseSpec(md);
    const out = serializeSpec(ast);
    expect(out).toContain('[on fail]');
    const { ast: ast2, errors } = parseSpec(out);
    expect(errors).toEqual([]);
    const flat = (ast2.steps ?? []).flatMap(function walk(s): string[] { return [s.step_type, ...('children' in s ? (s as { children: import('../src/ast-types.js').StepNode[] }).children.flatMap(walk) : [])]; });
    expect(flat).toContain('on_fail');
  });
});

// B8 结构声明输出禁赋标量字面量（0023 作者拍板方案一:静态闸主治,方案二〔body失配不转retry〕
// 谢绝——容器retry对body失败并非总无意义:body输入来自前序LLM步时重跑轮输入会变;唯字面量
// 直赋是输入无关必死,恰为本闸判定面。实撞:11子实例39万token白烧,根因一行源码类型说谎）。
// @v: anc-rule-b8
describe('B8: yaml/[T] 声明输出禁赋标量字面量（error）', () => {
  const F = '\u0060\u0060\u0060';
  const mk = (decl: string, bodyLine: string) => `# T
Id: t
## Goal
g
## Outputs
- cur: ${decl}  # c
## Steps
1. [act] 赋
  + → cur: ${decl}
  > 纯计算
  > ${F}hop_python
${bodyLine}
  > ${F}
2. [exit] 完
`;

  it('反例：yaml ← ""（probe 形态）→ B8 error 报文给改法带行号', () => {
    const { errors } = validate(mk('yaml', '  > cur = ""'));
    const b8 = errors.find(e => e.rule === 'B8');
    expect(b8).toBeDefined();
    expect(b8!.severity).toBe('error');
    expect(b8!.message).toContain('空态写 {} 或 []');
    expect(b8!.message).toContain('body 第');
  });

  it('反例：LiteralExpr 四型全拦（数字/bool/None 对 yaml;串对 [text]）', () => {
    for (const [decl, line] of [['yaml', '  > cur = 42'], ['yaml', '  > cur = true'], ['yaml', '  > cur = None'], ['[text]', '  > cur = "x"']] as const) {
      const { errors } = validate(mk(decl, line));
      expect(errors.find(e => e.rule === 'B8'), `${decl} ← ${line}`).toBeDefined();
    }
  });

  it('反例：if 分支内的字面量直赋同拦（walk 递归覆盖）', () => {
    const spec = mk('yaml', '  > if 1 > 0:\n  >     cur = ""\n  > else:\n  >     cur = {}').replace(/\\n/g, '\n');
    const { errors } = validate(spec);
    expect(errors.filter(e => e.rule === 'B8')).toHaveLength(1);   // then 支拦,else 支 {} 不拦
  });

  it('正例：{} / [] / 表达式 / 变量赋值 → 零 B8（只判字面量直赋——数据流归运行期）', () => {
    for (const line of ['  > cur = {}', '  > cur = []', '  > cur = {"k": 1}', '  > tmp = ""\n  > cur = build(x: tmp)'] ) {
      const spec = mk('yaml', line).replace(/\\n/g, '\n');
      const { errors } = validate(spec);
      expect(errors.find(e => e.rule === 'B8'), line).toBeUndefined();
    }
  });

  it('正例：局部变量（非声明输出）赋标量不拦（无类型声明无从违反）;text 声明输出赋串不拦', () => {
    const spec = `# T
Id: t
## Goal
g
## Outputs
- msg: text  # m
## Steps
1. [act] 赋
  + → msg: text
  > 纯计算
  > \u0060\u0060\u0060hop_python
  > tmp = ""
  > msg = "done"
  > \u0060\u0060\u0060
2. [exit] 完
`.replace(/\\u0060/g, '\u0060');
    const { errors } = validate(spec);
    expect(errors.find(e => e.rule === 'B8')).toBeUndefined();
  });
});

// B9：act/check body 写域静态检（2026-09-01 dr21 双撞立规——act 建持久目录构建期全绿
// 真机撞 WORK_ZONE_ONLY 各烧一轮:第十二次步21/第十六次步32。静态拦字面路径形态,
// 变量路径静态不求值留运行时闸,commit 步豁免）。
// @v: anc-rule-b9
describe('B9: act/check body 写域静态检', () => {
  const F = '\u0060\u0060\u0060';
  const mkAct = (bodyLine: string, stepType = 'act') => `# T
Id: t
## Goal
g
## Outputs
- r: line  # x
## Steps
1. [${stepType}] 写
  + → r: line
  > 说明
  > ${F}hop_python
${bodyLine}
  > r = "ok"
  > ${F}
2. [exit] 完
`;

  it('反例：act body makedirs 字面路径（dr21 原步21形态）→ B9 error', () => {
    const { errors } = validate(mkAct('  > makedirs(path: "DocReviewers/x/reviewers")'));
    const b9 = errors.find(e => e.rule === 'B9');
    expect(b9).toBeDefined();
    expect(b9!.severity).toBe('error');
    expect(b9!.message).toContain('work_zone_path');
  });

  it('反例：拼接表达式最左叶字面量（"rounds/" + rid）同拦', () => {
    const { errors } = validate(mkAct('  > makedirs(path: "rounds/" + rid)'));
    expect(errors.find(e => e.rule === 'B9')).toBeDefined();
  });

  it('正例：act body write 用 work_zone_path() 包裹放行', () => {
    const { errors } = validate(mkAct('  > write(path: work_zone_path("draft.md"), content: "x")'));
    expect(errors.find(e => e.rule === 'B9')).toBeUndefined();
  });

  it('正例：commit 步字面路径豁免（写 workspace 是本职）', () => {
    const spec = `# T
Id: t
## Goal
g
## Outputs
- r: line  # x
## Steps
1. [subtask] 包
  + → r: line
  1.1. [check final] 核
    + → ok: bool  # b
    + → note: text  # w
    > \u0060\u0060\u0060hop_python
    > ok = True
    > note = ""
    > \u0060\u0060\u0060
2. [commit] 交付写盘
  - ← r
  > \u0060\u0060\u0060hop_python
  > write(path: "deliver/out.md", content: "x")
  > \u0060\u0060\u0060
`.replaceAll('\u0060', String.fromCharCode(96));
    const { errors } = validate(spec);
    expect(errors.find(e => e.rule === 'B9')).toBeUndefined();
  });

  it('正例：act 变量路径不误报（静态不求值,归运行时闸）', () => {
    const { errors } = validate(mkAct('  > makedirs(path: target_dir)'));
    expect(errors.find(e => e.rule === 'B9')).toBeUndefined();
  });
});

// B10：body 读侧字面绝对路径静态检（2026-09-01 deep-validate 批立规——九坑之坑 6 读侧半边:
// body 文件工具字面绝对路径构建期全绿,真机撞沙箱"禁绝对路径"拒,0042 卡记同款实撞十一次。
// B9 同形姊妹条:判定件收窄"字面量且以 / 开头",相对路径读侧完全合法;commit 不豁免——
// 读侧无"写 workspace 本职"对应物,绝对路径对 commit 的 read 同样必拒）。
// @v: anc-rule-b10
describe('B10: body 读侧字面绝对路径静态检', () => {
  const F = String.fromCharCode(96).repeat(3);
  const mkStep = (bodyLine: string, stepType = 'act') => `# T
Id: t
## Goal
g
## Outputs
- r: line  # x
## Steps
1. [${stepType}] 读
  + → r: line
  > 说明
  > ${F}hop_python
${bodyLine}
  > ${F}
2. [exit] 完
`;

  it('反例：act body read 字面绝对路径（0042 十一撞形态）→ B10 error 指路相对路径', () => {
    const { errors } = validate(mkStep('  > r = read(path: "/Users/x/f.md")'));
    const b10 = errors.find(e => e.rule === 'B10');
    expect(b10).toBeDefined();
    expect(b10!.severity).toBe('error');
    expect(b10!.message).toContain('workspace 相对');
  });

  it('反例：拼接表达式最左叶绝对字面量（"/tmp/" + name 的 exists）同拦', () => {
    const { errors } = validate(mkStep('  > r = exists(path: "/tmp/" + name)'));
    expect(errors.find(e => e.rule === 'B10')).toBeDefined();
  });

  it('反例：commit body 绝对路径同拒（读侧无写域豁免对应物）', () => {
    const spec = `# T
Id: t
## Goal
g
## Outputs
- r: line  # x
## Steps
1. [subtask] 包
  + → r: line
  1.1. [check final] 核
    + → ok: bool  # b
    + → note: text  # w
    > ${F}hop_python
    > ok = True
    > note = ""
    > ${F}
2. [commit] 交付
  - ← r
  > ${F}hop_python
  > prev = read(path: "/etc/hosts")
  > write(path: "deliver/out.md", content: prev)
  > ${F}
`;
    const { errors } = validate(spec);
    expect(errors.find(e => e.rule === 'B10')).toBeDefined();
  });

  it('正例：相对路径放行（读侧相对路径完全合法）', () => {
    const { errors } = validate(mkStep('  > r = read(path: ".anchor-audit/x.yaml")'));
    expect(errors.find(e => e.rule === 'B10')).toBeUndefined();
  });

  it('正例：work_zone_path() 包裹放行（其产物是合法绝对形态）', () => {
    const { errors } = validate(mkStep('  > r = read(path: work_zone_path("f.md"))'));
    expect(errors.find(e => e.rule === 'B10')).toBeUndefined();
  });

  it('正例：变量路径放行（静态不求值,归运行时闸）', () => {
    const { errors } = validate(mkStep('  > r = read(path: some_path)'));
    expect(errors.find(e => e.rule === 'B10')).toBeUndefined();
  });

  it('正例：listdir 相对路径放行、写侧字面相对路径归 B9 不误挂 B10', () => {
    const { errors } = validate(mkStep('  > r = listdir(path: "docs")'));
    expect(errors.find(e => e.rule === 'B10')).toBeUndefined();
  });
});

// subtask free 静态面三修（^anc-rule-p8/^anc-rule-p10/^anc-rule-b7 互斥——三轮review批,修前形态即红）。
// @v: anc-rule-p8, anc-rule-p10, anc-rule-b7, anc-exec-subtask-free-expand
describe('subtask free 静态面适配', () => {
  it('正例：空 free 视作 P8 把关点——"commit 写外面"教法不再撞闸（修前红:P8 error）', () => {
    const { ast, errors: pe } = parseSpec(`# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=2] 外壳
  + → out: text  # o
  1.1. [subtask free] 到步展开
    + → mid: text  # m
  1.2. [commit] 按教法写在free外面
    - ← mid
`);
    expect(pe).toHaveLength(0);
    const errs = validateSpec(ast!);
    expect(errs.some(e => e.rule === 'P8' && e.severity === 'error')).toBe(false);
  });

  it('反例：非 free 空 subtask 不是把关点（豁免不外溢——P8 照拦）', () => {
    const { ast } = parseSpec(`# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=2] 外壳
  + → out: text  # o
  1.1. [reason] 干活
    + → mid: text  # m
  1.2. [commit] 无把关
    - ← mid
`);
    const errs = validateSpec(ast!);
    expect(errs.some(e => e.rule === 'P8' && e.severity === 'error')).toBe(true);
  });

  it('正例：空 free 声明交付物零 P10 warn（修前红:合规写法必然误报）', () => {
    const { ast } = parseSpec(`# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [reason] 前
  + → a: text  # p
2. [subtask free] 到步展开
  - ← a
  + → out: text  # o
`);
    const errs = validateSpec(ast!);
    expect(errs.filter(e => e.rule === 'P10' && e.message.includes('"2"'))).toHaveLength(0);
  });

  it('反例：Config expansion_max 非法值 warn 不 error（可配化随批,^anc-exec-subtask-free-expand 契约7——配置钝感:validate 早看见,运行时回缺省不炸）', () => {
    const { ast } = parseSpec(`# T
Id: t
## Goal
g
## Config
expansion_max: -3
## Outputs
- out: text  # o
## Steps
1. [reason] 干
  + → out: text  # o
`);
    const errs = validateSpec(ast!);
    const hit = errs.filter(e => e.rule === 'config' && e.message.includes('expansion_max'));
    expect(hit).toHaveLength(1);
    expect(hit[0]!.severity).toBe('warn');
  });

  it('正例：Config expansion_max 合法正整数零告警', () => {
    const { ast } = parseSpec(`# T
Id: t
## Goal
g
## Config
expansion_max: 50
## Outputs
- out: text  # o
## Steps
1. [reason] 干
  + → out: text  # o
`);
    const errs = validateSpec(ast!);
    expect(errs.filter(e => e.rule === 'config')).toHaveLength(0);
  });

  it('反例：free×parallel 互斥拒（B7——修前红:两属性同收静默竞争）', () => {
    const { ast, errors: pe } = parseSpec(`# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask free parallel] 竞争形态
  + → out: text  # o
`);
    expect(pe).toHaveLength(0);
    const errs = validateSpec(ast!);
    expect(errs.some(e => e.rule === 'B7' && e.message.includes('互斥'))).toBe(true);
  });
});

// @v: anc-exec-output-quoted-prefix-repair — doc-review 首跑二撞（2026-08-30）:中文写作高频形态
// `键: "引号片段"接裸文` 是非法 YAML 标量,一行炸整文 yamlLoad,恢复阶梯判真散文放弃——
// 10 条风险点内容完好三连 SCHEMA_MISMATCH 烧尽。修:解析失败后逐行修复命中行重试。
describe('repairQuotedPrefixScalars（值内前置引号片段修复）', () => {
  it('正例：实撞形态——列表项值以引号片段开头接裸文 → 修复后 yamlLoad 解出完整列表', () => {
    const text = [
      'risk_draft:',
      '  - id: R3',
      '    risk_point: "陶寺=尧都"是证据链推定而非定论：王巍明言"未得到文字证据就不能定论"——文档若径写即过度确定。',
      '    decision: 采纳',
      '  - id: R4',
      '    risk_point: 石峁遗址族群归属学界三派分歧',
    ].join('\n');
    const { load } = require('js-yaml');
    expect(() => load(text)).toThrow();                       // 原文确实炸
    const repaired = repairQuotedPrefixScalars(text);
    expect(repaired).not.toBe(text);                          // 命中修复
    const doc = load(repaired) as { risk_draft: Array<Record<string, string>> };
    expect(doc.risk_draft).toHaveLength(2);
    expect(doc.risk_draft[0].risk_point).toContain('陶寺=尧都');
    expect(doc.risk_draft[0].risk_point).toContain('过度确定');  // 裸文尾巴没丢
    expect(doc.risk_draft[1].risk_point).toContain('石峁');      // 未命中行原样
  });

  it('正例：恢复阶梯端到端——[yaml] 列表声明收到含引号前缀行的字符串（实撞同形:字段名顶键）→ 修复+剥层解出列表', () => {
    const raw = 'data:\n  - note: "要点"后面还有话\n    ok: true';
    const out = recoverOutputValues(
      [{ name: 'data', type: '[yaml]', description: '' }],
      { data: raw },
    );
    expect(Array.isArray(out.data)).toBe(true);
    expect((out.data as Array<{ note: string }>)[0].note).toContain('要点');
    expect((out.data as Array<{ note: string }>)[0].note).toContain('后面还有话');
  });

  it('反例：整值被引号完整包住（合法 YAML）→ 无命中,返回原文本引用（不误伤合法行）', () => {
    const text = 'note: "完整引号包住的合法值"\nok: true';
    expect(repairQuotedPrefixScalars(text)).toBe(text);
  });

  it('反例：纯散文（无键值形态）→ 无命中,原样返回', () => {
    const text = '这是一段"带引号"的散文,不是键值对。';
    expect(repairQuotedPrefixScalars(text)).toBe(text);
  });

  // @v: anc-exec-output-quoted-prefix-repair — parseYamlStructure 接线保护（review 变异5实证:
  // 修复块改 return undefined 全绿零保护——yaml 型 checkValue/coerce 共用判据面的修复重试须锁住;
  // 归一路径:checkValue 判"可 parse 成结构的字符串"合格→coerceOutputValues parse 成结构入变量空间）。
  it('正例：yaml 型声明收到含引号前缀行的结构文本 → parseYamlStructure 接线修复后归一成结构（变异5重放保护）', () => {
    const raw = 'items:\n  - note: "要点"后面还有话\n    ok: true';
    const out = coerceOutputValues(
      [{ name: 'data', type: 'yaml', description: '' }],
      { data: raw },
    );
    expect(typeof out.data).toBe('object');
    expect((out.data as { items: Array<{ note: string }> }).items[0].note).toContain('要点');
  });

  it('正例：列表项前缀形态 `- 键: "片段"接裸文` → 修复原语命中（(?:- )? 容忍分支）', () => {
    const { load } = require('js-yaml');
    const text = 'rows:\n  - note: "开头"接裸文尾巴\n    ok: true';
    const repaired = repairQuotedPrefixScalars(text);
    // 该形态命中的是缩进键行;真正的列表项前缀行形态单独验:
    const text2 = '- note: "开头"接裸文尾巴';
    const repaired2 = repairQuotedPrefixScalars(text2);
    expect(repaired2).not.toBe(text2);
    const doc = load(repaired2) as Array<{ note: string }>;
    expect(doc[0].note).toContain('开头');
    expect(doc[0].note).toContain('尾巴');
    void repaired;
  });

  it('反例：修复后二次解析仍炸 → 判真散文原样放弃（"仍炸"分支）', () => {
    // 构造:含引号前缀行(会被修复)但另有一行完全非法的 YAML(修复不了)——二次解析仍炸
    const raw = 'note: "片段"接裸文\n\t- : : 完全非法的行 [未闭合';
    const out = recoverOutputValues(
      [{ name: 'data', type: 'yaml', description: '' }],
      { data: raw },
    );
    expect(out.data).toBe(raw);   // 原样保留(恢复放弃),不造假结构
  });
});

// 列表元素位单键自嵌套剥壳（hopissues/0053——家族第 5 马甲:壳在元素位非值顶层。
// [line] 声明收到 [{"字段名":["真值"]}]:值是列表过"是结构"关,顶层剥不触发,元素壳无人剥,
// 三轮同因盲死——hopkb r15 批 8/32 灭实撞）
// @v: anc-exec-output-fence-recovery
describe('恢复阶梯:列表元素位单键自嵌套（hopissues/0053）', () => {
  const DECL = [{ name: 'touched_domains', type: '[line]', description: '' }];

  it('正例：卡内 probe 主判据——[{"字段名": ["a","b"]}] 解出 ["a","b"]（元素壳剥+拼平）', () => {
    const out = recoverOutputValues(DECL, { touched_domains: [{ touched_domains: ['法律/刑法/分则', '法律/刑法/总则'] }] });
    expect(out.touched_domains).toEqual(['法律/刑法/分则', '法律/刑法/总则']);
  });

  it('正例：逐元素标量壳——[{f:"a"},{f:"b"}] → ["a","b"]（就地替换形态）', () => {
    const out = recoverOutputValues(DECL, { touched_domains: [{ touched_domains: 'a' }, { touched_domains: 'b' }] });
    expect(out.touched_domains).toEqual(['a', 'b']);
  });

  it('正例：元素内多层同键自嵌套剥至不动点——[{f:{f:["a"]}}] → ["a"]', () => {
    const out = recoverOutputValues(DECL, { touched_domains: [{ touched_domains: { touched_domains: ['a'] } }] });
    expect(out.touched_domains).toEqual(['a']);
  });

  it('反例：卡内 probe 反判据——任一元素键名≠字段名整列表不碰（[{"别的键":[...]}] 照拒不救——混合形态说明列表语义真是对象列表不是壳）', () => {
    const v1 = [{ 别的键: ['a'] }];
    const out1 = recoverOutputValues(DECL, { touched_domains: v1 });
    expect(out1.touched_domains).toBe(v1);   // 原引用原样——未被碰
    const v2 = [{ touched_domains: ['a'] }, { 别的键: ['b'] }];   // 混合:一个同名一个不同名
    const out2 = recoverOutputValues(DECL, { touched_domains: v2 });
    expect(out2.touched_domains).toBe(v2);
  });

  it('反例：合法对象列表不误伤——[yaml] 声明收多键对象元素原样保留', () => {
    const decl = [{ name: 'rows', type: '[yaml]', description: '' }];
    const v = [{ rows: 1, note: 'x' }, { rows: 2, note: 'y' }];   // 元素含 rows 键但非单键——不是壳
    const out = recoverOutputValues(decl, { rows: v });
    expect(out.rows).toBe(v);
  });

  it('反例：空列表不触发（every 对空数组恒 true 的边界——length>0 前置钉）', () => {
    const v: unknown[] = [];
    const out = recoverOutputValues(DECL, { touched_domains: v });
    expect(out.touched_domains).toBe(v);   // 空列表本就合法,不碰
  });

  it('正例：经 normalizeOutputsToFixpoint 全链——元素壳剥出后过 [line] 校验（probe 的引擎侧真实路径）', async () => {
    const { normalizeOutputsToFixpoint, validateOutputValues } = await import('../src/validator.js');
    const decls = [{ name: 'touched_domains', type: '[line]', description: '' }];
    const normalized = normalizeOutputsToFixpoint(decls, { touched_domains: [{ touched_domains: ['a', 'b'] }] });
    expect(normalized.touched_domains).toEqual(['a', 'b']);
    expect(validateOutputValues(decls, normalized)).toEqual([]);   // 过校验零 mismatch
  });
});




// S16 并行收集断链静态检测（^anc-rule-s16,2026-09-04 作者补拍——写时抓"spec 真断链",
// 与引擎续链收割两半合拢消灭静默地带）// @v: anc-rule-s16
describe('S16 并行收集产出链完整', () => {
  const mk = (steps: string) => `# T
Id: t
## Goal
g
## Inputs
- items: [line]  # in
## Outputs
- paths: [line]  # out
## Steps
${steps}
9. [exit]
`;

  it('反例：中间壳漏声明被收集变量 → S16 error 点名断在哪层', () => {
    const { ast } = parseSpec(mk(`1. [loop for-each x in items, collect p into paths] 循环
  + → paths: [line]  # c
  1.1. [subtask retry=0] 壳
    1.1.1. [call callee(x) parallel] 派发
      + → p: result  # map
`));
    const errs = validateSpec(ast!).filter(e => e.rule === 'S16');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some(e => e.message.includes('断链') && e.message.includes('1.1'))).toBe(true);
  });

  it('正例：链齐（壳声明边界产出）→ S16 零报', () => {
    const { ast } = parseSpec(mk(`1. [loop for-each x in items, collect p into paths] 循环
  + → paths: [line]  # c
  1.1. [subtask retry=0] 壳
    + → p: line  # unit
    1.1.1. [call callee(x) parallel] 派发
      + → p: result  # map
`));
    const errs = validateSpec(ast!).filter(e => e.rule === 'S16');
    expect(errs).toEqual([]);
  });

  it('正例：call 直挂 loop（零中间容器）→ S16 零报（既有合法形态不误伤）', () => {
    const { ast } = parseSpec(mk(`1. [loop for-each x in items, collect p into paths] 循环
  + → paths: [line]  # c
  1.1. [call callee(x) parallel] 派发
    + → p: result  # map
`));
    const errs = validateSpec(ast!).filter(e => e.rule === 'S16');
    expect(errs).toEqual([]);
  });

  it('反例：collect 点名无人供 → S16 error（点名的变量循环体直接子级零声明）', () => {
    const { ast } = parseSpec(mk(`1. [loop for-each x in items, collect ghost into paths] 循环
  + → paths: [line]  # c
  1.1. [act] 干活
    + → other: line  # 别的
`));
    const errs = validateSpec(ast!).filter(e => e.rule === 'S16');
    expect(errs.some(e => e.message.includes('无人供给'))).toBe(true);
  });
});
