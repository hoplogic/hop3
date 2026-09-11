#!/usr/bin/env node
// mcp 绑定真机冒烟：tool_servers 注册条目装配 → 真调 WebSearch/amap 各一发 → 断言 unwrap+shape 全链。
// 零 LLM 费用（只走 MCP 工具调用面）。用法：DASHSCOPE_API_KEY=… node scripts/mcp-binding-smoke.mjs
// @v: anc-exec-mcp-binding, anc-exec-tool-composite —— 真机判据（绑定层零 LLM;5a 判卷者在链上）
import { loadToolRegistry } from '../dist/tools-registry.js';
import { CompositeToolProvider } from '../dist/tools-composite.js';

const HOST = {
  workspace_dir: process.cwd(),
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'unused',
};

if (!process.env.DASHSCOPE_API_KEY) {
  console.error('❌ 需要 DASHSCOPE_API_KEY（百炼通用 key）');
  process.exit(2);
}
const registry = loadToolRegistry(new URL('../examples/hoptools-bailian.yaml', import.meta.url).pathname);
const warns = [];
const c = new CompositeToolProvider(HOST, { registry, warn: m => warns.push(m) });

let failed = 0;
async function check(label, name, args, assertFn) {
  const r = await c.execute(name, args);
  try {
    if (!r.success) throw new Error(String(r.result).slice(0, 300));
    assertFn(r.result);
    console.log(`✅ ${label}`);
  } catch (e) {
    failed++;
    console.error(`❌ ${label}: ${e.message}`);
  }
}

await check('WebSearch 经 tool_id 调用+unwrap+shape', 'web_search', { query: 'HopSpec 语言' },
  r => { if (!Array.isArray(r.pages)) throw new Error(`pages 非数组: ${JSON.stringify(r).slice(0, 120)}`); });
await check('amap maps_geo 全链', 'maps_geo', { address: '杭州西湖' },
  r => { if (!Array.isArray(r.results)) throw new Error(`results 非数组: ${JSON.stringify(r).slice(0, 120)}`); });

if (warns.length) console.log('warns:', warns);
await c.close();
console.log(failed === 0 ? '═══ 冒烟通过 ═══' : `═══ ${failed} 项失败 ═══`);
process.exit(failed === 0 ? 0 : 1);
