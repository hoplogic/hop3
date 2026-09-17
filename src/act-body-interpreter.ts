// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: act-body ^anc-struct-act-body
// act body 解释器（独立模式执行器）：按 ActBody AST 顺序执行——求值 + 调白名单工具，无 LLM。
// 设计见 design/exec-engine.md ^anc-exec-act-body-interp；概念 ^anc-step-act-body-lang。
// 替换 dispatcher.executeActWithTools 的 LLM tool-use 循环（执行期无推理）。
// @a: anc-exec-act-body-interp

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';   // subprocess.run 专路（^anc-exec-subprocess-run） // @a: anc-exec-subprocess-run
import type { ActBody, ActStatement, ActExpr, AssignStmt, CallStmt, IfStmt, CallExpr, OutputDecl } from './ast-types.js';
import type { ToolProvider } from './provider-types.js';
import { ACT_BUILTINS } from './act-builtins.js';
import { isTruthy } from './ast-runtime.js';

/** BodyInterpreter 执行 hop_python body 所需的上下文（scope 初值输入、工具 provider、commit 放行开关、工具调用日志）。见 [[act-body#^anc-exec-act-body-interp]] */
export interface BodyExecContext {
  inputs: Record<string, unknown>;   // ← 输入值（按 name），作 scope 初值
  toolProvider: ToolProvider;
  allowCommit: boolean;              // commit=true 放行 requires_commit 工具
  workZone?: string;                 // 实例 work_zone 绝对路径——work_zone_path() 内置函数的注入源（见 ^anc-exec-work-zone）
  // time 内置（now/today）的重放记值序列：本步已求值的时间值按序入列——重放撞第 n 次取 [n-1]，
  // 缺席取真实时钟并追加（调用方随既有持久化通道落盘；重试/完成清本步序列）。
  // 见 design/act-body.md ^anc-exec-time-builtins。// @a: anc-exec-time-builtins
  timeJournal?: string[];
  // subprocess.run 命令白名单（注入源 HostConfig.sandbox.runtime.available——缺席=能力关死,
  // 缺省安全）与命令结果重放序列（与 timeJournal 同款:撞第 n 次取记录值不重执行——命令不幂等）。
  // 见 design/act-body.md ^anc-exec-subprocess-run。// @a: anc-exec-subprocess-run
  commandWhitelist?: string[];
  cmdJournal?: Array<{ stdout: string; stderr: string; returncode: number }>;
  toolCallLog: Array<{ name: string; result: 'success' | 'failure'; at: string }>;
  // 计算异常收集通道（2026-08-09 定稿"计算异常也是 fail"）：不可转数字/None取字段/非法下标
  // 等纯计算错误求值面折 None 兼 push 一条——调用方（dispatcher/engine）检非空即判本步 fail,
  // warnLog 即 fail 原因组装材料。求值不中途炸（宿主异常只承载工具执行失败等真故障）。
  warnLog?: string[];
  // spec 环境参数表（hop_env_* 只读变量,注入源 HostConfig.hop_env——run() 播入 scope,
  // body 内直接引用/f-string 插值走解释器既有文法。见 [[act-body#^anc-exec-body-hop-env]]）。
  // @a: anc-exec-body-hop-env
  hopEnv?: Record<string, string>;
}

/** 复用模式确定性重放的挂起信号：解释器（经 ReplayToolProvider）撞到 journal 之外的
 * 工具调用时抛出——携带待执行工具与序号，engine 捕获后转 ToolRequest 交 caller。
 * 不是错误：是"body 解释推进到了需要 caller 的那一行"。见 [[act-body#^anc-exec-tool-request]]。
 */
// @a: anc-exec-tool-request
export class ToolCallPending extends Error {
  constructor(
    public readonly tool: string,
    public readonly args: Record<string, unknown>,
    public readonly seq: number,
  ) {
    super(`TOOL_CALL_PENDING: ${tool} (seq ${seq})`);
  }
}

/** 复用模式重放 ToolProvider：包一份本步 tool_journal（已获结果序列）。
 * 第 N 次工具调用：journal 有第 N 项 → 直接返回（重放代入）；没有 → 按执行主体原则分派
 * （2026-09-05 作者定,权威 [[exec-engine#^anc-exec-tool-request]] 分派判据条款）：
 * fallback（引擎自有 provider）list() 命中 → 直执,结果先经 onDirectResult 入账再返回
 * （先入账后续跑——崩溃安全与回填路径同款账本语义）;不命中 → 抛 ToolCallPending 挂起交 caller
 * （剩余存在面=caller 会话专属工具:MCP/宿主能力）。
 * body 除工具调用外纯确定性 → 每个进程从头重放收敛到同一位置，零副作用。
 */
