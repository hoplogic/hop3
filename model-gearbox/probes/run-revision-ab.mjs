#!/usr/bin/env node
// P3 修订落实 A/B 探针（同一份上一版产出 + 同一份打回意见,分别用引擎标准态修订 prompt 与修订短 prompt 发给模型,看改没改对）。
// 用法: node model-gearbox/probes/run-revision-ab.mjs --service <service_id> [--n 6] [--arms standard,short] [--thinking on|off] [--max-tokens N] [--out <dir>]
//       node model-gearbox/probes/run-revision-ab.mjs --regrade <产物目录>   ← 不发请求,按现行判分规则重判已存的原始响应
// 考卷怎么来: 不手拼——用引擎真实装配。以 examples/hop-fact-check.md 跑 S 档语料(extract-scaling/doc-s.md):
//   CLI 推到提取步 2.3 → 交本文件内嵌的"上一版"points → 在验收步 2.4 以本文件内嵌的打回意见打回 →
//   引擎重跑读文档的两个 body 步(工具调用就地用引擎同款工具执行面应答)后回到 2.3 → 取引擎为这一轮装配的上下文,
//   经 renderPromptParts 渲染成 system/user 两块(与 dispatcher 发送面同一渲染源、同一拼法)。
//   两臂唯一差别是引擎修订档 setRevisionPromptMode('standard'|'short')(^anc-exec-revision-short-weak)。
//   渲染出的两份考卷原样存进产出目录(prompt-standard.json / prompt-short.json)——考卷随引擎版本变,改引擎后重跑即新卷。
// 上一版的毛病(意见就针对这两处):
//   ①P5 的前提②"四杯标准咖啡的咖啡因总量不超过 400 毫克"是把结论换个说法重说一遍——要补一杯多少毫克的具体数值与四杯总量(增补型修订,
//     2026-09-18 首次 A/B 里标准态 0/6 就栽在这一类:框架下它按重做全题来写,只会复读已有材料);
//   ②P2—P5 的 line_ref 是按原文两行的分法写的,引擎给的是按句拆成四行的编号(L1—L4)——要逐个改正(编辑型修订)。
// 判分四关(每发机械判,全过=该发改对):
//   ①形态: 从第一个 `points:` 键行起解析 YAML(键行前的思考文字按引擎规则允许,只记不扣),得到 5 个元素、每个元素六字段齐、id 为 P1—P5;
//   ②意见一落实: P5 的 premises 里有一个"每杯毫克数"x(40—200 之间),且同一段里写出了 4x(允许 ±5%)的四杯总量;
//   ③意见二落实: line_ref 为 P2=L2、P3=L2、P4=L3、P5=L4;
//   ④基准保留: 没被点名的部分原样——P1 六字段与上一版全等,P2/P3/P4 的 type/quote/claim 与上一版全等,P5 的 type/quote/claim 不变。
//   另记宽口径 quotes_type_kept(不进 pass):只看 quote/type 没被动,把"claim 换了个说法"的转述漂移与改坏原文摘抄分开。
// 产出: <out>/summary.yaml(两臂各关通过数,可贴档案 extract_scaling 的修订段)+ 两份考卷 + 每发原始响应。
// 纪律: 密钥只从 provider.api_key_env 读,只进请求头,不打印不落盘;模型身份取响应体 model 字段;n 缺省 6;
//   输出预算缺省读能力档案 max_output_tokens(与其它直连探针同口径);渲染依赖 dist/(先 npm run build)。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SERVICE = argOf('--service');
const N = parseInt(argOf('--n', '6'), 10);
const ARMS = argOf('--arms', 'standard,short').split(',');
const THINKING = argOf('--thinking', 'default');   // 与 run-task-complexity 同义:on/off 显式开关,default=端点缺省
const OUT = resolve(argOf('--out', join(HERE, 'extract-scaling', `run-revision-ab-${SERVICE}${THINKING === 'on' ? '-thinking' : THINKING === 'off' ? '-nothinking' : ''}-${new Date().toISOString().slice(0, 10)}`)));
const REGRADE_ONLY = args.includes('--regrade');
if (!SERVICE && !REGRADE_ONLY) { console.error('用法: --service <service_id> [--n 6] [--arms standard,short] [--thinking on|off] [--max-tokens N] [--out <dir>]'); process.exit(1); }

