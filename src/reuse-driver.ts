// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: mcp-server ^anc-struct-mcp-server
// 复用模式驱动工具的引擎调用序（todo/0146）——hopjit-mcp 七件驱动工具（run / submit_and_fetch_next /
// reap_and_fetch_next / status / resume / abort / validate）的实现。与 cli.ts 同名子命令逐行同序,区别三处:
// 工作区根取参数不读 cwd、出错抛 Error 不退进程、结果返回不写 stdout。不 import cli.ts——两边共享的真身是引擎。
// 环境变量值由组合根 mcp-server 读一次经 ReuseDriverContext 传入（run 隔离不变量 ^anc-run-isolation）。
// 见 design/mcp-server.md ^anc-mcp-reuse-driver-tools。// @a: anc-mcp-reuse-driver-tools
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute, dirname, sep } from 'node:path';
import { ExecutionEngine, type EngineOptions } from './engine.js';
import { parseSpec, parseFragment, flattenFragmentNumbering } from './parser.js';
import { validateSpec } from './validator.js';
import { readVars, readState, readSpec, flattenVars } from './persistence.js';
import type { CommandResponse, NextResponse } from './cli-types.js';
import type { SpecError, ValidationError } from './errors.js';
import type { HostConfig } from './provider-types.js';
import { configPaths, loadReuseConfig, applyReuseConfig } from './config-load.js';   // 复用模式两级配置（todo/0131） // @a: anc-config-reuse-consume
import { credentialLikeHopEnvKey, hopEnvCredentialError } from './provider-types.js';
import type { StepFailRecord } from './runtime-types.js';
import { loadTwoLevelRegistry } from './tools-registry.js';
import { checkRunDeps, antRoots } from './hopant.js';

/** 驱动工具上下文——组合根 mcp-server 每次调用现读后传入。见 design/mcp-server.md HopType ReuseDriverContext */
export interface ReuseDriverContext {
  workspace_dir: string;      // 工作区根绝对路径
  cli_abs_path: string;       // dist/cli.js 绝对路径（烘焙进 call_protocol/launch_command）
  home: string;               // 用户主目录绝对路径（HopAnt 根与系统级配置定位）
  api_key: string;            // HOPJIT_ANTHROPIC_API_KEY 值,缺席为空串
  hopjit_config: string;      // HOPJIT_CONFIG 值,缺席为空串
  context_mode_env: string;   // HOPJIT_CONTEXT_MODE 值,缺席为空串
}

/** 输出类提交参数：对象原样当输出对象;`@<路径>` 字符串先核 work_zone 再读文件 JSON.parse */
export type OutputArg = Record<string, unknown> | string;

const stateDirOf = (ctx: ReuseDriverContext, stateDir?: string) => resolve(ctx.workspace_dir, stateDir ?? '.hopstate');

// ── 文件参数助手（与 cli.ts 同规则,工作区根参数化）── ^anc-cli-file-arg-safety

/** `@` 后的路径解析：parallel worker 的裸文件名重定向到本 child work_zone,其余按工作区根解析。^anc-cli-parallel-file-isolation */
function resolveFileArg(ws: string, filePath: string, workZoneBase?: string): string {
  if (workZoneBase && !isAbsolute(filePath) && !filePath.includes('/')) return join(workZoneBase, filePath);
  return resolve(ws, filePath);
}

/** 显式实例号指向 parallel worker 子实例时返回其 work_zone,否则 undefined。^anc-cli-parallel-file-isolation */
function workerWorkZone(instanceDir: string, instanceId?: string): string | undefined {
  if (!instanceId || !instanceId.includes('/parallel/')) return undefined;
  return join(instanceDir, 'work_zone');
}

/** `@路径` 必须落在本执行单元 work_zone 内,越界抛 WORK_ZONE_VIOLATION。^anc-cli-file-arg-safety */
function assertInWorkZone(ws: string, value: string, instanceDir: string, workZoneBase?: string): string {
  const resolved = resolveFileArg(ws, value.slice(1), workZoneBase);
  const workZone = resolve(join(instanceDir, 'work_zone'));
  if (!(resolved === workZone || resolved.startsWith(workZone + sep))) {
    throw new Error(`WORK_ZONE_VIOLATION: output 路径越界 '${resolved}' 不在本执行单元 work_zone '${workZone}' 内。`
      + `请把产出写到 work_zone（响应给出的 output_path），不要写 /tmp 或自选绝对路径——否则与兄弟 worker 串台。`);
  }
  return resolved;
}

