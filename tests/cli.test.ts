// @module: hop-cli ^anc-struct-hop-cli
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, readFileSync, existsSync, readdirSync, symlinkSync, realpathSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, dirname, win32 as pathWin32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ExecutionEngine, type EngineOptions } from '../src/engine.js';
import {
  resolveParam,
  resolveTextParam,
  resolveInstance,
  resolveFileArgBase,
  workerWorkZone,
  assertOutputInWorkZone,
  isPathInWorkZone,
  buildHostConfig,
  extractHopEnvIntoHostConfig,
  resolveContextMode,
  errorExit,
  program,
  setOutputJson, readProjectCommands,
} from '../src/cli.js';
import type { HostConfig } from '../src/provider-types.js';

const HOST: HostConfig = {
  workspace_dir: '/tmp/test',
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'test-key',
};

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const CLI = join(PROJECT_ROOT, 'dist', 'cli.js');

const SIMPLE_SPEC = `# CLI Test
Id: cli-test

## Goal
Test CLI commands

## Outputs
- result: text  # output

## Steps
1. [reason] Think
  + → result: text  # thinking
  > Think about it
`;

function runCli(args: string, cwd: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    // stdio pipe：错误路径用例故意触发 errorExit 的 stderr（INVALID_STATE/ENOENT 等），
    // execSync 默认把子进程 stderr 直通终端——混进测试输出像真报错，吓到装包跑测试的人。
    // 捕获进返回值（下方 catch 的 err.stderr），断言仍可用。
    const stdout = execSync(`node "${CLI}" --json ${args}`, {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOPJIT_ANTHROPIC_API_KEY: '' },
    });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? '').trim(),
      exitCode: err.status ?? 1,
    };
  }
}

function runCliJson(args: string, cwd: string): any {
  const { stdout, exitCode } = runCli(args, cwd);
  if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}: ${stdout}`);
  return JSON.parse(stdout);
}

function setupWorkDir(): { dir: string; specFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-e2e-'));
  const specFile = 'spec.md';
  writeFileSync(join(dir, specFile), SIMPLE_SPEC);
  return { dir, specFile };
}

// 构建已统一前置到 npm test（package.json："test": "build && vitest run"）——
// 原 beforeAll 内 clean+build 与并行测试文件产生 dist 竞态窗口（MODULE_NOT_FOUND 假红/旧 dist 假绿），
// 2026-08-07 codex 三轮 review P1 移除。裸跑 vitest 前请自行 npm run build。


// @v: anc-struct-hop-cli
describe('CLI subprocess tests', () => {
  describe('init', () => {
    // @v: anc-cli-dispatch, anc-cli-json-io
    it('initializes execution and returns ok with instance_id', () => {
      const { dir, specFile } = setupWorkDir();
      const result = runCliJson(`init ${specFile} --state-dir state`, dir);
      expect(result.status).toBe('ok');
      expect(result.instance_id).toBeTruthy();
    });


    it('passes params via --params JSON', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-e2e-'));
      const spec = `# Params Test
Id: params-test
## Goal
Test params
## Inputs
- source: text  # input
## Outputs
- result: text  # output
## Steps
1. [reason] Analyze
  - ← source
  + → result: text  # analysis
  > Analyze source
`;
      writeFileSync(join(dir, 'spec.md'), spec);
      const result = runCliJson(`init spec.md --state-dir state --params '{"source":"hello"}'`, dir);
      expect(result.status).toBe('ok');
    });

    // hopissues/0076——init 入口漏传 specPath/cliAbsPath（run 入口有）：跨目录 init 时
    // doc-ref 首级解析目录错位到 cwd（同目录知识文件报 P15 文件未找到）,嵌套 call 响应缺
    // call_protocol。两测各锁一半边。// @v: anc-cli-init-response, anc-exec-call-protocol-payload
    it('跨目录 init:doc-ref 从 spec 同目录解析成功（0076 正例——修前 16 条 P15 文件未找到）', () => {
      const specDir = mkdtempSync(join(tmpdir(), 'cli-e2e-specdir-'));
      const workDir = mkdtempSync(join(tmpdir(), 'cli-e2e-workdir-'));
      writeFileSync(join(specDir, 'knowledge.md'), '# 知识\n\n## 判据节\n\n内容在此。\n');
      const spec = `# DocRef Init Test
Id: docref-init-test
## Goal
Cross-dir init
## Steps
1. [reason] 分析
  + → out1: text  # 产出
  > 按判据分析。引擎已自动注入（doc-ref）：
  > [[knowledge#判据节]]
`;
      writeFileSync(join(specDir, 'spec.md'), spec);
      // 从独立 workDir 发起 init,spec 在别的目录——doc-ref 必须按 spec 同目录解析
      const result = runCliJson(`init ${join(specDir, 'spec.md')} --state-dir state-init`, workDir);
      expect(result.status).toBe('ok');
      expect(result.instance_id).toBeTruthy();
    });

    it('init 后嵌套 call 响应带 call_protocol（0076 正例——修前 buildCallProtocol 因两路径缺席返 undefined）', () => {
      const specDir = mkdtempSync(join(tmpdir(), 'cli-e2e-callproto-'));
      const workDir = mkdtempSync(join(tmpdir(), 'cli-e2e-callwork-'));
      writeFileSync(join(specDir, 'child.md'), `# Child
Id: child-spec
## Goal
child
## Inputs
- msg: text  # 入参
## Outputs
- echo: text  # 回声
## Steps
1. [reason] 回声
  - ← msg
  + → echo: text  # 回声
  > echo
`);
      writeFileSync(join(specDir, 'parent.md'), `# Parent
Id: parent-spec
## Goal
parent
## Steps
1. [reason] 备参
  + → msg: text  # 消息
  > prep
2. [call child-spec(msg: msg)] 调子
  + → echo: echo  # 收取
`);
      const initR = runCliJson(`init ${join(specDir, 'parent.md')} --state-dir state-cp`, workDir);
      expect(initR.status).toBe('ok');
      const inst = initR.instance_id;
      // 推进到步骤 1,交付产出,拿步骤 2(call)的响应
      runCliJson(`advance --state-dir state-cp --instance ${inst}`, workDir);
      const r2 = runCliJson(`submit_and_fetch_next 1 --output '{"msg":"hi"}' --state-dir state-cp --instance ${inst}`, workDir);
      expect(r2.step_id).toBe('2');
      // 修前:init 建的实例 call 响应无 call_protocol(两路径缺席);修后:载荷在场且 init_command 可执行形态
      expect(r2.call_protocol).toBeTruthy();
      expect(String(r2.call_protocol.init_command)).toContain('child');
    });

    // @v: anc-exec-state-persistence
    // 跨进程回归：params 必须随 init 落盘，另起进程读得到。
    // 历史 bug：params 在 initExecution 后才从 cli 外部 write，而 init 内部已 persist 一次，
    // 导致落盘 vars.json 不含 params；同进程单测因内存里 params 在而测不出，仅跨进程暴露。
    it('persists --params across process boundary (regression)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-e2e-'));
      const spec = `# Params Persist Test
Id: params-persist
## Goal
Test params persistence
## Inputs
- source: text  # input
## Outputs
- result: text  # output
## Steps
1. [reason] Analyze
  - ← source
  + → result: text  # analysis
  > Analyze source
`;
      writeFileSync(join(dir, 'spec.md'), spec);
      const init = runCliJson(`init spec.md --state-dir state --params '{"source":"hello"}'`, dir);
      expect(init.status).toBe('ok');

      // 另起进程读变量——验证 params 真的落盘
      const vars = runCliJson(`vars --state-dir state`, dir);
      expect(vars.variables.source).toBe('hello');

      // 另起进程取下一步——验证 params 进入了步骤上下文
      const next = runCliJson(`debug_step --state-dir state`, dir);
      expect(next.status).toBe('step_ready');
      expect(next.context.inputs.source).toBe('hello');
    });

    it('passes params via --params @file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-e2e-'));
      writeFileSync(join(dir, 'spec.md'), SIMPLE_SPEC);
      writeFileSync(join(dir, 'params.json'), '{"key":"value"}');
      const result = runCliJson(`init spec.md --state-dir state --params @params.json`, dir);
      expect(result.status).toBe('ok');
    });

    it('returns error for invalid spec', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-e2e-'));
      writeFileSync(join(dir, 'bad.md'), 'not a valid spec');
      const result = runCliJson(`init bad.md --state-dir state`, dir);
      expect(result.status).toBe('error');
    });
  });

  // @v: anc-cli-list, anc-cli-list-response
  describe('list', () => {
    const EXEC_SPEC = `# T\nId: t1\n## Goal\nDo a thing here. second sentence.\n## Steps\n1. [reason] x\n  + → r: text  # o\n  > go\n`;

    it('lists executable specs, returns id + goal first sentence', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-list-'));
      writeFileSync(join(dir, 'a.md'), EXEC_SPEC);
      const result = runCliJson(`list .`, dir);
      expect(result.status).toBe('ok');
      expect(result.specs).toHaveLength(1);
      expect(result.specs[0].file).toBe('a.md');
      expect(result.specs[0].id).toBe('t1');
      expect(result.specs[0].goal).toBe('Do a thing here');   // 首句（句号切分）
    });

    it('excludes non-executable: no goal, no steps, README', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-list-'));
      writeFileSync(join(dir, 'exec.md'), EXEC_SPEC);
      writeFileSync(join(dir, 'no-goal.md'), `# X\nId: x\n## Steps\n1. [reason] y\n  + → r: text  # o\n  > z\n`);
      writeFileSync(join(dir, 'no-steps.md'), `# Y\nId: y\n## Goal\njust a goal\n`);
      writeFileSync(join(dir, 'README.md'), `# Readme\n普通文档,无 Goal/Steps`);
      const result = runCliJson(`list .`, dir);
      expect(result.specs.map((s: any) => s.file)).toEqual(['exec.md']);
    });

    it('excludes design docs (@trace / ## impl)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-list-'));
      writeFileSync(join(dir, 'exec.md'), EXEC_SPEC);
      writeFileSync(join(dir, 'design-doc.md'), `%% @trace\n\tid: d\n%%\n# D\n## Goal\ng\n## Steps\n1. [reason] x\n  + → r: text  # o\n  > go\n`);
      writeFileSync(join(dir, 'impl-doc.md'), `# I\n## Goal\ng\n## Steps\n1. [reason] x\n  + → r: text  # o\n  > go\n## impl foo\nbar\n`);
      const result = runCliJson(`list .`, dir);
      expect(result.specs.map((s: any) => s.file)).toEqual(['exec.md']);
    });

    it('empty dir returns empty specs', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-list-'));
      const result = runCliJson(`list .`, dir);
      expect(result.status).toBe('ok');
      expect(result.specs).toEqual([]);
    });
  });

  describe('debug_step', () => {
    it('returns step_ready after init', () => {
      const { dir, specFile } = setupWorkDir();
      runCliJson(`init ${specFile} --state-dir state`, dir);
      const result = runCliJson(`debug_step --state-dir state`, dir);
      expect(result.status).toBe('step_ready');
      expect(result.step_id).toBe('1');
      expect(result.step_type).toBe('reason');
    });
  });

  describe('submit_and_fetch_next', () => {
    // 旧 done 返回 {status:ok} 不推进；新 submit_and_fetch_next 回写后自动推进。
    // SIMPLE_SPEC 只有 1 个 reason 步，提交后所有步骤终态 → 直接 completed。
    it('completes step and advances to completed', () => {
      const { dir, specFile } = setupWorkDir();
      runCliJson(`init ${specFile} --state-dir state`, dir);
      runCliJson(`debug_step --state-dir state`, dir);
      const result = runCliJson(`submit_and_fetch_next 1 --output '{"result":"answer"}' --state-dir state`, dir);
      expect(result.status).toBe('completed');
    });

    // submit 直接返回推进后的下一步,无需再调一次取下一步。
    it('reaches completed after submit', () => {
      const { dir, specFile } = setupWorkDir();
      runCliJson(`init ${specFile} --state-dir state`, dir);
      runCliJson(`debug_step --state-dir state`, dir);
      const result = runCliJson(`submit_and_fetch_next 1 --output '{"result":"answer"}' --state-dir state`, dir);
      expect(result.status).toBe('completed');
    });
    it('rejects --output and --answer together', () => {
      const { dir, specFile } = setupWorkDir();
      runCliJson(`init ${specFile} --state-dir state`, dir);
      runCliJson(`debug_step --state-dir state`, dir);
      const { exitCode, stdout } = runCli(
        `submit_and_fetch_next 1 --output '{"result":"a"}' --answer '{"result":"b"}' --state-dir state`,
        dir,
      );
      expect(exitCode).not.toBe(0);
    });
  });

  // @v: anc-exec-stale-resubmit —— CLI 层幂等重发回执（hopissues/0056 B 案:CLI submit 路由原
  // 手拼 completeStep+advanceToCaller 绕开 completeAndAdvance 的 ALREADY_DONE 短路——引擎层钉
  // 全绿而 CLI probe 借道 WAITING_WRITEBACK 的 failed 壳,直喂引擎的测试假绿实锤;本组从真 CLI
  // 进程起步。变异实证:CLI 路由改回手拼形态,下方 ok 钉转 failed 红）
// 幂等回执结构=CommandResponse 契约面(0086 审计:@v 直标补挂——结构断言即字段级钉)。 // @v: anc-cli-command-response
  describe('submit_and_fetch_next 幂等重发回执（0056,CLI 层）', () => {
    const THREE_SPEC = `# Three
Id: three-cli

## Goal
g

## Outputs
- 交付物: text  # d

## Steps
1. [act free] 一
  + → 甲: text  # a
2. [act free] 二
  - ← 甲
  + → 乙: text  # b
3. [act free] 三
  - ← 乙
  + → 交付物: text  # d
`;
    function setupThree(): { dir: string } {
      const dir = mkdtempSync(join(tmpdir(), 'cli-0056-'));
      writeFileSync(join(dir, 'three.md'), THREE_SPEC);
      return { dir };
    }

    it('正例：同值/无值重发 → status ok + ALREADY_DONE + 点名在等步 2,非 WAITING_WRITEBACK 的 failed 壳', () => {
      const { dir } = setupThree();
      runCliJson(`run three.md --state-dir state`, dir);
      runCliJson(`submit_and_fetch_next 1 --output '{"甲":"v1"}' --state-dir state`, dir);
      const same = runCliJson(`submit_and_fetch_next 1 --output '{"甲":"v1"}' --state-dir state`, dir);
      expect(same.status).toBe('ok');
      expect(same.code).toBe('ALREADY_DONE');
      expect(String(same.message)).toContain('幂等重发');
      expect(String(same.message)).toContain("'2'");
      const noOut = runCliJson(`submit_and_fetch_next 1 --state-dir state`, dir);
      expect(noOut.status).toBe('ok');
      expect(noOut.code).toBe('ALREADY_DONE');
    });

    it('正例：confirm 步 --answer 重发 → 同判 ok+ALREADY_DONE（review F5 补——与 --output 共享同一代码行〔raw = output ?? answer〕,钉住参数路径不分叉）', () => {
      const CONFIRM_SPEC = `# Confirm
Id: confirm-0056

## Goal
g

## Outputs
- r: text  # r

## Steps
1. [confirm] 批一下
  + → approved: bool  # 批
2. [act free] 干活
  - ← approved
  + → r: text  # r
`;
      const dir = mkdtempSync(join(tmpdir(), 'cli-0056a-'));
      writeFileSync(join(dir, 'c.md'), CONFIRM_SPEC);
      runCliJson(`run c.md --state-dir state`, dir);
      runCliJson(`submit_and_fetch_next 1 --answer '{"value":"approve"}' --state-dir state`, dir);
      const resend = runCliJson(`submit_and_fetch_next 1 --answer '{"value":"approve"}' --state-dir state`, dir);
      expect(resend.status).toBe('ok');
      expect(resend.code).toBe('ALREADY_DONE');
      expect(String(resend.message)).toContain('幂等重发');
    });

    it('边界：重发后照常交步 2/步 3 → completed,账面无污染（0056 probe 三判据的 CLI 形态）', () => {
      const { dir } = setupThree();
      runCliJson(`run three.md --state-dir state`, dir);
      runCliJson(`submit_and_fetch_next 1 --output '{"甲":"v1"}' --state-dir state`, dir);
      runCliJson(`submit_and_fetch_next 1 --state-dir state`, dir);   // 幂等重发一次
      const s2 = runCliJson(`submit_and_fetch_next 2 --output '{"乙":"v2"}' --state-dir state`, dir);
      expect(s2.status).toBe('step_ready');
      expect(s2.step_id).toBe('3');
      const end = runCliJson(`submit_and_fetch_next 3 --output '{"交付物":"v3"}' --state-dir state`, dir);
      expect(end.status).toBe('completed');
      expect(end.outputs?.['交付物']).toBe('v3');
    });
  });

  describe('submit_and_fetch_next --failure', () => {
    it('records failure and advances to terminal failed (single-step spec)', () => {
      const { dir, specFile } = setupWorkDir();
      runCliJson(`init ${specFile} --state-dir state`, dir);
      runCliJson(`debug_step --state-dir state`, dir);
      // 单步 spec 失败提交 → 引擎推进至终态 failed（无 subtask 兜底）
      const result = runCliJson(`submit_and_fetch_next 1 --failure "something broke" --state-dir state`, dir);
      expect(result.status).toBe('failed');
    });

    it('reaches failed after failure submit', () => {
      const { dir, specFile } = setupWorkDir();
      runCliJson(`init ${specFile} --state-dir state`, dir);
      runCliJson(`debug_step --state-dir state`, dir);
      const result = runCliJson(`submit_and_fetch_next 1 --failure "broke" --state-dir state`, dir);
      expect(result.status).toBe('failed');
    });
  });

  describe('status', () => {
    it('reports pending after init', () => {
      const { dir, specFile } = setupWorkDir();
      runCliJson(`init ${specFile} --state-dir state`, dir);
      const result = runCliJson(`status --state-dir state`, dir);
      expect(result.status).toBe('ok');
      expect(result.total_steps).toBe(1);
      expect(result.pending).toBe(1);
    });

    it('reports completed after submit', () => {
      const { dir, specFile } = setupWorkDir();
      runCliJson(`init ${specFile} --state-dir state`, dir);
      runCliJson(`debug_step --state-dir state`, dir);
      runCliJson(`submit_and_fetch_next 1 --output '{"result":"ok"}' --state-dir state`, dir);
      const result = runCliJson(`status --state-dir state`, dir);
      expect(result.execution_status).toBe('completed');
      expect(result.completed).toBe(1);
    });
  });

  describe('vars', () => {
    it('shows outputs after step completion', () => {
      const { dir, specFile } = setupWorkDir();
      runCliJson(`init ${specFile} --state-dir state`, dir);
      runCliJson(`debug_step --state-dir state`, dir);
      runCliJson(`submit_and_fetch_next 1 --output '{"result":"the answer"}' --state-dir state`, dir);
      const result = runCliJson(`vars --state-dir state`, dir);
      expect(result.status).toBe('ok');
      expect(result.variables['result']).toBe('the answer');
    });
  });

  describe('submit_and_fetch_next --branch', () => {
    it('selects branch case via CLI', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-e2e-'));
      const branchSpec = `# Branch
Id: branch-cli
## Goal
Test branch
## Inputs
- mode: text  # input
## Outputs
- out: text  # output
## Steps
1. [branch] Choose
  1.1. [case] {mode}==fast
    1.1.1. [reason] Fast
      + → out: text  # output
      > Go fast
  1.2. [case] {mode}==slow
    1.2.1. [reason] Slow
      + → out: text  # output
      > Go slow
`;
      writeFileSync(join(dir, 'spec.md'), branchSpec);
      runCliJson(`init spec.md --state-dir state --params '{"mode":"slow"}'`, dir);
      // 选 case 1.2 后引擎推进至该 case 的 reason 步骤 1.2.1（submit 直接返回下一步）
      const result = runCliJson(`submit_and_fetch_next 1 --branch 1.2 --reason "user chose slow" --state-dir state`, dir);
      expect(result.status).toBe('step_ready');
      expect(result.step_id).toBe('1.2.1');
    });
  });

  // @v: anc-exec-state-persistence
  // 跨进程 replan 回归——实证 bug 就在这:每个 CLI 命令是独立进程,replan 改的 AST 必须
  // 落到 spec.json 才能被下条命令 load 读到。此前 saveSnapshot 漏写 spec.json,replan
  // 跨进程丢失(内存对、落盘错),现有测试全同进程故漏检。本测试真实跨进程驱动一轮 replan。
// ReplanResponse 契约面跨进程钉(0086 审计:@v 直标补挂)。 // @v: anc-cli-replan-response
  describe('submit_and_fetch_next --replan (cross-process)', () => {
    const ADAPTIVE_SPEC = `# Adaptive CLI
Id: adaptive-cli
## Goal
Test cross-process replan persistence
## Outputs
- final_out: text  # output
## Steps
1. [subtask retry=2 adaptive] Adaptive task
  + → final_out: text  # aggregated
  1.1. [act] Original single step
    + → task_out: text  # output
`;

    it('persists replanned AST across CLI processes and resumes into new children', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-replan-'));
      writeFileSync(join(dir, 'spec.md'), ADAPTIVE_SPEC);

      // 进程1:run → 进入 subtask,停在 act 1.1(无 body=caller 介入点)
      const r0 = runCliJson(`run spec.md --state-dir state`, dir);
      expect(r0.status).toBe('step_ready');
      expect(r0.step_id).toBe('1.1');

      // 进程2:第1次失败 → 带反馈重跑(step_ready 1.1)
      const r1 = runCliJson(`submit_and_fetch_next 1.1 --failure "fail once" --state-dir state`, dir);
      expect(r1.status).toBe('step_ready');
      expect(r1.step_id).toBe('1.1');

      // 进程3:第2次失败 → adaptive_needed(subtask 1)
      const r2 = runCliJson(`submit_and_fetch_next 1.1 --failure "fail again" --state-dir state`, dir);
      expect(r2.status).toBe('adaptive_needed');
      expect(r2.subtask_id).toBe('1');
      expect(r2.spec_id).toBe('adaptive-cli');

      // 进程4:replan 换成 2 步结构(原来 1 步)——@file 走文本安全路径
      const replanMd = `1. [act] sniff then\n  + → mid: text  # m\n2. [act] parse with hint\n  - ← mid\n  + → final_out: text  # covers output\n`;
      writeFileSync(join(dir, 'replan.md'), replanMd);
      const r3 = runCliJson(`submit_and_fetch_next 1 --replan @replan.md --state-dir state`, dir);
      // replan 后引擎推进进入新 children 首步(act 1.1,无 body=caller 介入点)
      expect(r3.status).toBe('step_ready');
      expect(r3.step_id).toBe('1.1');

      // 关键断言:读落盘 spec.json——bug 时仍是原始 1 步,修复后是 replan 的 2 步
      const stateRoot = join(dir, 'state');
      const instId = r2.instance_id;
      const specJson = JSON.parse(readFileSync(join(stateRoot, instId, 'spec.json'), 'utf-8'));
      const sub = specJson.steps.find((s: any) => s.step_id === '1');
      expect(sub.children).toHaveLength(2);
      expect(sub.children.map((c: any) => c.step_id)).toEqual(['1.1', '1.2']);
    });

    // @v: anc-exec-stale-resubmit （改实档:原断言依赖"跳过 running 叶子推进"病灶语义,0049 修掉后改新契约——WAITING 后顺序交付）
    it('正例：--proactive 跨进程编辑未执行部分并持久化（review 缺口⑦——spec.json 落盘同型风险有 :341 先例注释;修前零 cli 例）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-proactive-'));
      writeFileSync(join(dir, 'spec.md'), ADAPTIVE_SPEC);
      const r0 = runCliJson(`run spec.md --state-dir state`, dir);
      expect(r0.step_id).toBe('1.1');
      // 不失败,直接主动编辑未执行部分(1.1 是 running——前缀原样保留)
      const md = `1. [act] Original single step\n  + → task_out: text  # output\n2. [act] appended by proactive edit\n  - ← task_out\n  + → final_out: text  # covers output\n`;
      writeFileSync(join(dir, 'edit.md'), md);
      const r1 = runCliJson(`submit_and_fetch_next 1 --replan @edit.md --proactive --state-dir state`, dir);
      // 0049 契约:running 叶子 1.1 在等回写,replan 编辑落盘后推进被拦——WAITING_WRITEBACK
      // 指路先交 1.1(原期望 step_ready 1.2 依赖"DFS 跳过 running 叶子"病灶语义,注释自供
      // "1.1 running 不重发…连续 nextStep 同样给 1.2"——那正是错位递交静默吞的入口)
      expect(r1.status).toBe('failed');
      expect(String(r1.failure_reason)).toContain('WAITING_WRITEBACK');
      // 跨进程读落盘 spec.json:编辑已持久化(2 步)——拦推进不拦编辑落盘
      const instId = r0.instance_id;
      const specJson = JSON.parse(readFileSync(join(dir, 'state', instId, 'spec.json'), 'utf-8'));
      const sub = specJson.steps.find((s: any) => s.step_id === '1');
      expect(sub.children).toHaveLength(2);
      expect(sub.children[1].summary).toContain('appended by proactive');
      // 依序交 1.1 → 新追加步 1.2 到场(编辑真实生效的行为面实证)
      const r2 = runCliJson(`submit_and_fetch_next 1.1 --output '{"task_out":"v"}' --state-dir state`, dir);
      expect(r2.status).toBe('step_ready');
      expect(r2.step_id).toBe('1.2');
    });

    // @v: anc-cli-abort + anc-exec-abort — abort 命令跨进程（复用模式真实消费面:逐命令新进程）
    it('正例：abort 跨进程——中止后 status=aborted,resume 墓碑拒（RUN_ABORTED）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-abort-'));
      writeFileSync(join(dir, 'spec.md'), ADAPTIVE_SPEC);
      const r0 = runCliJson(`run spec.md --state-dir state`, dir);
      expect(r0.step_id).toBe('1.1');
      const ra = runCliJson(`abort --reason 用户放弃 --state-dir state`, dir);
      expect(ra.status).toBe('ok');
      expect(ra.execution_status).toBe('aborted');
      expect(ra.abort_reason).toBe('用户放弃');
      // 新进程 status 如实
      const rs = runCliJson(`status --state-dir state`, dir);
      expect(rs.execution_status).toBe('aborted');
      // 新进程 resume 墓碑拒——终局不是暂停
      const rr = runCliJson(`resume --state-dir state`, dir);
      expect(rr.status).toBe('failed');
      expect(String(rr.failure_reason)).toContain('RUN_ABORTED');
    });

    it('反例：completed 实例 abort → ABORT_TERMINAL_CONFLICT（跨进程,事实不被意图覆盖）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-abort2-'));
      writeFileSync(join(dir, 'spec.md'), ADAPTIVE_SPEC);
      const r0 = runCliJson(`run spec.md --state-dir state`, dir);
      // @file 须在 work_zone 内且相对路径（^anc-cli-file-arg-safety 拒绝对路径）——写进实例 work_zone 再相对引用
      const wzRel = join('state', r0.instance_id, 'work_zone', 'o.json');
      writeFileSync(join(dir, wzRel), JSON.stringify({ task_out: 'v', final_out: 'done' }));
      const r1 = runCliJson(`submit_and_fetch_next 1.1 --output @${wzRel} --state-dir state`, dir);
      expect(r1.status).toBe('completed');
      const ra = runCliJson(`abort --state-dir state`, dir);
      expect(ra.status).toBe('error');
      expect(String(ra.message)).toContain('ABORT_TERMINAL_CONFLICT');
    });

    // @v: anc-exec-subtask-free-expand — 到步展开跨进程（复用模式真实消费面）
    it('正例：subtask free 到步展开跨进程——initial_plan 携上下文,提交展开物接续执行', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-sfree-'));
      writeFileSync(join(dir, 'spec.md'), `# F
Id: f
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [reason] 前面
  + → a: text  # p
2. [subtask free] 到步展开
  - ← a
  + → out: text  # o
`);
      const r0 = runCliJson(`run spec.md --state-dir state`, dir);
      expect(r0.step_id).toBe('1');
      const r1 = runCliJson(`submit_and_fetch_next 1 --output '{"a":"真产出"}' --state-dir state`, dir);
      expect(r1.status).toBe('adaptive_needed');
      expect(r1.reason).toBe('initial_plan');
      expect(r1.expansion_context).toEqual({ a: '真产出' });
      // 新进程提交展开物
      const wz = join('state', r0.instance_id, 'work_zone', 'plan.md');
      writeFileSync(join(dir, wz), '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n');
      const r2 = runCliJson(`submit_and_fetch_next 2 --replan @${wz} --state-dir state`, dir);
      expect(r2.status).toBe('step_ready');
      expect(r2.step_id).toBe('2.1');
    });

    it('正例：expansion_max 超限跨进程——拒携指引,--extend-expansion 重交放行（耗尽不硬烧,2026-08-29 作者定）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-sfree-ext-'));
      writeFileSync(join(dir, 'spec.md'), `# F
Id: f
## Goal
g
## Config
expansion_max: 1
## Outputs
- out: text  # o
## Steps
1. [reason] 前面
  + → a: text  # p
2. [subtask free] 到步展开
  - ← a
  + → out: text  # o
`);
      const r0 = runCliJson(`run spec.md --state-dir state`, dir);
      runCliJson(`submit_and_fetch_next 1 --output '{"a":"真产出"}' --state-dir state`, dir);
      // 底账直置 1（达限）——跨进程改 state.json（搭真嵌套展开链成本高,引擎侧另有逐次断言）
      const stPath = join(dir, 'state', r0.instance_id, 'state.json');
      const st = JSON.parse(readFileSync(stPath, 'utf-8'));
      st.expansion_count = 1;
      writeFileSync(stPath, JSON.stringify(st));
      const wz = join('state', r0.instance_id, 'work_zone', 'plan.md');
      writeFileSync(join(dir, wz), '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n\n');
      // 无授权:拒且报文携续批指引
      const rj = runCliJson(`submit_and_fetch_next 2 --replan @${wz} --state-dir state`, dir);
      expect(rj.status).toBe('error');
      expect(JSON.stringify(rj.errors)).toContain('EXPANSION_LIMIT');
      expect(JSON.stringify(rj.errors)).toContain('extend-expansion');
      // 携授权:放行
      const ok = runCliJson(`submit_and_fetch_next 2 --replan @${wz} --extend-expansion --state-dir state`, dir);
      expect(ok.status).toBe('step_ready');
      expect(ok.step_id).toBe('2.1');
    });

    // @v: anc-rule-narrative-sections — 内容章节缺省供给跨进程（L2-spec 稳定面）
    it('正例：内容章节跨进程注入 spec_knowledge_context,(不供给)节排除', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-ns-'));
      writeFileSync(join(dir, 'spec.md'), `# NS
Id: ns
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [reason] 干
  + → out: text  # o

## 背景
口径XYZ

## 处置记录(不供给)
- 流水
`);
      const r0 = runCliJson(`run spec.md --state-dir state`, dir);
      const sk = r0.context?.spec_knowledge_context ?? '';
      expect(sk).toContain('口径XYZ');
      expect(sk).toContain('本文件《背景》');
      expect(sk).not.toContain('流水');
    });

    it('正例：--replan 提交子编号自然形态（1.1.——驱动侧 LLM 沿用原步骤号）→ CLI 侧归一后照常接受（P2-2 裁定 A:两模式同一宽容度;修前 parse 拒 references non-existent parent）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-replan-flat-'));
      writeFileSync(join(dir, 'spec.md'), ADAPTIVE_SPEC);
      const r0 = runCliJson(`run spec.md --state-dir state`, dir);
      expect(r0.step_id).toBe('1.1');
      runCliJson(`submit_and_fetch_next 1.1 --failure "fail once" --state-dir state`, dir);
      const r2 = runCliJson(`submit_and_fetch_next 1.1 --failure "fail again" --state-dir state`, dir);
      expect(r2.status).toBe('adaptive_needed');
      // 驱动侧自然形态:沿用原步骤号 1.1.（修前经 CLI 直达 engine.submitReplan 被 parse 拒）
      const replanMd = `1.1. [act] retry with new format\n  + → final_out: text  # covers output\n`;
      writeFileSync(join(dir, 'replan.md'), replanMd);
      const r3 = runCliJson(`submit_and_fetch_next 1 --replan @replan.md --state-dir state`, dir);
      expect(r3.status).toBe('step_ready');                      // 归一后接受,推进新 children
      expect(r3.step_id).toBe('1.1');
    });
  });

  describe('resume', () => {
    it('resumes from persisted state', () => {
      const { dir, specFile } = setupWorkDir();
      runCliJson(`init ${specFile} --state-dir state`, dir);
      // resume = recover + advanceToCaller → 推进到首个 caller 介入点（单步 spec 的 reason）
      const result = runCliJson(`resume --state-dir state`, dir);
      expect(result.status).toBe('step_ready');
      expect(result.step_id).toBe('1');
    });
  });

  describe('error handling', () => {
    it('exits non-zero for missing state directory', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-e2e-'));
      const { exitCode } = runCli(`debug_step --state-dir nonexistent`, dir);
      expect(exitCode).not.toBe(0);
    });

    it('exits non-zero for missing spec file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-e2e-'));
      const { exitCode } = runCli(`init missing.md --state-dir state`, dir);
      expect(exitCode).not.toBe(0);
    });
  });
});

