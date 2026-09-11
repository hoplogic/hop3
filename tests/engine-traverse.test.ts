// @module: exec-engine ^anc-struct-exec-engine （子模块 traverse 独立覆盖）
// @v: anc-exec-dfs-traversal, anc-exec-parallel-confirm-exclude
// engine-traverse 纯函数单测——dfs/parallel 收集是 bug 高发区,直接测纯函数(注意力自足),
// 不只靠 engine.test 间接覆盖。
import { describe, it, expect } from 'vitest';
import {
  collectDescendants, evaluateCondition,
} from '../src/engine-traverse.js';
import { VariableStore } from '../src/ast-runtime.js';
import type { SpecAST, StepNode, SubtaskStep, BranchStep, CaseStep, ParallelStep } from '../src/ast-types.js';

// 旧通道 subtreeContainsPausePoint 已删（P0.5：批量 fan-out 排除机制随通道退役——
// 统一模型下标注子树内 HITL 走 PARALLEL_HITL_TODO 占位收割）。
describe('collectDescendants', () => {
  it('叶子无后代', () => {
    expect(collectDescendants({ step_id: '1', step_type: 'reason', summary: '' } as StepNode)).toEqual([]);
  });
  it('递归收集所有后代', () => {
    const sub: SubtaskStep = { step_id: '1', step_type: 'subtask', summary: '', children: [
      { step_id: '1.1', step_type: 'subtask', summary: '', children: [
        { step_id: '1.1.1', step_type: 'reason', summary: '' } as StepNode,
      ] } as SubtaskStep,
      { step_id: '1.2', step_type: 'act', summary: '' } as StepNode,
    ] };
    const ids = collectDescendants(sub).map(s => s.step_id).sort();
    expect(ids).toEqual(['1.1', '1.1.1', '1.2']);
  });
});

describe('evaluateCondition（case 条件求值）', () => {
  const vars = new VariableStore({ mode: 'doc', flag: '' });
  it('空条件 → true（default case）', () => {
    expect(evaluateCondition(undefined, vars, 'root')).toBe(true);
    expect(evaluateCondition('  ', vars, 'root')).toBe(true);
  });
  it('== 相等匹配', () => {
    expect(evaluateCondition('mode == "doc"', vars, 'root')).toBe(true);
    expect(evaluateCondition('mode == "theme"', vars, 'root')).toBe(false);
  });
  it('!= 不等匹配', () => {
    expect(evaluateCondition('mode != "theme"', vars, 'root')).toBe(true);
    expect(evaluateCondition('mode != "doc"', vars, 'root')).toBe(false);
  });
  it('裸变量名走 isTruthy', () => {
    expect(evaluateCondition('mode', vars, 'root')).toBe(true);   // 'doc' truthy
    expect(evaluateCondition('flag', vars, 'root')).toBe(false);  // '' falsy
  });
  it('{var} 花括号语法', () => {
    expect(evaluateCondition('{mode} == "doc"', vars, 'root')).toBe(true);
  });

  // 2026-08-10 作者定：内置 pure 函数条件可用；非 pure 调用折计算异常（branch fail 路径）
  describe('内置 pure 函数', () => {
    const pv = new VariableStore({ items: ['a', 'b', 'c'], note: '  x  ' });
    it('len/in/not in 求值正确', () => {
      expect(evaluateCondition('len(items) > 2', pv, 'root')).toBe(true);
      expect(evaluateCondition('len(items) > 5', pv, 'root')).toBe(false);
      expect(evaluateCondition('"b" in items', pv, 'root')).toBe(true);
      expect(evaluateCondition('len(items) == 0', pv, 'root')).toBe(false);
    });
    it('非 pure（未知名）调用 → 计算异常（error 对象，branch fail）', () => {
      const r = evaluateCondition('fetch_data(items) > 0', pv, 'root');
      expect(typeof r).toBe('object');
      expect((r as { error: string }).error).toContain('pure');
    });
  });

  // dotted path 成员访问：for-each 对象元素按字段分流（如 point.type）。见 design ^anc-exec-dfs-traversal 条件求值
  describe('dotted path 成员访问', () => {
    const dv = new VariableStore({
      point: { id: 'P1', type: 'fact', claim: 'x', premises: '' },
      nested: { a: { b: 'deep' } },
      flat: 'v',
    });
    it('对象字段访问：point.type == "fact"', () => {
      expect(evaluateCondition('point.type == "fact"', dv, 'root')).toBe(true);
      expect(evaluateCondition('point.type == "inference"', dv, 'root')).toBe(false);
      expect(evaluateCondition('{point.type} == "fact"', dv, 'root')).toBe(true);
    });
    it('!= 与多层下钻', () => {
      expect(evaluateCondition('point.type != "inference"', dv, 'root')).toBe(true);
      expect(evaluateCondition('nested.a.b == "deep"', dv, 'root')).toBe(true);
    });
    it('缺失字段 → undefined（不匹配任何 literal）', () => {
      expect(evaluateCondition('point.missing == "x"', dv, 'root')).toBe(false);
      expect(evaluateCondition('point.type.deeper == "x"', dv, 'root')).toBe(false);  // type 是字符串非对象
    });
    it('裸变量（无点号）不受影响', () => {
      expect(evaluateCondition('flat == "v"', dv, 'root')).toBe(true);
    });
  });
});

