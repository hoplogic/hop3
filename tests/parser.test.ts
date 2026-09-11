// @module: spec-parser ^anc-struct-spec-parser
import { describe, it, expect } from 'vitest';
import { parseSpec, parseFragment, serializeSpec, convertSpecKeywords } from '../src/parser.js';
import { validateSpec } from '../src/validator.js';
import { isContainerStep, hasChildren, getChildren } from '../src/ast-helpers.js';
import type { CallStep, SubtaskStep, ReasonStep, LoopStep } from '../src/ast-types.js';

// ===== Minimal spec =====

const MINIMAL_SPEC = `# My Spec

## Steps
1. [reason] Analyze input
  - ← query
  + → result: text  # analysis result
  > Think carefully about the query
`;

// @v: anc-ast-spec-ast, anc-ast-spec-structure, anc-struct-spec-parser
describe('parseSpec', () => {
  // Tools 段真解析（^anc-rule-tools-section,概念 ^anc-tool-two-faces——interim 拦截随实装退役）
  // @v: anc-rule-tools-section, anc-tool-two-faces
  it('正例：Tools 段解析——签名/逐参数说明入结构/输出/notes 全收', () => {
    const md = `# T
Id: t
Goal: g

Tools:
- send_message(channel, content) -> message_id: line  # 发送清单到值班群
  - channel: line   # 目标频道标识——群 ID 不是群名
  - content: text   # 消息正文全文
  > 发送后撤不回;平台按 message_id 幂等
- web_search(query) -> results: yaml  # 行业对标搜索
  - query: line   # 搜索关键词

Outputs:
- r: text  # 出

## Steps
1. [reason] 想
  + → r: text  # 出
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.header.tools).toHaveLength(2);
    const sm = ast.header.tools![0];
    expect(sm.name).toBe('send_message');
    expect(sm.params).toEqual([
      { name: 'channel', type: 'line', description: '目标频道标识——群 ID 不是群名' },
      { name: 'content', type: 'text', description: '消息正文全文' },
    ]);
    expect(sm.output).toEqual({ name: 'message_id', type: 'line' });
    expect(sm.description).toBe('发送清单到值班群');
    expect(sm.notes).toContain('撤不回');
    expect(ast.header.tools![1].name).toBe('web_search');
  });

  it('反例：签名括号参数与子条目不一致 → parse error 点名缺/多的参数', () => {
    const md = `# T
Id: t
Goal: g

Tools:
- send_message(channel, content) -> message_id: line  # 发送
  - channel: line   # 频道

Outputs:
- r: text  # 出

## Steps
1. [reason] 想
  + → r: text  # 出
`;
    const { errors } = parseSpec(md);
    expect(errors.some(e => e.message.includes('签名参数与子条目不一致') && e.message.includes('content'))).toBe(true);
  });

  it('正例：Tools 段 serialize 往返保留（parse→serialize→parse 结构一致）', () => {
    const md = `# T
Id: t
Goal: g

Tools:
- send_message(channel) -> message_id: line  # 发送
  - channel: line   # 频道 ID
  > 撤不回

Outputs:
- r: text  # 出

## Steps
1. [reason] 想
  + → r: text  # 出
`;
    const first = parseSpec(md);
    expect(first.errors).toHaveLength(0);
    const written = serializeSpec(first.ast);
    const second = parseSpec(written);
    expect(second.errors).toHaveLength(0);
    expect(second.ast.header.tools).toEqual(first.ast.header.tools);
  });

  // @v: anc-exec-check-escalate —— 升层声明语言面（0006 批次一,概念 ^anc-step-check-escalatable）
  it('escalatable 正例：check 属性解析入 AST+serialize 回写+中文词可上升归一', () => {
    const md = `# E
Id: e
Goal: g
Outputs:
- r: text  # 出
## Steps
1. [subtask] 容器
  + → r: text  # 出
  1.1. [check escalatable] 收敛判定
    + → ok: bool  # 判定槽
    + → gap: yaml  # 缺口槽
    > 判
  1.2. [act] 干活
    + → r: text  # 出
    > 做
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const chk = (ast.steps![0] as SubtaskStep).children[0] as CheckStep;
    expect(chk.escalatable).toBe(true);
    const written = serializeSpec(ast);
    expect(written).toContain('[check escalatable]');
    // 中文词
    const zh = md.replace('[check escalatable]', '[检查 可上升]');
    const r2 = parseSpec(zh);
    const chk2 = (r2.ast.steps![0] as SubtaskStep).children[0] as CheckStep;
    expect(chk2.escalatable).toBe(true);
  });

  it('正例：无 Tools 段的 spec 零影响（向后兼容）', () => {
    const { ast, errors } = parseSpec(MINIMAL_SPEC);
    expect(errors.filter(e => e.message.includes('Tools'))).toHaveLength(0);
    expect(ast.header.tools).toBeUndefined();
  });

  // review D7：不合文法行响亮报错+真实行号（原实现:签名行不匹配静默跳过/行号恒报段头）
  it('D7 反例：签名行不合文法 → parse error 带该行真实行号,不静默丢', () => {
    const md = `# T
Id: t
Goal: g

Tools:
- broken tool no parens  # 缺括号的签名行

Outputs:
- r: text  # 出

## Steps
1. [reason] 想
  + → r: text  # 出
`;
    const { ast, errors } = parseSpec(md);
    const e = errors.find(x => x.message.includes('签名行不合文法'));
    expect(e).toBeDefined();
    expect(e!.line).toBe(6);   // 真实 1-based 行号（'- broken...' 所在行）,非段头行
    expect(ast.header.tools ?? []).toHaveLength(0);
  });

  it('D7 反例：参数条目不合文法 → parse error 带该行真实行号', () => {
    const md = `# T
Id: t
Goal: g

Tools:
- send_message(channel) -> message_id: line  # 发送
  - channel line 少了冒号

Outputs:
- r: text  # 出

## Steps
1. [reason] 想
  + → r: text  # 出
`;
    const { errors } = parseSpec(md);
    const e = errors.find(x => x.message.includes('参数条目不合文法'));
    expect(e).toBeDefined();
    expect(e!.line).toBe(7);
  });

  it('parses a minimal spec with title + 1 step', () => {
    const { ast, errors } = parseSpec(MINIMAL_SPEC);
    expect(errors).toHaveLength(0);
    expect(ast.header.title).toBe('My Spec');
    expect(ast.steps).toHaveLength(1);

    const step = ast.steps![0];
    expect(step.step_id).toBe('1');
    expect(step.step_type).toBe('reason');
    expect(step.summary).toBe('Analyze input');
    expect(step.inputs).toHaveLength(1);
    expect(step.inputs![0].name).toBe('query');
    expect(step.outputs).toHaveLength(1);
    expect(step.outputs![0]).toEqual({ name: 'result', type: 'text', description: 'analysis result' });
    expect(step.instruction).toBe('Think carefully about the query');
  });

  // @v: anc-ast-spec-header
  it('parses header with all sections', () => {
    const md = `# Full Spec
Id: full-spec

## Goal
Do everything

## Constraints
- Must be fast
- Must be correct

## Types
- SearchResult:
    query: text
    score: int

## Inputs
- query: text  # search query
- limit: int  # max results

## Outputs
- result: yaml  # final result
- status: line  # outcome

## Config
- max_depth: 5
- max_retries: 2

## Steps
1. [reason] Think
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.header.title).toBe('Full Spec');
    expect(ast.header.id).toBe('full-spec');
    expect(ast.header.goal).toBe('Do everything');
    expect(ast.header.constraints).toEqual(['Must be fast', 'Must be correct']);
    expect(ast.header.types).toHaveLength(1);
    expect(ast.header.types![0].name).toBe('SearchResult');
    expect(ast.header.types![0].fields).toEqual({ query: 'text', score: 'int' });
    expect(ast.header.inputs).toHaveLength(2);
    expect(ast.header.inputs![0]).toEqual({ name: 'query', type: 'text', description: 'search query' });
    expect(ast.header.outputs).toHaveLength(2);
    expect(ast.header.config).toEqual({ max_depth: 5, max_retries: 2 });
  });

  it('handles spec without Steps section (capability declaration)', () => {
    const md = `# Capability Spec

## Inputs
- data: yaml

## Outputs
- result: text  # processed result
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.header.title).toBe('Capability Spec');
    expect(ast.steps).toBeUndefined();
  });

  it('rejects input exceeding size limit', () => {
    // 阈值 100KB→1MB(hopissues/0080)——本钉体量随升,守的仍是"超限拒收"防御语义
    const huge = '# Title\n' + 'x'.repeat(1100 * 1024);
    const { errors } = parseSpec(huge);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/limit/i);
  });
});

// ===== Full spec with all 14 step types =====

const FULL_SPEC = `# Complete Spec
Id: complete

## Goal
Test all 14 step types

## Inputs
- data: text

## Outputs
- result: yaml  # final output
- status: line  # completion status

## Steps
1. [reason] Analyze the data
  - ← data
  + → analysis: text  # data analysis
  > Perform deep analysis

2. [act] Execute action
  - ← analysis
  + → action_result: yaml  # action output
  > Run the tool

3. [check] Verify results
  - ← action_result
  + → is_valid: bool  # validation result

4. [confirm] Get user confirmation
  + → approved: bool  # user decision

5. [commit] Execute irreversible operation
  + → approval: bool  # approval status
  > Delete all temporary data permanently

6. [call] child_spec : Execute sub-specification
  - ← analysis
  + → call_result: yaml  # sub-spec output

7. [branch] Route by analysis type
  7.1. [case] is_valid == true
    7.1.1. [act] Process valid result
      - ← action_result
      + → processed: text  # processed output
  7.2. [case] default
    7.2.1. [act] Handle invalid result
      + → processed: text  # fallback output

8. [subtask retry=2 adaptive] Complex subtask
  8.1. [reason] Plan approach
    + → plan: text
  8.2. [act] Execute plan
    - ← plan
    + → subtask_result: yaml

9. [subtask parallel] Run in parallel
  9.1. [act] Task A
    + → a_result: text
  9.2. [act] Task B
    + → b_result: text

10. [loop max_iterations=5] Iterate until done
  10.1. [check] Check completion
    + → done: bool
  10.2. [branch] Check if done
    10.2.1. [case] done == true
      10.2.1.1. [break]
    10.2.2. [case] default
      10.2.2.1. [act] Do more work
        + → progress: text
      10.2.2.2. [continue]

11. [exit]
`;