// Direct import tests — these run inside vitest and count toward coverage
describe('CLI function unit tests (coverage)', () => {
  beforeAll(() => setOutputJson(true));
  describe('resolveParam', () => {
    it('returns undefined for empty value', () => {
      expect(resolveParam(undefined)).toBeUndefined();
      expect(resolveParam('')).toBeUndefined();
    });

    it('parses inline JSON', () => {
      expect(resolveParam('{"key":"value"}')).toEqual({ key: 'value' });
    });

    it('reads @file reference', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-rp-'));
      writeFileSync(join(dir, 'data.json'), '{"x":1}');
      const origCwd = process.cwd();
      process.chdir(dir);
      try {
        expect(resolveParam('@data.json')).toEqual({ x: 1 });
      } finally {
        process.chdir(origCwd);
      }
    });

  });

  describe('resolveTextParam', () => {
    it('returns undefined for empty value', () => {
      expect(resolveTextParam(undefined)).toBeUndefined();
    });

    it('returns plain text as-is', () => {
      expect(resolveTextParam('hello world')).toBe('hello world');
    });

    it('reads @file as text', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-rtp-'));
      writeFileSync(join(dir, 'note.txt'), 'some text');
      const origCwd = process.cwd();
      process.chdir(dir);
      try {
        expect(resolveTextParam('@note.txt')).toBe('some text');
      } finally {
        process.chdir(origCwd);
      }
    });
  });

  // @v: anc-cli-parallel-file-isolation
  // 回归：并行 worker 共享 cwd 时固定 @file 名竞态（实证 bug：6 页并行 s3 丢失/s5-s6 串台）。
  // 修复：worker 子实例的裸文件名重定向到各自 work_zone，碰撞结构上不可能。
  describe('parallel worker 裸 @file 隔离', () => {
    it('workerWorkZone: --instance 含 /parallel/ 时返回 child work_zone，否则 undefined', () => {
      expect(workerWorkZone('/s/inst/parallel/4.3.1', 'inst/parallel/4.3.1'))
        .toBe(join('/s/inst/parallel/4.3.1', 'work_zone'));
      expect(workerWorkZone('/s/inst', 'inst')).toBeUndefined();
      expect(workerWorkZone('/s/inst', undefined)).toBeUndefined();
    });

    it('resolveFileArgBase: 裸文件名重定向到 work_zone，绝对路径/含 / 的相对路径不变', () => {
      const workZone = '/s/inst/parallel/4.3.1/work_zone';
      // 裸名 → 重定向
      expect(resolveFileArgBase('_w.json', workZone)).toBe(join(workZone, '_w.json'));
      // 含 / 的相对路径 → 尊重 driver 显式意图（不重定向，走 resolve）
      expect(resolveFileArgBase('sub/_w.json', workZone)).toBe(resolve('sub/_w.json'));
      // 绝对路径 → 原样
      expect(resolveFileArgBase('/abs/_w.json', workZone)).toBe(resolve('/abs/_w.json'));
      // 无 work_zone base（非 worker）→ 走 cwd resolve
      expect(resolveFileArgBase('_w.json', undefined)).toBe(resolve('_w.json'));
    });

    it('两个 worker 用同名 _w.json 不串台（核心回归）', () => {
      const root = mkdtempSync(join(tmpdir(), 'cli-race-'));
      // 模拟两个 child 各自的 work_zone
      const s1 = join(root, 'inst/parallel/4.3.1/work_zone');
      const s2 = join(root, 'inst/parallel/4.3.2/work_zone');
      mkdirSync(s1, { recursive: true });
      mkdirSync(s2, { recursive: true });
      // 两 worker 都写裸名 _w.json，但落各自 work_zone
      writeFileSync(join(s1, '_w.json'), '{"slide":"page1"}');
      writeFileSync(join(s2, '_w.json'), '{"slide":"page2"}');
      // 用各自 workZoneBase 解析同一裸名 → 拿到各自内容，不串台
      expect(resolveParam('@_w.json', s1)).toEqual({ slide: 'page1' });
      expect(resolveParam('@_w.json', s2)).toEqual({ slide: 'page2' });
    });

    // @v: anc-cli-file-arg-safety
    // 提交越界校验：--output @<path> 越界（/tmp 等）→ 拒绝提交（errorExit）。防串台第三重（引擎硬拦）。
    it('assertOutputInWorkZone: 越界路径拒绝、work_zone 内通过', () => {
      const instanceDir = '/s/inst/parallel/4.3.5';
      const workZone = join(instanceDir, 'work_zone');
      // mock process.exit → 抛错捕获（errorExit 内部调 process.exit）
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`EXIT:${c}`); }) as never);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        // 越界：/tmp 绝对路径 → 拒绝
        expect(() => assertOutputInWorkZone('@/tmp/out.json', instanceDir)).toThrow(/EXIT/);
        // 越界：兄弟 child 的 work_zone → 拒绝
        expect(() => assertOutputInWorkZone('@/s/inst/parallel/4.3.9/work_zone/out.json', instanceDir)).toThrow(/EXIT/);
        // 界内：本 work_zone 下确切路径 → 通过（不 exit）
        expect(() => assertOutputInWorkZone(`@${join(workZone, 'out_4.3.1.1.json')}`, instanceDir)).not.toThrow();
        // 裸名（worker 重定向到 work_zone）→ 通过
        expect(() => assertOutputInWorkZone('@out.json', instanceDir, workZone)).not.toThrow();
        // 内联 JSON（非 @file）→ 免校验
        expect(() => assertOutputInWorkZone('{"x":1}', instanceDir)).not.toThrow();
      } finally {
        exitSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });
  });

  // @v: anc-cli-instance-resolve
  describe('resolveInstance', () => {
    it('returns direct path when instanceId provided', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-ri-'));
      mkdirSync(join(dir, 'my-instance'));   // 在场校验落地后,显式号必须真实存在（^anc-cli-instance-resolve）
      writeFileSync(join(dir, 'my-instance', 'state.json'), '{}');   // 三档语义后,裸空目录=半初始化档（0059）——完整实例须 state.json 在场
      const result = resolveInstance(dir, 'my-instance');
      expect(result).toBe(join(dir, 'my-instance'));
    });

    it('finds most recent instance directory', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-ri-'));
      mkdirSync(join(dir, 'old-instance'));
      // Small delay to ensure different mtime
      mkdirSync(join(dir, 'new-instance'));
      writeFileSync(join(dir, 'new-instance', 'marker'), '');
      const result = resolveInstance(dir);
      expect(result).toBe(join(dir, 'new-instance'));
    });

    it('throws when no instances found', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-ri-'));
      expect(() => resolveInstance(dir)).toThrow('No instances found');
    });

    // @v: anc-cli-instance-resolve — 显式实例号在场校验（2026-09-01 live:core codex:parallel 实撞:
    // driver 手抄实例号丢一字符,缺校验时错号走到 persistence 读 spec.json 撞 ENOENT 报
    // CORRUPT_STATE_FILE"状态文件损坏"——两种病一张脸,收报文的人不会想到是号抄错了）
    it('正例：显式实例号不存在 → INSTANCE_NOT_FOUND 且报文列真实存在的实例号指路', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-ri-'));
      mkdirSync(join(dir, 'real-instance-aaa'));
      mkdirSync(join(dir, 'real-instance-bbb'));
      expect(() => resolveInstance(dir, 'typo-instance')).toThrow(/INSTANCE_NOT_FOUND.*typo-instance/);
      expect(() => resolveInstance(dir, 'typo-instance')).toThrow(/real-instance-(aaa|bbb)/);   // 指路:真实实例名在报文里
    });

    it('正例：state_dir 下无任何实例时报文如实说空,不指认不存在的实例', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-ri-'));
      expect(() => resolveInstance(dir, 'whatever')).toThrow(/INSTANCE_NOT_FOUND.*无任何实例/);
    });

    it('正例：指路列表按 mtime 新前旧后排序（review 面三探针 P4 抓零锁后补）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-ri-'));
      mkdirSync(join(dir, 'older-one'));
      const past = new Date(Date.now() - 60_000);
      utimesSync(join(dir, 'older-one'), past, past);
      mkdirSync(join(dir, 'newer-one'));
      let msg = '';
      try { resolveInstance(dir, 'typo'); } catch (e) { msg = (e as Error).message; }
      expect(msg.indexOf('newer-one')).toBeGreaterThan(-1);
      expect(msg.indexOf('newer-one')).toBeLessThan(msg.indexOf('older-one'));   // 新在前
    });

    it('正例：超过 5 个实例时指路恰列 5 个（上限值直接断言,review 面三缺口）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-ri-'));
      for (let i = 0; i < 6; i++) mkdirSync(join(dir, `inst-${i}`));
      let msg = '';
      try { resolveInstance(dir, 'typo'); } catch (e) { msg = (e as Error).message; }
      expect((msg.match(/inst-\d/g) ?? []).length).toBe(5);
    });

    it('正例：state_dir 本身不可读时报文如实说且主错误仍是 INSTANCE_NOT_FOUND（指路失败不掩主错误,5.3 打回补）', () => {
      const asFile = join(mkdtempSync(join(tmpdir(), 'cli-ri-')), 'not-a-dir');
      writeFileSync(asFile, 'plain file');   // state_dir 位置是个文件——readdirSync 必炸
      let msg = '';
      try { resolveInstance(asFile, 'whatever'); } catch (e) { msg = (e as Error).message; }
      expect(msg).toContain('INSTANCE_NOT_FOUND');
      expect(msg).toContain('state_dir 本身不可读');
    });

    it('反例：省略实例号且 state_dir 不存在 → 仍走既有报错,不误报 INSTANCE_NOT_FOUND（校验只在显式分支）', () => {
      const missing = join(tmpdir(), 'cli-ri-definitely-missing-' + Date.now());
      let msg = '';
      try { resolveInstance(missing); } catch (e) { msg = (e as Error).message; }
      expect(msg).not.toContain('INSTANCE_NOT_FOUND');   // 省略分支不吃新校验
    });

    it('反例：目录在而 spec.json 损坏 → 仍 CORRUPT_STATE_FILE（语义收纯不误迁——目录在文件坏是它的地盘）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-ri-'));
      const inst = join(dir, 'broken-instance');
      mkdirSync(inst);
      writeFileSync(join(inst, 'spec.json'), '{not valid json');
      writeFileSync(join(inst, 'state.json'), '{"format_version":1,"step_states":{}}');
      writeFileSync(join(inst, 'vars.json'), '{"format_version":2,"scopes":{}}');
      const resolved = resolveInstance(dir, 'broken-instance');   // 目录在,解析放行
      expect(resolved).toBe(inst);
      expect(() => ExecutionEngine.load(resolved)).toThrow(/CORRUPT_STATE_FILE/);   // 损坏归 load 层报
    });
  });

  describe('buildHostConfig', () => {
    it('returns host config with current cwd', () => {
      const config = buildHostConfig();
      expect(config.workspace_dir).toBe(process.cwd());
      expect(config.sandbox.filesystem.workspace_dir).toBe('.');
    });
  });

  // @v: anc-config-hop-env, anc-exec-doc-ref-hop-env —— 复用模式组合根:params 摘出 hop_env
  describe('extractHopEnvIntoHostConfig（复用模式组合根）', () => {
    it('正例：hop_env_* 键摘出入 HostConfig,业务 params 保留', () => {
      const hc = buildHostConfig();
      const params: Record<string, unknown> = { hop_env_kb_root: '/kb', business: 'x' };
      extractHopEnvIntoHostConfig(hc, params);
      expect(hc.hop_env?.hop_env_kb_root).toBe('/kb');
      expect(params['hop_env_kb_root']).toBeUndefined();
      expect(params['business']).toBe('x');
    });

    // 凭证禁入三级闸之 params 级（0004,复用模式半边——errorExit 经 process.exit,mock 探）
    it('反例：params 带凭证形态 hop_env 键 → errorExit 拒且指路（0004）', () => {
      const hc = buildHostConfig();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`EXIT:${c}`); }) as never);
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(() => extractHopEnvIntoHostConfig(hc, { hop_env_db_secret: 's3cret' })).toThrow(/EXIT:1/);
        const stderr = errSpy.mock.calls.map(c => String(c[0])).join('');
        expect(stderr).toContain('HOP_ENV_CREDENTIAL_REJECTED');
        expect(stderr).toContain('api_key_env');
        expect(JSON.stringify(hc.hop_env ?? {})).not.toContain('s3cret');   // 表未污染
      } finally { exitSpy.mockRestore(); errSpy.mockRestore(); }
    });

    it('正例：keyring_path 类含 key 非尾锚定 → 放行（口径=尾锚定,0004 裁定）', () => {
      const hc = buildHostConfig();
      extractHopEnvIntoHostConfig(hc, { hop_env_keyring_path: '/kr' });
      expect(hc.hop_env?.hop_env_keyring_path).toBe('/kr');
    });

    it('正例：绝对路径声明根自动扩 sandbox read allowed（写参即授权）', () => {
      const hc = buildHostConfig();
      extractHopEnvIntoHostConfig(hc, { hop_env_kb: '/abs/kb' });
      expect(hc.sandbox.filesystem.read_access.allowed).toContain('/abs/kb');
    });

    it('反例：相对路径值不扩白名单（workspace 内本就可读）', () => {
      const hc = buildHostConfig();
      const before = hc.sandbox.filesystem.read_access.allowed.length;
      extractHopEnvIntoHostConfig(hc, { hop_env_sub: 'docs/kb' });
      expect(hc.sandbox.filesystem.read_access.allowed.length).toBe(before);
    });

    it('反例：无 hop_env_* 键零变化;params undefined 不崩（基线=恒含 hop_env_language 打底,^anc-i18n-language-config）', () => {
      const hc = buildHostConfig();
      extractHopEnvIntoHostConfig(hc, { plain: 1 });
      expect(hc.hop_env).toEqual({ hop_env_language: 'en' });   // 打底键在,业务键零混入
      extractHopEnvIntoHostConfig(hc, undefined);
      expect(hc.hop_env).toEqual({ hop_env_language: 'en' });
    });

    it('反例：非字符串值丢弃不入表（环境参数是字符串键值;打底键不受影响）', () => {
      const hc = buildHostConfig();
      extractHopEnvIntoHostConfig(hc, { hop_env_n: 42 });
      expect(hc.hop_env).toEqual({ hop_env_language: 'en' });   // 42 被丢,打底键独存
    });

    it('正例：params 显式 hop_env_language 覆盖打底值（覆盖链后到覆盖,^anc-i18n-language-config）', () => {
      const hc = buildHostConfig();
      extractHopEnvIntoHostConfig(hc, { hop_env_language: 'zh' });
      expect(hc.hop_env?.hop_env_language).toBe('zh');
    });
  });

  // @v: anc-cli-pack, anc-cli-install-skill —— 进程内跑法（子进程 e2e 不进覆盖率统计）
  describe('lang 命令备份与拒写回（^anc-i18n-language-config 转换工具契约——阅卷抓零自动化测试补）', () => {
    // @v: anc-i18n-language-config
    const GOOD = '# Spec: cvt\nId: cvt\n\n## Steps\n1. [act free] do\n  + → o: text\n2. [check final] gate\n  - ← o\n  + → ok: bool  # g\n  + → note: text  # w\n';

    function capture() {
      const orig = process.stdout.write.bind(process.stdout);
      let buf = '';
      process.stdout.write = ((c: string) => { buf += c; return true; }) as never;
      return { get: () => buf, restore: () => { process.stdout.write = orig; } };
    }

    it('正：备份文件在场且内容=原件;再转一次(已是目标语言)零改动零备份', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-i18n-'));
      const f = join(dir, 's.md');
      writeFileSync(f, GOOD, 'utf-8');
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'lang', f, '--to', 'zh']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.backup).toBeTruthy();
      expect(existsSync(r.backup)).toBe(true);
      expect(readFileSync(r.backup, 'utf-8')).toBe(GOOD);            // 备份=原件逐字节
      expect(readFileSync(f, 'utf-8')).toContain('[探索 开放]');       // 原路径已是中文
      // 幂等面：已是目标语言 → 零改动零备份
      const cap2 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'lang', f, '--to', 'zh']);
      } finally { cap2.restore(); }
      const r2 = JSON.parse(cap2.get().trim().split('\n').pop()!);
      expect(r2.changed_lines).toBe(0);
      expect(r2.backup).toBeNull();
    });

    it('反：坏 --to 参数响亮拒(exit 非 0),原件字节不动零备份', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-i18n-bad-'));
      const f = join(dir, 's.md');
      writeFileSync(f, GOOD, 'utf-8');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`EXIT:${c}`); }) as never);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await expect(program.parseAsync(['node', 'hopjit', '--json', 'lang', f, '--to', 'fr'])).rejects.toThrow(/EXIT/);
      } finally { exitSpy.mockRestore(); stderrSpy.mockRestore(); }
      expect(readFileSync(f, 'utf-8')).toBe(GOOD);                    // 原件不动
      expect(readdirSync(dir).filter(n => n.includes('.bak.'))).toHaveLength(0);   // 零备份
    });

    it('正：原件既有 parse 错不背锅——errors 数不变即放行(基线对照律;拒写回支是防词表改坏的绊线,双语恒等价下正确词表不可达,绊线真咬由变异实证锁——见变异凭证)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-i18n-sick-'));
      const f = join(dir, 'sick.md');
      // 原件坏(无标题):before errors=N,关键词转换不改变 parse 错误 → after=N → 放行
      writeFileSync(f, 'Id: x\n\n## Steps\n1. [act free] do\n  + → o: text\n', 'utf-8');
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'lang', f, '--to', 'zh']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');   // 既有病不背锅,不新增即放行
    });
  });

  describe('pack/install-skill via parseAsync (coverage-visible)', () => {
    const REPO = resolve(__dirname, '..');
    function capture(): { get: () => string; restore: () => void } {
      const orig = process.stdout.write;
      let buf = '';
      process.stdout.write = ((c: string) => { buf += c; return true; }) as any;
      return { get: () => buf, restore: () => { process.stdout.write = orig; } };
    }

    it('pack in-process：产物齐 + 版本可见性字段', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-ip-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(REPO, 'examples/doc-review.md'), '--dir', join(dir, 'sk'), '--force']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.skill_name).toBe('doc-review');
      expect(existsSync(join(dir, 'sk/doc-review/spec.md'))).toBe(true);
    });

    it('pack in-process：坏 spec 走 error 路径', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-ip-bad-'));
      writeFileSync(join(dir, 'bad.md'), '# Spec: 坏\nGoal: 无步骤\n');
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(dir, 'bad.md'), '--dir', join(dir, 'sk')]);
      } finally { cap.restore(); process.exitCode = 0; }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('error');
    });

    it('install-skill 缺省目录：CC 零参数装到 ~/.claude/skills（正例,2026-08-11 作者定）', async () => {
      // HOME 指到临时目录——homedir() 随 HOME（POSIX），不真写用户目录
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-is-home-'));
      const origHome = process.env.HOME;
      const origCfgDir = process.env.CLAUDE_CONFIG_DIR;
      const origCodexHome = process.env.CODEX_HOME;
      process.env.HOME = fakeHome;
      delete process.env.CLAUDE_CONFIG_DIR;   // cfuse 环境该变量重定向 home,测试隔离须同清
      delete process.env.CODEX_HOME;
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        if (origCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = origCfgDir;
        if (origCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = origCodexHome;
      }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.target).toBe(join(fakeHome, '.claude', 'skills'));
      expect(existsSync(join(fakeHome, '.claude/skills/hopspec/SKILL.md'))).toBe(true);
    });

    // @v: anc-cli-carrier-home-resolution —— cfuse 内置载体适配（2026-09-02）
    // cfuse-cc:固定 ~/.codefuse/engine/cc/skills,复用 CC driver 源（references/driver-subagent.md 在,无 agents/）
    it('install-skill --carrier cfuse-cc 装到 ~/.codefuse/engine/cc/skills 且走 CC driver 源（正例）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-cfuse-cc-'));
      const origHome = process.env.HOME;
      const origCfgDir = process.env.CLAUDE_CONFIG_DIR;
      const origCodexHome = process.env.CODEX_HOME;
      process.env.HOME = fakeHome;
      delete process.env.CLAUDE_CONFIG_DIR;   // cfuse-cc 不读环境变量——清掉确保固定路径生效
      delete process.env.CODEX_HOME;
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--carrier', 'cfuse-cc', '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        if (origCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = origCfgDir;
        if (origCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = origCodexHome;
      }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.carrier).toBe('cfuse-cc');
      expect(r.target).toBe(join(fakeHome, '.codefuse', 'engine', 'cc', 'skills'));
      expect(existsSync(join(fakeHome, '.codefuse/engine/cc/skills/hopspec/SKILL.md'))).toBe(true);
      // 复用 CC driver 源:references 含 driver-subagent.md（CC 专属）,无 agents/（codex 专属）
      expect(existsSync(join(fakeHome, '.codefuse/engine/cc/skills/hopspec/references/driver-subagent.md'))).toBe(true);
      expect(existsSync(join(fakeHome, '.codefuse/engine/cc/skills/hopspec/agents'))).toBe(false);
    });

    // cfuse-codex:固定 ~/.codefuse/engine/codex/skills,复用 codex driver 源（agents/segment-driver.md 在）
    it('install-skill --carrier cfuse-codex 装到 ~/.codefuse/engine/codex/skills 且走 codex driver 源（正例）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-cfuse-codex-'));
      const origHome = process.env.HOME;
      const origCfgDir = process.env.CLAUDE_CONFIG_DIR;
      const origCodexHome = process.env.CODEX_HOME;
      process.env.HOME = fakeHome;
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CODEX_HOME;
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--carrier', 'cfuse-codex', '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        if (origCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = origCfgDir;
        if (origCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = origCodexHome;
      }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.carrier).toBe('cfuse-codex');
      expect(r.target).toBe(join(fakeHome, '.codefuse', 'engine', 'codex', 'skills'));
      expect(existsSync(join(fakeHome, '.codefuse/engine/codex/skills/hopspec/SKILL.md'))).toBe(true);
      // 复用 codex driver 源:有 agents/segment-driver.md（codex 专属）
      expect(existsSync(join(fakeHome, '.codefuse/engine/codex/skills/hopspec/agents/segment-driver.md'))).toBe(true);
    });

    // cc 载体读 CLAUDE_CONFIG_DIR:在场装到重定向 home（cfuse 会话内自动适配场景）
    it('install-skill --carrier cc 读 CLAUDE_CONFIG_DIR 装到重定向 home（正例:cfuse 会话内自动适配）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-cc-redir-'));
      const origHome = process.env.HOME;
      const origCfgDir = process.env.CLAUDE_CONFIG_DIR;
      const origCodexHome = process.env.CODEX_HOME;
      process.env.HOME = fakeHome;
      delete process.env.CODEX_HOME;
      process.env.CLAUDE_CONFIG_DIR = join(fakeHome, 'custom-cc-home');   // 模拟 cfuse 重定向
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        if (origCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = origCfgDir;
        if (origCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = origCodexHome;
      }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.target).toBe(join(fakeHome, 'custom-cc-home', 'skills'));
      expect(existsSync(join(fakeHome, 'custom-cc-home/skills/hopspec/SKILL.md'))).toBe(true);
    });

    // codex 载体读 CODEX_HOME:在场装到重定向 home
    it('install-skill --carrier codex 读 CODEX_HOME 装到重定向 home（正例）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-codex-redir-'));
      const origHome = process.env.HOME;
      const origCfgDir = process.env.CLAUDE_CONFIG_DIR;
      const origCodexHome = process.env.CODEX_HOME;
      process.env.HOME = fakeHome;
      delete process.env.CLAUDE_CONFIG_DIR;
      process.env.CODEX_HOME = join(fakeHome, 'custom-codex-home');
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--carrier', 'codex', '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        if (origCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = origCfgDir;
        if (origCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = origCodexHome;
      }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.target).toBe(join(fakeHome, 'custom-codex-home', 'skills'));
      expect(existsSync(join(fakeHome, 'custom-codex-home/skills/hopspec/SKILL.md'))).toBe(true);
    });

    // @v: anc-cli-install-skill-plus —— --plus 附装进阶研究件+工具配置落位（2026-08-30 作者定）
    it('正例：--plus 装 hop-fact-check/hop-deep-research 两 skill + tool_servers 并入 ~/.hopjit/config.yaml', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-plus-home-'));
      const origHome = process.env.HOME;
      const origCfgDir = process.env.CLAUDE_CONFIG_DIR;
      const origCodexHome = process.env.CODEX_HOME;
      process.env.HOME = fakeHome;
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CODEX_HOME;
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--plus', '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        if (origCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = origCfgDir;
        if (origCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = origCodexHome;
      }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(existsSync(join(fakeHome, '.claude/skills/hop-fact-check/SKILL.md'))).toBe(true);
      expect(existsSync(join(fakeHome, '.claude/skills/hop-deep-research/SKILL.md'))).toBe(true);
      // 工具配置落位:两 server 并入,响应记名
      expect(r.plus_tools_merged?.sort()).toEqual(['bailian_search', 'playwright']);
      const cfg = readFileSync(join(fakeHome, '.hopjit', 'config.yaml'), 'utf-8');
      expect(cfg).toContain('bailian_search');
      expect(cfg).toContain('playwright');
      // 剩余人工动作在 note 里明示
      expect(String(r.plus_note)).toContain('DASHSCOPE_API_KEY');
    });

    it('反例：--plus 遇已有同名 tool server → 跳过不覆盖（用户资产纪律）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-plus-home2-'));
      const origHome = process.env.HOME;
      const origCfgDir = process.env.CLAUDE_CONFIG_DIR;
      const origCodexHome = process.env.CODEX_HOME;
      process.env.HOME = fakeHome;
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CODEX_HOME;
      // 预置用户自己的 bailian_search 条目（url 特制作区分）
      mkdirSync(join(fakeHome, '.hopjit'), { recursive: true });
      writeFileSync(join(fakeHome, '.hopjit', 'config.yaml'),
        'tool_servers:\n  - name: bailian_search\n    binding: { kind: mcp, transport: http, url: "https://user-own.example/mcp" }\n    tools: []\n');
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--plus', '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        if (origCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = origCfgDir;
        if (origCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = origCodexHome;
      }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.plus_tools_merged).toEqual(['playwright']);   // 只并入缺席的
      const cfg = readFileSync(join(fakeHome, '.hopjit', 'config.yaml'), 'utf-8');
      expect(cfg).toContain('user-own.example');   // 用户条目原样保留
      expect(String(r.plus_note)).toContain("'bailian_search' 已在");
    });

    // --mcp 注册测试统一 fake HOME 隔离——跨 scope 感知读 ~/.claude.json,真 HOME 不封闭
    function withMcpEnv(fn: (ctx: { home: string; cwd: string }) => Promise<void>): Promise<void> {
      const fakeHome = mkdtempSync(join(tmpdir(), 'hopmcp-home-'));
      const cwd = mkdtempSync(join(tmpdir(), 'hopmcp-cwd-'));
      const oldCwd = process.cwd();
      // cfuse 内置 cc/codex 通过 CLAUDE_CONFIG_DIR/CODEX_HOME 重定向 home——测试隔离 HOME 须同清,
      // 否则 home 解析读真实 cfuse 目录污染（在 cfuse 环境跑测试时该变量设着）
      const saved: Record<string, string | undefined> = {};
      for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
        saved[k] = process.env[k]; delete process.env[k];
      }
      process.env.HOME = fakeHome;
      process.chdir(cwd);
      // cwd 取 chdir 后的 process.cwd()——macOS tmpdir 经 /var→/private/var symlink,
      // scope 感知按 process.cwd() 精确匹配,测试键必须同形
      return fn({ home: fakeHome, cwd: process.cwd() }).finally(() => {
        process.chdir(oldCwd);
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      });
    }

    // @v: anc-cli-install-skill — 双名双壳（2026-08-27 四改:恒装两壳,名字即模式;--mcp 只做注册+自举）
    it('install-skill 恒装双壳（/hopspec 复用 + /hopspec-mcp 薄壳）;--mcp 注册 .mcp.json（正例）', () => withMcpEnv(async ({ cwd }) => {
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-mcp-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      const reuse = readFileSync(join(dir, 'hopspec', 'SKILL.md'), 'utf-8');
      expect(reuse).toContain('driver subagent');               // 复用壳=复用协议
      expect(reuse).not.toContain('§M MCP 装配协议段');          // 不含 MCP 段（单壳双段形态已退役）
      const mcpShell = readFileSync(join(dir, 'hopspec-mcp', 'SKILL.md'), 'utf-8');
      expect(mcpShell).toContain('name: hopspec-mcp');          // 不同名并存
      expect(mcpShell).toContain('mcp__hopjit__start_run');     // 薄协议在场
      expect(mcpShell).not.toContain('driver subagent');        // 不含复用协议
      expect(existsSync(join(dir, 'hopspec-mcp', 'references', 'discovery.md'))).toBe(true);   // spec 定位件随装
      const mcp = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8'));
      expect(mcp.mcpServers.hopjit.command).toBe('hopjit-mcp');
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_registered).toContain('.mcp.json');
    }));

    // 反例守卫:不带 --mcp 也恒装两壳（装配零选择——名字即模式,选择在用户敲哪个名）
    it('install-skill 不带 --mcp 同样装出 hopspec-mcp 壳（装配零选择）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-both-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      expect(existsSync(join(dir, 'hopspec', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(dir, 'hopspec-mcp', 'SKILL.md'))).toBe(true);
    });

    it('install-skill --mcp 已有 hopjit 条目跳过不覆盖（反例:注册配置是用户资产）', () => withMcpEnv(async ({ cwd }) => {
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-mcp2-'));
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { hopjit: { command: 'my-custom' } } }), 'utf-8');
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      const mcp = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8'));
      expect(mcp.mcpServers.hopjit.command).toBe('my-custom');   // 未被覆盖
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_registered).toBeNull();
      expect(out.mcp_note).toContain('未改动');
    }));

    // @v: anc-cli-install-skill — CC 跨 scope 已注册感知（2026-08-20 实撞立:local 级在场又写
    // project 级=同名多 scope 冲突且窄 scope 盖住新注册）
    it('正例:~/.claude.json local 级已有 hopjit→跳过 .mcp.json 并 note 指明 scope', () => withMcpEnv(async ({ home, cwd }) => {
      writeFileSync(join(home, '.claude.json'), JSON.stringify({
        projects: { [cwd]: { mcpServers: { hopjit: { command: 'node', args: ['dev/dist/mcp-server.js'] } } } },
      }), 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-scope-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);        // 未制造第二 scope
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_registered).toBeNull();
      expect(out.mcp_note).toContain('local 级');
    }));

    it('正例:~/.claude.json user 级已有 hopjit→同样跳过并指明 scope', () => withMcpEnv(async ({ home, cwd }) => {
      writeFileSync(join(home, '.claude.json'), JSON.stringify({
        mcpServers: { hopjit: { command: 'hopjit-mcp' } },
      }), 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-scope2-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_note).toContain('user 级');
    }));

    it('反例:~/.claude.json 坏 JSON 或他项目 local 注册→照常写 .mcp.json（best-effort 不拦装）', () => withMcpEnv(async ({ home, cwd }) => {
      writeFileSync(join(home, '.claude.json'), '{ 坏 json', 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-scope3-'));
      let cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8')).mcpServers.hopjit.command).toBe('hopjit-mcp');
      // 他项目的 local 注册不误报（scope 感知按本 cwd 精确匹配）
      rmSync(join(cwd, '.mcp.json'));
      writeFileSync(join(home, '.claude.json'), JSON.stringify({
        projects: { '/elsewhere/project': { mcpServers: { hopjit: { command: 'x' } } } },
      }), 'utf-8');
      cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8')).mcpServers.hopjit.command).toBe('hopjit-mcp');
    }));

    // @v: anc-cli-install-skill — Codex env_vars 联动 standalone 凭证名（2026-08-20 实撞立:
    // 硬编码 ANTHROPIC 对,配置用其他凭证名时 server 启动即缺凭证）
    it('正例:Codex 注册 env_vars 取 standalone 配置 api_key_env 并集（含本次自举刚写的——自举先于注册）', () => withMcpEnv(async ({ home }) => {
      const codexDir = join(home, '.codex');
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(join(codexDir, 'config.toml'), [
        'model = "vendor/model-z"', 'model_provider = "myprov"', '',
        '[model_providers.myprov]', 'base_url = "https://prov.example/v1"',
        'env_key = "MYPROV_API_KEY"', '',
      ].join('\n'), 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-envv-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--carrier', 'codex', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      const toml = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
      expect(toml).toContain('env_vars = ["MYPROV_API_KEY"]');       // 联动自举产物,非硬编码 ANTHROPIC
      expect(toml).not.toContain('ANTHROPIC_AUTH_TOKEN');
    }));

    it('反例:standalone 配置读不到→env_vars 回落缺省 ANTHROPIC 对', () => withMcpEnv(async ({ home }) => {
      const codexDir = join(home, '.codex');
      mkdirSync(codexDir, { recursive: true });
      // config.toml 缺 model_provider 链→自举不写文件;env_vars 无来源→缺省对
      writeFileSync(join(codexDir, 'config.toml'), 'model = "m"\n', 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-envv2-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--carrier', 'codex', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      const toml = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
      expect(toml).toContain('env_vars = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]');
    }));

    it('install-skill --mcp 拒坏 .mcp.json（反例:不静默覆盖用户损坏配置）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-mcp3-'));
      const cwd = mkdtempSync(join(tmpdir(), 'hopmcp-cwd3-'));
      const oldCwd = process.cwd();
      process.chdir(cwd);
      writeFileSync(join(cwd, '.mcp.json'), '{ 坏 json', 'utf-8');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`EXIT:${c}`); }) as never);
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await expect(program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']))
          .rejects.toThrow(/EXIT/);
      } finally { exitSpy.mockRestore(); errSpy.mockRestore(); process.chdir(oldCwd); }
    });

    // @v: anc-cli-install-skill — --mcp 配置自举（2026-08-17 作者定:没有已有配置时学习主 agent
    // LLM 配置为 standalone 缺省模型并明示;已有配置零触碰;只写凭证名不写值）
    describe('install-skill --mcp 配置自举', () => {
      function withIsolatedEnv(fn: () => Promise<void>): Promise<void> {
        const fakeHome = mkdtempSync(join(tmpdir(), 'hopboot-home-'));
        const cwd = mkdtempSync(join(tmpdir(), 'hopboot-cwd-'));
        const origHome = process.env.HOME;
        const oldCwd = process.cwd();
        const saved: Record<string, string | undefined> = {};
        for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
          saved[k] = process.env[k]; delete process.env[k];
        }
        process.env.HOME = fakeHome;
        process.chdir(cwd);
        return fn().finally(() => {
          process.env.HOME = origHome; process.chdir(oldCwd);
          for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        });
      }

      it('正例:CC 载体两级配置全缺席→学习 ANTHROPIC_* 写系统级配置并明示（只写凭证名）', () => withIsolatedEnv(async () => {
        process.env.ANTHROPIC_AUTH_TOKEN = 'secret-value-must-not-land';
        process.env.ANTHROPIC_BASE_URL = 'https://example.com/anthropic';
        process.env.ANTHROPIC_MODEL = 'test-model-x';
        const dir = mkdtempSync(join(tmpdir(), 'hopboot-skill-'));
        const cap = capture();
        try {
          await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']);
        } finally { cap.restore(); }
        const cfgPath = join(process.env.HOME!, '.hopjit', 'config.yaml');
        const cfg = readFileSync(cfgPath, 'utf-8');
        expect(cfg).toContain('service_id: cc_host');
        expect(cfg).toContain('protocol: anthropic');
        expect(cfg).toContain('base_url: https://example.com/anthropic');
        expect(cfg).toContain('model: test-model-x');
        expect(cfg).toContain('api_key_env: ANTHROPIC_AUTH_TOKEN');
        expect(cfg).not.toContain('secret-value-must-not-land');   // 值绝不落盘
        const out = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect(out.mcp_config_bootstrapped).toBe(cfgPath);
        expect(out.mcp_config_note).toContain('test-model-x');      // 明示学了什么
        expect(out.mcp_config_note).toContain('ANTHROPIC_AUTH_TOKEN');
      }));

      it('正例:Codex 载体学 config.toml 的 model_provider 链,protocol 钉 openai-chat（responses 未实装不学）', () => withIsolatedEnv(async () => {
        const codexDir = join(process.env.HOME!, '.codex');
        mkdirSync(codexDir, { recursive: true });
        writeFileSync(join(codexDir, 'config.toml'), [
          'model = "vendor/model-z"', 'model_provider = "myprov"', '',
          '[model_providers.other]', 'base_url = "https://other.example"', '',
          '[model_providers.myprov]', 'base_url = "https://prov.example/v1"',
          'env_key = "MYPROV_API_KEY"', 'wire_api = "responses"', '',
        ].join('\n'), 'utf-8');
        const dir = mkdtempSync(join(tmpdir(), 'hopboot-skill2-'));
        const cap = capture();
        try {
          await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--carrier', 'codex', '--dir', dir, '--force']);
        } finally { cap.restore(); }
        const cfg = readFileSync(join(process.env.HOME!, '.hopjit', 'config.yaml'), 'utf-8');
        expect(cfg).toContain('service_id: codex_host');
        expect(cfg).toContain('protocol: openai-chat');             // 不学 responses（未实装）
        expect(cfg).toContain('base_url: https://prov.example/v1'); // 命中 myprov 节非 other 节
        expect(cfg).toContain('model: vendor/model-z');
        expect(cfg).toContain('api_key_env: MYPROV_API_KEY');
      }));

      it('正例:CC 环境干净但 settings.json env 块有配→第二级学习链命中（终端装配形态）', () => withIsolatedEnv(async () => {
        const ccDir = join(process.env.HOME!, '.claude');
        mkdirSync(ccDir, { recursive: true });
        writeFileSync(join(ccDir, 'settings.json'), JSON.stringify({
          model: 'settings-model-y',
          env: { ANTHROPIC_API_KEY: 'value-never-copied', ANTHROPIC_BASE_URL: 'https://settings.example' },
        }), 'utf-8');
        const dir = mkdtempSync(join(tmpdir(), 'hopboot-skill5-'));
        const cap = capture();
        try {
          await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']);
        } finally { cap.restore(); }
        const cfg = readFileSync(join(process.env.HOME!, '.hopjit', 'config.yaml'), 'utf-8');
        expect(cfg).toContain('api_key_env: ANTHROPIC_API_KEY');    // 学到"哪个名字被配了"
        expect(cfg).toContain('base_url: https://settings.example');
        expect(cfg).toContain('model: settings-model-y');            // 顶层 model 字段兜底
        expect(cfg).not.toContain('value-never-copied');             // settings 里的值也不抄
      }));

      it('正例:值含 YAML 特殊字符（冒号空格/井号）→产物过自家加载器不变形（二审探针实抓:裸模板拼接即炸）', () => withIsolatedEnv(async () => {
        process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
        process.env.ANTHROPIC_BASE_URL = 'https://api.example.com:8443/v1';
        process.env.ANTHROPIC_MODEL = 'claude: beta #test';
        const dir = mkdtempSync(join(tmpdir(), 'hopboot-skill7-'));
        const cap = capture();
        try {
          await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']);
        } finally { cap.restore(); }
        const { loadStandaloneConfig } = await import('../src/mcp-server.js');
        const cfg = loadStandaloneConfig(undefined, mkdtempSync(join(tmpdir(), 'hopboot-proj-')));
        expect(cfg.providers[0].model).toBe('claude: beta #test');           // 不变形
        expect(cfg.providers[0].base_url).toBe('https://api.example.com:8443/v1');
      }));

      it('反例:已有系统级配置零触碰（用户资产,与注册面同款纪律）', () => withIsolatedEnv(async () => {
        process.env.ANTHROPIC_API_KEY = 'k';
        const cfgPath = join(process.env.HOME!, '.hopjit', 'config.yaml');
        mkdirSync(dirname(cfgPath), { recursive: true });
        writeFileSync(cfgPath, 'providers:\n  - service_id: mine\n', 'utf-8');
        const dir = mkdtempSync(join(tmpdir(), 'hopboot-skill3-'));
        const cap = capture();
        try {
          await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']);
        } finally { cap.restore(); }
        expect(readFileSync(cfgPath, 'utf-8')).toContain('service_id: mine');   // 原样
        const out = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect(out.mcp_config_bootstrapped).toBeNull();
        expect(out.mcp_config_note).toContain('未改动');
      }));

      it('反例:项目级 hopjit.yaml 在场同样零触碰（两级配置任一在场即不自举）', () => withIsolatedEnv(async () => {
        process.env.ANTHROPIC_API_KEY = 'k';
        writeFileSync(join(process.cwd(), 'hopjit.yaml'), 'tool_servers: []\n', 'utf-8');
        const dir = mkdtempSync(join(tmpdir(), 'hopboot-skill6-'));
        const cap = capture();
        try {
          await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']);
        } finally { cap.restore(); }
        expect(existsSync(join(process.env.HOME!, '.hopjit', 'config.yaml'))).toBe(false);   // 系统级未被创建
        const out = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect(out.mcp_config_bootstrapped).toBeNull();
        expect(out.mcp_config_note).toContain('未改动');
      }));

      it('反例:学习源缺失（CC 无凭证 env）→不写文件,note 明示需自建', () => withIsolatedEnv(async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hopboot-skill4-'));
        const cap = capture();
        try {
          await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--mcp', '--dir', dir, '--force']);
        } finally { cap.restore(); }
        expect(existsSync(join(process.env.HOME!, '.hopjit', 'config.yaml'))).toBe(false);
        const out = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect(out.mcp_config_bootstrapped).toBeNull();
        expect(out.mcp_config_note).toContain('未自举');
      }));
    });

    it('install-skill 缺省 hopspec 壳=纯复用协议（回归:四改后仍无 standalone 块混入）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-reuse-'));
      await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', dir, '--force']);
      const shell = readFileSync(join(dir, 'hopspec', 'SKILL.md'), 'utf-8');
      expect(shell).toContain('driver subagent');                 // 复用协议在场
      expect(shell).not.toContain('STANDALONE 薄协议');            // standalone 块不混入
      expect(shell).toContain('DRIVER_CHANNEL_MISMATCH');          // 跨通道防线指路在场（改道牌四改退役）
    });

    it('install-skill --dir 覆盖缺省仍生效（反例:显式指定不被新缺省吞掉）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-is-home2-'));
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-dir-'));
      const origHome = process.env.HOME;
      process.env.HOME = fakeHome;
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap.restore(); process.env.HOME = origHome; }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(existsSync(join(dir, 'sk/hopspec/SKILL.md'))).toBe(true);
      expect(existsSync(join(fakeHome, '.claude'))).toBe(false); // 缺省路径未被触碰
    });

    // @v: anc-cli-install-skill —— 受管目录清理（2026-08-13 实撞:parallel-worker.md 残留教废协议;
    // 2026-08-24 hopissues/0022 判据改自有安装清单——只删"manifest 里有、源里已没有"的）
    it('正例：--force 清除 manifest 内、源已不存在的残留 .md（removed 列出;用户文件天然豁免——0022 probe 双向）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-prune-'));
      const cap1 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap1.restore(); }
      const refsDir = join(dir, 'sk/hopspec/references');
      // 陈旧残留=上版装的（塞进 manifest 模拟）;用户文件=不在任何 manifest
      const staleFile = join(refsDir, 'parallel-worker.md');
      writeFileSync(staleFile, '# 已退役的旧协议\n');
      const userFile = join(refsDir, 'my-note.md');
      writeFileSync(userFile, '# 用户自己的笔记\n');
      const mfPath = join(refsDir, '.hopjit-manifest.json');
      const mf = JSON.parse(readFileSync(mfPath, 'utf-8')) as { files: string[] };
      mf.files.push('parallel-worker.md');
      writeFileSync(mfPath, JSON.stringify(mf));
      const cap2 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap2.restore(); }
      const r = JSON.parse(cap2.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(existsSync(staleFile)).toBe(false);                                           // manifest 内残留照删（2026-08-13 立意保留）
      expect((r.removed as string[]).some(p => p.endsWith('parallel-worker.md'))).toBe(true);
      expect(existsSync(userFile)).toBe(true);                                             // 用户文件存活（0022 probe 主判据——原实现在此被删）
      expect(existsSync(join(refsDir, 'driver-subagent.md'))).toBe(true);                  // 源在场文件不误删
      const mfAfter = JSON.parse(readFileSync(mfPath, 'utf-8')) as { files: string[] };
      expect(mfAfter.files).not.toContain('parallel-worker.md');                           // 新 manifest 只含本次源清单
      expect(mfAfter.files).not.toContain('my-note.md');                                   // 用户文件永不入清单
    });

    it('反例：manifest 缺席（旧版装机/首装）→ 零删除（宁漏删不误删;本次落新 manifest 下次恢复管辖）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-nomf-'));
      const cap1 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap1.restore(); }
      const refsDir = join(dir, 'sk/hopspec/references');
      rmSync(join(refsDir, '.hopjit-manifest.json'));                    // 模拟旧版装机（无 manifest）
      const staleFile = join(refsDir, 'parallel-worker.md');
      writeFileSync(staleFile, '# 残留\n');
      const cap2 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap2.restore(); }
      expect(existsSync(staleFile)).toBe(true);                          // 空清单=零删除
      expect(existsSync(join(refsDir, '.hopjit-manifest.json'))).toBe(true);   // 新 manifest 已落——下次清理恢复管辖
    });

    it('反例：非 force 不清理（与"存在即跳过"对称——不覆盖也不删除）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-noprune-'));
      const cap1 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap1.restore(); }
      const staleFile = join(dir, 'sk/hopspec/references/parallel-worker.md');
      writeFileSync(staleFile, '# 残留\n');
      const cap2 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk')]);
      } finally { cap2.restore(); }
      expect(existsSync(staleFile)).toBe(true);   // 非 force 原样保留
    });

    it('反例：受管清理不碰 references/ 外的文件（SKILL.md 顶层/用户其它 skill 目录）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-scope-'));
      const cap1 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap1.restore(); }
      const userFile = join(dir, 'sk/hopspec/MY-NOTES.md');       // 用户放在 skill 顶层的文件
      const userSkill = join(dir, 'sk/my-own-skill/SKILL.md');    // 用户自己的 skill
      writeFileSync(userFile, 'x');
      mkdirSync(dirname(userSkill), { recursive: true });
      writeFileSync(userSkill, 'y');
      const cap2 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap2.restore(); }
      expect(existsSync(userFile)).toBe(true);
      expect(existsSync(userSkill)).toBe(true);
    });

    it('install-skill in-process：cc 布局 + 版本戳', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-ip-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.driver_version).toMatch(/^\d+\.\d+\.\d+/);
      expect(readFileSync(join(dir, 'sk/hopspec/SKILL.md'), 'utf-8'))
        .toMatch(/^---\n[\s\S]*?\n---\n<!-- driver:/);
      // /hop 装配 + 版本戳恰好一枚（copyFile 已注入后曾手工再戳,装出双行 driver 注释——实证修复的回归锁）
      const hopSkill = readFileSync(join(dir, 'sk/hop/SKILL.md'), 'utf-8');
      expect(hopSkill).toMatch(/^---\n[\s\S]*?\n---\n<!-- driver:/);
      expect(hopSkill.match(/<!-- driver:/g)).toHaveLength(1);
    });

    it('pack in-process：幂等跳过 + 知识文档收集', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-ip-k-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(REPO, 'scripts/audit/anchor-audit.md'), '--dir', join(dir, 'sk')]);
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(REPO, 'scripts/audit/anchor-audit.md'), '--dir', join(dir, 'sk')]);
      } finally { cap.restore(); }
      const outs = cap.get().trim().split('\n').map(l => JSON.parse(l));
      expect(outs[0].knowledge_docs).toContain('anchor-audit-knowledge.md');
      expect(outs[1].installed).toEqual([]);            // 幂等：二跑无写入
      expect(outs[1].note).toBeTruthy();
    });

    it('pack in-process：--name 覆盖 + spec 文件不存在报错', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-ip-n-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(REPO, 'examples/doc-review.md'), '--dir', join(dir, 'sk'), '--name', 'my-review']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.skill_name).toBe('my-review');
      expect(existsSync(join(dir, 'sk/my-review/SKILL.md'))).toBe(true);
    });

    // @v: anc-cli-pack — v0.6.0 carrier-aware：codex 包装模板 + 资产（in-process 供覆盖率可见）
    it('pack in-process：--carrier codex 包装 + --assets 拷入', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-ip-cdx-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(REPO, 'examples/coffee-week.md'), '--carrier', 'codex', '--dir', join(dir, 'sk'), '--assets', 'coffee-sales.json']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.carrier).toBe('codex');
      expect(r.assets).toEqual(['coffee-sales.json']);
      const skillMd = readFileSync(join(dir, 'sk/coffee-week/SKILL.md'), 'utf-8');
      expect(skillMd).toContain('# $coffee-week');
      expect(skillMd).not.toContain('AskUserQuestion');
      expect(existsSync(join(dir, 'sk/coffee-week/coffee-sales.json'))).toBe(true);
    });

    // @v: anc-cli-carrier-home-resolution —— pack cfuse-* 产物前置段指引用户装到 cfuse home,不硬编码原生路径
    it('pack in-process：--carrier cfuse-cc 前置段指引 --carrier cfuse-cc（不硬编码 --dir ~/.claude/skills）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-ip-fcc-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(REPO, 'examples/coffee-week.md'), '--carrier', 'cfuse-cc', '--dir', join(dir, 'sk')]);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.carrier).toBe('cfuse-cc');
      const skillMd = readFileSync(join(dir, 'sk/coffee-week/SKILL.md'), 'utf-8');
      expect(skillMd).toContain('--carrier cfuse-cc');   // 前置指引 cfuse-cc 装驱动
      expect(skillMd).not.toContain('--dir ~/.claude/skills');   // 不硬编码原生路径（否则 cfuse 用户照做装错位置）
    });

    it('pack in-process：--carrier cfuse-codex 前置段指引 cfuse-codex 位置（不硬编码 ~/.codex）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-ip-fcd-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(REPO, 'examples/coffee-week.md'), '--carrier', 'cfuse-codex', '--dir', join(dir, 'sk')]);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.carrier).toBe('cfuse-codex');
      const skillMd = readFileSync(join(dir, 'sk/coffee-week/SKILL.md'), 'utf-8');
      expect(skillMd).toContain('~/.codefuse/engine/codex/skills/hopspec/SKILL.md');   // 前置指引 cfuse-codex 位置
      expect(skillMd).not.toContain('~/.codex/skills/hopspec/SKILL.md');   // 不硬编码原生 ~/.codex
    });

    it('pack in-process：--assets 缺失即拒（error 路径）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-ip-am-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(REPO, 'examples/coffee-week.md'), '--dir', join(dir, 'sk'), '--assets', 'no-such.json']);
      } finally { cap.restore(); process.exitCode = 0; }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('error');
      expect(r.errors).toContain('no-such.json');
    });

    // @v: anc-cli-install-skill — --demo 双载体（in-process 供覆盖率可见）
    // @v: anc-cli-pack —— name 覆盖时副本 Id 随名改写（运行痕迹命名空间对齐 skill 名）
    it('pack --name 覆盖：副本 Id 行改写为 name（正例）;无 name 原样拷贝（反例）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-idrw-'));
      let cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(REPO, 'examples/syntax/confirm-commit.md'), '--name', 'demo-rename', '--dir', join(dir, 'a'), '--force']);
      } finally { cap.restore(); }
      const rewritten = readFileSync(join(dir, 'a/demo-rename/spec.md'), 'utf-8');
      expect(rewritten).toMatch(/^Id: demo-rename$/m);
      expect(rewritten).not.toMatch(/^Id: confirm-commit$/m);
      // 源文件不动
      expect(readFileSync(join(REPO, 'examples/syntax/confirm-commit.md'), 'utf-8')).toMatch(/^Id: confirm-commit$/m);
      // 反例:无 name → 原样(Id 保持)
      cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(REPO, 'examples/syntax/confirm-commit.md'), '--dir', join(dir, 'b'), '--force']);
      } finally { cap.restore(); }
      expect(readFileSync(join(dir, 'b/confirm-commit/spec.md'), 'utf-8')).toMatch(/^Id: confirm-commit$/m);
    });

    it('install-skill in-process：--demo 附装 demo 集全部成员（demo- 前缀命名空间）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-ip-demo-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk'), '--demo', '--force']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(existsSync(join(dir, 'sk/demo-coffee-week/SKILL.md'))).toBe(true);
      expect(existsSync(join(dir, 'sk/demo-coffee-week/coffee-sales.json'))).toBe(true);
      expect(existsSync(join(dir, 'sk/demo-fact-check/SKILL.md'))).toBe(true);
      expect(existsSync(join(dir, 'sk/demo-fact-check/fact-check-sample.md'))).toBe(true);
      expect(existsSync(join(dir, 'sk/demo-rename/SKILL.md'))).toBe(true);
      // 反例:旧裸名不再产生（防冲突污染的正名）
      expect(existsSync(join(dir, 'sk/coffee-week'))).toBe(false);
    });

    it('install-skill in-process：codex --demo 附装 $demo-* 全集', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-ip-demo-cdx-'));
      const cwd = process.cwd();
      const cap = capture();
      try {
        process.chdir(dir);
        // --dir 显式隔离（缺省已是 ~/.codex/skills 用户级——测试不许写真实家目录）;demo 恒项目级落 cwd
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--carrier', 'codex', '--dir', join(dir, 'sk'), '--demo', '--force']);
      } finally { cap.restore(); process.chdir(cwd); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      const md = readFileSync(join(dir, '.agents/skills/demo-coffee-week/SKILL.md'), 'utf-8');
      expect(md).toContain('# $demo-coffee-week');
      expect(existsSync(join(dir, '.agents/skills/demo-fact-check/SKILL.md'))).toBe(true);
      expect(existsSync(join(dir, '.agents/skills/demo-rename/SKILL.md'))).toBe(true);
    });

    it('install-skill in-process：幂等跳过（note 提示 force）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-ip-idem-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk')]);
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--dir', join(dir, 'sk')]);
      } finally { cap.restore(); }
      const outs = cap.get().trim().split('\n').map(l => JSON.parse(l));
      expect(outs[1].installed).toEqual([]);
      expect(outs[1].note).toContain('--force');
    });

    it('install-skill in-process：codex 布局', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-ip-cx-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--carrier', 'codex', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap.restore(); }
      // --dir 语义=skills 根（2026-08-27 看齐批——不再拼 .agents/skills 中间层）
      expect(existsSync(join(dir, 'sk/hopspec/agents/segment-driver.md'))).toBe(true);
      expect(existsSync(join(dir, 'sk/hopspec/references/cli-discovery.md'))).toBe(true);
      // $hop Codex 变体（2026-08-26 作者定"补"）：单文件装点 + 版本戳在 frontmatter 闭合线后（规约 A1——前置戳 Codex 不识别）
      expect(readFileSync(join(dir, 'sk/hop/SKILL.md'), 'utf-8'))
        .toMatch(/^---\n[\s\S]*?\n---\n<!-- driver:/);
    });

    it('install-skill in-process：拒绝未知 carrier', async () => {
      const origExit = process.exit;
      const origStderr = process.stderr.write;
      let stderr = '';
      process.exit = ((code: number) => { throw new Error(`EXIT:${code}`); }) as any;
      process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as any;
      try {
        await expect(program.parseAsync(['node', 'hopjit', '--json', 'install-skill', '--carrier', 'unknown']))
          .rejects.toThrow('EXIT:1');
      } finally {
        process.exit = origExit;
        process.stderr.write = origStderr;
      }
      expect(stderr).toContain("未知 carrier 'unknown'");
    });
  });

  describe('program commands via parseAsync', () => {
    it('init command registers and executes', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-prog-'));
      writeFileSync(join(dir, 'spec.md'), SIMPLE_SPEC);
      const origCwd = process.cwd();
      const origStdout = process.stdout.write;
      let captured = '';
      process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as any;
      process.chdir(dir);
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'init', 'spec.md', '--state-dir', 'state']);
        const result = JSON.parse(captured.trim());
        expect(result.status).toBe('ok');
        expect(result.instance_id).toBeTruthy();
      } finally {
        process.chdir(origCwd);
        process.stdout.write = origStdout;
      }
    });

    it('init with --params injects variables into engine', () => {
      const engine = new ExecutionEngine();
      const paramSpec = `# Param Test
Id: param-inject
## Goal
Test params inject
## Inputs
- source: text  # input
## Outputs
- result: text  # output
## Steps
1. [reason] Analyze
  - ← source
  + → result: text  # output
  > Analyze source
`;
      engine.initExecution(paramSpec, HOST);
      const vars = engine.getVariableStore();
      vars.write('source', 'hello', 'root');

      const allVars = vars.getAllVariables();
      expect(allVars['source']).toBe('hello');

      const next = engine.nextStep();
      expect(next.status).toBe('step_ready');
      if (next.status === 'step_ready') {
        expect(next.context.inputs['source']).toBe('hello');
      }
    });

    it('done with --answer passes HITL response', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-prog-'));
      writeFileSync(join(dir, 'spec.md'), SIMPLE_SPEC);
      const origCwd = process.cwd();
      process.chdir(dir);

      const origStdout = process.stdout.write;
      let captured = '';
      process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as any;

      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'init', 'spec.md', '--state-dir', 'state-a']);
        await program.parseAsync(['node', 'hopjit', '--json', 'debug_step', '--state-dir', 'state-a']);
        captured = '';
        // submit 后引擎推进——单步 spec 提交即终态 completed（不再是 {status:ok}）
        await program.parseAsync(['node', 'hopjit', '--json', 'submit_and_fetch_next', '1', '--answer', '{"result":"yes"}', '--state-dir', 'state-a']);
        const result = JSON.parse(captured.trim());
        expect(result.status).toBe('completed');
      } finally {
        process.chdir(origCwd);
        process.stdout.write = origStdout;
      }
    });

    it('debug_step command returns step_ready', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-prog-'));
      writeFileSync(join(dir, 'spec.md'), SIMPLE_SPEC);
      const origCwd = process.cwd();
      process.chdir(dir);

      const origStdout = process.stdout.write;
      let captured = '';
      process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as any;

      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'init', 'spec.md', '--state-dir', 'state2']);
        captured = '';
        await program.parseAsync(['node', 'hopjit', '--json', 'debug_step', '--state-dir', 'state2']);
        const result = JSON.parse(captured.trim());
        expect(result.status).toBe('step_ready');
        expect(result.step_id).toBe('1');
      } finally {
        process.chdir(origCwd);
        process.stdout.write = origStdout;
      }
    });

    it('submit_and_fetch_next command completes step', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-prog-'));
      writeFileSync(join(dir, 'spec.md'), SIMPLE_SPEC);
      const origCwd = process.cwd();
      process.chdir(dir);

      const origStdout = process.stdout.write;
      let captured = '';
      process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as any;

      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'init', 'spec.md', '--state-dir', 'state3']);
        captured = '';
        await program.parseAsync(['node', 'hopjit', '--json', 'debug_step', '--state-dir', 'state3']);
        captured = '';
        // 单步 spec：submit 后引擎推进至终态 completed
        await program.parseAsync(['node', 'hopjit', '--json', 'submit_and_fetch_next', '1', '--output', '{"result":"ok"}', '--state-dir', 'state3']);
        const result = JSON.parse(captured.trim());
        expect(result.status).toBe('completed');
        expect(result.outputs['result']).toBe('ok');
      } finally {
        process.chdir(origCwd);
        process.stdout.write = origStdout;
      }
    });

    it('submit_and_fetch_next --failure records failure', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-prog-'));
      writeFileSync(join(dir, 'spec.md'), SIMPLE_SPEC);
      const origCwd = process.cwd();
      process.chdir(dir);

      const origStdout = process.stdout.write;
      let captured = '';
      process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as any;

      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'init', 'spec.md', '--state-dir', 'state4']);
        captured = '';
        await program.parseAsync(['node', 'hopjit', '--json', 'debug_step', '--state-dir', 'state4']);
        captured = '';
        // 单步 spec：失败提交后引擎推进至终态 failed（无 subtask 兜底）
        await program.parseAsync(['node', 'hopjit', '--json', 'submit_and_fetch_next', '1', '--failure', 'test fail', '--state-dir', 'state4']);
        const result = JSON.parse(captured.trim());
        expect(result.status).toBe('failed');
      } finally {
        process.chdir(origCwd);
        process.stdout.write = origStdout;
      }
    });

    it('status command reports state', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-prog-'));
      writeFileSync(join(dir, 'spec.md'), SIMPLE_SPEC);
      const origCwd = process.cwd();
      process.chdir(dir);

      const origStdout = process.stdout.write;
      let captured = '';
      process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as any;

      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'init', 'spec.md', '--state-dir', 'state5']);
        captured = '';
        await program.parseAsync(['node', 'hopjit', '--json', 'status', '--state-dir', 'state5']);
        const result = JSON.parse(captured.trim());
        expect(result.status).toBe('ok');
        expect(result.total_steps).toBe(1);
      } finally {
        process.chdir(origCwd);
        process.stdout.write = origStdout;
      }
    });

    it('vars command returns variables', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-prog-'));
      writeFileSync(join(dir, 'spec.md'), SIMPLE_SPEC);
      const origCwd = process.cwd();
      process.chdir(dir);

      const origStdout = process.stdout.write;
      let captured = '';
      process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as any;

      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'init', 'spec.md', '--state-dir', 'state6']);
        await program.parseAsync(['node', 'hopjit', '--json', 'debug_step', '--state-dir', 'state6']);
        captured = '';
        await program.parseAsync(['node', 'hopjit', '--json', 'submit_and_fetch_next', '1', '--output', '{"result":"hello"}', '--state-dir', 'state6']);
        captured = '';
        await program.parseAsync(['node', 'hopjit', '--json', 'vars', '--state-dir', 'state6']);
        const result = JSON.parse(captured.trim());
        expect(result.status).toBe('ok');
        expect(result.variables['result']).toBe('hello');
      } finally {
        process.chdir(origCwd);
        process.stdout.write = origStdout;
      }
    });

    // @v: anc-cli-state-load — resume 走 recover（重置悬空 running），其余命令走 load
    it('resume command succeeds', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-prog-'));
      writeFileSync(join(dir, 'spec.md'), SIMPLE_SPEC);
      const origCwd = process.cwd();
      process.chdir(dir);

      const origStdout = process.stdout.write;
      let captured = '';
      process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as any;

      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'init', 'spec.md', '--state-dir', 'state7']);
        captured = '';
        await program.parseAsync(['node', 'hopjit', '--json', 'resume', '--state-dir', 'state7']);
        const result = JSON.parse(captured.trim());
        // resume = recover + advanceToCaller → 推进到首个 caller 介入点（reason 步骤）
        expect(result.status).toBe('step_ready');
      } finally {
        process.chdir(origCwd);
        process.stdout.write = origStdout;
      }
    });

    it('branch command selects case', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-prog-'));
      const branchSpec = `# Branch
Id: branch-cli-cov
## Goal
Test branch
## Inputs
- mode: text  # input
## Outputs
- out: text  # output
## Steps
1. [branch] Choose
  1.1. [case] {mode}==fast
    1.1.1. [reason] Fast
      + → out: text  # output
      > Go fast
  1.2. [case] {mode}==slow
    1.2.1. [reason] Slow
      + → out: text  # output
      > Go slow
`;
      writeFileSync(join(dir, 'spec.md'), branchSpec);
      const origCwd = process.cwd();
      process.chdir(dir);

      const origStdout = process.stdout.write;
      let captured = '';
      process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as any;

      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'init', 'spec.md', '--state-dir', 'state8', '--params', '{"mode":"fast"}']);
        captured = '';
        // 选 case 1.1 后引擎推进至该 case 的 reason 步骤 1.1.1（返回 step_ready，不再是 {status:ok}）
        await program.parseAsync(['node', 'hopjit', '--json', 'submit_and_fetch_next', '1', '--branch', '1.1', '--reason', 'fast', '--state-dir', 'state8']);
        const result = JSON.parse(captured.trim());
        expect(result.status).toBe('step_ready');
        expect(result.step_id).toBe('1.1.1');
      } finally {
        process.chdir(origCwd);
        process.stdout.write = origStdout;
      }
    });

    it('submit_and_fetch_next --replan parses @file and calls submitReplan', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-prog-'));
      const subtaskSpec = `# Subtask
Id: subtask-replan
## Goal
Test replan
## Outputs
- out: text  # output
## Steps
1. [subtask] Do work
  retry: 1
  1.1. [reason] Try
    + → out: text  # output
    > Do it
`;
      writeFileSync(join(dir, 'spec.md'), subtaskSpec);
      const newSteps = `1. [reason] Retry\n  + → out: text  # output\n  > Try again\n`;
      writeFileSync(join(dir, 'steps.md'), newSteps);

      const origCwd = process.cwd();
      process.chdir(dir);

      const origStdout = process.stdout.write;
      let captured = '';
      process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as any;

      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'init', 'spec.md', '--state-dir', 'state9']);
        // submitReplan 返回 error（非 adaptive_needed 状态），错误不推进、原样返回——
        // 仍走完整 CLI 路径：参数解析、@file 解析、load、submitReplan
        captured = '';
        await program.parseAsync(['node', 'hopjit', '--json', 'submit_and_fetch_next', '1', '--replan', '@steps.md', '--state-dir', 'state9']);
        const result = JSON.parse(captured.trim());
        expect(result.status).toBe('error');
        expect(result.code).toBe('INVALID_STATE');
      } finally {
        process.chdir(origCwd);
        process.stdout.write = origStdout;
      }
    });
  });

  describe('errorExit', () => {
    it('writes to stderr and calls process.exit', () => {
      const origExit = process.exit;
      const origStderr = process.stderr.write;
      let exitCode: number | undefined;
      let stderrMsg = '';
      process.exit = ((code: number) => { exitCode = code; }) as any;
      process.stderr.write = ((chunk: string) => { stderrMsg += chunk; return true; }) as any;

      try {
        errorExit('test error', 42);
      } catch {
        // errorExit is typed as never, but our mock doesn't actually exit
      } finally {
        process.exit = origExit;
        process.stderr.write = origStderr;
      }

      expect(exitCode).toBe(42);
      expect(stderrMsg).toContain('test error');
    });
  });
});

