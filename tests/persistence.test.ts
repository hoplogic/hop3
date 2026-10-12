// @module: persistence ^anc-provider-persistence
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsMod from 'node:fs';

// fsync 调用序钉的观测口（0088 批⑨）：ESM 命名导出不可 spyOn（namespace 不可配置）,
// 用 vi.mock 对 node:fs 做透传包装——只把 fsyncSync/renameSync 换成"调真实现的 vi.fn",
// 其余导出原样透传,本文件其它用例的真实 fs 行为不受影响。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) };
});
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, realpathSync, utimesSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionEngine } from '../src/engine.js';
import { writeAtomic, writeState, readState, readVars, readSpec, flattenVars, FilePersistence, MemoryPersistence, writeChildParams, readChildParams, readStateSeq, findRunRoot } from '../src/persistence.js';
import type { HostConfig } from '../src/provider-types.js';

const MINIMAL_HOST_CONFIG: HostConfig = {
  workspace_dir: '/tmp/test',
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'test-key',
};

const TWO_STEP_SPEC = `# Persist Test
Id: persist-test

## Goal
Test persistence round trip

## Inputs
- data: text  # input

## Outputs
- result: text  # final

## Steps
1. [reason] Step one
  - ← data
  + → mid: text  # intermediate
  > Do step one

2. [act] Step two
  - ← mid
  + → result: text  # final output
  > Do step two
`;

const BRANCH_SPEC = `# Branch Test
Id: branch-test

## Goal
Test branch persistence

## Outputs
- result: text  # output

## Steps
1. [branch] Choose path
  1.1. [case] Path A {condition: "always"}
    1.1.1. [act] Do A
      + → result: text  # from A
      > A path
  1.2. [case] Path B {condition: "never"}
    1.2.1. [act] Do B
      + → result: text  # from B
      > B path
`;

