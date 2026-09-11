// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: spec-ast ^anc-struct-spec-ast
// HopSpec 语言运行时基础能力——变量作用域存储 + step_id 寻址/作用域定位 + 条件真值语义。
// 不依赖执行状态、不涉调度,只依赖 spec-ast 自身(ast-types/ast-helpers)。
// 被 exec-engine/prompt-assembler/act-body 多方消费,故属语言基础层而非引擎私有。
// 见 design/spec-ast.md ^anc-struct-spec-ast（spec-ast 从"静态类型词汇表"扩为"语言词汇表 + 运行时基础能力"）。
import type { OutputDecl, SpecAST, StepNode } from './ast-types.js';
import { getParentStepId, hasChildren, getChildren } from './ast-helpers.js';

// ===== 步骤状态 + 变量作用域存储（从 engine-vars 迁入）=====

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** 步骤是否处于终态（done/failed/skipped）。单点定义终态集合——engine/engine-traverse 多处判据复用，
 * 新增终态只改这里。undefined（从未 set 状态的 pending 步骤）返回 false。 */
export function isTerminalStatus(st: StepStatus | undefined): boolean {
  return st === 'done' || st === 'failed' || st === 'skipped';
}

/** 树状变量作用域节点：持有本层变量表并链向父作用域，read 沿链上溯实现遮蔽/继承。见 [[spec-ast#^anc-struct-spec-ast-exports]]。 */
export interface VariableScope {
  id: string;
  parent: VariableScope | null;
  variables: Map<string, unknown>;
}

/** 树状作用域变量存储：按 scope_id 管理变量的读写/作用域创建/序列化，供 engine 与 prompt 消费（从 engine-vars 迁入语言运行时层）。见 [[spec-ast#^anc-struct-spec-ast-exports]]。 */
export class VariableStore { // @a: anc-exec-variable-store
  private root: VariableScope;
  private scopes: Map<string, VariableScope> = new Map();

  constructor(inputs?: Record<string, unknown>) {
    this.root = { id: 'root', parent: null, variables: new Map() };
    this.scopes.set('root', this.root);
    if (inputs) {
      for (const [k, v] of Object.entries(inputs)) {
        this.root.variables.set(k, v);
      }
    }
  }

  createScope(scopeId: string, parentId: string): VariableScope {
    const parent = this.scopes.get(parentId);
    if (!parent) throw new Error(`Parent scope '${parentId}' not found`);
    const scope: VariableScope = { id: scopeId, parent, variables: new Map() };
    this.scopes.set(scopeId, scope);
    return scope;
  }

  /** scope 是否已存在（供 ensureScope 显式判 loop 重进/resume 已恢复，避免用 createScope 抛错做控制流）。 */
  hasScope(scopeId: string): boolean {
    return this.scopes.has(scopeId);
  }

  findScope(stepId: string): VariableScope {
    return this.scopes.get(stepId) ?? this.root;
  }

  read(name: string, scopeId: string): unknown {
    // 整名优先：先按 name 原样向上查找（兼容真有 "a.b" 此名的扁平变量）。
    let scope: VariableScope | null = this.scopes.get(scopeId) ?? this.root;
    while (scope) {
      if (scope.variables.has(name)) return scope.variables.get(name);
      scope = scope.parent;
    }
    // 未命中且含路径分隔 → dotted path 成员访问：首段为根变量，逐段下钻。
    // 类似 JSON 路径：对象字段按 key 取，数组按数字下标取（`arr.0` 或 `arr[0]` 皆可）。
    // 用于 for-each 元素按字段/下标分流（如 branch 条件 {point.type}、{items.0.name}）。
    // 见 design ^anc-exec-dfs-traversal 条件求值。中途某段无法下钻（非对象/数组、越界、字段缺失）→ undefined。
    if (name.includes('.') || name.includes('[')) {
      // 归一化 `a[0].b` → `a.0.b`，再按 `.` 分段
      const segs = name.replace(/\[(\w+)\]/g, '.$1').split('.').filter(s => s !== '');
      let cur: VariableScope | null = this.scopes.get(scopeId) ?? this.root;
      while (cur) {
        if (cur.variables.has(segs[0])) {
          let val: unknown = cur.variables.get(segs[0]);
          for (let i = 1; i < segs.length; i++) {
            if (val === null || typeof val !== 'object') return undefined;
            if (Array.isArray(val)) {
              const idx = Number(segs[i]);
              if (!Number.isInteger(idx)) return undefined;  // 数组只接受整数下标
              val = val[idx];
            } else {
              val = (val as Record<string, unknown>)[segs[i]];
            }
          }
          return val;
        }
        cur = cur.parent;
      }
    }
    return undefined;
  }