// @v: anc-ast-base-step, anc-ast-step-type, anc-step-reason, anc-step-act, anc-step-check, anc-step-confirm, anc-step-parallel, anc-step-continue, anc-step-exit
describe('parseSpec — full spec', () => {
  it('parses all 13 step types + parallel attr including nested case/break/continue', () => {
    const { ast, errors } = parseSpec(FULL_SPEC);
    expect(errors).toHaveLength(0);
    expect(ast.steps).toBeDefined();

    const topLevel = ast.steps!;
    expect(topLevel).toHaveLength(11);

    // Verify each top-level step type
    expect(topLevel[0].step_type).toBe('reason');
    expect(topLevel[1].step_type).toBe('act');
    expect(topLevel[2].step_type).toBe('check');
    expect(topLevel[3].step_type).toBe('confirm');
    expect(topLevel[4].step_type).toBe('commit');
    expect(topLevel[5].step_type).toBe('call');
    expect(topLevel[6].step_type).toBe('branch');
    expect(topLevel[7].step_type).toBe('subtask');
    expect(topLevel[8].step_type).toBe('subtask');   // v0.2.0:原 [parallel] 位已迁移为 [subtask parallel]
    expect((topLevel[8] as any).parallel).toBe(true);
    expect(topLevel[9].step_type).toBe('loop');
    expect(topLevel[10].step_type).toBe('exit');

    // Verify nested types: case, break, continue
    const branch = topLevel[6] as any;
    expect(branch.children[0].step_type).toBe('case');
    expect(branch.children[1].step_type).toBe('case');

    const loop = topLevel[9] as any;
    const innerBranch = loop.children[1] as any;
    expect(innerBranch.children[0].children[0].step_type).toBe('break');
    expect(innerBranch.children[1].children[1].step_type).toBe('continue');
  });

  // @v: anc-step-parallel
  it('parses subtask parallel (static parallel group, v0.2.0)', () => {
    const { ast } = parseSpec(FULL_SPEC);
    const parallel = ast.steps![8] as any;
    expect(parallel.step_type).toBe('subtask');
    expect(parallel.parallel).toBe(true);
    expect(parallel.children).toHaveLength(2);
    expect(parallel.children[0].step_type).toBe('act');
    expect(parallel.children[0].summary).toBe('Task A');
    expect(parallel.children[1].step_type).toBe('act');
    expect(parallel.children[1].summary).toBe('Task B');
  });

  // @v: anc-exec-parallel-foreach
  // @v: anc-step-parallel —— loop 头 parallel 废除（统一模型 P0.5，矩阵行 8）
  it('反例:loop 头 parallel → parse error 带迁移提示（不静默通过）', () => {
    const spec = `# For-each Parse Test
Id: fe-parse

## Goal
test

## Inputs
- items: [text]  # list

## Steps
1. [loop for-each item in items, parallel] Fan out
  + → result: [text]  # collected
  1.1. [subtask] One
    - ← item
    + → result: text
    1.1.1. [reason] Do
      - ← item
      + → result: text
      > do it
`;
    const { errors } = parseSpec(spec);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('已废除');
    expect(errors[0].message).toContain('subtask parallel');
  });

  it('正例:循环头无 parallel + 体内 subtask parallel 正常解析（迁移后写法）', () => {
    const spec = `# FE2
Id: fe2

## Goal
test

## Inputs
- items: [text]  # list

## Steps
1. [loop for-each item in items, collect result_item into result] Fan out
  + → result: [text]  # collected
  1.1. [subtask parallel] One
    + → result_item: text  # 单项
    1.1.1. [reason] Do
      - ← item
      + → result_item: text
      > do it
`;
    const { ast, errors } = parseSpec(spec);
    expect(errors).toHaveLength(0);
    const loop = ast.steps![0] as any;
    expect(loop.parallel).toBeUndefined();
    expect(loop.children[0].parallel).toBe(true);
  });

  // @v: anc-exec-parallel-foreach
  it('rejects legacy two-line for-each syntax with friendly error', () => {
    const spec = `# Legacy For-each Test
Id: fe-legacy

## Goal
test

## Inputs
- items: [text]  # list

## Steps
1. [subtask parallel] Fan out
  - ← items
  + → item
  for-each items → item
  + → result: [text]  # collected
  1.1. [subtask] One
    - ← item
    + → result: text
    1.1.1. [reason] Do
      - ← item
      + → result: text
      > do it
`;
    const { errors } = parseSpec(spec);
    // 旧独立 `for-each items → item` 行应触发友好报错（硬替换、非静默忽略）
    const stale = errors.find(e => /for-each/.test(e.message) && /步骤头/.test(e.message));
    expect(stale).toBeDefined();
    expect(stale!.message).toContain('[loop for-each item in items]');
  });

  // @v: anc-exec-parallel-foreach —— 伪输出行文法(2026-08-07 废除)残留须友好报错指向步骤头新文法
  it('rejects stale pseudo-output-line for-each syntax with friendly error', () => {
    const spec = `# Stale Inline For-each
Id: fe-stale-inline

## Goal
test

## Inputs
- items: [text]  # list

## Steps
1. [subtask parallel] Fan out
  - ← items
  + → item : for-each items
  + → result: [text]  # collected
  1.1. [reason] Do
    - ← item
    + → result: text
    > do it
`;
    const { errors } = parseSpec(spec);
    const stale = errors.find(e => /伪输出行文法已废除/.test(e.message));
    expect(stale).toBeDefined();
    expect(stale!.message).toContain('[loop for-each item in items]');
  });

  // @v: anc-step-continue
  it('parses continue step in loop context', () => {
    const { ast } = parseSpec(FULL_SPEC);
    const loop = ast.steps![9] as any;
    const innerBranch = loop.children[1] as any;
    const continueStep = innerBranch.children[1].children[1];
    expect(continueStep.step_type).toBe('continue');
    expect(continueStep.step_id).toBe('10.2.2.2');
  });

  // @v: anc-step-subtask
  it('parses subtask attributes (retry, adaptive)', () => {
    const { ast } = parseSpec(FULL_SPEC);
    const subtask = ast.steps![7] as any;
    expect(subtask.step_type).toBe('subtask');
    expect(subtask.retry).toBe(2);
    expect(subtask.adaptive).toBe(true);
    expect(subtask.children).toHaveLength(2);
  });

  // @v: anc-step-loop
  it('parses loop max_iterations', () => {
    const { ast } = parseSpec(FULL_SPEC);
    const loop = ast.steps![9] as any;
    expect(loop.step_type).toBe('loop');
    expect(loop.max_iterations).toBe(5);
    expect(loop.children).toHaveLength(2);
  });

  // @v: anc-step-call
  // @v: anc-rule-call-orthography —— call 结构化逻辑标准写法（2026-08-09 作者裁决:机读全入方括号）
  describe('call 结构化逻辑标准写法 [call id(映射)] 描述', () => {
    it('结构化逻辑标准写法带映射:id+映射入方括号,同名裸名简写', () => {
      const r = parseSpec(`# T
Id: t1
Goal: g
## Steps
1. [call data_cleaning(source_data: raw_input, mode)] 调用清洗
  + → clean_result: cleaned
`);
      expect(r.errors).toHaveLength(0);
      const s = r.ast!.steps![0] as CallStep;
      expect(s.callee_spec_id).toBe('data_cleaning');
      expect(s.param_mapping).toEqual([
        { from: 'raw_input', to: 'source_data' },
        { from: 'mode', to: 'mode' },          // 同名裸名简写
      ]);
      expect(s.output_mapping).toEqual([{ from: 'cleaned', to: 'clean_result' }]);
      expect(s.summary).toBe('调用清洗');
    });

    it('结构化逻辑标准写法无输入:[call id] 无括号', () => {
      const r = parseSpec(`# T
Id: t2
Goal: g
## Steps
1. [call data_cleaning] 调用清洗
  + → clean_result: cleaned
`);
      expect(r.errors).toHaveLength(0);
      const s = r.ast!.steps![0] as CallStep;
      expect(s.callee_spec_id).toBe('data_cleaning');
      expect(s.param_mapping).toBeUndefined();
    });

    it('旧形态兼容读:[call] id : 描述 + ← 映射行;serializer 写结构化逻辑标准写法', () => {
      const r = parseSpec(`# T
Id: t3
Goal: g
## Steps
1. [call] data_cleaning : 调用清洗
  - ← source_data: raw_input
  + → clean_result: cleaned
`);
      expect(r.errors).toHaveLength(0);
      const s = r.ast!.steps![0] as CallStep;
      expect(s.callee_spec_id).toBe('data_cleaning');
      expect(s.param_mapping).toEqual([{ from: 'raw_input', to: 'source_data' }]);
      const line = serializeSpec(r.ast!).split('\n').find(l => l.includes('[call'));
      expect(line).toContain('[call data_cleaning(source_data: raw_input)] 调用清洗');
    });

    it('结构化逻辑标准写法 roundtrip:parse→serialize→parse 语义不变', () => {
      const src = `# T
Id: t4
Goal: g
## Steps
1. [call sub-spec(a: x, b)] 调
  + → out: result
`;
      const r1 = parseSpec(src);
      expect(r1.errors).toHaveLength(0);
      const r2 = parseSpec(serializeSpec(r1.ast!));
      expect(r2.errors).toHaveLength(0);
      const s1 = r1.ast!.steps![0] as CallStep;
      const s2 = r2.ast!.steps![0] as CallStep;
      expect(s2.callee_spec_id).toBe(s1.callee_spec_id);
      expect(s2.param_mapping).toEqual(s1.param_mapping);
      expect(s2.output_mapping).toEqual(s1.output_mapping);
    });

    // @v: anc-step-call-literal —— param_mapping 值位字面量（2026-08-27 hopissues/0044）
    describe('call 输入映射字面量', () => {
      it('正例:字符串/数字/bool 字面量落 literal_value,from 保留原文;裸词仍变量', () => {
        const r = parseSpec(`# T
Id: tl1
Goal: g
## Steps
1. [call split_structure(split_kind: "seq", retries: 3, strict: true, split_plan: seq_plan)] 调
  + → out: result
`);
        expect(r.errors).toHaveLength(0);
        const s = r.ast!.steps![0] as CallStep;
        expect(s.param_mapping).toEqual([
          { from: '"seq"', to: 'split_kind', literal_value: 'seq' },
          { from: '3', to: 'retries', literal_value: 3 },
          { from: 'true', to: 'strict', literal_value: true },
          { from: 'seq_plan', to: 'split_plan' },   // 裸词=变量,无 literal_value 键
        ]);
      });

      it('正例:含逗号的引号字面量不被切碎（引号感知切分）', () => {
        const r = parseSpec(`# T
Id: tl2
Goal: g
## Steps
1. [call fmt(sep: "a, b", src: data)] 调
  + → out: result
`);
        expect(r.errors).toHaveLength(0);
        const s = r.ast!.steps![0] as CallStep;
        expect(s.param_mapping).toEqual([
          { from: '"a, b"', to: 'sep', literal_value: 'a, b' },
          { from: 'data', to: 'src' },
        ]);
      });

      it('正例:字面量 roundtrip——serialize 回写作者原文,re-parse 语义不变', () => {
        const src = `# T
Id: tl3
Goal: g
## Steps
1. [call sub-spec(kind: "seq", plan: x)] 调
  + → out: result
`;
        const r1 = parseSpec(src);
        expect(r1.errors).toHaveLength(0);
        const serialized = serializeSpec(r1.ast!);
        expect(serialized).toContain('kind: "seq"');
        const r2 = parseSpec(serialized);
        expect(r2.errors).toHaveLength(0);
        expect((r2.ast!.steps![0] as CallStep).param_mapping).toEqual((r1.ast!.steps![0] as CallStep).param_mapping);
      });

      it('反例:裸词不猜成字符串——mode: seq 是变量映射,永不落 literal_value', () => {
        const r = parseSpec(`# T
Id: tl4
Goal: g
## Steps
1. [call sub-spec(mode: seq)] 调
  + → out: result
`);
        const s = r.ast!.steps![0] as CallStep;
        expect(s.param_mapping).toEqual([{ from: 'seq', to: 'mode' }]);
        expect('literal_value' in s.param_mapping![0]).toBe(false);
      });

      // review 实抓:初版 isLiteralForm /i 宽容,True 过判定而 parseInitValue 只认小写跌字符串
      // 分支——literal_value 得字符串 "True",静默转字符串正是条款禁止的病形
      it('反例:True/False/None 大写变体是裸词=变量映射,不产字符串字面量', () => {
        const r = parseSpec(`# T
Id: tl5
Goal: g
## Steps
1. [call sub-spec(a: True, b: False, c: None)] 调
  + → out: result
`);
        const s = r.ast!.steps![0] as CallStep;
        expect(s.param_mapping).toEqual([
          { from: 'True', to: 'a' },
          { from: 'False', to: 'b' },
          { from: 'None', to: 'c' },
        ]);
        for (const m of s.param_mapping!) expect('literal_value' in m).toBe(false);
      });

      it('正例:单引号串/负数/浮点/null 全形态落 literal_value（概念枚举逐项钉）', () => {
        const r = parseSpec(`# T
Id: tl6
Goal: g
## Steps
1. [call sub-spec(k: 'seq', n: -2, f: 0.5, z: null)] 调
  + → out: result
`);
        expect(r.errors).toHaveLength(0);
        const s = r.ast!.steps![0] as CallStep;
        expect(s.param_mapping).toEqual([
          { from: "'seq'", to: 'k', literal_value: 'seq' },
          { from: '-2', to: 'n', literal_value: -2 },
          { from: '0.5', to: 'f', literal_value: 0.5 },
          { from: 'null', to: 'z', literal_value: null },   // null 值键在场（'in' 判定依赖）
        ]);
        expect('literal_value' in s.param_mapping![3]).toBe(true);
      });

      it('反例:引号不同型不成对（\'x"）不判字面量——按裸词=变量名走', () => {
        const r = parseSpec(`# T
Id: tl7
Goal: g
## Steps
1. [call sub-spec(k: 'seq")] 调
  + → out: result
`);
        const s = r.ast!.steps![0] as CallStep;
        expect('literal_value' in s.param_mapping![0]).toBe(false);
      });

      // review 实抓:旧形态 - ← 行原走盲 split(',')+盲剥 #,含逗号字面量切碎/含 # 截断
      it('正例:旧形态 - ← 映射行字面量——含逗号不切碎,引号内 # 不剥', () => {
        const r = parseSpec(`# T
Id: tl8
Goal: g
## Steps
1. [call] sub-spec : 调
  - ← sep: "a, b", tag: "#1", src: data  # 注释照剥
  + → out: result
`);
        expect(r.errors).toHaveLength(0);
        const s = r.ast!.steps![0] as CallStep;
        expect(s.param_mapping).toEqual([
          { from: '"a, b"', to: 'sep', literal_value: 'a, b' },
          { from: '"#1"', to: 'tag', literal_value: '#1' },
          { from: 'data', to: 'src' },
        ]);
      });
    });

    // @v: anc-step-call-dynamic-callee —— callee 位插值（晚绑定,2026-09-05 作者三拍定形:
    // 动态派发归 call 不另造工具;{} 即 f-string 主语义,callee 位直接花括号无引号壳）
    describe('call callee 位插值（^anc-step-call-dynamic-callee）', () => {
      it('正例:[call {analyzer}(doc: x)] 解析后 callee_expr 非空且 callee_spec_id 为空', () => {
        const r = parseSpec(`# T
Id: dc1
Goal: g
## Inputs
- analyzer: line  # 目标 spec id
- x: text  # 材料
## Steps
1. [call {analyzer}(doc: x)] 调
  + → out: result
`);
        expect(r.errors).toHaveLength(0);
        const s = r.ast!.steps![0] as CallStep;
        expect(s.callee_expr).toEqual({ type: 'var', name: 'analyzer' });
        expect(s.callee_expr_src).toBe('analyzer');
        expect(s.callee_spec_id).toBeUndefined();
        expect(s.param_mapping).toEqual([{ from: 'x', to: 'doc' }]);
      });

      it('正例:字段取形态 {issue.analyzer_spec} + parallel 属性尾巴', () => {
        const r = parseSpec(`# T
Id: dc2
Goal: g
## Inputs
- issues: [yaml]  # 问题清单
## Steps
1. [loop for-each issue in issues, collect rr into rrs] 逐个
  + → rrs: [line]
  1.1. [call {issue.analyzer_spec}(problem: "k") parallel] 派发分析
    + → rr: out
`);
        expect(r.errors).toHaveLength(0);
        const loop = r.ast!.steps![0] as LoopStep;
        const s = loop.children[0] as CallStep;
        expect(s.callee_expr).toEqual({ type: 'field', object: { type: 'var', name: 'issue' }, field: 'analyzer_spec' });
        expect(s.callee_expr_src).toBe('issue.analyzer_spec');
        expect(s.parallel).toBe(true);
      });

      it('正例:无映射形态 [call {analyzer}] 也认', () => {
        const r = parseSpec(`# T
Id: dc3
Goal: g
## Inputs
- analyzer: line  # 目标 spec id
## Steps
1. [call {analyzer}] 调
  + → out: result
`);
        expect(r.errors).toHaveLength(0);
        const s = r.ast!.steps![0] as CallStep;
        expect(s.callee_expr).toEqual({ type: 'var', name: 'analyzer' });
        expect(s.param_mapping).toBeUndefined();
      });

      it('反例:空表达式 [call {}(x: y)] 写时 error 教形态', () => {
        const r = parseSpec(`# T
Id: dc4
Goal: g
## Steps
1. [call {}(x: y)] 调
  + → out: result
`);
        expect(r.errors.some(e => e.message.includes('call callee 位插值表达式非法'))).toBe(true);
      });

      it('反例:非法表达式 [call {1+}(x: y)] 写时 error 含原文', () => {
        const r = parseSpec(`# T
Id: dc5
Goal: g
## Steps
1. [call {1+}(x: y)] 调
  + → out: result
`);
        expect(r.errors.some(e => e.message.includes('call callee 位插值表达式非法') && e.message.includes('{1+}'))).toBe(true);
      });

      it('serializer 往返:parse→serialize→re-parse,callee_expr 语义不变（回写 {原文} 形态）', () => {
        const src = `# T
Id: dc6
Goal: g
## Inputs
- specs: [line]  # 候选清单
## Steps
1. [call {specs[0]}(doc: "x")] 调
  + → out: result
`;
        const r1 = parseSpec(src);
        expect(r1.errors).toHaveLength(0);
        const serialized = serializeSpec(r1.ast!);
        expect(serialized).toContain('[call {specs[0]}(');
        const r2 = parseSpec(serialized);
        expect(r2.errors).toHaveLength(0);
        const s1 = r1.ast!.steps![0] as CallStep;
        const s2 = r2.ast!.steps![0] as CallStep;
        expect(s2.callee_expr).toEqual(s1.callee_expr);
        expect(s2.callee_expr_src).toBe(s1.callee_expr_src);
        expect(s2.param_mapping).toEqual(s1.param_mapping);
      });

      // @v: anc-rule-v13 —— callee 插值断供核（V1 同族:根变量须有产出方）
      it('V13 正例:前序步骤产出 analyzer 后 call {analyzer} 过', () => {
        const r = parseSpec(`# T
Id: dc7
Goal: g
## Inputs
- x: line  # 材料
## Steps
1. [act] 选 spec
  - ← x
  + → analyzer: line  # 目标 spec id
  > \`\`\`hop_python
  > analyzer = strip(x)
  > \`\`\`
2. [call {analyzer}(doc: x)] 调
  + → out: result
`);
        expect(r.errors).toHaveLength(0);
        const errs = validateSpec(r.ast!).filter(e => e.severity === 'error');
        expect(errs).toHaveLength(0);
      });

      it('V13 反例:无产出方拒,报文含变量名', () => {
        const r = parseSpec(`# T
Id: dc8
Goal: g
## Steps
1. [call {ghost_spec}(doc: "x")] 调
  + → out: result
`);
        expect(r.errors).toHaveLength(0);
        const v13 = validateSpec(r.ast!).filter(e => e.rule === 'V13');
        expect(v13).toHaveLength(1);
        expect(v13[0].message).toContain('ghost_spec');
        expect(v13[0].message).toContain('无产出方');
      });

      // @v: anc-rule-p1 —— P1 双缺反例:call 步既无静态 Id 也无插值表达式（旧形态 [call] 后
      // summary 无 " id : " 段——三形态归一后 callee_spec_id/callee_expr 双双缺席,P1 必报）
      it('P1 双缺拒:call 步既无静态 Id 也无插值表达式 → P1 error', () => {
        const r = parseSpec(`# T
Id: dc10
Goal: g
## Steps
1. [call] 调
  + → out: result
`);
        expect(r.errors).toHaveLength(0);   // parser 层不拦——双缺归 P1 静态检
        const p1 = validateSpec(r.ast!).filter(e => e.rule === 'P1');
        expect(p1).toHaveLength(1);
        expect(p1[0].severity).toBe('error');
        expect(p1[0].message).toContain('missing callee_spec_id');
      });

      // @v: anc-rule-p1 —— P1 扩为 callee_spec_id 与 callee_expr 至少其一
      it('P1 插值形态放行:callee_expr 在场零 P1 报错', () => {
        const r = parseSpec(`# T
Id: dc9
Goal: g
## Inputs
- analyzer: line  # 目标 spec id
## Steps
1. [call {analyzer}] 调
  + → out: result
`);
        expect(r.errors).toHaveLength(0);
        const p1 = validateSpec(r.ast!).filter(e => e.rule === 'P1');
        expect(p1).toHaveLength(0);
      });
    });

    // @v: anc-step-parallel —— call parallel 标注（统一模型：异步派发；正反例矩阵行 9）
    describe('call parallel 标注', () => {
      it('正例:[call id(映射) parallel] 括号后属性尾巴解析为 parallel', () => {
        const r = parseSpec(`# T
Id: tp1
Goal: g
## Steps
1. [loop for-each ch in chapters, collect built into results] 逐章
  + → built_list: [text]
  1.1. [call construct(src: ch) parallel] 派发构建
    + → built: text
`);
        const s = (r.ast!.steps![0] as any).children[0] as CallStep;
        expect(s.step_type).toBe('call');
        expect(s.callee_spec_id).toBe('construct');
        expect(s.param_mapping).toEqual([{ from: 'ch', to: 'src' }]);
        expect(s.parallel).toBe(true);
        expect(s.summary).toBe('派发构建');
      });

      it('正例:[call id parallel] 无括号形态', () => {
        const r = parseSpec(`# T
Id: tp2
Goal: g
## Steps
1. [call construct parallel] 派发
  + → built: text
`);
        const s = r.ast!.steps![0] as CallStep;
        expect(s.callee_spec_id).toBe('construct');
        expect(s.parallel).toBe(true);
      });

      it('正例:serializer 保留 parallel 标注（roundtrip）', () => {
        const r1 = parseSpec(`# T
Id: tp3
Goal: g
## Steps
1. [call construct(src: ch) parallel] 派发
  + → built: text
`);
        const line = serializeSpec(r1.ast!).split('\n').find(l => l.includes('[call'));
        expect(line).toContain('[call construct(src: ch) parallel] 派发');
        const r2 = parseSpec(serializeSpec(r1.ast!));
        expect((r2.ast!.steps![0] as CallStep).parallel).toBe(true);
      });

      it('正例:subtask/case 的 parallel 同保留（roundtrip——候选文件固化通道,丢写即变串行;review 抓漏 2026-08-13）', () => {
        const r1 = parseSpec(`# T
Id: tp5
Goal: g
## Inputs
- x: int  # 选
## Steps
1. [subtask] 边界
  + → r: text
  1.1. [subtask retry=2 parallel] 活
    + → r: text
    1.1.1. [reason] A
      + → r: text  # a
      > a
2. [branch] 分流
  2.1. [case(x == 1) parallel] 并行臂
    + → r2: text
    2.1.1. [reason] B
      + → r2: text  # b
      > b
`);
        expect(r1.errors).toEqual([]);
        const out = serializeSpec(r1.ast!);
        expect(out).toContain('[subtask retry=2 parallel] 活');
        expect(out).toContain('[case(x == 1) parallel] 并行臂');
        const r2 = parseSpec(out);
        const sub = (r2.ast!.steps![0] as SubtaskStep).children[0] as SubtaskStep;
        const cs = (r2.ast!.steps![1] as BranchStep).children[0] as CaseStep & { parallel?: boolean };
        expect(sub.parallel).toBe(true);
        expect(sub.retry).toBe(2);
        expect(cs.parallel).toBe(true);
        expect(cs.condition).toBe('x == 1');
      });

      it('反例:未标注 call 的 parallel 字段缺席（不误标）', () => {
        const r = parseSpec(`# T
Id: tp4
Goal: g
## Steps
1. [call construct(src: ch)] 同步调用
  + → built: text
`);
        const s = r.ast!.steps![0] as CallStep;
        expect(s.callee_spec_id).toBe('construct');
        expect(s.parallel).toBeUndefined();
      });

      it('反例:属性尾巴不吞映射残段（) 后出现非属性字符不按标准写法命中）', () => {
        // ) 与 ] 间出现冒号（非属性字符集）——不得按"属性尾巴"解析出错误的 callee/映射
        const r = parseSpec(`# T
Id: tp5
Goal: g
## Steps
1. [call construct(src: ch) x: y] 畸形
  + → built: text
`);
        // 不命中标准写法特判（尾巴含 :）——不得静默产出带错误映射的 call；
        // 实际行为:整行不成步骤（畸形显式失败优于假装成功）
        const s = r.ast?.steps?.[0] as any;
        if (s) expect(s.param_mapping ?? []).not.toContainEqual({ from: 'y', to: 'x' });
        else expect(r.ast?.steps ?? []).toHaveLength(0);
      });
    });
  });

  it('parses call step callee_spec_id', () => {
    const { ast } = parseSpec(FULL_SPEC);
    const call = ast.steps![5] as any;
    expect(call.step_type).toBe('call');
    expect(call.callee_spec_id).toBe('child_spec');
    expect(call.summary).toBe('Execute sub-specification');
  });

  // @v: anc-step-confirm
  it('parses confirm with require_human attribute', () => {
    const md = `# Test
Goal: Test confirm parsing

## Steps
1. [confirm require_human=true] Verify with user
  > Please review the changes
`;
    const { ast } = parseSpec(md);
    const confirm = ast.steps![0] as any;
    expect(confirm.step_type).toBe('confirm');
    expect(confirm.require_human).toBe(true);
  });

  it('parses confirm without require_human', () => {
    const md = `# Test
Goal: Test confirm parsing

## Steps
1. [confirm] Auto-confirmable step
  > Review
`;
    const { ast } = parseSpec(md);
    const confirm = ast.steps![0] as any;
    expect(confirm.step_type).toBe('confirm');
    expect(confirm.require_human).toBeUndefined();
  });

  // @v: anc-step-ask
  it('parses ask step (data collection)', () => {
    const md = `# Test
Goal: Test ask parsing

## Inputs
- hint: text

## Steps
1. [ask require_human=true] 请提供文档类型
  - ← hint
  + → doc_type: line  # 文档类型
  > 基于 hint 确认文档类型
`;
    const { ast } = parseSpec(md);
    const ask = ast.steps![0] as any;
    expect(ask.step_type).toBe('ask');
    expect(ask.require_human).toBe(true);
    expect(ask.outputs[0].name).toBe('doc_type');
  });

  // @v: anc-step-ask, anc-rule-p12
  it('parses ask step with present_inputs (single var)', () => {
    const md = `# Test
Goal: g
## Inputs
- raw_outline: text  # draft
## Steps
1. [ask present_inputs=raw_outline] 确认大纲
  - ← raw_outline
  + → outline: text  # 定稿
  > 展示草案给用户审
`;
    const { ast } = parseSpec(md);
    const ask = ast.steps![0] as any;
    expect(ask.step_type).toBe('ask');
    expect(ask.present_inputs).toEqual(['raw_outline']);
  });

  // @v: anc-step-ask, anc-rule-p12
  it('parses ask step with present_inputs (multi var, comma-separated)', () => {
    const md = `# Test
Goal: g
## Inputs
- a: text  # first
- b: text  # second
## Steps
1. [ask present_inputs=a,b] 确认 a 和 b
  - ← a, b
  + → out: text  # final
  > 展示 a 和 b 给用户
`;
    const { ast } = parseSpec(md);
    const ask = ast.steps![0] as any;
    expect(ask.present_inputs).toEqual(['a', 'b']);
  });

  // @v: anc-step-ask
  it('ask without present_inputs leaves field undefined (backwards compat)', () => {
    const md = `# Test
Goal: g
## Inputs
- hint: text  # h
## Steps
1. [ask] 确认
  - ← hint
  + → out: text  # final
  > q
`;
    const { ast } = parseSpec(md);
    const ask = ast.steps![0] as any;
    expect(ask.present_inputs).toBeUndefined();
  });

  // @v: anc-step-call
  it('parses call step with input param_mapping', () => {
    const md = `# Test
Goal: Test call parsing

## Steps
1. [call] child_spec : Execute sub-spec
  - ← data, config
`;
    const { ast } = parseSpec(md);
    const call = ast.steps![0] as any;
    expect(call.step_type).toBe('call');
    expect(call.callee_spec_id).toBe('child_spec');
    expect(call.summary).toBe('Execute sub-spec');
    expect(call.param_mapping).toHaveLength(2);
    expect(call.param_mapping[0]).toEqual({ from: 'data', to: 'data' });
  });

  // @v: anc-step-branch, anc-step-case
  it('parses branch with case children', () => {
    const { ast } = parseSpec(FULL_SPEC);
    const branch = ast.steps![6] as any;
    expect(branch.step_type).toBe('branch');
    expect(branch.children).toHaveLength(2);
    expect(branch.children[0].step_type).toBe('case');
    expect(branch.children[0].condition).toBe('is_valid == true');
    expect(branch.children[1].condition).toBe('default');
  });

  // @v: anc-step-case, anc-rule-case-condition
  // case 条件解析:三种合法写法都要识别——描述+条件、纯条件、(default)。
  // 回归 ppt-html/doc-review 暴露的 bug:parser 此前把整行(含中文描述)当 condition,
  // 导致 evaluateCondition 提取变量名时拿到描述、求值恒 false、branch 全 skip。
  it('extracts condition from "[case] 描述 (条件)" — drops description, keeps last parens', () => {
    const spec = `# T
Id: t
## Goal
g
## Inputs
- m: line  # mode
## Outputs
- r: line  # out
## Steps
1. [branch] Route
  - ← m
  + → r: line  # out
  1.1. [case] 高风险 (risk_level == high)
    + → r: line  # case out
    1.1.1. [reason] x
      + → r: line
      > x
  1.2. [case] severity == 'fatal'
    + → r: line  # case out
    1.2.1. [reason] y
      + → r: line
      > y
  1.3. [case] 低/中风险 (default)
    + → r: line  # case out
    1.3.1. [reason] z
      + → r: line
      > z
`;
    const { ast, errors } = parseSpec(spec);
    expect(errors).toHaveLength(0);
    const branch = ast.steps![0] as any;
    expect(branch.children).toHaveLength(3);
    // 带描述 → 取末尾括号内
    expect(branch.children[0].condition).toBe('risk_level == high');
    // 纯条件无括号 → 整行
    expect(branch.children[1].condition).toBe("severity == 'fatal'");
    // (default) → 兜底
    expect(branch.children[2].condition).toBe('default');
  });

  it('case 取最后一对括号 (描述里有括号不被误截)', () => {
    const spec = `# T2
Id: t2
## Goal
g
## Inputs
- m: line  # mode
## Outputs
- r: line  # out
## Steps
1. [branch] Route
  - ← m
  + → r: line  # out
  1.1. [case] 低/中风险（含未知）(risk == low)
    + → r: line  # case out
    1.1.1. [reason] x
      + → r: line
      > x
`;
    const { ast, errors } = parseSpec(spec);
    expect(errors).toHaveLength(0);
    const c = (ast.steps![0] as any).children[0];
    // 描述里的中文全角括号「（含未知）」不应干扰半角 (risk == low) 的提取
    expect(c.condition).toBe('risk == low');
  });

  // @v: anc-step-commit
  it('parses commit irreversible_action from instruction', () => {
    const { ast } = parseSpec(FULL_SPEC);
    const commit = ast.steps![4] as any;
    expect(commit.step_type).toBe('commit');
    expect(commit.irreversible_action).toBe('Delete all temporary data permanently');
  });

  // @v: anc-step-break
  it('parses nested steps with correct hierarchy', () => {
    const { ast } = parseSpec(FULL_SPEC);
    const loop = ast.steps![9] as any;
    // loop (10) → check (10.1), branch (10.2) → case (10.2.1) → break (10.2.1.1)
    expect(loop.children[1].step_type).toBe('branch');
    expect(loop.children[1].children[0].children[0].step_type).toBe('break');
    expect(loop.children[1].children[0].children[0].step_id).toBe('10.2.1.1');
  });
});

