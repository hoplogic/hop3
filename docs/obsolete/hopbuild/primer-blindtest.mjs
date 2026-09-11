#!/usr/bin/env node
// primer 盲测：零先验 agent 只读 primer 文档翻译自然语言 skill → 真 validate 判分。
// 协议契约见 design/carrier-live-e2e.md ^anc-driver-live-e2e-primer。// @a: anc-driver-live-e2e-primer
// 测的是"primer 这份知识文档够不够让一个没有任何 HopSpec 先验的 agent 独立产出合法 spec"，
// 语法演进后 primer 是否失效由本测试暴露（primer 改动/语言语法改动后必跑）。
// 判分器 = 引擎 validate（唯一权威），不采信 agent 自评。
//
// 用法：node scripts/primer-blindtest.mjs [--launcher claude-ds] [--single-shot] [--failed-only] [题号...]
//   npm run test:primer               # 全部题（终端有 zenmux/DS 环境变量时用 test:primer:ds）
//   node scripts/primer-blindtest.mjs ticket qc  # 只跑指定题
//   --failed-only：只补跑上轮 results.json 里的失败题（结果按题合并，套件级断点续传）
//   --single-shot：旧单发模式（整篇一次生成）做可比对照；缺省是 draft+分段模式——
//     先产 HopSop draft，再按 draft 分段升格（每段 ~2k 字），规避长单发生成挂死
// launcher：裸 claude 在导出了 ANTHROPIC_*=zenmux 的终端会 401（2026-08-08 实撞）——
//   该环境用 --launcher claude-ds（zsh 函数，经 zsh -ic 调起，同 carrier-live-e2e 做法）。
// 有费用（每题一次 claude -p 无头调用），opt-in——不进 check/chain-health。
// 需真机终端（claude CLI 可用）。产物与日志落 .primer-blindtest/。

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// --primer example 切换被测教材（单例 primer 盲测同一装置复用）
// 被测物=执行链真源（2026-08-18 作者定'知识汇聚单源':primer-8k 族退役进 docs/obsolete/hopbuild/,
// 盲测测死文档无意义——测 hopbuild spec 真实注入的那份）
const PRIMER = join(ROOT, 'skills/hopbuild/hopbuild-primer.md');
const CLI = join(ROOT, 'dist/cli.js');
const OUTDIR = join(ROOT, '.primer-blindtest');

// ── 题库：id / 压力点 / 自然语言 skill 原文 ──────────────────────────────
// 覆盖历轮盲测撞出过问题的全部维度；新语法特性上线时在此加题。
const CASES = [
  {
    id: 'ticket',
    stress: '三焦点全踩（for-each+confirm+commit 把关链）',
    skill: '客户工单处理：对收到的每个客户工单，分析其类别和紧急度；全部分类完成后汇总成处理计划；处理计划须经主管批准；批准后给每个高优先级工单的客户发送回复邮件。约束：处理计划必须覆盖所有工单。',
  },
  {
    id: 'clean',
    stress: '条件循环+累加器+break+双约束',
    skill: '数据清洗：读入原始数据文件并统计质量指标；然后反复执行修复——每轮由分析确定修复策略、执行修复、重测质量指标，若质量分数达到 90 分则停止，最多修 10 轮；每轮把发现的错误追加到错误日志；结束后（无论达标与否）生成清洗报告，报告必须包含最终质量分数和完整错误日志。约束：原始数据文件不得被修改（只能写副本）。',
  },
  {
    id: 'expense',
    stress: 'branch 三档+ask+call+分档把关链',
    skill: '费用报销审批：先向员工收集报销单据信息（金额、类别、票据照片路径）；按金额分三档处理——小于 500 元走快速通道（自动核验票据格式后直接批准）；500 到 5000 元需要部门主管人工审批；大于 5000 元除主管审批外还要调用已有的『合规审查』流程（Id 为 compliance-review，输入报销信息，输出合规结论）；任何一档批准后，把报销记录写入财务系统（不可撤销）。约束：写入财务系统前必须有对应档位的批准结论。',
  },
  {
    id: 'trap',
    stress: '陷阱题——误导措辞（自动确认/提交/删除均非字面类型）',
    skill: '客户流失预警：系统每天凌晨自动确认前一天的活跃数据已就绪（就绪即继续，不就绪则终止今天的分析）；然后循环检查每个 VIP 客户的活跃度指标，把连续 7 天下降的客户提交到预警名单；对预警名单里的每个客户，删除其缓存的旧画像并重新计算画像（画像缓存随时可重建）；根据新画像判断流失风险等级；风险等级为高的客户，需要客户经理确认后才能把该客户加入挽留活动名单（加入后营销系统立即自动发券，券不可作废）。',
  },
  {
    id: 'minimal',
    stress: '极简题——防过度工程化（正解=单 reason 步）',
    skill: '翻译润色：把用户给的英文段落翻译成中文并润色到出版级流畅度，输出中文文本。',
  },
  {
    id: 'qc',
    stress: '新语法全栈（collect 子句+case 正字法+数值区间条件+统配）',
    skill: '订单质检：读入当日订单列表；对每个订单并行核验（金额与明细一致性、收件信息完整性），各订单产出核验结果；汇总所有核验结果，统计不合格订单数；不合格数为 0 时生成合格日报；不合格数在 1 到 5 之间时生成整改清单并请质检主管确认后下发整改工单（下发不可撤回）；超过 5 时属重大异常，请质检主管确认后触发全线停发指令（不可撤回）。约束：每个订单的核验结果必须包含两项核验的明细。',
  },
];

