#!/usr/bin/env node
// @v: anc-driver-codex-agent-roles, anc-driver-codex-inline-fallback, anc-driver-codex-rule-parity, anc-driver-codex-static-lint, anc-cli-json-io
// Codex carrier 静态纪律 + CC/Codex 稳定协议签名检查。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

// HOPJIT_CHECK_ROOT：判据回归测试注入替身仓库根（与 check-scripts-syntax 同款可测性通道）
const projectRoot = process.env['HOPJIT_CHECK_ROOT'] ?? resolve(import.meta.dirname, '..');
const codexRoot = join(projectRoot, 'driver', 'codex');

const requiredCodexFiles = [
  'SKILL.md',
  'hop-skill.md',   // $hop 日常命令（2026-08-26 作者定"补"——单文件,装点 ~/.codex/skills/hop/SKILL.md〔2026-08-27 看齐批用户级〕）
  'agents/segment-driver.md',
  'references/discovery.md',
  'references/execution-rules.md',
  // parallel-worker.md / batch-fanout.md 已随旧并行通道退役（P0.5 统一模型，2026-08-11）——
  // 复用模式 parallel 暂串行，P2 渐进协议实装时按新形态重建 worker 文件并回登本清单。
];

const ccBundle = [
  'driver/hopspec-skill.md',
  'driver/references/driver-subagent.md',
  'driver/references/step-execution-rules.md',
];

const codexBundle = [
  'driver/codex/SKILL.md',
  'driver/codex/agents/segment-driver.md',
  'driver/codex/references/execution-rules.md',
];

const protocolTokens = [
  'step_ready',
  'tool_request',
  '--tool-result',
  'paused',
  // parallel_ready 已随旧通道退役（P0.5）；统一模型渐进协议（§U8）两形态：
  'dispatch_ready',
  'drain_wait',
  'reap_and_fetch_next',
  'adaptive_needed',
  'completed',
  'status: completed',
  'status: failed',
  'failed',
  'reason',
  'check',
  'act',
  'commit',
  'output_path',
  'submit_and_fetch_next',
  '--instance',
  'SCHEMA_MISMATCH',
  '--failure',
];

const errors = [];
const machineCommands = [
  'run',
  'submit_and_fetch_next',
  'join_parallel',
  'fanout-plan',
  'fanout-next',
  'resume',
  'status',
  'list',
  'validate',
  'debug_step',
];

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walkFiles(path));
    else files.push(path);
  }
  return files;
}

function readProjectFile(path) {
  const absolute = join(projectRoot, path);
  if (!existsSync(absolute)) {
    errors.push(`missing file: ${path}`);
    return '';
  }
  return readFileSync(absolute, 'utf-8');
}

for (const path of requiredCodexFiles) {
  readProjectFile(join('driver/codex', path));
}

// Codex 把 SKILL.md 与 agents/*.md 注册为可调用能力（工具/子代理），其 description 取自
// YAML frontmatter——缺失或为空则 provider 直接 400 invalid_params（2026-08-08 真机实撞：
// agents/*.md 只有 @trace 无 frontmatter，$coffee-week 起跳即 "tools[0].description:
// empty string"）。references/*.md 仅被文内引用、不注册，不查。// @a: anc-driver-codex-static-lint
for (const path of requiredCodexFiles.filter(p => p.endsWith('SKILL.md') || p === 'hop-skill.md' || p.startsWith('agents/'))) {
  const content = readProjectFile(join('driver/codex', path));
  if (!content) continue;
  if (!content.startsWith('---\n')) {
    errors.push(`driver/codex/${path} must start with YAML frontmatter (---)`);
    continue;
  }
  const fmEnd = content.indexOf('\n---', 4);
  const fm = fmEnd > 0 ? content.slice(4, fmEnd) : '';
  for (const key of ['name', 'description']) {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    if (!m || !m[1].trim()) errors.push(`driver/codex/${path} frontmatter missing non-empty '${key}'`);
  }
}

if (existsSync(codexRoot)) {
  const forbidden = [
    { label: 'AskUserQuestion', pattern: /AskUserQuestion/ },
    { label: 'task-notification', pattern: /task-notification/ },
    { label: 'node <CLI>', pattern: /node\s+<CLI>/ },
    { label: 'driver/codex/AGENTS.md', pattern: /driver\/codex\/AGENTS\.md/ },
  ];

  for (const file of walkFiles(codexRoot).filter(path => path.endsWith('.md'))) {
    const content = readFileSync(file, 'utf-8');
    for (const item of forbidden) {
      if (item.pattern.test(content)) {
        errors.push(`${relative(projectRoot, file)} contains forbidden primitive: ${item.label}`);
      }
    }
  }
}

