// @module: tools ^anc-struct-tools
// @v: anc-provider-tool
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NotifyToolProvider, composeRunCard } from '../src/tools-notify.js';
import { DefaultToolProvider , executeValidateSpec, executeReadSpecTree, isWorkZonePath , registerWorkZoneRoot, executeInsertNode, executeReplaceNode, executeReplaceChildren, executeRenumberSteps } from '../src/tools.js';
import { deleteNodeAt, replaceNodeAt as coreReplaceNodeAt, renumberSteps as coreRenumberSteps } from '../src/spec-tree-edit.js';
import type { StepNode } from '../src/ast-types.js';
import { parseFragment as parseFragForCore } from '../src/parser.js';
import type { HostConfig } from '../src/provider-types.js';
import { B2_BUILTIN_FILE_TOOLS, B2_BUILTIN_NOTIFY_TOOLS, B2_BUILTIN_TOOL_SIGS, B9_WRITE_TOOLS, B10_READ_TOOLS } from '../src/validator.js';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

function makeProvider(workDir?: string): DefaultToolProvider {
  const dir = workDir ?? mkdtempSync(join(tmpdir(), 'hoptools-'));
  const config: HostConfig = {
    workspace_dir: dir,
    sandbox: {
      filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } },
      network: { trusted_hosts: [] },
      runtime: { available: [] },
    },
    api_key: 'test',
  };
  return new DefaultToolProvider(config);
}

// @v: anc-provider-tool, anc-exec-requires-commit, anc-config-sandbox
describe('DefaultToolProvider', () => {
  describe('list()', () => {
    it('returns the seventeen builtin tools (eleven file/dir + validate_spec + four tree-edit + read_spec_tree), all requires_commit=false (no bash)', () => {
      const provider = makeProvider();
      const tools = provider.list();
      expect(tools.map(t => t.name)).toEqual(
        ['read', 'write', 'listdir', 'exists', 'create', 'append', 'edit_file', 'search_file', 'makedirs', 'move', 'remove', 'validate_spec', 'insert_node', 'replace_node', 'replace_children', 'renumber_steps', 'read_spec_tree']);
      // 不可逆分界=是否出沙箱，非操作类型（作者定 2026-08-10）——箱内全 false（validate_spec 纯函数同理）
      for (const tool of tools) expect(tool.requires_commit).toBe(false);
    });

    it('each tool has required fields', () => {
      const provider = makeProvider();
      for (const tool of provider.list()) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.input_schema).toBeDefined();
      }
    });
  });

  // 三名单同源对账钉（^anc-rule-b2/b9/b10 各自宣称"与 tools.ts 注册面同源"——validator 核心层
  // 不得 import 适配层,同源全靠人记:2026-09-06 review 变异实锤 B2 删一员全量 2852 全绿零红、
  // B9 缺 edit_file/B10 缺 search_file 两批扩员各漏刷姊妹条。本钉在测试层对 DefaultToolProvider
  // 注册面逐员核,一钉治三名单的成员级保护与同源守卫——今后扩员漏刷任一名单当场红。）
  // @v: anc-rule-b2, anc-rule-b9, anc-rule-b10
  describe('B2/B9/B10 名单与 tools.ts 注册面同源对账', () => {
    const FILE_TOOL_NAMES = makeProvider().list().map(t => t.name);
    // 注册面按语义分组（与 file-tools.md HopSop 2.1/2.2 的读写侧分组同口径）
    const READ_SIDE = ['read', 'exists', 'listdir', 'search_file'];
    const WRITE_SIDE = ['write', 'append', 'create', 'edit_file', 'makedirs', 'move', 'remove'];

    it('B2 名单 = 注册面全量（文件件+spec 内容族,17 员逐员）', () => {
      expect([...B2_BUILTIN_FILE_TOOLS].sort()).toEqual([...FILE_TOOL_NAMES].sort());
    });

    it('B9 名单 = 注册面写侧七件逐员（edit_file 在内——review 补员后锁死）', () => {
      expect([...B9_WRITE_TOOLS].sort()).toEqual([...WRITE_SIDE].sort());
      for (const n of WRITE_SIDE) expect(FILE_TOOL_NAMES).toContain(n);
    });

    it('B10 名单 = 注册面读侧四件逐员（search_file 在内——review 补员后锁死）', () => {
      expect([...B10_READ_TOOLS].sort()).toEqual([...READ_SIDE].sort());
      for (const n of READ_SIDE) expect(FILE_TOOL_NAMES).toContain(n);
    });

    it('B2 签名表 = 注册面 input_schema 逐键核（参数名级对账——20260916 升档批:B2 三判的判据面与 ToolDef properties/required 同源,引擎参数改名/扩参漏刷签名表当场红）', () => {
      const provider = makeProvider();
      for (const def of provider.list()) {
        const sig = B2_BUILTIN_TOOL_SIGS.get(def.name);
        expect(sig, `签名表缺工具 ${def.name}`).toBeDefined();
        const schema = def.input_schema as { properties?: Record<string, unknown>; required?: string[] };
        expect([...sig!.props].sort(), `${def.name} 参数名集不同源`).toEqual(Object.keys(schema.properties ?? {}).sort());
        expect([...sig!.required].sort(), `${def.name} 必填集不同源`).toEqual([...(schema.required ?? [])].sort());
      }
      // 反向:签名表无幽灵成员(注册面删工具漏刷签名表同样红)
      const names = new Set(provider.list().map(t => t.name));
      for (const k of B2_BUILTIN_TOOL_SIGS.keys()) expect(names.has(k), `签名表幽灵成员 ${k}`).toBe(true);
    });

    it('B2 通知件名单 = 两员来源各验（R10 补第四份对账——dingtalk_notify 对 tools-notify 注册面,notify 对 tools-composite specs 表 tool_id 映射;此前零钉,注册面扩员/改映射静默漂移）', () => {
      const notifyNames = new NotifyToolProvider().list().map(t => t.name);
      expect(notifyNames).toContain('dingtalk_notify');
      expect(B2_BUILTIN_NOTIFY_TOOLS.has('dingtalk_notify')).toBe(true);
      // notify 真身=composite 内建成员表的 tool_id 映射(源码常量,静态可核)
      const compositeSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tools-composite.ts'), 'utf-8');
      expect(compositeSrc).toContain("tool_id: 'notify'");
      expect(B2_BUILTIN_NOTIFY_TOOLS.has('notify')).toBe(true);
      // 名单恰两员——注册面加第三员时此断言红,提醒同步扩名单
      expect(B2_BUILTIN_NOTIFY_TOOLS.size).toBe(2);
    });
  });

  // @v: anc-exec-sandbox-principle, anc-config-sandbox-model
  // 实参名进闸核对（file-tools 实参名进闸条款,2026-09-16 决策——move(src:/dst:) 笔误 undefined
  // 穿透 Node fs 报"path argument must be of type string"而 move 无 path 参,误导排查半轮;
  // 运行期兜底半边,静态半边=B2 三判〔act-body-validator.test〕,两层防线不互替）。
  // @v: anc-exec-tool-arg-gate
  describe('execute 实参名进闸', () => {
    it('反例：move 收 src/dst 臆造名 → 拒收点名合法参数,不再穿透 Node fs（实撞原样重放）', async () => {
      const provider = makeProvider();
      const result = await provider.execute('move', { src: 'a.txt', dst: 'b.txt' });
      expect(result.success).toBe(false);
      expect(String(result.result)).toContain('没有参数 "src"/"dst"');
      expect(String(result.result)).toContain('from/to');
    });

    it('反例：write 缺必填 content → 拒收点名缺谁', async () => {
      const provider = makeProvider();
      const result = await provider.execute('write', { path: 'x.txt' });
      expect(result.success).toBe(false);
      expect(String(result.result)).toContain('缺必填参数 "content"');
    });

    it('正例：合法参数名照常执行（可选参数缺席不误拒）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 't.txt'), 'ok');
      const provider = makeProvider(dir);
      const result = await provider.execute('read', { path: 't.txt' });
      expect(result.success).toBe(true);
    });
  });

  describe('execute bash (removed)', () => {
    it('rejects bash tool calls (bash not available in DefaultToolProvider)', async () => {
      const provider = makeProvider();
      const result = await provider.execute('bash', { command: 'echo hello' });
      expect(result.success).toBe(false);
      expect(String(result.result)).toContain('Unknown tool');
    });
  });

  describe('execute read', () => {
    it('reads file in workspace', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'test.txt'), 'hello world');
      const provider = makeProvider(dir);
      const result = await provider.execute('read', { path: 'test.txt' });
      expect(result.success).toBe(true);
      expect(result.result).toBe('hello world');
    });

    // read 行号段扩参（^anc-exec-builtin-search-file——两参均缺=全文存量零回归;行号 1 起;
    // start 越界报错带总行数;end 越界截尾;start>end 拒。2026-09-06 todo/0070）
    // @v: anc-exec-builtin-search-file
    it('正例:行号段读取与全文对应行 slice 一致（1 起含端）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'lines.txt'), 'L1\nL2\nL3\nL4\nL5');
      const provider = makeProvider(dir);
      const r = await provider.execute('read', { path: 'lines.txt', start_line: 2, end_line: 4 });
      expect(r.success).toBe(true);
      expect(r.result).toBe('L2\nL3\nL4');
    });

    it('正例:只给 start_line 读到文件尾;只给 end_line 从头读', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'lines.txt'), 'L1\nL2\nL3');
      const provider = makeProvider(dir);
      const r1 = await provider.execute('read', { path: 'lines.txt', start_line: 2 });
      expect(r1.success).toBe(true);
      expect(r1.result).toBe('L2\nL3');
      const r2 = await provider.execute('read', { path: 'lines.txt', end_line: 2 });
      expect(r2.success).toBe(true);
      expect(r2.result).toBe('L1\nL2');
    });

    it('正例:end_line 越界截到文件尾不报错（读到尾是自然语义）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'lines.txt'), 'L1\nL2\nL3');
      const provider = makeProvider(dir);
      const r = await provider.execute('read', { path: 'lines.txt', start_line: 2, end_line: 99 });
      expect(r.success).toBe(true);
      expect(r.result).toBe('L2\nL3');
    });

    it('反例:start_line 超总行数报错带总行数（宁拒不猜）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'lines.txt'), 'L1\nL2\nL3');
      const provider = makeProvider(dir);
      const r = await provider.execute('read', { path: 'lines.txt', start_line: 9 });
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('超出文件总行数 3');
    });

    it('反例(G3):start_line 为 0/负数/非整数 → 报错"须为 1 起整数"', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'lines.txt'), 'L1\nL2');
      const provider = makeProvider(dir);
      for (const bad of [0, -1, 1.5]) {
        const r = await provider.execute('read', { path: 'lines.txt', start_line: bad });
        expect(r.success).toBe(false);
        expect(String(r.result)).toContain('须为 1 起整数');
      }
    });

    it('反例(G3):end_line 为 0/负数/非整数 → 报错"须为 1 起整数"', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'lines.txt'), 'L1\nL2');
      const provider = makeProvider(dir);
      for (const bad of [0, -2, 2.5]) {
        const r = await provider.execute('read', { path: 'lines.txt', start_line: 1, end_line: bad });
        expect(r.success).toBe(false);
        expect(String(r.result)).toContain('须为 1 起整数');
      }
    });

    it('反例:start_line > end_line 无效区间拒', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'lines.txt'), 'L1\nL2\nL3');
      const provider = makeProvider(dir);
      const r = await provider.execute('read', { path: 'lines.txt', start_line: 3, end_line: 1 });
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('无效区间');
    });

    it('rejects absolute paths', async () => {
      const provider = makeProvider();
      const result = await provider.execute('read', { path: '/etc/passwd' });
      expect(result.success).toBe(false);
      expect(String(result.result)).toContain('Absolute paths');
    });

    it('rejects path traversal', async () => {
      const provider = makeProvider();
      const result = await provider.execute('read', { path: '../../../etc/passwd' });
      expect(result.success).toBe(false);
      expect(String(result.result)).toContain('traversal');
    });
  });

  describe('execute write', () => {
    it('writes file in workspace', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const provider = makeProvider(dir);
      const result = await provider.execute('write', { path: 'out.txt', content: 'data' }, 'workspace');
      expect(result.success).toBe(true);

      const readResult = await provider.execute('read', { path: 'out.txt' });
      expect(readResult.result).toBe('data');
    });

    // yaml 型变量直传写侧（^anc-type-yaml-structured 落盘条款——原 as string 裸断言,
    // 结构进来 writeFileSync 抛 TypeError 炸穿,三十六审探针实抓）
    // @v: anc-type-yaml-structured
    it('正例：content 收结构 → YAML 块式文本落盘（不炸穿）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const provider = makeProvider(dir);
      const r = await provider.execute('write', { path: 'c.yaml', content: { goal: 'g', inputs: [{ name: 'x' }] } }, 'workspace');
      expect(r.success).toBe(true);
      const back = await provider.execute('read', { path: 'c.yaml' });
      expect(String(back.result)).toContain('goal: g');
      expect(String(back.result)).toContain('- name: x');   // 块式 YAML 非 JSON 单行
    });

    it('反例：content 为字符串原样写入（不被二次序列化加引号）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const provider = makeProvider(dir);
      await provider.execute('append', { path: 'p.txt', content: 'line1: x' }, 'workspace');
      const back = await provider.execute('read', { path: 'p.txt' });
      expect(back.result).toBe('line1: x');
    });

    it('rejects write to .hopstate', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      mkdirSync(join(dir, '.hopstate'));
      const provider = makeProvider(dir);
      const result = await provider.execute('write', { path: '.hopstate/hack.json', content: '{}' }, 'workspace');
      expect(result.success).toBe(false);
      expect(String(result.result)).toContain('forbidden');
    });
  });

  // @v: anc-exec-tool-permission, anc-config-sandbox-filesystem
  describe('filesystem sandbox', () => {
    it('allows read within workspace', async () => {
      const wsDir = mkdtempSync(join(tmpdir(), 'hoptools-ws-'));
      writeFileSync(join(wsDir, 'data.txt'), 'ok');

      const config: HostConfig = {
        workspace_dir: wsDir,
        sandbox: {
          filesystem: { workspace_dir: wsDir, read_access: { allowed: [], denied: [], confirm_required: [] } },
          network: { trusted_hosts: [] },
          runtime: { available: [] },
        },
        api_key: 'test',
      };
      const provider = new DefaultToolProvider(config);
      const result = await provider.execute('read', { path: 'data.txt' });
      expect(result.success).toBe(true);
      expect(result.result).toBe('ok');
    });

    it('rejects write outside workspace', async () => {
      const wsDir = mkdtempSync(join(tmpdir(), 'hoptools-ws-'));
      const outsideDir = mkdtempSync(join(tmpdir(), 'hoptools-out-'));
      writeFileSync(join(outsideDir, 'target.txt'), 'orig');
      symlinkSync(join(outsideDir, 'target.txt'), join(wsDir, 'link'));

      const config: HostConfig = {
        workspace_dir: wsDir,
        sandbox: {
          filesystem: { workspace_dir: wsDir, read_access: { allowed: [], denied: [], confirm_required: [] } },
          network: { trusted_hosts: [] },
          runtime: { available: [] },
        },
        api_key: 'test',
      };
      const provider = new DefaultToolProvider(config);
      const result = await provider.execute('write', { path: 'link', content: 'hacked' }, 'workspace');
      expect(result.success).toBe(false);
      expect(String(result.result)).toContain('Write outside workspace');
    });

    it('allows read from allowed paths outside workspace', async () => {
      const wsDir = mkdtempSync(join(tmpdir(), 'hoptools-ws-'));
      const allowedDir = mkdtempSync(join(tmpdir(), 'hoptools-allowed-'));
      writeFileSync(join(allowedDir, 'shared.txt'), 'allowed-data');
      symlinkSync(join(allowedDir, 'shared.txt'), join(wsDir, 'link-allowed'));

      const config: HostConfig = {
        workspace_dir: wsDir,
        sandbox: {
          filesystem: { workspace_dir: wsDir, read_access: { allowed: [allowedDir], denied: [], confirm_required: [] } },
          network: { trusted_hosts: [] },
          runtime: { available: [] },
        },
        api_key: 'test',
      };
      const provider = new DefaultToolProvider(config);
      const result = await provider.execute('read', { path: 'link-allowed' });
      expect(result.success).toBe(true);
      expect(result.result).toBe('allowed-data');
    });

    it('rejects read from denied path', async () => {
      const wsDir = mkdtempSync(join(tmpdir(), 'hoptools-ws-'));
      writeFileSync(join(wsDir, 'secret.key'), 'key-data');

      const config: HostConfig = {
        workspace_dir: wsDir,
        sandbox: {
          filesystem: { workspace_dir: wsDir, read_access: { allowed: [], denied: ['secret.key'], confirm_required: [] } },
          network: { trusted_hosts: [] },
          runtime: { available: [] },
        },
        api_key: 'test',
      };
      const provider = new DefaultToolProvider(config);
      const result = await provider.execute('read', { path: 'secret.key' });
      expect(result.success).toBe(false);
      expect(String(result.result)).toContain('Read denied');
    });

    it('rejects read from confirm_required path in act step', async () => {
      const wsDir = mkdtempSync(join(tmpdir(), 'hoptools-ws-'));
      writeFileSync(join(wsDir, 'sensitive.conf'), 'config-data');

      const config: HostConfig = {
        workspace_dir: wsDir,
        sandbox: {
          filesystem: { workspace_dir: wsDir, read_access: { allowed: [], denied: [], confirm_required: ['sensitive.conf'] } },
          network: { trusted_hosts: [] },
          runtime: { available: [] },
        },
        api_key: 'test',
      };
      const provider = new DefaultToolProvider(config);
      const result = await provider.execute('read', { path: 'sensitive.conf' });
      expect(result.success).toBe(false);
      expect(String(result.result)).toContain('requires confirm');
    });

    it('rejects read outside workspace and allowed paths', async () => {
      const wsDir = mkdtempSync(join(tmpdir(), 'hoptools-ws-'));
      const outsideDir = mkdtempSync(join(tmpdir(), 'hoptools-out-'));
      writeFileSync(join(outsideDir, 'secret.txt'), 'leaked');
      symlinkSync(join(outsideDir, 'secret.txt'), join(wsDir, 'link-outside'));

      const config: HostConfig = {
        workspace_dir: wsDir,
        sandbox: {
          filesystem: { workspace_dir: wsDir, read_access: { allowed: [], denied: [], confirm_required: [] } },
          network: { trusted_hosts: [] },
          runtime: { available: [] },
        },
        api_key: 'test',
      };
      const provider = new DefaultToolProvider(config);
      const result = await provider.execute('read', { path: 'link-outside' });
      expect(result.success).toBe(false);
      expect(String(result.result)).toContain('Read outside allowed paths');
    });
  });

  describe('unknown tool', () => {
    it('returns failure for unknown tool name', async () => {
      const provider = makeProvider();
      const result = await provider.execute('unknown_tool', {});
      expect(result.success).toBe(false);
    });
  });
});