// ===== Input/Output parsing =====

// @v: anc-type-output-decl, anc-type-value-types
describe('parseSpec — input/output parsing', () => {
  // @v: anc-rule-v4 （类型token切分文法:28轮review抓静默吞新例——[enum(a, b)] 括号内逗号带空格,
  // 原 \S+ 形态吞不到闭括号后的 ],Inputs 整行静默消失/产出行被逗号切碎;三站点同修尾 \]?）
  // @v: anc-rule-v7-header-types
  it('[enum(a, b)] 列表元素含参形:Inputs/产出行/初值位三站点完整切出', () => {
    const inputsMd = `# T
## Goal
g
## Inputs
- lvls: [enum(high, medium, low)]  # 等级表
## Steps
1. [reason] R
`;
    const { ast: a1 } = parseSpec(inputsMd);
    expect(a1.header.inputs).toHaveLength(1);
    expect(a1.header.inputs![0]).toMatchObject({ name: 'lvls', type: '[enum(high,medium,low)]' });   // AST 存规范形——括号内逗号空格归一剥除（^anc-rule-v7-header-types ④,2026-09-05）

    const outMd = `# T
## Goal
g
## Steps
1. [reason] R
  + → lvls: [enum(high, medium, low)]  # 等级表
`;
    const { ast: a2 } = parseSpec(outMd);
    expect(a2.steps![0].outputs).toHaveLength(1);
    expect(a2.steps![0].outputs![0]).toMatchObject({ name: 'lvls', type: '[enum(high,medium,low)]' });   // 同上,规范形

    const initMd = `# T
## Goal
g
## Steps
1. [act] A
  + → m: [enum(a, b)] = []  # 累加器
`;
    const { ast: a3 } = parseSpec(initMd);
    expect(a3.steps![0].outputs![0]).toMatchObject({ name: 'm', type: '[enum(a,b)]', default: [] });   // 同上,规范形
  });

  it('存量类型形态零回归:[line]/enum(a, b)/text 照旧切出', () => {
    const md = `# T
## Goal
g
## Inputs
- x: [line]  # a
- y: enum(a, b)  # b
- z: text  # c
## Steps
1. [reason] R
`;
    const { ast } = parseSpec(md);
    expect(ast.header.inputs!.map(i => i.type)).toEqual(['[line]', 'enum(a,b)', 'text']);
  });

  it('parses multiple comma-separated inputs', () => {
    const md = `# Test
## Steps
1. [act] Do something
  - ← var1, var2, var3
`;
    const { ast } = parseSpec(md);
    expect(ast.steps![0].inputs).toHaveLength(3);
    expect(ast.steps![0].inputs!.map(i => i.name)).toEqual(['var1', 'var2', 'var3']);
  });

  it('parses output with type and description', () => {
    const md = `# Test
## Steps
1. [reason] Think
  + → analysis: yaml  # deep analysis result
`;
    const { ast } = parseSpec(md);
    const out = ast.steps![0].outputs![0];
    expect(out.name).toBe('analysis');
    expect(out.type).toBe('yaml');
    expect(out.description).toBe('deep analysis result');
  });

  it('parses output "none" as empty array', () => {
    const md = `# Test
## Steps
1. [branch] Route
  + → none
  1.1. [case] a
  1.2. [case] b
`;
    const { ast } = parseSpec(md);
    expect(ast.steps![0].outputs).toBeUndefined();
  });

  it('parses comma-separated output names without types', () => {
    const md = `# Test
## Steps
1. [loop] Repeat
  + → result, status
  1.1. [break]
`;
    const { ast } = parseSpec(md);
    expect(ast.steps![0].outputs).toHaveLength(2);
    expect(ast.steps![0].outputs![0].name).toBe('result');
    expect(ast.steps![0].outputs![0].type).toBe('');   // 裸名简写=引用,无类型主张(2026-08-09 扁平重构)
  });

  it('parses multi-line instructions', () => {
    const md = `# Test
## Steps
1. [act] Execute
  > First instruction line
  > Second instruction line
  > Third instruction line
`;
    const { ast } = parseSpec(md);
    expect(ast.steps![0].instruction).toBe('First instruction line\nSecond instruction line\nThird instruction line');
  });

  it('parses enum type in outputs', () => {
    const md = `# Test
## Steps
1. [reason] Classify
  + → category: enum(low,medium,high)  # priority level
`;
    const { ast } = parseSpec(md);
    expect(ast.steps![0].outputs![0].type).toBe('enum(low,medium,high)');
  });

  // @v: anc-type-value-types
  it('parses [line] array type in outputs', () => {
    const md = `# Test
## Steps
1. [reason] List items
  + → items: [line]  # list of items
`;
    const { ast } = parseSpec(md);
    expect(ast.steps![0].outputs![0].type).toBe('[line]');
    expect(ast.steps![0].outputs![0].name).toBe('items');
  });
});

// @v: anc-error-spec-error
// ===== Error cases =====

describe('parseSpec — error handling', () => {
  it('reports error for missing title', () => {
    const md = `## Steps
1. [reason] Think
`;
    const { errors } = parseSpec(md);
    expect(errors.some(e => e.message.match(/title/i))).toBe(true);
  });

  it('reports error for unknown step type', () => {
    const md = `# Test
## Steps
1. [unknown_type] Do something
`;
    const { errors } = parseSpec(md);
    expect(errors.some(e => e.message.match(/unknown.*step.*type/i))).toBe(true);
  });

  it('reports error for orphan nested step', () => {
    const md = `# Test
## Steps
1.1. [reason] Orphan child
`;
    const { ast, errors } = parseSpec(md);
    expect(errors.some(e => e.message.match(/non-existent parent/i))).toBe(true);
  });

  // @v: anc-ast-base-step
  it('records source_location for steps', () => {
    const { ast } = parseSpec(MINIMAL_SPEC);
    expect(ast.steps![0].source_location).toBeDefined();
    expect(ast.steps![0].source_location!.line_start).toBeGreaterThan(0);
    expect(ast.steps![0].source_location!.line_end).toBeGreaterThanOrEqual(ast.steps![0].source_location!.line_start);
  });

  it('records source_location for nested steps', () => {
    const { ast } = parseSpec(FULL_SPEC);
    const branch = ast.steps![6] as any;
    expect(branch.source_location).toBeDefined();
    expect(branch.children[0].source_location).toBeDefined();
  });
});

// ===== Serializer =====

describe('serializeSpec', () => {
  it('round-trips a simple spec', () => {
    const { ast } = parseSpec(MINIMAL_SPEC);
    const serialized = serializeSpec(ast);

    // Re-parse the serialized output
    const { ast: ast2, errors } = parseSpec(serialized);
    expect(errors).toHaveLength(0);
    expect(ast2.header.title).toBe(ast.header.title);
    expect(ast2.steps).toHaveLength(1);
    expect(ast2.steps![0].step_type).toBe('reason');
    expect(ast2.steps![0].summary).toBe('Analyze input');
  });

  it('serializes header sections', () => {
    const md = `# Test Spec

## Goal
Test goal

## Constraints
- Constraint 1

## Inputs
- x: text  # input x

## Outputs
- y: yaml  # output y

## Steps
1. [act] Do it
`;
    const { ast } = parseSpec(md);
    const serialized = serializeSpec(ast);
    expect(serialized).toContain('## Goal');
    expect(serialized).toContain('Test goal');
    expect(serialized).toContain('## Constraints');
    expect(serialized).toContain('- Constraint 1');
    expect(serialized).toContain('## Inputs');
    expect(serialized).toContain('- x: text');
    expect(serialized).toContain('## Outputs');
    expect(serialized).toContain('- y: yaml');
  });
});

// ===== Inline label format =====

