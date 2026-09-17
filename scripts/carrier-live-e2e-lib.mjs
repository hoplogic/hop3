#!/usr/bin/env node
// @a: anc-driver-live-e2e, anc-driver-live-e2e-isolation, anc-driver-live-e2e-events

import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { extractHopLogStepKeys } from '../dist/hoplog.js';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..');
export const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
// 场景级超时覆盖：复杂流程场景 LLM 交互 6-8 次,弱模型驱动 8 分钟不够（2026-08-09 实撞:
// alpha 批已完、beta 批 running 时被全局超时掐断——纯时长问题非协议问题）
export const SCENARIO_TIMEOUT_MS = {
  'cc:anchor-audit': 40 * 60 * 1000,   // 2026-08-13 20→40min：审计对象是固定 fixture(28K)+固定 spec(34步),业务量不随库涨——昨日 pass 全程 56 块/13.3min 已贴 20min 线(余量仅 33%),今日同业务 53 块/18.6min 被掐(每块慢 40%,API 时延波动——'speed:standard';输出量正常 1.8MB/最大单行 17KB,$file 卸载在位)。预算须罩住时延波动,非业务变重
};
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const HOP_WRITE_RE = /\bhopjit\b.*\b(run|submit_and_fetch_next|join_parallel|resume)\b|dist\/cli\.js.*\b(run|submit_and_fetch_next|join_parallel|resume)\b/;
const HOP_RUN_RE = /\bhopjit\b.*\brun\b|dist\/cli\.js.*\brun\b/;
const SECRET_ENV_CANDIDATES = {
  'cc:delegated': ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'cc:repair': ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'cc:adaptive': ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'cc:uncaught': ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'cc:parallel-partial': ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'cc:paused': ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'cc:call-fail': ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'cc:call': ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'cc:anchor-audit': ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'cc:parallel': ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'codex:parallel': ['ZENMUX_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'],
  'codex:delegated': ['ZENMUX_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'],
  'codex:flash': ['DEEPSEEK_API_KEY', 'ZENMUX_API_KEY', 'OPENAI_API_KEY'],
  'codex:demo': ['ZENMUX_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'],
  'codex:standalone': ['DEEPSEEK_API_KEY', 'ZENMUX_API_KEY'],
  'codex:standalone-parallel': ['DEEPSEEK_API_KEY', 'ZENMUX_API_KEY'],
  'cc:standalone': ['DEEPSEEK_API_KEY', 'ZENMUX_API_KEY'],
};

export class LiveE2EError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'LiveE2EError';
    this.exitCode = exitCode;
  }
}

export function parseJsonLines(text, label = 'JSONL') {
  const events = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new LiveE2EError(`${label} 第 ${index + 1} 行不是合法 JSON`, 1);
    }
  }
  return events;
}

export function redactSecrets(text, secrets) {
  let redacted = String(text);
  for (const secret of secrets.filter(value => typeof value === 'string' && value.length > 0)) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function visit(value, callback, context = {}) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback, context);
    return;
  }
  if (!value || typeof value !== 'object') return;
  callback(value, context);
  for (const nested of Object.values(value)) {
    visit(nested, callback, context);
  }
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item && typeof item === 'object' && item.type === 'text')
    .map(item => String(item.text ?? ''))
    .join('\n');
}

function actorFromClaudeNode(node, root) {
  if (node.parent_tool_use_id || root.parent_tool_use_id || root.isSidechain || root.agentId) return 'subagent';
  return 'main';
}

export function normalizeClaudeEvents(events) {
  const normalized = [{ type: 'carrier_start', actor: 'main' }];
  let finalText = '';
  const mainTexts = [];   // 全部主消息——终态 YAML 断言依据（不依赖"最后一条"，见 assertFailureScenario 注）

  for (const root of events) {
    visit(root, node => {
      const hookName = node.hook_name ?? node.hookName ?? node.name;
      if (node.type === 'hook_event' && (hookName === 'SubagentStart' || hookName === 'SubagentStop')) {
        normalized.push({
          type: hookName === 'SubagentStart' ? 'subagent_start' : 'subagent_stop',
          actor: 'subagent',
          role: String(node.agent_type ?? node.agentType ?? 'segment'),
          id: String(node.agent_id ?? node.agentId ?? ''),
        });
      }

      if (node.type === 'tool_use' && (node.name === 'Agent' || node.name === 'Task')) {
        const prompt = String(node.input?.prompt ?? node.input?.description ?? '');
        normalized.push({
          type: 'subagent_start',
          actor: 'subagent',
          role: classifyAgentRole(prompt),
          id: String(node.id ?? ''),
        });
      }

      if (node.type === 'tool_use' && node.name === 'Bash') {
        normalized.push({
          type: 'command',
          actor: actorFromClaudeNode(node, root),
          command: String(node.input?.command ?? ''),
        });
      }

      // CC 的 MCP 工具调用:tool_use 名形如 mcp__<server>__<tool>——归一为 mcp_tool
      //（与 codex mcp_tool_call 同构,standalone 薄协议正判据两载体同一断言）
      if (node.type === 'tool_use' && typeof node.name === 'string' && node.name.startsWith('mcp__')) {
        const parts = node.name.split('__');
        normalized.push({
          type: 'mcp_tool',
          actor: actorFromClaudeNode(node, root),
          server: String(parts[1] ?? ''),
          tool: parts.slice(2).join('__'),
        });
      }

      if (node.type === 'assistant' || node.role === 'assistant') {
        const text = textFromContent(node.message?.content ?? node.content);
        if (text) {
          const actor = actorFromClaudeNode(node, root);
          normalized.push({ type: 'message', actor, text });
          if (actor === 'main') { finalText = text; mainTexts.push(text); }
        }
      }

      if (node.type === 'result' && typeof node.result === 'string') {
        finalText = node.result;
        mainTexts.push(node.result);
        normalized.push({ type: 'message', actor: 'main', text: node.result });
      }
    }, root);
  }

  normalized.push({ type: 'carrier_stop', actor: 'main' });
  return { normalized: dedupeEvents(normalized), finalText, mainText: mainTexts.join('\n\n') };
}

function codexActor(node, rootThreadId) {
  const threadId = node.thread_id ?? node.sender_thread_id ?? node.item?.thread_id ?? node.item?.sender_thread_id;
  return threadId && rootThreadId && threadId !== rootThreadId ? 'subagent' : 'main';
}

export function normalizeCodexEvents(events) {
  const normalized = [{ type: 'carrier_start', actor: 'main' }];
  const rootThreadId = events.find(event => event.type === 'thread.started')?.thread_id ?? '';
  let finalText = '';
  const mainTexts = [];

  for (const event of events) {
    const item = event.item ?? {};
    if (item.type === 'collab_tool_call') {
      const tool = String(item.tool ?? '');
      const prompt = String(item.prompt ?? '');
      if (['spawn_agent', 'start_agent', 'delegate'].includes(tool)) {
        normalized.push({
          type: 'subagent_start',
          actor: 'subagent',
          role: classifyAgentRole(prompt),
          id: String(item.receiver_thread_ids?.[0] ?? ''),
        });
      } else if (['close_agent', 'finish_agent'].includes(tool)) {
        normalized.push({
          type: 'subagent_stop',
          actor: 'subagent',
          role: classifyAgentRole(prompt),
          id: String(item.receiver_thread_ids?.[0] ?? ''),
        });
      } else if (tool === 'wait') {
        normalized.push({
          type: 'subagent_wait',
          actor: 'main',
          role: 'segment',
          id: String(item.receiver_thread_ids?.[0] ?? ''),
        });
      }
    }

    if (item.type === 'command_execution') {
      normalized.push({
        type: 'command',
        actor: codexActor(item, rootThreadId),
        command: String(item.command ?? ''),
      });
    }

    if (item.type === 'mcp_tool_call') {
      normalized.push({
        type: 'mcp_tool',
        actor: codexActor(item, rootThreadId),
        server: String(item.server ?? ''),
        tool: String(item.tool ?? ''),
      });
    }

    if (item.type === 'agent_message') {
      const text = String(item.text ?? '');
      const actor = codexActor(item, rootThreadId);
      normalized.push({ type: 'message', actor, text });
      if (actor === 'main') { finalText = text; mainTexts.push(text); }
    }
  }

  normalized.push({ type: 'carrier_stop', actor: 'main' });
  return { normalized: dedupeEvents(normalized), finalText, mainText: mainTexts.join('\n\n') };
}

function classifyAgentRole(prompt) {
  // probe 分类是遗留容错（nonce 握手 2026-08-08 已废）——新协议不再产生 probe agent，
  // 保留识别只为旧轨迹归一不误判 segment；formalStarts 过滤依赖此分类。
  if (/HOPSPEC_AGENT_READY|probe/i.test(prompt)) return 'probe';
  if (/segment.driver|执行段|HopSpec driver/i.test(prompt)) return 'segment';
  if (/parallel.worker|并行/i.test(prompt)) return 'parallel';
  return 'segment';
}

