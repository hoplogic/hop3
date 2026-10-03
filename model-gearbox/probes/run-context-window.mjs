#!/usr/bin/env node
// 端点上下文窗口探针（层一协议面——零引擎直连,量"端点单次请求最多收多少输入 token,收进去的内容模型还读不读得到"）。
// 用法: node model-gearbox/probes/run-context-window.mjs --service <service_id> [--start 8000] [--max 2000000] [--precision 0.05] [--max-tokens 2048] [--out <yaml>] [--merge]
// 测法: 拼一段输入——开头一句暗号("本文开头的暗号是 <随机 8 位数>"),中间是编号记录行填充,末尾问"开头的暗号是什么"。
//   输入规模从 --start(估算 token 数)起逐次翻倍,直到端点拒收(HTTP 4xx)或到 --max;再在"最后一次收下"与"第一次拒收"之间二分,
//   直到两者相差不到 --precision(缺省 5%)。每发记:端点收没收(HTTP 状态)、响应 usage.input_tokens(端点自己数的输入量,
//   这是窗口读数的权威——填充按字符估算只用来定步长)、回答里有没有暗号(收下的输入模型真读到了开头没有)、拒收时的报错原文前 300 字符。
//   判定: 窗口 = 最后一次完整收下的请求的 input_tokens(端点实数),记"至少 X,不到 Y 被拒";到 --max 仍收下记"至少 X(测程顶)"。
//   端点实数取 usage 里三项之和(未缓存 input_tokens + 读缓存 cache_read_input_tokens + 写缓存 cache_creation_input_tokens)——
//   两家端点都会自动缓存相同前缀,只看 input_tokens 会少算(实撞:glm_flash 发约 100 万 token,input_tokens 只记 23449,另 100 万记在读缓存里;
//   qwen_flash 同前缀的 768K 那发只记 426679)。为此每发开头另放一个不同的测试编号,让端点缓存不上。
//   "完整收下"要求端点实数不低于按字符估算量的八成,低于的发次记 silently_truncated(端点回 200 却悄悄截掉了输入),按超窗处理;
//   超窗时端点是报错还是静默截断记进 over_window_behavior(后者对引擎更危险:没有报错可接)。
//   暗号答错单独记——收下却读不到开头,说明窗口名义上够、实际用不上,这个读数比名义窗口更要紧。
// 产出: --out 机读表(缺省 context-window/endpoint-context-windows.yaml),每个端点一条带实测日期;--merge 只替换本次测到的端点条目。
// 纪律: 只读配置不改配置;密钥只从 provider.api_key_env 指名的环境变量读,只进请求头,不打印不落盘;模型身份取响应体 model 字段。
//   输出预算给小(缺省 2048)——只要它答一个暗号;思考恒开的端点思考也吃这份预算,答空时如实记 stop_reason。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SERVICE = argOf('--service');
const START = parseInt(argOf('--start', '8000'), 10);
const MAX = parseInt(argOf('--max', '2000000'), 10);
const PRECISION = parseFloat(argOf('--precision', '0.05'));
const MAX_TOKENS = parseInt(argOf('--max-tokens', '2048'), 10);
const OUT = argOf('--out', join(HERE, 'context-window', 'endpoint-context-windows.yaml'));
const MERGE = args.includes('--merge');
if (!SERVICE) { console.error('用法: --service <service_id> [--start 8000] [--max 2000000] [--precision 0.05] [--max-tokens 2048] [--out <yaml>] [--merge]'); process.exit(1); }

const cfg = yamlLoad(readFileSync(join(homedir(), '.hopjit', 'config.yaml'), 'utf-8'));
const provider = (cfg.providers ?? []).find(p => p.service_id === SERVICE);
if (!provider) { console.error(`service '${SERVICE}' 不在 ~/.hopjit/config.yaml providers 内`); process.exit(1); }
const KEY = process.env[provider.api_key_env];
if (!KEY) { console.error(`环境变量 ${provider.api_key_env} 未设置`); process.exit(1); }

