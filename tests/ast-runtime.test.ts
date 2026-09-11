// @module: spec-ast ^anc-struct-spec-ast （运行时基础能力独立覆盖）
// @v: anc-exec-variable-store
// ast-runtime 单测——VariableStore 树状作用域 + getWriteScope 作用域定位 + isTruthy 真值语义。
// 这些是从 engine-vars/engine-traverse 迁入 spec-ast 的语言运行时基础能力(注意力自足:子模块独立红灯)。
import { describe, it, expect } from 'vitest';
import { VariableStore, getWriteScope, isTruthy } from '../src/ast-runtime.js';
import type { OutputDecl, SpecAST, StepNode, SubtaskStep } from '../src/ast-types.js';

describe('VariableStore 作用域', () => {
  it('root 初值 + read/write', () => {
    const vs = new VariableStore({ a: 1 });
    expect(vs.read('a', 'root')).toBe(1);
    vs.write('b', 2, 'root');
    expect(vs.read('b', 'root')).toBe(2);
    expect(vs.read('missing', 'root')).toBeUndefined();
  });

  it('子作用域向上查找祖先变量', () => {
    const vs = new VariableStore({ shared: 'top' });
    vs.createScope('1', 'root');
    vs.createScope('1.1', '1');
    expect(vs.read('shared', '1.1')).toBe('top');
    vs.write('local', 'child', '1.1');
    expect(vs.read('local', '1.1')).toBe('child');
    expect(vs.read('local', 'root')).toBeUndefined();
  });

  it('就近作用域遮蔽祖先同名', () => {
    const vs = new VariableStore({ x: 'root-val' });
    vs.createScope('1', 'root');
    vs.write('x', 'scope-val', '1');
    expect(vs.read('x', '1')).toBe('scope-val');
    expect(vs.read('x', 'root')).toBe('root-val');
  });

  it('未知 scopeId 回退 root', () => {
    const vs = new VariableStore({ a: 1 });
    expect(vs.read('a', 'nonexistent-scope')).toBe(1);
  });

  it('createScope 父不存在抛错', () => {
    const vs = new VariableStore();
    expect(() => vs.createScope('child', 'no-parent')).toThrow();
  });

  it('hasScope 判 scope 是否已存在（供 ensureScope 显式判，不用 catch 抛错做控制流）', () => {
    const vs = new VariableStore();
    expect(vs.hasScope('root')).toBe(true);
    expect(vs.hasScope('1')).toBe(false);
    vs.createScope('1', 'root');
    expect(vs.hasScope('1')).toBe(true);
  });

  it('writeToRoot 总写根', () => {
    const vs = new VariableStore();
    vs.createScope('1', 'root');
    vs.writeToRoot('g', 'global');
    expect(vs.read('g', '1')).toBe('global');
  });

  it('writeOutputs 批量写入', () => {
    // setOutputsToNull 已删（2026-08-09 函数级 fail 定稿:fail 不碰值空间）
    const vs = new VariableStore();
    vs.writeOutputs({ a: 1, b: 2 }, 'root');
    expect(vs.read('a', 'root')).toBe(1);
    expect(vs.read('b', 'root')).toBe(2);
  });

  it('deleteVar 删后 read 本 scope 无该变量(通用工具，非引擎每轮清)', () => {
    const vs = new VariableStore();
    vs.createScope('1', 'root');
    vs.write('iter', 'v', '1');
    vs.deleteVar('iter', '1');
    expect(vs.read('iter', '1')).toBeUndefined();
  });

  // @v: anc-exec-vars-scope-persist
  it('toJSON/fromScopes 往返(scope 树保真)', () => {
    const vs = new VariableStore({ a: 1 });
    vs.createScope('1', 'root');
    vs.write('b', 2, '1');
    const json = vs.toJSON();
    // v2：完整 scope 树，不再拍平
    expect(json.root.variables.a).toBe(1);
    expect(json.root.parent).toBeNull();
    expect(json['1'].variables.b).toBe(2);
    expect(json['1'].parent).toBe('root');
    // fromScopes 重建后作用域隔离保真
    const vs2 = VariableStore.fromScopes(json);
    expect(vs2.read('a', 'root')).toBe(1);
    expect(vs2.read('b', '1')).toBe(2);
    expect(vs2.read('a', '1')).toBe(1);   // 子 scope 沿链上溯读到 root
    expect(vs2.read('b', 'root')).toBeUndefined();  // 父 scope 读不到子的 b（隔离）
  });

  // @v: anc-exec-vars-scope-persist
  it('兄弟 scope 同名变量往返不互覆盖(修复静默数据损坏)', () => {
    const vs = new VariableStore();
    vs.createScope('1', 'root');
    vs.createScope('2', 'root');
    vs.write('x', 'v1', '1');
    vs.write('x', 'v2', '2');
    const vs2 = VariableStore.fromScopes(vs.toJSON());
    expect(vs2.read('x', '1')).toBe('v1');  // 各归其 scope，不互覆盖
    expect(vs2.read('x', '2')).toBe('v2');
  });

  it('fromScopes 孤儿 parent（scope 树损坏）响亮失败，不静默挂 root', () => {
    const corrupt = {
      root: { parent: null, variables: {} },
      '1.1': { parent: '1', variables: { x: 1 } },  // parent '1' 不在数据里
    };
    expect(() => VariableStore.fromScopes(corrupt)).toThrow(/CORRUPT_STATE_FILE/);
  });

  // @v: anc-exec-vars-scope-persist
  it('fromJSON v1 legacy：扁平变量全塞 root(向后兼容)', () => {
    const vs = VariableStore.fromJSON({ a: 1, b: 'hello' });
    expect(vs.read('a', 'root')).toBe(1);
    expect(vs.read('b', 'root')).toBe('hello');
  });

  it('getPendingOutputs 找未产出的声明输出', () => {
    const vs = new VariableStore({ done_var: 'x' });
    const decls: OutputDecl[] = [
      { name: 'done_var', type: 'text', description: '' },
      { name: 'missing_var', type: 'text', description: '' },
    ];
    expect(vs.getPendingOutputs(decls)).toEqual(['missing_var']);
  });
});

