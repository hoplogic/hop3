#!/usr/bin/env node
// 多 run 并发真机冒烟（run 隔离不变量,ARCHITECTURE ^anc-run-isolation——2026-08-14 实撞形态:
// 多 run 并发崩 server）：真 hopjit-mcp stdio 子进程,同 server 并发两 start_run（真 LLM）,
// 断言:两 run 各自到达终态/server 进程全程存活/凭证零泄进程 env/stderr 无漏网异常。
// 用法：DEEPSEEK_API_KEY=… node scripts/multi-run-smoke.mjs
// @v: anc-run-isolation —— 真机判据（单进程多 run 生存性,vitest 崩溃回归的真进程对应物）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('❌ 需要 DEEPSEEK_API_KEY');
  process.exit(2);
}
const ROOT = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'multi-run-'));
// 极小 reason spec ×2（真 LLM 一步,分钟内完）
for (const [name, topic] of [['a.md', '写一句关于茶的话'], ['b.md', '写一句关于咖啡的话']]) {
  writeFileSync(join(dir, name), `# S
Id: s-${name[0]}
Goal: ${topic}
## Outputs
- line_out: text  # 一句话
## Steps
1. [reason] 想
  + → line_out: text  # 一句话
  > ${topic}，一句即可
2. [exit]
`);
}
writeFileSync(join(dir, 'config.yaml'), JSON.stringify({
  providers: [{ service_id: 'deepseek', protocol: 'anthropic', base_url: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', api_key_env: 'DEEPSEEK_API_KEY' }],
}));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, 'dist', 'mcp-server.js')],
  env: { ...process.env, HOPJIT_CONFIG: join(dir, 'config.yaml') },
  stderr: 'pipe',
});
const client = new Client({ name: 'multi-run-smoke', version: '0' });
let stderrBuf = '';
await client.connect(transport);
transport.stderr?.on('data', d => { stderrBuf += String(d); });

const fails = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${label}${ok || !detail ? '' : `：${detail}`}`);
  if (!ok) fails.push(label);
};

const t0 = Date.now();
// 并发两 start_run（同 server 进程——实撞形态）:
const [ra, rb] = await Promise.all([
  client.callTool({ name: 'start_run', arguments: { spec_path: join(dir, 'a.md'), state_dir: join(dir, '.hs-a') } }),
  client.callTool({ name: 'start_run', arguments: { spec_path: join(dir, 'b.md'), state_dir: join(dir, '.hs-b') } }),
]);
const runA = JSON.parse(ra.content[0].text).run_id;
const runB = JSON.parse(rb.content[0].text).run_id;
check('并发两 start_run 都受理', !!runA && !!runB && runA !== runB);

// 轮询到双终态（run_status 走同一 server——进程活着才答得上来）:
const final = { [runA]: '', [runB]: '' };
for (let i = 0; i < 120 && (!final[runA] || !final[runB]); i++) {
  await new Promise(r => setTimeout(r, 2000));
  for (const id of [runA, runB]) {
    if (final[id]) continue;
    const st = JSON.parse((await client.callTool({ name: 'run_status', arguments: { run_id: id } })).content[0].text);
    if (st.status === 'completed' || st.status === 'failed') final[id] = st.status;
  }
}
check(`run A 到达终态（${final[runA] || '超时未达'}, ${((Date.now()-t0)/1000).toFixed(0)}s）`, final[runA] === 'completed');
check(`run B 到达终态（${final[runB] || '超时未达'}）`, final[runB] === 'completed');

// 互不串台：各自 vars 是各自话题（读盘面）:
try {
  const { readdirSync } = await import('node:fs');
  const va = JSON.parse(readFileSync(join(dir, '.hs-a', readdirSync(join(dir, '.hs-a'))[0], 'vars.json'), 'utf-8'));
  const vb = JSON.parse(readFileSync(join(dir, '.hs-b', readdirSync(join(dir, '.hs-b'))[0], 'vars.json'), 'utf-8'));
  const ta = JSON.stringify(va), tb = JSON.stringify(vb);
  check('两 run 产出各归各盘面（状态目录隔离）', ta.length > 0 && tb.length > 0 && ta !== tb);
} catch (e) { check('盘面核验', false, e.message?.slice(0, 120)); }

// 漏网异常零触发（进程兜底的 stderr 标记不出现——出现=结构防线漏网）:
check('stderr 无 [run-isolation] 漏网标记', !stderrBuf.includes('[run-isolation]'), stderrBuf.slice(0, 200));

await client.close();
if (fails.length) { console.error(`═══ ${fails.length} 项失败 ═══`); process.exit(1); }
console.log('═══ 多 run 并发真机冒烟通过 ═══');