// VariableStore.read dotted-path 单元验证（整名优先兼容 + 逐段下钻）
describe('VariableStore.read dotted path', () => {
  it('整名优先：真有 "a.b" 扁平变量时按整名命中', () => {
    const s = new VariableStore({ 'a.b': 'flatname', a: { b: 'nested' } });
    expect(s.read('a.b', 'root')).toBe('flatname');  // 整名优先于下钻
  });
  it('无整名 → 下钻对象字段', () => {
    const s = new VariableStore({ obj: { x: 1, y: { z: 'deep' } } });
    expect(s.read('obj.x', 'root')).toBe(1);
    expect(s.read('obj.y.z', 'root')).toBe('deep');
  });
  it('数组下标：a.0 与 a[0] 等价，可续下钻字段', () => {
    const s = new VariableStore({ items: [{ name: 'first' }, { name: 'second' }] });
    expect(s.read('items.0.name', 'root')).toBe('first');
    expect(s.read('items[1].name', 'root')).toBe('second');
    expect(s.read('items[0]', 'root')).toEqual({ name: 'first' });
  });
  it('中途非对象 / 字段缺失 / 越界 → undefined', () => {
    const s = new VariableStore({ obj: { x: 1 }, arr: [1, 2] });
    expect(s.read('obj.missing', 'root')).toBeUndefined();
    expect(s.read('obj.x.deeper', 'root')).toBeUndefined();  // x 是数字
    expect(s.read('arr.5', 'root')).toBeUndefined();          // 下标越界
    expect(s.read('arr.foo', 'root')).toBeUndefined();        // 非整数下标
    expect(s.read('nope.field', 'root')).toBeUndefined();     // 根变量不存在
  });
});

