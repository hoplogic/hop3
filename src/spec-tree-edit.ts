// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: spec-ast ^anc-struct-spec-ast
/**
 * AST 级 spec 树编辑核心（2026-08-30 作者两连拍板函数化重构——
 * ①"edit_spec_tree 的逻辑不成立,那些都是应该被调用的函数干的事情,而不是这么丑陋的挤在一起":
 *   原单工具四操作靠 op 参数分发拆成独立函数,各自可调,共享底盘沉本文件;
 * ②replan 编辑序列的机械拼装统一到本组函数——库内一套编辑代数一处实现。
 * 契约权威 [[tools/spec-tree-tools#^anc-exec-builtin-edit-tree-tool]] 两层结构之第一层。
 * AST 进 AST 出,零文本零文件访问;编辑函数不自动重编号——编号权威独立在 renumberSteps,
 * 调用方编辑完显式调它（单一职责;拼装类多次编辑只重编一次）。
 * // @a: anc-exec-builtin-edit-tree-tool
 */
import type { StepNode } from './ast-types.js';

type AnyStep = { step_id: string; children?: AnyStep[] };

/** 树编辑失败载荷（error=人读原因;六核心函数与工具薄壳共用形态）。 */
/** 树编辑结果二态（ok:true 成功 / ok:false 携 error——编辑函数不抛异常,失败是值）。 */
export type TreeEditOutcome = { ok: true } | { ok: false; error: string };

/** 定位节点（前序遍历首个 step_id 精确匹配）。 */
export function findNodeByPath(nodes: StepNode[], id: string): StepNode | null {
  const walk = (list: AnyStep[]): AnyStep | null => {
    for (const n of list) {
      if (n.step_id === id) return n;
      if (n.children) { const f = walk(n.children); if (f) return f; }
    }
    return null;
  };
  return walk(nodes as unknown as AnyStep[]) as StepNode | null;
}

/** 定位节点所在的兄弟列表与下标。 */
export function findParentListByPath(nodes: StepNode[], id: string): { list: StepNode[]; idx: number } | null {
  const walk = (list: AnyStep[]): { list: AnyStep[]; idx: number } | null => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].step_id === id) return { list, idx: i };
      const ch = list[i].children;
      if (ch) { const f = walk(ch); if (f) return f; }
    }
    return null;
  };
  return walk(nodes as unknown as AnyStep[]) as { list: StepNode[]; idx: number } | null;
}

/** insert_node 核心：片段插到 nodePath 写定的序号位置,原位者及后继后移。
 * 插尾=该层末位号+1（唯一越界位）;其余不存在的号响亮拒。不自动重编号。 */
export function insertNodeAt(steps: StepNode[], nodePath: string, fragSteps: StepNode[]): TreeEditOutcome {
  const loc = findParentListByPath(steps, nodePath);
  if (loc) {
    loc.list.splice(loc.idx, 0, ...fragSteps);
    return { ok: true };
  }
  // 越界追加位判定:父层存在且末段号 = 该层现有步数+1
  const seg = nodePath.split('.');
  const last = Number(seg[seg.length - 1]);
  const parentPath = seg.slice(0, -1).join('.');
  const parent = parentPath ? findNodeByPath(steps, parentPath) : null;
  const siblings = parentPath ? (parent as AnyStep | null)?.children : (steps as unknown as AnyStep[]);
  if (!siblings || !Number.isInteger(last) || last !== siblings.length + 1) {
    return { ok: false, error: `node_path '${nodePath}' 不存在（insert_node 的落位号须是现有步骤号,或该层末位号+1 表示追加）` };
  }
  (siblings as StepNode[]).push(...fragSteps);
  return { ok: true };
}

/** replace_node 核心：原位拼接替换（节点连行带子树消失,片段接进原位置）。
 * 入参恒为批量数组（单项=长度 1）。两阶段:先按调用前号解引用全部目标,再逐个 splice——
 * 边拼边查会撞先拼入片段的相对号。定位不到=目标已随先前替换离树（嵌套/重复违约）响亮拒。
 * 不自动重编号。 */
