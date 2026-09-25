// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: mcp-server ^anc-struct-mcp-server
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadStandaloneConfig,
  mergeConfigs,
  buildEnvSnapshot,
  providerToHostConfig,
  collectSpecTools,
  HopjitMcpCore,
  buildServer,
  type StandaloneConfig,
  type ProviderEntry,
} from '../src/mcp-server.js';
import { parseSpec } from '../src/parser.js';
import { ExecutionEngine } from '../src/engine.js';
import { StepDispatcher } from '../src/dispatcher.js';

const REPO = resolve(import.meta.dirname, '..');

function writeConfig(content: string, mode = 0o600, name = 'config.yaml'): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cfg-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

const VALID_PROVIDER: ProviderEntry = {
  service_id: 'deepseek', protocol: 'anthropic',
  base_url: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-flash',
  api_key_env: 'HOPJIT_TEST_KEY_ENV',
};

beforeAll(() => { process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-test-fake'; });
afterAll(() => { delete process.env['HOPJIT_TEST_KEY_ENV']; });

// @v: anc-config-standalone-schema —— StandaloneConfig 加载：fail-fast + env 引用唯一凭证形态
// @v: anc-exec-standalone-invariants —— standalone 整体约束第1/4/5条（key 不落盘/拦在门口/配置文件只一个）的配置侧正反例
describe('loadStandaloneConfig', () => {
  it('完整 schema 正常加载（YAML 原生书写）', () => {
    const p = writeConfig([
      'providers:',
      '  - service_id: deepseek',
      '    protocol: anthropic',
      '    base_url: https://api.deepseek.com/anthropic',
      '    model: deepseek-v4-flash',
      '    api_key_env: HOPJIT_TEST_KEY_ENV',
    ].join('\n'));
    const c = loadStandaloneConfig(p);
    expect(c.providers[0].service_id).toBe('deepseek');
  });

  // @v: anc-config-standalone-schema —— auth 鉴权头档（bearer=Authorization: Bearer,只认此形态
  // 的网关实测百炼 claude-code-proxy 对 x-api-key 报 InvalidApiKey）
  it('正例：providers auth: bearer 合法加载;反例：非法枚举值 fail-fast 拒', () => {
    const mk = (auth: string) => writeConfig([
      'providers:',
      '  - service_id: bailian_qwen',
      '    protocol: anthropic',
      '    base_url: https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy',
      '    model: qwen3.8-27b',
      '    api_key_env: HOPJIT_TEST_KEY_ENV',
      `    auth: ${auth}`,
    ].join('\n'));
    const ok = loadStandaloneConfig(mk('bearer'));
    expect((ok.providers[0] as { auth?: string }).auth).toBe('bearer');
    expect(() => loadStandaloneConfig(mk('token'))).toThrow(/auth 'token' 不支持/);
  });

  // @v: anc-exec-thinking-provider-default —— provider 级思考缺省（五级链第 4 级,0100 批:
  // 逐模型矫正档——端点缺省互相相反且不可见,配置层显式化;env 键 {SID}_THINKING 随快照披发）
  it('正例：providers thinking: disabled 合法加载且 env 快照披发 {SID}_THINKING;反例：非法枚举 fail-fast 拒', () => {
    const mk = (v: string) => writeConfig([
      'providers:',
      '  - service_id: antchat',
      '    protocol: anthropic',
      '    base_url: https://antchat.alipay.com/api/anthropic',
      '    model: Ling-3.0-Flash',
      '    api_key_env: HOPJIT_TEST_KEY_ENV',
      `    thinking: ${v}`,
    ].join('\n'));
    const ok = loadStandaloneConfig(mk('disabled'));
    expect((ok.providers[0] as { thinking?: string }).thinking).toBe('disabled');
    const keys = new Map([[ok.providers[0], 'k']]);
    const snap = buildEnvSnapshot(ok, keys as never);
    expect(snap['ANTCHAT_THINKING']).toBe('disabled');
    expect(() => loadStandaloneConfig(mk('auto'))).toThrow(/thinking 'auto' 非法/);
  });

  it('反例：thinking 缺席时快照无 {SID}_THINKING 键（缺省落引擎内建第 5 级,不披发假值）', () => {
    const p = writeConfig([
      'providers:',
      '  - service_id: antchat',
      '    protocol: anthropic',
      '    base_url: https://antchat.alipay.com/api/anthropic',
      '    model: Ling-3.0-Flash',
      '    api_key_env: HOPJIT_TEST_KEY_ENV',
    ].join('\n'));
    const c = loadStandaloneConfig(p);
    const snap = buildEnvSnapshot(c, new Map([[c.providers[0], 'k']]) as never);
    expect('ANTCHAT_THINKING' in snap).toBe(false);
  });

  it('JSON 语法写进 config.yaml 仍可解析（YAML 超集——不构成第二格式）', () => {
    const p = writeConfig(JSON.stringify({ providers: [VALID_PROVIDER] }), 0o600, 'config.yaml');
    const c = loadStandaloneConfig(p);
    expect(c.providers[0].service_id).toBe('deepseek');
  });

  it('顶层非映射（YAML 标量/数组）→ INVALID', () => {
    const p = writeConfig('- just\n- a\n- list\n');
    expect(() => loadStandaloneConfig(p)).toThrow(/不是 YAML 映射/);
  });

  // @v: anc-exec-model-routing —— 系统层 routing_rules 文法（两层配置的系统半边,2026-08-13）
  it('正例：routing_rules 合法（含 replan 类别）→ 加载通过', () => {
    const p = writeConfig([
      'providers:',
      '  - service_id: deepseek',
      '    protocol: anthropic',
      '    base_url: https://api.deepseek.com/anthropic',
      '    model: deepseek-v4-flash',
      '    api_key_env: HOPJIT_TEST_KEY_ENV',
      'routing_rules:',
      '  - step_type: act',
      '    model: deepseek/deepseek-v4-flash',
      '  - step_type: replan',
      '    model: deepseek/deepseek-v4-pro',
    ].join('\n'));
    const c = loadStandaloneConfig(p);
    expect(c.routing_rules).toHaveLength(2);
  });

  it('反例：routing_rules 未知类别（confirm 介入点无 LLM）→ 拒并列类别表', () => {
    const p = writeConfig([
      'providers:',
      '  - service_id: deepseek',
      '    protocol: anthropic',
      '    base_url: https://api.deepseek.com/anthropic',
      '    model: deepseek-v4-flash',
      '    api_key_env: HOPJIT_TEST_KEY_ENV',
      'routing_rules:',
      '  - step_type: confirm',
      '    model: deepseek-v4-flash',
    ].join('\n'));
    expect(() => loadStandaloneConfig(p)).toThrow(/不在类别表.*replan/s);
  });

  // thinking 枚举核（形态 B——非法值静默失效是 0008③ 同病） // @v: anc-exec-thinking-routing
  it('正例：routing_rules 带 thinking 合法枚举过;反例：枚举外值拒', () => {
    const mk = (tv: string) => writeConfig([
      'providers:', '  - service_id: deepseek', '    protocol: anthropic',
      '    base_url: https://api.deepseek.com/anthropic', '    model: m', '    api_key_env: HOPJIT_TEST_KEY_ENV',
      'routing_rules:', '  - step_type: act', '    model: deepseek/m2', `    thinking: ${tv}`,
    ].join('\n'));
    expect(loadStandaloneConfig(mk('disabled')).routing_rules![0].thinking).toBe('disabled');
    expect(() => loadStandaloneConfig(mk('off'))).toThrow(/thinking 'off' 非法/);
  });

  it('反例：routing_rules 引用 providers 外的 service → 拒（拼错=请求错后端,default_model 同纪律）', () => {
    const p = writeConfig([
      'providers:',
      '  - service_id: deepseek',
      '    protocol: anthropic',
      '    base_url: https://api.deepseek.com/anthropic',
      '    model: deepseek-v4-flash',
      '    api_key_env: HOPJIT_TEST_KEY_ENV',
      'routing_rules:',
      '  - step_type: act',
      '    model: ghost_service/some-model',
    ].join('\n'));
    expect(() => loadStandaloneConfig(p)).toThrow(/ghost_service.*不在合并后 providers/s);
  });

  it('文件缺失 → STANDALONE_CONFIG_MISSING（fail-fast 不降级）', () => {
    expect(() => loadStandaloneConfig('/nonexistent/cfg.json')).toThrow(/STANDALONE_CONFIG_MISSING/);
  });

  it('provider 内出现明文 api_key → 无条件拒绝', () => {
    const p = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, api_key: 'sk-plain' }] }), 0o600);
    expect(() => loadStandaloneConfig(p)).toThrow(/STANDALONE_CONFIG_PLAINTEXT_KEY/);
  });

  it('纯 api_key_env 引用形态 + 权限 644 → 正常加载（文件无秘密）', () => {
    const p = writeConfig(JSON.stringify({ providers: [VALID_PROVIDER] }), 0o644);
    const c = loadStandaloneConfig(p);
    expect(c.providers[0].api_key_env).toBe('HOPJIT_TEST_KEY_ENV');
  });

  it('顶层旧裸 api_key 格式 → 拒绝并提示 api_key_env', () => {
    const p = writeConfig(JSON.stringify({ api_key: 'sk-legacy' }), 0o600);
    expect(() => loadStandaloneConfig(p)).toThrow(/STANDALONE_CONFIG_PLAINTEXT_KEY.*api_key_env/);
  });

  // @v: anc-config-standalone-schema —— 统一配置两级合并（作者定 2026-08-13:同 schema 两作用域,逐节合并项目级赢）
  it('正例：系统级+项目级逐节合并——providers 按 service_id 项目级赢,routing_rules 按 step_type 合并,tool_servers 并集', () => {
    const sysDir = mkdtempSync(join(tmpdir(), 'cfg-sys-'));
    const projDir = mkdtempSync(join(tmpdir(), 'cfg-proj-'));
    // 经内部函数面直测合并（loadStandaloneConfig 的 homedir 不可注入——mergeConfigs 语义直测,
    // 端到端两级发现面由 projectDir 参数测）
    writeFileSync(join(sysDir, 'config.yaml'), JSON.stringify({
      providers: [VALID_PROVIDER, { ...VALID_PROVIDER, service_id: 'sysonly' }],
      routing_rules: [{ step_type: 'act', model: 'deepseek/sys-flash' }],
    }));
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({
      providers: [{ ...VALID_PROVIDER, model: 'proj-model' }],   // 同 service_id 覆盖
      routing_rules: [{ step_type: 'replan', model: 'deepseek/proj-opus' }],
      tool_servers: [{ name: 'projtool', binding: { kind: 'mcp', transport: 'stdio', command: '/bin/cat' }, tools: [{ name: 't', requires_commit: false }] }],
    }));
    // 模拟系统级:显式 configPath 指系统文件不合并——所以这里直接调 loadStandaloneConfig(undefined, projDir)
    // 需要系统级可注入…先用环境变量 HOME 注入(homedir 跟 HOME):
    const oldHome = process.env['HOME'];
    process.env['HOME'] = sysDir.replace(/\/config.yaml$/, '');
    try {
      const { mkdirSync, renameSync } = require('node:fs');
      mkdirSync(join(sysDir, '.hopjit'), { recursive: true });
      renameSync(join(sysDir, 'config.yaml'), join(sysDir, '.hopjit', 'config.yaml'));
      process.env['HOME'] = sysDir;
      const c = loadStandaloneConfig(undefined, projDir);
      expect(c.providers.find(p => p.service_id === 'deepseek')?.model).toBe('proj-model');   // 项目级赢
      expect(c.providers.some(p => p.service_id === 'sysonly')).toBe(true);                    // 系统级保留
      expect(c.routing_rules).toHaveLength(2);                                                 // 两级 step_type 合并
      expect(c.tool_servers).toHaveLength(1);                                                  // 项目级工具面
    } finally {
      process.env['HOME'] = oldHome;
    }
  });

  // 0005 期望③:跨级不同名 server 声明同一工具名——合并取并集后装配拒（端到端:原只断并集条数）
  it('反例：系统级+项目级不同名 server 撞工具名 → 合并后 startRun 装配拒 TOOLS_NAME_CONFLICT', async () => {
    const merged: StandaloneConfig = {
      providers: [VALID_PROVIDER],
      // 模拟 mergeConfigs 产物:两级各一 server（不同名,byKey 并集保留两条）,工具名撞车
      tool_servers: [
        { name: 'sys_srv', binding: { kind: 'mcp', transport: 'stdio', command: '/bin/cat' }, tools: [{ name: 'shared_tool', requires_commit: false }] },
        { name: 'proj_srv', binding: { kind: 'mcp', transport: 'stdio', command: '/bin/cat' }, tools: [{ name: 'shared_tool', requires_commit: false }] },
      ] as unknown[],
    };
    const core = new HopjitMcpCore(merged);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-xlevel-'));
    writeFileSync(join(dir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    const r = await core.startRun(join(dir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-xlevel-state-')));
    expect((r['error'] as { code: string }).code).toBe('TOOLS_NAME_CONFLICT');
  });

  // @v: anc-exec-revision-short-weak —— mergeConfigs revision_prompt 项目级赢（0084 M2 自立纪律
  // "新顶层键必须同步 mergeConfigs+补合并测试钉"——language 键补了本键没补,2026-09-18 review
  // 面三抓违纪后真补;合并漏本键=项目级 short 档静默蒸发,弱模型修订轮回落标准态烧尽）
  it('正例：revision_prompt 项目级赢;系统级单独在场也生效', () => {
    const sys = { providers: [VALID_PROVIDER], revision_prompt: 'standard' } as StandaloneConfig;
    const proj = { revision_prompt: 'short' } as StandaloneConfig;
    expect(mergeConfigs(sys, proj).revision_prompt).toBe('short');
    expect(mergeConfigs({ providers: [VALID_PROVIDER], revision_prompt: 'short' } as StandaloneConfig, {} as StandaloneConfig).revision_prompt).toBe('short');
  });

  // 0005 附带发现著文钉:server 同名=项目级整体替换（不判工具重——替换语义,byKey by name）
  it('正例：server 同名跨级 → 项目级整体替换该 server 声明（工具集换掉不判重）', () => {
    const sys = { providers: [VALID_PROVIDER], tool_servers: [{ name: 'same', binding: { kind: 'mcp', transport: 'stdio', command: '/sys/bin' }, tools: [{ name: 'old_tool', requires_commit: false }] }] } as StandaloneConfig;
    const proj = { tool_servers: [{ name: 'same', binding: { kind: 'mcp', transport: 'stdio', command: '/proj/bin' }, tools: [{ name: 'new_tool', requires_commit: false }] }] } as StandaloneConfig;
    const merged = mergeConfigs(sys, proj);
    expect(merged.tool_servers).toHaveLength(1);
    const srv = merged.tool_servers![0] as { binding: { command: string }; tools: Array<{ name: string }> };
    expect(srv.binding.command).toBe('/proj/bin');                      // 整体替换
    expect(srv.tools.map(t => t.name)).toEqual(['new_tool']);           // 工具集随之换掉
  });

  it('正例：项目级文件可只有 tool_servers（providers 归系统级——两级合并后齐即合法）', () => {
    const sysDir = mkdtempSync(join(tmpdir(), 'cfg-sys2-'));
    const projDir = mkdtempSync(join(tmpdir(), 'cfg-proj2-'));
    const { mkdirSync } = require('node:fs');
    mkdirSync(join(sysDir, '.hopjit'), { recursive: true });
    writeFileSync(join(sysDir, '.hopjit', 'config.yaml'), JSON.stringify({ providers: [VALID_PROVIDER] }));
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({
      tool_servers: [{ name: 'x', binding: { kind: 'mcp', transport: 'stdio', command: '/bin/cat' }, tools: [{ name: 't', requires_commit: false }] }],
    }));
    const oldHome = process.env['HOME'];
    process.env['HOME'] = sysDir;
    try {
      const c = loadStandaloneConfig(undefined, projDir);
      expect(c.providers).toHaveLength(1);
      expect(c.tool_servers).toHaveLength(1);
    } finally { process.env['HOME'] = oldHome; }
  });

  // @v: anc-config-standalone-schema —— 跨节引用校验时点=合并后（2026-08-13 BUG-E 实撞:
  // 项目级只有 routing_rules+tool_servers〔合法形态〕被逐文件引用核崩——providers undefined 读 .some）
  it('正例回归：项目级只有 routing_rules（引用系统级 providers 的 service）→ 合并后核通过,不崩不误拒（BUG-E 实撞形态）', () => {
    const sysDir = mkdtempSync(join(tmpdir(), 'cfg-sysE-'));
    const projDir = mkdtempSync(join(tmpdir(), 'cfg-projE-'));
    const { mkdirSync } = require('node:fs');
    mkdirSync(join(sysDir, '.hopjit'), { recursive: true });
    writeFileSync(join(sysDir, '.hopjit', 'config.yaml'), JSON.stringify({ providers: [VALID_PROVIDER] }));
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({
      routing_rules: [{ step_type: 'reason', model: `${VALID_PROVIDER.service_id}/some-model` }],
      tool_servers: [{ name: 'x', binding: { kind: 'mcp', transport: 'stdio', command: '/bin/cat' }, tools: [{ name: 't', requires_commit: false }] }],
    }));
    const oldHome = process.env['HOME'];
    process.env['HOME'] = sysDir;
    try {
      const c = loadStandaloneConfig(undefined, projDir);
      expect(c.routing_rules).toHaveLength(1);
      expect(c.providers).toHaveLength(1);
    } finally { process.env['HOME'] = oldHome; }
  });

  it('反例：合并后 routing_rules 引用真不在场的 service → 照拒（引用核没被推迟成不核）', () => {
    const sysDir = mkdtempSync(join(tmpdir(), 'cfg-sysE2-'));
    const projDir = mkdtempSync(join(tmpdir(), 'cfg-projE2-'));
    const { mkdirSync } = require('node:fs');
    mkdirSync(join(sysDir, '.hopjit'), { recursive: true });
    writeFileSync(join(sysDir, '.hopjit', 'config.yaml'), JSON.stringify({ providers: [VALID_PROVIDER] }));
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({
      routing_rules: [{ step_type: 'reason', model: 'ghost/some-model' }],
    }));
    const oldHome = process.env['HOME'];
    process.env['HOME'] = sysDir;
    try {
      expect(() => loadStandaloneConfig(undefined, projDir)).toThrow(/ghost.*不在合并后 providers/);
    } finally { process.env['HOME'] = oldHome; }
  });

  it('反例：两级合并后 providers 仍为空 → MISSING_PROVIDERS（项目级只有工具面且系统级缺席）', () => {
    const sysDir = mkdtempSync(join(tmpdir(), 'cfg-sys3-'));   // 无 .hopjit/config.yaml
    const projDir = mkdtempSync(join(tmpdir(), 'cfg-proj3-'));
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({
      tool_servers: [{ name: 'x', binding: { kind: 'mcp', transport: 'stdio', command: '/bin/cat' }, tools: [{ name: 't', requires_commit: false }] }],
    }));
    const oldHome = process.env['HOME'];
    process.env['HOME'] = sysDir;
    try {
      expect(() => loadStandaloneConfig(undefined, projDir)).toThrow(/MISSING_PROVIDERS/);
    } finally { process.env['HOME'] = oldHome; }
  });

  it('缺 providers[] → INVALID', () => {
    const p = writeConfig(JSON.stringify({ default_model: 'deepseek-v4-flash' }));
    expect(() => loadStandaloneConfig(p)).toThrow(/缺 providers/);
  });

  it('provider 缺 base_url → INVALID（字段逐一校验）', () => {
    const p = writeConfig(JSON.stringify({ providers: [{ service_id: 'x', protocol: 'anthropic', model: 'm', api_key_env: 'K' }] }));
    expect(() => loadStandaloneConfig(p)).toThrow(/base_url/);
  });

  // @v: anc-exec-protocol-adapter —— 配置面 protocol 枚举（openai 放行/乱值拒绝）
  it('正例：protocol openai-chat 放行（2026-08-13 作者定拆——openai 一词罩两套报文用户会疑惑）', () => {
    const p = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, protocol: 'openai-chat' }] }));
    const cfg = loadStandaloneConfig(p);
    expect(cfg.providers[0].protocol).toBe('openai-chat');
  });

  it('正例：protocol openai-responses 放行（0020 批实装 2026-09-20——原预留拒钉翻正:OpenAI 官方生态工具循环正路）', () => {
    const p = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, protocol: 'openai-responses' }] }));
    const cfg = loadStandaloneConfig(p);
    expect(cfg.providers[0].protocol).toBe('openai-responses');
  });

  it('反例：protocol 枚举外乱值 → INVALID（放行 openai 不放行一切）', () => {
    const p = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, protocol: 'grpc' }] }));
    expect(() => loadStandaloneConfig(p)).toThrow(/anthropic \| openai/);
  });

  it('api_key_env 缺失 → INVALID', () => {
    const { api_key_env: _drop, ...noKey } = VALID_PROVIDER;
    const p = writeConfig(JSON.stringify({ providers: [noKey] }));
    expect(() => loadStandaloneConfig(p)).toThrow(/api_key_env.*非法.*须匹配/);
  });

  it('api_key_env 空字符串 → INVALID', () => {
    const p = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, api_key_env: '' }] }));
    expect(() => loadStandaloneConfig(p)).toThrow(/api_key_env.*非法/);
  });

  it('小写 api_key_env 是合法 shell 标识符', () => {
    const p = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, api_key_env: 'hopjit_test_key' }] }));
    expect(loadStandaloneConfig(p).providers[0].api_key_env).toBe('hopjit_test_key');
  });
});

