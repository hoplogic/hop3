// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: exec-engine ^anc-struct-exec-engine （子模块 traverse）
import type { SpecAST, StepNode, LoopStep, BranchStep, CaseStep, ExitStep, ParallelStep } from './ast-types.js';
import { EXECUTABLE_STEP_TYPES, CONTAINER_STEP_TYPES, hasChildren, getChildren, getParentStepId, isParallelContainer, getForEach } from './ast-helpers.js';
// 语言运行时基础能力已迁 spec-ast（见 design/spec-ast.md ^anc-struct-spec-ast）：
// StepStatus/VariableStore（状态+变量存储）、getWriteScope/buildStepMap/SCOPE_CREATING_TYPES（作用域定位）、isTruthy（真值语义）。
import type { StepStatus, VariableStore } from './ast-runtime.js';
import { getWriteScope, buildStepMap, SCOPE_CREATING_TYPES, isTruthy, isTerminalStatus } from './ast-runtime.js';
import { parseExpression, exprMapChildren } from './act-body-parser.js';
import type { ActExpr } from './ast-types.js';
import { evalExprSync } from './act-body-interpreter.js';
import type { ParseError } from './errors.js';

const DEFAULT_MAX_ITERATIONS = 100;

/** DFS 遍历共享状态——步骤状态映射、变量存储、loop 计数器及 newlyRunning/newlyDone 回收通道。见 [[exec-engine#^anc-exec-dfs-traversal]] */
export interface TraversalState {
  stepStates: Map<string, StepStatus>;
  variables: VariableStore;
  loopCounters: Map<string, number>;
  // 串行迭代预算复位（可选——engine 注入;与派发路径"预算按迭代独立"同语义,2026-08-21 补配）
  retryCounters?: Map<string, number>;
  newlyRunning?: StepNode[];
  // 容器 done 通道(可选):propagateCompletion 把进入终态的容器(subtask/loop/branch/case)
  // push 进来,调用方 engine 据此对每个容器调 recordStepDone/Failed。
  // parallel 容器不走此通道(joinParallel 直接记录)。见 ^anc-obs-step-done-timing。
  newlyDone?: { node: StepNode; failed: boolean }[];
  // 条件求值观测通道:evaluateCondition 的 onWarn 汇入,engine 消费写 HopLog warn。
  condWarnings?: { stepId: string; message: string }[];
  // 条件计算异常 → branch fail 的原因传递（"fail 即异常"定稿,2026-08-09）:
  // handleBranchEntry 置入,engine 消费 recordStepFailure+升级链。
  branchCondError?: { stepId: string; reason: string };
  // on_fail 已激活集（^anc-step-on-fail）：宿主 retry 耗尽激活兜底时登记——dfs 对未激活
  // 兜底块整树标 skipped,激活后照常下钻。引擎持久化随 state.json。// @a: anc-exec-on-fail
  onFailActive?: Set<string>;
  // on_fail 已消耗集（2026-09-04 激活/消耗分离——兜底子树真实走完才登记;activateOnFail 的
  // 拒绝条件判本集,已激活未消耗重复激活幂等。0037 死法②:单集身兼两职,"已激活未执行"被当
  // "已用过"拒绝再激活直接上浮）。引擎持久化随 state.json。// @a: anc-exec-on-fail
  onFailConsumed?: Set<string>;
  // 续链失败半边待喂账（^anc-exec-parallel-reap-chain）：并行 call 失败投回壳后,壳兜底走完
  // 完结的那一刻（本传播级联内、loop 轮进之前）按账喂 collect 缓冲——级联后再扫账,壳已被
  // 轮进复位成 pending,时机错过。喂毕即销账;壳终 failed 的账由 engine.markSubtaskFailed 清。
  pendingChainFeeds?: { chain_child_id: string; loop_id: string; iter: number; unit_var: string; list_var: string }[];
  // 统一模型收齐门（call parallel）：loop 迭代耗尽时若本 loop 仍有在飞子实例，
  // 完成条件未满足——不 finalize 不标 done，容器保持 running 等收齐（drain）。
  // engine 注入判定（在飞记账在 engine 侧）。// @a: anc-exec-parallel-reap-drain
  hasInflightFor?: (loopStepId: string) => boolean;
  // 统一模型派发门（subtask parallel，P0.5）：开启时 pending 的 subtask parallel 不进子树，
  // 作为派发单元交 engine（dispatch_ready）。关闭（复用模式/worker 子实例）→ 按普通容器
  // 串行下钻=退化窗口零专门代码。见 [[parallel-execution#^anc-exec-parallel-reap-drain]]。
  // @a: anc-exec-parallel-dispatch-model
  unifiedDispatch?: boolean;
}

/** DFS 遍历结果——executable（命中可执行步骤）/exit（触发提前退出）/retry（控制流后重新遍历）/none（无可执行节点）四态之一。见 [[exec-engine#^anc-exec-dfs-traversal]] */
export type TraversalResult =
  | { kind: 'executable'; step: StepNode }
  | { kind: 'exit'; step: ExitStep }
  | { kind: 'retry' }
  | { kind: 'none' }
  | { kind: 'branch_failed'; stepId: string; reason: string }
  | { kind: 'dispatch'; step: StepNode }   // 统一模型：subtask parallel 派发单元（不进子树）// @a: anc-exec-parallel-dispatch-model
  | { kind: 'expand'; step: StepNode };   // subtask free 空容器到步——停下索计划（^anc-exec-subtask-free-expand）// @a: anc-exec-subtask-free-expand