export function replaceNodeAt(steps: StepNode[], replacements: { nodePath: string; fragSteps: StepNode[] }[]): TreeEditOutcome {
  const targets: { target: StepNode; fragSteps: StepNode[] }[] = [];
  for (const r of replacements) {
    const node = findNodeByPath(steps, r.nodePath);
    if (!node) return { ok: false, error: `node_path '${r.nodePath}' 不存在` };
    targets.push({ target: node, fragSteps: r.fragSteps });
  }
  // 目标间祖先-后代主动双向判定——契约"互不嵌套响亮拒"不靠"外层先执行内层恰好离树"的
  // 次序巧合:[内,外] 次序原静默吞掉内层编辑（review 实证）。
  const contains = (root: AnyStep, want: AnyStep): boolean => {
    if (!root.children) return false;
    for (const c of root.children) { if (c === want || contains(c, want)) return true; }
    return false;
  };
  for (let i = 0; i < targets.length; i++) {
    for (let j = 0; j < targets.length; j++) {
      if (i !== j && contains(targets[i].target as unknown as AnyStep, targets[j].target as unknown as AnyStep)) {
        return { ok: false, error: '替换目标存在嵌套（祖先与后代同批）——目标须互不嵌套' };
      }
    }
  }
  for (const { target, fragSteps } of targets) {
    const locate = (nodes: AnyStep[]): { list: AnyStep[]; idx: number } | null => {
      const i = nodes.indexOf(target as unknown as AnyStep);
      if (i >= 0) return { list: nodes, idx: i };
      for (const n of nodes) { if (n.children) { const f = locate(n.children); if (f) return f; } }
      return null;
    };
    const loc = locate(steps as unknown as AnyStep[]);
    if (!loc) return { ok: false, error: '替换目标已随先前替换离树（嵌套或重复目标违约输入）' };
    loc.list.splice(loc.idx, 1, ...(fragSteps as unknown as AnyStep[]));
  }
  return { ok: true };
}

/** replace_children 核心：子树换血,节点行自身保留;nodePath='root' 替换整树顶层。不自动重编号。 */
export function replaceChildrenAt(steps: StepNode[], nodePath: string, fragSteps: StepNode[]): TreeEditOutcome {
  if (nodePath === 'root') {
    (steps as unknown as AnyStep[]).splice(0, steps.length, ...(fragSteps as unknown as AnyStep[]));
    return { ok: true };
  }
  const node = findNodeByPath(steps, nodePath);
  if (!node) return { ok: false, error: `node_path '${nodePath}' 不存在` };
  (node as unknown as { children: AnyStep[] }).children = fragSteps as unknown as AnyStep[];
  return { ok: true };
}

/** delete_node 核心：节点连行带子树移除（D44 三原子的 delete——replan 统一时补齐编辑代数
 * 第四原子;工具入口暂不暴露,spec body 场景无删步需求,需要时另立）。不自动重编号。 */
export function deleteNodeAt(steps: StepNode[], nodePath: string): TreeEditOutcome {
  const loc = findParentListByPath(steps, nodePath);
  if (!loc) return { ok: false, error: `node_path '${nodePath}' 不存在` };
  loc.list.splice(loc.idx, 1);
  return { ok: true };
}

/** 编号权威：全树按位置重编号（N.M 层级号恒等于树位置——step ID 是唯一树结构权威的机械兑现）。
 * 返回旧号→新号全映射。 */
export function renumberSteps(steps: StepNode[]): Record<string, string> {
  const renumberMap: Record<string, string> = {};
  const walk = (nodes: AnyStep[], prefix: string) => {
    nodes.forEach((n, i) => {
      const newId = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      if (n.step_id && n.step_id !== newId) renumberMap[n.step_id] = newId;
      n.step_id = newId;
      if (n.children) walk(n.children, newId);
    });
  };
  walk(steps as unknown as AnyStep[], '');
  return renumberMap;
}

/** 队列同步：work_items 三段式首段是节点路径（root/root.N.M 或裸步骤号）——按映射改写。 */
export function syncWorkItems(workItems: string[], renumberMap: Record<string, string>): string[] {
  return workItems.map(item => {
    const parts = item.split('|').map(p => p.trim());
    if (parts.length < 1) return item;
    const path = parts[0];
    const bare = path.startsWith('root.') ? path.slice(5) : path === 'root' ? '' : path;
    if (bare && renumberMap[bare]) {
      const newPath = path.startsWith('root.') ? `root.${renumberMap[bare]}` : renumberMap[bare];
      return [newPath, ...parts.slice(1)].join(' | ');
    }
    return item;
  });
}
