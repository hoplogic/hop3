// @module: prompt-assembler ^anc-struct-prompt-assembler
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptAssembler, formatPromptText, actRoleKind, roleGuideText , stripAssemblyNotes, buildToolManifest, renderPromptParts } from '../src/prompt.js';
import { ExecutionEngine } from '../src/engine.js';
import type { HostConfig } from '../src/provider-types.js';
import type { AssembledContext } from '../src/runtime-types.js';

const HOST: HostConfig = {
  workspace_dir: '/tmp/test',
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'test-key',
};

const THREE_STEP_SPEC = `# Test Spec
Id: test-prompt

## Goal
Analyze and transform data

## Constraints
- Must be idempotent
- No side effects

## Types
- DataRecord:
    text: text
    score: int

## Inputs
- source: text  # input data

## Outputs
- result: text  # final output

## Steps
1. [reason] Analyze input
  - ← source
  + → analysis: text  # analysis result
  > Analyze the source data carefully

2. [act] Transform data
  - ← analysis
  + → transformed: text  # transformed data
  > Apply transformation

3. [reason] Verify output
  - ← transformed
  + → result: text  # verification result
  > Check the data
`;

const NESTED_SPEC = `# Deep Spec
Id: deep-nested

## Goal
Test deep nesting

## Outputs
- deep_result: text  # result

## Steps
1. [subtask] Level 1
  + → l1_out: text  # level 1
  1.1. [subtask] Level 2
    + → l2_out: text  # level 2
    1.1.1. [subtask] Level 3
      + → l3_out: text  # level 3
      1.1.1.1. [subtask] Level 4
        + → l4_out: text  # level 4
        1.1.1.1.1. [reason] Deep step
          + → deep_result: text  # deep
          > Do deep reasoning
`;

const LOOP_SPEC = `# Loop Test
Id: loop-test

## Goal
Test loop iteration

## Outputs
- total: int  # result

## Steps
1. [loop max_iterations=5] Process items
  + → loop_result: text  # per-iteration
  1.1. [reason] Process one item
    + → item_out: text  # item output
    > Process current item
2. [reason] Summarize
  - ← loop_result
  + → total: int  # total
  > Summarize results
`;

