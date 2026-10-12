// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: mcp-server ^anc-struct-mcp-server
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { collectLiveRunDirs } from '../src/hoplog.js';
import {
  loadStandaloneConfig,
  mergeConfigs,
  buildEnvSnapshot,
  providerToHostConfig,
  collectSpecTools,
  HopjitMcpCore,
  buildServer,
  resolveCommitAnalyzerProvider,
  type StandaloneConfig,
  type ProviderEntry,
} from '../src/mcp-server.js';
import { parseSpec } from '../src/parser.js';
import { ExecutionEngine } from '../src/engine.js';
import type { HostConfig } from '../src/provider-types.js';
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

  // @v: anc-exec-thinking-disable-unsupported —— 思考关不掉的端点声明（todo/0118）:只认布尔;
  // true 时快照披发 {SID}_THINKING_DISABLE_UNSUPPORTED=true 供 dispatcher 出口替换;false/缺席不披发;
  // 非 anthropic 协议写 true 加载期拒（其它协议不消费该键,写了等于静默失效）
  describe('providers thinking_disable_unsupported', () => {
    const mk = (line: string | null, protocol = 'anthropic') => writeConfig([
      'providers:',
      '  - service_id: glm_flash',
      `    protocol: ${protocol}`,
      '    base_url: https://example.invalid/anthropic',
      '    model: glm-5.3-flash',
      '    api_key_env: HOPJIT_TEST_KEY_ENV',
      '    thinking: enabled',
      ...(line === null ? [] : [`    thinking_disable_unsupported: ${line}`]),
    ].join('\n'));
    const snapOf = (path: string) => {
      const c = loadStandaloneConfig(path);
      return { c, snap: buildEnvSnapshot(c, new Map([[c.providers[0], 'k']]) as never) };
    };

    it('正例：true 合法加载,快照披发 GLM_FLASH_THINKING_DISABLE_UNSUPPORTED=true,与 thinking: enabled 并存', () => {
      const { c, snap } = snapOf(mk('true'));
      expect((c.providers[0] as { thinking_disable_unsupported?: boolean }).thinking_disable_unsupported).toBe(true);
      expect(snap['GLM_FLASH_THINKING_DISABLE_UNSUPPORTED']).toBe('true');
      expect(snap['GLM_FLASH_THINKING']).toBe('enabled');
    });

    it('反例：false 与缺席都不披发该键（未声明的端点行为不变）', () => {
      expect('GLM_FLASH_THINKING_DISABLE_UNSUPPORTED' in snapOf(mk('false')).snap).toBe(false);
      expect('GLM_FLASH_THINKING_DISABLE_UNSUPPORTED' in snapOf(mk(null)).snap).toBe(false);
    });

    it('反例：类型错（字符串 "true"、数字 1）加载期拒,报错点名字段', () => {
      expect(() => loadStandaloneConfig(mk('"true"'))).toThrow(/thinking_disable_unsupported 须为布尔/);
      expect(() => loadStandaloneConfig(mk('1'))).toThrow(/thinking_disable_unsupported 须为布尔/);
    });

    it('反例：非 anthropic 协议写 true 加载期拒;写 false 放行', () => {
      expect(() => loadStandaloneConfig(mk('true', 'openai-chat'))).toThrow(/只对 protocol: anthropic 有效/);
      expect(() => loadStandaloneConfig(mk('true', 'openai-responses'))).toThrow(/只对 protocol: anthropic 有效/);
      expect(() => loadStandaloneConfig(mk('false', 'openai-chat'))).not.toThrow();
    });
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

// @v: anc-hopant-callee-resolve, anc-provider-spec-default —— 独立模式 call 寻址：startRun 挂的缺省 DirSpecProvider 带
// antRoots(homedir(), hostConfig.workspace_dir),同目录没有的 callee 先落 <workspace_dir>/hop_tasks/ants/<id>/<id>.md,再落 <HOME>/.hopjit/ants/
// （callee 纯 hop_python,不触 LLM）。本例只装项目级、用户级为空——变异 M21-mcp：项目级根改成 '/nonexistent-mut' → callee 找不到,run 不 completed,红
describe('HopjitMcpCore 缺省 SpecProvider 两级寻址', () => {
  it('正例：call 只装在 <workspace_dir>/hop_tasks/ants/ 的 HopAnt（用户级没有）→ run completed,子实例产出回到父', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mcp-ants-home-'));   // 空的假 HOME：用户级 ~/.hopjit/ants/ 下什么都没有
    const dir = mkdtempSync(join(tmpdir(), 'mcp-ants-proj-'));   // 项目目录 = startRun 的 workspace_dir
    const antDir = join(dir, 'hop_tasks', 'ants', 'helper-ant');
    mkdirSync(antDir, { recursive: true });
    writeFileSync(join(antDir, 'helper-ant.md'), `# H
Id: helper-ant
## Goal
g
## Inputs
- q: text  # 词
## Outputs
- r: text  # 结果
## Steps
1. [act] 回显
  - ← q
  + → r: text  # 结果
  > \`\`\`hop_python
  > r = q + "!"
  > \`\`\`
`);
    writeFileSync(join(dir, 's.md'), `# C
Id: caller
## Goal
g
## Outputs
- out: text  # 结果
## Steps
1. [call helper-ant(q: "hi")] 调
  + → out: r  # 收取
`);
    const oldHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
      const r = await core.startRun(join(dir, 's.md'), undefined, mkdtempSync(join(tmpdir(), 'mcp-ants-state-')), dir);
      const runId = r['run_id'] as string;
      expect(runId, JSON.stringify(r)).toBeDefined();
      let st: Record<string, unknown> = {};
      for (let i = 0; i < 50; i++) {
        await new Promise(res => setTimeout(res, 100));
        st = core.runStatus(runId);
        if (st['status'] !== 'running') break;
      }
      expect(st['status'], JSON.stringify(st)).toBe('completed');
      expect((st['outputs'] as Record<string, unknown>)['out']).toBe('hi!');
    } finally {
      process.env['HOME'] = oldHome;
    }
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

  // @v: anc-exec-parallel-hitl-queue, anc-exec-call-child-persist —（37轮review:server重启后队列是空的,
  // caller拿旧卡child来答——账上paused→resumeSpec对账,子实例 state.json 在场走 stale 续跑到暂停点重新入队,
  // 同名child新卡入队后按原答继续;探针实证 completed vals=[5]。双锚:落盘批连锁修的击杀面钉——分派判据
  // 2026-10-07 hopissues/0126 起按 state.json 在场判〔原按退火标记重派发〕,本钉形态两版行为一致）
  it('U4b：server 重启后按旧卡 child_instance 应答 → 子实例续跑到暂停点重新入队接原答,completed', async () => {
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

  // hopissues/0126 的 MCP 真身：for-each × parallel 三子实例各停 commit 卡,server 重启后 resume_run(child_instance=…)
  // 对 commit 卡被预检 INVALID_STATE 拒（父账上该步 done 非 running）,正路是 resume_run(step_id=<for-each 容器步>) 走崩溃恢复
  // 分支——容器步 running 且非 confirm/ask/commit → recoverDanglingRunning + resumeSpec → 三子实例按 state.json 在场续跑收齐。
  // 修前只回最后一项（outs=[6]）。design parallel-execution U4b 第 6 条 MCP 入口条 / mcp-server ^anc-mcp-run-restore。
  // @v: anc-exec-parallel-hitl-queue, anc-mcp-run-restore
  it('正例（0126 MCP 真身）：三子实例停 commit 卡,新 core 批准后 resume_run(step_id=容器步) 崩溃恢复路 → 三项全部续跑 outs=[2,4,6];resume_run(child_instance=…) 对 commit 卡 INVALID_STATE 拒（既有限制如实钉住）', async () => {
    const echoConfig: StandaloneConfig = { ...config, commands: ['echo'] };   // commit body 跑外部命令才会停批准卡
    const core1 = new HopjitMcpCore(echoConfig);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-0126-'));
    writeFileSync(join(dir, 's.md'), `# T
Id: t-0126
## Goal
g
## Inputs
- items: [int]

## Outputs
- outs: [int]

## Steps
1. [loop for-each x in items, collect y into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [subtask parallel] 单项
    + → y: int  # 值
    1.1.1. [act] 备值
      - ← x
      + → y0: int  # 值
      > \`\`\`hop_python
      > y0 = x * 2
      > \`\`\`
    1.1.2. [check final] 判定
      - ← y0
      + → ok: bool  # 判
      + → note: text  # 说
      > \`\`\`hop_python
      > ok = True
      > note = "ok"
      > \`\`\`
    1.1.3. [commit] 落值
      - ← y0
      + → y: int  # 值
      > \`\`\`hop_python
      > r = subprocess.run(["echo", "x"])
      > y = y0
      > \`\`\`
`);
    const sd = mkdtempSync(join(tmpdir(), 'mcp-0126-state-'));
    const r = await core1.startRun(join(dir, 's.md'), { items: [1, 2, 3] }, sd, dir);
    const runId = r['run_id'] as string;
    let st: Record<string, unknown> = {};
    for (let i = 0; i < 80; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = core1.runStatus(runId);
      if (st['status'] === 'paused' && ((st['paused_queue'] as unknown[])?.length ?? 0) === 3) break;
    }
    const queue = st['paused_queue'] as Array<{ child_instance?: string; step_id: string; pause_reason?: string; presented_data?: { context?: Record<string, unknown> } }>;
    expect(queue.length).toBe(3);
    expect(queue[0].pause_reason).toBe('commit');
    const hash = String(queue[0].presented_data?.context?.['fingerprint']);
    // server 重启:新 core 空注册表
    const core2 = new HopjitMcpCore(echoConfig);
    // 带卡上的 child_instance:新 core 队列为空,从 parallel/<child> load 子实例引擎批;scope=task 覆盖三张卡
    expect((core2.approveCommit({ instance_id: runId, step_id: '1.1.3', fingerprint: hash, scope: 'task', state_dir: sd, child_instance: queue[0].child_instance }) as { status?: string }).status).toBe('ok');
    expect((core2.approveCommit({ instance_id: runId, step_id: '1.1.3', fingerprint: hash, scope: 'task', state_dir: sd, child_instance: 'nope' }) as { error?: { code?: string } }).error?.code).toBe('INSTANCE_NOT_FOUND');
    // 子实例 commit 卡带 child_instance 来答 → 预检拒（父账上 1.1.3 非 running）——既有限制,如实钉
    const rejected = core2.resumeRun(runId, '1.1.3', {}, sd, queue[0].child_instance) as { error?: { code?: string } };
    expect(rejected.error?.code).toBe('INVALID_STATE');
    // 正路：容器步 step_id 走崩溃恢复分支
    const a = core2.resumeRun(runId, '1', {}, sd) as { status?: string; recovered_from_crash?: boolean };
    expect(a.status).toBe('running');
    expect(a.recovered_from_crash).toBe(true);
    for (let i = 0; i < 100; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = core2.runStatus(runId);
      if (['completed', 'failed'].includes(st['status'] as string)) break;
    }
    expect(st['status']).toBe('completed');
    expect((st['outputs'] as Record<string, unknown>)['outs']).toEqual([2, 4, 6]);
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

  // @v: anc-mcp-stop-run —— 2026-10-11 语义审计 0156 B5：第四个回写口（resumeRun 的 rejected 回调）aborted 时同样收 tool provider
  // （设计第 2 条"三处一律见 aborted 先返只做资源收尾"——此口此前先返但漏 close,窄竞态工具通道泄漏;变异=删该分支的 close → 本例红）
  it('正/反（竞态防线·第四口）：resume 被拒收迟到时 run 已 aborted → 不改写终态且 tool provider 被 close;未 aborted 则回 paused+failure 且不 close', async () => {
    const run = async (stopBeforeReject: boolean) => {
      const core = new HopjitMcpCore(config);
      let resolveLate: ((r: unknown) => void) | undefined;
      let closeCalls = 0;
      const toolProvider = { list: () => [], execute: async () => ({ success: true, result: null }), close: async () => { closeCalls++; } };
      const entry: Record<string, unknown> = {
        runId: 'r-rj', specPath: '/x/s.md', state: 'paused',
        dispatcher: {
          requestAbortCascade: () => {},
          getToolProvider: () => toolProvider,
          resume: () => new Promise(res => { resolveLate = res; }),   // 挂起,等 stop（或不 stop）后再以 rejected 形态回
        },
        paused: { status: 'paused', step_id: '1', pause_reason: 'ask' },
        startedAt: '2026-08-22T00:00:00Z',
      };
      (core as any).runs.set('r-rj', entry);
      core.resumeRun('r-rj', '1', { value: 'a' });   // 在飞
      if (stopBeforeReject) core.stopRun('r-rj');    // 用户中止
      resolveLate!({ status: 'paused', rejected: { code: 'ASK_ANSWER_SHAPE', message: '坏形态' } });   // 拒收迟到
      await new Promise(res => setTimeout(res, 10));
      return { status: core.runStatus('r-rj')['status'], closeCalls, failure: entry['failure'] };
    };
    const stopped = await run(true);
    expect(stopped.status).toBe('aborted');     // 终态不被改写
    expect(stopped.closeCalls).toBe(1);         // 反例半边：aborted 时第四口也收 tool provider
    const alive = await run(false);
    expect(alive.status).toBe('paused');        // 正例半边：未 aborted 走拒收回 paused+failure
    expect((alive.failure as { reason: string }).reason).toContain('ASK_ANSWER_SHAPE');
    expect(alive.closeCalls).toBe(0);           // 可修正重试,不收 provider
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
  it('注册工具集与契约一致（独立模式六件 + 复用驱动七件 + approve_commit + approve_dirs + 管理八件 + server_status,2026-10-07 todo/0146 + 0148 + 2026-10-10 todo/0154）', async () => {   // @v: anc-mcp-admin-tools
    const { buildServer: build } = await import('../src/mcp-server.js');
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const server = build(core);
    // McpServer 内部注册表（SDK 私有结构，仅断言工具名集合——形状断言到此为止，行为归冒烟/真机）
    const tools = (server as any)._registeredTools;
    expect(Object.keys(tools).sort()).toEqual([
      'abort', 'ant_adapt', 'ant_bootstrap', 'ant_install', 'ant_list', 'ant_pack', 'ant_remove', 'ant_share', 'approve_commit', 'approve_dirs', 'doctor',
      'list_runs', 'reap_and_fetch_next', 'resume', 'resume_run', 'run', 'run_approved_command',
      'run_status', 'server_status', 'start_run', 'status', 'stop_run', 'submit_and_fetch_next', 'validate',
    ]);
    expect(tools['start_run'].inputSchema).toBeTruthy();   // schema 存在（zod 对象）
    // stop_run 注解逐项（^anc-mcp-stop-run——destructiveHint 丢弃在飞进度如实标破坏性;
    // idempotentHint 终态幂等是设计点名条款,review 补断言）
    expect(tools['stop_run'].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    // run_approved_command 注解（^anc-mcp-run-command——openWorldHint 如实 true:命令可联网,server 不在载体 Bash 沙箱里）
    expect(tools['run_approved_command'].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false });
    // description 是对 agent 的教材（^anc-mcp-run-command 契约）：授权三要素 + 被拒处置都要在 // @v: anc-mcp-run-command
    const desc = String(tools['run_approved_command'].description);
    for (const kw of ['什么任务', '什么核验', '才可以执行', 'APPROVAL_REQUIRED', '归人决定', '不得自己把命令加进卡']) expect(desc).toContain(kw);
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

// @v: anc-mcp-config, anc-mcp-server-status —— serve 启动面（子进程冒烟：配置三态都启动,独立模式能力如实报;stdio server 无法进程内测）
describe('serve 启动——配置问题不阻止启动（子进程）', () => {
  function spawnServe(env: Record<string, string | undefined>): { code: number; err: string } {
    const entry = join(REPO, 'dist', 'mcp-server.js');
    if (!existsSync(entry)) throw new Error('dist/mcp-server.js 缺失——测试入口必须先执行 npm run build');
    const r = spawnSync('node', [entry], {
      encoding: 'utf-8', timeout: 8000, input: '',
      env: { ...process.env, ...env },
    });
    return { code: r.status ?? -1, err: r.stderr ?? '' };
  }

  it('配置缺失 → 照常启动,横幅说明独立模式不可用并带 STANDALONE_CONFIG_MISSING', () => {
    const r = spawnServe({ HOPJIT_CONFIG: '/nonexistent/cfg.yaml' });
    expect(r.code).toBe(0);
    expect(r.err).toContain('server 就绪（复用驱动工具可用;独立模式不可用');
    expect(r.err).toContain('STANDALONE_CONFIG_MISSING');
    expect(r.err).not.toContain('启动失败');
  });

  it('key env 未设 → 照常启动,横幅报变量名', () => {
    const p = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, api_key_env: 'HOPJIT_NO_SUCH_KEY' }] }));
    const r = spawnServe({ HOPJIT_CONFIG: p, HOPJIT_NO_SUCH_KEY: undefined });
    expect(r.code).toBe(0);
    expect(r.err).toContain('独立模式不可用');
    expect(r.err).toContain('HOPJIT_NO_SUCH_KEY');
  });

  it('配置非法（明文 key）→ 照常启动,横幅带配置报文', () => {
    const p = writeConfig(JSON.stringify({ providers: [{ ...VALID_PROVIDER, api_key: 'sk-plain' }] }));
    const r = spawnServe({ HOPJIT_CONFIG: p });
    expect(r.code).toBe(0);
    expect(r.err).toContain('独立模式不可用');
    expect(r.err).toContain('STANDALONE_CONFIG_PLAINTEXT_KEY');
    expect(r.err).toContain('api_key_env');
    expect(r.err).not.toContain('sk-plain');   // 横幅不回显明文 key
  });

  it('配置合法+key 在 → exit 0 且就绪横幅说明独立模式可用（stdin 关闭即退出）', () => {
    const p = writeConfig(JSON.stringify({ providers: [VALID_PROVIDER] }));
    const r = spawnServe({ HOPJIT_CONFIG: p, HOPJIT_TEST_KEY_ENV: 'sk-smoke' });
    expect(r.code).toBe(0);
    expect(r.err).toContain('server 就绪（独立模式可用');
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

  // @v: anc-mcp-config
  it('HOPJIT_CONFIG 未设 → 配置路径回退到 <HOME>/.hopjit/config.yaml（假 HOME 下放一份合法配置即独立模式可用;空 HOME 即配置缺失）', () => {
    const home = mkdtempSync(join(tmpdir(), 'mcp-home-'));
    mkdirSync(join(home, '.hopjit'), { recursive: true });
    writeFileSync(join(home, '.hopjit', 'config.yaml'), JSON.stringify({ providers: [VALID_PROVIDER] }));
    const ok = spawnServe({ HOPJIT_CONFIG: undefined, HOME: home, HOPJIT_TEST_KEY_ENV: 'sk-smoke' });
    expect(ok.code).toBe(0);
    expect(ok.err).toContain('server 就绪（独立模式可用');
    const emptyHome = mkdtempSync(join(tmpdir(), 'mcp-home-empty-'));
    const missing = spawnServe({ HOPJIT_CONFIG: undefined, HOME: emptyHome, HOPJIT_TEST_KEY_ENV: 'sk-smoke' });
    expect(missing.code).toBe(0);
    expect(missing.err).toContain('独立模式不可用');
    expect(missing.err).toContain('STANDALONE_CONFIG_MISSING');
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
    })).toThrow(/STANDALONE_KEY_MISSING.*HOPJIT_MISSING_K.*backup.*独立模式不可用/);
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

// log_level 配置节（缺省 info——2026-09-30 todo/0127 作者定,对外分发防塞爆硬盘;2026-08-22 曾定 debug）
// @v: anc-config-standalone-schema, anc-obs-log-levels
describe('log_level 配置节（standalone 缺省 info）', () => {
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

  // @v: anc-obs-log-retention
  it('log_retention：max_runs 非正整数加载期拒;合法过;mergeConfigs 项目级赢', () => {
    expect(() => loadStandaloneConfig(writeConfig(base + 'log_retention:\n  max_runs: 0\n'))).toThrow(/log_retention\.max_runs 须为正整数/);
    expect(() => loadStandaloneConfig(writeConfig(base + 'log_retention:\n  max_runs: many\n'))).toThrow(/log_retention\.max_runs 须为正整数/);
    expect(() => loadStandaloneConfig(writeConfig(base + 'log_retention: 5\n'))).toThrow(/log_retention\.max_runs 须为正整数/);
    expect(loadStandaloneConfig(writeConfig(base + 'log_retention:\n  max_runs: 7\n')).log_retention).toEqual({ max_runs: 7 });
    const merged = mergeConfigs({ providers: [VALID_PROVIDER], log_retention: { max_runs: 3 } }, { providers: [], log_retention: { max_runs: 9 } });
    expect(merged.log_retention).toEqual({ max_runs: 9 });
    expect(mergeConfigs({ providers: [VALID_PROVIDER], log_retention: { max_runs: 3 } }, { providers: [] }).log_retention).toEqual({ max_runs: 3 });
  });

  it('正例：未配置 → startRun 落 info 级 hoplog（main.yaml 头 level: info）;配置 log_level: debug 才记 prompt 全文', async () => {
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
      expect(readFileSync(join(runDir!, 'main.yaml'), 'utf-8')).toMatch(/^level: info$/m);
      // hopissues/0116 卡 probe ① 的真实路径：MCP 起的 run 其 state.json 落盘后,活账反查必须能找到它的日志目录——
      // start_run 把 stateDir 送进 initExecution 并由 engine 透传 HopLog 这一跳此前零测试（review 面三缺口 9）
      const live = collectLiveRunDirs(join(dir, '.hopstate'));
      expect([...live].map(x => realpathSync(x))).toContain(realpathSync(runDir!));
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

  // @v: anc-i18n-serialize-lang, anc-i18n-language-config —— 语义审计 #5 #6 #7（2026-10-12）：todo/0160 把 language 缺省
  // 收口到 config-load.effectiveLanguage,但 mcp-server 的 startRun 与 restoreRun 四处仍写死 `=== 'zh' ? 'zh' : 'en'`
  // ——键缺席落 en,中文机器上独立模式与复用模式劈叉。本组钉"键缺席跟随系统语言、键在场用键值"在 MCP 两路都成立。
  it('正例（语义审计 #5 #6）：startRun 配置两级都没写 language、LANG=zh_CN.UTF-8 → HostConfig.language 与 hop_env_language 都是 zh（跟随系统语言,不再写死 en）', async () => {
    process.env['HOPJIT_CONFIG'] = '/hermetic/no-project-reload.yaml';
    const saved = { LC_ALL: process.env['LC_ALL'], LC_MESSAGES: process.env['LC_MESSAGES'], LANG: process.env['LANG'] };
    delete process.env['LC_ALL']; delete process.env['LC_MESSAGES']; process.env['LANG'] = 'zh_CN.UTF-8';
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });   // 无 language 键
      const dir = mkdtempSync(join(tmpdir(), 'mcp-lang-sys-'));
      const r = await core.startRun(join(REPO, 'examples', 'coffee-week.md'), { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 }, join(dir, '.hopstate'));
      expect(r['run_id']).toBeTruthy();
      const hc = ([...(core as any).runs.values()][0].dispatcher as any).hostConfig;
      expect(hc.language).toBe('zh');
      expect(hc.hop_env?.['hop_env_language']).toBe('zh');
    } finally {
      delete process.env['HOPJIT_CONFIG'];
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('反例（语义审计 #5 #6）：startRun 配置显式 language: en、LANG=zh_CN.UTF-8 → 仍是 en（键在场用键值,系统语言不覆盖显式配置）', async () => {
    process.env['HOPJIT_CONFIG'] = '/hermetic/no-project-reload.yaml';
    const saved = { LC_ALL: process.env['LC_ALL'], LC_MESSAGES: process.env['LC_MESSAGES'], LANG: process.env['LANG'] };
    delete process.env['LC_ALL']; delete process.env['LC_MESSAGES']; process.env['LANG'] = 'zh_CN.UTF-8';
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER], language: 'en' });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-lang-explicit-'));
      const r = await core.startRun(join(REPO, 'examples', 'coffee-week.md'), { daily_sales: [1, 2, 3, 4, 5, 6, 7], weekly_target: 10 }, join(dir, '.hopstate'));
      expect(r['run_id']).toBeTruthy();
      const hc = ([...(core as any).runs.values()][0].dispatcher as any).hostConfig;
      expect(hc.language).toBe('en');
      expect(hc.hop_env?.['hop_env_language']).toBe('en');
    } finally {
      delete process.env['HOPJIT_CONFIG'];
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('正例（语义审计 #7）：restoreRun 项目级与 server 配置都没写 language、LANG=zh_CN.UTF-8 → 恢复后 HostConfig.language 与 hop_env_language 都是 zh（restoreRun 半边同口径）', () => {
    const saved = { LC_ALL: process.env['LC_ALL'], LC_MESSAGES: process.env['LC_MESSAGES'], LANG: process.env['LANG'] };
    delete process.env['LC_ALL']; delete process.env['LC_MESSAGES']; process.env['LANG'] = 'zh_CN.UTF-8';
    try {
      const projDir = mkdtempSync(join(tmpdir(), 'mcp-lang-restore-'));
      writeFileSync(join(projDir, 'hopjit.yaml'), 'default_model: deepseek/m2\n');   // 无 language 键
      const ASK_SPEC = `# T\nId: lang-restore-t\n## Goal\ng\n## Inputs\n- x: line\n## Outputs\n- r: line  # r\n## Steps\n1. [ask] 问\n  - ← x\n  + → r: line  # r\n`;
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
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });   // server 配置也无 language
      const r = core.resumeRun(runId, '1', { value: 'go' }, stateDir);
      expect(JSON.stringify((r as { error?: unknown }).error ?? null)).toBe('null');
      const hc = ((core as any).runs.get(runId).dispatcher as any).hostConfig;
      expect(hc.language).toBe('zh');
      expect(hc.hop_env?.['hop_env_language']).toBe('zh');
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
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

  // ===== 独立模式 commit 批准停点（todo/0146 review D7/D12/D37/D2,走真 dispatcher,不用 mock 引擎）=====
  // confirm → commit(不留旧版本的写入 body):confirm 由人答,commit 由 dispatcher.executeCommit 的批准闸拦停
  // （keep:0 写工作区文件=引擎判 review,本测试没有注册分析模型 → 模板分析转人工）。
  const CC_SPEC = `# CC
Id: cc-t

## Goal
g

## Outputs
- out: line  # 交付

## Steps
1. [confirm] 审批
  + → approval: bool  # 审批
2. [commit] 交付
  + → out: line
  > 覆盖写一个文件,不留旧版本
  > \`\`\`hop_python
  > w = write(path: "shipped.txt", content: "x", keep: 0)
  > out = "shipped"
  > \`\`\`
`;
  function setupConfirmSnapshot(dirArg?: string): { stateDir: string; runId: string; dir: string } {
    const dir = dirArg ?? mkdtempSync(join(tmpdir(), 'mcp-cc-'));
    const specPath = join(dir, 'cc.md');
    writeFileSync(specPath, CC_SPEC);
    const stateDir = join(dir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CC_SPEC, {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'x',
    }, { stateDir, specPath });
    expect(init.status).toBe('ok');
    const n = engine.nextStep();
    expect(n.status).toBe('paused');
    expect((n as { step_id: string }).step_id).toBe('1');
    return { stateDir, runId: (init as { instance_id: string }).instance_id, dir };
  }
  // 新 core 从 confirm 快照恢复、答 approve,dispatcher 跑到 commit 批准停点
  async function runToCommitPause(): Promise<{ stateDir: string; runId: string; dir: string; core: HopjitMcpCore; hash: string }> {
    const s = setupConfirmSnapshot();
    const core = new HopjitMcpCore(config);
    expect((core.resumeRun(s.runId, '1', { value: 'approve' }, s.stateDir) as { status?: string }).status).toBe('running');
    await new Promise(res => setTimeout(res, 400));
    const st = core.runStatus(s.runId) as any;
    expect(st.status).toBe('paused');
    expect(st.paused.pause_reason).toBe('commit');
    expect(st.paused.step_id).toBe('2');
    return { ...s, core, hash: st.paused.presented_data.context.fingerprint };
  }

  // @v: anc-exec-commit-approval, anc-mcp-commit-approve
  it('独立模式 commit 批准（真 dispatcher）:停在批准点→未批准 resume_run 拒且仍 paused→approve_commit 走注册表内存引擎→resume_run 执行 body;once 不跨运行,task 之后同 spec 再跑不停', async () => {
    const { stateDir, runId, dir, core, hash } = await runToCommitPause();
    // 未批准:resume_run 同步拒,run 保持 paused,报文带 instance_id 与"问用户"
    const rej = core.resumeRun(runId, '2', {}) as any;
    expect(rej.error.code).toBe('COMMIT_NOT_APPROVED');
    expect(rej.error.message).toContain(`instance_id: "${runId}"`);
    expect(rej.error.message).toContain('在对话里用三个选项问');
    expect((core.runStatus(runId) as any).status).toBe('paused');
    // dispatcher.resume 的 commit 分支（mcp 同步预检之后的第二个产生点）:未批准结构化拒,报文同源
    const entry = (core as any).runs.get(runId);
    const dr = await entry.dispatcher.resume('2', {});
    expect(dr.rejected.code).toBe('COMMIT_NOT_APPROVED');
    expect(dr.rejected.message).toContain(`instance_id: "${runId}"`);
    expect(dr.rejected.message).toContain('在对话里用三个选项问');
    // approve_commit:run 在本进程注册表里 → 用其内存引擎记账（事件记在内存引擎上即证明没走 load 分支）
    const ok = core.approveCommit({ instance_id: runId, step_id: '2', fingerprint: hash, scope: 'once', state_dir: stateDir }) as any;
    expect(ok.status).toBe('ok');
    expect(entry.dispatcher.getEngine().getExecEvents().some((e: { event: string }) => e.event === 'commit_approved')).toBe(true);
    expect(existsSync(join(stateDir, 'commit_approvals.json'))).toBe(true);
    // 批准后 resume_run 放行,body 执行
    expect((core.resumeRun(runId, '2', {}) as any).status).toBe('running');
    await new Promise(res => setTimeout(res, 400));
    const done = core.runStatus(runId) as any;
    expect(done.status).toBe('completed');
    expect(done.outputs.out).toBe('shipped');
    // 同一 spec 再起一个实例:scope=once 只管本次运行,confirm 后再停在 commit;批 task 后第三个实例不再停
    const again = setupConfirmSnapshot(dir);
    expect((core.resumeRun(again.runId, '1', { value: 'approve' }, again.stateDir) as any).status).toBe('running');
    await new Promise(res => setTimeout(res, 400));
    const p2 = core.runStatus(again.runId) as any;
    expect(p2.status).toBe('paused');
    expect(p2.paused.pause_reason).toBe('commit');
    expect((core.approveCommit({ instance_id: again.runId, step_id: '2', fingerprint: hash, scope: 'task', state_dir: again.stateDir }) as any).status).toBe('ok');
    const third = setupConfirmSnapshot(dir);
    expect((core.resumeRun(third.runId, '1', { value: 'approve' }, third.stateDir) as any).status).toBe('running');
    await new Promise(res => setTimeout(res, 400));
    const done3 = core.runStatus(third.runId) as any;
    expect(done3.status).toBe('completed');
    expect(done3.outputs.out).toBe('shipped');
  });

  // @v: anc-mcp-commit-approve
  it('反例：approve_commit 的 scope 不是 once/task → INVALID_ARG,不记账,run 仍停在批准点', async () => {
    const { stateDir, runId, core, hash } = await runToCommitPause();
    for (const scope of ['forever', 'deny', '']) {
      expect(core.approveCommit({ instance_id: runId, step_id: '2', fingerprint: hash, scope, state_dir: stateDir })).toMatchObject({ error: { code: 'INVALID_ARG' } });
    }
    // 账里只有关卡分析留下的 referred 记录,没有任何批准记录
    const recs = JSON.parse(readFileSync(join(stateDir, 'commit_approvals.json'), 'utf-8')) as Array<{ outcome: string }>;
    expect(recs.map(r => r.outcome)).toEqual(['referred']);
    expect((core.runStatus(runId) as any).status).toBe('paused');
  });

  // @v: anc-mcp-run-restore, anc-exec-commit-approval
  it('server 重启后的 commit 停点快照:新 core resume_run 未批准得 COMMIT_NOT_APPROVED（不当崩溃悬空步重跑）;config 缺失的 core 得 STANDALONE_UNAVAILABLE 且快照不动', async () => {
    const { stateDir, runId } = await runToCommitPause();
    const core2 = new HopjitMcpCore(config);   // 重启后的 server,注册表空
    const r = core2.resumeRun(runId, '2', {}, stateDir) as any;
    expect(r.recovered_from_crash).toBeUndefined();
    expect(r).toMatchObject({ error: { code: 'COMMIT_NOT_APPROVED' } });
    const statePath = join(stateDir, runId, 'state.json');
    const before = readFileSync(statePath, 'utf-8');
    const nullCore = new HopjitMcpCore(null, { reason: 'STANDALONE_CONFIG_MISSING: 测试', fix: '创建配置' });
    expect(nullCore.resumeRun(runId, '2', {}, stateDir)).toMatchObject({ error: { code: 'STANDALONE_UNAVAILABLE', fix: '创建配置' } });
    expect(readFileSync(statePath, 'utf-8')).toBe(before);
  });

  // @v: anc-exec-confirm-answer
  it('独立模式 confirm 收到没有决定值的回答 → 拒收:run 回 paused,failure 带 SCHEMA_MISMATCH,不推进到 commit', async () => {
    const { stateDir, runId } = setupConfirmSnapshot();
    const core = new HopjitMcpCore(config);
    expect((core.resumeRun(runId, '1', {}, stateDir) as any).status).toBe('running');
    await new Promise(res => setTimeout(res, 300));
    const st = core.runStatus(runId) as any;
    expect(st.status).toBe('paused');
    expect(st.failure.reason).toContain('SCHEMA_MISMATCH');
    expect(st.paused).toBeUndefined();   // 恢复的 run 原本就没有暂停载荷;拒收不凭空造 commit 停点
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

// state.json 写入序号核对 MCP 侧（todo/0114——两个 MCP server 进程对同一 state_dir 的同一 run 都有注册项,
// 通道核对拦不住〔两边都是 mcp〕;两个 HopjitMcpCore 模拟两个进程,各自的注册项与引擎是各自的内存账）
// @v: anc-exec-state-seq-guard
describe('state.json 写入序号核对（MCP 侧预检）', () => {
  beforeAll(() => { process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-test-fake'; });
  const SPEC = `# T
Id: t-seq-mcp
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
  function pausedMcpSnapshot(): { stateDir: string; runId: string; instDir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-seq-'));
    const specPath = join(dir, 'seq-t.md');
    writeFileSync(specPath, SPEC);
    const stateDir = join(dir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'x',
    }, { stateDir, params: { base: 41 }, specPath, driverChannel: 'mcp' });
    expect(init.status).toBe('ok');
    let n = engine.nextStep();
    while (n.status === 'step_ready') { engine.completeStep(n.step_id, { prepared: 42 }); n = engine.nextStep(); }
    expect(n.status).toBe('paused');
    const runId = (init as { instance_id: string }).instance_id;
    return { stateDir, runId, instDir: join(stateDir, runId) };
  }
  // 另一个进程写了一次盘（内容不变,只把盘上序号推高——模拟"别的进程推进过"）
  function otherProcessWrites(instDir: string): void {
    const other = ExecutionEngine.load(instDir);
    (other as unknown as { persist(): void }).persist();
  }

  it('反例：B 先恢复出注册项,A 把 run 推进到 completed,B 再 resumeRun → STATE_STALE,state.json 不被覆盖', async () => {
    process.env['HOPJIT_CONFIG'] = '/hermetic/no-project-reload.yaml';
    try {
      const { stateDir, runId, instDir } = pausedMcpSnapshot();
      const coreA = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
      const coreB = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
      const restored = (coreB as any).restoreRun(runId, stateDir);
      expect('error' in restored).toBe(false);
      const ra = coreA.resumeRun(runId, '2', { result: 42 }, stateDir) as { error?: unknown };
      expect(ra.error).toBeUndefined();
      for (let i = 0; i < 50; i++) {
        if (coreA.runStatus(runId)['status'] === 'completed') break;
        await new Promise(res => setTimeout(res, 50));
      }
      expect(coreA.runStatus(runId)['status']).toBe('completed');
      const before = readFileSync(join(instDir, 'state.json'));
      const rb = coreB.resumeRun(runId, '2', { result: 99 }, stateDir) as { error?: { code: string; message: string } };
      expect(rb.error?.code).toBe('STATE_STALE');
      expect(rb.error?.message).toMatch(/^STATE_STALE: 盘上 state\.json 已被另一个进程（pid \d+，写于 .+）推进到序号 \d+，本进程内存里的账还停在序号 \d+——拒绝覆盖。/);
      expect(readFileSync(join(instDir, 'state.json')).equals(before)).toBe(true);
      expect(JSON.parse(before.toString()).terminal_state).toBe('completed');
    } finally { delete process.env['HOPJIT_CONFIG']; }
  });

  it('反例：同样情形下 B 调 stopRun → STATE_STALE,不写 aborted.json、不动 state.json;running 注册项不移出', () => {
    const { stateDir, runId, instDir } = pausedMcpSnapshot();
    const coreB = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    (coreB as any).restoreRun(runId, stateDir);
    otherProcessWrites(instDir);
    const before = readFileSync(join(instDir, 'state.json'));
    const r = coreB.stopRun(runId) as { error?: { code: string } };
    expect(r.error?.code).toBe('STATE_STALE');
    expect(existsSync(join(instDir, 'aborted.json'))).toBe(false);
    expect(readFileSync(join(instDir, 'state.json')).equals(before)).toBe(true);
    expect((coreB as any).runs.has(runId)).toBe(false);   // paused 注册项移出
    // running 的注册项:拒但不移出（在飞 dispatcher 下次写盘自己撞 STATE_STALE）
    (coreB as any).restoreRun(runId, stateDir);
    (coreB as any).runs.get(runId).state = 'running';
    otherProcessWrites(instDir);
    const r2 = coreB.stopRun(runId) as { error?: { code: string } };
    expect(r2.error?.code).toBe('STATE_STALE');
    expect((coreB as any).runs.has(runId)).toBe(true);
    expect(existsSync(join(instDir, 'aborted.json'))).toBe(false);
  });

  it('正例：过时注册项被移出后,B 再调 resumeRun 走从盘上重新加载,不再 STATE_STALE', () => {
    const { stateDir, runId, instDir } = pausedMcpSnapshot();
    const coreB = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    (coreB as any).restoreRun(runId, stateDir);
    otherProcessWrites(instDir);
    const r1 = coreB.resumeRun(runId, '2', { result: 42 }, stateDir) as { error?: { code: string } };
    expect(r1.error?.code).toBe('STATE_STALE');
    expect((coreB as any).runs.has(runId)).toBe(false);
    const diskSeq = JSON.parse(readFileSync(join(instDir, 'state.json'), 'utf-8')).state_seq;
    const r2 = coreB.resumeRun(runId, '2', { result: 42 }, stateDir) as { error?: unknown; status?: string };
    expect(r2.error).toBeUndefined();
    expect((coreB as any).runs.get(runId).dispatcher.getEngine().getStateSeq()).toBeGreaterThanOrEqual(diskSeq);
  });
});

// stop_run 快照兜底（hopissues/0117,^anc-mcp-stop-run 第 6 条）——MCP server 重启后注册表清空,
// 重启前停在 paused 的 run 只剩盘上快照:stop_run 带 state_dir 按快照写墓碑中止。
// @v: anc-mcp-stop-run
describe('stop_run 快照兜底（注册表外的 run）', () => {
  beforeAll(() => { process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-test-fake'; });
  const SPEC = `# T
Id: t-stop-snap
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
  /** 引擎直接跑到 paused 落盘（不经 startRun、不触 LLM）——等价于"server 重启前停在等人"的盘上形态。 */
  function pausedSnapshot(driverChannel: 'mcp' | 'cli' = 'mcp'): { stateDir: string; runId: string; instDir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-stop-snap-'));
    const specPath = join(dir, 's.md');
    writeFileSync(specPath, SPEC);
    const stateDir = join(dir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'x',
    }, { stateDir, params: { base: 41 }, specPath, driverChannel });
    expect(init.status).toBe('ok');
    let n = engine.nextStep();
    while (n.status === 'step_ready') { engine.completeStep(n.step_id, { prepared: 42 }); n = engine.nextStep(); }
    expect(n.status).toBe('paused');
    const runId = (init as { instance_id: string }).instance_id;
    return { stateDir, runId, instDir: join(stateDir, runId) };
  }
  /** 把盘上 state.json 的最后写入者改成指定 pid（模拟"别的进程最后写过这份快照"）。 */
  function setLastWriter(instDir: string, pid: number): void {
    const p = join(instDir, 'state.json');
    const st = JSON.parse(readFileSync(p, 'utf-8'));
    st.last_writer = { pid, at: '2026-10-04T00:00:00.000Z' };
    writeFileSync(p, JSON.stringify(st));
  }

  it('正例：paused 快照不在注册表 → 写墓碑、删问题卡,返回 aborted+restored_from_snapshot;之后 run_status 报 aborted、resume_run 拒 RUN_ABORTED', () => {
    const { stateDir, runId, instDir } = pausedSnapshot();
    expect(existsSync(join(instDir, 'paused.json'))).toBe(true);
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });   // 新 core = 重启后的空注册表
    const r = core.stopRun(runId, stateDir);
    expect(r).toEqual({ run_id: runId, status: 'aborted', restored_from_snapshot: true });
    expect(existsSync(join(instDir, 'aborted.json'))).toBe(true);
    expect(existsSync(join(instDir, 'paused.json'))).toBe(false);
    expect((core as any).runs.has(runId)).toBe(false);                 // 纯盘操作,不建注册项
    expect(core.runStatus(runId, stateDir)['status']).toBe('aborted');
    const rr = core.resumeRun(runId, '2', { result: 42 }, stateDir);
    expect((rr['error'] as { code: string }).code).toBe('RUN_ABORTED');
    // 幂等:再停一次照样回 aborted,不报错
    expect(core.stopRun(runId, stateDir)).toEqual({ run_id: runId, status: 'aborted', restored_from_snapshot: true });
  });

  it('正例：最后写入者是已退出的进程（server 重启的真实形态）→ 照常写墓碑中止', () => {
    const { stateDir, runId, instDir } = pausedSnapshot();
    const gone = spawnSync(process.execPath, ['-e', '']).pid as number;   // 子进程已退出,pid 不再存活
    setLastWriter(instDir, gone);
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    expect(core.stopRun(runId, stateDir)['status']).toBe('aborted');
    expect(existsSync(join(instDir, 'aborted.json'))).toBe(true);
  });

  it('反例：没传 state_dir 且缺省目录下没有该 run → RUN_NOT_FOUND,报文提示传 start_run 返回的 state_dir', () => {
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const r = core.stopRun('no-such-run-0117');
    expect((r['error'] as { code: string }).code).toBe('RUN_NOT_FOUND');
    expect((r['error'] as { message: string }).message).toContain('state_dir');
  });

  it('反例：快照已是终态（completed）→ 幂等回终态,不写墓碑', () => {
    const { stateDir, runId, instDir } = pausedSnapshot();
    const p = join(instDir, 'state.json');
    const st = JSON.parse(readFileSync(p, 'utf-8'));
    st.terminal_state = 'completed';
    writeFileSync(p, JSON.stringify(st));
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    expect(core.stopRun(runId, stateDir)).toEqual({ run_id: runId, status: 'completed', restored_from_snapshot: true });
    expect(existsSync(join(instDir, 'aborted.json'))).toBe(false);
  });

  it('反例：最后写入者是别的存活进程 → RUN_OWNED_ELSEWHERE,不写墓碑、问题卡原样', () => {
    const { stateDir, runId, instDir } = pausedSnapshot();
    setLastWriter(instDir, process.ppid);   // 父进程必然存活且不是本进程
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const r = core.stopRun(runId, stateDir);
    expect((r['error'] as { code: string }).code).toBe('RUN_OWNED_ELSEWHERE');
    expect((r['error'] as { message: string }).message).toContain(String(process.ppid));
    expect(existsSync(join(instDir, 'aborted.json'))).toBe(false);
    expect(existsSync(join(instDir, 'paused.json'))).toBe(true);
  });

  it('反例：run 属 CLI 通道（driver_channel=cli）→ DRIVER_CHANNEL_MISMATCH,报文指路 hopjit abort,不写墓碑', () => {
    const { stateDir, runId, instDir } = pausedSnapshot('cli');
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const r = core.stopRun(runId, stateDir);
    expect((r['error'] as { code: string }).code).toBe('DRIVER_CHANNEL_MISMATCH');
    expect((r['error'] as { message: string }).message).toContain('hopjit abort');
    expect(existsSync(join(instDir, 'aborted.json'))).toBe(false);
  });

  it('反例：墓碑写不进去（实例目录只读）→ STOP_WRITE_FAILED,如实报中止没有生效', () => {
    if (process.getuid?.() === 0) return;   // root 无视目录权限,本例无从构造
    const { stateDir, runId, instDir } = pausedSnapshot();
    chmodSync(instDir, 0o555);
    try {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
      const r = core.stopRun(runId, stateDir);
      expect((r['error'] as { code: string }).code).toBe('STOP_WRITE_FAILED');
      expect(existsSync(join(instDir, 'aborted.json'))).toBe(false);
    } finally { chmodSync(instDir, 0o755); }
  });

  it('工具面：stop_run 注册的入参里有可选的 state_dir,handler 把它透传给 core.stopRun', async () => {
    const { buildServer: build } = await import('../src/mcp-server.js');
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const tool = (build(core) as any)._registeredTools['stop_run'];
    const shape = tool.inputSchema.shape ?? tool.inputSchema._def?.shape?.();
    expect(Object.keys(shape).sort()).toEqual(['run_id', 'state_dir']);
    expect(shape.state_dir.isOptional()).toBe(true);
    const spy = vi.spyOn(core, 'stopRun');
    await tool.handler({ run_id: 'x', state_dir: '/tmp/somewhere' }, {});
    expect(spy).toHaveBeenCalledWith('x', '/tmp/somewhere');
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

// todo/0146 —— 配置能力状态、复用驱动工具、commit 批准入口、放行清单
describe('配置问题记为能力状态（todo/0146）', () => {
  // @v: anc-mcp-server-status
  it('classifyConfigError 四类各给修法', async () => {
    const { classifyConfigError } = await import('../src/mcp-server.js');
    expect(classifyConfigError('STANDALONE_CONFIG_MISSING: 找不到配置').fix).toContain('~/.hopjit/config.yaml');
    expect(classifyConfigError('STANDALONE_CONFIG_MISSING_PROVIDERS: 缺 providers[]').fix).toContain('providers');
    const key = classifyConfigError('STANDALONE_KEY_MISSING: 环境变量 MY_K 未设置（provider \'x\'）——独立模式不可用');
    expect(key.fix).toContain('MY_K');
    expect(classifyConfigError('STANDALONE_CONFIG_PLAINTEXT_KEY: 禁止').fix).toContain('api_key_env');
    // 兜底分支:未识别的报文也给修法,且不冒充前三类
    const other = classifyConfigError('WEIRD_CONFIG: 不认识的问题');
    expect(other.reason).toBe('WEIRD_CONFIG: 不认识的问题');
    expect(other.fix.length).toBeGreaterThan(0);
    for (const known of ['STANDALONE_CONFIG_MISSING: x', 'STANDALONE_CONFIG_MISSING_PROVIDERS: x', 'STANDALONE_KEY_MISSING: 环境变量 K 未设置']) {
      expect(other.fix).not.toBe(classifyConfigError(known).fix);
    }
  });

  it('config 为 null:server_status 如实报不可用与修法,start_run / 独立模式 resume_run 返回 STANDALONE_UNAVAILABLE', async () => {
    const core = new HopjitMcpCore(null, { reason: 'STANDALONE_CONFIG_MISSING: x', fix: '创建配置' }, '/nonexistent/cfg.yaml');
    const st = core.serverStatus(['run']) as any;
    expect(st.standalone).toMatchObject({ available: false, reason: 'STANDALONE_CONFIG_MISSING: x', fix: '创建配置', config_path: '/nonexistent/cfg.yaml' });
    expect(st.reuse_tools_available).toBe(true);
    // 闸缺席时 startRun 会在 config 为 null 处抛异常——接住转成对象,失败信息是"错误码不等"而不是 TypeError
    const r = await core.startRun(join(REPO, 'examples', 'coffee-week.md'), {}).catch((e: unknown) => ({ thrown: String(e) }));
    expect(r).toMatchObject({ error: { code: 'STANDALONE_UNAVAILABLE', fix: '创建配置' } });
    // mock 补齐 resume_run 闸后会用到的全部方法:闸缺席时走到 resume 返回 running,失败信息同样是错误码不等
    const engine = {
      assertStateFresh: () => undefined, claimDriverChannel: () => undefined,
      getStepStates: () => new Map([['2', 'running']]), checkCommitApproval: () => null,
      getInflight: () => [], getSpec: () => ({ steps: [] }), getCumulativeTokens: () => 0,
    };
    const dispatcher = { getEngine: () => engine, getPausedChildren: () => new Map(), resume: async () => ({ status: 'completed', outputs: {} }) };
    (core as any).runs.set('r1', { runId: 'r1', specPath: '/x.md', state: 'paused', dispatcher, paused: { status: 'paused', step_id: '2', pause_reason: 'ask' }, startedAt: 't' });
    expect(core.resumeRun('r1', '2', { value: 'x' })).toMatchObject({ error: { code: 'STANDALONE_UNAVAILABLE' } });
    expect((core as any).runs.get('r1').state).toBe('paused');
  });

  it('config 合法:server_status 报可用且无 reason', () => {
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const st = core.serverStatus([]) as any;
    expect(st.standalone.available).toBe(true);
    expect(st.standalone.reason).toBeUndefined();
  });
});

describe('复用驱动工具与 commit 批准（todo/0146,经工具 handler 调用）', () => {
  const SIMPLE = `# 简单
Id: simple

## Goal
g

## Outputs
- answer: line  # 结果

## Steps
1. [act] 算
  + → answer: line  # 结果
  > 算出结果
`;
  const GATED = `# 批准
Id: gated

## Goal
g

## Outputs
- out: line  # 交付

## Steps
1. [subtask] 把关
  + → ok: bool
  1.1. [check final] 核对
    + → ok: bool  # 判定
    + → note: text  # 说明
    > pass
2. [commit] 交付
  + → out: line
  > 覆盖写一个文件,不留旧版本（引擎判需要确认,没有分析模型 → 转人工）
  > \`\`\`hop_python
  > w = write(path: "shipped.txt", content: "x", keep: 0)
  > out = "shipped"
  > \`\`\`
`;
  type Tools = Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
  let tools: Tools;
  beforeAll(() => {
    tools = (buildServer(new HopjitMcpCore(null, { reason: 'STANDALONE_CONFIG_MISSING: 测试', fix: '' })) as any)._registeredTools as Tools;
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await tools[name].handler(args, {});
    return { body: JSON.parse(r.content[0].text), isError: r.isError === true };
  };
  const ws = (spec: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-drv-'));
    writeFileSync(join(dir, 's.md'), spec);
    return dir;
  };

  // @v: anc-mcp-reuse-driver-tools
  it('正例：config 缺失时 run→submit→status 全程可用,validate 只读', async () => {
    const dir = ws(SIMPLE);
    const v = await call('validate', { spec_path: 's.md', workspace_dir: dir });
    expect(v.body.status).toBe('ok');
    expect(existsSync(join(dir, '.hopstate'))).toBe(false);   // validate 只读:不建状态目录
    const r = await call('run', { spec_path: 's.md', workspace_dir: dir });
    expect(r.body.status).toBe('step_ready');
    expect(r.body.step_id).toBe('1');
    const id = r.body.instance_id;
    const done = await call('submit_and_fetch_next', { step_id: '1', output: { answer: '42' }, instance_id: id, workspace_dir: dir });
    expect(done.body.status).toBe('completed');
    expect(done.body.outputs.answer).toBe('42');
    const st = await call('status', { instance_id: id, workspace_dir: dir });
    expect(st.isError).toBe(false);
    expect(st.body.execution_status).toBe('completed');
    expect(st.body.instance_id).toBe(id);
    expect(existsSync(join(dir, '.hopstate', id))).toBe(true);   // state_dir 缺省相对工作区根
  });

  // @v: anc-config-reuse-consume
  it('正例（review 面三缺陷 3）：复用驱动 run 经 applyReuseConfig 吃两级配置——假 HOME 的 config.yaml commands/language + 工作区 hopjit.yaml 纯注释模板 → state.json host_context 带 available=[git] 与 hop_env_language=zh（三组合根之一此前零测试）', async () => {
    const dir = ws(SIMPLE);
    const fakeHome = mkdtempSync(join(tmpdir(), 'mcp-drv-home-'));
    mkdirSync(join(fakeHome, '.hopjit'), { recursive: true });
    writeFileSync(join(fakeHome, '.hopjit', 'config.yaml'), 'language: zh\ncommands: [git]\n');
    writeFileSync(join(dir, 'hopjit.yaml'), '# 模板\n# language: en\n');
    const savedHome = process.env.HOME; const savedCfg = process.env.HOPJIT_CONFIG;
    process.env.HOME = fakeHome; delete process.env.HOPJIT_CONFIG;
    try {
      const r = await call('run', { spec_path: 's.md', workspace_dir: dir });
      expect(r.body.status).toBe('step_ready');
      const st = JSON.parse(readFileSync(join(dir, '.hopstate', r.body.instance_id, 'state.json'), 'utf-8'));
      expect(st.host_context.sandbox.runtime.available).toEqual(['git']);   // 变异：reuse-driver 去掉 applyReuseConfig 调用 → [] 红
      expect(st.host_context.hop_env.hop_env_language).toBe('zh');
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedCfg === undefined) delete process.env.HOPJIT_CONFIG; else process.env.HOPJIT_CONFIG = savedCfg;
    }
  });

  it('反例：互斥提交形态 / work_zone 外 @路径 / 非法 status / 不存在的工作区 → 结构化错误,isError 标记', async () => {
    const dir = ws(SIMPLE);
    const r = await call('run', { spec_path: 's.md', workspace_dir: dir });
    const id = r.body.instance_id;
    const two = await call('submit_and_fetch_next', { step_id: '1', output: { answer: 'a' }, failure: 'x', instance_id: id, workspace_dir: dir });
    expect(two.isError).toBe(true);
    expect(two.body.error.code).toBe('INVALID_STATE');
    writeFileSync(join(dir, 'outside.json'), '{"answer":"x"}');
    const esc = await call('submit_and_fetch_next', { step_id: '1', output: '@outside.json', instance_id: id, workspace_dir: dir });
    expect(esc.body.error.code).toBe('WORK_ZONE_VIOLATION');
    const reap = await call('reap_and_fetch_next', { child_instance: 'c', status: 'done', instance_id: id, workspace_dir: dir });
    expect(reap.body.error.code).toBe('INVALID_ARG');
    const nows = await call('status', { workspace_dir: join(dir, 'nope') });
    expect(nows.body.error.code).toBe('WORKSPACE_NOT_FOUND');
    const noInst = await call('status', { instance_id: 'ghost', workspace_dir: dir });
    expect(noInst.body.error.code).toBe('INSTANCE_NOT_FOUND');
    const bad = ws('# 坏\n## Steps\n1. [nosuch] x\n');
    expect((await call('validate', { spec_path: 's.md', workspace_dir: bad })).body.status).toBe('error');
    // 中止后实例进终态
    const ab = await call('abort', { instance_id: id, reason: '测试', workspace_dir: dir });
    expect(ab.isError).toBe(false);
    expect((await call('status', { instance_id: id, workspace_dir: dir })).body.execution_status).toBe('aborted');
    const abGhost = await call('abort', { instance_id: 'ghost', workspace_dir: dir });
    expect(abGhost.isError).toBe(true);
    expect(abGhost.body.error.code).toBe('INSTANCE_NOT_FOUND');
  });

  it('反例：run 工具 spec 不存在 / log_level 非法 / max_runs 非正整数 / notify 渠道不支持 → 结构化错误,不建状态目录', async () => {
    const dir = ws(SIMPLE);
    const miss = await call('run', { spec_path: 'nope.md', workspace_dir: dir });
    expect(miss.isError).toBe(true);
    expect(miss.body.error.code).toBe('ENOENT');
    expect(miss.body.error.message).toContain('nope.md');
    for (const bad of [{ log_level: 'bad' }, { max_runs: 0 }, { max_runs: 1.5 }, { notify: 'sms' }]) {
      const r = await call('run', { spec_path: 's.md', workspace_dir: dir, ...bad });
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe('INVALID_ARG');
    }
    expect(existsSync(join(dir, '.hopstate'))).toBe(false);
  });

  // @v: anc-mcp-reuse-driver-tools
  it('反例：answer/output 解析后不是 JSON 对象（字符串、数字、null、数组）→ INVALID_ARG,confirm 停点不动;正确形态照常推进', async () => {
    const dir = ws(`# 确认
Id: cfm

## Goal
g

## Outputs
- approval: bool  # 审批

## Steps
1. [confirm] 审批
  + → approval: bool  # 审批
`);
    const r = await call('run', { spec_path: 's.md', workspace_dir: dir });
    expect(r.body.status).toBe('paused');
    const id = r.body.instance_id;
    for (const bad of ['"approve"', '3', 'null', '[1]']) {
      const s = await call('submit_and_fetch_next', { step_id: '1', answer: bad, instance_id: id, workspace_dir: dir });
      expect(s.isError).toBe(true);
      expect(s.body.error.code).toBe('INVALID_ARG');
      expect(s.body.error.message).toContain('{"value":"approve"}');
    }
    const st = await call('status', { instance_id: id, workspace_dir: dir });
    expect(st.body.execution_status).toBe('paused');
    expect(st.body.current_step).toBe('1');
    const ok = await call('submit_and_fetch_next', { step_id: '1', answer: { value: 'approve' }, instance_id: id, workspace_dir: dir });
    expect(ok.body.status).toBe('completed');
    expect(ok.body.outputs.approval).toBe(true);
  });

  // @v: anc-mcp-commit-approve, anc-mcp-dirs-approve
  it('反例：approve_commit / approve_dirs 显式传了不存在的工作区 → WORKSPACE_NOT_FOUND（与驱动工具同一规则）', async () => {
    const dir = ws(SIMPLE);
    const c = await call('approve_commit', { instance_id: 'x', step_id: '2', fingerprint: 'h', scope: 'once', workspace_dir: join(dir, 'nope') });
    expect(c.body.error.code).toBe('WORKSPACE_NOT_FOUND');
    const d = await call('approve_dirs', { instance_id: 'x', dirs_hash: 'h', workspace_dir: join(dir, 'nope') });
    expect(d.body.error.code).toBe('WORKSPACE_NOT_FOUND');
  });

  // @v: anc-exec-driver-channel
  it('驱动工具起跑的 run 认领 cli 通道:state.json 记 driver_channel=cli,同一实例可改用 hopjit 命令行推进', async () => {
    const dir = ws(SIMPLE);
    const r = await call('run', { spec_path: 's.md', workspace_dir: dir });
    const id = r.body.instance_id;
    const state = JSON.parse(readFileSync(join(dir, '.hopstate', id, 'state.json'), 'utf-8'));
    expect(state.driver_channel).toBe('cli');
    const cli = spawnSync('node', [join(REPO, 'dist', 'cli.js'), '--json', 'submit_and_fetch_next', '1', '--output', '{"answer":"42"}', '--state-dir', '.hopstate', '--instance', id], { cwd: dir, encoding: 'utf-8', timeout: 30000 });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout).status).toBe('completed');
  });

  // @v: anc-hopant-commit-store
  it('HopAnt 目录下的 spec:批准账落 <HopAnt 目录>/inner_store/commit_approvals.json,不落工作区 .hopstate', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mcp-home-'));
    const prevHome = process.env['HOME'];
    process.env['HOME'] = home;   // 组合根按 homedir() 现取 HopAnt 根;测试结束恢复
    try {
      const antDir = join(home, '.hopjit', 'ants', 'gated');
      mkdirSync(antDir, { recursive: true });
      writeFileSync(join(antDir, 'gated.md'), GATED);
      const dir = mkdtempSync(join(tmpdir(), 'mcp-drv-ws-'));
      const r = await call('run', { spec_path: join(antDir, 'gated.md'), workspace_dir: dir });
      expect(r.body.step_id).toBe('1.1');
      const id = r.body.instance_id;
      const p = await call('submit_and_fetch_next', { step_id: '1.1', output: { ok: true, note: '' }, instance_id: id, workspace_dir: dir });
      expect(p.body.pause_reason).toBe('commit');
      const ok = await call('approve_commit', { instance_id: id, step_id: '2', fingerprint: p.body.presented_data.context.fingerprint, scope: 'once', workspace_dir: dir });
      expect(ok.body.status).toBe('ok');
      expect(existsSync(join(realpathSync(antDir), 'inner_store', 'commit_approvals.json'))).toBe(true);
      expect(existsSync(join(dir, '.hopstate', 'commit_approvals.json'))).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome;
    }
  });

  // @v: anc-mcp-commit-approve
  it('commit：停在批准点→递交产出被拒→错哈希被拒→approve_commit→resume 执行;once 不跨运行,task 之后同 spec 再跑不停', async () => {
    const dir = ws(GATED);
    const r = await call('run', { spec_path: 's.md', workspace_dir: dir });
    const id = r.body.instance_id;
    expect(r.body.step_id).toBe('1.1');
    const p = await call('submit_and_fetch_next', { step_id: '1.1', output: { ok: true, note: '' }, instance_id: id, workspace_dir: dir });
    expect(p.body.status).toBe('paused');
    expect(p.body.pause_reason).toBe('commit');
    const ctx = p.body.presented_data.context;
    expect(ctx.body).toContain('out = "shipped"');
    const forged = await call('submit_and_fetch_next', { step_id: '2', output: { out: 'forged' }, instance_id: id, workspace_dir: dir });
    expect(forged.body.code ?? forged.body.error?.code).toBe('COMMIT_BODY_ENGINE_ONLY');
    const still = await call('resume', { instance_id: id, workspace_dir: dir });
    expect(still.body.pause_reason).toBe('commit');   // 未批准续跑仍停,body 不执行
    const wrong = await call('approve_commit', { instance_id: id, step_id: '2', fingerprint: 'deadbeef', scope: 'once', workspace_dir: dir });
    expect(wrong.body.error.code).toBe('COMMIT_NOT_APPROVED');
    const ok = await call('approve_commit', { instance_id: id, step_id: '2', fingerprint: ctx.fingerprint, scope: 'once', workspace_dir: dir });
    expect(ok.body.status).toBe('ok');
    expect(existsSync(join(dir, '.hopstate', 'commit_approvals.json'))).toBe(true);   // 任务卡/项目 spec 的账在 .hopstate 下
    const done = await call('resume', { instance_id: id, workspace_dir: dir });
    expect(done.body.status).toBe('completed');
    expect(done.body.outputs.out).toBe('shipped');
    // 新一次运行:once 不跨运行,再停;同一份分析不重复做,批 task 后第三次运行不停
    const r2 = await call('run', { spec_path: 's.md', workspace_dir: dir });
    const p2 = await call('submit_and_fetch_next', { step_id: '1.1', output: { ok: true, note: '' }, instance_id: r2.body.instance_id, workspace_dir: dir });
    expect(p2.body.pause_reason).toBe('commit');
    expect((await call('approve_commit', { instance_id: r2.body.instance_id, step_id: '2', fingerprint: ctx.fingerprint, scope: 'task', workspace_dir: dir })).body.status).toBe('ok');
    const r3 = await call('run', { spec_path: 's.md', workspace_dir: dir });
    const done3 = await call('submit_and_fetch_next', { step_id: '1.1', output: { ok: true, note: '' }, instance_id: r3.body.instance_id, workspace_dir: dir });
    expect(done3.body.status).toBe('completed');
  });

  it('resume_run 遇未批准的 commit 停点 → COMMIT_NOT_APPROVED,run 保持 paused', () => {
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const engine = {
      assertStateFresh: () => undefined, claimDriverChannel: () => undefined,
      getStepStates: () => new Map([['2', 'running']]),
      checkCommitApproval: () => ({ approved: false, decided_by: null, fingerprint: 'h1', body: 'out = 1', actions: [], store_path: '/x', analysis: null }),
      getCumulativeTokens: () => ({ input: 0, output: 0 }),
    };
    (core as any).runs.set('r1', { runId: 'r1', specPath: '/x.md', state: 'paused', dispatcher: { getEngine: () => engine, getPausedChildren: () => new Map() }, paused: { status: 'paused', step_id: '2', pause_reason: 'commit' }, startedAt: 't' });
    const r = core.resumeRun('r1', '2', {}) as any;
    expect(r.error.code).toBe('COMMIT_NOT_APPROVED');
    expect(r.error.fingerprint).toBe('h1');
    expect((core as any).runs.get('r1').state).toBe('paused');   // 拒于状态翻转之前
  });

  // @v: anc-cli-install-skill-permission
  it('放行清单 = 注册的全部工具（含 approve_commit 与 approve_dirs——两种批准的人同意都在对话里问,不靠载体弹窗）', async () => {
    const { HOPJIT_ALLOWED_TOOLS, APPROVE_COMMIT_TOOL, APPROVE_DIRS_TOOL, OPENCODE_DISABLED_TOOLS, RUN_APPROVED_COMMAND_TOOL } = await import('../src/provider-types.js');
    expect([...HOPJIT_ALLOWED_TOOLS].sort()).toEqual(Object.keys(tools).sort());
    expect(HOPJIT_ALLOWED_TOOLS).toContain(APPROVE_COMMIT_TOOL);
    expect(HOPJIT_ALLOWED_TOOLS).toContain(APPROVE_DIRS_TOOL);   // @v: anc-mcp-dirs-approve
    // opencode 关闭清单 ⊆ 注册面,且与复用模式要用的件零交集（驱动七件 + 批准三件 + server_status）——mcp-server 新增独立模式工具时这里红 // @v: anc-cli-opencode-tools-gate
    for (const t of OPENCODE_DISABLED_TOOLS) expect(Object.keys(tools)).toContain(t);
    const ADMIN = ['doctor', 'ant_list', 'ant_install', 'ant_adapt', 'ant_remove', 'ant_bootstrap', 'ant_pack', 'ant_share'];   // 管理八件两模式共用（^anc-mcp-admin-tools） // @v: anc-mcp-admin-tools
    const reuseNeeded = ['run', 'submit_and_fetch_next', 'reap_and_fetch_next', 'status', 'resume', 'abort', 'validate', APPROVE_COMMIT_TOOL, APPROVE_DIRS_TOOL, RUN_APPROVED_COMMAND_TOOL, 'server_status', ...ADMIN];
    for (const t of reuseNeeded) expect(OPENCODE_DISABLED_TOOLS).not.toContain(t);
    expect([...OPENCODE_DISABLED_TOOLS, ...reuseNeeded].sort()).toEqual(Object.keys(tools).sort());   // 两集合恰好瓜分注册面
  });

  // @v: anc-mcp-commit-approve
  it('tools/list：所有工具（含 approve_commit 与 approve_dirs）都不带 _meta requiresUserInteraction——人批准不靠载体强制弹窗', async () => {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const server = buildServer(new HopjitMcpCore(null, { reason: 'STANDALONE_CONFIG_MISSING: 测试', fix: '' }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    const listed = (await client.listTools()).tools;
    await client.close();
    const flag = (n: string) => (listed.find(t => t.name === n)?._meta as Record<string, unknown> | undefined)?.['anthropic/requiresUserInteraction'];
    expect(listed.length).toBe(Object.keys(tools).length);
    expect(listed.some(t => t.name === 'approve_commit')).toBe(true);
    expect(listed.some(t => t.name === 'approve_dirs')).toBe(true);   // @v: anc-mcp-dirs-approve
    for (const t of listed) expect(flag(t.name)).toBeUndefined();
    // approve_commit 的 fingerprint 参数说明经 tools/list 直接给调用方 agent 看:只覆盖 body,不提输入值与引用文件
    const fpDesc = (listed.find(t => t.name === 'approve_commit')?.inputSchema as any)?.properties?.fingerprint?.description as string;
    expect(fpDesc).toContain('body 的指纹');
    expect(fpDesc).not.toMatch(/输入值|引用文件/);   // @v: anc-mcp-commit-approve
  });

  it('server_status 工具列出全部注册工具;注解如实（只读件 readOnly,abort destructive）', async () => {
    const st = await call('server_status', {});
    expect([...st.body.tools].sort()).toEqual(Object.keys(tools).sort());
    expect(st.body.standalone.available).toBe(false);
    const ann = (n: string) => (tools as any)[n].annotations;
    for (const n of ['status', 'validate', 'server_status', 'doctor', 'ant_list']) expect(ann(n)).toMatchObject({ readOnlyHint: true });
    for (const n of ['run', 'submit_and_fetch_next', 'reap_and_fetch_next', 'resume', 'approve_commit']) expect(ann(n)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(ann('abort')).toMatchObject({ destructiveHint: true });
    expect(ann('ant_remove')).toMatchObject({ destructiveHint: true });   // 删目录如实标破坏性 // @v: anc-mcp-admin-tools
    expect(ann('ant_bootstrap')).toMatchObject({ openWorldHint: true });   // 跑 HopAnt 自带脚本可联网如实标 // @v: anc-mcp-admin-tools
  });
});

// 管理工具面八件（^anc-mcp-admin-tools,todo/0154）：业务体在 hop-admin.ts,server 组合根读 homedir()/cwd/env 装 AdminContext。
// 测试在假 HOME 下走 pack → install → adapt → list → remove 一条链;反例看结构化错误与 isError。
// @v: anc-mcp-admin-tools
describe('管理工具面（doctor / ant_*）', () => {
  type Tools = Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
  let tools: Tools;
  const savedEnv: Record<string, string | undefined> = {};
  let home: string;
  beforeAll(() => {
    tools = (buildServer(new HopjitMcpCore(null, { reason: 'STANDALONE_CONFIG_MISSING: 测试', fix: '' })) as any)._registeredTools as Tools;
    // 假 HOME：os.homedir() 在 POSIX 上读 HOME,server 的 adminContext 由它取 ~/.hopjit;几个载体重定向变量一并清掉
    for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'HOPJIT_CONFIG']) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    home = mkdtempSync(join(tmpdir(), 'mcp-admin-home-'));
    process.env.HOME = home;
  });
  afterAll(() => { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await tools[name].handler(args, {});
    return { body: JSON.parse(r.content[0].text), isError: r.isError === true };
  };
  const SPEC = (id: string) => `# Spec: ${id} 标题\nId: ${id}\nGoal: ${id} 的目标\n\n## Outputs\n- out % text  # 结果\n\n## Steps\n1. [act free] 干活\n  + → out % text  # 结果\n`;

  it('正例：ant_pack → ant_install → ant_adapt → ant_list → ant_remove 一条链在假 HOME 下走通;响应与 CLI 同形（action 字段）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mcp-admin-ws-'));
    writeFileSync(join(ws, 'weather.md'), SPEC('weather-brief'));
    const p = await call('ant_pack', { spec_path: 'weather.md', workspace_dir: ws });
    expect(p.isError).toBe(false);
    expect(p.body.action).toBe('pack'); expect(p.body.id).toBe('weather-brief');
    expect(p.body.pack.dir).toBe(join(ws, 'ants', 'weather-brief'));   // out 缺省 <workspace_dir>/ants
    const dry = await call('ant_install', { dir: p.body.pack.dir, dry_run: true, workspace_dir: ws });
    expect(dry.body.dry_run).toBe(true); expect(existsSync(join(home, '.hopjit', 'ants', 'weather-brief'))).toBe(false);
    const i = await call('ant_install', { dir: join('ants', 'weather-brief'), workspace_dir: ws });   // 相对路径按 workspace_dir 解析
    expect(i.isError).toBe(false); expect(i.body.result.installed).toEqual(['weather-brief']);
    expect(existsSync(join(home, '.hopjit', 'ants', 'weather-brief', 'weather-brief.md'))).toBe(true);   // 写的是假 HOME,由 server 进程落盘
    const a = await call('ant_adapt', { id: 'weather-brief', workspace_dir: ws });
    expect(a.isError).toBe(false); expect(a.body.report.ok).toBe(true); expect(typeof a.body.stamp_written).toBe('string');
    const l = await call('ant_list', { workspace_dir: ws });   // 显式传工作区——不传时项目级根按进程 cwd 算,仓库根下有 hop_tasks/ants/ 就多出条目（review D13 实撞）
    expect(l.body.ants).toEqual([{ id: 'weather-brief', scope: 'user', title: 'weather-brief 标题', adapt_state: 'adapted' }]);   // 装到缺省的用户级,条目带 scope（两级根,设计 hopant 决策 9）
    const b = await call('ant_bootstrap', { id: 'weather-brief', dry_run: true });
    expect(b.body.has_bootstrap).toBe(false);   // 没有 bootstrap.js 不报错
    const r = await call('ant_remove', { id: 'weather-brief' });
    expect(r.body.removed).toBe(true);
    expect((await call('ant_list', { workspace_dir: ws })).body.ants).toEqual([]);
  });

  it('正例：ant_share 首机无 owner_id 且不带 owner/yes → 不写包,返回 owner_prompt_required 与 owner_default;带 owner 重跑写包并把 owner 写回 config.yaml', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mcp-admin-ws-'));
    writeFileSync(join(ws, 's.md'), SPEC('share-me'));
    const p = await call('ant_pack', { spec_path: 's.md', workspace_dir: ws });
    await call('ant_install', { dir: p.body.pack.dir, workspace_dir: ws });
    const ask = await call('ant_share', { ids: ['share-me'], workspace_dir: ws });
    expect(ask.isError).toBe(false); expect(ask.body.owner_prompt_required).toBe(true); expect(typeof ask.body.owner_default).toBe('string');
    expect(existsSync(join(ws, 'share-me', 'package.json'))).toBe(false);
    const ok = await call('ant_share', { ids: ['share-me'], owner: 'tester-box', workspace_dir: ws });
    expect(ok.isError).toBe(false); expect(ok.body.share.dir).toBe(join(ws, 'share-me'));
    expect(existsSync(join(ws, 'share-me', 'package.json'))).toBe(true);
    expect(readFileSync(join(home, '.hopjit', 'config.yaml'), 'utf-8')).toContain('owner_id: tester-box');
    expect(ok.body.credential_scan.disclaimer).toBeTruthy();
    // @v: anc-hopant-share —— 决策 8"答过不再问"：owner 写回 config.yaml 之后再分享不带 owner 也不问,直接用落盘值写包（变异 M15b：取值链去掉 savedOwnerId → 又返回 owner_prompt_required,红）
    const out2 = mkdtempSync(join(tmpdir(), 'mcp-admin-share-out2-'));
    const again = await call('ant_share', { ids: ['share-me'], workspace_dir: ws, out: out2 });
    expect(again.isError).toBe(false);
    expect(again.body.owner_prompt_required).not.toBe(true);
    expect(again.body.share.dir).toBe(join(out2, 'share-me'));
    expect(existsSync(join(out2, 'share-me', 'package.json'))).toBe(true);
    expect(readFileSync(join(out2, 'share-me', 'package.json'), 'utf-8')).toContain('tester-box');
    await call('ant_remove', { id: 'share-me' });
  });

  // @v: anc-mcp-admin-tools —— scope 全链（review 变异 G2 install scope 透传 / G5 adapt 两级查找 / G6 remove scope 透传 / G10 list 两级合并带 scope）：
  // 同一个 id 先装用户级再装项目级不冲突（撞 id 只判目标级）;list 两条 project 在前;adapt 命中项目级;remove 按 scope 指定删,不传删项目级
  it('正例：scope:project 全链——同 id 用户级与项目级并存不冲突;ant_list 两条 project 在前;ant_adapt 命中 project;ant_remove 指定 scope:user 删用户级留项目级,不传 scope 删项目级', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mcp-admin-ws-'));
    const id = 'two-level';
    writeFileSync(join(ws, 'u.md'), SPEC(id));
    const pu = await call('ant_pack', { spec_path: 'u.md', workspace_dir: ws, out: join(ws, 'src-user') });
    expect(pu.isError).toBe(false);
    const iu = await call('ant_install', { dir: pu.body.pack.dir, workspace_dir: ws });   // 不传 scope → 用户级
    expect(iu.isError).toBe(false); expect(iu.body.scope).toBe('user');
    expect(existsSync(join(home, '.hopjit', 'ants', id, `${id}.md`))).toBe(true);
    // 另一份来源（同 id,内容多一段 Constraints 以便区分）装项目级：不报 HOPANT_ID_CONFLICT（变异 M2"两级任一存在即冲突"→ 红;变异 M9a scope 恒 user → 真撞 id 报冲突,红）
    writeFileSync(join(ws, 'p.md'), SPEC(id).replace('## Outputs', '## Constraints\n- 项目级那份\n\n## Outputs'));
    const pp = await call('ant_pack', { spec_path: 'p.md', workspace_dir: ws, out: join(ws, 'src-proj') });
    expect(pp.isError).toBe(false);
    const ip = await call('ant_install', { dir: pp.body.pack.dir, scope: 'project', workspace_dir: ws });
    expect(ip.isError, JSON.stringify(ip.body)).toBe(false);
    expect(ip.body.scope).toBe('project');
    expect(ip.body.plan.root).toBe(join(ws, 'hop_tasks', 'ants'));
    expect(existsSync(join(ws, 'hop_tasks', 'ants', id, `${id}.md`))).toBe(true);
    expect(readFileSync(join(ws, 'hop_tasks', 'ants', id, `${id}.md`), 'utf-8')).toContain('项目级那份');
    // list：两条同 id,project 在前 user 在后（G10）
    const l = await call('ant_list', { workspace_dir: ws });
    expect(l.body.ants.map((a: { id: string; scope: string }) => [a.id, a.scope])).toEqual([[id, 'project'], [id, 'user']]);
    // adapt：两级查找命中项目级,响应 scope 为 project,戳写进项目级那份的 inner_store（G5;变异 M17 只查用户级 → scope 为 user,红）
    const a = await call('ant_adapt', { id, workspace_dir: ws });
    expect(a.isError).toBe(false); expect(a.body.scope).toBe('project'); expect(a.body.report.ok).toBe(true);
    expect(a.body.stamp_written).toBe(join(ws, 'hop_tasks', 'ants', id, 'inner_store', 'adapt.yaml'));
    expect(existsSync(join(home, '.hopjit', 'ants', id, 'inner_store', 'adapt.yaml'))).toBe(false);
    // remove scope:user：删用户级,项目级那份仍在（G6;变异 M9b scope 不透传 → 删的是项目级,红）
    const ru = await call('ant_remove', { id, scope: 'user', workspace_dir: ws });
    expect(ru.isError).toBe(false); expect(ru.body.removed).toBe(true); expect(ru.body.scope).toBe('user');
    expect(existsSync(join(home, '.hopjit', 'ants', id))).toBe(false);
    expect(existsSync(join(ws, 'hop_tasks', 'ants', id, `${id}.md`))).toBe(true);
    expect((await call('ant_list', { workspace_dir: ws })).body.ants.map((x: { scope: string }) => x.scope)).toEqual(['project']);
    // remove 不传 scope：两级查找命中项目级,删它并回报 scope:project
    const rp = await call('ant_remove', { id, workspace_dir: ws });
    expect(rp.isError).toBe(false); expect(rp.body.removed).toBe(true); expect(rp.body.scope).toBe('project');
    expect(existsSync(join(ws, 'hop_tasks', 'ants', id))).toBe(false);
    expect((await call('ant_list', { workspace_dir: ws })).body.ants).toEqual([]);
  });

  it('反例：撞 id / 不存在的 id / spec 不存在 / 不存在的工作区 → 结构化错误且 isError,码取报文前缀', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mcp-admin-ws-'));
    writeFileSync(join(ws, 'd.md'), SPEC('dup-ant'));
    const p = await call('ant_pack', { spec_path: 'd.md', workspace_dir: ws });
    await call('ant_install', { dir: p.body.pack.dir, workspace_dir: ws });
    const again = await call('ant_install', { dir: p.body.pack.dir, workspace_dir: ws });
    expect(again.isError).toBe(true); expect(again.body.error.code).toBe('HOPANT_ID_CONFLICT');
    const nf = await call('ant_adapt', { id: 'no-such-ant' });
    expect(nf.isError).toBe(true); expect(nf.body.error.code).toBe('HOPANT_NOT_FOUND');
    const pe = await call('ant_pack', { spec_path: 'missing.md', workspace_dir: ws });
    expect(pe.isError).toBe(true); expect(pe.body.error.code).toBe('PACK_ERROR');
    const wsErr = await call('ant_adapt', { id: 'dup-ant', workspace_dir: join(ws, 'nope') });
    expect(wsErr.isError).toBe(true); expect(wsErr.body.error.code).toBe('WORKSPACE_NOT_FOUND');
    const pe2 = await call('ant_pack', { spec_path: 'd.md', workspace_dir: ws });   // 目标已存在且非空
    expect(pe2.isError).toBe(true); expect(pe2.body.error.code).toBe('HOPANT_TARGET_EXISTS');
    await call('ant_remove', { id: 'dup-ant' });
  });

  it('正例：doctor 返回 DoctorReport 形态——八问 id 齐、summary 四档、exit_code;零载体假 HOME 下前六问 fail carrier none', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mcp-admin-ws-'));
    const d = await call('doctor', { workspace_dir: ws });
    expect(d.isError).toBe(false);
    expect(d.body.action).toBe('doctor'); expect(d.body.carriers).toEqual([]);
    const ids = new Set(d.body.items.map((i: { id: string }) => i.id));
    for (const q of ['skill_installed', 'skill_version', 'skill_visible', 'mcp_registered', 'mcp_handshake', 'permissions', 'mcp_llm_config', 'standalone_credential']) expect(ids.has(q), q).toBe(true);
    for (const it of d.body.items.filter((i: { carrier: string }) => i.carrier === 'none')) expect(it.status).toBe('fail');
    expect(d.body.summary.fail).toBeGreaterThanOrEqual(6); expect(d.body.exit_code).toBe(1);
  });
});

// @v: anc-mcp-dirs-approve —— 复用驱动 run 停 paused/dirs → approve_dirs 工具 → resume;run approve_dirs 跳停;独立模式 start_run dirs 对账（缺 INIT_FAILED / 多 warn 不授 / 对上直通）
describe('Config.dirs 的 MCP 面（approve_dirs 工具与 start_run dirs 参数,todo/0148）', () => {
  const SPEC = `# DirsMcp
Id: dirs-mcp

## Goal
g

## Inputs
- out % line  # 目录

## Outputs
- answer % line  # 结果

## Config
dirs:
  readwrite: ["{out}"]

## Steps
1. [act] 算
  - ← out
  + → answer % line  # 结果
  > 算出结果
`;
  type Tools = Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
  let tools: Tools;
  beforeAll(() => { tools = (buildServer(new HopjitMcpCore(null, { reason: 'STANDALONE_CONFIG_MISSING: 测试', fix: '' })) as any)._registeredTools as Tools; });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await tools[name].handler(args, {});
    return { body: JSON.parse(r.content[0].text), isError: r.isError === true };
  };
  const ws = () => { const dir = mkdtempSync(join(tmpdir(), 'mcp-dirs-')); writeFileSync(join(dir, 's.md'), SPEC); const rw = mkdtempSync(join(tmpdir(), 'mcp-dirs-rw-')); return { dir, rw }; };

  it('正例：复用驱动 run → paused/dirs → approve_dirs 工具（哈希不符拒）→ resume step_ready', async () => {
    const { dir, rw } = ws();
    const p = await call('run', { spec_path: 's.md', workspace_dir: dir, params: { out: rw } });
    expect(p.body.status).toBe('paused'); expect(p.body.pause_reason).toBe('dirs');
    const hash = p.body.presented_data.context.dirs_hash;
    const bad = await call('approve_dirs', { instance_id: p.body.instance_id, dirs_hash: 'x', workspace_dir: dir });
    expect(bad.isError).toBe(true); expect(bad.body.error.code).toBe('DIRS_NOT_APPROVED');
    const ok = await call('approve_dirs', { instance_id: p.body.instance_id, dirs_hash: hash, workspace_dir: dir });
    expect(ok.body.status).toBe('ok');
    const next = await call('resume', { instance_id: p.body.instance_id, workspace_dir: dir });
    expect(next.body.status).toBe('step_ready');
  });

  it('正例：run approve_dirs=true 起跑即批,直达 step_ready', async () => {
    const { dir, rw } = ws();
    const r = await call('run', { spec_path: 's.md', workspace_dir: dir, params: { out: rw }, approve_dirs: true });
    expect(r.body.status).toBe('step_ready');
    expect(existsSync(join(dir, '.hopstate', 'dirs_approvals.json'))).toBe(true);
  });

  // @v: anc-exec-dirs-grant —— 恢复重建两白名单 / run_status 兜底与源⑥同判（dirs 批 review 修复）
  it('正例：server 重启恢复后 commit 写 readwrite 目录仍放行——restore 从 declared_dirs 重建两白名单（D2：首版 setHostConfig 盖掉 write_access,恢复后 commit 被拒）', async () => {
    const { dir, rw } = ws();
    const COMMIT_SPEC = `# DirsRestore
Id: dirs-restore

## Goal
g

## Inputs
- out % line  # 目录

## Outputs
- r % line  # 结果

## Config
dirs:
  readwrite: ["{out}"]

## Steps
1. [subtask] 把关
  + → ok % bool
  1.1. [check final] 核
    + → ok % bool  # 判
    + → note % text  # 说
    > pass
2. [commit] 写
  - ← out
  + → r % line  # 结果
  > 写进读写目录
  > \`\`\`hop_python
  > w = write(path: out + "/restored.txt", content: "ok")
  > r = "done"
  > \`\`\`
`;
    writeFileSync(join(dir, 'c.md'), COMMIT_SPEC);
    const sd = mkdtempSync(join(tmpdir(), 'mcp-dirs-restore-'));
    // 用引擎直接造"进程 1"的快照：起跑（dirsGrant 对上记账）→ check 判过 → commit 停在批准停点 → 批准
    const host = providerToHostConfig(VALID_PROVIDER, dir);
    const eng1 = new ExecutionEngine();
    const init = eng1.initExecution(COMMIT_SPEC, host, { stateDir: sd, specPath: join(dir, 'c.md'), params: { out: rw }, dirsGrant: { readwrite: [rw] }, driverChannel: 'mcp' });
    expect(init.status, JSON.stringify(init)).toBe('ok');
    const runId = init.instance_id!;
    eng1.setHostConfig(host);
    expect(eng1.checkDirsApproval()?.approved).toBe(true);
    eng1.nextStep(); eng1.completeStep('1.1', { ok: true, note: 'x' });
    const probe = eng1.checkCommitApproval('2')!; eng1.approveCommit('2', probe.fingerprint, 'once');
    eng1.nextStep();   // 2 进 running（commit 待执行）
    // "重启"：新 core 从快照恢复——restore 走 providerToHostConfig 新建沙箱 + setHostConfig,须重建两白名单
    const core2 = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const r = core2.resumeRun(runId, '2', { value: 'go' }, sd) as any;
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    const eng2 = (core2 as any).runs.get(runId)?.dispatcher?.getEngine?.() as ExecutionEngine | undefined;
    expect(eng2).toBeDefined();
    const hc = (eng2 as any).hostConfig as HostConfig;
    expect(hc.sandbox.filesystem.write_access?.allowed).toEqual([rw]);   // 两白名单已重建
    expect(hc.sandbox.filesystem.read_access.allowed).toContain(rw);
    for (let i = 0; i < 80 && !existsSync(join(rw, 'restored.txt')); i++) await new Promise(res => setTimeout(res, 50));
    expect(existsSync(join(rw, 'restored.txt'))).toBe(true);   // 恢复后 commit 真写进 readwrite 目录
    await core2.stopRun(runId);
  });

  it('正例：run_status 快照兜底对 dirs 卡——未批报 paused/dirs;账已批（卡残留）报陈卡不冒充 paused（与引擎源⑥同判）', async () => {
    const { dir, rw } = ws();
    const p = await call('run', { spec_path: 's.md', workspace_dir: dir, params: { out: rw } });
    expect(p.body.pause_reason).toBe('dirs');
    const id = p.body.instance_id;
    const core = new HopjitMcpCore(null, { reason: 'STANDALONE_CONFIG_MISSING: 测试', fix: '' });
    const st1 = core.runStatus(id, join(dir, '.hopstate')) as any;
    expect(st1.status).toBe('paused'); expect(st1.paused?.pause_reason).toBe('dirs');
    // 记账但故意把卡留下（模拟 approveDirs 删卡与进程退出之间崩溃）
    const eng = ExecutionEngine.load(join(dir, '.hopstate', id));
    const cardTxt = readFileSync(join(dir, '.hopstate', id, 'paused.json'), 'utf-8');
    eng.approveDirs(p.body.presented_data.context.dirs_hash);
    writeFileSync(join(dir, '.hopstate', id, 'paused.json'), cardTxt);
    const st2 = core.runStatus(id, join(dir, '.hopstate')) as any;
    expect(st2.status).not.toBe('paused');
    expect(String(st2.error?.message ?? '')).toContain('清单已批准');
  });

  it('独立模式：start_run 未传 dirs → INIT_FAILED 列缺的;传了同一组 → 直通并记账;多传的 → 不授（不报错）', async () => {
    const { dir, rw } = ws();
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const miss = await core.startRun(join(dir, 's.md'), { out: rw }, mkdtempSync(join(tmpdir(), 'mcp-dirs-st-')), dir);
    expect((miss['error'] as any)?.code).toBe('INIT_FAILED');
    expect((miss['error'] as any)?.message).toContain(`readwrite:${rw}`);
    const extra = mkdtempSync(join(tmpdir(), 'mcp-dirs-extra-'));
    const sd2 = mkdtempSync(join(tmpdir(), 'mcp-dirs-st-'));
    const ok = await core.startRun(join(dir, 's.md'), { out: rw }, sd2, dir, { readwrite: [rw], read: [extra] });
    expect(ok['run_id']).toBeDefined();
    expect(existsSync(join(sd2, 'dirs_approvals.json'))).toBe(true);
    expect((ok['warnings'] as string[])?.some(w => w.includes(`read:${extra}`) && w.includes('不授权'))).toBe(true);   // 多传的不授,提示随返回
    const st = await core.stopRun(ok['run_id'] as string);
    expect(st).toBeDefined();
  });

  // @v: anc-mcp-dirs-approve
  it('正/反（dirs 授权 warnings 按 rule 筛）：rule 为 dirs 类的透传;rule 非 dirs 类的不透传（即使报文文字含\'目录\'字样）', async () => {
    // 反例材料：Inputs 段塞一行全角冒号的孤儿行,文字里带 "Config.dirs" 与 "目录"——validator 出 rule=W1 的 warn,
    // 报文形如 "Inputs 段第 N 行不合本段文法,已被忽略: 'Config.dirs：目录'"。原正则 /start_run\.dirs|Config\.dirs/ 按文字会把它误当 dirs 提示透传。
    const { dir, rw } = ws();
    writeFileSync(join(dir, 's.md'), SPEC.replace('- out % line  # 目录\n', '- out % line  # 目录\n- Config.dirs：目录\n'));
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const extra = mkdtempSync(join(tmpdir(), 'mcp-dirs-extra-'));
    const sd = mkdtempSync(join(tmpdir(), 'mcp-dirs-st-'));
    const ok = await core.startRun(join(dir, 's.md'), { out: rw }, sd, dir, { readwrite: [rw], read: [extra] });
    expect(ok['run_id'], JSON.stringify(ok)).toBeDefined();
    const warnings = (ok['warnings'] as string[]) ?? [];
    expect(warnings.some(w => w.includes(`read:${extra}`) && w.includes('不授权'))).toBe(true);   // 正：引擎 dirs 对账的 warn（rule=CONFIG）透传
    expect(warnings.some(w => w.includes('不合本段文法'))).toBe(false);   // 反：W1 的 warn 文字含 Config.dirs/目录 也不透传——证明按 rule 不按文字
    expect(warnings.every(w => !/Config\.dirs：目录/.test(w))).toBe(true);
    const st = await core.stopRun(ok['run_id'] as string);
    expect(st).toBeDefined();
  });
});

// commit 安全分析用哪个模型:routing_rules 里 step_type=commit 那条优先,没有就用默认模型;引用未知 service 报配置错
// @v: anc-exec-commit-analyzer
describe('resolveCommitAnalyzerProvider', () => {
  const second: ProviderEntry = { service_id: 'other', protocol: 'openai-chat', base_url: 'https://x.example/v1', model: 'o-default', api_key_env: 'HOPJIT_TEST_KEY_ENV' };
  it('正例：有 commit 路由用它（service/model 都取规则里的）;没有就用 default_model;都没写取第一个 provider 的缺省模型', () => {
    const routed = resolveCommitAnalyzerProvider({ providers: [VALID_PROVIDER, second], default_model: 'deepseek/deepseek-v4-pro', routing_rules: [{ step_type: 'act', model: 'deepseek/a' }, { step_type: 'commit', model: 'other/o-review' }] });
    expect(routed).toEqual({ service_id: 'other', protocol: 'openai-chat', base_url: 'https://x.example/v1', api_key: 'sk-test-fake', auth: null, model: 'o-review' });
    const byDefault = resolveCommitAnalyzerProvider({ providers: [VALID_PROVIDER, second], default_model: 'other/o-big' });
    expect(byDefault).toMatchObject({ service_id: 'other', model: 'o-big' });
    const bare = resolveCommitAnalyzerProvider({ providers: [VALID_PROVIDER, second] });
    expect(bare).toMatchObject({ service_id: 'deepseek', model: 'deepseek-v4-flash', protocol: 'anthropic' });
  });
  it('反例：commit 路由引用的 service 不在 providers 里 → STANDALONE_CONFIG_INVALID', () => {
    expect(() => resolveCommitAnalyzerProvider({ providers: [VALID_PROVIDER], routing_rules: [{ step_type: 'commit', model: 'ghost/m' }] })).toThrow(/STANDALONE_CONFIG_INVALID.*ghost/);
  });

  // 以下用例逐分支侧钉住被审批次改动的函数（commit 安全分析批次 review 第五次阅卷后,机器枚举分支侧的 run20 存活项）
  // @v: anc-exec-commit-analyzer
  it('字段回落:裸模型名的 commit 路由取第一个 provider（不按名字找）;base_url 缺席记 null;key 环境变量未设记空串;auth 不是 bearer 记 null、是 bearer 原样记', () => {
    const bearer: ProviderEntry = { ...second, service_id: 'br', auth: 'bearer', base_url: undefined as any, api_key_env: 'HOPJIT_NO_SUCH_KEY_FOR_TEST' };
    delete process.env['HOPJIT_NO_SUCH_KEY_FOR_TEST'];
    // 裸模型名:service_id 解析为 default → 取 providers[0],哪怕 providers 里有名为 default 的也不按名找
    const bare = resolveCommitAnalyzerProvider({ providers: [VALID_PROVIDER, { ...second, service_id: 'default' }], routing_rules: [{ step_type: 'commit', model: 'plain-model' }] });
    expect(bare).toMatchObject({ service_id: 'deepseek', model: 'plain-model', auth: null });
    // 按名找时大小写不敏感
    const byName = resolveCommitAnalyzerProvider({ providers: [VALID_PROVIDER, second], routing_rules: [{ step_type: 'commit', model: 'OTHER/x' }] });
    expect(byName.service_id).toBe('other');
    const r = resolveCommitAnalyzerProvider({ providers: [VALID_PROVIDER, bearer], routing_rules: [{ step_type: 'commit', model: 'br/m' }] });
    expect(r).toEqual({ service_id: 'br', protocol: 'openai-chat', base_url: null, api_key: '', auth: 'bearer', model: 'm' });
  });
});

// @v: anc-mcp-server-status
describe('buildServer 的版本号', () => {
  it('server 自报的 version 取 package.json 的版本号（getEngineVersion 读到值时不用 0.0.0 回落）', () => {
    const server = buildServer(new HopjitMcpCore(null, { reason: 'STANDALONE_CONFIG_MISSING: 测试', fix: '' }));
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as { version: string };
    const info = (server as any).server?._serverInfo ?? (server as any)._serverInfo;
    expect(info?.version).toBe(pkg.version);
    expect(pkg.version).not.toBe('0.0.0');
  });
});

// todo/0163：reuse-driver 的 MCP 工具面此前只测过 output 一种提交形态;本组把另外六种提交形态、
// reap 真收割、run 两条反例、resume 崩溃恢复都经工具 handler 走到引擎,断言状态推进。
describe('复用驱动七种提交形态经 MCP 工具面（todo/0163;todo/0168 撤 branch 后七种）', () => {
  type Tools = Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
  const newTools = (): Tools => (buildServer(new HopjitMcpCore(null, { reason: 'STANDALONE_CONFIG_MISSING: 测试', fix: '' })) as any)._registeredTools as Tools;
  let tools: Tools;
  beforeAll(() => { tools = newTools(); });
  const callWith = async (t: Tools, name: string, args: Record<string, unknown>) => {
    const r = await t[name].handler(args, {});
    return { body: JSON.parse(r.content[0].text), isError: r.isError === true };
  };
  const call = (name: string, args: Record<string, unknown>) => callWith(tools, name, args);
  const ws = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-0163-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  };
  // 引擎拼的 launch_command / init_command 里的 CLI 路径取自 driverContext 的 cli_abs_path——vitest 直接跑 src 时它指向
  // 不存在的 src/cli.js,这里换成已构建的 dist/cli.js 再执行（与本文件"驱动工具起跑的 run 认领 cli 通道"用例同一依赖）。
  const runCliCommand = (cmd: string, cwd: string) => {
    const fixed = cmd.replace(/^node "[^"]+"/, `node "${join(REPO, 'dist', 'cli.js')}"`);
    const r = spawnSync(fixed, { cwd, encoding: 'utf-8', shell: true, timeout: 60000 });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    return r.stdout;
  };
  const readState = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, '.hopstate', id, 'state.json'), 'utf-8'));

  // 步 1 停在调用方手里时步 2 还是 pending——0163 原本拿这个窗口做"预选";todo/0168 撤了预选,同一夹具改测"引擎按值选路"与"branch 字段拒收"
  const BRANCH_BY_VALUE_SPEC = `# Branch
Id: branch-mcp

## Goal
选路

## Inputs
- mode: text  # 模式

## Outputs
- out: text  # 结果

## Steps
1. [reason] 前面
  + → a: text  # 前置
2. [branch] 选
  2.1. [case] {mode}==fast
    2.1.1. [reason] 快
      - ← a
      + → out: text  # 结果
      > 快走
  2.2. [case] {mode}==slow
    2.2.1. [reason] 慢
      - ← a
      + → out: text  # 结果
      > 慢走
`;

  const SIMPLE = `# 简单
Id: simple

## Goal
g

## Outputs
- answer: line  # 结果

## Steps
1. [act] 算
  + → answer: line  # 结果
  > 算出结果
`;
  const CALLER = `# Caller
Id: caller

## Goal
调子 spec

## Inputs
- base: int  # 底数

## Outputs
- result: int  # 结果

## Steps
1. [call double(n: base)] 调翻倍
  + → result: doubled  # 映射
`;
  const CALLEE_PURE = `# Double
Id: double

## Goal
翻倍

## Inputs
- n: int  # 数

## Outputs
- doubled: int  # 翻倍值

## Steps
1. [act] 算
  - ← n
  + → doubled: int  # 翻倍值
  > 纯计算
  > \`\`\`hop_python
  > doubled = n * 2
  > \`\`\`
`;
  const CALLEE_REASON = `# Double
Id: double

## Goal
翻倍

## Inputs
- n: int  # 数

## Outputs
- doubled: int  # 翻倍值

## Steps
1. [reason] 想一个翻倍值
  - ← n
  + → doubled: int  # 翻倍值
`;

  // @v: anc-mcp-reuse-driver-tools
  it('正例：child_instance 形态——call 子实例经 CLI init_command 建好并跑到 completed 后,父实例用 submit_and_fetch_next(child_instance) 回填 → 父实例 completed 且 result 是子实例算出的值', async () => {
    const dir = ws({ 'caller.md': CALLER, 'double.md': CALLEE_PURE });
    const r = await call('run', { spec_path: 'caller.md', params: { base: 20 }, workspace_dir: dir });
    expect(r.body.status).toBe('step_ready');
    expect(r.body.step_type).toBe('call');
    const cp = r.body.call_protocol;
    expect(cp.child_instance).toBe('1');
    runCliCommand(cp.init_command, dir);
    // 子实例的推进也走 MCP 工具（resume = recover + advanceToCaller,纯计算 body 一口气到终态）
    const child = await call('resume', { state_dir: cp.child_state_dir, instance_id: cp.child_instance, workspace_dir: dir });
    expect(child.body.status).toBe('completed');
    expect(child.body.outputs.doubled).toBe(40);
    const done = await call('submit_and_fetch_next', { step_id: '1', child_instance: cp.child_instance, instance_id: r.body.instance_id, workspace_dir: dir });
    expect(done.isError).toBe(false);
    expect(done.body.status).toBe('completed');
    expect(done.body.outputs.result).toBe(40);   // 子实例变量经 auto-map 回填到父输出槽
    expect(readState(dir, r.body.instance_id).step_states['1']).toBe('done');
  });

  // @v: anc-mcp-reuse-driver-tools
  it('正例：failure_child 形态——call 子实例的步骤经 MCP 报失败后,父实例用 submit_and_fetch_next(failure_child) 回填 → 父 call 步 failed、父实例终态 failed 且失败原因带子 spec 标识', async () => {
    const dir = ws({ 'caller.md': CALLER, 'double.md': CALLEE_REASON });
    const r = await call('run', { spec_path: 'caller.md', params: { base: 3 }, workspace_dir: dir });
    const cp = r.body.call_protocol;
    runCliCommand(cp.init_command, dir);
    const childReady = await call('resume', { state_dir: cp.child_state_dir, instance_id: cp.child_instance, workspace_dir: dir });
    expect(childReady.body.status).toBe('step_ready');
    expect(childReady.body.step_id).toBe('1');
    const childFailed = await call('submit_and_fetch_next', { step_id: '1', failure: '算不出来', state_dir: cp.child_state_dir, instance_id: cp.child_instance, workspace_dir: dir });
    expect(childFailed.body.status).toBe('failed');
    const done = await call('submit_and_fetch_next', { step_id: '1', failure_child: cp.child_instance, instance_id: r.body.instance_id, workspace_dir: dir });
    expect(done.isError).toBe(false);
    expect(done.body.status).toBe('failed');
    expect(String(done.body.failure_reason)).toContain('double');   // CalleeFailure 带 callee_spec_id
    expect(readState(dir, r.body.instance_id).step_states['1']).toBe('failed');
  });

  // @v: anc-mcp-reuse-driver-tools
  it('正例：failure 形态——单步 spec 的 act 步经 submit_and_fetch_next(failure) 报失败 → 引擎账上该步 failed,实例终态 failed 且失败原因是提交的文本', async () => {
    const dir = ws({ 's.md': SIMPLE });
    const r = await call('run', { spec_path: 's.md', workspace_dir: dir });
    expect(r.body.step_id).toBe('1');
    const done = await call('submit_and_fetch_next', { step_id: '1', failure: '数据源不可用', instance_id: r.body.instance_id, workspace_dir: dir });
    expect(done.isError).toBe(false);
    expect(done.body.status).toBe('failed');
    expect(String(done.body.failure_reason)).toContain('数据源不可用');
    expect(readState(dir, r.body.instance_id).step_states['1']).toBe('failed');
  });

  // @v: anc-mcp-reuse-driver-tools, anc-exec-branch-select-internal —— todo/0168：0163 的"branch 预选正例"方向写反,改为反例
  it('反例（todo/0168）：submit_and_fetch_next 没有 branch 提交形态——调用方传 branch=2.1 试图替引擎预选 case → INVALID_ARG 结构化拒收,报文点名 branch 并列出七种合法形态;引擎账上 branch 步仍 pending、两个 case 都没被动过', async () => {
    const dir = ws({ 'b.md': BRANCH_BY_VALUE_SPEC });
    const r = await call('run', { spec_path: 'b.md', params: { mode: 'slow' }, workspace_dir: dir });
    expect(r.body.step_id).toBe('1');
    const id = r.body.instance_id;
    const picked = await call('submit_and_fetch_next', { step_id: '2', branch: '2.1', reason: '人工定走快路', instance_id: id, workspace_dir: dir });
    expect(picked.isError).toBe(true);
    expect(picked.body.error.code).toBe('INVALID_ARG');
    expect(String(picked.body.error.message)).toContain("'branch'");
    for (const m of ['output', 'answer', 'child_instance', 'failure_child', 'failure', 'replan', 'tool_result']) expect(String(picked.body.error.message)).toContain(m);
    expect(String(picked.body.error.message)).toContain('七种');
    const st = readState(dir, id).step_states;
    expect(st['2']).toBe('pending');
    expect(st['2.1']).toBe('pending');
    expect(st['2.2']).toBe('pending');
  });

  // @v: anc-exec-branch-select-internal
  it('正例（todo/0168）：选路只由引擎按 case 条件求值——前序步交付 mode=slow 后,引擎进入 branch 命中 2.2：账上 2.2 running / 2.1 skipped（含 2.1.1）,下一介入点停在 2.2.1', async () => {
    const dir = ws({ 'b.md': BRANCH_BY_VALUE_SPEC });
    const r = await call('run', { spec_path: 'b.md', params: { mode: 'slow' }, workspace_dir: dir });
    const id = r.body.instance_id;
    const next = await call('submit_and_fetch_next', { step_id: '1', output: { a: '前置值' }, instance_id: id, workspace_dir: dir });
    expect(next.body.status).toBe('step_ready');
    expect(next.body.step_id).toBe('2.2.1');
    const st = readState(dir, id).step_states;
    expect(st['2']).toBe('running');
    expect(st['2.2']).toBe('running');
    expect(st['2.1']).toBe('skipped');
    expect(st['2.1.1']).toBe('skipped');
  });

  // @v: anc-exec-branch-select-internal —— 工具 schema 面：branch / reason 两字段不再存在（tools/list 给调用方看的就是这份）
  it('反例（todo/0168）：submit_and_fetch_next 的工具 schema 没有 branch / reason 字段,工具说明写的是七种形态', () => {
    const shape = (tools as any)['submit_and_fetch_next'].inputSchema;
    const keys = Object.keys(shape.shape ?? shape._def?.shape?.() ?? shape);
    expect(keys).not.toContain('branch');
    expect(keys).not.toContain('reason');
    expect(keys).toEqual(expect.arrayContaining(['output', 'answer', 'child_instance', 'failure_child', 'failure', 'replan', 'tool_result']));
    const desc = String((tools as any)['submit_and_fetch_next'].description);
    expect(desc).toContain('七种提交形态');
    expect(desc).not.toContain('branch');
  });

  // @v: anc-mcp-reuse-driver-tools
  it('正例：replan 形态——subtask free 到步停在 adaptive_needed 后,submit_and_fetch_next(replan=子步骤 markdown 文本) 提交展开物 → 下一介入点是展开出的第一个子步骤 2.1 的 step_ready', async () => {
    const dir = ws({ 'f.md': `# F
Id: f

## Goal
g

## Outputs
- out: text  # 结果

## Steps
1. [reason] 前面
  + → a: text  # 前置
2. [subtask free] 到步展开
  - ← a
  + → out: text  # 结果
` });
    const r = await call('run', { spec_path: 'f.md', workspace_dir: dir });
    expect(r.body.step_id).toBe('1');
    const id = r.body.instance_id;
    const need = await call('submit_and_fetch_next', { step_id: '1', output: { a: '真产出' }, instance_id: id, workspace_dir: dir });
    expect(need.body.status).toBe('adaptive_needed');
    expect(need.body.reason).toBe('initial_plan');
    const plan = '1. [act free] 干\n  - ← a\n  + → out: text  # 结果\n2. [check final] 核\n  - ← out\n  + → ok: bool  # 判定\n  + → note: text  # 说明\n';
    const next = await call('submit_and_fetch_next', { step_id: '2', replan: plan, instance_id: id, workspace_dir: dir });
    expect(next.isError).toBe(false);
    expect(next.body.status).toBe('step_ready');
    expect(next.body.step_id).toBe('2.1');
    expect(readState(dir, id).step_states['2']).toBe('running');   // 容器步进入执行,子步骤已挂上
  });

  // @v: anc-mcp-reuse-driver-tools
  it('正例：tool_result 形态——act body 解释到工具调用点发 tool_request 后,submit_and_fetch_next(tool_result) 注入工具结果 → 引擎重放续跑到 completed,输出是工具结果', async () => {
    const dir = ws({ 'm.md': `# Mixed
Id: mixed

## Goal
g

## Inputs
- u: text  # 地址

## Outputs
- out: text  # 结果

## Steps
1. [act] 纯计算
  - ← u
  + → host: text  # 大写
  > \`\`\`hop_python
  > host = upper(u)
  > \`\`\`
2. [act] 含工具
  - ← host
  + → out: text  # 结果
  > \`\`\`hop_python
  > out = fetch(target: host)
  > \`\`\`
` });
    const r = await call('run', { spec_path: 'm.md', params: { u: 'x.com' }, workspace_dir: dir });
    expect(r.body.status).toBe('tool_request');
    expect(r.body.step_id).toBe('2');
    expect(r.body.tool).toBe('fetch');
    const done = await call('submit_and_fetch_next', { step_id: '2', tool_result: '"FETCHED:X.COM"', instance_id: r.body.instance_id, workspace_dir: dir });
    expect(done.isError).toBe(false);
    expect(done.body.status).toBe('completed');
    expect(done.body.outputs.out).toBe('FETCHED:X.COM');
  });

  // @v: anc-mcp-reuse-driver-tools
  it('反例：同一次 submit_and_fetch_next 同时给 output 与 failure 两种形态 → INVALID_STATE 拒收,报文列出两个形态名,引擎状态不动（步 1 仍在等回写）', async () => {
    const dir = ws({ 's.md': SIMPLE });
    const r = await call('run', { spec_path: 's.md', workspace_dir: dir });
    const id = r.body.instance_id;
    const two = await call('submit_and_fetch_next', { step_id: '1', output: { answer: 'a' }, failure: '坏了', instance_id: id, workspace_dir: dir });
    expect(two.isError).toBe(true);
    expect(two.body.error.code).toBe('INVALID_STATE');
    expect(two.body.error.message).toContain('output');
    expect(two.body.error.message).toContain('failure');
    const st = await call('status', { instance_id: id, workspace_dir: dir });
    expect(st.body.execution_status).toBe('running');
    expect(readState(dir, id).step_states['1']).toBe('running');
    // 只给一种形态照常推进
    const done = await call('submit_and_fetch_next', { step_id: '1', output: { answer: 'a' }, instance_id: id, workspace_dir: dir });
    expect(done.body.status).toBe('completed');
  });

  // @v: anc-mcp-reuse-driver-tools
  it('正例：reap_and_fetch_next 真收割——subtask parallel 派发出的 worker 子实例跑完后,reap(child_instance, status=completed) → 父 loop 收到子实例的值并推进到 completed', async () => {
    const dir = ws({ 'pipe.md': `# ReusePipe
Id: reuse-pipe

## Goal
流水线

## Inputs
- nums: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in nums, collect o into outs] 逐项
  + → outs: [int]  # 收集列表
  1.1. [subtask parallel] 处理一项
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > \`\`\`hop_python
      > o = n * 7
      > \`\`\`
2. [exit] 交付
` });
    const r = await call('run', { spec_path: 'pipe.md', params: { nums: [2] }, workspace_dir: dir });
    expect(r.body.status).toBe('dispatch_ready');
    expect(r.body.child_instance).toBe('1.1.1');
    const id = r.body.instance_id;
    runCliCommand(r.body.launch_command, dir);   // worker 子进程跑到终态落盘
    expect(existsSync(join(dir, '.hopstate', id, 'parallel', '1.1.1', 'state.json'))).toBe(true);
    const done = await call('reap_and_fetch_next', { child_instance: '1.1.1', status: 'completed', instance_id: id, workspace_dir: dir });
    expect(done.isError).toBe(false);
    expect(done.body.status).toBe('completed');
    expect(done.body.outputs.outs).toEqual([14]);   // 子实例算的 2*7 被父 loop 收进 outs
  });

  // @v: anc-mcp-reuse-driver-tools
  it('反例：run 的 spec 在 ## Tools 段声明了本机没注册的工具 → 依赖核不过返回 INIT_FAILED（带 missing_tools）,不建实例目录', async () => {
    const dir = ws({ 't.md': `# T
Id: t

## Goal
g

## Tools
- nowhere_tool_0163(q) -> v % text  # 本机没注册
  - q % text  # 词

## Outputs
- out: text  # 结果

## Steps
1. [act free] 调
  - 工具: nowhere_tool_0163
  + → out: text  # 结果
` });
    const r = await call('run', { spec_path: 't.md', workspace_dir: dir });
    expect(r.body.status).toBe('error');
    expect(r.body.error_code).toBe('INIT_FAILED');
    expect(r.body.missing_tools).toEqual(['t: nowhere_tool_0163']);
    expect(r.body.message).toContain('工具没有注册');
    expect(existsSync(join(dir, '.hopstate'))).toBe(false);
  });

  // @v: anc-mcp-reuse-driver-tools
  it('反例：run 的 params 带形似凭证的 hop_env_api_key 键 → HOP_ENV_CREDENTIAL_REJECTED 结构化错误,不建实例目录', async () => {
    const dir = ws({ 's.md': SIMPLE });
    const r = await call('run', { spec_path: 's.md', params: { hop_env_api_key: 'x' }, workspace_dir: dir });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('HOP_ENV_CREDENTIAL_REJECTED');
    expect(r.body.error.message).toContain('hop_env_api_key');
    expect(existsSync(join(dir, '.hopstate'))).toBe(false);
  });

  // @v: anc-mcp-reuse-driver-tools
  it('正例：resume 崩溃恢复——run 把步 1 派出去（账上 running）后调用方没提交就没了,新 server core 调 resume → 悬空步被复位重派,响应回到步 1 的 step_ready,之后照常能提交', async () => {
    const dir = ws({ 's.md': SIMPLE });
    const r = await call('run', { spec_path: 's.md', workspace_dir: dir });
    expect(r.body.step_id).toBe('1');
    const id = r.body.instance_id;
    expect(readState(dir, id).step_states['1']).toBe('running');   // 崩溃现场：步 1 悬空 running
    const fresh = newTools();   // 模拟 server 进程重启:新 core,内存里什么都没有
    const back = await callWith(fresh, 'resume', { instance_id: id, workspace_dir: dir });
    expect(back.isError).toBe(false);
    expect(back.body.status).toBe('step_ready');
    expect(back.body.step_id).toBe('1');
    expect(back.body.instance_id).toBe(id);
    const done = await callWith(fresh, 'submit_and_fetch_next', { step_id: '1', output: { answer: '42' }, instance_id: id, workspace_dir: dir });
    expect(done.body.status).toBe('completed');
    expect(done.body.outputs.answer).toBe('42');
  });
});

// ── todo/0164：mcp 组合根装配线"删一行必红"——startRun / restoreRun 把配置装配成 HostConfig、模型引擎、
// 沙箱的每一行各配一条正例,断可观察面（模型客户端收到的实发请求参数 / 请求头、沙箱拒收报文、快照里的
// host_context、start_run 的结构化错误码）,不断内部私有变量。模型客户端经 globalThis.fetch 打桩抄实发
// 请求（SDK 走全局 fetch,与通知挂点组同一手法）,零网络。契约句在 mcp-server.md ^anc-mcp-config
// "组合根装配线逐条契约"与 ^anc-mcp-run-restore M3 条。
describe('mcp 组合根装配线删一行必红（todo/0164）', () => {
  const origFetch = globalThis.fetch;
  let sentRequests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;

  beforeEach(() => {
    process.env['HOPJIT_TEST_KEY_ENV'] = 'sk-test-fake';   // 前方 describe 的 finally 会删全局 env——本组自设保障
    sentRequests = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
      sentRequests.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const message = {
        id: 'msg_0164', type: 'message', role: 'assistant', model: 'stub',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      };
      return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  // 单步 reason 的 spec（无工具声明 → 单发纯推理,一次模型请求即可观察装配结果）
  const REASON_SPEC = `# T\nId: t0164-reason\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [reason] r\n  + → out: text  # o\n  > 回答 ok\n`;

  async function waitTerminal(core: HopjitMcpCore, runId: string): Promise<Record<string, unknown>> {
    let st: Record<string, unknown> = {};
    for (let i = 0; i < 150; i++) {
      await new Promise(res => setTimeout(res, 100));
      st = core.runStatus(runId) as Record<string, unknown>;
      if (['completed', 'failed'].includes(st['status'] as string)) break;
    }
    return st;
  }

  async function startReasonRun(config: StandaloneConfig, specText = REASON_SPEC): Promise<{ core: HopjitMcpCore; st: Record<string, unknown> }> {
    const core = new HopjitMcpCore(config);
    const dir = mkdtempSync(join(tmpdir(), 'mcp-0164-'));
    writeFileSync(join(dir, 's.md'), specText);
    const r = await core.startRun(join(dir, 's.md'), undefined, join(dir, '.hopstate'), dir);
    expect(r['error']).toBeUndefined();
    const st = await waitTerminal(core, r['run_id'] as string);
    expect(sentRequests.length).toBeGreaterThan(0);   // 真发过模型请求,下面断的是实发参数
    return { core, st };
  }

  // @v: anc-mcp-config
  it('正例：routing_rules 对 reason 写 thinking: disabled → 模型客户端收到的实发请求参数里 thinking.type 是 disabled（buildModelEngine 把规则的 thinking 透传进 ModelEngine;不透传则 reason 按引擎内建缺省发 enabled）', async () => {
    await startReasonRun({
      providers: [VALID_PROVIDER],
      routing_rules: [{ step_type: 'reason', model: 'deepseek/m-think', thinking: 'disabled' }],
    });
    const first = sentRequests[0];
    expect(first.body['model']).toBe('m-think');   // 路由命中的是这条规则
    expect((first.body['thinking'] as { type?: string } | undefined)?.type).toBe('disabled');
  });

  // @v: anc-mcp-config
  it('正例：routing_rules 的 model 不带 service 前缀（裸模型名）→ 规则的 service_id 归一为 providers[0].service_id,请求按该 service 级设置发出（{SID}_MAX_OUTPUT_TOKENS 决定实发 max_tokens;不归一则落到无 service 级设置的 default 客户端,max_tokens 回到引擎缺省 32768）', async () => {
    await startReasonRun({
      providers: [{ ...VALID_PROVIDER, max_output_tokens: 4321 }],
      routing_rules: [{ step_type: 'reason', model: 'm-bare' }],
    });
    const first = sentRequests[0];
    expect(first.body['model']).toBe('m-bare');
    expect(first.body['max_tokens']).toBe(4321);
  });

  // @v: anc-mcp-config
  it('正例：providers[0] 写 auth: bearer → 缺省 provider 路径（spec Config.model 裸模型名,走 defaultClient）的实发请求头是 Authorization: Bearer 且无 x-api-key;反例：auth 缺席 → 实发请求头是 x-api-key 且无 Authorization（providerToHostConfig 把 auth 贯穿到 HostConfig.auth）', async () => {
    const BARE_MODEL_SPEC = REASON_SPEC.replace('## Outputs', '## Config\nmodel: bare-default-model\n## Outputs');
    await startReasonRun({ providers: [{ ...VALID_PROVIDER, auth: 'bearer' }] }, BARE_MODEL_SPEC);
    const bearerReq = sentRequests[0];
    expect(bearerReq.body['model']).toBe('bare-default-model');   // 走的是缺省 provider 路径
    expect(bearerReq.headers['authorization']).toBe('Bearer sk-test-fake');
    expect(bearerReq.headers['x-api-key']).toBeUndefined();

    sentRequests = [];
    await startReasonRun({ providers: [VALID_PROVIDER] }, BARE_MODEL_SPEC);
    const apiKeyReq = sentRequests[0];
    expect(apiKeyReq.headers['x-api-key']).toBe('sk-test-fake');
    expect(apiKeyReq.headers['authorization']).toBeUndefined();
  });

  // @v: anc-mcp-config
  it('正例：run 里的 act body 读 workspace 内的 .env 与 secret.key → 都被沙箱拒,run 失败且拒收报文含 Read denied（providerToHostConfig 装的缺省拒读基线;基线为空则两个文件都读得到,run 直接 completed）', async () => {
    for (const secretFile of ['.env', 'secret.key']) {
      const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-0164-denied-'));
      writeFileSync(join(dir, secretFile), 'TOKEN=should-not-leak\n');
      const F = '```';
      writeFileSync(join(dir, 's.md'), `# T\nId: t0164-denied\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [act] 读\n  + → out: text  # o\n  > ${F}hop_python\n  > out = read(path: "${secretFile}")\n  > ${F}\n`);
      const r = await core.startRun(join(dir, 's.md'), undefined, join(dir, '.hopstate'), dir);
      expect(r['error']).toBeUndefined();
      const st = await waitTerminal(core, r['run_id'] as string);
      expect(st['status'], `读 ${secretFile} 该被拒`).toBe('failed');
      const reason = (st['failure'] as { reason?: string } | undefined)?.reason ?? '';
      expect(reason).toContain('Read denied');
      expect(reason).not.toContain('should-not-leak');
    }
    expect(sentRequests.length).toBe(0);   // 纯 body 步骤,全程没碰模型
  });

  // @v: anc-mcp-config
  it('正例：start_run 显式传 workspace_dir（≠ server cwd）→ 快照 host_context 的 workspace_dir / 沙箱锚 / config_project_dir 三处都等于它,不是 server 进程 cwd', async () => {
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const specDir = mkdtempSync(join(tmpdir(), 'mcp-0164-spec-'));
    const wsDir = mkdtempSync(join(tmpdir(), 'mcp-0164-ws-'));
    const F = '```';
    writeFileSync(join(specDir, 's.md'), `# T\nId: t0164-ws\n## Goal\ng\n## Outputs\n- out: text  # o\n## Steps\n1. [act] 算\n  + → out: text  # o\n  > ${F}hop_python\n  > out = "done"\n  > ${F}\n`);
    const stateDir = mkdtempSync(join(tmpdir(), 'mcp-0164-ws-state-'));
    const r = await core.startRun(join(specDir, 's.md'), undefined, stateDir, wsDir);
    expect(r['error']).toBeUndefined();
    const st = await waitTerminal(core, r['run_id'] as string);
    expect(st['status']).toBe('completed');
    const state = JSON.parse(readFileSync(join(stateDir, r['run_id'] as string, 'state.json'), 'utf-8')) as { host_context: { workspace_dir: string; config_project_dir?: string; sandbox: { filesystem: { workspace_dir: string } } } };
    expect(wsDir).not.toBe(process.cwd());
    expect(state.host_context.workspace_dir).toBe(wsDir);
    expect(state.host_context.sandbox.filesystem.workspace_dir).toBe(wsDir);
    expect(state.host_context.config_project_dir).toBe(wsDir);
  });

  // @v: anc-mcp-run-restore
  it('正例（重启版）：项目级 hopjit.yaml 对 reason 写 thinking: disabled,run 停在 ask 后换新 core 恢复续跑 → 恢复后第一次模型请求的 thinking.type 仍是 disabled（restoreRun 用重读配置调 buildModelEngine 装 model_engine;不装则路由丢失,reason 按内建缺省发 enabled）', async () => {
    const projDir = mkdtempSync(join(tmpdir(), 'mcp-0164-restore-think-'));
    writeFileSync(join(projDir, 'hopjit.yaml'), 'routing_rules:\n  - step_type: reason\n    model: deepseek/m-think\n    thinking: disabled\n');
    const SPEC = `# T\nId: t0164-rt\n## Goal\ng\n## Inputs\n- x: line\n## Outputs\n- out: text  # o\n## Steps\n1. [ask] 问\n  - ← x\n  + → v: line  # v\n2. [reason] r\n  - ← v\n  + → out: text  # o\n  > 回答 ok\n`;
    const stateDir = join(projDir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, {
      workspace_dir: projDir,
      sandbox: { filesystem: { workspace_dir: projDir, read_access: { allowed: [projDir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: '',
      config_project_dir: projDir,
    }, { stateDir, params: { x: 'a' }, specPath: join(projDir, 't.md') });
    expect(init.status).toBe('ok');
    let n = engine.nextStep();
    while (n.status === 'step_ready') { engine.completeStep((n as { step_id: string }).step_id, {}); n = engine.nextStep(); }
    expect(n.status).toBe('paused');
    const runId = (init as { instance_id: string }).instance_id;

    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });   // 新 core = 重启后的 server,server 配置无 routing_rules
    const r = core.resumeRun(runId, '1', { value: 'go' }, stateDir);
    expect(JSON.stringify((r as { error?: unknown }).error ?? null)).toBe('null');
    await waitTerminal(core, runId);
    expect(sentRequests.length).toBeGreaterThan(0);
    const first = sentRequests[0];
    expect(first.body['model']).toBe('m-think');
    expect((first.body['thinking'] as { type?: string } | undefined)?.type).toBe('disabled');
  });

  // @v: anc-mcp-run-restore
  it('正例（重启版）：显式 workspace_dir（≠ server cwd）的 run 停在 ask 后换新 core 恢复续跑 → 续跑的 body read 按原 workspace_dir 解析读到标记文件,快照 host_context.workspace_dir 仍是它（restoreRun 作业根从快照取;漂回 server cwd 则标记文件找不到,run 失败）', async () => {
    const wsDir = mkdtempSync(join(tmpdir(), 'mcp-0164-restore-ws-'));
    writeFileSync(join(wsDir, 'marker.txt'), 'marker-from-workspace');
    const F = '```';
    const SPEC = `# T\nId: t0164-rw\n## Goal\ng\n## Inputs\n- x: line\n## Outputs\n- out: text  # o\n## Steps\n1. [ask] 问\n  - ← x\n  + → v: line  # v\n2. [act] 读标记\n  - ← v\n  + → out: text  # o\n  > ${F}hop_python\n  > out = read(path: "marker.txt")\n  > ${F}\n`;
    const stateDir = mkdtempSync(join(tmpdir(), 'mcp-0164-restore-ws-state-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, {
      workspace_dir: wsDir,
      sandbox: { filesystem: { workspace_dir: wsDir, read_access: { allowed: [wsDir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: '',
    }, { stateDir, params: { x: 'a' }, specPath: join(wsDir, 't.md') });
    expect(init.status).toBe('ok');
    let n = engine.nextStep();
    while (n.status === 'step_ready') { engine.completeStep((n as { step_id: string }).step_id, {}); n = engine.nextStep(); }
    expect(n.status).toBe('paused');
    const runId = (init as { instance_id: string }).instance_id;
    expect(wsDir).not.toBe(process.cwd());

    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });   // 新 core = 重启后的 server
    const r = core.resumeRun(runId, '1', { value: 'go' }, stateDir);
    expect(JSON.stringify((r as { error?: unknown }).error ?? null)).toBe('null');
    const st = await waitTerminal(core, runId);
    expect(st['status']).toBe('completed');
    expect((st['outputs'] as Record<string, unknown>)['out']).toBe('marker-from-workspace');
    const state = JSON.parse(readFileSync(join(stateDir, runId, 'state.json'), 'utf-8')) as { host_context: { workspace_dir: string; sandbox: { filesystem: { workspace_dir: string } } } };
    expect(state.host_context.workspace_dir).toBe(wsDir);
    expect(state.host_context.sandbox.filesystem.workspace_dir).toBe(wsDir);
  });

  // @v: anc-mcp-config
  it('反例：项目级 hopjit.yaml 的 tool_servers 条目过了配置文法核但注册文法不合法（binding.kind 不在枚举内）→ start_run 返回结构化错误码 TOOLS_FILE_INVALID,不裸抛', async () => {
    const core = new HopjitMcpCore({ providers: [VALID_PROVIDER] });
    const dir = mkdtempSync(join(tmpdir(), 'mcp-0164-tfi-'));
    writeFileSync(join(dir, 's.md'), REASON_SPEC);
    writeFileSync(join(dir, 'hopjit.yaml'), 'tool_servers:\n  - name: srv\n    binding:\n      kind: carrier-pigeon\n    tools:\n      - name: fly\n');
    const r = await core.startRun(join(dir, 's.md'), undefined, join(dir, '.hopstate'), dir);
    const err = r['error'] as { code: string; message: string } | undefined;
    expect(err?.code).toBe('TOOLS_FILE_INVALID');
    expect(err?.message).toContain('carrier-pigeon');
    expect(r['run_id']).toBeUndefined();
    expect(sentRequests.length).toBe(0);
  });
});
