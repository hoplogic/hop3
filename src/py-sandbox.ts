// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: py-sandbox ^anc-struct-py-sandbox
// Python 语法沙箱的引擎侧编排：读原始字节 → 写私有副本 → 调检查器审副本 → 审过才执行副本 → 清理。
// 设计权威 docs/design/py-sandbox.md（执行契约 ^anc-pysb-exec / 系统沙箱 ^anc-pysb-os-independence）;
// 概念权威 docs/concepts/HopSpec V3扩展-Python语法沙箱.md。
//
// 三条规则本身不在这里——TS 里没有 CPython 解析器,检查器是随包发布的 scripts/pysb/pysb_check.py
// （^anc-pysb-model）。本文件只管"审的字节就是跑的字节"与系统沙箱套用。检查器与产物两次子进程
// 都经命令执行原语发出,受同一份命令白名单管——引擎不给自己开绕过白名单的暗道。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runWhitelistedCommand } from './command-exec.js';

/** 一条拒绝记录——检查器 stdout JSON 里 violations 数组的元素（字段约定见设计 HopType）。 */
export interface PyCheckViolation {
  /** 违规所在行号;语法错误拿不到行号时为 0。 */
  line: number;
  /** 违规的那个名字,按源码形态写（`pathlib` / `os.path` / `.format` / `open` / `<语法>`）。 */
  name: string;
  /** 为什么被拒,一句完整的话。 */
  reason: string;
  /** 替代写法;没有具体替代时是该类白名单清单。 */
  alternative: string;
}

/** 两个出口函数的策略参数——差异全在调用方（run_script 给 python3/60 秒/64KB）。 */
export interface PySandboxOptions {
  /** 解释器命令名（run_script 按扩展名表给 'python3'）;检查器与产物用同一个。 */
  interpreter: string;
  /** 命令白名单（sandbox.runtime.available,原样转交命令执行原语）。 */
  whitelist?: string[];
  /** 产物执行超时秒数（检查器固定 30 秒,不受此项影响）。 */
  timeoutSec: number;
  /** 产物单流输出上限字节（检查器固定 1MB,不受此项影响）。 */
  maxBuffer: number;
}

/** 执行结果二选一:被拒（没执行）或跑完（非零退出码照样是跑完——失败是值）。 */
export type PySandboxRunResult =
  | { status: 'rejected'; violations: PyCheckViolation[]; message: string }
  | { status: 'ran'; stdout: string; stderr: string; returncode: number; defense: 'syntax+os-sandbox' | 'syntax-only' };

/** 只审不跑的结果;message 是给执行模型看的拒绝报文。 */
export type PyCheckResult = { ok: true } | { ok: false; violations: PyCheckViolation[]; message: string };

// 检查器路径——包根由本文件编译产物位置推出（dist/ 的上一级,先例 cli.ts 的 package.json 定位）,不读进程工作目录。
const CHECKER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pysb', 'pysb_check.py');

// 拒绝报文末行固定附表一全列——模型改写时最常需要的就是"到底能 import 什么"（与检查器 MODULE_SYMBOLS 同表）。
const MODULE_SYMBOL_LIST = 'ast.AsyncFunctionDef ast.ClassDef ast.FunctionDef ast.get_docstring ast.iter_child_nodes ast.parse ast.walk re.escape re.findall re.match re.search re.split re.sub json.dumps json.loads sys.argv sys.exit sys.stderr';

// seatbelt profile——三条 deny 对应产物能力面之外的三类动作:连网、起子进程、写盘（^anc-pysb-os-independence）。
const SEATBELT_PROFILE = '(version 1)(allow default)(deny network*)(deny process-fork)(deny file-write*)'
  + '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))';

/**
 * 只审不跑:按三条规则审一份 .py 脚本。被拒是正常结果（返回 ok:false）;检查器自身坏了才抛错。
 * 调用方已过读权限链。消费点:测试与将来交付前"加标头后再审一遍"（^anc-pysb-artifact-form）。
 */
// @a: anc-pysb-exec
export function checkPythonScript(scriptPath: string, opts: PySandboxOptions): PyCheckResult {
  return withPrivateCopy(scriptPath, copy => runChecker(copy, opts));
}

/**
 * 审查并执行一份 .py 脚本——审的字节就是跑的字节:原始字节只读一次,检查器审私有副本、产物执行
 * 同一份副本,不再按原路径读盘。审过才执行;系统沙箱在场即套上,缺席照跑并标 syntax-only。
 * 命令执行原语抛出的错误（白名单拒/超时/撞顶/spawn 失败）原样上抛,由调用方包装。
 */