const cfg = REGRADE_ONLY ? {} : yamlLoad(readFileSync(join(homedir(), '.hopjit', 'config.yaml'), 'utf-8'));
const provider = REGRADE_ONLY ? {} : (cfg.providers ?? []).find(p => p.service_id === SERVICE);
if (!provider) { console.error(`service '${SERVICE}' 不在 providers 内`); process.exit(1); }
const KEY = REGRADE_ONLY ? '' : process.env[provider.api_key_env];
if (!KEY && !REGRADE_ONLY) { console.error(`环境变量 ${provider.api_key_env} 未设置`); process.exit(1); }
const PROFILE_DIR = join(HERE, '..', 'profiles');
const profile = readdirSync(PROFILE_DIR).filter(f => f.endsWith('.yaml'))
  .map(f => yamlLoad(readFileSync(join(PROFILE_DIR, f), 'utf-8')))
  .find(p => p && String(p.provider_ref).split(/\s/)[0] === SERVICE);
const MAX_TOKENS = parseInt(argOf('--max-tokens', ''), 10) || profile?.max_output_tokens || provider.max_output_tokens;
if (!MAX_TOKENS && !REGRADE_ONLY) { console.error(`找不到 ${SERVICE} 的输出预算(档案与配置都没有 max_output_tokens),用 --max-tokens 显式给`); process.exit(1); }

// ── 考卷内容(本文件即权威,改一字即换考卷) ──
const PRIOR = [
  { id: 'P1', type: 'fact', line_ref: 'L1', quote: '全球每天消费约 30 亿杯咖啡', claim: '全球每天消费约 30 亿杯咖啡', premises: '' },
  { id: 'P2', type: 'fact', line_ref: 'L1', quote: '咖啡因的半衰期约为 5 小时', claim: '咖啡因的半衰期约为 5 小时', premises: '' },
  { id: 'P3', type: 'inference', line_ref: 'L1', quote: '因此下午晚些时候摄入会影响夜间睡眠质量', claim: '下午晚些时候摄入咖啡因会影响夜间睡眠质量', premises: '① 咖啡因半衰期约 5 小时（即 P2）' },
  { id: 'P4', type: 'fact', line_ref: 'L2', quote: '美国 FDA 建议健康成年人每日咖啡因摄入不超过 400 毫克', claim: '美国 FDA 建议健康成年人每日咖啡因摄入不超过 400 毫克', premises: '' },
  { id: 'P5', type: 'inference', line_ref: 'L2', quote: '这说明每天四杯以内的标准咖啡对多数人是安全的', claim: '每天四杯以内的标准咖啡对多数人是安全的', premises: '① FDA 建议每日上限 400 毫克（即 P4）；② 四杯标准咖啡的咖啡因总量不超过 400 毫克' },
];
const GAP = [
  '1. P5 的前提②"四杯标准咖啡的咖啡因总量不超过 400 毫克"是把结论换个说法重复一遍,没有给出可核查的依据——请补上一杯标准咖啡大约含多少毫克咖啡因这个具体数值前提,并据此写出四杯的总量,让核查者能对照 400 毫克上限去核。',
  '2. line_ref 要对照带行号的原文（L1—L4 共四行）填写。上一版 P2—P5 的行号都填错了:P2 与 P3 的原句在 L2,P4 的原句在 L3,P5 的原句在 L4,请逐个改正;P1 的 L1 是对的,不要改动。',
].join('\n');
const WANT_LINE = { P2: 'L2', P3: 'L2', P4: 'L3', P5: 'L4' };

