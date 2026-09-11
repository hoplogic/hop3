#!/usr/bin/env node
// standalone 大输入内联真机核证（BUG-H ^anc-exec-llm-inline-context / 守卫 ^anc-guard-mock-blindspot）
// @a: anc-guard-mock-blindspot
// @v: anc-exec-llm-inline-context, anc-guard-mock-blindspot
// mock 盲区反向义务的真机格：mock LLM 不消费 prompt 内容,指针/真值不辨——本脚本用真 LLM 核
// "standalone × 超阈大输入"这一格（BUG-H 实撞时全测试面零覆盖的组合）。
// 断言三件：①终态 completed 且 verdict 引用了材料中的哨兵事实（LLM 真读到材料——编造无从得知）;
// ②HopLog 的 llm tokens_used 与材料量级相称（input_tokens 哨兵——BUG-H 时 48KB 材料只 583 tokens）;
// ③.hoplog/prompt 面零 $file 字样。
// 用法：DEEPSEEK_API_KEY=… node scripts/standalone-biginput-live-e2e.mjs   （1 次 LLM 交互,例行档）
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const { HopjitMcpCore } = await import(join(repo, 'dist', 'mcp-server.js'));

if (!process.env.DEEPSEEK_API_KEY) { console.error('exit 2: DEEPSEEK_API_KEY 未设置'); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), 'standalone-bigin-'));
// 大材料：>4KB 触 deflate 阈；哨兵事实埋中段（编造者无从得知的具体值）。
// 每轮掺随机 nonce 破 provider 前缀缓存（真机实撞:确定性填充第二轮起整段命中 DeepSeek 缓存,
// anthropic 兼容端点 input_tokens 只报 cache-miss=60,量级哨兵误红——哨兵依赖"本轮真发送",
// 缓存命中时 tokens 不反映材料体量;哨兵回读断言不受影响,它才是消费真凭据）。
const { randomBytes } = await import('node:crypto');
const nonce = randomBytes(6).toString('hex');
const SENTINEL = 'QK7-颐和园分馆-第43排';
const filler = Array.from({ length: 260 }, (_, i) => `第${i}段[${nonce}]：这是填充材料内容,用于把体积推过 deflate 阈值。`).join('\n');
const material = `${filler}\n【关键信息】藏书位置代号：${SENTINEL}\n${filler}`;
console.log(`材料体积: ${Buffer.byteLength(material)} 字节（阈值 4096）`);

const specPath = join(dir, 'bigin.md');
writeFileSync(specPath, [
  '# Spec: 大材料关键信息提取',
  'Id: bigin-probe',
  'Goal: 从大体积材料中找出藏书位置代号',
  '',
  '## Inputs',
  '- material: text  # 大材料全文',
  '',
  '## Outputs',
  '- verdict: line  # 藏书位置代号原文',
  '',
  '## Steps',
  '1. [reason] 找代号',
  '  - ← material',
  '  + → verdict: line  # 代号原文',
  '  > 在材料中找到"藏书位置代号"，把代号原样输出（只输出代号本身）。',
].join('\n'));

const core = new HopjitMcpCore({
  providers: [{ service_id: 'deepseek', protocol: 'anthropic', base_url: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', api_key_env: 'DEEPSEEK_API_KEY' }],
});

console.log('▶ startRun（真 deepseek,大输入内联核证）…');
const started = await core.startRun(specPath, { material }, join(dir, '.hopstate'));
if (started.error) { console.error('❌ startRun 拒绝:', JSON.stringify(started.error)); process.exit(1); }
let st = {};
for (let i = 0; i < 240; i++) { await new Promise(r => setTimeout(r, 500)); st = await core.runStatus(started.run_id); if (st.status !== 'running') break; }

let failed = 0;
const check = (label, ok, detail) => { if (ok) console.log(`✅ ${label}`); else { failed++; console.error(`❌ ${label}${detail ? ': ' + detail : ''}`); } };

check('run 终态 completed', st.status === 'completed', JSON.stringify(st).slice(0, 300));
const verdict = String(st.outputs?.verdict ?? '');
check(`verdict 含哨兵事实 ${SENTINEL}（LLM 真读到材料,编造无从得知）`, verdict.includes(SENTINEL), verdict.slice(0, 120));

// HopLog 侧双核: tokens 量级 + prompt 面零指针
try {
  const mainYaml = execSync(`find ${JSON.stringify(join(dir, '.hoplog'))} -name main.yaml`, { encoding: 'utf-8' }).trim().split('\n')[0];
  const log = readFileSync(mainYaml, 'utf-8');
  // HopLog 真格式=tokens_used: <input+output 总和>（info 级流控字段,dispatcher 记）——
  // 首版正则 /input:/ 抓错行得 36;二版直取 tokens_used 又撞 provider 前缀缓存（确定性材料
  // 第二轮整段命中 DeepSeek 缓存,input_tokens 只报 cache-miss=60）。三版=缓存感知双通道：
  // tokens 量级相称直接过;tokens 小则查 HopLog debug 级 llm.prompt 或 inputs 的字节体量
  //（盘面证据不受缓存影响）;两通道皆不可得才跳过明说。哨兵回读断言始终是消费真凭据主判。
  const toks = [...log.matchAll(/tokens_used:\s*(\d+)/g)].map(x => Number(x[1]));
  const maxTok = toks.length ? Math.max(...toks) : 0;
  if (maxTok > 1500) {
    check(`tokens_used(${maxTok}) 与材料量级相称`, true);
  } else if (log.length > 30000) {
    // main.yaml 本身携带 inputs（info 级记录步骤输入）——材料内联则日志体量必然万级
    check(`tokens_used(${maxTok}) 疑似缓存命中,改核 HopLog 体量(${log.length}B>30000——材料真在 prompt 面)`, true);
  } else {
    check(`tokens_used(${maxTok}) 与 HopLog 体量(${log.length}B) 双低——指针泄漏形态`, false);
  }
  check('HopLog prompt 面零 $file 字样', !log.includes('$file'));
} catch (e) { failed++; console.error('❌ HopLog 核验失败:', String(e).slice(0, 200)); }

console.log(failed === 0 ? '═══ standalone 大输入内联核证通过 ═══' : `═══ ${failed} 项失败 ═══`);
process.exit(failed === 0 ? 0 : 1);
