// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: hopant ^anc-struct-hopant
// HopAnt 实体在引擎侧的第一个模块：目录布局、安装、配置适配、本机索引（概念 HopAnt概念
// ^anc-struct-hopant-layout / -package / -lifecycle,设计 [[hopant]]）。纯函数：home、环境变量表、
// PATH、git 用户名、主机名、引擎版本全部由组合根 cli.ts 取好传入,本文件零 process.* 引用、不起子进程、
// 不执行 spec。inner_store 内部机制归 todo/0144,这里只建目录与放适配戳文件。

import { existsSync, readdirSync, statSync, mkdirSync, cpSync, rmSync, renameSync, readFileSync, writeFileSync, accessSync, realpathSync, constants } from 'node:fs';
import { join, basename, dirname, sep, relative, isAbsolute, resolve, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { parseSpec, sectionSpans, toolSigName, splitArgvPrefix } from './parser.js';
import { B2_BUILTIN_FILE_TOOLS, B2_BUILTIN_NOTIFY_TOOLS } from './validator.js';
import { ExecutionEngine } from './engine.js';
import { getChildren } from './ast-helpers.js';
import type { SpecHeader, StepNode, ToolNeed, ActStatement, ActExpr, CallExpr } from './ast-types.js';
import type { ToolServerEntry } from './tools-registry.js';
import { STANDARD_TOOL_NAMES, YAML_DUMP_OPTS, NATIVE_FIRST_BUILTIN_SPECIAL_TOOL_NAMES } from './provider-types.js';
import { ACT_BUILTIN_NAMES } from './act-builtins.js';

// ---------- 类型 ----------

/** 来源目录的形态：single=单 HopAnt 目录 / package=HopAnt 包根（含 ants/）/ invalid=都不是 */
export type SourceKind = 'single' | 'package' | 'invalid';

/** 安装计划（planInstall 产出,applyInstall 消费;--dry-run 原样呈给用户）*/
export interface InstallPlan { // @a: anc-hopant-install
  root: string;   // 装到哪一级的根（roots.user 或 roots.project）——applyInstall 末尾重建这一级的索引
  source_kind: SourceKind;
  ok: boolean;
  ants: { id: string; src: string; dst: string; conflict: boolean; hasBootstrap: boolean }[];
}

/** 安装结果：装了谁、跳过了哪些本机面文件、哪些 ant 带 bootstrap.js 等用户决定 */
export interface InstallResult { // @a: anc-hopant-install
  installed: string[];
  skipped_local_files: string[];
  bootstrap_pending: string[];
}

/** 机器侧事实,全部由组合根取好传入——模块自身不读进程环境 */
export interface AdaptEnv { // @a: anc-hopant-adapt
  tool_servers: ToolServerEntry[];
  providers: { api_key_env?: string }[];
  env_vars: Record<string, string | undefined>;
  path_dirs: string[];
  engine_version: string | null;
}

/** 配置适配报告：四项核验各自的 required/missing + 每个缺口一句怎么补 */
export interface AdaptReport { // @a: anc-hopant-adapt
  ok: boolean;
  /** missing=缺口;standard_unregistered=没注册的标准工具,不算缺口（设计决策 7）*/
  tools: { missing: string[]; standard_unregistered: string[]; errors: string[]; warnings: string[] };
  credentials: { required: string[]; missing: string[] };
  commands: { required: string[]; missing: string[] };
  engine: { required: string | null; current: string | null; ok: boolean };
  hints: string[];
  /** 不影响 ok 的提示 */
  notes: string[];
}

/** 适配戳（inner_store/adapt.yaml）：归属标识 @ 入口 spec 头哈希 + 当时的报告 */
export interface AdaptStamp { // @a: anc-hopant-stamp
  adapted: string;
  owner: string;
  hash: string;
  at: string;
  report: AdaptReport;
}

type HopAntErrorCode = 'HOPANT_BAD_ID' | 'HOPANT_SOURCE_INVALID' | 'HOPANT_SPEC_INVALID' | 'HOPANT_ID_MISMATCH' | 'HOPANT_ID_CONFLICT' | 'HOPANT_NOT_FOUND'
  | 'HOPANT_DOC_MISSING' | 'HOPANT_TARGET_EXISTS' | 'HOPANT_PKG_NAME_REQUIRED' | 'HOPANT_CREDENTIAL_LITERAL' | 'HOPANT_LOCAL_FACE_LEAK';   // 后五个=封装/分享（^anc-hopant-pack / -share）
/** 全部错误码的统一出口（码的全集=设计 ^anc-hopant-errors 表,加码加表一行,这里不写数字）：message 恒以码开头、冒号后是人话说明（设计 ^anc-hopant-errors 表）*/
export function hopantError(code: HopAntErrorCode, detail: string): Error { // @a: anc-hopant-errors
  return new Error(`${code}: ${detail}`);
}

// ---------- HopAntHome ----------

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** 两级 HopAnt 根（设计 hopant 决策 1 / 9,2026-10-10 todo/0155）：项目级 `<项目>/hop_tasks/ants`（这个项目总结出的）、用户级 `<home>/.hopjit/ants`（装进来给自己用的）。查找项目级先于用户级。 */ // @a: anc-hopant-home
export interface AntRoots { project: string; user: string }
/** 哪一级：project | user */ // @a: anc-hopant-home
export type AntScope = 'project' | 'user';

/** 由用户主目录与项目根算出两级 HopAnt 根。 */ // @a: anc-hopant-home
export function antRoots(home: string, projectDir: string): AntRoots {
  return { project: join(projectDir, 'hop_tasks', 'ants'), user: antsRoot(home) };
}

/** `<home>/.hopjit/ants`——用户级根（旧名保留给只认用户级的调用方：演示件安装、备份位上溯）。 */ // @a: anc-hopant-home
export function antsRoot(home: string): string {
  return join(home, '.hopjit', 'ants');
}

/** `<root>/<id>`——root 是任一级 HopAnt 根;id 不合法抛 HOPANT_BAD_ID */ // @a: anc-hopant-home
export function antDir(root: string, id: string): string {
  if (!id || !ID_RE.test(id) || id.includes('..')) {
    throw hopantError('HOPANT_BAD_ID', `HopAnt id '${id}' 不合法——只许小写字母、数字、连字符、下划线、点,不许路径分隔符与 ..`);
  }
  return join(root, id);
}

/** 按 id 两级查找（设计决策 9：项目级先于用户级,同 id 项目级遮住用户级）;"在场"判据与 listAntsIn 同——目录下有 `<id>.md` 入口 spec 才算。两级都没有返回 null。 */ // @a: anc-hopant-home
export function resolveAnt(roots: AntRoots, id: string): { dir: string; scope: AntScope } | null {
  for (const scope of ['project', 'user'] as const) {
    const dir = antDir(roots[scope], id);
    if (isAntDir(dir)) return { dir, scope };
  }
  return null;
}

/** `<root>/index.md`——该级的索引 */ // @a: anc-hopant-index
export function indexPath(root: string): string {
  return join(root, 'index.md');
}

function isAntDir(dir: string): boolean {
  return existsSync(join(dir, `${basename(dir)}.md`));
}

/** 某一级已装 HopAnt 的 id 列表：ants/ 下含 `<目录名>.md` 的子目录,升序;根不存在返回空 */ // @a: anc-hopant-home
export function listAntsIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(n => { const p = join(root, n); return statSync(p).isDirectory() && isAntDir(p); })
    .sort();
}

/** 两级合并：项目级全部在前、用户级在后,各自升序;同 id 两条都在（用户看得见被遮的那个）。 */ // @a: anc-hopant-home
export function listAnts(roots: AntRoots): { id: string; scope: AntScope; dir: string }[] {
  const out: { id: string; scope: AntScope; dir: string }[] = [];
  for (const scope of ['project', 'user'] as const) {
    for (const id of listAntsIn(roots[scope])) out.push({ id, scope, dir: join(roots[scope], id) });
  }
  return out;
}