// ── 渲染两臂考卷(引擎真实装配,见文件头) ──
const { ExecutionEngine } = await import(join(REPO, 'dist', 'engine.js'));
const { renderPromptParts } = await import(join(REPO, 'dist', 'prompt.js'));
const { CompositeToolProvider } = await import(join(REPO, 'dist', 'tools-composite.js'));
async function answerToolRequests(e, r, host) {
  const pv = new CompositeToolProvider(host);
  while (r.status === 'tool_request') {
    const t = await pv.execute(r.tool, r.args);
    const w = e.submitToolResult(r.step_id, t.success ? t.result : { error: String(t.result) });
    if (w.status !== 'ok') throw new Error('工具结果回写失败: ' + JSON.stringify(w));
    r = await e.advanceToCaller();
  }
  return r;
}
async function renderArm(mode) {
  const ws = mkdtempSync(join(tmpdir(), 'revision-ab-'));
  copyFileSync(join(HERE, 'extract-scaling', 'doc-s.md'), join(ws, 'doc-s.md'));
  copyFileSync(join(REPO, 'examples', 'hop-fact-check.md'), join(ws, 'hop-fact-check.md'));
  const r0 = JSON.parse(execFileSync('node', [join(REPO, 'dist', 'cli.js'), '--json', 'run', 'hop-fact-check.md', '--params', '{"doc_path":"doc-s.md"}', '--state-dir', '.hopstate'], { cwd: ws, encoding: 'utf-8' }));
  if (r0.step_id !== '2.3') throw new Error('首个停点不是提取步 2.3(范本改过?): ' + JSON.stringify(r0).slice(0, 300));
  const cwd0 = process.cwd();
  process.chdir(ws);   // 引擎按工作目录解析 work_zone 相对路径
  try {
    const e = ExecutionEngine.load(join(ws, '.hopstate', r0.instance_id));
    e.setRevisionPromptMode(mode);
    let r = await e.completeAndAdvance('2.3', { points: PRIOR });
    if (r.step_id !== '2.4') throw new Error('交提取步后不是验收步 2.4: ' + JSON.stringify(r).slice(0, 300));
    const host = { workspace_dir: ws, sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: '' };
    r = await answerToolRequests(e, await e.completeAndAdvance('2.4', { extract_ok: false, extract_gap: GAP }), host);
    if (r.step_id !== '2.3' || !r.context) throw new Error('打回后没回到提取步 2.3: ' + JSON.stringify(r).slice(0, 300));
    const p = renderPromptParts(r.context, 'reason');
    return { system: `Working directory: ${ws}\n\n` + p.stableSections.join('\n\n'), user: p.volatileSections.join('\n\n'), revision_short: r.context.revision_short === true };
  } finally { process.chdir(cwd0); }
}