describe('parseSpec — inline label format', () => {
  it('parses Goal: inline format', () => {
    const md = `# Inline Spec
Id: inline-test
Goal: Achieve the goal

Inputs:
- x: text

Outputs:
- y: yaml  # result

## Steps
1. [reason] Think
  - ← x
  + → y: yaml  # result
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.header.id).toBe('inline-test');
    expect(ast.header.goal).toBe('Achieve the goal');
    expect(ast.header.inputs).toHaveLength(1);
    expect(ast.header.outputs).toHaveLength(1);
  });
});

// ===== Coverage: types.ts type guards =====

describe('types.ts — type guards', () => {
  it('isContainerStep returns true for container types', () => {
    const subtask = { step_id: '1', step_type: 'subtask', summary: 's', children: [] } as SubtaskStep;
    expect(isContainerStep(subtask)).toBe(true);
  });

  it('isContainerStep returns false for non-container types', () => {
    const reason = { step_id: '1', step_type: 'reason', summary: 's' } as ReasonStep;
    expect(isContainerStep(reason)).toBe(false);
  });

  it('hasChildren returns false when children property is missing', () => {
    const reason = { step_id: '1', step_type: 'reason', summary: 's' } as ReasonStep;
    expect(hasChildren(reason)).toBe(false);
  });

  it('getChildren returns empty array for non-container step', () => {
    const reason = { step_id: '1', step_type: 'reason', summary: 's' } as ReasonStep;
    expect(getChildren(reason)).toEqual([]);
  });
});

// @v: anc-type-type-decl
// ===== Coverage: multiple TypeDecls parsing =====

describe('parseSpec — multiple TypeDecls', () => {
  it('parses two consecutive TypeDecls', () => {
    const md = `# Test

## Types
- SearchResult:
    query: text
    score: int
- Address:
    street: text
    city: text

## Steps
1. [reason] Think
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.header.types).toHaveLength(2);
    expect(ast.header.types![0].name).toBe('SearchResult');
    expect(ast.header.types![0].fields).toEqual({ query: 'text', score: 'int' });
    expect(ast.header.types![1].name).toBe('Address');
    expect(ast.header.types![1].fields).toEqual({ street: 'text', city: 'text' });
  });

  it('handles TypeDecl interrupted by non-type line', () => {
    const md = `# Test

## Types
- OnlyType:
    field_a: text
    field_b: int
some random interruption line

## Steps
1. [reason] Think
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.header.types).toHaveLength(1);
    expect(ast.header.types![0].name).toBe('OnlyType');
    expect(ast.header.types![0].fields).toEqual({ field_a: 'text', field_b: 'int' });
  });

  // 字段带 `- ` 前缀 + TypeName/字段带尾部 `# 注释`（fact-check/doc-review 实际写法）。
  // 曾漏解析：typeMatch 的 `:$` 被尾注释破坏、fieldMatch 未容忍 `- ` 前缀 → fields 全空。
  it('parses TypeDecl with `- ` field prefix and trailing comments', () => {
    const md = `# Test

## Types
- CheckPoint:  # 一个待核查点
  - id: line  # 点编号
  - type: line  # fact 或 inference
  - claim: text

## Steps
1. [reason] Think
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.header.types).toHaveLength(1);
    expect(ast.header.types![0].name).toBe('CheckPoint');
    expect(ast.header.types![0].fields).toEqual({ id: 'line', type: 'line', claim: 'text' });
  });
});

// ===== Coverage: step nested under non-container =====

describe('parseSpec — step under non-container', () => {
  it('reports error when child is nested under non-container step', () => {
    const md = `# Test
## Steps
1. [reason] Think
  1.1. [act] Nested under reason
`;
    const { errors } = parseSpec(md);
    expect(errors.some(e => e.message.match(/non-container/i))).toBe(true);
  });
});

// ===== Coverage: serializer — types, config, subtask/loop attrs, children =====

describe('serializeSpec/serializeFragment lang 参数与 lang 转换命令（^anc-i18n-language-config）', () => {
  // @v: anc-i18n-serialize-lang
  const SRC = `# Spec: lang-probe
Id: lang-probe

## Goal
probe

## Inputs
- data: line  # in

## Outputs
- out: markdown  # deliverable

## Steps
1. [act free] explore
  + → raw: yaml  # raw
2. [loop for-each item in raw, collect r into rs max=3] per item
  2.1. [subtask retry=2 parallel] unit
    2.1.1. [act] fetch
      - ← item
      + → r: text
    2.1.2. [check] verify
      - ← r
      + → ok: bool  # g
      + → note: text  # w
3. [branch] route
  + → out: markdown
  3.1. [case(len(rs) > 0)] has
    3.1.1. [reason] sum
      - ← rs
      + → out: markdown
  3.2. [case(else)] empty
    3.2.1. [act free] note
      + → out: markdown
4. [check final escalatable] gate
  - ← out
  + → fok: bool  # g
  + → fnote: text  # w
`;

  it('正: lang=zh 序列化出中文关键词且 parse 回英文规范形 AST(AST 恒英文不动)', () => {
    const { ast } = parseSpec(SRC);
    const zh = serializeSpec(ast, { lang: 'zh' });
    expect(zh).toContain('## 目标');
    expect(zh).toContain('标识: lang-probe');
    expect(zh).toContain('[探索 开放]');
    expect(zh).toContain('[循环 遍历 item 于 raw, 收集 r 入 rs 上限=3]');
    expect(zh).toContain('[子任务 重试=2 并行]');
    expect(zh).toContain('[条件(其他)]');
    expect(zh).toContain('[检查 终检 可上升]');
    const back = parseSpec(zh);
    expect(back.errors).toHaveLength(0);
    const types: string[] = [];
    const walk = (ns: { step_type: string; children?: unknown[] }[]) => { for (const n of ns) { types.push(n.step_type); if (n.children?.length) walk(n.children as typeof ns); } };
    walk(back.ast.steps as { step_type: string; children?: unknown[] }[]);
    expect(types).toContain('act');       // 中文文本 parse 回英文规范形
    expect(types).toContain('loop');
    expect(types).not.toContain('探索');
  });

  it('回归: lang 缺省(en)序列化行为与既有逐字节一致(零破坏)', () => {
    const { ast } = parseSpec(SRC);
    expect(serializeSpec(ast)).toBe(serializeSpec(ast, { lang: 'en' }));
  });

  it('正: convertSpecKeywords en→zh→en 逐字节可逆(纯英文件)', () => {
    const zh = convertSpecKeywords(SRC, 'zh');
    expect(zh).toContain('## 步骤');
    expect(zh).toContain('[探索 开放] explore');
    const back = convertSpecKeywords(zh, 'en');
    expect(back).toBe(SRC);
  });

  it('反: 变量名/说明文字/body 含关键词字串不被转换(词元级不腐蚀)', () => {
    const tricky = `# Spec: t\nId: t\n\n## Steps\n1. [act] do retry-ish things\n  + → 重试次数: int  # 说明里写 parallel 与 free 字样\n2. [commit] c\n  > prose mentions retry= and collect into here\n  > \`\`\`hop_python\n  > x = write(path: "a", content: "retry=99 collect into")\n  > \`\`\`\n`;
    const zh = convertSpecKeywords(tricky, 'zh');
    expect(zh).toContain('重试次数: int');            // 变量名不动
    expect(zh).toContain('说明里写 parallel 与 free 字样');   // 注释散文不动
    expect(zh).toContain('retry=99 collect into');    // 围栏 body 不动
    expect(zh).toContain('prose mentions retry= and collect into here');  // > 说明不动
  });

  it('反: 裸围栏内步骤形态的行不被转换(叙事节示例代码块——围栏跳过逻辑的真保护面;> 引用形围栏另有 > 前缀天然罩)', () => {
    const src = '# Spec: f\nId: f\n\n## Steps\n1. [act free] show example\n  + → o: text\n\n## 背景\n\n示例:\n\`\`\`\n1. [act free] fenced example step\n## Steps\n\`\`\`\n';
    const zh = convertSpecKeywords(src, 'zh');
    expect(zh).toContain('\n1. [act free] fenced example step');   // 裸围栏内步骤行原样
    expect(zh.split('\n')).toContain('## Steps');                  // 裸围栏内段头原样(围栏外的已转成 ## 步骤)
    expect(zh).toContain('1. [探索 开放] show example');             // 围栏外正常转换
    expect(zh).toContain('## 步骤');
  });

  it('反: case 括号组内表达式不被转换(else 整组例外)', () => {
    const src = '# Spec: c\nId: c\n\n## Steps\n1. [branch] r\n  + → o: text\n  1.1. [case(len(items) > 0 and retry_count < 3)] a\n    1.1.1. [act] x\n      + → o: text\n  1.2. [case(else)] b\n    1.2.1. [act] y\n      + → o: text\n';
    const zh = convertSpecKeywords(src, 'zh');
    expect(zh).toContain('[条件(len(items) > 0 and retry_count < 3)]');   // 表达式原样
    expect(zh).toContain('[条件(其他)]');
  });
});

describe('serializeSpec — full round-trip with all sections', () => {
  it('serializes and re-parses types, config, subtask/loop attrs, children', () => {
    const md = `# Full Round Trip

## Types
- Item:
    name: text
    count: int

## Config
- max_depth: 5

## Steps
1. [subtask retry=3 adaptive] Complex task
  1.1. [loop max_iterations=10] Iterate
    1.1.1. [check] Verify
      + → ok: bool
    1.1.2. [branch] Check
      1.1.2.1. [case] ok == true
        1.1.2.1.1. [break]
      1.1.2.2. [case] default
        1.1.2.2.1. [continue]
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);

    const serialized = serializeSpec(ast);

    // Verify types section
    expect(serialized).toContain('## Types');
    expect(serialized).toContain('- Item:');
    expect(serialized).toContain('    name: text');
    expect(serialized).toContain('    count: int');

    // Verify config section
    expect(serialized).toContain('## Config');
    expect(serialized).toContain('- max_depth: 5');

    // Verify subtask/loop attrs
    expect(serialized).toContain('[subtask retry=3 adaptive]');
    expect(serialized).toContain('[loop max=10]');

    // Re-parse and verify structure
    const { ast: ast2, errors: e2 } = parseSpec(serialized);
    expect(e2).toHaveLength(0);
    expect(ast2.header.types).toHaveLength(1);
    expect(ast2.header.config).toEqual({ max_depth: 5 });

    const subtask = ast2.steps![0] as any;
    expect(subtask.retry).toBe(3);
    expect(subtask.adaptive).toBe(true);
    expect(subtask.children).toHaveLength(1);

    const loop = subtask.children[0] as any;
    expect(loop.max_iterations).toBe(10);
    expect(loop.children).toHaveLength(2);
  });
});

// ===== Coverage: code fences =====

describe('parseSpec — code fences', () => {
  it('ignores content inside code fences in steps', () => {
    const md = `# Test

## Steps
1. [reason] Think
  + → result: text

\`\`\`
2. [act] This should be ignored
  - ← fake_var
\`\`\`

3. [act] Real step
  + → output: text
`;
    const { ast } = parseSpec(md);
    expect(ast.steps).toHaveLength(2);
    expect(ast.steps![0].step_id).toBe('1');
    expect(ast.steps![1].step_id).toBe('3');
  });

  it('ignores headings inside code fences during section identification', () => {
    const md = `# Real Title

\`\`\`
## Steps
1. [act] Fake step
\`\`\`

## Steps
1. [reason] Real step
`;
    const { ast } = parseSpec(md);
    expect(ast.header.title).toBe('Real Title');
    expect(ast.steps).toHaveLength(1);
    expect(ast.steps![0].step_type).toBe('reason');
  });
});

// ===== Coverage: nesting depth limit =====

describe('parseSpec — nesting depth limit（64 层输入防护,非业务约束）', () => {
  function deepSpec(levels: number): string {
    let md = '# Deep Spec\n\n## Steps\n';
    let id = '';
    for (let i = 1; i <= levels; i++) {
      id = id ? `${id}.1` : '1';
      const indent = '  '.repeat(i - 1);
      const type = i < levels ? 'subtask' : 'reason';
      md += `${indent}${id}. [${type}] Level ${i}\n`;
    }
    return md;
  }

  it('反例：超过 64 层报 ParseError', () => {
    const { errors } = parseSpec(deepSpec(65));
    expect(errors.some(e => e.message.match(/nesting depth/i))).toBe(true);
  });

  // 2026-08-17 作者判定修正：10 层限的该是 call 链深度（max_call_depth 正交闸）,
  // 内部嵌套是输入防护——hopkb 实撞:合法规约条件密度（每重条件 branch+case 吃 2 层）10 层轻易触顶
  it('正例：11 层合法规约不再误拒（原 10 层上限实撞面）', () => {
    const { errors } = parseSpec(deepSpec(11));
    expect(errors.filter(e => e.message.match(/nesting depth/i))).toEqual([]);
  });

  it('正例：64 层顶格恰好放行', () => {
    const { errors } = parseSpec(deepSpec(64));
    expect(errors.filter(e => e.message.match(/nesting depth/i))).toEqual([]);
  });
});

// ===== Coverage: obsidian comments =====

describe('parseSpec — obsidian comments', () => {
  it('skips lines starting with %%', () => {
    const md = `# Test

## Steps
1. [reason] Think
  + → x: text
%% This is an obsidian comment
2. [act] Do
  - ← x
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.steps).toHaveLength(2);
  });
});

// ===== Coverage: deep nesting with getMaxNesting recursive path =====

describe('parseSpec — multi-level nesting', () => {
  it('correctly builds 4-level deep tree', () => {
    const md = `# Test
## Steps
1. [subtask] L1
  1.1. [subtask] L2
    1.1.1. [subtask] L3
      1.1.1.1. [reason] L4
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const deepChild = (ast.steps![0] as any).children[0].children[0].children[0];
    expect(deepChild.step_id).toBe('1.1.1.1');
  });
});

// ===== Coverage: remaining branch edge cases =====

describe('parseSpec — branch coverage edge cases', () => {
  it('parses output without description (empty description fallback)', () => {
    const md = `# Test

## Outputs
- result: yaml

## Steps
1. [reason] Think
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.header.outputs![0].description).toBe('');
  });

  it('parses config with string value (non-numeric)', () => {
    const md = `# Test

## Config
- mode: fast
- max_depth: 5

## Steps
1. [reason] Think
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.header.config!.mode).toBe('fast');
    expect(ast.header.config!.max_depth).toBe(5);
  });

  it('skips non-step lines before first step in Steps section', () => {
    const md = `# Test

## Steps
Some introductory text that is not a step
1. [reason] Think
  + → x: text
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.steps).toHaveLength(1);
    expect(ast.steps![0].step_type).toBe('reason');
  });

  it('parses case step with empty condition (summary-less case)', () => {
    const md = `# Test
## Steps
1. [branch] Route
  1.1. [case]
    1.1.1. [act] Do A
      + → a: text
  1.2. [case] default
    1.2.1. [act] Do B
      + → b: text
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const branch = ast.steps![0] as any;
    // 空 case → 显式标 'default'(与 'default' 关键字归一化,见 ^anc-rule-case-condition)。
    // engine isDefault 判定本就把空/'default' 等价(engine-traverse:292),归一化让 AST 自描述更清晰。
    expect(branch.children[0].condition).toBe('default');
    expect(branch.children[1].condition).toBe('default');
  });

  it('parses commit step without instruction (falls back to summary)', () => {
    const md = `# Test
## Steps
1. [commit] Delete all records
  + → approval: bool
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const commit = ast.steps![0] as any;
    expect(commit.irreversible_action).toBe('Delete all records');
  });

  it('serializes spec with id field', () => {
    const md = `# My Spec
Id: my-spec-id

## Steps
1. [reason] Think
`;
    const { ast } = parseSpec(md);
    const serialized = serializeSpec(ast);
    expect(serialized).toContain('Id: my-spec-id');

    const { ast: ast2, errors } = parseSpec(serialized);
    expect(errors).toHaveLength(0);
    expect(ast2.header.id).toBe('my-spec-id');
  });
});

// @v: anc-step-check-finally
describe('parseSpec — [check final] parsing', () => {
  it('parses [check final]（现行写法）and sets is_finally=true', () => {
    const md = `# T
Id: t

## Goal
g

## Steps
1. [subtask] S
  + → ok: bool
  1.1. [act] A
    + → x: text
    > t
  1.2. [check final] V
    - ← x
    + → ok: bool
    + → note: text
    > check
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toEqual([]);
    const check = ast!.steps[0].children![1] as CheckStep;
    expect(check.is_finally).toBe(true);
  });

  it('parses [check finally]（旧写法兼容读,概念层已宣废止——本例是兼容判据非示范）and sets is_finally=true', () => {
    const md = `# Test
## Steps
1. [subtask] Do work
  1.1. [act] Run
    + → result: text
  1.2. [check finally] Verify constraints
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const subtask = ast.steps![0] as SubtaskStep;
    const checkStep = subtask.children[1] as any;
    expect(checkStep.step_type).toBe('check');
    expect(checkStep.is_finally).toBe(true);
  });

  it('parses plain [check] without is_finally', () => {
    const md = `# Test
## Steps
1. [subtask] Do work
  1.1. [check] Normal check
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const subtask = ast.steps![0] as SubtaskStep;
    const checkStep = subtask.children[0] as any;
    expect(checkStep.step_type).toBe('check');
    expect(checkStep.is_finally).toBeUndefined();
  });

  it('parses multiple [check finally] steps in sequence', () => {
    const md = `# Test
## Steps
1. [subtask] Do work
  1.1. [act] Run
    + → result: text
  1.2. [check finally] Verify A
  1.3. [check finally] Verify B
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const subtask = ast.steps![0] as SubtaskStep;
    expect((subtask.children[1] as any).is_finally).toBe(true);
    expect((subtask.children[2] as any).is_finally).toBe(true);
  });

  // @v: anc-exec-model-annotation
  it('extracts @model annotation from instruction', () => {
    const md = `# Test
## Steps
1. [reason] Analyze
  + → result: text  # analysis
  > @model deepseek/deepseek-v4-pro
  > Think carefully
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const step = ast.steps![0] as ReasonStep;
    expect(step.model_override).toBe('deepseek/deepseek-v4-pro');
    expect(step.instruction).toBe('Think carefully');
  });

  it('parses step without @model — model_override is undefined', () => {
    const md = `# Test
## Steps
1. [reason] Analyze
  + → result: text  # analysis
  > Think carefully
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const step = ast.steps![0] as ReasonStep;
    expect(step.model_override).toBeUndefined();
    expect(step.instruction).toBe('Think carefully');
  });

  // @src 源锚点（锚点体系 2026-08-18 作者定——纯追溯零执行语义,@model 同通道。 // @v: anc-step-src-annotation ）
  it('extracts @src annotation — 剥出 instruction、存 src_ref（出处含空格与引号整行收）', () => {
    const spec = `# T
Id: t
## Goal
g
## Steps
1. [reason] 想
  + → r: text  # r
  > @src 原文§3"逐个校验条目"
  > 思考
`;
    const { ast, errors } = parseSpec(spec);
    expect(errors).toHaveLength(0);
    expect(ast.steps![0].src_ref).toBe('原文§3"逐个校验条目"');
    expect(ast.steps![0].instruction).toBe('思考');   // 锚不进 instruction=不进执行 prompt
  });

  it('round-trips @src and @model through serialize（锚随产物持久化;@model 丢失系存量缺口同批修）', () => {
    const spec = `# T
Id: t
## Goal
g
## Steps
1. [reason] 想
  + → r: text  # r
  > @src 原文§3
  > @model deepseek/x
  > 思考
`;
    const { ast } = parseSpec(spec);
    const out = serializeSpec(ast);
    expect(out).toContain('@src 原文§3');
    expect(out).toContain('@model deepseek/x');
    const again = parseSpec(out).ast;
    expect(again.steps![0].src_ref).toBe('原文§3');           // 二次往返稳定
    expect(again.steps![0].model_override).toBe('deepseek/x');
  });

  it('parses step without @src — src_ref is undefined（无锚零占位）', () => {
    const spec = `# T\nId: t\n## Goal\ng\n## Steps\n1. [reason] r\n  + → r: text  # r\n  > t\n`;
    const { ast } = parseSpec(spec);
    expect(ast.steps![0].src_ref).toBeUndefined();
  });

  it('extracts @model with only model name (no service prefix)', () => {
    const md = `# Test
## Steps
1. [act] Execute
  + → output: text  # result
  > @model claude-sonnet-4-6
  > Run the computation
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const step = ast.steps![0];
    expect(step.model_override).toBe('claude-sonnet-4-6');
    expect(step.instruction).toBe('Run the computation');
  });
});

// @v: anc-rule-doc-ref-extract
describe('doc-ref 提取', () => {
  it('从 step instruction 提取 doc_refs', () => {
    const md = `# S

## Steps
1. [reason] plan
  + → r: text
  > 参照 [[design-spec#四、组件库]] 选组件
`;
    const { ast } = parseSpec(md);
    expect(ast.steps![0].doc_refs).toEqual([{ doc: 'design-spec', section: '四、组件库' }]);
  });

  it('从 Constraints 提取 spec 级 doc_refs', () => {
    const md = `# S
Constraints:
- 色板取自 [[design-spec#二、色板]]，禁止自创

## Steps
1. [reason] plan
  + → r: text
  > do it
`;
    const { ast } = parseSpec(md);
    expect(ast.header.doc_refs).toEqual([{ doc: 'design-spec', section: '二、色板' }]);
  });

  it('排除 #^ 锚点反链', () => {
    const md = `# S

## Steps
1. [reason] plan
  + → r: text
  > 见 [[doc#^anc-foo]] 和 [[doc#色板]]
`;
    const { ast } = parseSpec(md);
    expect(ast.steps![0].doc_refs).toEqual([{ doc: 'doc', section: '色板' }]);
  });

  it('无 doc-ref 时 doc_refs 缺省', () => {
    const md = `# S

## Steps
1. [reason] plan
  + → r: text
  > 普通指令无引用
`;
    const { ast } = parseSpec(md);
    expect(ast.steps![0].doc_refs).toBeUndefined();
  });
});

// @v: anc-exec-output-init
describe('parseSpec +→ = 初值 语法', () => {
  it('解析各类初值字面量到 OutputDecl.default', () => {
    const md = `# Init Syntax

## Steps
1. [loop max_iterations=3] Loop
  + → acc: yaml = []  # 空列表累加器
  1.1. [act] Work
    + → flag: bool = Null  # 每轮重置
    + → cnt: int = 0  # 计数
    + → tag: line = "seed"  # 带引号字符串
    + → plain: text = bare  # 裸文本
    + → normal: text  # 无初值
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const loop = ast.steps![0] as LoopStep;
    expect(loop.outputs!.find(o => o.name === 'acc')!.default).toEqual([]);
    const leaf = getChildren(loop)[0];
    const byName = (n: string) => leaf.outputs!.find(o => o.name === n)!;
    expect(byName('flag').default).toBeNull();
    expect(byName('cnt').default).toBe(0);
    expect(byName('tag').default).toBe('seed');
    expect(byName('plain').default).toBe('bare');
    expect(byName('normal').default).toBeUndefined();  // 无 = 初值 → default 缺省
    expect(byName('normal').description).toBe('无初值');  // 注释仍正确解析
  });
});

// ===== 表层表述变种：标题风 =====
// @v: anc-rule-surface-heading-flavor

// 剥 source_location（各风味行号不同）后深比较 AST 结构——证明"一 AST 多风味"。
function stripLoc(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripLoc);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'source_location') continue;
      out[k] = stripLoc(v);
    }
    return out;
  }
  return node;
}

// hop_python body 序列化往返（check body 批顺带修存量缺口:act/commit/check body 序列化全丢
// ——body 是执行语义本体,丢失后 re-parse 从引擎直执退化 LLM 自由发挥,与 for-each 子句丢失同族）。
// @v: anc-step-check-body
describe('serializeSpec — hop_python body 写回', () => {
  it('正例:act body 往返保留（存量缺口回归——原全丢）', () => {
    const md = '# T\n\n## Goal\nt\n\n## Steps\n1. [act] calc\n  + → x: int  # v\n  > ```hop_python\n  > x = 1 + 2\n  > ```\n';
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const out = serializeSpec(ast);
    const { ast: ast2, errors: e2 } = parseSpec(out);
    expect(e2).toHaveLength(0);
    expect((ast2.steps![0] as { body?: unknown }).body).toBeDefined();
  });

  it('正例:check body 往返保留（新能力同验）', () => {
    const md = '# T\n\n## Goal\nt\n\n## Inputs\n- fb: text\n\n## Steps\n1. [subtask] 组\n  + → ok: bool  # 判\n  1.1. [check final] 判空\n  - ← fb\n  + → ok: bool  # 判定\n  + → note: text  # 说明\n  > ```hop_python\n  > ok = len(fb) == 0\n  > note = "" if ok else "未对齐"\n  > ```\n';
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const out = serializeSpec(md ? ast : ast);
    const { ast: ast2, errors: e2 } = parseSpec(out);
    expect(e2).toHaveLength(0);
    const check = (ast2.steps![0] as { children: { body?: unknown; step_type: string }[] }).children[0];
    expect(check.step_type).toBe('check');
    expect(check.body).toBeDefined();
  });

  it('反例:无 body 步骤序列化不产出空围栏', () => {
    const md = '# T\n\n## Goal\nt\n\n## Steps\n1. [reason] think\n  + → r: text  # v\n  > 想一想\n';
    const { ast } = parseSpec(md);
    expect(serializeSpec(ast)).not.toContain('hop_python');
  });
});

// call 输出映射注释剥离序（三十三审实撞:先切逗号后剥#——注释里的半角逗号把注释尾切成幽灵映射,
// v4 首轮 CALL_OUTPUT_MISSING '零占位残留）'实录）。 // @v: anc-step-call
describe('call 输出映射 — 注释先剥再切', () => {
  it('正例：注释含半角逗号不产幽灵映射', () => {
    const md = '# T\n\n## Goal\ng\n\n## Steps\n1. [call foo(a: b)] 调\n  + → spec_body: fragment  # 完整片段（编号已重刷,零占位残留）\n';
    const { ast } = parseSpec(md);
    expect((ast.steps![0] as CallStep).output_mapping).toEqual([{ from: 'fragment', to: 'spec_body' }]);
  });

  it('反例：真多映射逗号联仍正常切分', () => {
    const md = '# T\n\n## Goal\ng\n\n## Steps\n1. [call foo(a: b)] 调\n  + → x: out1, y: out2\n';
    const { ast } = parseSpec(md);
    expect((ast.steps![0] as CallStep).output_mapping).toEqual([{ from: 'out1', to: 'x' }, { from: 'out2', to: 'y' }]);
  });
});

// ask/confirm 属性序列化往返（三十二审自家狗粮实撞:renumber_only 经 serializer 往返把
// present_inputs/require_human 全丢——呈交硬约束与真人闸静默降级;for-each/初值/body 丢失同族第4例）
// @v: anc-step-ask, anc-step-confirm
describe('serializeSpec — ask/confirm 属性写回', () => {
  it('正例：require_human + present_inputs 往返保留', () => {
    const md = '# T\n\n## Goal\ng\n\n## Inputs\n- a: text\n\n## Steps\n1. [ask require_human present_inputs=a] 问\n  - ← a\n  + → v: text  # 值\n  > 问一下\n2. [confirm require_human] 批\n  - ← v\n  + → ok: bool  # 批\n  > 请批\n';
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const { ast: ast2, errors: e2 } = parseSpec(serializeSpec(ast));
    expect(e2).toHaveLength(0);
    const ask = ast2.steps![0] as { require_human?: boolean; present_inputs?: string[] };
    expect(ask.require_human).toBe(true);
    expect(ask.present_inputs).toEqual(['a']);
    expect((ast2.steps![1] as { require_human?: boolean }).require_human).toBe(true);
  });

  it('反例：无属性的 ask/confirm 不产出多余属性字样', () => {
    const md = '# T\n\n## Goal\ng\n\n## Steps\n1. [ask] 问\n  + → v: text  # 值\n  > 问\n';
    const { ast } = parseSpec(md);
    const out = serializeSpec(ast);
    expect(out).not.toContain('require_human');
    expect(out).not.toContain('present_inputs');
  });
});

// 编号尾点可选（buildtest 实撞:LLM 写 `1.1 [reason]` 缺尾点被静默丢弃——父容器 S5"无子步"
// 报错指向缩进,重试打转;静默吞家族）。
// @v: anc-rule-step-number-dot-optional
describe('parseSpec — 步骤编号尾点可选', () => {
  it('正例：`1.1 [reason]` 无尾点与 `1.1. [reason]` 同 AST', () => {
    const withDot = '# A\n\n## Steps\n\n1. [loop max=3] 遍历\n  1.1. [reason] 判断\n  + → flag: line  # x\n';
    const noDot   = '# A\n\n## Steps\n\n1 [loop max=3] 遍历\n  1.1 [reason] 判断\n  + → flag: line  # x\n';
    const a = parseSpec(withDot), b = parseSpec(noDot);
    expect(a.errors).toHaveLength(0);
    expect(b.errors).toHaveLength(0);
    expect(stripLoc(b.ast.steps)).toEqual(stripLoc(a.ast.steps));
  });

  it('正例：无尾点 case/call 特判路径同收', () => {
    const md = '# A\n\n## Steps\n\n1 [branch] 分档\n  1.1 [case(x == 1)] 低档\n    1.1.1 [act] 处理\n    + → y: line  # v\n';
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const branch = ast.steps![0] as { children: { step_type: string }[] };
    expect(branch.children[0].step_type).toBe('case');
  });

  // 字母后缀伪步骤响亮拒（三十审实撞:'5.2b. [act]' 整步连 body 被吸进前一步——body 挂错宿主,
  // 前一步被引擎当纯计算直执,植锚 LLM 活整个跳过且 validate 全绿）
  it('反例：字母后缀伪步骤行响亮 parse error（不静默并入前一步）', () => {
    const md = '# A\n\n## Steps\n1. [act] a\n  + → x: int  # v\n  > do\n1b. [act] b\n  + → y: int  # v\n  > do\n';
    const { errors } = parseSpec(md);
    expect(errors.some(e => e.message.includes('字母后缀') || e.message.includes('编号不合文法'))).toBe(true);
  });

  it('反例：粘连无点 `1[reason]` 不收（数字-类型无分隔,歧义面大）', () => {
    const md = '# A\n\n## Steps\n\n1[reason] 判断\n+ → flag: line  # x\n';
    const { ast } = parseSpec(md);
    expect(ast.steps ?? []).toHaveLength(0);   // 不被识别为步骤行
  });

  it('反例：既有粘连带点形 `1.[reason]` 照收（零回归）', () => {
    const md = '# A\n\n## Steps\n\n1.[reason] 判断\n+ → flag: line  # x\n';
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.steps).toHaveLength(1);
  });
});

describe('parseSpec — 标题风（heading flavor）', () => {
  it('### / #### 前缀步骤解析出正确 step_id / type / 树结构', () => {
    const md = `# HF

## Steps

### 1. [loop max_iterations=50] 遍历待办项

这批 items 来自上游清洗阶段。本循环对每项独立处理。

- ← items          # 待处理清单
+ → processed: list

#### 1.1. [reason] 起草方案

依据 item 类型选择模板，输出结构化草案。

- ← item           # 当前项
+ → draft: text
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.steps).toHaveLength(1);
    const loop = ast.steps![0] as LoopStep;
    expect(loop.step_id).toBe('1');
    expect(loop.step_type).toBe('loop');
    expect(loop.max_iterations).toBe(50);
    const child = getChildren(loop)[0];
    expect(child.step_id).toBe('1.1');
    expect(child.step_type).toBe('reason');
    // 标题下自然段落吸收进 instruction
    expect(loop.instruction).toContain('本循环对每项独立处理');
    expect(child.instruction).toContain('依据 item 类型选择模板，输出结构化草案。');
    // 输入 # 就近注释被剥离，变量名干净
    expect(loop.inputs!.map(i => i.name)).toEqual(['items']);
    expect(child.inputs!.map(i => i.name)).toEqual(['item']);
  });

  it('标题风与等价内联风解析出结构相同的 AST（一 AST 多风味）', () => {
    const heading = `# Equiv

## Steps

### 1. [subtask] 处理

先做准备，再执行主体。

- ← raw            # 原始输入
+ → out: text  # 结果

#### 1.1. [reason] 主体

根据 raw 推导 out。

- ← raw
+ → out
`;
    const inline = `# Equiv

## Steps
1. [subtask] 处理
  - ← raw
  + → out: text  # 结果
  > 先做准备，再执行主体。
  1.1. [reason] 主体
    - ← raw
    + → out
    > 根据 raw 推导 out。
`;
    const a = parseSpec(heading);
    const b = parseSpec(inline);
    expect(a.errors).toHaveLength(0);
    expect(b.errors).toHaveLength(0);
    expect(stripLoc(a.ast.steps)).toEqual(stripLoc(b.ast.steps));
  });

  it('深过 h6 的 ####### 前缀照常解析（# 个数不参与构树）', () => {
    const md = `# Deep HF

## Steps

### 1. [subtask] L1
#### 1.1. [subtask] L2
##### 1.1.1. [subtask] L3
###### 1.1.1.1. [subtask] L4
####### 1.1.1.1.1. [reason] L5

到第 5 层用了 7 个 #。
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    let node = ast.steps![0];
    for (const id of ['1.1', '1.1.1', '1.1.1.1', '1.1.1.1.1']) {
      node = getChildren(node as SubtaskStep)[0];
      expect(node.step_id).toBe(id);
    }
    expect(node.step_type).toBe('reason');
    expect(node.instruction).toContain('到第 5 层用了 7 个 #。');
  });

  it('标题风裸 hop_python fence 被捕获并 de-indent 成 act body', () => {
    const heading = `# HF Act

## Steps

### 1. [act] 切分

无推理编排：纯内置函数计算。

- ← text
+ → word_count: int  # 词数

    \`\`\`hop_python
    cleaned = strip(text)
    words = split(cleaned, ",")
    word_count = len(words)
    \`\`\`
`;
    const { ast, errors } = parseSpec(heading);
    expect(errors).toHaveLength(0);
    const act = ast.steps![0] as import('../src/ast-types.js').ActStep;
    expect(act.body).toBeDefined();
    expect(act.body!.statements).toHaveLength(3);
    // 自然语言段落仍进 instruction，fence 不污染
    expect(act.instruction).toContain('无推理编排：纯内置函数计算。');
  });

  it('内联风回归：非标题风步骤的未知纯文本行仍静默丢弃', () => {
    const md = `# Inline Regress

## Steps
1. [reason] 分析
  - ← q
  + → r: text  # 结果
  这是一行没有前缀的杂散文本，内联风应当丢弃它
  > 正经指令
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const step = ast.steps![0];
    // 只有 `>` 指令进 instruction，杂散文本被丢弃
    expect(step.instruction).toBe('正经指令');
  });

  it('meta-first（←/→ 紧贴标题、正文在后）与 meta-last 解析出相同 AST', () => {
    const metaFirst = `# MF

## Steps

### 1. [reason] 分析
- ← q            # 查询
+ → r: text  # 结果

先审题，再作答。`;
    const metaLast = `# MF

## Steps

### 1. [reason] 分析

先审题，再作答。

- ← q            # 查询
+ → r: text  # 结果`;
    const a = parseSpec(metaFirst);
    const b = parseSpec(metaLast);
    expect(a.errors).toHaveLength(0);
    expect(b.errors).toHaveLength(0);
    // 顺序不敏感：两种排布 AST 结构相同
    expect(stripLoc(a.ast.steps)).toEqual(stripLoc(b.ast.steps));
    expect(a.ast.steps![0].instruction).toBe('先审题，再作答。');
  });

  it('## Task 契约分区静默忽略，header 仍正确解析', () => {
    const md = `# Spec: T
Id: demo

## Task

Goal: 一句话目标
Inputs:
- items: [text]  # 清单

## Steps

### 1. [reason] 处理
- ← items
+ → out: text  # 结果`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    // ## Task 不产生 section、不干扰 header
    expect(ast.header.id).toBe('demo');
    expect(ast.header.goal).toBe('一句话目标');
    expect(ast.header.inputs!.map(i => i.name)).toEqual(['items']);
    expect(ast.steps).toHaveLength(1);
    expect(ast.steps![0].step_id).toBe('1');
  });
});

// @v: anc-rule-compound-output —— 复合输出 YAML 展开(2026-08-09 通读实测:原解析成"name:"错误变量名)
describe('复合输出 YAML 展开', () => {
  it('`+ → name:` 声明头剥冒号、type=yaml、子行进 fields 不注册变量', () => {
    const md = `# Spec: t
Goal: g
## Steps
1. [act] s
  + → profile:  # 数据质量画像
    - missing_rates: [float]  # 各列缺失率
    - anomaly_count: int  # 异常记录数
2. [reason] use
  - ← profile
  + → out: text  # o
  > u
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const out = ast.steps![0].outputs![0];
    expect(out.name).toBe('profile');            // 冒号已剥
    expect(out.type).toBe('yaml');
    expect(out.description).toBe('数据质量画像');
    expect(out.fields).toHaveLength(2);
    expect(out.fields![0]).toEqual({ name: 'missing_rates', type: '[float]', description: '各列缺失率' });
    // 字段不注册为独立变量:步骤只有 1 个输出
    expect(ast.steps![0].outputs).toHaveLength(1);
    // 下游 ← profile 的 V1 放行由 validator.test.ts 侧覆盖(此处纯 parser 断言)
  });

  it('复合声明头后的非子行(平级输出行)正常解析,收集状态终止', () => {
    const md = `# Spec: t
Goal: g
## Steps
1. [act] s
  + → profile:  # 画像
    - a: int  # x
  + → plain: text  # 平级普通输出
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast.steps![0].outputs).toHaveLength(2);
    expect(ast.steps![0].outputs![1].name).toBe('plain');
    expect(ast.steps![0].outputs![0].fields).toHaveLength(1);
  });
});

