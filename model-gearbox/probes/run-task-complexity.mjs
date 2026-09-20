#!/usr/bin/env node
// G2 任务复杂度探针跑批（extract-scaling 语料的一键仪器——测"一次做正确的能力"）。
// 用法: node model-gearbox/probes/run-task-complexity.mjs --service <service_id> [--n 6] [--tiers xs,s,m,l] [--out <dir>]
// 测法: 每档语料直连单发(无重试无引擎兜底——裸能力=首轮通过率),产出对答案键机械判分。
//   判分三关(对 doc-<档>.key.yaml): ①schema(产出可解析为点数组且字段齐) ②覆盖(required 逐条:
//   claim 含 match 全部词〔|=任一〕且 type 相符) ③前提(premises_must_cite 条目的 premises 非空且非纯编号)。
//   三关全过=该发一次做对。曲线=各档 pass/n,坍塌点=首个 pass<n/2 的档。
// 产出: <out>/summary.yaml(可贴档案 extract_scaling 段)+全部原始响应留档。
// 纪律: 模型身份取响应体 model 字段;n 缺省 6;prompt 模板内嵌本文件(单发形态无既有模板——本仪器即模板权威,改一字即换考卷)。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SERVICE = argOf('--service');
const N = parseInt(argOf('--n', '6'), 10);
const TIERS = argOf('--tiers', 'xs,s,m,l').split(',');
const OUT = argOf('--out', join(HERE, 'extract-scaling', `run-${SERVICE}-${new Date().toISOString().slice(0, 10)}`));
if (!SERVICE) { console.error('用法: --service <service_id> [--n 6] [--tiers xs,s,m,l] [--out <dir>]'); process.exit(1); }

const cfg = yamlLoad(readFileSync(join(homedir(), '.hopjit', 'config.yaml'), 'utf-8'));
const provider = (cfg.providers ?? []).find(p => p.service_id === SERVICE);
if (!provider) { console.error(`service '${SERVICE}' 不在 providers 内`); process.exit(1); }
const KEY = process.env[provider.api_key_env];
if (!KEY) { console.error(`环境变量 ${provider.api_key_env} 未设置`); process.exit(1); }

// 输出预算:缺省读该服务的能力档案 max_output_tokens——探针纪律 2026-09-19:自设小预算会把思考型
// 模型的预算病记成能力病(本仪器写死 16384 时代给 deepseek XL/XXL 记了假 0 分——思考先烧光预算正文
// 全空)。档案找不到就报错退出不静默回落;--max-tokens 显式覆盖仅供预算敏感性对照臂。
import { readdirSync } from 'node:fs';
const PROFILE_DIR = join(HERE, '..', 'profiles');
const profile = readdirSync(PROFILE_DIR).filter(f => f.endsWith('.yaml'))
  .map(f => yamlLoad(readFileSync(join(PROFILE_DIR, f), 'utf-8')))
  .find(p => p && String(p.provider_ref).split(/\s/)[0] === SERVICE);
const MAX_TOKENS = parseInt(argOf('--max-tokens', ''), 10) || profile?.max_output_tokens;
if (!MAX_TOKENS) { console.error(`档案里找不到 provider_ref=${SERVICE} 的 max_output_tokens——先补档案,不许猜预算`); process.exit(1); }
console.log(`[预算] max_tokens=${MAX_TOKENS} (${argOf('--max-tokens') ? '显式覆盖' : '读自能力档案'})`);

