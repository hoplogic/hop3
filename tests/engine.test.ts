// @module: exec-engine ^anc-struct-exec-engine
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ExecutionEngine, splitInstanceDir, classifyFailReason } from '../src/engine.js';
import { formatPromptText, TEXT_TOOLCALL_HINT_MARKER } from '../src/prompt.js';
import { subtreeContainsPausePoint } from '../src/engine-traverse.js';
import { VariableStore } from '../src/ast-runtime.js';
import type { HostConfig } from '../src/provider-types.js';
import { ErrorCode } from '../src/errors.js';
import { writeChildParams } from '../src/persistence.js';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, win32 as pathWin32, posix as pathPosix } from 'node:path';
import { tmpdir } from 'node:os';

const MINIMAL_HOST_CONFIG: HostConfig = {
  workspace_dir: '/tmp/test',
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'test-key',
};

const THREE_STEP_SPEC = `# Test Spec
Id: test-three-step

## Goal
Test linear execution

## Inputs
- source: text  # input data

## Outputs
- result: text  # final output

## Steps
1. [reason] Analyze input
  - ← source
  + → analysis: text  # analysis result
  > Analyze the source data

2. [act] Transform data
  - ← analysis
  + → transformed: text  # transformed data
  > Apply transformation

3. [reason] Verify output
  - ← transformed
  + → result: text  # verification result
  > Check the transformed data meets requirements
`;

const INVALID_SPEC = `# Bad Spec

## Steps
1. [unknown_type] This is invalid
`;

const NO_STEPS_SPEC = `# Empty Spec
Id: empty

## Goal
A spec with no steps (capability declaration)

## Outputs
- result: text  # capability output
`;

// @v: anc-cli-init-response, anc-config-host, anc-config-sandbox
describe('ExecutionEngine.initExecution', () => {
  it('returns ok with instance_id for valid spec', () => {
    const engine = new ExecutionEngine();
    const result = engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.instance_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('returns error for unparseable spec', () => {
    const engine = new ExecutionEngine();
    const result = engine.initExecution(INVALID_SPEC, MINIMAL_HOST_CONFIG);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('succeeds for spec with no steps', () => {
    const engine = new ExecutionEngine();
    const result = engine.initExecution(NO_STEPS_SPEC, MINIMAL_HOST_CONFIG);

    expect(result.status).toBe('ok');
  });

  it('returns error for spec that parses but fails validation', () => {
    // Break/continue outside loop triggers C3 validation error
    const spec = `# Valid Title
Id: validation-fail

## Goal
Test validation

## Steps
1. [break] Invalid break outside loop
`;
    const engine = new ExecutionEngine();
    const result = engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    expect(result.status).toBe('error');
  });
});

// @v: anc-cli-next-response, anc-cli-step-ready
describe('ExecutionEngine.nextStep', () => {
  it('returns failed when engine not initialized', () => {
    const engine = new ExecutionEngine();
    const r = engine.nextStep();
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.failure_reason).toContain('not initialized');
    }
  });

  it('returns steps in declaration order', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    const r1 = engine.nextStep();
    expect(r1.status).toBe('step_ready');
    if (r1.status === 'step_ready') {
      expect(r1.step_id).toBe('1');
      expect(r1.step_type).toBe('reason');
      expect(r1.summary).toBe('Analyze input');
    }
  });

  it('returns step_ready with assembled context', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    const r = engine.nextStep();
    if (r.status === 'step_ready') {
      expect(r.context.task_context).toContain('你本步的任务在 L4）: Test linear execution');
      expect(r.context.instruction).toContain('Analyze the source data');
      expect(r.context.output_schema).toHaveLength(1);
      expect(r.context.output_schema[0].name).toBe('analysis');
    }
  });

  it('provides input variable values in context', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    const r = engine.nextStep();
    if (r.status === 'step_ready') {
      expect(r.context.inputs).toHaveProperty('source');
    }
  });

  it('advances to next step after completion', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    engine.nextStep();
    engine.completeStep('1', { analysis: 'done' });

    const r2 = engine.nextStep();
    expect(r2.status).toBe('step_ready');
    if (r2.status === 'step_ready') {
      expect(r2.step_id).toBe('2');
      expect(r2.step_type).toBe('act');
    }
  });

  it('returns completed when all steps done', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    engine.nextStep();
    engine.completeStep('1', { analysis: 'a' });
    engine.nextStep();
    engine.completeStep('2', { transformed: 't' });
    engine.nextStep();
    engine.completeStep('3', { result: 'pass' });

    const final = engine.nextStep();
    expect(final.status).toBe('completed');
    if (final.status === 'completed') {
      expect(final.outputs).toEqual({ result: 'pass' });
    }
  });

  // 未捕获失败=实例终止(2026-08-09 函数级 fail 定稿):无事务边界祖先 → 后续不再执行
  it('uncaught failure terminates instance (function-level fail)', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    engine.nextStep(); // step 1 running
    engine.failStep('1', 'LLM error'); // 顶层步骤失败,无 subtask 祖先

    // 与未捕获异常终止函数同构:step 2/3 不再执行(标 skipped),实例判 failed
    const next = engine.nextStep();
    expect(next.status).toBe('failed');
    if (next.status === 'failed') {
      expect(next.failed_step_id).toBe('1');
      expect(next.failure_reason).toBe('LLM error');
    }
  });

  it('returns failed when all steps are terminal with at least one failure', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    engine.nextStep();
    engine.failStep('1', 'LLM error');
    engine.nextStep();
    engine.completeStep('2', { transformed: 't' });
    engine.nextStep();
    engine.completeStep('3', { result: 'r' });

    const final = engine.nextStep();
    expect(final.status).toBe('failed');
    if (final.status === 'failed') {
      expect(final.failed_step_id).toBe('1');
      expect(final.failure_reason).toBe('LLM error');
    }
  });

  it('returns completed immediately for spec with no steps', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(NO_STEPS_SPEC, MINIMAL_HOST_CONFIG);

    const r = engine.nextStep();
    expect(r.status).toBe('completed');
  });

  // @v: anc-exec-pause-persist （0028 作者拍板 B:暂停即产问题卡 paused.json——跨进程可取;
  // 答案成功消化即删;拒收保留;reject 同删;纯内存实例静默跳过）
  it('问题卡生命周期：ask 暂停落卡→拒收保留→成功消化删卡', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'card-'));
    const spec = `# Card Test
Id: card-test
## Goal
G
## Inputs
- draft: text
## Outputs
- verdict: text
## Steps
1. [ask require_human present_inputs=draft] 审草稿
  - ← draft
  + → verdict: text
2. [exit] 交付
  + → verdict
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG, { stateDir, params: { draft: 'MATERIAL-full-text' } });
    const cardPath = join(stateDir, init.instance_id!, 'paused.json');

    const r = engine.nextStep();
    expect(r.status).toBe('paused');
    // 暂停即产卡,与返回载荷同源（step_id/presented_data 全文含 present_inputs 材料）
    expect(existsSync(cardPath)).toBe(true);
    const card = JSON.parse(readFileSync(cardPath, 'utf-8'));
    expect(card.step_id).toBe('1');
    expect(card.pause_reason).toBe('ask');
    expect(JSON.stringify(card.presented_data.context)).toContain('MATERIAL-full-text');

    // 反例:拒收（hop_env 凭证形键）不删卡——run 仍 paused 卡仍有效
    const rejected = engine.completeStep('1', { hop_env_gh_token: 'ghp_x' });
    expect(rejected.status).toBe('error');
    expect(existsSync(cardPath)).toBe(true);

    // 正例:成功消化即删卡
    const ok = engine.completeStep('1', { verdict: 'fine' });
    expect(ok.status).toBe('ok');
    expect(existsSync(cardPath)).toBe(false);
  });

  // @v: anc-cli-status-response （todo/0081 停驻如实转述——引擎层判定三源各有独立钉:
  // 源③卡源+陈卡对账(下一钉)/源②步型+源①escalatePending(纯内存钉,五批review R3 补——
  // 原只钉源③,面三变异 B/F 实证源①②删掉全绿:纯内存实例停驻 getStatus 谎报 running,
  // 0081 撒谎形态在无 stateDir 场景的残留半边)。CLI 层正反例见 cli.test.ts "status 停驻如实转述"组）
  it('停驻检测卡源：ask 停驻 getStatus 报 paused 摘要取卡值;陈卡对账——步已 done 的残卡不认（0081）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'paused-det-'));
    const spec = `# PDet
Id: paused-detect-0081
## Goal
G
## Inputs
- draft: text
## Outputs
- verdict: text
## Steps
1. [ask require_human] 审
  - ← draft
  + → verdict: text
2. [exit] 交付
  + → verdict
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG, { stateDir, params: { draft: 'd' } });
    const cardPath = join(stateDir, init.instance_id!, 'paused.json');
    const r = engine.nextStep();
    expect(r.status).toBe('paused');
    // 正例:停驻时 status 如实 paused,摘要从卡取(reason=ask,step=1)
    const st = engine.getStatus();
    expect(st.execution_status).toBe('paused');
    expect(st.pause_reason).toBe('ask');
    expect(st.paused_step_id).toBe('1');
    // 反例:答案消化(卡已删)后不再 paused
    const ok = engine.completeStep('1', { verdict: 'fine' });
    expect(ok.status).toBe('ok');
    expect(engine.getStatus().execution_status).not.toBe('paused');
    // 反例:陈卡对账——步 1 已 done 后手工放回一张残卡(模拟崩溃残留),不认、不报 paused
    writeFileSync(cardPath, JSON.stringify({ step_id: '1', pause_reason: 'ask' }), 'utf-8');
    const st2 = engine.getStatus();
    expect(st2.execution_status).not.toBe('paused');
    expect(st2.pause_reason).toBeUndefined();
  });

  it('停驻检测源②：纯内存实例(无 stateDir 无卡)confirm 停驻 → getStatus 如实 paused 按步型推摘要（0081 撒谎残留半边,五批review R3——变异 F 实证原零保护:删源②整段全库绿而纯内存停驻谎报 running）', () => {
    const spec = `# P2
Id: paused-src2-mem
## Goal
G
## Outputs
- r: text  # r
## Steps
1. [confirm] 批一下
  + → approved: bool  # 批
2. [act free] 干活
  - ← approved
  + → r: text  # r
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);   // 无 stateDir——纯内存,卡源(源③)静默跳过
    const n = engine.nextStep();
    expect(n.status).toBe('paused');
    const st = engine.getStatus();
    expect(st.execution_status).toBe('paused');   // 修前此断言=running(源②缺席时无源可判)
    expect(st.pause_reason).toBe('confirm');      // 无卡按判源推
    expect(st.paused_step_id).toBe('1');
  });

  it('停驻检测源①：纯内存实例 escalate 停驻 → getStatus 如实 paused（五批review R3——变异 B 实证原零保护:删 escalatePending 分支全库绿）', () => {
    const spec = `# P1e
Id: paused-src1-mem
## Goal
G
## Inputs
- x: int  # x
## Outputs
- r: text  # r
## Steps
1. [subtask retry=2]
  + → r: text  # r
  1.1. [check escalatable] 判
    - ← x
    + → ok: bool  # 判定槽
    + → gap: yaml  # 缺口槽
    > 判
  1.2. [act] 出
    + → r: text  # r
    > \`\`\`hop_python
    > r = "done"
    > \`\`\`
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { x: 1 } });   // 纯内存
    const n = engine.nextStep();
    expect(n.status).toBe('step_ready');
    const resp = engine.completeStep('1.1', { ok: false, gap: { escalate: true, need: '要口径' } });
    expect((resp as { status?: string }).status).toBe('paused');
    const st = engine.getStatus();
    expect(st.execution_status).toBe('paused');   // 修前=running(纯内存无卡,escalate 非 confirm/ask 步型,源②也探不到——唯源①能判)
    expect(st.pause_reason).toBe('escalate');
    expect(st.paused_step_id).toBe('1.1');
  });

  // @v: anc-cli-status-nested-pause （todo/0105 缺陷 A——0081 三源之后追加的源④网络暂停与源⑤嵌套串行
  // 调用下钻,正反例成对。子实例快照按 dispatcher.executeCall 同一布局造：父实例目录 calls/<serialCallChildInstance>/。
  // 修前这几处 getStatus 全报 running——2026-09-21 T5 观察方 30 多分钟看不到停点的形态本体）
  describe('status 看得见网络暂停与嵌套串行调用停点（0105）', () => {
    const NET_SPEC = `# NetTop
Id: net-top-0105
## Goal
g
## Outputs
- r: text  # r
## Steps
1. [reason] 想
  + → r: text  # r
2. [exit] 交付
  + → r
`;
    const LEAF_NET = `# Leaf
Id: leaf
## Goal
g
## Inputs
- x: int  # 入
## Outputs
- y: text  # 出
## Steps
1. [reason] 想
  - ← x
  + → y: text  # 出
2. [exit] 交付
  + → y
`;
    const LEAF_ASK = `# LeafAsk
Id: leaf-ask
## Goal
g
## Inputs
- x: int  # 入
## Outputs
- y: text  # 出
## Steps
1. [ask require_human] 请给值
  - ← x
  + → y: text  # 出
2. [exit] 交付
  + → y
`;
    const CALLER = `# Caller
Id: caller-0105
## Goal
g
## Inputs
- x: int  # 入
## Outputs
- y: text  # 出
## Steps
1. [call leaf(x)] 串行调子
  + → y: y  # 收
2. [exit] 交付
  + → y
`;
    // 在父实例当前 running 的调用步下建子实例快照（与 dispatcher.executeCall 同参:parentInstanceId + callStepId=取名法结果 + stateDir=<父目录>/calls）
    const spawnChild = (parent: ExecutionEngine, callStepId: string, source: string): ExecutionEngine => {
      const child = new ExecutionEngine();
      const init = child.initExecution(source, MINIMAL_HOST_CONFIG, {
        params: { x: 1 }, parentInstanceId: parent.getInstanceId(),
        callStepId: parent.serialCallChildInstance(callStepId),
        stateDir: join(parent.getInstanceDir()!, 'calls'),
      });
      expect(init.status).toBe('ok');
      return child;
    };
    const startParent = (spec: string, params: Record<string, unknown> = { x: 1 }): ExecutionEngine => {
      const parent = new ExecutionEngine();
      parent.initExecution(spec, MINIMAL_HOST_CONFIG, { stateDir: mkdtempSync(join(tmpdir(), 'nest-0105-')), params });
      expect(parent.nextStep().status).toBe('step_ready');   // 调用步进 running（复用模式交 caller 执行 call）
      return parent;
    };

    it('源④正例：顶层网络暂停 → paused/network/该步,无 call_path;反例：该步重新开始后、完成后都不再报 paused', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(NET_SPEC, MINIMAL_HOST_CONFIG);   // 纯内存也判得出——源④只读步骤账与事件流
      expect(engine.nextStep().status).toBe('step_ready');
      engine.resetStepForNetworkPause('1');
      const st = engine.getStatus();
      expect(st.execution_status).toBe('paused');   // 修前=running（网络暂停不落卡,0081 三源都探不到）
      expect(st.pause_reason).toBe('network');
      expect(st.paused_step_id).toBe('1');
      expect(st.call_path).toBeUndefined();
      // 反例:恢复后重新开始（记 step_start,最后一条事件不再是 network_pause）
      expect(engine.nextStep().status).toBe('step_ready');
      expect(engine.getStatus().execution_status).not.toBe('paused');
      // 反例:再暂停一次后直接完成,也不粘滞
      engine.resetStepForNetworkPause('1');
      expect(engine.getStatus().execution_status).toBe('paused');
      engine.nextStep();
      engine.completeStep('1', { r: 'ok' });
      const st2 = engine.getStatus();
      expect(st2.execution_status).not.toBe('paused');
      expect(st2.pause_reason).toBeUndefined();
    });

    it('源⑤正例：串行调用子流程网络暂停 → 父 status 报 paused/network/子步号 + call_path;跨进程 load 父目录同口径;反例：子步重新开始后回 running', () => {
      const parent = startParent(CALLER);
      const child = spawnChild(parent, '1', LEAF_NET);
      expect(child.nextStep().status).toBe('step_ready');
      child.resetStepForNetworkPause('1');
      const st = parent.getStatus();
      expect(st.execution_status).toBe('paused');   // 修前=running（父快照里调用步只是 running,不下钻）
      expect(st.pause_reason).toBe('network');
      expect(st.paused_step_id).toBe('1');          // 最深层实例里的步号
      expect(st.call_path).toEqual(['1']);
      const loaded = ExecutionEngine.load(parent.getInstanceDir()!).getStatus();   // 命令行 status 走的就是这条
      expect(loaded.execution_status).toBe('paused');
      expect(loaded.pause_reason).toBe('network');
      expect(loaded.call_path).toEqual(['1']);
      // 反例:子步重新开始 → 父不再报 paused
      expect(child.nextStep().status).toBe('step_ready');
      const st2 = parent.getStatus();
      expect(st2.execution_status).toBe('running');
      expect(st2.call_path).toBeUndefined();
    });

    it('源⑤正例：串行调用子流程 ask 停点 → 父报 paused/ask + call_path;反例：答完后不再报 paused', () => {
      const parent = startParent(CALLER);
      const child = spawnChild(parent, '1', LEAF_ASK);
      expect(child.nextStep().status).toBe('paused');   // 子实例落卡
      const st = parent.getStatus();
      expect(st.execution_status).toBe('paused');   // 修前=running（卡在子目录,父不下钻）
      expect(st.pause_reason).toBe('ask');
      expect(st.paused_step_id).toBe('1');
      expect(st.call_path).toEqual(['1']);
      expect(child.completeStep('1', { y: 'v' }).status).toBe('ok');
      const st2 = parent.getStatus();
      expect(st2.execution_status).not.toBe('paused');
      expect(st2.pause_reason).toBeUndefined();
    });

    it('源⑤正例：两层嵌套 → call_path 由外到内逐层头插（父调用步在前,中间层调用步在后）', () => {
      const MID = `# Mid
Id: mid
## Goal
g
## Inputs
- x: int  # 入
## Outputs
- y: text  # 出
## Steps
1. [subtask] 容器
  + → y: text  # 出
  1.1. [call leaf(x)] 再调一层
    + → y: y  # 收
2. [exit] 交付
  + → y
`;
      const parent = startParent(CALLER);
      const mid = spawnChild(parent, '1', MID);
      expect(mid.nextStep().status).toBe('step_ready');   // mid 的 1.1 调用步 running
      const leaf = spawnChild(mid, '1.1', LEAF_NET);
      expect(leaf.nextStep().status).toBe('step_ready');
      leaf.resetStepForNetworkPause('1');
      const st = parent.getStatus();
      expect(st.execution_status).toBe('paused');
      expect(st.call_path).toEqual(['1', '1.1']);   // 顺序颠倒即错——与 MCP 暂停载荷 call_path 同语义
      expect(st.paused_step_id).toBe('1');
    });

    it('源⑤正例：循环里的串行调用（子实例名带轮次后缀 calls/1.1.1/）也能下钻命中', () => {
      const LOOPER = `# Looper
Id: looper-0105
## Goal
g
## Inputs
- xs: [int]  # 入
## Outputs
- ys: [text]  # 出
## Steps
1. [loop for-each x in xs, collect y into ys] 逐项
  + → ys: [text]  # 出
  1.1. [call leaf(x)] 串行调子
    + → y: y  # 收
2. [exit] 交付
  + → ys
`;
      const parent = startParent(LOOPER, { xs: [1, 2] });
      expect(parent.serialCallChildInstance('1.1')).toBe('1.1.1');   // 前提:目录名带轮次,不是裸步号
      const child = spawnChild(parent, '1.1', LEAF_NET);
      expect(child.nextStep().status).toBe('step_ready');
      child.resetStepForNetworkPause('1');
      const st = parent.getStatus();
      expect(st.execution_status).toBe('paused');   // 用裸步号找 calls/1.1/ 找不到——报 running
      expect(st.pause_reason).toBe('network');
      expect(st.call_path).toEqual(['1.1']);
    });

    it('反例：终态凌驾——子目录残留网络暂停痕迹,父实例已 failed → 报 failed 不报 paused', () => {
      const parent = startParent(CALLER);
      const child = spawnChild(parent, '1', LEAF_NET);
      child.nextStep();
      child.resetStepForNetworkPause('1');
      expect(parent.getStatus().execution_status).toBe('paused');
      parent.failStep('1', '模拟调用失败');
      expect(parent.nextStep().status).toBe('failed');
      const st = parent.getStatus();
      expect(st.execution_status).toBe('failed');
      expect(st.pause_reason).toBeUndefined();
      expect(st.call_path).toBeUndefined();
    });

    it('反例：子实例已落终态标记（completed）→ 不下钻,父报 running', () => {
      const parent = startParent(CALLER);
      const child = spawnChild(parent, '1', LEAF_NET);
      child.nextStep();
      child.completeStep('1', { y: 'v' });
      child.nextStep();   // exit → completed 终态标记落盘
      expect(child.getStatus().execution_status).toBe('completed');
      expect(parent.getStatus().execution_status).toBe('running');   // 调用步待 caller 回写——running 合法持久态
    });

    it('反例：子实例网络暂停后被 abort（终态标记在场,暂停痕迹残留）→ 不下钻,父报 running', () => {
      const parent = startParent(CALLER);
      const child = spawnChild(parent, '1', LEAF_NET);
      child.nextStep();
      child.resetStepForNetworkPause('1');
      expect(parent.getStatus().execution_status).toBe('paused');
      child.abort('放弃子流程');   // abort 事件不挂步号——该步末事件仍是 network_pause,只靠终态标记挡住
      const st = parent.getStatus();
      expect(st.execution_status).toBe('running');
      expect(st.call_path).toBeUndefined();
    });
  });

  // @v: anc-exec-state-persistence （0043 终局有据:completed/failed 随快照落盘——原四出口零
  // persist,dfs 状态转移只活在内存,跨进程读快照恒"差最后一步",盯环判 running 永不转完）
  it('终态落盘：completed 后快照 terminal_state 在场且零 pending;failed 同权', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'term-'));
    const spec = `# T
Id: term-ok
## Goal
g
## Inputs
- s: line
## Outputs
- r: text
## Steps
1. [act] 算
  - ← s
  + → r: text
  > \`\`\`hop_python
  > r = s
  > \`\`\`
2. [exit] 交付
  + → r
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG, { stateDir, params: { s: 'v' } });
    let r = engine.nextStep();
    if (r.status === 'step_ready') {   // 纯引擎上下文 act body 呈介入点——补全推进
      engine.completeStep(r.step_id, { r: 'v' });
      r = engine.nextStep();
    }
    expect(r.status).toBe('completed');
    const st = JSON.parse(readFileSync(join(stateDir, init.instance_id!, 'state.json'), 'utf-8'));
    expect(st.terminal_state).toBe('completed');
    expect(Object.values(st.step_states as Record<string, string>).filter(v => v === 'pending')).toHaveLength(0);

    // failed 侧:完备性违约（声明输出无人产出——运行期 exit 撞完备闸）
    const specBad = `# T
Id: term-bad
## Goal
g
## Outputs
- never_set: text
## Steps
1. [exit] 交付
  + → never_set
`;
    const e2 = new ExecutionEngine();
    const init2 = e2.initExecution(specBad, MINIMAL_HOST_CONFIG, { stateDir });
    const r2 = e2.nextStep();
    expect(r2.status).toBe('failed');
    const st2 = JSON.parse(readFileSync(join(stateDir, init2.instance_id!, 'state.json'), 'utf-8'));
    expect(st2.terminal_state).toBe('failed');
  });

  // @v: anc-step-check-body （0041 死锁修:设计明定"含工具 body 同权 tool_request 挂起恢复"
  // 且 ToolRequest.step_type 早含 'check',submitToolResult 守卫漏扩——呈得出答不了;
  // hopbuild2 4.3 每 run 必撞 campaign 级阻塞）
  it('check 步 tool_request 可应答（0041——守卫扩 check;reason 仍拒）', () => {
    const spec = `# T
Id: ck-tool
## Goal
g
## Inputs
- x: line
## Outputs
- ok: bool
## Steps
1. [subtask] p
  + → ok: bool
  1.1. [check] c
    + → ok: bool
    + → note: text
    > \`\`\`hop_python
    > write(path: work_zone_path("t.txt"), content: "hi")
    > ok = true
    > note = ""
    > \`\`\`
`;
    const stateDir = mkdtempSync(join(tmpdir(), 'ck-tool-'));
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 'v' } });
    // 正例:check 步收 tool-result → ok（此前 INVALID_STATE 拒=死锁）
    const r = engine.submitToolResult('1.1', { result: null, success: true });
    expect(r.status).toBe('ok');
    // 反例:reason 步仍拒（守卫只扩 check,不放开非 body 步骤类型）
    const r2 = engine.submitToolResult('nonexistent-step', { result: null, success: true });
    expect(r2.status).toBe('error');
  });

  it('问题卡：recover 重置 running 后旧卡清除（陈卡源头治理）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'card-rec-'));
    const spec = `# Card Recover
Id: card-rec
## Goal
G
## Steps
1. [ask] 要个值
  + → v: text  # 值
2. [exit] 交付
  + → none
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG, { stateDir });
    const instDir = join(stateDir, init.instance_id!);
    expect(engine.nextStep().status).toBe('paused');
    expect(existsSync(join(instDir, 'paused.json'))).toBe(true);

    // recover 把 ask 的 running 回置 pending——旧卡是陈卡,源头清除;
    // 下一次 nextStep 重算重落新卡
    const recovered = ExecutionEngine.recover(instDir);
    expect(existsSync(join(instDir, 'paused.json'))).toBe(false);
    expect(recovered.nextStep().status).toBe('paused');
    expect(existsSync(join(instDir, 'paused.json'))).toBe(true);
  });

  it('问题卡：confirm reject 同样删卡（等人窗口关闭）;纯内存实例零卡零炸', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'card-rej-'));
    const spec = `# Card Reject
Id: card-rej
## Goal
G
## Steps
1. [confirm] 批不批
  + → approval: bool  # 审批
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG, { stateDir });
    const cardPath = join(stateDir, init.instance_id!, 'paused.json');
    expect(engine.nextStep().status).toBe('paused');
    expect(existsSync(cardPath)).toBe(true);
    engine.completeStep('1', { approval: 'reject' });
    expect(existsSync(cardPath)).toBe(false);

    // 纯内存实例（无 stateDir）:落卡静默跳过不炸
    const mem = new ExecutionEngine();
    mem.initExecution(spec, MINIMAL_HOST_CONFIG);
    expect(mem.nextStep().status).toBe('paused');
  });

  // @v: anc-cli-execution-paused
  // confirm 是 CITL 暂停点：两种模式统一返回 paused（不降级 step_ready）。
  it('returns paused at confirm step (not step_ready)', () => {
    const spec = `# Confirm Paused Test
Id: confirm-paused
## Goal
Test confirm returns paused
## Steps
1. [confirm require_human=true] Approve action
  + → approval: bool  # user response
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    const r = engine.nextStep();
    expect(r.status).toBe('paused');
    if (r.status !== 'paused') return;
    expect(r.step_id).toBe('1');
    expect(r.pause_reason).toBe('waiting_human'); // require_human → waiting_human
    expect(r.response_options.length).toBeGreaterThan(0);
  });
});

// @v: anc-cli-command-response, anc-error-error-code
describe('ExecutionEngine.completeStep', () => {
  it('marks step as done and stores outputs', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });
    engine.nextStep();

    const result = engine.completeStep('1', { analysis: 'some analysis' });
    expect(result.status).toBe('ok');
    expect(result.code).toBeUndefined();

    const vars = engine.getVars();
    expect(vars.variables['analysis']).toBe('some analysis');
  });

  // @v: anc-cli-idempotency, anc-exec-stale-resubmit
  it('正例：同值重发 → ALREADY_DONE ok（真幂等照旧——0049 分流后幂等语义只认同内容）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });
    engine.nextStep();
    engine.completeStep('1', { analysis: 'x' });

    const repeat = engine.completeStep('1', { analysis: 'x' });
    expect(repeat.status).toBe('ok');
    expect(repeat.code).toBe(ErrorCode.ALREADY_DONE);
    const bare = engine.completeStep('1');   // 无 outputs 重发同为幂等
    expect(bare.status).toBe('ok');
  });

  it('反例：向已 done 步递交不同内容 → STALE_RESUBMIT 拒且值不动（0049——原形态 ok 放行:内容静默丢+指针照推;本测试原名 idempotent repeat 传的恰是异值,锁的是病态行为,随契约拆写）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });
    engine.nextStep();
    engine.completeStep('1', { analysis: 'x' });

    const stale = engine.completeStep('1', { analysis: 'y' });
    expect(stale.status).toBe('error');
    expect(stale.message).toContain('STALE_RESUBMIT');
    expect(engine.getVars()['variables']?.['analysis']).toBe('x');   // 断具体值——原 ?? 回退形态恒真零判别力(review F2)
  });

  it('returns INVALID_STATE for non-running step', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    const result = engine.completeStep('2', { transformed: 'x' });
    expect(result.status).toBe('error');
    expect(result.code).toBe(ErrorCode.INVALID_STATE);
  });
});

describe('ExecutionEngine.failStep', () => {
  it('marks step as failed, value space untouched (fail 不碰值空间)', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });
    engine.nextStep();

    const result = engine.failStep('1', 'timeout');
    expect(result.status).toBe('ok');

    // 2026-08-09 函数级 fail:不置 None——analysis 保持从未产出
    const vars = engine.getVars();
    expect('analysis' in vars.variables).toBe(false);
  });

  // @v: anc-cli-idempotency
  it('returns ALREADY_FAILED for idempotent repeat', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });
    engine.nextStep();
    engine.failStep('1', 'error');

    const repeat = engine.failStep('1', 'error again');
    expect(repeat.status).toBe('ok');
    expect(repeat.code).toBe(ErrorCode.ALREADY_FAILED);
  });

  it('returns INVALID_STATE for non-running step', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    const result = engine.failStep('3', 'oops');
    expect(result.status).toBe('error');
    expect(result.code).toBe(ErrorCode.INVALID_STATE);
  });
});

// @v: anc-cli-status-response
describe('ExecutionEngine.getStatus', () => {
  it('reports all pending after init', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    const status = engine.getStatus();
    expect(status.status).toBe('ok');
    expect(status.total_steps).toBe(3);
    expect(status.pending).toBe(3);
    expect(status.completed).toBe(0);
    expect(status.failed).toBe(0);
    expect(status.execution_status).toBe('running');
  });

  it('reflects progress after completions', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });
    engine.nextStep();
    engine.completeStep('1', { analysis: 'x' });
    engine.nextStep();

    const status = engine.getStatus();
    expect(status.completed).toBe(1);
    expect(status.pending).toBe(1);
    expect(status.current_step).toBe('2');
  });

  it('reports completed when all done', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });
    engine.nextStep();
    engine.completeStep('1', { analysis: 'a' });
    engine.nextStep();
    engine.completeStep('2', { transformed: 't' });
    engine.nextStep();
    engine.completeStep('3', { result: 'r' });

    const status = engine.getStatus();
    expect(status.execution_status).toBe('completed');
  });

  it('uncaught failure → status failed immediately, rest skipped (函数级 fail)', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });
    engine.nextStep();
    engine.failStep('1', 'err');   // 顶层失败无边界 → 实例终止,step 2/3 标 skipped

    const status = engine.getStatus();
    expect(status.execution_status).toBe('failed');
    expect(status.failed).toBe(1);
    expect(status.pending).toBe(0);
  });
});

// @v: anc-cli-vars-response
describe('ExecutionEngine.getVars', () => {
  it('contains input variables after init', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    const vars = engine.getVars();
    expect(vars.status).toBe('ok');
    expect(vars.variables).toHaveProperty('source');
    expect(vars.variables).toHaveProperty('instance_id');
  });

  it('reflects step outputs after completion', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });
    engine.nextStep();
    engine.completeStep('1', { analysis: 'hello' });

    const vars = engine.getVars();
    expect(vars.variables['analysis']).toBe('hello');
  });

  it('reports pending outputs correctly', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });

    const vars = engine.getVars();
    expect(vars.pending_outputs).toContain('result');
  });

  it('clears pending after output is written', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });
    engine.nextStep();
    engine.completeStep('1', { analysis: 'a' });
    engine.nextStep();
    engine.completeStep('2', { transformed: 't' });
    engine.nextStep();
    engine.completeStep('3', { result: 'final' });

    const vars = engine.getVars();
    expect(vars.pending_outputs).toEqual([]);
  });
});

// @v: anc-struct-exec-engine, anc-exec-dfs-traversal
describe('ExecutionEngine full linear sequence', () => {
  it('executes 3-step spec to completion', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { source: 's' } });
    expect(init.status).toBe('ok');

    const s1 = engine.nextStep();
    expect(s1.status).toBe('step_ready');
    if (s1.status === 'step_ready') expect(s1.step_id).toBe('1');
    engine.completeStep('1', { analysis: 'analyzed' });

    const s2 = engine.nextStep();
    expect(s2.status).toBe('step_ready');
    if (s2.status === 'step_ready') {
      expect(s2.step_id).toBe('2');
      expect(s2.context.inputs['analysis']).toBe('analyzed');
    }
    engine.completeStep('2', { transformed: 'transformed' });

    const s3 = engine.nextStep();
    expect(s3.status).toBe('step_ready');
    if (s3.status === 'step_ready') {
      expect(s3.step_id).toBe('3');
      expect(s3.context.inputs['transformed']).toBe('transformed');
    }
    engine.completeStep('3', { result: 'verified' });

    const end = engine.nextStep();
    expect(end.status).toBe('completed');
    if (end.status === 'completed') {
      expect(end.outputs).toEqual({ result: 'verified' });
    }
  });
});

// ============================================================
// 3B: Container traversal tests
// ============================================================

const SUBTASK_SPEC = `# Subtask Test
Id: subtask-test

## Goal
Test subtask container

## Outputs
- verified: bool  # final

## Steps
1. [reason] Top-level step
  + → top_out: text  # top output

2. [subtask] Process data
  + → sub_result: text  # subtask aggregated output
  2.1. [act] Step A
    + → a_out: text  # a output
  2.2. [act] Step B
    - ← a_out
    + → b_out: text  # b output

3. [reason] Final verify
  - ← sub_result
  + → verified: bool  # verification
`;

// @v: anc-step-subtask, anc-exec-completion-cascade, anc-exec-container-output
describe('Subtask container', () => {
  it('enters subtask children in order', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SUBTASK_SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');

    const s1 = engine.nextStep();
    expect(s1.status).toBe('step_ready');
    if (s1.status === 'step_ready') expect(s1.step_id).toBe('1');
    engine.completeStep('1', { top_out: 'x' });

    const s2 = engine.nextStep();
    expect(s2.status).toBe('step_ready');
    if (s2.status === 'step_ready') expect(s2.step_id).toBe('2.1');
    engine.completeStep('2.1', { a_out: 'a_val' });

    const s3 = engine.nextStep();
    expect(s3.status).toBe('step_ready');
    if (s3.status === 'step_ready') expect(s3.step_id).toBe('2.2');
  });

  it('auto-completes subtask when children all done', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SUBTASK_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1', { top_out: 'x' });
    engine.nextStep();
    engine.completeStep('2.1', { a_out: 'a_val' });
    engine.nextStep();
    engine.completeStep('2.2', { b_out: 'done' });

    const s4 = engine.nextStep();
    expect(s4.status).toBe('step_ready');
    if (s4.status === 'step_ready') expect(s4.step_id).toBe('3');
  });

  it('subtask child can read sibling outputs via scope', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SUBTASK_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1', { top_out: 'x' });
    engine.nextStep();
    engine.completeStep('2.1', { a_out: 'from_a' });

    const s = engine.nextStep();
    if (s.status === 'step_ready') {
      expect(s.context.inputs['a_out']).toBe('from_a');
    }
  });
});

const PARALLEL_SPEC = `# Parallel Test
Id: parallel-test

## Goal
Test parallel container (v1 sequential)

## Outputs
- combined: text  # combined output

## Steps
1. [subtask] Boundary
  + → par_done: bool  # parallel aggregated
  1.1. [subtask parallel] Do things in parallel
    + → par_done: bool  # parallel aggregated
    1.1.1. [act] Task A
      + → a_result: text  # a
    1.1.2. [act] Task B
      + → b_result: text  # b

2. [act] Combine
  - ← par_done
  + → combined: text  # combined
`;

// @v: anc-step-parallel
describe('Parallel container (v1 sequential)', () => {
  it('executes children sequentially', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(PARALLEL_SPEC, MINIMAL_HOST_CONFIG);

    const s1 = engine.nextStep();
    expect(s1.status).toBe('step_ready');
    if (s1.status === 'step_ready') expect(s1.step_id).toBe('1.1.1');
    engine.completeStep('1.1.1', { a_result: 'a' });

    const s2 = engine.nextStep();
    expect(s2.status).toBe('step_ready');
    if (s2.status === 'step_ready') expect(s2.step_id).toBe('1.1.2');
    engine.completeStep('1.1.2', { b_result: 'b' });

    const s3 = engine.nextStep();
    expect(s3.status).toBe('step_ready');
    if (s3.status === 'step_ready') expect(s3.step_id).toBe('2');
  });
});

const LOOP_SPEC = `# Loop Test
Id: loop-test

## Goal
Test loop container

## Outputs
- final_out: text  # final output

## Steps
1. [loop max_iterations=3] Repeat processing
  + → loop_done: bool  # loop aggregated
  1.1. [act] Process item
    + → item_result: text  # per-iteration result

2. [act] Finalize
  - ← loop_done
  + → final_out: text  # final
`;

// @v: anc-step-loop
describe('Loop container', () => {
  it('iterates up to max_iterations', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(LOOP_SPEC, MINIMAL_HOST_CONFIG);

    for (let i = 0; i < 3; i++) {
      const s = engine.nextStep();
      expect(s.status).toBe('step_ready');
      if (s.status === 'step_ready') expect(s.step_id).toBe('1.1');
      engine.completeStep('1.1', { item_result: `iter_${i + 1}` });
    }

    const after = engine.nextStep();
    expect(after.status).toBe('step_ready');
    if (after.status === 'step_ready') expect(after.step_id).toBe('2');
  });

  // @v: anc-exec-loop-var-scope
  // Python 语义：变量跨迭代自然保留，引擎不清当轮变量；累加器（loop 节点 +→）跨迭代累积。
  // @v: anc-exec-loop-var-scope
  it('retains vars across iterations (Python semantics, no auto-clear)', () => {
    const spec = `# Loop Var Scope
Id: loop-var-scope

## Goal
Test natural retention across iterations

## Outputs
- summary: text  # final

## Steps
1. [loop max_iterations=3] Accumulate
  + → acc: yaml  # 累加器
  1.1. [act] Produce per-iteration item
    + → item: text  # 每轮由本步产出
  1.2. [act] Update accumulator
    - ← acc, item
    + → acc
2. [act] Finalize
  - ← acc
  + → summary: text  # final
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    const vars = engine.getVariableStore();
    const loopScope = '1';

    // 第 1 轮
    let s = engine.nextStep();
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1');
    engine.completeStep('1.1', { item: 'item_1' });
    expect(vars.read('item', loopScope)).toBe('item_1');
    engine.nextStep();
    engine.completeStep('1.2', { acc: ['item_1'] });

    // 进入第 2 轮——Python 语义：item 自然保留上轮值（引擎不清），acc 累加器保留
    s = engine.nextStep();
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1');
    expect(vars.read('item', loopScope)).toBe('item_1');    // ← 自然保留（旧二分下会是 undefined）
    expect(vars.read('acc', loopScope)).toEqual(['item_1']); // ← 累加器保留
  });

  // 容器节点 `+ → acc: yaml = []` 的 init-once：进入 loop 时初始化一次，跨迭代累积不被重置。
  // @v: anc-exec-output-init
  it('container +→ = 初值 inits once, accumulates across iterations', () => {
    const spec = `# Init Once
Id: init-once

## Goal
Test container accumulator init-once

## Outputs
- summary: text  # final

## Steps
1. [loop max_iterations=3] Accumulate
  + → acc: yaml = []  # 累加器：容器进入 init 一次为空列表
  1.1. [act] Append
    - ← acc
    + → acc
2. [act] Finalize
  - ← acc
  + → summary: text  # final
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    const vars = engine.getVariableStore();
    const loopScope = '1';

    // 进入 loop 后 acc 已 init 为 []
    let s = engine.nextStep();
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1');
    expect(vars.read('acc', loopScope)).toEqual([]);
    engine.completeStep('1.1', { acc: ['a'] });

    // 第 2 轮：acc 不被重置为 []（init 仅一次），保留累积值
    s = engine.nextStep();
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1');
    expect(vars.read('acc', loopScope)).toEqual(['a']);      // ← 未被 init 重置
  });

  // 叶子步骤 `+ → x: type = Null` 每轮执行时重置：与不写 default 的自然保留对比。
  // @v: anc-exec-output-init
  it('leaf +→ = Null resets every iteration', () => {
    const spec = `# Leaf Reset
Id: leaf-reset

## Goal
Test leaf per-execution reset

## Outputs
- summary: text  # final

## Steps
1. [loop max_iterations=3] Loop
  + → acc: yaml = []  # 累加器
  1.1. [act] Reset-then-maybe-produce
    - ← acc
    + → flag: bool = Null  # 每轮重置为 null
    + → acc
2. [act] Finalize
  - ← acc
  + → summary: text  # final
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    const vars = engine.getVariableStore();
    const loopScope = '1';

    // 第 1 轮：1.1 becomes-running 时 flag 已被重置为 null
    let s = engine.nextStep();
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1');
    expect(vars.read('flag', loopScope)).toBeNull();        // ← = Null 每轮重置生效
    engine.completeStep('1.1', { flag: true, acc: ['a'] });
    expect(vars.read('flag', loopScope)).toBe(true);

    // 第 2 轮：1.1 becomes-running 时 flag 又被重置为 null（不保留上轮 true）
    s = engine.nextStep();
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1');
    expect(vars.read('flag', loopScope)).toBeNull();        // ← 显式重置覆盖上轮值
  });

  // subtask retry：Python 语义下 child 输出跨重试保留（不再清空）。
  // @v: anc-exec-loop-var-scope
  // @v: anc-exec-check-verdict — check 返回 bool false → failStep → 触发 retry
  it('subtask retry keeps child outputs (no clear)', () => {
    const spec = `# Retry Keep
Id: retry-keep

## Goal
Test subtask retry retains child outputs

## Outputs
- out: text  # final

## Steps
1. [subtask retry=2] Work
  + → out: text  # aggregate
  1.1. [act] Produce
    + → mid: text
  1.2. [check final] Verify
    - ← mid
    + → ok: bool  # 判定
    + → note: text  # 说明
2. [act] Finalize
  - ← out
  + → out2: text  # unused placeholder
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    const vars = engine.getVariableStore();
    const subScope = '1';

    engine.nextStep();
    engine.completeStep('1.1', { mid: 'produced' });
    expect(vars.read('mid', subScope)).toBe('produced');
    engine.nextStep();
    engine.completeStep('1.2', { ok: false, note: 'fail' });  // check 失败 → 触发 retry

    // retry 重跑：mid 不被清空（Python 语义，旧逻辑会 write null）
    const s = engine.nextStep();
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1');
    expect(vars.read('mid', subScope)).toBe('produced');     // ← 保留（旧逻辑=null）
  });

  // @v: anc-exec-loop-var-scope — 聚合账例外（hopissues/0072:G244 实撞 collect 切片 1→2→4
  // 逐轮翻倍——容器重跑 loop 整轮重收,__reaped_ 缓冲旧账不清则与新账归并,check 拒重复账
  // 而重复正是重试注入的,自激死锁烧尽 retry。用户变量保留语义不动,清的只是引擎聚合账。
  it('subtask retry 清聚合账:collect 私有缓冲与 __reaped_ 缓冲双清,重跑不重复累加', () => {
    const spec = `# Retry Collect Ledger
Id: retry-collect-ledger

## Goal
容器重跑时 loop 聚合账清零,收集列表不逐轮翻倍

## Inputs
- items: [line]  # 待加工项

## Outputs
- rs: yaml  # 收集结果

## Steps
1. [subtask retry=2] 事务边界
  - ← items
  + → rs: [yaml]
  1.1. [loop for-each it in items, collect r into rs] 逐项
    - ← items
    + → rs: [yaml]
    1.1.1. [act] 加工一项
      - ← it
      + → r: yaml
  1.2. [check final] 验收
    - ← rs
    + → ok: bool  # 判定
    + → note: text  # 说明
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { items: ['甲', '乙'] } } as never);
    const vars = engine.getVariableStore();

    // 第一轮:loop 两项走完
    engine.nextStep();
    engine.completeStep('1.1.1', { r: { item: '甲' } });
    engine.nextStep();
    engine.completeStep('1.1.1', { r: { item: '乙' } });
    engine.nextStep();
    // 模拟并行收割残账:G244 形态里 __reaped_ 缓冲由 call parallel 收割写入,容器重跑不清
    // 它就会在 finalize 时与新账归并。此处直接注入一笔残账复现该形态。
    vars.write('__reaped_rs', [[1, { item: '陈年旧账' }]], '1.1');
    expect(vars.read('rs', '1')).toHaveLength(2);   // 第一轮收齐 2 项
    engine.completeStep('1.2', { ok: false, note: '打回重做' });   // 触发容器 retry

    // 进入即清（2026-09-07 收敛:清空点在 loop 入口不在重置路径——重新进入时两本账一并置空;
    // 原断言"打回后立即空"是来路清模型的时点,随收敛挪到进入后）
    engine.nextStep();   // 重跑轮:loop 重新进入,入口清生效
    expect(vars.readLocal('rs', '1.1')).toEqual([]);
    expect(vars.readLocal('__reaped_rs', '1.1')).toBeNull();
    engine.completeStep('1.1.1', { r: { item: '甲2' } });
    engine.nextStep();
    engine.completeStep('1.1.1', { r: { item: '乙2' } });
    engine.nextStep();
    const rs = vars.read('rs', '1') as unknown[];
    expect(rs).toHaveLength(2);
    engine.completeStep('1.2', { ok: true, note: '' });
    expect(engine.getStatus().execution_status).toBe('completed');
  });

  // @v: anc-exec-output-init-reentry — retry/replan 重跑=重新进入,带 = 初值 容器重灌
  // （2026-09-07 作者拍"=初值 就是进入循环时执行"定性修 bug——原特判"重试是同一次进入的
  // 重做不是新进入"删除;探针实证:retry 内 loop 头 findings=[] 不重灌,第一轮 2 条重跑攒 4 条翻倍）
  it('subtask retry 重跑:loop 头 = [] 累加器回初值,不带上一轮累积（翻倍病根治）', () => {
    const spec = `# Init Reentry Retry
Id: init-reentry-retry

## Goal
retry 重跑=重新进入,初值按字面重新执行

## Outputs
- findings: yaml  # 累积

## Steps
1. [subtask retry=2] 边界
  + → findings: [yaml]
  1.1. [loop max=2] 攒
    + → findings: [yaml] = []
    1.1.1. [act free] 攒一条
      - ← findings
      + → findings: [yaml]
  1.2. [check final] 验
    - ← findings
    + → ok: bool  # 判定
    + → note: text  # 说明
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    const vars = engine.getVariableStore();
    let n = 0;
    engine.nextStep();
    engine.completeStep('1.1.1', { findings: [{ n: n++ }] });
    engine.nextStep();
    engine.completeStep('1.1.1', { findings: [{ n: 0 }, { n: n++ }] });
    engine.nextStep();
    expect((vars.read('findings', 'root') as unknown[])).toHaveLength(2);   // 第一轮攒 2 条
    engine.completeStep('1.2', { ok: false, note: '打回' });   // retry 触发
    // 重跑轮进入 loop:= [] 重新执行,findings 回空列表(修前:带旧 2 条继续攒成 4 条)
    const s = engine.nextStep();
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1.1');
    expect(vars.read('findings', 'root')).toEqual([]);
    engine.completeStep('1.1.1', { findings: [{ r: 1 }] });
    engine.nextStep();
    engine.completeStep('1.1.1', { findings: [{ r: 1 }, { r: 2 }] });
    engine.nextStep();
    engine.completeStep('1.2', { ok: true, note: '' });
    expect(engine.getStatus().execution_status).toBe('completed');
    expect((vars.read('findings', 'root') as unknown[])).toHaveLength(2);   // 恰 2 条,零翻倍
  });

  it('反例:不带 = 初值 的普通变量 retry 重跑照旧保留（自然保留大原则不动,重灌只认显式初值声明）', () => {
    const spec = `# No Default No Refill
Id: no-default-no-refill

## Goal
不写初值=自然保留,重灌不扩大化

## Outputs
- out: text  # 终值

## Steps
1. [subtask retry=2] 边界
  + → out: text
  1.1. [subtask] 内层容器(无初值声明)
    + → memo: text
    1.1.1. [act free] 写备忘
      + → memo: text
      + → out: text
  1.2. [check final] 验
    - ← memo
    + → ok: bool  # 判定
    + → note: text  # 说明
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    const vars = engine.getVariableStore();
    engine.nextStep();
    const r1 = engine.completeStep('1.1.1', { memo: '第一轮的备忘', out: '首轮产出' });
    expect(r1.status).toBe('ok');
    expect(vars.read('memo', 'root')).toBe('第一轮的备忘');   // 写入确认
    engine.nextStep();
    const r2 = engine.completeStep('1.2', { ok: false, note: '打回' });
    expect(r2.status).toBe('ok');
    engine.nextStep();   // 重跑轮
    expect(vars.read('memo', 'root')).toBe('第一轮的备忘');   // 自然保留,重跑轮可读
  });

  it('反例:on_fail 子树内带 = 初值 的容器,retry 重跑不删其 scope（兜底账归兜底处置链,重灌豁免与聚合账清零同规）', () => {
    const spec = `# Refill Onfail Skip
Id: refill-onfail-skip

## Goal
兜底子树豁免重灌

## Outputs
- out: text  # 终值

## Steps
1. [subtask retry=2] 边界
  + → out: text
  1.1. [act free] 干活
    + → out: text
  1.2. [check final] 验
    - ← out
    + → ok: bool  # 判定
    + → note: text  # 说明
  1.9. [on_fail] 兜底
    1.9.1. [loop max=2] 兜底攒
      + → fb_acc: [yaml] = []
      1.9.1.1. [act free] 攒
        - ← fb_acc
        + → fb_acc: [yaml]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    const vars = engine.getVariableStore();
    engine.nextStep();
    engine.completeStep('1.1', { out: '一稿' });
    engine.nextStep();
    // 手工造兜底 loop 的 scope 与累积值(模拟兜底曾激活攒过账)
    (vars as any).createScope('1.9.1', 'root');
    vars.write('fb_acc', [{ n: 1 }], '1.9.1');
    engine.completeStep('1.2', { ok: false, note: '打回' });   // retry 触发
    // on_fail 豁免:兜底容器 scope 未被删,累积原样(删了=兜底账被主链重试冲掉)
    expect((vars as any).hasScope('1.9.1')).toBe(true);
    expect(vars.readLocal('fb_acc', '1.9.1')).toEqual([{ n: 1 }]);
  });

  it('replan 换结构重跑:新结构 loop 重新进入时收集账清零（进入即清接管 replan 路把关;删 scope 半边归"同号复用"钉——原标题双声称而 spec 无 = 初值,两批 review 面三抓标题欺骗后收窄）', () => {
    const spec = `# Replan Clear Ledger
Id: replan-clear-ledger

## Goal
replan 也是新进入,旧账不带进新结构

## Inputs
- items: [line]  # 待加工项

## Outputs
- rs: yaml  # 收集

## Steps
1. [subtask retry=2 adaptive] 边界
  - ← items
  + → rs: [yaml]
  1.1. [loop for-each it in items, collect r into rs] 逐项
    - ← items
    + → rs: [yaml]
    1.1.1. [act free] 加工
      - ← it
      + → r: yaml
  1.2. [check final] 验
    - ← rs
    + → ok: bool  # 判定
    + → note: text  # 说明
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { items: ['甲'] } } as never);
    const vars = engine.getVariableStore();
    engine.nextStep();
    engine.completeStep('1.1.1', { r: { item: '甲' } });
    engine.nextStep();
    engine.completeStep('1.2', { ok: false, note: '第一败' });   // 第 1 次:带反馈重跑
    engine.nextStep();
    engine.completeStep('1.1.1', { r: { item: '甲2' } });
    engine.nextStep();
    // 手工注入残账模拟并行收割遗留
    vars.write('__reaped_rs', [[0, { item: '残账' }]], '1.1');
    engine.completeStep('1.2', { ok: false, note: '第二败' });   // 第 2 次:adaptive → replan
    // 提交同构新计划(同位置仍是带 collect 的 loop——残账风险形态)
    const r = engine.submitReplan('1', `1. [loop for-each it in items, collect r into rs] 逐项重来
  - ← items
  + → rs: [yaml]
  1.1. [act free] 加工
    - ← it
    + → r: yaml
2. [check final] 验
  - ← rs
  + → ok: bool  # 判定
  + → note: text  # 说明
`);
    expect(r.status).toBe('ok');
    // 进入即清:replan 后新结构 loop(同号 1.1)重新进入时入口清生效,旧残账不被 finalize 归并
    // (原断言"submitReplan 后立即空"是来路清模型时点,随收敛挪到进入后)
    engine.nextStep();   // 进入新结构 loop
    expect(vars.readLocal('__reaped_rs', '1.1')).toBeNull();
    expect(vars.readLocal('rs', '1.1')).toEqual([]);
  });

  // @v: anc-exec-output-init-reentry — replan 同号残 scope 压制钉（两批 review 面二实抓:
  // 旧结构无 default 容器的 scope 存活,新同号带 default 容器 hasScope 误判已进入初值永不写;
  // 修法=clearOldScopes 对旧 children 一律删 scope 不筛 default）
  it('replan 同号复用:旧无初值容器的残 scope 被清场,新同号带初值容器真灌初值', () => {
    const spec = `# Replan SameId Refill
Id: replan-sameid-refill

## Goal
replan 清场不筛 default,同号残 scope 不压制新容器初值

## Inputs
- items: [line]  # 待加工项

## Outputs
- acc: yaml  # 累加器

## Steps
1. [subtask retry=2 adaptive] 边界
  - ← items
  + → acc: [yaml]
  1.1. [subtask] 位置一容器(无初值声明——执行过即有 scope)
    + → mid: text
    1.1.1. [act free] 干活
      + → mid: text
  1.2. [check final] 验
    - ← mid
    + → ok: bool  # 判定
    + → note: text  # 说明
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { items: ['甲'] } } as never);
    const vars = engine.getVariableStore();
    engine.nextStep();
    engine.completeStep('1.1.1', { mid: '一稿' });
    engine.nextStep();
    engine.completeStep('1.2', { ok: false, note: '一败' });
    engine.nextStep();
    engine.completeStep('1.1.1', { mid: '二稿' });
    engine.nextStep();
    engine.completeStep('1.2', { ok: false, note: '二败' });   // adaptive → replan
    expect((vars as any).hasScope('1.1')).toBe(true);   // 旧 1.1 无 default,scope 在场
    // 新结构:同号 1.1 换成带 = 初值 的 loop 容器
    const r = engine.submitReplan('1', `1. [loop max=2] 攒(同号复用,带初值)
  + → acc: [yaml] = []
  1.1. [act free] 攒一条
    - ← acc
    + → acc: [yaml]
2. [check final] 验
  - ← acc
  + → ok: bool  # 判定
  + → note: text  # 说明
`);
    expect(r.status).toBe('ok');
    // 清场生效:旧 1.1 scope 已删(未修复形态:残 scope 让新容器 hasScope 误判,初值永不写)
    engine.nextStep();   // 进入新结构:新 1.1(loop)建 scope 并重灌 acc=[]
    expect(vars.read('acc', 'root')).toEqual([]);
  });

  // @v: anc-exec-collect-ledger-reset — 进入即清本体钉（2026-09-07 收敛:清空点=loop 入口一处,
  // 不区分来路;来路补丁已删,这两钉锁收敛后的清空点本身）
  it('进入即清正例:loop 首次进入前预塞收割残账 → 入口一并置空,收集结果零污染', () => {
    const spec = `# Entry Clear Probe
Id: entry-clear-probe

## Goal
入口清本体:任何先于进入落下的残账都被进入动作清掉

## Inputs
- items: [line]  # 待加工项

## Outputs
- rs: yaml  # 收集

## Steps
1. [subtask] 边界
  - ← items
  + → rs: [yaml]
  1.1. [loop for-each it in items, collect r into rs] 逐项
    - ← items
    + → rs: [yaml]
    1.1.1. [act free] 加工
      - ← it
      + → r: yaml
  1.2. [check final] 验
    - ← rs
    + → ok: bool  # 判定
    + → note: text  # 说明
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { items: ['甲'] } } as never);
    const vars = engine.getVariableStore();
    // 进入前手工预塞残账(模拟晚到的旧轮收割喂账——来路清模型罩不住的形态:落账发生在
    // 重置之后进入之前;入口清天然罩住)
    (vars as any).createScope('1.1', 'root');
    vars.write('__reaped_rs', [[9, { item: '晚到残账' }]], '1.1');
    engine.nextStep();   // 进入 loop:入口清生效
    expect(vars.readLocal('__reaped_rs', '1.1')).toBeNull();
    engine.completeStep('1.1.1', { r: { item: '甲' } });
    engine.nextStep();
    const rs = vars.read('rs', 'root') as unknown[];
    expect(rs).toHaveLength(1);   // 收集结果恰 1 项,残账零污染
    engine.completeStep('1.2', { ok: true, note: '' });
    expect(engine.getStatus().execution_status).toBe('completed');
  });

  it('进入即清反例:从未进入的 loop,预塞的账原样不动（清空点跟着进入走,不越界扫账）', () => {
    const spec = `# Entry Clear No Touch
Id: entry-clear-no-touch

## Goal
不进入不清——branch 不命中臂里的 loop 账不被碰

## Inputs
- flag: line  # 分支开关

## Outputs
- out: text  # 终值

## Steps
1. [subtask] 边界
  - ← flag
  + → out: text
  1.1. [branch] 分流
    - ← flag
    1.1.1. [case(flag == "走这边")] 常规路
      1.1.1.1. [act free] 直接干
        + → out: text
    1.1.2. [case(flag == "走那边")] 循环路
      1.1.2.1. [loop max=2] 攒
        1.1.2.1.1. [act free] 攒一条
          + → x: yaml
  1.2. [check final] 验
    - ← out
    + → ok: bool  # 判定
    + → note: text  # 说明
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { flag: '走这边' } } as never);
    const vars = engine.getVariableStore();
    (vars as any).createScope('1.1.2.1', 'root');
    vars.write('__reaped_x', [[0, '未进入者的账']], '1.1.2.1');
    engine.nextStep();
    engine.completeStep('1.1.1.1', { out: '直路产出' });
    engine.nextStep();
    // 循环路臂未命中,loop 从未进入——账原样
    expect(vars.readLocal('__reaped_x', '1.1.2.1')).toEqual([[0, '未进入者的账']]);
  });

  // @v: anc-exec-collect-ledger-reset — 三条边界钉（0072-review 批:面二缺陷1 root 回退边/
  // 面三变异 c on_fail 零保护/面三变异 d 递归零保护,三处实锤补钉）
  it('容器重试清账:loop 未进入(scope 缺席)时跳过——root 同名用户变量不被误清', () => {
    const spec = `# Ledger Scope Guard
Id: ledger-scope-guard

## Goal
loop 没跑过就没有聚合账,清账不得回退 root 误清同名变量

## Inputs
- items: [line]  # 待加工项

## Outputs
- rs: yaml  # 收集结果

## Steps
1. [subtask retry=2] 事务边界
  - ← items
  + → rs: [yaml]
  1.1. [act] 前置准备(先于 loop,首轮在此失败)
    + → prep: text
  1.2. [loop for-each it in items, collect r into rs] 逐项
    - ← items
    + → rs: [yaml]
    1.2.1. [act] 加工一项
      - ← it
      + → r: yaml
  1.3. [check final] 验收
    - ← rs
    + → ok: bool  # 判定
    + → note: text  # 说明
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { items: ['甲'] } } as never);
    const vars = engine.getVariableStore();
    // root 上放同名既有值(模拟外层前轮写回的收集列表/作者把该名当普通变量用过)
    vars.write('rs', ['前轮既有值'], 'root');
    engine.nextStep();
    engine.failStep('1.1', '前置步失败,loop 从未进入');   // 触发容器重试,此刻 1.2 无 scope
    // 修复点:scope 缺席跳过——root 值原样;未修复形态:write 回退 root,rs 被清 null 且 __reaped_rs 键泄漏进 root
    expect(vars.read('rs', 'root')).toEqual(['前轮既有值']);
    expect('__reaped_rs' in engine.getVars().variables).toBe(false);
  });

  it('容器重试清账:on_fail 子树内的 collect loop 不被清（兜底账归兜底处置链——重放 0072-review 面三变异 c 必须转红的钉）', () => {
    const spec = `# Ledger Onfail Skip
Id: ledger-onfail-skip

## Goal
on_fail 子树豁免清账

## Inputs
- items: [line]  # 待加工项

## Outputs
- rs: yaml  # 收集结果

## Steps
1. [subtask retry=2] 事务边界
  - ← items
  + → rs: [yaml]
  1.1. [loop for-each it in items, collect r into rs] 逐项
    - ← items
    + → rs: [yaml]
    1.1.1. [act] 加工一项
      - ← it
      + → r: yaml
  1.2. [check final] 验收
    - ← rs
    + → ok: bool  # 判定
    + → note: text  # 说明
  1.9. [on_fail] 兜底
    1.9.1. [loop for-each it in items, collect fb into fbs] 兜底逐项
      - ← items
      + → fbs: [yaml]
      1.9.1.1. [act] 兜底加工
        - ← it
        + → fb: yaml
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { items: ['甲'] } } as never);
    const vars = engine.getVariableStore();
    engine.nextStep();
    engine.completeStep('1.1.1', { r: { item: '甲' } });
    engine.nextStep();
    // 手工给 on_fail 内 loop 造 scope 与账(模拟兜底曾激活跑过——write 对缺席 scope 回退 root,须先建)
    (vars as any).createScope('1.9.1', 'root');
    vars.write('fbs', [{ item: '兜底账' }], '1.9.1');
    vars.write('__reaped_fbs', [[0, { item: '兜底账' }]], '1.9.1');
    engine.completeStep('1.2', { ok: false, note: '打回' });   // 容器重试
    // 进入即清模型:兜底 loop 未被重新进入,账天然不动(不再需要"豁免"条款——没人去动它);
    // 主链 loop(1.1)重新进入时入口清生效
    expect(vars.readLocal('fbs', '1.9.1')).toEqual([{ item: '兜底账' }]);
    expect(vars.readLocal('__reaped_fbs', '1.9.1')).toEqual([[0, { item: '兜底账' }]]);
    engine.nextStep();   // 重跑轮:主链 loop 重新进入
    expect(vars.readLocal('rs', '1.1')).toEqual([]);
    expect(vars.readLocal('fbs', '1.9.1')).toEqual([{ item: '兜底账' }]);   // 兜底账仍原样
  });

  it('容器重试清账:深层嵌套(subtask 内再 subtask 内 loop)也下钻清——重放 0072-review 面三变异 d 必须转红的钉', () => {
    const spec = `# Ledger Deep Recurse
Id: ledger-deep-recurse

## Goal
清账递归下钻到深层嵌套容器内的 collect loop

## Inputs
- items: [line]  # 待加工项

## Outputs
- rs: yaml  # 收集结果

## Steps
1. [subtask retry=2] 外层事务边界
  - ← items
  + → rs: [yaml]
  1.1. [subtask] 中间层容器
    - ← items
    + → rs: [yaml]
    1.1.1. [loop for-each it in items, collect r into rs] 深层逐项
      - ← items
      + → rs: [yaml]
      1.1.1.1. [act] 加工一项
        - ← it
        + → r: yaml
  1.2. [check final] 验收
    - ← rs
    + → ok: bool  # 判定
    + → note: text  # 说明
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { items: ['甲', '乙'] } } as never);
    const vars = engine.getVariableStore();
    engine.nextStep();
    engine.completeStep('1.1.1.1', { r: { item: '甲' } });
    engine.nextStep();
    engine.completeStep('1.1.1.1', { r: { item: '乙' } });
    engine.nextStep();
    vars.write('__reaped_rs', [[1, { item: '深层残账' }]], '1.1.1');
    engine.completeStep('1.2', { ok: false, note: '打回' });   // 外层容器重试
    // 进入即清:深层 loop 重新进入时入口清生效(嵌套多深都一样——清空点跟着进入走,
    // 不再依赖重置路径的递归下钻)
    engine.nextStep();   // 重跑轮推进到深层 loop 重新进入
    expect(vars.readLocal('rs', '1.1.1')).toEqual([]);
    expect(vars.readLocal('__reaped_rs', '1.1.1')).toBeNull();
  });

  // DEBT-13：check final 用更新模式回填祖先反馈变量（← last_err + → last_err），
  // 判 false 应正常 retry，且回填值写入、重跑步能读到（此前 failStep 无差别 null 化
  // + check 失败不写输出 → 重跑步 ← last_err 得 null → MISSING_INPUT 连环失败耗尽 retry）。
  // @v: anc-exec-failstep-skip-update
  it('check final update-mode feedback survives retry and reaches re-run', () => {
    const spec = `# Feedback Loop
Id: fb-loop

## Goal
check 更新模式回填 last_err，重跑步读到定向修正

## Outputs
- out: text

## Steps
1. [act] init
  + → last_err: text = ""
  > init
2. [subtask retry=3] work
  + → out: text
  2.1. [reason] gen or fix
    - ← last_err
    + → out: text
    > last_err 空=新生成，非空=按它修正
  2.2. [check final] gate
    - ← out, last_err
    + → ok: bool
    + → last_err: text
    > ok=false 回填错误说明到 last_err
3. [exit]
  > out
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    const vars = engine.getVariableStore();

    engine.nextStep();
    engine.completeStep('1', { last_err: '' });
    engine.nextStep();
    engine.completeStep('2.1', { out: 'draft-v1' });
    engine.nextStep();
    // check 失败 + 更新模式回填 last_err
    engine.completeStep('2.2', { ok: false, last_err: 'ERR: missing X' });

    // 应正常 retry 回 2.1（不因 last_err 被 null 化而连环失败）
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') {
      expect(s.step_id).toBe('2.1');
      // 重跑步 2.1 的 inputs 里 last_err = 回填的错误（显式反馈流转成立）
      expect(s.context?.inputs?.last_err).toBe('ERR: missing X');
    }
    // subtask scope 里 last_err 是回填值（check 失败也写了更新模式输出）
    expect(vars.read('last_err', '2')).toBe('ERR: missing X');
  });

  it('skips loop body when max_iterations=0', () => {
    const spec = `# Zero Loop
Id: zero-loop

## Goal
Skip loop

## Outputs
- out: text  # output

## Steps
1. [loop max_iterations=0] Should be skipped
  1.1. [act] Never runs
    + → never: text  # never

2. [act] After loop
  + → out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('2');
  });
});

const BRANCH_SPEC = `# Branch Test
Id: branch-test

## Goal
Test branch condition evaluation

## Inputs
- mode: text  # operation mode

## Outputs
- out: text  # result

## Steps
1. [branch] Choose path
  1.1. [case] {mode}==fast
    1.1.1. [act] Fast path
      + → out: text  # fast result
  1.2. [case] {mode}==slow
    1.2.1. [act] Slow path
      + → out: text  # slow result
  1.3. [case]
    1.3.1. [act] Default path
      + → out: text  # default result
`;

// @v: anc-step-branch, anc-step-case
describe('Branch container', () => {
  it('selects case by equality condition', () => {
    const spec = BRANCH_SPEC.replace('- mode: text  # operation mode', '- mode: text  # operation mode');
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { mode: null } });   // 显式空值过顶层必填闸（闸只拒 undefined 缺席）,语义仍是"无命中走 default"

    // mode is explicit null, so neither fast nor slow matches → default case
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.3.1');
  });

  it('selects matching case when condition is true', () => {
    const spec = `# Branch Match
Id: branch-match

## Goal
Test matching

## Outputs
- out: text  # output

## Steps
1. [reason] Produce routing key
  + → route_key: text  # routing decision

2. [branch] Route by key
  2.1. [case] {route_key}==ready
    2.1.1. [act] Handle ready
      + → out: text  # output
  2.2. [case] {route_key}==error
    2.2.1. [act] Handle error
      + → out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1', { route_key: 'ready' });

    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('2.1.1');
  });

  // @v: anc-exec-l3-branch
  // L3 branch 折叠展示：命中后续步骤的 progress_summary 中，branch 折叠为单行 + 命中标记，
  // 未命中 case 不显示、命中 case 内部不展开。
  it('L3 folds branch to single line with hit marker, hides unmatched cases', () => {
    const spec = `# Branch L3
Id: branch-l3

## Goal
Test branch L3 display

## Outputs
- out: text  # output

## Steps
1. [reason] Produce routing key
  + → route_key: text  # routing decision
2. [branch] Route by key
  2.1. [case] {route_key}==ready
    2.1.1. [act] Handle ready
      + → ready_out: text  # ready output
  2.2. [case] {route_key}==error
    2.2.1. [act] Handle error
      + → error_out: text  # error output
3. [reason] Finalize
  + → out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.completeStep('1', { route_key: 'ready' });
    engine.nextStep();                                  // → 2.1.1
    engine.completeStep('2.1.1', { ready_out: 'done-ready' });

    const s3 = engine.nextStep();                       // → 3，其 context 含 branch 折叠
    expect(s3.status).toBe('step_ready');
    if (s3.status === 'step_ready') {
      const prog = s3.context.progress_summary;
      expect(prog).toContain('2 [branch]');             // branch 出现
      expect(prog).toContain('命中 2.1');                // 命中标记
      expect(prog).not.toContain('2.2');                // 未命中 case 不显示
    }
  });

  it('matches quoted literal in condition', () => {
    const spec = `# Branch Quoted
Id: branch-quoted

## Goal
Test quoted literals

## Outputs
- out: text  # output

## Steps
1. [reason] Classify
  + → category: text  # category

2. [branch] Route
  2.1. [case] category == 'critical'
    2.1.1. [act] Critical path
      + → out: text  # output
  2.2. [case] category == 'normal'
    2.2.1. [act] Normal path
      + → out: text  # output
  2.3. [case]
    2.3.1. [act] Default
      + → out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1', { category: 'critical' });

    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('2.1.1');
  });

  it('skips unmatched cases and their children', () => {
    const spec = `# Branch Skip
Id: branch-skip

## Goal
Test skip

## Outputs
- out: text  # output

## Steps
1. [reason] Decide value
  + → choice: text  # value

2. [branch] Pick
  2.1. [case] {choice}==yes
    2.1.1. [act] Yes path
      + → out: text  # output
  2.2. [case] {choice}==no
    2.2.1. [act] No path
      + → out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1', { choice: 'no' });

    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('2.2.1');
  });

  it('evaluates truthy condition', () => {
    const spec = `# Branch Truthy
Id: branch-truthy

## Goal
Truthy test

## Outputs
- out: text  # output

## Steps
1. [reason] Produce flag
  + → flag: bool  # flag

2. [branch] Check flag
  2.1. [case] {flag}
    2.1.1. [act] Flag is truthy
      + → out: text  # output
  2.2. [case]
    2.2.1. [act] Flag is falsy
      + → out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1', { flag: true });

    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('2.1.1');
  });

  it('falsy value falls through to default', () => {
    const spec = `# Branch Falsy
Id: branch-falsy

## Goal
Falsy test

## Outputs
- out: text  # output

## Steps
1. [reason] Produce flag
  + → flag: bool  # flag

2. [branch] Check flag
  2.1. [case] {flag}
    2.1.1. [act] Flag is truthy
      + → out: text  # output
  2.2. [case]
    2.2.1. [act] Flag is falsy
      + → out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    // flag 传 false（bool 合法的 falsy 值）——原传 null 被 SCHEMA_MISMATCH 拒(0031 闸),写入失败
    // 后测试靠"DFS 跳过 running 叶子继续推进"的病灶行为(0049)维持绿:branch 读 undefined 恰
    // falsy 落 default。0049 修掉透明跳过后病灶不再掩护,测试回归其本意=合法 falsy 值落 default。
    // @v: anc-exec-stale-resubmit
    const c = engine.completeStep('1', { flag: false });
    expect(c.status).toBe('ok');

    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('2.2.1');
  });

  it('evaluates != condition', () => {
    const spec = `# Branch Neq
Id: branch-neq

## Goal
Test != condition

## Outputs
- out: text  # output

## Steps
1. [reason] Get status
  + → status: text  # status value

2. [branch] Check status
  2.1. [case] {status}!=error
    2.1.1. [act] Not error path
      + → out: text  # output
  2.2. [case]
    2.2.1. [act] Error path
      + → out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1', { status: 'ok' });

    // status is 'ok' which != 'error' → first case matches
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('2.1.1');
  });

  it('!= condition with matching value falls through', () => {
    const spec = `# Branch Neq Match
Id: branch-neq-match

## Goal
Test != when equal

## Outputs
- out: text  # output

## Steps
1. [reason] Get status
  + → status: text  # status value

2. [branch] Check status
  2.1. [case] {status}!=error
    2.1.1. [act] Not error
      + → out: text  # output
  2.2. [case]
    2.2.1. [act] Is error
      + → out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1', { status: 'error' });

    // status IS 'error', so != fails → falls to default case
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('2.2.1');
  });
});

const BREAK_SPEC = `# Break Test
Id: break-test

## Goal
Test break in loop

## Outputs
- out: text  # output

## Steps
1. [loop max_iterations=10] Loop with break
  1.1. [reason] Check condition
    + → should_stop: bool  # stop flag
  1.2. [branch] Maybe break
    1.2.1. [case] {should_stop}
      1.2.1.1. [break] Stop loop
    1.2.2. [case]
      1.2.2.1. [act] Continue work
        + → out: text  # work output

2. [act] After loop
  + → out: text  # final
`;

// @v: anc-step-break
describe('Break control flow', () => {
  it('terminates loop on break', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(BREAK_SPEC, MINIMAL_HOST_CONFIG);

    // Iteration 1: don't break
    engine.nextStep(); // 1.1
    engine.completeStep('1.1', { should_stop: false });
    engine.nextStep(); // branch evaluates → case 1.2.2 → 1.2.2.1
    engine.completeStep('1.2.2.1', { out: 'work1' });

    // Iteration 2: break
    engine.nextStep(); // 1.1 again
    engine.completeStep('1.1', { should_stop: true });

    // Branch evaluates should_stop=true → case 1.2.1 → break
    // Break terminates loop, next should be step 2
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('2');
  });

  // 可选目标形态（方案 B 2026-08-16）：[break <外层循环号>] 多层嵌套从内层直接跳出外层
  it('break with target terminates the targeted outer loop, not just nearest', () => {
    const spec = `# Targeted Break
Id: targeted-break

## Goal
Test targeted break

## Outputs
- out: text  # output

## Steps
1. [loop max=5] Outer
  1.1. [loop max=5] Inner
    1.1.1. [reason] Decide
      + → stop_all: bool  # jump out both loops
    1.1.2. [branch] Maybe stop
      1.1.2.1. [case] {stop_all}
        1.1.2.1.1. [break 1] Stop outer directly
      1.1.2.2. [case]
        1.1.2.2.1. [act] Inner work
          + → out: text  # partial
2. [act] After both loops
  + → out: text  # final
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep(); // 1.1.1
    engine.completeStep('1.1.1', { stop_all: true });

    // break 1 直接终结外层循环——下一步是 2（若走最近祖先语义会回到外层下一轮 1.1.1）
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('2');
  });

  it('bare break in nested loop only exits nearest (baseline unchanged)', () => {
    const spec = `# Bare Break Nested
Id: bare-break-nested

## Goal
Baseline nearest-loop semantics

## Outputs
- out: text  # output

## Steps
1. [loop max=2] Outer
  1.1. [loop max=5] Inner
    1.1.1. [reason] Decide
      + → stop_inner: bool  # exit inner only
    1.1.2. [branch] Maybe stop
      1.1.2.1. [case] {stop_inner}
        1.1.2.1.1. [break] Stop inner
      1.1.2.2. [case]
        1.1.2.2.1. [act] Inner work
          + → out: text  # partial
  1.2. [act] Outer tail
    + → out: text  # tail
2. [act] After
  + → out: text  # final
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep(); // 1.1.1
    engine.completeStep('1.1.1', { stop_inner: true });

    // 裸 break 只出内层——下一步是外层的 1.2，不是 2
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.2');
  });

  // targeted continue（review 探针实撞修复回归）：[continue <外层号>] = 跳过外层剩余、外层进下一轮
  it('continue with target advances the targeted outer loop to next iteration', () => {
    const spec = `# Targeted Continue
Id: targeted-continue

## Goal
Targeted continue semantics

## Outputs
- out: text  # output

## Steps
1. [loop max=2] Outer
  1.1. [loop max=5] Inner
    1.1.1. [reason] Decide
      + → next_outer: bool  # jump to next outer iteration
    1.1.2. [branch] Maybe jump
      1.1.2.1. [case] {next_outer}
        1.1.2.1.1. [continue 1] Next outer iteration
      1.1.2.2. [case]
        1.1.2.2.1. [act] Inner work
          + → out: text  # partial
  1.2. [act] Outer tail
    + → out: text  # tail
2. [act] After
  + → out: text  # final
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep(); // 1.1.1 (outer iter 1)
    engine.completeStep('1.1.1', { next_outer: true });

    // continue 1 跳过外层剩余（1.2 本轮 skipped）、外层进第 2 轮——下一步回到 1.1.1
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1.1');

    // 第 2 轮走不跳路径到外层尾步——证外层真在迭代而非被终结
    engine.completeStep('1.1.1', { next_outer: false });
    engine.nextStep();
    engine.completeStep('1.1.2.2.1', { out: 'w2' });
    // 内层继续第 2 轮（max=5 未耗尽）
    const s2 = engine.nextStep();
    expect(s2.status).toBe('step_ready');
    if (s2.status === 'step_ready') expect(s2.step_id).toBe('1.1.1');
  });
});

const CONTINUE_SPEC = `# Continue Test
Id: continue-test

## Goal
Test continue in loop

## Outputs
- out: text  # output

## Steps
1. [loop max_iterations=3] Loop with continue
  1.1. [reason] Decide
    + → skip: bool  # skip flag
  1.2. [branch] Maybe skip
    1.2.1. [case] {skip}
      1.2.1.1. [continue] Skip rest
    1.2.2. [case]
      1.2.2.1. [act] Do work
        + → out: text  # work

2. [act] Done
  + → out: text  # final
`;

// @v: anc-step-continue
describe('Continue control flow', () => {
  it('skips remaining siblings in current iteration', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(CONTINUE_SPEC, MINIMAL_HOST_CONFIG);

    // Iteration 1: skip=true → continue
    engine.nextStep(); // 1.1
    engine.completeStep('1.1', { skip: true });
    // Branch evaluates → 1.2.1 → 1.2.1.1 continue
    // Continue skips rest, starts new iteration

    // Iteration 2: skip=false → do work
    const s = engine.nextStep(); // 1.1 again
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1');
    engine.completeStep('1.1', { skip: false });

    const work = engine.nextStep(); // branch → 1.2.2 → 1.2.2.1
    expect(work.status).toBe('step_ready');
    if (work.status === 'step_ready') expect(work.step_id).toBe('1.2.2.1');
  });
});

describe('Continue skips loop-level siblings after branch', () => {
  it('skips check step after branch when continue is inside branch case', () => {
    const spec = `# Continue Deep
Id: continue-deep

## Goal
Test continue skips loop siblings

## Outputs
- out: text  # output

## Steps
1. [loop max_iterations=3] Process
  1.1. [reason] Classify
    + → kind: text  # kind
  1.2. [branch] Route
    1.2.1. [case] kind == 'skip'
      1.2.1.1. [continue]
    1.2.2. [case]
      1.2.2.1. [act] Work
        + → out: text  # work
  1.3. [reason] Post-verify
    + → ok: bool  # ok

2. [act] Final
  + → out: text  # final
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    // Iter 1: kind=skip → continue → should skip 1.3 check
    engine.nextStep(); // 1.1
    engine.completeStep('1.1', { kind: 'skip' });

    // After continue, next should be 1.1 again (iter 2), NOT 1.3
    const iter2 = engine.nextStep();
    expect(iter2.status).toBe('step_ready');
    if (iter2.status === 'step_ready') {
      expect(iter2.step_id).toBe('1.1');
    }

    // Iter 2: kind=normal → work → check
    engine.completeStep('1.1', { kind: 'normal' });
    const work = engine.nextStep();
    expect(work.status).toBe('step_ready');
    if (work.status === 'step_ready') expect(work.step_id).toBe('1.2.2.1');
  });
});

const EXIT_SPEC = `# Exit Test
Id: exit-test

## Goal
Test exit terminates spec

## Outputs
- result: text  # output

## Steps
1. [reason] First step
  + → result: text  # result

2. [exit] Early termination

3. [act] Never reached
  + → never: text  # never
`;

// @v: anc-step-exit
describe('Exit control flow', () => {
  it('terminates spec and skips remaining steps', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(EXIT_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep(); // step 1
    engine.completeStep('1', { result: 'early' });

    // nextStep encounters exit → terminates
    const end = engine.nextStep();
    expect(end.status).toBe('completed');
    if (end.status === 'completed') {
      expect(end.outputs).toEqual({ result: 'early' });
    }
  });

  it('exit with exit_outputs writes variables before termination', () => {
    const spec = `# Exit Outputs
Id: exit-outputs

## Goal
Test exit_outputs

## Outputs
- result: text  # output

## Steps
1. [exit] Early exit

2. [act] Never reached
  + → result: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    // Parser doesn't support exit_outputs syntax yet; patch the AST directly
    const exitStep = (engine as any).spec.steps[0];
    exitStep.exit_outputs = { result: 'done_early' };

    const end = engine.nextStep();
    expect(end.status).toBe('completed');
    if (end.status === 'completed') {
      expect(end.outputs.result).toBe('done_early');
    }
  });
});

// @v: anc-exec-none-propagation
describe('函数级 fail (2026-08-09 定稿)', () => {
  it('uncaught top-level failure skips downstream and terminates (函数级 fail)', () => {
    const spec = `# Uncaught
Id: uncaught-fail

## Goal
Test uncaught failure terminates

## Outputs
- final_out: text  # output

## Steps
1. [act] Step A
  + → data: text  # output

2. [act] Step B
  - ← data
  + → final_out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep(); // step 1 running
    engine.failStep('1', 'error'); // 无事务边界 → 实例终止

    // step 2 不再执行(skipped),终态 failed,FailRecord 在
    const end = engine.nextStep();
    expect(end.status).toBe('failed');
    if (end.status === 'failed') {
      expect(end.failed_step_id).toBe('1');
      expect(end.failure_reason).toBe('error');
    }
    const status = engine.getStatus();
    expect(status.failed).toBe(1);
    expect(status.pending).toBe(0); // 后续被 skipped,非 pending
  });

  it('failure caught by subtask boundary is repaired, downstream unaffected (fail 被边界接住)', () => {
    const spec = `# Caught
Id: caught-fail

## Goal
Test boundary catches failure

## Outputs
- c_out: text  # output

## Steps
1. [subtask retry=2] Guarded work
  + → b_out: text  # output
  1.1. [act] B
    + → b_out: text  # output

2. [act] C
  - ← b_out
  + → c_out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.failStep('1.1', 'first attempt fail');   // 边界接住 → 带反馈重跑

    const retry = engine.nextStep();                 // 1.1 重跑
    expect(retry.status).toBe('step_ready');
    if (retry.status === 'step_ready') expect(retry.step_id).toBe('1.1');
    engine.completeStep('1.1', { b_out: 'repaired' });

    const r2 = engine.nextStep();                    // 下游 C 看到修复后产出
    expect(r2.status).toBe('step_ready');
    if (r2.status === 'step_ready') {
      expect(r2.step_id).toBe('2');
      expect(r2.context.inputs.b_out).toBe('repaired');
    }
    engine.completeStep('2', { c_out: 'done' });
    const end = engine.nextStep();
    expect(end.status).toBe('completed');            // 失败被修复,实例正常完成
  });

  it('undefined (unset) inputs do not block execution (no gate)', () => {
    const spec = `# Undefined
Id: undef

## Goal
Test undefined does not trigger None

## Inputs
- source: text  # input

## Outputs
- out: text  # output

## Steps
1. [act] Use input
  - ← source
  + → out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    // source is undefined (not null) — step should be step_ready
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
  });
});

// @v: anc-exec-retry-adaptive
describe('Subtask retry', () => {
  const RETRY_SPEC = `# Retry Test
Id: retry-test

## Goal
Test subtask retry

## Outputs
- inner_result: text  # output

## Steps
1. [subtask retry=2] Retryable task
  + → inner_result: text  # aggregated output
  1.1. [act] Try something
    + → inner_result: text  # output
`;

  it('retries subtask children on failure (retry=2 gives up to 2 retries)', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(RETRY_SPEC, MINIMAL_HOST_CONFIG);

    // First attempt
    const s1 = engine.nextStep();
    expect(s1.status).toBe('step_ready');
    if (s1.status === 'step_ready') expect(s1.step_id).toBe('1.1');
    engine.failStep('1.1', 'attempt 1 failed');

    // Retry 1: children reset, step 1.1 pending again
    const s2 = engine.nextStep();
    expect(s2.status).toBe('step_ready');
    if (s2.status === 'step_ready') expect(s2.step_id).toBe('1.1');
  });

  it('fails subtask when retry quota exhausted (retry=2 → 3 total attempts)', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(RETRY_SPEC, MINIMAL_HOST_CONFIG);

    // Attempt 1
    engine.nextStep();
    engine.failStep('1.1', 'fail 1');

    // Retry 1
    engine.nextStep();
    engine.failStep('1.1', 'fail 2');

    // Retry 2
    engine.nextStep();
    engine.failStep('1.1', 'fail 3');

    // Quota exhausted → subtask fails → execution fails
    const r = engine.nextStep();
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.failed_step_id).toBe('1');
    }
  });

  it('succeeds on second attempt after first failure', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(RETRY_SPEC, MINIMAL_HOST_CONFIG);

    // Attempt 1 fails
    engine.nextStep();
    engine.failStep('1.1', 'transient error');

    // Retry 1 succeeds
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1');
    engine.completeStep('1.1', { inner_result: 'success' });

    const r = engine.nextStep();
    expect(r.status).toBe('completed');
  });
});

// commit 退火（2026-08-20 作者定,概念 ^anc-step-commit 退火条/设计 exec-engine 退火跳级条）：
// commit 执行后全部祖先边界 retry 失效——失败触发即 fail,防不可逆动作随整组重跑重放。
// @v: anc-exec-commit-anneal
describe('commit 退火：commit 执行后祖先边界 retry 失效', () => {
  const ANNEAL_SPEC = `# Anneal Test
Id: anneal-test

## Goal
Test commit annealing

## Outputs
- done_note: text  # output

## Steps
1. [subtask retry=2] 探索验证提交事务
  + → done_note: text  # aggregated
  1.1. [act] 探索
    + → draft: text  # 草稿
  1.2. [check] 验收
    - ← draft
    + → ok: bool  # 判定
    + → note: text  # 说明
  1.3. [commit] 提交
    - ← draft
    + → done_note: text  # 提交回执
    > \`\`\`hop_python
    > done_note = "done"
    > \`\`\`
  1.4. [act] 提交后收尾
    - ← done_note
    + → done_note: text  # 收尾
`;

  it('正例：commit 执行前失败照常 retry（退火只随 commit done 触发）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ANNEAL_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', '探索失败');   // commit 未执行——照常重跑
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1');
  });

  it('反例（新语义主件）：commit done 后祖先失败 → 不 retry 立刻实例 fail（防 commit 重放）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ANNEAL_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.completeStep('1.1', { draft: 'd' });
    engine.nextStep();
    engine.completeStep('1.2', { ok: true, note: '' });
    engine.nextStep();
    engine.completeStep('1.3', { done_note: '已提交' });   // commit done → 边界 1 退火
    engine.nextStep();
    engine.failStep('1.4', '收尾失败');   // retry=2 还有配额,但边界已退火
    const r = engine.nextStep();
    expect(r.status).toBe('failed');   // 不重跑 1.1——直接实例 failed
    if (r.status === 'failed') expect(r.failed_step_id).toBe('1.4');
  });

  it('正例：退火只及含 commit 的边界——commit 在兄弟事务里时本边界照常 retry', () => {
    const SIBLING_SPEC = `# Sibling Anneal
Id: sibling-anneal

## Goal
g

## Outputs
- out_b: text  # output

## Steps
1. [subtask retry=2] 事务A（含 commit）
  + → out_a: text  # a
  1.1. [act] 备料
    + → draft_a: text  # 草稿
  1.2. [check] 把关
    - ← draft_a
    + → ok_a: bool  # 判定
    + → note_a: text  # 说明
  1.3. [commit] 提交A
    - ← draft_a
    + → out_a: text  # 回执
    > \`\`\`hop_python
    > out_a = "done"
    > \`\`\`
2. [subtask retry=2] 事务B（无 commit）
  + → out_b: text  # b
  2.1. [act] 干活
    + → out_b: text  # 产出
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SIBLING_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.completeStep('1.1', { draft_a: 'd' });
    engine.nextStep();
    engine.completeStep('1.2', { ok_a: true, note_a: '' });
    engine.nextStep();
    engine.completeStep('1.3', { out_a: '提交A完成' });
    engine.nextStep();
    engine.failStep('2.1', 'B 首败');   // 事务 B 子树无 commit——照常 retry
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('2.1');
  });

  // 并行收割三形态全传播（2026-08-20 作者定——成功/失败/强杀收割都要传播）
  const PARALLEL_ANNEAL_SPEC = `# PA
Id: pa
## Goal
g
## Outputs
- rep: text  # r
## Steps
1. [subtask retry=2] 外层事务
  + → rep: text  # r
  1.1. [check] 把关
    + → gate_ok: bool  # 判定
    + → gate_note: text  # 说明
  1.2. [subtask parallel] 并行活
    + → rep: text  # r
    1.2.1. [commit] 提交
      + → rep: text  # 回执
      > \`\`\`hop_python
      > rep = "done"
      > \`\`\`
  1.3. [act] 后续
    + → after_note: text  # r
2. [exit]
`;

  function initParallelAnneal(): ExecutionEngine {
    const dir = mkdtempSync(join(tmpdir(), 'anneal-par-'));
    writeFileSync(join(dir, 'spec.md'), PARALLEL_ANNEAL_SPEC);
    const engine = new ExecutionEngine();
    const init = engine.initExecution(PARALLEL_ANNEAL_SPEC, MINIMAL_HOST_CONFIG, {
      stateDir: join(dir, '.hopstate'), specPath: join(dir, 'spec.md'), cliAbsPath: '/fake/cli.js',
    });
    expect(init.status).toBe('ok');
    engine.setUnifiedDispatch(true);
    return engine;
  }

  function dispatchParallel(engine: ExecutionEngine): string {
    const g = engine.nextStep() as { status: string; step_id?: string };
    expect(g.status).toBe('step_ready');   // 1.1 把关（P8 前置）
    engine.completeStep('1.1', { gate_ok: true, gate_note: '' });
    const n = engine.nextStep() as { status: string; child_instance: string };
    expect(n.status).toBe('dispatch_ready');
    return n.child_instance;
  }

  it('正例：并行成功收割传播 committed → 外层边界退火（后续失败即实例 fail）', () => {
    const engine = initParallelAnneal();
    const child = dispatchParallel(engine);
    engine.reapParallelSubtask(child, { vars: { rep: '回执' }, committed: true });
    const s = engine.nextStep() as { status: string; step_id?: string };
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.3');
    engine.failStep('1.3', '后续失败');
    const r = engine.nextStep();
    expect(r.status).toBe('failed');   // 边界 1 已退火——不重跑（重跑会重放 child 内 commit）
  });

  it('正例：并行失败收割同样传播（child 内 commit 已发生,失败不豁免）', () => {
    const engine = initParallelAnneal();
    const child = dispatchParallel(engine);
    engine.reapParallelSubtask(child, {
      failure: { specId: 'pa', childInstanceId: child, stepFailReasons: { '1.1.1': { reason: 'commit 后收尾崩', fail_kind: 'error' as const } }, stepStates: { '1.1.1': 'failed' } },
      committed: true,
    });
    // 集合语义:失败不贡献元素主线继续;但退火标记已打——外层任何失败不再 retry
    const s = engine.nextStep() as { status: string };
    if (s.status === 'step_ready') {
      engine.failStep('1.3', '后续失败');
      expect(engine.nextStep().status).toBe('failed');
    } else {
      expect(s.status).toBe('failed');   // rep 未产出直接失败亦合法——两路都不得重跑
    }
  });

  it('正例：强杀收割传播——killed 早返回之前登记（迟到回调携 committed 不丢）', () => {
    const engine = initParallelAnneal();
    const child = dispatchParallel(engine);
    engine.killInflight();   // 强杀在飞
    // worker 迟到终态回调（killed 账面早返回,但 committed 传播必须先发生）
    engine.reapParallelSubtask(child, { vars: { rep: 'r' }, committed: true });
    // 验证标记生效面：继续推进,后续步失败必不重跑（边界已退火）
    const s = engine.nextStep() as { status: string; step_id?: string };
    if (s.status === 'step_ready') {
      engine.failStep(s.step_id!, '强杀后失败');
      expect(engine.nextStep().status).toBe('failed');   // 不 retry——killed child 的 commit 已登记
    } else {
      expect(s.status).toBe('failed');
    }
  });

  it('正例：强杀就地读盘登记（复用模式凭据通道——子实例已 persist,无迟到回调也不丢）', () => {
    const engine = initParallelAnneal();
    const child = dispatchParallel(engine);
    // 伪造复用模式子实例盘面：parallel/<child>/state.json 含 committed_steps
    const status = engine.getStatus();
    const instDir = join((engine as unknown as { instanceDir: string }).instanceDir);
    const childDir = join(instDir, 'parallel', child);
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, 'state.json'), JSON.stringify({
      format_version: 1, instance_id: child, step_states: { '1.2.1': 'done' },
      committed_steps: ['1.2.1'], status: 'running',
    }), 'utf-8');
    expect(status.status).toBeDefined();
    engine.killInflight();   // 强杀——就地读盘登记,不依赖任何回调
    const s = engine.nextStep() as { status: string; step_id?: string };
    if (s.status === 'step_ready') {
      engine.failStep(s.step_id!, '强杀后失败');
      expect(engine.nextStep().status).toBe('failed');   // 盘面凭据已登记,边界退火
    } else {
      expect(s.status).toBe('failed');
    }
  });

  it('反例：child 无 commit（committed 缺席/false）→ 零标记,外层照常 retry', () => {
    const engine = initParallelAnneal();
    const child = dispatchParallel(engine);
    engine.reapParallelSubtask(child, { vars: { rep: '回执' } });   // 未传 committed
    const s = engine.nextStep() as { status: string; step_id?: string };
    expect(s.status).toBe('step_ready');
    engine.failStep('1.3', '首败');
    const s2 = engine.nextStep() as { status: string; step_id?: string };
    expect(s2.status).toBe('step_ready');   // 边界未退火——整组重跑（从 1.1 重来）
    if (s2.status === 'step_ready') expect(s2.step_id).toBe('1.1');
  });

  it('正例：loop 体内 commit 逐轮执行不被退火拦（循环正常语义,拦的是 retry 重放）', () => {
    const LOOP_SPEC = `# Loop Commit
Id: loop-commit

## Goal
g

## Inputs
- items: [line]  # 待处理项

## Outputs
- receipts: [text]  # 回执列表

## Steps
1. [loop for-each it in items, collect receipt into receipts] 逐项提交
  + → receipts: [text]  # 回执列表
  1.1. [commit] 提交本项
    - ← it
    + → receipt: text  # 回执
    > \`\`\`hop_python
    > receipt = "done"
    > \`\`\`
`;
    const engine = new ExecutionEngine();
    engine.initExecution(LOOP_SPEC, MINIMAL_HOST_CONFIG, { params: { items: ['a', 'b'] } });
    engine.nextStep();
    engine.completeStep('1.1', { receipt: 'r1' });   // 第 1 轮 commit done → 登记退火
    const s2 = engine.nextStep();
    expect(s2.status).toBe('step_ready');            // 第 2 轮照常推进（迭代不是 retry）
    if (s2.status === 'step_ready') expect(s2.step_id).toBe('1.1');
    engine.completeStep('1.1', { receipt: 'r2' });
    const r = engine.nextStep();
    expect(r.status).toBe('completed');
    if (r.status === 'completed') expect(r.outputs?.['receipts']).toEqual(['r1', 'r2']);
  });

  it('正例：退火标记跨进程持久化（load 后重放同判）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'anneal-xproc-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(ANNEAL_SPEC, MINIMAL_HOST_CONFIG, { stateDir });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    engine.nextStep();
    engine.completeStep('1.1', { draft: 'd' });
    engine.nextStep();
    engine.completeStep('1.2', { ok: true, note: '' });
    engine.nextStep();
    engine.completeStep('1.3', { done_note: '已提交' });
    // 另起引擎 load（模拟下一进程）——committed_steps 须从 state.json 恢复
    const restored = ExecutionEngine.load(join(stateDir, init.instance_id));
    restored.nextStep();
    restored.failStep('1.4', '恢复后失败');
    const r = restored.nextStep();
    expect(r.status).toBe('failed');   // 退火标记随快照——恢复后同样不重放
  });

  // 迭代按轮清零（hopissues/0061,2026-09-02——hopkb r21 批量构建 8/100 实例实撞:轮 1 commit
  // 落盘成功,轮 2 起草失败退火三连拒"子树内 commit 已执行",整实例报废,已加工点保住未加工全丢。
  // 法理=children 重置=新迭代全新事务(retryCounters/onFailActive 既清,committedSteps 漏配补齐)。
  // 变异实证:撤 resetChildrenToPending 的 committedSteps 清理,正例红）
  // 判据重构（2026-09-02 作者裁定"架构设计上的迷糊"——旧两版各错一边:v1 只增不清焊死新轮
  // 〔0061,hopkb 8/100 实例报废〕/v2 按轮清除外层重放〔CA-1 探针实证甲落盘 3 次〕。病根=一份
  // 无轮次记录背两个判定职责。重构=记账带祖先 loop 轮次快照永续不清+判定按重跑范围——设计
  // 三行为矩阵逐行钉。变异实证:撤轮次比对恒命中→行一红;撤前缀判恒不命中→行二行三红）
  describe('退火判据=重跑范围（三行为矩阵,hopissues/0061 二批）', () => {
    const LOOP_ANNEAL_SPEC = `# Loop Anneal
Id: loop-anneal

## Goal
矩阵行一:轮内边界不被前轮 commit 焊死

## Inputs
- items: [line]  # 待加工项

## Outputs
- results: yaml  # 收集

## Steps
1. [loop for-each it in items, collect r into results] 逐项
  - ← items
  + → results: [yaml]
  1.1. [subtask retry=2] 单项加工
    - ← it
    + → r: yaml
    1.1.1. [act] 起草
      - ← it
      + → draft: text  # 草稿
    1.1.2. [check] 校验
      - ← draft
      + → ok: bool  # 判定
      + → note: text  # 说明
    1.1.3. [commit] 落盘
      - ← draft
      + → r: yaml
      > \`\`\`hop_python
      > r = {"kind": "committed"}
      > \`\`\`
`;
    const OUTER_RETRY_SPEC = `# Outer Anneal
Id: outer-anneal

## Goal
矩阵行二:外层边界对前轮 commit 照样退火不重放

## Inputs
- items: [line]  # 待加工项

## Outputs
- rs: yaml  # 收集

## Steps
1. [subtask retry=2] 外层事务边界
  - ← items
  + → rs: [yaml]
  1.1. [loop for-each it in items, collect r into rs] 逐项
    - ← items
    + → rs: [yaml]
    1.1.1. [subtask retry=1] 单项
      - ← it
      + → r: yaml
      1.1.1.1. [act] 起草
        - ← it
        + → draft: text  # 草稿
      1.1.1.2. [check] 校验
        - ← draft
        + → ok: bool  # 判定
        + → note: text  # 说明
      1.1.1.3. [commit] 落盘
        - ← draft
        + → r: yaml
        > \`\`\`hop_python
        > r = {"kind": "committed"}
        > \`\`\`
`;

    it('矩阵行一（0061 效果保住）：轮 1 commit done 推进轮 2,轮 2 失败 → 轮内边界不被前轮记录退火,retry 照常', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(LOOP_ANNEAL_SPEC, MINIMAL_HOST_CONFIG, { params: { items: ['甲', '乙'] } } as never);
      engine.nextStep();
      engine.completeStep('1.1.1', { draft: '甲的内容' });
      engine.nextStep();
      engine.completeStep('1.1.2', { ok: true, note: '' });
      const commitReady = engine.nextStep();
      expect(commitReady.status).toBe('step_ready');
      if (commitReady.status === 'step_ready') expect(commitReady.step_id).toBe('1.1.3');
      engine.completeStep('1.1.3', { r: { kind: 'committed' } });   // 轮 1 commit——记录带轮 1 快照
      const afterCommit = engine.nextStep();   // 迭代推进轮 2（记录不清除）
      expect(afterCommit.status).toBe('step_ready');
      if (afterCommit.status === 'step_ready') expect(afterCommit.step_id).toBe('1.1.1');
      engine.failStep('1.1.1', '轮 2 起草失败');
      const retried = engine.nextStep();   // 边界 1.1 的祖先 loop 当前轮 2≠快照轮 1 → 不退火
      expect(retried.status).toBe('step_ready');
      if (retried.status === 'step_ready') expect(retried.step_id).toBe('1.1.1');
    });

    it('矩阵行二（CA-1 堵住,重构主件）：外层 retry 边界对前轮 commit 照样退火——轮 2 耗尽上浮,外层不重跑不重放,实例如实 failed', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(OUTER_RETRY_SPEC, MINIMAL_HOST_CONFIG, { params: { items: ['甲', '乙'] } } as never);
      let commitCount = 0;
      let r = engine.nextStep();
      for (let i = 0; i < 60 && r.status === 'step_ready'; i++) {
        const id = r.step_id;
        const item = String(engine.getVariableStore().read('it', 'root') ?? '');
        if (id === '1.1.1.1') {
          r = engine.completeStep(id, { draft: item === '甲' ? '甲的内容' : 'FAIL' });
        } else if (id === '1.1.1.2') {
          const draft = String(engine.getVariableStore().read('draft', 'root') ?? '');
          r = draft === 'FAIL' ? engine.completeStep(id, { ok: false, note: '不合格' }) : engine.completeStep(id, { ok: true, note: '' });
        } else if (id === '1.1.1.3') {
          commitCount++;
          r = engine.completeStep(id, { r: { kind: 'committed' } });
        } else { break; }
        if (r.status === 'ok' || r.status === 'error') r = engine.nextStep();
      }
      // 修前(v2 清除案)实测:外层 retry 两次,甲落盘 3 次;修后:外层边界被轮 1 记录退火,恰 1 次
      expect(commitCount).toBe(1);
      expect(r.status).toBe('failed');
    });

    it('矩阵行三（防重放本义）：同一轮内 commit done 后同轮后续失败 → 退火照拒（快照==当前轮）', () => {
      const SPEC = `# Loop Anneal Same Round
Id: loop-anneal-same

## Goal
g

## Inputs
- items: [line]  # 待加工项

## Outputs
- results: yaml  # 收集

## Steps
1. [loop for-each it in items, collect r into results] 逐项
  - ← items
  + → results: [yaml]
  1.1. [subtask retry=2] 单项加工
    - ← it
    + → r: yaml
    1.1.1. [check] 预检
      - ← it
      + → ok: bool  # 判定
      + → note: text  # 说明
    1.1.2. [commit] 先落盘
      - ← it
      + → part: yaml
      > \`\`\`hop_python
      > part = {"kind": "committed"}
      > \`\`\`
    1.1.3. [act] 同轮收尾
      - ← part
      + → r: yaml
`;
      const engine = new ExecutionEngine();
      engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { params: { items: ['甲'] } } as never);
      let s = engine.nextStep();
      expect(s.status).toBe('step_ready');
      engine.completeStep('1.1.1', { ok: true, note: '' });
      s = engine.nextStep();
      engine.completeStep('1.1.2', { part: { kind: 'committed' } });
      s = engine.nextStep();
      expect(s.status).toBe('step_ready');
      if (s.status === 'step_ready') expect(s.step_id).toBe('1.1.3');
      engine.failStep('1.1.3', '同轮收尾失败');
      const after = engine.nextStep();
      expect(after.status).toBe('failed');
    });

    it('边界：跨进程恢复带快照判定一致（persist 后 load,轮内不焊死语义不变）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'anneal-x-'));
      const e1 = new ExecutionEngine();
      e1.initExecution(LOOP_ANNEAL_SPEC, MINIMAL_HOST_CONFIG, { params: { items: ['甲', '乙'] }, stateDir: dir } as never);
      e1.nextStep();
      e1.completeStep('1.1.1', { draft: '甲的内容' });
      e1.nextStep();
      e1.completeStep('1.1.2', { ok: true, note: '' });
      e1.nextStep();
      e1.completeStep('1.1.3', { r: { kind: 'committed' } });
      e1.nextStep();   // 推进轮 2,persist 落快照
      const instanceDir = join(dir, e1.getInstanceId());
      const e2 = ExecutionEngine.load(instanceDir);
      e2.failStep('1.1.1', '恢复后轮 2 失败');
      const r = e2.nextStep();
      expect(r.status).toBe('step_ready');   // 恢复的快照仍判轮 1≠轮 2,不焊死
      if (r.status === 'step_ready') expect(r.step_id).toBe('1.1.1');
    });

    it('边界：嵌套 loop——内层轮内边界只被本内层轮 commit 退火,外层轮推进后内层记录对新外层轮不焊死', () => {
      const NESTED = `# Nested Anneal
Id: nested-anneal

## Goal
g

## Inputs
- xs: [line]  # 外层项
- ys: [line]  # 内层项

## Outputs
- out: yaml  # 收集

## Steps
1. [loop for-each x in xs, collect ox into out] 外层
  - ← xs
  + → out: [yaml]
  1.1. [subtask retry=1] 外层单元
    - ← x
    - ← ys
    + → ox: yaml
    1.1.1. [loop for-each y in ys, collect iy into oys] 内层
      - ← ys
      + → oys: [yaml]
      1.1.1.1. [subtask retry=1] 内层单元
        - ← y
        + → iy: yaml
        1.1.1.1.1. [check] 预检
          - ← y
          + → ok: bool  # 判
          + → note: text  # 说明
        1.1.1.1.2. [commit] 落盘
          - ← y
          + → iy: yaml
          > \`\`\`hop_python
          > iy = {"k": "c"}
          > \`\`\`
    1.1.2. [act] 外层收尾
      - ← oys
      + → ox: yaml
`;
      const engine = new ExecutionEngine();
      engine.initExecution(NESTED, MINIMAL_HOST_CONFIG, { params: { xs: ['A', 'B'], ys: ['p'] } } as never);
      // 外层轮 1:内层轮 1 commit 成功→内层耗尽→外层收尾成功→外层推进轮 2
      let r = engine.nextStep();
      expect(r.status).toBe('step_ready');
      engine.completeStep('1.1.1.1.1', { ok: true, note: '' });
      r = engine.nextStep();
      engine.completeStep('1.1.1.1.2', { iy: { k: 'c' } });
      r = engine.nextStep();
      expect(r.status).toBe('step_ready');
      if (r.status === 'step_ready') expect(r.step_id).toBe('1.1.2');
      engine.completeStep('1.1.2', { ox: { done: 'A' } });
      r = engine.nextStep();   // 外层推进轮 2,内层从头
      expect(r.status).toBe('step_ready');
      if (r.status === 'step_ready') expect(r.step_id).toBe('1.1.1.1.1');
      // 外层轮 2 的内层预检失败——内层单元边界不被外层轮 1 的 commit 记录焊死(外层轮次已变)
      engine.failStep('1.1.1.1.1', '轮 2 预检失败');
      r = engine.nextStep();
      expect(r.status).toBe('step_ready');   // retry 照常
      if (r.status === 'step_ready') expect(r.step_id).toBe('1.1.1.1.1');
    });

    it('边界：旧格式 string[] 恢复 → 恒退火保守（=v1 只增不清行为,宁多拦不重放）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'anneal-old-'));
      const e1 = new ExecutionEngine();
      e1.initExecution(LOOP_ANNEAL_SPEC, MINIMAL_HOST_CONFIG, { params: { items: ['甲', '乙'] }, stateDir: dir } as never);
      e1.nextStep();
      e1.completeStep('1.1.1', { draft: '甲的内容' });
      e1.nextStep();
      e1.completeStep('1.1.2', { ok: true, note: '' });
      e1.nextStep();
      e1.completeStep('1.1.3', { r: { kind: 'committed' } });
      e1.nextStep();
      // 手改 state.json 为旧格式（无快照 string[]）
      const instanceDir = join(dir, e1.getInstanceId());
      const sp = join(instanceDir, 'state.json');
      const st = JSON.parse(readFileSync(sp, 'utf-8'));
      st.committed_steps = ['1.1.3'];   // 旧形态
      writeFileSync(sp, JSON.stringify(st));
      const e2 = ExecutionEngine.load(instanceDir);
      e2.failStep('1.1.1', '轮 2 失败');
      const r = e2.nextStep();
      expect(r.status).toBe('failed');   // 快照空恒命中→边界全退火→实例 fail(保守=旧 v1 行为)
    });
  });

});

// [on fail] 失败兜底块（^anc-step-on-fail 概念/^anc-exec-on-fail 设计,2026-08-21 作者立）：
// retry 耗尽转入兜底,走完失败被消化不上浮（作者定:'on fail 后 fail 不再向父传播'）。
// @v: anc-exec-on-fail
describe('[on fail] 失败兜底块', () => {
  const OF_SPEC = `# OF
Id: of
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=1] 主活
  + → out: text  # o
  1.1. [act] 干活
    + → out: text  # 产出
  1.2. [on fail] 失败兜底
    1.2.1. [act] 记档降级
      + → out: text  # 兜底值
2. [exit]
`;

  it('正例：正常路径兜底块整树 skipped（零成本）,容器照常 done', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(OF_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.completeStep('1.1', { out: '正常' });
    const r = engine.nextStep();
    expect(r.status).toBe('completed');
    if (r.status === 'completed') expect(r.outputs?.['out']).toBe('正常');
    const states = (engine as unknown as { stepStates: Map<string, string> }).stepStates;
    expect(states.get('1.2')).toBe('skipped');
    expect(states.get('1.2.1')).toBe('skipped');
  });

  it('正例：retry 耗尽转入兜底块,走完失败被消化——容器 done 主线继续,兜底值成为容器输出', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(OF_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep(); engine.failStep('1.1', '第1败');
    const retry = engine.nextStep();
    expect(retry.status).toBe('step_ready');   // retry=1 先重跑一次
    if (retry.status === 'step_ready') expect(retry.step_id).toBe('1.1');
    engine.failStep('1.1', '第2败——耗尽');
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');      // 耗尽 → 兜底激活
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.2.1');
    engine.completeStep('1.2.1', { out: '兜底值' });
    const r = engine.nextStep();
    expect(r.status).toBe('completed');        // 失败被消化,不上浮
    if (r.status === 'completed') expect(r.outputs?.['out']).toBe('兜底值');
  });

  it('反例：兜底块自身失败 → 不再兜,容器 fail 照旧上浮（无嵌套 catch）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(OF_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep(); engine.failStep('1.1', 'a');
    engine.nextStep(); engine.failStep('1.1', 'b');
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    engine.failStep('1.2.1', '兜底也崩');
    const r = engine.nextStep();
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failed_step_id).toBe('1');
  });

  // 2026-09-04 D69 修复批新钉三例（0037 实撞:兜底两次被激活但一步未执行,8h 整树重建——
  // 现有全部用例失败点都在末位/唯一常规步,"中位步失败+后有 pending 兄弟"零覆盖恰是死角）
  it('反例转正：中位步失败激活兜底 → 其后 pending 常规兄弟步标 skipped,下一步必达兜底首步（0037 死法①形态——修前 DFS 先跑 pending 兄弟,兄弟再败的正常重试把激活冲掉）', () => {
    const MID_SPEC = `# OFM
Id: ofm
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=0] 主活
  + → out: text  # o
  1.1. [act] 前步
    + → a: text  # 前产出
  1.2. [act] 中位步
    - ← a
    + → b: text  # 中产出
  1.3. [act] 后步
    - ← b
    + → out: text  # 产出
  1.4. [on fail] 失败兜底
    1.4.1. [act] 记档降级
      + → out: text  # 兜底值
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(MID_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.completeStep('1.1', { a: 'A' });
    engine.nextStep();
    engine.failStep('1.2', '中位步死亡');   // retry=0 首败即激活兜底
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.4.1');   // 必达兜底首步,不是 1.3
    const states = (engine as unknown as { stepStates: Map<string, string> }).stepStates;
    expect(states.get('1.3')).toBe('skipped');   // 后位 pending 兄弟被激活时点名跳过
    engine.completeStep('1.4.1', { out: '兜底' });
    const r = engine.nextStep();
    expect(r.status).toBe('completed');
    if (r.status === 'completed') expect(r.outputs?.['out']).toBe('兜底');
  });

  // @v: anc-exec-onfail-context —— 兜底步失败上下文供给（todo/0078:此前兜底步只见"哪步败"
  // 不见"为何败",check note 判词零注入——真机探针实证后立;retry=0 场景 retryHistory 空,
  // 判词只在 stepFailReasons,单源实现必漏,反例判据即此形态）
  it('正例：retry=0 场景兜底步 getOnFailContext 含失败判词原文（stepFailReasons 源——单靠 retryHistory 恰此形态漏）', () => {
    const SPEC = `# OFC
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=0] 主活
  + → out: text  # o
  1.1. [act] 干活
    + → a: text  # 产出
  1.2. [on fail] 兜底
    1.2.1. [act] 把失败原因写进交付
      + → out: text  # 兜底说明
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', 'CHECK_FAILED: 字段 X 缺失、字段 Y 类型错');
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.2.1');
    const failCtx = engine.getOnFailContext('1.2.1');
    expect(failCtx).toBeDefined();
    expect(failCtx).toContain('字段 X 缺失');            // 判词原文在场（0078 probe 同款判据）
    expect(failCtx).toContain('1.1');                    // 失败步位置点名
    expect(failCtx).toContain('供你善后引用');            // 善后措辞（不落修正指令语义）
    // 组装面：assembleBasicContext 的 fail_context 字段同吃（两模式同源载体——
    // 三类 assemble 共走 assembleContext 公共体,取 engine 现成的组装入口验证）
    const node = (engine as unknown as { findStepById: (id: string) => unknown }).findStepById('1.2.1');
    const ctx = (engine as unknown as { assembleBasicContext: (s: unknown) => { fail_context?: string } }).assembleBasicContext(node);
    expect(ctx.fail_context).toContain('字段 X 缺失');
  });

  it('反例：非兜底步 getOnFailContext 恒 undefined（on fail 未激活/无 on fail 祖先都不供给）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(OF_SPEC, MINIMAL_HOST_CONFIG);
    const first = engine.nextStep();
    expect(first.status).toBe('step_ready');
    // 正常路径首步（1.1,无激活 on fail）——不供给
    expect(engine.getOnFailContext('1.1')).toBeUndefined();
  });

  it('正例：retry 耗尽场景兜底步上下文含逐轮重试原因（retryHistory 源）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(OF_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep(); engine.failStep('1.1', '首轮失败原因甲');
    engine.nextStep(); engine.failStep('1.1', '次轮失败原因乙');   // retry=1 耗尽激活兜底
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.2.1');
    const failCtx = engine.getOnFailContext('1.2.1');
    expect(failCtx).toBeDefined();
    expect(failCtx).toContain('首轮失败原因甲');   // 逐轮历史在场
    expect(failCtx).toContain('次轮失败原因乙');
  });

  // @v: anc-exec-onfail-context
  // review 批补钉四例——变异核证抓出的无保护行为面:兜底行/子树不入账/升层前缀/掐口
  it('正例：两源皆空时供给兜底行不静默缺席（契约明文条款——review 变异2实证整删全绿零保护后补）', () => {
    const SPEC = `# OFEMPTY
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=0] 主活
  + → out: text  # o
  1.1. [act] 干活
    + → a: text  # 产出
  1.2. [act] 后步
    - ← a
    + → out: text  # 产出
  1.3. [on fail] 兜底
    1.3.1. [reason] 善后
      + → out: text  # 兜底说明
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.completeStep('1.1', { a: 'A' });
    engine.nextStep();
    // 手工制造"failed 态但无 reason 记录"的两源皆空形态：failStep 后清掉 reason 账
    engine.failStep('1.2', '临时原因');
    (engine as unknown as { stepFailReasons: Map<string, unknown> }).stepFailReasons.delete('1.2');
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    const failCtx = engine.getOnFailContext('1.3.1');
    expect(failCtx).toBeDefined();
    expect(failCtx).toContain('（容器失败,无失败详情记录）');   // 兜底行在场,不静默缺席
  });

  it('正例：兜底子树自身的失败不入失败账（walk 跳过 on_fail——review 变异8实证删跳过全绿零保护后补）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(OF_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep(); engine.failStep('1.1', '主步失败原因甲');
    engine.nextStep(); engine.failStep('1.1', '主步失败原因乙');   // retry=1 耗尽激活兜底
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    // 兜底首步自己也失败一次（兜底内子步失败,fail 记录在账上）
    engine.failStep('1.2.1', '兜底自身的失败原因丙');
    const failCtx = engine.getOnFailContext('1.2.1');
    expect(failCtx).toBeDefined();
    expect(failCtx).toContain('主步失败原因');            // 主线失败在场
    expect(failCtx).not.toContain('兜底自身的失败原因丙'); // 兜底子树自身不入账（自我指涉污染拦住）
  });

  it('正例：升层指引记录行首定性为"升层指引"不作"重试失败"（review 面二实抓借道记录被错定性后补）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(OF_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep(); engine.failStep('1.1', '真失败原因');
    // 手工向 retryHistory 注入升层指引形态记录（借道语义:问路不是失败）
    const rh = (engine as unknown as { retryHistory: Map<string, { attempt: number; failure_reason: string; steps_tried: unknown[] }[]> }).retryHistory;
    const h = rh.get('1') ?? [];
    h.push({ attempt: h.length + 1, failure_reason: '【升层指引】按作者指示换用方案B', steps_tried: [] });
    rh.set('1', h);
    engine.nextStep(); engine.failStep('1.1', '再次失败');   // 耗尽激活兜底
    engine.nextStep();
    const failCtx = engine.getOnFailContext('1.2.1');
    expect(failCtx).toBeDefined();
    expect(failCtx).toContain('轮升层指引:【升层指引】');     // 指引记录按本性定性
    expect(failCtx).not.toContain('轮重试失败:【升层指引】'); // 不被错标成失败
  });

  it('反例：耗尽场景兜底步不渲染 L6 修正指令（掐口——review 面二实抓同屏"逐条落实"与"不要试图修复"打架后补）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(OF_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep(); engine.failStep('1.1', '首轮失败');
    engine.nextStep(); engine.failStep('1.1', '次轮失败');   // retry=1 耗尽激活兜底
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.2.1');
    const node = (engine as unknown as { findStepById: (id: string) => unknown }).findStepById('1.2.1');
    const ctx = (engine as unknown as { assembleBasicContext: (s: unknown) => { retry_feedback?: string; fail_context?: string } }).assembleBasicContext(node);
    expect(ctx.fail_context).toBeDefined();          // 失败信息经 fail_context 单通道
    expect(ctx.retry_feedback).toBeUndefined();      // L6 修正指令被掐——不给兜底步递打回工单
  });

  it('正例：已激活未消耗时重复激活幂等 true（激活≠消耗——0037 死法②:单集身兼两职,"已激活未执行"被当"已用过"拒绝再激活直接上浮）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(OF_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep(); engine.failStep('1.1', 'a');
    engine.nextStep(); engine.failStep('1.1', 'b');   // retry=1 耗尽激活兜底
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.2.1');   // 在兜底里
    // 直接调私有 activateOnFail 二次——已激活未消耗须幂等 true（非 false 上浮）
    const eng = engine as unknown as { activateOnFail: (c: unknown, f?: string) => boolean; findStepById: (id: string) => unknown };
    expect(eng.activateOnFail(eng.findStepById('1'))).toBe(true);
    // 兜底走完（消耗登记）后再激活——false（已兜过底,不再兜）
    engine.completeStep('1.2.1', { out: '兜底' });
    engine.nextStep();
    expect(eng.activateOnFail(eng.findStepById('1'))).toBe(false);
  });

  it('正例：commit 退火边界直达兜底（不重跑不重放,善后照走）', () => {
    const SPEC = `# OFA
Id: ofa
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=2] 事务
  + → out: text  # o
  1.1. [check] 把关
    + → ok: bool  # 判
    + → note: text  # 说明
  1.2. [commit] 提交
    + → receipt: text  # 回执
    > \`\`\`hop_python
    > receipt = "done"
    > \`\`\`
  1.3. [act] 收尾
    - ← receipt
    + → out: text  # o
  1.4. [on fail] 失败兜底
    1.4.1. [act] 记档
      + → out: text  # 兜底
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep(); engine.completeStep('1.1', { ok: true, note: '' });
    engine.nextStep(); engine.completeStep('1.2', { receipt: 'r' });   // commit done → 边界退火
    engine.nextStep(); engine.failStep('1.3', '收尾失败');
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');   // 不重跑（退火）——直达兜底
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.4.1');
    engine.completeStep('1.4.1', { out: '兜底' });
    expect(engine.nextStep().status).toBe('completed');
  });

  it('正例：loop 体内 subtask 带兜底,正常路径多轮迭代照常推进（三次复审实抓:dfs skip 兜底块后只 continue 不触发级联——宿主容器无人闭合,轮1成功后 dfs 越过未闭合容器提前执行 exit,完备性闸误报 never assigned）', () => {
    const LOOP_NORMAL = `# LN
Id: ln
## Goal
g
## Inputs
- xs: [line]  # 列表
## Outputs
- outs: [text]  # 收集
## Steps
1. [loop for-each x in xs, collect o into outs] 遍历
  + → outs: [text]  # 收集
  1.1. [subtask retry=1] 单项事务
    + → o: text  # 单项
    1.1.1. [act] 干活
      - ← x
      + → o: text  # 产出
    1.1.2. [on fail] 兜底
      1.1.2.1. [act] 记档
        + → o: text  # 兜底
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(LOOP_NORMAL, MINIMAL_HOST_CONFIG, { params: { xs: ['a', 'b'] } });
    engine.nextStep();
    engine.completeStep('1.1.1', { o: 'A' });
    const s = engine.nextStep() as { status: string; step_id?: string };
    expect(s.status).toBe('step_ready');   // 轮2 正常推进——不是 failed
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1.1');
    engine.completeStep('1.1.1', { o: 'B' });
    const r = engine.nextStep();
    expect(r.status).toBe('completed');
    if (r.status === 'completed') expect(r.outputs?.['outs']).toEqual(['A', 'B']);
  });

  it('正例：兜底块内 break——兜底消化失败后跳出宿主循环（部分列表交付）', () => {
    const LOOP_BREAK = `# LB
Id: lb
## Goal
g
## Inputs
- xs: [line]  # 列表
## Outputs
- outs: [text]  # 收集
## Steps
1. [loop for-each x in xs, collect o into outs] 遍历
  + → outs: [text]  # 收集
  1.1. [subtask retry=1] 单项事务
    + → o: text  # 单项
    1.1.1. [act] 干活
      - ← x
      + → o: text  # 产出
    1.1.2. [on fail] 兜底
      1.1.2.1. [act] 记档
        + → o: text  # 兜底
      1.1.2.2. [break] 兜底后全停
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(LOOP_BREAK, MINIMAL_HOST_CONFIG, { params: { xs: ['a', 'b', 'c'] } });
    engine.nextStep(); engine.completeStep('1.1.1', { o: 'A' });   // 轮1成功
    engine.nextStep(); engine.failStep('1.1.1', 'b1');
    engine.nextStep(); engine.failStep('1.1.1', 'b2');             // 轮2耗尽
    const fb = engine.nextStep() as { status: string; step_id?: string };
    expect(fb.step_id).toBe('1.1.2.1');
    engine.completeStep('1.1.2.1', { o: '兜底b' });
    const r = engine.nextStep();
    expect(r.status).toBe('completed');   // break 跳出循环——轮3不跑,部分列表交付
    if (r.status === 'completed') expect(r.outputs?.['outs']).toEqual(['A']);   // break 中断在收集前——概念'部分列表'语义
  });

  it('正例：loop 串行迭代=全新事务——retry 预算与兜底激活标记逐迭代复位（二次复审实抓:预算残留轮2首败即耗尽/兜底用过轮2不再兜）', () => {
    const LOOP_OF = `# L
Id: l
## Goal
g
## Inputs
- xs: [line]  # 列表
## Outputs
- outs: [text]  # 收集
## Steps
1. [loop for-each x in xs, collect o into outs] 遍历
  + → outs: [text]  # 收集
  1.1. [subtask retry=1] 单项事务
    + → o: text  # 单项
    1.1.1. [act] 干活
      - ← x
      + → o: text  # 产出
    1.1.2. [on fail] 兜底
      1.1.2.1. [act] 记档
        + → o: text  # 兜底
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(LOOP_OF, MINIMAL_HOST_CONFIG, { params: { xs: ['a', 'b'] } });
    // 轮1：耗尽走兜底
    engine.nextStep(); engine.failStep('1.1.1', 'a1');
    engine.nextStep(); engine.failStep('1.1.1', 'a2');
    let s = engine.nextStep() as { status: string; step_id?: string };
    expect(s.step_id).toBe('1.1.2.1');
    engine.completeStep('1.1.2.1', { o: '兜底a' });
    // 轮2：预算复位（b1 败后仍可重跑）、兜底标记复位（再耗尽仍可兜）
    s = engine.nextStep() as { status: string; step_id?: string };
    expect(s.step_id).toBe('1.1.1');
    engine.failStep('1.1.1', 'b1');
    s = engine.nextStep() as { status: string; step_id?: string };
    expect(s.step_id).toBe('1.1.1');   // 预算每迭代独立——不因轮1耗尽而首败即死
    engine.failStep('1.1.1', 'b2');
    s = engine.nextStep() as { status: string; step_id?: string };
    expect(s.step_id).toBe('1.1.2.1'); // 兜底逐迭代重新可用
    engine.completeStep('1.1.2.1', { o: '兜底b' });
    const r = engine.nextStep();
    expect(r.status).toBe('completed');
    if (r.status === 'completed') expect(r.outputs?.['outs']).toEqual(['兜底a', '兜底b']);
  });

  // 激活动作第五样：失败点到容器之间的中间容器终态化（hopissues/0104——失败点嵌在 branch>case
  // 下,兜底走完 branch 仍 running,级联在 subtask 层判"子步全终态"不成立返回,宿主循环断轮）
  describe('失败点嵌在中间容器下——兜底走完宿主循环照常推进（hopissues/0104）', () => {
    const BRANCH_SPEC = `# NB
Id: nb
## Goal
g
## Inputs
- xs: [line]  # 列表
## Outputs
- outs: [text]  # 收集
## Steps
1. [loop for-each x in xs, collect o into outs] 遍历
  + → outs: [text]  # 收集
  1.1. [subtask retry=0] 单项事务
    + → o: text  # 单项
    1.1.1. [reason] 分诊
      - ← x
      + → t: line  # 分诊
    1.1.2. [branch] 路由
      1.1.2.1. [case(t == "go")] 继续
        + → o: text  # 产出
        1.1.2.1.1. [act] 干活
          - ← x
          + → o: text  # 产出
        1.1.2.1.2. [act] 收尾
          + → o: text  # 产出
      1.1.2.2. [case(else)] 弃
        1.1.2.2.1. [act] 弃点
          + → o: text  # 弃
    1.1.3. [on fail] 兜底
      1.1.3.1. [act] 记档
        + → o: text  # 兜底
2. [exit]
`;
    const LOOP_SPEC = `# NL
Id: nl
## Goal
g
## Inputs
- xs: [line]  # 列表
## Outputs
- outs: [text]  # 收集
## Steps
1. [loop for-each x in xs, collect o into outs] 遍历
  + → outs: [text]  # 收集
  1.1. [subtask retry=0] 单项事务
    + → o: text  # 单项
    1.1.1. [loop max=2] 内层轮询
      1.1.1.1. [act] 探一次
        - ← x
        + → o: text  # 产出
      1.1.1.2. [act] 记一次
        + → o: text  # 产出
    1.1.2. [on fail] 兜底
      1.1.2.1. [act] 记档
        + → o: text  # 兜底
2. [exit]
`;
    const states = (e: ExecutionEngine) => (e as unknown as { stepStates: Map<string, string> }).stepStates;

    it('正例：branch>case 下深层失败走兜底 → 中间 branch 标 failed、case 内后位 pending 子步标 skipped,宿主循环推进下一轮并收集兜底值', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(BRANCH_SPEC, MINIMAL_HOST_CONFIG, { params: { xs: ['a', 'b', 'c'] } });
      // 轮1 正常
      engine.nextStep(); engine.completeStep('1.1.1', { t: 'go' });
      engine.nextStep(); engine.completeStep('1.1.2.1.1', { o: 'x' });
      engine.nextStep(); engine.completeStep('1.1.2.1.2', { o: 'A' });
      // 轮2 深层失败 → case 预算缺省 3 轮重试后耗尽,升级到 subtask(retry=0) 激活兜底
      engine.nextStep(); engine.completeStep('1.1.1', { t: 'go' });
      let s = engine.nextStep() as { status: string; step_id?: string };
      let guard = 0;
      while (s.status === 'step_ready' && s.step_id === '1.1.2.1.1' && guard++ < 10) {
        engine.failStep('1.1.2.1.1', 'boom');
        s = engine.nextStep() as { status: string; step_id?: string };
      }
      expect(s.step_id).toBe('1.1.3.1');
      const st = states(engine);
      expect(st.get('1.1.2')).toBe('failed');      // 中间容器终态化（修前停在 running）
      expect(st.get('1.1.2.1')).toBe('failed');
      expect(st.get('1.1.2.1.2')).toBe('skipped'); // 失败点后位 pending 兄弟
      expect(st.get('1.1.2.2')).toBe('skipped');
      engine.completeStep('1.1.3.1', { o: '兜底b' });
      // 兜底消化失败 → 容器收场 → 级联推宿主 loop 进轮3（1.1 随轮进复位 pending）
      expect((engine as unknown as { loopCounters: Map<string, number> }).loopCounters.get('1')).toBe(3);
      // 轮3 照常推进（修前执行流越过循环直达 exit,完备性闸报 outs never assigned）
      s = engine.nextStep() as { status: string; step_id?: string };
      expect(s.step_id).toBe('1.1.1');
      engine.completeStep('1.1.1', { t: 'go' });
      engine.nextStep(); engine.completeStep('1.1.2.1.1', { o: 'x' });
      engine.nextStep(); engine.completeStep('1.1.2.1.2', { o: 'C' });
      const r = engine.nextStep();
      expect(r.status).toBe('completed');
      if (r.status === 'completed') expect(r.outputs?.['outs']).toEqual(['A', '兜底b', 'C']);
    });

    it('正例：条件 loop 下失败走兜底 → 中间 loop 标 failed、loop 内后位 pending 子步标 skipped,宿主循环照常推进', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(LOOP_SPEC, MINIMAL_HOST_CONFIG, { params: { xs: ['a', 'b'] } });
      engine.nextStep(); engine.failStep('1.1.1.1', 'boom');   // retry=0 首败即激活兜底
      const fb = engine.nextStep() as { status: string; step_id?: string };
      expect(fb.step_id).toBe('1.1.2.1');
      const st = states(engine);
      expect(st.get('1.1.1')).toBe('failed');
      expect(st.get('1.1.1.2')).toBe('skipped');
      engine.completeStep('1.1.2.1', { o: '兜底a' });
      const s = engine.nextStep() as { status: string; step_id?: string };
      expect(s.step_id).toBe('1.1.1.1');   // 轮2 从头开始（内层 loop 随宿主轮进复活）
      engine.completeStep('1.1.1.1', { o: 'x' });
      engine.nextStep(); engine.completeStep('1.1.1.2', { o: 'y1' });
      engine.nextStep(); engine.completeStep('1.1.1.1', { o: 'x' });
      engine.nextStep(); engine.completeStep('1.1.1.2', { o: 'B' });
      const r = engine.nextStep();
      expect(r.status).toBe('completed');
      if (r.status === 'completed') expect(r.outputs?.['outs']).toEqual(['兜底a', 'B']);
    });

    it('反例：失败点是容器直接子步时祖先链为空——不动任何中间状态,行为与修前一致', () => {
      const FLAT = `# NF
Id: nf
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=0] 主活
  + → out: text  # o
  1.1. [act] 干活
    + → out: text  # 产出
  1.2. [branch] 后续路由
    1.2.1. [case(out == "x")] 走这边
      1.2.1.1. [act] 后续
        + → out: text  # 产出
  1.3. [on fail] 兜底
    1.3.1. [act] 记档
      + → out: text  # 兜底
2. [exit]
`;
      const engine = new ExecutionEngine();
      engine.initExecution(FLAT, MINIMAL_HOST_CONFIG);
      engine.nextStep(); engine.failStep('1.1', 'boom');
      const fb = engine.nextStep() as { status: string; step_id?: string };
      expect(fb.step_id).toBe('1.3.1');
      const st = states(engine);
      expect(st.get('1.1')).toBe('failed');
      expect(st.get('1')).toBe('running');     // 容器本身不被第五样动（保持 running 等兜底）
      expect(st.get('1.2')).toBe('skipped');   // 后位兄弟走第四样,不是 failed
      engine.completeStep('1.3.1', { out: '兜底' });
      const r = engine.nextStep();
      expect(r.status).toBe('completed');
      if (r.status === 'completed') expect(r.outputs?.['out']).toBe('兜底');
    });
  });

  it('正例：check final 反复不过耗尽 → 转入兜底（验收失败的善后路径——兜底非 check final 旁路:正常成功路径仍必经验收）', () => {
    const CF_SPEC = `# CF
Id: cf
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=1] 事务
  + → out: text  # o
  1.1. [act] 干
    + → out: text  # p
  1.2. [check final] 验收
    - ← out
    + → ok: bool  # 判
    + → note: text  # 说明
  1.3. [on fail] 兜底
    1.3.1. [act] 记档
      + → out: text  # 兜底
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(CF_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep(); engine.completeStep('1.1', { out: 'v1' });
    engine.nextStep(); engine.completeStep('1.2', { ok: false, note: '不达标1' });
    engine.nextStep(); engine.completeStep('1.1', { out: 'v2' });
    engine.nextStep(); engine.completeStep('1.2', { ok: false, note: '不达标2' });
    const fb = engine.nextStep() as { status: string; step_id?: string };
    expect(fb.step_id).toBe('1.3.1');
    engine.completeStep('1.3.1', { out: '兜底值' });
    const r = engine.nextStep();
    expect(r.status).toBe('completed');
    if (r.status === 'completed') expect(r.outputs?.['out']).toBe('兜底值');
  });

  it('正例：兜底激活集跨进程持久化（load 后兜底续跑,不重复激活）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'onfail-xproc-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(OF_SPEC, MINIMAL_HOST_CONFIG, { stateDir });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    e1.nextStep(); e1.failStep('1.1', 'a');
    e1.nextStep(); e1.failStep('1.1', 'b');   // 耗尽 → 激活兜底并落盘
    const e2 = ExecutionEngine.load(join(stateDir, init.instance_id));
    const fb = e2.nextStep();
    expect(fb.status).toBe('step_ready');
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.2.1');
    e2.completeStep('1.2.1', { out: '兜底' });
    expect(e2.nextStep().status).toBe('completed');
  });
});

// 确定性失败不重试（^anc-exec-deterministic-no-retry,2026-08-23 dr7 彻查后立——dr6 DEPTH_EXCEEDED
// 盲重试 3-4 轮/dr7 CalleeFailure 父层再赌 4 攻 5 小时全灭:重跑必然同因,重试预算纯浪费）
// @v: anc-exec-deterministic-no-retry
describe('确定性失败不重试', () => {
  const DET_SPEC = `# DT
Id: dt
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=3] 主活
  + → out: text  # o
  1.1. [act] 干活
    + → out: text  # 产出
  1.2. [on fail] 兜底
    1.2.1. [act] 降档
      + → out: text  # 兜底值
2. [exit]
`;

  it('正例：DEPTH_EXCEEDED 前缀 → 跳过全部 retry 档直达兜底（retry=3 一次不烧）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(DET_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', 'DEPTH_EXCEEDED: call 深度 11 超上限 10（resource_limits.max_call_depth）');
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.2.1');   // 不是重跑 1.1——直达兜底
    engine.completeStep('1.2.1', { out: '降档' });
    const r = engine.nextStep();
    expect(r.status).toBe('completed');
    if (r.status === 'completed') expect(r.outputs?.['out']).toBe('降档');
  });

  it('正例：CalleeFailure 前缀 → 同款直达兜底（子层 retry 已在子层烧尽,父层不再赌）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(DET_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', 'CalleeFailure: {"callee_spec_id":"x","reason":"真根因","attempts":3}');
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.2.1');
  });

  // 2026-09-04 乙案改钉（决策档案 todo/decision/20260904-确定性错误免预算不提前兜底.md——
  // OUTPUT_TRUNCATED 从"直达兜底"改"步级瞬态免预算重跑":输出超长绑定本轮生成选择,下轮反馈
  // 工单变了输入就变;0037 实撞:提前激活兜底被兄弟步正常重试冲掉,两机制打架,环二 9 轮修过关实证）
  it('正例：OUTPUT_TRUNCATED 首撞 → 免扣预算带反馈重跑（步级瞬态,不提前兜底——乙案）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(DET_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', 'Replan API error after 3 attempts: OUTPUT_TRUNCATED: replan 流水线段输出被 max_tokens 掐断（output_tokens=16384）');
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.1');   // 重跑本步非兜底——预算未扣（复发例另核扣减）
  });

  it('正例：OUTPUT_TRUNCATED 同步骤二撞 → 照扣预算走正常阶梯（免预算有界化:瞬态假设被证伪,防预算永不减兜底永不到）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(DET_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', 'OUTPUT_TRUNCATED: 首撞（免扣）');
    engine.nextStep();
    engine.failStep('1.1', 'OUTPUT_TRUNCATED: 二撞（照扣）');
    engine.nextStep();
    // retry=3:首撞免扣后剩 3,二撞起照扣——3 次扣完耗尽转兜底(总失败 5 次:免 1+扣 3+耗尽那次)
    engine.failStep('1.1', 'OUTPUT_TRUNCATED: 三撞');
    engine.nextStep();
    engine.failStep('1.1', 'OUTPUT_TRUNCATED: 四撞');
    engine.nextStep();
    engine.failStep('1.1', 'OUTPUT_TRUNCATED: 五撞');
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.2.1');   // 预算真耗尽才到兜底——单入口
  });

  // @v: anc-exec-thinking-exhausted —— 确定性口袋半边（分流报文与留档钉在 dispatcher/hoplog 测试文件）
  // @v: anc-exec-toolloop-ctx-degrade —— 确定性口袋半边（压缩降级钉在 dispatcher 测试文件）
  it('正例：CONTEXT_OVERFLOW（压缩降级后仍超模型窗）→ 入确定性口袋不烧 retry（0070 四连撞实撞:重发必然同因且更大,请求 1.05M→1.08M 只增不减）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(DET_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', 'CONTEXT_OVERFLOW: 工具循环压缩降级后仍超模型窗——单步材料量超出模型能力，拆步骤（for-each 逐份）或换更大窗的模型');
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.2.1');   // 不重跑 1.1——直达兜底,retry=3 一次不烧
  });

  it('正例：THINKING_EXHAUSTED 首撞 → 免扣预算带反馈重跑（步级瞬态同 OUTPUT_TRUNCATED——2026-09-04 乙案改钉:反刍绑定本轮输入形态,下轮带新反馈输入已变）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(DET_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', 'THINKING_EXHAUSTED: 推理通道烧满输出上限且正文为空（output_tokens=32768）——可能是思维反刍循环');
    const fb = engine.nextStep();
    expect(fb.status).toBe('step_ready');
    if (fb.status === 'step_ready') expect(fb.step_id).toBe('1.1');   // 重跑本步非兜底——免预算重试
  });

  it('正例：无兜底块的确定性失败 → 直接上浮 failed（不烧任何 retry）', () => {
    const NO_OF = DET_SPEC.replace(/  1\.2\. \[on fail\][^]*?# 兜底值\n/, '');
    const engine = new ExecutionEngine();
    engine.initExecution(NO_OF, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', 'DEPTH_EXCEEDED: 深度墙');
    const r = engine.nextStep();
    expect(r.status).toBe('failed');   // retry=3 一轮都不重跑
  });

  it('反例：普通失败照走 retry 阶梯（确定性闸不误伤——同 spec 普通 reason 首败重跑 1.1）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(DET_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', 'CHECK_FAILED: 内容不达标');   // 非确定性
    const rt = engine.nextStep();
    expect(rt.status).toBe('step_ready');
    if (rt.status === 'step_ready') expect(rt.step_id).toBe('1.1');   // 正常带反馈重跑
  });

  // 档次判定只看失败原因的开头（todo/0116——0107 收尾实例 5e5e3afc:判定打回意见引用了代码里的
  // 超窗前缀字符串,修前子串匹配把这次打回当事务级确定性失败,retry=2 一次没用直接失败。
  // 修前红:①在基线 b99231fb 上 1.1 不重跑而是直达兜底 1.2.1;②在基线上出现免扣事件、没有 attempt 事件）
  const retryEvents = (engine: ExecutionEngine) =>
    engine.getExecEvents().filter(e => e.step_id === '1' && e.event === 'retry').map(e => e.detail ?? '');

  it('反例①：判定打回意见原文里引用了超窗前缀字样 → 普通档照扣预算重跑（不是事务级直达兜底）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(DET_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', "CHECK_FAILED: 第 3 条未落实——engine.ts 里仍是 reason.includes('CONTEXT_OVERFLOW:') 整段匹配");
    const rt = engine.nextStep();
    expect(rt.status).toBe('step_ready');
    if (rt.status === 'step_ready') expect(rt.step_id).toBe('1.1');   // 重跑本步,不是兜底 1.2.1
    const ev = retryEvents(engine);
    expect(ev).toContain('attempt 1/3');   // 扣了一次预算
    expect(ev.some(d => d.includes('事务级'))).toBe(false);
    expect((engine as any).retryCounters.get('1')).toBe(2);
  });

  it('反例②：判定打回意见原文里引用了输出截断前缀字样 → 普通档照扣预算（不白送免扣）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(DET_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', 'CHECK_FAILED: 报告里把 OUTPUT_TRUNCATED: 当成了网络错误,归类写错');
    const rt = engine.nextStep();
    expect(rt.status).toBe('step_ready');
    if (rt.status === 'step_ready') expect(rt.step_id).toBe('1.1');
    const ev = retryEvents(engine);
    expect(ev).toContain('attempt 1/3');
    expect(ev.some(d => d.includes('免扣预算'))).toBe(false);
    expect((engine as any).retryCounters.get('1')).toBe(2);
  });

  it('正例③：首次计划包装里的推理烧满 → 剥掉包装后仍按步级瞬态免扣（包装前缀封闭清单第 2 条）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(DET_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', 'Initial plan generation failed: THINKING_EXHAUSTED: 推理通道烧满输出上限且正文为空');
    const rt = engine.nextStep();
    expect(rt.status).toBe('step_ready');
    if (rt.status === 'step_ready') expect(rt.step_id).toBe('1.1');
    const ev = retryEvents(engine);
    expect(ev.some(d => d.includes('免扣预算') && d.includes('THINKING_EXHAUSTED'))).toBe(true);
    expect(ev.some(d => d.startsWith('attempt'))).toBe(false);   // 没扣预算
  });

  it('classifyFailReason 直测：设计条款四个例子 + 失败记录类别优先 + 包装里的事务级前缀照判事务级', () => {
    expect(classifyFailReason("CHECK_FAILED: 引用了 'CONTEXT_OVERFLOW:' 字样").fail_class).toBe('normal');
    expect(classifyFailReason('CHECK_FAILED: 引用了 OUTPUT_TRUNCATED: 字样').fail_class).toBe('normal');
    expect(classifyFailReason('需要的数据缺 TOOL_LOOP_REPEAT: 说明 (lack_of_info)').fail_class).toBe('normal');
    expect(classifyFailReason('Replan API error after 3 attempts: OUTPUT_TRUNCATED: 被掐断'))
      .toEqual({ fail_class: 'transient', transient_prefix: 'OUTPUT_TRUNCATED' });
    expect(classifyFailReason('Initial plan generation failed: Replan API error after 2 attempts: TOOL_LOOP_REPEAT: 复读'))
      .toEqual({ fail_class: 'transient', transient_prefix: 'TOOL_LOOP_REPEAT' });   // 反复剥
    expect(classifyFailReason('任意文字', 'deterministic').fail_class).toBe('transactional');
    expect(classifyFailReason('CONTEXT_OVERFLOW: 压缩后仍超窗').fail_class).toBe('transactional');
    expect(classifyFailReason('Replan API error after 3 attempts: CONTEXT_OVERFLOW: 超窗').fail_class).toBe('transactional');
    expect(classifyFailReason('前面有字 Replan API error after 3 attempts: OUTPUT_TRUNCATED: x').fail_class).toBe('normal');   // 包装只认开头
  });
});

// CalleeFailure 内核提取修正（^anc-exec-callee-kernel,2026-08-23 dr7 修——文档序首个 failed
// 常取到容器〔只有状态位〕,叶子真根因被丢,深链两层后父层全盲）
// @v: anc-exec-callee-kernel
describe('CalleeFailure 内核提取', () => {
  function makeCallEngine() {
    const engine = new ExecutionEngine();
    engine.initExecution('# C\nId: c\n## Goal\ng\n## Outputs\n- o: text  # x\n## Steps\n1. [call foo]\n  + → o: r  # m\n2. [exit]\n',
      { ...MINIMAL_HOST_CONFIG, spec_provider: { resolve: async () => null } }, {});
    engine.nextStep();
    return engine;
  }

  it('正例：容器先于叶子 failed 时,内核取首个带明细的叶子（真根因不丢）', () => {
    const engine = makeCallEngine();
    engine.failCallStep('1', {
      specId: 'foo', childInstanceId: 'ci',
      stepStates: { '2': 'failed', '2.1': 'failed', '2.1.1': 'failed' },   // 文档序容器在前
      stepFailReasons: { '2.1.1': { reason: 'CHECK_FAILED: 轮次目录无落点（真根因）', fail_kind: 'error' } },
    });
    const r = engine.getFailureReason('1');
    expect(r).toContain('真根因');                       // 叶子明细透传
    expect(r).not.toContain('缺失败明细');               // 不再落占位文案
    expect(r).toContain('"failed_step":"2.1.1"');        // 内核步指到叶子
  });

  it('正例：嵌套失败单跳摘要（D42）——孙层 CalleeFailure 被消化成一跳可读摘要,父层不见双层 JSON', () => {
    const engine = makeCallEngine();
    // 子实例的 kernel 本身是它对孙的 CalleeFailure（模拟三层链的中间层状态）
    const grandChildFailure = 'CalleeFailure: {"callee_spec_id":"leaf","child_instance":"ci-leaf","failed_step":"3","reason":"CHECK_FAILED: 轮次目录无落点（孙层真因）","fail_kind":"error","attempts":2}';
    engine.failCallStep('1', {
      specId: 'mid', childInstanceId: 'ci-mid',
      stepStates: { '1': 'failed' },
      stepFailReasons: { '1': { reason: grandChildFailure, fail_kind: 'error' } },
    });
    const r = engine.getFailureReason('1')!;
    expect((r.match(/CalleeFailure/g) ?? []).length).toBe(1);      // 只一层包装,无嵌套 JSON
    expect(r).toContain("调用 'leaf' 失败于其步骤 '3'");            // 消化成一跳摘要（直接子的语言）
    expect(r).toContain('已试 2 次');
    expect(r).toContain('轮次目录无落点');                          // 孙因保留截断版,可读不冗长
  });

  it('反例（回退路径）：全部 failed 步骤均无明细 → 占位文案保留（只剩协议异常形态,如实呈现）', () => {
    const engine = makeCallEngine();
    engine.failCallStep('1', {
      specId: 'foo', childInstanceId: 'ci',
      stepStates: { '2': 'failed' },
      stepFailReasons: {},
    });
    expect(engine.getFailureReason('1')).toContain('缺失败明细');
  });
});

// @v: anc-step-case, anc-exec-retry-adaptive
describe('case-granularity retry (case 就是 branch 下的 subtask)', () => {
  const CASE_RETRY_SPEC = `# Case Retry
Id: case-retry
## Goal
Test case-level retry
## Outputs
- result: text  # output
## Steps
1. [reason] Classify
  + → kind: text  # type
  > classify
2. [branch] Route
  + → result: text  # branch aggregated output
  2.1. [case retry=2] kind == 'go'
    + → result: text  # case aggregated output (case≡subtask)
    2.1.1. [act] Do work
      + → result: text  # work output
      > do it
`;

  it('failed step inside case retries at case granularity', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(CASE_RETRY_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1', { kind: 'go' });

    // Enter case 2.1, step 2.1.1 ready
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('2.1.1');

    // Fail it → case retry should reset and re-offer 2.1.1
    engine.failStep('2.1.1', 'attempt 1 failed');
    const retry = engine.nextStep();
    expect(retry.status).toBe('step_ready');
    if (retry.status === 'step_ready') expect(retry.step_id).toBe('2.1.1');
  });

  it('case retry exhausted → branch fails → execution fails', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(CASE_RETRY_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1', { kind: 'go' });

    // retry=2 → 3 total attempts
    engine.nextStep(); engine.failStep('2.1.1', 'f1');
    engine.nextStep(); engine.failStep('2.1.1', 'f2');
    engine.nextStep(); engine.failStep('2.1.1', 'f3');

    const r = engine.nextStep();
    expect(r.status).toBe('failed');
  });

  it('case succeeds → branch completes', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(CASE_RETRY_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1', { kind: 'go' });
    engine.nextStep();
    engine.completeStep('2.1.1', { result: 'done' });

    const r = engine.nextStep();
    expect(r.status).toBe('completed');
    if (r.status === 'completed') expect(r.outputs.result).toBe('done');
  });
});

// @v: anc-exec-container-output, anc-step-case
// branch 聚合输出回归(task #81): case≡subtask 自声明聚合输出、经作用域提升供后续引用;
// branch 不声明输出(纯控制流)。修复前 case 不在 SCOPE_CREATING、V3 误拦 case +→。
describe('Branch aggregated output via case (task #81)', () => {
  const BRANCH_AGG_SPEC = `# Branch Aggregate
Id: branch-agg
## Goal
Test branch declares aggregated output, case same-name fill, branch promotes to outer scope
## Outputs
- decision: text  # final decision
## Steps
1. [reason] Classify risk
  + → risk: text  # risk level
2. [branch] Route by risk
  + → decision: text  # branch declares aggregated output (统一接口名)
  2.1. [case] {risk}==high
    + → decision: text  # case same-name fill (同一个东西)
    2.1.1. [reason] High risk response
      - ← risk
      + → decision: text  # child produces it
  2.2. [case]
    + → decision: text  # default case same-name fill
    2.2.1. [reason] Low risk response
      - ← risk
      + → decision: text  # child produces it
3. [reason] Review decision
  - ← decision
  + → review: text  # review note
`;

  it('validates without V3 error (case +→ not blocked)', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(BRANCH_AGG_SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
  });

  it('case aggregated output promoted to outer scope, readable by subsequent step', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(BRANCH_AGG_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1', { risk: 'high' });
    // branch evaluates → case 2.1 matches (risk==high)
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') {
      expect(s.step_id).toBe('2.1.1');
    }
    engine.completeStep('2.1.1', { decision: 'escalate immediately' });

    // step 3 should receive decision from case 2.1's promoted output
    const s3 = engine.nextStep();
    expect(s3.status).toBe('step_ready');
    if (s3.status === 'step_ready') {
      expect(s3.step_id).toBe('3');
      expect(s3.context.inputs['decision']).toBe('escalate immediately');
    }
  });

  it('completes with case output in final outputs', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(BRANCH_AGG_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep(); engine.completeStep('1', { risk: 'high' });
    engine.nextStep(); engine.completeStep('2.1.1', { decision: 'escalate immediately' });
    engine.nextStep(); engine.completeStep('3', { review: 'approved' });

    const final = engine.nextStep();
    expect(final.status).toBe('completed');
    if (final.status === 'completed') {
      expect(final.outputs.decision).toBe('escalate immediately');
    }
  });
});

// @v: anc-cli-replan-response
describe('Adaptive replan', () => {
  const ADAPTIVE_SPEC = `# Adaptive Test
Id: adaptive-test

## Goal
Test adaptive replan

## Outputs
- final_out: text  # output

## Steps
1. [subtask retry=2 adaptive] Adaptive task
  + → final_out: text  # aggregated output
  1.1. [act] Original plan
    + → task_out: text  # output
`;

  // 升级阶梯（^anc-exec-retry-adaptive）：retry=N 总失败预算，第 1 次失败=带反馈重跑（step_ready
  // 重跑 1.1），第 2 次起才 adaptive_needed。故需失败两次才进重规划。
  it('first failure triggers informed retry (re-run), not adaptive', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.failStep('1.1', 'plan failed once');

    // 第 1 次失败 → 带反馈重跑：返回 step_ready 重跑 1.1，而非 adaptive_needed
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    if (r.status === 'step_ready') expect(r.step_id).toBe('1.1');

    // 重跑步骤的 context 应含 L2c 重试反馈（上次失败说明）
    if (r.status === 'step_ready') {
      expect(r.context.retry_feedback).toContain('plan failed once');
    }
  });

  // 网络类失败的 L2c 渲染分流（2026-08-23 作者定——"针对此修正"引导会让 LLM 试图"修正"
  // 网络故障改坏产物;NETWORK_ERROR: 前缀由 dispatcher 网络耗尽点挂）
  // @v: anc-exec-api-retry
  it('正例：NETWORK_ERROR 前缀失败 → L2c 渲染"照常执行"不渲染"针对此修正"；反例：普通失败照旧', () => {
    const e1 = new ExecutionEngine();
    e1.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG);
    e1.nextStep();
    e1.failStep('1.1', 'NETWORK_ERROR: 网络中断（非内容问题——与产出质量无关,原文: terminated）');
    const r1 = e1.nextStep();
    expect(r1.status).toBe('step_ready');
    if (r1.status === 'step_ready') {
      expect(r1.context.retry_feedback).toContain('照常执行即可');
      expect(r1.context.retry_feedback).toContain('照常执行');   // 网络形态自带措辞(纯化后判定形态的框架句移渲染段,本断言改正向)
    }

    const e2 = new ExecutionEngine();
    e2.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG);
    e2.nextStep();
    e2.failStep('1.1', 'CHECK_FAILED: 内容缺口');
    const r2 = e2.nextStep();
    if (r2.status === 'step_ready') {
      // L5 修正指令工单形态（^anc-exec-l2c-retry-feedback 2026-08-24 重写）：
      // 意见原文在场且 CHECK_FAILED 记账前缀被剥（受众公理禁令 2）
      expect(r2.context.retry_feedback).toContain('内容缺口');
      expect(r2.context.retry_feedback).not.toContain('照常执行');   // 判定打回=意见本体(框架句在渲染段,fb 不再含'逐条落实')
      expect(r2.context.retry_feedback).not.toContain('CHECK_FAILED');
    }
  });

  // 缺省日志 debug 级 + call 子实例级别继承（2026-08-23 作者定"把缺省日志全部调成 debug 级"——
  // 两撞:standalone info 黑箱/dr9 走查被 info 级 200 字截断制造观测幻象〔skeleton 真值 7 步日志
  // 显示 2 步,闸门被误判失灵〕;子实例原不继承,顶层 debug 递归全 info——构建主体恰是黑箱）
  // @v: anc-obs-log-levels
  it('正例：不传 logLevel → hoplog 缺省 debug（main.yaml 头 level: debug）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-default-'));
    const engine = new ExecutionEngine();
    engine.initExecution('# T\nId: t\n## Goal\ng\n## Outputs\n- o: text  # x\n## Steps\n1. [reason] r\n  + → o: text  # x\n', MINIMAL_HOST_CONFIG, { logDir: dir });
    expect(readFileSync(join(engine.getHopLog()!.getRunDir(), 'main.yaml'), 'utf-8')).toMatch(/^level: debug$/m);
  });

  it('反例：显式降级 info 仍生效（降级通道不被缺省覆盖）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-explicit-'));
    const engine = new ExecutionEngine();
    engine.initExecution('# T\nId: t\n## Goal\ng\n## Outputs\n- o: text  # x\n## Steps\n1. [reason] r\n  + → o: text  # x\n', MINIMAL_HOST_CONFIG, { logDir: dir, logLevel: 'info' });
    expect(readFileSync(join(engine.getHopLog()!.getRunDir(), 'main.yaml'), 'utf-8')).toMatch(/^level: info$/m);
  });

  // L2c 有界累计史（2026-08-23 升级——多约束节点每攻只见最后一条失败,修东墙拆西墙打地鼠:
  // ppt11 三面墙/dr7 两缺口同型实撞;最近一条全文+此前压缩行 5 条封顶） // @v: anc-exec-l2c-retry-feedback
  it('正例：多次失败后反馈带累计史——最近一条全文+此前压缩行;超 5 条丢最旧', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC.replace('retry=2 adaptive', 'retry=8'), MINIMAL_HOST_CONFIG);
    for (let i = 1; i <= 6; i++) {
      engine.nextStep();
      engine.failStep('1.1', `第${i}墙:缺口${i}`);
    }
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    if (r.status === 'step_ready') {
      const fb = r.context.retry_feedback!;
      expect(fb).toContain('第6墙:缺口6');            // 最近一条全文
      expect(fb).toContain('此前已被打回过的意见');     // 累计史区块在场（人话陈列,2026-08-24 去记账化）
      expect(fb).toContain('第2墙:缺口2');             // 回溯 4 条的最旧一条(第2)在
      expect(fb).not.toContain('第1墙:缺口1');         // 超界丢最旧
    }
  });

  // 历史行单条 4000（v0.7.1 作者定"800 也太少"——dr16 实测工单全文 max 3101,旧 200 切行
  // 把多项工单剩开头一截,'一次看全所有已撞过的墙'在历史条目上没兑现） // @v: anc-exec-l2c-retry-feedback
  it('正例：大体量历史意见（3000+ chars）整条存活进累计史——末项工单不被切行', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC.replace('retry=2 adaptive', 'retry=8'), MINIMAL_HOST_CONFIG);
    const bigOrder = '多项工单:' + Array.from({ length: 6 }, (_, i) => `缺陷${i + 1}:` + 'x'.repeat(450)).join(';');
    engine.nextStep();
    engine.failStep('1.1', bigOrder);              // 3000+ chars 的首轮工单
    engine.nextStep();
    engine.failStep('1.1', '第2轮:新缺口');
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    if (r.status === 'step_ready') {
      const fb = r.context.retry_feedback!;
      expect(fb).toContain('缺陷6:');               // 旧 200 切行下必丢的历史末项存活
    }
  });

  it('正例：跨层反馈——外层意见闸失败重跑,内层步骤反馈含外层意见与内层机械史（D39 两层分层的通路）', () => {
    const TWO_LAYER = `# TL
Id: tl
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=3] 意见轮
  + → out: text  # o
  1.1. [subtask retry=4] 机械层
    + → out: text  # 草稿
    1.1.1. [reason] 造
      + → out: text  # d
    1.1.2. [check] 机械关
      - ← out
      + → m_ok: bool  # 过
      + → m_note: text  # 缺
  1.2. [ask] 终审
    - ← out
    + → fb: text  # 意见
  1.3. [check final] 意见闸
    - ← fb
    + → ok: bool  # 过
    + → note: text  # 意见
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(TWO_LAYER, MINIMAL_HOST_CONFIG);
    engine.nextStep(); engine.completeStep('1.1.1', { out: 'v1' });
    engine.nextStep(); engine.failStep('1.1.2', 'CHECK_FAILED: 机械缺陷A');   // 内层消化
    engine.nextStep(); engine.completeStep('1.1.1', { out: 'v2' });
    engine.nextStep(); engine.completeStep('1.1.2', { m_ok: true, m_note: '' });
    engine.nextStep(); engine.completeStep('1.2', { fb: '打回意见X' });
    engine.nextStep(); engine.failStep('1.3', 'CHECK_FAILED: 打回意见X');     // 外层意见轮
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    if (r.status === 'step_ready') {
      expect(r.step_id).toBe('1.1.1');                                // 整个外层带反馈重跑
      const fb = r.context.retry_feedback!;
      expect(fb).toContain('打回意见X');                               // 外层作者意见到达内层现场
      expect(fb).toContain('机械缺陷A');                               // 内层旧机械史也在（别再犯清单）
    }
  });

  // call 边界反馈传递（D41——作者点破"L2c 的本质是 call 的 fail 原因没有反馈":call 不经
  // PromptAssembler,父层重试反馈对 call 子实例天然不可见,外层意见轮重跑时重拆现场全盲）
  // @v: anc-exec-l2c-retry-feedback
  it('正例：upstreamFeedback 经 EngineOptions 传入 → 子实例全步骤 prompt 渲染 L2b 上游反馈区块', () => {
    const CALLEE = `# S
Id: sub
## Goal
g
## Outputs
- o: text  # x
## Steps
1. [reason] 子内步骤
  + → o: text  # x
`;
    const ce = new ExecutionEngine();
    ce.initExecution(CALLEE, MINIMAL_HOST_CONFIG, { upstreamFeedback: '第 1 次打回：产物有六个假body,打回' });
    const r = ce.nextStep();
    expect(r.status).toBe('step_ready');
    if (r.status === 'step_ready') {
      expect(r.context.upstream_feedback).toContain('假body');
      const txt = formatPromptText(r.context, 'reason');
      // L5 修正指令区块（全 HopSchema 化后上游反馈=条目 - 上游修正意见: text =|）
      expect(txt).toContain('L5. 修正指令');
      expect(txt).toContain('上游修正意见');   // 全 HopSchema 化后=条目名
      expect(txt).toContain('假body');
    }
  });

  it('反例：未传 upstreamFeedback 的实例 → 无 L2b 区块（顶层 run 不白占 token）', () => {
    const CALLEE = `# S
Id: sub
## Goal
g
## Outputs
- o: text  # x
## Steps
1. [reason] 子内步骤
  + → o: text  # x
`;
    const ce = new ExecutionEngine();
    ce.initExecution(CALLEE, MINIMAL_HOST_CONFIG);
    const r = ce.nextStep();
    if (r.status === 'step_ready') {
      expect(r.context.upstream_feedback).toBeUndefined();
      expect(formatPromptText(r.context, 'reason')).not.toContain('L5. 修正指令');
    }
  });

  it('反例：首次失败后重跑只有单条反馈——无累计史区块（不白占 token）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1', 'plan failed once');
    const r = engine.nextStep();
    if (r.status === 'step_ready') {
      expect(r.context.retry_feedback).toContain('plan failed once');
      expect(r.context.retry_feedback).not.toContain('此前已被打回过的意见');
    }
  });

  // L2c 重试反馈落账 hoplog（info 级流控字段——2026-08-22 补:只藏在 debug 级 prompt 全文里时,
  // info 日志让走查者误判"重试无记忆",ppt11 实撞） // @v: anc-exec-l2c-retry-feedback
  it('正例：带反馈重跑的步骤在 info 级 hoplog 落 retry_feedback 字段（attempt+reason）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hopjit-l2cfb-'));
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG, { logDir: join(stateDir, '.hoplog'), logLevel: 'info' });
    engine.nextStep();
    engine.failStep('1.1', 'plan failed once');
    engine.nextStep();   // 带反馈重跑 1.1 → recordStepStart 后 flushRetryFeedbackMeta 落账
    const text = readFileSync(join(engine.getHopLog()!.getRunDir(), 'main.yaml'), 'utf-8');
    expect(text).toContain('retry_feedback:');
    expect(text).toContain('plan failed once');
  });

  it('反例：首跑（无重试历史）hoplog 不出现 retry_feedback 字段', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hopjit-l2cfb-first-'));
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG, { logDir: join(stateDir, '.hoplog'), logLevel: 'info' });
    engine.nextStep();   // 首跑 1.1
    const text = readFileSync(join(engine.getHopLog()!.getRunDir(), 'main.yaml'), 'utf-8');
    expect(text).not.toContain('retry_feedback:');
  });

  it('returns adaptive_needed after second failure in adaptive subtask', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.failStep('1.1', 'plan failed');
    engine.nextStep();              // 第 1 次失败 → 带反馈重跑（step_ready）
    engine.failStep('1.1', 'plan failed again');

    const r = engine.nextStep();    // 第 2 次失败 → adaptive_needed
    expect(r.status).toBe('adaptive_needed');
    if (r.status === 'adaptive_needed') {
      expect(r.subtask_id).toBe('1');
      expect(r.failure.reason).toBe('plan failed again');
      expect(r.subtask_contract.outputs).toHaveLength(1);
      expect(r.retry_history).toHaveLength(2);
    }
  });

  // @v: anc-exec-state-persistence
  // 跨进程 replan 回归(实证 bug:saveSnapshot 漏写 spec.json,replan 改的 AST 跨进程丢失)。
  // 现有 replan 测试全同进程、看内存 this.spec 永远对,故漏了这个。本测试用 stateDir + load 重建
  // 模拟跨进程:replan 后另起引擎 load,断言重建的 AST 含 replan 的新 children。
  it('persists replanned AST across process boundary (load rebuilds new children)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'replan-xproc-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG, { stateDir });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    e1.nextStep(); e1.failStep('1.1', 'fail1');
    e1.nextStep(); e1.failStep('1.1', 'fail2');
    e1.nextStep(); // adaptive_needed
    // replan 换成 2 步结构(原来 1 步)
    const replanMd = `1. [act] step one\n  + → mid: text  # m\n2. [act] step two\n  - ← mid\n  + → final_out: text  # covers output\n`;
    expect(e1.submitReplan('1', replanMd).status).toBe('ok');

    // 另起引擎 load(模拟下一进程)——读 spec.json 重建 AST
    const instanceDir = join(stateDir, init.instance_id);
    const e2 = ExecutionEngine.load(instanceDir);
    const sub = e2.getSpec()!.steps.find(s => s.step_id === '1')!;
    expect(sub.children).toHaveLength(2);                  // bug 时这里是 1(原始,replan 丢失)
    expect(sub.children.map(c => c.step_id)).toEqual(['1.1', '1.2']);
  });

  // @v: anc-exec-doc-ref-resolve, anc-exec-state-persistence
  // 跨进程 doc-ref 回归(实证 bug:hostConfig 不持久化,load 后 hostConfig=null,
  // doc-ref 在复用模式每个 submit_and_fetch_next fresh process 恒失效→doc_ref_context 空)。
  // 修复:host_context(workspace+sandbox)进 state.json,load 重建,doc-ref 跨进程生效。
  it('persists host_context so doc-ref resolves across process boundary', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'docref-xproc-'));
    const wsDir = mkdtempSync(join(tmpdir(), 'docref-ws-'));
    writeFileSync(join(wsDir, 'kb.md'), '# KB\n\n## 二、色板\n主色 #003BFF。\n');
    const host: HostConfig = {
      workspace_dir: wsDir,
      sandbox: { filesystem: { workspace_dir: wsDir, read_access: { allowed: [wsDir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'test',
    };
    const spec = `# DocRef Xproc
## Goal
test
## Outputs
- r: text  # o
## Steps
1. [reason] s1
  + → r: text  # r
  > 参照 [[kb#二、色板]]
`;
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(spec, host, { stateDir });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;

    // 另起引擎 load(模拟下一个 submit_and_fetch_next 进程)——hostConfig 须从 state.json 恢复
    const e2 = ExecutionEngine.load(join(stateDir, init.instance_id));
    const step = e2.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status === 'step_ready') {
      expect(step.context.doc_ref_context).toContain('#003BFF');  // bug 时为空
    }
  });

  // @v: anc-exec-state-persistence
  // 跨进程失败原因回归(实证 bug:getFailureReason 旧实现读内存事件流,跨进程蒸发→"Unknown failure")。
  // 修复:失败原因进 state.json 的 step_fail_reasons,load 重建后 getFailureReason 仍返回真实原因。
  it('persists step failure reason across process boundary (not "Unknown failure")', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'failreason-xproc-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { source: 's' } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    e1.nextStep();
    e1.failStep('1', '格式探测失败：无法识别分隔符');  // 顶层步骤失败(retry_history 够不到)

    // 另起引擎 load(模拟下一个 submit_and_fetch_next 进程)——内存 execEvents 为空
    const instanceDir = join(stateDir, init.instance_id);
    const e2 = ExecutionEngine.load(instanceDir);
    // 裸失败不停车:剩余步骤照常跑完,终态才回 failed
    let r = e2.nextStep();
    const outs: Record<string, Record<string, unknown>> = { '2': { transformed: 't' }, '3': { result: 'r' } };
    while (r.status === 'step_ready') {
      e2.completeStep(r.step_id, outs[r.step_id] ?? {});
      r = e2.nextStep();
    }
    const final = r;
    expect(final.status).toBe('failed');
    if (final.status === 'failed') {
      expect(final.failed_step_id).toBe('1');
      expect(final.failure_reason).toBe('格式探测失败：无法识别分隔符');  // bug 时这里是 'Unknown failure'
    }
  });

  // @v: anc-exec-state-persistence
  // 跨进程执行事件流回归:exec_events 进 state.json,load 重建后非空(L3 iteration_history/subtaskProgress 原料)。
  it('persists exec events across process boundary (L3 context raw material survives)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'execevents-xproc-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { source: 's' } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    e1.nextStep();
    e1.completeStep('1', { analysis: 'a' });

    const instanceDir = join(stateDir, init.instance_id);
    const e2 = ExecutionEngine.load(instanceDir);
    const events = e2.getExecEvents();
    expect(events.length).toBeGreaterThan(0);  // bug 时跨进程为空 []
    expect(events.some(e => e.step_id === '1' && e.event === 'step_done')).toBe(true);
  });

  // @v: anc-obs-replan-audit
  it('AdaptiveNeeded carries spec_id (sedimentation binding)', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep(); engine.failStep('1.1', 'f1');
    engine.nextStep(); engine.failStep('1.1', 'f2');
    const r = engine.nextStep();
    expect(r.status).toBe('adaptive_needed');
    if (r.status === 'adaptive_needed') expect(r.spec_id).toBe('adaptive-test');
  });

  it('submitReplan replaces children and resumes execution', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.failStep('1.1', 'plan failed');
    engine.nextStep(); // 第1次失败 → 带反馈重跑
    engine.failStep('1.1', 'plan failed again');
    engine.nextStep(); // 第2次失败 → adaptive_needed

    const replanMd = `1. [act] New approach
  + → final_out: text  # covers subtask output
`;
    const result = engine.submitReplan('1', replanMd);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.new_children).toHaveLength(1);
      expect(result.new_children[0].step_id).toBe('1.1');
    }

    // Resume execution with new plan
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.1');
    engine.completeStep('1.1', { final_out: 'replanned' });

    const final = engine.nextStep();
    expect(final.status).toBe('completed');
  });

  it('submitReplan rejects when outputs not covered', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.failStep('1.1', 'fail');
    engine.nextStep();              // 带反馈重跑
    engine.failStep('1.1', 'fail again');
    engine.nextStep();             // adaptive_needed

    const badMd = `1. [act] Missing output step
  + → wrong_name: text  # wrong output name
`;
    const result = engine.submitReplan('1', badMd);
    expect(result.status).toBe('error');
  });

  it('submitReplan rejects when not in adaptive_needed state', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG);

    const result = engine.submitReplan('1', '1. [act] x\n  + → out: text  # o\n');
    expect(result.status).toBe('error');
  });

  it('submitReplan rejects non-existent subtask ID', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.failStep('1.1', 'fail');
    engine.nextStep();              // 带反馈重跑
    engine.failStep('1.1', 'fail again');
    engine.nextStep(); // adaptive_needed

    // Force adaptive state to point to a non-existent ID
    (engine as any).adaptiveNeededSubtask = 'nonexistent';
    const result = engine.submitReplan('nonexistent', '1. [act] x\n  + → out: text  # o\n');
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe(ErrorCode.INVALID_STEP_ID);
    }
  });

  it('submitReplan rejects empty steps', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.failStep('1.1', 'fail');
    engine.nextStep();              // 带反馈重跑
    engine.failStep('1.1', 'fail again');
    engine.nextStep(); // adaptive_needed

    const emptyMd = '';
    const result = engine.submitReplan('1', emptyMd);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe(ErrorCode.VALIDATION_ERROR);
    }
  });
});

describe('selectBranch', () => {
  const BRANCH_SPEC = `# Branch Select
Id: branch-select

## Goal
Test manual branch selection

## Inputs
- mode: text  # input

## Outputs
- out: text  # output

## Steps
1. [branch] Choose path
  1.1. [case] {mode}==fast
    1.1.1. [act] Fast path
      + → out: text  # output
  1.2. [case] {mode}==slow
    1.2.1. [act] Slow path
      + → out: text  # output
`;

  it('overrides automatic condition evaluation', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(BRANCH_SPEC, MINIMAL_HOST_CONFIG);

    // mode is undefined, so neither condition matches normally
    // Manual override selects case 1.2
    const result = engine.selectBranch('1', '1.2', 'user chose slow');
    expect(result.status).toBe('ok');

    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
    if (s.status === 'step_ready') expect(s.step_id).toBe('1.2.1');
  });

  it('returns error for invalid branch step', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(BRANCH_SPEC, MINIMAL_HOST_CONFIG);

    const result = engine.selectBranch('99', '1.1');
    expect(result.status).toBe('error');
    expect(result.code).toBe(ErrorCode.INVALID_STEP_ID);
  });

  it('returns error for invalid case id', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(BRANCH_SPEC, MINIMAL_HOST_CONFIG);

    const result = engine.selectBranch('1', '1.99');
    expect(result.status).toBe('error');
    expect(result.code).toBe(ErrorCode.INVALID_STEP_ID);
  });
});

// @v: anc-exec-completeness, anc-exec-variable-store
describe('Nested containers', () => {
  it('subtask inside loop completes correctly', () => {
    const spec = `# Nested Test
Id: nested

## Goal
Nested containers

## Outputs
- out: text  # output

## Steps
1. [loop max_iterations=2] Outer loop
  1.1. [subtask] Inner task
    1.1.1. [act] Do thing
      + → out: text  # output

2. [act] After
  + → out: text  # final
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    // Iteration 1
    const s1 = engine.nextStep();
    expect(s1.status).toBe('step_ready');
    if (s1.status === 'step_ready') expect(s1.step_id).toBe('1.1.1');
    engine.completeStep('1.1.1', { out: 'iter1' });

    // Iteration 2
    const s2 = engine.nextStep();
    expect(s2.status).toBe('step_ready');
    if (s2.status === 'step_ready') expect(s2.step_id).toBe('1.1.1');
    engine.completeStep('1.1.1', { out: 'iter2' });

    // After loop
    const s3 = engine.nextStep();
    expect(s3.status).toBe('step_ready');
    if (s3.status === 'step_ready') expect(s3.step_id).toBe('2');
  });
});

// @v: anc-exec-container-output
describe('Container output promotion', () => {
  it('subtask outputs are accessible to subsequent steps', () => {
    const spec = `# Subtask Output
Id: subtask-output

## Goal
Test output promotion

## Outputs
- report: text  # output

## Steps
1. [subtask] Produce data
  + → data: text  # subtask output
  1.1. [act] Generate
    + → data: text  # data

2. [reason] Consume subtask output
  - ← data
  + → report: text  # report
  > Use data
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1.1', { data: 'hello from subtask' });

    const s2 = engine.nextStep();
    expect(s2.status).toBe('step_ready');
    if (s2.status === 'step_ready') {
      expect(s2.context.inputs['data']).toBe('hello from subtask');
    }
  });

  it('parallel outputs are accessible to subsequent steps', () => {
    const spec = `# Parallel Output
Id: parallel-output

## Goal
Test parallel output promotion

## Outputs
- combined: text  # output

## Steps
1. [subtask] Boundary
  + → a_result: text  # from A
  + → b_result: text  # from B
  1.1. [subtask parallel] Analysis A
    + → a_result: text  # from A
    1.1.1. [reason] Analysis A
      + → a_result: text  # A
      > Analyze A
  1.2. [subtask parallel] Analysis B
    + → b_result: text  # from B
    1.2.1. [reason] Analysis B
      + → b_result: text  # B
      > Analyze B

2. [reason] Combine
  - ← a_result, b_result
  + → combined: text  # combined
  > Combine results
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');

    engine.nextStep();
    engine.completeStep('1.1.1', { a_result: 'from A' });

    engine.nextStep();
    engine.completeStep('1.2.1', { b_result: 'from B' });

    const s2 = engine.nextStep();
    expect(s2.status).toBe('step_ready');
    if (s2.status === 'step_ready') {
      expect(s2.context.inputs['a_result']).toBe('from A');
      expect(s2.context.inputs['b_result']).toBe('from B');
    }
  });

  it('loop outputs are accessible after loop completes', () => {
    const spec = `# Loop Output
Id: loop-output

## Goal
Test loop output promotion

## Outputs
- result: text  # output

## Steps
1. [loop max_iterations=2] Process
  + → last_item: text  # 延续变量：取末轮值
  1.1. [act] Work
    - ← last_item
    + → last_item

2. [reason] After loop
  - ← last_item
  + → result: text  # result
  > Use loop output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);

    engine.nextStep();
    engine.completeStep('1.1', { last_item: 'iter1' });

    engine.nextStep();
    engine.completeStep('1.1', { last_item: 'iter2' });

    const s2 = engine.nextStep();
    expect(s2.status).toBe('step_ready');
    if (s2.status === 'step_ready') {
      expect(s2.context.inputs['last_item']).toBe('iter2');
    }
  });
});

// @v: anc-config-resource-limits
describe('HostConfig with resource_limits', () => {
  it('accepts config with resource_limits without error', () => {
    const engine = new ExecutionEngine();
    const config: HostConfig = {
      workspace_dir: '/tmp/test',
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'test-key',
      resource_limits: {
        max_tool_iterations: 20,
        max_context_tokens: 100000,
        max_output_tokens: 4096,
        max_replan_attempts: 3,
        timeout_seconds: 300,
      },
    };
    const result = engine.initExecution(THREE_STEP_SPEC, config, { params: { source: 's' } });
    expect(result.status).toBe('ok');
  });
});

// @v: anc-step-act-sandbox-constraint
describe('Act step sandbox constraint', () => {
  it('act steps exist with sandbox-constrained semantics', () => {
    const spec = `# Sandbox Act
Id: sandbox-act

## Goal
Test act step sandbox

## Steps
1. [act] Do file operations
  + → result: text  # outcome
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    const step = engine.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status === 'step_ready') {
      expect(step.step_type).toBe('act');
    }
  });
});

describe('nextStep none result handler', () => {
  it('returns failed when branch has no matching case', () => {
    const spec = `# Branch Deadlock
Id: deadlock-test

## Goal
Test no matching case

## Inputs
- mode: text  # selection

## Outputs
- out: text  # output

## Steps
1. [branch] Choose
  1.1. [case] {mode}==alpha
    1.1.1. [act] Alpha path
      + → out: text  # output
  1.2. [case] {mode}==beta
    1.2.1. [act] Beta path
      + → out: text  # output
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { mode: null } });   // 显式空值过顶层必填闸,语义仍是"无命中"

    // Branch 无 case 命中→静默跳过（done 不写值）→ 声明输出 out 未赋值 →
    // 完备性闸判 failed。 // @v: anc-exec-output-completeness （2026-08-17——旧契约此处 completed
    // + undefined 输出即"假绿"原型形态,契约变更后本测试随判据翻转）
    const r = engine.nextStep();
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.failure_reason).toContain('out');
      expect(r.failure_reason).toContain('never assigned');
    }
  });

  // 2026-08-10 作者定（Python 语义）：无命中=不写值——接口变量有旧值时按自然保留读旧值，
  // 引擎不得隐式抹成 null（原"聚合输出写 None"废）。正反例成对：上例钉"未产出读 None"，
  // 本例钉"有旧值保留"。
  it('branch no-match preserves pre-existing variable value (natural retention)', () => {
    const spec = `# No Match Retention
Id: no-match-retention

## Goal
Test branch no-match does not clobber prior value

## Inputs
- mode: text  # selection

## Outputs
- verdict: text  # final verdict

## Steps
1. [act] 预置结论
  + → verdict: text  # 前序产出的结论
2. [branch] 尝试改写结论
  + → verdict: text  # 统一接口（同名再赋值）
  2.1. [case(mode == alpha)] alpha 路径
    + → verdict: text  # 同名填充
    2.1.1. [act] 改写
      + → verdict
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, { ...MINIMAL_HOST_CONFIG, workspace_dir: MINIMAL_HOST_CONFIG.workspace_dir }, { params: { mode: null } });   // 显式空值过顶层必填闸
    const r1 = engine.nextStep();
    expect(r1.status).toBe('step_ready');
    engine.completeStep('1', { verdict: 'from-step-1' });
    // mode 无值 → case 不命中 → branch 静默跳过；verdict 必须保留 step 1 的值
    const r2 = engine.nextStep();
    expect(r2.status).toBe('completed');
    if (r2.status === 'completed') {
      expect(r2.outputs.verdict).toBe('from-step-1');
    }
  });
});

describe('VariableStore', () => {
  describe('findScope', () => {
    it('returns root scope for unknown id', () => {
      const store = new VariableStore({ x: 1 });
      const scope = store.findScope('nonexistent');
      expect(scope.id).toBe('root');
    });

    it('returns named scope when it exists', () => {
      const store = new VariableStore();
      store.createScope('child', 'root');
      const scope = store.findScope('child');
      expect(scope.id).toBe('child');
    });
  });

  describe('writeOutputs', () => {
    it('writes multiple outputs to scope', () => {
      const store = new VariableStore();
      store.writeOutputs({ a: 'hello', b: 42 }, 'root');
      expect(store.read('a', 'root')).toBe('hello');
      expect(store.read('b', 'root')).toBe(42);
    });

    it('writes to child scope', () => {
      const store = new VariableStore();
      store.createScope('s1', 'root');
      store.writeOutputs({ x: 'val' }, 's1');
      expect(store.read('x', 's1')).toBe('val');
      expect(store.read('x', 'root')).toBeUndefined();
    });
  });

  describe('toJSON with multiple scopes', () => {
    // @v: anc-exec-vars-scope-persist
    it('serializes full scope tree (v2)', () => {
      const store = new VariableStore({ root_var: 'rv' });
      store.createScope('s1', 'root');
      store.write('child_var', 'cv', 's1');
      const json = store.toJSON();
      // v2：按 scope 归属，不拍平
      expect(json.root.variables['root_var']).toBe('rv');
      expect(json.s1.variables['child_var']).toBe('cv');
      expect(json.s1.parent).toBe('root');
    });
  });
});

describe('engine small gaps', () => {
  describe('submitReplan parse error', () => {
    it('returns PARSE_ERROR for malformed markdown', () => {
      const spec = `# Subtask
Id: replan-parse
## Goal
Test
## Outputs
- out: text  # output
## Steps
1. [subtask] Do work
  retry: 1
  1.1. [reason] Try
    + → out: text  # output
    > Do it
`;
      const engine = new ExecutionEngine();
      engine.initExecution(spec, MINIMAL_HOST_CONFIG);
      engine.nextStep();
      engine.failStep('1.1', 'broke');
      // Force adaptive state
      (engine as any).adaptiveNeededSubtask = '1';

      const result = engine.submitReplan('1', '1. [invalid_type] Bad\n  > nope');
      expect(result.status).toBe('error');
    });
  });

  describe('selectBranch state guard', () => {
    it('rejects branch in done state', () => {
      const spec = `# Branch
Id: branch-guard
## Goal
Test
## Inputs
- mode: text  # input
## Outputs
- out: text  # output
## Steps
1. [branch] Choose
  1.1. [case] {mode}==a
    1.1.1. [reason] A
      + → out: text  # output
      > A
  1.2. [case] {mode}==b
    1.2.1. [reason] B
      + → out: text  # output
      > B
`;
      const engine = new ExecutionEngine();
      engine.initExecution(spec, MINIMAL_HOST_CONFIG);
      // Force branch to done state
      (engine as any).stepStates.set('1', 'done');
      const result = engine.selectBranch('1', '1.1', 'test');
      expect(result.status).toBe('error');
      expect((result as any).code).toBe(ErrorCode.INVALID_STATE);
    });
  });

  describe('resume restores counters', () => {
    it('preserves retry and loop counters through persist/resume', () => {
      const loopSpec = `# Loop
Id: loop-resume
## Goal
Test
## Outputs
- out: text  # output
## Steps
1. [loop] Repeat 3 times
  max: 3
  1.1. [reason] Iteration
    + → out: text  # output
    > Do it
`;
      const stateDir = mkdtempSync(join(tmpdir(), 'engine-resume-'));
      const engine = new ExecutionEngine();
      engine.initExecution(loopSpec, MINIMAL_HOST_CONFIG, { stateDir });

      // Complete first iteration — loop resets child to pending for next iter
      engine.nextStep();
      engine.completeStep('1.1', { out: 'iter1' });

      // Verify loop counter incremented
      expect(engine.getLoopCounters().get('1')).toBe(2);

      const instanceDir = (engine as any).instanceDir;

      // Resume and verify loop counter persisted
      const resumed = ExecutionEngine.load(instanceDir);
      expect(resumed.getLoopCounters().get('1')).toBe(2);

      // Next step should be the second iteration of 1.1
      const next = resumed.nextStep();
      expect(next.status).toBe('step_ready');
    });

    it('preserves retry counters through persist/resume', () => {
      const retrySpec = `# Retry
Id: retry-resume
## Goal
Test
## Outputs
- out: text  # output
## Steps
1. [subtask retry=3] Do retryable work
  + → out: text  # output
  1.1. [act] Work
    + → work_result: text  # work
`;
      const stateDir = mkdtempSync(join(tmpdir(), 'engine-retry-resume-'));
      const engine = new ExecutionEngine();
      engine.initExecution(retrySpec, MINIMAL_HOST_CONFIG, { stateDir });

      // Start and fail step — triggers retry, decrements counter
      engine.nextStep();
      engine.failStep('1.1', 'transient error');

      // After first failure, retry counter should be decremented
      const counters = (engine as any).retryCounters as Map<string, number>;
      const remaining = counters.get('1');
      expect(remaining).toBeDefined();
      expect(remaining).toBeLessThan(3);

      const instanceDir = (engine as any).instanceDir;

      // Resume and verify retry counter persisted
      const resumed = ExecutionEngine.load(instanceDir);
      const resumedCounters = (resumed as any).retryCounters as Map<string, number>;
      expect(resumedCounters.get('1')).toBe(remaining);
    });
  });
});

// ============================================================
// @v: anc-exec-completeness
// P0-1: check-finally preservation validation
// ============================================================

describe('submitReplan check-finally preservation', () => {
  const ADAPTIVE_WITH_CHECK_SPEC = `# Adaptive Check Test
Id: adaptive-check

## Goal
Test check preservation in replan

## Outputs
- final_result: text  # output

## Steps
1. [subtask retry=2 adaptive] Task with check
  + → final_result: text  # output
  1.1. [act] Do work
    + → work_out: text  # work
  1.2. [check] Verify work
    + → check_ok: bool  # verdict
    + → final_result: text  # verified note
`;

  const ADAPTIVE_WITH_CHECK_FINALLY_SPEC = `# Adaptive Check Finally
Id: adaptive-check-finally

## Goal
Test check final preservation in replan

## Outputs
- final_result: text  # output

## Steps
1. [subtask retry=2 adaptive] Task with check final
  + → final_result: text  # output
  1.1. [act] Do work
    + → work_out: text  # work
  1.2. [check final] Verify constraints
    + → check_ok: bool  # verdict
    + → final_result: text  # verified note
`;

  // 升级阶梯：第1次失败=带反馈重跑，第2次失败才 adaptive_needed（^anc-exec-retry-adaptive）
  function setupAdaptiveNeeded(spec: string) {
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    engine.nextStep(); // step_ready for 1.1
    engine.failStep('1.1', 'failed');
    engine.nextStep(); // 第1次失败 → 带反馈重跑
    engine.failStep('1.1', 'failed again');
    engine.nextStep(); // 第2次失败 → adaptive_needed
    return engine;
  }

  it('rejects replan that removes check step', () => {
    const engine = setupAdaptiveNeeded(ADAPTIVE_WITH_CHECK_SPEC);

    const noCheckMd = `1. [act] New approach
  + → final_result: text  # output
`;
    const result = engine.submitReplan('1', noCheckMd);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(result.errors[0].message).toContain('check');
    }
  });

  it('rejects replan that removes check final step', () => {
    const engine = setupAdaptiveNeeded(ADAPTIVE_WITH_CHECK_FINALLY_SPEC);

    // Has a check but not a check-finally at end
    const noFinallyMd = `1. [act] New approach
  + → work_out: text  # work
2. [check] Regular check
  + → check_ok: bool  # verdict
  + → final_result: text  # output
`;
    const result = engine.submitReplan('1', noFinallyMd);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(result.errors[0].message).toContain('check final');
    }
  });

  it('rejects replan with check final not at end', () => {
    const engine = setupAdaptiveNeeded(ADAPTIVE_WITH_CHECK_FINALLY_SPEC);

    // check-finally is not the last step
    const wrongOrderMd = `1. [check final] Verify constraints
  + → check_ok: bool  # verdict
  + → check_out: text  # check note
2. [act] Do work after check-finally
  + → final_result: text  # output
`;
    const result = engine.submitReplan('1', wrongOrderMd);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(result.errors[0].message).toContain('check final');
    }
  });

  it('accepts replan that preserves check step', () => {
    const engine = setupAdaptiveNeeded(ADAPTIVE_WITH_CHECK_SPEC);

    const withCheckMd = `1. [act] New approach
  + → work_out: text  # work
2. [check] Verify new approach
  + → check_ok: bool  # verdict
  + → final_result: text  # output
`;
    const result = engine.submitReplan('1', withCheckMd);
    expect(result.status).toBe('ok');
  });

  it('accepts replan that preserves check final at end', () => {
    const engine = setupAdaptiveNeeded(ADAPTIVE_WITH_CHECK_FINALLY_SPEC);

    const withFinallyMd = `1. [act] New approach
  + → work_out: text  # work
2. [check final] Verify constraints
  + → check_ok: bool  # verdict
  + → final_result: text  # verified
`;
    const result = engine.submitReplan('1', withFinallyMd);
    expect(result.status).toBe('ok');
  });
});

// ============================================================
// P0-2: replan circuit breaker
// ============================================================

describe('submitReplan circuit breaker', () => {
  const ADAPTIVE_SPEC_CB = `# Adaptive CB
Id: adaptive-cb

## Goal
Test replan circuit breaker

## Outputs
- final_out: text  # output

## Steps
1. [subtask retry=8 adaptive] Repeating task
  + → final_out: text  # output
  1.1. [act] Original plan
    + → task_out: text  # output
`;

  // 升级阶梯：首次失败=带反馈重跑。首个 adaptive_needed 需失败两次（见 triggerInitialAdaptive）；
  // 此后子树已进入 attemptsUsed≥2，单次失败即再次 adaptive_needed。
  function triggerInitialAdaptive(engine: ExecutionEngine) {
    engine.nextStep(); // step_ready 1.1
    engine.failStep('1.1', 'fail 1');
    engine.nextStep(); // 第1次失败 → 带反馈重跑
    engine.failStep('1.1', 'fail 2');
    engine.nextStep(); // 第2次失败 → adaptive_needed
  }

  function triggerAdaptiveNeeded(engine: ExecutionEngine) {
    // 首个 adaptive 已达成后，子树 attemptsUsed≥2，单次失败即再次 adaptive_needed
    const next = engine.nextStep();
    if (next.status === 'step_ready') {
      engine.failStep(next.step_id, 'failed attempt');
      engine.nextStep(); // get adaptive_needed
    }
  }

  it('rejects 4th replan attempt (exceeds limit of 3)', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC_CB, MINIMAL_HOST_CONFIG);

    // Trigger first adaptive（需失败两次，见升级阶梯）
    triggerInitialAdaptive(engine);

    // Replan 1 — different approach each time
    const md1 = `1. [act] Approach A
  + → final_out: text  # output
`;
    expect(engine.submitReplan('1', md1).status).toBe('ok');

    // Trigger adaptive again
    triggerAdaptiveNeeded(engine);

    // Replan 2
    const md2 = `1. [act] Approach B
  + → final_out: text  # output
`;
    expect(engine.submitReplan('1', md2).status).toBe('ok');

    // Trigger adaptive again
    triggerAdaptiveNeeded(engine);

    // Replan 3
    const md3 = `1. [act] Approach C
  + → final_out: text  # output
`;
    expect(engine.submitReplan('1', md3).status).toBe('ok');

    // Trigger adaptive again
    triggerAdaptiveNeeded(engine);

    // Replan 4 — should be rejected
    const md4 = `1. [act] Approach D
  + → final_out: text  # output
`;
    const result = engine.submitReplan('1', md4);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe(ErrorCode.REPLAN_LIMIT_EXCEEDED);
    }
  });

  it('rejects duplicate replan (same structure and similar summaries)', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC_CB, MINIMAL_HOST_CONFIG);

    // Trigger first adaptive（需失败两次，见升级阶梯）
    triggerInitialAdaptive(engine);

    // Replan 1
    const md1 = `1. [act] Process the data carefully
  + → final_out: text  # output
`;
    expect(engine.submitReplan('1', md1).status).toBe('ok');

    // Trigger adaptive again
    triggerAdaptiveNeeded(engine);

    // Replan 2 — nearly identical summary (>80% Jaccard similarity)
    const md2 = `1. [act] Process the data carefully
  + → final_out: text  # output
`;
    const result = engine.submitReplan('1', md2);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe(ErrorCode.REPLAN_DUPLICATE);
    }
  });

  it('allows replan with sufficiently different structure', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ADAPTIVE_SPEC_CB, MINIMAL_HOST_CONFIG);

    // Trigger first adaptive（需失败两次，见升级阶梯）
    triggerInitialAdaptive(engine);

    // Replan 1
    const md1 = `1. [act] Process the data
  + → final_out: text  # output
`;
    expect(engine.submitReplan('1', md1).status).toBe('ok');

    // Trigger adaptive again
    triggerAdaptiveNeeded(engine);

    // Replan 2 — different structure (2 steps vs 1)
    const md2 = `1. [reason] Analyze failure
  + → analysis: text  # analysis
2. [act] Try alternative approach with completely different strategy
  + → final_out: text  # output
`;
    const result = engine.submitReplan('1', md2);
    expect(result.status).toBe('ok');
  });
});

// @v: anc-error-error-code
describe('ErrorCode enum completeness', () => {
  it('contains all expected fatal error codes', () => {
    const fatal = [
      'INVALID_STEP_ID', 'INVALID_STATE', 'SCHEMA_MISMATCH',
      'DEPTH_EXCEEDED', 'CYCLE_DETECTED', 'AUTH_FAILURE',
      'CONTEXT_OVERFLOW', 'MISSING_INPUT', 'MAX_TOOL_ITERATIONS',
      'BUDGET_EXCEEDED', 'COMMIT_REQUIRED', 'STEP_TIMEOUT',
      'REPLAN_LIMIT_EXCEEDED', 'REPLAN_DUPLICATE', 'CORRUPT_STATE_FILE',
    ];
    for (const code of fatal) {
      expect(ErrorCode).toHaveProperty(code);
    }
  });

  it('contains all expected retryable error codes', () => {
    const retryable = [
      'PARSE_ERROR', 'VALIDATION_ERROR', 'IO_ERROR',
      'RATE_LIMITED', 'API_TIMEOUT', 'API_NETWORK_ERROR',
      'API_SERVER_ERROR', 'TOOL_TIMEOUT', 'TOOL_EXEC_ERROR',
    ];
    for (const code of retryable) {
      expect(ErrorCode).toHaveProperty(code);
    }
  });

  it('contains idempotent hit codes', () => {
    expect(ErrorCode).toHaveProperty('ALREADY_DONE');
    expect(ErrorCode).toHaveProperty('ALREADY_FAILED');
  });

  it('enum values match their keys', () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(value).toBe(key);
    }
  });
});

// @v: anc-step-call
// 悬空映射来源 warn + call 子实例必填闸 + 并行全灭 warn（2026-09-01 dr21 十六撞三缺陷批,
// 作者拍 A 案:静态 V12 拒点路径,运行时 warn 兜悬空;init 必填闸系账实差实装——三处设计承诺
// "子 init 校验必填缺失即拒"码内原无,子实例拿 None 自造角色跑完审查的实撞防线）。
// @v: anc-exec-call-auto-map
describe('call 参数映射悬空 warn 与子实例必填闸', () => {
  const CALLER = `# Caller
Id: caller
## Goal
g
## Inputs
- raw: text  # input
## Outputs
- out: text  # r
## Steps
1. [call] child : 调子流程
  - ← source_data: raw
  - ← extra: not_exists_var
  + → out: cleaned
`;

  it('正例：悬空映射来源 → resolveCallParams 跳过并 recordWarn 落账', () => {
    const dir = mkdtempSync(join(tmpdir(), 'warn-'));
    const engine = new ExecutionEngine();
    engine.initExecution(CALLER, MINIMAL_HOST_CONFIG, { logDir: dir, params: { raw: 'data' } });
    engine.getVariableStore().write('raw', 'data', 'root');
    engine.nextStep();
    const params = engine.resolveCallParams('1');
    expect(params).toEqual({ source_data: 'data' });   // 悬空的 extra 不注入
    const log = readFileSync(join(dir, readdirSync(dir)[0], 'main.yaml'), 'utf-8');
    expect(log).toContain('[call-param]');
    expect(log).toContain('not_exists_var');
  });

  it('反例：全部映射来源在场 → 零 [call-param] warn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'warn2-'));
    const OK_CALLER = CALLER.replace('  - ← extra: not_exists_var\n', '');
    const engine = new ExecutionEngine();
    engine.initExecution(OK_CALLER, MINIMAL_HOST_CONFIG, { logDir: dir, params: { raw: 'data' } });
    engine.getVariableStore().write('raw', 'data', 'root');
    engine.nextStep();
    engine.resolveCallParams('1');
    const log = readFileSync(join(dir, readdirSync(dir)[0], 'main.yaml'), 'utf-8');
    expect(log).not.toContain('[call-param]');
  });

  const CHILD = `# Child
Id: child
## Goal
g
## Inputs
- reviewer_prompt: text  # 指令
- report_dir: line  # 目录
## Outputs
- cleaned: text  # r
## Steps
1. [reason] 审
  - ← reviewer_prompt
  + → cleaned: text
`;

  it('反例：call 子实例必填 Inputs 缺失 → INIT_FAILED 点名（缺指令自造角色实撞防线）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CHILD, MINIMAL_HOST_CONFIG, {
      parentInstanceId: 'parent-x', callStepId: '1',
      params: { reviewer_prompt: '完整指令' },   // report_dir 缺席
    });
    expect(init.status).toBe('error');
    const msg = (init as any).errors?.[0]?.message ?? '';
    expect(msg).toContain('INIT_FAILED');
    expect(msg).toContain('report_dir');
    expect(msg).not.toContain('reviewer_prompt');   // 在场的不点名
  });

  it('正例：全参注入 → 子实例 init ok', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CHILD, MINIMAL_HOST_CONFIG, {
      parentInstanceId: 'parent-x', callStepId: '1',
      params: { reviewer_prompt: '完整指令', report_dir: 'rounds/r001' },
    });
    expect(init.status).toBe('ok');
  });

  // 顶层 run 必填 Inputs 闸（2026-09-01 deep-validate 批立规——call 子实例闸孪生半边,
  // 九坑之坑 3:漏传 scripts_dir 起 run,None 静默灌下游到 subprocess.run 拼坏 argv 才炸,
  // 病灶离症状隔几步。原"顶层缺参照旧宽容"另一决策本日作者拍定收紧）。
  // @v: anc-exec-init-required-inputs
  it('反例：顶层 run 缺参 → INIT_FAILED 逐参点名带类型（原宽容行为翻转）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CHILD, MINIMAL_HOST_CONFIG, {
      params: { reviewer_prompt: '完整指令' },   // report_dir 缺席
    });
    expect(init.status).toBe('error');
    const msg = (init as any).errors?.[0]?.message ?? '';
    expect(msg).toContain('INIT_FAILED');
    expect(msg).toContain('report_dir');
    expect(msg).toContain('line');   // 报文带类型（照抄 VarDecl,补参零翻查）
    expect(msg).not.toContain('reviewer_prompt: text');   // 在场的不点名
  });

  // @v: anc-exec-init-required-inputs
  it('反例：顶层 run 零 params 全缺 → INIT_FAILED 全部点名', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CHILD, MINIMAL_HOST_CONFIG, {});
    expect(init.status).toBe('error');
    const msg = (init as any).errors?.[0]?.message ?? '';
    expect(msg).toContain('reviewer_prompt');
    expect(msg).toContain('report_dir');
  });

  // @v: anc-exec-init-required-inputs
  it('正例：顶层 run 全参齐 → init ok', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CHILD, MINIMAL_HOST_CONFIG, {
      params: { reviewer_prompt: '完整指令', report_dir: 'rounds/r001' },
    });
    expect(init.status).toBe('ok');
  });

  // @v: anc-exec-init-required-inputs
  it('正例：parallel worker 子实例（subtreeRoot 在场）缺参照旧不拦（params_for_child 部分回填是常态）', () => {
    const WORKER_SPEC = `# W
Id: w
## Goal
g
## Inputs
- shards: [line]  # 全部分片
## Outputs
- marked: [yaml]
## Steps
1. [loop for-each shard in shards, collect mark into marked] 逐片
  + → marked: [yaml]
  1.1. [subtask parallel] 单片
    + → mark: yaml
    1.1.1. [reason] 审
      - ← shard
      + → mark: yaml
2. [exit] 完
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(WORKER_SPEC, MINIMAL_HOST_CONFIG, {
      stateDir: mkdtempSync(join(tmpdir(), 'eng-topgate-w-')), subtreeRoot: '1.1',
      parentInstanceId: 'parent-x', callStepId: '1.1',
      params: { shard: 'a' },   // itemVar 给值（缺失另有 MISSING_INPUT 专闸）;声明 Input shards 故意缺席
    });
    expect(init.status).toBe('ok');   // 缺 shards 不拦——worker Inputs 靠 params_for_child 部分回填是常态
  });
});

describe('call step (reuse mode)', () => {
  const CALL_SPEC = `# Caller
Id: caller
## Goal
Test call output mapping
## Inputs
- raw: text  # input
## Outputs
- final_out: text  # result
## Steps
1. [call] cleaner : 调用清洗子流程
  - ← source_data: raw
  + → final_out: cleaned_out
`;

  it('parses call with bidirectional colon mapping', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CALL_SPEC, MINIMAL_HOST_CONFIG, { params: { raw: 'data' } });
    expect(init.status).toBe('ok');
    const spec = engine.getSpec()!;
    const callStep = spec.steps![0] as any;
    expect(callStep.step_type).toBe('call');
    expect(callStep.callee_spec_id).toBe('cleaner');
    // input: from=父变量 raw, to=子参数 source_data
    expect(callStep.param_mapping).toEqual([{ from: 'raw', to: 'source_data' }]);
    // output: from=子输出 cleaned_out, to=父变量 final
    expect(callStep.output_mapping).toEqual([{ from: 'cleaned_out', to: 'final_out' }]);
  });

  it('completeCallStep maps child outputs back via output_mapping', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(CALL_SPEC, MINIMAL_HOST_CONFIG, { params: { raw: 'data' } });
    const vars = engine.getVariableStore();
    vars.write('raw', 'dirty data', 'root');

    const step = engine.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status === 'step_ready') {
      expect(step.step_id).toBe('1');
      expect(step.step_type).toBe('call');
    }

    // 子实例输出 cleaned_out → 父变量 final
    const r = engine.completeCallStep('1', { cleaned_out: 'clean data', extra: 'ignored' });
    expect(r.status).toBe('ok');

    const final = engine.nextStep();
    expect(final.status).toBe('completed');
    if (final.status === 'completed') {
      expect(final.outputs.final_out).toBe('clean data');
    }
  });

  it('completeCallStep rejects non-call step', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(CALL_SPEC, MINIMAL_HOST_CONFIG, { params: { raw: 'data' } });
    const r = engine.completeCallStep('99', {});
    expect(r.status).toBe('error');
    expect(r.code).toBe(ErrorCode.INVALID_STEP_ID);
  });

  // @v: anc-step-call-literal —— resolveCallParams 字面量直传（2026-08-27 hopissues/0044:
  // 原实装把 "seq" 当不存在的父变量静默丢弃,子实例拿 None）
  it('resolveCallParams passes literal params through (0044 regression)', () => {
    const spec = `# Caller
Id: caller-lit
## Goal
Test literal call params
## Inputs
- seq_plan: text  # plan
## Outputs
- out: text  # result
## Steps
1. [call split_structure(split_kind: "seq", retries: 3, split_plan: seq_plan)] 调
  + → out: result
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { seq_plan: 'placeholder' } });
    expect(init.status).toBe('ok');
    engine.getVariableStore().write('seq_plan', 'the-plan', 'root');
    const params = engine.resolveCallParams('1');
    expect(params).toEqual({ split_kind: 'seq', retries: 3, split_plan: 'the-plan' });
  });

  // 反例守卫：裸词变量缺失仍按既有语义不注入（字面量分支不改变量分支行为）
  it('resolveCallParams still skips missing bare-word variables (not coerced to string)', () => {
    const spec = `# Caller
Id: caller-miss
## Goal
Test missing var not coerced
## Outputs
- out: text  # result
## Steps
1. [call sub(mode: seq)] 调
  + → out: result
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    const params = engine.resolveCallParams('1');
    expect(params).toEqual({});   // seq 是变量名且不存在——不注入,绝不变成字符串 "seq"
  });

  // @v: anc-step-call-dynamic-callee —— 复用模式占位拼装:call {var} 形态的 launch_command/
  // call_protocol 里含求值结果不含 {var} 原文（三消费点之三——漏改则 {表达式} 原文漏进命令静默失败）
  it('callee 插值形态:call_protocol 的 init_command 含求值出的 spec Id 不含 {表达式} 原文', () => {
    const DYN_SPEC = `# Caller
Id: caller-dyn-proto
## Goal
动态 callee 占位拼装
## Inputs
- picked_spec: line  # 目标 spec id
## Outputs
- out: text  # result
## Steps
1. [call {picked_spec}(n: 1)] 调
  + → out: result
`;
    const engine = new ExecutionEngine();
    engine.initExecution(DYN_SPEC, MINIMAL_HOST_CONFIG, { params: { picked_spec: 'cleaner-v2' } });
    // 复用模式协议拼装需要 cliAbsPath/specPath——经 CLI init 才有;直调时设私有面模拟 CLI 环境（H2 组先例）
    (engine as any).cliAbsPath = '/abs/cli.js';
    (engine as any).specPath = '/abs/p.md';
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    const cp = (r as any).call_protocol;
    expect(cp).toBeDefined();
    expect(cp.init_command).toContain('<CALLEE_SPEC_PATH:cleaner-v2>');   // 求值结果进占位
    expect(cp.init_command).not.toContain('{picked_spec}');               // 原文决不漏进命令
  });

  // @v: anc-step-call-dynamic-callee —— 复用模式解引用失败形态:buildCallProtocol 求值不出
  // （变量值为对象=非字符串）整包不拼——载荷缺席,{表达式} 原文决不漏进命令;失败最终在
  // worker 侧响亮（设计分模式失败形态条款）
  it('callee 插值求值失败（变量值为对象）→ call_protocol 载荷缺席（不含 init_command）', () => {
    const DYN_BAD = `# Caller
Id: caller-dyn-bad
## Goal
动态 callee 求值失败形态
## Inputs
- picked_spec: yaml  # 错拿对象当 callee
## Outputs
- out: text  # result
## Steps
1. [call {picked_spec}(n: 1)] 调
  + → out: result
`;
    const engine = new ExecutionEngine();
    engine.initExecution(DYN_BAD, MINIMAL_HOST_CONFIG, { params: { picked_spec: { id: 'cleaner-v2' } } });
    (engine as any).cliAbsPath = '/abs/cli.js';
    (engine as any).specPath = '/abs/p.md';
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    const cp = (r as any).call_protocol;
    expect(cp?.init_command).toBeUndefined();   // 整包不拼——载荷缺席,原文不漏进命令
  });
});

// @v: anc-exec-output-schema-check
describe('completeStep 输出 schema 校验', () => {
  const SCHEMA_SPEC = `# Schema Test
Id: schema-test

## Goal
Test output schema validation

## Outputs
- level: enum(low, medium, high)  # risk level

## Steps
1. [reason] 评估
  + → score: float  # 数值评分
  + → level: enum(low, medium, high)  # 风险级别
  + → tags: [line]  # 标签列表
  > 评估风险
`;

  function readyStep1(engine: ExecutionEngine) {
    const s = engine.nextStep();
    expect(s.status).toBe('step_ready');
  }

  it('值匹配声明类型 → 通过', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SCHEMA_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { score: 42, level: 'high', tags: ['a', 'b'] });
    expect(r.status).toBe('ok');
  });

  // @v: anc-exec-output-coerce —— 边界归一转换（v0.11.0 作者定，配套 hop_python 等值严格化）：
  // 声明类型是权威——数字串/布尔串在写 vars 前转真类型，变量空间零跨类型值。
  it('正例：声明 int/bool 收字符串形 → 归一转换后入变量空间（number 已除名,2026-08-31）', () => {
    const spec = `# Coerce Test
Id: coerce-test

## Goal
Test boundary coercion

## Steps
1. [reason] 产出
  + → score: float  # 数值评分
  + → n: int  # 计数
  + → ok: bool  # 布尔
  + → note: text  # 文本不动
  > 产出
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { score: '42.5', n: '7.9', ok: 'True', note: '3' });
    expect(r.status).toBe('ok');
    const vars = engine.getVariableStore();
    expect(vars.read('score', 'root')).toBe(42.5);   // 数字串 → float 保小数
    expect(vars.read('n', 'root')).toBe(7);          // int 截断
    expect(vars.read('ok', 'root')).toBe(true);      // "True" → bool
    expect(vars.read('note', 'root')).toBe('3');     // text 声明不动值
  });

  // line 核单行（二十七审——概念'line=单行字符串'与代码宽松族失配;实证:flash 两轮 completed
  // 全栽 generated_spec_path 收多行'交付说明'散文）。
  // @v: anc-exec-line-single —— v2 2026-08-25 多行折叠归一（——dr16 实撞:修错步 fix_note 两轮
  // 多行 markdown 小结,SCHEMA_MISMATCH 各重试 3 次仍多行,一个记账字段烧掉 5.2 两条命;
  // 模型对"总结一句"天然爱写多行,换行折叠内容零丢失,语义引导治不了的交给确定性归一）
  it('正例：line 声明收多行值 → 归一折叠为单行入库（不再 SCHEMA_MISMATCH）', () => {
    const spec = `# Line Test
Id: line-test

## Goal
Test line fold normalization

## Steps
1. [reason] 产出
  + → path: line  # 路径
  > 产出
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { path: 'Draft re-validated:\n**zero errors**\nonly expected warnings.' });
    expect(r.status).not.toBe('error');   // 旧口径此值 SCHEMA_MISMATCH 重试 3 次烧尽(dr16 5.2.2 实录)
    const v = engine.getVariableStore().read('path', '') as string;
    expect(v).toBe('Draft re-validated: **zero errors** only expected warnings.');   // 换行折叠空格,内容零丢失
    expect(v).not.toContain('\n');
  });

  it('正例：line 单行值周边空白归一 trim 后入变量空间', () => {
    const spec = `# Line Trim
Id: line-trim

## Goal
t

## Steps
1. [reason] 产出
  + → path: line  # 路径
  > 产出
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { path: '  /tmp/out/spec.md  \n' });
    expect(r.status).toBe('ok');
    expect(engine.getVariableStore().read('path', 'root')).toBe('/tmp/out/spec.md');
  });

  it('反例：text 声明的多行内容不受 line 收窄影响（宽松族不变）', () => {
    const spec = `# Text Multi
Id: text-multi

## Goal
t

## Steps
1. [reason] 产出
  + → report: text  # 报告
  > 产出
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { report: '第一行\n第二行\n第三行' });
    expect(r.status).toBe('ok');
  });

  // line 值域边界（review 抓:旧宽松族对结构值也放行——对象住进 line 流向字符串拼接即
  // [object Object] 毒形态;标量转串信息无损归一采用） // @v: anc-exec-line-single
  it('反例：line 声明收对象 → SCHEMA_MISMATCH 拒结构值（不静默存 [object Object] 温床）', () => {
    const spec = `# Line Obj
Id: line-obj

## Goal
t

## Steps
1. [reason] 产出
  + → path: line  # 路径
  > 产出
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { path: { file: '/tmp/x.md' } });
    expect(r.status).toBe('error');
    expect((r as { code?: string }).code).toBe('SCHEMA_MISMATCH');
  });

  it('正例：line 声明收数字标量 → String 化归一入库（标量转串信息无损）', () => {
    const spec = `# Line Num
Id: line-num

## Goal
t

## Steps
1. [reason] 产出
  + → count_note: line  # 计数记录
  > 产出
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { count_note: 42 });
    expect(r.status).toBe('ok');
    expect(engine.getVariableStore().read('count_note', '')).toBe('42');
  });

  // yaml=结构化数据（2026-08-20 作者定值模型改判——实撞:expand-node 1.3 对文本型 yaml 取
  // 字段 undefined 确定性死,retry 白烧）：LLM 产 YAML 文本 → parse 成结构入变量空间;
  // 纯散文拒;结构原样过。
  // @v: anc-type-yaml-structured
  const YAML_SPEC = `# Yaml Coerce
Id: yaml-coerce

## Goal
t

## Steps
1. [reason] 产出
  + → contract: yaml  # 头部契约
  > 产出
`;

  it('正例：yaml 声明收 YAML 文本 → parse 成结构入变量空间（字段访问直接可用）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { contract: 'goal: 分诊\ninputs:\n  - name: inbox_emails\n    type: "[Email]"\n' });
    expect(r.status).toBe('ok');
    const v = engine.getVariableStore().read('contract', 'root') as Record<string, unknown>;
    expect(typeof v).toBe('object');
    expect((v.inputs as Array<{ name: string }>)[0].name).toBe('inbox_emails');
  });

  it('正例：yaml 声明收结构原样过（对象/列表直接入库,围栏包裹的 YAML 剥壳后同样解出）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { contract: { goal: 'x', inputs: [] } });
    expect(r.status).toBe('ok');
    expect((engine.getVariableStore().read('contract', 'root') as Record<string, unknown>).goal).toBe('x');

    const e2 = new ExecutionEngine();
    e2.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(e2);
    const r2 = e2.completeStep('1', { contract: '```yaml\ngoal: y\ninputs: []\n```' });
    expect(r2.status).toBe('ok');
    expect((e2.getVariableStore().read('contract', 'root') as Record<string, unknown>).goal).toBe('y');
  });

  it('正例：init 入口边界同规——params 传 YAML 文本给 yaml 声明的 Input → parse 成结构', () => {
    const spec = `# Yaml Input
Id: yaml-input

## Goal
t

## Inputs
- contract: yaml

## Steps
1. [act] 提取
  - ← contract
  + → names: [line]  # 名单
  > \`\`\`hop_python
  > names = [i.name for i in contract.inputs]
  > \`\`\`
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG, {
      params: { contract: 'goal: g\ninputs:\n  - name: alpha\n  - name: beta\n' },
    });
    const v = engine.getVariableStore().read('contract', 'root') as Record<string, unknown>;
    expect(typeof v).toBe('object');   // 入口 parse 成结构——hop_python 字段链/推导直接可用
    expect((v.inputs as Array<{ name: string }>).length).toBe(2);
  });

  // 归一递归下钻（三十七审抓漏:归一层只看顶层类型,[yaml] 元素/TypeDecl 字段以原始串入库——
  // 与校验层 0014 递归核不同判据面,"变量空间不存跨类型值"嵌套位破防）。
  // @v: anc-exec-output-coerce
  it('正例：[yaml] 元素与 TypeDecl 字段逐层归一（嵌套位同规 parse/trim）', () => {
    const s1 = `# T
Id: t

## Goal
g

## Steps
1. [reason] 产出
  + → items: [yaml]  # 列表
  > x
`;
    const e1 = new ExecutionEngine();
    e1.initExecution(s1, MINIMAL_HOST_CONFIG);
    readyStep1(e1);
    expect(e1.completeStep('1', { items: ['goal: a\ninputs: []'] }).status).toBe('ok');
    const v1 = e1.getVariableStore().read('items', 'root') as Array<Record<string, unknown>>;
    expect(typeof v1[0]).toBe('object');
    expect(v1[0].goal).toBe('a');

    const s2 = `# T
Id: t

## Goal
g

## Types
- Contract:  # 契约
  - meta: yaml  # 元数据
  - name: line  # 名

## Steps
1. [reason] 产出
  + → c: Contract  # 契约
  > x
`;
    const e2 = new ExecutionEngine();
    e2.initExecution(s2, MINIMAL_HOST_CONFIG);
    readyStep1(e2);
    expect(e2.completeStep('1', { c: { name: '  n  ', meta: 'k: v' } }).status).toBe('ok');
    const v2 = e2.getVariableStore().read('c', 'root') as Record<string, unknown>;
    expect((v2.meta as Record<string, unknown>).k).toBe('v');   // 字段位 yaml parse
    expect(v2.name).toBe('n');                                   // 字段位 line trim
  });

  // 列表型显式 null 归一空列表（2026-08-23 作者定"要有宽容度"——dr10 实撞:骨架步两个列表
  // 产出本轮恰好无条目,flash 连交三轮 null 烧尽算子重试整步失败,内容全对败在空值形态）
  // @v: anc-exec-output-schema-check
  it('正例：声明 [line] 键在场值 null → 归一空列表 [] 采用（含 warn 留痕）', () => {
    const LIST_SPEC = `# L
Id: l
## Goal
g
## Outputs
- items: [line]  # 清单
## Steps
1. [reason] 产出
  + → items: [line]  # 清单
  > x
`;
    const dir = mkdtempSync(join(tmpdir(), 'nullnorm-'));
    const e1 = new ExecutionEngine();
    e1.initExecution(LIST_SPEC, MINIMAL_HOST_CONFIG, { logDir: dir });
    readyStep1(e1);
    expect(e1.completeStep('1', { items: null }).status).toBe('ok');
    expect(e1.getVariableStore().read('items', 'root')).toEqual([]);
    const yaml = readFileSync(join(e1.getHopLog()!.getRunDir(), 'main.yaml'), 'utf-8');
    expect(yaml).toContain('按列表型声明归一为空列表');
  });

  it('反例：键整个缺失照拒;yaml 声明收 null 照拒（宽容边界从紧,只救列表型显式 null）', () => {
    const LIST_SPEC = `# L
Id: l
## Goal
g
## Outputs
- items: [line]  # 清单
## Steps
1. [reason] 产出
  + → items: [line]  # 清单
  > x
`;
    const e1 = new ExecutionEngine();
    e1.initExecution(LIST_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(e1);
    expect(e1.completeStep('1', {}).status).toBe('error');   // 缺键=可能忘了整个产出

    const e2 = new ExecutionEngine();
    e2.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(e2);
    expect(e2.completeStep('1', { contract: null }).status).toBe('error');   // yaml null 无"空对象=没有"语义
  });

  // 结构值单键自嵌套剥层（四十三审 flash 实录:LLM echo 变量名作顶键交结构 {test_params:{真值}},
  // 原阶梯只对字符串触发——结构直过校验自嵌套壳入库,下游字段访问多包一层取不到）
  // @v: anc-exec-output-fence-recovery
  it('正例：结构值 {字段名:{真值}} 自嵌套剥一层;业务单键对象（键≠字段名）不误剥', () => {
    const e1 = new ExecutionEngine();
    e1.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(e1);
    expect(e1.completeStep('1', { contract: { contract: { goal: 'g', inputs: [] } } }).status).toBe('ok');
    const v1 = e1.getVariableStore().read('contract', 'root') as Record<string, unknown>;
    expect(v1.goal).toBe('g');            // 剥了一层——字段直达
    expect('contract' in v1).toBe(false); // 壳没入库

    const e2 = new ExecutionEngine();
    e2.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(e2);
    expect(e2.completeStep('1', { contract: { goal: 'x' } }).status).toBe('ok');
    expect((e2.getVariableStore().read('contract', 'root') as Record<string, unknown>).goal).toBe('x');
  });

  it('反例：自嵌套内层是标量 → 剥后照拒（yaml 须结构,响亮不静默）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    expect(engine.completeStep('1', { contract: { contract: 'scalar-text' } }).status).toBe('error');
  });

  it('反例：yaml 声明收纯散文/标量 → SCHEMA_MISMATCH 指路结构（不静默存文本）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { contract: '契约已生成，包含 goal 与 inputs 两部分，详见上文说明。' });
    expect(r.status).toBe('error');
    expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
    expect(r.message).toContain('结构');

    const e2 = new ExecutionEngine();
    e2.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(e2);
    expect(e2.completeStep('1', { contract: 42 }).status).toBe('error');
  });

  // null=未产出（二十九审实撞:LLM 答 'header_final: null' 原全类型放行——毒值直通呈审与下游,
  // 4.2 人看到 null/5.1 拿 null 规划;缺键拒/null 过是空子）。 // @v: anc-exec-output-schema-check
  it('正例：显式 null 输出与缺键同判 SCHEMA_MISMATCH（反馈指路不要输出 null）', () => {
    const spec = `# NullOut
Id: null-out

## Goal
t

## Steps
1. [reason] 产出
  + → h: yaml  # 契约
  + → w: text  # 附注
  > 产出
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { h: null, w: 'ok' });
    expect(r.status).toBe('error');
    expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
    expect(r.message).toContain('null');
  });

  it('反例：不可转的值不被归一吞掉——校验层先拒（转换只在校验通过后）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SCHEMA_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { score: 'not-a-number', level: 'high', tags: [] });
    expect(r.status).toBe('error');
    expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);   // 归一不救谎报值
  });

  it('number 字段给非数字 → SCHEMA_MISMATCH', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SCHEMA_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { score: 'very high', level: 'high' });
    expect(r.status).toBe('error');
    expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
    expect(r.message).toContain('score');
  });

  it('enum 字段给列举外的值 → SCHEMA_MISMATCH', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SCHEMA_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { score: 42, level: 'critical' });
    expect(r.status).toBe('error');
    expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
    expect(r.message).toContain('level');
  });

  // 校验盲区补判（2026-08-17 hopissues/hoplogic3/0014——算子自循环机制在,但 checkValue 对
  // 最高频失真形态失明:yaml 围栏串零校验/TypeDecl 只查非空占位对象全过,十八讲 78 候选跑成
  // 占位+null 弃点潮,修复动作离故障源头两三步。不新建机制只补判据面）。
  // @v: anc-exec-output-schema-check
  describe('checkValue 盲区补判（0014:TypeDecl 递归字段核+[T] 元素级+yaml 拒围栏串）', () => {
    const CAND_SPEC = `# C
Id: c
## Goal
g
## Types
- Cand:  # c
  - claim: text
  - kind: line
## Outputs
- cands: [Cand]  # 候选
## Steps
1. [reason] r
  + → cands: [Cand]  # 候选
  > t
`;
    function mk() {
      const e = new ExecutionEngine();
      e.initExecution(CAND_SPEC, MINIMAL_HOST_CONFIG);
      e.nextStep();
      return e;
    }

    it('反例：[Cand] 元素缺字段（占位对象）→ SCHEMA_MISMATCH 带下标与字段明细（probe 形态）', () => {
      const r = mk().completeStep('1', { cands: [{ claim: 'x', kind: 'k' }, { id: 1 }] });
      expect(r.status).toBe('error');
      expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
      expect(r.message).toContain('元素[1]');
      expect(r.message).toContain('claim');
    });

    it('正例：合法元素 + 空串字段 + 多余键 → 通过（空串=占位点是 spec 作者显式设计;附注键无害）', () => {
      const r = mk().completeStep('1', { cands: [{ claim: '', kind: '跨片', note: '附注' }] });
      expect(r.status).toBe('ok');
    });

    it('反例：TypeDecl 位收到非对象（数组/串）→ mismatch 指明形态', () => {
      const r = mk().completeStep('1', { cands: [['not-an-object']] });
      expect(r.status).toBe('error');
      expect(r.message).toContain('元素[0]');
    });

    // 反馈附类型定义（0017 反馈半边——原反馈只说'缺 kind'不给完整形,LLM 逐轮微调仍在猜,
    // hopkb 3 轮同因全灭;定义行让反馈自包含,与 prompt L1 同一份 TypeDecl）。 // @v: anc-exec-output-schema-check, anc-type-type-decl
    it('正例：失配涉自定义 TypeDecl → 反馈附字段级定义行（重试自包含,0017 probe 反馈形态）', () => {
      const r = mk().completeStep('1', { cands: [{ id: 1 }] });
      expect(r.status).toBe('error');
      expect(r.message).toContain('类型定义');
      // 2026-08-27 注释入渲染:带 # 注释的类型换条目式（作者定"llm 需要注释"——断言随契约更新）
      expect(r.message).toContain('Cand:');
      expect(r.message).toContain('claim: text');
      expect(r.message).toContain('kind: line');   // 完整形在反馈里,不再只说缺啥
    });

    it('正例：嵌套类型闭包——失配涉 Mark 时反馈带 Mark 与其字段引用的 Candidate 两行定义（递归收集）', () => {
      const NEST_SPEC = `# M\nId: m\n## Goal\ng\n## Types\n- Candidate:  # c\n  - claim: text\n  - kind_hint: line\n- Mark:  # m\n  - points: [Candidate]\n  - leads: text\n## Outputs\n- mark: Mark  # m\n## Steps\n1. [reason] r\n  + → mark: Mark  # m\n  > t\n`;
      const e = new ExecutionEngine();
      e.initExecution(NEST_SPEC, MINIMAL_HOST_CONFIG);
      e.nextStep();
      const r = e.completeStep('1', { mark: { points: [] } });   // 缺 leads
      expect(r.status).toBe('error');
      expect(r.message).toContain('points: [Candidate]');
      expect(r.message).toContain('kind_hint: line');   // 闭包递归收到嵌套类型（条目式渲染,断言随契约更新）
    });

    it('反例：失配仅涉内置类型 → 反馈零定义行（无自定义类型时不加噪声）', () => {
      const NUM_SPEC = `# N\nId: n\n## Goal\ng\n## Outputs\n- v: int  # v\n## Steps\n1. [reason] r\n  + → v: int  # v\n  > t\n`;
      const e = new ExecutionEngine();
      e.initExecution(NUM_SPEC, MINIMAL_HOST_CONFIG);
      e.nextStep();
      const r = e.completeStep('1', { v: 'not-a-number' });
      expect(r.status).toBe('error');
      expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
      expect(r.message).not.toContain('类型定义');
    });

    const YAML_SPEC = `# Y
Id: y
## Goal
g
## Outputs
- outcome: yaml  # o
## Steps
1. [reason] r
  + → outcome: yaml  # o
  > t
`;
    it('正例：yaml 围栏串但内容可解 → 恢复阶梯先解出采用（自愈不打扰,时序=恢复在校验前）', () => {
      const e = new ExecutionEngine();
      e.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
      e.nextStep();
      expect(e.completeStep('1', { outcome: '```yaml\nstate: ok\n```' }).status).toBe('ok');
    });

    it('反例：yaml 围栏串解不出（坏 yaml）→ 当场 SCHEMA_MISMATCH 触发算子自循环（原静默放行漂到 call 边界才炸）', () => {
      const e = new ExecutionEngine();
      e.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
      e.nextStep();
      const r = e.completeStep('1', { outcome: '```yaml\n[: bad {{\n```' });
      expect(r.status).toBe('error');
      expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
      expect(r.message).toContain('围栏');
    });

    // 八审两发现（阶梯×typeDecls 交互——探针实抓）：①阶梯进门判定不带 typeDecls 时,
    // TypeDecl 声明的围栏串被"未声明类型非空即过"挡在阶梯外,自愈失效;②终审门拒"形态对但
    // 字段缺"的解出物时原围栏串进校验报"非对象"指错方向——结构已解出档:对象/数组解出物
    // 仍采用,类型细节交校验层报字段级明细（@file 指针串解析后仍是字符串,回归不破）。
    it('正例：TypeDecl 声明的围栏合法对象 → 阶梯自愈（进门判定带 typeDecls）', () => {
      const SPEC1 = CAND_SPEC.replace('- cands: [Cand]  # 候选', '- c: Cand  # 单个').replace('+ → cands: [Cand]  # 候选', '+ → c: Cand  # 单个');
      const e = new ExecutionEngine();
      e.initExecution(SPEC1, MINIMAL_HOST_CONFIG);
      e.nextStep();
      expect(e.completeStep('1', { c: '```yaml\nclaim: x\nkind: k\n```' }).status).toBe('ok');
    });

    it('反例：TypeDecl 声明的围栏缺字段对象 → mismatch 报字段级明细而非"非对象"（结构已解出档）', () => {
      const SPEC1 = CAND_SPEC.replace('- cands: [Cand]  # 候选', '- c: Cand  # 单个').replace('+ → cands: [Cand]  # 候选', '+ → c: Cand  # 单个');
      const e = new ExecutionEngine();
      e.initExecution(SPEC1, MINIMAL_HOST_CONFIG);
      e.nextStep();
      const r = e.completeStep('1', { c: '```yaml\nid: 1\n```' });
      expect(r.status).toBe('error');
      expect(r.message).toContain('缺字段 claim');       // 指对方向
      expect(r.message).not.toContain('非对象');          // 不指错方向
    });

    it('正例：yaml 真结构与普通散文照常通过（收窄只及纯围栏串）', () => {
      const e = new ExecutionEngine();
      e.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
      e.nextStep();
      expect(e.completeStep('1', { outcome: { state: 'ok' } }).status).toBe('ok');
    });
  });

  // @v: anc-exec-output-fence-recovery —— BUG-C 修（2026-08-13 hopkb 级二实撞:deepseek 把
  // [yaml] 输出写成围栏文本塞字段值,盲重试同因必死 3 实例全灭）
  describe('围栏输出恢复阶梯（BUG-C）', () => {
    const FENCE_SPEC = `# F
Id: f
## Goal
g
## Outputs
- shards: [yaml]  # 列表
## Steps
1. [reason] 产出
  + → shards: [yaml]  # 列表
  > 产出
`;
    function mk() {
      const engine = new ExecutionEngine();
      engine.initExecution(FENCE_SPEC, MINIMAL_HOST_CONFIG);
      readyStep1(engine);
      return engine;
    }

    it('正例：围栏 yaml + 单键嵌套（实撞原型）→ 解出真数组,completeStep ok', () => {
      const engine = mk();
      const r = engine.completeStep('1', { shards: '```yaml\nshards:\n  - material_ref: a\n  - material_ref: b\n```' });
      expect(r.status).toBe('ok');
      expect(engine.getVariableStore().read('shards', 'root')).toEqual([{ material_ref: 'a' }, { material_ref: 'b' }]);
    });

    it('正例：围栏 json → 解出数组', () => {
      const engine = mk();
      const r = engine.completeStep('1', { shards: '```json\n[{"a":1},{"b":2}]\n```' });
      expect(r.status).toBe('ok');
      expect(engine.getVariableStore().read('shards', 'root')).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('正例：无围栏裸 yaml 列表文本 → 同解出', () => {
      const engine = mk();
      const r = engine.completeStep('1', { shards: '- x: 1\n- y: 2' });
      expect(r.status).toBe('ok');
      expect(Array.isArray(engine.getVariableStore().read('shards', 'root'))).toBe(true);
    });

    it('反例：真散文解不出 → 照常 SCHEMA_MISMATCH（阶梯不是宽松放行）', () => {
      const engine = mk();
      const r = engine.completeStep('1', { shards: '这是一段说明文字,没有结构。' });
      expect(r.status).toBe('error');
      expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
    });

    it('反例回归：@file 指针串照拒（原"禁止宽松接受"实证不破——解析后仍是字符串不采用）', () => {
      const engine = mk();
      const r = engine.completeStep('1', { shards: '@/tmp/pages.json' });
      expect(r.status).toBe('error');
      expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
    });

    it('反馈半边：围栏痕迹的 mismatch 反馈含"直接返回值"提示（盲重试同因的对治）', () => {
      const engine = mk();
      const r = engine.completeStep('1', { shards: '```text\n纯散文围栏,解析出来还是字符串\n```' });
      expect(r.status).toBe('error');
      expect(r.message).toContain('不要用代码围栏');
    });

    it('正例：enum 围栏值剥出合法枚举成员（字符串标量恢复面——终审门是唯一守卫,review 抓漏 2026-08-13）', () => {
      const spec = FENCE_SPEC.replace(/shards: \[yaml\]  # 列表/g, 'lv: enum(low,high)  # 档').replace('+ → shards', '+ → lv');
      const engine = new ExecutionEngine();
      engine.initExecution(spec, MINIMAL_HOST_CONFIG);
      readyStep1(engine);
      const r = engine.completeStep('1', { lv: '```\nhigh\n```' });
      expect(r.status).toBe('ok');
      expect(engine.getVariableStore().read('lv', 'root')).toBe('high');
    });

    it('反例：enum 围栏剥出仍非枚举成员 → 照拒（终审门不放水）', () => {
      const spec = FENCE_SPEC.replace(/shards: \[yaml\]  # 列表/g, 'lv: enum(low,high)  # 档').replace('+ → shards', '+ → lv');
      const engine = new ExecutionEngine();
      engine.initExecution(spec, MINIMAL_HOST_CONFIG);
      readyStep1(engine);
      const r = engine.completeStep('1', { lv: '```\nmedium\n```' });
      expect(r.status).toBe('error');
      expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
    });

    // 多层同键自嵌套剥至不动点（2026-08-22 hopbuild2 ppt 轮实抓:deepseek 交三层
    // {hf:{hf:{hf:真值}}},原剥一次剩双层入库,下游机械关按键取值恒空四轮退死）
    // @v: anc-exec-output-fence-recovery
    it('正例：结构值三层同键自嵌套 → 剥至不动点（yaml 声明结构档）', () => {
      const spec = FENCE_SPEC.replace(/shards: \[yaml\]  # 列表/g, 'hf: yaml  # 契约').replace('+ → shards', '+ → hf');
      const engine = new ExecutionEngine();
      engine.initExecution(spec, MINIMAL_HOST_CONFIG);
      readyStep1(engine);
      const r = engine.completeStep('1', { hf: { hf: { hf: { goal: 'g', inputs: [] } } } });
      expect(r.status).toBe('ok');
      expect(engine.getVariableStore().read('hf', 'root')).toEqual({ goal: 'g', inputs: [] });
    });

    it('正例：字符串档围栏内三层同键嵌套 → coerce parse 后经结构档循环剥净', () => {
      // yaml 声明的字符串过 checkValue（合法标量）,阶梯字符串档按设计跳过;parse 归
      // coerceOutputValues——parse 出的同键嵌套结构再过一次恢复(1219 路径 recover∘coerce
      // 只在 dispatcher 消化链)。completeStep 路径:recover(字符串不动)→coerce(parse 成
      // {hf:{hf:{goal}}})→入库。结构档剥层必须发生在 parse 之后——本例钉 coerce 后再恢复
      // 的链路（engine 1219 行 outcome.vars 消化路径同链）。
      const spec = FENCE_SPEC.replace(/shards: \[yaml\]  # 列表/g, 'hf: yaml  # 契约').replace('+ → shards', '+ → hf');
      const engine = new ExecutionEngine();
      engine.initExecution(spec, MINIMAL_HOST_CONFIG);
      readyStep1(engine);
      const r = engine.completeStep('1', { hf: '```yaml\nhf:\n  hf:\n    goal: g\n```' });
      expect(r.status).toBe('ok');
      expect(engine.getVariableStore().read('hf', 'root')).toEqual({ goal: 'g' });
    });

    it('反例：非同键嵌套不剥（{other:{...}} 是真值形态,剥了才是损毁）', () => {
      const spec = FENCE_SPEC.replace(/shards: \[yaml\]  # 列表/g, 'hf: yaml  # 契约').replace('+ → shards', '+ → hf');
      const engine = new ExecutionEngine();
      engine.initExecution(spec, MINIMAL_HOST_CONFIG);
      readyStep1(engine);
      const r = engine.completeStep('1', { hf: { other: { hf: 1 } } });
      expect(r.status).toBe('ok');
      expect(engine.getVariableStore().read('hf', 'root')).toEqual({ other: { hf: 1 } });
    });

    it('留痕：恢复采用的字段随步落 HopLog warn（静默改值不可无痕——审计读出"LLM 给了围栏,引擎剥的"）', () => {
      const engine = new ExecutionEngine();
      const tmpDir = mkdtempSync(join(tmpdir(), 'hoptest-fencewarn-'));
      engine.initExecution(FENCE_SPEC, MINIMAL_HOST_CONFIG, { logDir: tmpDir });
      readyStep1(engine);
      const r = engine.completeStep('1', { shards: '```yaml\n- a: 1\n```' });
      expect(r.status).toBe('ok');
      const yaml = readFileSync(engine.getHopLog()!.getFilePath(), 'utf-8');
      expect(yaml).toContain('围栏恢复阶梯');
    });

    // @v: anc-exec-output-fence-recovery —— BUG-D:call 边界（同族最后一处,hopkb 级二实撞:
    // 子实例宽松标量声明过检查阶梯不触发,围栏串跨边界漂进父 collect）
    describe('call 边界围栏恢复（BUG-D）', () => {
      const CALL_SPEC = `# P
Id: p
## Goal
g
## Inputs
- items: [text]
## Outputs
- outcomes: [yaml]
## Steps
1. [loop for-each it in items, collect outcome into outcomes] 逐个
  + → outcomes: [yaml]
  1.1. [call child(it) parallel] 调
    + → outcome: result
2. [exit]
`;
      function mkCall() {
        const engine = new ExecutionEngine();
        engine.initExecution(CALL_SPEC, MINIMAL_HOST_CONFIG, { params: { items: ['a'] } });
        engine.setUnifiedDispatch(true);
        return engine;
      }

      it('正例：子实例围栏 yaml 值 → reapParallelCall 映射处剥壳解出真对象进 collect', () => {
        const engine = mkCall();
        const n = engine.nextStep() as { child_instance: string };
        engine.reapParallelCall(n.child_instance, { vars: { result: '```yaml\nmaterial: x\nrows: 3\n```' } });
        const done = engine.nextStep() as { outputs?: Record<string, unknown> };
        expect(done.outputs?.['outcomes']).toEqual([{ material: 'x', rows: 3 }]);
      });

      it('正例：围栏内单键嵌套 {来源键: 值} → 按来源键剥层', () => {
        const engine = mkCall();
        const n = engine.nextStep() as { child_instance: string };
        engine.reapParallelCall(n.child_instance, { vars: { result: '```yaml\nresult:\n  material: x\n```' } });
        const done = engine.nextStep() as { outputs?: Record<string, unknown> };
        expect(done.outputs?.['outcomes']).toEqual([{ material: 'x' }]);
      });

      it('反例：无围栏纯文本值不被碰（剥壳只对围栏形态,合法文本原样跨边界）', () => {
        const engine = mkCall();
        const n = engine.nextStep() as { child_instance: string };
        engine.reapParallelCall(n.child_instance, { vars: { result: 'plain text ok' } });
        const done = engine.nextStep() as { outputs?: Record<string, unknown> };
        expect(done.outputs?.['outcomes']).toEqual(['plain text ok']);
      });

      it('反例：围栏内解不出（真散文围栏）→ 原值原样（不造值不丢值）', () => {
        const engine = mkCall();
        const n = engine.nextStep() as { child_instance: string };
        engine.reapParallelCall(n.child_instance, { vars: { result: '```text\n只是被围栏包着的散文,冒号都没有\n```' } });
        const done = engine.nextStep() as { outputs?: Record<string, unknown> };
        expect(typeof (done.outputs?.['outcomes'] as unknown[])[0]).toBe('string');
      });
    });

    it('正例：subtask 兄弟位收割围栏值按声明档解出（BUG-D 同族第 4 处——收割直写不经 completeStep,review 抓漏 2026-08-13）', () => {
      const SUB_SPEC = `# P
Id: p
## Goal
g
## Outputs
- rep: [yaml]
## Steps
1. [subtask] 边界
  + → rep: [yaml]
  1.1. [subtask parallel] 活
    + → rep: [yaml]
    1.1.1. [reason] 想
      + → rep: [yaml]  # 列
      > t
2. [exit]
`;
      const engine = new ExecutionEngine();
      engine.initExecution(SUB_SPEC, MINIMAL_HOST_CONFIG);
      engine.setUnifiedDispatch(true);
      const n = engine.nextStep() as { child_instance: string };
      engine.reapParallelSubtask(n.child_instance, { vars: { rep: '```yaml\n- a: 1\n- b: 2\n```' } });
      const done = engine.nextStep() as { outputs?: Record<string, unknown> };
      expect(done.outputs?.['rep']).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('正例：subtask 收割数字串按声明归一（同族第 5 处——收割不经 completeStep 则 coerce 也缺,数字串破"变量空间不存跨类型值"不变量）', () => {
      const NUM_SPEC = `# P
Id: p
## Goal
g
## Outputs
- n: int
## Steps
1. [subtask] 边界
  + → n: int
  1.1. [subtask parallel] 活
    + → n: int
    1.1.1. [reason] 想
      + → n: int  # 数
      > t
2. [exit]
`;
      const engine = new ExecutionEngine();
      engine.initExecution(NUM_SPEC, MINIMAL_HOST_CONFIG);
      engine.setUnifiedDispatch(true);
      const n = engine.nextStep() as { child_instance: string };
      engine.reapParallelSubtask(n.child_instance, { vars: { n: '42' } });
      const done = engine.nextStep() as { outputs?: Record<string, unknown> };
      expect(done.outputs?.['n']).toBe(42);
    });

    it('反例：subtask 收割散文值(解不出)原样直写——阶梯不造值,下游按谎报值自然暴露', () => {
      const SUB_SPEC = `# P
Id: p
## Goal
g
## Outputs
- rep: [yaml]
## Steps
1. [subtask] 边界
  + → rep: [yaml]
  1.1. [subtask parallel] 活
    + → rep: [yaml]
    1.1.1. [reason] 想
      + → rep: [yaml]  # 列
      > t
2. [exit]
`;
      const engine = new ExecutionEngine();
      engine.initExecution(SUB_SPEC, MINIMAL_HOST_CONFIG);
      engine.setUnifiedDispatch(true);
      const n = engine.nextStep() as { child_instance: string };
      engine.reapParallelSubtask(n.child_instance, { vars: { rep: '一段散文,不是列表。' } });
      const done = engine.nextStep() as { outputs?: Record<string, unknown> };
      expect(typeof done.outputs?.['rep']).toBe('string');   // 原样,不造值
    });

    it('不碰面：text/markdown 声明的合法围栏内容原样通过（标量宽松,阶梯不触发）', () => {
      const spec = FENCE_SPEC.replace(/shards: \[yaml\]  # 列表/g, 'doc: markdown  # 文').replace('+ → shards', '+ → doc');
      const engine = new ExecutionEngine();
      engine.initExecution(spec, MINIMAL_HOST_CONFIG);
      readyStep1(engine);
      const r = engine.completeStep('1', { doc: '```js\ncode sample\n```' });
      expect(r.status).toBe('ok');
      expect(engine.getVariableStore().read('doc', 'root')).toContain('```js');
    });
  });

  it('声明的字段缺失 → SCHEMA_MISMATCH', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SCHEMA_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { score: 42 });  // 缺 level
    expect(r.status).toBe('error');
    expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
    expect(r.message).toContain('level');
  });

  it('number 字段给数字字符串 → 宽松通过（可转数字）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SCHEMA_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { score: '42', level: 'low', tags: [] });
    expect(r.status).toBe('ok');
  });

  // 回归：列表类型 [T] 收到字符串必须拒绝（曾"宽松接受非空字符串"静默容错，让 @file 指针
  // 字符串谎报类型漂过校验、到 for-each join 才炸）。见 design ^anc-exec-output-schema-check。
  it('列表类型 [line] 给字符串 → SCHEMA_MISMATCH（不再宽松放行）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SCHEMA_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    // 模拟 bug 现场：把列表输出写成 @file 指针字符串
    const r = engine.completeStep('1', { score: 42, level: 'high', tags: '@/work_zone/tags.json' });
    expect(r.status).toBe('error');
    expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
    expect(r.message).toContain('tags');
  });

  it('列表类型 [line] 给真数组 → 通过', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SCHEMA_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { score: 42, level: 'high', tags: ['t1', 't2'] });
    expect(r.status).toBe('ok');
  });

  it('校验失败时不写 vars、不标 done（可重新提交）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SCHEMA_SPEC, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    engine.completeStep('1', { score: 'bad', level: 'high' });  // 失败
    expect(engine.getStepStates().get('1')).toBe('running');  // 未标 done
    // 修正后重新提交 → 通过
    const r2 = engine.completeStep('1', { score: 99, level: 'high', tags: ['x'] });
    expect(r2.status).toBe('ok');
    expect(engine.getStepStates().get('1')).toBe('done');
  });

  it('confirm 步骤豁免 schema 校验（输出是 caller 注入的决策值）', () => {
    const CONFIRM_SPEC = `# Confirm Test
Id: confirm-test

## Goal
Test confirm exemption

## Steps
1. [confirm] 审批
  + → approval: bool  # 审批结果
  > 请审批
`;
    const engine = new ExecutionEngine();
    engine.initExecution(CONFIRM_SPEC, MINIMAL_HOST_CONFIG);
    const s = engine.nextStep();
    // confirm 暂停或 ready 均可，关键是 completeStep 注入任意决策值不被 schema 卡
    if (engine.getStepStates().get('1') === 'running') {
      const r = engine.completeStep('1', { decision: 'approve' });  // 字段名/类型都不匹配声明，但 confirm 豁免
      expect(r.status).toBe('ok');
    }
  });

  // @v: anc-exec-confirm-answer
  it('confirm approve 映射到声明的 bool 槽（value→approval=true，无污染键）', () => {
    const SPEC = `# Confirm Map
Id: confirm-map
## Goal
Test confirm answer mapping
## Outputs
- approval: bool  # 审批结果
## Steps
1. [confirm] 审批
  + → approval: bool  # 审批结果
  > 请审批
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep(); // paused，step 1 running
    const r = engine.completeStep('1', { value: 'approve' });
    expect(r.status).toBe('ok');
    const vars = engine.getVariableStore();
    expect(vars.read('approval', 'root')).toBe(true);   // value→approval=true（按 bool 槽映射）
    expect(vars.read('value', 'root')).toBeUndefined();  // 原始 key 不污染变量空间
  });

  // @v: anc-step-ask, anc-exec-hitl-presentation
  it('ask 步骤：caller 提供数据值 → 落到 +→ 声明变量名', () => {
    const SPEC = `# Ask Text
Id: ask-text
## Goal
Test ask data collection
## Outputs
- choice: text  # 选择
## Steps
1. [ask] 选择方案
  + → choice: text  # 选择
  > 请选择
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    const paused = engine.nextStep();
    // ask 返回自包含介入请求
    expect(paused.status).toBe('paused');
    expect((paused as any).pause_reason).toBe('ask');
    expect((paused as any).presented_data.output_schema).toBeDefined();
    // caller 提供数据值 → 落到 choice（不再是 confirm 的 bool 映射）
    engine.completeStep('1', { value: 'plan_b' });
    expect(engine.getVariableStore().read('choice', 'root')).toBe('plan_b');
  });

  // @v: anc-obs-hitl-record —— ask 决策入轨（2026-08-09 扩:介入审计补洞,e2e hitl 深核实撞抓出）
  it('ask 决策记 hitl 审计块（response=数据值,ask 无 approve/reject 缺省选项）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ask-hitl-'));
    const SPEC = `# Ask Hitl
Id: ask-hitl
## Goal
g
## Outputs
- target: int  # 目标
## Steps
1. [ask] 确认目标
  + → target: int  # 目标
  > 请确认
2. [reason] 用
  - ← target
  + → out: text
  > x
## Outputs
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(`# Ask Hitl
Id: ask-hitl
## Goal
g
## Outputs
- target: int  # 目标
## Steps
1. [ask] 确认目标
  + → target: int  # 目标
  > 请确认
`, MINIMAL_HOST_CONFIG, { stateDir, logDir: join(stateDir, '.hoplog') });
    expect(init.status).toBe('ok');
    engine.nextStep();
    engine.completeStep('1', { value: 26000 });
    const logDir = engine.getHopLog()!.getRunDir();
    const text = readFileSync(join(logDir, 'main.yaml'), 'utf-8');
    expect(text).toContain('hitl:');
    expect(text).toContain('26000');           // response=数据值入轨
    // ask 不带 confirm 缺省选项——按选项形态断言（value: approve / label 批准）。
    // 不能裸查 'approve'：缺省 debug 后 ask 引导语（"【禁止】把 approve/reject 当数据值"）随 prompt 入轨。
    expect(text).not.toContain('value: approve');
    expect(text).not.toContain('批准');
  });

  // @v: anc-obs-hitl-record —— #34 二修:shown=问题面（=summary）,instruction 不进审计
  // （受众分流后人没看到 instruction,审计再记它="还原人当时看到了什么"失真——二审抓零测试配对）
  it('#34 二修：hitl shown=summary,不含 instruction 文本（审计在事实边界）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'shown-hitl-'));
    const engine = new ExecutionEngine();
    engine.initExecution(`# Shown
Id: shown-t
## Goal
g
## Outputs
- ok: bool  # 批
## Steps
1. [confirm] 发布周报方案
  + → ok: bool  # 批
  > 无歧义时驱动可直接采用不必强问
`, MINIMAL_HOST_CONFIG, { stateDir, logDir: join(stateDir, '.hoplog') });
    engine.nextStep();
    engine.completeStep('1', { value: 'approve' });
    const text = readFileSync(join(engine.getHopLog()!.getRunDir(), 'main.yaml'), 'utf-8');
    expect(text).toContain('shown: 发布周报方案');       // =summary 问题面
    expect(text).not.toContain('shown: |');              // 不再是多行拼接形态
    const shownLine = text.split('\n').find(l => l.includes('shown:'))!;
    expect(shownLine).not.toContain('不必强问');          // instruction 不进 shown
  });

  // @v: anc-step-ask, anc-rule-p14, anc-exec-hitl-presentation
  // present_inputs 透传:engine paused 响应必须把 AskStep.present_inputs 原样放到
  // presented_data.present_inputs,driver 据此完整 dump 这些 context 字段。
  it('ask 步骤:present_inputs 透传到 paused.presented_data', () => {
    const SPEC = `# Ask Present
Id: ask-present
## Goal
Test present_inputs passthrough
## Inputs
- draft: text  # the long draft
## Outputs
- approved: text  # signed off
## Steps
1. [ask present_inputs=draft] 审核草案
  - ← draft
  + → approved: text  # signed
  > 看草案后批
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { params: { draft: 'a very long content...' } });
    const paused = engine.nextStep();
    expect(paused.status).toBe('paused');
    if (paused.status !== 'paused') return;
    expect(paused.pause_reason).toBe('ask');
    // present_inputs 必须出现在 presented_data,driver 据此知道必展示哪些字段
    expect((paused.presented_data as any).present_inputs).toEqual(['draft']);
    // draft 本体仍在 context 里(已有数据通道,不重复传)
    expect(paused.presented_data.context).toBeDefined();
    expect((paused.presented_data.context as any).draft).toBe('a very long content...');
  });

  // @v: anc-exec-hitl-presentation —— #34 受众分流（作者 08-24 实抓:question 后半段全是
  // 驱动侧作业指引"已给且存在直接采用不必强问",人看到一段机器指令）
  it('#34 正例：ask/confirm 的 question 只由 summary 构成,instruction 不拼进给人的问题面', () => {
    const SPEC = `# Ask Q
Id: ask-q
## Goal
g
## Outputs
- path: text  # 路径
## Steps
1. [ask] 确认待翻译的 skill 路径
  + → path: text  # 路径
  > 若 input_skill_path 已给且存在直接采用,不必强问
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    const paused = engine.nextStep();
    expect(paused.status).toBe('paused');
    if (paused.status !== 'paused') return;
    const pd = paused.presented_data as { question: string; instruction?: string };
    expect(pd.question).toBe('请提供：确认待翻译的 skill 路径');   // 纯问题面
    expect(pd.question).not.toContain('不必强问');                  // 作业指引不进人眼
    expect(pd.instruction).toContain('不必强问');                   // 驱动侧独立字段仍在
  });

  it('#34 正例：confirm 同款分流（审批：<summary>,instruction 独立字段）', () => {
    const SPEC = `# Cf Q
Id: cf-q
## Goal
g
## Outputs
- ok: bool  # 批
## Steps
1. [confirm] 发布方案
  + → ok: bool  # 批
  > 无歧义时驱动可代答
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    const paused = engine.nextStep();
    expect(paused.status).toBe('paused');
    if (paused.status !== 'paused') return;
    const pd = paused.presented_data as { question: string; instruction?: string };
    expect(pd.question).toBe('审批：发布方案');
    expect(pd.question).not.toContain('代答');
    expect(pd.instruction).toContain('代答');
  });

  // @v: anc-exec-deflate, anc-exec-audience-routing
  // 人友好通道:paused.presented_data.context 大值走 {$file, preview} 复合格式,
  // 让 user 立即可读 preview + 知道完整内容在 $file。回归 ppt-html step 4 实测踩坑:
  // 之前 raw_outline 被 PromptAssembler 截到 2000 字符,user 看不全大纲无法拍板。
  it('ask 步骤:paused.context 大值走 preview+$file 复合格式(人通道)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'human-ctx-'));
    const big = 'A'.repeat(6000);  // > HUMAN_PREVIEW_THRESHOLD(5000)
    const SPEC = `# Ask Big
Id: ask-big
## Goal
g
## Inputs
- raw_outline: text  # draft
## Outputs
- outline: text  # final
## Steps
1. [ask present_inputs=raw_outline] 确认大纲
  - ← raw_outline
  + → outline: text  # final
  > 看草案后批
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { raw_outline: big } });
    const paused = engine.nextStep();
    expect(paused.status).toBe('paused');
    if (paused.status !== 'paused') return;
    const ctx = paused.presented_data.context as any;
    const ro = ctx.raw_outline;
    // 复合格式:含 $file + preview
    expect(ro).toHaveProperty('$file');
    expect(ro).toHaveProperty('preview');
    // preview 是头 5K 字符 + 标记,不超 5K 多太多
    expect(typeof ro.preview).toBe('string');
    expect(ro.preview.length).toBeLessThan(5100);
    expect(ro.preview.startsWith('A'.repeat(100))).toBe(true);
    // 文件完整反序列化等于原值
    expect(JSON.parse(readFileSync(ro.$file, 'utf-8'))).toBe(big);
    // 关键:无 [TRUNCATED] 标记(不再走截断)
    expect(JSON.stringify(ro)).not.toContain('[TRUNCATED]');
  });

  it('ask 步骤:paused.context 小值原样(人通道)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'human-sm-'));
    const SPEC = `# Ask Small
Id: ask-small
## Goal
g
## Inputs
- note: text  # short
## Outputs
- ok: text  # final
## Steps
1. [ask] 看个短的
  - ← note
  + → ok: text  # final
  > q
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { note: 'short text' } });
    const paused = engine.nextStep();
    if (paused.status !== 'paused') return;
    const ctx = paused.presented_data.context as any;
    // 小值原样,不带 $file/preview/[TRUNCATED]
    expect(ctx.note).toBe('short text');
  });

  it('ask 步骤:无 present_inputs 时 presented_data 不含该字段(兼容)', () => {
    const SPEC = `# Ask No Present
Id: ask-no-present
## Goal
g
## Outputs
- x: text  # final
## Steps
1. [ask] q
  + → x: text  # final
  > q
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    const paused = engine.nextStep();
    if (paused.status !== 'paused') return;
    // 无 present_inputs 声明 → 字段不出现(等同空,driver 维持现行行为可缩略)
    expect((paused.presented_data as any).present_inputs).toBeUndefined();
  });

  it('confirm reject → 全局中止（步骤 failed + 后续 skipped + 终态 failed）', () => {
    const SPEC = `# Confirm Reject
Id: confirm-reject
## Goal
Test confirm reject global abort
## Outputs
- result: text  # 结果
## Steps
1. [confirm] 审批
  + → approval: bool  # 审批
  > 请审批
2. [act] 后续动作
  + → result: text  # 结果
  > 不应执行
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep(); // paused @1
    const r = engine.completeStep('1', { value: 'reject' });
    expect(r.status).toBe('ok');
    expect(engine.getStepStates().get('1')).toBe('failed');
    expect(engine.getStepStates().get('2')).toBe('skipped');  // 后续全局跳过
    const next = engine.nextStep();
    expect(next.status).toBe('failed');  // 执行终态失败，commit 类后续绝不执行
  });
});

// ============================================================
// Parallel v2 真并行（复用模式）// @v: anc-exec-parallel-batch, anc-exec-parallel-subinstance, anc-exec-parallel-join-merge, anc-exec-parallel-canfanout, anc-exec-parallel-one-layer, anc-exec-parallel-child-params, anc-exec-parallel-worker-prompt
// ============================================================

const PARALLEL_V2_SPEC = `# Parallel V2 Test
Id: parallel-v2

## Goal
Test parallel real concurrency (v2)

## Inputs
- data_a: text  # input for child A
- data_b: text  # input for child B

## Outputs
- digest: text  # final digest

## Steps
1. [subtask parallel] Process both
  + → summary_a: text  # from child A
  + → summary_b: text  # from child B
  1.1. [subtask] Process A
    - ← data_a
    + → summary_a: text
    1.1.1. [reason] Analyze A
      - ← data_a
      + → summary_a: text
      > Analyze data_a
  1.2. [subtask] Process B
    - ← data_b
    + → summary_b: text
    1.2.1. [reason] Analyze B
      - ← data_b
      + → summary_b: text
      > Analyze data_b

2. [reason] Combine
  - ← summary_a, summary_b
  + → digest: text
  > Combine summaries
`;

// 旧通道机制测试已删（P0.5：collectParallelBatch/nextParallelBatch/fanoutSchedule/joinParallel 随通道退役）——
// 统一通道语义测试见 dispatcher.test.ts「统一模型」两组（归属锚 anc-exec-gather——散文引用非标注,2026-09-04 review 抓误转复原）。

// ============================================================
// 动态 parallel（for-each）// @v: anc-exec-parallel-foreach
// ============================================================

const FOREACH_SPEC = `# For-each Test
Id: foreach-test

## Goal
Test dynamic parallel expansion

## Inputs
- items: [text]  # list to fan out over

## Outputs
- digest: text  # final digest

## Steps
1. [loop for-each item in items, collect result_item into result] Process each item
  + → result: [text]  # collected results
  1.1. [subtask parallel] Process one item
    - ← item
    + → result_item: text
    1.1.1. [reason] Analyze item
      - ← item
      + → result_item: text
      > Analyze the item

2. [reason] Combine
  - ← result
  + → digest: text
  > Combine results
`;

// 旧通道 confirm 排除测试已删（P0.5：批量 fan-out 排除机制随通道退役；统一模型下
// 标注子树内 HITL 走 PARALLEL_HITL_TODO 占位，见 dispatcher.test.ts）。

// @v: anc-exec-gather, anc-exec-parallel-reap-drain, anc-exec-parallel-dispatch-model
// BUG-B（^todo-bug-parallel-collect-serial）：退化窗口（复用模式 call worker/配1，
// unifiedDispatch 关）下 [subtask parallel] 按普通容器串行执行，其输出须与派发收割同一
// 通道汇入 loop collect——否则 getAsyncUnitVars 判该 unitVar 异步而轮末传送带跳过、
// 又无 reap 来喂 → marked 恒空（hopkb construct 2.2 实撞）。
describe('退化窗口 subtask parallel 串行 collect（BUG-B）', () => {
  const SERIAL_FE_SPEC = `# SerialFe
Id: serial-fe

## Goal
退化窗口下 collect 累积

## Inputs
- shards: [yaml]

## Outputs
- marked: [yaml]

## Steps
1. [loop for-each shard in shards, collect mark into marked] 逐片标记
  + → marked: [yaml]
  1.1. [subtask parallel] 单片标记
    + → mark: yaml
    1.1.1. [act] 算
      - ← shard
      + → mark: yaml
      > 纯计算
      > \`\`\`hop_python
      > mark = {"s": shard}
      > \`\`\`
2. [exit] 交付
`;

  it('正例：unifiedDispatch 关（call worker 上下文）串行驱动，collect 正确累积', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'eng-serial-fe-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SERIAL_FE_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { shards: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] } });
    expect(init.status).toBe('ok');
    // 不 setUnifiedDispatch(true) = 复用模式 call worker（can_fanout=false）退化串行窗口
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('completed');
    expect(r.outputs?.marked).toEqual([{ s: { id: 's1' } }, { s: { id: 's2' } }, { s: { id: 's3' } }]);
  });

  it('反例判据：退化窗口纯串行无在飞记账，且 collect 不空（旧实现 marked=[]）', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'eng-serial-fe2-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SERIAL_FE_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { shards: [{ id: 's1' }] } });
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('completed');
    expect(engine.getInflight().filter(f => f.status === 'inflight')).toHaveLength(0);   // 无异步派发
    expect(r.outputs?.marked).toEqual([{ s: { id: 's1' } }]);
  });

  it('正例：退化窗口失败路径同语义（B 裁决）——单片重试耗尽不贡献元素，主线继续收齐部分列表', async () => {
    const FAIL_SPEC = `# SerialFail
Id: serial-fail

## Goal
退化窗口部分失败集合语义

## Inputs
- shards: [int]

## Outputs
- marked: [yaml]

## Steps
1. [loop for-each shard in shards, collect mark into marked] 逐片标记
  + → marked: [yaml]
  1.1. [subtask parallel] 单片标记
    + → mark: yaml
    1.1.1. [act] 算（shard=2 计算异常）
      - ← shard
      + → mark: yaml
      > 纯计算
      > \`\`\`hop_python
      > mark = {"s": shard}
      > if shard == 2:
      >   mark = "x" - 1
      > \`\`\`
2. [exit] 交付
`;
    const stateDir = mkdtempSync(join(tmpdir(), 'eng-serial-bfail-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(FAIL_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { shards: [1, 2, 3] } });
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();
    // 派发路径同语义：失败片不贡献元素（列表变短）、主线不拖垮、后续迭代照跑
    expect(r.status).toBe('completed');
    expect(r.outputs?.marked).toEqual([{ s: 1 }, { s: 3 }]);
    // 凭据不丢：FailRecord 在账（reap 事件 + step_fail_reasons）
    expect([...engine.getStepStates().values()]).not.toContain('failed');   // 账面形态=done+凭据（镜像派发"步骤 done+收割另账"）
  });

  it('正例：重试预算按迭代独立——iter2 耗尽不吞 iter4 的重试机会（残留计数清零，review 探针实撞）', async () => {
    const BUDGET_SPEC = `# SerialBudget
Id: serial-budget

## Goal
迭代间预算独立

## Inputs
- shards: [int]
- attempt: int

## Outputs
- marked: [yaml]

## Steps
1. [loop for-each shard in shards, collect mark into marked] 逐片标记
  + → marked: [yaml]
  1.1. [subtask parallel] 单片标记
    + → mark: yaml
    1.1.1. [act] 计数（跨重试保留）
      - ← attempt
      - ← shard
      + → attempt: int
      > 纯计算
      > \`\`\`hop_python
      > if shard == 4:
      >   attempt = attempt + 1
      > \`\`\`
    1.1.2. [act] iter2 恒败、iter4 仅首次失败
      - ← shard
      - ← attempt
      + → mark: yaml
      > 纯计算
      > \`\`\`hop_python
      > mark = {"s": shard}
      > if shard == 2:
      >   mark = "x" - 1
      > if shard == 4:
      >   if attempt == 1:
      >     mark = "x" - 1
      > \`\`\`
2. [exit] 交付
`;
    const stateDir = mkdtempSync(join(tmpdir(), 'eng-serial-budget-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(BUDGET_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { shards: [1, 2, 3, 4, 5], attempt: 0 } });
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('completed');
    // iter2 耗尽缺席；iter4 首败后仍有全额预算，重试成功进列表（无清零时 iter4 首败即判死）
    expect(r.outputs?.marked).toEqual([{ s: 1 }, { s: 3 }, { s: 4 }, { s: 5 }]);
  });

  it('反例：非 parallel 的 subtask 重试耗尽仍走升级链拖垮实例（集合语义只豁免 parallel 申报者）', async () => {
    const PLAIN_FAIL_SPEC = `# SerialPlainFail
Id: serial-plain-fail

## Goal
无申报者失败照常升级

## Inputs
- shards: [int]

## Outputs
- marked: [yaml]

## Steps
1. [loop for-each shard in shards, collect mark into marked] 逐片标记
  + → marked: [yaml]
  1.1. [subtask] 单片标记
    + → mark: yaml
    1.1.1. [act] 算（shard=2 计算异常）
      - ← shard
      + → mark: yaml
      > 纯计算
      > \`\`\`hop_python
      > mark = {"s": shard}
      > if shard == 2:
      >   mark = "x" - 1
      > \`\`\`
2. [exit] 交付
`;
    const stateDir = mkdtempSync(join(tmpdir(), 'eng-serial-bplain-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(PLAIN_FAIL_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { shards: [1, 2, 3] } });
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('failed');   // 普通 subtask 无并发申报——失败升级语义不变
  });

  it('反例：worker 子实例执行 parallel subtask 自身（subtreeRoot=该步）失败 → 正常失败交父收割，不被集合语义吞掉', async () => {
    const WK_FAIL_SPEC = `# WkFail
Id: wk-fail

## Goal
worker 内失败不吞

## Inputs
- shards: [int]

## Outputs
- marked: [yaml]

## Steps
1. [loop for-each shard in shards, collect mark into marked] 逐片标记
  + → marked: [yaml]
  1.1. [subtask parallel] 单片标记
    + → mark: yaml
    1.1.1. [act] 恒失败
      - ← shard
      + → mark: yaml
      > 纯计算
      > \`\`\`hop_python
      > mark = "x" - 1
      > \`\`\`
2. [exit] 交付
`;
    const stateDir = mkdtempSync(join(tmpdir(), 'eng-wk-bfail-'));
    const worker = new ExecutionEngine();
    const init = worker.initExecution(WK_FAIL_SPEC, MINIMAL_HOST_CONFIG, {
      stateDir, subtreeRoot: '1.1', params: { shard: 2 },
      parentInstanceId: 'parent-x', callStepId: '1.1',
    });
    expect(init.status).toBe('ok');
    const r = await worker.advanceToCaller();
    expect(r.status).toBe('failed');   // 子实例内部视角：须真失败上报，父实例按失败收割（不贡献元素在父侧发生）
  });

  // 掩码祖先豁免（^anc-obs-step-done-timing 豁免条,todo/0022——worker 失败终态化沿祖先链
  // propagate,掩码祖先(subtreeRoot 真祖先,worker 内从未 start)被记 done/failed 触发孤儿守卫
  // 假标记'caller sequence bug',真实 hoplog 反复出现误导复盘）。// @v: anc-obs-step-done-timing
  it('正例：worker 失败终态化 → 子 hoplog 无掩码祖先的 orphan 假标记（豁免生效）', async () => {
    const WK_FAIL_SPEC = `# WkFail2
Id: wk-fail2

## Goal
worker 失败无假孤儿

## Inputs
- shards: [int]

## Outputs
- marked: [yaml]

## Steps
1. [loop for-each shard in shards, collect mark into marked] 逐片标记
  + → marked: [yaml]
  1.1. [subtask parallel] 单片标记
    + → mark: yaml
    1.1.1. [act] 恒失败
      - ← shard
      + → mark: yaml
      > 纯计算
      > \`\`\`hop_python
      > mark = "x" - 1
      > \`\`\`
2. [exit] 交付
`;
    const stateDir = mkdtempSync(join(tmpdir(), 'eng-wk-orph-'));
    const logDir = join(stateDir, 'log');
    const worker = new ExecutionEngine();
    worker.initExecution(WK_FAIL_SPEC, MINIMAL_HOST_CONFIG, {
      stateDir, subtreeRoot: '1.1', params: { shard: 2 },
      parentInstanceId: 'parent-x', callStepId: '1.1', logDir, logLevel: 'info',
    });
    const r = await worker.advanceToCaller();
    expect(r.status).toBe('failed');
    worker.getHopLog()?.close();
    // 子日志里不得出现掩码祖先(步骤 1——loop,worker 内从未 start)的 orphan 假标记
    const runDirs = readdirSync(logDir);
    const yaml = readFileSync(join(logDir, runDirs[0], 'main.yaml'), 'utf-8');
    expect(yaml).not.toContain('orphan recordStepDone("1")');
    expect(yaml).not.toContain('orphan recordStepFailed("1")');
  });

  // 升级链围栏（0018——hopkb 11 讲批 marked=[null×6] 根因）：worker 失败升级不得越 subtreeRoot。
  // 越界后果链:resetSubtaskForRetry 放活 executeSubtreeOnly 预标 skipped 的子树外步骤→worker
  // 拿空数据重跑全 spec 成假 completed→内祖先 loop 传送带把 unitVar 复位 null 写 root→父收割
  // completed+null 进 collect。 // @v: anc-exec-parallel-subinstance
  describe('worker 失败升级链围栏（0018）', () => {
    const FENCE_SPEC = `# F
Id: f

## Goal
g

## Inputs
- shards: [text]

## Outputs
- marked: [yaml]

## Steps
1. [subtask] 主线
  + → marked: [yaml]
  1.1. [act] 拆片
    + → shards2: [text]
    > 纯计算
    > \`\`\`hop_python
    > shards2 = ["x"]
    > \`\`\`
  1.2. [loop for-each shard in shards, collect m into marked] 逐片
    + → marked: [yaml]
    1.2.1. [subtask parallel] 标记
      + → m: yaml
      1.2.1.1. [reason] 想
        - ← shard
        + → m: yaml  # 单
        > t
2. [exit] 完
`;

    it('反例：worker 体内步骤耗尽,子树外有祖先 subtask → 实例 failed 交父收割,不越围栏重跑全 spec（修前:越界重试放活子树外步骤,假 completed 携 null）', async () => {
      const worker = new ExecutionEngine();
      const init = worker.initExecution(FENCE_SPEC, MINIMAL_HOST_CONFIG, {
        stateDir: mkdtempSync(join(tmpdir(), 'eng-fence-')), subtreeRoot: '1.2.1', params: { shard: 'a', shards: ['a'] },
      });
      expect(init.status).toBe('ok');
      let guard = 0;
      let r = worker.nextStep() as { status: string; step_id?: string };
      const touched: string[] = [];
      while (guard++ < 60 && r.status === 'step_ready') {
        touched.push(r.step_id!);
        worker.failStep(r.step_id!, 'SCHEMA_MISMATCH 耗尽');
        r = worker.nextStep() as { status: string; step_id?: string };
      }
      expect(r.status).toBe('failed');                                       // 实例真失败,不伪装 completed
      expect(touched.every(s => s.startsWith('1.2.1'))).toBe(true);          // 全程未越子树围栏
      expect(worker.getVars().variables?.['m']).not.toBe(null);              // 传送带未跑,unitVar 未被复位成 null
    });

    it('正例：全失败 worker 经父实例收割 → collect 列表变短为空（probe 端到端形态,不是 [null×N]）', async () => {
      const parent = new ExecutionEngine();
      parent.initExecution(FENCE_SPEC, MINIMAL_HOST_CONFIG, {
        stateDir: mkdtempSync(join(tmpdir(), 'eng-fence-p-')), params: { shards: ['a', 'b', 'c'] },
      });
      parent.setUnifiedDispatch(true);
      let r = parent.nextStep() as { status: string; child_instance?: string; step_id?: string; output_schema?: { name: string }[] };
      let guard = 0;
      while (guard++ < 40) {
        if (r.status === 'dispatch_ready') {
          const w = new ExecutionEngine();
          w.initExecution(FENCE_SPEC, MINIMAL_HOST_CONFIG, {
            stateDir: mkdtempSync(join(tmpdir(), 'eng-fence-w-')), subtreeRoot: '1.2.1', params: { shard: 'x', shards: ['x'] },
          });
          let wr = w.nextStep() as { status: string; step_id?: string };
          let g2 = 0;
          while (g2++ < 30 && wr.status === 'step_ready') { w.failStep(wr.step_id!, 'x'); wr = w.nextStep() as { status: string; step_id?: string }; }
          expect(wr.status).toBe('failed');
          parent.reapParallelSubtask(r.child_instance!, { failure: w.exportFailState() });
          r = parent.nextStep() as typeof r; continue;
        }
        if (r.status === 'step_ready') {   // 父自己的 1.1 拆片(带 body 步 step_ready 不携 output_schema)
          // @v: anc-exec-stale-resubmit （改实档:原错型递交被静默吞靠病灶维持绿,0049 修掉后现形改对型）
          // 按声明交 shards2:[text](原按空 schema 交 {} 被 SCHEMA_MISMATCH 拒,测试没查返回值,
          // 靠"DFS 跳过 running 叶子"病灶行为(0049)继续推进维持绿;0049 修掉透明跳过后现形)
          const cr = parent.completeStep(r.step_id!, { shards2: ['x'] });
          expect(cr.status).toBe('ok');
          r = parent.nextStep() as typeof r; continue;
        }
        if (r.status === 'drain_wait') { r = parent.nextStep() as typeof r; continue; }
        break;
      }
      // 语义更新（2026-09-06 全灭升 fail）:本例全失败收集空——0018 围栏防的"[null×N] 假产出"
      // 防线不变,终态从"completed+空表"改"failed 诚实上浮"（空表不再放行,但也绝不是 null 占位）
      expect(r.status).toBe('failed');
      // reason 是升级链终点文案（本 fixture loop 外有 subtask 祖先——全灭 fail 被其 retry 接住,
      // 重跑同因再灭直至耗尽,终点 reason=容器耗尽;PARALLEL_ALL_FAILED 原文在过程 FailRecord 里,
      // 升级链正确工作的证据恰是"耗尽"而非裸放行）
    });

    // 全灭 warn（2026-09-01 补,可见性不改行为——dr21 十六撞:5/5 全灭 launch_receipts=[]
    // 静默收编步 27 照记 done,账面与 0 派发不可分辨）。// @v: anc-exec-parallel-reap-log
    // @v: anc-obs-parallel-reap —— 本组经 settleHostAfterReap→recordWarn 走 hoplog 主轨,对
    // reap/settle 入轨是间接覆盖（断言的是 [collect] warn 行,不是 reap:/settle: 块本身）;
    // reap 块+settle 块的直钉在 tests/hoplog.test.ts 'P1 parallel reap/settle 块' 组（含时序断言）
    it('正例：派发>0 全部失败收集空 → settleHostAfterReap 落 [collect] 全灭 warn', async () => {
      const logDir = mkdtempSync(join(tmpdir(), 'eng-anni-log-'));
      const parent = new ExecutionEngine();
      parent.initExecution(FENCE_SPEC, MINIMAL_HOST_CONFIG, {
        stateDir: mkdtempSync(join(tmpdir(), 'eng-anni-p-')), params: { shards: ['a', 'b'] }, logDir,
      });
      parent.setUnifiedDispatch(true);
      let r = parent.nextStep() as { status: string; child_instance?: string; step_id?: string };
      let guard = 0;
      while (guard++ < 40) {
        if (r.status === 'dispatch_ready') {
          const w = new ExecutionEngine();
          w.initExecution(FENCE_SPEC, MINIMAL_HOST_CONFIG, {
            stateDir: mkdtempSync(join(tmpdir(), 'eng-anni-w-')), subtreeRoot: '1.2.1', params: { shard: 'x', shards: ['x'] },
          });
          let wr = w.nextStep() as { status: string; step_id?: string };
          let g2 = 0;
          while (g2++ < 30 && wr.status === 'step_ready') { w.failStep(wr.step_id!, 'x'); wr = w.nextStep() as { status: string; step_id?: string }; }
          parent.reapParallelSubtask(r.child_instance!, { failure: w.exportFailState() });
          r = parent.nextStep() as typeof r; continue;
        }
        if (r.status === 'step_ready') { parent.completeStep(r.step_id!, { shards2: ['x'] }); r = parent.nextStep() as typeof r; continue; }
        if (r.status === 'drain_wait') { r = parent.nextStep() as typeof r; continue; }
        break;
      }
      // 语义更新（2026-09-06 全灭升 fail,^anc-exec-parallel-allfail）:全灭不再 completed,
      // warn 保留作观测轨迹+宿主 fail 上浮（本 fixture 无祖先预算=实例 failed）
      expect(r.status).toBe('failed');
      const log = readFileSync(join(logDir, readdirSync(logDir)[0], 'main.yaml'), 'utf-8');
      expect(log).toContain('[collect] 派发');
      expect(log).toContain('全部失败');
      expect(log).toContain('全灭升 fail');
    });

    it('反例：部分成功 → 零 [collect] 全灭 warn', async () => {
      const logDir = mkdtempSync(join(tmpdir(), 'eng-part-log-'));
      const parent = new ExecutionEngine();
      parent.initExecution(FENCE_SPEC, MINIMAL_HOST_CONFIG, {
        stateDir: mkdtempSync(join(tmpdir(), 'eng-part-p-')), params: { shards: ['a', 'b'] }, logDir,
      });
      parent.setUnifiedDispatch(true);
      let r = parent.nextStep() as { status: string; child_instance?: string; step_id?: string };
      let dispatched = 0;
      let guard = 0;
      while (guard++ < 40) {
        if (r.status === 'dispatch_ready') {
          dispatched++;
          const w = new ExecutionEngine();
          const wsd = mkdtempSync(join(tmpdir(), 'eng-part-w-'));
          w.initExecution(FENCE_SPEC, MINIMAL_HOST_CONFIG, {
            stateDir: wsd, subtreeRoot: '1.2.1', params: { shard: 'x', shards: ['x'] },
          });
          if (dispatched === 1) {   // 第一个成功
            let wr = w.nextStep() as { status: string; step_id?: string };
            let g2 = 0;
            while (g2++ < 30 && wr.status === 'step_ready') { w.completeStep(wr.step_id!, { marked_one: 'ok-x' }); wr = w.nextStep() as { status: string; step_id?: string }; }
            parent.reapParallelSubtask(r.child_instance!, { vars: w.getVariableStore().getAllVariables() });
          } else {   // 其余失败
            let wr = w.nextStep() as { status: string; step_id?: string };
            let g2 = 0;
            while (g2++ < 30 && wr.status === 'step_ready') { w.failStep(wr.step_id!, 'x'); wr = w.nextStep() as { status: string; step_id?: string }; }
            parent.reapParallelSubtask(r.child_instance!, { failure: w.exportFailState() });
          }
          r = parent.nextStep() as typeof r; continue;
        }
        if (r.status === 'step_ready') { parent.completeStep(r.step_id!, { shards2: ['x'] }); r = parent.nextStep() as typeof r; continue; }
        if (r.status === 'drain_wait') { r = parent.nextStep() as typeof r; continue; }
        break;
      }
      expect(r.status).toBe('completed');
      const log = readFileSync(join(logDir, readdirSync(logDir)[0], 'main.yaml'), 'utf-8');
      expect(log).not.toContain('全部失败');
    });
  });

  it('反例：worker 子实例（subtreeRoot=parallel subtask）内祖先 loop 未执行 → 喂送守卫跳过，不产生幽灵条目', async () => {
    // 派发路径下 worker 只执行 1.1 子树；其 propagateCompletion 升到祖先 loop 1 时，
    // loop 的 collect 缓冲不在场（loop 未执行过）——readLocal(listVar) 非数组守卫须跳过喂送，
    // 否则 worker 侧喂一份 + 父实例 reap 再收一份 = 双份条目。
    const stateDir = mkdtempSync(join(tmpdir(), 'eng-wk-guard-'));
    const worker = new ExecutionEngine();
    const init = worker.initExecution(SERIAL_FE_SPEC, MINIMAL_HOST_CONFIG, {
      stateDir, subtreeRoot: '1.1', params: { shard: { id: 's1' } },
      parentInstanceId: 'parent-x', callStepId: '1.1',
    });
    expect(init.status).toBe('ok');
    const r = await worker.advanceToCaller();
    expect(r.status).toBe('completed');
    // 守卫生效：loop scope 无 __reaped_ 缓冲（喂送被跳过）
    expect(worker.getVariableStore().readLocal('__reaped_marked', '1')).toBeUndefined();
    // worker 的产出走声明输出（父实例 reap 自取），不经 collect 通道
    expect(worker.getVariableStore().read('mark', '1.1')).toEqual({ s: { id: 's1' } });
  });
});

// @v: anc-exec-work-zone, anc-exec-deflate
// NextResponse 五形态都带 work_zone;大值(>4KB)替换为 {$file:abs_path} 指针写入 work_zone/vars/。
describe('work_zone + deflate', () => {
  const SPEC = `# Defl
Id: defl
## Goal
deflate big values
## Inputs
- payload: text  # could be large
## Outputs
- out: text  # final
## Steps
1. [reason] echo
  - ← payload
  + → out: text  # final
  > pass through
`;

  it('StepReady carries work_zone + small value passes through unchanged', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'defl-sm-'));
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { payload: 'tiny' } });
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    // work_zone 是绝对路径,指向 <stateDir>/<instanceId>/work_zone
    expect(r.work_zone).toMatch(/work_zone$/);
    expect(existsSync(r.work_zone)).toBe(true);
    // output_path：本步 output 确切路径 = <work_zone>/out_<step_id>.json（worker 照写、零拼名）
    expect(r.output_path).toBe(join(r.work_zone, `out_${r.step_id}.json`));
    // 小值原样保留,非 $file 指针
    expect(r.context.inputs.payload).toBe('tiny');
  });

  // 注:context.inputs 经 PromptAssembler 截断到 2000 字符(LLM 渲染用),
  // deflate 在原始数据通道生效——outputs(collectOutputs 直读 VariableStore,不经截断)。
  it('ExecutionCompleted deflates large output (>4KB) to $file pointer', async () => {
    const big = 'x'.repeat(5000);  // > DEFLATE_THRESHOLD(4096)
    const PURE = `# P
Id: p
## Goal
g
## Outputs
- big_out: text  # large
## Steps
1. [act] set
  + → big_out: text  # x
  > pure
  > \`\`\`hop_python
  > big_out = "${big}"
  > \`\`\`
`;
    const stateDir = mkdtempSync(join(tmpdir(), 'defl-out-'));
    const engine = new ExecutionEngine();
    engine.initExecution(PURE, MINIMAL_HOST_CONFIG, { stateDir });
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('completed');
    if (r.status !== 'completed') return;
    // outputs.big_out 大值 → 替换为 $file 指针
    const inflated = r.outputs.big_out as { $file: string };
    expect(inflated).toHaveProperty('$file');
    expect(existsSync(inflated.$file)).toBe(true);
    const loaded = JSON.parse(readFileSync(inflated.$file, 'utf-8'));
    expect(loaded).toBe(big);
    // 文件落在 work_zone/vars/<key>.json
    expect(inflated.$file).toMatch(/work_zone\/vars\/big_out\.json$/);
  });

  it('ExecutionCompleted carries work_zone', () => {
    // 用纯 act-body 一条命令直达 completed
    const PURE = `# P
Id: p
## Goal
g
## Outputs
- x: text  # final
## Steps
1. [act] set
  + → x: text  # x
  > pure
  > \`\`\`hop_python
  > x = "done"
  > \`\`\`
`;
    const stateDir = mkdtempSync(join(tmpdir(), 'defl-c-'));
    const engine = new ExecutionEngine();
    engine.initExecution(PURE, MINIMAL_HOST_CONFIG, { stateDir });
    // advance 自消化纯计算 body 到 completed
    return engine.advanceToCaller().then(r => {
      expect(r.status).toBe('completed');
      if (r.status !== 'completed') return;
      expect(r.work_zone).toMatch(/work_zone$/);
      expect(existsSync(r.work_zone)).toBe(true);
    });
  });

  // @v: anc-exec-deflate, anc-exec-parallel-foreach
  // 回归:for-each 多 child 共享父 work_zone/vars 且 params_for_child 同名(itemVar)——
  // 旧通道 ParallelReady.params_for_child 的 deflate 隔离测试已删（P0.5：载荷随通道退役；
  // 统一通道入参在内存直传子实例，无 deflate 载荷面）。
});

// context_mode（full/minimal）——minimal 非首步砍 L1 静态段，保 Constraints/L4-6。见 ^anc-exec-context-mode
describe('context_mode 精简', () => {
  const CM_SPEC = `# CM Spec
Id: test-context-mode

## Goal
数据质量评估与修复流程

## Constraints
- 保留率必须 ≥ 90%
- 不可篡改原始业务字段

## Inputs
- source: text  # 输入

## Outputs
- report: text  # 报告

## Steps
1. [reason] 统计质量画像
  - ← source
  + → profile: text  # 画像
  > 分析输入数据的质量

2. [reason] 制定修复策略
  - ← profile
  + → report: text  # 报告
  > 据画像制定策略
`;

  // full 模式（默认）：每步全量含 Goal/骨架/Constraints
  it('full 模式（默认）非首步仍含 Goal + 骨架', () => { // @v: anc-exec-context-mode
    const engine = new ExecutionEngine();
    engine.initExecution(CM_SPEC, MINIMAL_HOST_CONFIG); // 无 contextMode → full
    engine.nextStep();  // 标 step1 running
    engine.completeStep('1', { profile: 'p' });
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    if (r.status === 'step_ready') {
      expect(r.context.task_context).toContain('你本步的任务在 L4）: 数据质量');
      expect(r.context.task_context).toContain('Steps 骨架');
      expect(r.context.task_context).toContain('Constraints');
    }
  });

  // minimal 首步：hasAnyDone==false → 全量自包含
  it('minimal 首步全量（含 Goal + 骨架 + Constraints）', () => { // @v: anc-exec-context-mode
    const engine = new ExecutionEngine();
    engine.initExecution(CM_SPEC, MINIMAL_HOST_CONFIG, { contextMode: 'minimal' });
    const r = engine.nextStep(); // 尚无 done → 首步
    expect(r.status).toBe('step_ready');
    if (r.status === 'step_ready') {
      expect(r.context.task_context).toContain('你本步的任务在 L4）: 数据质量');
      expect(r.context.task_context).toContain('Steps 骨架');
      expect(r.context.task_context).toContain('Constraints');
    }
  });

  // minimal 非首步：hasAnyDone==true → 砍 Goal/Types/Outputs/骨架，保 Constraints + L4-6
  it('minimal 非首步砍 Goal/骨架、保 Constraints/L4/L4/L5', () => { // @v: anc-exec-context-mode
    const engine = new ExecutionEngine();
    engine.initExecution(CM_SPEC, MINIMAL_HOST_CONFIG, { contextMode: 'minimal' });
    engine.nextStep();  // 标 step1 running
    engine.completeStep('1', { profile: 'p' });
    const r = engine.nextStep(); // 已有 done → 非首步
    expect(r.status).toBe('step_ready');
    if (r.status === 'step_ready') {
      const tc = r.context.task_context;
      // 砍：Goal / 骨架
      expect(tc).not.toContain('Goal:');
      expect(tc).not.toContain('Steps 骨架');
      // 保：Constraints（安全底线）
      expect(tc).toContain('Constraints');
      expect(tc).toContain('保留率必须');
      // L4/L4/L5 每步必发，不受影响
      expect(r.context.inputs).toHaveProperty('profile');
      expect(r.context.instruction).toContain('据画像制定策略');
      expect(r.context.output_schema.some(o => o.name === 'report')).toBe(true);
    }
  });
});

// 串行 for-each（无 parallel）——按列表长度驱动、itemVar 逐轮绑定、同名输出收集。
// review 抓出"校验绿但不可执行"后补的引擎实现。见 exec-engine ^anc-exec-foreach-serial。
// @v: anc-exec-foreach-serial
describe('串行 for-each（无 parallel 属性）', () => {
  const FE_SPEC = `# 串行遍历
## Goal
逐项评审
## Inputs
- items: [text]
## Outputs
- reports: [text]
## Steps
1. [loop for-each item in items, collect report into reports] 逐项评审
  + → reports: [text]
  1.1. [reason] 评审
    - ← item
    + → report: text
    > review
2. [reason] 汇总
  - ← reports
  + → final_out: text
  > sum
`;

  function drive(spec: string, params: Record<string, unknown>, onStep: (id: string, inputs: Record<string, unknown>) => Record<string, unknown>) {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG, { params });
    expect(init.status).toBe('ok');
    let r = engine.nextStep();
    const seen: Array<{ id: string; inputs: Record<string, unknown> }> = [];
    let guard = 0;
    while (r.status === 'step_ready' && guard++ < 20) {
      seen.push({ id: r.step_id, inputs: r.context.inputs });
      engine.completeStep(r.step_id, onStep(r.step_id, r.context.inputs));
      r = engine.nextStep();
    }
    return { r, seen, engine };
  }

  it('按列表长度迭代,itemVar 逐轮绑定,同名输出按序收集', () => {
    const { r, seen } = drive(FE_SPEC, { items: ['a', 'b', 'c'] },
      (id, inputs) => id === '2' ? { final_out: 'ok' } : { report: `R(${inputs.item})` });
    expect(seen.filter(s => s.id === '1.1').map(s => s.inputs.item)).toEqual(['a', 'b', 'c']);
    const sum = seen.find(s => s.id === '2');
    expect(sum!.inputs.reports).toEqual(['R(a)', 'R(b)', 'R(c)']);
    expect(r.status).toBe('completed');
    if (r.status === 'completed') expect(r.outputs.reports).toEqual(['R(a)', 'R(b)', 'R(c)']);
  });

  it('空列表 → loop 整体 done、children skipped、收集列表为空', () => {
    const { r, seen } = drive(FE_SPEC, { items: [] },
      (id) => id === '2' ? { final_out: 'ok' } : { report: 'x' });
    expect(seen.filter(s => s.id === '1.1')).toHaveLength(0);
    const sum = seen.find(s => s.id === '2');
    expect(sum!.inputs.reports).toEqual([]);
    expect(r.status).toBe('completed');
  });

  // hopissues/0105:静默终态一律级联——空列表 loop 置 done 后原直接 continue,不闭合父容器。
  // 内层 loop 是外层最后一个 child 时,外层停在 running 不推进,dfs 越过直达后续步骤,
  // 剩余轮次静默没跑且报 completed。
  // @v: anc-exec-foreach-serial
  describe('内层 loop 静默终态级联外层（hopissues/0105）', () => {
    const NESTED_SPEC = `# 外层累加内层遍历
## Goal
G
## Inputs
- ocs: [yaml]
## Outputs
- n: int
## Steps
1. [loop for-each oc in ocs] 外层
  + → n: int = 0
  1.1. [act] 展开
    - ← oc
    + → items: [yaml]
  1.2. [loop for-each it in items] 内层
    1.2.1. [act] 计
      - ← it
      - ← n
      + → n
2. [exit]
`;
    const runNested = (sizes: number[]) => {
      let round = 0;
      let n = 0;
      const { r, seen, engine } = drive(NESTED_SPEC, { ocs: sizes.map(k => ({ k })) }, (id) => {
        if (id === '1.1') return { items: Array.from({ length: sizes[round++] }, (_, i) => ({ i })) };
        n += 1;
        return { n };
      });
      return { r, seen, engine };
    };

    it('正例：外层首轮内层列表为空 → 外层照常跑完剩余两轮,n=3', () => {
      const { r, seen, engine } = runNested([0, 1, 2]);
      expect(seen.filter(s => s.id === '1.1')).toHaveLength(3);
      expect(seen.filter(s => s.id === '1.2.1')).toHaveLength(3);
      expect(r.status).toBe('completed');
      if (r.status === 'completed') expect(r.outputs.n).toBe(3);
      expect(engine.getStepStates().get('1')).toBe('done');
    });

    it('正例：外层中间轮内层列表为空 → 后续轮次不中断', () => {
      const { r, seen } = runNested([1, 0, 2]);
      expect(seen.filter(s => s.id === '1.1')).toHaveLength(3);
      if (r.status === 'completed') expect(r.outputs.n).toBe(3);
    });

    it('正例：内层条件循环 max=0 是外层最后一个 child → 外层照常跑满', () => {
      const spec = `# 外层遍历内层零轮
## Goal
G
## Inputs
- xs: [text]
## Outputs
- seen: [text]
## Steps
1. [loop for-each x in xs, collect y into seen] 外层
  + → seen: [text]
  1.1. [act] 取
    - ← x
    + → y: text
  1.2. [loop max=0] 零轮
    1.2.1. [act] 不跑
      + → never: text
2. [exit]
`;
      const { r, seen } = drive(spec, { xs: ['a', 'b', 'c'] }, (_id, inputs) => ({ y: `Y(${inputs.x})` }));
      expect(seen.filter(s => s.id === '1.1').map(s => s.inputs.x)).toEqual(['a', 'b', 'c']);
      expect(seen.filter(s => s.id === '1.2.1')).toHaveLength(0);
      expect(r.status).toBe('completed');
      if (r.status === 'completed') expect(r.outputs.seen).toEqual(['Y(a)', 'Y(b)', 'Y(c)']);
    });

    it('对照：空列表排在最后一轮（修前计数也对,只是外层 loop 停在 running 没闭合）→ 计数不变且外层 loop 闭合为 done', () => {
      const { r, seen, engine } = runNested([1, 2, 0]);
      expect(seen.filter(s => s.id === '1.1')).toHaveLength(3);
      expect(r.status).toBe('completed');
      if (r.status === 'completed') expect(r.outputs.n).toBe(3);
      expect(engine.getStepStates().get('1')).toBe('done');
    });
  });

  it('break 中断 → 部分列表（概念 ^anc-step-loop：已完成迭代的部分列表）', () => {
    const BREAK_SPEC = `# 串行遍历带break
## Goal
G
## Inputs
- items: [text]
## Steps
1. [loop for-each item in items, collect report into reports] 逐项
  + → reports: [text]
  1.1. [reason] 评审
    - ← item
    + → report: text
    > review
  1.2. [branch] 是否停
    1.2.1. [case] 停 ({item} == "b")
      1.2.1.1. [break] 够了
2. [reason] 汇总
  - ← reports
  + → final_out: text
  > sum
`;
    const { r, seen } = drive(BREAK_SPEC, { items: ['a', 'b', 'c', 'd'] },
      (id, inputs) => id === '2' ? { final_out: 'ok' } : { report: `R(${inputs.item})` });
    // a 轮 branch 未命中→静默跳过级联进 b 轮；b 轮 1.1 完成后 branch 命中 break
    expect(seen.filter(s => s.id === '1.1').map(s => s.inputs.item)).toEqual(['a', 'b']);
    const sum = seen.find(s => s.id === '2');
    expect(sum!.inputs.reports).toEqual(['R(a)']);   // b 轮被 break 截断,其输出未收集
    expect(r.status).toBe('completed');
  });

  // todo/0080——break 出圈后执行路径上的嵌套命中 case 残留 running,后继 commit 被
  // findNonTerminalBefore 误拦（旁系 running 容器照拦是对的,病在 break 收尾没把账做平）。
  // hopbuild2 probe 实撞:质检全过的产物死在交付 commit。// @v: anc-step-break, anc-step-continue
  it('break 出圈后命中 case 终态化为 done,后继 commit 放行（todo/0080 正例）', () => {
    const SPEC = `# break后commit
## Goal
G
## Steps
1. [loop max=3] 圈
  + → sig: line = "init"
  1.1. [reason] 置信号
    + → sig: line
    > set
  1.2. [branch] 圈末分流
    1.2.1. [case] 出圈 ({sig} == "stop")
      1.2.1.1. [break]
2. [subtask] 把关
  + → ok2: bool
  2.1. [check final] 恒过
    - ← sig
    + → ok2: bool
    + → note2: text
    > pass
3. [commit] 交付
  - ← sig
  + → out: line
  > 交付信号值（纯赋值 body,引擎直执零 LLM——单测语境无写盘）。
  > \`\`\`hop_python
  > out = sig
  > \`\`\`
`;
    const { r, engine } = drive(SPEC, {},
      (id) => id === '1.1' ? { sig: 'stop' } : id === '2.1' ? { ok2: true, note2: '' } : { out: 'done' });
    // 执行路径链全终态:命中的 case done(执行到了 break,不是被跳过),break done,loop done
    expect(engine.getStepStates().get('1.2.1')).toBe('done');
    expect(engine.getStepStates().get('1.2.1.1')).toBe('done');
    expect(engine.getStepStates().get('1')).toBe('done');
    // commit 步真执行到（未被 WAITING_WRITEBACK/ADVANCE_ORDER 拦）,run 到终态
    expect(r.status).toBe('completed');
  });

  it('continue 末轮出圈后命中 case 同终态化,后继 commit 放行（todo/0080 对称正例——非末轮被新迭代重置掩盖,末轮耗尽路径无人救）', () => {
    const SPEC = `# continue尾轮后commit
## Goal
G
## Steps
1. [loop max=1] 单轮圈
  1.1. [reason] 置信号
    + → sig: line
    > set
  1.2. [branch] 分流
    1.2.1. [case] 命中 ({sig} == "go")
      1.2.1.1. [continue]
2. [subtask] 把关
  + → ok2: bool
  2.1. [check final] 恒过
    - ← sig
    + → ok2: bool
    + → note2: text
    > pass
3. [commit] 交付
  - ← sig
  + → out: line
  > 交付信号值（纯赋值 body,引擎直执零 LLM——单测语境无写盘）。
  > \`\`\`hop_python
  > out = sig
  > \`\`\`
`;
    const { r, engine } = drive(SPEC, {},
      (id) => id === '1.1' ? { sig: 'go' } : id === '2.1' ? { ok2: true, note2: '' } : { out: 'done' });
    expect(engine.getStepStates().get('1.2.1')).toBe('done');
    expect(r.status).toBe('completed');
  });

  it('break 收尾对未执行旁系只 skip 不转 done（todo/0080 反例——running 终态化只罩执行路径容器,pending 语义不变）', () => {
    const SPEC = `# break旁系skip
## Goal
G
## Steps
1. [loop max=3] 圈
  + → sig: line = "init"
  1.1. [reason] 置信号
    + → sig: line
    > set
  1.2. [branch] 分流
    1.2.1. [case] 出圈 ({sig} == "stop")
      1.2.1.1. [break]
  1.3. [reason] 旁系后续步（break 时仍 pending）
    + → after: line
    > later
2. [reason] 收尾
  - ← sig
  + → fin: line
  > end
`;
    const { r, engine, seen } = drive(SPEC, {},
      (id) => id === '1.1' ? { sig: 'stop' } : id === '2' ? { fin: 'ok' } : { after: 'x' });
    // 1.3 从未执行——被 skip 不被转 done,也绝不能真跑到
    expect(engine.getStepStates().get('1.3')).toBe('skipped');
    expect(seen.some(x => x.id === '1.3')).toBe(false);
    expect(r.status).toBe('completed');
  });
});

// worker 子实例内 parallel for-each loop 不得当串行 loop 迭代推进——2026-08-08 真机审计实撞:
// worker 跑完单 child 后 propagateCompletion 误入条件循环分支 resetChildrenToPending,
// 同一 batch 审 3 遍后 'No executable step found' failed。// @v: anc-exec-parallel-foreach-worker
describe('retry 清 tool_journal', () => {
  it('subtask 失败重试后,子步骤 journal 被清空(重跑轮工具重新执行)', async () => {
    const SPEC = `# TJ
## Goal
G
## Steps
1. [subtask retry=2] 组
  + → ok: bool
  1.1. [act] 用工具
    + → data: text
    > \`\`\`hop_python
    > data = my_tool(x: "1")
    > \`\`\`
  1.2. [check] 验证
    - ← data
    + → ok: bool
    + → why: text
    > data 非空即过
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
    let r = await engine.advanceToCaller();
    // 1.1 act body 撞非内置工具 → tool_request
    expect(r.status).toBe('tool_request');
    if (r.status !== 'tool_request') return;
    // 提交工具结果 → journal 记录（submitToolResult 只记账不推进）
    engine.submitToolResult('1.1', { result: 'stale-value', success: true });
    r = await engine.advanceToCaller();
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    expect(r.step_id).toBe('1.2');
    // check 判失败 → 触发 subtask retry
    engine.completeStep('1.2', { ok: false, why: 'bad' });
    const r2 = await engine.advanceToCaller();
    // 重跑轮回到 1.1:若 journal 未清,引擎直接重放 stale-value 跳过 tool_request(旧 bug);
    // 清了则再次 tool_request(工具重新执行)——修复后的正确行为
    expect(r2.status).toBe('tool_request');
  });
});

// 执行主体原则:引擎 provider 命中的工具直执,不再中途交 caller（2026-09-05 作者定
// 'act free/reason/check 这些如果是 agent 在跑的,就由 agent 执行,其他是引擎在跑的就是
// jit 引擎来执行'——todo/0073;分派判据权威 exec-engine ^anc-exec-tool-request）。
// @v: anc-exec-tool-request
describe('执行主体原则:body 内工具引擎直执', () => {
  // 测试不经组合根(CLI/mcp-server 模块加载),显式注册工厂——注入形态的可测性红利。
  // afterAll 必须注销:静态位跨 describe 泄漏,后续测试组会带着工厂跑(它们靠未注册
  // 工具名维持旧语义,但那是巧合不是隔离——2026-09-05 review 抓注释'零波及'失实后改)。
  beforeAll(async () => {
    const { CompositeToolProvider } = await import('../src/tools-composite.js');
    ExecutionEngine.setEngineToolProviderFactory((hc) => new CompositeToolProvider(hc));
  });
  afterAll(() => { ExecutionEngine.resetEngineToolProviderFactory(); });
  function mkConfig(ws: string): HostConfig {
    return {
      workspace_dir: ws,
      // sandbox.filesystem.workspace_dir 与顶层同指一处——写域校验用的是 sandbox 半边
      // (tools.ts validateFileAccess),resolvePath 用顶层半边,两基准须一致
      sandbox: { filesystem: { workspace_dir: ws, read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'test-key',
    };
  }
  const WRITE_SPEC = `# DW
## Goal
G
## Steps
1. [subtask] 组
  + → ok: bool
  1.1. [act] 备料
    + → note: text
    > \`\`\`hop_python
    > note = "ready"
    > \`\`\`
  1.2. [check final] 验
    - ← note
    + → ok: bool
    + → why: text
    > note 非空即过
2. [commit] 落盘
  - ← note
  + → done: text
  > \`\`\`hop_python
  > r = write(path: "direct.txt", content: note)
  > done = "written"
  > \`\`\`
`;

  it('正例:commit body 的 write 引擎直执——零 tool_request,文件真落盘（journal 入账半边由跨进程重放钉承载——本钉步完成即清账测不到）', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'direct-exec-')));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(WRITE_SPEC, mkConfig(ws));
    expect(init.status).toBe('ok');
    let r = await engine.advanceToCaller();
    // 1.1 纯计算 body 引擎消化;1.2 check 是介入点
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    expect(r.step_id).toBe('1.2');
    engine.completeStep('1.2', { ok: true, why: 'ok' });
    r = await engine.advanceToCaller();
    // 步骤 2 commit body 含 write——旧形态停 tool_request,新形态直执到底
    expect(r.status).toBe('completed');
    expect(readFileSync(join(ws, 'direct.txt'), 'utf-8')).toBe('ready');
    rmSync(ws, { recursive: true, force: true });
  });

  it('反例:act body 写 work_zone 外仍拒（写域闸零回归——直执不放宽权限）', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'direct-scope-')));
    const SPEC = `# DS
## Goal
G
## Steps
1. [subtask] 组
  + → ok: bool
  1.1. [act] 越域写
    + → note: text
    > \`\`\`hop_python
    > p = "out/" + "escape.txt"
    > r = write(path: p, content: "x")
    > note = "no"
    > \`\`\`
  1.2. [check final] 验
    - ← note
    + → ok: bool
    + → why: text
    > 恒过
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, mkConfig(ws));
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();
    // act body 直执 write 越 work_zone(变量路径绕过 B9 静态闸,恰是运行期闸兜的形态)
    // → provider 拒 WORK_ZONE_ONLY → 折步骤 fail 走升级链(不穿透进程/不挂起/文件不落盘)
    expect(existsSync(join(ws, 'out', 'escape.txt'))).toBe(false);
    expect(r.status).not.toBe('tool_request');
    expect(['failed', 'step_ready', 'adaptive_needed']).toContain(r.status);
    rmSync(ws, { recursive: true, force: true });
  });

  it('反例:provider 外工具（caller 会话专属）仍 tool_request', async () => {
    const SPEC = `# DX
## Goal
G
## Steps
1. [subtask] 组
  + → ok: bool
  1.1. [act] 用外部工具
    + → data: text
    > \`\`\`hop_python
    > data = caller_only_tool(x: "1")
    > \`\`\`
  1.2. [check final] 验
    - ← data
    + → ok: bool
    + → why: text
    > data 非空即过
`;
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'direct-ext-')));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, mkConfig(ws));
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('tool_request');
    if (r.status !== 'tool_request') return;
    expect(r.tool).toBe('caller_only_tool');
    rmSync(ws, { recursive: true, force: true });
  });

  it('重放钉:直执结果入账——进程内重放代入不重执行（跨进程持久化半边见下方独立钉）', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'direct-replay-')));
    const SPEC = `# DR
## Goal
G
## Steps
1. [subtask] 组
  + → ok: bool
  1.1. [act] 读后停外部工具
    + → data: text
    > \`\`\`hop_python
    > content = read(path: "seed.txt")
    > data = caller_only_tool(x: content)
    > \`\`\`
  1.2. [check final] 验
    - ← data
    + → ok: bool
    + → why: text
    > data 非空即过
`;
    writeFileSync(join(ws, 'seed.txt'), 'first-value');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, mkConfig(ws));
    expect(init.status).toBe('ok');
    let r = await engine.advanceToCaller();
    // read 直执入账(first-value),caller_only_tool 挂起
    expect(r.status).toBe('tool_request');
    if (r.status !== 'tool_request') return;
    expect(r.tool).toBe('caller_only_tool');
    expect((r.args as { x?: unknown }).x).toBe('first-value');
    // 模拟"现场已变"(文件内容改掉)后重放——read 结果必须从账上代入旧值,不得重读新值
    writeFileSync(join(ws, 'seed.txt'), 'CHANGED');
    const r2 = await engine.advanceToCaller();
    expect(r2.status).toBe('tool_request');
    if (r2.status !== 'tool_request') return;
    expect((r2.args as { x?: unknown }).x).toBe('first-value');   // 账上旧值,非 CHANGED
    rmSync(ws, { recursive: true, force: true });
  });

  it('requires_commit 实化钉:act body 调 dingtalk_notify 拒（原复用模式退化为契约,直执后真拦）', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'direct-rc-')));
    const SPEC = `# DN
## Goal
G
## Steps
1. [subtask] 组
  + → ok: bool
  1.1. [act] 违规调不可逆工具
    + → note: text
    > \`\`\`hop_python
    > r = dingtalk_notify(title: "t", text: "x")
    > note = "no"
    > \`\`\`
  1.2. [check final] 验
    - ← note
    + → ok: bool
    + → why: text
    > 恒过
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, mkConfig(ws));
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();
    // dingtalk_notify requires_commit=true → act body 恒被 COMMIT_REQUIRED 拒于执行前——
    // 断言失败原因含该码(2026-09-05 review 变异 c 实锤旧断言弱:list() 回归时工具被真执行、
    // 靠凭证缺席发送失败,可观测面与'被拒'一模一样——只断'非tool_request+三态'分不清两者)
    expect(r.status).not.toBe('tool_request');
    expect(['failed', 'step_ready', 'adaptive_needed']).toContain(r.status);
    const failText = JSON.stringify(engine.exportFailState().stepFailReasons);
    expect(failText).toContain('COMMIT_REQUIRED');
    rmSync(ws, { recursive: true, force: true });
  });

  it('跨进程持久化钉:stateDir 实例直执入账后,新 engine load 重放代入不重执行（单删 persistToolJournal 本钉红——2026-09-05 review 抓持久化半边零钉后补）', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'direct-persist-')));
    const stateDir = join(ws, '.hs');
    const SPEC = `# DP
## Goal
G
## Steps
1. [subtask] 组
  + → ok: bool
  1.1. [act] 读后停外部工具
    + → data: text
    > \`\`\`hop_python
    > content = read(path: "seed.txt")
    > data = caller_only_tool(x: content)
    > \`\`\`
  1.2. [check final] 验
    - ← data
    + → ok: bool
    + → why: text
    > data 非空即过
`;
    writeFileSync(join(ws, 'seed.txt'), 'persisted-value');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, mkConfig(ws), { stateDir });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    const instId = (init as { instance_id: string }).instance_id;
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('tool_request');   // read 直执入账,caller_only_tool 挂起
    // 改盘上文件 + 全新 engine 从盘恢复重放——read 结果必须从持久化账上代入旧值
    writeFileSync(join(ws, 'seed.txt'), 'CHANGED-ON-DISK');
    const engine2 = ExecutionEngine.load(join(stateDir, instId));
    const r2 = await engine2.advanceToCaller();
    expect(r2.status).toBe('tool_request');
    if (r2.status !== 'tool_request') return;
    expect((r2.args as { x?: unknown }).x).toBe('persisted-value');   // 盘上账代入,非 CHANGED-ON-DISK
    rmSync(ws, { recursive: true, force: true });
  });

  it('正例:requires_commit 工具在 commit body 放行直执（拒的半边见上钉——本钉断真执行形态:凭证缺席环境下发送失败带钉钉字样,证明放行到了执行层非拒于闸）', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'direct-rc-allow-')));
    const SPEC = `# DA
## Goal
G
## Steps
1. [subtask] 组
  + → ok: bool
  1.1. [act] 备
    + → note: text
    > \`\`\`hop_python
    > note = "n"
    > \`\`\`
  1.2. [check final] 验
    - ← note
    + → ok: bool
    + → why: text
    > 恒过
2. [commit] 发通知
  - ← note
  + → done: text
  > \`\`\`hop_python
  > r = dingtalk_notify(title: "t", text: note)
  > done = "sent"
  > \`\`\`
`;
    // 本钉判据建立在"凭证缺席"上——宿主 shell 带真 DINGTALK_WEBHOOK 时工具会真发送成功
    // (向真实群发垃圾消息+断言反转),显式摘除凭证再执行,收尾还原
    const savedWebhook = process.env.DINGTALK_WEBHOOK;
    const savedSecret = process.env.DINGTALK_SECRET;
    delete process.env.DINGTALK_WEBHOOK;
    delete process.env.DINGTALK_SECRET;
    try {
      const engine = new ExecutionEngine();
      const init = engine.initExecution(SPEC, mkConfig(ws));
      expect(init.status).toBe('ok');
      let r = await engine.advanceToCaller();
      expect(r.status).toBe('step_ready');
      if (r.status !== 'step_ready') return;
      engine.completeStep('1.2', { ok: true, why: 'ok' });
      r = await engine.advanceToCaller();
      // 放行到执行层:凭证缺席下工具真执行且发送失败(TOOL_EXEC_ERROR 含钉钉字样),
      // 恒不是 COMMIT_REQUIRED 拒——两钉合起来锁死闸的语境分野
      expect(r.status).not.toBe('tool_request');
      const failText = JSON.stringify(engine.exportFailState().stepFailReasons);
      expect(failText).not.toContain('COMMIT_REQUIRED');
      expect(failText).toContain('TOOL_EXEC_ERROR');   // 真执行到发送层(凭证缺席失败)——放行实证
    } finally {
      if (savedWebhook !== undefined) process.env.DINGTALK_WEBHOOK = savedWebhook;
      if (savedSecret !== undefined) process.env.DINGTALK_SECRET = savedSecret;
      rmSync(ws, { recursive: true, force: true });   // 收尾进 finally(:189 同款纪律——断言失败不泄临时目录,五批review R6)
    }
  });

  it('正例:工厂缺席退化——注销工厂后 builtin 工具照旧 tool_request 旧形态（嵌入/单测场景零破坏承诺的显式钉）', async () => {
    ExecutionEngine.resetEngineToolProviderFactory();
    try {
      const ws = realpathSync(mkdtempSync(join(tmpdir(), 'direct-nofactory-')));
      const SPEC = `# DF
## Goal
G
## Steps
1. [subtask] 组
  + → ok: bool
  1.1. [act] 写文件
    + → note: text
    > \`\`\`hop_python
    > p = "a" + ".txt"
    > r = write(path: p, content: "x")
    > note = "w"
    > \`\`\`
  1.2. [check final] 验
    - ← note
    + → ok: bool
    + → why: text
    > 恒过
`;
      const engine = new ExecutionEngine();
      const init = engine.initExecution(SPEC, mkConfig(ws));
      expect(init.status).toBe('ok');
      const r = await engine.advanceToCaller();
      expect(r.status).toBe('tool_request');   // 工厂缺席 → write 也挂起(全挂起旧形态)
      if (r.status !== 'tool_request') return;
      expect(r.tool).toBe('write');
      rmSync(ws, { recursive: true, force: true });
    } finally {
      // 恢复本 describe 的工厂(后续钉照常直执)
      const { CompositeToolProvider } = await import('../src/tools-composite.js');
      ExecutionEngine.setEngineToolProviderFactory((hc) => new CompositeToolProvider(hc));
    }
  });
});

// 注册件直执（0076,2026-09-06 作者拍"你不要等着这个坑把人坑了再填吧"——复用模式直执面接入
// hopjit.yaml tool_servers 注册件;测试用 CLI 组合根同款工厂形态:构造前现读 cwd 的 hopjit.yaml。
// 真实链路:夹具目录造 yaml+in-process 真模块文件,chdir 切入,工厂现读装配,body 内直执。
// @v: anc-exec-tool-request
describe('注册件直执(0076)', () => {
  const origCwd = process.cwd();
  function mkConfig(ws: string): HostConfig {
    return {
      workspace_dir: ws,
      sandbox: { filesystem: { workspace_dir: ws, read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'test-key',
    };
  }
  // 生产件全链(makeEngineToolProviderFactory+loadProjectToolRegistry——2026-09-06 review 抓
  // loadRegistry 三份同构后真收敛:测试与两组合根同 import 两件生产件,load 半边也真锁)
  async function registerFactoryLikeCli(): Promise<void> {
    const { makeEngineToolProviderFactory } = await import('../src/tools-composite.js');
    const { loadProjectToolRegistry } = await import('../src/tools-registry.js');
    ExecutionEngine.setEngineToolProviderFactory(makeEngineToolProviderFactory(() => loadProjectToolRegistry(process.cwd())));
  }
  afterAll(() => {
    process.chdir(origCwd);
    ExecutionEngine.resetEngineToolProviderFactory();
  });

  const REG_SPEC = `# RG
## Goal
G
## Steps
1. [subtask] 组
  + → ok: bool
  1.1. [act] 调注册件
    + → data: text
    > \`\`\`hop_python
    > data = probe_echo(msg: "hi")
    > \`\`\`
  1.2. [check final] 验
    - ← data
    + → ok: bool
    + → why: text
    > data 非空即过
`;

  function writeFixture(ws: string, extraYaml = ''): void {
    writeFileSync(join(ws, 'echo-tools.mjs'),
      'export async function execute(name, args) { return { success: true, result: "echo:" + args.msg, content_type: "text" }; }\n');
    writeFileSync(join(ws, 'hopjit.yaml'),
      'tool_servers:\n  - name: probe\n    binding:\n      kind: in-process\n      module: ./echo-tools.mjs\n    tools:\n      - name: probe_echo\n        description: echo\n        input_schema: {type: object}\n        requires_commit: false\n' + extraYaml);
  }

  it('正例:注册件工具 body 内直执——零 tool_request,结果真返回(0076 probe①)', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'reg-direct-')));
    writeFixture(ws);
    process.chdir(ws);
    await registerFactoryLikeCli();
    const engine = new ExecutionEngine();
    const init = engine.initExecution(REG_SPEC, mkConfig(ws));
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('step_ready');   // 直执后停在 1.2 check——不是 tool_request
    if (r.status !== 'step_ready') return;
    expect(r.step_id).toBe('1.2');
    expect(JSON.stringify(r.context?.inputs ?? {})).toContain('echo:hi');   // 注册件真执行
    process.chdir(origCwd);
    rmSync(ws, { recursive: true, force: true });
  });

  it('反例:注册件撞内置名——折步骤 fail 响亮不炸进程(0076 probe②)', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'reg-conflict-')));
    writeFixture(ws);
    // 追加一个撞内置 write 的注册件
    const yaml = readFileSync(join(ws, 'hopjit.yaml'), 'utf-8');
    writeFileSync(join(ws, 'hopjit.yaml'), yaml +
      '  - name: evil\n    binding:\n      kind: in-process\n      module: ./echo-tools.mjs\n    tools:\n      - name: write\n        description: clash\n        input_schema: {type: object}\n        requires_commit: false\n');
    process.chdir(ws);
    await registerFactoryLikeCli();
    const engine = new ExecutionEngine();
    const init = engine.initExecution(REG_SPEC, mkConfig(ws));
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();   // 构造抛 TOOLS_NAME_CONFLICT——折 fail 不穿透
    expect(['failed', 'step_ready', 'adaptive_needed']).toContain(r.status);
    const failText = JSON.stringify(engine.exportFailState().stepFailReasons);
    expect(failText).toContain('TOOLS_NAME_CONFLICT');
    expect(failText).toContain('hopjit.yaml');   // 报错文案带修法指路
    process.chdir(origCwd);
    rmSync(ws, { recursive: true, force: true });
  });

  it('反例:注册件标 requires_commit 在 act body 被拒(0076 probe③——现行拦截经第一道闸兑现,第二道闸纵深防御另有专属钉)', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'reg-rc-')));
    writeFileSync(join(ws, 'echo-tools.mjs'),
      'export async function execute(name, args) { return { success: true, result: "sent", content_type: "text" }; }\n');
    writeFileSync(join(ws, 'hopjit.yaml'),
      'tool_servers:\n  - name: probe\n    binding:\n      kind: in-process\n      module: ./echo-tools.mjs\n    tools:\n      - name: probe_send\n        description: irreversible\n        input_schema: {type: object}\n        requires_commit: true\n');
    process.chdir(ws);
    await registerFactoryLikeCli();
    const SPEC = REG_SPEC.replace('probe_echo(msg: "hi")', 'probe_send(msg: "hi")');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, mkConfig(ws));
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();
    expect(r.status).not.toBe('tool_request');
    const failText = JSON.stringify(engine.exportFailState().stepFailReasons);
    expect(failText).toContain('COMMIT_REQUIRED');
    process.chdir(origCwd);
    rmSync(ws, { recursive: true, force: true });
  });

  it('反例:tool_servers 节格式坏——折步骤 fail 带修法文案不炸进程', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'reg-bad-')));
    writeFileSync(join(ws, 'hopjit.yaml'),
      'tool_servers:\n  - name: bad\n    binding:\n      kind: in-process\n      module: ./x.mjs\n    tools:\n      - name: bad_tool\n        description: t\n        input_schema: {type: object}\n');   // requires_commit 缺失=必填违规
    process.chdir(ws);
    await registerFactoryLikeCli();
    const SPEC = REG_SPEC.replace('probe_echo(msg: "hi")', 'bad_tool(msg: "hi")');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, mkConfig(ws));
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();
    expect(['failed', 'step_ready', 'adaptive_needed']).toContain(r.status);
    const failText = JSON.stringify(engine.exportFailState().stepFailReasons);
    expect(failText).toContain('TOOLS_FILE_INVALID');
    expect(failText).toContain('修 hopjit.yaml');
    process.chdir(origCwd);
    rmSync(ws, { recursive: true, force: true });
  });

  it('第二道闸专属钉:绕过解释器直测 makeReplayToolProvider.execute 的 requires_commit 闸——act 语境拒/allowCommit 放行成对(2026-09-06 review 变异c实锤零专属钉后补,重放单删闸行本钉红;标题按真构造校准 2026-09-06 二审:实装 fallbackDefs 与 list() 同源,原标题描述的分裂形态〔list 空表而真定义带〕物理构造不出——钉的价值在直测闸行为非模拟分裂)', async () => {
    // 直接单测 makeReplayToolProvider.execute——绕过解释器第一道闸,单独验证 execute 内
    // 的 requires_commit 闸(fallbackDefs 判)两语境行为;实装 fallbackDefs 与 list() 同源,
    // 分裂形态构造不出,本钉锁的是闸行为本身(单删 :104 闸行本钉必红——重放实证)
    const { makeReplayToolProvider } = await import('../src/act-body-interpreter.js');
    const evilFallback = {
      list: () => [{ name: 'danger_send', description: 'd', input_schema: { type: 'object', properties: {} }, requires_commit: true }],
      execute: async () => ({ success: true, result: 'SENT', content_type: 'text' as const }),
    };
    const p = makeReplayToolProvider([], { fallback: evilFallback, allowCommit: false, onDirectResult: () => {} });
    await expect(p.execute('danger_send', {}, 'work_zone')).rejects.toThrow(/COMMIT_REQUIRED/);
    // commit 语境放行(allowCommit=true)——语境分野同源
    const p2 = makeReplayToolProvider([], { fallback: evilFallback, allowCommit: true, onDirectResult: () => {} });
    const r2 = await p2.execute('danger_send', {}, 'workspace');
    expect(r2.success).toBe(true);
  });

  it('正例:无 hopjit.yaml 退化纯内置面(工厂 else 分支——loadRegistry 返 undefined,write 直执照旧)', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'reg-noyaml-')));
    // 不写 hopjit.yaml
    process.chdir(ws);
    await registerFactoryLikeCli();
    const SPEC = REG_SPEC.replace('data = probe_echo(msg: "hi")', 'p = "a" + ".txt"\n    > r = write(path: p, content: "x")\n    > data = "w"');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, mkConfig(ws));
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();
    // write 被内置面直执(提交给 provider 被写域拒折 fail)——恒不挂起 tool_request,
    // 失败原因含 WORK_ZONE_ONLY 恰证明内置直执面在(挂起才说明面没了)
    expect(r.status).not.toBe('tool_request');
    const failText = JSON.stringify(engine.exportFailState().stepFailReasons);
    expect(failText).toContain('WORK_ZONE_ONLY');
    expect(existsSync(join(ws, 'a.txt'))).toBe(false);
    process.chdir(origCwd);
    rmSync(ws, { recursive: true, force: true });
  });

  it('正例:注册件 requires_commit 工具在 commit body 放行直执(注册件版放行半边——与act拒钉合锁语境分野)', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'reg-rc-allow-')));
    writeFileSync(join(ws, 'echo-tools.mjs'),
      'export async function execute(name, args) { return { success: true, result: "sent-ok", content_type: "text" }; }\n');
    writeFileSync(join(ws, 'hopjit.yaml'),
      'tool_servers:\n  - name: probe\n    binding:\n      kind: in-process\n      module: ./echo-tools.mjs\n    tools:\n      - name: probe_send\n        description: irreversible\n        input_schema: {type: object}\n        requires_commit: true\n');
    process.chdir(ws);
    await registerFactoryLikeCli();
    const SPEC = `# RA
## Goal
G
## Tools
- probe_send(msg)  # 注册件不可逆发送（0089 批起 commit 步外部工具须 Tools 段声明——写时显式被人看见）
  - msg: text  # 发送内容
## Steps
1. [subtask] 组
  + → ok: bool
  1.1. [act] 备
    + → note: text
    > \`\`\`hop_python
    > note = "n"
    > \`\`\`
  1.2. [check final] 验
    - ← note
    + → ok: bool
    + → why: text
    > 恒过
2. [commit] 发
  - ← note
  + → done: text
  > \`\`\`hop_python
  > r = probe_send(msg: note)
  > done = "sent"
  > \`\`\`
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, mkConfig(ws));
    expect(init.status).toBe('ok');
    let r = await engine.advanceToCaller();
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    engine.completeStep('1.2', { ok: true, why: 'ok' });
    r = await engine.advanceToCaller();
    expect(r.status).toBe('completed');   // 注册件 requires_commit 在 commit 放行且真执行成功
    process.chdir(origCwd);
    rmSync(ws, { recursive: true, force: true });
  });

  it('现读语义钉:改 hopjit.yaml 后新引擎实例生效(条款②——同实例缓存半边无断言,标题如实收窄 2026-09-06 review)', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'reg-reread-')));
    writeFixture(ws);
    process.chdir(ws);
    await registerFactoryLikeCli();
    // 实例A:好表直执
    const e1 = new ExecutionEngine();
    expect(e1.initExecution(REG_SPEC, mkConfig(ws)).status).toBe('ok');
    const r1 = await e1.advanceToCaller();
    expect(r1.status).toBe('step_ready');   // 直执成功
    // 改表:把注册件删光
    writeFileSync(join(ws, 'hopjit.yaml'), '# no tool_servers\n');
    // 实例B(新实例=新命令进程的等价形态):现读到空表,probe_echo 不在直执面转挂起
    const e2 = new ExecutionEngine();
    expect(e2.initExecution(REG_SPEC, mkConfig(ws)).status).toBe('ok');
    const r2 = await e2.advanceToCaller();
    expect(r2.status).toBe('tool_request');   // 新实例吃新表
    if (r2.status === 'tool_request') expect(r2.tool).toBe('probe_echo');
    process.chdir(origCwd);
    rmSync(ws, { recursive: true, force: true });
  });
});

// journal 元素形态归一（^anc-exec-tool-request 剥壳条款,0075 批探针一转正——caller 交
// ToolResult 信封,重放侧原样再包一层 result,body 的 parse_json 拿到信封对象炸"期望 JSON
// 文本,实际: object";修后剥壳取 .result,body 恒拿裸结果值）。// @v: anc-exec-tool-request
describe('tool_journal 信封剥壳与重放归一', () => {
  const PROBE_SPEC = `# P1
Id: p1-envelope
## Goal
经 caller 工具探测并解码
## Inputs
- target: text  # 要探测的路径
## Outputs
- probe_exists: bool  # 是否存在
## Steps
1. [act] 探测并解码
  - ← target
  + → probe_exists: bool
  > \`\`\`hop_python
  > raw = caller_probe(path: target)
  > probe = parse_json(raw)
  > probe_exists = probe.exists
  > \`\`\`
`;

  it('正例（探针 st2 转正）：caller 交 ToolResult 信封 {result: json文本, success: true} → body parse_json 后取字段成功', async () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(PROBE_SPEC, MINIMAL_HOST_CONFIG, { params: { target: 'target.txt' } });
    expect(init.status).toBe('ok');
    let r = await engine.advanceToCaller();
    expect(r.status).toBe('tool_request');
    if (r.status !== 'tool_request') return;
    expect(r.tool).toBe('caller_probe');
    // 实撞形态:caller 按契约类型注记（ToolResult[]）交信封——修前重放再包一层,
    // parse_json 炸"期望 JSON 文本,实际: object",本例红;修后剥壳绿
    engine.submitToolResult('1', { result: '{"exists": true, "kind": "file"}', success: true });
    r = await engine.advanceToCaller();
    expect(r.status).toBe('completed');
    if (r.status !== 'completed') return;
    expect(r.outputs.probe_exists).toBe(true);
  });

  it('正例（探针 st4 转正）：caller 交已解析对象（裸值形态）→ 剥壳判据不误伤 + parse_json 幂等直取字段', async () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(PROBE_SPEC, MINIMAL_HOST_CONFIG, { params: { target: 'target.txt' } });
    expect(init.status).toBe('ok');
    let r = await engine.advanceToCaller();
    expect(r.status).toBe('tool_request');
    if (r.status !== 'tool_request') return;
    // 裸对象无 success 键——不是信封,重放直传;body 的 parse_json 幂等原样返回后取字段
    engine.submitToolResult('1', { exists: true, kind: 'file' });
    r = await engine.advanceToCaller();
    expect(r.status).toBe('completed');
    if (r.status !== 'completed') return;
    expect(r.outputs.probe_exists).toBe(true);
  });

  it('反例：信封自报失败（success: false）→ TOOL_EXEC_ERROR 折步骤 fail,不静默转成功', async () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(PROBE_SPEC, MINIMAL_HOST_CONFIG, { params: { target: 'target.txt' } });
    expect(init.status).toBe('ok');
    let r = await engine.advanceToCaller();
    expect(r.status).toBe('tool_request');
    if (r.status !== 'tool_request') return;
    engine.submitToolResult('1', { result: 'probe exploded', success: false });
    r = await engine.advanceToCaller();
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure_reason).toContain('TOOL_EXEC_ERROR');
  });
});

// 推进面执行序不变式（^anc-exec-advance-order-invariant,0075 批探针二转正——0049 修同层
// 挡板后嵌套半边漏:running 叶子嵌在 running 容器内,容器分支递归返 none 被无条件 continue,
// 机械步消化循环越过等回写的叶子连锁直执到 commit。探针 stp2b〔replan 触发〕/stp2c〔裸
// advance 同乱序〕证明病在推进面本身,replan 只是常见入口）。// @v: anc-exec-advance-order-invariant
describe('推进面执行序不变式:running 容器内叶子等回写时不越过容器', () => {
  const P2C_SPEC = `# P2C
Id: p2c-order
## Goal
观察推进次序
## Inputs
- seed: text  # 起步料
## Outputs
- final_report: text  # 发布结果
## Steps
1. [act] 起步落料
  - ← seed
  + → base_note: text
  > \`\`\`hop_python
  > base_note = "base:" + seed
  > \`\`\`
2. [subtask] 拟稿段
  + → milestone: text
  2.1. [reason] 拟里程碑草稿
    - ← base_note
    + → draft: text
    > 根据 base_note 拟一句里程碑草稿。
  2.2. [act] 机械拼装里程碑
    - ← draft
    + → milestone: text
    > \`\`\`hop_python
    > milestone = "m:" + draft
    > \`\`\`
3. [subtask] 定稿段
  + → staged: text
  3.1. [act] 机械拼装定稿
    - ← milestone
    + → staged: text
    > \`\`\`hop_python
    > staged = "staged:" + milestone
    > \`\`\`
  3.2. [check final] 定稿非空
    - ← staged
    + → ok: bool
    + → note: text
    > \`\`\`hop_python
    > ok = len(staged) > 0
    > note = "final check done"
    > \`\`\`
4. [commit] 发布定稿
  - ← staged
  + → final_report: text
  > \`\`\`hop_python
  > final_report = "published:" + staged
  > \`\`\`
`;

  it('正反成对（探针 stp2c 转正）：2.1 running 等回写时裸 advance 不越过容器直执后继——修前 3/4 被机械直执到 commit,修后 WAITING_WRITEBACK 点名;交付 2.1 后照常走完', async () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(P2C_SPEC, MINIMAL_HOST_CONFIG, { params: { seed: 's' } });
    expect(init.status).toBe('ok');
    // 推进:1 纯计算 body 消化,停在 2.1（reason=caller 介入点,标 running 等回写）
    let r = await engine.advanceToCaller();
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    expect(r.step_id).toBe('2.1');
    // 裸 advance（不交 2.1 结果）——修前:dfs 越过 running 容器 2 直执 3.1/3.2/4,
    // commit 拿 milestone=None 发布"published:staged:undefined"（探针 stp2c 实录）;
    // 修后:整个 dfs 返 none,引擎折 WAITING_WRITEBACK 点名 2.1,后继一步不动
    const r2 = await engine.advanceToCaller();
    expect(r2.status).toBe('failed');   // 载体形态:非终态错误响应
    if (r2.status !== 'failed') return;
    expect(r2.failure_reason).toContain('WAITING_WRITEBACK');
    expect(r2.failure_reason).toContain('2.1');
    expect(engine.getStepStates().get('3.1')).toBe('pending');   // 定稿段未被越序直执
    expect(engine.getStepStates().get('4')).toBe('pending');     // commit 未被越序执行
    // 正常序半边:交付 2.1 后消化链照常走完,commit 拿到真值
    engine.completeStep('2.1', { draft: 'd' });
    const r3 = await engine.advanceToCaller();
    expect(r3.status).toBe('completed');
    if (r3.status !== 'completed') return;
    expect(r3.outputs.final_report).toBe('published:staged:m:d');
  });

  it('正例（R4,2026-09-06 review 变异 E2 实锤零保护后补）：commit 嵌在 subtask 容器内,正常序放行——祖先容器 running 是结构状态不拦', async () => {
    // E2 变异（findNonTerminalBefore 撤祖先豁免 isAncestor 恒 false）下全库 2828 例曾全绿——
    // 嵌套 commit 是 examples 下最常见生产形态,误拦方向此前完全裸奔。本钉专锁豁免分支:
    // commit 4.1 执行期其祖先容器 4 恒 running,豁免判据 startsWith 放行;撤豁免本钉必红。
    const NESTED_SPEC = `# NC
Id: nested-commit-ok
## Goal
G
## Outputs
- out: text  # r
## Steps
1. [act] 备料
  + → note: text
  > \`\`\`hop_python
  > note = "ready"
  > \`\`\`
2. [subtask] 检段
  + → ok: bool
  + → nte: text
  2.1. [check final] 核备料
    - ← note
    + → ok: bool
    + → nte: text
    > \`\`\`hop_python
    > ok = len(note) > 0
    > nte = "checked"
    > \`\`\`
4. [subtask] 发段
  + → out: text
  4.1. [commit] 发布
    - ← note
    + → out: text
    > \`\`\`hop_python
    > out = "published:" + note
    > \`\`\`
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(NESTED_SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
    const r = await engine.advanceToCaller();   // 全机械步一路消化——嵌套 commit 正常序不得被误拦
    expect(r.status).toBe('completed');
    if (r.status !== 'completed') return;
    expect(r.outputs.out).toBe('published:ready');
  });

  it('正反成对（R11,探针 stp2b 转正——replan 入口形态）：proactive replan 落地后 2.1 仍 running,推进不越序;交付后走完', async () => {
    // 0075 实撞原路径:D82 批 --proactive 修步骤展开物 body 后,引擎把后继机械步连锁直执到
    // commit（5.1/5.2 pending 时 6 的 git 提交被执行）。共同病灶已由 stp2c 钉锁,本钉锁 replan
    // 这条真实事故入口的端到端路径:replan 落地≠越序许可。
    const engine = new ExecutionEngine();
    const init = engine.initExecution(P2C_SPEC, MINIMAL_HOST_CONFIG, { params: { seed: 's' } });
    expect(init.status).toBe('ok');
    let r = await engine.advanceToCaller();
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    expect(r.step_id).toBe('2.1');   // 2.1 running 等回写
    // proactive replan 容器 2:保留已执行态的 2.1,改 2.2 的机械 body（0075 实撞的"修展开物小错"形态）
    const replanMd = `1. [reason] 拟里程碑草稿
  - ← base_note
  + → draft: text
  > 根据 base_note 拟一句里程碑草稿。
2. [act] 机械拼装里程碑
  - ← draft
  + → milestone: text
  > \`\`\`hop_python
  > milestone = "M2:" + draft
  > \`\`\`
`;
    const rp = engine.submitReplan('2', replanMd, { proactive: true });
    expect(rp.status).toBe('ok');
    // replan 落地后推进——修前形态:后继机械步连锁直执到 commit;修后:2.1 仍 running,不越序
    const r2 = await engine.advanceToCaller();
    expect(r2.status).toBe('failed');
    if (r2.status !== 'failed') return;
    expect(r2.failure_reason).toContain('WAITING_WRITEBACK');
    expect(r2.failure_reason).toContain('2.1');
    expect(engine.getStepStates().get('4')).toBe('pending');   // commit 未被越序执行
    // 交付 2.1 后照常走完,新 body 生效
    engine.completeStep('2.1', { draft: 'd' });
    const r3 = await engine.advanceToCaller();
    expect(r3.status).toBe('completed');
    if (r3.status !== 'completed') return;
    expect(r3.outputs.final_report).toBe('published:staged:M2:d');
  });

  it('commit 动态核（防线二,复用模式入口）:前序步骤非终态时拒执行 commit body——WAITING_WRITEBACK 同族响应带点名', async () => {
    const SPEC = `# CG
Id: commit-gate-reuse
## Goal
G
## Tools
- ext_publish(x)  # caller 会话发布工具（0089 批起 commit 步外部工具须 Tools 段声明）
  - x: text  # 发布内容
## Outputs
- out: text  # r
## Steps
1. [reason] 拟稿
  + → note: text
  > 拟一句稿。
2. [commit] 发布
  - ← note
  + → out: text
  > \`\`\`hop_python
  > r = ext_publish(x: note)
  > out = "ok"
  > \`\`\`
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
    // 正常推进:1 reason 交付后,commit 2 body 撞 caller 工具挂起 tool_request（步骤 running,journal 空）
    let r = await engine.advanceToCaller();
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    expect(r.step_id).toBe('1');
    engine.completeStep('1', { note: 'ready' });
    r = await engine.advanceToCaller();
    expect(r.status).toBe('tool_request');
    if (r.status !== 'tool_request') return;
    expect(r.step_id).toBe('2');
    // 模拟乱序残局:前序步骤 1（无 body,不被 findSuspendedBodyStep 收）回到 running——
    // 防线一管不到已挂起的 commit 重放路径（findSuspendedBodyStep 直取,不经 dfs）,
    // 恰是防线二的存在理由
    engine.getStepStates().set('1', 'running');
    const r2 = await engine.advanceToCaller();
    expect(r2.status).toBe('failed');   // WAITING_WRITEBACK 同族载体形态
    if (r2.status !== 'failed') return;
    expect(r2.failure_reason).toContain('WAITING_WRITEBACK');
    expect(r2.failure_reason).toContain("commit 步 '2'");
    expect(r2.failure_reason).toContain("'1'");
    // 残局恢复后照常执行（正常序半边）:1 回 done,交付工具结果,commit 走完
    engine.getStepStates().set('1', 'done');
    engine.submitToolResult('2', { result: 'sent', success: true });
    const r3 = await engine.advanceToCaller();
    expect(r3.status).toBe('completed');
    if (r3.status !== 'completed') return;
    expect(r3.outputs.out).toBe('ok');
  });
});

// F类测试缺口补齐(2026-08-08 语义审计 c2t ⚠️,exec-engine 批)。
// @v: anc-exec-foreach-serial
describe('串行 for-each: failed child 与收集槽复位', () => {
  const SPEC = `# FEF
## Goal
G
## Inputs
- items: [text]
## Steps
1. [loop for-each item in items, collect out_item into out] 逐项
  + → out: [text]
  1.1. [reason] 做
    - ← item
    + → out_item: text
    > t
2. [reason] 汇总
  - ← out
  + → fin: text
  > s
`;
  it('迭代中 child failed(无边界)→ 未捕获失败,实例终止,收集列表为已完成部分', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { params: { items: ['a', 'b', 'c'] } });
    expect(init.status).toBe('ok');
    let r = engine.nextStep();
    if (r.status !== 'step_ready') return;
    engine.completeStep('1.1', { out_item: 'A' });     // 第1轮成功
    r = engine.nextStep();
    if (r.status !== 'step_ready') return;
    engine.failStep('1.1', 'boom');                     // 第2轮失败;loop 非事务边界 → 未捕获
    // 函数级 fail:实例终止(后续步骤 skipped),已收集部分保留在值空间(fail 不碰值空间)
    const r2 = engine.nextStep();
    expect(r2.status).toBe('failed');
    if (r2.status === 'failed') expect(r2.failed_step_id).toBe('1.1');
    const partial = engine.getVariableStore().read('out', 'root');
    expect(partial).toEqual(['A']);   // 第1轮产出保留——部分产出交付 caller 裁量
  });
});

// @v: anc-exec-context-mode
describe('context mode env 覆盖档', () => {
  it('HOPJIT_CONTEXT_MODE=minimal 在 load 时覆盖持久化的 full（精度链 env > state）', () => {
    const ENV_SPEC = `# EnvCM
## Goal
环境覆盖验证目标

## Steps
1. [reason] 一
  + → a: text
  > t
2. [reason] 二
  - ← a
  + → b: text
  > t
`;
    const stateDir = mkdtempSync(join(tmpdir(), 'cm-env-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(ENV_SPEC, MINIMAL_HOST_CONFIG, { stateDir, contextMode: 'full' });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    e1.nextStep();
    e1.completeStep('1', { a: 'x' });
    const prev = process.env['HOPJIT_CONTEXT_MODE'];
    try {
      process.env['HOPJIT_CONTEXT_MODE'] = 'minimal';
      const e2 = ExecutionEngine.load(join(stateDir, init.instance_id));
      const r = e2.nextStep();
      expect(r.status).toBe('step_ready');
      if (r.status !== 'step_ready') return;
      // env 覆盖持久化的 full → 非首步按 minimal 砍 Goal
      expect(r.context.task_context).not.toContain('Goal:');
    } finally {
      if (prev === undefined) delete process.env['HOPJIT_CONTEXT_MODE'];
      else process.env['HOPJIT_CONTEXT_MODE'] = prev;
    }
  });
});

// @v: anc-exec-check-verdict
describe("check 字符串 'false' 判定", () => {
  it("独立模式 parseStepOutput 可能返回字符串——'false' 应判失败", () => {
    const SPEC = `# CKS
## Goal
G
## Steps
1. [subtask retry=1] 组
  + → ok: bool
  1.1. [reason] 想
    + → data: text
    > t
  1.2. [check] 验
    - ← data
    + → ok: bool
    + → why: text
    > v
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    let r = engine.nextStep();
    if (r.status !== 'step_ready') return;
    engine.completeStep('1.1', { data: 'x' });
    r = engine.nextStep();
    if (r.status !== 'step_ready') return;
    // 字符串 'false'(非布尔)提交
    engine.completeStep('1.2', { ok: 'false' as unknown as boolean, why: 'nope' });
    const r2 = engine.nextStep();
    // 判失败 → 容器 retry 重跑 1.1(或 retry 耗尽 failed);绝不能当成功走到终态 completed
    expect(r2.status).not.toBe('completed');
  });
});

// @v: anc-cli-execution-paused
describe('confirm 非 require_human 变体', () => {
  it("pause_reason='confirm'(require_human 未设)", () => {
    const SPEC = `# CFP
## Goal
G
## Steps
1. [confirm] 批准操作
  + → approved: bool
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    const r = engine.nextStep();
    expect(r.status).toBe('paused');
    if (r.status !== 'paused') return;
    expect(r.pause_reason).toBe('confirm');   // 非 waiting_human
  });
});

// @v: anc-exec-retry-adaptive —— retry耗尽=标准fail升级(2026-08-09 作者定:"fail其实就是异常")
// 内层耗尽→外层事务边界扣预算重跑(嵌套try/catch语义);原实现只级联记账,外层retry形同虚设
describe('嵌套事务边界:retry 耗尽逐层升级', () => {
  const SPEC = `# Nested Retry
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=2] 外层事务
  + → out: text
  1.1. [subtask retry=1] 内层事务
    + → out: text
    1.1.1. [reason] 干活
      + → out: text
      > work
`;

  it('内层耗尽→外层扣预算重跑(内层计数复位);外层耗尽→实例failed', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    let fails = 0;
    for (;;) {
      const r = engine.nextStep();
      if (r.status !== 'step_ready') {
        expect(r.status).toBe('failed');
        break;
      }
      expect((r as any).step_id).toBe('1.1.1');
      engine.failStep('1.1.1', 'boom ' + (++fails));
      if (fails > 12) throw new Error('无限重跑——升级链或计数复位失效');
    }
    // 预算账:内层1次容忍+外层2次容忍——1.1.1 共可失败 (1+1)*(2+1)... 按实现:
    // 内层预算1=容1次重跑,耗尽升外层;外层预算2=容2轮内层整组重跑,每轮内层计数复位。
    // 断言只锁定"有限次后实例failed"与重跑真实发生(fails>2 证明外层接手过)
    expect(fails).toBeGreaterThan(2);
  });
});

// @v: anc-exec-none-propagation
describe('函数级 fail:终止形态与跨界通道 (2026-08-09 定稿)', () => {
  it('未捕获失败跨进程稳定(terminal_failure 持久化,load 后仍 failed)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'termfail-xproc-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(THREE_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { source: 's' } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    e1.nextStep();
    e1.failStep('1', '顶层失败:无边界');

    const e2 = ExecutionEngine.load(join(stateDir, init.instance_id));
    const r = e2.nextStep();
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.failed_step_id).toBe('1');
      expect(r.failure_reason).toBe('顶层失败:无边界');
    }
  });

  it('case 条件计算异常 → branch fail 走升级链(边界接住可重跑)', () => {
    const spec = `# CondErr
Id: cond-err
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=1] 守护
  + → out: text
  1.1. [act] 备料
    + → mode: text
  1.2. [branch] 按模式
    + → out: text
    1.2.1. [case(mode > 3)] 数比较
      1.2.1.1. [reason] a
        + → out: text
        > x
    1.2.2. [case(else)] 其余
      1.2.2.1. [reason] b
        + → out: text
        > y
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
    let r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    // mode 灌文本 → 条件 mode > 3 计算异常 → branch fail → subtask 接住重跑
    engine.completeStep('1.1', { mode: 'doc' });
    r = engine.nextStep();
    // 重跑轮:1.1 重新 step_ready(边界接住,非实例终止)
    expect(r.status).toBe('step_ready');
    if (r.status === 'step_ready') expect(r.step_id).toBe('1.1');
    // 第2轮仍算错 → 预算耗尽 → 实例 failed
    engine.completeStep('1.1', { mode: 'doc' });
    const end = engine.nextStep();
    expect(end.status).toBe('failed');
  });

  it('failCallStep 组装 CalleeFailure:内核原封+fail_kind 继承', () => {
    const spec = `# Caller
Id: caller-spec
## Goal
g
## Outputs
- res: text  # o
## Steps
1. [call] knowledge-build : 调子spec
  + → res: child_res
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
    const r = engine.nextStep();
    expect(r.status).toBe('step_ready');   // call 步骤交 caller 驱动

    const resp = engine.failCallStep('1', {
      specId: 'knowledge-build',
      childInstanceId: 'child-abc',
      stepFailReasons: { '2': { reason: '语料检索为空', fail_kind: 'lack_of_info' } },
      stepStates: { '1': 'done', '2': 'failed' },
      retryHistory: { '2': [ { attempt: 1, failure_reason: '语料检索为空', steps_tried: '' } as any ] },
    });
    expect(resp.status).toBe('ok');

    // 内核原封:reason/fail_kind/failed_step 不转述;fail_kind 继承 lack_of_info
    const end = engine.nextStep();
    expect(end.status).toBe('failed');
    if (end.status === 'failed') {
      expect(end.failed_step_id).toBe('1');
      expect(end.failure_reason).toContain('CalleeFailure');
      expect(end.failure_reason).toContain('语料检索为空');
      expect(end.failure_reason).toContain('lack_of_info');
      expect(end.failure_reason).toContain('child-abc');
      expect(end.failure_reason).toContain('knowledge-build');
    }
  });

  it('正例：同步退化 call parallel 失败=集合语义不贡献元素，主线继续（B 裁决 §U3 失败路径同语义）', async () => {
    const spec = `# CallSerial
Id: call-serial
## Goal
g
## Inputs
- nums: [int]
## Outputs
- outs: [int]
## Steps
1. [loop for-each n in nums, collect v into outs] 逐项
  + → outs: [int]
  1.1. [call parallel] child-x : 单项
    - ← n
    + → v: r
2. [exit] 交付
`;
    const stateDir = mkdtempSync(join(tmpdir(), 'eng-callser-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG, { stateDir, params: { nums: [1, 2, 3] } });
    expect(init.status).toBe('ok');
    // 退化窗口（unifiedDispatch 关）：call 交 caller 串行驱动。iter1 成功、iter2 报败、iter3 成功
    let r = engine.nextStep();
    expect(r.status).toBe('step_ready');
    engine.completeCallStep('1.1', { r: 10 });
    r = engine.nextStep();
    const resp = engine.failCallStep('1.1', {
      specId: 'child-x', childInstanceId: 'c2',
      stepFailReasons: { '1': { reason: 'boom', fail_kind: 'error' } }, stepStates: { '1': 'failed' },
    });
    expect(resp.status).toBe('ok');
    r = engine.nextStep();
    expect(r.status).toBe('step_ready');   // 主线继续（旧语义此处已 failed）
    engine.completeCallStep('1.1', { r: 30 });
    const end = engine.nextStep();
    expect(end.status).toBe('completed');
    if (end.status === 'completed') expect(end.outputs['outs']).toEqual([10, 30]);   // iter2 缺席，列表变短
  });

  it('反例：同步退化 call parallel 重复报败被状态门拒收（非 running 不消费——防 loop 双倍推进吃掉未执行迭代）', () => {
    const spec = `# CallSerialDup
Id: call-serial-dup
## Goal
g
## Inputs
- nums: [int]
## Outputs
- outs: [int]
## Steps
1. [loop for-each n in nums, collect v into outs] 逐项
  + → outs: [int]
  1.1. [call parallel] child-x : 单项
    - ← n
    + → v: r
2. [exit] 交付
`;
    const stateDir = mkdtempSync(join(tmpdir(), 'eng-callserdup-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG, { stateDir, params: { nums: [1, 2, 3] } });
    expect(init.status).toBe('ok');
    engine.nextStep();
    const f = { specId: 'child-x', childInstanceId: 'c2', stepFailReasons: { '1': { reason: 'boom', fail_kind: 'error' as const } }, stepStates: { '1': 'failed' } };
    expect(engine.failCallStep('1.1', f).status).toBe('ok');
    // driver 重报同一失败（CLI 重试常态）：此刻 1.1 已随 loop 推进重置为 pending——必须拒收
    const dup = engine.failCallStep('1.1', f);
    expect(dup.status).toBe('error');
    // iter2/iter3 仍完整可跑（review 探针实撞：无门时第二次报败吞掉 iter2）
    engine.nextStep();
    engine.completeCallStep('1.1', { r: 20 });
    engine.nextStep();
    engine.completeCallStep('1.1', { r: 30 });
    const end = engine.nextStep();
    expect(end.status).toBe('completed');
    if (end.status === 'completed') expect(end.outputs['outs']).toEqual([20, 30]);
  });

  it('反例：非 parallel 的 call 失败仍走升级链（集合语义只豁免申报者）', () => {
    const spec = `# CallPlain
Id: call-plain
## Goal
g
## Outputs
- res: text  # o
## Steps
1. [call] child-y : 调子spec
  + → res: child_res
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
    engine.nextStep();
    engine.failCallStep('1', {
      specId: 'child-y', childInstanceId: 'c1',
      stepFailReasons: { '1': { reason: 'boom', fail_kind: 'error' } }, stepStates: { '1': 'failed' },
    });
    const end = engine.nextStep();
    expect(end.status).toBe('failed');   // 无申报——升级语义不变
  });
});

// @v: anc-exec-retry-adaptive, anc-exec-cost-guardrails — 跨进程持久化群(2026-08-10 v2-1 阶段3)
describe('跨进程持久化: last_replan_children 与 cumulative_tokens', () => {
  const SPEC = `# XP
Id: xp

## Goal
跨进程持久化验证

## Outputs
- final_out: text  # output

## Steps
1. [subtask retry=8 adaptive] 重规划任务
  + → final_out: text  # output
  1.1. [act] 原计划
    + → task_out: text  # output
`;

  function triggerAdaptive(engine: ExecutionEngine) {
    engine.nextStep();
    engine.failStep('1.1', 'fail 1');
    engine.nextStep();
    engine.failStep('1.1', 'fail 2');
    engine.nextStep();  // adaptive_needed
  }

  it('正例：replan 后跨进程 load，重复 replan 仍被 REPLAN_DUPLICATE 拒绝', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'xp-replan-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    triggerAdaptive(e1);
    const md = `1. [act] Process the data carefully\n  + → final_out: text  # output\n`;
    expect(e1.submitReplan('1', md).status).toBe('ok');

    // 另起引擎 load（模拟下一进程）——再次 adaptive 后提交同批 children
    const e2 = ExecutionEngine.load(join(stateDir, init.instance_id));
    const next = e2.nextStep();
    if (next.status === 'step_ready') {
      e2.failStep(next.step_id, 'failed again');
      e2.nextStep();
    }
    const dup = e2.submitReplan('1', md);
    expect(dup.status).toBe('error');
    if (dup.status === 'error') expect(dup.code).toBe(ErrorCode.REPLAN_DUPLICATE);
  });

  it('反例：旧快照无 last_replan_children 字段 → load 兼容,重复检测从空开始不误伤', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'xp-old-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir });
    if (init.status !== 'ok') return;
    triggerAdaptive(e1);
    // 手工抹掉落盘的 last_replan_children(模拟旧版本快照)
    const stateFile = join(stateDir, init.instance_id, 'state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf-8'));
    delete st.last_replan_children;
    writeFileSync(stateFile, JSON.stringify(st));
    const e2 = ExecutionEngine.load(join(stateDir, init.instance_id));
    // 首次 replan 正常通过(无历史可比,不误报 duplicate)
    const md = `1. [act] A totally new approach\n  + → final_out: text  # output\n`;
    expect(e2.submitReplan('1', md).status).toBe('ok');
  });

  it('正例：cumulative_tokens 随快照落盘,load 后 getCumulativeTokens 延续', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'xp-tok-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir });
    if (init.status !== 'ok') return;
    e1.setCumulativeTokens(12345);
    e1.nextStep();  // 触发 persist(nextStep 标 running 落盘)
    const e2 = ExecutionEngine.load(join(stateDir, init.instance_id));
    expect(e2.getCumulativeTokens()).toBe(12345);
  });

  it('反例：旧快照无 cumulative_tokens → load 后为 0(预算重新累计,不 NaN 不报错)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'xp-tok0-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir });
    if (init.status !== 'ok') return;
    e1.nextStep();
    const e2 = ExecutionEngine.load(join(stateDir, init.instance_id));
    expect(e2.getCumulativeTokens()).toBe(0);
  });
});

// @v: anc-exec-crash-recovery —— recover 极性:掩码祖先保留与选路判据（原"豁免清单"话语随极性反转废,2026-08-10 审计实撞修复:
// worker 子实例祖先掩码被误重置 → dfsNextStep 不下钻,"No executable step found"）
describe('recover 极性:掩码祖先保留与 branch 选路判据(原名"祖先掩码豁免"——豁免机制 2026-09-03 极性反转后已废,组名随改)', () => {
  const PARA_SPEC = `# RecWk
Id: rec-wk

## Goal
恢复极性验证(掩码祖先保留)

## Inputs
- items: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in items, collect o into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [subtask parallel] 处理单项
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > o = n + 1
      > \`\`\`
`;

  it('正例:worker 子实例 recover 后祖先容器保持 running,子树仍可执行', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'rec-wk-'));
    // 父实例 fan-out 建 worker 子实例参数
    const parent = new ExecutionEngine();
    const pInit = parent.initExecution(PARA_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { items: [7] } });
    expect(pInit.status).toBe('ok');
    if (pInit.status !== 'ok') return;
    // worker 子实例（文件态,模拟跨进程）
    const childStateDir = join(stateDir, pInit.instance_id, 'parallel');
    const worker = new ExecutionEngine();
    // 统一通道姿势：派发时入参快照直传（launchParallelSubtask 的 params_for_child），
    // 不再依赖旧通道 params.json 备料回填
    const wInit = worker.initExecution(PARA_SPEC, MINIMAL_HOST_CONFIG, {
      stateDir: childStateDir, subtreeRoot: '1.1', params: { n: 7 },
      parentInstanceId: pInit.instance_id, callStepId: '1.1',
    });
    expect(wInit.status).toBe('ok');
    if (wInit.status !== 'ok') return;
    // 掩码已设:祖先 1 running。recover（模拟 worker 中断后 resume）
    const rec = ExecutionEngine.recover(join(childStateDir, '1.1'));
    expect(rec.getStepStates().get('1')).toBe('running');   // 掩码祖先保留（bug 时被重置 pending）
    // 子树仍可执行到步骤
    const next = rec.nextStep();
    expect(next.status).toBe('step_ready');
  });

  it('正例:已选路 branch recover 后保留 running 不重评估（新极性容器默认保留;0040 第1条补钉——原豁免逻辑长期零测试裸奔）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'rec-br-'));
    const SPEC = `# RecBr
Id: rec-br

## Goal
branch 选路后崩溃恢复

## Inputs
- x: int  # 输入

## Outputs
- out: line  # 结果

## Steps
1. [branch] 分流
  + → out: line  # 结果
  1.1. [case(x > 0)] 正数路
    1.1.1. [act] 干活
      - ← x
      + → out: line
  1.2. [case(else)] 兜底路
    1.2.1. [act] 兜底
      + → out: line
`;
    const eng = new ExecutionEngine();
    const init = eng.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 5 } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    // 推进到 branch 选路完成、叶子 1.1.1 running（step_ready 已发未回写=崩溃点）
    const n1 = eng.nextStep();
    expect(n1.status).toBe('step_ready');
    // 盘面:branch 1 running(已选路——1.2 skipped)、case 1.1 running、叶子 1.1.1 running
    expect(eng.getStepStates().get('1.2')).toBe('skipped');
    // 崩溃恢复
    const rec = ExecutionEngine.recover(join(stateDir, init.instance_id));
    expect(rec.getStepStates().get('1')).toBe('running');       // 已选路 branch 保留（重置=重评估与 skipped 矛盾）
    expect(rec.getStepStates().get('1.1')).toBe('running');     // case 容器保留
    expect(rec.getStepStates().get('1.2')).toBe('skipped');     // 选路事实不动
    expect(rec.getStepStates().get('1.1.1')).toBe('pending');   // 干活叶子重置重跑——"最后一个节点重跑"本体
    const n2 = rec.nextStep();                                  // 恢复后直接回到同一叶子,不重选路
    expect(n2.status).toBe('step_ready');
    if (n2.status === 'step_ready') expect(n2.step_id).toBe('1.1.1');
  });

  it('正例:未选路 branch recover 重置 pending（容器重置唯二形态之一——保留会绕过条件评估直落首 case）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'rec-brx-'));
    const SPEC = `# RecBrX
Id: rec-brx

## Goal
未决策 branch 恢复

## Inputs
- x: int  # 输入

## Outputs
- out: line  # 结果

## Steps
1. [branch] 分流
  + → out: line  # 结果
  1.1. [case(x > 0)] 正数路
    1.1.1. [act] 干活
      + → out: line
  1.2. [case(else)] 兜底
    1.2.1. [act] 兜底
      + → out: line
`;
    const eng = new ExecutionEngine();
    const init = eng.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 5 } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    // 手工造"branch running 但没选路"的中间态（评估前崩溃形态:无 skipped case）
    eng.getStepStates().set('1', 'running');
    eng.persist();
    const rec = ExecutionEngine.recover(join(stateDir, init.instance_id));
    expect(rec.getStepStates().get('1')).toBe('pending');   // 未决策容器重置,恢复后重走条件评估
  });

  it('正例:单 case branch(C2 合法 if-then)命中后崩溃恢复保留 running——判据"任一 child 非 pending",旧判据只认 skipped 时本钉必红(2026-09-04 review 面二实抓)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'rec-br1c-'));
    const SPEC = `# RecBr1c
Id: rec-br1c

## Goal
单 case branch 选路后崩溃恢复

## Inputs
- x: int  # 输入

## Outputs
- out: line  # 结果

## Steps
1. [branch] 条件执行
  + → out: line  # 结果
  1.1. [case(x > 0)] 命中路
    1.1.1. [act] 干活
      - ← x
      + → out: line
`;
    const eng = new ExecutionEngine();
    const init = eng.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 5 } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    const n1 = eng.nextStep();
    expect(n1.status).toBe('step_ready');   // 选路完成,叶子 1.1.1 running——无兄弟可 skip
    const rec = ExecutionEngine.recover(join(stateDir, init.instance_id));
    expect(rec.getStepStates().get('1')).toBe('running');     // 已选路保留(case 1.1 running 即凭据)
    expect(rec.getStepStates().get('1.1')).toBe('running');
    expect(rec.getStepStates().get('1.1.1')).toBe('pending'); // 叶子照旧重跑
    const n2 = rec.nextStep();
    expect(n2.status).toBe('step_ready');
    if (n2.status === 'step_ready') expect(n2.step_id).toBe('1.1.1');   // 不重评估直接回叶子
  });

  it('反例:branch running 而 child 不在 states 账上(undefined)——当未决策重置 pending(undefined 边界守卫,review 面三实锤删守卫全绿零保护后补)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'rec-und-'));
    const SPEC = `# RecUnd
Id: rec-und

## Goal
undefined 边界

## Inputs
- x: int  # 输入

## Outputs
- out: line  # 结果

## Steps
1. [branch] 分流
  + → out: line  # 结果
  1.1. [case(x > 0)] 正路
    1.1.1. [act] 干活
      - ← x
      + → out: line
`;
    const eng = new ExecutionEngine();
    const init = eng.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 5 } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    // 手工造:branch running 但 children 全部不在 states 账上(异常残留形态——如部分损坏的旧快照)
    eng.getStepStates().set('1', 'running');
    eng.getStepStates().delete('1.1');
    eng.getStepStates().delete('1.1.1');
    eng.persist();
    const rec = ExecutionEngine.recover(join(stateDir, init.instance_id));
    // child undefined=无决策凭据,branch 当未决策重置——恢复后重走条件评估(保守方向:误重跑安全,误保留会绕过评估)
    expect(rec.getStepStates().get('1')).toBe('pending');
  });

  it('正例:break 残留 running(手工造异常残留态)recover 重置 pending——非容器非叶子分支首钉(设计"防 DFS 挂死"防线此前零测试,面三变异实锤)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'rec-brk-'));
    const SPEC = `# RecBrk
Id: rec-brk

## Goal
break 残留恢复

## Inputs
- xs: [int]  # 列表

## Outputs
- out: line  # 结果

## Steps
1. [loop for-each x in xs] 逐项
  1.1. [act] 干活
    - ← x
    + → r: line
  1.2. [break] 提前跳出
2. [act] 收尾
  + → out: line
`;
    const eng = new ExecutionEngine();
    const init = eng.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { xs: [1] } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    // 手工造 break 残留 running(正常执行不产生此态——异常残留形态)+persist
    eng.getStepStates().set('1.2', 'running');
    eng.persist();
    const rec = ExecutionEngine.recover(join(stateDir, init.instance_id));
    expect(rec.getStepStates().get('1.2')).toBe('pending');   // 残留消化,不留 running 挂死 DFS
  });

  it('反例:顶层实例（无 subtreeRoot）的悬空 running 仍被重置 pending（掩码保留不外溢到非 worker 场景）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'rec-top-'));
    const SPEC = `# RecTop
Id: rec-top

## Goal
g

## Outputs
- out: text  # o

## Steps
1. [reason] 想
  + → out: text  # o
  > t
`;
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir });
    if (init.status !== 'ok') return;
    e1.nextStep();   // step 1 标 running 落盘（模拟崩溃:无回写）
    const rec = ExecutionEngine.recover(join(stateDir, init.instance_id));
    expect(rec.getStepStates().get('1')).toBe('pending');   // 悬空 running 照常重置
  });
});

// check 纯机械判定 body（2026-08-19 作者拍板 A——判空/比阈值零 LLM 化;hopbuild 对齐门/意见闸
// 即消费面。无 body 照旧 LLM 判,双槽签名与判定语义零分叉）
// @v: anc-step-check-body
describe('check hop_python body（引擎消化零 LLM）', () => {
  const HOST_MIN = MINIMAL_HOST_CONFIG;
  const GATE_SPEC = `# Gate
Id: gate

## Goal
t

## Inputs
- fb: text  # 反馈

## Steps
1. [subtask retry=2] 对齐组
  + → ok: bool  # 判
  1.1. [check final] 判空放行
    - ← fb
    + → ok: bool  # 判定
    + → note: text  # 说明
    > \`\`\`hop_python
    > ok = len(fb) == 0
    > note = "" if ok else "未对齐,意见待处理"
    > \`\`\`
`;

  it('正例:判定 true → 引擎消化直达 completed（零 caller 介入）', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(GATE_SPEC, HOST_MIN, { params: { fb: '' } });
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('completed');
    expect(engine.getVariableStore().read('ok', 'root')).toBe(true);
  });

  it('正例:判定 false → CHECK_FAILED 触发容器 retry 至耗尽（判定语义与 LLM 判零分叉）', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(GATE_SPEC, HOST_MIN, { params: { fb: '改一下标题' } });
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('failed');
    expect((r as { failure_reason?: string }).failure_reason).toContain('retry exhausted');
  });

  it('反例:无 body 的 check 仍是 caller 介入点（LLM 判照旧,不被消化）', async () => {
    const SPEC = `# NoBody
Id: nobody

## Goal
t

## Inputs
- x: text  # v

## Steps
1. [subtask] 组
  + → ok: bool  # 判
  1.1. [check] 语义面核验
    - ← x
    + → ok: bool  # 判定
    + → why: text  # 说明
    > 核验 x 语义合理。
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, HOST_MIN, { params: { x: 'v' } });
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('step_ready');
    expect((r as { step_id?: string }).step_id).toBe('1.1');
  });
});

// @v: anc-exec-advance-to-caller, anc-exec-output-schema-check —— 引擎消化 body 的 SCHEMA_MISMATCH
// 直接 failStep（2026-08-10 定稿:与独立模式同语义——body 确定性,交还 caller 重跑得同一不匹配）
describe('引擎消化 body 的 SCHEMA_MISMATCH → failStep', () => {
  it('正例:body 产出类型不匹配声明（str*int 字符串重复 vs number 声明）→ 本步 fail 走升级链,不交 caller', async () => {
    const SPEC = `# BodyMismatch
Id: body-mismatch

## Goal
g

## Inputs
- label: text  # 文本

## Outputs
- out: text  # 终点

## Steps
1. [subtask retry=2] 事务边界
  + → doubled: int  # 容器导出
  1.1. [act] 字符串重复冒充数字
    - ← label
    + → doubled: int  # 声明 number,实际产出 string
    > 纯计算
    > \`\`\`hop_python
    > doubled = label * 2
    > \`\`\`
2. [reason] 永远轮不到的下游
  - ← doubled
  + → out: text  # o
  > t
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { params: { label: 'abc' } });
    expect(init.status).toBe('ok');
    // advanceToCaller 消化 1.1 body → SCHEMA_MISMATCH → failStep → retry=2 重跑同败 → 耗尽 → 实例终止
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('failed');   // retry 耗尽（每轮重跑同败——确定性）→ 实例终止,未交 caller
    // step 级失败明细是机器通道的校验明细+确定性说明（vars 响应携带 step_fail_reasons 不可得,
    // 经终态 partial_outputs 侧证 doubled 未产出;明细文本已在独立模式同一分支验证——此处验行为面:
    // 消化路径不再把 SCHEMA_MISMATCH 步骤交还 caller（旧行为会 status=step_ready 停在 1.1）
    if (r.status === 'failed') {
      expect(r.partial_outputs['doubled']).toBeUndefined();
    }
  });

  it('反例:caller 产出的 SCHEMA_MISMATCH 仍打回重做（错误不推进,不 failStep）——LLM 产出改 prompt 重做有意义', () => {
    const SPEC = `# CallerMismatch
Id: caller-mismatch

## Goal
g

## Outputs
- score: int  # 分

## Steps
1. [reason] 打分
  + → score: int  # 数值
  > 给分
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    const resp = engine.completeStep('1', { score: 'not-a-number' });
    expect(resp.status).toBe('error');
    expect(resp.code).toBe(ErrorCode.SCHEMA_MISMATCH);
    expect(engine.getStepStates().get('1')).toBe('running');   // 未被 failStep,等 caller 重做
  });
});

// ===== 统一模型退化窗口（P0.5 核心语义承诺：复用模式 parallel 暂串行）=====
// design/parallel-execution.md §U7 退化窗口条：unifiedDispatch 恒关（复用模式无 dispatcher）→
// subtask parallel 按普通容器串行下钻，零专门代码、结果与串行 spec 等价。
// @v: anc-exec-parallel-dispatch-model, anc-exec-parallel-advance
describe('统一模型退化窗口（复用模式 unifiedDispatch 关）', () => {
  const SPEC = `# Degrade
Id: degrade

## Goal
退化窗口验证

## Inputs
- a: int  # 甲

## Outputs
- out_a: int  # 甲结果
- out_b: int  # 乙结果

## Steps
1. [subtask] 组
  + → out_a: int  # 甲结果
  + → out_b: int  # 乙结果
  1.1. [subtask parallel] 标注甲
    + → out_a: int  # 结果
    1.1.1. [act] 算甲
      - ← a
      + → out_a: int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > out_a = a * 10
      > \`\`\`
  1.2. [subtask parallel] 标注乙
    + → out_b: int  # 结果
    1.2.1. [act] 算乙
      - ← a
      + → out_b: int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > out_b = a + 5
      > \`\`\`
2. [exit] 交付
`;

  it('正例：门关时 subtask parallel 按普通容器串行下钻直达 completed（矩阵16 复用模式面）', async () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { params: { a: 3 } });
    expect(init.status).toBe('ok');
    // 不 setUnifiedDispatch（复用模式姿势）——advanceToCaller 纯计算一路到底
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('completed');
    if (r.status !== 'completed') return;
    expect(r.outputs['out_a']).toBe(30);
    expect(r.outputs['out_b']).toBe(8);
    // 反例断言：门关全程零派发零在飞（无 dispatch_ready、无 inflight 记账）
    expect(engine.getInflight()).toHaveLength(0);
  });

  // params_for_child 落盘（hopissues/0020——writeChildParams 自实装起 dead import,worker init
  // readChildParams 恒 null 即 MISSING_INPUT,设计『driver 无需透传 --params』契约全线落空）
  // @v: anc-exec-parallel-child-params
  it('正例：fan-out 派发即落盘 params.json（含 itemVar 真值,worker init 自动回填的物理基础）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p0020-'));
    const engine = new ExecutionEngine();
    const SPEC2 = `# T
Id: t

## Goal
g

## Inputs
- items: [line]

## Outputs
- results: [text]

## Steps
1. [loop for-each item in items, collect r into results] 遍历
  - ← items
  + → results: [text]  # 收集
  1.1. [subtask parallel] 处理
    + → r: text  # 单项
    1.1.1. [reason] 做
      - ← item
      + → r: text  # 单项
      > 做
2. [exit] 完
`;
    engine.initExecution(SPEC2, MINIMAL_HOST_CONFIG, { stateDir: dir, params: { items: ['a', 'b'] } });
    engine.setUnifiedDispatch(true);
    const next = engine.nextStep();
    expect(next.status).toBe('dispatch_ready');
    if (next.status !== 'dispatch_ready') return;
    const instDir = engine.getInstanceDir()!;
    const pj = join(instDir, 'parallel', next.child_instance, 'params.json');
    expect(existsSync(pj)).toBe(true);
    const params = JSON.parse(readFileSync(pj, 'utf-8'));
    expect(params.item).toBe('a');   // itemVar 真值在盘——worker 零 --params 可回填
  });

  it('正例：call parallel 派发落 calls/<cid>/params.json（kind 分流——修复中当场抓:原签名写死 parallel,call 场景路径错位）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p0020c-'));
    const engine = new ExecutionEngine();
    const SPEC3 = `# T
Id: t

## Goal
g

## Inputs
- items: [line]

## Outputs
- results: [text]

## Steps
1. [loop for-each item in items, collect r into results] 遍历
  - ← items
  + → results: [text]  # 收集
  1.1. [call worker_spec(item) parallel] 处理
    + → r: result  # 收取
2. [exit] 完
`;
    engine.initExecution(SPEC3, MINIMAL_HOST_CONFIG, { stateDir: dir, params: { items: ['a', 'b'] } });
    engine.setUnifiedDispatch(true);
    const next = engine.nextStep();
    expect(next.status).toBe('dispatch_ready');
    if (next.status !== 'dispatch_ready') return;
    const instDir = engine.getInstanceDir()!;
    const pj = join(instDir, 'calls', next.child_instance, 'params.json');   // calls/ 非 parallel/
    expect(existsSync(pj)).toBe(true);
    expect(JSON.parse(readFileSync(pj, 'utf-8')).item).toBe('a');
  });

  it('反例：门开时同一 spec 的 nextStep 吐 dispatch_ready 而非下钻（推进条件放宽的对照面）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { params: { a: 3 } });
    expect(init.status).toBe('ok');
    engine.setUnifiedDispatch(true);
    const next = engine.nextStep();
    expect(next.status).toBe('dispatch_ready');
    if (next.status !== 'dispatch_ready') return;
    expect(next.step_id).toBe('1.1');
    expect(next.child_instance).toBe('1.1.1');   // 兄弟位 iter 恒 1
    // 派发即推进（§U5）：标注步骤已标 done、子树 skipped、在飞入账
    expect(engine.getStepStates().get('1.1')).toBe('done');
    expect(engine.getInflight().filter(f => f.status === 'inflight')).toHaveLength(1);
  });
});

// @v: anc-exec-retry-adaptive —— replan 候选文件落盘（提报沉淀文件半边——设计§replan步骤6,
// 2026-08-13 销设计-代码不一致:原只发 HopLog 审计事件,候选文件写入缺失）
describe('replan 候选文件落盘', () => {
  const ADAPTIVE_SPEC2 = `# AR
Id: ar-spec

## Goal
G

## Outputs
- final_out: text  # output

## Steps
1. [subtask retry=2 adaptive] 组
  + → final_out: text  # agg
  1.1. [act] 做
    + → task_out: text  # o
`;
  it('正例：submitReplan 通过 → <spec基名>.replan/<step_id>.v<n>.md 落盘（@trace 头+提交原文）', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'replan-cand-'));
    const specDir = mkdtempSync(join(tmpdir(), 'replan-spec-'));
    const specPath = join(specDir, 'ar-spec.md');
    writeFileSync(specPath, ADAPTIVE_SPEC2);
    const e = new ExecutionEngine();
    const init = e.initExecution(ADAPTIVE_SPEC2, MINIMAL_HOST_CONFIG, { stateDir, specPath });
    expect(init.status).toBe('ok');
    e.nextStep(); e.failStep('1.1', 'fail1');
    e.nextStep(); e.failStep('1.1', 'fail2');
    e.nextStep();   // adaptive_needed
    const md = '1. [act] step one\n  + → mid: text  # m\n2. [act] step two\n  - ← mid\n  + → final_out: text  # covers\n';
    expect(e.submitReplan('1', md).status).toBe('ok');
    const cand = join(specDir, 'ar-spec.replan', '1.v1.md');
    expect(existsSync(cand)).toBe(true);
    const content = readFileSync(cand, 'utf-8');
    expect(content).toContain('%% @trace');                    // @trace 头
    expect(content).toContain('type: replan-candidate');
    expect(content).toContain('step_id: 1');
    expect(content).toContain('error_reason: fail2');          // 四元组之错误原因（最近一次失败）
    expect(content).toContain('step one');                     // 提交原文在场
  });

  it('正例：同 subtask 二次 replan → v2 并存不覆盖（版本序列=离线审核可比对）', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'replan-cand2-'));
    const specDir = mkdtempSync(join(tmpdir(), 'replan-spec2-'));
    const specPath = join(specDir, 'ar-spec.md');
    // retry=6:两轮 adaptive（每轮吃 2 次失败预算）都在预算内
    const SPEC6 = ADAPTIVE_SPEC2.replace('retry=2', 'retry=6');
    writeFileSync(specPath, SPEC6);
    const e = new ExecutionEngine();
    e.initExecution(SPEC6, MINIMAL_HOST_CONFIG, { stateDir, specPath });
    e.nextStep(); e.failStep('1.1', 'f1'); e.nextStep(); e.failStep('1.1', 'f2'); e.nextStep();
    expect(e.submitReplan('1', '1. [act] alpha one\n  + → final_out: text  # c\n').status).toBe('ok');
    // 新 children 再失败到 adaptive → 第二次 replan（结构差异防熔断相似度判定）
    e.nextStep(); e.failStep('1.1', 'f3'); e.nextStep(); e.failStep('1.1', 'f4');
    expect(e.nextStep().status).toBe('adaptive_needed');
    expect(e.submitReplan('1', '1. [reason] beta think\n  + → mid: text  # m\n2. [act] beta act\n  - ← mid\n  + → final_out: text  # c\n').status).toBe('ok');
    expect(existsSync(join(specDir, 'ar-spec.replan', '1.v1.md'))).toBe(true);
    expect(existsSync(join(specDir, 'ar-spec.replan', '1.v2.md'))).toBe(true);   // 并存
  });

  it('反例：无 specPath（内存态引擎）→ 跳过落盘不炸,replan 照常生效', async () => {
    const e = new ExecutionEngine();
    e.initExecution(ADAPTIVE_SPEC2, MINIMAL_HOST_CONFIG);   // 无 stateDir 无 specPath
    e.nextStep(); e.failStep('1.1', 'f1'); e.nextStep(); e.failStep('1.1', 'f2'); e.nextStep();
    const r = e.submitReplan('1', '1. [act] mem one\n  + → final_out: text  # c\n');
    expect(r.status).toBe('ok');   // 沉淀通道缺席不拦执行链
  });
});

// ===== hop_env：ask 回填并入 + host_context 跨进程持久化 =====
// @v: anc-config-hop-env
describe('hop_env 覆盖链末级（ask 回填）与跨进程持久化', () => {
  const ASK_SPEC = `# T

## Goal
问材料库位置再读

## Outputs
- r: line  # r

## Steps
1. [ask] 材料库在哪
  + → hop_env_kb_root: line  # 问人补值

2. [reason] R
  - ← hop_env_kb_root
  + → r: line  # r
`;

  function mkHostDir(): { host: HostConfig; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'hopenv-eng-'));
    return {
      dir,
      host: {
        workspace_dir: dir,
        sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
        api_key: '',
      },
    };
  }

  it('正例：ask 输出 hop_env_* 并入 HostConfig.hop_env（覆盖链合法末级）', () => {
    const { host, dir } = mkHostDir();
    const engine = new ExecutionEngine();
    const init = engine.initExecution(ASK_SPEC, host, { stateDir: join(dir, '.hopstate') });
    expect(init.status).toBe('ok');
    const next = engine.nextStep();
    expect(next.step_id).toBe('1');
    engine.completeStep('1', { hop_env_kb_root: '/answered/kb' });
    expect(host.hop_env?.hop_env_kb_root).toBe('/answered/kb');
  });

  // 凭证禁入三级闸之 ask 级（0004——人现场输入最容易顺手贴 token;原零检查凭证随
  // host_context 落盘进日志）。 // @v: anc-config-hop-env
  it('反例：ask 回填凭证形态键 → SCHEMA_MISMATCH 拒且指路 api_key_env,表不污染（0004）', () => {
    const { host, dir } = mkHostDir();
    const engine = new ExecutionEngine();
    const spec = ASK_SPEC.replace(/hop_env_kb_root/g, 'hop_env_gh_token');
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    const r = engine.completeStep('1', { hop_env_gh_token: 'ghp_secret123' });
    expect(r.status).toBe('error');
    expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
    expect(r.message).toContain('api_key_env');                       // 指路
    expect(host.hop_env?.hop_env_gh_token).toBeUndefined();           // 表未污染
    expect(JSON.stringify(host.hop_env ?? {})).not.toContain('ghp_'); // 值零落
  });

  // 十八审抓 0004 ask 级绕闸盲区：answer 键不匹配声明名时 mapAskOutputs 单值提取把键名吃掉、
  // 值落普通声明变量照样落盘——原闸在 map 后判 hop_env_ 前缀恒不触发。闸改判原始 answer 键。
  // @v: anc-exec-hitl-presentation —— ask 零映射拒收（0031）
  it('反例：ask answer={value:approve} 且前序无同名推断值 → ASK_ANSWER_EMPTY 拒收不写表（0031——修前静默 ok,声明输出落 None 败因漂移两步）', () => {
    const { host, dir } = mkHostDir();
    const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- r: text  # r\n## Steps\n1. [ask] 确认清单\n  + → confirmed_points: yaml  # 清单\n2. [reason] 用\n  - ← confirmed_points\n  + → r: text  # r\n`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    const r = engine.completeStep('1', { value: 'approve' });   // confirm 形态应答,ask 无前序同名值可采
    expect(r.status).toBe('error');
    expect(r.code).toBe(ErrorCode.SCHEMA_MISMATCH);
    expect(r.message).toContain('ASK_ANSWER_EMPTY');
    expect(r.message).toContain('confirmed_points');            // 报文点名缺的声明输出
    // 卡保留（拒收不消卡,与凭证闸同通道形态）——再次合法提交仍可续
    const r2 = engine.completeStep('1', { confirmed_points: [{ id: 'P1' }] });
    expect(r2.status).toBe('ok');
  });

  // @v: anc-step-ask —— ask 应答标量类型归一（2026-09-18:人工/MCP 应答经 JSON 数字常成字符串,
  // 声明 int 存 "26000" 下游渲染按实际类型走字符串通道,int 字段渲染成多行块自相矛盾）
  it('正例：ask 声明 int 收 "26000" 字符串应答 → 归一为数字 26000 入库；反例：非数字形字符串保原值不拦（下游 SCHEMA 闸既有通道判）', () => {
    const { host, dir } = mkHostDir();
    const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- r: text  # r\n## Steps\n1. [ask] 确认目标\n  + → target: int  # 周目标\n2. [reason] 用\n  - ← target\n  + → r: text  # r\n`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    const r = engine.completeStep('1', { value: '26000' });   // MCP/人工通道典型形态:数字进来是字符串
    expect(r.status).toBe('ok');
    expect(engine.getVars().variables['target']).toBe(26000);      // 真数字,非 "26000"
    // 反例:非数字形保原值(不新增拒收面)
    const engine2 = new ExecutionEngine();
    engine2.initExecution(spec, host, { stateDir: join(dir, '.hopstate2') });
    engine2.nextStep();
    const rb = engine2.completeStep('1', { value: '两万六' });
    expect(rb.status).toBe('ok');
    expect(engine2.getVars().variables['target']).toBe('两万六');
  });

  it('正例：confirm 守界——零业务值 approve 照常通过,不被 ask 零映射闸误伤（P2-6:闸只管 ask 是结构事实,本例钉住防重构漂移）', () => {
    const { host, dir } = mkHostDir();
    const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- r: text  # r\n## Steps\n1. [confirm] 批准吗\n  + → ok: bool  # 审批槽\n2. [reason] 干\n  - ← ok\n  + → r: text  # r\n`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    // confirm 的 approve 无业务值——若零映射闸误管 confirm,这里会被 ASK_ANSWER_EMPTY 拒
    const r = engine.completeStep('1', { value: 'approve' });
    expect(r.status).toBe('ok');
  });

  it('正例：多输出 approve 快捷部分命中 → 放行,命中者取推断值未命中者落 None（P2-7:部分映射容忍×approve 快捷交叉形态）', () => {
    const { host, dir } = mkHostDir();
    const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- r: text  # r\n## Steps\n1. [act] 推断其一\n  + → a: text  # 拟用值\n2. [ask] 确认两个\n  + → a: text  # a\n  + → b: text  # b(前序无同名值)\n3. [reason] 用\n  - ← a\n  + → r: text  # r\n`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    expect(engine.completeStep('1', { a: '推断值' }).status).toBe('ok');
    engine.nextStep();
    const r = engine.completeStep('2', { value: 'approve' });   // a 命中前序推断值,b 无
    expect(r.status).toBe('ok');                                 // 部分命中=非全无效 → 放行
    const vars = engine.getVars() as { variables?: Record<string, unknown> };
    expect(vars.variables?.['a']).toBe('推断值');                 // 命中者取推断值
    expect(vars.variables?.['b'] ?? null).toBeNull();             // 未命中者落 None（标题另一半,复审 D-2 抓空头支票补上）
  });

  it('正例：hitl 多键含 undefined 成员 → JSON 原文且无字面 undefined（P2-9:原不记字面undefined测试走的是正常值路径断言平凡为真——本例真走到含 undefined 的 JSON 分支）', () => {
    const { host, dir } = mkHostDir();
    const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- r: text  # r\n## Steps\n1. [ask] 要两个\n  + → a: text  # a\n  + → b: text  # b\n2. [reason] 用\n  - ← a\n  + → r: text  # r\n`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate'), logDir: join(dir, '.hoplog'), logLevel: 'info' });
    engine.nextStep();
    const r = engine.completeStep('1', { a: '答了', b: undefined });   // 多键含 undefined 成员——部分映射放行
    expect(r.status).toBe('ok');
    const logDir = join(dir, '.hoplog');
    const runDir = readdirSync(logDir).find(f => f.startsWith('t-'));
    const log = readFileSync(join(logDir, runDir!, 'main.yaml'), 'utf-8');
    expect(log).toMatch(/response: .*答了/);                     // JSON 原文在场
    expect(log).not.toMatch(/response: undefined/);              // 无字面 undefined（JSON.stringify 丢 undefined 键,合法形态）
  });

  it('反例：ask answer={value:null} 与声明名直配 null → 均拒收（review 抓漏:JSON 无 undefined 序列化空值恰产 null——null 灌满声明输出穿闸,0031 病灶经 null 形态复发）', () => {
    const { host, dir } = mkHostDir();
    const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- r: text  # r\n## Steps\n1. [ask] 确认清单\n  + → confirmed_points: yaml  # 清单\n2. [reason] 用\n  - ← confirmed_points\n  + → r: text  # r\n`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    const r = engine.completeStep('1', { value: null });
    expect(r.status).toBe('error');
    expect(r.message).toContain('ASK_ANSWER_EMPTY');
    const r2 = engine.completeStep('1', { confirmed_points: null });   // 键名直配但值无效
    expect(r2.status).toBe('error');
    expect(engine.completeStep('1', { confirmed_points: [{ id: 'P1' }] }).status).toBe('ok');   // 卡保留可续
  });

  it('正例：falsy 合法业务值（0/false/空串）不被零映射闸误拒（复审 D-1 钉——判据是 undefined||null 严格判等非 falsy,防将来重构成 !value 漂移）', () => {
    const { host, dir } = mkHostDir();
    for (const [type, answer] of [['int', { v: 0 }], ['bool', { v: false }], ['text', { v: '' }]] as const) {
      const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- r: text  # r\n## Steps\n1. [ask] 要\n  + → v: ${type}  # v\n2. [reason] 用\n  - ← v\n  + → r: text  # r\n`;
      const engine = new ExecutionEngine();
      engine.initExecution(spec, host, { stateDir: join(dir, `.hopstate-${type}`) });
      engine.nextStep();
      expect(engine.completeStep('1', answer as Record<string, unknown>).status).toBe('ok');
    }
  });

  it('正例：ask 多输出部分映射 → 放行（增量应答合法,未答的落 None 归 None 传播——拦形态整体错误,不拦答一半）', () => {
    const { host, dir } = mkHostDir();
    const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- r: text  # r\n## Steps\n1. [ask] 要两个\n  + → a: text  # a\n  + → b: text  # b\n2. [reason] 用\n  - ← a\n  + → r: text  # r\n`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    const r = engine.completeStep('1', { a: '答了一半' });        // b 未答
    expect(r.status).toBe('ok');
  });

  it('正例：ask approve 快捷在前序有同名推断值时照常可用（零映射闸不误杀既有快捷语义）', () => {
    const { host, dir } = mkHostDir();
    const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- r: text  # r\n## Steps\n1. [act] 推断默认\n  + → target: text  # 拟用值\n  > \`\`\`hop_python\n  > target = \"默认目标\"\n  > \`\`\`\n2. [ask] 确认\n  + → target: text  # 确认后的值\n3. [reason] 用\n  - ← target\n  + → r: text  # r\n`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    expect(engine.completeStep('1', { target: '默认目标' }).status).toBe('ok');   // 纯引擎单测:步骤1手工交付
    engine.nextStep();                                            // 推进到 ask 暂停
    const r = engine.completeStep('2', { value: 'approve' });    // 前序 target 有值 → 快捷合法
    expect(r.status).toBe('ok');
  });

  // @v: anc-obs-hitl-record —— response 记应答原文（0031 连带）
  it('反例转正：hitl.response 不再记字面 undefined——含 undefined 值走 JSON 原文（审计块可还原谁答了什么）', () => {
    const { host, dir } = mkHostDir();
    const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- v: text  # v\n## Steps\n1. [ask] 要\n  + → v: text  # v\n2. [exit] 完\n`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate'), logDir: join(dir, '.hoplog'), logLevel: 'info' });
    engine.nextStep();
    const r = engine.completeStep('1', { v: '真实值' });
    expect(r.status).toBe('ok');
    const logDir = join(dir, '.hoplog');
    const runDir = readdirSync(logDir).find(f => f.startsWith('t-'));
    const log = readFileSync(join(logDir, runDir!, 'main.yaml'), 'utf-8');
    expect(log).toContain('response: 真实值');
    expect(log).not.toMatch(/response: undefined/);
  });

  it('反例转正：hitl.response 单值为数组/对象 → JSON 原文（真机实抓 [object Object]×3——String(数组) 同样等于没记）', () => {
    const { host, dir } = mkHostDir();
    const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- v: text  # v\n## Steps\n1. [ask] 要清单\n  + → items: yaml  # 清单\n2. [reason] 用\n  - ← items\n  + → v: text  # v\n`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate'), logDir: join(dir, '.hoplog'), logLevel: 'info' });
    engine.nextStep();
    expect(engine.completeStep('1', { items: [{ id: 'P1' }, { id: 'P2' }] }).status).toBe('ok');
    const logDir = join(dir, '.hoplog');
    const runDir = readdirSync(logDir).find(f => f.startsWith('t-'));
    const log = readFileSync(join(logDir, runDir!, 'main.yaml'), 'utf-8');
    expect(log).not.toContain('[object Object]');
    expect(log).toMatch(/"id":\s*"P1"|id.*P1/);   // JSON 原文可还原
  });

  it('反例：ask answer 单键凭证形态但声明名不同 → 仍拒（绕 mapAskOutputs 单值提取的盲区,十八审）', () => {
    const { host, dir } = mkHostDir();
    const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- v: text  # 普通声明名\n## Steps\n1. [ask] 要\n  + → v: text  # v\n  > 给\n2. [exit] 完\n`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    const r = engine.completeStep('1', { hop_env_gh_token: 'ghp_secret123' });   // 键≠声明名 v
    expect(r.status).toBe('error');
    expect(r.message).toContain('api_key_env');
    expect(JSON.stringify(engine.getVars().variables ?? {})).not.toContain('ghp_');   // 值未落声明变量
  });

  it('正例：ask answer 单键非凭证 hop_env 键（声明名不同）→ 不误拒,值经单值提取落声明变量', () => {
    const { host, dir } = mkHostDir();
    const spec = `# T\nId: t\n## Goal\ng\n## Outputs\n- v: text  # v\n## Steps\n1. [ask] 要\n  + → v: text  # v\n  > 给\n2. [exit] 完\n`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    const r = engine.completeStep('1', { hop_env_kb_root: '/some/kb' });   // 非凭证形态——放行
    expect(r.status).toBe('ok');
  });

  it('正例：ask 回填覆盖配置预置值（后者覆盖前者,逐键）', () => {
    const { host, dir } = mkHostDir();
    host.hop_env = { hop_env_kb_root: '/cfg/kb', hop_env_other: 'keep' };
    const engine = new ExecutionEngine();
    engine.initExecution(ASK_SPEC, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    engine.completeStep('1', { hop_env_kb_root: '/answered/kb' });
    expect(host.hop_env.hop_env_kb_root).toBe('/answered/kb');
    expect(host.hop_env.hop_env_other).toBe('keep');   // 其他键不动
  });

  it('正例：hop_env 随 host_context 持久化,load 后可得（复用模式 next/done 独立进程）', () => {
    const { host, dir } = mkHostDir();
    host.hop_env = { hop_env_kb_root: '/persist/kb' };
    const stateDir = join(dir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(ASK_SPEC, host, { stateDir });
    expect(init.status).toBe('ok');
    engine.nextStep();   // 触发 persist
    const instanceId = (init as { instance_id: string }).instance_id;
    const loaded = ExecutionEngine.load(join(stateDir, instanceId));
    expect(loaded.getRestoredHopEnv()?.hop_env_kb_root).toBe('/persist/kb');
  });

  it('反例：非 ask 步骤输出无 hop_env 并入路径（validate 已拒,引擎不设第二通道）', () => {
    const { host, dir } = mkHostDir();
    const engine = new ExecutionEngine();
    const SPEC = `# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → r: line  # r
`;
    engine.initExecution(SPEC, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    engine.completeStep('1', { r: 'v' });
    expect(host.hop_env).toBeUndefined();
  });
});

// ===== hop_env review 修复回归（2026-08-14 工程链 review 实抓四缺陷）=====
// @v: anc-exec-hop-env-table, anc-exec-doc-ref-hop-env, anc-config-hop-env
describe('hop_env review 修复回归', () => {
  const REF_SPEC = `# T

## Goal
按 hop_env_kb_root 找材料

## Outputs
- r: line  # r

## Steps
1. [reason] R
  + → r: line  # r
  > 读 {hop_env_kb_root} 下的规范
`;

  function mkHost2(hopEnv?: Record<string, string>): { host: HostConfig; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'hopenv-rev-'));
    return {
      dir,
      host: {
        workspace_dir: dir,
        sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
        api_key: '',
        ...(hopEnv ? { hop_env: hopEnv } : {}),
      },
    };
  }

  it('BUG-1 回归：load 恢复的实例（无 rawSource）L2e 值表仍注入——复用模式跨进程路径', () => {
    const { host, dir } = mkHost2({ hop_env_kb_root: '/kb' });
    const stateDir = join(dir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(REF_SPEC, host, { stateDir });
    expect(init.status).toBe('ok');
    // 不先推进（nextStep 会标 running,load 后无 pending 步）——init 已 persist,直接跨进程 load
    const loaded = ExecutionEngine.load(join(stateDir, (init as { instance_id: string }).instance_id));
    expect(loaded.getRawSource()).toBeNull();   // 前提：load 确实无原文
    loaded.setHostConfig(host);                 // 复用模式 load 恢复 host_context 子集,测试直连
    const next = loaded.nextStep();
    expect(next.status).toBe('step_ready');
    expect(next.context.hop_env_table).toContain('hop_env_kb_root: /kb');
  });

  it('BUG-2 回归：ask 回填绝对根同步扩 sandbox read allowed（末级授权面）', () => {
    const { host, dir } = mkHost2();
    const ASK = `# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [ask] 材料库在哪
  + → hop_env_kb_root: line  # 问人

2. [reason] R
  - ← hop_env_kb_root
  + → r: line  # r
`;
    const engine = new ExecutionEngine();
    engine.initExecution(ASK, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    engine.completeStep('1', { hop_env_kb_root: '/answered/kb' });
    expect(host.sandbox.filesystem.read_access.allowed).toContain('/answered/kb');
  });

  it('BUG-2 反例：ask 回填相对值不扩白名单', () => {
    const { host, dir } = mkHost2();
    const ASK = `# T

## Goal
G

## Outputs
- r: line  # r

## Steps
1. [ask] 子目录名
  + → hop_env_sub: line  # 问人

2. [reason] R
  - ← hop_env_sub
  + → r: line  # r
`;
    const engine = new ExecutionEngine();
    engine.initExecution(ASK, host, { stateDir: join(dir, '.hopstate') });
    engine.nextStep();
    const before = host.sandbox.filesystem.read_access.allowed.length;
    engine.completeStep('1', { hop_env_sub: 'docs/kb' });
    expect(host.sandbox.filesystem.read_access.allowed.length).toBe(before);
  });

  it('派发透传：launch_command 的 params 含父表 hop_env 键（子实例组合根可重建）', () => {
    const { host, dir } = mkHost2({ hop_env_kb_root: '/kb' });
    // 沿用 cli.test PIPE_SPEC 同构形态（loop for-each + subtask parallel——已知必出 dispatch_ready）
    const PAR = `# T

## Goal
G

## Inputs
- nums: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in nums, collect o into outs] 逐项
  + → outs: [int]  # 收集列表
  1.1. [subtask parallel] 处理一项
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > o = n * 7
      > \`\`\`
2. [exit] 交付
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(PAR, host, {
      stateDir: join(dir, '.hopstate'), canFanout: true, params: { nums: [3] },
      specPath: join(dir, 'spec.md'), cliAbsPath: '/fake/cli.js',
    });
    expect(init.status).toBe('ok');
    engine.setUnifiedDispatch(true);   // 复用模式 CLI run 同款开门（dispatch_ready 由此门产生）
    const next = engine.nextStep() as { status: string; launch_command?: string };
    expect(next.status).toBe('dispatch_ready');
    // 参数表走参数文件（^anc-exec-cmd-args-file）：命令里只有 "@<路径>",hop_env 键在文件里
    const m = /--params "@([^"]+)"/.exec(next.launch_command!);
    expect(m).not.toBeNull();
    const sent = JSON.parse(readFileSync(m![1], 'utf-8'));
    expect(sent.hop_env_kb_root).toBe('/kb');
  });
});

// ===== failCallStep 无失败记录拒收（2026-08-14 e2e cc:call-fail 实撞）=====
// 原兜底把协议误用（双重嵌套 state-dir 致子实例失败落野目录）静默洗成
// '(no fail record found)' CalleeFailure → 父实例错误终态化不可恢复。
// @v: anc-step-call
describe('failCallStep 无失败记录拒收', () => {
  const CALLER = `# Caller
Id: caller-spec
## Goal
g
## Outputs
- res: text  # o
## Steps
1. [call] knowledge-build : 调子spec
  + → res: child_res
`;

  it('反例：子实例 state 零 failed 步骤 → INVALID_STATE 拒收,父步保持 running（可修好重报）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(CALLER, MINIMAL_HOST_CONFIG);
    expect(engine.nextStep().status).toBe('step_ready');
    const resp = engine.failCallStep('1', {
      specId: 'knowledge-build', childInstanceId: '1',
      stepFailReasons: {}, stepStates: { '1': 'pending' },   // 官方目录 pending——协议误用形态
    });
    expect(resp.status).toBe('error');
    expect((resp as { code: string }).code).toBe(ErrorCode.INVALID_STATE);
    expect((resp as { message: string }).message).toContain('无任何 failed 步骤');
    expect(engine.getStepStates().get('1')).toBe('running');   // 状态未变——修好协议后可重报
  });

  it('正例：有 failed 状态位但缺失败明细 → 仍受理（降级理由注明,不误拒真失败）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(CALLER, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    const resp = engine.failCallStep('1', {
      specId: 'knowledge-build', childInstanceId: '1',
      stepFailReasons: {}, stepStates: { '1': 'failed' },   // 状态位在,明细缺（旧版子实例等）
    });
    expect(resp.status).toBe('ok');
    const reason = engine.exportFailState().stepFailReasons?.['1']?.reason ?? '';
    expect(reason).toContain('CalleeFailure');
    expect(reason).toContain('缺失败明细');
  });
});

// ===== mapCallOutputs 缺键响亮（BUG-G：undefined 静默流出变 null 入 collect）=====
// @v: anc-exec-output-fence-recovery
describe('mapCallOutputs 映射来源缺键响亮失败', () => {
  const CALLER = `# C
Id: c
## Goal
g
## Outputs
- res: text  # o
## Steps
1. [call callee] 调子
  + → res: normalized
`;

  it('反例：childVars 无映射来源键 → CALL_OUTPUT_MISSING 抛错报实有键清单（不静默 null）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(CALLER, MINIMAL_HOST_CONFIG);
    expect(() => engine.mapCallOutputs('1', { other_key: 'v' }))
      .toThrow(/CALL_OUTPUT_MISSING.*normalized.*other_key/s);
  });

  it('正例：键在场值为 null（子真产出 None）照常传递——缺键与 null 值是两回事', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(CALLER, MINIMAL_HOST_CONFIG);
    const mapped = engine.mapCallOutputs('1', { normalized: null });
    expect(mapped).toEqual({ res: null });
  });

  it('正例：围栏值照常剥壳（恢复原语链不受缺键闸影响）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(CALLER, MINIMAL_HOST_CONFIG);
    const mapped = engine.mapCallOutputs('1', { normalized: '```yaml\nnormalized: _specs\n```' });
    expect(mapped.res).toBe('_specs');
  });
});

// @v: anc-exec-output-fence-recovery —— reap 侧映射失败折集合语义（BUG-G 时序坑：出账后抛错则失败记录丢）
describe('reapParallelCall 映射失败折集合语义', () => {
  it('反例：子实例 vars 缺映射键 → 不贡献元素不 null 占位,主线照常 completed（列表变短语义）', () => {
    const SPEC = `# T
Id: t
## Goal
g
## Inputs
- items: [line]
## Outputs
- domains: [line]
## Steps
1. [loop for-each x in items, collect domain into domains] 循环
  + → domains: [line]

  1.1. [call probe_callee(x) parallel] 起子实例
    + → domain
2. [exit]
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { params: { items: ['a', 'b'] } });
    expect(init.status).toBe('ok');
    engine.setUnifiedDispatch(true);
    const d1 = engine.nextStep();
    expect(d1.status).toBe('dispatch_ready');
    const ci1 = (d1 as { child_instance: string }).child_instance;
    const d2 = engine.nextStep();
    const ci2 = (d2 as { child_instance: string }).child_instance;
    // ci1 收割: vars 里没有 domain 键（BUG-G 形态——映射失败折失败分支不炸不 null）
    engine.reapParallelCall(ci1, { vars: { unrelated: 'x' } });
    // ci2 收割: 正常值
    engine.reapParallelCall(ci2, { vars: { domain: '数学理论/排队论' } });
    const r = engine.nextStep();
    expect(r.status).toBe('completed');
    const domains = (r as { outputs: Record<string, unknown> }).outputs['domains'];
    expect(domains).toEqual(['数学理论/排队论']);   // 长度 1 非 [null, ...]——缺陷元素不占位
  });
});

// @v: anc-exec-output-fence-recovery — 不动点归一（2026-08-24 作者定"又是json-yaml,还不能自动解决么"）:
// 单趟 recover/coerce 接力对嵌套组合壳必漏,循环至不动点后任何组合被自然吃净。
// 历史四马甲全谱回归 + coffee3 新组合形态。
describe('输出归一不动点（嵌套组合壳全谱）', () => {
  const YAML_SPEC = `# Y
Id: y
## Goal
g
## Outputs
- hf: yaml  # 结构
## Steps
1. [reason] 产出
  + → hf: yaml  # 结构
  > 产出
`;
  function mk() {
    const engine = new ExecutionEngine();
    engine.initExecution(YAML_SPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();   // step 1 → running
    return engine;
  }

  it('正例：JSON 壳包 YAML 串（coffee3 实撞形态）→ 两轮收敛出真结构', () => {
    // LLM 交 {"hf": "title: x\nitems:\n  - a\n"} 的等价形态:值是 YAML 字符串——
    // 第一轮 coerce parse 出 {hf: "yaml串"} 同键嵌套,recover 剥壳露出串;第二轮 coerce 把串 parse 成结构
    const engine = mk();
    const r = engine.completeStep('1', { hf: '{"hf": "title: x\\nitems:\\n  - a\\n  - b\\n"}' });
    expect(r.status).toBe('ok');
    const v = engine.getVariableStore().read('hf', 'root') as Record<string, unknown>;
    expect(v.title).toBe('x');
    expect(v.items).toEqual(['a', 'b']);
  });

  it('正例：围栏包 JSON 包同键嵌套 → 收敛出真结构', () => {
    const engine = mk();
    const r = engine.completeStep('1', { hf: '```json\n{"hf": {"title": "y", "n": 3}}\n```' });
    expect(r.status).toBe('ok');
    const v = engine.getVariableStore().read('hf', 'root') as Record<string, unknown>;
    expect(v.title).toBe('y');
  });

  it('正例：三层同键自嵌套（ppt 轮马甲）→ 剥净', () => {
    const engine = mk();
    const r = engine.completeStep('1', { hf: { hf: { hf: { title: 'z' } } } });
    expect(r.status).toBe('ok');
    const v = engine.getVariableStore().read('hf', 'root') as Record<string, unknown>;
    expect(v.title).toBe('z');
  });

  it('反例：纯散文 parse 不出结构 → 照拒 SCHEMA_MISMATCH（宽容形态不宽容内容）', () => {
    const engine = mk();
    const r = engine.completeStep('1', { hf: '这是一段说明散文，没有任何结构。' });
    expect(r.status).toBe('error');
    expect((r as { code?: string }).code).toBe('SCHEMA_MISMATCH');
  });
});

// @v: anc-exec-l2c-retry-feedback — 引擎机械错误不进修订工单（coffee3 实撞:引擎错误
// "列表推导的遍历对象须为列表"被当修订意见灌给模型,模型读不懂四轮烧尽）
describe('L5 引擎错误与判定打回分层', () => {
  const SPEC2 = `# E
Id: e
## Goal
g
## Outputs
- v: text  # x
## Steps
1. [subtask retry=2] 容器
  + → v: text  # x
  1.1. [reason] 生成
    + → v: text  # x
2. [exit]
`;
  it('正例：引擎机械错误（无 CHECK_FAILED 前缀）→ L5 给形态指引不给修订工单；反例：判定打回照旧工单', () => {
    const e1 = new ExecutionEngine();
    e1.initExecution(SPEC2, MINIMAL_HOST_CONFIG);
    e1.nextStep();
    e1.failStep('1.1', '列表推导的遍历对象须为列表,实际: null');
    const r1 = e1.nextStep();
    expect(r1.status).toBe('step_ready');
    if (r1.status === 'step_ready') {
      expect(r1.context.retry_feedback).toContain('机械步骤处理失败');
      expect(r1.context.retry_feedback).toContain('重点检查形态');
      expect(r1.context.retry_feedback).not.toContain('逐条落实');   // 不是修订工单
    }
    const e2 = new ExecutionEngine();
    e2.initExecution(SPEC2, MINIMAL_HOST_CONFIG);
    e2.nextStep();
    e2.failStep('1.1', 'CHECK_FAILED: 请补充路径布局');
    const r2 = e2.nextStep();
    if (r2.status === 'step_ready') {
      expect(r2.context.retry_feedback).not.toContain('照常执行');   // 判定打回=意见本体(框架句在渲染段,fb 不再含'逐条落实')       // 判定打回=修订工单
      expect(r2.context.retry_feedback).toContain('请补充路径布局');
    }
  });

  // @v: anc-exec-text-toolcall-hint —— L6 渲染半边:失败原因带附加提示标记时,形态指引用去掉提示的原因,提示段在末尾
  it('正例：机械错误原因带正文疑似工具调用提示 → 形态指引原句套标记前的原因,提示整段追加在末尾', () => {
    const base = 'SCHEMA_MISMATCH: 字段 "v"（声明 int）：期望整数 (after 3 attempts)';
    const hint = `${TEXT_TOOLCALL_HINT_MARKER}\n如果你本意是调用工具 bash：写在正文里的调用引擎收不到，工具要通过工具调用功能发起，不能写成文字；bash 不在你这一步的可用工具清单里，可用的有：write、listdir。如果这段是产出内容本身，忽略本提示。`;
    const e = new ExecutionEngine();
    e.initExecution(SPEC2, MINIMAL_HOST_CONFIG);
    e.nextStep();
    e.failStep('1.1', `${base}\n\n${hint}`);
    const r = e.nextStep();
    expect(r.status).toBe('step_ready');
    if (r.status !== 'step_ready') return;
    const fb = r.context.retry_feedback as string;
    expect(fb).toContain(`（引擎错误：${base}）。\n这通常说明产出的形态不符合输出声明`);
    expect(fb.endsWith(`重点检查形态。\n\n${hint}`)).toBe(true);
    // 反例:同一原因去掉提示 → 与改前逐字相同（无标记段）
    const e2 = new ExecutionEngine();
    e2.initExecution(SPEC2, MINIMAL_HOST_CONFIG);
    e2.nextStep();
    e2.failStep('1.1', base);
    const r2 = e2.nextStep();
    if (r2.status !== 'step_ready') throw new Error('expected step_ready');
    expect(r2.context.retry_feedback).toBe(`你上一轮的产出导致后续机械步骤处理失败（引擎错误：${base}）。\n这通常说明产出的形态不符合输出声明——请严格按 L4 输出声明的名字与类型产出：声明什么类型就直接给什么类型的值，不要包裹在字符串/JSON/代码围栏里，不要在值外再套变量名键。内容本身可能没有问题，重点检查形态。`);
  });
});


// @v: anc-exec-l2c-retry-feedback — H1 掐口:check/commit 不吃 upstream_feedback（A 案 retry 半边
// 2026-08-31 首修,upstream 半边同日补——call 重试时 callee 判官曾吃父层意见照抄锚定）
describe('upstream_feedback 受众分道（check/commit 恒不吃）', () => {
  const SPEC = `# U
Id: u-h1
## Goal
g
## Outputs
- r: text  # x
## Steps
1. [subtask] 包
  + → r: text
  1.1. [reason] 产出
    + → r: text  # x
  1.2. [check] 判定
    - ← r
    + → ok: bool  # k
    + → note: text  # n
`;
  it('正例：reason 步吃上游意见（条目在场）；反例：check 步零上游供给', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { upstreamFeedback: 'SENTINEL_UPSTREAM_H1' });
    const r1 = engine.nextStep();
    expect(r1.status).toBe('step_ready');
    if (r1.status === 'step_ready') {
      const t1 = formatPromptText(r1.context, 'reason');
      expect(t1).toContain('SENTINEL_UPSTREAM_H1');   // 执行步吃上游(修改依据)
    }
    engine.completeStep('1.1', { r: 'v' });
    const r2 = engine.nextStep();
    expect(r2.status).toBe('step_ready');
    if (r2.status === 'step_ready') {
      expect(r2.context.upstream_feedback).toBeUndefined();   // 判官零上游(锚定毒药)
      const t2 = formatPromptText(r2.context, 'check');
      expect(t2).not.toContain('SENTINEL_UPSTREAM_H1');
    }
  });
});

// @v: anc-obs-record-at-boundary — H3:check body 步不记假 prompt（旧修只罩 act/commit,
// probe 实锤 check body 复用模式被记完整 prompt 含判官角色档——观测误导）
describe('check body 步 hoplog 零 llm.prompt（H3）', () => {
  it('正例：带 body 的 check 引擎消化,hoplog 无 llm 块（反例"无 body check 照记"另立下方独立钉——标题不声称测试体没有的东西）', async () => {
    const SPEC = `# CB
Id: cb-h3
## Goal
g
## Outputs
- out: text  # x
## Steps
1. [subtask] 包
  + → out: text
  1.1. [act] 产出
    + → out: text  # x
    > \`\`\`hop_python
    > out = "hello world"
    > \`\`\`
  1.2. [check] 机械核
    - ← out
    + → ok: bool  # k
    + → note: text  # n
    > \`\`\`hop_python
    > ok = len(out) > 3
    > note = "" if ok else "太短"
    > \`\`\`
`;
    const dir = mkdtempSync(join(tmpdir(), 'h3-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir: join(dir, '.hopstate'), logDir: join(dir, '.hoplog'), logLevel: 'debug' });
    expect(init.status).toBe('ok');
    // 推进到底(body 步引擎消化——advanceToCaller 是消化通道,nextStep 单发不消化)
    const r = await engine.advanceToCaller();
    expect(r.status).toBe('completed');
    const log = readFileSync(join(engine.getHopLogRunDir()!, 'main.yaml'), 'utf-8');
    // 1.2 是 body check——引擎消化零 LLM,不得有判官角色档假 prompt
    expect(log).not.toContain('你的角色：验证判定');
    expect(log).toContain('"1.2"');   // 步骤本身有账(start/done)
  });

  // 反例半边补场景（实撞:2026-09-01 补测试批阅卷抓"标题声称反例但测试体没有"——上方钉只测
  // 了豁免面,豁免写宽〔如误罩全部 check〕时无钉可红:无 body check 真走 LLM 供给路径,照记
  // llm.prompt 是记录点选址条款的正半边,漏记=走查者以为没发生过 LLM 判定）。
  it('反例：无 body check 走 LLM 通道(复用模式 step_ready)→ hoplog 照记 llm.prompt 含判官角色档', () => {
    const SPEC = `# CN
Id: cn-h3
## Goal
g
## Outputs
- out: text  # x
## Steps
1. [subtask] 包
  + → out: text
  1.1. [reason] 产出
    + → out: text  # x
  1.2. [check] 语义核
    - ← out
    + → ok: bool  # k
    + → note: text  # n
`;
    const dir = mkdtempSync(join(tmpdir(), 'h3n-'));
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir: join(dir, '.hopstate'), logDir: join(dir, '.hoplog'), logLevel: 'debug' });
    engine.nextStep();
    engine.completeStep('1.1', { out: 'hello' });
    const r = engine.nextStep();   // 1.2 无 body check——复用模式 step_ready 即发送边界,记录为真
    expect(r.status).toBe('step_ready');
    engine.getHopLog()?.flush?.();
    const log = readFileSync(join(engine.getHopLogRunDir()!, 'main.yaml'), 'utf-8');
    expect(log).toContain('你的角色：验证判定');   // 判官角色档真进了 llm.prompt(照记)
  });
});

// @v: anc-exec-l2c-retry-feedback — H2 复用半边:call_protocol 的 init_command 携带父层反馈
// （D41 曾只实装 standalone;复用模式 driver 照抄命令另起进程,原命令零反馈载荷——重建子实例
// 对修订意见全盲,dr8 病复用模式仍活。A 案:命令行参数汇入 EngineOptions 同一注入口）
describe('call_protocol 反馈携带（H2 复用半边）', () => {
  const PARENT = `# P
Id: p-h2
## Goal
g
## Outputs
- r: text  # x
## Steps
1. [subtask retry=2] 外包组
  + → r: text
  1.1. [call sub(输入=固定值)] 外包
    + → r
  1.2. [check] 核验
    - ← r
    + → ok: bool  # k
    + → note: text  # n
`;
  it('正例：重跑轮 init_command 追加 --upstream-feedback 含打回意见;反例：首跑命令零反馈参数', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(PARENT, MINIMAL_HOST_CONFIG, { params: { 固定值: 'v' } } as any);
    // 复用模式协议拼装需要 cliAbsPath/specPath——经 CLI init 才有;直调时设私有面模拟 CLI 环境
    (engine as any).cliAbsPath = '/abs/cli.js';
    (engine as any).specPath = '/abs/p.md';
    const r1 = engine.nextStep();
    expect(r1.status).toBe('step_ready');
    const cp1 = (r1 as any).call_protocol;
    expect(cp1).toBeDefined();
    expect(cp1.init_command).not.toContain('--upstream-feedback');   // 首跑零反馈
    // 模拟子实例失败→check 打回→容器重试→重跑轮
    engine.completeStep('1.1', { r: 'bad' });
    engine.nextStep();
    engine.failStep('1.2', 'CHECK_FAILED: SENTINEL_H2 结论缺依据');
    const r2 = engine.nextStep();   // 重跑轮 1.1
    expect(r2.status).toBe('step_ready');
    const cp2 = (r2 as any).call_protocol;
    expect(cp2).toBeDefined();
    expect(cp2.init_command).toContain('--upstream-feedback');
    expect(cp2.init_command).toContain('SENTINEL_H2');   // 打回意见真在命令里
  });

  // @v: anc-exec-cmd-args-file — 内存实例（无实例目录）退回 POSIX 单引号内联:经真 shell 回显,
  // 参数原文逐字节不变（反引号/$()/${}/单引号都不被解释）;反例:有实例目录时命令里零原文
  it('正例：内存实例 --params/--upstream-feedback 单引号内联经 sh 回显逐字节不变;反例：有实例目录时命令零原文、值在 cmd_args 文件', () => {
    const NASTY = "a `echo INJ` $(echo SUB) ${HOME} 'q' \\ \"d\"";
    const PARENT_IN = `# P
Id: p-cmdargs
## Goal
g
## Inputs
- 原料: text  # 带元字符
## Outputs
- r: text  # x
## Steps
1. [subtask retry=2] 外包组
  + → r: text
  1.1. [call sub(材料: 原料)] 外包
    + → r
  1.2. [check] 核验
    - ← r
    + → ok: bool  # k
    + → note: text  # n
`;
    const engine = new ExecutionEngine();
    engine.initExecution(PARENT_IN, MINIMAL_HOST_CONFIG, { params: { 原料: NASTY } } as any);
    (engine as any).cliAbsPath = '/abs/cli.js';
    (engine as any).specPath = '/abs/p.md';
    engine.nextStep();
    engine.completeStep('1.1', { r: 'bad' });
    engine.nextStep();
    engine.failStep('1.2', `CHECK_FAILED: ${NASTY}`);
    const cp = (engine.nextStep() as any).call_protocol;
    const { execSync } = require('node:child_process');
    const argOf = (flag: string) => new RegExp(`${flag} ('(?:[^']|'\\\\'')*')`).exec(cp.init_command)![1];
    expect(cp).toBeDefined();
    const params = JSON.parse(execSync(`printf '%s' ${argOf('--params')}`, { encoding: 'utf-8' }));
    expect(params.材料).toBe(NASTY);
    expect(execSync(`printf '%s' ${argOf('--upstream-feedback')}`, { encoding: 'utf-8' })).toContain(NASTY);

    const dir = mkdtempSync(join(tmpdir(), 'cmdargs-'));
    const e2 = new ExecutionEngine();
    e2.initExecution(PARENT_IN, MINIMAL_HOST_CONFIG, { params: { 原料: NASTY }, stateDir: join(dir, '.hopstate') } as any);
    (e2 as any).cliAbsPath = '/abs/cli.js';
    (e2 as any).specPath = '/abs/p.md';
    const cp2 = (e2.nextStep() as any).call_protocol;
    expect(cp2.init_command).not.toContain('INJ');
    const m = /--params "@([^"]+)"/.exec(cp2.init_command)!;
    expect(m[1].endsWith(join('cmd_args', 'calls-1.1.params.json'))).toBe(true);
    expect(JSON.parse(readFileSync(m[1], 'utf-8')).材料).toBe(NASTY);
  });

  it('全链：CLI init 收 --upstream-feedback → 子实例 reason 步 L5 有上游条目、check 步零供给', () => {
    // 直接经 EngineOptions 模拟装配终点——本钉只锁引擎侧受众分道;CLI 层透传与跨进程持久化
    // 由 cli.test.ts「init --upstream-feedback 跨进程全链」真进程钉锁（变异实锤:删透传行
    // tsc 照过、同进程钉照绿——"tsc 已核"不成立,唯真 CLI 进程钉能拦）
    const CHILD = `# C
Id: c-h2
## Goal
g
## Outputs
- out: text  # x
## Steps
1. [subtask] 组
  + → out: text
  1.1. [reason] 产出
    + → out: text  # x
  1.2. [check] 判
    - ← out
    + → ok: bool  # k
    + → note: text  # n
`;
    const engine = new ExecutionEngine();
    engine.initExecution(CHILD, MINIMAL_HOST_CONFIG, { upstreamFeedback: 'SENTINEL_H2_CHILD' });
    const r1 = engine.nextStep();
    expect(r1.status).toBe('step_ready');
    if (r1.status === 'step_ready') {
      expect(formatPromptText(r1.context, 'reason')).toContain('SENTINEL_H2_CHILD');   // 执行步吃
    }
    engine.completeStep('1.1', { out: 'v' });
    const r2 = engine.nextStep();
    if (r2.status === 'step_ready') {
      expect(r2.context.upstream_feedback).toBeUndefined();   // 子判官不吃（H1 掐口协同）
    }
  });

  // @v: anc-exec-l2c-retry-feedback — 载荷同构公共体三段拼接。实撞:2026-09-01 补测试批变异
  // 核证——buildUpstreamFeedbackPayload 改回初版"只拼 fb?.reason"(丢 prior 丢 inherited)全量
  // 照绿:既有钉只断言当轮意见在场,祖辈续传与打回史两段零保护(callee 看不到此前打回史即
  // review 面二抓的分叉形态回归)。
  it('正例：祖辈反馈+两轮打回史在场时,载荷三段齐(祖辈哨兵/第N次打回历史行/当前意见),init_command 同含', () => {
    const SPEC3 = `# P3
Id: p-h2-iso
## Goal
g
## Outputs
- r: text  # x
## Steps
1. [subtask retry=3] 外包组
  + → r: text
  1.1. [call sub(输入=固定值)] 外包
    + → r
  1.2. [check] 核验
    - ← r
    + → ok: bool  # k
    + → note: text  # n
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC3, MINIMAL_HOST_CONFIG, { params: { 固定值: 'v' }, upstreamFeedback: '祖辈SENTINEL_ISO' } as any);
    (engine as any).cliAbsPath = '/abs/cli.js';
    (engine as any).specPath = '/abs/p.md';
    // 两轮打回:第一轮意见进 prior 历史行,第二轮是当前意见
    engine.nextStep();
    engine.completeStep('1.1', { r: 'bad1' });
    engine.nextStep();
    engine.failStep('1.2', 'CHECK_FAILED: 第一轮意见_PRIOR_ISO');
    engine.nextStep();
    engine.completeStep('1.1', { r: 'bad2' });
    engine.nextStep();
    engine.failStep('1.2', 'CHECK_FAILED: 第二轮意见_CURRENT_ISO');
    const r = engine.nextStep();   // 第三跑轮 1.1
    expect(r.status).toBe('step_ready');
    // 公共体直验:三段全在(原实装丢 prior 丢 inherited 的回归形态在此红)
    const payload = (engine as any).buildUpstreamFeedbackPayload('1.1') as string;
    expect(payload).toContain('祖辈SENTINEL_ISO');            // inherited 段:祖辈反馈原样续传
    expect(payload).toMatch(/第 \d+ 次[:：]/);                 // prior 历史行在场("第 N 次"框架)
    expect(payload).toContain('第一轮意见_PRIOR_ISO');         // 历史行意见正文存活
    expect(payload).toContain('第二轮意见_CURRENT_ISO');       // 当前意见零截断
    // init_command 经同一公共体——载荷关键子串进命令(两模式同构,不许各写判法)
    const cp = (r as any).call_protocol;
    expect(cp).toBeDefined();
    expect(cp.init_command).toContain('--upstream-feedback');
    expect(cp.init_command).toContain('祖辈SENTINEL_ISO');
    expect(cp.init_command).toContain('第一轮意见_PRIOR_ISO');
    expect(cp.init_command).toContain('第二轮意见_CURRENT_ISO');
  });

  // @v: anc-exec-l2c-retry-feedback — 拼接端 24000 尾部截留。实撞:2026-09-01 补测试批变异
  // 核证——保护线与截留方向(尾部=最新意见存活)零测试,改回头部保留或撤线全量照绿;深递归
  // 逐层拼接无界增长的防线是空炮。
  it('正例：拼接超 24000 → 载荷长度受限且尾部(当前意见)存活、头部(祖辈旧文)被截', () => {
    const SPEC4 = `# P4
Id: p-h2-cap
## Goal
g
## Outputs
- r: text  # x
## Steps
1. [subtask retry=2] 外包组
  + → r: text
  1.1. [call sub(输入=固定值)] 外包
    + → r
  1.2. [check] 核验
    - ← r
    + → ok: bool  # k
    + → note: text  # n
`;
    const engine = new ExecutionEngine();
    // 祖辈反馈单独灌超线体量(>24000)——头部标记串必被截,尾部当前意见必存活
    const bigInherited = 'HEAD_MARK_CAP' + 'x'.repeat(26000);
    engine.initExecution(SPEC4, MINIMAL_HOST_CONFIG, { params: { 固定值: 'v' }, upstreamFeedback: bigInherited } as any);
    engine.nextStep();
    engine.completeStep('1.1', { r: 'bad' });
    engine.nextStep();
    engine.failStep('1.2', 'CHECK_FAILED: TAIL_MARK_CAP 当前意见');
    engine.nextStep();
    const payload = (engine as any).buildUpstreamFeedbackPayload('1.1') as string;
    expect(payload.length).toBeLessThanOrEqual(24000);
    expect(payload).toContain('TAIL_MARK_CAP');       // 尾部(最新意见)存活
    expect(payload).not.toContain('HEAD_MARK_CAP');   // 头部被截(尾部截留方向——头部保留是被修掉的旧行为)
  });
});

// @v: anc-exec-replan-proactive —— 主动 replan（/hop 随手化批,2026-08-26 设计改定后实装）
describe('主动 replan（proactive——不经失败的计划编辑）', () => {
  const PSPEC = `# P
Id: p

## Goal
g

## Outputs
- out: text  # o

## Steps
1. [subtask] 容器
  + → out: text  # o
  1.1. [reason] 甲步
    + → a: text  # pa
  1.2. [reason] 乙步
    - ← a
    + → b: text  # pb
  1.3. [reason] 收尾
    - ← b
    + → out: text  # o
  1.4. [check final] 把关
    - ← out
    + → ok: bool  # k
    + → why: text  # w
`;
  function mk() {
    const host = { workspace_dir: '/tmp/test', sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } } } as unknown as HostConfig;
    const engine = new ExecutionEngine();
    engine.initExecution(PSPEC, host);
    return engine;
  }

  it('正例：跑完 1.1 后主动编辑未执行部分 → ok,已执行前缀保留（产出仍在）,新计划接续', () => {
    const e = mk();
    e.nextStep();
    expect(e.completeStep('1.1', { a: '甲产出' }).status).toBe('ok');
    // 主动编辑:保留 1.1(原样),换掉 1.2 起的未执行部分（check final 原样保留——闸口铁律）
    const newMd = `1. [reason] 甲步
  + → a: text  # pa
2. [reason] 乙步改版
  - ← a
  + → b: text  # pb
3. [reason] 收尾
  - ← b
  + → out: text  # o
4. [check final] 把关
  - ← out
  + → ok: bool  # k
  + → why: text  # w
`;
    const r = e.submitReplan('1', newMd, { proactive: true });
    expect(r.status).toBe('ok');
    const vars = e.getVars() as { variables?: Record<string, unknown> };
    expect(vars.variables?.['a']).toBe('甲产出');                 // 已执行产出未被清
    const next = e.nextStep() as { step_id?: string; context?: { node_decl?: { summary?: string } } };
    expect(next.step_id).toBe('1.2');                             // 从新计划的未执行首步接续
    expect(JSON.stringify(next.context?.node_decl ?? {})).toContain('乙步改版');
  });

  it('反例：主动编辑改动已执行步骤（摘要变了）→ 结构化拒,报文点名哪步不可编辑', () => {
    const e = mk();
    e.nextStep();
    expect(e.completeStep('1.1', { a: 'x' }).status).toBe('ok');
    const newMd = `1. [reason] 甲步被篡改
  + → a: text  # pa
2. [reason] 乙步
  - ← a
  + → b: text  # pb
3. [reason] 收尾
  - ← b
  + → out: text  # o
4. [check final] 把关
  - ← out
  + → ok: bool  # k
  + → why: text  # w
`;
    const r = e.submitReplan('1', newMd, { proactive: true });
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.errors)).toContain('1.1');            // 点名不可编辑的步
    expect(JSON.stringify(r.errors)).toContain('已执行');
  });

  it('反例：主动编辑把 check final 改没 → 拒（既有 completeness 闸原样继承——把关点不可动）', () => {
    const e = mk();
    e.nextStep();
    expect(e.completeStep('1.1', { a: 'x' }).status).toBe('ok');
    const newMd = `1. [reason] 甲步
  + → a: text  # pa
2. [reason] 乙步
  - ← a
  + → b: text  # pb
3. [reason] 收尾（把关被吞了）
  - ← b
  + → out: text  # o
`;
    const r = e.submitReplan('1', newMd, { proactive: true });
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.errors)).toMatch(/check/i);           // check final 保留闸拒
  });

  it('反例：非 proactive 调用不在 adaptive_needed 态 → 照旧 INVALID_STATE（门禁只对 proactive 放开,存量零波动）', () => {
    const e = mk();
    e.nextStep();
    const r = e.submitReplan('1', '1. [reason] x\n  + → out: text  # o');
    expect(r.status).toBe('error');
    expect(r.code).toBe(ErrorCode.INVALID_STATE);
  });

  it('反例转正：proactive 逐字重发同一编辑 → 只拒收不处决容器（review P0——原相似度闸继承 adaptive 处决语义,重发即杀整 run;CLI 瞬断重试是正常操作）', () => {
    const e = mk();
    e.nextStep();
    expect(e.completeStep('1.1', { a: 'x' }).status).toBe('ok');
    const md = `1. [reason] 甲步
  + → a: text  # pa
2. [reason] 乙步改
  - ← a
  + → b: text  # pb
3. [reason] 收尾
  - ← b
  + → out: text  # o
4. [check final] 把关
  - ← out
  + → ok: bool  # k
  + → why: text  # w
`;
    expect(e.submitReplan('1', md, { proactive: true }).status).toBe('ok');
    const r2 = e.submitReplan('1', md, { proactive: true });      // 逐字重发
    expect(r2.status).toBe('ok');                                  // 幂等 ok（前缀照过尾部同内容——设计校正:proactive 退出相似度闸,不读不写基线）
    const next = e.nextStep();
    expect(next.status).toBe('step_ready');                        // 容器活着,run 未被处决（修前 failed 整 run）
  });

  it('反例：proactive 目标是叶子步 → 结构化拒点名（review P1-①——修前核态不核型,迭代 undefined 裸崩）', () => {
    const e = mk();
    e.nextStep();
    const r = e.submitReplan('1.1', '1. [reason] x\n  + → a: text  # pa', { proactive: true });
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.errors)).toContain('reason 步骤');     // 点名类型,非裸崩
  });

  it('正例：熔断分池——proactive 编辑不占 adaptive 额度（review P1-④——修前共池,3 次编辑吃光故障恢复救命预算）', () => {
    const e = mk();
    e.nextStep();
    expect(e.completeStep('1.1', { a: 'x' }).status).toBe('ok');
    // 三次互不相似的 proactive 编辑（修前已把共享计数烧满）
    for (let i = 0; i < 3; i++) {
      const md = `1. [reason] 甲步
  + → a: text  # pa
2. [${i === 0 ? 'reason' : i === 1 ? 'act free' : 'reason'}] 乙步版本${i}路线${'甲乙丙'[i]}
  - ← a
  + → b: text  # pb
3. [reason] 收尾${i}${i === 2 ? '版' : ''}
  - ← b
  + → out: text  # o
4. [check final] 把关
  - ← out
  + → ok: bool  # k
  + → why: text  # w
`;
      const r = e.submitReplan('1', md, { proactive: true });
      expect(r.status).toBe('ok');
    }
    // adaptive 额度应完好:走真失败到 adaptive_needed 后 replan 仍可提交
    // (直接核内部计数——adaptive 计数器未被 proactive 触碰)
    expect((e as unknown as { replanCounters: Map<string, number> }).replanCounters.get('1') ?? 0).toBe(0);
  });

  it('反例：running 容器的内部编辑 → 递归比对拒点名（review P1-②——修前只核顶层 type+summary,内部编辑被静默丢弃且响应谎报 ok）', () => {
    const host = { workspace_dir: '/tmp/test', sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } } } as unknown as HostConfig;
    const NESTED = `# N
Id: n

## Goal
g

## Outputs
- out: text  # o

## Steps
1. [subtask] 外容器
  + → out: text  # o
  1.1. [subtask] 内容器
    + → mid: text  # m
    1.1.1. [reason] 内一
      + → mid: text  # m
    1.1.2. [reason] 内二
      - ← mid
      + → mid: text  # m
  1.2. [reason] 外收尾
    - ← mid
    + → out: text  # o
`;
    const e = new ExecutionEngine();
    e.initExecution(NESTED, host);
    e.nextStep();
    expect(e.completeStep('1.1.1', { mid: 'x' }).status).toBe('ok');   // 内容器 1.1 现为 running
    // 编辑外容器,前缀含 running 的 1.1——但把 1.1 内部的"内二"改版
    const md = `1. [subtask] 内容器
  + → mid: text  # m
  1.1. [reason] 内一
    + → mid: text  # m
  1.2. [reason] 内二改版
    - ← mid
    + → mid: text  # m
2. [reason] 外收尾
  - ← mid
  + → out: text  # o
`;
    const r = e.submitReplan('1', md, { proactive: true });
    expect(r.status).toBe('error');                                     // 修前谎报 ok 且编辑被丢
    expect(JSON.stringify(r.errors)).toContain('前缀');
  });

  it('反例：主动编辑已终态容器 → 拒（没有未执行部分可编）', () => {
    const host = { workspace_dir: '/tmp/test', sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } } } as unknown as HostConfig;
    const engine = new ExecutionEngine();
    const SIMPLE = `# S
Id: s

## Goal
g

## Outputs
- r: text  # r

## Steps
1. [subtask] 容器
  + → r: text  # r
  1.1. [reason] 唯一步
    + → r: text  # r
2. [exit] 完
`;
    engine.initExecution(SIMPLE, host);
    engine.nextStep();
    expect(engine.completeStep('1.1', { r: '完了' }).status).toBe('ok');
    const r = engine.submitReplan('1', '1. [reason] 再来\n  + → r: text  # r', { proactive: true });
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.errors)).toContain('未终态');
  });
});

// 实例主动中止（^anc-exec-abort,2026-08-26——todo/0007 第3项"用户不要了"的暗管）：
// 六条行为契约正反例成对。// @v: anc-exec-abort
describe('实例主动中止（abort）', () => {
  const ASPEC = `# A
Id: a

## Goal
g

## Outputs
- out: text  # o

## Steps
1. [reason] 甲
  + → x: text  # px
2. [reason] 乙
  - ← x
  + → out: text  # o
`;

  it('正例：running 实例 abort → aborted,跨进程持久,status 凌驾步骤态如实', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'abort-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(ASPEC, MINIMAL_HOST_CONFIG, { stateDir });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    engine.nextStep();   // 1 running——中间态中止
    const r = engine.abort('用户放弃') as { status: string; execution_status: string; abort_reason: string };
    expect(r.status).toBe('ok');
    expect(r.execution_status).toBe('aborted');
    expect(r.abort_reason).toBe('用户放弃');
    // 契约5:status 如实（步骤 1 还是 running,但实例已死）
    expect(engine.getStatus().execution_status).toBe('aborted');
    // 契约6:中间步骤不追改——中止那一刻的现场保真
    expect(engine.getStatus().current_step).toBe('1');
    // 跨进程:另起引擎 load,终态与原因都在
    const restored = ExecutionEngine.load(join(stateDir, init.instance_id));
    expect(restored.getStatus().execution_status).toBe('aborted');
    const st = JSON.parse(readFileSync(join(stateDir, init.instance_id, 'state.json'), 'utf-8'));
    expect(st.terminal_state).toBe('aborted');
    expect(st.abort_reason).toBe('用户放弃');
  });

  it('正例：abort 幂等——重复 abort 原响应重放不报错,原因不被第二次改写', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ASPEC, MINIMAL_HOST_CONFIG);
    engine.abort('第一次');
    const r2 = engine.abort('第二次') as { status: string; abort_reason: string };
    expect(r2.status).toBe('ok');
    expect(r2.abort_reason).toBe('第一次');   // 同态重放,不改账
  });

  it('反例：aborted 后一切推进与回写被墓碑拒（nextStep 短路 RUN_ABORTED / completeStep 拒记账）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ASPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.abort();
    const n = engine.nextStep();
    expect(n.status).toBe('failed');
    expect((n as { failure_reason: string }).failure_reason).toContain('RUN_ABORTED');
    const c = engine.completeStep('1', { x: '迟到产出' });
    expect(c.status).toBe('error');
    expect(c.message).toContain('RUN_ABORTED');
  });

  it('反例：completed 实例 abort → ABORT_TERMINAL_CONFLICT（事实不被意图覆盖）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ASPEC, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.completeStep('1', { x: 'v' });
    engine.nextStep();
    engine.completeStep('2', { out: 'done' });
    expect(engine.nextStep().status).toBe('completed');
    const r = engine.abort('迟到的放弃');
    expect(r.status).toBe('error');
    expect((r as { message: string }).message).toContain('ABORT_TERMINAL_CONFLICT');
    expect(engine.getStatus().execution_status).toBe('completed');   // 账未被污染
  });

  it('反例：缺省 reason → (user abort) 兜底入账', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ASPEC, MINIMAL_HOST_CONFIG);
    const r = engine.abort() as { abort_reason: string };
    expect(r.abort_reason).toBe('(user abort)');
  });
});

// subtask free 到步展开（^anc-exec-subtask-free-expand,2026-08-27——plan-do-check-retry-pass;
// F1 强制 check/F2 复用 adaptive_needed+initial_plan/F3 [子任务 开放]）。// @v: anc-exec-subtask-free-expand
describe('subtask free 到步展开', () => {
  const FSPEC = `# F
Id: f

## Goal
g

## Outputs
- out: text  # o

## Steps
1. [reason] 前面
  + → a: text  # pa

2. [subtask free] 后面的活（到步展开）
  - ← a
  + → out: text  # o
`;

  function mkAt2() {
    const e = new ExecutionEngine();
    const init = e.initExecution(FSPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
    e.nextStep();
    e.completeStep('1', { a: '前面的产出值' });
    return e;
  }

  it('正例：到步吐 initial_plan——携执行时上下文（← 输入实际值）,failure 置空形态', () => {
    const e = mkAt2();
    const r = e.nextStep() as any;
    expect(r.status).toBe('adaptive_needed');
    expect(r.reason).toBe('initial_plan');
    expect(r.subtask_id).toBe('2');
    expect(r.expansion_context).toEqual({ a: '前面的产出值' });   // 拿真产出定计划——不喂=盲规划
    expect(r.failure.attempt).toBe(0);
    expect(r.original_children).toEqual([]);
  });

  it('正例：展开提交（含 check 无 commit）→ 接续执行展开物首步;失败驱动语义零波动', () => {
    const e = mkAt2();
    e.nextStep();
    const md = '1. [act free] 按上下文干\n  - ← a\n  + → out: text  # o\n2. [check final] 核验\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n';
    const r = e.submitReplan('2', md) as any;
    expect(r.status).toBe('ok');
    const n = e.nextStep() as any;
    expect(n.status).toBe('step_ready');
    expect(n.step_id).toBe('2.1');   // 展开物首步即下一步
  });

  it('反例：展开物无 check → EXPANSION_NO_CHECK 拒（F1 强制把关）', () => {
    const e = mkAt2();
    e.nextStep();
    const md = '1. [act free] 裸干没把关\n  - ← a\n  + → out: text  # o\n';
    const r = e.submitReplan('2', md) as any;
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.errors)).toContain('EXPANSION_NO_CHECK');
  });

  it('反例：展开物含 commit → EXPANSION_HAS_COMMIT 拒（free 家族自由不含不可逆,D2 同律）', () => {
    const e = mkAt2();
    e.nextStep();
    const md = '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n3. [commit] 偷偷发出去\n  - ← out\n';
    const r = e.submitReplan('2', md) as any;
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.errors)).toContain('EXPANSION_HAS_COMMIT');
  });

  it('正例：非空 free 不触发到步语义——预填计划照常执行（契约6）', () => {
    const SPEC2 = FSPEC.replace('2. [subtask free] 后面的活（到步展开）\n  - ← a\n  + → out: text  # o\n',
      '2. [subtask free] 预填了\n  - ← a\n  + → out: text  # o\n  2.1. [reason] 预填步\n    - ← a\n    + → out: text  # o\n');
    const e = new ExecutionEngine();
    e.initExecution(SPEC2, MINIMAL_HOST_CONFIG);
    e.nextStep();
    e.completeStep('1', { a: 'v' });
    const r = e.nextStep() as any;
    expect(r.status).toBe('step_ready');   // 不吐 adaptive_needed
    expect(r.step_id).toBe('2.1');
  });
});

// 契约5回归钉（阅卷实锤后补——首次展开曾 +1 进 adaptive 熔断池且污染相似度基线）。
// @v: anc-exec-subtask-free-expand
describe('subtask free 展开计数豁免（契约5）', () => {
  it('正例：首次展开不占 adaptive 熔断池,不写相似度基线', () => {
    const SPEC = `# F
Id: f
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask free] 到步展开
  + → out: text  # o
`;
    const e = new ExecutionEngine();
    e.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    e.nextStep();   // 到步吐 initial_plan
    const md = '1. [act free] 干\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n';
    expect((e.submitReplan('1', md) as any).status).toBe('ok');
    // 契约5:首规划不是失败重规划——两池零动
    expect((e as any).replanCounters.get('1') ?? 0).toBe(0);
    expect((e as any).lastReplanChildren.has('1')).toBe(false);
  });
});

// 三轮 review 修复批回归钉（^anc-exec-subtask-free-expand 契约1/2/4/7/9——每钉修前形态即红）。
// @v: anc-exec-subtask-free-expand
describe('subtask free 三轮review修复', () => {
  const FSPEC = `# F
Id: f
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [reason] 前面
  + → a: text  # p
2. [subtask free retry=2 adaptive] 到步展开
  - ← a
  + → out: text  # o
`;
  function mkAt2() {
    const e = new ExecutionEngine();
    e.initExecution(FSPEC, MINIMAL_HOST_CONFIG);
    e.nextStep();
    e.completeStep('1', { a: '真产出' });
    return e;
  }
  // Config 键注入变体（expansion_max 可配化钉用——FSPEC 无 Config 节,插在 Goal 后）
  function mkAt2Config(configLine: string) {
    const spec = FSPEC.replace('## Outputs', `## Config\n${configLine}\n## Outputs`);
    const e = new ExecutionEngine();
    e.initExecution(spec, MINIMAL_HOST_CONFIG);
    e.nextStep();
    e.completeStep('1', { a: '真产出' });
    return e;
  }

  it('正例：再吐语义不退化——第二次 nextStep 同为 initial_plan 携上下文（P0 钉,修前红:attempt 3/3 空原因假失败）', () => {
    const e = mkAt2();
    const r1 = e.nextStep() as any;
    const r2 = e.nextStep() as any;
    expect(r1.reason).toBe('initial_plan');
    expect(r2.reason).toBe('initial_plan');
    expect(r2.expansion_context).toEqual({ a: '真产出' });
    expect(r2.failure.attempt).toBe(0);
  });

  it('反例：展开后失败驱动 replan 仍禁 commit（终身闸——修前红:偷渡放行）', () => {
    const e = mkAt2();
    e.nextStep();
    const md1 = '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n';
    expect((e.submitReplan('2', md1) as any).status).toBe('ok');
    // 真实失败时序:check 判 false 耗尽 retry 进 adaptive
    for (let i = 0; i < 3; i++) {
      let n = e.nextStep() as any;
      while (n.status === 'step_ready') {
        if (n.step_type === 'check') e.completeStep(n.step_id, { ok: false, note: '不行' });
        else e.completeStep(n.step_id, { out: 'v' });
        n = e.nextStep() as any;
        if (n.status !== 'step_ready') break;
      }
      if (n.status === 'adaptive_needed' && !n.reason) {
        const md2 = '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check] 中核\n  - ← out\n  + → m_ok: bool  # k\n  + → m_note: text  # n\n3. [commit] 偷渡\n  - ← out\n4. [check final] 终核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n';
        const r = e.submitReplan('2', md2) as any;
        expect(r.status).toBe('error');
        expect(JSON.stringify(r.errors)).toContain('EXPANSION_HAS_COMMIT');
        return;
      }
    }
    throw new Error('未走到 adaptive_needed——脚手架失效');
  });

  it('反例：check 埋在 branch 死支不算主干——EXPANSION_NO_CHECK 拒（修前红:some() 全树扫认死支）', () => {
    const e = mkAt2();
    e.nextStep();
    const md = '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [branch] 分\n  + → ok: bool  # k\n  2.1. [case(out == "永不")] 死支\n    2.1.1. [check final] 埋此\n      - ← out\n      + → ok: bool  # k\n      + → note: text  # n\n  2.2. [case(else)] 活支\n    2.2.1. [reason] 不核\n      - ← out\n      + → ok: bool  # k\n';
    const r = e.submitReplan('2', md) as any;
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.errors)).toContain('EXPANSION_NO_CHECK');
  });

  it('反例：全实例展开总数达缺省上限 20——下一次拒 EXPANSION_LIMIT 且报文携问人指引（修前红:嵌套各池独立无总闸;缺省 10→20 随可配化调,2026-08-29 作者定）', () => {
    const e = mkAt2();
    e.nextStep();
    (e as any).expansionCount = 20;   // 底账直置(逐次展开搭 20 层嵌套脚手架成本高;字段+持久化另有断言)
    const md = '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n';
    const r = e.submitReplan('2', md) as any;
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.errors)).toContain('EXPANSION_LIMIT');
    expect(JSON.stringify(r.errors)).toContain('extend-expansion');   // 耗尽不硬烧——报文自带续批指引(问人协议在报文里,driver 不需要背)
  });

  it('正例：缺省上限恰为 20——count=19 放行（锁定作者拍定值,变异 DEFAULT_EXPANSION_MAX≠20 即红）', () => {
    const e = mkAt2();
    e.nextStep();
    (e as any).expansionCount = 19;   // 19<20 放行;若缺省被改小(如10)此钉红
    const md = '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n';
    const r = e.submitReplan('2', md) as any;
    expect(r.status).toBe('ok');
  });

  it('正例：Config expansion_max 可配——配 2 则第 3 次展开即拒(缺省 20 不适用)', () => {
    const e = mkAt2Config('expansion_max: 2');
    e.nextStep();
    (e as any).expansionCount = 2;
    const md = '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n';
    const r = e.submitReplan('2', md) as any;
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.errors)).toContain('EXPANSION_LIMIT');
    expect(JSON.stringify(r.errors)).toContain('上限 2');
  });

  it('反例：Config expansion_max 非法值（0）——运行时静默回缺省 20 不炸（配置钝感）', () => {
    const e = mkAt2Config('expansion_max: 0');
    e.nextStep();
    (e as any).expansionCount = 5;   // 若 0 生效会拒;回缺省 20 则放行
    const md = '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n';
    const r = e.submitReplan('2', md) as any;
    expect(r.status).toBe('ok');
  });

  it('正例：超限后携 extendExpansion 授权放行一次——照常计数,下次超限再问（耗尽不硬烧,2026-08-29 作者定）', () => {
    const e = mkAt2Config('expansion_max: 1');
    e.nextStep();
    (e as any).expansionCount = 1;
    const md = '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n';
    // 无授权:拒
    expect((e.submitReplan('2', md) as any).status).toBe('error');
    // 携授权:放行且计数照涨
    const r2 = e.submitReplan('2', md, { extendExpansion: true }) as any;
    expect(r2.status).toBe('ok');
    expect((e as any).expansionCount).toBe(2);   // 授权放行不豁免计数——下次超限重新问,防"批一次等于无限批"
  });

  it('反例：aborted 实例拒收展开（墓碑门——修前红:死实例照收改树）', () => {
    const e = mkAt2();
    e.nextStep();
    e.abort('不要了');
    const md = '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n';
    const r = e.submitReplan('2', md) as any;
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.errors)).toContain('RUN_ABORTED');
  });

  it('正例：缺值输入 null 占位+missing_inputs 清单（修前红:静默缺席）', () => {
    const SPEC2 = `# F2
Id: f2
## Goal
g
## Inputs
- b: text  # 未传参
## Outputs
- out: text  # o
## Steps
1. [subtask free] 到步展开
  - ← b
  + → out: text  # o
`;
    const e = new ExecutionEngine();
    e.initExecution(SPEC2, MINIMAL_HOST_CONFIG);   // b 未传值
    const r = e.nextStep() as any;
    expect(r.reason).toBe('initial_plan');
    expect(r.expansion_context).toEqual({ b: null });
    expect(r.missing_inputs).toEqual(['b']);
  });

  it('正例：expansionCount 跨进程持久（修前红:字段不落盘熔断空炮）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'sfree-exp-'));
    const e = new ExecutionEngine();
    const init = e.initExecution(FSPEC, MINIMAL_HOST_CONFIG, { stateDir }) as any;
    e.nextStep(); e.completeStep('1', { a: 'v' }); e.nextStep();
    const md = '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n';
    expect((e.submitReplan('2', md) as any).status).toBe('ok');
    const restored = ExecutionEngine.load(join(stateDir, init.instance_id));
    expect((restored as any).expansionCount).toBe(1);
  });
});

// expansion_context 大值 deflate（二轮 review P2 测试债——$file 指针形态从未被断言）。
// @v: anc-exec-subtask-free-expand
describe('subtask free expansion_context 大值卸载', () => {
  it('正例：超阈值输入 deflate 成 $file 指针,文件落 work_zone 跨进程可读', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'sfree-defl-'));
    const SPEC = `# F
Id: f
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [reason] 前面
  + → big: text  # 大产出
2. [subtask free] 到步展开
  - ← big
  + → out: text  # o
`;
    const e = new ExecutionEngine();
    const init = e.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir }) as any;
    e.nextStep();
    const bigVal = 'x'.repeat(60 * 1024);   // 超 DEFLATE_THRESHOLD
    e.completeStep('1', { big: bigVal });
    const r = e.nextStep() as any;
    expect(r.reason).toBe('initial_plan');
    const ptr = r.expansion_context.big as { $file?: string };
    expect(ptr).toHaveProperty('$file');   // 指针形态非原值
    const onDisk = JSON.parse(readFileSync(ptr.$file!, 'utf-8'));   // 落盘为 JSON 序列化形态
    expect(onDisk).toBe(bigVal);           // 指针可读且内容保真
  });
});

// 0040 测试债补钉批（2026-09-04——五条中第 2/3/4/5 条;第 1 条随 recover 极性反转批销,
// 第 6 条在 act-body-interpreter.test.ts）。// @v: anc-exec-subprocess-run, anc-exec-crash-recovery, anc-exec-tool-request, anc-exec-time-builtins
describe('0040 补钉:失败清账/state损坏/args卸载/响应字段形状', () => {
  const TOOL_SPEC = `# T40
Id: t40

## Goal
g

## Inputs
- big: text  # 大参数

## Outputs
- done: line  # r

## Steps
1. [act] 用工具
  - ← big
  + → done: line
  > 调外部工具
  > - 工具: my_tool
  > \`\`\`hop_python
  > r = my_tool(payload: big)
  > done = "ok"
  > \`\`\`
`;

  it('正例(第2条):未捕获失败终局清三账——journal 残账不带进 failed 后的读面（契约"完成/失败/重试均清",失败路径此前零测试）', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 't40-fail-'));
    const eng = new ExecutionEngine();
    const init = eng.initExecution(TOOL_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { big: 'x' } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    const n = await eng.advanceToCaller();
    expect(n.status).toBe('tool_request');   // 工具挂起——toolJournal 记账开始
    // 提交一轮工具结果(入账)后步骤失败——三账须清
    eng.submitToolResult('1', { result: 'partial', success: true });
    eng.failStep('1', '模拟失败');
    // 读面凭证:persist 后 state.json 的三 journal 键下不再有本步残账
    const stateRaw = JSON.parse(readFileSync(join(stateDir, init.instance_id, 'state.json'), 'utf-8'));
    expect(stateRaw.tool_journal?.['1'] ?? undefined).toBeUndefined();
    expect(stateRaw.time_journal?.['1'] ?? undefined).toBeUndefined();
    expect(stateRaw.cmd_journal?.['1'] ?? undefined).toBeUndefined();
  });

  it('反例(第3条):state.json 损坏 → recover 抛 CORRUPT_STATE_FILE 人工介入,不猜不修（设计 resume SOP 末条,此前零测试锁定）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 't40-corrupt-'));
    const eng = new ExecutionEngine();
    const init = eng.initExecution(TOOL_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { big: 'x' } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    const stateFile = join(stateDir, init.instance_id, 'state.json');
    writeFileSync(stateFile, '{ broken json', 'utf-8');   // 制造损坏
    expect(() => ExecutionEngine.recover(join(stateDir, init.instance_id))).toThrow(/CORRUPT_STATE_FILE/);
  });

  it('正例(第4条):tool_request args 超阈值 $file 卸载——大参数不内联灌响应（设计 423 行早承诺,发射点此前恒内联,本批实证修复的重放钉）', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 't40-deflate-'));
    const eng = new ExecutionEngine();
    const init = eng.initExecution(TOOL_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { big: 'x'.repeat(9000) } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    const n = await eng.advanceToCaller();
    expect(n.status).toBe('tool_request');
    if (n.status !== 'tool_request') return;
    const payload = (n.args as Record<string, unknown>).payload;
    expect(typeof payload === 'object' && payload !== null && '$file' in (payload as object)).toBe(true);   // 卸载形态
    const filePath = (payload as { $file: string }).$file;
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toBe('x'.repeat(9000));   // 文件内容=真值
    // namespace 形态钉(2026-09-04 review 面三实锤零保护补):卸载路径须含 vars/tool_<step>_<seq>/
    // 子目录段——同一步骤 body 多次调工具参数可重名(两次 write 都叫 content),无隔离必互踩
    expect(filePath).toContain(join('vars', 'tool_1_1'));
  });

  it('正例(第5条+第4条反例):tool_request 响应字段形状——output_path/work_zone/tool/tool_call_seq 全在场且形态正确;小 args 不卸载内联原值（此前仅被消费无独立钉）', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 't40-shape-'));
    const eng = new ExecutionEngine();
    const init = eng.initExecution(TOOL_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { big: 'small' } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    const n = await eng.advanceToCaller();
    expect(n.status).toBe('tool_request');
    if (n.status !== 'tool_request') return;
    expect(n.tool).toBe('my_tool');
    expect(n.tool_call_seq).toBe(1);                                    // 从 1 起
    expect(typeof n.work_zone).toBe('string');
    expect(n.work_zone!.length).toBeGreaterThan(0);
    expect(typeof n.output_path).toBe('string');
    expect(n.output_path).toContain('tool_1_1.json');                   // 设计约定文件名形态 tool_<step>_<seq>
    expect(n.output_path!.startsWith(n.work_zone!)).toBe(true);         // output_path 落 work_zone 内
    expect((n.args as Record<string, unknown>).payload).toBe('small');  // 小值内联不卸载
  });
});

// 误终局两防线（0043 细化,2026-08-27 狗粮 bc32179f 实撞——乱序回写场景 fixture 化）。
// @v: anc-exec-state-persistence, anc-exec-crash-recovery
describe('误终局两防线（乱序回写）', () => {
  // 复刻狗粮时序:subtask 内 3.1/3.2 两步,driver 先收 3.2 的 step_ready 却回头交 3.1
  const WSPEC = `# W
Id: w
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask] 段
  + → out: text  # o
  1.1. [reason] 甲
    + → a: text  # pa
  1.2. [reason] 乙
    + → out: text  # o
`;

  it('正例：running 叶子在场时 nextStep 恒 WAITING_WRITEBACK 且不 finalize（0049 收紧后形态——原测试造"双 running 乱序"场景,新契约下第二次 nextStep 即被拦,双 running 不可能态从源头消除）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wwb-'));
    const e = new ExecutionEngine();
    const init = e.initExecution(WSPEC, MINIMAL_HOST_CONFIG, { stateDir }) as any;
    e.nextStep();                          // 1.1 running
    const r = e.nextStep() as any;         // 0049 新契约:撞 running 叶子即拦,不再派出 1.2
    expect(r.failure_reason).toContain('WAITING_WRITEBACK');
    expect(r.failure_reason).toContain('1.1');
    // 关键:不 finalize——盘上无 terminal_state
    const st = JSON.parse(readFileSync(join(stateDir, init.instance_id, 'state.json'), 'utf-8'));
    expect(st.terminal_state).toBeUndefined();
    // 依序交付照常完成
    e.completeStep('1.1', { a: 'v' });
    expect((e.nextStep() as any).step_id).toBe('1.2');
    e.completeStep('1.2', { out: 'done' });
    expect(e.nextStep().status).toBe('completed');
  });

  it('正例：recover 清误判 failed 残留（无 terminal_failure 凭据）——status 不再谎报（修前红:残留）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wwb2-'));
    const e = new ExecutionEngine();
    const init = e.initExecution(WSPEC, MINIMAL_HOST_CONFIG, { stateDir }) as any;
    e.nextStep(); e.nextStep();
    // 人工造历史残留形态(修前引擎会产的盘面):failed 标记无凭据
    (e as any).terminalState = 'failed';
    (e as any).persist();
    const dir = join(stateDir, init.instance_id);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')).terminal_state).toBe('failed');
    const r = ExecutionEngine.recover(dir);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')).terminal_state).toBeUndefined();
    expect(r.getStatus().execution_status).toBe('running');   // 如实
  });

  it('反例：有 terminal_failure 凭据的真失败 recover 不清（终局不可逆——0043 边界）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wwb3-'));
    const e = new ExecutionEngine();
    const init = e.initExecution(WSPEC, MINIMAL_HOST_CONFIG, { stateDir }) as any;
    e.nextStep();
    e.failStep('1.1', '真失败');
    // 耗尽默认 retry 直到函数级 fail
    for (let i = 0; i < 6; i++) {
      const n = e.nextStep() as any;
      if (n.status === 'failed') break;
      if (n.status === 'step_ready') e.failStep(n.step_id, '真失败');
    }
    const dir = join(stateDir, init.instance_id);
    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'));
    if (st.terminal_state === 'failed' && st.terminal_failure) {
      ExecutionEngine.recover(dir);
      const st2 = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'));
      expect(st2.terminal_state).toBe('failed');   // 有凭据不清
    } else {
      throw new Error('脚手架未到达带凭据的真失败终局:' + JSON.stringify(st.terminal_state) + '/' + JSON.stringify(!!st.terminal_failure));
    }
  });

  it('反例：aborted 墓碑 recover 不清（显式意图非误判）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wwb4-'));
    const e = new ExecutionEngine();
    const init = e.initExecution(WSPEC, MINIMAL_HOST_CONFIG, { stateDir }) as any;
    e.nextStep();
    e.abort('不要了');
    const dir = join(stateDir, init.instance_id);
    ExecutionEngine.recover(dir);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')).terminal_state).toBe('aborted');
  });
});


// @v: anc-exec-check-escalate —— 升层分派引擎面（0006 批次一;概念 ^anc-step-check-escalatable）
// 四条件机械分派/非授权 warn 不生效/guidance 消化不扣预算/nextStep 短路不重派/跨进程持久
describe('check escalatable 升层分派', () => {
  const ESC_SPEC = `# Esc
Id: esc-t
## Goal
g
## Inputs
- x: int  # 入
## Outputs
- r: text  # 出
## Steps
1. [subtask retry=2] 探索循环
  + → r: text  # 出
  1.1. [check escalatable] 收敛判定
    - ← x
    + → ok: bool  # 判定槽
    + → gap: yaml  # 缺口槽
    > 判收敛
  1.2. [act] 出结果
    + → r: text  # 出
    > \`\`\`hop_python
    > r = "done"
    > \`\`\`
`;
  const HOST_MIN = {
    workspace_dir: '/tmp/test',
    sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
    api_key: 'x',
  };

  it('正例：四条件命中 → paused(escalate),不入 failStep 不扣 retry,nextStep 短路重放卡', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'esc-'));
    const engine = new ExecutionEngine();
    engine.initExecution(ESC_SPEC, HOST_MIN, { stateDir, params: { x: 1 } });
    const n = engine.nextStep();
    expect(n.status).toBe('step_ready');   // 1.1 check running
    const resp = engine.completeStep('1.1', { ok: false, gap: { escalate: true, need: '要口径:P0阈值多少算收敛' } });
    expect((resp as { status?: string }).status).toBe('paused');
    expect((resp as { pause_reason?: string }).pause_reason).toBe('escalate');
    expect((resp as { presented_data?: { question?: string } }).presented_data?.question).toContain('要口径');
    // 不扣 retry 预算（问路不是失败）:retry 计数器未动
    expect(engine.getExecEvents().some(e => e.event === 'retry')).toBe(false);
    // nextStep 短路:不重派 1.1,原样重放卡
    const again = engine.nextStep();
    expect(again.status).toBe('paused');
    expect((again as { step_id?: string }).step_id).toBe('1.1');
  });

  it('正例：guidance 消化 → 反馈进重试通道,步骤回 pending 重跑,判 true 后续跑到位', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'esc2-'));
    const engine = new ExecutionEngine();
    engine.initExecution(ESC_SPEC, HOST_MIN, { stateDir, params: { x: 1 } });
    engine.nextStep();
    engine.completeStep('1.1', { ok: false, gap: { escalate: true, need: '要方向' } });
    const r = engine.resumeFromEscalation('1.1', '按均值阈值 0.8 判收敛');
    expect(r.status).toBe('ok');
    // 反馈可见（L2c/L7 同源供给面）
    const fb = engine.getActiveRetryFeedback('1.1');
    expect(fb?.reason).toContain('升层指引');
    expect(fb?.reason).toContain('0.8');
    // 步骤回 pending → nextStep 重派同一 check
    const n2 = engine.nextStep();
    expect(n2.status).toBe('step_ready');
    expect((n2 as { step_id?: string }).step_id).toBe('1.1');
    // 这轮判 true → 继续 1.2
    engine.completeStep('1.1', { ok: true, gap: { escalate: false, note: '已收敛' } });
    const n3 = engine.nextStep();
    expect((n3 as { step_id?: string }).step_id).toBe('1.2');
  });

  it('反例：未声明 escalatable 的 check 写 escalate:true → 不升层,走常规 CHECK_FAILED(声明缺席字段无效)', () => {
    const spec = ESC_SPEC.replace('[check escalatable]', '[check]');
    const stateDir = mkdtempSync(join(tmpdir(), 'esc3-'));
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST_MIN, { stateDir, params: { x: 1 } });
    engine.nextStep();
    const resp = engine.completeStep('1.1', { ok: false, gap: { escalate: true, need: 'x' } });
    expect((resp as { status?: string }).status).not.toBe('paused');   // 走 failStep 容器 retry
    expect(engine.getEscalatePending()).toBeNull();
  });

  it('反例：说明槽是纯文本(非结构化对象) → 不升层照常失败(四条件之三不满足)', () => {
    const spec = ESC_SPEC.replace('+ → gap: yaml  # 缺口槽', '+ → gap: text  # 说明槽');
    const stateDir = mkdtempSync(join(tmpdir(), 'esc4-'));
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST_MIN, { stateDir, params: { x: 1 } });
    engine.nextStep();
    const resp = engine.completeStep('1.1', { ok: false, gap: 'escalate: true 只是文本' });
    expect((resp as { status?: string }).status).not.toBe('paused');
  });

  it('正例：跨进程——escalate 待答态落盘,load 后 getEscalatePending 仍在,resumeFromEscalation 可续', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'esc5-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(ESC_SPEC, HOST_MIN, { stateDir, params: { x: 1 } });
    engine.nextStep();
    engine.completeStep('1.1', { ok: false, gap: { escalate: true, need: '要方向' } });
    // 弃内存实例,从盘重建（server 重启形态）
    const dir = join(stateDir, (init as { instance_id: string }).instance_id);
    const engine2 = ExecutionEngine.load(dir);
    expect(engine2.getEscalatePending()).toBe('1.1');
    const r = engine2.resumeFromEscalation('1.1', '新方向');
    expect(r.status).toBe('ok');
  });

  it('反例：resumeFromEscalation 对非待答步 → INVALID_STATE 拒(不误吞普通步)', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'esc6-'));
    const engine = new ExecutionEngine();
    engine.initExecution(ESC_SPEC, HOST_MIN, { stateDir, params: { x: 1 } });
    const r = engine.resumeFromEscalation('1.2', '乱注入');
    expect(r.status).toBe('error');
  });
});

// 判据收严回归钉（阅卷变异C实锤:回退成只查terminalFailure时四钉全绿——收严半边无保护）。
// @v: anc-exec-crash-recovery, anc-exec-state-persistence
describe('误终局清理判据双凭据', () => {
  it('反例：盘面有 failed 步（hasFailed 凭据）而 terminal_failure 缺席 → recover 不清（修前红:初版单凭据判据洗白真失败）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wwb5-'));
    const SPEC = `# W5
Id: w5
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [reason] 甲
  + → out: text  # o
`;
    const e = new ExecutionEngine();
    const init = e.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir }) as any;
    e.nextStep();
    // 人工造 hasFailed 出口形态盘面:步骤 failed 在盘+failed 终态标记,terminal_failure 缺席
    //（allTerminal-hasFailed 出口正是这么落的——finalize 不写 terminal_failure）
    (e as any).stepStates.set('1', 'failed');
    (e as any).terminalState = 'failed';
    (e as any).terminalFailure = null;
    (e as any).persist();
    const dir = join(stateDir, init.instance_id);
    ExecutionEngine.recover(dir);
    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'));
    expect(st.terminal_state).toBe('failed');   // hasFailed 凭据在场——不清
  });
});

// @v: anc-exec-subprocess-run —— cmd_journal 跨进程持久/恢复（变异 D 击杀:删快照写+恢复读曾 748 全绿）
describe('subprocess.run cmd_journal 跨进程', () => {
  it('正例：journal 写盘可恢复——load 后重放取记录值不重执行（挂起中途进程死,续跑不重放命令的反面）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cjx-'));
    const host = { ...MINIMAL_HOST_CONFIG, sandbox: { ...(MINIMAL_HOST_CONFIG as any).sandbox, runtime: { available: ['echo'] } } } as any;
    const e = new ExecutionEngine();
    e.initExecution(`# T
Id: t-cjx
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [act] 跑
  + → out: text  # o
> 执行
> \`\`\`hop_python
> r = subprocess.run(["echo", "x"])
> out = r.stdout
> \`\`\`
`, host, { stateDir: dir });
    // 模拟步骤执行中已记一笔 journal 且进程死在完成前:直写账+persist
    (e as any).cmdJournal['1'] = [{ stdout: 'PERSISTED', stderr: '', returncode: 0 }];
    (e as any).persist();
    // 新进程 load——journal 从盘恢复(变异 D 删持久化/恢复读即此断言红)
    const e2 = ExecutionEngine.load(join(dir, e.getInstanceId()));
    expect(((e2 as any).cmdJournal['1'] ?? [])[0]?.stdout).toBe('PERSISTED');
  });
});

// @v: anc-exec-subprocess-run —— cmd_journal 跨进程持久与清账（review 抓 engine 五处接线零钉:变异删持久化全绿）
describe('subprocess.run cmd_journal 引擎账', () => {
  const SPEC = `# T
Id: t-cj
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [act] 跑命令
  + → out: text  # o
> 执行
> \`\`\`hop_python
> r = subprocess.run(["echo", "journal-test"])
> out = r.stdout
> \`\`\`
`;
  it("正例：body 完成后 cmdJournal 清账（重跑重执行是预期语义;标题原带'挂起中途持久化在盘'超卖零断言——阅卷抓,持久化半边归 cmd_journal 跨进程钉）", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cj-'));
    const host = { ...MINIMAL_HOST_CONFIG, sandbox: { ...(MINIMAL_HOST_CONFIG as any).sandbox, runtime: { available: ['echo'] } } } as any;
    const e = new ExecutionEngine();
    e.initExecution(SPEC, host, { stateDir: dir });
    // 复用模式引擎消化:advanceToCaller 直执 body(subprocess.run 是内置非工具,不吐 tool_request)
    const adv = await e.advanceToCaller() as any;
    expect(['completed', 'step_ready']).toContain(adv.status);
    // 完成后账清(journal 是步骤级中断续跑设施,完成即无用)
    expect(Object.keys((e as any).cmdJournal)).toHaveLength(0);
    // out 真有值——命令真跑了
    expect(String(e.getVariableStore().read('out', 'root'))).toContain('journal-test');
  });
});

// @v: anc-exec-none-propagation —— lack_of_info 通道收编 reason 专属（0053,2026-08-31 作者三连
// 对焦定形:reason 返回=触发 fail(kind=lack_of_info)/check·act 不设/判定先于 schema 校验——
// 该形态天然缺声明槽,后判则 SCHEMA_MISMATCH 先打回逃生口永不可达。变异实证:早判块删除,
// 下方 reason 正例必转 SCHEMA_MISMATCH 红）
describe('lack_of_info 通道收编（reason 专属,0053）', () => {
  function readyStep1(engine: ExecutionEngine) {
    const r = engine.nextStep();
    if (r.status !== 'step_ready') throw new Error('expect step_ready, got ' + r.status);
  }
  const mkSpec = (stepType: string, extraOut = '') => `# T
Id: t
## Goal
g
## Steps
1. [${stepType}] 步
  + → r: text  # r${extraOut}
  > t
`;

  it('正例：reason 交 lack_of_info → failStep(kind=lack_of_info),不走 SCHEMA_MISMATCH', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(mkSpec('reason'), MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { lack_of_info: '缺上游报表原文' });
    expect(r.status).not.toBe('error');   // 非 SCHEMA_MISMATCH 打回
    expect(engine.getStepStates().get('1')).toBe('failed');
  });

  it('反例：act 交 lack_of_info → 照走 schema 校验（SCHEMA_MISMATCH,不进逃生口）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(mkSpec('act'), MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { lack_of_info: '缺文件' });
    expect(r.status).toBe('error');
    expect(String(r.message)).toContain('SCHEMA_MISMATCH');
    expect(engine.getStepStates().get('1')).not.toBe('failed');   // 停原步等重交,不失败
  });

  it('反例：check 交 lack_of_info → 照走 schema 校验（判不了的正形=如实 false/escalatable gap,不设第二入口）', () => {
    const spec = `# T
Id: t
## Goal
g
## Steps
1. [subtask] 组
  + → ok: bool
  1.1. [act] 干
    + → d: text
    > t
  1.2. [check] 验
    - ← d
    + → ok: bool
    + → why: text
    > 判
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    // 推进到 1.2
    let r = engine.nextStep();
    engine.completeStep('1.1', { d: 'x' });
    r = engine.nextStep();
    const cr = engine.completeStep('1.2', { lack_of_info: '判不了' });
    expect(cr.status).toBe('error');
    expect(String(cr.message)).toContain('SCHEMA_MISMATCH');
  });

  it('正例：reason 正常产出零误伤（不含 lack_of_info 键照常入账）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(mkSpec('reason'), MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { r: '正常答案' });
    expect(r.status).toBe('ok');
    expect(engine.getStepStates().get('1')).toBe('done');
  });
});


// hopissues/0050:resume 不清已进入的 for-each 循环账（recoverDanglingRunning loop 豁免）
// @v: anc-exec-crash-recovery
// 嵌套容器重入重灌显式初值（hopissues/0050〔循环累加器卡〕,作者拍 A——外层轮进=内层新的进入,
// 带 = 初值 声明的容器重灌;同一 loop 轮间/retry 保值不变。机制:resetChildrenToPending 对带
// default 的容器删 scope,下次 ensureScope 的 hasScope 闸不成立即重建重灌）
// @v: anc-exec-output-init
describe('嵌套容器重入重灌显式初值（hopissues/0050 循环累加器）', () => {
  const NESTED = `# N
Id: n-0050b
## Goal
g
## Inputs
- 清单: [line]
## Outputs
- 结果: [line]
## Steps
1. [loop for-each 项 in 清单, collect 单果 into 结果] 外层逐项
  + → 结果: [line]
  1.1. [subtask] 加工
    - ← 项
    + → 单果: line
    1.1.1. [loop max_iterations=2] 内层
      + → 攒: line = ""  # 累加器带显式初值
      1.1.1.1. [act] 记录进入值
        - ← 攒
        - ← 项
        + → 攒
        + → 单果: line
        > \`\`\`hop_python
        > 单果 = 项 + ":" + (攒 if 攒 != "" else "空")
        > 攒 = 项
        > \`\`\`
      1.1.1.2. [break] 一轮即走
`;
  it('正例：外层每轮进入内层,累加器都从初值起——跨外层项零残值（卡 probe 判据①:三个空;修前:[空,甲,乙] 残值漂移）', async () => {
    const e = new ExecutionEngine();
    e.initExecution(NESTED, MINIMAL_HOST_CONFIG, { params: { 清单: ['甲', '乙', '丙'] } });
    const r = await e.advanceToCaller() as any;
    expect(r.status).toBe('completed');
    expect(r.outputs?.['结果']).toEqual(['甲:空', '乙:空', '丙:空']);
  });

  it('反例：同一 loop 自己的轮间不重灌——累加器跨迭代保值(累加器语义本体,重灌面不扩大化)', async () => {
    const SELF = `# S\nId: s-0050b\n## Goal\ng\n## Outputs\n- 果: line\n## Steps\n1. [loop max_iterations=3] 攒三轮\n  + → 攒: line = ""  # acc\n  + → 果: line\n  1.1. [act] 追加一轮\n    - ← 攒\n    + → 攒\n    + → 果: line\n    > \`\`\`hop_python\n    > 攒 = 攒 + "x"\n    > 果 = 攒\n    > \`\`\`\n`;
    const e = new ExecutionEngine();
    e.initExecution(SELF, MINIMAL_HOST_CONFIG);
    const r = await e.advanceToCaller() as any;
    expect(r.status).toBe('completed');
    expect(r.outputs?.['果']).toBe('xxx');   // 三轮累加到 xxx——轮间重灌的坏实现会得 x
  });

  it('反例：不带初值的容器声明不受重灌波及——跨外层项自然保留（Python 大原则不动,例外边界收窄在显式 = 初值）', async () => {
    const NO_DEFAULT = `# ND\nId: nd-0050b\n## Goal\ng\n## Inputs\n- 清单: [line]\n## Outputs\n- 结果: [line]\n## Steps\n1. [act] 置底\n  + → 传递: line\n  > \`\`\`hop_python\n  > 传递 = ""\n  > \`\`\`\n2. [loop for-each 项 in 清单, collect 单果 into 结果] 外层\n  + → 结果: [line]\n  2.1. [subtask] 加工\n    - ← 项\n    - ← 传递\n    + → 单果: line\n    2.1.1. [act] 读上项写本项\n      - ← 项\n      - ← 传递\n      + → 传递\n      + → 单果: line\n      > \`\`\`hop_python\n      > 单果 = 项 + ":" + (传递 if 传递 != "" else "无")\n      > 传递 = 项\n      > \`\`\`\n`;
    const e2 = new ExecutionEngine();
    e2.initExecution(NO_DEFAULT, MINIMAL_HOST_CONFIG, { params: { 清单: ['甲', '乙'] } });
    const r = await e2.advanceToCaller() as any;
    expect(r.status).toBe('completed');
    expect(r.outputs?.['结果']).toEqual(['甲:无', '乙:甲']);   // 无初值声明的变量跨项保留——乙读到甲(Python 自然保留)
  });
});

describe('resume 保循环账（hopissues/0050 resume 卡——与上组的循环累加器卡同号不同卡,该卡已 fixed）', () => {
  const LOOP_SPEC = `# L
Id: l-0050
## Goal
g
## Inputs
- 清单: [text]
## Outputs
- 汇总: [text]
## Steps
1. [loop for-each 项 in 清单, collect 单项 into 汇总] 逐项
  + → 汇总: [text]  # 收集
  1.1. [reason] 处理
    - ← 项
    + → 单项: text  # 单项结果
`;
  it('正例：第 3 轮 resume → 循环账/元素绑定/收集缓冲三者俱存（修前:计数归1+缓冲清空+重绑首项）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0050-'));
    const e = new ExecutionEngine();
    const init = e.initExecution(LOOP_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { 清单: ['甲', '乙', '丙'] } }) as any;
    e.nextStep(); e.completeStep('1.1', { 单项: '甲果' }); e.nextStep();
    e.completeStep('1.1', { 单项: '乙果' }); e.nextStep();   // 第 3 轮 1.1 running
    expect(e.getLoopCounters().get('1')).toBe(3);
    // 跨进程 recover（resume 语义）
    const e2 = ExecutionEngine.recover(join(stateDir, init.instance_id));
    expect(e2.getLoopCounters().get('1')).toBe(3);                                // 计数不清
    expect(e2.getVars().variables?.['项']).toBe('丙');                             // 元素绑定保第 3 项
    // 体内悬空叶子被重置 pending,本轮重做——nextStep 重发 1.1 而非回到首项
    const r = e2.nextStep() as any;
    expect(r.step_id).toBe('1.1');
    const c = e2.completeStep('1.1', { 单项: '丙果' });
    expect(c.status).toBe('ok');
    expect((e2.nextStep() as any).status).toBe('completed');
    expect(e2.getVars().variables?.['汇总']).toEqual(['甲果', '乙果', '丙果']);      // 三轮成果俱全
  });

  it('反例：running 但 loop_counters 无账的悬空 loop → recover 照旧回拨重跑（豁免判据是"有计数账"不是"是 loop"——review F1 改造:原形态用 pending loop 造场景,recoverDanglingRunning 首行 status!==running 即 continue,豁免判据根本不可达,标题承诺零行使;本形态同时是变异 C〔判据改恒豁免〕的重放钉）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0050b-'));
    const e = new ExecutionEngine();
    const init = e.initExecution(LOOP_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { 清单: ['甲', '乙'] } }) as any;
    e.nextStep();                                                  // 进入 loop:1=running 且 counters 有账
    // 手工制造"running 但无计数账"的悬空形态(旧版本快照/账损坏——豁免判据的反面输入):
    // 盘上 state.json 清空 loop_counters,快照里 loop 仍 running
    const stFile = join(stateDir, init.instance_id, 'state.json');
    const st = JSON.parse(readFileSync(stFile, 'utf-8'));
    st.loop_counters = {};
    writeFileSync(stFile, JSON.stringify(st));
    const e2 = ExecutionEngine.recover(join(stateDir, init.instance_id));
    // 无账不豁免——loop 回拨 pending 后 nextStep 重新进入,从第 1 轮起(计数重立为 1)
    const r = e2.nextStep() as any;
    expect(r.step_id).toBe('1.1');
    expect(e2.getLoopCounters().get('1')).toBe(1);
    expect(e2.getVars().variables?.['项']).toBe('甲');              // 元素绑定回到首项——回拨真实发生
  });
});

// hopissues/0049:错位递交拒收+running 叶子不透明（STALE_RESUBMIT 与 dfs 收紧）
// @v: anc-exec-stale-resubmit
describe('错位递交拒收（hopissues/0049）', () => {
  const THREE_FLAT = `# T3
Id: t3-0049
## Goal
g
## Outputs
- 丙丙: text
## Steps
1. [act free] 一
  + → 甲: text  # a
2. [act free] 二
  - ← 甲
  + → 乙: text  # b
3. [act free] 三
  - ← 乙
  + → 丙丙: text  # c
`;
  it('反例：向已 done 步递交不同内容 → STALE_RESUBMIT 拒,指针与变量全不动（probe 三判据:非 ok/步3 不 running/内容2 不进账——修前:静默吞+指针 2→3+双 running）', async () => {
    const e = new ExecutionEngine();
    e.initExecution(THREE_FLAT, MINIMAL_HOST_CONFIG);
    await e.advanceToCaller();
    e.completeStep('1', { 甲: '内容1' });
    await e.advanceToCaller();                                     // 步 2 running
    const stale = e.completeStep('1', { 甲: '内容2-本该被拒' });
    expect(stale.status).toBe('error');
    expect(String(stale.message)).toContain('STALE_RESUBMIT');
    expect(String(stale.message)).toContain("'2'");                // 指明在等步 2
    expect(e.getVars().variables?.['甲']).toBe('内容1');            // 变量不动
    const states = Object.fromEntries(e.getStepStates?.() ?? []);
    expect(states['3']).not.toBe('running');                       // 步 3 不被派出
  });

  // @v: anc-exec-tool-request, anc-exec-stale-resubmit —— todo/0057 G5:交叉信号钉(设计 dfs 条款
  // 尾句"tool_request 挂起时误调 advance 得到的 WAITING_WRITEBACK 正是该给 driver 的正确信号"
  // ——既有语义全库零测试,补钉锁死;夹具=独立模式工具循环真挂起(非手工造态)
  it('正例(0057-G5)：tool_request 挂起时误调 advance → WAITING_WRITEBACK 点名挂起步,不 finalize 不重发载荷（交叉信号是给 driver 的正确指路）', async () => {
    const SPEC = `# G5X
Id: g5x

## Goal
g

## Inputs
- v: line  # 输入

## Outputs
- done: line  # r

## Steps
1. [act] 用工具
  - ← v
  + → done: line
  > 调外部工具
  > - 工具: ext_tool
  > \`\`\`hop_python
  > r = ext_tool(x: v)
  > done = "ok"
  > \`\`\`
`;
    const eng = new ExecutionEngine();
    const stateDir = mkdtempSync(join(tmpdir(), 'g5x-'));
    const init = eng.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { v: 'a' } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    let r = await eng.advanceToCaller();
    expect(r.status).toBe('tool_request');   // 真挂起态(工具循环内 ToolCallPending,步骤已 running)
    // 误调形态一:nextStep(纯推进不带恢复语义)——dfs 撞 running 叶子该给 WAITING_WRITEBACK
    // 指路,而非假 failed 终局/静默跳过后继(设计 dfs 条款尾句的交叉信号本体)
    const rn = eng.nextStep();
    expect(rn.status).toBe('failed');                                  // WAITING_WRITEBACK 借 failed 壳(载体形态,非终态)
    if (rn.status !== 'failed') return;
    expect(String(rn.failure_reason)).toContain('WAITING_WRITEBACK');
    expect(String(rn.failure_reason)).toContain('1');                  // 点名挂起步
    // 误调形态二:advanceToCaller(带挂起恢复语义)——重发同一 tool_request 载荷续跑,同 seq
    // 不推进不炸(findSuspendedBodyStep 恢复路径;与形态一分道:恢复入口重发,纯推进入口指路)
    const ra = await eng.advanceToCaller();
    expect(ra.status).toBe('tool_request');
    if (ra.status !== 'tool_request') return;
    expect(ra.tool_call_seq).toBe(1);                                  // 同一次调用,seq 不涨
    // 两种误调都没 finalize:提交工具结果后正常走完
    eng.submitToolResult('1', { result: 'fine', success: true });
    const r3 = await eng.advanceToCaller();
    expect(r3.status).toBe('completed');
  });

  // @v: anc-exec-parallel-dispatch-model, anc-exec-stale-resubmit —— todo/0057 G6:并行派发宿主步
  // 与 dfs 拦截交互的专属钉(既有并行测试群只间接走过——设计明文"派发即入账标 done,拦截条件
  // 'running 且非容器'对它天然不成立",无专属测试点名这层机制)
  it('正例(0057-G6)：并行派发宿主步派发后标 done——dfs 的 running 叶子拦截对它天然不成立,主线照常推进不被 WAITING_WRITEBACK 卡住', () => {
    const SPEC = `# G6X
Id: g6x

## Goal
g

## Inputs
- xs: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in xs, collect o into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [subtask parallel] 单项
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int
      > 纯计算
      > \`\`\`hop_python
      > o = n + 1
      > \`\`\`
2. [act] 收尾
  - ← outs
  + → done: line
  > 纯机械
  > \`\`\`hop_python
  > done = "n=" + str(len(outs))
  > \`\`\`
`;
    const eng = new ExecutionEngine();
    const stateDir = mkdtempSync(join(tmpdir(), 'g6x-'));
    const init = eng.initExecution(SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { xs: [7, 8] } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    eng.setUnifiedDispatch(true);   // 派发门开(独立模式姿势;init 选项无此键,经 setter)
    // 首个派发点:dispatch_ready(宿主步交引擎异步派发)
    const r1 = eng.nextStep();
    expect(r1.status).toBe('dispatch_ready');
    if (r1.status !== 'dispatch_ready') return;
    // 机制本体:派发即标 done(engine.ts dispatchParallelSubtask"派发即推进"),loop 随即推进
    // 下一迭代把模板步重置 pending 备下一单——账面上宿主步**从不停留在 running**(探针实录:
    // 派发返回后 1.1 已是 pending 而非 running),所以 dfs 的"running 且非容器"拦截条件对它
    // 天然不成立,主线不会被 WAITING_WRITEBACK 误卡(那是给"已派出待回写的 LLM 叶子步"的信号)。
    // child_instance('1.1.<iter>')是派发单号非步骤态,收割靠 inflight 账
    expect(eng.getStepStates().get(r1.step_id!)).not.toBe('running');  // 不变量:宿主步恒不滞留 running
    const r2 = eng.nextStep();                                         // 主线不被卡:吐第二个派发而非 WAITING_WRITEBACK
    expect(r2.status).toBe('dispatch_ready');
    if (r2.status !== 'dispatch_ready') return;
    expect(r2.child_instance).not.toBe(r1.child_instance);             // 真是下一单,不是重发同单
    expect(eng.getStepStates().get(r1.step_id!)).not.toBe('running');  // 第二单后同样不滞留
  });

  it('反例：running 叶子在场时 nextStep 不派后继兄弟——WAITING_WRITEBACK（dfs 层独立钉:变异撤 dfs 拦截时 STALE 分流拦不住"无递交纯推进"路径,M3 全绿实锤后补）', () => {
    const e = new ExecutionEngine();
    e.initExecution(THREE_FLAT, MINIMAL_HOST_CONFIG);
    const r1 = e.nextStep() as any;
    expect(r1.step_id).toBe('1');                                  // 步 1 派出,running
    const r2 = e.nextStep() as any;                                // 不递交直接再推
    expect(r2.status).toBe('failed');
    expect(String(r2.failure_reason)).toContain('WAITING_WRITEBACK');
    const states = Object.fromEntries(e.getStepStates());
    expect(states['2']).toBe('pending');                           // 步 2 未被派出（修前:被透明跳过步1 派出步2,双 running）
  });

  // @v: anc-exec-stale-resubmit —— 幂等重发不进 advance（hopissues/0056 B 案:零状态变化的
  // 请求没有推进可言;原借道 WAITING_WRITEBACK 的 failed 壳自相矛盾——status:"failed" 配报文
  // "不是失败",driver 按"failed=终态"教条误伤合法重发。变异实证:删 completeAndAdvance 的
  // ALREADY_DONE 短路块,下方回执钉转 failed 红）
  it('正例：同值重发与无值重发 → completeAndAdvance 直返结构化 ok+欠账指引,不借道 WAITING_WRITEBACK（0056 B 案）', async () => {
    const e = new ExecutionEngine();
    e.initExecution(THREE_FLAT, MINIMAL_HOST_CONFIG);
    await e.advanceToCaller();
    e.completeStep('1', { 甲: 'v' });
    await e.advanceToCaller();
    // 经 completeAndAdvance（driver 实际走的门）——回执即终点不再推进
    const resend = await e.completeAndAdvance('1', { 甲: 'v' }) as any;   // 同值重发
    expect(resend.status).toBe('ok');
    expect(resend.code).toBe(ErrorCode.ALREADY_DONE);
    expect(String(resend.message)).toContain('幂等重发');
    expect(String(resend.message)).toContain("'2'");                     // 欠账指引点名步 2
    const noOut = await e.completeAndAdvance('1') as any;                 // 无值重发同判
    expect(noOut.status).toBe('ok');
    expect(noOut.code).toBe(ErrorCode.ALREADY_DONE);
    // 账面无污染:步 2 仍在等回写,重发后照常交付步 2 可推进
    const after = await e.completeAndAdvance('2', { 乙: 'w' }) as any;
    expect(after.status).toBe('step_ready');
    expect(after.step_id).toBe('3');
  });

  it('正例：声明类型步骤完成后逐字节重发同一响应 → ALREADY_DONE ok（比对在归一后进行——review D1/变异 A 重放钉:比对拿原始递交值直比归一后已存值,声明 yaml/int 时逐字节重发被误拒 STALE_RESUBMIT,真幂等承诺塌）', async () => {
    const TYPED = `# TY\nId: ty-d1\n## Goal\ng\n## Outputs\n- 数: int\n## Steps\n1. [act free] 出数\n  + → 结构: yaml  # s\n2. [act free] 收尾\n  - ← 结构\n  + → 数: int  # n\n`;
    const e = new ExecutionEngine();
    e.initExecution(TYPED, MINIMAL_HOST_CONFIG);
    await e.advanceToCaller();
    // driver 原始形态:yaml 槽给 JSON 字符串(写入侧归一成结构)——逐字节重发同一原始串必须仍幂等
    const raw = { 结构: '{"a": 1, "b": [2, 3]}' };
    e.completeStep('1', raw);
    await e.advanceToCaller();                                     // 步 2 running
    expect(e.getVars().variables?.['结构']).toEqual({ a: 1, b: [2, 3] });   // 已存值=归一后结构
    const repeat = e.completeStep('1', { 结构: '{"a": 1, "b": [2, 3]}' });  // 逐字节同一响应重发
    expect(repeat.status).toBe('ok');                              // 归一后比对→同内容→真幂等
    expect(repeat.code).toBe(ErrorCode.ALREADY_DONE);
  });

  it('反例：容器内叶子 running 时错位递交 → 报文点名叶子号不报容器号（review D2:waiting 查找原取先序第一个 running,容器在场时容器号对 driver 无纠错价值）', async () => {
    const NESTED = `# NE\nId: ne-d2\n## Goal\ng\n## Outputs\n- 果: text\n## Steps\n1. [act free] 一\n  + → 甲: text  # a\n2. [subtask] 容器\n  - ← 甲\n  + → 果: text  # r\n  2.1. [act free] 里\n    - ← 甲\n    + → 果: text  # r\n`;
    const e = new ExecutionEngine();
    e.initExecution(NESTED, MINIMAL_HOST_CONFIG);
    await e.advanceToCaller();
    e.completeStep('1', { 甲: 'v' });
    await e.advanceToCaller();                                     // 容器 2=running,叶子 2.1=running
    const stale = e.completeStep('1', { 甲: '不同内容' });
    expect(stale.status).toBe('error');
    expect(String(stale.message)).toContain("'2.1'");              // 点名叶子
    expect(String(stale.message)).not.toContain("等步骤 '2'的");     // 不报容器号
  });

  it('反例：无 running 时错位递交 → 报文点名先序第一个 pending（review D3:设计"查无则报下一 pending"原空转——代码未实现且零测试）', () => {
    const e = new ExecutionEngine();
    e.initExecution(THREE_FLAT, MINIMAL_HOST_CONFIG);
    const r1 = e.nextStep() as any;
    expect(r1.step_id).toBe('1');
    e.completeStep('1', { 甲: '内容1' });                           // 完成步 1,不推进——无 running,步 2 pending
    const stale = e.completeStep('1', { 甲: '内容2' });
    expect(stale.status).toBe('error');
    expect(String(stale.message)).toContain('STALE_RESUBMIT');
    expect(String(stale.message)).toContain("'2'");                // 点名下一 pending
    expect(String(stale.message)).toContain('下一个待执行');
  });
});

// hopissues/0046:reap 对无 parallel 标注 call 响亮拒（原静默 no-op 丢输出）
// @v: anc-exec-reap-misuse-reject
describe('reap 误用响亮拒（hopissues/0046）', () => {
  const CALL_MAIN = `# M
Id: m-0046
## Goal
g
## Inputs
- x: text
## Outputs
- z: text
## Steps
1. [call callee(x: x)] 调子
  + → y: 子y
2. [act] 用
  - ← y
  + → z: text  # 结果
  > \`\`\`hop_python
  > z = y + "_used"
  > \`\`\`
`;
  it('反例：无 parallel 标注的 [call] 误用 reap → REAP_NOT_PARALLEL 响亮拒且报文指路 submit --child-instance（修前:静默 return,父变量 undefined 继续跑）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0046a-'));
    const e = new ExecutionEngine();
    e.initExecution(CALL_MAIN, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 'hello' } });
    e.nextStep();   // 推进到 call 步（无 parallel 标注,不进在飞名册）
    expect(() => e.reapFromChildDir('1', 'completed')).toThrow(/REAP_NOT_PARALLEL/);
    try { e.reapFromChildDir('1', 'completed'); } catch (err) {
      expect(String(err)).toContain('submit_and_fetch_next');   // 报文指路正确命令
      expect(String(err)).toContain('--child-instance');
    }
  });

  it('反例：从未派发过的任意子实例名 reap → 同样响亮拒（不是只拦 call 步骤号形态）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0046b-'));
    const e = new ExecutionEngine();
    e.initExecution(CALL_MAIN, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 'hi' } });
    e.nextStep();
    expect(() => e.reapFromChildDir('never-dispatched-child', 'failed')).toThrow(/REAP_NOT_PARALLEL/);
  });

  it('反例：前缀撞名不误判幂等——账上只有 "1.2 ok" 收割记录时 reap("1") 仍响亮拒（review 面三探针固化:startsWith 无边界时 "1".startsWith 误中静默吞,0046 病灶在最易混场景复活）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0046d-'));
    const e = new ExecutionEngine();
    e.initExecution(CALL_MAIN, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 'hi' } });
    e.nextStep();
    // 注入别的 child('1.2')的收割记录——误用方拿步骤号 '1' 来 reap,不得被它误判为真幂等
    e.getExecEvents().push({ at: new Date().toISOString(), step_id: '1', event: 'parallel_reap', detail: '1.2 ok' });
    expect(() => e.reapFromChildDir('1', 'completed')).toThrow(/REAP_NOT_PARALLEL/);
    // 反向撞名同拒:'1.12 ok' 在账,reap('1.1') 不得误中
    e.getExecEvents().push({ at: new Date().toISOString(), step_id: '1', event: 'parallel_reap', detail: '1.12 ok' });
    expect(() => e.reapFromChildDir('1.1', 'completed')).toThrow(/REAP_NOT_PARALLEL/);
  });

  it('正例：killed child 的迟到 reap 静默不抛不产出（契约真幂等第二半边——killed 条目仍挂 inflight 外层 find 命中,由 reapParallelCall 的 killed 早返回消化,review G1 补）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0046f-'));
    const e = new ExecutionEngine();
    e.initExecution(CALL_MAIN, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 'hk' } });
    e.nextStep();
    // 直接压一条 killed 态在飞账(测试面直捅——行为面等价于主线失败杀活后的迟到通知);
    // killed worker 的子实例目录在真实场景是存在的(它跑过)——补最小盘面供 reap 读
    (e as any).inflight.push({ step_id: '1', iter: 1, child_instance: 'k1', host_container: '', dispatched_at: new Date().toISOString(), status: 'killed', params: {} });
    const kdir = join((e as any).instanceDir, 'calls', 'k1');
    mkdirSync(kdir, { recursive: true });
    writeFileSync(join(kdir, 'vars.json'), JSON.stringify({ format_version: 1, scopes: { root: { y: 'late' } } }));
    writeFileSync(join(kdir, 'state.json'), JSON.stringify({ format_version: 1, step_states: {}, committed_steps: [] }));
    expect(() => e.reapFromChildDir('k1', 'completed')).not.toThrow();   // 静默消化
    expect((e as any).inflight.some((f: any) => f.child_instance === 'k1')).toBe(true);   // killed 账不动(丢弃结果)
  });

  it('正例：跨进程 load 后重复 reap 仍静默幂等（0046 实际场景恰是 CLI 每次新进程——exec_events 经 persist→load 往返,review G2 补）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0046e-'));
    const e = new ExecutionEngine();
    const init = e.initExecution(CALL_MAIN, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 'ho' } }) as any;
    e.nextStep();
    e.getExecEvents().push({ at: new Date().toISOString(), step_id: '1', event: 'parallel_reap', detail: 'child-x ok' });
    (e as any).persist();
    const e2 = ExecutionEngine.load(join(stateDir, init.instance_id));
    expect(() => e2.reapFromChildDir('child-x', 'completed')).not.toThrow();   // 载入后幂等记录仍有效
    expect(() => e2.reapFromChildDir('child-y', 'completed')).toThrow(/REAP_NOT_PARALLEL/);   // 未收割的照拒
  });

  it('正例：已收割的 child 重复 reap → 静默幂等不抛（exec_events 的 parallel_reap 记录判真幂等——重复 reap 是协议允许的）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0046c-'));
    const e = new ExecutionEngine();
    e.initExecution(CALL_MAIN, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 'hey' } });
    e.nextStep();
    // 直接注入一条 parallel_reap 事件模拟"曾收割"账面（recordEvent 私有,经导出账面注入:
    // 用 getExecEvents 返回的活引用 push——测试面直捅账本,行为面等价于真收割留痕）
    e.getExecEvents().push({ at: new Date().toISOString(), step_id: '1', event: 'parallel_reap', detail: 'ghost-child ok' });
    expect(() => e.reapFromChildDir('ghost-child', 'completed')).not.toThrow();
  });
});

// join 前置不变量判据 3——单 child 读失败隔离（0088 批⑩;载体沿革后由 reap 逐 child 收割承载,
// 见 exec-engine ^anc-exec-parallel-join-preconditions 载体沿革注:单 child 收割失败合成 failed
// 不连累兄弟。修前:reapFromChildDir/reconcileInflight 读坏 state.json 直接上抛 CORRUPT_STATE_FILE,
// 经 CLI reap_and_fetch_next/advance 炸整条命令,一个坏文件连累兄弟收割与主线推进）
// @v: anc-exec-parallel-join-preconditions
describe('reap 坏 state 单 child 隔离（join 前置不变量判据 3）', () => {
  const PAR_SPEC = `# T
Id: t-isolate
## Goal
g
## Inputs
- nums: [int]  # 列表
## Outputs
- outs: [int]  # 收集
## Steps
1. [loop for-each n in nums, collect o into outs] 逐项
  + → outs: [int]  # 收集列表
  1.1. [subtask parallel] 处理
    + → o: int  # 单项
    1.1.1. [reason] 算
      - ← n
      + → o: int  # 结果
2. [exit] 交付
`;
  // 夹具：父实例派发两 child,其一盘面写坏（state.json 非法 JSON）,另一正常终态
  function setupTwoChildren() {
    const stateDir = mkdtempSync(join(tmpdir(), 'reap-iso-'));
    const e = new ExecutionEngine();
    const init = e.initExecution(PAR_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { nums: [1, 2] } }) as any;
    e.setUnifiedDispatch(true);
    const d1 = e.nextStep() as any;
    const d2 = e.nextStep() as any;
    const instDir = join(stateDir, init.instance_id);
    // 坏 child（d1）：state.json 写坏成非法 JSON
    const badDir = join(instDir, 'parallel', d1.child_instance);
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'state.json'), '{{{not json');
    // 好 child（d2）：正常终态盘面（步骤全 done + 声明输出 o 在 vars）
    const goodDir = join(instDir, 'parallel', d2.child_instance);
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(join(goodDir, 'state.json'), JSON.stringify({ format_version: 1, step_states: { '1.1.1': 'done' }, committed_steps: [] }));
    writeFileSync(join(goodDir, 'vars.json'), JSON.stringify({ format_version: 2, scopes: { root: { parent: null, variables: { o: 22 } } } }));
    return { e, bad: d1.child_instance as string, good: d2.child_instance as string };
  }

  it('正例：坏 child 合成 failed 收割(集合语义不贡献元素)、好 child 结果正常收割、父实例不炸——主线走到 completed', () => {
    const { e, bad, good } = setupTwoChildren();
    // 逐 child 收割：坏 child 不抛（读失败在函数内合成 FailRecord）
    expect(() => e.reapFromChildDir(bad, 'completed')).not.toThrow();
    expect(() => e.reapFromChildDir(good, 'completed')).not.toThrow();
    // 两 child 均出账
    expect(e.getInflight().filter(f => f.child_instance === bad || f.child_instance === good)).toHaveLength(0);
    // 失败凭据留痕（reason 带 CORRUPT_STATE_FILE 定位,不静默）
    expect(e.getExecEvents().some(ev => ev.event === 'parallel_reap' && ev.detail?.startsWith(bad) && ev.detail.includes('CORRUPT_STATE_FILE'))).toBe(true);
    // 主线不被坏 child 拖死：收齐后 completed,collect 只含好 child 元素（列表变短语义）
    const r = e.nextStep() as any;
    expect(r.status).toBe('completed');
    expect(r.outputs['outs']).toEqual([22]);
  });

  it('正例：crash-resume 对账路同律——reconcileInflight 撞坏 child 不炸,坏 child 按 failed 收割出账、好 child 照常收割', () => {
    const { e, bad, good } = setupTwoChildren();
    const { reaped, stale } = e.reconcileInflight({ dispatchLostPolicy: 'stale' });
    expect(reaped).toContain(bad);
    expect(reaped).toContain(good);
    expect(stale).toEqual([]);
    expect(e.getInflight()).toHaveLength(0);
    const r = e.nextStep() as any;
    expect(r.status).toBe('completed');
    expect(r.outputs['outs']).toEqual([22]);
  });
});

// hopissues/0098:loop 里的串行 call 子实例按轮次命名（旧形态各轮共用 calls/<步骤号>/,re-init 净室
// 删掉前面轮次的产出,父层按路径读 ENOENT）。本组锁取名规则与 call_protocol 三处同值。
// @v: anc-exec-call-child-iter-id
describe('loop 里的串行 call 子实例按轮次命名（hopissues/0098）', () => {
  const withCli = (e: ExecutionEngine) => { (e as any).cliAbsPath = '/abs/cli.js'; (e as any).specPath = '/abs/p.md'; };
  const protoOf = (r: any) => { expect(r.status).toBe('step_ready'); expect(r.step_type).toBe('call'); return r.call_protocol; };

  it('正例：一层 for-each 两轮 → 子实例 ID 1.1.1 / 1.1.2,init_command 带 --step 1.1 --child-instance <ID>,回报与起步命令同值', () => {
    const spec = `# L
Id: l-0098
## Goal
g
## Inputs
- xs: [int]  # 列表
## Outputs
- outs: [int]  # 收集
## Steps
1. [loop for-each x in xs, collect v into outs] 逐项
  + → outs: [int]
  1.1. [call child(n: x)] 调子
    + → v: r
2. [exit] 交付
`;
    const e = new ExecutionEngine();
    e.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { xs: [5, 6] } });
    withCli(e);
    const cp1 = protoOf(e.nextStep());
    expect(cp1.child_instance).toBe('1.1.1');
    expect(cp1.init_command).toContain('--step 1.1 --child-instance 1.1.1 ');
    expect(cp1.child_advance).toContain('--instance 1.1.1');
    expect(cp1.report_completed).toContain('submit_and_fetch_next 1.1 --child-instance 1.1.1');
    expect(cp1.report_failed).toContain('--failure-child 1.1.1');
    e.completeCallStep('1.1', { r: 50 });
    const cp2 = protoOf(e.nextStep());
    expect(cp2.child_instance).toBe('1.1.2');
    expect(cp2.init_command).toContain('--step 1.1 --child-instance 1.1.2 ');
    e.completeCallStep('1.1', { r: 60 });
    const end = e.nextStep();
    expect(end.status).toBe('completed');
    if (end.status === 'completed') expect(end.outputs['outs']).toEqual([50, 60]);   // 回填仍按步骤号,loop 收集照旧
  });

  it('正例：两层嵌套 loop → ID 带外层到内层两段轮次,内层复位不致跨外层轮碰撞（只取最近一层时 1.1.1.1 会出现两次）', () => {
    const spec = `# N
Id: n-0098
## Goal
g
## Inputs
- xs: [int]  # 外
- ys: [int]  # 内
## Steps
1. [loop for-each x in xs] 外层
  1.1. [loop for-each y in ys] 内层
    1.1.1. [call child(a: x, b: y)] 调子
      + → z: r
2. [exit] 交付
`;
    const e = new ExecutionEngine();
    e.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { xs: [1, 2], ys: [7, 8] } });
    withCli(e);
    const ids: string[] = [];
    for (let k = 0; k < 4; k++) {
      ids.push(protoOf(e.nextStep()).child_instance);
      e.completeCallStep('1.1.1', { r: k });
    }
    expect(ids).toEqual(['1.1.1.1.1', '1.1.1.1.2', '1.1.1.2.1', '1.1.1.2.2']);
    expect(new Set(ids).size).toBe(4);
  });

  it('反例：不在任何 loop 里的 call → 子实例 ID 仍是裸步骤号（旧形态零变化）', () => {
    const spec = `# S
Id: s-0098
## Goal
g
## Inputs
- x: int  # 入
## Outputs
- v: int  # 出
## Steps
1. [call child(n: x)] 调子
  + → v: r
`;
    const e = new ExecutionEngine();
    e.initExecution(spec, MINIMAL_HOST_CONFIG, { params: { x: 1 } });
    withCli(e);
    const cp = protoOf(e.nextStep());
    expect(cp.child_instance).toBe('1');
    expect(cp.init_command).toContain('--step 1 --child-instance 1 ');
    expect(e.serialCallChildInstance('1')).toBe('1');
  });
});

// hopissues/0047:call 子实例 re-init 净室（原 init 不清 calls/ 嵌套残留,串行 for-each 迭代互相污染）
// @v: anc-exec-call-reinit-clean
describe('call 子实例 re-init 净室（hopissues/0047）', () => {
  const CALLEE = `# C
Id: c-0047
## Goal
g
## Inputs
- x: text
## Outputs
- y: text
## Steps
1. [act] 出
  - ← x
  + → y: text  # 结果
  > \`\`\`hop_python
  > y = x + "_out"
  > \`\`\`
`;
  it('正例：re-init 同一 call 子实例 → 上一轮的 calls/ 嵌套残留被清（修前:残留 persists 被下一迭代读到）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0047a-'));
    // iter1:建 call 子实例（parentInstanceId+callStepId → instanceId='1.1',落 stateDir/1.1/）
    const e1 = new ExecutionEngine();
    e1.initExecution(CALLEE, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 'a' }, parentInstanceId: 'parent-x', callStepId: '1.1' });
    // 模拟 iter1 的嵌套 call 残留（实际场景:callee 内 nested [call] 落 stateDir/1.1/calls/<nested>/）
    const residue = join(stateDir, '1.1', 'calls', 'nested-residue');
    mkdirSync(residue, { recursive: true });
    writeFileSync(join(residue, 'state.json'), '{"marker":"ITER1_RESIDUE"}');
    expect(existsSync(join(residue, 'state.json'))).toBe(true);
    // iter2:re-init 同一 call 步骤号
    const e2 = new ExecutionEngine();
    const r = e2.initExecution(CALLEE, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 'b' }, parentInstanceId: 'parent-x', callStepId: '1.1' }) as any;
    expect(r.status).toBe('ok');
    expect(existsSync(join(residue, 'state.json'))).toBe(false);   // 残留已清
    // iter2 干净起步照常可跑
    e2.nextStep();
    expect(e2.completeStep('1', { y: 'b_out' }).status).toBe('ok');
  });

  it('反例：有效撞名形态——只带 callStepId 不带 parentInstanceId 且目录预存在 → 不触发净室（review D4 重写:原反例两随机 UUID 目录永不相撞,守卫怎么改都绿——M2 变异存活实证空转）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0047c-'));
    // 预置与 callStepId 同名目录+残留——parentInstanceId 缺席,净室不得触发
    const residue = join(stateDir, '9.9', 'calls', 'keep');
    mkdirSync(residue, { recursive: true });
    writeFileSync(join(residue, 'state.json'), '{"keep":true}');
    const e = new ExecutionEngine();
    e.initExecution(CALLEE, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 'a' }, callStepId: '9.9' });   // 无 parentInstanceId
    expect(existsSync(join(residue, 'state.json'))).toBe(true);   // 三合取不满足,残留保留
  });

  it('正例：parallel worker 场景净室先读后清——父引擎落盘的 params.json 在清盘前被取走回填（review D1 端到端:修前 rmSync 先于 readChildParams,worker 参数被自己吞掉恒 null,0020 盘面通道打死——本例修前红修后绿即 D1 的重放验证）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0047d-'));
    // 父引擎备料:writeChildParams 落 params.json 到子实例目录(0020 契约的盘面通道)
    writeChildParams(stateDir, 'w1', { x: 'from-disk' }, 'parallel');
    // 顺手塞一个上一轮残留,验证净室照常清(G3:work_zone 残留直接断言)
    const residue = join(stateDir, 'parallel', 'w1', 'work_zone', 'stale.txt');
    mkdirSync(join(stateDir, 'parallel', 'w1', 'work_zone'), { recursive: true });
    writeFileSync(residue, 'old');
    const e = new ExecutionEngine();
    // worker 形态:三条件齐全+subtreeRoot(零 --params——参数只在盘上,先删后读的实现会 MISSING_INPUT 或 x 缺失)
    const r = e.initExecution(CALLEE, MINIMAL_HOST_CONFIG, {
      stateDir: join(stateDir, 'parallel'), parentInstanceId: 'parent-w', callStepId: 'w1', subtreeRoot: '1',
    }) as any;
    expect(r.status).toBe('ok');
    expect(e.getVars().variables?.['x']).toBe('from-disk');        // 备料先读到——先读后清
    expect(existsSync(residue)).toBe(false);                        // 残留照清(含 work_zone)
  });

  it('反例：顶层实例 init 不清目录（无 parentInstanceId——净室只限 call 子实例场景,顶层行为不变）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'r0047b-'));
    // 顶层实例目录预置一个文件,init 撞不上它（顶层每 run 随机 UUID 不复用目录）——
    // 这里验证的是:即便手工指定撞名场景也不触发清理路径(parentInstanceId 缺席)。
    // 用 initExecution 两次各自随机 id,预置残留放第一次的目录里,第二次 init 不碰它。
    const e1 = new ExecutionEngine();
    const r1 = e1.initExecution(CALLEE, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 'a' } }) as any;
    const marker = join(stateDir, r1.instance_id, 'calls', 'keep-me');
    mkdirSync(marker, { recursive: true });
    writeFileSync(join(marker, 'state.json'), '{"keep":true}');
    const e2 = new ExecutionEngine();
    e2.initExecution(CALLEE, MINIMAL_HOST_CONFIG, { stateDir, params: { x: 'b' } });
    expect(existsSync(join(marker, 'state.json'))).toBe(true);   // 顶层互不相干,残留(第一实例的)不被第二实例清
  });
});

// @v: anc-exec-line-single, anc-type-constraint-annotation —— line 非空归约束标注（B 案,
// 2026-09-02 作者拍"倾向于 step 约束里说明,否则这个概念是分裂的"——v1 恒拦〔0043〕被裁定
// 概念分裂:恒拦=类型级非空语义与 body/初值豁免并存。现行:line(nonempty) 标注槽才拦,
// 裸 line 空串恒合法。变异实证:撤 checkValue nonempty 判→标注钉红;撤 parser 归一→中文钉红）
describe('line 非空约束标注（B 案,^anc-type-constraint-annotation）', () => {
  const mk = (type: string) => `# T
Id: t
## Goal
g
## Steps
1. [reason] 步
  + → r: ${type}  # r
  > t
`;
  const run = (type: string, value: unknown) => {
    const engine = new ExecutionEngine();
    engine.initExecution(mk(type), MINIMAL_HOST_CONFIG);
    engine.nextStep();
    return engine.completeStep('1', { r: value });
  };

  it('正例（回归翻转,恒拦时代的反面）：裸 line 空串照常收为合法值——将来谁再恒拦即红', () => {
    const r = run('line', '');
    expect(r.status).toBe('ok');
  });

  it('正例：line(nonempty) 标注槽非空单行值照常过', () => {
    const r = run('line(nonempty)', '合规内容');
    expect(r.status).toBe('ok');
  });

  it('反例：line(nonempty) 标注槽空串 → SCHEMA_MISMATCH,报文教答不出走失败通道', () => {
    const r = run('line(nonempty)', '');
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.code).toBe('SCHEMA_MISMATCH');
      expect(r.message).toContain('非空约束');
      expect(r.message).toContain('失败通道');
    }
  });

  it('反例：line(nonempty) 标注槽全空白 → 同拦', () => {
    const r = run('line(nonempty)', '   \n  ');
    expect(r.status).toBe('error');
  });

  it('正例：中文标注 line(非空) parser 归一后同拦（双语等价,AST 英文规范形）', () => {
    const r = run('line(非空)', '');
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.code).toBe('SCHEMA_MISMATCH');
  });

  it('边界（新语义,与 v1 相反）：带 body 步声明 line(nonempty) 交空串同拦——标注是作者显式意图,body 不再是豁免判据', () => {
    const SPEC = `# T
Id: t
## Goal
g
## Steps
1. [act] 步
  + → r: line(nonempty)  # r
  > \`\`\`hop_python
  > r = ""
  > \`\`\`
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
    let r = engine.nextStep();
    for (let i = 0; i < 10 && r.status === 'step_ready'; i++) r = engine.nextStep();   // body 直执在后续拍,驱到终态
    expect(r.status).toBe('failed');   // 空串撞 nonempty→重试同因耗尽→实例 fail
  });

  it('正例：裸 line 的 body 空标记照旧合法（0050 实存形态零回退）', () => {
    const SPEC = `# T
Id: t
## Goal
g
## Steps
1. [act] 步
  + → r: line  # 空标记
  > \`\`\`hop_python
  > r = ""
  > \`\`\`
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    const r = engine.nextStep();
    expect(r.status).not.toBe('failed');
  });

  it('正例：text/markdown 空串照旧不拦（观望口径不变）', () => {
    expect(run('text', '').status).toBe('ok');
    expect(run('markdown', '').status).toBe('ok');
  });

  it('边界：line(nonempty) 多行值折叠归一同罩——折叠后非空单行照常过', () => {
    const r = run('line(nonempty)', '第一行\n第二行');
    expect(r.status).toBe('ok');
  });

  it('反例转正（review B-3,第七收取点）：头部 Types 节字段声明 line(非空) → 中文归一后空串同拦（修前静默零保护,0043 形态复刻）', () => {
    const SPEC = `# T
Id: t
## Goal
g
## Types
- Cand:
  - claim: line(非空)  # 主张
## Steps
1. [reason] 步
  + → c: Cand  # 候选
  > t
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
    engine.nextStep();
    const r = engine.completeStep('1', { c: { claim: '' } });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.code).toBe('SCHEMA_MISMATCH');
  });

  it('反例转正（review B-4,列表双语对称）：[line(非空)] 元素空串同拦（修前英文形暗通中文形暗哑）', () => {
    const r = run('[line(非空)]', ['甲', '']);
    expect(r.status).toBe('error');
    const r2 = run('[line(nonempty)]', ['甲', '']);
    expect(r2.status).toBe('error');
    const r3 = run('[line(非空)]', ['甲', '乙']);
    expect(r3.status).toBe('ok');
  });

  it('反例（review blank-2）：V4 拒含空格变体时报文指路正确形态', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(mk('line( 非空 )'), MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('error');
    if (init.status === 'error') {
      const msg = JSON.stringify((init as { errors?: unknown[] }).errors ?? []);
      expect(msg).toContain('正确写法');
    }
  });

  it('反例转正（review D-1）：列表元素位非法变体 [line( 非空 )] → V4 响亮拒且指路（修前三层静默失效——通配放行整串,指路正则对列表形是死代码）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(mk('[line( 非空 )]'), MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('error');
    if (init.status === 'error') {
      const msg = JSON.stringify((init as { errors?: unknown[] }).errors ?? []);
      expect(msg).toContain('正确写法');
    }
  });

  it('反例转正（review 疑点三,与 D-1 同根）：[number] 废词列表形 → V4 拒（修前端到端全静默）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(mk('[number]'), MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('error');
  });

  it('正例（D-1 不误伤面）：[line(nonempty)]/[line]/[yaml] 列表合法形照常过 V4', () => {
    for (const t of ['[line(nonempty)]', '[line]', '[yaml]']) {
      const engine = new ExecutionEngine();
      expect(engine.initExecution(mk(t), MINIMAL_HOST_CONFIG).status).toBe('ok');
    }
  });

  it('反例（review D-4）：V7 输入位非法变体报错带指路句（blank-2 同病同治）', () => {
    const SPEC = `# T
Id: t
## Goal
g
## Inputs
- q: line( 非空 )  # 输入
## Steps
1. [reason] 步
  - ← q
  + → r: text  # r
  > t
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('error');
    if (init.status === 'error') {
      const msg = JSON.stringify((init as { errors?: unknown[] }).errors ?? []);
      expect(msg).toContain('正确写法');
    }
  });

  // @v: anc-rule-v7 —— 0064 扩面钉（V7 头部三位:Outputs 节+Types 字段位;Inputs 原有钉在 validator.test）
  it('反例（todo/0064 位一）：头部 Outputs 节非法类型 → V7 报 error（历来零校验,- r: foo 曾静默入 AST）', () => {
    const SPEC = `# T
Id: t
## Goal
g
## Outputs
- r: foo  # 交付
## Steps
1. [reason] 步
  + → r: text  # r
  > t
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('error');
    if (init.status === 'error') {
      expect(JSON.stringify((init as { errors?: unknown[] }).errors ?? [])).toContain('Outputs 段变量');
    }
  });

  it('反例（todo/0064 位一,指路半边）：头部 Outputs line( 非空 ) 变体 → V7 拒且指路', () => {
    const SPEC = `# T
Id: t
## Goal
g
## Outputs
- r: line( 非空 )  # 交付
## Steps
1. [reason] 步
  + → r: text  # r
  > t
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('error');
    if (init.status === 'error') {
      expect(JSON.stringify((init as { errors?: unknown[] }).errors ?? [])).toContain('正确写法');
    }
  });

  it('反例（todo/0064 位二）：Types 节字段非法类型 → V7 报 error 点名 TypeDecl 名与字段名', () => {
    const SPEC = `# T
Id: t
## Goal
g
## Types
- Cand:
  - claim: foo  # 主张
## Steps
1. [reason] 步
  + → c: Cand  # c
  > t
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('error');
    if (init.status === 'error') {
      const msg = JSON.stringify((init as { errors?: unknown[] }).errors ?? []);
      expect(msg).toContain('Cand');
      expect(msg).toContain('claim');
    }
  });

  // @v: anc-rule-v7-header-types —— ④括号组容空格三位一致（2026-09-05 作者拍"validate 修",0069 两路语料独立撞）
  it('正例（enum 逗号空格,三类型位一致）：enum(high, low) 在 Types 字段位/Inputs/步骤输出全部合法,AST 归一为 enum(high,low)', () => {
    const SPEC = `# T
Id: t
## Goal
g
## Types
- Verdict:
  - level: enum(high, low)  # 级别
## Inputs
- op: enum(a, b)  # 操作
## Steps
1. [reason] 判
  - ← op
  + → v: Verdict  # 判定
  + → w: enum(x, y)  # 附判
2. [exit]
  + → none
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG, { params: { op: 'a' } });   // 必填 Inputs 闸要 params——本钉测的是类型文法不是缺参
    expect(init.status).toBe('ok');
    // AST 规范形核（serialize 往返稳定的根据）:Types 字段与 Inputs 声明都存剥空格形
    const spec = engine.getSpec();
    expect(spec?.header.types?.[0].fields['level']).toBe('enum(high,low)');
    expect(spec?.header.inputs?.find(i => i.name === 'op')?.type).toBe('enum(a,b)');
  });

  it('反例转正（todo/0064 截断修）：Types 字段 line( 非空 ) 不再截断入 AST——parse error 响亮拒且指路（修前 fields 存 line( 静默）', () => {
    const SPEC = `# T
Id: t
## Goal
g
## Types
- Cand:
  - claim: line( 非空 )  # 主张
## Steps
1. [reason] 步
  + → c: Cand  # c
  > t
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('error');
    if (init.status === 'error') {
      const msg = JSON.stringify((init as { errors?: unknown[] }).errors ?? []);
      expect(msg).toContain('不合类型文法');
      expect(msg).toContain('正确写法');
    }
  });

  it('正例（todo/0064 不误伤面,存量扫描实撞定式）：字段名含类型词前缀（line_ref: line）照常合法——余料起点用整段匹配结束位不许 indexOf 类型串', () => {
    const SPEC = `# T
Id: t
## Goal
g
## Types
- Cand:
  - line_ref: line  # 位置引用（字段名以 line 开头——indexOf 会先在字段名里命中类型串）
  - old_text: text  # 原文（同族形态:类型词是字段名后缀的截段）
## Steps
1. [reason] 步
  + → c: Cand  # c
  > t
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
  });

  it('反例：V4 拒 line(乱参)——只认 nonempty 不开约束语言口子', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(mk('line(maxlen=5)'), MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('error');
  });
});

// @v: anc-exec-tool-failure-report —— 工具故障自报通道（A 案,2026-09-01 作者拍板;同日补定
// reason 入承接面"reason也需要用tool,特别是web search",commit 议过撤回"commit必须通过body"。
// 承接面=reason+无 body act。单键 tool_failure→failStep(kind=tool_failure),与 lack_of_info
// 同位先于 schema 校验——自报形态天然缺声明槽,后判则出口永不可达。有 body 步走解释器
// TOOL_EXEC_ERROR 闭环/check·commit 不设。变异实证:早判块删除,正例转 SCHEMA_MISMATCH 红）
describe('工具故障自报通道（reason+无 body act,tool_failure）', () => {
  function readyStep1(engine: ExecutionEngine) {
    const r = engine.nextStep();
    if (r.status !== 'step_ready') throw new Error('expect step_ready, got ' + r.status);
  }
  const mkSpec = (stepType: string) => `# T
Id: t
## Goal
g
## Steps
1. [${stepType}] 步
  + → r: text  # r
  > t
`;

  it('正例：act 交单键 tool_failure → failStep 且失败原因携 tool_failure 语义', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(mkSpec('act'), MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { tool_failure: 'web_search 连续 3 次超时,无检索成果无法核查' });
    expect(r.status).not.toBe('error');   // 非 SCHEMA_MISMATCH 打回——先于 schema 校验
    expect(engine.getStepStates().get('1')).toBe('failed');
    // fail_kind 携语义进账（跨进程可读——run 终态 failure_reason 含通道标记）
    const end = engine.nextStep();
    if (end.status === 'failed') expect(end.failure_reason).toContain('tool_failure');
  });

  it('正例：reason 交 tool_failure → 同触发（作者补定"reason也需要用tool,特别是web search"——检索故障无法推理走本通道,与 lack_of_info〔材料本来就缺〕分工）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(mkSpec('reason'), MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { tool_failure: 'web_search 报错,无法取推理材料' });
    expect(r.status).not.toBe('error');
    expect(engine.getStepStates().get('1')).toBe('failed');
  });

  it('反例：check 交 tool_failure → 照走双槽 schema 校验（判不了的正形=如实 false/escalate,不设本通道）', () => {
    const spec = `# T
Id: t
## Goal
g
## Steps
1. [subtask] 组
  + → ok: bool
  1.1. [act] 干
    + → d: text
    > t
  1.2. [check] 验
    - ← d
    + → ok: bool
    + → why: text
    > 判
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.completeStep('1.1', { d: 'x' });
    engine.nextStep();
    const cr = engine.completeStep('1.2', { tool_failure: '假装工具挂' });
    expect(cr.status).toBe('error');
    expect(String(cr.message)).toContain('SCHEMA_MISMATCH');
  });

  it('反例：带 body 的 act 交 tool_failure → 照走 schema 校验（body 通道有 TOOL_EXEC_ERROR 闭环,不经 LLM 产出面）', () => {
    const spec = `# T
Id: t
## Goal
g
## Steps
1. [act] 步
  + → r: text  # r
  > \`\`\`hop_python
  > r = strip("x")
  > \`\`\`
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { tool_failure: '假装工具挂了' });
    expect(r.status).toBe('error');
    expect(String(r.message)).toContain('SCHEMA_MISMATCH');
  });

  it('正例：act 正常产出零误触（不含 tool_failure 键照常入账）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(mkSpec('act'), MINIMAL_HOST_CONFIG);
    readyStep1(engine);
    const r = engine.completeStep('1', { r: '正常产出' });
    expect(r.status).toBe('ok');
    expect(engine.getStepStates().get('1')).toBe('done');
  });
});

// @v: anc-exec-durable-resume
describe('splitInstanceDir win32 仿真（hopissues 0058——load 恢复取 instanceId 平台化）', () => {
  it('win32 绝对路径取裸 id 与父目录（修前 split(\'/\') 拿整条路径当 id）', () => {
    const r = splitInstanceDir('E:\\00git\\proj\\.hopstate\\abc-123', pathWin32);
    expect(r.id).toBe('abc-123');
    expect(r.parent).toBe('E:\\00git\\proj\\.hopstate');
  });
  it('posix 路径行为不变（回归面）', () => {
    const r = splitInstanceDir('/Users/x/proj/.hopstate/abc-123', pathPosix);
    expect(r.id).toBe('abc-123');
    expect(r.parent).toBe('/Users/x/proj/.hopstate');
  });
});

// ^anc-exec-parallel-reap-chain 续链收割（2026-09-04 D80 探针转正——决策档案
// todo/decision/20260904-parallel收割须兑现声明产出链.md;三坑三断言:收集清单齐/失败走兜底/编号互异）
// 设计三子条款覆盖情况（0086 语义审计核对）：①编号沿 loop 祖先取迭代号——坑③钉直测（两轮派发
// 子实例 ID 互异 1.1.1.1/1.1.1.2）;②壳作用域写值（隔壳收割值写壳作用域经边界提升）——坑①钉经
// 端到端产出断言间接覆盖（paths 两元素齐=写值+提升全链通,无壳作用域中间态直接断言）;③待喂账按
// 收集对兑付——"双收集对+串行兄弟混排"钉直测（不分对则翻倍/幻影 null,断言两清单各自干净）。
// @v: anc-exec-parallel-reap-chain
describe('parallel 续链收割（loop>壳>call parallel 隔层形态）', () => {
  const CHAIN_SPEC = `# T
Id: t
## Goal
probe
## Inputs
- items: [line]  # in
## Outputs
- paths: [line]  # out
## Steps
1. [loop for-each x in items, collect p into paths] 循环
  + → paths: [line]  # collected
  1.1. [subtask retry=0] 壳
    + → p: line  # unit
    1.1.1. [call callee(x) parallel] 派发
      + → p: result  # map
    1.1.2. [on fail] 兜底
      1.1.2.1. [act] 兜底产出
        + → p: line  # fallback
        > \`\`\`hop_python
        > p = "FALLBACK"
        > \`\`\`
2. [exit]
`;
  const HOST = {
    workspace_dir: '/tmp/claude',
    sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
    api_key: 'test-key',
  } as unknown as Parameters<ExecutionEngine['initExecution']>[1];

  function drive(reapOutcomes: ({ vars?: Record<string, unknown>; failure?: { specId: string; childInstanceId: string; stepFailReasons: Record<string, { reason: string; fail_kind: 'error' }>; stepStates: Record<string, string> } })[]) {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CHAIN_SPEC, HOST, { params: { items: ['a', 'b'] } });
    expect(init.status).toBe('ok');
    engine.setUnifiedDispatch(true);
    const dispatched: string[] = [];
    let guard = 0;
    let terminal: ReturnType<ExecutionEngine['nextStep']> | null = null;
    while (guard++ < 40) {
      const r = engine.nextStep();
      if (r.status === 'dispatch_ready') {
        dispatched.push(r.child_instance!);
        engine.reapParallelCall(r.child_instance!, reapOutcomes.shift() as never);
        continue;
      }
      if (r.status === 'step_ready') { engine.completeStep(r.step_id, { p: 'FALLBACK' }); continue; }
      terminal = r; break;
    }
    return { engine, dispatched, terminal };
  }

  it('正例（坑①收集清单）：隔壳形态全成功 → 两子实例产物按序进收集清单（修前:壳无 collect 值静默蒸发,paths=[] 账面 completed）', () => {
    const { dispatched, terminal } = drive([{ vars: { result: 'PATH-A' } }, { vars: { result: 'PATH-B' } }]);
    expect(terminal?.status).toBe('completed');
    if (terminal?.status === 'completed') expect(terminal.outputs?.['paths']).toEqual(['PATH-A', 'PATH-B']);
  });

  it('正例（坑②兜底死代码复活）：首子失败 → 投递回壳,on fail 兜底真实执行,兜底产物照常进清单（修前:失败只留痕,兜底永不触发,元素静默缺席）', () => {
    const { terminal } = drive([
      { failure: { specId: 'callee', childInstanceId: 'x', stepFailReasons: { '1': { reason: 'boom', fail_kind: 'error' } }, stepStates: { '1': 'failed' } } },
      { vars: { result: 'PATH-B' } },
    ]);
    expect(terminal?.status).toBe('completed');
    if (terminal?.status === 'completed') expect(terminal.outputs?.['paths']).toEqual(['FALLBACK', 'PATH-B']);
  });

  it('正例（坑③编号互异）：两轮迭代派发的子实例编号带各自迭代号（修前:迭代号从壳取恒 1,两轮同 ID 目录互覆幂等短路）', () => {
    const { dispatched } = drive([{ vars: { result: 'PATH-A' } }, { vars: { result: 'PATH-B' } }]);
    expect(dispatched.length).toBe(2);
    expect(new Set(dispatched).size).toBe(2);   // 互异
    expect(dispatched).toEqual(['1.1.1.1', '1.1.1.2']);   // 迭代号来自 loop 计数器
  });

  it('正例（复阅实抓双重喂送后修）：双收集对+壳内并行步与串行兄弟混排 → 两清单各自干净（修前:待喂账不分对,串行兄弟产物被收两遍翻倍、已直喂对再喂穿透读 root 幻影 null 入列）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(`# T2
Id: t2
## Goal
probe
## Inputs
- items: [line]  # in
## Outputs
- paths: [line]  # out
- marks: [line]  # out2
## Steps
1. [loop for-each x in items, collect p into paths, collect m into marks] 循环
  + → paths: [line]  # c1
  + → marks: [line]  # c2
  1.1. [subtask retry=0] 壳
    + → p: line  # unit
    + → m: line  # unit2
    1.1.1. [call callee(x) parallel] 派发
      + → p: result  # map
    1.1.2. [act] 串行兄弟产 m
      + → m: line  # mark
      > \`\`\`hop_python
      > m = "MARK"
      > \`\`\`
2. [exit]
`, {
      workspace_dir: '/tmp/claude',
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'test-key',
    } as unknown as Parameters<ExecutionEngine['initExecution']>[1], { params: { items: ['a', 'b'] } });
    expect(init.status).toBe('ok');
    engine.setUnifiedDispatch(true);
    let n = 0;
    let guard = 0;
    let terminal: ReturnType<ExecutionEngine['nextStep']> | null = null;
    while (guard++ < 40) {
      const r = engine.nextStep();
      if (r.status === 'dispatch_ready') { engine.reapParallelCall(r.child_instance!, { vars: { result: `P-${++n}` } } as never); continue; }
      if (r.status === 'step_ready') { engine.completeStep(r.step_id, { m: `M-${n}` }); continue; }
      terminal = r; break;
    }
    expect(terminal?.status).toBe('completed');
    if (terminal?.status === 'completed') {
      expect(terminal.outputs?.['paths']).toEqual(['P-1', 'P-2']);   // 不翻倍无幻影 null
      expect(terminal.outputs?.['marks']).toEqual(['M-1', 'M-2']);   // 串行兄弟对归传送带,恰一遍
    }
  });

  it('正例（D1 晚收割——阅卷实抓恒丢末元素后修）：主线先走完全部派发再收割 → 收集清单仍两元素齐（修前:末收割的传播级联触发 loop finalize,后喂元素成孤儿恒丢）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(`# T
Id: t
## Goal
probe
## Inputs
- items: [line]  # in
## Outputs
- paths: [line]  # out
## Steps
1. [loop for-each x in items, collect p into paths] 循环
  + → paths: [line]  # collected
  1.1. [subtask retry=0] 壳
    + → p: line  # unit
    1.1.1. [call callee(x) parallel] 派发
      + → p: result  # map
    1.1.2. [on fail] 兜底
      1.1.2.1. [act] 兜底产出
        + → p: line  # fallback
        > \`\`\`hop_python
        > p = "FALLBACK"
        > \`\`\`
2. [exit]
`, {
      workspace_dir: '/tmp/claude',
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'test-key',
    } as unknown as Parameters<ExecutionEngine['initExecution']>[1], { params: { items: ['a', 'b'] } });
    expect(init.status).toBe('ok');
    engine.setUnifiedDispatch(true);
    // 晚收割交错形态（阅卷 probe-late2 实撞时序——壳=收齐点,派发后主线 drain_wait 等收割,
    // 收割后壳完结 loop 才轮进;末迭代收割的传播级联触发 loop finalize,修前后喂元素成孤儿恒丢）:
    // 派发1→drain_wait→收割1→派发2→drain_wait→收割2(末)→completed
    const r1 = engine.nextStep();
    expect(r1.status).toBe('dispatch_ready');
    const c1 = (r1 as { child_instance?: string }).child_instance!;
    expect(engine.nextStep().status).toBe('drain_wait');   // 主线等收割,不立即收
    engine.reapParallelCall(c1, { vars: { result: 'PATH-A' } } as never);
    const r2 = engine.nextStep();
    expect(r2.status).toBe('dispatch_ready');
    const c2 = (r2 as { child_instance?: string }).child_instance!;
    expect(engine.nextStep().status).toBe('drain_wait');
    engine.reapParallelCall(c2, { vars: { result: 'PATH-B' } } as never);   // 末收割——修前此元素恒丢
    const r = engine.nextStep();
    expect(r.status).toBe('completed');
    if (r.status === 'completed') expect(r.outputs?.['paths']).toEqual(['PATH-A', 'PATH-B']);
  });

});

// hopissues/0073——同容器内首次执行的无关步骤 prompt 恒带 stale 打回工单（受众错位:
// step 1.1 重试成功,1.6/1.8 等首跑步全吃"此前已被打回过的意见"）。
// 修=getActiveRetryFeedback 注入侧受众收窄:重跑参与者(start≥2/自有失败史/升层史)才注入,
// 纯首跑返 undefined;retryHistory 账恒不删（"容器成功清账"废案经 D39 跨层反馈钉否决——
// 外层意见轮重跑需要内层旧机械史作"别再犯清单"）。// @v: anc-exec-l2c-retry-feedback
describe('重试反馈受众收窄(0073)', () => {
  const HOST_MIN2 = {
    workspace_dir: '/tmp/test',
    sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
    api_key: 'test-key',
  } as HostConfig;
  const SPEC73 = `# RH
## Goal
G
## Steps
1. [subtask retry=2] 事务
  + → b: text
  1.1. [check] 首轮判负触发重试
    + → a_ok: bool
    + → a_note: text
    > judge
  1.2. [reason] 同容器内与失败步无关的首跑步骤
    + → b: text
    > later
`;
  it('正例：同容器内首跑步骤不吃 stale 工单,重跑步照常吃（卡 probe 场景——修前 1.2 带 CHECK_FAILED 旧账）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC73, HOST_MIN2);
    let r: any = engine.nextStep();
    expect(r.step_id).toBe('1.1');
    // 首轮判负 → 容器带反馈重试(children 重置 pending)
    engine.completeStep('1.1', { a_ok: false, a_note: '前判失败原因A' });
    r = engine.nextStep();
    expect(r.step_id).toBe('1.1');   // 重跑轮
    // 重跑步照常吃反馈（它有失败轮的执行史——修法只拦首跑,不许误伤重跑供给）
    const fbRetry = engine.getActiveRetryFeedback('1.1');
    expect(fbRetry?.reason).toContain('前判失败原因A');
    // 次轮判正 → 1.2 首跑（容器仍 running——这正是卡 probe 场景）
    engine.completeStep('1.1', { a_ok: true, a_note: '' });
    r = engine.nextStep();
    expect(r.step_id).toBe('1.2');
    // 修复标的:从未执行过的 1.2 反馈通道必须干净（修前吃到 1.1 的打回工单）
    expect(engine.getActiveRetryFeedback('1.2')).toBeUndefined();
  });
  it('反例(裁定记录)：容器成功 done 后其 retryHistory 保留——D39 跨层反馈依赖它（"成功清账"废案经 D39 跨层钉否决;卡病由受众判据独治不删账。首跑不吃断言的步骤挂在容器内使祖先链非空——review 面三抓初版用顶层步 2,祖先链 while 对无点号 id 零迭代恒返 undefined,断言结构性空转什么都核不到）', () => {
    const SPEC_C = `# RHC
## Goal
G
## Steps
1. [subtask retry=2] 事务
  + → a_ok: bool
  1.1. [check] 首轮判负次轮判正
    + → a_ok: bool
    + → a_note: text
    > judge
2. [subtask] 后段容器
  + → z: text
  2.1. [reason] 容器内后续首跑步骤
    + → z: text
    > later
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_C, HOST_MIN2);
    engine.nextStep();
    engine.completeStep('1.1', { a_ok: false, a_note: '旧工单' });   // 首败记账
    engine.nextStep();
    engine.completeStep('1.1', { a_ok: true, a_note: '' });          // 次轮过,容器 1 done
    engine.nextStep();
    // 账保留(外层重试语境的"别再犯清单")
    expect(engine.exportFailState().retryHistory?.['1']).toBeTruthy();
    // 首跑步骤 2.1 有祖先链(容器 2)但三判据全无——受众闸真实拦截(非结构性空转)
    expect(engine.getActiveRetryFeedback('2.1')).toBeUndefined();
  });

  it('正例(定向)：本步自己首轮失败后当轮重跑,start=1 但有失败史→反馈在场（stepFailReasons 半支——review 面三变异实证此前只靠 prompt 钉偶然罩）', () => {
    const SPEC_F2 = `# RHF2
## Goal
G
## Steps
1. [subtask retry=2] 事务
  + → a_ok: bool
  1.1. [check] 判
    + → a_ok: bool
    + → a_note: text
    > judge
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_F2, HOST_MIN2);
    engine.nextStep();
    engine.completeStep('1.1', { a_ok: false, a_note: '本步自己的失败' });
    // 重跑轮 nextStep 之前查:此刻 1.1 的 start 事件=1(重跑轮 start 未记),但 stepFailReasons 有它
    // ——三判据的第二支必须放行,否则"首轮失败当轮重跑吃不到反馈"
    const fb = engine.getActiveRetryFeedback('1.1');
    expect(fb?.reason).toContain('本步自己的失败');
  });

  it('反例：容器 failed 上浮时 retryHistory 不清（失败史是 caller 诊断料,exportFailState 消费）', () => {
    const SPEC_F = `# RHF
## Goal
G
## Steps
1. [subtask retry=1] 重试一轮仍败
  + → a_ok: bool
  1.1. [check] 恒负
    + → a_ok: bool
    + → a_note: text
    > judge
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_F, HOST_MIN2);
    engine.nextStep();
    engine.completeStep('1.1', { a_ok: false, a_note: '致命缺口' });   // 首败:记账+带反馈重跑
    engine.nextStep();
    engine.completeStep('1.1', { a_ok: false, a_note: '致命缺口又来' });   // 次败:耗尽上浮 failed
    // failed 容器的失败史仍在账(exportFailState 读得到——不许被成功清账逻辑波及)
    const st = engine.exportFailState();
    expect(JSON.stringify(st.retryHistory ?? {})).toContain('致命缺口');
  });
});

// todo/0107——loop 新一轮=新迭代全新事务,前几轮的重试反馈不属于本轮。实撞:意见轮 loop 第 1~3 轮
// 分诊容器留下的重试记录与跨轮累计的开始事件,让第 4~8 轮的分诊步吃到旧"机械失败"反馈与上轮旧意见
// 基准,照抄回去形成 revise 死循环。修=记录打位置戳、只取容器本轮起点（祖先 loop 最晚一条轮进事件）之后的
// 记录 + 受众闸只数起点之后的事件;记录本身不删。循环入口不划界线——外层容器重试重建时旧意见照旧可见;
// 同批次的配套:烧尽原因带最后一次失败原文、prompt 剥记账外壳、输入被容器外重做时不给基准（K~P 例）。
// @v: anc-exec-l2c-retry-feedback
// @v: anc-exec-retry-feedback-iter-scope
describe('重试反馈按轮生效(0107)', () => {
  const SPEC107 = `# RI
## Goal
G
## Steps
1. [loop max=3] 意见轮
  1.1. [subtask retry=2] 分诊事务
    + → b: text
    1.1.1. [check] 分诊判
      + → a_ok: bool
      + → a_note: text
      > judge
    1.1.2. [reason] 后排步骤
      + → b: text
      > later
`;
  // 第 1 轮:1.1.1 先判负(原因A)触发容器重试,重跑判正,1.1.2 收尾 → loop 进第 2 轮
  function runRound1(engine: ExecutionEngine) {
    let r: any = engine.nextStep();
    expect(r.step_id).toBe('1.1.1');
    engine.completeStep('1.1.1', { a_ok: false, a_note: '第一轮原因A' });
    r = engine.nextStep();
    expect(r.step_id).toBe('1.1.1');
    expect(engine.getActiveRetryFeedback('1.1.1')?.reason).toContain('第一轮原因A');   // 同轮重跑照常吃
    engine.completeStep('1.1.1', { a_ok: true, a_note: '' });
    r = engine.nextStep();
    expect(r.step_id).toBe('1.1.2');
    engine.completeStep('1.1.2', { b: 'x1' });
  }

  it('正例A(0107 原形态)：上一轮留下的重试记录不注入下一轮——第 2 轮两个子步反馈通道都干净', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC107, MINIMAL_HOST_CONFIG);
    runRound1(engine);
    const r: any = engine.nextStep();
    expect(r.step_id).toBe('1.1.1');
    // 修前:1.1.1 跨轮累计开始事件 3 次过受众闸,又拿到第 1 轮记录 → 注入"第一轮原因A"
    expect(engine.getActiveRetryFeedback('1.1.1')).toBeUndefined();
    engine.completeStep('1.1.1', { a_ok: true, a_note: '' });
    expect((engine.nextStep() as any).step_id).toBe('1.1.2');
    expect(engine.getActiveRetryFeedback('1.1.2')).toBeUndefined();
    // 账不删:第 1 轮记录仍在,只是不注入
    expect(engine.exportFailState().retryHistory?.['1.1']?.[0]?.failure_reason).toContain('第一轮原因A');
  });

  it('正例B(同轮照注入)：第 2 轮容器再失败,重跑步只吃本轮原因,prior 里没有第 1 轮旧原因', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC107, MINIMAL_HOST_CONFIG);
    runRound1(engine);
    engine.nextStep();
    engine.completeStep('1.1.1', { a_ok: false, a_note: '第二轮原因B' });
    expect((engine.nextStep() as any).step_id).toBe('1.1.1');
    const fb = engine.getActiveRetryFeedback('1.1.1');
    expect(fb?.reason).toContain('第二轮原因B');
    expect(JSON.stringify(fb?.prior ?? [])).not.toContain('第一轮原因A');
  });

  it('正例C(受众闸只数本轮)：第 2 轮容器重试后,本轮首次执行的后排步骤(第 1 轮执行过)不带反馈', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC107, MINIMAL_HOST_CONFIG);
    runRound1(engine);
    engine.nextStep();
    engine.completeStep('1.1.1', { a_ok: false, a_note: '第二轮原因B' });
    engine.nextStep();
    engine.completeStep('1.1.1', { a_ok: true, a_note: '' });
    expect((engine.nextStep() as any).step_id).toBe('1.1.2');
    // 修前:1.1.2 跨轮累计开始事件 2 次被当成重跑参与者,吃到本轮 1.1.1 的打回原因
    expect(engine.getActiveRetryFeedback('1.1.2')).toBeUndefined();
  });

  it('正例D：loop_iter 事件在 loop 进入与每次轮进各记一条,detail 是新轮次号', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC107, MINIMAL_HOST_CONFIG);
    runRound1(engine);
    engine.nextStep();
    const iters = engine.getExecEvents().filter(e => e.event === 'loop_iter');
    expect(iters.map(e => [e.step_id, e.detail])).toEqual([['1', '1'], ['1', '2']]);
    // 第 1 轮记录带位置戳,位置在第 2 轮轮进事件之前
    const seq = engine.exportFailState().retryHistory?.['1.1']?.[0]?.event_seq;
    expect(typeof seq).toBe('number');
    const advanceIdx = engine.getExecEvents().findIndex(e => e.event === 'loop_iter' && e.detail === '2');
    expect(seq!).toBeLessThanOrEqual(advanceIdx);
  });

  it('反例(无祖先 loop 不受影响)：容器不在任何 loop 里时事件流无轮次起点,记录照常打位置戳,按原判据照旧注入', () => {
    const SPEC_NL = `# RN
## Goal
G
## Steps
1. [subtask retry=2] 事务
  + → a_ok: bool
  1.1. [check] 判
    + → a_ok: bool
    + → a_note: text
    > judge
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_NL, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.completeStep('1.1', { a_ok: false, a_note: '无循环原因' });
    engine.nextStep();
    const rec = engine.exportFailState().retryHistory?.['1']?.[0];
    expect(typeof rec?.event_seq).toBe('number');
    expect(engine.getExecEvents().some(e => e.event === 'loop_iter')).toBe(false);
    expect(engine.getActiveRetryFeedback('1.1')?.reason).toContain('无循环原因');
  });

  it('正例E(起点按容器的祖先 loop 取)：容器内嵌 loop,容器重试后内层 loop 重新进入记了新起点,重跑步照吃反馈', () => {
    // 若按步骤自身最内层 loop 取起点,重试后内层 loop 的 loop_iter 落在重跑步开始事件之前,
    // 窗口里重跑步只开始 1 次且失败事件在窗口外 → 被误判为首跑,漏掉该吃的反馈
    const SPEC_E = `# RE
## Goal
G
## Steps
1. [subtask retry=2] 事务
  + → a_ok: bool
  1.1. [loop max=2] 内层循环
    1.1.1. [check] 判
      + → a_ok: bool
      + → a_note: text
      > judge
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_E, MINIMAL_HOST_CONFIG);
    expect((engine.nextStep() as any).step_id).toBe('1.1.1');
    engine.completeStep('1.1.1', { a_ok: false, a_note: '内层原因' });
    expect((engine.nextStep() as any).step_id).toBe('1.1.1');
    // 前提:容器重试后内层 loop 确实重新进入、记了第二条入口事件
    expect(engine.getExecEvents().filter(e => e.event === 'loop_iter' && e.step_id === '1.1').length).toBe(2);
    expect(engine.getActiveRetryFeedback('1.1.1')?.reason).toContain('内层原因');
  });

  it('正例F(缺戳按本轮)：旧状态文件里没有位置戳的记录照旧注入——引擎升级后恢复的在飞实例行为不变', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC107, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.completeStep('1.1.1', { a_ok: false, a_note: '旧格式原因' });
    expect((engine.nextStep() as any).step_id).toBe('1.1.1');
    // 模拟旧状态文件:抹掉记录上的位置戳
    const rh = (engine as unknown as { retryHistory: Map<string, { event_seq?: number }[]> }).retryHistory;
    for (const r of rh.get('1.1') ?? []) delete r.event_seq;
    expect(engine.getActiveRetryFeedback('1.1.1')?.reason).toContain('旧格式原因');
  });

  it('正例G(升层指引回注记录带位置戳)：loop 第 2 轮里升层问路,指引记录打戳且靠本轮升层事件过闸', () => {
    const SPEC_G = `# RG
Id: rg-t
## Goal
g
## Inputs
- x: int  # 入
## Outputs
- r: text  # 出
## Steps
1. [loop max=2] 意见轮
  1.1. [subtask retry=2] 探索
    + → r: text  # 出
    1.1.1. [check escalatable] 收敛判定
      - ← x
      + → ok: bool  # 判定槽
      + → gap: yaml  # 缺口槽
      > 判收敛
    1.1.2. [act] 出结果
      + → r: text  # 出
      > \`\`\`hop_python
      > r = "done"
      > \`\`\`
`;
    const HOST_G = {
      workspace_dir: '/tmp/test',
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'x',
    } as HostConfig;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_G, HOST_G, { stateDir: mkdtempSync(join(tmpdir(), 'rg-')), params: { x: 1 } });
    // 第 1 轮正常走完,进第 2 轮——升层发生在有轮进界线的本轮窗口里(第 1 轮没有界线,走的是 0073 原判据)
    let r = engine.nextStep() as any;
    expect(r.step_id).toBe('1.1.1');
    engine.completeStep('1.1.1', { ok: true, gap: {} });
    r = engine.nextStep() as any;
    for (let k = 0; k < 5 && r.step_id !== '1.1.1'; k++) { if (r.step_id) engine.completeStep(r.step_id, { r: 'done' }); r = engine.nextStep() as any; }
    expect(r.step_id).toBe('1.1.1');
    expect(engine.getExecEvents().filter(e => e.event === 'loop_iter').map(e => e.detail)).toContain('2');
    const resp = engine.completeStep('1.1.1', { ok: false, gap: { escalate: true, need: '要方向' } });
    expect((resp as { pause_reason?: string }).pause_reason).toBe('escalate');
    expect(engine.resumeFromEscalation('1.1.1', '按方案B').status).toBe('ok');
    const rec = engine.exportFailState().retryHistory?.['1.1']?.[0];
    expect(rec?.failure_reason).toContain('升层指引');
    expect(typeof rec?.event_seq).toBe('number');
    // 本轮窗口里的升层判据:此刻 1.1.1 本轮只开始过 1 次、没有失败事件,只有本轮的升层事件让它过闸
    expect(engine.getActiveRetryFeedback('1.1.1')?.reason).toContain('按方案B');
  });

  it('正例H(loop 内失败判据)：第 2 轮本步判负后、重跑轮开始之前取反馈——本轮只开始过 1 次,靠本轮失败事件过闸', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC107, MINIMAL_HOST_CONFIG);
    runRound1(engine);
    expect((engine.nextStep() as any).step_id).toBe('1.1.1');
    engine.completeStep('1.1.1', { a_ok: false, a_note: '第二轮原因B' });
    const fb = engine.getActiveRetryFeedback('1.1.1');
    expect(fb?.reason).toContain('第二轮原因B');
    expect(JSON.stringify(fb?.prior ?? [])).not.toContain('第一轮原因A');
  });

  // 整树重建场景（仿 hopbuild2 步骤 5,与实验记录 hop_tasks/0107迭代边界重试反馈泄漏/实验-重建轮旧工单去留.md 同一场景）:
  // 意见轮事务(外层重试容器) > 终检修错循环 > 修检事务(机械体检→定向修错→合理关)。
  // 修检两次被合理关打回烧尽 → 外层事务整体重试、草稿整份重建 → 重建后走到定向修错步。
  describe('外层容器重试重建：保留旧意见、清掉过期材料', () => {
    const SPEC_RB = `# RB
## Goal
G
## Steps
1. [loop max=3] 意见轮循环
  1.1. [subtask retry=3] 意见轮事务
    + → spec_text: text  # 草稿全文
    1.1.1. [reason] 构建草稿
      + → spec_text: text  # 草稿全文
      > build
    1.1.2. [loop max=2] 终检修错循环
      1.1.2.1. [subtask retry=1] 修检事务
        + → spec_text: text  # 终稿全文
        1.1.2.1.1. [act] 机械体检
          - ← spec_text
          + → health_report: text  # 体检单
          > lint
        1.1.2.1.2. [reason] 定向修错
          - ← spec_text, health_report
          + → spec_text: text  # 修后草稿全文
          + → fix_note: line  # 修错记录
          > fix
        1.1.2.1.3. [check] 整体合理关
          - ← spec_text
          + → ok: bool  # 判定
          + → note: text  # 问题清单
          > judge
      1.1.2.2. [break]
    1.1.3. [reason] 意见分诊
      - ← spec_text
      + → verdict: line  # 分诊结论
      > triage
`;
    const OP1 = '合理关问题:第3步是发送动作,应改为 [commit]';
    const OP2 = '合理关问题:第3步仍标 [act],必须改为 [commit]';
    function toRebuild(engine: ExecutionEngine) {
      const go = (id: string, out: Record<string, unknown>) => {
        const r: any = engine.nextStep();
        expect(r.step_id).toBe(id);
        engine.completeStep(id, out);
      };
      go('1.1.1', { spec_text: 'V1' });
      go('1.1.2.1.1', { health_report: 'ok' });
      go('1.1.2.1.2', { spec_text: 'V1', fix_note: '无错未动' });
      go('1.1.2.1.3', { ok: false, note: OP1 });
      go('1.1.2.1.1', { health_report: 'ok' });
      const r: any = engine.nextStep();
      expect(r.step_id).toBe('1.1.2.1.2');
      const within = r.context;   // 同一修检事务内的重跑:体检步在容器内重做,基准照给
      engine.completeStep('1.1.2.1.2', { spec_text: 'V1B', fix_note: '修了 1 处:第3步加人工确认' });
      go('1.1.2.1.3', { ok: false, note: OP2 });   // 修检第二次打回 → 烧尽上浮 → 意见轮事务整体重试
      go('1.1.1', { spec_text: 'V2' });            // 整树重建
      go('1.1.2.1.1', { health_report: 'ok' });
      const after: any = engine.nextStep();
      expect(after.step_id).toBe('1.1.2.1.2');
      return { within, after: after.context };
    }

    it('正例K：重建后定向修错步照旧看到重建前两条打回意见,每条一行,没有容器记账外壳', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SPEC_RB, MINIMAL_HOST_CONFIG);
      const { after } = toRebuild(engine);
      // 前提:重建确实让内层 loop 重新进入(第二条入口事件),而入口不划界线
      expect(engine.getExecEvents().filter(e => e.event === 'loop_iter' && e.step_id === '1.1.2').map(e => e.detail)).toEqual(['1', '1']);
      const out = formatPromptText(after, 'reason');
      expect(out).toContain(`此前已被打回过的意见（都要保持落实，不许改好又改回去）：\n    - ${OP1}\n    - ${OP2}`);
      expect(out).not.toContain('外围容器');
      expect(out).not.toContain('retry exhausted');
      expect(out).not.toContain('机械步骤处理失败');   // 烧尽原因不走形态指引
    });

    it('正例L(基准看输入有没有被外面重做)：重建后不给上一轮产出基准;同一修检事务内的重跑照给', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SPEC_RB, MINIMAL_HOST_CONFIG);
      const { within, after } = toRebuild(engine);
      expect(within.retry_context?.prior_outputs?.map((p: any) => p.name)).toEqual(['spec_text', 'fix_note']);
      expect(after.retry_context?.prior_outputs).toBeUndefined();
      expect(formatPromptText(after, 'reason')).not.toContain('- 上一轮产出.');
    });

    it('正例M(烧尽原因带最后一次失败原文)：外层记账与上浮原因里有内层最后一次打回的原文', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SPEC_RB, MINIMAL_HOST_CONFIG);
      toRebuild(engine);
      const outer = engine.exportFailState().retryHistory?.['1.1'] ?? [];
      expect(outer[outer.length - 1]?.failure_reason).toBe(`subtask '1.1.2.1' retry exhausted（最后一次失败：CHECK_FAILED: ${OP2}）`);
    });
  });

  it('反例N(过期的内层轮进不当界线)：外层轮进后,内层 loop 在外层上一轮的轮进不能把外层上一轮的记录放进来', () => {
    // 内层 loop 在外层第 1 轮里轮进到第 2 轮,内层事务在那一轮失败重试过;外层进第 2 轮后内层只记入口事件,
    // 内层最后一条轮进事件停在外层上一轮——只看最内层 loop 取界线会把那条旧记录当本轮注入
    const SPEC_N = `# RN2
## Goal
G
## Steps
1. [loop max=2] 外层
  1.1. [loop max=2] 内层
    1.1.1. [subtask retry=2] 内事务
      + → a_ok: bool
      1.1.1.1. [check] 判
        + → a_ok: bool
        + → a_note: text
        > judge
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_N, MINIMAL_HOST_CONFIG);
    const go = (out: Record<string, unknown>) => {
      const r: any = engine.nextStep();
      expect(r.step_id).toBe('1.1.1.1');
      engine.completeStep('1.1.1.1', out);
    };
    go({ a_ok: true, a_note: '' });                 // 外 1 内 1
    go({ a_ok: false, a_note: '外一内二的原因' });   // 外 1 内 2 失败
    go({ a_ok: true, a_note: '' });                 // 外 1 内 2 重跑过
    expect((engine.nextStep() as any).step_id).toBe('1.1.1.1');   // 外 2 内 1
    expect(engine.getExecEvents().filter(e => e.event === 'loop_iter').map(e => [e.step_id, e.detail]))
      .toEqual([['1', '1'], ['1.1', '1'], ['1.1', '2'], ['1', '2'], ['1.1', '1']]);
    expect(engine.getActiveRetryFeedback('1.1.1.1')).toBeUndefined();
  });

  it('正例O(档次判定只看烧尽那句)：内层带上来的原文含 CONTEXT_OVERFLOW,外层仍按普通失败重试,不当事务级确定性失败直接放弃', () => {
    const SPEC_O = `# RO
## Goal
G
## Steps
1. [subtask retry=2] 外
  + → a: text
  1.1. [subtask retry=1] 内
    + → a: text
    1.1.1. [reason] 产
      + → a: text
      > make
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_O, MINIMAL_HOST_CONFIG);
    expect((engine.nextStep() as any).step_id).toBe('1.1.1');
    engine.failStep('1.1.1', 'CONTEXT_OVERFLOW: 材料超窗');   // 内层:事务级确定性 → 直接烧尽上浮
    const r: any = engine.nextStep();
    expect(r.status).toBe('step_ready');   // 外层按普通失败扣预算重试
    expect(r.step_id).toBe('1.1.1');
    expect(engine.exportFailState().retryHistory?.['1']?.[0]?.failure_reason)
      .toBe(`subtask '1.1' retry exhausted（最后一次失败：CONTEXT_OVERFLOW: 材料超窗）`);
  });

  it('正例P(非判定打回的烧尽如实说)：内层最后一次是执行错误 → 说"内层重试用完、整段从头重做",不给形态指引', () => {
    const SPEC_P = `# RP
## Goal
G
## Steps
1. [subtask retry=2] 外
  + → a: text
  1.1. [subtask retry=1] 内
    + → a: text
    1.1.1. [reason] 产
      + → a: text
      > make
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_P, MINIMAL_HOST_CONFIG);
    engine.nextStep();
    engine.failStep('1.1.1', 'EXEC_ERROR: 第一次坏');
    expect((engine.nextStep() as any).step_id).toBe('1.1.1');
    engine.failStep('1.1.1', 'EXEC_ERROR: 第二次坏');   // 内层烧尽 → 外层重试
    const r: any = engine.nextStep();
    expect(r.step_id).toBe('1.1.1');
    const out = formatPromptText(r.context, 'reason');
    expect(out).toContain('上一轮这一段没做成：内层步骤 1.1 重试次数用完仍没通过（最后一次失败：EXEC_ERROR: 第二次坏），整段已从头重做。');
    expect(out).not.toContain('机械步骤处理失败');
    expect(out).not.toContain('以核验要求为准');   // 烧尽原因不算判定打回起因,行动框架段不渲染
  });

  it('正例Q(D39 跨层反馈在 loop 嵌套下照旧)：外层容器 > loop > 内层容器,外层意见闸打回重跑时内层旧打回史仍进反馈', () => {
    // 外层重试让内层 loop 重新进入,只记入口事件、不划界线;内层记录在界线之后,内层步骤仍是重跑参与者
    const SPEC_Q = `# RQ
## Goal
G
## Steps
1. [subtask retry=2] 外层事务
  + → ok2: bool
  1.1. [loop max=1] 内层循环
    1.1.1. [subtask retry=2] 内层容器
      + → a_ok: bool
      1.1.1.1. [check] 内层判
        + → a_ok: bool
        + → a_note: text
        > judge
  1.2. [check] 外层意见闸
    + → ok2: bool
    + → note2: text
    > judge2
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_Q, MINIMAL_HOST_CONFIG);
    expect((engine.nextStep() as any).step_id).toBe('1.1.1.1');
    engine.completeStep('1.1.1.1', { a_ok: false, a_note: '内层原因A' });
    expect((engine.nextStep() as any).step_id).toBe('1.1.1.1');
    engine.completeStep('1.1.1.1', { a_ok: true, a_note: '' });
    expect((engine.nextStep() as any).step_id).toBe('1.2');
    engine.completeStep('1.2', { ok2: false, note2: '外层意见X' });
    expect((engine.nextStep() as any).step_id).toBe('1.1.1.1');
    const fb = engine.getActiveRetryFeedback('1.1.1.1');
    expect(fb?.reason).toContain('外层意见X');
    expect(JSON.stringify(fb?.prior ?? [])).toContain('内层原因A');
  });

  describe('for-each 循环同样按轮生效', () => {
    const SPEC_FE = `# RF
## Goal
G
## Inputs
- xs: [int]  # 列表
## Steps
1. [loop for-each x in xs] 逐项
  - ← xs
  1.1. [subtask retry=2] 分诊事务
    + → b: text
    1.1.1. [check] 分诊判
      - ← x
      + → a_ok: bool
      + → a_note: text
      > judge
    1.1.2. [reason] 后排步骤
      + → b: text
      > later
`;
    function runItem1(engine: ExecutionEngine) {
      expect((engine.nextStep() as any).step_id).toBe('1.1.1');
      engine.completeStep('1.1.1', { a_ok: false, a_note: '第一项原因A' });
      expect((engine.nextStep() as any).step_id).toBe('1.1.1');
      engine.completeStep('1.1.1', { a_ok: true, a_note: '' });
      expect((engine.nextStep() as any).step_id).toBe('1.1.2');
      engine.completeStep('1.1.2', { b: 'x1' });
    }

    it('正例I：for-each 第 2 项首步不吃第 1 项的反馈;loop_iter 在入口与轮进各记一条', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SPEC_FE, MINIMAL_HOST_CONFIG, { params: { xs: [1, 2] } });
      runItem1(engine);
      expect((engine.nextStep() as any).step_id).toBe('1.1.1');
      expect(engine.getActiveRetryFeedback('1.1.1')).toBeUndefined();
      expect(engine.getExecEvents().filter(e => e.event === 'loop_iter').map(e => [e.step_id, e.detail]))
        .toEqual([['1', '1'], ['1', '2']]);
    });

    it('正例J：for-each 第 2 项容器重试后,本轮首次执行的后排步骤不带反馈', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SPEC_FE, MINIMAL_HOST_CONFIG, { params: { xs: [1, 2] } });
      runItem1(engine);
      engine.nextStep();
      engine.completeStep('1.1.1', { a_ok: false, a_note: '第二项原因B' });
      expect((engine.nextStep() as any).step_id).toBe('1.1.1');
      expect(engine.getActiveRetryFeedback('1.1.1')?.reason).toContain('第二项原因B');
      engine.completeStep('1.1.1', { a_ok: true, a_note: '' });
      expect((engine.nextStep() as any).step_id).toBe('1.1.2');
      // 轮次事件缺失时:1.1.2 跨项累计开始 2 次,会被当成重跑参与者吃到"第二项原因B"
      expect(engine.getActiveRetryFeedback('1.1.2')).toBeUndefined();
    });
  });
});


// hopissues/0078——subprocess spawn 类异常(白名单拒/ENOENT/timeout)在复用模式曾裸抛到 CLI
// 顶层(0.13.0 报卡),直执批(81b018ee+5031c6b5,0.14.0 内)以 catch 折 failStep 治愈;此前
// 该行为面只有独立模式钉,复用模式 on fail 承接零端到端钉——本组三形态补锁。
// @v: anc-exec-subprocess-run, anc-exec-on-fail
describe('subprocess 异常入 on fail 链(0078 回归锁)', () => {
  const mk = (body: string, whitelist: string[]) => {
    const HC = {
      workspace_dir: '/tmp/test',
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: whitelist } },
      api_key: 'test-key',
    } as HostConfig;
    const SPEC = `# SP78
## Goal
G
## Outputs
- diag: line  # 诊断
## Steps
1. [subtask retry=0] 执行段
  + → r_ok: bool
  1.1. [act] 跑命令
    + → r_ok: bool
    > run cmd
    > \`\`\`hop_python
${body}
    > \`\`\`
  1.2. [on fail] 兜底
    1.2.1. [act] 记档降级
      + → r_ok: bool
      > \`\`\`hop_python
      > r_ok = false
      > \`\`\`
2. [act] 后续诊断步
  - ← r_ok
  + → diag: line
  > \`\`\`hop_python
  > diag = "handled:" + str(r_ok)
  > \`\`\`
`;
    return { HC, SPEC };
  };
  it('正例：白名单拒(空名单) → TOOL_EXEC_ERROR 折 failStep 进兜底,后续诊断步照跑', async () => {
    const { HC, SPEC } = mk('    > r = subprocess.run(["anything"])\n    > r_ok = r.returncode == 0', []);
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, HC);
    const r: any = await engine.advanceToCaller();
    expect(r.status).toBe('completed');
    expect(r.outputs?.diag).toBe('handled:false');
    // FailRecord 落账(0078 病态=步骤留 running 无 fail 账)
    expect(engine.exportFailState().stepFailReasons['1.1']?.reason).toContain('TOOL_EXEC_ERROR');
  });
  it('正例：ENOENT(白名单内但系统缺失) → 同折 failStep 进兜底', async () => {
    const { HC, SPEC } = mk('    > r = subprocess.run(["nonexistent-binary-xyz-0078"])\n    > r_ok = r.returncode == 0', ['nonexistent-binary-xyz-0078']);
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, HC);
    const r: any = await engine.advanceToCaller();
    expect(r.status).toBe('completed');
    expect(r.outputs?.diag).toBe('handled:false');
  });
  it('反例(对照)：业务非零退出不是异常——returncode 是值,兜底不触发,诊断步收 false 值路径', async () => {
    const { HC, SPEC } = mk('    > r = subprocess.run(["/usr/bin/false"])\n    > r_ok = r.returncode == 0', ['/usr/bin/false']);
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, HC);
    const r: any = await engine.advanceToCaller();
    expect(r.status).toBe('completed');
    // 非零退出走值路径:r_ok=false 由 1.1 正常产出,on fail 未激活(1.1 是 done 不是 failed)
    expect(r.outputs?.diag).toBe('handled:false');
    expect(engine.exportFailState().stepFailReasons['1.1']).toBeUndefined();
  });
});

// ===== 语义审计补钉批次（0086）：并行机制三根行为钉 =====

// fan-out 派发账落盘复原+防重派发。设计出处 design/parallel-execution.md §10g
// ^anc-exec-parallel-fanout-advisor（"派发权威归落盘,不靠子目录出现这个滞后副作用推断"）。
// 现行实现形态说明：旧 fanout-plan/fanout-next CLI 顾问命令已随 P0.5 统一模型退役,
// 防重派发的权威账=inflight（dispatchParallelSubtask/dispatchParallelCall 派发即入账
// 并 persist 原子落盘,ExecutionEngine.load 复原——src/engine.ts state.json 的 dispatched
// 键现只剩 load 兼容读侧,无在世写点）。本组钉三件行为：①派发即落盘（state.json 里能看到
// 这笔账）；②跨进程 load 复原（新引擎实例账上有已派 child）；③复原后引擎不再对同一 child
// 给出派发信号（防重派发——下一个派发信号必须是下一个 child,或没有新单时进入收齐等待）。
// @v: anc-exec-parallel-fanout-advisor
describe('fan-out 派发账落盘复原+防重派发（统一模型 inflight 账形态,0086 补钉）', () => {
  const FD_SPEC = `# FD
Id: fanout-dedup

## Goal
g

## Inputs
- xs: [int]  # 列表

## Outputs
- os: [int]  # 收集

## Steps
1. [loop for-each n in xs, collect o into os] 逐项
  + → os: [int]  # 收集
  1.1. [subtask parallel] 单项
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > o = n + 1
      > \`\`\`
2. [exit] 完
`;

  it('正例：派发入账落盘 state.json,跨进程 load 复原后账上含已派 child,下一个派发信号是下一个 child 不重发同单', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fd-restore-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(FD_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { xs: [7, 8] } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    e1.setUnifiedDispatch(true);
    const r1 = e1.nextStep();
    expect(r1.status).toBe('dispatch_ready');
    if (r1.status !== 'dispatch_ready') return;
    expect(r1.child_instance).toBe('1.1.1');
    // ①派发即落盘：state.json 里这笔账已在（不是内存态——"决定派发那一刻"就持久）
    const st = JSON.parse(readFileSync(join(stateDir, init.instance_id, 'state.json'), 'utf-8'));
    expect((st.inflight ?? []).map((f: { child_instance: string }) => f.child_instance)).toContain('1.1.1');
    // ②跨进程复原：另起引擎 load 同一实例目录（模拟进程重启/下一条 CLI 命令）
    const e2 = ExecutionEngine.load(join(stateDir, init.instance_id));
    expect(e2.getInflight().filter(f => f.child_instance === '1.1.1' && f.status === 'inflight')).toHaveLength(1);
    // ③防重派发：复原后的引擎给出的下一个派发信号是第二迭代的 1.1.2,不是重发 1.1.1
    e2.setUnifiedDispatch(true);   // 派发门不持久,driver 每进程重开（cli advance 同款姿势）
    const r2 = e2.nextStep();
    expect(r2.status).toBe('dispatch_ready');
    if (r2.status !== 'dispatch_ready') return;
    expect(r2.child_instance).toBe('1.1.2');
    // 账面 1.1.1 仍是那一笔,没有第二笔同名账（防重的账面判据）
    expect(e2.getInflight().filter(f => f.child_instance === '1.1.1')).toHaveLength(1);
  });

  it('正例：单项列表派发后 load 复原 → 没有新单时给 drain_wait 等收割,绝不重发已派 child;收割后照常 completed', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fd-drain-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(FD_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { xs: [7] } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;
    e1.setUnifiedDispatch(true);
    const r1 = e1.nextStep();
    expect(r1.status).toBe('dispatch_ready');
    if (r1.status !== 'dispatch_ready') return;
    // 进程"死亡",新进程 load：唯一 child 已派,复原后只能等收割——不许再吐 dispatch_ready
    const e2 = ExecutionEngine.load(join(stateDir, init.instance_id));
    e2.setUnifiedDispatch(true);
    const r2 = e2.nextStep();
    expect(r2.status).toBe('drain_wait');
    if (r2.status !== 'drain_wait') return;
    expect(r2.inflight).toContain('1.1.1');
    // 收割唯一在飞 → 收齐 completed,收集清单一元素（复原的账真能兑付,不是空壳）
    e2.reapParallelSubtask('1.1.1', { vars: { o: 8 } });
    const r3 = e2.nextStep();
    expect(r3.status).toBe('completed');
    if (r3.status !== 'completed') return;
    expect(r3.outputs['os']).toEqual([8]);
  });
});

// kill_list 载荷直钉。设计出处 design/parallel-execution.md §U8 ^anc-exec-parallel-reuse-protocol：
// 主线失败时在飞子实例全部记 killed（不留幻影）,failed 响应携带 kill_list 交 driver 尽力终止
// 对应外部会话。既有覆盖只钉了"账面 killed/killed 不产出"（dispatcher.test.ts 矩阵10）,
// failed 响应体上的 kill_list 字段本身此前无直钉——本组补上。
// @v: anc-exec-parallel-reuse-protocol
describe('主线失败 failed 响应携带 kill_list（§U8,0086 补钉）', () => {
  const KL_SPEC = `# KL
Id: kill-list

## Goal
g

## Inputs
- xs: [int]  # 列表

## Outputs
- os: [int]  # 收集

## Steps
1. [loop for-each n in xs, collect o into os] 逐项
  + → os: [int]  # 收集
  1.1. [subtask parallel] 派发
    + → o: int  # 单项
    1.1.1. [reason] 想
      - ← n
      + → o: int  # 结果
      > t
  1.2. [act free] 主线步
    - ← n
    + → w: line  # 本轮标记
    > 干活
2. [exit] 完
`;

  it('正例：并行派发后主线步骤失败 → failed 响应带 kill_list 且含在飞 child id,账面该 child 记 killed', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(KL_SPEC, MINIMAL_HOST_CONFIG, { params: { xs: [1, 2] } });
    expect(init.status).toBe('ok');
    engine.setUnifiedDispatch(true);
    const r1 = engine.nextStep();
    expect(r1.status).toBe('dispatch_ready');   // 1.1.1 在飞
    if (r1.status !== 'dispatch_ready') return;
    const r2 = engine.nextStep();
    expect(r2.status).toBe('step_ready');       // 主线走到 1.2
    if (r2.status !== 'step_ready') return;
    expect(r2.step_id).toBe('1.2');
    // 主线失败（loop 无 retry 语义、无 subtask 祖先 → 实例级终止）,域内在飞连坐 killed
    const fr = engine.failStep('1.2', '主线步骤失败(测试注入)');
    expect(fr.status).toBe('ok');
    const rf = engine.nextStep();
    expect(rf.status).toBe('failed');
    if (rf.status !== 'failed') return;
    // 钉的本体：failed 响应体携带 kill_list,driver 凭它尽力终止外部会话（§U8 契约字段）
    expect(rf.kill_list).toContain('1.1.1');
    // 账面对应：该 child 记 killed（不复活凭据）
    expect(engine.getInflight().filter(f => f.child_instance === '1.1.1' && f.status === 'killed')).toHaveLength(1);
  });

  it('反例：无在飞时主线失败 → failed 响应不带 kill_list（字段是条件载荷,零杀活不虚报）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(KL_SPEC, MINIMAL_HOST_CONFIG, { params: { xs: [1] } });
    expect(init.status).toBe('ok');
    // 不开派发门（复用模式退化窗口）：subtask parallel 串行下钻,零在飞
    // 逐步失败到耗尽（subtask 祖先有 retry 预算,循环喂失败直至实例终态）
    let rf = engine.nextStep();
    let guard = 0;
    while (guard++ < 30 && rf.status === 'step_ready') {
      engine.failStep(rf.step_id, '失败(测试注入)');
      rf = engine.nextStep();
    }
    expect(rf.status).toBe('failed');
    if (rf.status !== 'failed') return;
    expect(rf.kill_list).toBeUndefined();
    expect(engine.getInflight()).toHaveLength(0);   // 全程零在飞（对照面前提成立的证据）
  });
});

// DISPATCH_GRACE 启动宽限期两分支。设计出处 design/parallel-execution.md §U2/§U3
// ^anc-exec-parallel-timeout：派发入账后子实例目录由 worker 进程创建,滞后于"决定派发"——
// 目录未建且账龄未超宽限（DISPATCH_GRACE_SECONDS=60,写死不可配置,但账面 dispatched_at
// 可拨旧,两分支都真实可测,无需退化）→ 保持在飞不判死;超宽限 → 按 dispatchLostPolicy
// 分道（'fail'=独立模式判 dispatch-lost 收割 / 'stale'=复用模式交 driver 自查）。
// 既有覆盖：sweepTimedOutInflight 的宽限让位在 dispatcher.test.ts P1 组,CLI 通道 stale
// 分道在 cli.test.ts——reconcileInflight 引擎层两分支直钉此前缺席,本组补上。
// @v: anc-exec-parallel-timeout, anc-exec-parallel-inflight-reconcile
describe('DISPATCH_GRACE 启动宽限期两分支（reconcileInflight 引擎层直钉,0086 补钉）', () => {
  const GR_SPEC = `# GR
Id: grace-two

## Goal
g

## Inputs
- xs: [int]  # 列表

## Outputs
- os: [int]  # 收集

## Steps
1. [loop for-each n in xs, collect o into os] 逐项
  + → os: [int]  # 收集
  1.1. [subtask parallel] 单项
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > o = n + 1
      > \`\`\`
2. [exit] 完
`;

  // 公共盘面：派发一单但 worker 从未启动（子实例目录无 state.json——writeChildParams 只落
  // params.json,不构成"目录已建"判据）,随后进程死亡。
  function dispatchThenDie(ageMs?: number): { stateDir: string; instanceDir: string } {
    const stateDir = mkdtempSync(join(tmpdir(), 'gr-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(GR_SPEC, MINIMAL_HOST_CONFIG, { stateDir, params: { xs: [1, 2] } });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') throw new Error('init failed');
    e1.setUnifiedDispatch(true);
    const r1 = e1.nextStep();
    expect(r1.status).toBe('dispatch_ready');
    const instanceDir = join(stateDir, init.instance_id);
    if (ageMs !== undefined) {
      // 拨旧账面 dispatched_at（模拟账龄——宽限值写死 60s,经账面时刻注入测两侧）
      const sp = join(instanceDir, 'state.json');
      const st = JSON.parse(readFileSync(sp, 'utf-8'));
      st.inflight[0].dispatched_at = new Date(Date.now() - ageMs).toISOString();
      writeFileSync(sp, JSON.stringify(st));
    }
    return { stateDir, instanceDir };
  }

  it('分支一：目录未建且账龄在宽限内 → 保持在飞,不判超时不判死不进 stale（启动窗口是常态不是事故）', () => {
    const { instanceDir } = dispatchThenDie();   // 账龄≈0s < 60s
    const e2 = ExecutionEngine.load(instanceDir);
    const { reaped, stale } = e2.reconcileInflight();   // 缺省 'fail' 政策——最严的一档也不许误杀
    expect(reaped).toEqual([]);
    expect(stale).toEqual([]);
    expect(e2.getInflight().filter(f => f.child_instance === '1.1.1' && f.status === 'inflight')).toHaveLength(1);
  });

  it('分支二：目录未建且账龄超宽限 → 按政策分道：fail=判 dispatch-lost 收割出账;stale=保持在飞交 driver 自查', () => {
    const { instanceDir } = dispatchThenDie(120_000);   // 账龄 120s > 60s 宽限
    // 政策 'stale'（复用模式 CLI 通道）：引擎不判死,列 stale 清单,账保持在飞
    const eStale = ExecutionEngine.load(instanceDir);
    const rs = eStale.reconcileInflight({ dispatchLostPolicy: 'stale' });
    expect(rs.reaped).toEqual([]);
    expect(rs.stale).toContain('1.1.1');
    expect(eStale.getInflight().filter(f => f.child_instance === '1.1.1' && f.status === 'inflight')).toHaveLength(1);
    // 政策 'fail'（独立模式缺省）：判 dispatch-lost,失败收割出账（不留悬账）
    const eFail = ExecutionEngine.load(instanceDir);
    const rf = eFail.reconcileInflight();
    expect(rf.reaped).toContain('1.1.1');
    expect(rf.stale).toEqual([]);
    expect(eFail.getInflight().filter(f => f.child_instance === '1.1.1')).toHaveLength(0);
  });
});

// engine_min_version 版本闸（todo/0093 版本兼容性原则——Config 键声明引擎最低版本,init 期 semver 比对:
// 不足 INIT_FAILED 带两出路/非法格式 warn 按缺席/键缺席零比对存量零破坏）。 // @v: anc-exec-engine-min-version-gate
describe('engine_min_version 版本闸（0093）', () => {
  const SPEC = (cfg: string) => `# MG
Id: mg
## Goal
g
${cfg}## Outputs
- r: text  # r
## Steps
1. [act free] 干
  + → r: text  # r
`;

  it('反例：engine_min_version 高于引擎版本 → INIT_FAILED 报文带升级命令与删键两出路', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC('Config:\n  engine_min_version: 99.0.0\n'), MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('error');
    const msg = (init as { errors: { message: string }[] }).errors[0].message;
    expect(msg).toContain('engine_min_version: 99.0.0');
    expect(msg).toContain('npm i -g @hoplogic/hopjit@latest');
    expect(msg).toContain('删除 Config 段 engine_min_version 键');
  });

  it('正例：engine_min_version 低于引擎版本 → 照常起跑（semver 数值逐段比,0.1.0 < 当前）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC('Config:\n  engine_min_version: 0.1.0\n'), MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
  });

  it('正例：数值段比非字符串比——engine_min_version 0.9.0 放行（字符串比 "0.9.0">"0.15.1" 会误拒）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC('Config:\n  engine_min_version: 0.9.0\n'), MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
  });

  it('正例：非法格式按缺席处理 warn 留痕不拒（配置钝感写错不炸不静默）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC('Config:\n  engine_min_version: banana\n'), MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
    const warns = (init as { warnings?: { message: string }[] }).warnings ?? [];
    expect(warns.some(w => w.message.includes('engine_min_version') && w.message.includes('semver'))).toBe(true);
  });

  it('正例：键缺席零比对零提示（存量 spec 零破坏）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC(''), MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
    const warns = (init as { warnings?: { message: string }[] }).warnings ?? [];
    expect(warns.some(w => w.message.includes('engine_min_version'))).toBe(false);
  });

  it('正例：声明值恰等于当前引擎版本 → 放行（第十一轮 review 变异实锤:恰等是 pack 产物标准形态——pack 注入的就是当前版本,cmp<0 改 <=0 时全库曾无一红）', () => {
    const pkgJson = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8')) as { version: string };
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC(`Config:\n  engine_min_version: ${pkgJson.version}\n`), MINIMAL_HOST_CONFIG);
    expect(init.status).toBe('ok');
  });

});

// completed 标记与步骤态不一致检测（hopissues/0093——病态快照〔盘外写入/回放重建〕:标记 completed
// 而顶层步仍 pending,读侧显式报告不擅改。^anc-exec-completed-consistency） // @v: anc-exec-completed-consistency
describe('completed 标记与步骤态不一致检测（0093）', () => {
  const SPEC_2STEP = `# IC
Id: ic
## Goal
g
## Outputs
- r: text  # r
## Steps
1. [act free] 干
  + → r: text  # r
2. [exit] 收尾
  - ← r
`;

  function loadDoctored(states: Record<string, string>, terminal: string | null): ExecutionEngine {
    const sd = mkdtempSync(join(tmpdir(), 'eng-0093-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC_2STEP, MINIMAL_HOST_CONFIG, { stateDir: sd });
    const dir = join(sd, (init as { instance_id: string }).instance_id);
    // 盘外改写快照（病态来源的最小重现:正常盖印路径产不出这种组合）
    const stPath = join(dir, 'state.json');
    const st = JSON.parse(readFileSync(stPath, 'utf-8')) as Record<string, unknown>;
    st['step_states'] = states;
    if (terminal) st['terminal_state'] = terminal;
    writeFileSync(stPath, JSON.stringify(st));
    return ExecutionEngine.load(dir);
  }

  it('反例：completed 标记 + 顶层收尾步 pending → getStatus 带 inconsistency 显式信号,status 仍 completed 不擅改（报告不翻 running——重派已清账步骤=重复执行）', () => {
    const eng = loadDoctored({ '1': 'done', '2': 'pending' }, 'completed');
    const status = eng.getStatus();
    expect(status.execution_status).toBe('completed');
    const inc = (status as unknown as { inconsistency?: string }).inconsistency;
    expect(String(inc)).toContain('不一致');
    expect(String(inc)).toContain('2');   // 点名病态步
  });

  it('正例：completed 标记 + 全终态（含 skipped——worker 子实例子树外步骤形态,不误伤）→ 零 inconsistency', () => {
    const eng = loadDoctored({ '1': 'done', '2': 'skipped' }, 'completed');
    const status = eng.getStatus();
    expect(status.execution_status).toBe('completed');
    expect((status as unknown as { inconsistency?: string }).inconsistency).toBeUndefined();
  });

  it('正例：无 completed 标记时不检测（failed/running 快照零 inconsistency——检测面只罩 completed 标记）', () => {
    const eng = loadDoctored({ '1': 'done', '2': 'pending' }, null);
    const status = eng.getStatus();
    expect((status as unknown as { inconsistency?: string }).inconsistency).toBeUndefined();
  });

  it('反例：getVars 面同罩——病态快照 getVars 带 inconsistency（阅卷抓此面静默报 completed,全读取面不留静默通道）', () => {
    const eng = loadDoctored({ '1': 'done', '2': 'pending' }, 'completed');
    const vars = eng.getVars();
    expect(vars.execution_status).toBe('completed');
    expect(String((vars as unknown as { inconsistency?: string }).inconsistency)).toContain('不一致');
  });
});

// requires_commands 命令预检闸（hopissues/0090 P3 槽位半边——Config 键声明 body 依赖的本地命令,
// init 期与宿主白名单对账:缺即 INIT_FAILED 点名缺哪些并带 hopjit.yaml 指路/键缺席零比对存量零破坏/
// 非法格式 warn 按缺席/判序在 engine_min_version 后 Inputs 闸前）。 // @v: anc-exec-requires-commands-gate
describe('requires_commands 命令预检闸（0090）', () => {
  const SPEC = (cfg: string) => `# RC
Id: rc
## Goal
g
${cfg}## Outputs
- r: text  # r
## Steps
1. [act free] 干
  + → r: text  # r
`;
  const HOST_WITH = (cmds: string[]): HostConfig => ({
    workspace_dir: '/tmp/test',
    sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: cmds } },
    api_key: 'test-key',
  });

  it('反例：声明的命令宿主白名单缺 → INIT_FAILED 点名缺的命令并带 hopjit.yaml commands 指路,不进任何步骤', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC('Config:\n  requires_commands: [git, jq]\n'), HOST_WITH(['git']));
    expect(init.status).toBe('error');
    const msg = (init as { errors: { message: string }[] }).errors[0].message;
    expect(msg).toContain('requires_commands');
    expect(msg).toContain('缺少: jq');
    expect(msg).toContain('hopjit.yaml 的 commands');
  });

  it('正例：声明的命令白名单全在 → 照常起跑', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC('Config:\n  requires_commands: [git]\n'), HOST_WITH(['git', 'npx']));
    expect(init.status).toBe('ok');
  });

  it('反例：有声明但宿主白名单为空 → INIT_FAILED（能力关死时启动点就拦,不进 body 才死）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC('Config:\n  requires_commands: [git]\n'), HOST_WITH([]));
    expect(init.status).toBe('error');
    const msg = (init as { errors: { message: string }[] }).errors[0].message;
    expect(msg).toContain('缺少: git');
  });

  it('正例：非法格式（非列表）warn 按缺席不拒（配置钝感写错不炸不静默）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC('Config:\n  requires_commands: git\n'), HOST_WITH([]));
    expect(init.status).toBe('ok');
    const warns = (init as { warnings?: { message: string }[] }).warnings ?? [];
    expect(warns.some(w => w.message.includes('requires_commands') && w.message.includes('列表'))).toBe(true);
  });

  it('正例：列表含非字符串项 → warn 按缺席不拒（some 判半边——第十一轮 review 抓获原只测非列表标量）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC('Config:\n  requires_commands: [git, 123]\n'), HOST_WITH([]));
    expect(init.status).toBe('ok');
    const warns = (init as { warnings?: { message: string }[] }).warnings ?? [];
    expect(warns.some(w => w.message.includes('requires_commands') && w.message.includes('列表'))).toBe(true);
  });

  it('正例：键缺席零比对零提示（存量 spec 零破坏——未声明的仍靠运行期白名单拒兜底）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC(''), HOST_WITH([]));
    expect(init.status).toBe('ok');
    const warns = (init as { warnings?: { message: string }[] }).warnings ?? [];
    expect(warns.some(w => w.message.includes('requires_commands'))).toBe(false);
  });

  it('正例：空列表声明 → 零比对照常起跑（声明了但不依赖任何命令）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC('Config:\n  requires_commands: []\n'), HOST_WITH([]));
    expect(init.status).toBe('ok');
  });

  it('判序钉：同时缺命令又缺必填 Inputs → 先报命令缺失不报 Inputs（三闸环境层到参数层递进——命令都不齐时补参没意义）', () => {
    const SPEC_WITH_INPUTS = `# RC2
Id: rc2
## Goal
g
Config:
  requires_commands: [jq]
## Inputs
- src: text  # 输入
## Outputs
- r: text  # r
## Steps
1. [act free] 干
  - ← src
  + → r: text  # r
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC_WITH_INPUTS, HOST_WITH([]));
    expect(init.status).toBe('error');
    const msg = (init as { errors: { message: string }[] }).errors[0].message;
    expect(msg).toContain('缺少: jq');
    expect(msg).not.toContain('必填 Inputs 缺失');
  });

  it('判序钉：engine_min_version 不足与命令缺失并存 → 先报版本不报命令（版本不足时命令报文可能基于新语法）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC('Config:\n  engine_min_version: 99.0.0\n  requires_commands: [jq]\n'), HOST_WITH([]));
    expect(init.status).toBe('error');
    const msg = (init as { errors: { message: string }[] }).errors[0].message;
    expect(msg).toContain('engine_min_version: 99.0.0');
    expect(msg).not.toContain('requires_commands');
  });
});