/** 深度优先前序遍历步骤树，定位下一个可执行节点：容器自动展开标 running、branch 内部评估条件、loop/控制流状态转移。见 [[exec-engine#^anc-exec-dfs-traversal]] */
export function dfsNextStep(steps: StepNode[], state: TraversalState, spec: SpecAST): TraversalResult { // @a: anc-exec-dfs-traversal
  for (const step of steps) {
    const status = state.stepStates.get(step.step_id);

    if (isTerminalStatus(status)) continue;

    if (status === 'pending') {
      // on_fail 失败兜底块（^anc-step-on-fail）：常规执行流跳过——它是失败路径专用块,
      // 只在宿主 retry 耗尽时被 engine 激活（activateOnFail 置 pending 前先清本 skip）。
      // 未激活即整树 skipped（正常路径零成本）。// @a: anc-exec-on-fail
      if (step.step_type === 'on_fail' && !state.onFailActive?.has(step.step_id)) {
        state.stepStates.set(step.step_id, 'skipped');
        const skipAll = (nodes: StepNode[]): void => {
          for (const n of nodes) { state.stepStates.set(n.step_id, 'skipped'); if (hasChildren(n)) skipAll(getChildren(n)); }
        };
        skipAll(getChildren(step));
        // skip 后必须触发完成级联+重遍历（branch skipped 同款纪律）——只 continue 会让宿主
        // 容器（children 已全终态）无人闭合,dfs 越过未闭合容器直落后续步骤（三次复审探针
        // 实抓:正常路径轮 1 成功后 exit 被提前执行,完备性闸误报 never assigned）。
        // // @a: anc-exec-on-fail
        propagateCompletion(step.step_id, state, spec);
        return { kind: 'retry' };
      }
      if (step.step_type === 'break') {
        handleBreak(step, state, spec);
        return { kind: 'retry' };
      }
      if (step.step_type === 'continue') {
        handleContinue(step, state, spec);
        return { kind: 'retry' };
      }
      if (step.step_type === 'exit') {
        handleExit(step as ExitStep, state, spec);
        return { kind: 'exit', step: step as ExitStep };
      }

      if (EXECUTABLE_STEP_TYPES.has(step.step_type)) {
        // 叶子 `+ → x = 初值` 每次执行前重置：写入 default 到叶子的 write scope（最近容器 scope）。
        // loop 内每轮该步执行即每轮重置（Python `x=None` 语义）。仅带 default 的输出触发，opt-in。
        // 见 ^anc-exec-output-init。// @a: anc-exec-output-init
        if (step.outputs?.some(o => o.default !== undefined)) {
          const leafScope = getWriteScope(step.step_id, spec);
          for (const o of step.outputs) {
            if (o.default !== undefined) state.variables.write(o.name, o.default, leafScope);
          }
        }
        return { kind: 'executable', step };
      }

      if (CONTAINER_STEP_TYPES.has(step.step_type)) {
        // 统一模型派发门：subtask parallel（callee 申报）在 unifiedDispatch 下不进子树，
        // 整棵作为派发单元交 engine 异步派发——主线随即继续下一兄弟/下一迭代。
        // 门关（复用模式/worker）时落到下方普通容器路径串行下钻（退化窗口）。
        // @a: anc-exec-parallel-dispatch-model
        // case 就是 branch 下的 subtask——parallel 宿主三型（2026-08-13 作者定）。case 的派发
        // 前提=分支已命中（handleBranchEntry 先选臂,未命中臂 skipped 不会走到这）// @a: anc-step-parallel
        if (state.unifiedDispatch && (step.step_type === 'subtask' || step.step_type === 'case')
          && (step as import('./ast-types.js').SubtaskStep).parallel) {
          return { kind: 'dispatch', step };
        }
        // subtask free 空容器到步——不进子树（没有子树）、不标 running,吐展开信号交 engine
        // 组索计划载荷（^anc-exec-subtask-free-expand 契约1;非空 free=预填计划,落普通容器路径照常执行）。
        // @a: anc-exec-subtask-free-expand
        if (step.step_type === 'subtask' && (step as import('./ast-types.js').SubtaskStep).free === true
          && getChildren(step).length === 0) {
          return { kind: 'expand', step };
        }
        state.stepStates.set(step.step_id, 'running');
        state.newlyRunning?.push(step);
        ensureScope(step, state, spec);

        if (step.step_type === 'branch') {
          const evalResult = handleBranchEntry(step as BranchStep, state, spec);
          // 条件计算异常 → branch fail,交 engine 走标准升级链（"fail 即异常",2026-08-09）。// @a: anc-exec-none-propagation
          if (evalResult === 'error') return { kind: 'branch_failed', stepId: step.step_id, reason: state.branchCondError?.reason ?? '条件求值失败' };
          // 静默跳过已级联终态——重遍历（级联可能推进 loop 下一轮并重置兄弟步骤，
          // 当前栈继续下钻会用新一轮变量评估本节点、跳过被重置的前置步骤——实测撞出）。
          if (evalResult === 'skipped') return { kind: 'retry' };
        }

        if (step.step_type === 'loop') {
          const loop = step as LoopStep;
          const fe = getForEach(loop);
          if (fe) {   // 串行 for-each 唯一形态（loop 头 parallel 已废除）
            // 串行 for-each 入口（概念 ^anc-step-loop 两驱动形态；此前仅 parallel 形态有实现，
            // 串行掉进条件循环空转——review 抓出"校验绿但不可执行"）：按列表长度驱动，
            // itemVar 首轮绑定进 loop scope；收集列表 init 在父 scope（进行式收集，break 天然
            // 得部分列表、跨进程 resume 靠 vars.json 恢复，无新增持久化状态）。
            // 见 [[exec-engine#^anc-exec-foreach-serial]]。// @a: anc-exec-foreach-serial
            // 扁平命名空间（2026-08-09 重构）：变量一律落 root——itemVar、child 单项值、
            // 终态收集列表都在 root 同名槽上。**loop scope 仅作引擎私有收集缓冲区**（迭代
            // 推进把 root 上的本轮单项快照进缓冲，终态整体写回 root）——vars.json v2 scope
            // 树自然持久化缓冲，无新增状态。root 槽在循环期间是"本轮值"（哨兵 null 防
            // skipped 轮重收），终态才是列表——外部读者按 S12/顺序在 loop 终态后读，无中间态暴露。
            // 双语义分流：带 = 初值 → 累加器（ensureScope 已灌 root，子步骤更新模式累加，
            // 不走缓冲归并）；不带 → 收集列表。
            const listVal = state.variables.read(fe.listVar, 'root');
            const items = Array.isArray(listVal) ? listVal : [];   // 非列表 V8 静态拦；运行时 null 兜底空列表
            // 进入即清（2026-09-07 作者拍"loop 一旦执行,collect 操作清空初值"——收割缓冲此前
            // 不在入口清,靠 retry/replan 来路补丁,漏路即 G244 翻倍;入口一处兑现后来路补丁删除,
            // 且天然罩住晚到的旧轮收割喂账。hasScope 守卫罩两笔——防御性冗余:扁平命名空间下
            // getWriteScope 恒 root,ensureScope 进入必建 scope,守卫现行不可达（两批 review 实测
            // 核证,窄执行下收集照常走）;留它防 write 落点 ?? root 回退的机制性风险面（scope 创建
            // 时序将来若变,无守卫即静默覆写 root 同名变量+泄漏引擎键）。两批 review 面二抓旧笔裸写同修。
            // @a: anc-exec-collect-ledger-reset
            const loopScopeReady = state.variables.hasScope(step.step_id);
            for (const c of getCollectPairs(loop)) {
              if (loopScopeReady) {
                state.variables.write(c.listVar, [], step.step_id);   // loop scope = 私有缓冲
                state.variables.write(`__reaped_${c.listVar}`, null, step.step_id);   // 收割缓冲同点清
              }
              state.variables.write(c.unitVar, null, 'root');        // 单项槽哨兵复位
            }
            if (items.length === 0) {
              for (const c of getCollectPairs(loop)) {
                state.variables.write(c.listVar, [], 'root');
              }
              state.stepStates.set(step.step_id, 'done');
              skipAllChildren(step, state);
              continue;
            }
            state.loopCounters.set(step.step_id, 1);
            state.variables.write(fe.itemVar, items[0], 'root');
          } else {
            const maxIter = loop.max_iterations ?? DEFAULT_MAX_ITERATIONS;
            if (maxIter === 0) {
              state.stepStates.set(step.step_id, 'done');
              skipAllChildren(step, state);
              continue;
            }
            state.loopCounters.set(step.step_id, 1);
          }
        }

        const children = getChildren(step);
        if (children.length > 0) {
          const result = dfsNextStep(children, state, spec);
          if (result.kind !== 'none') return result;
        }
        continue;
      }
    }

    // running 叶子=已派出待回写的活跃态——DFS 撞到即停(返 none,引擎 WAITING_WRITEBACK 防线
    // 接手),不再透明跳过扫后继兄弟(hopissues/0049——原 continue 使防线只在"恰好无后继"时
    // 可达:两步 spec 安全三步就漏;错位递交把指针推过等回写的步,双 running 不可能态)
    // @a: anc-exec-stale-resubmit
    if (status === 'running' && !CONTAINER_STEP_TYPES.has(step.step_type)) {
      return { kind: 'none' };
    }
    if (status === 'running' && CONTAINER_STEP_TYPES.has(step.step_type)) {
      const children = getChildren(step);
      if (children.length > 0) {
        const result = dfsNextStep(children, state, spec);
        if (result.kind !== 'none') return result;
      }
      // running 容器子树返 none 的两种成因必须区分（^anc-exec-advance-order-invariant,
      // 2026-09-05 0075 批——0049 修了同层挡板〔上方 running 叶子分支〕,叶子嵌在 running
      // 容器内时递归返 none 被无条件 continue,嵌套半边漏了:机械步消化循环越过等回写的
      // 叶子连锁直执到 commit,探针 stp2b/stp2c 实证裸 advance 也乱序）：
      // ① 子树内存在 running 的非容器叶子（已派出等回写）→ 推进阻塞,整个 dfs 返 none
      //   （引擎 WAITING_WRITEBACK 防线接手）,不得扫后继兄弟;
      // ② 子树全终态（容器待完成级联闭合）→ continue 扫后继兄弟合法。
      // @a: anc-exec-advance-order-invariant
      if (subtreeHasRunningLeaf(step, state)) return { kind: 'none' };
      // 收齐门（gather barrier，统一模型 §U3）：本容器子树内仍有在飞子实例 → 容器未完成，
      // 主线不得越过它扫描后续兄弟（容器边界=收齐点）。返回 none 由 engine 折为 drain_wait。
      // @a: anc-exec-parallel-reap-drain
      if (state.hasInflightFor?.(step.step_id)) return { kind: 'none' };
      continue;
    }
  }

  return { kind: 'none' };
}