// ── 盲测 prompt（与历轮手工盲测同一措辞骨架，保持可比性）────────────────
// 缺省两阶段生成（作者定 2026-08-09，长单发生成在 claude-ds 链路概率性挂死——
// 19KB 输入+小输出秒回、同输入+整篇 spec 单发 24min 零字节，病灶是单次生成长度）：
//   阶段A：先产 HopSop draft（控制流骨架，小产出）——语法见
//          docs/concepts/HopSop.md，prompt 内嵌其紧凑摘要保持零先验自包含；
//   阶段B：按 draft 逐段升格为完整 hopskill，每段 ~2000 字，段间接力直到 <<SPEC-END>>。
// --single-shot 保留旧单发模式做可比对照。

const FLOW_SYNTAX = `HopSop（轻量流程草稿语法，纯 Markdown——词汇与 primer「HopSop 流程草稿记法」节同族）：
- 多层数字序号表达层级与顺序：1 / 1.1 / 1.2.1，子节点缩进 2 空格。
- 容器节点（仅这四种可拥有子节点）：[subtask] 一组有共同边界的子节点；[loop] 子节点构成循环体；[branch] 子节点必须全是 [case(…)]；[case(命中条件)] 等同 subtask、直接挂该分支的步骤，兜底写 [case(else)] 且只能放最后。
- 普通步骤：无标记，一句话描述一个动作。
- 流控节点（与容器同用中括号标注）：[continue <循环序号>] / [break <循环序号>] / [exit]。
- 只表达控制流，不写变量、类型、步骤类型。`;

function draftPrompt(skillText) {
  return `你是一个流程分析 agent。用下面这个轻量语法，把一个自然语言 skill 的执行流程整理成结构化流程草稿：

<flow-syntax>
${FLOW_SYNTAX}
</flow-syntax>

任务：为下面这个 skill 写流程草稿——识别所有循环（"每个/逐个"必须成 [循环]）、所有分支（互斥路径必须成 [分支]+[条件(…)]）、所有顺序步骤，忠实原文不增删业务逻辑：

"${skillText}"

只输出流程草稿本身（数字序号开头的行），不要任何其他文字。`;
}

