#!/usr/bin/env node
// standalone 外部工具真机全链：tool_servers 节(真百炼 WebSearch) + 真 LLM reason → 完整 run 到 completed。
// 2026-08-13 扩：激活分级路由全新面——系统 routing_rules 分档 + spec Config 段(-分项体例) + 软偏好落级(ghost service→warn→系统档)。
// 覆盖面 = mcp-binding-smoke(零 LLM 绑定层) 之上唯一缺的真机环：LLM 与外部工具在同一 run 内协同。
// LLM 交互 1 次（reason 步）——守卫链 5c 例行档（≤5）。
// 用法：DASHSCOPE_API_KEY=… DEEPSEEK_API_KEY=… node scripts/standalone-tools-live-e2e.mjs
// @v: anc-exec-mcp-binding, anc-exec-tool-composite —— 真机判据（LLM×外部工具协同;5a 判卷者在链上）
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

for (const k of ['DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY']) {
  if (!process.env[k]) { console.error(`❌ 需要 ${k}`); process.exit(2); }
}

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const { HopjitMcpCore } = await import(join(repo, 'dist', 'mcp-server.js'));

const dir = mkdtempSync(join(tmpdir(), 'standalone-tools-live-'));
const specPath = join(dir, 'search-brief.md');
writeFileSync(specPath, [
  '# Spec: 检索一条并总结',
  'Id: search-brief',
  'Goal: 用外部检索工具查一个主题，由模型压成一句话简报',
  '',
  'Config:',
  '- models:',
  '  - reason: ghostsvc/super-model',   // 软偏好:环境无 ghostsvc → warn 落级到系统 routing_rules
  '',
  '## Inputs',
  '- topic: text  # 检索主题',
  '',
  '## Outputs',
  '- brief: text  # 一句话简报',
  '',
  '## Steps',
  '1. [act] 检索主题',
  '  - ← topic',
  '  + → pages: yaml  # 检索结果页列表',
  '  > 纯工具调用：外部 web_search（百炼 WebSearch,经 hoptools.yaml 白名单）',
  '  > ```hop_python',
  '  > found = web_search(query: topic)',
  '  > pages = found["pages"]',
  '  > ```',
  '2. [reason] 压成简报',
  '  - ← topic, pages',
  '  + → brief: text  # 一句话简报',
  '  > 从检索结果提炼一句话（50 字内）说明 topic 是什么。只依据 pages 内容，不外推。',
  '3. [exit] 交付',
].join('\n'));

const core = new HopjitMcpCore({
  providers: [{
    service_id: 'deepseek', protocol: 'anthropic',
    base_url: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat',   // deepseek 官方别名恒指最新——真机脚本用真实可用型号,文档样例的教学型号名不适用
    api_key_env: 'DEEPSEEK_API_KEY',
  }],
  // 分级路由真机激活面（2026-08-13 新语义:系统层分档+spec Config 段-分项+软偏好落级——
  // spec 偏好 ghostsvc 缺席 → warn → 落到这里的 reason 档）
  routing_rules: [{ step_type: 'reason', model: 'deepseek/deepseek-chat' }],
  tool_servers: (await import('js-yaml')).load((await import('node:fs')).readFileSync(join(repo, 'examples', 'hoptools-bailian.yaml'), 'utf-8')).tool_servers,
});

console.log('▶ startRun（真百炼 WebSearch + 真 deepseek reason）…');
const t0 = performance.now();
const started = await core.startRun(specPath, { topic: 'HopSpec 规范语言' }, join(dir, '.hopstate'));
if (started.error) { console.error('❌ startRun 拒绝:', JSON.stringify(started.error)); process.exit(1); }

let st = {};
for (let i = 0; i < 240; i++) {   // 至多 ~120s（真 LLM+真检索）
  await new Promise(r => setTimeout(r, 500));
  st = await core.runStatus(started.run_id);
  if (st.status === 'completed' || st.status === 'failed') break;
}
const secs = ((performance.now() - t0) / 1000).toFixed(1);

let failed = 0;
function check(label, ok, detail) {
  if (ok) console.log(`✅ ${label}`);
  else { failed++; console.error(`❌ ${label}${detail ? ': ' + detail : ''}`); }
}
check(`run 终态 completed（${secs}s）`, st.status === 'completed', `实际 ${st.status}: ${JSON.stringify(st).slice(0, 400)}`);
const brief = st.outputs?.brief;
check('brief 产出非空文本（LLM 消费了工具结果）', typeof brief === 'string' && brief.trim().length > 0, JSON.stringify(brief)?.slice(0, 200));
if (typeof brief === 'string') console.log('   brief =', brief.slice(0, 120));

// 落盘核验：独立模式工具在进程内直接执行,审计记录走 HopLog（tool: 字段,anc-obs-audit）——
// state.json 的 tool_journal 是复用模式重放通道,本路径不写它。
try {
  const { execSync } = await import('node:child_process');
  const hoplog = execSync(`grep -rl "web_search" ${JSON.stringify(join(dir, '.hoplog'))}`, { encoding: 'utf-8' }).trim();
  check('HopLog 记了 web_search 工具审计（tool: 字段）', hoplog.length > 0);
  // 软偏好落级真机核证（2026-08-13 新语义）：spec 偏好 ghostsvc 缺席 → warn 留痕且 run 照常 completed
  const logText = execSync(`cat ${JSON.stringify(hoplog.split('\n')[0])}`, { encoding: 'utf-8' });
  check('软偏好落级 warn 在轨（ghostsvc 缺席→落系统分档,run 未受阻）', logText.includes('ghostsvc') && logText.includes('落下一级'));
} catch (e) {
  check('HopLog 含 web_search 记录', false, e.message?.slice(0, 200));
}

console.log(failed === 0 ? '═══ standalone 外部工具真机全链通过 ═══' : `═══ ${failed} 项失败 ═══`);
process.exit(failed === 0 ? 0 : 1);