// @a: anc-exec-tool-request
export function makeReplayToolProvider(
  journal: unknown[],
  direct?: { fallback: ToolProvider; onDirectResult: (result: unknown) => void; allowCommit?: boolean },
): ToolProvider {
  // 原第二参 toolNames 摘除（2026-09-05 review 抓:生产唯一调用点恒传 undefined,死参数是漂移源）
  let seq = 0;
  const fallbackDefs = direct ? new Map(direct.fallback.list().map(t => [t.name, t])) : null;
  const p: ToolProvider & { openToolSet?: boolean } = {
    // 名单开放（openToolSet）——fallback 外的工具存在性由 caller 执行时兜底（B2 已在 validate
    // 期提示）。requires_commit 拦截:fallback 命中的工具走真 provider 定义,list() 带真
    // requires_commit,解释器闸实化为真拦（与独立模式同款）;fallback 外仍退化为契约。
    list: () => (direct ? direct.fallback.list() : []),
    execute: async (name: string, args: Record<string, unknown>, writeScope?: 'work_zone' | 'workspace') => {
      const i = seq++;
      if (i < journal.length) {
        // journal 元素两形态归一（^anc-exec-tool-request 剥壳条款,2026-09-05 0075 批实撞:
        // caller 按契约类型注记交 ToolResult 信封,这里原样再包一层 result——body 拿到信封
        // 对象,parse_json 炸"期望 JSON 文本,实际: object"）：
        // - caller submitToolResult 入账的 ToolResult 信封（{result, success} 对象）→ 剥壳
        //   取 .result 交 body,success 随信封透传（信封自报失败照走 TOOL_EXEC_ERROR）;
        // - 引擎直执 onDirectResult 入账的裸结果值 → 包成功信封直传。
        // body 拿到的恒是裸结果值——与引擎直执模式逐值一致。// @a: anc-exec-tool-request
        const entry = journal[i];
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)
            && typeof (entry as Record<string, unknown>).success === 'boolean'
            && 'result' in (entry as Record<string, unknown>)) {
          const env = entry as { success: boolean; result: string | Record<string, unknown> };
          return { success: env.success, result: env.result };
        }
        return { success: true, result: entry as Record<string, unknown> };
      }
      const def = fallbackDefs?.get(name);
      if (direct && def) {
        // 第二道 requires_commit 闸——闸与执行同源（2026-09-05 review 变异实锤:解释器 :460 的闸
        // 依赖本 provider 的 list(),执行依赖 fallback 命中判据,两来源曾各自独立——list() 回归时
        // 闸被绕过而工具真执行（act 语境真发不可撤回消息,测试环境靠凭证缺席掩盖）。此处按
        // fallback 真定义再判一次,list() 无论怎么坏,act 语境的 requires_commit 工具恒拒。
        if (def.requires_commit && !direct.allowCommit) {
          throw new Error(`COMMIT_REQUIRED: tool "${name}" requires commit step`);
        }
        const r = await direct.fallback.execute(name, args, writeScope);
        // 只有成功结果入账（引擎直执侧 journal 元素=裸成功结果值——失败由解释器抛
        // TOOL_EXEC_ERROR 转步骤 fail,journal 随之清账,重试重跑是预期语义）
        if (r.success) direct.onDirectResult(r.result);
        return r;
      }
      throw new ToolCallPending(name, args, i + 1);
    },
  };
  p.openToolSet = true;
  return p;
}

/** $file 指针解引用：`{$file: abs_path}`（agent 通道 deflate 卸载，见 shared-types ^anc-exec-deflate）
 * → 读文件 JSON.parse 取真实值。BodyInterpreter 的输入来自 step.context.inputs（经 resolveInputs
 * deflate），与 LLM 通道不同——LLM 看到指针可决定 Read，解释器必须拿到真值才能做数组拼接/字段
 * 访问等运算。非指针原样返回。// @a: anc-exec-inputs-deflate */
async function derefFilePointer(v: unknown): Promise<unknown> {
  // 递归下钻（D59,2026-08-24——原只剥顶层:指针藏在数组元素/对象字段位时原样进 scope,
  // dr13 实撞 collect 数组一项超阈成指针,机械拼装把 {$file} 对象喂 edit_spec_tree 拒
  // "需要非空 fragment",4 攻同败烧死。"解释器必须拿到真值"承诺覆盖任意嵌套位）。
  // // @a: anc-exec-inputs-deflate
  if (Array.isArray(v)) {
    return Promise.all(v.map(x => derefFilePointer(x)));
  }
  if (v !== null && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec);
    // 形状契约（shared-types ^anc-exec-deflate）：恰单键 {$file: string} 才是指针——
    // 含其他键的用户数据对象（如人通道 {$file, preview}）原样返回不误读文件。
    if (keys.length === 1 && keys[0] === '$file' && typeof rec.$file === 'string') {
      const raw = await readFile(rec.$file, 'utf-8');   // 读失败即抛（缺盘面响亮报错，不静默）
      return JSON.parse(raw);
    }
    // $preview 预览对象（BUG-H v2 inline 通道,^anc-exec-llm-inline-context）同须还原真值——
    // 受众是裸 API LLM,但解释器消费同一份 context.inputs;不识别即把对象喂工具
    // （dr18 第3攻实撞:validate_spec(text:fragment) 收预览对象报"必须是字符串",确定性
    // 错误重试必死,5.1#3 七小时白烧）。full_file 缺席响亮抛——节选替真值=静默截断。
    // full_file 类型并入形状判据（review 二修:存在但非 string 的对象不匹配"可选 full_file(string)"
    // 契约形状——按守卫哲学原样保留走普通对象分支,不误抛"缺 full_file"）。
    // @a: anc-exec-llm-inline-context
    if (typeof rec['$preview'] === 'string' && typeof rec['full_chars'] === 'number'
        && (rec['full_file'] === undefined || typeof rec['full_file'] === 'string')
        && keys.every(k => k === '$preview' || k === 'full_chars' || k === 'full_file')) {
      const fullFile = rec['full_file'];
      if (fullFile === undefined) {
        throw new Error(`TOOL_EXEC_ERROR: $preview 预览对象缺 full_file 全文路径（full_chars=${rec['full_chars']}）——解释器需要真值,不能拿节选顶替`);
      }
      const raw = await readFile(fullFile as string, 'utf-8');
      return JSON.parse(raw);
    }
    // 普通对象:字段位递归（含 {$file,preview} 双键对象——本体不匹配指针形状原样保留,
    // 但其字段若嵌了指针同样下钻;实际数据里 preview 是字符串,无副作用）
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec)) out[k] = await derefFilePointer(val);
    return out;
  }
  return v;
}

/** hop_python 解释器（两种模式共用）：按 ActBody AST 顺序求值执行、调白名单/Provider 工具，执行期无 LLM/无推理。见 [[act-body#^anc-exec-act-body-interp]] */
export class BodyInterpreter {
  private timeSeq = 0;   // 本次 run() 内 time 内置的取值序号（重放定位）// @a: anc-exec-time-builtins
  private cmdSeq = 0;    // 本次 run() 内 subprocess.run 的调用序号（cmdJournal 重放定位）// @a: anc-exec-subprocess-run
  constructor(private ctx: BodyExecContext) {}