/** parser 保留 `# Spec: ` 行的 `Spec: ` 前缀在 title 里;索引与 list 呈现的是标题本体 */
export function specTitle(rawTitle: string): string { // @a: anc-hopant-index
  return rawTitle.replace(/^Spec:\s*/i, '').trim();
}

function readHeader(specPath: string): SpecHeader {
  const text = readFileSync(specPath, 'utf-8');
  const { ast, errors } = parseSpec(text);
  if (errors.length) throw hopantError('HOPANT_SPEC_INVALID', `${specPath} 入口 spec 解析失败——第 ${errors[0].line} 行: ${errors[0].message}`);
  return ast.header;
}

/** 重建某一级的 index.md（一行一 ant：`- id — 标题 — Goal 首行`）,返回条目数。该级没有任何 ant 且索引本来不在时不建目录不写文件——项目级根多数项目没有,不无故在项目里长出 hop_tasks/ants/。 */ // @a: anc-hopant-index
export function rebuildIndex(root: string): number {
  const ids = listAntsIn(root);
  if (ids.length === 0 && !existsSync(indexPath(root))) return 0;
  const lines = ['# HopAnt 索引（由 hopjit ant 维护,勿手改）', ''];
  for (const id of ids) {
    try {
      const h = readHeader(join(root, id, `${id}.md`));
      const goal = (h.goal ?? '').split('\n')[0].trim() || '（无 Goal）';
      lines.push(`- ${id} — ${specTitle(h.title)} — ${goal}`);
    } catch {
      lines.push(`- ${id} — （入口 spec 解析失败）`);
    }
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(indexPath(root), lines.join('\n') + '\n', 'utf-8');
  return ids.length;
}

// ---------- AntInstaller ----------

/** 判来源目录形态,返回形态与各 ant 目录 */
export function detectSource(srcDir: string): { kind: SourceKind; antDirs: string[] } { // @a: anc-hopant-install
  const antsSub = join(srcDir, 'ants');
  if (existsSync(antsSub) && statSync(antsSub).isDirectory()) {
    const dirs = readdirSync(antsSub)
      .map(n => join(antsSub, n))
      .filter(p => statSync(p).isDirectory() && isAntDir(p))
      .sort();
    if (dirs.length) return { kind: 'package', antDirs: dirs };
  }
  if (isAntDir(srcDir)) return { kind: 'single', antDirs: [srcDir] };
  return { kind: 'invalid', antDirs: [] };
}

/** 生成安装计划,不写盘;来源无效/入口 spec 解析失败/Id 与文件名不符各抛对应错误码 */
export function planInstall(srcDir: string, root: string): InstallPlan { // @a: anc-hopant-install
  const { kind, antDirs } = detectSource(srcDir);
  if (kind === 'invalid') {
    throw hopantError('HOPANT_SOURCE_INVALID', `${srcDir} 既不是单 HopAnt 目录（含 <目录名>.md 入口 spec）,也不是 HopAnt 包根（含 ants/<id>/<id>.md）`);
  }
  const ants = antDirs.map(src => {
    const id = basename(src);
    const h = readHeader(join(src, `${id}.md`));
    if (h.id && h.id !== id) {
      throw hopantError('HOPANT_ID_MISMATCH', `${src} 入口 spec 的 Id 字段 '${h.id}' 与文件名 '${id}' 不一致——两者必须相同（文件名即 HopAnt id）`);
    }
    const dst = antDir(root, id);   // 撞 id 只在本级判——另一级有同 id 是合法遮蔽（决策 9）
    return { id, src, dst, conflict: existsSync(dst), hasBootstrap: existsSync(join(src, 'bootstrap.js')) };
  });
  return { root, source_kind: kind, ok: ants.every(a => !a.conflict), ants };
}

const LOCAL_DIR = 'inner_store';
const LOCAL_FILE_RE = /\.orig\.md$/;

/** 本机面判法（概念 ^anc-struct-hopant-layout 的唯一落码）：ant 根下顶层 inner_store/ 或任意深度 *.orig.md。
 * applyInstall（装时跳过）与 shareAnts（分享时排除 + 自检）共用——2026-10-09 子卡 E 从 applyInstall 抽出。relPath 用 / 或平台分隔符都认。 */ // @a: anc-hopant-install, anc-hopant-share
export function isLocalFace(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/);
  return parts[0] === LOCAL_DIR || LOCAL_FILE_RE.test(parts[parts.length - 1]);
}

/** 按计划落盘：全或无,跳过来源里的 inner_store/ 与 *.orig.md,建空 inner_store/,重建索引 */
export function applyInstall(plan: InstallPlan): InstallResult { // @a: anc-hopant-install
  if (!plan.ok) {
    const bad = plan.ants.filter(a => a.conflict).map(a => a.id);
    throw hopantError('HOPANT_ID_CONFLICT', `已装有同 id 的 HopAnt: ${bad.join(', ')}——先 hopjit ant remove <id>,或改来源目录里的 id（文件名与 Id 字段一起改）。本次一个都没装`);
  }
  const skipped: string[] = [];
  for (const a of plan.ants) {
    cpSync(a.src, a.dst, {
      recursive: true,
      filter: (src) => {
        const rel = relative(a.src, src);
        if (!rel) return true;
        if (isLocalFace(rel)) { skipped.push(`${a.id}/${rel}`); return false; }   // 本机面判法单点 isLocalFace // @a: anc-hopant-install
        return true;
      },
    });
    mkdirSync(join(a.dst, LOCAL_DIR), { recursive: true });
  }
  rebuildIndex(plan.root);
  return {
    installed: plan.ants.map(a => a.id),
    skipped_local_files: skipped,
    bootstrap_pending: plan.ants.filter(a => a.hasBootstrap).map(a => a.id),
  };
}

/** 卸载;scope 缺省按 resolveAnt 找到的那一级（项目级在就删项目级,决策 9）;keepStore 为真先把 inner_store/ 挪到 `<home>/.hopjit/ants-store-backup/<id>/`（两级共用,home 由 roots.user 上溯）。
 * 返回删了哪一级（'project' | 'user'）;不存在、没删返回 null。 */
export function removeAnt(roots: AntRoots, id: string, keepStore: boolean, scope?: AntScope): AntScope | null { // @a: anc-hopant-install
  const hit = scope ? { dir: antDir(roots[scope], id), scope } : resolveAnt(roots, id);
  if (!hit || !existsSync(hit.dir)) return null;
  const store = join(hit.dir, LOCAL_DIR);
  if (keepStore && existsSync(store)) {
    const backupRoot = join(dirname(dirname(roots.user)), '.hopjit', 'ants-store-backup');   // roots.user = <home>/.hopjit/ants
    const backup = join(backupRoot, id);
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    mkdirSync(backupRoot, { recursive: true });
    renameSync(store, backup);
  }
  rmSync(hit.dir, { recursive: true, force: true });
  rebuildIndex(roots[hit.scope]);
  return hit.scope;
}

// ---------- AntAdapter ----------

/** 归属标识 `<用户>-<主机>`：git 用户名 > 登录名 > 'user';空格与斜杠换连字符 */
export function ownerId(gitUserName: string, loginName: string, hostname: string): string { // @a: anc-hopant-stamp
  const clean = (s: string) => s.trim().replace(/[\s/\\]+/g, '-');
  const user = clean(gitUserName) || clean(loginName) || 'user';
  return `${user}-${clean(hostname) || 'host'}`;
}

const HASHED_KINDS = ['tools', 'approved_commands', 'config'] as const;

