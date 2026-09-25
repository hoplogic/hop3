// @module: py-sandbox ^anc-struct-py-sandbox
// Python 语法沙箱:检查器三条规则（scripts/pysb/pysb_check.py）+ 执行契约（src/py-sandbox.ts）。
// 设计权威 docs/design/py-sandbox.md;反例清单来自概念层 §2.2 的实测对照（每条都是实撞过的逃逸）。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkPythonScript, runSandboxedPython, type PySandboxOptions } from '../src/py-sandbox.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(REPO, 'scripts', 'pysb', 'pysb_check.py');

// 解释器真身探测（tools.test.ts 同款纪律:shell alias 在子进程里不存在;全不可用时让用例显式失败而不是静默假绿）
function findPython(): string {
  for (const py of [process.env.HOPJIT_TEST_PYTHON, 'python3', 'python'].filter((c): c is string => Boolean(c))) {
    try {
      execFileSync(py, ['-c', 'print(1)'], { stdio: 'ignore', timeout: 10000 });
      return py;
    } catch { /* 试下一个 */ }
  }
  throw new Error('本机没有可用的 python3——语法沙箱用例无法验证（设 HOPJIT_TEST_PYTHON 指定解释器）');
}
const PY = findPython();
const OPTS: PySandboxOptions = { interpreter: PY, whitelist: [PY], timeoutSec: 30, maxBuffer: 64 * 1024 };

