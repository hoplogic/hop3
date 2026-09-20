#!/usr/bin/env node
// P1 核验能力探针跑批（judge-granularity 族的自动复跑仪器——0095 run-probes 批首件）。
// 用法: node model-gearbox/probes/run-judge-granularity.mjs --service <service_id> [--n 6] [--out <dir>]
//   service_id 须在 ~/.hopjit/config.yaml providers 内;凭证经该条目的 api_key_env 环境变量。
// 三层阶梯(判据方法论=D12 P1 节;prompt 逐字取 templates.md,语料取 corpus/——同卷纪律):
//   L1 开放式核验 ×n(好卷)——判词跨轮一致性人工比对材料(输出原文全存,自反判定不机械化:相反指令
//      的语义识别归人;脚本只出"待比对判词组");
//   L2 按清单核验 好/坏双臂各 ×n——机械判:extract_ok 对基准/表内矛盾(Q 行 vs 终判)/定位(gap 含 Q3);
//   L3 单点核验 A/B 双臂各 ×n——机械判:covered 对基准+missing 定位。
// 产出: <out>/summary.yaml(可贴档案的档位建议+逐层指标)+全部原始响应留档。
// 模型身份恒取响应体 model 字段(禁 LLM 自报);每格 n 缺省 6(批间反转纪律)。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const THINKING = argOf('--thinking', 'default');   // on=显式开思考(对照臂);default=端点缺省
const SERVICE = argOf('--service');
const N = parseInt(argOf('--n', '6'), 10);
const OUT = argOf('--out', join(HERE, 'judge-granularity', `run-${SERVICE}-${new Date().toISOString().slice(0, 10)}`));
if (!SERVICE) { console.error('用法: --service <service_id> [--n 6] [--out <dir>]'); process.exit(1); }

// provider 解析(读 ~/.hopjit/config.yaml——auth 档同 config 语义:bearer=Authorization 头)
const cfg = yamlLoad(readFileSync(join(homedir(), '.hopjit', 'config.yaml'), 'utf-8'));
const provider = (cfg.providers ?? []).find(p => p.service_id === SERVICE);
if (!provider) { console.error(`service '${SERVICE}' 不在 providers 内`); process.exit(1); }
const KEY = process.env[provider.api_key_env];
if (!KEY) { console.error(`环境变量 ${provider.api_key_env} 未设置`); process.exit(1); }

// 语料与模板装配(同卷纪律:全部从库内文件现读,不内置副本)
const docRaw = readFileSync(join(HERE, 'extract-scaling', 'doc-s.md'), 'utf-8');
const DOC = docRaw.split(/(?<=[。！？])/).map(s => s.trim()).filter(Boolean)
  .map((s, i) => `L${i + 1}: ${s}`).join('\n');
const stripComments = (t) => t.split('\n').filter(l => !l.trim().startsWith('#')).join('\n').trim();
const GOOD = stripComments(readFileSync(join(HERE, 'judge-granularity', 'corpus', 'points-good.yaml'), 'utf-8'));
const BAD = stripComments(readFileSync(join(HERE, 'judge-granularity', 'corpus', 'points-bad.yaml'), 'utf-8'));
const templates = readFileSync(join(HERE, 'judge-granularity', 'templates.md'), 'utf-8');
const blockOf = (title) => {
  const i = templates.indexOf(title);
  const s = templates.indexOf('```', i);
  const e = templates.indexOf('```', s + 3);
  return templates.slice(s + 4, e).trim();
};
const T1 = blockOf('## L1 开放式核验');
const T2 = blockOf('## L2 按清单核验');
const T3 = blockOf('## L3 单点核验');