/** 入口 spec 头的内容哈希：只覆盖 Tools / 已批准命令 / Config 三段,sha256 前 12 位。
 * 段切分复用 parser 的 sectionSpans——parser 认什么段头（英文/中文 ## 段头、内联标签形）这里就认什么,
 * 不自写段头正则（v0.1.0 自写一套,中文段头与内联形下改了工具哈希不变——review 实跑抓出）。*/
export function headerHash(specText: string): string { // @a: anc-hopant-stamp
  const lines = specText.split('\n');
  const spans = sectionSpans(specText);
  const pieces = HASHED_KINDS.map(kind => {
    const sp = spans.find(s => s.kind === kind);
    return sp ? lines.slice(sp.startLine, sp.endLine).join('\n').trim() : '';
  });
  return createHash('sha256').update(pieces.join('\n---\n')).digest('hex').slice(0, 12);
}

function stampPath(dir: string): string { return join(dir, LOCAL_DIR, 'adapt.yaml'); }

/** 读 inner_store/adapt.yaml;缺失或坏文件返回 null */
export function readStamp(dir: string): AdaptStamp | null { // @a: anc-hopant-stamp
  const p = stampPath(dir);
  if (!existsSync(p)) return null;
  try {
    const v = yamlLoad(readFileSync(p, 'utf-8')) as Partial<AdaptStamp> | null;
    if (!v || typeof v.owner !== 'string' || typeof v.hash !== 'string') return null;
    return v as AdaptStamp;
  } catch { return null; }
}

/** 写 inner_store/adapt.yaml（目录不存在先建）,返回路径 */
export function writeStamp(dir: string, stamp: AdaptStamp): string { // @a: anc-hopant-stamp
  mkdirSync(join(dir, LOCAL_DIR), { recursive: true });
  const p = stampPath(dir);
  writeFileSync(p, yamlDump(stamp, YAML_DUMP_OPTS), 'utf-8');   // @a: anc-config-yaml-dump-opts
  return p;
}

/** 要不要重新适配：无戳 / 分支不同（别的机器拷来）/ 哈希不同（spec 头改过）任一为真 */
export function needsAdapt(stamp: AdaptStamp | null, owner: string, hash: string): boolean { // @a: anc-hopant-stamp
  if (!stamp) return true;
  if (stamp.owner !== owner) return true;
  if (stamp.hash !== hash) return true;
  return false;
}

/** `ant list` 的三态：never=没有戳 / stale=戳在但分支或头哈希不符（含入口 spec 读不出来）/ adapted。CLI 只调不判 */
export function adaptState(dir: string, owner: string): 'never' | 'stale' | 'adapted' { // @a: anc-hopant-stamp
  const stamp = readStamp(dir);
  if (!stamp) return 'never';
  let hash = '';
  try { hash = headerHash(readFileSync(join(dir, `${basename(dir)}.md`), 'utf-8')); } catch { /* 读不出来按不符 */ }
  return needsAdapt(stamp, owner, hash) ? 'stale' : 'adapted';
}

/** 逻辑适配前备份 `<id>.md` → `<id>.orig.md`;已存在不覆盖返回 false */
export function backupOrig(dir: string): boolean { // @a: anc-hopant-adapt
  const id = basename(dir);
  const orig = join(dir, `${id}.orig.md`);
  if (existsSync(orig)) return false;
  cpSync(join(dir, `${id}.md`), orig);
  return true;
}

