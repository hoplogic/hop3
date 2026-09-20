// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: tools ^anc-struct-tools
import { readFileSync, writeFileSync, appendFileSync, realpathSync, readdirSync, statSync, mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { ToolProvider, ToolDef, ToolResult, HostConfig, SandboxConfig, WriteScope } from './provider-types.js';
import { parseSpec, parseFragment, serializeFragment } from './parser.js';
import { insertNodeAt, replaceNodeAt, replaceChildrenAt, renumberSteps, syncWorkItems } from './spec-tree-edit.js';
import type { StepNode } from './ast-types.js';
import { validateSpec, type FragmentOptions } from './validator.js';
import { dump as yamlDump } from 'js-yaml';

/** 写侧工具 content 归一为文本：结构值（yaml 型变量直传）序列化为 YAML 文本落盘——概念
 * ^anc-type-yaml-structured 落盘条款（原 as string 裸断言,结构进来 writeFileSync 抛
 * TypeError 炸穿,三十六审探针实抓）;字符串原样;其余标量 String。// @a: anc-type-yaml-structured */
function contentToText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return yamlDump(v).trimEnd() + '\n';
  return String(v);
}

function resolveReal(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

// work_zone 路径判定：.hopstate/<instance>/work_zone/ 是引擎划定的实例涂鸦区——
// work_zone_path() 返回其绝对路径，读写工具对它放行（.hopstate 禁令与绝对路径禁令的唯一豁免）。
// 见 ^anc-exec-work-zone。// @a: anc-exec-work-zone
// .hopstate 内任意深度的 work_zone 段（子实例三段路径 .hopstate/<父>/parallel|calls/<cid>/work_zone/——
// 2026-08-30 审计实抓 [^/]+ 单段致 standalone 子实例写自身 work_zone 误拒）。// @a: anc-exec-work-zone
const WORK_ZONE_RE = /(^|\/)\.hopstate\/.+?\/work_zone(\/|$)|\/hopjit-workzone-[^/]+(\/|$)/;
// 判定第三支:注册根前缀（0066——state-dir 名不含 .hopstate 字面时前两支全不中,work_zone_path()
// 产物被自家绝对路径禁令拒。发出侧〔persistence getWorkZone〕是事实源,创建/取用时注册真实根,
// 判定不再只靠字面名猜;前两支保留存量兼容〔跨进程场景注册未发生时惯例名仍通〕）。// @a: anc-exec-work-zone
const REGISTERED_WORK_ZONE_ROOTS = new Set<string>();
/** work_zone 真实根注册——persistence 发出 work_zone 路径时登记（根须已过 resolveReal,与判定侧 realpath 同基准）。见 [[tools/file-tools#^anc-exec-write-scope]] */
export function registerWorkZoneRoot(root: string): void { if (root) REGISTERED_WORK_ZONE_ROOTS.add(root); }
/** work_zone 涂鸦区路径判定——.hopstate 禁令与绝对路径禁令的唯一豁免（消费方=本文件写侧校验;export 供测试判据复用）。三支:字面正则两形态+注册根前缀。见 [[exec-engine#^anc-exec-work-zone]] */
export function isWorkZonePath(p: string): boolean {
  if (WORK_ZONE_RE.test(p)) return true;
  for (const root of REGISTERED_WORK_ZONE_ROOTS) {
    if (p === root || p.startsWith(root + '/')) return true;
  }
  return false;
}

// 解析 workspace 相对路径（禁绝对路径 / `..`）。复用于 DefaultToolProvider 与 doc-ref。
// @a: anc-exec-tool-permission
export function resolveWorkspacePath(workspaceDir: string, filePath: string): string {
  if (isAbsolute(filePath)) {
    throw new Error(`Absolute paths are forbidden: ${filePath}`);
  }
  if (filePath.includes('..')) {
    throw new Error(`Path traversal (..) is forbidden: ${filePath}`);
  }
  return resolve(workspaceDir, filePath);
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
  const realPath = resolveReal(resolvedPath);
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
  if (realPath.startsWith(wsDir)) return;
  for (const allowed of fs.read_access.allowed) {
    const allowedReal = resolveReal(resolve(allowed));
    if (realPath.startsWith(allowedReal)) return;
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

const WRITE_TOOL: ToolDef = {
  name: 'write',
  description: 'Write content to a file (create or overwrite).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to write' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "写入回执一句话（文本,如 'Written N bytes to <path>'）",
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
    },
    required: ['path', 'old_text', 'new_text'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "替换回执一句话（文本,含替换处字节偏移,如 'Replaced 1 occurrence at byte N in <path>'）",
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
    },
    required: ['from', 'to'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "移动回执一句话（文本）;源不存在则失败",
};

const DELETE_TOOL: ToolDef = {
  name: 'remove',
  description: 'Delete a file (fails if it does not exist).',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path of the file to delete' } },
    required: ['path'],
  },
  requires_commit: false,
  category: 'basic',   // 文件读写族恒 basic（0054——零声明可用）
  returns: "删除回执一句话（文本）;目标不存在则失败",
};

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

/** ToolProvider 默认实现——内置十六件工具（十件文件/目录+validate_spec+树编辑四件+read_spec_tree）,写侧按步骤语境分域（act/check 限 work_zone、commit 限 workspace）+读侧三级权限链。见 [[tools/file-tools#^anc-exec-builtin-file-tools]] */
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
    return [READ_TOOL, WRITE_TOOL, LIST_DIR_TOOL, FILE_EXISTS_TOOL, CREATE_TOOL, APPEND_TOOL, EDIT_FILE_TOOL, SEARCH_FILE_TOOL, MKDIR_TOOL, MOVE_TOOL, DELETE_TOOL, VALIDATE_SPEC_TOOL, INSERT_NODE_TOOL, REPLACE_NODE_TOOL, REPLACE_CHILDREN_TOOL, RENUMBER_STEPS_TOOL, READ_SPEC_TREE_TOOL];
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
      switch (tool_name) {
        case 'read': return this.executeRead(tool_args.path as string, tool_args.start_line as number | undefined, tool_args.end_line as number | undefined);
        case 'write': return this.executeWrite(tool_args.path as string, contentToText(tool_args.content), write_scope);
        case 'listdir': return this.executeListDir(tool_args.path as string);
        case 'exists': return this.executeFileExists(tool_args.path as string);
        case 'create': return this.executeCreate(tool_args.path as string, contentToText(tool_args.content), write_scope);
        case 'append': return this.executeAppend(tool_args.path as string, contentToText(tool_args.content), write_scope);
        case 'edit_file': return this.executeEditFile(tool_args.path as string, tool_args.old_text as string, tool_args.new_text as string, write_scope);
        case 'search_file': return this.executeSearchFile(tool_args.path as string, tool_args.pattern as string, tool_args.context_lines as number | undefined);
        case 'makedirs': return this.executeMkdir(tool_args.path as string, write_scope);
        case 'move': return this.executeMove(tool_args.from as string, tool_args.to as string, write_scope);
        case 'remove': return this.executeDelete(tool_args.path as string, write_scope);
        case 'validate_spec': return executeValidateSpec(tool_args);   // 纯函数,无路径校验链 // @a: anc-exec-builtin-validate-tool
        case 'insert_node': return executeInsertNode(tool_args);        // 纯函数,树编辑四件 // @a: anc-exec-builtin-edit-tree-tool
        case 'replace_node': return executeReplaceNode(tool_args);
        case 'replace_children': return executeReplaceChildren(tool_args);
        case 'renumber_steps': return executeRenumberSteps(tool_args);
        case 'read_spec_tree': return executeReadSpecTree(tool_args, this.language);   // 纯函数,读面对偶:骨干/子树两档;node/skeleton 档按项目语言出词（^anc-i18n-language-config） // @a: anc-exec-builtin-read-tree-tool
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
    const resolved = this.resolvePath(filePath);
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
    const resolved = this.resolvePath(filePath);
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

  private executeWrite(filePath: string, content: string, scope: WriteScope): ToolResult {
    const resolved = this.resolvePath(filePath);
    this.validateFileAccess(resolved, 'write', scope);
    writeFileSync(resolved, content, 'utf-8');
    return { result: `Written ${content.length} bytes to ${filePath}`, success: true, content_type: 'text' };
  }

  // ── 内置文件/目录工具组（2026-08-10 实装，契约与流程见 [[tools/file-tools#^anc-exec-builtin-file-tools]]）──
  // @a: anc-exec-builtin-file-tools

  private executeListDir(dirPath: string): ToolResult {
    const resolved = this.resolvePath(dirPath);
    this.validateFileAccess(resolved, 'read');
    const entries = readdirSync(resolved).map(name => {
      const st = statSync(resolve(resolved, name));
      const t = st.isDirectory() ? 'dir' : 'file';
      return { name, type: t, kind: t };   // type=正名(行业惯例),kind=兼容别名(2026-09-07 作者拍——R9 实撞 e.type 缺键恒假) // @a: anc-exec-builtin-file-tools
    });
    // 空目录语义明示（2026-09-18 作者对 Qwen 复读循环追问"listdir 符合常见 tool 行为么"后定——
    // 裸 [] 对弱模型是哑数据:与"没返回"难区分,不构成换路信号,实撞连续 14 轮重扫同一空目录;
    // JSON 前缀保持在首位,机械 parse 面不变,注记只进 LLM 通道）。// @a: anc-exec-builtin-file-tools
    if (entries.length === 0) {
      return { result: '[]\n（目录存在但为空——没有任何文件或子目录。重复查询同一目录不会得到不同结果；若在找输入材料，本步所需输入已在提示词的"本步输入材料"段给出。）', success: true, content_type: 'json' };
    }
    return { result: JSON.stringify(entries), success: true, content_type: 'json' };
  }

  private executeFileExists(filePath: string): ToolResult {
    const resolved = this.resolvePath(filePath);
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
    writeFileSync(resolved, content, { encoding: 'utf-8', flag: 'wx' });
    return { result: `Created ${filePath} (${content.length} bytes)`, success: true, content_type: 'text' };
  }

  private executeAppend(filePath: string, content: string, scope: WriteScope): ToolResult {
    const resolved = this.resolvePath(filePath);
    this.validateFileAccess(resolved, 'write', scope);
    appendFileSync(resolved, content, 'utf-8');
    return { result: `Appended ${content.length} bytes to ${filePath}`, success: true, content_type: 'text' };
  }

  // edit_file 局部精确替换（HopSop 六步照 [[tools/file-tools#^anc-exec-builtin-edit-file-tool]]）：
  // old_text 恰匹配一处才替换，零匹配/多匹配报错带计数——宁拒不猜，调用方补上下文重试。
  // @a: anc-exec-builtin-edit-file-tool
  private executeEditFile(filePath: string, oldText: string, newText: string, scope: WriteScope): ToolResult {
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
      return { result: `未找到匹配（old_text 头 80 字符:${oldText.slice(0, 80)}）`, success: false, content_type: 'text' };
    }
    if (n >= 2) {
      return { result: `匹配 ${n} 处,请提供更长的唯一上下文`, success: false, content_type: 'text' };
    }
    const offset = content.indexOf(oldText);
    // 按偏移拼接而非 String.replace——replace 会解释 new_text 里的 $ 特殊模式（$& 等），字面替换语义禁此通道
    writeFileSync(resolved, content.slice(0, offset) + newText + content.slice(offset + oldText.length), 'utf-8');
    return { result: `Replaced 1 occurrence at char ${offset} in ${filePath}`, success: true, content_type: 'text' };
  }

  private executeMkdir(dirPath: string, scope: WriteScope): ToolResult {
    const resolved = this.resolvePath(dirPath);
    this.validateFileAccess(resolved, 'write', scope);
    mkdirSync(resolved, { recursive: true });   // 已存在即成功（幂等）
    return { result: `Directory ready: ${dirPath}`, success: true, content_type: 'text' };
  }

  private executeMove(fromPath: string, toPath: string, scope: WriteScope): ToolResult {
    const from = this.resolvePath(fromPath);
    const to = this.resolvePath(toPath);
    this.validateFileAccess(from, 'write', scope);   // move 的源与目标都过写侧校验
    this.validateFileAccess(to, 'write', scope);
    renameSync(from, to);   // rename 原子性透传（同文件系统内原子替换）
    return { result: `Moved ${fromPath} → ${toPath}`, success: true, content_type: 'text' };
  }

  private executeDelete(filePath: string, scope: WriteScope): ToolResult {
    const resolved = this.resolvePath(filePath);
    this.validateFileAccess(resolved, 'write', scope);
    unlinkSync(resolved);   // 不存在即 ENOENT（显式失败不静默）；仅文件——目录不删（最重操作不进 v1）
    return { result: `Deleted ${filePath}`, success: true, content_type: 'text' };
  }

  private resolvePath(filePath: string): string {
    // work_zone 绝对路径放行（work_zone_path() 的产物）——其余绝对路径照拒
    if (isAbsolute(filePath) && !filePath.includes('..') && isWorkZonePath(filePath)) return filePath;
    return resolveWorkspacePath(this.workspaceDir, filePath);
  }

  private validateFileAccess(resolvedPath: string, operation: 'read' | 'write', scope: WriteScope = 'work_zone'): void {
    const realPath = resolveReal(resolvedPath);
    // work_zone 是引擎划定的实例涂鸦区：读写全放行（.hopstate 禁令的唯一豁免）
    if (isWorkZonePath(realPath)) return;
    if (operation === 'write') {
      // 写侧分域（2026-08-28 作者定,契约 [[tools/file-tools#^anc-exec-builtin-file-tools]]）：act/check
      // 语境（'work_zone'）写域=仅 work_zone——探索段写的都是中间产物,散落 workspace 会被
      // 后续步/并行兄弟 read 到（自污染）;commit 语境（'workspace'）才可写全域（交付写盘）。
      // @a: anc-exec-write-scope
      if (scope === 'work_zone') {
        throw new Error(`WORK_ZONE_ONLY: act/check 步骤的写域限 work_zone 涂鸦区（中间产物用 work_zone_path() 取路径）——持久产物写盘归 [commit] 步骤承载: ${realPath}`);
      }
      const wsDir = resolveReal(resolve(this.sandbox.filesystem.workspace_dir));
      if (!realPath.startsWith(wsDir)) {
        throw new Error(`Write outside workspace sandbox: ${realPath}`);
      }
      if (realPath.includes('.hopstate')) {
        throw new Error('Write to .hopstate/ is forbidden');
      }
      return;
    }
    validateReadAccess(this.sandbox, resolvedPath);
  }
}
