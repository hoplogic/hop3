// @module: persistence ^anc-provider-persistence
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionEngine } from '../src/engine.js';
import { writeAtomic, writeState, readState, readVars, readSpec, flattenVars, FilePersistence, MemoryPersistence, writeChildParams, readChildParams } from '../src/persistence.js';
import type { HostConfig } from '../src/provider-types.js';
import { isWorkZonePath } from '../src/tools.js';

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

    it('branch with selection preserved on resume', () => {
      const engine = new ExecutionEngine();
      const init = engine.initExecution(BRANCH_SPEC, MINIMAL_HOST_CONFIG, { stateDir: tmpDir });
      if (init.status !== 'ok') return;
      const instanceDir = join(tmpDir, init.instance_id);

      engine.selectBranch('1', '1.1', 'test');

      // Resume
      const resumed = ExecutionEngine.recover(instanceDir);
      const next = resumed.nextStep();
      expect(next.status).toBe('step_ready');
      if (next.status !== 'step_ready') return;
      expect(next.step_id).toBe('1.1.1');
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

// 双形态注册回归（0086 补钉——0066:两消费点各吃原始/realpath 一种形态,只注册一种另一点失配）。
// @v: anc-exec-work-zone
describe('work_zone 根双形态注册（0086 补钉）', () => {
  it('正例：MemoryPersistence 建 work_zone 后,原始路径与 realpath 两形态写域判定都放行', () => {
    const mp = new MemoryPersistence();
    const wz = mp.getWorkZone();
    expect(isWorkZonePath(join(wz, 'x.txt'))).toBe(true);
    expect(isWorkZonePath(join(realpathSync(wz), 'x.txt'))).toBe(true);
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
