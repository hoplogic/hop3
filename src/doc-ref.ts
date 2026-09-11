// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: doc-ref ^anc-struct-doc-ref
// doc-ref [[文档#章节]] 确定性精确引用解析。
// 概念: ../../HopSpec V3核心规范.md ^anc-exec-doc-ref
// 设计: design/spec-parser.md ^anc-rule-doc-ref-extract（提取）
//       design/step-dispatcher.md ^anc-exec-doc-ref-resolve（解析）
//       design/prompt-assembler.md ^anc-exec-doc-ref-injection（注入/deflate）

import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, isAbsolute, normalize } from 'node:path';
import type { DocRef, DocRefFragment } from './ast-types.js';
import type { SandboxConfig } from './provider-types.js';
import { DEFLATE_THRESHOLD, INLINE_PREVIEW_MAX } from './ast-helpers.js';
import { resolveWorkspacePath, validateReadAccess } from './tools.js';

// 捕获组1=文档路径，组2=章节名；(?:\|别名)? 吞掉 Obsidian 别名后缀。
// 强制要求 #章节（无 # 的纯 [[doc]] 不匹配）。
const RE_DOC_REF = /\[\[([^\]#|]+)#([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
const RE_HEADING = /^(#{1,6})\s+(.*\S)/;
const RE_FENCE = /^```/;

/**
 * 从文本提取 doc-ref。排除 #^ 前缀（那是 [[doc#^anc-*]] 段落锚点反链，非章节引用）。
 * 同一 (doc, section) 去重。// @a: anc-rule-doc-ref-extract
 */
export function extractDocRefs(text: string): DocRef[] {
  if (!text) return [];
  const seen = new Set<string>();
  const refs: DocRef[] = [];
  RE_DOC_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_DOC_REF.exec(text)) !== null) {
    const doc = m[1].trim();
    const section = m[2].trim();
    if (section.startsWith('^')) continue; // 段落锚点反链，非章节引用
    if (!doc || !section) continue;
    const key = `${doc} ${section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ doc, section });
  }
  return refs;
}

// 剥离章节名/标题的序号前缀做归一化匹配。四类前缀：
//  ① 阿拉伯序号 `4` / `4.7`（分隔符可选）  ② 中文数字序号 `二、`（分隔符必需——
//  避免 "十全大补" 的 "十" 被误剥）  ③ 全角括号序号 `（一）`  ④ 半角括号序号 `(1)`。
// "第三方" 因 "第" 不在数字集、无分隔符，不会被剥。
const RE_NUM_PREFIX = /^(?:\d+(?:\.\d+)*[.、\s]*|[一二三四五六七八九十百千零]+[、.\s]+|（[^）]*）\s*|\([^)]*\)\s*)/;

function normalizeSection(s: string): string {
  return s.replace(RE_NUM_PREFIX, '').trim();
}

interface Heading { line: number; depth: number; text: string; }

function scanHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (RE_FENCE.test(lines[i].trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    const hm = lines[i].match(RE_HEADING);
    if (hm) headings.push({ line: i, depth: hm[1].length, text: hm[2].trim() });
  }
  return headings;
}

/** 章节切片结果：命中标题、章节正文、匹配级别（精确/归一化/子串/未命中）及歧义标记。见 [[doc-ref#^anc-exec-doc-ref-resolve]] */
export interface SliceResult {
  heading: string;
  content: string;
  matched: 'exact' | 'normalized' | 'fuzzy' | 'none';
  ambiguous?: boolean;
}

/**
 * 在 markdown 文本中定位 section 标题并切出其章节正文（含子标题，到下一个同级/更高级标题止）。
 * 三级匹配：精确 → 归一化序号 → 子串包含。// @a: anc-exec-doc-ref-resolve
 */
export function sliceSection(lines: string[], section: string): SliceResult {
  const headings = scanHeadings(lines);
  const target = section.trim();
  const normTarget = normalizeSection(target);

  let hit: Heading | undefined;
  let matched: SliceResult['matched'] = 'none';
  let ambiguous = false;

  // a. 精确
  hit = headings.find(h => h.text === target);
  if (hit) matched = 'exact';

  // b. 归一化序号相等
  if (!hit && normTarget) {
    hit = headings.find(h => normalizeSection(h.text) === normTarget);
    if (hit) matched = 'normalized';
  }

  // c. 子串包含（兜底，多命中取首 + 标 ambiguous）
  if (!hit) {
    const cands = headings.filter(h =>
      h.text.includes(target) || (normTarget && normalizeSection(h.text).includes(normTarget)));
    if (cands.length > 0) {
      hit = cands[0];
      matched = 'fuzzy';
      ambiguous = cands.length > 1;
    }
  }

  if (!hit) return { heading: '', content: '', matched: 'none' };

  // 切区间 [命中行+1, 下一个 depth <= 命中 depth 的标题行)
  let end = lines.length;
  for (const h of headings) {
    if (h.line > hit.line && h.depth <= hit.depth) { end = h.line; break; }
  }
  const content = lines.slice(hit.line + 1, end).join('\n').trim();
  return { heading: hit.text, content, matched, ambiguous };
}