  // 执行 body，返回 +→ 声明的输出值（从 scope 取声明名）
  async run(body: ActBody, outputDecls: OutputDecl[]): Promise<Record<string, unknown>> {
    // 输入边界解引用 $file 指针（agent 通道 deflate 的逆操作，见 shared-types ^anc-exec-deflate）：
    // resolveInputs 把超 DEFLATE_THRESHOLD 的输入值写 work_zone/vars/<name>.json 并换 {$file} 指针。
    // 解释器是确定性执行体，不能像 LLM 那样"决定要不要 Read"——`a + b` 这类数组拼接必须拿到真数组，
    // 否则 Array.isArray(指针对象)=false 落入数值强转报"不可转数字"（BUG-A ^todo-bug-deflate-plus）。
    const scope = new Map<string, unknown>();
    // hop_env 只读变量先播（命名空间保留,输入名不可能撞前缀）// @a: anc-exec-body-hop-env
    for (const [name, value] of Object.entries(this.ctx.hopEnv ?? {})) scope.set(name, value);
    for (const [name, value] of Object.entries(this.ctx.inputs)) {
      scope.set(name, await derefFilePointer(value));
    }
    await this.execStatements(body.statements, scope);
    const outputs: Record<string, unknown> = {};
    for (const decl of outputDecls) {
      if (scope.has(decl.name)) outputs[decl.name] = scope.get(decl.name);
    }
    return outputs;
  }

  private async execStatements(stmts: ActStatement[], scope: Map<string, unknown>): Promise<void> {
    for (const stmt of stmts) await this.execStatement(stmt, scope);
  }

  private async execStatement(stmt: ActStatement, scope: Map<string, unknown>): Promise<void> {
    if (stmt.type === 'assign') {
      const a = stmt as AssignStmt;
      // hop_env_* 只读——运行期写防线（静态 B1 闸的兜底:replan 生成的 body 不过 validate）。
      // @a: anc-exec-body-hop-env
      if (a.target.startsWith('hop_env_')) {
        this.ctx.warnLog?.push(`赋值目标 "${a.target}" 使用保留命名空间 hop_env_（spec 环境参数只读）`);
        return;
      }
      scope.set(a.target, await this.evalExpr(a.value, scope));
    } else if (stmt.type === 'call') {
      await this.evalExpr((stmt as CallStmt).call, scope);   // 副作用调用，丢弃返回值
    } else if (stmt.type === 'if') {
      const ifs = stmt as IfStmt;
      const cond = await this.evalExpr(ifs.condition, scope);
      if (isTruthy(cond)) await this.execStatements(ifs.then_body, scope);
      else if (ifs.else_body) await this.execStatements(ifs.else_body, scope);
    }
  }

  private async evalExpr(expr: ActExpr, scope: Map<string, unknown>): Promise<unknown> {
    switch (expr.type) {
      case 'literal':
        return expr.value;
      case 'var':
        if (!scope.has(expr.name)) throw new Error(`act body 引用未定义变量 "${expr.name}"`);
        return scope.get(expr.name);
      case 'field': {
        const obj = await this.evalExpr(expr.object, scope);
        if (obj === null || obj === undefined) {
          // 计算异常（调用方检 warnLog 非空 → 本步 fail;工具执行失败不属计算异常仍 throw）
          this.ctx.warnLog?.push(`计算异常: 在 None 上取字段 "${expr.field}" → None`);
          return null;
        }
        return (obj as Record<string, unknown>)[expr.field];
      }
      case 'unary': {
        const v = await this.evalExpr(expr.operand, scope);
        if (expr.op === 'not') return !isTruthy(v);
        return -toNumber(v);   // '-'
      }
      case 'index': {
        const obj = await this.evalExpr(expr.object, scope);
        const idx = await this.evalExpr(expr.index, scope);
        if (Array.isArray(obj)) {
          const n = typeof idx === 'number' ? idx : Number(idx);
          if (!Number.isInteger(n)) { this.ctx.warnLog?.push(`计算异常: 下标 ${JSON.stringify(idx)} 非整数 → None`); return null; }
          return obj[n < 0 ? obj.length + n : n];   // 负数下标 Python 语义（items[-1]=末元素）
        }
        if (obj !== null && typeof obj === 'object') return (obj as Record<string, unknown>)[String(idx)];
        this.ctx.warnLog?.push('计算异常: 在非数组/对象上取下标 → None');
        return null;
      }
      case 'slice': {
        // 序列切片 seq[start:stop]——钳位宽容（越界得空序列非报错,与单下标 None 传播分野;
        // ^anc-step-act-body-slice,2026-09-05） // @a: anc-step-act-body-slice
        const obj = await this.evalExpr(expr.object, scope);
        const start = expr.start === undefined ? undefined : await this.evalExpr(expr.start, scope);
        const stop = expr.stop === undefined ? undefined : await this.evalExpr(expr.stop, scope);
        const r = sliceValue(obj, start, stop);
        if (r.err) { this.ctx.warnLog?.push(r.err); return null; }
        return r.value;
      }
      case 'binary':
        return this.evalBinary(expr.op, expr.left, expr.right, scope);
      case 'call':
        return this.evalCall(expr as CallExpr, scope);
      // 字面量构造与 f-string（Python 对齐 2026-08-10 A 档）
      case 'list_literal': {
        const out: unknown[] = [];
        for (const el of expr.elements) out.push(await this.evalExpr(el, scope));
        return out;
      }
      case 'dict_literal': {
        const out: Record<string, unknown> = {};
        for (const en of expr.entries) {
          // 键=表达式求值后 str 归一（Python 对齐 2026-08-20;None 键计算异常响亮） // @a: anc-step-act-body-dict-key
          const kv = await this.evalExpr(en.key, scope);
          if (kv === null || kv === undefined) throw new Error('对象字面量键求值为 None——键须有值（字面量键写 {"k": v}）');
          out[typeof kv === 'string' ? kv : String(kv)] = await this.evalExpr(en.value, scope);
        }
        return out;
      }
      case 'fstring': {
        let s = '';
        for (const p of expr.parts) s += p.kind === 'text' ? p.text : formatFStringValue(await this.evalExpr(p.expr, scope));
        return s;
      }
      case 'ternary':   // 惰性求值——只算命中分支（未命中支的工具调用/异常都不发生,与 Python 同义）
        return isTruthy(await this.evalExpr(expr.condition, scope))
          ? await this.evalExpr(expr.then, scope)
          : await this.evalExpr(expr.else, scope);
      case 'comprehension': {   // 列表推导（^anc-step-act-body-comprehension:有界映射/过滤;迭代变量遮蔽外层同名,退出恢复）
        const src = await this.evalExpr(expr.source, scope);
        if (!Array.isArray(src)) throw new Error(`列表推导的遍历对象须为列表,实际: ${JSON.stringify(src)?.slice(0, 60)}`);
        const had = scope.has(expr.itemVar); const prev = scope.get(expr.itemVar);
        const out: unknown[] = [];
        for (const item of src) {
          scope.set(expr.itemVar, item);
          if (expr.filter && !isTruthy(await this.evalExpr(expr.filter, scope))) continue;
          out.push(await this.evalExpr(expr.element, scope));
        }
        if (had) scope.set(expr.itemVar, prev); else scope.delete(expr.itemVar);
        return out;
      }
      default: {
        // 逐节点类穷尽断言——ActExpr 加成员未接,tsc 编译红 // @a: anc-struct-expr-walk
        const _exhaustive: never = expr;
        throw new Error(`evalExpr 未覆盖节点: ${(_exhaustive as ActExpr).type}`);
      }
    }
  }