/** 输出类参数解析：对象直接用;`@路径` 核 work_zone 后读 JSON;其它字符串按 JSON 文本解析。 */
function resolveOutputArg(ws: string, value: OutputArg, instanceDir: string, workZoneBase?: string): unknown {
  if (typeof value !== 'string') return value;
  if (value.startsWith('@')) return JSON.parse(readFileSync(assertInWorkZone(ws, value, instanceDir, workZoneBase), 'utf-8'));
  return JSON.parse(value);
}

/** 文本类参数（failure/replan）：`@路径` 读原文,否则原值。 */
function resolveTextArg(ws: string, value: string, workZoneBase?: string): string {
  return value.startsWith('@') ? readFileSync(resolveFileArg(ws, value.slice(1), workZoneBase), 'utf-8') : value;
}

/** 解析目标实例目录：显式实例号定位并核在场与初始化,省略时取 state_dir 下 mtime 最新。与 cli resolveInstance 同报文。^anc-cli-instance-resolve
 * // @a: anc-mcp-reuse-driver-tools */
export function resolveInstance(stateDir: string, instanceId?: string): string {
  stateDir = resolve(stateDir);
  if (instanceId) {
    const dir = join(stateDir, instanceId);
    if (!existsSync(dir)) {
      let hint: string;
      try {
        const real = listByMtime(stateDir).slice(0, 5);
        hint = real.length ? `state_dir 下真实存在的实例（新在前，最多列 5 个）: ${real.join(', ')}` : 'state_dir 下无任何实例';
      } catch { hint = `state_dir 本身不可读: ${stateDir}`; }
      throw new Error(`INSTANCE_NOT_FOUND: 实例 ${instanceId} 在 ${stateDir} 下不存在——若实例号是手抄的请核对有无抄错。${hint}`);
    }
    if (!existsSync(join(dir, 'state.json')) && !existsSync(join(dir, 'spec.json'))) {
      throw new Error(`INSTANCE_NOT_INITIALIZED: 子实例 ${instanceId} 目录在场但未完成初始化（无 state.json/spec.json——常见成因: child 启动失败留下的半截目录）。删除该目录后重新派发即可。`);
    }
    return dir;
  }
  if (!existsSync(stateDir)) throw new Error(`INSTANCE_NOT_FOUND: state_dir ${stateDir} 不存在`);
  const entries = listByMtime(stateDir);
  if (entries.length === 0) throw new Error('INSTANCE_NOT_FOUND: No instances found in state directory');
  return join(stateDir, entries[0]);
}

function listByMtime(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => { try { return { name: d.name, m: statSync(join(dir, d.name)).mtimeMs }; } catch { return null; } })
    .filter((x): x is { name: string; m: number } => x !== null)
    .sort((a, b) => b.m - a.m)
    .map(x => x.name);
}

// ── HostConfig 装配（与 cli buildHostConfig 同值,工作区根参数化）── ^anc-config-sandbox-workspace-root

function buildHostConfig(ctx: ReuseDriverContext): HostConfig {
  const ws = ctx.workspace_dir;
  const hc: HostConfig = {
    workspace_dir: ws,
    sandbox: {
      filesystem: { workspace_dir: ws, read_access: { allowed: ['.'],
        denied: ['.env', '.env.*', '*.key', '*.pem', '.hopstate/**', '.hoplog/**'], confirm_required: [] } },
      network: { trusted_hosts: [] },
      runtime: { available: [] },
    },
    language: 'en',
    hop_env: { hop_env_language: 'en' },
    api_key: ctx.api_key,
  };
  // 两级配置（todo/0131,与 cli buildHostConfig 同一消费面 applyReuseConfig）;home / HOPJIT_CONFIG 来自 ctx（组合根读过一次）。
  // warnings 走 stderr（server 进程的 stderr 由载体收）。// @a: anc-config-reuse-consume
  const { config, warnings } = loadReuseConfig(configPaths(ctx.home, ws, ctx.hopjit_config || undefined));
  for (const w of warnings) process.stderr.write(`${w}\n`);
  applyReuseConfig(hc, config);
  return hc;
}