// P0-2 回归：默认沙箱 denied 基线——.env/*.key/.hopstate 默认拒读（2026-08-08 语义审计 ❌:
// 设计要求默认拒密钥类,代码 denied=[] 致凭证对 LLM read 工具可读）。// @v: anc-config-sandbox-filesystem
describe('默认沙箱 denied 基线', () => {
  it('cli buildHostConfig 的默认 denied 含 .env/*.key/.hopstate', async () => {
    const { buildHostConfig } = await import('../src/cli.js');
    const cfg = buildHostConfig();
    const denied = cfg.sandbox?.filesystem?.read_access?.denied ?? [];
    for (const must of ['.env', '*.key', '.hopstate/**', '.hoplog/**']) {
      expect(denied).toContain(must);
    }
  });

  // 声明在场 ≠ 拦截生效：glob 模式在纯子串匹配下会静默空转（复核实抓）——必须测真实拦截行为
  it('denied 基线的 glob 模式真实拦截（*.key/*.pem/.hopstate/**/.env.*）', async () => {
    const { buildHostConfig } = await import('../src/cli.js');
    const { validateReadAccess } = await import('../src/tools.js');
    const sandbox = buildHostConfig().sandbox;
    const blocked = [
      '/proj/secrets/api.key',
      '/proj/certs/server.pem',
      '/proj/.hopstate/abc/vars.json',
      '/proj/.env.production',
      '/proj/.env',
      // #50（dr19 实撞）：LLM 工具环逛 .hoplog 读巨型 main.yaml 灌爆上下文——日志树默认拒读
      '/proj/.hoplog/hopbuild2-20260826/main.yaml',
      '/proj/.hoplog/x/calls/5.1.1/log/split-node-1/main.yaml',
    ];
    for (const p of blocked) {
      expect(() => validateReadAccess(sandbox, p), `${p} 应被拦截`).toThrow(/denied/);
    }
    // 正常文件不误伤
    expect(() => validateReadAccess({ ...sandbox, filesystem: { ...sandbox.filesystem, workspace_dir: '/proj' } }, '/proj/src/index.ts')).not.toThrow();
  });
});