// 单发提取 prompt(与 hop-fact-check 2.3 的字段契约同构,砍引擎分层——裸单发测裸能力)
function buildPrompt(doc) {
  const numbered = doc.split(/(?<=[。！？])/).map(s => s.trim()).filter(Boolean)
    .map((s, i) => `L${i + 1}: ${s}`).join('\n');
  return `从下面的文档提取全部核查点,穷举、逐条编号（P1/P2…）:
- **事实点**(type=fact): 可独立查证的客观断言——具体数据、事件、时间、引述、明确的因果陈述;
- **推演点**(type=inference): 文档从事实推出的结论/预测/评价——含"因此/说明/意味着"等推理跳转。

每点五个字段: id / type(fact 或 inference) / line_ref(照抄行号如 L2) / claim(断言提炼成中性可检索的一句话,补全省略的主语宾语) / premises(推演点专用:该结论依赖的事实前提,每条把内容写全,不能只写编号;fact 点留空字符串)。

一句话含多个独立断言时拆成多点。宁细勿漏。

## 文档(带行号)
${numbered}

## 交付格式(直接输出 YAML 数组,不要围栏,不要任何分析文字,第一行就是 "- id: P1")
- id: P1
  type: fact
  line_ref: L1
  claim: …
  premises: ""`;
}

async function call(prompt) {
  const headers = { 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  if (provider.auth === 'bearer') headers['Authorization'] = `Bearer ${KEY}`;
  else headers['x-api-key'] = KEY;
  const r = await fetch(`${provider.base_url}/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: provider.model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
  });
  const body = await r.json();
  const text = (body.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, model: body.model ?? '(响应体缺 model 字段)', stop: body.stop_reason };
}

// 机械判分(对答案键三关)
function grade(text, key) {
  // 关① schema: 剥可能的散文前置后解析(首轮散文前置本身记形态但只要数组可辨仍判覆盖——
  // schema 关单列: 首字符即数组=过)
  const cleanStart = text.trimStart().startsWith('- id') || text.trimStart().startsWith('- ');
  let pts = null;
  try { pts = yamlLoad(text); } catch { /* 整文不可解析,试截取数组段 */ }
  if (!Array.isArray(pts)) {
    const i = text.indexOf('- id');
    if (i >= 0) { try { pts = yamlLoad(text.slice(i)); } catch { /* 保持 null */ } }
  }
  if (!Array.isArray(pts)) {
    // 逐条抢救解析(实撞:Ling claim 值以中文引号开头未包裹整值——单条 YAML 伤毒化整卷,
    // G2 覆盖被记 0 实为 G5 形态病。逐条切块解析,坏条跳过好条保留,schema 关仍如实记 false)
    const blocks = text.split(/\n(?=- id)/).filter(b => b.trim().startsWith('- id'));
    const rescued = [];
    for (const b of blocks) {
      try { const one = yamlLoad(b); if (Array.isArray(one) && one[0]) { rescued.push(one[0]); continue; } } catch { /* 落引号修复 */ }
      // 引号修复档:claim/premises 值以中文引号开头未包裹整值(YAML 语法伤)——给两字段值整体补双引号再试
      try {
        const fixed = b.replace(/^(\s+(?:claim|premises)): (.+)$/gm, (m, k, v) => /^["'|>]/.test(v.trim()) && !/^"[^"]*"$/.test(v.trim()) ? `${k}: "${v.trim().replace(/"/g, '\\"')}"` : m);
        const one = yamlLoad(fixed);
        if (Array.isArray(one) && one[0]) rescued.push(one[0]);
      } catch { /* 真坏条跳过 */ }
    }
    if (rescued.length) pts = rescued;
  }
  if (!Array.isArray(pts)) return { schema: false, prose_prefix: !cleanStart, covered: 0, required: key.required.length, premises_ok: false, pass: false, miss: ['(产出不可解析为数组)'] };
  const fieldsOk = pts.every(p => p && typeof p === 'object' && 'type' in p && 'claim' in p);
  // 关② 覆盖: required 逐条 match(词含"|"=任一命中;全部词命中且 type 相符)
  // 空白归一比对(键写"5 小时"模型写"5小时"同义——中文语境空格非语义,冒烟实撞后归一)
  const norm = (s) => String(s ?? '').replace(/[\s]/g, '');
  const hit = (p, words) => words.every(w => w.split('|').some(alt => norm(p.claim).includes(norm(alt))));
  const miss = [];
  let covered = 0;
  for (const req of key.required) {
    const typeOk = (p) => req.type.split('|').includes(String(p.type));   // 键 type 支持 a|b 两可(裁量两可不作判分依据)
    const found = pts.find(p => hit(p, req.match) && typeOk(p));
    if (found) covered++;
    else miss.push(req.ref + (pts.find(p => hit(p, req.match)) ? '(词中但 type 错)' : '(未命中)'));
  }
  // 关③ 前提: premises_must_cite 条目的对应点 premises 非空且长度>10(纯编号如"P5"不算)
  let premOk = true;
  for (const req of key.required) {
    const mustCite = req.premises_must_cite;
    const ifInf = req.premises_if_inference;   // 两可条目的分道前提:按 inference 提取才查(按 fact 提取天然无前提)
    if (!mustCite && !ifInf) continue;
    const found = pts.find(p => hit(p, req.match) && req.type.split('|').includes(String(p.type)));
    if (!found) { premOk = false; continue; }
    if (ifInf && String(found.type) !== 'inference') continue;
    const prem = String(found.premises ?? '');
    if (prem.replace(/[P0-9①②③、,;\s]/g, '').length < 5) { premOk = false; miss.push(req.ref + '(前提空/纯编号)'); }
  }
  const pass = cleanStart && fieldsOk && covered === key.required.length && premOk;
  return { schema: cleanStart && fieldsOk, prose_prefix: !cleanStart, covered, required: key.required.length, premises_ok: premOk, pass, miss };
}