// @v: anc-rule-s14 —— Id 签名 serializer 原样回写
describe('Id 函数签名 serializer', () => {
  it('有 signature 回写签名原文;无则回写纯 id', () => {
    const md = `# T
Id: clean-data(raw_data) -> report
## Goal
g
## Inputs
- raw_data: [text]  # in
## Outputs
- report: markdown  # out
## Steps
1. [reason] r
  - ← raw_data
  + → report: markdown
  > t
`;
    const { ast } = parseSpec(md);
    expect(serializeSpec(ast)).toContain('Id: clean-data(raw_data) -> report');
  });
});

// @v: anc-rule-case-condition —— case 结构化逻辑标准写法改版(2026-08-09 作者定:机读入[],与loop属性同构)
describe('case 结构化逻辑标准写法 [case(条件)] 描述', () => {
  it('新结构化逻辑标准写法:条件入[](含 ] 与嵌套括号不误截),描述纯人读', () => {
    const md = `# T
## Steps
1. [branch] b
  1.1. [case(risk == "high" and items[0] == "a")] 高危路径
    1.1.1. [reason] r
      + → o: text
      > t
  1.2. [case] 兜底
    1.2.1. [reason] r2
      + → o: text
      > t
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const c = (ast.steps![0] as any).children[0];
    expect(c.condition).toBe('risk == "high" and items[0] == "a"');
    expect(c.summary).toBe('高危路径');
    expect((ast.steps![0] as any).children[1].condition).toBe('default');
    // serializer 写结构化逻辑标准写法
    expect(serializeSpec(ast)).toContain('[case(risk == "high" and items[0] == "a")] 高危路径');
  });

  it('反例：[case()] 空条件 → parse error 指路 else（设计明文空串同废——2026-08-30 审计实抓放行:引擎把空串当第二 default,放中间静默吞其后全部 case）', () => {
    const src = `# T
## Goal
g
## Steps
1. [branch] 分
  1.1. [case(x > 1)] 大
    + → r: text
  1.2. [case()] 空
    + → r: text
`;
    const { errors } = parseSpec(src);
    expect(errors.some(e => /\[case\(\)\] 空条件已废止/.test(e.message) && /else/.test(e.message))).toBe(true);
  });

  it('反例：[case(default)] 显式拒（旧统配废止——同批顺手钉:此前该拒零测试）', () => {
    const src = `# T
## Goal
g
## Steps
1. [branch] 分
  1.1. [case(x > 1)] 大
    + → r: text
  1.2. [case(default)] 兜
    + → r: text
`;
    const { errors } = parseSpec(src);
    expect(errors.some(e => /\[case\(default\)\] 已废止/.test(e.message))).toBe(true);
  });

  it('正例：裸 [case] 仍=default 兜底、[case(else)] 照常（空串拒不误伤合法形态）', () => {
    const src = `# T
## Goal
g
## Steps
1. [branch] 分
  1.1. [case(x > 1)] 大
    + → r: text
  1.2. [case(else)] 其余
    + → r: text
2. [branch] 分2
  2.1. [case(y > 1)] 大
    + → r2: text
  2.2. [case] 兜底
    + → r2: text
`;
    const { ast, errors } = parseSpec(src);
    expect(errors).toHaveLength(0);
    expect((ast.steps![0] as any).children[1].condition).toBe('default');
    expect((ast.steps![1] as any).children[1].condition).toBe('default');
  });

  it('旧形态兼容读,序列化归一为新结构化逻辑标准写法', () => {
    const md = `# T
## Steps
1. [branch] b
  1.1. [case] 高危 (risk == high)
    1.1.1. [reason] r
      + → o: text
      > t
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const c = (ast.steps![0] as any).children[0];
    expect(c.condition).toBe('risk == high');
    expect(c.summary).toBe('高危');   // 旧形态 summary 剥条件归一
    expect(serializeSpec(ast)).toContain('[case(risk == high)] 高危');
  });
});