  private async evalBinary(op: string, leftE: ActExpr, rightE: ActExpr, scope: Map<string, unknown>): Promise<unknown> {
    // and/or 短路
    if (op === 'and') {
      const l = await this.evalExpr(leftE, scope);
      if (!isTruthy(l)) return l;
      return this.evalExpr(rightE, scope);
    }
    if (op === 'or') {
      const l = await this.evalExpr(leftE, scope);
      if (isTruthy(l)) return l;
      return this.evalExpr(rightE, scope);
    }
    const l = await this.evalExpr(leftE, scope);
    const r = await this.evalExpr(rightE, scope);
    // 计算异常:不可转数字/NaN 求值面折 null+warnLog 留痕,调用方检非空判本步 fail
    const num = (v: unknown): number => {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isNaN(n)) this.ctx.warnLog?.push(`计算异常: ${JSON.stringify(v)} 不可转数字（运算 ${op}）→ None`);
      return n;
    };
    const guard = (v: number): number | null => Number.isNaN(v) ? null : v;
    switch (op) {
      case '+':
        if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];   // 列表拼接（Python 语义;原数值强转 [1]+[2]=3 是 bug）
        if (typeof l === 'string' || typeof r === 'string') return String(l) + String(r);
        return guard(num(l) + num(r));
      case '-': return guard(num(l) - num(r));
      case '*': {
        // 字符串重复 "-" * 3（Python 语义）
        if (typeof l === 'string' && typeof r === 'number' && Number.isInteger(r)) return l.repeat(Math.max(0, r));
        if (typeof r === 'string' && typeof l === 'number' && Number.isInteger(l)) return r.repeat(Math.max(0, l));
        return guard(num(l) * num(r));
      }
      case '/': return guard(num(l) / num(r));
      case '==': return strictEq(l, r);
      case '!=': return !strictEq(l, r);
      case '<': case '>': case '<=': case '>=':
        return orderedCompare(op, l, r, this.ctx.warnLog ? m => this.ctx.warnLog!.push(m) : undefined);
      case '%': return guard(num(l) % num(r));
      case '//': return guard(Math.floor(num(l) / num(r)));
      case '**': return guard(Math.pow(num(l), num(r)));
      case 'in': return membershipTest(l, r, this.ctx.warnLog ? m => this.ctx.warnLog!.push(m) : undefined);
      case 'not in': { const v = membershipTest(l, r, this.ctx.warnLog ? m => this.ctx.warnLog!.push(m) : undefined); return v === null ? null : !v; }
      default: { this.ctx.warnLog?.push(`计算异常: 未知运算符 "${op}" → None`); return null; }
    }
  }

  // subprocess.run 专路（^anc-exec-subprocess-run——白名单命令行调用:参数解析/白名单核/
  // journal 重放/spawnSync 执行。HopSop 五步全在此,设计 design/act-body.md）。
  // @a: anc-exec-subprocess-run
  private async evalSubprocessRun(call: CallExpr, scope: Map<string, unknown>): Promise<unknown> {
    // 空名单拒移至 argv 解析后（0090——报文要点名命令;判空提前拒省一次解析不值一个哑报文）// @a: anc-exec-subprocess-run
    // 参数解析:位置参数恰一个(argv 列表);具名只认 input/timeout/cwd,其余点名拒
    //（B2 专项静态拦为先〔validator subprocess.run 块〕,此处运行期兜底双闸——名字带来
    // subprocess 的期望,期望逐条明确接或拒,不静默吞）
    let argv: unknown = undefined;
    let input: string | undefined;
    let timeoutSec = 60;
    let cwd: string | undefined;
    for (const a of call.args) {
      if (!a.name) {
        if (argv !== undefined) throw new Error('TOOL_EXEC_ERROR: subprocess.run 只接受一个位置参数（argv 列表）——命令与参数在同一个列表里,命令是第一个元素');
        argv = await this.evalExpr(a.value, scope);
        continue;
      }
      if (a.name === 'input') { input = String(await this.evalExpr(a.value, scope) ?? ''); continue; }
      if (a.name === 'timeout') {
        const t = Number(await this.evalExpr(a.value, scope));
        // 非法值早失败不带病执行（review F6 裁定 B——原 warn'按缺省60执行'文案撒谎:warnLog=fail
        // 既有定稿使实际=命令真跑完(副作用已发生)再炸步再重试重执行非幂等命令;非法参数是 spec
        // 写错,命令不该跑,与其余禁参同路 throw）。// @a: anc-exec-subprocess-run
        if (!Number.isFinite(t) || t <= 0) {
          throw new Error(`TOOL_EXEC_ERROR: subprocess.run timeout=${JSON.stringify(t)} 非法（须正数秒）——非法参数不执行命令,修 spec 里的 timeout 值`);
        }
        timeoutSec = t;
        continue;
      }
      if (a.name === 'cwd') { cwd = String(await this.evalExpr(a.value, scope)); continue; }
      throw new Error(`TOOL_EXEC_ERROR: subprocess.run 不支持参数 "${a.name}"——只认 input=/timeout=/cwd=;check= 恒拒(失败是值,returncode 的处置写 check 步或分支),shell= 恒拒(把 shell 走私进来白名单管控全失),capture_output 不需要(输出恒捕获)`);
    }
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every(x => typeof x === 'string')) {
      throw new Error('TOOL_EXEC_ERROR: subprocess.run 的 argv 必须是非空字符串列表（["git", "diff"] 形态——整串命令行 "git diff" 没有 shell 在解释,会找一个叫 "git diff" 的命令）');
    }
    const cmd = argv[0] as string;
    // hopjit 恒拒名单（^anc-exec-subprocess-deny-hopjit,2026-08-30 作者定——层次约束:被执行的
    // 步骤内容不得反过来驱动执行引擎,自嵌套执行必坏状态账;优先于白名单,白名单写了也不放行）
    // @a: anc-exec-subprocess-deny-hopjit
    if (cmd === 'hopjit' || cmd.split('/').pop() === 'hopjit') {
      throw new Error('TOOL_EXEC_ERROR: act/commit 步骤不得调用 hopjit——执行中的步骤不驱动引擎（自嵌套执行会破坏状态账）。跑别的 spec 用 [call <Id>] 步骤;通知等不可逆动作走注册工具的 commit 步骤;执行状态是引擎的账,步骤不查');
    }
    if (!this.ctx.commandWhitelist || this.ctx.commandWhitelist.length === 0) {
      throw new Error(`TOOL_EXEC_ERROR: 命令 "${cmd}" 无法执行——本执行环境未配置命令白名单（sandbox.runtime.available 为空=能力关死,缺省安全）。修法:把 ${cmd} 加进项目根 hopjit.yaml 的 commands: 列表（如 commands:\n  - ${cmd}）后重跑（hopissues/0090 指路条款）`);
    }
    if (!this.ctx.commandWhitelist.includes(cmd)) {
      throw new Error(`TOOL_EXEC_ERROR: 命令 "${cmd}" 不在白名单（sandbox.runtime.available: ${this.ctx.commandWhitelist.join(', ')}）。修法:把 ${cmd} 加进项目根 hopjit.yaml 的 commands: 列表（如 commands:\n  - ${cmd}）后重跑（hopissues/0090 指路条款）`);
    }
    // journal 重放:撞第 n 次取记录值不重执行（命令不幂等——git worktree add 二跑必败;
    // body 中断续跑从头重放,与 timeJournal 同款）
    const n = this.cmdSeq++;
    if (this.ctx.cmdJournal && n < this.ctx.cmdJournal.length) {
      return this.ctx.cmdJournal[n];
    }
    const r = spawnSync(cmd, (argv as string[]).slice(1), {
      input,
      timeout: timeoutSec * 1000,
      cwd: cwd ?? this.ctx.workZone ?? undefined,
      encoding: 'utf-8',
      shell: false,   // 恒定——参数列表制的物理保证,不是可选项
      maxBuffer: 10 * 1024 * 1024,
    });
    if (r.error) {
      // spawn 自身失败——真故障走 TOOL_EXEC_ERROR → 本步 fail 既有升级链;三类常见因指路
      //（review 抓 ENOBUFS 裸报不指路——设计"撞顶=步骤失败报文指路",不截断:截断的 stdout
      // 喂下游=静默数据缺角,比响亮失败更危险）。// @a: anc-exec-subprocess-run
      const code = (r.error as NodeJS.ErrnoException).code;
      const hint = code === 'ENOBUFS' ? '——输出超过 10MB 上限,用命令自带过滤收窄（如 git log --grep= 而非全量再筛）'
        : code === 'ETIMEDOUT' ? `——超时（timeout=${timeoutSec}s,可调大或收窄命令工作量）`
        : code === 'ENOENT' ? '——命令不存在（白名单里有名字但系统里找不到可执行文件）'
        : '';
      throw new Error(`TOOL_EXEC_ERROR: subprocess.run ["${cmd}", ...] 执行失败: ${r.error.message}${hint}`);
    }
    const rec = { stdout: r.stdout ?? '', stderr: r.stderr ?? '', returncode: r.status ?? -1 };
    this.ctx.cmdJournal?.push(rec);
    this.ctx.toolCallLog.push({ name: 'subprocess.run:' + cmd, result: rec.returncode === 0 ? 'success' : 'failure', at: isoNow() });
    return rec;
  }

  private async evalCall(call: CallExpr, scope: Map<string, unknown>): Promise<unknown> {
    // work_zone_path(rel?)：实例 work_zone 下的路径（无参=根）——需实例上下文，
    // 不走 ACT_BUILTINS 占位实现（2026-08-10 作者定名）。// @a: anc-exec-work-zone, anc-exec-work-zone-path
    if (call.callee === 'work_zone_path') {
      if (!this.ctx.workZone) throw new Error('TOOL_EXEC_ERROR: work_zone_path 不可用——本执行环境未提供 work_zone');
      const rel = call.args.length > 0 ? String(await this.evalExpr(call.args[0].value, scope)) : '';
      if (rel.includes('..')) throw new Error(`TOOL_EXEC_ERROR: work_zone_path 禁 .. 穿越: ${rel}`);
      return rel ? `${this.ctx.workZone}/${rel}` : this.ctx.workZone;
    }
    // subprocess.run 命令行白名单调用（^anc-exec-subprocess-run,2026-08-29 作者定 todo/0033）：
    // argv[0] ∈ 白名单(sandbox.runtime.available,缺席=关死);参数列表直接 spawnSync 不经 shell;
    // cmdJournal 重放(撞第 n 次取记录值不重执行——命令不幂等,git worktree add 二跑必败);
    // 失败是值(returncode 进结构体,处置归 check/分支)。// @a: anc-exec-subprocess-run
    if (call.callee === 'subprocess.run') {
      return this.evalSubprocessRun(call, scope);
    }
    // time 实例上下文内置（now/today）：journal 记值保重放确定性——撞第 n 次取记录值,
    // 缺席取真实时钟并追加。见 design/act-body.md ^anc-exec-time-builtins。// @a: anc-exec-time-builtins
    if (call.callee === 'now' || call.callee === 'today') {
      if (!this.ctx.timeJournal) throw new Error(`TOOL_EXEC_ERROR: ${call.callee} 不可用——本执行环境未提供时间上下文`);
      const n = this.timeSeq++;
      if (n < this.ctx.timeJournal.length) return this.ctx.timeJournal[n];
      const v = call.callee === 'now' ? isoNow() : isoNow().slice(0, 10);
      this.ctx.timeJournal.push(v);
      return v;
    }
    // 内置函数：位置参数
    const builtin = ACT_BUILTINS.get(call.callee);
    if (builtin) {
      const args = await Promise.all(call.args.map(a => this.evalExpr(a.value, scope)));
      // 计算异常=None+warnLog（2026-08-09 定稿的求值面统一罩——binary 分支早有,builtin 裸调漏罩
      // 至 2026-08-13 触发器设计实撞:int('3200元') 裸抛炸穿 advanceToCaller 而非走 fail 升级链）
      try { return builtin.fn(args); }
      catch (e) { this.ctx.warnLog?.push(`计算异常: ${call.callee}(...) 求值失败（${e instanceof Error ? e.message : String(e)}）→ None`); return null; }
    }
    // 否则视为 ToolProvider 工具：命名参数 → Record；先查 requires_commit 拦截
    const toolDef = this.ctx.toolProvider.list().find(t => t.name === call.callee);
    // 复用模式重放 provider（openToolSet）：名单开放——工具真伪由 caller 执行兜底（B2 validate 期已提示），
    // 不在引擎侧拦。独立模式（封闭名单）维持严格校验。// @a: anc-exec-tool-request
    const openSet = (this.ctx.toolProvider as { openToolSet?: boolean }).openToolSet === true;
    if (!toolDef && !openSet) {
      throw new Error(`TOOL_EXEC_ERROR: act body 调用未知工具/函数 "${call.callee}"（不在内置白名单也不在 ToolProvider 清单）`);
    }
    if (toolDef && !this.ctx.allowCommit && toolDef.requires_commit) {
      throw new Error(`COMMIT_REQUIRED: tool "${call.callee}" requires commit step`);
    }
    const argObj: Record<string, unknown> = {};
    for (const a of call.args) {
      if (!a.name) throw new Error(`act body 工具 "${call.callee}" 调用须用命名参数（如 ${call.callee}(arg: value)）`);
      argObj[a.name] = await this.evalExpr(a.value, scope);
    }
    // 写域随 allowCommit 分派（[[tools/file-tools#^anc-exec-builtin-file-tools]] 分域条款,2026-08-28）：
    // act/check body（allowCommit=false）→ 'work_zone',commit body → 'workspace'。
    // @a: anc-exec-write-scope
    const result = await this.ctx.toolProvider.execute(call.callee, argObj, this.ctx.allowCommit ? 'workspace' : 'work_zone');
    // 工具瞬时失败的重试归 ToolProvider 内部职责（execute 自己实现重试/超时）——
    // 解释器只调一次拿结果，与工具命名空间同归宿主。失败即抛，转容器级 retry。
    this.ctx.toolCallLog.push({
      name: call.callee,
      result: result.success ? 'success' : 'failure',
      at: new Date().toISOString(),
      ...(result.audit ?? {}),   // 外部工具 server 归属+耗时（anc-obs-audit）
    });
    if (!result.success) {
      // 对象错误序列化——失败面 result 经 in-process 模块/宿主注入 provider 可为对象,String()
      // 直转产 [object Object],FailRecord→replan 的适配依据被占位符吃掉（与 dispatcher 工具循环
      // 同族,^anc-exec-tool-result-render 防御性同判条款）。// @a: anc-exec-tool-result-render
      const errText = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      throw new Error(`TOOL_EXEC_ERROR: tool "${call.callee}" failed: ${errText}`);
    }
    return result.result;
  }
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) throw new Error(`act body 期望数字，实际: ${JSON.stringify(v)}`);
  return n;
}

