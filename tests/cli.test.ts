// @module: hop-cli ^anc-struct-hop-cli
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { parse as parseJsonc } from 'jsonc-parser';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, readFileSync, existsSync, readdirSync, symlinkSync, realpathSync, cpSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve, dirname, win32 as pathWin32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
// schema-sep 拒写回用例的观测口（^anc-cli-schema-sep）：ESM 具名导入是只读绑定,vi.spyOn 换不掉 cli.ts
// 已绑定的 convertSchemaSeparators——对 parser 模块做透传包装,只把它换成"调真实现的 vi.fn",
// 其余导出原样透传;拒写回用例里 mockImplementationOnce 单次换成会改坏文件的桩,本文件其它用例不受影响。
vi.mock('../src/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/parser.js')>();
  return { ...actual, convertSchemaSeparators: vi.fn(actual.convertSchemaSeparators) };
});
import * as parserMod from '../src/parser.js';
import { validateSpec } from '../src/validator.js';
import { ExecutionEngine, type EngineOptions } from '../src/engine.js';
import { readSpec } from '../src/persistence.js';
import {
  resolveParam,
  resolveTextParam,
  resolveInstance,
  resolveFileArgBase,
  workerWorkZone,
  assertOutputInWorkZone,
  isPathInWorkZone,
  buildHostConfig,
  resolveWorkspaceArg,
  extractHopEnvIntoHostConfig,
  resolveContextMode,
  errorExit,
  program,
  setOutputJson,
  detectCarriers, firstRunHint,
  installDemoAnts, rewriteSpecId, mcpHandshake,
  runDoctor, learnStandaloneEntry, readMcpRegistration, ccPermissionMissing, readSkillFrontmatter, resolveCarrierHome,
} from '../src/cli.js';
import type { HostConfig } from '../src/provider-types.js';
import { HOPJIT_ALLOWED_TOOLS } from '../src/provider-types.js';
import { hostname, userInfo } from 'node:os';
import { antPack, type AdminContext } from '../src/hop-admin.js';
import { antRoots } from '../src/hopant.js';
// 搬进 hop-admin.ts 的探测函数不再读进程状态,测试在 withHome 改好 HOME / cwd / env 后用它现组一份 AdminContext（todo/0154）。
// @v: anc-mcp-admin-tools
const adminCtx = (env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): AdminContext => {
  let login = ''; try { login = userInfo().username; } catch { /* 容器里可能取不到 */ }
  const home = env.HOME ?? homedir();
  return { home, cwd, env, exec_path: process.execPath, login, hostname: hostname(), roots: antRoots(home, cwd) };   // roots 漏装过（0154+0155 review D11）——AdminContext 七字段要齐,vitest 不做类型检查靠不住
};

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

// setup 写进 CC 放行设置的工具名单（写死,不取自 HOPJIT_ALLOWED_TOOLS 本身——期望值取自被测常量时,常量漏项测试照样绿）
const EXPECTED_ALLOW = ['start_run', 'run_status', 'resume_run', 'list_runs', 'stop_run', 'run_approved_command', 'server_status',
  'run', 'submit_and_fetch_next', 'reap_and_fetch_next', 'status', 'resume', 'abort', 'validate', 'approve_commit', 'approve_dirs',
  'doctor', 'ant_list', 'ant_install', 'ant_adapt', 'ant_remove', 'ant_bootstrap', 'ant_pack', 'ant_share']   // 管理八件（todo/0154,^anc-mcp-admin-tools）
  .map(t => `mcp__hopjit__${t}`);

// 子进程恒用一次性家目录：install-skill 缺省即注册 MCP（2026-10-01）后,继承真实 HOME/CODEX_HOME 的用例会把 hopjit
// 写进开发者真实的 ~/.codex/config.toml 或 ~/.hopjit/config.yaml（review 面三变异 (j) 实抓,本机只因沙箱 EPERM 幸免）。
// 无 cli 子进程用例依赖真实家目录（grep 零命中）,统一在这里隔离。
const SUBPROC_HOME = mkdtempSync(join(tmpdir(), 'hopcli-home-'));
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
      env: { ...process.env, HOPJIT_ANTHROPIC_API_KEY: '', HOME: SUBPROC_HOME, CODEX_HOME: join(SUBPROC_HOME, '.codex'), CLAUDE_CONFIG_DIR: join(SUBPROC_HOME, '.claude'), OPENCODE_CONFIG_DIR: join(SUBPROC_HOME, '.config', 'opencode') },
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