/** doc-ref 解析期文件未找到/章节无匹配/沙箱拒读时抛出，携带原始 DocRef，供 engine failStep 消费。见 [[doc-ref#^anc-exec-doc-ref-resolve]] */
export class DocRefError extends Error {
  constructor(message: string, readonly ref: DocRef) { super(message); }
}

// 候选路径：原名 + 补 .md 兜底（Obsidian 习惯省后缀）
/** hop_env 环境参数展开（doc-ref 路径位是唯一引擎展开位——面最小原则,概念 ^anc-config-hop-env,
 * 设计 doc-ref ^anc-exec-doc-ref-hop-env）：\{ \} 反斜杠转义为字面花括号;{hop_env_xxx} 替换为表值;
 * 未定义键抛 HOP_ENV_UNDEFINED（响亮——空串拼路径是找错文件的温床）。三段式防转义内容被误替换;
 * 占位符用可打印哨兵（控制字节会把源文件/被处理串变二进制,NUL 实撞教训）。
 * // @a: anc-exec-doc-ref-hop-env */
export function expandHopEnv(path: string, hopEnv: Record<string, string> | undefined): { path: string; expanded: boolean } {
  const ESC_O = '⟪⟪HOPENV_LB⟫⟫', ESC_C = '⟪⟪HOPENV_RB⟫⟫';
  let sPath = path.replace(/\\\{/g, ESC_O).replace(/\\\}/g, ESC_C);   // ①转义占位
  let expanded = false;
  sPath = sPath.replace(/\{(hop_env_[a-z0-9_]+)\}/g, (_, key: string) => {   // ②变量替换
    const v = hopEnv?.[key];
    if (v === undefined) {
      throw new Error(`HOP_ENV_UNDEFINED: doc-ref 引用了未定义的环境参数 '${key}'——可用键: ${Object.keys(hopEnv ?? {}).join(', ') || '(空——配置 env: 节或 params 传入)'}`);
    }
    expanded = true;
    return v;
  });
  return { path: sPath.split(ESC_O).join('{').split(ESC_C).join('}'), expanded };
}

function candidatePaths(doc: string): string[] {
  if (doc.endsWith('.md') || /\.ya?ml$/i.test(doc)) return [doc];   // 显式扩展名不追加 .md 兜底
  return [doc, `${doc}.md`];
}

/** YAML 键切片（^anc-exec-doc-ref-yaml-slice,R10 sandbox 实撞 2026-09-08 作者拍"做"——
 * 结构化规则表存 YAML 是语料常态,锚点原先只认 Markdown 标题,YAML 键报"章节未匹配"只能
 * 整读或散文指路。行级切片不走解析-序列化:保注释（规则表语义大量住块注释）+与 Markdown
 * 切片同为行区间算法。两级匹配:a 点路径精确逐层下钻 → b 单键名深度优先首命中（多命中
 * 取首+标 ambiguous）。切区间含键行自身（单行键值切掉键行就没了）,键行上紧邻无空行阻隔
 * 的注释块一并带入。// @a: anc-exec-doc-ref-yaml-slice */