/** params 里的 hop_env_* 摘入 HostConfig.hop_env（凭证形态键名拒）,绝对路径值同扩读白名单。^anc-config-hop-env */
function extractHopEnv(hostConfig: HostConfig, params: Record<string, unknown> | undefined): void {
  if (!params) return;
  const hopEnv: Record<string, string> = {};
  for (const k of Object.keys(params)) {
    if (!k.startsWith('hop_env_')) continue;
    if (credentialLikeHopEnvKey(k)) throw new Error(hopEnvCredentialError(k, 'params'));
    if (typeof params[k] === 'string') hopEnv[k] = params[k] as string;
    delete params[k];
  }
  if (Object.keys(hopEnv).length === 0) return;
  hostConfig.hop_env = { ...(hostConfig.hop_env ?? {}), ...hopEnv };
  for (const v of Object.values(hopEnv)) {
    if (isAbsolute(v) && !hostConfig.sandbox.filesystem.read_access.allowed.includes(v)) hostConfig.sandbox.filesystem.read_access.allowed.push(v);
  }
}

/** 顶层起跑依赖核：通过返回 null,不过返回 INIT_FAILED 响应（与 cli runDepsGate 同形）。^anc-cli-run-deps-gate */
function runDepsGate(ctx: ReuseDriverContext, content: string, specAbsPath: string): Record<string, unknown> | null {
  const { sysPath, projPath } = configPaths(ctx.home, ctx.workspace_dir, ctx.hopjit_config || undefined);   // 路径唯一来源 config-load.configPaths // @a: anc-struct-config-load-exports
  const reg = loadTwoLevelRegistry(sysPath, projPath);
  const rep = checkRunDeps(content, specAbsPath, { roots: antRoots(ctx.home, ctx.workspace_dir), tool_servers: reg.tool_servers });
  if (rep.ok) return null;
  const lines = [...rep.tools.missing.map(t => `工具没有注册 ${t}`), ...rep.tools.errors, ...rep.calls.missing.map(c => `call 目标找不到 ${c}`), ...rep.calls.unreadable];
  const message = `INIT_FAILED 依赖核:${lines.join(';')}`;
  return {
    status: 'error', error_code: 'INIT_FAILED', message,
    errors: [{ kind: 'validate', rule: 'INIT_FAILED', severity: 'error', message }],
    missing_tools: rep.tools.missing, missing_calls: rep.calls.missing, hints: rep.hints,
  };
}

// ── 七件驱动函数 ──

