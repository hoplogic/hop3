#!/usr/bin/env node
// G1 推理复杂度探针跑批——整数算术阶梯(禁工具,纯推理;难度单参数化,答案机判)。两种任务形态:
//   mul: N 位 × N 位乘法(直接推理——一遍算完,部分积可并行心算);
//   div: 2N 位 ÷ N 位除法,商保留 2N+1 位有效数字四舍五入(迭代推理——每位商依赖上一步余数,
//        错一步后面全错;2N+1 位有效数字逼到小数位,不能整数商糊弄。作者立 2026-09-19:
//        乘法是直接推理,除法补迭代推理——同一根 G1 轴上的第二种负载形态,分开记档)。
// 用法: node model-gearbox/probes/run-reasoning-complexity.mjs --service <service_id> [--task mul|div] [--start 2] [--max 12] [--n 5] [--confirm 20] [--out <dir>]
// 测法: 从 N=start 起逐位爬梯,每档 n 发(缺省 5);正确率 >=90% 才继续爬;
//   首个不达标的 N 停梯,对前一档(候选最大 N)加测到 confirm 发(缺省 20)确认概率——
//   confirm 发正确率 >=90% 即定档"最大 N",不足则降一档再确认。
// 判分: mul 精确比对乘积;div 真值用 BigInt 定标算出 2N+1 位有效数字的四舍五入商,
//   出题期规避舍入贴线题(舍入决定位是 4/5 的重生成——边界题考的是舍入规约不是算力,剔除);
//   比对按数值等值(允许尾零省略等纯格式差,不许末位差一——末位错就是算错)。
// 产出: <out>/summary.yaml(最大 N+逐档正确率曲线)+全部原始响应留档。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SERVICE = argOf('--service');
const TASK = argOf('--task', 'mul');
const START = parseInt(argOf('--start', '2'), 10);
const MAXN = parseInt(argOf('--max', '12'), 10);
const N_CLIMB = parseInt(argOf('--n', '5'), 10);
const N_CONFIRM = parseInt(argOf('--confirm', '20'), 10);
const OUT = argOf('--out', join(HERE, 'reasoning-complexity', `run-${SERVICE}${TASK === 'mul' ? '' : '-' + TASK}-${new Date().toISOString().slice(0, 10)}`));
if (!SERVICE || !['mul', 'div'].includes(TASK)) { console.error('用法: --service <service_id> [--task mul|div] [--start 2] [--max 12] [--n 5] [--confirm 20]'); process.exit(1); }

const cfg = yamlLoad(readFileSync(join(homedir(), '.hopjit', 'config.yaml'), 'utf-8'));
const provider = (cfg.providers ?? []).find(p => p.service_id === SERVICE);
if (!provider) { console.error(`service '${SERVICE}' 不在 providers 内`); process.exit(1); }
const KEY = process.env[provider.api_key_env];
if (!KEY) { console.error(`环境变量 ${provider.api_key_env} 未设置`); process.exit(1); }

// 确定性伪随机(mulberry32)——同 seed 同题序,跨模型同卷
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const SEED = parseInt(argOf('--seed', '20260918'), 10);
function nDigit(rand, n) { // 首位 1-9 其余 0-9
  let s = String(1 + Math.floor(rand() * 9));
  for (let i = 1; i < n; i++) s += String(Math.floor(rand() * 10));
  return BigInt(s);
}

function buildPrompt(a, b) {
  return `计算 ${a} × ${b}。

规则：
- 禁止使用任何工具或代码——纯推理计算;
- 思考过程可以写,但最后一行必须是且只是: 答案: <乘积数字>
- 答案行里只有数字,不带逗号分隔符。`;
}

function buildDivPrompt(a, b, sigDigits) {
  return `计算 ${a} ÷ ${b},商保留 ${sigDigits} 位有效数字(四舍五入)。

规则：
- 禁止使用任何工具或代码——纯推理计算;
- 思考过程可以写,但最后一行必须是且只是: 答案: <商>
- 答案行里只有数字与小数点,不带逗号分隔符,恰好 ${sigDigits} 位有效数字。`;
}

