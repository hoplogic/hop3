// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: hoplog ^anc-obs-hoplog
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// 三级日志：debug ⊇ info ⊇ warn。审计性字段无视级别始终记录。
export type LogLevel = 'debug' | 'info' | 'warn'; // @a: anc-obs-log-levels

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2,
};

/** 从 HopLog YAMLL 提取真实步骤块键（如 1 / 1.1 / 1.1#2）。
 * 块键格式的单一事实源：resume 重建与 carrier-live-e2e G11 共同消费，禁止另造 `step:` 字段。
 * // @a: anc-obs-step-keys */
export function extractHopLogStepKeys(text: string): string[] {
  const executionAt = text.search(/^execution:\s*$/m);
  if (executionAt < 0) return [];
  const execution = text.slice(executionAt);
  const re = /^( +)(?:"([\d.]+(?:#\d+)?)"|([\d.]+(?:#\d+)?)):\s*$/gm;
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(execution)) !== null) {
    const key = match[2] ?? match[3];
    const base = key.split('#', 1)[0];
    // YAMLL 的步骤块头缩进严格为 step-id 深度 × 2。除了落实格式契约，这也避免
    // outputs/metadata 中形似数字的普通 mapping key 被误当成步骤记录。
    if (match[1].length === base.split('.').length * 2) keys.push(key);
  }
  return keys;
}

// 审计性字段：步骤行为的属性，任何级别都写入 // @a: anc-obs-audit
export interface ToolCallRecord {
  name: string;
  result: 'success' | 'failure';
  at: string;
  server?: string;        // 外部工具归属（mcp 绑定的 server 逻辑名）——内置工具缺席
  duration_ms?: number;   // 外部调用耗时（出引擎进程,延迟是审计必需——五点需求⑤）
}

/** commit 步骤的审计字段：不可逆操作的目标、授权来源、结果、时间——审计性字段，无视日志级别始终记录。见 [[spec-observability#^anc-obs-audit]] */
export interface CommitAuditRecord {
  target?: string;
  authorized_by: 'human' | 'caller' | 'policy' | 'none';
  result: 'success' | 'failure';
  at: string;
}

/** confirm 步骤的 HITL 记录：人的决策、决策者、结构化选项——审计性字段，任何级别都写入。见 [[spec-observability#^anc-obs-hitl-record]] */
export interface HitlRecord { // @a: anc-obs-hitl-record
  shown?: string;                    // 展示给人的问题面（=summary,与 paused question 同源——#34 受众分流后 instruction 不进人眼;选项归 response_options,instruction 审计痕在 paused 卡整卡）
  response?: string;
  responder?: 'human' | 'caller';
  // 结构化选项 {value,label}——设计契约形态；string[] 旧形态兼容读（写侧一律结构化）。
  // 2026-08-08 语义审计 ❌ 修复：原 options: string[] 扁平化丢 label。
  response_options?: Array<{ value: string; label?: string }>;
  /** @deprecated 旧扁平形态,仅兼容既有调用方,新代码用 response_options */
  options?: string[];
  at?: string;
}

// replan 提报记录(降级阶梯第3/4档运行时生成,供离线沉淀)// @a: anc-obs-replan-audit
export interface ReplanAuditRecord {
  spec_id: string;
  step_id: string;
  error_reason: string;
  generated_children: Array<{ step_id: string; step_type: string; summary: string; outputs: string[] }>;
  base: 'scratch' | 'fallback';
  at: string;
}

// 步骤特有字段类型（recordStepMeta 入参）// @a: anc-obs-step-mapping
export interface StepMeta {
  // 审计性字段（始终记录）——不可逆/敏感操作的追责记录
  tool?: ToolCallRecord[];
  commit_audit?: CommitAuditRecord;
  hitl?: HitlRecord;
  callee_spec_id?: string;
  // 流控轨迹字段（info 级）
  knowledge?: Array<{ source_id: string; at: string }>;  // 只读知识检索，非审计范畴
  doc_refs?: Array<{ source_id: string; at: string }>;   // doc-ref [[doc#章节]] 确定性引用注入， // @a: anc-exec-doc-ref-resolve
  retry?: { attempt: number; max: number };
  // L2c 重试反馈落账（info 级流控字段,2026-08-22 补——只藏在 debug 级 prompt 全文里时,
  // info 日志让走查者误判"重试无记忆"〔ppt11 实撞〕;体量小价值高,还原重跑决策依据）。
  // 见 spec-observability ^anc-obs-log-levels。// @a: anc-exec-l2c-retry-feedback
  retry_feedback?: { attempt: number; reason: string };
  taken?: string;        // branch: selected case step_id
  condition?: string;    // case: condition expression
  // LLM 轨迹（model/tokens 为 info 级；prompt/response 为 debug 级,在 recordStepMeta 内剥离）。
  // prompt = 发送边界从实际 request 对象序列化的字节（^anc-obs-record-at-boundary 2026-08-24:
  // 独立模式由 dispatcher 在 API 调用处成对记录——旧形态只在 engine recordStepStart 记
  // formatPromptText 渲染件,意图层记录与实发内容分叉,假 prompt 骗过十几轮走查）。
  // response = LLM 原始回复全文（解析前 text content,DEBT-09:每轮尝试独立落账丢弃轮保痕）。
  // @a: anc-obs-llm-response, anc-obs-record-at-boundary
  llm?: { model?: string; max_tokens?: number; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; prompt?: string; response?: string };   // cache 两字段:缓存观测（openai 协议 null 如实记）;max_tokens=当次请求实发上限（发送口抄实际参数,^anc-exec-output-budget 观测条）// @a: anc-exec-cache-control, anc-exec-output-budget
  tokens_used?: number;
  // adaptive 三段流水线中间产物（生成侧留痕——离线审核候选文件时对照"当时怎么想的"）。
  // 见 step-dispatcher ^anc-exec-adaptive-pipeline。// @a: anc-exec-adaptive-pipeline
  replan_pipeline?: { failure_analysis?: string; replan_strategy?: string };
  // submitReplan 拒因原文（0030）——错误凭证类,审计通道恒写（P2 对齐裁定:失败凭证严重度≥warn,
  // 挂流控通道=归类错误,warn 级用户恰恰最该看到;见 spec-observability ^anc-obs-audit 归类判据）
  submit_rejected?: string[];
}

/** HopLog 构造选项：spec_id、日志目录、最低记录级别等——决定 run 目录命名与级别裁剪深度。见 [[spec-observability#^anc-obs-file-layout]] */
export interface HopLogOptions {
  specId: string;
  logDir: string;
  level?: LogLevel;
  title: string;
  goal: string;
  inputs?: Record<string, unknown>;
  traceId?: string;  // 跨 run 关联:worker 子实例继承父 trace_id
}

// 审计性字段 key 集合——写入时无视日志级别
const AUDIT_FIELDS = new Set<string>(['tool', 'commit_audit', 'hitl', 'callee_spec_id', 'submit_rejected']);
// 流控轨迹字段——info 级写入
const FLOW_FIELDS = new Set<string>(['knowledge', 'doc_refs', 'retry', 'retry_feedback', 'taken', 'condition', 'llm', 'tokens_used', 'replan_pipeline']);
// 编译期穷举校验：AUDIT ∪ FLOW 必须覆盖 StepMeta 全部 key——新增字段若未归类，下行报错，
// 避免 recordStepMeta 分级判据（!isAudit && isFlow）把未知字段静默当"始终记录"。
type _MetaFieldsCovered = Exclude<keyof StepMeta, 'tool' | 'commit_audit' | 'hitl' | 'callee_spec_id' | 'submit_rejected' | 'knowledge' | 'doc_refs' | 'retry' | 'retry_feedback' | 'taken' | 'condition' | 'llm' | 'tokens_used' | 'replan_pipeline'>;
const _metaFieldsCovered: _MetaFieldsCovered extends never ? true : never = true;
void _metaFieldsCovered;

/**
 * HopLog 执行轨迹日志——唯一信息源是 main.yaml 文件本身。
 * 每个 record* 方法实时 appendFileSync，无内存镜像（查询已记录内容请读文件）。
 */
export class HopLog { // @a: anc-obs-hoplog, anc-obs-execution-log-absorption
  private level: LogLevel;
  private runDir: string;
  private filePath: string;
  // 已 start 的步骤集合——守卫孤儿字段（步骤未 start 时 done/meta/warn 不写入）
  private startedSteps = new Set<string>();
  // 延迟 resume marker：resume() 只暂存时间戳，由下一次写入按正确层级落盘（三出口之一：emitResumed
  // 续未完成 step / recordStepStart 内联接新 step / flushTopLevelResume 顶层收尾）。
  // 避免旧实现把裸注释砸进未闭合 prompt 块标量中间破坏 YAML。见 design ^anc-obs-hoplog-resume。
  private pendingResume: string | null = null;
  // loop 多轮：hoplog 展示态轮次计数。同一 loop 子步 step-id 每轮重复（4.1 每轮同名），
  // 嵌套后成同层重复 key（YAML 非法）——检测"已 done 过的 step 又 start"=新轮次、+1，
  // hoplog key 写 `4.1#2`（#iter 仅展示 key，不碰 step-id 铁钉、depth 仍按点号算）。
  // 与 startedSteps 同性质的展示态计数，不违反"无内存镜像"。见 design ^anc-obs-nested-tree。
  private iterCounts = new Map<string, number>();
  // 已 done 的 step（判 loop 新轮：已 done 又 start = 进入下一轮）。
  private doneSteps = new Set<string>();
  // 已写过 resumed_at 的 step——同一 step 只落一个 resumed_at（多次 resume 续同一未完成 step 会各触发
  // emitResumed，重复写语义冗余）。首次恢复的 marker 足以标记"该 step 曾被恢复"，后续恢复不再重复写。
  // resume 重建时从文件扫已有 resumed_at 行填入（跨进程去重）。顶层事件（close/replan）用空串 '' 记。
  private resumedWritten = new Set<string>();

  constructor(options: HopLogOptions) {
    this.level = options.level ?? 'debug';   // 缺省 debug（2026-08-23 作者定'把缺省日志全部调成 debug 级'——日志是核验通道缺省即全息;两撞:standalone info 黑箱/走查被 200 字截断误导。降级走显式配置） // @a: anc-obs-log-levels
    const runId = generateRunId();
    this.runDir = join(options.logDir, `${options.specId}-${runId}`); // @a: anc-obs-file-layout
    mkdirSync(this.runDir, { recursive: true });
    this.filePath = join(this.runDir, 'main.yaml');

    // Header — written immediately。spec_id（用户在 spec 写的 Id:）/trace_id（调用方传入）走 toYaml 转义
    // ——外部来源值含空格/冒号/特殊字符会破 YAML header；run_id（内部生成固定格式）/level（枚举）无需。
    // 见 ARCHITECTURE.md ^anc-string-escape（hoplog YAML 通道 + 来源判据;原 DESIGN.md 已并入,0086 批随批清死引用）。// @a: anc-string-escape
    this.append(`spec_id: ${toYaml(options.specId)}\n`);
    this.append(`run_id: ${runId}\n`);
    // traceId 未传时兜底 runId（带时间戳后缀非纯 UUID）——防御性保证 header 恒有 trace_id；
    // 生产路径 engine 恒传（顶层=instanceId/worker=父id），兜底仅直接构造 HopLog 的测试/工具场景。
    this.append(`trace_id: ${toYaml(options.traceId ?? runId)}\n`); // @a: anc-obs-trace-inherit
    this.append(`level: ${this.level}\n`);
    this.append(`started_at: ${toYaml(timestamp())}\n`);
    // title/goal 在 spec: 下的 2 空格层级；多行值走 block scalar，内容须比键更深缩进（indent=1 → 内容 4 空格 > 键 2 空格）。
    // 不传 indent 时多行 goal 的 block scalar 内容仅 2 空格 = 键缩进 → YAML 非法（block 判空 + 内容行无冒号）。
    this.append(`spec:\n  title: ${toYaml(options.title, 1)}\n  goal: ${toYaml(options.goal, 1)}\n`);
    const filteredInputs = this.filterValues(options.inputs);
    if (filteredInputs && Object.keys(filteredInputs).length > 0) {
      this.append(`inputs:\n${toYaml(filteredInputs, 1)}\n`);
    }
    this.append(`execution:\n`);
  }

  static resume(runDir: string, level?: LogLevel): HopLog { // @a: anc-obs-hoplog-resume
    const log = Object.create(HopLog.prototype) as HopLog;
    log.runDir = runDir;
    log.filePath = join(runDir, 'main.yaml');
    // 从已有 main.yaml 头部读取 level（跨进程恢复时保持原 run 的日志级别）
    if (!level && existsSync(log.filePath)) {
      const head = readFileSync(log.filePath, 'utf-8').slice(0, 500);
      const m = head.match(/^level:\s*(debug|info|warn)/m);
      if (m) level = m[1] as LogLevel;
    }
    log.level = level ?? 'info';
    // 从已有 main.yaml 重建 startedSteps——跨进程恢复时守卫不能丢已记录的步骤，
    // 否则下一进程的 recordStepDone 会误判为孤儿。步骤记录格式：`  "<id>":` 或 `  <id>:`（二级缩进）
    log.startedSteps = new Set();
    log.iterCounts = new Map<string, number>();
    log.doneSteps = new Set<string>();
    log.pendingWarns = new Map<string, string[]>();   // Object.create 绕过字段初始化器（#29）
    log.resumedWritten = new Set<string>();
    if (existsSync(log.filePath)) {
      const text = readFileSync(log.filePath, 'utf-8');
      for (const key of extractHopLogStepKeys(text)) {
        const hash = key.indexOf('#');
        if (hash >= 0) {
          // loop 多轮 key `4.1#2`：还原 step-id + 重建轮次计数（取最大 N）
          const base = key.slice(0, hash);
          const iter = Number(key.slice(hash + 1));
          log.startedSteps.add(base);
          if (Number.isFinite(iter)) log.iterCounts.set(base, Math.max(log.iterCounts.get(base) ?? 1, iter));
        } else {
          log.startedSteps.add(key);
        }
      }
      // 重建 doneSteps：loop 新轮的判据是"已 **done** 又 start"，**不是**"已 started 又 start"——
      // resume 续一个**未完成**的 step（如 subtask 内某 act 中断、resume 重发其 step_ready 再走
      // recordStepStart）不是新轮，误当新轮会生成错误的 #iter key（实测 v3：4.2 中断 resume → "4#2"/"4.2#2"）。
      // 故 doneSteps 只收文件中**真正终态**的 step：栈式单遍——step key 入栈，遇 status: completed/failed
      // 标记其归属 step（缩进比 status 浅 2 的最近 step key）为 done。
      const lines = text.split('\n');
      const stepStack: Array<{ id: string; indent: number }> = [];
      for (const line of lines) {
        if (line.trim() === '') continue;
        const indent = line.length - line.trimStart().length;
        const keyMatch = line.match(/^ +(?:"([\d.]+(?:#\d+)?)"|([\d.]+(?:#\d+)?)):\s*$/);
        if (keyMatch) {
          const key = keyMatch[1] ?? keyMatch[2];
          const base = key.indexOf('#') >= 0 ? key.slice(0, key.indexOf('#')) : key;
          while (stepStack.length && stepStack[stepStack.length - 1].indent >= indent) stepStack.pop();
          stepStack.push({ id: base, indent });
          continue;
        }
        const sm = line.match(/^( +)status: (completed|failed)\s*$/);
        if (sm) {
          const stInd = sm[1].length;
          // status 归属：缩进恰为 stInd-2 的最近 step（栈顶应是它）
          for (let i = stepStack.length - 1; i >= 0; i--) {
            if (stepStack[i].indent === stInd - 2) { log.doneSteps.add(stepStack[i].id); break; }
          }
        }
        // resumed_at 归属：填 resumedWritten 去重（跨进程——本进程 resume 续同 step 不再重写第二个 resumed_at）。
        const rm = line.match(/^( *)resumed_at:/);
        if (rm) {
          const rInd = rm[1].length;
          if (rInd === 0) { log.resumedWritten.add(''); }  // 顶层 resumed_at（close/replan）
          else for (let i = stepStack.length - 1; i >= 0; i--) {
            if (stepStack[i].indent === rInd - 2) { log.resumedWritten.add(stepStack[i].id); break; }
          }
        }
      }
      // startedSteps 已含文件中所有写过骨架的 step（含未 done 的）——recordStepStart 幂等判据直接用它：
      // startedSteps 有且未 done = resume 续/ recover 重发，跳过骨架只补 resumed_at（见 recordStepStart）。
    }
    mkdirSync(runDir, { recursive: true });

    // resume marker 延迟写入：不在此 append（可能砸进上一步未闭合的 prompt 块标量中间破坏
    // YAML），仅暂存时间戳，由下一次写入按正确层级落成结构化字段 resumed_at（三出口见 pendingResume 声明处）。
    // 见 design ^anc-obs-hoplog-resume。
    log.pendingResume = timestamp();
    return log;
  }

  // resumed_at 的**顶层出口**（close/replan 场景）：resume 后未再写任何 step 就直接终态/重规划时，
  // 把暂存的 marker 落成顶层字段（0 缩进，stepKey 用空串 '' 去重）。另两个出口按落点分工：
  // ① emitResumed(stepId)——resume 续**未完成** step（recordStepStart 幂等分支）；
  // ② recordStepStart 内联——resume 后首个**新** step，作该 step 块字段。
  // 三出口对应三种真实落点语义，不合一（旧设计企图用单个 flushResume 从 stepId 反推缩进覆盖所有场景，
  // 嵌套 resume/多次 flush 时归属错乱、resumed_at 落错层截断 YAML，实测崩——故按落点拆分）。
  // pendingResume 非空且顶层未写过才落，写后清空——天然幂等，多次调用仅首次落、余次 no-op。
  // 见 design ^anc-obs-hoplog-resume / ^anc-obs-nested-tree。// @a: anc-obs-hoplog-resume
  private flushTopLevelResume(): void {
    if (this.pendingResume === null) return;
    // 顶层 resumed_at 已写过（stepKey=''）→ 不重复写；仍清 pendingResume 避免它漏到别处。
    if (this.resumedWritten.has('')) { this.pendingResume = null; return; }
    this.append(`resumed_at: ${toYaml(this.pendingResume)}\n`);
    this.resumedWritten.add('');
    this.pendingResume = null;
  }

  // step-id 点号深度 = 树层级（顶层=1）。缩进纯函数：key 前导 2d、body 字段 2d+2、子块值基准 d+2
  // （toYaml 的 indentLevel 单位是 2 空格，d+2 对应 2d+4 空格）。#iter 后缀不影响深度。见 design ^anc-obs-nested-tree。
  private stepDepth(stepId: string): number {
    const base = stepId.split('#')[0];
    return base.split('.').length;
  }
  private ind(spaces: number): string { return ' '.repeat(spaces); }

  // hoplog 展示 key：loop 多轮子步加 `#iter` 区分（iterCounts 记当前轮次）。首轮及非重复 step 无后缀。
  private hoplogKey(stepId: string): string {
    const iter = this.iterCounts.get(stepId);
    return iter && iter > 1 ? `${stepId}#${iter}` : stepId;
  }

  // YAMLL 块头：写 `<2d>"<step-id>":`（缩进 = step 深度，供折叠）。每个 record 事件自成一块。
  // 见 design/spec-observability.md ^anc-obs-nested-tree（v3 YAMLL）。// @a: anc-obs-nested-tree
  private blockHeader(stepId: string): void {
    this.append(`${this.ind(2 * this.stepDepth(stepId))}${toYaml(this.hoplogKey(stepId))}:\n`);
  }

  recordStepStart(stepId: string, type: string, summary: string, inputs?: Record<string, unknown>, promptText?: string): void { // @a: anc-obs-debug-context
    // loop/retry 新轮：已终态（done/failed）的 step 又 start = 下一轮 → 轮次 +1（hoplog key 加 #iter）。
    if (this.doneSteps.has(stepId)) {
      this.iterCounts.set(stepId, (this.iterCounts.get(stepId) ?? 1) + 1);
      this.doneSteps.delete(stepId);
      // 新轮的 start 块必须真实写出——同时清 startedSteps,否则落进下方 resume 去重分支被吞成
      // resumed 标记,新轮无 #N 块键(2026-08-10 cc:repair e2e 实撞:3.2 失败重跑三轮全记 "3.2",
      // 轮次键断言红;3.1 恰好跨进程重建走文件路径未撞)。// @a: anc-obs-nested-tree
      this.startedSteps.delete(stepId);
    }
    // resume 续未完成 / recover 重发（可能多次）：start 块已写过 → 不重写，只写一个 resumed 块（去重）。
    // YAMLL 下这不是"避免重复 key"（块间本就允许重复 step-id），而是语义去重：一次恢复标一次。
    if (this.startedSteps.has(stepId)) {
      this.emitResumed(stepId);
      return;
    }
    this.startedSteps.add(stepId);

    const d = this.stepDepth(stepId);
    const f = 2 * d + 2;
    this.blockHeader(stepId);   // 独立块：块头 `<2d>id:`
    this.append(`${this.ind(f)}type: ${type}\n`);
    this.append(`${this.ind(f)}summary: ${toYaml(summary)}\n`);
    this.append(`${this.ind(f)}at: ${toYaml(timestamp())}\n`);
    // resume 后首个新 step：进程在此恢复——resumed_at 作本块字段落盘（本块的 f，天然对齐），一次即清。
    if (this.pendingResume !== null && !this.resumedWritten.has(stepId)) {
      this.append(`${this.ind(f)}resumed_at: ${toYaml(this.pendingResume)}\n`);
      this.resumedWritten.add(stepId);
      this.pendingResume = null;
    }
    const filtered = this.filterValues(inputs);
    if (filtered && Object.keys(filtered).length > 0) {
      this.append(`${this.ind(f)}inputs:\n${toYaml(filtered, d + 2)}\n`);
    }
    // debug 级记录完整 prompt（给 LLM 的完整输入——6 层格式化文本）
    if (promptText && this.level === 'debug') {
      this.append(`${this.ind(f)}llm:\n`);
      this.append(`${this.ind(f + 2)}prompt: ${toYaml(promptText, d + 2)}\n`);
    }
    this.flushPendingWarns(stepId);   // 组装期暂存告警冲账（#29）
  }

  // resume marker：自成一块 `<2d>id:` + `<2d+2>resumed_at:`。resume 时就知道续的是哪个 step
  // （engine 从 state.json running 传入），块头即用它，缩进自算——不再延迟到"下一次调用"。
  // 同 step 已写过 resumed 块则跳过（多次 resume 只标一次）。// @a: anc-obs-hoplog-resume
  private emitResumed(stepId: string): void {
    if (this.pendingResume === null) return;
    if (this.resumedWritten.has(stepId)) { this.pendingResume = null; return; }
    this.blockHeader(stepId);
    this.append(`${this.ind(2 * this.stepDepth(stepId) + 2)}resumed_at: ${toYaml(this.pendingResume)}\n`);
    this.resumedWritten.add(stepId);
    this.pendingResume = null;
  }

  // 孤儿写入 = Engine 调用序列 bug 的信号——写入错误标记暴露问题，但不抛异常打断执行
  private guardOrphan(stepId: string, method: string): boolean {
    if (this.startedSteps.has(stepId)) return true;
    this.append(`# ERROR: orphan ${method}("${stepId}") — step never started (caller sequence bug)\n`);
    return false;
  }

  recordStepDone(stepId: string, outputs?: Record<string, unknown>): void {
    if (!this.guardOrphan(stepId, 'recordStepDone')) return;

    const d = this.stepDepth(stepId);
    const f = 2 * d + 2;
    this.blockHeader(stepId);   // YAMLL：done 自成一块（块头 `<2d>id:`，与 start 块同 step-id、独立）
    const filtered = this.filterValues(outputs);
    if (filtered && Object.keys(filtered).length > 0) {
      if (this.level === 'debug') {
        this.append(`${this.ind(f)}response:\n${toYaml(filtered, d + 2)}\n`);
      }
      this.append(`${this.ind(f)}outputs:\n${toYaml(filtered, d + 2)}\n`);
    }
    this.append(`${this.ind(f)}status: completed\n`);
    this.append(`${this.ind(f)}completed_at: ${toYaml(timestamp())}\n`);
    this.doneSteps.add(stepId); // 标记已 done（loop 再次 start 同 id → 新轮次）
  }

  recordStepFailed(stepId: string, reason: string, failKind: string = 'error'): void {
    if (!this.guardOrphan(stepId, 'recordStepFailed')) return;

    const d = this.stepDepth(stepId);
    const f = 2 * d + 2;
    this.blockHeader(stepId);   // YAMLL：failed 自成一块
    this.append(`${this.ind(f)}status: failed\n`);
    this.append(`${this.ind(f)}failed_at: ${toYaml(timestamp())}\n`);
    this.append(`${this.ind(f)}fail_kind: ${toYaml(failKind)}\n`);
    // 块标量续行须比字段行深（2026-08-31 作者实抓:漏传 indent 续行浅于字段行,多行 reason
    // 提前终止块标量整文非法——check note 多行失败原因首撞）。f 是空格数,toYaml 收两空格档。
    this.append(`${this.ind(f)}reason: ${toYaml(sanitize(reason), f / 2)}\n`);
    this.doneSteps.add(stepId); // 标记已终态（loop 再次 start 同 id → 新轮次）
  }

  /**
   * 记录步骤特有字段。审计性字段（tool/commit_audit/hitl/callee_spec_id）
   * 无视日志级别始终写入；流控轨迹字段（knowledge/retry/taken/condition/llm/tokens_used）info 级写入。
   */
  recordStepMeta(stepId: string, meta: StepMeta): void {
    if (!this.guardOrphan(stepId, 'recordStepMeta')) return;

    const d = this.stepDepth(stepId);
    const f = 2 * d + 2;
    // 先算出实际要写的字段（按级别过滤后），非空才写块头——避免空 meta 留一个孤块头。
    const entries = Object.entries(meta).filter(([key, value]) => {
      if (value === undefined) return false;
      const isAudit = AUDIT_FIELDS.has(key);
      const isFlow = FLOW_FIELDS.has(key);
      return isAudit || !isFlow || this.shouldRecord('info');
    });
    if (entries.length === 0) return;
    this.blockHeader(stepId);   // YAMLL：meta 自成一块
    for (const [key, value] of entries) {
      // llm.prompt/response 是 debug 级子字段（^anc-obs-log-levels）——llm 块整体属 info 级
      // 流控字段,非 debug 时剥离 prompt/response 只留 model/tokens,并 sanitize。
      let v = value;
      if (key === 'llm' && typeof value === 'object' && value !== null && ('response' in value || 'prompt' in value)) {
        const { prompt, response, ...rest } = value as { prompt?: string; response?: string } & Record<string, unknown>;
        // sanitizeFull 不截断——prompt/response 是全文核验通道,200 字截断会重演 dr9"截断制造观测幻象"
        v = this.level === 'debug'
          ? { ...rest, ...(prompt !== undefined ? { prompt: sanitizeFull(prompt) } : {}), ...(response !== undefined ? { response: sanitizeFull(response) } : {}) }
          : rest;
      }
      const valStr = toYaml(v, d + 2);
      if (typeof value === 'object' && value !== null) {
        this.append(`${this.ind(f)}${key}:\n${valStr}\n`);
      } else {
        this.append(`${this.ind(f)}${key}: ${valStr}\n`);
      }
    }
  }

  /** 疑似反刍留档（^anc-exec-thinking-exhausted 二批,hopissues/0060）——文档级顶层块,
   * 不过孤儿守卫（命中时点在截断抛错前,当前步可能未 start/已终态,步级归属不可靠;
   * recordWarn 空 stepId 顶层块同先例）。content 经 sanitizeFull 抹密钥**不截断**——
   * 全文是留档价值本体（200 字截断=白留;llm.prompt 全文核验通道同理）。无视日志级别
   * 恒写（审计性留档——留给线下判"是不是反刍"的唯一证据）。 */
  // @a: anc-exec-thinking-exhausted
  recordRuminationSuspect(where: string, outputTokens: number | string, content: string): void {
    this.append(`rumination_suspect:\n  where: ${toYaml(where, 1)}\n  output_tokens: ${toYaml(outputTokens, 1)}\n  content: ${toYaml(sanitizeFull(content), 1)}\n`);   // outputTokens 同过 toYaml——'?' 回退值裸插会写出 YAML 保留指示符破坏整档(review C1-1 探针实证)
  }

  // stepId 非空 → step 级告警（warn 作该 step 块字段，过 guardOrphan 守卫）。
  // stepId 为空 '' → 文档级告警（如"Output 声明了却从未赋值"，不归属任何 step）：
  //   落顶层 `warn:` 独立块，不过 guardOrphan、不写 blockHeader（空 id 无 step 归属，
  //   旧实现误让它走 guardOrphan 被当孤儿写成 `# ERROR: orphan` 而正文丢失）。
  recordWarn(stepId: string, message: string): void {
    if (!this.shouldRecord('warn')) return;
    if (stepId === '') {   // 文档级：顶层独立块
      this.append(`warn: ${toYaml(sanitize(message), 0)}\n`);
      return;
    }
    // 组装期告警暂存（#29,^anc-obs-log-levels recordWarn 条款）：prompt 组装（含
    // [context-compress]）发生在 recordStepStart 实参求值期,时序天然早于 start——不是调用
    // 序列 bug。guardOrphan 一行标记吃正文=压缩观测通道在大样路径失聪（ppt 实锤 orphan
    // recordWarn(4.2)）。暂存,start 块写完后冲账;参照 flushDocRefMeta 先例。
    // 判据两半:未 start（首轮组装期）∪ 上轮已终态（loop 新轮组装期——此刻 iterCounts
    // 未 +1,直写会落上一轮块键;暂存到新轮 recordStepStart 后冲账,彼时轮次已 +1 落对 #N 块。
    // review 探针实抓:第二轮组装 warn 直写归错轮）。
    if (!this.startedSteps.has(stepId) || this.doneSteps.has(stepId)) {
      const list = this.pendingWarns.get(stepId) ?? [];
      list.push(message);
      this.pendingWarns.set(stepId, list);
      return;
    }
    const f = 2 * this.stepDepth(stepId) + 2;
    this.blockHeader(stepId);   // YAMLL：warn 自成一块
    this.append(`${this.ind(f)}warn: ${toYaml(sanitize(message), f / 2)}\n`);
  }

  // 组装期暂存的 step 级 warn（#29）——recordStepStart 冲账;close 兜底降文档级不丢正文。// @a: anc-obs-log-levels
  private pendingWarns = new Map<string, string[]>();
  private flushPendingWarns(stepId: string): void {
    const list = this.pendingWarns.get(stepId);
    if (!list?.length) return;
    this.pendingWarns.delete(stepId);
    const f = 2 * this.stepDepth(stepId) + 2;
    for (const msg of list) {
      this.blockHeader(stepId);
      this.append(`${this.ind(f)}warn: ${toYaml(sanitize(msg), f / 2)}\n`);
    }
  }

  // parallel fan-out/join 审计:作为 parallel 步骤（parallelStepId）的 body 子字段写入，缩进按步骤深度
  // （fanout:/join: 键在 2d+2，与 type/summary 并列；子内容更深）。始终写入（无视级别）。
  // ⚠️ 曾误实现为顶格 0 缩进——在 execution 深缩进流中途 append 顶格键会提前闭合 execution mapping，
  // 令其后步骤错位、YAML 不可解析。改为随步骤深度缩进后自然嵌在该 parallel 子树内。
  // 见 design/spec-observability.md ^anc-obs-nested-tree。// @a: anc-obs-nested-tree, anc-obs-parallel-child-satellite
  recordParallelFanout(parallelStepId: string, childIds: string[], maxConcurrent: number): void {
    const f = 2 * this.stepDepth(parallelStepId) + 2;
    this.blockHeader(parallelStepId);   // YAMLL：fanout 自成一块（块头 = parallel step-id）
    this.append(`${this.ind(f)}fanout:\n`);
    // 字段序：max_concurrent（窗口容量，先看到）→ children（全集）→ started_at（开始持续派发的锚点）。
    // fanout 不做二元起止——parallel 阶段"结束"由 join 的 ended_at 承载。见 design ^anc-obs-nested-tree。
    this.append(`${this.ind(f + 2)}max_concurrent: ${maxConcurrent}\n`);
    this.append(`${this.ind(f + 2)}children:\n${childIds.map(id => `${this.ind(f + 4)}- ${toYaml(id)}`).join('\n')}\n`);
    this.append(`${this.ind(f + 2)}started_at: ${toYaml(timestamp())}\n`);
  }

  // 每派发一个 child 一次（fanout-plan/fanout-next 顾问进程在 toLaunch 循环内调）：流式 append 一条 dispatch 块。
  // dispatched_at = 引擎决定派发的时刻（"引擎动作时刻"，如实反映滑动窗口的持续派发，非 fanout 一瞬塌缩）；
  // log = 该 child 子日志目录（确定性算出）。顾问进程 load 后 HopLog.resume 重建父句柄故能 append。
  // 见 design/spec-observability.md ^anc-obs-parallel-dispatch。// @a: anc-obs-parallel-dispatch
  recordParallelDispatch(parallelStepId: string, childId: string, logDir: string): void {
    const f = 2 * this.stepDepth(parallelStepId) + 2;
    this.blockHeader(parallelStepId);   // YAMLL：dispatch 自成一块（块头 = parallel step-id，块间重复合法）
    this.append(`${this.ind(f)}dispatch:\n`);
    this.append(`${this.ind(f + 2)}child: ${toYaml(childId)}\n`);
    this.append(`${this.ind(f + 2)}dispatched_at: ${toYaml(timestamp())}\n`);
    this.append(`${this.ind(f + 2)}log: ${toYaml(logDir)}\n`);
  }

  // join 完成时记录。childResults 每项带 failed + 可选 log（子实例日志路径，join 时逐个读子实例顺手带出）。
  // startedAt = engine 进入 join 的时刻（外部捕获传入）；ended_at = 本方法 merge 完的 timestamp()。

  /** reap 块（P1 统一模型）：随到随收逐条流式——child/status/reaped_at（对称 dispatch 块）。
   * 见 [[spec-observability#^anc-obs-parallel-reap]]。 // @a: anc-obs-parallel-reap */
  recordParallelReap(hostStepId: string, childId: string, status: 'completed' | 'failed'): void {
    const f = 2 * this.stepDepth(hostStepId) + 2;
    this.blockHeader(hostStepId);
    this.append(`${this.ind(f)}reap:\n`);
    this.append(`${this.ind(f + 2)}child: ${toYaml(childId)}\n`);
    this.append(`${this.ind(f + 2)}status: ${status}\n`);
    this.append(`${this.ind(f + 2)}reaped_at: ${toYaml(timestamp())}\n`);
    this.flush();
  }

  /** settle 块（P1 统一模型）：容器收齐终态化一条——settled_at。
   * 见 [[spec-observability#^anc-obs-parallel-reap]]。 // @a: anc-obs-parallel-reap */
  recordParallelSettle(hostStepId: string): void {
    const f = 2 * this.stepDepth(hostStepId) + 2;
    this.blockHeader(hostStepId);
    this.append(`${this.ind(f)}settle:\n`);
    this.append(`${this.ind(f + 2)}settled_at: ${toYaml(timestamp())}\n`);
    this.flush();
  }
  // 见 design/spec-observability.md ^anc-obs-nested-tree。// @a: anc-obs-parallel-dispatch
  recordParallelJoin(
    parallelStepId: string,
    childResults: Record<string, { failed: boolean; log?: string }>,
    startedAt?: string,
  ): void {
    const f = 2 * this.stepDepth(parallelStepId) + 2;
    this.blockHeader(parallelStepId);   // YAMLL：join 自成一块
    this.append(`${this.ind(f)}join:\n`);
    this.append(`${this.ind(f + 2)}children:\n`);
    for (const [id, res] of Object.entries(childResults)) {
      const status = res.failed ? 'failed' : 'completed';
      // child 值写成 inline mapping：status + 可选 log（子日志定位线索）
      const logPart = res.log ? `, log: ${toYaml(res.log)}` : '';
      this.append(`${this.ind(f + 4)}${toYaml(id)}: {status: ${status}${logPart}}\n`);
    }
    if (startedAt) this.append(`${this.ind(f + 2)}started_at: ${toYaml(startedAt)}\n`);
    this.append(`${this.ind(f + 2)}ended_at: ${toYaml(timestamp())}\n`);
  }

  // replan 提报记录:降级阶梯第3/4档运行时生成的审计事件,供离线沉淀为预声明备用链路。
  // 顶层事件、无视日志级别始终记录、不受 guardOrphan(replan 是 subtask 级跨进程事件,
  // 不是叶子步 meta——subtask 容器本就不 recordStepStart,且跨进程 startedSteps 重置)。
  // 见 design/spec-observability.md ^anc-obs-replan-audit。// @a: anc-obs-replan-audit
  recordReplanAudit(audit: ReplanAuditRecord): void {
    this.flushTopLevelResume(); // 顶层事件：resumed_at 落顶层（0 缩进）
    this.append(`replan_audit:\n${toYaml(audit, 1)}\n`);
  }

  close(status: 'completed' | 'failed' | 'cancelled' | 'aborted'): void {   // aborted=实例主动中止——有终章不留无尾账 // @a: anc-exec-abort
    // #29 兜底：到终态仍滞留的暂存 warn 降文档级落账——真调用序列 bug 正文也不丢。
    // 前缀区分两形态（二审抓前缀撒谎:start 过但上轮终态后未再 start 的步骤不能说"未start"）
    for (const [sid, list] of this.pendingWarns) {
      const tag = this.startedSteps.has(sid) ? `step ${sid} 终态后` : `step ${sid} 未start`;
      for (const msg of list) this.append(`warn: ${toYaml(sanitize(`[${tag}] ${msg}`))}\n`);
    }
    this.pendingWarns.clear();
    this.flushTopLevelResume(); // resume 后直接终态也不丢 marker——close 前落顶层 resumed_at（0 缩进）
    this.append(`status: ${status}\n`);
    this.append(`ended_at: ${toYaml(timestamp())}\n`);
  }

  getLevel(): 'debug' | 'info' | 'warn' { return this.level; }   // launch_command 级别继承用 // @a: anc-exec-parallel-reuse-protocol

    getRunDir(): string {
    return this.runDir;
  }

  getFilePath(): string {
    return this.filePath;
  }

  flush(): void { // @a: anc-obs-hoplog-flush
    // All writes are immediate via appendFileSync — flush is a no-op
  }

  private append(text: string): void {
    appendFileSync(this.filePath, text);
  }

  private shouldRecord(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
  }

  private filterValues(values?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!values) return undefined;
    // warn: 不记录变量值（只看步骤骨架和警告）
    if (this.level === 'warn') return undefined;
    // debug: 完整记录（仅脱敏 API key，不截断——debug 的核心价值是完整还原 LLM 输入）
    // info: 脱敏 + 截断（摘要足够，控制文件大小）
    return this.level === 'debug' ? sanitizeRecordFull(values) : sanitizeRecordTruncated(values);
  }
}

/** 日志脱敏 helper：抹除 API key 类敏感 pattern 并截断超长文本，保证密钥不落 HopLog。见 [[spec-observability#^anc-obs-log-levels]] */
export function sanitize(text: string): string {
  let s = text.replace(/\b(sk-|key-)[a-zA-Z0-9]{20,}/g, '$1***');
  if (s.length > 200) s = s.substring(0, 200) + ' [TRUNCATED]';
  return s;
}

function sanitizeFull(text: string): string {
  return text.replace(/\b(sk-|key-)[a-zA-Z0-9]{20,}/g, '$1***');
}

/** 对 record 的字符串值逐个应用 fn（非字符串原样）。full/truncated 两个 sanitize 变体共用骨架。 */
function mapStringValues(rec: Record<string, unknown>, fn: (s: string) => string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    result[k] = typeof v === 'string' ? fn(v) : v;
  }
  return result;
}

function sanitizeRecordFull(rec: Record<string, unknown>): Record<string, unknown> {
  return mapStringValues(rec, sanitizeFull);
}

function sanitizeRecordTruncated(rec: Record<string, unknown>): Record<string, unknown> {
  return mapStringValues(rec, sanitize);
}

function generateRunId(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = randomBytes(2).toString('hex');
  return `${date}T${time}-${hex}`;
}

/** 带时区偏移的毫秒精度本地时间戳（`YYYY-MM-DDTHH:MM:SS.mmm+ZZZZ`）——YAMLL 各事件时间字段的
 * 单点来源。engine 记 join/dispatch 时刻也复用它，保证与日志内时间同源同格式（勿另起 new Date
 * 手拼，格式漂移会让日志时间轴不可比）。见 design/spec-observability.md ^anc-obs-timestamp。 */
export function timestamp(): string { // @a: anc-obs-timestamp
  const now = new Date();
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const h = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const m = String(Math.abs(off) % 60).padStart(2, '0');
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  // 毫秒级精度（.mmm 三位零填充）：亚秒事件可分辨——同批 dispatch 落同一秒、join 起止单进程内间隔<1s。
  // 见 design ^anc-obs-timestamp / ^anc-obs-parallel-dispatch。
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${ms}${sign}${h}:${m}`;
}

/** 把日志条目对象序列化为 block-style YAML 文本，供 record* 方法实时 appendFileSync 写入 main.yaml。见 [[spec-observability#^anc-obs-hoplog-flush]] */
export function toYaml(obj: unknown, indent = 0): string {
  const prefix = '  '.repeat(indent);
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean') return String(obj);
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') {
    if (obj.includes('\n')) {
      const lines = obj.split('\n');
      // 块标量安全条件（#41,^anc-obs-hoplog-flush 条款 2）：无指示符的 | 由首个非空行定缩进
      // 基线——值首行自带前导空白（LLM response 里嵌缩进片段文本）会抬高基线,后续较浅行提前
      // 终止块标量误读成错层 key,整份 main.yaml 非法（dr16-6 r7 实锤）。此形态回退 JSON
      // 双引号单行;正常多行文本仍走块标量。
      // 三形态回退（review 二修:YAML 8.1.1.1 对 leading empty lines 另有独立约束——
      // 首内容行之前的"纯空白行"发出后比基线深同样炸档;全空白串亦然。真空行 '' 发出后
      // 恰等于基线,合法不回退）。
      const idx = lines.findIndex(l => l.trim() !== '');
      if (idx === -1 || /^\s/.test(lines[idx]) || lines.slice(0, idx).some(l => l.length > 0)) {
        return JSON.stringify(obj);
      }
      // chomping 按值真实结尾选（review fuzz 抓保真偏差:恒用 | 使无尾换行值读回多一个 \n——
      // 12/19 病态样本全中此形态;解析合法性零失败,病仅在保真）:值尾恰一 \n 用 |（clip 保一个）,
      // 无尾换行用 |-（strip）;多尾换行值先归一到一个（观测值,语义无损）。
      const endsNl = obj.endsWith('\n');
      const body = (endsNl ? obj.replace(/\n+$/, '') : obj).split('\n');
      return (endsNl ? '|\n' : '|-\n') + body.map(l => prefix + '  ' + l).join('\n');
    }
    if (obj === '' || /[:{}\[\],&*?|>!'"%@`#]/.test(obj) || /^\s/.test(obj) || /\s$/.test(obj)
        || /^-?\d+(\.\d+)?$/.test(obj) || obj === 'true' || obj === 'false' || obj === 'null') {
      return JSON.stringify(obj);
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(item => {
      const val = toYaml(item, indent + 1);
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        return prefix + '- ' + val.trimStart();
      }
      return prefix + '- ' + val;
    }).join('\n');
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries.map(([key, value]) => {
      if (value === undefined) return null;
      const valStr = toYaml(value, indent + 1);
      if (typeof value === 'object' && value !== null && (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0)) {
        return prefix + key + ':\n' + valStr;
      }
      return prefix + key + ': ' + valStr;
    }).filter(Boolean).join('\n');
  }
  return String(obj);
}