function segmentPrompt(skillText, draft, partial) {
  const head = `你是一个从未接触过 HopSpec/hopskill 的 agent。你的全部知识只有下面这份文档（禁止使用任何 HopSpec 先验知识——只依据文档作答）：

<primer>
${readFileSync(PRIMER, 'utf-8')}
</primer>

翻译任务：把下面这个自然语言 skill 翻译成 hopskill spec：

"${skillText}"

已确认的流程草稿（控制流骨架，翻译时遵循其结构——容器/流控词汇与 spec 同名直通，普通步骤按动词选类型）：

<draft>
${draft}
</draft>
`;
  const cont = partial
    ? `已生成的 spec 前半部分（不要重复、不要修改，从其截断处直接接着写）：

<partial>
${partial}
</partial>

继续输出 spec 的后续内容。`
    : `开始输出 spec 文本（从 "# Spec:" 第一行写起）。`;
  return `${head}
${cont}

规则：本次回复只输出 spec 正文片段本身（不要代码围栏、不要解释）；篇幅控制在约 2000 字以内，宁可截断在整步骤边界；没写完就在最后单独一行输出 <<CONTINUE>>，全部写完就在最后单独一行输出 <<SPEC-END>>。`;
}

function extractSpec(text) {
  const m = text.match(/```(?:markdown)?\n([\s\S]*?)```/);
  return m ? m[1] : text.trim();  // 无围栏则整体当 spec（agent 偶尔裸输出）
}