function dedupeEvents(events) {
  const seen = new Set();
  return events.filter(event => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ===== codex 载体环境自包含（todo/0061,^anc-driver-live-e2e-isolation codex 子条）=====
// 宿主 ~/.codex/config.toml 的插件/外部 MCP/桌面通知是宿主环境噪声——未登录的外连插件
// （slack）曾把 codex:delegated/codex:demo 双双拖死超时（每次起动连 mcp.slack.com 撞
// AuthRequired,rmcp worker 反复 fatal,2026-09-01 发版前实撞）。e2e 起 codex 用临时
// CODEX_HOME:宿主配置按段过滤复制,载体环境自包含,宿主装什么插件与 e2e 结论无关。

/** 宿主 codex config.toml 按段过滤（纯函数——测试面）：剔除 [plugins.*]/[marketplaces.*]/
 * [mcp_servers.*] 三族段与顶层 notify 数组;其余（model/model_providers/sandbox_mode/
 * projects 信任等）原样保留。过滤法优于白名单重建——保留面按段透传,不逐键枚举漏项。 */
export function filterCodexConfigForIsolation(text) {
  const lines = text.split('\n');
  const out = [];
  let skippingSection = false;
  let skippingNotify = false;
  let inAnySection = false;   // 段内状态位——notify 只滤顶层（review C2-1:保留段内同名键按'按段原样透传'承诺保留）
  for (const line of lines) {
    const trimmed = line.trim();
    if (skippingNotify) {
      if (trimmed.endsWith(']')) skippingNotify = false;   // notify 数组收尾行
      continue;
    }
    if (trimmed.startsWith('[')) {
      inAnySection = true;
      // 段头行:判是否进入剔除族（含带引号键形态 [plugins."x@y"] 与 [[数组表]]——后者理论形态顺手封死）
      skippingSection = /^\[\[?(plugins|marketplaces|mcp_servers)[.\]]/.test(trimmed);
      if (skippingSection) continue;
      out.push(line);
      continue;
    }
    if (skippingSection) continue;   // 剔除段体行（含注释与空行到下一段头）
    if (!inAnySection && /^notify\s*=\s*\[/.test(trimmed)) {
      // 顶层 notify 数组（e2e 每 turn 弹桌面通知同为噪声）——单行闭合直接跳,多行进跨行跳
      if (!trimmed.endsWith(']') || trimmed === 'notify = [') skippingNotify = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** 构造临时 CODEX_HOME：过滤后的 config.toml + 宿主 profile 文件族（*.config.toml,
 * flash 档 -p 消费）+ auth.json（若在——codex 自身登录态,保守带上）。返回目录路径,
 * 调用方 finally 负责整目录删除（宿主真身全程零接触）。 */
export function buildIsolatedCodexHome(hostCodexHome = join(homedir(), '.codex')) {
  const home = mkdtempSync(join(tmpdir(), 'hopjit-e2e-codex-home-'));
  const hostConfig = join(hostCodexHome, 'config.toml');
  if (existsSync(hostConfig)) {
    writeFileSync(join(home, 'config.toml'), filterCodexConfigForIsolation(readFileSync(hostConfig, 'utf-8')));
  }
  if (existsSync(hostCodexHome)) {
    for (const name of readdirSync(hostCodexHome)) {
      if (name !== 'config.toml' && name.endsWith('.config.toml')) {
        copyFileSync(join(hostCodexHome, name), join(home, name));
      }
    }
  }
  const auth = join(hostCodexHome, 'auth.json');
  if (existsSync(auth)) copyFileSync(auth, join(home, 'auth.json'));
  return home;
}

export function selectCredential(scenario, env, explicitName) {
  const candidates = explicitName
    ? [explicitName]
    : SECRET_ENV_CANDIDATES[scenario] ?? [];
  const name = candidates.find(candidate => typeof env[candidate] === 'string' && env[candidate].length > 0);
  if (!name) {
    const expected = candidates.length > 0 ? candidates.join(' / ') : '由 --credential-env 指定的变量';
    throw new LiveE2EError(`缺少 live E2E 凭证环境变量：${expected}`, 2);
  }
  return { name, value: env[name] };
}

export function collectSecrets(env, selected) {
  const names = new Set([
    selected.name,
    ...Object.values(SECRET_ENV_CANDIDATES).flat(),
  ]);
  return [...names]
    .map(name => env[name])
    .filter(value => typeof value === 'string' && value.length >= 8);
}

export function validateScenarioPreconditions(scenario, options = {}) {
  const supported = new Set([
    'cc:delegated', 'codex:delegated', 'codex:flash', 'codex:demo', 'codex:standalone', 'cc:standalone',
    // 失败路径场景组（2026-08-09 作者定 12345；见 design ^anc-driver-live-e2e-scenarios）
    'cc:repair', 'cc:adaptive', 'cc:uncaught', 'cc:parallel-partial', 'cc:paused', 'cc:call-fail', 'cc:call',
    // 复杂流程场景（2026-08-09 作者定——LLM 交互深核主载体，见 design 场景表）
    'cc:anchor-audit',
    // 轻量并行冒烟（2026-08-11 作者定入 e2e:all——统一模型渐进派发最小闭环，分钟级；
    // 重的 anchor-audit 单独 test:e2e:audit 不进批量）
    'cc:parallel', 'codex:parallel',
    // 独立模式真机并行（2026-08-11 作者定补缺：standalone 薄协议 × 统一模型并行叠加）
    'codex:standalone-parallel',
  ]);
  if (!supported.has(scenario)) {
    throw new LiveE2EError(`未知 live E2E 场景：${scenario}`, 2);
  }
  if (scenario === 'codex:standalone') {
    // standalone 场景需 hopjit MCP server 可注册 + StandaloneConfig（e2e 生成临时 config,凭证经 env）
    // 见 design ^anc-driver-codex-standalone-dispatch
  }
  // codex:flash（2026-08-08 作者定命题反转）：场景身份=弱模型长程命题，非降级路径验证。
  // deepseek-v4-flash 驱动完整业务；模式自适应（spawn 成/败皆合法），业务终态必须通过。
  if (scenario.startsWith('cc:') && options.launcher && !['claude', 'claude-ds'].includes(options.launcher)) {
    throw new LiveE2EError(`不支持的 CC launcher：${options.launcher}`, 2);
  }
  const executable = scenario.startsWith('cc:') ? (options.launcher ?? 'claude') : 'codex';
  return { executable };
}

export async function runChildProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const append = (current, chunk) => {
    const next = current + chunk.toString('utf-8');
    if (Buffer.byteLength(next) > MAX_CAPTURE_BYTES) {
      terminateProcessTree(child);
      throw new LiveE2EError('carrier 输出超过 32 MiB，已终止', 1);
    }
    return next;
  };

  child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });

  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child);
    setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 1000).unref();
  }, timeoutMs);

  const result = await new Promise((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => resolvePromise({
      code: code ?? 1,
      signal,
      stdout,
      stderr,
      timedOut,
    }));
  });
  clearTimeout(timer);
  return result;
}

function terminateProcessTree(child, signal = 'SIGTERM') {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Process may already have exited.
  }
}

export function createIsolatedWorkspace(carrier) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), `hopjit-${carrier}-live-e2e-`)));
  mkdirSync(join(workspace, 'examples'), { recursive: true });
  cpSync(join(PROJECT_ROOT, 'examples', 'coffee-week.md'), join(workspace, 'examples', 'coffee-week.md'));
  cpSync(join(PROJECT_ROOT, 'examples', 'coffee-sales.json'), join(workspace, 'examples', 'coffee-sales.json'));
  cpSync(join(PROJECT_ROOT, 'examples', 'e2e-parallel-smoke.md'), join(workspace, 'examples', 'e2e-parallel-smoke.md'));
  cpSync(join(PROJECT_ROOT, 'examples', 'e2e-failure'), join(workspace, 'examples', 'e2e-failure'), { recursive: true });
  // cc:call 正向场景:教学样例对(父调子,同目录寻址)
  cpSync(join(PROJECT_ROOT, 'examples', 'syntax', 'call-parent-summarize.md'), join(workspace, 'examples', 'syntax', 'call-parent-summarize.md'));
  cpSync(join(PROJECT_ROOT, 'examples', 'syntax', 'call-child-normalize.md'), join(workspace, 'examples', 'syntax', 'call-child-normalize.md'));
  // cc:anchor-audit 场景素材直接取 scripts/audit/ 活工具（2026-08-09 作者纠正：语法演进时
  // 工具和样例必须跟着变，"冻结拷贝"是错误解读——测试判据靠断言锁不变量（产物位置/批文件名/
  // 缺陷召回/hitl 数量,由 spec 结构决定）,不靠冻结文件防漂移;工具改动 e2e 红了正是该红）。
  mkdirSync(join(workspace, 'audit-kit'), { recursive: true });
  for (const f of ['anchor-audit.md', 'anchor-audit-knowledge.md', 'scan.py', 'cross_compare.py']) {
    cpSync(join(PROJECT_ROOT, 'scripts', 'audit', f), join(workspace, 'audit-kit', f));
  }
  // doc-ref 按执行 cwd（workspace 根）相对解析 [[anchor-audit-knowledge#…]]——知识文档须在根可达
  cpSync(join(PROJECT_ROOT, 'scripts', 'audit', 'anchor-audit-knowledge.md'), join(workspace, 'anchor-audit-knowledge.md'));
  cpSync(join(PROJECT_ROOT, 'examples', 'e2e-audit-fixture'), join(workspace, 'fixture'), {
    recursive: true,
    filter: src => !src.includes('.anchor-audit'),   // 本机冒烟产物不带入
  });

  mkdirSync(join(workspace, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(workspace, 'node_modules', '@hoplogic'), { recursive: true });
  symlinkSync(PROJECT_ROOT, join(workspace, 'node_modules', '@hoplogic', 'hopjit'), 'dir');
  symlinkSync(join(PROJECT_ROOT, 'dist', 'cli.js'), join(workspace, 'node_modules', '.bin', 'hopjit'), 'file');
  return workspace;
}

export function cleanupWorkspace(workspace) {
  if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
}

/** 失败现场归档：exit-1 路径在 cleanup 前把 .hopstate/.hoplog/完整 stdio/归一事件
 * 落 .e2e-evidence/failures/<scenario>-<ts>/，逐文件 key 脱敏（脱敏即写、含 secret 原文的
 * 二进制/超限文件跳过不落）。焚毁前不归档=根因证据全失（2026-08-08 codex:inline 实撞）。
 * 见 [[carrier-live-e2e#^anc-driver-live-e2e-isolation]]。// @a: anc-driver-live-e2e-isolation */
export function archiveFailureEvidence({ workspace, scenario, result, normalized, secrets, evidenceRoot }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(evidenceRoot, 'failures', `${scenario.replace(/:/g, '-')}-${stamp}`);
  mkdirSync(dest, { recursive: true });

  const redact = (text) => {
    let out = String(text);
    for (const secret of secrets) {
      if (secret) out = out.split(secret).join('[REDACTED]');
    }
    return out;
  };

  // 执行状态与轨迹：整树拷贝后逐文件脱敏改写（非文本/超 4MB 跳过——宁缺毋漏原文 key）
  for (const sub of ['.hopstate', '.hoplog']) {
    const src = join(workspace, sub);
    if (!existsSync(src)) continue;
    cpSync(src, join(dest, sub), { recursive: true });
    walkWorkspace(join(dest, sub), path => {
      try {
        const stat = lstatSync(path);
        if (!stat.isFile()) return;
        if (stat.size > 4 * 1024 * 1024) { rmSync(path); return; }
        writeFileSync(path, redact(readFileSync(path, 'utf-8')));
      } catch {
        try { rmSync(path); } catch { /* 脱敏不了就不留 */ }
      }
    });
  }

  // 完整 stdio（不截断——诊断 tail 的 8000 字符窗口曾滚掉弃实例根因）+ 归一事件
  if (result) {
    writeFileSync(join(dest, 'stdout.log'), redact(result.stdout ?? ''));
    writeFileSync(join(dest, 'stderr.log'), redact(result.stderr ?? ''));
  }
  writeFileSync(join(dest, 'events.json'), redact(JSON.stringify(normalized ?? [], null, 2)));
  return dest;
}