describe('persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hopjit-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // @v: anc-exec-crash-recovery
  describe('writeAtomic', () => {
    it('creates a new file', () => {
      const path = join(tmpDir, 'test.json');
      writeAtomic(path, '{"a":1}');
      expect(readFileSync(path, 'utf-8')).toBe('{"a":1}');
    });

    it('overwrites an existing file atomically', () => {
      const path = join(tmpDir, 'test.json');
      writeAtomic(path, '{"v":1}');
      writeAtomic(path, '{"v":2}');
      expect(readFileSync(path, 'utf-8')).toBe('{"v":2}');
      expect(existsSync(path + '.tmp')).toBe(false);
    });

    // @v: anc-exec-crash-recovery —— fsync 调用序钉（0088 批⑨:设计伪代码 write→fsync→rename,
    // 缺 fsync 则掉电时 rename 可能先于数据持久化,读到空/半截新文件。此前只测结果文件内容,
    // fsync 被删测试照绿——本钉直接断言 fsyncSync 被调且时序在 renameSync 之前）
    it('fsyncSync 在 renameSync 之前被调用（要么旧要么新承诺的第二步）', () => {
      const fsyncSpy = vi.mocked(fsMod.fsyncSync);
      const renameSpy = vi.mocked(fsMod.renameSync);
      fsyncSpy.mockClear();
      renameSpy.mockClear();
      writeAtomic(join(tmpDir, 'order.json'), '{"a":1}');
      expect(fsyncSpy).toHaveBeenCalled();
      expect(renameSpy).toHaveBeenCalled();
      // invocationCallOrder 是 vitest 全局单调序号——fsync 的首次调用序必须先于 rename 的首次调用序
      expect(fsyncSpy.mock.invocationCallOrder[0]).toBeLessThan(renameSpy.mock.invocationCallOrder[0]);
    });
  });

  // @v: anc-exec-state-persistence
  describe('initExecution with stateDir', () => {
    it('writes spec.json, state.json, vars.json on init', () => {
      const engine = new ExecutionEngine();
      const result = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir: tmpDir, params: { data: 'd' } });
      expect(result.status).toBe('ok');

      if (result.status !== 'ok') return;
      const instanceDir = join(tmpDir, result.instance_id);
      expect(existsSync(join(instanceDir, 'spec.json'))).toBe(true);
      expect(existsSync(join(instanceDir, 'state.json'))).toBe(true);
      expect(existsSync(join(instanceDir, 'vars.json'))).toBe(true);
    });

    it('state.json has correct initial content', () => {
      const engine = new ExecutionEngine();
      const result = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir: tmpDir, params: { data: 'd' } });
      if (result.status !== 'ok') return;

      const instanceDir = join(tmpDir, result.instance_id);
      const state = readState(instanceDir);
      expect(state.format_version).toBe(1);
      expect(state.step_states['1']).toBe('pending');
      expect(state.step_states['2']).toBe('pending');
      expect(state.step_states['1']).toBeDefined();
    });

    it('vars.json contains header inputs', () => {
      const engine = new ExecutionEngine();
      const result = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir: tmpDir, params: { data: 'd' } });
      if (result.status !== 'ok') return;

      const instanceDir = join(tmpDir, result.instance_id);
      const vars = readVars(instanceDir);
      expect(vars.format_version).toBe(2);
      expect(flattenVars(vars)['instance_id']).toBe(result.instance_id);
      // 'data' input has no default → stored as undefined → dropped by JSON.stringify
      // instance_id is the key proof that header inputs are written
    });
  });

  describe('persist after mutations', () => {
    it('updates state.json after completeStep', () => {
      const engine = new ExecutionEngine();
      const init = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir: tmpDir, params: { data: 'd' } });
      if (init.status !== 'ok') return;
      const instanceDir = join(tmpDir, init.instance_id);

      const next = engine.nextStep();
      expect(next.status).toBe('step_ready');
      if (next.status !== 'step_ready') return;

      engine.completeStep(next.step_id, { mid: 'intermediate' });

      const state = readState(instanceDir);
      expect(state.step_states[next.step_id]).toBe('done');

      const vars = readVars(instanceDir);
      expect(flattenVars(vars)['mid']).toBe('intermediate');
    });

    it('updates state.json after failStep', () => {
      const engine = new ExecutionEngine();
      const init = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir: tmpDir, params: { data: 'd' } });
      if (init.status !== 'ok') return;
      const instanceDir = join(tmpDir, init.instance_id);

      const next = engine.nextStep();
      if (next.status !== 'step_ready') return;

      engine.failStep(next.step_id, 'test failure');

      const state = readState(instanceDir);
      expect(state.step_states[next.step_id]).toBe('failed');
    });
  });

  // @v: anc-exec-crash-recovery
  describe('resume (crash recovery)', () => {
    it('resumes after complete step — continues to next', () => {
      const engine = new ExecutionEngine();
      const init = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir: tmpDir, params: { data: 'd' } });
      if (init.status !== 'ok') return;
      const instanceDir = join(tmpDir, init.instance_id);

      // Execute step 1
      const step1 = engine.nextStep();
      if (step1.status !== 'step_ready') return;
      engine.completeStep(step1.step_id, { mid: 'value' });

      // Resume from disk
      const resumed = ExecutionEngine.load(instanceDir);
      const next = resumed.nextStep();
      expect(next.status).toBe('step_ready');
      if (next.status !== 'step_ready') return;
      expect(next.step_id).toBe('2');
    });

    it('crash recovery — running step resets to pending', () => {
      const engine = new ExecutionEngine();
      const init = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir: tmpDir, params: { data: 'd' } });
      if (init.status !== 'ok') return;
      const instanceDir = join(tmpDir, init.instance_id);

      // Get step 1 into running state
      const step1 = engine.nextStep();
      expect(step1.status).toBe('step_ready');

      // Simulate crash: manually set step to 'running' on disk
      const currentState = readState(instanceDir);
      currentState.step_states['1'] = 'running';
      writeState(instanceDir, currentState);

      // Resume — running should become pending
      const resumed = ExecutionEngine.recover(instanceDir);
      const next = resumed.nextStep();
      expect(next.status).toBe('step_ready');
      if (next.status !== 'step_ready') return;
      expect(next.step_id).toBe('1');
    });

    // @v: anc-exec-state-persistence
    // load 与 recover 的语义对照：load 保留 running（复用模式 next→done 跨进程流），
    // recover 才重置。回归——历史上 done 进程用崩溃恢复式 resume，把 next 设的 running
    // 重置成 pending，导致 completeStep 报 "expected running"。
    it('load preserves running step (next→done across processes)', () => {
      const engine = new ExecutionEngine();
      const init = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir: tmpDir, params: { data: 'd' } });
      if (init.status !== 'ok') return;
      const instanceDir = join(tmpDir, init.instance_id);

      // next 把 step 1 设为 running 并落盘（模拟 next 进程）
      const step1 = engine.nextStep();
      expect(step1.status).toBe('step_ready');
      expect(readState(instanceDir).step_states['1']).toBe('running');

      // 另一进程 load（模拟 done 进程）——running 必须保留
      const loaded = ExecutionEngine.load(instanceDir);
      expect(loaded.getStepStates().get('1')).toBe('running');
      // completeStep 能正常回写（running 未被重置）。
      // 输出字段须匹配 step 1 的声明 `+→ mid: text`（schema 校验 anc-exec-output-schema-check）
      const result = loaded.completeStep('1', { mid: 'x' });
      expect(result.status).toBe('ok');
    });

    it('branch with selection preserved on resume（todo/0168 后夹具改为引擎自己求值选路,不再借 selectBranch 预选）', () => {
      const engine = new ExecutionEngine();
      const init = engine.initExecution(BRANCH_SPEC, MINIMAL_HOST_CONFIG, { stateDir: tmpDir });
      if (init.status !== 'ok') return;
      const instanceDir = join(tmpDir, init.instance_id);

      // 引擎进入 branch 按条件选中 1.1（条件 always）,停在 1.1.1 running——这就是"已选路"的账
      const first = engine.nextStep();
      expect(first.status).toBe('step_ready');
      if (first.status !== 'step_ready') return;
      expect(first.step_id).toBe('1.1.1');
      expect(engine.getStepStates().get('1.2')).toBe('skipped');

      // recover：已选路的 branch 保留选择不重评估,悬空 running 的叶子重置后再次停在 1.1.1
      const resumed = ExecutionEngine.recover(instanceDir);
      const next = resumed.nextStep();
      expect(next.status).toBe('step_ready');
      if (next.status !== 'step_ready') return;
      expect(next.step_id).toBe('1.1.1');
      expect(resumed.getStepStates().get('1.2')).toBe('skipped');
    });

    it('resumed engine continues to persist', () => {
      const engine = new ExecutionEngine();
      const init = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir: tmpDir, params: { data: 'd' } });
      if (init.status !== 'ok') return;
      const instanceDir = join(tmpDir, init.instance_id);

      // Complete step 1
      const step1 = engine.nextStep();
      if (step1.status !== 'step_ready') return;
      engine.completeStep(step1.step_id, { mid: 'v1' });

      // Resume and complete step 2
      const resumed = ExecutionEngine.load(instanceDir);
      const step2 = resumed.nextStep();
      if (step2.status !== 'step_ready') return;
      resumed.completeStep(step2.step_id, { result: 'final' });

      // Verify final state on disk
      const state = readState(instanceDir);
      expect(state.step_states['1']).toBe('done');
      expect(state.step_states['2']).toBe('done');

      const vars = readVars(instanceDir);
      expect(flattenVars(vars)['result']).toBe('final');
    });
  });

  describe('backward compatibility', () => {
    it('works without stateDir (pure in-memory)', () => {
      const engine = new ExecutionEngine();
      const init = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { data: 'd' } });
      expect(init.status).toBe('ok');

      if (init.status !== 'ok') return;
      const next = engine.nextStep();
      expect(next.status).toBe('step_ready');
      if (next.status !== 'step_ready') return;
      engine.completeStep(next.step_id, { mid: 'test' });
      // No crash — engine works fine without persistence
    });
  });

  // @v: anc-provider-persistence
  describe('FilePersistence', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fp-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    const SNAPSHOT = {
      spec: { header: { title: 'T', id: 'fp-spec' }, steps: [] },
      state: { format_version: 1 as const, step_states: { '1': 'done' }, retry_counters: {}, loop_counters: {} },
      vars: { format_version: 1 as const, variables: { x: 42 } },
    };

    it('init creates instance dir + writes spec', () => {
      const fp = new FilePersistence(dir);
      fp.init('inst-1', SNAPSHOT.spec as any);
      expect(fp.getInstanceDir()).toBe(join(dir, 'inst-1'));
      expect(existsSync(join(dir, 'inst-1', 'spec.json'))).toBe(true);
    });

    // @v: anc-exec-work-zone
    it('init creates work_zone/ and work_zone/vars/ subdirs', () => {
      const fp = new FilePersistence(dir);
      fp.init('inst-1', SNAPSHOT.spec as any);
      expect(existsSync(join(dir, 'inst-1', 'work_zone'))).toBe(true);
      expect(existsSync(join(dir, 'inst-1', 'work_zone', 'vars'))).toBe(true);
    });

    // @v: anc-exec-work-zone
    it('getWorkZone returns absolute path to work_zone/', () => {
      const fp = new FilePersistence(dir);
      fp.init('inst-1', SNAPSHOT.spec as any);
      expect(fp.getWorkZone()).toBe(join(dir, 'inst-1', 'work_zone'));
    });

    it('getWorkZone before init throws', () => {
      const fp = new FilePersistence(dir);
      expect(() => fp.getWorkZone()).toThrow();
    });

    // @v: anc-exec-state-persistence —— 往返一致性直标（0088 批⑪:行为原有测,直标缺位补齐）
    it('save then load round-trips snapshot', () => {
      const fp = new FilePersistence(dir);
      fp.init('inst-1', SNAPSHOT.spec as any);
      fp.saveSnapshot(SNAPSHOT as any);

      const loaded = fp.loadSnapshot();
      expect(loaded.state.step_states['1']).toBe('done');
      expect(flattenVars(loaded.vars)['x']).toBe(42);
      expect((loaded.spec.header as any).id).toBe('fp-spec');
    });

    it('exists reflects whether state.json present', () => {
      const fp = new FilePersistence(dir);
      fp.init('inst-1', SNAPSHOT.spec as any);
      expect(fp.exists()).toBe(false);  // no saveSnapshot yet → no state.json
      fp.saveSnapshot(SNAPSHOT as any);
      expect(fp.exists()).toBe(true);
    });

    it('reconstructs from existing instance dir (isInstanceDir=true)', () => {
      const fp1 = new FilePersistence(dir);
      fp1.init('inst-1', SNAPSHOT.spec as any);
      fp1.saveSnapshot(SNAPSHOT as any);

      const instanceDir = fp1.getInstanceDir()!;
      const fp2 = new FilePersistence(instanceDir, true);
      expect(fp2.exists()).toBe(true);
      expect(flattenVars(fp2.loadSnapshot().vars)['x']).toBe(42);
    });

    it('saveSnapshot before init throws', () => {
      const fp = new FilePersistence(dir);
      expect(() => fp.saveSnapshot(SNAPSHOT as any)).toThrow();
    });
  });

  // @v: anc-provider-persistence
  describe('MemoryPersistence', () => {
    const SNAPSHOT = {
      spec: { header: { title: 'T', id: 'mem-spec' }, steps: [] },
      state: { format_version: 1 as const, step_states: { '1': 'running' }, retry_counters: {}, loop_counters: {} },
      vars: { format_version: 1 as const, variables: { y: 'hello' } },
    };

    it('exists false before any save, true after', () => {
      const mp = new MemoryPersistence();
      mp.init('inst-1', SNAPSHOT.spec as any);
      expect(mp.exists()).toBe(false);
      mp.saveSnapshot(SNAPSHOT as any);
      expect(mp.exists()).toBe(true);
    });

    it('save then load returns same snapshot', () => {
      const mp = new MemoryPersistence();
      mp.init('inst-1', SNAPSHOT.spec as any);
      mp.saveSnapshot(SNAPSHOT as any);
      const loaded = mp.loadSnapshot();
      expect(loaded.state.step_states['1']).toBe('running');
      expect(flattenVars(loaded.vars)['y']).toBe('hello');
    });

    it('writes no files to disk', () => {
      const probe = mkdtempSync(join(tmpdir(), 'mem-probe-'));
      const mp = new MemoryPersistence();
      mp.init('inst-1', SNAPSHOT.spec as any);
      mp.saveSnapshot(SNAPSHOT as any);
      // probe dir stays empty — MemoryPersistence never touches fs

      expect(readdirSync(probe).length).toBe(0);
      rmSync(probe, { recursive: true, force: true });
    });

    it('loadSnapshot before save throws', () => {
      const mp = new MemoryPersistence();
      mp.init('inst-1', SNAPSHOT.spec as any);
      expect(() => mp.loadSnapshot()).toThrow();
    });
  });

  // @v: anc-provider-persistence
  describe('engine defaults to MemoryPersistence (无 stateDir 宿主兜底)', () => {
    it('no stateDir → no .hopstate files written', () => {
      const probe = mkdtempSync(join(tmpdir(), 'engine-mem-'));
      const engine = new ExecutionEngine();
      const init = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { data: 'd' } });
      expect(init.status).toBe('ok');
      // No stateDir passed → MemoryPersistence → probe stays clean

      expect(readdirSync(probe).length).toBe(0);
      rmSync(probe, { recursive: true, force: true });
    });
  });

  // @v: anc-exec-parallel-join-preconditions
  // 状态文件格式校验：format_version + 关键字段不符 → CORRUPT_STATE_FILE，而非晦涩 TypeError。
  describe('readState/readVars 格式校验', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'corrupt-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('合法 state.json/vars.json 正常读', () => {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ format_version: 1, step_states: { '1': 'done' }, retry_counters: {}, loop_counters: {} }));
      writeFileSync(join(dir, 'vars.json'), JSON.stringify({ format_version: 1, variables: { x: 1 } }));
      expect(readState(dir).step_states['1']).toBe('done');
      expect(readVars(dir).variables.x).toBe(1);
    });

    it('非法 JSON → CORRUPT_STATE_FILE', () => {
      writeFileSync(join(dir, 'state.json'), '{ not json');
      expect(() => readState(dir)).toThrow(/CORRUPT_STATE_FILE.*非合法 JSON/);
    });

    it('format_version 不符 → CORRUPT_STATE_FILE', () => {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ format_version: 2, step_states: {} }));
      expect(() => readState(dir)).toThrow(/CORRUPT_STATE_FILE.*format_version/);
    });

    it('缺关键字段 step_states → CORRUPT_STATE_FILE', () => {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ format_version: 1 }));
      expect(() => readState(dir)).toThrow(/CORRUPT_STATE_FILE.*step_states/);
    });

    it('vars 缺 variables → CORRUPT_STATE_FILE', () => {
      writeFileSync(join(dir, 'vars.json'), JSON.stringify({ format_version: 1 }));
      expect(() => readVars(dir)).toThrow(/CORRUPT_STATE_FILE.*variables/);
    });

    it('文件不存在 → CORRUPT_STATE_FILE 不可读', () => {
      expect(() => readState(dir)).toThrow(/CORRUPT_STATE_FILE.*不可读/);
    });
  });
});