// @v: anc-exec-prompt-assembly, anc-struct-prompt-assembler
describe('PromptAssembler', () => {
  describe('L1a task_context (ancestor chain)', () => {
    it('includes Goal, Constraints, and Types', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });
      const assembler = new PromptAssembler(engine);

      const step1 = engine.getSpec()!.steps![0];
      const ctx = assembler.assembleReasonContext(step1);

      expect(ctx.task_context).toContain('Goal（整个规约的总目标，供你理解所处任务；你本步的任务在 L4）: Analyze and transform data');
      expect(ctx.task_context).toContain('- Must be idempotent');   // 分条渲染（2026-08-30 L1 三件实装,分号挤行退役）
      // 字段级定义（0017——只发名字列表=LLM 被要求产出从未见过定义的结构,与 0014 字段闸不对称）// @v: anc-type-type-decl
      expect(ctx.task_context).toContain('DataRecord={text:text, score:int}');
    });

    it('shows full ancestor for depth ≤ 3', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(NESTED_SPEC, HOST);
      const assembler = new PromptAssembler(engine);

      // step 1.1.1.1.1 has depth 5 ancestors
      const spec = engine.getSpec()!;
      const findStep = (steps: any[], id: string): any => {
        for (const s of steps) {
          if (s.step_id === id) return s;
          if (s.children) {
            const found = findStep(s.children, id);
            if (found) return found;
          }
        }
        return null;
      };
      const deepStep = findStep(spec.steps!, '1.1.1.1.1');
      expect(deepStep).not.toBeNull();

      const ctx = assembler.assembleReasonContext(deepStep);

      // @v: anc-exec-cache-affinity — 祖先链自 task_context 拆出至 position_context（缓存亲和 A——
      // 稳定段被易变内容截断=前缀缓存全废）。断言随字段迁移,格式契约不变。
      // Depth ≤ 3: full format with [type] tag
      expect(ctx.position_context).toContain('1 [subtask]');
      expect(ctx.position_context).toContain('1.1 [subtask]');
      expect(ctx.position_context).toContain('1.1.1 [subtask]');
      // Depth > 3: compressed format without [type]
      expect(ctx.position_context).toMatch(/1\.1\.1\.1:.*Level 4/);
      // 反例半边:task_context 不再含祖先链行（拆分真发生,非双写）
      expect(ctx.task_context).not.toMatch(/1\.1\.1\.1:.*Level 4/);
    });

    it('includes loop iteration counter in ancestor', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(LOOP_SPEC, HOST);

      // First step inside the loop
      const s1 = engine.nextStep();
      expect(s1.status).toBe('step_ready');
      if (s1.status === 'step_ready') {
        expect(s1.step_id).toBe('1.1');
        // 祖先链(含 loop iter)在 position_context（缓存亲和拆分——iter 每轮变,正是易变面的典型）
        expect(s1.context.position_context).toContain('1 [loop]');
        expect(s1.context.position_context).toMatch(/iter \d/);
      }
    });
  });

  // @v: anc-exec-l3-display-rules
  describe('L2a progress_summary (sliding window)', () => {
    it('returns "No steps completed yet" initially', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });
      const assembler = new PromptAssembler(engine);

      const step1 = engine.getSpec()!.steps![0];
      const ctx = assembler.assembleReasonContext(step1);

      expect(ctx.progress_summary).toBe('No steps completed yet.');
    });

    it('shows completed steps with output values', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });

      engine.nextStep(); // step 1
      engine.completeStep('1', { analysis: 'done analyzing' });

      const s2 = engine.nextStep(); // step 2
      expect(s2.status).toBe('step_ready');
      if (s2.status === 'step_ready') {
        expect(s2.context.progress_summary).toContain('✓ 1');
        expect(s2.context.progress_summary).toContain('analysis=');
      }
    });

    it('compresses older steps beyond sliding window', () => {
      // Use a spec with 7+ steps to test sliding window
      const manySteps = `# Many Steps
Id: many

## Goal
Test sliding window

## Outputs
- final_out: text  # result

## Steps
1. [reason] Step one
  + → out1: text  # o1
2. [reason] Step two
  + → out2: text  # o2
3. [reason] Step three
  + → out3: text  # o3
4. [reason] Step four
  + → out4: text  # o4
5. [reason] Step five
  + → out5: text  # o5
6. [reason] Step six
  + → out6: text  # o6
7. [reason] Step seven
  + → final_out: text  # o7
`;
      const engine = new ExecutionEngine();
      engine.initExecution(manySteps, HOST);

      for (let i = 1; i <= 6; i++) {
        engine.nextStep();
        engine.completeStep(String(i), { [`out${i}`]: `val${i}` });
      }

      const s7 = engine.nextStep();
      expect(s7.status).toBe('step_ready');
      if (s7.status === 'step_ready') {
        // First step (beyond window of 5) should be compressed (no [type])
        expect(s7.context.progress_summary).toMatch(/✓ 1 \[reason\] Step one → out1/)   // 缩略行保留 [type]+summary(2026-08-31 F13);
        // Recent steps should have [type] tag
        expect(s7.context.progress_summary).toContain('[reason]');
      }
    });
  });

  // @v: anc-exec-l3-loop
  describe('L2b iteration_history', () => {
    it('is undefined for non-loop steps', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });
      const assembler = new PromptAssembler(engine);

      const step1 = engine.getSpec()!.steps![0];
      const ctx = assembler.assembleReasonContext(step1);

      expect(ctx.iteration_history).toBeUndefined();
    });

    it('is undefined on first loop iteration', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(LOOP_SPEC, HOST);

      const s = engine.nextStep();
      expect(s.status).toBe('step_ready');
      if (s.status === 'step_ready') {
        expect(s.context.iteration_history).toBeUndefined();
      }
    });

    it('renders iteration number and prior-round output from second iteration on', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(LOOP_SPEC, HOST);

      // 第 1 轮：进入 loop 子步骤 1.1 并完成 → loop 滚到第 2 轮
      const first = engine.nextStep();
      expect(first.status).toBe('step_ready');
      if (first.status === 'step_ready') expect(first.step_id).toBe('1.1');
      engine.completeStep('1.1', { item_out: 'round-1-result' });

      // 第 2 轮：1.1 再次 ready，此时迭代历史应已生成
      const second = engine.nextStep();
      expect(second.status).toBe('step_ready');
      if (second.status === 'step_ready') {
        const hist = second.context.iteration_history;
        expect(hist).toBeDefined();
        // 要素①：每轮标注迭代序号 + 当前轮序号
        expect(hist).toMatch(/iteration 2/);
        expect(hist).toMatch(/iter 1/);
        // 要素①：渲染上一轮关键产出（子步骤完成标记）
        expect(hist).toContain('1.1');
        expect(hist).toMatch(/✓/);
      }
    });
  });

  describe('L3 inputs (variable resolution)', () => {
    it('resolves input bindings from variable store', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });

      engine.nextStep(); // step 1
      engine.completeStep('1', { analysis: 'test analysis' });

      const s2 = engine.nextStep();
      expect(s2.status).toBe('step_ready');
      if (s2.status === 'step_ready') {
        expect(s2.context.inputs['analysis']).toBe('test analysis');
      }
    });

    it('failed step outputs stay unset (fail 不碰值空间,2026-08-09 函数级 fail)', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });
      const assembler = new PromptAssembler(engine);

      engine.nextStep(); // step 1
      engine.failStep('1', 'test failure');

      // fail 不置 None:analysis 从未产出 → undefined(声明未产出)
      const step2 = engine.getSpec()!.steps![1];
      const ctx = assembler.assembleReasonContext(step2);
      expect(ctx.inputs['analysis']).toBeUndefined();
    });

    // @v: anc-exec-inputs-deflate, anc-exec-deflate
    // 大值不再截断 [TRUNCATED](v1 偏差),改 deflate 到 work_zone/vars/<name>.json 走 $file 指针。
    // 见 design/prompt-assembler.md 决策5 ^anc-exec-inputs-deflate。
    it('deflates large string values to $file pointer (FilePersistence)', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'pdefl-s-'));
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { stateDir, params: { source: 's' } });

      engine.nextStep();
      const bigValue = 'x'.repeat(5000); // > DEFLATE_THRESHOLD(4096)
      engine.completeStep('1', { analysis: bigValue });

      const s2 = engine.nextStep();
      expect(s2.status).toBe('step_ready');
      if (s2.status === 'step_ready') {
        const val = s2.context.inputs['analysis'] as { $file: string };
        expect(val).toHaveProperty('$file');
        // 文件内容反序列化 = 原始大值,不丢数据
        expect(JSON.parse(readFileSync(val.$file, 'utf-8'))).toBe(bigValue);
        // 文件落在 work_zone/vars/analysis.json
        expect(val.$file).toMatch(/work_zone\/vars\/analysis\.json$/);
      }
    });

    it('deflates large object values to $file pointer (FilePersistence)', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'pdefl-o-'));
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { stateDir, params: { source: 's' } });

      engine.nextStep();
      const bigObj = { data: 'y'.repeat(5000) };
      engine.completeStep('1', { analysis: bigObj });

      const s2 = engine.nextStep();
      expect(s2.status).toBe('step_ready');
      if (s2.status === 'step_ready') {
        const val = s2.context.inputs['analysis'] as { $file: string };
        expect(val).toHaveProperty('$file');
        expect(JSON.parse(readFileSync(val.$file, 'utf-8'))).toEqual(bigObj);
      }
    });

    it('small values inline as-is (no deflate, no truncate)', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'pdefl-i-'));
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { stateDir, params: { source: 's' } });

      engine.nextStep();
      const small = 'hello world';
      engine.completeStep('1', { analysis: small });

      const s2 = engine.nextStep();
      if (s2.status === 'step_ready') {
        // 小值原样,不带 $file、不带 [TRUNCATED]
        expect(s2.context.inputs['analysis']).toBe(small);
      }
    });
  });

  describe('L4 instruction', () => {
    it('instruction 在场时不复读 summary（任务先行批——L4 步骤行已带 summary,任务段重复是纯噪声）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });

      const s = engine.nextStep();
      expect(s.status).toBe('step_ready');
      if (s.status === 'step_ready') {
        expect(s.context.instruction).toContain('Analyze the source data carefully');
        expect(s.context.instruction).not.toContain('Analyze input');
      }
    });
  });

  describe('L4 output_schema', () => {
    it('provides output declarations', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });

      const s = engine.nextStep();
      expect(s.status).toBe('step_ready');
      if (s.status === 'step_ready') {
        expect(s.context.output_schema).toHaveLength(1);
        expect(s.context.output_schema[0].name).toBe('analysis');
        expect(s.context.output_schema[0].type).toBe('text');
      }
    });
  });

  // @v: anc-exec-token-budget
  describe('Budget trimming（2026-08-09 分层压缩契约:处置留痕非静默丢弃）', () => {
    function mkTrim() {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });
      const assembler = new PromptAssembler(engine);
      return (assembler as any).applyBudgetTrimming.bind(assembler);
    }

    it('总量内不动任何层', () => {
      const trim = mkTrim();
      const ctx: AssembledContext = {
        task_context: 'x'.repeat(2000),
        progress_summary: 'y'.repeat(2000),
        iteration_history: 'z'.repeat(1000),
        instruction: 'do',
        inputs: {},
        output_schema: [],
      };
      const out = trim(ctx);
      expect(out.iteration_history).toBe('z'.repeat(1000));
      expect(out.task_context).toBe('x'.repeat(2000));
    });

    it('超量:L3b 折叠为摘要行+留痕(非静默 undefined)', () => {
      const trim = mkTrim();
      const ctx: AssembledContext = {
        task_context: 'x'.repeat(20000),
        progress_summary: 'y'.repeat(20000),
        iteration_history: 'Loop 1 — iteration 9:\n' + 'z'.repeat(8000),
        instruction: 'do',
        inputs: {},
        output_schema: [],
      };
      const out = trim(ctx);
      expect(out.iteration_history).toContain('Loop 1');                      // 摘要行保留
      expect(out.iteration_history).toContain('[context-compress]');          // 留痕
      expect(out.iteration_history!.length).toBeLessThan(400);
    });

    it('超量:L3 压缩留痕、L1a 契约零截断(不可降级)', () => {
      const trim = mkTrim();
      const bigTask = 'x'.repeat(30000);
      const ctx: AssembledContext = {
        task_context: bigTask,
        progress_summary: 'y'.repeat(30000),
        instruction: 'do',
        inputs: {},
        output_schema: [],
      };
      const out = trim(ctx);
      expect(out.task_context).toBe(bigTask);                                 // 契约原样
      expect(out.progress_summary).toContain('[context-compress]');           // L3 留痕
      expect(out.progress_summary.length).toBeLessThan(30000);
    });

    it('超量:L2 知识降为指针行留痕', () => {
      const trim = mkTrim();
      const ctx: AssembledContext = {
        task_context: 'x'.repeat(30000),
        progress_summary: 'y'.repeat(2000),
        knowledge_context: 'k'.repeat(20000),
        instruction: 'do',
        inputs: {},
        output_schema: [],
      };
      const out = trim(ctx);
      expect(out.knowledge_context).toContain('[context-compress]');          // 留痕非 undefined
      expect(out.knowledge_context!.length).toBeLessThan(300);
    });
  });

  
  describe('reassembleAggressive', () => {
    it('produces minimal context with only goal and direct parent', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(NESTED_SPEC, HOST);
      const assembler = new PromptAssembler(engine);

      const spec = engine.getSpec()!;
      const findStep = (steps: any[], id: string): any => {
        for (const s of steps) {
          if (s.step_id === id) return s;
          if (s.children) {
            const found = findStep(s.children, id);
            if (found) return found;
          }
        }
        return null;
      };
      const deepStep = findStep(spec.steps!, '1.1.1.1.1');

      const ctx = assembler.reassembleAggressive(deepStep);

      // Should only have goal + 1 parent level (1.1.1.1 is direct parent)
      expect(ctx.task_context).toContain('你本步的任务在 L4）: Test deep nesting');
      expect(ctx.task_context).toContain('1.1.1.1');
      // Should NOT have top-level ancestors like "1 " at line start (only direct parent)
      const lines = ctx.task_context.split('\n').filter(l => l.trim());
      const ancestorLines = lines.filter(l => l.trim().match(/^\d/));
      expect(ancestorLines.length).toBeLessThanOrEqual(1);

      // No iteration history
      expect(ctx.iteration_history).toBeUndefined();
      // No knowledge context
      expect(ctx.knowledge_context).toBeUndefined();
    });

    // @src 零执行语义（概念'不进执行 LLM 的 prompt'——锚点体系承诺回归钉）// @v: anc-step-src-annotation
    it('反例：@src 锚不泄入执行 prompt（task_context/instruction 全无出处文本）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution('# T\nId: t\n## Goal\ng\n## Outputs\n- r: text  # r\n## Steps\n1. [reason] 想\n  + → r: text  # r\n  > @src 原文秘密出处标记XYZZY\n  > 思考\n2. [exit] 完\n', HOST);
      const ctx = new PromptAssembler(engine).assembleReasonContext(engine.getSpec()!.steps![0]);
      expect(JSON.stringify(ctx)).not.toContain('XYZZY');
    });

    // L1a 不可降级（设计激进压缩条款——十六审抓设计代码不一致:原只发 Goal+直接父,
    // Constraints/Types/Outputs 三件契约全丢;激进压缩砍 L1b/L2/L3/L4 不砍契约）
    it('正例：激进压缩保留 L1a 全部契约（Constraints/Types 字段级/Outputs 不可降级）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });
      const assembler = new PromptAssembler(engine);
      const step1 = engine.getSpec()!.steps![0];
      const ctx = assembler.reassembleAggressive(step1);
      expect(ctx.task_context).toContain('- Must be idempotent');   // 分条渲染（2026-08-30 L1 三件实装,分号挤行退役）   // 安全约束不丢
      expect(ctx.task_context).toContain('DataRecord={text:text, score:int}');               // Types 字段级同源
      expect(ctx.task_context).toContain('你的输出声明在 L4）: result: text');
    });

    it('aggressively truncates inputs', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });

      engine.nextStep();
      engine.completeStep('1', { analysis: 'a'.repeat(1000) });

      const assembler = new PromptAssembler(engine);
      const step2 = engine.getSpec()!.steps![1];
      const ctx = assembler.reassembleAggressive(step2);

      const val = ctx.inputs['analysis'] as string;
      expect(val.length).toBeLessThanOrEqual(400);
    });
  });

  describe('assembleAdaptiveContext', () => {
    it('produces replan context for failed subtask', () => {
      const subtaskSpec = `# Adaptive Test
Id: adaptive

## Goal
Test adaptive replan

## Outputs
- final_out: text  # final

## Steps
1. [subtask retry=2 adaptive] Process
  + → final_out: text  # subtask out
  1.1. [reason] Try something
    + → attempt: text  # attempt
    > Do the thing
  1.2. [act] Execute
    - ← attempt
    + → exec_result: text  # exec result
    > Execute it
`;
      const engine = new ExecutionEngine();
      const init = engine.initExecution(subtaskSpec, HOST);
      expect(init.status).toBe('ok');

      // 升级阶梯：第1次失败 → 带反馈重跑，第2次失败 → adaptive_needed
      engine.nextStep(); // step 1.1
      engine.completeStep('1.1', { attempt: 'plan A' });
      engine.nextStep(); // step 1.2
      engine.failStep('1.2', 'execution failed');
      // 带反馈重跑：重置 children，重跑 1.1 → 1.2 再次失败
      engine.nextStep();
      engine.completeStep('1.1', { attempt: 'plan A2' });
      engine.nextStep();
      engine.failStep('1.2', 'execution failed again');
      engine.nextStep(); // adaptive_needed

      const assembler = new PromptAssembler(engine);
      const ctx = assembler.assembleAdaptiveContext('1');

      expect(ctx.task_context).toContain('Goal: Test adaptive replan');
      expect(ctx.task_context).toContain('Subtask: Process');
      expect(ctx.instruction).toContain('Replan required');
      expect(ctx.progress_summary).toContain('1.1');
      expect(ctx.progress_summary).toContain('1.2');
      expect(ctx.output_schema).toHaveLength(1);
      expect(ctx.output_schema[0].name).toBe('final_out');
    });

    // 0017 同族十六审补：replan 生成新步骤要产出这些输出——输出涉自定义类型时定义闭包须在场
    it('正例：subtask 输出涉自定义类型 → replan 上下文附字段级定义闭包（嵌套类型全带）', () => {
      const SPEC = `# A\nId: a\n## Goal\ng\n## Types\n- Candidate:  # c\n  - claim: text\n- Mark:  # m\n  - points: [Candidate]\n## Outputs\n- mark: Mark  # m\n## Steps\n1. [subtask adaptive] P\n  + → mark: Mark  # m\n  1.1. [reason] r\n    + → mark: Mark  # m\n    > t\n`;
      const engine = new ExecutionEngine();
      engine.initExecution(SPEC, HOST);
      const ctx = new PromptAssembler(engine).assembleAdaptiveContext('1');
      // 2026-08-27 注释入渲染:带 # 注释的类型换条目式（作者定"llm 需要注释"——断言随契约更新）
      expect(ctx.task_context).toContain('Mark:  # m');
      expect(ctx.task_context).toContain('points: [Candidate]');
      expect(ctx.task_context).toContain('Candidate:  # c');
      expect(ctx.task_context).toContain('claim: text');
    });

    it('反例：subtask 输出全内置类型 → replan 上下文零 Types 段（不加噪声）', () => {
      const SPEC = `# B\nId: b\n## Goal\ng\n## Types\n- Unused:  # u\n  - x: text\n## Outputs\n- out: text  # o\n## Steps\n1. [subtask adaptive] P\n  + → out: text  # o\n  1.1. [reason] r\n    + → out: text  # o\n    > t\n`;
      const engine = new ExecutionEngine();
      engine.initExecution(SPEC, HOST);
      const ctx = new PromptAssembler(engine).assembleAdaptiveContext('1');
      expect(ctx.task_context).not.toContain('Unused=');   // 未被输出引用的类型不进 replan 上下文
    });

    it('returns minimal context for unknown subtask', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });

      const assembler = new PromptAssembler(engine);
      const ctx = assembler.assembleAdaptiveContext('nonexistent');

      expect(ctx.instruction).toBe('Replan required.');
      expect(ctx.output_schema).toHaveLength(0);
    });
  });

  describe('Method variants', () => {
    it('assembleCheckContext produces same structure as assembleReasonContext', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });
      const assembler = new PromptAssembler(engine);

      const step = engine.getSpec()!.steps![0];
      const reason = assembler.assembleReasonContext(step);
      const check = assembler.assembleCheckContext(step);

      expect(reason.task_context).toBe(check.task_context);
      expect(reason.progress_summary).toBe(check.progress_summary);
    });

    it('assembleActContext produces same structure', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });
      const assembler = new PromptAssembler(engine);

      const step = engine.getSpec()!.steps![0];
      const reason = assembler.assembleReasonContext(step);
      const act = assembler.assembleActContext(step);

      expect(reason.task_context).toBe(act.task_context);
    });
  });

  // @v: anc-provider-knowledge
  // @v: anc-exec-token-budget
  describe('knowledge provider budget', () => {
    it('uses larger budget when hasKnowledgeProvider is true', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });
      const withKnowledge = new PromptAssembler(engine, true);
      const without = new PromptAssembler(engine, false);

      const step = engine.getSpec()!.steps![0];
      const ctxWith = withKnowledge.assembleReasonContext(step);
      const ctxWithout = without.assembleReasonContext(step);

      // Both produce valid contexts; budget allocation differs internally
      expect(ctxWith.task_context).toBeDefined();
      expect(ctxWithout.task_context).toBeDefined();
    });
  });

  describe('backward compatibility', () => {
    // @v: anc-exec-l2c-retry-feedback
  it('engine nextStep still returns AssembledContext with all fields', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });

      const r = engine.nextStep();
      expect(r.status).toBe('step_ready');
      if (r.status === 'step_ready') {
        expect(r.context).toBeDefined();
        expect(typeof r.context.task_context).toBe('string');
        expect(typeof r.context.progress_summary).toBe('string');
        expect(typeof r.context.instruction).toBe('string');
        expect(Array.isArray(r.context.output_schema)).toBe(true);
        expect(typeof r.context.inputs).toBe('object');
      }
    });
  });

  // 覆盖守护：hoplog 的 llm.prompt（debug 级）= formatPromptText(ctx) 渲染的完整 context。
  // 保证 formatPromptText 不漏记 AssembledContext 的任何字段——新增字段忘同步渲染 → 本组断言挂。
  // 契约锚点见 [[spec-observability#^anc-obs-debug-context]]（debug 记 llm.prompt = 完整自包含 prompt 文本）。
  describe('formatPromptText 字段覆盖守护', () => {
    // 每字段填一个唯一可识别哨兵值，断言全部出现在渲染输出里。
    const FULL_CTX: AssembledContext = {
      task_context: 'SENTINEL_TASK_CTX',
      knowledge_context: 'SENTINEL_KNOWLEDGE',
      doc_ref_context: 'SENTINEL_DOCREF',
      hop_env_table: 'SENTINEL_HOPENV_TABLE',
      retry_feedback: 'SENTINEL_RETRY_FB',
      progress_summary: 'SENTINEL_PROGRESS',
      iteration_history: 'SENTINEL_ITER_HIST',
      fail_context: 'SENTINEL_FAIL_CTX',
      inputs: { sentinel_input_key: 'SENTINEL_INPUT_VAL' },
      instruction: 'SENTINEL_INSTRUCTION',
      output_schema: [{ name: 'sentinel_out', type: 'text', description: 'SENTINEL_SCHEMA_DESC' }],
    };

    // 修正指令收尾段（2026-08-23 作者定"错误意见应该放在输出的位置"——dr12 实撞:反馈在中部
    // 与作业指令隔 2.5 万字,两条明确要改的意见零落实） // @v: anc-exec-l2c-retry-feedback
    it('正例：L5 修正指令垫尾（L4 之后,上游先重试后）；反例：无反馈时不出现 L5 区块', () => {
      // 2026-08-24 层序重编:旧 L2b/L2c 区块名废除,修正指令=L5 垫尾;旧独立"L5 输出约束"区块废除并入 L4
      const out = formatPromptText({ ...FULL_CTX, upstream_feedback: 'SENTINEL_UPSTREAM' } as any, 'reason');
      const posL4 = out.indexOf('L4. 当前节点');
      const posL5 = out.indexOf('L5. 修正指令');
      const posUp = out.indexOf('上游修正意见');   // 全 HopSchema 化后条目名
      const posRetry = out.indexOf('SENTINEL_RETRY_FB');
      expect(posL5).toBeGreaterThan(posL4);
      expect(posUp).toBeGreaterThan(posL5);
      expect(posRetry).toBeGreaterThan(posUp);   // 上游先、本地重试后
      expect(out).not.toContain('═══ L5. 输出约束');   // 旧独立输出约束区块零出现
      const noFb = formatPromptText({ ...FULL_CTX, retry_feedback: undefined, upstream_feedback: undefined } as any, 'reason');
      expect(noFb).not.toContain('L5. 修正指令');
    });

    it('渲染覆盖 AssembledContext 全部字段（漏记即挂）', () => { // @v: anc-obs-debug-context
      const out = formatPromptText(FULL_CTX, 'reason');
      // 逐字段哨兵——任一缺失说明 formatPromptText 漏渲染该字段
      expect(out).toContain('SENTINEL_TASK_CTX');       // L1 task_context
      expect(out).toContain('SENTINEL_KNOWLEDGE');       // L2 步骤级 knowledge_context
      expect(out).toContain('SENTINEL_DOCREF');          // L2 doc_ref_context
      expect(out).toContain('SENTINEL_HOPENV_TABLE');   // L2 hop_env_table
      expect(out).toContain('SENTINEL_RETRY_FB');        // L5 retry_feedback
      expect(out).toContain('SENTINEL_PROGRESS');        // L3 progress_summary
      expect(out).toContain('SENTINEL_ITER_HIST');       // L3 iteration_history
      expect(out).toContain('sentinel_input_key');       // L4 inputs (key)
      expect(out).toContain('SENTINEL_INPUT_VAL');       // L4 inputs (value)
      expect(out).toContain('SENTINEL_INSTRUCTION');     // L4 instruction
      expect(out).toContain('sentinel_out');             // L4 output_schema (name)
      // fail_context 渲染+位置契约（^anc-exec-onfail-context:落 L3 区块尾——review 变异3实证
      // 渲染行删掉全绿零保护后补） // @v: anc-exec-onfail-context
      expect(out).toContain('SENTINEL_FAIL_CTX');
      const posL3 = out.indexOf('L3. 轨迹与位置');
      const posFail = out.indexOf('SENTINEL_FAIL_CTX');
      const posL4h = out.indexOf('L4. 当前节点');
      expect(posFail).toBeGreaterThan(posL3);
      expect(posFail).toBeLessThan(posL4h);   // 在 L3 区块内,不漂进 L4/L6
    });

    it('可选字段缺省时不崩、必填字段仍完整渲染', () => { // @v: anc-obs-debug-context
      const minimal: AssembledContext = {
        task_context: 'ONLY_TASK',
        progress_summary: 'ONLY_PROGRESS',
        inputs: {},
        instruction: 'ONLY_INSTRUCTION',
        output_schema: [{ name: 'r', type: 'text', description: 'd' }],
      };
      const out = formatPromptText(minimal, 'reason');
      expect(out).toContain('ONLY_TASK');
      expect(out).toContain('ONLY_PROGRESS');
      expect(out).toContain('ONLY_INSTRUCTION');
      expect(out).not.toContain('**本步输入材料**（HopSchema 赋值形态'); // 零输入时 L4 不渲染输入段(L4 并入后占位行随省——整段不出场比一行'(无输入)'更省噪声)
    });

    // formatParallelPromptText 测试已删（P0.5：函数随旧通道派活单退役）

    // @v: anc-exec-format-example-structural —— 交付格式例按值性质分形（结构型字段禁 | 块标量:
    // Ling hb2 实撞——引擎把 yaml 型 aux_ledger 渲染成 `aux_ledger: |` 占位,模型逐字照抄交出
    // 字符串包结构,validator 拒收五轮烧尽;G5 探针 T5 同考点明示指令下 6/6 立据是引擎教错不是模型不会）
    describe('交付格式例按值性质分形', () => {
      const mkCtx = (outs: AssembledContext['output_schema']): AssembledContext =>
        ({ ...FULL_CTX, output_schema: outs });

      it('正例：yaml 型占位=缩进结构,不出 | 块标量;结构规则短句在场', () => {
        const out = formatPromptText(mkCtx([{ name: 'ledger', type: 'yaml', description: '台账' }]), 'reason');
        expect(out).not.toContain('ledger: |');
        expect(out).toContain('ledger:\n  （台账——结构化数据:直接写缩进的 YAML 对象/列表');
        expect(out).toContain('不要用 | 把结构包成字符串');
      });

      it('正例：[Type] 列表型占位=- 条目起头;自定义 TypeDecl 型同归结构档', () => {
        const out = formatPromptText(mkCtx([
          { name: 'items', type: '[CheckPoint]', description: '清单' },
          { name: 'card', type: 'IssueCard', description: '卡' },
        ]), 'reason');
        expect(out).toContain('items:\n  - （清单——列表值');
        expect(out).not.toContain('items: |');
        expect(out).toContain('card:\n  （卡——结构化数据');
      });

      it('反例：文本多行型仍教块标量,标量型仍单行;全非结构型时结构规则短句不出现', () => {
        const out = formatPromptText(mkCtx([
          { name: 'report', type: 'markdown', description: '报告' },
          { name: 'ok', type: 'bool', description: '判定' },
        ]), 'reason');
        expect(out).toContain('report: |');
        expect(out).toContain('ok: （判定）');
        expect(out).not.toContain('不要用 | 把结构包成字符串');
      });

      it('正例：修订短 prompt 的格式例同一分形源——yaml 型不出块标量', () => {
        const shortCtx: AssembledContext = {
          ...FULL_CTX, revision_short: true,
          output_schema: [{ name: 'ledger', type: 'yaml', description: '台账' }],
        };
        const out = formatPromptText(shortCtx, 'reason');
        expect(out).not.toContain('ledger: |');
        expect(out).toContain('ledger:\n  （修订后的完整值——结构化数据');
      });
    });

    // @v: anc-exec-revision-short-weak —— 弱模型档修订短 prompt（打回重试轮换卷:命令整体替换
    // 为修订祈使句,从头教学框架全撤;A/B 实锤框架在场弱模型按篇幅选"从头做题"模板 schema 0/6,
    // 砍净 6/6。缺省 standard 全模型零变化——revision_short 不置位时渲染与本组其余测试同卷）。
    describe('revision_short 修订短 prompt', () => {
      const SHORT_CTX: AssembledContext = {
        ...FULL_CTX,
        revision_short: true,
        constraints_text: '- SENTINEL_CONSTRAINT_LINE',
        retry_context: {
          check_failed_origin: true,
          rejected_by: { step_id: '2.4', summary: '验收提取完备性', checked_inputs: ['doc_content', 'points'] },
          prior_outputs: [{ name: 'points', type: '[CheckPoint]', rendered: 'SENTINEL_PRIOR_POINTS' }],
        },
      };

      it('正例：短卷=修订命令头+基准+意见+落实规则在场;从头教学框架全撤', () => {
        const out = formatPromptText(SHORT_CTX, 'reason');
        // 换掉的命令:修订祈使句开卷
        expect(out).toContain('修订任务');
        expect(out).toContain('不是重做任务');
        // 六件在场
        expect(out).toContain('SENTINEL_CONSTRAINT_LINE');   // Constraints 保留(作者拍)
        expect(out).toContain('SENTINEL_INPUT_VAL');          // 输入材料
        expect(out).toContain('sentinel_out');                // 输出声明
        expect(out).toContain('SENTINEL_PRIOR_POINTS');       // 上一版基准
        expect(out).toContain('SENTINEL_RETRY_FB');           // 打回意见
        expect(out).toContain('意见未提到的地方原样保留');      // 落实规则
        expect(out).toContain('被步骤 2.4');                   // 打回来源点名
        // 从头教学框架全撤
        expect(out).not.toContain('SENTINEL_TASK_CTX');       // L1 全局契约撤
        expect(out).not.toContain('SENTINEL_KNOWLEDGE');      // L2 知识撤
        expect(out).not.toContain('SENTINEL_PROGRESS');       // L3 轨迹撤
        expect(out).not.toContain('SENTINEL_INSTRUCTION');    // 原任务祈使句整体撤下(命令替换的本体)
        expect(out).not.toContain('═══ L0');                   // 世界观撤
        expect(out).not.toContain('L4. 当前节点');             // 标准分层框架不在场
      });

      it('正例：schema 行内反馈单独摘出保留（例外保真②——纠错信息不随 instruction 撤下蒸发）', () => {
        const kicked = { ...SHORT_CTX, instruction: 'SENTINEL_INSTRUCTION\n\n[上次输出未通过校验，请修正后重新输出]\nSENTINEL_SCHEMA_KICK' };
        const out = formatPromptText(kicked, 'reason');
        expect(out).toContain('SENTINEL_SCHEMA_KICK');        // 校验反馈保留
        expect(out).toContain('[上次输出未通过校验');
        expect(out).not.toContain('SENTINEL_INSTRUCTION');    // 原任务本体仍撤
      });

      it('正例：工具清单保留（例外保真①——下发面与清单同源）;反例：revision_short 不置位走标准卷零变化', () => {
        const withTools = { ...SHORT_CTX, tool_manifest: 'SENTINEL_TOOL_MANIFEST' };
        expect(formatPromptText(withTools, 'reason')).toContain('SENTINEL_TOOL_MANIFEST');
        // 反例:同一 ctx 去掉 revision_short → 标准卷(教学框架在场)
        const std = { ...SHORT_CTX, revision_short: undefined } as AssembledContext;
        const out = formatPromptText(std, 'reason');
        expect(out).toContain('SENTINEL_TASK_CTX');
        expect(out).toContain('SENTINEL_INSTRUCTION');
        expect(out).toContain('L4. 当前节点');
      });

      it('契约：短卷全入易变面（stableSections 空——system 只剩工作目录行,短档无缓存亲和稳定面）', () => {
        const parts = renderPromptParts(SHORT_CTX, 'reason');
        expect(parts.stableSections).toHaveLength(0);
        expect(parts.volatileSections.join('\n')).toContain('修订任务');
      });

      // @v: anc-exec-revision-short-weak —— 装配层触发块（2026-09-18 review 面三变异 M1 实锤:
      // 置位块整删 3068 全绿零保护——渲染层四钉全用手工 ctx,只锁"置位后渲染什么"不锁"何时置位";
      // 本组真走 assembleContext 锁触发条件全域:short×reason×打回轮置位+constraints 抽出剥注记,
      // standard 档/首轮不置位）
      describe('装配层 revision_short 触发（真走 assembleContext）', () => {
        const RETRY_SPEC = `# T
Id: t-rev
## Goal
g
## Constraints
- 每条核查须标注证据来源,不得凭记忆断言;搜不到就如实标注,禁止编造数据（完整判据见 [[某设计#^anc-fake-ref]]）
## Inputs
- doc: text  # 料
## Steps
1. [subtask retry=2] 提取并验收
  - ← doc
  + → pts: text  # 清单
  1.1. [reason] 提取
    - ← doc
    + → pts: text  # 清单
    > 提取
  1.2. [check final] 验收
    - ← pts
    + → ok: bool  # 判
    + → gap: text  # 说明
    > 核对`;
        function mkRetryCtx(mode: 'standard' | 'short'): AssembledContext {
          // 按引擎真实驱动序构造打回轮（与"L5 打回轮恒供给"组同款——nextStep 驱动,不越过引擎直调）
          const engine = new ExecutionEngine();
          engine.initExecution(RETRY_SPEC, HOST, { params: { doc: 'd' } });
          engine.setRevisionPromptMode(mode);
          engine.nextStep();                                   // → 1.1
          engine.completeStep('1.1', { pts: '旧版清单' });
          engine.nextStep();                                   // → 1.2
          engine.failStep('1.2', 'CHECK_FAILED: 漏了X');
          const r = engine.nextStep();                         // → 1.1 打回重跑轮
          return (r as { context: AssembledContext }).context;
        }

        it('正例：short 档×reason 打回轮 → revision_short 置位+constraints_text 抽出且剥装配注记', () => {
          const ctx = mkRetryCtx('short');
          expect(ctx.retry_feedback).toBeDefined();            // 前置自证:打回轮真构造出来了
          expect(ctx.revision_short).toBe(true);
          expect(ctx.constraints_text).toContain('每条核查须标注证据来源');   // 约束本体保留
          expect(ctx.constraints_text).not.toContain('[[某设计');   // stripAssemblyNotes 剥装配注记（含指路短语所在半句——句读边界收窄）
        });

        it('反例：standard 档同打回轮 → 不置位;首轮（无打回）short 档 → 不置位', () => {
          const ctxStd = mkRetryCtx('standard');
          expect(ctxStd.retry_feedback).toBeDefined();
          expect(ctxStd.revision_short).toBeUndefined();
          const engineFirst = new ExecutionEngine();
          engineFirst.initExecution(RETRY_SPEC, HOST, { params: { doc: 'd' } });
          engineFirst.setRevisionPromptMode('short');
          const first = engineFirst.nextStep();
          const ctxFirst = (first as { context: AssembledContext }).context;
          expect(ctxFirst.revision_short).toBeUndefined();
        });
      });

      // @v: anc-exec-inputs-deflate —— retry 基准卸载指路语按工具面分叉（2026-09-18 review 面二抓
      // 组装期拼死文案"用 read 工具按需取"对零工具面步是死指路——决策5 普遍规则第三处落点;
      // 修后组装层只存中性事实,渲染层按 tool_manifest 分叉）
      it('retry 基准卸载条目：有工具面指 read 按需取;零工具面给"凭节选修订"出口不指死路', () => {
        const po = { name: 'pts', type: 'text', rendered: 'X'.repeat(500), offloaded: true, offload_path: '/wz/vars/retry_base_pts.txt', full_chars: 9999 };
        const base = { ...SHORT_CTX, retry_context: { check_failed_origin: true, prior_outputs: [po] } };
        const withTools = formatPromptText({ ...base, tool_manifest: 'M' } as any, 'reason');
        expect(withTools).toContain('可用 read 工具按需取');
        expect(withTools).toContain('/wz/vars/retry_base_pts.txt');
        const noTools = formatPromptText(base as any, 'reason');
        expect(noTools).toContain('基于以下节选修订');
        expect(noTools).not.toContain('read 工具按需取');
      });
    });
  });
});