export interface DriverRunArgs {
  spec_path: string; params?: Record<string, unknown>; state_dir?: string;
  log_dir?: string; log_level?: string; max_runs?: number; context_mode?: string; notify?: string;
  approve_dirs?: boolean;   // 起跑即批 Config.dirs 清单跳停点（与 CLI --approve-dirs 同义,^anc-cli-approve-dirs / ^anc-mcp-dirs-approve） // @a: anc-mcp-dirs-approve
}
/** run：init + 推进到首个 caller 介入点（cli run 顶层分支同序;worker 起跑仍走 CLI launch_command）。// @a: anc-mcp-reuse-driver-tools */
export async function driverRun(ctx: ReuseDriverContext, args: DriverRunArgs): Promise<unknown> {
  const specAbs = resolve(ctx.workspace_dir, args.spec_path);
  const content = readFileSync(specAbs, 'utf-8');
  const hostConfig = buildHostConfig(ctx);
  const params = args.params ? { ...args.params } : undefined;
  extractHopEnv(hostConfig, params);
  if (args.log_level !== undefined && !['debug', 'info', 'warn'].includes(args.log_level)) {
    throw new Error(`INVALID_ARG: log_level 只认 debug | info | warn,收到 '${args.log_level}'`);
  }
  if (args.max_runs !== undefined && !(Number.isInteger(args.max_runs) && args.max_runs >= 1)) {
    throw new Error(`INVALID_ARG: max_runs 须为正整数,收到 ${String(args.max_runs)}`);
  }
  if (args.notify !== undefined && args.notify !== 'dingtalk') {
    throw new Error(`INVALID_ARG: notify 渠道 '${args.notify}' 不支持——可用渠道: dingtalk`);
  }
  const stateDir = stateDirOf(ctx, args.state_dir);
  const mode = (ctx.context_mode_env || args.context_mode || '').toLowerCase() === 'minimal' ? 'minimal' : 'full';
  const engineOpts: EngineOptions = {
    stateDir,
    canFanout: true,
    specPath: specAbs,
    cliAbsPath: ctx.cli_abs_path,
    ...(params ? { params } : {}),
    logDir: args.log_dir ? resolve(ctx.workspace_dir, args.log_dir) : resolve(stateDir, '..', '.hoplog'),
    ...(args.log_level ? { logLevel: args.log_level as 'debug' | 'info' | 'warn' } : {}),
    ...(args.max_runs !== undefined ? { maxRuns: args.max_runs } : {}),
    contextMode: mode,
    driverChannel: 'cli',
  };
  const gate = runDepsGate(ctx, content, specAbs);
  if (gate) return gate;
  const engine = new ExecutionEngine();
  const initResult = engine.initExecution(content, hostConfig, engineOpts);
  if (initResult.status !== 'ok') return initResult;
  if (args.approve_dirs) {   // @a: anc-mcp-dirs-approve
    const st = engine.checkDirsApproval();
    if (st && !st.approved) { const r = engine.approveDirs(st.dirs_hash); if (r.status === 'error') throw new Error(r.message); }
  }
  engine.setUnifiedDispatch(true);
  if (args.notify) engine.notifyChannel = args.notify;   // 渠道入快照;MCP 推进不发,改走 CLI 续推时照发（v1 边界）
  return engine.advanceToCaller();
}