// Keep existing unit tests as supplementary
describe('CLI helpers (unit tests via engine)', () => {
  describe('init + next + done workflow', () => {
    it('initializes and gets next step', () => {
      const engine = new ExecutionEngine();
      const result = engine.initExecution(SIMPLE_SPEC, HOST, { stateDir: mkdtempSync(join(tmpdir(), 'cli-')) });
      expect(result.status).toBe('ok');

      const next = engine.nextStep();
      expect(next.status).toBe('step_ready');
    });

    it('completes step with output', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      engine.nextStep();
      const done = engine.completeStep('1', { result: 'done' });
      expect(done.status).toBe('ok');
    });

    it('fails step with reason', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      engine.nextStep();
      const fail = engine.failStep('1', 'something broke');
      expect(fail.status).toBe('ok');
    });
  });

  describe('status and vars', () => {
    it('returns status after init', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const status = engine.getStatus();
      expect(status.status).toBe('ok');
      expect(status.total_steps).toBe(1);
      expect(status.pending).toBe(1);
    });

    it('returns vars after completion', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      engine.nextStep();
      engine.completeStep('1', { result: 'hello' });
      const vars = engine.getVars();
      expect(vars.status).toBe('ok');
      expect(vars.variables['result']).toBe('hello');
    });
  });

  // @v: anc-cli-branch-request
  describe('branch selection', () => {
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
    1.1.1. [reason] Fast path
      + → out: text  # output
      > Go fast
  1.2. [case] {mode}==slow
    1.2.1. [reason] Slow path
      + → out: text  # output
      > Go slow
`;

    it('selects a branch case', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(BRANCH_SPEC, HOST);
      const result = engine.selectBranch('1', '1.2', 'user chose slow');
      expect(result.status).toBe('ok');

      const next = engine.nextStep();
      expect(next.status).toBe('step_ready');
      if (next.status === 'step_ready') {
        expect(next.step_id).toBe('1.2.1');
      }
    });
  });

  describe('resume', () => {
    it('resumes from persisted state', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'cli-resume-'));
      const engine = new ExecutionEngine();
      const init = engine.initExecution(SIMPLE_SPEC, HOST, { stateDir });
      expect(init.status).toBe('ok');

      if (init.status === 'ok') {
        const instanceDir = join(stateDir, init.instance_id);
        const resumed = ExecutionEngine.load(instanceDir);
        const status = resumed.getStatus();
        expect(status.status).toBe('ok');
        expect(status.total_steps).toBe(1);
      }
    });
  });

  describe('path safety', () => {
    it('resolveParam handles @file syntax', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-file-'));
      writeFileSync(join(dir, 'params.json'), '{"key": "value"}');

      const filePath = join(dir, 'params.json');
      const content = JSON.parse(require('node:fs').readFileSync(filePath, 'utf-8'));
      expect(content.key).toBe('value');
    });
  });

  // @v: anc-exec-advance-to-caller
  describe('引擎消化无工具 body（节奏归引擎）', () => {
    const FENCE = '```';
    it('纯内置函数 body：run 一次直接 completed（引擎消化，零往返）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-body-'));
      const spec = `# Body Test
Id: body-test
## Goal
g
## Inputs
- raw: text  # in（原名 text——规则 27 类型名保留后改）
## Outputs
- report: text  # out
## Steps
1. [act] 规整
  - ← raw
  + → words: text  # 词
  + → wc: int  # 数
  > ${FENCE}hop_python
  > cleaned = strip(raw)
  > words = split(cleaned, ",")
  > wc = len(words)
  > ${FENCE}
2. [act] 报告
  - ← wc
  + → report: text  # 报告
  > ${FENCE}hop_python
  > report = "count=" + str(wc)
  > ${FENCE}
`;
      writeFileSync(join(dir, 'body.md'), spec);
      // 两个纯内置 body 步骤被引擎消化，run 一条直达 completed
      const result = runCliJson(`run body.md --state-dir state --params '{"raw":" a,b,c "}'`, dir);
      expect(result.status).toBe('completed');
      expect(result.outputs.report).toBe('count=3');
    });

    it('含工具调用 body：引擎解释至工具调用点发 tool_request', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-body2-'));
      const spec = `# Mixed
Id: mixed
## Goal
g
## Inputs
- u: text  # u
## Outputs
- out: text  # o
## Steps
1. [act] 纯计算
  - ← u
  + → host: text  # h
  > ${FENCE}hop_python
  > host = upper(u)
  > ${FENCE}
2. [act] 含工具
  - ← host
  + → out: text  # o
  > ${FENCE}hop_python
  > out = fetch(target: host)
  > ${FENCE}
`;
      writeFileSync(join(dir, 'm.md'), spec);
      // step1 纯计算被引擎消化；step2 含 fetch 工具——引擎解释 body 撞工具调用发 tool_request
      // （单工具介入，caller 不见 body 全文；2026-08-04 概念层原则 6 收紧）。 // @v: anc-exec-tool-request
      const next = runCliJson(`run m.md --state-dir state --params '{"u":"x.com"}'`, dir);
      expect(next.status).toBe('tool_request');
      expect(next.step_id).toBe('2');
      expect(next.tool).toBe('fetch');
      expect(next.args.target).toBe('X.COM');
      expect(next.tool_call_seq).toBe(1);
    });

    it('run 单命令：纯计算 spec 一条命令直达 completed（省 init 往返）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-run-'));
      const spec = `# Run Test
Id: run-test
## Goal
g
## Inputs
- raw: text  # in（原名 text——规则 27 类型名保留后改）
## Outputs
- report: text  # out
## Steps
1. [act] 规整
  - ← raw
  + → wc: int  # 数
  > ${FENCE}hop_python
  > wc = len(split(strip(raw), ","))
  > ${FENCE}
2. [act] 报告
  - ← wc
  + → report: text  # 报告
  > ${FENCE}hop_python
  > report = "count=" + str(wc)
  > ${FENCE}
`;
      writeFileSync(join(dir, 'r.md'), spec);
      const result = runCliJson(`run r.md --state-dir state --params '{"raw":" a,b,c "}'`, dir);
      expect(result.status).toBe('completed');
      expect(result.outputs.report).toBe('count=3');
    });

    it('tool_request 完整往返：--tool-result 注入后重放续跑至 completed', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-run2-'));
      const spec = `# Run Mixed
Id: run-mixed
## Goal
g
## Inputs
- u: text  # u
## Outputs
- out: text  # o
## Steps
1. [act] 纯计算
  - ← u
  + → host: text  # h
  > ${FENCE}hop_python
  > host = upper(u)
  > ${FENCE}
2. [act] 含工具
  - ← host
  + → out: text  # o
  > ${FENCE}hop_python
  > out = fetch(target: host)
  > ${FENCE}
`;
      writeFileSync(join(dir, 'rm.md'), spec);
      // 引擎解释 step2 body 至工具调用点发 tool_request；--tool-result 注入后重放续跑至 completed。
      // @v: anc-exec-tool-request
      const result = runCliJson(`run rm.md --state-dir state --params '{"u":"x.com"}'`, dir);
      expect(result.status).toBe('tool_request');
      expect(result.step_id).toBe('2');
      expect(result.tool).toBe('fetch');
      expect(result.args.target).toBe('X.COM');
      const done = runCliJson(
        `submit_and_fetch_next 2 --tool-result '"FETCHED:X.COM"' --state-dir state --instance ${result.instance_id}`, dir);
      expect(done.status).toBe('completed');
      expect(done.outputs.out).toBe('FETCHED:X.COM');   // 工具结果代入 out，输出由引擎组装
      // 完成清账（^anc-exec-tool-request journal 生命周期"步骤完成时清本步 journal"——
      // 2026-08-30 变异实锤该行为原先零测试保护：删掉 engine.ts 完成清账行 861 测试全绿）：
      // 步骤跑完后 state.json 不得残留本步 tool_journal，否则该步重试/重跑时会重放到旧结果。
      const stateAfter = JSON.parse(readFileSync(join(dir, 'state', done.instance_id, 'state.json'), 'utf-8'));
      expect(stateAfter.tool_journal?.['2']).toBeUndefined();
    });
  });
});