// 伪随机(固定种子,可复现):暗号与填充值
let seed = 20260928;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
const SECRET = String(10000000 + (rnd() % 90000000));
// 填充行:编号 + 六位值,每行内容不同(避免端点对重复文本做压缩或模型把重复当噪声跳过)
const lineOf = i => `记录 ${i}:检测值 ${100000 + (rnd() % 900000)},状态 ${['正常', '偏高', '偏低', '待复核'][rnd() % 4]}。\n`;
let charsPerToken = 1.6;   // 首发后按端点实数校准
// 每发开头放一个不同的编号——前缀相同的请求会被端点自动缓存,缓存命中的部分记在 cache_read_input_tokens 不进 input_tokens
// (实撞 qwen_flash:同前缀的 768K 那发 input_tokens 只记 426679),读数会被缓存搅乱;开头各不相同,端点就缓存不上
let shotNo = 0;
const buildPrompt = targetTokens => {
  const head = `第 ${++shotNo} 次测试,测试编号 ${targetTokens}-${shotNo}。本文开头的暗号是 ${SECRET}。请记住它,文末会问。\n\n`;
  const tail = `\n\n问题:本文开头的暗号是什么?只回答那个 8 位数字。`;
  const budgetChars = Math.max(0, Math.floor(targetTokens * charsPerToken) - head.length - tail.length);
  seed = 20260928; rnd();   // 每次从同一种子重建,规模不同但前缀一致
  const parts = []; let len = 0; let i = 1;
  while (len < budgetChars) { const l = lineOf(i++); parts.push(l); len += l.length; }
  return head + parts.join('') + tail;
};