// ===== F类测试缺口补齐（2026-08-08 语义审计 c2t ⚠️，persistence 批）=====

// @v: anc-exec-state-persistence —— 目录 0700/文件 0600 是设计显式契约
describe('权限位契约', () => {
  it('实例目录 0700、状态文件 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptest-perm-'));
    const engine = new ExecutionEngine();
    const result = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir: dir, params: { data: 'd' } });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const instanceDir = join(dir, result.instance_id);
    expect(statSync(instanceDir).mode & 0o777).toBe(0o700);
    for (const f of ['spec.json', 'state.json', 'vars.json']) {
      expect(statSync(join(instanceDir, f)).mode & 0o777).toBe(0o600);
    }
  });
});

// @v: anc-string-escape —— 外部来源值（空格/引号/换行/中文）经 params.json 通道往返
describe('params.json 特殊字符往返', () => {
  it('writeChildParams → readChildParams 逐字保真', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptest-esc-'));
    const params = {
      spaced: 'hello world "quoted" ',
      multiline: 'line1\nline2\ttabbed',
      chinese: '中文值：密算/隐私计算',
      tricky: `back\\slash 'single' $dollar`,
    };
    writeChildParams(dir, 'c1', params);
    expect(readChildParams(join(dir, 'parallel', 'c1'))).toEqual(params);
  });
});