mkdirSync(OUT, { recursive: true });
const modelSeen = new Set();
const tiers = {};
for (const tier of TIERS) {
  const doc = readFileSync(join(HERE, 'extract-scaling', `doc-${tier}.md`), 'utf-8');
  const key = yamlLoad(readFileSync(join(HERE, 'extract-scaling', `doc-${tier}.key.yaml`), 'utf-8'));
  const prompt = buildPrompt(doc);
  console.log(`[${tier.toUpperCase()}] ${key.required.length} 必要点 ×${N}…`);
  const runs = [];
  for (let i = 1; i <= N; i++) {
    const { text, model, stop } = await call(prompt);
    modelSeen.add(model);
    writeFileSync(join(OUT, `${tier}-${i}.txt`), text || `(空正文 stop_reason=${stop})`);
    const g = grade(text, key);
    runs.push({ i, ...g });
    console.log(`  ${tier}-${i}: pass=${g.pass} 覆盖=${g.covered}/${g.required} schema=${g.schema}${g.miss.length ? ' 缺:' + g.miss.slice(0, 3).join('/') : ''}`);
  }
  const passN = runs.filter(r => r.pass).length;
  tiers[tier] = { pass: `${passN}/${N}`, pass_rate: passN / N, runs };
}
// 坍塌点=首个 pass_rate < 0.5 的档
const order = ['xs', 's', 'm', 'l', 'xl', 'xxl'].filter(t => TIERS.includes(t));   // 档序全集(高档生成件随扩——漏登新档=坍塌点判定盲区,Ling XXL 0/6 报'未坍塌'实撞)
const collapse = order.find(t => tiers[t] && tiers[t].pass_rate < 0.5) ?? '(测程内未坍塌)';
const summary = {
  service: SERVICE, model_from_response: [...modelSeen], n_per_cell: N,
  date: new Date().toISOString().slice(0, 10),
  维度: 'G2 任务复杂度(一次做正确的能力)——单发裸能力,无重试无引擎兜底',
  tiers: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, { pass: v.pass, runs: v.runs.map(r => ({ i: r.i, pass: r.pass, covered: `${r.covered}/${r.required}`, prose_prefix: r.prose_prefix, miss: r.miss })) }])),
  坍塌点: collapse,
};
writeFileSync(join(OUT, 'summary.yaml'), yamlDump(summary, { lineWidth: 200 }));
console.log(`\n══ summary ══\n${order.map(t => `${t.toUpperCase()}: ${tiers[t]?.pass ?? '-'}`).join('  ')}\n坍塌点: ${collapse}\n产物: ${OUT}`);