// @v: anc-exec-parallel-foreach-join-collect, anc-exec-parallel-foreach-barrier
// for-each parallel 的 join 收集端回归——bug:CLI join_parallel 用 getChildren(parallel) 收集，
// 对 for-each 只拿到模板 child（{P}.1），漏掉合成实例 {P}.2…{P}.N → 它们永远 running、
// 聚合列表残缺、下游空洞。现行口径=按 listVar 长度算期望合成 ID 集（漏 worker 拒 join）。
// 旧通道 CLI 回归测试已删（P0.5：join_parallel/fanout-plan/fanout-next 命令随通道退役）。

describe('CLI branch with [case] 描述 (条件) 写法 (regression)', () => {
  const BRANCH_SPEC = `# Branch Desc Test
Id: branch-desc
## Goal
测试带描述的 case 分流
## Inputs
- mode: line  # 模式
## Outputs
- picked: line  # 选中标记
## Steps
1. [branch] 按模式分流
  - ← mode
  + → picked: line  # 选中
  1.1. [case] 文档模式 (mode == "doc")
    + → picked: line  # mark
    1.1.1. [act] 标记 doc
      + → picked: line
      > pure
      > \`\`\`hop_python
      > picked = "doc-picked"
      > \`\`\`
  1.2. [case] 主题模式 (mode == "theme")
    + → picked: line  # mark
    1.2.1. [act] 标记 theme
      + → picked: line
      > pure
      > \`\`\`hop_python
      > picked = "theme-picked"
      > \`\`\`
2. [reason] 汇总
  - ← picked
  + → out: line  # final
  > 透传 picked
`;
  it('mode=doc → 选中 1.1, picked=doc-picked (描述被丢弃,只取括号内条件)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bdesc-d-'));
    writeFileSync(join(dir, 'b.md'), BRANCH_SPEC);
    const next = runCliJson(`run b.md --state-dir state --params '{"mode":"doc"}'`, dir);
    expect(next.status).toBe('step_ready');
    expect(next.step_id).toBe('2');
    expect(next.context.inputs.picked).toBe('doc-picked');
  });
  it('mode=theme → 选中 1.2, picked=theme-picked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bdesc-t-'));
    writeFileSync(join(dir, 'b.md'), BRANCH_SPEC);
    const next = runCliJson(`run b.md --state-dir state --params '{"mode":"theme"}'`, dir);
    expect(next.status).toBe('step_ready');
    expect(next.step_id).toBe('2');
    expect(next.context.inputs.picked).toBe('theme-picked');
  });

  // @v: anc-cli-install-skill
  // @v: anc-cli-pack
  describe('pack', () => {
    const REPO = resolve(__dirname, '..');
    it('打包 spec 成具名 skill（薄 SKILL.md + spec.md），description 取 goal 首行', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-'));
      const r = runCliJson(`pack "${join(REPO, 'examples/doc-review.md')}"`, dir);
      expect(r.status).toBe('ok');
      expect(r.skill_name).toBe('doc-review');
      const skillMd = readFileSync(join(dir, '.claude/skills/doc-review/SKILL.md'), 'utf-8');
      expect(skillMd).toContain('name: doc-review');
      expect(skillMd).not.toContain('description: 对文档进行多角度专家评审，输出优先问题清单和对焦决策 >'); // goal 续行不得混入 frontmatter
      expect(skillMd).toContain('document_path');              // 参数引导含 Inputs
      expect(skillMd).toContain('/hopspec run');               // 执行委托指向 hopspec 协议
      expect(existsSync(join(dir, '.claude/skills/doc-review/spec.md'))).toBe(true);
    });

    // @v: anc-cli-pack-version-floor
    it('前置段版本声明——两载体产物带打包时版本与升级指引,版本取 readPackageVersion 单点（hopissues/0051;变异重放:版本行改死字面量→单点一致断言红）', () => {
      // 单点真值:与 CLI 自报版本一致(dist 相对定位包根 package.json——pack 产物写的必须是同一个数)
      const pkgVersion = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')).version as string;
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-ver-'));
      runCliJson(`pack "${join(REPO, 'examples/doc-review.md')}"`, dir);
      const ccMd = readFileSync(join(dir, '.claude/skills/doc-review/SKILL.md'), 'utf-8');
      expect(ccMd).toContain(`版本 >= ${pkgVersion}`);                       // 打包时版本入壳
      expect(ccMd).toContain('npm i -g @hoplogic/hopjit@latest');            // 升级命令指路(只提示不默认升级,作者拍 A)
      const dir2 = mkdtempSync(join(tmpdir(), 'cli-pack-ver2-'));
      runCliJson(`pack "${join(REPO, 'examples/coffee-week.md')}" --carrier codex --assets coffee-sales.json`, dir2);
      const cxMd = readFileSync(join(dir2, '.agents/skills/coffee-week/SKILL.md'), 'utf-8');
      expect(cxMd).toContain(`版本 >= ${pkgVersion}`);                       // Codex 载体同款
      expect(cxMd).toContain('npm i -g @hoplogic/hopjit@latest');
    });

    // skill 版本注入（hopissues/0092——薄包装 frontmatter 原恒缺 version,消费方读空回退 unknown;
    // --skill-version 显式注入两载体,未传不写行且 note 提示,不设缺省值）。 // @v: anc-cli-pack
    it('正例：--skill-version 注入两载体 frontmatter version 行（0092）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-sv-'));
      const r = runCliJson(`pack "${join(REPO, 'examples/doc-review.md')}" --skill-version 2.6.5`, dir);
      expect(r.status).toBe('ok');
      const ccMd = readFileSync(join(dir, '.claude/skills/doc-review/SKILL.md'), 'utf-8');
      expect(ccMd).toMatch(/^version: 2\.6\.5$/m);
      const fm = ccMd.split('---')[1];                          // frontmatter 块内(非正文提及)
      expect(fm).toContain('version: 2.6.5');
      const dir2 = mkdtempSync(join(tmpdir(), 'cli-pack-sv2-'));
      runCliJson(`pack "${join(REPO, 'examples/coffee-week.md')}" --carrier codex --assets coffee-sales.json --skill-version 1.0.0`, dir2);
      const cxFm = readFileSync(join(dir2, '.agents/skills/coffee-week/SKILL.md'), 'utf-8').split('---')[1];
      expect(cxFm).toContain('version: 1.0.0');
    });

    it('正例：未传 --skill-version → frontmatter 无 version 行且 note 提示（不静默不编造）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-nosv-'));
      const r = runCliJson(`pack "${join(REPO, 'examples/doc-review.md')}"`, dir);
      expect(r.status).toBe('ok');
      const fm = readFileSync(join(dir, '.claude/skills/doc-review/SKILL.md'), 'utf-8').split('---')[1];
      expect(fm).not.toContain('version:');
      expect(String(r.note ?? '')).toContain('--skill-version');
    });

    it('doc-ref 知识文档随包拷入', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-k-'));
      const r = runCliJson(`pack "${join(REPO, 'scripts/audit/anchor-audit.md')}"`, dir);
      expect(r.knowledge_docs).toContain('anchor-audit-knowledge.md');
      expect(existsSync(join(dir, '.claude/skills/anchor-audit/anchor-audit-knowledge.md'))).toBe(true);
    });

    // hopissues/0077——pack 原恒不传 doc-ref 上下文,P15 空转:知识缺失 validate 报 error 而
    // pack 照 ok 写产物(打包假绿,装上即 P15)。修=validate 闸门带上下文 error 即拒+知识收集
    // 面缺失响亮拒。// @v: anc-cli-pack
    it('反例(0077)：doc-ref 知识文件缺失 → pack 拒且不写产物（修前 status=ok 假绿）', () => {
      const srcDir = mkdtempSync(join(tmpdir(), 'cli-pack-77s-'));
      writeFileSync(join(srcDir, 'leaf.md'), `# Leaf
Id: leaf-77
## Goal
G
## Steps
1. [reason] 按判据干
  + → out1: text  # 产出
  > 引擎已自动注入（doc-ref）：
  > [[knowledge#Rule]]
`);
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-77-'));
      const { stdout, exitCode } = runCli(`pack "${join(srcDir, 'leaf.md')}"`, dir);
      const r = JSON.parse(stdout);
      expect(r.status).toBe('error');
      expect(JSON.stringify(r)).toContain('P15');
      expect(existsSync(join(dir, '.claude/skills/leaf-77/spec.md'))).toBe(false);   // 不写产物
    });
    it('反例(0077)：知识文件在但章节缺失 → 同拒（P15 章节未匹配形态）', () => {
      const srcDir = mkdtempSync(join(tmpdir(), 'cli-pack-77c-'));
      writeFileSync(join(srcDir, 'knowledge.md'), '# 知识\n\n## 别的节\n\n内容。\n');
      writeFileSync(join(srcDir, 'leaf.md'), `# Leaf
Id: leaf-77c
## Goal
G
## Steps
1. [reason] 按判据干
  + → out1: text  # 产出
  > 引擎已自动注入（doc-ref）：
  > [[knowledge#Rule]]
`);
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-77c2-'));
      const { stdout } = runCli(`pack "${join(srcDir, 'leaf.md')}"`, dir);
      expect(JSON.parse(stdout).status).toBe('error');
    });
    it('反例(0077 第二道闸)：知识文件在 cwd 可 validate 但不在 spec 同目录 → pack 拒（review 面三变异实证:删 missingDocs 拒后 status=ok 产物缺 knowledge.md——正是"装上即 P15"假绿真身;第一道闸带 cwd 上下文放行,唯第二道闸拦得住）', () => {
      const srcDir = mkdtempSync(join(tmpdir(), 'cli-pack-77d-'));
      writeFileSync(join(srcDir, 'leaf.md'), `# Leaf
Id: leaf-77d
## Goal
G
## Steps
1. [reason] 按判据干
  + → out1: text  # 产出
  > 引擎已自动注入（doc-ref）：
  > [[knowledge#Rule]]
`);
      const cwdDir = mkdtempSync(join(tmpdir(), 'cli-pack-77d2-'));
      // 知识放 cwd 不放 spec 同目录——validate 的解析上下文(workspace=cwd)能找到,打包却带不走
      writeFileSync(join(cwdDir, 'knowledge.md'), '# 知识\n\n## Rule\n\n判据。\n');
      const { stdout } = runCli(`pack "${join(srcDir, 'leaf.md')}"`, cwdDir);
      const r = JSON.parse(stdout);
      expect(r.status).toBe('error');
      expect(JSON.stringify(r)).toContain('不在 spec 同目录');
    });
    it('正例(0077)：知识齐全 → pack 照过且知识随包（零回归——既有拷入钉的对照面）', () => {
      const srcDir = mkdtempSync(join(tmpdir(), 'cli-pack-77g-'));
      writeFileSync(join(srcDir, 'knowledge.md'), '# 知识\n\n## Rule\n\n判据内容。\n');
      writeFileSync(join(srcDir, 'leaf.md'), `# Leaf
Id: leaf-77g
## Goal
G
## Steps
1. [reason] 按判据干
  + → out1: text  # 产出
  > 引擎已自动注入（doc-ref）：
  > [[knowledge#Rule]]
`);
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-77g2-'));
      const r = runCliJson(`pack "${join(srcDir, 'leaf.md')}"`, dir);
      expect(r.status).toBe('ok');
      expect(existsSync(join(dir, '.claude/skills/leaf-77g/knowledge.md'))).toBe(true);
    });

    it('坏 spec 不放行（validate 闸门）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-bad-'));
      writeFileSync(join(dir, 'bad.md'), '# Spec: 坏\nGoal: 无步骤\n');
      const { stdout, exitCode } = runCli('pack bad.md', dir);
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain('"status":"error"');
    });

    it('幂等：存在不覆盖，--force 覆盖', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-idem-'));
      runCliJson(`pack "${join(REPO, 'examples/doc-review.md')}"`, dir);
      const r2 = runCliJson(`pack "${join(REPO, 'examples/doc-review.md')}"`, dir);
      expect(r2.installed).toEqual([]);
      const r3 = runCliJson(`pack "${join(REPO, 'examples/doc-review.md')}" --force`, dir);
      expect(r3.installed.length).toBeGreaterThan(0);
    });

    // v0.5.0 --assets：数据资产拷入 skill 目录，skill 自包含可跑
    it('--assets 拷入数据资产（coffee-week + coffee-sales.json）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-assets-'));
      const r = runCliJson(`pack "${join(REPO, 'examples/coffee-week.md')}" --assets coffee-sales.json`, dir);
      expect(r.status).toBe('ok');
      expect(r.assets).toEqual(['coffee-sales.json']);
      expect(existsSync(join(dir, '.claude/skills/coffee-week/coffee-sales.json'))).toBe(true);
    });

    // @v: anc-cli-pack, anc-driver-codex-install-layout
    it('--carrier codex 生成 $skill 包装，不混入 CC 原语', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-codex-'));
      const r = runCliJson(`pack "${join(REPO, 'examples/coffee-week.md')}" --carrier codex --assets coffee-sales.json`, dir);
      expect(r.status).toBe('ok');
      expect(r.carrier).toBe('codex');
      const skillDir = join(dir, '.agents/skills/coffee-week');
      const skillMd = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
      expect(skillMd).toContain('# $coffee-week');
      expect(skillMd).toContain('~/.codex/skills/hopspec/SKILL.md');   // 薄包装定位句(看齐批:用户级为主+项目级兜底,不再硬编码 ../hopspec 相对跳)
      expect(skillMd).not.toContain('/hopspec run');
      expect(skillMd).not.toContain('AskUserQuestion');
      expect(existsSync(join(skillDir, 'spec.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'coffee-sales.json'))).toBe(true);
    });

    // @v: anc-cli-pack —— 资产条目录形态（2026-09-04 扩,hopissues/0069）：整树递归拷入保持相对路径,
    // 多文件 skill 的 references/、scripts/ 附属资产按目录点名,产物内指针原样可解析
    it('--assets 目录条目整树递归拷入（多文件 skill 附属资产形态）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-assets-dir-'));
      const specDir = mkdtempSync(join(tmpdir(), 'cli-pack-srcdir-'));
      cpSync(join(REPO, 'examples/coffee-week.md'), join(specDir, 'coffee-week.md'));
      cpSync(join(REPO, 'examples/coffee-sales.json'), join(specDir, 'coffee-sales.json'));
      mkdirSync(join(specDir, 'references', 'base'), { recursive: true });
      writeFileSync(join(specDir, 'references', 'workflows.md'), '# 工作流细节', 'utf-8');
      writeFileSync(join(specDir, 'references', 'base', 'rules.yaml'), 'rule: 1', 'utf-8');
      const r = runCliJson(`pack "${join(specDir, 'coffee-week.md')}" --assets coffee-sales.json,references`, dir);
      expect(r.status).toBe('ok');
      const skillDir = join(dir, '.claude/skills/coffee-week');
      expect(existsSync(join(skillDir, 'coffee-sales.json'))).toBe(true);
      expect(existsSync(join(skillDir, 'references/workflows.md'))).toBe(true);            // 目录直下文件
      expect(existsSync(join(skillDir, 'references/base/rules.yaml'))).toBe(true);         // 嵌套子目录保持结构
    });

    // 防呆：资产缺失即拒，不产出装上就跑不了的 skill
    it('--assets 缺失文件即 error 拒 pack', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-assets-miss-'));
      const { stdout, exitCode } = runCli(`--json pack "${join(REPO, 'examples/coffee-week.md')}" --assets no-such.json`, dir);
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain('"status":"error"');
      expect(stdout).toContain('no-such.json');
      expect(existsSync(join(dir, '.claude/skills/coffee-week'))).toBe(false);   // 半成品目录也不留
    });
  });

  // @v: anc-cli-install-skill —— v0.5.0 --demo：附装 /coffee-week 演示 skill（默认不装）
  describe('install-skill --demo', () => {
    it('默认不装 demo；--demo 附装 demo 集全部成员（demo- 前缀）', () => {
      const dir1 = mkdtempSync(join(tmpdir(), 'cli-isk-nodemo-'));
      runCliJson('install-skill --dir sk', dir1);
      expect(existsSync(join(dir1, 'sk/demo-coffee-week'))).toBe(false);

      const dir2 = mkdtempSync(join(tmpdir(), 'cli-isk-demo-'));
      const r = runCliJson('install-skill --dir sk --demo', dir2);
      expect(r.status).toBe('ok');
      expect(existsSync(join(dir2, 'sk/demo-coffee-week/SKILL.md'))).toBe(true);
      expect(existsSync(join(dir2, 'sk/demo-coffee-week/spec.md'))).toBe(true);
      expect(existsSync(join(dir2, 'sk/demo-coffee-week/coffee-sales.json'))).toBe(true);
      expect(existsSync(join(dir2, 'sk/demo-fact-check/SKILL.md'))).toBe(true);
      expect(existsSync(join(dir2, 'sk/demo-fact-check/fact-check-sample.md'))).toBe(true);
      expect(existsSync(join(dir2, 'sk/demo-rename/SKILL.md'))).toBe(true);
      expect((r.installed as string[]).some(p => p.includes('demo-coffee-week'))).toBe(true);
      expect((r.installed as string[]).some(p => p.includes('demo-fact-check'))).toBe(true);
      expect((r.installed as string[]).some(p => p.includes('demo-rename'))).toBe(true);
    });

    it('codex 载体带 --demo：附装 $demo-* 全集（正式件落 --dir=skills 根,demo 恒项目级落 cwd）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-isk-demo-codex-'));
      const r = runCliJson(`install-skill --carrier codex --dir ${join(dir, 'sk')} --demo`, dir);
      expect(r.status).toBe('ok');
      expect(existsSync(join(dir, 'sk/hopspec/SKILL.md'))).toBe(true);
      const demoDir = join(dir, '.agents/skills/demo-coffee-week');
      expect(existsSync(join(demoDir, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(demoDir, 'spec.md'))).toBe(true);
      expect(existsSync(join(demoDir, 'coffee-sales.json'))).toBe(true);
      expect(readFileSync(join(demoDir, 'SKILL.md'), 'utf-8')).toContain('# $demo-coffee-week');
      expect(existsSync(join(dir, '.agents/skills/demo-fact-check/SKILL.md'))).toBe(true);
    });
  });

  // @v: anc-exec-tool-request —— 跨进程确定性重放（journal 持久化 + 多工具顺序）
  describe('tool_request 跨进程重放', () => {
    const FENCE = '```';
    it('双工具 body：两次挂起各自独立进程注入，seq 递增，最终输出由引擎组装', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-tr2-'));
      const spec = `# Two Tools
Id: two-tools
## Goal
g
## Inputs
- u: text  # u
## Outputs
- out: text  # o
## Steps
1. [act] 双工具
  - ← u
  + → out: text  # o
  > ${FENCE}hop_python
  > a = fetch(target: u)
  > b = enrich(data: a)
  > out = a + ":" + b
  > ${FENCE}
`;
      writeFileSync(join(dir, 't.md'), spec);
      const r1 = runCliJson(`run t.md --state-dir state --params '{"u":"x"}'`, dir);
      expect(r1.status).toBe('tool_request');
      expect(r1.tool).toBe('fetch');
      expect(r1.tool_call_seq).toBe(1);
      // 新进程注入第 1 个工具结果 → 重放代入 → 挂起在第 2 个工具
      const r2 = runCliJson(`submit_and_fetch_next 1 --tool-result '"A"' --state-dir state --instance ${r1.instance_id}`, dir);
      expect(r2.status).toBe('tool_request');
      expect(r2.tool).toBe('enrich');
      expect(r2.tool_call_seq).toBe(2);
      expect(r2.args.data).toBe('A');   // 第 1 个结果已代入第 2 个调用的参数求值
      // 注入第 2 个 → body 跑完，引擎组装输出
      const r3 = runCliJson(`submit_and_fetch_next 1 --tool-result '"B"' --state-dir state --instance ${r1.instance_id}`, dir);
      expect(r3.status).toBe('completed');
      expect(r3.outputs.out).toBe('A:B');
    });

    // @v: anc-cli-json-io, anc-exec-advance-to-caller, anc-exec-tool-request
    it('data-quality 全链：每次状态推进都返回非空单行 JSON', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-data-quality-io-'));
      const specPath = join(PROJECT_ROOT, 'examples/data-quality.md');
      const rawData = JSON.parse(readFileSync(join(PROJECT_ROOT, 'examples/demo-data.json'), 'utf-8'));
      writeFileSync(join(dir, 'params.json'), JSON.stringify({ raw_data: rawData, quality_threshold: 0.8 }));

      const runJson = (args: string): any => {
        const result = runCli(args, dir);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toBe('');
        return JSON.parse(result.stdout);
      };
      const submitFile = (response: any, payload: unknown, option: '--tool-result' | '--output'): any => {
        writeFileSync(resolve(dir, response.output_path), JSON.stringify(payload));
        return runJson(
          `submit_and_fetch_next ${response.step_id} ${option} "@${response.output_path}" `
          + `--state-dir state --instance ${response.instance_id}`,
        );
      };

      const t1 = runJson(`run "${specPath}" --state-dir state --params @params.json`);
      expect(t1.status).toBe('tool_request');
      expect(t1.tool_call_seq).toBe(1);

      const t2 = submitFile(t1, { id: 0, amount: 1, qty: 1, unit_price: 0, region: 1 }, '--tool-result');
      expect(t2.status).toBe('tool_request');
      expect(t2.tool_call_seq).toBe(2);

      const t3 = submitFile(t2, { amount: 1, qty: 0, unit_price: 0 }, '--tool-result');
      expect(t3.status).toBe('tool_request');
      expect(t3.tool_call_seq).toBe(3);

      const t4 = submitFile(t3, { amount_equals_qty_times_unit_price: 3 }, '--tool-result');
      expect(t4.status).toBe('tool_request');
      expect(t4.tool_call_seq).toBe(4);

      const s2 = submitFile(t4, {
        total_records: 12,
        missing_counts: { amount: 1, qty: 1, region: 1 },
        outlier_counts: { amount: 1 },
        rule_violation_counts: { amount_equals_qty_times_unit_price: 3 },
      }, '--tool-result');
      expect(s2.status).toBe('step_ready');
      expect(s2.step_id).toBe('2');

      const s31 = submitFile(s2, { fix_strategy: 'Use deterministic field rules.' }, '--output');
      expect(s31.status).toBe('step_ready');
      expect(s31.step_id).toBe('3.1');

      // 3.2 判定步已 body 化（a6dc9504 双模式化批：五公式引擎直执零 LLM）——3.1 提交后引擎
      // 直接消化 3.2 的 check body，下一介入点是步骤 4。clean_data 用 rawData 原样（含 null/
      // 离群/违例）会判不达标，这里喂修净形态让 body 算出达标走通主链。
      const cleanData = rawData.map((r: Record<string, unknown>) => ({
        id: r.id ?? 'r-fix', region: r.region ?? 'east',
        amount: 100, qty: 2, unit_price: 50,
      }));
      const s4 = submitFile(s31, {
        clean_data: cleanData,
        repair_summary: 'No-op fixture repair for CLI JSON I/O verification.',
      }, '--output');
      expect(s4.status).toBe('step_ready');
      expect(s4.step_id).toBe('4');

      const completed = submitFile(s4, { quality_report: '# test report' }, '--output');
      expect(completed.status).toBe('completed');
      expect(completed.outputs.quality_report).toBe('# test report');
    });

    it('对非 tool_request 状态用 --tool-result → INVALID_STATE', () => {
      const { dir, specFile } = setupWorkDir();
      const init = runCliJson(`init ${specFile} --state-dir state`, dir);
      const { stdout } = runCli(`submit_and_fetch_next 1 --tool-result '"x"' --state-dir state --instance ${init.instance_id}`, dir);
      expect(stdout).toContain('INVALID_STATE');
    });
  });

  describe('install-skill', () => {
    it('展开 CC skill 布局（改名 SKILL.md + references；--dir 显式指定——缺省目录另有正例）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-installskill-'));
      const r = runCliJson(`install-skill --dir ${join(dir, '.claude/skills')}`, dir);
      expect(r.status).toBe('ok');
      expect(r.carrier).toBe('cc');
      // 版本可见性：响应带 driver_version/source；SKILL.md frontmatter 后有版本戳
      expect(r.driver_version).toMatch(/^\d+\.\d+\.\d+/);
      expect(r.driver_source).toBeTruthy();
      const hopspecSkill = readFileSync(join(dir, '.claude/skills/hopspec/SKILL.md'), 'utf-8');
      expect(hopspecSkill).toMatch(/^---\n[\s\S]*?\n---\n<!-- driver: @hoplogic\/hopjit v/);
      const hopskillBuild = readFileSync(join(dir, '.claude/skills/hopbuild/SKILL.md'), 'utf-8');
      expect(hopskillBuild).toMatch(/^---\n[\s\S]*?\n---\n<!-- driver: @hoplogic\/hopjit v/);
      // 主 skill 改名为 SKILL.md、references 随拷、hopbuild 整目录
      expect(existsSync(join(dir, '.claude/skills/hopspec/SKILL.md'))).toBe(true);
      expect(existsSync(join(dir, '.claude/skills/hopspec/references/cli-discovery.md'))).toBe(true);
      expect(existsSync(join(dir, '.claude/skills/hopbuild/SKILL.md'))).toBe(true);
      // hopbuild2 同批分发（^anc-build-layout2）——五文件同目录随行（call 同目录寻址+doc-ref 同目录读）
      const hb2 = readFileSync(join(dir, '.claude/skills/hopbuild2/SKILL.md'), 'utf-8');
      expect(hb2).toMatch(/^---\n[\s\S]*?\n---\n<!-- driver: @hoplogic\/hopjit v/);   // 壳带版本戳
      for (const f of ['spec.md', 'split-node.md', 'split-structure.md', 'split-patterns.md']) {
        expect(existsSync(join(dir, '.claude/skills/hopbuild2', f))).toBe(true);
      }
    });

    it('幂等：再跑不覆盖（installed 空 + note）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-installskill-idem-'));
      // 显式 --dir——缺省现指用户级 ~/.claude/skills,测试不得真写用户目录
      runCliJson(`install-skill --dir ${join(dir, 'sk')}`, dir);
      const r2 = runCliJson(`install-skill --dir ${join(dir, 'sk')}`, dir);
      expect(r2.status).toBe('ok');
      expect(r2.installed).toHaveLength(0);
      expect(r2.note).toBeTruthy();
    });

    // @v: anc-driver-codex-install-layout
    it('codex 载体 --dir=skills 根展开 main/segment-driver 布局（2026-08-27 看齐批:缺省用户级 ~/.codex/skills,测试恒显式 --dir 防写真实家目录）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-installskill-codex-'));
      const r = runCliJson(`install-skill --carrier codex --dir ${join(dir, 'sk')}`, dir);
      expect(r.status).toBe('ok');
      expect(r.carrier).toBe('codex');
      expect(realpathSync(r.target)).toBe(realpathSync(join(dir, 'sk')));
      const skillDir = join(dir, 'sk/hopspec');
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8'))
        .toMatch(/^---\n[\s\S]*?\n---\n<!-- driver: @hoplogic\/hopjit v/);
      expect(existsSync(join(skillDir, 'agents/segment-driver.md'))).toBe(true);
      // parallel-worker.md 已随旧通道退役（P0.5 统一模型）——不再随包安装
      expect(existsSync(join(skillDir, 'agents/parallel-worker.md'))).toBe(false);
      // @v: anc-cli-json-io
      expect(readFileSync(join(skillDir, 'agents/segment-driver.md'), 'utf-8'))
        .toContain('<CLI> --json run');
      expect(readFileSync(join(skillDir, 'references/execution-rules.md'), 'utf-8'))
        .toContain('<CLI> --json submit_and_fetch_next');
      expect(readdirSync(join(skillDir, 'references')).filter(f => f.endsWith('.md')).sort()).toEqual([
        'cli-discovery.md',
        'discovery.md',
        'execution-rules.md',
      ]);   // batch-fanout.md 已随旧通道退役（P0.5）;.hopjit-manifest.json 是装置元数据（0022 受管清单）不入 skill 内容断言
      expect(existsSync(join(skillDir, 'references/driver-subagent.md'))).toBe(false);
      expect(existsSync(join(skillDir, 'references/parallel-worker.md'))).toBe(false);
      // 构建工具两件随装（hopissues/0052——修前 codex 分支漏拷,两载体清单不对等;
      // 与 CC 同源同戳:SKILL.md 带版本戳）。变异重放:删 codex 分支两段 copyDir → 本四断言红。
      // @v: anc-cli-install-skill
      expect(existsSync(join(dir, 'sk/hopbuild/SKILL.md'))).toBe(true);
      expect(readFileSync(join(dir, 'sk/hopbuild/SKILL.md'), 'utf-8'))
        .toMatch(/^---\n[\s\S]*?\n---\n<!-- driver: @hoplogic\/hopjit v/);
      expect(existsSync(join(dir, 'sk/hopbuild2/SKILL.md'))).toBe(true);
      expect(existsSync(join(dir, 'sk/hopbuild2/spec.md'))).toBe(true);   // 五文件同目录随行的抽查件
      expect(existsSync(join(skillDir, 'references/step-execution-rules.md'))).toBe(false);
      // 不再写项目根 AGENTS.md（那是用户的项目指令文件）
      expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    });

    it('codex 安装幂等，--force 可覆盖新布局中的已有文件', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-installskill-codex-force-'));
      const skillPath = join(dir, 'out/hopspec/SKILL.md');
      runCliJson('install-skill --carrier codex --dir out', dir);
      writeFileSync(skillPath, 'user-customized', 'utf-8');

      const skipped = runCliJson('install-skill --carrier codex --dir out', dir);
      expect(skipped.installed).toHaveLength(0);
      expect(skipped.note).toBeTruthy();
      expect(readFileSync(skillPath, 'utf-8')).toBe('user-customized');

      const forced = runCliJson('install-skill --carrier codex --dir out --force', dir);
      expect(forced.installed.length).toBeGreaterThan(0);
      expect(readFileSync(skillPath, 'utf-8')).toContain('# hopspec - Codex Main Orchestrator');
    });

    // 回归：全局装时 bin 是软链，isMain 判断须 realpathSync 解析软链，否则 parseAsync 不跑、
    // 所有命令空跑 exit 0（真机全局 hopjit 触发）。此处经软链执行 cli.js 复现并验证修复。
    it('经软链执行（模拟全局 bin）命令仍生效', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-symlink-'));
      const link = join(dir, 'hopjit-link');
      symlinkSync(CLI, link);
      // 通过软链跑 install-skill——修复前 isMain=false → 空跑 exit 0 不建目录
      const stdout = execSync(`node "${link}" --json install-skill --dir out`, { cwd: dir, encoding: 'utf-8', timeout: 5000 }).trim();
      const r = JSON.parse(stdout);
      expect(r.status).toBe('ok');
      expect(existsSync(join(dir, 'out/hopspec/SKILL.md'))).toBe(true);
    });
  });

  // @v: anc-cli-version-single-source
  // --version 必须等于包 package.json 的 version——0.1.1 发布时 CLI 仍自报硬编码的 0.1.0，
  // 就因为版本号有两份真值且无测试锁住。此用例把"单一事实源"变成红灯保护。
  describe('--version 单一事实源', () => {
    it('CLI 自报版本 === package.json 的 version', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-version-'));
      const { stdout, exitCode } = runCli('--version', dir);
      expect(exitCode).toBe(0);
      // CLI 常量已指向 dist/cli.js（见文件头），据此定位包根 package.json
      const pkgVersion = (JSON.parse(
        readFileSync(resolve(CLI, '..', '..', 'package.json'), 'utf-8'),
      ) as { version: string }).version;
      expect(stdout.trim()).toBe(pkgVersion);
      // 反向锁：不得是任何硬编码字面量（若有人退回写死值，此断言配合上一条即失败）
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
});

// HopLog 恒开：run 不带 --log-dir 时缺省 <state-dir>/../.hoplog（hop-cli v0.6.1,
// 2026-08-08 E2E 实撞后引擎侧恒开——此前零测试,语义审计 ❌）。// @v: anc-obs-hoplog-always-on
describe('HopLog 恒开缺省', () => {
  it('run 省略 --log-dir 仍产生 .hoplog 轨迹', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-alwayson-'));
    writeFileSync(join(dir, 's.md'), `# AO
## Goal
G
## Steps
1. [reason] 想
  + → out: text
  > t
`);
    const r = runCliJson('run s.md --state-dir st', dir);
    expect(r.status).toBe('step_ready');
    // 缺省落点 = <state-dir>/../.hoplog = <dir>/.hoplog
    expect(existsSync(join(dir, '.hoplog'))).toBe(true);
    const runs = readdirSync(join(dir, '.hoplog'));
    expect(runs.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, '.hoplog', runs[0], 'main.yaml'))).toBe(true);
  });
});