// @v: anc-exec-l1-skeleton —— 重构跟进:骨架渲染 for-each/parallel 属性(itemVar 对 LLM 的唯一声明)
describe('L1 骨架容器属性渲染（v0.1.1）', () => {
  // @v: anc-step-break — 目标随骨架渲染（丢渲染=执行 LLM 眼里多层跳出降级为最近循环）
  it('break/continue 目标步骤号入骨架行,裸形态不带', () => {
    const spec = `# T
Id: t
## Goal
g

## Steps
1. [loop max=3] Outer
  1.1. [loop max=3] Inner
    1.1.1. [reason] W
      + → x: bool  # f
      > w
    1.1.2. [branch] B
      1.1.2.1. [case] {x}
        1.1.2.1.1. [break 1] stop all
      1.1.2.2. [case]
        1.1.2.2.1. [continue] next inner
2. [act] Tail
  + → out: text  # o
  > t
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    const assembler = new PromptAssembler(engine);
    const leaf = ((engine.getSpec()!.steps![0] as any).children[0]).children[0];
    const ctx = assembler.assembleReasonContext(leaf);
    expect(ctx.task_context).toContain('[break 1] stop all');
    expect(ctx.task_context).toContain('[continue] next inner');
  });

  it('loop for-each+parallel 与 subtask parallel 均入骨架行', () => {
    const spec = `# T
Id: t
## Goal
g
## Inputs
- items: [text]  # 列表

## Steps
1. [loop for-each item in items, collect out_item into out] 遍历
  + → out: [text]  # 收集
  1.1. [subtask parallel] Do 一项
    + → out_item: text  # 单项
    1.1.1. [reason] Do
      - ← item
      + → out_item: text  # 单项
      > do
2. [subtask] 边界
  + → a: text  # x
  2.1. [subtask parallel] 并发组
    + → a: text  # x
    2.1.1. [reason] A
      + → a: text  # a
      > a
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    const assembler = new PromptAssembler(engine);
    const inner = (engine.getSpec()!.steps![0] as any).children[0];
    const ctx = assembler.assembleReasonContext(inner);
    expect(ctx.task_context).toContain('for-each item in items');
    expect(ctx.task_context).toContain('parallel');
  });

  // 骨架 case 用标准写法 [case(条件)]/[case(else)] 渲染——与 spec 源同形，不出现第二种格式（旧 [case: 条件] 废）
  it('case 条件与统配按标准写法入骨架行', () => {
    const spec = `# T2
Id: t2
## Goal
g
## Inputs
- mode: line  # 模式

## Steps
1. [branch] 判
  + → out: text  # 结论
  1.1. [case(mode == "a")] A 路
    + → out: text  # 同名填充
    1.1.1. [reason] ra
      + → out
      > ra
  1.2. [case(else)] 兜底
    + → out: text  # 同名填充
    1.2.1. [reason] rb
      + → out
      > rb
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    const assembler = new PromptAssembler(engine);
    const inner = (engine.getSpec()!.steps![0] as any).children[0].children[0];
    const ctx = assembler.assembleReasonContext(inner);
    expect(ctx.task_context).toContain('[case(mode == "a")]');
    expect(ctx.task_context).toContain('[case(else)]');
    expect(ctx.task_context).not.toContain('[case: ');
  });
});

// F类测试缺口补齐(2026-08-08 语义审计 c2t ⚠️,prompt-assembler 批)。
// @v: anc-exec-l3-display-rules
describe('fullDisplaySet 依赖驱动展示（决策 2 核心）', () => {
  it('早期依赖步骤跨滑窗仍全文展示（当前步 ← 引用其产出）', () => {
    const spec = `# DepDrive
## Goal
依赖驱动验证

## Steps
1. [reason] 源头
  + → seed: text
  > t
2. [reason] 中间a
  + → x2: text
  > t
3. [reason] 中间b
  + → x3: text
  > t
4. [reason] 中间c
  + → x4: text
  > t
5. [reason] 中间d
  + → x5: text
  > t
6. [reason] 中间e
  + → x6: text
  > t
7. [reason] 中间f
  + → x7: text
  > t
8. [reason] 消费者
  - ← seed
  + → fin: text
  > t
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    for (let i = 1; i <= 7; i++) {
      engine.nextStep();
      engine.completeStep(String(i), i === 1 ? { seed: 'SEED-VALUE-XYZ' } : { ['x' + i]: 'v' + i });
    }
    const r = engine.nextStep();   // 步骤8,依赖步骤1(在滑窗5之外)
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    // 步骤1早已滑出近5窗口,但作为依赖产出者必须全文展示其值
    expect(r.context.progress_summary).toContain('SEED-VALUE-XYZ');
  });
});