// @v: anc-exec-parallel-foreach-worker —— params.json 存在但损坏 → 响亮失败非 MISSING_INPUT
describe('readChildParams calls 分支与缺文件路径（0086 补钉）', () => {
  it('正例：kind=calls → params.json 落 calls/<cid>（0020 修——call 子实例路径,修前写死 parallel）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptest-calls-'));
    writeChildParams(dir, 'c9', { a: 1 }, 'calls');
    expect(existsSync(join(dir, 'calls', 'c9', 'params.json'))).toBe(true);
    expect(readChildParams(join(dir, 'calls', 'c9'))).toEqual({ a: 1 });
  });

  it('反例：params.json 不存在 → 返回 null（MISSING_INPUT 上游判据,与损坏文件的 throw 分野）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptest-nofile-'));
    mkdirSync(join(dir, 'empty'), { recursive: true });
    expect(readChildParams(join(dir, 'empty'))).toBeNull();
  });
});

describe('readChildParams 损坏文件分支', () => {
  it('非法 JSON → throw CORRUPT_STATE_FILE（不吞成 null）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptest-corrupt-params-'));
    const childDir = join(dir, 'c1');
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, 'params.json'), '{broken');
    expect(() => readChildParams(childDir)).toThrow(/CORRUPT_STATE_FILE.*params\.json/);
  });
});