// ===== F类测试缺口补齐（2026-08-08 语义审计 c2t ⚠️，hop-cli 批）=====

// @v: anc-cli-validate-response —— validate 命令子进程路径此前零测试
// CLI 坏输入反例组（2026-08-17 作者定'错误分支需要用反例测试,不是刷数字'——覆盖率盘点
// 抓三个零测试错误分支;DEPTH_EXCEEDED/CALL_PROTOCOL_MISUSE 已有子进程测试不在此列）。
// @v: anc-cli-dispatch, anc-cli-validate-response, anc-cli-list
describe('CLI 坏输入反例（进程内,errorExit 路径）', () => {
  function withExitSpy(fn: () => Promise<void>): Promise<void> {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`EXIT:${c}`); }) as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return fn().finally(() => { exitSpy.mockRestore(); errSpy.mockRestore(); });
  }
  const stderrText = () => (vi.mocked(process.stderr.write).mock.calls ?? []).map(c => String(c[0])).join('');

  it('反例：reap_and_fetch_next --status 非法值 → INVALID_ARG 响亮拒（不静默按 completed）', () => withExitSpy(async () => {
    await expect(program.parseAsync(['node', 'hopjit', '--json', 'reap_and_fetch_next', '1.1', '--status', 'done', '--state-dir', 'nope']))
      .rejects.toThrow(/EXIT:1/);
    expect(stderrText()).toContain('INVALID_ARG');
    expect(stderrText()).toContain("'done'");   // 报文含收到的坏值,指错方向可辨
  }));

  it('反例：validate 目标文件不存在 → 显式失败（ENOENT 原文,不吞成空报告）', () => withExitSpy(async () => {
    await expect(program.parseAsync(['node', 'hopjit', '--json', 'validate', '/nonexistent/ghost-spec.md']))
      .rejects.toThrow(/EXIT:1/);
    expect(stderrText()).toMatch(/ENOENT|no such file/i);
  }));

  it('反例：list 目标目录不存在 → 显式失败（不吞成空清单）', () => withExitSpy(async () => {
    await expect(program.parseAsync(['node', 'hopjit', '--json', 'list', '/nonexistent/ghost-dir']))
      .rejects.toThrow(/EXIT:1/);
    expect(stderrText()).toMatch(/ENOENT|no such file/i);
  }));
});