/** running 容器子树内是否存在 running 的非容器叶子（已派出等回写的执行步）——
 * dfsNextStep running 容器分支的两种 none 判据（①推进阻塞 vs ②待闭合）。
 * 容器 running 是结构状态不算"在等"（与 engine.findWritebackTarget 同口径）。
 * 见 [[exec-engine#^anc-exec-advance-order-invariant]]。// @a: anc-exec-advance-order-invariant */
function subtreeHasRunningLeaf(container: StepNode, state: TraversalState): boolean {
  for (const child of getChildren(container)) {
    const st = state.stepStates.get(child.step_id);
    if (st === 'running' && !CONTAINER_STEP_TYPES.has(child.step_type)) return true;
    if (hasChildren(child) && subtreeHasRunningLeaf(child, state)) return true;
  }
  return false;
}

/** commit 执行入口动态核（^anc-exec-advance-order-invariant 防线二,两模式两入口共用判定
 * 公共件）：文档序先于目标 commit 步的全部步骤必须已终态（done/skipped/failed）——存在
 * pending/running 即拒（返回第一个未终态步骤 id）,全终态返回 null 放行。parallel 派发即
 * done 是声明豁免（派发路径已置 done,本核自然放行）。
 * 见 [[exec-engine#^anc-exec-advance-order-invariant]]。// @a: anc-exec-advance-order-invariant */
export function findNonTerminalBefore(
  commitStepId: string,
  steps: StepNode[],
  stepStates: Map<string, StepStatus>,
): string | null {
  const flat: StepNode[] = [];
  const walk = (nodes: StepNode[]): void => {
    for (const n of nodes) { flat.push(n); if (hasChildren(n)) walk(getChildren(n)); }
  };
  walk(steps);
  for (const n of flat) {
    if (n.step_id === commitStepId) return null;   // 走到本步=前序全过
    const st = stepStates.get(n.step_id);
    // 祖先容器 running 是结构状态（执行流正在其内推进到本 commit）,不算未终态;
    // 非祖先的 running 容器（旁系）意味着其内仍有活没走完,算未终态拦。
    if (st === 'pending') return n.step_id;
    if (st === 'running') {
      const isAncestor = commitStepId.startsWith(n.step_id + '.');
      if (!isAncestor) return n.step_id;
    }
  }
  return null;   // commit 步不在树上（call 子实例收窄等形态）——不拦,归调用方状态机
}

// 旧通道 collectParallelBatch/subtreeContainsPausePoint 已删（P0.5）——统一模型派发门见
// dfsNextStep 的 dispatch 分支（unifiedDispatch）。// @a: anc-exec-parallel-dispatch-model

