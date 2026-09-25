#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: hop-cli ^anc-struct-hop-cli
import { Command } from 'commander';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { parse as parseJsonc, modify as jsoncModify, applyEdits as jsoncApplyEdits, type ParseError } from 'jsonc-parser';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync, cpSync, realpathSync, rmSync } from 'node:fs';
import { resolve, join, isAbsolute, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ExecutionEngine, type EngineOptions } from './engine.js';
import { parseSpec, parseFragment , flattenFragmentNumbering , convertSpecKeywords } from './parser.js';
import { validateSpec } from './validator.js';
import { readVars, readState, readSpec, stateExists, flattenVars } from './persistence.js';
import { hasChildren, getChildren, isParallelContainer, getForEach } from './ast-helpers.js';
import type { StepNode } from './ast-types.js';
import type { CommandResponse, ListResponse, NextResponse } from './cli-types.js';
import type { SpecError, ValidationError } from './errors.js';
import type { HostConfig } from './provider-types.js';
import { credentialLikeHopEnvKey, hopEnvCredentialError, ENGINE_DEFAULT_MODEL } from './provider-types.js';
import { CompositeToolProvider, makeEngineToolProviderFactory } from './tools-composite.js';

import { parseToolServers, enrichParamsComments, loadProjectToolRegistry } from './tools-registry.js';
import { sendDingtalk, composeRunCard } from './tools-notify.js';   // 复用模式通知挂点（^anc-cli-notify-reuse） // @a: anc-cli-notify-reuse

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
program.hook('preAction', (thisCommand) => { setOutputJson(thisCommand.opts().json === true); });
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
    process.stdout.write(yamlDump(data as object, { lineWidth: -1, noRefs: true }));
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

/** 复用模式项目级 commands 键读取（^anc-exec-subprocess-run 配置通路——复用模式此前零配置
 * 加载面,本键是首个:只读 hopjit.yaml 的 commands 一个键,不引入完整配置合并;文件缺席/坏 YAML/
 * 键缺席全部回空名单=能力关死,配置钝感不炸 CLI）。 */ // @a: anc-exec-subprocess-run