export interface DriverSubmitArgs {
  step_id: string; instance_id?: string; state_dir?: string;
  output?: OutputArg; answer?: OutputArg; child_instance?: string; failure_child?: string;
  failure?: string; replan?: string; proactive?: boolean; extend_expansion?: boolean;
  tool_result?: OutputArg;
}
// 七种,没有 branch：选路只由引擎按 case 条件求值,调用方不替引擎选 case。// @a: anc-exec-branch-select-internal
const SUBMIT_MODES = ['output', 'answer', 'child_instance', 'failure_child', 'failure', 'replan', 'tool_result'] as const;
const SUBMIT_FIXED_KEYS = new Set(['step_id', 'instance_id', 'state_dir', 'workspace_dir', 'proactive', 'extend_expansion']);
/** submit_and_fetch_next：按提交形态回写,成功则推进到下一介入点（cli submit_and_fetch_next 同表）。// @a: anc-mcp-reuse-driver-tools */
export async function driverSubmit(ctx: ReuseDriverContext, args: DriverSubmitArgs): Promise<unknown> {
  // 未知提交键结构化拒收：SDK 的 zod 对象 schema 对未知键是剥除不是拒收,直调处理器又不经 zod——两条路径都在这里同判。
  // @a: anc-exec-branch-select-internal
  const unknownKey = Object.keys(args).find(k => !(SUBMIT_MODES as readonly string[]).includes(k) && !SUBMIT_FIXED_KEYS.has(k));
  if (unknownKey !== undefined) throw new Error(`INVALID_ARG: 不认识的提交字段 '${unknownKey}'——合法提交形态七种: ${SUBMIT_MODES.join(' / ')}`);
  const modes = SUBMIT_MODES.filter(k => args[k] !== undefined);
  if (modes.length > 1) throw new Error(`INVALID_STATE: 互斥参数只能给一个，收到 [${modes.join(', ')}]`);
  const ws = ctx.workspace_dir;
  const stepId = args.step_id;
  const instanceDir = resolveInstance(stateDirOf(ctx, args.state_dir), args.instance_id);
  const engine = ExecutionEngine.load(instanceDir);
  engine.claimDriverChannel('cli');   // 与 CLI 同通道:同一 run 可在 MCP 工具与 CLI 回退间切换 // @a: anc-exec-driver-channel
  if (engine.getCanFanout()) engine.setUnifiedDispatch(true);
  const workZoneBase = workerWorkZone(instanceDir, args.instance_id);

  let writeResult: CommandResponse;
  if (args.child_instance !== undefined) {
    const childDir = join(instanceDir, 'calls', args.child_instance);
    const childVars = flattenVars(readVars(childDir));
    if ((readState(childDir).committed_steps ?? []).length > 0) engine.markCommitted(stepId);   // @a: anc-exec-commit-anneal
    writeResult = engine.completeCallStep(stepId, childVars);
  } else if (args.failure_child !== undefined) {
    const childDir = join(instanceDir, 'calls', args.failure_child);
    const childState = readState(childDir);
    if ((childState.committed_steps ?? []).length > 0) engine.markCommitted(stepId);   // @a: anc-exec-commit-anneal
    const childSpec = readSpec(childDir) as { header?: { id?: string } };
    writeResult = engine.failCallStep(stepId, {
      specId: childSpec.header?.id ?? 'unnamed',
      childInstanceId: args.failure_child,
      stepFailReasons: (childState.step_fail_reasons ?? {}) as Record<string, StepFailRecord>,
      stepStates: childState.step_states,
      retryHistory: childState.retry_history,
    });
  } else if (args.failure !== undefined) {
    writeResult = engine.failStep(stepId, resolveTextArg(ws, args.failure, workZoneBase));
  } else if (args.replan !== undefined) {
    const md = resolveTextArg(ws, args.replan, workZoneBase);
    const opts = (args.proactive || args.extend_expansion)
      ? { ...(args.proactive ? { proactive: true } : {}), ...(args.extend_expansion ? { extendExpansion: true } : {}) } : undefined;
    writeResult = engine.submitReplan(stepId, flattenFragmentNumbering(md), opts);
  } else if (args.tool_result !== undefined) {
    writeResult = engine.submitToolResult(stepId, resolveOutputArg(ws, args.tool_result, instanceDir, workZoneBase));
  } else {
    const raw = args.output ?? args.answer;
    const parsed = raw !== undefined ? resolveOutputArg(ws, raw, instanceDir, workZoneBase) : undefined;
    // 解析结果必须是对象（与 CLI 同一检查,[[hop-cli#^anc-cli-json-io]]）:inputSchema 为接受 `@路径` 允许字符串,
    // JSON 文本解析出的字符串、数字、null、数组挡不住——null/数组曾让 confirm 被当同意推进。引擎状态不动。// @a: anc-mcp-reuse-driver-tools
    if (raw !== undefined && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
      const name = args.output !== undefined ? 'output' : 'answer';
      const shape = name === 'answer' ? '{"value":"approve"}（或 {"value":"<用户给的值>"}）' : '{"<输出槽名>": <值>}';
      throw new Error(`INVALID_ARG: ${name} 解析后须是 JSON 对象（收到 ${parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed}）——正确形态 ${shape}`);
    }
    const outputs = parsed as Record<string, unknown> | undefined;
    if (engine.getEscalatePending() === stepId && args.answer !== undefined) {   // @a: anc-exec-check-escalate
      writeResult = engine.resumeFromEscalation(stepId, String((outputs?.['guidance'] ?? outputs?.['value']) ?? ''));
    } else {
      return engine.completeAndAdvance(stepId, outputs);   // @a: anc-exec-stale-resubmit
    }
  }
  if (writeResult.status !== 'ok') return writeResult;
  return engine.advanceToCaller();
}

export interface DriverReapArgs { child_instance: string; status: string; instance_id?: string; state_dir?: string }
/** reap_and_fetch_next：读子实例目录收割 + 推进（cli reap_and_fetch_next 同序）。^anc-exec-parallel-reuse-protocol
 * // @a: anc-mcp-reuse-driver-tools */