// 宽松相等：数字与数字字符串可比（"3" == 3），其余按 ===
/** 纯表达式同步求值（case 条件用——无工具调用无 await，2026-08-09 表达式子集升格）。
 * scope 读取回调化：条件求值方（engine-traverse）用 VariableStore.read 提供。
 * 变量不存在返回 undefined（不抛——条件上下文里未定义按 falsy 走，与旧 evaluateCondition
 * 容忍语义一致；静态合法性由 C8 把守）。// @a: anc-rule-c8 */
/** 成员测试 x in xs（Python 语义，2026-08-10 对齐——替代原 contains 函数）：
 * 数组查元素（宽松等值）、字符串查子串、对象查键。其余类型=计算异常折 null。 */
function membershipTest(needle: unknown, hay: unknown, onWarn?: (msg: string) => void): boolean | null {
  if (Array.isArray(hay)) return hay.some(x => strictEq(x, needle));
  if (typeof hay === 'string') return hay.includes(String(needle));
  if (hay !== null && hay !== undefined && typeof hay === 'object') return String(needle) in (hay as Record<string, unknown>);
  onWarn?.(`计算异常: in 右侧期望数组/字符串/对象，实际 ${JSON.stringify(hay)} → None`);
  return null;
}

/** 序比较 < > <= >=（Python 语义同类型才可比，2026-08-11 作者定"心智用 python 一致"）：
 * 数字/bool 互比按数、双字符串字典序、双列表逐元素字典序（元素递归同规则）；
 * 其余组合（含数字×数字串、None/对象参比）=计算异常折 null。等值宽松不外溢至此。
 * 双求值器共用。// @a: anc-exec-ordered-compare */
