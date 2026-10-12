// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: tools ^anc-struct-tools
import { readFileSync, writeFileSync, appendFileSync, realpathSync, readdirSync, statSync, lstatSync, readlinkSync, mkdirSync, renameSync, unlinkSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, isAbsolute, normalize, dirname, basename, join, sep, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolProvider, ToolDef, ToolResult, HostConfig, SandboxConfig, WriteScope } from './provider-types.js';
import { YAML_DUMP_OPTS } from './provider-types.js';   // @a: anc-config-yaml-dump-opts
import { runSandboxedPython } from './py-sandbox.js';   // Python 语法沙箱（.py 脚本一律先审后跑——^anc-pysb-exec） // @a: anc-exec-builtin-run-script
import { parseSpec, parseFragment, serializeFragment } from './parser.js';
import { insertNodeAt, replaceNodeAt, replaceChildrenAt, renumberSteps, syncWorkItems } from './spec-tree-edit.js';
import type { StepNode } from './ast-types.js';
import { DEFAULT_KEEP } from './ast-types.js';   // @a: anc-exec-file-keep-recycle
import { validateSpec, type FragmentOptions } from './validator.js';
import { dump as yamlDump } from 'js-yaml';

/** 写侧工具 content 归一为文本：结构值（yaml 型变量直传）序列化为 YAML 文本落盘——概念
 * ^anc-type-yaml-structured 落盘条款（原 as string 裸断言,结构进来 writeFileSync 抛
 * TypeError 炸穿,三十六审探针实抓）;字符串原样;其余标量 String。// @a: anc-type-yaml-structured */
/** 回收站留存件时间戳——本地时间 YYYYMMDD-HHMMSS（字典序即时间序,轮转按文件名升序） */
function recycleStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function contentToText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return yamlDump(v, YAML_DUMP_OPTS).trimEnd() + '\n';   // @a: anc-config-yaml-dump-opts
  return String(v);
}

/** edit_file 零匹配提示：old_text 首个非空行在文件里最接近的至多 3 行。比较前两边都去掉行首空白与 #、
 * 去掉 [...] 段、压缩空白;规范化相等排最前,其余按字符二元组 Dice ≥0.5 降序。// @a: anc-exec-builtin-edit-file-tool */
function nearestLines(content: string, oldText: string): { line: number; text: string }[] {
  const norm = (s: string) => s.replace(/^[\s#]+/, '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  const bigrams = (s: string) => { const out: string[] = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; };
  const dice = (a: string, b: string) => {
    const x = bigrams(a), y = bigrams(b);
    if (!x.length || !y.length) return a === b ? 1 : 0;
    const pool = new Map<string, number>();
    for (const g of y) pool.set(g, (pool.get(g) ?? 0) + 1);
    let hit = 0;
    for (const g of x) { const c = pool.get(g) ?? 0; if (c > 0) { hit++; pool.set(g, c - 1); } }
    return (2 * hit) / (x.length + y.length);
  };
  const target = norm(oldText.split('\n').find(l => l.trim()) ?? '');
  if (!target) return [];
  return content.split('\n')
    .map((text, i) => ({ line: i + 1, text, score: norm(text) === target ? 2 : dice(norm(text), target) }))
    .filter(c => c.text.trim() && c.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, 3)
    .map(({ line, text }) => ({ line, text }));
}

function resolveReal(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

// 校验链上"目标路径"的真实路径——目标不存在也解析到底（最近已存在祖先的真实路径+剩余段;末段悬空软链顺链接目标继续,
// 相对链接目标以软链所在目录的真实路径为基准——与 OS 解析同基准）。旧实现 resolveReal 在目标不存在时退回未解析
// 形态,经软链父目录新建文件即逃出 workspace（hopissues/0112 批次 probe 实证）。失败即拒:只数软链跳数,超限抛错,
// 不返回未解析形态（未解析路径字面常在 workspace 内,返回它等于放行）。见 [[tools/file-tools#^anc-exec-tool-path-resolve]]
// @a: anc-exec-tool-path-resolve
const MAX_SYMLINK_HOPS = 40;   // 与 Linux 内核 MAXSYMLINKS 同值
/** 路径的真实形态——目标存在取 realpath;不存在则逐级上溯祖先解析软链后拼回尾段（软链跳数超 40 抛错不放行）。mcp-server run_approved_command 的 cwd 越界判共用。 */
export function resolveRealDeep(p: string, hops = 0): string {
  try { return realpathSync(p); } catch { /* 目标不存在或链路断,往下解析 */ }
  let isLink = false;
  try { isLink = lstatSync(p).isSymbolicLink(); } catch { /* 不存在,按祖先解析 */ }
  if (isLink) {
    if (hops >= MAX_SYMLINK_HOPS) throw new Error(`Symlink chain too deep or cyclic: ${p}`);
    return resolveRealDeep(resolve(resolveRealDeep(dirname(p), hops), readlinkSync(p)), hops + 1);
  }
  const parent = dirname(p);
  if (parent === p) return p;   // 已到文件系统根
  return join(resolveRealDeep(parent, hops), basename(p));   // 上溯祖先不计跳数
}

// "p 在目录 root 内"——恒带路径分隔符边界（裸 startsWith 会把 /x/proj2 当成 /x/proj 之内,probe 实证可越界覆盖）。
// 两参须已统一成同一形态（都取真实路径或都取字面）。// @a: anc-exec-tool-path-resolve
/** p 是否落在目录 root 内（含相等）——带路径分隔符边界;两参须同为真实路径或同为字面。 */
export function isWithinDir(p: string, root: string): boolean {
  if (p === root) return true;
  return p.startsWith(root.endsWith(sep) ? root : root + sep);
}

// 解析文件工具 path 入参:workspace 相对路径按根拼接;绝对路径落在 workspace 内即认（与相对写法落同一处）,
// 外则拒且报文点名 workspace 根;含 .. 一律拒。复用于 DefaultToolProvider 与 doc-ref。
// 只管形态与落区——软链逃逸由校验链的真实路径判定拦（hopissues/0112 前是"一律禁绝对路径"）。
// @a: anc-exec-tool-permission, anc-exec-tool-path-resolve
export function resolveWorkspacePath(workspaceDir: string, filePath: string): string {
  if (filePath.includes('..')) {
    throw new Error(`Path traversal (..) is forbidden: ${filePath}`);
  }
  if (!isAbsolute(filePath)) return resolve(workspaceDir, filePath);
  const p = normalize(filePath);
  // 字面判 或 真实路径判（macOS /tmp→/private/tmp:字面 /tmp/… 对已取真实路径的根字面不中）
  if (isWithinDir(p, workspaceDir) || isWithinDir(resolveRealDeep(p), resolveReal(workspaceDir))) return p;
  throw new Error(`Absolute path outside workspace: ${filePath}（workspace 根: ${workspaceDir}——写 workspace 相对路径,或写落在 workspace 内的绝对路径）`);
}

// 路径是否匹配某模式（子串命中 或 realpath 前缀命中）。denied/confirm_required 共用同一判据。
// 注：includes 子串匹配偏宽（会跨路径段命中），属已登记的收紧候选（见 code-quality 报告 tools P2），
// 此处只抽重复、不改判据（沙箱行为不变）。
function pathMatches(realPath: string, pattern: string): boolean {
  // 含通配符的模式走 glob 语义（* 匹配单段不跨 /，** 匹配任意含 /）——此前纯子串匹配下
  // '*.key' 等字面星号模式永远命不中任何真实路径 = 静默失效（2026-08-08 复核实抓：
  // denied 基线三个 glob 模式全部空转，且测试只断言数组含字符串未测拦截行为=声明自证假绿）。
  if (pattern.includes('*')) {
    const esc = (t: string) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const body = pattern
      .split('**').map(seg => seg.split('*').map(esc).join('[^/]*'))
      .join('.*');
    return new RegExp(`(^|/)${body}($|/)`).test(realPath);
  }
  return realPath.includes(pattern) || realPath.startsWith(resolveReal(pattern));
}

// 校验读权限（denied / confirm_required / workspace 内 / allowed 链）。
// 抽自 DefaultToolProvider.validateFileAccess 的 read 分支，供 doc-ref 复用。
// @a: anc-exec-tool-permission
export function validateReadAccess(sandbox: SandboxConfig, resolvedPath: string): void {
  const realPath = resolveRealDeep(resolvedPath);   // @a: anc-exec-tool-path-resolve
  const fs = sandbox.filesystem;
  const wsDir = resolveReal(resolve(fs.workspace_dir));
  for (const denied of fs.read_access.denied) {
    if (pathMatches(realPath, denied)) {
      throw new Error(`Read denied: ${realPath} matches denied pattern "${denied}"`);
    }
  }
  for (const confirmReq of fs.read_access.confirm_required) {
    if (pathMatches(realPath, confirmReq)) {
      throw new Error(`Read requires confirm: ${realPath} (act steps cannot confirm)`);
    }
  }
  if (isWithinDir(realPath, wsDir)) return;
  for (const allowed of fs.read_access.allowed) {
    const allowedReal = resolveReal(resolve(allowed));
    if (isWithinDir(realPath, allowedReal)) return;
  }
  throw new Error(`Read outside allowed paths: ${realPath}`);
}

// 读取一个受沙箱约束的 workspace 文件（解析路径 + 校验读权限 + 读取）。
// doc-ref 解析直接复用此入口，与 act 步骤的 read 工具同一套权限。
// @a: anc-exec-doc-ref-resolve
export function readSandboxedFile(workspaceDir: string, sandbox: SandboxConfig, filePath: string): string {
  const resolved = resolveWorkspacePath(workspaceDir, filePath);
  validateReadAccess(sandbox, resolved);
  return readFileSync(resolved, 'utf-8');
}

const READ_TOOL: ToolDef = {
  name: 'read',
  description: 'Read a file and return its contents — whole file, or a 1-based line range via start_line/end_line.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to read' },
      start_line: { type: 'integer', description: 'Optional 1-based start line — omit both line params to read the whole file' },
      end_line: { type: 'integer', description: 'Optional 1-based end line (inclusive); beyond EOF reads to end of file' },
    },
    required: ['path'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "文件内容（文本）——全文,或带 start_line/end_line 时该行号段",
};

// 覆盖与删除前留存旧版本（2026-10-08 作者定,与 commit 安全分析同批次）：write / edit_file / move / remove
// 带可选 keep（缺省 DEFAULT_KEEP,住 ast-types.ts）——销毁 work_zone 外已有文件的内容前先复制进 <状态目录>/recycle/,同一文件每次 run 只留存一次
// （接管账 recycle_ledger.json 记录）。契约 [[tools/file-tools#^anc-exec-file-keep-recycle]]。
// @a: anc-exec-file-keep-recycle
/** 回收站目录名（状态目录下的子目录）;不叫 backup——作者定,避免和用户自己的备份目录混淆 */
const RECYCLE_DIR_NAME = 'recycle';
/** 接管账文件名——放在顶层实例目录里,记录本次运行里每个文件是否已留存过,子实例共用,续跑与崩溃恢复后仍在 */
const RECYCLE_LEDGER_FILE = 'recycle_ledger.json';
/** 接管账条目——copy 装留存件绝对路径（字符串路径,不是内容）;created 表示当前内容是本 run 写出的 */
type RecycleLedgerEntry = { copy: string } | { created: true };
const KEEP_PARAM = { type: 'integer', minimum: 0, description: 'Before overwriting or deleting an existing file, keep its old version in the recycle area; at most this many versions per file. Default 3; 0 = keep nothing' };

const WRITE_TOOL: ToolDef = {
  name: 'write',
  description: 'Write content to a file (create or overwrite).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to write' },
      content: { type: 'string', description: 'Content to write' },
      keep: KEEP_PARAM,
    },
    required: ['path', 'content'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "写入回执一句话（文本,如 'Written N bytes to <path>';覆盖已有文件时末尾注明旧版本存放位置）",
};

// 内置文件/目录工具组（2026-08-10 作者定实装）：全部 requires_commit=false——
// 不可逆分界=是否出沙箱，非操作类型（沙箱是探索区、整体可重建）。写侧全限
// workspace 内+禁 .hopstate/。见 [[tools/file-tools#^anc-exec-builtin-file-tools]]。
// @a: anc-exec-builtin-file-tools
const LIST_DIR_TOOL: ToolDef = {
  name: 'listdir',
  description: 'List directory entries (name + type: file/dir).',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path to list' } },
    required: ['path'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "JSON: [{name, type: file|dir}] 目录条目数组（裸数组，无包装对象;kind 同值兼容别名）",
};

const FILE_EXISTS_TOOL: ToolDef = {
  name: 'exists',
  description: 'Check whether a path exists (returns exists + kind).',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to probe' } },
    required: ['path'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "JSON: {exists: 是否存在(bool), type: file|dir（存在时;kind 同值兼容别名）}",
};

const CREATE_TOOL: ToolDef = {
  name: 'create',
  description: 'Create a new file exclusively — fails if it already exists (atomic, for concurrent claim/sentinel files).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the new file' },
      content: { type: 'string', description: 'Initial content' },
    },
    required: ['path', 'content'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "创建回执一句话（文本）;目标已存在则失败",
};

const APPEND_TOOL: ToolDef = {
  name: 'append',
  description: 'Append content to a file (creates it if missing).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file' },
      content: { type: 'string', description: 'Content to append' },
    },
    required: ['path', 'content'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "追加回执一句话（文本）",
};

// edit_file 局部精确替换（2026-09-05 作者拍甲案——0038b 实测"改三处却 write 全文回写"的封堵正路）。
// 见 [[tools/file-tools#^anc-exec-builtin-edit-file-tool]]。
// @a: anc-exec-builtin-edit-file-tool
const EDIT_FILE_TOOL: ToolDef = {
  name: 'edit_file',
  description: 'Replace exactly one occurrence of old_text with new_text in a file.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the file to edit' },
      old_text: { type: 'string', description: 'Exact text to replace — must match exactly one occurrence in the file' },
      new_text: { type: 'string', description: 'Replacement text (empty string = delete old_text; to insert, include old_text as anchor plus the new content)' },
      keep: KEEP_PARAM,
    },
    required: ['path', 'old_text', 'new_text'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "替换回执一句话（文本,含替换处字符偏移,如 'Replaced 1 occurrence at char N in <path>'）",
};