/** commit 批准停点的 CLI 闭环（todo/0146 ^anc-cli-approve-commit）：按停点载荷的 step_id 与 fingerprint 批准（scope=once）,再 resume。 */
function approveAndResume(cwd: string, stateDir: string, instanceId: string, paused: any): any {
  const ctx = paused.presented_data.context;
  const ok = runCliJson(`approve_commit ${ctx.step_id} --fingerprint ${ctx.fingerprint} --scope once --state-dir ${stateDir} --instance ${instanceId}`, cwd);
  expect(ok.status).toBe('ok');
  return runCliJson(`resume --state-dir ${stateDir} --instance ${instanceId}`, cwd);
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
      writeFileSync(join(specDir, 'child-spec.md'), `# Child
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

  // @v: anc-cli-json-io —— --output/--answer 解析结果须是 JSON 对象（todo/0146 probe 3 实撞:
  // --answer '"approve"' 进引擎 'decision' in 字符串抛 TypeError）。正例 {"value":"approve"} 见上方 0056 组。
  describe('submit_and_fetch_next 非对象提交 → INVALID_ARG（调引擎前拒,状态不动）', () => {
    const CONFIRM_SPEC = `# Spec: obj-guard
Id: obj-guard

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
    const setup = () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-objguard-'));
      writeFileSync(join(dir, 'c.md'), CONFIRM_SPEC);
      runCliJson(`run c.md --state-dir state`, dir);
      return dir;
    };

    it('反例：--answer 裸字符串 → INVALID_ARG 指明对象形态,确认点仍停着', () => {
      const dir = setup();
      const r = runCli(`submit_and_fetch_next 1 --answer '"approve"' --state-dir state`, dir);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('INVALID_ARG');
      expect(r.stderr).toContain('--answer');
      expect(r.stderr).toContain('{"value":"approve"}');
      expect(r.stderr).not.toContain("'in' operator");          // 不再漏出引擎 TypeError 原文
      const st = runCliJson(`status --state-dir state`, dir);
      expect(st.current_step).toBe('1');                         // 状态未动
      const ok = runCliJson(`submit_and_fetch_next 1 --answer '{"value":"approve"}' --state-dir state`, dir);
      expect(ok.status).toBe('step_ready');                      // 改用对象形态即可续
      expect(ok.step_id).toBe('2');
    });

    it('反例：--output 数组 / null → INVALID_ARG,报文点名收到的类型', () => {
      const dir = setup();
      runCliJson(`submit_and_fetch_next 1 --answer '{"value":"approve"}' --state-dir state`, dir);
      const arr = runCli(`submit_and_fetch_next 2 --output '[1]' --state-dir state`, dir);
      expect(arr.exitCode).not.toBe(0);
      expect(arr.stderr).toContain('INVALID_ARG');
      expect(arr.stderr).toContain('数组');
      const nul = runCli(`submit_and_fetch_next 2 --output 'null' --state-dir state`, dir);
      expect(nul.exitCode).not.toBe(0);
      expect(nul.stderr).toContain('INVALID_ARG');
      expect(nul.stderr).toContain('null');
      const end = runCliJson(`submit_and_fetch_next 2 --output '{"r":"done"}' --state-dir state`, dir);
      expect(end.status).toBe('completed');                      // 拒收后账面无污染
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

  // @v: anc-exec-branch-select-internal —— todo/0168：原「submit_and_fetch_next --branch 选 case」改为引擎按值选路 + 选项不存在
  describe('submit_and_fetch_next 没有 --branch（todo/0168）', () => {
    const branchSpec = `# Branch
Id: branch-cli
## Goal
Test branch
## Inputs
- mode: text  # input
## Outputs
- out: text  # output
## Steps
1. [reason] 前面
  + → a: text  # 前置
  > 前置
2. [branch] Choose
  2.1. [case] {mode}==fast
    2.1.1. [reason] Fast
      - ← a
      + → out: text  # output
      > Go fast
  2.2. [case] {mode}==slow
    2.2.1. [reason] Slow
      - ← a
      + → out: text  # output
      > Go slow
`;
    it('正例（todo/0168）：跨进程 CLI 驱动——run 传 mode=slow 停在步 1,交付步 1 后引擎自己进入 branch 按条件命中 2.2,下一步是 2.2.1,账上 2.1 skipped', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-e2e-'));
      writeFileSync(join(dir, 'spec.md'), branchSpec);
      const init = runCliJson(`run spec.md --state-dir state --params '{"mode":"slow"}'`, dir);
      expect(init.step_id).toBe('1');
      const result = runCliJson(`submit_and_fetch_next 1 --output '{"a":"x"}' --state-dir state`, dir);
      expect(result.status, JSON.stringify(result)).toBe('step_ready');
      expect(result.step_id).toBe('2.2.1');
      const st = JSON.parse(readFileSync(join(dir, 'state', init.instance_id, 'state.json'), 'utf-8')).step_states;
      expect(st['2.2']).toBe('running');
      expect(st['2.1']).toBe('skipped');
    });
    it('反例（todo/0168）：--branch 选项已不存在——传 --branch 2.1 由 commander 报未知选项退出非零,引擎账一字未动', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-e2e-'));
      writeFileSync(join(dir, 'spec.md'), branchSpec);
      const init = runCliJson(`run spec.md --state-dir state --params '{"mode":"slow"}'`, dir);
      expect(init.step_id).toBe('1');
      const r = runCli(`submit_and_fetch_next 2 --branch 2.1 --reason "user chose fast" --state-dir state`, dir);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/unknown option '--branch'/);
      const st = JSON.parse(readFileSync(join(dir, 'state', init.instance_id, 'state.json'), 'utf-8')).step_states;
      expect(st['2']).toBe('pending');
      expect(st['2.1']).toBe('pending');
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
      const specJson = readSpec(join(stateRoot, instId)) as any;   // spec.json 是内容寻址引用,经 readSpec 解引用（^anc-provider-spec-content-addressed）
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
      const specJson = readSpec(join(dir, 'state', instId)) as any;   // 同上,经 readSpec
      const sub = specJson.steps.find((s: any) => s.step_id === '1');
      expect(sub.children).toHaveLength(2);
      expect(sub.children[1].summary).toContain('appended by proactive');
      // 依序交 1.1 → 新追加步 1.2 到场(编辑真实生效的行为面实证)
      const r2 = runCliJson(`submit_and_fetch_next 1.1 --output '{"task_out":"v"}' --state-dir state`, dir);
      expect(r2.status).toBe('step_ready');
      expect(r2.step_id).toBe('1.2');
    });

    // @v: anc-cli-abort, anc-exec-abort — abort 命令跨进程（复用模式真实消费面:逐命令新进程）
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
    it('returns host config with current cwd——sandbox 根与 workspace_dir 同值且为绝对路径（原钉 \'.\' 相对写法,2026-10-04 按 ^anc-config-sandbox-workspace-root 改）', () => {   // @v: anc-config-sandbox-workspace-root
      const config = buildHostConfig();
      expect(config.workspace_dir).toBe(process.cwd());
      expect(config.sandbox.filesystem.workspace_dir).toBe(process.cwd());
    });
  });

  // @v: anc-config-hop-env, anc-exec-doc-ref-hop-env —— 复用模式组合根:params 摘出 hop_env
  describe('extractHopEnvIntoHostConfig（复用模式组合根）', () => {
    // 打底键 hop_env_language 自 todo/0160 起跟随系统语言——本组断言按英文环境写,进组前把三个区域变量钉成 en_US
    const savedLang: Record<string, string | undefined> = {};
    beforeEach(() => { for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) { savedLang[k] = process.env[k]; delete process.env[k]; } process.env.LANG = 'en_US.UTF-8'; });
    afterEach(() => { for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) { if (savedLang[k] === undefined) delete process.env[k]; else process.env[k] = savedLang[k]; } });
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

  describe('schema-sep 命令（HopSchema 分隔符 : → % 迁移,todo/0109 probe2——^anc-cli-schema-sep）', () => {
    // @v: anc-cli-schema-sep
    function capture() {
      const orig = process.stdout.write.bind(process.stdout);
      let buf = '';
      process.stdout.write = ((c: string) => { buf += c; return true; }) as never;
      return { get: () => buf, restore: () => { process.stdout.write = orig; } };
    }
    const run = async (f: string) => {
      const cap = capture();
      try { await program.parseAsync(['node', 'hopjit', '--json', 'schema-sep', f]); } finally { cap.restore(); }
      return JSON.parse(cap.get().trim().split('\n').pop()!);
    };
    // 真实范例 hop-fact-check 的冒号写法快照 tests/fixtures/hop-fact-check.colon.md（0109 第 3 步库内范例已全量转成 %,这份冻结转换前原文作冒号输入;含 Types/Tools/hop_python body/围栏 YAML 示例,裸键段头形态）拷到临时区,
    // 在步骤段前补一段 Config（库内范例没有带 Config 的）——probe2 要求三样齐
    const CONFIG_BLOCK = '配置:\n- expansion_max: 5\n\n';
    const mkRealCopy = () => {
      const src = readFileSync(join(PROJECT_ROOT, 'tests', 'fixtures', 'hop-fact-check.colon.md'), 'utf-8');
      expect(src).toContain('\n## 步骤\n');
      const withConfig = src.replace('\n## 步骤\n', '\n' + CONFIG_BLOCK + '## 步骤\n');
      const dir = mkdtempSync(join(tmpdir(), 'cli-schema-sep-'));
      const f = join(dir, 'hop-fact-check.md');
      writeFileSync(f, withConfig, 'utf-8');
      return { dir, f, original: withConfig };
    };

    it('正（probe2）：真实范例全部分隔符换成 " % ",非分隔符行逐字节不变,改动行只差"名: "→"名 % ",备份=原件,validate 零 error 零 W2', async () => {
      const { f, original } = mkRealCopy();
      const beforeSeps = parserMod.parseSpec(original).ast.header.colon_separators!;
      expect(beforeSeps.some(s => s.section === 'Types')).toBe(true);
      expect(beforeSeps.some(s => s.section === 'Tools')).toBe(true);
      const r = await run(f);
      expect(r.status).toBe('ok');
      expect(r.changed_lines).toBe(beforeSeps.length);
      expect(readFileSync(r.backup, 'utf-8')).toBe(original);              // 备份在场且=原件逐字节
      const converted = readFileSync(f, 'utf-8');
      const a = original.split('\n');
      const b = converted.split('\n');
      expect(b).toHaveLength(a.length);
      const sepLines = new Set(beforeSeps.map(s => s.line));
      for (let i = 0; i < a.length; i++) {
        if (!sepLines.has(i + 1)) { expect(b[i], `第 ${i + 1} 行`).toBe(a[i]); continue; }   // 非分隔符行逐字节不变
        const rec = beforeSeps.find(s => s.line === i + 1)!;
        // 改动行：只把"名 + 冒号及两侧空白"换成"名 % ",其余（缩进/类型原文/# 说明）不动
        expect(b[i].replace(`${rec.name} % `, '')).toBe(a[i].replace(new RegExp(`${rec.name}\\s*:\\s*`), ''));
      }
      expect(converted).toContain(CONFIG_BLOCK);                           // Config 段不动
      expect(converted).toContain('- id: P5');                              // 围栏内 YAML 示例不动
      expect(converted).toContain('- web_search(query) -> result % yaml');
      const after = parserMod.parseSpec(converted);
      expect(after.errors).toHaveLength(0);
      const v = validateSpec(after.ast);
      expect(v.filter(e => e.severity === 'error')).toHaveLength(0);
      expect(v.filter(e => e.rule === 'W2')).toHaveLength(0);
      // 幂等：再跑一次零改动零备份
      const r2 = await run(f);
      expect(r2.changed_lines).toBe(0);
      expect(r2.backup).toBeNull();
      expect(readFileSync(f, 'utf-8')).toBe(converted);
    });

    const expectRefused = async (dir: string, f: string, original: string, re: RegExp) => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`EXIT:${c}`); }) as never);
      let err = '';
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((c: string) => { err += c; return true; }) as never);
      try {
        await expect(program.parseAsync(['node', 'hopjit', '--json', 'schema-sep', f])).rejects.toThrow(/EXIT:1/);
      } finally { exitSpy.mockRestore(); stderrSpy.mockRestore(); }
      expect(err).toMatch(re);
      expect(err).toContain('原件未动,无备份产生');
      expect(readFileSync(f, 'utf-8')).toBe(original);                     // 原件一字节不动
      expect(readdirSync(dir).filter(n => n.includes('.bak.'))).toHaveLength(0);   // 零备份
    };

    it('反（核对①）：转换引入新错误 → 拒写回、退出码 1、原件不动、零备份', async () => {
      const { dir, f, original } = mkRealCopy();
      // 正确的转换函数造不出引病输入——单次换成会改坏文件的桩（删掉 Id 行 + 删掉标题,parse 错误数上升）
      vi.mocked(parserMod.convertSchemaSeparators).mockImplementationOnce((t: string) =>
        ({ text: t.replace(/^# .*\n/, '').replace(/^标识: .*\n/m, ''), changed_lines: [1], unmatched_lines: [] }));
      await expectRefused(dir, f, original, /核对①/);
    });

    it('反（核对②a）：错误数不增但语义变了（换分隔符之外顺手改了 Outputs 的说明）→ 拒写回', async () => {
      const { dir, f, original } = mkRealCopy();
      vi.mocked(parserMod.convertSchemaSeparators).mockImplementationOnce((t: string) =>
        ({ text: t.replace('- factcheck_report: markdown  # 核查报告', '- factcheck_report: markdown  # 改过的说明'), changed_lines: [], unmatched_lines: [] }));
      await expectRefused(dir, f, original, /核对②转换前后 AST 不等/);
    });

    it('反（核对②b）：AST 不变但改动越出冒号分隔符行（改了标题下的 HTML 注释行）→ 拒写回并报行号', async () => {
      const { dir, f, original } = mkRealCopy();
      const realConvert = (await vi.importActual<typeof import('../src/parser.js')>('../src/parser.js')).convertSchemaSeparators;
      vi.mocked(parserMod.convertSchemaSeparators).mockImplementationOnce((t: string) => {
        const r = realConvert(t);
        return { ...r, text: r.text.replace('<!-- 改本文件', '<!-- 改动本文件') };
      });
      await expectRefused(dir, f, original, /核对②改动越出了冒号分隔符行: 2/);
    });

    it('反（核对③）：有该改没改成的行（转换不完整）→ 拒写回并报行号', async () => {
      const { dir, f, original } = mkRealCopy();
      vi.mocked(parserMod.convertSchemaSeparators).mockImplementationOnce((t: string) =>
        ({ text: t, changed_lines: [], unmatched_lines: [] }));   // 什么都没改却报成功
      await expectRefused(dir, f, original, /核对③.*第 \d+/);
    });
  });

  describe('pack/install-skill via parseAsync (coverage-visible)', () => {
    const REPO = resolve(__dirname, '..');
    // install-skill 缺省即注册+放行（2026-10-01）后,它会往 process.cwd() 写 .mcp.json 与 .claude/settings.local.json——
    // in-process 用例不隔离 cwd 就会写进仓库根（阅卷实抓：npm test 后仓库根多出 .mcp.json,开发者真实 settings.local.json 被追加一条）。
    // 本块每例 chdir 到独立临时目录;withMcpEnv 自带的 chdir 嵌套其内无冲突（finally 回到本块的临时目录再回 origCwd）。
    // setup 缺省装演示 HopAnt 进 <HOME>/.hopjit/ants（2026-10-06）后,不隔离 HOME 的用例会写进开发者真实家目录——
    // 本块每例同时把 HOME 指到临时目录、清掉载体 home 重定向变量;个别用例自设 HOME 的照旧,恢复时回到本块的临时 HOME。
    let blockCwd = '';
    let blockOrigCwd = '';
    let blockHome = '';
    const blockSavedEnv: Record<string, string | undefined> = {};
    beforeEach(() => {
      blockOrigCwd = process.cwd(); blockCwd = mkdtempSync(join(tmpdir(), 'hopskill-cwd-')); process.chdir(blockCwd);
      for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR']) { blockSavedEnv[k] = process.env[k]; delete process.env[k]; }
      blockHome = mkdtempSync(join(tmpdir(), 'hopskill-home-')); process.env.HOME = blockHome;
    });
    afterEach(() => {
      process.chdir(blockOrigCwd); rmSync(blockCwd, { recursive: true, force: true });
      for (const [k, v] of Object.entries(blockSavedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(blockHome, { recursive: true, force: true });
    });
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'cfuse-cc', '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'cfuse-codex', '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'codex', '--force']);
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

    // @v: anc-cli-carrier-home-resolution —— opencode 载体（2026-09-15,见 todo/0089）
    // opencode:home 用 XDG（~/.config/opencode,非 ~/.opencode）,复用 CC driver 源（references/driver-subagent.md 在,无 agents/）
    // @v: anc-driver-opencode-install-layout —— opencode 装载面（driver/opencode/ 自有内容层+hop 照装〔2026-09-20 撤销不装裁定〕+hopbuild 族共装）
    it('install-skill --carrier opencode 装到 ~/.config/opencode/skills 且用 driver/opencode/ 自有内容层（正例——2026-09-19 从复用 CC 源改判:发现层兼容不等于执行层可用,原语适配版为准）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-opencode-'));
      const origHome = process.env.HOME;
      const origCfgDir = process.env.CLAUDE_CONFIG_DIR;
      const origCodexHome = process.env.CODEX_HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CODEX_HOME;
      delete process.env.OPENCODE_CONFIG_DIR;   // opencode 缺席环境变量→回落 XDG ~/.config/opencode
      delete process.env.XDG_CONFIG_HOME;
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        if (origCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = origCfgDir;
        if (origCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = origCodexHome;
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.carrier).toBe('opencode');
      expect(r.target).toBe(join(fakeHome, '.config', 'opencode', 'skills'));
      expect(existsSync(join(fakeHome, '.config/opencode/skills/hopspec/SKILL.md'))).toBe(true);
      // driver/opencode/ 自有内容层:装出的 SKILL.md 是原语适配版——含 question 工具指令,
      // 正文零 CC 专属原语（AskUserQuestion 至多出现于 @trace note 的映射说明一处,超出=退回 CC 原文）
      const installedSkill = readFileSync(join(fakeHome, '.config/opencode/skills/hopspec/SKILL.md'), 'utf-8');
      expect(installedSkill).toContain('question 工具');
      expect(installedSkill.split('AskUserQuestion').length - 1).toBeLessThanOrEqual(1);
      expect(existsSync(join(fakeHome, '.config/opencode/skills/hopspec/references/driver-subagent.md'))).toBe(true);
      expect(existsSync(join(fakeHome, '.config/opencode/skills/hopspec/agents'))).toBe(false);
      // hop 件照装（2026-09-20 作者撤"v1 不装"裁定——codex 先例同款;装出件为 opencode 适配版:
      // 隐式触发说法+question 工具,零 $hop 前缀与 CC 原语）
      const hopSkill = readFileSync(join(fakeHome, '.config/opencode/skills/hop/SKILL.md'), 'utf-8');
      expect(hopSkill).toContain('question');
      expect(hopSkill).not.toContain('$hop');
      expect(hopSkill).not.toContain('AskUserQuestion');
      // hopbuild 族照旧共装
      expect(existsSync(join(fakeHome, '.config/opencode/skills/hopbuild/SKILL.md'))).toBe(true);
      expect(existsSync(join(fakeHome, '.config/opencode/skills/hopfix/hopfix.md'))).toBe(true);
      // hopbuild 族 SKILL.md 副本把 /hopspec run 改写为隐式触发（对齐 driver 原语映射 斜杠→隐式 + LLM 消费友好）
      // opencode 有斜杠命令系统（/hopspec run 可工作）,改写非修功能失效,是一致化;CC 源不改,只改装出副本
      const hb2Skill = readFileSync(join(fakeHome, '.config/opencode/skills/hopbuild2/SKILL.md'), 'utf-8');
      expect(hb2Skill).toContain('用 hopspec skill 执行');
      expect(hb2Skill).not.toContain('/hopspec run');   // 守卫：装出副本不得残留任何 /hopspec run 形态（含无尾空格的边角写法）
      const hbSkill = readFileSync(join(fakeHome, '.config/opencode/skills/hopbuild/SKILL.md'), 'utf-8');
      expect(hbSkill).not.toContain('/hopspec run');   // 若 CC 源含 /hopspec run 则改写,不含则无变化
      const hfSkill = readFileSync(join(fakeHome, '.config/opencode/skills/hopfix/SKILL.md'), 'utf-8');
      expect(hfSkill).toContain('用 hopspec skill 执行');   // hopfix SKILL.md 原 /hopspec run → 改写
      expect(hfSkill).not.toContain('/hopspec run');
    });

    // @v: anc-cli-stale-skill-scan —— 陈旧副本处置（hopissues/0096 起;2026-10-07 自带件改为挪进备份区,非本器零打扰）
    it('install-skill 旧位置旧 demo skill → 整目录挪进 ~/.hopjit/stale-backup,RESTORE.txt 记回路;非本器文件不动（正例+反例——0096:8-14 旧 demo 静默活着 29 child 全灭的对治）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-stale-'));
      const origHome = process.env.HOME;
      const origCfg = process.env.CLAUDE_CONFIG_DIR;
      process.env.HOME = fakeHome;
      delete process.env.CLAUDE_CONFIG_DIR;
      // 旧位置(CC 族扫 ~/.claude/skills)造三件:①本器旧版 demo(该报)②非本器文件(零打扰)③本器当前版(零提示)
      const oldRoot = join(fakeHome, '.claude', 'skills');
      mkdirSync(join(oldRoot, 'demo-fact-check'), { recursive: true });
      writeFileSync(join(oldRoot, 'demo-fact-check', 'SKILL.md'), '---\nname: demo-fact-check\n---\n<!-- driver: @hoplogic/hopjit v0.1.0 (x) installed 2026-08-14 -->\n');
      writeFileSync(join(oldRoot, 'demo-fact-check', 'spec.md'), '# Spec: x\n');   // 无 engine_min_version 指纹
      mkdirSync(join(oldRoot, 'user-own-skill'), { recursive: true });
      writeFileSync(join(oldRoot, 'user-own-skill', 'SKILL.md'), '---\nname: user-own-skill\n---\n用户自建,无本器版本戳\n');
      const targetDir = join(fakeHome, 'fresh-target');
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', targetDir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        if (origCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = origCfg;
      }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      const notes: string[] = r.stale_notes ?? [];
      expect(notes.some(n => n.includes('已挪走') && n.includes(join(oldRoot, 'demo-fact-check')) && n.includes('HopAnt'))).toBe(true);
      expect(notes.some(n => n.includes('user-own-skill'))).toBe(false);                          // 非本器文件零打扰
      expect(existsSync(join(oldRoot, 'user-own-skill', 'SKILL.md'))).toBe(true);                 // 非本器文件原地不动
      expect(existsSync(join(oldRoot, 'demo-fact-check'))).toBe(false);                           // 原目录已挪走
      const backupRoot = join(fakeHome, '.hopjit', 'stale-backup');
      const [stamp] = readdirSync(backupRoot);
      expect(readFileSync(join(backupRoot, stamp, 'demo-fact-check', 'SKILL.md'), 'utf-8')).toContain('v0.1.0');   // 内容完整进了备份区
      expect(readFileSync(join(backupRoot, stamp, 'RESTORE.txt'), 'utf-8')).toContain(`→ ${join(oldRoot, 'demo-fact-check')}`);
    });

    // @v: anc-cli-stale-skill-scan —— 现行目标目录里的旧 demo skill（CC 旧 --demo 与正式件同目录）也挪走,其他件不动
    it('setup 现行目标目录里的旧 demo-* skill 挪进备份区,同目录的当前版正式件不动（正例+反例）', async () => {
      const targetDir = join(process.env.HOME!, 'tgt');
      mkdirSync(join(targetDir, 'demo-rename'), { recursive: true });
      writeFileSync(join(targetDir, 'demo-rename', 'SKILL.md'), '---\nname: demo-rename\n---\n<!-- driver: @hoplogic/hopjit v9.9.9 (x) installed 2026-10-01 -->\n');
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', targetDir, '--force']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      const notes: string[] = r.stale_notes ?? [];
      expect(notes.some(n => n.includes(join(targetDir, 'demo-rename')) && n.includes('已挪走'))).toBe(true);   // 版本号不论新旧都挪
      expect(notes.some(n => n.includes(join(targetDir, 'hopspec')))).toBe(false);                              // 本次刚装的正式件不报
      expect(existsSync(join(targetDir, 'demo-rename'))).toBe(false);
      expect(existsSync(join(targetDir, 'hopspec', 'SKILL.md'))).toBe(true);                                     // 正式件不动
    });

    // @v: anc-cli-stale-skill-scan —— 旧名 hopskill-build 按自带件挪走,不再被当成用户自建件指路 /hopfix（2026-10-07 实撞）
    it('Codex 旧位置 ~/.agents/skills 的 hopspec 与旧名 hopskill-build 陈旧副本都挪进备份区;带戳的用户自建件原地不动指路 /hopfix（正例+反例）', async () => {
      const legacyRoot = join(process.env.HOME!, '.agents', 'skills');
      const stamp = '<!-- driver: @hoplogic/hopjit v0.2.6 (x) installed 2026-08-14T06:51:27.024Z -->';
      for (const name of ['hopspec', 'hopskill-build', 'my-flow']) {
        mkdirSync(join(legacyRoot, name), { recursive: true });
        writeFileSync(join(legacyRoot, name, 'SKILL.md'), `---\nname: ${name}\n---\n${stamp}\n`);
      }
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'codex', '--dir', join(process.env.HOME!, 'codex-skills'), '--force']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      const notes: string[] = r.stale_notes ?? [];
      for (const name of ['hopspec', 'hopskill-build']) {
        expect(existsSync(join(legacyRoot, name))).toBe(false);
        expect(notes.some(n => n.includes('已挪走') && n.includes(join(legacyRoot, name)))).toBe(true);
      }
      expect(notes.some(n => n.includes('hopskill-build') && n.includes('/hopfix'))).toBe(false);   // 旧名不再误指 /hopfix
      expect(existsSync(join(legacyRoot, 'my-flow', 'SKILL.md'))).toBe(true);                        // 用户自建件原地不动
      expect(notes.some(n => n.includes(join(legacyRoot, 'my-flow')) && n.includes('/hopfix'))).toBe(true);
      const backupRoot = join(process.env.HOME!, '.hopjit', 'stale-backup');
      const stamps = readdirSync(backupRoot);
      expect(stamps).toHaveLength(1);                                                                  // 同一次 setup 共用一个时间戳目录
      const restore = readFileSync(join(backupRoot, stamps[0], 'RESTORE.txt'), 'utf-8').trim().split('\n');
      expect(restore).toHaveLength(2);
    });

    // @v: anc-cli-stale-skill-scan —— 挪动失败退回只提示,原目录不动
    it('备份区建不起来（~/.hopjit/stale-backup 被普通文件占位）→ 陈旧副本原地不动,stale_notes 退回提示并写明失败（反例）', async () => {
      const oldRoot = join(process.env.HOME!, '.agents', 'skills');
      mkdirSync(join(oldRoot, 'hopfix'), { recursive: true });
      writeFileSync(join(oldRoot, 'hopfix', 'SKILL.md'), '---\nname: hopfix\n---\n<!-- driver: @hoplogic/hopjit v0.0.1 (x) installed 2026-01-01 -->\n');
      mkdirSync(join(process.env.HOME!, '.hopjit'), { recursive: true });
      writeFileSync(join(process.env.HOME!, '.hopjit', 'stale-backup'), '占位');
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'codex', '--dir', join(process.env.HOME!, 'tgt2'), '--force']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');                                                                     // 不拦装载
      const notes: string[] = r.stale_notes ?? [];
      expect(notes.some(n => n.includes(join(oldRoot, 'hopfix')) && n.includes('挪进备份区失败') && n.includes('原目录未动'))).toBe(true);
      expect(existsSync(join(oldRoot, 'hopfix', 'SKILL.md'))).toBe(true);
    });

    // @v: anc-cli-stale-skill-scan —— 别的载体的现行安装目录不是旧位置（2026-10-07 实撞:opencode 轮挪走了 CC 在用的 hopbuild2）
    it('setup --carrier opencode 不动 ~/.claude/skills 里的自带件,哪怕版本落后、spec.md 无指纹;只挪那里的旧 demo-*（反例+正例）', async () => {
      const ccRoot = join(process.env.HOME!, '.claude', 'skills');
      for (const [name, v] of [['hopbuild2', '0.0.1'], ['hopfix', '0.0.1'], ['demo-rename', '0.0.1']] as const) {
        mkdirSync(join(ccRoot, name), { recursive: true });
        writeFileSync(join(ccRoot, name, 'SKILL.md'), `---\nname: ${name}\n---\n<!-- driver: @hoplogic/hopjit v${v} (x) installed 2026-10-01 -->\n`);
      }
      writeFileSync(join(ccRoot, 'hopbuild2', 'spec.md'), '# Spec: hopbuild2\n');
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--dir', join(process.env.HOME!, 'oc-skills'), '--force']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      const notes: string[] = r.stale_notes ?? [];
      expect(existsSync(join(ccRoot, 'hopbuild2', 'spec.md'))).toBe(true);
      expect(existsSync(join(ccRoot, 'hopfix', 'SKILL.md'))).toBe(true);
      expect(notes.some(n => n.includes(join(ccRoot, 'hopbuild2')) || n.includes(join(ccRoot, 'hopfix')))).toBe(false);
      expect(existsSync(join(ccRoot, 'demo-rename'))).toBe(false);                                   // 旧 demo 仍挪
    });

    // @v: anc-cli-stale-skill-scan —— 缺 engine_min_version 指纹只判用户自建件;当前版自带件不因此误判
    it('Codex 旧位置当前版 hopbuild2（spec.md 无指纹）不挪;同处当前版用户自建件缺指纹仍指路 /hopfix（反例+正例）', async () => {
      const legacyRoot = join(process.env.HOME!, '.agents', 'skills');
      const v = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')).version;
      for (const name of ['hopbuild2', 'my-flow']) {
        mkdirSync(join(legacyRoot, name), { recursive: true });
        writeFileSync(join(legacyRoot, name, 'SKILL.md'), `---\nname: ${name}\n---\n<!-- driver: @hoplogic/hopjit v${v} (x) installed 2026-10-07 -->\n`);
        writeFileSync(join(legacyRoot, name, 'spec.md'), `# Spec: ${name}\n`);
      }
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'codex', '--dir', join(process.env.HOME!, 'codex-skills2'), '--force']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      const notes: string[] = r.stale_notes ?? [];
      expect(existsSync(join(legacyRoot, 'hopbuild2', 'spec.md'))).toBe(true);
      expect(notes.some(n => n.includes(join(legacyRoot, 'hopbuild2')))).toBe(false);
      expect(notes.some(n => n.includes(join(legacyRoot, 'my-flow')) && n.includes('/hopfix'))).toBe(true);
    });

    // opencode 读 OPENCODE_CONFIG_DIR:在场装到重定向 config 目录
    it('install-skill --carrier opencode 读 OPENCODE_CONFIG_DIR 装到重定向 home（正例）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-opencode-redir-'));
      const origHome = process.env.HOME;
      const origCfgDir = process.env.CLAUDE_CONFIG_DIR;
      const origCodexHome = process.env.CODEX_HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CODEX_HOME;
      delete process.env.XDG_CONFIG_HOME;
      process.env.OPENCODE_CONFIG_DIR = join(fakeHome, 'custom-oc-home');   // 模拟重定向
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        if (origCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = origCfgDir;
        if (origCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = origCodexHome;
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.target).toBe(join(fakeHome, 'custom-oc-home', 'skills'));
      expect(existsSync(join(fakeHome, 'custom-oc-home/skills/hopspec/SKILL.md'))).toBe(true);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--plus', '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--plus', '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']);
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

    // @v: anc-cli-install-skill, anc-cli-install-skill-permission, anc-cli-install-skill-single-entry, anc-cli-hop-dispatch
    // 2026-10-01 作者定"核心是通过安装和 /hop 完成对 coding agent 的教育,对用户尽可能傻瓜化"：缺省即注册+放行+单入口
    describe('install-skill 缺省傻瓜化（0132 后续）', () => {
      it('正例：不带 --mcp 也注册 .mcp.json 并写 CC 放行;六件装齐但只有 hop 用户可见;hop-ops.md 随装', () => withMcpEnv(async ({ cwd }) => {
        const dir = mkdtempSync(join(tmpdir(), 'hopskill-def-'));
        const fakeBin = mkdtempSync(join(tmpdir(), 'hopskill-bin-'));
        writeFileSync(join(fakeBin, 'hopjit-mcp'), '');   // 握手只查 command 在 PATH 上能否找到,不执行它
        const oldPath = process.env.PATH;
        process.env.PATH = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${oldPath ?? ''}`;
        const cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', dir, '--force']); } finally { cap.restore(); process.env.PATH = oldPath; }
        const out = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect(out.mcp_registered).toContain('.mcp.json');
        expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8')).mcpServers.hopjit.command).toBe('hopjit-mcp');
        expect(out.permission_written).toContain(join('.claude', 'settings.local.json'));
        const perm = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf-8'));
        // 放行清单=HOPJIT_ALLOWED_TOOLS 全量,含 approve_commit（todo/0146;人批准在对话里问）// @v: anc-cli-install-skill-permission
        expect(perm.permissions.allow).toEqual(EXPECTED_ALLOW);
        expect(HOPJIT_ALLOWED_TOOLS.map(t => `mcp__hopjit__${t}`)).toEqual(EXPECTED_ALLOW);   // 常量与写死名单一致
        expect(perm.permissions.allow).toContain('mcp__hopjit__approve_commit');
        expect(perm.permissions.allow.some((x: string) => x.includes('*'))).toBe(false);   // 不加通配（通配会放行以后新增、尚未评估的工具）
        expect(Object.keys(perm)).toEqual(['permissions']);   // 新建时不多写别的键
        // 项目级注册后做一次握手自检,结果随输出返回（todo/0146）// @v: anc-cli-install-skill-handshake
        expect(out.mcp_handshake).toBeTruthy();
        expect(out.mcp_handshake.ok).toBe(true);
        expect(out.mcp_handshake.tools).toContain('approve_commit');
        for (const name of ['hop', 'hopspec', 'hopspec-mcp', 'hopbuild', 'hopbuild2', 'hopfix']) expect(existsSync(join(dir, name, 'SKILL.md'))).toBe(true);
        // 键名必须是 CC 官方的连字符形 user-invocable（下划线形被 CC 静默忽略——review 实锤,下划线自 8 月起一直是空操作）
        expect(readFileSync(join(dir, 'hop', 'SKILL.md'), 'utf-8')).toMatch(/^user-invocable: true$/m);
        for (const name of ['hopspec', 'hopspec-mcp', 'hopbuild', 'hopbuild2', 'hopfix']) expect(readFileSync(join(dir, name, 'SKILL.md'), 'utf-8')).toMatch(/^user-invocable: false$/m);
        for (const name of ['hop', 'hopspec', 'hopspec-mcp', 'hopbuild', 'hopbuild2', 'hopfix']) expect(readFileSync(join(dir, name, 'SKILL.md'), 'utf-8')).not.toContain('user_invocable');
        expect(existsSync(join(dir, 'hop', 'references', 'hop-ops.md'))).toBe(true);
        expect(existsSync(join(dir, 'hopspec', 'references', 'hop-ops.md'))).toBe(false);   // 运维件只归 hop,不混进 hopspec/references
        expect(readFileSync(join(dir, 'hop', 'SKILL.md'), 'utf-8')).toContain('### 0. 分派');
      }));

      it('放行幂等三形态：已有别的条目追加不覆盖;二跑不重复;坏 JSON 不写只 note', () => withMcpEnv(async ({ cwd }) => {
        const dir = mkdtempSync(join(tmpdir(), 'hopskill-perm-'));
        mkdirSync(join(cwd, '.claude'), { recursive: true });
        writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] }, other: 1 }, null, 2));
        let cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', dir, '--force']); } finally { cap.restore(); }
        let perm = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf-8'));
        expect(perm.permissions.allow).toEqual(['Bash(ls:*)', ...EXPECTED_ALLOW]);
        expect(perm.permissions.deny).toEqual(['Bash(rm:*)']);
        expect(perm.other).toBe(1);
        cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', dir, '--force']); } finally { cap.restore(); }
        const out2 = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect(out2.permission_written).toBeNull();
        expect(out2.permission_note).toContain('未改动');
        perm = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf-8'));
        expect(perm.permissions.allow.filter((x: string) => x === 'mcp__hopjit__run_approved_command')).toHaveLength(1);
        // 旧版只写了 run_approved_command 的项目:重跑只补缺的,已有的不重复
        writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['mcp__hopjit__run_approved_command'] } }));
        cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', dir, '--force']); } finally { cap.restore(); }
        perm = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf-8'));
        expect(perm.permissions.allow[0]).toBe('mcp__hopjit__run_approved_command');   // 已有条目原位不动
        expect([...perm.permissions.allow].sort()).toEqual([...EXPECTED_ALLOW].sort());
        writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{ 坏 json');
        cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', dir, '--force']); } finally { cap.restore(); }
        const out3 = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect(out3.permission_written).toBeNull();
        expect(out3.permission_note).toContain('不是合法 JSON');
        expect(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf-8')).toBe('{ 坏 json');   // 未覆盖
      }));

      it('反例：codex 载体不写 CC 放行文件,permission_note 指路放行 hopjit 的 MCP 工具（不再有除外项）', () => withMcpEnv(async ({ cwd }) => {
        const dir = mkdtempSync(join(tmpdir(), 'hopskill-cx-'));
        const cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'codex', '--dir', dir, '--force']); } finally { cap.restore(); }
        const out = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect(out.permission_written).toBeNull();
        expect(out.permission_note).toContain('hopjit 的 MCP 工具');
        expect(out.permission_note).not.toContain('除外');
        expect(existsSync(join(cwd, '.claude', 'settings.local.json'))).toBe(false);
      }));

      it('反例：opencode 载体不写 CC 放行文件（carrierFamily 把它归 cc 系——判据必须显式枚举）,note 含工具名与 tools 节说明;hop-ops.md 随装', () => withMcpEnv(async ({ cwd, home }) => {
        const dir = mkdtempSync(join(tmpdir(), 'hopskill-oc-'));
        process.env.OPENCODE_CONFIG_DIR = join(home, 'opencode');
        const cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--dir', dir, '--force']); }
        finally { cap.restore(); delete process.env.OPENCODE_CONFIG_DIR; }
        const out = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect(out.permission_written).toBeNull();
        expect(out.permission_note).toContain('hopjit 的 MCP 工具');
        expect(out.permission_note).not.toContain('除外');
        expect(out.permission_note).toContain('tools 节');   // b 案：server 已启用,note 说的是 tools 节已关独立模式工具（^anc-cli-opencode-tools-gate）
        expect(out.permission_note).not.toContain('enabled 改为 true');
        expect(existsSync(join(cwd, '.claude', 'settings.local.json'))).toBe(false);
        expect(existsSync(join(dir, 'hop', 'references', 'hop-ops.md'))).toBe(true);
        expect(readFileSync(join(dir, 'hop', 'SKILL.md'), 'utf-8')).toMatch(/^user-invocable: true$/m);
      }));

      it('codex 载体 hop-ops.md 随装（三载体拷贝各自有钉）', () => withMcpEnv(async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hopskill-cx2-'));
        const cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'codex', '--dir', dir, '--force']); } finally { cap.restore(); }
        expect(existsSync(join(dir, 'hop', 'references', 'hop-ops.md'))).toBe(true);
        expect(readFileSync(join(dir, 'hop', 'SKILL.md'), 'utf-8')).toMatch(/^user-invocable: true$/m);
      }));

      it('放行非法形态三支：顶层数组 / permissions 非对象 / allow 非数组 → 文件字节不变,只 note', () => withMcpEnv(async ({ cwd }) => {
        const dir = mkdtempSync(join(tmpdir(), 'hopskill-perm2-'));
        mkdirSync(join(cwd, '.claude'), { recursive: true });
        const f = join(cwd, '.claude', 'settings.local.json');
        for (const [raw, kw] of [['[1,2]', '顶层不是对象'], ['{"permissions":"abc"}', 'permissions 不是对象'], ['{"permissions":{"allow":"Bash(ls:*)"}}', 'allow 不是数组']] as const) {
          writeFileSync(f, raw);
          const cap = capture();
          try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', dir, '--force']); } finally { cap.restore(); }
          const out = JSON.parse(cap.get().trim().split('\n').pop()!);
          expect(out.permission_written).toBeNull();
          expect(out.permission_note).toContain(kw);
          expect(readFileSync(f, 'utf-8')).toBe(raw);   // 一个字节都没动
        }
      }));

      it('不带 --mcp 时 output 恒带 mcp_registered / mcp_config_bootstrapped 两键（可为 null）;fake HOME 无配置无凭证 → mcp_config_note 点明 run_approved_command 不可达', () => withMcpEnv(async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hopskill-keys-'));
        const savedEnv: Record<string, string | undefined> = {};
        for (const k of Object.keys(process.env)) if (k.startsWith('ANTHROPIC_')) { savedEnv[k] = process.env[k]; delete process.env[k]; }   // 自举学习源=宿主 ANTHROPIC_*,本例要'学不到'
        const cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', dir, '--force']); }
        finally { cap.restore(); for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v; }
        const out = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect('mcp_registered' in out).toBe(true);
        expect('mcp_config_bootstrapped' in out).toBe(true);
        expect(out.mcp_config_bootstrapped).toBeNull();
        expect(out.mcp_config_note).toContain('run_approved_command');
      }));

      it('自举抛异常 → status 仍 ok,mcp_config_note 带"自举失败"（不阻断 skill 安装）', () => withMcpEnv(async ({ home }) => {
        const dir = mkdtempSync(join(tmpdir(), 'hopskill-boot-'));
        // 让自举在写 ~/.hopjit/config.yaml 时真抛：把 ~/.hopjit 占成一个文件,mkdirSync 必 ENOTDIR/EEXIST（ESM 命名导出 spy 不进内部调用,改用环境造异常）
        writeFileSync(join(home, '.hopjit'), 'not-a-dir');
        process.env.ANTHROPIC_AUTH_TOKEN = 'x';   // 保证走到写盘那一步
        const cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', dir, '--force']); }
        finally { cap.restore(); delete process.env.ANTHROPIC_AUTH_TOKEN; }
        const out = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect(out.status).toBe('ok');
        expect(out.mcp_config_bootstrapped).toBeNull();
        expect(out.mcp_config_note).toContain('自举失败');
      }));

      it('注册面环境性失败 → status 仍 ok,mcp_note 带"注册失败"（非用户配置损坏,降 note 不阻断;与坏 JSON 响亮形态成对）', () => withMcpEnv(async ({ cwd }) => {
        if (process.getuid && process.getuid() === 0) return;   // root 无视权限位
        const dir = mkdtempSync(join(tmpdir(), 'hopskill-regfail-'));
        // 合法 .mcp.json 在场（没有 hopjit 条目）但目录只读：读得过、写不进——writeFileSync EACCES 是环境性失败,不是用户配置损坏
        writeFileSync(join(cwd, '.mcp.json'), '{"mcpServers":{}}');
        const { chmodSync } = await import('node:fs');
        chmodSync(join(cwd, '.mcp.json'), 0o444);   // 文件只读：writeFileSync EACCES
        chmodSync(cwd, 0o555);                      // 目录只读：放行的 mkdir .claude EACCES
        const cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', dir, '--force']); }
        finally { cap.restore(); chmodSync(cwd, 0o755); chmodSync(join(cwd, '.mcp.json'), 0o644); }
        const out = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect(out.status).toBe('ok');
        expect(out.mcp_registered).toBeNull();
        expect(out.mcp_note).toContain('注册失败');
        expect(out.permission_written).toBeNull();   // 同一只读 cwd 下放行写入也只 note（首版此处抛出炸整条安装）
        expect(out.permission_note).toContain('放行写入失败');
      }));

      it('codex/opencode 载体六件装齐且五件 user-invocable: false（单入口三载体同形）', () => withMcpEnv(async ({ home }) => {
        for (const carrier of ['codex', 'opencode']) {
          const dir = mkdtempSync(join(tmpdir(), `hopskill-six-${carrier}-`));
          if (carrier === 'opencode') process.env.OPENCODE_CONFIG_DIR = join(home, 'opencode');
          const cap = capture();
          try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', carrier, '--dir', dir, '--force']); }
          finally { cap.restore(); delete process.env.OPENCODE_CONFIG_DIR; }
          for (const name of ['hop', 'hopspec', 'hopspec-mcp', 'hopbuild', 'hopbuild2', 'hopfix']) expect(existsSync(join(dir, name, 'SKILL.md'))).toBe(true);
          expect(readFileSync(join(dir, 'hop', 'SKILL.md'), 'utf-8')).toMatch(/^user-invocable: true$/m);
          for (const name of ['hopspec', 'hopspec-mcp', 'hopbuild', 'hopbuild2', 'hopfix']) expect(readFileSync(join(dir, name, 'SKILL.md'), 'utf-8')).toMatch(/^user-invocable: false$/m);
        }
      }));

      it('陈旧副本扫描：六件之一（hopfix）旧版本副本在旧位置 → 按本器自带件挪进备份区（isBundled 清单保护）', () => withMcpEnv(async ({ home }) => {
        const dir = mkdtempSync(join(tmpdir(), 'hopskill-stale-'));
        const legacy = join(home, '.agents', 'skills', 'hopfix');   // Codex 用户级旧位置
        mkdirSync(legacy, { recursive: true });
        writeFileSync(join(legacy, 'SKILL.md'), '---\nname: hopfix\n---\n<!-- driver: @hoplogic/hopjit v0.0.1 (x) installed 2026-01-01T00:00:00.000Z -->\n');
        const cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'codex', '--dir', dir, '--force']); } finally { cap.restore(); }
        const out = JSON.parse(cap.get().trim().split('\n').pop()!);
        const notes: string[] = out.stale_notes ?? [];
        expect(notes.some(n => n.includes(legacy) && n.includes('已挪走'))).toBe(true);
        expect(existsSync(legacy)).toBe(false);
      }));
    });

    // @v: anc-cli-carrier-autodetect — install-skill 缺省按载体 home 在场自动探测,--carrier 降为覆盖（2026-10-03 作者定"智能探测不是手工选择"）
    describe('install-skill 载体自动探测', () => {
      function withHome(fn: (home: string) => Promise<void> | void): Promise<void> {
        const fakeHome = mkdtempSync(join(tmpdir(), 'hopdetect-home-'));
        const cwd = mkdtempSync(join(tmpdir(), 'hopdetect-cwd-'));
        const oldCwd = process.cwd();
        const saved: Record<string, string | undefined> = {};
        for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'HOPJIT_POSTINSTALL']) { saved[k] = process.env[k]; delete process.env[k]; }
        process.env.HOME = fakeHome;
        process.chdir(cwd);
        return Promise.resolve(fn(fakeHome)).finally(() => {
          process.chdir(oldCwd);
          for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        });
      }
      const runInstall = async (args: string[]) => {
        const cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', ...args]); } finally { cap.restore(); }
        return JSON.parse(cap.get().trim().split('\n').pop()!);
      };

      it('detectCarriers：按 home 在场探测,顺序固定,零在场空数组（正反例）', () => withHome((home) => {
        expect(detectCarriers(adminCtx())).toEqual([]);
        mkdirSync(join(home, '.codex'), { recursive: true });
        expect(detectCarriers(adminCtx())).toEqual(['codex']);
        mkdirSync(join(home, '.claude'), { recursive: true });
        mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
        expect(detectCarriers(adminCtx())).toEqual(['cc', 'codex', 'opencode']);
      }));

      it('detectCarriers：CLAUDE_CONFIG_DIR 把 cc 重定向到 cfuse 目录时与 cfuse-cc 去重,只报先探到的 cc', () => withHome((home) => {
        const cfuseCc = join(home, '.codefuse', 'engine', 'cc');
        mkdirSync(cfuseCc, { recursive: true });
        process.env.CLAUDE_CONFIG_DIR = cfuseCc;
        expect(detectCarriers(adminCtx())).toEqual(['cc']);
        delete process.env.CLAUDE_CONFIG_DIR;
        expect(detectCarriers(adminCtx())).toEqual(['cfuse-cc']);   // 裸终端无重定向：~/.claude 不在,cfuse-cc 自己在
      }));

      it('零参数两载体在场 → 两个都装,carriers/results 两元素,顶层字段=第一个载体的值', () => withHome(async (home) => {
        mkdirSync(join(home, '.claude'), { recursive: true });
        mkdirSync(join(home, '.codex'), { recursive: true });
        const out = await runInstall(['--force']);
        expect(out.status).toBe('ok');
        expect(out.carriers).toEqual(['cc', 'codex']);
        expect(out.results).toHaveLength(2);
        expect(out.carrier).toBe('cc');
        expect(out.target).toBe(join(home, '.claude', 'skills'));
        expect(out.results[1].carrier).toBe('codex');
        expect(out.results[1].target).toBe(join(home, '.codex', 'skills'));
        expect(existsSync(join(home, '.claude', 'skills', 'hop', 'SKILL.md'))).toBe(true);
        expect(existsSync(join(home, '.codex', 'skills', 'hop', 'SKILL.md'))).toBe(true);
        expect(out.detect_note).toContain('cc, codex');
        // todo/0139 挂钩①：顶层恒带 next_step,指向包内 AGENT-GUIDE 绝对路径且文件真在场（死路径=指了等于没指） // @v: anc-cli-install-skill
        expect(out.next_step).toContain('AGENT-GUIDE.md');
        const guidePath = out.next_step.match(/(\/\S+AGENT-GUIDE\.md)/)?.[1];
        expect(guidePath, 'next_step 里要有绝对路径').toBeTruthy();
        expect(existsSync(guidePath!)).toBe(true);
        expect(out.results[0].next_step, 'next_step 与载体无关,不进 results').toBeUndefined();
        // 第二句指路可贴进项目 CLAUDE.md/AGENTS.md 的模板（todo/0139 挂钩②改形态）——同样核绝对路径真在场 // @v: anc-cli-install-skill
        expect(out.next_step).toContain('先问用户');
        const tplPath = out.next_step.match(/(\/\S+agent-instructions-template\.md)/)?.[1];
        expect(tplPath, 'next_step 里要有模板绝对路径').toBeTruthy();
        expect(existsSync(tplPath!)).toBe(true);
      }));

      it('零在场 → 回落只装 cc 并 detect_note 说明（旧缺省不退化）;显式 --carrier codex 时 ~/.claude 在场也不碰（反例）', () => withHome(async (home) => {
        const out = await runInstall(['--force']);
        expect(out.carriers).toEqual(['cc']);
        expect(out.detect_note).toContain('未探到任何载体');
        expect(existsSync(join(home, '.claude', 'skills', 'hop', 'SKILL.md'))).toBe(true);
        rmSync(join(home, '.claude'), { recursive: true, force: true });
        mkdirSync(join(home, '.claude'), { recursive: true });
        const out2 = await runInstall(['--carrier', 'codex', '--force']);
        expect(out2.carriers).toEqual(['codex']);
        expect(out2.detect_note).toBeUndefined();
        expect(existsSync(join(home, '.claude', 'skills'))).toBe(false);
        expect(out2.next_step, '显式 --carrier 路径同样恒带').toContain('AGENT-GUIDE.md');   // @v: anc-cli-install-skill
      }));

      it('--dir 给了目录不探测,等价 cc（旧行为）', () => withHome(async (home) => {
        mkdirSync(join(home, '.codex'), { recursive: true });
        const dir = mkdtempSync(join(tmpdir(), 'hopdetect-dir-'));
        const out = await runInstall(['--dir', dir, '--force']);
        expect(out.carriers).toEqual(['cc']);
        expect(out.target).toBe(dir);
        expect(existsSync(join(home, '.codex', 'skills'))).toBe(false);
      }));

      // @v: anc-cli-postinstall — 钩子已撤（2026-10-09 todo/0143）:package.json 不再登记 postinstall,dist 里没有 postinstall.js,HOPJIT_POSTINSTALL 不再有任何分支
      it('postinstall 钩子已撤：package.json 无 postinstall 字段;HOPJIT_POSTINSTALL=1 不再改变 setup 行为（项目级两件照写）', () => withHome(async (home) => {
        const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));
        expect(pkg.scripts.postinstall).toBeUndefined();
        expect(existsSync(resolve(__dirname, '..', 'src', 'postinstall.ts'))).toBe(false);
        mkdirSync(join(home, '.claude'), { recursive: true });
        process.env.HOPJIT_POSTINSTALL = '1';
        const out = await runInstall(['--force']);
        expect(out.mcp_registered).toBe(resolve(process.cwd(), '.mcp.json'));   // 变异：恢复 projectScope 分支 → null 红
        expect(out.permission_written).toBe(resolve(process.cwd(), '.claude', 'settings.local.json'));
      }));

      // @v: anc-cli-first-run-hint — 撤钩子后漏跑 setup 的唯一兜底：下一条任何 hopjit 命令 stderr 一行指路,零状态,不碰 --json 的 stdout
      describe('首次运行提示', () => {
        const stamp = (v: string) => `---\nname: hop\n---\n<!-- driver: @hoplogic/hopjit v${v} (/pkg) installed 2026-10-09T00:00:00.000Z -->\n# hop\n`;
        const cur = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')).version as string;
        it('纯函数七支：豁免命令 / 版本与帮助 / 静音与 CI / 零载体 / 全装同版本 → 空;有未装 → 指路 setup;只有落后 → 指路刷新', () => {
          const probeMissing = () => null; const probeOk = () => cur; const probeOld = () => '0.0.1';
          expect(firstRunHint(['setup'], {}, cur, probeMissing)).toBe('');
          expect(firstRunHint(['install-skill', '--force'], {}, cur, probeMissing)).toBe('');
          expect(firstRunHint(['--version'], {}, cur, probeMissing)).toBe('');
          expect(firstRunHint(['list', '--help'], {}, cur, probeMissing)).toBe('');
          expect(firstRunHint([], {}, cur, probeMissing)).toBe('');
          return withHome(async (home) => {
            expect(firstRunHint(['list'], {}, cur, probeMissing)).toBe('');   // 假 HOME 下零载体
            mkdirSync(join(home, '.claude'), { recursive: true });
            expect(firstRunHint(['--json', 'list'], {}, cur, probeMissing)).toMatch(/^\[hopjit\] \/hop 还没装进本机 agent（cc）——运行 hopjit setup/);
            expect(firstRunHint(['list'], { HOPJIT_SKIP_SKILL: '1' }, cur, probeMissing)).toBe('');   // 有载体且未装,静音开关压住（变异：删开关 → 红）
            expect(firstRunHint(['list'], { CI: 'true' }, cur, probeMissing)).toBe('');
            expect(firstRunHint(['list'], {}, cur, probeOk)).toBe('');
            expect(firstRunHint(['list'], {}, cur, probeOld)).toMatch(/版本落后（cc 装于 v0\.0\.1,当前 v/);
          });
        });
        it('真读戳：探到 cc 无 hop/SKILL.md → 提示;写入同版本戳 → 零输出;戳改旧版本 → 落后提示', () => withHome(async (home) => {
          mkdirSync(join(home, '.claude', 'skills', 'hop'), { recursive: true });
          expect(firstRunHint(['list'], {}, cur)).toContain('还没装进本机 agent（cc）');
          writeFileSync(join(home, '.claude', 'skills', 'hop', 'SKILL.md'), stamp(cur));
          expect(firstRunHint(['list'], {}, cur)).toBe('');   // 变异：戳正则改坏 → 这里仍提示红
          writeFileSync(join(home, '.claude', 'skills', 'hop', 'SKILL.md'), stamp('0.1.0'));
          expect(firstRunHint(['list'], {}, cur)).toContain('版本落后（cc 装于 v0.1.0');
        }));
        it('挂点：`--json list` 在未装机器上 stderr 一行指路,stdout 仍是纯 JSON;setup 自身零提示（跨进程真跑）', () => withHome(async (home) => {
          mkdirSync(join(home, '.claude'), { recursive: true });
          const env = { ...process.env, HOME: home, HOPJIT_ANTHROPIC_API_KEY: '' }; delete env.HOPJIT_SKIP_SKILL; delete env.CI; delete env.CLAUDE_CONFIG_DIR;
          const r = spawnSync(process.execPath, [CLI, '--json', 'list', mkdtempSync(join(tmpdir(), 'frh-ls-'))], { env, encoding: 'utf-8' });
          expect(r.stderr).toMatch(/^\[hopjit\] \/hop 还没装进本机 agent（cc）——运行 hopjit setup/);   // 变异：preAction 不写 stderr → 红
          expect(() => JSON.parse(r.stdout.trim())).not.toThrow();   // stdout 纯净
          const r2 = spawnSync(process.execPath, [CLI, '--json', 'setup', '--dir', mkdtempSync(join(tmpdir(), 'frh-sk-'))], { env, encoding: 'utf-8', cwd: mkdtempSync(join(tmpdir(), 'frh-cwd-')) });
          expect(r2.stderr).not.toContain('还没装进本机 agent');
        }));
      });

      // @v: anc-cli-doctor
      describe('hopjit doctor（^anc-cli-doctor）', () => {
        const cur = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')).version as string;
        const okHandshake = () => ({ ok: true, tools: ['run', 'status'], standalone_available: false });
        const byId = (items: { id: string; carrier: string; status: string; detail: string; hint?: string }[], id: string, carrier?: string) =>
          items.filter(i => i.id === id && (carrier === undefined || i.carrier === carrier));
        const one = (items: { id: string; carrier: string; status: string; detail: string; hint?: string }[], id: string, carrier?: string) => { const l = byId(items, id, carrier); expect(l, id).toHaveLength(1); return l[0]; };
        // 假 HOME 下只造 cc 一个载体（~/.claude 在场）,setup 在临时 cwd 跑——cwd 的 .mcp.json 与 settings.local.json 就是 doctor 要看的项目级两件
        const ccReady = async (home: string, extraEnv: Record<string, string> = {}) => {
          mkdirSync(join(home, '.claude'), { recursive: true });
          process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'x';   // 让自举学到 providers（只写名）
          await runInstall([]);
          return { ...process.env, ...extraEnv } as NodeJS.ProcessEnv;
        };

        it('正：setup 后全好——八问 ok（cc 单载体 8 项）,exit_code 0;握手注入 ok', () => withHome(async (home) => {
          const env = await ccReady(home, { ANTHROPIC_API_KEY: 'x' });
          const r = runDoctor(adminCtx(env), { handshake: okHandshake });
          expect(r.carriers).toEqual(['cc']);
          expect(r.items.map(i => i.status)).toEqual(Array(8).fill('ok'));   // 变异：任一问判法改坏 → 对应项非 ok 红
          expect(r.summary).toEqual({ ok: 8, warn: 0, fail: 0, na: 0 });
          expect(r.exit_code).toBe(0);
          expect(one(r.items, 'mcp_handshake').detail).toContain('2 个工具');
          expect(one(r.items, 'permissions').detail).toContain(`${HOPJIT_ALLOWED_TOOLS.length} 项全在`);
          expect(one(r.items, 'mcp_llm_config').detail).toContain('cc_host');
        }));

        it('反：没装 skill → skill_installed fail 且 skill_version / skill_visible 级联 n/a,exit_code 1;hint 指 hopjit setup', () => withHome(async (home) => {
          mkdirSync(join(home, '.claude'), { recursive: true });
          const r = runDoctor(adminCtx({ ...process.env, ANTHROPIC_API_KEY: 'x' }), { handshake: okHandshake });
          const inst = one(r.items, 'skill_installed', 'cc');
          expect(inst.status).toBe('fail'); expect(inst.hint).toContain('hopjit setup');
          expect(one(r.items, 'skill_version', 'cc').status).toBe('n/a');   // 变异：级联不做 → warn/fail 红
          expect(one(r.items, 'skill_visible', 'cc').status).toBe('n/a');
          expect(r.exit_code).toBe(1);   // 变异：exit_code 恒 0 → 红
        }));

        it('反：戳改旧 → skill_version warn 不 fail,exit_code 0;frontmatter 删 user-invocable → cc skill_visible fail', () => withHome(async (home) => {
          const env = await ccReady(home, { ANTHROPIC_API_KEY: 'x' });
          const skill = join(home, '.claude', 'skills', 'hop', 'SKILL.md');
          const orig = readFileSync(skill, 'utf-8');
          writeFileSync(skill, orig.replace(/@hoplogic\/hopjit v[\d.]+/, '@hoplogic/hopjit v0.0.1'));
          let r = runDoctor(adminCtx(env), { handshake: okHandshake });
          const ver = one(r.items, 'skill_version', 'cc');
          expect(ver.status).toBe('warn'); expect(ver.detail).toContain('v0.0.1'); expect(ver.hint).toContain('刷新');   // 变异：落后判 fail → 红
          expect(r.exit_code).toBe(0);
          writeFileSync(skill, orig.replace(/^user-invocable: true$/m, 'user-invocable: false'));
          r = runDoctor(adminCtx(env), { handshake: okHandshake });
          expect(one(r.items, 'skill_visible', 'cc').status).toBe('fail');   // 变异：cc 不核 user-invocable → 红
          expect(one(r.items, 'skill_visible', 'cc').detail).toContain('user-invocable');
        }));

        it('反：.mcp.json 删 hopjit → mcp_registered fail 且 mcp_handshake n/a（不拉起）;permissions 文件删 → fail 缺 N 项', () => withHome(async (home) => {
          const env = await ccReady(home, { ANTHROPIC_API_KEY: 'x' });
          rmSync(join(process.cwd(), '.mcp.json'));
          rmSync(join(process.cwd(), '.claude', 'settings.local.json'));
          const r = runDoctor(adminCtx(env), { handshake: () => { throw new Error('不该拉起'); } });
          expect(one(r.items, 'mcp_registered', 'cc').status).toBe('fail');
          expect(one(r.items, 'mcp_registered', 'cc').hint).toContain('项目根');
          expect(one(r.items, 'mcp_handshake').status).toBe('n/a');   // 变异：没注册也拉起 → throw 红
          const perm = one(r.items, 'permissions', 'cc');
          expect(perm.status).toBe('fail'); expect(perm.detail).toContain(`缺 ${HOPJIT_ALLOWED_TOOLS.length} 项`);
          expect(r.exit_code).toBe(1);
        }));

        it('反：握手失败 → mcp_handshake fail,detail=reason hint=fix（透传 mcpHandshake 的字段）', () => withHome(async (home) => {
          const env = await ccReady(home, { ANTHROPIC_API_KEY: 'x' });
          const r = runDoctor(adminCtx(env), { handshake: () => ({ ok: false, reason: 'R-原因', fix: 'F-修法' }) });
          const h = one(r.items, 'mcp_handshake');
          expect(h.status).toBe('fail'); expect(h.detail).toBe('R-原因'); expect(h.hint).toBe('F-修法');   // 变异：detail/hint 不透传 → 红
        }));

        it('反（作者口径两档）：无 providers → mcp_llm_config fail 且 detail 是"模型没配置"+ 没学到的原因、standalone_credential n/a;providers 在场 env 缺 → credential warn 不 fail exit 0,env 在 → ok', () => withHome(async (home) => {
          mkdirSync(join(home, '.claude'), { recursive: true });
          // 不给 ANTHROPIC_* → 自举学不到 → 无 providers
          delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
          await runInstall([]);
          expect(existsSync(join(home, '.hopjit', 'config.yaml'))).toBe(false);
          let r = runDoctor(adminCtx({ ...process.env }), { handshake: okHandshake });
          const llm = one(r.items, 'mcp_llm_config');
          expect(llm.status).toBe('fail');   // 变异：无 providers 判 warn → 红
          expect(llm.detail).toMatch(/^MCP server 的模型没配置：setup 从 cc 没学到 LLM 配置——.*ANTHROPIC_AUTH_TOKEN\/ANTHROPIC_API_KEY/);   // 变异：detail 不带 learnStandaloneEntry 的 note 半句 → 红
          expect(llm.hint).toContain('config.yaml');
          expect(one(r.items, 'standalone_credential').status).toBe('n/a');   // 变异：级联不做 → 红
          expect(r.exit_code).toBe(1);
          // 现在写一份 providers（变量名 DOCTOR_TEST_KEY）
          mkdirSync(join(home, '.hopjit'), { recursive: true });
          writeFileSync(join(home, '.hopjit', 'config.yaml'), 'providers:\n  - service_id: t\n    protocol: anthropic\n    base_url: https://x\n    model: m\n    api_key_env: DOCTOR_TEST_KEY\n');
          const envNo = { ...process.env } as NodeJS.ProcessEnv; delete envNo.DOCTOR_TEST_KEY;
          r = runDoctor(adminCtx(envNo), { handshake: okHandshake });
          expect(one(r.items, 'mcp_llm_config').status).toBe('ok');
          const cred = one(r.items, 'standalone_credential');
          expect(cred.status).toBe('warn'); expect(cred.detail).toContain('DOCTOR_TEST_KEY'); expect(cred.hint).toContain('只影响 MCP 独立模式');   // 变异：凭证缺判 fail → 红（作者口径：这不是 fail）
          expect(r.items.filter(i => i.status === 'fail').map(i => i.id)).not.toContain('standalone_credential');
          r = runDoctor(adminCtx({ ...envNo, DOCTOR_TEST_KEY: 'v' }), { handshake: okHandshake });
          expect(one(r.items, 'standalone_credential').status).toBe('ok');
        }));

        it('反：零载体 → 问 1-6 各一项 fail（carrier none）,问 7 仍答;exit 1', () => withHome(async () => {
          const r = runDoctor(adminCtx({ ...process.env }), { handshake: () => { throw new Error('不该拉起'); } });
          expect(r.carriers).toEqual([]);
          const fails = r.items.filter(i => i.carrier === 'none');
          expect(fails.map(i => i.id)).toEqual(['skill_installed', 'skill_version', 'skill_visible', 'mcp_registered', 'mcp_handshake', 'permissions']);   // 变异：零载体不出项 → 红
          expect(fails.every(i => i.status === 'fail')).toBe(true);
          expect(one(r.items, 'mcp_llm_config').status).toBe('fail');
          expect(r.exit_code).toBe(1);
        }));

        it('反：opencode 载体 enabled:false（hopjit 自己写的旧形态）→ mcp_registered warn,hint 指路重跑 setup 不叫用户手工改文件;Codex 载体 config.toml 有 [mcp_servers.hopjit] → ok（构造验,非真机）', () => withHome(async (home) => {
          const oc = join(home, '.config', 'opencode'); mkdirSync(join(oc, 'skills', 'hop'), { recursive: true });
          writeFileSync(join(oc, 'skills', 'hop', 'SKILL.md'), `---\nname: hop\ndescription: d\n---\n<!-- driver: @hoplogic/hopjit v${cur} (/pkg) installed 2026-10-09T00:00:00.000Z -->\n`);
          writeFileSync(join(oc, 'opencode.json'), JSON.stringify({ mcp: { hopjit: { type: 'local', command: ['hopjit-mcp'], enabled: false } } }));
          const cx = join(home, '.codex'); mkdirSync(join(cx, 'skills', 'hop'), { recursive: true });
          writeFileSync(join(cx, 'skills', 'hop', 'SKILL.md'), `---\nname: hop\ndescription: d\n---\n<!-- driver: @hoplogic/hopjit v${cur} (/pkg) installed 2026-10-09T00:00:00.000Z -->\n`);
          writeFileSync(join(cx, 'config.toml'), 'model = "m"\n\n[mcp_servers.hopjit]\ncommand = "hopjit-mcp"\n');
          const r = runDoctor(adminCtx({ ...process.env }), { handshake: okHandshake });
          expect(r.carriers).toEqual(['codex', 'opencode']);
          const oreg = one(r.items, 'mcp_registered', 'opencode');
          expect(oreg.status).toBe('warn');   // 变异：enabled:false 判 ok/fail → 红
          expect(oreg.hint).toContain('重跑 hopjit setup');   // 旧形态指路重跑 setup（setup 会升级）,不是叫用户改文件
          expect(oreg.hint).not.toContain('改回 true');
          expect(one(r.items, 'mcp_registered', 'codex').status).toBe('ok');
          expect(one(r.items, 'skill_visible', 'codex').status).toBe('ok');   // 非 cc 系不核 user-invocable（这里没写）
          expect(one(r.items, 'permissions', 'codex').status).toBe('n/a');
          expect(one(r.items, 'permissions', 'opencode').status).toBe('n/a');
          expect(one(r.items, 'mcp_handshake').carrier).toBe('codex');   // 第一个 registered 的载体
        }));

        it('直测三只读函数：learnStandaloneEntry 学到/学不到两态;readMcpRegistration cc 项目级 .mcp.json 与坏 JSON;ccPermissionMissing 四形态 invalid 与缺口', () => withHome(async (home) => {
          mkdirSync(join(home, '.claude'), { recursive: true });
          delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
          expect(learnStandaloneEntry(adminCtx(), 'cc').note).toContain('ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY');
          process.env.ANTHROPIC_API_KEY = 'x';
          const l = learnStandaloneEntry(adminCtx(), 'cc'); expect(l.entry?.api_key_env).toBe('ANTHROPIC_API_KEY'); expect(l.entry?.service_id).toBe('cc_host');
          const cwd = process.cwd();
          expect(readMcpRegistration(adminCtx(process.env, cwd), 'cc').registered).toBe(false);
          writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { hopjit: { command: '/abs/hopjit-mcp' } } }));
          const reg = readMcpRegistration(adminCtx(process.env, cwd), 'cc'); expect(reg.registered).toBe(true); expect(reg.command).toBe('/abs/hopjit-mcp'); expect(reg.where).toContain('.mcp.json');
          writeFileSync(join(cwd, '.mcp.json'), '{bad');
          const bad = readMcpRegistration(adminCtx(process.env, cwd), 'cc'); expect(bad.registered).toBe(false); expect(bad.note).toContain('不是合法 JSON');
          mkdirSync(join(cwd, '.claude'), { recursive: true });
          expect(ccPermissionMissing(cwd).missing).toHaveLength(HOPJIT_ALLOWED_TOOLS.length);
          writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{bad');
          expect(ccPermissionMissing(cwd).invalid).toContain('不是合法 JSON');
          writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: 'x' } }));
          expect(ccPermissionMissing(cwd).invalid).toContain('不是数组');
          writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: HOPJIT_ALLOWED_TOOLS.map(t => `mcp__hopjit__${t}`) } }));
          expect(ccPermissionMissing(cwd).missing).toEqual([]);
          expect(readSkillFrontmatter(join(home, '.claude'), 'hop')).toBeNull();
          mkdirSync(join(home, '.claude', 'skills', 'hop'), { recursive: true });
          writeFileSync(join(home, '.claude', 'skills', 'hop', 'SKILL.md'), '---\nname: hop\ndescription: a: b, c\nuser-invocable: true\n---\n# x\n');
          expect(readSkillFrontmatter(join(home, '.claude'), 'hop')).toEqual({ name: 'hop', description: 'a: b, c', user_invocable: true });   // 含 ": " 的 description 不炸（真机实抓）
        }));

        it('子进程：`--json doctor` 在未装假 HOME 下 exit 1 且 stdout 纯 JSON（exit_code 与 summary.fail 同源）;人读形态同 exit;doctor 自身不触发首次运行提示', () => withHome(async (home) => {
          mkdirSync(join(home, '.claude'), { recursive: true });
          const env = { ...process.env, HOME: home, HOPJIT_ANTHROPIC_API_KEY: '' }; delete env.HOPJIT_SKIP_SKILL; delete env.CI; delete env.CLAUDE_CONFIG_DIR;
          const r = spawnSync(process.execPath, [CLI, '--json', 'doctor'], { env, encoding: 'utf-8', cwd: process.cwd() });
          expect(r.status).toBe(1);   // 变异：exitCode 不设 → 0 红
          const j = JSON.parse(r.stdout.trim()) as { action: string; exit_code: number; summary: { fail: number } };
          expect(j.action).toBe('doctor'); expect(j.exit_code).toBe(1); expect(j.summary.fail).toBeGreaterThan(0);
          expect(r.stderr).not.toContain('还没装进本机 agent');   // 变异：FIRST_RUN_EXEMPT 去 doctor → 红
          const h = spawnSync(process.execPath, [CLI, 'doctor'], { env, encoding: 'utf-8', cwd: process.cwd() });
          expect(h.status).toBe(1);
          expect(h.stdout).toMatch(/^hopjit doctor — v/); expect(h.stdout).toMatch(/\[fail\] {2}skill_installed/); expect(h.stdout).toMatch(/summary: \d+ ok \/ \d+ warn \/ \d+ fail \/ \d+ n\/a\n$/);
        }));
      });
    });

    // 元守卫：install-skill 缺省即注册+放行后,任何用例都不得往仓库根写 .mcp.json / .claude/settings.local.json
    // （review 首轮抓污染,修了 cwd 隔离;面三元变异证明隔离钩子自己无人守——这里守它）
    describe('install-skill 测试不污染仓库根（元守卫）', () => {
      const REPO_ROOT = resolve(__dirname, '..');
      const snap = (p: string) => existsSync(p) ? readFileSync(p, 'utf-8') : null;
      let before: Record<string, string | null> = {};
      beforeAll(() => { before = { mcp: snap(join(REPO_ROOT, '.mcp.json')), perm: snap(join(REPO_ROOT, '.claude', 'settings.local.json')) }; });
      afterAll(() => {
        expect(snap(join(REPO_ROOT, '.mcp.json'))).toBe(before.mcp);
        expect(snap(join(REPO_ROOT, '.claude', 'settings.local.json'))).toBe(before.perm);
      });
      it('快照已记（断言在 afterAll）', () => { expect(before).toBeDefined(); });
    });

    // 反例守卫:不带 --mcp 也恒装两壳（装配零选择——名字即模式,选择在用户敲哪个名）
    it('install-skill 不带 --mcp 同样装出 hopspec-mcp 壳（装配零选择）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-both-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      expect(existsSync(join(dir, 'hopspec', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(dir, 'hopspec-mcp', 'SKILL.md'))).toBe(true);
    });

    // @v: anc-cli-install-skill — opencode 载体 --mcp 注册（2026-09-15,见 todo/0089）
    // opencode 写用户级 opencode.json 的 mcp.hopjit（type:local + command 数组 + environment 留空靠 process.env 透传）
    it('install-skill --carrier opencode --mcp 写 opencode.json 的 mcp.hopjit（正例）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-mcp-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);   // 避免项目根 hopjit.yaml 挡自举（projPath=cwd/hopjit.yaml 不存在）
      const dir = mkdtempSync(join(tmpdir(), 'oc-skill-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const oc = JSON.parse(readFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'), 'utf-8'));
      expect(oc.mcp.hopjit.type).toBe('local');
      expect(oc.mcp.hopjit.command).toEqual(['hopjit-mcp']);
      expect(oc.mcp.hopjit.environment).toEqual({});
      // b 案（todo/0134,^anc-cli-opencode-tools-gate）：server 启用,独立模式专属五件在 tools 节关掉;复用驱动与批准面不关
      expect(oc.mcp.hopjit.enabled).toBe(true);
      expect(oc.tools).toEqual({ hopjit_start_run: false, hopjit_run_status: false, hopjit_resume_run: false, hopjit_list_runs: false, hopjit_stop_run: false });
      expect(oc.tools.hopjit_run_approved_command).toBeUndefined();
      expect(oc.tools.hopjit_run).toBeUndefined();
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_registered).toContain('opencode.jsonc');   // 写 opencode.jsonc(candidates[0])
      expect(out.mcp_config_note).toContain('opencode.jsonc');   // 无 model 不自举,note 指明 opencode.jsonc 不存在
      expect(out.mcp_note).toContain('enabled:true');
      expect(out.mcp_note).toContain('hopjit_start_run');   // note 点名关掉了哪些、走 standalone 怎么开
    });

    // @v: anc-cli-opencode-tools-gate —— tools 节幂等：用户已有的键不动,已是 false 的键不重写,重跑不翻 server 条目
    it('setup --carrier opencode（review 面三 G7,mut-17）：首装时 tools 节里独立模式专属键在场但为 true → 写成 false（判据是"值不为 false"不是"键在场"）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-tools-t-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-cwd3-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME; const origOcDir = process.env.OPENCODE_CONFIG_DIR; const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome; delete process.env.OPENCODE_CONFIG_DIR; delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      // 无 mcp.hopjit（首装）,但用户曾手工写过 hopjit_start_run: true
      writeFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'), '{\n  "tools": { "hopjit_start_run": true, "my_tool": true }\n}\n');
      const dir = mkdtempSync(join(tmpdir(), 'oc-skill3-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
        cap.restore();
        const oc = parseJsonc(readFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'), 'utf-8')) as any;
        expect(oc.mcp.hopjit.enabled).toBe(true);
        expect(oc.tools.hopjit_start_run).toBe(false);   // 变异：幂等判改成"键在场即跳过" → 仍是 true 红
        expect(oc.tools.my_tool).toBe(true);
      } finally {
        process.env.HOME = origHome; process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
    });
    it('setup --carrier opencode：tools 节已有用户键 → 只补缺席的五键,用户键原样;重跑幂等（反例:不覆盖）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-tools-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-cwd2-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME; const origOcDir = process.env.OPENCODE_CONFIG_DIR; const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome; delete process.env.OPENCODE_CONFIG_DIR; delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      // 用户已有 tools 节（含注释与一个自己的键,hopjit_stop_run 已是 false）,无 mcp.hopjit
      writeFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'), '{\n  // 用户注释\n  "tools": { "my_tool": true, "hopjit_stop_run": false }\n}\n');
      const dir = mkdtempSync(join(tmpdir(), 'oc-skill2-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
        cap.restore();
        const text1 = readFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'), 'utf-8');
        expect(text1).toContain('// 用户注释');   // jsoncModify 保留原格式与注释
        const oc1 = parseJsonc(text1) as any;
        expect(oc1.tools.my_tool).toBe(true);
        expect(oc1.tools.hopjit_start_run).toBe(false);
        expect(oc1.tools.hopjit_stop_run).toBe(false);
        expect(oc1.mcp.hopjit.enabled).toBe(true);
        // 用户把 start_run 改 true 走 standalone 后重跑 setup：mcp.hopjit 已存在整条跳过,tools 节也不动
        writeFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'), text1.replace('"hopjit_start_run": false', '"hopjit_start_run": true'));
        const cap2 = capture();
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
        cap2.restore();
        const oc2 = parseJsonc(readFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'), 'utf-8')) as any;
        expect(oc2.tools.hopjit_start_run).toBe(true);   // 用户的 standalone 开关没被重跑翻回
        expect(oc2.tools.my_tool).toBe(true);
      } finally {
        process.env.HOME = origHome; process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
    });

    // @v: anc-cli-install-skill — opencode 载体 LLM 自举（2026-09-15,见 todo/0089）
    // 读 opencode.json 的 model（"provider/model-id"）+ provider.<id>.options.baseURL + env[0],protocol 按 provider id 推断
    it('install-skill --carrier opencode --mcp 自举读 opencode.json 的 model/provider（正例）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-bootstrap-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-boot-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);   // 避免项目根 hopjit.yaml 挡自举
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      writeFileSync(join(fakeHome, '.config/opencode/opencode.json'), JSON.stringify({
        model: 'anthropic/claude-sonnet-4-6',
        provider: { anthropic: { options: { baseURL: 'https://api.anthropic.com' }, env: ['ANTHROPIC_API_KEY'] } },
      }), 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'oc-skill2-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_config_bootstrapped).toContain('config.yaml');
      expect(out.mcp_config_note).toContain('opencode 宿主配置');
      expect(out.mcp_config_note).toContain('claude-sonnet-4-6');
      const cfg = readFileSync(join(fakeHome, '.hopjit/config.yaml'), 'utf-8');
      expect(cfg).toContain('opencode_host');
      expect(cfg).toContain('protocol: anthropic');
      expect(cfg).toContain('claude-sonnet-4-6');
      expect(cfg).toContain('ANTHROPIC_API_KEY');
    });

    // @v: anc-cli-install-skill — opencode npm 字段忠实照抄（0020 批:npm=opencode 的 wire_api 等价物,
    // @ai-sdk/openai→responses / @ai-sdk/openai-compatible→chat / 缺席回退 id 推断保守 chat）
    it('正例:provider.npm=@ai-sdk/openai → 忠实学 openai-responses;npm 缺席回退 id 推断保守 chat', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-npm-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-npm-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      writeFileSync(join(fakeHome, '.config/opencode/opencode.json'), JSON.stringify({
        model: 'myproxy/gpt-5.4',
        provider: { myproxy: { npm: '@ai-sdk/openai', options: { baseURL: 'https://proxy.example/v1' }, env: ['MYPROXY_API_KEY'] } },
      }), 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'oc-skill-npm-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const cfg = readFileSync(join(fakeHome, '.hopjit/config.yaml'), 'utf-8');
      expect(cfg).toContain('protocol: openai-responses');   // npm=@ai-sdk/openai 忠实照抄
      // 同一形态但 npm 缺席 → 回退 id 推断（myproxy 不含 anthropic）保守 chat
      const fakeHome2 = mkdtempSync(join(tmpdir(), 'cli-oc-npm2-'));
      const cwd2 = mkdtempSync(join(tmpdir(), 'cli-oc-npm2-cwd-'));
      process.env.HOME = fakeHome2;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd2);
      mkdirSync(join(fakeHome2, '.config/opencode'), { recursive: true });
      writeFileSync(join(fakeHome2, '.config/opencode/opencode.json'), JSON.stringify({
        model: 'myproxy/gpt-5.4',
        provider: { myproxy: { options: { baseURL: 'https://proxy.example/v1' }, env: ['MYPROXY_API_KEY'] } },
      }), 'utf-8');
      const dir2 = mkdtempSync(join(tmpdir(), 'oc-skill-npm2-'));
      const cap2 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir2, '--force']);
      } finally {
        cap2.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const cfg2 = readFileSync(join(fakeHome2, '.hopjit/config.yaml'), 'utf-8');
      expect(cfg2).toContain('protocol: openai-chat');   // 无 npm 无证据不猜 responses
    });

    // @v: anc-cli-install-skill — opencode npm 阶梯另两分支（review 批变异5存活后钉死:anthropic 分支删除
    // 则 Anthropic provider 发 chat/completions 必 404;openai-compatible 归 chat 是官方文档明定）
    it('正例:npm=@ai-sdk/anthropic → anthropic;npm=@ai-sdk/openai-compatible → openai-chat（阶梯四分支补齐另两枚）', async () => {
      for (const [npmVal, expected] of [['@ai-sdk/anthropic', 'protocol: anthropic'], ['@ai-sdk/openai-compatible', 'protocol: openai-chat']] as const) {
        const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-npm3-'));
        const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-npm3-cwd-'));
        const oldCwd = process.cwd();
        const origHome = process.env.HOME;
        const origOcDir = process.env.OPENCODE_CONFIG_DIR;
        const origXdg = process.env.XDG_CONFIG_HOME;
        process.env.HOME = fakeHome;
        delete process.env.OPENCODE_CONFIG_DIR;
        delete process.env.XDG_CONFIG_HOME;
        process.chdir(cwd);
        mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
        writeFileSync(join(fakeHome, '.config/opencode/opencode.json'), JSON.stringify({
          model: 'prov/m1',
          provider: { prov: { npm: npmVal, options: { baseURL: 'https://x.example/v1' }, env: ['X_API_KEY'] } },
        }), 'utf-8');
        const dir = mkdtempSync(join(tmpdir(), 'oc-skill-npm3-'));
        const cap = capture();
        try {
          await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
        } finally {
          cap.restore();
          process.env.HOME = origHome;
          process.chdir(oldCwd);
          if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
          if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
        }
        const cfg = readFileSync(join(fakeHome, '.hopjit/config.yaml'), 'utf-8');
        expect(cfg).toContain(expected);
      }
    });

    // @v: anc-cli-install-skill — opencode 注册 best-effort（坏 JSON 不阻断 skill 安装,与 cc 分支 .claude.json 同纪律）
    it('install-skill --carrier opencode --mcp 遇坏 opencode.json 不阻断,note 提示未注册（反例:best-effort）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-bad-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-bad-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      writeFileSync(join(fakeHome, '.config/opencode/opencode.json'), '{ 坏 json', 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'oc-bad-skill-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.status).toBe('ok');   // skill 安装不受阻断
      expect(out.mcp_registered).toBeNull();
      expect(out.mcp_note).toContain('不是合法 JSON');
      expect(existsSync(join(dir, 'hopspec/SKILL.md'))).toBe(true);   // skill 照装
    });

    // @v: anc-cli-install-skill — opencode 注册已有 mcp.hopjit 跳过（注册面是用户资产,--force 不覆盖）
    it('install-skill --carrier opencode --mcp 已有 mcp.hopjit 跳过不覆盖（反例:注册面用户资产）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-skip-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-skip-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      writeFileSync(join(fakeHome, '.config/opencode/opencode.json'), JSON.stringify({
        mcp: { hopjit: { type: 'local', command: ['my-custom'], environment: {} } },
      }), 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'oc-skip-skill-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const oc = JSON.parse(readFileSync(join(fakeHome, '.config/opencode/opencode.json'), 'utf-8'));
      expect(oc.mcp.hopjit.command).toEqual(['my-custom']);   // 未被覆盖
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_registered).toBeNull();
      expect(out.mcp_note).toContain('未改动');
    });

    // @v: anc-cli-opencode-tools-gate —— 已有条目三分（2026-10-11 作者抓"普通用户会手工翻么？这是 hopjit 自己的 mcp service"）：
    // hopjit 自己写的 enabled:false 旧形态由 setup 升级;command 不是 hopjit-mcp 的用户自配条目即使 enabled:false 也不动。
    // 变异：ownStale 判定改坏（恒 false,等于回到"已有即跳过"）→ 正例红;判定去掉 command 条件 → 反例红。
    async function runOpencodeSetupWith(existing: string): Promise<{ text: string; out: any }> {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-stale-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-stale-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME; const origOcDir = process.env.OPENCODE_CONFIG_DIR; const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome; delete process.env.OPENCODE_CONFIG_DIR; delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      const cfg = join(fakeHome, '.config/opencode/opencode.json');
      writeFileSync(cfg, existing, 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'oc-stale-skill-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome; process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      return { text: readFileSync(cfg, 'utf-8'), out: JSON.parse(cap.get().trim().split('\n').pop()!) };
    }
    it('正例：opencode 已有 mcp.hopjit 是 hopjit 自己写的旧形态（command hopjit-mcp + enabled:false）→ setup 升级为 enabled:true 并补 tools 节五键,其余键与用户键不动', async () => {
      const { text, out } = await runOpencodeSetupWith(JSON.stringify({
        model: 'x/y',
        mcp: { hopjit: { type: 'local', command: ['hopjit-mcp'], enabled: false, environment: { FOO: 'bar' } } },
        tools: { my_tool: true },
      }, null, 2));
      const oc = parseJsonc(text) as any;
      expect(oc.mcp.hopjit.enabled).toBe(true);   // 变异：ownStale 恒 false → 仍 false 红
      expect(oc.mcp.hopjit.command).toEqual(['hopjit-mcp']);
      expect(oc.mcp.hopjit.environment).toEqual({ FOO: 'bar' });   // 只翻 enabled 一键,用户改过的 environment 不动
      expect(oc.tools).toEqual({ my_tool: true, hopjit_start_run: false, hopjit_run_status: false, hopjit_resume_run: false, hopjit_list_runs: false, hopjit_stop_run: false });
      expect(oc.model).toBe('x/y');
      expect(out.mcp_registered).toContain('opencode.json');
      expect(out.mcp_note).toContain('旧形态升级');
    });
    it('反例：opencode 已有 mcp.hopjit 是用户自配（command 不是 hopjit-mcp）且 enabled:false → setup 不动它,tools 节也不写', async () => {
      const original = JSON.stringify({ mcp: { hopjit: { type: 'local', command: ['my-wrapper'], enabled: false } } }, null, 2);
      const { text, out } = await runOpencodeSetupWith(original);
      expect(text).toBe(original);   // 变异：ownStale 去掉 command 条件 → 文件被改写红
      expect(out.mcp_registered).toBeNull();
      expect(out.mcp_note).toContain('未改动');
    });

    // @v: anc-cli-install-skill — opencode 自举缺 model 不自举（学习源缺失→不写文件,note 明示）
    it('install-skill --carrier opencode --mcp 遇 opencode.json 无 model 不自举（反例:学习源缺失）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-nomodel-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-nomodel-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      writeFileSync(join(fakeHome, '.config/opencode/opencode.json'), JSON.stringify({
        provider: { anthropic: { options: { baseURL: 'https://api.anthropic.com' }, env: ['ANTHROPIC_API_KEY'] } },
      }), 'utf-8');   // 有 provider 无 model
      const dir = mkdtempSync(join(tmpdir(), 'oc-nomodel-skill-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_config_bootstrapped).toBeNull();   // 不自举
      expect(out.mcp_config_note).toContain('缺 model');
      expect(existsSync(join(fakeHome, '.hopjit/config.yaml'))).toBe(false);   // 未写配置
    });

    // @v: anc-cli-pack — opencode 载体 pack（dir 缺省 .opencode/skills + installHint 含 opencode,走 cc 包装模板）
    it('pack --carrier opencode 落 .opencode/skills + installHint 含 opencode（正例）', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'cli-pack-oc-'));
      const oldCwd = process.cwd();
      process.chdir(cwd);
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(REPO, 'examples/doc-review.md'), '--carrier', 'opencode', '--force']);
      } finally {
        cap.restore();
        process.chdir(oldCwd);
      }
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.status).toBe('ok');
      expect(existsSync(join(cwd, '.opencode', 'skills', 'doc-review', 'SKILL.md'))).toBe(true);
      const skillMd = readFileSync(join(cwd, '.opencode', 'skills', 'doc-review', 'SKILL.md'), 'utf-8');
      expect(skillMd).toContain('hopjit setup --carrier opencode');   // installHint 含 opencode
    });

    // @v: anc-cli-install-skill — opencode .jsonc 保留注释(jsonc-parser modify/applyEdits,opencode 同款)
    it('install-skill --carrier opencode --mcp 写 .jsonc 保留用户注释（正例:jsonc-parser）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-jsonc-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-jsonc-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      writeFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'),
        '{\n  // 用户注释\n  "provider": { "theta": { "options": { "baseURL": "https://x" } } }\n}\n', 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'oc-jsonc-skill-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const text = readFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'), 'utf-8');
      expect(text).toContain('// 用户注释');   // 注释保留(jsonc-parser 不丢)
      expect(text).toContain('hopjit-mcp');   // mcp.hopjit 写入
      expect(text).toContain('https://x');   // 用户配置保留
    });

    // @v: anc-cli-install-skill — opencode .jsonc 已有 mcp.hopjit 跳过(candidates 检测 .jsonc,消除静默冲突)
    it('install-skill --carrier opencode --mcp 遇 .jsonc 已有 mcp.hopjit 跳过（正例:candidates 检测 .jsonc）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-jsonc-skip-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-jsonc-skip-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      writeFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'),
        '{\n  // 我的 hopjit\n  "mcp": { "hopjit": { "type": "local", "command": ["my-custom"], "environment": {} } }\n}\n', 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'oc-jsonc-skip-skill-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const text = readFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'), 'utf-8');
      expect(text).toContain('my-custom');   // 未被覆盖
      expect(text).not.toContain('hopjit-mcp');   // 没写新的(candidates 检测到 .jsonc 的 mcp.hopjit)
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_registered).toBeNull();
      expect(out.mcp_note).toContain('未改动');
    });

    // @v: anc-cli-install-skill — opencode 自举读 .jsonc 含注释(parseJsonc 含注释)
    it('install-skill --carrier opencode --mcp 自举读 .jsonc 含注释的 model（正例:parseJsonc）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-jsonc-boot-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-jsonc-boot-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      writeFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'),
        '{\n  // 我的 LLM\n  "model": "anthropic/claude-sonnet-4-6",\n  "provider": { "anthropic": { "options": { "baseURL": "https://api.anthropic.com" }, "env": ["ANTHROPIC_API_KEY"] } }\n}\n', 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'oc-jsonc-boot-skill-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_config_bootstrapped).toContain('config.yaml');   // 自举成功(parseJsonc 读含注释 .jsonc)
      expect(out.mcp_config_note).toContain('opencode 宿主配置');
      expect(out.mcp_config_note).toContain('claude-sonnet-4-6');
      const cfg = readFileSync(join(fakeHome, '.hopjit/config.yaml'), 'utf-8');
      expect(cfg).toContain('opencode_host');
      expect(cfg).toContain('claude-sonnet-4-6');
    });

    // @v: anc-cli-install-skill — opencode 自举 deep-merge(.jsonc 无 model fallback opencode.json,与 opencode 加载一致)
    it('install-skill --carrier opencode --mcp 自举 deep-merge:.jsonc 无 model fallback opencode.json（正例:deep-merge）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-merge-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-merge-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      // .jsonc 有 provider.env 无 model;opencode.json 有 model + provider.baseURL——验证 deep-merge 合并
      writeFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'),
        '{\n  // 我的 provider\n  "provider": { "anthropic": { "env": ["ANTHROPIC_API_KEY"] } }\n}\n', 'utf-8');
      writeFileSync(join(fakeHome, '.config/opencode/opencode.json'),
        '{\n  "model": "anthropic/claude-sonnet-4-6",\n  "provider": { "anthropic": { "options": { "baseURL": "https://api.anthropic.com" } } }\n}\n', 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'oc-merge-skill-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_config_bootstrapped).toContain('config.yaml');   // deep-merge 后有 model+baseURL,自举成功
      expect(out.mcp_config_note).toContain('claude-sonnet-4-6');   // model 来自 opencode.json(deep-merge fallback)
      const cfg = readFileSync(join(fakeHome, '.hopjit/config.yaml'), 'utf-8');
      expect(cfg).toContain('claude-sonnet-4-6');   // model 来自 opencode.json
      expect(cfg).toContain('ANTHROPIC_API_KEY');   // env 来自 .jsonc(deep-merge provider 合并)
    });

    // @v: anc-cli-install-skill — opencode 检测 candidates 含 config.json(config.json 有 mcp.hopjit 跳过)
    it('install-skill --carrier opencode --mcp 遇 config.json 已有 mcp.hopjit 跳过（正例:candidates 含 config.json）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-cfgjson-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-cfgjson-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      writeFileSync(join(fakeHome, '.config/opencode/config.json'),
        '{ "mcp": { "hopjit": { "type": "local", "command": ["my-custom"], "environment": {} } } }\n', 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'oc-cfgjson-skill-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_registered).toBeNull();   // config.json 有 mcp.hopjit,candidates 检测到,跳过
      expect(out.mcp_note).toContain('未改动');
    });

    // @v: anc-cli-install-skill — opencode 自举 deep-merge options 内部(递归合并非浅 merge;.jsonc 有 baseURL,opencode.json 有 apiKey/env → 两者都保留)
    it('install-skill --carrier opencode --mcp 自举 deep-merge options 内部（正例:递归合并非浅 merge）', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'cli-oc-deepopt-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-oc-deepopt-cwd-'));
      const oldCwd = process.cwd();
      const origHome = process.env.HOME;
      const origOcDir = process.env.OPENCODE_CONFIG_DIR;
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = fakeHome;
      delete process.env.OPENCODE_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.chdir(cwd);
      mkdirSync(join(fakeHome, '.config/opencode'), { recursive: true });
      // .jsonc 有 model + options.baseURL;opencode.json 有 options.apiKey + env——浅 merge 会丢 baseURL(不自举),递归 deep-merge 保留 baseURL(自举)
      writeFileSync(join(fakeHome, '.config/opencode/opencode.jsonc'),
        '{ "model": "anthropic/claude", "provider": { "anthropic": { "options": { "baseURL": "https://api.anthropic.com" } } } }\n', 'utf-8');
      writeFileSync(join(fakeHome, '.config/opencode/opencode.json'),
        '{ "provider": { "anthropic": { "options": { "apiKey": "sk-x" }, "env": ["ANTHROPIC_API_KEY"] } } }\n', 'utf-8');
      const dir = mkdtempSync(join(tmpdir(), 'oc-deepopt-skill-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'opencode', '--mcp', '--dir', dir, '--force']);
      } finally {
        cap.restore();
        process.env.HOME = origHome;
        process.chdir(oldCwd);
        if (origOcDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = origOcDir;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
      }
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_config_bootstrapped).toContain('config.yaml');   // 递归 deep-merge 保留 baseURL,自举成功(浅 merge 会丢 baseURL 不自举)
      const cfg = readFileSync(join(fakeHome, '.hopjit/config.yaml'), 'utf-8');
      expect(cfg).toContain('https://api.anthropic.com');   // baseURL 来自 .jsonc(options 内部递归合并保留)
      expect(cfg).toContain('ANTHROPIC_API_KEY');   // env 来自 opencode.json
    });

    it('install-skill --mcp 已有 hopjit 条目跳过不覆盖（反例:注册配置是用户资产）', () => withMcpEnv(async ({ cwd }) => {
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-mcp2-'));
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { hopjit: { command: 'my-custom' } } }), 'utf-8');
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      const mcp = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8'));
      expect(mcp.mcpServers.hopjit.command).toBe('my-custom');   // 未被覆盖
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_registered).toBeNull();
      expect(out.mcp_note).toContain('未改动');
    }));

    // @v: anc-cli-install-skill-handshake
    it('握手按项目 .mcp.json 里的 command 判:command 指向不存在的绝对路径 → mcp_handshake.ok=false 且 reason 带该路径;setup 不因此失败,skill 照装', () => withMcpEnv(async ({ cwd }) => {
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-hs-'));
      const ghost = join(cwd, 'no-such-bin', 'hopjit-mcp-ghost');
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { hopjit: { command: ghost } } }), 'utf-8');
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      const out = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(out.mcp_handshake.ok).toBe(false);
      expect(out.mcp_handshake.reason).toContain(ghost);
      expect(out.mcp_handshake.fix).toBeTruthy();
      expect(existsSync(join(dir, 'hop', 'SKILL.md'))).toBe(true);
      expect(out.installed.length).toBeGreaterThan(0);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8')).mcpServers.hopjit.command).toBe('hopjit-mcp');
      // 他项目的 local 注册不误报（scope 感知按本 cwd 精确匹配）
      rmSync(join(cwd, '.mcp.json'));
      writeFileSync(join(home, '.claude.json'), JSON.stringify({
        projects: { '/elsewhere/project': { mcpServers: { hopjit: { command: 'x' } } } },
      }), 'utf-8');
      cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']);
      } finally { cap.restore(); }
      expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8')).mcpServers.hopjit.command).toBe('hopjit-mcp');
    }));

    // @v: anc-cli-install-skill — CC 系载体注册按族决策（2026-10-11 todo/0158 第一块:cc 与 cfuse-cc 共用项目级 .mcp.json
    // 却各查自己的 .claude.json,cc 在 local 级已注册时 cfuse-cc 照写 .mcp.json 即给 cc 制造同名双 scope;doctor 真机报 cfuse-cc 没注册实撞）
    describe('CC 系载体注册按族决策（cc 与 cfuse-cc 同机）', () => {
      // 假 HOME 下同时造 cc（~/.claude）与 cfuse-cc（~/.codefuse/engine/cc）两个 home,setup 不带 --carrier 自动探测两者
      const twoCc = (home: string) => {
        mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
        mkdirSync(join(home, '.codefuse', 'engine', 'cc', 'skills'), { recursive: true });
        return { ccJson: join(home, '.claude.json'), cfJson: join(home, '.codefuse', 'engine', 'cc', '.claude.json') };
      };
      const localReg = (cwd: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ...extra, projects: { [cwd]: { mcpServers: { hopjit: { command: 'hopjit-mcp' } } } } }, null, 2) + '\n';
      const runSetupJson = async (): Promise<any> => {
        const cap = capture();
        try { await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--force']); } finally { cap.restore(); }
        return JSON.parse(cap.get().trim().split('\n').pop()!);
      };
      const resultOf = (out: any, carrier: string) => (out.results as any[]).find(r => r.carrier === carrier);

      it('正例 1:cc local 级已注册、cfuse-cc 未注册 → 不写 .mcp.json;cfuse-cc 自己的 .claude.json 多出 local 级条目;cc 的 .claude.json 字节不变;两载体 note / mcp_registered 各指明去向', () => withMcpEnv(async ({ home, cwd }) => {
        const { ccJson, cfJson } = twoCc(home);
        writeFileSync(ccJson, localReg(cwd, { numStartups: 3 }), 'utf-8');
        writeFileSync(cfJson, JSON.stringify({ numStartups: 1, projects: { [cwd]: { allowedTools: [] } } }, null, 2) + '\n', 'utf-8');
        const ccBefore = readFileSync(ccJson, 'utf-8');
        const out = await runSetupJson();
        expect(out.carriers).toEqual(expect.arrayContaining(['cc', 'cfuse-cc']));
        expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);                  // 决策分支 (b):族内已有注册 → 不制造第二 scope
        expect(readFileSync(ccJson, 'utf-8')).toBe(ccBefore);                       // 已注册的兄弟一字不动
        const cf = JSON.parse(readFileSync(cfJson, 'utf-8'));
        expect(cf.projects[cwd].mcpServers.hopjit).toEqual({ command: 'hopjit-mcp' });   // 写进 cfuse-cc 自己的 local 级
        expect(cf.projects[cwd].allowedTools).toEqual([]);                           // 只加一键,其余键不动
        expect(cf.numStartups).toBe(1);
        expect(resultOf(out, 'cc').mcp_registered).toBeNull();
        expect(resultOf(out, 'cc').mcp_note).toContain('local 级');
        expect(resultOf(out, 'cfuse-cc').mcp_registered).toBe(cfJson);
      }));

      it('正例 2:两个都没注册 → 写一次 .mcp.json 供族内共用;两个 .claude.json 字节不变', () => withMcpEnv(async ({ home, cwd }) => {
        const { ccJson, cfJson } = twoCc(home);
        writeFileSync(ccJson, JSON.stringify({ projects: {} }, null, 2) + '\n', 'utf-8');
        writeFileSync(cfJson, JSON.stringify({ projects: {} }, null, 2) + '\n', 'utf-8');
        const b1 = readFileSync(ccJson, 'utf-8'), b2 = readFileSync(cfJson, 'utf-8');
        const out = await runSetupJson();
        expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8')).mcpServers.hopjit.command).toBe('hopjit-mcp');   // 决策分支 (a)
        expect(readFileSync(ccJson, 'utf-8')).toBe(b1);
        expect(readFileSync(cfJson, 'utf-8')).toBe(b2);
        const regs = [resultOf(out, 'cc'), resultOf(out, 'cfuse-cc')];
        expect(regs.filter(r => r.mcp_registered === join(cwd, '.mcp.json'))).toHaveLength(1);   // 只写一次
        expect(regs.some(r => typeof r.mcp_note === 'string' && r.mcp_note.includes('已有 mcpServers.hopjit 条目'))).toBe(true);   // 第二轮按已有跳过
      }));

      it('反例 1:cfuse-cc 的 .claude.json 是坏 JSON → INSTALL_SKILL_ERROR 响亮退出,.mcp.json 不写,cc 的文件不动', () => withMcpEnv(async ({ home, cwd }) => {
        const { ccJson, cfJson } = twoCc(home);
        writeFileSync(ccJson, localReg(cwd), 'utf-8');
        writeFileSync(cfJson, '{ 坏 json', 'utf-8');
        const ccBefore = readFileSync(ccJson, 'utf-8');
        const origExit = process.exit; const origStderr = process.stderr.write; let stderr = '';
        process.exit = ((code: number) => { throw new Error(`EXIT:${code}`); }) as any;
        process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as any;
        const cap = capture();
        try {
          await expect(program.parseAsync(['node', 'hopjit', '--json', 'setup', '--force'])).rejects.toThrow('EXIT:1');
        } finally { cap.restore(); process.exit = origExit; process.stderr.write = origStderr; }
        expect(stderr + cap.get()).toContain('INSTALL_SKILL_ERROR');   // 决策分支:坏 JSON 响亮失败,不静默覆盖
        expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
        expect(readFileSync(ccJson, 'utf-8')).toBe(ccBefore);
        expect(readFileSync(cfJson, 'utf-8')).toBe('{ 坏 json');
      }));

      it('反例 2:两个都已在各自 local 级注册 → 什么都不写,两条 note 分别指明 scope', () => withMcpEnv(async ({ home, cwd }) => {
        const { ccJson, cfJson } = twoCc(home);
        writeFileSync(ccJson, localReg(cwd), 'utf-8');
        writeFileSync(cfJson, localReg(cwd), 'utf-8');
        const b1 = readFileSync(ccJson, 'utf-8'), b2 = readFileSync(cfJson, 'utf-8');
        const out = await runSetupJson();
        expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
        expect(readFileSync(ccJson, 'utf-8')).toBe(b1);
        expect(readFileSync(cfJson, 'utf-8')).toBe(b2);
        expect(resultOf(out, 'cc').mcp_note).toContain('local 级');
        expect(resultOf(out, 'cfuse-cc').mcp_note).toContain('local 级');
      }));

      it('正例 3:正例 1 之后跑 doctor,cc 与 cfuse-cc 的 mcp_registered 都 ok（查法=写法:doctor 认 cfuse-cc 自己 .claude.json 的 local 级条目）', () => withMcpEnv(async ({ home, cwd }) => {
        const { ccJson, cfJson } = twoCc(home);
        writeFileSync(ccJson, localReg(cwd), 'utf-8');
        writeFileSync(cfJson, JSON.stringify({ projects: {} }, null, 2) + '\n', 'utf-8');
        await runSetupJson();
        const r = runDoctor(adminCtx(process.env, cwd), { handshake: () => ({ ok: true, tools: ['run'], standalone_available: false }) });
        const regItems = r.items.filter(i => i.id === 'mcp_registered' && (i.carrier === 'cc' || i.carrier === 'cfuse-cc'));
        expect(regItems.map(i => [i.carrier, i.status])).toEqual(expect.arrayContaining([['cc', 'ok'], ['cfuse-cc', 'ok']]));
        expect(regItems.find(i => i.carrier === 'cfuse-cc')!.detail).toContain('local 级');
      }));
    });

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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--carrier', 'codex', '--dir', dir, '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--carrier', 'codex', '--dir', dir, '--force']);
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
        await expect(program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']))
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
          await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']);
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

      it('正例:Codex 载体学 config.toml 的 model_provider 链,protocol 忠实照抄 wire_api=responses（0020 批撤强制降级）', () => withIsolatedEnv(async () => {
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
          await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--carrier', 'codex', '--dir', dir, '--force']);
        } finally { cap.restore(); }
        const cfg = readFileSync(join(process.env.HOME!, '.hopjit', 'config.yaml'), 'utf-8');
        expect(cfg).toContain('service_id: codex_host');
        expect(cfg).toContain('protocol: openai-responses');        // 忠实照抄 wire_api="responses"（0020 批）
        expect(cfg).toContain('base_url: https://prov.example/v1'); // 命中 myprov 节非 other 节
        expect(cfg).toContain('model: vendor/model-z');
        expect(cfg).toContain('api_key_env: MYPROV_API_KEY');
      }));

      it('反例:Codex wire_api 缺席 → protocol 缺省学 openai-chat（负半边——缺省被改恒 responses 则 chat-only 端点启动即撞,review 批变异4存活后钉死）', () => withIsolatedEnv(async () => {
        const codexDir = join(process.env.HOME!, '.codex');
        mkdirSync(codexDir, { recursive: true });
        writeFileSync(join(codexDir, 'config.toml'), [
          'model = "vendor/model-z"', 'model_provider = "myprov"', '',
          '[model_providers.myprov]', 'base_url = "https://prov.example/v1"',
          'env_key = "MYPROV_API_KEY"', '',
        ].join('\n'), 'utf-8');   // 无 wire_api 行
        const dir = mkdtempSync(join(tmpdir(), 'hopboot-nowire-'));
        const cap = capture();
        try {
          await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--carrier', 'codex', '--dir', dir, '--force']);
        } finally { cap.restore(); }
        const cfg = readFileSync(join(process.env.HOME!, '.hopjit', 'config.yaml'), 'utf-8');
        expect(cfg).toContain('protocol: openai-chat');   // 缺省保守 chat,不猜 responses
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
          await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']);
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
          await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']);
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
          await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']);
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
          await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']);
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
          await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--mcp', '--dir', dir, '--force']);
        } finally { cap.restore(); }
        expect(existsSync(join(process.env.HOME!, '.hopjit', 'config.yaml'))).toBe(false);
        const out = JSON.parse(cap.get().trim().split('\n').pop()!);
        expect(out.mcp_config_bootstrapped).toBeNull();
        expect(out.mcp_config_note).toContain('未自举');
      }));
    });

    it('install-skill 缺省 hopspec 壳=纯复用协议（回归:四改后仍无 standalone 块混入）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hopskill-reuse-'));
      await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', dir, '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk'), '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk'), '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk'), '--force']);
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
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap1.restore(); }
      const refsDir = join(dir, 'sk/hopspec/references');
      rmSync(join(refsDir, '.hopjit-manifest.json'));                    // 模拟旧版装机（无 manifest）
      const staleFile = join(refsDir, 'parallel-worker.md');
      writeFileSync(staleFile, '# 残留\n');
      const cap2 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap2.restore(); }
      expect(existsSync(staleFile)).toBe(true);                          // 空清单=零删除
      expect(existsSync(join(refsDir, '.hopjit-manifest.json'))).toBe(true);   // 新 manifest 已落——下次清理恢复管辖
    });

    // todo/0146 probe 3 实撞：CC 沙箱禁写 ~/.claude/skills,已装好时 setup 无条件重写 manifest 撞 EPERM
    it('边界：manifest 内容不变时不写盘（目录只读也不撞 EPERM）;内容变了照常重写', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-mfsame-'));
      const cap1 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk')]);
      } finally { cap1.restore(); }
      const refsDir = join(dir, 'sk/hopspec/references');
      const mfPath = join(refsDir, '.hopjit-manifest.json');
      const before = readFileSync(mfPath, 'utf-8');
      chmodSync(mfPath, 0o444);                                          // 模拟沙箱：manifest 不可写
      const cap2 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk')]);
      } finally { cap2.restore(); chmodSync(mfPath, 0o644); }
      const r2 = JSON.parse(cap2.get().trim().split('\n').pop()!);
      expect(r2.status).toBe('ok');                                      // 同内容=跳过写入,不因只读失败
      expect(readFileSync(mfPath, 'utf-8')).toBe(before);
      writeFileSync(mfPath, JSON.stringify({ version: '0.0.0', files: [] }));   // 内容过期
      const cap3 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk')]);
      } finally { cap3.restore(); }
      expect(readFileSync(mfPath, 'utf-8')).toBe(before);                // 内容变了照常重写回现行清单
    });

    it('反例：非 force 不清理（与"存在即跳过"对称——不覆盖也不删除）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-noprune-'));
      const cap1 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap1.restore(); }
      const staleFile = join(dir, 'sk/hopspec/references/parallel-worker.md');
      writeFileSync(staleFile, '# 残留\n');
      const cap2 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk')]);
      } finally { cap2.restore(); }
      expect(existsSync(staleFile)).toBe(true);   // 非 force 原样保留
    });

    it('反例：受管清理不碰 references/ 外的文件（SKILL.md 顶层/用户其它 skill 目录）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-scope-'));
      const cap1 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap1.restore(); }
      const userFile = join(dir, 'sk/hopspec/MY-NOTES.md');       // 用户放在 skill 顶层的文件
      const userSkill = join(dir, 'sk/my-own-skill/SKILL.md');    // 用户自己的 skill
      writeFileSync(userFile, 'x');
      mkdirSync(dirname(userSkill), { recursive: true });
      writeFileSync(userSkill, 'y');
      const cap2 = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap2.restore(); }
      expect(existsSync(userFile)).toBe(true);
      expect(existsSync(userSkill)).toBe(true);
    });

    it('install-skill in-process：cc 布局 + 版本戳', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-ip-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk'), '--force']);
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
      // 中文关键词 `标识:` 同样改写,关键词保留（2026-10-06 前只认 `Id:`,fact-check-demo 漏改）
      cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'pack', join(REPO, 'examples/fact-check-demo.md'), '--name', 'demo-fact-check', '--dir', join(dir, 'c'), '--force']);
      } finally { cap.restore(); }
      const zh = readFileSync(join(dir, 'c/demo-fact-check/spec.md'), 'utf-8');
      expect(zh).toMatch(/^标识: demo-fact-check$/m);
      expect(zh).not.toMatch(/^标识: fact-check-demo$/m);
    });

    // @v: anc-cli-install-skill-demo-ants —— setup 缺省装三个演示 HopAnt（与载体无关,不进载体 skill 目录）;--demo 隐藏无作用
    it('setup in-process：缺省装演示 HopAnt 到 ~/.hopjit/ants,载体 skill 目录与项目 .agents/skills 都没有 demo-*（正例+反例）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-ip-demo-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'codex', '--dir', join(dir, 'sk'), '--force']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.demo_ants).toEqual(['demo-coffee-week', 'demo-fact-check', 'demo-rename']);
      const ants = join(process.env.HOME!, '.hopjit', 'ants');
      expect(existsSync(join(ants, 'demo-coffee-week', 'demo-coffee-week.md'))).toBe(true);
      expect(existsSync(join(ants, 'demo-coffee-week', 'coffee-sales.json'))).toBe(true);
      expect(existsSync(join(ants, 'demo-coffee-week', 'inner_store'))).toBe(true);
      expect(existsSync(join(ants, 'demo-fact-check', 'fact-check-sample.md'))).toBe(true);
      expect(readFileSync(join(ants, 'index.md'), 'utf-8')).toMatch(/^- demo-rename — /m);
      // 反例：不再 pack 成载体 skill（skill 目录与 Codex 旧项目级装载点都没有 demo-*）
      expect(readdirSync(join(dir, 'sk')).some(n => n.startsWith('demo-'))).toBe(false);
      expect(existsSync(join(process.cwd(), '.agents', 'skills'))).toBe(false);
    });

    it('setup in-process：--demo 仍被接受且结果与不带相同（隐藏的兼容参数）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-ip-demo-alias-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk'), '--demo', '--force']);
      } finally { cap.restore(); }
      const r = JSON.parse(cap.get().trim().split('\n').pop()!);
      expect(r.status).toBe('ok');
      expect(r.demo_ants).toEqual(['demo-coffee-week', 'demo-fact-check', 'demo-rename']);
      expect(readdirSync(join(dir, 'sk')).some(n => n.startsWith('demo-'))).toBe(false);
    });

    it('install-skill in-process：幂等跳过（note 提示 force）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-ip-idem-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk')]);
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--dir', join(dir, 'sk')]);
      } finally { cap.restore(); }
      const outs = cap.get().trim().split('\n').map(l => JSON.parse(l));
      expect(outs[1].installed).toEqual([]);
      expect(outs[1].note).toContain('--force');
    });

    it('install-skill in-process：codex 布局', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-is-ip-cx-'));
      const cap = capture();
      try {
        await program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'codex', '--dir', join(dir, 'sk'), '--force']);
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
        await expect(program.parseAsync(['node', 'hopjit', '--json', 'setup', '--carrier', 'unknown']))
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