/** 完成级联：某步终态后递归向上检查父容器，全 children 终态则容器完成并按声明 +→ 提升聚合输出、loop 触发下轮迭代。见 [[exec-engine#^anc-exec-completion-cascade]] */
export function propagateCompletion(stepId: string, state: TraversalState, spec: SpecAST): void { // @a: anc-exec-completion-cascade, anc-exec-container-output
  const parentId = getParentStepId(stepId);
  if (!parentId) return;

  const stepMap = buildStepMap(spec);
  const parent = stepMap.get(parentId);
  if (!parent) return;

  if (!CONTAINER_STEP_TYPES.has(parent.step_type)) return;

  const children = getChildren(parent);
  const allTerminal = children.every(c => isTerminalStatus(state.stepStates.get(c.step_id)));

  if (!allTerminal) return;

  if (parent.step_type === 'loop') {
    // parallel 形态 loop（for-each+parallel）不走迭代推进——fan-out/join 归 engine.joinParallel；
    // worker 子实例（subtreeRoot=单 child）内 propagate 到父 loop 时若误入下方条件循环分支，
    // 会 resetChildrenToPending 无限重跑同一 batch（2026-08-08 真机审计实撞：worker 内
    // loop_counters 5.2:3、同批审 3 遍后 'No executable step found' failed——parallel 降属性
    // 重构回归：旧 [parallel] 类型天然不匹配 step_type==='loop'，降属性后落进迭代逻辑）。
    // @a: anc-exec-parallel-foreach-worker
    const loop = parent as LoopStep;
    const fe = getForEach(loop);
    const allChildrenDoneOrSkipped = children.every(c => {
      const s = state.stepStates.get(c.step_id);
      return s === 'done' || s === 'skipped';
    });
    if (fe) {
      // 串行 for-each 迭代推进：本轮 children 同名输出 append 到父 scope 收集列表 →
      // 未耗尽则 itemVar 绑定下一元素、收集槽复位（防 skipped 轮误收上轮残值）、children 重置。
      // 收集进行式落父 scope：break 中断即天然部分列表（概念 ^anc-step-loop）。
      // 见 [[exec-engine#^anc-exec-foreach-serial]]。// @a: anc-exec-foreach-serial
      if (allChildrenDoneOrSkipped) {
        const listVal = state.variables.read(fe.listVar, 'root');
        const items = Array.isArray(listVal) ? listVal : [];
        const currentIter = state.loopCounters.get(parentId) ?? 1;
        // call parallel 产出的 unitVar 不走轮末传送带——子实例收割时按 iter 直写缓冲
        // （engine.reapInflight），轮末重复收会塞哨兵 null。// @a: anc-exec-parallel-reap-drain
        const asyncUnits = getAsyncUnitVars(loop);
        for (const c of getCollectPairs(loop)) {
          if (asyncUnits.has(c.unitVar)) continue;
          // 传送带归并：unitVar 槽 = 本轮单项值（child 写 root；skipped 轮为哨兵 null）。
          // 快照进 loop scope 私有缓冲（键=listVar）。同引用防御保留（防单项值意外指向
          // 缓冲自身——B1 自引用实撞的结构性防线，见 nested-loop-accumulator 测试）。
          const v = state.variables.read(c.unitVar, 'root');
          const buffer = state.variables.readLocal(c.listVar, parentId);
          if (Array.isArray(buffer)) {
            buffer.push(v === buffer ? null : (v ?? null));
            state.variables.write(c.unitVar, null, 'root');   // 单项槽复位（传送带运走）
          }
        }
        if (currentIter < items.length) {
          state.loopCounters.set(parentId, currentIter + 1);
          state.variables.write(fe.itemVar, items[currentIter], 'root');
          resetChildrenToPending(children, state);
          return;
        }
        // 收齐门（统一模型 §U3）：迭代耗尽但本 loop 仍有在飞子实例 → 完成条件未满足，
        // 容器保持 running 等收齐——不 finalize（缓冲还在收）不标 done。
        // 全部收好后 engine.reapInflight 会再触发本级联。// @a: anc-exec-parallel-reap-drain
        if (state.hasInflightFor?.(parentId)) return;
        // 列表耗尽 → 缓冲整体写回 root（收集列表成为对外可见的终值）
        finalizeForEachCollect(loop, state);
      }
      // 含 failed child → 同样把已收缓冲写回 root（部分列表），落到下方终态。
      if (!allChildrenDoneOrSkipped) finalizeForEachCollect(loop, state);
    } else {
      const maxIter = loop.max_iterations ?? DEFAULT_MAX_ITERATIONS;
      const currentIter = state.loopCounters.get(parent.step_id) ?? 1;

      if (currentIter < maxIter) {
        if (allChildrenDoneOrSkipped) {
          state.loopCounters.set(parent.step_id, currentIter + 1);
          resetChildrenToPending(children, state);
          // Python 语义：变量跨迭代自然保留，引擎不清当轮变量。
          // 需每轮重置的量由作者在子步骤显式 `+ → x = Null`（叶子每轮执行即重置）。
          // 见 [[exec-engine]] 变量作用域规则 6 / 概念 ^anc-exec-loop-var-scope。// @a: anc-exec-loop-var-scope
          return;
        }
      }
    }
  }

  // 退化窗口（unifiedDispatch 关/配1）下的 parallel subtask 串行完成：声明输出喂 loop collect 的
  // __reaped_ 缓冲——与派发收割（engine.reapParallelSubtask）同一通道。否则 getAsyncUnitVars
  // 判该 unitVar 为异步而轮末传送带跳过、又无 reap 来喂 → collect 恒空（BUG-B
  // ^todo-bug-parallel-collect-serial）。见 parallel-execution §U3「标注步骤产出的单项随收割收」
  // 在退化下的等价落点（顺序模拟等价性：串行执行的 parallel subtask 输出须与派发收割同终值）。
  if (parent.step_type === 'subtask' && (parent as import('./ast-types.js').SubtaskStep).parallel) {
    feedSerialParallelSubtaskCollect(parent, state, spec);
  }

  // Promote container declared outputs to parent scope（串行 for-each 除外：收集列表已进行式
  // 写在父 scope，loop scope 里是最后一轮的单值——通用提升会用单值覆写列表）。// @a: anc-exec-foreach-serial
  const isSerialForEach = parent.step_type === 'loop' && getForEach(parent);
  if (parent.outputs && parent.outputs.length > 0 && SCOPE_CREATING_TYPES.has(parent.step_type)) {
    const containerScope = parentId;
    const parentScope = getWriteScope(parentId, spec);
    for (const decl of parent.outputs) {
      // 串行 for-each 收集列表（无 default）跳过——已进行式落父 scope，loop scope 是末轮
      // 单值，通用提升会覆写列表；累加器（带 default）正常提升（终值在 loop scope）。
      if (isSerialForEach && decl.default === undefined) continue;
      const val = state.variables.read(decl.name, containerScope);
      if (val !== undefined) {
        state.variables.write(decl.name, val, parentScope);
      }
    }
  }

  // branch 完成判定：被选中的 case 失败即 branch 失败（concept: 被激活的 case 失败 → branch 失败）
  // 其余 case 为 skipped，仅当选中的 case（非 skipped）为 failed 时 branch failed
  if (parent.step_type === 'branch') {
    const activeFailed = children.some(c => state.stepStates.get(c.step_id) === 'failed');
    state.stepStates.set(parentId, activeFailed ? 'failed' : 'done');
    state.newlyDone?.push({ node: parent, failed: activeFailed });
    propagateCompletion(parentId, state, spec);
    return;
  }

  // 收齐门（统一模型 §U3，兄弟位）：children 全终态但本容器仍有在飞（subtask parallel
  // 派发即标 done、结果未收）→ 容器保持 running 等收齐，engine.settleHostAfterReap 终态化。
  // @a: anc-exec-parallel-reap-drain
  if (state.hasInflightFor?.(parentId)) return;
  // 兜底消耗登记（2026-09-04 激活/消耗分离）：on_fail 容器自身完结=兜底真实走完——此刻才算
  // "已用过"（activateOnFail 拒绝条件判消耗集非激活集）。// @a: anc-exec-on-fail
  if (parent.step_type === 'on_fail' && state.onFailActive?.has(parentId)) {
    state.onFailConsumed?.add(parentId);
  }
  state.stepStates.set(parentId, 'done');
  // 续链失败半边待喂账兑现（^anc-exec-parallel-reap-chain）：完结的容器若挂着待喂账（并行
  // call 失败投回壳,兜底走完至此),边界产出此刻已在容器 scope（上方提升块刚写完）——按账取
  // 被收集变量喂 loop 的 __reaped_ 缓冲,喂毕销账。必须在本级联内做:级联传到 loop 层会轮进
  // 复位 children,之后再扫账值已被清。// @a: anc-exec-parallel-reap-chain
  if (state.pendingChainFeeds?.length) {
    for (let i = state.pendingChainFeeds.length - 1; i >= 0; i--) {
      const feed = state.pendingChainFeeds[i];
      if (feed.chain_child_id !== parentId) continue;
      // 只喂账上点名的那一对（复阅实抓:遍历壳全部收集对=已直喂的对被再喂一遍元素翻倍,
      // 未写壳作用域的对穿透读到 root 残值幻影 null 入列——账携 unit_var/list_var 按对兑现）
      const v = state.variables.read(feed.unit_var, parentId);
      if (v !== undefined && v !== null) {   // null 同挡（作用域链穿透读到 root 初始 null 的幻影形态）
        const key = `__reaped_${feed.list_var}`;
        const buf = (state.variables.readLocal(key, feed.loop_id) as [number, unknown][] | null) ?? [];
        buf.push([feed.iter, v]);
        state.variables.write(key, buf, feed.loop_id);
      }
      state.pendingChainFeeds.splice(i, 1);
    }
  }
  // parallel 容器 done 由 joinParallel 直接记录,此通道排除 parallel(避免重复)。
  // 见 design/spec-observability.md ^anc-obs-step-done-timing。
  if (!isParallelContainer(parent)) {
    state.newlyDone?.push({ node: parent, failed: false });
  }
  propagateCompletion(parentId, state, spec);
}