function scriptFile(content: string | Buffer, name = 'x.py'): string {
  const dir = mkdtempSync(join(tmpdir(), 'hoppysb-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

// 检查器三条规则——直接走 checkPythonScript（与 run_script 同一条审查通路,只是不执行）
// @v: anc-pysb-defenses
describe('检查器三条规则', () => {
  const SDC_GUARD = 'import ast, sys\nsrc = open(sys.argv[1]).read()\nbad = []\nfor n in ast.walk(ast.parse(src)):\n    if isinstance(n, ast.FunctionDef) and n.end_lineno - n.lineno + 1 > 40:\n        bad.append(n.name)\nif bad:\n    print("too long", bad, file=sys.stderr)\n    sys.exit(1)\n';

  it('正例：sdc 守卫脚本审过（ast.walk/FunctionDef/end_lineno/读模式 open/sys.exit 全在白名单）', () => {
    expect(checkPythonScript(scriptFile(SDC_GUARD), OPTS)).toEqual({ ok: true });
  });

  it('正例：白名单条目可当值用（sorted key=len、lambda、map(re.escape)、str.lower）', () => {
    const src = 'import re\nxs = sorted(["b", "a"], key=len)\nys = sorted(xs, key=lambda s: -len(s))\nprint(list(map(re.escape, ys)), str.lower("A"))\n';
    expect(checkPythonScript(scriptFile(src), OPTS)).toEqual({ ok: true });
  });

  it('正例：open 的只读模式三种写法与关键字 encoding 都放行', () => {
    const src = 'a = open("f").read()\nb = open("f", "rb").read()\nc = open("f", mode="rt", encoding="utf-8").read()\n';
    expect(checkPythonScript(scriptFile(src), OPTS)).toEqual({ ok: true });
  });

  // 概念层 §2.2 实测对照清单逐条成为反例——每条注明拒它的是哪条规则
  const REJECTS: Array<[string, string | Buffer]> = [
    ['规则三 __builtins__.eval（万能钥匙）', '__builtins__.eval("1")'],
    ['规则三 breakpoint()（内置名白名单外）', 'breakpoint()'],
    ['规则三 help("modules")', 'help("modules")'],
    ['规则一 UTF-7 编码声明藏 __import__', Buffer.from('# -*- coding: utf-7 -*-\nprint(+AF8AXwBpAG0AcABvAHIAdABfAF8-("os").uname().sysname)\n')],
    ['规则一 全角 ｅval（NFKC 归一后是 eval）', 'print(ｅval("6*7"))\n'],
    ['规则三 f = open（open 当值）', 'f = open\nf("x", "w")'],
    ['规则三 {"w": open}', 'h = {"w": open}'],
    ['规则三 map(open, …)', 'list(map(open, ["x"], ["w"]))'],
    ['规则三 open 模式用变量', 'm = "w"\nopen("x", m)'],
    ['规则三 open(**{"mode": "w"})', 'open("x", **{"mode": "w"})'],
    ['规则三 open(*args)', 'open(*["x", "w"])'],
    ['规则三 open 写模式字面量', 'open("out.txt", "w")'],
    ['规则三 类属性藏 open', 'class C:\n    f = open'],
    ['规则三 "{0.__class__}".format(1)', '"{0.__class__}".format(1)'],
    ['规则三 str.format(模板, 1)', 'str.format("{0.__class__}", 1)'],
    ['规则三 format_map', '"{x.__class__}".format_map({"x": 1})'],
    ['规则三 gi_frame 取帧', 'def gen():\n    yield 1\ng = gen()\nb = g.gi_frame.f_globals'],
    ['规则二 f(re)（模块当值）', 'import re\ndef f(m):\n    return m\nf(re)'],
    ['规则二 re.enum.sys（符号不在表一）', 'import re\nre.enum.sys'],
    ['规则二 re = open（重绑模块名）', 'import re\nre = 1'],
    ['规则二 def f(re)（形参遮蔽模块名）', 'import re\ndef f(re):\n    return re.match'],
    ['规则三 作用域错位绑 eval', 'def g():\n    eval = 1\nprint(eval("6*7"))'],
    ['规则二 sys.modules', 'import sys\nsys.modules["os"]'],
    ['规则二 from re import match', 'from re import match'],
    ['规则二 import os.path', 'import os.path'],
    ['规则二 import os', 'import os'],
    ['规则二 import re as r', 'import re as r'],
    ['规则三 match 类模式取 __class__', 'match 1:\n    case int(__class__=c):\n        pass'],
    ['规则三 type(1)', 'type(1)'],
    ['规则三 下划线属性 x.__class__', 'x = 1\nx.__class__'],
  ];
  for (const [label, src] of REJECTS) {
    it(`反例：${label} → 拒`, () => {
      const r = checkPythonScript(scriptFile(src), OPTS);
      expect(r.ok).toBe(false);
    });
  }

  it('反例：语法错误记成一条拒绝（name=<语法>）,不是检查器自身失败', () => {
    const r = checkPythonScript(scriptFile('def f(:\n'), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations).toHaveLength(1);
      expect(r.violations[0].name).toBe('<语法>');
      expect(r.violations[0].line).toBe(1);
    }
  });

  it('拒绝报文:逐条点名行号+名字+原因+替代,末行附表一全列', () => {
    const r = checkPythonScript(scriptFile('x = 1\nimport pathlib\nopen("o", "w")\n'), OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msg = r.message;
    expect(msg.split('\n')[0]).toBe('Python 语法沙箱审查未通过,脚本没有执行。逐条改完再跑:');
    expect(msg).toContain('- 第 2 行 `pathlib`:pathlib 不在模块白名单内。替代:');
    expect(msg).toContain('- 第 3 行 `open`:');
    expect(msg).toContain('print(…, file=sys.stderr)');   // 写模式的替代写法
    expect(msg.split('\n').at(-1)).toMatch(/^可用的模块符号:ast\.AsyncFunctionDef .* sys\.stderr$/);
    for (const v of r.violations) {
      expect(typeof v.line).toBe('number');
      expect(v.reason.length).toBeGreaterThan(0);
      expect(v.alternative.length).toBeGreaterThan(0);
    }
  });

  it('拒绝记录按 (行号,名字,原因) 去重:同一行重复出现同一违规只报一次', () => {
    const r = checkPythonScript(scriptFile('type(1); type(2)\n'), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.filter(v => v.name === 'type')).toHaveLength(1);
  });

  // 拒绝报文末行的表一清单在 TS 里另有一份常量——与检查器 MODULE_SYMBOLS 同表两处,这里钉住一致
  it('报文末行的模块符号清单与检查器 MODULE_SYMBOLS 逐项一致', () => {
    const dump = execFileSync(PY, ['-I', '-B', '-c',
      `import importlib.util as u\ns=u.spec_from_file_location("c", ${JSON.stringify(CHECKER)})\nm=u.module_from_spec(s)\ns.loader.exec_module(m)\nprint(m.MODULE_LIST_TEXT)`], { encoding: 'utf-8' });
    const r = checkPythonScript(scriptFile('import os\n'), OPTS);
    if (r.ok) throw new Error('应被拒');
    expect(r.message.split('\n').at(-1)).toBe(`可用的模块符号:${dump.trim()}`);
  });

  it('检查器输出协议:stdout 恰好一行 JSON,审完退出码恒 0;读不到文件退出码 2 且 stderr 写原因', () => {
    const ok = execFileSync(PY, ['-I', '-B', CHECKER, scriptFile('print(1)\n')], { encoding: 'utf-8' });
    expect(ok).toBe('{"ok": true}\n');
    const bad = execFileSync(PY, ['-I', '-B', CHECKER, scriptFile('import os\n')], { encoding: 'utf-8' });
    expect(bad.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(bad)).toMatchObject({ ok: false, violations: [{ line: 1, name: 'os' }] });
    let status = 0; let stderr = '';
    try {
      execFileSync(PY, ['-I', '-B', CHECKER, '/nonexistent/hopjit-pysb.py'], { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e) {
      status = (e as { status: number }).status;
      stderr = String((e as { stderr: string }).stderr);
    }
    expect(status).toBe(2);
    expect(stderr).toContain('读不到');
  });
});

// 执行契约:审的字节就是跑的字节 / -I 隔离 / 被拒不执行 / 检查器坏了抛错 / 临时目录恒删
// @v: anc-pysb-exec
describe('执行契约', () => {
  it('正例：审过即执行,回执三字段+defense;非零退出码照样是跑完', () => {
    const p = scriptFile('import sys\nprint("VIOLATIONS: 2")\nsys.exit(1)\n');
    const r = runSandboxedPython(p, [], OPTS);
    expect(r.status).toBe('ran');
    if (r.status !== 'ran') return;
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain('VIOLATIONS: 2');
    expect(['syntax+os-sandbox', 'syntax-only']).toContain(r.defense);
  });

  it('正例：工作目录=原脚本所在目录,脚本用相对名读同目录样例;args 逐项传入', () => {
    const p = scriptFile('import sys\nprint(open("sample.txt").read().strip(), "|".join(sys.argv[1:]))\n');
    writeFileSync(join(dirname(p), 'sample.txt'), 'SAMPLE\n');
    const r = runSandboxedPython(p, ['a b', 'c'], OPTS);
    expect(r.status).toBe('ran');
    if (r.status === 'ran') expect(r.stdout.trim()).toBe('SAMPLE a b|c');
  });

  it('反例：审查没过 → 不执行（脚本想写的哨兵文件不出现）,返回 rejected 带报文', () => {
    const p = scriptFile('import os\nopen("SENTINEL", "w")\n');
    const r = runSandboxedPython(p, [], OPTS);
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.message).toContain('脚本没有执行');
    expect(existsSync(join(dirname(p), 'SENTINEL'))).toBe(false);
  });

  it('反例（冒牌标准库）：脚本旁边放 json.py,脚本只写 import json → -I 下加载的是标准库', () => {
    const p = scriptFile('import json\nprint(json.dumps({"a": 1}))\n', 'main.py');
    writeFileSync(join(dirname(p), 'json.py'), 'print("IMPOSTOR LOADED")\ndef dumps(x):\n    return "fake"\n');
    const r = runSandboxedPython(p, [], OPTS);
    expect(r.status).toBe('ran');
    if (r.status !== 'ran') return;
    expect(r.stdout).not.toContain('IMPOSTOR');
    expect(r.stdout.trim()).toBe('{"a": 1}');
  });

  it('执行的是私有副本:traceback 里的路径不是原路径,文件名保留原名', () => {
    const p = scriptFile('import sys\nsys.exit(int("x"))\n', 'guard_c1.py');
    const r = runSandboxedPython(p, [], OPTS);
    expect(r.status).toBe('ran');
    if (r.status !== 'ran') return;
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain('guard_c1.py');
    expect(r.stderr).toContain('hopjit-pysb-');
    expect(r.stderr).not.toContain(p);
  });

  it('临时目录恒删:审过、被拒两种路径跑完后 tmpdir 下不残留新的 hopjit-pysb-* 目录', () => {
    // 私有临时根:共享 tmpdir 会同时看到并行测试文件（tools.test 的 run_script）正在用的
    // hopjit-pysb-* 目录,误判为泄漏（全量跑偶发红）。os.tmpdir() 每次调用现读 TMPDIR。
    const privateRoot = mkdtempSync(join(tmpdir(), 'pysb-leak-'));
    const saved = process.env['TMPDIR'];
    process.env['TMPDIR'] = privateRoot;
    try {
      runSandboxedPython(scriptFile('print(1)\n'), [], OPTS);
      runSandboxedPython(scriptFile('import os\n'), [], OPTS);
      expect(readdirSync(privateRoot).filter(n => n.startsWith('hopjit-pysb-'))).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = saved;
      rmSync(privateRoot, { recursive: true, force: true });
    }
  });

  it('原始字节原样进副本（UTF-7 编码声明的文件被审的就是那份字节,照样拒）', () => {
    const bytes = Buffer.from('# -*- coding: utf-7 -*-\n+AF8AXwBpAG0AcABvAHIAdABfAF8-("os")\n');
    const p = scriptFile(bytes);
    expect(readFileSync(p).equals(bytes)).toBe(true);
    expect(runSandboxedPython(p, [], OPTS).status).toBe('rejected');
  });

  it('反例：解释器不在命令白名单 → 原语的白名单拒原样上抛（检查器都没起）', () => {
    expect(() => runSandboxedPython(scriptFile('print(1)\n'), [], { ...OPTS, whitelist: ['git'] })).toThrow(/不在白名单/);
    expect(() => runSandboxedPython(scriptFile('print(1)\n'), [], { ...OPTS, whitelist: [] })).toThrow(/未配置命令白名单/);
  });

  it('反例：检查器自身失败（解释器不是 Python,输出不合约定）→ 抛"检查器自身运行失败",不当成被拒', () => {
    // echo 充当"解释器":退出码 0 但 stdout 不是约定 JSON——模拟检查器坏掉
    expect(() => checkPythonScript(scriptFile('print(1)\n'), { ...OPTS, interpreter: 'echo', whitelist: ['echo'] }))
      .toThrow(/检查器自身运行失败/);
    // false 充当"解释器":非零退出
    expect(() => checkPythonScript(scriptFile('print(1)\n'), { ...OPTS, interpreter: 'false', whitelist: ['false'] }))
      .toThrow(/检查器自身运行失败/);
  });

  it('产物超时:原语的超时报文原样上抛', () => {
    const p = scriptFile('while True:\n    pass\n');
    expect(() => runSandboxedPython(p, [], { ...OPTS, timeoutSec: 1 })).toThrow(/超时/);
  }, 15000);
});

// 系统沙箱:在场即套上,缺席照跑并标 syntax-only（探测失败——含嵌套被拒 71——按缺席处理）
// @v: anc-pysb-os-independence
describe('系统沙箱探测与套用', () => {
  it('defense 与本机 seatbelt 的实测可用性一致', () => {
    let seatbeltUsable = false;
    if (process.platform === 'darwin') {
      try {
        execFileSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore', timeout: 5000 });
        seatbeltUsable = true;
      } catch { /* 嵌套被拒或不在场=缺席 */ }
    }
    const r = runSandboxedPython(scriptFile('print(1)\n'), [], OPTS);
    expect(r.status).toBe('ran');
    if (r.status === 'ran') expect(r.defense).toBe(seatbeltUsable ? 'syntax+os-sandbox' : 'syntax-only');
  });
});