// @v: anc-rule-c8 —— 表达式求值数值语义(修字符串化比较 '9'>'10' 坑)
describe('evaluateCondition: hop_python 表达式', () => {
  const HOST: any = { workspace_dir: '/tmp', sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: 'k' };
  function mkVars(init: Record<string, unknown>) {
    const vs = new VariableStore(init);
    return vs;
  }

  it('数值比较: 9 < 10 为真(旧字符串化 "9">"10" 坑已修)', () => {
    const vars = mkVars({ count: 9 });
    expect(evaluateCondition('count < 10', vars, 'root')).toBe(true);
    expect(evaluateCondition('count > 10', vars, 'root')).toBe(false);
  });

  it('and/or 短路与算术', () => {
    const vars = mkVars({ a: 3, b: 0, mode: 'doc' });
    expect(evaluateCondition('a > 1 and mode == "doc"', vars, 'root')).toBe(true);
    expect(evaluateCondition('b or a', vars, 'root')).toBe(true);
    expect(evaluateCondition('a * 2 == 6', vars, 'root')).toBe(true);
    expect(evaluateCondition('not (a > 5)', vars, 'root')).toBe(true);
  });

  it('裸字兼容仅限比较位置:已声明 == 未声明裸字按字面量;未赋值变量比较不误命中', () => {
    const vars = mkVars({ mode: 'fast', unset: undefined });
    expect(evaluateCondition('mode == fast', vars, 'root')).toBe(true);
    // unset 已声明(值undefined) vs 裸字 fast→字面量:'undefined'!=='fast' → false(不误命中)
    expect(evaluateCondition('unset == fast', vars, 'root')).toBe(false);
  });

  // 真值 Python 对齐（2026-08-20 作者拍板——case 条件与 body if 同一 isTruthy）
  // @v: anc-exec-none-propagation
  it('正例：case 条件裸真值对空列表/空对象判假,非空判真', () => {
    expect(evaluateCondition('items', mkVars({ items: [] }), 'root')).toBe(false);
    expect(evaluateCondition('items', mkVars({ items: ['a'] }), 'root')).toBe(true);
    expect(evaluateCondition('obj', mkVars({ obj: {} }), 'root')).toBe(false);
    expect(evaluateCondition('not items', mkVars({ items: [] }), 'root')).toBe(true);
  });

  // 推导 itemVar 绑定语义（三十四审——element/filter 内 itemVar 不得被裸字消歧字面量化:
  // `s == target` 的 s 若转成 "s" 则 filter 恒错;source 位仍按外层判定）。
  // @v: anc-step-act-body-comprehension
  it('正例：推导 filter 里 itemVar 参与比较不被字面量化（绑定变量视为已声明）', () => {
    const vars = mkVars({ names: ['a', 'bb', 'ccc'], target: 'bb' });
    // s 若被字面量化成 "s"，"s" == target 恒假 → len == 0；正确语义命中 1 个
    expect(evaluateCondition('len([s for s in names if s == target]) == 1', vars, 'root')).toBe(true);
  });

  it('反例：推导 source 位裸字不因 itemVar 放宽（source 用外层判定,未声明照 falsy 语义）', () => {
    const vars = mkVars({ mode: 'fast' });
    // element 位 itemVar==裸字:itemVar 已声明侧成立,裸字 fast 按字面量——遍历 ["fast","x"] 滤出 1 个
    const vars2 = mkVars({ opts: ['fast', 'x'] });
    expect(evaluateCondition('len([o for o in opts if o == fast]) == 1', vars2, 'root')).toBe(true);
    // source 位引用未声明变量→计算异常响亮（{error} 返回,branch 将 fail）,不静默造空表通过
    const r = evaluateCondition('len([x for x in ghost]) == 0', vars, 'root');
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('遍历对象须为列表');
  });

  // 裸字消歧嵌套位下钻（v0.10.0 exprMapChildren 修——原实现只认 binary/unary/field/index,
  // 三元/call 实参里嵌套的比较位裸字不消歧,C8 静态放行运行时选错分支=validate 绿 run 错分叉,探针实抓）
  // @v: anc-struct-expr-walk
  it('正例：三元/call 实参内嵌套比较的裸字同样消歧（嵌套位下钻）', () => {
    const vars = mkVars({ mode: 'fast' });
    expect(evaluateCondition('("y" if mode == fast else "n") == "y"', vars, 'root')).toBe(true);
    expect(evaluateCondition('len("ab" if mode == fast else "") > 0', vars, 'root')).toBe(true);
  });

  it('反例：嵌套位裸字兼容边界不放宽——两侧都未声明仍不消歧（undefined→falsy）', () => {
    const vars = mkVars({ mode: 'fast' });
    // 内层 nope == fast 两侧都未声明→不消歧,undefined==undefined... nope未声明读undefined,
    // fast 未声明也 undefined→按严格等值 undefined==undefined 为真? 不:裸字位置无已声明侧,
    // 不转字面量,两个未声明变量都读 undefined,None/未赋值互等→真——钉住现状语义(与顶层一致)
    expect(evaluateCondition('("y" if nope == fast else "n") == "y"', vars, 'root'))
      .toBe(evaluateCondition('nope == fast', vars, 'root'));   // 嵌套与顶层同语义,无分叉
  });
});