  /** 变量是否已声明（沿链存在性,不看值——声明未赋值的 undefined 也算在场）。
   * 条件求值的裸字消歧用:声明判据必须是存在性,用"值非 undefined"会把未赋值输入
   * 误判未声明（2026-08-09 case 表达式升格实测撞出）。 */
  hasVar(name: string, scopeId: string): boolean {
    let scope: VariableScope | null = this.scopes.get(scopeId) ?? this.root;
    while (scope) {
      if (scope.variables.has(name)) return true;
      scope = scope.parent;
    }
    return false;
  }

  /** 只读指定 scope 本层，不沿链上溯。loop 合并收集时用——上溯会在提升链断裂时
   * 撞到父 scope 收集列表自身，产生 acc.push(acc) 自引用（2026-08-09 hopkb 实撞 B1）。 */
  readLocal(name: string, scopeId: string): unknown {
    return this.scopes.get(scopeId)?.variables.get(name);
  }

  write(name: string, value: unknown, scopeId: string): void {
    const scope = this.scopes.get(scopeId) ?? this.root;
    scope.variables.set(name, value);
  }

  writeToRoot(name: string, value: unknown): void {
    this.root.variables.set(name, value);
  }

  writeOutputs(outputs: Record<string, unknown>, scopeId: string): void {
    for (const [k, v] of Object.entries(outputs)) {
      this.write(k, v, scopeId);
    }
  }


  getAllVariables(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const collectScope = (scope: VariableScope) => {
      for (const [k, v] of scope.variables) {
        if (!(k in result)) result[k] = v;
      }
    };
    for (const scope of this.scopes.values()) {
      collectScope(scope);
    }
    return result;
  }

  getPendingOutputs(declaredOutputs: OutputDecl[]): string[] {
    const allVars = this.getAllVariables();
    return declaredOutputs
      .filter(o => !(o.name in allVars) || allVars[o.name] === undefined)
      .map(o => o.name);
  }

  clearScope(scopeId: string): void {
    const scope = this.scopes.get(scopeId);
    if (scope) scope.variables.clear();
  }

  // 从指定 scope 删除单个变量（删后 read 沿链上溯，本 scope 无则返回祖先值或 undefined）。
  // 注：Python 语义改造后引擎不再每轮清变量（^anc-exec-loop-var-scope），此方法为通用工具、无引擎内部调用者。
  deleteVar(name: string, scopeId: string): void {
    const scope = this.scopes.get(scopeId);
    if (scope) scope.variables.delete(name);
  }

  deleteScope(scopeId: string): void {
    this.scopes.delete(scopeId);
  }

  /** 序列化完整 scope 树（vars.json format_version=2）：每个 scope 记 parent id + 本层变量。
   * 见 [[exec-engine#^anc-exec-vars-scope-persist]]。不再拍平——拍平会丢兄弟 scope 同名变量。 */
  // @a: anc-exec-vars-scope-persist
  toJSON(): Record<string, { parent: string | null; variables: Record<string, unknown> }> {
    const result: Record<string, { parent: string | null; variables: Record<string, unknown> }> = {};
    for (const [scopeId, scope] of this.scopes) {
      result[scopeId] = {
        parent: scope.parent?.id ?? null,
        variables: Object.fromEntries(scope.variables),
      };
    }
    return result;
  }