/** 求值 branch case 条件表达式：`{var}` 真值判定、`{var}==literal` / `{var}!=literal` 字符串比较，空条件恒真（default case）。见 [[exec-engine#^anc-exec-dfs-traversal]] */
// 返回 boolean=正常判定;返回 {error} = 条件计算异常(2026-08-09 定稿:计算异常也是 fail——
// 条件算错即 branch fail,不折 falsy 继续跑)。
export function evaluateCondition(
  condition: string | undefined,
  variables: VariableStore,
  scopeId: string,
  onWarn?: (msg: string) => void,
): boolean | { error: string } {
  if (!condition || condition.trim() === '') return true;

  // hop_python 纯表达式求值（2026-08-09 升格,作者裁决"一套表达式文法两个宿主"）：
  // parseExpression 解析（比较数值语义,修旧字符串化等值的 '9'>'10' 坑）+ evalExprSync 求值。
  // 解析失败返回 error → branch fail（不折 falsy 继续跑;C8 已静态拦非法条件,运行时再撞即显式失败）。
  // 见 design/exec-engine.md 条件求值规则 / spec-parser ^anc-rule-c8。// @a: anc-rule-c8
  const errs: ParseError[] = [];
  // {var} 花括号包裹形态兼容（设计既有文法:{point.type} == literal——花括号仅是变量引用
  // 记号,剥除后即合法表达式;不剥则 tokenize 拒 '{'）
  const normalized = condition.trim().replace(/\{([\w.[\]]+)\}/g, '$1');   // [N] 归一化已撤——方括号下标 2026-08-09 起是原生文法（IndexExpr）
  const parsed = parseExpression(normalized, errs);
  if (!parsed) return { error: `条件 "${condition.trim()}" 解析失败: ${errs.map(e => e.message).join('; ')}` };
  // 裸字字面量消歧（2026-08-09 作者选 C）：仅**比较运算符操作数位置**的未声明裸标识符
  // 按字符串字面量（存量 `mode == fast` 兼容,enum 比较无引号噪音）；裸真值/算术/逻辑位置
  // 的未声明变量仍按 undefined→falsy（`flag` 恒真事故不可能）。字符串字面量建议加引号（概念文法倡导）。
  const expr = disambiguateBareWords(parsed, name => variables.hasVar(name, scopeId));
  const calcErrors: string[] = [];
  const val = evalExprSync(expr, name => variables.read(name, scopeId), msg => { calcErrors.push(msg); onWarn?.(msg); });
  if (calcErrors.length > 0) {
    return { error: `条件 "${condition.trim()}" 计算异常: ${calcErrors.join('; ')}` };
  }
  return isTruthy(val);
}