async function call(prompt) {
  const headers = { 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  if (provider.auth === 'bearer') headers['Authorization'] = `Bearer ${KEY}`; else headers['x-api-key'] = KEY;
  const r = await fetch(`${provider.base_url}/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: provider.model, max_tokens: MAX_TOKENS, system: prompt.system, ...(THINKING === 'on' ? { thinking: { type: 'enabled', budget_tokens: Math.floor(MAX_TOKENS / 2) } } : THINKING === 'off' ? { thinking: { type: 'disabled' } } : {}), messages: [{ role: 'user', content: prompt.user }] }),
  });
  const body = await r.json();
  const text = (body.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, model: body.model ?? '(响应体缺 model 字段)', stop: body.stop_reason, http: r.status, error: body.error ? JSON.stringify(body.error).slice(0, 300) : undefined };
}

// ── 判分 ──
const FIELDS = ['id', 'type', 'line_ref', 'quote', 'claim', 'premises'];
const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
function grade(text) {
  const g = { form: false, comment1: false, comment2: false, baseline: false, quotes_kept: false, prose_before_key: false, notes: [] };
  // 围栏按引擎容忍规则处理(引擎解析层同样剥,不单独扣分):有含 points: 的围栏块就只取块内;
  // 没有围栏时从 points: 键行起取,遇到第一行顶格且不是 YAML 键的文字(交付后的自查散文)就截止
  const fenced = [...text.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)].map(x => x[1]).find(b => /^points\s*:/m.test(b));
  const body = fenced ?? text;
  const m = body.match(/^points\s*:/m);
  if (!m) { g.notes.push('没有 points: 键行' + (/^lack_of_info\s*:/m.test(text) ? '(交了 lack_of_info——声称信息不够)' : '')); return g; }
  g.prose_before_key = text.slice(0, text.indexOf(body) + m.index).replace(/```[a-zA-Z]*/g, '').trim().length > 0;
  const lines = body.slice(m.index).split('\n');
  const end = lines.findIndex((l, i) => i > 0 && l.trim() && !/^\s/.test(l) && !/^[A-Za-z_][\w]*\s*:/.test(l));
  let pts = null;
  try { pts = yamlLoad((end > 0 ? lines.slice(0, end) : lines).join('\n'))?.points; } catch (err) { g.notes.push('YAML 解析失败: ' + String(err.message).split('\n')[0]); return g; }
  if (!Array.isArray(pts)) { g.notes.push('points 不是列表'); return g; }
  const byId = Object.fromEntries(pts.filter(p => p && typeof p === 'object').map(p => [String(p.id), p]));
  g.form = pts.length === 5 && pts.every(p => p && typeof p === 'object' && FIELDS.every(f => f in p)) && PRIOR.every(q => byId[q.id]);
  if (!g.form) g.notes.push(`形态不合: ${pts.length} 个元素,id=${pts.map(p => p?.id).join('/')}`);
  const p5 = byId.P5;
  if (p5) {
    const prem = String(p5.premises ?? '');
    const nums = [...prem.matchAll(/(\d+(?:\.\d+)?)\s*(?:毫克|mg)/gi)].map(x => parseFloat(x[1]));
    const perCup = nums.filter(x => x >= 40 && x <= 200);
    g.comment1 = perCup.some(x => nums.some(y => Math.abs(y - 4 * x) <= 0.05 * 4 * x) || [...prem.matchAll(/(\d+(?:\.\d+)?)/g)].some(y => Math.abs(parseFloat(y[1]) - 4 * x) <= 0.05 * 4 * x));
    if (!g.comment1) g.notes.push('意见一未落实,P5 premises=' + prem.slice(0, 160));
  }
  const wrongLines = Object.entries(WANT_LINE).filter(([id, l]) => !byId[id] || !same(byId[id].line_ref, l));
  g.comment2 = wrongLines.length === 0;
  if (!g.comment2) g.notes.push('行号未改对: ' + wrongLines.map(([id, l]) => `${id} 应 ${l} 实 ${byId[id]?.line_ref}`).join(','));
  const broken = [];
  for (const q of PRIOR) {
    const p = byId[q.id]; if (!p) { broken.push(q.id + ' 缺失'); continue; }
    const keep = q.id === 'P1' ? FIELDS : ['type', 'quote', 'claim'];
    for (const f of keep) if (!same(p[f], q[f])) broken.push(`${q.id}.${f}`);
  }
  g.baseline = broken.length === 0;
  if (!g.baseline) g.notes.push('未点名处被改动: ' + broken.join(','));
  // 宽口径(只记不进 pass):只看原文摘抄 quote 与分类 type 有没有被动——claim 是模型自己的转述,换个说法不改原意的
  // 改写(如"半衰期"写成"在人体内的半衰期")在严口径下也算改动,宽口径把这类转述漂移与真改坏原文摘抄分开记
  g.quotes_kept = !broken.some(b => / 缺失$|\.(quote|type)$/.test(b));
  return g;
}

// ── 只重判模式:--regrade <产物目录>——不发请求,对已存的原始响应重跑判分并重写 summary(判分规则修正后用) ──
const REGRADE = argOf('--regrade');
if (REGRADE) {
  const dir = resolve(REGRADE);
  const old = yamlLoad(readFileSync(join(dir, 'summary.yaml'), 'utf-8'));
  for (const [arm, a] of Object.entries(old.arms)) {
    const n = a.shots.length;
    a.shots = a.shots.map(s => { const text = readFileSync(join(dir, `${arm}-${s.shot}.txt`), 'utf-8'); const g = grade(text); return { ...s, pass: g.form && g.comment1 && g.comment2 && g.baseline, ...g }; });
    const cnt = k => `${a.shots.filter(s => s[k]).length}/${n}`;
    Object.assign(a, { pass: cnt('pass'), form: cnt('form'), comment1_value_added: cnt('comment1'), comment2_line_refs_fixed: cnt('comment2'), baseline_kept: cnt('baseline'), quotes_type_kept: cnt('quotes_kept'), prose_before_key: cnt('prose_before_key') });
    console.log(`${arm}: 四关全过 ${a.pass}(形态 ${a.form} / 意见一 ${a.comment1_value_added} / 意见二 ${a.comment2_line_refs_fixed} / 基准 ${a.baseline_kept};宽口径摘抄与分类未动 ${a.quotes_type_kept})`);
    for (const s of a.shots) if (!s.pass) console.log(`  ${arm}-${s.shot}: ${s.notes.join(' | ')}`);
  }
  writeFileSync(join(dir, 'summary.yaml'), yamlDump(old, { lineWidth: 200 }));
  process.exit(0);
}

// ── 主流程 ──
mkdirSync(OUT, { recursive: true });
const prompts = {};
for (const arm of ARMS) {
  prompts[arm] = await renderArm(arm);
  writeFileSync(join(OUT, `prompt-${arm}.json`), JSON.stringify(prompts[arm], null, 1));
  console.log(`考卷 ${arm}: revision_short=${prompts[arm].revision_short} system ${prompts[arm].system.length} 字符 / user ${prompts[arm].user.length} 字符`);
}
const models = new Set();
const arms = {};
for (const arm of ARMS) {
  const shots = [];
  for (let i = 1; i <= N; i++) {
    const t0 = Date.now();
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {   // 限流/服务端错不是能力读数:等 30 秒重发,最多 3 次
      res = await call(prompts[arm]);
      if (res.http !== 429 && res.http < 500) break;
      await new Promise(ok => setTimeout(ok, 30000));
    }
    if (res.http >= 400) throw new Error(`端点报错 HTTP ${res.http}——环境故障不是能力读数,探针中止不计分: ${res.error ?? ''}`);
    models.add(res.model);
    writeFileSync(join(OUT, `${arm}-${i}.txt`), res.text || `(空正文 stop_reason=${res.stop} http=${res.http} ${res.error ?? ''})`);
    const g = grade(res.text);
    const pass = g.form && g.comment1 && g.comment2 && g.baseline;
    shots.push({ shot: i, pass, ...g, stop_reason: res.stop, seconds: Math.round((Date.now() - t0) / 1000) });
    console.log(`${arm}-${i}: ${pass ? '✅' : '❌'} 形态${g.form ? '✓' : '✗'} 意见一${g.comment1 ? '✓' : '✗'} 意见二${g.comment2 ? '✓' : '✗'} 基准${g.baseline ? '✓' : '✗'}${g.prose_before_key ? ' (键行前有思考文字)' : ''} ${g.notes.join(' | ')}`);
  }
  const cnt = k => `${shots.filter(s => s[k]).length}/${N}`;
  arms[arm] = { revision_short: prompts[arm].revision_short, prompt_chars: prompts[arm].system.length + prompts[arm].user.length, pass: cnt('pass'), form: cnt('form'), comment1_value_added: cnt('comment1'), comment2_line_refs_fixed: cnt('comment2'), baseline_kept: cnt('baseline'), quotes_type_kept: cnt('quotes_kept'), prose_before_key: cnt('prose_before_key'), shots };
}
const summary = {
  probe: 'run-revision-ab', service: SERVICE, model_from_response: [...models], date: new Date().toISOString().slice(0, 10),
  thinking: THINKING, max_tokens: MAX_TOKENS, n: N,
  说明: '同一份上一版 points + 同一份两条打回意见,两臂只差引擎修订档(standard=标准态全量修订 prompt,short=修订短 prompt)。四关:形态/意见一(补每杯毫克数与四杯总量)/意见二(行号改成 L2/L2/L3/L4)/基准保留;pass=四关全过。quotes_type_kept=宽口径(只看原文摘抄与分类没被动,允许 claim 转述换说法),只记不进 pass。prose_before_key 只记不扣(引擎允许键行前写思考)',
  arms,
};
writeFileSync(join(OUT, 'summary.yaml'), yamlDump(summary, { lineWidth: 200 }));
console.log(`\n══ ${SERVICE} ══\n` + ARMS.map(a => `${a}: 四关全过 ${arms[a].pass}(形态 ${arms[a].form} / 意见一 ${arms[a].comment1_value_added} / 意见二 ${arms[a].comment2_line_refs_fixed} / 基准 ${arms[a].baseline_kept})`).join('\n') + `\n产物: ${OUT}`);