describe('validate 命令响应结构', () => {
  it('合法 spec → status ok + errors 空 + warn 分入 warnings 桶', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopcli-validate-'));
    // 无终止路径的 loop → C5 warn(非 error):status 仍 ok 但 warnings 非空
    writeFileSync(join(dir, 'spec.md'), `# V
## Goal
g
## Steps
1. [loop] 无终止
  1.1. [reason] 干
    + → out: text
    > t
`);
    const r = runCliJson('validate spec.md', dir);
    expect(r.status).toBe('ok');
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w: any) => w.rule === 'C5')).toBe(true);
  });

  it('解析失败 → parseError 短路:status error 且不进规则校验', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopcli-validate2-'));
    writeFileSync(join(dir, 'spec.md'), `# Bad
## Steps
1. [nonsense_type] 未知类型
  + → out: text
`);
    const r = runCliJson('validate spec.md', dir);
    expect(r.status).toBe('error');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.warnings).toEqual([]);
  });

  // @v: anc-rule-p15 — validate 命令生产路径递文件访问上下文（2026-08-20 实撞立:原恒传
  // undefined,P15 静默跳过,坏 doc-ref 报"通过"假绿——audit spec 即中招）
  it('反例（原假绿形态）:doc-ref 指向不存在文件 → validate 即报 P15 error（不再静默跳过）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopcli-p15-'));
    writeFileSync(join(dir, 'spec.md'), `# P
## Goal
g
## Steps
1. [reason] 想 参考 [[ghost-knowledge#不存在的判据]]
  + → out: text
  > t 参考 [[ghost-knowledge#不存在的判据]]
`);
    const r = runCliJson('validate spec.md', dir);
    expect(r.status).toBe('error');
    expect(r.errors.some((e: any) => e.rule === 'P15')).toBe(true);
  });

  it('正例:doc-ref 指向 spec 同目录知识文档 → validate 过（P15 两级基准第一级）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopcli-p15ok-'));
    writeFileSync(join(dir, 'knowledge.md'), '## 判据\n正文\n');
    writeFileSync(join(dir, 'spec.md'), `# P
## Goal
g
## Steps
1. [reason] 想 见 [[knowledge#判据]]
  + → out: text
  > t 见 [[knowledge#判据]]
`);
    const r = runCliJson('validate spec.md', dir);
    expect(r.status).toBe('ok');
  });

  // @v: anc-rule-fragment-mode —— CLI --fragment 通道钉（parseFragment 解析面直钉在
  // parser.test.ts,片段验证豁免面在 validator.test.ts;本钉锁 CLI validate --fragment 端到端）
  it('正例:--fragment 无文件身份 → P15 维持缺席跳过（不误拒片段）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopcli-p15frag-'));
    writeFileSync(join(dir, 'frag.md'), `1. [reason] 想 见 [[ghost#judge]]
  + → out: text
  > t 见 [[ghost#judge]]
`);
    const r = runCliJson('validate frag.md --fragment', dir);
    expect(r.errors.some((e: any) => e.rule === 'P15')).toBe(false);
  });
});

// 值内注入字符(引号/冒号/井号/换行)经 --json 输出往返不破坏结构——转义权威=JSON.stringify
// 禁手拼(ARCHITECTURE 转义规范;0086 审计:此前零注入字符回归用例)。 // @v: anc-string-escape
describe('输出转义注入字符回归（0086 补钉）', () => {
  it('正例：变量值含引号/冒号/井号/换行 → --json 回读 JSON.parse 无损往返', () => {
    const { dir, specFile } = setupWorkDir();
    const run = runCliJson(`run ${specFile} --state-dir state`, dir);
    const evil = 'a"b: c#d\ne\'f'.replace("\\n","\n");
    const wz = join(dir, 'state', run.instance_id, 'work_zone');
    writeFileSync(join(wz, 'o.json'), JSON.stringify({ result: evil }));
    const next = runCliJson(`submit_and_fetch_next ${run.step_id} --output @state/${run.instance_id}/work_zone/o.json --state-dir state --instance ${run.instance_id}`, dir);
    expect(['step_ready','completed']).toContain(next.status);
    const vars = runCliJson(`vars --state-dir state --instance ${run.instance_id}`, dir);
    expect(vars.variables.result).toBe(evil);
  });
});

// @v: anc-cli-json-io —— 缺省(无 --json)输出 YAML 人读格式,此前全部测试只走 --json
describe('缺省 YAML 输出（无 --json）', () => {
  it('validate 不带 --json → 输出 YAML 非 JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopcli-yaml-'));
    writeFileSync(join(dir, 'spec.md'), `# Y
## Goal
g
## Steps
1. [reason] 想
  + → out: text
  > t
`);
    const stdout = execSync(`node "${CLI}" validate spec.md`, {
      cwd: dir, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOPJIT_OUTPUT: '' },
    }).trim();
    expect(() => JSON.parse(stdout)).toThrow();       // 不是单行 JSON
    expect(stdout).toContain('status: ok');           // 是 YAML key: value
  });
});

// 旧通道 worker run 入口（--parallel-parent/--parallel-child）裸 @params 隔离测试已删
// （P0.5：worker 启动路径随通道退役，P2 渐进协议重建时按新形态补测）。

describe('init warnings 透传', () => {
  it('C5 warn spec → init ok 且 warnings 数组携带 rule/message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopcli-initwarn-'));
    writeFileSync(join(dir, 'spec.md'), `# W
## Goal
g
## Steps
1. [loop] 无终止
  1.1. [reason] 干
    + → out: text
    > t
`);
    const r = runCliJson('init spec.md --state-dir state', dir);
    expect(r.status).toBe('ok');
    expect(Array.isArray(r.warnings)).toBe(true);
    const c5 = r.warnings.find((w: any) => w.rule === 'C5');
    expect(c5).toBeDefined();
    expect(c5.severity).toBe('warn');
  });
});

// @v: anc-exec-call-auto-map, anc-exec-call-depth-check
describe('复用模式 call：engine 侧 Inputs 自动映射 + 运行时 depth 检查', () => {
  const CALLER_SPEC = `# Caller
Id: caller

## Goal
调子 spec

## Inputs
- base: int  # 底数

## Outputs
- result: int  # 结果

## Steps
1. [act] 备料
  - ← base
  + → prepared: int  # 备好的数
  > 纯计算
  > \`\`\`hop_python
  > prepared = base + 1
  > \`\`\`
2. [call double(n: prepared)] 调翻倍
  + → result: doubled  # 映射
`;
  const CALLEE_SPEC = `# Double
Id: double

## Goal
翻倍

## Inputs
- n: int  # 数

## Outputs
- doubled: int  # 结果

## Steps
1. [act] 翻倍
  - ← n
  + → doubled: int  # 结果
  > 纯计算
  > \`\`\`hop_python
  > doubled = n * 2
  > \`\`\`
`;

  function setupCallDir(): { dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cli-call-'));
    writeFileSync(join(dir, 'caller.md'), CALLER_SPEC);
    writeFileSync(join(dir, 'double.md'), CALLEE_SPEC);
    return { dir };
  }

  // @v: anc-cli-instance-resolve — call-parent 通路同经校验网（review 面二抓:初版收纯只在
  // --instance 通路,--call-parent 直调 load 绕过校验,错号父实例仍报 CORRUPT_STATE_FILE 旧病）
  it('反例：init --parent 传不存在的父实例号 → INSTANCE_NOT_FOUND 指路,不再报 CORRUPT_STATE_FILE', () => {
    const { dir } = setupCallDir();
    runCliJson('run caller.md --state-dir state', dir);   // 建一个真实实例供指路
    const r = runCli('--json init double.md --parent no-such-parent --step 2 --state-dir state', dir);
    const all = r.stdout + r.stderr;
    expect(all).toContain('INSTANCE_NOT_FOUND');
    expect(all).not.toContain('CORRUPT_STATE_FILE');
  });

  it('正例：init --parent --step 自动从父 vars 按 param_mapping 取值（n←prepared，无需 --params）', () => {
    const { dir } = setupCallDir();
    // 父跑到 call 步（act 纯计算被引擎消化，run 直达 step 2 call 介入点）
    const run = runCliJson(`run caller.md --params '{"base": 20}' --state-dir state`, dir);
    expect(run.status).toBe('step_ready');
    expect(run.step_id).toBe('2');
    const parent = run.instance_id;
    // 子实例 init：不传 --params——引擎自动映射 n ← 父.prepared(21)
    const init = runCliJson(`init double.md --parent ${parent} --step 2 --state-dir state`, dir);
    expect(init.status).toBe('ok');
    const childVars = runCliJson(`vars --state-dir state/${parent}/calls --instance 2`, dir);
    expect(childVars.variables.n).toBe(21);
  });

  it('正例：显式 --params 优先于自动映射（caller 可覆盖）', () => {
    const { dir } = setupCallDir();
    const run = runCliJson(`run caller.md --params '{"base": 20}' --state-dir state`, dir);
    const parent = run.instance_id;
    const init = runCliJson(`init double.md --parent ${parent} --step 2 --params '{"n": 99}' --state-dir state`, dir);
    expect(init.status).toBe('ok');
    const childVars = runCliJson(`vars --state-dir state/${parent}/calls --instance 2`, dir);
    expect(childVars.variables.n).toBe(99);
  });

  it('反例：calls/ 目录深度超 max_call_depth(10) → DEPTH_EXCEEDED 拒建子实例', () => {
    const { dir } = setupCallDir();
    const run = runCliJson(`run caller.md --params '{"base": 1}' --state-dir state`, dir);
    const parent = run.instance_id;
    // 伪造 10 层 calls/ 嵌套的 state-dir 路径（第 11 层触限）
    const deep = 'state/' + parent + Array.from({ length: 10 }, () => '/calls/2').join('');
    // 需要目录里有可 load 的父实例——把真实父实例状态复制到深层路径
    const realParent = join(dir, 'state', parent);
    const deepParent = join(dir, deep);
    mkdirSync(deepParent, { recursive: true });
    for (const f of ['state.json', 'vars.json', 'spec.json']) {
      writeFileSync(join(deepParent, f), readFileSync(join(realParent, f)));
    }
    const deepStateDir = deep.slice(0, deep.lastIndexOf('/'));   // 去掉末段实例名 → --state-dir
    const r = runCli(`init double.md --parent 2 --step 2 --state-dir ${deepStateDir}`, dir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('DEPTH_EXCEEDED');
  });

  it('正例：depth 上限内（1 层 call）init 正常通过', () => {
    const { dir } = setupCallDir();
    const run = runCliJson(`run caller.md --params '{"base": 2}' --state-dir state`, dir);
    const parent = run.instance_id;
    const init = runCliJson(`init double.md --parent ${parent} --step 2 --state-dir state`, dir);
    expect(init.status).toBe('ok');
  });
});


// ===== 统一模型复用模式渐进协议（P2 §U8）——跨进程闭环 =====
// design/parallel-execution.md ^anc-exec-parallel-reuse-protocol：run→dispatch_ready（引擎拼
// launch_command）→worker 子进程跑完→reap_and_fetch_next 收割→drain→completed。
// @v: anc-exec-parallel-reuse-protocol, anc-exec-gather
describe('复用模式渐进派发（reap_and_fetch_next/advance 跨进程闭环）', () => {
  const PIPE_SPEC = `# ReusePipe
Id: reuse-pipe

## Goal
复用模式流水线

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

  it('正例：dispatch_ready 带 launch_command，worker 子进程跑完 reap 收割，收齐 completed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-reuse-pd-'));
    writeFileSync(join(dir, 'pipe.md'), PIPE_SPEC);
    // run → 第一个介入点应为 dispatch_ready（subtask parallel 派发）
    const r1 = runCliJson(`run pipe.md --state-dir state --params '{"nums":[3,5]}'`, dir);
    expect(r1.status).toBe('dispatch_ready');
    expect(r1.dispatch_kind).toBe('subtask');
    expect(r1.child_instance).toBe('1.1.1');   // iter 1
    expect(r1.launch_command).toContain('--parallel-child 1.1.1');
    expect(r1.launch_command).toContain('--json');
    const inst = r1.instance_id;
    // driver 姿势：执行引擎拼好的 launch_command（worker 子进程跑到终态）
    const { execSync } = require('node:child_process');
    execSync(r1.launch_command, { cwd: dir, stdio: 'pipe' });
    // advance 续推主线 → 第二迭代派发
    const r2 = runCliJson(`advance --state-dir state --instance ${inst}`, dir);
    expect(r2.status).toBe('dispatch_ready');
    expect(r2.child_instance).toBe('1.1.2');
    execSync(r2.launch_command, { cwd: dir, stdio: 'pipe' });
    // 收割第一个 → 引擎继续推进（可能 drain_wait 或直接 completed，取决于第二个是否已收）
    const r3 = runCliJson(`reap_and_fetch_next 1.1.1 --status completed --state-dir state --instance ${inst}`, dir);
    let final = r3;
    if (final.status !== 'completed') {
      final = runCliJson(`reap_and_fetch_next 1.1.2 --status completed --state-dir state --instance ${inst}`, dir);
    }
    expect(final.status).toBe('completed');
    expect(final.outputs.outs).toEqual([21, 35]);   // 按派发序
  });

  it('反例：重复 reap 同一子实例幂等（不重复收集、不报错）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-reuse-idem-'));
    writeFileSync(join(dir, 'pipe.md'), PIPE_SPEC);
    const r1 = runCliJson(`run pipe.md --state-dir state --params '{"nums":[2]}'`, dir);
    expect(r1.status).toBe('dispatch_ready');
    const inst = r1.instance_id;
    const { execSync } = require('node:child_process');
    execSync(r1.launch_command, { cwd: dir, stdio: 'pipe' });
    const r2 = runCliJson(`reap_and_fetch_next 1.1.1 --status completed --state-dir state --instance ${inst}`, dir);
    expect(r2.status).toBe('completed');
    expect(r2.outputs.outs).toEqual([14]);
    // 二次 reap：inflight 已出账 → 幂等 no-op，响应仍 completed 且列表不翻倍
    const r3 = runCliJson(`reap_and_fetch_next 1.1.1 --status completed --state-dir state --instance ${inst}`, dir);
    expect(r3.status).toBe('completed');
    expect(r3.outputs.outs).toEqual([14]);
  });

  it('反例：worker 失败（从未启动=dispatch-lost 真失败形态）→ 不贡献元素，主线不拖垮', () => {
    // P1 对账后语义澄清：盘上状态是权威——worker 真跑完（子实例 completed 落盘）时
    // driver 谎报 --status failed 不生效（对账先按真值收割）。故失败模拟=不启动 worker。
    const dir = mkdtempSync(join(tmpdir(), 'cli-reuse-fail-'));
    writeFileSync(join(dir, 'pipe.md'), PIPE_SPEC);
    const r1 = runCliJson(`run pipe.md --state-dir state --params '{"nums":[4,6]}'`, dir);
    const inst = r1.instance_id;
    const { execSync } = require('node:child_process');
    // 第一个 worker 不启动（真失败形态）；直接报 failed
    const r2 = runCliJson(`reap_and_fetch_next 1.1.1 --status failed --state-dir state --instance ${inst}`, dir);
    expect(r2.status).toBe('dispatch_ready');
    expect(r2.child_instance).toBe('1.1.2');
    execSync(r2.launch_command, { cwd: dir, stdio: 'pipe' });
    const final = runCliJson(`reap_and_fetch_next 1.1.2 --status completed --state-dir state --instance ${inst}`, dir);
    expect(final.status).toBe('completed');
    expect(final.outputs.outs).toEqual([42]);   // 仅第二项（6*7）；失败项缺席
  });

  it('反例：报成无盘面 → 响亮报错不静默空产出（U2 不对称条款——completed 报告须盘面为证）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-reuse-liar-'));
    writeFileSync(join(dir, 'pipe.md'), PIPE_SPEC);
    const r1 = runCliJson(`run pipe.md --state-dir state --params '{"nums":[4]}'`, dir);
    const inst = r1.instance_id;
    // worker 从未启动（目录未建），driver 谎报 completed —— readVars 缺盘面必须响亮失败
    const { exitCode, stdout, stderr } = runCli(`reap_and_fetch_next 1.1.1 --status completed --state-dir state --instance ${inst}`, dir);
    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toMatch(/vars\.json|ENOENT|no such file/i);
  });
});

// ===== 复用模式 call parallel 跨进程闭环（形态三——盘点缺口补齐 2026-08-11）=====
// dispatch_kind:'call' 的 launch_command 带 <CALLEE_SPEC_PATH:id> 占位，driver 解析后执行。
// @v: anc-exec-parallel-reuse-protocol
describe('复用模式 call parallel（dispatch_kind=call 占位符闭环）', () => {
  it('正例：call 派发→占位符填 callee 路径→子进程跑完→reap 收齐', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-reuse-call-'));
    writeFileSync(join(dir, 'callee.md'), `# Build
Id: build

## Goal
翻十倍

## Inputs
- src: int  # 素材

## Outputs
- built: int  # 产物

## Steps
1. [act] 算
  - ← src
  + → built: int  # 产物
  > 纯计算
  > \`\`\`hop_python
  > built = src * 10
  > \`\`\`
`);
    writeFileSync(join(dir, 'caller.md'), `# CallPipe
Id: call-pipe

## Goal
流水线

## Inputs
- chapters: [int]  # 章列表

## Outputs
- results: [int]  # 产物列表

## Steps
1. [loop for-each ch in chapters, collect built into results] 逐章
  + → results: [int]  # 收集
  1.1. [act] 生产
    - ← ch
    + → confirmed: int  # 确认稿
    > \`\`\`hop_python
    > confirmed = ch + 1
    > \`\`\`
  1.2. [call build(src: confirmed) parallel] 派发构建
    + → built  # 单项端（同名收取）
2. [exit] 交付
`);
    const r1 = runCliJson(`run caller.md --state-dir state --params '{"chapters":[1,2]}'`, dir);
    expect(r1.status).toBe('dispatch_ready');
    expect(r1.dispatch_kind).toBe('call');
    expect(r1.launch_command).toContain('<CALLEE_SPEC_PATH:build>');
    expect(r1.launch_command).toContain('--call-parent');
    const inst = r1.instance_id;
    const { execSync } = require('node:child_process');
    // driver 姿势：占位符按 spec 发现解析为 callee 路径后执行
    const fill = (lc: string) => lc.replace(/<CALLEE_SPEC_PATH:build>/, join(dir, 'callee.md'));
    execSync(fill(r1.launch_command), { cwd: dir, stdio: 'pipe' });
    const r2 = runCliJson(`advance --state-dir state --instance ${inst}`, dir);
    expect(r2.status).toBe('dispatch_ready');
    expect(r2.child_instance).toBe('1.2.2');
    execSync(fill(r2.launch_command), { cwd: dir, stdio: 'pipe' });
    const r3 = runCliJson(`reap_and_fetch_next 1.2.1 --status completed --state-dir state --instance ${inst}`, dir);
    let final = r3;
    if (final.status !== 'completed') {
      final = runCliJson(`reap_and_fetch_next 1.2.2 --status completed --state-dir state --instance ${inst}`, dir);
    }
    expect(final.status).toBe('completed');
    expect(final.outputs.results).toEqual([20, 30]);   // (ch+1)*10 按派发序
  });
});

// ===== P1 crash-resume 在飞对账（矩阵行 14）=====
// design/parallel-execution.md ^anc-exec-parallel-inflight-reconcile：账面+子实例状态两真值源
// 对账——终态补收割/目录丢失判败/killed 不复活/已收割不重复收。
// @v: anc-exec-parallel-inflight-reconcile
describe('P1 crash-resume 在飞对账（复用模式跨进程）', () => {
  const PIPE = `# RecPipe
Id: rec-pipe

## Goal
恢复对账

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
      > o = n * 3
      > \`\`\`
2. [exit] 交付
`;

  it('正例：worker 已跑完但主进程死于收割前 → advance 对账补收割直达 completed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-rec-reap-'));
    writeFileSync(join(dir, 'pipe.md'), PIPE);
    const { execSync } = require('node:child_process');
    const r1 = runCliJson(`run pipe.md --state-dir state --params '{"nums":[5]}'`, dir);
    expect(r1.status).toBe('dispatch_ready');
    const inst = r1.instance_id;
    // worker 跑完（子实例终态落盘），但"主进程死了"——不调 reap_and_fetch_next
    execSync(r1.launch_command, { cwd: dir, stdio: 'pipe' });
    // 新进程 advance：对账应补收割 1.1.1 → 收齐 → completed
    const r2 = runCliJson(`advance --state-dir state --instance ${inst}`, dir);
    expect(r2.status).toBe('completed');
    expect(r2.outputs.outs).toEqual([15]);
  });

  it('正例：账龄在启动宽限期内、目录未建 → 保持在飞不误杀（drain_wait 等待,2026-08-11 真机实撞修正）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-rec-grace-'));
    writeFileSync(join(dir, 'pipe.md'), PIPE);
    const r1 = runCliJson(`run pipe.md --state-dir state --params '{"nums":[5]}'`, dir);
    const inst = r1.instance_id;
    // worker 尚未启动（复用模式后台起的常态窗口）——立即 advance：不得判死
    const r2 = runCliJson(`advance --state-dir state --instance ${inst}`, dir);
    expect(r2.status).toBe('drain_wait');
    expect(r2.inflight).toContain('1.1.1');
    expect(r2.stale ?? []).not.toContain('1.1.1');   // 启动中≠stale
  });

  it('反例改判：账龄超宽限且目录未建——复用模式(CLI 通道)不再判死,降级 stale 交 driver(2026-08-13 分道:真机 67s 合法慢启动被误杀)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-rec-lost-'));
    writeFileSync(join(dir, 'pipe.md'), PIPE);
    const { execSync } = require('node:child_process');
    const r1 = runCliJson(`run pipe.md --state-dir state --params '{"nums":[5,7]}'`, dir);
    const inst = r1.instance_id;
    // 拨旧账面 dispatched_at 超宽限期（模拟 driver 慢启动/真丢失——引擎分不清,所以交 driver）
    const statePath = join(dir, 'state', inst, 'state.json');
    const st = JSON.parse(readFileSync(statePath, 'utf-8'));
    st.inflight[0].dispatched_at = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(statePath, JSON.stringify(st));
    const r2 = runCliJson(`advance --state-dir state --instance ${inst}`, dir);
    // 不判死：1.1.1 保持在飞入 stale 清单;名额尚有,主线继续派第二迭代——stale 双载荷随
    // dispatch_ready 带出（driver 契约:任一响应见 stale 即自查）
    expect(r2.status).toBe('dispatch_ready');
    expect(r2.child_instance).toBe('1.1.2');
    expect(r2.stale).toContain('1.1.1');
    // driver 对 stale 项自查"没起过" → 用引擎重拼的 stale_launch 原样执行（真 driver 手里没有
    // 当初的 dispatch_ready——launch_command 不落盘,重拼是唯一通道）;同时把 r2 派的 1.1.2 也起了
    expect(r2.stale_launch['1.1.1']).toBeTruthy();
    execSync(r2.stale_launch['1.1.1'], { cwd: dir, stdio: 'pipe' });
    execSync(r2.launch_command, { cwd: dir, stdio: 'pipe' });
    const r3 = runCliJson(`reap_and_fetch_next 1.1.1 --status completed --state-dir state --instance ${inst}`, dir);
    const r4 = runCliJson(`reap_and_fetch_next 1.1.2 --status completed --state-dir state --instance ${inst}`, dir);
    expect(r4.status).toBe('completed');
    expect(r4.outputs.outs).toEqual([15, 21]);   // 5*3, 7*3——健康慢活不再被误杀
  });

  it('反例：driver 确认活已死显式报败 → 合成收割列表变短（stale 的显式出口,谎报失败只是放弃产出）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-rec-dead-'));
    writeFileSync(join(dir, 'pipe.md'), PIPE);
    const { execSync } = require('node:child_process');
    const r1 = runCliJson(`run pipe.md --state-dir state --params '{"nums":[5,7]}'`, dir);
    const inst = r1.instance_id;
    const statePath = join(dir, 'state', inst, 'state.json');
    const st = JSON.parse(readFileSync(statePath, 'utf-8'));
    st.inflight[0].dispatched_at = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(statePath, JSON.stringify(st));
    const r2 = runCliJson(`advance --state-dir state --instance ${inst}`, dir);
    expect(r2.stale).toContain('1.1.1');   // stale 随 dispatch_ready 双载荷带出
    // driver 判死路径：显式报败（目录缺失容错通道既有）;第二迭代照常起
    const r3 = runCliJson(`reap_and_fetch_next 1.1.1 --status failed --state-dir state --instance ${inst}`, dir);
    execSync((r3.launch_command ?? r2.launch_command), { cwd: dir, stdio: 'pipe' });
    const r4 = runCliJson(`reap_and_fetch_next 1.1.2 --status completed --state-dir state --instance ${inst}`, dir);
    expect(r4.status).toBe('completed');
    expect(r4.outputs.outs).toEqual([21]);   // 报败项缺席列表变短——原语义经显式通道保留
  });

  it('反例：已收割项不重复收（对账幂等）——两次 advance 结果一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-rec-idem-'));
    writeFileSync(join(dir, 'pipe.md'), PIPE);
    const { execSync } = require('node:child_process');
    const r1 = runCliJson(`run pipe.md --state-dir state --params '{"nums":[2]}'`, dir);
    const inst = r1.instance_id;
    execSync(r1.launch_command, { cwd: dir, stdio: 'pipe' });
    const r2 = runCliJson(`advance --state-dir state --instance ${inst}`, dir);
    expect(r2.status).toBe('completed');
    expect(r2.outputs.outs).toEqual([6]);
    const r3 = runCliJson(`advance --state-dir state --instance ${inst}`, dir);
    expect(r3.status).toBe('completed');
    expect(r3.outputs.outs).toEqual([6]);   // 不翻倍
  });
});

// review 补：对账 stale 载荷（U2 设计承诺——未终态在飞经 drain_wait.stale 交 driver 重建）
// @v: anc-exec-parallel-inflight-reconcile
describe('P1 对账 stale 载荷（复用模式重建信号）', () => {
  it('正例：子实例已建但未终态（模拟 worker 崩溃于中途）→ advance 返回 drain_wait 且 stale 含该项', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-rec-stale-'));
    writeFileSync(join(dir, 'pipe.md'), `# StalePipe
Id: stale-pipe

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
    1.1.1. [reason] 需要 LLM 的步骤（worker 无凭证跑不完——制造未终态现场）
      - ← n
      + → o: int  # 结果
2. [exit] 交付
`);
    const r1 = runCliJson(`run pipe.md --state-dir state --params '{"nums":[5]}'`, dir);
    expect(r1.status).toBe('dispatch_ready');
    const inst = r1.instance_id;
    // 手工建子实例目录（init 但不跑完——running 现场）：直接用 init 命令建 parallel 子实例
    runCliJson(`init pipe.md --parallel-parent ${inst} --parallel-child 1.1.1 --params '{"n":5}' --state-dir state`, dir);
    // advance 对账：子实例存在且非终态 → stale
    const r2 = runCliJson(`advance --state-dir state --instance ${inst}`, dir);
    expect(r2.status).toBe('drain_wait');
    expect(r2.stale).toContain('1.1.1');
  });
});