async function call(prompt) {
  const headers = { 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  if (provider.auth === 'bearer') headers['Authorization'] = `Bearer ${KEY}`;
  else headers['x-api-key'] = KEY;
  const r = await fetch(`${provider.base_url}/v1/messages`, {
    method: 'POST', headers,
    // --thinking on 显式开思考对照臂(2026-09-20 Ling 判官翻案重测用——历史 P1 观测全在思考关档;
    // budget=max_tokens/2 与引擎装配同式)。缺省不带参数吃端点缺省,历史可比性不破。
    body: JSON.stringify({ model: provider.model, max_tokens: 16384, ...(THINKING === 'on' ? { thinking: { type: 'enabled', budget_tokens: 8192 } } : {}), messages: [{ role: 'user', content: prompt }] }),   // 16384:探针判定不该被输出预算截穿(deepseek L1 实撞:thinking 烧满 4096 正文零字节——空响应是烧穿症状不是判定产出,预算不足会把 G4 弱区误记成 P1 形态)
  });
  const body = await r.json();
  const text = (body.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
  // 空正文如实携形态注记(thinking 烧穿/截断与"判定产出"必须可区分——空文件无法验尸)
  const note = !text && body.stop_reason === 'max_tokens' ? `(空正文:stop_reason=max_tokens,thinking 烧穿形态——本发不是判定产出,是 G4 稳定性症状;usage=${JSON.stringify(body.usage)})` : '';
  return { text: text || note, model: body.model ?? '(响应体缺 model 字段)' };
}

mkdirSync(OUT, { recursive: true });
const save = (name, text) => writeFileSync(join(OUT, name), text);
const okOf = (t) => (t.match(/extract_ok:\s*(\w+)/) || [])[1];
const modelSeen = new Set();

// L1 开放式核验(好卷 ×n——自反材料组)
console.log(`[L1] 开放式 ×${N}(好卷)…`);
const l1 = [];
for (let i = 1; i <= N; i++) {
  const { text, model } = await call(T1.replace('{DOC}', DOC).replace('{POINTS}', GOOD));
  modelSeen.add(model); save(`L1-open-${i}.txt`, text);
  l1.push({ i, extract_ok: okOf(text) });
  console.log(`  L1-${i}: extract_ok=${okOf(text)}`);
}

// L2 按清单核验(好/坏双臂各 ×n)
console.log(`[L2] 核对表 好/坏双臂各 ×${N}…`);
const l2 = { good: [], bad: [] };
for (const [arm, pts] of [['good', GOOD], ['bad', BAD]]) {
  for (let i = 1; i <= N; i++) {
    const { text, model } = await call(T2.replace('{DOC}', DOC).replace('{POINTS}', pts));
    modelSeen.add(model); save(`L2-${arm}-${i}.txt`, text);
    const qs = {};
    for (const m of text.matchAll(/Q(\d):\s*(yes|no)/g)) qs[`Q${m[1]}`] = m[2];
    const ok = okOf(text);
    const allYes = ['Q1','Q2','Q3','Q4','Q5','Q6'].every(q => qs[q] === 'yes');
    const contradiction = (allYes && ok === 'false') || (!allYes && ok === 'true');
    const gap = text.split(/extract_gap/)[1] ?? '';
    l2[arm].push({ i, extract_ok: ok, qs, contradiction, gap_names_q3: /Q3/.test(gap) });
    console.log(`  L2-${arm}-${i}: ok=${ok} 矛盾=${contradiction} gap点Q3=${/Q3/.test(gap)}`);
  }
}

// L3 单点核验(A=全覆盖/B=漏睡眠断言,各 ×n)——单题固定用 L2 行双断言题(与首跑同卷)
console.log(`[L3] 单题 A/B 双臂各 ×${N}…`);
const L2_LINE = DOC.split('\n').find(l => l.includes('半衰期'));
const A_CLAIMS = '- P2: claim=咖啡因的半衰期约为 5 小时\n- P3: claim=下午晚些时候摄入咖啡因会影响夜间睡眠质量';
const B_CLAIMS = '- P2: claim=咖啡因的半衰期约为 5 小时';
const l3 = { A: [], B: [] };
for (const [arm, claims, expect] of [['A', A_CLAIMS, 'yes'], ['B', B_CLAIMS, 'no']]) {
  for (let i = 1; i <= N; i++) {
    const p = T3.replace('{LINE_TEXT}', L2_LINE).replace('{N}', '2')
      .replace('{ASSERTION_LIST}', '①半衰期约 5 小时 ②下午晚些时候摄入会影响夜间睡眠质量')
      .replace('{LINE_ID}', 'L2').replace('{LINE_CLAIMS}', claims);
    const { text, model } = await call(p);
    modelSeen.add(model); save(`L3-${arm}-${i}.txt`, text);
    const covered = (text.match(/covered:\s*(yes|no)/) || [])[1];
    const missOk = arm === 'A' ? true : /missing:.*[②2]/.test(text);
    l3[arm].push({ i, covered, correct: covered === expect && missOk });
    console.log(`  L3-${arm}-${i}: covered=${covered} 正确=${covered === expect && missOk}`);
  }
}

// 汇总(L1 自反判定归人——脚本产出待比对材料清单;L2/L3 机械指标)
const l2GoodTrue = l2.good.filter(x => x.extract_ok === 'true').length;
const l2BadFalse = l2.bad.filter(x => x.extract_ok === 'false').length;
const l2Contra = [...l2.good, ...l2.bad].filter(x => x.contradiction).length;
const l2Locate = l2.bad.filter(x => x.extract_ok === 'false' && x.gap_names_q3).length;
const l3Correct = [...l3.A, ...l3.B].filter(x => x.correct).length;
const summary = {
  service: SERVICE, model_from_response: [...modelSeen], n_per_cell: N,
  date: new Date().toISOString().slice(0, 10),
  L1_open: { runs: l1, 自反判定: '归人——逐份读 L1-open-*.txt 比对判词是否出现相反指令(语义识别不机械化)' },
  L2_checklist: {
    good_true: `${l2GoodTrue}/${N}`, bad_false: `${l2BadFalse}/${N}`,
    表内矛盾: `${l2Contra}/${N * 2}`, 坏卷定位准确: `${l2Locate}/${N}`,
  },
  L3_single: { correct: `${l3Correct}/${N * 2}`, A: l3.A, B: l3.B },
  判档建议: (() => {
    // 机械可判部分先出(L1 自反待人比对后修正):
    if (l3Correct < N * 2) return 'unusable 候选(L3 未全对)——复核原始件后定';
    if (l2GoodTrue >= N - 1 && l2BadFalse >= N - 1 && l2Locate >= Math.ceil(N * 2 / 3)) return 'checklist-only 候选(待 L1 自反比对:零自反则升 open-ok 候选)';
    return 'closed-questions-only 候选(L2 判向或定位不达线;待 L1 比对佐证)';
  })(),
};
save('summary.yaml', yamlDump(summary, { lineWidth: 200 }));
console.log('\n══ summary ══\n' + yamlDump(summary.L2_checklist) + 'L3: ' + summary.L3_single.correct + '\n判档建议: ' + summary.判档建议 + '\n产物: ' + OUT);