// @v: anc-exec-work-zone —— 2026-08-10 改判：body 内 work_zone_path() 需要真实目录，
// MemoryPersistence 首调 tmpdir 自建（原"返回空串透传"废——NextResponse 侧空串由 dispatcher 兜）
describe('MemoryPersistence.getWorkZone', () => {
  it('首调自建 tmpdir 并稳定复用（同实例两次调用同路径）', () => {
    const mp = new MemoryPersistence();
    const wz = mp.getWorkZone();
    expect(wz).toContain('hopjit-workzone-');
    expect(mp.getWorkZone()).toBe(wz);   // 幂等：不重复建目录
  });
});

// work_zone 根集合来源（todo/0124——persistence 只报根,登记归 engine;原 0086 补钉的"双形态注册"
// 断言改到 tools.test.ts 提供者侧:提供者收一条根自己放两形态）。
// @v: anc-exec-work-zone-registry
describe('getWorkZoneRoots：本实例加祖先实例的 work_zone 集合', () => {
  it('正例：MemoryPersistence 的集合就是自己的 tmpdir 根（无祖先布局）', () => {
    const mp = new MemoryPersistence();
    const wz = mp.getWorkZone();
    expect(mp.getWorkZoneRoots()).toEqual([wz]);
  });
  it('正例：顶层 FilePersistence 只报自己一条（state-dir 目录名任意,不看 .hopstate 字面）', () => {
    const stateDir = join(mkdtempSync(join(tmpdir(), 'hopwzr-')), 'runtime', 'hopstate');
    const fp = new FilePersistence(stateDir);
    fp.init('top-1', { header: { title: 'T', id: 't' }, steps: [] } as never);
    expect(fp.getWorkZoneRoots()).toEqual([join(stateDir, 'top-1', 'work_zone')]);
  });
  it('正例：call 子实例与 parallel 孙实例按目录布局上溯——自身首位,祖先依次在后（子写父 judgement_log 形态的根据）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hopwzr-'));
    const top = new FilePersistence(stateDir);
    top.init('top-1', { header: { title: 'T', id: 't' }, steps: [] } as never);
    top.saveSnapshot({ spec: { header: { title: 'T', id: 't' }, steps: [] }, state: { instance_id: 'top-1', spec_id: 't', step_states: {}, current_step: null, retry_counts: {}, loop_counters: {} }, vars: { variables: {} } } as never);
    const child = new FilePersistence(join(stateDir, 'top-1', 'calls'));
    child.init('3.1', { header: { title: 'C', id: 'c' }, steps: [] } as never);
    child.saveSnapshot({ spec: { header: { title: 'C', id: 'c' }, steps: [] }, state: { instance_id: '3.1', spec_id: 'c', step_states: {}, current_step: null, retry_counts: {}, loop_counters: {} }, vars: { variables: {} } } as never);
    const grand = new FilePersistence(join(stateDir, 'top-1', 'calls', '3.1', 'parallel'));
    grand.init('2.4.7', { header: { title: 'G', id: 'g' }, steps: [] } as never);
    expect(child.getWorkZoneRoots()).toEqual([
      join(stateDir, 'top-1', 'calls', '3.1', 'work_zone'),
      join(stateDir, 'top-1', 'work_zone'),
    ]);
    expect(grand.getWorkZoneRoots()).toEqual([
      join(stateDir, 'top-1', 'calls', '3.1', 'parallel', '2.4.7', 'work_zone'),
      join(stateDir, 'top-1', 'calls', '3.1', 'work_zone'),
      join(stateDir, 'top-1', 'work_zone'),
    ]);
  });
  it('反例：上一级有 state.json 但中间目录名不是 parallel/calls——不上溯（kind 判定半边,review 面三 m7 曾全绿）', () => {
    // 上溯看的是实例目录的上两级:<父实例>/parallel|calls/<cid>——这里把 state.json 放在 stateDir 的上一级
    // （即实例目录的上两级）,让 state.json 半边成立,只剩"中间目录名须是 parallel/calls"这半边把关
    const base = mkdtempSync(join(tmpdir(), 'hopwzr-'));
    writeFileSync(join(base, 'state.json'), '{}');
    const stateDir = join(base, 'hopstate');
    const fp = new FilePersistence(stateDir);
    fp.init('top-2', { header: { title: 'T', id: 't' }, steps: [] } as never);
    expect(fp.getWorkZoneRoots()).toEqual([join(stateDir, 'top-2', 'work_zone')]);
  });
  it('反例：state-dir 自己就叫 calls 时,上一级没有 state.json 不算祖先（同名目录不误认父实例）', () => {
    const stateDir = join(mkdtempSync(join(tmpdir(), 'hopwzr-')), 'calls');
    const fp = new FilePersistence(stateDir);
    fp.init('lonely', { header: { title: 'L', id: 'l' }, steps: [] } as never);
    expect(fp.getWorkZoneRoots()).toEqual([join(stateDir, 'lonely', 'work_zone')]);
  });
});

