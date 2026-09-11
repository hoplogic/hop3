// @module: spec-ast ^anc-struct-spec-ast
// ast-helpers 纯函数单测——AST 谓词 + step_id 寻址（无状态、无副作用）。
// getParentStepId 从 engine-traverse 迁入（纯 AST 寻址非引擎调度职责）。
import { describe, it, expect } from 'vitest';
import { getParentStepId, isContainerStep, hasChildren, getChildren, isParallelContainer, getForEach, formatTypeDecl, collectTypeDeclClosure } from '../src/ast-helpers.js';
import type { StepNode } from '../src/ast-types.js';

describe('getParentStepId', () => {
  it('嵌套 ID 取父', () => {
    expect(getParentStepId('1.2.3')).toBe('1.2');
    expect(getParentStepId('4.7')).toBe('4');
  });
  it('顶层 ID 无父', () => {
    expect(getParentStepId('1')).toBeNull();
  });
});

describe('AST 谓词', () => {
  const leaf: StepNode = { step_id: '1', step_type: 'reason', summary: 's', inputs: [], outputs: [] } as StepNode;
  const container: StepNode = { step_id: '2', step_type: 'subtask', summary: 's', inputs: [], outputs: [], children: [leaf] } as StepNode;

  it('isContainerStep：容器步骤 true、叶子 false', () => {
    expect(isContainerStep(container)).toBe(true);
    expect(isContainerStep(leaf)).toBe(false);
  });
  it('hasChildren / getChildren', () => {
    expect(hasChildren(container)).toBe(true);
    expect(hasChildren(leaf)).toBe(false);
    expect(getChildren(container)).toHaveLength(1);
    expect(getChildren(leaf)).toEqual([]);
  });
});

// F类补齐（2026-08-08 审计）：两谓词此前无直接单测，负例未显式验证
// @v: anc-step-parallel
describe('isParallelContainer / getForEach 谓词', () => {
  const mk = (o: Record<string, unknown>) => ({ step_id: '1', summary: 's', ...o }) as any;

  it('isParallelContainer: subtask 带 parallel=true 为真（统一模型 P0.5：loop 宿主已废除）', () => {
    expect(isParallelContainer(mk({ step_type: 'subtask', parallel: true, children: [] }))).toBe(true);
    // 反例（矩阵行 8 类型面）：loop 即便被塞 parallel 字段也不再是并行容器（字段已删，运行时防御）
    expect(isParallelContainer(mk({ step_type: 'loop', parallel: true, children: [] } as any))).toBe(false);
  });

  it('isParallelContainer 负例: 无 parallel 的容器/非容器步骤均为假', () => {
    expect(isParallelContainer(mk({ step_type: 'subtask', children: [] }))).toBe(false);
    expect(isParallelContainer(mk({ step_type: 'loop', children: [] }))).toBe(false);
    expect(isParallelContainer(mk({ step_type: 'reason' }))).toBe(false);
    expect(isParallelContainer(mk({ step_type: 'branch', children: [] }))).toBe(false);
  });

  it('getForEach: 仅 loop 携 forEach 时返回绑定,其余 undefined', () => {
    const fe = { listVar: 'items', itemVar: 'item' };
    expect(getForEach(mk({ step_type: 'loop', forEach: fe, children: [] }))).toEqual(fe);
    expect(getForEach(mk({ step_type: 'loop', children: [] }))).toBeUndefined();
    expect(getForEach(mk({ step_type: 'subtask', forEach: fe, children: [] }))).toBeUndefined();   // 非 loop 不认
  });
});

// TypeDecl 序列化两原语（0017 单源——prompt L1/mismatch 反馈/replan 三消费点;十七审补直测:
// 消费面端到端例已有,此处钉边界护栏——自引用死循环/空 fields/[T] 起点/内置起点）。
// @v: anc-type-type-decl
describe('formatTypeDecl / collectTypeDeclClosure 边界', () => {
  const decls = [
    { name: 'Node', fields: { val: 'text', next: 'Node' } },      // 自引用
    { name: 'Empty', fields: {} },
    { name: 'Wrap', fields: { items: '[Node]' } },                // [T] 嵌套引用
  ];

  it('正例：formatTypeDecl 单行序列化;空 fields 输出 名={}（如实——空定义也是定义）', () => {
    expect(formatTypeDecl(decls[0])).toBe('Node={val:text, next:Node}');
    expect(formatTypeDecl(decls[1])).toBe('Empty={}');
  });

  it('正例：自引用类型闭包不死循环（seen 去重,单次收录）', () => {
    const c = collectTypeDeclClosure(['Node'], decls);
    expect(c).toHaveLength(1);
    expect(c[0].name).toBe('Node');
  });

  it('正例：[T] 包裹起点与嵌套 [T] 字段均剥括号命中（Wrap→[Node]→Node 两层）', () => {
    expect(collectTypeDeclClosure(['[Node]'], decls).map(t => t.name)).toEqual(['Node']);
    expect(collectTypeDeclClosure(['Wrap'], decls).map(t => t.name).sort()).toEqual(['Node', 'Wrap']);
  });

  it('反例：内置类型起点零命中;decls 缺席返回空（零特判不炸）', () => {
    expect(collectTypeDeclClosure(['text', 'bool', 'int'], decls)).toHaveLength(0);
    expect(collectTypeDeclClosure(['Node'], undefined)).toHaveLength(0);
    expect(collectTypeDeclClosure(['Node'], [])).toHaveLength(0);
  });
});