// @v: anc-exec-parallel-foreach-join-collect
// （for-each 屏障锚的 @v 2026-10-11 迁至 engine.test.ts 的 drain_wait 屏障用例——这里只是说明注释,无测试体;语义审计 0156 A1）
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

    // 交付段（四段式第四段,todo/0129 B5——设计 2026-08-15 写定,模板从不读 header.outputs,语义审计抓）
    // @v: anc-cli-pack-shell
    it('交付段：两载体壳都含「## 交付」段,逐项列 spec Outputs 名+类型+注释（与 Outputs 严格对齐）;无 Outputs 的 spec 写兜底句', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-pack-deliver-'));
      runCliJson(`pack "${join(REPO, 'examples/doc-review.md')}"`, dir);
      const cc = readFileSync(join(dir, '.claude/skills/doc-review/SKILL.md'), 'utf-8');
      expect(cc).toContain('## 交付');
      const outNames = ['synthesis', 'decision_output'];   // examples/doc-review.md 的 Outputs 两项（头部用 `Outputs:` 短形态）
      for (const n of outNames) expect(cc, `交付段漏 ${n}`).toMatch(new RegExp('## 交付[\\s\\S]*`' + n + '`（text）'));
      expect(cc).toContain('汇聚报告');   // 注释随行
      expect(cc.indexOf('## 交付')).toBeGreaterThan(cc.indexOf('## 执行'));   // 段序：触发/参数/执行/交付
      const dir2 = mkdtempSync(join(tmpdir(), 'cli-pack-deliver-cx-'));
      runCliJson(`pack "${join(REPO, 'examples/doc-review.md')}" --carrier codex`, dir2);
      const cx = readFileSync(join(dir2, '.agents/skills/doc-review/SKILL.md'), 'utf-8');
      expect(cx).toContain('## 交付');
      for (const n of outNames) expect(cx).toContain('`' + n + '`');
      // 反例：无 Outputs 的 spec → 兜底句而非空段
      const noOut = join(dir, 'noout.md');
      writeFileSync(noOut, '# NoOut\nId: noout\n## Goal\ng\n## Steps\n1. [act free] a\n  + → x: text  # x\n');
      const dir3 = mkdtempSync(join(tmpdir(), 'cli-pack-deliver-no-'));
      runCliJson(`pack "${noOut}"`, dir3);
      expect(readFileSync(join(dir3, '.claude/skills/noout/SKILL.md'), 'utf-8')).toContain('本 spec 未声明交付物');
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
      // 壳里不提知识文档（^anc-cli-pack-shell 内务零披露,todo/0151 作者定删——变异：knowledgeNote 恢复本断言红）
      const shell = readFileSync(join(dir, '.claude/skills/anchor-audit/SKILL.md'), 'utf-8');
      expect(shell).not.toContain('判据知识文档');
      expect(shell).not.toContain('anchor-audit-knowledge.md');
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

  // @v: anc-cli-install-skill-demo-ants —— 演示件改 HopAnt（2026-10-06 作者定"demo 可以缺省就装"）：子进程真实入口
  // @v: anc-cli-ant, anc-hopant-pack, anc-hopant-share
  describe('ant pack / ant share 子命令（todo/0142 子卡 C/E）', () => {
    const runAnt = (args: string[], cwd: string, home: string) => spawnSync(process.execPath, [CLI, '--json', 'ant', ...args], {
      cwd, encoding: 'utf-8', timeout: 10000, env: { ...process.env, HOME: home, HOPJIT_ANTHROPIC_API_KEY: '' },
    });
    const last = (out: string) => JSON.parse(out.trim());
    it('pack：缺省 --out ants、Id 行取 id、--assets 随包;响应 action=pack 带 pack.reconciled 与 next_step;再 install 产物成功', () => {
      const home = mkdtempSync(join(tmpdir(), 'cli-ap-home-')); const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cli-ap-cwd-')));
      writeFileSync(join(cwd, 'spec.md'), `# Spec: s\nId: my-first-ant\nGoal: g\n## Tools\n- web_search(query) -> r % yaml  # x\n  - query % text  # q\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  - 工具: web_search\n  + → out % text\n`);
      writeFileSync(join(cwd, 'sample.md'), '# 样例\n');
      const r = runAnt(['pack', 'spec.md', '--assets', 'sample.md'], cwd, home);
      expect(r.status, r.stderr).toBe(0);
      const j = last(r.stdout);
      expect(j.action).toBe('pack'); expect(j.id).toBe('my-first-ant');
      expect(j.pack.dir).toBe(join(cwd, 'ants', 'my-first-ant'));
      expect(j.pack.reconciled).toEqual({ tools_added: [], tools_removed: [], commands_added: [], commands_removed: [], commands_undetermined: [] });
      expect(j.pack.assets_copied).toEqual(['sample.md']);
      expect(j.next_step).toContain('hopjit ant install');
      expect(existsSync(join(cwd, 'ants', 'my-first-ant', 'my-first-ant.md'))).toBe(true);
      const inst = runAnt(['install', join(cwd, 'ants', 'my-first-ant')], cwd, home);
      expect(inst.status, inst.stderr).toBe(0);
      expect(last(inst.stdout).result.installed).toEqual(['my-first-ant']);
    });
    it('pack 反例：spec 不存在 → stderr PACK_ERROR 退出 1;doc-ref 缺 → HOPANT_DOC_MISSING 退出 1 且不建目录', () => {
      const home = mkdtempSync(join(tmpdir(), 'cli-ap-home2-')); const cwd = mkdtempSync(join(tmpdir(), 'cli-ap-cwd2-'));
      const r = runAnt(['pack', 'nope.md'], cwd, home);
      expect(r.status).toBe(1); expect(r.stderr).toContain('PACK_ERROR');
      writeFileSync(join(cwd, 'd.md'), `# Spec: d\nId: d-ant\nGoal: g\n## Constraints\n- 见 [[missing#x]]\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`);
      const r2 = runAnt(['pack', 'd.md'], cwd, home);
      expect(r2.status).toBe(1); expect(r2.stderr).toContain('HOPANT_DOC_MISSING');
      expect(existsSync(join(cwd, 'ants', 'd-ant'))).toBe(false);
    });
    // @v: anc-cli-ant, anc-hopant-pack —— 设计 hop-cli.md ^anc-cli-ant pack 条"不存在或不可读 → PACK_ERROR"的不可读半边（0156 语义审计）;root 下 chmod 000 拦不住读,跳过
    // @v: anc-hopant-index, anc-hopant-pack —— pack 直落某级 HopAnt 根时重建该根 index.md（2026-10-11 天气总结实撞：封进 hop_tasks/ants/ 后索引空表,/hop 分派命中不了）
    // 变异：hop-admin 的 indexRoot 判定改恒 undefined → 正例红;改恒传 outDir（封到别处也重建）→ 反例红
    it('正例：pack --out <项目级根 hop_tasks/ants> → 该根 index.md 多出这一行,响应 pack.index_rebuilt 是该根;就地 ant list 能列到 scope=project', () => {
      const home = mkdtempSync(join(tmpdir(), 'cli-api-home-')); const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cli-api-cwd-')));
      writeFileSync(join(cwd, 'spec.md'), `# Spec: 天气穿衣建议\nId: weather-ant\nGoal: 查天气给建议\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`);
      const r = runAnt(['pack', 'spec.md', '--out', 'hop_tasks/ants'], cwd, home);
      expect(r.status, r.stderr).toBe(0);
      const j = last(r.stdout);
      expect(j.pack.index_rebuilt).toBe(join(cwd, 'hop_tasks', 'ants'));
      const idx = readFileSync(join(cwd, 'hop_tasks', 'ants', 'index.md'), 'utf-8');
      expect(idx).toContain('- weather-ant — 天气穿衣建议 — 查天气给建议');   // 变异：indexRoot 恒 undefined → 索引文件不在/无此行,红
      const l = runAnt(['list'], cwd, home);
      expect(l.status, l.stderr).toBe(0);
      expect(last(l.stdout).ants.some((a: { id: string; scope: string }) => a.id === 'weather-ant' && a.scope === 'project')).toBe(true);
    });
    it('反例：pack 到别处（缺省 <cwd>/ants,不是任何一级 HopAnt 根）→ 不建 index.md,响应 index_rebuilt 为 null（待装目录,索引归 install）', () => {
      const home = mkdtempSync(join(tmpdir(), 'cli-api-home2-')); const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cli-api-cwd2-')));
      writeFileSync(join(cwd, 'spec.md'), `# Spec: s\nId: elsewhere-ant\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`);
      const r = runAnt(['pack', 'spec.md'], cwd, home);
      expect(r.status, r.stderr).toBe(0);
      expect(last(r.stdout).pack.index_rebuilt).toBeNull();
      expect(existsSync(join(cwd, 'ants', 'index.md'))).toBe(false);   // 变异：恒传 outDir → 这里长出 index.md,红
      expect(existsSync(join(cwd, 'hop_tasks', 'ants'))).toBe(false);   // 项目级根不无故长出
    });
    it.skipIf(process.getuid?.() === 0)('正/反（antPack 不可读）：入口 spec chmod 000 → PACK_ERROR 前缀且报文含\'读不出\';可读时照常产出', () => {
      const home = mkdtempSync(join(tmpdir(), 'cli-ap-home3-')); const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cli-ap-cwd3-')));
      const specPath = join(cwd, 'spec.md');
      writeFileSync(specPath, `# Spec: s\nId: unreadable-ant\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`);
      const ctx = adminCtx({ ...process.env, HOME: home }, cwd);
      chmodSync(specPath, 0o000);
      try {
        let caught: unknown;
        try { antPack(ctx, 'spec.md', {}); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(Error);
        const msg = (caught as Error).message;
        expect(msg.startsWith('PACK_ERROR: ')).toBe(true);     // 不是裸 EACCES 系统错误
        expect(msg).toContain('读不出');
        expect(msg).toContain('EACCES');                        // 系统错误 message 附在后面
        expect(existsSync(join(cwd, 'ants', 'unreadable-ant'))).toBe(false);
      } finally {
        chmodSync(specPath, 0o644);                              // 让临时目录能清理
      }
      const ok = antPack(ctx, 'spec.md', {});                    // 正例：同一文件可读后照常产出
      expect(ok.action).toBe('pack'); expect(ok.id).toBe('unreadable-ant');
      expect(existsSync(join(cwd, 'ants', 'unreadable-ant', 'unreadable-ant.md'))).toBe(true);
    });
    it('share：owner 四态（决策 8 答过不再问）——首机无旗返回 owner_prompt_required 不写包退出 0;--owner 写包并把 owner_id 写回 config.yaml（只动这一键）;config 已有 owner_id 时不带旗直接用不问;响应带 credential_scan 回执', () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'cli-as-home-'))); const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cli-as-cwd-')));
      mkdirSync(join(home, '.hopjit'), { recursive: true });
      writeFileSync(join(home, '.hopjit', 'config.yaml'), 'language: zh\ncommands: [git]\n');
      writeFileSync(join(cwd, 'spec.md'), `# Spec: s\nId: share-me\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`);
      expect(runAnt(['pack', 'spec.md'], cwd, home).status).toBe(0);
      expect(runAnt(['install', join(cwd, 'ants', 'share-me')], cwd, home).status).toBe(0);
      const ask = runAnt(['share', 'share-me', '--out', 'pk'], cwd, home);
      expect(ask.status, ask.stderr).toBe(0);
      const aj = last(ask.stdout);
      expect(aj.owner_prompt_required).toBe(true); expect(typeof aj.owner_default).toBe('string'); expect(aj.share).toBeUndefined();
      expect(existsSync(join(cwd, 'pk', 'share-me'))).toBe(false);   // 变异：缺 owner 也写包 → 红
      const ok = runAnt(['share', 'share-me', '--out', 'pk', '--owner', 'alice-laptop', '--pkg-version', '1.2.3'], cwd, home);
      expect(ok.status, ok.stderr).toBe(0);
      const oj = last(ok.stdout);
      expect(oj.share.name).toBe('share-me'); expect(oj.share.version).toBe('1.2.3'); expect(oj.share.owner).toBe('alice-laptop');
      expect(oj.owner_written).toBe(join(home, '.hopjit', 'config.yaml'));
      const cfg = readFileSync(join(home, '.hopjit', 'config.yaml'), 'utf-8');
      expect(cfg).toContain('owner_id: alice-laptop'); expect(cfg).toContain('language: zh'); expect(cfg).toContain('- git');   // 其余键原样（变异：整文件覆盖 → 红）
      const pkg = JSON.parse(readFileSync(join(cwd, 'pk', 'share-me', 'package.json'), 'utf-8'));
      expect(pkg.hopant.owner).toBe('alice-laptop');
      expect(oj.credential_scan.method).toBe('heuristic'); expect(oj.credential_scan.rejected).toEqual([]); expect(typeof oj.credential_scan.disclaimer).toBe('string');   // 回执提到顶层（变异：不透传 → 红）
      // config 已有 owner_id：不带任何旗也直接用落盘值,不再问（变异 D4：没旗仍走 prompt 分支 → share 为 undefined 红）
      const again = runAnt(['share', 'share-me', '--out', 'pk2'], cwd, home);
      expect(again.status, again.stderr).toBe(0);
      const gj = last(again.stdout);
      expect(gj.owner_prompt_required).toBeUndefined();
      expect(gj.share.owner).toBe('alice-laptop');
      expect(gj.share.version).toBe('0.1.0');   // --pkg-version 缺省（变异 M33：缺省改 9.9.9 → 红）
    });
    it('share：首机（无 config.yaml）--yes 现算 用户-机器 并新建 config 只含 owner_id;config 顶层不是映射 → CONFIG_ERROR 退 1', () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'cli-as-home3-'))); const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cli-as-cwd3-')));
      writeFileSync(join(cwd, 'spec.md'), `# Spec: s\nId: first-box\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`);
      expect(runAnt(['pack', 'spec.md'], cwd, home).status).toBe(0);
      expect(runAnt(['install', join(cwd, 'ants', 'first-box')], cwd, home).status).toBe(0);
      expect(existsSync(join(home, '.hopjit', 'config.yaml'))).toBe(false);
      const yes = runAnt(['share', 'first-box', '--out', 'pk', '--yes'], cwd, home);
      expect(yes.status, yes.stderr).toBe(0);
      const yj = last(yes.stdout);
      expect(yj.share.owner).toMatch(/^[^\s]+-[^\s]+$/);   // 用户-机器 现算
      const cfg = readFileSync(join(home, '.hopjit', 'config.yaml'), 'utf-8');   // 变异 M38：文件不存在不新建 → 读失败红
      expect(cfg.trim()).toBe(`owner_id: ${yj.share.owner}`);
      writeFileSync(join(home, '.hopjit', 'config.yaml'), '- not\n- a map\n');
      const bad = runAnt(['share', 'first-box', '--out', 'pk3', '--owner', 'x-y'], cwd, home);
      expect(bad.status).toBe(1); expect(bad.stderr).toContain('CONFIG_ERROR');   // 变异 M37：顶层非映射不抛 → 红
    });
    it('share 反例：没装的 id → HOPANT_NOT_FOUND 退出 1;多 id 缺 --name → HOPANT_PKG_NAME_REQUIRED', () => {
      const home = mkdtempSync(join(tmpdir(), 'cli-as-home2-')); const cwd = mkdtempSync(join(tmpdir(), 'cli-as-cwd2-'));
      const r = runAnt(['share', 'ghost', '--owner', 'o'], cwd, home);
      expect(r.status).toBe(1); expect(r.stderr).toContain('HOPANT_NOT_FOUND');
      const r2 = runAnt(['share', 'a', 'b', '--owner', 'o'], cwd, home);
      expect(r2.status).toBe(1); expect(r2.stderr).toContain('HOPANT_PKG_NAME_REQUIRED');
    });
  });

  describe('setup 缺省装演示 HopAnt', () => {
    // 每例独立家目录——SUBPROC_HOME 被别的用例共用,演示件装过一次后再跑就是"已装跳过",测不到首装
    const runFresh = (args: string[], cwd: string, home: string) => spawnSync(process.execPath, [CLI, '--json', ...args], {
      cwd, encoding: 'utf-8', timeout: 5000,
      env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode') },
    });
    const last = (out: string) => JSON.parse(out.trim().split('\n').pop()!);

    it('首装三件齐（入口 spec 名=id、Id/标识 行改写、资产同目录、inner_store、索引）;再跑全跳过且 --force 不覆盖', () => {
      const home = mkdtempSync(join(tmpdir(), 'cli-demo-ant-home-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-demo-ant-cwd-'));
      const r1 = runFresh(['setup', '--dir', 'sk'], cwd, home);
      expect(r1.status).toBe(0);
      const o1 = last(r1.stdout);
      expect(o1.demo_ants).toEqual(['demo-coffee-week', 'demo-fact-check', 'demo-rename']);
      expect(o1.demo_note).toBeUndefined();
      const ants = join(home, '.hopjit', 'ants');
      expect(readFileSync(join(ants, 'demo-rename', 'demo-rename.md'), 'utf-8')).toMatch(/^Id: demo-rename$/m);
      expect(readFileSync(join(ants, 'demo-coffee-week', 'demo-coffee-week.md'), 'utf-8')).toMatch(/^Id: demo-coffee-week$/m);
      expect(readFileSync(join(ants, 'demo-fact-check', 'demo-fact-check.md'), 'utf-8')).toMatch(/^标识: demo-fact-check$/m);
      expect(existsSync(join(ants, 'demo-coffee-week', 'coffee-sales.json'))).toBe(true);
      expect(existsSync(join(ants, 'demo-fact-check', 'fact-check-sample.md'))).toBe(true);
      expect(existsSync(join(ants, 'demo-rename', 'inner_store'))).toBe(true);
      const idx = readFileSync(join(ants, 'index.md'), 'utf-8');
      for (const id of ['demo-coffee-week', 'demo-fact-check', 'demo-rename']) expect(idx).toContain(`- ${id} — `);
      expect(readdirSync(join(cwd, 'sk')).some(n => n.startsWith('demo-'))).toBe(false);   // 不进载体 skill 目录
      // 用户改过的演示件：再跑（含 --force）不覆盖,demo_note 说明跳过与刷新方法
      const mine = join(ants, 'demo-rename', 'demo-rename.md');
      writeFileSync(mine, readFileSync(mine, 'utf-8') + '\n<!-- 用户改过 -->\n');
      const o2 = last(runFresh(['setup', '--dir', 'sk', '--force'], cwd, home).stdout);
      expect(o2.demo_ants).toEqual([]);
      expect(o2.demo_note).toContain('demo-rename 已装，跳过');
      expect(o2.demo_note).toContain('hopjit ant remove demo-rename');
      expect(readFileSync(mine, 'utf-8')).toContain('<!-- 用户改过 -->');
    });

    it('--demo 被接受（结果同缺省）且 setup --help 不列它', () => {
      const home = mkdtempSync(join(tmpdir(), 'cli-demo-ant-alias-'));
      const cwd = mkdtempSync(join(tmpdir(), 'cli-demo-ant-alias-cwd-'));
      const r = runFresh(['setup', '--dir', 'sk', '--demo'], cwd, home);
      expect(r.status).toBe(0);
      expect(last(r.stdout).demo_ants).toEqual(['demo-coffee-week', 'demo-fact-check', 'demo-rename']);
      const help = spawnSync(process.execPath, [CLI, 'setup', '--help'], { encoding: 'utf-8', timeout: 5000 });
      expect(help.stdout).toContain('--plus');
      expect(help.stdout).not.toContain('--demo');
    });
  });

  // @v: anc-cli-install-skill-demo-ants —— installDemoAnts / rewriteSpecId 单元面（临时家目录,不经 CLI）
  describe('installDemoAnts / rewriteSpecId', () => {
    it('rewriteSpecId：Id 与 标识 两种关键词都改写且关键词保留;只改第一处;都没有原文不变', () => {
      expect(rewriteSpecId('# Spec: x\nId: old\n', 'new')).toBe('# Spec: x\nId: new\n');
      expect(rewriteSpecId('# 规约: x\n标识: 旧名\n', 'demo-x')).toBe('# 规约: x\n标识: demo-x\n');
      expect(rewriteSpecId('Id: a\nId: b\n', 'z')).toBe('Id: z\nId: b\n');
      expect(rewriteSpecId('# Spec: x\nGoal: y\n', 'z')).toBe('# Spec: x\nGoal: y\n');
    });

    it('包根缺原件：三件都进 notes 说明失败,不抛异常,ants 目录无半成品', () => {
      const home = mkdtempSync(join(tmpdir(), 'cli-demo-unit-'));
      const r = installDemoAnts(join(home, 'no-such-pkg'), home);
      expect(r.installed).toEqual([]);
      expect(r.notes).toHaveLength(3);
      expect(r.notes.every(n => n.includes('安装失败'))).toBe(true);
      expect(existsSync(join(home, '.hopjit', 'ants', 'demo-coffee-week'))).toBe(false);
    });

    it('部分已装：只装缺的那几件,已装的原样不动', () => {
      const home = mkdtempSync(join(tmpdir(), 'cli-demo-unit-part-'));
      const pre = join(home, '.hopjit', 'ants', 'demo-coffee-week');
      mkdirSync(pre, { recursive: true });
      writeFileSync(join(pre, 'demo-coffee-week.md'), '# Spec: 用户自己的\n');
      const r = installDemoAnts(PROJECT_ROOT, home);
      expect(r.installed).toEqual(['demo-fact-check', 'demo-rename']);
      expect(r.notes).toEqual(['demo-coffee-week 已装，跳过（要刷新先 hopjit ant remove demo-coffee-week）']);
      expect(readFileSync(join(pre, 'demo-coffee-week.md'), 'utf-8')).toBe('# Spec: 用户自己的\n');
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
      const r = runCliJson(`setup --dir ${join(dir, '.claude/skills')}`, dir);
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
      runCliJson(`setup --dir ${join(dir, 'sk')}`, dir);
      const r2 = runCliJson(`setup --dir ${join(dir, 'sk')}`, dir);
      expect(r2.status).toBe('ok');
      expect(r2.installed).toHaveLength(0);
      expect(r2.note).toBeTruthy();
    });

    // @v: anc-driver-codex-install-layout
    it('codex 载体 --dir=skills 根展开 main/segment-driver 布局（2026-08-27 看齐批:缺省用户级 ~/.codex/skills,测试恒显式 --dir 防写真实家目录）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-installskill-codex-'));
      const r = runCliJson(`setup --carrier codex --dir ${join(dir, 'sk')}`, dir);
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
      runCliJson('setup --carrier codex --dir out', dir);
      writeFileSync(skillPath, 'user-customized', 'utf-8');

      const skipped = runCliJson('setup --carrier codex --dir out', dir);
      expect(skipped.installed).toHaveLength(0);
      expect(skipped.note).toBeTruthy();
      expect(readFileSync(skillPath, 'utf-8')).toBe('user-customized');

      const forced = runCliJson('setup --carrier codex --dir out --force', dir);
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
      const stdout = execSync(`node "${link}" --json setup --dir out`, {
        cwd: dir, encoding: 'utf-8', timeout: 5000,
        env: { ...process.env, HOME: SUBPROC_HOME, CODEX_HOME: join(SUBPROC_HOME, '.codex'), CLAUDE_CONFIG_DIR: join(SUBPROC_HOME, '.claude'), OPENCODE_CONFIG_DIR: join(SUBPROC_HOME, '.config', 'opencode') },
      }).trim();
      const r = JSON.parse(stdout);
      expect(r.status).toBe('ok');
      expect(existsSync(join(dir, 'out/hopspec/SKILL.md'))).toBe(true);
    });
  });

  // @v: anc-cli-install-skill
  // 命令名 setup,旧名 install-skill 退役为隐藏别名（todo/0143,2026-10-06 作者定）：
  // 旧名行为与 stdout 和 setup 相同,stderr 多一行改名提示;--help 只列 setup。
  describe('setup 与隐藏别名 install-skill', () => {
    const runWithStderr = (args: string, cwd: string) => spawnSync(process.execPath, [CLI, '--json', ...args.split(' ')], {
      cwd, encoding: 'utf-8', timeout: 5000,
      env: { ...process.env, HOME: SUBPROC_HOME, CODEX_HOME: join(SUBPROC_HOME, '.codex'), CLAUDE_CONFIG_DIR: join(SUBPROC_HOME, '.claude'), OPENCODE_CONFIG_DIR: join(SUBPROC_HOME, '.config', 'opencode') },
    });

    it('正例：setup 装出 skill,stderr 无改名提示', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-setup-'));
      const r = runWithStderr('setup --dir out', dir);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout.trim().split('\n').pop()!).status).toBe('ok');
      expect(existsSync(join(dir, 'out/hop/SKILL.md'))).toBe(true);
      expect(r.stderr).not.toContain('已改名为 setup');
    });

    it('旧名 install-skill 仍可用：装出同样的 skill,stderr 提示改用 setup', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-setup-alias-'));
      const r = runWithStderr('install-skill --dir out', dir);
      expect(r.status).toBe(0);
      const o = JSON.parse(r.stdout.trim().split('\n').pop()!);
      expect(o.status).toBe('ok');
      expect(existsSync(join(dir, 'out/hop/SKILL.md'))).toBe(true);
      expect(r.stderr).toContain('[hopjit] install-skill 已改名为 setup，请改用 hopjit setup');
    });

    it('--help 列出 setup,不列 install-skill', () => {
      const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf-8', timeout: 5000 });
      expect(r.stdout).toMatch(/^\s+setup\b/m);
      expect(r.stdout).not.toContain('install-skill');
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
    // 需要目录里有可 load 的父实例——把真实父实例目录整份复制到深层路径（含 specs/ 真身：spec.json 自内容寻址起是
    // 引用形态,单拷三件读不到真身;伪造的中间层没有 state.json,findRunRoot 到此即止,真身须随目录一起在）
    const realParent = join(dir, 'state', parent);
    const deepParent = join(dir, deep);
    mkdirSync(deepParent, { recursive: true });
    for (const f of ['state.json', 'vars.json', 'spec.json']) writeFileSync(join(deepParent, f), readFileSync(join(realParent, f)));
    cpSync(join(realParent, 'specs'), join(deepParent, 'specs'), { recursive: true });   // 真身随引用走（目标是自身子目录,不能整目录 cpSync）
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
// dispatch_kind:'call' 的 launch_command 里 callee 位置由引擎填解析出的绝对路径（^anc-exec-callee-resolver）,driver 照抄执行。
// @v: anc-exec-parallel-reuse-protocol
describe('复用模式 call parallel（dispatch_kind=call 占位符闭环）', () => {
  it('正例：call 派发→引擎填好 callee 路径→子进程跑完→reap 收齐', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-reuse-call-'));
    writeFileSync(join(dir, 'build.md'), `# Build
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
    expect(r1.launch_command).toContain('build.md"'); // @v: anc-exec-callee-resolver
    expect(r1.launch_command).not.toContain('<CALLEE_SPEC_PATH:');
    expect(r1.launch_command).toContain('--call-parent');
    const inst = r1.instance_id;
    const { execSync } = require('node:child_process');
    // driver 姿势：路径已由引擎填好,整串照抄执行
    const fill = (lc: string) => lc;
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

  // 2026-10-08 作者定"同一个工作的 commit 不能被反复执行,是宪法级原则"：stale_launch 对跑过的子实例（state.json 在场）
  // 拼 resume 续跑,不再拼 run 重建——此前 worker 入口对已有目录走 re-init 净室整目录重跑,已执行且已批准的 commit 被重放。
  // design parallel-execution U4b 第 6 条 stale_launch 分叉条 / exec-engine ^anc-exec-call-reinit-clean 触发面。
  // @v: anc-exec-parallel-hitl-queue, anc-exec-call-reinit-clean
  it('正例（复用模式端到端）：子实例两句 commit,第一句批准执行后停第二张卡;新进程 advance 的 stale_launch 拼 resume,重起后第一句 commit 不重放（step_done 仍 1 次、committed_steps 不变、hoplog 单 run 目录）,批准第二句后收齐（变异：stale_launch 恒拼 run 本例红）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-stale-resume-'));
    const TWO = `# P2
Id: p3b
## Goal
g
## Inputs
- items: [int]  # 项
## Outputs
- outs: [int]  # 收
## Steps
1. [loop for-each x in items, collect y into outs] 逐项
  + → outs: [int]  # 收
  1.1. [subtask parallel] 单项
    + → y: int  # 值
    1.1.1. [act] 备
      - ← x
      + → y0: int  # 值
      > \`\`\`hop_python
      > y0 = x * 2
      > \`\`\`
    1.1.2. [commit] 第一句
      - ← y0
      + → y1: int  # 值
      > \`\`\`hop_python
      > w1 = write(path: "c1.txt", content: "a", keep: 0)
      > y1 = y0 + 1
      > \`\`\`
    1.1.3. [commit] 第二句
      - ← y1
      + → y: int  # 值
      > \`\`\`hop_python
      > w2 = write(path: "c2.txt", content: "b", keep: 0)
      > y = y1
      > \`\`\`
`;
    writeFileSync(join(dir, 'p.md'), TWO);
    const { execSync } = require('node:child_process');
    const r1 = runCliJson(`run p.md --state-dir state --params '{"items":[1]}' --workspace ${dir}`, dir);
    const inst = r1.instance_id;
    expect(runCliJson(`advance --state-dir state --instance ${inst}`, dir).status).toBe('drain_wait');
    const w1 = JSON.parse(execSync(r1.launch_command, { cwd: dir, encoding: 'utf-8' }));
    expect(w1.status).toBe('paused'); expect(w1.pause_reason).toBe('commit'); expect(w1.step_id).toBe('1.1.2');
    const w2 = approveAndResume(dir, `state/${inst}/parallel`, '1.1.1', w1);
    expect(w2.status).toBe('paused'); expect(w2.step_id).toBe('1.1.3');
    const childState = () => JSON.parse(readFileSync(join(dir, 'state', inst, 'parallel', '1.1.1', 'state.json'), 'utf-8'));
    const doneCount = () => (childState().exec_events as { step_id: string; event: string }[]).filter(e => e.step_id === '1.1.2' && e.event === 'step_done').length;
    expect(doneCount()).toBe(1);
    expect(childState().committed_steps.map((c: { step_id: string }) => c.step_id)).toEqual(['1.1.2']);
    // 新进程对账：子实例 state.json 在场 → stale_launch 拼 resume 不拼 run
    const r3 = runCliJson(`advance --state-dir state --instance ${inst}`, dir);
    expect(r3.status).toBe('drain_wait');
    expect(r3.stale).toEqual(['1.1.1']);
    expect(r3.stale_launch['1.1.1']).toMatch(/--json resume --state-dir ".*\/parallel" --instance 1\.1\.1$/);
    expect(r3.stale_launch['1.1.1']).not.toContain('--parallel-parent');
    const w3 = JSON.parse(execSync(r3.stale_launch['1.1.1'], { cwd: dir, encoding: 'utf-8' }));
    expect(w3.status).toBe('paused'); expect(w3.step_id).toBe('1.1.3');               // 续跑到第二张卡,不从头
    expect(doneCount()).toBe(1);                                                        // 修前 2——第一句被重放
    expect(childState().committed_steps.map((c: { step_id: string }) => c.step_id)).toEqual(['1.1.2']);
    const w4 = approveAndResume(dir, `state/${inst}/parallel`, '1.1.1', w3);
    expect(w4.status).toBe('completed');
    const r4 = runCliJson(`reap_and_fetch_next 1.1.1 --status completed --state-dir state --instance ${inst}`, dir);
    expect(r4.status).toBe('completed');
    expect(r4.outputs.outs).toEqual([3]);
  });

  // @v: anc-exec-parallel-hitl-queue
  it('正例（分叉的另一半）：从未起过的子实例（只有 params.json 无 state.json）超宽限入 stale → stale_launch 仍拼 run --parallel-parent 重建（既有 dispatch-lost 降级形态不变）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-stale-run-'));
    writeFileSync(join(dir, 'pipe.md'), PIPE);
    const r1 = runCliJson(`run pipe.md --state-dir state --params '{"nums":[5]}'`, dir);
    const inst = r1.instance_id;
    const statePath = join(dir, 'state', inst, 'state.json');
    const st = JSON.parse(readFileSync(statePath, 'utf-8'));
    st.inflight[0].dispatched_at = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(statePath, JSON.stringify(st));
    expect(existsSync(join(dir, 'state', inst, 'parallel', '1.1.1', 'state.json'))).toBe(false);
    const r2 = runCliJson(`advance --state-dir state --instance ${inst}`, dir);
    expect(r2.stale).toContain('1.1.1');
    expect(r2.stale_launch['1.1.1']).toContain('--json run ');
    expect(r2.stale_launch['1.1.1']).toContain('--parallel-child 1.1.1');
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
    // @v: anc-exec-callee-resolver —— 引擎按同目录规则解析出的绝对路径
    expect(cp.init_command).toContain('double.md"');
    expect(cp.init_command).not.toContain('<CALLEE_SPEC_PATH:');
    expect(cp.init_command).toContain('--parent ' + run.instance_id);
    expect(cp.init_command).toContain('--step 2');
    // auto-map 快照（base+1）已折入——参数表走参数文件,命令里只有 "@<路径>"（^anc-exec-cmd-args-file）
    const pm = /--params "@([^"]+)"/.exec(cp.init_command);
    expect(pm).not.toBeNull();
    expect(JSON.parse(readFileSync(pm![1], 'utf-8'))).toMatchObject({ n: 21 });
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
    // driver 唯一动作：照抄（callee 路径引擎已填）
    const initCmd = cp.init_command;
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
  > 不留旧版本地写一份记录,再计算
  > \`\`\`hop_python
  > w = write(path: "cdouble.txt", content: "x", keep: 0)
  > doubled = n * 2
  > \`\`\`
`);
    const run = runCliJson(`run caller.md --params '{"base": 5}' --state-dir state`, dir);
    expect(run.status).toBe('step_ready');
    const cp = run.call_protocol;
    const { execSync } = require('node:child_process');
    execSync(cp.init_command, { cwd: dir, stdio: 'pipe' });
    // 子实例的 commit 首次执行前停在批准点（todo/0146 ^anc-exec-commit-approval）——批准后续跑
    const paused = JSON.parse(execSync(cp.child_advance, { cwd: dir, stdio: 'pipe' }).toString());
    expect(paused.pause_reason).toBe('commit');
    approveAndResume(dir, cp.child_state_dir, cp.child_instance, paused);
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
// @v: anc-config-sandbox-workspace-root — 工作区根起跑定一次、持久化恒绝对路径,续推命令从别的 cwd 敲也不漂
describe('工作区根不随续推命令的进程 cwd 漂移（2026-10-04 英文文档批一实撞）', () => {
  const WRITE_SPEC = (dst: string) => `# WS
Id: wsroot
## Goal
g
## Steps
1. [confirm] go
  + → go: bool  # 放行
2. [commit] 写盘
  + → written: line  # 落点
  > 写 workspace 内相对路径,不留旧版本（keep=0 落 review 档,无分析模型时停下等人）
  > \`\`\`hop_python
  > written = write(path: "${dst}", content: "probe", keep: 0)
  > \`\`\`
`;
  it('正例：run 在仓库根起跑,driver cd 进 work_zone 敲 submit 触发 commit 写 docs/x.md → 落仓库根下,放行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-wsroot-'));
    mkdirSync(join(dir, 'docs'));   // write 不建父目录（既有契约）,目标目录与真实仓库同样预先在场
    writeFileSync(join(dir, 'ws.md'), WRITE_SPEC('docs/out.md'));
    const run = runCliJson(`run ws.md --state-dir state`, dir);
    expect(run.status).toBe('paused');
    // state.json 里两个工作区字段都是绝对路径且同值（修前 sandbox 侧存 '.'）
    const st = JSON.parse(readFileSync(join(dir, 'state', run.instance_id, 'state.json'), 'utf-8'));
    expect(st.host_context.sandbox.filesystem.workspace_dir).toBe(st.host_context.workspace_dir);
    expect(st.host_context.sandbox.filesystem.workspace_dir.startsWith('/')).toBe(true);
    // 从 work_zone 目录敲续推命令（worker 为写相对 --output @ 常这么做）
    const wz = join(dir, 'state', run.instance_id, 'work_zone');
    mkdirSync(wz, { recursive: true });
    const gate = runCliJson(`submit_and_fetch_next 1 --output '{"go": true}' --state-dir ${join(dir, 'state')} --instance ${run.instance_id}`, wz);
    expect(gate.pause_reason).toBe('commit');   // commit 首次执行前停在批准点（todo/0146）
    const done = approveAndResume(wz, join(dir, 'state'), run.instance_id, gate);
    expect(done.status).toBe('completed');
    expect(existsSync(join(dir, 'docs', 'out.md'))).toBe(true);            // 落仓库根,不是 work_zone/docs
    expect(existsSync(join(wz, 'docs', 'out.md'))).toBe(false);
  });
  it('反例：同形态下 commit 写工作区外绝对路径仍拒——边界不放松', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-wsroot-out-'));
    const outside = join(mkdtempSync(join(tmpdir(), 'cli-wsroot-ext-')), 'leak.md');
    writeFileSync(join(dir, 'ws.md'), WRITE_SPEC(outside));
    const run = runCliJson(`run ws.md --state-dir state`, dir);
    const wz = join(dir, 'state', run.instance_id, 'work_zone');
    mkdirSync(wz, { recursive: true });
    const gate = runCliJson(`submit_and_fetch_next 1 --output '{"go": true}' --state-dir ${join(dir, 'state')} --instance ${run.instance_id}`, wz);
    expect(gate.pause_reason).toBe('commit');
    const r = approveAndResume(wz, join(dir, 'state'), run.instance_id, gate);
    expect(JSON.stringify(r)).toMatch(/Write outside workspace sandbox|failed/);
    expect(existsSync(outside)).toBe(false);
  });
});

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
    const initCmd = cp.init_command
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

