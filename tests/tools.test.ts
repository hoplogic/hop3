// @module: tools ^anc-struct-tools
// @v: anc-provider-tool
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NotifyToolProvider, composeRunCard } from '../src/tools-notify.js';
import { DefaultToolProvider , executeValidateSpec, executeReadSpecTree, executeInsertNode, executeReplaceNode, executeReplaceChildren, executeRenumberSteps } from '../src/tools.js';
import { deleteNodeAt, replaceNodeAt as coreReplaceNodeAt, renumberSteps as coreRenumberSteps } from '../src/spec-tree-edit.js';
import { DEFAULT_KEEP, type StepNode } from '../src/ast-types.js';
import { parseFragment as parseFragForCore } from '../src/parser.js';
import type { HostConfig } from '../src/provider-types.js';
import { B2_BUILTIN_FILE_TOOLS, B2_BUILTIN_NOTIFY_TOOLS, B2_BUILTIN_TOOL_SIGS, B9_WRITE_TOOLS, B10_READ_TOOLS } from '../src/validator.js';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, symlinkSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';   // run_script 组:解释器真身探测（不静默假绿）
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// 模拟 engine.getWorkZone() 对"当前实例=该 work_zone"的推法：登记进读集合 + 设为写根（todo/0126 读写分权）
function ownWz(p: DefaultToolProvider, wz: string, tree?: string): void {
  p.registerWorkZoneRoot(wz);
  p.setWorkZoneScope({ own: wz, ...(tree ? { tree } : {}) });
}

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
    it('returns the eighteen builtin tools (eleven file/dir + validate_spec + four tree-edit + read_spec_tree + run_script), all requires_commit=false (no bash)', () => {
      const provider = makeProvider();
      const tools = provider.list();
      expect(tools.map(t => t.name)).toEqual(
        ['read', 'write', 'listdir', 'exists', 'create', 'append', 'edit_file', 'search_file', 'makedirs', 'move', 'remove', 'validate_spec', 'insert_node', 'replace_node', 'replace_children', 'renumber_steps', 'read_spec_tree', 'run_script']);
      // 不可逆分界=是否出沙箱，非操作类型（作者定 2026-08-10）——箱内全 false（validate_spec 纯函数同理;
      // run_script 与 body 面的 subprocess.run 同档=同一份 spawn 能力的同一个曝露面,见 tools/run-script.md）
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

    // 名单收的是注册面全员（2026-09-22 run_script 入列时把这条隐含口径写明,权威=spec-parser
    // ^anc-rule-b2）——不是"恒可用的那些件":category='special' 只管无 body act 的下发面,
    // 而 B2 校验的是有 body 的步骤,body 调用走解释器 ToolProvider 通路不看 category
    it('B2 名单 = 注册面全量（文件件+spec 内容族+run_script,18 员逐员）', () => {
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

  // @v: anc-exec-builtin-run-script, anc-exec-run-script-no-command-choice
  // 受控脚本执行（设计权威 docs/design/tools/run-script.md,2026-09-22 作者拍 todo/0110 候选 B）。
  // 病灶:standalone 的 [act free] 工具面此前没有任何一件能让进程跑起来,而 sdc 规约步骤要求
  // "实跑校验脚本"——三家模型在同一步各死一种死法,其中一家被逼出伪造执行来源（写下"以 shell
  // 运行 python3…退出码 0"而那一轮它只发了 makedirs 与 write）。
  describe('execute run_script（受控脚本执行）', () => {
    /** 带命令白名单的 provider——缺省 makeProvider 的 runtime.available 是空的（=能力关死） */
    function makeProviderWithCommands(dir: string, commands: string[]): DefaultToolProvider {
      return new DefaultToolProvider({
        workspace_dir: dir,
        sandbox: {
          filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } },
          network: { trusted_hosts: [] },
          runtime: { available: commands },
        },
        api_key: 'test',
      } as unknown as HostConfig);
    }

    // 解释器真身探测（anchor-scan.test.ts 同款纪律:不能只试裸 `python3`——shell alias 在子进程
    // 里不存在;全不可用时让用例显式失败而不是静默假绿）
    function findPython(): string | null {
      for (const py of [process.env.HOPJIT_TEST_PYTHON, 'python3', 'python'].filter((c): c is string => Boolean(c))) {
        try {
          execFileSync(py, ['-c', 'print(1)'], { stdio: 'ignore', timeout: 10000 });
          return py;
        } catch { /* 试下一个 */ }
      }
      return null;
    }

    it('正例：脚本跑起来,stdout 与退出码 0 逐字回传（JSON 三键）', async () => {
      const py = findPython();
      expect(py, '本机没有可用的 python3——run_script 的真跑用例无法验证（设 HOPJIT_TEST_PYTHON 指定解释器）').toBeTruthy();
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      writeFileSync(join(dir, 'ok.py'), 'print("hello from script")\n');
      const provider = makeProviderWithCommands(dir, [py!.split('/').pop()!, 'python3', 'python']);
      const r = await provider.execute('run_script', { path: 'ok.py' });
      expect(r.success).toBe(true);
      expect(r.content_type).toBe('json');
      const out = JSON.parse(String(r.result)) as { returncode: number; stdout: string; stderr: string };
      expect(out.returncode).toBe(0);
      expect(out.stdout).toContain('hello from script');
    });

    // 本组最要命的一种实现错误（契约正反例末条）——校验脚本对违规样例返回 1 是它的判定结果,
    // 工具若回 success:false,模型读成"执行工具也不好用",转头去找别的执行入口(0110 实撞的死法)
    it('正例（退出码是值不是失败）：脚本返回 1 → success 仍为 true,returncode 如实是 1', async () => {
      const py = findPython();
      expect(py, '本机没有可用的 python3').toBeTruthy();
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      writeFileSync(join(dir, 'guard.py'), 'import sys\nprint("VIOLATIONS FOUND: 2")\nsys.exit(1)\n');
      const provider = makeProviderWithCommands(dir, [py!.split('/').pop()!, 'python3', 'python']);
      const r = await provider.execute('run_script', { path: 'guard.py' });
      expect(r.success).toBe(true);
      const out = JSON.parse(String(r.result)) as { returncode: number; stdout: string };
      expect(out.returncode).toBe(1);
      expect(out.stdout).toContain('VIOLATIONS FOUND: 2');
    });

    it('正例：args 逐项当参数传给脚本（一项一个参数,不是一整串待拆的命令行）', async () => {
      const py = findPython();
      expect(py, '本机没有可用的 python3').toBeTruthy();
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      writeFileSync(join(dir, 'echo_args.py'), 'import sys\nprint("|".join(sys.argv[1:]))\n');
      const provider = makeProviderWithCommands(dir, [py!.split('/').pop()!, 'python3', 'python']);
      const r = await provider.execute('run_script', { path: 'echo_args.py', args: ['a b', 'c'] });
      const out = JSON.parse(String(r.result)) as { stdout: string };
      expect(out.stdout.trim()).toBe('a b|c');   // 'a b' 整项是一个参数——经 shell 会被拆成两个
    });

    // 工作目录约定（契约"工作目录这条约定必须写进给执行 LLM 看的工具说明"）——2026-09-23 T9 复跑实撞:
    // 模型照其余文件工具的习惯给 args 传工作区相对路径,脚本在自己的目录下找不到文件。行为与说明成对钉:
    it('正例（工作目录=脚本所在目录）：脚本在子目录里,同目录样例传裸文件名即可读到', async () => {
      const py = findPython();
      expect(py, '本机没有可用的 python3').toBeTruthy();
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      mkdirSync(join(dir, 'wz'));
      writeFileSync(join(dir, 'wz', 'sample.txt'), 'SAMPLE-CONTENT\n');
      writeFileSync(join(dir, 'wz', 'readit.py'), 'import sys\nprint(open(sys.argv[1]).read().strip())\n');
      const provider = makeProviderWithCommands(dir, [py!.split('/').pop()!, 'python3', 'python']);
      const r = await provider.execute('run_script', { path: 'wz/readit.py', args: ['sample.txt'] });
      expect(r.success).toBe(true);
      const out = JSON.parse(String(r.result)) as { returncode: number; stdout: string };
      expect(out.returncode).toBe(0);
      expect(out.stdout.trim()).toBe('SAMPLE-CONTENT');
    });

    it('工具说明写明工作目录=脚本所在目录、同目录样例传裸文件名（缺这句模型会传工作区相对路径）', () => {
      const def = makeProvider().list().find(t => t.name === 'run_script')!;
      expect(def.description).toContain('its own directory as the working directory');
      expect(def.description).toContain('bare filename');
      const argsDesc = (def.input_schema.properties as Record<string, { description: string }>).args.description;
      expect(argsDesc).toContain('against its own directory');
    });

    it('反例：.sh 脚本被拒,报文给理由并指出改写成 .py（不是干巴巴一句不支持）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      writeFileSync(join(dir, 'check.sh'), 'echo hi\n');
      const provider = makeProviderWithCommands(dir, ['python3']);
      const r = await provider.execute('run_script', { path: 'check.sh' });
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('命令白名单形同虚设');   // 理由:shell 语义下脚本内容就是任意命令
      expect(String(r.result)).toContain('.py');                  // 出路
    });

    it('反例：不支持的扩展名/无扩展名 → 拒收并列出当前支持的类型', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      writeFileSync(join(dir, 'tool.js'), 'console.log(1)\n');
      writeFileSync(join(dir, 'noext'), 'x\n');
      const provider = makeProviderWithCommands(dir, ['python3', 'node']);
      const js = await provider.execute('run_script', { path: 'tool.js' });
      expect(js.success).toBe(false);
      expect(String(js.result)).toContain('.py');   // 支持清单
      const noext = await provider.execute('run_script', { path: 'noext' });
      expect(noext.success).toBe(false);
      expect(String(noext.result)).toContain('无扩展名');
    });

    it('反例：脚本文件不存在 → 拒收并指路"先把脚本写出来"（不静默当空脚本跑）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      const provider = makeProviderWithCommands(dir, ['python3']);
      const r = await provider.execute('run_script', { path: 'nope.py' });
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('不存在');
      expect(String(r.result)).toContain('先把脚本写出来');
    });

    it('反例：args 不是列表（模型塞了一整串命令行）→ 拒收并说清该给什么形态', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      writeFileSync(join(dir, 'x.py'), 'print(1)\n');
      const provider = makeProviderWithCommands(dir, ['python3']);
      const r = await provider.execute('run_script', { path: 'x.py', args: '--flag v' });
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('args 须是字符串列表');
      expect(String(r.result)).toContain('不是一整串待拆的命令行');
    });

    // 白名单两拒的配置指路（hopissues/0090:用户 1.5 小时废跑才摸到 hopjit.yaml——空名单报
    // "不可用"不点名命令、缺命令报"不在白名单"不提配置载体,两种报文都断在同一处）。
    // 这两钉核的是共用原语本身（^anc-exec-command-primitive）——同一份实现此前只有 body 面的
    // subprocess.run 一个消费口在核,这里从新消费口再核一遍:抽出后两边拿到的是同一套报文。
    // @v: anc-exec-command-primitive
    it('反例：命令白名单为空（缺省安全=能力关死）→ 报文点名命令并指路 hopjit.yaml 的 commands', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      writeFileSync(join(dir, 'x.py'), 'print(1)\n');
      const provider = makeProvider(dir);   // 缺省 runtime.available = []
      const r = await provider.execute('run_script', { path: 'x.py' });
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('python3');    // 点名是哪个命令没放行
      expect(String(r.result)).toContain('hopjit.yaml');
      expect(String(r.result)).toContain('commands');
    });

    it('反例：白名单在场但没放行解释器 → 同样点名命令+指路配置,并列出当前放行了什么', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      writeFileSync(join(dir, 'x.py'), 'print(1)\n');
      const provider = makeProviderWithCommands(dir, ['git', 'uv']);
      const r = await provider.execute('run_script', { path: 'x.py' });
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('python3');
      expect(String(r.result)).toContain('git, uv');   // 当前放行清单,让人看出差在哪
      expect(String(r.result)).toContain('hopjit.yaml');
    });

    it('反例：workspace 外的绝对路径 → 走 read 同款权限链被拒（"能执行"的前提是"能读到"）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      const outside = mkdtempSync(join(tmpdir(), 'hopout-'));
      writeFileSync(join(outside, 'evil.py'), 'print(1)\n');
      const provider = makeProviderWithCommands(dir, ['python3']);
      const r = await provider.execute('run_script', { path: join(outside, 'evil.py') });
      expect(r.success).toBe(false);
    });

    // 语法沙箱接入（py-sandbox 设计"与 run_script 的关系收窄"）:.py 一律先审,审不过不执行,
    // 拒绝报文作为 success:false 的 result 回给模型,同一个工具循环里照报文改写再调
    // @v: anc-pysb-exec
    it('反例（语法沙箱）：脚本 import os → 不执行,success:false 且报文点名行号与替代写法', async () => {
      const py = findPython();
      expect(py, '本机没有可用的 python3').toBeTruthy();
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      writeFileSync(join(dir, 'bad.py'), 'import os\nprint(os.getcwd())\n');
      const provider = makeProviderWithCommands(dir, [py!.split('/').pop()!, 'python3', 'python']);
      const r = await provider.execute('run_script', { path: 'bad.py' });
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('脚本没有执行');
      expect(String(r.result)).toContain('第 1 行 `os`');
      expect(String(r.result)).toContain('可用的模块符号:');
    });

    it('反例（语法沙箱）：写模式 open → 不执行（目标文件不出现）,报文给 print(…, file=sys.stderr) 替代', async () => {
      const py = findPython();
      expect(py, '本机没有可用的 python3').toBeTruthy();
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      writeFileSync(join(dir, 'w.py'), 'open("out.txt", "w")\n');
      const provider = makeProviderWithCommands(dir, [py!.split('/').pop()!, 'python3', 'python']);
      const r = await provider.execute('run_script', { path: 'w.py' });
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('file=sys.stderr');
      expect(existsSync(join(dir, 'out.txt'))).toBe(false);
    });

    it('正例（语法沙箱）：回执 JSON 带 defense 字段,取值是两档之一', async () => {
      const py = findPython();
      expect(py, '本机没有可用的 python3').toBeTruthy();
      const dir = mkdtempSync(join(tmpdir(), 'hoprun-'));
      writeFileSync(join(dir, 'ok.py'), 'print(1)\n');
      const provider = makeProviderWithCommands(dir, [py!.split('/').pop()!, 'python3', 'python']);
      const r = await provider.execute('run_script', { path: 'ok.py' });
      expect(r.success).toBe(true);
      const out = JSON.parse(String(r.result)) as { defense: string };
      expect(['syntax+os-sandbox', 'syntax-only']).toContain(out.defense);
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

    it('rejects absolute paths outside workspace', async () => {
      const provider = makeProvider();
      const result = await provider.execute('read', { path: '/etc/passwd' });
      expect(result.success).toBe(false);
      expect(String(result.result)).toContain('Absolute path outside workspace');
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

    // 父目录缺失报文（hopissues/0120——裸 ENOENT 分不清路径写错还是目录没建;报文指路 makedirs,不代建）
    // @v: anc-exec-write-parent-missing
    it('反例：write 目标的父目录不存在 → 报文点名父目录并指路 makedirs,文件不落、目录不代建', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const provider = makeProvider(dir);
      const r = await provider.execute('write', { path: 'newdir_a/newdir_b/probe.txt', content: 'x' }, 'workspace');
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain(`父目录 ${join(realpathSync(dir), 'newdir_a/newdir_b')} 不存在`);   // 工具层路径已 realpath（macOS /tmp → /private/tmp）
      expect(String(r.result)).toContain('makedirs');
      expect(String(r.result)).toContain('ENOENT');   // 原始错误保留在括号里
      expect(existsSync(join(dir, 'newdir_a'))).toBe(false);   // 不自动建目录
    });
    it('反例：create / append 目标的父目录不存在 → 同一指路报文（三件同链）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const provider = makeProvider(dir);
      for (const tool of ['create', 'append']) {
        const r = await provider.execute(tool, { path: 'nodir/f.txt', content: 'x' }, 'workspace');
        expect(r.success).toBe(false);
        expect(String(r.result)).toMatch(/^父目录 .*nodir 不存在,请先 makedirs/);
      }
    });
    it('正例：父目录在场的写入照常;父目录在场的 ENOENT（目标是坏软链）原文照回不改写', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const provider = makeProvider(dir);
      mkdirSync(join(dir, 'sub'));
      const ok = await provider.execute('write', { path: 'sub/f.txt', content: 'x' }, 'workspace');
      expect(ok.success).toBe(true);
      // 先 makedirs 再 write 是设计指的正路
      await provider.execute('makedirs', { path: 'deep/er' }, 'workspace');
      const ok2 = await provider.execute('write', { path: 'deep/er/f.txt', content: 'y' }, 'workspace');
      expect(ok2.success).toBe(true);
      // 真造坏软链（review 面三 mut-12 抓本例标题承诺没兑现）：sub/ 在场,sub/dangling → sub/nope/x（workspace 内、目标目录不存在）,
      // open 抛 ENOENT 而 dirname(resolved)=sub 存在 → 不改写,原文照回
      symlinkSync(join(dir, 'sub', 'nope', 'x'), join(dir, 'sub', 'dangling'));
      const r = await provider.execute('write', { path: 'sub/dangling', content: 'z' }, 'workspace');
      expect(r.success).toBe(false);
      expect(String(r.result)).toMatch(/ENOENT/);
      expect(String(r.result)).not.toMatch(/^父目录 /);   // 变异：withParentDirHint 删 !existsSync(parent) 半边 → 这里被改写成指路报文,红
    });
    it('反例（review 面二 G11）：move 的目标父目录不存在 → 同一指路报文点名目标父目录;源不存在的 ENOENT 原文照回（那是源的问题）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const provider = makeProvider(dir);
      writeFileSync(join(dir, 'a.txt'), 'A');
      const r = await provider.execute('move', { from: 'a.txt', to: 'nodir/b.txt' }, 'workspace');
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain(`父目录 ${join(realpathSync(dir), 'nodir')} 不存在,请先 makedirs`);
      expect(existsSync(join(dir, 'a.txt'))).toBe(true);   // 源未动
      const r2 = await provider.execute('move', { from: 'ghost.txt', to: 'nodir/b.txt' }, 'workspace');
      expect(r2.success).toBe(false);
      expect(String(r2.result)).not.toMatch(/父目录 /);
      expect(String(r2.result)).toMatch(/ENOENT/);
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
    // 2026-10-12 语义审计 #25 #26（作者拍甲案）：空目录 result 恒为纯 []（content_type json 必须真能 parse）,
    // 给弱模型看的明示语走 hint 旁路——修前注记拼进 result,parse_json / call 位 JSON.parse 都炸
    it('正例（语义审计 #25）：空目录 result === "[]" 且 JSON.parse 得空数组;明示语在 hint 字段（含"目录存在但为空"）,不在 result 里', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-empty-'));
      const r = await makeProvider(dir).execute('listdir', { path: '.' });
      expect(r.success).toBe(true);
      expect(r.content_type).toBe('json');
      expect(r.result).toBe('[]');
      expect(JSON.parse(String(r.result))).toEqual([]);
      expect(r.hint).toContain('目录存在但为空');
      expect(String(r.result)).not.toContain('目录存在但为空');
    });
    it('反例（语义审计 #26）：非空目录 hint 缺席——明示语只给空目录', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-nonempty-'));
      writeFileSync(join(dir, 'a.txt'), 'x');
      const r = await makeProvider(dir).execute('listdir', { path: '.' });
      expect(r.success).toBe(true);
      expect(r.hint).toBeUndefined();
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
    it('正例：零匹配附最接近行——凭记忆多写 ### 且步骤类型记错,报错给出带缩进的原文行号与原文,文件不改（hb2 qwen-flash 实撞）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      const draft = '2. [branch] Route\n    2.1.3. [reason] Document mitigation steps\n      - ← deliverable\n    2.1.4. [reason] Generate postmortem';
      await p.execute('write', { path: 'doc.md', content: draft }, 'workspace');
      const r = await p.execute('edit_file', { path: 'doc.md', old_text: '### 2.1.3. [act] Document mitigation steps\n  - ← deliverable', new_text: '' }, 'workspace');
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('未找到匹配');
      expect(String(r.result)).toContain('第 2 行 "    2.1.3. [reason] Document mitigation steps"');
      expect(String(r.result)).not.toContain('第 1 行');
      expect((await p.execute('read', { path: 'doc.md' })).result).toBe(draft);
    });
    it('反例：零匹配且文件里没有够得上相似门槛的行——不附最接近行提示', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('write', { path: 'doc.md', content: 'alpha beta\ngamma delta' }, 'workspace');
      const r = await p.execute('edit_file', { path: 'doc.md', old_text: '完全无关的一句中文', new_text: 'x' }, 'workspace');
      expect(r.success).toBe(false);
      expect(String(r.result)).not.toContain('最接近的行');
    });
    // 最接近行算法四处边界（file-tools.md HopSop 5.1.1–5.1.5）:Dice 门槛、至多 3 条、排序、只比首行
    const nearHint = async (content: string, oldText: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('write', { path: 'doc.md', content }, 'workspace');
      const r = await p.execute('edit_file', { path: 'doc.md', old_text: oldText, new_text: 'x' }, 'workspace');
      expect(r.success).toBe(false);
      return String(r.result);
    };
    it('正例：规范化后不相等、但 Dice 过 0.5 门槛的行照样附上;门槛以下的行不附', async () => {
      // 与 "deploy the service" 的 Dice:deploy a server≈0.65（过门槛）,deploy it≈0.48（不过）
      const msg = await nearHint('deploy a server\ndeploy it', 'deploy the service');
      expect(msg).toContain('第 1 行 "deploy a server"');
      expect(msg).not.toContain('deploy it');
    });
    it('反例：过门槛的行超过 3 条 → 只附分数最高的 3 条', async () => {
      // 分数:deploy the servic≈0.97 / redeploy…≈0.70 / employ services≈0.71 / deploy a server≈0.65
      const msg = await nearHint('deploy a server\nredeploy the servers now\nemploy services\ndeploy the servic', 'deploy the service');
      expect(msg).toContain('第 4 行');
      expect(msg).toContain('第 3 行');
      expect(msg).toContain('第 2 行');
      expect(msg).not.toContain('第 1 行');
    });
    it('正例：排序——规范化后相等的行排最前,同分按行号从小到大', async () => {
      const msg = await nearHint('deploy the services\n## deploy [act] the service\ndeploy the servicee\n  deploy the service', '### deploy the service');
      const order = [...msg.matchAll(/第 (\d+) 行/g)].map(m => Number(m[1]));
      expect(order).toEqual([2, 4, 1]);   // 2 与 4 规范化相等同为 2 分按行号;1 与 3 Dice 同分（均≈0.97）取行号小的,3 被 3 条上限挤掉
    });
    it('反例：只比 old_text 首个非空行——后续行在文件里有原文也不参与比对', async () => {
      const msg = await nearHint('完全无关的第一行内容\nsecond line exact', '\nzzz qqq\nsecond line exact extra');
      expect(msg).not.toContain('最接近的行');
    });
    it('正例：替换成功回执带字符偏移（UTF-16 码元,中文不按字节算）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
      const p = makeProvider(dir);
      await p.execute('write', { path: 'doc.md', content: '中文前缀TARGET' }, 'workspace');
      const r = await p.execute('edit_file', { path: 'doc.md', old_text: 'TARGET', new_text: 'x' }, 'workspace');
      expect(String(r.result)).toContain('Replaced 1 occurrence at char 4 in');
    });
    it('反例：工具清单里给模型看的返回说明写字符偏移,不写字节', () => {
      const def = makeProvider().list().find(t => t.name === 'edit_file')!;
      expect(def.returns).toContain('at char');
      expect(def.returns).toContain('字符偏移');
      expect(def.returns).not.toMatch(/byte|字节/);
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

// 路径解析与目录边界判定（hopissues/0112,契约 [[tools/file-tools#^anc-exec-tool-path-resolve]]）：
// 判据只问落点在不在 workspace 内,不问写法;同批修两处既有逃逸（兄弟前缀目录/新建文件经软链父目录）。
// @v: anc-exec-tool-path-resolve
describe('路径解析：workspace 内绝对路径与目录边界', () => {
  it('正例：commit 语境写 workspace 内绝对路径,落点与相对写法相同;读侧同认', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-abs-'));
    mkdirSync(join(dir, 'skill'));
    const p = makeProvider(dir);
    const w = await p.execute('write', { path: join(dir, 'skill', 'spec.md'), content: 'abs' }, 'workspace');
    expect(w.success, String(w.result)).toBe(true);
    expect(readFileSync(join(dir, 'skill', 'spec.md'), 'utf-8')).toBe('abs');
    expect((await p.execute('read', { path: 'skill/spec.md' })).result).toBe('abs');       // 相对读到同一文件
    writeFileSync(join(dir, 'README.md'), 'hi');
    expect((await p.execute('read', { path: join(dir, 'README.md') })).result).toBe('hi'); // 0112 probe 读侧
  });

  it('正例：字面路径经软链（如 macOS /tmp→/private/tmp）而根已取真实路径时,真实路径判仍认', async () => {
    const real = mkdtempSync(join(tmpdir(), 'hoptools-real-'));
    const alias = join(mkdtempSync(join(tmpdir(), 'hoptools-alias-')), 'ws');
    symlinkSync(real, alias);   // alias 是 workspace 的另一个字面名
    const p = makeProvider(alias);   // 构造器把根取成真实路径
    const r = await p.execute('write', { path: join(alias, 'x.txt'), content: 'v' }, 'workspace');
    expect(r.success, String(r.result)).toBe(true);
    expect(readFileSync(join(real, 'x.txt'), 'utf-8')).toBe('v');
  });

  it('反例：workspace 外绝对路径拒,报文点名在 workspace 外并带出 workspace 根', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-abs-'));
    const outside = mkdtempSync(join(tmpdir(), 'hoptools-out-'));
    const p = makeProvider(dir);
    const r = await p.execute('write', { path: join(outside, 'x.txt'), content: 'v' }, 'workspace');
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('Absolute path outside workspace');
    expect(String(r.result)).toContain('workspace 根');
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
  });

  it('反例：绝对形态含 .. 一律拒（即便化简后落在 workspace 内）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-abs-'));
    mkdirSync(join(dir, 'a'));
    const p = makeProvider(dir);
    const r = await p.execute('write', { path: join(dir, 'a') + '/../b.txt', content: 'v' }, 'workspace');
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('Path traversal');
  });

  it('反例：兄弟前缀目录（/x/proj 与 /x/proj2）经软链不再被当成 workspace 内——写读都拒', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'hoptools-sib-'));
    const ws = join(parent, 'proj'); const sib = join(parent, 'proj2');
    mkdirSync(ws); mkdirSync(sib);
    writeFileSync(join(sib, 'victim.txt'), 'orig');
    symlinkSync(sib, join(ws, 'lsib'));
    const p = new DefaultToolProvider({
      workspace_dir: ws,
      sandbox: {
        filesystem: { workspace_dir: ws, read_access: { allowed: [], denied: [], confirm_required: [] } },
        network: { trusted_hosts: [] }, runtime: { available: [] },
      },
      api_key: 'test',
    });
    expect((await p.execute('write', { path: 'lsib/victim.txt', content: 'X' }, 'workspace')).success).toBe(false);
    expect(readFileSync(join(sib, 'victim.txt'), 'utf-8')).toBe('orig');
    expect((await p.execute('read', { path: 'lsib/victim.txt' })).success).toBe(false);
    // 绝对写法指向兄弟目录同拒（字面判与真实路径判都不中）——拒因必须是路径解析层的契约报文,
    // 不能退化成写域闸兜底的 "Write outside workspace sandbox"（裸前缀比较会把 /x/proj2 当成 /x/proj 内）
    const abs = await p.execute('write', { path: join(sib, 'victim.txt'), content: 'X' }, 'workspace');
    expect(abs.success).toBe(false);
    expect(String(abs.result)).toContain('Absolute path outside workspace');
    expect(String(abs.result)).toContain('workspace 根');
    const absNew = await p.execute('write', { path: join(sib, 'x.txt'), content: 'X' }, 'workspace');
    expect(absNew.success).toBe(false);
    expect(String(absNew.result)).toContain('Absolute path outside workspace');
    expect(existsSync(join(sib, 'x.txt'))).toBe(false);
    expect(readFileSync(join(sib, 'victim.txt'), 'utf-8')).toBe('orig');
  });

  it('反例：经软链父目录新建文件（目标不存在）不再逃出 workspace;悬空软链写入同拒', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'hoptools-ws-'));
    const far = mkdtempSync(join(tmpdir(), 'hoptools-far-'));
    symlinkSync(far, join(ws, 'lfar'));
    symlinkSync(join(far, 'dangling.txt'), join(ws, 'ldang'));
    const p = makeProvider(ws);
    const r = await p.execute('write', { path: 'lfar/new.txt', content: 'X' }, 'workspace');
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('Write outside workspace');
    expect(existsSync(join(far, 'new.txt'))).toBe(false);
    expect((await p.execute('write', { path: 'ldang', content: 'X' }, 'workspace')).success).toBe(false);
    expect(existsSync(join(far, 'dangling.txt'))).toBe(false);
  });

  it('反例：读侧经软链父目录探测 workspace 外不存在的文件拒（旧形态 exists 返回 false 成功,可探测外部文件存否）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'hoptools-ws-'));
    const far = mkdtempSync(join(tmpdir(), 'hoptools-far-'));
    symlinkSync(far, join(ws, 'lout'));
    const p = makeProvider(ws);
    const e = await p.execute('exists', { path: 'lout/absent.txt' });
    expect(e.success).toBe(false);
    expect(String(e.result)).toContain('Read outside allowed paths');
    const r = await p.execute('read', { path: 'lout/absent.txt' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('Read outside allowed paths');   // 校验拒,不是读盘 ENOENT
  });

  it('正例：读侧经指向 workspace 内目录的软链探测不存在的文件照常放行（exists 返回 false）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'hoptools-ws-'));
    mkdirSync(join(ws, 'inner'));
    symlinkSync(join(ws, 'inner'), join(ws, 'lin'));
    const p = makeProvider(ws);
    const e = await p.execute('exists', { path: 'lin/absent.txt' });
    expect(e.success, String(e.result)).toBe(true);
    expect(String(e.result)).toContain('"exists":false');
  });

  it('正例：workspace 内尚不存在的多级新路径照常可写（祖先解析不误伤正常新建）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-abs-'));
    mkdirSync(join(dir, 'a'));
    const p = makeProvider(dir);
    expect((await p.execute('write', { path: 'a/new.txt', content: 'v' }, 'workspace')).success).toBe(true);
    expect((await p.execute('makedirs', { path: join(dir, 'b', 'c') }, 'workspace')).success).toBe(true);
    expect(existsSync(join(dir, 'b', 'c'))).toBe(true);
  });

  it('正例：超过 40 层的新嵌套路径照常可写（上溯祖先不计软链跳数）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-deep-'));
    const p = makeProvider(dir);
    const deep = Array.from({ length: 45 }, (_, i) => 'd' + i).join('/');
    const r = await p.execute('makedirs', { path: deep }, 'workspace');
    expect(r.success, String(r.result)).toBe(true);
    expect(existsSync(join(dir, deep))).toBe(true);
  });

  it('反例：经软链父目录新建超过 40 层的新目录不再逃出（旧形态上溯也计数,耗尽后放行未解析路径）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'hoptools-ws-'));
    const far = mkdtempSync(join(tmpdir(), 'hoptools-far-'));
    symlinkSync(far, join(ws, 'lfar'));
    const p = makeProvider(ws);
    const deep = 'lfar/' + Array.from({ length: 41 }, (_, i) => 'x' + i).join('/');
    const r = await p.execute('makedirs', { path: deep }, 'workspace');
    expect(r.success).toBe(false);
    expect(existsSync(join(far, 'x0'))).toBe(false);
  });

  it('反例：经别名目录访问相对形态的悬空软链不再逃出（链接目标以软链所在目录的真实路径为基准）', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'hoptools-alias-'));
    const ws = join(parent, 'ws'); mkdirSync(join(ws, 'deep', 'er'), { recursive: true });
    symlinkSync('../escaped.txt', join(ws, 'd'));          // 按 d 所在目录解析 = parent/escaped.txt,workspace 外
    symlinkSync(ws, join(ws, 'deep', 'er', 'a'));          // 别名:deep/er/a 指回 workspace 根
    const p = makeProvider(ws);
    expect((await p.execute('write', { path: 'd', content: 'X' }, 'workspace')).success).toBe(false);
    const r = await p.execute('write', { path: 'deep/er/a/d', content: 'X' }, 'workspace');
    expect(r.success).toBe(false);
    expect(existsSync(join(parent, 'escaped.txt'))).toBe(false);
  });

  it('反例：软链成环由校验拒（失败即拒,报文点名层数超限或成环）,不靠 OS 报错兜底', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'hoptools-loop-'));
    symlinkSync('loopB', join(ws, 'loopA'));
    symlinkSync('loopA', join(ws, 'loopB'));
    const p = makeProvider(ws);
    const r = await p.execute('write', { path: 'loopA', content: 'X' }, 'workspace');
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('Symlink chain too deep or cyclic');
  });

  it('read allowed 清单同带分隔符边界:allowed=/x/kb 时经软链读 /x/kb2 拒,读 /x/kb 放行', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'hoptools-allow-'));
    const ws = join(parent, 'ws'); const kb = join(parent, 'kb'); const kb2 = join(parent, 'kb2');
    for (const d of [ws, kb, kb2]) mkdirSync(d);
    writeFileSync(join(kb, 'f.md'), 'ok'); writeFileSync(join(kb2, 'f.md'), 'secret');
    symlinkSync(kb, join(ws, 'lkb')); symlinkSync(kb2, join(ws, 'lkb2'));
    const p = new DefaultToolProvider({
      workspace_dir: ws,
      sandbox: {
        filesystem: { workspace_dir: ws, read_access: { allowed: [kb], denied: [], confirm_required: [] } },
        network: { trusted_hosts: [] }, runtime: { available: [] },
      },
      api_key: 'test',
    });
    expect((await p.execute('read', { path: 'lkb/f.md' })).result).toBe('ok');
    const r = await p.execute('read', { path: 'lkb2/f.md' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('Read outside allowed paths');
  });
});