// div 出题:被除数 2N 位 ÷ 除数 N 位,真值=商的 2N+1 位有效数字四舍五入(BigInt 定标精确算)。
// 规避两类脏题重生成:①舍入决定位是 4 或 5(边界题考的是舍入规约不是算力);②进位改变位数
// (如 999.99→1000.0,有效数字位形态变——判分歧义面,剔除)。
function makeDivProblem(rand, n) {
  const sig = 2 * n + 1;
  for (let tries = 0; tries < 200; tries++) {
    const a = nDigit(rand, 2 * n);
    const b = nDigit(rand, n);
    const d = String(a / b).length;          // 商的整数部分位数(N 或 N+1)
    const dec = sig - d;                     // 小数位数
    if (dec < 0) continue;
    const scaled = a * 10n ** BigInt(dec);
    const q = scaled / b;
    const rem = scaled % b;
    const decision = (rem * 10n) / b;        // 截断位后第一位(0-9)
    if (decision === 4n || decision === 5n) continue;
    const rounded = decision >= 6n ? q + 1n : q;
    const s = String(rounded);
    if (s.length !== d + dec) continue;      // 进位改位数——剔除
    const truthStr = dec > 0 ? s.slice(0, d) + '.' + s.slice(d) : s;
    return { a, b, truthStr, sig };
  }
  throw new Error(`div 出题 200 次未产出净题(N=${n})——检查出题参数`);
}

// div 判分归一:剥尾随小数零与孤立小数点(123.4500 与 123.45 数值同——纯格式差放行;末位差一不放)
function normDecimal(s) {
  let t = s.replace(/[,\s]/g, '');
  if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
  return t;
}

async function call(prompt) {
  const headers = { 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  if (provider.auth === 'bearer') headers['Authorization'] = `Bearer ${KEY}`;
  else headers['x-api-key'] = KEY;
  const r = await fetch(`${provider.base_url}/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: provider.model, max_tokens: 16384, messages: [{ role: 'user', content: prompt }] }),
  });
  const body = await r.json();
  const text = (body.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, model: body.model ?? '(响应体缺 model 字段)', stop: body.stop_reason };
}

// 判分:取最后一个"答案:"行的数字串(允许全角冒号/空格),与真值比对
// mul=BigInt 乘积精确比对;div=小数串归一后比对(剥尾零等纯格式差,末位差一不放行)
function grade(text, truthStr) {
  const m = [...text.matchAll(/答案[:：]\s*([0-9.,\s]+)/g)].pop();
  if (!m) return { correct: false, got: '(无答案行)' };
  const got = m[1].replace(/[,\s]/g, '');
  const ok = TASK === 'div' ? normDecimal(got) === normDecimal(truthStr) : got === truthStr;
  return { correct: ok, got };
}

mkdirSync(OUT, { recursive: true });
const modelSeen = new Set();
const curve = {};

async function testTier(n, shots, tag) {
  const rand = rng(SEED + n * 1000 + (TASK === 'div' ? 500000 : 0));   // 每档独立种子流(confirm 复用同流前缀=同题续测;div 独立流不与 mul 撞题)
  let correct = 0;
  const runs = [];
  for (let i = 1; i <= shots; i++) {
    let prompt, truthStr, header;
    if (TASK === 'div') {
      const p = makeDivProblem(rand, n);
      prompt = buildDivPrompt(p.a, p.b, p.sig);
      truthStr = p.truthStr;
      header = `# ${p.a} ÷ ${p.b} ≈ ${truthStr}（${p.sig} 位有效数字）`;
    } else {
      const a = nDigit(rand, n), b = nDigit(rand, n);
      const truth = a * b;
      prompt = buildPrompt(a, b);
      truthStr = String(truth);
      header = `# ${a} × ${b} = ${truth}`;
    }
    const { text, model, stop } = await call(prompt);
    modelSeen.add(model);
    writeFileSync(join(OUT, `N${n}-${tag}-${i}.txt`), `${header}\n${text || `(空正文 stop_reason=${stop})`}`);
    const g = grade(text, truthStr);
    if (g.correct) correct++;
    runs.push({ i, correct: g.correct, ...(g.correct ? {} : { got: String(g.got).slice(0, 40), truth: truthStr }) });
    console.log(`  N=${n} ${tag}-${i}: ${g.correct ? '✓' : '✗ got=' + String(g.got).slice(0, 30)}`);
  }
  return { correct, shots, rate: correct / shots, runs };
}