// 复用模式两级配置合并（todo/0131——此前 buildHostConfig 只读项目级三个单键,系统级 ~/.hopjit/config.yaml 一个键都不读;
// 作者 2026-09-30 定旧口径是 agent 自拟）。卡 probe 1–4 测试化;全部假 HOME + 临时项目目录。
// @v: anc-config-reuse-consume, anc-exec-subprocess-run
describe('复用模式两级配置合并', () => {
  let savedHome: string | undefined; let savedCfg: string | undefined; let prevCwd = '';
  function fx(): { home: string; proj: string } {
    const home = mkdtempSync(join(tmpdir(), 'cl-home-')); const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cl-proj-')));
    mkdirSync(join(home, '.hopjit'), { recursive: true });
    process.env.HOME = home; delete process.env.HOPJIT_CONFIG;
    return { home, proj };
  }
  const savedLang: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedHome = process.env.HOME; savedCfg = process.env.HOPJIT_CONFIG; prevCwd = process.cwd();
    // language 缺省自 todo/0160 起跟随系统语言——本组"缺省 en"断言按英文环境写,进组前钉成 en_US
    for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) { savedLang[k] = process.env[k]; delete process.env[k]; } process.env.LANG = 'en_US.UTF-8';
  });
  afterEach(() => {
    process.chdir(prevCwd);
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedCfg === undefined) delete process.env.HOPJIT_CONFIG; else process.env.HOPJIT_CONFIG = savedCfg;
    for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) { if (savedLang[k] === undefined) delete process.env[k]; else process.env[k] = savedLang[k]; }
  });

  it('probe 1 正例：系统级 config.yaml 注册 in-process 工具、项目无 hopjit.yaml → tool-call 成功（修前 UNKNOWN_TOOL）', () => {
    const { home, proj } = fx();
    writeFileSync(join(home, '.hopjit', 'echo-tools.mjs'), 'export async function execute(name, args) { return { success: true, result: "echo:" + args.msg, content_type: "text" }; }\n');
    writeFileSync(join(home, '.hopjit', 'config.yaml'), 'tool_servers:\n  - name: sys_probe\n    binding:\n      kind: in-process\n      module: ./echo-tools.mjs\n    tools:\n      - name: sys_echo\n        description: echo\n        input_schema: {type: object}\n        requires_commit: false\n');
    const r = execSync(`node "${CLI}" --json tool-call sys_echo --args '{"msg":"hi"}'`, { cwd: proj, encoding: 'utf-8', env: { ...process.env, HOME: home, HOPJIT_ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const j = JSON.parse(r.trim());
    expect(j.status).toBe('ok');
    expect(String(j.result)).toBe('echo:hi');   // 系统级条目的 module 相对 ~/.hopjit/ 解析
  });

  it('probe 2 正例：系统级 commands: [git] + 项目级 commands: [uv] → sandbox.runtime.available 同时含两者（并集）', () => {
    const { home, proj } = fx();
    writeFileSync(join(home, '.hopjit', 'config.yaml'), 'commands: [git]\n');
    writeFileSync(join(proj, 'hopjit.yaml'), 'commands: [uv]\n');
    const hc = buildHostConfig(proj);
    expect(hc.sandbox.runtime.available).toEqual(['git', 'uv']);
  });

  it('probe 3 正例：系统级 language: zh 项目不写 → zh;项目写 en → en（项目级赢）', () => {
    const { home, proj } = fx();
    writeFileSync(join(home, '.hopjit', 'config.yaml'), 'language: zh\n');
    expect(buildHostConfig(proj).language).toBe('zh');
    expect(buildHostConfig(proj).hop_env?.hop_env_language).toBe('zh');
    writeFileSync(join(proj, 'hopjit.yaml'), 'language: en\n');
    expect(buildHostConfig(proj).language).toBe('en');
  });

  it('probe 4 正例：系统级 env: {hop_env_x: a} → hop_env 含 hop_env_x=a;params 传 hop_env_x 仍覆盖（覆盖链后到覆盖）', () => {
    const { home, proj } = fx();
    writeFileSync(join(home, '.hopjit', 'config.yaml'), 'env: {hop_env_x: a}\nresource_limits: {max_call_depth: 5}\n');
    const hc = buildHostConfig(proj);
    expect(hc.hop_env).toEqual({ hop_env_language: 'en', hop_env_x: 'a' });
    expect(hc.resource_limits?.max_call_depth).toBe(5);   // 复用模式此前拿不到配置的 resource_limits
    extractHopEnvIntoHostConfig(hc, { hop_env_x: 'from-params' });
    expect(hc.hop_env?.hop_env_x).toBe('from-params');
  });

  it('反例：系统级文件坏 YAML → 钝感回缺省（空名单 / en）并 stderr 记一行,不炸;项目级 commands 含 hopjit → CONFIG_ERROR 响亮抛', () => {
    const { home, proj } = fx();
    writeFileSync(join(home, '.hopjit', 'config.yaml'), ':::bad yaml{{{\n');
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const hc = buildHostConfig(proj);
      expect(hc.sandbox.runtime.available).toEqual([]);
      expect(hc.language).toBe('en');
      expect(errSpy.mock.calls.map(c => String(c[0])).join('')).toMatch(/\[config\] .*config\.yaml 读取失败,这份文件按零配置处理/);   // 分文件容错后 warning 点名文件（2026-10-08 review 修复）
    } finally { errSpy.mockRestore(); }
    writeFileSync(join(home, '.hopjit', 'config.yaml'), 'commands: [git]\n');
    writeFileSync(join(proj, 'hopjit.yaml'), 'commands:\n  - /opt/bin/hopjit\n');
    expect(() => buildHostConfig(proj)).toThrow(/CONFIG_ERROR: .*不得含 hopjit/);   // @v: anc-exec-subprocess-deny-hopjit
  });

  it('反例：HOPJIT_CONFIG 指向单文件 → 只用它,系统级与项目级都不参与', () => {
    const { home, proj } = fx();
    writeFileSync(join(home, '.hopjit', 'config.yaml'), 'commands: [git]\n');
    writeFileSync(join(proj, 'hopjit.yaml'), 'commands: [uv]\n');
    const one = join(home, 'one.yaml'); writeFileSync(one, 'commands: [only]\n');
    process.env.HOPJIT_CONFIG = one;
    expect(buildHostConfig(proj).sandbox.runtime.available).toEqual(['only']);
  });
});

