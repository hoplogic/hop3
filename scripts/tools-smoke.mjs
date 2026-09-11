#!/usr/bin/env node
// 工具三通道统一冒烟：内置组（in-process 硬装配）+ in-process 扩展模块（真隔离模块装载）
// + mcp（真百炼服务,凭证在场才跑——缺凭证跳过明说不装通过）。
// 改引擎后一条命令快验全部工具通道；零 LLM 费用。用法：npm run test:smoke:tools
// @v: anc-exec-tool-composite, anc-exec-inprocess-binding, anc-exec-mcp-binding —— 三通道冒烟判据（5a 判卷者在链上）
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const { CompositeToolProvider } = await import(join(repo, 'dist', 'tools-composite.js'));
const { loadToolRegistry } = await import(join(repo, 'dist', 'tools-registry.js'));

let failed = 0;
function check(label, ok, detail) {
  if (ok) console.log(`✅ ${label}`);
  else { failed++; console.error(`❌ ${label}${detail ? ': ' + detail : ''}`); }
}

const ws = realpathSync(mkdtempSync(join(tmpdir(), 'tools-smoke-')));   // macOS /var→/private/var symlink 归一
const HOST = {
  workspace_dir: ws,
  sandbox: { filesystem: { workspace_dir: ws, read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'unused',
};

// ── 通道①：内置组（构造器硬装配,零配置恒在）──
{
  const c = new CompositeToolProvider(HOST);
  const w = await c.execute('write', { path: 'probe.txt', content: 'hello' });
  const r = await c.execute('read', { path: 'probe.txt' });
  check('内置组: write→read 回读一致', w.success && r.success && r.result === 'hello', JSON.stringify({ w: w.result, r: r.result }).slice(0, 120));
  const denied = await c.execute('write', { path: '../escape.txt', content: 'x' });
  check('内置组: 越界写被沙箱拒', !denied.success);
}

// ── 通道②：in-process 扩展模块（真隔离模块 word-stats 装载全链）──
{
  const toolsYaml = join(ws, 'hoptools-inproc.yaml');
  writeFileSync(toolsYaml, [
    'tool_servers:',
    '  - name: word_stats_lib',
    '    binding:',
    '      kind: in-process',
    `      module: ${JSON.stringify(resolve(repo, 'examples/ext-tools/word-stats.mjs'))}`,
    '    tools:',
    '      - name: word_stats',
    '        requires_commit: false',
    '        input_schema:',
    '          type: object',
    '          properties: { text: { type: string } }',
    '          required: [text]',
    '        output_schema:',
    '          words: int',
    '          chars: int',
  ].join('\n'));
  const c = new CompositeToolProvider(HOST, { registry: loadToolRegistry(toolsYaml) });
  const r = await c.execute('word_stats', { text: 'a bb ccc' });
  check('in-process: 隔离模块装载+执行+HopSchema 校验裁剪', r.success && JSON.stringify(r.result) === '{"words":3,"chars":8}', JSON.stringify(r.result).slice(0, 120));
  const rejected = await c.execute('word_stats', {});
  check('in-process: 发端校验拦必填缺失（未调用模块）', !rejected.success && String(rejected.result).includes('INPUT_SCHEMA_MISMATCH'));
  await c.close();
}

// ── 通道③：mcp（真百炼服务——凭证在场才跑,缺凭证跳过明说）──
if (process.env.DASHSCOPE_API_KEY) {
  const registry = loadToolRegistry(join(repo, 'examples', 'hoptools-bailian.yaml'));
  const c = new CompositeToolProvider(HOST, { registry });
  const r = await c.execute('web_search', { query: 'HopSpec' });
  check('mcp: 真百炼 WebSearch 经 tool_id 全链（unwrap+HopSchema）', r.success && Array.isArray(r.result?.pages), JSON.stringify(r.result).slice(0, 120));
  check('mcp: audit 元信息在场（server 归属+耗时）', r.audit?.server === 'bailian_search' && typeof r.audit?.duration_ms === 'number');
  await c.close();
} else {
  console.log('⏭  mcp 通道跳过（DASHSCOPE_API_KEY 未设置——真机面缺凭证不装通过）');
}

console.log(failed === 0 ? '═══ 工具三通道冒烟通过 ═══' : `═══ ${failed} 项失败 ═══`);
process.exit(failed === 0 ? 0 : 1);