// @v: anc-ast-spec-header —— Config 段 '-' 分项体例（作者定 2026-08-13:与 Inputs/Outputs 一致,spec 全篇一种分项心智;
// 引擎把条目列表归一为配置映射——原映射体例兼容读）
describe('Config 段 - 分项体例', () => {
  it('正例：内外层 - 分项（标准体例——Config 就是一个 HopSchema 字段,内层条目同款分项）递归归一,嵌套保真', () => {
    const md = `# T
Id: t

Config:
- models:
  - reason: ds/pro
  - replan: zh/glm
- model: ds/flash

## Goal
g

## Steps
1. [exit] 完
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toEqual([]);
    expect(ast!.header.config).toEqual({ models: { reason: 'ds/pro', replan: 'zh/glm' }, model: 'ds/flash' });
  });

  it('正例：内层映射（无 -）兼容读——外层 dash 内层映射混写同归一', () => {
    const md = `# T
Id: t

Config:
- models:
    reason: ds/pro
- model: ds/flash

## Goal
g

## Steps
1. [exit] 完
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toEqual([]);
    expect(ast!.header.config).toEqual({ models: { reason: 'ds/pro' }, model: 'ds/flash' });
  });

  it('正例：映射体例（无 -）兼容读——两体例同归一', () => {
    const md = `# T
Id: t

Config:
  models:
    reason: ds/pro
  model: ds/flash

## Goal
g

## Steps
1. [exit] 完
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toEqual([]);
    expect(ast!.header.config).toEqual({ models: { reason: 'ds/pro' }, model: 'ds/flash' });
  });
});

// ── 属性总闸（2026-08-13 作者定：parallel 仅 subtask/call/case;未消费属性一律 parse error——
// 实撞:[case parallel] 静默吞且旧形态下被解析成 default 统配,[reason retry=2] 全族同病）──
// @v: anc-rule-attr-gate, anc-step-parallel
describe('属性总闸：未消费属性即 parse error', () => {
  const parse = (steps: string) => parseSpec(`# T
Id: t
Goal: g
## Steps
${steps}`);

  // collect 子句带类型标注（四十四审重档实录:flash 反复写 into results: [yaml]——': [yaml]'
  // 被切成未知属性,原报文不指路正解,单轮核查两轮打转;报错指路给存在的替代,append 文案先例）
  it('反例：collect into 带类型标注 → 未知属性报错并指路 collect 正形', () => {
    const { errors } = parse(`1. [loop for-each s in suppliers, collect result into results: [yaml]] 遍历
  - ← suppliers
  1.1. [reason] r
    + → result: yaml  # x
    > r`);
    const hit = errors.find(e => e.message.includes('未知属性'));
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('collect result into results');
    expect(hit!.message).toContain('类型声明归循环头');
  });

  it('反例：非 loop 步骤的 [ 形未知属性不给 collect 指路（避免误导）', () => {
    const { errors } = parse(`1. [subtask retry=2 [weird]] 组
  1.1. [reason] r
    + → r: text  # a
    > t`);
    const hit = errors.find(e => e.message.includes('未知属性'));
    expect(hit).toBeDefined();
    expect(hit!.message).not.toContain('collect');
  });

  it('正例：collect 正形（into 后裸名）零报错', () => {
    const { errors } = parse(`1. [loop for-each s in suppliers, collect result into results] 遍历
  - ← suppliers
  + → results: [yaml]  # 收集
  1.1. [reason] r
    + → result: yaml  # x
    > r`);
    expect(errors).toHaveLength(0);
  });

  it('反例：[reason retry=2] → 错位属性报错并指路 subtask/case', () => {
    const { errors } = parse(`1. [reason retry=2] 想
  + → r: text  # a
  > t`);
    expect(errors.some(e => e.message.includes('不消费属性 "retry"') && e.message.includes('subtask/case'))).toBe(true);
  });

  it('反例：[act parallel] → 错位属性报错并指路 subtask/call/case', () => {
    const { errors } = parse(`1. [act parallel] 做
  + → r: text  # a
  > t`);
    expect(errors.some(e => e.message.includes('不消费属性 "parallel"') && e.message.includes('subtask/call/case'))).toBe(true);
  });

  it('反例：[subtask bogus] 未知词 → 报"未知属性"不静默丢弃', () => {
    const { errors } = parse(`1. [subtask bogus] 组
  + → r: text
  1.1. [act] x
    + → r: text  # a
    > b`);
    expect(errors.some(e => e.message.includes('未知属性 "bogus"'))).toBe(true);
  });

  it('正例：[case(x == 1) parallel] 标准写法尾属性——parallel 落 AST,条件不被污染', () => {
    const { ast, errors } = parse(`1. [subtask] b
  + → r: text
  1.1. [branch] f
    1.1.1. [case(x == 1) parallel] 走
      + → r: text
      1.1.1.1. [reason] A
        + → r: text  # a
        > a
    1.1.2. [case(else)] 兜
      1.1.2.1. [exit]`);
    expect(errors).toEqual([]);
    const c = (ast!.steps![0] as SubtaskStep).children[0].children![0] as CaseStep & { parallel?: boolean };
    expect(c.condition).toBe('x == 1');
    expect(c.parallel).toBe(true);
  });

  it('正例：[case(x == 1) retry=2 adaptive] 尾多属性同收', () => {
    const { ast, errors } = parse(`1. [subtask] b
  + → r: text
  1.1. [branch] f
    1.1.1. [case(x == 1) retry=2 adaptive] 走
      + → r: text
      1.1.1.1. [reason] A
        + → r: text  # a
        > a`);
    expect(errors).toEqual([]);
    const c = (ast!.steps![0] as SubtaskStep).children[0].children![0] as CaseStep;
    expect(c.condition).toBe('x == 1');
    expect(c.retry).toBe(2);
    expect(c.adaptive).toBe(true);
  });

  it('正例：既有合法属性全形态零误伤（subtask retry+adaptive+parallel/loop for-each+collect/check final/ask present_inputs）', () => {
    const { errors } = parse(`1. [loop for-each x in xs, collect r into rs] 遍历
  + → rs: [text]
  1.1. [subtask retry=2 adaptive parallel] 活
    + → r: text
    1.1.1. [reason] A
      - ← x
      + → r: text  # a
      > a
2. [subtask] 收尾组
  + → ok: bool
  2.1. [check final] 核
    - ← rs
    + → ok: bool  # 判
    + → note: text  # 说明
    > 核
3. [ask present_inputs=rs] 呈交
  - ← rs
  + → ans: text  # 答`);
    expect(errors).toEqual([]);
  });
});

// ===== i18n 关键词双语直通（方案 B,术语表 design/i18n.md ^anc-i18n-glossary）=====
// @v: anc-i18n-keyword-impl
describe('serializeSpec loop 子句写回（v0.7.6 抓漏——丢写=L2e 降级源漏引用）', () => {
  const SRC = `# T
Id: t
## Goal
g
## Inputs
- customers: [line]  # in
## Outputs
- alerts: [line]  # out
## Steps
1. [loop for-each c in customers, collect a into alerts] scan
  + → alerts: [line]  # sink
  1.1. [reason] judge
    - ← c
    + → a: line  # unit
`;

  it('正例：for-each/collect 子句 AST 层往返一致', () => {
    const r1 = parseSpec(SRC);
    expect(r1.errors).toHaveLength(0);
    const out = serializeSpec(r1.ast!);
    expect(out).toContain('for-each c in customers');
    expect(out).toContain('collect a into alerts');
    const r2 = parseSpec(out);
    expect(r2.errors).toHaveLength(0);
    const l1 = r1.ast!.steps![0] as LoopStep, l2 = r2.ast!.steps![0] as LoopStep;
    expect(l2.forEach).toEqual(l1.forEach);
    expect(l2.collect).toEqual(l1.collect);
  });

  it('反例：条件循环（无 for-each）不多写子句', () => {
    const md = SRC.replace('[loop for-each c in customers, collect a into alerts]', '[loop max=3]')
      .replace('    - ← c\n', '');
    const r = parseSpec(md);
    const line = serializeSpec(r.ast!).split('\n').find(l => l.includes('[loop'));
    expect(line).toContain('max=3');
    expect(line).not.toContain('for-each');
    expect(line).not.toContain('collect');
  });
});

