#!/usr/bin/env node
// 端点输出上限探针（层一协议面——零引擎直连,量"端点对单次响应到底放多少输出 token"）。
// 用法: node model-gearbox/probes/run-output-cap.mjs [--services a,b] [--n 2] [--count 15000] [--max-tokens 65536] [--out <yaml>] [--raw-dir <dir>] [--merge]
// 测法: 对 ~/.hopjit/config.yaml 里每个 anthropic 协议 provider 发必然超长的请求(从 1 数到 count,每行一个数——缺省 15000 约需 7 万 tokens,超过请求的 65536,不带上限的端点应写满请求值),
//   请求 max_tokens 取 --max-tokens(缺省 65536),记录响应的 stop_reason / output_tokens / 响应体 model 字段。
//   判定: stop_reason=max_tokens 且 output_tokens < 请求值×0.9 → 端点自带上限=该值(n 发一致才记硬上限值,
//   不一致记"不稳定"并列出各发值);stop_reason=max_tokens 且 output_tokens ≥ 请求值×0.9 → 本地请求上限掐断
//   (请求值本身太小,加大 --max-tokens 再量);stop_reason=end_turn → 本次未触顶,记"至少 output_tokens"。
//   0.9 与引擎截断报文的判据同值(docs/design/step-dispatcher.md ^anc-exec-output-truncation-loud)。
// 产出: --out 机读表(缺省 output-cap/endpoint-output-caps.yaml),每个端点一条,各带自己的实测日期与数数长度;
//   --merge 时只替换本次测到的端点条目、保留表里其余条目(个别模型对长数数任务会自己停笔或拒写——
//   实测 Qwen3.8-27B 在 antchat 端点上数到 15000 时两发只写 5770 与 8 tokens 就停,数到 8000 时一发回"由于输出长度限制无法列出",
//   这类端点单独换 --count 补测后并入);
//   --raw-dir 给了才留每发的响应摘要(不含正文全文)。
// 纪律: 只读配置不改配置;密钥只从 provider.api_key_env 指名的环境变量读,只进请求头,不打印不落盘;
//   模型身份取响应体 model 字段。本探针不读能力档案的 max_output_tokens——它量的正是这个数。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = parseInt(argOf('--n', '2'), 10);
const COUNT = parseInt(argOf('--count', '15000'), 10);
const MAX_TOKENS = parseInt(argOf('--max-tokens', '65536'), 10);
const OUT = argOf('--out', join(HERE, 'output-cap', 'endpoint-output-caps.yaml'));
const RAW_DIR = argOf('--raw-dir');
const ONLY = argOf('--services') ? argOf('--services').split(',') : null;
const MERGE = args.includes('--merge');
const THRESHOLD = 0.9;

const cfg = yamlLoad(readFileSync(join(homedir(), '.hopjit', 'config.yaml'), 'utf-8'));
const providers = (cfg.providers ?? [])
  .filter(p => (p.protocol ?? 'anthropic') === 'anthropic')
  .filter(p => !ONLY || ONLY.includes(p.service_id));
if (providers.length === 0) { console.error('没有可测的 anthropic 协议 provider(检查 --services 拼写)'); process.exit(1); }

const PROMPT = `从 1 数到 ${COUNT}，每行只写一个阿拉伯数字，不要写任何其他文字，不要省略，不要用省略号，一直写到 ${COUNT} 为止。`;