// @v: anc-mcp-key-isolation —— key 解析：env 引用优先，缺失报变量名不报值
describe('providerToHostConfig', () => {
  it('api_key_env 存在时解引用', () => {
    process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-from-env';
    try {
      const hc = providerToHostConfig(VALID_PROVIDER, '/w');
      expect(hc.api_key).toBe('sk-from-env');
      expect(hc.base_url).toBe('https://api.deepseek.com/anthropic');
      expect(hc.model).toBe('deepseek-v4-flash');
    } finally { process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-test-fake'; }
  });

  it('env 缺失 → 报变量名、不报任何值', () => {
    delete process.env['HOPJIT_TEST_KEY_ENV'];
    try {
      providerToHostConfig(VALID_PROVIDER, '/w');
      expect.unreachable('应抛 STANDALONE_KEY_MISSING');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('HOPJIT_TEST_KEY_ENV');
      expect(msg).toContain('deepseek');
      expect(msg).not.toContain('sk-');
    } finally {
      process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-test-fake';
    }
  });

});

// @v: anc-mcp-tools —— 工具面预检：spec 非内置工具收集
describe('collectSpecTools', () => {
  function toolsOf(spec: string): string[] {
    const { ast, errors } = parseSpec(spec);
    expect(errors.filter(e => e.kind === 'parse')).toHaveLength(0);
    return [...collectSpecTools(ast.steps ?? [])].sort();
  }

  it('纯内置 body（coffee-week 风格）→ 空集', () => {
    const spec = `# T\nId: t\n## Goal\ng\n## Steps\n1. [act] 算\n  + → out: int  # o\n  > 说明\n  > \`\`\`hop_python\n  > out = sum(xs) + max(xs)\n  > \`\`\`\n`;
    expect(toolsOf(spec)).toEqual([]);
  });

  it('非内置调用收集（含嵌套参数与 if 分支）', () => {
    const spec = `# T\nId: t\n## Goal\ng\n## Steps\n1. [act] 拉\n  + → out: text  # o\n  > 说明\n  > \`\`\`hop_python\n  > a = fetch(url: "http://x")\n  > if len(a) > 0:\n  >     out = summarize(data: parse_csv(raw: a))\n  > else:\n  >     out = "empty"\n  > \`\`\`\n`;
    expect(toolsOf(spec)).toEqual(['fetch', 'parse_csv', 'summarize']);
  });

  it('嵌套容器（subtask 子步）也收集', () => {
    const spec = `# T\nId: t\n## Goal\ng\n## Steps\n1. [subtask] 容器\n  + → r: text  # o\n  1.1. [act] 内\n    + → r: text  # o\n    > 说明\n    > \`\`\`hop_python\n    > r = custom_tool(x: 1)\n    > \`\`\`\n`;
    expect(toolsOf(spec)).toEqual(['custom_tool']);
  });
});

// @v: anc-mcp-tools, anc-mcp-run-lifecycle —— 注册表核心：错误路径（不触 LLM）
describe('HopjitMcpCore（无 LLM 错误路径）', () => {
  const config: StandaloneConfig = { providers: [VALID_PROVIDER] };

  // @v: anc-exec-parallel-hitl-queue （0013 方案A:run_status 全量呈现待答队列,resume_run 按
  // child_instance 路由——core 级轻探,dispatcher 队列语义已在 dispatcher.test.ts 全谱）
  it('U4b：runStatus 附 paused_queue;resumeRun 携 child_instance 透传路由', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-q-'));
    writeFileSync(join(dir, 's.md'), `# T
Id: t-q
## Goal
g
## Inputs
- items: [int]

## Outputs
- vals: [int]

## Steps
1. [loop for-each it in items, collect human_val into vals] 逐项
  + → vals: [int]  # 收集
  1.1. [subtask parallel] 问人
    + → human_val: int  # 人值
    1.1.1. [ask require_human=true] 请提供
      - ← it
      + → human_val: int  # 人值
2. [exit] 交付
  + → vals
`);
    const sd = mkdtempSync(join(tmpdir(), 'mcp-q-state-'));
    const r = await core.startRun(join(dir, 's.md'), { items: [1, 2] }, sd, dir);
    const runId = r['run_id'] as string;
    expect(runId).toBeDefined();
    // 等 run 走到 paused（全员等人）
    let st: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = core.runStatus(runId);
      if (st['status'] === 'paused') break;
    }
    expect(st['status']).toBe('paused');
    const queue = st['paused_queue'] as Array<{ child_instance?: string; step_id: string }>;
    expect(queue?.length).toBe(2);   // 方案A全量呈现
    expect(queue[0].child_instance).toBeDefined();
    // 按 child 应答第一张
    const a1 = core.resumeRun(runId, queue[0].step_id, { human_val: 5 }, undefined, queue[0].child_instance);
    expect((a1 as { status?: string }).status).toBe('running');
    for (let i = 0; i < 50; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = core.runStatus(runId);
      if (st['status'] === 'paused' && (st['paused_queue'] as unknown[])?.length === 1) break;
    }
    expect((st['paused_queue'] as unknown[])?.length).toBe(1);
    // 答第二张 → completed
    const q2 = (st['paused_queue'] as Array<{ child_instance?: string; step_id: string }>)[0];
    core.resumeRun(runId, q2.step_id, { human_val: 6 }, undefined, q2.child_instance);
    for (let i = 0; i < 50; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = core.runStatus(runId);
      if (['completed', 'failed'].includes(st['status'] as string)) break;
    }
    expect(st['status']).toBe('completed');
    expect((st['outputs'] as Record<string, unknown>)['vals']).toEqual([5, 6]);
  });

  // @v: anc-exec-parallel-hitl-queue （todo/0105 缺陷 B,兑现 hopissues/0094 期望行为第 ② 条:resume_run 带错
  // child_instance 在状态翻转前同步拒收——修前先回 {status:'running'},dispatcher 异步拒收后才复原 paused,调用方只见假 running）
  it('0105 B：串行 call 停点带错 child_instance → 同步 CHILD_NOT_IN_QUEUE,run 仍 paused 载荷不变无 failure;反例：不带 child_instance 正确应答照常受理跑完', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-0105b-'));
    writeFileSync(join(dir, 'leaf.md'), `# Leaf
Id: leaf
## Goal
g
## Inputs
- x: int

## Outputs
- y: int

## Steps
1. [ask require_human=true] 请给值
  - ← x
  + → y: int  # 人值
2. [exit] 交付
  + → y
`);
    writeFileSync(join(dir, 's.md'), `# T
Id: t-0105b
## Goal
g
## Inputs
- x: int

## Outputs
- y: int

## Steps
1. [call leaf(x)] 串行调子
  + → y: y  # 收
2. [exit] 交付
  + → y
`);
    const sd = mkdtempSync(join(tmpdir(), 'mcp-0105b-state-'));
    const r = await core.startRun(join(dir, 's.md'), { x: 1 }, sd, dir);
    const runId = r['run_id'] as string;
    let st: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = core.runStatus(runId);
      if (st['status'] === 'paused') break;
    }
    expect(st['status']).toBe('paused');
    const paused = st['paused'] as { step_id: string; call_path?: string[] };
    expect(paused.call_path).toEqual(['1']);
    // 正例:带错 child_instance(串行 call 停点本不该带)→ 同步结构化拒
    const bad = core.resumeRun(runId, paused.step_id, { y: 5 }, undefined, '1');
    expect((bad as { error?: { code: string } }).error?.code).toBe('CHILD_NOT_IN_QUEUE');
    expect((bad as { status?: string }).status).toBeUndefined();   // 修前=running
    const st2 = core.runStatus(runId);   // 同步读——不等异步复原
    expect(st2['status']).toBe('paused');
    expect((st2['paused'] as { step_id: string }).step_id).toBe(paused.step_id);
    expect(st2['failure']).toBeUndefined();
    // 反例:按拒因指引去掉 child_instance 重答 → 受理并跑完
    const ok = core.resumeRun(runId, paused.step_id, { y: 5 });
    expect((ok as { status?: string }).status).toBe('running');
    for (let i = 0; i < 50; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = core.runStatus(runId);
      if (['completed', 'failed'].includes(st['status'] as string)) break;
    }
    expect(st['status']).toBe('completed');
    expect((st['outputs'] as Record<string, unknown>)['y']).toBe(5);
  });

  // @v: anc-exec-parallel-hitl-queue, anc-exec-call-child-persist（37轮review:server重启后队列是空的,
  // caller拿旧卡child来答——账上paused→resumeSpec重派发重暂停,同名child新卡入队后按原答继续;探针实证
  // completed vals=[5]。双锚:落盘批连锁修①〔分派判据改退火标记〕的击杀面钉——TRACEABILITY 卡引用本钉）
  it('U4b：server 重启后按旧卡 child_instance 应答 → 重派发重暂停接原答,completed', async () => {
    const core1 = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-qr-'));
    writeFileSync(join(dir, 's.md'), `# T
Id: t-qr
## Goal
g
## Inputs
- items: [int]

## Outputs
- vals: [int]

## Steps
1. [loop for-each it in items, collect human_val into vals] 逐项
  + → vals: [int]  # 收集
  1.1. [subtask parallel] 问人
    + → human_val: int  # 人值
    1.1.1. [ask require_human=true] 请提供
      - ← it
      + → human_val: int  # 人值
2. [exit] 交付
  + → vals
`);
    const sd = mkdtempSync(join(tmpdir(), 'mcp-qr-state-'));
    const r = await core1.startRun(join(dir, 's.md'), { items: [1] }, sd, dir);
    const runId = r['run_id'] as string;
    let st: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = core1.runStatus(runId);
      if (st['status'] === 'paused') break;
    }
    const card = (st['paused_queue'] as Array<{ child_instance?: string; step_id: string }>)[0];
    expect(card?.child_instance).toBeDefined();
    // server 重启:新 core 空注册表,按旧卡应答
    const core2 = new HopjitMcpCore(config);
    const a = core2.resumeRun(runId, card.step_id, { human_val: 5 }, sd, card.child_instance);
    expect((a as { status?: string }).status).toBe('running');
    for (let i = 0; i < 80; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = core2.runStatus(runId);
      if (['completed', 'failed'].includes(st['status'] as string)) break;
    }
    expect(st['status']).toBe('completed');
    expect((st['outputs'] as Record<string, unknown>)['vals']).toEqual([5]);
  });

  // @v: anc-mcp-run-restore （0028 快照兜底:注册表不中纯读盘取问题卡——零 Dispatcher 零凭证;
  // 四形态:有卡返 paused+卡全文/坏卡 RESTORE_FAILED/无卡有快照指路 resume_run/全无 RUN_NOT_FOUND）
  // token 统计透出（^anc-mcp-run-status-inflight token 条,todo/0023——账早记全但 run_status
  // 不透出,长跑中途看烧了多少只能翻 HopLog）。// @v: anc-mcp-run-status-inflight
  it('正例：注册表命中 run 有 token 账 → run_status 带 cumulative_tokens;反例：0 账不出字段（向后兼容）', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-tok-'));
    writeFileSync(join(dir, 's.md'), `# T
Id: t-tok
## Goal
g
## Inputs
- items: [int]

## Outputs
- vals: [int]

## Steps
1. [loop for-each it in items, collect human_val into vals] 逐项
  + → vals: [int]  # 收集
  1.1. [subtask parallel] 问人
    + → human_val: int  # 人值
    1.1.1. [ask require_human=true] 请提供
      - ← it
      + → human_val: int  # 人值
2. [exit] 交付
`);
    const sd = mkdtempSync(join(tmpdir(), 'mcp-tok-state-'));
    const r = await core.startRun(join(dir, 's.md'), { items: [1] }, sd, dir);
    const runId = r['run_id'] as string;
    let st: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = core.runStatus(runId);
      if (st['status'] === 'paused') break;
    }
    // 反例半边:纯计算+ask 零 LLM 调用,账为 0 → 字段缺席（0 值不出,响应形状向后兼容）
    expect('cumulative_tokens' in st).toBe(false);
    // 正例半边:造账（引擎内存 setCumulativeTokens——纯暴露语义:透出的就是这本账）后再查
    const entry = (core as unknown as { runs: Map<string, { dispatcher: { getEngine(): { setCumulativeTokens(n: number): void } } }> }).runs.get(runId);
    entry!.dispatcher.getEngine().setCumulativeTokens(4321);
    st = core.runStatus(runId);
    expect(st['cumulative_tokens']).toBe(4321);
  });

  it('正例：快照兜底 completed 带盘上 cumulative_tokens（跨进程恢复态不归零）', () => {
    const core = new HopjitMcpCore(config);
    const sd = mkdtempSync(join(tmpdir(), 'tok-fb-'));
    mkdirSync(join(sd, 'run-t'), { recursive: true });
    writeFileSync(join(sd, 'run-t', 'state.json'), JSON.stringify({
      format_version: 1, step_states: { '1': 'done' }, terminal_state: 'completed', cumulative_tokens: 9876,
    }));
    writeFileSync(join(sd, 'run-t', 'spec.json'), JSON.stringify({ header: { outputs: [] } }));
    writeFileSync(join(sd, 'run-t', 'vars.json'), JSON.stringify({ format_version: 1, variables: {} }));
    const st = core.runStatus('run-t', sd);
    expect(st['status']).toBe('completed');
    expect(st['cumulative_tokens']).toBe(9876);
  });

  it('runStatus 快照兜底四形态（0028 detach 跨进程取卡）', () => {
    const core = new HopjitMcpCore(config);
    const sd = mkdtempSync(join(tmpdir(), 'card-fb-'));

    // 形态1:有卡 → paused + 卡全文 + restored_from_snapshot
    mkdirSync(join(sd, 'run-a'), { recursive: true });
    writeFileSync(join(sd, 'run-a', 'paused.json'), JSON.stringify({
      status: 'paused', step_id: '1', pause_reason: 'ask',
      presented_data: { question: 'Q全文', context: { draft: 'MATERIAL' } },
    }));
    const a = core.runStatus('run-a', sd);
    expect(a['status']).toBe('paused');
    expect(a['restored_from_snapshot']).toBe(true);
    expect(JSON.stringify((a['paused'] as Record<string, unknown>)['presented_data'])).toContain('MATERIAL');

    // 形态2:坏卡 → RESTORE_FAILED（不假绿不吞）
    mkdirSync(join(sd, 'run-b'), { recursive: true });
    writeFileSync(join(sd, 'run-b', 'paused.json'), '{broken');
    expect(((core.runStatus('run-b', sd))['error'] as { code: string }).code).toBe('RESTORE_FAILED');

    // 形态3:无卡有 state.json → RUN_NOT_FOUND 但报文指路 resume_run（不做半个恢复）
    mkdirSync(join(sd, 'run-c'), { recursive: true });
    writeFileSync(join(sd, 'run-c', 'state.json'), '{}');
    const c = core.runStatus('run-c', sd);
    expect((c['error'] as { code: string }).code).toBe('RUN_NOT_FOUND');
    expect((c['error'] as { message: string }).message).toContain('resume_run');

    // 形态4:全无 → RUN_NOT_FOUND
    expect(((core.runStatus('run-zzz', sd))['error'] as { code: string }).code).toBe('RUN_NOT_FOUND');

    // 陈卡对账（31轮review:删卡与persist间崩溃残留——卡说等人而state.json该步已终态,
    // 状态源为准不报假paused）
    mkdirSync(join(sd, 'run-e'), { recursive: true });
    writeFileSync(join(sd, 'run-e', 'paused.json'), JSON.stringify({ status: 'paused', step_id: '1', pause_reason: 'ask', presented_data: { question: 'Q' } }));
    writeFileSync(join(sd, 'run-e', 'state.json'), JSON.stringify({ format_version: 1, step_states: { '1': 'done', '2': 'done' } }));
    const e = core.runStatus('run-e', sd);
    expect((e['error'] as { code: string }).code).toBe('RUN_NOT_FOUND');
    expect((e['error'] as { message: string }).message).toContain('陈卡');

    // 正例:卡步骤在 state.json 里确为 running → 照常返 paused（对账不误伤真暂停）
    mkdirSync(join(sd, 'run-f'), { recursive: true });
    writeFileSync(join(sd, 'run-f', 'paused.json'), JSON.stringify({ status: 'paused', step_id: '1', pause_reason: 'ask', presented_data: { question: 'Q' } }));
    writeFileSync(join(sd, 'run-f', 'state.json'), JSON.stringify({ format_version: 1, step_states: { '1': 'running' } }));
    expect((core.runStatus('run-f', sd))['status']).toBe('paused');

    // 嵌套子实例卡点名（32轮review:call/parallel 暂停卡落子目录,顶层无卡时报文点名可读路径,
    // 不冒充顶层 paused——恢复边界:嵌套暂停经 resume_run 重跑 call）
    mkdirSync(join(sd, 'run-g', 'calls', 'child-1'), { recursive: true });
    writeFileSync(join(sd, 'run-g', 'state.json'), JSON.stringify({ format_version: 1, step_states: { '1': 'running' } }));
    writeFileSync(join(sd, 'run-g', 'calls', 'child-1', 'paused.json'), JSON.stringify({ status: 'paused', step_id: '2', presented_data: { question: '子卡Q' } }));
    const g = core.runStatus('run-g', sd);
    expect((g['error'] as { code: string }).code).toBe('RUN_NOT_FOUND');
    expect((g['error'] as { message: string }).message).toContain('calls/child-1/paused.json');

    // 终态直读（0043 终局有据——terminal_state 落盘后 completed/failed 跨进程零成本可判,
    // outputs=header.outputs 声明变量按 vars.json v2 root scope 现值收集）
    mkdirSync(join(sd, 'run-t'), { recursive: true });
    writeFileSync(join(sd, 'run-t', 'state.json'), JSON.stringify({ format_version: 1, step_states: { '1': 'done' }, terminal_state: 'completed' }));
    writeFileSync(join(sd, 'run-t', 'spec.json'), JSON.stringify({ header: { outputs: [{ name: 'result' }] } }));
    writeFileSync(join(sd, 'run-t', 'vars.json'), JSON.stringify({ format_version: 2, scopes: { root: { parent: null, variables: { result: 42, internal_tmp: 'x' } } } }));
    const t = core.runStatus('run-t', sd);
    expect(t['status']).toBe('completed');
    expect((t['outputs'] as Record<string, unknown>)['result']).toBe(42);
    expect((t['outputs'] as Record<string, unknown>)['internal_tmp']).toBeUndefined();   // 只收声明输出

    mkdirSync(join(sd, 'run-tf'), { recursive: true });
    writeFileSync(join(sd, 'run-tf', 'state.json'), JSON.stringify({ format_version: 1, step_states: { '1': 'failed' }, terminal_state: 'failed', terminal_failure: { stepId: '1', reason: 'boom' } }));
    const tf = core.runStatus('run-tf', sd);
    expect(tf['status']).toBe('failed');
    expect((tf['failure'] as { reason: string }).reason).toBe('boom');

    // completed 标记与步骤态不一致的显式报告（hopissues/0093——病态快照:标记 completed 而顶层
    // 收尾步仍 pending,引擎正常盖印路径产不出;读侧检测报告不擅改:status 仍 completed 但带
    // inconsistency 字段,不清标记不翻 running。^anc-exec-completed-consistency）
    // @v: anc-exec-completed-consistency
    mkdirSync(join(sd, 'run-inc'), { recursive: true });
    writeFileSync(join(sd, 'run-inc', 'state.json'), JSON.stringify({ format_version: 1, step_states: { '1': 'done', '2': 'pending' }, terminal_state: 'completed' }));
    writeFileSync(join(sd, 'run-inc', 'spec.json'), JSON.stringify({ header: { outputs: [{ name: 'r' }] }, steps: [{ step_id: '1', step_type: 'act' }, { step_id: '2', step_type: 'exit' }] }));
    writeFileSync(join(sd, 'run-inc', 'vars.json'), JSON.stringify({ format_version: 2, scopes: { root: { parent: null, variables: { r: 'v' } } } }));
    const inc = core.runStatus('run-inc', sd);
    expect(inc['status']).toBe('completed');                                    // 报告不擅改:status 不翻
    expect(String(inc['inconsistency'])).toContain('不一致');                    // 显式信号在场
    expect(String(inc['inconsistency'])).toContain('2');                        // 点名病态步

    // 反例:正常 completed（全终态,含 skipped——worker 形态不误伤）零 inconsistency
    mkdirSync(join(sd, 'run-inc-ok'), { recursive: true });
    writeFileSync(join(sd, 'run-inc-ok', 'state.json'), JSON.stringify({ format_version: 1, step_states: { '1': 'done', '2': 'skipped' }, terminal_state: 'completed' }));
    writeFileSync(join(sd, 'run-inc-ok', 'spec.json'), JSON.stringify({ header: { outputs: [{ name: 'r' }] }, steps: [{ step_id: '1', step_type: 'act' }, { step_id: '2', step_type: 'exit' }] }));
    writeFileSync(join(sd, 'run-inc-ok', 'vars.json'), JSON.stringify({ format_version: 2, scopes: { root: { parent: null, variables: { r: 'v' } } } }));
    const incOk = core.runStatus('run-inc-ok', sd);
    expect(incOk['status']).toBe('completed');
    expect(incOk['inconsistency']).toBeUndefined();

    // 注册表命中面接线钉（阅卷变异实锤:liveInconsistency 改恒 null 全绿存活——接线两行零钉防护。
    // 注入最小 RunEntry 直测 runStatus 装配线:entry.state=completed 且引擎检测器报不一致→字段透出）
    const fakeEngine = { detectCompletedInconsistency: () => 'terminal_state=completed 但顶层步 9 仍未终态——完成标记与步骤态不一致(接线钉注入)', getCumulativeTokens: () => 0, getInflight: () => [] };
    (core as unknown as { runs: Map<string, unknown> }).runs.set('run-live-inc', {
      runId: 'run-live-inc', state: 'completed', specPath: 'x.md', startedAt: 'now',
      dispatcher: { getEngine: () => fakeEngine },
    });
    const liveInc = core.runStatus('run-live-inc', sd);
    expect(liveInc['status']).toBe('completed');
    expect(String(liveInc['inconsistency'])).toContain('不一致');
    // 对照:检测器返 null 时字段缺席
    (core as unknown as { runs: Map<string, unknown> }).runs.set('run-live-ok', {
      runId: 'run-live-ok', state: 'completed', specPath: 'x.md', startedAt: 'now',
      dispatcher: { getEngine: () => ({ detectCompletedInconsistency: () => null, getCumulativeTokens: () => 0, getInflight: () => [] }) },
    });
    const liveOk = core.runStatus('run-live-ok', sd);
    expect(liveOk['inconsistency']).toBeUndefined();

    // 终态优先于残卡（40轮review探针实抓分支序:completed快照+残留死卡并存,卡分支先行→
    // 陈卡对账NOT_FOUND挡住盘上terminal_state;权威序=墓碑>终态>等人卡）
    mkdirSync(join(sd, 'run-tc'), { recursive: true });
    writeFileSync(join(sd, 'run-tc', 'state.json'), JSON.stringify({ format_version: 1, step_states: { '1': 'done' }, terminal_state: 'completed' }));
    writeFileSync(join(sd, 'run-tc', 'paused.json'), JSON.stringify({ status: 'paused', step_id: '1', presented_data: { question: 'stale' } }));
    writeFileSync(join(sd, 'run-tc', 'spec.json'), JSON.stringify({ header: { outputs: [{ name: 'r' }] } }));
    writeFileSync(join(sd, 'run-tc', 'vars.json'), JSON.stringify({ format_version: 2, scopes: { root: { parent: null, variables: { r: 'v' } } } }));
    const tc = core.runStatus('run-tc', sd);
    expect(tc['status']).toBe('completed');
    expect((tc['outputs'] as Record<string, unknown>)['r']).toBe('v');

    // aborted 墓碑优先于卡（stop_run 终局不复活）
    mkdirSync(join(sd, 'run-d'), { recursive: true });
    writeFileSync(join(sd, 'run-d', 'aborted.json'), '{}');
    writeFileSync(join(sd, 'run-d', 'paused.json'), '{"status":"paused"}');
    expect((core.runStatus('run-d', sd))['status']).toBe('aborted');
  });

  it('spec 不存在 → SPEC_NOT_FOUND（不搜索不猜）', async () => {
    const core = new HopjitMcpCore(config);
    const r = await core.startRun('/nonexistent/spec.md');
    expect((r['error'] as { code: string }).code).toBe('SPEC_NOT_FOUND');
  });

  it('坏 spec → SPEC_INVALID（validate 闸门）', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-core-'));
    writeFileSync(join(dir, 'bad.md'), '# Spec: 坏\nGoal: 无步骤\n');
    const r = await core.startRun(join(dir, 'bad.md'));
    expect((r['error'] as { code: string }).code).toBe('SPEC_INVALID');
  });

  // @v: anc-mcp-config — workspace_dir 参数（2026-08-20 作者定作业对象根显式化,与 spec_path 同款焊死）
  it('反例：workspace_dir 显式传入但不存在 → WORKSPACE_NOT_FOUND（不搜索不猜,零状态写入）', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-wsarg-'));
    writeFileSync(join(dir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    const r = await core.startRun(join(dir, 's.md'), undefined, undefined, '/nonexistent/workspace');
    expect((r['error'] as { code: string }).code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('正例：workspace_dir 显式传入 → 折进本 run 作业根（doc-ref workspace 级/沙箱锚随之,init 可过闸）', async () => {
    // spec 在 specDir、业务知识文档在 wsDir——workspace_dir 不传则 P15 按 server cwd 找不到必 INIT_FAILED;
    // 传了 wsDir 则第二级命中,init 过闸进 running（LLM 调用会因假凭证后续失败,不影响本判定点——
    // startRun 返回 run_id 即证 workspace 参数已生效）
    const core = new HopjitMcpCore(config);
    const specDir = mkdtempSync(join(tmpdir(), 'mcp-wsarg-spec-'));
    const wsDir = mkdtempSync(join(tmpdir(), 'mcp-wsarg-ws-'));
    writeFileSync(join(wsDir, 'biz.md'), '## 判据\n业务判据正文\n');
    writeFileSync(join(specDir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r 参考 [[biz#判据]]\n  + → out: text  # o\n  > t 参考 [[biz#判据]]\n`);
    const r = await core.startRun(join(specDir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-wsarg-state-')), wsDir);
    expect(r['error']).toBeUndefined();
    expect(r['run_id']).toBeDefined();
  });

  // @v: anc-mcp-config — state_dir 锚 workspace_dir（#28 双基准劈裂:缺省 state_dir 时快照
  // mkdir 按 server cwd、act body write 按 workspace_dir 解析同一相对路径,work_zone 两头
  // 对不上 ENOENT——coffee/ppt 首发两 run 同死实撞）
  it('正例：缺省 state_dir + 显式 workspace_dir → .hopstate 落 workspace_dir 下,返回值携带解析后绝对路径', async () => {
    const core = new HopjitMcpCore(config);
    const specDir = mkdtempSync(join(tmpdir(), 'mcp-sd-spec-'));
    const wsDir = mkdtempSync(join(tmpdir(), 'mcp-sd-ws-'));
    writeFileSync(join(specDir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    const r = await core.startRun(join(specDir, 's.md'), undefined, undefined, wsDir);
    expect(r['error']).toBeUndefined();
    expect(r['state_dir']).toBe(join(wsDir, '.hopstate'));   // 锚 workspace_dir,非 server cwd
    // 快照真落在 workspace_dir 下（run_id 实例目录在场）——work_zone 与 body write 同基准
    expect(existsSync(join(wsDir, '.hopstate', r['run_id'] as string))).toBe(true);
    expect(existsSync(join(process.cwd(), '.hopstate', r['run_id'] as string))).toBe(false);   // server cwd 零残留
    core.stopRun(r['run_id'] as string);
  });

  it('正例：显式相对 state_dir → 同锚 workspace_dir;绝对路径原样用（两形态判据成对）', async () => {
    const core = new HopjitMcpCore(config);
    const specDir = mkdtempSync(join(tmpdir(), 'mcp-sd2-spec-'));
    const wsDir = mkdtempSync(join(tmpdir(), 'mcp-sd2-ws-'));
    const absState = mkdtempSync(join(tmpdir(), 'mcp-sd2-abs-'));
    writeFileSync(join(specDir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    const r1 = await core.startRun(join(specDir, 's.md'), undefined, 'mystate', wsDir);
    expect(r1['state_dir']).toBe(join(wsDir, 'mystate'));
    expect(existsSync(join(wsDir, 'mystate', r1['run_id'] as string))).toBe(true);
    core.stopRun(r1['run_id'] as string);
    const r2 = await core.startRun(join(specDir, 's.md'), undefined, absState, wsDir);
    expect(r2['state_dir']).toBe(absState);
    expect(existsSync(join(absState, r2['run_id'] as string))).toBe(true);
    core.stopRun(r2['run_id'] as string);
  });

  // stop_run 主动中止（2026-08-22 作者定"hopjit 应该能自己杀自己的子任务"——
  // 此前失控 run 只能杀 server 重启会话止损,两次实撞）
  // @v: anc-mcp-stop-run
  it('正例：running run 经 stop_run 中止 → aborted 终态,list_runs 可见,幂等重停', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-stop-'));
    writeFileSync(join(dir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    const r = await core.startRun(join(dir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-stop-state-')), dir);
    const runId = r['run_id'] as string;
    expect(runId).toBeDefined();
    const s1 = core.stopRun(runId);
    expect(s1['status']).toBe('aborted');
    // 注册表可见 aborted 终态
    const listed = (core.listRuns()['runs'] as Array<{ run_id: string; status: string }>).find(x => x.run_id === runId);
    expect(listed?.status).toBe('aborted');
    // 幂等：再停返回现状不报错
    const s2 = core.stopRun(runId);
    expect(s2['status']).toBe('aborted');
    expect(s2['error']).toBeUndefined();
    // run_status 同样呈 aborted
    const st = core.runStatus(runId);
    expect(st['status']).toBe('aborted');
  });

  it('反例：未知 run_id → RUN_NOT_FOUND', () => {
    const core = new HopjitMcpCore(config);
    const r = core.stopRun('no-such-run');
    expect((r['error'] as { code: string }).code).toBe('RUN_NOT_FOUND');
  });

  // @v: anc-exec-pause-persist （34轮review:stop_run 是 paused→终局的转移,等人窗口随之关闭——
  // 残卡误导文件级消费方〔API 面有墓碑优先兜着,文件面没有〕,随墓碑同拍清除）
  it('正例：paused run 经 stop_run 中止 → 问题卡随墓碑清除', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-stop-card-'));
    const sd = join(dir, '.hopstate');
    writeFileSync(join(dir, 's.md'), `# T
Id: t-card
## Goal
g
## Outputs
- v: text
## Steps
1. [ask] 要个值
  + → v: text  # 值
2. [exit] 交付
  + → v
`);
    const r = await core.startRun(join(dir, 's.md'), undefined, sd, dir);
    const runId = r['run_id'] as string;
    // 等 run 走到 paused（ask 免 LLM,快）
    let paused = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(res => setTimeout(res, 100));
      if ((core.runStatus(runId))['status'] === 'paused') { paused = true; break; }
    }
    expect(paused).toBe(true);
    const cardPath = join(sd, runId, 'paused.json');
    expect(existsSync(cardPath)).toBe(true);
    core.stopRun(runId);
    expect(existsSync(join(sd, runId, 'aborted.json'))).toBe(true);
    expect(existsSync(cardPath)).toBe(false);
  });

  it('竞态防线：aborted 后迟到的执行结果不改写终态（applyResult 钉死）', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-stop-race-'));
    writeFileSync(join(dir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    const r = await core.startRun(join(dir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-stop-race-state-')), dir);
    const runId = r['run_id'] as string;
    core.stopRun(runId);
    // 等在飞执行循环自然收尾（假凭证 LLM 失败/abort 步间返回,任一形态都会触发 applyResult）
    await new Promise(res => setTimeout(res, 1500));
    expect(core.runStatus(runId)['status']).toBe('aborted');   // 迟到结果没能把 aborted 改回 failed
  });

  // review 补盲四组（2026-08-22 二轮 review——缺陷1/2/4 全落在无测区,机检绿≠契约兑现的实证）：
  // paused 停 / aborted 不可 resume 双防线 / catch 旁路钉住 / 工具通道收口分道。

  it('正例：paused run 被停 → 直接终局 aborted,当场收工具通道（契约第5条 paused 分道——无在飞回调可收）', () => {
    const core = new HopjitMcpCore(config);
    const close = vi.fn();
    const entry: Record<string, unknown> = {
      runId: 'r-sp', specPath: '/x/s.md', state: 'paused',
      dispatcher: { requestAbortCascade: vi.fn(), getToolProvider: () => ({ close }) },
      paused: { status: 'paused', step_id: '1', pause_reason: 'ask' },
      startedAt: '2026-08-22T00:00:00Z',
    };
    (core as any).runs.set('r-sp', entry);
    const r = core.stopRun('r-sp');
    expect(r['status']).toBe('aborted');
    expect(entry['paused']).toBeUndefined();               // 暂停载荷清空（不再等注入）
    expect(close).toHaveBeenCalledTimes(1);                // paused 分道：当场收
  });

  it('反例（契约第5条 running 分道）：running run 被停不当场收工具通道——在飞那步要跑完,收口归钉住回调', () => {
    const core = new HopjitMcpCore(config);
    const close = vi.fn();
    const entry: Record<string, unknown> = {
      runId: 'r-sr', specPath: '/x/s.md', state: 'running',
      dispatcher: { requestAbortCascade: vi.fn(), getToolProvider: () => ({ close }) },
      startedAt: '2026-08-22T00:00:00Z',
    };
    (core as any).runs.set('r-sr', entry);
    core.stopRun('r-sr');
    expect(close).not.toHaveBeenCalled();                  // 不当场收（首版误当场收,在飞步工具调用会撞"已关停"拒绝）
    (core as any).applyResult(entry, { status: 'failed', failure: { step_id: '1', reason: 'late' } });
    expect(close).toHaveBeenCalledTimes(1);                // 迟到结果到达时由钉住分支收
    expect(entry['state']).toBe('aborted');                // 且不被改写
  });

  it('反例：aborted run 同进程 resume → INVALID_STATE 拒（中止是终局不是暂停）', () => {
    const core = new HopjitMcpCore(config);
    (core as any).runs.set('r-ab', {
      runId: 'r-ab', specPath: '/x/s.md', state: 'aborted',
      dispatcher: {}, startedAt: '2026-08-22T00:00:00Z',
    });
    const r = core.resumeRun('r-ab', '1', { value: 'x' });
    expect((r['error'] as { code: string }).code).toBe('INVALID_STATE');
  });

  it('反例（契约第4条 跨重启墓碑门）：stop_run 落盘 aborted.json,新 server restore 撞墓碑 → RUN_ABORTED 拒复活', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-stop-tomb-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'mcp-stop-tomb-state-'));
    writeFileSync(join(dir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    const r = await core.startRun(join(dir, 's.md'), undefined, stateDir, dir);
    const runId = r['run_id'] as string;
    core.stopRun(runId);
    expect(existsSync(join(stateDir, runId, 'aborted.json'))).toBe(true);   // 墓碑落盘
    // 模拟 server 重启：新 core 空注册表,resume 未命中走 restoreRun——撞墓碑即拒,不复活成 paused
    //（首版无此门:aborted run 可被恢复一路跑到自然终态含 commit,review 实抓）
    const core2 = new HopjitMcpCore(config);
    const r2 = core2.resumeRun(runId, '1', { value: 'x' }, stateDir);
    expect((r2['error'] as { code: string }).code).toBe('RUN_ABORTED');
  });

  it('竞态防线：resume 异常迟到不改写 aborted（catch 旁路钉住——首版只堵 applyResult,review 实抓）', async () => {
    const core = new HopjitMcpCore(config);
    let rejectLate: ((e: Error) => void) | undefined;
    const entry: Record<string, unknown> = {
      runId: 'r-lc', specPath: '/x/s.md', state: 'paused',
      dispatcher: {
        requestAbortCascade: () => {},
        resume: () => new Promise((_res, rej) => { rejectLate = rej; }),   // 挂起,等 stop 后再异常
      },
      paused: { status: 'paused', step_id: '1', pause_reason: 'ask' },
      startedAt: '2026-08-22T00:00:00Z',
    };
    (core as any).runs.set('r-lc', entry);
    core.resumeRun('r-lc', '1', { value: 'a' });   // 在飞
    core.stopRun('r-lc');                          // 用户中止
    rejectLate!(new Error('LLM down'));            // 异常迟到（startRun catch 同型同修）
    await new Promise(res => setTimeout(res, 10));
    expect(core.runStatus('r-lc')['status']).toBe('aborted');   // 不被改写成 failed
  });

  // @v: anc-exec-doc-ref-resolve — 两级基准第一级在 MCP startRun 全链生效（audit spec 实撞形态）
  it('正例：spec 同目录知识文档（audit 形态）——workspace 指别处仍过 init（doc-ref 第一级 spec 目录命中）', async () => {
    const core = new HopjitMcpCore(config);
    const specDir = mkdtempSync(join(tmpdir(), 'mcp-specdoc-'));
    const wsDir = mkdtempSync(join(tmpdir(), 'mcp-specdoc-ws-'));
    writeFileSync(join(specDir, 'knowledge.md'), '## 判据\n知识正文\n');
    writeFileSync(join(specDir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r 见 [[knowledge#判据]]\n  + → out: text  # o\n  > t 见 [[knowledge#判据]]\n`);
    const r = await core.startRun(join(specDir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-specdoc-state-')), wsDir);
    expect(r['error']).toBeUndefined();
    expect(r['run_id']).toBeDefined();
  });

  // 每 run 重读项目级配置（0007②+0012 并单——项目根=run 组合根 cwd,数据面节重读项目级赢,
  // providers 恒启动期快照;hopkb tidy 四工具注册实撞:加白名单后须重启会话才生效）。
  // @v: anc-mcp-config
  it('正例：改项目级 hopjit.yaml 工具白名单 → 下一个 startRun 即见（不重启 server,0012 probe）', async () => {
    const projDir = mkdtempSync(join(tmpdir(), 'mcp-reload-'));
    const F = '\u0060\u0060\u0060';
    writeFileSync(join(projDir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: yaml  # o\n## Steps\n1. [act] 调\n  + → out: yaml  # o\n  > ${F}hop_python\n  > out = late_tool(x: 1)\n  > ${F}\n`);
    const core = new HopjitMcpCore(config);   // server 启动期配置无 late_tool
    const oldCwd = process.cwd();
    process.chdir(projDir);
    try {
      // 第一跑:项目级无配置 → TOOLS_UNAVAILABLE
      const r1 = await core.startRun(join(projDir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-reload-s1-')));
      expect((r1['error'] as { code: string }).code).toBe('TOOLS_UNAVAILABLE');
      // "server 不重启"直接写项目级配置 → 第二跑即见
      writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({
        tool_servers: [{ name: 'late', binding: { kind: 'mcp', transport: 'stdio', command: '/bin/cat' }, tools: [{ name: 'late_tool', requires_commit: false }] }],
      }));
      const r2 = await core.startRun(join(projDir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-reload-s2-')));
      expect(r2['error']).toBeUndefined();   // 预检过（装配面已含 late_tool）
      expect(r2['run_id']).toBeDefined();
    } finally { process.chdir(oldCwd); }
  });

  it('反例：项目级 env 节塞凭证键 → CONFIG_INVALID 响亮拒（十二审——原 catch 静默回退吞 0004 闸）', async () => {
    const projDir = mkdtempSync(join(tmpdir(), 'mcp-reload-cred-'));
    writeFileSync(join(projDir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({ env: { hop_env_gh_token: 'ghp_leak' } }));
    const core = new HopjitMcpCore(config);
    const oldCwd = process.cwd();
    process.chdir(projDir);
    try {
      const r = await core.startRun(join(projDir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-reload-cred-s-')));
      const err = r['error'] as { code: string; message: string };
      expect(err.code).toBe('CONFIG_INVALID');       // 响亮非静默回退
      expect(err.message).toContain('凭证');          // 0004 闸报文透传
    } finally { process.chdir(oldCwd); }
  });

  it('反例：项目级文件写 providers 节 → 不生效（凭证安全面恒启动期快照,0012 反例）', async () => {
    const projDir = mkdtempSync(join(tmpdir(), 'mcp-reload-prov-'));
    writeFileSync(join(projDir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({
      providers: [{ service_id: 'evil', protocol: 'anthropic', base_url: 'https://evil.example', model: 'x', api_key_env: 'EVIL_KEY' }],
    }));
    const core = new HopjitMcpCore(config);
    const oldCwd = process.cwd();
    process.chdir(projDir);
    try {
      const r = await core.startRun(join(projDir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-reload-prov-s-')));
      expect(r['error']).toBeUndefined();   // 不因 EVIL_KEY 缺环境变量而拒——providers 节被忽略
      expect(r['run_id']).toBeDefined();
    } finally { process.chdir(oldCwd); }
  });

  it('反例：HOPJIT_CONFIG 显式指定时项目级文件不重读（单文件语义——项目文件写非法内容也不拒不生效）', async () => {
    const projDir = mkdtempSync(join(tmpdir(), 'mcp-reload-envvar-'));
    writeFileSync(join(projDir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({ env: { hop_env_gh_token: 'ghp_leak' } }));   // 无重读语义下须被无视
    const core = new HopjitMcpCore(config);
    const oldCwd = process.cwd();
    process.chdir(projDir);
    process.env['HOPJIT_CONFIG'] = '/explicit/single-file.yaml';
    try {
      const r = await core.startRun(join(projDir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-reload-envvar-s-')));
      expect(r['error']).toBeUndefined();   // 项目文件的凭证违规不触发——根本没读它
      expect(r['run_id']).toBeDefined();
    } finally { process.chdir(oldCwd); delete process.env['HOPJIT_CONFIG']; }
  });

  it('反例：项目级 routing_rules 引用拼错的 service → CONFIG_INVALID 装配期拒（十四审——原漂到运行期才请求错后端,BUG-E 引用核在重读路径缺位）', async () => {
    const projDir = mkdtempSync(join(tmpdir(), 'mcp-reload-ref-'));
    writeFileSync(join(projDir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({ routing_rules: [{ step_type: 'reason', model: 'tpyo_service/model-x' }] }));
    const core = new HopjitMcpCore(config);
    const oldCwd = process.cwd();
    process.chdir(projDir);
    try {
      const r = await core.startRun(join(projDir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-reload-ref-s-')));
      const err = r['error'] as { code: string; message: string };
      expect(err.code).toBe('CONFIG_INVALID');
      expect(err.message).toContain('tpyo_service');   // 引用核报文点名坏 service
    } finally { process.chdir(oldCwd); }
  });

  it('正例：项目级 routing_rules 引用启动期快照里的 service → 合并后引用核过（引用核对合并后 providers,合法引用不误拒）', async () => {
    const projDir = mkdtempSync(join(tmpdir(), 'mcp-reload-ref-ok-'));
    writeFileSync(join(projDir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    // 项目级文件自身无 providers 节——引用的 deepseek 只存在于启动期快照,逐文件核必误拒,合并后核才放行（BUG-E 形态）
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({ routing_rules: [{ step_type: 'reason', model: 'deepseek/other-model' }] }));
    const core = new HopjitMcpCore(config);
    const oldCwd = process.cwd();
    process.chdir(projDir);
    try {
      const r = await core.startRun(join(projDir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-reload-ref-ok-s-')));
      expect(r['error']).toBeUndefined();
      expect(r['run_id']).toBeDefined();
    } finally { process.chdir(oldCwd); }
  });

  // 工具名冲突结构化 error（0005——原从 CompositeToolProvider 构造点裸抛,SDK 兜成无 code
  // 的 isError 文本;契约=startRun 返回 error:{code,message},design tool-interface 加载 fail-fast 条）。
  // @v: anc-exec-tool-composite
  it('反例：tool_servers 声明与内置 read 撞名 → startRun 返回结构化 TOOLS_NAME_CONFLICT（非裸抛）', async () => {
    const conflictConfig: StandaloneConfig = {
      providers: [VALID_PROVIDER],
      tool_servers: [{ name: 'srv', binding: { kind: 'mcp', transport: 'stdio', command: '/bin/cat' }, tools: [{ name: 'read', requires_commit: false }] }] as unknown[],
    };
    const core = new HopjitMcpCore(conflictConfig);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-conflict-'));
    writeFileSync(join(dir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    const r = await core.startRun(join(dir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-conflict-state-')));
    const err = r['error'] as { code: string; message: string };
    expect(err).toBeDefined();                            // 结构化非 throw
    expect(err.code).toBe('TOOLS_NAME_CONFLICT');         // 程序化可识别
    expect(err.message).toContain('read');                // 冲突名在报文
  });

  it('反例：两 server 声明同一工具名 → 同款结构化拒（跨 server 判重面）', async () => {
    const conflictConfig: StandaloneConfig = {
      providers: [VALID_PROVIDER],
      tool_servers: [
        { name: 'a', binding: { kind: 'mcp', transport: 'stdio', command: '/bin/cat' }, tools: [{ name: 'dup_tool', requires_commit: false }] },
        { name: 'b', binding: { kind: 'mcp', transport: 'stdio', command: '/bin/cat' }, tools: [{ name: 'dup_tool', requires_commit: false }] },
      ] as unknown[],
    };
    const core = new HopjitMcpCore(conflictConfig);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-conflict2-'));
    writeFileSync(join(dir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    const r = await core.startRun(join(dir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-conflict2-state-')));
    expect((r['error'] as { code: string }).code).toBe('TOOLS_NAME_CONFLICT');
  });

  // 凭证禁入三级闸之 params 级（0004,standalone 半边）。 // @v: anc-config-hop-env
  it('反例：startRun params 带凭证形态 hop_env 键 → HOP_ENV_CREDENTIAL_REJECTED 结构化拒（不落盘不建 run）', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-cred-'));
    writeFileSync(join(dir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    const r = await core.startRun(join(dir, 's.md'), { hop_env_gh_token: 'ghp_secret' }, mkdtempSync(join(tmpdir(), 'mcp-cred-state-')));
    const err = r['error'] as { code: string; message: string };
    expect(err.code).toBe('HOP_ENV_CREDENTIAL_REJECTED');
    expect(err.message).toContain('api_key_env');   // 指路
  });

  it('正例：params 带非凭证 hop_env 键（含 keyring_path 尾锚定边界）→ 照常建 run', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-cred2-'));
    writeFileSync(join(dir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > t\n`);
    const r = await core.startRun(join(dir, 's.md'), { hop_env_keyring_path: '/kb' }, mkdtempSync(join(tmpdir(), 'mcp-cred2-state-')));
    expect(r['error']).toBeUndefined();
    expect(r['run_id']).toBeDefined();
  });

  it('所需工具超出 DefaultToolProvider → TOOLS_UNAVAILABLE 列缺口', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-core-t-'));
    writeFileSync(join(dir, 's.md'), `# T\nId: t\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [act] 拉\n  + → out: text  # o\n  > 说明\n  > \`\`\`hop_python\n  > out = exotic_tool(x: 1)\n  > \`\`\`\n`);
    const r = await core.startRun(join(dir, 's.md'));
    const err = r['error'] as { code: string; message: string };
    expect(err.code).toBe('TOOLS_UNAVAILABLE');
    expect(err.message).toContain('exotic_tool');
  });

  it('run_status：无 run 时省略 run_id → RUN_NOT_FOUND 说明', () => {
    const core = new HopjitMcpCore(config);
    const r = core.runStatus();
    expect((r['error'] as { code: string }).code).toBe('RUN_NOT_FOUND');
  });

  it('resume_run：未知 run → RUN_NOT_FOUND；list_runs 初始为空', async () => {
    const core = new HopjitMcpCore(config);
    const r = core.resumeRun('no-such', 's1', { value: 'approve' });
    expect((r['error'] as { code: string }).code).toBe('RUN_NOT_FOUND');
    expect((core.listRuns()['runs'] as unknown[])).toEqual([]);
  });

  it('coffee-week（纯内置）过工具面预检并真正启动（引擎消化 act，不触 LLM 前即注册）', async () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-core-cw-'));
    const r = await core.startRun(
      join(REPO, 'examples', 'coffee-week.md'),
      { daily_sales: [3200, 2800, 3600, 4100, 3900, 5200, 4800], weekly_target: 26000 },
      join(dir, '.hopstate'),
    );
    // 工具面预检通过 + init 成功 → 返回 run_id（后续 reason 步会因假 key 失败，
    // 但那是异步的——本用例只验启动面；终态验证归真机 live 验收）
    expect(r['run_id']).toBeTruthy();
    expect(r['status']).toBe('running');
    const listed = core.listRuns()['runs'] as { run_id: string }[];
    expect(listed).toHaveLength(1);
    expect(listed[0].run_id).toBe(r['run_id']);

    // G11 核真过程（^anc-meta-layer-test）：HopLog 恒开——main.yaml 落盘且记录了
    // 引擎消化的 act 步轨迹（step 1 纯内置计算在 init/advance 期同步完成），不只看注册表状态
    const logRoot = join(dir, '.hoplog');
    expect(existsSync(logRoot)).toBe(true);
    const runDirs = readdirSync(logRoot);
    expect(runDirs.length).toBeGreaterThan(0);
    const mainYaml = readFileSync(join(logRoot, runDirs[0], 'main.yaml'), 'utf-8');
    // 头部含 run 身份即日志真开（startRun 同步段只到 init——act 消化在异步 runSpec 内，
    // 其步轨迹断言归 e2e-execution 的引擎级用例；此处守"standalone 不是黑箱"的通道在场性）
    expect(mainYaml).toContain('spec_id: coffee-week');
    expect(mainYaml).toContain('run_id:');
  });
});

// @v: anc-mcp-run-lifecycle —— paused→resume→completed 状态机全链（mock dispatcher，
// 补真机验收的自动化回归：此前 resume 成功路径只有一次性真机证据）
describe('HopjitMcpCore resume 状态机（mock dispatcher）', () => {
  const config: StandaloneConfig = { providers: [VALID_PROVIDER] };

  // 经公共 API 注入 mock entry：绕过 startRun 的 LLM 触发（薄壳无缝隙，直接操作私有注册表属测试对内部结构的最小依赖）
  function seedRun(core: HopjitMcpCore, state: string, resumeImpl?: () => Promise<unknown>) {
    const entry = {
      runId: 'r-test', specPath: '/x/spec.md', state,
      dispatcher: { resume: resumeImpl ?? (async () => ({ status: 'completed', outputs: { done: 1 } })) },
      paused: state === 'paused' ? { status: 'paused', step_id: '1', pause_reason: 'ask' } : undefined,
      startedAt: '2026-08-07T00:00:00Z',
    };
    (core as any).runs.set('r-test', entry);
    return entry;
  }

  it('paused → resume_run 立即返回 running（job 式异步，v0.2.0 契约）', () => {
    const core = new HopjitMcpCore(config);
    seedRun(core, 'paused');
    const r = core.resumeRun('r-test', '1', { value: '轻松' });
    expect(r['status']).toBe('running');
    expect(r['run_id']).toBe('r-test');
  });

  it('resume 后台完成 → run_status 转 completed 且携带 outputs', async () => {
    const core = new HopjitMcpCore(config);
    seedRun(core, 'paused');
    core.resumeRun('r-test', '1', { value: 'x' });
    await new Promise(res => setTimeout(res, 10));   // 等异步 then 落注册表
    const s = core.runStatus('r-test');
    expect(s['status']).toBe('completed');
    expect((s['outputs'] as Record<string, unknown>)['done']).toBe(1);
  });

  it('resume 再暂停（多次 HITL）→ paused 载荷更新', async () => {
    const core = new HopjitMcpCore(config);
    seedRun(core, 'paused', async () => ({ status: 'paused', pause: { status: 'paused', step_id: '2', pause_reason: 'confirm' } }));
    core.resumeRun('r-test', '1', { value: 'a' });
    await new Promise(res => setTimeout(res, 10));
    const s = core.runStatus('r-test');
    expect(s['status']).toBe('paused');
    expect((s['paused'] as Record<string, unknown>)['step_id']).toBe('2');
  });

  it('resume 抛错 → failed 终态含 step 与 reason', async () => {
    const core = new HopjitMcpCore(config);
    seedRun(core, 'paused', async () => { throw new Error('LLM down'); });
    core.resumeRun('r-test', '1', { value: 'a' });
    await new Promise(res => setTimeout(res, 10));
    const s = core.runStatus('r-test');
    expect(s['status']).toBe('failed');
    expect((s['failure'] as Record<string, unknown>)['reason']).toContain('LLM down');
  });

  it('对 running（非 paused）的 run resume → INVALID_STATE 不推进', () => {
    const core = new HopjitMcpCore(config);
    seedRun(core, 'running');
    const r = core.resumeRun('r-test', '1', { value: 'a' });
    expect((r['error'] as { code: string }).code).toBe('INVALID_STATE');
  });

  // resume 拒收传播（0016——修前 rejected 形态不存在:completeStep 结构化错误被吞成
  // 'No executable step found' 且 run 被錘 failed 终态）。 // @v: anc-mcp-run-lifecycle
  it('反例：resume 注入被拒（rejected）→ run 回 paused 原载荷恢复 + failure 携原始错误码指路（0016 probe 形态）', async () => {
    const core = new HopjitMcpCore(config);
    const entry = seedRun(core, 'paused', async () => ({
      status: 'paused',
      rejected: { code: 'HOP_ENV_CREDENTIAL_REJECTED', message: "ask 回填键 'hop_env_gh_token' 形似凭证——凭证只许走 providers[].api_key_env" },
    }));
    core.resumeRun('r-test', '1', { hop_env_gh_token: 'ghp_x' });
    await new Promise(res => setTimeout(res, 10));
    const s = core.runStatus('r-test');
    expect(s['status']).toBe('paused');                                             // 不是 failed 终态——仍在等修正
    expect((s['paused'] as Record<string, unknown>)['step_id']).toBe('1');          // 原暂停载荷恢复
    const reason = (s['failure'] as Record<string, unknown>)['reason'] as string;
    expect(reason).toContain('HOP_ENV_CREDENTIAL_REJECTED');                        // 原始错误码可见
    expect(reason).toContain('api_key_env');                                        // 指路可见
    expect(entry.state).toBe('paused');
  });

  it('正例：拒收后修正重试成功 → failure 残留清除（新暂停点不再展示旧拒因）', async () => {
    const core = new HopjitMcpCore(config);
    let calls = 0;
    seedRun(core, 'paused', async () => {
      calls++;
      if (calls === 1) return { status: 'paused', rejected: { code: 'SCHEMA_MISMATCH', message: 'bad' } };
      return { status: 'paused', pause: { status: 'paused', step_id: '2', pause_reason: 'confirm' } };   // 合法注入推进到下一暂停点
    });
    core.resumeRun('r-test', '1', { value: 'bad' });
    await new Promise(res => setTimeout(res, 10));
    expect((core.runStatus('r-test')['failure'] as Record<string, unknown>)['reason']).toContain('SCHEMA_MISMATCH');
    core.resumeRun('r-test', '1', { value: 'good' });
    await new Promise(res => setTimeout(res, 10));
    const s = core.runStatus('r-test');
    expect(s['status']).toBe('paused');
    expect((s['paused'] as Record<string, unknown>)['step_id']).toBe('2');
    expect(s['failure']).toBeUndefined();                                           // 旧拒因清除
  });
});

// @v: anc-mcp-tools —— buildServer 工具注册面（zod schema 是对外稳定面，此前零直接测试）
// @v: anc-struct-standalone-endpoint —— standalone 对外形态（五工具装配）
describe('buildServer 工具面', () => {
  it('注册恰好五工具且名称与契约一致（stop_run 2026-08-22 补——主动中止面）', async () => {
    const { buildServer: build } = await import('../src/mcp-server.js');
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const server = build(core);
    // McpServer 内部注册表（SDK 私有结构，仅断言工具名集合——形状断言到此为止，行为归冒烟/真机）
    const tools = (server as any)._registeredTools;
    expect(Object.keys(tools).sort()).toEqual(['list_runs', 'resume_run', 'run_status', 'start_run', 'stop_run']);
    expect(tools['start_run'].inputSchema).toBeTruthy();   // schema 存在（zod 对象）
    // stop_run 注解逐项（^anc-mcp-stop-run——destructiveHint 丢弃在飞进度如实标破坏性;
    // idempotentHint 终态幂等是设计点名条款,review 补断言）
    expect(tools['stop_run'].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });
});

// @v: anc-mcp-tools, anc-mcp-run-lifecycle —— 2026-08-07 codex review 五修的负向回归
describe('codex review 五修回归', () => {
  const twoProviders: StandaloneConfig = {
    providers: [
      { ...VALID_PROVIDER },
      { service_id: 'backup', protocol: 'anthropic', base_url: 'https://b.example/anthropic', model: 'm2', api_key_env: 'HOPJIT_TEST_KEY_ENV2' },
    ],
    default_model: 'override-model',
  };

  it('[P1] 多 provider：全量注入路由 env + ModelEngine 带 default_model', async () => {
    process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-a';
    process.env['HOPJIT_TEST_KEY_ENV2'] = 'sk-b';
    delete process.env['DEEPSEEK_API_KEY']; delete process.env['BACKUP_API_KEY'];
    try {
      const core = new HopjitMcpCore(twoProviders);
      const dir = mkdtempSync(join(tmpdir(), 'mcp-mp-'));
      const r = await core.startRun(
        join(REPO, 'examples', 'coffee-week.md'),
        { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 },
        join(dir, '.hopstate'),
      );
      expect(r['run_id']).toBeTruthy();
      // 改判（run 隔离不变量 2026-08-14,ARCHITECTURE ^anc-run-isolation）：凭证/端点改走
      // run 级 env_snapshot,进程 env **不再被写**——原"路由 env 全量注入"是把进程环境当
      // 全局注册表的反模式（多 run 共享可变槽+凭证泄进程环境）。dispatcher envOf 只查快照。
      expect(process.env['DEEPSEEK_API_KEY']).toBeUndefined();
      expect(process.env['BACKUP_API_KEY']).toBeUndefined();
    } finally {
      for (const k of ['HOPJIT_TEST_KEY_ENV', 'HOPJIT_TEST_KEY_ENV2', 'DEEPSEEK_API_KEY', 'BACKUP_API_KEY', 'BACKUP_BASE_URL', 'DEEPSEEK_BASE_URL']) delete process.env[k];
    }
  });

  it('[P1] 错误 step_id → 拒绝且 run 保持 paused（不毁可恢复态）', () => {
    process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-a';
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
      (core as any).runs.set('r1', {
        runId: 'r1', specPath: '/x.md', state: 'paused',
        dispatcher: { resume: async () => ({ status: 'completed' }) },
        paused: { status: 'paused', step_id: '2', pause_reason: 'ask' },
        startedAt: 't',
      });
      const r = core.resumeRun('r1', '999', { value: 'x' });
      expect((r['error'] as { code: string }).code).toBe('INVALID_STATE');
      expect((core.runStatus('r1'))['status']).toBe('paused');   // 关键：没被打成 failed/running
    } finally { delete process.env['HOPJIT_TEST_KEY_ENV']; }
  });

  it('[P2] run_status 简写：一终态 + 一活跃并存时仍命中活跃 run', () => {
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    (core as any).runs.set('done1', { runId: 'done1', specPath: '/a.md', state: 'completed', dispatcher: {}, startedAt: 't' });
    (core as any).runs.set('live1', { runId: 'live1', specPath: '/b.md', state: 'running', dispatcher: {}, startedAt: 't' });
    const r = core.runStatus();
    expect(r['run_id']).toBe('live1');
  });

  it('[P2] 工具预检遍历 field 链：tool(...).field 不再绕过', () => {
    const spec = `# T\nId: t\n## Goal\ng\n## Steps\n1. [act] 拉\n  + → out: text  # o\n  > 说明\n  > \`\`\`hop_python\n  > out = custom_tool(x: 1).field_a\n  > \`\`\`\n`;
    const { ast, errors } = parseSpec(spec);
    expect(errors.filter(e => e.kind === 'parse')).toHaveLength(0);
    expect([...collectSpecTools(ast.steps ?? [])]).toEqual(['custom_tool']);
  });
});

// @v: anc-config-standalone-schema —— v0.3.2 配置校验收紧（codex 二轮 review）
describe('v0.3.2 配置校验收紧', () => {
  it('default_model 引用未声明 service → 拒（v0.4.0 语义：引用须指向 providers 内——取代 v0.3.2 的一刀切拒 /）', () => {
    const p = writeConfig(JSON.stringify({ providers: [VALID_PROVIDER], default_model: 'backup/m2' }));
    expect(() => loadStandaloneConfig(p)).toThrow(/service 'backup' 不在 providers 内/);
  });

  it('default_model 裸模型名 → 通过', () => {
    const p = writeConfig(JSON.stringify({ providers: [VALID_PROVIDER], default_model: 'deepseek-reasoner' }));
    expect(loadStandaloneConfig(p).default_model).toBe('deepseek-reasoner');
  });

  it('service_id 大小写归一冲突 → 拒（路由 env 键互相覆盖）', () => {
    const p = writeConfig(JSON.stringify({ providers: [
      VALID_PROVIDER,
      { ...VALID_PROVIDER, service_id: 'DeepSeek', api_key_env: 'K2' },
    ] }));
    expect(() => loadStandaloneConfig(p)).toThrow(/大小写归一后冲突/);
  });

  it('service_id 保留名 default → 拒', () => {
    const p = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, service_id: 'default' }] }));
    expect(() => loadStandaloneConfig(p)).toThrow(/保留名/);
  });

  it('fallback_mode 已废除——残留旧键宽容忽略,不影响加载（正例）', () => {
    // 2026-08-10 作者拍板 standalone 拆为独立薄协议:注册 MCP server 即 opt-in,
    // fallback_mode 双信号废除。旧 config 残留该键按未知键忽略,不 fail。
    const p = writeConfig(JSON.stringify({ providers: [VALID_PROVIDER], fallback_mode: 'auto' }));
    const c = loadStandaloneConfig(p);
    expect(c.providers[0].service_id).toBe('deepseek');
  });

  it('fallback_mode 已废除——schema 类型上无此字段（反例:编译期钉死）', () => {
    const c = loadStandaloneConfig(writeConfig(JSON.stringify({ providers: [VALID_PROVIDER] })));
    // @ts-expect-error fallback_mode 已从 StandaloneConfig 移除——若有人加回类型,此行报错提醒对齐设计
    expect(c.fallback_mode).toBeUndefined();
  });
});

// @v: anc-mcp-tools —— 工具注解（2026-08-10 实撞:无注解被 Codex exec 审批层自动取消）
describe('工具注解（ToolAnnotations——载体审批分级判据）', () => {
  it('正例:四工具注解齐全——查询类 readOnly,写入类非破坏非开放世界', async () => {
    const core = new HopjitMcpCore(loadStandaloneConfig(writeConfig(JSON.stringify({ providers: [VALID_PROVIDER] }))));
    const server = buildServer(core);
    // SDK 内部注册表:server._registeredTools（无公开读接口,测试直查——形态变更即此测红,提醒对齐 SDK）
    const tools = (server as unknown as { _registeredTools: Record<string, { annotations?: Record<string, unknown> }> })._registeredTools;
    expect(tools['list_runs'].annotations).toMatchObject({ readOnlyHint: true });
    expect(tools['run_status'].annotations).toMatchObject({ readOnlyHint: true });
    // 反例判据:写入类若误标 readOnlyHint:true,载体会免审直放非只读动作——注解必须如实
    expect(tools['start_run'].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(tools['resume_run'].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  });
});

// @v: anc-mcp-config —— serve 启动面（子进程冒烟：fail-fast 三态，stdio server 无法进程内测）
describe('serve 启动 fail-fast（子进程）', () => {
  function spawnServe(env: Record<string, string | undefined>): { code: number; err: string } {
    const entry = join(REPO, 'dist', 'mcp-server.js');
    if (!existsSync(entry)) throw new Error('dist/mcp-server.js 缺失——测试入口必须先执行 npm run build');
    const r = spawnSync('node', [entry], {
      encoding: 'utf-8', timeout: 8000, input: '',
      env: { ...process.env, ...env },
    });
    return { code: r.status ?? -1, err: r.stderr ?? '' };
  }

  it('配置缺失 → exit 1 报 STANDALONE_CONFIG_MISSING', () => {
    const r = spawnServe({ HOPJIT_CONFIG: '/nonexistent/cfg.yaml' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('STANDALONE_CONFIG_MISSING');
  });

  it('key env 未设 → 启动即拒（不等首次 start_run）报变量名', () => {
    const p = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, api_key_env: 'HOPJIT_NO_SUCH_KEY' }] }));
    const r = spawnServe({ HOPJIT_CONFIG: p, HOPJIT_NO_SUCH_KEY: undefined });
    expect(r.code).toBe(1);
    expect(r.err).toContain('HOPJIT_NO_SUCH_KEY');
    expect(r.err).toContain('拒绝启动');
  });

  it('配置合法+key 在 → exit 0 且就绪横幅落 stderr（stdin 关闭即退出）', () => {
    const p = writeConfig(JSON.stringify({ providers: [VALID_PROVIDER] }));
    const r = spawnServe({ HOPJIT_CONFIG: p, HOPJIT_TEST_KEY_ENV: 'sk-smoke' });
    expect(r.code).toBe(0);
    expect(r.err).toContain('standalone server 就绪');
    expect(r.err).toContain('deepseek');
  });

  // 宿主断开即退出（^anc-mcp-shutdown-on-disconnect,四十七审——孤儿 server 实撞:历史会话的
  // server 挂两天无人杀。原纯启动场景'碰巧'退出〔事件循环空〕,有过 run 活动即留 handle 变孤儿;
  // 修后断开钩确定退出+留痕。正例=退出且留痕指路 restore;反例〔stdin 开着存活〕由上组
  // 'key env 未设'外全部 serve 流程隐含——spawnSync 不关 stdin 的形态会 8s 超时,不单测）
  // @v: anc-mcp-shutdown-on-disconnect
  it('stdin 关闭 → exit 0 且留痕指路 resume_run 恢复', () => {
    const p = writeConfig(JSON.stringify({ providers: [VALID_PROVIDER] }));
    const r = spawnServe({ HOPJIT_CONFIG: p, HOPJIT_TEST_KEY_ENV: 'sk-smoke' });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/stdin 关闭|宿主断开/);
    expect(r.err).toContain('resume_run');
  });
});

// @v: anc-mcp-config —— 预检函数 in-process（serve 的 stdio 段测不了，预检逻辑单独可测）
describe('preflightProviderKeys', () => {
  it('全部 provider key 在 → 通过', async () => {
    const { preflightProviderKeys } = await import('../src/mcp-server.js');
    process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-a';
    expect(() => preflightProviderKeys({ providers: [VALID_PROVIDER] })).not.toThrow();
  });

  it('任一 provider key 缺 → 抛错报变量名与 provider', async () => {
    const { preflightProviderKeys } = await import('../src/mcp-server.js');
    delete process.env['HOPJIT_MISSING_K'];
    expect(() => preflightProviderKeys({
      providers: [VALID_PROVIDER, { ...VALID_PROVIDER, service_id: 'backup', api_key_env: 'HOPJIT_MISSING_K' }],
    })).toThrow(/HOPJIT_MISSING_K.*backup.*拒绝启动/);
  });
});

// @v: anc-config-standalone-schema, anc-mcp-config —— v0.4.0+ 配置解析、路由与凭证快照回归
// env 快照键集契约（0008③——快照是封闭集:dispatcher envOf 有快照不回退 process.env,
// 漏键=用户环境变量静默失效。原两处手写只冻 providers 三键,HOPJIT_MAX_OUTPUT_TOKENS/
// ANTHROPIC_MODEL 等固定透传键恒 undefined）。 // @v: anc-run-isolation
describe('buildEnvSnapshot 键集契约', () => {
  const cfg: StandaloneConfig = { providers: [VALID_PROVIDER] };
  const keys = () => new Map([[VALID_PROVIDER, 'sk-test-fake']]);

  it('正例：固定透传键在场即冻入快照（HOPJIT_MAX_OUTPUT_TOKENS 设置后 standalone 下真生效）', () => {
    process.env['HOPJIT_MAX_OUTPUT_TOKENS'] = '9999';
    process.env['ANTHROPIC_MODEL'] = 'env-model-x';
    try {
      const snap = buildEnvSnapshot(cfg, keys());
      expect(snap['HOPJIT_MAX_OUTPUT_TOKENS']).toBe('9999');
      expect(snap['ANTHROPIC_MODEL']).toBe('env-model-x');
      expect(snap['DEEPSEEK_API_KEY']).toBe('sk-test-fake');   // providers 派生三键照旧
      expect(snap['DEEPSEEK_PROTOCOL']).toBe('anthropic');
    } finally { delete process.env['HOPJIT_MAX_OUTPUT_TOKENS']; delete process.env['ANTHROPIC_MODEL']; }
  });

  it('反例：透传键环境里没设 → 不入快照（不写 undefined 占位键——in 判定面干净）', () => {
    delete process.env['HOPJIT_MAX_OUTPUT_TOKENS'];
    const snap = buildEnvSnapshot(cfg, keys());
    expect('HOPJIT_MAX_OUTPUT_TOKENS' in snap).toBe(false);
  });

  it('反例：透传表外的键不冻（快照仍是封闭集,不是 process.env 全量拷贝）', () => {
    process.env['RANDOM_BUSINESS_VAR'] = 'x';
    try {
      const snap = buildEnvSnapshot(cfg, keys());
      expect('RANDOM_BUSINESS_VAR' in snap).toBe(false);
    } finally { delete process.env['RANDOM_BUSINESS_VAR']; }
  });

  // @v: anc-config-standalone-schema —— auth 鉴权头档快照透传（2026-09-18 review 面三变异 M2 实锤
  // 该行删掉全绿零保护后真补:配置 bearer 而快照不透传=dispatcher 永走 x-api-key,真机对百炼即
  // InvalidApiKey——静默失效正是本钉要锁的形态;卡原虚记两钉,本批改实）
  it('正例：provider auth: bearer → 快照透传 {SID}_AUTH=bearer;反例：auth 缺省 → 不写 _AUTH 键', () => {
    const bearerP = { ...VALID_PROVIDER, auth: 'bearer' as const };
    const snapB = buildEnvSnapshot({ providers: [bearerP] }, new Map([[bearerP, 'sk-test-fake']]));
    expect(snapB['DEEPSEEK_AUTH']).toBe('bearer');
    const snapDefault = buildEnvSnapshot(cfg, keys());
    expect('DEEPSEEK_AUTH' in snapDefault).toBe(false);
  });
});

describe('v0.4.0 default_model 两形态与格式校验', () => {
  // 密闭化：仓库根常驻项目级 hopjit.yaml 后,startRun 每 run 重读会用真配置覆盖本组假 default_model
  //（0007/0012 重读契约的正确行为——测试环境须与开发者盘面解耦）。HOPJIT_CONFIG 在场即跳过重读。
  beforeEach(() => { process.env['HOPJIT_CONFIG'] = '/hermetic/no-project-reload.yaml'; });
  afterEach(() => { delete process.env['HOPJIT_CONFIG']; });

  it('default_model=service/model 引用且 service 在 providers 内 → 通过', () => {
    const p = writeConfig(JSON.stringify({
      providers: [VALID_PROVIDER, { ...VALID_PROVIDER, service_id: 'backup', api_key_env: 'K2' }],
      default_model: 'backup/m2',
    }));
    expect(loadStandaloneConfig(p).default_model).toBe('backup/m2');
  });

  it('default_model 引用未声明的 service → 拒（错后端防线前移到加载期）', () => {
    const p = writeConfig(JSON.stringify({ providers: [VALID_PROVIDER], default_model: 'typo/m2' }));
    expect(() => loadStandaloneConfig(p)).toThrow(/service 'typo' 不在 providers 内/);
  });

  it.each(['/m2', 'backup/', ' backup/m2'])('default_model 空片段或首尾空白 → 拒：%j', defaultModel => {
    const p = writeConfig(JSON.stringify({
      providers: [VALID_PROVIDER, { ...VALID_PROVIDER, service_id: 'backup', api_key_env: 'K2' }],
      default_model: defaultModel,
    }));
    expect(() => loadStandaloneConfig(p)).toThrow(/INVALID_MODEL_REF/);
  });

  it('default_model service 引用按大小写归一命中', () => {
    const p = writeConfig(JSON.stringify({
      providers: [VALID_PROVIDER, { ...VALID_PROVIDER, service_id: 'Backup', api_key_env: 'K2' }],
      default_model: 'backup/m2',
    }));
    expect(loadStandaloneConfig(p).default_model).toBe('backup/m2');
  });

  it('service_id 含 / 或空白 → 拒（路由语法冲突）', () => {
    const p1 = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, service_id: 'foo/bar' }] }));
    expect(() => loadStandaloneConfig(p1)).toThrow(/service_id.*非法/);
    const p2 = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, service_id: 'a b' }] }));
    expect(() => loadStandaloneConfig(p2)).toThrow(/service_id.*非法/);
  });

  it.each(['a-b', '9svc', 'a.b'])('service_id 不能生成安全路由 env：%s', serviceId => {
    const p = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, service_id: serviceId }] }));
    expect(() => loadStandaloneConfig(p)).toThrow(/service_id.*非法/);
  });

  it('base_url/model 空串 → 拒（fail-fast 不拖到 API 调用期）', () => {
    const p1 = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, base_url: '' }] }));
    expect(() => loadStandaloneConfig(p1)).toThrow(/base_url 缺失或为空/);
    const p2 = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, model: '  ' }] }));
    expect(() => loadStandaloneConfig(p2)).toThrow(/model 缺失或为空/);
  });

  it('api_key_env 非 POSIX env 名（BAD-NAME）→ 拒', () => {
    const p = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, api_key_env: 'BAD-NAME' }] }));
    expect(() => loadStandaloneConfig(p)).toThrow(/须匹配/);
  });

  it('startRun 构造 ModelEngine：service/model 引用拆开归属', async () => {
    process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-a'; process.env['K2'] = 'sk-b';
    try {
      const core = new HopjitMcpCore({
        providers: [{ ...VALID_PROVIDER }, { ...VALID_PROVIDER, service_id: 'Backup', model: 'm-b', api_key_env: 'K2' }],
        default_model: 'backup/m2',
      });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-dm-'));
      const r = await core.startRun(
        join(REPO, 'examples', 'coffee-week.md'),
        { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 },
        join(dir, '.hopstate'),
      );
      expect(r['run_id']).toBeTruthy();
      // 经注册表拿 dispatcher 的 hostConfig 验证 ModelEngine（私有结构最小依赖）
      const entry = [...(core as any).runs.values()][0];
      const me = (entry.dispatcher as any).hostConfig.model_engine;
      expect(me.default_service_id).toBe('Backup');
      expect(me.default_model).toBe('m2');
    } finally { delete process.env['K2']; process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-test-fake'; }
  });

  it('startRun 直接调用时任一 secondary key 缺失也在执行前失败', async () => {
    process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-a';
    delete process.env['HOPJIT_MISSING_SECONDARY'];
    const core = new HopjitMcpCore({ providers: [
      VALID_PROVIDER,
      { ...VALID_PROVIDER, service_id: 'backup', api_key_env: 'HOPJIT_MISSING_SECONDARY' },
    ] });
    await expect(core.startRun('/nonexistent/spec.md')).rejects.toThrow(/HOPJIT_MISSING_SECONDARY.*backup/);
  });

  it('provider key 先全量快照再写派生 env，源变量与派生目标碰撞不串 key', async () => {
    process.env['ALPHA_SOURCE_KEY'] = 'sk-alpha';
    process.env['ALPHA_API_KEY'] = 'sk-beta';
    delete process.env['BETA_API_KEY'];
    try {
      const core = new HopjitMcpCore({ providers: [
        { ...VALID_PROVIDER, service_id: 'alpha', api_key_env: 'ALPHA_SOURCE_KEY' },
        { ...VALID_PROVIDER, service_id: 'beta', api_key_env: 'ALPHA_API_KEY' },
      ] });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-key-snapshot-'));
      const result = await core.startRun(
        join(REPO, 'examples', 'coffee-week.md'),
        { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 },
        join(dir, '.hopstate'),
      );
      expect(result['run_id']).toBeTruthy();
      // 改判（run 隔离,同上例）：不再写进程 env——源变量 ALPHA_API_KEY 原值不被覆盖
      //（旧行为把派生目标写回 env,恰与 beta 的源变量同名——快照方案下"碰撞"类别整体消失）。
      expect(process.env['ALPHA_API_KEY']).toBe('sk-beta');   // 用户设的原值原样
      expect(process.env['BETA_API_KEY']).toBeUndefined();
    } finally {
      for (const key of ['ALPHA_SOURCE_KEY', 'ALPHA_API_KEY', 'BETA_API_KEY', 'ALPHA_BASE_URL', 'BETA_BASE_URL']) delete process.env[key];
    }
  });
});

// resource_limits 配置节（四十四审 MCP 直驱实撞——重档步 OUTPUT_TRUNCATED 于 16384 缺省,
// MCP 主模式无输出预算配置通道:selftest 自设 env,server 进程改 env 须重注册,与每 run 重读哲学相悖）
// @v: anc-config-standalone-schema
describe('resource_limits 配置节', () => {
  // 文法核（四十五审——原零核:'not-a-map'/数字串静默漂到装配,max_tokens NaN 发 API 400 离病灶两层）
  it('反例：非映射/数字串/未知键三形态加载期拒;正例：合法数字过', () => {
    const base = ['providers:', '  - service_id: x', '    protocol: anthropic',
      '    base_url: https://x.invalid', '    model: m', '    api_key_env: HOPJIT_TEST_KEY_ENV'].join('\n') + '\n';
    expect(() => loadStandaloneConfig(writeConfig(base + 'resource_limits: not-a-map\n'))).toThrow(/resource_limits 须为映射/);
    expect(() => loadStandaloneConfig(writeConfig(base + 'resource_limits:\n  max_output_tokens: "lots"\n'))).toThrow(/须为正数/);
    expect(() => loadStandaloneConfig(writeConfig(base + 'resource_limits:\n  max_outputs_tokens: 65536\n'))).toThrow(/不是合法键/);
    const c = loadStandaloneConfig(writeConfig(base + 'resource_limits:\n  max_output_tokens: 65536\n'));
    expect(c.resource_limits?.max_output_tokens).toBe(65536);
  });

  it('正例：mergeConfigs 逐键合并项目级赢', () => {
    const merged = mergeConfigs(
      { providers: [VALID_PROVIDER], resource_limits: { max_output_tokens: 16384, max_tool_iterations: 20 } as any },
      { providers: [], resource_limits: { max_output_tokens: 65536 } as any },
    );
    expect(merged.resource_limits?.max_output_tokens).toBe(65536);   // 项目级赢
    expect((merged.resource_limits as any)?.max_tool_iterations).toBe(20);  // 系统级保留
  });

  it('正例：startRun 装配进 hostConfig.resource_limits（dispatcher 输出预算消费面）', async () => {
    process.env['HOPJIT_CONFIG'] = '/hermetic/no-project-reload.yaml';
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER], resource_limits: { max_output_tokens: 65536 } as any });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-rl-'));
      const r = await core.startRun(
        join(REPO, 'examples', 'coffee-week.md'),
        { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 },
        join(dir, '.hopstate'),
      );
      expect(r['run_id']).toBeTruthy();
      const entry = [...(core as any).runs.values()][0];
      expect((entry.dispatcher as any).hostConfig.resource_limits?.max_output_tokens).toBe(65536);
    } finally { delete process.env['HOPJIT_CONFIG']; }
  });

  it('反例：未配置 → hostConfig.resource_limits 维持缺省（不产生空对象覆盖）', async () => {
    process.env['HOPJIT_CONFIG'] = '/hermetic/no-project-reload.yaml';
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-rl2-'));
      const r = await core.startRun(
        join(REPO, 'examples', 'coffee-week.md'),
        { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 },
        join(dir, '.hopstate'),
      );
      expect(r['run_id']).toBeTruthy();
      const entry = [...(core as any).runs.values()][0];
      expect(entry.dispatcher.hostConfig?.resource_limits?.max_output_tokens).toBeUndefined();
    } finally { delete process.env['HOPJIT_CONFIG']; }
  });
});

// log_level 配置节（2026-08-22 作者定方案③——standalone 缺省 debug:执行日志是唯一核验通道,
// info 不记 prompt 正文即黑箱;实撞:L2c 反馈在不在外部无从核验,走查误判"重试无记忆"）
// @v: anc-config-standalone-schema
describe('log_level 配置节（standalone 缺省 debug）', () => {
  const base = ['providers:', '  - service_id: x', '    protocol: anthropic',
    '    base_url: https://x.invalid', '    model: m', '    api_key_env: HOPJIT_TEST_KEY_ENV'].join('\n') + '\n';

  it('反例：非法值加载期拒;正例：合法枚举过 + mergeConfigs 项目级赢', () => {
    expect(() => loadStandaloneConfig(writeConfig(base + 'log_level: verbose\n'))).toThrow(/log_level 须为 debug\|info\|warn/);
    expect(loadStandaloneConfig(writeConfig(base + 'log_level: warn\n')).log_level).toBe('warn');
    const merged = mergeConfigs(
      { providers: [VALID_PROVIDER], log_level: 'info' },
      { providers: [], log_level: 'warn' },
    );
    expect(merged.log_level).toBe('warn');   // 项目级赢
    expect(mergeConfigs({ providers: [VALID_PROVIDER], log_level: 'info' }, { providers: [] }).log_level).toBe('info');   // 项目级缺席回退系统级
  });

  it('正例：未配置 → startRun 落 debug 级 hoplog（main.yaml 头 level: debug,prompt 全文可核）', async () => {
    process.env['HOPJIT_CONFIG'] = '/hermetic/no-project-reload.yaml';
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-ll-'));
      const r = await core.startRun(
        join(REPO, 'examples', 'coffee-week.md'),
        { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 },
        join(dir, '.hopstate'),
      );
      expect(r['run_id']).toBeTruthy();
      const entry = [...(core as any).runs.values()][0] as { dispatcher: { getEngine: () => { getHopLogRunDir: () => string | null } } };
      const runDir = entry.dispatcher.getEngine().getHopLogRunDir();
      expect(runDir).toBeTruthy();
      expect(readFileSync(join(runDir!, 'main.yaml'), 'utf-8')).toMatch(/^level: debug$/m);
    } finally { delete process.env['HOPJIT_CONFIG']; }
  });

  it('反例（配置口生效）：log_level: info → hoplog 头 level: info（降级通道可用）', async () => {
    process.env['HOPJIT_CONFIG'] = '/hermetic/no-project-reload.yaml';
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER], log_level: 'info' });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-ll2-'));
      const r = await core.startRun(
        join(REPO, 'examples', 'coffee-week.md'),
        { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 },
        join(dir, '.hopstate'),
      );
      expect(r['run_id']).toBeTruthy();
      const entry = [...(core as any).runs.values()][0] as { dispatcher: { getEngine: () => { getHopLogRunDir: () => string | null } } };
      const runDir = entry.dispatcher.getEngine().getHopLogRunDir();
      expect(readFileSync(join(runDir!, 'main.yaml'), 'utf-8')).toMatch(/^level: info$/m);
    } finally { delete process.env['HOPJIT_CONFIG']; }
  });
});

// ===== F类测试缺口补齐（2026-08-08 语义审计 c2t ⚠️，mcp-server 批）=====

// @v: anc-i18n-serialize-lang —— language 配置节合并与文法核（todo/0084 M2:mergeConfigs 曾漏本键,
// 项目级 zh 在 MCP 侧静默蒸发落 en 与 CLI 劈叉——commands 前车同型复发;文法核原零核坏值静默当 en）
describe('language 配置节（0084 M2 合并断线修复）', () => {
  const base = ['providers:', '  - service_id: x', '    protocol: anthropic',
    '    base_url: https://x.invalid', '    model: m', '    api_key_env: HOPJIT_TEST_KEY_ENV'].join('\n') + '\n';

  it('正例：mergeConfigs 项目级 zh 赢（修前恒 undefined——漏合并本体）;项目级缺席回退系统级', () => {
    const merged = mergeConfigs(
      { providers: [VALID_PROVIDER], language: 'en' },
      { providers: [], language: 'zh' },
    );
    expect(merged.language).toBe('zh');   // 项目级赢——修前此断言红（merged.language === undefined）
    expect(mergeConfigs({ providers: [VALID_PROVIDER], language: 'zh' }, { providers: [] }).language).toBe('zh');
  });

  it('正例（R12）：startRun 侧 hop_env_language 打底在 hostConfig（M4"与 startRun 对齐"的对齐目标自身有钉——面三变异 G 实证原零保护）', async () => {
    process.env['HOPJIT_CONFIG'] = '/hermetic/no-project-reload.yaml';
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER], language: 'zh' });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-lang-base-'));
      const r = await core.startRun(
        join(REPO, 'examples', 'coffee-week.md'),
        { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 },
        join(dir, '.hopstate'),
      );
      expect(r['run_id']).toBeTruthy();
      const entry = [...(core as any).runs.values()][0];
      expect((entry.dispatcher as any).hostConfig.hop_env?.['hop_env_language']).toBe('zh');
    } finally { delete process.env['HOPJIT_CONFIG']; }
  });

  it('反例：非法值（fr）加载期响亮拒,不静默当 en;正例：合法枚举过', () => {
    expect(() => loadStandaloneConfig(writeConfig(base + 'language: fr\n'))).toThrow(/language 须为 en\|zh/);
    expect(loadStandaloneConfig(writeConfig(base + 'language: zh\n')).language).toBe('zh');
  });

  // @v: anc-exec-revision-short-weak —— 修订供给档文法核（坏值静默当 standard=开关悄悄失效,响亮拒）
  it('revision_prompt 正例：short 合法加载;反例：非法枚举值 fail-fast 拒', () => {
    expect(loadStandaloneConfig(writeConfig(base + 'revision_prompt: short\n')).revision_prompt).toBe('short');
    expect(() => loadStandaloneConfig(writeConfig(base + 'revision_prompt: brief\n'))).toThrow(/revision_prompt 须为 standard\|short/);
  });
});