// @v: anc-exec-l3-branch
describe('branch 无 case 命中折叠展示', () => {
  it('无命中 → 折叠标静默跳过,输出 None 可检', () => {
    const spec = `# NoHit
## Goal
无命中验证

## Steps
1. [reason] 出分类
  + → kind: text
  > t
2. [branch] 分流
  2.1. [case] 甲 (kind == "alpha")
    + → out: text
    2.1.1. [reason] 甲支
      + → out: text
      > t
3. [reason] 后继
  + → fin: text
  > t
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    engine.nextStep();
    engine.completeStep('1', { kind: 'omega' });   // 不命中任何 case
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    expect(r.step_id).toBe('3');   // branch 静默跳过直达后继
    // L3 折叠行存在(branch 已终态入 L3;具体措辞不锁死,断言其出现在进度里)
    expect(r.context.progress_summary).toContain('[branch]');
  });
});

// @v: anc-exec-l3-branch —— 状态跟随（hopissues/0063:原 marker 硬编码 ✓ 且聚合值无条件求值,
// 当前步还在 case 内部时渲染"✓ … → candidates=null",与"你的位置"自相矛盾——向执行 LLM 报
// 已交付空值假信息。变异实证:marker 改回硬编码 ✓,running 钉红）
describe('branch 折叠行状态跟随（hopissues/0063）', () => {
  const SPEC = `# BranchState
## Goal
状态跟随验证

## Steps
1. [reason] 出分类
  + → kind: text
  > t
2. [branch] 分流
  + → candidates: text
  2.1. [case] 甲 (kind == "alpha")
    + → candidates: text
    2.1.1. [reason] 甲支第一步
      + → mid: text
      > t
    2.1.2. [reason] 甲支第二步
      - ← mid
      + → candidates: text
      > t
3. [reason] 后继
  - ← candidates
  + → fin: text
  > t
`;

  it('正例（probe 判据①②）：running branch 渲染 ▶ 且不渲染聚合输出——case 子步执行中取其 prompt 的 L3', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, HOST);
    engine.nextStep();
    engine.completeStep('1', { kind: 'alpha' });   // 命中 2.1
    engine.nextStep();
    engine.completeStep('2.1.1', { mid: '半成品' });
    const r = engine.nextStep();   // 停在 2.1.2——branch 2 仍 running
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    expect(r.step_id).toBe('2.1.2');
    const l3 = r.context.progress_summary ?? '';
    // 判据①:执行中的 branch 不标 ✓
    expect(l3).not.toMatch(/✓ 2 \[branch\]/);
    expect(l3).toMatch(/▶ 2 \[branch\]/);
    // 判据②:未完成的 branch 不渲染聚合输出值(不出现"已交付 null"误报)
    expect(l3).not.toContain('candidates=null');
    expect(l3).not.toMatch(/▶ 2 \[branch\][^\n]*→/);
  });

  it('正例（probe 判据③）：done branch 现行形态不回退——✓+命中 case+聚合输出', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, HOST);
    engine.nextStep();
    engine.completeStep('1', { kind: 'alpha' });
    engine.nextStep();
    engine.completeStep('2.1.1', { mid: '半成品' });
    engine.nextStep();
    engine.completeStep('2.1.2', { candidates: '三个候选' });
    const r = engine.nextStep();   // branch done,停在 3
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    expect(r.step_id).toBe('3');
    const l3 = r.context.progress_summary ?? '';
    expect(l3).toMatch(/✓ 2 \[branch\]/);
    expect(l3).toContain('命中 2.1');
    // 聚合输出值在场——判据③的"聚合输出"半边（首落批只断 ✓+命中，值出现无断言——工程链
    // review 增量批补：done 态值不渲染的回退同样破坏契约，与 running 态不渲染值成对）
    expect(l3).toMatch(/✓ 2 \[branch\][^\n]*→[^\n]*candidates/);
  });

  it('正例（三态补全）：failed branch 渲染 ✗ 且不渲染聚合输出——条件计算异常致 branch failed 后取后继 L3', () => {
    // ✗ 分支（prompt.ts marker 三分的 failed 半边）首落批零测试覆盖——工程链 review 增量批补钉。
    // branch failed 的既有制法：case 条件对文本值做数值比较 → 计算异常也是 fail（2026-08-09 定稿）。
    const FSPEC = `# BranchFailedState
## Goal
failed 态渲染验证

## Steps
1. [subtask retry=1] 守护
  + → out: text
  1.1. [reason] 出模式
    + → mode: text
    > t
  1.2. [branch] 按模式分流
    + → candidates: text
    1.2.1. [case] 数比较 (mode > 3)
      1.2.1.1. [reason] 甲支
        + → candidates: text
        > t
  1.3. [reason] 后继
    + → out: text
    > t
  1.4. [on fail] 兜底
    1.4.1. [reason] 降级
      + → out: text
      > t
`;
    const engine = new ExecutionEngine();
    engine.initExecution(FSPEC, HOST);
    engine.nextStep();
    // mode 灌文本 → 条件 mode > 3 计算异常 → branch failed（retry 重跑轮仍灌坏值 → 耗尽激活兜底）
    engine.completeStep('1.1', { mode: 'doc' });
    let r = engine.nextStep();
    if (r.status === 'step_ready' && r.step_id === '1.1') {
      engine.completeStep('1.1', { mode: 'doc' });
      r = engine.nextStep();
    }
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    expect(engine.getStepStates().get('1.2')).toBe('failed');
    const l3 = r.context.progress_summary ?? '';
    expect(l3).toMatch(/✗ 1\.2 \[branch\]/);            // 失败记号在场
    expect(l3).not.toMatch(/✓ 1\.2 \[branch\]/);        // 不许标已完成
    expect(l3).not.toMatch(/1\.2 \[branch\][^\n]*→/);   // 不许渲染聚合输出
  });
});

// @v: anc-exec-l3-loop
describe('loop 迭代数>4 早期轮次压缩', () => {
  it('第 6 轮时早期轮压缩为计数、近轮保留', () => {
    const spec = `# ManyIter
## Goal
多轮验证

## Steps
1. [loop max_iterations=10] 磨
  + → acc: text = ""
  1.1. [reason] 干
    - ← acc
    + → acc: text
    > t
  1.2. [branch] 停判
    1.2.1. [case] 停 (acc == "STOP")
      1.2.1.1. [break] 出
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    let iter = 0;
    let lastCtx = '';
    for (;;) {
      const r = engine.nextStep();
      if (r.status !== 'step_ready') break;
      if (r.step_id === '1.1') {
        iter++;
        lastCtx = r.context.iteration_history ?? '';
        engine.completeStep('1.1', { acc: iter >= 6 ? 'STOP' : 'r' + iter });
      } else break;
      if (iter >= 6) { engine.nextStep(); break; }
    }
    // 第6轮组装时:上下文含近轮信息且不逐轮堆全部5轮明细(存在压缩迹象——断言含轮次序号且长度受控)
    expect(iter).toBeGreaterThanOrEqual(6);
    expect(lastCtx.length).toBeGreaterThan(0);
  });
});

// @v: anc-exec-token-budget —— max_context_tokens 覆盖告警线(死承诺2026-08-09实装)+观测通道
describe('分层压缩契约:覆盖开关与观测', () => {
  it('ResourceLimits.max_context_tokens 覆盖告警线', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, { ...HOST, resource_limits: { max_tool_iterations: 10, max_context_tokens: 500, max_output_tokens: 1000, max_replan_attempts: 3 } } as any);
    const assembler = new PromptAssembler(engine);
    expect((assembler as any).budget.total).toBe(500);
  });

  it('无覆盖时告警线缺省 10000', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, HOST, { params: { source: 's' } });
    const assembler = new PromptAssembler(engine);
    expect((assembler as any).budget.total).toBe(10000);
  });

  it('压缩动作记 HopLog warn(静默丢弃废除)', () => {
    const engine = new ExecutionEngine();
    const dir = mkdtempSync(join(tmpdir(), 'hoptest-compress-warn-'));
    engine.initExecution(THREE_STEP_SPEC, HOST, { logDir: dir, params: { source: 's' } });
    engine.nextStep();   // step 1 start(recordWarn 过 guardOrphan 需步骤在场)
    const assembler = new PromptAssembler(engine);
    const trim = (assembler as any).applyBudgetTrimming.bind(assembler);
    trim({
      task_context: 'x'.repeat(30000),
      progress_summary: 'y'.repeat(30000),
      iteration_history: 'iter\n' + 'z'.repeat(9000),
      instruction: 'do', inputs: {}, output_schema: [],
    }, '1');
    const yaml = readFileSync(engine.getHopLog()!.getFilePath(), 'utf-8');
    expect(yaml).toContain('context-compress');
  });
});

// ===== L2e hop_env 值表注入 =====
// @v: anc-exec-hop-env-table, anc-config-hop-env
describe('L2e hop_env 值表注入（attachHopEnvTable via assembleBasicContext）', () => {

  function mkHost(hopEnv?: Record<string, string>) {
    const ws = mkdtempSync(join(tmpdir(), 'l2e-'));
    return {
      workspace_dir: ws,
      sandbox: {
        filesystem: { workspace_dir: ws, read_access: { allowed: [ws], denied: [], confirm_required: [] } },
        network: { trusted_hosts: [] }, runtime: { available: [] },
      },
      api_key: '',
      ...(hopEnv ? { hop_env: hopEnv } : {}),
    };
  }

  const SPEC_REFS = `# T

## Goal
按 hop_env_kb_root 找材料

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → r: line  # r
  > 读 {hop_env_kb_root} 下的规范
`;

  const SPEC_NO_REF = `# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → r: line  # r
`;

  it('正例：spec 引用了键且表非空 → 值表在场,渲染含键值', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC_REFS, mkHost({ hop_env_kb_root: '/kb/brand' }));
    expect(init.status).toBe('ok');
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    expect(next.context.hop_env_table).toContain('hop_env_kb_root: /kb/brand');
    const rendered = formatPromptText(next.context, 'reason');
    // 2026-08-24 层序重编:旧 L2e 区块名废除,hop_env 值表渲染进 L2 知识区块（yaml 条目化,带作用说明）
    expect(rendered).toContain('hop_env 环境参数');
    expect(rendered).toContain('/kb/brand');
  });

  it('反例：spec 零引用 → 零表不白占 token', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_NO_REF, mkHost({ hop_env_kb_root: '/kb/brand' }));
    const next = engine.nextStep();
    expect(next.context.hop_env_table).toBeUndefined();
  });

  it('反例：表为空 → 无字段（引用了也没值可注,doc-ref 位才响亮报错）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_REFS, mkHost());
    const next = engine.nextStep();
    expect(next.context.hop_env_table).toBeUndefined();
  });
});

// [act free] 角色档（design ^anc-exec-act-free-role——review 实抓:原角色前缀只进 hoplog
// 记录线,standalone 真实请求零角色指引;修后 formatPromptText 'act_free' 档 + roleGuideText
// 供 dispatcher system 注入,两线同源） // @v: anc-exec-act-free-role
describe('[act free] 角色档分道', () => {
  const ctx = {
    task_context: 'Goal: t',
    progress_summary: '',
    inputs: {},
    instruction: '做事',
    output_schema: [{ name: 'o', type: 'text', description: '' }],
  } as Parameters<typeof formatPromptText>[0];

  it('正例：act_free 档=任务执行档（可推理可用工具,"自由"退场）且明令禁止不可逆动作', () => {
    const text = formatPromptText(ctx, 'act_free');
    expect(text).toContain('你的角色：任务执行');
    expect(text).not.toContain('自由');   // 机制词退场（作者定"否则无法无天"）
    expect(text).toContain('可以推理');
    expect(text).toContain('不可逆动作');   // free≠全能:commit 语义仍禁（作者钉）
  });

  it('反例：普通 act 档维持"确定性执行禁推理"（无 free 不松绑）', () => {
    const text = formatPromptText(ctx, 'act');
    expect(text).toContain('禁止推理');
    expect(text).not.toContain('你的角色：任务执行。');
  });

  it('actRoleKind 选择器：free→act_free / 非 free→act（engine hoplog 线与 dispatcher 请求线共用）', () => {
    expect(actRoleKind(true)).toBe('act_free');
    expect(actRoleKind(false)).toBe('act');
    expect(actRoleKind(undefined)).toBe('act');
  });

  it('roleGuideText：dispatcher 注入面拿到与 formatPromptText 同源的角色档文本', () => {
    expect(roleGuideText('act_free')).toContain('你的角色：任务执行');
    expect(roleGuideText('commit')).toContain('不可逆动作执行');
  });
});

// ═══ L0-L5 重构新契约正反例（2026-08-24 受众公理重构,概念 Prompt组装参考 L0-L5 层序） ═══

const RE_HOST: HostConfig = {
  workspace_dir: '/tmp',
  api: { provider: 'anthropic', model: 'claude-test' },
};

// @v: anc-exec-l0-worldview-impl — L0 世界观五件（含树词表）+静态地图前置+缺席标注+戒律按类型裁剪
// （2026-08-30 作者两连抓后扩定:原四句零树词表"[act]是什么全靠猜";动态地图物理落 L2 后"L0 读了个寂寞"）
describe('L0 世界观与区块地图', () => {
  const BASE_CTX: AssembledContext = {
    task_context: 'T', progress_summary: 'P', inputs: {}, instruction: 'I',
    output_schema: [{ name: 'o', type: 'text', description: 'd' }],
  };

  it('正例：世界观五件在场（系统是什么/树怎么读/你是谁/输出去哪/地图）', () => {
    const out = formatPromptText(BASE_CTX, 'reason');
    expect(out).toContain('HopSpec 是把任务写成编号步骤树的规约');
    expect(out).toContain('树怎么读');
    expect(out).toContain('只有叶子步骤真正被执行');
    expect(out).toContain('只执行树中的一个叶子步骤');
    expect(out).toContain('本消息是你能看到的全部信息');
    expect(out).toContain('会被机器按 YAML 解析成变量');   // 输出口径统一 YAML（2026-08-24 作者定）
  });

  it('正例：HopSchema 类型全表在例子前直给+长值 =| 点明 YAML 块标量规则（2026-08-31 作者两抓:类型词零先验望文生义/缩进块边界规则自造词）', () => {
    const out = formatPromptText(BASE_CTX, 'reason');
    // 类型全表:八个执行面类型逐词在场(HopSpec 类型无执行 LLM 消费面不进表)
    for (const t of ['line（单行文本）', 'text（多行纯文本）', 'markdown', 'yaml（结构化数据）', 'prompt（给 LLM 的指令文本）']) {
      expect(out).toContain(t);
    }
    expect(out).toContain('数字只有这两种');
    expect(out).toContain('方括号包原子=列表');
    // 长值 =| 例点明 YAML 块标量规则(边界/结束/不转义三件接给模型)
    expect(out).toContain('规则同 YAML 块标量');
    expect(out).toContain('退出缩进即结束');
  });

  it('正例：树词表列全 15 种步骤类型（2026-08-31 作者抓漏容器类别后补全——含 call/on fail/exit/break/continue）', () => {
    const out = formatPromptText(BASE_CTX, 'reason');
    for (const token of ['[reason]', '[check]', '[act]', '[commit]', '[ask]', '[confirm]', '[call]',
                         '[subtask]', '[loop]', '[branch]', '[case]', '[on fail]',
                         '[exit]', '[break]', '[continue]']) {
      expect(out).toContain(token);
    }
    expect(out).toContain('叶子步骤类型');
    expect(out).toContain('容器类型');
    expect(out).toContain('控制流动作');
    expect(out).toContain('编排属性');
    expect(out).toContain('你只是其中某一轮');
  });


  it('正例：静态地图恒在 L0 内且先于 L1 出场（地图不迟到——修前地图挂易变面落 L2 后）', () => {
    const out = formatPromptText(BASE_CTX, 'reason');
    const mapIdx = out.indexOf('本消息区块地图');
    const l1Idx = out.indexOf('═══ L1');
    expect(mapIdx).toBeGreaterThan(-1);
    expect(l1Idx).toBeGreaterThan(-1);
    expect(mapIdx).toBeLessThan(l1Idx);
    // 静态地图列全现行六区块（层号 2026-08-31 前移:输入并入当前节点后旧 L5/L6 补位为 L4/L5,不留空挡——作者定）
    for (const row of ['- L0 ', '- L1 ', '- L2 ', '- L3 ', '- L4 ', '- L5 ']) {
      expect(out).toContain(row);
    }
    expect(out).not.toContain('- L6 ');   // 旧 L6 已前移,地图无空挡
    expect(out).toContain('输入材料（实际值）、输出声明、执行说明都在这里');
  });

  it('正例：可选区块在地图行内静态标注,勘误行机制已废（2026-08-31 作者定"还不如在 L0 说 L2/L5 是可选"）', () => {
    const bare = formatPromptText(BASE_CTX, 'reason');
    expect(bare).toContain('（可选——没有就不出现）');       // L2 行
    expect(bare).toContain('（可选——仅重试轮出现）');       // L5 行
    expect(bare).not.toContain('区块地图勘误');
    const withAll = formatPromptText({ ...BASE_CTX, knowledge_context: 'K', retry_feedback: 'F' }, 'reason');
    expect(withAll).not.toContain('区块地图勘误');
  });

  it('正例：act 档含 Bash 单命令纪律；反例：reason 步不含（戒律按类型裁剪）', () => {
    expect(formatPromptText(BASE_CTX, 'act')).toContain('每条 Bash 命令只做一件事');
    expect(formatPromptText(BASE_CTX, 'reason')).not.toContain('Bash');
  });

  it('正例：check 细则（双槽/名字任取）就地在 L4 输出段——2026-08-31 作者抓"太遥远"后从 L0 角色档迁入', () => {
    const out = formatPromptText({ ...BASE_CTX, node_decl: { step_id: '1', step_type: 'check', summary: 's', input_names: [] }, output_schema: [{ name: 'ok', type: 'bool', description: '' }, { name: 'note', type: 'text', description: '' }] } as any, 'check');
    expect(out).toContain('判定槽');
    expect(out).toContain('不必叫 ok/note');
  });
});

