// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: persistence ^anc-provider-persistence
import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync, openSync, fsyncSync, closeSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { registerWorkZoneRoot } from './tools.js';
import type { SpecAST } from './ast-types.js';
import type { PersistenceProvider } from './provider-types.js';
import type { StateFile, VarsFile, EngineSnapshot } from './runtime-types.js';

/** 原子写文件：先写 `.tmp` 再 rename 覆盖，避免崩溃中途留下半截状态文件。见 design ^anc-exec-crash-recovery */
export function writeAtomic(filePath: string, data: string): void { // @a: anc-exec-crash-recovery
  const tmp = filePath + '.tmp';
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, data);
    // fsync 是"要么旧要么新"承诺的第二步（设计伪代码 write→fsync→rename）——缺它则掉电时
    // rename 可能先于数据落盘持久化，读到空/半截新文件（2026-08-08 语义审计 ❌ 实抓）。
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
}

/** 确保实例状态目录 `<stateDir>/<instanceId>/` 存在（0700 权限）并返回其路径。见 design ^anc-exec-state-persistence */
export function ensureStateDir(stateDir: string, instanceId: string): string { // @a: anc-exec-state-persistence
  const dir = join(stateDir, instanceId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** fan-out 时把某 child 的 params_for_child（内部真值，不 deflate）落盘到其 subinstance 目录
 * `<parentDir>/parallel/<childId>/params.json`，供 worker init 按 cid 回填 itemVar。
 * 见 design/parallel-execution.md ^anc-exec-parallel-foreach-worker。
 * 落盘一律 JSON.stringify（禁手拼），是持久化通道的转义手段——见 ARCHITECTURE.md ^anc-string-escape。
 * // @a: anc-exec-parallel-foreach-worker, anc-string-escape */
export function writeChildParams(parentDir: string, childId: string, params: Record<string, unknown>, kind: 'parallel' | 'calls' = 'parallel'): void {
  const dir = join(parentDir, kind, childId);   // call 子实例落 calls/<cid>（0020——原写死 parallel,call 场景路径错位）
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(join(dir, 'params.json'), JSON.stringify(params, null, 2));
}

/** worker init 按 cid 回读 `<workerInstanceDir>/params.json`（= 父引擎 fan-out 落盘的 child 真值）。
 * 不存在返回 null（触发 MISSING_INPUT 硬报错）。worker 只读自己那份，不碰父/兄弟 vars。 // @a: anc-exec-parallel-foreach-worker */
export function readChildParams(workerInstanceDir: string): Record<string, unknown> | null {
  const filePath = join(workerInstanceDir, 'params.json');
  if (!existsSync(filePath)) return null;
  // 文件存在但损坏 ≠ 不存在：吞成 null 会与"未落盘"同路径走 MISSING_INPUT，掩盖真实故障
  // （设计要求响亮失败——2026-08-08 审计 ⚠️ 修复）。
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>; }
  catch (e) { throw new Error(`CORRUPT_STATE_FILE: params.json 损坏（${filePath}）: ${e instanceof Error ? e.message : String(e)}`); }
}

/** 将执行状态快照原子写入实例目录下的 `state.json`。见 [[persistence#^anc-provider-persistence]] */
export function writeState(dir: string, state: StateFile): void {
  writeAtomic(join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

/** 将变量快照原子写入实例目录下的 `vars.json`。见 [[persistence#^anc-provider-persistence]] */
export function writeVars(dir: string, vars: VarsFile): void {
  writeAtomic(join(dir, 'vars.json'), JSON.stringify(vars, null, 2));
}

/** 将运行时 AST 快照原子写入实例目录下的 `spec.json`（随 replan 演化需重写）。见 [[persistence#^anc-provider-persistence]] */
export function writeSpec(dir: string, spec: object): void {
  writeAtomic(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
}

// 状态文件读取健壮性校验：format_version 必须 === 1 + 关键字段存在。
// 不符抛 CORRUPT_STATE_FILE:<path>（明确定位），替代裸 JSON.parse + as 断言后续的晦涩 TypeError。
// 见 design/exec-engine.md ^anc-exec-parallel-join-preconditions。// @a: anc-exec-parallel-join-preconditions
// requiredKey 可传多个候选（任一存在即合格，用于 vars.json v1 `variables` / v2 `scopes` 二者其一）；
// allowedVersions 缺省 [1]（state.json 恒 v1），vars.json 传 [1,2] 兼容旧扁平格式。
function parseChecked<T>(filePath: string, requiredKeys: string | string[], allowedVersions: number[] = [1]): T {
  let raw: string;
  try { raw = readFileSync(filePath, 'utf-8'); }
  catch (e) { throw new Error(`CORRUPT_STATE_FILE: ${filePath} 不可读 (${e instanceof Error ? e.message : String(e)})`); }
  let obj: unknown;
  try { obj = JSON.parse(raw); }
  catch { throw new Error(`CORRUPT_STATE_FILE: ${filePath} 非合法 JSON`); }
  if (typeof obj !== 'object' || obj === null) {
    throw new Error(`CORRUPT_STATE_FILE: ${filePath} 顶层非对象`);
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec.format_version !== 'number' || !allowedVersions.includes(rec.format_version)) {
    throw new Error(`CORRUPT_STATE_FILE: ${filePath} format_version=${JSON.stringify(rec.format_version)}，期望 ${allowedVersions.join('|')}`);
  }
  const keys = Array.isArray(requiredKeys) ? requiredKeys : [requiredKeys];
  if (!keys.some(k => typeof rec[k] === 'object' && rec[k] !== null)) {
    throw new Error(`CORRUPT_STATE_FILE: ${filePath} 缺关键字段 "${keys.join('|')}"`);
  }
  return obj as T;
}

/** 读取并校验实例目录下的 `state.json`（format_version + step_states 校验）。见 [[persistence#^anc-provider-persistence]] */
export function readState(dir: string): StateFile {
  return parseChecked<StateFile>(join(dir, 'state.json'), 'step_states');
}

/** 读取并校验实例目录下的 `vars.json`（format_version 1|2 + variables/scopes 二者其一校验）。见 [[persistence#^anc-provider-persistence]] */
export function readVars(dir: string): VarsFile {
  return parseChecked<VarsFile>(join(dir, 'vars.json'), ['variables', 'scopes'], [1, 2]);
}

/** 把 VarsFile（v1 扁平 / v2 scope 树）摊平为 name→value 字典，供按名读取的 cli 场景（call 回填、for-each 列表长度、join merge）。
 * v2 合并所有 scope 变量、非 root scope 覆盖 root（与旧 v1 toJSON 的合并序一致，无行为回退）。 */
export function flattenVars(vars: VarsFile): Record<string, unknown> {
  if (vars.format_version === 2 && vars.scopes) {
    const flat: Record<string, unknown> = { ...(vars.scopes.root?.variables ?? {}) };
    for (const [scopeId, data] of Object.entries(vars.scopes)) {
      if (scopeId === 'root') continue;
      Object.assign(flat, data.variables);
    }
    return flat;
  }
  return vars.variables ?? {};
}

/** 读取实例目录下的 `spec.json` 运行时 AST 快照。损坏时抛 CORRUPT_STATE_FILE（与 state/vars 同错误语义，
 * 便于崩溃恢复定位）。SpecAST 无 format_version 字段，故不走 parseChecked。见 [[persistence#^anc-provider-persistence]] */
export function readSpec(dir: string): object {
  const filePath = join(dir, 'spec.json');
  let raw: string;
  try { raw = readFileSync(filePath, 'utf-8'); }
  catch (e) { throw new Error(`CORRUPT_STATE_FILE: ${filePath} 不可读 (${e instanceof Error ? e.message : String(e)})`); }
  let obj: unknown;
  try { obj = JSON.parse(raw); }
  catch { throw new Error(`CORRUPT_STATE_FILE: ${filePath} 非合法 JSON`); }
  if (typeof obj !== 'object' || obj === null) {
    throw new Error(`CORRUPT_STATE_FILE: ${filePath} 顶层非对象`);
  }
  return obj;
}

/** 判断实例目录下是否已存在 `state.json`（cli 定位实例是否有状态）。见 [[persistence#^anc-provider-persistence]] */
export function stateExists(dir: string): boolean {
  return existsSync(join(dir, 'state.json'));
}

/**
 * 复用模式持久化：快照 ↔ .hopstate/<instance_id>/ 文件。
 * CLI 每个命令是独立进程，状态必须外置存活。
 */
export class FilePersistence implements PersistenceProvider { // @a: anc-provider-persistence
  private instanceDir: string | null = null;

  // stateDir: 实例存储的根目录（.hopstate）。从已存在实例目录恢复时传 instanceDir + isInstanceDir=true。
  constructor(private stateDir: string, isInstanceDir = false) {
    if (isInstanceDir) this.instanceDir = stateDir;
  }

  init(instanceId: string, spec: SpecAST): void {
    this.instanceDir = ensureStateDir(this.stateDir, instanceId);
    writeSpec(this.instanceDir, spec);
    // 创建 work_zone/ + work_zone/vars/(driver @file 临时文件 + deflate $file 指针存放)
    // 见 design/exec-engine.md ^anc-exec-work-zone。// @a: anc-exec-work-zone
    mkdirSync(join(this.instanceDir, 'work_zone', 'vars'), { recursive: true, mode: 0o700 });
  }

  // 返回 work_zone 工作区绝对路径,NextResponse 五形态都携带此路径。// @a: anc-exec-work-zone
  getWorkZone(): string {
    if (!this.instanceDir) throw new Error('FilePersistence.getWorkZone before init');
    const wz = join(this.instanceDir, 'work_zone');
    // 注册真实根进写域判定面（0066——state-dir 名不含 .hopstate 字面时字面支不中;发出侧即事实源。
    // 原始形态与 realpath 形态都注册:resolvePath 拿 work_zone_path() 原始产物判、validateFileAccess
    // 拿 resolveReal 后的判——两消费点各吃一种形态,只注册一种另一点失配（probe 重放实抓:只注册
    // realpath 时 /tmp 原始形态在 resolvePath 处照拒）。目录未建时 realpath 炸则只注册原始形态。// @a: anc-exec-work-zone
    registerWorkZoneRoot(wz);
    try { registerWorkZoneRoot(realpathSync(wz)); } catch { /* 目录未建,原始形态已注册 */ }
    return wz;
  }

  saveSnapshot(snapshot: EngineSnapshot): void {
    if (!this.instanceDir) throw new Error('FilePersistence.saveSnapshot before init');
    writeVars(this.instanceDir, snapshot.vars);
    writeState(this.instanceDir, snapshot.state);
    // spec.json 是运行时 AST 快照,随 replan 演化必须重写——否则跨进程 load 丢失 replan
    // 的新 children(此前真实 bug)。见 design/exec-engine.md ^anc-exec-state-persistence。
    // v1 每次 saveSnapshot 都写(整树序列化,spec 通常不大;正确性优先、不漏写);
    // v2 可优化为脏标记(仅 replan 改 AST 时写)。// @a: anc-exec-state-persistence
    writeSpec(this.instanceDir, snapshot.spec);
  }

  loadSnapshot(): EngineSnapshot {
    if (!this.instanceDir) throw new Error('FilePersistence.loadSnapshot before init');
    return {
      spec: readSpec(this.instanceDir) as SpecAST,
      vars: readVars(this.instanceDir),
      state: readState(this.instanceDir),
    };
  }

  exists(): boolean {
    return this.instanceDir != null && stateExists(this.instanceDir);
  }

  getInstanceDir(): string | null {
    return this.instanceDir;
  }
}

/**
 * 宿主无 instanceDir 时的兜底持久化：进程内快照（2026-08-29 设计改判，
 * 原"独立模式默认/无需跨进程"论证已翻案——见 design/persistence.md 决策 2）。
 * 现仅用于宿主自身无 instanceDir 的场景（测试/程序内嵌入）；
 * standalone call/parallel 子实例已改落盘随父。
 * 注意非全然纯内存：getWorkZone 惰性在 tmpdir 建 work_zone 目录
 * （body 内 work_zone_path() 需真实目录）。
 */
export class MemoryPersistence implements PersistenceProvider {
  private snapshot: EngineSnapshot | null = null;
  private spec: SpecAST | null = null;

  init(_instanceId: string, spec: SpecAST): void {
    this.spec = spec;
  }

  saveSnapshot(snapshot: EngineSnapshot): void {
    this.snapshot = snapshot;
  }

  loadSnapshot(): EngineSnapshot {
    if (!this.snapshot) throw new Error('MemoryPersistence.loadSnapshot before any saveSnapshot');
    return this.snapshot;
  }

  exists(): boolean {
    return this.snapshot != null;
  }

  // 独立模式不暴露 work_zone 给外部 driver(dispatcher 进程内直跑,无 @file 跨进程交换需求)——
  // NextResponse 仍透传空串。但 body 内 work_zone_path() 需要真实目录（2026-08-10 作者定），
  // 首次调用时按实例在 tmpdir 下自建。// @a: anc-exec-work-zone
  private workZoneDir = '';
  getWorkZone(): string {
    if (!this.workZoneDir) {
      this.workZoneDir = mkdtempSync(join(tmpdir(), 'hopjit-workzone-'));
      // 同注册（0066——mkdtemp 返回的已是真实路径;字面支已罩 hopjit-workzone-*,注册罩 realpath 差异面）。// @a: anc-exec-work-zone
      registerWorkZoneRoot(this.workZoneDir);
      // vars/ 同建（与 FilePersistence.init 对称——deflate $file 写点在 vars/ 下,
      // 缺目录则大输入组装 ENOENT,BUG-F 实撞）。// @a: anc-exec-work-zone, anc-exec-deflate
      mkdirSync(join(this.workZoneDir, 'vars'), { recursive: true, mode: 0o700 });
    }
    return this.workZoneDir;
  }
}
