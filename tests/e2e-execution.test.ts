// @module-deps: exec-engine, shared-providers
import { describe, it, expect } from 'vitest';
import { ExecutionEngine } from '../src/engine.js';
import type { HostConfig } from '../src/provider-types.js';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOST: HostConfig = {
  workspace_dir: '/tmp/test',
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'test-key',
};

const DATA_QUALITY_SPEC = `# Spec: 数据质量评估与修复
Id: data-quality
Goal: 评估输入数据集的质量问题，自动修复并生成质量报告

## Inputs
- raw_data: yaml  # 原始数据集
- quality_threshold: int  # 质量达标阈值

## Outputs
- quality_report: markdown  # 质量报告

## Constraints
- 修复后数据行数保留率 ≥ 90%
- 不可篡改原始业务字段含义

## Types
- DataRecord:
  - id: line  # 记录标识
  - fields: yaml  # 业务字段
  - source: line  # 数据来源

## Steps
1. [act] 统计数据质量指标（缺失率、异常分布、跨字段一致性）
  - ← raw_data
  + → profile: yaml  # 数据质量画像
2. [reason] 解读质量画像，制定修复策略
  - ← profile
  + → fix_strategy: text  # 修复策略
  > 权衡数据保留率与质量，选择合适的缺失值处理和异常值处理方案
3. [subtask retry=3 adaptive] 执行修复并验证质量达标
  + → repair_summary: text  # 修复摘要
  3.1. [act] 按策略修复数据
    - ← raw_data, fix_strategy
    + → clean_data: yaml  # 修复结果
  3.2. [check] 验证修复后质量 ≥ threshold 且行数保留率 ≥ 90%
    - ← clean_data, quality_threshold
    + → quality_ok: bool  # 是否达标
    + → quality_note: text  # 说明槽:未达标原因(通过时不被查看)
4. [act] 生成质量报告（含修复前后对比）
  - ← profile, fix_strategy
  + → quality_report
5. [exit]
`;

const MOCK_RAW_DATA = [
  { id: 'r1', fields: { name: 'Alice', score: 95 }, source: 'csv' },
  { id: 'r2', fields: { name: null, score: 88 }, source: 'csv' },
];
const MOCK_PROFILE = {
  missing_rates: [0.0, 0.05, 0.12],
  anomaly_count: 3,
  issues: ['missing name in row 2', 'outlier score in row 5'],
};
const MOCK_FIX_STRATEGY = '使用 KNN 填充缺失值，Z-score>3 标记异常后用中位数替换';
const MOCK_CLEAN_DATA = [
  { id: 'r1', fields: { name: 'Alice', score: 95 }, source: 'csv' },
  { id: 'r2', fields: { name: 'Unknown', score: 88 }, source: 'csv' },
];
const MOCK_QUALITY_REPORT = '# 数据质量报告\n\n修复前缺失率12%→修复后0%，保留率100%';

function initWithInputs(engine: ExecutionEngine, opts?: { stateDir?: string }) {
  const result = engine.initExecution(DATA_QUALITY_SPEC, HOST,
    { ...opts, params: { raw_data: MOCK_RAW_DATA, quality_threshold: 0.85 } });
  expect(result.status).toBe('ok');
  const vars = engine.getVariableStore();
  vars.write('raw_data', MOCK_RAW_DATA, 'root');
  vars.write('quality_threshold', 0.85, 'root');
  return result;
}