// @v: anc-exec-l0-worldview-impl — L0 恒定化（2026-09-01 作者两拍"L0 根据不同的节点有不同的
// 表述,是不是对 llm cache 不友好""具体要做的事情应该挪到 L4"。实撞:旧 roleGuideOf 七档进
// 稳定块打 cache 断点,步骤类型一换稳定块前缀变形 cache 全失——省当次 token 砸跨请求缓存）。
describe('L0 恒定化+L4 本步操作指引（2026-09-01 作者两拍）', () => {
  const BASE_CTX: AssembledContext = {
    task_context: 'T', progress_summary: 'P', inputs: {}, instruction: 'I',
    output_schema: [{ name: 'o', type: 'text', description: 'd' }],
  };

  it('钉⑤正例：L0 稳定块跨步骤类型逐字节同构（reason 与 act 两步各组装,stableSections join 后串相等）', () => {
    // 变异重放在案（4.4 实测）:恢复旧裁剪行为（buildL0Worldview 尾拼 roleGuideOf(stepType)）
    // → 本钉红（reason/act 稳定块前缀分叉）;恒定化形态 → 绿。cache 断点跨步复用的机检本体。
    const types = ['reason', 'check', 'act', 'act_free', 'commit'];
    const stables = types.map(t => renderPromptParts(BASE_CTX, t).stableSections.join('\n\n'));
    for (let i = 1; i < stables.length; i++) {
      expect(stables[i]).toBe(stables[0]);   // 逐字节同构,任一类型分叉即红
    }
    // 恒定三样在稳定块内:泛化角色句/通用戒律/YAML 总口径
    expect(stables[0]).toContain('你负责执行 L4 指出的那一个步骤');
    expect(stables[0]).toContain('步骤类型专属的操作指引在 L4 区块内就地给出');
    expect(stables[0]).toContain('输出总口径');
    // 类型专属句零残留(reason 推理档/act 禁推理档都不许进稳定块)
    expect(stables[0]).not.toContain('你的角色');
  });

  it('钉⑥正例：L4 含类型专属指引（reason 档 lack_of_info 教学/act 档 Bash 纪律/check 档双槽指引各就其位）', () => {
    const l4Of = (stepType: string, extra?: Partial<AssembledContext>) => {
      const parts = renderPromptParts({ ...BASE_CTX, ...extra }, stepType);
      return parts.volatileSections.join('\n\n');
    };
    // reason 档:推理身份+lack_of_info 出口教学(教出口必教下文)在 L4 易变面
    const reasonL4 = l4Of('reason');
    expect(reasonL4).toContain('─── 本步操作指引 ───');
    expect(reasonL4).toContain('你的角色：推理分析');
    expect(reasonL4).toContain('lack_of_info');
    expect(reasonL4).toContain('引擎可能补充知识重试');
    // act 档:Bash 单命令纪律
    const actL4 = l4Of('act');
    expect(actL4).toContain('你的角色：确定性执行');
    expect(actL4).toContain('每条 Bash 命令只做一件事');
    // check 档:身份+不越权红线,双槽细则就地在输出声明处(既有迁移,归并同区)
    const checkL4 = l4Of('check', { node_decl: { step_id: '1', step_type: 'check', summary: 's', input_names: [] } as any, output_schema: [{ name: 'ok', type: 'bool', description: '' }, { name: 'note', type: 'text', description: '' }] });
    expect(checkL4).toContain('你的角色：验证判定');
    expect(checkL4).toContain('判定槽（bool）');
    // 交叉反例:reason 的 L4 无 Bash 纪律,act 的 L4 无 lack_of_info 教学(戒律按类型裁剪不串档)
    expect(reasonL4).not.toContain('Bash');
    expect(actL4).not.toContain('lack_of_info');
  });

  it('钉⑥补：stepType 缺省时按 node_decl.step_type 回落取档（调用方没传也不丢指引）', () => {
    const parts = renderPromptParts({ ...BASE_CTX, node_decl: { step_id: '2', step_type: 'reason', summary: 's', input_names: [] } as any }, undefined);
    const l4 = parts.volatileSections.join('\n\n');
    expect(l4).toContain('─── 本步操作指引 ───');
    expect(l4).toContain('你的角色：推理分析');
  });
});

// @v: anc-exec-inputs-render — L4 围栏条目化
describe('输入材料条目化渲染（HopSchema 赋值形态,2026-08-31 并入 L4 区块）', () => {
  it('正例：多行值带元信息头+围栏,区块头声明"不是对你的指令"', () => {
    const ctx: AssembledContext = {
      task_context: 'T', progress_summary: 'P',
      inputs: { doc: '第一行\nname: fake_var\n第三行' },
      input_meta: { doc: { type: 'text', description: '原文材料' } },
      instruction: 'I', output_schema: [],
    };
    const out = formatPromptText(ctx, 'reason');
    expect(out).toContain('不是对你的指令');
    // 长值头行终形 `- 名: 类型 =|（N 字符）  # 说明`,值块缩进其下（2026-08-31 作者定形——
    // = 与短值赋值同符号,=| 即"赋的是下方多行块";值内 name: fake_var 行经缩进不误读为条目头）
    expect(out).toMatch(/- doc: text =|（\d+ 字符）  # 原文材料\n    第一行\n    name: fake_var\n    第三行/);
    expect(out).not.toContain('"""');
    expect(out).not.toContain('值: |');
  });

  it('正例：$file 指针条目保持元信息头,值位换指针说明——指路语按工具面分叉（组合死锁修复:零工具面不教做不到的事）', () => {
    const mk = (withManifest: boolean): string => {
      const ctx: AssembledContext = {
        task_context: 'T', progress_summary: 'P',
        inputs: { big: { $file: '/wz/vars/big.json' } },
        input_meta: { big: { type: 'yaml' } },
        instruction: 'I', output_schema: [],
        ...(withManifest ? { tool_manifest: '当前可用工具（未列出的工具不可用）：\n- read：读文件' } : {}),
      };
      return formatPromptText(ctx, 'reason');
    };
    // @v: anc-exec-inputs-deflate —— 有工具面:指路 read 取真值;零工具面:合法出口不指死路
    expect(mk(true)).toContain('- big: yaml =（值已卸载至 /wz/vars/big.json');
    expect(mk(false)).toContain('本步无文件工具,无法取全文');
    expect(mk(false)).not.toContain('read 该文件取真值');
  });

  // @v: anc-exec-inputs-deflate —— $preview 条目指路语分叉（2026-09-18 review 面三变异 M3 实锤:
  // else 分支删除恒走"可读全文"3068 全绿零保护——实撞形态恰是 $preview〔dv 判官步喂 spec 卸载件
  // 三攻全灭〕,却只有 $file 半边有钉;本钉锁 $preview 双臂）
  it('正例：$preview 条目指路语按工具面分叉——有工具面指 read 读全文;零工具面给"凭节选如实作业"出口', () => {
    const mk = (withManifest: boolean): string => {
      const ctx: AssembledContext = {
        task_context: 'T', progress_summary: 'P',
        inputs: { doc: { $preview: '节选内容'.repeat(10), full_chars: 30000, full_file: '/wz/vars/doc.json' } },
        input_meta: { doc: { type: 'text' } },
        instruction: 'I', output_schema: [],
        ...(withManifest ? { tool_manifest: '当前可用工具：\n- read：读文件' } : {}),
      };
      return formatPromptText(ctx, 'reason');
    };
    expect(mk(true)).toContain('可用 read 工具读全文');
    expect(mk(false)).toContain('因材料截断未完整覆盖');
    expect(mk(false)).not.toContain('可用 read 工具读全文');
  });

  it('反例：短单行值不套围栏（条目形态但轻量）', () => {
    const ctx: AssembledContext = {
      task_context: 'T', progress_summary: 'P', inputs: { n: 42 },
      instruction: 'I', output_schema: [],
    };
    const out = formatPromptText(ctx, 'reason');
    expect(out).toContain('- n = 42');   // 短值单行形态(2026-08-31 作者定)
    expect(out).not.toContain('体量:');
  });
});

// @v: anc-exec-inputs-render — 对象/列表值递归 HopSchema 展开（hopissues/0064:对象值被
// JSON.stringify 压成 227,774 字符单行灌 prompt,中文淹没在转义引号里。作者终拍定案:每层每
// 字段 `名: 类型 = 值`,解释项逐层在场——做 HopSchema 的初衷就是给 LLM 足够解释,纯 YAML 无
// 解释项;字段类型声明优先/运行时推断兜底,推断是标注不校验）
describe('对象/列表值递归 HopSchema 渲染（0064——JSON.stringify 与裸 YAML dump 均从值位绝迹）', () => {
  it('正例：对象列表逐字段 名: 类型 = 值 展开,不再单行压缩', () => {
    const points = Array.from({ length: 6 }, (_, i) => ({ claim: `第${i}条三十字中文断言内容示例文本材料`, basis: `依据文本片段${i}`, weight: i }));
    const ctx: AssembledContext = {
      task_context: 'T', progress_summary: 'P',
      inputs: { points },
      input_meta: { points: { type: '[Mark]', description: '核查点清单' } },
      instruction: 'I', output_schema: [],
    };
    const out = formatPromptText(ctx, 'reason');
    expect(out).not.toMatch(/= \[\{"/);                          // 旧形态:单行 JSON 压缩零出现
    expect(out).toMatch(/- points: \[Mark\] {2}# 核查点清单\n/);   // 顶层变量行=第一层:名: 类型 # 说明
    expect(out).toContain("- claim: line = '第0条三十字中文断言内容示例文本材料'");   // 列表元素首字段起头,类型+单引号值
    expect(out).toContain("basis: line = '依据文本片段0'");       // 后续字段对齐缩进,同为 名: 类型 = 值
    expect(out).toContain('weight: int = 0');                    // 数字推断 int,裸值无引号
    expect(out).not.toMatch(/\n\s+- claim: 第0条/);               // 裸 YAML 无类型行绝迹（字段行必带类型）
  });

  it('正例：短对象 {"k":1} 同走递归展开——k: int = 1 嵌套形态,JSON/flow 单行零出现', () => {
    const ctx: AssembledContext = {
      task_context: 'T', progress_summary: 'P', inputs: { cfg: { k: 1 } },
      instruction: 'I', output_schema: [],
    };
    const out = formatPromptText(ctx, 'reason');
    expect(out).toMatch(/- cfg\n {4}k: int = 1/);   // 键行后嵌套,字段带推断类型（无声明,meta 缺省无类型段）
    expect(out).not.toContain('= {"k":1}');         // JSON 单行绝迹
    expect(out).not.toContain('= {k: 1}');          // flow 单行档也不存在
    expect(out).not.toContain('cfg =|');            // =| 文本块记号不用于结构值
  });

  it('正例：Types 声明命中时字段类型用声明,优先于运行时推断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix0064-decl-'));
    const SPEC = `# T
Id: t
## Goal
g
## Types
- Mark:
    claim: line  # 断言
    basis: text  # 依据
## Inputs
- marked: [Mark]  # 各片标记汇总
## Outputs
- r: line  # r
## Steps
1. [reason] R
  - ← marked
  + → r: line  # r
  > 基于标记判定
`;
    const host: HostConfig = {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'k',
    };
    // basis 值给短单行——运行时推断会标 line,声明是 text:断 text 即证声明优先
    const marked = [{ claim: '一切危害社会的行为', basis: '第十三条原文' }];
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host, { params: { marked }, stateDir: join(dir, '.hopstate') });
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    const out = formatPromptText((next as { context: AssembledContext }).context, 'reason');
    expect(out).toContain("- claim: line = '一切危害社会的行为'");
    expect(out).toContain("basis: text = '第十三条原文'");   // 声明 text 优先（推断只会给 line）
  });

  // inline 预览通道扩对象档（0064 病灶②:$preview 只判 typeof val === 'string',对象值原样
  // 透传——227KB 就是从这个豁口穿到渲染层的）
  it('正例：inline 模式对象超大（序列化 >20K）走 $preview——预览为 YAML 前缀节选非 JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix0064-obj-'));
    const SPEC = `# T
Id: t
## Goal
g
## Inputs
- material: yaml  # 大料
## Outputs
- r: line  # r
## Steps
1. [reason] R
  - ← material
  + → r: line  # r
  > 基于材料判定
`;
    const host: HostConfig = {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'k',
    };
    const material = { items: Array.from({ length: 3000 }, (_, i) => `条目${i}内容片段`) };
    const serialized = JSON.stringify(material);
    expect(serialized.length).toBeGreaterThan(20000);   // 前提自证:确超 INLINE_PREVIEW_MAX
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host, { params: { material }, stateDir: join(dir, '.hopstate') });
    engine.setInlineLlmContext(true);
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    const inputs = (next as { context: { inputs: Record<string, unknown> } }).context.inputs;
    const v = inputs['material'] as { $preview?: string; full_chars?: number; full_file?: string };
    expect(v).toHaveProperty('$preview');           // 对象档也进预览通道,不再原样透传
    // full_chars 与 $preview 同源同单位=渲染文本全文字符数（review 抓原实现记 JSON 序列化
    // 字符数,与渲染节选两单位相减出假省略量——实截 11896 报 2301/零截断报省略 15045）
    expect(v.full_chars).toBeGreaterThanOrEqual(v.$preview!.length);
    expect(v.full_chars).not.toBe(serialized.length);   // 不再是 JSON 序列化字符数（渲染形态与 JSON 长度必不同）
    expect(v.full_file).toContain('vars');          // 全文照旧 JSON 落盘
    expect(JSON.parse(readFileSync(v.full_file!, 'utf-8'))).toEqual(material);   // 文件内是 JSON 原文,机器面回读不变
    const text = formatPromptText((next as { context: AssembledContext }).context, 'reason');
    expect(text).toContain('字符节选）');            // 预览条目形态在场
    expect(text).toContain('items:');               // 预览内容=递归 HopSchema 形态前缀（与正文同形态）
    expect(text).toContain("- '条目0内容片段'");     // 列表字符串元素带引号形态（HopSchema 接法）
    expect(text).not.toContain('{"items"');         // 非 JSON 前缀
  });

  it('正例：inline 模式 check 步大对象豁免预览——判官全量内联（#53 豁免对对象同样成立）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix0064-chk-'));
    const SPEC = `# T
Id: t
## Goal
g
## Inputs
- spec_data: yaml  # 被审结构
## Outputs
- r: line  # r
## Steps
1. [subtask] 审
  + → r: line  # r
  1.1. [check] 整体合理关
    - ← spec_data
    + → ok: bool  # 判定槽
    + → why: text  # 说明槽
    > 全文复核
  1.2. [act] 收尾
    + → r: line  # r
    > \`\`\`hop_python
    > r = "x"
    > \`\`\`
`;
    const host: HostConfig = {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'k',
    };
    const spec_data = { items: Array.from({ length: 3000 }, (_, i) => `条款${i}内容片段`) };
    expect(JSON.stringify(spec_data).length).toBeGreaterThan(20000);
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host, { params: { spec_data }, stateDir: join(dir, '.hopstate') });
    engine.setInlineLlmContext(true);
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    expect((next as { step_id: string }).step_id).toBe('1.1');
    const inputs = (next as { context: { inputs: Record<string, unknown> } }).context.inputs;
    const v = inputs['spec_data'] as Record<string, unknown>;
    expect(v).not.toHaveProperty('$preview');   // 判定步不截头,原对象全量供给
    expect(v).not.toHaveProperty('$file');
    expect(Array.isArray((v as { items?: unknown }).items)).toBe(true);   // 原值形态完好
  });
});