// status 停驻如实转述（todo/0081——此前 execution_status 枚举缺 paused,停驻报 running:
// 看护方接 CLI status 通道感知不到"引擎在等人",停点挂死〔2026-09-09 实撞 30+ 分钟〕。
// 判定三源见 hop-cli.md ^anc-cli-status-response;网络暂停与嵌套串行调用停点两源〔todo/0105〕见 ^anc-cli-status-nested-pause）
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

  // @v: anc-cli-status-nested-pause （todo/0105——快照由引擎在进程内造出,status 命令另起进程读盘:
  // 与 T5 观察方同一条通道。修前两例都报 running）
  it('正例：顶层网络暂停快照 → status 报 paused/network,无 call_path;反例：该步重新开始后回 running', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-0105a-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(`# NetCli
Id: net-cli-0105
## Goal
g
## Outputs
- r: text  # r
## Steps
1. [reason] 想
  + → r: text  # r
2. [exit] 交付
  + → r
`, HOST, { stateDir: join(dir, 'state') });
    engine.nextStep();
    engine.resetStepForNetworkPause('1');   // 落盘:步回 pending + 末事件 network_pause
    const st = runCliJson(`status --state-dir state --instance ${init.instance_id}`, dir);
    expect(st.execution_status).toBe('paused');
    expect(st.pause_reason).toBe('network');
    expect(st.paused_step_id).toBe('1');
    expect(st.call_path).toBeUndefined();
    engine.nextStep();   // 恢复:重新开始该步
    const st2 = runCliJson(`status --state-dir state --instance ${init.instance_id}`, dir);
    expect(st2.execution_status).toBe('running');
    expect(st2.pause_reason).toBeUndefined();
  });

  it('正例：串行调用子流程网络暂停快照 → status 报 paused/network/子步号 + call_path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-0105b-'));
    const parent = new ExecutionEngine();
    const init = parent.initExecution(`# CallerCli
Id: caller-cli-0105
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
`, HOST, { stateDir: join(dir, 'state'), params: { x: 1 } });
    parent.nextStep();   // 调用步 running
    const child = new ExecutionEngine();
    child.initExecution(`# Leaf
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
`, HOST, { params: { x: 1 }, parentInstanceId: init.instance_id, callStepId: parent.serialCallChildInstance('1'), stateDir: join(parent.getInstanceDir()!, 'calls') });
    child.nextStep();
    child.resetStepForNetworkPause('1');
    const st = runCliJson(`status --state-dir state --instance ${init.instance_id}`, dir);
    expect(st.execution_status).toBe('paused');
    expect(st.pause_reason).toBe('network');
    expect(st.paused_step_id).toBe('1');
    expect(st.call_path).toEqual(['1']);
    expect(st.current_step).toBe('1');   // 本层 running 的调用步——current_step 原义不变
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