const mainSkill = readProjectFile('driver/codex/SKILL.md');
if (/^### (reason|check|act|commit)$/m.test(mainSkill)) {
  errors.push('driver/codex/SKILL.md embeds segment execution rules');
}
if (!mainSkill.includes('INLINE_FALLBACK')) {
  errors.push('driver/codex/SKILL.md missing INLINE_FALLBACK capability gate');
}
// @v: anc-driver-codex-capability-gate, anc-driver-codex-first-heartbeat
// 2026-08-08 直发重构：nonce probe 废除——正向断言直发+心跳协议 token，反向禁探针词汇回流。
for (const token of [
  '任务即握手',
  'fork_turns="none"',
  'SUBAGENT_READY',
  'INLINE_FALLBACK',
  'AGENT_PROTOCOL_ERROR',
  'timeout_ms=300000',
  '零新实例',
  '不持久化、不跨运行复用',
  // 心跳判死即行动三 token（2026-08-14 flash 两轮超时实撞——弱模型空真推理失败卡死点,
  // 设计 ^anc-driver-codex-first-heartbeat"判死即行动"条款）：
  '禁止再 wait、禁止只查目录不行动',
  '天然满足',
  '没发 spawn 就 wait 是在等一个不存在的人',
]) {
  if (!mainSkill.includes(token)) {
    errors.push(`driver/codex/SKILL.md missing capability-gate token: ${token}`);
  }
}
// 探针协议已废——除决策依据行（"不派探针、不发 nonce"否定句）外不得再出现探针操作指令
if (/HOPSPEC_AGENT_READY:<nonce>|派生一个 probe agent|派 probe/.test(mainSkill)) {
  errors.push('driver/codex/SKILL.md still contains revoked nonce-probe protocol (2026-08-08 直发重构后应移除)');
}
for (const token of [
  '<PROJECT_ROOT>/.hopstate',
  '.hopspec/` 仅存 `recent-dirs.json',
  '绝不能作为 state-dir',
]) {
  if (!mainSkill.includes(token)) {
    errors.push(`driver/codex/SKILL.md missing state namespace token: ${token}`);
  }
}

const codexExecutionRules = readProjectFile('driver/codex/references/execution-rules.md');
if (!codexExecutionRules.includes('DRIVER_PROTOCOL_ERROR')) {
  errors.push('driver/codex/references/execution-rules.md missing DRIVER_PROTOCOL_ERROR guard');
}

// 续接交接契约（^anc-exec-reuse-subagent-driver,2026-08-13 真机实撞 cc:adaptive 超时）：
// 介入点响应只发一次不可重取——主 agent 起续接 subagent 必须随交接传未消费响应。
// CC 载体原语 <PENDING>（skill 传+模板收+缺件 DRIVER_PROTOCOL_ERROR 兜底）;Codex 同契约
// 已由交接信封 current_response 承载（下方 token 核）。
for (const [path, tokens] of [
  ['driver/hopspec-skill.md', ['<PENDING>', 'stale']],
  ['driver/references/driver-subagent.md', ['<PENDING>', 'DRIVER_PROTOCOL_ERROR']],
  ['driver/codex/SKILL.md', ['current_response']],
]) {
  const content = readProjectFile(path);
  for (const token of tokens) {
    if (!content.includes(token)) {
      errors.push(`${path} missing continuation-handoff token: ${token}`);
    }
  }
}

function checkBundle(name, paths) {
  const content = paths.map(readProjectFile).join('\n');
  for (const token of protocolTokens) {
    if (!content.includes(token)) {
      errors.push(`${name} carrier bundle missing protocol token: ${token}`);
    }
  }
}

checkBundle('CC', ccBundle);
checkBundle('Codex', codexBundle);

// @v: anc-cli-json-io
// CLI 缺省输出 YAML；driver 是机器消费方，命令模板必须在子命令前显式带全局 --json。
for (const path of [...ccBundle, ...codexBundle, 'driver/references/discovery.md', 'driver/codex/references/discovery.md']) {
  const content = readProjectFile(path);
  for (const command of machineCommands) {
    const missingJson = new RegExp(`(?:node\\s+)?<CLI>\\s+(?!\\-\\-json\\b)${command.replace('-', '\\-')}\\b`);
    if (missingJson.test(content)) {
      errors.push(`${path} machine command '${command}' missing global --json`);
    }
  }
}