// read_access.allowed 内绝对路径——读类第④合法形态（design tools/file-tools ^anc-exec-tool-path-resolve,2026-10-07）：
// 起跑把 spec 所在目录加进 allowed,spec_dir() 产物由此能读;写类与 run_script 不认（strict 档）。
// 作者定"不让读的话 knowledge、data 和未来的 inner_store 都要再分开授权"。 // @v: anc-exec-tool-path-resolve
describe('read_access.allowed 内绝对路径（spec 目录只读）', () => {
  function makeProviderAllowing(wsDir: string, extraAllowed: string[]): DefaultToolProvider {
    const config: HostConfig = {
      workspace_dir: wsDir,
      sandbox: {
        filesystem: { workspace_dir: wsDir, read_access: { allowed: [wsDir, ...extraAllowed], denied: [], confirm_required: [] } },
        network: { trusted_hosts: [] },
        runtime: { available: ['python3'] },
      },
      api_key: 'test',
    };
    return new DefaultToolProvider(config);
  }
  function setup() {
    const ws = mkdtempSync(join(tmpdir(), 'hoptools-ws-'));
    const ant = mkdtempSync(join(tmpdir(), 'hoptools-ant-'));   // workspace 外的"spec 目录"
    mkdirSync(join(ant, 'data'), { recursive: true });
    writeFileSync(join(ant, 'data', 'a.csv'), 'k,v\n1,2\n', 'utf-8');
    return { ws, ant, p: makeProviderAllowing(ws, [ant]) };
  }

  it('正例：read / exists / listdir / search_file 对 allowed 内绝对路径放行（workspace 外）', async () => {
    const { ant, p } = setup();
    const r = await p.execute('read', { path: join(ant, 'data', 'a.csv') });
    expect(r.success, String(r.result)).toBe(true);
    expect(String(r.result)).toContain('k,v');
    const e = await p.execute('exists', { path: join(ant, 'data', 'a.csv') });
    expect(e.success).toBe(true);
    expect(JSON.parse(String(e.result)).exists).toBe(true);
    const l = await p.execute('listdir', { path: join(ant, 'data') });
    expect(l.success, String(l.result)).toBe(true);
    const sf = await p.execute('search_file', { path: join(ant, 'data', 'a.csv'), pattern: '1,2' });
    expect(sf.success, String(sf.result)).toBe(true);
  });

  it('反例：不在 allowed 内的 workspace 外绝对路径,读仍拒（变异：删 read 档分支本例不变,删 allowed 判本例红）', async () => {
    const { p } = setup();
    const other = mkdtempSync(join(tmpdir(), 'hoptools-other-'));
    writeFileSync(join(other, 'x.txt'), 'x', 'utf-8');
    const r = await p.execute('read', { path: join(other, 'x.txt') });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('Absolute path outside workspace');
  });

  it('反例：写类不认 allowed——commit 语境 write / append / create / makedirs / remove 到 allowed 内绝对路径全拒,文件不落', async () => {
    const { ant, p } = setup();
    for (const [tool, args] of [
      ['write', { path: join(ant, 'data', 'new.txt'), content: 'v' }],
      ['append', { path: join(ant, 'data', 'a.csv'), content: 'x' }],
      ['create', { path: join(ant, 'data', 'c.txt'), content: 'v' }],
      ['makedirs', { path: join(ant, 'data', 'sub') }],
      ['remove', { path: join(ant, 'data', 'a.csv') }],
    ] as const) {
      const r = await p.execute(tool, args as Record<string, unknown>, 'workspace');
      expect(r.success, `${tool} 应拒`).toBe(false);
      expect(String(r.result)).toMatch(/Absolute path outside workspace|outside workspace/);
    }
    expect(existsSync(join(ant, 'data', 'new.txt'))).toBe(false);
    expect(readFileSync(join(ant, 'data', 'a.csv'), 'utf-8')).toBe('k,v\n1,2\n');
  });

  it('反例：run_script 走 strict 档——allowed 内的 .py 不被当作可执行脚本（寻址面不扩到 spec 目录,作者定）', async () => {
    const { ant, p } = setup();
    writeFileSync(join(ant, 'data', 'x.py'), 'print(1)\n', 'utf-8');
    const r = await p.execute('run_script', { path: join(ant, 'data', 'x.py') });
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('Absolute path outside workspace');
  });

  it('反例：allowed 内绝对路径带 .. 仍拒;denied 模式命中仍拒（read 档不绕过后续校验链）', async () => {
    const { ws, ant } = setup();
    const p = new DefaultToolProvider({
      workspace_dir: ws,
      sandbox: { filesystem: { workspace_dir: ws, read_access: { allowed: [ws, ant], denied: ['a.csv'], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'test',
    });
    const r1 = await p.execute('read', { path: join(ant, 'data', '..', 'data', 'a.csv') });
    expect(r1.success).toBe(false);
    const r2 = await p.execute('read', { path: join(ant, 'data', 'a.csv') });
    expect(r2.success).toBe(false);
    expect(String(r2.result)).toContain('Read denied');
  });
});

// work_zone 涂鸦区豁免（2026-08-10 作者定 work_zone_path）：.hopstate 禁令的唯一豁免。
// 豁免只对登记过的本 run 涂鸦区生效（todo/0124）——测试先 registerWorkZoneRoot 再走链。
// @v: anc-exec-work-zone, anc-exec-work-zone-path, anc-exec-work-zone-registry
describe('work_zone 涂鸦区豁免', () => {
  it('正例：登记后 work_zone 绝对路径读写放行（.hopstate 内）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
    const wz = join(dir, '.hopstate', 'inst-1', 'work_zone');
    mkdirSync(wz, { recursive: true });
    const p = makeProvider(dir);
    ownWz(p, wz);
    const target = join(wz, 'draft.md');
    expect((await p.execute('write', { path: target, content: 'v' })).success).toBe(true);
    expect((await p.execute('read', { path: target })).result).toBe('v');
    expect((await p.execute('remove', { path: target })).success).toBe(true);
  });
  it('反例：.hopstate 非 work_zone 区仍拒；work_zone 伪装带 .. 仍拒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
    mkdirSync(join(dir, '.hopstate', 'inst-1', 'work_zone'), { recursive: true });
    const p = makeProvider(dir);
    ownWz(p, join(dir, '.hopstate', 'inst-1', 'work_zone'));
    expect((await p.execute('write', { path: join(dir, '.hopstate', 'inst-1', 'state.json'), content: '{}' })).success).toBe(false);
    // 字符串拼接保留字面 ..（path.join 会把 .. 折叠掉,原写法与上一断言同路径——review 面三抓出的假反例）
    const dotdot = await p.execute('write', { path: join(dir, '.hopstate', 'inst-1', 'work_zone') + '/../state.json', content: '{}' });
    expect(dotdot.success).toBe(false);
    expect(String(dotdot.result)).toContain('Path traversal');
  });
});

// 写侧分域（2026-08-28 作者定,契约 [[tools/file-tools#^anc-exec-builtin-file-tools]]）：act/check 语境
// （write_scope='work_zone',亦是缺省——信号缺席按窄域拒）写域仅 work_zone;commit 语境
// （'workspace'）才可写全域。触发实撞：fact-check 真机跑 act free 步把中间 yaml 写到
// workspace 根——free 步能 read 工作区一切,散落物会被后续步/并行兄弟读到（自污染）。
// @v: anc-exec-write-scope, anc-exec-work-zone-registry
describe('写侧分域（act 限 work_zone / commit 限 workspace）', () => {
  it('正例：act 语境（缺省窄域）写登记过的 work_zone 放行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
    const wz = join(dir, '.hopstate', 'inst-1', 'work_zone');
    mkdirSync(wz, { recursive: true });
    const p = makeProvider(dir);
    ownWz(p, wz);
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
    ownWz(p, wz);
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

// work_zone 豁免只认本 run 自己的涂鸦区集合（todo/0124,作者定"这个任务就应该直接把 work_zone 目录记下来"）：
// 原字面正则让 workspace 外任何含 .hopstate/<x>/work_zone 字面的路径都能读写、原模块级注册表让同进程
// 别的 run 互相可读写——两支退役,集合归提供者实例。变异回放:validateFileAccess 或 resolvePath 任一处换回
// 字面正则,下方反例即红（两处都是生效点,只改一处另一处照样放行）。
// @v: anc-exec-work-zone-registry
describe('work_zone 豁免不认 workspace 外的惯例名', () => {
  const outsideTree = () => {
    const base = mkdtempSync(join(tmpdir(), 'hopwz0124-'));
    const ws = join(base, 'ws'); mkdirSync(ws);
    const outside = join(base, 'out'); mkdirSync(outside);
    return { base, ws, outside };
  };
  it('反例：直接写 workspace 外含 .hopstate/a/work_zone 字面的绝对路径——act 与 commit 两种写域都拒,外部目录零新文件', async () => {
    const { ws, outside } = outsideTree();
    const p = makeProvider(ws);
    const fake = join(outside, '.hopstate', 'a', 'work_zone');
    // 拒因须是解析层契约报文（^anc-exec-tool-path-resolve:workspace 外绝对路径点名 workspace 根）,不是写域闸兜底——
    // resolvePath 的捷径若换回字面正则,路径会漏到 validateFileAccess 才被拦,报文退化为 WORK_ZONE_ONLY/Write outside
    const r1 = await p.execute('makedirs', { path: fake });
    expect(r1.success).toBe(false);
    expect(String(r1.result)).toContain('Absolute path outside workspace');
    expect((await p.execute('makedirs', { path: fake }, 'workspace')).success).toBe(false);
    mkdirSync(fake, { recursive: true });   // 就算目录已在,写也不许
    const r2 = await p.execute('write', { path: join(fake, 'x.txt'), content: 'X' });
    expect(r2.success).toBe(false);
    expect(String(r2.result)).toContain('Absolute path outside workspace');
    const r3 = await p.execute('write', { path: join(fake, 'x.txt'), content: 'X' }, 'workspace');
    expect(r3.success).toBe(false);
    expect(String(r3.result)).toContain('Absolute path outside workspace');
    expect(existsSync(join(fake, 'x.txt'))).toBe(false);
  });
  it('反例：读别的项目的涂鸦区（.hopstate/run9/work_zone 字面在 workspace 外）——read 与 listdir 都拒', async () => {
    const { ws, outside } = outsideTree();
    const other = join(outside, 'otherproj', '.hopstate', 'run9', 'work_zone');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'secret.txt'), 'S');
    const p = makeProvider(ws);
    const rr = await p.execute('read', { path: join(other, 'secret.txt') });
    expect(rr.success).toBe(false);
    expect(String(rr.result)).toContain('Absolute path outside workspace');
    expect((await p.execute('listdir', { path: other })).success).toBe(false);
  });
  it('反例：经 workspace 内软链到外部、再拼出惯例名——真实路径不在集合里,拒', async () => {
    const { ws, outside } = outsideTree();
    symlinkSync(outside, join(ws, 'lout'));
    const p = makeProvider(ws);
    const viaLink = join(ws, 'lout', '.hopstate', 'a', 'work_zone');
    expect((await p.execute('makedirs', { path: viaLink })).success).toBe(false);
    mkdirSync(join(outside, '.hopstate', 'a', 'work_zone'), { recursive: true });
    expect((await p.execute('write', { path: join(viaLink, 'x.txt'), content: 'X' })).success).toBe(false);
    expect(existsSync(join(outside, '.hopstate', 'a', 'work_zone', 'x.txt'))).toBe(false);
  });
  it('反例：同进程另一个 run（另一个提供者）登记的 work_zone,本提供者不放行——集合按实例不按进程', async () => {
    const { ws } = outsideTree();
    const wsB = mkdtempSync(join(tmpdir(), 'hopwz0124-B-'));
    const wzB = join(wsB, '.hopstate', 'run-b', 'work_zone');
    mkdirSync(wzB, { recursive: true });
    writeFileSync(join(wzB, 'b.txt'), 'B');
    const pA = makeProvider(ws);
    const pB = makeProvider(wsB);
    ownWz(pB, wzB);
    expect((await pB.execute('read', { path: join(wzB, 'b.txt') })).result).toBe('B');
    expect((await pA.execute('read', { path: join(wzB, 'b.txt') })).success).toBe(false);
    expect((await pA.execute('write', { path: join(wzB, 'a-wrote.txt'), content: 'A' })).success).toBe(false);
    expect(existsSync(join(wzB, 'a-wrote.txt'))).toBe(false);
  });
  it('反例：登记根的前缀串不误中（/a/work_zone 登记后 /a/work_zonefake 不放行——带分隔符边界）', async () => {
    const { ws } = outsideTree();
    const wz = join(ws, '.hopstate', 'a', 'work_zone');
    mkdirSync(wz, { recursive: true });
    mkdirSync(join(ws, '.hopstate', 'a', 'work_zonefake'), { recursive: true });
    const p = makeProvider(ws);
    ownWz(p, wz);
    expect((await p.execute('write', { path: join(ws, '.hopstate', 'a', 'work_zonefake', 'x'), content: 'X' })).success).toBe(false);
  });
  it('正例：登记后顶层 work_zone 与子实例三段路径（parallel/calls）读写放行', async () => {
    const { ws } = outsideTree();
    const roots = [
      join(ws, '.hopstate', 'abc-123', 'work_zone'),
      join(ws, '.hopstate', 'abc-123', 'parallel', '5.2.1.14', 'work_zone'),
      join(ws, '.hopstate', 'abc-123', 'calls', '3.1', 'work_zone'),
    ];
    const p = makeProvider(ws);
    const tree = join(ws, '.hopstate', 'abc-123');
    for (const r of roots) { mkdirSync(r, { recursive: true }); ownWz(p, r, tree); expect((await p.execute('write', { path: join(r, 'out.json'), content: '{}' })).success).toBe(true); }
    // 当前实例切到顶层后,子实例的产物仍可读（tree 内任意 work_zone）
    ownWz(p, roots[0], tree);
    for (const r of roots) expect((await p.execute('read', { path: join(r, 'out.json') })).result).toBe('{}');
  });
  it('反例转正例：子实例不能写父 work_zone（登记了父根、own=子根 → append 父路径拒）;但能读父 work_zone 的产物（todo/0126 读写分权）', async () => {
    const { ws } = outsideTree();
    const stateDir = join(ws, '.hopstate');
    const parentWz = join(stateDir, 'top-1', 'work_zone');
    const childWz = join(stateDir, 'top-1', 'calls', '5.1.1', 'work_zone');
    mkdirSync(parentWz, { recursive: true }); mkdirSync(childWz, { recursive: true });
    writeFileSync(join(stateDir, 'top-1', 'state.json'), '{}');
    writeFileSync(join(parentWz, 'judgement-log.md'), '# 父台账\n');
    const child = makeProvider(ws);
    for (const r of [childWz, parentWz]) child.registerWorkZoneRoot(r);   // FilePersistence.getWorkZoneRoots 的产物形态
    child.setWorkZoneScope({ own: childWz, tree: join(stateDir, 'top-1') });
    const w = await child.execute('append', { path: join(parentWz, 'judgement-log.md'), content: '- 点\n' });
    expect(w.success).toBe(false);
    expect(String(w.result)).toContain('WORK_ZONE_ONLY');
    expect(readFileSync(join(parentWz, 'judgement-log.md'), 'utf-8')).toBe('# 父台账\n');   // 父文件未被动
    expect((await child.execute('read', { path: join(parentWz, 'judgement-log.md') })).result).toBe('# 父台账\n');   // 读父放行
    expect((await child.execute('append', { path: join(childWz, 'judgement-log.md'), content: '- 点\n' })).success).toBe(true);   // 写自己放行
  });
  it('正例：MemoryPersistence 的 tmpdir 形态 hopjit-workzone-* 登记后放行（原始与真实路径两形态都吃——macOS /var→/private/var）', async () => {
    const { ws } = outsideTree();
    const wz = mkdtempSync(join(tmpdir(), 'hopjit-workzone-'));
    const p = makeProvider(ws);
    ownWz(p, wz);
    expect((await p.execute('write', { path: join(wz, 'x.json'), content: '1' })).success).toBe(true);
    const { realpathSync } = await import('node:fs');
    expect((await p.execute('read', { path: join(realpathSync(wz), 'x.json') })).result).toBe('1');
  });
  it('正例：自定义 state-dir（runtime/hopstate,不含 .hopstate 字面——hopkb 实撞形态）登记后放行,未登记的兄弟 run 照拒', async () => {
    const { ws } = outsideTree();
    const wz = join(ws, 'runtime', 'hopstate', '9d203b30', 'work_zone');
    const sibling = join(ws, 'runtime', 'hopstate', 'other-run', 'work_zone');
    mkdirSync(wz, { recursive: true }); mkdirSync(sibling, { recursive: true });
    const p = makeProvider(ws);
    ownWz(p, wz);
    expect((await p.execute('write', { path: join(wz, 'findings'), content: 'f' })).success).toBe(true);
    expect((await p.execute('write', { path: join(sibling, 'y'), content: 'y' })).success).toBe(false);
  });
  it('正例：经 CompositeToolProvider 登记转发到内置文件成员;派生视图与父同一集合', async () => {
    const { CompositeToolProvider } = await import('../src/tools-composite.js');
    const { ws } = outsideTree();
    const wz = join(ws, '.hopstate', 'c-1', 'work_zone');
    mkdirSync(wz, { recursive: true });
    const config: HostConfig = { workspace_dir: ws, sandbox: { filesystem: { workspace_dir: ws, read_access: { allowed: [ws], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: 'test' };
    const cp = new CompositeToolProvider(config);
    expect((await cp.execute('write', { path: join(wz, 'a.txt'), content: 'a' })).success).toBe(false);
    cp.registerWorkZoneRoot(wz); cp.setWorkZoneScope({ own: wz });
    expect((await cp.execute('write', { path: join(wz, 'a.txt'), content: 'a' })).success).toBe(true);
    const view = cp.forkForParallelChild();
    expect((await view.execute('read', { path: join(wz, 'a.txt') })).result).toBe('a');
  });
  it('正例：Composite 转发给全部实现了 registerWorkZoneRoot 的成员——宿主注入的替身成员也收到（不是只转第一个）', async () => {
    const { CompositeToolProvider } = await import('../src/tools-composite.js');
    const { ws } = outsideTree();
    const got: string[] = [];
    const stub = { list: () => [{ name: 'stub_tool', description: 's', input_schema: { type: 'object' } }], execute: async () => ({ result: '', success: true }), registerWorkZoneRoot: (r: string) => { got.push(r); } };
    const config: HostConfig = { workspace_dir: ws, sandbox: { filesystem: { workspace_dir: ws, read_access: { allowed: [ws], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: 'test', tool_provider: stub };
    const cp = new CompositeToolProvider(config);
    cp.registerWorkZoneRoot('/x/.hopstate/r/work_zone');
    expect(got).toEqual(['/x/.hopstate/r/work_zone']);   // 内置文件成员在前,替身在后——只转 members[0] 则此处为空
  });
  it('反例转正例：登记一条成环软链形态的根不抛错（真实形态解析失败只登记原始形态,fail-closed——todo/0125 条目 2）', async () => {
    const { ws, outside } = outsideTree();
    symlinkSync(join(outside, 'loopB'), join(outside, 'loopA'));
    symlinkSync(join(outside, 'loopA'), join(outside, 'loopB'));
    const p = makeProvider(ws);
    const looped = join(outside, 'loopA', '.hopstate', 'x', 'work_zone');
    expect(() => p.registerWorkZoneRoot(looped)).not.toThrow();
    // 原始形态已登记:字面命中捷径;但目标不可达,写落到校验链真实路径解析处响亮失败而不是静默放行到别处
    const r = await p.execute('write', { path: join(looped, 'a.txt'), content: 'x' });
    expect(r.success).toBe(false);
    // 正常根照常可用——一次病态登记不污染提供者
    const wz = join(ws, '.hopstate', 'ok', 'work_zone'); mkdirSync(wz, { recursive: true });
    ownWz(p, wz);
    expect((await p.execute('write', { path: join(wz, 'b.txt'), content: 'y' })).success).toBe(true);
  });
  it('正例：两形态各自命中——workspace 外的 work_zone 经软链别名登记,原始（别名）写法与真实写法都放行（不依赖 macOS /var 差异;两形态只放一种时各有一半失守）', async () => {
    const { ws, outside: outsideRaw } = outsideTree();
    const { realpathSync } = await import('node:fs');
    const outside = realpathSync(outsideRaw);   // 先剥掉 macOS /tmp→/private/tmp 这层与本用例无关的别名,只留自己建的那一层软链
    // work_zone 在 workspace 外（自定义 state-dir 形态）,经一条别名软链访问——resolveWorkspacePath 兜不住,豁免只能靠集合
    const realWz = join(outside, 'real', 'hopstate', 'r1', 'work_zone');
    mkdirSync(realWz, { recursive: true });
    symlinkSync(join(outside, 'real'), join(outside, 'alias'));
    const viaAlias = join(outside, 'alias', 'hopstate', 'r1', 'work_zone');
    const p = makeProvider(ws);
    ownWz(p, viaAlias);   // 登记别名形态;真实形态由提供者自己解析进集合
    expect((await p.execute('write', { path: join(viaAlias, 'a.txt'), content: 'A' })).success).toBe(true);   // resolvePath 捷径吃原始形态
    expect((await p.execute('read', { path: join(realWz, 'a.txt') })).result).toBe('A');                      // 真实形态直接给也认
    expect((await p.execute('append', { path: join(viaAlias, 'a.txt'), content: 'B' })).success).toBe(true);  // validateFileAccess 吃真实形态
  });
});

// work_zone 写只归本实例、读对实例树开放（todo/0126,作者定"可以读,但不应该能写""祖先、兄弟这些都是避免文件的重复 copy"）。
// 变异回放:validateFileAccess 写侧换回"命中读范围即放行"→下方反例红;读侧去掉 tree 分支→"只按目录布局判"那条正例红
// （mkTree 把四根都登记进了兜底集合,父读子/兄弟互读经兜底也能过——所以专门加一条零登记只靠 tree 的用例锁 tree 分支）。
// @v: anc-exec-work-zone-registry
describe('work_zone 写只归本实例', () => {
  // 一棵实例树:top / top>calls/c1 / top>calls/c2（兄弟）/ top>calls/c1>parallel/g1（孙）
  const mkTree = () => {
    const ws = mkdtempSync(join(tmpdir(), 'hopwz0126-'));
    const top = join(ws, '.hopstate', 'top');
    const c1 = join(top, 'calls', 'c1'); const c2 = join(top, 'calls', 'c2'); const g1 = join(c1, 'parallel', 'g1');
    for (const d of [top, c1, c2, g1]) { mkdirSync(join(d, 'work_zone'), { recursive: true }); writeFileSync(join(d, 'state.json'), '{}'); }
    const wz = (d: string) => join(d, 'work_zone');
    const p = makeProvider(ws);
    // standalone 共用一个提供者：各实例先后都登记过（模拟各自 getWorkZone 推法）
    for (const d of [top, c1, c2, g1]) p.registerWorkZoneRoot(wz(d));
    return { ws, top, c1, c2, g1, wz, p, as: (d: string) => p.setWorkZoneScope({ own: wz(d), tree: top }) };
  };
  it('反例：子写父拒（WORK_ZONE_ONLY）、父写子拒、兄弟互写拒、孙写祖父拒——写只认当前实例自己的 work_zone', async () => {
    const t = mkTree();
    const tryWrite = async (from: string, to: string) => { t.as(from); return t.p.execute('write', { path: join(t.wz(to), 'x.txt'), content: 'X' }); };
    for (const [from, to] of [[t.c1, t.top], [t.top, t.c1], [t.c1, t.c2], [t.c2, t.c1], [t.g1, t.top], [t.g1, t.c2]] as const) {
      const r = await tryWrite(from, to);
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('WORK_ZONE_ONLY');
      expect(existsSync(join(t.wz(to), 'x.txt'))).toBe(false);
    }
    // commit 写域也不放行别人的涂鸦区（.hopstate 禁写兜住）
    t.as(t.c1);
    expect((await t.p.execute('write', { path: join(t.wz(t.top), 'x.txt'), content: 'X' }, 'workspace')).success).toBe(false);
  });
  it('正例：本实例写自己放行;子读父、父读子、兄弟互读、孙读祖父全部放行（tree 内任意 work_zone）', async () => {
    const t = mkTree();
    for (const d of [t.top, t.c1, t.c2, t.g1]) { t.as(d); expect((await t.p.execute('write', { path: join(t.wz(d), 'mine.txt'), content: d })).success).toBe(true); }
    for (const [from, to] of [[t.c1, t.top], [t.top, t.c1], [t.c1, t.c2], [t.g1, t.top], [t.top, t.g1]] as const) {
      t.as(from);
      expect((await t.p.execute('read', { path: join(t.wz(to), 'mine.txt') })).result).toBe(to);
      expect((await t.p.execute('listdir', { path: t.wz(to) })).success).toBe(true);
    }
  });
  it('反例：tree 内但不在 work_zone 段下的文件（state.json/vars.json）读侧不豁免;别的 run 的 work_zone 读写都拒', async () => {
    const t = mkTree();
    t.as(t.c1);
    // state.json 在 tree 内但不在任何 work_zone 段下——走常规读链（workspace 内所以能读,但不是靠豁免;这里验的是它不被当涂鸦区写）
    expect((await t.p.execute('write', { path: join(t.top, 'state.json'), content: '{}' })).success).toBe(false);
    const other = join(t.ws, '.hopstate', 'other-run', 'work_zone'); mkdirSync(other, { recursive: true }); writeFileSync(join(other, 's.txt'), 'S');
    expect((await t.p.execute('write', { path: join(other, 'x.txt'), content: 'X' })).success).toBe(false);
    // other-run 在 workspace 内、.hopstate 下——读侧不豁免时走常规读链:workspace 内可读。这条验的是"不是靠 tree 豁免",用 workspace 外的别 run 验拒
    const outsideRun = join(mkdtempSync(join(tmpdir(), 'hopwz-other-')), '.hopstate', 'r', 'work_zone'); mkdirSync(outsideRun, { recursive: true }); writeFileSync(join(outsideRun, 's.txt'), 'S');
    expect((await t.p.execute('read', { path: join(outsideRun, 's.txt') })).success).toBe(false);
    expect((await t.p.execute('write', { path: join(outsideRun, 'x.txt'), content: 'X' })).success).toBe(false);
  });
  it('正例：只靠目录布局判——零登记任何兄弟/祖先/后代根,只 setWorkZoneScope({own, tree}),读祖先/兄弟/后代 work_zone 仍放行（复用模式子实例独立提供者的真实形态;删 tree 分支即红）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'hopwz0126t-'));
    // state-dir 放 workspace **外**（自定义 --state-dir 形态）：tree 内的 work_zone 不在 workspace 里,常规读链兜不住,
    // 读放行只能来自 tree 分支——放 workspace 内的话 workspace 读链会把它放行,验不到 tree
    const top = join(mkdtempSync(join(tmpdir(), 'hopwz0126-state-')), 'hopstate', 'top');
    const c1 = join(top, 'calls', 'c1'); const c2 = join(top, 'calls', 'c2'); const g1 = join(c1, 'parallel', 'g1');
    const wz = (d: string) => join(d, 'work_zone');
    for (const d of [top, c1, c2, g1]) { mkdirSync(wz(d), { recursive: true }); writeFileSync(join(d, 'state.json'), '{}'); writeFileSync(join(wz(d), 'm.txt'), d); }
    const p = makeProvider(ws);
    p.setWorkZoneScope({ own: wz(c1), tree: top });   // 不 registerWorkZoneRoot 任何根
    for (const d of [top, c2, g1]) expect((await p.execute('read', { path: join(wz(d), 'm.txt') })).result).toBe(d);
    expect((await p.execute('write', { path: join(wz(c1), 'w.txt'), content: 'w' })).success).toBe(true);
    expect((await p.execute('write', { path: join(wz(top), 'w.txt'), content: 'w' })).success).toBe(false);
  });
  it('正例：tree 缺席（MemoryPersistence 形态）时读只认登记过的根;own 切换后旧 own 变只读', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'hopwz0126m-'));
    const a = mkdtempSync(join(tmpdir(), 'hopjit-workzone-')); const b = mkdtempSync(join(tmpdir(), 'hopjit-workzone-'));
    const p = makeProvider(ws);
    p.registerWorkZoneRoot(a); p.registerWorkZoneRoot(b);
    p.setWorkZoneScope({ own: a });
    expect((await p.execute('write', { path: join(a, 'a.txt'), content: 'A' })).success).toBe(true);
    expect((await p.execute('write', { path: join(b, 'b.txt'), content: 'B' })).success).toBe(false);
    p.setWorkZoneScope({ own: b });
    expect((await p.execute('write', { path: join(b, 'b.txt'), content: 'B' })).success).toBe(true);
    expect((await p.execute('write', { path: join(a, 'a2.txt'), content: 'A' })).success).toBe(false);   // 旧 own 只读
    expect((await p.execute('read', { path: join(a, 'a.txt') })).result).toBe('A');   // 登记过的根可读
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
    expect(r.text).toContain('+ → out % text');       // IO 声明在
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



// 钉钉通知工具模块（^anc-tool-dingtalk-notify——todo/0052 正式形态;真发送归真机 probe 不进 vitest,
// 可测面=报文拼装与失败值,fetch 打桩零网络）
// @v: anc-tool-dingtalk-notify, anc-tool-dingtalk-sop
// execute() 的 switch 把四个树工具名派给对应函数——按 case 逐个经 execute 调一次（commit 安全分析批次 review 变异 run20 存活项:case 标签换掉后原测试只直调函数,不经 switch）
// @v: anc-exec-builtin-edit-tree-tool
describe('execute() 对树工具名的派发', () => {
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
  const FRAG = '1. [reason] 判断紧急\n  - ← item\n  + → flag: line  # f\n';
  it('insert_node / replace_node / replace_children / read_spec_tree 四个名字各派到自己的实现（结果带各自的标志字段）', async () => {
    const p = makeProvider();
    const ins = JSON.parse((await p.execute('insert_node', { spec_text: DRAFT, node_path: '2', fragment: FRAG }, 'workspace')).result as string);
    expect(ins.status).toBe('ok');
    expect(ins.renumber_map['2']).toBe('3');
    const rep = JSON.parse((await p.execute('replace_node', { spec_text: DRAFT, node_path: '1.1', fragment: FRAG }, 'workspace')).result as string);
    expect(rep.status).toBe('ok');
    expect(rep.spec_text).toContain('1.1. [reason] 判断紧急');
    const ch = JSON.parse((await p.execute('replace_children', { spec_text: DRAFT, node_path: '1', fragment: FRAG }, 'workspace')).result as string);
    expect(ch.status).toBe('ok');
    expect(ch.spec_text).not.toContain('待展开');
    const rd = JSON.parse((await p.execute('read_spec_tree', { spec_text: DRAFT, mode: 'skeleton' }, 'workspace')).result as string);
    expect(rd.status).toBe('ok');
    expect(rd.text).toContain('2.1. [act] 写清单');
  });
});

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

// @v: anc-exec-tool-manifest-source —— 复用模式指引档分族名单与注册面同源（两份名单都住
// provider-types 共享层〔prompt 层1 消费,不得反向 import 层2 tools〕,同源性靠本钉:两族
// 并起来恰等于注册面的 special 件全集——新增 special 内建件不登记任一族即红）。
// 为什么钉"并集"而不只钉唯一语义源族（2026-09-22 随 run_script 落地改判据）:
// buildToolManifest 的 else 分支本就把名单外的件当原生优先件渲染,所以第二份名单在功能上
// 不必要——它存在是为了守卫的牙。旧钉判"注册面 special 全集 == 唯一语义源族",run_script
// 这种该走原生优先的新件必然让它红,于是加件的人必须停下来想"这件走哪一族";若改成
// 单名单+隐式兜底,加件的人什么都不做就全绿,分族决定被静默替他做了。
describe('复用模式指引档两族名单与 DefaultToolProvider 注册面同源', () => {
  it('正例：注册面上非 basic（即 special 档,缺省 special）的内建件名集合 == 唯一语义源族 ∪ 原生优先族', async () => {
    const { ENGINE_BUILTIN_SPECIAL_TOOL_NAMES, NATIVE_FIRST_BUILTIN_SPECIAL_TOOL_NAMES } = await import('../src/provider-types.js');
    const host: HostConfig = { workspace_dir: tmpdir(), sandbox: { allowed_paths: [], denied_paths: [] } } as unknown as HostConfig;
    const provider = new DefaultToolProvider(host);
    const specialOnRegistry = provider.list().filter(t => (t.category ?? 'special') === 'special').map(t => t.name).sort();
    const bothFamilies = [...ENGINE_BUILTIN_SPECIAL_TOOL_NAMES, ...NATIVE_FIRST_BUILTIN_SPECIAL_TOOL_NAMES].sort();
    expect(specialOnRegistry).toEqual(bothFamilies);
  });

  it('反例：两族不许有交集（同一件工具分进两族=渲染分道判据自相矛盾）', async () => {
    const { ENGINE_BUILTIN_SPECIAL_TOOL_NAMES, NATIVE_FIRST_BUILTIN_SPECIAL_TOOL_NAMES } = await import('../src/provider-types.js');
    const overlap = [...NATIVE_FIRST_BUILTIN_SPECIAL_TOOL_NAMES].filter(n => ENGINE_BUILTIN_SPECIAL_TOOL_NAMES.has(n));
    expect(overlap).toEqual([]);
  });
});

// @v: anc-exec-dirs-grant —— write_access.allowed（Config.dirs.readwrite 经授权）：commit 可写、act/check 仍拒、read 目录 commit 写仍拒、denied 仍拦、未声明照拒
describe('write_access.allowed 写域（Config.dirs.readwrite,todo/0148）', () => {
  function mk(ws: string, readOnly: string[], readWrite: string[]): DefaultToolProvider {
    const config: HostConfig = {
      workspace_dir: ws,
      sandbox: {
        filesystem: {
          workspace_dir: ws,
          read_access: { allowed: [ws, ...readOnly, ...readWrite], denied: ['*.key'], confirm_required: [] },
          write_access: { allowed: readWrite },
        },
        network: { trusted_hosts: [] }, runtime: { available: [] },
      },
      api_key: 'test',
    };
    return new DefaultToolProvider(config);
  }
  function setup() {
    const ws = mkdtempSync(join(tmpdir(), 'hopdirs-ws-'));
    const ro = mkdtempSync(join(tmpdir(), 'hopdirs-ro-'));
    const rw = mkdtempSync(join(tmpdir(), 'hopdirs-rw-'));
    const other = mkdtempSync(join(tmpdir(), 'hopdirs-other-'));
    writeFileSync(join(ro, 'a.txt'), 'ro', 'utf-8'); writeFileSync(join(rw, 'b.txt'), 'rw', 'utf-8'); writeFileSync(join(rw, 'secret.key'), 'k', 'utf-8');
    return { ws, ro, rw, other, p: mk(ws, [ro], [rw]) };
  }

  it('正例：commit 语境 write / append / create / makedirs 到 readwrite 目录放行,文件真落;读也放行', async () => {
    const { rw, p } = setup();
    expect((await p.execute('write', { path: join(rw, 'out.md'), content: 'x' }, 'workspace')).success).toBe(true);
    expect(readFileSync(join(rw, 'out.md'), 'utf-8')).toBe('x');
    expect((await p.execute('append', { path: join(rw, 'b.txt'), content: '+' }, 'workspace')).success).toBe(true);
    expect((await p.execute('makedirs', { path: join(rw, 'sub') }, 'workspace')).success).toBe(true);
    expect((await p.execute('create', { path: join(rw, 'c.txt'), content: 'c' }, 'workspace')).success).toBe(true);
    expect(readFileSync(join(rw, 'c.txt'), 'utf-8')).toBe('c');
    expect((await p.execute('read', { path: join(rw, 'b.txt') })).success).toBe(true);
  });
  it('正例：commit 语境 edit_file / move / remove 到 readwrite 目录放行;反例：move 跨域（源在 readwrite、目标在只读 read 目录,或反向）两端都过写侧校验 → 拒且源目标都不动——字面路径在解析层拒,经 readwrite 内软链指向 read 目录的路径解析层放行、校验层拒（变异：move 去掉目标或源的写侧校验本例红）', async () => {
    const { ro, rw, p } = setup();
    expect((await p.execute('edit_file', { path: join(rw, 'b.txt'), old_text: 'rw', new_text: 'RW' }, 'workspace')).success).toBe(true);
    expect(readFileSync(join(rw, 'b.txt'), 'utf-8')).toBe('RW');
    expect((await p.execute('move', { from: join(rw, 'b.txt'), to: join(rw, 'moved.txt') }, 'workspace')).success).toBe(true);
    expect(existsSync(join(rw, 'b.txt'))).toBe(false); expect(readFileSync(join(rw, 'moved.txt'), 'utf-8')).toBe('RW');
    expect((await p.execute('remove', { path: join(rw, 'moved.txt') }, 'workspace')).success).toBe(true);
    expect(existsSync(join(rw, 'moved.txt'))).toBe(false);
    writeFileSync(join(rw, 'src.txt'), 's', 'utf-8');
    const out = await p.execute('move', { from: join(rw, 'src.txt'), to: join(ro, 'dst.txt') }, 'workspace');
    expect(out.success).toBe(false);
    expect(existsSync(join(rw, 'src.txt'))).toBe(true); expect(existsSync(join(ro, 'dst.txt'))).toBe(false);
    const back = await p.execute('move', { from: join(ro, 'a.txt'), to: join(rw, 'a.txt') }, 'workspace');
    expect(back.success).toBe(false);
    expect(existsSync(join(ro, 'a.txt'))).toBe(true); expect(existsSync(join(rw, 'a.txt'))).toBe(false);
    symlinkSync(ro, join(rw, 'link-ro'));
    const viaLinkOut = await p.execute('move', { from: join(rw, 'src.txt'), to: join(rw, 'link-ro', 'dst.txt') }, 'workspace');
    expect(viaLinkOut.success).toBe(false);
    expect(existsSync(join(rw, 'src.txt'))).toBe(true); expect(existsSync(join(ro, 'dst.txt'))).toBe(false);
    const viaLinkIn = await p.execute('move', { from: join(rw, 'link-ro', 'a.txt'), to: join(rw, 'a2.txt') }, 'workspace');
    expect(viaLinkIn.success).toBe(false);
    expect(existsSync(join(ro, 'a.txt'))).toBe(true); expect(existsSync(join(rw, 'a2.txt'))).toBe(false);
  });
  it('反例：act/check 语境（缺省 work_zone 写域）写 readwrite 目录仍拒 WORK_ZONE_ONLY——readwrite 不放大探索步权限', async () => {
    const { rw, p } = setup();
    const r = await p.execute('write', { path: join(rw, 'act.md'), content: 'x' });
    expect(r.success).toBe(false); expect(String(r.result)).toContain('WORK_ZONE_ONLY');
    expect(existsSync(join(rw, 'act.md'))).toBe(false);
  });
  it('反例：read（只读档）目录 commit 写仍拒;读放行', async () => {
    const { ro, p } = setup();
    const r = await p.execute('write', { path: join(ro, 'x.md'), content: 'x' }, 'workspace');
    expect(r.success).toBe(false); expect(String(r.result)).toMatch(/outside workspace/);
    expect((await p.execute('read', { path: join(ro, 'a.txt') })).success).toBe(true);
  });
  it('反例：denied 基线对 readwrite 目录仍优先拦读', async () => {
    const { rw, p } = setup();
    const r = await p.execute('read', { path: join(rw, 'secret.key') });
    expect(r.success).toBe(false); expect(String(r.result)).toContain('denied');
  });
  it('反例：未声明的 workspace 外目录读写照拒（变异：删 write_access 判本例不变——边界变异由下方软链兄弟前缀例钉）', async () => {
    const { other, p } = setup();
    expect((await p.execute('read', { path: join(other, 'z') })).success).toBe(false);
    expect((await p.execute('write', { path: join(other, 'z.md'), content: 'x' }, 'workspace')).success).toBe(false);
  });
  it('反例：兄弟前缀目录不算在 readwrite 内（/x/rw2 不算 /x/rw）——字面路径在解析层拒;经 readwrite 内软链指向兄弟目录的路径解析层放行、校验层按真实路径带分隔符边界拒（变异：写域退回裸 startsWith 本例红）', async () => {
    const { rw, p } = setup();
    const sib = rw + '2'; mkdirSync(sib, { recursive: true });
    expect((await p.execute('write', { path: join(sib, 'x.md'), content: 'x' }, 'workspace')).success).toBe(false);
    symlinkSync(sib, join(rw, 'to-sib'));
    const viaLink = await p.execute('write', { path: join(rw, 'to-sib', 'y.md'), content: 'x' }, 'workspace');
    expect(viaLink.success).toBe(false);
    expect(existsSync(join(sib, 'y.md'))).toBe(false);
  });
  it('反例：经 readwrite 内软链指向 read（只读）目录——解析层放行、校验层按真实路径查写白名单拒（变异：写域误用读白名单本例红）', async () => {
    const { ro, rw, p } = setup();
    symlinkSync(ro, join(rw, 'to-ro'));
    const r = await p.execute('write', { path: join(rw, 'to-ro', 'z.md'), content: 'x' }, 'workspace');
    expect(r.success).toBe(false);
    expect(existsSync(join(ro, 'z.md'))).toBe(false);
  });
});

// 文件写类四件的 keep 参数:覆盖、移动替换、删除前把旧版本留存进 <状态目录>/recycle/,同一文件每次 run 只留存一次,
// 轮转保留最近 keep 份;keep=0 不留存;work_zone 豁免;keep 不是非负整数即拒。
// @v: anc-exec-file-keep-recycle
describe('keep 参数与回收站', () => {
  const setup = (run = 'run1') => {
    const ws = mkdtempSync(join(tmpdir(), 'keep-ws-'));
    const p = makeProvider(ws);
    const tree = join(ws, '.hopstate', run);
    ownWz(p, join(tree, 'work_zone'), tree);
    mkdirSync(join(tree, 'work_zone'), { recursive: true });
    return { ws, p, tree, recycle: join(ws, '.hopstate', 'recycle') };
  };
  const copiesOf = (dir: string, name: string): string[] =>
    existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith(`${name}.`)).sort() : [];

  it('正例：覆盖已有文件 → 旧内容留存进回收站,回执注明位置;同一 run 再次覆盖不再留存,回执指向本次运行开始前的版本;接管账记一条', async () => {
    const { ws, p, tree, recycle } = setup();
    writeFileSync(join(ws, 'a.txt'), 'v0');
    const r1 = await p.execute('write', { path: 'a.txt', content: 'v1' }, 'workspace');
    expect(r1.success).toBe(true);
    expect(String(r1.result)).toContain('旧版本已存到');
    const copies = copiesOf(recycle, 'a.txt');
    expect(copies.length).toBe(1);
    expect(readFileSync(join(recycle, copies[0]!), 'utf-8')).toBe('v0');
    const r2 = await p.execute('write', { path: 'a.txt', content: 'v2' }, 'workspace');
    expect(String(r2.result)).toContain('本次运行开始前的版本已存于');
    expect(copiesOf(recycle, 'a.txt').length).toBe(1);   // 一次 run 只轮换一次
    expect(readFileSync(join(ws, 'a.txt'), 'utf-8')).toBe('v2');
    const ledger = JSON.parse(readFileSync(join(tree, 'recycle_ledger.json'), 'utf-8'));
    expect(Object.keys(ledger).length).toBe(1);
  });

  it('正例：keep=0 不留存;同一 run 先 keep=0 覆盖后,再用缺省 keep 覆盖也不留存（本次运行开始前的内容已经没了,留下的只是本 run 自己写的）', async () => {
    const { ws, p, recycle } = setup();
    writeFileSync(join(ws, 'b.txt'), 'v0');
    expect((await p.execute('write', { path: 'b.txt', content: 'v1', keep: 0 }, 'workspace')).success).toBe(true);
    expect(copiesOf(recycle, 'b.txt')).toEqual([]);
    await p.execute('write', { path: 'b.txt', content: 'v2' }, 'workspace');
    expect(copiesOf(recycle, 'b.txt')).toEqual([]);
  });

  it('正例：新建文件不留存,同一 run 之后再覆盖它也不留存（本 run 自己建的）', async () => {
    const { p, recycle } = setup();
    await p.execute('write', { path: 'n.txt', content: 'v1' }, 'workspace');
    await p.execute('write', { path: 'n.txt', content: 'v2' }, 'workspace');
    expect(copiesOf(recycle, 'n.txt')).toEqual([]);
  });

  it('正例：remove 缺省进回收站,keep=0 永久删除;move 替换已有目标时留存目标的旧版本', async () => {
    const { ws, p, recycle } = setup();
    writeFileSync(join(ws, 'd.txt'), 'D');
    const rd = await p.execute('remove', { path: 'd.txt' }, 'workspace');
    expect(rd.success).toBe(true);
    expect(existsSync(join(ws, 'd.txt'))).toBe(false);
    expect(readFileSync(join(recycle, copiesOf(recycle, 'd.txt')[0]!), 'utf-8')).toBe('D');
    writeFileSync(join(ws, 'e.txt'), 'E');
    expect((await p.execute('remove', { path: 'e.txt', keep: 0 }, 'workspace')).success).toBe(true);
    expect(copiesOf(recycle, 'e.txt')).toEqual([]);
    writeFileSync(join(ws, 'src.txt'), 'NEW');
    writeFileSync(join(ws, 'dst.txt'), 'OLD');
    expect((await p.execute('move', { from: 'src.txt', to: 'dst.txt' }, 'workspace')).success).toBe(true);
    expect(readFileSync(join(ws, 'dst.txt'), 'utf-8')).toBe('NEW');
    expect(readFileSync(join(recycle, copiesOf(recycle, 'dst.txt')[0]!), 'utf-8')).toBe('OLD');
    expect(copiesOf(recycle, 'src.txt')).toEqual([]);   // 源内容原样到了目标,不留存
  });

  it('正例：跨 run 轮转——五次 run 各覆盖一次、keep=3 → 回收站只剩最近三份旧版本（v2/v3/v4）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'keep-rot-'));
    writeFileSync(join(ws, 'r.txt'), 'v0');
    for (let k = 1; k <= 5; k++) {
      const p = makeProvider(ws);
      const tree = join(ws, '.hopstate', `run${k}`);
      ownWz(p, join(tree, 'work_zone'), tree);
      expect((await p.execute('write', { path: 'r.txt', content: `v${k}`, keep: 3 }, 'workspace')).success).toBe(true);
    }
    const recycle = join(ws, '.hopstate', 'recycle');
    const kept = copiesOf(recycle, 'r.txt').map(f => readFileSync(join(recycle, f), 'utf-8')).sort();
    expect(kept).toEqual(['v2', 'v3', 'v4']);
  });

  it('反例：work_zone 内的覆盖与删除不留存、不入接管账', async () => {
    const { p, tree, recycle } = setup();
    const f = join(tree, 'work_zone', 'scratch.txt');
    writeFileSync(f, 'S');
    expect((await p.execute('write', { path: f, content: 'S2' })).success).toBe(true);
    expect((await p.execute('remove', { path: f })).success).toBe(true);
    expect(existsSync(recycle)).toBe(false);
    expect(existsSync(join(tree, 'recycle_ledger.json'))).toBe(false);
  });

  it('正例：remove 带 keep=0 永久删除后,同一 run 里该路径被工具之外的手段重新建出（如外部命令）,再用缺省 keep 覆盖也不留存（run 前的内容已被本 run 删掉,接管账记 created）', async () => {
    const { ws, p, tree, recycle } = setup();
    writeFileSync(join(ws, 'g.txt'), 'v0');
    const key = realpathSync(join(ws, 'g.txt'));
    expect((await p.execute('remove', { path: 'g.txt', keep: 0 }, 'workspace')).success).toBe(true);
    expect(JSON.parse(readFileSync(join(tree, 'recycle_ledger.json'), 'utf-8'))[key]).toEqual({ created: true });
    writeFileSync(join(ws, 'g.txt'), 'ext');
    expect((await p.execute('write', { path: 'g.txt', content: 'v2' }, 'workspace')).success).toBe(true);
    expect(copiesOf(recycle, 'g.txt')).toEqual([]);
  });

  it('反例：目标是目录（不是普通文件）→ 不留存、回收站不建件;write 与 remove 按原语自身的报错失败,报文不是"旧版本留存失败"', async () => {
    const { ws, p, recycle } = setup();
    mkdirSync(join(ws, 'dir1'));
    const rw = await p.execute('write', { path: 'dir1', content: 'x' }, 'workspace');
    expect(rw.success).toBe(false);
    expect(String(rw.result)).not.toContain('旧版本留存失败');
    const rr = await p.execute('remove', { path: 'dir1' }, 'workspace');
    expect(rr.success).toBe(false);
    expect(String(rr.result)).not.toContain('旧版本留存失败');
    expect(existsSync(join(ws, 'dir1'))).toBe(true);
    expect(existsSync(recycle)).toBe(false);
  });

  it('反例：work_zone 内新建文件、keep=0 覆盖也不入接管账（noteLedger 的 work_zone 跳过）', async () => {
    const { p, tree } = setup();
    const wz = join(tree, 'work_zone');
    expect((await p.execute('write', { path: join(wz, 'fresh.txt'), content: 'F' })).success).toBe(true);
    expect((await p.execute('create', { path: join(wz, 'fresh2.txt'), content: 'F' })).success).toBe(true);
    writeFileSync(join(wz, 'old.txt'), 'O');
    expect((await p.execute('write', { path: join(wz, 'old.txt'), content: 'O2', keep: 0 })).success).toBe(true);
    expect(existsSync(join(tree, 'recycle_ledger.json'))).toBe(false);
  });

  it('正例：edit_file 改已有文件 → 改之前的旧版本留存进回收站并入账', async () => {
    const { ws, p, tree, recycle } = setup();
    writeFileSync(join(ws, 'ed.txt'), 'hello world');
    const r = await p.execute('edit_file', { path: 'ed.txt', old_text: 'world', new_text: 'there' }, 'workspace');
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain('旧版本已存到');
    expect(readFileSync(join(ws, 'ed.txt'), 'utf-8')).toBe('hello there');
    const copies = copiesOf(recycle, 'ed.txt');
    expect(copies.length).toBe(1);
    expect(readFileSync(join(recycle, copies[0]!), 'utf-8')).toBe('hello world');
    const ledger = JSON.parse(readFileSync(join(tree, 'recycle_ledger.json'), 'utf-8'));
    expect(ledger[realpathSync(join(ws, 'ed.txt'))]).toEqual({ copy: join(recycle, copies[0]!) });
  });

  it('正例：父子实例两个提供者共用同一个 tree → 同一 run 内同一文件只留存一次', async () => {
    const { ws, p, tree, recycle } = setup();
    const child = makeProvider(ws);
    const childWz = join(tree, 'children', 'c1', 'work_zone');
    mkdirSync(childWz, { recursive: true });
    child.setWorkZoneScope({ own: childWz, tree });
    writeFileSync(join(ws, 'shared.txt'), 'v0');
    expect((await p.execute('write', { path: 'shared.txt', content: 'v1' }, 'workspace')).success).toBe(true);
    const r2 = await child.execute('write', { path: 'shared.txt', content: 'v2' }, 'workspace');
    expect(r2.success).toBe(true);
    expect(String(r2.result)).toContain('本次运行开始前的版本已存于');
    const copies = copiesOf(recycle, 'shared.txt');
    expect(copies.length).toBe(1);
    expect(readFileSync(join(recycle, copies[0]!), 'utf-8')).toBe('v0');
  });

  it('反例：留存拷贝失败（回收站位置被普通文件占住）→ 写入与删除都不执行,原文件不变', async () => {
    const { ws, p, recycle } = setup();
    mkdirSync(join(ws, '.hopstate'), { recursive: true });
    writeFileSync(recycle, 'not a dir');
    writeFileSync(join(ws, 'f.txt'), 'ORIG');
    const rw = await p.execute('write', { path: 'f.txt', content: 'NEW' }, 'workspace');
    expect(rw.success).toBe(false);
    expect(String(rw.result)).toContain('旧版本留存失败');
    expect(readFileSync(join(ws, 'f.txt'), 'utf-8')).toBe('ORIG');
    const rd = await p.execute('remove', { path: 'f.txt' }, 'workspace');
    expect(rd.success).toBe(false);
    expect(existsSync(join(ws, 'f.txt'))).toBe(true);
  });

  it('反例：接管账文件损坏（不是 JSON、是数组）→ 按空账处理,覆盖照常留存旧版本、不抛错,账被重写成合法对象', async () => {
    for (const bad of ['{not json', '[1,2]']) {
      const { ws, p, tree, recycle } = setup();
      mkdirSync(tree, { recursive: true });
      writeFileSync(join(tree, 'recycle_ledger.json'), bad);
      writeFileSync(join(ws, 'c.txt'), 'C0');
      const r = await p.execute('write', { path: 'c.txt', content: 'C1' }, 'workspace');
      expect(r.success).toBe(true);
      expect(copiesOf(recycle, 'c.txt').length).toBe(1);   // 坏账当空账:按"本 run 第一次碰"留存——多留一份,不丢内容
      const ledger = JSON.parse(readFileSync(join(tree, 'recycle_ledger.json'), 'utf-8'));
      expect(Array.isArray(ledger)).toBe(false);
      expect(Object.keys(ledger).length).toBe(1);
    }
  });

  it('正例：没有实例目录（未推 tree）时用内存接管账——同一提供者两次覆盖同一文件只留存一次', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'keep-mem-'));
    const p = makeProvider(ws);
    const name = `mem-${ws.slice(-6)}.txt`;   // 内存账模式的回收站在系统临时区,文件名带随机后缀免与并行用例撞名
    writeFileSync(join(ws, name), 'v0');
    const r1 = await p.execute('write', { path: name, content: 'v1' }, 'workspace');
    expect(r1.success).toBe(true);
    const m = /旧版本已存到 (\S+)（/.exec(String(r1.result));
    expect(m).not.toBeNull();
    expect(readFileSync(m![1]!, 'utf-8')).toBe('v0');
    const r2 = await p.execute('write', { path: name, content: 'v2' }, 'workspace');
    expect(String(r2.result)).toContain(`本次运行开始前的版本已存于 ${m![1]}`);
    expect(existsSync(join(ws, '.hopstate'))).toBe(false);   // 不落账文件
  });

  it('正例：move 把源文件的接管账条目移交给目标——之后再覆盖目标按"本 run 自己建的"不留存', async () => {
    const { ws, p, tree, recycle } = setup();
    expect((await p.execute('write', { path: 'born.txt', content: 'B' }, 'workspace')).success).toBe(true);   // 本 run 新建 → {created:true}
    writeFileSync(join(ws, 'target.txt'), 'T0');
    expect((await p.execute('move', { from: 'born.txt', to: 'target.txt' }, 'workspace')).success).toBe(true);
    const ledger = JSON.parse(readFileSync(join(tree, 'recycle_ledger.json'), 'utf-8'));
    const realWs = realpathSync(ws);
    expect(ledger[join(realWs, 'target.txt')]).toEqual({ created: true });
    expect(ledger[join(realWs, 'born.txt')]).toBeUndefined();
    expect(readFileSync(join(recycle, copiesOf(recycle, 'target.txt')[0]!), 'utf-8')).toBe('T0');   // 被替换的旧目标照常留存
    await p.execute('write', { path: 'target.txt', content: 'T2' }, 'workspace');
    expect(copiesOf(recycle, 'target.txt').length).toBe(1);
  });

  it('正例：已留存过的文件再用 keep=0 覆盖或 edit_file → 接管账改记 created（write 的"!existed 或 keep == 0"、edit_file 的"keep == 0"入账条件）', async () => {
    const { ws, p, tree, recycle } = setup();
    writeFileSync(join(ws, 'r.txt'), 'v0');
    await p.execute('write', { path: 'r.txt', content: 'v1' }, 'workspace');
    const key = join(realpathSync(ws), 'r.txt');
    const read = () => JSON.parse(readFileSync(join(tree, 'recycle_ledger.json'), 'utf-8'));
    expect(read()[key]).toHaveProperty('copy');
    expect((await p.execute('write', { path: 'r.txt', content: 'v2', keep: 0 }, 'workspace')).success).toBe(true);
    expect(read()[key]).toEqual({ created: true });
    expect(copiesOf(recycle, 'r.txt').length).toBe(1);   // 本次运行开始前的版本仍在回收站
    writeFileSync(join(ws, 'q.txt'), 'hello world');
    await p.execute('write', { path: 'q.txt', content: 'hello world' }, 'workspace');
    const keyQ = join(realpathSync(ws), 'q.txt');
    expect(read()[keyQ]).toHaveProperty('copy');
    expect((await p.execute('edit_file', { path: 'q.txt', old_text: 'world', new_text: 'there', keep: 0 }, 'workspace')).success).toBe(true);
    expect(read()[keyQ]).toEqual({ created: true });   // edit_file 的"keep == 0"入账条件
  });

  it('create 与 append 的接管账:create 新建记 created;append 让原本不存在的文件出现记 created;append 到已有文件不记——之后覆盖照常留存 run 前的内容', async () => {
    const { ws, p, tree, recycle } = setup();
    const read = () => JSON.parse(readFileSync(join(tree, 'recycle_ledger.json'), 'utf-8'));
    const key = (name: string) => join(realpathSync(ws), name);
    expect((await p.execute('create', { path: 'c.txt', content: 'C1' }, 'workspace')).success).toBe(true);
    expect(read()[key('c.txt')]).toEqual({ created: true });
    await p.execute('write', { path: 'c.txt', content: 'C2' }, 'workspace');
    expect(copiesOf(recycle, 'c.txt')).toEqual([]);   // 本 run 自己建的,覆盖不留存
    expect((await p.execute('append', { path: 'n.txt', content: 'N1' }, 'workspace')).success).toBe(true);
    expect(read()[key('n.txt')]).toEqual({ created: true });
    await p.execute('write', { path: 'n.txt', content: 'N2' }, 'workspace');
    expect(copiesOf(recycle, 'n.txt')).toEqual([]);
    writeFileSync(join(ws, 'e.txt'), 'E0');
    expect((await p.execute('append', { path: 'e.txt', content: '+E1' }, 'workspace')).success).toBe(true);
    expect(read()[key('e.txt')]).toBeUndefined();   // 文件里仍含 run 前的内容,不算本 run 建的
    await p.execute('write', { path: 'e.txt', content: 'E2' }, 'workspace');
    const copies = copiesOf(recycle, 'e.txt');
    expect(copies.length).toBe(1);
    expect(readFileSync(join(recycle, copies[0]!), 'utf-8')).toBe('E0+E1');
  });

  it('反例：move 的源文件不存在 → 报 ENOENT,已有目标不动、不留存、不入账（源在场才留存目标）', async () => {
    const { ws, p, tree, recycle } = setup();
    writeFileSync(join(ws, 'kept.txt'), 'K0');
    const r = await p.execute('move', { from: 'ghost.txt', to: 'kept.txt' }, 'workspace');
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/ENOENT/);
    expect(readFileSync(join(ws, 'kept.txt'), 'utf-8')).toBe('K0');
    expect(copiesOf(recycle, 'kept.txt')).toEqual([]);
    expect(existsSync(join(tree, 'recycle_ledger.json'))).toBe(false);
  });

  it('反例：keep 不是非负整数（负数、小数、字符串）→ 拒,原文件不动', async () => {
    const { ws, p } = setup();
    writeFileSync(join(ws, 'k.txt'), 'K');
    for (const keep of [-1, 1.5, '3']) {
      const r = await p.execute('write', { path: 'k.txt', content: 'x', keep }, 'workspace');
      expect(r.success).toBe(false);
      expect(String(r.result)).toContain('keep 须是非负整数');
    }
    expect(readFileSync(join(ws, 'k.txt'), 'utf-8')).toBe('K');
  });

  it('keep 缺省值是 3（DEFAULT_KEEP 住 ast-types.ts,引擎停点模板与工具轮转同源）:不传 keep 时连续五次 run 覆盖只留三份', async () => {
    expect(DEFAULT_KEEP).toBe(3);
    const ws = mkdtempSync(join(tmpdir(), 'keep-default-'));
    for (let i = 0; i < 5; i++) {
      const p = makeProvider(ws);
      const tree = join(ws, '.hopstate', `run${i}`);
      ownWz(p, join(tree, 'work_zone'), tree);
      mkdirSync(join(tree, 'work_zone'), { recursive: true });
      if (i === 0) writeFileSync(join(ws, 'k.txt'), 'v0');
      expect((await p.execute('write', { path: 'k.txt', content: `v${i + 1}` }, 'workspace')).success).toBe(true);
    }
    expect(copiesOf(join(ws, '.hopstate', 'recycle'), 'k.txt').length).toBe(3);
  });

  it('工具定义:write / edit_file / move / remove 的 keep 参数类型是 integer、下限 0', () => {
    const defs = makeProvider().list();
    for (const name of ['write', 'edit_file', 'move', 'remove']) {
      const keep = (defs.find(t => t.name === name)!.input_schema as any).properties.keep;
      expect(keep, name).toEqual(expect.objectContaining({ type: 'integer', minimum: 0 }));
    }
  });

  it('回执:move 替换已有目标、remove 删除已有文件,回执都写明旧版本存到了哪里;move 带 keep=0 替换目标不留存', async () => {
    const { ws, p, recycle } = setup();
    writeFileSync(join(ws, 'ms.txt'), 'NEW');
    writeFileSync(join(ws, 'md.txt'), 'OLD');
    const rm = await p.execute('move', { from: 'ms.txt', to: 'md.txt' }, 'workspace');
    expect(String(rm.result)).toMatch(/^Moved ms\.txt → md\.txt 旧版本已存到 /);
    writeFileSync(join(ws, 'del.txt'), 'D');
    const rd = await p.execute('remove', { path: 'del.txt' }, 'workspace');
    expect(String(rd.result)).toMatch(/^Deleted del\.txt 旧版本已存到 /);
    writeFileSync(join(ws, 'ks.txt'), 'NEW');
    writeFileSync(join(ws, 'kd.txt'), 'OLD');
    const rk = await p.execute('move', { from: 'ks.txt', to: 'kd.txt', keep: 0 }, 'workspace');
    expect(rk.success).toBe(true);
    expect(String(rk.result)).toBe('Moved ks.txt → kd.txt');
    expect(copiesOf(recycle, 'kd.txt')).toEqual([]);
  });

  it('轮转只删本文件的留存件:文件名里的点按字面匹配,名字只是以本文件名结尾的别的文件不受影响;刚留存的这份即使排序靠前也不删', async () => {
    const { ws, p, recycle } = setup();
    mkdirSync(recycle, { recursive: true });
    // aXtxt 在点不转义时会被 a.txt 的模式匹配;xa.txt 在模式不锚定开头时会被匹配
    for (const f of ['aXtxt.20200101-000000', 'xa.txt.20200101-000000']) writeFileSync(join(recycle, f), 'other');
    writeFileSync(join(ws, 'a.txt'), 'A0');
    const r = await p.execute('write', { path: 'a.txt', content: 'A1', keep: 1 }, 'workspace');
    expect(r.success).toBe(true);
    expect(existsSync(join(recycle, 'aXtxt.20200101-000000'))).toBe(true);
    expect(existsSync(join(recycle, 'xa.txt.20200101-000000'))).toBe(true);
    // 回收站里已有一份时间戳在未来的留存件:按时间排序后刚留存的这份排在前面,轮转也不删它
    writeFileSync(join(recycle, 'f.txt.29991231-235959'), 'future');
    writeFileSync(join(ws, 'f.txt'), 'F0');
    const rf = await p.execute('write', { path: 'f.txt', content: 'F1', keep: 1 }, 'workspace');
    const copy = /旧版本已存到 (\S+)（/.exec(String(rf.result))![1]!;
    expect(readFileSync(copy, 'utf-8')).toBe('F0');
  });

  it('内存接管账:move 之后源路径的条目删除——源路径被重新建出后再覆盖,按 run 前已有的文件留存', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'keep-memmv-'));
    const p = makeProvider(ws);
    const tag = ws.slice(-6);
    const src = `src-${tag}.txt`;
    const dst = `dst-${tag}.txt`;
    expect((await p.execute('write', { path: src, content: 'S' }, 'workspace')).success).toBe(true);   // 本 run 新建 → created
    expect((await p.execute('move', { from: src, to: dst }, 'workspace')).success).toBe(true);
    writeFileSync(join(ws, src), 'EXT');   // 工具之外重新建出源路径
    const r = await p.execute('write', { path: src, content: 'S2' }, 'workspace');
    const m = /旧版本已存到 (\S+)（/.exec(String(r.result));
    expect(m).not.toBeNull();
    expect(m![1]!.startsWith(join(tmpdir(), 'hopjit-recycle') + '/')).toBe(true);   // 无实例目录时回收站在系统临时区
    expect(readFileSync(m![1]!, 'utf-8')).toBe('EXT');
  });

  // 以下用例逐分支侧钉住被审批次改动的函数（commit 安全分析批次 review 第五次阅卷后,机器枚举分支侧的 run20 存活项）
  // @v: anc-exec-file-keep-recycle
  it('同一秒内多份留存件:序号接着现有最大值加 1（跨过轮转删出的空位）;前缀相同但后缀不是纯数字的文件不算序号', async () => {
    const { ws, p, recycle } = setup();
    mkdirSync(recycle, { recursive: true });
    const fixed = new Date(2030, 0, 2, 3, 4, 5);
    vi.useFakeTimers({ now: fixed, toFake: ['Date'] });
    try {
      const stamp = '20300102-030405';
      // 回收站里已有 a.txt.<stamp>（序号 1）与 a.txt.<stamp>-4,还有一个 a.txt.<stamp>-x（后缀不是数字,不算）
      for (const f of [`a.txt.${stamp}`, `a.txt.${stamp}-4`, `a.txt.${stamp}-x`]) writeFileSync(join(recycle, f), 'old');
      writeFileSync(join(ws, 'a.txt'), 'A0');
      const r = await p.execute('write', { path: 'a.txt', content: 'A1', keep: 9 }, 'workspace');
      expect(String(r.result)).toContain(`旧版本已存到 ${join(recycle, `a.txt.${stamp}-5`)}（`);
      expect(readFileSync(join(recycle, `a.txt.${stamp}-5`), 'utf-8')).toBe('A0');
      // 回收站里这一秒还没有任何留存件:文件名不带序号
      writeFileSync(join(ws, 'b.txt'), 'B0');
      const rb = await p.execute('write', { path: 'b.txt', content: 'B1', keep: 9 }, 'workspace');
      expect(String(rb.result)).toContain(`旧版本已存到 ${join(recycle, `b.txt.${stamp}`)}（`);
    } finally {
      vi.useRealTimers();
    }
  });

  // @v: anc-exec-file-keep-recycle
  it('轮转排序按（时间戳,序号数值）:同一秒的 -2 与 -10 按数值排,-2 先被删;没有序号的那份当作序号 1', async () => {
    const { ws, p, recycle } = setup();
    mkdirSync(recycle, { recursive: true });
    const old = '20200101-000000';
    for (const [f, c] of [[`c.txt.${old}`, 's1'], [`c.txt.${old}-2`, 's2'], [`c.txt.${old}-10`, 's10']] as const) writeFileSync(join(recycle, f), c);
    writeFileSync(join(ws, 'c.txt'), 'C0');
    const r = await p.execute('write', { path: 'c.txt', content: 'C1', keep: 2 }, 'workspace');
    expect(r.success).toBe(true);
    // 四份里留最近两份:刚留存的这份 + 同秒序号最大的 -10;s1（序号 1）与 -2 被删
    expect(existsSync(join(recycle, `c.txt.${old}`))).toBe(false);
    expect(existsSync(join(recycle, `c.txt.${old}-2`))).toBe(false);
    expect(existsSync(join(recycle, `c.txt.${old}-10`))).toBe(true);
  });

  // @v: anc-exec-file-keep-recycle
  it('留存后清理旧件失败（旧留存件的名字被一个非空目录占住,unlink 报 EPERM/EISDIR）→ 写入照常完成,回执末尾带"清理旧留存件失败"', async () => {
    const { ws, p, recycle } = setup();
    mkdirSync(recycle, { recursive: true });
    // 一个名字形如留存件、实际是非空目录的条目:匹配轮转模式,unlinkSync 对目录抛错
    mkdirSync(join(recycle, 'd.txt.20200101-000000', 'inner'), { recursive: true });
    writeFileSync(join(recycle, 'd.txt.20200101-000000', 'inner', 'f'), 'x');
    writeFileSync(join(ws, 'd.txt'), 'D0');
    const r = await p.execute('write', { path: 'd.txt', content: 'D1', keep: 1 }, 'workspace');
    expect(r.success).toBe(true);
    expect(String(r.result)).toMatch(/;清理旧留存件失败：.+/);
    expect(readFileSync(join(ws, 'd.txt'), 'utf-8')).toBe('D1');
    expect(existsSync(join(recycle, 'd.txt.20200101-000000', 'inner', 'f'))).toBe(true);
  });

  // @v: anc-exec-file-keep-recycle
  it('接管账文件内容是 JSON 的 null 或数字 → 按空账处理（对象判断的两个条件）;move 的源文件在账上没有条目时目标不继承条目', async () => {
    const { ws, p, tree, recycle } = setup();
    mkdirSync(tree, { recursive: true });
    for (const content of ['null', '42', '"str"']) {
      writeFileSync(join(tree, 'recycle_ledger.json'), content);
      writeFileSync(join(ws, 'e.txt'), 'E0');
      const r = await p.execute('write', { path: 'e.txt', content: 'E1' }, 'workspace');
      expect(r.success, content).toBe(true);
      expect(String(r.result)).toContain('旧版本已存到');
    }
    // move 的源在账上没有条目:目标不继承;之后覆盖目标（run 前就有的文件内容已换成源内容,目标仍按"run 前已有"留存一次）
    writeFileSync(join(tree, 'recycle_ledger.json'), '{}');
    writeFileSync(join(ws, 'src.txt'), 'S');
    expect((await p.execute('move', { from: 'src.txt', to: 'dst.txt', keep: 0 }, 'workspace')).success).toBe(true);
    const ledger = JSON.parse(readFileSync(join(tree, 'recycle_ledger.json'), 'utf-8'));
    expect(ledger[realpathSync(join(ws, 'dst.txt'))]).toBeUndefined();
    const r2 = await p.execute('write', { path: 'dst.txt', content: 'D2' }, 'workspace');
    expect(String(r2.result)).toContain('旧版本已存到');
    expect(copiesOf(recycle, 'dst.txt').length).toBe(1);
  });

  // @v: anc-exec-file-keep-recycle
  it('setWorkZoneScope:own 为空串时写根集合为空（任何 work_zone 写都按工作区路径处理）;tree 缺席时回收站锚回退为系统临时区', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'keep-scope-'));
    const p = makeProvider(ws);
    p.setWorkZoneScope({ own: '' });
    expect((p as any).ownRoots.size).toBe(0);
    expect((p as any).treeRoots.size).toBe(0);
    expect((p as any).recycleTree).toBeUndefined();
    p.setWorkZoneScope({ own: join(ws, 'wz'), tree: '' });
    expect((p as any).ownRoots.size).toBeGreaterThan(0);
    expect((p as any).recycleTree).toBeUndefined();
  });
});