// search_file 单文件子串搜索（2026-09-05 作者拍"rg 类工具两件立todo",todo/0070——D81 定向读盘
// 正路的读侧兑现:按关键词定位行号,配合 read 行号段取代整读）。纯子串非正则、零命中空清单。
// 见 [[tools/file-tools#^anc-exec-builtin-search-file]]。
// @a: anc-exec-builtin-search-file
const SEARCH_FILE_TOOL: ToolDef = {
  name: 'search_file',
  description: 'Search a single file for a literal substring; returns matching lines with 1-based line numbers. Not a regex.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the file to search' },
      pattern: { type: 'string', description: 'Literal substring to search for (not a regex); must be non-empty' },
      context_lines: { type: 'integer', description: 'Optional number of context lines around each match (default 0)' },
    },
    required: ['path', 'pattern'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "命中清单 JSON 文本 [{line, text}]（line 为 1 起行号;context_lines>0 时成员另带 context 字段;零命中=[]）",
};

const MKDIR_TOOL: ToolDef = {
  name: 'makedirs',
  description: 'Create a directory (with parents; succeeds if it already exists).',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path to create' } },
    required: ['path'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "创建回执一句话（文本）",
};

const MOVE_TOOL: ToolDef = {
  name: 'move',
  description: 'Move/rename a file or directory (atomic rename within the filesystem).',
  input_schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source path' },
      to: { type: 'string', description: 'Destination path' },
      keep: KEEP_PARAM,
    },
    required: ['from', 'to'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "移动回执一句话（文本,目标已存在被替换时末尾注明旧版本存放位置）;源不存在则失败",
};

const DELETE_TOOL: ToolDef = {
  name: 'remove',
  description: 'Delete a file (fails if it does not exist).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the file to delete' },
      keep: KEEP_PARAM,
    },
    required: ['path'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "删除回执一句话（文本,末尾注明旧版本存放位置;keep=0 为永久删除）;目标不存在则失败",
};

// run_script 受控脚本执行（2026-09-22 作者拍 todo/0110 候选 B——实撞:standalone 的 [act free]
// 工具面此前没有任何一件能让进程跑起来,而 sdc 规约步骤要求"实跑校验脚本",三家模型在同一步各
// 死一种死法、其中一家被逼出伪造执行来源。本件不给引擎添新物理能力:同一份 spawn 能力 body 面的
// subprocess.run 早已发布,增量只是"决定跑什么的人从规约作者变成执行模型"——故 category='special'
// 须节点显式声明才下发。契约 [[tools/run-script#^anc-exec-builtin-run-script]]。
// 工具说明必须写明工作目录=脚本所在目录（2026-09-23 T9 复跑实撞:模型照其余文件工具的习惯给 args 传
// 工作区相对路径,脚本找不到文件——契约同锚点"工作目录这条约定必须写进给执行 LLM 看的工具说明"）。
// @a: anc-exec-builtin-run-script
const RUN_SCRIPT_TOOL: ToolDef = {
  name: 'run_script',
  description: 'Run a script file and return its stdout/stderr/exit code. You choose the script and its arguments; the engine picks the interpreter from the file extension (.py → python3) — you cannot pass a command. Shell scripts (.sh) are refused. Every .py script is first checked by the Python syntax sandbox: only `import ast`/`re`/`json`/`sys` (used as module.symbol), a fixed set of builtins, and read-only open() are allowed. A rejected script is not run; the failure message lists each offending line with a replacement — fix them and call again. The script runs with its own directory as the working directory, and args reach it verbatim (the engine does not resolve them): pass sample files that sit next to the script by bare filename (e.g. args: ["sample.ts"]), not by a workspace-relative path.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the script file to run (.py), resolved like the other file tools. Must already exist — write it first.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Optional command-line arguments passed to the script, one list item per argument. Passed as-is; relative paths are resolved by the script against its own directory, so a file next to the script is just its filename' },
    },
    required: ['path'],
  },
  requires_commit: false,   // 与 body 面的 subprocess.run 同档（同一份能力同一个曝露面）
  category: 'special',      // 第一个 special 内置件——须节点写 `- 工具: run_script` 才下发（三条理由见契约）
  returns: "JSON 文本 {returncode, stdout, stderr, defense}。**非零退出码是脚本自己的判定结果,不是工具失败**（校验脚本对违规样例返回 1 是正常行为,照常读 stdout 用它的结论）;defense 是本次执行的防护等级（syntax+os-sandbox=语法审查加系统沙箱 / syntax-only=只有语法审查）。工具报失败只在脚本没能跑起来时（语法沙箱审查未通过——报文逐条列出违规行与替代写法,照改后重调/扩展名不支持/命令白名单未放行/文件不存在/超时/输出过大）",
};

// 脚本扩展名 → 解释器（模型不选命令,引擎按扩展名定——^anc-exec-run-script-no-command-choice）。
// v1 只此一行:sdc 类任务的校验脚本恒是 Python。加一行的成本是本表 + 操作者白名单放行同名解释器。
const SCRIPT_INTERPRETERS: Record<string, string> = { '.py': 'python3' };

