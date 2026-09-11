#!/usr/bin/env node
// standalone 一期真机验收（TODO ^todo-codex-standalone-fallback 完成判据 1 + key 安全扫描）。
// 用户终端跑：node scripts/verify-standalone-live.mjs [--config <path>]
// 依赖：~/.hopjit/config.yaml（或 --config / HOPJIT_CONFIG）+ 对应 api_key_env 已设。
import { loadStandaloneConfig, HopjitMcpCore } from '../dist/mcp-server.js';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dump as yamlDump } from 'js-yaml';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfgArg = process.argv.indexOf('--config');
const cfgPath = cfgArg > 0 ? process.argv[cfgArg + 1] : process.env.HOPJIT_CONFIG;

const config = loadStandaloneConfig(cfgPath);
const keyVals = config.providers.map(p => process.env[p.api_key_env]).filter(Boolean);
// 启动自检:打出实际生效的后端配对(key 只露尾4),宿主 ANTHROPIC_* 在场时说明其不参与——
// 让"用错 key/错后端"在启动时可见,不用等到第一次 LLM 调用才 401
console.log(yamlDump({
  凭证自检: config.providers.map(p => ({
    service: p.service_id, base_url: p.base_url,
    api_key_env: p.api_key_env,
    key尾4: (process.env[p.api_key_env] ?? '').slice(-4) || '(未设!)',
  })),
  宿主环境: {
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ? `在场(尾${process.env.ANTHROPIC_AUTH_TOKEN.slice(-4)},standalone 不使用——显式配对优先)` : '(未设)',
  },
}).trim());
const core = new HopjitMcpCore(config);

async function waitTerminal(runId, onPaused) {
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const st = core.runStatus(runId);
    if (st.status === 'paused' && onPaused) { await onPaused(st); continue; }
    if (st.status === 'completed' || st.status === 'failed') return st;
  }
  throw new Error('TIMEOUT');
}

function scanKeyLeak(dir) {   // key 不落盘扫描：.hopstate/.hoplog 全文件不得含任何 key 值
  const hits = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (statSync(p).size < 10_000_000) {
        const text = readFileSync(p, 'utf-8');
        for (const k of keyVals) if (k && text.includes(k)) hits.push(p);
      }
    }
  };
  try { walk(dir); } catch { /* 目录不存在跳过 */ }
  return hits;
}

// ① coffee-week → ask 采默认 → completed
{
  const dir = mkdtempSync(join(tmpdir(), 'sa-live-cw-'));
  const stateDir = join(dir, '.hopstate');
  const r = await core.startRun(join(ROOT, 'examples/coffee-week.md'),
    { daily_sales: [3200, 2800, 3600, 4100, 3900, 5200, 4800], weekly_target: 26000 }, stateDir);
  if (!r.run_id) { console.error('❌ coffee-week start 失败:\n' + yamlDump(r)); process.exit(1); }
  const st = await waitTerminal(r.run_id, async (s) => {
    console.log(`  paused@${s.paused.step_id}(${s.paused.pause_reason}) → 注入 26000`);
    core.resumeRun(r.run_id, s.paused.step_id, { value: 26000 });
  });
  if (st.status !== 'completed' || !st.outputs?.weekly_report) {
    console.error('❌ coffee-week 未 completed:\n' + yamlDump({ status: st.status, failure: st.failure ?? null })); process.exit(1);
  }
  const leaks = scanKeyLeak(dir);
  if (leaks.length) { console.error('❌ key 落盘泄漏:', leaks); process.exit(1); }
  console.log('✅ coffee-week: paused(ask)→resume→completed, key 零落盘。终态:');
  console.log('```yaml\n' + yamlDump({ status: 'completed', outputs: st.outputs }, { lineWidth: -1 }) + '```');
}

// ② e2e-paused（confirm require_human）→ paused → approve → completed（HITL confirm 闭环）
{
  const dir = mkdtempSync(join(tmpdir(), 'sa-live-cf-'));
  const r = await core.startRun(join(ROOT, 'examples/e2e-failure/e2e-paused.md'),
    { daily_sales: [3200, 2800, 3600, 4100, 3900, 5200, 4800] }, join(dir, '.hopstate'));
  if (!r.run_id) { console.error('❌ e2e-paused start 失败:\n' + yamlDump(r)); process.exit(1); }
  const st = await waitTerminal(r.run_id, async (s) => {
    console.log(`  paused@${s.paused.step_id}(${s.paused.pause_reason}) → approve`);
    core.resumeRun(r.run_id, s.paused.step_id, { value: 'approve' });
  });
  if (st.status !== 'completed' || st.outputs?.published !== true) {
    console.error('❌ e2e-paused 未 completed/published:\n' + yamlDump({ status: st.status, failure: st.failure ?? null, outputs: st.outputs ?? null })); process.exit(1);
  }
  const leaks = scanKeyLeak(dir);
  if (leaks.length) { console.error('❌ key 落盘泄漏:', leaks); process.exit(1); }
  console.log('✅ e2e-paused: paused(confirm require_human)→approve→completed, key 零落盘。终态:');
  console.log('```yaml\n' + yamlDump({ status: 'completed', outputs: st.outputs }, { lineWidth: -1 }) + '```');
}
console.log('═══ standalone 一期真机验收全部通过 ═══');
process.exit(0);