async function callOnce(provider) {
  const key = process.env[provider.api_key_env];
  if (!key) return { error: `环境变量 ${provider.api_key_env} 未设置` };
  const headers = { 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  if (provider.auth === 'bearer') headers['Authorization'] = `Bearer ${key}`;
  else headers['x-api-key'] = key;
  const started = Date.now();
  try {
    const r = await fetch(`${provider.base_url}/v1/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: provider.model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: PROMPT }] }),
      signal: AbortSignal.timeout(20 * 60 * 1000),
    });
    const body = await r.json();
    if (!r.ok) return { error: `HTTP ${r.status}: ${JSON.stringify(body).slice(0, 300)}` };
    const text = (body.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    return {
      stop_reason: body.stop_reason ?? null,
      output_tokens: body.usage?.output_tokens ?? null,
      response_model: body.model ?? '(响应体缺 model 字段)',
      text_chars: text.length,
      last_line: lines.at(-1) ?? '',
      block_types: (body.content ?? []).map(b => b.type),
      seconds: Math.round((Date.now() - started) / 1000),
    };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

function judgeOne(a) {
  if (a.error) return 'error';
  if (a.stop_reason === 'max_tokens' && typeof a.output_tokens === 'number') {
    return a.output_tokens < MAX_TOKENS * THRESHOLD ? 'endpoint_cap' : 'request_cap';
  }
  if (a.stop_reason === 'end_turn') return 'not_reached';
  return 'other';
}

function verdict(attempts) {
  const kinds = attempts.map(judgeOne);
  const toks = attempts.map(a => a.output_tokens);
  if (kinds.every(k => k === 'error')) {
    return { verdict: 'error', endpoint_output_cap: null, note: `全部请求失败,未量到:${attempts.map(a => a.error).join(' / ')}` };
  }
  if (kinds.includes('request_cap') && !kinds.includes('endpoint_cap')) {
    // 任一发写满请求值=端点放行过这么多,不存在更低的端点上限;其余发提前自然结束是模型自己停笔(数腻了/拒写),不是端点掐断
    return { verdict: 'request_cap', endpoint_output_cap: null, at_least: Math.max(...toks.filter(t => typeof t === 'number')), note: `至少一发写满了请求的 ${MAX_TOKENS}(各发 ${toks.join('/')}),端点上限不低于请求值;要量真上限加大 --max-tokens` };
  }
  if (kinds.every(k => k === 'endpoint_cap')) {
    return new Set(toks).size === 1
      ? { verdict: 'endpoint_cap', endpoint_output_cap: toks[0], note: `${attempts.length} 发都在 ${toks[0]} 被掐断(请求 ${MAX_TOKENS}),端点自带上限,忽略请求 max_tokens` }
      : { verdict: 'endpoint_cap_unstable', endpoint_output_cap: null, note: `各发都低于请求值被掐断但数值不一致:${toks.join('/')}` };
  }
  if (kinds.every(k => k === 'not_reached')) {
    return { verdict: 'not_reached', endpoint_output_cap: null, at_least: Math.max(...toks), note: `未触顶:各发 ${toks.join('/')} tokens 都自然结束,端点上限至少 ${Math.max(...toks)};要量真上限加大 --count(模型提前停笔或拒写也落这一档,看 attempts 的 last_line)` };
  }
  return { verdict: 'mixed', endpoint_output_cap: null, note: `各发判定不一致:${kinds.join('/')}(${toks.join('/')})——见 attempts` };
}

const results = [];
for (const p of providers) {
  const attempts = [];
  for (let i = 0; i < N; i++) {
    console.log(`[${p.service_id}] 第 ${i + 1}/${N} 发…`);
    const a = await callOnce(p);
    attempts.push(a);
    console.log(`[${p.service_id}] 第 ${i + 1} 发: ${a.error ? '错误 ' + a.error : `stop_reason=${a.stop_reason} output_tokens=${a.output_tokens} model=${a.response_model} ${a.seconds}s`}`);
  }
  const v = verdict(attempts);
  results.push({
    service_id: p.service_id, base_url: p.base_url, request_model: p.model,
    response_model: attempts.find(a => a.response_model)?.response_model ?? null,
    measured: new Date().toISOString().slice(0, 10), count_to: COUNT, requested_max_tokens: MAX_TOKENS, ...v,
    attempts: attempts.map(a => a.error ? { error: a.error } : { stop_reason: a.stop_reason, output_tokens: a.output_tokens, last_line: a.last_line, seconds: a.seconds }),
  });
  if (RAW_DIR) { mkdirSync(RAW_DIR, { recursive: true }); writeFileSync(join(RAW_DIR, `${p.service_id}.json`), JSON.stringify(attempts, null, 2)); }
}

let kept = [];
if (MERGE) {
  try { kept = (yamlLoad(readFileSync(OUT, 'utf-8'))?.endpoints ?? []).filter(e => !results.some(r => r.service_id === e.service_id)); }
  catch { kept = []; }
}
const table = {
  probe: 'model-gearbox/probes/run-output-cap.mjs',
  method: `每端点发 ${N} 次"从 1 数到 count_to,每行一个数"的请求,请求 max_tokens=requested_max_tokens;stop_reason=max_tokens 且 output_tokens < 请求值×${THRESHOLD} 判端点自带上限(各发一致才记值);任一发写满请求值判端点上限不低于请求值;全部自然结束记"至少"`,
  endpoints: [...kept, ...results],
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `# 端点输出上限实测表(机读;由 run-output-cap.mjs 生成,重跑覆盖)\n${yamlDump(table, { lineWidth: 200 })}`);
console.log(`已写 ${OUT}`);
for (const r of results) console.log(`${r.service_id}: ${r.verdict} ${r.endpoint_output_cap ?? r.at_least ?? ''} — ${r.note}`);
