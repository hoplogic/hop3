#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: hop-cli ^anc-struct-hop-cli
import { Command, Option } from 'commander';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { parse as parseJsonc, modify as jsoncModify, applyEdits as jsoncApplyEdits, type ParseError } from 'jsonc-parser';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync, cpSync, renameSync, appendFileSync, realpathSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve, join, isAbsolute, dirname, sep, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname, userInfo, tmpdir } from 'node:os';
import { ExecutionEngine, DECLARED_DIRS_PARAM, type DeclaredDirs, getEngineVersion, type EngineOptions } from './engine.js';
import { parseSpec, parseFragment , flattenFragmentNumbering , convertSpecKeywords , convertSchemaSeparators } from './parser.js';
import { validateSpec } from './validator.js';
import { readVars, readState, readSpec, stateExists, flattenVars, findRunRoot } from './persistence.js';
import { hasChildren, getChildren, isParallelContainer, getForEach } from './ast-helpers.js';
import type { StepNode } from './ast-types.js';
import type { CommandResponse, ListResponse, NextResponse } from './cli-types.js';
import type { SpecError, ValidationError } from './errors.js';
import type { HostConfig } from './provider-types.js';
import { credentialLikeHopEnvKey, hopEnvCredentialError, OPENCODE_DISABLED_TOOLS, YAML_DUMP_OPTS } from './provider-types.js';
import { CompositeToolProvider, makeEngineToolProviderFactory } from './tools-composite.js';

import { parseToolServers, enrichParamsComments, loadTwoLevelRegistry } from './tools-registry.js';
import { configPaths, loadReuseConfig, loadToolRegistry, applyReuseConfig } from './config-load.js';   // 复用模式两级配置（todo/0131,[[config-load#^anc-config-reuse-consume]]） // @a: anc-config-reuse-consume
import { sendDingtalk, composeRunCard } from './tools-notify.js';   // 复用模式通知挂点（^anc-cli-notify-reuse） // @a: anc-cli-notify-reuse
import { antDir, antsRoot, antRoots, planInstall, applyInstall, resolveCalleeSpecPath, checkRunDeps, commitApprovalStorePath } from './hopant.js';   // 演示 HopAnt 安装 / 依赖核 / callee 与批准账解析（^anc-cli-install-skill-demo-ants / ^anc-cli-run-deps-gate）
// hop 管理面业务体（doctor 八问 / ant 七动作 / 载体探测助手）住 hop-admin.ts,本文件的 doctor / ant 子命令与 setup 的探测半边都调它（todo/0154,^anc-mcp-admin-tools）。
import { type AdminContext, type Carrier, type McpHandshake, CARRIER_VALUES, carrierFamily, resolveCarrierHome, detectCarriers, installedHopDriverVersion, learnStandaloneEntry, readMcpRegistration, ccFamilyRegistration, writeCcLocalRegistration, ccPermissionMissing, mcpHandshake, rewriteSpecId,
  runDoctor, formatDoctorReport, antList, antInstall, antAdapt, antRemove, antBootstrap, antPack, antShare } from './hop-admin.js';   // @a: anc-mcp-admin-tools
// tests/cli.test.ts 既有的导入面（搬家前这些符号在本文件导出）——转发保持可达,不是跨模块出口。
export { resolveCarrierHome, detectCarriers, installedHopDriverVersion, readSkillFrontmatter, readMcpRegistration, detectCcHopjitRegistration, ccFamilyRegistration, writeCcLocalRegistration, ccPermissionMissing, mcpHandshake, learnStandaloneEntry, runDoctor, formatDoctorReport, rewriteSpecId, type Carrier, type DoctorReport, type DoctorItem, type DoctorStatus, type McpRegistration, type McpHandshake, type StandaloneEntry, type AdminContext } from './hop-admin.js';

// 在 spec 树中按 step_id 查找节点（join_parallel 用于定位 parallel 容器及其 children）
function findStepInSpec(stepId: string, steps: StepNode[]): StepNode | null {
  for (const step of steps) {
    if (step.step_id === stepId) return step;
    if (hasChildren(step)) {
      const found = findStepInSpec(stepId, getChildren(step));
      if (found) return found;
    }
  }
  return null;
}

// --version 单一事实源 = 包 package.json，杜绝硬编码字面量与发版脱节。见 [[hop-cli#^anc-cli-version-single-source]]
function readPackageVersion(): string { // @a: anc-cli-version-single-source
  try {
    // dist/cli.js → 上溯包根 dist/../package.json
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0'; // 读失败兜底，不阻断 CLI 启动
  }
}

const program = new Command();
program.option('--json', 'Force single-line JSON output (default is YAML; machine consumers should pass this)');
program.hook('preAction', (thisCommand) => {
  setOutputJson(thisCommand.opts().json === true);
  const hint = firstRunHint(process.argv.slice(2), process.env, readPackageVersion());   // 只写 stderr,不碰 --json 的 stdout（^anc-cli-first-run-hint） // @a: anc-cli-first-run-hint
  if (hint) process.stderr.write(hint + '\n');
});
program.name('hopjit').version(readPackageVersion()).description('HopJIT execution engine CLI'); // @a: anc-struct-hop-cli, anc-cli-dispatch

/** stdout 输出：缺省 YAML（人可读，2026-08-06 拍板），--json flag 或 HOPJIT_OUTPUT=json 强制
 * 单行 JSON（机器消费方——driver/测试显式带 --json）。见 [[hop-cli#^anc-cli-json-io]]。
 * 序列化器（yaml.dump/JSON.stringify）是 CLI 通道的转义手段（禁手拼）——见 ARCHITECTURE.md ^anc-string-escape。 */
let FORCE_JSON = process.env['HOPJIT_OUTPUT'] === 'json';
/** 输出模式开关：--json flag 置位（preAction hook 调用；env 恒优先）。见 [[hop-cli#^anc-cli-json-io]] */
export function setOutputJson(on: boolean): void { FORCE_JSON = on || process.env['HOPJIT_OUTPUT'] === 'json'; }
/** stdout 输出分流：缺省 YAML（人读），FORCE_JSON 时单行 JSON（机器）。见 [[hop-cli#^anc-cli-json-io]] */
export function output(data: unknown): void { // @a: anc-cli-json-io, anc-string-escape
  if (FORCE_JSON) {
    process.stdout.write(JSON.stringify(data) + '\n');
  } else {
    process.stdout.write(yamlDump(data as object, YAML_DUMP_OPTS));   // @a: anc-config-yaml-dump-opts
  }
}

/** 运行时错误（参数非法、IO 失败）写 stderr 并以非零 exit code 退出，与业务错误的 stdout JSON 分流。见 [[hop-cli#^anc-cli-json-io]] */
export function errorExit(message: string, code = 1): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

// @file 解析根目录：并行 worker 的裸文件名（无 / 、非绝对）重定向到该 child 的 work_zone，
// 消除多 worker 共享 cwd 的固定名竞态。见 design/hop-cli.md ^anc-cli-parallel-file-isolation。
// @a: anc-cli-parallel-file-isolation
export function resolveFileArgBase(filePath: string, workZoneBase?: string): string {
  // 仅对 worker 子实例的「裸文件名」重定向；绝对路径/含 / 的相对路径尊重 driver 显式意图
  if (workZoneBase && !isAbsolute(filePath) && !filePath.includes('/')) {
    return join(workZoneBase, filePath);
  }
  return resolve(filePath);
}

/** 解析 JSON 参数：`@file` 前缀从文件读取（走 worker work_zone 重定向），否则原样 JSON.parse。见 [[hop-cli#^anc-cli-file-arg-safety]] */
export function resolveParam(value: string | undefined, workZoneBase?: string): unknown {
  if (!value) return undefined;
  if (value.startsWith('@')) {
    const filePath = resolveFileArgBase(value.slice(1), workZoneBase);
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  }
  return JSON.parse(value);
}

/** 提交越界校验：`--output @<path>` 的解析路径必须落在本执行单元 work_zone 内，越界（/tmp、
 * 项目根、兄弟 child）→ 抛错拒绝提交。引擎唯一能真拦的点（复用模式 act 由 CC 执行、写入不过引擎，
 * 只能提交时校验）。回归 ppt-html v4 串台：worker 写共享 /tmp 互相覆盖。见 [[hop-cli#^anc-cli-file-arg-safety]]。
 */
// @a: anc-cli-file-arg-safety
/** work_zone 前缀判定纯函数——分隔符可注入供 win32 仿真测试（0057:win32 resolve 产反斜杠,
 * 硬编码 '/' 使 work_zone 内合法路径永不匹配,@file 提交全废;宿主运行时缺省吃平台 sep）。
 */
// @a: anc-cli-file-arg-safety
export function isPathInWorkZone(resolved: string, workZone: string, sepChar: string = sep): boolean {
  return resolved === workZone || resolved.startsWith(workZone + sepChar);
}

/** --output @file 路径越界校验：@ 路径必须落在本执行单元 work_zone 内（防兄弟 worker 串台/防写 /tmp）。见 [[hop-cli#^anc-cli-file-arg-safety]] 越界校验条款。 */
export function assertOutputInWorkZone(value: string | undefined, instanceDir: string, workZoneBase?: string): void {
  if (!value || !value.startsWith('@')) return;   // 内联 JSON 不涉文件，免校验
  const resolved = resolveFileArgBase(value.slice(1), workZoneBase);
  const workZone = resolve(join(instanceDir, 'work_zone'));
  // 允许 work_zone 目录本身及其子路径（含 worker 子实例的 <childDir>/work_zone，因 instanceDir 已是 childDir）
  if (!isPathInWorkZone(resolved, workZone)) {
    errorExit(`WORK_ZONE_VIOLATION: --output 路径越界 '${resolved}' 不在本执行单元 work_zone '${workZone}' 内。`
      + `请把 output 写到 work_zone（响应给出的 output_path），不要写 /tmp 或自选绝对路径——否则与兄弟 worker 串台。`);
  }
}

/** 解析文本参数（如 --steps/--reason）：`@file` 前缀读文件原文，否则返回原值——LLM 生成内容经 @file 防注入。见 [[hop-cli#^anc-cli-file-arg-safety]] */
export function resolveTextParam(value: string | undefined, workZoneBase?: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('@')) {
    const filePath = resolveFileArgBase(value.slice(1), workZoneBase);
    return readFileSync(filePath, 'utf-8');
  }
  return value;
}

// 判定 --instance 是否指向 parallel worker 子实例（路径含 /parallel/），
// 是则返回其 work_zone 工作区用于裸文件名重定向。// @a: anc-cli-parallel-file-isolation
export function workerWorkZone(instanceDir: string, instanceOpt?: string): string | undefined {
  if (!instanceOpt || !instanceOpt.includes('/parallel/')) return undefined;
  return join(instanceDir, 'work_zone');
}

/** 解析目标实例目录：显式 --instance 直接定位，省略时取 state_dir 下最新（按 mtime）实例。见 [[hop-cli#^anc-cli-instance-resolve]] */
export function resolveInstance(stateDir: string, instanceId?: string): string { // @a: anc-cli-instance-resolve
  // 绝对化（2026-08-14 review 实抓）：load 恢复的 instanceDir 派生 call_protocol/launch_command
  // 载荷内 state-dir——相对路径折进跨进程照抄的命令,driver 换 cwd 执行即落错目录。
  // @a: anc-exec-call-protocol-payload
  stateDir = resolve(stateDir);
  if (instanceId) {
    const dir = join(stateDir, instanceId);
    // 显式实例号先做目录在场校验（2026-09-01 codex:parallel 实撞:driver 手抄号丢一字符,
    // 缺校验时错号走到 persistence 撞 ENOENT 报 CORRUPT_STATE_FILE"状态文件损坏"——两种病
    // 一张脸,收报文的人不会想到是号抄错了。报文列真实实例指路让 driver 能自纠;
    // CORRUPT_STATE_FILE 语义随之收纯=目录在文件坏。省略分支取的就是真实目录,天然无此病。）
    // @a: anc-cli-instance-resolve
    if (!existsSync(dir)) {
      let hint: string;
      try {
        const real = readdirSync(stateDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => { try { return { name: d.name, m: statSync(join(stateDir, d.name)).mtimeMs }; } catch { return null; } })
          .filter((x): x is { name: string; m: number } => x !== null)
          .sort((a, b) => b.m - a.m)
          .slice(0, 5)
          .map(x => x.name);
        hint = real.length ? `state_dir 下真实存在的实例（新在前，最多列 5 个）: ${real.join(', ')}` : 'state_dir 下无任何实例';
      } catch { hint = `state_dir 本身不可读: ${stateDir}`; }
      throw new Error(`INSTANCE_NOT_FOUND: 实例 ${instanceId} 在 ${stateDir} 下不存在——若实例号是手抄的请核对有无抄错。${hint}`);
    }
    // 半初始化档（0059）：目录在场而 state.json 与 spec.json 双缺——child 启动失败留下的半截目录
    // （父先写 params.json、child 未 init 即死）。不拦则一路走到 persistence 读 spec.json 撞 ENOENT
    // 裹成 CORRUPT_STATE_FILE"状态文件损坏"——病是"从未初始化"不是"文件坏",报文教错排障方向。
    // 三档语义:目录不在=INSTANCE_NOT_FOUND / 在而未初始化=INSTANCE_NOT_INITIALIZED / 初始化过文件坏=CORRUPT_STATE_FILE。
    // @a: anc-cli-instance-resolve
    if (!existsSync(join(dir, 'state.json')) && !existsSync(join(dir, 'spec.json'))) {
      throw new Error(`INSTANCE_NOT_INITIALIZED: 子实例 ${instanceId} 目录在场但未完成初始化（无 state.json/spec.json——常见成因: child 启动失败留下的半截目录）。删除该目录后重新派发即可。`);
    }
    return dir;
  }
  // 先按目录类型过滤（跳过文件），再取 mtime 排最新；单项 statSync 容错——
  // 目录混入不可 stat 的项（权限/竞态删除）不应中断整个解析。
  const entries = readdirSync(stateDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      try { return { name: d.name, mtimeMs: statSync(join(stateDir, d.name)).mtimeMs }; }
      catch { return null; }
    })
    .filter((e): e is { name: string; mtimeMs: number } => e !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (entries.length === 0) {
    throw new Error('No instances found in state directory');
  }
  return join(stateDir, entries[0].name);
}

/** 复用模式通知挂点（^anc-cli-notify-reuse——五个可达终态/停点的命令统一出口:一处实现五处调用）。
 * 二与门（2026-08-31 作者定"每次 hop 时说,否则太烦"——渠道随话语走零配置文件）:
 * ①engine.notifyChannel 在场（run --notify <渠道> 置值入快照跨进程,渠道来自用户话语点名）
 * ②凭证 sendDingtalk 自查。缺门①静默跳过;发送失败记 stderr 一行,
 * output() 恒执行——通知是旁路,主流程响应零阻塞变化。 // @a: anc-cli-notify-reuse */