// @v: anc-exec-cmd-args-file — hopissues/0097:命令数据值走参数文件。旧实装把参数表两层
// JSON.stringify 塞进双引号,反引号与 ${X} 在双引号内照样被 shell 解释——driver 经 /bin/sh 照抄
// 执行时,带 markdown 代码块的 node_source 被静默吞成空串（子 spec 源腐蚀）。本组真起 shell 验往返。
describe('call 协议命令数据值走参数文件（0097 shell 元字符防线）', () => {
  const PAYLOAD = 'A `echo INJECTED` B ${HOME} C $(echo SUB) D "q" E \\ F \'s\' G\n```hop_python\nx = 1\n```';
  const CALLER = `# Caller
Id: caller-meta

## Goal
透传

## Inputs
- src: text  # 带元字符的源文本

## Outputs
- result: text  # 回显

## Steps
1. [call echo(s: src)] 调回显
  + → result: out  # 映射
`;
  const CALLEE = `# Echo
Id: echo

## Goal
回显

## Inputs
- s: text  # 源

## Outputs
- out: text  # 回显

## Steps
1. [act] 回显
  - ← s
  + → out: text  # 原样
  > 纯计算
  > \`\`\`hop_python
  > out = s
  > \`\`\`
`;
  it('正例：参数值含反引号/${}/$()/引号/反斜杠/代码块——经 shell 照抄 init_command,子实例拿到的值逐字节不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-cmdargs-'));
    writeFileSync(join(dir, 'caller.md'), CALLER);
    writeFileSync(join(dir, 'echo.md'), CALLEE);
    writeFileSync(join(dir, 'params.json'), JSON.stringify({ src: PAYLOAD }));
    const run = runCliJson(`run caller.md --params @params.json --state-dir state`, dir);
    expect(run.step_type).toBe('call');
    const cp = run.call_protocol;
    const { execSync } = require('node:child_process');
    // driver 唯一动作：整串照抄交 /bin/sh（callee 路径引擎已填;execSync 缺省即 shell 形态——0097 事故现场同款）
    execSync(cp.init_command, { cwd: dir, stdio: 'pipe' });
    execSync(cp.child_advance, { cwd: dir, stdio: 'pipe' });
    const done = runCliJson(cp.report_completed.replace(/^node "[^"]+" --json /, ''), dir);
    expect(done.status).toBe('completed');
    expect(done.outputs.result).toBe(PAYLOAD);   // 子实例 s → out → 父 result 往返逐字节不变
  });

  it('反例：命令串里不出现任何参数原文——数据只在 cmd_args 文件里,文件放父实例目录（不进子实例目录,躲 re-init 净室）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-cmdargs-'));
    writeFileSync(join(dir, 'caller.md'), CALLER);
    writeFileSync(join(dir, 'echo.md'), CALLEE);
    writeFileSync(join(dir, 'params.json'), JSON.stringify({ src: PAYLOAD }));
    const run = runCliJson(`run caller.md --params @params.json --state-dir state`, dir);
    const cmd = run.call_protocol.init_command;
    expect(cmd).not.toContain('INJECTED');
    expect(cmd).not.toContain('hop_python');
    const m = /--params "@([^"]+)"/.exec(cmd);
    expect(m).not.toBeNull();
    expect(m![1].startsWith('/')).toBe(true);
    expect(m![1].endsWith(join('state', run.instance_id, 'cmd_args', 'calls-1.params.json'))).toBe(true);
    expect(JSON.parse(readFileSync(m![1], 'utf-8'))).toMatchObject({ s: PAYLOAD });
    expect(m![1]).not.toContain(join(run.instance_id, 'calls'));
  });

  it('正例：init --upstream-feedback @file 读文件原文（引擎烘焙的反馈形态）;反例：不带 @ 仍按字面文本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-cmdargs-fb-'));
    writeFileSync(join(dir, 'echo.md'), CALLEE);
    writeFileSync(join(dir, 'fb.txt'), PAYLOAD);
    const a = runCliJson(`init echo.md --params '{"s":"x"}' --upstream-feedback @fb.txt --state-dir state`, dir);
    const stA = JSON.parse(readFileSync(join(dir, 'state', a.instance_id, 'state.json'), 'utf-8'));
    expect(stA.upstream_feedback).toBe(PAYLOAD);
    const b = runCliJson(`init echo.md --params '{"s":"x"}' --upstream-feedback "LITERAL_FB" --state-dir state2`, dir);
    const stB = JSON.parse(readFileSync(join(dir, 'state2', b.instance_id, 'state.json'), 'utf-8'));
    expect(stB.upstream_feedback).toBe('LITERAL_FB');
  });
});

