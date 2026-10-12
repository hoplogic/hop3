// @module: config-load ^anc-struct-config-load
// 两级配置读取合并模块专属测试（todo/0131）。全部用临时目录当家目录与项目根,不碰开发者真实 ~/.hopjit。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configPaths, loadHopConfig, loadReuseConfig, loadToolRegistry, mergeConfigs, parseConfigFile, applyReuseConfig, detectSystemLanguage, effectiveLanguage, type HopConfig } from '../src/config-load.js';
import type { HostConfig } from '../src/provider-types.js';

function fx(): { home: string; proj: string; sys: (y: string) => void; prj: (y: string) => void } {
  const home = mkdtempSync(join(tmpdir(), 'cl-home-'));
  const proj = mkdtempSync(join(tmpdir(), 'cl-proj-'));
  mkdirSync(join(home, '.hopjit'), { recursive: true });
  const mod = 'export async function execute(name, args) { return { success: true, result: "echo:" + (args.msg ?? ""), content_type: "text" }; }\n';
  writeFileSync(join(home, '.hopjit', 'echo-tools.mjs'), mod);
  writeFileSync(join(proj, 'echo-tools.mjs'), mod);
  return {
    home, proj,
    sys: (y) => writeFileSync(join(home, '.hopjit', 'config.yaml'), y),
    prj: (y) => writeFileSync(join(proj, 'hopjit.yaml'), y),
  };
}
const PROVIDER = 'providers:\n  - service_id: s1\n    protocol: anthropic\n    base_url: https://x/v1\n    model: m\n    api_key_env: K1\n';
function bareHost(ws: string): HostConfig {
  return { workspace_dir: ws, sandbox: { filesystem: { workspace_dir: ws, read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, language: 'en', hop_env: { hop_env_language: 'en' }, api_key: '' };
}

// @v: anc-struct-config-load-exports, anc-struct-config-load-types
describe('configPaths：路径怎么来只有这一处', () => {
  it('正例：缺省两级 = <home>/.hopjit/config.yaml + <projectDir>/hopjit.yaml', () => {
    const p = configPaths('/h', '/p');
    expect(p).toEqual({ sysPath: '/h/.hopjit/config.yaml', projPath: '/p/hopjit.yaml', homeDir: '/h' });
  });
  it('反例：显式路径（HOPJIT_CONFIG）在场 → 单文件语义 projPath null,不合并', () => {
    const p = configPaths('/h', '/p', '/etc/one.yaml');
    expect(p.sysPath).toBe('/etc/one.yaml');
    expect(p.projPath).toBeNull();
  });
});

// @v: anc-config-two-level-merge
describe('两级合并逐键规则', () => {
  it('正例：只有系统级在场 → 系统级的 commands / language / env / resource_limits / tool_servers 全部生效（修前复用模式一个键都不读）', () => {
    const f = fx();
    f.sys('commands: [git]\nlanguage: zh\nenv: {hop_env_x: a}\nresource_limits: {max_call_depth: 4}\ntool_servers:\n  - name: ws\n    binding: {kind: in-process, module: ./echo-tools.mjs}\n    tools:\n      - name: web_search_x\n        params: []\n');
    const c = loadHopConfig(configPaths(f.home, f.proj), { requireProviders: false });
    expect(c.commands).toEqual(['git']);
    expect(c.language).toBe('zh');
    expect(c.env).toEqual({ hop_env_x: 'a' });
    expect(c.resource_limits).toEqual({ max_call_depth: 4 });
    expect((c.tool_servers as Array<{ name: string; _base_dir: string }>)[0]._base_dir).toBe(join(f.home, '.hopjit'));   // 系统级条目相对 ~/.hopjit/
  });
  it('正例：单值键项目级在场即赢（language / log_level）;env 与 resource_limits 逐键合并项目级赢', () => {
    const f = fx();
    f.sys('language: zh\nlog_level: debug\nenv: {hop_env_a: sa, hop_env_b: sb}\nresource_limits: {max_call_depth: 4, max_output_tokens: 1000}\n');
    f.prj('language: en\nenv: {hop_env_b: pb, hop_env_c: pc}\nresource_limits: {max_output_tokens: 2000}\n');
    const c = loadHopConfig(configPaths(f.home, f.proj), { requireProviders: false });
    expect(c.language).toBe('en');
    expect(c.log_level).toBe('debug');   // 项目级没写,系统级留
    expect(c.env).toEqual({ hop_env_a: 'sa', hop_env_b: 'pb', hop_env_c: 'pc' });
    expect(c.resource_limits).toEqual({ max_call_depth: 4, max_output_tokens: 2000 });
  });
  it('正例：commands 两级并集去重', () => {
    const f = fx();
    f.sys('commands: [git, echo]\n'); f.prj('commands: [uv, git]\n');
    const c = loadHopConfig(configPaths(f.home, f.proj), { requireProviders: false });
    expect(c.commands).toEqual(['git', 'echo', 'uv']);
  });
  it('正例：tool_servers 按 name 合并,同名项目级整条替换;各条目 _base_dir 跟声明所在文件走', () => {
    const f = fx();
    f.sys('tool_servers:\n  - name: a\n    binding: {kind: in-process, module: ./echo-tools.mjs}\n    tools: [{name: a_sys, description: d, input_schema: {type: object}, requires_commit: false}]\n  - name: b\n    binding: {kind: in-process, module: ./echo-tools.mjs}\n    tools: [{name: b1, description: d, input_schema: {type: object}, requires_commit: false}]\n');
    f.prj('tool_servers:\n  - name: a\n    binding: {kind: in-process, module: ./echo-tools.mjs}\n    tools: [{name: a_proj, description: d, input_schema: {type: object}, requires_commit: false}]\n');
    const c = loadHopConfig(configPaths(f.home, f.proj), { requireProviders: false });
    const ts = c.tool_servers as Array<{ name: string; tools: Array<{ name: string }>; _base_dir: string }>;
    expect(ts.map(t => t.name).sort()).toEqual(['a', 'b']);
    const a = ts.find(t => t.name === 'a')!;
    expect(a.tools[0].name).toBe('a_proj');   // 整条替换,不是 tools 并集
    expect(a._base_dir).toBe(f.proj);
    expect(ts.find(t => t.name === 'b')!._base_dir).toBe(join(f.home, '.hopjit'));
  });
  it('反例：HOPJIT_CONFIG 单文件 → 只用它,项目级 hopjit.yaml 不合并', () => {
    const f = fx();
    const one = join(f.home, 'one.yaml');
    writeFileSync(one, 'commands: [only]\n');
    f.prj('commands: [proj]\nlanguage: zh\n');
    const c = loadHopConfig(configPaths(f.home, f.proj, one), { requireProviders: false });
    expect(c.commands).toEqual(['only']);
    expect(c.language).toBeUndefined();
  });
  it('两级全缺席：复用模式返空配置;独立模式（requireProviders）抛 STANDALONE_CONFIG_MISSING', () => {
    const f = fx();
    expect(loadHopConfig(configPaths(f.home, f.proj), { requireProviders: false })).toEqual({ providers: [] });
    expect(() => loadHopConfig(configPaths(f.home, f.proj), { requireProviders: true })).toThrow(/STANDALONE_CONFIG_MISSING/);
  });
  it('独立模式：合并后 providers 为空 → STANDALONE_CONFIG_MISSING_PROVIDERS;在场则 resolveDefault 回调被调（default_model 引用核注入点）', () => {
    const f = fx();
    f.prj('commands: [git]\n');
    expect(() => loadHopConfig(configPaths(f.home, f.proj), { requireProviders: true })).toThrow(/MISSING_PROVIDERS/);
    f.sys(PROVIDER);
    let seen: HopConfig | undefined;
    const c = loadHopConfig(configPaths(f.home, f.proj), { requireProviders: true, resolveDefault: (cfg) => { seen = cfg; } });
    expect(seen).toBe(c);
    expect(c.commands).toEqual(['git']);
  });
  it('mergeConfigs 直测：owner_id 不合并（只在系统级有意义）', () => {
    const m = mergeConfigs({ providers: [], owner_id: 'u-h' } as HopConfig, { providers: [] } as HopConfig);
    expect(m.owner_id).toBeUndefined();
  });
  it('parseConfigFile：env 值 ~/ 前缀按传入的 homeDir 归一（模块不读进程状态）', () => {
    const f = fx();
    f.prj('env: {hop_env_kb: ~/kb}\n');
    const c = parseConfigFile(join(f.proj, 'hopjit.yaml'), false, '/fake/home');
    expect(c.env?.hop_env_kb).toBe('/fake/home/kb');
  });
});

// @v: anc-config-reuse-consume
describe('复用模式容错两档与消费面', () => {
  it('反例（分文件容错）：系统级文件坏 YAML + 项目级好 → 项目级保留,一条 warning 点名系统级文件,不抛（修前整体回空连项目级 [git] 一起丢）', () => {
    const f = fx();
    f.sys(':::bad yaml{{{\n'); f.prj('commands: [git]\n');
    const { config, warnings } = loadReuseConfig(configPaths(f.home, f.proj));
    expect(config.commands).toEqual(['git']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/\[config\] .*config\.yaml 读取失败,这份文件按零配置处理/);
  });
  it('正例（review 面二 E 回归）：项目级 hopjit.yaml 是纯注释模板 + 系统级 zh/[git] → zh 与 [git] 仍生效且零 warning（修前把模板当坏文件,系统级一起丢成零配置）', () => {
    const f = fx();
    f.sys('language: zh\ncommands: [git]\n'); f.prj('# hopjit.yaml 模板\n# language: en\n\n');
    const { config, warnings } = loadReuseConfig(configPaths(f.home, f.proj));
    expect(warnings).toEqual([]);
    expect(config.language).toBe('zh');
    expect(config.commands).toEqual(['git']);
    const hc = bareHost(f.proj); applyReuseConfig(hc, config);
    expect(hc.hop_env.hop_env_language).toBe('zh');
    expect(hc.sandbox.runtime.available).toEqual(['git']);
  });
  it('正例：parseConfigFile 对空文件按零配置（与纯注释同判）;两级都坏 → 两条 warning 各点名一份,合并结果零配置', () => {
    const f = fx();
    f.prj('');
    expect(parseConfigFile(join(f.proj, 'hopjit.yaml'), false, f.home)).toEqual({ providers: [] });
    f.sys('- a\n'); f.prj('commands: git\n');
    const { config, warnings } = loadReuseConfig(configPaths(f.home, f.proj));
    expect(config).toEqual({ providers: [] });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/config\.yaml/); expect(warnings[1]).toMatch(/hopjit\.yaml/);
  });
  it('反例（review 面二 F）：tool_servers 条目为 null → parseConfigFile 抛 STANDALONE_CONFIG_INVALID 点名下标;loadReuseConfig 不吞,折 CONFIG_ERROR 点名文件（修前合并 byKey 取 .name 崩 TypeError）', () => {
    const f = fx();
    f.prj('tool_servers:\n  -\n  - name: ok\n    binding: {kind: in-process, module: ./echo-tools.mjs}\n    tools: []\n');
    expect(() => parseConfigFile(join(f.proj, 'hopjit.yaml'), false, f.home)).toThrow(/STANDALONE_CONFIG_INVALID: .*tool_servers\[0\] 须为映射/);
    expect(() => loadReuseConfig(configPaths(f.home, f.proj))).toThrow(/^CONFIG_ERROR: .*hopjit\.yaml tool_servers 节读坏/);
    f.prj('tool_servers: notalist\n');
    expect(() => loadReuseConfig(configPaths(f.home, f.proj))).toThrow(/^CONFIG_ERROR: .*tool_servers 须为数组/);
  });
  it('反例：commands 形状不符（标量）→ 钝感回缺省带 warning;language 坏值同档', () => {
    const f = fx();
    f.prj('commands: git\n');
    expect(loadReuseConfig(configPaths(f.home, f.proj)).warnings).toHaveLength(1);
    f.prj('language: fr\n');
    const r = loadReuseConfig(configPaths(f.home, f.proj));
    expect(r.config.language).toBeUndefined();
    expect(r.warnings).toHaveLength(1);
  });
  it('反例：commands 含 hopjit → CONFIG_ERROR 响亮抛（钝感档的唯一例外）', () => {
    const f = fx();
    f.sys('commands: [git, hopjit]\n');
    expect(() => loadReuseConfig(configPaths(f.home, f.proj))).toThrow(/^CONFIG_ERROR: .*不得含 hopjit/);
  });
  it('反例：tool_servers 坏条目 → loadToolRegistry 响亮抛（不被钝感档吞）', () => {
    const f = fx();
    f.prj('tool_servers:\n  - name: bad\n    tools: [{name: x, description: d, input_schema: {type: object}, requires_commit: false}]\n');   // 缺 binding
    expect(() => loadToolRegistry(configPaths(f.home, f.proj), f.proj)).toThrow(/TOOLS_FILE_INVALID|binding/);
  });
  it('正例：loadToolRegistry 两级合并后解析;零注册返 undefined', () => {
    const f = fx();
    expect(loadToolRegistry(configPaths(f.home, f.proj), f.proj)).toBeUndefined();
    f.sys('tool_servers:\n  - name: ws\n    binding: {kind: in-process, module: ./echo-tools.mjs}\n    tools: [{name: web_search_x, description: d, input_schema: {type: object}, requires_commit: false}]\n');
    const reg = loadToolRegistry(configPaths(f.home, f.proj), f.proj)!;
    expect(reg.map(r => r.name)).toEqual(['ws']);
  });
  it('正例：applyReuseConfig 四样装进 HostConfig;env 绝对路径值同扩 read allowed;resource_limits 合并进去', () => {
    const f = fx();
    const abs = realpathSync(f.home);
    const hc = bareHost(f.proj);
    applyReuseConfig(hc, { providers: [], commands: ['git'], language: 'zh', env: { hop_env_root: abs, hop_env_rel: 'x' }, resource_limits: { max_call_depth: 3 } });
    expect(hc.sandbox.runtime.available).toEqual(['git']);
    expect(hc.language).toBe('zh');
    expect(hc.hop_env).toEqual({ hop_env_language: 'zh', hop_env_root: abs, hop_env_rel: 'x' });
    expect(hc.sandbox.filesystem.read_access.allowed).toContain(abs);
    expect(hc.resource_limits?.max_call_depth).toBe(3);
  });
  it('正例（review 面三 G8）：applyReuseConfig 对 env 绝对路径值去重——已在 read allowed 里的不重复 push,两个同值键只扩一次', () => {
    const hc = bareHost('/ws');
    hc.sandbox.filesystem.read_access.allowed.push('/data/kb');
    applyReuseConfig(hc, { providers: [], env: { hop_env_a: '/data/kb', hop_env_b: '/data/kb', hop_env_c: 'rel/path' } });
    expect(hc.sandbox.filesystem.read_access.allowed.filter(x => x === '/data/kb')).toHaveLength(1);
    expect(hc.sandbox.filesystem.read_access.allowed).not.toContain('rel/path');
  });
  it('反例：applyReuseConfig 空配置 → 缺省四样（空名单 / 语言跟随系统〔本例钉英文环境〕/ 只打底键 / 无 resource_limits）', () => {
    const saved = { LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES, LANG: process.env.LANG };
    try {
      delete process.env.LC_ALL; delete process.env.LC_MESSAGES; process.env.LANG = 'en_US.UTF-8';   // 缺省随系统语言（todo/0160）,本例把系统钉成英文
      const hc = bareHost('/ws');
      applyReuseConfig(hc, { providers: [] });
      expect(hc.sandbox.runtime.available).toEqual([]);
      expect(hc.language).toBe('en');
      expect(hc.hop_env).toEqual({ hop_env_language: 'en' });
      expect(hc.resource_limits).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

// @v: anc-i18n-language-config —— todo/0160 作者定"language 缺省跟随系统语言,中文就 zh 否则 en"
describe('language 缺省跟随系统语言（detectSystemLanguage / effectiveLanguage）', () => {
  const KEYS = ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (patch: Partial<Record<(typeof KEYS)[number], string>>) => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    for (const [k, v] of Object.entries(patch)) process.env[k] = v;
  };
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.restoreAllMocks();
  });

  it('正例：LANG=zh_CN.UTF-8 且键缺席 → zh;LANG=en_US.UTF-8 且键缺席 → en（applyReuseConfig 走到 hop_env_language 同值）', () => {
    setEnv({ LANG: 'zh_CN.UTF-8' });
    const hc = bareHost('/ws'); applyReuseConfig(hc, { providers: [] });
    expect(hc.language).toBe('zh');   // 变异：探测函数恒返 'en' → 红
    expect(hc.hop_env.hop_env_language).toBe('zh');
    setEnv({ LANG: 'en_US.UTF-8' });
    const hc2 = bareHost('/ws'); applyReuseConfig(hc2, { providers: [] });
    expect(hc2.language).toBe('en');
  });
  it('正例（优先序）：LC_ALL=en_US 压 LANG=zh_CN → en;LC_MESSAGES=zh_TW 压 LANG=en_US → zh;zh-Hans / ZH_cn 大小写与连字符都算中文', () => {
    setEnv({ LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' });
    expect(detectSystemLanguage()).toBe('en');   // 变异：顺序改成 LANG 先 → 红
    setEnv({ LC_MESSAGES: 'zh_TW.UTF-8', LANG: 'en_US.UTF-8' });
    expect(detectSystemLanguage()).toBe('zh');
    expect(detectSystemLanguage({ LANG: 'zh-Hans' })).toBe('zh');
    expect(detectSystemLanguage({ LANG: 'ZH_cn' })).toBe('zh');
    expect(detectSystemLanguage({ LANG: 'C' })).toBe('en');
    expect(detectSystemLanguage({ LANG: 'POSIX' })).toBe('en');
    expect(detectSystemLanguage({ LANG: 'ja_JP.UTF-8' })).toBe('en');
  });
  it('正例（兜底）：三个环境变量都空 → 用 Intl 的 resolvedOptions().locale;Intl 报 zh-CN → zh,报 en-US → en', () => {
    setEnv({});
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ locale: 'zh-CN' } as Intl.ResolvedDateTimeFormatOptions);
    expect(detectSystemLanguage()).toBe('zh');   // 变异：删 Intl 兜底 → 空串落 en 红
    spy.mockReturnValue({ locale: 'en-US' } as Intl.ResolvedDateTimeFormatOptions);
    expect(detectSystemLanguage()).toBe('en');
  });
  it('反例（显式不被覆盖）：language: en 加 LANG=zh_CN → 仍 en;language: zh 加 LANG=en_US → 仍 zh', () => {
    setEnv({ LANG: 'zh_CN.UTF-8' });
    const hc = bareHost('/ws'); applyReuseConfig(hc, { providers: [], language: 'en' });
    expect(hc.language).toBe('en');   // 变异：effectiveLanguage 忽略键值恒探测 → 红
    expect(hc.hop_env.hop_env_language).toBe('en');
    setEnv({ LANG: 'en_US.UTF-8' });
    const hc2 = bareHost('/ws'); applyReuseConfig(hc2, { providers: [], language: 'zh' });
    expect(hc2.language).toBe('zh');
  });
  it('反例（坏值按缺席）：复用模式 language: fr 坏值加 LANG=zh_CN → zh（等同没写,不再写死 en）', () => {
    setEnv({ LANG: 'zh_CN.UTF-8' });
    const hc = bareHost('/ws'); applyReuseConfig(hc, { providers: [], language: 'fr' as unknown as 'en' });
    expect(hc.language).toBe('zh');   // 变异：坏值落 en → 红
    expect(effectiveLanguage(undefined)).toBe('zh');
    expect(effectiveLanguage(42)).toBe('zh');
  });
});