export function sliceYamlKey(lines: string[], section: string): SliceResult {
  // 键行扫描:缩进 + 键名 + 冒号（#开头是注释;引号键剥引号）
  interface KeyLine { line: number; indent: number; key: string }
  const keys: KeyLine[] = [];
  const RE_KEY = /^(\s*)((?:"[^"]+")|(?:'[^']+')|(?:[^\s#:][^:]*?))\s*:(?:\s|$)/;
  const RE_SEQ_ITEM = /^\s*-(?:\s|$)/;   // 序列项行:值内容不是键——不入键表也不作出块边界
  // （业界对照调研抓零缩进序列坑:YAML 允许 `- 项` 与父键同列〔GitHub Actions/K8s 常见〕,
  // 不排除则 `- name` 成伪键且切片在首个序列项处静默截断——唯一 P15 兜不住的切错形态）
  lines.forEach((raw, i) => {
    if (RE_SEQ_ITEM.test(raw)) return;
    const m = RE_KEY.exec(raw);
    if (!m) return;
    let key = m[2].trim();
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
    keys.push({ line: i, indent: m[1].length, key });
  });

  const target = section.trim();
  let hit: KeyLine | undefined;
  let matched: SliceResult['matched'] = 'none';
  let ambiguous = false;

  if (target.includes('.')) {
    // a. 点路径精确:逐层下钻——每段须在上一段的行区间内且缩进更深(取该区间内该键名的最浅缩进层)
    const segs = target.split('.').map(t => t.trim()).filter(Boolean);
    let lo = 0, hiEnd = lines.length, parentIndent = -1;
    let cur: KeyLine | undefined;
    for (const seg of segs) {
      // 限直接子级（阅卷抓跳级静默命中后改严——a 档点路径是精确定位,与 b 档单键名宽松
      // 兜底分工;判据:区间内全部键的最浅缩进=直接子级层,命中键须恰在该层）
      const inRange = keys.filter(k => k.line >= lo && k.line < hiEnd && k.indent > parentIndent);
      if (inRange.length === 0) { cur = undefined; break; }
      const childIndent = Math.min(...inRange.map(k => k.indent));
      cur = inRange.find(k => k.indent === childIndent && k.key === seg);
      if (!cur) break;
      // 收窄区间到 cur 的子树
      lo = cur.line + 1;
      hiEnd = lines.length;
      for (const k of keys) { if (k.line > cur.line && k.indent <= cur.indent) { hiEnd = k.line; break; } }
      parentIndent = cur.indent;
    }
    if (cur) { hit = cur; matched = 'exact'; }
  } else {
    // b. 单键名深度优先首命中(行序即深度优先)
    const cands = keys.filter(k => k.key === target);
    if (cands.length > 0) { hit = cands[0]; matched = cands.length > 1 ? 'fuzzy' : 'exact'; ambiguous = cands.length > 1; }
  }

  if (!hit) return { heading: '', content: '', matched: 'none' };

  // 切区间 [键行, 下一个缩进<=键行缩进的键行);键行上紧邻注释块带入
  let end = lines.length;
  for (const k of keys) { if (k.line > hit.line && k.indent <= hit.indent) { end = k.line; break; } }
  let start = hit.line;
  while (start > 0) {
    const prev = lines[start - 1];
    if (/^\s*#/.test(prev)) start--;   // 紧邻注释行
    else break;   // 空行或其它内容即阻隔
  }
  const content = lines.slice(start, end).join('\n').replace(/\s+$/, '');
  return { heading: hit.key, content, matched, ambiguous };
}

/** 按目标文件扩展名分流切片档（.yaml/.yml 走键切片,其余走 Markdown 标题切片）。
 * // @a: anc-exec-doc-ref-yaml-slice */
export function sliceByFileType(filePath: string, lines: string[], section: string): SliceResult {
  return /\.ya?ml$/i.test(filePath) ? sliceYamlKey(lines, section) : sliceSection(lines, section);
}

/** 定位 doc-ref 文件——解析基准两级（design ^anc-exec-doc-ref-resolve 解析基准条,2026-08-20 作者定）：
 * 第一级 spec 目录（spec 自带材料随 spec 走——自包含分发单元,同名时赢）,specDir 缺席跳过；
 * 第二级 workspace（业务材料按作业对象根解析）。命中返回绝对路径（读取统一走 validateReadAccess——
 * spec 目录可在 workspace 外,已由 init 组合点入 read allowed）,全不命中返回 undefined。
 * 不吞 resolveWorkspacePath 的抛错（path traversal 等）——由调用方按各自语义处理。
 * // @a: anc-exec-doc-ref-resolve */
function resolveDocFile(workspaceDir: string, doc: string, specDir?: string): string | undefined {
  for (const cand of candidatePaths(doc)) {
    // spec 目录级不吃 ../绝对路径（越界逃逸面;字面绝对路径是禁令不许 join 吞掉）——
    // 这类引用只走 workspace 级,由 resolveWorkspacePath 响亮拦
    if (specDir && !cand.includes('..') && !isAbsolute(cand)) {
      const inSpecDir = normalize(join(specDir, cand));
      if (existsSync(inSpecDir)) return inSpecDir;
    }
    // 保持既有 workspace 语义（相对路径经 resolveWorkspacePath 拦 ../绝对路径）
    const inWs = resolveWorkspacePath(workspaceDir, cand);
    if (existsSync(inWs)) return inWs;
  }
  return undefined;
}

/**
 * 静态存在性校验（P15 用）：文件存在 + 章节可匹配。返回 null 表示通过，否则返回错误说明。
 * 不抛异常（validator 收集错误而非中断）。// @a: anc-rule-p15
 */
export function checkDocRefExists(workspaceDir: string, sandbox: SandboxConfig, ref: DocRef, hopEnv?: Record<string, string>, specDir?: string): string | null {
  // P15 两档（^anc-exec-doc-ref-hop-env）：含 {hop_env_*} 的引用在表可得时展开后查;
  // 表缺席跳过留注入期兜底（不假绿也不误拒——报文责任归 validator 侧,此处返 null 即"本档不拦"）。
  let doc = ref.doc;
  let viaHopEnv = false;
  if (/\{hop_env_[a-z0-9_]+\}/.test(doc)) {
    if (!hopEnv || Object.keys(hopEnv).length === 0) return null;   // 表缺席=注入期核
    try {
      const ex = expandHopEnv(doc, hopEnv);
      doc = ex.path; viaHopEnv = ex.expanded;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);   // 未定义键静态即报（HOP_ENV_UNDEFINED）
    }
  } else {
    doc = expandHopEnv(doc, hopEnv).path;   // 纯转义还原（无变量不会抛）
  }
  let resolvedFile: string | undefined;
  try {
    if (viaHopEnv && isAbsolute(doc)) {
      if (doc.includes('..')) return `doc-ref 路径含 ..: ${doc}`;
      resolvedFile = candidatePaths(normalize(doc)).find(c => existsSync(c));
    } else {
      resolvedFile = resolveDocFile(workspaceDir, doc, specDir);   // 两级基准与注入期同判 // @a: anc-rule-p15
    }
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (!resolvedFile) return `文件未找到: ${doc}`;
  let text: string;
  try {
    // resolveDocFile 已返绝对路径——读取统一走 validateReadAccess（spec 目录候选可在 workspace 外）
    validateReadAccess(sandbox, resolvedFile);
    text = readFileSync(resolvedFile, 'utf-8');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const slice = sliceByFileType(resolvedFile, text.split('\n'), ref.section);   // .yaml 走键切片 // @a: anc-exec-doc-ref-yaml-slice
  if (slice.matched === 'none') return `章节未匹配: [[${ref.doc}#${ref.section}]]`;
  return null;
}

/**
 * 运行期解析一组 doc-ref 为章节内容片段。同文件只读一次（按 path 缓存）。
 * 大节超 DEFLATE_THRESHOLD 时写 workZone/docref/ 并返 file_path 指针；
 * workZone 空串（独立模式）时不卸载、内联全文。
 * 文件/章节找不到 → 抛 DocRefError（dispatcher 据此 failStep）。// @a: anc-exec-doc-ref-resolve
 */
export function resolveDocRefs(
  refs: DocRef[],
  workspaceDir: string,
  sandbox: SandboxConfig,
  workZone: string,
  hopEnv?: Record<string, string>,
  specDir?: string,
  inlinePreview?: boolean,   // inline 通道（standalone 裸 API LLM）:大节不产指针,改预览形态（^anc-exec-llm-inline-context v2）
): DocRefFragment[] {
  const fileCache = new Map<string, string[]>();
  const fragments: DocRefFragment[] = [];

  // hop_env 展开（注入期,步骤 1b——展开后再走既有 sandbox 校验链,展开值同受读权限约束）。
  // 展开产生的绝对路径走 validateReadAccess 直判（hop_env 值常是 workspace 外绝对根,声明根已随
  // 组合根扩入 read allowed——写配置即授权;未声明根照拒）;字面绝对路径 doc-ref 维持原禁令。
  // @a: anc-exec-doc-ref-hop-env
  const expandedRefs = refs.map(r => {
    const ex = expandHopEnv(r.doc, hopEnv);
    return { ref: { ...r, doc: ex.path }, viaHopEnv: ex.expanded };
  });

  for (const { ref, viaHopEnv } of expandedRefs) {
    let resolvedFile: string | undefined;
    if (viaHopEnv && isAbsolute(ref.doc)) {
      if (ref.doc.includes('..')) throw new DocRefError(`doc-ref 路径含 ..: [[${ref.doc}#${ref.section}]]`, ref);
      resolvedFile = candidatePaths(normalize(ref.doc)).find(c => existsSync(c));
    } else {
      // 定位文件（两级基准:spec 目录优先/workspace 兜底,含 .md 兜底）
      resolvedFile = resolveDocFile(workspaceDir, ref.doc, specDir);
    }
    if (!resolvedFile) throw new DocRefError(`doc-ref 文件未找到: [[${ref.doc}#${ref.section}]]`, ref);

    let lines = fileCache.get(resolvedFile);
    if (!lines) {
      // resolveDocFile/hop_env 两路皆已是绝对路径——读取统一 validateReadAccess+直读
      //（spec 目录候选可在 workspace 外,已由 init 组合点入 read allowed）
      validateReadAccess(sandbox, resolvedFile);
      lines = readFileSync(resolvedFile, 'utf-8').split('\n');
      fileCache.set(resolvedFile, lines);
    }

    const slice = sliceByFileType(resolvedFile, lines, ref.section);   // .yaml 走键切片 // @a: anc-exec-doc-ref-yaml-slice
    if (slice.matched === 'none') {
      throw new DocRefError(`doc-ref 章节未匹配: [[${ref.doc}#${ref.section}]]`, ref);
    }

    const frag: DocRefFragment = {
      doc: ref.doc,
      section: ref.section,
      heading: slice.heading,
      content: slice.content,
      matched: slice.matched as DocRefFragment['matched'],
    };

    // inline 预览通道:超限大节头部节选+全文落盘（值位真内容非死引用）// @a: anc-exec-llm-inline-context
    if (inlinePreview && slice.content.length > INLINE_PREVIEW_MAX) {
      if (workZone) {
        const docrefDir = join(workZone, 'docref');
        mkdirSync(docrefDir, { recursive: true, mode: 0o700 });
        const safe = `${ref.doc}__${ref.section}`.replace(/[^\w一-龥.-]+/g, '_');
        frag.file_path = join(docrefDir, `${safe}.md`);
        writeFileSync(frag.file_path, slice.content, { mode: 0o600 });
      }
      frag.preview = slice.content.slice(0, INLINE_PREVIEW_MAX);
      frag.full_chars = slice.content.length;
      fragments.push(frag);
      continue;
    }
    // deflate: 大节卸载到 work_zone 文件（agent 通道专属——inline 通道禁入:中节(4K-20K)在
    // inline 下必须全文内联,掉进本分支产 $file 指针即 BUG-H 复发）
    if (!inlinePreview && workZone && Buffer.byteLength(slice.content, 'utf-8') > DEFLATE_THRESHOLD) {
      const docrefDir = join(workZone, 'docref');
      mkdirSync(docrefDir, { recursive: true, mode: 0o700 });
      const safe = `${ref.doc}__${ref.section}`.replace(/[^\w一-龥.-]+/g, '_');
      const filePath = join(docrefDir, `${safe}.md`);
      writeFileSync(filePath, slice.content, { mode: 0o600 });
      frag.file_path = filePath;
    }
    fragments.push(frag);
  }
  return fragments;
}

/**
 * 把解析出的 fragment 渲染为 doc_ref_context 文本（进 L2 知识区块）。yaml 条目化
 * （2026-08-24 受众公理：来源=人读得懂的文档名+章节,剥 [[]] wiki 语法与"命中标题"解析器
 * 调试尾巴——那是给引擎账目看的,不是给执行 LLM 的;作用一句话说明与本步的关系）。
 * 大节（有 file_path）内容位换 $file 指针；小节内联全文。// @a: anc-exec-doc-ref-injection
 */
export function formatDocRefContext(fragments: DocRefFragment[]): string {
  if (fragments.length === 0) return '';
  const indent = (t: string) => t.split('\n').map(l => '    ' + l).join('\n');
  return fragments.map(f => {
    const head = `- 来源: ${f.doc}《${f.section}》\n  作用: 作者指定的必读知识——本步背景教材，后续指令假定你已读过`;
    if (f.preview !== undefined) {
      // inline 预览条目（^anc-exec-llm-inline-context v2）:值位真内容节选+明示省略量与全文去处
      const omitted = (f.full_chars ?? f.preview.length) - f.preview.length;
      const fullLine = f.file_path ? `\n  全文: ${f.file_path}（有文件工具时可读全文）` : '';
      return `${head}\n  体量: 全文 ${f.full_chars} 字符（本条为前 ${f.preview.length} 字符节选预览）${fullLine}\n  内容: |\n${indent(f.preview)}\n${indent(`（……以下省略 ${omitted} 字符）`)}`;
    }
    if (f.file_path) {
      return `${head}\n  内容: （全文见 ${f.file_path}，请 Read 获取完整章节）`;
    }
    return `${head}\n  内容: |\n${indent(f.content)}`;
  }).join('\n');
}