const call = async targetTokens => {
  const prompt = buildPrompt(targetTokens);
  const expectedTokens = Math.round(prompt.length / charsPerToken);   // 按已校准的字符/token 比估的本发输入量
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (provider.auth === 'bearer') headers['Authorization'] = `Bearer ${KEY}`; else headers['x-api-key'] = KEY;
  const t0 = Date.now();
  // 限流(429)与服务端错(5xx)不是窗口读数——等 30 秒重发,最多 3 次;仍不行就如实记成拒收并带报错原文
  let r, raw;
  for (let attempt = 0; attempt < 4; attempt++) {
    r = await fetch(`${provider.base_url}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ model: provider.model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }) });
    raw = await r.text();
    if (r.status !== 429 && r.status < 500) break;
    console.log(`[重发] HTTP ${r.status},30 秒后重试`);
    await new Promise(res => setTimeout(res, 30000));
  }
  // 欠费/鉴权类 4xx 同样是 4xx,但与窗口无关——当成"超窗拒收"会把上界记错(2026-09-28 百炼欠费实撞),探针直接中止
  if (/Arrearage|Billing issue|good standing|InvalidApiKey|Unauthorized|quota/i.test(raw)) throw new Error(`端点报账户类错误 HTTP ${r.status}——环境故障不是窗口读数,探针中止: ${raw.slice(0, 300)}`);
  let body = null; try { body = JSON.parse(raw); } catch { /* 非 JSON 报错体 */ }
  const text = (body?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
  const rec = {
    target_tokens: targetTokens, prompt_chars: prompt.length, http: r.status, seconds: Math.round((Date.now() - t0) / 1000),
    accepted: r.ok && !body?.error,
    // 端点实数 = 三个 usage 字段之和(未缓存 + 读缓存 + 写缓存);只取 input_tokens 会漏掉缓存命中的部分
    input_tokens: body?.usage ? (body.usage.input_tokens ?? 0) + (body.usage.cache_read_input_tokens ?? 0) + (body.usage.cache_creation_input_tokens ?? 0) : null,
    cache_read_tokens: body?.usage?.cache_read_input_tokens ?? null,
    stop_reason: body?.stop_reason ?? null,
    secret_recalled: text.includes(SECRET),
    model_from_response: body?.model ?? null,
  };
  // 静默截断防线:端点回 200,但三项合计的输入量仍远小于发过去的量——这一发等于"超出窗口",不能算收下,
  // 也不能拿来校准字符/token 比(否则下一发的步长会被放大几十倍;缓存口径修好前 glm_flash 就这样把请求吹到 50MB 被 413)
  rec.silently_truncated = rec.accepted && rec.input_tokens != null && rec.input_tokens < expectedTokens * 0.8;
  if (rec.silently_truncated) rec.expected_tokens = expectedTokens;
  if (!rec.accepted) rec.error = (body?.error?.message ?? raw).slice(0, 300);
  else if (!rec.secret_recalled) rec.answer_head = text.slice(0, 120);
  if (rec.accepted && rec.input_tokens && !rec.silently_truncated) charsPerToken = prompt.length / rec.input_tokens;
  console.log(JSON.stringify(rec));
  return rec;
};

const shots = [];
let lo = null, hi = null;   // lo=最后一次收下的记录,hi=第一次拒收的记录
for (let t = START; ; t = Math.min(t * 2, MAX)) {
  const rec = await call(t); shots.push(rec);
  if (rec.accepted && !rec.silently_truncated) lo = rec; else { hi = rec; break; }
  if (t >= MAX) break;
}
while (lo && hi && (hi.target_tokens - lo.target_tokens) / lo.target_tokens > PRECISION) {
  const mid = Math.floor((lo.target_tokens + hi.target_tokens) / 2);
  const rec = await call(mid); shots.push(rec);
  if (rec.accepted && !rec.silently_truncated) lo = rec; else hi = rec;
}

const entry = {
  service: SERVICE, model_from_response: [...new Set(shots.map(s => s.model_from_response).filter(Boolean))],
  date: new Date().toISOString().slice(0, 10),
  context_window_at_least: lo?.input_tokens ?? null,
  rejected_at_estimated: hi ? hi.target_tokens : null,
  rejected_error: hi?.error ?? null,
  over_window_behavior: !hi ? null : hi.silently_truncated ? `静默截断——回 200 不报错,端点实数只记 ${hi.input_tokens}(按字符估约 ${hi.expected_tokens})` : `报错拒收 HTTP ${hi.http}`,
  reading: !lo ? '起步规模就被拒收,调小 --start 重量'
    : hi ? `收下 ${lo.input_tokens} 输入 token,估算 ${hi.target_tokens} 时${hi.silently_truncated ? '被静默截断' : '被拒'}——窗口在两者之间`
    : `测程顶 ${MAX} 仍收下(端点实数 ${lo.input_tokens}),窗口至少这么大`,
  secret_recall: `${shots.filter(s => s.accepted && !s.silently_truncated && s.secret_recalled).length}/${shots.filter(s => s.accepted && !s.silently_truncated).length} 次完整收下的请求答对开头暗号`,
  shots,
};

let table = { endpoints: [] };
if (MERGE && existsSync(OUT)) table = yamlLoad(readFileSync(OUT, 'utf-8')) ?? { endpoints: [] };
table.说明 = '端点上下文窗口实测表(run-context-window.mjs)。context_window_at_least=最后一次收下的请求里端点自己数的 input_tokens;rejected_at_estimated=第一次被拒的请求按字符估算的输入规模;secret_recall=收下的请求里模型答对开头暗号的次数(收下却答不出=名义窗口够、实际读不到开头)';
table.endpoints = (table.endpoints ?? []).filter(e => e.service !== SERVICE).concat([entry]);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, yamlDump(table, { lineWidth: 200 }));
console.log(`\n══ ${SERVICE} ══\n${entry.reading}\n暗号: ${entry.secret_recall}\n表: ${OUT}`);
