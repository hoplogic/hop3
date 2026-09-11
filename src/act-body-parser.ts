// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: act-body ^anc-struct-act-body
// act body 解析器：``` hop_python 围栏 → ActBody AST
// 设计见 design/spec-ast.md ^anc-ast-act-body；概念 HopSpec V3核心规范 ^anc-step-act。
// 无推理编排：赋值 + 白名单调用 + if-else 分支（确定性条件），禁循环（for/while → 错误）。
// Python 风格：缩进块、if cond: / elif cond: / else:、无花括号。

import type { ActBody, ActStatement, AssignStmt, CallStmt, IfStmt, ActExpr, BinaryExpr, BinaryOp, CallExpr, CallArg } from './ast-types.js';
import type { ParseError } from './errors.js';
import { ACT_BUILTIN_NAMES } from './act-builtins.js';

const FENCE_OPEN = /^```hop_python\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const LOOP_KEYWORDS = /\b(for|while)\b/;

// ---------------------------------------------------------------------------
// 围栏提取：从 instruction 行数组中切出 hop_python body 与剩余自然语言行
// ---------------------------------------------------------------------------

export function extractHopPythonFence(instructionLines: string[]): {
  bodyLines: string[] | null;
  bodyStartIndex: number;       // body 首行在 instructionLines 中的索引（错误定位用）
  narrative: string[];
  unclosed: boolean;            // 开栏后到指令区结束都没等到闭栏（指令级围栏配对——原静默接受:
                                // 删掉闭栏行 body 照样提取,配对形同虚设）// @a: anc-rule-unclosed-fence
} {
  const narrative: string[] = [];
  let bodyLines: string[] | null = null;
  let bodyStartIndex = -1;
  let inBody = false;

  for (let i = 0; i < instructionLines.length; i++) {
    const line = instructionLines[i];
    const trimmed = line.trim();
    if (!inBody && FENCE_OPEN.test(trimmed)) {
      inBody = true;
      bodyLines = [];
      bodyStartIndex = i + 1;
      continue;
    }
    if (inBody && FENCE_CLOSE.test(trimmed)) {
      inBody = false;
      continue;
    }
    if (inBody) {
      bodyLines!.push(line);
    } else {
      narrative.push(line);
    }
  }
  return { bodyLines, bodyStartIndex, narrative, unclosed: inBody };
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokKind =
  | 'ident' | 'number' | 'string' | 'fstring' | 'op' | 'colon'
  | 'lparen' | 'rparen' | 'lbracket' | 'rbracket' | 'lbrace' | 'rbrace' | 'comma' | 'dot'
  | 'newline' | 'indent' | 'dedent' | 'eof';

interface Token {
  kind: TokKind;
  value: string;
  line: number;   // 1-based within body
}

const KEYWORDS = new Set(['if', 'elif', 'else', 'and', 'or', 'not', 'in', 'is', 'for', 'true', 'false', 'None', 'null']);

// 推导嵌套深度闸报错文案（^anc-step-act-body-comprehension 嵌套深度≤2,2026-09-03 作者拍板）
const COMPREHENSION_DEPTH_ERR = '列表推导嵌套超两层（最多两层——外层过滤+内层聚合谓词是常见合法形态;更深的嵌套升 loop 步骤或先拆中间变量）';
// 多字符运算符优先匹配
const MULTI_OPS = ['==', '!=', '<=', '>=', '//', '**'];   // // 整除、** 幂（Python 对齐 2026-08-10）——先于单字符 / 和 * 匹配
const SINGLE_OPS = new Set(['+', '-', '*', '/', '%', '<', '>', '=']);

function tokenize(bodyLines: string[], baseLine: number, errors: ParseError[]): Token[] | null {
  const tokens: Token[] = [];
  const indentStack: number[] = [0];
  let ok = true;

  for (let ln = 0; ln < bodyLines.length; ln++) {
    const raw = bodyLines[ln];
    const absLine = baseLine + ln;

    // 禁循环：早拦——先掩字符串字面量再搜关键词（hopissues/0079:字符串里的英文 for/while
    // 是数据不是语句,对原始行直搜误拦合法参数〔实撞:subprocess 参数含错误文案
    // 'Profile changed while being read' 被拒,被迫无意义改写〕。掩法=成对引号段替换等长
    // 占位,反斜杠转义跳过——与 tokenizer 的字符串识别同语义,只用于本早拦不改 token 流）。
    // @a: anc-step-act-body-comprehension
    const masked = raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, m => 'x'.repeat(m.length));
    if (LOOP_KEYWORDS.test(masked)) {
      // 列表推导放行（2026-08-19 作者拍板 ^anc-step-act-body-comprehension）:推导的 for 恒在 '[' 之后;
      // 语句级 for/while（行首或赋值号后直接 for）仍拦。while 无推导形态恒拦。
      const forIdx = masked.search(/\bfor\b/);
      const bracketIdx = masked.indexOf('[');
      const isComprehension = forIdx >= 0 && bracketIdx >= 0 && bracketIdx < forIdx && !/\bwhile\b/.test(masked);
      if (!isComprehension) {
        errors.push({ kind: 'parse', line: absLine, message: 'act body 禁止循环语句（for/while）——循环须升 HopSpec loop 步骤;列表推导 [expr for x in xs] 可用' });
        ok = false;
      }
    }

    const content = raw.replace(/\s+$/, '');
    const trimmedStart = content.replace(/^\s*/, '');
    if (trimmedStart === '' || trimmedStart.startsWith('#')) continue; // 空行/纯注释跳过

    // 缩进只接受空格、禁 tab（hop_python 词法契约，见概念 ^anc-step-act-body-lang）。
    // 注：act body 在 `> ` 区，`>` 紧跟的 tab 会被 RE_INSTRUCTION 吞掉，但「> 空格+tab」
    // 形态的 tab 会残留进此处的行首空白——必须显式拦，否则缩进列数被污染却静默接受。
    const leadingWs = content.slice(0, content.length - trimmedStart.length);
    if (leadingWs.includes('\t')) {
      errors.push({ kind: 'parse', line: absLine, message: 'act body 缩进只接受空格，不接受 tab' });
      ok = false;
    }

    const indent = content.length - trimmedStart.length;
    const top = indentStack[indentStack.length - 1];
    if (indent > top) {
      indentStack.push(indent);
      tokens.push({ kind: 'indent', value: '', line: absLine });
    } else if (indent < top) {
      while (indentStack.length > 1 && indent < indentStack[indentStack.length - 1]) {
        indentStack.pop();
        tokens.push({ kind: 'dedent', value: '', line: absLine });
      }
      if (indent !== indentStack[indentStack.length - 1]) {
        errors.push({ kind: 'parse', line: absLine, message: 'act body 缩进不一致' });
        ok = false;
      }
    }

    // 行内 tokenize（剥行尾注释）
    let s = trimmedStart;
    const hashIdx = findCommentStart(s);
    if (hashIdx >= 0) s = s.slice(0, hashIdx).replace(/\s+$/, '');

    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      // f-string 前缀（Python 对齐 2026-08-10）：f"..." / f'...'——发独立 fstring token,
      // 原文（未转义）存 value,插值解析在 parser 层做（文本段与 {expr} 交替切分）
      if ((c === 'f' || c === 'F') && (s[i + 1] === '"' || s[i + 1] === "'")) {
        const quote = s[i + 1]; let j = i + 2; let rawVal = '';
        while (j < s.length && s[j] !== quote) {
          if (s[j] === '\\' && j + 1 < s.length) { rawVal += s[j] + s[j + 1]; j += 2; continue; }
          rawVal += s[j]; j++;
        }
        if (j >= s.length) { errors.push({ kind: 'parse', line: absLine, message: '未闭合 f-string' }); ok = false; break; }
        tokens.push({ kind: 'fstring', value: rawVal, line: absLine });
        i = j + 1; continue;
      }
      // string
      if (c === '"' || c === "'") {
        const quote = c; let j = i + 1; let val = '';
        while (j < s.length && s[j] !== quote) {
          if (s[j] === '\\' && j + 1 < s.length) {
            // 标准转义语义（v0.2.2）：\n 换行、\t 制表、\\ 反斜杠、\"/\' 引号；其余 \X → X
            const e = s[j + 1];
            val += e === 'n' ? '\n' : e === 't' ? '\t' : e;
            j += 2; continue;
          }
          val += s[j]; j++;
        }
        if (j >= s.length) { errors.push({ kind: 'parse', line: absLine, message: '未闭合字符串' }); ok = false; break; }
        tokens.push({ kind: 'string', value: val, line: absLine });
        i = j + 1; continue;
      }
      // number
      const prevTok = tokens[tokens.length - 1];
      const dotIsPostfix = c === '.' && prevTok && (prevTok.kind === 'ident' || prevTok.kind === 'rparen' || prevTok.kind === 'rbracket');
      if (!dotIsPostfix && (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? '')))) {
        let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
        tokens.push({ kind: 'number', value: s.slice(i, j), line: absLine });
        i = j; continue;
      }
      // ident / keyword——收 Unicode 字母（中文 enum 成员/字面量:`risk == 高`,2026-08-09
      // case 结构化逻辑标准写法迁移复测撞出 [A-Za-z_] 吃不了中文）
      if (/[\p{L}_]/u.test(c)) {
        let j = i; while (j < s.length && /[\p{L}\p{N}_]/u.test(s[j])) j++;
        tokens.push({ kind: 'ident', value: s.slice(i, j), line: absLine });
        i = j; continue;
      }
      // multi-char op
      const two = s.slice(i, i + 2);
      if (MULTI_OPS.includes(two)) { tokens.push({ kind: 'op', value: two, line: absLine }); i += 2; continue; }
      // single
      if (c === ':') { tokens.push({ kind: 'colon', value: ':', line: absLine }); i++; continue; }
      if (c === '(') { tokens.push({ kind: 'lparen', value: '(', line: absLine }); i++; continue; }
      if (c === ')') { tokens.push({ kind: 'rparen', value: ')', line: absLine }); i++; continue; }
      if (c === ',') { tokens.push({ kind: 'comma', value: ',', line: absLine }); i++; continue; }
      if (c === '[') { tokens.push({ kind: 'lbracket', value: '[', line: absLine }); i++; continue; }
      if (c === ']') { tokens.push({ kind: 'rbracket', value: ']', line: absLine }); i++; continue; }
      if (c === '{') { tokens.push({ kind: 'lbrace', value: '{', line: absLine }); i++; continue; }
      if (c === '}') { tokens.push({ kind: 'rbrace', value: '}', line: absLine }); i++; continue; }
      if (c === '.') { tokens.push({ kind: 'dot', value: '.', line: absLine }); i++; continue; }
      if (SINGLE_OPS.has(c)) { tokens.push({ kind: 'op', value: c, line: absLine }); i++; continue; }
      errors.push({ kind: 'parse', line: absLine, message: `act body 非法字符: ${c}` });
      ok = false; break;
    }
    tokens.push({ kind: 'newline', value: '', line: absLine });
  }
  // 收尾 dedent
  while (indentStack.length > 1) { indentStack.pop(); tokens.push({ kind: 'dedent', value: '', line: baseLine + bodyLines.length }); }
  tokens.push({ kind: 'eof', value: '', line: baseLine + bodyLines.length });
  return ok ? tokens : null;
}

// 找到行内注释 # 的起点（跳过字符串内的 #）
function findCommentStart(s: string): number {
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === inStr) inStr = null; else if (c === '\\') i++; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '#') return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 递归下降 parser
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private toks: Token[], private errors: ParseError[]) {}

  private comprehensionDepth = 0;   // 推导嵌套深度计数器（^anc-step-act-body-comprehension:嵌套深度≤2,2026-09-03 作者拍板放宽原禁嵌套——进推导+1解析完-1,当前已在第2层还要开新推导即第3层,拒;element 先于 for 解析,其内嵌套由推导完成后回查 exprComprehensionDepth 深度感知补拦)
  private peek(): Token { return this.toks[this.pos]; }
  private next(): Token { return this.toks[this.pos++]; }
  private at(kind: TokKind): boolean { return this.peek().kind === kind; }
  private atKeyword(kw: string): boolean { const t = this.peek(); return t.kind === 'ident' && t.value === kw; }
  private peekAhead(n: number): Token | undefined { return this.toks[this.pos + n]; }
  private err(msg: string): void { this.errors.push({ kind: 'parse', line: this.peek().line, message: 'act body: ' + msg }); }

  private skipNewlines(): void { while (this.at('newline')) this.next(); }

  // 顶层语句块（直到 eof）
  parseProgram(): ActStatement[] {
    const stmts: ActStatement[] = [];
    this.skipNewlines();
    while (!this.at('eof')) {
      const s = this.parseStatement();
      if (!s) break;
      stmts.push(s);
      this.skipNewlines();
    }
    return stmts;
  }

  // 缩进块：INDENT statement+ DEDENT
  private parseBlock(): ActStatement[] {
    const stmts: ActStatement[] = [];
    if (!this.at('indent')) { this.err('期望缩进块'); return stmts; }
    this.next(); // indent
    this.skipNewlines();
    while (!this.at('dedent') && !this.at('eof')) {
      const s = this.parseStatement();
      if (!s) break;
      stmts.push(s);
      this.skipNewlines();
    }
    if (this.at('dedent')) this.next();
    return stmts;
  }

  private parseStatement(): ActStatement | null {
    const t = this.peek();
    if (t.kind === 'ident' && (t.value === 'if')) return this.parseIf();
    if (t.kind === 'ident' && (t.value === 'elif' || t.value === 'else')) {
      this.err(`意外的 ${t.value}（无匹配 if）`); return null;
    }
    // pass 定向报错（B 档：Python 惯性——hop_python 分支必须有实动作，空分支删掉整个 if 分支）
    if (t.kind === 'ident' && t.value === 'pass') {
      this.err('hop_python 无 pass——分支里必须有实动作；空分支直接不写该分支');
      this.next(); if (this.at('newline')) this.next();
      return null;
    }
    // ident 开头：可能是赋值 (ident = ...) 或调用语句 (ident(...))
    if (t.kind === 'ident' && !KEYWORDS.has(t.value)) {
      // 向前看：下一个非该 ident 的 token
      const save = this.pos;
      const name = this.next().value;
      // 增强赋值 a += 1（B 档定向报错——写全 a = a + 1）
      if (this.at('op') && ['+', '-', '*', '/'].includes(this.peek().value)
          && this.toks[this.pos + 1]?.kind === 'op' && this.toks[this.pos + 1]?.value === '=') {
        this.err(`hop_python 无增强赋值（${name} ${this.peek().value}= …）——写全 ${name} = ${name} ${this.peek().value} …`);
        while (!this.at('newline') && !this.at('eof')) this.next();
        return null;
      }
      if (this.at('op') && this.peek().value === '=') {
        this.next(); // =
        const value = this.parseExpr();
        const line = t.line;
        // 多重赋值 a = b = 1（B 档定向报错——拆成两行）
        if (this.at('op') && this.peek().value === '=') {
          this.err(`hop_python 无多重赋值（${name} = x = …）——拆成两行分别赋值`);
          while (!this.at('newline') && !this.at('eof')) this.next();
          return null;
        }
        this.expectNewlineOrEnd();
        return { type: 'assign', target: name, value, line } as AssignStmt;
      }
      // Python 惯性错误定向报错（agent 高频编造，泛用报错会让它盲目重试——文案必须指对方向）
      if (name === 'import' || name === 'from') {
        this.err('hop_python 无 import——内置函数与文件/目录工具（listdir/exists/makedirs/remove 等）直接裸名调用，无需导入；本行删除');
        while (!this.at('newline') && !this.at('eof')) this.next();
        return null;
      }
      // 回退，作为表达式语句（应是 call）
      this.pos = save;
      const expr = this.parseExpr();
      this.expectNewlineOrEnd();
      if (expr.type === 'call') return { type: 'call', call: expr, line: t.line } as CallStmt;
      this.err('表达式语句只允许工具/函数调用'); return null;
    }
    this.err(`非法语句起始: ${t.value || t.kind}`);
    this.next();
    return null;
  }

  private parseIf(): IfStmt {
    const line = this.peek().line;
    this.next(); // if
    const condition = this.parseExpr();
    this.expectColon();
    this.expectNewline();
    const then_body = this.parseBlock();
    let else_body: ActStatement[] | undefined;
    this.skipNewlines();
    if (this.atKeyword('elif')) {
      // elif 展开为 else_body: [嵌套 IfStmt]
      else_body = [this.parseIf()];
    } else if (this.atKeyword('else')) {
      this.next(); // else
      this.expectColon();
      this.expectNewline();
      else_body = this.parseBlock();
    }
    return { type: 'if', condition, then_body, else_body, line };
  }

  // 表达式优先级：ternary(最低) > or > and > not > cmp > add > mul > unary > postfix > primary
  private parseExpr(): ActExpr {
    const e = this.parseOr();
    // 条件表达式 a if c else b（2026-08-17 作者定改判转正式支持——原 B 档报错让生成 LLM
    // 错误泛化为"hop_python 不支持 if/else"；Python 同款最低优先级、右结合,惰性求值归求值器）
    if (this.atKeyword('if')) {
      this.next();   // 吃 if
      const condition = this.parseOr();
      if (!this.atKeyword('else')) {
        this.err('条件表达式缺 else——完整形态 a if c else b');
        return e;
      }
      this.next();   // 吃 else
      const elseExpr = this.parseExpr();   // 递归=右结合（a if c1 else b if c2 else d）
      return { type: 'ternary', condition, then: e, else: elseExpr };
    }
    return e;
  }

  private parseOr(): ActExpr {
    let left = this.parseAnd();
    while (this.atKeyword('or')) { this.next(); const right = this.parseAnd(); left = bin('or', left, right); }
    return left;
  }
  private parseAnd(): ActExpr {
    let left = this.parseNot();
    while (this.atKeyword('and')) { this.next(); const right = this.parseNot(); left = bin('and', left, right); }
    return left;
  }
  private parseNot(): ActExpr {
    if (this.atKeyword('not')) { this.next(); return { type: 'unary', op: 'not', operand: this.parseNot() }; }
    return this.parseCmp();
  }
  private parseCmp(): ActExpr {
    let left = this.parseAdd();
    if (this.at('op') && ['==', '!=', '<', '>', '<=', '>='].includes(this.peek().value)) {
      const op = this.next().value as BinaryOp; const right = this.parseAdd(); left = bin(op, left, right);
      // 链式比较 1 < x < 5（B 档定向报错——用 and 拆：1 < x and x < 5）
      if (this.at('op') && ['==', '!=', '<', '>', '<=', '>='].includes(this.peek().value)) {
        this.err('hop_python 无链式比较（a < b < c）——用 and 拆开：a < b and b < c');
        this.next(); this.parseAdd();
      }
    } else if (this.atKeyword('is')) {   // is/is not 仅限 None,归一为 ==/!= 对 None。// @a: anc-exec-ordered-compare
      // is [not] None（Python 惯用形，2026-08-11 作者定）：仅限 None 判定，解析层归一为
      // ==/!= 对 None 字面量——AST 零新节点（serializer/walker/求值器零改动）。右操作数
      // 非 None 定向报错指路 ==（hop_python 值模型无对象身份概念，不开通用 is）。
      this.next();
      const negated = this.atKeyword('not');
      if (negated) this.next();
      if (this.atKeyword('None') || this.atKeyword('null')) {
        this.next();
        left = bin(negated ? '!=' : '==', left, { type: 'literal', value: null, literal_kind: 'null' });
      } else {
        this.err(`hop_python 的 is 仅限 None 判定（x is None / x is not None）——其他比较用 ${negated ? '!=' : '=='}`);
        this.parseAdd();   // 消费右侧防级联报错
      }
    } else if (this.atKeyword('in')) {
      // 成员测试 x in items（Python 惯用形，2026-08-10 对齐——替代原 contains 函数）
      this.next(); const right = this.parseAdd(); left = bin('in', left, right);
    } else if (this.atKeyword('not') && this.peekAhead(1)?.kind === 'ident' && this.peekAhead(1)?.value === 'in') {
      // not in：双关键字中缀（前缀 not 归 parseNot；Python 语义 not x in xs ≡ not (x in xs) 由层级自然成立）
      this.next(); this.next(); const right = this.parseAdd(); left = bin('not in', left, right);
    }
    return left;
  }
  private parseAdd(): ActExpr {
    let left = this.parseMul();
    while (this.at('op') && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value as BinaryOp; const right = this.parseMul(); left = bin(op, left, right);
    }
    return left;
  }
  private parseMul(): ActExpr {
    let left = this.parseUnary();
    while (this.at('op') && ['*', '/', '%', '//'].includes(this.peek().value)) {
      const op = this.next().value as BinaryOp; const right = this.parseUnary(); left = bin(op, left, right);
    }
    return left;
  }
  private parseUnary(): ActExpr {
    if (this.at('op') && this.peek().value === '-') { this.next(); return { type: 'unary', op: '-', operand: this.parseUnary() }; }
    return this.parsePower();
  }
  private parsePower(): ActExpr {
    // ** 右结合、优先级高于一元负号左侧（Python: -2**2 == -4），底数取 postfix
    const base = this.parsePostfix();
    if (this.at('op') && this.peek().value === '**') {
      this.next(); const exp = this.parseUnary();   // 右结合：递归回 unary 层（2**-1、2**3**2 都对）
      return bin('**', base, exp);
    }
    return base;
  }
  private parsePostfix(): ActExpr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.at('dot')) {
        this.next();
        // 字段访问（.N 数字段 2026-08-09 作者定删除——下标只有 items[N] 一种写法）
        if (!this.at('ident')) { this.err('. 后期望字段名（下标用 [N]）'); break; }
        e = { type: 'field', object: e, field: this.next().value };
      } else if (this.at('lbracket')) {
        // [expr] 下标——Python 结构化逻辑标准写法,index 为任意表达式（items[0]/items[i]/items[n-1],
        // 2026-08-09 作者定 A:动态下标全开;.N dotted 形态同日删除——两形态并存无价值）。
        // [start:stop] 切片——端点各自可省可负,钳位宽容（^anc-step-act-body-slice,2026-09-05
        // todo/0071:LLM 按 Python 直觉写 l[2:] 是本能,原报文"] 未闭合"不指路烧两轮定位）。
        // @a: anc-step-act-body-slice
        this.next();
        let start: ActExpr | undefined;
        if (!this.at('colon')) {
          start = this.parseExpr();
          if (this.at('rbracket')) { this.next(); e = { type: 'index', object: e, index: start }; continue; }
        }
        if (!this.at('colon')) { this.err('] 未闭合'); break; }
        this.next();   // 吃切片 ':'
        let stop: ActExpr | undefined;
        if (!this.at('rbracket') && !this.at('colon')) stop = this.parseExpr();
        if (this.at('colon')) { this.err('步长切片（l[::2] 三段形态）不支持——反转 l[::-1] 用 reversed(l)；隔位取用推导式 [l[i] for i in range(0, len(l), 2)]'); break; }
        if (!this.at('rbracket')) { this.err('] 未闭合（切片）'); break; }
        this.next();
        e = { type: 'slice', object: e, ...(start ? { start } : {}), ...(stop ? { stop } : {}) };
      } else if (this.at('lparen')) {
        // 调用：e 必须是 var（callee 名）。field 链上的调用是 Python 惯性错误
        // （os.listdir(x) / s.strip()），定向报错指对方向，防 agent 盲目重试。
        // 唯一特例 subprocess.run（^anc-exec-subprocess-run,2026-08-29 作者拍 A 案——"写是按
        // python 写"名字是写法的一部分;认字面不开模块系统,其余 field 调用照旧定向报错）。
        // @a: anc-exec-subprocess-run
        if (e.type === 'field' && e.object.type === 'var' && e.object.name === 'subprocess' && e.field === 'run') {
          e = this.parseCallArgs('subprocess.run');
          continue;
        }
        if (e.type === 'field') {
          const root = ((): string => { let c: ActExpr = e; while (c.type === 'field') c = c.object; return c.type === 'var' ? c.name : '?'; })();
          this.err(`hop_python 无模块/方法调用（${root}.xxx(...)）——一律裸名直调：文件/目录用内置工具 listdir/exists/makedirs/remove/move 等（无 os 前缀），字符串方法函数化（strip(s) 非 s.strip()），列表追加用拼接 xs = xs + [item]（无 append）`);
          break;
        }
        if (e.type !== 'var') { this.err('只能调用具名函数/工具'); break; }
        e = this.parseCallArgs((e as { name: string }).name);
      } else break;
    }
    return e;
  }
  private parseCallArgs(callee: string): CallExpr {
    this.next(); // (
    const args: CallArg[] = [];
    if (!this.at('rparen')) {
      for (;;) {
        // 命名参数 name: expr / name=expr（后者 Python kwargs 形态,随 subprocess.run 批
        // 放开——"写是按 python 写";改前 name= 是解析错误,零歧义零回归;== 是独立 token 不混。
        // ^anc-exec-subprocess-run 双形态条款）// @a: anc-exec-subprocess-run
        if (this.at('ident') && this.toks[this.pos + 1]?.kind === 'colon') {
          const name = this.next().value; this.next(); // ident :
          args.push({ name, value: this.parseExpr() });
        } else if (this.at('ident') && this.toks[this.pos + 1]?.kind === 'op' && this.toks[this.pos + 1]?.value === '=') {
          const name = this.next().value; this.next(); // ident =
          args.push({ name, value: this.parseExpr() });
        } else {
          args.push({ value: this.parseExpr() });
        }
        if (this.at('comma')) { this.next(); continue; }
        break;
      }
    }
    if (this.at('rparen')) this.next(); else this.err(') 未闭合');
    return { type: 'call', callee, args };
  }
  private parsePrimary(): ActExpr {
    const t = this.peek();
    if (t.kind === 'number') { this.next(); return { type: 'literal', value: Number(t.value), literal_kind: 'number' }; }
    if (t.kind === 'string') { this.next(); return { type: 'literal', value: t.value, literal_kind: 'string' }; }
    if (t.kind === 'ident' && (t.value === 'true' || t.value === 'false')) {
      this.next(); return { type: 'literal', value: t.value === 'true', literal_kind: 'bool' };
    }
    // None 字面量（Python 结构化逻辑标准写法;null 同义）——上游 fail 输出为 None,条件 `x == None`
    // 检测降级路径是概念层失败传播节明文推荐模式,此前无结构化逻辑标准写法可写（2026-08-09 审出补齐）。
    if (t.kind === 'ident' && (t.value === 'None' || t.value === 'null')) {
      this.next(); return { type: 'literal', value: null, literal_kind: 'null' };
    }
    // Python 惯性 True/False/None 大写形——直接归一（与 Python 对齐方针一致，双写法不进文档）
    if (t.kind === 'ident' && (t.value === 'True' || t.value === 'False')) {
      this.next(); return { type: 'literal', value: t.value === 'True', literal_kind: 'bool' };
    }
    if (t.kind === 'ident' && !KEYWORDS.has(t.value)) { this.next(); return { type: 'var', name: t.value }; }
    if (t.kind === 'lparen') { this.next(); const e = this.parseExpr(); if (this.at('rparen')) this.next(); else this.err(') 未闭合'); return e; }
    // 列表字面量 [1, "a", x]（Python 对齐 2026-08-10）——lbracket 在 primary 位即字面量（postfix 位才是下标）
    if (t.kind === 'lbracket') {
      this.next();
      const elements: ActExpr[] = [];
      if (!this.at('rbracket')) {
        elements.push(this.parseExpr());
        // 列表推导 [expr for x in xs (if cond)]（2026-08-19 作者拍板——纯映射/过滤,有界零状态,
        // 不违禁循环本意;体内禁工具调用〔checkActExpr 统一核〕;嵌套深度≤2〔2026-09-03 作者拍板放宽原禁嵌套,
        // hopissues/0068:外层过滤+内层聚合谓词是标准 Python 合法形态〕。 // @a: anc-step-act-body-comprehension
        if (this.peek().kind === 'ident' && this.peek().value === 'for') {
          if (this.comprehensionDepth >= 2) { this.err(COMPREHENSION_DEPTH_ERR); }
          this.next();   // 吃 for
          const it = this.peek();
          if (it.kind !== 'ident' || KEYWORDS.has(it.value)) { this.err('列表推导 for 后期望迭代变量名'); return { type: 'list_literal', elements }; }
          this.next();
          if (this.peek().kind === 'ident' && this.peek().value === 'in') this.next(); else this.err('列表推导期望 in');
          // source/filter 用无三元档 parseOr——推导内裸 if 归 filter（Python 同款,三元要用须括号）。
          // 深度计数 try/finally 恢复,解析异常不泄漏计数。
          this.comprehensionDepth++;
          let source: ActExpr;
          let filter: ActExpr | undefined;
          try {
            source = this.parseOr();
            if (this.peek().kind === 'ident' && this.peek().value === 'if') { this.next(); filter = this.parseOr(); }
          } finally {
            this.comprehensionDepth--;
          }
          if (this.at('rbracket')) this.next(); else this.err('] 未闭合（列表推导）');
          // element 先于 for 解析,其内嵌套不经在场计数器——回查子树推导深度:外围层数(comprehensionDepth,
          // 此刻已减回=包住本推导的层数)+本推导 1 层+element 内深度 >2 即第 3 层,拒。
          if (this.comprehensionDepth + 1 + exprComprehensionDepth(elements[0]) > 2) this.err(COMPREHENSION_DEPTH_ERR);
          return { type: 'comprehension', element: elements[0], itemVar: it.value, source, ...(filter ? { filter } : {}) };
        }
        while (this.at('comma')) { this.next(); if (this.at('rbracket')) break; elements.push(this.parseExpr()); }
      }
      if (this.at('rbracket')) this.next(); else this.err('] 未闭合（列表字面量）');
      return { type: 'list_literal', elements };
    }
    // 对象字面量 {"k": v} / {key_var: v}——键=表达式,Python 同义（2026-08-20 作者定『与 python
    // 一致』:字面量键最常用,裸名=变量引用〔未定义 B4 静态拦并指路〕,计算键合法;求值 str 归一）。
    // @a: anc-step-act-body-dict-key
    if (t.kind === 'lbrace') {
      this.next();
      const entries: Array<{ key: ActExpr; value: ActExpr }> = [];
      if (!this.at('rbrace')) {
        for (;;) {
          const keyExpr = this.parseExpr();
          if (this.at('colon')) this.next(); else { this.err('对象字面量键后期望 :'); break; }
          entries.push({ key: keyExpr, value: this.parseExpr() });
          if (this.at('comma')) { this.next(); if (this.at('rbrace')) break; continue; }
          break;
        }
      }
      if (this.at('rbrace')) this.next(); else this.err('} 未闭合（对象字面量）');
      return { type: 'dict_literal', entries };
    }
    // f-string f"x={v}"——原文按 {expr} 切分，插值段经 parseExpression 子解析
    if (t.kind === 'fstring') {
      this.next();
      return this.parseFString(t.value, t.line);
    }
    this.err(`非法表达式起始: ${t.value || t.kind}`);
    this.next();
    return { type: 'literal', value: '', literal_kind: 'string' }; // 占位，错误已记
  }

  // f-string 原文切分：{expr} 为插值（{{/}} 转义为字面花括号），文本段做标准转义
  private parseFString(raw: string, line: number): ActExpr {
    const parts: Array<{ kind: 'text'; text: string } | { kind: 'expr'; expr: ActExpr }> = [];
    let text = '';
    let i = 0;
    const unescape = (s: string) => s.replace(/\\(.)/g, (_, e) => e === 'n' ? '\n' : e === 't' ? '\t' : e);
    while (i < raw.length) {
      const c = raw[i];
      if (c === '{' && raw[i + 1] === '{') { text += '{'; i += 2; continue; }
      if (c === '}' && raw[i + 1] === '}') { text += '}'; i += 2; continue; }
      if (c === '{') {
        const end = raw.indexOf('}', i + 1);
        if (end < 0) { this.errors.push({ kind: 'parse', line, message: 'f-string 插值 { 未闭合' }); break; }
        if (text) { parts.push({ kind: 'text', text: unescape(text) }); text = ''; }
        const exprSrc = raw.slice(i + 1, end).trim();
        const subErrs: ParseError[] = [];
        const expr = parseExpression(exprSrc, subErrs);
        if (!expr || subErrs.length > 0) {
          this.errors.push({ kind: 'parse', line, message: `f-string 插值表达式非法: {${exprSrc}}` });
        } else {
          parts.push({ kind: 'expr', expr });
        }
        i = end + 1; continue;
      }
      if (c === '\\' && i + 1 < raw.length) { text += raw[i] + raw[i + 1]; i += 2; continue; }
      text += c; i++;
    }
    if (text) parts.push({ kind: 'text', text: unescape(text) });
    return { type: 'fstring', parts };
  }

  private expectColon(): void { if (this.at('colon')) this.next(); else this.err('期望 :'); }
  private expectNewline(): void { if (this.at('newline')) this.next(); else this.err('期望换行'); }
  private expectNewlineOrEnd(): void { if (this.at('newline')) this.next(); else if (!this.at('eof') && !this.at('dedent')) this.err('语句后期望换行'); }
}

function bin(op: BinaryOp, left: ActExpr, right: ActExpr): BinaryExpr {
  return { type: 'binary', op, left, right };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function parseActBody(
  bodyLines: string[],
  baseLine: number,
  errors: ParseError[],
): ActBody | null {
  const before = errors.length;
  const toks = tokenize(bodyLines, baseLine, errors);
  if (!toks) return null;
  const parser = new Parser(toks, errors);
  const statements = parser.parseProgram();
  if (errors.length > before) return null; // 有解析错误则不产出 body
  return { statements, source_location: { line_start: baseLine, line_end: baseLine + bodyLines.length } };
}

// ---------------------------------------------------------------------------
// 序列化：ActBody AST → hop_python 文本（复用模式交付 CC 用；不要求与原文逐字符等价，
// 语义等价即可——见 spec-ast.md serialize 是辅助工具）。 // @a: anc-ast-act-body
// ---------------------------------------------------------------------------

/** 单行纯表达式解析出口（case 条件升 hop_python 表达式子集，2026-08-09 作者裁决
 * "一套表达式文法两个宿主"）——同一文法：字面量/变量/字段/下标/比较/and-or-not/算术/括号。
 * 赋值天然不可达（只走表达式链不走语句链）；工具调用由调用方查 AST 拒（C8/求值双侧）。
 * 返回 null = 解析失败（errors 带准确错因——修 8k primer K 题'运算符不支持误报未定义变量'）。
 * // @a: anc-rule-c8 */
export function parseExpression(exprText: string, errors: ParseError[]): ActExpr | null {
  const toks = tokenize([exprText], 1, errors);
  if (!toks) return null;
  const before = errors.length;
  const p = new Parser(toks, errors);
  // Parser 私有方法经内部出口调用（同文件内 friend 访问）
  const expr = (p as unknown as { parseExpr(): ActExpr }).parseExpr();
  // 表达式后必须只剩换行/EOF——尾随内容（如 `x == 1 extra`）= 非法
  const rest = (p as unknown as { peek(): Token }).peek();
  if (rest.kind !== 'newline' && rest.kind !== 'eof') {
    errors.push({ kind: 'parse', line: rest.line, message: `case 条件: 表达式后有多余内容 "${rest.value ?? rest.kind}"` });
    return null;
  }
  return errors.length > before ? null : expr;
}

/** 表达式 AST 是否含调用节点（case 条件禁工具调用——条件零副作用）。 */
export function exprHasCall(expr: ActExpr): boolean {
  // 扫描类经 exprChildren（^anc-struct-expr-walk）——新节点在原语一处登记本面自动覆盖
  if (expr.type === 'call') return true;
  return exprChildren(expr).some(exprHasCall);
}

/** 找出表达式里第一个非 pure（不在内置白名单）的调用名——条件允许内置 pure 函数、禁工具
 * （2026-08-10 作者定）。无则 null。callee 是否 pure 由传入判定器决定（validator 传 ACT_BUILTIN_NAMES）。 */
export function findNonPureCallWith(expr: ActExpr, isPure: (name: string) => boolean): string | null {
  // 扫描类经 exprChildren（^anc-struct-expr-walk）
  if (expr.type === 'call' && !isPure(expr.callee)) return expr.callee;
  for (const c of exprChildren(expr)) { const hit = findNonPureCallWith(c, isPure); if (hit) return hit; }
  return null;
}

/** ActBody → 渲染文本——prompt 组装时给 LLM 看的 body 展示（非执行通道）。见 [[act-body#^anc-struct-act-body-exports]] */
export function serializeActBody(body: ActBody): string {
  return body.statements.map(s => serializeStmt(s, 0)).join('\n');
}

function indent(level: number): string { return '    '.repeat(level); }

function serializeStmt(stmt: ActStatement, level: number): string {
  const pad = indent(level);
  if (stmt.type === 'assign') {
    return `${pad}${(stmt as AssignStmt).target} = ${serializeExpr((stmt as AssignStmt).value)}`;
  }
  if (stmt.type === 'call') {
    return `${pad}${serializeExpr((stmt as CallStmt).call)}`;
  }
  // if
  const ifs = stmt as IfStmt;
  const lines: string[] = [`${pad}if ${serializeExpr(ifs.condition)}:`];
  for (const s of ifs.then_body) lines.push(serializeStmt(s, level + 1));
  if (ifs.else_body) {
    // elif 展开还原：else_body 恰为单个 IfStmt → 输出 elif
    if (ifs.else_body.length === 1 && ifs.else_body[0].type === 'if') {
      const elif = ifs.else_body[0] as IfStmt;
      const elifLines = serializeStmt(elif, level).split('\n');
      elifLines[0] = `${pad}elif ${serializeExpr(elif.condition)}:`;
      lines.push(...elifLines.slice(0));
    } else {
      lines.push(`${pad}else:`);
      for (const s of ifs.else_body) lines.push(serializeStmt(s, level + 1));
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 表达式遍历原语（^anc-struct-expr-walk,v0.10.0 作者拍板 B+A——expr 消费面三撞成律后立项）：
// 两原语是全库唯二"逐节点列孩子"的位置,switch 带 never 穷尽断言——ActExpr 加成员而原语
// 未接,tsc 编译红。扫描类消费面经 exprChildren 递归,变换类经 exprMapChildren,自身零逐节点 switch。
// ---------------------------------------------------------------------------

/** 子表达式清单（不含自身;literal/var 返回 []）。见 [[act-body#^anc-struct-expr-walk]] */
export function exprChildren(expr: ActExpr): ActExpr[] { // @a: anc-struct-expr-walk
  switch (expr.type) {
    case 'literal': case 'var': return [];
    case 'field': return [expr.object];
    case 'index': return [expr.object, expr.index];
    case 'slice': return [expr.object, ...(expr.start ? [expr.start] : []), ...(expr.stop ? [expr.stop] : [])];
    case 'unary': return [expr.operand];
    case 'binary': return [expr.left, expr.right];
    case 'call': return expr.args.map(a => a.value);
    case 'list_literal': return expr.elements;
    case 'dict_literal': return expr.entries.flatMap(en => [en.key, en.value]);
    case 'fstring': return expr.parts.filter(p => p.kind === 'expr').map(p => (p as { kind: 'expr'; expr: ActExpr }).expr);
    case 'ternary': return [expr.condition, expr.then, expr.else];
    case 'comprehension': return [expr.element, expr.source, ...(expr.filter ? [expr.filter] : [])];
    default: {
      const _exhaustive: never = expr;
      throw new Error(`exprChildren 未覆盖节点: ${(_exhaustive as ActExpr).type}`);
    }
  }
}

/** 表达式子树内推导的最大嵌套深度（无推导=0;推导自身 1 层+子树内深度取最大——深度闸用:
 * element 先于外层 for 解析,其内嵌套须回查。原布尔判 exprContainsComprehension 随嵌套深度≤2
 * 语义退役,element 内一层嵌套现在合法,布尔判分不出 1 层与 2 层）。 */
export function exprComprehensionDepth(expr: ActExpr): number { // @a: anc-step-act-body-comprehension
  const childMax = exprChildren(expr).reduce((m, c) => Math.max(m, exprComprehensionDepth(c)), 0);
  return expr.type === 'comprehension' ? 1 + childMax : childMax;
}

/** 子表达式同构重建（每个孩子过 f,结构与其余字段不变）。变换类消费面用。见 [[act-body#^anc-struct-expr-walk]] */
export function exprMapChildren(expr: ActExpr, f: (e: ActExpr) => ActExpr): ActExpr { // @a: anc-struct-expr-walk
  switch (expr.type) {
    case 'literal': case 'var': return expr;
    case 'field': return { ...expr, object: f(expr.object) };
    case 'index': return { ...expr, object: f(expr.object), index: f(expr.index) };
    case 'slice': return { ...expr, object: f(expr.object), ...(expr.start ? { start: f(expr.start) } : {}), ...(expr.stop ? { stop: f(expr.stop) } : {}) };
    case 'unary': return { ...expr, operand: f(expr.operand) };
    case 'binary': return { ...expr, left: f(expr.left), right: f(expr.right) };
    case 'call': return { ...expr, args: expr.args.map(a => ({ ...a, value: f(a.value) })) };
    case 'list_literal': return { ...expr, elements: expr.elements.map(f) };
    case 'dict_literal': return { ...expr, entries: expr.entries.map(en => ({ key: f(en.key), value: f(en.value) })) };
    case 'fstring': return { ...expr, parts: expr.parts.map(p => p.kind === 'expr' ? { ...p, expr: f(p.expr) } : p) };
    case 'ternary': return { ...expr, condition: f(expr.condition), then: f(expr.then), else: f(expr.else) };
    case 'comprehension': return { ...expr, element: f(expr.element), source: f(expr.source), ...(expr.filter ? { filter: f(expr.filter) } : {}) };
    default: {
      const _exhaustive: never = expr;
      throw new Error(`exprMapChildren 未覆盖节点: ${(_exhaustive as ActExpr).type}`);
    }
  }
}

// 序列化优先级表（与 parseExpr 链一致:ternary 最低→postfix 最高）。子表达式优先级低于所在
// 语境要求时补括号——零括号版曾把 -(a+b) 序列化成 -a + b（语义漂移:serializeActBody 是复用模式
// 交付 caller"严格按此执行"的执行文本,三审探针实抓存量缺陷,v0.9.1）。
const PREC = { ternary: 0, or: 1, and: 2, not: 3, cmp: 4, add: 5, mul: 6, unary: 7, postfix: 8 } as const;
const CMP_OPS = new Set(['==', '!=', '<', '>', '<=', '>=', 'in', 'not in']);

function exprPrec(expr: ActExpr): number {
  switch (expr.type) {
    case 'ternary': return PREC.ternary;
    case 'comprehension': return PREC.postfix;   // 方括号自包=原子形态
    case 'binary':
      if (expr.op === 'or') return PREC.or;
      if (expr.op === 'and') return PREC.and;
      if (CMP_OPS.has(expr.op)) return PREC.cmp;
      if (expr.op === '+' || expr.op === '-') return PREC.add;
      return PREC.mul;   // * / % // **
    case 'unary': return expr.op === 'not' ? PREC.not : PREC.unary;
    case 'literal': case 'var': case 'field': case 'index': case 'slice': case 'call':
    case 'list_literal': case 'dict_literal': case 'fstring':
      return PREC.postfix;   // 自带边界
    default: {
      const _exhaustive: never = expr;
      throw new Error(`exprPrec 未覆盖节点: ${(_exhaustive as ActExpr).type}`);
    }
  }
}

/** 子表达式按语境最低优先级渲染——低于门槛补括号。 */
function serializeSub(expr: ActExpr, minPrec: number, inFstring = false): string {
  const s = serializeExpr(expr, inFstring);
  return exprPrec(expr) < minPrec ? `(${s})` : s;
}

// inFstring 参数：真时字符串字面量写单引号——f-string 外层恒双引号,插值内再出双引号
// 即撞栏（`f"{p["id"]}"` re-parse 必炸;原写法 roundtrip 漂移实锤,todo/0016 投影漂移族）。
// 参数透传非模块状态（^anc-run-isolation 顶层可变量禁令,机检拦后改形态）。
// @a: anc-rule-serialize-output-forms
function quoteSingle(v: string): string {
  return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\t/g, '\\t') + "'";
}

function serializeExpr(expr: ActExpr, inFstring = false): string {
  switch (expr.type) {
    case 'literal':
      if (expr.literal_kind === 'string') return inFstring ? quoteSingle(String(expr.value)) : JSON.stringify(expr.value);
      return String(expr.value);
    case 'var': return expr.name;
    case 'field': return `${serializeSub(expr.object, PREC.postfix, inFstring)}.${expr.field}`;
    case 'index': return `${serializeSub(expr.object, PREC.postfix, inFstring)}[${serializeExpr(expr.index, inFstring)}]`;
    case 'slice': return `${serializeSub(expr.object, PREC.postfix, inFstring)}[${expr.start ? serializeExpr(expr.start, inFstring) : ''}:${expr.stop ? serializeExpr(expr.stop, inFstring) : ''}]`;
    case 'unary': {
      const p = expr.op === 'not' ? PREC.not : PREC.unary;
      return expr.op === 'not' ? `not ${serializeSub(expr.operand, p, inFstring)}` : `-${serializeSub(expr.operand, p, inFstring)}`;
    }
    case 'binary': {
      const p = exprPrec(expr);
      // 左结合:左侧同级不括,右侧同级要括（a - (b - c)）；** 右结合方向相反（(2**3)**2 左侧要括）
      const rightAssoc = expr.op === '**';
      return `${serializeSub(expr.left, rightAssoc ? p + 1 : p, inFstring)} ${expr.op} ${serializeSub(expr.right, rightAssoc ? p : p + 1, inFstring)}`;
    }
    case 'call': {
      const c = expr as CallExpr;
      const args = c.args.map(a => a.name ? `${a.name}: ${serializeExpr(a.value, inFstring)}` : serializeExpr(a.value, inFstring)).join(', ');
      return `${c.callee}(${args})`;
    }
    case 'list_literal': return `[${expr.elements.map(e => serializeExpr(e, inFstring)).join(', ')}]`;
    case 'comprehension': return `[${serializeExpr(expr.element, inFstring)} for ${expr.itemVar} in ${serializeExpr(expr.source, inFstring)}${expr.filter ? ` if ${serializeExpr(expr.filter, inFstring)}` : ''}]`;
    case 'dict_literal': return `{${expr.entries.map(en => `${serializeExpr(en.key, inFstring)}: ${serializeExpr(en.value, inFstring)}`).join(', ')}}`;
    case 'ternary':
      // then/condition 需高于 ternary 级（嵌套三元在这些位置须括号）；else 位右结合不括
      return `${serializeSub(expr.then, PREC.ternary + 1, inFstring)} if ${serializeSub(expr.condition, PREC.ternary + 1, inFstring)} else ${serializeExpr(expr.else, inFstring)}`;
    case 'fstring': {
      const body = expr.parts.map(p => p.kind === 'text'
        ? p.text.replace(/\{/g, '{{').replace(/\}/g, '}}').replace(/\n/g, '\\n').replace(/"/g, '\\"')
        : `{${serializeExpr(p.expr, true)}}`).join('');
      return `f"${body}"`;
    }
    default: {
      const _exhaustive: never = expr;
      throw new Error(`serializeExpr 未覆盖节点: ${(_exhaustive as ActExpr).type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 判定 body 是否含工具调用（callee 不在内置白名单 = 工具调用，需 caller 执行）。
// CLI next 据此分流：无工具 body 引擎消化，含工具 body 交 caller。
// 见 design/hop-cli.md ^anc-cli-next-drives-body。 // @a: anc-cli-next-drives-body
// ---------------------------------------------------------------------------

export function bodyHasToolCall(body: ActBody): boolean {
  return body.statements.some(stmtHasToolCall);
}

function stmtHasToolCall(stmt: ActStatement): boolean {
  if (stmt.type === 'assign') return exprHasToolCall(stmt.value);
  if (stmt.type === 'call') return exprHasToolCall(stmt.call);
  // if
  if (exprHasToolCall(stmt.condition)) return true;
  if (stmt.then_body.some(stmtHasToolCall)) return true;
  if (stmt.else_body && stmt.else_body.some(stmtHasToolCall)) return true;
  return false;
}

function exprHasToolCall(expr: ActExpr): boolean {
  // 扫描类经 exprChildren（^anc-struct-expr-walk）
  if (expr.type === 'call' && !ACT_BUILTIN_NAMES.has(expr.callee)) return true;
  return exprChildren(expr).some(exprHasToolCall);
}