// @v: anc-rule-c8 —— 描述完备性审查补齐(2026-08-09):None字面量/方括号下标/等值vs序比较语义边界
describe('evaluateCondition: None/下标/语义边界', () => {
  function mkVars(init: Record<string, unknown>) { return new VariableStore(init); }

  it('x == None 检测降级路径(fail的null与未赋值undefined都命中)', () => {
    const vars = mkVars({ failed_out: null, mode: 'doc' });
    expect(evaluateCondition('failed_out == None', vars, 'root')).toBe(true);
    expect(evaluateCondition('mode == None', vars, 'root')).toBe(false);
    expect(evaluateCondition('mode != None', vars, 'root')).toBe(true);
    expect(evaluateCondition('failed_out == null', vars, 'root')).toBe(true);   // null 同义词
  });

  it('items[0] 方括号下标是唯一下标写法(.N dotted 已删,2026-08-09 作者定)', () => {
    const vars = mkVars({ items: ['a', 'b'], i: 1 });
    expect(evaluateCondition('items[0] == "a"', vars, 'root')).toBe(true);
    expect(evaluateCondition('items[i] == "b"', vars, 'root')).toBe(true);      // 动态下标(作者定A)
    expect(evaluateCondition('items[i - 1] == "a"', vars, 'root')).toBe(true);  // 表达式下标
    // .N 已删:解析失败=条件计算异常(fail即异常定稿——返回{error}非falsy,branch将fail)
    const r = evaluateCondition('items.0 == "a"', vars, 'root');
    expect(typeof r).toBe('object');
  });

  // 切片端点消歧下钻（2026-09-05 review 变异实锤:exprMapChildren slice case 不映射端点后,
  // 端点内三元比较位裸字不被消歧、条件静默选错分支,1287 例全绿存活——本钉即重放该变异的防线）
  // @v: anc-step-act-body-slice
  it('切片端点内比较位裸字被消歧（items[(1 if mode == fast else 0):2]——fast 按字面量）', () => {
    const vars = mkVars({ items: [1, 2, 3], mode: 'fast' });
    expect(evaluateCondition('items[(1 if mode == fast else 0):2] == [2]', vars, 'root')).toBe(true);
  });

  it('条件里切片钳位与缺省端点（items[1:] 越界与全省形态）', () => {
    const vars = mkVars({ items: [1, 2] });
    expect(evaluateCondition('items[1:] == [2]', vars, 'root')).toBe(true);
    expect(evaluateCondition('items[10:] == []', vars, 'root')).toBe(true);
    expect(evaluateCondition('items[:] == items', vars, 'root')).toBe(true);
  });

  it('等值 Python 严格(跨类型 False 不异常)、序比较跨类型=计算异常', () => {
    // 数字串在输出边界已归一转换（anc-exec-output-coerce）——条件里撞到 "3" 只可能是
    // text 声明的真字符串，Python 严格语义下 == 3 就是 False（宽松等值 2026-08-11 废）
    const vars = mkVars({ n: '3', mode: 'doc' });
    expect(evaluateCondition('n == 3', vars, 'root')).toBe(false);      // strictEq
    // 文本参与序比较=计算异常 → {error}(branch将fail)——"程序错了"与"不命中"可辨(fail即异常定稿)
    const r2 = evaluateCondition('mode > 3', vars, 'root');
    expect(typeof r2).toBe('object');
  });

  it('true/false 字面量与一元负号', () => {
    const vars = mkVars({ ok: true, n: 5 });
    expect(evaluateCondition('ok == true', vars, 'root')).toBe(true);
    expect(evaluateCondition('-n < 0', vars, 'root')).toBe(true);
  });
});

// @v: anc-rule-c8 —— 计算异常=None+log(2026-08-09 作者定:不静默不炸,warn留痕)
describe('evaluateCondition: 计算异常留痕', () => {
  it('文本参与序比较 → {error} 返回(branch将fail) + onWarn 留痕', () => {
    const vars = new VariableStore({ mode: 'doc' });
    const warns: string[] = [];
    const r = evaluateCondition('mode > 3', vars, 'root', m => warns.push(m));
    expect(typeof r).toBe('object');
    expect((r as any).error).toContain('计算异常');
    expect(warns.some(w => w.includes('计算异常'))).toBe(true);
  });
});