describe('i18n 中文关键词直通', () => {
  const ZH_SPEC = `# Spec: 客户检查
Id: kehu-check
## 目标
逐个检查客户并收集预警
## 输入
- 客户列表: [line]  # 全部客户
## 输出
- 预警名单: [line]  # 收集结果
## 步骤
1. [循环 遍历 客户 于 客户列表, 收集 预警 入 预警名单] 逐个检查
  + → 预警名单: [line]  # 收集端
  1.1. [子任务 重试=2 并行] 检查单个客户
    - ← 客户
    + → 预警: line  # 单项
    1.1.1. [推理] 判断活跃度
      - ← 客户
      + → 预警: line  # 判定
2. [结束] 交付
`;

  it('正例：全中文 spec parse+validate 双绿,AST 恒英文规范形', () => {
    const { ast, errors } = parseSpec(ZH_SPEC);
    expect(errors).toHaveLength(0);
    expect(validateSpec(ast!).filter(e => e.severity === 'error')).toHaveLength(0);
    const loop = ast!.steps![0] as LoopStep;
    expect(loop.step_type).toBe('loop');                                  // 循环→loop
    expect(loop.for_each ?? (loop as any).forEach).toBeDefined();         // 遍历…于→for-each…in
    expect(loop.collect).toEqual([{ unitVar: '预警', listVar: '预警名单' }]);  // 收集…入→collect…into
    const st = (loop.children![0]) as SubtaskStep;
    expect(st.step_type).toBe('subtask');                                 // 子任务→subtask
    expect(st.retry).toBe(2);                                             // 重试=2→retry=2
    expect(st.parallel).toBe(true);                                       // 并行→parallel
    expect(st.children![0].step_type).toBe('reason');                     // 推理→reason
    expect(ast!.steps![1].step_type).toBe('exit');                        // 结束→exit
  });

  it('正例：标识: 行（Id 中文别名）收 id', () => {
    const { ast, errors } = parseSpec(ZH_SPEC.replace('Id: kehu-check', '标识: kehu-check'));
    expect(errors).toHaveLength(0);
    expect(ast!.header.id).toBe('kehu-check');
  });

  it('正例：中英混写同义（方案 B 直通零声明）', () => {
    const mixed = ZH_SPEC.replace('[推理]', '[reason]').replace('## 目标', '## Goal');
    const { ast, errors } = parseSpec(mixed);
    expect(errors).toHaveLength(0);
    expect(ast!.header.goal).toContain('逐个检查');
  });

  it('正例：必须真人确认→require_human', () => {
    const md = `# T
Id: t
## 目标
g
## 输出
- r: line  # r
## 步骤
1. [确认 必须真人确认] 请人审批
  + → r: bool  # 批复
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast!.steps![0].step_type).toBe('confirm');
    expect((ast!.steps![0] as ConfirmStep).require_human).toBe(true);
  });

  it('反例：未知中文步骤类型报错回显作者字面（不显归一名）', () => {
    const md = `# T
Id: t
## 目标
g
## 输出
- r: line  # r
## 步骤
1. [思考] X
  + → r: line  # r
`;
    const { errors } = parseSpec(md);
    expect(errors.some(e => e.message.includes('思考'))).toBe(true);
  });

  it('正例：其他（else 中文别名）统配位归一 default 且须居末', () => {
    const md = `# T
Id: t
## 目标
g
## 输出
- r: line  # r
## 步骤
1. [分支] 分流
  + → r: line  # r
  1.1. [条件(x > 0)] 正数
    + → r: line  # r
  1.2. [条件(其他)] 其他情况
    + → r: line  # r
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const branch = ast!.steps![0];
    expect(branch.step_type).toBe('branch');
    expect((branch.children![1] as any).condition).toBe('default');       // 其余→default 与 else 恒等价
  });

  it('正例：[探索 free] 中文别名与 free 属性正交（别名归一在前,属性解析在后）', () => {
    // @v: anc-rule-b7
    const { ast, errors } = parseSpec(`# T
Id: t
## Goal
g
## Steps
1. [探索 free] 自由干活
  + → r: text  # r
`);
    expect(errors).toHaveLength(0);
    expect(ast!.steps![0].step_type).toBe('act');
    expect((ast!.steps![0] as { free?: boolean }).free).toBe(true);
  });

  it('正例：[探索 开放] 全中文形态归一为 act free（free 中文词 开放,2026-08-26 作者定）', () => {
    // @v: anc-i18n-keyword-impl + anc-rule-b7
    const { ast, errors } = parseSpec(`# T
Id: t
## Goal
g
## Steps
1. [探索 开放] 自由干活
  + → r: text  # r
`);
    expect(errors).toHaveLength(0);
    expect(ast!.steps![0].step_type).toBe('act');
    expect((ast!.steps![0] as { free?: boolean }).free).toBe(true);
  });

  it('正例：术语表全谱表驱动——15 步骤词逐词归一+8 段头词逐词识别（漏词=静默失效,防表滞后）', () => {
    // 步骤类型 15 词（并行已退役为属性,两侧同报错另测;跳出/继续须 loop 内;条件须 branch 内——按各自最小合法宿主构造）
    const simple = { '推理': 'reason', '探索': 'act', '检查': 'check', '确认': 'confirm', '询问': 'ask',
      '提交': 'commit', '子任务': 'subtask', '循环': 'loop', '结束': 'exit' };
    for (const [zh, en] of Object.entries(simple)) {
      const { ast, errors } = parseSpec(`# T
Id: t
## Goal
g
## Steps
1. [${zh}] S
  + → r: line  # r
`);
      expect(errors, zh).toHaveLength(0);
      expect(ast!.steps![0].step_type, zh).toBe(en);
    }
    const nested = parseSpec(`# T
Id: t
## Goal
g
## Steps
1. [分支] b
  1.1. [条件(x > 0)] c
    1.1.1. [推理] r
      + → r: line  # r
2. [循环 上限=3] l
  2.1. [检查] k
  2.2. [跳出循环] out
  2.3. [继续循环] next
3. [调用 helper] call it
  + → r2  # r
`);
    expect(nested.errors).toHaveLength(0);
    expect(nested.ast!.steps![0].step_type).toBe('branch');
    expect(nested.ast!.steps![0].children![0].step_type).toBe('case');
    expect(nested.ast!.steps![1].step_type).toBe('loop');
    expect((nested.ast!.steps![1] as LoopStep).max_iterations).toBe(3);   // 上限=3 → max=3
    expect(nested.ast!.steps![1].children![1].step_type).toBe('break');
    expect(nested.ast!.steps![1].children![2].step_type).toBe('continue');
    expect(nested.ast!.steps![2].step_type).toBe('call');
    // 段头 8 词（标识 已单测;目标/输入/输出/步骤 已在 ZH_SPEC;约束/类型/配置 此处补齐）
    const full = parseSpec(`# T
标识: t
## 目标
g
## 约束
- 只读操作
## 类型
- 画像:
    名字: line
    分数: int
## 输入
- x: line  # in
## 输出
- r: line  # r
## 配置
- max_retries: 2
## 步骤
1. [推理] R
  - ← x
  + → r: line  # r
`);
    expect(full.errors).toHaveLength(0);
    expect(full.ast!.header.constraints).toEqual(['只读操作']);
    expect(full.ast!.header.types![0].name).toBe('画像');
    expect(full.ast!.header.config?.max_retries).toBe(2);
  });

  it('反例回归：变量名含关键词字串不被子串腐蚀（重试次数/并行度——归一纪律:词元级）', () => {
    const md = `# T
Id: t
## Goal
g
## Inputs
- 重试次数: int  # n
- 列表: [line]  # l
## Outputs
- r: [line]  # r
## Steps
1. [loop 遍历 并行度 于 列表, 收集 u 入 r] 扫
  + → r: [line]  # r
  1.1. [branch] 分流
    1.1.1. [条件(重试次数 > 3)] 超限
      + → u: line  # u
      1.1.1.1. [reason] j
        - ← 并行度, 重试次数
        + → u: line  # u
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const loop = ast!.steps![0] as LoopStep;
    expect(loop.forEach!.itemVar).toBe('并行度');                          // 不得腐蚀成 parallel度
    const cs = loop.children![0].children![0] as any;
    expect(cs.condition).toBe('重试次数 > 3');                             // 不得腐蚀成 retry次数
  });

  it('正例：中文属性尾巴经 条件(...) 通道归一（[情形(x>0) 重试=2 并行]）', () => {
    const md = `# T
Id: t
## Goal
g
## Outputs
- r: line  # r
## Steps
1. [branch] b
  + → r: line  # r
  1.1. [条件(x > 0) 重试=2 并行] c
    + → r: line  # r
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const cs = ast!.steps![0].children![0] as any;
    expect(cs.retry).toBe(2);
    expect(cs.parallel).toBe(true);
  });

  it('正例：内联标签形态中文段头（目标:/输出:/步骤:——独立面）', () => {
    const md = `# T
Id: t
目标: 找出问题
输出:
- r: line  # r
步骤:
1. [推理] R
  + → r: line  # r
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast!.header.goal).toBe('找出问题');
    expect(ast!.header.outputs).toHaveLength(1);
    expect(ast!.steps![0].step_type).toBe('reason');
  });

  it('正例：标识: 行签名形态（中文函数名+前缀双语剥离）', () => {
    const md = `# T
标识: 评估(客户) -> 结果
## Goal
g
## Steps
1. [reason] r
  + → 结果: line  # r
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast!.header.id).toBe('评估');
    expect(ast!.header.signature).toBe('评估(客户) -> 结果');
  });

  it('正例：中文 Inputs 名不再被静默吞行（RE_VAR_DECL 宽一档随批修）', () => {
    const md = `# T
Id: t
## Goal
g
## Inputs
- 客户列表: [line]  # 中文名
## Outputs
- r: line  # r
## Steps
1. [reason] R
  - ← 客户列表
  + → r: line  # r
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast!.header.inputs).toHaveLength(1);
    expect(ast!.header.inputs![0].name).toBe('客户列表');
  });
});

// @v: anc-step-break, anc-step-continue — 可选目标形态（方案 B 2026-08-16）：[break 5.2] 裸步骤号入 target_loop
describe('break/continue optional loop target', () => {
  const md = `# Test
## Steps
1. [loop max=3] Outer
  1.1. [loop max=3] Inner
    1.1.1. [break 1]
    1.1.2. [continue 1.1]
  1.2. [break]
`;
  it('parses bare step-number key into target_loop; bare form stays undefined', () => {
    const r = parseSpec(md);
    expect(r.errors).toEqual([]);
    const outer = r.ast!.steps[0] as { children: Array<{ children?: Array<{ step_type: string; target_loop?: string }>; target_loop?: string }> };
    const inner = outer.children[0].children!;
    expect(inner[0].target_loop).toBe('1');
    expect(inner[1].target_loop).toBe('1.1');
    expect((outer.children[1] as { target_loop?: string }).target_loop).toBeUndefined();
  });

  it('round-trips target through serializeSpec', () => {
    const r1 = parseSpec(md);
    const r2 = parseSpec(serializeSpec(r1.ast!));
    expect(r2.errors).toEqual([]);
    const outer = r2.ast!.steps[0] as { children: Array<{ children?: Array<{ target_loop?: string }> }> };
    expect(outer.children[0].children![0].target_loop).toBe('1');
    expect(outer.children[0].children![1].target_loop).toBe('1.1');
  });

  it('rejects multiple targets', () => {
    const bad = `# Test
## Steps
1. [loop max=3] Repeat
  1.1. [break 1 2]
`;
    const r = parseSpec(bad);
    expect(r.errors.some(e => e.message.includes('多个目标步骤号'))).toBe(true);
  });

  it('still rejects non-step-number bare keys on break', () => {
    const bad = `# Test
## Steps
1. [loop max=3] Repeat
  1.1. [break bogus]
`;
    const r = parseSpec(bad);
    expect(r.errors.some(e => e.message.includes('未知属性'))).toBe(true);
  });
});

// @v: anc-rule-fragment-mode — parseFragment 原生解析裸步骤片段（不拼头,报错行号=片段真实行）
describe('parseFragment: bare step fragment', () => {
  it('parses bare steps without title or Steps heading', () => {
    const frag = `1. [reason] 分析
  - ← upstream_data
  + → verdict: bool  # 判定
  > 按口径判
2. [act] 记录
  - ← verdict
  + → note: text  # 记录行
`;
    const r = parseFragment(frag);
    expect(r.errors).toEqual([]);
    expect(r.ast.steps!.length).toBe(2);
    expect(r.ast.steps![0].step_type).toBe('reason');
    expect(r.ast.header.title).toBe('(fragment)');
  });

  it('reports real fragment line numbers (no header offset)', () => {
    const frag = `1. [reason] ok
  + → x: bool  # f
2. [bogus] 坏类型
`;
    const r = parseFragment(frag);
    expect(r.errors.length).toBeGreaterThan(0);
    // 坏步骤在片段第 3 行——原生解析行号不偏移
    expect(r.errors.some(e => e.line === 3)).toBe(true);
  });

  it('rejects deep absolute-path numbering (fragment must start at 1)', () => {
    const r = parseFragment('3.2.1. [reason] 深层\n  + → y: bool  # 判\n  > 判\n');
    expect(r.errors.some(e => e.message.includes('non-existent parent'))).toBe(true);
  });

  it('rejects empty fragment with guidance', () => {
    const r = parseFragment('只是散文，没有步骤行\n');
    expect(r.errors.some(e => e.message.includes('无可解析步骤行'))).toBe(true);
  });
});

// 初值字面量:非空对象/列表按 JSON 解析（2026-08-17 hopissues/hoplogic3/0002——parseInitValue
// 原只认空 {}/[],hopkb 批量壳 tally 对象初值被静默存串,运行期 x["k"] 炸"非对象取下标"）。
// @v: anc-rule-init-value
describe('初值字面量 JSON 解析（对象/列表）', () => {
  const mk = (init: string) => `# T
Id: t
## Goal
g
## Outputs
- out: yaml  # o
## Steps
1. [loop max_iterations=3] 环
  + → tally: yaml = ${init}
  1.1. [act] a
    + → out: yaml  # o
    > \`\`\`hop_python
    > out = tally
    > \`\`\`
`;

  it('正例：非空对象初值 JSON 解析为真对象（hopkb 实撞形态）', () => {
    const { ast, errors } = parseSpec(mk('{"committed": 0, "skipped": 0}'));
    expect(errors).toHaveLength(0);
    const def = ast.steps![0].outputs![0].default as Record<string, unknown>;
    expect(typeof def).toBe('object');
    expect(def.committed).toBe(0);
  });

  it('正例：非空列表初值解析为真数组；空 {}/[] 与标量回归不变', () => {
    expect(Array.isArray(parseSpec(mk('[1, 2]')).ast.steps![0].outputs![0].default)).toBe(true);
    expect(parseSpec(mk('{}')).ast.steps![0].outputs![0].default).toEqual({});
    expect(parseSpec(mk('[]')).ast.steps![0].outputs![0].default).toEqual([]);
    expect(parseSpec(mk('0')).ast.steps![0].outputs![0].default).toBe(0);
  });

  it('反例：形似对象但坏 JSON（单引号键）→ parse error 指路,不静默存串', () => {
    const { errors } = parseSpec(mk("{'committed': 0}"));
    expect(errors.some(e => e.message.includes('不是合法 JSON'))).toBe(true);
    expect(errors.some(e => e.message.includes('双引号'))).toBe(true);   // 报文含改法
  });

  // serializer = 初值写回（v0.10.2 七审探针实抓——原全部 default 丢失,至少 v0.5.0 起:
  // 初值是语义子句〔累加器 init/每轮重置〕,丢失后 re-parse 语义不同,超出"格式不保真"豁免,
  // 与 v0.7.6 for-each 子句丢失同族;判据=AST 级往返,字符串级测不出）
  it('正例：serializeSpec 写回 = 初值——六形态 AST 级往返稳定', async () => {
    const { serializeSpec } = await import('../src/parser.js');
    for (const init of ['{"committed": 0}', '[1, 2]', '0', '""', 'Null', 'true']) {
      const p1 = parseSpec(mk(init));
      const p2 = parseSpec(serializeSpec(p1.ast));
      expect(p2.errors, init).toHaveLength(0);
      expect(JSON.stringify(p2.ast.steps![0].outputs![0].default), init)
        .toBe(JSON.stringify(p1.ast.steps![0].outputs![0].default));
    }
  });
});

// @v: anc-rule-unclosed-fence —— 未闭合围栏响亮拒（P1/P2 处置批复审抓,静默吞家族）
describe('未闭合围栏响亮拒', () => {
  it('反例：步骤节内裸围栏只开不闭 → parse error 带开栏行号,其后步骤不静默蒸发（修前 AST 只剩前半且 errors 空）', () => {
    const SPEC = `# T
Id: t

## Goal
g

## Outputs
- r: text  # r

## Steps
1. [act] 甲
  + → a: text  # a
\`\`\`
这里围栏没闭
2. [act] 乙
  + → r: text  # r
`;
    const { errors } = parseSpec(SPEC);
    const fenceErr = errors.find(e => e.message.includes('围栏未闭合'));
    expect(fenceErr).toBeDefined();
    expect(fenceErr!.message).toContain('截断');           // 指路检查产物截断
  });

  it('反例：parseFragment 片段未闭围栏同拒（replan 产物截断是现实形态）', () => {
    const frag = '1. [act] 甲\n  + → a: text  # a\n\`\`\`\n未闭\n2. [act] 乙\n  + → b: text  # b';
    const { errors } = parseFragment(frag);
    expect(errors.some(e => e.message.includes('围栏未闭合'))).toBe(true);
  });

  it('正例：配对围栏照常零错（不误伤既有形态,含 body 围栏与裸围栏）', () => {
    const SPEC = `# T
Id: t

## Goal
g

## Outputs
- r: text  # r

## Steps
1. [act] 甲
  + → r: text  # r
  > \`\`\`hop_python
  > r = "x"
  > \`\`\`
`;
    const { errors } = parseSpec(SPEC);
    expect(errors).toEqual([]);
  });
});

// [subtask free] 到步展开档（^anc-step-subtask-free,2026-08-27）——parse 双语+S5 豁免+往返。
// @v: anc-step-subtask-free, anc-rule-s5
describe('[subtask free] 到步展开档', () => {
  const mk = (typeTag: string) => `# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [reason] 前面
  + → a: text  # p
2. [${typeTag}] 到步展开
  - ← a
  + → out: text  # o
`;

  it('正例：[subtask free] 空 children parse+validate 双绿（S5 豁免）,free 入 AST,serialize 往返保留', () => {
    const { ast, errors } = parseSpec(mk('subtask free'));
    expect(errors).toHaveLength(0);
    const st = ast!.steps![1] as SubtaskStep;
    expect(st.free).toBe(true);
    expect(st.children).toHaveLength(0);
    expect(validateSpec(ast!).filter(e => e.severity === 'error')).toHaveLength(0);
    const round = parseSpec(serializeSpec(ast!));
    expect((round.ast!.steps![1] as SubtaskStep).free).toBe(true);   // 丢写=降级撞 S5
  });

  it('正例：[子任务 开放] 全中文归一同语义', () => {
    const { ast, errors } = parseSpec(mk('子任务 开放'));
    expect(errors).toHaveLength(0);
    const st = ast!.steps![1] as SubtaskStep;
    expect(st.step_type).toBe('subtask');
    expect(st.free).toBe(true);
    expect(validateSpec(ast!).filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('反例：非 free 空 subtask 照拒 S5（豁免不外溢）', () => {
    const { ast } = parseSpec(mk('subtask'));
    const errs = validateSpec(ast!);
    expect(errs.some(e => e.rule === 'S5')).toBe(true);
  });
});

// TypeDecl # 注释入 AST（2026-08-27 作者定"jit 不需要注释,llm 需要"——原 parser 静默丢弃,
// 作者按宪法写的字段语义执行 LLM 收不到,fact-check CheckPoint.premises 纪律供给面蒸发实撞）
// @v: anc-type-type-decl
describe('Types 段 # 注释捕获与往返', () => {
  const SRC = `# T
Id: t-desc
Goal: g
Types:
- CheckPoint:  # 一个待核查点
  - id: line  # 点编号（P1/P2…）
  - claim: text  # 待核查的断言
  - bare: line
## Steps
1. [reason] r
  + → out: text  # o
`;

  it('正例：类型级与字段级注释入 description/field_descriptions,无注释字段缺席', () => {
    const r = parseSpec(SRC);
    expect(r.errors).toHaveLength(0);
    const t = r.ast!.header.types![0];
    expect(t.description).toBe('一个待核查点');
    expect(t.field_descriptions).toEqual({ id: '点编号（P1/P2…）', claim: '待核查的断言' });
    expect('bare' in (t.field_descriptions ?? {})).toBe(false);   // 无注释不注水
    expect(t.fields).toEqual({ id: 'line', claim: 'text', bare: 'line' });   // 类型词不受注释影响
  });

  it('正例：serialize 回写带注释,re-parse 往返不丢', () => {
    const r1 = parseSpec(SRC);
    const out = serializeSpec(r1.ast!);
    expect(out).toContain('CheckPoint:  # 一个待核查点');
    expect(out).toContain('id: line  # 点编号（P1/P2…）');
    const r2 = parseSpec(out);
    const t2 = r2.ast!.header.types![0];
    expect(t2.description).toBe('一个待核查点');
    expect(t2.field_descriptions).toEqual(r1.ast!.header.types![0].field_descriptions);
  });

  it('反例：全无注释的类型,description/field_descriptions 双缺席（旧 spec 零形态变化）', () => {
    const r = parseSpec(`# T
Id: t-plain
Goal: g
Types:
- Pt:
  - x: line
## Steps
1. [reason] r
  + → out: text  # o
`);
    const t = r.ast!.header.types![0];
    expect(t.description).toBeUndefined();
    expect(t.field_descriptions).toBeUndefined();
  });
});

// 内容章节缺省供给（^anc-rule-narrative-sections 2026-08-27 作者三连定:"内容章节就是缺省要供给
// 的内容"/"不只是背景"/"处置记录垃圾集散地除外"→通用(不供给)标记）。
// @v: anc-rule-narrative-sections
describe('内容章节收集', () => {
  const NS = `# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [reason] 干
  + → out: text  # o

## 背景
口径甲

## 任意名章节
不限背景——节名无白名单

## 处置记录(不供给)
- 流水账
`;
  it('正例：非关键字##节收集入AST(任意名),带(不供给)标记排除,原文字节', () => {
    const { ast, errors } = parseSpec(NS);
    expect(errors).toHaveLength(0);
    const ns = ast!.header.narrative_sections!;
    expect(ns.map(n => n.title)).toEqual(['背景', '任意名章节']);
    expect(ns[0].content).toBe('口径甲');
  });

  it('正例：serialize 往返保留内容章节（丢写=镜像语境蒸发）', () => {
    const { ast } = parseSpec(NS);
    const round = parseSpec(serializeSpec(ast!));
    expect(round.ast!.header.narrative_sections!.map(n => n.title)).toEqual(['背景', '任意名章节']);
  });

  it('反例：含步骤行的非关键字节=标题风分区不收（既有契约不被侵占）', () => {
    const md = `# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Task
1. [reason] 标题风步骤
  + → out: text  # o
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast!.header.narrative_sections).toBeUndefined();
    // 注:无 ## Steps 段头时步骤本就不解析(HopTrait 形态既有行为,git stash 对照核实)——
    // 本反例只锁"含步骤行的节不被收为内容章节",标题风契约本体归 ^anc-rule-surface-heading-flavor 既有测试
  });

  it('反例：无内容章节的既有spec零变化(字段缺席不注水)', () => {
    const { ast } = parseSpec(MINIMAL_SPEC);
    expect(ast!.header.narrative_sections).toBeUndefined();
  });

  it('正例：惯例名单——干净标题 ## 处置记录 直接排除,免带标记（A 案双轨,2026-08-29 作者抓"(不供给)进标题很蠢"）', () => {
    const { ast } = parseSpec(NS.replace('## 处置记录(不供给)', '## 处置记录'));
    const titles = (ast!.header.narrative_sections ?? []).map(n => n.title);
    expect(titles).not.toContain('处置记录');
    expect(titles).toContain('背景');   // 供给面不受名单影响
  });

  it('反例：近似名不入名单——## 处置记录摘要 照常收集（名单是精确等于,不是前缀匹配）', () => {
    const { ast } = parseSpec(NS.replace('## 处置记录(不供给)', '## 处置记录摘要'));
    const titles = (ast!.header.narrative_sections ?? []).map(n => n.title);
    expect(titles).toContain('处置记录摘要');
  });

  it('正例：全角括号（不供给）同排除', () => {
    const { ast } = parseSpec(NS.replace('## 处置记录(不供给)', '## 处置记录（不供给）'));
    expect(ast!.header.narrative_sections!.every(n => !n.title.includes('处置记录'))).toBe(true);
  });
});

// 阅卷两漂移回归钉（^anc-rule-narrative-sections——###内容蒸发/%%块伪节）。
// @v: anc-rule-narrative-sections
describe('内容章节边角（阅卷实锤修）', () => {
  it('正例：## 节内 ### 子节全文并入不蒸发,往返字节保全（修前红:###掐断+序列化丢失）', () => {
    const md = `# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [reason] 干
  + → out: text  # o

## 背景
上半段

### 子节
子节内容
`;
    const { ast } = parseSpec(md);
    const ns = ast!.header.narrative_sections!;
    expect(ns).toHaveLength(1);
    expect(ns[0].content).toContain('### 子节');
    expect(ns[0].content).toContain('子节内容');
    const round = parseSpec(serializeSpec(ast!));
    expect(round.ast!.header.narrative_sections![0].content).toContain('子节内容');
  });

  it('反例：%% @trace 块内 ## 不被误收伪节（修前红）', () => {
    const md = `%%
@trace
## 伪节在注释块
%%
# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [reason] 干
  + → out: text  # o
`;
    const { ast } = parseSpec(md);
    expect(ast!.header.narrative_sections).toBeUndefined();
  });
});

// 排除标记宽容匹配（作者抓位置陷阱:模板节名行标记后跟注释列,尾匹配照抄即静默失效）。
// @v: anc-rule-narrative-sections
describe('排除标记位置宽容', () => {
  it('正例：标记后带尾巴（照抄模板注释列形态）仍排除（修前红:尾匹配失效垃圾被供给）', () => {
    const md = `# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [reason] 干
  + → out: text  # o

## 处置记录(不供给) 补充说明尾巴
- 流水一条
`;
    const { ast } = parseSpec(md);
    expect(ast!.header.narrative_sections).toBeUndefined();
  });
});

// 围栏优先序回归钉（阅卷复判实锤:%%先判引入本批新回归——围栏内%%翻转注释块,内容截断+往返硬错）。
// @v: anc-rule-narrative-sections
describe('内容章节围栏优先序', () => {
  it('正例：围栏内 %% 不触发注释块状态机——内容全保,往返零错误（修前红:截断+未闭合围栏硬错）', () => {
    const md = `# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [reason] 干
  + → out: text  # o

## 背景
围栏含百分号:
\`\`\`
%%
@trace 示例
%%
\`\`\`
围栏后内容
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const ns = ast!.header.narrative_sections!;
    expect(ns[0].content).toContain('@trace 示例');
    expect(ns[0].content).toContain('围栏后内容');
    const round = parseSpec(serializeSpec(ast!));
    expect(round.errors).toHaveLength(0);   // 往返零硬错
    expect(round.ast!.header.narrative_sections![0].content).toContain('围栏后内容');
  });
});

// 声明区孤儿行→W1 warn（^anc-rule-decl-zone-warn,todo/0016 作者定"做吧"——全角冒号一刀）
// @v: anc-rule-decl-zone-warn
describe('声明区文法警告 W1（decl_zone_orphans）', () => {
  const wrap = (declZone: string) => `# Spec: T
Id: t
Goal: g

${declZone}

## Steps
1. [reason] 干
  + → out: text
`;
  const w1 = (md: string) => {
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);   // parser 半边零报错(收集不拒收)
    return validateSpec(ast!).filter(e => e.rule === 'W1');
  };

  it('反例：Inputs 全角冒号声明行→W1 warn 且点名全角标点（修前:整行静默蒸发零警告）', () => {
    const warns = w1(wrap('## Inputs\n- 城市：text'));
    expect(warns).toHaveLength(1);
    expect(warns[0].severity).toBe('warn');
    expect(warns[0].message).toContain('Inputs');
    expect(warns[0].message).toContain('城市');
    expect(warns[0].message).toContain('全角标点');
  });

  it('反例：Outputs 缺类型位的裸名行→W1 warn（不含全角时无标点点名）', () => {
    const warns = w1(wrap('## Outputs\n- report_only_name'));
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('Outputs');
    expect(warns[0].message).not.toContain('全角标点');
  });

  it('反例：Types 段字段行全角冒号→W1 warn 归 Types 段', () => {
    const warns = w1(wrap('## Types\n- Claim:\n  text：text'));
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('Types');
  });

  it('反例：Id 行全角冒号→spec 无 id 且 W1 点名 Id 行', () => {
    const md = `# Spec: T
Id：demo-quanjia
Goal: g

## Steps
1. [reason] 干
  + → out: text
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    expect(ast!.header.id).toBeUndefined();
    const warns = validateSpec(ast!).filter(e => e.rule === 'W1');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('Id');
  });

  it('反例：Constraints 行漏 `- ` 前缀→W1 warn（整条约束原静默蒸发）', () => {
    const warns = w1(wrap('## Constraints\n- 正常约束一条\n漏了短横线的约束'));
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('Constraints');
    expect(warns[0].message).toContain('漏了短横线');
  });

  it('反例：Config 键全角冒号→W1 warn（原静默丢键,运行时按缺省走）', () => {
    const warns = w1(wrap('## Config\nexpansion_max：20'));
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('Config');
    expect(warns[0].message).toContain('全角标点');
  });

  it('正例：Config 合法键行（裸键/- 前缀/嵌套 models 条目）零 W1', () => {
    const warns = w1(wrap('## Config\nexpansion_max: 20\n- retry_max: 3\nmodels:\n  - reason: fast'));
    expect(warns).toHaveLength(0);
  });

  it('正例：合法声明+空行+纯#注释+Types 嵌套字段全豁免,零 W1', () => {
    const warns = w1(wrap(`## Inputs
- city: text  # 城市名

# 这是纯注释行
- n: int

## Outputs
- report: markdown

## Types
- Claim:
  text: text
  tier: text`));
    expect(warns).toHaveLength(0);
  });

  it('反例：Steps 区流浪散文行→W1 warn（Steps 扩围,作者令"这个也修掉"——原静默丢弃）', () => {
    const md = wrap('## Inputs\n- city: text') + 'Steps 区内流浪文字：全角也点名\n';
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const warns = validateSpec(ast!).filter(e => e.rule === 'W1');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('Steps');
    expect(warns[0].message).toContain('全角标点');
  });

  it('反例：Outputs 箭头 ASCII 误写 `+ ->`→W1 warn（探底形态③——原静默丢输出声明）', () => {
    const md = wrap('## Inputs\n- city: text').replace('+ → out: text', '+ → out: text\n  + -> extra: text');
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const warns = validateSpec(ast!).filter(e => e.rule === 'W1');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('->');
  });

  it('正例：Steps 后叙事节（## 使用说明 散文）与 Steps 区 # 注释行不触发 W1（停收闸+注释豁免）', () => {
    const md = wrap('## Inputs\n- city: text') + '# 顶层散文注释（call-parent-summarize 惯用形态）\n\n## 使用说明\n这里的散文自由写：全角不点名（），叙事节合法。\n';
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const warns = validateSpec(ast!).filter(e => e.rule === 'W1');
    expect(warns).toHaveLength(0);
  });

  // serializer 三形态分写往返钉（^anc-rule-serialize-output-forms——S4 豁免格式不豁免语义）
  // @v: anc-rule-serialize-output-forms
  it('正例：裸名输出（更新模式）serialize 后仍是裸名,往返 AST 等价（修前写 `name: ` 漂移成 yaml 复合头）', () => {
    const md = `# T
Id: t
Goal: g

## Outputs
- findings: yaml  # acc

## Steps
1. [loop max=3] 累
  + → findings: yaml  # 延续
  1.1. [reason] 加一条
    + → findings
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const ser = serializeSpec(ast!);
    expect(ser).toMatch(/\+ → findings\n|\+ → findings$/m);   // 裸名无尾冒号
    const round = parseSpec(ser);
    const n = (x: unknown) => JSON.stringify(x, (k, v) => (k === 'source_location' ? undefined : v));
    expect(n(round.ast)).toBe(n(ast));
  });

  it('正例：复合输出（fields 展开）serialize 保 fields,往返 AST 等价（修前写 `name: yaml` 丢字段）', () => {
    const md = `# T
Id: t
Goal: g

## Outputs
- report: yaml  # r

## Steps
1. [act] assemble
  + → report:
    - total: int  # 总数
    - note: line
  > fill fields
`;
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const ser = serializeSpec(ast!);
    expect(ser).toContain('- total: int');
    const round = parseSpec(ser);
    const n = (x: unknown) => JSON.stringify(x, (k, v) => (k === 'source_location' ? undefined : v));
    expect(n(round.ast)).toBe(n(ast));
  });

  it('正例：f-string 插值内字符串写单引号,含索引取键的 body 往返零错误（修前双引号撞栏 re-parse 炸）', () => {
    const md = ['# T', 'Id: t', 'Goal: g', '', '## Inputs', '- xs: [yaml]  # in', '## Outputs', '- r: text  # r',
      '## Steps', '1. [act] fmt', '  - ← xs', '  + → r: text  # r',
      '  > ```hop_python', '  > r = f"{xs[0][\'k\']} end"', '  > ```', ''].join('\n');
    const { ast, errors } = parseSpec(md);
    expect(errors).toHaveLength(0);
    const ser = serializeSpec(ast!);
    expect(ser).toContain("['k']");   // 单引号形态,不是 [\"k\"]
    const round = parseSpec(ser);
    expect(round.errors).toHaveLength(0);
  });

  // @v: anc-rule-unclosed-fence —— 指令级围栏配对（文档级已有钉,此为 0016 第二批扩展面）
  it('反例：hop_python 指令围栏开了没关→响亮 parse error（原静默接受,闭栏删除不可见）', () => {
    const md = ['# Spec: T', 'Id: t', 'Goal: g', '', '## Steps', '1. [act] 算',
      '  + → out: text', '  > ```hop_python', '  > out = "x"', ''].join('\n');
    const { errors } = parseSpec(md);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.message.includes('围栏未闭合'))).toBe(true);
  });
});

// @v: anc-step-tool-grant —— 节点工具授权条目（0054,作者 B 案:每工具一行+意图注释;变异实证:
// RE_TOOL_GRANT 删除下方正例必红——条目行会被 RE_VAR_DECL 族收编或静默掉）
describe('节点工具授权条目 - 工具:（0054）', () => {
  const mk = (lines: string) => `# T
Id: t
## Goal
g
## Steps
1. [act free] 干活
${lines}
  + → r: text  # r
  > t
`;

  it('正例：每工具一行收进 tool_grants,意图注释入 note,中英键与全半角冒号同收', () => {
    const { ast, errors } = parseSpec(mk(`  - 工具: pdf_extract  # 提取合同页
  - tools: ocr_image
  - 工具：spec_probe`));
    expect(errors).toHaveLength(0);
    const g = (ast.steps![0] as any).tool_grants;
    expect(g).toEqual([
      { name: 'pdf_extract', note: '提取合同页' },
      { name: 'ocr_image' },
      { name: 'spec_probe' },
    ]);
  });

  it('正例：* 全量授权', () => {
    const { ast, errors } = parseSpec(mk('  - 工具: *'));
    expect(errors).toHaveLength(0);
    expect((ast.steps![0] as any).tool_grants).toEqual([{ name: '*' }]);
  });

  it('反例：一行多名逗号分隔 → parse error 指路每行一个', () => {
    const { errors } = parseSpec(mk('  - 工具: pdf_extract, ocr_image'));
    expect(errors.some(e => /每行恰一个工具名/.test(e.message))).toBe(true);
  });

  // reason 扩员（^anc-exec-reason-tools 2026-09-01 作者拍"等同于 act 的能力,不能 commit 写"——
  // 旧反例"reason 无工具面"随概念层改定翻正）。 // @v: anc-exec-reason-tools
  it('正例：reason 步带授权行合法收进 tool_grants（2026-09-01 扩员,旧形态报 parse error）', () => {
    const src = `# T
Id: t
## Goal
g
## Steps
1. [reason] 想
  - 工具: pdf_extract  # 读合同页再推理
  + → r: text  # r
  > t
`;
    const { ast, errors } = parseSpec(src);
    expect(errors).toHaveLength(0);
    expect((ast.steps![0] as any).tool_grants).toEqual([{ name: 'pdf_extract', note: '读合同页再推理' }]);
  });

  it('反例：check 步带授权行 → parse error 指路（判官纯判定无工具面,reason 扩员不及 check）', () => {
    const src = `# T
Id: t
## Goal
g
## Steps
1. [check] 判
  - 工具: pdf_extract
  - ← r
  + → ok: bool  # 判
  + → note: text  # 说明
`;
    const { errors } = parseSpec(src);
    expect(errors.some(e => /仅 act\/reason 步骤可用/.test(e.message))).toBe(true);
  });
});

// @v: anc-step-tool-deny —— 节点工具禁用条目（^anc-step-tool-deny 2026-09-05 作者拍"是不是可以在
// 指定节点禁止 write tool"——授权行对称半边,管辖面更宽:能关任意工具含 basic 族;禁 * / 同名授禁冲突拒）
describe('节点工具禁用条目 - 禁工具:', () => {
  const mk = (lines: string) => `# T
Id: t
## Goal
g
## Steps
1. [act free] 干活
${lines}
  + → r: text  # r
  > t
`;

  it('正例：每工具一行收进 tool_denies,原因注释入 note,中英键同收', () => {
    const { ast, errors } = parseSpec(mk(`  - 禁工具: write  # 修错步禁整文件覆盖
  - deny_tools: append`));
    expect(errors).toHaveLength(0);
    const d = (ast.steps![0] as any).tool_denies;
    expect(d).toEqual([
      { name: 'write', note: '修错步禁整文件覆盖' },
      { name: 'append' },
    ]);
  });

  it('反例：一行多名逗号分隔 → parse error 指路每行一个', () => {
    const { errors } = parseSpec(mk('  - 禁工具: write, append'));
    expect(errors.some(e => /工具禁用行每行恰一个工具名/.test(e.message))).toBe(true);
  });

  it('反例：空名拒（缺工具名指路写法）', () => {
    const { errors } = parseSpec(mk('  - 禁工具:   # 只有注释没有名'));
    expect(errors.some(e => /工具禁用行缺工具名/.test(e.message))).toBe(true);
  });

  it('反例：* 全量禁拒（真要如此逐件列名——防一行废掉整个工具面;授权行 * 合法有意不对称）', () => {
    const { errors } = parseSpec(mk('  - 禁工具: *'));
    expect(errors.some(e => /不接受 \*/.test(e.message))).toBe(true);
  });

  it('反例：check 步带禁用行 → parse error（消费面与授权行同族:仅 act/reason）', () => {
    const src = `# T
Id: t
## Goal
g
## Steps
1. [check] 判
  - 禁工具: write
  - ← r
  + → ok: bool  # 判
  + → note: text  # 说明
`;
    const { errors } = parseSpec(src);
    expect(errors.some(e => /带工具禁用行（- 禁工具:）——该条目仅 act\/reason 步骤可用/.test(e.message))).toBe(true);
  });

  it('反例：同名既授又禁 → parse error 点名工具名（冲突即笔误当场打回）', () => {
    const { errors } = parseSpec(mk(`  - 工具: pdf_extract  # 提取合同页
  - 禁工具: pdf_extract  # 又禁它`));
    expect(errors.some(e => /工具 "pdf_extract" 同时出现在授权行与禁用行/.test(e.message))).toBe(true);
  });

  it('正例：reason 步带禁用行合法收进 tool_denies（消费面同授权行）', () => {
    const src = `# T
Id: t
## Goal
g
## Steps
1. [reason] 想
  - 禁工具: write  # 推理步禁写盘
  + → r: text  # r
  > t
`;
    const { ast, errors } = parseSpec(src);
    expect(errors).toHaveLength(0);
    expect((ast.steps![0] as any).tool_denies).toEqual([{ name: 'write', note: '推理步禁写盘' }]);
  });
});



// hopissues/0080——100KB 硬上限被真实业务 spec 触顶(报告方 100,558 字节被拒,被迫压缩到
// 99,776 牺牲可读性),违背"只做异常输入防护不是业务约束"定位;报文只报阈值不报实况。
// 修=上限 1MB+报文带实际字节数。// @v: anc-rule-input-guard
describe('输入大小上限(0080)', () => {
  const pad = (n: number) => {
    const base = '# Big\n## Goal\nG\n## Steps\n1. [reason] 步\n  + → out1: text  # 产出\n  > do\n';
    return base + '\n<!-- ' + 'x'.repeat(n - base.length - 10) + ' -->\n';
  };
  it('正例：100KB<x<1MB 的 spec 进语义校验（修前被一刀切拒收——卡场景 100,558 字节）', () => {
    const md = pad(150 * 1024);
    const { errors } = parseSpec(md);
    expect(errors.some(e => e.message.includes('exceeds'))).toBe(false);
  });
  it('反例：超 1MB 仍拒且报文带实际字节数（防御语义保留,报文不再只报阈值）', () => {
    const md = pad(1024 * 1024 + 100);
    const { errors } = parseSpec(md);
    const hit = errors.find(e => e.message.includes('exceeds'));
    expect(hit).toBeTruthy();
    expect(hit!.message).toMatch(/actual: \d+ bytes/);
  });
  it('反例：parseFragment 侧超 1MB 同拒且报文带实际字节数（两报文点改了两处,一处一钉防账面不对称——review 面三变异实证此侧原零钉）', () => {
    const frag = '1. [reason] 步\n  + → out1: text  # 产出\n  > do\n<!-- ' + 'x'.repeat(1024 * 1024) + ' -->\n';
    const { errors } = parseFragment(frag);
    const hit = errors.find(e => e.message.includes('exceeds'));
    expect(hit).toBeTruthy();
    expect(hit!.message).toMatch(/actual: \d+ bytes/);
  });
});