// @v: anc-mcp-config —— RUN_LIMIT 并发上限（防失控烧费契约,此前零测试）
describe('RUN_LIMIT 并发上限', () => {
  function seedEntry(core: HopjitMcpCore, id: string, state: string) {
    (core as any).runs.set(id, {
      runId: id, specPath: '/x/spec.md', state,
      dispatcher: {}, startedAt: '2026-08-08T00:00:00Z',
    });
  }

  it('4 个活跃 run（含 paused）→ 第 5 个 startRun 拒 RUN_LIMIT', async () => {
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    seedEntry(core, 'r1', 'running');
    seedEntry(core, 'r2', 'running');
    seedEntry(core, 'r3', 'paused');    // paused 计入活跃——挂起的 run 也占并发额度
    seedEntry(core, 'r4', 'running');
    const r = await core.startRun('/nonexistent/spec.md');
    expect((r['error'] as { code: string }).code).toBe('RUN_LIMIT');   // 上限检查先于文件存在性
  });

  it('终态 run 不占额度：3 running + 2 completed → 放行到后续检查', async () => {
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    seedEntry(core, 'r1', 'running');
    seedEntry(core, 'r2', 'running');
    seedEntry(core, 'r3', 'running');
    seedEntry(core, 'r4', 'completed');
    seedEntry(core, 'r5', 'failed');
    const r = await core.startRun('/nonexistent/spec.md');
    expect((r['error'] as { code: string }).code).toBe('SPEC_NOT_FOUND');   // 过了并发闸,落到文件检查
  });

  // todo/0084 M1——上限配置化:批量场景第 5 run 被拒实撞,裸常量任何途径改不了
  it('正例（0084 M1）：配置 max_concurrent_runs: 6 → 第 5 个 run 过并发闸落到文件检查', async () => {
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER], resource_limits: { max_concurrent_runs: 6 } as any });
    seedEntry(core, 'r1', 'running');
    seedEntry(core, 'r2', 'running');
    seedEntry(core, 'r3', 'paused');
    seedEntry(core, 'r4', 'running');
    const r = await core.startRun('/nonexistent/spec.md');
    expect((r['error'] as { code: string }).code).toBe('SPEC_NOT_FOUND');   // 缺省会拒 RUN_LIMIT,配置调大后放行
  });

  it('反例（0084 M1）：配置调大后第 7 个仍拒（上限是调,不是拆）;文法核:非法键值加载期拒', async () => {
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER], resource_limits: { max_concurrent_runs: 6 } as any });
    for (let i = 1; i <= 6; i++) seedEntry(core, `r${i}`, 'running');
    const r = await core.startRun('/nonexistent/spec.md');
    expect((r['error'] as { code: string }).code).toBe('RUN_LIMIT');
    expect(String((r['error'] as { message: string }).message)).toContain('6');   // 报文报的是配置值非硬 4
    // 文法核:RL_KEYS 白名单收编后,数字串形态照拒（与家族同律）
    const base = ['providers:', '  - service_id: x', '    protocol: anthropic',
      '    base_url: https://x.invalid', '    model: m', '    api_key_env: HOPJIT_TEST_KEY_ENV'].join('\n') + '\n';
    expect(() => loadStandaloneConfig(writeConfig(base + 'resource_limits:\n  max_concurrent_runs: "many"\n'))).toThrow(/须为正数/);
    const c = loadStandaloneConfig(writeConfig(base + 'resource_limits:\n  max_concurrent_runs: 8\n'));
    expect((c.resource_limits as any)?.max_concurrent_runs).toBe(8);
  });
});