/** 比较位置未声明裸字 → 字符串字面量（AST 变换,不动其他位置）。// @a: anc-rule-c8 */
function disambiguateBareWords(expr: ActExpr, isDeclared: (name: string) => boolean): ActExpr {
  const isDeclaredRef = (e: ActExpr): boolean => {
    let cur: ActExpr = e;
    while (cur.type === 'field') cur = cur.object;
    return cur.type === 'var' && isDeclared(cur.name);
  };
  if (expr.type === 'binary') {
    // 兼容边界与 C8 静态侧一致:仅"另一侧是已声明变量/字段链"时本侧裸字按字面量
    const cmp = expr.op === '==' || expr.op === '!=';
    const fix = (side: ActExpr, otherDeclared: boolean): ActExpr => {
      if (cmp && otherDeclared && side.type === 'var' && !isDeclared(side.name)) {
        return { type: 'literal', value: side.name } as ActExpr;
      }
      return disambiguateBareWords(side, isDeclared);
    };
    return { ...expr, left: fix(expr.left, isDeclaredRef(expr.right)), right: fix(expr.right, isDeclaredRef(expr.left)) };
  }
  // 推导:itemVar 绑定变量——element/filter 内 itemVar 视为已声明（否则 filter 里
  // `s == target` 的 s 被字面量化成 "s" 恒错）;source 用原判定。// @a: anc-step-act-body-comprehension
  if (expr.type === 'comprehension') {
    const innerDeclared = (name: string) => name === expr.itemVar || isDeclared(name);
    return {
      ...expr,
      element: disambiguateBareWords(expr.element, innerDeclared),
      source: disambiguateBareWords(expr.source, isDeclared),
      ...(expr.filter ? { filter: disambiguateBareWords(expr.filter, innerDeclared) } : {}),
    };
  }
  // 其余节点经 exprMapChildren 同构下钻（v0.10.0——原实现只认 // @a: anc-struct-expr-walk
  // binary/unary/field/index,三元/call 实参/list 里嵌套的比较位裸字不消歧:
  // ('y' if mode == fast else 'n')=='y' 运行时 fast 按 undefined→falsy 选错分支,
  // 而 C8 静态侧放行裸字=validate 绿 run 错分叉,探针实抓第四处同族缺陷）
  return exprMapChildren(expr, e => disambiguateBareWords(e, isDeclared));
}
function extractVarName(expr: string): string {
  if (expr.startsWith('{') && expr.endsWith('}')) {
    return expr.slice(1, -1).trim();
  }
  return expr.trim();
}