describe('E2E Execution: 数据质量评估与修复', () => {
  describe('parse + validate', () => {
    it('parses without errors and has correct structure', () => {
      const engine = new ExecutionEngine();
      const result = engine.initExecution(DATA_QUALITY_SPEC, HOST, { params: { raw_data: MOCK_RAW_DATA, quality_threshold: 0.85 } });
      expect(result.status).toBe('ok');

      const spec = engine.getSpec()!;
      expect(spec.header.title).toBe('Spec: 数据质量评估与修复');
      expect(spec.header.id).toBe('data-quality');
      expect(spec.header.inputs).toHaveLength(2);
      expect(spec.header.outputs).toHaveLength(1);
      expect(spec.header.constraints).toHaveLength(2);
      expect(spec.header.types).toHaveLength(1);
      expect(spec.steps).toHaveLength(5);
    });

    it('has correct step types', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(DATA_QUALITY_SPEC, HOST, { params: { raw_data: MOCK_RAW_DATA, quality_threshold: 0.85 } });
      const steps = engine.getSpec()!.steps!;
      expect(steps[0].step_type).toBe('act');
      expect(steps[1].step_type).toBe('reason');
      expect(steps[2].step_type).toBe('subtask');
      expect(steps[3].step_type).toBe('act');
      expect(steps[4].step_type).toBe('exit');
    });
  });

  describe('happy path — linear execution to completion', () => {
    it('executes all steps and returns final outputs', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      // Step 1: act — 统计质量指标
      const s1 = engine.nextStep();
      expect(s1.status).toBe('step_ready');
      if (s1.status === 'step_ready') {
        expect(s1.step_id).toBe('1');
        expect(s1.step_type).toBe('act');
      }
      engine.completeStep('1', { profile: MOCK_PROFILE });

      // Step 2: reason — 制定修复策略
      const s2 = engine.nextStep();
      expect(s2.status).toBe('step_ready');
      if (s2.status === 'step_ready') {
        expect(s2.step_id).toBe('2');
        expect(s2.step_type).toBe('reason');
      }
      engine.completeStep('2', { fix_strategy: MOCK_FIX_STRATEGY });

      // Step 3.1: act (inside subtask) — 修复数据
      const s3_1 = engine.nextStep();
      expect(s3_1.status).toBe('step_ready');
      if (s3_1.status === 'step_ready') {
        expect(s3_1.step_id).toBe('3.1');
        expect(s3_1.step_type).toBe('act');
      }
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });

      // Step 3.2: check — 验证质量
      const s3_2 = engine.nextStep();
      expect(s3_2.status).toBe('step_ready');
      if (s3_2.status === 'step_ready') {
        expect(s3_2.step_id).toBe('3.2');
        expect(s3_2.step_type).toBe('check');
      }
      engine.completeStep('3.2', { quality_ok: true, quality_note: '质量达标' });

      // Step 4: act — 生成报告
      const s4 = engine.nextStep();
      expect(s4.status).toBe('step_ready');
      if (s4.status === 'step_ready') {
        expect(s4.step_id).toBe('4');
        expect(s4.step_type).toBe('act');
      }
      engine.completeStep('4', { quality_report: MOCK_QUALITY_REPORT });

      // Step 5: exit — execution completes
      const end = engine.nextStep();
      expect(end.status).toBe('completed');
      if (end.status === 'completed') {
        expect(end.outputs).toHaveProperty('quality_report');
        expect(end.outputs['quality_report']).toBe(MOCK_QUALITY_REPORT);
      }
    });
  });

  describe('variable propagation', () => {
    it('step 1 receives raw_data input', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      const s1 = engine.nextStep();
      if (s1.status === 'step_ready') {
        expect(s1.context.inputs['raw_data']).toEqual(MOCK_RAW_DATA);
      }
    });

    it('step 2 receives profile from step 1', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });

      const s2 = engine.nextStep();
      if (s2.status === 'step_ready') {
        expect(s2.context.inputs['profile']).toEqual(MOCK_PROFILE);
      }
    });

    it('step 3.1 receives raw_data and fix_strategy', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });
      engine.nextStep();
      engine.completeStep('2', { fix_strategy: MOCK_FIX_STRATEGY });

      const s3_1 = engine.nextStep();
      if (s3_1.status === 'step_ready') {
        expect(s3_1.context.inputs['raw_data']).toEqual(MOCK_RAW_DATA);
        expect(s3_1.context.inputs['fix_strategy']).toBe(MOCK_FIX_STRATEGY);
      }
    });

    it('step 3.2 receives clean_data and quality_threshold', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });
      engine.nextStep();
      engine.completeStep('2', { fix_strategy: MOCK_FIX_STRATEGY });
      engine.nextStep();
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });

      const s3_2 = engine.nextStep();
      if (s3_2.status === 'step_ready') {
        expect(s3_2.context.inputs['clean_data']).toEqual(MOCK_CLEAN_DATA);
        expect(s3_2.context.inputs['quality_threshold']).toBe(0.85);
      }
    });

    it('step 4 receives profile and fix_strategy', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });
      engine.nextStep();
      engine.completeStep('2', { fix_strategy: MOCK_FIX_STRATEGY });
      engine.nextStep();
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });
      engine.nextStep();
      engine.completeStep('3.2', { quality_ok: true, quality_note: '质量达标' });

      const s4 = engine.nextStep();
      if (s4.status === 'step_ready') {
        expect(s4.context.inputs['profile']).toEqual(MOCK_PROFILE);
        expect(s4.context.inputs['fix_strategy']).toBe(MOCK_FIX_STRATEGY);
      }
    });
  });

  describe('subtask adaptive — check step fails', () => {
    it('triggers adaptive_needed after second check failure (升级阶梯)', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      // Steps 1, 2 complete normally
      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });
      engine.nextStep();
      engine.completeStep('2', { fix_strategy: MOCK_FIX_STRATEGY });

      // Step 3.1 completes, 3.2 check fails (第1次)
      engine.nextStep();
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });
      engine.nextStep();
      engine.failStep('3.2', 'quality below threshold');

      // 第1次失败 → 带反馈重跑：subtask children 重置，重跑从 3.1 开始
      const rerun = engine.nextStep();
      expect(rerun.status).toBe('step_ready');
      if (rerun.status === 'step_ready') expect(rerun.step_id).toBe('3.1');
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });
      engine.nextStep(); // 3.2 again
      engine.failStep('3.2', 'quality below threshold again');

      // 第2次失败 → adaptive_needed
      const r = engine.nextStep();
      expect(r.status).toBe('adaptive_needed');
      if (r.status === 'adaptive_needed') {
        expect(r.subtask_id).toBe('3');
      }
    });

    it('succeeds after replan following check failure', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });
      engine.nextStep();
      engine.completeStep('2', { fix_strategy: MOCK_FIX_STRATEGY });

      // First attempt: 3.1 ok, 3.2 fails（第1次 → 带反馈重跑）
      engine.nextStep();
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });
      engine.nextStep();
      engine.failStep('3.2', 'quality below threshold');
      // 重跑 3.1 → 3.2 再次失败（第2次 → adaptive_needed）
      engine.nextStep();
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });
      engine.nextStep();
      engine.failStep('3.2', 'quality below threshold again');

      // adaptive_needed
      engine.nextStep();

      // Submit replan (must include a check step since original had one)
      const replanMd = `1. [act] 使用更强策略修复
  - ← raw_data, fix_strategy
  + → clean_data: yaml  # 修复结果
2. [check] 验证修复质量
  - ← clean_data
  + → repair_ok: bool  # 是否达标
  + → repair_summary: text  # 修复摘要
`;
      const result = engine.submitReplan('3', replanMd);
      expect(result.status).toBe('ok');

      // Execute replanned steps
      const newStep = engine.nextStep();
      expect(newStep.status).toBe('step_ready');
      if (newStep.status === 'step_ready') expect(newStep.step_id).toBe('3.1');
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });

      const checkStep = engine.nextStep();
      expect(checkStep.status).toBe('step_ready');
      if (checkStep.status === 'step_ready') expect(checkStep.step_id).toBe('3.2');
      engine.completeStep('3.2', { repair_ok: true, repair_summary: '修复完成' });

      // Subtask auto-completes → step 4
      const s4 = engine.nextStep();
      expect(s4.status).toBe('step_ready');
      if (s4.status === 'step_ready') {
        expect(s4.step_id).toBe('4');
      }
    });
  });

  describe('subtask adaptive — replan and complete', () => {
    it('returns adaptive_needed with correct contract after failure', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });
      engine.nextStep();
      engine.completeStep('2', { fix_strategy: MOCK_FIX_STRATEGY });

      // Execute subtask children: 3.1 ok, 3.2 fails（第1次 → 带反馈重跑）
      engine.nextStep();
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });
      engine.nextStep();
      engine.failStep('3.2', 'quality below threshold');
      // 重跑 → 3.2 再次失败（第2次 → adaptive_needed）
      engine.nextStep();
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });
      engine.nextStep();
      engine.failStep('3.2', 'quality below threshold again');

      const r = engine.nextStep();
      expect(r.status).toBe('adaptive_needed');
      if (r.status === 'adaptive_needed') {
        expect(r.subtask_id).toBe('3');
        expect(r.subtask_contract.outputs.length).toBeGreaterThan(0);
        expect(r.failure.reason).toBe('quality below threshold again');
      }
    });

    it('accepts replanned steps and continues to completion', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });
      engine.nextStep();
      engine.completeStep('2', { fix_strategy: MOCK_FIX_STRATEGY });

      // First attempt fails（第1次 → 带反馈重跑）
      engine.nextStep();
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });
      engine.nextStep();
      engine.failStep('3.2', 'quality below threshold');
      // 重跑 → 再次失败（第2次 → adaptive_needed）
      engine.nextStep();
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });
      engine.nextStep();
      engine.failStep('3.2', 'quality below threshold again');

      engine.nextStep(); // adaptive_needed

      // Submit replan (must include a check step since original had one)
      const replanMd = `1. [act] 使用备用策略修复数据
  - ← raw_data, fix_strategy
  + → clean_data: yaml  # 修复结果
2. [check] 验证修复质量达标
  - ← clean_data
  + → repair_ok: bool  # 是否达标
  + → repair_summary: text  # 修复摘要
`;
      const result = engine.submitReplan('3', replanMd);
      expect(result.status).toBe('ok');

      // Execute new plan
      const newStep = engine.nextStep();
      expect(newStep.status).toBe('step_ready');
      if (newStep.status === 'step_ready') {
        expect(newStep.step_id).toBe('3.1');
      }
      engine.completeStep('3.1', { clean_data: MOCK_CLEAN_DATA });

      const checkStep = engine.nextStep();
      expect(checkStep.status).toBe('step_ready');
      if (checkStep.status === 'step_ready') {
        expect(checkStep.step_id).toBe('3.2');
      }
      engine.completeStep('3.2', { repair_ok: true, repair_summary: '备用策略修复完成' });

      // Continue to step 4
      const s4 = engine.nextStep();
      expect(s4.status).toBe('step_ready');
      if (s4.status === 'step_ready') {
        expect(s4.step_id).toBe('4');
      }
      engine.completeStep('4', { quality_report: MOCK_QUALITY_REPORT });

      // Exit → completed
      const end = engine.nextStep();
      expect(end.status).toBe('completed');
      if (end.status === 'completed') {
        expect(end.outputs['quality_report']).toBe(MOCK_QUALITY_REPORT);
      }
    });
  });

  describe('prompt context verification', () => {
    it('task_context contains Goal and Constraints', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      const s1 = engine.nextStep();
      if (s1.status === 'step_ready') {
        expect(s1.context.task_context).toContain('评估输入数据集的质量问题');
        expect(s1.context.task_context).toContain('修复后数据行数保留率');
      }
    });

    it('output_schema matches step declarations', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      const s1 = engine.nextStep();
      if (s1.status === 'step_ready') {
        expect(s1.context.output_schema).toHaveLength(1);
        expect(s1.context.output_schema[0].name).toBe('profile');
        expect(s1.context.output_schema[0].type).toBe('yaml');
      }
    });

    it('step 2 instruction contains execution description', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);
      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });

      const s2 = engine.nextStep();
      if (s2.status === 'step_ready') {
        expect(s2.context.instruction).toContain('权衡数据保留率与质量');
      }
    });

    it('progress_summary updates after steps complete', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);
      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });

      const s2 = engine.nextStep();
      if (s2.status === 'step_ready') {
        expect(s2.context.progress_summary).toContain('统计数据质量指标');
      }
    });
  });

  describe('persistence + resume', () => {
    it('resumes from mid-execution state', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'e2e-persist-'));
      const engine = new ExecutionEngine();
      const init = initWithInputs(engine, { stateDir });

      // Complete step 1
      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });

      // Resume from disk
      if (init.status === 'ok') {
        const instanceDir = join(stateDir, init.instance_id);
        const resumed = ExecutionEngine.load(instanceDir);

        // Should return step 2
        const s2 = resumed.nextStep();
        expect(s2.status).toBe('step_ready');
        if (s2.status === 'step_ready') {
          expect(s2.step_id).toBe('2');
          expect(s2.context.inputs['profile']).toEqual(MOCK_PROFILE);
        }
      }
    });

    it('resume preserves variable values', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'e2e-vars-'));
      const engine = new ExecutionEngine();
      const init = initWithInputs(engine, { stateDir });

      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });
      engine.nextStep();
      engine.completeStep('2', { fix_strategy: MOCK_FIX_STRATEGY });

      if (init.status === 'ok') {
        const instanceDir = join(stateDir, init.instance_id);
        const resumed = ExecutionEngine.load(instanceDir);
        const vars = resumed.getVars();

        expect(vars.status).toBe('ok');
        if (vars.status === 'ok') {
          expect(vars.variables['profile']).toEqual(MOCK_PROFILE);
          expect(vars.variables['fix_strategy']).toBe(MOCK_FIX_STRATEGY);
        }
      }
    });
  });

  describe('status tracking', () => {
    it('reports correct progress at each stage', () => {
      const engine = new ExecutionEngine();
      initWithInputs(engine);

      const initial = engine.getStatus();
      expect(initial.status).toBe('ok');
      expect(initial.pending).toBeGreaterThan(0);
      expect(initial.completed).toBe(0);

      // Complete first step
      engine.nextStep();
      engine.completeStep('1', { profile: MOCK_PROFILE });

      const mid = engine.getStatus();
      expect(mid.completed).toBeGreaterThanOrEqual(1);
    });
  });
});