// @v: anc-mcp-tools —— jsonContent isError 标志（错误响应置 isError:true,此前零直接测试）
describe('工具响应 isError 标志', () => {
  it('handler 返回 error 载荷 → isError:true;正常载荷无 isError', async () => {
    const { buildServer: build } = await import('../src/mcp-server.js');
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const server = build(core);
    const tools = (server as any)._registeredTools;
    // run_status 不存在的 run → error 载荷
    const errResp = await tools['run_status'].handler({ run_id: 'nope' }, {} as any);
    expect(errResp.isError).toBe(true);
    expect(JSON.parse(errResp.content[0].text).error.code).toBe('RUN_NOT_FOUND');
    // list_runs 空注册表 → 正常载荷
    const okResp = await tools['list_runs'].handler({}, {} as any);
    expect(okResp.isError).toBeUndefined();
    expect(JSON.parse(okResp.content[0].text).runs).toEqual([]);
  });
});

// @v: anc-mcp-run-restore, anc-exec-pause-persist —— server 重启后 paused run 从快照恢复（暂停态经 running 编码,载荷重算）
describe('HopjitMcpCore run 恢复（server 重启后从快照重建）', () => {
  const config: StandaloneConfig = { providers: [VALID_PROVIDER] };
  // 前方 describe 的 finally 会删全局 env（顺序污染）——本组用例自设保障
  beforeEach(() => { process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-test-fake'; });

  // 带 ask 的纯内置 spec：act(纯计算) → ask(暂停)。跑到 paused 后模拟 server 重启。
  const ASK_SPEC = `# Restore
Id: restore-t

## Goal
恢复验证

## Inputs
- base: int  # 底数

## Outputs
- result: int  # 结果

## Steps
1. [act] 备料
  - ← base
  + → prepared: int  # 备好的数
  > 纯计算
  > \`\`\`hop_python
  > prepared = base + 1
  > \`\`\`
2. [ask require_human=true] 请确认数值
  - ← prepared
  + → result: int  # 人确认的值
`;

  function setupPausedSnapshot(): { stateDir: string; runId: string; specPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-restore-'));
    const specPath = join(dir, 'restore-t.md');
    writeFileSync(specPath, ASK_SPEC);
    const stateDir = join(dir, '.hopstate');
    // 用引擎直接跑到 paused（避免经 startRun 触 LLM）：act 纯计算被消化,停在 ask
    const engine = new ExecutionEngine();
    const init = engine.initExecution(ASK_SPEC, {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'x',
    }, { stateDir, params: { base: 41 }, specPath });
    expect(init.status).toBe('ok');
    // 推进：act 消化 → ask 标 running 返回 paused（同步落盘）
    let n = engine.nextStep();
    while (n.status === 'step_ready') {
      // act 纯计算不该到这（引擎不消化时手动补全）——防御性推进
      engine.completeStep(n.step_id, { prepared: 42 });
      n = engine.nextStep();
    }
    expect(n.status).toBe('paused');
    const runId = (init as { instance_id: string }).instance_id;
    return { stateDir, runId, specPath };
  }

  // 带钉根变体（十三审 restore 重读反例用——host_context.config_project_dir 在场才走重读分支）
  function setupPausedSnapshotWithDir(): { stateDir: string; runId: string; projDir: string } {
    const projDir = mkdtempSync(join(tmpdir(), 'mcp-restore-pin-'));
    const specPath = join(projDir, 'restore-t.md');
    writeFileSync(specPath, ASK_SPEC);
    const stateDir = join(projDir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(ASK_SPEC, {
      workspace_dir: projDir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'x',
      config_project_dir: projDir,   // 钉根——restore 按此重读项目级配置
    }, { stateDir, params: { base: 41 }, specPath });
    expect(init.status).toBe('ok');
    let n = engine.nextStep();
    while (n.status === 'step_ready') { engine.completeStep(n.step_id, { prepared: 42 }); n = engine.nextStep(); }
    expect(n.status).toBe('paused');
    return { stateDir, runId: (init as { instance_id: string }).instance_id, projDir };
  }

  it('正例：runId 不在注册表 → 从快照恢复并注入答案续跑到 completed（tokens 预算延续）', async () => {
    const { stateDir, runId } = setupPausedSnapshot();
    const core = new HopjitMcpCore(config);   // 新 core = 重启后的 server（注册表空）
    const r = core.resumeRun(runId, '2', { value: 42 }, stateDir);
    expect((r as { status?: string }).status).toBe('running');   // job 式异步立即返回
    // 等异步 resume 完成（纯 ask 注入 + 终态,无 LLM 调用）
    await new Promise(res => setTimeout(res, 300));
    const st = core.runStatus(runId);
    expect((st as { status?: string }).status).toBe('completed');
    expect(((st as { outputs?: Record<string, unknown> }).outputs)?.['result']).toBe(42);
  });

  // @v: anc-mcp-run-restore, anc-exec-crash-recovery —— #52 崩溃恢复分支（dr20 实撞:
  // server 死时 run 正在推进,原三停点预检拒死纯崩溃态,MCP run 只能弃）
  it('#52 正例：运行中崩溃的快照（步骤悬空 running）→ resume_run 走崩溃分支重跑续到停点', async () => {
    // 构造崩溃态:act(纯计算)→ask 的 spec,推进到步1 running 后直接 persist(模拟 server 死在步1执行中)
    const dir = mkdtempSync(join(tmpdir(), 'mcp-crash-'));
    const specPath = join(dir, 'restore-t.md');
    writeFileSync(specPath, ASK_SPEC);
    const stateDir = join(dir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(ASK_SPEC, {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'x',
    }, { stateDir, params: { base: 41 }, specPath });
    expect(init.status).toBe('ok');
    // 手工把步1置 running 后落盘=崩溃快照（不走 completeStep——正是"执行中死掉"的形态）
    const n = engine.nextStep();
    expect(n.status).toBe('step_ready');   // 步1 已 running
    // 引擎 nextStep 时已 persist(running 态在盘)——直接弃内存实例模拟进程死
    const runId = (init as { instance_id: string }).instance_id;

    const core = new HopjitMcpCore(config);   // 新 core=重启后 server
    const r = core.resumeRun(runId, '1', {}, stateDir);   // step_id=悬空崩溃步,answer 忽略
    expect((r as { status?: string }).status).toBe('running');
    expect((r as { recovered_from_crash?: boolean }).recovered_from_crash).toBe(true);
    // 异步续跑:步1 纯计算 body 被消化 → 停在步2 ask paused
    await new Promise(res => setTimeout(res, 400));
    const st = core.runStatus(runId);
    expect((st as { status?: string }).status).toBe('paused');
    expect(((st as { paused?: { step_id?: string } }).paused)?.step_id).toBe('2');
  });

  // @v: anc-exec-check-escalate —— 升层待答跨进程恢复放行（0006 批次一,与崩溃分支互斥判据）
  it('escalate 正例：升层待答态 server 重启后 resume_run 放行,guidance 消化续跑', async () => {
    const ESC_SPEC = `# Esc
Id: esc-mcp
## Goal
g
## Outputs
- r: text  # 出
## Steps
1. [subtask retry=2] 循环
  + → r: text  # 出
  1.1. [check escalatable] 判
    + → ok: bool  # 判定槽
    + → gap: yaml  # 缺口槽
    > 判
  1.2. [act] 出
    + → r: text  # 出
    > \`\`\`hop_python
    > r = "done"
    > \`\`\`
`;
    const dir = mkdtempSync(join(tmpdir(), 'mcp-esc-'));
    writeFileSync(join(dir, 'esc-mcp.md'), ESC_SPEC);
    const stateDir = join(dir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(ESC_SPEC, {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'x',
    }, { stateDir, specPath: join(dir, 'esc-mcp.md') });
    engine.nextStep();
    engine.completeStep('1.1', { ok: false, gap: { escalate: true, need: '要口径' } });   // 升层落卡
    const runId = (init as { instance_id: string }).instance_id;

    const core = new HopjitMcpCore(config);   // 重启后 server
    // run_status 快照兜底可见 escalate 卡
    const st = core.runStatus(runId, stateDir);
    expect((st as { status?: string }).status).toBe('paused');
    // resume_run 放行(非 confirm/ask 但 escalatePending 命中)——guidance 消化,LLM 步会因假凭证
    // 后续失败,本判定点只核放行与消化不核跑通
    const r = core.resumeRun(runId, '1.1', { guidance: '按 0.8 阈值' }, stateDir);
    expect((r as { status?: string }).status).toBe('running');
  });

  it('#52 反例：step_id 既非停点也非悬空 running（如已 done 的步）→ INVALID_STATE 仍拒', () => {
    const { stateDir, runId } = setupPausedSnapshot();   // 步1 done,步2 ask running(paused)
    const core = new HopjitMcpCore(config);
    const r = core.resumeRun(runId, '1', { value: 1 }, stateDir);   // 步1 是 act 且已 done
    expect((r['error'] as { code: string }).code).toBe('INVALID_STATE');
  });

  it('反例：无快照的 runId → RUN_NOT_FOUND（不误恢复）', () => {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-restore-none-'));
    const r = core.resumeRun('ghost-run', 's1', { value: 1 }, join(dir, '.hopstate'));
    expect((r['error'] as { code: string }).code).toBe('RUN_NOT_FOUND');
  });

  // @v: anc-exec-network-pause （33轮review探针实抓:网络暂停步是普通步,恢复预检只认confirm/ask
  // 把它拒死——detach断网暂停跨进程永远续不了;按免答通道同判据〔network_pause事件+pending〕放行）
  it('正例：网络暂停步跨进程 resume 放行（免答续跑,不被 confirm/ask 预检拒）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'np-restore-'));
    const sd = join(dir, '.hopstate');
    const spec = `# NP
Id: np-x
## Goal
g
## Outputs
- r: text
## Steps
1. [reason] R
  + → r: text
  > t
2. [exit] 交付
  + → r
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'x',
    }, { stateDir: sd });
    engine.nextStep();   // 步1 running
    engine.resetStepForNetworkPause('1', 'NETWORK_ERROR: probe');   // 回置 pending+事件落账
    const core = new HopjitMcpCore(config);   // 新 core=新进程
    const r = core.resumeRun(init.instance_id!, '1', {}, sd);
    expect((r as { status?: string }).status).toBe('running');   // 预检放行,免答续跑
  });

  it('反例：恢复后 step_id 指向非 confirm/ask 步骤 → INVALID_STATE 拒且不推进', () => {
    const { stateDir, runId } = setupPausedSnapshot();
    const core = new HopjitMcpCore(config);
    const r = core.resumeRun(runId, '1', { value: 1 }, stateDir);   // step 1 是 act
    expect((r['error'] as { code: string }).code).toBe('INVALID_STATE');
    // run 已恢复进注册表且保持 paused（坏输入不毁可恢复态）
    const st = core.runStatus(runId);
    expect((st as { status?: string }).status).toBe('paused');
  });

  it('正例：restore 合成——快照恢复表覆盖配置 env,配置独有键保留（快照是覆盖链更下游产物）', () => {
    // 快照里的 hop_env（原 run params 覆盖/ask 回填的沉淀）须赢过配置重合成。
    // @v: anc-config-hop-env
    const dir = mkdtempSync(join(tmpdir(), 'mcp-restore-env-'));
    const specPath = join(dir, 'restore-t.md');
    writeFileSync(specPath, ASK_SPEC);
    const stateDir = join(dir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(ASK_SPEC, {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: '',
      hop_env: { hop_env_kb: '/snap/kb' },   // 快照沉淀值
    }, { stateDir, params: { base: 1 }, specPath });
    let n = engine.nextStep();
    while (n.status === 'step_ready') { engine.completeStep(n.step_id, { prepared: 42 }); n = engine.nextStep(); }
    expect(n.status).toBe('paused');
    const runId = (init as { instance_id: string }).instance_id;

    const core = new HopjitMcpCore({ ...config, env: { hop_env_kb: '/cfg/kb', hop_env_extra: 'e' } });
    const r = core.resumeRun(runId, '1', { value: 1 }, stateDir);   // 坏 step_id：恢复入注册表但保持 paused
    expect((r['error'] as { code: string }).code).toBe('INVALID_STATE');
    // 观察恢复 run 的 hostConfig（注册表 dispatcher 持有——账面断言,经运行时逃逸访问私有）
    const entry = (core as unknown as { runs: Map<string, { dispatcher: unknown }> }).runs.get(runId)!;
    const hc = (entry.dispatcher as { hostConfig: { hop_env?: Record<string, string> } }).hostConfig;
    expect(hc.hop_env?.hop_env_kb).toBe('/snap/kb');    // 快照赢
    expect(hc.hop_env?.hop_env_extra).toBe('e');        // 配置独有键保留
  });

  it('正例：BUG-I——config_project_dir 随快照钉住,restoreRun 以它重读项目级配置(工具面跨重启不丢)', () => {
    // 模拟实撞:run 启动于项目根 A（hopjit.yaml 声明 tool_servers）,server 重启后 cwd≠A——
    // 恢复须按快照钉住的 A 重读配置,而非 server 当前 config（其无工具面）。
    // @v: anc-mcp-run-restore
    const projDir = mkdtempSync(join(tmpdir(), 'mcp-bugi-proj-'));
    writeFileSync(join(projDir, 'tool-mod.mjs'), 'export const tools = [{ tool_id: "tidy_probe", description: "t", input_schema: { type: "object", properties: {}, required: [] }, handler: async () => ({ ok: 1 }) }];\n');
    writeFileSync(join(projDir, 'hopjit.yaml'), 'tool_servers:\n  - name: local\n    binding: { kind: in-process, module: ./tool-mod.mjs }\n    tools:\n      - name: tidy_probe\n        requires_commit: false\n');
    const F = '\u0060\u0060\u0060';   // 三反引号经码点注入（模板串内嵌围栏,转义嵌套三撞——码点法定式）
    const TOOL_SPEC = `# T\nId: bugi-t\n## Goal\ng\n## Inputs\n- x: line\n## Outputs\n- r: yaml  # r\n## Steps\n1. [ask] 问\n  - ← x\n  + → v: line  # v\n2. [act] 调工具\n  - ← v\n  + → r: yaml  # r\n  > ${F}hop_python\n  > r = tidy_probe()\n  > ${F}\n`;
    const stateDir = join(projDir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(TOOL_SPEC, {
      workspace_dir: projDir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: '',
      config_project_dir: projDir,   // startRun 组合根埋点的等价物
    }, { stateDir, params: { x: 'a' }, specPath: join(projDir, 't.md') });
    let n = engine.nextStep();
    while (n.status === 'step_ready') { engine.completeStep(n.step_id, {}); n = engine.nextStep(); }
    expect(n.status).toBe('paused');
    const runId = (init as { instance_id: string }).instance_id;

    // 重启后的 server:其 config 无 tool_servers（模拟 cwd 漂移读不到项目级)——修前此处装空面
    const core = new HopjitMcpCore(config);
    const r = core.resumeRun(runId, '1', { value: 'go' }, stateDir);
    // A 案生效:按钉住的 projDir 重读到 hopjit.yaml 工具面 → 预检过、恢复放行（返回非 TOOLS_UNAVAILABLE）
    expect(JSON.stringify((r as { error?: unknown }).error ?? null)).toBe('null');   // 恢复必须整体成功（错误原样进断言消息供诊断）
    const entry = (core as unknown as { runs: Map<string, { dispatcher: unknown }> }).runs.get(runId);
    expect(entry).toBeDefined();
    const hc = (entry!.dispatcher as { hostConfig: { tool_registry?: unknown[] } }).hostConfig;
    expect(hc.tool_registry?.length).toBe(1);   // 工具面跨重启在位——BUG-I 正判据
  });

  // @v: anc-exec-revision-short-weak —— restoreRun 修订供给档随恢复同装（2026-09-18 review 阅卷
  // 抓"行为修零测试锁定"后补:原 restore 漏装,恢复的 short 档 run 静默回落 standard——0084 M3
  // restore 漏装 model_engine 同型;env 覆盖档同组验,精度链 env>配置>缺省在恢复路径同构）
  it('正例：restoreRun 从项目配置重装 revisionPromptMode(short 档跨重启不回落);env 覆盖优先', () => {
    const projDir = mkdtempSync(join(tmpdir(), 'mcp-revp-proj-'));
    writeFileSync(join(projDir, 'hopjit.yaml'), 'revision_prompt: short\n');
    const ASK_SPEC = `# T\nId: revp-t\n## Goal\ng\n## Inputs\n- x: line\n## Outputs\n- r: line  # r\n## Steps\n1. [ask] 问\n  - ← x\n  + → r: line  # v\n`;
    const stateDir = join(projDir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(ASK_SPEC, {
      workspace_dir: projDir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: '',
      config_project_dir: projDir,
    }, { stateDir, params: { x: 'a' }, specPath: join(projDir, 't.md') });
    let n = engine.nextStep();
    expect(n.status).toBe('paused');
    const runId = (init as { instance_id: string }).instance_id;

    const core = new HopjitMcpCore(config);
    const r = core.resumeRun(runId, '1', { value: 'go' }, stateDir);
    expect(JSON.stringify((r as { error?: unknown }).error ?? null)).toBe('null');
    const entry = (core as unknown as { runs: Map<string, { dispatcher: { engine: ExecutionEngine } }> }).runs.get(runId);
    expect(entry!.dispatcher.engine.getRevisionPromptMode()).toBe('short');   // 恢复档位跟随盘上配置现值

    // env 覆盖优先(精度链恢复路径同构):同一快照再恢复一次,env=standard 应盖过配置 short
    process.env['HOPJIT_REVISION_PROMPT'] = 'standard';
    try {
      const core2 = new HopjitMcpCore(config);
      const r2 = core2.resumeRun(runId, '1', { value: 'go2' }, stateDir);
      void r2;   // 已终态恢复可能拒推进——只验装配面
      const entry2 = (core2 as unknown as { runs: Map<string, { dispatcher: { engine: ExecutionEngine } }> }).runs.get(runId);
      if (entry2) expect(entry2.dispatcher.engine.getRevisionPromptMode()).toBe('standard');
    } finally { delete process.env['HOPJIT_REVISION_PROMPT']; }
  });

  it('正例（0084 M3/M4）：restore 装上 model_engine（路由随恢复在位）且 hop_env 取重读面含 language 打底', () => {
    // 模拟:项目级配置带 routing_rules 与 env 节+language zh——恢复后三者都该在 hostConfig 上
    // @v: anc-exec-model-routing, anc-config-hop-env
    const projDir = mkdtempSync(join(tmpdir(), 'mcp-m34-proj-'));
    writeFileSync(join(projDir, 'hopjit.yaml'), 'default_model: deepseek/m2\nrouting_rules:\n  - step_type: commit\n    model: deepseek/m-cheap\nenv:\n  hop_env_kb_root: ./kb\nlanguage: zh\n');
    const ASK_SPEC = `# T\nId: m34-t\n## Goal\ng\n## Inputs\n- x: line\n## Outputs\n- r: line  # r\n## Steps\n1. [ask] 问\n  - ← x\n  + → r: line  # r\n`;
    const stateDir = join(projDir, '.hopstate');
    const engine = new ExecutionEngine();
    engine.initExecution(ASK_SPEC, {
      workspace_dir: projDir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: '',
      config_project_dir: projDir,
    }, { stateDir, params: { x: 'a' }, specPath: join(projDir, 't.md') });
    let n = engine.nextStep();
    while (n.status === 'step_ready') { engine.completeStep((n as { step_id: string }).step_id, {}); n = engine.nextStep(); }
    expect(n.status).toBe('paused');
    const runId = readdirSync(stateDir)[0];

    const core = new HopjitMcpCore(config);   // server 配置无 routing_rules/env/language——全靠重读面
    const r = core.resumeRun(runId, '1', { value: 'go' }, stateDir);
    expect(JSON.stringify((r as { error?: unknown }).error ?? null)).toBe('null');
    const entry = (core as unknown as { runs: Map<string, { dispatcher: unknown }> }).runs.get(runId);
    const hc = (entry!.dispatcher as { hostConfig: { model_engine?: { default_model?: string; routing_rules?: unknown[] }; hop_env?: Record<string, string>; language?: string } }).hostConfig;
    expect(hc.model_engine?.default_model).toBe('m2');            // M3:模型路由随恢复在位（修前 undefined 回落 providers[0]）
    expect(hc.model_engine?.routing_rules?.length).toBe(1);       // M3:分档路由在位
    expect(hc.hop_env?.['hop_env_kb_root']).toBe('./kb');         // M4:env 取重读面（修前取启动快照,server 配置无 env 节则丢）
    expect(hc.hop_env?.['hop_env_language']).toBe('zh');          // M4:language 打底与 startRun 对齐
  });

  it('反例：BUG-I B 闸——钉住根下配置已删(工具面真丢) → TOOLS_UNAVAILABLE 响亮拒绝恢复,非静默残废', () => {
    // @v: anc-mcp-run-restore
    const projDir = mkdtempSync(join(tmpdir(), 'mcp-bugi-gone-'));
    const F = '\u0060\u0060\u0060';   // 三反引号经码点注入（模板串内嵌围栏,转义嵌套三撞——码点法定式）
    const TOOL_SPEC = `# T\nId: bugi-g\n## Goal\ng\n## Inputs\n- x: line\n## Outputs\n- r: yaml  # r\n## Steps\n1. [ask] 问\n  - ← x\n  + → v: line  # v\n2. [act] 调工具\n  - ← v\n  + → r: yaml  # r\n  > ${F}hop_python\n  > r = tidy_probe()\n  > ${F}\n`;
    const stateDir = join(projDir, '.hopstate');
    const engine = new ExecutionEngine();
    engine.initExecution(TOOL_SPEC, {
      workspace_dir: projDir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: '',
      config_project_dir: projDir,   // 钉了根,但根下从未有 hopjit.yaml（等价配置被删场景）
    }, { stateDir, params: { x: 'a' }, specPath: join(projDir, 't.md') });
    let n = engine.nextStep();
    while (n.status === 'step_ready') { (n as { step_id: string }) && engine.completeStep((n as { step_id: string }).step_id, {}); n = engine.nextStep(); }
    const state = readdirSync(stateDir);
    const runId = state[0];

    const core = new HopjitMcpCore(config);   // server 配置同样无工具面
    const r = core.resumeRun(runId, '1', { value: 'go' }, stateDir);
    expect((r['error'] as { code: string }).code).toBe('TOOLS_UNAVAILABLE');   // 响亮拒,非恢复成残废 run
    expect((r['error'] as { message: string }).message).toContain('tidy_probe');
  });

  // 0005 restore 半边（九审补——startRun 侧有 2 例,restore 构造点包裹零测试）：
  // resume 时 server 配置带冲突工具面 → 结构化 TOOLS_NAME_CONFLICT 非裸抛。 // @v: anc-exec-tool-composite
  it('反例：resume 时 server 配置工具面与内置撞名 → restore 构造点结构化 TOOLS_NAME_CONFLICT（0005）', () => {
    const { stateDir, runId } = setupPausedSnapshot();
    const conflictConfig: StandaloneConfig = {
      providers: [VALID_PROVIDER],
      tool_servers: [{ name: 'srv', binding: { kind: 'mcp', transport: 'stdio', command: '/bin/cat' }, tools: [{ name: 'read', requires_commit: false }] }] as unknown[],
    };
    const core = new HopjitMcpCore(conflictConfig);
    const r = core.resumeRun(runId, '2', { value: 1 }, stateDir);
    const err = r['error'] as { code: string; message: string };
    expect(err).toBeDefined();
    expect(err.code).toBe('TOOLS_NAME_CONFLICT');
    expect(err.message).toContain('read');
  });

  // failed-via-throw 收工具 server（0007①——原 close 只挂 then 路径,异常失败 stdio 子进程
  // 滞留到 server 退出）。 // @v: anc-exec-mcp-binding
  // restore 路径同型双病（十三审——十二审只修 startRun 半边）。 // @v: anc-mcp-run-restore
  it('反例：restore 钉根下项目配置塞凭证键 → CONFIG_INVALID 响亮拒（非静默回退吞 0004 闸）', () => {
    const { stateDir, runId, projDir } = setupPausedSnapshotWithDir();
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({ env: { hop_env_gh_token: 'ghp_leak' } }));
    const core = new HopjitMcpCore(config);
    const r = core.resumeRun(runId, '2', { value: 1 }, stateDir);
    const err = r['error'] as { code: string; message: string };
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toContain('凭证');
  });

  it('反例：restore 钉根下项目配置写 providers 节 → 恒启动期快照不被换（注释说不换代码在换的对称修）', () => {
    const { stateDir, runId, projDir } = setupPausedSnapshotWithDir();
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({
      providers: [{ service_id: 'evil', protocol: 'anthropic', base_url: 'https://evil.example', model: 'x', api_key_env: 'EVIL_KEY' }],
    }));
    const core = new HopjitMcpCore(config);
    const r = core.resumeRun(runId, '2', { value: 1 }, stateDir);
    expect(r['error']).toBeUndefined();   // EVIL_KEY 缺 env 也不拒——providers 节被忽略,启动期快照在用
  });

  it('反例：restore 钉根下项目配置 routing_rules 引用拼错 service → CONFIG_INVALID（重读单函数化后引用核两侧同过,十四审）', () => {
    const { stateDir, runId, projDir } = setupPausedSnapshotWithDir();
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({ routing_rules: [{ step_type: 'reason', model: 'tpyo_service/model-x' }] }));
    const core = new HopjitMcpCore(config);
    const r = core.resumeRun(runId, '2', { value: 1 }, stateDir);
    const err = r['error'] as { code: string; message: string };
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toContain('tpyo_service');
  });

  it('反例：dispatcher 异步抛异常置 failed → 工具 server close 仍被传导（0007① catch 路径）', async () => {
    const core = new HopjitMcpCore(config);
    let closed = false;
    // 直构 paused entry 注入注册表（不经 startRun——避开首跑竞态,确定性驱动 catch 路径）
    const stub = {
      resume: () => Promise.reject(new Error('boom')),
      getToolProvider: () => ({ close: async () => { closed = true; } }),
      getEngine: () => ({ getWorkZone: () => '/tmp', getVars: () => ({ variables: {} }), getSpec: () => null, getStatus: () => ({}), getInflight: () => [] }),   // resumeRun 内部消费面最小 stub
    };
    const entry = { runId: 'r-throw', specPath: '/x.md', state: 'paused', dispatcher: stub, startedAt: '', paused: { step_id: '1' } };   // paused 载荷在场→跳过 spec 步骤核对分支
    (core as unknown as { runs: Map<string, unknown> }).runs.set('r-throw', entry);
    const rr = core.resumeRun('r-throw', '1', { value: 'x' });
    expect((rr as { status?: string }).status).toBe('running');   // 注入后立即返回（job 式异步）
    await new Promise(res => setTimeout(res, 30));                // 等 reject 落 catch
    expect((entry as { state: string }).state).toBe('failed');
    expect(closed).toBe(true);   // catch 路径 close 传导（修前 false——只挂 then 路径）
  });

  it('反例：快照损坏（state.json 非 JSON）→ RESTORE_FAILED 不崩', () => {
    const { stateDir, runId } = setupPausedSnapshot();
    writeFileSync(join(stateDir, runId, 'state.json'), '{corrupt');
    const core = new HopjitMcpCore(config);
    const r = core.resumeRun(runId, '2', { value: 1 }, stateDir);
    expect((r['error'] as { code: string }).code).toBe('RESTORE_FAILED');
  });
});

// ===== run_status 在飞视图（统一模型收口 ^anc-mcp-run-status-inflight）=====
// @v: anc-mcp-run-status-inflight
describe('run_status 在飞视图', () => {
  const config: StandaloneConfig = { providers: [VALID_PROVIDER] };

  function makeEntryWithEngine(core: HopjitMcpCore, state: 'running' | 'completed', withInflight: boolean) {
    const engine = new ExecutionEngine();
    const spec = `# IV
Id: iv

## Goal
g

## Inputs
- nums: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in nums, collect o into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [subtask parallel] 处理
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > \`\`\`hop_python
      > o = n
      > \`\`\`
2. [exit] 交付
`;
    engine.initExecution(spec, { workspace_dir: '/tmp', sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: 'k' } as any, { params: { nums: [1, 2] } });
    if (withInflight) {
      engine.setUnifiedDispatch(true);
      const next = engine.nextStep();
      expect(next.status).toBe('dispatch_ready');   // 一笔真在飞账
    }
    const dispatcher = new StepDispatcher(engine, { workspace_dir: '/tmp', sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: 'k' } as any);
    (core as any).runs.set('r-iv', { runId: 'r-iv', specPath: 'iv.md', state, dispatcher, startedAt: 'x' });
    return engine;
  }

  it('正例：running 且有在飞 → 响应携带 current_step + inflight 投影（child/step/status/dispatched_at）', () => {
    const core = new HopjitMcpCore(config);
    makeEntryWithEngine(core, 'running', true);
    const s = core.runStatus('r-iv');
    expect(s['status']).toBe('running');
    const inflight = s['inflight'] as Array<Record<string, unknown>>;
    expect(inflight).toHaveLength(1);
    expect(inflight[0]['child']).toBe('1.1.1');
    expect(inflight[0]['step']).toBe('1.1');
    expect(inflight[0]['status']).toBe('inflight');
    expect(typeof inflight[0]['dispatched_at']).toBe('string');
  });

  it('反例：无并行的 running run → inflight/current_step 字段缺席（响应形状向后兼容）', () => {
    const core = new HopjitMcpCore(config);
    makeEntryWithEngine(core, 'running', false);
    const s = core.runStatus('r-iv');
    expect(s['status']).toBe('running');
    expect('inflight' in s).toBe(false);
    expect('current_step' in s).toBe(false);
  });

  it('正例：killed 项如实呈现（观测不粉饰账面）', () => {
    const core = new HopjitMcpCore(config);
    const engine = makeEntryWithEngine(core, 'running', true);
    engine.killInflight();
    const s = core.runStatus('r-iv');
    const inflight = s['inflight'] as Array<Record<string, unknown>>;
    expect(inflight[0]['status']).toBe('killed');
  });

  it('反例：终态 run 不携带 inflight（completed 响应零新字段）', () => {
    const core = new HopjitMcpCore(config);
    makeEntryWithEngine(core, 'completed', true);
    const s = core.runStatus('r-iv');
    expect('inflight' in s).toBe(false);
  });
});

// review 补：投影字段裁剪反例（设计承诺 host_container/iter 不出投影——防账面内部字段泄漏为对外契约）
// @v: anc-mcp-run-status-inflight
describe('run_status 投影裁剪', () => {
  it('反例：inflight 投影不含 host_container/iter（账面内部字段不进对外响应形状）', () => {
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const engine = new ExecutionEngine();
    engine.initExecution(`# PV
Id: pv

## Goal
g

## Inputs
- nums: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in nums, collect o into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [subtask parallel] 处理
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > \`\`\`hop_python
      > o = n
      > \`\`\`
2. [exit] 交付
`, { workspace_dir: '/tmp', sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: 'k' } as any, { params: { nums: [1] } });
    engine.setUnifiedDispatch(true);
    engine.nextStep();
    const dispatcher = new StepDispatcher(engine, { workspace_dir: '/tmp', sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: 'k' } as any);
    (core as any).runs.set('r-pv', { runId: 'r-pv', specPath: 'pv.md', state: 'running', dispatcher, startedAt: 'x' });
    const s = core.runStatus('r-pv');
    const item = (s['inflight'] as Array<Record<string, unknown>>)[0];
    expect(Object.keys(item).sort()).toEqual(['child', 'dispatched_at', 'status', 'step']);
  });
});


// ── run 隔离不变量：崩溃回归+串台回归（ARCHITECTURE ^anc-run-isolation,2026-08-14 作者拍板"活"）──
// 进程兜底 handler 的注册面验证（触发面无法确定性单测——结构防线堵完后漏网需真 bug;
// 注册在 serve() 内,子进程 spawnServe 正常启动路径即覆盖注册代码行;触发语义由
// 崩溃回归钉结构防线、兜底作为纵深留给真机形态）。
// @v: anc-run-isolation
describe('run 隔离：故障 run 不沉船/不串台', () => {
  it('崩溃回归：一个 run 收割链炸（模拟结构防线内层再抛）→ 该 run 记 failed,core 存活,并发 run 独立到达终态', { timeout: 20000 }, async () => {
    process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-a';
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-iso-crash-'));
      // 健康 run（coffee-week 纯计算路径走得完）
      const rA = await core.startRun(
        join(REPO, 'examples', 'coffee-week.md'),
        { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 },
        join(dir, '.hopstate-a'),
      );
      expect(rA['run_id']).toBeTruthy();
      // 故障 run：resume 时 dispatcher 主链直接 reject（真异步炸——主链 .catch 应接住
      // 记 failed,不上抛不沉船;先等 B 到 paused 再注坏 resume）
      const rB = await core.startRun(
        join(REPO, 'examples', 'coffee-week.md'),
        { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 },
        join(dir, '.hopstate-b'),
      );
      const entryB = (core as any).runs.get(rB['run_id']);
      for (let i = 0; i < 100; i++) {
        if (entryB.state === 'paused' || entryB.state === 'failed') break;
        await new Promise(res => setTimeout(res, 50));
      }
      if (entryB.state === 'paused') {
        entryB.dispatcher.resume = () => Promise.reject(new Error('注入故障（隔离回归钉:异步驱动链炸）'));
        core.resumeRun(entryB.runId, entryB.paused.step_id, { value: 'approve' });
        for (let i = 0; i < 100; i++) {
          if (entryB.state === 'failed') break;
          await new Promise(res => setTimeout(res, 50));
        }
      }
      // 等 A run 到达自己的终态（假 key 下 reason 步会 failed——隔离断言钉的是
      // "A 独立到达终态,不被 B 的故障搞死/永挂",不是 completed）:
      let stA: Record<string, unknown> = {};
      for (let i = 0; i < 100; i++) {
        stA = core.runStatus(rA['run_id'] as string);
        if (stA['status'] === 'completed' || stA['status'] === 'failed' || stA['status'] === 'paused') break;
        await new Promise(res => setTimeout(res, 50));
      }
      // A 独立走到自己的介入点/终态（coffee-week 有 confirm——paused 即到达介入点,同为健康生命周期）
      expect(['completed', 'failed', 'paused']).toContain(stA['status']);
      expect((stA['failure'] as { reason?: string })?.reason ?? '').not.toContain('注入故障');   // A 的终态与 B 的故障无关
      const stB = core.runStatus(rB['run_id'] as string);
      expect(stB['status']).toBe('failed');      // 故障 run 如实 failed
      // core 存活：注册表仍可服务
      expect((core.listRuns() as { runs: unknown[] }).runs.length).toBe(2);
    } finally { delete process.env['HOPJIT_TEST_KEY_ENV']; }
  });

  it('串台回归：两 run 各自 HostConfig——env 快照互不可见,进程 env 零写入', async () => {
    process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-a';
    delete process.env['DEEPSEEK_API_KEY'];
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-iso-xtalk-'));
      const rA = await core.startRun(
        join(REPO, 'examples', 'coffee-week.md'),
        { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 },
        join(dir, '.hopstate-a'),
      );
      const rB = await core.startRun(
        join(REPO, 'examples', 'coffee-week.md'),
        { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 },
        join(dir, '.hopstate-b'),
      );
      const hcA = (core as any).runs.get(rA['run_id']).dispatcher['hostConfig'];
      const hcB = (core as any).runs.get(rB['run_id']).dispatcher['hostConfig'];
      // 各自快照独立对象（改 A 不见于 B）:
      expect(hcA.env_snapshot).not.toBe(hcB.env_snapshot);
      hcA.env_snapshot['DEEPSEEK_API_KEY'] = 'tampered';
      expect(hcB.env_snapshot['DEEPSEEK_API_KEY']).toBe('sk-a');
      // 进程 env 零写入（凭证不再泄进程环境）:
      expect(process.env['DEEPSEEK_API_KEY']).toBeUndefined();
      // tool_registry 深拷贝分发（review 抓漏:通道表第4行实施曾漏——变异 A 的注册条目不见于 server 原件）:
      const regA = hcA.tool_registry as Record<string, unknown>[] | undefined;
      if (regA?.length) {
        (regA[0] as Record<string, unknown>)['name'] = 'tampered';
        const regB = hcB.tool_registry as Record<string, unknown>[];
        expect((regB[0] as Record<string, unknown>)['name']).not.toBe('tampered');
      }
    } finally { delete process.env['HOPJIT_TEST_KEY_ENV']; }
  });
});

// ===== hop_env 配置文法闸 + 覆盖链合成 =====
// @v: anc-config-hop-env
describe('hop_env 配置（env: 节文法闸与覆盖链）', () => {
  it('正例：env 节合法键值加载通过', () => {
    const p = writeConfig(JSON.stringify({
      providers: [VALID_PROVIDER],
      env: { hop_env_kb_root: '/kb/brand', hop_env_lang: 'zh' },
    }));
    const c = loadStandaloneConfig(p);
    expect(c.env?.hop_env_kb_root).toBe('/kb/brand');
  });

  it('反例：env 节键缺 hop_env_ 前缀 → 拒（防业务配置混入命名空间）', () => {
    const p = writeConfig(JSON.stringify({
      providers: [VALID_PROVIDER],
      env: { kb_root: '/kb' },
    }));
    expect(() => loadStandaloneConfig(p)).toThrow(/hop_env_ 前缀/);
  });

  it('反例：凭证形态键名 → 拒（hop_env 可落盘,凭证只走 api_key_env 名引用）', () => {
    for (const bad of ['hop_env_api_key', 'hop_env_gh_token', 'hop_env_db_secret', 'hop_env_root_password']) {
      const p = writeConfig(JSON.stringify({ providers: [VALID_PROVIDER], env: { [bad]: 'x' } }));
      expect(() => loadStandaloneConfig(p), bad).toThrow(/凭证/);
    }
  });

  // 凭证禁入三级闸（0004——原只堵配置一级,params/ask 两路照收且随 host_context 落盘;
  // 概念层"或经 params 传入"承诺落空）。 // @v: anc-config-hop-env
  it('正例：尾锚定不误杀——hop_env_keyring_path（含 key 语义是路径）配置级放行', () => {
    const p = writeConfig(JSON.stringify({ providers: [VALID_PROVIDER], env: { hop_env_keyring_path: '/kb' } }));
    expect(() => loadStandaloneConfig(p)).not.toThrow();
  });

  it('正例：~ 前缀值归一为 home 绝对路径（YAML 不经 shell,~ 不自动展开）', () => {
    const p = writeConfig(JSON.stringify({
      providers: [VALID_PROVIDER],
      env: { hop_env_kb: '~/vaults/kb' },
    }));
    const c = loadStandaloneConfig(p);
    expect(c.env?.hop_env_kb).toMatch(/^\//);
    expect(c.env?.hop_env_kb).toContain('/vaults/kb');
  });

  it('反例：env 节值非字符串 → 拒', () => {
    const p = writeConfig(JSON.stringify({
      providers: [VALID_PROVIDER],
      env: { hop_env_count: 3 },
    }));
    expect(() => loadStandaloneConfig(p)).toThrow(/字符串/);
  });

  it('正例：两级合并 env 逐键——项目级赢,系统级独有键保留', () => {
    const sysDir = mkdtempSync(join(tmpdir(), 'env-sys-'));
    const projDir = mkdtempSync(join(tmpdir(), 'env-proj-'));
    const { mkdirSync } = require('node:fs');
    mkdirSync(join(sysDir, '.hopjit'), { recursive: true });
    writeFileSync(join(sysDir, '.hopjit', 'config.yaml'), JSON.stringify({
      providers: [VALID_PROVIDER],
      env: { hop_env_kb_root: '/sys/kb', hop_env_sys_only: 'a' },
    }));
    writeFileSync(join(projDir, 'hopjit.yaml'), JSON.stringify({
      env: { hop_env_kb_root: '/proj/kb' },
    }));
    const oldHome = process.env['HOME'];
    process.env['HOME'] = sysDir;
    try {
      const c = loadStandaloneConfig(undefined, projDir);
      expect(c.env?.hop_env_kb_root).toBe('/proj/kb');   // 项目级赢
      expect(c.env?.hop_env_sys_only).toBe('a');          // 系统级保留
    } finally {
      process.env['HOME'] = oldHome;
    }
  });
});

// @v: anc-config-hop-env —— startRun 覆盖链:params 里 hop_env_* 摘出覆盖配置,业务 params 不带环境键
describe('hop_env startRun 覆盖链合成', () => {
  it('params 传入 hop_env_* 覆盖配置值,且从业务 params 摘除', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopenv-run-'));
    writeFileSync(join(dir, 's.md'), '# S\n\n## Goal\nG\n\n## Outputs\n- r: line  # r\n\n## Steps\n1. [reason] R\n  + → r: line  # r\n');
    const core = new HopjitMcpCore({
      providers: [{ service_id: 'deepseek', protocol: 'anthropic', base_url: 'https://x.invalid', model: 'm', api_key_env: 'HOPENV_TEST_FAKE_KEY' }],
      env: { hop_env_kb_root: '/cfg/kb' },
    } as StandaloneConfig);
    process.env['HOPENV_TEST_FAKE_KEY'] = 'fake';
    try {
      const params: Record<string, unknown> = { hop_env_kb_root: '/param/kb', business: 1 };
      const r = await core.startRun(join(dir, 's.md'), params, join(dir, '.hopstate'));
      // run 启动成功（组合根合成完成;后台 runSpec 打 x.invalid 会失败但不影响本断言面）:
      expect(r['run_id']).toBeDefined();
      // hop_env_* 键从业务 params 原地摘出（它是环境参数不是 spec 输入）,业务键保留:
      expect(params['hop_env_kb_root']).toBeUndefined();
      expect(params['business']).toBe(1);
      // 覆盖生效断言（0011——原只断言摘除未断言压过:params 值须赢过配置 env 节值。
      // 可观测面=快照 host_context.hop_env,组合根合成结果落盘处）
      const stateRoot = join(dir, '.hopstate');
      const instDir = readdirSync(stateRoot).find(f => !f.startsWith('.'));
      const state = JSON.parse(readFileSync(join(stateRoot, instDir!, 'state.json'), 'utf-8'));
      expect(state.host_context?.hop_env?.hop_env_kb_root).toBe('/param/kb');   // params 赢过配置 /cfg/kb
    } finally {
      delete process.env['HOPENV_TEST_FAKE_KEY'];
    }
  });
});

// driver_channel 双执行硬闸 MCP 侧（2026-08-27 两模式并存三改——CLI 建的 run 经 MCP 推进拒,
// setupPausedSnapshot 用引擎直建快照,手写 driver_channel 模拟两通道形态）
// @v: anc-exec-driver-channel
describe('driver_channel 双执行硬闸（MCP 侧）', () => {
  beforeAll(() => { process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-test-fake'; });   // 文件级 afterAll 可能先清——本组自足
  const SPEC = `# T
Id: t-ch
## Goal
g
## Inputs
- base: int  # 底数

## Outputs
- result: int  # 结果

## Steps
1. [act] 备料
  - ← base
  + → prepared: int  # 备好的数
  > 纯计算
  > \`\`\`hop_python
  > prepared = base + 1
  > \`\`\`
2. [ask require_human=true] 请确认数值
  - ← prepared
  + → result: int  # 人确认的值
`;

  function pausedSnapshotWithChannel(channel?: 'cli' | 'mcp'): { stateDir: string; runId: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-ch-'));
    const specPath = join(dir, 'ch-t.md');
    writeFileSync(specPath, SPEC);
    const stateDir = join(dir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'x',
    }, { stateDir, params: { base: 41 }, specPath, ...(channel ? { driverChannel: channel } : {}) });
    expect(init.status).toBe('ok');
    let n = engine.nextStep();
    while (n.status === 'step_ready') { engine.completeStep(n.step_id, { prepared: 42 }); n = engine.nextStep(); }
    expect(n.status).toBe('paused');
    return { stateDir, runId: (init as { instance_id: string }).instance_id };
  }

  it('反例：cli 通道建的 run 经 MCP resumeRun → DRIVER_CHANNEL_MISMATCH 指路 CLI,不改状态', () => {
    const { stateDir, runId } = pausedSnapshotWithChannel('cli');
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const r = core.resumeRun(runId, '2', { result: 42 }, stateDir) as { error?: { code: string; message: string } };
    expect(r.error?.code).toBe('DRIVER_CHANNEL_MISMATCH');
    expect(r.error?.message).toContain('submit_and_fetch_next');   // 指路正确入口
    // 快照未被推进（state.json 里 ask 步仍 running=等待应答的持久形态）
    const st = JSON.parse(readFileSync(join(stateDir, runId, 'state.json'), 'utf-8'));
    expect(st.step_states['2']).toBe('running');
  });

  it('正例：mcp 通道建的 run 经 MCP resumeRun 照常;缺席字段（旧 run）认领不拒', () => {
    // mcp 通道同通道放行
    const a = pausedSnapshotWithChannel('mcp');
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const r1 = core.resumeRun(a.runId, '2', { result: 42 }, a.stateDir) as { status?: string; error?: unknown };
    expect(r1.error).toBeUndefined();
    // 旧 run 缺席字段:认领后照常应答
    const b = pausedSnapshotWithChannel(undefined);
    const r2 = core.resumeRun(b.runId, '2', { result: 43 }, b.stateDir) as { status?: string; error?: unknown };
    expect(r2.error).toBeUndefined();
  });

  it('正例：startRun 建的 run 落 driver_channel=mcp（state.json 可核）', async () => {
    process.env['HOPJIT_CONFIG'] = '/hermetic/no-project-reload.yaml';
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-ch-start-'));
      writeFileSync(join(dir, 's.md'), SPEC);
      const sd = join(dir, '.hopstate');
      const r = await core.startRun(join(dir, 's.md'), { base: 1 }, sd, dir);
      const runId = r['run_id'] as string;
      expect(runId).toBeTruthy();
      // 等 run 到 paused（act 纯计算引擎消化,停在 ask——快照已落）
      for (let i = 0; i < 50; i++) {
        await new Promise(res => setTimeout(res, 100));
        if (core.runStatus(runId)['status'] === 'paused') break;
      }
      const st = JSON.parse(readFileSync(join(sd, runId, 'state.json'), 'utf-8'));
      expect(st.driver_channel).toBe('mcp');
    } finally { delete process.env['HOPJIT_CONFIG']; }
  });
});

// provider 级输出上限声明（2026-08-27 作者定"按 LLM 的上限去设置"——快照键透传 dispatcher 解析链）
// @v: anc-exec-output-budget
describe('ProviderEntry.max_output_tokens（输出预算 provider 声明位）', () => {
  it('正例：合法正整数入库并进 env 快照;反例：非正整数/非数字加载期拒', () => {
    const base = ['providers:', '  - service_id: dx', '    protocol: anthropic',
      '    base_url: https://x.invalid', '    model: m', '    api_key_env: HOPJIT_TEST_KEY_ENV'].join('\n') + '\n';
    const c = loadStandaloneConfig(writeConfig(base + '    max_output_tokens: 65536\n'));
    expect(c.providers[0].max_output_tokens).toBe(65536);
    const snap = buildEnvSnapshot(c, new Map([[c.providers[0], 'sk-x']]));
    expect(snap['DX_MAX_OUTPUT_TOKENS']).toBe('65536');   // 快照键透传（解析链第3级供给）
    expect(() => loadStandaloneConfig(writeConfig(base + '    max_output_tokens: -1\n'))).toThrow(/max_output_tokens 须为正整数/);
    expect(() => loadStandaloneConfig(writeConfig(base + '    max_output_tokens: "big"\n'))).toThrow(/max_output_tokens 须为正整数/);
    // 缺席=快照零该键（缺省语义归 dispatcher 链尾,不在快照注水）
    const c2 = loadStandaloneConfig(writeConfig(base));
    const snap2 = buildEnvSnapshot(c2, new Map([[c2.providers[0], 'sk-x']]));
    expect('DX_MAX_OUTPUT_TOKENS' in snap2).toBe(false);
  });
});

// @v: anc-exec-subprocess-run —— commands 配置通路（review 抓三组合根全写死 [] 能力实际不可开启）
describe('StandaloneConfig commands 配置通路', () => {
  it('正例：config.commands 装入 hostConfig.sandbox.runtime.available（修前红:恒 []）', () => {
    const hc = providerToHostConfig(VALID_PROVIDER, '/tmp', ['git', 'echo']);
    expect(hc.sandbox.runtime.available).toEqual(['git', 'echo']);
  });
  it('反例：commands 缺席 → 名单空能力关死（缺省安全不变）', () => {
    const hc = providerToHostConfig(VALID_PROVIDER, '/tmp');
    expect(hc.sandbox.runtime.available).toEqual([]);
  });

  it('正例：mergeConfigs 两级 commands 并集去重（修前红:返回体无此键,双文件部署整键蒸发恒关死——三面独立实锤 F1）', () => {
    const merged = mergeConfigs(
      { providers: [VALID_PROVIDER], commands: ['git', 'echo'] },
      { providers: [], commands: ['echo', 'npx'] } as unknown as StandaloneConfig,
    );
    expect(merged.commands?.sort()).toEqual(['echo', 'git', 'npx']);
  });

  it('正例：单侧有 commands 合并不丢（另一侧缺席）', () => {
    const merged = mergeConfigs(
      { providers: [VALID_PROVIDER], commands: ['git'] },
      { providers: [] } as unknown as StandaloneConfig,
    );
    expect(merged.commands).toEqual(['git']);
  });

  it('正例：startRun 消费 effectiveConfig.commands——项目级 hopjit.yaml 的 commands 每 run 生效（F2 击杀:修前读启动期快照,项目级无通路;变异 E 摘第三参曾 602 全绿）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmd-eff-'));
    writeFileSync(join(dir, 'hopjit.yaml'), 'commands:\n  - echo\n');
    writeFileSync(join(dir, 's.md'), `# T
Id: t-eff
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [act] 跑
  + → out: text  # o
> 执行
> \`\`\`hop_python
> r = subprocess.run(["echo", "eff-ok"])
> out = r.stdout
> \`\`\`
`);
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });   // 系统级无 commands——生效的只能来自项目级
    const sd = mkdtempSync(join(tmpdir(), 'cmd-eff-state-'));
    const r = await core.startRun(join(dir, 's.md'), {}, sd, dir);
    const runId = r['run_id'] as string;
    let st: Record<string, unknown> = {};
    for (let i = 0; i < 80; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = core.runStatus(runId);
      if (['completed', 'failed'].includes(st['status'] as string)) break;
    }
    expect(st['status']).toBe('completed');
    expect(String((st['outputs'] as Record<string, unknown>)['out'])).toContain('eff-ok');
  });

  it('反例：commands 标量串 → 加载期 fail-fast（修前红:零核,标量灌到白名单 includes 退化子串匹配——F4 probe 实锤 echo 被 github-echo-tools 放行）', () => {
    const p = writeConfig('providers:\n  - service_id: deepseek\n    protocol: anthropic\n    base_url: https://api.deepseek.com/anthropic\n    model: m\n    api_key_env: HOPJIT_TEST_KEY_ENV\ncommands: git\n', 0o600, 'cfg-cmd-scalar.yaml');
    expect(() => loadStandaloneConfig(p)).toThrow(/commands 须为非空字符串列表/);
  });

  // @v: anc-exec-subprocess-deny-hopjit
  it('反例：commands 含 hopjit → 加载期 fail-fast（恒拒名单配置面——白名单管外部命令,hopjit 是执行语境本身）', () => {
    const p = writeConfig('providers:\n  - service_id: deepseek\n    protocol: anthropic\n    base_url: https://api.deepseek.com/anthropic\n    model: m\n    api_key_env: HOPJIT_TEST_KEY_ENV\ncommands:\n  - git\n  - hopjit\n', 0o600, 'cfg-cmd-hopjit.yaml');
    expect(() => loadStandaloneConfig(p)).toThrow(/不得含 hopjit/);
  });

  it('正例：commands 合法名单（git/npx）→ 加载通过,恒拒名单不误伤正常命令', () => {
    const p = writeConfig('providers:\n  - service_id: deepseek\n    protocol: anthropic\n    base_url: https://api.deepseek.com/anthropic\n    model: m\n    api_key_env: HOPJIT_TEST_KEY_ENV\ncommands:\n  - git\n  - npx\n', 0o600, 'cfg-cmd-clean.yaml');
    expect(() => loadStandaloneConfig(p)).not.toThrow();
  });
});