async function outputWithNotify(result: { status: string }, engine: ExecutionEngine): Promise<void> {
  try {
    const st = result.status;
    if ((st === 'completed' || st === 'failed' || st === 'paused') && engine.notifyChannel) {
      if (engine.notifyChannel === 'dingtalk') {
        const status = engine.getStatus();
        const q = (result as unknown as { presented_data?: { question?: string } }).presented_data?.question;
        const failure = (result as unknown as { failure_reason?: string; failed_step_id?: string });
        const card = composeRunCard({
          spec_title: engine.getSpec()?.header.title ?? status.instance_id,
          state: st as 'completed' | 'failed' | 'paused',
          completed_steps: status.completed, total_steps: status.total_steps,
          ...(st === 'failed' && failure.failed_step_id ? { current_step: `${failure.failed_step_id}: ${String(failure.failure_reason ?? '').slice(0, 160)}` } : status.current_step ? { current_step: status.current_step } : {}),
          ...(q ? { paused_question: String(q) } : {}),
          run_id_tail: status.instance_id.slice(-8),
        });
        // CLI 是短命进程——fire-and-forget 会被进程退出掐死（实测:stderr 留痕竞态丢失）,
        // 故 await 发送但带 5s 超时兜底:发送最多拖住进程 5s,超时记痕放行——"不拖垮主流程"在
        // 短命进程形态=不无限等,不是不等（^anc-cli-notify-reuse 短命进程条款）。
        // 定时器赛后必清:不清则发送秒回后句柄仍吊着事件循环,每次都白拖满 5s 才退进程
        // （原批阅卷实抓的缺陷本体）。 // @a: anc-cli-notify-reuse
        let timer: ReturnType<typeof setTimeout> | undefined;
        const sent = await Promise.race([
          sendDingtalk({ title: card.title, text: card.text }),
          new Promise<{ success: boolean; result: string }>(res => { timer = setTimeout(() => res({ success: false, result: '发送超时(5s)——网络慢或不可达,不再等待' }), 5000); }),
        ]);
        clearTimeout(timer);
        if (!sent.success) process.stderr.write(`[notify] 发送失败: ${String(sent.result).slice(0, 160)}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[notify] 挂点异常不拦主流程: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  output(result);
}

/** 构造 CLI 默认 HostConfig（workspace=cwd + 默认沙箱），供独立模式命令实例化 Engine/Dispatcher。见 [[hop-cli#^anc-struct-hop-cli]] */
// 引擎自有工具执行体工厂注册（执行主体原则 2026-09-05——组合根注入,engine 不越层 import
// tools-composite;body 消化路径经此构造 provider 直执。直执面=内置两成员∪hopjit.yaml 注册件
// （0076 补齐注入半边——工厂内现读,engine 零感知;构造/解析错误经消化路径 catch 折步骤 fail）。
// ^anc-exec-tool-request 分派判据四条款）
// @a: anc-exec-tool-request
ExecutionEngine.setEngineToolProviderFactory(
  // 项目根取本 run 的 HostConfig.workspace_dir（`run --workspace WS` 从别处 cwd 起跑时 WS 的 hopjit.yaml 才是项目级文件,
  // ^anc-cli-workspace-arg;review 面二 A 真机 INIT_FAILED 复现）;home 仍在组合根读一次。两级 tool_servers（todo/0131） // @a: anc-config-reuse-consume
  makeEngineToolProviderFactory(hc => loadToolRegistry(reuseConfigPaths(hc.workspace_dir), hc.workspace_dir)),
);

// 复用模式 call 的 callee 路径解析注册（两级:调用方同目录 → ~/.hopjit/ants/<id>/<id>.md;家目录读在组合根）。
// 引擎拿它把 init_command / launch_command 里的 callee 位置填成真实路径。^anc-exec-callee-resolver // @a: anc-exec-callee-resolver
ExecutionEngine.setCalleeSpecResolver((callerSpecPath, calleeId, workspaceDir) => resolveCalleeSpecPath(dirname(callerSpecPath), antRoots(homedir(), workspaceDir), calleeId));   // 两级 HopAnt 根：项目级取本实例工作区（^anc-hopant-home 决策 9）;不做 process.cwd 兜底——引擎传空串只在 hostConfig 缺席时,空串直传等价只查用户级（exec-engine ^anc-exec-callee-resolver）
// commit 批准账位置（^anc-exec-commit-approval / ^anc-hopant-commit-store）:HopAnt 记在 ant 目录 inner_store,
// 任务卡记在 run 根旁（.hopstate/commit_approvals.json）。规则唯一真身在 hopant.commitApprovalStorePath,mcp-server 同注册。
// @a: anc-exec-commit-approval
ExecutionEngine.setCommitApprovalStoreResolver((specPath, instanceDir, workspaceDir) => commitApprovalStorePath(antRoots(homedir(), workspaceDir), specPath, dirname(findRunRoot(instanceDir))));

/** 顶层 run/init 起跑依赖核：不过时输出 INIT_FAILED 响应并返回 false（调用方直接 return,不建实例）。
 * 判定在 hopant.checkRunDeps,这里只取注册面与家目录。^anc-cli-run-deps-gate // @a: anc-cli-run-deps-gate */
function runDepsGate(content: string, specAbsPath: string, workspaceDir: string): boolean {
  const { sysPath, projPath } = reuseConfigPaths(workspaceDir);   // 项目级按工作区根读（^anc-cli-workspace-arg）;路径唯一来源 config-load.configPaths // @a: anc-config-reuse-consume, anc-struct-config-load-exports
  const reg = loadTwoLevelRegistry(sysPath, projPath);
  const rep = checkRunDeps(content, specAbsPath, { roots: antRoots(homedir(), workspaceDir), tool_servers: reg.tool_servers });
  if (rep.ok) return true;
  const lines = [...rep.tools.missing.map(t => `工具没有注册 ${t}`), ...rep.tools.errors, ...rep.calls.missing.map(c => `call 目标找不到 ${c}`), ...rep.calls.unreadable];
  const message = `INIT_FAILED 依赖核:${lines.join(';')}`;
  // 与引擎 init 失败同形（status:error + errors[] 带 rule INIT_FAILED,退出码 0 走业务错误通道）,另带三个结构化字段
  output({
    status: 'error', error_code: 'INIT_FAILED', message,
    errors: [{ kind: 'validate', rule: 'INIT_FAILED', severity: 'error', message }],
    missing_tools: rep.tools.missing, missing_calls: rep.calls.missing, hints: rep.hints,
  });
  return false;
}

// --max-runs 文法核:非正整数响亮拒,不静默当缺省（与 log_level 同姿势）。见 ^anc-obs-log-retention // @a: anc-obs-log-retention
function parseMaxRuns(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`--max-runs 须为正整数（实际: ${String(raw)}）\n`);
    process.exit(2);
  }
  return n;
}

/** `--approve-dirs`：起跑即把 Config.dirs 清单记进批准账,跳过 dirs 停点——写参数的人就是批准的人（脚本 / CI 场景）。
 * 实例没有 workspace 外目录时什么都不做（INVALID_STATE 不是错,是无需批）。见 [[hop-cli#^anc-cli-approve-dirs]]。 */ // @a: anc-cli-approve-dirs
export function approveDirsIfFlagged(engine: ExecutionEngine, flagged: boolean | undefined): void {
  if (!flagged) return;
  const st = engine.checkDirsApproval();
  if (!st || st.approved) return;
  const r = engine.approveDirs(st.dirs_hash);
  if (r.status === 'error') errorExit(r.message);
}

/** run / init 的 `--workspace <dir>` 解析：缺席返 cwd（既有行为零改动）;显式值绝对路径 normalize、相对路径按 cwd
 * 解析,不存在或不是目录即 errorExit WORKSPACE_NOT_FOUND（报文形态与 mcp-server start_run 同款——只接受显式
 * 路径,不做搜索）。工作区此前只由进程 cwd 隐式决定,CC 会话里用户看不见 cwd、Bash cd 过别处它还会变,作者
 * 2026-10-07 问"复用模式下的 cwd 是哪儿来的"后补齐与独立模式 workspace_dir 对称的一半。
 * 见 [[hop-cli#^anc-cli-workspace-arg]]。 */ // @a: anc-cli-workspace-arg
export function resolveWorkspaceArg(arg: string | undefined, cwd: string = process.cwd()): string {
  if (arg === undefined) return cwd;
  const p = isAbsolute(arg) ? normalize(arg) : resolve(cwd, arg);
  let isDir = false;
  try { isDir = statSync(p).isDirectory(); } catch { /* 不存在 */ }
  if (!isDir) errorExit(`WORKSPACE_NOT_FOUND: workspace 不存在（${p}）——只接受显式路径,不做搜索`);
  return p;
}

/** 构造 CLI 默认 HostConfig（workspace=cwd 或 --workspace 显式值+默认沙箱+项目级 commands/language 键读取）——复用模式
 * 组合根,独立模式命令实例化 Engine/Dispatcher 同用;tool_registry 不在此装配,归工厂内现读〔0076〕。
 * 见 [[hop-cli#^anc-struct-hop-cli]]。（出口注释沿革:2026-09-04 review 抓缺补;2026-09-06 review 抓
 * 0076 批插函数把本注释顶开挂错主后合并归位） */
export function buildHostConfig(workspaceDir: string = process.cwd()): HostConfig {
  // 工作区根=本 run 唯一一次定（缺省读 cwd;run/init 的 --workspace 显式传则用它,^anc-cli-workspace-arg）。
  // sandbox.filesystem.workspace_dir 必须与 workspace_dir 同值且是绝对路径——
  // 原 '.' 存进 state.json 后在每个续推 hopjit 进程里按该进程 cwd 重新展开,driver cd 进 work_zone 敲 submit
  // 即把 commit 写权限边界带偏（2026-10-04 三翻译 worker 全被 Write outside workspace sandbox 拒;MCP 侧
  // 2026-08-20 同款已改）。见 [[sandbox#^anc-config-sandbox-workspace-root]]。// @a: anc-config-sandbox-workspace-root
  const hc: HostConfig = {
    workspace_dir: workspaceDir,
    sandbox: {
      filesystem: { workspace_dir: workspaceDir, read_access: { allowed: ['.'],
        // 默认拒读基线：密钥/凭证类即使在 workspace 内也拦（sandbox.md 读权限优先级
        // denied > allowed；2026-08-08 语义审计 ❌ 实抓：设计一贯示例含 .env/*.key,
        // 代码 denied=[] 致默认部署下凭证文件对 LLM read 工具可读）。// @a: anc-config-sandbox-filesystem
        denied: ['.env', '.env.*', '*.key', '*.pem', '.hopstate/**', '.hoplog/**'], confirm_required: [] } },   // .hoplog（#50:LLM 逛日志树 read 巨型 main.yaml 灌爆上下文,dr19 实撞）
      network: { trusted_hosts: [] },
      runtime: { available: [] },   // 下方 applyReuseConfig 按两级合并结果填（^anc-exec-subprocess-run 配置通路） // @a: anc-exec-subprocess-run
    },
    language: 'en',   // 占位,applyReuseConfig 按键值或系统语言填（^anc-i18n-language-config,todo/0160） // @a: anc-i18n-serialize-lang
    hop_env: { hop_env_language: 'en' },   // 占位,同上由 applyReuseConfig 覆盖
    api_key: process.env['HOPJIT_ANTHROPIC_API_KEY'] ?? '',
  };
  // 复用模式两级配置（todo/0131——此前只读项目级三个单键,系统级 ~/.hopjit/config.yaml 一个键都不读）：
  // 系统级 + 项目级合并,commands / language / env / resource_limits 四样装入;容错两档——读坏回缺省并 stderr 一行,
  // commands 含 hopjit 响亮抛（CONFIG_ERROR）。家目录与 HOPJIT_CONFIG 在本组合根读一次。// @a: anc-config-reuse-consume
  const { config, warnings } = loadReuseConfig(reuseConfigPaths(workspaceDir));
  for (const w of warnings) process.stderr.write(`${w}\n`);
  applyReuseConfig(hc, config);
  return hc;
}

/** 组合根读进程状态装管理面上下文（设计 HopSchema AdminContext,[[mcp-server#^anc-mcp-admin-tools]]）：cwd 缺省进程 cwd;login 取不到为空串。 */ // @a: anc-mcp-admin-tools
function adminContext(cwd: string = process.cwd()): AdminContext {
  let login = '';
  try { login = userInfo().username; } catch { /* 容器里可能取不到 */ }
  const home = homedir();
  return { home, cwd, env: process.env, exec_path: process.execPath, login, hostname: hostname(), roots: antRoots(home, cwd) };
}

/** 复用模式两级配置路径（组合根算一次：home / HOPJIT_CONFIG / 工作区根）。 */ // @a: anc-config-reuse-consume
function reuseConfigPaths(workspaceDir: string) {
  return configPaths(homedir(), workspaceDir, process.env['HOPJIT_CONFIG'] || undefined);
}

/** 复用模式组合根的 hop_env 合成：--params 里 hop_env_* 键摘出入 HostConfig.hop_env（覆盖链
 * "调用方 params 传入"级——复用模式无 config.yaml 加载面,配置两级合并属 standalone 组合根）;
 * 摘出项从业务 params 删除（它是环境参数不是 spec 输入）;值为绝对路径的声明根同扩 sandbox
 * read allowed（写参即授权,与 mcp-server startRun 同款）。见 [[doc-ref#^anc-exec-doc-ref-hop-env]]。
 * // @a: anc-config-hop-env, anc-exec-doc-ref-hop-env */
export function extractHopEnvIntoHostConfig(hostConfig: HostConfig, params: Record<string, unknown> | undefined): void {
  if (!params) return;
  const hopEnv: Record<string, string> = {};
  for (const k of Object.keys(params)) {
    if (k.startsWith('hop_env_')) {
      // 凭证禁入三级闸之 params 级（0004,复用模式半边——与 standalone 同判）
      if (credentialLikeHopEnvKey(k)) errorExit(hopEnvCredentialError(k, 'params'));
      if (typeof params[k] === 'string') hopEnv[k] = params[k] as string;
      delete params[k];
    }
  }
  if (Object.keys(hopEnv).length === 0) return;
  hostConfig.hop_env = { ...(hostConfig.hop_env ?? {}), ...hopEnv };
  for (const v of Object.values(hopEnv)) {
    if (isAbsolute(v) && !hostConfig.sandbox.filesystem.read_access.allowed.includes(v)) {
      hostConfig.sandbox.filesystem.read_access.allowed.push(v);
    }
  }
}

/** 子实例继承的 Config.dirs 清单：父经 launch_command / init_command 的参数文件以保留键 DECLARED_DIRS_PARAM 透传,
 * 组合根摘出进 EngineOptions.inheritedDirs（不是 Inputs,从 params 删掉）。见 [[exec-engine#^anc-exec-dirs-grant]] 子实例与恢复条。 */ // @a: anc-exec-dirs-grant
export function extractInheritedDirs(params: Record<string, unknown> | undefined): DeclaredDirs | undefined {
  if (!params || !(DECLARED_DIRS_PARAM in params)) return undefined;
  const v = params[DECLARED_DIRS_PARAM]; delete params[DECLARED_DIRS_PARAM];
  return v && typeof v === 'object' && Array.isArray((v as DeclaredDirs).read) ? v as DeclaredDirs : undefined;
}

/** context 精简档 resolve：env HOPJIT_CONTEXT_MODE > --context-mode flag > 默认 full。见 [[prompt-assembler#^anc-exec-context-mode]] */
export function resolveContextMode(flag?: string): 'full' | 'minimal' {
  const v = (process.env['HOPJIT_CONTEXT_MODE'] || flag || '').toLowerCase();   // 空串视同未设,与 MCP 驱动工具同（^anc-exec-context-mode）
  return v === 'minimal' ? 'minimal' : 'full';
}

// === Commands ===

// 执行前合法性校验——只读，不创建实例。返回 error+warn 全集。
// 见 [[HopSpec V3配套HopJIT运行时能力#^anc-exec-validation]]
program.command('validate <spec>')
  .description('Validate spec legality without creating an instance')
  .option('--fragment', 'Validate a bare step fragment (no header/Steps heading required)')   // 片段模式 // @a: anc-rule-fragment-mode
  .option('--known-vars <names>', 'Comma-separated upstream variable names available to the fragment')
  .action((specPath: string, opts: { fragment?: boolean; knownVars?: string }) => {
    try {
      const content = readFileSync(resolve(specPath), 'utf-8');
      const { ast, errors: parseErrors } = opts.fragment ? parseFragment(content) : parseSpec(content);
      // 解析错误即 error 级，无法继续验证规则
      if (parseErrors.length > 0) {
        output({ status: 'error', errors: parseErrors as SpecError[], warnings: [] });
        return;
      }
      // P15 文件访问上下文：validate 命令必须递（2026-08-20 实撞立——原恒传 undefined,P15 静默
      // 跳过,坏 doc-ref 报"通过"假绿;init 期才响亮,两入口判定面撕裂）。基准与注入期同判:
      // spec 目录优先/cwd（workspace）兜底;沙箱=宽读闸（validate 只核存在性,无执行面）。
      // fragment 无文件身份,维持缺席跳过。见 spec-parser ^anc-rule-p15。// @a: anc-rule-p15
      const docRefCtx = opts.fragment ? undefined : {
        workspace_dir: process.cwd(),
        // spec 目录入 allowed——与 init 组合点"随 spec 引用即授权"同款（spec 可在 cwd 外）;沙箱根恒绝对路径（^anc-config-sandbox-workspace-root,单进程语境也不留 '.' 写法）
        sandbox: { filesystem: { workspace_dir: process.cwd(), read_access: { allowed: ['.', dirname(resolve(specPath))], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
        spec_dir: dirname(resolve(specPath)),
        lenient_cross_dir: true,   // validate 时点 cwd 是猜测非运行期权威——跨目录"文件未找到"降 warn
      };
      const all = validateSpec(ast, docRefCtx, opts.fragment
        ? { fragment: true, knownVars: opts.knownVars ? opts.knownVars.split(',').map(s => s.trim()).filter(Boolean) : [] }
        : undefined);
      const errors = all.filter((e: ValidationError) => e.severity === 'error');
      const warnings = all.filter((e: ValidationError) => e.severity !== 'error');  // warn+info 同入提示桶
      output({
        status: errors.length > 0 ? 'error' : 'ok',
        errors: errors as SpecError[],
        warnings: warnings as SpecError[],
      });
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// lang：关键词语言转换（备份后原地改写,行级手术——^anc-i18n-language-config 转换工具条款;首名 i18n-convert 作者抓'太复杂'改短）。// @a: anc-i18n-language-config
program.command('lang <spec>')
  .description('Convert spec keywords between zh/en in place (backup first; line surgery, non-keyword bytes untouched)')
  .requiredOption('--to <lang>', 'Target keyword language: zh | en')
  .action((specPath: string, opts: { to: string }) => {
    try {
      if (opts.to !== 'zh' && opts.to !== 'en') errorExit(`--to 只认 zh|en,收到 '${opts.to}'`);
      const abs = resolve(specPath);
      const original = readFileSync(abs, 'utf-8');
      // 转换前 validate 基线（errors 数——转换不引病判据）
      const before = parseSpec(original);
      const beforeErrs = before.errors.length > 0 ? before.errors.length : validateSpec(before.ast).filter(e => e.severity === 'error').length;
      const converted = convertSpecKeywords(original, opts.to as 'zh' | 'en');
      const after = parseSpec(converted);
      const afterErrs = after.errors.length > 0 ? after.errors.length : validateSpec(after.ast).filter(e => e.severity === 'error').length;
      if (afterErrs !== beforeErrs) {
        errorExit(`转换引病拒写回: 转换前 ${beforeErrs} error → 转换后 ${afterErrs} error(原件未动,无备份产生)——请报 hopissues 附本 spec`);
      }
      if (converted === original) {
        output({ status: 'ok', changed_lines: 0, backup: null, note: '关键词已是目标语言,零改动零备份' });
        return;
      }
      // 备份（已存在加序号不覆盖）,后写回
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      let bak = `${abs}.bak.${stamp}`;
      for (let i = 2; existsSync(bak); i++) bak = `${abs}.bak.${stamp}.${i}`;
      writeFileSync(bak, original, 'utf-8');
      writeFileSync(abs, converted, 'utf-8');
      const changed = original.split('\n').reduce((n, l, i) => n + (l !== converted.split('\n')[i] ? 1 : 0), 0);
      output({ status: 'ok', changed_lines: changed, backup: bak });
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// schema-sep：HopSchema 名/类型分隔符 `:` → ` % ` 原地迁移（todo/0109 第 2 步;形态仿 lang——先备份、
// 行级手术、转换引病拒写回）。写回前三道核对:①错误数不增 ②剥 source_location/colon_separators 后
// AST 相等 ③无定位失败行且转换后零冒号分隔符。见 design/hop-cli.md ^anc-cli-schema-sep。// @a: anc-cli-schema-sep
program.command('schema-sep <spec>')
  .description("Migrate HopSchema name/type separators from ':' to ' % ' in place (backup first; separators only, other bytes untouched)")
  .action((specPath: string) => {
    try {
      const abs = resolve(specPath);
      const original = readFileSync(abs, 'utf-8');
      const errCount = (r: ReturnType<typeof parseSpec>) =>
        r.errors.length > 0 ? r.errors.length : validateSpec(r.ast).filter(e => e.severity === 'error').length;
      const before = parseSpec(original);
      const beforeErrs = errCount(before);
      const { text: converted, changed_lines, unmatched_lines } = convertSchemaSeparators(original);
      const after = parseSpec(converted);
      const afterErrs = errCount(after);
      const refuseTail = '(原件未动,无备份产生)——请把这份 spec 附到 hopissues 报告';
      // 核对①：转换前已有的错误不算转换的锅,只拦增量（同 lang 的基线对照）
      if (afterErrs > beforeErrs) {
        errorExit(`转换引病拒写回（核对①错误数增加）: 转换前 ${beforeErrs} error → 转换后 ${afterErrs} error${refuseTail}`);
      }
      // 核对②：只换了分隔符,语义一点不许变。②a 剥掉行号、分隔符记录、内容章节后两份 AST 逐字段相等
      // （narrative_sections 是非关键字 ## 节的原文字节收集——声明区写在这类节下时节原文含声明行,
      // 随分隔符改动而变是预期内的）;②b 字节层兜底:有差异的行必须恰好是转换前 parser 记录的
      // 冒号分隔符行,行数也不许变——不信转换函数自报的改动清单,用 parser 记录独立核对。
      const strip = (ast: unknown) => JSON.stringify(ast, (k, v) =>
        (k === 'source_location' || k === 'colon_separators' || k === 'narrative_sections') ? undefined : v);
      if (strip(before.ast) !== strip(after.ast)) {
        errorExit(`转换引病拒写回（核对②转换前后 AST 不等,改写越出了分隔符）${refuseTail}`);
      }
      const origLines = original.split('\n');
      const convLines = converted.split('\n');
      const expectedLines = new Set((before.ast.header.colon_separators ?? []).map(x => x.line));
      const strayLines = convLines.length !== origLines.length ? ['行数变了']
        : origLines.flatMap((l, i) => (l !== convLines[i] && !expectedLines.has(i + 1)) ? [String(i + 1)] : []);
      if (strayLines.length > 0) {
        errorExit(`转换引病拒写回（核对②改动越出了冒号分隔符行: ${strayLines.slice(0, 10).join(', ')}）${refuseTail}`);
      }
      // 核对③：该改没改成的行=转换不完整
      const leftover = after.ast.header.colon_separators ?? [];
      if (unmatched_lines.length > 0 || leftover.length > 0) {
        const ls = [...new Set([...unmatched_lines, ...leftover.map(x => x.line)])].sort((a, b) => a - b).join(', ');
        errorExit(`转换不完整拒写回（核对③仍有冒号分隔符未改成,第 ${ls} 行）${refuseTail}`);
      }
      if (converted === original) {
        output({ status: 'ok', changed_lines: 0, backup: null, note: '没有用冒号的分隔符,零改动零备份' });
        return;
      }
      // 备份（时间戳=UTC 年月日时分秒 14 位;已存在加序号不覆盖）,后写回
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      let bak = `${abs}.bak.${stamp}`;
      for (let i = 2; existsSync(bak); i++) bak = `${abs}.bak.${stamp}.${i}`;
      writeFileSync(bak, original, 'utf-8');
      writeFileSync(abs, converted, 'utf-8');
      output({ status: 'ok', changed_lines: changed_lines.length, backup: bak });
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// list <dir>：扫目录列可执行 spec（无状态纯函数）。判定规则见 design/hop-cli.md ^anc-cli-list // @a: anc-cli-list
program.command('list <dir>')
  .description('List executable HopSpec files in a directory (no state, no instance)')
  .action((dir: string) => {
    try {
      const dirAbs = resolve(dir);
      const entries = readdirSync(dirAbs).filter(f => f.endsWith('.md')).sort();
      const specs: Array<{ file: string; id: string; goal: string }> = [];
      for (const file of entries) {
        const full = join(dirAbs, file);
        let content: string;
        try { content = readFileSync(full, 'utf-8'); } catch { continue; }
        // 排除设计文档：@trace 头 / design/ 路径 / impl 段
        if (content.includes('%% @trace') || full.includes(sep + 'design' + sep) || content.includes('## impl ')) continue;   // 设计目录排除按 path.sep（0057 家族——原硬编码正斜杠 win32 失效,0086 续账修）// @a: anc-cli-list
        const { ast, errors: parseErrors } = parseSpec(content);
        if (parseErrors.length > 0) continue;                 // 解析失败跳过
        const goal = (ast.header.goal ?? '').trim();
        const hasSteps = (ast.steps?.length ?? 0) > 0;
        if (!goal || !hasSteps) continue;                     // 非可执行 spec
        const goalFirst = goal.split(/[\n。.]/)[0].trim();    // Goal 首句
        specs.push({ file, id: (ast.header.id ?? ast.header.title ?? '').trim(), goal: goalFirst });
      }
      output({ status: 'ok', dir, specs } as ListResponse);
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

program.command('init <spec>')
  .description('Parse spec and initialize execution instance')
  .option('--params <json>', 'Spec inputs as JSON or @file')
  .option('--parent <id>', 'Parent instance ID')
  .option('--step <id>', 'Call step ID')
  .option('--child-instance <id>', 'Call child instance ID (dir <parent>/calls/<id>/; defaults to --step; engine gives <step>.<iters> inside loops)')
  .option('--parallel-parent <id>', 'Parent instance ID (for parallel child subinstance)')
  .option('--parallel-child <id>', 'Parallel child step ID (subinstance落 <parent>/parallel/<id>/)')
  .option('--trace <id>', 'Trace ID')
  .option('--upstream-feedback <text>', 'Parent-layer revision feedback for call child, text or @file (D41 reuse-mode leg — engine renders it as L5 upstream entry)')
  .option('--workspace <dir>', 'Workspace root (default: cwd; explicit path must exist — ^anc-cli-workspace-arg)')
  .option('--approve-dirs', 'Approve the Config.dirs directory list at init (skip the dirs pause — ^anc-cli-approve-dirs)')
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .option('--log-dir <dir>', 'Log directory for .hoplog output')
  .option('--log-level <level>', 'Log level: debug | info | warn (default info)')
  .option('--max-runs <n>', 'Keep at most N run dirs under the log dir, oldest pruned before this run (default 3)')
  .action((specPath: string, opts) => {
    try {
      const content = readFileSync(resolve(specPath), 'utf-8');
      const hostConfig = buildHostConfig(resolveWorkspaceArg(opts.workspace));   // @a: anc-cli-workspace-arg
      let params = resolveParam(opts.params) as Record<string, unknown> | undefined;
      extractHopEnvIntoHostConfig(hostConfig, params);   // @a: anc-config-hop-env
      const inheritedDirs = extractInheritedDirs(params);   // @a: anc-exec-dirs-grant
      // 子实例（复用模式）两类：call → <stateDir>/<parent>/calls/<step>/；parallel → <parent>/parallel/<child>/
      const callMode = opts.parent && opts.step; // @a: anc-step-call
      const isParallelChild = !!(opts.parallelParent && opts.parallelChild); // @a: anc-exec-parallel-subinstance
      const childParent = callMode ? opts.parent : isParallelChild ? opts.parallelParent : undefined;
      // call 子实例 ID 与步骤号分开传（hopissues/0098）：--child-instance 定目录,缺席回退 --step;
      // 参数映射恒按 --step 取（下方 resolveCallParams）。// @a: anc-exec-call-child-iter-id
      const childStep = callMode ? (opts.childInstance ?? opts.step) : isParallelChild ? opts.parallelChild : undefined;
      const subdir = callMode ? 'calls' : 'parallel';
      const effectiveStateDir = (callMode || isParallelChild)
        ? join(opts.stateDir, childParent, subdir)
        : opts.stateDir;
      if (callMode) {
        // 父实例号来自 --parent 参数（driver 拼/抄）——同 --instance 的手抄误差面,同经
        // resolveInstance 做在场校验（review 面二抓:初版收纯只在 --instance 通路,本通路
        // 直调 load 绕过校验,错号父实例仍报 CORRUPT_STATE_FILE 旧病）。
        // @a: anc-cli-instance-resolve
        const parentDir = resolveInstance(opts.stateDir, childParent);
        // 运行时 call-depth 检查：目录层级即调用链深度——父实例路径里的 calls/ 祖先数 + 本次 = 深度。
        // 超限不建子实例（父层按步骤失败走升级链）。见 design/exec-engine.md ^anc-exec-call-depth-check。
        // @a: anc-exec-call-depth-check
        const parentEngine = ExecutionEngine.load(parentDir);
        // 只数 stateDir 参数内的 calls/ 段（嵌套时 driver 传 --state-dir .hopstate/<root>/calls/...），
        // 不数 cwd 绝对路径——用户工程路径里恰好叫 calls 的目录不算深度
        const depth = join(opts.stateDir, childParent).split(/[\\/]/).filter(seg => seg === 'calls').length + 1;
        const maxDepth = hostConfig.resource_limits?.max_call_depth ?? 10;
        if (depth > maxDepth) {
          errorExit(`DEPTH_EXCEEDED: call 深度 ${depth} 超上限 ${maxDepth}（resource_limits.max_call_depth）——不创建子实例`);
        }
        // engine 侧 Inputs 自动映射：引擎按 param_mapping 从父 vars 取值；显式 --params 项优先
        // （caller 可覆盖，信任 caller）。见 design/exec-engine.md ^anc-exec-call-auto-map。
        // @a: anc-exec-call-auto-map
        const autoParams = parentEngine.resolveCallParams(opts.step);
        if (Object.keys(autoParams).length > 0) params = { ...autoParams, ...(params ?? {}) };
      }
      const engineOpts: EngineOptions = {
        // resolve 绝对化（与 run 入口对称,2026-08-14 review 实抓）：instanceDir 派生自它,
        // call_protocol/launch_command 载荷内 state-dir 取 dirname(instanceDir)——相对路径
        // 会被折进跨进程照抄的命令,driver 换 cwd 执行即落错目录。// @a: anc-exec-call-protocol-payload
        stateDir: resolve(effectiveStateDir),
        // 路径身份两字段与 run 入口对称（hopissues/0076——init 漏传即:doc-ref 首级解析目录
        // 错位到 cwd〔跨目录 init 报 16 条 P15 文件未找到〕+buildCallProtocol 任一缺席返
        // undefined〔嵌套 call 响应不带 call_protocol,子实例无标准协议可续〕）。
        // @a: anc-cli-init-response, anc-exec-call-protocol-payload
        specPath: resolve(specPath),
        cliAbsPath: resolve(fileURLToPath(import.meta.url)),
        ...(params ? { params } : {}),
        ...(inheritedDirs ? { inheritedDirs } : {}),   // @a: anc-exec-dirs-grant
        ...(opts.logDir ? { logDir: resolve(opts.logDir) } : {}),   // 与 run 路径同：绝对化入账,活账反查按绝对路径比对（review 面二缺陷 5）
        ...(opts.logLevel ? { logLevel: opts.logLevel } : {}),
        ...(opts.maxRuns !== undefined ? { maxRuns: parseMaxRuns(opts.maxRuns) } : {}),   // @a: anc-obs-log-retention
        ...((callMode || isParallelChild) ? { parentInstanceId: childParent, callStepId: childStep } : {}),
        ...(isParallelChild ? { canFanout: false, subtreeRoot: opts.parallelChild } : {}),
        ...(opts.trace ? { traceId: opts.trace } : {}),
        driverChannel: 'cli',   // 双执行硬闸落账 // @a: anc-exec-driver-channel
              ...(opts.upstreamFeedback ? { upstreamFeedback: resolveTextParam(String(opts.upstreamFeedback)) } : {}),   // H2 复用半边（D41）——init_command 携带,汇入 standalone 同一注入口;引擎烘焙恒 @<反馈文件>（^anc-exec-cmd-args-file） // @a: anc-exec-l2c-retry-feedback, anc-exec-cmd-args-file
      };

      // 顶层实例起跑依赖核（call/parallel 子实例不核——父实例起跑时已核过整棵 call 树）^anc-cli-run-deps-gate
      if (!callMode && !isParallelChild && !runDepsGate(content, resolve(specPath), hostConfig.workspace_dir)) return;
      const engine = new ExecutionEngine();
      const result = engine.initExecution(content, hostConfig, engineOpts);

      if (result.status === 'ok') approveDirsIfFlagged(engine, opts.approveDirs);   // @a: anc-cli-approve-dirs
      output(result);
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// run = init + 推进到首个 caller 介入点（引擎 completeAndAdvance 节奏）。// @a: anc-cli-dispatch, anc-exec-parallel-subinstance
// 支持 --parallel-parent/--parallel-child 创建 worker 子实例并推进（worker 一条命令完成 init+advance）。
program.command('run <spec>')
  .description('Init and advance to first caller-action point or terminal (combines init + advance)')
  .option('--params <json>', 'Spec inputs as JSON or @file')
  .option('--parallel-parent <id>', 'Parent instance ID (for parallel worker subinstance)')
  .option('--parallel-child <id>', 'Parallel child step ID (worker scope)')
  .option('--call-parent <id>', 'Parent instance ID (for call child subinstance——统一模型 call parallel worker)')
  .option('--call-step <id>', 'Call child instance ID（<step>.<iter>,目录 calls/<ci>/）')
  .option('--workspace <dir>', 'Workspace root (default: cwd; explicit path must exist — ^anc-cli-workspace-arg)')
  .option('--approve-dirs', 'Approve the Config.dirs directory list at start (skip the dirs pause; the person writing this flag is the approver — ^anc-cli-approve-dirs)')
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .option('--log-dir <dir>', 'Log directory for .hoplog output')
  .option('--log-level <level>', 'Log level: debug | info | warn (default info)')
  .option('--max-runs <n>', 'Keep at most N run dirs under the log dir, oldest pruned before this run (default 3)')
  .option('--context-mode <mode>', 'Context verbosity: full (default) | minimal (see ^anc-exec-context-mode)')
  .option('--notify <channel>', 'Notify channel at terminal/paused states (currently: dingtalk; persisted into instance state; ^anc-cli-notify-reuse)')
  .action(async (specPath: string, opts) => {
    try {
      const content = readFileSync(resolve(specPath), 'utf-8');
      const hostConfig = buildHostConfig(resolveWorkspaceArg(opts.workspace));   // @a: anc-cli-workspace-arg

      const isWorker = !!(opts.parallelParent && opts.parallelChild);
      // call parallel worker（统一模型 §U8）：callee spec 全量执行,子实例落 calls/<ci>/——
      // 与 parallel worker 的差别仅目录与无子树收窄。// @a: anc-exec-parallel-reuse-protocol
      const isCallWorker = !!(opts.callParent && opts.callStep);
      // call worker 深度检查（review 抓漏：init --parent 有而本入口没有）：目录 calls/ 段数
      // 即调用链深度，同 ^anc-exec-call-depth-check 判据。// @a: anc-exec-call-depth-check
      if (isCallWorker) {
        const depth = join(opts.stateDir, opts.callParent).split(/[\\/]/).filter(seg => seg === 'calls').length + 1;
        const maxDepth = hostConfig.resource_limits?.max_call_depth ?? 10;
        if (depth > maxDepth) {
          errorExit(`DEPTH_EXCEEDED: call 深度 ${depth} 超上限 ${maxDepth}（resource_limits.max_call_depth）——不创建子实例`);
        }
        // 两协议混用闸（2026-08-14 e2e 实撞）：--state-dir 尾段已是 <call-parent>/calls
        // = 驱动方把协议 A（init --parent 后对 <STATE>/<INST>/calls 标准循环）的目录喂给了
        // 本入口——本入口自拼 <parent>/calls/,再喂即双重嵌套,子实例跑死野目录。// @a: anc-exec-call-depth-check
        const sdSegs = opts.stateDir.replace(/[\\/]+$/, '').split(/[\\/]/);
        if (sdSegs.length >= 2 && sdSegs[sdSegs.length - 1] === 'calls' && sdSegs[sdSegs.length - 2] === opts.callParent) {
          errorExit(`CALL_PROTOCOL_MISUSE: --state-dir 已指向 '${opts.callParent}/calls'——run --call-parent 会自拼该层级,再喂即双重嵌套。两条协议二选一：init --parent 建的子实例用标准循环驱动（--state-dir <STATE>/<INST>/calls --instance <子ID>）；run --call-parent 只用于引擎派发的 launch_command（--state-dir 传顶层 <STATE>）`);
        }
        // 父实例号在场校验——恒在深度/协议两闸之后（两闸是路径静态判,报文各自指路更准;本闸只管
        // "号抄错/父不存在":0086 续账③实撞,错号父实例静默建 state/<错号>/calls/<ci> 野目录树零报错。
        // 设计 ^anc-cli-instance-resolve 全通路收纯承诺 2026-09-01 点名本通路,init --parent 同批修了本入口漏网。
        // @a: anc-cli-instance-resolve
        resolveInstance(opts.stateDir, opts.callParent);
      }
      const effectiveStateDir = isWorker
        ? join(opts.stateDir, opts.parallelParent, 'parallel')
        : isCallWorker
          ? join(opts.stateDir, opts.callParent, 'calls')
          : opts.stateDir;
      // worker 启动入口也走裸 @file 隔离：--params @裸名 重定向到本 child work_zone，
      // 与 submit_and_fetch_next 同规则，消除共享 cwd 竞态。// @a: anc-cli-parallel-file-isolation
      const runWorkZoneBase = isWorker
        ? join(opts.stateDir, opts.parallelParent, 'parallel', opts.parallelChild, 'work_zone')
        : undefined;
      const params = resolveParam(opts.params, runWorkZoneBase) as Record<string, unknown> | undefined;
      extractHopEnvIntoHostConfig(hostConfig, params);   // 子实例经 launch_command params 透传父表,同一组合根摘出 // @a: anc-config-hop-env
      const inheritedDirs = extractInheritedDirs(params);   // @a: anc-exec-dirs-grant

      // for-each worker 的 itemVar 经引擎单一权威、driver 透传的 --params 注入——
      // worker 不翻父实例自播种（破隔离+权威倒置，已撤；缺 itemVar 由 engine init 硬校验报错）。
      // 见 design/parallel-execution.md §9e ^anc-exec-parallel-foreach-worker。// @a: anc-exec-parallel-foreach-worker

      const engineOpts: EngineOptions = {
        stateDir: resolve(effectiveStateDir),
        canFanout: !isWorker && !isCallWorker,
        specPath: resolve(specPath),
        cliAbsPath: resolve(fileURLToPath(import.meta.url)),
        ...(isWorker ? { subtreeRoot: opts.parallelChild, parentInstanceId: opts.parallelParent, callStepId: opts.parallelChild, traceId: opts.parallelParent } : {}), // @a: anc-obs-trace-inherit
        ...(isCallWorker ? { parentInstanceId: opts.callParent, callStepId: opts.callStep, traceId: opts.callParent } : {}),
        ...(params ? { params } : {}),
        ...(inheritedDirs ? { inheritedDirs } : {}),   // @a: anc-exec-dirs-grant
        // HopLog 恒开（缺省 <state-dir>/../.hoplog，同 driver 模板约定与 mcp-server 先例）——
        // 轨迹是 G11 核真过程的凭证，不能依赖 driver LLM 记得传参（2026-08-08 E2E 实撞：
        // subagent 漏抄模板参数即无轨迹假红）。--log-dir 仍可显式改址。// @a: anc-obs-hoplog-always-on
        logDir: resolve(opts.logDir ?? join(opts.stateDir, '..', '.hoplog')),
        ...(opts.logLevel ? { logLevel: opts.logLevel } : {}),
        ...(opts.maxRuns !== undefined ? { maxRuns: parseMaxRuns(opts.maxRuns) } : {}),   // @a: anc-obs-log-retention
        contextMode: resolveContextMode(opts.contextMode),  // env > flag > full。 // @a: anc-exec-context-mode
        driverChannel: 'cli',   // 双执行硬闸落账 // @a: anc-exec-driver-channel
      };
      // 顶层实例起跑依赖核（worker 子实例不核）^anc-cli-run-deps-gate
      if (!isWorker && !isCallWorker && !runDepsGate(content, resolve(specPath), hostConfig.workspace_dir)) return;
      const engine = new ExecutionEngine();
      const initResult = engine.initExecution(content, hostConfig, engineOpts);
      if (initResult.status !== 'ok') { output(initResult); return; }
      approveDirsIfFlagged(engine, opts.approveDirs);   // @a: anc-cli-approve-dirs
      // 统一模型渐进派发（§U8）：顶层实例开门（worker/call 子实例不开——嵌套退化串行不变式）。
      // driver 收 dispatch_ready 起后台 worker + advance 续推。// @a: anc-exec-parallel-reuse-protocol
      if (!isWorker && !isCallWorker) engine.setUnifiedDispatch(true);
      // --notify <渠道> 置值入快照（^anc-cli-notify-reuse——子实例不置:通知归顶层 run,worker 不发;
      // 渠道枚举闸:非法值启动即拒响亮报枚举,不静默漂过——用户以为会响的手机永远不响） // @a: anc-cli-notify-reuse
      if (opts.notify && !isWorker && !isCallWorker) {
        if (opts.notify !== 'dingtalk') {
          errorExit(`--notify 渠道 '${opts.notify}' 不支持——可用渠道: dingtalk`);
        }
        engine.notifyChannel = opts.notify;
      }
      const result = await engine.advanceToCaller();
      await outputWithNotify(result, engine);
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// submit_and_fetch_next：driver 主循环唯一应答命令——交活 + 领取下一指令（一次原子往返）。
// 提交内容由互斥参数区分；回写成功则 completeAndAdvance 推进返回 NextResponse，出错原样返回不推进。
// 节奏归引擎，见 design/exec-engine.md ^anc-exec-advance-to-caller。// @a: anc-cli-dispatch
program.command('submit_and_fetch_next <step-id>')
  .description('Submit step result and fetch next caller-action point (driver main loop)')
  .option('--output <json>', 'Step result (reason/check/act) as a JSON object keyed by output name, e.g. \'{"listing": "..."}\', or @file')
  .option('--answer <json>', 'HITL reply (confirm/ask) as a JSON object, e.g. \'{"value":"approve"}\', or @file')
  .option('--child-instance <id>', 'Call child instance ID (maps callee outputs back)')
  .option('--failure-child <id>', 'Call child instance ID that FAILED (engine assembles CalleeFailure from child state)')
  .option('--failure <text>', 'Step failure reason')
  .option('--replan <md>', 'Replanned children markdown or @file (for adaptive_needed)')
  .option('--proactive', '主动计划编辑（不经失败,/hop 边跑边改——只编未执行部分,^anc-exec-replan-proactive）')
  .option('--extend-expansion', '展开超限续批（EXPANSION_LIMIT 后经真人批准重交——一次授权放行一次,^anc-exec-subtask-free-expand 契约7）')
  .option('--tool-result <json>', 'Single tool result (answers tool_request) as JSON or @file')
  .option('--instance <id>', 'Instance ID')
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .action(async (stepId: string, opts) => {
    try {
      // 互斥校验：一次只提交一种
      // 没有 branch 形态：选路只由引擎按 case 条件求值,调用方不替引擎选 case。// @a: anc-exec-branch-select-internal
      const modes = ['output', 'answer', 'childInstance', 'failureChild', 'failure', 'replan', 'toolResult']
        .filter(k => opts[k] !== undefined);
      if (modes.length > 1) {
        throw new Error(`INVALID_STATE: 互斥参数只能给一个，收到 [${modes.join(', ')}]`);
      }

      const instanceDir = resolveInstance(opts.stateDir, opts.instance);
      const engine = ExecutionEngine.load(instanceDir);
      engine.claimDriverChannel('cli');   // 双执行硬闸:跨通道推进拒（旧 run 缺席即认领）// @a: anc-exec-driver-channel
      // 渐进派发门跨进程重开：顶层实例（can_fanout=true 持久化）即开——worker 子实例不开。
      // @a: anc-exec-parallel-reuse-protocol
      if (engine.getCanFanout()) engine.setUnifiedDispatch(true);
      // can_fanout 已从 StateFile 恢复（顶层 true / worker false），无需显式设
      // parallel worker 裸 @file 重定向到本 child work_zone，消除共享 cwd 竞态。
      // @a: anc-cli-parallel-file-isolation
      const workZoneBase = workerWorkZone(instanceDir, opts.instance);

      // 按参数路由到回写方法 → 成功则 completeAndAdvance 推进；出错原样返回不推进。
      let writeResult: CommandResponse;
      if (opts.childInstance) {            // call 回填
        const childDir = join(instanceDir, 'calls', opts.childInstance);
        const childVars = flattenVars(readVars(childDir));
        // call 同界记账：子实例含已执行 commit → 父登记本 call 步退火（重跑 call=子内
        // commit 必重放）。子 state.json 的 committed_steps 即凭据。// @a: anc-exec-commit-anneal
        if ((readState(childDir).committed_steps ?? []).length > 0) engine.markCommitted(stepId);
        writeResult = engine.completeCallStep(stepId, childVars);
      } else if (opts.failureChild) {            // call 子实例失败 → 引擎读子实例状态组装 CalleeFailure
        // 对称 --child-instance 的机器通道（2026-08-09 fail 即异常定稿）：驱动方只报告子实例 ID，
        // 失败内核（FailRecord）由引擎从子实例 state.json 原封取——杜绝自由文本转述。// @a: anc-step-call
        const childDir = join(instanceDir, 'calls', opts.failureChild);
        const childState = readState(childDir);
        if ((childState.committed_steps ?? []).length > 0) engine.markCommitted(stepId);   // 失败子同守（子内 commit 已发生）// @a: anc-exec-commit-anneal
        const childSpec = readSpec(childDir) as { header?: { id?: string } };
        writeResult = engine.failCallStep(stepId, {
          specId: childSpec.header?.id ?? 'unnamed',
          childInstanceId: opts.failureChild,
          stepFailReasons: (childState.step_fail_reasons ?? {}) as Record<string, import('./runtime-types.js').StepFailRecord>,
          stepStates: childState.step_states,
          retryHistory: childState.retry_history,
        });
      } else if (opts.failure !== undefined) {   // 步骤失败
        const reason = resolveTextParam(opts.failure, workZoneBase) ?? opts.failure;
        writeResult = engine.failStep(stepId, reason);
      } else if (opts.replan !== undefined) {    // 重规划 children
        const stepsMd = resolveTextParam(opts.replan, workZoneBase) ?? opts.replan;
        // 片段编号归一（P2-2 裁定 A——复用模式驱动侧 LLM 同有沿用原步骤号倾向,与 standalone
        // 管线同一宽容度;幂等,已连号产物不变。^anc-rule-fragment-mode）
        writeResult = engine.submitReplan(stepId, flattenFragmentNumbering(stepsMd), (opts.proactive || opts.extendExpansion) ? { ...(opts.proactive ? { proactive: true } : {}), ...(opts.extendExpansion ? { extendExpansion: true } : {}) } : undefined);
      } else if (opts.toolResult !== undefined) { // tool_request 应答：注入单工具结果，重放续跑
        // @a: anc-exec-tool-request
        if (opts.toolResult.startsWith('@')) assertOutputInWorkZone(opts.toolResult, instanceDir, workZoneBase);
        writeResult = engine.submitToolResult(stepId, resolveParam(opts.toolResult, workZoneBase));
      } else {                                    // 普通输出 / confirm answer
        // output / answer 互斥（前面 modes 校验保证），取非空的那个解析
        // 提交越界校验：--output @file 的路径必须在本执行单元 work_zone 内，越界拒绝（防串台）。
        // @a: anc-cli-file-arg-safety
        if (opts.output !== undefined) assertOutputInWorkZone(opts.output, instanceDir, workZoneBase);
        const raw = opts.output ?? opts.answer;
        const parsed = raw ? resolveParam(raw, workZoneBase) : undefined;
        // 解析结果必须是对象（todo/0146 probe 3 实撞:--answer '"approve"' 进引擎 'decision' in 字符串抛 TypeError）——
        // 在调引擎之前按用法错误拒,状态不动。见 [[hop-cli#^anc-cli-json-io]]。// @a: anc-cli-json-io
        if (raw && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
          const flag = opts.output !== undefined ? '--output' : '--answer';
          const shape = flag === '--answer' ? `'{"value":"approve"}'（或 '{"value":"<用户给的值>"}'）` : `'{"<输出槽名>": <值>}'`;
          errorExit(`INVALID_ARG: ${flag} 解析后须是 JSON 对象（收到 ${parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed}）——正确形态 ${shape}`);
          return;
        }
        const outputs = parsed as Record<string, unknown> | undefined;
        // 升层应答专用消化路（^anc-exec-check-escalate——CLI 半边,与 dispatcher.resume 对称:
        // guidance 回注反馈通道不走 completeStep 声明匹配）// @a: anc-exec-check-escalate
        if (engine.getEscalatePending() === stepId && opts.answer !== undefined) {
          const guidance = String(((outputs?.['guidance'] ?? outputs?.['value'])) ?? '');
          writeResult = engine.resumeFromEscalation(stepId, guidance);
        } else {
          // 走 completeAndAdvance 真身而非手拼 completeStep+advance（hopissues/0056——
          // 幂等重发的 ALREADY_DONE 短路住在 completeAndAdvance 里,手拼路径绕开它:
          // probe 实撞 CLI 幂等重发仍借道 WAITING_WRITEBACK 的 failed 壳,直调引擎的
          // 测试全绿假象。本函数头注释原本就写"completeAndAdvance 推进",代码如实归位）。
          // @a: anc-exec-stale-resubmit
          const resp = await engine.completeAndAdvance(stepId, outputs);
          if (resp.status === 'ok' || resp.status === 'error') { output(resp); return; }   // ALREADY_DONE 短路/出错不推进
          await outputWithNotify(resp as NextResponse, engine);   // @a: anc-cli-notify-reuse
          return;
        }
      }

      if (writeResult.status !== 'ok') { output(writeResult); return; }   // 出错不推进
      const next = await engine.advanceToCaller();
      await outputWithNotify(next, engine);   // 复用模式通知挂点（^anc-cli-notify-reuse） // @a: anc-cli-notify-reuse
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// 旧通道命令已删（P0.5 统一模型）：join_parallel / fanout-plan / fanout-next——静态
// fan-out→批量窗口→单点 join 通道随 loop 头 parallel 文法废除整体退役；复用模式并行
// 由 P2 渐进协议（dispatch_ready/drain_wait 交 driver）恢复。见 parallel-execution §U7。

// reap_and_fetch_next：统一模型收割命令（§U8 复用模式渐进协议）——worker 终态后 driver 报告
// id+成败，引擎读子实例目录收割（输出/FailRecord 机器通道自取）+ advanceToCaller 一次原子往返。
// @a: anc-exec-parallel-reuse-protocol
program.command('reap_and_fetch_next <child-instance>')
  .description('统一模型收割：读子实例目录收割输出/失败 + 领取下一介入点（复用模式渐进派发）')
  .option('--status <status>', 'Child terminal status: completed | failed', 'completed')
  .option('--instance <id>', 'Instance ID')
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .action(async (childInstance: string, opts) => {
    try {
      if (opts.status !== 'completed' && opts.status !== 'failed') {
        errorExit(`INVALID_ARG: --status 须为 completed | failed（收到 '${opts.status}'）`);
        return;
      }
      const instanceDir = resolveInstance(opts.stateDir, opts.instance);
      const engine = ExecutionEngine.load(instanceDir);
      engine.claimDriverChannel('cli');   // 双执行硬闸 // @a: anc-exec-driver-channel
      engine.setUnifiedDispatch(true);   // 复用模式渐进派发场景本命令专用——续推可能吐下一个 dispatch_ready
      engine.reconcileInflight({ dispatchLostPolicy: 'stale' });   // 复用模式对账：目录未建超宽限降级 stale 交 driver（引擎判不了 driver 起没起,2026-08-13 分道）// @a: anc-exec-parallel-inflight-reconcile
      engine.reapFromChildDir(childInstance, opts.status);
      await outputWithNotify(await engine.advanceToCaller(), engine);   // ^anc-cli-notify-reuse // @a: anc-cli-notify-reuse
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// advance：dispatch_ready 后续推主线（advanceToCaller 薄壳，仅渐进派发场景）。// @a: anc-exec-parallel-reuse-protocol
program.command('advance')
  .description('续推主线到下一介入点（dispatch_ready 之后使用；常规驱动用 run/submit_and_fetch_next）')
  .option('--instance <id>', 'Instance ID')
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .action(async (opts) => {
    try {
      const instanceDir = resolveInstance(opts.stateDir, opts.instance);
      const engine = ExecutionEngine.load(instanceDir);
      engine.claimDriverChannel('cli');   // 双执行硬闸 // @a: anc-exec-driver-channel
      engine.setUnifiedDispatch(true);
      engine.reconcileInflight({ dispatchLostPolicy: 'stale' });   // 复用模式对账：dispatch-lost 降级 stale（同上,2026-08-13 分道）// @a: anc-exec-parallel-inflight-reconcile
      await outputWithNotify(await engine.advanceToCaller(), engine);   // ^anc-cli-notify-reuse // @a: anc-cli-notify-reuse
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// debug_step：调试用——纯推进一步、不消化纯计算 body、不自动 advance。正常驱动用 run + submit_and_fetch_next。
program.command('debug_step')
  .description('[DEBUG] Advance exactly one step (no body consumption, no auto-advance). Normal driving uses run + submit_and_fetch_next')
  .option('--instance <id>', 'Instance ID')
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .action((opts) => {
    try {
      const instanceDir = resolveInstance(opts.stateDir, opts.instance);
      const engine = ExecutionEngine.load(instanceDir);
      engine.claimDriverChannel('cli');   // 双执行硬闸——调试命令同样改状态,不豁免（0086 审计抓漏）// @a: anc-exec-driver-channel
      const result = engine.nextStep();
      output(result);
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// 实例主动中止（^anc-cli-abort——一命令一方法,路由 ExecutionEngine.abort;加载走 load 保留现场,
// 中止不需要 recover 的悬空重置。契约 [[exec-engine#^anc-exec-abort]]）。// @a: anc-cli-abort
program.command('abort')
  .description('Abort a non-terminal instance (irreversible; snapshot/hoplog preserved for inspection)')
  .option('--instance <id>', 'Instance ID')
  .option('--reason <text>', 'Abort reason (recorded in state for audit)')
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .action((opts) => {
    try {
      const instanceDir = resolveInstance(opts.stateDir, opts.instance);
      const engine = ExecutionEngine.load(instanceDir);
      engine.claimDriverChannel('cli');   // 双执行硬闸 // @a: anc-exec-driver-channel
      const result = engine.abort(opts.reason);
      output(result);
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// commit 转人工后的批准 CLI 入口（^anc-cli-approve-commit——本宿主不注册安全分析函数,需要模型判的动作按模板转人工;与 MCP 工具 approve_commit 同一引擎方法、同一批准账;
// 加载走 load 不认领通道,两种通道的 run 都可批;只记账不推进,批准后 resume 续跑。权威 [[exec-engine#^anc-exec-commit-approval]]）
// @a: anc-cli-approve-commit
program.command('approve_commit <step-id>')
  .description('Approve a [commit] step after the safety analysis referred it to a human (scope once|task); then resume')
  .requiredOption('--fingerprint <fp>', 'fingerprint from presented_data.context of the commit pause')
  .requiredOption('--scope <scope>', 'once (this run only) | task (always for this step while its body is unchanged)')
  .option('--instance <id>', 'Instance ID')
  .option('--state-dir <dir>', 'State directory (relative to --workspace)', '.hopstate')
  .option('--workspace <dir>', 'Workspace root the run was started on (default: cwd); must exist')
  .action((stepId: string, opts) => {
    try {
      const ws = resolveWorkspaceArg(opts.workspace);   // 与 run/init 同一解析,显式路径不存在 → WORKSPACE_NOT_FOUND
      const engine = ExecutionEngine.load(resolveInstance(resolve(ws, opts.stateDir), opts.instance));
      output(engine.approveCommit(stepId, opts.fingerprint, opts.scope));   // scope 非 once/task 由引擎回 INVALID_STATE
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// Config.dirs 清单批准的 CLI 入口（^anc-cli-approve-dirs——与 MCP 工具 approve_dirs 同一引擎方法、同一批准账 dirs_approvals.json;
// 人批准由 driver 在对话里问——先把清单呈给用户问同不同意,同意后才跑本命令;载体弹窗不当批准）。// @a: anc-cli-approve-dirs
program.command('approve_dirs <dirs-hash>')
  .description('Approve the Config.dirs directory list once (dirs_hash from the pause payload); then resume')
  .option('--instance <id>', 'Instance ID')
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .action((dirsHash: string, opts) => {
    try {
      const engine = ExecutionEngine.load(resolveInstance(opts.stateDir, opts.instance));
      output(engine.approveDirs(dirsHash));
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

program.command('status')
  .description('Get execution status')
  .option('--instance <id>', 'Instance ID')
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .action((opts) => {
    try {
      const instanceDir = resolveInstance(opts.stateDir, opts.instance);
      const engine = ExecutionEngine.load(instanceDir);
      const result = engine.getStatus();
      output(result);
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// tool-call：复用模式特殊工具执行通道（0054 ^anc-step-tool-grant——act free 的 driver 经此
// 调引擎内建/注册工具:引擎实现是唯一语义源,driver 不用 Bash 模仿。外挂 MCP 件已注册进
// driver 环境时建议直连,本命令兜底。requires_commit 工具恒拒——act 语境无 commit 授权,
// 与 body 通道同闸;工具面=Composite 全量(内建+项目 hopjit.yaml tool_servers 注册件)。）
// @a: anc-step-tool-grant
program.command('tool-call <name>')
  .description('Invoke a registered hop tool directly (reuse-mode channel for special tools)')
  .option('--args <json>', 'Tool arguments as JSON object (use @file for large payloads)', '{}')
  .action(async (name: string, opts: { args: string }) => {
    try {
      const hostConfig = buildHostConfig();
      // 两级 tool_servers 注册面装配（与消化路径直执面同一公共函数 loadToolRegistry——
      // todo/0131 两级;坏节 fail-fast 由 parseToolServers 承担）// @a: anc-config-reuse-consume
      try {
        const reg = loadToolRegistry(reuseConfigPaths(hostConfig.workspace_dir), hostConfig.workspace_dir);   // tool-call 无 --workspace,buildHostConfig 缺省即 cwd // @a: anc-config-reuse-consume
        if (reg) {
          (hostConfig as HostConfig & { tool_registry?: unknown }).tool_registry = reg;
        }
      } catch (e) {
        output({ status: 'error', code: 'CONFIG_ERROR', message: `hopjit.yaml tool_servers 解析失败: ${e instanceof Error ? e.message : String(e)}` });
        process.exitCode = 1; return;
      }
      const provider = new CompositeToolProvider(hostConfig);
      const def = provider.list().find((t: { name: string }) => t.name === name);
      if (!def) {
        output({ status: 'error', code: 'UNKNOWN_TOOL', message: `工具 '${name}' 未注册——可用: ${provider.list().map((t: { name: string }) => t.name).join(', ')}` });
        process.exitCode = 1; return;
      }
      if (def.requires_commit) {
        output({ status: 'error', code: 'COMMIT_REQUIRED', message: `工具 '${name}' 声明 requires_commit——act 语境不可调（不可逆动作归 commit 步骤 body）` });
        process.exitCode = 1; return;
      }
      const argText = opts.args.startsWith('@') ? readFileSync(resolve(opts.args.slice(1)), 'utf-8') : opts.args;
      const args = JSON.parse(argText) as Record<string, unknown>;
      const r = await provider.execute(name, args);
      output(r.success ? { status: 'ok', result: r.result } : { status: 'error', code: 'TOOL_FAILED', message: String(r.result ?? 'tool failed') });
      if (!r.success) process.exitCode = 1;
    } catch (err) {
      output({ status: 'error', code: 'TOOL_CALL_ERROR', message: err instanceof Error ? err.message : String(err) });
      process.exitCode = 1;
    }
  });

program.command('vars')
  .description('Get all variable values')
  .option('--instance <id>', 'Instance ID')
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .action((opts) => {
    try {
      const instanceDir = resolveInstance(opts.stateDir, opts.instance);
      const engine = ExecutionEngine.load(instanceDir);
      const result = engine.getVars();
      output(result);
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

program.command('resume')
  .description('Resume execution from crash or pause (recover + advance to next caller-action point)')
  .option('--instance <id>', 'Instance ID')
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .action(async (opts) => {
    try {
      const instanceDir = resolveInstance(opts.stateDir, opts.instance);
      // 崩溃恢复：重置悬空 running，落盘。resume 是唯一用 recover 的命令，其余命令用 load
      // （保留 running——复用模式下 running 是"已交付 caller 待回写"的合法持久态）。
      // 见 design/hop-cli.md ^anc-cli-state-load。// @a: anc-cli-state-load
      const engine = ExecutionEngine.recover(instanceDir);
      engine.claimDriverChannel('cli');   // 双执行硬闸 // @a: anc-exec-driver-channel
      const result = await engine.advanceToCaller();        // 推进到下一个 caller 介入点
      await outputWithNotify(result, engine);   // ^anc-cli-notify-reuse // @a: anc-cli-notify-reuse
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// 载体 home 解析（^anc-cli-carrier-home-resolution,2026-09-02 cfuse 内置载体适配）：
// carrier 扩展为 cc|codex|cfuse-cc|cfuse-codex。cc/codex 读官方环境变量 CLAUDE_CONFIG_DIR/CODEX_HOME
// （自动适配当前环境——cfuse 内置 cc/codex 通过这两个变量把 home 重定向到 ~/.codefuse/engine/{cc,codex}）;
// cfuse-cc/cfuse-codex 固定 ~/.codefuse/engine/{cc,codex}（裸终端显式指定 cfuse 目标,不读环境变量——
// 裸终端跑 install-skill 时目标 agent 可能未启动,环境变量无法表达"装给谁",须显式 carrier 声明目标）。
// driver 源用 carrierFamily 派生（cc|codex）——cfuse-* 复用对应原生源,不新写 driver。
// 载体名、载体 home 解析、自动探测、版本戳读取、MCP 注册判定、握手、放行缺口、归属标识等助手 2026-10-10 todo/0154 搬到 hop-admin.ts（hop-cli 模块出口文件,mcp-server 也要用）;
// 本文件只保留 setup 自己的写半边与各命令薄壳。tests 既有的导入面经下方 re-export 保持可达。// @a: anc-mcp-admin-tools

// 首次运行提示（^anc-cli-first-run-hint,todo/0143 撤 postinstall 钩子后的唯一兜底）：用户只敲了 npm install -g 没敲 setup,
// 本包第一个有代码在跑的时机就是下一条 hopjit 命令。纯函数七支——只算出那一行,写 stderr 与否由 preAction 钩子做;
// 零状态（装过就有版本戳）、不自动装（用户环境拦安装脚本正说明不希望包自作主张改东西）。// @a: anc-cli-first-run-hint
const FIRST_RUN_EXEMPT = new Set(['setup', 'install-skill', 'doctor']);   // doctor 与 setup 同豁免：体检命令不自己提示自己（^anc-cli-doctor）
/** 算出首次运行提示那一行（空串=不提示）：豁免 setup/版本/帮助 → 静音与 CI → 零载体 → 逐载体读版本戳 → 有未装指路 setup / 只落后指路刷新。见 [[hop-cli#^anc-cli-first-run-hint]]。 */ // @a: anc-cli-first-run-hint
export function firstRunHint(argv: readonly string[], env: NodeJS.ProcessEnv, engineVersion: string,
  probe: (c: Carrier) => string | null = c => installedHopDriverVersion(adminContext(), c)): string {
  const sub = argv.find(a => !a.startsWith('-'));
  if (!sub || FIRST_RUN_EXEMPT.has(sub)) return '';
  if (argv.some(a => a === '--version' || a === '-V' || a === '--help' || a === '-h')) return '';
  if (env.HOPJIT_SKIP_SKILL === '1' || env.CI) return '';
  const carriers = detectCarriers(adminContext());
  if (carriers.length === 0) return '';
  const missing: string[] = []; const stale: string[] = [];
  for (const c of carriers) {
    const v = probe(c);
    if (v === null) missing.push(c);
    else if (v !== engineVersion) stale.push(`${c} 装于 v${v}`);
  }
  if (missing.length) return `[hopjit] /hop 还没装进本机 agent（${missing.join(', ')}）——运行 hopjit setup;静音：HOPJIT_SKIP_SKILL=1`;
  if (stale.length) return `[hopjit] /hop 版本落后（${stale.join('、')},当前 v${engineVersion}）——重跑 hopjit setup 刷新;静音：HOPJIT_SKIP_SKILL=1`;
  return '';
}

/** --carrier 取值校验（载体名全集 CARRIER_VALUES 在 hop-admin.ts）。 */ // @a: anc-cli-carrier-home-resolution
function assertCarrier(c: string, cmd: string): asserts c is Carrier {
  if (!CARRIER_VALUES.includes(c as Carrier))
    throw new Error(`${cmd}_ERROR: 未知 carrier '${c}'（支持: ${CARRIER_VALUES.join(' | ')}）`);
}

/** 自举 standalone 配置（setup 第 3 项职责）：已存在短路 → learnStandaloneEntry 学一条 → 写 ~/.hopjit/config.yaml（只写凭证变量名）。学习半边已抽成 learnStandaloneEntry 供 doctor 复用。 */ // @a: anc-cli-install-skill
export function bootstrapStandaloneConfig(carrier: Carrier): { written: string | null; note: string } {
  const sysPath = join(homedir(), '.hopjit', 'config.yaml');
  const projPath = resolve(process.cwd(), 'hopjit.yaml');
  if (existsSync(sysPath) || existsSync(projPath)) {
    return { written: null, note: `standalone 配置已存在（${existsSync(sysPath) ? sysPath : projPath}）——未改动（用户资产）` };
  }

  const learned = learnStandaloneEntry(adminContext(), carrier);
  if (!learned.entry) return { written: null, note: learned.note };
  const entry = learned.entry;

  mkdirSync(dirname(sysPath), { recursive: true });
  // providers 节走 YAML 序列化器——值来自宿主配置不可控,裸模板拼接遇 ": "/"#" 类字符产物
  // 即炸自家加载器（二审探针实抓:model 值含冒号空格 → loadStandaloneConfig bad indentation）
  const yaml = `# hopjit standalone 配置——hopjit setup 自举于 ${new Date().toISOString()}
# 学习源：${carrier === 'opencode' ? 'opencode 宿主配置文件（deep-merge config.json/opencode.json/opencode.jsonc,model + provider.<id>）' : carrierFamily(carrier) === 'cc' ? 'Claude Code 宿主环境变量（ANTHROPIC_*）' : 'Codex 宿主 config.toml（model_provider 链）'}
# 凭证只存环境变量名（${entry.api_key_env}）,值不落盘。格式与改法见 docs/reference/配置参考.md
` + yamlDump({ providers: [entry] }, YAML_DUMP_OPTS);   // @a: anc-config-yaml-dump-opts
  writeFileSync(sysPath, yaml, 'utf-8');
  return {
    written: sysPath,
    note: `已自举 standalone 缺省模型（学自${carrier === 'opencode' ? ' opencode 宿主配置文件（deep-merge config.json/opencode.json/opencode.jsonc）' : carrierFamily(carrier) === 'cc' ? ' Claude Code 宿主环境' : ' Codex 宿主配置'}）：model=${entry.model} / 端点=${entry.base_url} / 凭证=环境变量 ${entry.api_key_env}（只存名不存值）→ ${sysPath}。不合适可直接编辑该文件`,
  };
}

// Codex 注册 env_vars 的凭证名来源：系统级 standalone 配置 providers 的 api_key_env 并集。
// 读不到（缺席/坏文件/空表）返回 null,调用侧回落缺省对。见 hop-cli ^anc-cli-install-skill 注册条。
// @a: anc-cli-install-skill
export function readStandaloneCredentialNames(): string[] | null {
  const sysPath = join(homedir(), '.hopjit', 'config.yaml');
  if (!existsSync(sysPath)) return null;
  try {
    const cfg = yamlLoad(readFileSync(sysPath, 'utf-8')) as { providers?: { api_key_env?: unknown }[] };
    const names = [...new Set((cfg?.providers ?? [])
      .map(p => p?.api_key_env)
      .filter((n): n is string => typeof n === 'string' && n.trim() !== ''))];
    return names.length > 0 ? names : null;
  } catch { return null; }
}

/** CC 载体放行 hopjit 的 MCP 工具（^anc-cli-install-skill-permission;2026-10-01 首版只放行 run_approved_command,
 * 2026-10-07 todo/0146 扩为 HOPJIT_ALLOWED_TOOLS 清单）：Claude Code 对每个 MCP 工具调用缺省弹窗且只认工具名看不见参数——
 * 放行清单里的工具名=撤掉空闸,把关交给 hopjit 自己（任务卡闸、commit 批准、confirm/ask）。approve_commit 也在清单里——
 * commit 的人批准由 driver 在对话里问,载体弹窗不当批准闸。落点 <cwd>/.claude/settings.local.json 的 permissions.allow;幂等（缺的逐个补,
 * 全在则不动）;保留其他键与条目;坏 JSON 不写只报 note;只加精确工具名,不加通配、不加 Bash 规则、不动 deny。 */
// @a: anc-cli-install-skill-permission
/** CC 载体放行写入（^anc-cli-install-skill-permission）：缺口由 ccPermissionMissing 算（只读半边,doctor 共用）,本函数只做写与写失败降 note。 */ // @a: anc-cli-install-skill-permission
export function ensureCcPermission(cwd: string): { written: string | null; note?: string } {
  const gap = ccPermissionMissing(cwd);   // 查法=写法：缺口判定只此一处,doctor 问 6 调同一个（^anc-cli-doctor）
  const { path: p, missing, cfg, allow } = gap;
  if (gap.invalid) return { written: null, note: gap.invalid };
  if (missing.length === 0) return { written: null, note: `hopjit 工具已全部放行（${p}）,未改动` };
  const perms = (cfg['permissions'] as Record<string, unknown> | undefined) ?? {};
  perms['allow'] = [...allow, ...missing];
  cfg['permissions'] = perms;
  try {   // 环境性失败（目录不可写等）降 note,不让 skill 安装跟着失败——与注册面同律（review 测试'注册面环境性失败'实抓:注册 catch 住了,放行这里又炸整条安装）
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  } catch (e) {
    return { written: null, note: `放行写入失败（${e instanceof Error ? e.message : String(e)}）——请手动在 ${p} 的 permissions.allow 加 hopjit 工具 ${missing.join(', ')}` };
  }
  return { written: p };
}

/** 本器自带件的旧名（改过名的安装件）——陈旧扫描按自带件处置,不当用户自建件（^anc-cli-stale-skill-scan） */
const STALE_LEGACY_BUNDLED_NAMES = ['hopskill-build'];   // 2026-08 改名为 hopbuild（f66cc8cc）

/** 一次 setup 的陈旧副本备份区;root 首次挪动时才建 */
export interface StaleBackup { root: string }

/** 把陈旧副本整目录挪进备份区（^anc-cli-stale-skill-scan）：先 rename,跨文件系统改为复制后删除;
 * 撞名加 -2/-3 后缀;成功后在 RESTORE.txt 追加"备份路径 → 原路径"。任何一步失败原目录不动,返回错误说明。 */
// @a: anc-cli-stale-skill-scan
export function moveStaleToBackup(dir: string, backup: StaleBackup): { ok: true; dest: string } | { ok: false; error: string } {
  try {
    mkdirSync(backup.root, { recursive: true });
    const base = dir.split(sep).pop()!;
    let dest = join(backup.root, base);
    for (let i = 2; existsSync(dest); i++) dest = join(backup.root, `${base}-${i}`);
    try {
      renameSync(dir, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      cpSync(dir, dest, { recursive: true });
      rmSync(dir, { recursive: true, force: true });
    }
    appendFileSync(join(backup.root, 'RESTORE.txt'), `${dest} → ${dir}\n`, 'utf-8');
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 注册后的握手自检（^anc-cli-install-skill-handshake）：以当前 node 跑包内 server 走一遍 MCP 握手,另查注册 command 在 PATH 上
 * 能否找到。只报告不修改注册;失败不抛。 */


// 演示集：包内原件 → HopAnt id（作者定"demo 保留前缀"）。原件留在 examples/ 不动,装时生成 HopAnt 目录。
const DEMO_ANTS: { spec: string; id: string; asset?: string }[] = [
  { spec: 'coffee-week.md', id: 'demo-coffee-week', asset: 'coffee-sales.json' },
  { spec: 'fact-check-demo.md', id: 'demo-fact-check', asset: 'fact-check-sample.md' },
  { spec: join('syntax', 'confirm-commit.md'), id: 'demo-rename' },
];

// setup 第 7 项：三个演示件缺省装成 HopAnt（`<home>/.hopjit/ants/demo-*`,与载体无关）。
// 已存在的不读不写（--force 也不覆盖——inner_store 是本机状态）;失败只进 notes 不抛,不拦 skill 安装。
// 安装本身走 hopant 的 planInstall/applyInstall,与 `hopjit ant install` 同一条路径。
// 见 [[hop-cli#^anc-cli-install-skill-demo-ants]]。
// @a: anc-cli-install-skill-demo-ants
export function installDemoAnts(pkgRoot: string, home: string): { installed: string[]; notes: string[] } {
  const installed: string[] = [];
  const notes: string[] = [];
  for (const demo of DEMO_ANTS) {
    if (existsSync(antDir(antsRoot(home), demo.id))) {
      notes.push(`${demo.id} 已装，跳过（要刷新先 hopjit ant remove ${demo.id}）`);
      continue;
    }
    let tmp: string | undefined;
    try {
      tmp = mkdtempSync(join(tmpdir(), 'hopjit-demo-'));
      const srcDir = join(tmp, demo.id);
      mkdirSync(srcDir);
      const raw = readFileSync(join(pkgRoot, 'examples', demo.spec), 'utf-8');
      writeFileSync(join(srcDir, `${demo.id}.md`), rewriteSpecId(raw, demo.id), 'utf-8');
      if (demo.asset) copyFileSync(join(pkgRoot, 'examples', demo.asset), join(srcDir, demo.asset));
      applyInstall(planInstall(srcDir, antsRoot(home)));   // 演示件恒落用户级（hopant 决策 1）
      installed.push(demo.id);
    } catch (err: unknown) {
      notes.push(`${demo.id} 安装失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }
  return { installed, notes };
}

// 对外命令名 setup;install-skill 是隐藏别名（不进 --help,stderr 提示改名,保留一个版本周期——todo/0143）。
// 两个名字共用 defineSetupCommand 一处定义的选项与 action,不复制。
// @a: anc-cli-install-skill
function defineSetupCommand(name: 'setup' | 'install-skill'): void {
const isLegacyAlias = name === 'install-skill';
program.command(name, { hidden: isLegacyAlias })
  .description('Install the hop skills into every detected coding agent (Claude Code / Codex / opencode, native or cfuse) and register the hopjit MCP server')
  .option('--dir <target>', 'Skills root directory (default: resolved per carrier — cc/codex read CLAUDE_CONFIG_DIR/CODEX_HOME, cfuse-cc/cfuse-codex use ~/.codefuse/engine/{cc,codex}/skills, opencode uses ~/.config/opencode/skills)')
  .option('--carrier <carrier>', 'Driver carrier: cc | codex | cfuse-cc | cfuse-codex | opencode (default: auto-detect every carrier whose home directory exists; falls back to cc)')
  .addOption(new Option('--demo', 'Compatibility alias — the demo HopAnts are installed by default now (2026-10-06); passing this flag changes nothing').hideHelp())   // 隐藏的无作用参数,保留一个版本周期（^anc-cli-install-skill-demo-ants） // @a: anc-cli-install-skill-demo-ants
  .option('--plus', 'Also install the hop-fact-check and hop-deep-research research skills, and merge their tool_servers config into ~/.hopjit/config.yaml')
  .option('--mcp', 'Compatibility alias — MCP server registration and standalone config bootstrap now happen by default (2026-10-01); passing this flag changes nothing')   // 缺省即注册（作者定"缺省安装 mcp"）,flag 留作兼容别名 // @a: anc-cli-install-skill
  .option('--force', 'Overwrite existing files')
  .action((opts) => {
    // 旧名调用：stdout 与 setup 完全相同,只在 stderr 多一行改名提示（旧版 driver 仍会调旧名）// @a: anc-cli-install-skill
    if (isLegacyAlias) process.stderr.write('[hopjit] install-skill 已改名为 setup，请改用 hopjit setup（旧名将在后续版本移除）\n');
    try {
      // 包根 = cli.js（dist/cli.js）的 dist 的上一级
      const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const driverDir = join(pkgRoot, 'driver');
      if (!existsSync(driverDir)) {
        errorExit(`INSTALL_SKILL_ERROR: 包内未找到 driver/（${driverDir}）——确认包完整安装`);
        return;
      }
      // 载体选择三支（^anc-cli-carrier-autodetect）：显式 --carrier 只装那一个;--dir 给了目录却不知给谁,等价 cc（旧行为）;
      // 都没给→探测本机在场的载体逐个装,零探到回落 cc。// @a: anc-cli-carrier-autodetect
      let carriers: Carrier[];
      let detectNote: string | undefined;
      if (opts.carrier !== undefined) {
        assertCarrier(opts.carrier, 'INSTALL_SKILL');
        carriers = [opts.carrier as Carrier];
      } else if (opts.dir !== undefined) {
        carriers = ['cc'];
      } else {
        carriers = detectCarriers(adminContext());
        if (carriers.length === 0) {
          carriers = ['cc'];
          detectNote = '未探到任何载体 home（~/.claude / ~/.codex / ~/.config/opencode / ~/.codefuse）,按 Claude Code 装到 ~/.claude/skills;其他载体装好后重跑 hopjit setup 即自动补装';
        } else {
          detectNote = `自动探测到载体：${carriers.join(', ')}（要只装一个用 --carrier）`;
        }
      }
      const driverVersion = readPackageVersion();
      // 陈旧副本备份区:同一次 setup 的所有载体共用一个时间戳目录,首次需要挪动时才建（^anc-cli-stale-skill-scan）
      const staleBackup: StaleBackup = { root: join(homedir(), '.hopjit', 'stale-backup', new Date().toISOString().replace(/:/g, '-')) };

      // CC 系载体的注册决策按族算一次（^anc-cli-install-skill 注册条 (a)/(b)）：族=本机在场的全部 CC 系载体（home 目录存在,不只本次要装的——
      // --carrier 只装一个时其余仍参与"已注册感知"）。anyRegistered 为 true 走 (b)：不写 .mcp.json,缺注册的被装载体往自己的 .claude.json 写 local 级;
      // 为 false 走 (a)：写一次共用的 .mcp.json。// @a: anc-cli-install-skill
      // 族集合 = 本次要装的 CC 系载体 ∪ 本机探到的 CC 系载体（--dir 形态下 carriers 只有 cc 且 home 可能不在场,仍要查 cc 自己的 .claude.json）
      const ccFamilyPresent = [...new Set<'cc' | 'cfuse-cc'>([...carriers, ...detectCarriers(adminContext())].filter((c): c is 'cc' | 'cfuse-cc' => carrierFamily(c) === 'cc'))];
      const ccFamily = ccFamilyRegistration(adminContext(), ccFamilyPresent);
      const installOne = (carrier: Carrier): Record<string, unknown> => {
      // 目标按 carrier home 解析（^anc-cli-carrier-home-resolution）：cc/codex 读官方环境变量
      // CLAUDE_CONFIG_DIR/CODEX_HOME（自动适配当前环境,如 cfuse 内置载体重定向）;cfuse-cc/cfuse-codex
      // 固定 ~/.codefuse/engine/{cc,codex}/skills（裸终端显式指定 cfuse 目标）。--dir 覆盖。
      // 见 [[hop-cli#^anc-cli-carrier-home-resolution]]。
      const targetArg = opts.dir ?? join(resolveCarrierHome(adminContext(), carrier), 'skills');
      const target = isAbsolute(targetArg) ? targetArg : resolve(process.cwd(), targetArg);
      const installed: string[] = [];
      const force = opts.force === true;
      // 版本可见性：响应带 driver_version/driver_source；SKILL.md frontmatter 后注入版本戳注释——
      // 已装副本自身可查（head -5），不依赖安装时的响应。见 [[hop-cli#^anc-cli-install-skill]] 版本可见性条。
      const versionStamp = `<!-- driver: @hoplogic/hopjit v${driverVersion} (${pkgRoot}) installed ${new Date().toISOString()} -->`;

      const stampSkill = (source: string, src: string): string => {
        const newline = source.includes('\r\n') ? '\r\n' : '\n';
        const lines = source.split(/\r?\n/);
        if (lines[0] !== '---') {
          throw new Error(`INSTALL_SKILL_ERROR: ${src} 必须以 YAML frontmatter 开头`);
        }
        const frontmatterEnd = lines.indexOf('---', 1);
        if (frontmatterEnd < 0) {
          throw new Error(`INSTALL_SKILL_ERROR: ${src} 的 YAML frontmatter 未闭合`);
        }
        lines.splice(frontmatterEnd + 1, 0, versionStamp);
        return lines.join(newline);
      };

      // 拷贝 helper：目标存在且非 force → 跳过并记录；SKILL.md 注入版本戳
      const copyFile = (src: string, dst: string): boolean => {
        if (existsSync(dst) && !force) return false;
        mkdirSync(dirname(dst), { recursive: true });
        if (dst.endsWith('SKILL.md')) {
          writeFileSync(dst, stampSkill(readFileSync(src, 'utf-8'), src), 'utf-8');
        } else {
          copyFileSync(src, dst);
        }
        return true;
      };
      const copyDir = (src: string, dst: string): boolean => {
        if (existsSync(dst) && !force) return false;
        mkdirSync(dirname(dst), { recursive: true });
        cpSync(src, dst, { recursive: true });
        return true;
      };
      // 受管目录清理（--force 档,2026-08-13 实撞立契约;2026-08-24 hopissues/0022 判据改自有
      // 安装清单——原"源目录补集"把用户放在同目录的文件一并 rmSync〔probe 实证 my-note.md 被无声删,
      // dev-install 缺省带 --force 日常装机天然走此档〕。受管边界=清单不是目录：只删"上次
      // manifest 里有、本次源里已没有"的——自己上版装的陈旧残留照删（parallel-worker.md 残留
      // 喂废协议实撞立意保留）,不在任何 manifest 的文件=不是我写的=无权删。manifest 缺席
      // （首装/旧版装机）按空清单=零删除,本次落新 manifest 后下次恢复管辖。
      // 见 hop-cli ^anc-cli-install-skill 受管目录清理条。// @a: anc-cli-install-skill
      const MANIFEST_NAME = '.hopjit-manifest.json';
      const removed: string[] = [];
      const pruneManagedDir = (srcDirs: string[], dstDir: string, extraNames: string[] = []): void => {
        const sourceNames = new Set([
          ...srcDirs.flatMap(d => existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.md')) : []),
          ...extraNames,
        ]);
        if (force && existsSync(dstDir)) {
          let prev: string[] = [];
          const mfPath = join(dstDir, MANIFEST_NAME);
          if (existsSync(mfPath)) {
            try { prev = (JSON.parse(readFileSync(mfPath, 'utf-8')) as { files?: string[] }).files ?? []; }
            catch { prev = []; }   // 损坏按空清单=零删除（宁漏删不误删）
          }
          for (const f of prev) {
            if (!sourceNames.has(f) && f.endsWith('.md') && existsSync(join(dstDir, f))) {
              rmSync(join(dstDir, f));
              removed.push(join(dstDir, f));
            }
          }
        }
        // 每次装机（force 与否）落 manifest——本次源清单即下次清理的管辖面。内容逐字节不变时不写
        //（todo/0146 probe 3:CC 沙箱禁写 ~/.claude/skills,零安装的 setup 因重写同内容 manifest 撞 EPERM）
        if (existsSync(dstDir)) {
          const mfPath = join(dstDir, MANIFEST_NAME);
          const mfText = JSON.stringify({ version: readPackageVersion(), files: [...sourceNames].sort() }, null, 2);
          let same = false;
          try { same = existsSync(mfPath) && readFileSync(mfPath, 'utf-8') === mfText; } catch { same = false; }
          if (!same) writeFileSync(mfPath, mfText, 'utf-8');
        }
      };

      let codexLegacyPaths: string[] = [];   // 文案在陈旧扫描之后生成——被挪走的路径不再点名（^anc-cli-stale-skill-scan）
      const movedStale: string[] = [];
      if (carrier === 'opencode') {
        // opencode 载体（driver/opencode/ 自有内容层——2026-09-19 作者抓"opencode 完全复用 cc 的?"后立:
        // 0089 批只适配了路径与配置面,driver 正文逐字节搭 CC 车（AskUserQuestion/subagent 等 CC 原语
        // 30 处零适配,真机能通靠模型自由发挥非协议保证）。本分支装 driver/opencode/ 适配版
        //（原语映射权威 opencode-driver-carrier ^anc-driver-opencode-primitive-map）;
        // hopbuild 族照旧共装（构建件载体中立度高,v1 接受）;hop 件照装（2026-09-20 撤销首版
        // "不装"裁定——作者抓"在 codex /hop 都能用,为什么在 opencode 不装?",详下方装载段）。
        // @a: anc-driver-opencode-install-layout
        const skillDir = join(target, 'hopspec');
        if (copyFile(join(driverDir, 'opencode', 'SKILL.md'), join(skillDir, 'SKILL.md'))) installed.push(join(skillDir, 'SKILL.md'));
        if (copyFile(join(driverDir, 'opencode', 'SKILL-mcp.md'), join(target, 'hopspec-mcp', 'SKILL.md'))) installed.push(join(target, 'hopspec-mcp/SKILL.md'));
        if (copyFile(join(driverDir, 'opencode', 'references', 'discovery.md'), join(target, 'hopspec-mcp', 'references', 'discovery.md'))) installed.push(join(target, 'hopspec-mcp/references/discovery.md'));
        if (copyDir(join(driverDir, 'opencode', 'references'), join(skillDir, 'references'))) installed.push(join(skillDir, 'references/'));
        pruneManagedDir([join(driverDir, 'opencode', 'references')], join(skillDir, 'references'));
        for (const buildSkill of ['hopbuild', 'hopbuild2', 'hopfix'] as const) {
          if (copyDir(join(driverDir, '..', 'skills', buildSkill), join(target, buildSkill))) {
            installed.push(join(target, `${buildSkill}/`));
            const sk = join(target, buildSkill, 'SKILL.md');
            if (existsSync(sk)) {
              // 按 opencode-driver-carrier 原语映射（斜杠触发→隐式触发，见 driver/opencode/SKILL.md @trace note） // @a: anc-driver-opencode-install-layout
              // 把 CC 源的 /hopspec run 改写为隐式触发（装时改副本，不改 CC 源）。opencode 有斜杠命令系统
              // （每个 skill 注册为 /skillname，/hopspec run <spec> 经 prompt.ts（1.18.31）追加为 user 输入可工作），
              // 但 hopbuild SKILL.md 由 LLM 消费（用户调 hopbuild2 时 LLM 读它再调 hopspec skill），
              // LLM 经 skill 工具隐式触发更直接，斜杠形式需 LLM 自行翻译。
              let content = stampSkill(readFileSync(sk, 'utf-8'), sk);
              content = content.replace(/\/hopspec run /g, '用 hopspec skill 执行 ');
              writeFileSync(sk, content, 'utf-8');
            }
          }
        }
        if (copyFile(join(driverDir, '..', 'scripts', 'hopfix', 'hopfix.md'), join(target, 'hopfix', 'hopfix.md'))) {
          installed.push(join(target, 'hopfix/hopfix.md'));
        }
        // hop 件（2026-09-20 作者抓"在 codex /hop 都能用,为什么在 opencode 不装?"——撤销上一批
        // "v1 不装"裁定:Codex 先例已证 /hop 适配成本=三处载体差异,opencode 能力面只强不弱;
        // driver/opencode/hop-skill.md 照 codex 版适配,stale 清理与 carrier_note 随撤）。
        if (copyFile(join(driverDir, 'opencode', 'hop-skill.md'), join(target, 'hop', 'SKILL.md'))) {
          installed.push(join(target, 'hop/SKILL.md'));
        }
        if (copyFile(join(driverDir, 'opencode', 'hop-references', 'hop-ops.md'), join(target, 'hop', 'references', 'hop-ops.md'))) installed.push(join(target, 'hop/references/hop-ops.md'));   // 运维规则按需读件（^anc-cli-hop-dispatch） // @a: anc-cli-hop-dispatch
      } else if (carrierFamily(carrier) === 'codex') {
        // Codex 载体（codex | cfuse-codex,共用 codex driver 源）：main / segment driver 按 agent 主体拆分。
        // 只复用真正载体中立的 cli-discovery，其余 references 使用 Codex 自包含版本。
        // 装点=<target>/hopspec 直拼（2026-08-27 看齐批——target 即 skills 根,不再拼 .agents/skills 中间层）。
        // 见 design/codex-driver-carrier.md ^anc-driver-codex-install-layout。
        // @a: anc-driver-codex-install-layout
        const skillDir = join(target, 'hopspec');
        // 旧项目级残留检测（作者抓"项目级留着老skill只会造成版本冲突"——Codex 同名 project>user,
        // cwd 的 .agents/skills 旧件会永久盖住用户级新版=静默旧版锁定）：正式件残留响亮提示;
        // 不自动删（可能是用户有意的项目级钉版,删除权归人）。旧 demo-* skill 由陈旧扫描另报废弃。
        const legacyRoot = join(process.cwd(), '.agents', 'skills');
        if (resolve(legacyRoot) !== resolve(target)) {
          codexLegacyPaths = ['hopspec', 'hop'].filter(n => existsSync(join(legacyRoot, n, 'SKILL.md'))).map(n => join(legacyRoot, n));
        }
        // 双名双壳（2026-08-27 四改）：恒装两壳——$hopspec（复用）与 $hopspec-mcp（MCP 薄壳）
        // 不同名并存,名字即模式;配置自举+注册 server 缺省即做（2026-10-01）。// @a: anc-cli-install-skill
        if (copyFile(join(driverDir, 'codex', 'SKILL.md'), join(skillDir, 'SKILL.md'))) installed.push(join(skillDir, 'SKILL.md'));
        if (copyFile(join(driverDir, 'codex', 'SKILL-mcp.md'), join(target, 'hopspec-mcp', 'SKILL.md'))) installed.push(join(target, 'hopspec-mcp/SKILL.md'));
        if (copyFile(join(driverDir, 'codex', 'references', 'discovery.md'), join(target, 'hopspec-mcp', 'references', 'discovery.md'))) installed.push(join(target, 'hopspec-mcp/references/discovery.md'));

        const agentsDir = join(skillDir, 'agents');
        let wroteAgents = false;
        for (const file of readdirSync(join(driverDir, 'codex', 'agents')).filter(f => f.endsWith('.md'))) {
          wroteAgents = copyFile(join(driverDir, 'codex', 'agents', file), join(agentsDir, file)) || wroteAgents;
        }
        if (wroteAgents) installed.push(join(agentsDir, '/'));

        const refsDir = join(skillDir, 'references');
        let wroteRefs = false;
        for (const file of readdirSync(join(driverDir, 'codex', 'references')).filter(f => f.endsWith('.md'))) {
          wroteRefs = copyFile(join(driverDir, 'codex', 'references', file), join(refsDir, file)) || wroteRefs;
        }
        wroteRefs = copyFile(
          join(driverDir, 'references', 'cli-discovery.md'),
          join(refsDir, 'cli-discovery.md'),
        ) || wroteRefs;
        if (wroteRefs) installed.push(join(refsDir, '/'));
        pruneManagedDir([join(driverDir, 'codex', 'agents')], agentsDir);
        // codex references 源=codex/references ∪ 公共 cli-discovery（单文件从 CC 公共池借,须白名单——
        // 不能把整个 driver/references 当源:那会给 CC 专属文件〔driver-subagent 等〕开豁免）
        pruneManagedDir([join(driverDir, 'codex', 'references')], refsDir, ['cli-discovery.md']);
        // $hop 日常命令 Codex 变体（2026-08-26 作者定"补"——CC 装 hop 而 codex 缺席即载体不对等;
        // 单文件无 agents/references,布局契约 codex-driver-carrier ^anc-driver-codex-install-layout hop 件条款。
        // 版本戳由 copyFile 统一注入,不再手工补戳（CC hop 段曾双重打戳,本段不复制该病）
        if (copyFile(join(driverDir, 'codex', 'hop-skill.md'), join(target, 'hop', 'SKILL.md'))) {
          installed.push(join(target, 'hop/SKILL.md'));
        }
        if (copyFile(join(driverDir, 'codex', 'hop-references', 'hop-ops.md'), join(target, 'hop', 'references', 'hop-ops.md'))) installed.push(join(target, 'hop/references/hop-ops.md'));   // @a: anc-cli-hop-dispatch
        // 构建工具两件（hopissues/0052——载体中立件,修前 codex 分支漏拷致两载体清单不对等,
        // Codex 用户装完无 /hopbuild;与 CC 分支同源同戳:copyDir 拷入+SKILL.md 走 stampSkill）。
        // @a: anc-cli-install-skill
        if (copyDir(join(driverDir, '..', 'skills', 'hopbuild'), join(target, 'hopbuild'))) {
          installed.push(join(target, 'hopbuild/'));
          const hb = join(target, 'hopbuild', 'SKILL.md');
          if (existsSync(hb)) writeFileSync(hb, stampSkill(readFileSync(hb, 'utf-8'), hb), 'utf-8');
        }
        if (copyDir(join(driverDir, '..', 'skills', 'hopbuild2'), join(target, 'hopbuild2'))) {
          installed.push(join(target, 'hopbuild2/'));
          const hb2 = join(target, 'hopbuild2', 'SKILL.md');
          if (existsSync(hb2)) writeFileSync(hb2, stampSkill(readFileSync(hb2, 'utf-8'), hb2), 'utf-8');
        }
        // hopfix 定向修正器（todo/0093 件二——版本兼容三义务的迁移通道:validate error 清单为工单即批量迁移;
        // 壳+流程件同装:壳在 skills/hopfix,流程真源 scripts/hopfix/hopfix.md 拷入壳目录成自足件）。// @a: anc-cli-install-skill
        if (copyDir(join(driverDir, '..', 'skills', 'hopfix'), join(target, 'hopfix'))) {
          installed.push(join(target, 'hopfix/'));
          const hf = join(target, 'hopfix', 'SKILL.md');
          if (existsSync(hf)) writeFileSync(hf, stampSkill(readFileSync(hf, 'utf-8'), hf), 'utf-8');
          if (copyFile(join(driverDir, '..', 'scripts', 'hopfix', 'hopfix.md'), join(target, 'hopfix', 'hopfix.md'))) {
            installed.push(join(target, 'hopfix/hopfix.md'));
          }
        }
      } else {
        // CC 载体（默认）：hopspec-skill.md → hopspec/SKILL.md + references + skills/hopbuild/
        // 双名双壳（2026-08-27 四改）：恒装两壳——/hopspec（复用）与 /hopspec-mcp（MCP 薄壳）
        // 不同名并存,名字即模式;配置自举+注册 server 缺省即做（2026-10-01）。// @a: anc-cli-install-skill
        if (copyFile(join(driverDir, 'hopspec-skill.md'), join(target, 'hopspec', 'SKILL.md'))) installed.push(join(target, 'hopspec/SKILL.md'));
        if (copyFile(join(driverDir, 'hopspec-skill-mcp.md'), join(target, 'hopspec-mcp', 'SKILL.md'))) installed.push(join(target, 'hopspec-mcp/SKILL.md'));
        // MCP 壳只需 discovery 一件（spec 定位;执行协议件是复用壳专属,整目录拷贝会喂废协议）
        if (copyFile(join(driverDir, 'references', 'discovery.md'), join(target, 'hopspec-mcp', 'references', 'discovery.md'))) installed.push(join(target, 'hopspec-mcp/references/discovery.md'));
        if (copyDir(join(driverDir, 'references'), join(target, 'hopspec', 'references'))) installed.push(join(target, 'hopspec/references/'));
        pruneManagedDir([join(driverDir, 'references')], join(target, 'hopspec', 'references'));
        // hopbuild 住包内 skills/（2026-08-15 作者定:构建工具非载体驱动件,聚合目录防再挪伤筋动骨）
        if (copyDir(join(driverDir, '..', 'skills', 'hopbuild'), join(target, 'hopbuild'))) {
          installed.push(join(target, 'hopbuild/'));
          const hb = join(target, 'hopbuild', 'SKILL.md');
          if (existsSync(hb)) writeFileSync(hb, stampSkill(readFileSync(hb, 'utf-8'), hb), 'utf-8');
        }
        // hopbuild2 同批分发（^anc-build-layout2,2026-08-25 作者定"构建成完整 skill"——
        // v1/v2 并存,触发词分开;五文件同目录随行:spec 经 call 同目录寻址两分拆器,doc-ref 同目录读知识库）
        if (copyDir(join(driverDir, '..', 'skills', 'hopbuild2'), join(target, 'hopbuild2'))) {
          installed.push(join(target, 'hopbuild2/'));
          const hb2 = join(target, 'hopbuild2', 'SKILL.md');
          if (existsSync(hb2)) writeFileSync(hb2, stampSkill(readFileSync(hb2, 'utf-8'), hb2), 'utf-8');
        }
        // /hop 随手命令（2026-08-26,^anc-exec-replan-proactive 首个消费方——恒复用模式主对话自驱,
        // 与 hopspec 分工:成品重编排/随手轻自驱;单文件无 references）
        if (copyFile(join(driverDir, 'hop-skill.md'), join(target, 'hop', 'SKILL.md'))) {
          installed.push(join(target, 'hop/SKILL.md'));
          // 版本戳 copyFile 已注入——此前手工再戳一次造成双重戳（装出的 SKILL.md 两行 driver 注释,实证已修）
        }
        if (copyFile(join(driverDir, 'hop-references', 'hop-ops.md'), join(target, 'hop', 'references', 'hop-ops.md'))) installed.push(join(target, 'hop/references/hop-ops.md'));   // @a: anc-cli-hop-dispatch
        // hopfix 定向修正器（todo/0093 件二——同 codex 分支,两载体清单对等）。// @a: anc-cli-install-skill
        if (copyDir(join(driverDir, '..', 'skills', 'hopfix'), join(target, 'hopfix'))) {
          installed.push(join(target, 'hopfix/'));
          const hf = join(target, 'hopfix', 'SKILL.md');
          if (existsSync(hf)) writeFileSync(hf, stampSkill(readFileSync(hf, 'utf-8'), hf), 'utf-8');
          if (copyFile(join(driverDir, '..', 'scripts', 'hopfix', 'hopfix.md'), join(target, 'hopfix', 'hopfix.md'))) {
            installed.push(join(target, 'hopfix/hopfix.md'));
          }
        }
        // 旧名目录清理（hopskill-build→hopbuild 改名,残留旧 skill 会双触发——install-skill 残留清理先例）
        const legacy = join(target, 'hopskill-build');
        if (existsSync(legacy)) { rmSync(legacy, { recursive: true, force: true }); installed.push(`${legacy}/ （旧名残留已清理）`); }
      }

      // --plus 附装进阶研究件+工具配置落位（2026-08-30 作者定"install-skill --plus 这样比较
      // 简单的"——进阶件不进缺省:缺省件铁律=零配置可跑,这两件依赖外部工具注册;--plus 一开关
      // 到位,装完只差一个 API key 环境变量）。见 [[hop-cli#^anc-cli-install-skill]] --plus 条。
      // @a: anc-cli-install-skill-plus
      let plusNote: string | undefined;
      let plusToolsMerged: string[] = [];
      if (opts.plus === true) {
        const PLUS_SET: { spec: string; name: string; assets?: string }[] = [
          { spec: 'hop-fact-check.md', name: 'hop-fact-check', assets: 'fact-check-sample.md' },
          { spec: join('hop-deep-research', 'hop-deep-research.md'), name: 'hop-deep-research', assets: 'hop-deep-research-sample.md' },
        ];
        const plusNotes: string[] = [];
        const plusTarget = carrierFamily(carrier) === 'codex' ? join(process.cwd(), '.agents', 'skills') : target;
        for (const item of PLUS_SET) {
          const r = packSpec(join(pkgRoot, 'examples', item.spec), {
            dir: plusTarget, carrier: carrier, name: item.name, assets: item.assets, force,
          });
          if (r.status === 'ok') {
            installed.push(...r.installed);
            if (r.installed.length === 0) plusNotes.push(`${item.name} 已存在（--force 覆盖）`);
          } else plusNotes.push(`${item.name} 安装失败：${r.message}`);
        }
        // 工具配置合并:websearch+playwright 的 tool_servers 并入 ~/.hopjit/config.yaml——
        // 按 server name 判重跳过（用户资产纪律,与 --mcp 注册面同款）;YAML 经序列化器不裸拼。
        try {
          const cfgPath = join(homedir(), '.hopjit', 'config.yaml');
          const cfg = (existsSync(cfgPath) ? yamlLoad(readFileSync(cfgPath, 'utf-8')) : {}) as Record<string, unknown> ?? {};
          const servers = (Array.isArray(cfg['tool_servers']) ? cfg['tool_servers'] : []) as { name?: string }[];
          const have = new Set(servers.map(sv => sv.name));
          for (const yf of ['hoptools-websearch.yaml', 'hoptools-playwright.yaml']) {
            const src = yamlLoad(readFileSync(join(pkgRoot, 'examples', yf), 'utf-8')) as { tool_servers?: { name?: string }[] };
            for (const sv of src?.tool_servers ?? []) {
              if (sv.name && !have.has(sv.name)) { servers.push(sv); have.add(sv.name); plusToolsMerged.push(sv.name); }
              else if (sv.name) plusNotes.push(`tool server '${sv.name}' 已在 config.yaml，未改动`);
            }
          }
          if (plusToolsMerged.length > 0) {
            cfg['tool_servers'] = servers;
            mkdirSync(join(homedir(), '.hopjit'), { recursive: true });
            writeFileSync(cfgPath, yamlDump(cfg, YAML_DUMP_OPTS), 'utf-8');   // @a: anc-config-yaml-dump-opts
          }
        } catch (e) {
          plusNotes.push(`工具配置合并失败（skill 已装,手动把 examples/hoptools-*.yaml 抄进 ~/.hopjit/config.yaml）：${e instanceof Error ? e.message : String(e)}`);
        }
        plusNotes.push('剩余一步：export DASHSCOPE_API_KEY=<百炼key>（web_search 凭证;Playwright 首跑自动下载浏览器 ~150MB）');
        plusNote = plusNotes.join('；');
      }

      // --mcp 配置自举（2026-08-17 作者定——没有已有配置时把主 agent 的 LLM 配置学习为
      // standalone 缺省模型,并向用户明示）。仅两级配置全缺席时执行（已有配置=用户资产零触碰）；
      // 只写凭证名不写值（standalone 不变量第 1 条）。自举先于注册——Codex 注册的 env_vars
      // 要取到本次刚写的凭证名。见 [[hop-cli#^anc-cli-install-skill]] --mcp 配置自举子条。
      // @a: anc-cli-install-skill
      // 2026-10-01 作者定"缺省安装 mcp"：注册与自举不再要 --mcp——装完就能用（run_approved_command 可达的前提是 server 起得来,server 起得来的前提是 providers 配置在场）;自举失败只留 note 不阻断。// @a: anc-cli-install-skill
      let mcpConfigBootstrapped: string | null = null;
      let mcpConfigNote: string | undefined;
      try {
        const r = bootstrapStandaloneConfig(carrier);
        mcpConfigBootstrapped = r.written;
        mcpConfigNote = r.note;
        // 自举没成且系统级配置本来也不在——server 起不来,run_approved_command 不可达,把后果说出来（设计缺省注册条）
        if (!r.written && !existsSync(join(homedir(), '.hopjit', 'config.yaml')) && r.note) mcpConfigNote = `${r.note}。注意：没有 providers 配置时 hopjit MCP server 起不来,任务卡已批准命令零弹窗（run_approved_command）要等配置就位才可用`;
      } catch (e) {
        mcpConfigNote = `standalone 配置自举失败（${e instanceof Error ? e.message : String(e)}）——请自建 ~/.hopjit/config.yaml`;
      }

      // 注册 MCP server——缺省即做（2026-08-16 作者定装壳+注册一个动作,当时为 --mcp 显式 flag;2026-10-01 作者定缺省安装）。
      // 已有 hopjit 条目一律跳过（注册配置是用户资产,--force 不覆盖注册面——force 只管壳文件）。
      // CC 合并写 <cwd>/.mcp.json（保留其他 server）;Codex 追加 ~/.codex/config.toml [mcp_servers.hopjit]
      //（env_vars 凭证名透传——Codex 干净环境启动 stdio server 实撞防线,值不落盘只写名）。
      // 见 [[hop-cli#^anc-cli-install-skill]] --mcp 条。// @a: anc-cli-install-skill
      let mcpRegistered: string | null = null;
      let mcpNote: string | undefined;
      try {   // 缺省即注册后,注册面任何失败（家目录不可写/路径受限）只留 note,不让 skill 安装跟着失败（^anc-cli-install-skill 缺省注册条）
        if (carrier === 'opencode') {
          // opencode 注册:跟随 opencode 配置管理——写 candidates [opencode.jsonc, opencode.json, config.json] 第一个存在
          // （对齐 opencode globalConfigFile 三候选;都不存在用 opencode.jsonc）的 mcp.hopjit。
          // jsonc-parser modify/applyEdits 保留原格式+注释——hoplogic 对所有候选文件统一 jsoncModify
          // （opencode 仅 .jsonc 用 patchJsonc,非 .jsonc 用 stringify 重新格式化;hoplogic 统一 jsoncModify 更优雅——
          // 保留原格式不重新格式化用户文件,是"高质量优雅"取舍,不严格跟随 opencode 非 .jsonc 的 stringify）。
          // 检测 candidates 查 mcp.hopjit（.jsonc/opencode.json/config.json 任一已有则跳过,消除只查一个文件漏其他的静默冲突）。
          // 坏 JSON best-effort 不阻断 skill 安装（与 cc 分支 .claude.json 同纪律）。// @a: anc-cli-install-skill
          const reg = readMcpRegistration(adminContext(), carrier);   // 已注册判定只此一处,doctor 问 4 调同一个（^anc-cli-doctor）
          // 已有条目三分（^anc-cli-opencode-tools-gate）："已有即跳过"只保护用户资产;command 是 hopjit-mcp 且 enabled:false
          // 的条目是 2026-09-15 至 10-08 之间 setup 自己写的旧形态,由 setup 升级,不留给 doctor 叫用户手工翻。
          const ownStale = reg.registered && reg.command === 'hopjit-mcp' && reg.enabled === false;
          if (reg.registered && !ownStale) {
            mcpNote = `已有 mcp.hopjit 条目，未改动（${reg.config_path}）——请自查 command`;
          } else {
            const configPath = reg.config_path;
            const text = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '{}';
            const errs: ParseError[] = [];
            parseJsonc(text, errs);
            if (errs.length > 0) {   // jsonc-parser parse 不抛错,坏 JSON 填 errs
              mcpNote = `${configPath} 不是合法 JSON——未注册 MCP（不覆盖用户配置,请修复后重跑 hopjit setup）`;
            } else {
              // enabled:true + tools 节关独立模式专属工具（todo/0134 作者拍 b 案,翻 2026-09-15 的 enabled:false）：
              // 复用模式需要 server 活着（驱动七件与 run_approved_command 走 MCP 工具）,而 LLM 看到 hopjit_start_run
              // 会自决调它劫持执行（opencode 无 MCP 工具优先机制,skill 指令拦不住——hopissues/0099）。opencode 官方文档
              // 核实全局 tools 配置支持按 `<server>_<tool>` 关闭且 server 保持开启——server 开着,只关会劫持的五件。
              // tools 节逐键 jsoncModify：只写缺席或值不为 false 的键,用户已有的其他键不动（幂等）。// @a: anc-cli-opencode-tools-gate
              // 旧形态升级只翻 enabled 这一个键（其余键如 environment 是用户可能改过的,不动）;首装写整条。
              let out = ownStale
                ? jsoncApplyEdits(text, jsoncModify(text, ['mcp', 'hopjit', 'enabled'], true, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
                : jsoncApplyEdits(text, jsoncModify(text, ['mcp', 'hopjit'], { type: 'local', command: ['hopjit-mcp'], enabled: true, environment: {} }, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
              const cur = (parseJsonc(out) as { tools?: Record<string, unknown> } | null)?.tools ?? {};
              for (const t of OPENCODE_DISABLED_TOOLS) {
                const key = `hopjit_${t}`;
                if (cur[key] === false) continue;
                out = jsoncApplyEdits(out, jsoncModify(out, ['tools', key], false, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
              }
              mkdirSync(dirname(configPath), { recursive: true });
              writeFileSync(configPath, out, 'utf-8');
              mcpRegistered = configPath;
              const toolsList = OPENCODE_DISABLED_TOOLS.map(t => `hopjit_${t}`).join(' / ');
              mcpNote = ownStale
                ? `旧形态升级：mcp.hopjit 原为 hopjit 自己写的 enabled:false（2026-10-08 之前的 setup 产物）,已改 enabled:true,并在 tools 节关闭独立模式专属工具 ${toolsList}。走 standalone（用 hopspec-mcp skill）时把这几键改 true 或删掉`
                : `已注册 mcp.hopjit（enabled:true）,并在 tools 节关闭独立模式专属工具 ${toolsList}（防复用模式下模型误调 start_run）。走 standalone（用 hopspec-mcp skill）时把这几键改 true 或删掉`;
            }
          }
        } else if (carrierFamily(carrier) === 'codex') {
          const reg = readMcpRegistration(adminContext(), carrier);   // ^anc-cli-doctor 同一判定
          const configPath = reg.config_path;
          const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
          if (reg.registered) {
            mcpNote = `已有 [mcp_servers.hopjit] 条目，未改动（${configPath}）——请自查 command 与 env_vars`;
          } else {
            // env_vars 联动 standalone 配置的 api_key_env 并集（2026-08-20 实撞立——硬编码 ANTHROPIC 对,
            // 配置用 DEEPSEEK_API_KEY 等其他凭证名时 server 启动即缺凭证,透传目的落空）;读不到回落缺省对
            const envNames = readStandaloneCredentialNames() ?? ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
            mkdirSync(dirname(configPath), { recursive: true });
            const block = `\n[mcp_servers.hopjit]\ncommand = "hopjit-mcp"\nenv_vars = [${envNames.map(n => `"${n}"`).join(', ')}]\n`;
            writeFileSync(configPath, existing + block, 'utf-8');
            mcpRegistered = configPath;
          }
        } else {
          // CC 跨 scope 已注册感知（2026-08-20 实撞立——local/user 级注册在场时又写 project 级,
          // CC 报同名多 scope 冲突且新注册被窄 scope 盖住）。~/.claude.json 读不了照常走 .mcp.json
          // 判定（best-effort,CC 内部格式演进不拦装）。// @a: anc-cli-install-skill
          const reg = readMcpRegistration(adminContext(), carrier);   // ^anc-cli-doctor 同一判定（user/local 级 + 项目级 .mcp.json 两级）
          const configPath = reg.config_path;
          if (reg.note) throw new Error(`INSTALL_SKILL_ERROR: ${configPath} 不是合法 JSON——修复后重试（不覆盖用户配置）`);
          const ownScope = ccFamily.perCarrier[carrier as 'cc' | 'cfuse-cc'] ?? null;
          if (ownScope) {
            // 本载体自己已在 user / local 级注册——不写任何东西,note 指明 scope
            mcpNote = `已有 hopjit 注册（${ownScope}）,未写 .mcp.json——同名多 scope 会冲突且窄 scope 优先;请自查该注册指向`;
          } else if (ccFamily.anyRegistered) {
            // (b) 族内兄弟载体已在 user / local 级注册——写 .mcp.json 会给兄弟制造同名双 scope;改往本载体自己的 .claude.json 写 local 级条目
            const written = writeCcLocalRegistration(adminContext(), carrier as 'cc' | 'cfuse-cc');
            if (written) mcpRegistered = written;
            else mcpNote = `族内其他 CC 系载体已有 hopjit 注册,未写 .mcp.json;本载体的 .claude.json 不存在（载体没启动过）,启动一次后重跑 hopjit setup 即补 local 级注册`;
          } else {
            let config: { mcpServers?: Record<string, unknown> } = {};
            if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf-8'));
            config.mcpServers = config.mcpServers ?? {};
            if (config.mcpServers['hopjit']) {
              mcpNote = `已有 mcpServers.hopjit 条目，未改动（${configPath}）——请自查 command`;
            } else {
              config.mcpServers['hopjit'] = { command: 'hopjit-mcp' };
              writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
              mcpRegistered = configPath;
            }
          }
        }
      } catch (e) {
        // 用户配置损坏（INSTALL_SKILL_ERROR 前缀）仍响亮失败——不静默覆盖用户文件是既有契约;只有环境性失败（家目录不可写/受限）才降为 note
        if (e instanceof Error && e.message.startsWith('INSTALL_SKILL_ERROR:')) throw e;
        mcpNote = `MCP server 注册失败（${e instanceof Error ? e.message : String(e)}）——skill 已装好,但 hopjit MCP 工具不可达;修复后重跑 hopjit setup 即补注册`;
      }

      const skipped = installed.length === 0;
      // 陈旧副本处置（hopissues/0096 立"给升级路径不给清理命令";2026-10-07 作者同意自带件自动挪进备份区）:
      // 扫描本安装器写过的旧位置。认领判据=SKILL.md 含本器版本戳（非本器文件零打扰）;陈旧判据=戳版本落后
      // 当前包版本,或 spec.md 无 engine_min_version 指纹（0093 前旧产物）;旧 demo-* 不看版本带戳即废弃。
      // 本器自带件（六件+旧名 hopskill-build+hop-*+demo-*）整目录挪到 ~/.hopjit/stale-backup/<时间戳>/ 并写
      // RESTORE.txt——旧位置 --force 刷不到、载体可能优先加载盖住新版,挪走不删则用户改过也不丢;任何一步
      // 失败退回只提示。用户自建件（pack 产物）本器无新版源,仍只提示指路 /hopfix。
      // 见 hop-cli ^anc-cli-stale-skill-scan。// @a: anc-cli-stale-skill-scan
      const staleNotes: string[] = [];
      {
        const scanRoots = carrierFamily(carrier) === 'codex'
          ? [join(homedir(), '.agents', 'skills'), join(process.cwd(), '.agents', 'skills')]   // Codex 族历史用户级装载点 + 2026-08-27 至 10-06 项目级 demo 装载点
          : [join(homedir(), '.claude', 'skills')];                      // CC 族历史装位置
        // 各载体的现行安装目录:一次 setup 依次装多个载体,A 的现行目录对 B 不是旧位置（2026-10-07 实撞:opencode 轮把
        // ~/.claude/skills 当旧位置,挪走了 CC 在用的当前版 hopbuild2）。只有 Codex 的两处历史位置做完整扫描,其余只看 demo-*
        const currentInstallDirs = new Set([...CARRIER_VALUES.map(c => resolve(resolveCarrierHome(adminContext(), c), 'skills')), resolve(target)]);
        const seenRoots = new Set<string>();
        for (const root of [...scanRoots, target]) {
          const demoOnly = carrierFamily(carrier) !== 'codex' || currentInstallDirs.has(resolve(root));
          if (seenRoots.has(resolve(root))) continue;
          seenRoots.add(resolve(root));
          if (!existsSync(root)) continue;
          for (const name of readdirSync(root)) {
            const isOldDemo = name.startsWith('demo-');
            if (demoOnly && !isOldDemo) continue;
            const dir = join(root, name);
            const sk = join(dir, 'SKILL.md');
            if (!existsSync(sk)) continue;
            let head = '';
            try { head = readFileSync(sk, 'utf-8'); } catch { continue; }
            const m = head.match(/driver: @hoplogic\/hopjit v(\S+)/);
            if (!m) continue;                                            // 非本安装器产物,零打扰
            // 六件清单=本器安装集（用户可见只 hop 一个,其余五件 user_invocable:false 由 /hop 分派——^anc-cli-install-skill-single-entry;单入口的代码面是各 skill 源的 frontmatter,这里是安装集的唯一枚举点） // @a: anc-cli-install-skill-single-entry
            const isBundled = ['hopspec', 'hopspec-mcp', 'hop', 'hopbuild', 'hopbuild2', 'hopfix'].includes(name)
              || STALE_LEGACY_BUNDLED_NAMES.includes(name) || name.startsWith('hop-') || isOldDemo;
            // engine_min_version 指纹由 pack 注入,只用来判用户自建件;自带件的 spec.md 本来不带它（hopbuild2 实撞误判）
            const specPath = join(dir, 'spec.md');
            const noFingerprint = !isBundled && existsSync(specPath) && !readFileSync(specPath, 'utf-8').includes('engine_min_version');
            const older = m[1] !== driverVersion;
            if (!isOldDemo && !older && !noFingerprint) continue;
            // Codex 的 --plus 进阶件现行就装在 <cwd>/.agents/skills——那里的 hop-* 是现行位置不是旧位置,不挪,指路重装
            const isPlusHome = carrierFamily(carrier) === 'codex' && resolve(root) === resolve(process.cwd(), '.agents', 'skills');
            if (isPlusHome && name.startsWith('hop-')) {
              staleNotes.push(`⚠️ 进阶件 ${dir} 版本落后（装于 v${m[1]},当前 v${driverVersion}）——在项目目录重跑 hopjit setup --carrier codex --plus --force 刷新`);
              continue;
            }
            if (!isBundled) {
              staleNotes.push(`⚠️ 旧位置发现陈旧的自建 skill ${dir}（装于 v${m[1]},当前 v${driverVersion}）——升级走 /hopfix 定向修正（validate error 清单为工单的版本迁移正门,不是简单覆盖）`);
              continue;
            }
            const reason = isOldDemo
              ? `旧形态演示 skill,演示件已改为 HopAnt 装在 ${antsRoot(homedir())}/`
              : name.startsWith('hop-')
                ? `装于 v${m[1]},当前 v${driverVersion};进阶件要用时以 hopjit setup --plus 重装`
                : `装于 v${m[1]},当前 v${driverVersion};现行位置已随本次安装刷新,旧位置可能被载体优先加载盖住新版`;
            const moved = moveStaleToBackup(dir, staleBackup);
            if (moved.ok) {
              movedStale.push(resolve(dir));
              staleNotes.push(`已挪走陈旧副本：${dir} → ${moved.dest}（${reason}）。需要时按 ${join(staleBackup.root, 'RESTORE.txt')} 挪回`);
            } else {
              staleNotes.push(`⚠️ 发现陈旧副本 ${dir}（${reason}）——自动挪进备份区失败（${moved.error}）,原目录未动,请自行删除或挪走`);
            }
          }
        }
      }
      const legacyLeft = codexLegacyPaths.filter(p => !movedStale.includes(resolve(p)));
      const codexLegacyNote = legacyLeft.length > 0
        ? `⚠️ 当前项目 .agents/skills/ 有旧安装残留（${legacyLeft.map(p => p.split(sep).pop()).join(', ')}）——Codex 同名 skill 项目级优先于用户级,残留会盖住本次安装的新版。确认非有意钉版后删除:rm -rf ${legacyLeft.join(' ')}`
        : undefined;
      // CC 放行 hopjit 工具清单;其他载体指路不猜格式。判据显式枚举——carrierFamily 把 opencode 也归 'cc'（包装模板选型语义）,借它会把 CC 文件写进 opencode 项目（review 实抓） // @a: anc-cli-install-skill-permission
      let permissionWritten: string | null = null;
      let permissionNote: string | undefined;
      if (carrier === 'cc' || carrier === 'cfuse-cc') {
        const r = ensureCcPermission(process.cwd());
        permissionWritten = r.written;
        permissionNote = r.note;
      } else {
        permissionNote = `请在 ${carrier} 载体里放行 hopjit 的 MCP 工具（按 <server>_<tool> 粒度的放行配置）${carrier === 'opencode' ? ';server 已启用（mcp.hopjit.enabled: true）,独立模式专属工具已在 tools 节关闭,要走 standalone 时把那几键改 true' : ''}——驱动工具与任务卡里批准的命令才能不再逐条弹窗`;   // @a: anc-cli-opencode-tools-gate
      }

      // 注册后的握手自检（^anc-cli-install-skill-handshake）——只报告不改注册,失败不阻断。
      // @a: anc-cli-install-skill-handshake
      let handshake: McpHandshake | undefined;
      {
        let command = 'hopjit-mcp';
        if (carrier === 'cc' || carrier === 'cfuse-cc') {
          try {
            const c = JSON.parse(readFileSync(resolve(process.cwd(), '.mcp.json'), 'utf-8')) as { mcpServers?: { hopjit?: { command?: unknown } } };
            if (typeof c.mcpServers?.hopjit?.command === 'string') command = c.mcpServers.hopjit.command;
          } catch { /* 没有项目级注册或读不了——按缺省 command 判 */ }
        }
        handshake = mcpHandshake(process.execPath, join(pkgRoot, 'dist', 'mcp-server.js'), command, process.env.PATH ?? '');
      }

      return {
        carrier,
        target,
        installed,
        ...(removed.length ? { removed } : {}),   // 受管目录清理清单（--force 档）// @a: anc-cli-install-skill
        ...(plusNote ? { plus_note: plusNote, plus_tools_merged: plusToolsMerged } : {}),
        ...(codexLegacyNote ? { legacy_note: codexLegacyNote } : {}),
        mcp_registered: mcpRegistered,
        ...(mcpNote ? { mcp_note: mcpNote } : {}),
        mcp_config_bootstrapped: mcpConfigBootstrapped,
        ...(mcpConfigNote ? { mcp_config_note: mcpConfigNote } : {}),
        ...(handshake ? { mcp_handshake: handshake } : {}),   // @a: anc-cli-install-skill-handshake
        permission_written: permissionWritten,   // CC 放行 hopjit 工具清单的落点（^anc-cli-install-skill-permission） // @a: anc-cli-install-skill-permission
        ...(permissionNote ? { permission_note: permissionNote } : {}),
        ...(staleNotes.length ? { stale_notes: staleNotes } : {}),   // @a: anc-cli-stale-skill-scan
        ...(skipped ? { note: '无文件写入（目标已存在，用 --force 覆盖）' } : {}),
      };
      };   // installOne

      // 多载体响应：顶层字段取第一个载体的值（兼容只读顶层的旧消费方）,全部结果在 results（^anc-cli-carrier-autodetect）。// @a: anc-cli-carrier-autodetect
      const results = carriers.map(installOne);
      // 演示 HopAnt 与载体无关,每次调用只装一次（^anc-cli-install-skill-demo-ants） // @a: anc-cli-install-skill-demo-ants
      const demo = installDemoAnts(pkgRoot, homedir());
      output({
        status: 'ok',
        ...results[0],
        carriers,
        results,
        driver_version: driverVersion,
        driver_source: pkgRoot,
        ...(detectNote ? { detect_note: detectNote } : {}),
        demo_ants: demo.installed,
        ...(demo.notes.length ? { demo_note: demo.notes.join('；') } : {}),
        // 装包必经点指路 agent 使用说明——带包内绝对路径,agent 不必再算 npm root（todo/0139 挂钩①,^anc-cli-install-skill）// @a: anc-cli-install-skill
        next_step: `装完请读 ${join(pkgRoot, 'docs', 'AGENT-GUIDE.md')}（给 agent 的使用说明：装完你的行为要变在哪、三条必须守的边界）；要让项目里的 agent 稳定走 hop,先问用户一句,同意再把 ${join(pkgRoot, 'docs', 'agent-instructions-template.md')} 里的那段贴进项目的 CLAUDE.md 或 AGENTS.md`,
      });
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });
}
defineSetupCommand('setup');
defineSetupCommand('install-skill');


// pack：把一个 hopskill spec 打包成载体对应的独立具名 skill。
// 产品形态：用户拿到的是具名能力（"帮我评审文档"），HopSpec/hopjit 是实现细节不外露。
// 薄包装只做触发+参数引导+执行委托，驱动协议单一权威在 hopspec skill（内嵌=第二真值必漂移）。
// 核心逻辑提炼为 packSpec()——pack 命令与 setup --plus 共用（单一实现，不复制）。
// 见 design/hop-cli.md ^anc-cli-pack。
// @a: anc-cli-pack
type PackResult =
  | { status: 'ok'; carrier: Carrier; skill_name: string; target: string; installed: string[]; knowledge_docs: string[]; assets: string[]; note?: string }
  | { status: 'error'; message: string; errors?: string[] };

function packSpec(specPath: string, opts: { dir: string; carrier: Carrier; name?: string; assets?: string; force?: boolean; skillVersion?: string }): PackResult {
  if (!existsSync(specPath)) return { status: 'error', message: `PACK_ERROR: spec 文件不存在（${specPath}）` };
  const raw = readFileSync(specPath, 'utf-8');

  // validate 闸门：pack 不放行坏 spec
  const { ast, errors: parseErrors } = parseSpec(raw);
  if (parseErrors.length > 0) {
    return { status: 'error', message: 'spec 解析失败，先修再 pack', errors: parseErrors.map(e => e.message) };
  }
  // doc-ref 解析上下文（hopissues/0077——原恒缺席,P15 检查空转:知识文件缺失/章节缺失
  // validate 报 error 而 pack 照 ok 写产物,打包假绿;pack 是交付时点,知识闭合是产物硬要求,
  // 不用 validate 命令的 lenient 降级——缺失即 error 拒。与 validate 命令 :346-356 同构。
  // @a: anc-cli-pack
  const packSpecDir = dirname(resolve(specPath));
  const packDocRefCtx = {
    workspace_dir: process.cwd(),
    sandbox: { filesystem: { workspace_dir: process.cwd(), read_access: { allowed: ['.', packSpecDir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
    spec_dir: packSpecDir,
  };
  const allErrors = validateSpec(ast, packDocRefCtx);
  const errors = allErrors.filter(e => e.severity === 'error');
  if (errors.length > 0) {
    return { status: 'error', message: 'spec 未过校验闸门，先修再 pack', errors: errors.map(e => `${e.rule}: ${e.message}`) };
  }

  const skillName = opts.name ?? ast.header.id ?? 'hopskill';
  // 前置段版本声明（hopissues/0051 ^anc-cli-pack-version-floor——打包时版本入壳,低版本场景
  // 指路'版本过低先升级'而非让用户猜语法错误;取 readPackageVersion 单点不写第二真值;
  // 只提示不默认升级,作者拍 A）。// @a: anc-cli-pack-version-floor
  const packVersion = readPackageVersion();
  const goalFull = ast.header.goal ?? ast.header.title ?? skillName;
  const goalLine = goalFull.split('\n')[0].trim();   // frontmatter description 只取首行（goal 可带 > 续行说明）
  const target = isAbsolute(opts.dir) ? opts.dir : resolve(process.cwd(), opts.dir);
  const skillDir = join(target, skillName);
  const force = opts.force === true;
  const installed: string[] = [];

  // 数据资产（--assets 逗号分隔，spec 同目录）：先全量存在性检查再拷——缺任一即拒，
  // 不产出装上就跑不了的 skill（防呆）。见 [[hop-cli#^anc-cli-pack]] 资产条。
  const specDirForAssets = dirname(specPath);
  const assets = (opts.assets ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const missing = assets.filter(a => !existsSync(join(specDirForAssets, a)));
  if (missing.length > 0) {
    return { status: 'error', message: `PACK_ERROR: 资产不存在于 spec 同目录（${specDirForAssets}）`, errors: missing };
  }

  // 收集 doc-ref 引用的知识文档（spec 级 + 步骤级；同目录 .md，doc-ref 按同住约定）
  const docNames = new Set<string>();
  for (const r of ast.header.doc_refs ?? []) docNames.add(r.doc);
  const walk = (steps: StepNode[]) => {
    for (const st of steps) {
      for (const r of st.doc_refs ?? []) docNames.add(r.doc);
      if (hasChildren(st)) walk(getChildren(st));
    }
  };
  walk(ast.steps ?? []);
  const specDir = dirname(specPath);
  const knowledgeDocs: string[] = [];
  const missingDocs: string[] = [];
  for (const doc of docNames) {
    const base = doc.endsWith('.md') ? doc : `${doc}.md`;
    const src = join(specDir, base);
    // 缺失响亮拒不静默跳过（hopissues/0077——跳过=产物装上即 P15,pack 成功≠知识闭合）
    if (existsSync(src)) knowledgeDocs.push(base);
    else missingDocs.push(base);
  }
  if (missingDocs.length > 0) {
    return { status: 'error', message: `PACK_ERROR: doc-ref 引用的知识文档不在 spec 同目录（${specDir}）——产物知识不闭合,装上即 P15`, errors: missingDocs };
  }

  // 薄包装 SKILL.md：三段式（触发/参数引导/执行委托），按 carrier 使用自身原语。
  const inputs = ast.header.inputs ?? [];
  const paramLines = inputs.length
    ? inputs.map(i => `- \`${i.name}\`（${i.type}）${i.description ? `：${i.description}` : ''}`).join('\n')
    : '- 本 spec 无输入参数。';
  // 壳里不提知识文档（^anc-cli-pack-shell 内务零披露——点名文件就是诱导预读;todo/0151 作者定删）。文件照样随包拷入,PackResponse.knowledge_docs 仍列。
  // 交付段（四段式第四段,^anc-cli-pack-shell——壳的参数段对齐 Inputs,交付段对齐 Outputs,两头都不悬空;
  // 2026-08-15 作者抓"壳的输出还没对上",设计写定后模板一直没读 header.outputs,2026-09-30 语义审计抓,todo/0129 B5 补）// @a: anc-cli-pack-shell
  const outputs = ast.header.outputs ?? [];
  const deliverLines = outputs.length
    ? outputs.map(o => `- \`${o.name}\`（${o.type}）${o.description ? `：${o.description}` : ''}`).join('\n')
    : '- 本 spec 未声明交付物——终态后把引擎返回的 outputs 原样报告。';
  const deliverSection = `## 交付\n\n任务到终态后，按下列交付物逐项向用户交付（与 spec \`## Outputs\` 一一对应，不漏不改写）：\n\n${deliverLines}\n\n单一 text/markdown 交付物直接展示正文；多项或结构化交付物保底用 YAML 块防漏。`;

  // 前置段装驱动命令/位置按 carrier 生成（^anc-cli-carrier-home-resolution——cfuse-* 载体的 pack 产物
  // 要指引用户装到 cfuse home,不能硬编码原生 ~/.claude / ~/.codex,否则 cfuse 用户照做装错位置）
  const installHint = opts.carrier === 'cfuse-cc' ? '`hopjit setup --carrier cfuse-cc`'
    : opts.carrier === 'cfuse-codex' ? '`hopjit setup --carrier cfuse-codex`'
    : opts.carrier === 'opencode' ? '`hopjit setup --carrier opencode`'
    : carrierFamily(opts.carrier) === 'codex' ? '`hopjit setup --carrier codex`'
    : '`hopjit setup`';
  const codexHopspecPath = opts.carrier === 'cfuse-codex'
    ? '~/.codefuse/engine/codex/skills/hopspec/SKILL.md'
    : '~/.codex/skills/hopspec/SKILL.md';

  // skill 版本注入（0092——frontmatter 原恒缺 version:HopSpec 头无 version 槽翻译期即丢,pack 无源可继承,
  // 消费方读空回退 unknown;--skill-version 显式注入,未传不写行且 note 提示——不设缺省值,编造比缺席更误导）。
  // @a: anc-cli-pack
  const versionLine = opts.skillVersion ? `version: ${opts.skillVersion}\n` : '';
  const ccSkillMd = `---
name: ${skillName}
${versionLine}description: ${goalLine} 用户提出相关任务时触发本 skill，按其中说明驱动执行。
---

# /${skillName}

**做什么**：${goalFull}

本 skill 由 HopSpec 规约驱动（本目录 \`spec.md\`）——步骤结构、审核点、并行与重试由 hopjit 引擎强制执行，不靠对话记忆。

## 前置（一次性）

1. hopjit 引擎已安装且版本 >= ${packVersion}（本 skill 由该版本打包;\`hopjit --version\` 可验证,低于则先升级：\`npm i -g @hoplogic/hopjit@latest\`）；
2. hopspec 驱动 skill 已安装：${installHint}（本 skill 依赖它的驱动协议）。

## 参数

从用户请求和本目录资产组装以下输入（有演示数据的直接读，不足才问）：

${paramLines}

## 执行

组装好参数后，按 hopspec 驱动协议执行本目录的 spec：

\`\`\`
/hopspec run <本 skill 目录>/spec.md --params '<组装的参数 JSON>'
\`\`\`

**输入确认等暂停点由 spec 内的 ask/confirm 步骤引擎强制**——按 hopspec 协议原样呈给用户拍板（不要代答）；终态后按下面「交付」段向用户报告。

${deliverSection}

## 🔴 用户注意力纪律（本 skill 面向非程序员，非 debug 模式）

- **内务不进对话**：CLI 探测、路径解析、状态目录、JSON 细节一律不展示——探测与定位静默完成，只在出错时说人话解释；
- **零行话**：对用户不说 spec/引擎/介入点/subagent，说"步骤/任务/需要你确认"；
- **用户只看三类内容**：要收集的输入、必须拍板的确认点、最终交付物。进度至多一行一步（"✓ 已完成：xx"）。
`;
  const codexSkillMd = `---
name: ${skillName}
${versionLine}description: ${goalLine} 用户提出相关任务或显式使用 $${skillName} 时触发，按 HopSpec 驱动执行。
---

# $${skillName}

**做什么**：${goalFull}

本 skill 的执行规约在本目录 \`spec.md\`，数据与知识资产也随 skill 同目录安装。

## 前置

1. hopjit CLI 可用且版本 >= ${packVersion}（本 skill 由该版本打包;\`hopjit --version\` 可验证,低于则先升级：\`npm i -g @hoplogic/hopjit@latest\`）；
2. hopspec skill 已安装（用户级 \`${codexHopspecPath}\`,或本项目 \`.agents/skills/hopspec/SKILL.md\`——就近取在场的那份）。

## 参数

从用户请求和本目录资产组装以下输入（有演示数据的直接读，不足才问）：

${paramLines}

## 执行

1. 读取 hopspec 的 SKILL.md（前置第 2 条定位到的那份），把它作为本次执行的 main orchestrator 协议；
2. 按该协议运行本目录 \`spec.md\`，传入组装的参数——**输入确认等暂停点由 spec 内 ask/confirm 步骤引擎强制**，原样交用户拍板（不要代答）；
3. 终态按下面「交付」段逐项交付。

${deliverSection}

## 用户注意力

- 不展示 CLI 探测、路径解析、状态目录或 JSON 内务；
- 不向用户讲 spec、引擎、subagent 等实现术语；
- 用户只看必要输入、必须确认的问题和最终交付物。
`;
  const skillMd = carrierFamily(opts.carrier) === 'codex' ? codexSkillMd : ccSkillMd;

  const writeIfAllowed = (dst: string, content: string): boolean => {
    if (existsSync(dst) && !force) return false;
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, content, 'utf-8');
    return true;
  };
  if (writeIfAllowed(join(skillDir, 'SKILL.md'), skillMd)) installed.push(join(skillDir, 'SKILL.md'));
  const copyIfAllowed = (src: string, dst: string): boolean => {
    if (existsSync(dst) && !force) return false;
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    return true;
  };
  // name 覆盖且≠spec Id 时,打包副本的 Id: 行随名改写——Id 是运行痕迹命名根(hoplog 目录/状态
  // 元数据/call 寻址),skill 名与 Id 不一致会让 demo 运行痕迹干扰目标环境(demo-rename 跑出
  // confirm-commit-* 日志)。源文件不动;无 name 零改写。见 [[hop-cli#^anc-cli-pack]] Id 随名条。
  const specDst = join(skillDir, 'spec.md');
  // engine_min_version 注入（todo/0093 版本兼容性原则——pack 产物声明打包时引擎版本,消费端 init 闸比对
  // ^anc-exec-engine-min-version-gate;spec 已有该键=作者手写值保留不覆盖〔放宽是知情行为〕;无 Config 段则
  // 建段。与 --skill-version 正交:那是消费方业务版本,这是引擎兼容闸）。// @a: anc-cli-pack, anc-exec-engine-min-version-gate
  const injectEngineMinVersion = (text: string): string => {
    if (/^\s*-?\s*engine_min_version\s*:/m.test(text)) return text;   // 作者手写在场,保留
    const line = `  engine_min_version: ${packVersion}`;   // 缩进键值形态(概念例同款;parser -? 键: 值 两形态都收)
    if (/^Config:\s*$/m.test(text)) return text.replace(/^Config:\s*$/m, `Config:\n${line}`);
    // 无 Config 段:插在 Inputs/Outputs/Steps 首个段头前（Config 属头部段,Steps 前合法位）
    const m = text.match(/^## (Inputs|Outputs|Steps)/m);
    return m ? text.replace(m[0], `Config:\n${line}\n\n${m[0]}`) : text;
  };
  if (opts.name && ast.header.id && opts.name !== ast.header.id) {
    if (!existsSync(specDst) || opts.force === true) {
      mkdirSync(dirname(specDst), { recursive: true });
      const rewritten = injectEngineMinVersion(rewriteSpecId(raw, opts.name));
      writeFileSync(specDst, rewritten, 'utf-8');
      installed.push(specDst);
    }
  } else if (!existsSync(specDst) || opts.force === true) {
    mkdirSync(dirname(specDst), { recursive: true });
    writeFileSync(specDst, injectEngineMinVersion(raw), 'utf-8');
    installed.push(specDst);
  }
  for (const doc of knowledgeDocs) {
    if (copyIfAllowed(join(specDir, doc), join(skillDir, doc))) installed.push(join(skillDir, doc));
  }
  // 资产条目文件/目录双形态（^anc-cli-pack 资产条 2026-09-04 扩）：目录整树递归拷入保持相对
  // 路径结构——多文件 skill 的 references/、scripts/ 附属资产按目录点名，产物内指针原样可解析。
  for (const asset of assets) {
    const srcPath = join(specDirForAssets, asset);
    const dstPath = join(skillDir, asset);
    if (statSync(srcPath).isDirectory()) {
      if (!existsSync(dstPath) || force) {
        cpSync(srcPath, dstPath, { recursive: true, force: true });
        installed.push(dstPath);
      }
    } else if (copyIfAllowed(srcPath, dstPath)) installed.push(dstPath);
  }

  return {
    status: 'ok',
    carrier: opts.carrier,
    skill_name: skillName,
    target,
    installed,
    knowledge_docs: knowledgeDocs,
    assets,
    ...(installed.length === 0
      ? { note: '无文件写入（目标已存在，用 --force 覆盖）' }
      : (!opts.skillVersion ? { note: '产物 SKILL.md 无版本号——消费方读 frontmatter version 的场景请传 --skill-version <v>（0092）' } : {})),
  };
}

program.command('pack <spec>')
  .description('Pack a hopskill spec into a standalone named skill for Claude Code or Codex')
  .option('--carrier <carrier>', 'Skill carrier: cc | codex | cfuse-cc | cfuse-codex | opencode', 'cc')
  .option('--dir <target>', 'Target skills directory (default: .claude/skills for cc/cfuse-cc, .agents/skills for codex/cfuse-codex, .opencode/skills for opencode — project-level per carrierFamily; cfuse home needs --dir)')
  .option('--name <name>', 'Skill name (default: spec Id)')
  .option('--assets <files>', 'Comma-separated data files (in spec dir) to bundle into the skill')
  .option('--skill-version <v>', 'Inject version into packed SKILL.md frontmatter (0092: consumers reading version get unknown otherwise)')
  .option('--force', 'Overwrite existing files')
  .action((specArg, opts) => {
    try {
      assertCarrier(opts.carrier, 'PACK');
      const carrier = opts.carrier as Carrier;
      const specPath = isAbsolute(specArg) ? specArg : resolve(process.cwd(), specArg);
      const target = opts.dir ?? (carrier === 'opencode' ? '.opencode/skills' : carrierFamily(carrier) === 'codex' ? '.agents/skills' : '.claude/skills');
      const result = packSpec(specPath, {
        dir: target,
        carrier: carrier,
        name: opts.name,
        skillVersion: opts.skillVersion,
        assets: opts.assets,
        force: opts.force === true,
      });
      output(result);
      if (result.status === 'error') process.exitCode = 1;
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// ---------- hopjit ant：HopAnt 安装/适配/索引/卸载/bootstrap（^anc-cli-ant,业务全在 hopant 模块） ----------
// 组合根职责：取 home、两级配置的 tool_servers 与 providers、PATH、git 用户名、登录名、主机名、引擎版本,
// 全部作为参数交给 hopant 的纯函数;子进程只在 ant bootstrap 一处（跑 HopAnt 自带的 bootstrap.js）。

// ---------- hopjit doctor / ant：业务体在 hop-admin.ts,这里只做"读进程状态 → 调一个函数 → 输出 / 退出码"的薄壳（^anc-cli-doctor / ^anc-cli-ant「实现落点」） ----------

/** ant 子命令共用的壳：成功 output,业务体抛的 `大写码:` Error 走 errorExit（stderr + 退出码 1,stdout 不出 JSON）。 */ // @a: anc-cli-ant
function antShell(fn: (ctx: AdminContext) => Record<string, unknown>, afterOutput?: (r: Record<string, unknown>) => void): void {
  try {
    const r = fn(adminContext());
    output(r);
    afterOutput?.(r);
  } catch (err: unknown) { errorExit(err instanceof Error ? err.message : String(err)); }
}

program.command('doctor')
  .description('Health check after install: skill / version / menu / MCP registration / handshake / permissions / MCP server LLM config / standalone credential (design/hop-cli.md ^anc-cli-doctor)')
  .action(() => {   // @a: anc-cli-doctor
    try {
      const r = runDoctor(adminContext());
      if (FORCE_JSON) output(r); else process.stdout.write(formatDoctorReport(r));
      process.exitCode = r.exit_code;   // fail 是正常报告不是命令出错——不走 errorExit
    } catch (err: unknown) { errorExit(err instanceof Error ? err.message : String(err)); }
  });

const ant = program.command('ant').description('HopAnt: install / adapt / list / remove / bootstrap / pack / share (design/hopant.md)');

ant.command('install <dir>')
  .description('Install a HopAnt directory or a HopAnt package root (ants/<id>/) into ~/.hopjit/ants/')
  .option('--dry-run', 'Only print the install plan; write nothing')
  .addOption(new Option('--scope <scope>', 'Install into the user-level (~/.hopjit/ants, default) or project-level (<cwd>/hop_tasks/ants) HopAnt root').choices(['user', 'project']).default('user'))
  .action((dirArg: string, opts: { dryRun?: boolean; scope: 'user' | 'project' }) => antShell(ctx => antInstall(ctx, dirArg, opts.dryRun === true, opts.scope)));   // @a: anc-cli-ant

ant.command('adapt <id>')
  .description('Check this machine against the HopAnt entry spec header: tools / credentials / commands / engine version; write adapt stamp when all green')
  .action((id: string) => antShell(ctx => antAdapt(ctx, id), r => { if (!(r['report'] as { ok: boolean }).ok) process.exitCode = 1; }));   // 报告有缺口：stdout 仍是完整 JSON、退出码 1 // @a: anc-cli-ant

ant.command('list')
  .description('List installed HopAnts with adapt state (adapted / stale / never)')
  .action(() => antShell(ctx => antList(ctx)));   // @a: anc-cli-ant

ant.command('remove <id>')
  .description('Remove an installed HopAnt')
  .option('--keep-store', 'Move inner_store/ to ~/.hopjit/ants-store-backup/<id>/ before removing')
  .addOption(new Option('--scope <scope>', 'Which level to remove from; default = whichever level the id resolves to (project first)').choices(['user', 'project']))
  .action((id: string, opts: { keepStore?: boolean; scope?: 'user' | 'project' }) => antShell(ctx => antRemove(ctx, id, opts.keepStore === true, opts.scope)));   // @a: anc-cli-ant

ant.command('bootstrap <id>')
  .description('Run the HopAnt\'s own bootstrap.js (installs its runtime deps); --dry-run only prints its plan')
  .option('--dry-run', 'Pass --dry-run to bootstrap.js')
  .action((id: string, opts: { dryRun?: boolean }) => antShell(ctx => antBootstrap(ctx, id, opts.dryRun === true),
    r => { if (r['has_bootstrap'] === true && r['returncode'] !== 0) process.exitCode = 1; }));   // 脚本非零：本命令退出码 1 // @a: anc-cli-ant

ant.command('pack <spec>')
  .description('Pack a spec into an installable HopAnt directory <out>/<id>/ (reconciles Tools / approved-commands header against the body; copies doc-ref files and --assets)')
  .option('--out <dir>', 'Output root (default: ./ants)', 'ants')
  .option('--id <id>', 'HopAnt id (default: the spec Id line)')
  .option('--assets <files...>', 'Extra files to copy into the HopAnt root (relative to the spec dir or absolute)')
  .action((spec: string, opts: { out: string; id?: string; assets?: string[] }) => antShell(ctx => antPack(ctx, spec, { out: opts.out, id: opts.id, assets: opts.assets })));   // @a: anc-cli-ant, anc-hopant-pack

ant.command('share <ids...>')
  .description('Bundle installed HopAnts (distributable face only) into a HopAnt package directory <out>/<name>/ with package.json; four checks must pass')
  .option('--out <dir>', 'Output root (default: cwd)', '.')
  .option('--name <name>', 'Package name (default: the single id; required for several)')
  .option('--pkg-version <v>', 'Package version (transport label; not --version, that is the engine version flag)', '0.1.0')
  .option('--owner <id>', 'Owner identifier to record in the package (also saved to ~/.hopjit/config.yaml owner_id)')
  .option('--yes', 'Use the default owner identifier without asking')
  .action((ids: string[], opts: { out: string; name?: string; pkgVersion: string; owner?: string; yes?: boolean }) =>
    antShell(ctx => antShare(ctx, ids, { out: opts.out, name: opts.name, pkg_version: opts.pkgVersion, owner: opts.owner, yes: opts.yes })));   // @a: anc-cli-ant, anc-hopant-share

export { program };

// isMain 判断须解析软链：全局装时 bin 是软链（/usr/local/bin/hopjit → .../dist/cli.js），
// process.argv[1] 是软链路径、import.meta.url 是真实路径，直接比对不等 → parseAsync 不跑 →
// 全局 hopjit 所有命令空跑 exit 0（致命）。realpathSync 解析两边软链后比对。// @a: anc-struct-hop-cli
function resolveRealPath(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}
const isMain = process.argv[1] !== undefined
  && resolveRealPath(process.argv[1]) === resolveRealPath(fileURLToPath(import.meta.url));
if (isMain) {
  program.parseAsync(process.argv).catch(err => {
    errorExit(err instanceof Error ? err.message : String(err));
  });
}