function semverGte(cur: string, req: string): boolean {
  const p = (v: string) => { const m = v.match(/^(\d+)\.(\d+)\.(\d+)/); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
  const a = p(cur), b = p(req);
  if (!a || !b) return true;   // 非 semver 不拦,与引擎 initExecution 的 fail-open 同律
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return true;
}

function execInPath(cmd: string, pathDirs: string[]): boolean {
  if (cmd.includes('/') || cmd.includes('\\')) {
    try { accessSync(cmd, constants.X_OK); return true; } catch { return false; }
  }
  const names = [cmd, `${cmd}.exe`, `${cmd}.cmd`];
  for (const d of pathDirs) {
    for (const n of names) {
      const p = join(d, n);
      try { if (statSync(p).isFile()) { accessSync(p, constants.X_OK); return true; } } catch { /* 下一个 */ }
    }
  }
  return false;
}

interface ToolSplit { missing: string[]; standard_unregistered: string[]; errors: string[]; warnings: string[] }

/** Tools 段需求按注册面分堆——adapt 与 checkRunDeps 共用的唯一判据 */
function splitToolNeeds(needs: ToolNeed[], toolServers: ToolServerEntry[]): ToolSplit {
  const available = toolServers.flatMap(s => (s.tools ?? []).map(t => ({
    name: t.name, tool_id: t.tool_id, input_schema: t.input_schema, requires_commit: t.requires_commit,
  })));
  // 先按名算没注册的工具,只把在场的交给引擎对账——errors 直取引擎返回,不解析它的错误文案（引擎改措辞这里不受影响）。
  // 没注册的再分两堆：标准工具（STANDARD_TOOL_NAMES,复用模式由 caller 自带能力落实）只记 notes 不算缺口;其余进 missing
  const unregistered = needs.filter(n => !available.some(d => d.name === n.name || d.tool_id === n.name)).map(n => n.name);
  const present = needs.filter(n => !unregistered.includes(n.name));
  const rc = ExecutionEngine.reconcileTools(present, available);
  return {
    missing: unregistered.filter(n => !STANDARD_TOOL_NAMES.has(n)),
    standard_unregistered: unregistered.filter(n => STANDARD_TOOL_NAMES.has(n)),
    errors: rc.errors.map(e => e.message),
    warnings: rc.warnings.map(w => w.message),
  };
}

/** 配置适配四项核：工具（复用引擎 reconcileTools）/ 凭证 / 命令 PATH 实查 / 引擎版本;不写盘 */
export function adapt(dir: string, env: AdaptEnv): AdaptReport { // @a: anc-hopant-adapt
  const id = basename(dir);
  const header = readHeader(join(dir, `${id}.md`));
  const needs = header.tools ?? [];
  const hints: string[] = [];

  // 工具：复用引擎起跑的同一判据（与 checkRunDeps 共用 splitToolNeeds）
  const tools = splitToolNeeds(needs, env.tool_servers);
  const { missing, standard_unregistered: standardUnregistered, errors } = tools;
  const notes = standardUnregistered.map(n => `${n} 是标准工具：复用模式由 caller 自带能力落实,可直接用;独立模式下 anthropic 协议 provider 可能原生可搜、首次请求时探测,不认时才要在 tool_servers 注册 tool_id 为 ${n} 的条目（样例 examples/hoptools-websearch.yaml）`);
  for (const n of missing) hints.push(`工具 '${n}' 未注册：在 ~/.hopjit/config.yaml 的 tool_servers 节注册它,或把本机同能力的工具 tool_id 映射为 '${n}'`);
  for (const e of errors) hints.push(`工具声明问题：${e}`);

  // 凭证：Tools 段工具所属 server 的 auth_env ∪ providers 的 api_key_env
  const credNames = new Set<string>();
  for (const n of needs) {
    const srv = env.tool_servers.find(s => (s.tools ?? []).some(t => t.name === n.name || t.tool_id === n.name));
    const authEnv = srv?.binding?.auth_env;
    if (authEnv) credNames.add(authEnv);
  }
  for (const p of env.providers) if (p.api_key_env) credNames.add(p.api_key_env);
  const credRequired = [...credNames].sort();
  const credMissing = credRequired.filter(n => !(env.env_vars[n] ?? '').trim());
  for (const n of credMissing) hints.push(`凭证环境变量 ${n} 未设置：export ${n}=<值>（只在本机环境里,不写进 spec 或配置文件）`);

  // 命令：已批准命令每条前缀首项在 PATH 实查
  const cmdRequired = [...new Set((header.approved_commands ?? []).map(c => c[0]).filter(Boolean))].sort();
  const cmdMissing = cmdRequired.filter(c => !execInPath(c, env.path_dirs));
  const hasBootstrap = existsSync(join(dir, 'bootstrap.js'));
  for (const c of cmdMissing) {
    hints.push(`命令 '${c}' 在 PATH 里找不到：安装后确认在 PATH${hasBootstrap ? `;该 HopAnt 带 bootstrap.js,先 hopjit ant bootstrap ${id} --dry-run 看它的安装计划` : ''}`);
  }

  // 引擎版本
  const required = typeof header.config?.['engine_min_version'] === 'string' ? String(header.config['engine_min_version']) : null;
  const engineOk = !required || !env.engine_version || semverGte(env.engine_version, required);
  if (!engineOk) hints.push(`引擎版本 ${env.engine_version} 低于 spec 要求 ${required}：npm i -g @hoplogic/hopjit@latest`);

  const ok = missing.length === 0 && errors.length === 0 && credMissing.length === 0 && cmdMissing.length === 0 && engineOk;
  return {
    ok, tools,
    credentials: { required: credRequired, missing: credMissing },
    commands: { required: cmdRequired, missing: cmdMissing },
    engine: { required, current: env.engine_version, ok: engineOk },
    hints, notes,
  };
}

// ===== 编排：call 寻址与起跑依赖核 =====

/** call 目标寻址：同目录 `<id>.md` → `<HopAnt 根>/<id>/<id>.md`;找不到或 id 像路径返回 null */
export function resolveCalleeSpecPath(callerDir: string, roots: AntRoots | null, calleeId: string): string | null { // @a: anc-hopant-callee-resolve
  if (!calleeId || calleeId.includes('/') || calleeId.includes('\\') || calleeId.includes('..')) return null;
  const p1 = join(callerDir, `${calleeId}.md`);
  if (existsSync(p1)) return p1;
  if (roots !== null) {
    for (const root of [roots.project, roots.user]) {   // 项目级先于用户级（决策 9）
      const p = join(root, calleeId, `${calleeId}.md`);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** commit 批准账位置：spec 在 `<HopAnt 根>/<id>/` 下 → `<id>/inner_store/commit_approvals.json`,其余 → `<runRootParent>/commit_approvals.json`。
 * cli 与 mcp-server 两个组合根注册给引擎的闭包都调它（[[exec-engine#^anc-exec-commit-approval]]）。 */
export function commitApprovalStorePath(roots: AntRoots, specPath: string, runRootParent: string): string { // @a: anc-hopant-commit-store
  // specPath 由引擎按 canonicalSpecPath 传入（已解析软链）,两级 HopAnt 根按同一口径解析后再比前缀——HOME 经软链时两边不一致会让账错落 run 根上一级
  for (const rawRoot of [roots.project, roots.user]) {   // 项目级先于用户级（决策 9）
    let root = rawRoot;
    try { root = realpathSync(rawRoot); } catch { /* 目录不存在:用原值 */ }
    const rel = relative(root, specPath);
    const parts = rel.split(sep);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel) && parts.length >= 2) {
      return join(root, parts[0], 'inner_store', 'commit_approvals.json');
    }
  }
  return join(runRootParent, 'commit_approvals.json');
}

/** dirs 批准账位置：与 commitApprovalStorePath 同一位置规则,只换文件名——两类批准粒度不同（commit 按步骤+body,
 * dirs 按整份清单）,分文件零歧义。引擎只注册一个解析位（给 commit 账路径）,dirs 账由引擎在同目录换名——
 * 本函数是那条规则的具名真身,供测试与审计对照。见 [[hopant#^anc-hopant-commit-store]] / [[exec-engine#^anc-exec-dirs-grant]] */ // @a: anc-hopant-commit-store, anc-exec-dirs-grant
export function dirsApprovalStorePath(roots: AntRoots, specPath: string, runRootParent: string): string {
  return join(dirname(commitApprovalStorePath(roots, specPath, runRootParent)), 'dirs_approvals.json');
}

// 起跑依赖核的环境输入：roots 定位已装 HopAnt 目录（两级）,tool_servers 是两级合并后的工具注册表。
export interface RunDepsEnv { // @a: anc-hopant-run-deps
  roots: AntRoots;
  tool_servers: ToolServerEntry[];
}

// 起跑依赖核的结果：ok 为 false 时 tools.missing / calls 列出缺口,hints 是给用户的修法。
export interface RunDepsReport { // @a: anc-hopant-run-deps
  ok: boolean;
  tools: ToolSplit;
  calls: { missing: string[]; unreadable: string[] };
  hints: string[];
}

function collectCalls(steps: StepNode[], out: { step_id: string; id: string }[]): void {
  for (const st of steps) {
    if (st.step_type === 'call' && st.callee_spec_id) out.push({ step_id: st.step_id, id: st.callee_spec_id });
    collectCalls(getChildren(st), out);
  }
}

/** 复用模式起跑依赖核：Tools 段工具 + 静态 call 目标,沿 call 树递归;不写盘不起子进程 */
export function checkRunDeps(specText: string, specPath: string, env: RunDepsEnv): RunDepsReport { // @a: anc-hopant-run-deps
  const tools: ToolSplit = { missing: [], standard_unregistered: [], errors: [], warnings: [] };
  const calls = { missing: [] as string[], unreadable: [] as string[] };
  const registered = new Set(env.tool_servers.flatMap(s => (s.tools ?? []).flatMap(t => [t.name, t.tool_id])));
  const missingToolNames = new Set<string>();
  const missingCallIds = new Set<string>();
  const queue: { text: string; path: string }[] = [{ text: specText, path: specPath }];
  const visited = new Set<string>([specPath]);
  while (queue.length) {
    const { text, path } = queue.shift()!;
    const name = basename(path, '.md');
    const { ast, errors } = parseSpec(text);
    if (errors.length) {
      // 入口那份的解析错误归引擎 init 报,这里不抢;callee 那份记不可读
      if (path !== specPath) calls.unreadable.push(`${name}: 第 ${errors[0].line} 行 ${errors[0].message}`);
      continue;
    }
    const split = splitToolNeeds(ast.header.tools ?? [], env.tool_servers);
    for (const t of split.missing) { tools.missing.push(`${name}: ${t}`); missingToolNames.add(t); }
    for (const t of split.standard_unregistered) tools.standard_unregistered.push(`${name}: ${t}`);
    for (const e of split.errors) tools.errors.push(`${name}: ${e}`);
    for (const w of split.warnings) tools.warnings.push(`${name}: ${w}`);
    const found: { step_id: string; id: string }[] = [];
    collectCalls(ast.steps ?? [], found);
    for (const c of found) {
      const p = resolveCalleeSpecPath(dirname(path), env.roots, c.id);
      if (p === null) {
        // call 也可以调工具:已注册的工具名或标准工具都算找得到
        if (registered.has(c.id) || STANDARD_TOOL_NAMES.has(c.id)) continue;
        calls.missing.push(`${name} 步骤 ${c.step_id}: ${c.id}`);
        missingCallIds.add(c.id);
        continue;
      }
      if (visited.has(p)) continue;
      visited.add(p);
      let calleeText: string;
      try { calleeText = readFileSync(p, 'utf-8'); } catch (e) { calls.unreadable.push(`${basename(p, '.md')}: ${(e as Error).message}`); continue; }
      queue.push({ text: calleeText, path: p });
    }
  }
  const hints: string[] = [];
  for (const t of missingToolNames) hints.push(`工具 ${t} 没有注册:在 ~/.hopjit/config.yaml 或项目 hopjit.yaml 的 tool_servers 里注册它（宿主自己挂的 MCP 也要在这里注册一遍）,或改用 HopAnt 实现这一步`);
  for (const id of missingCallIds) hints.push(`call 目标 ${id} 找不到:不是同目录的 spec,不是本项目或本机已装的 HopAnt,也不是已注册的工具——HopAnt 先装（/hop 安装 <目录>）,拼错了改 spec`);
  for (const e of tools.errors) hints.push(`工具声明问题:${e}`);
  for (const u of calls.unreadable) hints.push(`call 目标读不了:${u}`);
  const ok = tools.missing.length === 0 && tools.errors.length === 0 && calls.missing.length === 0 && calls.unreadable.length === 0;
  return { ok, tools, calls, hints };
}


// ---------- AntPacker：封装与分享（概念 ^anc-struct-hopant-lifecycle ⑤⑥,设计 ^anc-hopant-pack / ^anc-hopant-share） ----------


/** 标准工具的标准签名（Tools 段一行,不含前导 `- `）——补入标准工具时直接写它,不写占位（作者 2026-10-09 OK）。键须 ∈ STANDARD_TOOL_NAMES。 */ // @a: anc-hopant-pack
const STANDARD_TOOL_SIGNATURES: Readonly<Record<string, string>> = {
  web_search: 'web_search(query) -> result % yaml  # 封装对账补入（标准工具,签名由 hop 定）\n  - query % text  # 查询词',
};

/** 头对账的增删明细（设计 HopSchema ReconcileReport） */
export interface ReconcileReport { // @a: anc-hopant-pack
  tools_added: string[];
  tools_removed: string[];
  commands_added: string[];
  commands_removed: string[];
  commands_undetermined: string[];
}

/** packAnt 的返回（设计 HopSchema PackAntResult） */
export interface PackAntResult { // @a: anc-hopant-pack
  id: string;
  dir: string;
  reconciled: ReconcileReport;
  docs_copied: string[];
  assets_copied: string[];
  index_rebuilt: string | null;   // 封装直落某级 HopAnt 根时重建了该根的 index.md（根路径）;封到别处为 null（^anc-hopant-index 第三个改动入口）
}

/** body 使用面（collectBodyUsage 的返回）：工具名 / subprocess.run 首项 / 静态判不出的调用 */
export interface BodyUsage { // @a: anc-hopant-pack
  tools: string[];
  commands: string[];
  undetermined: string[];
}

/** 内建名单（设计 collectBodyUsage 2.2）：引擎恒注册零声明的名字,不是注册面工具,头对账时从使用面剔除。
 * 事实源 = validator 的 B2 两名单（文件工具十一件 + 树编辑 special + run_script;通知件 dingtalk_notify / notify）∪ act 内建函数 ∪ 原生优先族——
 * 不在 hopant 里另抄名单（review 2026-10-09：此前自抄十一件是库内第三份,且漏了通知件）。 */ // @a: anc-hopant-pack
function isBuiltinCallee(name: string): boolean {
  return ACT_BUILTIN_NAMES.has(name) || B2_BUILTIN_FILE_TOOLS.has(name) || B2_BUILTIN_NOTIFY_TOOLS.has(name)
    || NATIVE_FIRST_BUILTIN_SPECIAL_TOOL_NAMES.has(name);
}

/** 递归收一个表达式里的全部 CallExpr（实参里嵌套的也收——`my_tool(a: other_tool())` 两个都算）。 */
function walkExprCalls(e: ActExpr | undefined, out: CallExpr[]): void {
  if (!e || typeof e !== 'object') return;
  const any = e as unknown as Record<string, unknown>;
  if (any['type'] === 'call') {
    out.push(e as CallExpr);
    for (const a of (e as CallExpr).args ?? []) walkExprCalls(a.value as ActExpr, out);
    return;
  }
  for (const v of Object.values(any)) {
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') walkExprCalls(x as ActExpr, out); }
    else if (v && typeof v === 'object') walkExprCalls(v as ActExpr, out);
  }
}

function walkStmtCalls(stmts: ActStatement[] | undefined, out: CallExpr[]): void {
  for (const st of stmts ?? []) {
    if (st.type === 'assign') walkExprCalls(st.value, out);
    else if (st.type === 'call') walkExprCalls(st.call, out);
    else if (st.type === 'if') { walkExprCalls(st.condition, out); walkStmtCalls(st.then_body, out); walkStmtCalls(st.else_body, out); }
  }
}

/** 从 steps 的 body 与 tool_grants 收使用面（设计 collectBodyUsage 三步）。使用面两种来源：带 body 的步骤里的调用;任何步骤
 * `- 工具:` 授权行里的名字（经内建名单过滤,`*` 全量授权不是工具名）。act free / reason 步没有 body,它们的工具面只由授权行表达。 */ // @a: anc-hopant-pack
export function collectBodyUsage(steps: StepNode[]): BodyUsage {
  const tools: string[] = []; const commands: string[] = []; const undetermined: string[] = [];
  const addU = (arr: string[], v: string) => { if (!arr.includes(v)) arr.push(v); };
  const visit = (nodes: StepNode[]) => {
    for (const st of nodes) {
      const grants = (st as { tool_grants?: { name: string }[] }).tool_grants;
      for (const g of grants ?? []) if (g.name !== '*' && !isBuiltinCallee(g.name)) addU(tools, g.name);   // 不过滤会把 `- 工具: read` 补进 Tools 段,产物装机 adapt 红（review H-1）
      const body = (st as { body?: { statements?: ActStatement[] } }).body;
      if (body) {
        const calls: CallExpr[] = [];
        walkStmtCalls(body.statements, calls);
        for (const c of calls) {
          if (c.callee === 'subprocess.run') {
            const a0 = c.args?.[0]?.value as unknown as { type?: string; elements?: { type?: string; value?: unknown }[] } | undefined;
            const first = a0?.type === 'list_literal' ? a0.elements?.[0] : undefined;
            if (first && first.type === 'literal' && typeof first.value === 'string') addU(commands, first.value);
            else addU(undetermined, `${st.step_id}: subprocess.run 第一参不是列表字面量,静态判不出命令名`);
          } else if (!isBuiltinCallee(c.callee)) {
            addU(tools, c.callee);
          }
        }
      }
      visit(getChildren(st));
    }
  };
  visit(steps);
  return { tools, commands, undetermined };
}

/** 头对账：声明面（Tools 段 / 已批准命令段）与使用面比对,少补多删,只重写这两段（设计 reconcileHeader 六步）。 */ // @a: anc-hopant-pack
export function reconcileHeader(specText: string): { report: ReconcileReport; newText: string } {
  const { ast, errors } = parseSpec(specText);
  if (errors.length) throw hopantError('HOPANT_SPEC_INVALID', `第 ${errors[0].line} 行 ${errors[0].message}`);
  const usage = collectBodyUsage(ast.steps ?? []);
  const declaredTools = (ast.header.tools ?? []).map(t => t.name);
  const usedTools = new Set(usage.tools);
  const tools_added = usage.tools.filter(t => !declaredTools.includes(t));
  const tools_removed = declaredTools.filter(t => !usedTools.has(t) && !STANDARD_TOOL_NAMES.has(t));
  const declaredCmds = (ast.header.approved_commands ?? []).map(c => c[0]);
  const usedCmds = new Set(usage.commands);
  const commands_added = usage.commands.filter(c => !declaredCmds.includes(c));
  const commands_removed = usage.undetermined.length ? [] : declaredCmds.filter(c => !usedCmds.has(c));
  const report: ReconcileReport = { tools_added, tools_removed, commands_added, commands_removed, commands_undetermined: usage.undetermined };
  if (!tools_added.length && !tools_removed.length && !commands_added.length && !commands_removed.length) return { report, newText: specText };

  // 两段各自重写——每次基于最新文本重算 sectionSpans,避免第一段改动后行号漂移
  const rewriteSection = (text: string, kind: string, keepPred: (line: string) => boolean, additions: string[], insertBefore: string[], header: string, fmt: (x: string) => string): string => {
    const lines = text.split('\n');
    const spans = sectionSpans(text);
    const sp = spans.find(x => x.kind === kind);
    if (sp) {
      const body = lines.slice(sp.startLine + 1, sp.endLine);
      // 顶层条目（`- ` 零缩进）被删时,它下面缩进的子条目（参数行 / `>` 扩展行）一起删——Tools 段的声明是多行形态
      const kept: string[] = []; let dropping = false;
      for (const l of body) {
        const top = /^-\s/.test(l);
        if (top) { dropping = !keepPred(l); if (!dropping) kept.push(l); continue; }
        if (dropping && /^\s+\S/.test(l)) continue;
        if (dropping && !l.trim()) { dropping = false; }
        kept.push(l);
      }
      while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
      lines.splice(sp.startLine + 1, sp.endLine - sp.startLine - 1, ...kept, ...additions.map(fmt), '');
    } else if (additions.length) {
      let at = lines.length;
      for (const k of insertBefore) { const t = spans.find(x => x.kind === k); if (t) { at = t.startLine; break; } }
      lines.splice(at, 0, header, ...additions.map(fmt), '');
    }
    return lines.join('\n');
  };
  // 条目识别复用 parser 文法（toolSigName / splitArgvPrefix）,不自写正则——自写的漏中文工具名与带引号命令,报告说删了正文没删（review M-2）
  const removedToolSet = new Set(tools_removed);
  let text = specText;
  text = rewriteSection(text, 'tools',
    (l) => { const n = toolSigName(l); return !n || !removedToolSet.has(n); },
    tools_added, ['config', 'approved_commands', 'steps'], '## Tools',
    (t) => STANDARD_TOOL_NAMES.has(t)
      ? `- ${STANDARD_TOOL_SIGNATURES[t] ?? `${t}(input) -> result % yaml  # 封装对账补入（标准工具,签名由 hop 定）\n  - input % text  # 待补`}`
      : `- ${t}(input) -> result % yaml  # 封装对账补入——正文调用了但 Tools 段未声明,请补参数签名\n  - input % text  # 待补`);
  text = rewriteSection(text, 'approved_commands',
    (l) => { const first = splitArgvPrefix(l.replace(/^\s*-\s*/, '')).tokens[0]; return !first || !commands_removed.includes(first); },
    commands_added, ['steps'], '## 已批准命令', (c) => `- ${c}`);
  return { report, newText: text };
}

/** 封装：spec → `<outDir>/<id>/` 可装目录（设计 packAnt 七步）。不覆盖已有目标,doc 缺即拒,不建 inner_store/。 */ // @a: anc-hopant-pack
export function packAnt(specPath: string, outDir: string, opts: { id?: string; assets?: string[]; indexRoot?: string; rewriteId?: (raw: string, id: string) => string } = {}): PackAntResult {
  const specAbs = resolve(specPath);
  const raw = readFileSync(specAbs, 'utf-8');
  const { ast, errors } = parseSpec(raw);
  if (errors.length) throw hopantError('HOPANT_SPEC_INVALID', `${specAbs} 第 ${errors[0].line} 行 ${errors[0].message}`);
  const id = opts.id ?? ast.header.id;
  if (!id || !ID_RE.test(id) || id.includes('..') || /[A-Z]/.test(id)) throw hopantError('HOPANT_BAD_ID', `${id ?? '(空)'}——HopAnt id 须小写字母/数字开头,只含小写字母、数字、. _ -`);
  const { report, newText } = reconcileHeader(raw);
  const srcDir = dirname(specAbs);
  const docNames = new Set<string>();
  for (const d of ast.header.doc_refs ?? []) docNames.add(d.doc);
  const visitDocs = (nodes: StepNode[]) => { for (const st of nodes) { for (const d of (st as { doc_refs?: { doc: string }[] }).doc_refs ?? []) docNames.add(d.doc); visitDocs(getChildren(st)); } };
  visitDocs(ast.steps ?? []);
  const docFiles: { name: string; src: string }[] = []; const missing: string[] = []; const escaping: string[] = [];
  for (const d of docNames) {
    const base = d.endsWith('.md') ? d : `${d}.md`;
    // 越界引用（../ 或绝对路径）拷不进 ant 根,封装假绿产物装上后 share 必红——拒（设计第 4 步）
    if (isAbsolute(base) || normalize(base).split(/[\\/]/)[0] === '..') { escaping.push(d); continue; }
    const cand = join(srcDir, base);
    if (existsSync(cand)) docFiles.push({ name: base, src: cand }); else missing.push(d);
  }
  if (escaping.length) throw hopantError('HOPANT_DOC_MISSING', `doc-ref 引用越出 spec 所在目录: ${escaping.join(', ')}——知识文件须在 ${srcDir} 或其子目录,先放进来再封装`);
  if (missing.length) throw hopantError('HOPANT_DOC_MISSING', `doc-ref 指向的文件不在 spec 同目录: ${missing.join(', ')}——先把知识文件放到 ${srcDir} 再封装`);
  // assets 存在性与 docs 一起前置核——全部拒绝路径都在写盘之前,不留半成品目录（review M-4）
  const assetFiles: string[] = [];
  for (const a of opts.assets ?? []) {
    const src = isAbsolute(a) ? a : resolve(srcDir, a);
    if (!existsSync(src)) throw hopantError('HOPANT_DOC_MISSING', `--assets 指向的文件不存在: ${src}`);
    assetFiles.push(src);
  }
  // 存在之外再核可读（todo/0159）：文件在但读不出（权限 / 坏符号链接）等同拿不到材料,同报 HOPANT_DOC_MISSING;
  // 收齐一次性抛,且必须在 mkdirSync(dst) 之前——留到 cpSync 才撞就是半成品目录 + 裸系统错 // @a: anc-hopant-pack
  const unreadable: string[] = [];
  for (const src of [...docFiles.map(d => d.src), ...assetFiles]) {
    try { accessSync(src, constants.R_OK); } catch (e) { unreadable.push(`${src}（${(e as Error).message}）`); }
  }
  if (unreadable.length) throw hopantError('HOPANT_DOC_MISSING', `随包文件存在但读不出: ${unreadable.join(', ')}——先修权限或换成可读的副本再封装`);
  const dst = join(resolve(outDir), id);
  if (existsSync(dst) && readdirSync(dst).length) throw hopantError('HOPANT_TARGET_EXISTS', `${dst} 已存在且非空——封装不覆盖,先删或换 --out`);
  mkdirSync(dst, { recursive: true });
  // Id 行改写：组合根注入 cli 的 rewriteSpecId;缺省回退是同一正则的本地副本（hopant 不能反向 import cli,层规造成的必要重复）。
  // 原文没有 Id 行时在 `# Spec:` 标题后插入——产物恒有 Id 行,share 核一才能严格比对（review M-7）
  const rewrite = opts.rewriteId ?? ((t: string, i: string) => t.replace(/^(Id|标识)(\s*:\s*)\S+.*$/m, (_m, kw: string) => `${kw}: ${i}`));
  let finalText = rewrite(newText, id);
  if (!/^(Id|标识)\s*:/m.test(finalText)) finalText = finalText.replace(/^(#\s*(?:Spec|规约)\s*:[^\n]*\n)/m, `$1Id: ${id}\n`);
  writeFileSync(join(dst, `${id}.md`), finalText, 'utf-8');
  const docs_copied: string[] = [];
  for (const d of docFiles) { mkdirSync(dirname(join(dst, d.name)), { recursive: true }); cpSync(d.src, join(dst, d.name)); docs_copied.push(d.name); }
  const assets_copied: string[] = [];
  for (const src of assetFiles) { cpSync(src, join(dst, basename(src)), { recursive: true }); assets_copied.push(basename(src)); }
  // 直落 HopAnt 根（组合根判 outDir 等于 roots.project / roots.user 时传 indexRoot）→ 重建该根 index.md,与 install / remove 同律：
  // /hop 分派只读索引,不重建则"就地成为活的项目级 HopAnt"落空（2026-10-11 天气总结实撞）。// @a: anc-hopant-index, anc-hopant-pack
  if (opts.indexRoot) rebuildIndex(opts.indexRoot);
  return { id, dir: dst, reconciled: report, docs_copied, assets_copied, index_rebuilt: opts.indexRoot ?? null };
}

// ---- 分享 ----

/** 凭证扫描命中项（设计 HopSchema CredentialHit） */
export interface CredentialHit { file: string; line: number; layers: number[]; reason: string; } // @a: anc-hopant-share

/** 核二回执（设计 HopSchema CredentialScan）——不是"没有凭证"的保证,是"扫了什么、按什么判、判出什么" */
export interface CredentialScan { // @a: anc-hopant-share
  files_scanned: number;
  rejected: CredentialHit[];
  warnings: CredentialHit[];
  method: 'heuristic';
  disclaimer: string;
}

/** 免责文案（作者 2026-10-09 定"要强调免责"）——响应字段、driver 念给用户、错误说明三处同一句。 */ // @a: anc-hopant-share
export const CREDENTIAL_SCAN_DISCLAIMER = '凭证扫描是启发式的尽力防线,不保证无漏;不把密钥写进 hop 文档和代码是用户自己的责任——请经环境变量（spec 里 *_env: 键写变量名）或密钥管理服务取用。';

/** 第 1 层：已知厂商凭证形态表——与键名无关,命中即拒且不降档。加一项加一行。 */ // @a: anc-hopant-share
const KNOWN_SECRET_SHAPES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'OpenAI/Anthropic sk-', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/ },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{16,}/ },
  { name: 'Slack token', re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Google OAuth', re: /\bya29\.[0-9A-Za-z_-]{20,}/ },
  { name: 'Stripe key', re: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}/ },
  { name: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'PEM private key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'URL 带账号密码', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i },
];
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const PLACEHOLDER_RE = /^(?:<[^>]*>|\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|\{\{[^}]*\}\}|\*{3,}|x{6,}|["']{2}|null|none|~|\.{3})$/i;
const ENV_LOOKUP_RE = /^(?:os\.environ(?:\.get)?\s*[\[(]|os\.getenv\s*\(|process\.env\.|\$\{?[A-Z_][A-Z0-9_]*\}?$|\$\(|getenv\()/;
const CRED_KEY_HINT_RE = /(?:api[_-]?key|apikey|token|secret|password|passwd|credential|auth)/i;
const KEY_VALUE_LINE_RE = /^\s*(?:-\s*)?["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*(.+?)\s*,?\s*$/;
const STRING_LITERAL_RE = /(["'`])((?:\\.|(?!\1).){8,}?)\1/g;
const EXAMPLE_FILE_RE = /(?:^|[\/_.-])(?:example|sample|test|fixture|demo)s?(?:[\/_.-]|$)/i;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}
/** 第 2 层：高熵随机串——长度 ≥ 24、字符集 ∈ {base64, hex, urlsafe}、香农熵分两档：base64/urlsafe ≥ 4.0;纯 hex ≥ 3.0 且长度 ≥ 32（hex 只有 16 种字符,熵上限 4.0,拿 4.0 当门槛永不命中） */
function looksHighEntropy(v: string): boolean {
  if (v.length < 24) return false;
  if (ENV_NAME_RE.test(v) || PLACEHOLDER_RE.test(v)) return false;   // UUID 不单列：带连字符的 UUID 熵约 3.7,过不了 4.0 门槛,本就放行
  if (/[\\/]/.test(v) && /\.[a-z0-9]{1,5}(?:$|[?#])/i.test(v)) return false;           // 文件路径
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false;                                   // 不带账号段的 URL（带的归第 1 层）
  if (new Set(v).size <= 3) return false;                                                 // 重复字符串
  const isHex = /^[0-9a-f]+$/i.test(v);
  if (isHex && v.length < 32) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(v)) return false;
  return shannonEntropy(v) >= (isHex ? 3.0 : 4.0);
}
/** 第 3 层的值形态半边：像密钥的值——≥ 8 字符、含数字或大小写混合,不是环境变量名 / 占位 / 纯数字 / 取环境变量的表达式 */
function looksLikeSecretValue(v: string): boolean {
  if (v.length < 8) return false;
  if (ENV_NAME_RE.test(v) || PLACEHOLDER_RE.test(v) || ENV_LOOKUP_RE.test(v)) return false;
  if (/^\d+(?:\.\d+)?$/.test(v)) return false;
  if (/^(?:true|false|yes|no|on|off)$/i.test(v)) return false;
  return /\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v));
}
function unquote(v: string): string { return v.trim().replace(/^["'`]|["'`]$/g, ''); }

/** 核二：三层证据综合研判（设计 scanCredentials 四步,作者 2026-10-09 定"不能只靠关键词匹配""三层综合研判"）。
 * 每个候选串：L1 已知厂商形态单独即拒（不降档）;L2 高熵与 L3 键名提示+值形态单独只警告、同值叠加即拒;
 * 代码围栏 / 注释行 / 示例文件内的 L2+L3 降为警告。返回 {rejected, warnings},处置归调用方。 */ // @a: anc-hopant-share
export function scanCredentials(text: string, ctx: { file: string; kind?: 'doc' | 'data' | 'code' | 'text' }): { rejected: CredentialHit[]; warnings: CredentialHit[] } {
  const rejected: CredentialHit[] = []; const warnings: CredentialHit[] = [];
  const kind = ctx.kind ?? kindOf(ctx.file);
  const exampleFile = EXAMPLE_FILE_RE.test(ctx.file);
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    const ln = i + 1;
    if (kind === 'doc' && /^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    const isComment = /^\s*(?:#|\/\/|\/\*|\*|<!--)/.test(line) && kind !== 'doc';
    const demoted = inFence || isComment || exampleFile;
    // L1：整行查厂商形态,与键名无关
    for (const shape of KNOWN_SECRET_SHAPES) {
      if (shape.re.test(line)) { rejected.push({ file: ctx.file, line: ln, layers: [1], reason: `疑似 ${shape.name} 形态的凭证——真钥匙不该出现在分发件里（示例文件也不行）` }); return; }
    }
    // 候选串：键值行取键与值;代码行另取字符串字面量
    const candidates: { key?: string; value: string }[] = [];
    const kv = KEY_VALUE_LINE_RE.exec(line.replace(/\s+#(?![^"']*["']).*$/, ''));
    if (kv) candidates.push({ key: kv[1], value: unquote(kv[2]) });
    if (kind === 'code') for (const m of line.matchAll(STRING_LITERAL_RE)) if (!candidates.some(c => c.value === m[2])) candidates.push({ key: kv?.[1], value: m[2] });
    for (const c of candidates) {
      if (c.key && /_env$/i.test(c.key)) continue;                     // *_env 键就是环境变量名的家
      const l2 = looksHighEntropy(c.value);
      const keyHint = !!c.key && CRED_KEY_HINT_RE.test(c.key);
      const l3 = keyHint && looksLikeSecretValue(c.value);
      if (!l2 && !l3) continue;
      const layers = [...(l2 ? [2] : []), ...(l3 ? [3] : [])];
      const strong = l2 && l3;
      const reason = strong
        ? `键 ${c.key} 后跟了高熵随机串,两层证据叠加——应写环境变量名,不写值`
        : l2 ? `高熵随机串（长度 ${c.value.length}）,像生成的密钥——请确认不是凭证`
        : `键 ${c.key} 后跟了像密钥的值——应写环境变量名（大写字母数字下划线）,不写值`;
      if (strong && !demoted) rejected.push({ file: ctx.file, line: ln, layers, reason });
      else warnings.push({ file: ctx.file, line: ln, layers, reason: demoted && strong ? `${reason}（在${inFence ? '代码围栏' : isComment ? '注释' : '示例文件'}内,降为警告）` : reason });
    }
  });
  return { rejected, warnings };
}
function kindOf(file: string): 'doc' | 'data' | 'code' | 'text' {
  if (/\.(md|markdown)$/i.test(file)) return 'doc';
  if (/\.(ya?ml|json|toml|ini|env|cfg|conf)$/i.test(file)) return 'data';
  if (/\.(py|js|mjs|cjs|ts|sh|bash|zsh|rb|go|rs|java)$/i.test(file)) return 'code';
  return 'text';
}
/** 核二扫描面：可分发面全部文本文件（作者 2026-10-09 定"要扩"）——按扩展名判文本,无后缀时试 UTF-8 解码 */
const TEXT_EXT_RE = /\.(md|markdown|ya?ml|json|toml|ini|env|cfg|conf|txt|csv|py|js|mjs|cjs|ts|sh|bash|zsh|rb|go|rs|java|xml|html?)$/i;
function isTextFile(abs: string, rel: string): boolean {
  if (TEXT_EXT_RE.test(rel)) return true;
  if (/\.[A-Za-z0-9]{1,6}$/.test(rel)) return false;
  try { const buf = readFileSync(abs); if (buf.includes(0)) return false; new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

/** shareAnts 的返回（设计 HopSchema ShareAntsResult） */
export interface ShareAntsResult { // @a: anc-hopant-share
  name: string;
  version: string;
  dir: string;
  ants: string[];
  checks: { header_dir_consistent: boolean; no_local_face: boolean; lineage_written: string[] };
  credential_scan: CredentialScan;
  owner: string;
}

const PKG_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function listFilesRec(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFilesRec(root, r)); else out.push(r);
  }
  return out;
}

/** 分享：若干已装 HopAnt 的可分发面 → `<outDir>/<name>/{package.json, ants/<id>/…}`（设计 shareAnts 八步,四核任一不过即抛不写）。 */ // @a: anc-hopant-share
export function shareAnts(roots: AntRoots, ids: string[], outDir: string, opts: { name?: string; version?: string; owner: string }): ShareAntsResult {
  if (!ids.length) throw hopantError('HOPANT_BAD_ID', '至少给一个 HopAnt id');
  if (!opts.owner || !opts.owner.trim()) throw hopantError('HOPANT_BAD_ID', '归属标识 owner 不能为空——CLI 四态取值后到这里恒有值');
  if (ids.length > 1 && !opts.name) throw hopantError('HOPANT_PKG_NAME_REQUIRED', `多个 HopAnt（${ids.join(', ')}）装一个包须给 --name <包名>`);
  const name = opts.name ?? ids[0];
  if (!PKG_NAME_RE.test(name)) throw hopantError('HOPANT_BAD_ID', `包名 ${name} 不合 npm 包名规则（小写字母数字 - . _,可带 @scope/）`);
  const version = opts.version ?? '0.1.0';
  // 核一：入口 spec 头与目录一致
  const dirOf = new Map<string, string>();   // 每个 id 两级查找一次,项目级先（决策 9）——这个项目总结的 HopAnt 不须先装用户级就能分享
  for (const id of ids) {
    const hit = resolveAnt(roots, id);
    if (!hit) throw hopantError('HOPANT_NOT_FOUND', `${id} 没装（本项目 hop_tasks/ants/ 与 ~/.hopjit/ants/ 都没有）——hopjit ant list 看已装清单`);
    dirOf.set(id, hit.dir);
    const dir = hit.dir;
    const entry = join(dir, `${id}.md`);
    const text = readFileSync(entry, 'utf-8');
    const { ast, errors } = parseSpec(text);
    if (errors.length) throw hopantError('HOPANT_SPEC_INVALID', `${entry} 第 ${errors[0].line} 行 ${errors[0].message}`);
    if (ast.header.id !== id) throw hopantError('HOPANT_ID_MISMATCH', `${entry} 的 Id 是 ${ast.header.id},目录名是 ${id}`);
    const docNames = new Set<string>((ast.header.doc_refs ?? []).map(d => d.doc));
    const visitDocs = (nodes: StepNode[]) => { for (const st of nodes) { for (const d of (st as { doc_refs?: { doc: string }[] }).doc_refs ?? []) docNames.add(d.doc); visitDocs(getChildren(st)); } };
    visitDocs(ast.steps ?? []);
    const missing = [...docNames].filter(d => !existsSync(join(dir, d.endsWith('.md') ? d : `${d}.md`)));
    if (missing.length) throw hopantError('HOPANT_DOC_MISSING', `${id} 的 doc-ref 文件不在目录内: ${missing.join(', ')}`);
  }
  // 核二：凭证扫描——可分发面全部文本文件（本机面不扫,它不进包）,三层综合研判;rejected 抛不写,warnings 进回执
  const scan: CredentialScan = { files_scanned: 0, rejected: [], warnings: [], method: 'heuristic', disclaimer: CREDENTIAL_SCAN_DISCLAIMER };
  for (const id of ids) {
    const dir = dirOf.get(id)!;
    for (const rel of listFilesRec(dir)) {
      if (isLocalFace(rel)) continue;
      const abs = join(dir, rel);
      if (!isTextFile(abs, rel)) continue;
      scan.files_scanned++;
      const r = scanCredentials(readFileSync(abs, 'utf-8'), { file: `${id}/${rel}` });
      scan.rejected.push(...r.rejected); scan.warnings.push(...r.warnings);
    }
  }
  if (scan.rejected.length) throw hopantError('HOPANT_CREDENTIAL_LITERAL', scan.rejected.map(h => `${h.file}:${h.line}（第 ${h.layers.join('+')} 层）——${h.reason}`).join('; ') + `。${CREDENTIAL_SCAN_DISCLAIMER}`);
  // 核四前置：谱系（D 演化未落地,inner_store/ 下无谱系文件 → 不写字段）
  const lineage: Record<string, unknown> = {};
  for (const id of ids) {
    const lp = join(dirOf.get(id)!, LOCAL_DIR, 'lineage.yaml');
    if (existsSync(lp)) { try { lineage[id] = yamlLoad(readFileSync(lp, 'utf-8')); } catch { /* 坏文件按无谱系 */ } }
  }
  const pkgDir = join(resolve(outDir), name);
  if (existsSync(pkgDir) && readdirSync(pkgDir).length) throw hopantError('HOPANT_TARGET_EXISTS', `${pkgDir} 已存在且非空——先删或换 --out`);
  // 写包：可分发面,排除本机面
  for (const id of ids) {
    const src = dirOf.get(id)!; const dst = join(pkgDir, 'ants', id);
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true, filter: (p) => { const rel = relative(src, p); return !rel || !isLocalFace(rel); } });
  }
  // 核三自检：产物里不得有本机面路径（防排除逻辑回归）
  const leaked = ids.flatMap(id => listFilesRec(join(pkgDir, 'ants', id)).filter(isLocalFace).map(r => `ants/${id}/${r}`));
  if (leaked.length) { rmSync(pkgDir, { recursive: true, force: true }); throw hopantError('HOPANT_LOCAL_FACE_LEAK', leaked.join(', ')); }
  const ants: Record<string, unknown> = {};
  for (const id of ids) ants[id] = id in lineage ? { lineage: lineage[id] } : {};
  const pkg = { name, version, files: ['ants/'], hopant: { owner: opts.owner, ants } };
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  return { name, version, dir: pkgDir, ants: ids, checks: { header_dir_consistent: true, no_local_face: true, lineage_written: Object.keys(lineage) }, credential_scan: scan, owner: opts.owner };
}