// ===== New feature e2e tests =====

describe('E2E: C2 single case branch (if-then)', () => {
  const SINGLE_CASE_SPEC = `# Single Case
Id: single-case

## Goal
Test if-then branch

## Outputs
- result: text  # output

## Steps
1. [reason] Classify
  + → kind: text  # classification
  > Classify the input
2. [branch] Route
  2.1. [case] kind == 'special'
    2.1.1. [reason] Handle special
      + → result: text  # special result
      > Handle special case
`;

  it('parses and validates single case branch without error', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SINGLE_CASE_SPEC, HOST);
    expect(init.status).toBe('ok');
  });

  it('executes with matching case', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SINGLE_CASE_SPEC, HOST);
    engine.nextStep();
    engine.completeStep('1', { kind: 'special' });
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    if (next.status === 'step_ready') {
      expect(next.step_id).toBe('2.1.1');
    }
  });
});

describe('E2E: C6 check inside case', () => {
  const CHECK_IN_CASE_SPEC = `# Check in Case
Id: check-in-case

## Goal
Test check inside case

## Outputs
- result: text  # output

## Steps
1. [reason] Classify
  + → kind: text  # type
  > Classify
2. [branch] Route
  2.1. [case] kind == 'verify'
    2.1.1. [reason] Do work
      + → work: text  # work output
      > Do the work
    2.1.2. [check] Verify work
      - ← work
      + → work_ok: bool  # verdict slot
      + → result: text  # verification
      > Check work quality
  2.2. [case]
    2.2.1. [reason] Default path
      + → result: text  # default
      > Default
`;

  it('validates check inside case without error', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CHECK_IN_CASE_SPEC, HOST);
    expect(init.status).toBe('ok');
  });
});

