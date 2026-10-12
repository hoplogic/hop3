/**
 * hopjit-mcp run_approved_command——按任务卡《已批准命令》授权在 run 上下文里执行命令（todo/0132,承接 hopissues/0114）。
 * 契约 docs/design/mcp-server.md ^anc-mcp-run-command;账块 ^anc-obs-command-block;并集 ^anc-exec-command-primitive。
 * 夹具不起 LLM:直接用 FilePersistence 落一份 header.approved_commands 的快照（内容寻址形态）+ 含
 * host_context.workspace_dir 与 hoplog_run_dir 的 state,再直调 HopjitMcpCore.runCommand。
 */
// @module: mcp-server ^anc-struct-mcp-server
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load as yamlLoad } from 'js-yaml';
import { HopjitMcpCore, RUN_COMMAND_TIMEOUT_DEFAULT_SEC, RUN_COMMAND_TIMEOUT_MAX_SEC, type StandaloneConfig, type ProviderEntry } from '../src/mcp-server.js';
import * as commandExec from '../src/command-exec.js';
import { FilePersistence, readSpec } from '../src/persistence.js';
import { HopLog } from '../src/hoplog.js';
import { unionApprovedCommandNames } from '../src/command-exec.js';
import { ExecutionEngine } from '../src/engine.js';
import { StepDispatcher } from '../src/dispatcher.js';
import type { HostConfig } from '../src/provider-types.js';

const PROVIDER: ProviderEntry = { service_id: 'x', protocol: 'anthropic', base_url: 'https://example.invalid', model: 'm', api_key_env: 'HOPJIT_RUN_CMD_TEST_KEY' };
const CONFIG: StandaloneConfig = { providers: [PROVIDER] };

type Fixture = { ws: string; stateDir: string; iid: string; hoplogDir?: string };