// 内置文件/目录工具组（2026-08-10 作者定实装：全 requires_commit=false——不可逆分界=
// 是否出沙箱，非操作类型）。正反例成对钉每个工具的语义边界与沙箱约束。
// @v: anc-exec-builtin-file-tools
describe('内置文件/目录工具组', () => {
  describe('listdir', () => {
    it('正例：列目录返回 name+type（正名,行业惯例）+kind（兼容别名同值）——2026-09-07 作者拍乙案:R9 实撞 e.type 缺键恒假文件清单恒空', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'a.txt'), 'x');
      mkdirSync(join(dir, 'sub'));
      const r = await makeProvider(dir).execute('listdir', { path: '.' });
      expect(r.success).toBe(true);
      const entries = JSON.parse(String(r.result)) as Array<{ name: string; type: string; kind: string }>;
      expect(entries).toContainEqual({ name: 'a.txt', type: 'file', kind: 'file' });   // type 正名在场
      expect(entries).toContainEqual({ name: 'sub', type: 'dir', kind: 'dir' });
      for (const e of entries) expect(e.type).toBe(e.kind);   // 兼容别名恒同值（存量消费 kind 零破坏）
    });
    it('反例：目录不存在显式失败', async () => {
      const r = await makeProvider().execute('listdir', { path: 'nope' });
      expect(r.success).toBe(false);
    });
  });

  describe('exists', () => {
    it('正例：存在返回 kind，不存在返回 false 不报错（探测语义）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'a.txt'), 'x');
      const p = makeProvider(dir);
      expect(JSON.parse(String((await p.execute('exists', { path: 'a.txt' })).result))).toEqual({ exists: true, type: 'file', kind: 'file' });   // type 正名+kind 兼容
      const miss = await p.execute('exists', { path: 'missing.txt' });
      expect(miss.success).toBe(true);
      expect(JSON.parse(String(miss.result))).toEqual({ exists: false, type: 'none', kind: 'none' });
    });
  });

  describe('create（排他新建，OS 原子语义透传）', () => {
    it('正例：新建成功', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const r = await makeProvider(dir).execute('create', { path: 'claim.lock', content: 'w1' }, 'workspace');
      expect(r.success).toBe(true);
    });
    it('反例：目标已存在即失败（并发抢占仅一家赢）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('create', { path: 'claim.lock', content: 'w1' }, 'workspace');
      const second = await p.execute('create', { path: 'claim.lock', content: 'w2' }, 'workspace');
      expect(second.success).toBe(false);
      expect(String(second.result)).toMatch(/EEXIST|exist/i);
    });
  });

  describe('append', () => {
    it('正例：追加保留旧内容；文件不存在则创建', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('append', { path: 'log.txt', content: 'a' }, 'workspace');
      await p.execute('append', { path: 'log.txt', content: 'b' }, 'workspace');
      const r = await p.execute('read', { path: 'log.txt' });
      expect(r.result).toBe('ab');
    });
  });

  // search_file 单文件子串搜索（^anc-exec-builtin-search-file——纯子串非正则,零命中空清单
  // 探测语义同 exists,pattern 禁空串同 edit_file 哲学。2026-09-06 todo/0070）
  // @v: anc-exec-builtin-search-file
  describe('execute search_file', () => {
    it('正例:三处同串返回三行带 1 起行号', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'doc.txt'), 'alpha 目标词\nbeta\n目标词 gamma\ndelta\n尾行目标词');
      const provider = makeProvider(dir);
      const r = await provider.execute('search_file', { path: 'doc.txt', pattern: '目标词' });
      expect(r.success).toBe(true);
      const hits = JSON.parse(String(r.result));
      expect(hits.map((h: { line: number }) => h.line)).toEqual([1, 3, 5]);
      expect(hits[1].text).toBe('目标词 gamma');
    });

    it('正例:context_lines=1 命中成员带上下文字段', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'doc.txt'), 'a\nb-hit\nc');
      const provider = makeProvider(dir);
      const r = await provider.execute('search_file', { path: 'doc.txt', pattern: 'hit', context_lines: 1 });
      expect(r.success).toBe(true);
      const hits = JSON.parse(String(r.result));
      expect(hits).toHaveLength(1);
      expect(hits[0].context).toBe('a\nb-hit\nc');
    });

    it('反例:零命中返回空清单不报错（探测语义同 exists）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'doc.txt'), 'nothing here');
      const provider = makeProvider(dir);
      const r = await provider.execute('search_file', { path: 'doc.txt', pattern: '不存在的串' });
      expect(r.success).toBe(true);
      expect(JSON.parse(String(r.result))).toEqual([]);
    });

    it('反例:pattern 空串报错（同 edit_file old_text 禁空串哲学）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'doc.txt'), 'x');
      const provider = makeProvider(dir);
      const r = await provider.execute('search_file', { path: 'doc.txt', pattern: '' });
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('pattern 不可为空');
    });

    it('反例:denied 路径拒搜索（读权限三级链同 read）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'secret.env'), 'SECRET=x');
      const provider = new DefaultToolProvider({
        workspace_dir: dir,
        sandbox: {
          filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [join(dir, 'secret.env')], confirm_required: [] } },
          network: { trusted_hosts: [] },
          runtime: { available: [] },
        },
        api_key: 'test',
      });
      const r = await provider.execute('search_file', { path: 'secret.env', pattern: 'SECRET' });
      expect(r.success).toBe(false);
    });

    it('反例:pattern 是正则元字符按字面匹配（不解释正则）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      writeFileSync(join(dir, 'doc.txt'), 'price: a.c\nprice: abc');
      const provider = makeProvider(dir);
      const r = await provider.execute('search_file', { path: 'doc.txt', pattern: 'a.c' });
      expect(r.success).toBe(true);
      const hits = JSON.parse(String(r.result));
      expect(hits).toHaveLength(1);   // 只中字面 a.c,不中 abc——正则语义会两处都中
      expect(hits[0].line).toBe(1);
    });
  });

  // edit_file 局部精确替换（^anc-exec-builtin-edit-file-tool——恰一处才替换,零/多匹配报错带计数;
  // 0038b 实测"改三处却 write 全文回写"的封堵正路）。
  // @v: anc-exec-builtin-edit-file-tool
  describe('edit_file 局部精确替换', () => {
    it('正例：唯一匹配替换成功——内容改对,回执含 char 偏移（字符偏移=UTF-16 码元,与文档口径同批改词）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('write', { path: 'doc.md', content: 'line one\nline two\nline three' }, 'workspace');
      const r = await p.execute('edit_file', { path: 'doc.md', old_text: 'line two', new_text: 'line 2' }, 'workspace');
      expect(r.success).toBe(true);
      expect(String(r.result)).toContain('char');
      expect(String(r.result)).toContain('Replaced 1 occurrence');
      const back = await p.execute('read', { path: 'doc.md' });
      expect(back.result).toBe('line one\nline 2\nline three');
    });
    it('反例：零匹配报错（含"未找到匹配"与 old_text 回显）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('write', { path: 'doc.md', content: 'hello' }, 'workspace');
      const r = await p.execute('edit_file', { path: 'doc.md', old_text: 'ghost text', new_text: 'x' }, 'workspace');
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('未找到匹配');
      expect(String(r.result)).toContain('ghost text');
    });
    it('反例：多匹配报错带计数（"2 处"——宁拒不猜,补上下文重试）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('write', { path: 'doc.md', content: 'dup X dup' }, 'workspace');
      const r = await p.execute('edit_file', { path: 'doc.md', old_text: 'dup', new_text: 'one' }, 'workspace');
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('2 处');
    });
    it('反例：old_text 空串拒（空串匹配无意义）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('write', { path: 'doc.md', content: 'abc' }, 'workspace');
      const r = await p.execute('edit_file', { path: 'doc.md', old_text: '', new_text: 'x' }, 'workspace');
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('old_text 不可为空');
    });
    it('正例：new_text 空串 = 删除 old_text 那一段', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('write', { path: 'doc.md', content: 'keep-DELETE-keep' }, 'workspace');
      const r = await p.execute('edit_file', { path: 'doc.md', old_text: '-DELETE-', new_text: '' }, 'workspace');
      expect(r.success).toBe(true);
      expect((await p.execute('read', { path: 'doc.md' })).result).toBe('keepkeep');
    });
    it('反例：目标文件不存在报错不静默（编辑语义预设文件在场,与 write 有意不同）', async () => {
      const r = await makeProvider().execute('edit_file', { path: 'ghost.md', old_text: 'a', new_text: 'b' }, 'workspace');
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('文件不存在');
    });
    it('正例：new_text 含 $& 时字面落盘（锁 offset 切片语义——String.replace 形态会把 $& 解释成匹配串）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('write', { path: 'doc.md', content: 'hello world' }, 'workspace');
      const r = await p.execute('edit_file', { path: 'doc.md', old_text: 'world', new_text: '$& [$1]' }, 'workspace');
      expect(r.success).toBe(true);
      const back = await p.execute('read', { path: 'doc.md' });
      expect(back.result).toBe('hello $& [$1]');   // 字面替换——$& 不被解释成 "world"
    });
  });

  describe('mkdir（幂等）', () => {
    it('正例：含中间层一次建成，重复调用仍成功', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      expect((await p.execute('makedirs', { path: 'a/b/c' }, 'workspace')).success).toBe(true);
      expect((await p.execute('makedirs', { path: 'a/b/c' }, 'workspace')).success).toBe(true);
      expect((await p.execute('write', { path: 'a/b/c/f.txt', content: 'x' }, 'workspace')).success).toBe(true);
    });
  });

  describe('move（rename 原子性透传）', () => {
    it('正例：移动后源消失、目标可读', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('write', { path: 'src.txt', content: 'v' }, 'workspace');
      expect((await p.execute('move', { from: 'src.txt', to: 'dst.txt' }, 'workspace')).success).toBe(true);
      expect(JSON.parse(String((await p.execute('exists', { path: 'src.txt' })).result)).exists).toBe(false);
      expect((await p.execute('read', { path: 'dst.txt' })).result).toBe('v');
    });
    it('反例：源不存在显式失败', async () => {
      const r = await makeProvider().execute('move', { from: 'ghost.txt', to: 'dst.txt' }, 'workspace');
      expect(r.success).toBe(false);
    });
  });

  describe('remove', () => {
    it('正例：删除后 exists 为 false', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('write', { path: 'tmp.txt', content: 'x' }, 'workspace');
      expect((await p.execute('remove', { path: 'tmp.txt' }, 'workspace')).success).toBe(true);
      expect(JSON.parse(String((await p.execute('exists', { path: 'tmp.txt' })).result)).exists).toBe(false);
    });
    it('反例：目标不存在显式失败（不静默）', async () => {
      const r = await makeProvider().execute('remove', { path: 'ghost.txt' }, 'workspace');
      expect(r.success).toBe(false);
    });
  });

  describe('写侧沙箱边界（六件写工具通用）', () => {
    it('反例：.hopstate/ 全部写工具拒', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      mkdirSync(join(dir, '.hopstate'));
      const p = makeProvider(dir);
      for (const [tool, args] of [
        ['create', { path: '.hopstate/x', content: 'v' }],
        ['append', { path: '.hopstate/x', content: 'v' }],
        ['edit_file', { path: '.hopstate/x', old_text: 'a', new_text: 'b' }],   // @v: anc-exec-builtin-edit-file-tool
        ['makedirs', { path: '.hopstate/sub' }],
        ['remove', { path: '.hopstate/x' }],
        ['move', { from: '.hopstate/x', to: 'out.txt' }],
      ] as const) {
        const r = await p.execute(tool, args as Record<string, unknown>);
        expect(r.success, `${tool} 应拒 .hopstate/`).toBe(false);
        expect(String(r.result)).toContain('.hopstate');
      }
    });
    it('反例：路径穿越（..）与绝对路径全拒', async () => {
      const p = makeProvider();
      expect((await p.execute('makedirs', { path: '../escape' })).success).toBe(false);
      expect((await p.execute('create', { path: '/tmp/abs.txt', content: 'v' })).success).toBe(false);
      expect((await p.execute('edit_file', { path: '../escape.md', old_text: 'a', new_text: 'b' })).success).toBe(false);   // @v: anc-exec-builtin-edit-file-tool
    });
  });
});