  /** 从 scope 树重建（v2）：三遍——① 建所有空 scope ② 连 parent 指针 ③ 灌变量，
   * 保证连指针/灌变量前所有节点已在 map。见 [[exec-engine#^anc-exec-vars-scope-persist]]。 */
  // @a: anc-exec-vars-scope-persist
  static fromScopes(scopes: Record<string, { parent: string | null; variables: Record<string, unknown> }>): VariableStore {
    const store = new VariableStore();
    // 第 1 遍：建所有 scope 节点（root 已由构造函数建好，复用之）
    for (const scopeId of Object.keys(scopes)) {
      if (scopeId === 'root') continue;
      store.scopes.set(scopeId, { id: scopeId, parent: null, variables: new Map() });
    }
    // 第 2 遍：连 parent 指针。孤儿 parent（数据里不存在该 parent id）响亮失败——vars.json v2 应含
    // 完整 scope 树，parent 缺失是数据损坏，静默挂 root 会掩盖它。
    for (const [scopeId, data] of Object.entries(scopes)) {
      if (scopeId === 'root') continue;
      const scope = store.scopes.get(scopeId)!;
      if (data.parent === null) { scope.parent = store.root; continue; }
      const parent = store.scopes.get(data.parent);
      if (!parent) throw new Error(`CORRUPT_STATE_FILE: vars.json scope '${scopeId}' 的 parent '${data.parent}' 不存在（scope 树损坏）`);
      scope.parent = parent;
    }
    // 第 3 遍：灌变量（含 root）
    for (const [scopeId, data] of Object.entries(scopes)) {
      const scope = store.scopes.get(scopeId) ?? store.root;
      for (const [k, v] of Object.entries(data.variables)) scope.variables.set(k, v);
    }
    return store;
  }

  /** v1 legacy：扁平变量字典全塞 root（向后兼容旧 vars.json）。 */
  static fromJSON(data: Record<string, unknown>): VariableStore {
    return new VariableStore(data);
  }
}

// ===== step_id 寻址 + 作用域定位（从 engine-traverse 迁入）=====

// 开作用域的容器类型:branch 声明聚合输出(统一接口名),各 case 同名填充。
// branch + case 都开作用域。见 design/exec-engine.md 变量作用域规则 5b / ^anc-exec-container-output
export const SCOPE_CREATING_TYPES = new Set(['subtask', 'loop', 'branch', 'case']);   // parallel 已属性化——scope 随其宿主容器（subtask/loop）创建

// 建 step_id → StepNode 反查表——**纯函数无缓存**（run 隔离不变量,ARCHITECTURE ^anc-run-isolation,
// 2026-08-14）：原模块顶层 let _stepMapCache 是"run 级缓存住进程级槽"的违反面——多 run/多引擎
// 并发互踢命中率归零,且是全库唯一可变模块全局,被仿写〔按内容键控〕即正确性 bug。缓存归属
// =引擎实例（调用方按需持有,spec 变更点唯 replan,实例内失效时机清晰）。// @a: anc-run-isolation
export function buildStepMap(spec: SpecAST): Map<string, StepNode> {
  const map = new Map<string, StepNode>();
  const walk = (steps: StepNode[]) => {
    for (const step of steps) {
      map.set(step.step_id, step);
      if (hasChildren(step)) walk(getChildren(step));
    }
  };
  walk(spec.steps ?? []);
  return map;
}

// 写变量的归属命名空间——**恒为 root**（2026-08-09 扁平命名空间重构，概念层裁决：
// 一次执行=一个扁平命名空间，容器是控制流块非作用域，同名=同一变量）。
// 原"向上找最近容器"的块级语义废除——它制造 Python 不存在的隐式影子变量（三份实跑
// 报告同源实撞）。签名保留（调用面广），参数不再使用。scope 树仅作两类内部存储基质：
// ① 串行 for-each 的收集缓冲区（loop scope，见 engine-traverse 归并）；② vars.json v2
// 兼容。语义边界只在实例间（call 子实例/parallel worker=独立 VariableStore）。
// @a: anc-exec-loop-var-scope
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getWriteScope(stepId: string, spec: SpecAST): string {
  return 'root';
}

// ===== 条件真值语义（从 engine-traverse 迁入）=====

// HopSpec 条件真值判断（branch/case 条件求值、None 传播共用）。
// null/undefined/false/''/0 为 falsy,其余 truthy。
export function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value === false) return false;
  if (value === '') return false;
  if (value === 0) return false;
  // 空列表/空对象为假（2026-08-20 作者拍板 Python 对齐——真值面唯一未对齐处;yaml 值模型改
  // 结构后空列表形态大增,`if xs:` 判空必须全类型工作。"false"/"0" 字符串仍真,归边界归一管）
  // @a: anc-exec-none-propagation
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}