// @a: anc-pysb-exec
export function runSandboxedPython(scriptPath: string, args: string[], opts: PySandboxOptions): PySandboxRunResult {
  return withPrivateCopy(scriptPath, copy => {
    const check = runChecker(copy, opts);
    if (!check.ok) return { status: 'rejected', violations: check.violations, message: check.message };
    const wrapperArgv = probeOsSandbox();
    const r = runWhitelistedCommand([opts.interpreter, '-I', '-B', copy, ...args], {
      whitelist: opts.whitelist,
      cwd: dirname(scriptPath),   // 脚本读同目录样例文件用相对名;副本在别处,-I 让两个目录都不进模块搜索路径
      timeoutSec: opts.timeoutSec,
      maxBuffer: opts.maxBuffer,
      label: 'run_script',
      wrapperArgv,
    });
    return { status: 'ran', ...r, defense: wrapperArgv ? 'syntax+os-sandbox' : 'syntax-only' };
  });
}

// 私有副本:os.tmpdir() 下新建 hopjit-pysb-<随机> 目录,保留原文件名（拒绝报文与 traceback 里的文件名
// 对得上模型写的那份）。该目录不匹配 work_zone 判定,执行模型的写工具写不进去。finally 恒删。
// @a: anc-pysb-exec
function withPrivateCopy<T>(scriptPath: string, fn: (copy: string) => T): T {
  const bytes = readFileSync(scriptPath);
  const dir = mkdtempSync(join(tmpdir(), 'hopjit-pysb-'));
  try {
    const copy = join(dir, basename(scriptPath));
    writeFileSync(copy, bytes);
    return fn(copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 调检查器并校验输出协议:退出码 0 + stdout 恰为约定 JSON 才算审完;否则是检查器自身失败（引擎
// 故障,抛错——不该让模型去改脚本）。
// @a: anc-pysb-exec
function runChecker(copy: string, opts: PySandboxOptions): PyCheckResult {
  const r = runWhitelistedCommand([opts.interpreter, '-I', '-B', CHECKER_PATH, copy], {
    whitelist: opts.whitelist,
    timeoutSec: 30,
    maxBuffer: 1024 * 1024,
    label: 'Python 语法沙箱检查器',
  });
  const brokenMsg = (why: string) => `Python 语法沙箱检查器自身运行失败（${why}）——这是引擎侧故障,不是脚本的问题。`
    + `检查器 ${CHECKER_PATH},退出码 ${r.returncode},stderr: ${r.stderr.slice(0, 500) || '(空)'}`;
  if (r.returncode !== 0) throw new Error(brokenMsg('非零退出'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    throw new Error(brokenMsg('输出不是 JSON'));
  }
  const o = parsed as { ok?: unknown; violations?: unknown };
  if (o.ok === true) return { ok: true };
  if (o.ok !== false || !Array.isArray(o.violations) || o.violations.length === 0) {
    throw new Error(brokenMsg('输出不合约定形态'));
  }
  const violations = o.violations as PyCheckViolation[];
  return { ok: false, violations, message: formatRejection(violations) };
}

// 拒绝报文排版（设计"拒绝报文"节）:逐条点名行号、名字、原因、替代,末行附表一全列。
// @a: anc-pysb-defenses
function formatRejection(violations: PyCheckViolation[]): string {
  const lines = violations.map(v => `- 第 ${v.line} 行 \`${v.name}\`:${v.reason}。替代:${v.alternative}`);
  return ['Python 语法沙箱审查未通过,脚本没有执行。逐条改完再跑:', ...lines, `可用的模块符号:${MODULE_SYMBOL_LIST}`].join('\n');
}

// 系统沙箱探测:在场返回要拼在 argv 前的包装前缀,缺席返回 undefined。实跑一次 /usr/bin/true 而不是
// 只看命令在不在——sandbox-exec 在场但嵌套被拒（退出码 71）的情形真实存在,只看在不在会让产物以一个
// 与脚本无关的错误失败。每次执行前探一次、不缓存（缓存要引入模块级可变状态,与 run 隔离守卫相抵）。
// 探测是引擎内部的固定命令,不经命令白名单。Linux bwrap 未实现（工程偏差③）,非 macOS 一律缺席。
// @a: anc-pysb-os-independence
function probeOsSandbox(): string[] | undefined {
  if (process.platform !== 'darwin') return undefined;
  const r = spawnSync('sandbox-exec', ['-p', SEATBELT_PROFILE, '/usr/bin/true'], { timeout: 5000, shell: false });
  return !r.error && r.status === 0 ? ['sandbox-exec', '-p', SEATBELT_PROFILE] : undefined;
}