function orderedCompare(op: '<' | '>' | '<=' | '>=', l: unknown, r: unknown, onWarn?: (msg: string) => void): boolean | null {
  // cmp: l<r → -1, l>r → 1, 相等 → 0, 不可比 → null
  const cmp = (a: unknown, b: unknown): number | null => {
    const aNum = typeof a === 'number' || typeof a === 'boolean';
    const bNum = typeof b === 'number' || typeof b === 'boolean';
    if (aNum && bNum) { const x = Number(a), y = Number(b); return x < y ? -1 : x > y ? 1 : 0; }
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const c = cmp(a[i], b[i]);
        if (c === null || c !== 0) return c;
      }
      return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
    }
    return null;
  };
  const c = cmp(l, r);
  if (c === null) {
    onWarn?.(`计算异常: ${op} 两侧类型不可比（Python 语义同类型才可比）: ${JSON.stringify(l)} ${op} ${JSON.stringify(r)} → None`);
    return null;
  }
  return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
}

/** 表达式同步求值（无工具无 IO 的纯求值面）——engine-traverse case 条件判定消费。见 [[act-body#^anc-exec-act-body-interp]] */
export function evalExprSync(expr: ActExpr, readVar: (name: string) => unknown, onWarn?: (msg: string) => void): unknown {
  switch (expr.type) {
    case 'literal': return expr.value;
    case 'var': return readVar(expr.name);
    case 'field': {
      const obj = evalExprSync(expr.object, readVar, onWarn);
      if (obj === null || obj === undefined) return undefined;
      if (Array.isArray(obj) && /^\d+$/.test(expr.field)) return obj[Number(expr.field)];
      return (obj as Record<string, unknown>)[expr.field];
    }
    case 'unary': {
      const v = evalExprSync(expr.operand, readVar, onWarn);
      return expr.op === 'not' ? !isTruthy(v) : -toNumber(v);
    }
    case 'binary': {
      const op = expr.op;
      if (op === 'and') { const l = evalExprSync(expr.left, readVar, onWarn); return isTruthy(l) ? evalExprSync(expr.right, readVar, onWarn) : l; }
      if (op === 'or') { const l = evalExprSync(expr.left, readVar, onWarn); return isTruthy(l) ? l : evalExprSync(expr.right, readVar, onWarn); }
      const l = evalExprSync(expr.left, readVar, onWarn);
      const r = evalExprSync(expr.right, readVar, onWarn);
      // 计算异常 = None + log（2026-08-09 作者定——HopSpec 无异常机制,错误载体唯一化为
      // None 值,log 保可观测;"静默折 false"与"当场炸"两个极端都废）。不可转数字即计算异常。
      const num = (v: unknown): number => {
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isNaN(n)) onWarn?.(`计算异常: ${JSON.stringify(v)} 不可转数字（运算 ${op}）→ None`);
        return n;
      };
      const guard = (v: unknown): unknown => (typeof v === 'number' && Number.isNaN(v)) ? undefined : v;   // NaN→None
      switch (op) {
        case '+': return (typeof l === 'string' || typeof r === 'string') ? String(l) + String(r) : guard(num(l) + num(r));
        case '-': return guard(num(l) - num(r));
        case '*': {
          if (typeof l === 'string' && typeof r === 'number' && Number.isInteger(r)) return l.repeat(Math.max(0, r));
          if (typeof r === 'string' && typeof l === 'number' && Number.isInteger(l)) return r.repeat(Math.max(0, l));
          return guard(num(l) * num(r));
        }
        case '/': return guard(num(l) / num(r));
        case '==': return strictEq(l, r);
        case '!=': return !strictEq(l, r);
        case '<': case '>': case '<=': case '>=': {
          const v = orderedCompare(op, l, r, onWarn);
          return v === null ? undefined : v;
        }
        case '%': return guard(num(l) % num(r));
        case '//': return guard(Math.floor(num(l) / num(r)));
        case '**': return guard(Math.pow(num(l), num(r)));
        case 'in': { const v = membershipTest(l, r, onWarn); return v === null ? undefined : v; }
        case 'not in': { const v = membershipTest(l, r, onWarn); return v === null ? undefined : !v; }
        default: return undefined;
      }
    }
    case 'index': {
      const obj = evalExprSync(expr.object, readVar, onWarn);
      const idx = evalExprSync(expr.index, readVar, onWarn);
      if (Array.isArray(obj)) {
        const n = typeof idx === 'number' ? idx : Number(idx);
        if (!Number.isInteger(n)) { onWarn?.(`计算异常: 下标 ${JSON.stringify(idx)} 非整数 → None`); return undefined; }
        return obj[n < 0 ? obj.length + n : n];   // 负数下标 Python 语义
      }
      if (obj !== null && typeof obj === 'object') return (obj as Record<string, unknown>)[String(idx)];
      return undefined;
    }
    case 'slice': {
      // 序列切片同步档（条件表达式里切片可用——^anc-step-act-body-slice） // @a: anc-step-act-body-slice
      const obj = evalExprSync(expr.object, readVar, onWarn);
      const start = expr.start === undefined ? undefined : evalExprSync(expr.start, readVar, onWarn);
      const stop = expr.stop === undefined ? undefined : evalExprSync(expr.stop, readVar, onWarn);
      const r = sliceValue(obj, start, stop);
      if (r.err) { onWarn?.(r.err); return undefined; }
      return r.value;
    }
    case 'call': {
      // 内置 pure 函数条件可用（2026-08-10 作者定——零副作用可反复求值,如 len(items) > 0）；
      // 工具调用仍禁（C8 静态拒,此处防御性折计算异常）。
      const builtin = ACT_BUILTINS.get(expr.callee);
      if (!builtin) { onWarn?.(`计算异常: 条件调用非 pure 函数 "${expr.callee}" → None`); return undefined; }
      const args = expr.args.map(a => evalExprSync(a.value, readVar, onWarn));
      try { return builtin.fn(args); }
      catch (e) { onWarn?.(`计算异常: ${expr.callee}(...) 求值失败（${e instanceof Error ? e.message : String(e)}）→ None`); return undefined; }
    }
    case 'list_literal': return expr.elements.map(el => evalExprSync(el, readVar, onWarn));
    case 'dict_literal': {
      const out: Record<string, unknown> = {};
      for (const en of expr.entries) {
        const kv = evalExprSync(en.key, readVar, onWarn);
        if (kv === null || kv === undefined) { onWarn?.('对象字面量键求值为 None'); continue; }
        out[typeof kv === 'string' ? kv : String(kv)] = evalExprSync(en.value, readVar, onWarn);
      }
      return out;
    }
    case 'fstring': {
      let s = '';
      for (const p of expr.parts) s += p.kind === 'text' ? p.text : formatFStringValue(evalExprSync(p.expr, readVar, onWarn));
      return s;
    }
    case 'ternary':   // 惰性求值——只算命中分支（与 async 求值器同义）
      return isTruthy(evalExprSync(expr.condition, readVar, onWarn))
        ? evalExprSync(expr.then, readVar, onWarn)
        : evalExprSync(expr.else, readVar, onWarn);
    case 'comprehension': {   // 列表推导——迭代变量经包装 readVar 注入,遮蔽外层同名 // @a: anc-step-act-body-comprehension
      const src = evalExprSync(expr.source, readVar, onWarn);
      if (!Array.isArray(src)) { onWarn?.(`列表推导的遍历对象须为列表,实际: ${JSON.stringify(src)?.slice(0, 60)}`); return undefined; }
      const out: unknown[] = [];
      for (const item of src) {
        const scopedRead = (name: string) => name === expr.itemVar ? item : readVar(name);
        if (expr.filter && !isTruthy(evalExprSync(expr.filter, scopedRead, onWarn))) continue;
        out.push(evalExprSync(expr.element, scopedRead, onWarn));
      }
      return out;
    }
    default: {
      // 逐节点类穷尽断言 // @a: anc-struct-expr-walk
      const _exhaustive: never = expr;
      throw new Error(`evalExprSync 未覆盖节点: ${(_exhaustive as ActExpr).type}`);
    }
  }
}

