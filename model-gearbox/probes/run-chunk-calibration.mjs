#!/usr/bin/env node
// 切块尺寸标定探针——回答两个问题(作者点题 2026-09-19):
//   ① 分块提取能不能治覆盖率塌方,各模型的建议块大小是多少;
//   ② 3 并发 try-best(同块三实例取并集)能把覆盖率抬到多少。
// 方法: 同一份语料(缺省 doc-xl,40 点答案键)按不同块大小切,逐块提取→全文并集→对答案键算覆盖率。
//   完备性不判 pass/fail,记覆盖率百分比(作者定'完备性不要追求十全十美')。
// 用法: node run-chunk-calibration.mjs --service <id> [--doc extract-scaling/doc-xl.md] [--sizes 4,8,16] [--n 2] [--burst 3]
//   --sizes 块大小清单(行数);--n 每配置重复发数;--burst 并发臂的实例数(只在各尺寸单发跑完后,对最优尺寸跑并发臂)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SERVICE = argOf('--service');
const DOC = argOf('--doc', join(HERE, 'extract-scaling', 'doc-xl.md'));
const KEYF = DOC.replace(/\.md$/, '.key.yaml');
const SIZES = argOf('--sizes', '4,8,16').split(',').map(Number);
const N = parseInt(argOf('--n', '2'), 10);
const BURST = parseInt(argOf('--burst', '3'), 10);
const OUT = argOf('--out', join(HERE, 'chunk-calibration', `run-${SERVICE}-${new Date().toISOString().slice(0, 10)}`));
if (!SERVICE) { console.error('用法: --service <id> [--sizes 4,8,16] [--n 2] [--burst 3]'); process.exit(1); }

const cfg = yamlLoad(readFileSync(join(homedir(), '.hopjit', 'config.yaml'), 'utf-8'));
const provider = (cfg.providers ?? []).find(p => p.service_id === SERVICE);
if (!provider) { console.error(`service '${SERVICE}' 不在 providers 内`); process.exit(1); }
const KEY = process.env[provider.api_key_env];
if (!KEY) { console.error(`环境变量 ${provider.api_key_env} 未设置`); process.exit(1); }

// 输出预算:缺省读该服务的能力档案 max_output_tokens(model-gearbox/profiles/<service>.yaml 或档案内 service_id 匹配件);
// 档案找不到时报错退出——不静默回落小值(小预算会把 thinking 型的预算病记成能力病)。--max-tokens 显式覆盖仅供对照臂。
import { readdirSync } from 'node:fs';
const PROFILE_DIR = join(HERE, '..', 'profiles');
const profile = readdirSync(PROFILE_DIR).filter(f => f.endsWith('.yaml'))
  .map(f => yamlLoad(readFileSync(join(PROFILE_DIR, f), 'utf-8')))
  .find(p => p && String(p.provider_ref).split(/\s/)[0] === SERVICE);
const MAX_TOKENS = parseInt(argOf('--max-tokens', ''), 10) || profile?.max_output_tokens;
if (!MAX_TOKENS) { console.error(`档案里找不到 provider_ref=${SERVICE} 的 max_output_tokens——先补档案,不许猜预算`); process.exit(1); }
console.log(`[预算] max_tokens=${MAX_TOKENS} (${argOf('--max-tokens') ? '显式覆盖' : '读自能力档案'})`);

const doc = readFileSync(DOC, 'utf-8');
const key = yamlLoad(readFileSync(KEYF, 'utf-8'));

// 与 run-task-complexity 同款断行编号
const numberedLines = doc.split(/(?<=[。！？])/).map(s => s.trim()).filter(Boolean)
  .map((s, i) => `L${i + 1}: ${s}`);

function buildChunkPrompt(chunkLines) {
  return `从下面的文档片段提取全部核查点,穷举、逐条编号（P1/P2…,块内自编号即可）:
- **事实点**(type=fact): 可独立查证的客观断言——具体数据、事件、时间、引述、明确的因果陈述;
- **推演点**(type=inference): 文档从事实推出的结论/预测/评价——含"因此/说明/意味着"等推理跳转。

每点五个字段: id / type(fact 或 inference) / line_ref(照抄行首 L 号) / claim(断言提炼成中性可检索的一句话,补全省略的主语宾语) / premises(推演点专用,fact 点留空字符串)。

一句话含多个独立断言时拆成多点。宁细勿漏。只处理给出的这几行。

## 文档片段(带全局行号)
${chunkLines.join('\n')}

## 交付格式(直接输出 YAML 数组,不要围栏,不要任何分析文字;片段无可提取点时输出空数组 [])
- id: P1
  type: fact
  line_ref: L?
  claim: …
  premises: ""`;
}