describe('getWriteScope（2026-08-09 扁平命名空间:恒 root）', () => {
  it('任意深度步骤写入均落 root——容器是控制流块非作用域(同名=同一变量)', () => {
    const spec: SpecAST = { header: { title: 'T' }, steps: [
      { step_id: '1', step_type: 'subtask', summary: 's', children: [
        { step_id: '1.1', step_type: 'reason', summary: 'r' },
      ] } as SubtaskStep,
    ] };
    expect(getWriteScope('1.1', spec)).toBe('root');
    expect(getWriteScope('1', spec)).toBe('root');
  });
});

// @v: anc-exec-none-propagation
describe('isTruthy（HopSpec 条件真值语义——Python 对齐,2026-08-20 作者拍板空结构为假）', () => {
  it('falsy: null/undefined/false/空串/0/空列表/空对象', () => {
    expect(isTruthy(null)).toBe(false);
    expect(isTruthy(undefined)).toBe(false);
    expect(isTruthy(false)).toBe(false);
    expect(isTruthy('')).toBe(false);
    expect(isTruthy(0)).toBe(false);
    expect(isTruthy([])).toBe(false);      // yaml 值模型后 `if xs:` 判空必须全类型工作
    expect(isTruthy({})).toBe(false);
  });
  it('truthy: 非空串/非零数/非空结构/true;"false"/"0" 字符串仍真（真值只看空不空）', () => {
    expect(isTruthy('x')).toBe(true);
    expect(isTruthy(1)).toBe(true);
    expect(isTruthy(['a'])).toBe(true);
    expect(isTruthy({ k: 1 })).toBe(true);
    expect(isTruthy(true)).toBe(true);
    expect(isTruthy('false')).toBe(true);
    expect(isTruthy('0')).toBe(true);
  });
});