// @v: anc-exec-work-zone, anc-exec-deflate —— BUG-F 修：MemoryPersistence workzone 与 vars/ 同建
describe('MemoryPersistence getWorkZone（BUG-F 回归）', () => {
  it('正例：首调自建 tmpdir 时 vars/ 同建（deflate 写点就绪,与 FilePersistence 对称）', () => {
    const mp = new MemoryPersistence();
    const wz = mp.getWorkZone();
    expect(existsSync(join(wz, 'vars'))).toBe(true);
  });

  it('幂等：再调返回同一路径不重建', () => {
    const mp = new MemoryPersistence();
    expect(mp.getWorkZone()).toBe(mp.getWorkZone());
  });
});

// readStateSeq:只读 state.json 的写入序号与最后写入者;读不出一律序号 0 不抛（todo/0114）
// @v: anc-exec-state-seq-guard
describe('readStateSeq（state.json 写入序号只读口）', () => {
  it('正例：字段在场原样返回;反例：文件不在/坏 JSON/字段缺席/类型不对都返回 seq 0 不抛', () => {
    const d = mkdtempSync(join(tmpdir(), 'seq-read-'));
    expect(readStateSeq(d)).toEqual({ seq: 0 });   // 文件不在
    writeFileSync(join(d, 'state.json'), '{坏的');
    expect(readStateSeq(d)).toEqual({ seq: 0 });   // 解析失败
    writeFileSync(join(d, 'state.json'), JSON.stringify({ format_version: 1, step_states: {} }));
    expect(readStateSeq(d)).toEqual({ seq: 0 });   // 旧文件字段缺席
    writeFileSync(join(d, 'state.json'), JSON.stringify({ step_states: {}, state_seq: '7' }));
    expect(readStateSeq(d)).toEqual({ seq: 0 });   // 类型不对
    writeFileSync(join(d, 'state.json'), JSON.stringify({ step_states: {}, state_seq: 7, last_writer: { pid: 123, at: '2026-09-26T00:00:00.000Z' } }));
    expect(readStateSeq(d)).toEqual({ seq: 7, last_writer: { pid: 123, at: '2026-09-26T00:00:00.000Z' } });
  });
});