async function call(prompt) {
  const headers = { 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  if (provider.auth === 'bearer') headers['Authorization'] = `Bearer ${KEY}`;
  else headers['x-api-key'] = KEY;
  const r = await fetch(`${provider.base_url}/v1/messages`, {
    method: 'POST', headers,
    // 输出预算恒读档案值(探针纪律 2026-09-19——自设小预算把 thinking 型的预算病误记成能力病:
    // deepseek 8K 档整篇 0/40 而 64K 满分,假坍塌入了首版标定表)。--max-tokens 显式覆盖仅供预算敏感性对照臂。
    body: JSON.stringify({ model: provider.model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
  });
  const body = await r.json();
  const text = (body.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, usage: body.usage ?? {} };
}

function parsePoints(text) {
  let s = text.trim();
  const fence = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?\s*```$/);
  if (fence) s = fence[1];
  try {
    const doc2 = yamlLoad(s);
    if (Array.isArray(doc2)) return doc2.filter(p => p && typeof p === 'object');
  } catch { /* 整体炸,逐块救 */ }
  const out = [];
  for (const block of s.split(/\n(?=- id:)/)) {
    try { const d = yamlLoad(block); if (Array.isArray(d) && d[0]) out.push(d[0]); } catch { /* 弃 */ }
  }
  return out;
}

// 覆盖率判分: required 逐条 match(与 run-task-complexity 同判据——词全含,|=任一;type 相符)
function coverage(points) {
  const hit = (p, words) => words.every(w => String(w).split('|').some(alt => String(p.claim ?? '').replace(/\s/g, '').includes(String(alt).replace(/\s/g, ''))));
  const typeOk = (p, req) => String(req.type).split('|').includes(String(p.type));
  let got = 0; const missed = [];
  for (const req of key.required) {
    if (points.find(p => hit(p, req.match) && typeOk(p, req))) got++;
    else missed.push(req.ref);
  }
  return { got, total: key.required.length, rate: got / key.required.length, missed };
}

function makeChunks(size) {
  const chunks = [];
  for (let i = 0; i < numberedLines.length; i += size) chunks.push(numberedLines.slice(i, i + size));
  return chunks;
}

async function extractFullDoc(size) {
  // 一次全文提取 = 逐块串行调用取并集;返回 {points, calls, tokens}
  const chunks = makeChunks(size);
  const all = []; let tokens = 0;
  for (const c of chunks) {
    const { text, usage } = await call(buildChunkPrompt(c));
    tokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    all.push(...parsePoints(text));
  }
  return { points: all, calls: chunks.length, tokens };
}

mkdirSync(OUT, { recursive: true });
// doc 记相对路径——绝对路径含本机用户目录,进产物即撞 GitHub 净度闸(0.17.0 发版快照实撞 8 份全拦)
const DOC_REL = DOC.includes('/model-gearbox/') ? 'model-gearbox/' + DOC.split('/model-gearbox/')[1] : DOC;
const result = { service: SERVICE, doc: DOC_REL, key_points: key.required.length, sizes: {}, burst: {} };

// 基线对照: 整篇一发(size=全篇)
console.log('[基线] 整篇一发 ×' + N);
{
  const rates = [];
  for (let i = 0; i < N; i++) {
    const { text } = await call(buildChunkPrompt(numberedLines));
    const cov = coverage(parsePoints(text));
    rates.push(cov.rate);
    console.log(`  whole-${i + 1}: ${cov.got}/${cov.total}`);
  }
  result.sizes['whole'] = { rates: rates.map(r => +(r * 100).toFixed(1)) };
}

for (const size of SIZES) {
  console.log(`[块=${size} 行] ×${N}…`);
  const rates = []; let lastMissed = [];
  for (let i = 0; i < N; i++) {
    const { points, calls, tokens } = await extractFullDoc(size);
    const cov = coverage(points);
    rates.push(cov.rate); lastMissed = cov.missed;
    console.log(`  size${size}-${i + 1}: ${cov.got}/${cov.total} (${calls} 块, ${tokens} tokens)`);
  }
  result.sizes[`s${size}`] = { rates: rates.map(r => +(r * 100).toFixed(1)), last_missed: lastMissed };
}

// 并发臂: 取单发均值最高的块尺寸,同一份文档 BURST 个独立实例并集
const best = SIZES.map(s => [s, result.sizes[`s${s}`].rates.reduce((a, b) => a + b, 0) / N]).sort((a, b) => b[1] - a[1])[0][0];
console.log(`[并发臂] 块=${best} × ${BURST} 实例并集…`);
{
  const runs = await Promise.all(Array.from({ length: BURST }, () => extractFullDoc(best)));
  const merged = runs.flatMap(r => r.points);
  const cov = coverage(merged);
  const solo = runs.map(r => coverage(r.points));
  console.log(`  单实例: ${solo.map(c => c.got + '/' + c.total).join('  ')}`);
  console.log(`  ${BURST} 并集: ${cov.got}/${cov.total} (${(cov.rate * 100).toFixed(1)}%)  漏: ${cov.missed.join(',') || '无'}`);
  result.burst = { size: best, n: BURST, solo: solo.map(c => +(c.rate * 100).toFixed(1)), merged: +(cov.rate * 100).toFixed(1), merged_missed: cov.missed };
}

writeFileSync(join(OUT, 'summary.yaml'), yamlDump(result, { lineWidth: 200 }));
console.log('\n══ summary ══');
console.log('整篇基线:', result.sizes['whole'].rates.join('/'), '%');
for (const s of SIZES) console.log(`块=${s}:`, result.sizes[`s${s}`].rates.join('/'), '%');
console.log(`并发臂(块=${result.burst.size}×${BURST}): 单实例 ${result.burst.solo.join('/')} % → 并集 ${result.burst.merged}%`);
console.log('产物:', OUT);