// last_sync 一致性（2026-08-14 手工纪律三撞升守卫）。// @a: anc-driver-lint-last-sync
// driver/ 带 @trace last_sync 头的文件,实改必须同步刷——①已提交面:最后 commit 日期>last_sync 日期红;
// ②未提交面:git 脏区且 last_sync≠今天红。git 不可用→显式跳过明说（^anc-meta-guard-trust 禁静默装绿）。
// 日粒度比对（同日多改不折腾时分）。判据回归经 HOPJIT_CHECK_ROOT 替身仓库时 git 面自然跳过（替身非 git 仓库）。
{
  const traceFiles = [];
  const collect = (dir) => {
    for (const e of readdirSync(join(projectRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) collect(rel);
      else if (e.name.endsWith('.md')) traceFiles.push(rel);
    }
  };
  collect('driver');
  if (existsSync(join(projectRoot, 'skills'))) collect('skills');   // 构建器 skill 2026-08-15 自 driver/ 迁出,last_sync 纪律随文件走不随目录丢 // @a: anc-driver-lint-last-sync
  let gitOk = true;
  let dirtySet = new Set();
  try {
    const dirty = execSync('git status --porcelain -- driver/', { cwd: projectRoot, encoding: 'utf-8' });
    dirtySet = new Set(dirty.split('\n').filter(Boolean).map(l => l.slice(3).trim()));
  } catch { gitOk = false; }
  if (!gitOk) {
    console.log('⏭  last_sync 一致性检查跳过（git 不可用——非 git 仓库或替身根）,不装绿。');
  } else {
    // 本地日期(非UTC):last_sync 按 CLAUDE.md 约定用本地时间写入,UTC 判'今天'在本地 0-8 点
    // 跨日窗口必假红(0830 实撞:本地 8-30 凌晨 2 点=UTC 8-29,刚刷的 last_sync 被判'≠今天')。
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (const rel of traceFiles) {
      const content = readFileSync(join(projectRoot, rel), 'utf-8');
      const m = /last_sync:\s*(\d{4}-\d{2}-\d{2})/.exec(content);
      if (!m) continue;   // 无 last_sync 头的文件不在本检查面
      const declared = m[1];
      if (dirtySet.has(rel)) {
        if (declared !== today) errors.push(`${rel} 在 git 脏区（正在改）但 last_sync=${declared}≠今天——改 driver 文件必须同步刷 last_sync（三撞升守卫,^anc-driver-lint-last-sync）`);
        continue;
      }
      let lastCommit = '';
      try {
        lastCommit = execSync(`git log -1 --format=%ad --date=short -- "${rel}"`, { cwd: projectRoot, encoding: 'utf-8' }).trim();
      } catch { continue; }
      if (lastCommit && lastCommit > declared) {
        errors.push(`${rel} 最后 commit ${lastCommit} > last_sync ${declared}——实改未刷 last_sync（三撞升守卫,^anc-driver-lint-last-sync）`);
      }
    }
  }
}

// /hop 六动作两载体 parity（^anc-exec-reuse-distill,2026-08-28 提纯批）。// @v: anc-exec-reuse-distill
// distill 提纯与查现成流程是一对机制（生产/消费半边）——任一载体缺 token 即动作面漂移。
for (const path of ['driver/hop-skill.md', 'driver/codex/hop-skill.md']) {
  const content = readProjectFile(path);
  for (const token of ['distill', '提纯', 'hop_tasks/specs/', '查现成流程', '总结', '改动阶段进 worktree']) {   // 末 token=act/commit 分界兑现(^anc-exec-reuse-worktree-act) // @a: anc-exec-reuse-worktree-act
    if (!content.includes(token)) {
      errors.push(`${path} missing /hop distill token: ${token}（六动作 parity,^anc-exec-reuse-distill）`);
    }
  }
}

// /hop 恒复用模式红线两载体在场（hopissues/0071 实撞:driver 觉得任务大调 start_run 走 MCP
// 独立模式,撞 1M 上下文墙烧 6.2M tokens 零产出——红线条款是修复本体,丢句即防线消失）。
for (const path of ['driver/hop-skill.md', 'driver/codex/hop-skill.md']) {
  const content = readProjectFile(path);
  if (!content.includes('mcp__hopjit__start_run')) {
    errors.push(`${path} missing /hop reuse-mode red-line token: mcp__hopjit__start_run（禁调 start_run 红线条款丢失,hopissues/0071）`);
  }
}

if (errors.length > 0) {
  console.error('Driver carrier lint failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Driver carrier lint passed.');