// 通过场景轨迹归档（2026-08-09 作者质疑"都没留档谁核对的"——runner 焚毁前核过但不可事后复核,
// 审计链断最后一环）。焚毁 workspace 前把 .hoplog+state.json 脱敏归档到 passes/,每场景保留最近
// PASS_ARCHIVE_KEEP 份;凭证 JSON 的 evidence_archive 字段指向本归档。见 design 通过场景轨迹归档节。
const PASS_ARCHIVE_KEEP = 3;
export function archivePassEvidence({ workspace, scenario, secrets, evidenceRoot }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = scenario.replace(/:/g, '-');
  const passesRoot = join(evidenceRoot, 'passes');
  const dest = join(passesRoot, `${slug}-${stamp}`);
  mkdirSync(dest, { recursive: true });

  const redact = (text) => {
    let out = String(text);
    for (const secret of secrets) {
      if (secret) out = out.split(secret).join('[REDACTED]');
    }
    return out;
  };
  for (const sub of ['.hopstate', '.hoplog']) {
    const src = join(workspace, sub);
    if (!existsSync(src)) continue;
    cpSync(src, join(dest, sub), { recursive: true });
    walkWorkspace(join(dest, sub), path => {
      try {
        const stat = lstatSync(path);
        if (!stat.isFile()) return;
        if (stat.size > 4 * 1024 * 1024) { rmSync(path); return; }
        writeFileSync(path, redact(readFileSync(path, 'utf-8')));
      } catch {
        try { rmSync(path); } catch { /* 脱敏不了就不留 */ }
      }
    });
  }
  // 滚动保留:同场景旧归档只留最近 PASS_ARCHIVE_KEEP 份。
  // 兄弟判定=slug 后紧跟时间戳（\d{4}-），不能裸 startsWith——cc-call 会把 cc-call-fail-* 也算兄弟,
  // 排序后 cc-call-2026…(数字<字母)排最前被当"最旧"删掉:刚归档即被自己删,凭证指向空目录
  //（2026-08-12 真机实撞:cc:call/cc:parallel 通过归档当场蒸发,review 抓出）。
  const siblingRe = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-`);
  const siblings = readdirSync(passesRoot)
    .filter(name => siblingRe.test(name))
    .sort();
  for (const old of siblings.slice(0, Math.max(0, siblings.length - PASS_ARCHIVE_KEEP))) {
    rmSync(join(passesRoot, old), { recursive: true, force: true });
  }
  return dest;
}

export function readWorkspaceText(workspace) {
  const chunks = [];
  walkWorkspace(workspace, path => {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return;
      chunks.push(`${path}\n${readFileSync(path, 'utf-8')}`);
    } catch {
      // Races during carrier shutdown are reported by process status instead.
    }
  });
  return chunks.join('\n');
}

function walkWorkspace(path, callback) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    callback(path);
    return;
  }
  for (const entry of readdirSync(path)) walkWorkspace(join(path, entry), callback);
}

export function assertNoSecretLeak(texts, secrets) {
  for (const [label, text] of Object.entries(texts)) {
    for (const secret of secrets) {
      if (secret && String(text).includes(secret)) {
        throw new LiveE2EError(`检测到凭证泄露：${label}`, 1);
      }
    }
  }
}

export function readTerminalEvidence(workspace) {
  const stateRoot = join(workspace, '.hopstate');
  if (!existsSync(stateRoot)) throw new LiveE2EError('carrier 未创建 .hopstate', 1);
  const instances = readdirSync(stateRoot)
    .map(name => join(stateRoot, name))
    .filter(path => lstatSync(path).isDirectory() && existsSync(join(path, 'state.json')));
  if (instances.length !== 1) {
    throw new LiveE2EError(`预期恰好 1 个 HopJIT instance，实际 ${instances.length}`, 1);
  }

  const instanceDir = instances[0];
  const state = JSON.parse(readFileSync(join(instanceDir, 'state.json'), 'utf-8'));
  const vars = JSON.parse(readFileSync(join(instanceDir, 'vars.json'), 'utf-8'));
  const states = Object.values(state.step_states ?? {});
  if (states.length === 0 || states.some(value => value !== 'done')) {
    throw new LiveE2EError('HopJIT instance 未完成全部步骤', 1);
  }
  const weeklyReport = String(vars.scopes?.root?.variables?.weekly_report ?? '');
  if (!weeklyReport.includes('周营业额：27600 元')) {
    throw new LiveE2EError('HopJIT 终态缺少预期周营业额 27600', 1);
  }

  // G11 核真过程（^anc-meta-layer-test e2e 原则）：终态之外必须核执行日志轨迹——
  // main.yaml 须在场且含全部步骤的 step 记录与终态记录（结果对但过程轨迹缺失=driver 绕过协议的信号）
  const hoplogRoot = join(workspace, '.hoplog');
  if (!existsSync(hoplogRoot)) throw new LiveE2EError('carrier 未产生 .hoplog（HopLog 轨迹缺失，无法核真过程）', 1);
  const runDirs = readdirSync(hoplogRoot).filter(name => lstatSync(join(hoplogRoot, name)).isDirectory());
  if (runDirs.length === 0) throw new LiveE2EError('.hoplog 下无 run 目录', 1);
  const mainYamls = runDirs
    .map(name => join(hoplogRoot, name, 'main.yaml'))
    .filter(pathname => existsSync(pathname));
  if (mainYamls.length === 0) throw new LiveE2EError('.hoplog 无 main.yaml——执行过程无轨迹', 1);
  const yamlTexts = mainYamls.map(pathname => readFileSync(pathname, 'utf-8'));
  const loggedStepIds = new Set(yamlTexts.flatMap(text =>
    extractHopLogStepKeys(text).map(key => key.split('#', 1)[0])));
  for (const stepId of Object.keys(state.step_states ?? {})) {
    if (!loggedStepIds.has(stepId)) {
      throw new LiveE2EError(`HopLog 缺步骤 ${stepId} 的过程记录——state 已 done 而轨迹缺失`, 1);
    }
  }
  // 深核（2026-08-09 作者两问"log核对了么"补齐——块键在场≠过程真）：
  // ①run 终态行入轨；②LLM 交互步骤的产物入轨——coffee-week 步骤 2 是 reason（verdict/advice）、
  // 3.2 是 check（report_ok），它们是 driver LLM 真跑的，outputs 块是"LLM 交互发生且结果入轨"的
  // 唯一产物侧证据（块键只证明 start 过，done 未入轨也有块键）。
  const allText = yamlTexts.join('\n');
  if (!/^status: completed$/m.test(allText)) {
    throw new LiveE2EError('HopLog 缺 run 终态行 status: completed——执行未走到 close', 1);
  }
  for (const marker of ['verdict:', 'report_ok:']) {
    if (!allText.includes(marker)) {
      throw new LiveE2EError(`HopLog 缺 LLM 步骤产物 ${marker}——reason/check 交互结果未入轨（结果对但 LLM 过程不可核）`, 1);
    }
  }
  // ask 介入点强制确认（2026-08-09 参数确认入 spec）：hitl 决策块必须入轨——引擎强制的
  // 确认真发生且可审计（demo 曾靠包装文字劝 LLM 问,遵循度波动:今天问明天不问）
  if (!allText.includes('hitl:')) {
    throw new LiveE2EError('HopLog 缺 hitl 决策块——spec 首步 ask 确认未走引擎介入点', 1);
  }
  return { instanceId: basename(instanceDir), weeklyReport };
}

// ===== 失败路径场景证据核验（2026-08-09 作者定 12345；design ^anc-driver-live-e2e-scenarios）=====
// 与 readTerminalEvidence（快乐路径专用：全 done+周报断言）分开——失败场景的正确终态各不相同。
function readSoleInstance(workspace) {
  const stateRoot = join(workspace, '.hopstate');
  if (!existsSync(stateRoot)) throw new LiveE2EError('carrier 未创建 .hopstate', 1);
  const instances = readdirSync(stateRoot)
    .map(name => join(stateRoot, name))
    .filter(path => lstatSync(path).isDirectory() && existsSync(join(path, 'state.json')));
  if (instances.length !== 1) {
    throw new LiveE2EError(`预期恰好 1 个 HopJIT instance，实际 ${instances.length}`, 1);
  }
  const dir = instances[0];
  return {
    dir,
    state: JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')),
    vars: JSON.parse(readFileSync(join(dir, 'vars.json'), 'utf-8')),
  };
}

function rootVars(vars) {
  return vars.scopes?.root?.variables ?? {};
}

// G11 核真过程（失败场景版）：读 workspace 全部 .hoplog run 的 main.yaml——终态对但轨迹缺失
// = driver 绕协议信号（2026-08-09 作者指正：只看 state/vars 即绿违反守卫链,尤其 LLM 交互步骤）。
function readHopLogText(workspace) {
  const hoplogRoot = join(workspace, '.hoplog');
  if (!existsSync(hoplogRoot)) throw new LiveE2EError('carrier 未产生 .hoplog（HopLog 轨迹缺失，无法核真过程）', 1);
  const runDirs = readdirSync(hoplogRoot).filter(name => lstatSync(join(hoplogRoot, name)).isDirectory());
  const texts = runDirs
    .map(name => join(hoplogRoot, name, 'main.yaml'))
    .filter(pathname => existsSync(pathname))
    .map(pathname => readFileSync(pathname, 'utf-8'));
  if (texts.length === 0) throw new LiveE2EError('.hoplog 无 main.yaml——执行过程无轨迹', 1);
  return { text: texts.join('\n---\n'), stepKeys: new Set(texts.flatMap(t => extractHopLogStepKeys(t))) };
}

// @v: anc-exec-retry-adaptive, anc-exec-none-propagation, anc-exec-parallel-inflight, anc-obs-hoplog —— 失败路径账面+轨迹形状（5a 断言在链）
function assertFailureScenario(scenario, { normalized, finalText, mainText, workspace, offline = false }) {
  // 终态 YAML 断言看全部主消息（mainText），非"最后一条"（finalText）——2026-08-10 实撞：
  // parallel-partial 主 agent 先报 completed YAML，后到的 task-notification 补话覆盖
  // finalText 导致误红。语义断言（该说过什么）与顺序断言（最后说什么）分开。
  const terminalText = mainText ?? finalText;
  const commands = normalized.filter(event => event.type === 'command');
  const { dir, state, vars } = readSoleInstance(workspace);
  const rv = rootVars(vars);

  if (scenario === 'cc:repair') {
    // 修复回路：终态 completed + 周报含复核区块 + state 有过失败/重试的账
    if (!offline && !terminalText.includes('status: completed')) throw new LiveE2EError('repair 场景应修复后 completed', 1);
    const report = String(rv.weekly_report ?? '');
    if (!report.includes('数据复核')) throw new LiveE2EError('repair 周报缺"数据复核"区块——反馈流未流转', 1);
    const retryHistory = state.retry_history ?? {};
    if (Object.keys(retryHistory).length === 0) throw new LiveE2EError('repair 场景 retry_history 为空——首跑未按设计失败（或重试未走引擎）', 1);
    // G11 过程核验：check 失败入轨（LLM 判定真发生）+ 轮次键证明重试真实二次交互
    const log = readHopLogText(workspace);
    if (!log.text.includes('CHECK_FAILED')) throw new LiveE2EError('HopLog 无 CHECK_FAILED 失败块——check 判定未入轨（结果对但过程不可核）', 1);
    if (!log.stepKeys.has('3.1#2') || !log.stepKeys.has('3.2#2')) {
      throw new LiveE2EError('HopLog 缺 3.1#2/3.2#2 轮次键——重试未真实重跑（一次跑就绿=反馈回路未演练）', 1);
    }
    if (!/^status: completed$/m.test(log.text)) throw new LiveE2EError('HopLog 尾部非 completed 终态', 1);
    return { exercised: 'repair' };
  }

  if (scenario === 'cc:adaptive') {
    // @v: anc-exec-retry-adaptive, anc-exec-adaptive-pipeline —— 修复升级阶梯第 3/4 档真机断言（5a 断言在链）
    // 断言锚协议轨迹不锚计划内容（replan 真 LLM 生成有概率性;design §4 cc:adaptive 行五判据）——
    // 断言锚协议轨迹不锚计划内容（replan 真 LLM 生成有概率性;design §4 cc:adaptive 行五判据）
    const log = readHopLogText(workspace);
    // ①replan_audit 审计块入轨（提报沉淀审计半边）
    if (!log.text.includes('replan_audit:')) throw new LiveE2EError('HopLog 无 replan_audit 块——adaptive 重规划未走引擎提报通道', 1);
    // ②候选文件落盘（提报沉淀文件半边——2026-08-13 缺口1交付的首个真机核证）。
    // offline 重放跳过：候选文件在 workspace/examples/（业务工作区面）,passes/ 归档只收
    // .hopstate/.hoplog——重放面=账面断言,缺席跳过不装通过（§7 契约;补 cc:adaptive 入重放
    // 清单时实撞:三份归档全红在此子断言）。
    if (!offline) {
      const candidateDir = join(workspace, 'examples', 'e2e-failure', 'e2e-adaptive.replan');
      if (!existsSync(join(candidateDir, '1.v1.md'))) throw new LiveE2EError('候选文件 e2e-adaptive.replan/1.v1.md 缺失——沉淀文件通道未走', 1);
      const candidate = readFileSync(join(candidateDir, '1.v1.md'), 'utf-8');
      if (!candidate.includes('%% @trace')) throw new LiveE2EError('候选文件缺 @trace 头——四元组绑定缺失', 1);
    }
    // ③新 children 真执行过：replan 后的步骤块键在轨（原 1.1 失败两轮后,replan 重置 children——
    //   新 1.1 的重启轮块键 1.1#N 或新增步骤键在场即证）
    const keys = [...log.stepKeys];
    const rerunKeys = keys.filter(k => k.startsWith('1.1') || k.startsWith('1.2'));
    if (rerunKeys.length < 3) throw new LiveE2EError(`replan 后新 children 执行轨迹不足（1.x 系块键 ${rerunKeys.length} 个,原两败+新执行应 ≥3）`, 1);
    // ④终态两收口都合法,轨迹必须完整
    const completed = /^status: completed$/m.test(log.text);
    const failed = /^status: failed$/m.test(log.text);
    if (!completed && !failed) throw new LiveE2EError('HopLog 尾部无终态——run 未走完', 1);
    // ⑤completed 时业务侧证据:total=9600
    if (completed) {
      const { vars } = readSoleInstance(workspace);
      const rv = rootVars(vars);
      if (Number(rv.total) !== 9600) throw new LiveE2EError(`completed 但 total≠9600（实际 ${rv.total}）——新计划算错`, 1);
    }
    return { exercised: completed ? 'adaptive-completed' : 'adaptive-exhausted' };
  }

  if (scenario === 'cc:uncaught') {
    // 未捕获失败=实例终止：failed 终态 + 步骤3 skipped + 步骤1产出保留 + reason 原文
    if (!offline && !terminalText.includes('status: failed')) throw new LiveE2EError('uncaught 场景 driver 应输出 failed YAML', 1);
    if (!offline && !terminalText.includes('计算异常')) throw new LiveE2EError('uncaught 失败 reason 未含"计算异常"原文——被转述或粉饰', 1);
    if (state.step_states?.['3'] !== 'skipped') throw new LiveE2EError(`uncaught 步骤3 应 skipped（实例终止后不执行），实际 ${state.step_states?.['3']}`, 1);
    if (typeof rv.label_len !== 'number') throw new LiveE2EError('uncaught 步骤1 产出 label_len 丢失——fail 不碰值空间被违反', 1);
    if (!state.terminal_failure) throw new LiveE2EError('uncaught 场景 state 缺 terminal_failure 标记', 1);
    // G11 过程核验：warn 留痕+failed 块在轨,步骤3 无任何块键（实例终止后未启动）,尾部 failed 终态
    const log = readHopLogText(workspace);
    if (!log.text.includes('warn:') || !log.text.includes('计算异常')) throw new LiveE2EError('HopLog 缺计算异常 warn 留痕', 1);
    if (!log.text.includes('fail_kind:')) throw new LiveE2EError('HopLog 缺 failed 块（fail_kind/reason）', 1);
    if ([...log.stepKeys].some(k => k.split('#')[0] === '3')) {
      throw new LiveE2EError('HopLog 出现步骤 3 块键——实例终止后步骤 3 仍被启动（函数级 fail 被违反）', 1);
    }
    if (!/^status: failed$/m.test(log.text)) throw new LiveE2EError('HopLog 尾部非 failed 终态', 1);
    return { exercised: 'uncaught' };
  }

  if (scenario === 'cc:parallel-partial') {
    // 部分失败=列表变短：completed + doubled_list 长度2 + summary=collected=2 + 1.2 failed 记账
    if (!offline && !terminalText.includes('status: completed')) throw new LiveE2EError('parallel-partial 消费步骤接受部分结果，应 completed', 1);
    const list = rv.doubled_list;
    if (!Array.isArray(list) || list.length !== 2) throw new LiveE2EError(`doubled_list 应为长度 2 的数组（失败 child 不贡献元素），实际 ${JSON.stringify(list)}`, 1);
    if (list.includes(null)) throw new LiveE2EError('doubled_list 含 null——失败槽填 None 的旧语义复活', 1);
    if (String(rv.summary ?? '') !== 'collected=2') throw new LiveE2EError(`summary 应为 collected=2，实际 ${rv.summary}`, 1);
    // 统一模型凭据位（2026-08-11 断言随语义迁移——旧通道失败记父 step_states,统一模型"派发即
    // 推进"父账恒 done,失败凭据=父 HopLog reap:failed 块+子实例目录自己的账,§U3 三契约①）：
    if (Object.entries(state.step_states ?? {}).some(([, s]) => s === 'failed')) {
      throw new LiveE2EError('父账出现 failed 步骤——部分失败不应拖垮主线（账面形态应 done+收割另账）', 1);
    }
    const log = readHopLogText(workspace);
    const reapFailed = (log.text.match(/reap:\n\s+child: (\S+)\n\s+status: failed/g) ?? []).length;
    const reapOk = (log.text.match(/reap:\n\s+child: (\S+)\n\s+status: completed/g) ?? []).length;
    if (reapFailed !== 1) throw new LiveE2EError(`父 HopLog 应恰有 1 个 reap:failed 块（失败收割凭据），实际 ${reapFailed}`, 1);
    if (reapOk !== 2) throw new LiveE2EError(`父 HopLog 应恰有 2 个 reap:completed 块，实际 ${reapOk}`, 1);
    // G11 过程核验（统一模型 §U8）：dispatch 块 ≥3（三迭代逐个派发入轨）；收割在账
    // （inflight 排空=收齐完成——state 无 inflight 残留即全收好）。
    const dispatchCount = (log.text.match(/dispatch:/g) ?? []).length;
    if (dispatchCount < 3) throw new LiveE2EError(`HopLog dispatch 块应 ≥3（渐进派发逐个入轨），实际 ${dispatchCount}`, 1);
    const inflightLeft = (state.inflight ?? []).filter(f => f.status === 'inflight');
    if (inflightLeft.length !== 0) throw new LiveE2EError(`收齐后账面仍有在飞 ${inflightLeft.length} 个——幻影`, 1);
    return { exercised: 'parallel-partial' };
  }

  if (scenario === 'cc:paused') {
    // paused 语义：无终态、confirm 步非 done、published 未落值、事件流无 --answer 提交
    if (terminalText.includes('status: completed')) throw new LiveE2EError('paused 场景不应有 completed 终态——confirm 被替答了', 1);
    if (commands.some(event => /--answer/.test(event.command))) {
      throw new LiveE2EError('paused 场景观测到 --answer 提交——driver 替答违规（require_human=true）', 1);
    }
    if (state.step_states?.['2'] === 'done') throw new LiveE2EError('confirm 步骤被标 done——paused 语义被绕过', 1);
    if (rv.published !== undefined) throw new LiveE2EError('published 变量已落值——confirm 被替答', 1);
    // G11 过程核验：confirm 起始块在轨（真走到介入点）+ 无 hitl 决策块（没人替答）+ 无 completed 终态
    const log = readHopLogText(workspace);
    if (!log.text.includes('type: confirm')) throw new LiveE2EError('HopLog 无 confirm 起始块——未走到介入点', 1);
    if (log.text.includes('hitl:')) throw new LiveE2EError('HopLog 出现 hitl 决策块——confirm 被替答（决策入轨了）', 1);
    if (/^status: completed$/m.test(log.text)) throw new LiveE2EError('HopLog 出现 completed 终态——paused 被绕过跑完', 1);
    return { exercised: 'paused' };
  }

  if (scenario === 'cc:call-fail') {
    // call 跨界失败：failed 终态 + reason 是 CalleeFailure 结构（内核原封） + 用了 --failure-child 而非 --failure 文本
    if (!offline && !terminalText.includes('status: failed')) throw new LiveE2EError('call-fail 场景应 failed 终态', 1);
    const reason = String(state.step_fail_reasons?.['1']?.reason ?? '');
    if (!reason.includes('CalleeFailure')) throw new LiveE2EError('父失败 reason 非 CalleeFailure 结构——未走 --failure-child 机器通道', 1);
    for (const kernel of ['e2e-call-child', '计算异常', 'fail_kind']) {
      if (!reason.includes(kernel)) throw new LiveE2EError(`CalleeFailure 缺内核要素 "${kernel}"——内核原封被违反`, 1);
    }
    if (commands.some(event => /--failure\s/.test(event.command) && !/--failure-child/.test(event.command))) {
      throw new LiveE2EError('观测到 --failure 自由文本提交——call 失败必须走 --failure-child', 1);
    }
    if (!existsSync(join(dir, 'calls'))) throw new LiveE2EError('父实例无 calls/ 子实例目录——call 未按协议驱动', 1);
    // G11 过程核验：跨界失败入轨——父 HopLog 的 failed 块 reason 含 CalleeFailure（非仅入 state）
    const log = readHopLogText(workspace);
    if (!log.text.includes('CalleeFailure')) throw new LiveE2EError('HopLog 无 CalleeFailure 失败块——跨界失败未入轨', 1);
    if (!/^status: failed$/m.test(log.text)) throw new LiveE2EError('HopLog 尾部非 failed 终态', 1);
    return { exercised: 'call-fail' };
  }

  throw new LiveE2EError(`未实现的失败场景断言：${scenario}`, 2);
}

// codex:standalone 断言（design ^anc-driver-codex-standalone-dispatch；TODO 完成判据 2-5）：
// spawn 禁用环境下 main 经 hopjit MCP 工具面执行——零 hopjit CLI 写命令、零 subagent、
// 终态同构 envelope（status: completed YAML 块）、HITL 经 resume_run 注入不替答。
// @v: anc-driver-codex-standalone-dispatch, anc-mcp-tools —— 薄协议判据（5a 断言在链）
function assertStandaloneScenario({ normalized, finalText, mainText, workspace, offline = false }) {
  const terminalText = mainText ?? finalText;  // CC 侧 task-notification 补话会覆盖 finalText（同 assertFailureScenario 注）
  const commands = normalized.filter(event => event.type === 'command');
  // 判据 2 核心：执行不走 hopjit CLI（run/submit 全在 server 进程内,shell 面零 hopjit 写命令）
  const cliWrites = commands.filter(event => HOP_WRITE_RE.test(event.command) || HOP_RUN_RE.test(event.command));
  if (cliWrites.length > 0) {
    throw new LiveE2EError(`standalone 场景观测到 hopjit CLI 写命令（应全走 MCP 工具面）: ${cliWrites[0].command.slice(0, 80)}`, 1);
  }
  // 看护 subagent 合法（2026-08-22 作者定标准范式 ^anc-driver-standalone-watch——后台看护
  // 轮询 run_status 到停点带回,主对话不 sleep 自锁;08-10 的'零 subagent'断言先于该范式,过时判据
  // live:core 实撞误杀:run completed 27600 全对仍判红）。仍拦的是执行外包形态:subagent 里
  // 出现 hopjit CLI 写命令已被上方判据 2 全局覆盖（events 含 subagent 内命令）,此处不重复判。
  // 判据 4：终态同构 envelope
  if (!offline && !terminalText.includes('status: completed')) {
    throw new LiveE2EError('standalone 场景终态非 completed YAML 块（三路径同构 envelope 要求）', 1);
  }
  if (!offline && !terminalText.includes('27600')) {
    throw new LiveE2EError('standalone 终态缺业务结果（周营业额 27600）', 1);
  }
  // 薄协议正判据：main 必须真经 hopjit MCP 工具面执行——start_run 至少一次可观测
  //（负判据"零 CLI 写命令"挡不住根本没跑的假绿;正负成对）。
  const mcpCalls = normalized.filter(event => event.type === 'mcp_tool' && event.server.includes('hopjit'));
  if (!offline && !mcpCalls.some(event => event.tool === 'start_run')) {
    throw new LiveE2EError('standalone 场景未观测到 hopjit MCP start_run 调用——薄协议未走通（工具面未注册成功或 main 未选定 standalone）', 1);
  }
  // 账面核验（review 补 2026-08-12:此前零盘面断言——offline 重放真空通过=装通过,真机侧也只看
  // 终态文本不读盘。coffee-week 同业务,快乐路径判据全适用:全步 done+周报 27600+HopLog 轨迹+hitl）
  readTerminalEvidence(workspace);
  // HITL 严格判据（resume_run 必现）待真机首跑校准——判据从真实轨迹校准,不闭门定形（同 anchor-audit 先例）。
  return { exercised: 'standalone' };
}

// cc:call 正向场景断言（2026-08-11 作者定"做"；design ^anc-driver-live-e2e-scenarios cc:call 行）：
// 父 completed + calls/ 子实例目录 + 回填值真实流转 + G11 双侧轨迹（父 call 步 done + 子实例完整 completed）。
// @v: anc-exec-call-auto-map, anc-obs-hoplog —— call 协议产物与回填（5a 断言在链）
function assertCallScenario({ normalized, finalText, mainText, workspace, offline = false }) {
  const terminalText = mainText ?? finalText;
  if (!offline && !terminalText.includes('status: completed')) throw new LiveE2EError('cc:call 场景应 completed 终态', 1);
  const { dir, vars } = readSoleInstance(workspace);
  const rv = rootVars(vars);
  // 回填值真实流转:clean_doc 来自子 spec 规整(无连续空行/无首尾空白),summary 非空
  const cleanDoc = String(rv.clean_doc ?? '');
  if (!cleanDoc) throw new LiveE2EError('父 vars 无 clean_doc——call 回填未发生', 1);
  if (/\n{3,}/.test(cleanDoc) || cleanDoc !== cleanDoc.trim()) {
    throw new LiveE2EError('clean_doc 未经子 spec 规整（仍含连续空行/首尾空白）——回填值非子产物', 1);
  }
  if (!String(rv.summary ?? '')) throw new LiveE2EError('父 vars 无 summary——回填值未被下游消费', 1);
  // call 协议产物:父实例 calls/ 子实例目录
  if (!existsSync(join(dir, 'calls'))) throw new LiveE2EError('父实例无 calls/ 子实例目录——call 未按协议驱动', 1);
  // G11 双侧过程核验:父 HopLog call 步 done 在轨;子实例自有完整 completed 轨迹
  const log = readHopLogText(workspace);
  if (!/^status: completed$/m.test(log.text)) throw new LiveE2EError('父 HopLog 尾部非 completed 终态', 1);
  const childDirs = readdirSync(join(dir, 'calls'));
  if (childDirs.length === 0) throw new LiveE2EError('calls/ 目录为空——子实例未落盘', 1);
  return { exercised: 'call' };
}

// cc:anchor-audit 断言（2026-08-09 作者定复杂流程场景；design ^anc-driver-live-e2e-scenarios 复杂流程节）。
// 判据全部从真实轨迹校准（.hoplog/anchor-audit-* 与 fixture 冒烟）,不闭门定形。
// @v: anc-meta-traceability —— 审计产物契约（anchor-audit spec 归属锚;5a 断言在链）
function assertAnchorAuditScenario({ normalized, finalText, mainText, workspace, offline = false }) {
  const terminalText = mainText ?? finalText;  // 同上,三撞成律归一
  if (!offline && !terminalText.includes('status: completed')) throw new LiveE2EError('anchor-audit 应 completed（report_only 只读路径）', 1);

  // —— 终态产物 + 缺陷召回（fixture 埋的确定性缺陷,审计必须抓到）——
  const auditDir = join(workspace, 'fixture', '.anchor-audit');
  if (!offline) {   // 产物类判据在 workspace/fixture 下,归档只收 .hopstate+.hoplog——离线不可核面
  for (const f of ['report.md', 'semantic_audit_summary.yaml', 'cross_compare_results.yaml']) {
    if (!existsSync(join(auditDir, f))) throw new LiveE2EError(`审计产物缺失: ${f}`, 1);
  }
  for (const mod of ['alpha', 'beta']) {
    if (!existsSync(join(auditDir, `batch_${mod}_results.yaml`))) {
      throw new LiveE2EError(`语义审计批产物缺失: batch_${mod}_results.yaml（按模块名断点标识）`, 1);
    }
  }
  const report = readFileSync(join(auditDir, 'report.md'), 'utf-8');
  for (const defect of ['anc-string-escape-control', 'anc-string-locale']) {
    if (!report.includes(defect)) throw new LiveE2EError(`report.md 未抓到埋设缺陷 ${defect}——审计召回失败`, 1);
  }
  }

  // —— HopLog 过程核验（G11）——
  const log = readHopLogText(workspace);
  if (!/^status: completed$/m.test(log.text)) throw new LiveE2EError('HopLog 尾部非 completed 终态', 1);
  // ask×2 决策入轨（hitl 审计块——代答也必须可审计）
  const hitlCount = (log.text.match(/hitl:/g) ?? []).length;
  if (hitlCount < 2) throw new LiveE2EError(`hitl 决策块应 ≥2（步骤2 approve + 步骤7 report_only），实际 ${hitlCount}`, 1);
  if (!log.text.includes('report_only')) throw new LiveE2EError('HopLog 无 report_only 决策——步骤7 未按嘱咐选只读', 1);
  // 渐进派发入轨（统一模型 §U8）:2 批各一条 dispatch 块
  const auditDispatch = (log.text.match(/dispatch:/g) ?? []).length;
  if (auditDispatch < 2) throw new LiveE2EError(`HopLog dispatch 块应 ≥2（alpha/beta 两批渐进派发），实际 ${auditDispatch}`, 1);

  // —— prompt 深核（LLM 交互第 2 层:引擎喂给 LLM 的东西对不对;debug 级 llm.prompt 已在轨）——
  // ① doc-ref 注入在场:主日志含 L2 知识条目（yaml 条目化形态,2026-08-24 层序重编:旧 L2d
  //   区块名与"命中标题"调试尾巴按受众公理剥除;在场性判据改核条目头。语义审计维度判据切片
  //   只注入 5.2.1.1——那是 worker 子实例的步骤,在 worker 子日志核,见下 ②′）
  //   历史存档兼容:2026-08-24 前的冻结凭证是旧 L2d 形态——判据两代任一命中即过（存档是
  //   冻结证据不可重录;新录凭证必然新形态）。
  const docRefNew = log.text.includes('来源:') && log.text.includes('作者指定的必读知识');
  const docRefOld = log.text.includes('L2d') && log.text.includes('命中标题：');
  if (!docRefNew && !docRefOld) {
    throw new LiveE2EError('prompt 无 doc-ref 知识条目（新形态:来源:/作者指定的必读知识;旧存档形态:L2d/命中标题）——doc-ref 注入缺失', 1);
  }
  // ② 并行批隔离:worker 子日志的 prompt 只含本模块 batch,不得出现另一模块名。
  //   worker 子日志在 .hoplog/<run>/parallel/<childId>/log/<childRun>/main.yaml
  const hoplogRoot = join(workspace, '.hoplog');
  const workerYamls = [];
  for (const run of readdirSync(hoplogRoot)) {
    const pDir = join(hoplogRoot, run, 'parallel');
    if (!existsSync(pDir)) continue;
    for (const child of readdirSync(pDir)) {
      const logDir = join(pDir, child, 'log');
      if (!existsSync(logDir)) continue;
      for (const childRun of readdirSync(logDir)) {
        const y = join(logDir, childRun, 'main.yaml');
        if (existsSync(y)) workerYamls.push(readFileSync(y, 'utf-8'));
      }
    }
  }
  if (workerYamls.length !== 2) throw new LiveE2EError(`并行 worker 子日志应恰 2 份（alpha/beta 各一批），实际 ${workerYamls.length}`, 1);
  const isolationPairs = [['module: alpha', 'module: beta'], ['module: beta', 'module: alpha']];
  const matched = new Set();
  for (const y of workerYamls) {
    const own = isolationPairs.findIndex(([mine, other]) => y.includes(mine) && !y.includes(other));
    if (own === -1) throw new LiveE2EError('worker 子日志批隔离违规——prompt 含另一模块的 batch 数据（或模块标识缺失）', 1);
    matched.add(own);
    // ②′ 语义审计判据切片必达 worker（5.2.1.1 的 doc-ref 注入在 worker 子实例,不在主日志——
    // 首绿路上实撞:断言查主日志恒红,切片实际各 worker 一处。判据锚随 yaml 条目化改形态:
    // 旧"命中标题：xxx"调试尾巴已按受众公理剥除,改核切片内容名在场）
    if (!y.includes('语义审计维度判据')) {
      throw new LiveE2EError('worker 子日志无语义审计判据切片——知识注入未达审计 LLM', 1);
    }
  }
  if (matched.size !== 2) throw new LiveE2EError('两份 worker 子日志未分别对应 alpha/beta 两批', 1);
  // ③ 数据流正确:4.2 reason 的 prompt 含前序产物路径
  if (!log.text.includes('cross_compare_results.yaml')) {
    throw new LiveE2EError('prompt 无 cross_compare_results.yaml 路径——4.2 前序产物未传导', 1);
  }
  return { exercised: 'anchor-audit' };
}

// 轻量并行冒烟断言（统一模型 §U8 渐进派发最小闭环；2026-08-11 随 P2 入 e2e:all）。
// 判据：completed + 列表全收齐按派发序 + dispatch 块逐个入轨 + 账面无在飞残留。
// 串行退化（载体无并行能力逐个 launch→reap）同样通过——语义等价，验的是协议闭环非加速比。
// @v: anc-exec-parallel-inflight, anc-exec-parallel-reap-log —— 统一模型派发/收割账面（5a 断言在链）
function assertParallelSmokeScenario({ finalText, mainText, workspace, offline = false }) {
  // 终态断言看全部主消息（mainText）非最后一条——2026-08-12 真机实撞:主 agent 先报 completed YAML,
  // 后到的 task-notification 补话("上一条终态YAML即为最终交付")覆盖 finalText 误红。failure 场景
  // 2026-08-10 同款,本函数当时漏配。
  const terminalText = mainText ?? finalText;
  if (!offline && !terminalText.includes('status: completed')) throw new LiveE2EError('parallel 冒烟应 completed', 1);
  const stateRoot = join(workspace, '.hopstate');
  const instances = readdirSync(stateRoot).filter(d => !d.startsWith('.'));
  // 按目录名（非全路径）滤子实例目录——重放守卫首撞：归档路径含 'parallel' 时全路径过滤把顶层也滤光
  const top = instances
    .filter(name => !name.includes('parallel') && !name.includes('calls'))
    .map(d => join(stateRoot, d))
    .find(d => existsSync(join(d, 'state.json')));
  if (!top) throw new LiveE2EError('未找到顶层实例 state', 1);
  const state = JSON.parse(readFileSync(join(top, 'state.json'), 'utf-8'));
  const vars = JSON.parse(readFileSync(join(top, 'vars.json'), 'utf-8'));
  const flat = Object.assign({}, ...Object.values(vars.scopes ?? {}).map(sc => sc.variables ?? {}));
  const list = flat.doubled_list;
  if (!Array.isArray(list) || list.length !== 3) throw new LiveE2EError(`doubled_list 应 3 项，实际 ${JSON.stringify(list)}`, 1);
  const expected = [6400, 5600, 8200];
  if (JSON.stringify(list) !== JSON.stringify(expected)) {
    throw new LiveE2EError(`doubled_list 应按派发序 ${JSON.stringify(expected)}，实际 ${JSON.stringify(list)}`, 1);
  }
  if (String(flat.summary ?? '') !== 'collected=3') throw new LiveE2EError(`summary 应 collected=3，实际 ${flat.summary}`, 1);
  const inflightLeft = (state.inflight ?? []).filter(f => f.status === 'inflight');
  if (inflightLeft.length !== 0) throw new LiveE2EError(`账面在飞残留 ${inflightLeft.length}——收齐失败/幻影`, 1);
  // G11：dispatch 块逐个入轨（3 迭代 ≥3 条）
  const log = readHopLogText(workspace);
  const dispatchCount = (log.text.match(/dispatch:/g) ?? []).length;
  if (dispatchCount < 3) throw new LiveE2EError(`HopLog dispatch 块应 ≥3（渐进派发逐个入轨），实际 ${dispatchCount}`, 1);
  if (!/^status: completed$/m.test(log.text)) throw new LiveE2EError('HopLog 尾部非 completed 终态', 1);
  return { exercised: 'parallel-smoke' };
}

// 独立模式真机并行断言（standalone 薄协议 × 统一模型并行叠加,2026-08-11 补缺）：
// 薄协议判据（零 CLI 写命令/零 subagent/MCP start_run 在轨）沿用 standalone;
// 业务判据（列表按派发序/收齐）从终态文本核——server 进程内 dispatcher 自行并发,
// driver 面不出现任何 worker 驱动痕迹正是判据。
// @v: anc-driver-codex-standalone-dispatch, anc-exec-parallel-inflight —— 薄协议×并行叠加（5a 断言在链）
function assertStandaloneParallelScenario({ normalized, finalText, mainText, workspace, offline = false }) {
  const terminalText = mainText ?? finalText;
  const commands = normalized.filter(event => event.type === 'command');
  const cliWrites = commands.filter(event => HOP_WRITE_RE.test(event.command) || HOP_RUN_RE.test(event.command));
  if (cliWrites.length > 0) {
    throw new LiveE2EError(`standalone-parallel 观测到 hopjit CLI 写命令（应全走 MCP 工具面）: ${cliWrites[0].command.slice(0, 80)}`, 1);
  }
  if (normalized.some(event => event.type === 'subagent_start')) {
    throw new LiveE2EError('standalone-parallel 不应出现 subagent——并发归 server 进程内 dispatcher,不归 driver', 1);
  }
  const mcpCalls = normalized.filter(event => event.type === 'mcp_tool' && event.server.includes('hopjit'));
  if (!offline && !mcpCalls.some(event => /start_run/.test(event.tool))) {
    throw new LiveE2EError('standalone-parallel 未观测到 hopjit MCP start_run 调用——薄协议未走通', 1);
  }
  if (!offline && !terminalText.includes('status: completed')) {
    throw new LiveE2EError('standalone-parallel 终态非 completed YAML 块', 1);
  }
  for (const needle of offline ? [] : ['6400', '5600', '8200', 'collected=3']) {
    if (!terminalText.includes(needle)) {
      throw new LiveE2EError(`standalone-parallel 终态缺业务结果 ${needle}（列表按派发序 [6400,5600,8200]）`, 1);
    }
  }
  // 账面核验（review 补 2026-08-12,同 assertStandaloneScenario）：账面判据与 parallel 冒烟完全同构
  // ——委托其账面部分（offline:true 跳过其终态文本判据,只跑 state/vars/HopLog 面）
  assertParallelSmokeScenario({ finalText, mainText, workspace, offline: true });
  return { exercised: 'standalone-parallel' };
}

// offline=true：存档重放模式（G13 ^anc-driver-live-e2e-assertions）——事件流/终态文本类正向判据跳过
// （归档只有 .hopstate+.hoplog）,账面形状断言全跑。事件缺席只跳过对应判据,不装通过其余面。
// @a: anc-driver-live-e2e-assertions
export function assertScenario({ scenario, normalized, finalText, mainText, workspace, offline = false }) {
  if (FAILURE_SCENARIOS[scenario]) {
    return assertFailureScenario(scenario, { normalized, finalText, mainText, workspace, offline });
  }
  if (scenario === 'cc:anchor-audit') {
    return assertAnchorAuditScenario({ normalized, finalText, mainText, workspace, offline });
  }
  if (scenario === 'codex:standalone' || scenario === 'cc:standalone') {
    return assertStandaloneScenario({ normalized, finalText, mainText, workspace, offline });
  }
  if (scenario === 'cc:call') {
    return assertCallScenario({ normalized, finalText, mainText, workspace, offline });
  }
  if (scenario === 'codex:standalone-parallel') {
    return assertStandaloneParallelScenario({ normalized, finalText, mainText, workspace, offline });
  }
  if (scenario === 'cc:parallel' || scenario === 'codex:parallel') {
    return assertParallelSmokeScenario({ finalText, mainText, workspace, offline });
  }

  const commands = normalized.filter(event => event.type === 'command');
  const writes = commands.filter(event => HOP_WRITE_RE.test(event.command));
  const runs = commands.filter(event => HOP_RUN_RE.test(event.command));
  const formalStarts = normalized.filter(event => event.type === 'subagent_start' && event.role !== 'probe');

  // 终态断言吃 mainText（^anc-driver-live-e2e-events 三撞成律,本处与 anchor-audit 是当年漏迁的最后两处存量）
  const terminalText = mainText ?? finalText;
  if (!offline && !terminalText.includes('status: completed')) {
    throw new LiveE2EError('carrier 最终输出不是完整的 completed YAML', 1);
  }
  if (!offline && !terminalText.includes('周营业额：27600 元')) {
    throw new LiveE2EError('carrier 最终输出缺少预期周营业额 27600', 1);
  }
  readTerminalEvidence(workspace);

  if (scenario === 'cc:delegated' || scenario === 'codex:delegated') {
    // main 的写禁令豁免 --answer：paused（ask/confirm）注入按 skill 协议归 main 本职
    //（2026-08-09 coffee-week 首步加 ask 后实红——断言没跟上"main 只碰介入点"的分工全貌:
    // 禁的是 main 抢执行链(run/执行步 submit),不是介入点注入）。
    // --help 探测豁免（2026-08-25 live:core 三诊实撞:sonnet 主 agent 跑 'hopjit resume --help'
    // 探命令面——只读零状态写入,HOP_WRITE_RE 词面命中误杀;写禁令拦的是真执行链抢跑）
    const mainWrites = writes.filter(event => event.actor === 'main' && !/--answer\b/.test(event.command) && !/--help\b/.test(event.command));
    if (mainWrites.length > 0) {
      throw new LiveE2EError('delegated 场景观测到 main 执行 HopJIT 写命令（非介入点 --answer）', 1);
    }
    const directEvidence = formalStarts.length > 0 && writes.some(event => event.actor === 'subagent');
    const codexWaitEvidence = scenario === 'codex:delegated'
      && normalized.some(event => event.type === 'subagent_wait')
      // 措辞随 cc297f6"说人话"纪律：用户可见消息不含 segment 等协议词——匹配人话表述,
      // 且不锁词序/短语（2026-08-08 实撞后 2026-08-09 再撞："已定位并启动…任务执行中"被
      // 旧正则拒——"已启动"要求连续子串、"任务.*启动"锁死词序。不变量是语义"已开始干活"：
      // 出现 启动/执行中/进行中/started/running 任一即算,不组合限定）。
      // 三撞（2026-08-11）："任务开始执行"不含以上任一词——补 开始/委托/交由。语义不变量
      // 仍是"已开始干活"，词表随真机人话措辞渐进收敛（穷举不可能,红一次补一词）。
      && normalized.some(event => event.type === 'message' && /启动|执行中|进行中|开始|委托|交由|started|running|begin/i.test(event.text))
      // 闭合证据的"零写命令"同样豁免 --answer（介入点注入归 main 本职,同 mainWrites 豁免——
      // 2026-08-10 实撞:main 仅注入 answer 被计入 writes,闭合证据判非零假红）
      && writes.filter(event => !/--answer\b/.test(event.command)).length === 0;
    if (!offline && !directEvidence && !codexWaitEvidence) {
      throw new LiveE2EError('delegated 场景缺少直接或闭合的 subagent 执行证据', 1);
    }
  }

  if (scenario === 'codex:flash' && !offline) {
    // 模式自适应断言（2026-08-08 作者定"跑出 spawn 就 spawn"+命题反转"测的是 ds4flash"）：
    // 场景验的是弱模型长程可靠性，物理模式随环境——delegated 验 main 零写命令，
    // inline 验 main 恰一次 run；exercised 随凭证上报供人核实际路径。
    if (formalStarts.length > 0) {
      // spawn 可用 → delegated：main 不得写 HopJIT（--answer 介入点注入豁免,同 delegated 场景）
      if (writes.some(event => event.actor === 'main' && !/--answer\b/.test(event.command))) {
        throw new LiveE2EError('spawn 在场走 delegated 时 main 不得执行 HopJIT 写命令（非介入点 --answer）', 1);
      }
      return { exercised: 'delegated' };
    }
    // 闭合证据 delegated（2026-08-13 真机实撞:codex 新版 collab 流只转发 wait 不转发 spawn_agent——
    // formalStarts=0 但 main 进 segment wait+零写命令+业务由 subagent 完成,与 delegated 场景同款闭合判据,flash 当时漏配）
    const flashWaitEvidence = normalized.some(event => event.type === 'subagent_wait')
      && writes.filter(event => !/--answer\b/.test(event.command)).length === 0;
    if (flashWaitEvidence) {
      return { exercised: 'delegated-closed' };
    }
    const mainRuns = runs.filter(event => event.actor === 'main');
    if (mainRuns.length !== 1) {
      throw new LiveE2EError(`inline 模式 main 的 hopjit run 应恰为 1 次，实际 ${mainRuns.length}（且无 wait 闭合证据——既非 delegated 亦非 inline）`, 1);
    }
    return { exercised: 'inline' };
  }
  return { exercised: scenario.includes('delegated') ? 'delegated' : 'default' };
}

// 失败路径场景的 spec/params/嘱咐（2026-08-09 作者定 12345）。确定性失败触发全在 spec body
// 内（计算异常/机械 check 判据），prompt 不诱导失败也不掩盖——driver 按协议如实驱动即可。
const FAILURE_SCENARIOS = {
  'cc:repair': {
    spec: 'examples/e2e-failure/e2e-repair.md',
    params: { daily_sales: [3200, 2800, 3600, 4100, 3900, 5200, 4800], weekly_target: 26000 },
    extra: '核验步骤按判据如实回答（含"## 数据复核"字样才算合格），失败会自动重试，照常驱动到终态。',
  },
  'cc:adaptive': {
    spec: 'examples/e2e-failure/e2e-adaptive.md',
    params: { orders: [
      { id: 'A1', amount: { value: 3200, currency: 'CNY' } },
      { id: 'A2', amount: { value: 2800, currency: 'CNY' } },
      { id: 'A3', amount: { value: 3600, currency: 'CNY' } },
    ] },
    extra: '子任务失败两次后会请求重规划（adaptive_needed）——按响应里的 subtask 契约与失败历史生成新 children 经 --replan 提交,照常驱动到终态。',
  },
  'cc:uncaught': {
    spec: 'examples/e2e-failure/e2e-uncaught.md',
    params: { label: 'north-store' },
    extra: '执行中若引擎返回 failed 终态，如实输出 failed YAML（reason 原文），不要重试、不要改参数再跑。',
  },
  'cc:parallel-partial': {
    spec: 'examples/e2e-failure/e2e-parallel-partial.md',
    params: { store_sales: [3200, 'bad-data', 4100] },
    extra: '并行分支里有失败是预期数据问题，照常 join 并驱动到终态，不要修数据重跑。',
  },
  'cc:paused': {
    spec: 'examples/e2e-failure/e2e-paused.md',
    params: { daily_sales: [3200, 2800, 3600, 4100, 3900, 5200, 4800] },
    extra: '遇到需要人确认的步骤时，如实报告"有一处需要确认"并停止——本次运行没有人在场，不要替答、不要注入任何 answer。',
  },
  'cc:call-fail': {
    spec: 'examples/e2e-failure/e2e-call-parent.md',
    params: { raw_value: 'not-a-number' },
    extra: '遇到 call 步骤按 skill 的 call 协议驱动子实例；子实例失败时用 --failure-child 机器通道回报（不要用 --failure 文本转述）；最终如实输出 failed YAML。',
  },
};

export function buildPrompt(scenario = 'codex:delegated', workspace = undefined) {
  if (scenario === 'cc:anchor-audit') {
    const specRef = workspace ? join(workspace, 'audit-kit', 'anchor-audit.md') : 'audit-kit/anchor-audit.md';
    const kitDir = workspace ? join(workspace, 'audit-kit') : 'audit-kit';
    const fixtureDir = workspace ? join(workspace, 'fixture') : 'fixture';
    const params = JSON.stringify({ project_root: fixtureDir, scripts_dir: kitDir, concept_dir: '', audit_mode: 'fresh' });
    return `$hopspec run ${specRef} --params '${params}'\n所有输入已经显式提供，不要再次请求参数确认。在当前工作目录执行（状态目录=当前目录下 .hopstate）。执行中两处询问按此答复：确认审计范围时选 approve；展示审计结果询问修复时选 report_only（本次只审计不修复）。完整执行并以终态 YAML 结束。`;
  }
  if (scenario === 'codex:standalone-parallel') {
    const specRef = workspace ? join(workspace, 'examples', 'e2e-parallel-smoke.md') : 'examples/e2e-parallel-smoke.md';
    return `$hopspec-mcp run ${specRef} --params '{"store_sales":[3200,2800,4100]}'
启动前先报告一句:直接发起 MCP 工具调用 mcp__hopjit__list_runs（全限定名,只读零状态）,报告这次调用成功与否及返回内容摘要。禁止用工具清单可见性、list_mcp_resources、shell 跑 codex mcp list 等任何探测代替这次真调用。随后按 $hopspec-mcp 薄协议执行（经 mcp__hopjit__start_run 委托 server 全程执行,包括其中的并行步骤——server 进程内自行并发,你不驱动任何 worker）。所有输入已显式提供,不要请求参数确认。完整执行并以终态 YAML 结束。`;
  }
  if (scenario === 'cc:parallel' || scenario === 'codex:parallel') {
    const specRef = workspace ? join(workspace, 'examples', 'e2e-parallel-smoke.md') : 'examples/e2e-parallel-smoke.md';
    return `$hopspec run ${specRef} --params '{"store_sales":[3200,2800,4100]}'
所有输入已经显式提供，不要再次请求参数确认。在当前工作目录执行（状态目录=当前目录下 .hopstate）。遇到 dispatch_ready 按 skill 的渐进派发协议驱动（起 worker 执行 launch_command、advance 续推、收到完成后 reap_and_fetch_next 收割）；无并行能力时按串行逐个执行 launch_command 后 reap 亦可。完整执行并以终态 YAML 结束。`;
  }
  const failure = FAILURE_SCENARIOS[scenario];
  if (failure) {
    const specRef = workspace ? join(workspace, failure.spec) : failure.spec;
    return `$hopspec run ${specRef} --params '${JSON.stringify(failure.params)}'
所有输入已经显式提供，不要再次请求参数确认。在当前工作目录执行（状态目录=当前目录下 .hopstate）。${failure.extra}`;
  }
  if (scenario === 'cc:call') {
    // 正向 call:复用教学样例对(父 summarize 调子 normalize)——教学件即测试件
    const specRef = workspace ? join(workspace, 'examples', 'syntax', 'call-parent-summarize.md') : 'examples/syntax/call-parent-summarize.md';
    const params = JSON.stringify({ doc: "  第一段  有多余空格\n\n\n\n第二段:引擎按spec执行,可靠可回放。\n\n\n  第三段   结尾  " });
    return `$hopspec run ${specRef} --params '${params}'\n所有输入已经显式提供,不要再次请求参数确认。在当前工作目录执行（状态目录=当前目录下 .hopstate）。遇到 call 步骤按 skill 的 call 协议驱动子实例到完成并回填。完整执行并以终态 YAML 结束。`;
  }
  if (scenario === 'codex:demo') {
    return '$demo-coffee-week\n使用 skill 自带的 coffee-sales.json 和 weekly_target=26000。执行到"确认本周数据和目标"的询问时,我确认目标就是 26000 元,直接以 26000 作答继续。完整执行并以终态 YAML 结束。';
  }
  const params = JSON.stringify({
    daily_sales: [3200, 2800, 3600, 4100, 3900, 5200, 4800],
    weekly_target: 26000,
  });
  // spec 用工作区绝对路径钉死定位一级（相对 cwd）——E2E 验的是协议与执行面，不该
  // 让 LLM 定位漂移（相对路径曾概率性走到"相对包根"一级 → cd 全局包目录 → .hopstate
  // 逃逸出 workspace 假红，2026-08-08 实撞）。定位体验归手工验收 §3。
  const specRef = workspace ? join(workspace, 'examples', 'coffee-week.md') : 'examples/coffee-week.md';
  if (scenario === 'codex:standalone' || scenario === 'cc:standalone') {
    // 双名双壳（四改）:MCP 装配用 $hopspec-mcp 具名调用——名字即模式,零形态判定。
    // 首句仍强制报告 list_runs 试调用结果——失败日志据此一眼分辨"注册失败"vs"skill 失效"。
    return `$hopspec-mcp run ${specRef} --params '${params}'\n启动前先报告一句:直接发起 MCP 工具调用 mcp__hopjit__list_runs（全限定名,只读零状态）,报告这次调用成功与否及返回内容摘要。禁止用工具清单可见性、list_mcp_resources、shell 跑 codex mcp list 等任何探测代替这次真调用（MCP 工具延迟加载,清单看不见不等于不存在）。随后按 $hopspec-mcp 薄协议执行。执行到"确认本周数据和目标"的询问时,我确认目标就是 26000 元,直接以 26000 作答继续。状态目录=当前目录下 .hopstate。完整执行并以终态 YAML 结束。`;
  }
  // coffee-week 首步是 [ask require_human] 确认周目标（2026-08-09 参数确认入 spec 引擎强制）——
  // e2e 无人在场,prompt 即用户预授权:确认目标 26000。
  return `$hopspec run ${specRef} --params '${params}'\n所有输入已经显式提供。执行到"确认本周数据和目标"的询问时,我确认目标就是 26000 元,直接以 26000 作答继续。在当前工作目录执行（状态目录=当前目录下 .hopstate）。按已安装 skill 完整执行，并以终态 YAML 结束。`;
}

export function buildCarrierCommand(scenario, options = {}) {
  const prompt = buildPrompt(scenario, options.workspace);
  if (scenario.startsWith('cc:')) {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--forward-subagent-text',
      '--include-hook-events',
      '--no-session-persistence',
      '--dangerously-skip-permissions',
      '--setting-sources', 'project',
    ];
    if (options.model) args.push('--model', options.model);
    if (scenario === 'cc:standalone') {
      // 薄协议场景：注册 hopjit MCP server（工具面可见=选定 standalone,与 codex 侧同一契约）。
      // --strict-mcp-config 隔离用户全局 MCP 配置——工具面只有本场景注册的 server,判定确定。
      // mcpConfigPath 由 runner 生成（server 命令+HOPJIT_CONFIG env）。
      args.push('--mcp-config', options.mcpConfigPath, '--strict-mcp-config');
    }
    args.push(prompt);
    if (options.launcher === 'claude-ds') {
      return {
        command: 'zsh',
        args: ['-ic', 'claude-ds "$@"', 'carrier-live-e2e', ...args],
      };
    }
    return { command: options.launcher ?? 'claude', args };
  }

  const args = [
    'exec',
    // --ephemeral 不用于 standalone:高嫌疑它跳过 MCP server 启动——持久注册的 hopjit 在
    // --ephemeral 会话里 router 报 unsupported call,而用户手动 exec（无 --ephemeral）中
    // 持久注册的 deepwiki 工具在场;全部 22 份 e2e 轨迹（皆 --ephemeral）零 mcp_startup 事件。
    ...(scenario === 'codex:standalone' || scenario === 'codex:standalone-parallel' ? [] : ['--ephemeral']),
    '--json',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
  ];
  if (scenario === 'codex:standalone' || scenario === 'codex:standalone-parallel') {
    // standalone 场景：hopjit MCP server 由 runner 以持久注册（codex mcp add）提供——
    // 真机实证 exec 运行时不为 -c 注入的 mcp_servers 起 stdio 进程（2026-08-10 判定实验:
    // deepwiki 持久注册工具在场,同命令 -c 注入的 hopjit 调用报 not a function）。
    // 此处只显式关 multi_agent（只"不加"参数不够,用户全局 config.toml 的
    // agents.enabled=true 会漏进来,实撞走了 delegated）。
    args.push(
      '-c', 'agents.enabled=false',
      '-c', 'features.multi_agent_v2=false',
    );
  } else {
    // codex:flash 与 delegated 同一工具面参数——不压制、不诱导，flash 的真实环境决定
    // delegated/inline，模式自适应断言两头都验（2026-08-08 命题反转：测的是弱模型，不是降级路径）。
    args.push(
      '--enable', 'multi_agent_v2',
      '-c', 'agents.enabled=true',
      // 委派指令要求直接调用，不能藏进 functions.exec（Codex 0.154.0 请求对照，todo/0094）。
      '-c', 'features.multi_agent_v2.non_code_mode_only=true',
      '-c', 'features.multi_agent_v2.tool_namespace="agents"',
    );
  }
  if (options.profile) args.push('-p', options.profile);
  if (options.model) args.push('-m', options.model);
  args.push('-C', options.workspace, prompt);
  return { command: 'codex', args };
}

export function carrierAdapter(scenario, stdout) {
  const events = parseJsonLines(stdout, scenario.startsWith('cc:') ? 'Claude stream-json' : 'Codex --json');
  return scenario.startsWith('cc:')
    ? normalizeClaudeEvents(events)
    : normalizeCodexEvents(events);
}

// 失败诊断给人看——YAML 结构（2026-08-09 作者指正:原 JSON 里塞 8000 字符转义 stdout 没法读）。
// carrier 进度提炼自 stream-json 的 result 事件（主 agent 的人话摘要）,raw stdout 全文在失败归档里。
export function diagnosticSummary({ scenario, result, normalized, secrets }) {
  const counts = {};
  for (const event of normalized) counts[event.type] = (counts[event.type] ?? 0) + 1;
  // 提取 carrier 的进度摘要:stream-json 每个 result 事件的 result 字段（主 agent 人话汇报）
  const progress = [];
  for (const line of result.stdout.split('\n')) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'result' && typeof ev.result === 'string') progress.push(ev.result.replace(/\n+/g, ' ').slice(0, 200));
      if (ev.type === 'result' && ev.is_error) progress.push(`[error_during_execution] ${(ev.errors ?? []).join('; ')}`.slice(0, 200));
    } catch { /* 非 JSON 行跳过 */ }
  }
  const lines = [
    '═══ 失败诊断 ═══',
    `scenario: ${scenario}`,
    `exit_code: ${result.code}`,
    `signal: ${result.signal ?? 'null'}`,
    `timed_out: ${result.timedOut}`,
    `event_counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || '(无归一事件——常见于超时被掐,事件归一未执行)'}`,
    'carrier_progress:  # 主 agent 逐段人话汇报（提炼自 result 事件,完整 stdout 见失败归档）',
    ...(progress.length ? progress.map(p => `  - ${p}`) : ['  - (无 result 事件)']),
    ...(result.stderr.trim() ? ['stderr_tail: |', ...result.stderr.slice(-2000).split('\n').map(l => `  ${l}`)] : []),
    // 短 stdout 尾段（人可扫;完整不截断版在失败归档 stdout.log）
    'stdout_tail: |',
    ...result.stdout.slice(-1500).split('\n').map(l => `  ${l}`),
  ];
  return redactSecrets(lines.join('\n'), secrets);
}

export function assertBuilt() {
  const cli = join(PROJECT_ROOT, 'dist', 'cli.js');
  if (!existsSync(cli)) {
    throw new LiveE2EError('缺少 dist/cli.js；先运行 npm run build', 2);
  }
}

export async function installCarrierSkill(workspace, carrier, env, timeoutMs, withDemo = false, mcpShell = false) {
  const args = [
    join(PROJECT_ROOT, 'dist', 'cli.js'),
    '--json',
    'install-skill',
    '--carrier', carrier,
    '--force',
  ];
  if (carrier === 'cc') args.push('--dir', join(workspace, '.claude', 'skills'));
  else args.push('--dir', join(workspace, '.agents', 'skills'));   // --dir 语义=skills 根（2026-08-27 看齐批）;e2e 恒项目级隔离,workspace 即项目根故落 .agents/skills
  if (withDemo) args.push('--demo');
  // 壳分模式装配（2026-08-16）:standalone 场景须装 MCP 变体壳——运行时形态判定已随装配时化退役,
  // 复用壳只剩改道牌,装错变体=agent 提示重装而非走薄协议。CC 走 --mcp（.mcp.json 落临时 workspace
  // cwd 零污染;会话仍由 --strict-mcp-config 钉工具面,装壳注册产物无干扰）;Codex 不可走 --mcp
  //（会写真实 ~/.codex/config.toml 污染用户配置）——装完复用壳后直接拷 MCP 变体覆盖。
  if (mcpShell && carrier === 'cc') args.push('--mcp');
  const result = await runChildProcess(process.execPath, args, { cwd: workspace, env, timeoutMs });
  if (result.code !== 0) {
    throw new LiveE2EError(`install-skill 失败：${result.stderr || result.stdout}`, 2);
  }
  // 双名双壳（2026-08-27 四改）：install-skill 恒装两壳（hopspec + hopspec-mcp）,场景 prompt
  // 用 $hopspec-mcp 具名调用即选定 MCP 装配。mcpShell 参数保留调用面兼容（只余 cc --mcp 注册便利）。
  if (withDemo && !existsSync(join(workspace, '.agents', 'skills', 'demo-coffee-week', 'SKILL.md'))) {
    throw new LiveE2EError('Codex demo skill 未安装到 .agents/skills/demo-coffee-week', 2);
  }
}

export async function initializeGitWorkspace(workspace, env, timeoutMs) {
  const result = await runChildProcess('git', ['init', '-q'], {
    cwd: workspace,
    env,
    timeoutMs,
  });
  if (result.code !== 0) {
    throw new LiveE2EError(`临时工作区 git init 失败：${result.stderr || result.stdout}`, 2);
  }
}