function stripQuotes(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

function handleBranchEntry(branch: BranchStep, state: TraversalState, spec: SpecAST): 'ok' | 'skipped' | 'error' {
  const scopeId = getWriteScope(branch.step_id, spec);
  const cases = branch.children;

  for (let i = 0; i < cases.length; i++) {
    const caseStep = cases[i];
    const isDefault = !caseStep.condition || caseStep.condition.trim() === '' || caseStep.condition.trim() === 'default';
    const verdict = isDefault || evaluateCondition(caseStep.condition, state.variables, scopeId,
      msg => state.condWarnings?.push({ stepId: caseStep.step_id, message: msg }));

    // 条件计算异常 = branch fail（2026-08-09 定稿:计算异常也是 fail,不折 falsy 继续跑——
    // "程序错了"与"条件不命中"必须在轨迹上可辨）。branch fail 走标准升级链(调用方处置)。
    if (typeof verdict === 'object') {
      state.condWarnings?.push({ stepId: branch.step_id, message: verdict.error });
      for (const cs of cases) skipCaseRecursive(cs, state);
      state.stepStates.set(branch.step_id, 'failed');
      state.branchCondError = { stepId: branch.step_id, reason: verdict.error };
      return 'error';
    }
    const matches = verdict === true;
    if (matches) {
      // [case(cond) parallel] 命中臂在派发门开时留 pending——case 就是 branch 下的 subtask,
      // 整棵是派发单元:直接标 running 会绕过派发门(门只拦 pending 容器),退化成串行下钻
      //（2026-08-13 定形批实撞）。门关(复用模式/worker)照旧 running 串行。// @a: anc-step-parallel
      const dispatchable = state.unifiedDispatch && (caseStep as { parallel?: boolean }).parallel;
      if (!dispatchable) {
        state.stepStates.set(caseStep.step_id, 'running');
        ensureScope(caseStep, state, spec);
        // 选中的 case 进 newlyRunning(branch 自身已被 dfsNextStep 加入),
        // nextStep 据此为 case 容器记录 step_start 骨架。未选中走 skipCaseRecursive。
        // 见 design/spec-observability.md ^anc-obs-step-start-timing。// @a: anc-obs-step-start-timing
        state.newlyRunning?.push(caseStep);
      }
      for (let j = 0; j < cases.length; j++) {
        if (j !== i) {
          skipCaseRecursive(cases[j], state);
        }
      }
      return 'ok';
    }
  }

  // No case matched — silent skip: mark branch done, all cases skipped.
  // 值空间不写入——与 case/loop 未产出同构（主动写 null 会隐式抹掉变量既有值）。
  for (const caseStep of cases) {
    skipCaseRecursive(caseStep, state);
  }
  state.stepStates.set(branch.step_id, 'done');
  // 静默跳过也是终态——必须级联（否则 branch 为容器最后一个 child 时父容器永不完成、
  // loop 永不迭代且泄漏执行后续步骤；串行 for-each 实测撞出，条件循环同样受害）。
  // 与 handleBreak 的 propagate 对称。// @a: anc-exec-completion-cascade
  propagateCompletion(branch.step_id, state, spec);
  return 'skipped';
}

/** 从 stepId 向上找最近的 loop 祖先节点（break/continue 共用）。无则 null。 */
function findNearestLoopAncestor(stepId: string, spec: SpecAST): StepNode | null {
  const stepMap = buildStepMap(spec);
  let ancestorId = getParentStepId(stepId);
  while (ancestorId) {
    const ancestor = stepMap.get(ancestorId);
    if (ancestor && ancestor.step_type === 'loop') return ancestor;
    ancestorId = getParentStepId(ancestorId);
  }
  return null;
}

/** for-each 收集对（collect 子句声明的 unitVar→listVar）。判据=显式子句（2026-08-09
 * 作者定——原类型驱动"头[T]无初值"存在同名异型裂缝，同日废除）。其余容器头输出一律
 * 普通变量（末值导出/累加器），引擎零动作。 */
export function getCollectPairs(loop: LoopStep): { unitVar: string; listVar: string }[] {
  return loop.collect ?? [];
}

/** 循环体内 call parallel 步骤产出的 unitVar 集合——这些收集对不走轮末传送带
 * （值在子实例收割时按 iter 直写缓冲，见 engine.reapInflight），轮末重复收会塞进
 * 哨兵 null。统一模型 §U3。// @a: anc-exec-parallel-reap-drain */
export function getAsyncUnitVars(loop: LoopStep): Set<string> {
  const out = new Set<string>();
  for (const d of collectDescendants(loop)) {
    const isAsyncCall = d.step_type === 'call' && (d as import('./ast-types.js').CallStep).parallel;
    const isAsyncSubtask = d.step_type === 'subtask' && (d as import('./ast-types.js').SubtaskStep).parallel;
    if (isAsyncCall) {
      for (const m of (d as import('./ast-types.js').CallStep).output_mapping ?? []) out.add(m.to);
    }
    if (isAsyncCall || isAsyncSubtask) {
      for (const o of d.outputs ?? []) out.add(o.name);
    }
  }
  return out;
}

/** 退化窗口下的 parallel subtask 串行完成 → 声明输出按 [iter, value] 喂最近 loop 的
 * __reaped_<listVar> 缓冲（与 reapParallelSubtask 同一收集通道）。仅当 loop 确在执行
 * （其 collect 缓冲在场）时生效——worker 子树内祖先 loop 未执行，缓冲不在场即天然跳过，
 * 不产生幽灵条目。// @a: anc-exec-parallel-reap-drain */
function feedSerialParallelSubtaskCollect(subtask: StepNode, state: TraversalState, spec: SpecAST): void {
  const loop = findNearestLoopAncestor(subtask.step_id, spec);
  if (!loop || loop.step_type !== 'loop') return;
  const collectUnits = new Map((loop as LoopStep).collect?.map(p => [p.unitVar, p.listVar]) ?? []);
  if (collectUnits.size === 0) return;
  const iter = state.loopCounters.get(loop.step_id) ?? 1;
  for (const decl of subtask.outputs ?? []) {
    const listVar = collectUnits.get(decl.name);
    if (!listVar) continue;
    if (!Array.isArray(state.variables.readLocal(listVar, loop.step_id))) continue;   // loop 未执行
    const val = state.variables.read(decl.name, subtask.step_id);
    if (val === undefined) continue;
    const key = `__reaped_${listVar}`;
    const buf = (state.variables.readLocal(key, loop.step_id) as [number, unknown][] | null) ?? [];
    buf.push([iter, val]);
    state.variables.write(key, buf, loop.step_id);
  }
}

/** 串行 for-each 终态：loop scope 私有缓冲整体写回 root 同名槽（收集列表对外可见）。
 * 耗尽/break/failed 三条终态路径共用——不调则 root 残留末轮单项值。幂等（缓冲不存在即跳过）。
 * 统一模型：call parallel 的收割值在 `__reaped_<listVar>`（[iter, value] 对，engine.reapParallelCall
 * 写入），此处按 iter 排序合入——列表序=派发序，失败的活缺席（列表变短）。// @a: anc-exec-parallel-reap-drain */
export function finalizeForEachCollect(loop: LoopStep, state: TraversalState): void {
  for (const c of getCollectPairs(loop)) {
    const buffer = state.variables.readLocal(c.listVar, loop.step_id);
    const reaped = state.variables.readLocal(`__reaped_${c.listVar}`, loop.step_id);
    let final: unknown[] | null = Array.isArray(buffer) ? buffer : null;
    if (Array.isArray(reaped) && reaped.length > 0) {
      const sorted = [...(reaped as [number, unknown][])].sort((a, b) => a[0] - b[0]).map(p => p[1]);
      final = [...(final ?? []), ...sorted];
    }
    if (final) state.variables.write(c.listVar, final, 'root');
  }
}

function handleBreak(step: StepNode, state: TraversalState, spec: SpecAST): void {
  state.stepStates.set(step.step_id, 'done');
  const loop = resolveTargetLoop(step, spec);
  if (loop) {
    skipRemainingInContainer(loop, state);
    // 收齐门（break=「后面不派了」正常路径，不杀活）：仍有在飞 → loop 保持 running 等收齐，
    // engine.reapInflight 收完最后一个时再终态化。// @a: anc-exec-parallel-reap-drain
    if (state.hasInflightFor?.(loop.step_id)) return;
    state.stepStates.set(loop.step_id, 'done');
    // break 终态：已收缓冲写回 root（概念 ^anc-step-loop：部分列表）。break 轮不算完成迭代，不收。
    if (getForEach(loop)) finalizeForEachCollect(loop as LoopStep, state);
    propagateCompletion(loop.step_id, state, spec);
  }
}

function handleContinue(step: StepNode, state: TraversalState, spec: SpecAST): void {
  state.stepStates.set(step.step_id, 'done');
  const loop = resolveTargetLoop(step, spec);
  if (loop) {
    skipRemainingInContainer(loop, state);
    // 从目标循环的直接子节点起传播——从 continue 步自身起时,传播链先经中间层嵌套循环,
    // 中间循环见 children 全终态即抢先推进自己的迭代,目标外层反被终态化（targeted continue
    // review 探针实撞 2026-08-16）。直接子节点起传播 → parent 即目标循环,迭代推进落对。
    const rel = step.step_id.slice(loop.step_id.length + 1);
    const directChildId = `${loop.step_id}.${rel.split('.')[0]}`;
    propagateCompletion(directChildId, state, spec);
  }
}

/** break/continue 的目标循环解析：带 target_loop 找指定祖先循环（C3 已保证存在且是祖先 loop,
 * 此处防御性核验后回退最近祖先）,缺省=最近祖先循环。// @a: anc-step-break, anc-step-continue */
function resolveTargetLoop(step: StepNode, spec: SpecAST): StepNode | null {
  const target = (step as import('./ast-types.js').BreakStep | import('./ast-types.js').ContinueStep).target_loop;
  if (target) {
    const stepMap = buildStepMap(spec);
    const node = stepMap.get(target);
    if (node && node.step_type === 'loop' && step.step_id.startsWith(target + '.')) return node;
    // C3 拦过不该到这——防御性回退最近祖先（不静默吞:上层 HopLog warn 由 caller 记）
  }
  return findNearestLoopAncestor(step.step_id, spec);
}

function handleExit(step: ExitStep, state: TraversalState, spec: SpecAST): void {
  state.stepStates.set(step.step_id, 'done');

  if (step.exit_outputs) {
    const scopeId = getWriteScope(step.step_id, spec);
    for (const [k, v] of Object.entries(step.exit_outputs)) {
      state.variables.write(k, v, scopeId);
    }
  }

  for (const [id, status] of state.stepStates) {
    if (status === 'pending' || status === 'running') {
      if (id !== step.step_id) {
        state.stepStates.set(id, 'skipped');
      }
    }
  }
}

function ensureScope(step: StepNode, state: TraversalState, spec: SpecAST): void {
  if (!SCOPE_CREATING_TYPES.has(step.step_type)) return;
  // 显式判"已存在"（loop 重进 / resume 已恢复），不建、不重灌初值——避免用 createScope 抛错做控制流。
  if (state.variables.hasScope(step.step_id)) return;
  const parentScope = getWriteScope(step.step_id, spec);
  // parent scope 未建则跳过——worker 子实例 executeSubtreeOnly 收窄执行到 child 子树、父容器 scope 不建，
  // 此时 child 容器的 parent 缺失是合法的（旧实现靠 createScope 抛错被 catch 吞，现显式判）。
  if (!state.variables.hasScope(parentScope)) return;
  state.variables.createScope(step.step_id, parentScope);
  // 容器节点 `+ → acc = 初值` 的 init-once：仅首次创建 scope 时写入（loop 每轮重进/resume 恢复都提前 return，
  // 不重灌 → 累加器保值）。扁平命名空间：初值写 root（同名=同一变量，全空间唯一）。
  // 见 ^anc-exec-output-init。// @a: anc-exec-output-init
  if (step.outputs) {
    for (const o of step.outputs) {
      if (o.default !== undefined) state.variables.write(o.name, o.default, 'root');
    }
  }
}

function skipCaseRecursive(caseStep: CaseStep, state: TraversalState): void {
  state.stepStates.set(caseStep.step_id, 'skipped');
  skipAllChildren(caseStep, state);
}

// 标记子孙：pending → skipped（未执行的才算跳过）；running **容器** → done（执行路径——
// 命中的 branch/case 链执行到了 break/continue,是走过不是被跳过;一层收尾只转 loop 直接
// 子级时,嵌套命中 case 残留 running,loop done 后 DFS 不再下钻,唯一撞到它的是 commit
// 执行序预检 findNonTerminalBefore——质检全过的产物死在交付步,todo/0080 实撞 2026-09-08）；
// running **非容器叶子**不动（等回写的真工作不能强转——break/continue 同步消化语义下该
// 形态不可达〔自己就是执行点,旁系在飞有 hasInflightFor 收齐门先挡〕,判据保守防御）；
// 已 done/failed/skipped 不动。// @a: anc-step-break, anc-step-continue
function skipAllChildren(step: StepNode, state: TraversalState): void {
  if (!hasChildren(step)) return;
  for (const child of getChildren(step)) {
    const st = state.stepStates.get(child.step_id);
    if (st === 'pending') {
      state.stepStates.set(child.step_id, 'skipped');
    } else if (st === 'running' && CONTAINER_STEP_TYPES.has(child.step_type)) {
      state.stepStates.set(child.step_id, 'done');
    }
    skipAllChildren(child, state);
  }
}

// break/continue 收尾 loop 时调用：未执行的 pending → skipped；
// 执行路径上的 running（如命中的 branch/case）→ done（它执行到了 break/continue，不是被跳过）；
// 已 done/failed/skipped 的不动。避免把已执行步骤误标 skipped。
function skipRemainingInContainer(container: StepNode, state: TraversalState): void {
  if (!hasChildren(container)) return;
  for (const child of getChildren(container)) {
    const status = state.stepStates.get(child.step_id);
    if (status === 'pending') {
      state.stepStates.set(child.step_id, 'skipped');
      skipAllChildren(child, state);
    } else if (status === 'running') {
      state.stepStates.set(child.step_id, 'done');
      skipAllChildren(child, state);
    }
  }
}

function resetChildrenToPending(children: StepNode[], state: TraversalState): void {
  for (const child of children) {
    state.stepStates.set(child.step_id, 'pending');
    // 新迭代=全新事务（与派发路径"预算按迭代独立"2026-08-11 同语义——串行路径此前漏配,
    // 二次复审探针实抓 2026-08-21:轮 1 耗掉的预算漂进轮 2,轮 2 首败即耗尽）：
    // ①子树 retry 预算复位;②兜底激活标记清除（轮 1 用过兜底,轮 2 耗尽该重新可兜）。
    // // @a: anc-exec-on-fail, anc-exec-retry-adaptive
    if (child.step_type === 'subtask' || child.step_type === 'case') state.retryCounters?.delete(child.step_id);
    if (child.step_type === 'on_fail') { state.onFailActive?.delete(child.step_id); state.onFailConsumed?.delete(child.step_id); }   // 新迭代兜底重新可用——激活/消耗两集同清（D69 分离后消耗集是拒绝判据,漏清=下一圈兜底被上一圈的消耗焊死）
    // commit 退火记录不清（2026-09-02 判据重构撤 0061 批清理项——记录永续带祖先 loop 轮次
    // 快照,轮内边界不被前轮焊死由轮次比对承担,外层边界对前轮 commit 照样退火。
    // 见 engine.hasCommitInRetryScope,^anc-exec-commit-anneal）。
    // 带显式 = 初值 声明的容器:删其变量 scope——下次进入 init-once 判据(hasScope)自然不成立,
    // 重建重灌（hopissues/0050 作者拍 A:外层轮进导致的重入是新的进入,"容器进入时求值写入"
    // 按字面兑现——修前不重灌,上一外层项残值静默漂进下一项,hopkb 爆炸罪正文写进决水罪.md
    // 污染落盘实撞。例外边界收窄在"作者显式写了初值":写初值即表达每次进入从初值开始;
    // 不带 default 的容器 scope 不碰,其余变量 Python 自然保留大原则不动）。
    // // @a: anc-exec-output-init
    if (CONTAINER_STEP_TYPES.has(child.step_type) && child.outputs?.some(o => o.default !== undefined)) {
      state.variables.deleteScope(child.step_id);
    }
    if (hasChildren(child)) {
      resetChildrenToPending(getChildren(child), state);
    }
  }
}

// 收集一个节点的所有后代（不含自身），用于 parallel child 子树输入解析、subtree 收窄等
export function collectDescendants(node: StepNode): StepNode[] {
  if (!hasChildren(node)) return [];
  const out: StepNode[] = [];
  for (const c of getChildren(node)) {
    out.push(c, ...collectDescendants(c));
  }
  return out;
}