// @v: anc-exec-call-child-iter-id — hopissues/0098 事故形态真进程重放:loop 两轮串行 call,每轮子实例
// 把产出写进自己的 work_zone、父层只收路径（同 hopbuild2 child_frag_path）。旧形态两轮共用 calls/<步骤号>/,
// 第 2 轮 init 的 re-init 净室整目录删除,第 1 轮登记的路径悬空;修后各轮独立目录,两个路径都读得到。
describe('loop 里的串行 call 子实例按轮次命名（0098 真进程重放）', () => {
  const CALLER = `# Caller
Id: caller-0098

## Goal
逐段拆

## Inputs
- segs: [text]  # 段

## Outputs
- paths: [text]  # 各段产出文件路径

## Steps
1. [loop for-each seg in segs, collect p into paths] 逐段
  + → paths: [text]  # 收集
  1.1. [call frag(s: seg)] 拆一段
    + → p: frag_path  # 只收路径不收内容
`;
  const CALLEE = `# Frag
Id: frag

## Goal
写片段

## Inputs
- s: text  # 段

## Outputs
- frag_path: text  # 片段文件路径

## Steps
1. [act] 写片段
  - ← s
  + → frag_path: text  # 路径
  > 纯计算
  > \`\`\`hop_python
  > frag_path = work_zone_path("fragment.md")
  > w = write(path: frag_path, content: s)
  > \`\`\`
`;
  it('正例：两轮各落 calls/1.1.1 与 calls/1.1.2,第 1 轮的片段文件在第 2 轮 init 后仍在,内容各是各的', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-0098-'));
    writeFileSync(join(dir, 'caller.md'), CALLER);
    writeFileSync(join(dir, 'frag.md'), CALLEE);
    const { execSync } = require('node:child_process');
    let resp = runCliJson(`run caller.md --params '{"segs": ["SEG_A", "SEG_B"]}' --state-dir state`, dir);
    const ids: string[] = [];
    for (let k = 0; k < 2; k++) {
      expect(resp.step_type).toBe('call');
      const cp = resp.call_protocol;
      ids.push(cp.child_instance);
      execSync(cp.init_command, { cwd: dir, stdio: 'pipe' });
      execSync(cp.child_advance, { cwd: dir, stdio: 'pipe' });
      resp = runCliJson(cp.report_completed.replace(/^node "[^"]+" --json /, ''), dir);
    }
    expect(ids).toEqual(['1.1.1', '1.1.2']);
    expect(resp.status).toBe('completed');
    const paths: string[] = resp.outputs.paths;
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain(join('calls', '1.1.1', 'work_zone'));
    expect(paths[1]).toContain(join('calls', '1.1.2', 'work_zone'));
    expect(readFileSync(paths[0], 'utf-8')).toBe('SEG_A');   // 修前:ENOENT（第 2 轮 init 删了 calls/1.1/）
    expect(readFileSync(paths[1], 'utf-8')).toBe('SEG_B');
  });

  it('反例：旧驱动手拼 init 不带 --child-instance → 子实例 ID 回退 --step,目录仍是 calls/<步骤号>/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-0098b-'));
    writeFileSync(join(dir, 'caller.md'), CALLER);
    writeFileSync(join(dir, 'frag.md'), CALLEE);
    const run = runCliJson(`run caller.md --params '{"segs": ["SEG_A"]}' --state-dir state`, dir);
    const init = runCliJson(`init frag.md --parent ${run.instance_id} --step 1.1 --params '{"s":"x"}' --state-dir state`, dir);
    expect(init.instance_id).toBe('1.1');
    expect(existsSync(join(dir, 'state', run.instance_id, 'calls', '1.1', 'state.json'))).toBe(true);
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

  it('正例：env 设成空串视同未设 → flag minimal 生效（与 MCP 驱动工具同一规则,prompt-assembler ^anc-exec-context-mode）', () => {
    process.env[KEY] = '';
    expect(resolveContextMode('minimal')).toBe('minimal');
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
    const r = runCliJson(`setup --dir ${dir}/sk`, dir);
    expect(r.installed.some((i: string) => i.includes('hopfix/'))).toBe(true);
    expect(existsSync(join(dir, 'sk', 'hopfix', 'SKILL.md'))).toBe(true);
    const flow = readFileSync(join(dir, 'sk', 'hopfix', 'hopfix.md'), 'utf-8');
    expect(flow).toContain('版本迁移对照');
    expect(flow).toContain('B2 commit 步未知函数升 error');
  });

  it('正例：Codex 载体同装（两载体清单对等）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-inst-hf2-'));
    runCliJson(`setup --carrier codex --dir ${dir}/sk`, dir);
    expect(existsSync(join(dir, 'sk', 'hopfix', 'hopfix.md'))).toBe(true);
  });
});

// hopbuild2 主流程步骤 1 入口（设计 hopbuild2.md D103,hopissues 0107/0109）:
// ①起跑参数给了形态合格且文件在场的路径 → 1.1 机械判定后直接采用,不停在 ask 问人（0107 实撞:ask 恒暂停,
//   说明文字写"已给且存在时不必问"管不住引擎）;形态不合格（绝对路径）→ 照常停在 1.2.2.1 问人;
// ②入口协议恒传 target_profile 空串——语言层顶层 Inputs 全必填,省略即起跑被拒（0109 实撞）,本例锁住这条规则,
//   SKILL.md 命令模板若删掉这个键,用户照模板起跑就会撞上。 // @v: anc-build-main-flow
describe('hopbuild2 主流程步骤 1 入口路径与参数协议', () => {
  const HB2_SPEC = join(PROJECT_ROOT, 'skills', 'hopbuild2', 'spec.md');
  function ws(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-hb2-entry-'));
    writeFileSync(join(dir, 'valid-skill.md'), '# 示例 skill\n\n1. 读输入\n2. 写报告\n');
    return dir;
  }

  it('正例：给在场的相对路径 → 不停在问路径的 ask,直接走到后续步骤', () => {
    const dir = ws();
    const r = runCliJson(`run "${HB2_SPEC}" --state-dir st --params '{"input_skill_path":"valid-skill.md","max_depth":3,"target_profile":""}'`, dir);
    // 1.1 预判、1.2.1.1 采用、1.3 体检、1.4 分型、1.5.2.1 放行、2.1 读本体都是引擎直执的 body,
    // 第一个要交给执行者的步骤是 2.2（扫包内引用）
    expect(r.status).toBe('step_ready');
    expect(r.step_id).toBe('2.2');
    expect(r.pause_reason).toBeUndefined();
  });

  it('反例：给绝对路径 → 形态不合格,停在 1.2.2.1 问人', () => {
    const dir = ws();
    const r = runCliJson(`run "${HB2_SPEC}" --state-dir st --params '{"input_skill_path":"${join(dir, 'valid-skill.md')}","max_depth":3,"target_profile":""}'`, dir);
    expect(r.status).toBe('paused');
    expect(r.step_id).toBe('1.2.2.1');
    expect(r.pause_reason).toBe('ask');
  });

  it('反例：路径形态合格但文件不在 → 停在 1.2.2.1 问人', () => {
    const dir = ws();
    const r = runCliJson(`run "${HB2_SPEC}" --state-dir st --params '{"input_skill_path":"no-such.md","max_depth":3,"target_profile":""}'`, dir);
    expect(r.status).toBe('paused');
    expect(r.step_id).toBe('1.2.2.1');
    expect(r.pause_reason).toBe('ask');
  });

  it('反例：省略 target_profile 键 → 起跑被拒（INIT_FAILED）,所以 SKILL.md 命令模板必须恒带空串', () => {
    const dir = ws();
    const { stdout } = runCli(`run "${HB2_SPEC}" --state-dir st --params '{"input_skill_path":"valid-skill.md","max_depth":3}'`, dir);
    expect(stdout).toContain('INIT_FAILED');
    expect(stdout).toContain('target_profile');
    const skill = readFileSync(join(PROJECT_ROOT, 'skills', 'hopbuild2', 'SKILL.md'), 'utf-8');
    expect(skill).toMatch(/--params '\{[^}]*"target_profile": ""[^}]*\}'/);
  });
});

// ===== 复用模式起跑依赖核（0142 子卡 B）=====
// 顶层 run / init 起跑前核 Tools 段工具与静态 call 目标;子 worker（--call-parent / --parent / --parallel-*）不再核。
// HOME 用临时目录（HopAnt 装在 <HOME>/.hopjit/ants 下）,HOPJIT_CONFIG 剥掉,不碰真实用户目录。
// @v: anc-cli-run-deps-gate
describe('复用模式起跑依赖核（run / init 顶层闸）', () => {
  function cli(home: string, cwd: string, args: string[]): { status: number; json: any; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, HOPJIT_ANTHROPIC_API_KEY: '' };
    delete env.HOPJIT_CONFIG;
    const r = spawnSync('node', [CLI, '--json', ...args], { cwd, env, encoding: 'utf-8', timeout: 10000 });
    let json: any = null;
    try { json = JSON.parse(r.stdout); } catch { /* 留 null,断言里看 stdout */ }
    return { status: r.status ?? 1, json, stderr: r.stderr };
  }
  const CALLER = (callee: string) => `# Spec: 调用方
Id: caller

## Goal
调子流程

## Outputs
- out: text  # 结果

## Steps
1. [call ${callee}(q: "x")] 调
  + → out: r  # 收取
`;
  const CALLEE = (id: string, tools = '') => `# Spec: ${id}
Id: ${id}

## Goal
子流程
${tools}
## Inputs
- q: text  # 词

## Outputs
- r: text  # 结果

## Steps
1. [act] 回显
  - ← q
  + → r: text  # 结果
  > \`\`\`hop_python
  > r = q
  > \`\`\`
`;
  const UNREG_TOOLS = '\n## Tools\n- nowhere_tool(q) -> v % text  # 本机没注册\n  - q % text  # 词\n';

  it('反例：run 时 call 目标找不到 → INIT_FAILED 带 missing_calls 与 hint,退出码 0,不建实例目录', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-gate-home-')); const dir = mkdtempSync(join(tmpdir(), 'cli-gate-'));
    writeFileSync(join(dir, 'caller.md'), CALLER('ghost-ant'));
    const r = cli(home, dir, ['run', 'caller.md', '--state-dir', 'state']);
    expect(r.status).toBe(0);
    expect(r.json.status).toBe('error');
    expect(r.json.error_code).toBe('INIT_FAILED');
    expect(r.json.errors[0]).toMatchObject({ kind: 'validate', rule: 'INIT_FAILED', severity: 'error' });
    expect(r.json.missing_calls).toEqual(['caller 步骤 1: ghost-ant']);
    expect(r.json.hints.some((h: string) => h.includes('/hop 安装'))).toBe(true);
    expect(existsSync(join(dir, 'state')) ? readdirSync(join(dir, 'state')) : []).toEqual([]);
  });

  it('反例：init 时 Tools 段工具没注册（含 call 树里的子 spec）→ INIT_FAILED 带 missing_tools', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-gate-home-')); const dir = mkdtempSync(join(tmpdir(), 'cli-gate-'));
    writeFileSync(join(dir, 'caller.md'), CALLER('sub'));
    writeFileSync(join(dir, 'sub.md'), CALLEE('sub', UNREG_TOOLS));
    const r = cli(home, dir, ['init', 'caller.md', '--state-dir', 'state']);
    expect(r.json.status).toBe('error');
    expect(r.json.missing_tools).toEqual(['sub: nowhere_tool']);
    expect(r.json.message).toContain('工具没有注册 sub: nowhere_tool');
  });

  // @v: anc-config-reuse-consume, anc-cli-workspace-arg
  it('正例（review 面二 A）：`run --workspace WS` 从别的目录起跑,WS/hopjit.yaml 注册的 in-process 工具过依赖核且 act body 能调到（修前依赖核与工具工厂都读进程 cwd → INIT_FAILED）', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-ws-home-'));
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cli-ws-')));
    const elsewhere = mkdtempSync(join(tmpdir(), 'cli-elsewhere-'));
    writeFileSync(join(ws, 'echo-tools.mjs'), 'export async function execute(name, args) { return { success: true, result: "ws:" + args.q, content_type: "text" }; }\n');
    writeFileSync(join(ws, 'hopjit.yaml'), 'tool_servers:\n  - name: wsprobe\n    binding: {kind: in-process, module: ./echo-tools.mjs}\n    tools:\n      - name: ws_echo\n        description: 回显\n        input_schema: {type: object, properties: {q: {type: string}}, required: [q]}\n        requires_commit: false\n');
    writeFileSync(join(ws, 'spec.md'), `# Spec: ws-tool
Id: ws-tool

## Goal
调工作区注册的工具

## Tools
- ws_echo(q) -> v % text  # 回显
  - q % text  # 词

## Outputs
- out: text  # 结果

## Steps
1. [act] 调
  + → out: text  # 结果
  > \`\`\`hop_python
  > out = ws_echo(q: "hi")
  > \`\`\`
`);
    const r = cli(home, elsewhere, ['run', join(ws, 'spec.md'), '--workspace', ws, '--state-dir', join(ws, 'state')]);
    expect(r.json?.status, JSON.stringify(r.json) + r.stderr).not.toBe('error');   // 变异：runDepsGate 改回 adaptConfigPaths(process.cwd()) → INIT_FAILED missing_tools 红
    expect(r.json?.status).toBe('completed');
    expect(r.json?.outputs?.out).toBe('ws:hi');   // 变异：工具工厂改回 process.cwd() → UNKNOWN_TOOL 失败红
  });

  // @v: anc-exec-callee-resolver, anc-hopant-run-deps —— 项目级 HopAnt 根取自 --workspace（HostConfig.workspace_dir）,不是进程 cwd：
  // 依赖核与 callee 路径烘焙两处都要用对根（变异 M16：注册闭包改 antRoots(homedir(), process.cwd()) → 依赖核过了但 init_command 留占位,红;
  // 变异 M21：runDepsGate 改 antRoots(homedir(), '/nonexistent-mut') → INIT_FAILED missing_calls,红）
  it('正例：`run --workspace WS`（WS ≠ 进程 cwd）调只装在 WS/hop_tasks/ants/ 的 HopAnt → 过依赖核,init_command 填 WS/hop_tasks/ants/foo/foo.md 真实路径', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-gate-home-'));   // 空假 HOME：用户级没有 foo
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cli-ws-ant-')));
    const elsewhere = mkdtempSync(join(tmpdir(), 'cli-elsewhere-'));   // 进程 cwd 在别处,且它下面没有 hop_tasks/
    const fooDir = join(ws, 'hop_tasks', 'ants', 'foo');
    mkdirSync(fooDir, { recursive: true });
    writeFileSync(join(fooDir, 'foo.md'), CALLEE('foo'));
    writeFileSync(join(ws, 'caller.md'), CALLER('foo'));
    const r = cli(home, elsewhere, ['run', join(ws, 'caller.md'), '--workspace', ws, '--state-dir', join(ws, 'state')]);
    expect(r.json?.status, JSON.stringify(r.json) + r.stderr).not.toBe('error');   // 依赖核按 WS 的项目级根找到 foo
    expect(r.json?.status).toBe('step_ready');
    const cp = r.json.call_protocol;
    expect(cp.init_command).toContain(`init "${join(fooDir, 'foo.md')}"`);   // 真实路径,不是 <CALLEE_SPEC_PATH:foo> 占位
    expect(cp.init_command).not.toContain('<CALLEE_SPEC_PATH:foo>');
  });

  it('正例：call 已装 HopAnt → 起跑通过,init_command 填的是 <HOME>/.hopjit/ants/<id>/<id>.md,照抄执行子实例跑完', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-gate-home-')); const dir = mkdtempSync(join(tmpdir(), 'cli-gate-'));
    const antDirPath = join(home, '.hopjit', 'ants', 'helper-ant');
    mkdirSync(antDirPath, { recursive: true });
    writeFileSync(join(antDirPath, 'helper-ant.md'), CALLEE('helper-ant'));
    writeFileSync(join(dir, 'caller.md'), CALLER('helper-ant'));
    const r = cli(home, dir, ['run', 'caller.md', '--state-dir', 'state']);
    expect(r.json.status, JSON.stringify(r.json)).toBe('step_ready');
    const cp = r.json.call_protocol;
    expect(cp.init_command).toContain(`init "${join(antDirPath, 'helper-ant.md')}"`);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.HOPJIT_CONFIG;
    execSync(cp.init_command, { cwd: dir, stdio: 'pipe', env });
    execSync(cp.child_advance, { cwd: dir, stdio: 'pipe', env });
    const done = cli(home, dir, cp.report_completed.replace(/^node "[^"]+" --json /, '').match(/"[^"]*"|\S+/g)!.map((t: string) => t.replace(/^"|"$/g, '')));
    expect(done.json.status).toBe('completed');
    expect(done.json.outputs.out).toBe('x');
  });

  it('正例：子 worker 不再核——父起跑后子 spec 改成依赖未注册工具,照抄 init_command 子实例照常建立', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-gate-home-')); const dir = mkdtempSync(join(tmpdir(), 'cli-gate-'));
    writeFileSync(join(dir, 'caller.md'), CALLER('sub'));
    writeFileSync(join(dir, 'sub.md'), CALLEE('sub'));
    const r = cli(home, dir, ['run', 'caller.md', '--state-dir', 'state']);
    expect(r.json.status).toBe('step_ready');
    writeFileSync(join(dir, 'sub.md'), CALLEE('sub', UNREG_TOOLS));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.HOPJIT_CONFIG;
    const out = execSync(r.json.call_protocol.init_command, { cwd: dir, encoding: 'utf-8', env });
    expect(out).not.toContain('依赖核');
    expect(JSON.parse(out).status).toBe('ok');
  });
});