// review 补：run --call-parent 深度检查（与 init --parent 同判据——此前缺失）
// @v: anc-exec-call-depth-check
describe('run --call-parent 深度检查', () => {
  it('反例：calls/ 嵌套超 max_call_depth → DEPTH_EXCEEDED 拒建', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-cw-depth-'));
    writeFileSync(join(dir, 's.md'), `# S
Id: s
## Goal
g
## Outputs
- x: text  # o
## Steps
1. [act] a
  + → x: text  # o
  > \`\`\`hop_python
  > x = "v"
  > \`\`\`
`);
    // 构造 10 层 calls/ 嵌套的 state-dir 路径（无需真目录——深度按路径段数算,超限在建实例前拒）
    const deep = Array(10).fill('calls/x').join('/');
    const r = runCli(`run s.md --call-parent p --call-step 1.1 --params '{}' --state-dir state/${deep}`, dir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('DEPTH_EXCEEDED');
  });
});

// ===== run --call-parent 两协议混用闸（2026-08-14 e2e cc:call-fail 实撞）=====
// @v: anc-exec-call-depth-check
describe('run --call-parent 协议混用闸', () => {
  const CHILD_SPEC = `# Child
Id: mini-child
## Goal
g
## Inputs
- x: int
## Outputs
- y: int  # o
## Steps
1. [act] 算
  - ← x
  + → y: int  # r
  > 纯计算
  > \`\`\`hop_python
  > y = x + 1
  > \`\`\`
`;

  it('反例：--state-dir 已指向 <parent>/calls → CALL_PROTOCOL_MISUSE 拒,不建双重嵌套目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-misuse-'));
    writeFileSync(join(dir, 'child.md'), CHILD_SPEC);
    const { stdout, stderr, exitCode } = runCli(
      `run child.md --call-parent P123 --call-step 1 --params '{"x":1}' --state-dir state/P123/calls`, dir);
    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toContain('CALL_PROTOCOL_MISUSE');   // errorExit 出 stderr（--json 下亦然）
    expect(existsSync(join(dir, 'state', 'P123', 'calls', 'P123'))).toBe(false);   // 嵌套目录未落成
  });

  it('正例：顶层 state-dir 照常（launch_command 正规姿势零误伤;0086 续账③后父号须真实在场——生产实况 launch_command 恒携真父,原虚构 P123 形态随在场校验落地更新）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-misuse-ok-'));
    writeFileSync(join(dir, 'child.md'), CHILD_SPEC);
    writeFileSync(join(dir, 'parent.md'), CHILD_SPEC.replace('Id: cw-child', 'Id: cw-parent'));
    const p = runCliJson(`run parent.md --params '{"x":0}' --state-dir state`, dir);
    const r = runCliJson(`run child.md --call-parent ${p.instance_id} --call-step 1 --params '{"x":1}' --state-dir state`, dir);
    expect(r.status).toBe('completed');
    expect(existsSync(join(dir, 'state', p.instance_id, 'calls', '1'))).toBe(true);
  });
});

// ===== call_protocol 载荷（协议收敛：命令拼装权归引擎,driver 照抄零手拼）=====
// @v: anc-exec-call-protocol-payload
describe('call_protocol 载荷（step_ready 附引擎拼好的命令）', () => {
  const CALLER_SPEC2 = `# Caller2
Id: caller2

## Goal
调子 spec

## Inputs
- base: int  # 底数

## Outputs
- result: int  # 结果

## Steps
1. [act] 备料
  - ← base
  + → prepared: int  # 备好的数
  > 纯计算
  > \`\`\`hop_python
  > prepared = base + 1
  > \`\`\`
2. [call double(n: prepared)] 调翻倍
  + → result: doubled  # 映射
`;
  const CALLEE_SPEC2 = `# Double
Id: double

## Goal
翻倍

## Inputs
- n: int  # 数

## Outputs
- doubled: int  # 结果

## Steps
1. [act] 算
  - ← n
  + → doubled: int  # 翻倍值
  > 纯计算
  > \`\`\`hop_python
  > doubled = n * 2
  > \`\`\`
`;

  function setup2(): { dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cli-callproto-'));
    writeFileSync(join(dir, 'caller.md'), CALLER_SPEC2);
    writeFileSync(join(dir, 'double.md'), CALLEE_SPEC2);
    return { dir };
  }

  it('正例：call 步 step_ready 附 call_protocol,五字段齐且命令含 auto-map params 快照', () => {
    const { dir } = setup2();
    const run = runCliJson(`run caller.md --params '{"base": 20}' --state-dir state`, dir);
    expect(run.status).toBe('step_ready');
    expect(run.step_type).toBe('call');
    const cp = run.call_protocol;
    expect(cp).toBeDefined();
    expect(cp.init_command).toContain('<CALLEE_SPEC_PATH:double>');   // 占位符（寻址归 caller）
    expect(cp.init_command).toContain('--parent ' + run.instance_id);
    expect(cp.init_command).toContain('--step 2');
    expect(cp.init_command).toContain('\\"n\\":21');                  // auto-map 快照（base+1）已折入（shell 双层引形态）
    expect(cp.init_command).toContain('--trace ' + run.instance_id);  // trace 继承已折入
    expect(cp.child_instance).toBe('2');
    expect(cp.child_state_dir).toContain(join(run.instance_id, 'calls'));
    expect(cp.report_completed).toContain('--child-instance 2');
    expect(cp.report_failed).toContain('--failure-child 2');
    expect(cp.child_advance).toContain('advance');                    // 循环起步命令（cc:call 实撞补）
    expect(cp.child_advance).toContain('--instance 2');
    expect(cp.child_advance).toContain(cp.child_state_dir);
    // 两回报命令 instance/state-dir 指向父（照抄即正确落点）
    expect(cp.report_completed).toContain('--instance ' + run.instance_id);
  });

  it('正例：照抄载荷命令全链闭环——init(填占位)→子循环→report_completed→父 completed', () => {
    const { dir } = setup2();
    const run = runCliJson(`run caller.md --params '{"base": 20}' --state-dir state`, dir);
    const cp = run.call_protocol;
    const { execSync } = require('node:child_process');
    // driver 唯一动作：填占位符
    const initCmd = cp.init_command.replace('<CALLEE_SPEC_PATH:double>', join(dir, 'double.md'));
    execSync(initCmd, { cwd: dir, stdio: 'pipe' });
    // 子实例已建且落官方目录（照抄 child_state_dir 即正确落点）
    expect(existsSync(join(dir, 'state', run.instance_id, 'calls', '2', 'state.json'))).toBe(true);
    // 子 spec 纯计算——照抄 child_advance 推到终态（逐字执行载荷命令,验第六字段真可执行——
    // 手拼等价命令验不到字段本身,cc:call 实撞后照抄面必须全字段过真跑）
    execSync(cp.child_advance, { cwd: dir, stdio: 'pipe' });
    const done = runCliJson(cp.report_completed.replace(/^node "[^"]+" --json /, ''), dir);
    expect(done.status).toBe('completed');
    expect(done.outputs.result).toBe(42);   // (20+1)*2——auto-map 与回填双向走通
  });

  it('正例：载荷内路径一律绝对——相对 --state-dir 起跑,命令仍含绝对路径（跨进程照抄防 cwd 漂移）', () => {
    const { dir } = setup2();
    // 相对 state-dir（driver 常态写法）——载荷若折入相对路径,照抄进程换 cwd 即落错目录
    const run = runCliJson(`run caller.md --params '{"base": 20}' --state-dir state`, dir);
    const cp = run.call_protocol;
    const m = /--state-dir "([^"]+)"/.exec(cp.init_command);
    expect(m).not.toBeNull();
    expect(m![1].startsWith('/')).toBe(true);                       // init 命令内绝对
    expect(cp.child_state_dir.startsWith('/')).toBe(true);          // 子循环 state-dir 绝对
    expect(cp.report_completed).toContain(m![1]);                   // 回报命令同一绝对根
  });

  it('正例：resume 断线重取介入点,载荷跨进程完好（trace/log-dir 折入项不丢）', () => {
    const { dir } = setup2();
    const run = runCliJson(`run caller.md --params '{"base": 20}' --state-dir state`, dir);
    // 模拟 driver 进程死亡后新进程 resume（load 恢复 cliAbsPath/specPath/hoplog）
    const res = runCliJson(`resume --state-dir state --instance ${run.instance_id}`, dir);
    expect(res.status).toBe('step_ready');
    expect(res.step_type).toBe('call');
    const cp = res.call_protocol;
    expect(cp).toBeDefined();
    expect(cp.init_command).toContain('--trace ' + run.instance_id);
    expect(cp.init_command).toContain('--log-dir');
    expect(/--state-dir "\//.test(cp.init_command)).toBe(true);    // resume 进程里同样绝对
  });

  it('反例：非 call 步骤零载荷（字段缺席,响应形状不膨胀）', () => {
    const { dir } = setup2();
    // debug_step 看第 1 步（act 有 body 会被 run 消化,改用 init+debug_step 观察原始形态）
    const init = runCliJson(`init caller.md --params '{"base": 1}' --state-dir state`, dir);
    const next = runCliJson(`debug_step --state-dir state --instance ${init.instance_id}`, dir);
    if (next.status === 'step_ready') {
      expect(next.call_protocol).toBeUndefined();
    }
  });

  // call 同界记账（复用模式 CLI 消化点——commit 退火跨界半边;独立模式 settleCallOutcome 由
  // engine.test 并行组覆盖,本例钉 --child-instance 落盘通道） // @v: anc-exec-commit-anneal
  it('正例：子实例含已执行 commit → 父 --child-instance 消化时登记 call 步退火（committed_steps 跨界）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-anneal-call-'));
    writeFileSync(join(dir, 'caller.md'), `# CA
Id: ca
## Goal
g
## Inputs
- base: int  # 底
## Outputs
- result: int  # 果
## Steps
1. [call cdouble(n: base)] 调含 commit 的子
  + → result: doubled  # 映射
`);
    writeFileSync(join(dir, 'cdouble.md'), `# CDouble
Id: cdouble
## Goal
g
## Inputs
- n: int  # 数
## Outputs
- doubled: int  # 果
## Steps
1. [commit] 不可逆翻倍
  - ← n
  + → doubled: int  # 翻倍
  > 纯计算
  > \`\`\`hop_python
  > doubled = n * 2
  > \`\`\`
`);
    const run = runCliJson(`run caller.md --params '{"base": 5}' --state-dir state`, dir);
    expect(run.status).toBe('step_ready');
    const cp = run.call_protocol;
    const { execSync } = require('node:child_process');
    execSync(cp.init_command.replace('<CALLEE_SPEC_PATH:cdouble>', join(dir, 'cdouble.md')), { cwd: dir, stdio: 'pipe' });
    execSync(cp.child_advance, { cwd: dir, stdio: 'pipe' });
    // 子实例 state.json 已含 committed_steps（子内 commit body 引擎直执 done）
    const childState = JSON.parse(readFileSync(join(dir, 'state', run.instance_id, 'calls', cp.child_instance, 'state.json'), 'utf-8'));
    // 断言适配判据重构新形态（{step_id,iters} 带祖先 loop 轮次快照——顶层 commit 无祖先 loop 快照空）
    expect(childState.committed_steps).toEqual([{ step_id: '1', iters: {} }]);
    // 父消化 → 父 state.json 登记 call 步退火（同界记账）
    const done = runCliJson(cp.report_completed.replace(/^node "[^"]+" --json /, ''), dir);
    expect(done.status).toBe('completed');
    const parentState = JSON.parse(readFileSync(join(dir, 'state', run.instance_id, 'state.json'), 'utf-8'));
    expect(parentState.committed_steps).toEqual([{ step_id: cp.child_instance, iters: {} }]);   // call 步 id（父视角,新形态）
  });

  it('反例：内存实例（无 specPath/cliAbsPath）载荷缺席——退旧协议不假拼', () => {
    // 经 engine API 直验（CLI 通道外无路径注入源）
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CALLER_SPEC2, {
      workspace_dir: '/tmp', sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: '',
    }, { params: { base: 1 } });
    expect(init.status).toBe('ok');
    engine.nextStep();                              // 步骤 1 领取（标 running）
    engine.completeStep('1', { prepared: 2 });      // 步骤 1 交付
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    expect(next.step_type).toBe('call');
    expect(next.call_protocol).toBeUndefined();
  });
});

// @v: anc-exec-call-protocol-payload —— report_failed 照抄真跑（六字段照抄面收口:此前唯它零执行）
describe('call_protocol report_failed 照抄闭环', () => {
  it('正例：子实例真失败→照抄 report_failed→父收 CalleeFailure 内核', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-cprf-'));
    writeFileSync(join(dir, 'caller.md'), `# CF
Id: cf

## Goal
调必败子

## Outputs
- r: text  # r

## Steps
1. [call failchild] 调
  + → r: out_v
2. [exit]
`);
    writeFileSync(join(dir, 'failchild.md'), `# FC
Id: failchild

## Goal
必败

## Inputs
- x: text

## Outputs
- out_v: text  # o

## Steps
1. [act] 算
  - ← x
  + → out_v: text  # o
  > 纯计算
  > \`\`\`hop_python
  > out_v = x - 1
  > \`\`\`
`);
    const run = runCliJson(`run caller.md --params '{}' --state-dir state`, dir);
    expect(run.status).toBe('step_ready');
    const cp = run.call_protocol;
    const { execSync } = require('node:child_process');
    // 照抄 init 并补 --params 传 x="abc"（字符串减法→body 计算异常,子实例真失败——原形态
    // 靠"x 缺失 undefined-1 炸"触发,2026-09-01 init 必填闸落地后缺参在 init 即被拒〔闸的
    // 设计行为〕,state.json 不落盘 report_failed 无从照抄;改传毒值保留"运行期真失败"意图）:
    const initCmd = cp.init_command.replace('<CALLEE_SPEC_PATH:failchild>', join(dir, 'failchild.md'))
      + ` --params '{"x": "abc"}'`;
    execSync(initCmd, { cwd: dir, stdio: 'pipe' });
    // 照抄 child_advance——子实例 body 计算异常→failed（advance 命令本身 exit 0 返 failed JSON）
    try { execSync(cp.child_advance, { cwd: dir, stdio: 'pipe' }); } catch { /* failed 终态可能非零退出,不影响盘面 */ }
    // 照抄 report_failed——引擎读子实例失败记录组装 CalleeFailure:
    const out = execSync(cp.report_failed.replace(/^node "[^"]+" --json /, `node "${CLI}" --json `), { cwd: dir, encoding: 'utf-8' });
    const resp = JSON.parse(out.trim());
    expect(resp.status).toBe('failed');
    expect(JSON.stringify(resp)).toContain('CalleeFailure');
  });
});

// driver_channel 双执行硬闸（2026-08-27 两模式并存三改的安全半边——同一 run 被 CLI 与 MCP
// 两条通道各推一遍是最高危事故,防线从 NL 纪律降为引擎机制）
// @v: anc-exec-driver-channel
describe('driver_channel 双执行硬闸（CLI 侧）', () => {
  it('正例：CLI run 建的实例 state.json 落 driver_channel=cli,同通道 submit 照常', () => {
    const { dir, specFile } = setupWorkDir();
    const run = runCliJson(`run ${specFile} --state-dir state`, dir);
    expect(run.status).toBe('step_ready');
    const stateP = join(dir, 'state', run.instance_id, 'state.json');
    expect(JSON.parse(readFileSync(stateP, 'utf-8')).driver_channel).toBe('cli');
    const next = runCliJson(`submit_and_fetch_next ${run.step_id} --output '{"result":"hi"}' --state-dir state --instance ${run.instance_id}`, dir);
    expect(['step_ready', 'completed']).toContain(next.status);
  });

  it('反例：state.json 被标 mcp 通道 → CLI submit 响亮拒 DRIVER_CHANNEL_MISMATCH 指路 MCP 工具,状态不动', () => {
    const { dir, specFile } = setupWorkDir();
    const run = runCliJson(`run ${specFile} --state-dir state`, dir);
    const stateP = join(dir, 'state', run.instance_id, 'state.json');
    const st = JSON.parse(readFileSync(stateP, 'utf-8'));
    st.driver_channel = 'mcp';   // 模拟 MCP server 建的 run
    writeFileSync(stateP, JSON.stringify(st));
    const r = runCli(`submit_and_fetch_next ${run.step_id} --output '{"result":"hi"}' --state-dir state --instance ${run.instance_id}`, dir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('DRIVER_CHANNEL_MISMATCH');
    expect(r.stderr).toContain('resume_run');   // 指路正确入口
    expect(JSON.parse(readFileSync(stateP, 'utf-8')).step_states[run.step_id]).toBe('running');   // 状态没被推进
  });

  it('正例：旧 run 缺席字段 → 首个推进入口认领不拒（存量兼容）', () => {
    const { dir, specFile } = setupWorkDir();
    const run = runCliJson(`run ${specFile} --state-dir state`, dir);
    const stateP = join(dir, 'state', run.instance_id, 'state.json');
    const st = JSON.parse(readFileSync(stateP, 'utf-8'));
    delete st.driver_channel;   // 模拟旧版引擎建的 run
    writeFileSync(stateP, JSON.stringify(st));
    const next = runCliJson(`submit_and_fetch_next ${run.step_id} --output '{"result":"hi"}' --state-dir state --instance ${run.instance_id}`, dir);
    expect(['step_ready', 'completed']).toContain(next.status);
    expect(JSON.parse(readFileSync(stateP, 'utf-8')).driver_channel).toBe('cli');   // 认领落账
  });

  it('反例：只读命令不拦——status/vars 对 mcp 通道 run 照常返回（跨通道可观测）', () => {
    const { dir, specFile } = setupWorkDir();
    const run = runCliJson(`run ${specFile} --state-dir state`, dir);
    const stateP = join(dir, 'state', run.instance_id, 'state.json');
    const st = JSON.parse(readFileSync(stateP, 'utf-8'));
    st.driver_channel = 'mcp';
    writeFileSync(stateP, JSON.stringify(st));
    const status = runCliJson(`status --state-dir state --instance ${run.instance_id}`, dir);
    expect(status.instance_id ?? status.status).toBeTruthy();   // 正常返回不报 MISMATCH
    const vars = runCliJson(`vars --state-dir state --instance ${run.instance_id}`, dir);
    expect(vars).toBeTruthy();
  });
});

// @v: anc-exec-subprocess-run —— 复用模式 commands 配置通路（变异 B 击杀面:readProjectCommands 恒 [] 曾 172 全绿）
describe('readProjectCommands 复用模式配置通路', () => {
  it('正例：项目级 hopjit.yaml commands 键读入（修前红:全测试库零引用该函数）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rpc-'));
    writeFileSync(join(dir, 'hopjit.yaml'), 'commands:\n  - git\n  - echo\n');
    const prev = process.cwd();
    try {
      process.chdir(dir);
      expect(readProjectCommands()).toEqual(['git', 'echo']);
    } finally { process.chdir(prev); }
  });

  // @v: anc-exec-subprocess-deny-hopjit
  it('反例：commands 白名单含 hopjit → CONFIG_ERROR 响亮拒（钝感函数的唯一响亮例外——静默剔除会让作者误以为生效）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rpc3-'));
    const prev = process.cwd();
    try {
      process.chdir(dir);
      writeFileSync(join(dir, 'hopjit.yaml'), 'commands:\n  - git\n  - hopjit\n');
      expect(() => readProjectCommands()).toThrow(/不得含 hopjit/);
      writeFileSync(join(dir, 'hopjit.yaml'), 'commands:\n  - git\n  - /opt/bin/hopjit\n');
      expect(() => readProjectCommands()).toThrow(/不得含 hopjit/);   // 路径形态同拒
    } finally { process.chdir(prev); }
  });

  it('反例：坏 YAML/标量形状/文件缺席 → 回空名单钝感不炸（三形态）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rpc2-'));
    const prev = process.cwd();
    try {
      process.chdir(dir);
      expect(readProjectCommands()).toEqual([]);   // 缺席
      writeFileSync(join(dir, 'hopjit.yaml'), 'commands: git\n');
      expect(readProjectCommands()).toEqual([]);   // 标量形状不符
      writeFileSync(join(dir, 'hopjit.yaml'), ':::bad yaml{{{\n');
      expect(readProjectCommands()).toEqual([]);   // 坏 YAML
    } finally { process.chdir(prev); }
  });
});

// status 停驻如实转述（todo/0081——此前 execution_status 枚举缺 paused,停驻报 running:
// 看护方接 CLI status 通道感知不到"引擎在等人",停点挂死〔2026-09-09 实撞 30+ 分钟〕。
// 判定三源与 network 边界见 hop-cli.md ^anc-cli-status-response）
// @v: anc-cli-status-response, anc-cli-vars-response
describe('status 停驻如实转述（paused 档,0081）', () => {
  const CONFIRM_SPEC = `# ConfirmStatus
Id: confirm-status-0081

## Goal
g

## Outputs
- r: text  # r

## Steps
1. [confirm] 批一下
  + → approved: bool  # 批
2. [act free] 干活
  - ← approved
  + → r: text  # r
`;

  it('正例：confirm 停驻 → status 报 paused 带 pause_reason/paused_step_id（修前此处断言 running——撒谎通道本体）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-0081a-'));
    writeFileSync(join(dir, 'c.md'), CONFIRM_SPEC);
    const run = runCliJson(`run c.md --state-dir state`, dir);
    expect(run.status).toBe('paused');
    const st = runCliJson(`status --state-dir state`, dir);
    expect(st.execution_status).toBe('paused');
    expect(st.pause_reason).toBe('confirm');
    expect(st.paused_step_id).toBe('1');
  });

  it('反例：答案消化后回 running,摘要字段离场;跑完报 completed（paused 不粘滞）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-0081b-'));
    writeFileSync(join(dir, 'c.md'), CONFIRM_SPEC);
    runCliJson(`run c.md --state-dir state`, dir);
    runCliJson(`submit_and_fetch_next 1 --answer '{"value":"approve"}' --state-dir state`, dir);
    const st = runCliJson(`status --state-dir state`, dir);
    expect(st.execution_status).toBe('running');   // 步 2 已交 caller 等回写——running 是复用模式合法持久态
    expect(st.pause_reason).toBeUndefined();
    expect(st.paused_step_id).toBeUndefined();
    runCliJson(`submit_and_fetch_next 2 --output '{"r":"done"}' --state-dir state`, dir);
    const st2 = runCliJson(`status --state-dir state`, dir);
    expect(st2.execution_status).toBe('completed');
  });

  it('反例：aborted 凌驾——停驻实例 abort 后 status 报 aborted 非 paused（终态凌驾序不被 paused 档扰动,残卡不翻案）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-0081c-'));
    writeFileSync(join(dir, 'c.md'), CONFIRM_SPEC);
    runCliJson(`run c.md --state-dir state`, dir);
    runCliJson(`abort --reason 'test' --state-dir state`, dir);
    const st = runCliJson(`status --state-dir state`, dir);
    expect(st.execution_status).toBe('aborted');
    expect(st.pause_reason).toBeUndefined();
  });

  it('正例：vars 同口径——停驻时 execution_status 同报 paused（两响应共用同一状态推导,VarsResponse 枚举随批扩）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-0081d-'));
    writeFileSync(join(dir, 'c.md'), CONFIRM_SPEC);
    runCliJson(`run c.md --state-dir state`, dir);
    const v = runCliJson(`vars --state-dir state`, dir);
    expect(v.execution_status).toBe('paused');
  });
});

// 复用模式通知挂点（^anc-cli-notify-reuse——todo/0052 复用模式半边;真发送归真机 probe,
// 可测面=渠道跨进程持久+二与门+发送拼装。二与门形态 2026-08-31 作者定"每次 hop 时说,
// 否则太烦"——渠道随话语走零配置文件,原设计的 hopjit.yaml notify 配置门退役不实装）
// @v: anc-cli-notify-reuse
describe('复用模式通知挂点（--notify <渠道> 二与门）', () => {
  const PURE_SPEC = `# 复用通知试跑
Id: reuse-notify-probe
Goal: g

## Outputs
- out: text  # o

## Steps
1. [act] 算
  + → out: text  # o
  > \`\`\`hop_python
  > out = "done"
  > \`\`\`
`;
  function setup(): string {
    const dir = mkdtempSync(join(tmpdir(), 'reuse-ntf-'));
    writeFileSync(join(dir, 'spec.md'), PURE_SPEC);
    return dir;
  }
  const ENV_HOOK = { DINGTALK_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=fakehook02' };

  function runCliEnv(args: string, cwd: string, env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
    // spawnSync 而非 execSync——成功路径也要收 stderr（[notify] 留痕断言;execSync 成功时 stderr 拿不到）
    const r = spawnSync('node', [CLI, '--json', ...args.split(' ').filter(Boolean)], {
      cwd, encoding: 'utf-8', timeout: 15000,
      env: { ...process.env, HOPJIT_ANTHROPIC_API_KEY: '', ...env },
    });
    return { stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), exitCode: r.status ?? -1 };
  }

  it('正例：--notify dingtalk 渠道名记入实例 state（跨进程可见——run 后直接读 state.json）', { timeout: 20000 }, () => {
    const dir = setup();
    // 显式清空凭证:宿主环境可能带真 DINGTALK_WEBHOOK——不清则测试进程真发送(向真实群发垃圾消息+网络等待)
    const r = runCliEnv(`run spec.md --state-dir state --notify dingtalk`, dir, { DINGTALK_WEBHOOK: '' });
    expect(JSON.parse(r.stdout).status).toBe('completed');
    const instDir = readdirSync(join(dir, 'state'))[0];
    const st = JSON.parse(readFileSync(join(dir, 'state', instDir, 'state.json'), 'utf-8'));
    expect(st.notify_channel).toBe('dingtalk');
  });

  it('反例：未 --notify → state 无渠道字段（缺省缺席=不通知）', () => {
    const dir = setup();
    const r = runCliEnv(`run spec.md --state-dir state`, dir, ENV_HOOK);   // ENV_HOOK 是假 webhook,覆盖宿主真值
    expect(JSON.parse(r.stdout).status).toBe('completed');
    const instDir = readdirSync(join(dir, 'state'))[0];
    const st = JSON.parse(readFileSync(join(dir, 'state', instDir, 'state.json'), 'utf-8'));
    expect(st.notify_channel).toBeUndefined();
  });

  it('反例：--notify 带非法渠道 → 启动即拒响亮报可用枚举（渠道枚举闸——静默漂过=用户以为会响的手机永远不响）', () => {
    const dir = setup();
    const r = runCliEnv(`run spec.md --state-dir state --notify telegram`, dir, ENV_HOOK);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('dingtalk');   // 报文带可用渠道枚举指路
  });

  it('正例：二与门齐 → 终态时发送尝试留痕（假 webhook 网络必败,stderr 见 [notify] 行——发送尝试的实证;主流程照常 completed）', { timeout: 20000 }, () => {
    const dir = setup();
    const r = runCliEnv(`run spec.md --state-dir state --notify dingtalk`, dir, ENV_HOOK);
    expect(JSON.parse(r.stdout).status).toBe('completed');   // 通知旁路不拖垮主流程
    expect(r.stderr).toContain('[notify]');                   // 发送尝试真实发生（假 token 被钉钉拒或网络失败,恒有一行）
  });

  it('反例：项目有 hopjit.yaml notify 节但 run 未带 --notify → 零发送零留痕（配置门已退役——话语不点名恒不发,配置文件在场也不擅自发）', () => {
    const dir = setup();
    writeFileSync(join(dir, 'hopjit.yaml'), 'notify:\n  channel: dingtalk\n');
    const r = runCliEnv(`run spec.md --state-dir state`, dir, ENV_HOOK);   // 假 webhook——即使误发也打不到真群
    expect(JSON.parse(r.stdout).status).toBe('completed');
    expect(r.stderr).not.toContain('[notify]');
  });
});