/** f-string 插值格式化：None→"None"（Python 同形）、对象/数组→JSON、其余 String()。 */
function formatFStringValue(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 等值 ==/!=（Python 严格语义，2026-08-11 作者定删宽松等值——原 looseEq 数字串特赦废，
 * 输出边界已归一转换后语言内零跨类型特例）：None/未赋值同为"无值"互等（x == None 命中
 * 两者——值模型事实）；数字/bool 家族按数（True == 1 真，Python 同义）；列表/对象深比较
 * 逐元素递归；跨类型不相等不异常（"3" == 3 假）。membershipTest 元素查找同语义。
 * // @a: anc-exec-ordered-compare */
function strictEq(l: unknown, r: unknown): boolean {
  if (l === r) return true;
  if ((l === null || l === undefined) && (r === null || r === undefined)) return true;
  const lNum = typeof l === 'number' || typeof l === 'boolean';
  const rNum = typeof r === 'number' || typeof r === 'boolean';
  if (lNum && rNum) return Number(l) === Number(r);
  if (Array.isArray(l) && Array.isArray(r)) {
    return l.length === r.length && l.every((x, i) => strictEq(x, r[i]));
  }
  if (typeof l === 'object' && typeof r === 'object' && l !== null && r !== null && !Array.isArray(l) && !Array.isArray(r)) {
    const lk = Object.keys(l as Record<string, unknown>); const rk = Object.keys(r as Record<string, unknown>);
    return lk.length === rk.length && lk.every(k => k in (r as Record<string, unknown>)
      && strictEq((l as Record<string, unknown>)[k], (r as Record<string, unknown>)[k]));
  }
  return false;
}

// ISO 8601 本地时区时刻（time 内置的真实时钟源——单点,便于测试替身）。// @a: anc-exec-time-builtins
function isoNow(): string {
  const d = new Date();
  const pad = (x: number, w = 2) => String(x).padStart(w, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// @a: anc-step-act-body-slice
/** 切片求值共用件：钳位宽容语义（Python 切片本款——越界钳边界、负端点 len+n 换算、start>=stop 得空;
 * 数组与字符串同语义,其他类型/非整数端点=计算异常文案返回。^anc-step-act-body-slice） */
function sliceValue(obj: unknown, start: unknown, stop: unknown): { value?: unknown[] | string; err?: string } {
  const isArr = Array.isArray(obj);
  const isStr = typeof obj === 'string';
  if (!isArr && !isStr) return { err: '计算异常: 在非列表/字符串上切片 → None' };
  const len = isArr ? (obj as unknown[]).length : (obj as string).length;
  const norm = (v: unknown, dflt: number): number | null => {
    // None 与 undefined 一律按端点缺席（值模型"None 与未赋值同视为无值"归一;Python 本款 l[:None]=全量。
    // 2026-09-05 review 抓:原 Number() 强转使 None 静默当 0、数字串静默过——与设计"非整数=计算异常"不符）
    if (v === undefined || v === null) return dflt;
    const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : NaN;   // bool 当 0/1=Python 本款;数字串/其余不再强转
    if (!Number.isInteger(n)) return null;
    const adjusted = n < 0 ? len + n : n;
    return Math.max(0, Math.min(len, adjusted));
  };
  const s = norm(start, 0);
  const e = norm(stop, len);
  if (s === null || e === null) return { err: '计算异常: 切片端点非整数 → None' };
  if (s >= e) return { value: isArr ? [] : '' };
  return { value: isArr ? (obj as unknown[]).slice(s, e) : (obj as string).slice(s, e) };
}