// work_zone 涂鸦区豁免（2026-08-10 作者定 work_zone_path）：.hopstate 禁令的唯一豁免。
// @v: anc-exec-work-zone, anc-exec-work-zone-path
describe('work_zone 涂鸦区豁免', () => {
  it('正例：work_zone 绝对路径读写放行（.hopstate 内）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
    const wz = join(dir, '.hopstate', 'inst-1', 'work_zone');
    mkdirSync(wz, { recursive: true });
    const p = makeProvider(dir);
    const target = join(wz, 'draft.md');
    expect((await p.execute('write', { path: target, content: 'v' })).success).toBe(true);
    expect((await p.execute('read', { path: target })).result).toBe('v');
    expect((await p.execute('remove', { path: target })).success).toBe(true);
  });
  it('反例：.hopstate 非 work_zone 区仍拒；work_zone 伪装带 .. 仍拒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
    mkdirSync(join(dir, '.hopstate', 'inst-1'), { recursive: true });
    const p = makeProvider(dir);
    expect((await p.execute('write', { path: join(dir, '.hopstate', 'inst-1', 'state.json'), content: '{}' })).success).toBe(false);
    expect((await p.execute('write', { path: join(dir, '.hopstate', 'inst-1', 'work_zone', '..', 'state.json'), content: '{}' })).success).toBe(false);
  });
});

// 写侧分域（2026-08-28 作者定,契约 [[tools/file-tools#^anc-exec-builtin-file-tools]]）：act/check 语境
// （write_scope='work_zone',亦是缺省——信号缺席按窄域拒）写域仅 work_zone;commit 语境
// （'workspace'）才可写全域。触发实撞：fact-check 真机跑 act free 步把中间 yaml 写到
// workspace 根——free 步能 read 工作区一切,散落物会被后续步/并行兄弟读到（自污染）。
// @v: anc-exec-write-scope
describe('写侧分域（act 限 work_zone / commit 限 workspace）', () => {
  it('正例：act 语境（缺省窄域）写 work_zone 放行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
    const wz = join(dir, '.hopstate', 'inst-1', 'work_zone');
    mkdirSync(wz, { recursive: true });
    const p = makeProvider(dir);
    expect((await p.execute('write', { path: join(wz, 'mid.yaml'), content: 'k: v' })).success).toBe(true);
  });
  it('反例：act 语境写 workspace 根拒 WORK_ZONE_ONLY（write/append/create/makedirs/move/remove 全写侧）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
    const p = makeProvider(dir);
    const r = await p.execute('write', { path: 'stray.yaml', content: 'x' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('WORK_ZONE_ONLY');
    expect((await p.execute('append', { path: 'stray.log', content: 'x' })).success).toBe(false);
    expect((await p.execute('create', { path: 'stray.lock', content: 'x' })).success).toBe(false);
    expect((await p.execute('makedirs', { path: 'straydir' })).success).toBe(false);
    // move：目标在 work_zone 内、源在 workspace——源侧越界也拒（两路径都过校验）
    await p.execute('write', { path: 'src.txt', content: 'v' }, 'workspace');
    const wz = join(dir, '.hopstate', 'inst-1', 'work_zone');
    mkdirSync(wz, { recursive: true });
    expect((await p.execute('move', { from: 'src.txt', to: join(wz, 'dst.txt') })).success).toBe(false);
    expect((await p.execute('remove', { path: 'src.txt' })).success).toBe(false);
  });
  it('正例：commit 语境（workspace）写 workspace 根放行,.hopstate 仍拒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
    mkdirSync(join(dir, '.hopstate'), { recursive: true });
    const p = makeProvider(dir);
    expect((await p.execute('write', { path: 'deliver.md', content: 'final' }, 'workspace')).success).toBe(true);
    expect((await p.execute('write', { path: '.hopstate/hack.json', content: '{}' }, 'workspace')).success).toBe(false);
  });
});

// @v: anc-exec-builtin-validate-tool — 内置 validate_spec：纯函数,与 CLI 同一实现,正反例全谱
describe('validate_spec built-in tool', () => {
  const FULL_OK = `# T
Goal: g
## Steps
1. [reason] r
  + → x: bool  # f
  > think
`;
  const FRAG = `1. [reason] 判
  - ← upstream_item
  + → verdict: bool  # 判定
  > 判断
`;

  it('whole-spec mode: valid spec → ok', () => {
    const r = executeValidateSpec({ text: FULL_OK });
    expect(r.success).toBe(true);
    const j = JSON.parse(r.result as string);
    expect(j.status).toBe('ok');
    expect(j.errors).toEqual([]);
  });

  it('fragment mode with known_vars → ok', () => {
    const r = executeValidateSpec({ text: FRAG, fragment: true, known_vars: ['upstream_item'] });
    const j = JSON.parse(r.result as string);
    expect(j.status).toBe('ok');
  });

  it('fragment mode without known_vars → V1 error surfaced', () => {
    const r = executeValidateSpec({ text: FRAG, fragment: true });
    const j = JSON.parse(r.result as string);
    expect(j.status).toBe('error');
    expect(j.errors.some((e: { rule?: string }) => e.rule === 'V1')).toBe(true);
  });

  it('whole-spec mode rejects bare fragment as parse error (same as CLI)', () => {
    const r = executeValidateSpec({ text: FRAG });
    const j = JSON.parse(r.result as string);
    expect(j.status).toBe('error');
    expect(j.errors.some((e: { message: string }) => e.message.includes('Missing spec title'))).toBe(true);
  });

  it('rejects non-string text / non-bool fragment / non-array known_vars (no swallow)', () => {
    expect(executeValidateSpec({ text: 42 }).success).toBe(false);
    expect(executeValidateSpec({ text: 'x', fragment: 'yes' }).success).toBe(false);
    expect(executeValidateSpec({ text: 'x', fragment: true, known_vars: 'a,b' }).success).toBe(false);
  });

  it('is exposed via DefaultToolProvider.list and dispatch', async () => {
    const provider = makeProvider();
    expect(provider.list().some(t => t.name === 'validate_spec')).toBe(true);
    const r = await provider.execute('validate_spec', { text: FULL_OK });
    expect(JSON.parse(r.result as string).status).toBe('ok');
  });
});

// 树编辑函数组（2026-08-19 作者立项:维护骨干与完整 spec 序号一致性——增量展开的编号维护
// 原靠 LLM 手工换算,手滑即树错位）
// @v: anc-exec-builtin-edit-tree-tool
// read_spec_tree（D45,作者立项"需要有按章节读内容或者读骨干的功能"——树编辑函数组的
// 读面对偶:skeleton 骨干/node 子树两档,大 spec 不再整文灌 prompt）
// @v: anc-exec-builtin-read-tree-tool
describe('read_spec_tree built-in tool', () => {
  const S = `# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [subtask retry=2] 容器
  + → out: text  # o
  1.1. [act] 干活
    - ← x
    + → out: text  # o
    > 执行说明第一行
    > \`\`\`hop_python
    > out = "v"
    > \`\`\`
2. [exit]
`;

  it('正例：skeleton 档——结构行与 IO 声明在场,执行说明与 body 全部剔除（读骨干,体量正比步数）', () => {
    const r = JSON.parse(executeReadSpecTree({ spec_text: S, mode: 'skeleton' }).result as string);
    expect(r.status).toBe('ok');
    expect(r.text).toContain('1.1. [act] 干活');
    expect(r.text).toContain('+ → out: text');       // IO 声明在
    expect(r.text).not.toContain('执行说明');          // > 行剔除
    expect(r.text).not.toContain('hop_python');       // body 剔除
  });

  it('正例：node 档——指定步骤子树全文含 body（按需下钻,不带兄弟不带全文）', () => {
    const r = JSON.parse(executeReadSpecTree({ spec_text: S, mode: 'node', node_path: '1.1' }).result as string);
    expect(r.status).toBe('ok');
    expect(r.text).toContain('hop_python');           // 子树全文含 body
    expect(r.text).not.toContain('[subtask');         // 不带父容器
    expect(r.text).not.toContain('[exit]');           // 不带兄弟
  });

  it('正例：spec_is_fragment 裸片段同样可读', () => {
    const frag = '1. [reason] 甲\n  + → a: text  # pa\n  > 说明\n2. [act] 乙\n  - ← a\n  + → b: text  # pb\n';
    const r = JSON.parse(executeReadSpecTree({ spec_text: frag, mode: 'skeleton', spec_is_fragment: true }).result as string);
    expect(r.status).toBe('ok');
    expect(r.text).toContain('[reason] 甲');
    expect(r.text).not.toContain('说明');
  });

  it('反例：mode=node 且 node_path 悬空 → 结构化 NODE_NOT_FOUND 响亮拒（不静默空串）', () => {
    const out = executeReadSpecTree({ spec_text: S, mode: 'node', node_path: '9.9' });
    expect(out.success).toBe(false);
    const r = JSON.parse(out.result as string);
    expect(r.status).toBe('error');
    expect(r.errors[0].message).toContain('NODE_NOT_FOUND');
  });

  it('反例：坏 mode / 空 spec_text / parse 坏文本 → 结构化 error', () => {
    expect(JSON.parse(executeReadSpecTree({ spec_text: S, mode: 'outline' }).result as string).status).toBe('error');
    expect(JSON.parse(executeReadSpecTree({ spec_text: '', mode: 'skeleton' }).result as string).status).toBe('error');
    const bad = executeReadSpecTree({ spec_text: '# X\n## Steps\n1.1. [reason] 顶层裸深号\n', mode: 'skeleton' });
    expect(JSON.parse(bad.result as string).status).toBe('error');
  });
});