export function stripSegment(text) {   // export 供判据回归（guard-scripts.test）
  // 段落回复：剥哨兵行与偶发围栏，返回 { chunk, done }
  const done = /<<SPEC-END>>/.test(text);
  let t = text.replace(/<<(?:CONTINUE|SPEC-END)>>/g, '');
  // 只有回复整体以围栏开头才按外层围栏剥（贪婪到最后闭合——外层围栏内嵌 hop_python 围栏时
  // 非贪婪截内层丢尾）。裸正文内嵌围栏时不剥——原实现对任意位置贪婪匹配,把首个 ``` 前的
  // 头部（# Spec:/Id:/Goal:）整段丢弃,expense/trap 两题 parse error '缺 # 标题' 实撞真身
  //（2026-08-15 deep 首跑;agent 裸正文作答完全合规,是判分器自伤）。
  if (/^\s*```/.test(t)) {
    const m = t.match(/```(?:markdown)?\n([\s\S]*)```/);
    if (m) t = m[1];
  }
  return { chunk: t.replace(/\s+$/, ''), done };
}

// 单次 agent 调用（一段生成）。段级超时缺省 300s——分段后每段产出小，300s 到点即判挂死。
function callAgent(launcher, prompt, timeoutMs) {
  const cliArgs = ['-p', '--disallowed-tools', '*'];
  const r = launcher === 'claude-ds'
    ? spawnSync('zsh', ['-ic', `claude-ds "$@"`, 'primer-blindtest', ...cliArgs],
        { input: prompt, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 })
    : spawnSync('claude', cliArgs,
        { input: prompt, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, reason: `超时(${timeoutMs / 1000}s)`, r };
  if (r.error || r.status !== 0) return { ok: false, reason: `agent 调用失败(exit ${r.status ?? '?'})`, r };
  return { ok: true, stdout: r.stdout, r };
}

// 带一次自动重试（挂死是概率性的，同 prompt 重发通常就绿）
function callAgentRetry(launcher, prompt, timeoutMs) {
  const first = callAgent(launcher, prompt, timeoutMs);
  if (first.ok) return first;
  const second = callAgent(launcher, prompt, timeoutMs);
  return second.ok ? second : { ...second, reason: `${first.reason}→重试后${second.reason}` };
}

function archiveError(id, launcher, phase, call) {
  writeFileSync(join(OUTDIR, `${id}.agent-error.txt`), [
    `launcher: ${launcher}`, `phase: ${phase}`, `reason: ${call.reason}`,
    `exit: ${call.r?.status ?? 'spawn-error'}`, `error: ${call.r?.error?.message ?? ''}`,
    `--- stderr ---`, (call.r?.stderr ?? '').slice(-4000),
    `--- stdout tail ---`, (call.r?.stdout ?? '').slice(-2000),
  ].join('\n'));
}

// 两阶段生成：draft（流程草稿）→ 分段升格接力。返回 { spec } 或 { fail: reason }
function generateStaged(launcher, c, timeoutMs) {
  const d = callAgentRetry(launcher, draftPrompt(c.skill), timeoutMs);
  if (!d.ok) { archiveError(c.id, launcher, 'draft', d); return { fail: `draft: ${d.reason}` }; }
  const draft = d.stdout.trim();
  writeFileSync(join(OUTDIR, `${c.id}.draft.md`), draft);

  let spec = '';
  const MAX_SEGMENTS = 8;  // ~2k 字/段 × 8 远超任何题目规模；防哨兵失灵死循环
  for (let seg = 1; seg <= MAX_SEGMENTS; seg++) {
    const s = callAgentRetry(launcher, segmentPrompt(c.skill, draft, spec || null), timeoutMs);
    if (!s.ok) {
      // 段级断点：已拼接部分落盘，重跑本题可人工续查
      writeFileSync(join(OUTDIR, `${c.id}.partial.md`), spec);
      archiveError(c.id, launcher, `segment-${seg}`, s);
      return { fail: `第${seg}段: ${s.reason}（partial 已存）` };
    }
    writeFileSync(join(OUTDIR, `${c.id}.seg${seg}.raw.txt`), s.stdout);
    const { chunk, done } = stripSegment(s.stdout);
    spec = spec ? `${spec}\n${chunk}` : chunk;
    if (done) return { spec };
  }
  writeFileSync(join(OUTDIR, `${c.id}.partial.md`), spec);
  return { fail: `${MAX_SEGMENTS} 段未见 <<SPEC-END>>（partial 已存）` };
}

function generateSingleShot(launcher, c, timeoutMs) {
  const prompt = `你是一个从未接触过 HopSpec/hopskill 的 agent。你的全部知识只有下面这份文档（禁止使用任何 HopSpec 先验知识——只依据文档作答）：

<primer>
${readFileSync(PRIMER, 'utf-8')}
</primer>

翻译任务：把下面这个自然语言 skill 翻译成 hopskill spec：

"${c.skill}"

只输出翻译出的完整 spec 文本，用一个 markdown 代码块包裹（\`\`\`markdown 开头、\`\`\` 结尾），不要任何其他文字。`;
  const r = callAgentRetry(launcher, prompt, timeoutMs);
  if (!r.ok) { archiveError(c.id, launcher, 'single-shot', r); return { fail: r.reason }; }
  writeFileSync(join(OUTDIR, `${c.id}.raw.txt`), r.stdout);
  return { spec: extractSpec(r.stdout) };
}

function loadPrevResults() {
  const p = join(OUTDIR, 'results.json');
  if (!existsSync(p)) return {};
  try {
    const prev = JSON.parse(readFileSync(p, 'utf-8'));
    return Object.fromEntries((prev.results ?? []).map(r => [r.id, r]));
  } catch { return {}; }
}

function main() {
  if (!existsSync(CLI)) { console.error('缺 dist/cli.js——先 npm run build。不静默跳过。'); process.exit(2); }
  if (!existsSync(PRIMER)) { console.error(`缺 ${PRIMER}。`); process.exit(2); }
  const probe = spawnSync('claude', ['--version'], { encoding: 'utf-8' });
  if (probe.error || probe.status !== 0) { console.error('claude CLI 不可用（需真机终端）。不静默跳过。'); process.exit(2); }

  const argv = process.argv.slice(2);
  let launcher = process.env.HOPSPEC_PRIMER_LAUNCHER ?? 'claude';
  const li = argv.indexOf('--launcher');
  if (li >= 0) { launcher = argv[li + 1]; argv.splice(li, 2); }
  if (!['claude', 'claude-ds'].includes(launcher)) { console.error(`不支持的 launcher：${launcher}（claude | claude-ds）`); process.exit(2); }
  const singleShot = argv.includes('--single-shot');
  if (singleShot) argv.splice(argv.indexOf('--single-shot'), 1);
  const failedOnly = argv.includes('--failed-only');
  if (failedOnly) argv.splice(argv.indexOf('--failed-only'), 1);
  const only = argv;

  mkdirSync(OUTDIR, { recursive: true });
  const prevById = loadPrevResults();
  let cases = only.length ? CASES.filter(c => only.includes(c.id)) : CASES;
  if (failedOnly) cases = cases.filter(c => !prevById[c.id]?.ok);
  if (!cases.length) {
    console.error(only.length || !failedOnly ? `无匹配题目。可选：${CASES.map(c => c.id).join(' ')}` : '上轮已全绿，--failed-only 无题可跑。');
    process.exit(failedOnly ? 0 : 2);
  }

  // 段级超时：分段后单段产出小（draft/2k 字级），300s 到点即判挂死重试；--single-shot 沿用长时限
  const TIMEOUT_MS = Number(process.env.HOPSPEC_PRIMER_TIMEOUT_MS ?? (singleShot ? 600_000 : 300_000));
  const results = [];

  console.log(`═══ primer 盲测（${cases.length} 题；${singleShot ? '单发模式' : 'draft+分段模式'}；判分=引擎 validate；产物→ .primer-blindtest/）═══`);
  for (const c of cases) {
    process.stdout.write(`${c.id.padEnd(10)} ${c.stress.padEnd(38)} ... `);
    const g = singleShot ? generateSingleShot(launcher, c, TIMEOUT_MS) : generateStaged(launcher, c, TIMEOUT_MS);
    if (g.fail) {
      results.push({ id: c.id, ok: false, reason: g.fail });
      console.log(`❌ ${g.fail} → ${c.id}.agent-error.txt`); continue;
    }
    const specPath = join(OUTDIR, `${c.id}.spec.md`);
    writeFileSync(specPath, g.spec);

    const v = spawnSync('node', [CLI, 'validate', specPath], { encoding: 'utf-8' });
    const out = (v.stdout ?? '') + (v.stderr ?? '');
    const errCount = (out.match(/severity: error/g) ?? []).length;
    writeFileSync(join(OUTDIR, `${c.id}.validate.txt`), out);
    if (/^status: ok/m.test(out)) {
      results.push({ id: c.id, ok: true, errors: 0 });
      console.log('✅ validate 全绿');
    } else {
      results.push({ id: c.id, ok: false, errors: errCount, reason: `${errCount} error` });
      console.log(`❌ ${errCount} error → ${c.id}.validate.txt`);
    }
  }

  const pass = results.filter(r => r.ok);
  console.log(`\n═══ 汇总：${pass.length}/${results.length} 全绿 ═══`);
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.id}${r.ok ? '' : `（${r.reason}）`}`);
  // 结果按题合并留档（套件级断点续传：单题/失败题重跑不再冲掉全量状态）
  for (const r of results) prevById[r.id] = r;
  const merged = CASES.map(c => prevById[c.id]).filter(Boolean);
  writeFileSync(join(OUTDIR, 'results.json'), JSON.stringify({
    ran_at: new Date().toISOString(), primer: PRIMER_VARIANT, mode: singleShot ? 'single-shot' : 'staged', results: merged,
  }, null, 2));
  // 轮次历史归档（^anc-driver-live-e2e-primer ⑤,2026-08-15 作者点'没加日志么'）：产物同名覆盖,
  // 每轮重跑冲掉上轮——教学力是纵向观测量,无轮次史则演进不可考。本轮跑过的题的产物快照入
  // history/<UTC时间戳>-<题号>/（只收本轮 ran 的题,未跑的题不重复归档）。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const histDir = join(OUTDIR, 'history', `${stamp}-${results.map(r => r.id).join('_')}`);
  mkdirSync(histDir, { recursive: true });
  for (const r of results) {
    for (const f of readdirSync(OUTDIR)) {
      if (f.startsWith(`${r.id}.`)) cpSync(join(OUTDIR, f), join(histDir, f));
    }
  }
  writeFileSync(join(histDir, 'results.json'), JSON.stringify({
    ran_at: new Date().toISOString(), primer: PRIMER_VARIANT, mode: singleShot ? 'single-shot' : 'staged',
    results,   // 本轮实跑（非合并全量——全量看根 results.json）
  }, null, 2));
  console.log(`轮次归档 → ${histDir}`);
  // 退出码语义与 carrier runner 对齐（0=过/1=失败/2=前置缺失）——原 exit=失败题数,恰 2 题失败
  // 会被三档调度误读为"前置缺失"（2026-08-15 deep 首跑实撞:4/6 却报 ⏭）。
  process.exit(pass.length === results.length ? 0 : 1);
}

// 直跑才执行（export stripSegment 供判据回归 import——import 时不得触发盲测跑真机）:
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