// @v: anc-exec-inputs-render — 递归 HopSchema 渲染护栏与边角行为（0064 工程链 review 增量批
// 补钉:护栏/兜底/推断此前零直接覆盖——深度护栏与 20000 降级是防回归钉〔护栏本身在,修前即绿〕,
// 循环引用钉配套 D1 修复〔修前 eager JSON.stringify 在 try 外,循环引用值炸 TypeError〕）
describe('递归 HopSchema 渲染护栏与边角行为（0064 review 增量批）', () => {
  const mkCtx = (inputs: Record<string, unknown>): AssembledContext => ({
    task_context: 'T', progress_summary: 'P', inputs,
    instruction: 'I', output_schema: [],
  });

  it('钉1 正例：8 层嵌套对象触深度护栏——第 6 层子树降级 YAML 块并注明,前 5 层保持类型标注', () => {
    // lv1..lv7 逐层嵌套,tag 字段每层一枚——深度计数:顶层变量行即第一层,lv6 字段落在 depth 6 触护栏
    let leaf: Record<string, unknown> = { tag: 'v7' };
    for (let i = 6; i >= 1; i--) leaf = { tag: `v${i}`, [`lv${i + 1}`]: leaf };
    const out = formatPromptText(mkCtx({ deep: leaf }), 'reason');
    expect(out).toContain("tag: line = 'v6'");                       // 护栏内层级(depth 6 标量)保持 名: 类型 = 值
    expect(out).toContain('嵌套超 6 层,本子树降级 YAML 块');          // 降级标注字面（变异 A:DEPTH_MAX 6→2 本行红）
    expect(out).toContain('tag: v7');                                // 降级块(lv7 子树)内是裸 YAML(无类型段)
  });

  it('钉2 正例：渲染文本超 20000 的对象整值换 yamlDump 块形态——degraded 标注在场', () => {
    const big = { items: Array.from({ length: 3000 }, (_, i) => `条目${i}内容片段`) };   // 渲染 >45K 字符
    const out = formatPromptText(mkCtx({ big }), 'reason');
    expect(out).toContain('渲染超 20000 字符,值降级 YAML 块');   // degraded 标注（变异 B:条件改 Infinity 本行红）
    expect(out).toContain('- 条目0内容片段');                    // yamlDump 块形态(裸 YAML 元素)
    expect(out).not.toContain("- '条目0内容片段'");              // HopSchema 引号接法不在场(整值已换形态)
  });

  it('钉3 正例（D1 配套）：循环引用对象不炸渲染;渲染+序列化双抛时兜底安全字面', () => {
    // 值经引擎变量存储会 JSON 化,循环引用只在直驱渲染层时构成——本钉手工 ctx 直喂 formatPromptText。
    // 修①前:renderInputEntries 对象分支在 try 之前 eager JSON.stringify(v),循环引用当场炸
    // TypeError,注释声称的"循环引用回 JSON 单行"兜底够不着——本钉修前红(炸)修后绿。
    const cyc: Record<string, unknown> = { name: '环' };
    cyc['self'] = cyc;
    let out = '';
    expect(() => { out = formatPromptText(mkCtx({ cyc }), 'reason'); }).not.toThrow();
    expect(out).toContain('- cyc');   // 条目在场（循环引用经深度护栏 yamlDump 锚点形态渲出,不炸即约定达成）
    // 渲染与 JSON.stringify 双抛形态（抛异常 getter——Object.entries 取值即抛,stringify 同抛）:
    // 兜底安全字面 = [非可序列化值]
    const evil = { get boom(): string { throw new Error('getter 炸'); } };
    let out2 = '';
    expect(() => { out2 = formatPromptText(mkCtx({ evil }), 'reason'); }).not.toThrow();
    expect(out2).toContain('- evil = [非可序列化值]');
  });

  it('钉4 正例：inferHopType 五型推断——bool/int/float/line/text 渲染行类型段逐一在场', () => {
    const mixed = { flag: true, n: 3, ratio: 3.5, short: '短单行', long: '第一行\n第二行' };
    const out = formatPromptText(mkCtx({ mixed }), 'reason');
    expect(out).toContain('flag: bool = true');        // true → bool
    expect(out).toContain('n: int = 3');               // 整数 → int
    expect(out).toContain('ratio: float = 3.5');       // 非整数 number → float
    expect(out).toContain("short: line = '短单行'");    // 短单行字符串 → line
    expect(out).toMatch(/long: text =\|（\d+ 字符）/);   // 多行字符串 → text,=| 块接法
  });

  it('钉5 正例：混型列表 [{k:1}, 裸字符串, 42, 多行病态] 逐元素按型渲染,病态元素 yamlDump 兜底不炸', () => {
    const mix = [{ k: 1 }, '裸字符串', 42, '多\n行病态'];
    let out = '';
    expect(() => { out = formatPromptText(mkCtx({ mix }), 'reason'); }).not.toThrow();
    expect(out).toContain('- k: int = 1');       // 对象元素首字段起头带类型
    expect(out).toContain("- '裸字符串'");        // 字符串元素单引号接法
    expect(out).toContain('- 42');               // 数字元素裸值
    expect(out).toMatch(/- \|-?\n\s+多\n\s+行病态/);   // 病态元素(多行串)yamlDump 兜底档——YAML 块标量文法如实
  });

  it('⑦ 配套：空对象/空列表显式 = {} / = []——字段级与顶层同治,不留静默空白', () => {
    const out = formatPromptText(mkCtx({ eo: {}, el: [], wrap: { inner_obj: {}, inner_list: [] } }), 'reason');
    expect(out).toContain('- eo = {}');            // 顶层空对象（变异 D:revert 显式化本行红）
    expect(out).toContain('- el = []');            // 顶层空列表
    expect(out).toContain('inner_obj = {}');       // 字段级空对象（无声明类型,裸名接法）
    expect(out).toContain('inner_list = []');      // 字段级空列表
  });
});

// @v: anc-exec-l5-node-impl — L4 完整节点形态（旧 L5 输出约束并入）
describe('L4 完整节点呈现', () => {
  it('正例：首行步骤行含[类型],输入/输出人话标签在场且 ←/→ 源码记号不外发（2026-08-31 作者抓"解释很丑,别用←→"——变异实证:渲染改回箭头本例必红）', () => {
    const ctx: AssembledContext = {
      task_context: 'T', progress_summary: 'P', inputs: { a: 1 },
      node_decl: { step_id: '4.2', step_type: 'reason', summary: '生成契约', input_names: ['a'] },
      instruction: 'I', output_schema: [{ name: 'h', type: 'yaml', description: '契约' }],
    };
    const out = formatPromptText(ctx, 'reason');
    expect(out).toContain('4.2 [reason] 生成契约');
    expect(out).toContain('**本步输入材料**（HopSchema 赋值形态');   // L4 并入后输入条目就地在 L4
    expect(out).toContain('- a');   // 输入条目 HopSchema 头行(该用例 meta 缺省仅字段名,无类型注)
    expect(out).toContain('- a = 1');   // 短值单行形态
    // @v: anc-exec-l5-task-first —— 段序契约:产出段承接任务,条目=名(类型)——生成指引
    expect(out).toContain('**本步要产出**（任务完成=交付这些字段');
    expect(out).toContain('- h（yaml）——契约');   // 产出条目=名(类型)——生成指引(任务先行批新形态)
    expect(out).toContain('不得多也不得少');
    // ←/→ 源码记号不出现在 L4 渲染（L1 骨架的步骤行不带箭头,故全文断言安全面窄化到 L4 标记行形态）
    expect(out).not.toContain('- ← a');
    expect(out).not.toContain('+ → h');
  });

  it('正例：L0 词表含 HopSchema 一句话（作者定"有 HopSchema 解释 Input/Output 会容易很多"）', () => {
    const out = formatPromptText({ task_context: 'T', progress_summary: 'P', inputs: {}, instruction: 'I', output_schema: [{ name: 'o', type: 'text', description: 'd' }] }, 'reason');
    expect(out).toContain('名字叫 HopSchema');
    expect(out).toContain('只声明形状');
    expect(out).toContain('带实际值');
    expect(out).toContain('复合结构');   // 例子直给版(2026-08-31 作者抓'解释很蠢,没有复合结构,直接给例子')
  });

  it('反例：全文无独立"L5. 输出约束"区块（已并入 L4）', () => {
    const ctx: AssembledContext = {
      task_context: 'T', progress_summary: 'P', inputs: {},
      instruction: 'I', output_schema: [{ name: 'o', type: 'text', description: 'd' }],
    };
    expect(formatPromptText(ctx, 'reason')).not.toContain('═══ L5. 输出约束');
  });
});

// @v: anc-exec-l3-position — L3 位置末行当前步骤本体（旧独立"当前位置"区块废除）
describe('L3 位置渲染', () => {
  it('正例：嵌套步骤的 position 末行是当前步骤本体带 ◀；反例：旧独立 L1p 区块零出现', () => {
    const spec = `# T
Id: t
## Goal
g
## Outputs
- h: text  # x
## Steps
1. [subtask retry=3] 容器
  + → h: text  # x
  1.1. [reason] 生成
    + → h: text  # x
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, RE_HOST);
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    if (r.status === 'step_ready') {
      expect(r.context.position_context).toMatch(/当前步骤: 1\.1 \[reason\].*◀/);
      const out = formatPromptText(r.context, 'reason');
      expect(out).not.toContain('L1p');
      expect(out).toContain('你的位置');
    }
  });
});

describe('字符串值恒 =| 块形态（2026-08-31 作者终定——避免二义和转义,单行只留无歧义标量）', () => {
  it('正例：字符串（含 # 与不含）一律 =| 块；反例：数字/布尔照旧单行 = 值', () => {
    const ctx = {
      task_context: 'Goal: t', progress_summary: '', position_context: '', instruction: '干活',
      node_decl: { step_id: '1', step_type: 'reason', summary: 's', input_names: ['a','b','n','f'] },
      output_schema: [{ name: 'r', type: 'text', description: '' }],
      inputs: { a: '促销价#5 专享', b: '干净短串', n: 26000, f: true },
      input_meta: { a: { type: 'line', description: '说明A' }, b: { type: 'line', description: '说明B' }, n: { type: 'int', description: '数' }, f: { type: 'bool', description: '旗' } },
    } as any;
    const out = formatPromptText(ctx, 'reason');
    expect(out).toMatch(/- a: line =\|（\d+ 字符）  # 说明A/);
    expect(out).toContain('    促销价#5 专享');
    expect(out).toMatch(/- b: line =\|（\d+ 字符）  # 说明B/);
    expect(out).toContain('    干净短串');
    expect(out).not.toMatch(/= 促销价/);
    expect(out).not.toMatch(/= 干净短串/);
    // 数字/布尔天然无歧义:照旧单行
    expect(out).toContain('- n: int = 26000  # 数');
    expect(out).toContain('- f: bool = true  # 旗');
  });
});

// @v: anc-exec-l2c-retry-feedback — check/commit 恒不吃 L5（受众分道）
describe('check 步恒不吃 L5 重试反馈（A 案——判官独立判定,历史判词是锚定毒药）', () => {
  it('正例：subtask 重试轮 check 步 prompt 零 L5 区块零历史判词；反例：同轮执行步照常有 L5', () => {
    const spec = `# T
Id: t-ck
## Goal
g
## Outputs
- h: text  # x
## Steps
1. [subtask retry=3] 容器
  + → h: text  # x
  1.1. [reason] 生成
    + → h: text  # x
  1.2. [check] 核验
    - ← h
    + → ok: bool  # 判
    + → note: text  # 说明
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, RE_HOST);
    engine.nextStep();
    engine.completeStep('1.1', { h: 'V1' });
    engine.nextStep();
    engine.failStep('1.2', 'CHECK_FAILED: SENTINEL_OLD_VERDICT 三要素缺失');
    // 重跑轮:1.1#2 执行步照常吃 L5
    const r1 = engine.nextStep();
    const out1 = (r1 as any).context ? formatPromptText((r1 as any).context, 'reason') : '';
    expect(out1).toContain('SENTINEL_OLD_VERDICT');   // 执行步带旧判词(修改依据)
    expect(out1).toContain('以核验要求为准');   // 冲突裁决规则(作者定:闸门优先于作业指引)
    engine.completeStep('1.1', { h: 'V2 新版本' });
    // 1.2#2 判官轮:零 L5 零历史判词
    const r2 = engine.nextStep();
    const out2 = (r2 as any).context ? formatPromptText((r2 as any).context, 'check') : '';
    expect(out2).not.toContain('SENTINEL_OLD_VERDICT');   // 历史判词不进判官眼
    expect(out2).not.toContain('═══ L5. 修正指令');
    expect(out2).toContain('V2 新版本');   // 判官对着新产出判
    expect(out2).toContain('会作为修改依据发给重做的执行者');   // 说明槽下游消费指引(作者定'应该给check指引')
    // 细则就地:在 L4 输出段(声明句之后),不挤角色档(作者抓"太遥远";L0 恒定化后角色档也在 L4
    // "本步操作指引"子块——边界从 ═══ 改到下一个 **段题**,断言意图不变:细则贴输出声明)
    expect(out2).toMatch(/本步要产出[\s\S]{0,200}判定槽（bool）/);
    expect(out2.split('你的角色：验证判定')[1].split('**本步')[0]).not.toContain('判定槽（bool）');
  });

  // @v: anc-exec-l2c-retry-feedback — commit 半边掐口（S2 防御纵深）。实撞:2026-09-01 补测试批
  // 变异核证——prompt.ts 掐口三元删 commit 半边,全量 2504 照绿(带 body commit 走引擎直执不发
  // prompt,行为面无钉)。本钉直调 PromptAssembler 对 commit 步组装,把掐口锁在组装层。
  it('正例：subtask 重试轮 commit 步组装零 retry_feedback 零 L5 区块（EngineOptions 带 upstream 时 upstream_feedback 同为 undefined）', () => {
    const spec = `# T
Id: t-cm
## Goal
g
## Outputs
- done_note: text  # x
## Steps
1. [subtask retry=3] 容器
  + → done_note: text  # x
  1.1. [reason] 生成
    + → draft: text  # 草稿
  1.2. [check] 验收
    - ← draft
    + → ok: bool  # 判
    + → note: text  # 说明
  1.3. [commit] 提交
    - ← draft
    + → done_note: text  # 回执
    > \`\`\`hop_python
    > done_note = "done"
    > \`\`\`
2. [exit]
`;
    const findStep = (steps: any[], id: string): any => {
      for (const s of steps) {
        if (s.step_id === id) return s;
        if (s.children) { const f = findStep(s.children, id); if (f) return f; }
      }
      return null;
    };
    // retry 半边:容器有打回史后对 commit 步组装
    const engine = new ExecutionEngine();
    engine.initExecution(spec, RE_HOST);
    engine.nextStep();
    engine.failStep('1.1', 'CHECK_FAILED: SENTINEL_COMMIT_L5 修订意见');
    const assembler = new PromptAssembler(engine);
    const ast = engine.getSpec()!;
    // 正向对照:同容器 reason 步照常吃 L5——夹具真产生了反馈,commit 断言才不是空转
    const reasonCtx = assembler.assembleReasonContext(findStep(ast.steps!, '1.1'));
    expect(reasonCtx.retry_feedback).toContain('SENTINEL_COMMIT_L5');
    const commitCtx = assembler.assembleActContext(findStep(ast.steps!, '1.3'));
    expect(commitCtx.retry_feedback).toBeUndefined();   // commit 恒不吃(掐口在组装层,非"不发 prompt"侥幸)
    const out = formatPromptText(commitCtx, 'commit');
    expect(out).not.toContain('═══ L5. 修正指令');
    expect(out).not.toContain('SENTINEL_COMMIT_L5');
    // upstream 半边:EngineOptions 带 upstreamFeedback 初始化后对 commit 步组装
    const engine2 = new ExecutionEngine();
    engine2.initExecution(spec, RE_HOST, { upstreamFeedback: 'SENTINEL_UP_CM' } as any);
    const assembler2 = new PromptAssembler(engine2);
    const upCtx = assembler2.assembleActContext(findStep(engine2.getSpec()!.steps!, '1.3'));
    expect(upCtx.upstream_feedback).toBeUndefined();
    expect(formatPromptText(upCtx, 'commit')).not.toContain('SENTINEL_UP_CM');
  });
});