// 统计纪律:爬梯小样本(n=5)只是便宜过滤,不具备判"低于 90%"的功力——真值 90% 时 5 发
// 出 4/5 的概率约 33%,拿它停梯是把抽样噪声当边界(实撞:首版 Ling N3 4/5 被错停)。
// 任何贴线判定(停梯或定档)都升 confirm 发数(缺省 20)确认:
//   爬梯 ≥90% → 直接爬下一档(爬梯通过不需确认——它只可能低估不影响边界正确性,边界档最终恒过 confirm);
//   爬梯 <90% → 本档升 20 发确认:真 <90% 才停梯,≥90% 继续爬;
//   停梯后前一档若未 confirm 过,补 confirm 定"最大 N"。
let maxN = null;
let lastConfirmed = null;   // 已 20 发确认 ≥90% 的最高档
for (let n = START; n <= MAXN; n++) {
  console.log(`[爬梯] N=${n} ×${N_CLIMB}…`);
  const r = await testTier(n, N_CLIMB, 'climb');
  curve[`N${n}`] = { climb: `${r.correct}/${r.shots}`, runs: r.runs };
  if (r.rate >= 0.9) continue;   // 爬梯过,继续(边界确认推迟到停梯时)
  console.log(`N=${n} 爬梯 ${r.correct}/${r.shots} <90%——升 ${N_CONFIRM} 发确认(小样本不判死)…`);
  const c = await testTier(n, N_CONFIRM, 'confirm');
  curve[`N${n}`].confirm = `${c.correct}/${c.shots}`; curve[`N${n}`].confirm_rate = c.rate;
  if (c.rate >= 0.9) { lastConfirmed = n; console.log(`N=${n} 确认 ${c.correct}/${c.shots} ≥90%——继续爬`); continue; }
  console.log(`N=${n} 确认 ${c.correct}/${c.shots} <90%——停梯`);
  break;
}
// 定档:停梯档的前一档(或测程顶)——未 confirm 过的补 confirm,不达则降档续确认
let candidate = null;
for (let n = MAXN; n >= START; n--) {
  if (!curve[`N${n}`]) continue;
  if (curve[`N${n}`].confirm_rate !== undefined && curve[`N${n}`].confirm_rate < 0.9) continue;   // 已确认不达标的档跳过
  candidate = n; break;
}
while (candidate !== null && candidate >= START) {
  if (curve[`N${candidate}`]?.confirm_rate >= 0.9) { maxN = candidate; break; }   // 爬梯期已确认过
  console.log(`[定档确认] N=${candidate} ×${N_CONFIRM}…`);
  const r = await testTier(candidate, N_CONFIRM, 'confirm');
  curve[`N${candidate}`] = { ...(curve[`N${candidate}`] ?? {}), confirm: `${r.correct}/${r.shots}`, confirm_rate: r.rate };
  if (r.rate >= 0.9) { maxN = candidate; break; }
  console.log(`N=${candidate} 确认 ${r.correct}/${r.shots} <90%——降档`);
  candidate--;
}

const summary = {
  service: SERVICE, model_from_response: [...modelSeen],
  date: new Date().toISOString().slice(0, 10), seed: SEED, task: TASK,
  维度: TASK === 'div'
    ? 'G1 推理复杂度——2N÷N 位除法阶梯,商 2N+1 位有效数字(迭代推理:每位商依赖上一步余数;禁工具纯推理;爬梯每档 n=' + N_CLIMB + ',候选最大档 confirm=' + N_CONFIRM + ' 发,正确率>=90% 定档)'
    : 'G1 推理复杂度——N 位整数乘法阶梯(直接推理;禁工具纯推理;爬梯每档 n=' + N_CLIMB + ',候选最大档 confirm=' + N_CONFIRM + ' 发,正确率>=90% 定档)',
  curve,
  最大N: maxN ?? `(N=${START} 都不达标)`,
};
writeFileSync(join(OUT, 'summary.yaml'), yamlDump(summary, { lineWidth: 200 }));
console.log(`\n══ summary ══\n最大N(>=90%,confirm ${N_CONFIRM} 发): ${summary.最大N}\n产物: ${OUT}`);