// setup 的 MCP 握手自检（todo/0146）：真起 server 走 initialize → tools/list → server_status。
// @v: anc-cli-install-skill-handshake
describe('mcpHandshake', () => {
  const SERVER = join(PROJECT_ROOT, 'dist', 'mcp-server.js');
  it('正例：server 起得来且 command 在 PATH 上 → ok,带工具清单与独立模式状态', () => {
    const bin = mkdtempSync(join(tmpdir(), 'hs-bin-'));
    writeFileSync(join(bin, 'hopjit-mcp'), '');
    const h = mcpHandshake(process.execPath, SERVER, 'hopjit-mcp', bin);
    expect(h.ok).toBe(true);
    expect(h.tools).toContain('run');
    expect(h.tools).toContain('server_status');
    expect(typeof h.standalone_available).toBe('boolean');
    if (h.standalone_available === false) expect(h.fix).toBeTruthy();   // 不可用必带修法
  });
  it('反例：command 不在 PATH 上 → ok=false,修法给出绝对路径注册形态', () => {
    const h = mcpHandshake(process.execPath, SERVER, 'hopjit-mcp-nope', mkdtempSync(join(tmpdir(), 'hs-empty-')));
    expect(h.ok).toBe(false);
    expect(h.reason).toContain('PATH');
    expect(h.fix).toContain(SERVER);
  });
  it('反例：包内 server 文件缺失 → ok=false 报路径', () => {
    const h = mcpHandshake(process.execPath, join(tmpdir(), 'no-such-mcp-server.js'), 'x', '');
    expect(h.ok).toBe(false);
    expect(h.reason).toContain('不存在');
    expect(h.reason).toContain('no-such-mcp-server.js');
  });
  it('反例：server 起来后立即退出 → ok=false,reason 带退出码', () => {
    const js = join(mkdtempSync(join(tmpdir(), 'hs-exit-')), 'exit3.js');
    writeFileSync(js, 'process.exit(3);\n');
    const h = mcpHandshake(process.execPath, js, 'x', '');
    expect(h.ok).toBe(false);
    expect(h.reason).toContain('exit 3');
  });
});

// CLI 的 commit 批准入口（todo/0146）：CI / 脚本 / MCP 回退时不卡死。
// @v: anc-cli-approve-commit, anc-cli-commit-approve-response
describe('approve_commit 子命令', () => {
  it('正例：run→check final→commit 停点→approve_commit→resume 执行;反例：错哈希与非 commit 步骤被拒', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-approve-'));
    writeFileSync(join(dir, 'g.md'), `# 批准
Id: cli-approve

## Goal
g

## Outputs
- out: line  # 交付

## Steps
1. [subtask] 把关
  + → ok: bool
  1.1. [check final] 核对
    + → ok: bool  # 判定
    + → note: text  # 说明
    > pass
2. [commit] 交付
  + → out: line
  > 不留旧版本地写一份文件再赋值
  > \`\`\`hop_python
  > w = write(path: "o.txt", content: "x", keep: 0)
  > out = "cli"
  > \`\`\`
`);
    const r = runCliJson('run g.md --state-dir st', dir);
    const id = r.instance_id;
    writeFileSync(join(dir, 'o.json'), '{"ok": true, "note": ""}');
    const p = runCliJson(`submit_and_fetch_next 1.1 --output '{"ok": true, "note": ""}' --state-dir st --instance ${id}`, dir);
    expect(p.pause_reason).toBe('commit');
    // 三条拒绝都是业务错误:stdout 出 JSON、退出码 0（hop-cli.md approveCommitCommand 第 4 行,与 resume 等命令同一规则）
    // 带 body 的 commit 不接受递交产出
    const sub = runCli(`submit_and_fetch_next 2 --output '{"out": "forged"}' --state-dir st --instance ${id}`, dir);
    expect(sub.exitCode).toBe(0);
    expect(JSON.parse(sub.stdout)).toMatchObject({ status: 'error', code: 'COMMIT_BODY_ENGINE_ONLY' });
    const wrong = runCli(`approve_commit 2 --fingerprint deadbeef --scope once --state-dir st --instance ${id}`, dir);
    expect(wrong.exitCode).toBe(0);
    expect(JSON.parse(wrong.stdout)).toMatchObject({ status: 'error', code: 'COMMIT_NOT_APPROVED' });
    const notCommit = runCli(`approve_commit 1.1 --fingerprint ${p.presented_data.context.fingerprint} --scope once --state-dir st --instance ${id}`, dir);
    expect(notCommit.exitCode).toBe(0);
    expect(JSON.parse(notCommit.stdout)).toMatchObject({ status: 'error', code: 'INVALID_STATE' });
    // 缺 --scope 是参数错误(commander 必填项):退出码非 0,不记账
    const noScope = runCli(`approve_commit 2 --fingerprint ${p.presented_data.context.fingerprint} --state-dir st --instance ${id}`, dir);
    expect(noScope.exitCode).not.toBe(0);
    expect(noScope.stderr).toContain('--scope');
    // 停下时账里只有一条 referred（防重复分析）;三次拒绝都没写进 approved 记录
    const approvals = () => JSON.parse(readFileSync(join(dir, 'st', 'commit_approvals.json'), 'utf-8')) as { outcome: string }[];
    expect(approvals().map(r => r.outcome)).toEqual(['referred']);
    // 拒绝之后账面不动:仍停在同一个批准点
    expect(runCliJson(`status --state-dir st --instance ${id}`, dir).execution_status).toBe('paused');
    const done = approveAndResume(dir, 'st', id, p);
    expect(done.status).toBe('completed');
    expect(done.outputs.out).toBe('cli');
    expect(approvals().map(r => r.outcome)).toEqual(['referred', 'approved']);
  });

  // @v: anc-cli-approve-commit, anc-cli-workspace-arg
  it('--workspace：cwd 不是工作区时按 --workspace 定位 state-dir 批准成功;显式工作区不存在 → WORKSPACE_NOT_FOUND,退出码 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-approve-ws-'));
    writeFileSync(join(dir, 'g.md'), `# 批准
Id: cli-approve-ws

## Goal
g

## Outputs
- out: line  # 交付

## Steps
1. [confirm] 审批
  + → approval: bool  # 审批
2. [commit] 交付
  + → out: line
  > 不留旧版本地写一份文件再赋值
  > \`\`\`hop_python
  > w = write(path: "o.txt", content: "x", keep: 0)
  > out = "ws"
  > \`\`\`
`);
    const id = runCliJson('run g.md --state-dir st', dir).instance_id;
    const p = runCliJson(`submit_and_fetch_next 1 --answer '{"value":"approve"}' --state-dir st --instance ${id}`, dir);
    expect(p.pause_reason).toBe('commit');
    const elsewhere = mkdtempSync(join(tmpdir(), 'cli-approve-cwd-'));
    const ok = runCliJson(`approve_commit 2 --fingerprint ${p.presented_data.context.fingerprint} --scope once --workspace ${dir} --state-dir st --instance ${id}`, elsewhere);
    expect(ok.status).toBe('ok');
    expect(existsSync(join(dir, 'st', 'commit_approvals.json'))).toBe(true);
    expect(existsSync(join(elsewhere, 'st'))).toBe(false);
    const ghost = runCli(`approve_commit 2 --fingerprint x --scope once --workspace ${join(dir, 'nope')} --state-dir st --instance ${id}`, elsewhere);
    expect(ghost.exitCode).toBe(1);
    expect(ghost.stderr).toContain('WORKSPACE_NOT_FOUND');
  });
});

// @v: anc-cli-workspace-arg —— run/init 的 --workspace 显式工作区根（2026-10-07 作者问"复用模式下的 cwd 是哪儿来的？
// 在 CC 下用户没有显性的 cwd 感知"）：缺省仍 cwd、显式值进 state.json 与 hoplog 头与响应、不存在即拒、相对路径绝对化、
// 项目级 hopjit.yaml 随工作区定位、子实例启动命令恒带父值。
describe('--workspace 显式工作区根（^anc-cli-workspace-arg）', () => {
  const PARENT_PAR_SPEC = `# WS Par
Id: ws-par

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
  function mkProj(): { cwdDir: string; proj: string; specFile: string } {
    const cwdDir = mkdtempSync(join(tmpdir(), 'ws-cwd-'));
    const proj = mkdtempSync(join(tmpdir(), 'ws-proj-'));
    writeFileSync(join(cwdDir, 'spec.md'), SIMPLE_SPEC);
    return { cwdDir, proj, specFile: join(cwdDir, 'spec.md') };
  }
  const realDir = (d: string) => realpathSync(d);

  it('正例：run --workspace <绝对路径> → 响应回显 workspace_dir、state.json host_context.workspace_dir、hoplog 头 workspace_dir: 三处同值且等于显式值（不是 cwd）', () => {
    const { cwdDir, proj, specFile } = mkProj();
    const r = runCliJson(`run "${specFile}" --workspace "${proj}" --state-dir .hopstate`, cwdDir);
    expect(r.status).toBe('step_ready');
    expect(r.workspace_dir).toBe(proj);
    expect(r.workspace_dir).not.toBe(cwdDir);
    const st = JSON.parse(readFileSync(join(cwdDir, '.hopstate', r.instance_id, 'state.json'), 'utf-8'));
    expect(st.host_context.workspace_dir).toBe(proj);
    expect(st.host_context.sandbox.filesystem.workspace_dir).toBe(proj);   // 两处同值（58a3c061 约束）
    const runDirs = readdirSync(join(cwdDir, '.hoplog'));
    const head = readFileSync(join(cwdDir, '.hoplog', runDirs[0], 'main.yaml'), 'utf-8');
    const lines = head.split('\n');
    const iStarted = lines.findIndex(l => l.startsWith('started_at:'));
    const iWs = lines.findIndex(l => l.startsWith('workspace_dir:'));
    expect(iWs).toBe(iStarted + 1);   // 紧随 started_at
    expect(lines[iWs]).toContain(proj);
    expect(head.indexOf('workspace_dir:')).toBeLessThan(head.indexOf('execution:'));
  });

  it('正例：不传 --workspace → 行为与改前一致,workspace_dir 等于进程 cwd（响应与 state 同值）', () => {
    const { cwdDir, specFile } = mkProj();
    const r = runCliJson(`run "${specFile}" --state-dir .hopstate`, cwdDir);
    expect(r.status).toBe('step_ready');
    expect(realDir(r.workspace_dir)).toBe(realDir(cwdDir));
    const st = JSON.parse(readFileSync(join(cwdDir, '.hopstate', r.instance_id, 'state.json'), 'utf-8'));
    expect(st.host_context.workspace_dir).toBe(r.workspace_dir);
  });

  it('反例：--workspace 指向不存在的目录 → WORKSPACE_NOT_FOUND 非零退出,不建实例、不写状态目录', () => {
    const { cwdDir, specFile } = mkProj();
    const r = runCli(`run "${specFile}" --workspace "${join(cwdDir, 'no-such-dir')}" --state-dir .hopstate`, cwdDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('WORKSPACE_NOT_FOUND');
    expect(r.stdout + r.stderr).toContain('不做搜索');
    expect(existsSync(join(cwdDir, '.hopstate'))).toBe(false);
  });

  it('反例：--workspace 指向一个文件（存在但不是目录）→ 同样 WORKSPACE_NOT_FOUND', () => {
    const { cwdDir, specFile } = mkProj();
    const r = runCli(`run "${specFile}" --workspace "${specFile}" --state-dir .hopstate`, cwdDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('WORKSPACE_NOT_FOUND');
  });

  it('正例：--workspace 相对路径按 cwd 解析并绝对化（state.json 里是绝对路径）', () => {
    const { cwdDir, specFile } = mkProj();
    mkdirSync(join(cwdDir, 'sub', 'proj'), { recursive: true });
    const r = runCliJson(`run "${specFile}" --workspace sub/proj --state-dir .hopstate`, cwdDir);
    expect(r.status).toBe('step_ready');
    // 相对值按子进程 cwd（已是 realpath——macOS /tmp→/private/tmp）解析,比较两边都取真实路径
    expect(realDir(r.workspace_dir)).toBe(realDir(join(cwdDir, 'sub', 'proj')));
    expect(r.workspace_dir.startsWith('/')).toBe(true);
    const st = JSON.parse(readFileSync(join(cwdDir, '.hopstate', r.instance_id, 'state.json'), 'utf-8'));
    expect(st.host_context.workspace_dir).toBe(r.workspace_dir);
  });

  it('正例：init --workspace 同款——state.json 工作区等于显式值', () => {
    const { cwdDir, proj, specFile } = mkProj();
    const r = runCliJson(`init "${specFile}" --workspace "${proj}" --state-dir .hopstate`, cwdDir);
    expect(r.status).toBe('ok');
    const st = JSON.parse(readFileSync(join(cwdDir, '.hopstate', r.instance_id, 'state.json'), 'utf-8'));
    expect(st.host_context.workspace_dir).toBe(proj);
  });

  it('正例：项目级 hopjit.yaml 随工作区定位——cwd 下的 language: zh 不生效,--workspace 目录下的 commands 生效', () => {
    const { cwdDir, proj, specFile } = mkProj();
    writeFileSync(join(cwdDir, 'hopjit.yaml'), 'language: zh\n');
    writeFileSync(join(proj, 'hopjit.yaml'), 'commands:\n  - echo\n');
    // --workspace 目录下没写 language 键 → 缺省跟随系统语言（todo/0160）;本例要证的是 cwd 下的 zh 没被读到,
    // 所以把子进程的系统语言钉成英文,断 en 才有分辨力（本机 LANG=zh_CN 时不钉会与 cwd 的 zh 撞值）
    const saved = { LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES, LANG: process.env.LANG };
    let r: any;
    try {
      delete process.env.LC_ALL; delete process.env.LC_MESSAGES; process.env.LANG = 'en_US.UTF-8';
      r = runCliJson(`run "${specFile}" --workspace "${proj}" --state-dir .hopstate`, cwdDir);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    const st = JSON.parse(readFileSync(join(cwdDir, '.hopstate', r.instance_id, 'state.json'), 'utf-8'));
    expect(st.host_context.sandbox.runtime.available).toEqual(['echo']);
    expect(st.host_context.hop_env?.hop_env_language ?? 'en').toBe('en');
  });

  it('正例：parallel worker 的 launch_command 恒带 --workspace "<父 workspace_dir>"（子进程 cwd 由 driver 的 Bash 决定,不带即父子分叉）', () => {
    const { cwdDir, proj } = mkProj();
    writeFileSync(join(cwdDir, 'par.md'), PARENT_PAR_SPEC);
    const r = runCliJson(`run "${join(cwdDir, 'par.md')}" --workspace "${proj}" --params '{"nums":[3]}' --state-dir .hopstate`, cwdDir);
    expect(r.status).toBe('dispatch_ready');
    expect(r.launch_command).toContain(`--workspace "${proj}"`);
    expect(r.workspace_dir).toBe(proj);   // 派发项并列回显
  });

  it('单元：resolveWorkspaceArg——缺席返 cwd / 绝对 normalize / 相对按 cwd 解析（纯函数面,子进程用例之外的快判）', () => {
    const d = mkdtempSync(join(tmpdir(), 'ws-unit-'));
    expect(resolveWorkspaceArg(undefined, d)).toBe(d);
    expect(resolveWorkspaceArg(d + '/./', d)).toBe(d + '/');
    mkdirSync(join(d, 'x'));
    expect(resolveWorkspaceArg('x', d)).toBe(join(d, 'x'));
  });
});

// @v: anc-cli-approve-dirs —— Config.dirs 的 CLI 面：run 停 paused/dirs → approve_dirs → resume;--approve-dirs 跳停点且账在;哈希不符拒;独立于 commit 账文件
describe('Config.dirs 批准停点的 CLI 入口（^anc-cli-approve-dirs,todo/0148）', () => {
  const DIRS_SPEC = (rw: string) => `# DirsCli
Id: dirs-cli

## Goal
G

## Inputs
- out % line  # 报告目录

## Outputs
- r % line  # r

## Config
dirs:
  readwrite: ["{out}"]

## Steps
1. [reason] a
  + → r % line  # r
`;
  function mkProj() {
    const dir = mkdtempSync(join(tmpdir(), 'dirs-cli-'));
    const rw = mkdtempSync(join(tmpdir(), 'dirs-cli-rw-'));
    writeFileSync(join(dir, 'spec.md'), DIRS_SPEC(rw));
    return { dir, rw };
  }

  it('正例：run → paused/dirs（context.dirs 列 readwrite 条目、dirs_hash 在场）→ approve_dirs → resume 到 step_ready;账落 .hopstate/dirs_approvals.json,与 commit_approvals.json 分文件', () => {
    const { dir, rw } = mkProj();
    const p = runCliJson(`run spec.md --params '{"out":"${rw}"}' --state-dir .hopstate`, dir);
    expect(p.status).toBe('paused'); expect(p.pause_reason).toBe('dirs');
    expect(p.presented_data.context.dirs).toEqual([{ path: rw, mode: 'readwrite' }]);
    const hash = p.presented_data.context.dirs_hash; expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const bad = runCli(`approve_dirs deadbeef --state-dir .hopstate --instance ${p.instance_id}`, dir);
    expect(bad.stdout + bad.stderr).toContain('DIRS_NOT_APPROVED');
    const ok = runCliJson(`approve_dirs ${hash} --state-dir .hopstate --instance ${p.instance_id}`, dir);
    expect(ok.status).toBe('ok');
    expect(existsSync(join(dir, '.hopstate', 'dirs_approvals.json'))).toBe(true);
    expect(existsSync(join(dir, '.hopstate', 'commit_approvals.json'))).toBe(false);
    const next = runCliJson(`resume --state-dir .hopstate --instance ${p.instance_id}`, dir);
    expect(next.status).toBe('step_ready');
  });

  // @v: anc-exec-dirs-grant —— status 源⑥ / worker 继承（dirs 批 review 修复）
  it('正例：dirs 停点期间 hopjit status 报 paused/dirs 无 paused_step_id（源⑥）;approve_dirs 后不再 paused', () => {
    const { dir, rw } = mkProj();
    const p = runCliJson(`run spec.md --params '{"out":"${rw}"}' --state-dir .hopstate`, dir);
    expect(p.pause_reason).toBe('dirs');
    const st = runCliJson(`status --state-dir .hopstate --instance ${p.instance_id}`, dir);
    expect(st.execution_status).toBe('paused'); expect(st.pause_reason).toBe('dirs'); expect('paused_step_id' in st).toBe(false);
    runCliJson(`approve_dirs ${p.presented_data.context.dirs_hash} --state-dir .hopstate --instance ${p.instance_id}`, dir);
    expect(runCliJson(`status --state-dir .hopstate --instance ${p.instance_id}`, dir).execution_status).not.toBe('paused');
  });

  it('正例：复用模式 parallel worker 经 launch_command 起跑不重展开——父批过 dirs 后 worker 直达 step_ready（D1：首版 worker 重展开 {out} 缺值 INIT_FAILED）', () => {
    const { dir, rw } = mkProj();
    writeFileSync(join(dir, 'par.md'), `# WS Par Dirs
Id: ws-par-dirs

## Goal
G

## Inputs
- nums % [int]  # 列表
- out % line  # 目录

## Outputs
- outs % [int]  # 收集

## Config
dirs:
  readwrite: ["{out}"]

## Steps
1. [loop for-each n in nums, collect o into outs] 逐项
  + → outs % [int]  # 收集列表
  1.1. [subtask parallel] 处理一项
    + → o % int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o % int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > o = n * 7
      > \`\`\`
2. [exit] 交付
`);
    const r = runCliJson(`run par.md --approve-dirs --params '{"nums":[3],"out":"${rw}"}' --state-dir .hopstate`, dir);
    expect(r.status).toBe('dispatch_ready');
    const w = runCliJson(r.launch_command.replace(/^node "[^"]+" --json /, ''), dir);   // 照引擎拼的命令起 worker
    expect(w.status, JSON.stringify(w).slice(0, 300)).not.toBe('error');
    expect(w.status).not.toBe('paused');
    const wst = JSON.parse(readFileSync(join(dir, '.hopstate', r.instance_id, 'parallel', r.child_instance, 'state.json'), 'utf-8'));
    expect(wst.host_context.sandbox.filesystem.write_access.allowed).toEqual([rw]);   // 继承父的写白名单
    expect('out' in (wst.inputs ?? wst.vars ?? {})).toBe(false);   // 保留键没泄成 Inputs
  });

  it('正例：run --approve-dirs 不停,直接 step_ready,账已记（写参数的人就是批准的人）', () => {
    const { dir, rw } = mkProj();
    const r = runCliJson(`run spec.md --approve-dirs --params '{"out":"${rw}"}' --state-dir .hopstate`, dir);
    expect(r.status).toBe('step_ready');
    const recs = JSON.parse(readFileSync(join(dir, '.hopstate', 'dirs_approvals.json'), 'utf-8'));
    expect(recs).toHaveLength(1); expect(recs[0].dirs_hash).toMatch(/^[0-9a-f]{64}$/); expect(recs[0].spec_path.endsWith('/spec.md')).toBe(true);
  });

  it('正例：init --approve-dirs 同款——之后 resume 直达 step_ready', () => {
    const { dir, rw } = mkProj();
    const i = runCliJson(`init spec.md --approve-dirs --params '{"out":"${rw}"}' --state-dir .hopstate`, dir);
    expect(i.status).toBe('ok');
    expect(runCliJson(`resume --state-dir .hopstate --instance ${i.instance_id}`, dir).status).toBe('step_ready');
  });

  it('反例：Inputs 传的目录不存在 → run 直接 INIT_FAILED,不建实例', () => {
    const { dir } = mkProj();
    const r = runCliJson(`run spec.md --params '{"out":"${join(dir, 'no-such')}"}' --state-dir .hopstate`, dir);
    expect(r.status).toBe('error');
    expect(r.errors[0].message).toMatch(/^INIT_FAILED.*目录不存在/);
    expect(existsSync(join(dir, '.hopstate'))).toBe(false);
  });

  it('正例：不声明 dirs 的 spec 行为与改前完全一致——run 直达 step_ready,无 dirs 账文件', () => {
    const { dir, specFile } = setupWorkDir();
    const r = runCliJson(`run ${specFile} --state-dir .hopstate`, dir);
    expect(r.status).toBe('step_ready');
    expect(existsSync(join(dir, '.hopstate', 'dirs_approvals.json'))).toBe(false);
  });
});