/** ToolProvider 契约的默认实现：无宿主注入时提供 Read/Write 两个受控工具（均 requires_commit=false，不含 bash），执行受 SandboxConfig 约束。见 [[tools#^anc-struct-tools]] */
// 内置 spec 验证工具（2026-08-16 作者定:hopbuild 验证 in-process 化）：纯函数零文件访问,
// 与 CLI validate 同一实现——两通道零语义分叉。见 [[tools/spec-tree-tools#^anc-exec-builtin-validate-tool]]。
// @a: anc-exec-builtin-validate-tool
const VALIDATE_SPEC_TOOL: ToolDef = {
  name: 'validate_spec',
  description: 'Validate HopSpec text (or a bare step fragment) and return {status, errors, warnings} JSON. Pure function: pass the content itself, not a path.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Full spec markdown, or bare step fragment when fragment=true' },
      fragment: { type: 'boolean', description: 'Validate as a bare step fragment (numbering starts at 1; whole-file completeness rules exempt)' },
      known_vars: { type: 'array', items: { type: 'string' }, description: 'Fragment mode: upstream variable names available to the fragment (feeds V1 traceability)' },
    },
    required: ['text'],
  },
  requires_commit: false,
  returns: "JSON: {status: ok|error, errors: 结构化错误列表, warnings: 同}",
};

// 内置 spec 树编辑函数组（2026-08-19 作者立项"维护骨干与完整 spec 序号一致性";2026-08-30
// 作者拍板函数化——四操作拆四个独立工具各自可调,共享底盘沉 spec-tree-edit.ts,旧 edit_spec_tree
// 单入口废除）。见 [[tools/spec-tree-tools#^anc-exec-builtin-edit-tree-tool]]。// @a: anc-exec-builtin-edit-tree-tool
const TREE_EDIT_COMMON_PROPS = {
  spec_text: { type: 'string', description: 'Full spec markdown; or a bare step fragment when spec_is_fragment=true' },
  spec_is_fragment: { type: 'boolean', description: 'Treat spec_text as a bare step fragment (no # title / ## Steps); output spec_text is also a bare fragment' },
  work_items: { type: 'array', items: { type: 'string' }, description: "Optional queue items 'path | desc | weight' — first segment rewritten per renumber_map" },
} as const;

const INSERT_NODE_TOOL: ToolDef = {
  name: 'insert_node',
  description: 'Insert a step fragment at the given step position; the step currently there (and all following siblings with their subtrees) shift down, all steps renumbered by tree position. Append = last position + 1 (the only allowed out-of-range path). Returns {spec_text, work_items?, renumber_map} JSON. Pure function.',
  input_schema: {
    type: 'object',
    properties: {
      ...TREE_EDIT_COMMON_PROPS,
      node_path: { type: 'string', description: "Landing step id for the fragment (e.g. '2' or '2.1'); to append, use last sibling number + 1" },
      fragment: { type: 'string', description: 'Bare step fragment, numbering starts at 1' },
    },
    required: ['spec_text', 'node_path', 'fragment'],
  },
  requires_commit: false,
  returns: "JSON: {status, spec_text: 编辑并重编号后全文, work_items?: 随重编号改写, renumber_map: 旧号→新号}",
};

const REPLACE_NODE_TOOL: ToolDef = {
  name: 'replace_node',
  description: 'Splice a fragment in place of the target node itself (node line and subtree removed, fragment steps take its position — placeholder leaf replacement). Batch via replacements (all targets located by pre-call ids, renumber once). Returns {spec_text, work_items?, renumber_map} JSON. Pure function.',
  input_schema: {
    type: 'object',
    properties: {
      ...TREE_EDIT_COMMON_PROPS,
      node_path: { type: 'string', description: 'Target step id (single replacement; ignored when replacements present)' },
      fragment: { type: 'string', description: 'Bare step fragment (single replacement; ignored when replacements present)' },
      replacements: { type: 'array', items: { type: 'object', properties: { node_path: { type: 'string' }, fragment: { type: 'string' } }, required: ['node_path', 'fragment'] }, description: 'Batch: all targets located by pre-call step ids, renumber once at the end' },
    },
    required: ['spec_text'],
  },
  requires_commit: false,
  returns: "JSON: 同 insert_node（{status, spec_text, work_items?, renumber_map}）",
};

const REPLACE_CHILDREN_TOOL: ToolDef = {
  name: 'replace_children',
  description: "Replace all children of the target node with the fragment (node line itself kept — container expansion). node_path 'root' replaces the whole Steps section. Returns {spec_text, work_items?, renumber_map} JSON. Pure function.",
  input_schema: {
    type: 'object',
    properties: {
      ...TREE_EDIT_COMMON_PROPS,
      node_path: { type: 'string', description: "Target step id; 'root' replaces all top-level steps" },
      fragment: { type: 'string', description: 'Bare step fragment, numbering starts at 1' },
    },
    required: ['spec_text', 'node_path', 'fragment'],
  },
  requires_commit: false,
  returns: "JSON: 同 insert_node（{status, spec_text, work_items?, renumber_map}）",
};

const RENUMBER_STEPS_TOOL: ToolDef = {
  name: 'renumber_steps',
  description: 'Renumber all steps by tree position without structural change (fix a skewed draft). Returns {spec_text, work_items?, renumber_map} JSON. Pure function.',
  input_schema: {
    type: 'object',
    properties: { ...TREE_EDIT_COMMON_PROPS },
    required: ['spec_text'],
  },
  requires_commit: false,
  returns: "JSON: 同 insert_node（{status, spec_text, work_items?, renumber_map}）",
};

const READ_SPEC_TREE_TOOL: ToolDef = {
  name: 'read_spec_tree',
  description: 'Read HopSpec selectively: mode=skeleton returns structure tree only (step lines + IO declarations, no execution notes or bodies); mode=node returns the full subtree of one step id. Pure function: pass content, not paths.',
  input_schema: {
    type: 'object',
    properties: {
      spec_text: { type: 'string', description: 'Full spec markdown; or a bare step fragment when spec_is_fragment=true' },
      mode: { type: 'string', enum: ['skeleton', 'node'], description: 'skeleton=structure tree without notes/bodies; node=full subtree of node_path' },
      node_path: { type: 'string', description: "Target step id (e.g. '2.1'); required for mode=node" },
      spec_is_fragment: { type: 'boolean', description: 'Treat spec_text as a bare step fragment' },
    },
    required: ['spec_text', 'mode'],
  },
  requires_commit: false,
  returns: "JSON: {status, text: skeleton=结构树文本|node=子树全文, errors?: 出错时}",
};

/** read_spec_tree 执行体（纯函数——测试直调）。树编辑函数组的读面对偶：skeleton 读骨干/
 * node 按步骤树下钻子树（D45,作者立项"需要有按章节读内容或者读骨干的功能"——大 spec 住文件,
 * 消费方先读骨干按需下钻,不再整文灌 prompt）。见 [[tools/spec-tree-tools#^anc-exec-builtin-read-tree-tool]] */
// @a: anc-exec-builtin-read-tree-tool
export function executeReadSpecTree(args: Record<string, unknown>, lang: 'en' | 'zh' = 'en'): ToolResult {
  const jsonErr = (errors: unknown): ToolResult => ({ result: JSON.stringify({ status: 'error', errors }), success: false, content_type: 'json' });
  const specText = args.spec_text;
  const mode = args.mode;
  if (typeof specText !== 'string' || !specText.trim()) return jsonErr([{ kind: 'args', message: 'spec_text 须为非空字符串' }]);
  if (mode !== 'skeleton' && mode !== 'node') return jsonErr([{ kind: 'args', message: "mode 须为 skeleton | node" }]);
  const isFrag = args.spec_is_fragment === true;
  const parsed = isFrag ? parseFragment(specText) : parseSpec(specText);
  if (parsed.errors.length > 0) return jsonErr(parsed.errors);
  const steps = parsed.ast.steps ?? [];
  if (mode === 'node') {
    const target = typeof args.node_path === 'string' ? args.node_path : '';
    const find = (nodes: StepNode[]): StepNode | null => {
      for (const n of nodes) {
        if (n.step_id === target) return n;
        const kids = (n as { children?: StepNode[] }).children;
        if (kids?.length) { const hit = find(kids); if (hit) return hit; }
      }
      return null;
    };
    const node = find(steps);
    if (!node) return jsonErr([{ kind: 'lookup', message: `NODE_NOT_FOUND: 步骤 '${target}' 不存在` }]);
    return { result: JSON.stringify({ status: 'ok', text: serializeFragment([node], { lang }) }), success: true, content_type: 'json' };
  }
  // skeleton：结构行（步骤行+IO 声明）——不含执行说明（> 行）与 body
  const lines: string[] = [];
  const walk = (nodes: StepNode[]): void => {
    for (const n of nodes) {
      const full = serializeFragment([{ ...n, children: [] } as StepNode], { lang }).split('\n');
      for (const l of full) {
        const s = l.trim();
        if (s === '' || s.startsWith('>')) continue;   // 执行说明与 body 全部剔除
        lines.push(l);
      }
      const kids = (n as { children?: StepNode[] }).children;
      if (kids?.length) walk(kids);
    }
  };
  walk(steps);
  return { result: JSON.stringify({ status: 'ok', text: lines.join('\n') + '\n' }), success: true, content_type: 'json' };
}

/** 树编辑四工具执行体（Provider 外纯函数,测试直调）。共享壳（行级手术形态,hopissues/0048
 * 作者拍定方案 A）:parse（全文/裸片段——只做定位与记账,不产出文本）→ spec-tree-edit 核心函数
 * → renumberSteps → syncWorkItems → 原文行数组上行级手术产出文本（原"serializeSpec 全文重建"
 * 结构性有损:parser 建 AST 前就丢 %% 块/HTML 注释锚/续行注释/行式头四类载体,serialize 无从
 * 回写——hopkb 891 行真规约干跑 renumber 丢 213 行实测）。
 * 见 [[tools/spec-tree-tools#^anc-exec-tree-edit-line-surgery]] 契约四条。// @a: anc-exec-builtin-edit-tree-tool, anc-exec-tree-edit-line-surgery */