describe('树编辑函数组 built-in tools（原 edit_spec_tree,2026-08-30 函数化拆四件）', () => {
  const DRAFT = `# T
Id: t

## Goal
g

## Steps
1. [loop max=3] 遍历
  1.1. [reason] 待展开——判断
    + → flag: line  # f
2. [subtask] 汇总
  2.1. [act] 写清单
    + → out: text  # o
`;
  const FRAG = `1. [reason] 判断紧急
  - ← item
  + → flag: line  # f
2. [act] 记录
  - ← flag
  + → note: text  # n
`;

  it('正例：replace_children 替换占位并重编号（增量展开主操作）', () => {
    const r = executeReplaceChildren({ spec_text: DRAFT, node_path: '1', fragment: FRAG });
    expect(r.success).toBe(true);
    const j = JSON.parse(r.result as string);
    expect(j.status).toBe('ok');
    expect(j.spec_text).toContain('1.1. [reason] 判断紧急');
    expect(j.spec_text).toContain('1.2. [act] 记录');
    expect(j.spec_text).not.toContain('待展开');
    // renumber_map 只含真实旧树号——片段相对号经 __frag 临时键进树,已从映射剔除
    // (原断言 renumber_map['1']==='1.1' 把假旧号钉成特性,review D1 纠正:原树步 1 没动,
    //  '1' 键若在场会让 syncWorkItems 误改写指向它的队列项)
    expect(j.renumber_map['1']).toBeUndefined();
    expect(Object.keys(j.renumber_map).some(k => k.startsWith('__frag'))).toBe(false);
  });

  // @v: anc-exec-builtin-edit-tree-tool — insert_node 单原语（2026-08-30 作者纠偏对齐 D44 编辑代数:
  // 原 insert_before/insert_after 双操作,after 是 D44 裁定否掉的"add after"语义未经拍板复活;
  // insert 语义=node_path 写定落位序号,原位者及后继自动后移;插尾写末位号+1）。
  it('正例：insert_node 落位指定序号——原位者后移连锁重编号 + work_items 队列同步', () => {
    const r = executeInsertNode({
      spec_text: DRAFT, node_path: '2',
      fragment: '1. [check] 核验\n  - ← flag\n  + → ok: bool  # k\n  + → why: text  # w\n',
      work_items: ['root.2 | 汇总段展开 | light'],
    });
    const j = JSON.parse(r.result as string);
    expect(j.status).toBe('ok');
    expect(j.spec_text).toMatch(/2\. \[check\] 核验/);   // 新片段落在写定的 2 号位
    expect(j.renumber_map['2']).toBe('3');           // 原步骤 2 自动后移成 3
    expect(j.renumber_map['2.1']).toBe('3.1');       // 子树连锁
    expect(j.work_items).toEqual(['root.3 | 汇总段展开 | light']);   // 队列同步
  });

  it('正例：insert_node 落位号=末位号+1（唯一允许的越界位）→ 追加到该层末尾', () => {
    const r = executeInsertNode({
      spec_text: DRAFT, node_path: '3',
      fragment: '1. [check] 尾核\n  - ← flag\n  + → ok2: bool  # k\n  + → why2: text  # w\n',
    });
    const j = JSON.parse(r.result as string);
    expect(j.status).toBe('ok');
    expect(j.spec_text).toMatch(/3\. \[check\] 尾核/);   // 追加成第 3 步（顶层原 2 步,3=末位+1）
  });

  it('反例：insert_node 缺 node_path → 响亮拒（G5 补——review 抓无测试）', () => {
    const r = executeInsertNode({
      spec_text: DRAFT, fragment: '1. [check] 核\n  - ← flag\n  + → okx: bool  # k\n  + → whyx: text  # w\n',
    });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('node_path');
  });

  it('正例：insert_node 深层落位（2.1 位插入,原 2.1 后移成 2.2）（G5 补——原仅顶层被测）', () => {
    const r = executeInsertNode({
      spec_text: DRAFT, node_path: '2.1',
      fragment: '1. [check] 深核\n  - ← flag\n  + → okd: bool  # k\n  + → whyd: text  # w\n',
    });
    const j = JSON.parse(r.result as string);
    expect(j.status).toBe('ok');
    expect(j.spec_text).toMatch(/2\.1\. \[check\] 深核/);
    expect(j.renumber_map['2.1']).toBe('2.2');   // 原 2.1 后移
  });

  it('反例：insert_node 落位号越界且非末位+1 → 响亮拒（不猜位置）', () => {
    const r = executeInsertNode({
      spec_text: DRAFT, node_path: '9',
      fragment: '1. [check] 核\n  - ← flag\n  + → ok3: bool  # k\n  + → why3: text  # w\n',
    });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('末位号+1');
  });

  it('正例：renumber_only 修复错位草稿（无片段纯重刷）', () => {
    const skewed = DRAFT.replace('2. [subtask]', '5. [subtask]').replace('2.1. [act]', '5.1. [act]');
    const r = executeRenumberSteps({ spec_text: skewed, });
    const j = JSON.parse(r.result as string);
    expect(j.status).toBe('ok');
    expect(j.spec_text).toContain('2. [subtask] 汇总');
    expect(j.renumber_map['5']).toBe('2');
  });

  // replace_node 原位拼接替换（^anc-exec-builtin-edit-tree-tool——占位叶子语义:节点连行带子树
  // 消失片段接进原位;replace_children 会把脚手架行残留树里）// @v: anc-exec-builtin-edit-tree-tool
  it('正例：replace_node 占位行本体消失,片段原位接入并重编号', () => {
    const skeleton = `1. [act] 取数\n  + → xs: [yaml]  # 列表\n2. [reason] 待展开——分析\n  - ← xs\n  + → verdict: line  # v\n3. [act] 存档\n  - ← verdict\n  + → path: line  # p\n`;
    const r = executeReplaceNode({
      spec_text: skeleton, spec_is_fragment: true, node_path: '2',
      fragment: '1. [reason] 逐项分析\n  - ← xs\n  + → notes: text  # n\n2. [reason] 汇总裁定\n  - ← notes\n  + → verdict: line  # v\n',
    });
    expect(r.success).toBe(true);
    const j = JSON.parse(r.result as string);
    expect(j.spec_text).not.toContain('待展开');                  // 占位行本体消失
    expect(j.spec_text).toContain('2. [reason] 逐项分析');        // 片段接进原位
    expect(j.spec_text).toContain('3. [reason] 汇总裁定');        // 双步展开连锁重编号
    expect(j.spec_text).toContain('4. [act] 存档');               // 后继让位
    expect(j.renumber_map['3']).toBe('4');
  });

  it('正例：replace_node 批量 replacements——全部按调用前号定位,末次统一重编号（首片段 3 步,树内真出现新号 3 与后续目标撞——两阶段解引用的实证场景,review D7 强化）', () => {
    const skeleton = `1. [reason] 待展开——甲\n  + → a: text  # a\n2. [act] 中转\n  - ← a\n  + → m: text  # m\n3. [reason] 待展开——乙\n  - ← m\n  + → b: text  # b\n`;
    const r = executeReplaceNode({
      spec_text: skeleton, spec_is_fragment: true, replacements: [
        { node_path: '1', fragment: '1. [act] 甲一\n  + → raw: text  # r\n2. [reason] 甲二\n  - ← raw\n  + → mid: text  # d\n3. [reason] 甲三\n  - ← mid\n  + → a: text  # a\n' },
        { node_path: '3', fragment: '1. [reason] 乙\n  - ← m\n  + → b: text  # b\n' },
      ],
    });
    expect(r.success).toBe(true);
    const j = JSON.parse(r.result as string);
    expect(j.spec_text).not.toContain('待展开');
    expect(j.spec_text).toContain('1. [act] 甲一');
    expect(j.spec_text).toContain('3. [reason] 甲三');   // 先拼入片段第 3 步真实占号 3
    expect(j.spec_text).toContain('4. [act] 中转');       // 原步 2 让位到 4
    expect(j.spec_text).toContain('5. [reason] 乙');      // 目标 '3'(原乙占位)按调用前号命中——边拼边查的坏实现会把片段"甲三"错当目标(review 变异4实证静默吞步)
    expect(j.spec_text).not.toMatch(/待展开——乙/);
  });

  it('正例：insert_node work_items 指向未移动步骤的队列项不被误改写（review D1 正钉——renumber_map 无假旧号键）', () => {
    // 树 [1,2,3] 顶层,插到 2:原步 1 不动;修前 renumber_map 里冒出片段假旧号 "1":"2",
    // syncWorkItems 会把指向原步 1 的队列项误写成指向新插入的步 2
    const skel = '1. [act] 甲\n  + → a: text  # a\n2. [act] 乙\n  - ← a\n  + → b: text  # b\n3. [act] 丙\n  - ← b\n  + → c: text  # c\n';
    const r = executeInsertNode({
      spec_text: skel, spec_is_fragment: true, node_path: '2',
      fragment: '1. [act] 新\n  - ← a\n  + → n: text  # n\n',
      work_items: ['1 | 甲的活 | 1'],
    });
    expect(r.success).toBe(true);
    const j = JSON.parse(r.result as string);
    expect(j.renumber_map['1']).toBeUndefined();            // 原步 1 没动,映射不得有 '1' 键
    expect(j.renumber_map['2']).toBe('3');                  // 真实移动的照记
    expect(j.work_items).toEqual(['1 | 甲的活 | 1']);        // 指向未移步骤的队列项原样
  });

  it('正例：replace_children node_path=root 替换整个 Steps（review D3 补——变异实证此前零保护）', () => {
    const skel = '1. [act] 旧甲\n  + → a: text  # a\n2. [act] 旧乙\n  - ← a\n  + → b: text  # b\n';
    const r = executeReplaceChildren({
      spec_text: skel, spec_is_fragment: true, node_path: 'root',
      fragment: '1. [act] 新一\n  + → x: text  # x\n2. [act] 新二\n  - ← x\n  + → y: text  # y\n3. [act] 新三\n  - ← y\n  + → z: text  # z\n',
    });
    expect(r.success).toBe(true);
    const j = JSON.parse(r.result as string);
    expect(j.spec_text).not.toContain('旧甲');
    expect(j.spec_text).not.toContain('旧乙');
    expect(j.spec_text).toContain('1. [act] 新一');
    expect(j.spec_text).toContain('3. [act] 新三');
  });

  it('正例：insert_node 嵌套层末位+1 追加（契约"2.4"例——review G2 补,parentPath 分支此前零覆盖）', () => {
    const skel = '1. [act] 甲\n  + → a: text  # a\n2. [subtask retry=2] 乙\n  + → b: text  # b\n  2.1. [act] 子一\n    + → s1: text  # s\n  2.2. [act] 子二\n    - ← s1\n    + → b: text  # b\n';
    const r = executeInsertNode({
      spec_text: skel, spec_is_fragment: true, node_path: '2.3',
      fragment: '1. [act] 子三\n  - ← b\n  + → s3: text  # s\n',
    });
    expect(r.success).toBe(true);
    const j = JSON.parse(r.result as string);
    expect(j.spec_text).toContain('2.3. [act] 子三');
  });

  it('正例：syncWorkItems 裸步骤号首段形态照映射改写（review G1 补——变异实证此前零保护）', () => {
    const skel = '1. [act] 甲\n  + → a: text  # a\n2. [act] 乙\n  - ← a\n  + → b: text  # b\n';
    const r = executeInsertNode({
      spec_text: skel, spec_is_fragment: true, node_path: '1',
      fragment: '1. [act] 新\n  + → n: text  # n\n',
      work_items: ['2 | 乙的活 | 3'],   // 裸步骤号首段(非 root. 前缀)
    });
    expect(r.success).toBe(true);
    const j = JSON.parse(r.result as string);
    expect(j.work_items).toEqual(['3 | 乙的活 | 3']);   // 原步 2 → 3,裸号形态照改
  });

  it('反例：replacements 在场时单项 node_path/fragment 被忽略（契约明文——review G4 补）', () => {
    const skel = '1. [reason] 待展开——甲\n  + → a: text  # a\n2. [act] 乙\n  - ← a\n  + → b: text  # b\n';
    const r = executeReplaceNode({
      spec_text: skel, spec_is_fragment: true,
      node_path: '2',                                         // 单项指乙——应被忽略
      fragment: '1. [act] 不该出现\n  + → x: text  # x\n',
      replacements: [{ node_path: '1', fragment: '1. [act] 甲新\n  + → a: text  # a\n' }],
    });
    expect(r.success).toBe(true);
    const j = JSON.parse(r.result as string);
    expect(j.spec_text).toContain('甲新');
    expect(j.spec_text).not.toContain('不该出现');            // 单项被忽略未执行
    expect(j.spec_text).toContain('2. [act] 乙');             // 乙未被替换
  });

  it('反例：replacements 嵌套目标（父先替换子已离树）响亮拒不裸崩', () => {
    const skel = '1. [act] 甲\n  + → a: text  # a\n2. [subtask retry=2] 乙\n  + → b: text  # b\n  2.1. [reason] 待展开——丙\n    + → c: text  # c\n';
    const r = executeReplaceNode({
      spec_text: skel, spec_is_fragment: true, replacements: [
        { node_path: '2', fragment: '1. [act] 乙新\n  + → b: text  # b\n' },
        { node_path: '2.1', fragment: '1. [act] 丙新\n  + → c: text  # c\n' },
      ],
    });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('嵌套');   // 主动双向判定(review D2)——不再依赖"外层先执行内层离树"的次序文案
  });

  it('反例：replacements 嵌套目标反序（[内,外] 次序）同样响亮拒——不靠执行次序巧合（review D2 双向钉）', () => {
    const skel = '1. [act] 甲\n  + → a: text  # a\n2. [subtask retry=2] 乙\n  + → b: text  # b\n  2.1. [reason] 待展开——丙\n    + → c: text  # c\n';
    const r = executeReplaceNode({
      spec_text: skel, spec_is_fragment: true, replacements: [
        { node_path: '2.1', fragment: '1. [act] 丙新\n  + → c: text  # c\n' },
        { node_path: '2', fragment: '1. [act] 乙新\n  + → b: text  # b\n' },
      ],
    });
    // 修前实证:此次序返回 ok,内层(2.1)编辑成果被外层(2)替换静默吞掉
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('嵌套');
  });

  it('反例：replacements 重复目标响亮拒不裸崩', () => {
    const skel = '1. [reason] 待展开——甲\n  + → a: text  # a\n';
    const r = executeReplaceNode({
      spec_text: skel, spec_is_fragment: true, replacements: [
        { node_path: '1', fragment: '1. [act] 甲一\n  + → a: text  # a\n' },
        { node_path: '1', fragment: '1. [act] 甲二\n  + → x: text  # x\n' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('反例：replace_node 目标不存在响亮拒', () => {
    const r = executeReplaceNode({ spec_text: '1. [act] 甲\n  + → a: text  # a\n', spec_is_fragment: true, node_path: '9', fragment: '1. [act] 乙\n  + → b: text  # b\n' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('不存在');
  });

  it('反例：replace_children 不收 replacements——缺 node_path/fragment 照拒（四工具各管各参数,配错工具即缺参）', () => {
    const r = executeReplaceChildren({ spec_text: DRAFT, replacements: [{ node_path: '1', fragment: '1. [act] 甲\n  + → a: text  # a' }] });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('replace_children');
  });

  // spec_is_fragment 片段对片段模式（^anc-exec-builtin-edit-tree-tool——hopbuild2 拼装步:
  // 编辑对象是裸骨架片段,强求全文=逼 LLM 包壳去壳）// @v: anc-exec-builtin-edit-tree-tool
  it('正例：spec_is_fragment 裸片段进出（替换占位,输出无 # 头无 ## Steps）', () => {
    const skeleton = `1. [act] 取数\n  + → xs: [yaml]  # 列表\n2. [reason] 待展开——分析\n  - ← xs\n  + → verdict: line  # v\n`;
    const r = executeReplaceChildren({
      spec_text: skeleton, spec_is_fragment: true, node_path: '2',
      fragment: '1. [reason] 逐项分析\n  - ← xs\n  + → verdict: line  # v\n',
    });
    expect(r.success).toBe(true);
    const j = JSON.parse(r.result as string);
    expect(j.status).toBe('ok');
    expect(j.spec_text.startsWith('1. [act] 取数')).toBe(true);   // 裸片段直出,首字符即步骤号
    expect(j.spec_text).toContain('2.1. [reason] 逐项分析');
    // 无标题头无节标题（行首 # 才是标题——行内 `# 说明` 注释不算）
    expect(j.spec_text.split('\n').some((l: string) => l.startsWith('#'))).toBe(false);
  });

  // 行级手术契约钉（hopissues/0048 方案 A——编辑落原文行数组,弃 serialize 全文重建;
  // 设计 [[tools/spec-tree-tools#^anc-exec-tree-edit-line-surgery]] 契约四条与正反例）
  // @v: anc-exec-tree-edit-line-surgery
  describe('行级手术（hopissues/0048——原文字节保全）', () => {
    // 四类载体齐备的全文 spec：%% 块 / HTML 注释锚 / 声明续行注释 / 行式 Goal 头
    const LOSSY_CARRIERS = `%% @trace
	id: carrier-test
	note: 头块整块——重建病第一类载体
%%
# Spec: 载体保全
Id: carrier

Goal: 行式头形态——重建病第四类载体（旧形态会被改写成节式标题）

## Inputs
- a: line  # 首行注释
  # 续行注释——第三类载体

## Steps
1. [act] 步一
  <!-- @a: anc-carrier-html -->
  - ← a
  + → b: line = ""  # 累加器首行
                    # 累加器续行——第三类载体
  > 说明行
2. [act] 步二
  - ← b
  + → c: line  # c

## 背景
任务卡叙事节——尾部钳位对象,编辑末步不得把本节搬走。
`;

    it('正例：无错位 spec 干跑 renumber_steps 逐字节幂等（契约的机检形态）', () => {
      const r = executeRenumberSteps({ spec_text: LOSSY_CARRIERS });
      expect(r.success).toBe(true);
      const j = JSON.parse(r.result as string);
      expect(j.status).toBe('ok');
      expect(j.spec_text).toBe(LOSSY_CARRIERS);   // 逐字节相同,不是"语义等价"
      expect(j.renumber_map).toEqual({});
    });

    it('正例：insert_node 后四类载体全存活,且只有目标位后的步骤行编号变了', () => {
      const r = executeInsertNode({ spec_text: LOSSY_CARRIERS, node_path: '2',
        fragment: '1. [act] 插入步\n  - ← b\n  + → d: line  # d\n' });
      expect(r.success).toBe(true);
      const j = JSON.parse(r.result as string);
      expect(j.status).toBe('ok');
      // 四类载体逐一在场
      expect(j.spec_text).toContain('%% @trace');
      expect(j.spec_text).toContain('重建病第一类载体');
      expect(j.spec_text).toContain('<!-- @a: anc-carrier-html -->');
      expect(j.spec_text).toContain('# 续行注释——第三类载体');
      expect(j.spec_text).toContain('# 累加器续行——第三类载体');
      expect(j.spec_text).toContain('Goal: 行式头形态');          // 行式未被改写节式
      expect(j.spec_text).not.toContain('## Goal');
      // 编辑本身正确：插入步占 2 号,原步二顶成 3
      expect(j.spec_text).toContain('2. [act] 插入步');
      expect(j.spec_text).toContain('3. [act] 步二');
      expect(j.renumber_map).toEqual({ '2': '3' });
    });

    it('正例：replace_node 末步——尾部叙事节不随步消失（钳位条款）', () => {
      const r = executeReplaceNode({ spec_text: LOSSY_CARRIERS, node_path: '2',
        fragment: '1. [act] 换血步\n  - ← b\n  + → c: line  # c2\n' });
      expect(r.success).toBe(true);
      const j = JSON.parse(r.result as string);
      expect(j.status).toBe('ok');
      expect(j.spec_text).toContain('## 背景');                  // 叙事节还在
      expect(j.spec_text).toContain('编辑末步不得把本节搬走');
      expect(j.spec_text).toContain('2. [act] 换血步');
      expect(j.spec_text).not.toContain('步二');                  // 被替换步真离场
    });

    it('正例：片段带自有注释与缩进,按原文字节进树只改编号 token', () => {
      const r = executeInsertNode({ spec_text: LOSSY_CARRIERS, node_path: '1',
        fragment: '1. [act] 新首步\n  <!-- 片段自带注释 -->\n  + → z: line = ""  # 片段累加器\n       # 片段续行注释\n' });
      expect(r.success).toBe(true);
      const j = JSON.parse(r.result as string);
      expect(j.spec_text).toContain('1. [act] 新首步');
      expect(j.spec_text).toContain('<!-- 片段自带注释 -->');
      expect(j.spec_text).toContain('# 片段续行注释');
      expect(j.spec_text).toContain('2. [act] 步一');            // 原首步顶为 2
      expect(j.renumber_map).toEqual({ '1': '2', '2': '3' });
    });

    it('正例：标题风步骤行编号改写保 # 前缀与行内字节（`### N.` 形态）', () => {
      const heading = `# Spec: 标题风
Id: h

## Steps
### 1. [act] 甲步
  + → a: text  # a

正文段落归甲步吸收。

### 2. [act] 乙步
  - ← a
  + → b: text  # b
`;
      const r = executeInsertNode({ spec_text: heading, node_path: '2',
        fragment: '1. [act] 插队\n  - ← a\n  + → m: text  # m\n' });
      expect(r.success).toBe(true);
      const j = JSON.parse(r.result as string);
      expect(j.status).toBe('ok');
      expect(j.spec_text).toContain('### 1. [act] 甲步');        // # 前缀保留
      expect(j.spec_text).toContain('### 3. [act] 乙步');        // 只改编号 token
      expect(j.spec_text).toContain('正文段落归甲步吸收。');       // 吸收段落随步保留
    });

    it('正例：带前导空格的尾部叙事节标题同被钳住（review D5 重放钉——节头判据原用 raw 行,与 parser 的 trim 后判不同构,缩进的 ## 背景 钳不住随末步编辑被搬走）', () => {
      const INDENTED_TAIL = LOSSY_CARRIERS.replace('## 背景', '  ## 背景');
      const r = executeReplaceNode({ spec_text: INDENTED_TAIL, node_path: '2',
        fragment: '1. [act] 换血步\n  - ← b\n  + → c: line  # c2\n' });
      expect(r.success).toBe(true);
      const j = JSON.parse(r.result as string);
      expect(j.spec_text).toContain('  ## 背景');                  // 缩进标题原样在场
      expect(j.spec_text).toContain('编辑末步不得把本节搬走');       // 叙事节内容未随替换消失
    });

    it('正例：末步含围栏内 ## 行不误认节头（变异 D 重放钉——围栏感知契约明文,原零夹具:删掉围栏翻转 95 例全绿）', () => {
      const FENCED_LAST = `# Spec: 围栏
Id: fence

## Steps
1. [act] 步一
  + → a: text  # a
2. [act] 末步带围栏
  - ← a
  + → b: text  # b
  > 说明:
  \`\`\`
  ## 这行在围栏里,是内容不是节头
  \`\`\`

## 背景
围栏后的真叙事节。
`;
      // 干跑幂等测不出钳位错位(边界钳在哪,前缀+段+后缀拼回去都是原文)——必须真编辑末步:
      // 围栏内 ## 若被误认节头,末步区间被截短,围栏 ## 起的半截步体被错当后缀保留,
      // 替换后残留孤儿内容;围栏感知正确时整步(含围栏)随替换消失,真叙事节独存。
      const r = executeReplaceNode({ spec_text: FENCED_LAST, node_path: '2',
        fragment: '1. [act] 换血\n  - ← a\n  + → b: text  # b2\n' });
      expect(r.success).toBe(true);
      const j = JSON.parse(r.result as string);
      expect(j.spec_text).toContain('2. [act] 换血');              // 替换真发生
      expect(j.spec_text).not.toContain('这行在围栏里');            // 旧步体(含围栏)整体消失,无孤儿残留
      expect(j.spec_text).toContain('## 背景');                    // 真叙事节被钳位保住
      expect(j.spec_text).toContain('围栏后的真叙事节');
    });

    it('反例守卫：全文模式输出不经 serializeSpec（重建病防复发——%% 块在 serialize 面外,在场即证）', () => {
      // renumber 干跑逐字节幂等已钉正面;此例从反面钉:serializeSpec 对同一输入必然丢 %% 块,
      // 两者输出不同即证产出通道不是 serialize
      const r = executeRenumberSteps({ spec_text: LOSSY_CARRIERS });
      const j = JSON.parse(r.result as string);
      expect(j.spec_text).toContain('%%');
    });
  });

  it('正例：spec_is_fragment 幂等往返（renumber_only 进出同形）', () => {
    const frag = `1. [act] 甲\n  + → a: text  # x\n2. [act] 乙\n  - ← a\n  + → b: text  # y\n`;
    const r = executeRenumberSteps({ spec_text: frag, spec_is_fragment: true, });
    const j = JSON.parse(r.result as string);
    expect(j.status).toBe('ok');
    expect(j.spec_text).toBe(frag);
  });

  it('反例：spec_is_fragment 输入无可解析步骤行,parse error 响亮拒', () => {
    const r = executeRenumberSteps({ spec_text: '这是一段散文,没有步骤行', spec_is_fragment: true, });
    expect(r.success).toBe(false);
  });

  it('反例：spec_is_fragment 非布尔拒', () => {
    const r = executeRenumberSteps({ spec_text: 'x', spec_is_fragment: 'yes', });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('spec_is_fragment');
  });

  it('反例：node_path 不存在响亮拒（不静默空操作）', () => {
    const r = executeReplaceChildren({ spec_text: DRAFT, node_path: '9.9', fragment: FRAG });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('不存在');
  });

  it('反例：片段 parse error 原样返回不编辑', () => {
    const r = executeReplaceChildren({ spec_text: DRAFT, node_path: '1', fragment: '这不是步骤' });
    expect(r.success).toBe(false);
    // "不编辑"半边(review G5 补):失败返回不携带任何编辑产物——纯函数入参 DRAFT 自然未动,
    // 这里钉的是返回面不给出半成品 spec_text
    const parsed = JSON.parse(String(r.result));
    expect(parsed.spec_text).toBeUndefined();
  });

  it('反例：缺 fragment 的编辑操作拒（renumber_only 除外）', () => {
    const r = executeInsertNode({ spec_text: DRAFT, node_path: '1' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('fragment');
  });

  // deleteNodeAt 核心函数直接单元测试（review G3 补——D44 第四原子,工具面不暴露:
  // replan 通道上游 parseReplanEdits 前置校验把悬空引用挡光,拒收路径全库不可达;
  // 核心层是公开出口(设计出口表已列),replan 现役依赖,直测正反例）
  // @v: anc-exec-builtin-edit-tree-tool
  it('正例：deleteNodeAt 节点连行带子树移除,后继经 renumberSteps 归位', () => {
    const { ast } = parseFragForCore('1. [act] 甲\n  + → a: text  # a\n2. [subtask retry=2] 乙\n  + → b: text  # b\n  2.1. [act] 子\n    + → s: text  # s\n3. [act] 丙\n  - ← a\n  + → c: text  # c\n');
    const steps = ast.steps as StepNode[];
    const r = deleteNodeAt(steps, '2');
    expect(r.ok).toBe(true);
    coreRenumberSteps(steps);
    expect(steps.length).toBe(2);
    expect(steps.map(n => n.step_id)).toEqual(['1', '2']);   // 丙归位为 2,子树连带消失
  });

  it('正例：replaceNodeAt 核心层两阶段解引用——裸片段(未打临时号)真实占号后,后续目标仍按调用前对象命中（review D7 核心层钉:边拼边查的坏实现会把先拼入的同号片段步错当目标）', () => {
    // 直调核心函数,片段不打 __frag 临时号——先替换目标 1 的片段含第 3 步,树内真出现新号 3;
    // 坍缩为"按 nodePath 现场重定位"的实现会把它错当后续目标 '3'
    const { ast } = parseFragForCore('1. [reason] 待甲\n  + → a: text  # a\n2. [act] 中转\n  - ← a\n  + → m: text  # m\n3. [reason] 待乙\n  - ← m\n  + → b: text  # b\n');
    const steps = ast.steps as StepNode[];
    const frag1 = parseFragForCore('1. [act] 甲一\n  + → r: text  # r\n2. [act] 甲二\n  - ← r\n  + → d: text  # d\n3. [act] 甲三\n  - ← d\n  + → a: text  # a\n').ast.steps as StepNode[];
    const frag2 = parseFragForCore('1. [reason] 乙\n  - ← m\n  + → b: text  # b\n').ast.steps as StepNode[];
    const r = coreReplaceNodeAt(steps, [
      { nodePath: '1', fragSteps: frag1 },
      { nodePath: '3', fragSteps: frag2 },
    ]);
    expect(r.ok).toBe(true);
    coreRenumberSteps(steps);
    const summaries = steps.map(n => (n as unknown as { summary: string }).summary);
    expect(summaries).toEqual(['甲一', '甲二', '甲三', '中转', '乙']);   // '待乙'被换成'乙';坏实现会把'甲三'换掉、'待乙'残留
  });

  it('正例：syncWorkItems 首段=root 形态原样保留不改写（review 复验补——root 不是步骤号,不受重编号波及）', () => {
    const skel = '1. [act] 甲\n  + → a: text  # a\n2. [act] 乙\n  - ← a\n  + → b: text  # b\n';
    const r = executeInsertNode({
      spec_text: skel, spec_is_fragment: true, node_path: '1',
      fragment: '1. [act] 新\n  + → n: text  # n\n',
      work_items: ['root | 整树的活 | 1'],
    });
    expect(r.success).toBe(true);
    const j = JSON.parse(r.result as string);
    expect(j.work_items).toEqual(['root | 整树的活 | 1']);   // root 首段原样
  });

  it('反例：insert_node 落位到无子步骤的叶子子层 → 响亮拒（review 复验补——父无 children 的拒收半边）', () => {
    const skel = '1. [act] 甲\n  + → a: text  # a\n2. [act] 乙\n  - ← a\n  + → b: text  # b\n';
    const r = executeInsertNode({
      spec_text: skel, spec_is_fragment: true, node_path: '1.5',
      fragment: '1. [act] 新\n  + → n: text  # n\n',
    });
    // 步骤 1 是叶子(无 children),1.5 既非现存号也非'末位+1'(子层空,合法追加位只有 1.1)
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('不存在');
  });

  it('反例：deleteNodeAt node_path 不存在响亮拒（工具面不可达,核心层直测）', () => {
    const { ast } = parseFragForCore('1. [act] 甲\n  + → a: text  # a\n');
    const r = deleteNodeAt(ast.steps as StepNode[], '9.9');
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('不存在');
  });

  it('Provider 注册在场（树编辑四件）', async () => {
    const provider = makeProvider();
    for (const n of ['insert_node', 'replace_node', 'replace_children', 'renumber_steps']) expect(provider.list().some(t => t.name === n)).toBe(true);
    const r = await provider.execute('renumber_steps', { spec_text: DRAFT });
    expect(JSON.parse(r.result as string).status).toBe('ok');
  });
});

// @v: anc-exec-work-zone —— work_zone 判定覆盖子实例三段路径（2026-08-30 审计实抓 [^/]+ 单段
// 误拒 standalone 子实例写自身 work_zone;变异实证:改回单段正则下方三段正例必红）
describe('isWorkZonePath 注册根前缀支(0066——自定义 state-dir 名)', () => {
  // @v: anc-exec-work-zone
  it('正:注册自定义根后,该根下路径判 true(state-dir 不含 .hopstate 字面——hopkb runtime/hopstate 实撞形态)', () => {
    registerWorkZoneRoot('/Users/x/.hopkb/runtime/hopstate/9d203b30/work_zone');
    expect(isWorkZonePath('/Users/x/.hopkb/runtime/hopstate/9d203b30/work_zone/findings')).toBe(true);
    expect(isWorkZonePath('/Users/x/.hopkb/runtime/hopstate/9d203b30/work_zone')).toBe(true);
  });
  it('反:未注册的裸自定义路径照拒(注册面不放大到任意绝对路径)', () => {
    expect(isWorkZonePath('/Users/x/.hopkb/runtime/hopstate/other-run/work_zone/y')).toBe(false);
    expect(isWorkZonePath('/Users/x/somewhere/else.txt')).toBe(false);
  });
  it('反:注册根的前缀串不误中(root+"/"边界——/a/work_zone 注册后 /a/work_zonefake 不放行)', () => {
    registerWorkZoneRoot('/tmp/t0066/a/work_zone');
    expect(isWorkZonePath('/tmp/t0066/a/work_zonefake/x')).toBe(false);
  });
});

describe('isWorkZonePath 子实例路径形态', () => {
  it('正例：顶层/parallel 子实例/call 子实例三形态全放行', () => {
    expect(isWorkZonePath('.hopstate/abc-123/work_zone/out.json')).toBe(true);
    expect(isWorkZonePath('.hopstate/abc-123/parallel/5.2.1.14/work_zone/vars/batch.json')).toBe(true);
    expect(isWorkZonePath('.hopstate/abc-123/calls/3.1/work_zone/x.txt')).toBe(true);
  });
  it('正例：MemoryPersistence tmpdir 形态 hopjit-workzone-* 放行（判定第二支——2026-08-30 review 抓设计判据漏此支后补钉）', () => {
    expect(isWorkZonePath('/var/tmp/hopjit-workzone-ab12/x.json')).toBe(true);
  });
  it('反例：仓库正式区/伪装名/裸 .hopstate 状态区/伪装前缀目录仍拒', () => {
    expect(isWorkZonePath('src/engine.ts')).toBe(false);
    expect(isWorkZonePath('.hopstate/abc/work_zone_fake/x')).toBe(false);
    expect(isWorkZonePath('.hopstate/abc/state.json')).toBe(false);
    // 左端锚定（2026-08-30 review 抓旧病:不锚定时 myapp.hopstate 伪装前缀可豁免）
    expect(isWorkZonePath('myapp.hopstate/abc/work_zone/x')).toBe(false);
  });
});


// 钉钉通知工具模块（^anc-tool-dingtalk-notify——todo/0052 正式形态;真发送归真机 probe 不进 vitest,
// 可测面=报文拼装与失败值,fetch 打桩零网络）
// @v: anc-tool-dingtalk-notify, anc-tool-dingtalk-sop
describe('NotifyToolProvider 钉钉通知', () => {
  const FAKE_HOOK = 'https://oapi.dingtalk.com/robot/send?access_token=deadbeef01';
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;
  const origFetch = globalThis.fetch;
  const origWebhook = process.env.DINGTALK_WEBHOOK;
  const origSecret = process.env.DINGTALK_SECRET;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return { status: 200, json: async () => ({ errcode: 0 }) } as Response;
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origWebhook === undefined) delete process.env.DINGTALK_WEBHOOK; else process.env.DINGTALK_WEBHOOK = origWebhook;
    if (origSecret === undefined) delete process.env.DINGTALK_SECRET; else process.env.DINGTALK_SECRET = origSecret;
  });

  it('反例：DINGTALK_WEBHOOK 缺席 → success:false 带建法指引,零网络动作', async () => {
    delete process.env.DINGTALK_WEBHOOK;
    const r = await new NotifyToolProvider().execute('dingtalk_notify', { text: 'x' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('DINGTALK_WEBHOOK 未设置');
    expect(String(r.result)).toContain('自定义机器人');
    expect(fetchCalls).toHaveLength(0);
  });

  it('反例：text 空 → success:false 不发', async () => {
    process.env.DINGTALK_WEBHOOK = FAKE_HOOK;
    const r = await new NotifyToolProvider().execute('dingtalk_notify', { text: '  ' });
    expect(r.success).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it('正例：title+at_mobiles → markdown 分型+at 注入;无 secret 时 URL 不带签名', async () => {
    process.env.DINGTALK_WEBHOOK = FAKE_HOOK;
    delete process.env.DINGTALK_SECRET;
    const r = await new NotifyToolProvider().execute('dingtalk_notify', { text: '正文', title: '标题', at_mobiles: ['138000'] });
    expect(r.success).toBe(true);
    expect(JSON.parse(String(r.result))).toEqual({ sent: true, msgtype: 'markdown' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).not.toContain('&sign=');
    expect(fetchCalls[0].body).toMatchObject({ msgtype: 'markdown', markdown: { title: '标题', text: '正文' }, at: { atMobiles: ['138000'], isAtAll: false } });
  });

  it('正例：无 title 纯 text 分型;DINGTALK_SECRET 在场 URL 带 timestamp+sign（加签算法真机验证过的形态）', async () => {
    process.env.DINGTALK_WEBHOOK = FAKE_HOOK;
    process.env.DINGTALK_SECRET = 'SECtest0000';
    const r = await new NotifyToolProvider().execute('dingtalk_notify', { text: 'hello' });
    expect(r.success).toBe(true);
    expect(JSON.parse(String(r.result)).msgtype).toBe('text');
    expect(fetchCalls[0].url).toContain('&timestamp=');
    expect(fetchCalls[0].url).toContain('&sign=');
    expect(fetchCalls[0].body).toMatchObject({ msgtype: 'text', text: { content: 'hello' } });
  });

  it('反例：fetch 抛网络异常 → catch 归一 success:false 带"网络失败"（Trait 第三分叉钉——review 面三 G3 抓无断言后补）', async () => {
    process.env.DINGTALK_WEBHOOK = FAKE_HOOK;
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const r = await new NotifyToolProvider().execute('dingtalk_notify', { text: 'x' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('网络失败');
  });

  it('反例：钉钉拒收 errcode≠0 → success:false 带常见原因指引（失败是值不抛）', async () => {
    process.env.DINGTALK_WEBHOOK = FAKE_HOOK;
    globalThis.fetch = (async () => ({ status: 200, json: async () => ({ errcode: 310000, errmsg: 'keywords not in content' }) })) as unknown as typeof fetch;
    const r = await new NotifyToolProvider().execute('dingtalk_notify', { text: 'x' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('errcode=310000');
    expect(String(r.result)).toContain('常见原因');
  });
});

// composeRunCard 卡片组装（^anc-cli-notify-reuse——两挂点共享渲染,三态钉）
// @v: anc-cli-notify-reuse
describe('composeRunCard 运行状态卡片', () => {
  it('正例：completed 三态徽记+进度+run 尾段', () => {
    const c = composeRunCard({ spec_title: '周报', state: 'completed', completed_steps: 5, total_steps: 5, run_id_tail: 'abcd1234' });
    expect(c.title).toBe('✅ 完成 周报');
    expect(c.text).toContain('进度: 5/5 步');
    expect(c.text).toContain('run: …abcd1234');
  });
  it('正例：paused 带停点问题摘要（⏸️ 徽记,问题截断 200 字）', () => {
    const c = composeRunCard({ spec_title: '合同审查', state: 'paused', completed_steps: 2, total_steps: 6, paused_question: '请确认口径:' + 'x'.repeat(300), run_id_tail: 'ff00' });
    expect(c.title).toBe('⏸️ 等你确认 合同审查');
    expect(c.text).toContain('请确认口径:');
    expect(c.text.length).toBeLessThan(400);
  });
  it('正例：failed 带失败步（❌ 徽记,失败步行在进度行前）', () => {
    const c = composeRunCard({ spec_title: 'T', state: 'failed', completed_steps: 1, total_steps: 3, current_step: '2: boom', run_id_tail: 'ee11' });
    expect(c.title).toBe('❌ 失败 T');
    expect(c.text).toContain('失败步 2: boom');
  });
});

// @v: anc-exec-tool-manifest-source —— 内建特殊族名单常量与注册面同源（名单住 provider-types
// 共享层〔prompt 层1 消费,不得反向 import 层2 tools〕,同源性靠本钉:注册面的 special 件恰
// 等于名单——内建族扩员漏改任一处即红）
describe('ENGINE_BUILTIN_SPECIAL_TOOL_NAMES 与 DefaultToolProvider 注册面同源', () => {
  it('正例：注册面上非 basic（即 special 档,缺省 special）的内建件名集合 == 名单常量', async () => {
    const { ENGINE_BUILTIN_SPECIAL_TOOL_NAMES } = await import('../src/provider-types.js');
    const host: HostConfig = { workspace_dir: tmpdir(), sandbox: { allowed_paths: [], denied_paths: [] } } as unknown as HostConfig;
    const provider = new DefaultToolProvider(host);
    const specialOnRegistry = provider.list().filter(t => (t.category ?? 'special') === 'special').map(t => t.name).sort();
    expect(specialOnRegistry).toEqual([...ENGINE_BUILTIN_SPECIAL_TOOL_NAMES].sort());
  });
});