export function readProjectCommands(): string[] {
  try {
    const p = resolve(process.cwd(), 'hopjit.yaml');
    if (!existsSync(p)) return [];
    const parsed = yamlLoad(readFileSync(p, 'utf-8')) as { commands?: unknown } | null;
    const c = parsed?.commands;
    if (!(Array.isArray(c) && c.every(x => typeof x === 'string'))) return [];
    // hopjit 恒拒名单配置面（^anc-exec-subprocess-deny-hopjit）——本函数其余形态钝感（坏 YAML
    // 回空=能力关死,安全侧),唯此例外响亮:写了 hopjit 是明确的越层配置,静默剔除会让作者
    // 误以为生效,运行期再撞恒拒报文更迷惑。// @a: anc-exec-subprocess-deny-hopjit
    if (c.some(x => x === 'hopjit' || x.split('/').pop() === 'hopjit')) {
      throw new Error('CONFIG_ERROR: hopjit.yaml commands 白名单不得含 hopjit——act/commit 步骤不驱动引擎（跑别的 spec 用 [call],不可逆动作走注册工具）');
    }
    return c;
  } catch (err) { if (err instanceof Error && err.message.startsWith('CONFIG_ERROR:')) throw err; return []; }
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
/** 项目级 language 键读取（hopjit.yaml language: zh|en,缺省 en——文件缺席/坏 YAML/坏值一律
 * 回 en 安全侧,读法与 readProjectCommands 同款单键读。^anc-i18n-language-config）。// @a: anc-i18n-serialize-lang */
export function readProjectLanguage(): 'en' | 'zh' {
  try {
    const p = resolve(process.cwd(), 'hopjit.yaml');
    if (!existsSync(p)) return 'en';
    const parsed = yamlLoad(readFileSync(p, 'utf-8')) as { language?: unknown } | null;
    return parsed?.language === 'zh' ? 'zh' : 'en';
  } catch { return 'en'; }
}

// 引擎自有工具执行体工厂注册（执行主体原则 2026-09-05——组合根注入,engine 不越层 import
// tools-composite;body 消化路径经此构造 provider 直执。直执面=内置两成员∪hopjit.yaml 注册件
// （0076 补齐注入半边——工厂内现读,engine 零感知;构造/解析错误经消化路径 catch 折步骤 fail）。
// ^anc-exec-tool-request 分派判据四条款）
// @a: anc-exec-tool-request
ExecutionEngine.setEngineToolProviderFactory(
  makeEngineToolProviderFactory(() => loadProjectToolRegistry(process.cwd())),   // cwd 读在组合根（run 隔离不变量）
);

/** 构造 CLI 默认 HostConfig（workspace=cwd+默认沙箱+项目级 commands/language 键读取）——复用模式
 * 组合根,独立模式命令实例化 Engine/Dispatcher 同用;tool_registry 不在此装配,归工厂内现读〔0076〕。
 * 见 [[hop-cli#^anc-struct-hop-cli]]。（出口注释沿革:2026-09-04 review 抓缺补;2026-09-06 review 抓
 * 0076 批插函数把本注释顶开挂错主后合并归位） */
export function buildHostConfig(): HostConfig {
  return {
    workspace_dir: process.cwd(),
    sandbox: {
      filesystem: { workspace_dir: '.', read_access: { allowed: ['.'],
        // 默认拒读基线：密钥/凭证类即使在 workspace 内也拦（sandbox.md 读权限优先级
        // denied > allowed；2026-08-08 语义审计 ❌ 实抓：设计一贯示例含 .env/*.key,
        // 代码 denied=[] 致默认部署下凭证文件对 LLM read 工具可读）。// @a: anc-config-sandbox-filesystem
        denied: ['.env', '.env.*', '*.key', '*.pem', '.hopstate/**', '.hoplog/**'], confirm_required: [] } },   // .hoplog（#50:LLM 逛日志树 read 巨型 main.yaml 灌爆上下文,dr19 实撞）
      network: { trusted_hosts: [] },
      runtime: { available: readProjectCommands() },   // 配置通路:项目级 hopjit.yaml commands 键（^anc-exec-subprocess-run） // @a: anc-exec-subprocess-run
    },
    language: readProjectLanguage(),   // 生成物语言（^anc-i18n-language-config） // @a: anc-i18n-serialize-lang
    // language 同步注入 hop_env（hop_env_language 键——hopbuild2 拼头 body/doc-ref 经既有通道
    // 消费生成物语言,零新机制;params 显式传 hop_env_language 时按覆盖链后到覆盖）。// @a: anc-i18n-serialize-lang
    hop_env: { hop_env_language: readProjectLanguage() },
    api_key: process.env['HOPJIT_ANTHROPIC_API_KEY'] ?? '',
  };
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

/** context 精简档 resolve：env HOPJIT_CONTEXT_MODE > --context-mode flag > 默认 full。见 [[prompt-assembler#^anc-exec-context-mode]] */
export function resolveContextMode(flag?: string): 'full' | 'minimal' {
  const v = (process.env['HOPJIT_CONTEXT_MODE'] ?? flag ?? '').toLowerCase();
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
        // spec 目录入 allowed——与 init 组合点"随 spec 引用即授权"同款（spec 可在 cwd 外）
        sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.', dirname(resolve(specPath))], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
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
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .option('--log-dir <dir>', 'Log directory for .hoplog output')
  .option('--log-level <level>', 'Log level: debug | info | warn', 'debug')
  .action((specPath: string, opts) => {
    try {
      const content = readFileSync(resolve(specPath), 'utf-8');
      const hostConfig = buildHostConfig();
      let params = resolveParam(opts.params) as Record<string, unknown> | undefined;
      extractHopEnvIntoHostConfig(hostConfig, params);   // @a: anc-config-hop-env
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
        ...(opts.logDir ? { logDir: opts.logDir } : {}),
        ...(opts.logLevel ? { logLevel: opts.logLevel } : {}),
        ...((callMode || isParallelChild) ? { parentInstanceId: childParent, callStepId: childStep } : {}),
        ...(isParallelChild ? { canFanout: false, subtreeRoot: opts.parallelChild } : {}),
        ...(opts.trace ? { traceId: opts.trace } : {}),
        driverChannel: 'cli',   // 双执行硬闸落账 // @a: anc-exec-driver-channel
              ...(opts.upstreamFeedback ? { upstreamFeedback: resolveTextParam(String(opts.upstreamFeedback)) } : {}),   // H2 复用半边（D41）——init_command 携带,汇入 standalone 同一注入口;引擎烘焙恒 @<反馈文件>（^anc-exec-cmd-args-file） // @a: anc-exec-l2c-retry-feedback, anc-exec-cmd-args-file
      };

      const engine = new ExecutionEngine();
      const result = engine.initExecution(content, hostConfig, engineOpts);

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
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .option('--log-dir <dir>', 'Log directory for .hoplog output')
  .option('--log-level <level>', 'Log level: debug | info | warn', 'debug')
  .option('--context-mode <mode>', 'Context verbosity: full (default) | minimal (see ^anc-exec-context-mode)')
  .option('--notify <channel>', 'Notify channel at terminal/paused states (currently: dingtalk; persisted into instance state; ^anc-cli-notify-reuse)')
  .action(async (specPath: string, opts) => {
    try {
      const content = readFileSync(resolve(specPath), 'utf-8');
      const hostConfig = buildHostConfig();

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
        // HopLog 恒开（缺省 <state-dir>/../.hoplog，同 driver 模板约定与 mcp-server 先例）——
        // 轨迹是 G11 核真过程的凭证，不能依赖 driver LLM 记得传参（2026-08-08 E2E 实撞：
        // subagent 漏抄模板参数即无轨迹假红）。--log-dir 仍可显式改址。// @a: anc-obs-hoplog-always-on
        logDir: resolve(opts.logDir ?? join(opts.stateDir, '..', '.hoplog')),
        ...(opts.logLevel ? { logLevel: opts.logLevel } : {}),
        contextMode: resolveContextMode(opts.contextMode),  // env > flag > full。 // @a: anc-exec-context-mode
        driverChannel: 'cli',   // 双执行硬闸落账 // @a: anc-exec-driver-channel
      };
      const engine = new ExecutionEngine();
      const initResult = engine.initExecution(content, hostConfig, engineOpts);
      if (initResult.status !== 'ok') { output(initResult); return; }
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
  .option('--output <json>', 'Step result (reason/check/act) as JSON or @file')
  .option('--answer <json>', 'Confirm decision (HITL) as JSON or @file')
  .option('--child-instance <id>', 'Call child instance ID (maps callee outputs back)')
  .option('--failure-child <id>', 'Call child instance ID that FAILED (engine assembles CalleeFailure from child state)')
  .option('--failure <text>', 'Step failure reason')
  .option('--branch <case-id>', 'Branch case selection')
  .option('--replan <md>', 'Replanned children markdown or @file (for adaptive_needed)')
  .option('--proactive', '主动计划编辑（不经失败,/hop 边跑边改——只编未执行部分,^anc-exec-replan-proactive）')
  .option('--extend-expansion', '展开超限续批（EXPANSION_LIMIT 后经真人批准重交——一次授权放行一次,^anc-exec-subtask-free-expand 契约7）')
  .option('--tool-result <json>', 'Single tool result (answers tool_request) as JSON or @file')
  .option('--reason <text>', 'Optional reason (for branch selection audit)')
  .option('--instance <id>', 'Instance ID')
  .option('--state-dir <dir>', 'State directory', '.hopstate')
  .action(async (stepId: string, opts) => {
    try {
      // 互斥校验：一次只提交一种
      const modes = ['output', 'answer', 'childInstance', 'failureChild', 'failure', 'branch', 'replan', 'toolResult']
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
      } else if (opts.branch !== undefined) {    // 分支选择
        writeResult = engine.selectBranch(stepId, opts.branch, opts.reason);
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
        const outputs = raw ? (resolveParam(raw, workZoneBase) as Record<string, unknown>) : undefined;
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
      // 项目级 tool_servers 注册面装配（与消化路径直执面同一公共函数 loadProjectToolRegistry——
      // 0076 提取消重复;坏节 fail-fast 由 parseToolServers 承担）
      try {
        const reg = loadProjectToolRegistry(process.cwd());
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
// @a: anc-cli-carrier-home-resolution
type Carrier = 'cc' | 'codex' | 'cfuse-cc' | 'cfuse-codex' | 'opencode';
type DriverFamily = 'cc' | 'codex';
const CARRIER_VALUES: Carrier[] = ['cc', 'codex', 'cfuse-cc', 'cfuse-codex', 'opencode'];
function carrierFamily(c: Carrier): DriverFamily {
  return c === 'codex' || c === 'cfuse-codex' ? 'codex' : 'cc';
}
function resolveCarrierHome(c: Carrier): string {
  const h = homedir();
  switch (c) {
    case 'cc':          return process.env.CLAUDE_CONFIG_DIR || join(h, '.claude');
    case 'codex':       return process.env.CODEX_HOME       || join(h, '.codex');
    case 'cfuse-cc':    return join(h, '.codefuse', 'engine', 'cc');
    case 'cfuse-codex': return join(h, '.codefuse', 'engine', 'codex');
    // opencode 用 XDG：OPENCODE_CONFIG_DIR 重定向 config 目录,缺席回落 $XDG_CONFIG_HOME/opencode（默认 ~/.config/opencode,非 ~/.opencode）。
    case 'opencode':    return process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(h, '.config'), 'opencode');
  }
}
function assertCarrier(c: string, cmd: string): asserts c is Carrier {
  if (!CARRIER_VALUES.includes(c as Carrier))
    throw new Error(`${cmd}_ERROR: 未知 carrier '${c}'（支持: ${CARRIER_VALUES.join(' | ')}）`);
}

// opencode 配置文件:跟随 opencode globalConfigFile,candidates [opencode.jsonc, opencode.json],
// 第一个存在;都不存在用 opencode.jsonc（opencode 标准,首次启动生成它）。见 ^anc-cli-install-skill opencode 载体。
function resolveOcConfigPath(carrier: Carrier): string {
  const home = resolveCarrierHome(carrier);
  for (const f of ['opencode.jsonc', 'opencode.json', 'config.json']) {   // 对齐 opencode globalConfigFile 三候选
    const p = join(home, f);
    if (existsSync(p)) return p;
  }
  return join(home, 'opencode.jsonc');
}

// 递归 deep-merge(对齐 opencode mergeDeep):object 递归合并(后者覆盖同名),数组/原始值后者覆盖。
// 用于 opencode 自举 deep-merge provider——options 内部(baseURL/apiKey)也合并,而非浅 merge 整体覆盖。
function deepMerge<T>(a: T, b: unknown): T {
  if (typeof a === 'object' && a !== null && !Array.isArray(a) && typeof b === 'object' && b !== null && !Array.isArray(b)) {
    const result: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
      result[k] = deepMerge(result[k], v);
    }
    return result as T;
  }
  return (b ?? a) as T;
}

// --mcp 配置自举：两级 standalone 配置全缺席时,按载体学习宿主 LLM 后端写系统级配置。
// CC=ANTHROPIC_* 环境变量族;Codex=~/.codex/config.toml 的 model_provider 链。只写凭证名不写值。
// 学习源缺失→不写文件,note 明示需自建。见 design/hop-cli.md ^anc-cli-install-skill --mcp 配置自举子条。
// @a: anc-cli-install-skill
export function bootstrapStandaloneConfig(carrier: Carrier): { written: string | null; note: string } {
  const sysPath = join(homedir(), '.hopjit', 'config.yaml');
  const projPath = resolve(process.cwd(), 'hopjit.yaml');
  if (existsSync(sysPath) || existsSync(projPath)) {
    return { written: null, note: `standalone 配置已存在（${existsSync(sysPath) ? sysPath : projPath}）——未改动（用户资产）` };
  }

  let entry: { service_id: string; protocol: string; base_url: string; model: string; api_key_env: string };
  if (carrier === 'opencode') {
    // opencode 自举：deep-merge 三文件（opencode 加载顺序 config.json → opencode.json → opencode.jsonc,
    // 后者覆盖、.jsonc 优先,与 opencode 加载一致）取 model + provider.<id>.options.baseURL + env[0]（凭证名）。
    // protocol 忠实照抄 provider.<id>.npm 字段（0020 批改定——npm 字段=opencode 的 wire_api 等价物:
    // 声明该 provider 用哪个 AI SDK,官方文档明定 @ai-sdk/openai→/v1/responses、
    // @ai-sdk/openai-compatible→chat/completions、@ai-sdk/anthropic→Anthropic 原生）;
    // npm 缺席（内置 provider 协议定义在 opencode 内置注册表,配置文件里抄不到）回退 id 推断:
    // 含 anthropic→anthropic,否则保守取 openai-chat（猜 responses 撞无此面端点=启动即炸,不猜）。
    // 只写凭证名不写值。学习源缺失→不写文件,note 明示。见 design/hop-cli.md ^anc-cli-install-skill opencode 载体 LLM 自举子条。
    // @a: anc-cli-install-skill
    const home = resolveCarrierHome(carrier);
    const ocFiles = ['config.json', 'opencode.json', 'opencode.jsonc'].map(f => join(home, f));   // opencode 加载顺序
    let model: string | undefined;
    const provider: Record<string, { options?: { baseURL?: string }; env?: string[]; npm?: string }> = {};
    let anyExists = false;
    for (const f of ocFiles) {
      if (!existsSync(f)) continue;
      anyExists = true;
      const errs: ParseError[] = [];
      const c = parseJsonc(readFileSync(f, 'utf-8'), errs) as { model?: string; provider?: Record<string, { options?: { baseURL?: string }; env?: string[]; npm?: string }> };
      if (errs.length > 0) continue;   // 坏文件跳过(best-effort,不阻断 deep-merge 其他文件)
      if (c.model) model = c.model;   // 后者覆盖(.jsonc 优先)
      if (c.provider) {
        for (const [id, p] of Object.entries(c.provider)) {
          provider[id] = deepMerge(provider[id], p);   // 递归 deep-merge provider.<id>(对齐 opencode mergeDeep,options 内部也合并)
        }
      }
    }
    if (!anyExists) {
      return { written: null, note: `未自举 standalone 配置：${resolveOcConfigPath(carrier)} 不存在——请自建 ~/.hopjit/config.yaml` };
    }
    if (!model || !model.includes('/')) {
      return { written: null, note: `未自举 standalone 配置：opencode 配置缺 model（"provider/model-id" 格式）——请自建 ~/.hopjit/config.yaml` };
    }
    const slashIdx = model.indexOf('/');
    const providerId = model.slice(0, slashIdx);
    const modelId = model.slice(slashIdx + 1);
    const prov = provider[providerId];
    const baseUrl = prov?.options?.baseURL;
    const envKey = prov?.env?.[0];
    if (!baseUrl) {
      return { written: null, note: `未自举 standalone 配置：provider.${providerId} 缺 options.baseURL——请自建 ~/.hopjit/config.yaml` };
    }
    entry = {
      service_id: 'opencode_host',
      protocol: prov?.npm === '@ai-sdk/anthropic' ? 'anthropic'
        : prov?.npm === '@ai-sdk/openai' ? 'openai-responses'
        : prov?.npm ? 'openai-chat'   // @ai-sdk/openai-compatible 及其余 SDK 包一律 chat
        : providerId.toLowerCase().includes('anthropic') ? 'anthropic' : 'openai-chat',
      base_url: baseUrl,
      model: modelId,
      api_key_env: envKey ?? 'OPENAI_API_KEY',
    };
  } else if (carrierFamily(carrier) === 'cc') {
    // 两级学习链：①进程环境 ANTHROPIC_* ②CC settings 文件族 env 块+顶层 model（项目级>用户级——
    // 覆盖"普通终端跑装配"形态:settings env 块只在 CC 会话内注入子进程;运行期 server 由 CC 拉起
    // 必继承 env 块,凭证名引用仍有效）。只取"哪个名字被配了"不抄值（standalone 不变量第 1 条）。
    // 用户级 settings 路径按 carrier home 解析（^anc-cli-carrier-home-resolution——cfuse-cc 读 ~/.codefuse/engine/cc）。
    const settingsEnv: Record<string, string> = {};
    let settingsModel: string | undefined;
    for (const sp of [
      join(resolveCarrierHome(carrier), 'settings.json'),
      resolve(process.cwd(), '.claude', 'settings.json'),
      resolve(process.cwd(), '.claude', 'settings.local.json'),   // 后读者赢=项目级>用户级
    ]) {
      if (!existsSync(sp)) continue;
      try {
        const s = JSON.parse(readFileSync(sp, 'utf-8')) as { env?: Record<string, string>; model?: string };
        for (const [k, v] of Object.entries(s.env ?? {})) if (typeof v === 'string') settingsEnv[k] = v;
        if (typeof s.model === 'string' && s.model.trim()) settingsModel = s.model;
      } catch { /* 坏 settings 不阻塞自举——学习链落下一级 */ }
    }
    const has = (name: string) => !!(process.env[name]?.trim() || settingsEnv[name]?.trim());
    const val = (name: string) => process.env[name]?.trim() || settingsEnv[name]?.trim() || '';
    const keyEnv = has('ANTHROPIC_AUTH_TOKEN') ? 'ANTHROPIC_AUTH_TOKEN'
      : has('ANTHROPIC_API_KEY') ? 'ANTHROPIC_API_KEY' : null;
    if (!keyEnv) {
      // 两级链都空（如 OAuth 订阅登录——凭证在 keychain 无 env 名,且订阅凭证本不可复用给独立 server）
      return { written: null, note: '未自举 standalone 配置：进程环境与 CC settings 文件均无 ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY（OAuth 订阅登录的凭证不可复用给独立 server）——请自建 ~/.hopjit/config.yaml 并配 API key（格式见 docs/reference/配置参考）' };
    }
    entry = {
      service_id: 'cc_host',
      protocol: 'anthropic',
      base_url: val('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com',
      model: val('ANTHROPIC_MODEL') || settingsModel || ENGINE_DEFAULT_MODEL,   // 缺省=引擎缺省模型同源常量（0086 续账修:原字面量第二真值）
      api_key_env: keyEnv,
    };
  } else {
    const tomlPath = join(resolveCarrierHome(carrier), 'config.toml');
    if (!existsSync(tomlPath)) {
      return { written: null, note: `未自举 standalone 配置：${tomlPath} 不存在——请自建 ~/.hopjit/config.yaml` };
    }
    const toml = readFileSync(tomlPath, 'utf-8');
    const model = toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    const providerId = toml.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1];
    // provider 表：providerId 命中 [model_providers.<id>] 节内取 base_url/env_key（节界=下一个 [ 行）
    let baseUrl: string | undefined; let envKey: string | undefined; let wireApi: string | undefined;
    if (providerId) {
      const section = toml.split(new RegExp(`\\[model_providers\\.${providerId}\\]`))[1]?.split(/\n\[/)[0];
      baseUrl = section?.match(/base_url\s*=\s*"([^"]+)"/)?.[1];
      envKey = section?.match(/env_key\s*=\s*"([^"]+)"/)?.[1];
      wireApi = section?.match(/wire_api\s*=\s*"([^"]+)"/)?.[1];
    }
    if (!model || !baseUrl) {
      return { written: null, note: `未自举 standalone 配置：${tomlPath} 缺 model/model_provider 的 base_url——请自建 ~/.hopjit/config.yaml` };
    }
    entry = {
      service_id: 'codex_host',
      // protocol 忠实照抄宿主 wire_api（0020 批撤强制降级——responses 适配器实装后照抄即忠实,
      // 原"一律学 openai-chat"防的是预留枚举启动即炸,前提已消;缺省 chat 与 Codex 同）
      protocol: wireApi === 'responses' ? 'openai-responses' : 'openai-chat',
      base_url: baseUrl,
      model,
      api_key_env: envKey ?? 'OPENAI_API_KEY',
    };
  }

  mkdirSync(dirname(sysPath), { recursive: true });
  // providers 节走 YAML 序列化器——值来自宿主配置不可控,裸模板拼接遇 ": "/"#" 类字符产物
  // 即炸自家加载器（二审探针实抓:model 值含冒号空格 → loadStandaloneConfig bad indentation）
  const yaml = `# hopjit standalone 配置——install-skill --mcp 自举于 ${new Date().toISOString()}
# 学习源：${carrier === 'opencode' ? 'opencode 宿主配置文件（deep-merge config.json/opencode.json/opencode.jsonc,model + provider.<id>）' : carrierFamily(carrier) === 'cc' ? 'Claude Code 宿主环境变量（ANTHROPIC_*）' : 'Codex 宿主 config.toml（model_provider 链）'}
# 凭证只存环境变量名（${entry.api_key_env}）,值不落盘。格式与改法见 docs/reference/配置参考.md
` + yamlDump({ providers: [entry] });
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

// CC 跨 scope 已注册感知：user 级（<CC home>/.claude.json 顶层 mcpServers）与 local 级（projects["<cwd>"]
// .mcpServers）任一有 hopjit 即返回所在 scope 描述,均无返回 null。<CC home>/.claude.json 缺席/解析失败
// 一律 null（best-effort——CC 内部格式演进不拦装）。.claude.json 位置按 ^anc-cli-carrier-home-resolution
// 解析:cfuse-cc 固定 ~/.codefuse/engine/cc/.claude.json;cc 载体读 CLAUDE_CONFIG_DIR（设时 .claude.json 在
// 其下,未设在 home 根 ~/.claude.json——.claude.json 原生与 ~/.claude/ 目录不同层,CLAUDE_CONFIG_DIR
// 重定向后才进配置目录）。见 hop-cli ^anc-cli-install-skill 注册条。
// @a: anc-cli-install-skill
export function detectCcHopjitRegistration(carrier: 'cc' | 'cfuse-cc' = 'cc'): string | null {
  const ccJsonPath = carrier === 'cfuse-cc'
    ? join(resolveCarrierHome('cfuse-cc'), '.claude.json')
    : (process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'));
  if (!existsSync(ccJsonPath)) return null;
  try {
    const cc = JSON.parse(readFileSync(ccJsonPath, 'utf-8')) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    if (cc.projects?.[process.cwd()]?.mcpServers?.['hopjit']) return `CC local 级,${ccJsonPath} projects["${process.cwd()}"]`;
    if (cc.mcpServers?.['hopjit']) return `CC user 级,${ccJsonPath}`;
    return null;
  } catch { return null; }
}

// install-skill：把包内 driver/ 的 skill 源展开到 .claude/skills/（CC）或 .agents/skills/（Codex）。
// 纯文件拷贝、不涉引擎状态。包根用 import.meta.url 定位（不依赖 cwd）。见 design/hop-cli.md ^anc-cli-install-skill。
// @a: anc-cli-install-skill
program.command('install-skill')
  .description('Install hopspec driver skills for Claude Code / Codex (native or cfuse) from the package driver/ sources')
  .option('--dir <target>', 'Skills root directory (default: resolved per carrier — cc/codex read CLAUDE_CONFIG_DIR/CODEX_HOME, cfuse-cc/cfuse-codex use ~/.codefuse/engine/{cc,codex}/skills, opencode uses ~/.config/opencode/skills)')
  .option('--carrier <carrier>', 'Driver carrier: cc | codex | cfuse-cc | cfuse-codex | opencode', 'cc')
  .option('--demo', 'Also install the coffee-week demo skill for the selected carrier')
  .option('--plus', 'Also install the hop-fact-check and hop-deep-research research skills, and merge their tool_servers config into ~/.hopjit/config.yaml')
  .option('--mcp', 'Bootstrap standalone config and register the hopjit MCP server (CC: .mcp.json; Codex: <Codex home>/config.toml per ^anc-cli-carrier-home-resolution). Both shells (hopspec + hopspec-mcp) are always installed')   // 双名双壳,--mcp 只管注册 // @a: anc-cli-install-skill
  .option('--force', 'Overwrite existing files')
  .action((opts) => {
    try {
      // 包根 = cli.js（dist/cli.js）的 dist 的上一级
      const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const driverDir = join(pkgRoot, 'driver');
      if (!existsSync(driverDir)) {
        errorExit(`INSTALL_SKILL_ERROR: 包内未找到 driver/（${driverDir}）——确认包完整安装`);
        return;
      }
      assertCarrier(opts.carrier, 'INSTALL_SKILL');
      const carrier = opts.carrier as Carrier;
      // 目标按 carrier home 解析（^anc-cli-carrier-home-resolution）：cc/codex 读官方环境变量
      // CLAUDE_CONFIG_DIR/CODEX_HOME（自动适配当前环境,如 cfuse 内置载体重定向）;cfuse-cc/cfuse-codex
      // 固定 ~/.codefuse/engine/{cc,codex}/skills（裸终端显式指定 cfuse 目标）。--dir 覆盖。
      // demo 例外恒项目级见 --demo 段。见 [[hop-cli#^anc-cli-carrier-home-resolution]]。
      const targetArg = opts.dir ?? join(resolveCarrierHome(carrier), 'skills');
      const target = isAbsolute(targetArg) ? targetArg : resolve(process.cwd(), targetArg);
      const installed: string[] = [];
      const force = opts.force === true;
      // 版本可见性：响应带 driver_version/driver_source；SKILL.md frontmatter 后注入版本戳注释——
      // 已装副本自身可查（head -5），不依赖安装时的响应。见 [[hop-cli#^anc-cli-install-skill]] 版本可见性条。
      const driverVersion = readPackageVersion();
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
        // 每次装机（force 与否）落 manifest——本次源清单即下次清理的管辖面
        if (existsSync(dstDir)) {
          writeFileSync(join(dstDir, MANIFEST_NAME),
            JSON.stringify({ version: readPackageVersion(), files: [...sourceNames].sort() }, null, 2), 'utf-8');
        }
      };

      let codexLegacyNote: string | undefined;
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
      } else if (carrierFamily(carrier) === 'codex') {
        // Codex 载体（codex | cfuse-codex,共用 codex driver 源）：main / segment driver 按 agent 主体拆分。
        // 只复用真正载体中立的 cli-discovery，其余 references 使用 Codex 自包含版本。
        // 装点=<target>/hopspec 直拼（2026-08-27 看齐批——target 即 skills 根,不再拼 .agents/skills 中间层）。
        // 见 design/codex-driver-carrier.md ^anc-driver-codex-install-layout。
        // @a: anc-driver-codex-install-layout
        const skillDir = join(target, 'hopspec');
        // 旧项目级残留检测（作者抓"项目级留着老skill只会造成版本冲突"——Codex 同名 project>user,
        // cwd 的 .agents/skills 旧件会永久盖住用户级新版=静默旧版锁定）：正式件残留响亮提示;
        // 不自动删（可能是用户有意的项目级钉版,删除权归人）。demo 件属项目级正品不报。
        const legacyRoot = join(process.cwd(), '.agents', 'skills');
        if (resolve(legacyRoot) !== resolve(target)) {
          const legacy = ['hopspec', 'hop'].filter(n => existsSync(join(legacyRoot, n, 'SKILL.md')));
          if (legacy.length > 0) {
            codexLegacyNote = `⚠️ 当前项目 .agents/skills/ 有旧安装残留（${legacy.join(', ')}）——Codex 同名 skill 项目级优先于用户级,残留会盖住本次安装的新版。确认非有意钉版后删除:rm -rf ${legacy.map(n => join(legacyRoot, n)).join(' ')}`;
          }
        }
        // 双名双壳（2026-08-27 四改）：恒装两壳——$hopspec（复用）与 $hopspec-mcp（MCP 薄壳）
        // 不同名并存,名字即模式;--mcp 只管"配置自举+注册 server"。// @a: anc-cli-install-skill
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
        // 不同名并存,名字即模式;--mcp 只管"配置自举+注册 server"。// @a: anc-cli-install-skill
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

      // --demo：附装 carrier 对应的 coffee-week 演示 skill（CC=/coffee-week，Codex=$coffee-week）。
      // 内部走 carrier-aware packSpec，保持具名能力生成逻辑单一实现。
      // 见 [[hop-cli#^anc-cli-install-skill]] --demo 条。
      let demoNote: string | undefined;
      if (opts.demo === true) {
        // demo 集全装,skill 名一律 demo- 前缀（命名空间:一眼识别演示件/可整批删/不与用户 skill 撞名;
        // spec Id 不改——Id 牵动 call 引用与 hoplog spec_id）。见 [[hop-cli#^anc-cli-install-skill]] --demo 条。
        const DEMO_SET: { spec: string; name: string; assets?: string }[] = [
          { spec: 'coffee-week.md', name: 'demo-coffee-week', assets: 'coffee-sales.json' },
          { spec: 'fact-check-demo.md', name: 'demo-fact-check', assets: 'fact-check-sample.md' },
          { spec: join('syntax', 'confirm-commit.md'), name: 'demo-rename', assets: undefined },
        ];
        // demo 恒项目级（2026-08-27 作者定"只有 demo 是项目级"——演示材料跟项目走,正式件用户级）：
        // Codex 落 cwd 的 .agents/skills;CC 维持 target（CC 无项目级/用户级张力,demo 随正式件同点）。
        const demoTarget = carrierFamily(carrier) === 'codex'
          ? join(process.cwd(), '.agents', 'skills')
          : target;
        const demoNotes: string[] = [];
        for (const demo of DEMO_SET) {
          const demoResult = packSpec(join(pkgRoot, 'examples', demo.spec), {
            dir: demoTarget,
            carrier: carrier,
            name: demo.name,
            assets: demo.assets,
            force,
          });
          if (demoResult.status === 'ok') {
            installed.push(...demoResult.installed);
            if (demoResult.installed.length === 0) demoNotes.push(`${demo.name} 已存在（--force 覆盖）`);
          } else {
            demoNotes.push(`${demo.name} 安装失败：${demoResult.message}`);
          }
        }
        if (demoNotes.length > 0) demoNote = demoNotes.join('；');
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
            writeFileSync(cfgPath, yamlDump(cfg, { lineWidth: -1, noRefs: true }), 'utf-8');
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
      let mcpConfigBootstrapped: string | null = null;
      let mcpConfigNote: string | undefined;
      if (opts.mcp === true) {
        const r = bootstrapStandaloneConfig(carrier);
        mcpConfigBootstrapped = r.written;
        mcpConfigNote = r.note;
      }

      // --mcp 同步注册 MCP server（2026-08-16 作者定——装壳+注册一个动作;显式 flag 即授权）。
      // 已有 hopjit 条目一律跳过（注册配置是用户资产,--force 不覆盖注册面——force 只管壳文件）。
      // CC 合并写 <cwd>/.mcp.json（保留其他 server）;Codex 追加 ~/.codex/config.toml [mcp_servers.hopjit]
      //（env_vars 凭证名透传——Codex 干净环境启动 stdio server 实撞防线,值不落盘只写名）。
      // 见 [[hop-cli#^anc-cli-install-skill]] --mcp 条。// @a: anc-cli-install-skill
      let mcpRegistered: string | null = null;
      let mcpNote: string | undefined;
      if (opts.mcp === true) {
        if (carrier === 'opencode') {
          // opencode 注册:跟随 opencode 配置管理——写 candidates [opencode.jsonc, opencode.json, config.json] 第一个存在
          // （对齐 opencode globalConfigFile 三候选;都不存在用 opencode.jsonc）的 mcp.hopjit。
          // jsonc-parser modify/applyEdits 保留原格式+注释——hoplogic 对所有候选文件统一 jsoncModify
          // （opencode 仅 .jsonc 用 patchJsonc,非 .jsonc 用 stringify 重新格式化;hoplogic 统一 jsoncModify 更优雅——
          // 保留原格式不重新格式化用户文件,是"高质量优雅"取舍,不严格跟随 opencode 非 .jsonc 的 stringify）。
          // 检测 candidates 查 mcp.hopjit（.jsonc/opencode.json/config.json 任一已有则跳过,消除只查一个文件漏其他的静默冲突）。
          // 坏 JSON best-effort 不阻断 skill 安装（与 cc 分支 .claude.json 同纪律）。// @a: anc-cli-install-skill
          const home = resolveCarrierHome(carrier);
          const candidates = [join(home, 'opencode.jsonc'), join(home, 'opencode.json'), join(home, 'config.json')];
          const existing = candidates.find(p => {
            if (!existsSync(p)) return false;
            const errs: ParseError[] = [];
            const c = parseJsonc(readFileSync(p, 'utf-8'), errs) as { mcp?: Record<string, unknown> };
            return errs.length === 0 && !!c.mcp?.['hopjit'];   // 坏 JSON(errs 非空)不算已配
          });
          if (existing) {
            mcpNote = `已有 mcp.hopjit 条目，未改动（${existing}）——请自查 command`;
          } else {
            const configPath = candidates.find(p => existsSync(p)) ?? candidates[0];
            const text = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '{}';
            const errs: ParseError[] = [];
            parseJsonc(text, errs);
            if (errs.length > 0) {   // jsonc-parser parse 不抛错,坏 JSON 填 errs
              mcpNote = `${configPath} 不是合法 JSON——未注册 MCP（不覆盖用户配置,请修复后重试 --mcp）`;
            } else {
              // 默认 enabled:false——避免 LLM 在有 hopjit_start_run MCP 工具可用时自决调它、劫持 // @a: anc-cli-install-skill
              // hopspec 复用模式（名字即模式:hopspec=复用 CLI / hopspec-mcp=standalone MCP）。
              // opencode 无 MCP 优先机制（MCP 工具与内置工具平级注入同一工具字典，session/tools.ts:390-490（1.18.31）
              // 无优先级/权重，工具选择由 LLM 在 toolChoice:auto 下自决）——劫持是 LLM 的自决倾向，
              // 非 opencode 引导；enabled:false 经 opencode mcp/index.ts:514-517（1.18.31）使 server 不启动、工具不注入，
              // 机制层兜住（skill 指令拦不住 LLM 用 MCP）。走 standalone（hopspec-mcp）时用户手动改 enabled:true。
              const value = { type: 'local', command: ['hopjit-mcp'], enabled: false, environment: {} };
              const edits = jsoncModify(text, ['mcp', 'hopjit'], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
              mkdirSync(dirname(configPath), { recursive: true });
              writeFileSync(configPath, jsoncApplyEdits(text, edits), 'utf-8');
              mcpRegistered = configPath;
              mcpNote = `已注册 mcp.hopjit（默认 enabled:false,避免劫持 hopspec 复用模式）。走 standalone（用 hopspec-mcp skill）时手动改 enabled:true`;
            }
          }
        } else if (carrierFamily(carrier) === 'codex') {
          const configPath = join(resolveCarrierHome(carrier), 'config.toml');
          const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
          if (/\[mcp_servers\.hopjit\]/.test(existing)) {
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
          const existingScope = detectCcHopjitRegistration(carrier as 'cc' | 'cfuse-cc');
          const configPath = resolve(process.cwd(), '.mcp.json');
          if (existingScope) {
            mcpNote = `已有 hopjit 注册（${existingScope}）,未写 .mcp.json——同名多 scope 会冲突且窄 scope 优先;请自查该注册指向`;
          } else {
            let config: { mcpServers?: Record<string, unknown> } = {};
            if (existsSync(configPath)) {
              try { config = JSON.parse(readFileSync(configPath, 'utf-8')); }
              catch { throw new Error(`INSTALL_SKILL_ERROR: ${configPath} 不是合法 JSON——修复后重试（不覆盖用户配置）`); }
            }
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
      }

      const skipped = installed.length === 0;
      // 陈旧副本新鲜度提示（hopissues/0096——作者定"给的不是清理命令,是 hopfix 这样的升级命令"：
      // 只读扫描本安装器写过的旧位置,发现陈旧报 stale_notes 携升级路径,不代删不代改。
      // 认领判据=SKILL.md 含本器版本戳才认（非本器文件零打扰）;陈旧判据=戳版本落后当前包版本,
      // 或 spec.md 无 engine_min_version 指纹（0093 前旧产物）。0096 实撞:8-14 旧 demo 副本
      // 缺 web_search 授权在历史用户级位置静默活着,29 child 全灭 116 次失败提交后才被发现。
      // 见 hop-cli ^anc-cli-stale-skill-scan）。// @a: anc-cli-stale-skill-scan
      const staleNotes: string[] = [];
      {
        const scanRoots = carrierFamily(carrier) === 'codex'
          ? [join(homedir(), '.agents', 'skills')]                       // Codex 族历史用户级装载点（demo 恒项目级口径前）
          : [join(homedir(), '.claude', 'skills')];                      // CC 族:demo 改恒项目级前的旧装位置
        for (const root of scanRoots) {
          if (resolve(root) === resolve(target)) continue;               // 现行目标不算旧位置
          if (!existsSync(root)) continue;
          for (const name of readdirSync(root)) {
            const sk = join(root, name, 'SKILL.md');
            if (!existsSync(sk)) continue;
            let head = '';
            try { head = readFileSync(sk, 'utf-8'); } catch { continue; }
            const m = head.match(/driver: @hoplogic\/hopjit v(\S+)/);
            if (!m) continue;                                            // 非本安装器产物,零打扰
            const specPath = join(root, name, 'spec.md');
            const noFingerprint = existsSync(specPath) && !readFileSync(specPath, 'utf-8').includes('engine_min_version');
            const older = m[1] !== driverVersion;
            if (!older && !noFingerprint) continue;
            const isBundled = ['hopspec', 'hopspec-mcp', 'hop', 'hopbuild', 'hopbuild2', 'hopfix'].includes(name) || name.startsWith('demo-') || name.startsWith('hop-');
            staleNotes.push(isBundled
              ? `⚠️ 旧位置发现陈旧副本 ${join(root, name)}（装于 v${m[1]},当前 v${driverVersion}）——该位置已不受本次安装管辖,可能被载体优先加载盖住新版。升级:现行位置已随本次安装刷新;旧位置文件请自行处置（确认无自改内容后可删,路径如上）`
              : `⚠️ 旧位置发现陈旧的自建 skill ${join(root, name)}（装于 v${m[1]},当前 v${driverVersion}）——升级走 /hopfix 定向修正（validate error 清单为工单的版本迁移正门,不是简单覆盖）`);
          }
        }
      }
      output({
        status: 'ok',
        carrier: carrier,
        driver_version: driverVersion,
        driver_source: pkgRoot,
        target,
        installed,
        ...(removed.length ? { removed } : {}),   // 受管目录清理清单（--force 档）// @a: anc-cli-install-skill
        ...(demoNote ? { demo_note: demoNote } : {}),
        ...(plusNote ? { plus_note: plusNote, plus_tools_merged: plusToolsMerged } : {}),
        ...(codexLegacyNote ? { legacy_note: codexLegacyNote } : {}),
        ...(opts.mcp === true ? { mcp_registered: mcpRegistered } : {}),
        ...(mcpNote ? { mcp_note: mcpNote } : {}),
        ...(opts.mcp === true ? { mcp_config_bootstrapped: mcpConfigBootstrapped } : {}),
        ...(mcpConfigNote ? { mcp_config_note: mcpConfigNote } : {}),
        ...(staleNotes.length ? { stale_notes: staleNotes } : {}),   // @a: anc-cli-stale-skill-scan
        ...(skipped ? { note: '无文件写入（目标已存在，用 --force 覆盖）' } : {}),
      });
    } catch (err: unknown) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });


// pack：把一个 hopskill spec 打包成载体对应的独立具名 skill。
// 产品形态：用户拿到的是具名能力（"帮我评审文档"），HopSpec/hopjit 是实现细节不外露。
// 薄包装只做触发+参数引导+执行委托，驱动协议单一权威在 hopspec skill（内嵌=第二真值必漂移）。
// 核心逻辑提炼为 packSpec()——pack 命令与 install-skill --demo 共用（单一实现，不复制）。
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
    sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.', packSpecDir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
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
  const knowledgeNote = knowledgeDocs.length
    ? `\n本目录还包含判据知识文档（${knowledgeDocs.join('、')}），引擎执行时按 spec 内 doc-ref 自动切片注入，无需手动引用。`
    : '';

  // 前置段装驱动命令/位置按 carrier 生成（^anc-cli-carrier-home-resolution——cfuse-* 载体的 pack 产物
  // 要指引用户装到 cfuse home,不能硬编码原生 ~/.claude / ~/.codex,否则 cfuse 用户照做装错位置）
  const installHint = opts.carrier === 'cfuse-cc' ? '`hopjit install-skill --carrier cfuse-cc`'
    : opts.carrier === 'cfuse-codex' ? '`hopjit install-skill --carrier cfuse-codex`'
    : opts.carrier === 'opencode' ? '`hopjit install-skill --carrier opencode`'
    : carrierFamily(opts.carrier) === 'codex' ? '`hopjit install-skill --carrier codex`'
    : '`hopjit install-skill`';
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

**输入确认等暂停点由 spec 内的 ask/confirm 步骤引擎强制**——按 hopspec 协议原样呈给用户拍板（不要代答）；终态后向用户报告 outputs。${knowledgeNote}

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
3. 终态完整输出 YAML。${knowledgeNote}

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
      const rewritten = injectEngineMinVersion(raw.replace(/^Id:\s*\S+.*$/m, `Id: ${opts.name}`));
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