type TreeEditParsed = {
  ast: { steps?: StepNode[] }; specIsFragment: boolean; workItems?: string[];
  lines: string[];                          // spec_text 原文行数组（手术的字节权威）
  srcLinesOf: WeakMap<object, string[]>;    // 节点→其原文行数组（主文节点→lines;片段节点→各自片段的行数组）
  prefixEnd: number;                        // 0-based 排他:首步行之前的原文行全属前缀,原样进出
  suffixStart: number;                      // 0-based:末步范围（尾部叙事节钳位后）之后的原文行全属后缀,原样进出
};

function parseTreeEditInput(args: Record<string, unknown>, toolName: string): TreeEditParsed | ToolResult {
  const specText = args.spec_text;
  if (typeof specText !== 'string') return { result: `${toolName}: spec_text 必须是字符串`, success: false, content_type: 'text' };
  const specIsFragment = args.spec_is_fragment === true;
  if (args.spec_is_fragment !== undefined && typeof args.spec_is_fragment !== 'boolean') {
    return { result: `${toolName}: spec_is_fragment 参数必须是布尔`, success: false, content_type: 'text' };
  }
  const workItems = Array.isArray(args.work_items) && (args.work_items as unknown[]).every(v => typeof v === 'string')
    ? args.work_items as string[] : undefined;
  const { ast, errors: pe } = specIsFragment ? parseFragment(specText) : parseSpec(specText);
  if (pe.length > 0) return { result: JSON.stringify({ status: 'error', errors: pe }), success: false, content_type: 'json' };
  if (!ast.steps) return { result: `${toolName}: spec 无 Steps 节`, success: false, content_type: 'text' };

  // 行级手术底账：原文行数组 + 每个节点的源行归属 + 前后缀边界（^anc-exec-tree-edit-line-surgery）
  const lines = specText.split('\n');
  const srcLinesOf = new WeakMap<object, string[]>();
  const flat: StepNode[] = [];
  const collect = (list: StepNode[]) => {
    for (const n of list) {
      srcLinesOf.set(n, lines);
      flat.push(n);
      const kids = (n as { children?: StepNode[] }).children;
      if (kids?.length) collect(kids);
    }
  };
  collect(ast.steps as StepNode[]);
  let prefixEnd = lines.length, suffixStart = lines.length;
  if (flat.length > 0) {
    prefixEnd = (flat[0].source_location?.line_start ?? 1) - 1;
    // 尾部叙事节钳位：末步（先序末位=文档序末位）的行区间在 parser 账面上吞并了 Steps 区之后的
    // 非关键字 ## 节（任务卡 ## 背景/## 处置记录——splitSections 只认关键字节头）。手术把末步
    // 区间钳在第一个尾部 ## 标题行之前（围栏感知）——编辑末步不把叙事节搬走或删掉。
    const last = flat[flat.length - 1];
    let end = last.source_location?.line_end ?? lines.length;   // 1-based 含端
    let inFence = false;
    for (let i = last.source_location?.line_start ?? 1; i < end; i++) {   // 0-based 从步骤行的下一行起扫
      const t = lines[i].trim();   // 节头判据按 trim 后判——与 parser 节切分同构（review D5:
      if (/^```/.test(t)) { inFence = !inFence; continue; }   // raw 判会漏带前导空格的尾部标题,钳不住）
      if (inFence) continue;
      if (/^##\s/.test(t)) { end = i; break; }
    }
    if (last.source_location) last.source_location = { ...last.source_location, line_end: end };
    suffixStart = end;
  }
  return { ast: ast as { steps?: StepNode[] }, specIsFragment, workItems, lines, srcLinesOf, prefixEnd, suffixStart };
}

/** 片段节点打 __frag 临时唯一号：片段自带 1..n 相对号会与原树 step_id 撞号——撞号会把
 * "片段相对号→最终号"污染进 renumber_map,进而让 syncWorkItems 误改写指向未移动步骤的
 * 队列项（review 面二/面三实证）。与 dispatcher replan 拼装的 tagTemp 同法;临时键由
 * finishTreeEdit 从返回映射剔除。seq 由调用方传（批量 replacements 逐项递增——不用模块级
 * 计数器,run 隔离守卫禁模块顶层可变状态）。// @a: anc-exec-builtin-edit-tree-tool */
function tagFragTemp(nodes: StepNode[], seq: number): StepNode[] {
  const tag = `__frag${seq}`;
  const walk = (list: StepNode[], prefix: string) => {
    list.forEach((n, i) => {
      (n as { step_id: string }).step_id = `${prefix}.${i + 1}`;
      const kids = (n as { children?: StepNode[] }).children;
      if (kids?.length) walk(kids, (n as { step_id: string }).step_id);
    });
  };
  walk(nodes, tag);
  return nodes;
}

// 片段行登记是行级手术的一环（片段按原文字节进树,只改编号 token）。// @a: anc-exec-tree-edit-line-surgery
function parseTreeEditFragment(frag: unknown, toolName: string, seq = 1, parsed?: TreeEditParsed): StepNode[] | ToolResult {
  if (typeof frag !== 'string' || !frag.trim()) return { result: `${toolName}: 需要非空 fragment`, success: false, content_type: 'text' };
  const { ast: fa, errors: fe } = parseFragment(frag);
  if (fe.length > 0) return { result: JSON.stringify({ status: 'error', errors: fe }), success: false, content_type: 'json' };
  const fs2 = fa.steps ?? [];
  if (!fs2.length) return { result: `${toolName}: fragment 无可解析步骤`, success: false, content_type: 'text' };
  // 行级手术底账登记：片段节点的源行=片段自己的行数组（渲染时按原文字节进树,只改编号 token）
  if (parsed) {
    const fragLines = frag.split('\n');
    const reg = (list: StepNode[]) => {
      for (const n of list) {
        parsed.srcLinesOf.set(n, fragLines);
        const kids = (n as { children?: StepNode[] }).children;
        if (kids?.length) reg(kids);
      }
    };
    reg(fs2 as StepNode[]);
  }
  return tagFragTemp(fs2 as StepNode[], seq);
}

/** 节点的原文行段：源行数组按 source_location 切片,首行（步骤行）只改行首编号 token
 * ——含标题风 `### N.` 前缀与缩进形态,行内其余字节一律不碰。// @a: anc-exec-tree-edit-line-surgery */
function stepOwnSegment(n: StepNode, srcLinesOf: WeakMap<object, string[]>): string[] {
  const src = srcLinesOf.get(n);
  const sl = n.source_location;
  if (!src || !sl) return [];
  const seg = src.slice(sl.line_start - 1, sl.line_end);
  if (seg.length > 0) {
    seg[0] = seg[0].replace(/^(\s*(?:#+\s+)?)(\d+(?:\.\d+)*)/, (_m, pre: string) => pre + n.step_id);
  }
  return seg;
}

/** 行级手术产出文本：前缀原样 + 编辑后树的先序段落搬移 + 后缀原样。
 * 无结构变化的 renumber 干跑=各段按原序连续铺满=逐字节幂等。// @a: anc-exec-tree-edit-line-surgery */
function renderTreeEditText(parsed: TreeEditParsed): string {
  const out: string[] = parsed.lines.slice(0, parsed.prefixEnd);
  const emit = (list: StepNode[]) => {
    for (const n of list) {
      out.push(...stepOwnSegment(n, parsed.srcLinesOf));
      const kids = (n as { children?: StepNode[] }).children;
      if (kids?.length) emit(kids);
    }
  };
  emit(parsed.ast.steps as StepNode[]);
  out.push(...parsed.lines.slice(parsed.suffixStart));
  return out.join('\n');
}

function finishTreeEdit(parsed: TreeEditParsed): ToolResult {
  const steps = parsed.ast.steps as StepNode[];
  const renumberMap = renumberSteps(steps);
  // 剔除片段临时键——renumber_map 只含真实旧树号,"旧号→新号全映射"契约才成立;
  // 临时键混入会让 syncWorkItems 把指向未移动步骤的队列项误改写。
  for (const k of Object.keys(renumberMap)) {
    if (k.startsWith('__frag')) delete renumberMap[k];
  }
  const outText = renderTreeEditText(parsed);   // 行级手术,弃 serialize 全文重建（^anc-exec-tree-edit-line-surgery）
  const out: Record<string, unknown> = { status: 'ok', spec_text: outText, renumber_map: renumberMap };
  if (parsed.workItems) out.work_items = syncWorkItems(parsed.workItems, renumberMap);
  return { result: JSON.stringify(out), success: true, content_type: 'json' };
}

/** insert_node 工具执行体：片段落位到 node_path（后移让位;插尾=末步下一号）→重编号→队列同步。 */
export function executeInsertNode(args: Record<string, unknown>): ToolResult { // @a: anc-exec-builtin-edit-tree-tool
  const parsed = parseTreeEditInput(args, 'insert_node');
  if ('success' in parsed) return parsed;
  const nodePath = typeof args.node_path === 'string' ? args.node_path : '';
  if (!nodePath) return { result: 'insert_node 需要 node_path（新片段的落位序号;插尾写最后一步的下一号）', success: false, content_type: 'text' };
  const frag = parseTreeEditFragment(args.fragment, 'insert_node', 1, parsed);
  if (!Array.isArray(frag)) return frag;
  const r = insertNodeAt(parsed.ast.steps as StepNode[], nodePath, frag);
  if (!r.ok) return { result: `insert_node: ${r.error}`, success: false, content_type: 'text' };
  return finishTreeEdit(parsed);
}

/** replace_node 工具执行体：恒批量两阶段解引用替换（先全定位后全替换,序号漂移免疫）。 */
export function executeReplaceNode(args: Record<string, unknown>): ToolResult { // @a: anc-exec-builtin-edit-tree-tool
  const parsed = parseTreeEditInput(args, 'replace_node');
  if ('success' in parsed) return parsed;
  const replacementsIn = Array.isArray(args.replacements) ? args.replacements as { node_path?: unknown; fragment?: unknown }[] : undefined;
  if (args.replacements !== undefined && !replacementsIn) {
    return { result: 'replace_node: replacements 必须是 {node_path, fragment} 数组', success: false, content_type: 'text' };
  }
  const items: { nodePath: string; fragSteps: StepNode[] }[] = [];
  if (replacementsIn) {
    const seen = new Set<string>();
    for (const [ri, rp] of replacementsIn.entries()) {
      if (typeof rp.node_path !== 'string' || !rp.node_path) return { result: 'replace_node: replacements 各项需要 node_path', success: false, content_type: 'text' };
      if (seen.has(rp.node_path)) return { result: `replace_node: replacements 目标 '${rp.node_path}' 重复`, success: false, content_type: 'text' };
      seen.add(rp.node_path);
      const frag = parseTreeEditFragment(rp.fragment, 'replace_node', ri + 1, parsed);   // 逐项独立临时号——同批多片段互不撞
      if (!Array.isArray(frag)) return frag;
      items.push({ nodePath: rp.node_path, fragSteps: frag });
    }
  } else {
    const nodePath = typeof args.node_path === 'string' ? args.node_path : '';
    if (!nodePath) return { result: 'replace_node 需要 node_path（或 replacements 批量）', success: false, content_type: 'text' };
    const frag = parseTreeEditFragment(args.fragment, 'replace_node', 1, parsed);
    if (!Array.isArray(frag)) return frag;
    items.push({ nodePath, fragSteps: frag });
  }
  const r = replaceNodeAt(parsed.ast.steps as StepNode[], items);
  if (!r.ok) return { result: `replace_node: ${r.error}`, success: false, content_type: 'text' };
  return finishTreeEdit(parsed);
}

/** replace_children 工具执行体：整换容器子树（node_path 空=root 全量换）。 */
export function executeReplaceChildren(args: Record<string, unknown>): ToolResult { // @a: anc-exec-builtin-edit-tree-tool
  const parsed = parseTreeEditInput(args, 'replace_children');
  if ('success' in parsed) return parsed;
  const nodePath = typeof args.node_path === 'string' ? args.node_path : '';
  if (!nodePath) return { result: 'replace_children 需要 node_path', success: false, content_type: 'text' };
  const frag = parseTreeEditFragment(args.fragment, 'replace_children', 1, parsed);
  if (!Array.isArray(frag)) return frag;
  const r = replaceChildrenAt(parsed.ast.steps as StepNode[], nodePath, frag);
  if (!r.ok) return { result: `replace_children: ${r.error}`, success: false, content_type: 'text' };
  return finishTreeEdit(parsed);
}

/** renumber_steps 工具执行体：全树顺位重编号（编号权威独立成件,编辑函数不自动重编号）。 */
export function executeRenumberSteps(args: Record<string, unknown>): ToolResult { // @a: anc-exec-builtin-edit-tree-tool
  const parsed = parseTreeEditInput(args, 'renumber_steps');
  if ('success' in parsed) return parsed;
  return finishTreeEdit(parsed);
}


/** validate_spec 执行体（Provider 外的纯函数——不依赖 workspace/sandbox,便于测试直调）。
 * 逻辑与 CLI validate 同序：parse error 即返、规则分桶。见 [[tools/spec-tree-tools#^anc-exec-builtin-validate-tool]] */
export function executeValidateSpec(args: Record<string, unknown>): ToolResult { // @a: anc-exec-builtin-validate-tool
  const text = args.text;
  if (typeof text !== 'string') {
    return { result: 'validate_spec: text 参数必须是字符串（传内容本身,不是路径）', success: false, content_type: 'text' };
  }
  const fragment = args.fragment === true;
  if (args.fragment !== undefined && typeof args.fragment !== 'boolean') {
    return { result: 'validate_spec: fragment 参数必须是布尔', success: false, content_type: 'text' };
  }
  let knownVars: string[] = [];
  if (args.known_vars !== undefined) {
    if (!Array.isArray(args.known_vars) || args.known_vars.some(v => typeof v !== 'string')) {
      return { result: 'validate_spec: known_vars 参数必须是字符串数组', success: false, content_type: 'text' };
    }
    knownVars = args.known_vars as string[];
  }
  const { ast, errors: parseErrors } = fragment ? parseFragment(text) : parseSpec(text);
  if (parseErrors.length > 0) {
    return { result: JSON.stringify({ status: 'error', errors: parseErrors, warnings: [] }), success: true, content_type: 'json' };
  }
  const opts: FragmentOptions | undefined = fragment ? { fragment: true, knownVars } : undefined;
  const all = validateSpec(ast, undefined, opts);
  const errors = all.filter(e => e.severity === 'error');
  const warnings = all.filter(e => e.severity !== 'error');
  return {
    result: JSON.stringify({ status: errors.length > 0 ? 'error' : 'ok', errors, warnings }),
    success: true,
    content_type: 'json',
  };
}

/** ToolProvider 默认实现——内置十八件工具（十一件文件/目录+validate_spec+树编辑四件+read_spec_tree+run_script）,写侧按步骤语境分域（act/check 限 work_zone、commit 限 workspace）+读侧三级权限链。见 [[tools/file-tools#^anc-exec-builtin-file-tools]] */
export class DefaultToolProvider implements ToolProvider { // @a: anc-exec-tool-permission
  private workspaceDir: string;
  private sandbox: SandboxConfig;
  private language: 'en' | 'zh';   // 生成物语言（^anc-i18n-language-config——read_spec_tree node 档序列化按它出词） // @a: anc-i18n-serialize-lang

  constructor(hostConfig: HostConfig) {
    this.workspaceDir = resolveReal(hostConfig.workspace_dir);
    this.sandbox = hostConfig.sandbox;
    this.language = hostConfig.language ?? 'en';
  }

  list(): ToolDef[] {
    return [READ_TOOL, WRITE_TOOL, LIST_DIR_TOOL, FILE_EXISTS_TOOL, CREATE_TOOL, APPEND_TOOL, EDIT_FILE_TOOL, SEARCH_FILE_TOOL, MKDIR_TOOL, MOVE_TOOL, DELETE_TOOL, VALIDATE_SPEC_TOOL, INSERT_NODE_TOOL, REPLACE_NODE_TOOL, REPLACE_CHILDREN_TOOL, RENUMBER_STEPS_TOOL, READ_SPEC_TREE_TOOL, RUN_SCRIPT_TOOL];
  }

  // write_scope 缺省 'work_zone'——信号缺席按窄域拒,不静默放宽（分域条款 ^anc-exec-write-scope）
  async execute(tool_name: string, tool_args: Record<string, unknown>, write_scope: WriteScope = 'work_zone'): Promise<ToolResult> {
    try {
      // 实参名进闸核对（file-tools 实参名进闸条款,2026-09-16 决策——move(src:/dst:) 笔误
      // undefined 穿透 Node fs 报"path argument must be of type string"而 move 无 path 参,
      // 误导排查。未知参数名/缺必填按 input_schema 核,报文点名合法参数名集,走 ToolResult
      // 失败通道不抛。// @a: anc-exec-tool-arg-gate
      const def = this.list().find(t => t.name === tool_name);
      if (def?.input_schema) {
        const schema = def.input_schema as { properties?: Record<string, unknown>; required?: string[] };
        const legal = Object.keys(schema.properties ?? {});
        const unknown = Object.keys(tool_args).filter(k => !legal.includes(k));
        if (unknown.length > 0) {
          return { result: `工具 "${tool_name}" 没有参数 ${unknown.map(k => `"${k}"`).join('/')}——它的参数是 ${legal.join('/')}`, success: false, content_type: 'text' };
        }
        const missing = (schema.required ?? []).filter(k => tool_args[k] === undefined);
        if (missing.length > 0) {
          return { result: `工具 "${tool_name}" 缺必填参数 ${missing.map(k => `"${k}"`).join('/')}（参数全集 ${legal.join('/')}）`, success: false, content_type: 'text' };
        }
      }
      // keep 实参校验（^anc-exec-file-keep-recycle 参数条——与实参名进闸同一失败通道） // @a: anc-exec-file-keep-recycle
      let keep = DEFAULT_KEEP;
      if (tool_args.keep !== undefined) {
        if (typeof tool_args.keep !== 'number' || !Number.isInteger(tool_args.keep) || tool_args.keep < 0) {
          return { result: `工具 "${tool_name}" 的 keep 须是非负整数,实际: ${JSON.stringify(tool_args.keep)}`, success: false, content_type: 'text' };
        }
        keep = tool_args.keep;
      }
      switch (tool_name) {
        case 'read': return this.executeRead(tool_args.path as string, tool_args.start_line as number | undefined, tool_args.end_line as number | undefined);
        case 'write': return this.executeWrite(tool_args.path as string, contentToText(tool_args.content), write_scope, keep);
        case 'listdir': return this.executeListDir(tool_args.path as string);
        case 'exists': return this.executeFileExists(tool_args.path as string);
        case 'create': return this.executeCreate(tool_args.path as string, contentToText(tool_args.content), write_scope);
        case 'append': return this.executeAppend(tool_args.path as string, contentToText(tool_args.content), write_scope);
        case 'edit_file': return this.executeEditFile(tool_args.path as string, tool_args.old_text as string, tool_args.new_text as string, write_scope, keep);
        case 'search_file': return this.executeSearchFile(tool_args.path as string, tool_args.pattern as string, tool_args.context_lines as number | undefined);
        case 'makedirs': return this.executeMkdir(tool_args.path as string, write_scope);
        case 'move': return this.executeMove(tool_args.from as string, tool_args.to as string, write_scope, keep);
        case 'remove': return this.executeDelete(tool_args.path as string, write_scope, keep);
        case 'validate_spec': return executeValidateSpec(tool_args);   // 纯函数,无路径校验链 // @a: anc-exec-builtin-validate-tool
        case 'insert_node': return executeInsertNode(tool_args);        // 纯函数,树编辑四件 // @a: anc-exec-builtin-edit-tree-tool
        case 'replace_node': return executeReplaceNode(tool_args);
        case 'replace_children': return executeReplaceChildren(tool_args);
        case 'renumber_steps': return executeRenumberSteps(tool_args);
        case 'read_spec_tree': return executeReadSpecTree(tool_args, this.language);   // 纯函数,读面对偶:骨干/子树两档;node/skeleton 档按项目语言出词（^anc-i18n-language-config） // @a: anc-exec-builtin-read-tree-tool
        case 'run_script': return this.executeRunScript(tool_args.path as string, tool_args.args);   // 受控脚本执行（^anc-exec-builtin-run-script） // @a: anc-exec-builtin-run-script
        default: return { result: `Unknown tool: ${tool_name}`, success: false, content_type: 'text' };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: msg, success: false, content_type: 'text' };
    }
  }

  // read 行号段扩参（2026-09-06 todo/0070——两参均缺=全文存量零回归;行号 1 起与 D76 编号版同口径;
  // start 越界报错带总行数(宁拒不猜)/end 越界截尾(读到尾是自然语义)。契约 [[tools/file-tools#^anc-exec-builtin-search-file]]）
  // @a: anc-exec-builtin-search-file
  private executeRead(filePath: string, startLine?: number, endLine?: number): ToolResult {
    const resolved = this.resolvePath(filePath, 'read');
    this.validateFileAccess(resolved, 'read');
    const content = readFileSync(resolved, 'utf-8');
    if (startLine === undefined && endLine === undefined) {
      return { result: content, success: true, content_type: 'text' };   // 存量路径:扩参前逐字节一致
    }
    const allLines = content.split('\n');
    const total = allLines.length;
    const start = startLine ?? 1;
    if (!Number.isInteger(start) || start < 1) {
      return { result: `start_line 须为 1 起整数,实际: ${String(startLine)}`, success: false, content_type: 'text' };
    }
    if (start > total) {
      return { result: `start_line ${start} 超出文件总行数 ${total}（${filePath}）`, success: false, content_type: 'text' };
    }
    const end = endLine === undefined ? total : endLine;
    if (!Number.isInteger(end) || end < 1) {
      return { result: `end_line 须为 1 起整数,实际: ${String(endLine)}`, success: false, content_type: 'text' };
    }
    if (start > end) {
      return { result: `无效区间: start_line ${start} > end_line ${end}`, success: false, content_type: 'text' };
    }
    const seg = allLines.slice(start - 1, Math.min(end, total)).join('\n');
    return { result: seg, success: true, content_type: 'text' };
  }

  // search_file 单文件子串搜索（2026-09-06 todo/0070——纯子串非正则,零命中空清单探测语义同 exists,
  // pattern 禁空串同 edit_file 哲学。契约 [[tools/file-tools#^anc-exec-builtin-search-file]]）
  // @a: anc-exec-builtin-search-file
  private executeSearchFile(filePath: string, pattern: string, contextLines?: number): ToolResult {
    if (!pattern) {
      return { result: 'pattern 不可为空', success: false, content_type: 'text' };
    }
    const resolved = this.resolvePath(filePath, 'read');
    this.validateFileAccess(resolved, 'read');
    const allLines = readFileSync(resolved, 'utf-8').split('\n');
    const ctx = contextLines ?? 0;
    const hits: Array<{ line: number; text: string; context?: string }> = [];
    for (let i = 0; i < allLines.length; i++) {
      if (allLines[i].includes(pattern)) {
        const hit: { line: number; text: string; context?: string } = { line: i + 1, text: allLines[i] };
        if (ctx > 0) {
          const from = Math.max(0, i - ctx);
          const to = Math.min(allLines.length, i + ctx + 1);
          hit.context = allLines.slice(from, to).join('\n');
        }
        hits.push(hit);
      }
    }
    return { result: JSON.stringify(hits), success: true, content_type: 'json' };
  }

  // 写入类三件（write/create/append）与 move 目标侧的父目录缺失报文（hopissues/0120,设计
  // [[tools/file-tools#^anc-exec-write-parent-missing]]）：ENOENT 且 dirname 不存在才改写——
  // 指路 makedirs 不代建（makedirs 是显式原语,commit 里不藏隐式动作）;父目录在场的 ENOENT 原文照回。
  // @a: anc-exec-write-parent-missing
  private withParentDirHint<T>(resolved: string, fn: () => T): T {
    try {
      return fn();
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const parent = dirname(resolved);
      if (code === 'ENOENT' && !existsSync(parent)) {
        const raw = err instanceof Error ? err.message : String(err);
        throw new Error(`父目录 ${parent} 不存在,请先 makedirs 或改用已存在目录（原始错误：${raw}）`);
      }
      throw err;
    }
  }

  private executeWrite(filePath: string, content: string, scope: WriteScope, keep: number = DEFAULT_KEEP): ToolResult {
    const resolved = this.resolvePath(filePath);
    this.validateFileAccess(resolved, 'write', scope);
    const existed = existsSync(resolved);
    const note = this.retainBeforeChange(resolved, keep);   // @a: anc-exec-file-keep-recycle
    this.withParentDirHint(resolved, () => writeFileSync(resolved, content, 'utf-8'));
    if (!existed || keep === 0) this.noteLedger(resolved, { created: true });
    return { result: `Written ${content.length} bytes to ${filePath}${note ? ' ' + note : ''}`, success: true, content_type: 'text' };
  }

  // ── 内置文件/目录工具组（2026-08-10 实装，契约与流程见 [[tools/file-tools#^anc-exec-builtin-file-tools]]）──
  // @a: anc-exec-builtin-file-tools

  private executeListDir(dirPath: string): ToolResult {
    const resolved = this.resolvePath(dirPath, 'read');
    this.validateFileAccess(resolved, 'read');
    const entries = readdirSync(resolved).map(name => {
      const st = statSync(resolve(resolved, name));
      const t = st.isDirectory() ? 'dir' : 'file';
      return { name, type: t, kind: t };   // type=正名(行业惯例),kind=兼容别名(2026-09-07 作者拍——R9 实撞 e.type 缺键恒假) // @a: anc-exec-builtin-file-tools
    });
    // 空目录语义明示（2026-09-18 作者对 Qwen 复读循环追问"listdir 符合常见 tool 行为么"后定——
    // 裸 [] 对弱模型是哑数据:与"没返回"难区分,不构成换路信号,实撞连续 14 轮重扫同一空目录）。
    // 明示语走 hint 旁路,result 恒为纯 []——修前把注记拼进 result,content_type 仍标 json,parse_json
    // 与 call 位 JSON.parse 都炸（2026-10-12 语义审计 #25 作者拍甲案）。// @a: anc-exec-builtin-file-tools
    if (entries.length === 0) {
      return { result: '[]', success: true, content_type: 'json', hint: '（目录存在但为空——没有任何文件或子目录。重复查询同一目录不会得到不同结果；若在找输入材料，本步所需输入已在提示词的"本步输入材料"段给出。）' };
    }
    return { result: JSON.stringify(entries), success: true, content_type: 'json' };
  }

  private executeFileExists(filePath: string): ToolResult {
    const resolved = this.resolvePath(filePath, 'read');
    this.validateFileAccess(resolved, 'read');
    // 探测语义：不存在不报错，返回 false
    if (!existsSync(resolved)) {
      return { result: JSON.stringify({ exists: false, type: 'none', kind: 'none' }), success: true, content_type: 'json' };   // type 正名+kind 兼容(2026-09-07) // @a: anc-exec-builtin-file-tools
    }
    const st = statSync(resolved);
    const t2 = st.isDirectory() ? 'dir' : 'file';
    return { result: JSON.stringify({ exists: true, type: t2, kind: t2 }), success: true, content_type: 'json' };
  }

  private executeCreate(filePath: string, content: string, scope: WriteScope): ToolResult {
    const resolved = this.resolvePath(filePath);
    this.validateFileAccess(resolved, 'write', scope);
    // 'wx' 排他标志——检查+创建一步完成（OS 原子语义透传，无 TOCTOU 窗口）；已存在即 EEXIST
    this.withParentDirHint(resolved, () => writeFileSync(resolved, content, { encoding: 'utf-8', flag: 'wx' }));
    this.noteLedger(resolved, { created: true });   // @a: anc-exec-file-keep-recycle
    return { result: `Created ${filePath} (${content.length} bytes)`, success: true, content_type: 'text' };
  }

  private executeAppend(filePath: string, content: string, scope: WriteScope): ToolResult {
    const resolved = this.resolvePath(filePath);
    this.validateFileAccess(resolved, 'write', scope);
    const existed = existsSync(resolved);
    this.withParentDirHint(resolved, () => appendFileSync(resolved, content, 'utf-8'));
    if (!existed) this.noteLedger(resolved, { created: true });   // @a: anc-exec-file-keep-recycle
    return { result: `Appended ${content.length} bytes to ${filePath}`, success: true, content_type: 'text' };
  }

  // edit_file 局部精确替换（HopSop 六步照 [[tools/file-tools#^anc-exec-builtin-edit-file-tool]]）：
  // old_text 恰匹配一处才替换，零匹配/多匹配报错带计数——宁拒不猜，调用方补上下文重试。
  // @a: anc-exec-builtin-edit-file-tool
  private executeEditFile(filePath: string, oldText: string, newText: string, scope: WriteScope, keep: number = DEFAULT_KEEP): ToolResult {
    if (oldText === '') {
      return { result: 'old_text 不可为空', success: false, content_type: 'text' };
    }
    const resolved = this.resolvePath(filePath);
    this.validateFileAccess(resolved, 'write', scope);   // 与 executeWrite 同链同序
    if (!existsSync(resolved)) {
      return { result: `文件不存在:${filePath}`, success: false, content_type: 'text' };
    }
    const content = readFileSync(resolved, 'utf-8');
    const n = content.split(oldText).length - 1;
    if (n === 0) {
      // 零匹配附最接近行：凭记忆写 old_text 的调用方看不出错在哪（hb2 qwen-flash 修错步十几轮零匹配实撞），
      // 给出文件原文让下一次照抄——仍拒绝不自动纠正（宁拒不猜）
      const near = nearestLines(content, oldText);
      const hint = near.length
        ? `。文件里最接近的行（old_text 须逐字照抄原文,含行首空格与 # 号）: ${near.map(l => `第 ${l.line} 行 ${JSON.stringify(l.text)}`).join('; ')}`
        : '';
      return { result: `未找到匹配（old_text 头 80 字符:${oldText.slice(0, 80)}）${hint}`, success: false, content_type: 'text' };
    }
    if (n >= 2) {
      return { result: `匹配 ${n} 处,请提供更长的唯一上下文`, success: false, content_type: 'text' };
    }
    const offset = content.indexOf(oldText);
    // 按偏移拼接而非 String.replace——replace 会解释 new_text 里的 $ 特殊模式（$& 等），字面替换语义禁此通道
    const note = this.retainBeforeChange(resolved, keep);   // @a: anc-exec-file-keep-recycle
    writeFileSync(resolved, content.slice(0, offset) + newText + content.slice(offset + oldText.length), 'utf-8');
    if (keep === 0) this.noteLedger(resolved, { created: true });
    return { result: `Replaced 1 occurrence at char ${offset} in ${filePath}${note ? ' ' + note : ''}`, success: true, content_type: 'text' };
  }

  private executeMkdir(dirPath: string, scope: WriteScope): ToolResult {
    const resolved = this.resolvePath(dirPath);
    this.validateFileAccess(resolved, 'write', scope);
    mkdirSync(resolved, { recursive: true });   // 已存在即成功（幂等）
    return { result: `Directory ready: ${dirPath}`, success: true, content_type: 'text' };
  }

  private executeMove(fromPath: string, toPath: string, scope: WriteScope, keep: number = DEFAULT_KEEP): ToolResult {
    const from = this.resolvePath(fromPath);
    const to = this.resolvePath(toPath);
    this.validateFileAccess(from, 'write', scope);   // move 的源与目标都过写侧校验
    this.validateFileAccess(to, 'write', scope);
    // 目标父目录缺失同走指路报文（^anc-exec-write-parent-missing move 侧——源在场而 rename ENOENT 且 dirname(to) 不存在;
    // 源不在场的 ENOENT 是源的问题,原文照回）。// @a: anc-exec-write-parent-missing
    // 目标侧已有文件会被 rename 替换——先留存;源侧内容原样到了目标,不留存（^anc-exec-file-keep-recycle 触发条件）
    const note = existsSync(from) ? this.retainBeforeChange(to, keep) : '';   // @a: anc-exec-file-keep-recycle
    const fromEntry = this.readLedger()[this.ledgerKey(from)] ?? null;   // rename 之前取——之后源路径已不存在
    if (existsSync(from)) this.withParentDirHint(to, () => renameSync(from, to));
    else renameSync(from, to);   // rename 原子性透传（同文件系统内原子替换）
    // 接管账：B 现在装的是 A 的内容——B 的记录换成 A 的记录,A 的记录删除
    this.noteLedger(to, fromEntry);
    this.noteLedger(from, null);
    return { result: `Moved ${fromPath} → ${toPath}${note ? ' ' + note : ''}`, success: true, content_type: 'text' };
  }

  private executeDelete(filePath: string, scope: WriteScope, keep: number = DEFAULT_KEEP): ToolResult {
    const resolved = this.resolvePath(filePath);
    this.validateFileAccess(resolved, 'write', scope);
    const note = this.retainBeforeChange(resolved, keep);   // @a: anc-exec-file-keep-recycle
    unlinkSync(resolved);   // 不存在即 ENOENT（显式失败不静默）；仅文件——目录不删（最重操作不进 v1）
    return { result: `Deleted ${filePath}${note ? ' ' + note : ''}`, success: true, content_type: 'text' };
  }

  // ── 覆盖与删除前留存旧版本（HopSop 照 [[tools/file-tools#^anc-exec-file-keep-recycle]]）──
  // @a: anc-exec-file-keep-recycle
  private recycleTree: string | undefined;                          // setWorkZoneScope 推来的 tree 原样（本 run 顶层实例目录）
  private memoryLedger = new Map<string, RecycleLedgerEntry>();     // tree 缺席时的内存接管账,键=目标真实路径

  private ledgerKey(target: string): string {
    try { return resolveRealDeep(target); } catch { return normalize(target); }
  }

  private readLedger(): Record<string, RecycleLedgerEntry> {
    if (!this.recycleTree) return Object.fromEntries(this.memoryLedger);
    const file = join(this.recycleTree, RECYCLE_LEDGER_FILE);
    if (!existsSync(file)) return {};
    try {
      const v = JSON.parse(readFileSync(file, 'utf-8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, RecycleLedgerEntry> : {};
    } catch { return {}; }   // 账坏了按空账处理——后果是多留存一份,不丢内容
  }

  /** 按接管账更新规则写账;entry=null 删除该键。每次重读——复用模式其他进程可能刚写过 */
  private noteLedger(target: string, entry: RecycleLedgerEntry | null): void {
    const key = this.ledgerKey(target);
    if (this.isReadableWorkZone(key)) return;   // work_zone 不留存,也不入账——涂鸦区写入不该把账撑大
    if (!this.recycleTree) {
      if (entry) this.memoryLedger.set(key, entry); else this.memoryLedger.delete(key);
      return;
    }
    const ledger = this.readLedger();
    if (entry) ledger[key] = entry; else delete ledger[key];
    const file = join(this.recycleTree, RECYCLE_LEDGER_FILE);
    const tmp = `${file}.tmp-${process.pid}`;
    mkdirSync(this.recycleTree, { recursive: true });
    writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf-8');
    renameSync(tmp, file);   // 写临时文件再 rename——原子替换
  }

  /** target=已过写侧校验的宿主机绝对路径;返回拼进回执的说明;留存失败抛错（原语不执行） */
  private retainBeforeChange(target: string, keep: number): string {
    let st;
    try { st = statSync(target); } catch { return ''; }   // 不存在——没有内容要销毁
    if (!st.isFile()) return '';
    const key = this.ledgerKey(target);
    if (this.isReadableWorkZone(key)) return '';   // work_zone 豁免——涂鸦区可整体重建
    const known = this.readLedger()[key];
    if (known) return 'copy' in known ? `本次运行开始前的版本已存于 ${known.copy}` : '';
    if (keep === 0) { this.noteLedger(key, { created: true }); return ''; }
    const root = this.recycleTree ? join(dirname(this.recycleTree), RECYCLE_DIR_NAME) : join(tmpdir(), 'hopjit-recycle');
    const ws = this.workspaceDir;
    const rel = isWithinDir(key, ws) ? relative(ws, key) : join('_external', key.replace(/^[\\/]+/, '').replace(/^[A-Za-z]:[\\/]*/, ''));
    const base = join(root, rel) + '.' + recycleStamp(new Date());
    // 同一秒已有留存件:序号取现有最大值加 1,不复用轮转删出的空位（复用会让新件排在旧件前面被紧接着的轮转删掉）
    let maxSeq = 0;
    try {
      const prefix = basename(base);
      for (const f of readdirSync(dirname(base))) {
        if (f === prefix) maxSeq = Math.max(maxSeq, 1);
        else if (f.startsWith(prefix + '-') && /^\d+$/.test(f.slice(prefix.length + 1))) maxSeq = Math.max(maxSeq, Number(f.slice(prefix.length + 1)));
      }
    } catch { /* 目录还不存在 */ }
    const copyPath = maxSeq === 0 ? base : `${base}-${maxSeq + 1}`;
    try {
      mkdirSync(dirname(copyPath), { recursive: true });
      copyFileSync(target, copyPath);
    } catch (err: unknown) {
      throw new Error(`旧版本留存失败,没有覆盖/删除：${err instanceof Error ? err.message : String(err)}`);
    }
    this.noteLedger(key, { copy: copyPath });
    // 轮转：只删匹配 <原文件名>.<8位>-<6位>(-n) 形态的件——回收站在 .hopstate 内,用户工具写不进来
    let extra = '';
    try {
      const dir = dirname(copyPath);
      const name = basename(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${name}\\.(\\d{8}-\\d{6})(?:-(\\d+))?$`);
      // 按（时间戳,序号数值）排序——字符串排序会把 -10 排到 -2 前面
      const copies = readdirSync(dir).map(f => ({ f, m: re.exec(f) })).filter(x => x.m)
        .map(x => ({ f: x.f, ts: x.m![1]!, seq: x.m![2] ? Number(x.m![2]) : 1 }))
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq));
      const self = basename(copyPath);
      for (const old of copies.slice(0, Math.max(0, copies.length - keep))) if (old.f !== self) unlinkSync(join(dir, old.f));
    } catch (err: unknown) {
      extra = `;清理旧留存件失败：${err instanceof Error ? err.message : String(err)}`;
    }
    return `旧版本已存到 ${copyPath}（该文件在回收站最多保留 ${keep} 份）${extra}`;
  }

  // run_script 受控脚本执行（HopSop 六步在 [[tools/run-script#关键逻辑]]）：扩展名定解释器 →
  // 读权限链 → 文件在场 → args 归一 → Python 语法沙箱审查并执行 → 结果归一。
  // **非零退出码照样 success: true**——校验脚本对违规样例本就该返回 1,报成工具失败会把模型
  // 重新推回"找别的执行入口"的死路（0110 缘起实撞形态,契约点名这是最要命的实现错误）。
  // @a: anc-exec-builtin-run-script
  private executeRunScript(scriptPath: string, rawArgs: unknown): ToolResult {
    const fail = (msg: string): ToolResult => ({ result: msg, success: false, content_type: 'text' });
    // ① 扩展名定解释器——模型不供给命令（^anc-exec-run-script-no-command-choice）
    const dot = scriptPath.lastIndexOf('.');
    const ext = dot > 0 ? scriptPath.slice(dot).toLowerCase() : '';
    const supported = Object.keys(SCRIPT_INTERPRETERS).join('/');
    if (ext === '.sh') {
      // .sh 专项报文:它是最可能被试的那个,给理由而不是干巴巴一句不支持
      return fail(`run_script 不支持 shell 脚本——shell 语义下脚本内容就是任意命令,命令白名单形同虚设。把要做的事写成 .py 脚本再跑（当前支持: ${supported}）`);
    }
    const cmd = SCRIPT_INTERPRETERS[ext];
    if (!cmd) {
      return fail(`run_script 不支持的脚本类型 "${ext || '(无扩展名)'}"——当前支持: ${supported}`);
    }
    // ② 路径解析与读权限（与 read 同链同序——"能执行"的前提是"能读到"）
    const resolved = this.resolvePath(scriptPath);
    this.validateFileAccess(resolved, 'read');
    // ③ 文件在场——执行语义预设脚本已写好（与 edit_file"目标不存在即报错"同款,不静默当空脚本跑）
    if (!existsSync(resolved)) {
      return fail(`run_script: 脚本文件不存在: ${scriptPath}——先把脚本写出来再跑`);
    }
    // ④ args 归一:必须是列表,元素逐个 String() 归一
    let args: string[] = [];
    if (rawArgs !== undefined) {
      if (!Array.isArray(rawArgs)) {
        return fail('run_script: args 须是字符串列表（每项一个参数,不是一整串待拆的命令行）');
      }
      args = rawArgs.map(v => String(v));
    }
    // ⑤ Python 语法沙箱——审的字节就是跑的字节,审过才执行,系统沙箱在场即套上（^anc-pysb-exec）。
    // 检查器与产物都经命令执行原语发出:白名单核在检查器 spawn 之前,白名单两拒报文不变。
    // 原语抛出的指路报文经工具结果通道回执行方（execute 的 catch 折 ToolResult），不炸步。
    const r = runSandboxedPython(resolved, args, {
      interpreter: cmd,
      whitelist: this.sandbox.runtime?.available,
      timeoutSec: 60,
      maxBuffer: 64 * 1024,     // 工具面消费者是模型的上下文窗口（body 面 10MB 的理由见契约"输出限额"）
    });   // 工作目录=脚本所在目录（工具面拿不到本实例 work_zone,理由见契约"工作目录为什么是脚本所在目录"）
    // ⑥ 结果归一——被拒是模型可改的失败,报文逐条带替代写法;跑起来了就是 success,退出码是值
    if (r.status === 'rejected') return fail(r.message);
    return {
      result: JSON.stringify({ returncode: r.returncode, stdout: r.stdout, stderr: r.stderr, defense: r.defense }),
      success: true,
      content_type: 'json',
    };
  }

  // work_zone 豁免读写分权（^anc-exec-work-zone-registry;todo/0124 按 run 登记 → todo/0126 作者定"可以读,但不应该能写"）：
  // 写只认当前执行实例的 work_zone（own——standalone 父子兄弟共用本提供者,"谁在写"只能用 engine 每次 getWorkZone 推来的
  // 时序信号表达,不能用集合）;读认本 run 顶层实例目录（tree）内任意 work_zone 段（按目录布局判,祖先/兄弟/后代一网打尽,
  // 后代动态创建枚举必滞后）,readableRoots 只作 tree 缺席（MemoryPersistence）的兜底。各存原始+真实两形态——
  // resolvePath 吃 work_zone_path() 原始产物,validateFileAccess 吃真实路径（0066 probe 实证只认一种另一点失配）。
  // @a: anc-exec-work-zone-registry
  private readableRoots = new Set<string>();
  private ownRoots = new Set<string>();
  private treeRoots = new Set<string>();
  private static bothForms(p: string): string[] {
    const out = [normalize(p)];
    // 真实形态解析失败（软链超限/成环）只留原始形态——登记在响应组装点被调,抛错会炸整个响应;少一形态只是它不豁免（todo/0125 条目 2）
    try { out.push(resolveRealDeep(p)); } catch { /* 病态 state-dir 软链 */ }
    return out;
  }
  registerWorkZoneRoot(root: string): void {
    if (!root) return;
    for (const f of DefaultToolProvider.bothForms(root)) this.readableRoots.add(f);
  }
  setWorkZoneScope(scope: { own: string; tree?: string }): void {
    this.ownRoots = new Set(scope.own ? DefaultToolProvider.bothForms(scope.own) : []);
    this.treeRoots = new Set(scope.tree ? DefaultToolProvider.bothForms(scope.tree) : []);
    this.recycleTree = scope.tree || undefined;   // 回收站与接管账锚本 run 顶层实例目录 // @a: anc-exec-file-keep-recycle
  }
  private isOwnWorkZone(p: string): boolean {
    for (const root of this.ownRoots) if (isWithinDir(p, root)) return true;
    return false;
  }
  private isReadableWorkZone(p: string): boolean {
    if (this.isOwnWorkZone(p)) return true;
    for (const root of this.treeRoots) {
      if (!isWithinDir(p, root)) continue;
      // 相对 tree 的路径按分隔符切段,须含整段 work_zone（work_zonefake 不算;实例目录下的 state.json/vars.json 不算）
      const rel = p === root ? '' : p.slice(root.endsWith(sep) ? root.length : root.length + 1);
      if (rel.split(sep).includes('work_zone')) return true;
    }
    for (const root of this.readableRoots) if (isWithinDir(p, root)) return true;
    return false;
  }

  private resolvePath(filePath: string, mode: 'strict' | 'read' = 'strict'): string {
    // 本 run 涂鸦区绝对路径放行（work_zone_path() 的产物,work_zone 可在 workspace 外）——其余绝对路径
    // 交 resolveWorkspacePath 判落区（workspace 内认,外拒）// @a: anc-exec-work-zone-registry
    if (isAbsolute(filePath) && !filePath.includes('..') && this.isReadableWorkZone(normalize(filePath))) return filePath;
    // read 档：落在 read_access.allowed 某目录内的绝对路径放行（起跑把 spec 所在目录加进 allowed,spec_dir() 产物由此能读——
    // 一条读授权覆盖 knowledge/数据样例/将来的 inner_store,作者 2026-10-07 定;写类与 run_script 走 strict 不认此形态;
    // 放行后 validateFileAccess('read') 仍过 denied/confirm_required 链）。design tools/file-tools ^anc-exec-tool-path-resolve 第④形态
    // @a: anc-exec-tool-path-resolve
    if (mode === 'read' && isAbsolute(filePath) && !filePath.includes('..')) {
      const p = normalize(filePath);
      for (const allowed of this.sandbox.filesystem.read_access.allowed) {
        const root = resolve(allowed);
        if (isWithinDir(p, root) || isWithinDir(resolveRealDeep(p), resolveReal(root))) return p;
      }
    }
    // strict 档第⑤形态（todo/0148,design tools/file-tools ^anc-exec-tool-path-resolve）：落在 write_access.allowed 某目录内的绝对路径放行
    //（spec Config.dirs.readwrite 声明并经人批准）——随后 validateFileAccess('write', scope) 分域：act/check 仍 WORK_ZONE_ONLY,commit 放行;
    // read 档已由 readwrite 并入 read_access.allowed 覆盖,此处只补写类。// @a: anc-exec-dirs-grant
    if (mode === 'strict' && isAbsolute(filePath) && !filePath.includes('..')) {
      const p = normalize(filePath);
      for (const allowed of this.sandbox.filesystem.write_access?.allowed ?? []) {
        const root = resolve(allowed);
        if (isWithinDir(p, root) || isWithinDir(resolveRealDeep(p), resolveReal(root))) return p;
      }
    }
    return resolveWorkspacePath(this.workspaceDir, filePath);
  }

  private validateFileAccess(resolvedPath: string, operation: 'read' | 'write', scope: WriteScope = 'work_zone'): void {
    const realPath = resolveRealDeep(resolvedPath);   // 目标不存在也解析父目录软链 // @a: anc-exec-tool-path-resolve
    // 涂鸦区豁免读写分权（todo/0126）：读认本 run 实例树内任意 work_zone;写只认当前实例自己的。// @a: anc-exec-work-zone-registry
    if (operation === 'read' ? this.isReadableWorkZone(realPath) : this.isOwnWorkZone(realPath)) return;
    if (operation === 'write') {
      // 写侧分域（2026-08-28 作者定,契约 [[tools/file-tools#^anc-exec-builtin-file-tools]]）：act/check
      // 语境（'work_zone'）写域=仅 work_zone——探索段写的都是中间产物,散落 workspace 会被
      // 后续步/并行兄弟 read 到（自污染）;commit 语境（'workspace'）才可写全域（交付写盘）。
      // @a: anc-exec-write-scope
      if (scope === 'work_zone') {
        throw new Error(`WORK_ZONE_ONLY: act/check 步骤的写域限 work_zone 涂鸦区（中间产物用 work_zone_path() 取路径）——持久产物写盘归 [commit] 步骤承载: ${realPath}`);
      }
      const wsDir = resolveReal(resolve(this.sandbox.filesystem.workspace_dir));
      // commit 写域 = workspace ∪ write_access.allowed（Config.dirs.readwrite 经授权,真实路径判带分隔符边界——与 workspace 同判据）
      // @a: anc-exec-dirs-grant
      const inWriteAllowed = (this.sandbox.filesystem.write_access?.allowed ?? []).some(d => isWithinDir(realPath, resolveReal(resolve(d))));
      if (!isWithinDir(realPath, wsDir) && !inWriteAllowed) {
        throw new Error(`Write outside workspace sandbox: ${realPath}（commit 写域=workspace 根 ${wsDir}${this.sandbox.filesystem.write_access?.allowed?.length ? ' ∪ Config.dirs.readwrite ' + this.sandbox.filesystem.write_access.allowed.join(', ') : ''}）`);
      }
      if (realPath.includes('.hopstate')) {
        throw new Error('Write to .hopstate/ is forbidden');
      }
      return;
    }
    validateReadAccess(this.sandbox, resolvedPath);
  }
}