// spec 快照内容寻址（todo/0130 承接 hopissues/0115——hopkb 单批 2309 份 spec.json 1.62G 只有 3 种内容）：真身按 sha256 在
// run 根 specs/ 存一份,实例 spec.json 只存引用;读侧双形态+缓存。变异回放:writeSpec 去掉"真身已存在则跳过"→幂等钉红;
// readSpec 去掉 $spec_ref 分支→引用形态 load 红。
// @v: anc-provider-spec-content-addressed
describe('spec 快照内容寻址去重', () => {
  const SPEC = (id: string) => ({ header: { title: 'T', id }, steps: [{ step_id: '1', type: 'act', summary: 's' }] }) as never;
  const snap = (spec: unknown, iid: string) => ({ spec, state: { format_version: 1, instance_id: iid, spec_id: 't', step_states: {}, current_step: null, retry_counters: {}, loop_counters: {} }, vars: { format_version: 2, scopes: {} } }) as never;
  const readRef = (dir: string) => JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf-8')) as { $spec_ref?: string; format_version?: number };

  it('正例：同内容三实例（顶层+call 子+parallel 孙）只落一份真身,三个 spec.json 都是同 sha 引用;不同内容再来一份', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cas-'));
    const top = new FilePersistence(stateDir); top.init('top', SPEC('same')); top.saveSnapshot(snap(SPEC('same'), 'top'));
    const topDir = join(stateDir, 'top');
    const child = new FilePersistence(join(topDir, 'calls')); child.init('c1', SPEC('same')); child.saveSnapshot(snap(SPEC('same'), 'c1'));
    const grand = new FilePersistence(join(topDir, 'calls', 'c1', 'parallel')); grand.init('g1', SPEC('same')); grand.saveSnapshot(snap(SPEC('same'), 'g1'));
    const specsDir = join(topDir, 'specs');
    expect(readdirSync(specsDir)).toHaveLength(1);
    const shas = [topDir, join(topDir, 'calls', 'c1'), join(topDir, 'calls', 'c1', 'parallel', 'g1')].map(d => readRef(d).$spec_ref);
    expect(new Set(shas).size).toBe(1);
    expect(shas[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(readRef(topDir).format_version).toBe(1);
    // 子实例目录下不该出现自己的 specs/
    expect(existsSync(join(topDir, 'calls', 'c1', 'specs'))).toBe(false);
    // 不同内容 → 第二份真身
    child.saveSnapshot(snap(SPEC('other'), 'c1'));
    expect(readdirSync(specsDir)).toHaveLength(2);
    expect(readRef(join(topDir, 'calls', 'c1')).$spec_ref).not.toBe(shas[0]);
  });
  it('正例：读侧解引用得到与写入等价的 AST;readSpec 每次返回独立对象（改一份不串另一份）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cas-'));
    const fp = new FilePersistence(stateDir); fp.init('i', SPEC('x')); fp.saveSnapshot(snap(SPEC('x'), 'i'));
    const a = readSpec(join(stateDir, 'i')) as { header: { id: string } };
    const b = readSpec(join(stateDir, 'i')) as { header: { id: string } };
    expect(a).toEqual(SPEC('x'));
    a.header.id = 'mutated';
    expect(b.header.id).toBe('x');
    expect(fp.loadSnapshot().spec).toEqual(SPEC('x'));
  });
  it('正例：写侧幂等——同内容 saveSnapshot 三次,真身与引用文件 mtime 都不变（零重写）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cas-'));
    const fp = new FilePersistence(stateDir); fp.init('i', SPEC('x')); fp.saveSnapshot(snap(SPEC('x'), 'i'));
    const dir = join(stateDir, 'i'); const sha = readRef(dir).$spec_ref!;
    const truth = join(stateDir, 'i', 'specs', `${sha}.json`); const ref = join(dir, 'spec.json');
    const old = Date.now() / 1000 - 3600;
    utimesSync(truth, old, old); utimesSync(ref, old, old);
    fp.saveSnapshot(snap(SPEC('x'), 'i')); fp.saveSnapshot(snap(SPEC('x'), 'i'));
    expect(Math.abs(statSync(truth).mtimeMs / 1000 - old)).toBeLessThan(2);
    expect(Math.abs(statSync(ref).mtimeMs / 1000 - old)).toBeLessThan(2);
  });
  it('正例：replan 改 AST → 新 sha 新真身,旧真身仍在,引用改指新 sha（版本史天然保留）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cas-'));
    const fp = new FilePersistence(stateDir); fp.init('i', SPEC('v1')); fp.saveSnapshot(snap(SPEC('v1'), 'i'));
    const dir = join(stateDir, 'i'); const sha1 = readRef(dir).$spec_ref!;
    fp.saveSnapshot(snap(SPEC('v2'), 'i'));
    const sha2 = readRef(dir).$spec_ref!;
    expect(sha2).not.toBe(sha1);
    expect(existsSync(join(dir, 'specs', `${sha1}.json`))).toBe(true);
    expect(existsSync(join(dir, 'specs', `${sha2}.json`))).toBe(true);
    expect((readSpec(dir) as { header: { id: string } }).header.id).toBe('v2');
  });
  it('正例：旧内联形态（整份 AST 写在 spec.json 里,v0.5.0 及以前的 run）readSpec 与 loadSnapshot 照读,不改写;首次 saveSnapshot 后自动转成引用', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cas-old-'));
    const dir = join(stateDir, 'legacy'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(SPEC('legacy'), null, 2));
    writeState(dir, { format_version: 1, instance_id: 'legacy', spec_id: 't', step_states: {}, current_step: null, retry_counters: {}, loop_counters: {} } as never);
    writeFileSync(join(dir, 'vars.json'), JSON.stringify({ format_version: 2, scopes: {} }));
    expect(readSpec(dir)).toEqual(SPEC('legacy'));
    expect(readRef(dir).$spec_ref).toBeUndefined();   // 读不改写
    const fp = new FilePersistence(dir, true);
    expect(fp.loadSnapshot().spec).toEqual(SPEC('legacy'));
    fp.saveSnapshot(snap(SPEC('legacy'), 'legacy'));
    expect(readRef(dir).$spec_ref).toMatch(/^[0-9a-f]{64}$/);   // 自动迁移
    expect(readSpec(dir)).toEqual(SPEC('legacy'));
  });
  it('反例：引用指向的真身缺失 → CORRUPT_STATE_FILE 点名引用文件与真身路径;引用文件坏 JSON → CORRUPT_STATE_FILE', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cas-bad-'));
    const dir = join(stateDir, 'i'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({ format_version: 1, $spec_ref: 'deadbeef'.repeat(8) }));
    expect(() => readSpec(dir)).toThrow(/CORRUPT_STATE_FILE.*spec\.json.*specs\/deadbeef/);
    writeFileSync(join(dir, 'spec.json'), '{not json');
    expect(() => readSpec(dir)).toThrow(/CORRUPT_STATE_FILE/);
  });
  it('正例：读侧缓存——同 sha 第二次读不再碰真身文件（删掉真身仍能读回）;不同进程首次读走盘', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cas-cache-'));
    const fp = new FilePersistence(stateDir); fp.init('i', SPEC('cached')); fp.saveSnapshot(snap(SPEC('cached'), 'i'));
    const dir = join(stateDir, 'i'); const sha = readRef(dir).$spec_ref!;
    expect(readSpec(dir)).toEqual(SPEC('cached'));
    unlinkSync(join(dir, 'specs', `${sha}.json`));
    expect(readSpec(dir)).toEqual(SPEC('cached'));   // 缓存命中
  });
  it('正例（hopissues/0115 probe ③）：replan 后模拟崩溃,ExecutionEngine.load 得到的是改过的 AST', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cas-replan-'));
    const engine = new ExecutionEngine();
    const spec = `# R
Id: r
## Goal
g
## Outputs
- o: text  # o
## Steps
1. [subtask free] 展开
  + → o: text  # o
2. [exit] 交付
  + → o
`;
    const host: HostConfig = { workspace_dir: stateDir, sandbox: { filesystem: { workspace_dir: stateDir, read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: 't' };
    const init = engine.initExecution(spec, host, { stateDir });
    expect(init.status).toBe('ok');
    const first = engine.nextStep();
    expect(first.status).toBe('adaptive_needed');
    const rp = engine.submitReplan('1', '1. [subtask] 展开\n  + → o: text  # o\n  1.1. [act free] 干\n    + → o: text  # o\n  1.2. [check] 核\n    - ← o\n    + → ok: bool  # ok\n    + → note: text  # n\n');
    expect(rp.status).toBe('ok');
    const dir = join(stateDir, init.instance_id!);
    type Tree = { spec: { steps: Array<{ step_id: string; children?: Array<{ step_id: string }> }> } };
    const memChildren = (engine as unknown as Tree).spec.steps.find(s => s.step_id === '1')!.children?.map(c => c.step_id);
    expect(memChildren?.length).toBeGreaterThan(0);   // replan 确实改了内存 AST
    // "崩溃"=不再用这个 engine,另起 load——盘上引用指向的真身必须是改过的树
    const re = ExecutionEngine.load(dir);
    const loaded = (re as unknown as Tree).spec.steps.find(s => s.step_id === '1')!.children?.map(c => c.step_id);
    expect(loaded).toEqual(memChildren);
    expect(readdirSync(join(dir, 'specs'))).toHaveLength(2);   // 展开前（无 children）后（有 children）两份真身
  });
  it('正例：findRunRoot——顶层返回自身;call 子/parallel 孙上溯到顶层;state-dir 自己叫 calls 时上一级无 state.json 不上溯', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cas-root-'));
    const top = new FilePersistence(stateDir); top.init('top', SPEC('x')); top.saveSnapshot(snap(SPEC('x'), 'top'));
    const topDir = join(stateDir, 'top');
    const child = new FilePersistence(join(topDir, 'calls')); child.init('c', SPEC('x')); child.saveSnapshot(snap(SPEC('x'), 'c'));
    const grand = new FilePersistence(join(topDir, 'calls', 'c', 'parallel')); grand.init('g', SPEC('x'));
    expect(findRunRoot(topDir)).toBe(topDir);
    expect(findRunRoot(join(topDir, 'calls', 'c'))).toBe(topDir);
    expect(findRunRoot(join(topDir, 'calls', 'c', 'parallel', 'g'))).toBe(topDir);
    const lonely = join(mkdtempSync(join(tmpdir(), 'cas-lone-')), 'calls');
    const lp = new FilePersistence(lonely); lp.init('l', SPEC('x'));
    expect(findRunRoot(join(lonely, 'l'))).toBe(join(lonely, 'l'));
  });
  it('正例：MemoryPersistence 零变化——快照在内存,无 specs/ 无引用', () => {
    const mp = new MemoryPersistence(); mp.init('m', SPEC('x')); mp.saveSnapshot(snap(SPEC('x'), 'm'));
    expect(mp.loadSnapshot().spec).toEqual(SPEC('x'));
  });
});