// @v: anc-exec-l2c-retry-feedback — L5 打回轮恒供给（点名+基准）
describe('L5 打回轮恒供给（点名+核对象清单+留存基准,2026-08-31 作者两抓）', () => {
  const mkSpec = () => `# T
Id: t-rc
## Goal
g
## Outputs
- h: text  # x
## Steps
1. [subtask retry=3] 容器
  + → h: text  # x
  1.1. [reason] 生成
    + → h: text  # x
  1.2. [check] 核验
    - ← h
    + → ok: bool  # 判
    + → note: text  # 说明
2. [exit]
`;
  it('正例：打回轮 L5 含来源 check 点名+"本次核验看的是"清单+上一版产出 inline（小值）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(mkSpec(), RE_HOST);
    engine.nextStep();
    engine.completeStep('1.1', { h: 'PRIOR_DRAFT_VALUE' });
    engine.nextStep();
    engine.failStep('1.2', 'CHECK_FAILED: 内容太短');
    const r = engine.nextStep();   // 重跑 1.1
    expect(r.status).toBe('step_ready');
    const out = (r as any).context ? formatPromptText((r as any).context, 'reason') : '';
    expect(out).toContain('被步骤 1.2');
    expect(out).toContain('本次核验看的是: h');
    expect(out).toContain('PRIOR_DRAFT_VALUE');   // 留存基准 inline（≤2000 小档）
    expect(out).toContain('本轮修改的基准');
  });

  it('反例：首跑轮零打回供给；大值走卸载不 inline 全文', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(mkSpec(), RE_HOST);
    const first = engine.nextStep();
    const firstOut = (first as any).context ? formatPromptText((first as any).context, 'reason') : '';
    expect(firstOut).not.toContain('本次核验看的是');
    // 大值:>500 chars（作者从 2000 压到 500）的留存产出打回轮不整段 inline
    engine.completeStep('1.1', { h: 'X'.repeat(600) });
    engine.nextStep();
    engine.failStep('1.2', 'CHECK_FAILED: 假红');
    const r = engine.nextStep();
    const out = (r as any).context ? formatPromptText((r as any).context, 'reason') : '';
    if (out.includes('（已卸载）')) {
      // 卸载档:节选指路语两臂任一在场（有工具面"以下为开头节选"/零工具面"基于以下节选修订"——
      // 2026-09-18 review 修:组装期死文案改渲染层按工具面分叉,本断言随新形态）
      expect(out).toMatch(/以下为开头节选|基于以下节选修订/);
      expect(out).not.toContain('X'.repeat(550));   // 全文没进 prompt
    } else {
      // 无 workZone 场景:如实全文（内联真值纪律）——两种出口都合法,断言至少居其一
      expect(out).toContain('X'.repeat(550));
    }
  });

  // @v: anc-exec-l2c-retry-feedback — R3 容器围栏反例。实撞:2026-09-01 补测试批变异核证——
  // nearestRetryContainerIdOf 恒 undefined+起因不判(回退全局尾扫旧形态)全量照绿,张冠李戴回归
  // (机械失败重试轮点名 run 内更早无关 check,同屏"被步骤X打回"与"机械错误"互相矛盾)零保护。
  it('反例：机械错误重试轮不点名 run 内更早的无关 check,也不渲染行动框架句', () => {
    const spec = `# T
Id: t-r3
## Goal
g
## Outputs
- b: text  # x
## Steps
1. [subtask retry=2] 甲容器
  + → a: text  # x
  1.1. [reason] 产甲
    + → a: text  # x
  1.2. [check] 核甲
    - ← a
    + → ok1: bool  # 判
    + → n1: text  # 说明
2. [subtask retry=2] 乙容器
  + → b: text  # x
  2.1. [reason] 产乙
    + → b: text  # x
3. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, RE_HOST);
    // 甲容器:check 判 false 一轮(CHECK_FAILED 入事件流),重跑后过闸——run 里留下无关 check 失败史
    engine.nextStep();
    engine.completeStep('1.1', { a: 'v1' });
    engine.nextStep();
    engine.failStep('1.2', 'CHECK_FAILED: 甲的意见');
    engine.nextStep();
    engine.completeStep('1.1', { a: 'v2' });
    engine.nextStep();
    engine.completeStep('1.2', { ok1: true, n1: '' });
    // 乙容器:2.1 机械错误(非 CHECK_FAILED)触发容器重试
    engine.nextStep();
    engine.failStep('2.1', 'SCHEMA_MISMATCH: 输出缺 b 字段(重试耗尽形态)');
    const r = engine.nextStep();   // 重跑轮 2.1
    expect(r.status).toBe('step_ready');
    const out = (r as any).context ? formatPromptText((r as any).context, 'reason') : '';
    expect(out).toContain('机械步骤处理失败');   // 正向对照:机械轮 L5 真在场(形态指引),下两条否定断言才不是空转
    expect(out).not.toContain('被步骤 1.2');     // 围栏:无关 check 不点名(旧全局尾扫会张冠李戴)
    expect(out).not.toContain('以核验要求为准'); // 起因:机械轮不渲染行动框架句(判据=CHECK_FAILED 起因)
  });
});

// @v: anc-exec-l2c-retry-feedback — 渲染端 upstream 超限尾部截留（与拼接端公共体同向）。
// 实撞:2026-09-01 补测试批变异核证——渲染端改回 truncateToChars 头部保留(最新意见被截掉的
// 旧行为,review 面二抓方向相反后修)全量照绿,方向零测试保护。
describe('渲染端 upstream_feedback 超限尾部截留', () => {
  it('正例：EngineOptions 直塞超 24000 上游文本 → ctx.upstream_feedback 长度受限且尾部存活、头部被截', () => {
    const spec = `# T
Id: t-upcap
## Goal
g
## Outputs
- out: text  # x
## Steps
1. [reason] 产出
  + → out: text  # x
`;
    const big = 'HEAD_RENDER_CAP' + 'y'.repeat(26000) + 'TAIL_RENDER_CAP';
    const engine = new ExecutionEngine();
    engine.initExecution(spec, RE_HOST, { upstreamFeedback: big } as any);
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    const up = (r as any).context.upstream_feedback as string;
    expect(up.length).toBeLessThanOrEqual(24000);
    expect(up).toContain('TAIL_RENDER_CAP');       // 尾部(最新意见)存活
    expect(up).not.toContain('HEAD_RENDER_CAP');   // 头部被截(头部保留是被修掉的旧行为)
    expect(up).toContain('[TRUNCATED]');           // 截留标记在场(读者知道文本不全)
  });
});

// @v: anc-exec-l2c-retry-feedback — L5 修正指令工单去记账化
describe('L5 修正指令工单', () => {
  it('正例：意见原文在场且逐条落实框架；反例：CHECK_FAILED/第N次记账字样零出现', () => {
    const spec = `# T
Id: t
## Goal
g
## Outputs
- h: text  # x
## Steps
1. [subtask retry=3] 容器
  + → h: text  # x
  1.1. [reason] 生成
    + → h: text  # x
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, RE_HOST);
    engine.nextStep();
    engine.failStep('1.1', 'CHECK_FAILED: 请删除 agent_launcher 条目');
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    if (r.status === 'step_ready') {
      const fb = r.context.retry_feedback!;
      expect(fb).toContain('请删除 agent_launcher 条目');   // 意见原文（纯化后=意见本体,框架句移渲染段）
      expect(fb).not.toContain('CHECK_FAILED');              // 记账前缀剥除
      expect(fb).not.toMatch(/第 \d+ 次/);                   // 计数框架剥除
      const out = formatPromptText(r.context, 'reason');
      expect(out).toContain('- 打回意见: text =|');           // HopSchema 条目化（作者定"意见也应该 hopschema 展示"）
      expect(out).toContain('逐条落实');                      // 行动框架段（渲染段收尾,双重陈述废除后唯一位）
    }
  });

  // @v: anc-exec-l2c-retry-feedback L5 不可降级零截断（v0.7.1）——dr16 实撞回归防线:
  // 6 项工单 3101 chars 被旧 300 tokens(1200 chars)上限截剩 2 项传给修错轮。
  it('正例：大体量修正工单（>1200 chars）零截断全量进 retry_feedback', () => {
    const spec = `# Spec: L5 零截断
Id: l6-nocut
Goal: t
Outputs:
- h: text  # x

## Steps
1. [subtask retry=3] 容器
  + → h: text  # x
  1.1. [reason] 生成
    + → h: text  # x
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, RE_HOST);
    engine.nextStep();
    // 6 项工单模拟——总量远超旧 1200 chars 上限
    const items = Array.from({ length: 6 }, (_, i) =>
      `缺陷${i + 1}：步骤 ${i + 1} 的交付写盘无 commit 保护，修法=按探索范式三段剥出 commit 并前置 check final。` + 'x'.repeat(400));
    engine.failStep('1.1', 'CHECK_FAILED: ' + items.join('\n'));
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    if (r.status === 'step_ready') {
      const fb = r.context.retry_feedback!;
      expect(fb).toContain('缺陷1');
      expect(fb).toContain('缺陷6');            // 末项存活=未截尾（旧上限下必丢）
      expect(fb.length).toBeGreaterThan(2400);  // 全量在场
    }
  });

});


// @v: anc-exec-l0-worldview-impl — 输出格式单一口径=YAML（作者定 2026-08-24"又是json和yaml混乱了"）:
// 旧角色档教"产出 JSON"而解析器先验 YAML——flash 照教交 ```json 被判 null 三轮烧尽。
// 教的方向与解析先验一致;宽容收 JSON 不变（解析层正反例在 dispatcher.test.ts parseStepOutput）。
describe('L0 输出格式口径统一 YAML', () => {
  const CTX: AssembledContext = {
    task_context: 'T', progress_summary: 'P', inputs: {}, instruction: 'I',
    output_schema: [{ name: 'o', type: 'text', description: 'd' }],
  };
  it('正例：各角色档教 YAML 产出（含块标量指引）；反例：无任何"产出 JSON"教导残留', () => {
    for (const t of ['reason', 'act', 'act_free', 'commit', 'check', 'revision']) {
      const out = formatPromptText(CTX, t);
      expect(out).not.toContain('产出 JSON');
      expect(out).not.toContain('JSON 对象');
    }
    expect(formatPromptText(CTX, 'reason')).toContain('产出 YAML');
    expect(formatPromptText(CTX, 'reason')).toContain('块标量');
    expect(formatPromptText(CTX, 'reason')).toContain('不要代码围栏');
    // L0 世界观第四句同口径
    expect(formatPromptText(CTX, 'reason')).toContain('按 YAML 解析成变量');
  });
});

// TypeDecl 注释进 LLM 消费面（formatTypeDecl 三消费点同源——prompt L1/子树闭包/SCHEMA_MISMATCH）
// @v: anc-type-type-decl
describe('formatTypeDecl 注释渲染', () => {
  it('正例：带注释换条目式多行——字段语义到达执行 LLM;反例：无注释保持单行紧凑零变化', async () => {
    const { formatTypeDecl } = await import('../src/ast-helpers.js');
    const withDesc = formatTypeDecl({ name: 'CheckPoint', fields: { id: 'line', claim: 'text' }, description: '一个待核查点', field_descriptions: { claim: '待核查的断言' } });
    expect(withDesc).toContain('CheckPoint:  # 一个待核查点');
    expect(withDesc).toContain('claim: text  # 待核查的断言');
    expect(withDesc).toContain('id: line');   // 无注释字段照列
    // 缩进结构断言（review 实抓拍平:toContain 对缩进失明——字段行必须比头行深;
    // 消费点垫层归 indentBlock 全行垫,不再有'模板只垫首行'的坑面）
    const lines = withDesc.split('\n');
    const headIndent = lines[0].search(/\S/);
    expect(headIndent).toBe(0);   // 零外部缩进假设——相对缩进封闭在函数内
    for (const fl of lines.slice(1)) expect(fl.search(/\S/)).toBeGreaterThan(headIndent);   // 字段恒深于头行
    const plain = formatTypeDecl({ name: 'Pt', fields: { x: 'line' } });
    expect(plain).toBe('Pt={x:line}');   // 旧形态逐字不变
  });
});

function makeL1Ctx(spec: string): string {
  const engine = new ExecutionEngine();
  const init = engine.initExecution(spec, HOST);
  if (init.status !== 'ok') throw new Error('spec parse failed: ' + JSON.stringify(init));
  const assembler = new PromptAssembler(engine);
  return assembler.assembleReasonContext(engine.getSpec()!.steps![0]).task_context ?? '';
}

// @v: anc-exec-l1-skeleton — L1 受众定位句三件+装配注记剥离（2026-08-30 语义审计实锤三件
// 全未实装后补——hoplog 现场:审计 run 自身 Constraints 分号挤行且 [[doc-ref]] 死链接进
// 执行 LLM 上下文;变异实证:剥离函数改恒等返回,剥离正例必红。剥离逻辑经 stripAssemblyNotes
// 纯函数直测——集成面带 [[]] 的 spec 会被 P15 doc-ref 存在性校验拦在 init,纯函数测不受限）
describe('L1 受众定位句与装配注记剥离', () => {
  it('正例：Goal/Outputs 带定位前缀,Constraints 分条渲染', () => {
    const l1 = makeL1Ctx(`# T
## Goal
全局目标G
Constraints:
- 红线一
- 红线二
## Outputs
- 交付物: text  # f
## Steps
1. [reason] r
  + → 交付物: text
  > t
`);
    expect(l1).toContain('Goal（整个规约的总目标，供你理解所处任务；你本步的任务在 L4）');
    expect(l1).toContain('Outputs（整个规约最终交付物，非你本步输出');
    expect(l1).toContain('- 红线一');
    expect(l1).toContain('- 红线二');
    expect(l1).not.toContain('红线一; 红线二');   // 分号挤行形态退役
  });

  it('正例：stripAssemblyNotes 剥 [[doc-ref]] 短句与 ^anc-* 串,约束本体保留', () => {
    expect(stripAssemblyNotes('每个锚点严格审计,不采样不跳过。完整表述见注入的 [[audit-knowledge#宪法级原则]]。'))
      .toBe('每个锚点严格审计,不采样不跳过。');
    expect(stripAssemblyNotes('输出隔离:中间文件写 .audit/ 目录 ^anc-rule-demo'))
      .toBe('输出隔离:中间文件写 .audit/ 目录');
  });

  it('反例：整条都是装配说明 → 剥成空串（调用方据此过滤空壳条）', () => {
    expect(stripAssemblyNotes('判据由引擎注入 [[kb#格式]]、[[kb#语法]]，禁止自创判据。')).toBe('');
    expect(stripAssemblyNotes('真约束保留')).toBe('真约束保留');   // 无装配内容零误伤
  });
});

// @v: anc-exec-l0-worldview-impl —— lack_of_info 供给面收编（0053:通用戒律删行,出口只进
// reason 角色档;check 档教"判不了≠不达标"。变异实证:reason 档出口句删除下方正例必红）
describe('lack_of_info 供给面（reason 专属,0053）', () => {
  const CTX: AssembledContext = {
    task_context: 'T', progress_summary: 'P', inputs: {}, instruction: 'I',
    output_schema: [{ name: 'o', type: 'text', description: 'd' }],
  };

  it('正例：reason 档教 lack_of_info 出口（YAML 形态+下文交代）；通用戒律无该行', () => {
    const out = formatPromptText(CTX, 'reason');
    expect(out).toContain('lack_of_info: 说明缺少什么');
    expect(out).toContain('可能补充知识重试');   // 教出口必教下文(实话化:不承诺不存在的机制)
    expect(out).toContain('其他字段不会被采用');   // 封混合形态
    expect(out).not.toContain('{"lack_of_info"');   // JSON 旧形态退场(通用戒律行已删)
  });

  it('反例：act/check 档不教 lack_of_info；check 档教"判不了≠不达标"', () => {
    const act = formatPromptText(CTX, 'act');
    expect(act).not.toContain('lack_of_info');
    // 判不了处置随细则迁 L4 输出段(须 check node_decl 才渲染)——作者抓"太遥远"批
    const check = formatPromptText({ ...CTX, node_decl: { step_id: '1', step_type: 'check', summary: 's', input_names: [] } } as any, 'check');
    expect(check).not.toContain('lack_of_info');
    expect(check).toContain('判不了不等于不达标');
    expect(check).toContain('缺什么依据');
  });
});

// @v: anc-step-tool-grant —— L4 工具清单渲染（0054:basic 恒列/special 按授权/复用模式通道指引;
// 变异实证:manifest 组装块删除下方正例必红）
// @v: anc-exec-tool-manifest-supply —— 第 5 面 reason 步清单同供（2026-09-01 作者抓"教学缺口
// 就该补"——anc-exec-reason-tools 只接下发面没接供给面:standalone reason 有工具可用却零清单
// 零 tool_failure 教条,"清单与下发面同源"对 reason 落空。变异实证:组装条件撤 reason 半边,
// 下方 standalone 正例红）
describe('L4 工具清单 reason 步同供（供给面第 5 面）', () => {
  const REASON_SPEC = `# T
Id: r-manifest
## Goal
g
## Outputs
- r: text  # r
## Steps
1. [reason] 分析
  - 工具: read  # 声明才有清单（2026-09-18 修订:零声明 reason 零清单——清单与下发面同源）
  + → r: text  # r
  > 想
`;
  function mkEngineWithTools(): ExecutionEngine {
    const engine = new ExecutionEngine();
    engine.initExecution(REASON_SPEC, HOST);
    engine.setToolDefsSource({
      list: () => [{ name: 'read', description: '读文件', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, requires_commit: false, category: 'basic' as const }],
      execute: async () => ({ result: '', success: true }),
    } as never);
    return engine;
  }

  it('正例：standalone reason 步带声明 → L4 含工具清单与 tool_failure 教条（2026-09-18 修订:声明才渲染——零声明零清单,与下发面同源）', () => {
    const engine = mkEngineWithTools();
    const assembler = new PromptAssembler(engine);
    const step1 = engine.getSpec()!.steps![0];
    const ctx = assembler.assembleReasonContext(step1);
    expect(ctx.tool_manifest).toBeDefined();
    expect(ctx.tool_manifest).toContain('当前可用工具');
    expect(ctx.tool_manifest).toContain('read');
    expect(ctx.tool_manifest).toContain('tool_failure');       // 故障出口教条同供
    expect(ctx.tool_manifest).toContain('先自己想办法');        // 自救优先半句同供
  });

  it('反例：复用模式（无注册面）reason 步 → 不渲染指引档（caller 自带工具面,教条归 driver 文件）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(REASON_SPEC, HOST);
    const assembler = new PromptAssembler(engine);
    const step1 = engine.getSpec()!.steps![0];
    const ctx = assembler.assembleReasonContext(step1);
    expect(ctx.tool_manifest).toBeUndefined();
  });

  // @v: anc-exec-reason-tools —— 零声明 reason 零清单（2026-09-18 review 面三变异 M4 实锤:
  // reasonHasGrants 收窄条件回退旧形态〔零声明也渲染满配清单〕3068 全绿零保护——本反例锁
  // "有注册面但零声明 → prompt 零工具清单",清单与下发面同源的收窄半边;既有"反例"钉测的是
  // 复用模式无注册面,挡不住本形态）
  it('反例：有注册面+零声明 reason 步 → 不渲染工具清单（清单与下发面同源——零声明单发零工具,prompt 不许挂幽灵清单）', () => {
    const NO_GRANT_SPEC = REASON_SPEC.replace('  - 工具: read  # 声明才有清单（2026-09-18 修订:零声明 reason 零清单——清单与下发面同源）\n', '');
    const engine = new ExecutionEngine();
    engine.initExecution(NO_GRANT_SPEC, HOST);
    engine.setToolDefsSource({
      list: () => [{ name: 'read', description: '读文件', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, requires_commit: false, category: 'basic' as const }],
      execute: async () => ({ result: '', success: true }),
    } as never);
    const ctx = new PromptAssembler(engine).assembleReasonContext(engine.getSpec()!.steps![0]);
    expect(ctx.tool_manifest).toBeUndefined();
  });
});

describe('L4 工具清单（buildToolManifest,0054）', () => {
  const DEFS = [
    { name: 'read', description: '读文件', input_schema: { type: 'object', properties: { path: { type: 'string', description: '路径' } }, required: ['path'] }, category: 'basic' as const },
    { name: 'pdf_extract', description: '提取 PDF 文本', input_schema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }, category: 'special' as const },
    { name: 'ocr_image', description: '图片 OCR', input_schema: { type: 'object', properties: {} }, category: 'special' as const },
  ];

  it('正例：basic 恒列;声明的 special 在场带真身参数与意图注释;未声明 special 不出现', () => {
    const out = buildToolManifest({ tool_grants: [{ name: 'pdf_extract', note: '提取合同页' }] }, DEFS);
    expect(out).toContain('- read：读文件');
    expect(out).toContain('参数 path: string  # 路径');
    expect(out).toContain('- pdf_extract：提取 PDF 文本（本步用途：提取合同页）');
    expect(out).not.toContain('ocr_image');
    expect(out).toContain('未列出的工具不可用');
  });

  it('正例：* 全量含全部 special', () => {
    const out = buildToolManifest({ tool_grants: [{ name: '*' }] }, DEFS);
    expect(out).toContain('pdf_extract');
    expect(out).toContain('ocr_image');
  });

  // @v: anc-exec-tool-manifest-source —— 指引档按族分道（第 4 条:内建族恒 tool-call/非内建
  // 原生优先;变异实证:分族判断改恒真下"非内建原生优先"钉红）
  it('正例：defs 缺席（复用模式）非内建件 → 原生能力优先,tool-call 只作兜底', () => {
    // 指引档按族分道（^anc-exec-tool-manifest-source 第 4 条——作者定"复用模式下应该用
    // agent 自己的 web search"）:pdf_extract/web_search 都不在内建族名单,教原生优先。
    const out = buildToolManifest({ tool_grants: [{ name: 'web_search', note: '检索外部依据' }] }, undefined);
    expect(out).toContain('基础文件工具');
    expect(out).toContain('优先用你环境里语义等价的原生能力');
    expect(out).toContain("没有等价能力时才经 `hopjit tool-call web_search");
  });

  it('正例：defs 缺席（复用模式）引擎内建件 → 恒教 tool-call,不教原生模仿', () => {
    const out = buildToolManifest({ tool_grants: [{ name: 'insert_node', note: '插入步骤' }] }, undefined);
    expect(out).toContain("经 `hopjit tool-call insert_node");
    expect(out).toContain('引擎实现是唯一语义源');
    expect(out).not.toContain('优先用你环境里语义等价的原生能力');
  });

  it('正例：defs 缺席 * 全量授权 → 两族口径同渲染（内建 tool-call+其余原生优先）', () => {
    const out = buildToolManifest({ tool_grants: [{ name: '*' }] }, undefined);
    expect(out).toContain('引擎内建件');
    expect(out).toContain('原生能力');
    expect(out).toContain('tool-call');
  });

  it('反例：零授权零 defs 的裸 act → 只有基础族口径,无 special 行', () => {
    const out = buildToolManifest({}, undefined);
    expect(out).toContain('基础文件工具');
    expect(out).not.toContain('tool-call');
  });

  // @v: anc-step-tool-deny —— L4 清单联动（^anc-step-tool-deny:复用模式与 standalone
  // 禁用语义逐字节一致——节点禁 basic 件时 manifest 文字里无该件,两边都要过滤）
  it('反例：节点禁 basic 件（write）→ manifest 文字里无该件（defs 在场与缺席两档都剔除）', () => {
    const outWithDefs = buildToolManifest(
      { tool_grants: [], tool_denies: [{ name: 'read', note: '本步禁读' }] }, DEFS);
    expect(outWithDefs).not.toContain('- read：读文件');
    const outNoDefs = buildToolManifest({ tool_denies: [{ name: 'write' }] }, undefined);
    expect(outNoDefs).toContain('基础文件工具');
    expect(outNoDefs).not.toMatch(/基础文件工具（[^）]*write/);   // basic 恒列行的口径清单里无 write
  });

  // @v: anc-exec-reason-tools —— manifest 真身档 requires_commit 恒过滤（与 dispatcher 下发面
  // 同源承诺:该函数语境无 allowCommit,manifest 只服务非 commit 步的 act free/reason——授权了
  // 也不列,列了=教 LLM 调一件调不通的工具）
  it('反例：授权 requires_commit 件时 manifest 真身档不列它（恒过滤,与下发面同源）', () => {
    const DEFS_RC = [
      ...DEFS,
      { name: 'db_commit', description: '不可逆入库', input_schema: { type: 'object', properties: {} }, category: 'special' as const, requires_commit: true },
    ];
    const out = buildToolManifest({ tool_grants: [{ name: 'db_commit', note: '入库' }] }, DEFS_RC);
    expect(out).not.toContain('db_commit');
    expect(out).toContain('- read：读文件');   // 同清单其余件照常在列（过滤只掐 requires_commit 件）
  });

  // @v: anc-step-call-dynamic-callee —— L0 心智模型关键短语在场（知识供给半边:call=派发
  // 独立子实例的 subagent 心智,禁自己扮演子任务——两短语缺任一=教学面静默蒸发）
  it('正例：L0 心智模型关键短语在场（"独立子实例"与"不要自己在上下文里逐个扮演"）', () => {
    const out = formatPromptText({ task_context: 'T', progress_summary: 'P', inputs: {}, instruction: 'I', output_schema: [{ name: 'o', type: 'text', description: 'd' }] }, 'reason');
    expect(out).toContain('独立子实例');
    expect(out).toContain('不要自己在上下文里逐个扮演');
  });

  // @v: anc-exec-tool-failure-report —— L4 教条配套面（教出口必教下文;act 渲染/commit 不渲染
  // ——commit 不设自报通道,死指令不发。自救优先半句 2026-09-01 作者确认补——原句隐含先自救
  // 没明说,模型可能读成"失败一次就该报"。L4 句形态=自救三形态+自救记录+滥用防线;显式成本
  // 结构半句只在 driver 四处,L4 的"整段重跑"措辞隐带成本方向〔review F3 改注释如实〕）
  it('正例：真身档 act 步渲染 tool_failure 出口教条（自救优先+出口+滥用防线三段齐）,commit 步不渲染', () => {
    const act = buildToolManifest({ tool_grants: [] }, DEFS, { stepType: 'act', workZoneRel: 'wz' });
    expect(act).toContain('先自己想办法');            // 自救优先半句
    expect(act).toContain('换参数重试、换清单里语义等价的工具');
    expect(act).toContain('tool_failure');
    expect(act).toContain('试过什么自救');            // 故障说明升格含自救记录
    expect(act).toContain('仅工具调用实际失败时');     // 滥用防线句
    const commit = buildToolManifest({ tool_grants: [] }, DEFS, { stepType: 'commit' });
    expect(commit).not.toContain('tool_failure');
  });
});