// 落一份带《已批准命令》清单的 run 快照。withHoplog=false 时 state 不带 hoplog_run_dir（模拟 hoplog 关着）。
function makeRun(approved: string[][] | undefined, opts: { withHoplog?: boolean; iid?: string } = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-cmd-')));
  const ws = join(root, 'ws'); mkdirSync(ws);
  const stateDir = join(root, 'state'); mkdirSync(stateDir);
  const iid = opts.iid ?? 'inst-1';
  const spec = { header: { title: 'T', id: 't', ...(approved ? { approved_commands: approved } : {}) }, steps: [{ step_id: '1', type: 'act', summary: 's' }] };
  let hoplogDir: string | undefined;
  if (opts.withHoplog !== false) {
    const log = new HopLog({ specId: 't', logDir: join(root, 'hoplog'), title: 'T' });
    hoplogDir = log.getRunDir();
  }
  const state = {
    format_version: 1, instance_id: iid, spec_id: 't', step_states: {}, current_step: null, retry_counters: {}, loop_counters: {},
    ...(hoplogDir ? { hoplog_run_dir: hoplogDir } : {}),
    host_context: { workspace_dir: ws, sandbox: { filesystem: { workspace_dir: ws, read_access: { allowed: [ws], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } } },
  };
  const p = new FilePersistence(stateDir);
  p.init(iid, spec as never);
  p.saveSnapshot({ spec, state, vars: { format_version: 2, scopes: {} } } as never);
  return { ws, stateDir, iid, hoplogDir };
}

const call = (fx: Fixture, argv: string[], extra: Record<string, unknown> = {}) =>
  new HopjitMcpCore(CONFIG).runCommand({ state_dir: fx.stateDir, instance_id: fx.iid, argv, ...extra }) as Record<string, any>;

// @v: anc-mcp-run-command, anc-obs-command-block
describe('run_approved_command 按任务卡授权', () => {
  const made: string[] = [];
  const track = (fx: Fixture) => { made.push(join(fx.ws, '..')); return fx; };
  afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('正例：卡上批 `python3 -c`,跑 python3 -c print(1) 放行,返回 returncode 0,hoplog 出现 command: 块（argv/cwd/returncode/duration_ms）', () => {
    const fx = track(makeRun([['python3', '-c'], ['echo']]));
    const r = call(fx, ['python3', '-c', 'print(1)'], { caller_step: '2.1' });
    expect(r.error).toBeUndefined();
    expect(r.returncode).toBe(0);
    expect(r.stdout.trim()).toBe('1');
    expect(r.truncated).toEqual({ stdout: false, stderr: false });
    const text = readFileSync(join(fx.hoplogDir!, 'main.yaml'), 'utf-8');
    const doc = yamlLoad(text.slice(text.indexOf('command:'))) as Record<string, any>;
    expect(doc.command.argv).toEqual(['python3', '-c', 'print(1)']);
    expect(doc.command.cwd).toBe(fx.ws);
    expect(doc.command.returncode).toBe(0);
    expect(typeof doc.command.duration_ms).toBe('number');
    expect(doc.command.caller_step).toBe('2.1');
    expect(text.indexOf('resumed_at:')).toBeGreaterThan(-1);   // 先钉在场——indexOf 缺席返回 -1 会让下一行的"小于"恒过（review 面三抓弱断言）
    expect(text.indexOf('resumed_at:')).toBeLessThan(text.indexOf('command:'));   // 跨进程续写先冲 resume marker
  });

  it('反例：curl 不在卡上 → APPROVAL_REQUIRED,报文含"已批准命令"与卡上现有前缀,不含 hopjit.yaml', () => {
    const fx = track(makeRun([['python3', '-c']]));
    const r = call(fx, ['curl', 'https://example.com']);
    expect(r.error.code).toBe('APPROVAL_REQUIRED');
    expect(r.error.message).toContain('已批准命令');
    expect(r.error.message).toContain('python3 -c');
    expect(r.error.message).not.toContain('hopjit.yaml');
    // 报文与 description/skill 同口径：归人决定,不并列'改走 Bash'当修法（review 面二抓）
    expect(r.error.message).toContain('请停下问用户');
    expect(r.error.message).toContain('不要换通道绕过');
    expect(r.error.message).not.toContain('改走载体 Bash 照常授权');
  });

  it('反例：argv 短于前缀（只给 python3）→ 拒;前缀逐项相等不是只比 argv[0]', () => {
    const fx = track(makeRun([['python3', '-c']]));
    expect(call(fx, ['python3']).error.code).toBe('APPROVAL_REQUIRED');
    expect(call(fx, ['python3', '-m', 'http.server']).error.code).toBe('APPROVAL_REQUIRED');
  });

  it('反例：卡上没有《已批准命令》节 → 拒且报文说明节缺席', () => {
    const fx = track(makeRun(undefined));
    const r = call(fx, ['echo', 'x']);
    expect(r.error.code).toBe('APPROVAL_REQUIRED');
    expect(r.error.message).toContain('没有《已批准命令》节');
  });

  it('反例：argv[0]=hopjit 即便清单里有也恒拒（恒拒先于匹配——报文说明写进卡也无效,不教人往卡上加 hopjit 行）', () => {
    const fx = track(makeRun([['hopjit']]));
    const r = call(fx, ['hopjit', 'status']);
    expect(r.error.code).toBe('COMMAND_FAILED');
    expect(r.error.message).toContain('hopjit');
    const r2 = call(track(makeRun([['python3', '-c']])), ['/usr/local/bin/hopjit', 'status']);
    expect(r2.error.code).toBe('COMMAND_FAILED');
    expect(r2.error.message).not.toContain('加一行');
  });

  it('正例（todo/0152 撤闸）：cwd 指向 workspace 之外的临时目录 → 照跑,stdout 是该目录,账里 cwd 字段等于它;workspace 内相对路径仍按 workspace 解析', () => {
    // 2026-10-09 前本例是反例"cwd 越界即拒"（todo/0152 撤的那道闸）。撤闸依据：授权本体是 argv 前缀匹配,cwd 不是授权要素;
    // worktree / $TMPDIR 是正当工作面,原闸逼 agent 绕走载体 Bash 丢授权账。变异：把 isWithinDir 越界判加回 → 本例红
    const fx = track(makeRun([['pwd']]));
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    try {
      const far = call(fx, ['pwd'], { cwd: outside });
      expect(far.error).toBeUndefined();
      expect(far.returncode).toBe(0);
      expect(realpathSync(far.stdout.trim())).toBe(realpathSync(outside));
      const text = readFileSync(join(fx.hoplogDir!, 'main.yaml'), 'utf-8');
      const doc = yamlLoad(text.slice(text.indexOf('command:'))) as Record<string, any>;
      expect(doc.command.cwd).toBe(outside);   // 账如实记实际执行目录,不是 workspace
      mkdirSync(join(fx.ws, 'sub'));
      const ok = call(fx, ['pwd'], { cwd: 'sub' });
      expect(ok.error).toBeUndefined();
      expect(ok.stdout.trim()).toBe(join(fx.ws, 'sub'));
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('反例：超时 → COMMAND_FAILED 报文含超时提示', () => {
    const fx = track(makeRun([['python3', '-c']]));
    const r = call(fx, ['python3', '-c', 'import time;time.sleep(5)'], { timeout_sec: 1 });
    expect(r.error.code).toBe('COMMAND_FAILED');
    expect(r.error.message).toMatch(/超时|ETIMEDOUT/);
  });

  it('stdout 超 64KB：回给调用方截断并注明,truncated.stdout=true,账里 stdout_bytes 记原字节数', () => {
    const fx = track(makeRun([['python3', '-c']]));
    const r = call(fx, ['python3', '-c', 'print("a"*100000)']);
    expect(r.error).toBeUndefined();
    expect(r.truncated.stdout).toBe(true);
    expect(r.stdout).toContain('已截断');
    expect(r.stdout.length).toBeLessThan(100000);
    const text = readFileSync(join(fx.hoplogDir!, 'main.yaml'), 'utf-8');
    const doc = yamlLoad(text.slice(text.indexOf('command:'))) as Record<string, any>;
    expect(doc.command.stdout_bytes).toBe(100001);
    expect(doc.command.truncated.stdout).toBe(true);
  });

  it('非零 returncode 是正常返回不是错误', () => {
    const fx = track(makeRun([['python3', '-c']]));
    const r = call(fx, ['python3', '-c', 'import sys;sys.exit(3)']);
    expect(r.error).toBeUndefined();
    expect(r.returncode).toBe(3);
  });

  it('state 无 hoplog_run_dir（hoplog 关着）→ 实例目录 commands.log 追加一行 JSON 兜底', () => {
    const fx = track(makeRun([['echo']], { withHoplog: false }));
    const r = call(fx, ['echo', 'hi']);
    expect(r.error).toBeUndefined();
    const logPath = join(fx.stateDir, fx.iid, 'commands.log');
    expect(existsSync(logPath)).toBe(true);
    const line = JSON.parse(readFileSync(logPath, 'utf-8').trim().split('\n').pop()!);
    expect(line.argv).toEqual(['echo', 'hi']);
    expect(line.returncode).toBe(0);
  });

  it('反例：instance 不存在 → INSTANCE_NOT_FOUND 结构化错不炸', () => {
    const fx = track(makeRun([['echo']]));
    const r = new HopjitMcpCore(CONFIG).runCommand({ state_dir: fx.stateDir, instance_id: 'nope', argv: ['echo'] }) as Record<string, any>;
    expect(r.error.code).toBe('INSTANCE_NOT_FOUND');
  });

  it('spec.json 是 $spec_ref 引用形态（0130 内容寻址）——经 readSpec 解引用后同样读到清单', () => {
    const fx = track(makeRun([['echo']]));
    const raw = JSON.parse(readFileSync(join(fx.stateDir, fx.iid, 'spec.json'), 'utf-8'));
    expect(raw.$spec_ref).toBeDefined();   // 夹具确实是引用形态,不是 inline
    expect((readSpec(join(fx.stateDir, fx.iid)) as any).header.approved_commands).toEqual([['echo']]);
    expect(call(fx, ['echo', 'ok']).returncode).toBe(0);
  });

  it('反例：spec.json 坏掉 → CORRUPT_STATE_FILE 结构化错', () => {
    const fx = track(makeRun([['echo']]));
    writeFileSync(join(fx.stateDir, fx.iid, 'spec.json'), '{not json');
    const r = call(fx, ['echo']);
    expect(r.error.code).toBe('CORRUPT_STATE_FILE');
  });
  // ---- 0132 工程链 review 面三补钉（变异 a/i/j/l/m 全绿的点位 + 面二 G2/G9 新分支）----

  it('timeout：缺省 300 / 上限钳 1500 / 下限钳 1——传给原语的 timeoutSec 恰为这三值;上限恒低于 Claude Code 的 1800 秒 MCP 静默上限（hopissues/0128;变异:常量改回 3600 即红）', () => {
    const fx = track(makeRun([['echo']]));
    const seen: number[] = [];
    const spy = vi.spyOn(commandExec, 'runWhitelistedCommand').mockImplementation((_argv, opts) => { seen.push(opts.timeoutSec); return { stdout: '', stderr: '', returncode: 0 }; });
    try {
      call(fx, ['echo', 'a']);
      call(fx, ['echo', 'b'], { timeout_sec: 999999 });
      call(fx, ['echo', 'c'], { timeout_sec: 0 });
      call(fx, ['echo', 'd'], { timeout_sec: 2.9 });
      // 超限传入（旧上限 3600）截断到新上限照跑,不拒收——已写 timeout_sec: 3600 的任务卡不因此报错
      const over = call(fx, ['echo', 'e'], { timeout_sec: 3600 });
      expect((over as { error?: unknown }).error).toBeUndefined();
    } finally { spy.mockRestore(); }
    expect(seen).toEqual([RUN_COMMAND_TIMEOUT_DEFAULT_SEC, RUN_COMMAND_TIMEOUT_MAX_SEC, 1, 2, RUN_COMMAND_TIMEOUT_MAX_SEC]);
    expect(RUN_COMMAND_TIMEOUT_DEFAULT_SEC).toBe(300);
    expect(RUN_COMMAND_TIMEOUT_MAX_SEC).toBe(1500);
    // 决策分支:上限必须留在 Claude Code 对 MCP 工具 1800 秒静默上限之下——1800 以上的 timeout 在 CC 上必被载体中止,调用方拿不到回执（hopissues/0128）
    const CLAUDE_CODE_MCP_IDLE_LIMIT_SEC = 1800;
    expect(RUN_COMMAND_TIMEOUT_MAX_SEC).toBeLessThan(CLAUDE_CODE_MCP_IDLE_LIMIT_SEC);
  });

  it('反例：argv 为空数组（core 直调,绕过 zod）→ APPROVAL_REQUIRED 不炸（变异 l 重放）', () => {
    const fx = track(makeRun([['echo']]));
    const r = call(fx, []);
    expect(r.error.code).toBe('APPROVAL_REQUIRED');
    expect(r.error.message).toContain('argv 为空');
  });

  it('反例：state.json 不可读（权限拒）→ CORRUPT_STATE_FILE（persistence 对一切读错统一前缀;原 STATE_READ_FAILED 分支经此例证实是死代码已删）', () => {
    if (process.getuid && process.getuid() === 0) return;   // root 无视权限位,本例无法构造
    const fx = track(makeRun([['echo']]));
    const st = join(fx.stateDir, fx.iid, 'state.json');
    chmodSync(st, 0o000);
    try {
      const r = call(fx, ['echo', 'x']);
      expect(r.error.code).toBe('CORRUPT_STATE_FILE');
      expect(r.error.message).toContain('不可读');
    } finally { chmodSync(st, 0o644); }
  });

  it('stderr 超 64KB：truncated.stderr=true、回给调用方截断注明、账里 stderr_bytes 记原字节（变异 j 重放:stderr 不截即红）', () => {
    const fx = track(makeRun([['python3', '-c']]));
    const r = call(fx, ['python3', '-c', 'import sys;sys.stderr.write("b"*100000)']);
    expect(r.error).toBeUndefined();
    expect(r.truncated.stderr).toBe(true);
    expect(r.truncated.stdout).toBe(false);
    expect(r.stderr).toContain('已截断');
    const text = readFileSync(join(fx.hoplogDir!, 'main.yaml'), 'utf-8');
    const doc = yamlLoad(text.slice(text.indexOf('command:'))) as Record<string, any>;
    expect(doc.command.stderr_bytes).toBe(100000);
    expect(doc.command.truncated.stderr).toBe(true);
  });

  it('正例：argv 与前缀恰好相等（不多不少）→ 放行', () => {
    const fx = track(makeRun([['echo', 'hi']]));
    expect(call(fx, ['echo', 'hi']).returncode).toBe(0);
  });

  it('hoplog_run_dir 在 state 里但目录已被轮转删掉 → 账落 commands.log,不炸不丢', () => {
    const fx = track(makeRun([['echo']]));
    rmSync(fx.hoplogDir!, { recursive: true, force: true });
    const r = call(fx, ['echo', 'gone']);
    expect(r.error).toBeUndefined();
    expect(r.account_error).toBeUndefined();
    const line = JSON.parse(readFileSync(join(fx.stateDir, fx.iid, 'commands.log'), 'utf-8').trim().split('\n').pop()!);
    expect(line.argv).toEqual(['echo', 'gone']);
  });

  it('账写失败不吞执行结果：hoplog 与 commands.log 都写不进 → 返回体带 account_error,returncode/stdout 照常在（面二 G2）', () => {
    if (process.getuid && process.getuid() === 0) return;
    const fx = track(makeRun([['echo']], { withHoplog: false }));
    const instDir = join(fx.stateDir, fx.iid);
    mkdirSync(join(instDir, 'commands.log'));   // 同名目录占位——appendFileSync 必 EISDIR
    const r = call(fx, ['echo', 'still-ran']);
    expect(r.error).toBeUndefined();
    expect(r.returncode).toBe(0);
    expect(r.stdout.trim()).toBe('still-ran');
    expect(typeof r.account_error).toBe('string');
    expect(r.account_error).toContain('记账失败');
  });

});

// @v: anc-exec-command-primitive —— body 口白名单并集:同一张卡不写两遍
describe('subprocess.run 吃卡上《已批准命令》清单', () => {
  it('unionApprovedCommandNames：并命令名去重;两边都空保持 undefined（关死不变）', () => {
    expect(unionApprovedCommandNames(undefined, undefined)).toBeUndefined();
    expect(unionApprovedCommandNames([], [])).toEqual([]);
    expect(unionApprovedCommandNames(['git'], [['python3', '-c'], ['git', 'status']])).toEqual(['git', 'python3']);
    expect(unionApprovedCommandNames(undefined, [['echo']])).toEqual(['echo']);
  });

  it('正例：hopjit.yaml 白名单为空 + 卡上批 echo → 独立模式 body 的 subprocess.run(["echo", …]) 真执行（修前红:未配置白名单）', async () => {
    const SPEC = `# T
Id: t-approved
## Goal
g
## Outputs
- out % text  # o
## 已批准命令
- echo
## Steps
1. [act] 跑命令
  + → out % text  # o
> 执行
> \`\`\`hop_python
> r = subprocess.run(["echo", "from-card"])
> out = r.stdout
> \`\`\`
`;
    const host: HostConfig = {
      workspace_dir: '/tmp/test',
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'test-key',
    };
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host);
    const d = new StepDispatcher(engine, host);
    (d as any).sleep = () => Promise.resolve();
    const r = await d.runSpec();
    expect(r.status).toBe('completed');
    expect(String(engine.getVariableStore().read('out', 'root'))).toContain('from-card');
  });

  it('反例：卡上只批 echo,body 跑 ls → 仍拒（并的是命令名,不是放开全部）', async () => {
    const SPEC = `# T
Id: t-approved-neg
## Goal
g
## Outputs
- out % text  # o
## 已批准命令
- echo
## Steps
1. [act] 跑命令
  + → out % text  # o
> 执行
> \`\`\`hop_python
> r = subprocess.run(["ls"])
> out = r.stdout
> \`\`\`
`;
    const host: HostConfig = {
      workspace_dir: '/tmp/test',
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'test-key',
    };
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host);
    const d = new StepDispatcher(engine, host);
    (d as any).sleep = () => Promise.resolve();
    const r = await d.runSpec();
    expect(r.status).toBe('failed');
    expect(String(engine.getFailureReason?.('1') ?? JSON.stringify(r))).toMatch(/白名单|ls/);
  });
});