export async function driverReap(ctx: ReuseDriverContext, args: DriverReapArgs): Promise<NextResponse> {
  if (args.status !== 'completed' && args.status !== 'failed') {
    throw new Error(`INVALID_ARG: status 须为 completed | failed（收到 '${args.status}'）`);
  }
  const engine = ExecutionEngine.load(resolveInstance(stateDirOf(ctx, args.state_dir), args.instance_id));
  engine.claimDriverChannel('cli');
  engine.setUnifiedDispatch(true);
  engine.reconcileInflight({ dispatchLostPolicy: 'stale' });   // @a: anc-exec-parallel-inflight-reconcile
  engine.reapFromChildDir(args.child_instance, args.status);
  return engine.advanceToCaller();
}

export interface DriverInstanceArgs { instance_id?: string; state_dir?: string }
/** status：只读,不认领通道。// @a: anc-mcp-reuse-driver-tools */
export function driverStatus(ctx: ReuseDriverContext, args: DriverInstanceArgs): unknown {
  return ExecutionEngine.load(resolveInstance(stateDirOf(ctx, args.state_dir), args.instance_id)).getStatus();
}

/** resume：崩溃恢复（recover 重置悬空 running）+ 推进。^anc-cli-state-load // @a: anc-mcp-reuse-driver-tools */
export async function driverResume(ctx: ReuseDriverContext, args: DriverInstanceArgs): Promise<NextResponse> {
  const engine = ExecutionEngine.recover(resolveInstance(stateDirOf(ctx, args.state_dir), args.instance_id));
  engine.claimDriverChannel('cli');
  return engine.advanceToCaller();
}

/** abort：主动中止（不可逆,快照与 hoplog 保留）。^anc-cli-abort // @a: anc-mcp-reuse-driver-tools */
export function driverAbort(ctx: ReuseDriverContext, args: DriverInstanceArgs & { reason?: string }): unknown {
  const engine = ExecutionEngine.load(resolveInstance(stateDirOf(ctx, args.state_dir), args.instance_id));
  engine.claimDriverChannel('cli');
  return engine.abort(args.reason);
}

export interface DriverValidateArgs { spec_path: string; fragment?: boolean; known_vars?: string[] }
/** validate：只读合法性校验,返回 error 与 warn/info 两桶（cli validate 同形）。^anc-exec-validation // @a: anc-mcp-reuse-driver-tools */
export function driverValidate(ctx: ReuseDriverContext, args: DriverValidateArgs): unknown {
  const ws = ctx.workspace_dir;
  const specAbs = resolve(ws, args.spec_path);
  const content = readFileSync(specAbs, 'utf-8');
  const { ast, errors: parseErrors } = args.fragment ? parseFragment(content) : parseSpec(content);
  if (parseErrors.length > 0) return { status: 'error', errors: parseErrors as SpecError[], warnings: [] };
  const docRefCtx = args.fragment ? undefined : {
    workspace_dir: ws,
    sandbox: { filesystem: { workspace_dir: ws, read_access: { allowed: ['.', dirname(specAbs)], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
    spec_dir: dirname(specAbs),
    lenient_cross_dir: true,
  };
  const all = validateSpec(ast, docRefCtx, args.fragment ? { fragment: true, knownVars: args.known_vars ?? [] } : undefined);
  const errors = all.filter((e: ValidationError) => e.severity === 'error');
  const warnings = all.filter((e: ValidationError) => e.severity !== 'error');
  return { status: errors.length > 0 ? 'error' : 'ok', errors: errors as SpecError[], warnings: warnings as SpecError[] };
}

/** 运行时错误 → 结构化错误：code 取报文开头 `大写码:` 前缀,无前缀为 DRIVER_TOOL_ERROR。// @a: anc-mcp-reuse-driver-tools */
export function driverErrorOf(err: unknown): { error: { code: string; message: string } } {
  const message = err instanceof Error ? err.message : String(err);
  const m = /^([A-Z][A-Z0-9_]+):/.exec(message);
  return { error: { code: m ? m[1] : 'DRIVER_TOOL_ERROR', message } };
}