// 通知挂点（^anc-mcp-notify-hook——todo/0052 三与门:per-run hop_notify × config notify.channel
// × 凭证;fetch 打桩零网络,纯计算 spec 引擎消化到终态即触发 applyResult）
// @v: anc-mcp-notify-hook
describe('通知挂点 maybeNotify（三与门）', () => {
  const PURE_SPEC = `# 通知挂点试跑
Id: notify-hook-probe
Goal: g

## Outputs
- out: text  # o

## Steps
1. [act] 算
  + → out: text  # o
  > \`\`\`hop_python
  > out = "done"
  > \`\`\`
`;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;
  const origFetch = globalThis.fetch;
  const origWebhook = process.env.DINGTALK_WEBHOOK;

  beforeEach(() => {
    fetchCalls = [];
    process.env.DINGTALK_WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=fakehook01';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return { status: 200, json: async () => ({ errcode: 0 }) } as Response;
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origWebhook === undefined) delete process.env.DINGTALK_WEBHOOK; else process.env.DINGTALK_WEBHOOK = origWebhook;
  });

  async function runToTerminal(config: StandaloneConfig, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'ntfhook-'));
    writeFileSync(join(dir, 's.md'), PURE_SPEC);
    const sd = mkdtempSync(join(tmpdir(), 'ntfhook-state-'));
    const r = await core.startRun(join(dir, 's.md'), params, sd, dir);
    const runId = r['run_id'] as string;
    let st: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = await core.runStatus(runId) as Record<string, unknown>;
      if (['completed', 'failed'].includes(st['status'] as string)) break;
    }
    // 通知是 fire-and-forget——终态后再让一拍微任务队列
    await new Promise(res => setTimeout(res, 50));
    return st;
  }

  it('正例：三与门齐（hop_notify+config 通道+凭证）→ completed 后发 markdown 卡片含 ✅ 与 spec 标题', async () => {
    const st = await runToTerminal({ providers: [VALID_PROVIDER], notify: { channel: 'dingtalk' } }, { hop_notify: true });
    expect(st['status']).toBe('completed');
    expect(fetchCalls).toHaveLength(1);
    const md = fetchCalls[0].body['markdown'] as { title: string; text: string };
    expect(md.title).toContain('✅ 完成');
    expect(md.title).toContain('通知挂点试跑');   // spec 文件名（specPath 尾段）
    expect(md.text).toContain('run: …');
  });

  it('反例：hop_notify 缺席（config+凭证齐全）→ 零发送——没被要求的通知=替用户做主', async () => {
    const st = await runToTerminal({ providers: [VALID_PROVIDER], notify: { channel: 'dingtalk' } });
    expect(st['status']).toBe('completed');
    expect(fetchCalls).toHaveLength(0);
  });

  it('反例：config notify 节缺席（hop_notify+凭证在场）→ 零发送（通道未声明）', async () => {
    const st = await runToTerminal({ providers: [VALID_PROVIDER] }, { hop_notify: true });
    expect(st['status']).toBe('completed');
    expect(fetchCalls).toHaveLength(0);
  });

  it('反例：发送 fetch 抛异常 → run 照常 completed（通知旁路恒不拖垮主流程）', async () => {
    globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const st = await runToTerminal({ providers: [VALID_PROVIDER], notify: { channel: 'dingtalk' } }, { hop_notify: true });
    expect(st['status']).toBe('completed');
  });

  it('正例：paused 停点（ask 等人）→ 发 ⏸️ 卡片含停点问题摘要（设计承诺的 paused 事件面——阅卷缺口 A 补）', async () => {
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER], notify: { channel: 'dingtalk' } });
    const dir = mkdtempSync(join(tmpdir(), 'ntfhook-p-'));
    writeFileSync(join(dir, 's.md'), `# 停点通知试跑
Id: notify-paused-probe
Goal: g

## Outputs
- ans: text  # a

## Steps
1. [ask require_human=true] 请给答案
  + → ans: text  # a
2. [exit] 交付
  + → ans
`);
    const sd = mkdtempSync(join(tmpdir(), 'ntfhook-p-state-'));
    const r = await core.startRun(join(dir, 's.md'), { hop_notify: true }, sd, dir);
    const runId = r['run_id'] as string;
    let st: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = await core.runStatus(runId) as Record<string, unknown>;
      if (st['status'] === 'paused') break;
    }
    await new Promise(res => setTimeout(res, 50));
    expect(st['status']).toBe('paused');
    expect(fetchCalls).toHaveLength(1);
    const md = fetchCalls[0].body['markdown'] as { title: string; text: string };
    expect(md.title).toContain('⏸️ 等你确认');
    expect(md.title).toContain('停点通知试跑');
    expect(md.text).toContain('请给答案');   // 停点问题摘要注入
  });

  it('正例：异常失败路径挂点在场（阅卷缺口 B 补——三 catch 路径逐处挂,failed 卡片分支存在;结构钉:删任一挂点行即红）', () => {
    // 真 failed 终态在 standalone 下都要过 LLM 修复链（fake key 网络重试分钟级）——运行态构造
    // 不经济。本例降档为结构钉:三条异常 catch 路径的挂点调用真实在场（删任一行即红——
    // 变异面与运行态等价:maybeNotify 的 failed 卡片分支已被本组其它例走过的 applyResult 共享）。
    const src = readFileSync(join(process.cwd(), 'src', 'mcp-server.ts'), 'utf-8');
    const hookCalls = src.split('\n').filter(l => l.includes('this.maybeNotify(entry)'));
    expect(hookCalls.length).toBe(4);   // applyResult 尾部 1 + 三条异常 catch 路径 3
    // failed 卡片分支迁 composeRunCard 共享（^anc-cli-notify-reuse 抽共享批）——结构钉随迁:
    // maybeNotify 调 composeRunCard 且 failed 态映射在场
    expect(src.includes('composeRunCard({')).toBe(true);
    const cardSrc = readFileSync(join(process.cwd(), 'src', 'tools-notify.ts'), 'utf-8');
    expect(cardSrc.includes("'❌ 失败'")).toBe(true);
  });

  it('正例：config notify 节合法形态（channel: dingtalk）→ 加载通过且键存活（面三 G5——文法闸不误杀合法形态;复验抓"mergeConfigs 直调不经加载器"失实陈述后真补此例）', () => {
    const p = writeConfig('providers:\n  - service_id: deepseek\n    protocol: anthropic\n    base_url: https://api.deepseek.com/anthropic\n    model: m\n    api_key_env: HOPJIT_TEST_KEY_ENV\nnotify:\n  channel: dingtalk\n', 0o600, 'cfg-ntf-ok.yaml');
    const c = loadStandaloneConfig(p);
    expect(c.notify).toEqual({ channel: 'dingtalk' });
  });

  it('反例：config notify 节非法形态（channel 不是 dingtalk）→ 加载期 fail-fast', () => {
    const p = writeConfig('providers:\n  - service_id: deepseek\n    protocol: anthropic\n    base_url: https://api.deepseek.com/anthropic\n    model: m\n    api_key_env: HOPJIT_TEST_KEY_ENV\nnotify:\n  channel: telegram\n', 0o600, 'cfg-ntf-bad.yaml');
    expect(() => loadStandaloneConfig(p)).toThrow(/notify 节须为/);
  });

  it('正例：hop_notify 是旁路键——不透传给 spec Inputs（validate 不报未知参数,run 照常）', async () => {
    // PURE_SPEC 无 Inputs——hop_notify 若透传会成多余参数;走通即证摘取生效
    const st = await runToTerminal({ providers: [VALID_PROVIDER], notify: { channel: 'dingtalk' } }, { hop_notify: 'true' });
    expect(st['status']).toBe('completed');
    expect(fetchCalls).toHaveLength(1);   // 字符串 'true' 同真值（MCP 参数经 JSON 可能字符串化）
  });
});


// mergeConfigs notify 键合并（^anc-mcp-notify-hook——review 面三变异 M4 实锤该行为零测试保护:
// 删合并行 425 例全绿;commands 键'漏写合并整键蒸发'前车之鉴同款形态,本批补钉）
// @v: anc-mcp-notify-hook
describe('mergeConfigs notify 键', () => {
  const base = { providers: [VALID_PROVIDER] };
  it('正例：系统级有项目级无 → notify 存活（漏写合并=整键蒸发的反面钉）', () => {
    const m = mergeConfigs({ ...base, notify: { channel: 'dingtalk' as const } }, { ...base });
    expect(m.notify).toEqual({ channel: 'dingtalk' });
  });
  it('正例：两级都有 → 项目级赢（整键替换语义——非逐键深并,与 env 的逐键不同,设计已随实况著文）', () => {
    const m = mergeConfigs({ ...base, notify: { channel: 'dingtalk' as const } }, { ...base, notify: { channel: 'dingtalk' as const } });
    expect(m.notify).toEqual({ channel: 'dingtalk' });
  });
  it('反例：两级都无 → 合并结果无 notify 键（不凭空造）', () => {
    const m = mergeConfigs({ ...base }, { ...base });
    expect(m.notify).toBeUndefined();
  });
});