describe('E2E: V4 strict type validation', () => {
  it('rejects undeclared custom type in step output', () => {
    const spec = `# Strict Types
## Goal
Test V4

## Steps
1. [reason] Produce
  + → data: UndeclaredType  # bad type
  > Produce data
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, HOST);
    expect(init.status).toBe('error');
    if (init.status === 'error') {
      expect(init.errors.some(e => e.rule === 'V4')).toBe(true);
    }
  });

  it('accepts declared custom type', () => {
    const spec = `# Strict Types
## Goal
Test V4

## Types
- MyRecord:
    name: text
    score: int

## Steps
1. [reason] Produce
  + → data: MyRecord  # valid type
  > Produce data
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, HOST);
    expect(init.status).toBe('ok');
  });
});

// 完备性闸（2026-08-17 hopissues/hoplogic3/0001——原 warn 照发 completed="completed 零产出"
// 假绿混进全链强信号;概念层改判:未赋值声明输出=完备性违约判 failed）。
// 夹具经 branch 动态跳过产出步——静态闸 P10（两分支各有产出即绿）拦不住,恰是运行时闸的存在理由。
// @v: anc-exec-output-completeness
describe('E2E: 未赋值声明输出=完备性违约判 failed', () => {
  it('反例：声明输出经动态路径未赋值 → failed 携 reason + partial_outputs', () => {
    const spec = `# Unassigned Output
## Goal
Test output completeness

## Outputs
- result: text  # expected output

## Steps
1. [reason] Think
  + → cond_val: int  # decide
  > Think
2. [branch] 分
  + → result: text  # 统一接口
  2.1. [case(cond_val > 10)] 走产出
    + → result: text
    2.1.1. [reason] p
      + → result: text
      > t
  2.2. [case(else)] 不产出
    2.2.1. [reason] q
      + → note: text  # 不给 result!
      > t
`;
    const engine = new ExecutionEngine();
    const logDir = mkdtempSync(join(tmpdir(), 'hoplog-warn-'));
    engine.initExecution(spec, HOST, { logDir });
    engine.nextStep();
    engine.completeStep('1', { cond_val: 1 });   // else 路径→result 永不赋值
    let r = engine.nextStep();
    while (r.status === 'step_ready') {
      engine.completeStep(r.step_id, { note: 'n' });
      r = engine.nextStep();
    }
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.failure_reason).toContain('result');
      expect(r.failure_reason).toContain('never assigned');
      expect(r.partial_outputs).toBeDefined();   // 已产出部分照常携带
    }
    const events = engine.getExecEvents();
    expect(events.some(e => e.detail?.includes('result') && e.detail?.includes('never assigned'))).toBe(true);
  });

  it('正例：全部声明输出赋值 → completed 照常', () => {
    const spec = `# Assigned Output
## Goal
g

## Outputs
- result: text  # r

## Steps
1. [reason] Think
  + → result: text  # r
  > t
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    engine.nextStep();
    engine.completeStep('1', { result: 'ok' });
    expect(engine.nextStep().status).toBe('completed');
  });
});

describe('E2E: L3 dependency-driven progress', () => {
  const MULTI_STEP_SPEC = `# Multi Step
Id: multi-step

## Goal
Test L3 progress

## Outputs
- final_out: text  # result

## Steps
1. [reason] Step A
  + → a_out: text  # a output
  > Produce A
2. [reason] Step B
  + → b_out: text  # b output
  > Produce B
3. [reason] Step C
  + → c_out: text  # c output
  > Produce C
4. [reason] Step D
  + → d_out: text  # d output
  > Produce D
5. [reason] Step E
  + → e_out: text  # e output
  > Produce E
6. [reason] Step F
  + → f_out: text  # f output
  > Produce F
7. [reason] Step G
  + → g_out: text  # g output
  > Produce G
8. [reason] Step H
  + → h_out: text  # h output
  > Produce H
9. [reason] Use A only
  - ← a_out
  + → final_out: text  # uses a_out
  > Combine
`;

  it('shows dependency steps in full and compresses non-dependency non-recent', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(MULTI_STEP_SPEC, HOST);

    // Complete steps 1-8
    for (let i = 1; i <= 8; i++) {
      engine.nextStep();
      engine.completeStep(String(i), { [`${String.fromCharCode(96 + i)}_out`]: `val_${i}` });
    }

    const s9 = engine.nextStep();
    expect(s9.status).toBe('step_ready');
    if (s9.status === 'step_ready') {
      const progress = s9.context.progress_summary;
      // Step 1 (produces a_out, dependency of step 9) → full display
      expect(progress).toMatch(/✓ 1 \[reason\]/);
      // Steps 4-8 are the recent 5 siblings → full display
      expect(progress).toMatch(/✓ 8 \[reason\]/);
      // Steps 2-3 are NOT dependencies and NOT in recent 5 → compressed
      // 缩略行保留 [type]+summary(2026-08-31 F13——旧行为"压缩行无类型标"废除:L0 词表教了
      // 记号,L3 不许有一档不带记号的形态);与全显行的区分度=全显 [type]: 带冒号+输出值,
      // 缩略 [type] 无冒号+仅输出名。
      expect(progress).toMatch(/✓ 2 \[reason\] Step B/);
      expect(progress).toMatch(/✓ 3 \[reason\] Step C/);
      expect(progress).not.toMatch(/✓ 2 \[reason\]:/);   // 无冒号=非全显形态
      expect(progress).not.toMatch(/✓ 3 \[reason\]:/);
    }
  });
});

// @v: anc-obs-log-levels, anc-obs-step-mapping, anc-obs-execution-log-absorption
describe('E2E: HopLog output verification', () => {
  const LOG_SPEC = `# Spec: 日志验证
Id: log-verify

## Goal
Verify HopLog output matches concept model

## Inputs
- data: text  # input data

## Outputs
- result: text  # final output

## Steps
1. [reason] Analyze
  - ← data
  + → analysis: text  # analysis result
  > Analyze the input data
2. [subtask] Process and verify
  + → result: text  # processed output
  2.1. [act] Transform
    - ← analysis
    + → transformed: text  # transformed data
    > Apply transformation
  2.2. [check] Verify quality
    - ← transformed
    + → quality_ok: bool  # verdict slot
    + → result: text  # verification result
    > Check quality meets threshold
`;

  function runSpecWithLog(): { engine: ExecutionEngine; logDir: string } {
    const logDir = mkdtempSync(join(tmpdir(), 'hoplog-e2e-'));
    const engine = new ExecutionEngine();
    engine.initExecution(LOG_SPEC, HOST, { logDir, logLevel: 'debug', params: { data: 'd' } });

    const vars = engine.getVariableStore();
    vars.write('data', 'test input', 'root');

    // Step 1: reason
    engine.nextStep();
    engine.completeStep('1', { analysis: 'analyzed result' });

    // Step 2.1: act
    engine.nextStep();
    engine.completeStep('2.1', { transformed: 'transformed data' });

    // Step 2.2: check
    engine.nextStep();
    engine.completeStep('2.2', { quality_ok: true, result: 'quality ok' });

    // Final
    const final = engine.nextStep();
    expect(final.status).toBe('completed');

    return { engine, logDir };
  }

  it('creates main.yaml in run directory', () => {
    const { logDir } = runSpecWithLog();
    const dirs = readdirSync(logDir);
    expect(dirs.length).toBe(1);
    expect(dirs[0]).toMatch(/^log-verify-/);
    expect(existsSync(join(logDir, dirs[0], 'main.yaml'))).toBe(true);
  });

  it('main.yaml contains metadata header (streamed immediately)', () => {
    const { logDir, engine } = runSpecWithLog();
    const dirs = readdirSync(logDir);
    const content = readFileSync(join(logDir, dirs[0], 'main.yaml'), 'utf-8');

    expect(content).toContain('spec_id: log-verify');
    expect(content).toMatch(/run_id: \d{8}T\d{6}-[0-9a-f]{4}/);
    expect(content).toContain('level: debug');
    expect(content).toContain('status: completed');
    expect(content).toContain('ended_at:');
    expect(content).toContain('goal: Verify HopLog');
  });

  it('records all steps with correct types in file', () => {
    const { logDir } = runSpecWithLog();
    const dirs = readdirSync(logDir);
    const content = readFileSync(join(logDir, dirs[0], 'main.yaml'), 'utf-8');

    expect(content).toContain('type: reason');
    expect(content).toContain('type: act');
    expect(content).toContain('type: check');
    expect(content).toMatch(/summary:.*Analyze/);
    expect(content).toMatch(/summary:.*Transform/);
    expect(content).toMatch(/summary:.*Verify/);
    // All steps completed
    expect(content.match(/status: completed/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('records input/output values at debug level', () => {
    const { logDir } = runSpecWithLog();
    const dirs = readdirSync(logDir);
    const content = readFileSync(join(logDir, dirs[0], 'main.yaml'), 'utf-8');

    expect(content).toContain('analyzed result');
    expect(content).toContain('transformed data');
  });

  it('records step records in file as they happen', () => {
    const { logDir } = runSpecWithLog();
    const dirs = readdirSync(logDir);
    const content = readFileSync(join(logDir, dirs[0], 'main.yaml'), 'utf-8');

    // Step records are streamed: id + type + status all present
    expect(content).toMatch(/"1":/);
    expect(content).toMatch(/"2\.1":/);
    expect(content).toMatch(/type: reason/);
    expect(content).toMatch(/type: act/);
    expect(content).toMatch(/status: completed/);
    // step 1 record appears before step 2.1 record
    const step1Start = content.indexOf('"1":');
    const step21Start = content.indexOf('"2.1":');
    expect(step1Start).toBeGreaterThanOrEqual(0);
    expect(step1Start).toBeLessThan(step21Start);
  });

  it('records failed step with reason in file', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'hoplog-fail-'));
    const engine = new ExecutionEngine();
    engine.initExecution(LOG_SPEC, HOST, { logDir, logLevel: 'debug', params: { data: 'd' } });

    engine.nextStep();
    engine.failStep('1', 'LLM hallucinated');
    engine.nextStep(); // triggers failed

    const dirs = readdirSync(logDir);
    const content = readFileSync(join(logDir, dirs[0], 'main.yaml'), 'utf-8');

    expect(content).toContain('status: failed');
    expect(content).toContain('reason: LLM hallucinated');
    expect(content).toContain('failed_at:');
  });

  it('info level records real values; warn level omits them', () => {
    // info 级记录真实值
    const logDirInfo = mkdtempSync(join(tmpdir(), 'hoplog-info-'));
    const engine = new ExecutionEngine();
    engine.initExecution(LOG_SPEC, HOST, { logDir: logDirInfo, logLevel: 'info', params: { data: 'd' } });
    const vars = engine.getVariableStore();
    vars.write('data', 'real data', 'root');
    engine.nextStep();
    engine.completeStep('1', { analysis: 'real analysis' });
    engine.nextStep();
    engine.completeStep('2.1', { transformed: 'real transformed' });
    engine.nextStep();
    engine.completeStep('2.2', { quality_ok: true, result: 'ok' });
    engine.nextStep(); // completed
    const dirs = readdirSync(logDirInfo);
    const infoContent = readFileSync(join(logDirInfo, dirs[0], 'main.yaml'), 'utf-8');
    expect(infoContent).toContain('real data');
    expect(infoContent).toContain('real analysis');
    expect(infoContent).toContain('type: reason');

    // warn 级不记录变量值
    const logDirWarn = mkdtempSync(join(tmpdir(), 'hoplog-warn-'));
    const engine2 = new ExecutionEngine();
    engine2.initExecution(LOG_SPEC, HOST, { logDir: logDirWarn, logLevel: 'warn', params: { data: 'd' } });
    const vars2 = engine2.getVariableStore();
    vars2.write('data', 'secret data', 'root');
    engine2.nextStep();
    engine2.completeStep('1', { analysis: 'secret analysis' });
    engine2.nextStep();
    engine2.completeStep('2.1', { transformed: 'secret transformed' });
    engine2.nextStep();
    engine2.completeStep('2.2', { quality_ok: true, result: 'ok' });
    engine2.nextStep();
    const dirs2 = readdirSync(logDirWarn);
    const warnContent = readFileSync(join(logDirWarn, dirs2[0], 'main.yaml'), 'utf-8');
    expect(warnContent).not.toContain('secret data');
    expect(warnContent).not.toContain('secret analysis');
    expect(warnContent).toContain('type: reason');
    expect(warnContent).toContain('status: completed');
  });
});

// @v: anc-step-ask, anc-exec-hitl-presentation —— coffee-week demo spec 全链（2026-08-09 参数确认
// 入 spec 引擎强制:首步 [ask present_inputs require_human] 确认周目标——正反例钉住 demo 门面行为）
describe('E2E Execution: coffee-week（ask 介入点引擎强制）', () => {
  const SPEC = readFileSync(join(process.cwd(), 'examples/coffee-week.md'), 'utf-8');
  const PARAMS = { daily_sales: [3200, 2800, 3600, 4100, 3900, 5200, 4800], weekly_target: 26000 };

  it('正例:首步必 paused(ask)——引擎强制,driver 跳不过;注入确认值后走通到 reason', async () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, HOST, { params: PARAMS });
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('paused');                       // 不是 step_ready——确认在前
    if (r.status !== 'paused') return;
    expect(r.step_id).toBe('1');
    expect(r.pause_reason).toBe('ask');
    // present_inputs 呈交硬约束随介入请求携带（require_human 在 AST 层强制,paused 响应不回显）
    expect((r as { presented_data?: { present_inputs?: string[] } }).presented_data?.present_inputs).toContain('daily_sales');
    engine.completeStep('1', { value: 30000 });            // 店主改目标
    const r2 = await engine.advanceToCaller();
    expect(r2.status).toBe('step_ready');                  // 纯计算步被引擎消化,直达 reason
    if (r2.status !== 'step_ready') return;
    expect(r2.step_id).toBe('3');
    expect(r2.context.inputs.target_confirmed).toBe(30000); // 确认值(非原始 weekly_target)进数据流
  });

  it('反例:不注入确认,直接提交后续步骤 → 拒(INVALID_STATE,介入点绕不过)', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, HOST, { params: PARAMS });
    await engine.advanceToCaller();                        // 停在 ask paused
    const r = engine.completeStep('3', { verdict: 'v', advice: 'a' });   // 越过 ask 直接交 reason
    expect(r.status).toBe('error');                        // 步骤3 还是 pending,拒
  });
});

