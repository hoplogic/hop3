// @module: exec-engine ^anc-struct-exec-engine
// @v: anc-exec-foreach-serial —— 嵌套 loop 累加器合并(2026-08-09 hopkb construct 实撞 B1/B2)
// 2026-08-09 collect 子句重构后:旧崩溃场景(嵌套同名累加器)已被静态拒绝(V2 同名异型)——
// 结构性消除自引用;等价合法写法(collect+异名内层累加器)验证运行时零自引用。
import { describe, it, expect } from 'vitest';
import { ExecutionEngine } from '../src/engine.js';
import type { HostConfig } from '../src/provider-types.js';

const HOST: HostConfig = {
  workspace_dir: '/tmp/test',
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'k',
};

describe('B1史锚: 旧嵌套同名累加器写法被静态拒绝', () => {
  it('外层collect列表与内层同名累加器 → V2 同名异型 error(自引用崩溃结构性不可能)', () => {
    const SPEC_OLD = `# B1old
## Goal
g
## Inputs
- points: [text]
## Outputs
- item_result: [text]
## Steps
1. [loop for-each pt in points, collect unit into item_result] 逐点
  + → item_result: [text]
  1.1. [subtask retry=1] 处理
    - ← pt
    + → done_flag: text
    1.1.1. [loop max_iterations=2] 起草预检
      + → item_result: text = ""
      1.1.1.1. [reason] 起草
        - ← pt
        + → unit: text
        > draft
    1.1.2. [reason] 收尾
      + → done_flag: text
      > wrap
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC_OLD, HOST, { params: { points: ['p1'] } } as any);
    expect(init.status).toBe('error');   // 内层 text 累加器撞外层 [text] 列表 → V2
    expect((init as any).errors.some((e: any) => e.rule === 'V2')).toBe(true);
  });
});

describe('collect 子句: 嵌套 loop 合法形态零自引用', () => {
  const SPEC = `# B1new
## Goal
g
## Inputs
- points: [text]
## Outputs
- item_result: [text]
## Steps
1. [loop for-each pt in points, collect unit into item_result] 逐点
  + → item_result: [text]
  1.1. [subtask retry=1] 处理
    - ← pt
    + → done_flag: text
    1.1.1. [loop max_iterations=2] 起草预检
      + → draft_acc: text = ""
      1.1.1.1. [reason] 起草
        - ← pt
        - ← draft_acc
        + → draft_acc: text
        + → unit: text
        > draft
      1.1.1.2. [branch] 判
        1.1.1.2.1. [case] default
          1.1.1.2.1.1. [break]
    1.1.2. [reason] 收尾
      + → done_flag: text
      > wrap
`;

  it('break 退出路径:外层收集无自引用(B1 场景等价重写)', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, HOST, { params: { points: ['p1', 'p2'] } } as any);
    expect(init.status).toBe('ok');
    let guard = 0;
    for (;;) {
      if (++guard > 60) throw new Error('loop guard');
      const r = engine.nextStep();
      if (r.status === 'step_ready') {
        const sid = (r as any).step_id as string;
        engine.completeStep(sid, sid.endsWith('1.1.1.1')
          ? { draft_acc: 'd' + guard, unit: 'u' + guard }
          : { done_flag: 'ok' });
      } else break;
    }
    const out = engine.getVariableStore().read('item_result', 'root');
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(Array.isArray(out)).toBe(true);
    for (const el of out as unknown[]) expect(el).not.toBe(out);
  });

  it('迭代耗尽路径:合并无栈溢出、持久化可序列化(B2 场景等价重写)', () => {
    const SPEC2 = SPEC.replace(`      1.1.1.2. [branch] 判
        1.1.1.2.1. [case] default
          1.1.1.2.1.1. [break]
`, `      1.1.1.2. [reason] 记skip
        + → skip_note: text
        > note
`);
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC2, HOST, { params: { points: ['p1', 'p2'] } } as any);
    expect(init.status).toBe('ok');
    let guard = 0;
    for (;;) {
      if (++guard > 90) throw new Error('loop guard');
      const r = engine.nextStep();
      if (r.status !== 'step_ready') break;
      const sid = (r as any).step_id as string;
      const out = sid.endsWith('1.1.1.1') ? { draft_acc: 'd' + guard, unit: 'u' + guard }
        : sid.endsWith('1.1.1.2') ? { skip_note: 's' + guard }
        : { done_flag: 'ok' };
      engine.completeStep(sid, out);
    }
    const out = engine.getVariableStore().read('item_result', 'root');
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(() => JSON.stringify(engine.getVariableStore().getAllVariables())).not.toThrow();
  });
});

// @v: anc-exec-foreach-serial —— 串行 for-each 三种导出并存(collect/末值/累加器)
describe('串行 for-each 三种导出并存', () => {
  const SPEC3 = `# T3
## Goal
g
## Inputs
- points: [text]
## Outputs
- results: [text]
- last_status: text
## Steps
1. [loop for-each pt in points, collect r into results] 逐点
  + → results: [text]
  + → last_status: text
  1.1. [reason] 处理
    - ← pt
    + → r: text
    + → last_status: text
    > work
`;

  it('collect 走收集、普通 T 留末值——两种导出同容器并存', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC3, HOST, { params: { points: ['p1', 'p2'] } } as any);
    expect(init.status).toBe('ok');
    let n = 0;
    for (;;) {
      const r = engine.nextStep();
      if (r.status !== 'step_ready') break;
      n++;
      engine.completeStep((r as any).step_id, { r: 'r' + n, last_status: 'status-' + n });
      if (n > 10) throw new Error('guard');
    }
    const vs = engine.getVariableStore();
    expect(vs.read('results', 'root')).toEqual(['r1', 'r2']);      // collect 收集
    expect(vs.read('last_status', 'root')).toBe('status-2');       // 普通末值
  });
});