// @v: anc-exec-l2c-retry-feedback — H2 复用半边全链钉（真 CLI 进程）。实撞:2026-09-01 补测试批
// 变异核证——删 cli.ts 的 upstreamFeedback 透传行,tsc 照过全量 2504 照绿(既有钉全是同进程
// EngineOptions 模拟,零钉经过 CLI 层);顺藤深挖出 D22 跨进程断链(upstreamFeedback 不落
// state.json,init 与 advance 两个进程,载荷活不过 init——修=StateFile 持久化+load 恢复)。
// 本钉把 CLI 透传+落盘+load 恢复+组装供给整条链锁死。
describe('init --upstream-feedback 跨进程全链（H2 复用半边,D22 断链回归防线）', () => {
  const CHILD_SPEC = `# 上游反馈子实例
Id: upfb-child
Goal: g

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
  it('正例：init 带 --upstream-feedback → 落 state.json → 新进程 advance 的 step_ready 供给到 reason 步；反例：check 步不吃', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-upfb-'));
    writeFileSync(join(dir, 'child.md'), CHILD_SPEC);
    const init = runCliJson(`init child.md --upstream-feedback "SENTINEL_CLI_UP 请修正结论依据" --state-dir state`, dir);
    expect(init.status).toBe('ok');
    // 落盘半边：载荷必须活过 init 进程（D22——不落盘则 advance 新进程里恒空,透传行成死代码）
    const st = JSON.parse(readFileSync(join(dir, 'state', init.instance_id, 'state.json'), 'utf-8'));
    expect(st.upstream_feedback).toContain('SENTINEL_CLI_UP');
    // 供给半边：真起新 CLI 进程 advance——首个 step_ready(1.1 reason)的组装上下文带哨兵
    const adv = runCliJson(`advance --state-dir state`, dir);
    expect(adv.status).toBe('step_ready');
    expect(adv.step_id).toBe('1.1');
    expect(adv.context.upstream_feedback).toContain('SENTINEL_CLI_UP');
    // 掐口半边：提交 1.1 后推进到 1.2 check——判官零上游供给（H1 受众分道,跨进程同样成立）
    const next = runCliJson(`submit_and_fetch_next 1.1 --output '{"out":"v"}' --state-dir state --instance ${init.instance_id}`, dir);
    expect(next.status).toBe('step_ready');
    expect(next.step_id).toBe('1.2');
    expect(next.context.upstream_feedback).toBeUndefined();
  });
});

// @v: anc-cli-file-arg-safety, anc-cli-instance-resolve
// list 设计目录排除按 path.sep（0086 续账②——原硬编码 '/design/' win32 反斜杠路径失效;
// posix 下 sep='/' 行为不变,本钉锁 posix 半边回归;win32 半边属 0057 家族 pathWin32 仿真限度,
// sep 变量用法经本批 review 核对）。 // @v: anc-cli-list
describe('list 设计目录排除（0086 续账修）', () => {
  it('正例：design 子目录下的 spec 形态文件被排除,普通目录照常列出', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-list-design-'));
    mkdirSync(join(dir, 'design'), { recursive: true });
    const SPEC = `# L\n## Goal\ng\n## Outputs\n- r: text  # r\n## Steps\n1. [act free] 干\n  + → r: text  # r\n`;
    writeFileSync(join(dir, 'a.md'), SPEC);
    writeFileSync(join(dir, 'design', 'b.md'), SPEC);
    const top = runCliJson(`list ${dir}`, dir);
    expect(top.specs.some((x: any) => String(x.file).endsWith('a.md'))).toBe(true);
    const sub = runCliJson(`list ${join(dir, 'design')}`, dir);
    expect((sub.specs ?? []).length).toBe(0);
  });
});

describe('win32 路径三卡修复批（hopissues 0057/0058/0059——win32 判定经 pathWin32 仿真钉死）', () => {
  const w32 = pathWin32;

  // 0057 反例:win32 反斜杠形态、路径确在 work_zone 内——修后必须放行（修前硬编码 '/' 误拒）
  it('isPathInWorkZone: win32 反斜杠路径在 work_zone 内须放行（0057 病灶形态）', () => {
    const wz = w32.resolve('E:\\proj\\.hs\\inst-1\\work_zone');
    const inZone = w32.resolve('E:\\proj\\.hs\\inst-1\\work_zone\\params.json');
    expect(isPathInWorkZone(inZone, wz, w32.sep)).toBe(true);
    expect(isPathInWorkZone(wz, wz, w32.sep)).toBe(true);   // work_zone 目录本身
  });

  // 0057 正例:真越界仍拒——闸没被修松
  it('isPathInWorkZone: win32 真越界（兄弟实例/父目录）仍拒', () => {
    const wz = w32.resolve('E:\\proj\\.hs\\inst-1\\work_zone');
    expect(isPathInWorkZone(w32.resolve('E:\\proj\\.hs\\inst-2\\work_zone\\out.json'), wz, w32.sep)).toBe(false);
    expect(isPathInWorkZone(w32.resolve('E:\\proj\\.hs\\inst-1\\work_zone_evil\\x.json'), wz, w32.sep)).toBe(false);   // 前缀相似目录不许蹭
    expect(isPathInWorkZone(w32.resolve('E:\\tmp\\out.json'), wz, w32.sep)).toBe(false);
  });

  // posix 行为不变（回归面）
  it('isPathInWorkZone: posix 行为与修前一致（放行子路径/拒越界与前缀相似目录）', () => {
    const wz = '/proj/.hs/inst-1/work_zone';
    expect(isPathInWorkZone(wz + '/out.json', wz, '/')).toBe(true);
    expect(isPathInWorkZone('/proj/.hs/inst-1/work_zone_evil/x.json', wz, '/')).toBe(false);
  });

  // 宿主平台端到端:assertOutputInWorkZone 在本机真实路径上放行/拒（防抽函数后接线断;
  // errorExit 走 process.exit,按本文件既有 mock 模式抛 EXIT 捕获）
  it('assertOutputInWorkZone: 宿主平台 work_zone 内放行、越界拒（接线核）', () => {
    const inst = mkdtempSync(join(tmpdir(), 'wz-'));
    mkdirSync(join(inst, 'work_zone'), { recursive: true });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`EXIT:${c}`); }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => assertOutputInWorkZone('@' + join(inst, 'work_zone', 'ok.json'), inst)).not.toThrow();
      expect(() => assertOutputInWorkZone('@' + join(tmpdir(), 'evil.json'), inst)).toThrow(/EXIT/);
    } finally {
      exitSpy.mockRestore(); stderrSpy.mockRestore();
      rmSync(inst, { recursive: true, force: true });
    }
  });

  // 0059 正例:半初始化目录得 INSTANCE_NOT_INITIALIZED 明确报文（不再裹成 CORRUPT_STATE_FILE）
  it('resolveInstance: 半初始化子实例目录报 INSTANCE_NOT_INITIALIZED 指路删除重派（0059）', () => {
    const sd = mkdtempSync(join(tmpdir(), 'hs-'));
    const half = join(sd, 'parent-1', 'parallel', '2.2.1');
    mkdirSync(half, { recursive: true });
    writeFileSync(join(half, 'params.json'), '{"x":1}');   // 父写了 params,child 未 init
    expect(() => resolveInstance(sd, 'parent-1/parallel/2.2.1')).toThrow(/INSTANCE_NOT_INITIALIZED/);
    expect(() => resolveInstance(sd, 'parent-1/parallel/2.2.1')).toThrow(/删除该目录后重新派发/);
    rmSync(sd, { recursive: true, force: true });
  });

  // 0059 反例:完整实例照常放行(有 state.json 即过闸;内容坏归 CORRUPT_STATE_FILE 下游既有面)
  it('resolveInstance: state.json 在场的实例照常解析（半初始化闸不误伤完整实例）', () => {
    const sd = mkdtempSync(join(tmpdir(), 'hs-'));
    const inst = join(sd, 'inst-ok');
    mkdirSync(inst, { recursive: true });
    writeFileSync(join(inst, 'state.json'), '{}');
    expect(resolveInstance(sd, 'inst-ok')).toBe(resolve(inst));
    rmSync(sd, { recursive: true, force: true });
  });
});

// tool-call 三分支（语义审计 c2t 唯一全缺口——UNKNOWN_TOOL/COMMIT_REQUIRED/成功回执
// 此前零覆盖:两条 fail-fast 分支被误删不会有任何用例拦）。 // @v: anc-step-tool-grant
describe('tool-call 复用模式工具通道三分支（0086 修复批补钉）', () => {
  it('反例：未注册工具名 → UNKNOWN_TOOL 带可用清单,退出码 1', () => {
    const { dir } = setupWorkDir();
    const r = runCli(`tool-call no_such_tool --args {}`, dir);
    expect(r.exitCode).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.code).toBe('UNKNOWN_TOOL');
    expect(j.message).toContain('可用');
  });

  it('反例：requires_commit 工具在 act 语境 → COMMIT_REQUIRED 拒,退出码 1', () => {
    const { dir } = setupWorkDir();
    // 内建工具面里 requires_commit 恒真的代表:dingtalk_notify(外发不可逆)——从 Composite 全量清单取实况
    const list = runCli(`tool-call __probe__ --args {}`, dir);
    const avail = JSON.parse(list.stdout).message as string;
    const commitTool = 'dingtalk_notify';
    if (!avail.includes(commitTool)) {
      // 内建清单无该工具时用注册件形态兜底造一个 requires_commit 工具
      writeFileSync(join(dir, 'hopjit.yaml'),
        'tool_servers:\n  - name: t\n    binding: { kind: cli, command: echo }\n    tools:\n      - name: irreversible_send\n        requires_commit: true\n        params: []\n');
      const r2 = runCli(`tool-call irreversible_send --args {}`, dir);
      expect(r2.exitCode).toBe(1);
      expect(JSON.parse(r2.stdout).code).toBe('COMMIT_REQUIRED');
    } else {
      const r2 = runCli(`tool-call ${commitTool} --args {}`, dir);
      expect(r2.exitCode).toBe(1);
      expect(JSON.parse(r2.stdout).code).toBe('COMMIT_REQUIRED');
    }
  });

  it('正例：合法内建工具成功回执 {status:ok,result}', () => {
    const { dir } = setupWorkDir();
    writeFileSync(join(dir, 'probe.txt'), 'hello');
    const j = runCliJson(`tool-call exists --args '{"path":"probe.txt"}'`, dir);
    expect(j.status).toBe('ok');
    expect(j.result).toBeDefined();
  });
});

// 0086 修复批两根行为钉:debug_step 双执行闸(设计枚举与实装双补)+普通 replan 变量闸(挪出 free 块)。
// @v: anc-exec-driver-channel, anc-exec-completeness
describe('0086 修复批行为钉:debug_step 通道闸与普通 replan 变量闸', () => {
  it('反例：mcp 通道的 run 被 CLI debug_step 推 → DRIVER_CHANNEL_MISMATCH 拒,状态不动（修前:调试命令无闸直推,双执行硬闸可绕口）', () => {
    const { dir, specFile } = setupWorkDir();
    const run = runCliJson(`run ${specFile} --state-dir state`, dir);
    const stateP = join(dir, 'state', run.instance_id, 'state.json');
    const st = JSON.parse(readFileSync(stateP, 'utf-8'));
    st.driver_channel = 'mcp';
    writeFileSync(stateP, JSON.stringify(st));
    const r = runCli(`debug_step --state-dir state --instance ${run.instance_id}`, dir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('DRIVER_CHANNEL_MISMATCH');
    expect(JSON.parse(readFileSync(stateP, 'utf-8')).step_states[run.step_id]).toBe('running');
  });

  it('反例：普通 replan（非 free 展开）引用不存在变量 → VALIDATION_ERROR 拒（修前:parse-only 静默落树,运行时 MISSING_INPUT 晚炸）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-e2e-'));
    writeFileSync(join(dir, 'spec.md'), `# R
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=2]
  1.1. [act free] 干
    + → out: text  # o
  1.2. [check] 核
    - ← out
    + → ok: bool  # 判定
    + → note: text  # 说明
`);
    const run = runCliJson(`run spec.md --state-dir state`, dir);
    expect(run.step_id).toBe('1.1');
    // 主动 replan 未执行段,新步骤引用凭空变量 ghost_input（替换整个未执行子树,含 check 保留）
    const replanMd = '1.1. [act free] 干\n  - ← ghost_input\n  + → out: text  # o\n1.2. [check] 核\n  - ← out\n  + → ok: bool  # 判定\n  + → note: text  # 说明\n';
    const wz = join(dir, 'state', run.instance_id, 'work_zone');
    writeFileSync(join(wz, 'replan.md'), replanMd);
    const bad = runCli(`submit_and_fetch_next 1 --replan @${join(wz, 'replan.md')} --proactive --state-dir state --instance ${run.instance_id}`, dir);
    const body = bad.stdout + bad.stderr;
    expect(body).toContain('ghost_input');
    expect(bad.exitCode === 0 ? JSON.parse(bad.stdout).status : 'error').not.toBe('step_ready');
  });
});

// run --call-parent 父实例号在场校验（0086 续账③——设计 ^anc-cli-instance-resolve 全通路收纯
// 承诺点名本通路而实现漏网:错号父实例静默建野目录树零报错,probe 实抓）。 // @v: anc-cli-instance-resolve
describe('run --call-parent 父实例校验（0086 续账修复）', () => {
  it('反例：错号父实例 → INSTANCE_NOT_FOUND 拒,不建野目录', () => {
    const { dir } = setupWorkDir();
    const r = runCli(`run spec.md --call-parent NO-SUCH-PARENT --call-step 1.1 --state-dir state`, dir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('INSTANCE_NOT_FOUND');
    expect(existsSync(join(dir, 'state', 'NO-SUCH-PARENT'))).toBe(false);
  });

  it('正例：真父实例在场 → call 子实例照常建立推进', () => {
    const { dir, specFile } = setupWorkDir();
    const parent = runCliJson(`run ${specFile} --state-dir state`, dir);
    const child = runCliJson(`run ${specFile} --call-parent ${parent.instance_id} --call-step 2.1 --state-dir state`, dir);
    expect(child.status).toBe('step_ready');
    expect(existsSync(join(dir, 'state', parent.instance_id, 'calls', '2.1'))).toBe(true);
  });
});

// 引擎缺省模型单一事实源（0086 续账③——dispatcher 路由兜底与 install-skill CC 缺省原各写死字面量,
// 引擎升缺省 install 侧静默旧值;两消费点改读 ENGINE_DEFAULT_MODEL 常量）。 // @v: anc-cli-install-skill
describe('缺省模型同源常量（0086 续账修）', () => {
  it('正例：src 全域无 claude-* 模型字面量残留（除常量定义处——第二真值面清零）', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const files = readdirSync(srcDir).filter(f => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(srcDir, f), 'utf-8');
      for (const [i, line] of text.split('\n').entries()) {
        if (/'claude-(sonnet|opus|haiku)-[\w.-]+'/.test(line) && !line.includes('ENGINE_DEFAULT_MODEL =')) {
          offenders.push(`${f}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// escalate 升层应答 CLI 消化路（0088 批⑫——引擎面六例已有,CLI submit --answer 半边缺钉:
// cli.ts 升层分支〔getEscalatePending===stepId 且 --answer 在场 → resumeFromEscalation〕
// 被删时无跨进程用例拦）。 // @v: anc-exec-check-escalate
describe('escalate CLI 应答路（跨进程升层消化）', () => {
  const ESC_SPEC = `# Esc
Id: esc-cli

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

  it('正例：check 升层进待答态后,submit_and_fetch_next --answer 走升层消化路——guidance 回注重试反馈,同一 check 重派', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-esc-'));
    writeFileSync(join(dir, 'esc.md'), ESC_SPEC);
    const r1 = runCliJson(`run esc.md --state-dir state --params '{"x":1}'`, dir);
    expect(r1.status).toBe('step_ready');
    expect(r1.step_id).toBe('1.1');
    // check 判 false 且 gap 携 escalate:true → 引擎四条件命中,进入升层待答态（跨进程落盘）
    const r2 = runCliJson(`submit_and_fetch_next 1.1 --output '{"ok":false,"gap":{"escalate":true,"need":"要口径:P0阈值多少算收敛"}}' --state-dir state`, dir);
    expect(r2.status).toBe('paused');
    expect(r2.pause_reason).toBe('escalate');
    expect(r2.presented_data?.question).toContain('要口径');
    // 待答态下 --answer → CLI 升层分支 resumeFromEscalation（非 completeAndAdvance 声明匹配路）
    const r3 = runCliJson(`submit_and_fetch_next 1.1 --answer '{"guidance":"按均值阈值 0.8 判收敛"}' --state-dir state`, dir);
    expect(r3.status).toBe('step_ready');
    expect(r3.step_id).toBe('1.1');   // guidance 消化后同一 check 回 pending 重派
    // guidance 进了重试反馈通道（state.json retry_history 带升层指引前缀——resumeFromEscalation 独有形态）
    const state = JSON.parse(readFileSync(join(dir, 'state', r1.instance_id, 'state.json'), 'utf-8'));
    const allReasons = JSON.stringify(state.retry_history ?? {});
    expect(allReasons).toContain('升层指引');
    expect(allReasons).toContain('0.8');
  });

  it('反例：非待答态时同命令 --answer 走常规 completeAndAdvance,不误入升层消化路', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-esc-n-'));
    writeFileSync(join(dir, 'esc.md'), ESC_SPEC);
    const r1 = runCliJson(`run esc.md --state-dir state --params '{"x":1}'`, dir);
    expect(r1.step_id).toBe('1.1');
    // 未经升层暂停,直接 --answer 递交合格 check 输出 → 常规声明匹配路完成 1.1、续跑 1.2 到 completed
    const r2 = runCliJson(`submit_and_fetch_next 1.1 --answer '{"ok":true,"gap":{"escalate":false,"note":"已收敛"}}' --state-dir state`, dir);
    expect(r2.status).toBe('completed');
    expect(r2.outputs?.r).toBe('done');
    // 升层消化路未被误入：retry_history 无升层指引痕迹（resumeFromEscalation 独有形态）
    const state = JSON.parse(readFileSync(join(dir, 'state', r1.instance_id, 'state.json'), 'utf-8'));
    expect(JSON.stringify(state.retry_history ?? {})).not.toContain('升层指引');
  });
});

// trace_id 继承（0088 批⑬钉B——CLI worker 半边:run --parallel-parent 起 worker 时
// cli.ts engineOpts traceId=parallelParent,worker hoplog header trace_id 须=父 instance_id。
// 该赋值被删时引擎回落 traceId=自身 instance_id('1.1.1'),父子轨迹断链无钉拦）
// @v: anc-obs-trace-inherit
describe('trace_id 继承（run --parallel-parent worker 跨进程）', () => {
  it('正例：worker 子实例 hoplog 的 trace_id = 父 instance_id（grep 一个 trace_id 串起整棵执行树）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-trace-'));
    writeFileSync(join(dir, 'pipe.md'), `# TracePipe
Id: trace-pipe

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
    1.1.1. [reason] 判断
      - ← n
      + → o: int  # 结果
2. [exit] 交付
`);
    const r1 = runCliJson(`run pipe.md --state-dir state --params '{"nums":[5]}'`, dir);
    expect(r1.status).toBe('dispatch_ready');
    const parentId = r1.instance_id;
    // worker 起步（同 launch_command 形态——reason 步等 LLM 停在 step_ready,hoplog header 已写）
    const r2 = runCliJson(`run pipe.md --parallel-parent ${parentId} --parallel-child 1.1.1 --params '{"n":5}' --state-dir state`, dir);
    expect(r2.status).toBe('step_ready');
    // hoplog 落盘路径规律：<state-dir>/../.hoplog/<specId>-<runId>/main.yaml——父与 worker 各一个 run 目录
    const hoplogRoot = join(dir, '.hoplog');
    const runDirs = readdirSync(hoplogRoot).filter(d => d.startsWith('trace-pipe-'));
    expect(runDirs.length).toBe(2);
    // 两个 run（父+worker）的 trace_id 全部=父 instance_id——worker 继承而非各自为政
    for (const rd of runDirs) {
      const head = readFileSync(join(hoplogRoot, rd, 'main.yaml'), 'utf-8');
      expect(head).toMatch(new RegExp(`^trace_id: ${parentId}$`, 'm'));
    }
  });
});

// context 精简档三级优先级（0088 批⑭——CLI 侧 resolveContextMode 解析单测:引擎侧语义钉已有,
// 缺的是 env HOPJIT_CONTEXT_MODE > --context-mode flag > 缺省 full 的解析面。export 直测最轻,
// 落盘/响应面由既有引擎钉承载）。 // @v: anc-exec-context-mode
describe('resolveContextMode 三级优先级（env > flag > 缺省 full）', () => {
  const KEY = 'HOPJIT_CONTEXT_MODE';
  let saved: string | undefined;
  beforeAll(() => { saved = process.env[KEY]; });
  afterAll(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

  it('正例：env 设 minimal 且 flag 传 full → env 赢（每命令可覆盖的调试开关语义）', () => {
    process.env[KEY] = 'minimal';
    expect(resolveContextMode('full')).toBe('minimal');
  });

  it('正例：env 缺席仅 flag minimal → flag 生效', () => {
    delete process.env[KEY];
    expect(resolveContextMode('minimal')).toBe('minimal');
  });

  it('正例：env 与 flag 都不给 → 缺省 full', () => {
    delete process.env[KEY];
    expect(resolveContextMode(undefined)).toBe('full');
  });

  it('反例：env 设非法值 garbage → 落 full（枚举外不静默漂成 minimal）', () => {
    process.env[KEY] = 'garbage';
    expect(resolveContextMode(undefined)).toBe('full');
  });
});

// for-each worker CLI --params 注入直钉（0088 批⑮——0086 挂账"最实一条":该通道被改回
// "读父 vars 反解"禁用形态时无 CLI 侧用例拦。itemVar 供给权威=引擎 fan-out 落盘 params.json
// + driver 透传 --params（显式键优先,params.json 只补缺失键）;worker 不翻父实例 vars 自播种）
// @v: anc-exec-parallel-foreach-worker
describe('for-each worker --params itemVar 注入（CLI 跨进程）', () => {
  const FW_SPEC = `# FW
Id: fw-pipe

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
    1.1.1. [reason] 判断
      - ← n
      + → o: int  # 结果
2. [exit] 交付
`;
  function setupParent(dir: string): string {
    writeFileSync(join(dir, 'fw.md'), FW_SPEC);
    const r = runCliJson(`run fw.md --state-dir state --params '{"nums":[5]}'`, dir);
    expect(r.status).toBe('dispatch_ready');
    return r.instance_id;
  }

  it('正例：run --parallel-child 带 --params → itemVar 落 worker vars,显式键优先于 fan-out 落盘的 params.json（--params 注入通道直钉）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-fw-'));
    const inst = setupParent(dir);
    // 父 fan-out 已落 params.json（n=5）;显式 --params 传不同值 99——注入通道生效则 99 赢
    //（params.json 只补缺失键）。通道被删则 worker 只见落盘的 5,本断言红——直钉 --params 半边。
    const r = runCliJson(`run fw.md --parallel-parent ${inst} --parallel-child 1.1.1 --params '{"n":99}' --state-dir state`, dir);
    expect(r.status).toBe('step_ready');
    const vars = JSON.parse(readFileSync(join(dir, 'state', inst, 'parallel', '1.1.1', 'vars.json'), 'utf-8'));
    expect(vars.scopes.root.variables['n']).toBe(99);
  });

  it('反例：不带 --params 且备料 params.json 缺席 → engine init 硬校验 MISSING_INPUT 点名 itemVar,不静默翻父实例 vars 反解', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-fw-n-'));
    const inst = setupParent(dir);
    // 移除引擎 fan-out 落盘的备料——模拟"worker 被手工错启动/落盘缺失"现场
    rmSync(join(dir, 'state', inst, 'parallel', '1.1.1', 'params.json'));
    const r = runCli(`run fw.md --parallel-parent ${inst} --parallel-child 1.1.1 --state-dir state`, dir);
    const out = r.stdout + r.stderr;
    expect(out).toContain('MISSING_INPUT');
    expect(out).toContain("itemVar 'n'");   // 报错点名缺参（父 vars 里 nums=[5] 在场——翻父反解则不会报）
  });
});

// pack engine_min_version 注入（0093——产物 Config 声明打包时引擎版本;作者手写在场保留不覆盖）。 // @v: anc-cli-pack, anc-exec-engine-min-version-gate
describe('pack engine_min_version 注入（0093）', () => {
  const REPO2 = resolve(__dirname, '..');
  it('正例：pack 产物 spec.md Config 段含 engine_min_version=打包引擎版本', () => {
    const pkgV = JSON.parse(readFileSync(join(REPO2, 'package.json'), 'utf-8')).version as string;
    const dir = mkdtempSync(join(tmpdir(), 'cli-pack-me-'));
    const r = runCliJson(`pack "${join(REPO2, 'examples/syntax/confirm-commit.md')}" --dir ${dir} --force`, dir);
    expect(r.status).toBe('ok');
    const spec = readFileSync(join(dir, 'confirm-commit', 'spec.md'), 'utf-8');
    expect(spec).toMatch(new RegExp(`engine_min_version: ${pkgV.replace(/\./g, '\\.')}`));
  });

  it('正例：spec 已手写 engine_min_version → pack 保留作者值不覆盖（放宽是知情行为）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-pack-me2-'));
    const src = readFileSync(join(REPO2, 'examples/syntax/confirm-commit.md'), 'utf-8');
    writeFileSync(join(dir, 'hand.md'), src.replace('## Outputs', 'Config:\n  engine_min_version: 0.1.0\n\n## Outputs'));
    runCliJson(`pack hand.md --dir ${dir} --name handpack --force`, dir);
    const spec = readFileSync(join(dir, 'handpack', 'spec.md'), 'utf-8');
    expect(spec).toContain('engine_min_version: 0.1.0');
    expect((spec.match(/engine_min_version/g) ?? []).length).toBe(1);
  });
  it('正例：spec 已有 Config: 段（无 engine_min_version 键）→ 键插进既有段下,不重复建段（第十一轮 review 抓获:原钉全走无 Config 段分支,/^Config:$/ 替换路径零测试）', () => {
    const pkgV = JSON.parse(readFileSync(join(REPO2, 'package.json'), 'utf-8')).version as string;
    const dir = mkdtempSync(join(tmpdir(), 'cli-pack-me3-'));
    const src = readFileSync(join(REPO2, 'examples/syntax/confirm-commit.md'), 'utf-8');
    writeFileSync(join(dir, 'withcfg.md'), src.replace('## Outputs', 'Config:\n  model: test/m\n\n## Outputs'));
    runCliJson(`pack withcfg.md --dir ${dir} --name cfgpack --force`, dir);
    const spec = readFileSync(join(dir, 'cfgpack', 'spec.md'), 'utf-8');
    expect(spec).toMatch(new RegExp(`engine_min_version: ${pkgV.replace(/\./g, '\\.')}`));
    expect((spec.match(/^Config:/gm) ?? []).length).toBe(1);   // 不重复建段
    expect(spec).toContain('model: test/m');                     // 既有键保留
  });
});

// hopfix 随装（todo/0093 件二——版本兼容三义务迁移通道进分发面:壳+流程件副本两载体对等）。 // @v: anc-cli-install-skill
describe('install-skill 装载 hopfix（0093 件二）', () => {
  it('正例：CC 载体装出 hopfix 壳+流程件,流程件含版本迁移对照节', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-inst-hf-'));
    const r = runCliJson(`install-skill --dir ${dir}/sk`, dir);
    expect(r.installed.some((i: string) => i.includes('hopfix/'))).toBe(true);
    expect(existsSync(join(dir, 'sk', 'hopfix', 'SKILL.md'))).toBe(true);
    const flow = readFileSync(join(dir, 'sk', 'hopfix', 'hopfix.md'), 'utf-8');
    expect(flow).toContain('版本迁移对照');
    expect(flow).toContain('B2 commit 步未知函数升 error');
  });

  it('正例：Codex 载体同装（两载体清单对等）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-inst-hf2-'));
    runCliJson(`install-skill --carrier codex --dir ${dir}/sk`, dir);
    expect(existsSync(join(dir, 'sk', 'hopfix', 'hopfix.md'))).toBe(true);
  });
});
