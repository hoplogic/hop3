// @module: act-body ^anc-struct-act-body
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BodyInterpreter, evalExprSync } from '../src/act-body-interpreter.js';
import { ACT_BUILTINS } from '../src/act-builtins.js';
import { parseActBody, parseExpression, serializeActBody } from '../src/act-body-parser.js';
import type { OutputDecl } from '../src/ast-types.js';
import type { ParseError } from '../src/errors.js';
import type { ToolProvider, ToolDef, ToolResult } from '../src/provider-types.js';

// @v: anc-exec-act-body-interp
// act body 独立模式解释器：求值 + 内置函数 + 分支 + 工具调用 + requires_commit 拦截

// mock ToolProvider
function mockProvider(opts: {
  tools?: ToolDef[];
  exec?: (name: string, args: Record<string, unknown>) => ToolResult;
} = {}): ToolProvider {
  const tools = opts.tools ?? [];
  return {
    list: () => tools,
    execute: async (name, args) => opts.exec
      ? opts.exec(name, args)
      : { result: `${name}-result`, success: true },
  };
}

function tool(name: string, requires_commit = false): ToolDef {
  return { name, description: name, input_schema: {}, requires_commit };
}

// 解析 body 文本 → ActBody（裸 hop_python，无围栏）
function body(src: string) {
  const errors: ParseError[] = [];
  const b = parseActBody(src.split('\n'), 1, errors);
  if (!b) throw new Error('parse failed: ' + JSON.stringify(errors));
  return b;
}

async function run(src: string, inputs: Record<string, unknown>, outputs: OutputDecl[], provider?: ToolProvider, allowCommit = false) {
  const interp = new BodyInterpreter({
    inputs,
    toolProvider: provider ?? mockProvider(),
    allowCommit,
    toolCallLog: [],
  });
  return interp.run(body(src), outputs);
}

const OUT = (...names: string[]): OutputDecl[] => names.map(n => ({ name: n, type: 'text', description: '' }));

// @v: anc-exec-act-body-interp — min/max 单数组形态（v0.2.1，与 sum(list) 对齐）
import { ACT_BUILTINS } from '../src/act-builtins.js';
const _min = ACT_BUILTINS.get('min')!.fn; const _max = ACT_BUILTINS.get('max')!.fn;
describe('builtins min/max array form', () => {
  it('max(list) 等价 max(...list)；变参不变', () => {
    expect(_max([[3, 9, 1]])).toBe(9);
    expect(_max([3, 9, 1])).toBe(9);
    expect(_min([[3, 9, 1]])).toBe(1);
    expect(_min([5])).toBe(5);
  });
});

describe('BodyInterpreter 求值', () => {
  it('字面量赋值', async () => {
    const r = await run('out = 42', {}, OUT('out'));
    expect(r.out).toBe(42);
  });

  it('变量引用（从 inputs）', async () => {
    const r = await run('out = x', { x: 'hello' }, OUT('out'));
    expect(r.out).toBe('hello');
  });

  it('算术 + 优先级', async () => {
    const r = await run('out = 2 + 3 * 4', {}, OUT('out'));
    expect(r.out).toBe(14);
  });

  it('字符串拼接（+ 重载）', async () => {
    const r = await run('out = "a" + "b"', {}, OUT('out'));
    expect(r.out).toBe('ab');
  });

  it('比较 + 布尔短路', async () => {
    expect((await run('out = 5 > 3', {}, OUT('out'))).out).toBe(true);
    expect((await run('out = false and crash', {}, OUT('out'))).out).toBe(false);  // 短路不求值 crash
    expect((await run('out = true or crash', {}, OUT('out'))).out).toBe(true);
  });

  it('字段取', async () => {
    const r = await run('out = cfg.level', { cfg: { level: 'high' } }, OUT('out'));
    expect(r.out).toBe('high');
  });

  it('局部变量顺序传递', async () => {
    const r = await run('a = 10\nb = a + 5\nout = b', {}, OUT('out'));
    expect(r.out).toBe(15);
  });
});

describe('BodyInterpreter 内置函数', () => {
  it('len / upper / split', async () => {
    expect((await run('out = len(items)', { items: [1, 2, 3] }, OUT('out'))).out).toBe(3);
    expect((await run('out = upper(s)', { s: 'abc' }, OUT('out'))).out).toBe('ABC');
    expect((await run('out = split(s, ",")', { s: 'a,b' }, OUT('out'))).out).toEqual(['a', 'b']);
  });
});

describe('BodyInterpreter 分支', () => {
  it('if-else 走对路', async () => {
    const r1 = await run('if x > 3:\n    out = "hi"\nelse:\n    out = "lo"', { x: 5 }, OUT('out'));
    expect(r1.out).toBe('hi');
    const r2 = await run('if x > 3:\n    out = "hi"\nelse:\n    out = "lo"', { x: 1 }, OUT('out'));
    expect(r2.out).toBe('lo');
  });

  it('if-elif-else 链', async () => {
    const src = 'if x > 9:\n    out = "h"\nelif x > 3:\n    out = "m"\nelse:\n    out = "l"';
    expect((await run(src, { x: 10 }, OUT('out'))).out).toBe('h');
    expect((await run(src, { x: 5 }, OUT('out'))).out).toBe('m');
    expect((await run(src, { x: 1 }, OUT('out'))).out).toBe('l');
  });
});

describe('BodyInterpreter 工具调用', () => {
  it('调工具（命名参数），结果回流', async () => {
    const provider = mockProvider({
      tools: [tool('fetch')],
      exec: (name, args) => ({ result: `fetched:${args.url}`, success: true }),
    });
    const r = await run('out = fetch(url: u)', { u: 'http://x' }, OUT('out'), provider);
    expect(r.out).toBe('fetched:http://x');
  });

  it('工具失败 → 抛 TOOL_EXEC_ERROR', async () => {
    const provider = mockProvider({
      tools: [tool('bad')],
      exec: () => ({ result: 'boom', success: false }),
    });
    await expect(run('out = bad(x: 1)', {}, OUT('out'), provider)).rejects.toThrow(/TOOL_EXEC_ERROR/);
  });

  // 对象错误序列化——String() 直转产 [object Object],replan 适配依据被占位符吃掉
  // @v: anc-exec-tool-result-render
  it('工具失败且 result 是对象 → 报文含 JSON 明细不含 [object Object]', async () => {
    const provider = mockProvider({
      tools: [tool('bad')],
      exec: () => ({ result: { code: 42, detail: 'quota exceeded' }, success: false }),
    });
    await expect(run('out = bad(x: 1)', {}, OUT('out'), provider)).rejects.toThrow(/quota exceeded/);
    await expect(run('out = bad(x: 1)', {}, OUT('out'), provider)).rejects.not.toThrow(/object Object/);
  });

  it('未知工具 → 抛 TOOL_EXEC_ERROR（不在白名单也不在清单）', async () => {
    await expect(run('out = nonexistent(x: 1)', {}, OUT('out'))).rejects.toThrow(/未知工具/);
  });

  it('requires_commit 工具在 act（allowCommit=false）→ 抛 COMMIT_REQUIRED', async () => {
    const provider = mockProvider({ tools: [tool('send_email', true)] });
    await expect(run('out = send_email(to: a)', { a: 'x' }, OUT('out'), provider, false))
      .rejects.toThrow(/COMMIT_REQUIRED/);
  });

  // @v: anc-tool-dingtalk-notify —— 0052 口径 7 点名的必备反例:act 语境调 notify 被既有闸拒
  // （真 CompositeToolProvider 装配内置成员表,钉真链路——requires_commit 经 specs 表合并进
  // list() 名单,解释器按名单拦,tool_id 语言面调用同拦）
  it('反例：act 语境经真装配链调 notify（tool_id）→ COMMIT_REQUIRED 拒（钉钉工具 requires_commit=true）', async () => {
    const { CompositeToolProvider } = await import('../src/tools-composite.js');
    const host = { workspace_dir: mkdtempSync(join(tmpdir(), 'ntf-')) } as import('../src/provider-types.js').HostConfig;
    const composite = new CompositeToolProvider(host);
    await expect(run('out = notify(text: msg)', { msg: 'hi' }, OUT('out'), composite, false))
      .rejects.toThrow(/COMMIT_REQUIRED/);
    await expect(run('out = dingtalk_notify(text: msg)', { msg: 'hi' }, OUT('out'), composite, false))
      .rejects.toThrow(/COMMIT_REQUIRED/);   // wire 名同拦
  });

  // @v: anc-tool-dingtalk-notify —— 0040 第 6 条:放行半边正例(与上方 act 拒反例成对——
  // 真 CompositeToolProvider 装配,allowCommit=true 语境调 notify 须穿过 requires_commit 闸
  // 走到 sendDingtalk 本体。凭证=失败值形态:DINGTALK_WEBHOOK 未设时 sendDingtalk 返回
  // success:false 带建法指引,经解释器升为 TOOL_EXEC_ERROR——报文含建法指引=已进入工具本体,
  // 被闸拦则是 COMMIT_REQUIRED,两形态可区分,无需真网络)
  it('正例：commit 语境经真装配链调 notify → 穿过 requires_commit 闸走到 sendDingtalk（webhook 未配时返回建法指引失败值而非 COMMIT_REQUIRED——0040 第 6 条正反成对补钉）', async () => {
    const { CompositeToolProvider } = await import('../src/tools-composite.js');
    const host = { workspace_dir: mkdtempSync(join(tmpdir(), 'ntf-c-')) } as import('../src/provider-types.js').HostConfig;
    const composite = new CompositeToolProvider(host);
    const savedWebhook = process.env.DINGTALK_WEBHOOK;
    delete process.env.DINGTALK_WEBHOOK;   // 确保走"未配置"失败值路径,不打真网络
    try {
      // success:false 经解释器升为 TOOL_EXEC_ERROR 异常——报文含 webhook 建法指引=已进入
      // sendDingtalk 本体(被闸拦是 COMMIT_REQUIRED,两形态可区分)
      await expect(run('out = notify(text: msg)', { msg: 'hi' }, OUT('out'), composite, true))
        .rejects.toThrow(/DINGTALK_WEBHOOK 未设置/);
      await expect(run('out = notify(text: msg)', { msg: 'hi' }, OUT('out'), composite, true))
        .rejects.not.toThrow(/COMMIT_REQUIRED/);
    } finally {
      if (savedWebhook !== undefined) process.env.DINGTALK_WEBHOOK = savedWebhook;
    }
  });

  it('requires_commit 工具在 commit（allowCommit=true）→ 放行', async () => {
    const provider = mockProvider({
      tools: [tool('send_email', true)],
      exec: () => ({ result: 'sent', success: true }),
    });
    const r = await run('out = send_email(to: a)', { a: 'x' }, OUT('out'), provider, true);
    expect(r.out).toBe('sent');
  });

  it('工具命名参数缺失 → 报错', async () => {
    const provider = mockProvider({ tools: [tool('foo')] });
    await expect(run('out = foo(bar)', { bar: 1 }, OUT('out'), provider)).rejects.toThrow(/命名参数/);
  });

  it('独立语句调用（副作用，无赋值）', async () => {
    let called = false;
    const provider = mockProvider({
      tools: [tool('write')],
      exec: () => { called = true; return { result: 'ok', success: true }; },
    });
    await run('write(path: p, content: c)', { p: 'a', c: 'b' }, OUT('out'), provider);
    expect(called).toBe(true);
  });

  // 写域随 allowCommit 分派（[[tools/file-tools#^anc-exec-builtin-file-tools]] 分域条款,2026-08-28）
  // @v: anc-exec-write-scope
  it('正例：act body（allowCommit=false）工具调用带 write_scope=work_zone；commit body 带 workspace', async () => {
    const scopes: unknown[] = [];
    const provider: ToolProvider = {
      list: () => [tool('write')],
      execute: async (_n, _a, ws) => { scopes.push(ws); return { result: 'ok', success: true, content_type: 'text' }; },
    };
    await run('write(path: p, content: c)', { p: 'a', c: 'b' }, OUT('out'), provider, false);
    await run('write(path: p, content: c)', { p: 'a', c: 'b' }, OUT('out'), provider, true);
    expect(scopes).toEqual(['work_zone', 'workspace']);
  });
});

describe('BodyInterpreter 错误', () => {
  it('引用未定义变量 → 抛错', async () => {
    await expect(run('out = undefined_var', {}, OUT('out'))).rejects.toThrow(/未定义变量/);
  });

  it('null 上取字段 → None+log(2026-08-09 作者定"计算异常=None+log",原抛错废除)', async () => {
    const warnLog: string[] = [];
    const interp = new BodyInterpreter({ inputs: { obj: null }, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [], warnLog });
    const outputs = await interp.run(body('out = obj.field'), [{ name: 'out', type: 'text', description: '' }]);
    expect(outputs.out).toBeNull();
    expect(warnLog.some(w => w.includes('计算异常'))).toBe(true);
  });
});

// @v: anc-exec-act-body-interp, anc-exec-inputs-deflate
// BUG-A（^todo-bug-deflate-plus）：act-body 输入 var 须解引用 $file 指针（agent 通道 deflate 的
// 逆操作）——大值输入（>DEFLATE_THRESHOLD=4096）被 resolveInputs 卸载为 {$file:...} 指针，
// 解释器若拿指针对象当值，`a + b` 数组拼接 Array.isArray(指针)=false 落入数值强转报"不可转数字"。
describe('BodyInterpreter $file 指针解引用（BUG-A）', () => {
  it('正例：大数组（>4096 字符）输入经 $file 指针注入，`+` 拼接返回正确数组', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-deflate-'));
    // 96 候选、JSON ~7KB（超 DEFLATE_THRESHOLD），镜像 hopkb merged_points
    const merged = Array.from({ length: 96 }, (_, i) => ({ id: `c${i}`, summary: `候选点 ${i} ` + 'x'.repeat(60) }));
    const cross = [{ id: 'x1', summary: '跨片认识 1' }, { id: 'x2', summary: '跨片认识 2' }];
    const aPath = join(dir, 'merged_points.json');
    const bPath = join(dir, 'cross_points.json');
    writeFileSync(aPath, JSON.stringify(merged));
    writeFileSync(bPath, JSON.stringify(cross));
    expect(JSON.stringify(merged).length).toBeGreaterThan(4096);   // 确保真超 DEFLATE_THRESHOLD
    const warnLog: string[] = [];
    const interp = new BodyInterpreter({
      inputs: { merged_points: { $file: aPath }, cross_points: { $file: bPath } },
      toolProvider: mockProvider(),
      allowCommit: false,
      toolCallLog: [],
      warnLog,
    });
    const outputs = await interp.run(body('candidates = merged_points + cross_points'), [{ name: 'candidates', type: 'text', description: '' }]);
    expect(outputs.candidates).toHaveLength(98);
    expect(outputs.candidates[0]).toEqual(merged[0]);
    expect(outputs.candidates[97]).toEqual(cross[1]);
    expect(warnLog).toHaveLength(0);   // 反例判据：旧实现报"不可转数字"留 warnLog，修复后零警告
  });

  it('反例判据：指针输入不落数值强转——非指针小值拼接行为不变（回归基线）', async () => {
    const r = await run('out = a + b', { a: [1, 2], b: [3] }, OUT('out'));
    expect(r.out).toEqual([1, 2, 3]);
  });

  it('反例：含 $file 键但非单键的用户数据对象不视为指针（形状契约精确匹配，不误读文件）', async () => {
    const data = { $file: '/nonexistent/never-read.json', preview: '用户数据恰好带 $file 键' };
    const r = await run('out = a', { a: data }, OUT('out'));
    expect(r.out).toEqual(data);   // 原样进 scope；若误判指针会因文件不存在抛 ENOENT
  });

  // $preview 预览对象解引用（dr18 第3攻实撞:BUG-H v2 inline 通道把 31834 字符 fragment 换成
  // {$preview,full_chars,full_file},机械 body 调 validate_spec(text:fragment) 收到对象报
  // "text 参数必须是字符串",确定性错误重试必死,5.1#3 七小时白烧）
  // @v: anc-exec-llm-inline-context, anc-exec-inputs-deflate
  it('正例：{$preview,full_chars,full_file} 预览对象 → 读 full_file 还原全文真值', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-preview-'));
    const full = '1. [act] 完整片段 '.repeat(2000);   // 模拟超限全文
    const p = join(dir, 'fragment.json');
    writeFileSync(p, JSON.stringify(full));
    const r = await run('out = fragment', {
      fragment: { $preview: full.slice(0, 100), full_chars: full.length, full_file: p },
    }, OUT('out'));
    expect(r.out).toBe(full);   // 真值全文,非 100 字符节选
  });

  it('反例：$preview 对象缺 full_file → 响亮抛错不静默用节选（节选替真值=静默截断）', async () => {
    const warnLog: string[] = [];
    const interp = new BodyInterpreter({
      inputs: { fragment: { $preview: '节选...', full_chars: 30000 } },
      toolProvider: mockProvider(),
      allowCommit: false,
      toolCallLog: [],
      warnLog,
    });
    await expect(interp.run(body('out = fragment'), OUT('out'))).rejects.toThrow(/full_file/);
  });

  it('反例守卫：用户数据对象恰含 $preview 键但形状不符（有多余键）→ 原样保留不误读', async () => {
    const data = { $preview: 'x', full_chars: 3, custom: true };
    const r = await run('out = a', { a: data }, OUT('out'));
    expect(r.out).toEqual(data);
  });

  it('反例守卫二修：full_file 存在但非 string → 形状不符原样保留,不误抛"缺 full_file"', async () => {
    const data = { $preview: 'x', full_chars: 3, full_file: 42 };
    const r = await run('out = a', { a: data }, OUT('out'));
    expect(r.out).toEqual(data);   // 走普通对象递归分支,标量字段原样
    const data2 = { $preview: 'x', full_chars: 3, full_file: null };
    const r2 = await run('out = b', { b: data2 }, OUT('out'));
    expect(r2.out).toEqual(data2);
  });

  // 递归下钻（D59,2026-08-24——dr13 实撞:collect 数组一项超阈成指针,机械拼装把 {$file}
  // 对象喂 edit_spec_tree 拒"需要非空 fragment",4 攻同败烧死子实例;原实现只剥顶层值）
  // @v: anc-exec-inputs-deflate
  it('正例：数组元素位/对象字段位的 $file 指针同样解出真值（递归下钻）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-deflate-nest-'));
    const frag = '1. [act] 步骤\n  + → x: text  # y';
    const p = join(dir, 'fragment.json');
    writeFileSync(p, JSON.stringify(frag));
    const r = await run('out = fragments', {
      fragments: ['真值片段A', { $file: p }, '真值片段C'],
    }, OUT('out'));
    expect(r.out).toEqual(['真值片段A', frag, '真值片段C']);   // 元素位指针解出

    const r2 = await run('out = wrap', { wrap: { inner: { $file: p }, plain: 'k' } }, OUT('out'));
    expect((r2.out as Record<string, unknown>).inner).toBe(frag);   // 字段位指针解出
    expect((r2.out as Record<string, unknown>).plain).toBe('k');
  });

  it('反例：指针指向的文件缺失 → 响亮报错不静默（缺盘面必须失败）', async () => {
    const interp = new BodyInterpreter({
      inputs: { a: { $file: '/nonexistent/gone.json' } },
      toolProvider: mockProvider(),
      allowCommit: false,
      toolCallLog: [],
      warnLog: [],
    });
    await expect(interp.run(body('out = a'), [{ name: 'out', type: 'text', description: '' }]))
      .rejects.toThrow(/ENOENT|no such file/i);
  });
});

// @v: anc-exec-act-body-interp —— builtin 白名单尾部函数覆盖（keys/values/get/to_*/is_*——
// 此前无用例，coverage 洼地 76%；builtin 是 spec 作者可见 API，逐个至少一条正/反用例）
describe('act builtins 结构/转换/判定组', () => {
  const call = (name: string, args: unknown[]) => ACT_BUILTINS.get(name)!.fn(args);

  it('keys/values：对象取键值，非对象抛错', () => {
    expect(call('keys', [{ a: 1, b: 2 }])).toEqual(['a', 'b']);
    expect(call('values', [{ a: 1, b: 2 }])).toEqual([1, 2]);
    expect(() => call('keys', ['not-obj'])).toThrow(/期望对象/);
    expect(() => call('values', [[1]])).toThrow(/期望对象/);
  });

  it('get：命中取值/未命中取默认/无默认得 null', () => {
    expect(call('get', [{ x: 5 }, 'x'])).toBe(5);
    expect(call('get', [{ x: 5 }, 'y', 'dft'])).toBe('dft');
    expect(call('get', [{ x: 5 }, 'y'])).toBeNull();
  });

  it('count：数组长度', () => {
    expect(call('count', [[1, 2, 3]])).toBe(3);
  });

  // 2026-08-10 Python 对齐：to_number→int/float、to_string→str、to_bool→bool
  it('int/float/str/bool：转换四件套（Python 同名）', () => {
    expect(call('float', ['42.5'])).toBe(42.5);
    expect(call('int', ['42.9'])).toBe(42);   // Python int() 截断语义
    expect(call('str', [42])).toBe('42');
    expect(call('bool', ['YES'])).toBe(true);
    expect(call('bool', ['no'])).toBe(false);
    expect(call('bool', [true])).toBe(true);
    expect(call('bool', [0])).toBe(false);
  });

  // e2e-parallel-partial 注入形态的依赖锁定：该 live 用例靠 int("八千二") 抛计算异常
  // 制造 partial 失败盘面——int 对非数字字符串必须抛（改成静默折 0 即注入形态失效）
  it('int：数字字符串正常转换（正例），非数字字符串抛计算异常（反例）', () => {
    expect(call('int', ['6400'])).toBe(6400);
    expect(() => call('int', ['八千二'])).toThrow(/期望数字/);
  });

  // 反例：旧名已废（硬切不留别名）——to_string/to_number/to_bool/is_null/is_empty/contains/trim 全出白名单
  it('旧名已废：不在白名单', () => {
    for (const gone of ['to_string', 'to_number', 'to_bool', 'is_null', 'is_empty', 'contains', 'trim']) {
      expect(ACT_BUILTINS.has(gone), `${gone} 应已废除`).toBe(false);
    }
  });

  // in / not in 运算符（替代 contains 函数，Python 惯用形）
  it('in/not in：数组查元素、字符串查子串、对象查键', () => {
    const errs: ParseError[] = [];
    const ev = (src: string, vars: Record<string, unknown>) => {
      const e = parseExpression(src, errs)!;
      return evalExprSync(e, n => vars[n]);
    };
    expect(ev('2 in nums', { nums: [1, 2] })).toBe(true);
    expect(ev('5 in nums', { nums: [1, 2] })).toBe(false);
    expect(ev('"ell" in greeting', { greeting: 'hello' })).toBe(true);
    expect(ev('"k" in obj', { obj: { k: 1 } })).toBe(true);
    expect(ev('5 not in nums', { nums: [1, 2] })).toBe(true);
    expect(ev('2 not in nums', { nums: [1, 2] })).toBe(false);
    // 反例：右侧非容器 → 计算异常折 undefined（falsy）
    expect(ev('1 in num', { num: 42 })).toBe(undefined);
  });
});

// strip_fence 文本剥壳内置（design ^anc-exec-strip-fence——buildtest 实录:机械可剥的围栏壳
// 反复烧 LLM 重跑轮;纯文本零 parse,与 recoverFencedValue 结构档分工）
// @v: anc-exec-strip-fence
describe('strip_fence 文本剥壳', () => {
  async function run(expr: string, inputs: Record<string, unknown>): Promise<unknown> {
    const errors: ParseError[] = [];
    const body = parseActBody([`out = ${expr}`], 1, errors);
    expect(errors).toHaveLength(0);
    const interp = new BodyInterpreter({
      inputs, toolProvider: { list: () => [], execute: async () => ({ result: '', success: true }) },
      allowCommit: false, toolCallLog: [],
    });
    const o = await interp.run(body!, [{ name: 'out', var_type: 'text' }] as OutputDecl[]);
    return o.out;
  }

  it('正例：单围栏包裹 → 剥出正文（实撞形态:```yaml 壳）', async () => {
    const v = '```yaml\n1. [reason] 判断\n  + → x: bool  # b\n```';
    expect(await run('strip_fence(v)', { v })).toBe('1. [reason] 判断\n  + → x: bool  # b');
  });

  it('正例：围栏+自标记键前缀+统一缩进 → key 实参双剥（实撞形态:draft_fragment: | 包裹）', async () => {
    const v = '```yaml\ndraft_fragment: |\n  1. [loop] 遍历\n    1.1. [reason] 判\n```';
    expect(await run('strip_fence(v, "draft_fragment")', { v })).toBe('1. [loop] 遍历\n  1.1. [reason] 判');
  });

  it('反例：无壳裸片段 → 原样返回（幂等,不误剥）', async () => {
    const v = '1. [reason] 判断\n  + → x: bool  # b';
    expect(await run('strip_fence(v, "draft_fragment")', { v })).toBe(v);
  });

  it('反例：正文内嵌围栏（非整值包裹）→ 不碰（hop_python body 的合法围栏正文）', async () => {
    const v = '1. [act] 算\n  > ```hop_python\n  > x = 1\n  > ```\n2. [reason] 判';
    expect(await run('strip_fence(v)', { v })).toBe(v);
  });

  it('反例：键名不匹配 → 只剥围栏不剥键行', async () => {
    const v = '```\nother_key: |\n  内容\n```';
    expect(await run('strip_fence(v, "draft_fragment")', { v })).toBe('other_key: |\n  内容');
  });

  it('反例：非字符串值 → 原样返回', async () => {
    expect(await run('strip_fence(v)', { v: 42 })).toBe(42);
  });
});

// parse_json 结构解码内置（design ^anc-exec-parse-json——内置工具族 json 返回值的 body 侧
// 机械解码半边;缺它=机械编排被迫升 LLM 步,test11 实撞推理独白进产物）
// @v: anc-exec-parse-json
describe('parse_json 结构解码', () => {
  async function run(lines: string[], inputs: Record<string, unknown>, outName = 'out'): Promise<unknown> {
    const errors: ParseError[] = [];
    const body = parseActBody(lines, 1, errors);
    expect(errors).toHaveLength(0);
    const interp = new BodyInterpreter({
      inputs, toolProvider: { list: () => [], execute: async () => ({ result: '', success: true }) },
      allowCommit: false, toolCallLog: [],
    });
    const o = await interp.run(body!, [{ name: outName, var_type: 'text' }] as OutputDecl[]);
    return o[outName];
  }

  it('正例：工具 json 返回字符串 → 解码取字段（拼装步消费形态）', async () => {
    const raw = JSON.stringify({ status: 'ok', spec_text: '1. [act] 甲\n', renumber_map: {} });
    expect(await run(['r = parse_json(raw)', 'out = r.spec_text'], { raw })).toBe('1. [act] 甲\n');
  });

  it('正例：解码列表可下标与推导', async () => {
    expect(await run(['xs = parse_json(raw)', 'out = [x for x in xs if x > 1]'], { raw: '[1,2,3]' })).toEqual([2, 3]);
  });

  it('反例：坏 JSON → 计算异常折 None+warnLog 留痕（warnLog 非空即本步 fail,不静默）', async () => {
    const errors: ParseError[] = [];
    const body = parseActBody(['out = parse_json(raw)'], 1, errors);
    const warnLog: string[] = [];
    const interp = new BodyInterpreter({
      inputs: { raw: '{oops' }, toolProvider: { list: () => [], execute: async () => ({ result: '', success: true }) },
      allowCommit: false, toolCallLog: [], warnLog,
    });
    const o = await interp.run(body!, [{ name: 'out', var_type: 'text' }] as OutputDecl[]);
    expect(o.out).toBe(null);
    expect(warnLog.some(w => w.includes('parse_json 解析失败'))).toBe(true);
  });

  // 幂等容错五正例（2026-09-05 作者定"parse_json 应该需要有容错能力",0075 批——上游通道把
  // 文本提前解析成对象时 body 不因二次解析炸;概念层内置函数表同批扩注）。
  // 原"非字符串入参→计算异常"反例随幂等化改判为正例（42 原样返回,不再折 None）。
  it('正例（幂等）：已解析对象入参 → 原样返回可取字段', async () => {
    expect(await run(['r = parse_json(raw)', 'out = r.exists'], { raw: { exists: true, kind: 'file' } })).toBe(true);
  });

  it('正例（幂等）：数组入参 → 原样返回可推导', async () => {
    expect(await run(['xs = parse_json(raw)', 'out = [x for x in xs if x > 1]'], { raw: [1, 2, 3] })).toEqual([2, 3]);
  });

  it('正例（幂等）：数字入参 → 原样返回（原反例改判——修前折 None+warnLog"期望 JSON 文本"）', async () => {
    expect(await run(['out = parse_json(raw)'], { raw: 42 })).toBe(42);
  });

  it('正例（幂等）：布尔入参 → 原样返回', async () => {
    expect(await run(['out = parse_json(raw)'], { raw: false })).toBe(false);
  });

  it('正例（幂等）：null 入参 → 原样返回（null 是 JSON 值域成员）', async () => {
    expect(await run(['out = parse_json(raw)'], { raw: null })).toBe(null);
  });

  it('反例：undefined 入参照旧抛（不是 JSON 值域成员——引用未定义变量的信号不许静默吞;内置函数面直钉）', async () => {
    const { ACT_BUILTINS } = await import('../src/act-builtins.js');
    const pj = ACT_BUILTINS.get('parse_json')!;
    expect(() => pj.fn([undefined])).toThrow(/期望 JSON 文本.*undefined/);
  });
});

// work_zone_path 契约边界（design ^anc-exec-work-zone-path）：条件侧/无上下文两反例
// 补钉——正例端到端在 dispatcher.test.ts。 // @v: anc-exec-work-zone, anc-exec-work-zone-path
describe('work_zone_path 契约边界', () => {
  it('反例：case 条件里调用 → 计算异常折 undefined（需实例上下文）', () => {
    const errs: ParseError[] = [];
    const e = parseExpression('work_zone_path("x") == None', errs);
    const warns: string[] = [];
    const v = evalExprSync(e!, () => undefined, m => warns.push(m));
    expect(v).toBe(true);   // 折 None 后 == None 命中——降级可检测
    expect(warns.some(w => w.includes('实例上下文'))).toBe(true);
  });

  it('反例：body 执行环境未注入 workZone → TOOL_EXEC_ERROR 步骤失败', async () => {
    const errors: ParseError[] = [];
    const body = parseActBody(['p = work_zone_path("draft.md")'], 1, errors);
    expect(errors).toHaveLength(0);
    const interp = new BodyInterpreter({
      inputs: {}, toolProvider: { list: () => [], execute: async () => ({ result: '', success: true }) },
      allowCommit: false, toolCallLog: [],
    });
    await expect(interp.run(body!, [{ name: 'p', var_type: 'line' }] as OutputDecl[]))
      .rejects.toThrow(/work_zone/);
  });

  it('正例：注入 workZone 后返回拼接路径；无参返回根', async () => {
    const errors: ParseError[] = [];
    const body = parseActBody(['p = work_zone_path("draft.md")', 'root = work_zone_path()'], 1, errors);
    const interp = new BodyInterpreter({
      inputs: {}, toolProvider: { list: () => [], execute: async () => ({ result: '', success: true }) },
      allowCommit: false, workZone: '/wz/inst-1/work_zone', toolCallLog: [],
    });
    const out = await interp.run(body!, [
      { name: 'p', var_type: 'line' }, { name: 'root', var_type: 'line' },
    ] as OutputDecl[]);
    expect(out.p).toBe('/wz/inst-1/work_zone/draft.md');
    expect(out.root).toBe('/wz/inst-1/work_zone');
  });
});

// A 档能力实装（2026-08-10 作者定：列表/对象字面量、f-string、%//**、sorted/reversed/
// range/startswith/endswith）——每项正反例。 // @v: anc-exec-act-body-interp
describe('A 档：字面量构造与 f-string', () => {
  it('列表字面量：元素求值/空列表/嵌套', async () => {
    expect((await run('out = [1, 2 + 1, "a"]', {}, OUT('out'))).out).toEqual([1, 3, 'a']);
    expect((await run('out = []', {}, OUT('out'))).out).toEqual([]);
    expect((await run('out = [[1], [x]]', { x: 2 }, OUT('out'))).out).toEqual([[1], [2]]);
  });

  it('对象字面量：键限字符串字面量，值任意表达式', async () => {
    expect((await run('out = {"n": 1 + 1, "s": v}', { v: 'x' }, OUT('out'))).out).toEqual({ n: 2, s: 'x' });
    expect((await run('out = {}', {}, OUT('out'))).out).toEqual({});
  });

  it('正例：对象字面量变量键合法（Python 对齐 2026-08-20 改判——原拒收契约翻转,键=表达式求值）', () => {
    const errs: ParseError[] = [];
    const body = parseActBody(['o = {k: 1}'], 1, errs);
    expect(errs).toHaveLength(0);
    const dict = (body.statements[0] as { value: { entries: Array<{ key: { type: string } }> } }).value;
    expect(dict.entries[0].key.type).toBe('var');
  });

  it('f-string：插值/表达式/转义花括号/None 格式化', async () => {
    expect((await run('out = f"共{n}条, 均值={total / n}"', { n: 4, total: 10 }, OUT('out'))).out).toBe('共4条, 均值=2.5');
    expect((await run('out = f"{{literal}} {v}"', { v: 'x' }, OUT('out'))).out).toBe('{literal} x');
    expect((await run('out = f"v={v}"', { v: null }, OUT('out'))).out).toBe('v=None');
  });

  it('反例：f-string 插值未闭合/表达式非法 → parse error', () => {
    for (const src of ['s = f"x={v"', 's = f"x={+}"']) {
      const errs: ParseError[] = [];
      parseActBody([src], 1, errs);
      expect(errs.length, src).toBeGreaterThan(0);
    }
  });
});

describe('A 档：% // ** 运算符', () => {
  it('取模/整除/幂/幂右结合/Python 负号优先级', async () => {
    expect((await run('out = 10 % 3', {}, OUT('out'))).out).toBe(1);
    expect((await run('out = 10 // 3', {}, OUT('out'))).out).toBe(3);
    expect((await run('out = 2 ** 10', {}, OUT('out'))).out).toBe(1024);
    expect((await run('out = 2 ** 3 ** 2', {}, OUT('out'))).out).toBe(512);   // 右结合
    expect((await run('out = -2 ** 2', {}, OUT('out'))).out).toBe(-4);        // Python: -(2**2)
  });

  it('反例：% 不可转数字 → 计算异常折 null', async () => {
    const warnLog: string[] = [];
    const interp = new BodyInterpreter({ inputs: { s: 'abc' }, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [], warnLog });
    const outputs = await interp.run(body('out = s % 2'), [{ name: 'out', type: 'text', description: '' }] as any);
    expect(outputs.out).toBeNull();
    expect(warnLog.length).toBeGreaterThan(0);
  });
});

describe('A 档：sorted/reversed/range/startswith/endswith', () => {
  const call = (name: string, args: unknown[]) => ACT_BUILTINS.get(name)!.fn(args);
  it('sorted：数值按数排、字符串按字典序；原数组不动', () => {
    const xs = [3, 1, 2];
    expect(call('sorted', [xs])).toEqual([1, 2, 3]);
    expect(xs).toEqual([3, 1, 2]);
    expect(call('sorted', [['b', 'a']])).toEqual(['a', 'b']);
    expect(call('sorted', [[10, 9, 2]])).toEqual([2, 9, 10]);   // 数值序非字典序
  });
  it('reversed：反转拷贝', () => {
    expect(call('reversed', [[1, 2, 3]])).toEqual([3, 2, 1]);
  });
  it('range：单参/双参/步长/负步长；step=0 拒', () => {
    expect(call('range', [3])).toEqual([0, 1, 2]);
    expect(call('range', [1, 4])).toEqual([1, 2, 3]);
    expect(call('range', [1, 8, 3])).toEqual([1, 4, 7]);
    expect(call('range', [3, 0, -1])).toEqual([3, 2, 1]);
    expect(() => call('range', [1, 5, 0])).toThrow(/step/);
  });
  it('startswith/endswith', () => {
    expect(call('startswith', ['hello', 'he'])).toBe(true);
    expect(call('endswith', ['hello', 'lo'])).toBe(true);
    expect(call('startswith', ['hello', 'x'])).toBe(false);
  });
});

// B 档定向报错（有替代写法不实装——报错必须指对方向）。 // @v: anc-exec-act-body-interp
describe('B 档定向报错', () => {
  const parseErrs = (lines: string[]) => {
    const errs: ParseError[] = [];
    parseActBody(lines, 1, errs);
    return errs;
  };
  it('链式比较/pass/增强赋值/多重赋值 → 各自指路（三元已转正式支持,2026-08-17 作者改判）', () => {
    expect(parseErrs(['ok = 1 < x < 5'])[0].message).toContain('and 拆开');
    expect(parseErrs(['if a > 1:', '    pass'])[0].message).toContain('空分支');
    expect(parseErrs(['a += 1'])[0].message).toContain('写全 a = a +');
    expect(parseErrs(['a = b = 1'])[0].message).toContain('拆成两行');
  });
});

// 条件表达式 a if c else b（2026-08-17 作者定改判转正式支持——原 B 档报错让生成 LLM 错误泛化为
// "hop_python 不支持 if/else"连语句形都不敢写）。 // @v: anc-exec-act-body-interp, anc-step-act-body-lang
describe('条件表达式 a if c else b', () => {
  it('正例：基本形态两分支各命中', async () => {
    expect((await run('out = "h" if x > 3 else "l"', { x: 5 }, OUT('out'))).out).toBe('h');
    expect((await run('out = "h" if x > 3 else "l"', { x: 1 }, OUT('out'))).out).toBe('l');
  });
  it('正例：右结合嵌套（a if c1 else b if c2 else d）三段命中', async () => {
    const src = 'out = "big" if x > 9 else "mid" if x > 3 else "small"';
    expect((await run(src, { x: 10 }, OUT('out'))).out).toBe('big');
    expect((await run(src, { x: 5 }, OUT('out'))).out).toBe('mid');
    expect((await run(src, { x: 1 }, OUT('out'))).out).toBe('small');
  });
  it('正例：惰性求值——未命中分支不求值（除零/坏调用都不发生）', async () => {
    expect((await run('out = 1 if x > 3 else sum(x)', { x: 5 }, OUT('out'))).out).toBe(1);
  });
  it('正例：与 if 语句形等价可互换（同输入同输出）', async () => {
    const ternary = await run('out = "h" if x > 3 else "l"', { x: 5 }, OUT('out'));
    const stmt = await run('if x > 3:\n    out = "h"\nelse:\n    out = "l"', { x: 5 }, OUT('out'));
    expect(ternary.out).toBe(stmt.out);
  });
  it('正例：serialize 往返（parse→serialize→parse 结构稳定）', () => {
    const errs: ParseError[] = [];
    const b = parseActBody(['out = "h" if x > 3 else "l"'], 1, errs);
    expect(errs).toEqual([]);
    const text = serializeActBody(b!);
    expect(text).toContain('if x > 3 else');
    const errs2: ParseError[] = [];
    parseActBody(text.split('\n'), 1, errs2);
    expect(errs2).toEqual([]);
  });
  it('反例：缺 else 响亮报错（半个三元不静默吞）', () => {
    const errs: ParseError[] = [];
    parseActBody(['out = "h" if x > 3'], 1, errs);
    expect(errs.some(e => e.message.includes('缺 else'))).toBe(true);
  });
});

// 序列切片求值（^anc-step-act-body-slice——钳位宽容与单下标 None 传播分野,probe=todo/0071 全项）
// @v: anc-step-act-body-slice
describe('序列切片求值', () => {
  it('正例：probe 四基础项 l[1:]/l[:2]/l[-2:]/l[1:3]', async () => {
    const items = [1, 2, 3, 4, 5];
    expect((await run('out = items[1:]', { items }, OUT('out'))).out).toEqual([2, 3, 4, 5]);
    expect((await run('out = items[:2]', { items }, OUT('out'))).out).toEqual([1, 2]);
    expect((await run('out = items[-2:]', { items }, OUT('out'))).out).toEqual([4, 5]);
    expect((await run('out = items[1:3]', { items }, OUT('out'))).out).toEqual([2, 3]);
  });
  it('正例：字符串切片剥前缀 s[5:]（0066 实撞原场景）与去尾 s[:-1]', async () => {
    expect((await run('out = s[5:]', { s: 'L12: text' }, OUT('out'))).out).toBe('text');
    expect((await run('out = s[:-1]', { s: 'abc' }, OUT('out'))).out).toBe('ab');
  });
  it('正例：钳位宽容——l[10:]→[] / l[:99]→整列表 / 全省 l[:]→整拷贝', async () => {
    const items = [1, 2];
    expect((await run('out = items[10:]', { items }, OUT('out'))).out).toEqual([]);
    expect((await run('out = items[:99]', { items }, OUT('out'))).out).toEqual([1, 2]);
    expect((await run('out = items[:]', { items }, OUT('out'))).out).toEqual([1, 2]);
  });
  it('正例：条件表达式里切片可用（evalExprSync 同款）', () => {
    const errs: string[] = [];
    const v = evalExprSync(parseExpression('items[1:3] == [2, 3]', 1, [])!, (n) => (n === 'items' ? [1, 2, 3, 4] : undefined), (w) => errs.push(w));
    expect(v).toBe(true);
    expect(errs).toHaveLength(0);
  });
  it('反例：非列表/字符串上切片 → 计算异常 None（对象不支持切片,warnLog 文案在）', async () => {
    const warnLog: string[] = [];
    const interp = new BodyInterpreter({ inputs: { d: { a: 1 } }, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [], warnLog });
    const r = await interp.run(body('out = d[1:]'), OUT('out'));
    expect(r.out).toBeNull();
    expect(warnLog.some(w => w.includes('在非列表/字符串上切片'))).toBe(true);
  });
  it('反例：切片端点非整数（含数字串——不再 Number 强转静默过）→ 计算异常 None,warnLog 文案在', async () => {
    const warnLog: string[] = [];
    const interp = new BodyInterpreter({ inputs: { items: [1, 2], x: 'abc' }, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [], warnLog });
    const r = await interp.run(body('out = items[x:]'), OUT('out'));
    expect(r.out).toBeNull();
    expect(warnLog.some(w => w.includes('切片端点非整数'))).toBe(true);
    // 数字串端点(2026-09-05 review 抓:原 Number('2')=2 静默过,Python 本款 TypeError——收严为计算异常)
    const r2 = await run('out = items[s:]', { items: [1, 2, 3], s: '2' }, OUT('out'));
    expect(r2.out).toBeNull();
  });
  // 端点求值语义(2026-09-05 review 面二真机探针抓 None/undefined 分野后改定——设计 act-body.md 端点求值语义条款)
  // @v: anc-step-act-body-slice
  it('正例：None 端点按缺席（l[:None]=全量,与 Python 本款一致;值模型 None 与未赋值同视无值）', async () => {
    expect((await run('x = None\nout = items[:x]', { items: [1, 2, 3] }, OUT('out'))).out).toEqual([1, 2, 3]);
    expect((await run('x = None\nout = items[x:]', { items: [1, 2, 3] }, OUT('out'))).out).toEqual([1, 2, 3]);
  });
  it('正例：bool 端点当 0/1（Python 本款 True==1）', async () => {
    expect((await run('out = items[t:]', { items: [1, 2, 3], t: true }, OUT('out'))).out).toEqual([2, 3]);
  });
  it('正例：负数端点越界钳 0（l[-99:]=整拷贝——防将来 sliceValue 换实现丢 JS slice 巧合钳位）', async () => {
    expect((await run('out = items[-99:]', { items: [1, 2] }, OUT('out'))).out).toEqual([1, 2]);
    expect((await run('out = items[:-99]', { items: [1, 2] }, OUT('out'))).out).toEqual([]);
  });
  it('正例：start>stop 显式空序列（列表 [] 与字符串 "" 两形态）', async () => {
    expect((await run('out = items[3:1]', { items: [1, 2, 3, 4] }, OUT('out'))).out).toEqual([]);
    expect((await run('out = s[3:1]', { s: 'abcd' }, OUT('out'))).out).toBe('');
  });
  it('正例：表达式端点求值（l[n-1:len(l)]）', async () => {
    expect((await run('out = items[n-1:len(items)]', { items: [1, 2, 3, 4], n: 2 }, OUT('out'))).out).toEqual([2, 3, 4]);
  });
  it('反例：sync 档切片异常路径（非序列/数字串端点 → onWarn+undefined）', () => {
    const errs: string[] = [];
    const v1 = evalExprSync(parseExpression('d[1:]', 1, [])!, (n) => (n === 'd' ? { a: 1 } : undefined), (w) => errs.push(w));
    expect(v1).toBeUndefined();
    expect(errs.some(w => w.includes('在非列表/字符串上切片'))).toBe(true);
    const errs2: string[] = [];
    const v2 = evalExprSync(parseExpression('items[s:]', 1, [])!, (n) => (n === 'items' ? [1, 2] : n === 's' ? '1' : undefined), (w) => errs2.push(w));
    expect(v2).toBeUndefined();
    expect(errs2.some(w => w.includes('切片端点非整数'))).toBe(true);
  });
  // reversed 双收（2026-09-05 review 抓:step 报错指路 reversed 对字符串不成立——s[::-1] 的人按指路会再撞）
  it('正例：reversed 双收——列表返翻转列表,字符串返翻转字符串', async () => {
    expect((await run('out = reversed(items)', { items: [1, 2, 3] }, OUT('out'))).out).toEqual([3, 2, 1]);
    expect((await run('out = reversed(s)', { s: 'abc' }, OUT('out'))).out).toBe('cba');
  });

  it('反例（R12,2026-09-06 review 抓半边缺后补）：reversed 非序列入参（数字）→ 计算异常折 None,warnLog 留痕', async () => {
    const warnLog: string[] = [];
    const interp = new BodyInterpreter({ inputs: { n: 42 }, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [], warnLog });
    const r = await interp.run(body('out = reversed(n)'), OUT('out'));
    expect(r.out).toBeNull();
    expect(warnLog.length).toBeGreaterThan(0);
  });
});

// 存量缺口补钉（2026-08-10 作者核查：实测通过但零测试的能力——通过是巧合不是承诺）
// @v: anc-exec-act-body-interp
describe('存量能力补钉', () => {
  it('负数下标 items[-1] / 动态下标 items[i]', async () => {
    expect((await run('out = items[-1]', { items: [1, 2, 3] }, OUT('out'))).out).toBe(3);
    expect((await run('out = items[i]', { items: ['a', 'b'], i: 1 }, OUT('out'))).out).toBe('b');
  });
  it('字符串乘法 "-" * 3', async () => {
    expect((await run('out = "-" * 3', {}, OUT('out'))).out).toBe('---');
  });
  it('嵌套 if（两层）', async () => {
    const src = 'if a > 1:\n    if b > 2:\n        out = "ab"\n    else:\n        out = "a"\nelse:\n    out = "n"';
    expect((await run(src, { a: 5, b: 5 }, OUT('out'))).out).toBe('ab');
    expect((await run(src, { a: 5, b: 0 }, OUT('out'))).out).toBe('a');
    expect((await run(src, { a: 0, b: 5 }, OUT('out'))).out).toBe('n');
  });
  it('一元负号', async () => {
    expect((await run('out = -x', { x: 5 }, OUT('out'))).out).toBe(-5);
  });
  it('白名单逐函数正例（lower/round/abs/sum/strip/join/replace 此前无独立用例）', () => {
    const call = (name: string, args: unknown[]) => ACT_BUILTINS.get(name)!.fn(args);
    expect(call('lower', ['ABC'])).toBe('abc');
    expect(call('round', [2.567, 1])).toBe(2.6);
    expect(call('abs', [-3])).toBe(3);
    expect(call('sum', [[1, 2, 3]])).toBe(6);
    expect(call('strip', ['  x  '])).toBe('x');
    expect(call('join', [['a', 'b'], '-'])).toBe('a-b');
    expect(call('replace', ['a,b,c', ',', ';'])).toBe('a;b;c');
  });
});

// 核查补钉（2026-08-10 作者追问"正反例都补全了么"清点出的三缺口）：
// ①条件侧新表达式（evalExprSync 与 BodyInterpreter 是两份实现，body 侧绿不担保条件侧）；
// ②serializer 往返（复用模式重放依赖 serialize→reparse 闭环）；③零散反例。
// @v: anc-exec-act-body-interp
describe('A 档条件侧（evalExprSync 独立实现）', () => {
  const ev = (src: string, vars: Record<string, unknown>) => {
    const errs: ParseError[] = [];
    const e = parseExpression(src, errs);
    expect(errs, src).toHaveLength(0);
    return evalExprSync(e!, n => vars[n]);
  };
  it('正例：字面量构造/f-string/新算术/负数下标在条件里可用', () => {
    expect(ev('x in [1, 2]', { x: 2 })).toBe(true);
    expect(ev('len([1, 2]) > 1', {})).toBe(true);
    expect(ev('f"a" == "a"', {})).toBe(true);
    expect(ev('x % 2 == 0', { x: 2 })).toBe(true);
    expect(ev('x // 3 == 2', { x: 7 })).toBe(true);
    expect(ev('x ** 2 == 9', { x: 3 })).toBe(true);
    expect(ev('items[-1] == 3', { items: [1, 2, 3] })).toBe(true);
  });
  it('反例：% 不可转数字条件侧折 undefined（不炸）', () => {
    const errs: ParseError[] = [];
    const e = parseExpression('s % 2 == 0', errs);
    const warns: string[] = [];
    expect(evalExprSync(e!, () => 'abc', m => warns.push(m))).toBe(false);   // undefined == 0 → false
    expect(warns.length).toBeGreaterThan(0);
  });
});

// @v: anc-exec-ordered-compare —— 等值严格化 + is None（v0.7.0 作者定删宽松等值）：
// == 改 Python 严格深比较（跨类型 False 不异常），in 元素查找同语义；is 仅限 None 判定。
describe('等值 Python 严格语义 + is None', () => {
  it('正例：数字/bool 按数、深比较、None 家族互等、is None 归一', async () => {
    expect((await run('out = true == 1', {}, OUT('out'))).out).toBe(true);       // bool 属数字家族
    expect((await run('out = a == b', { a: [1, [2]], b: [1, [2]] }, OUT('out'))).out).toBe(true);   // 列表深比较
    expect((await run('out = a == b', { a: { k: 1 }, b: { k: 1 } }, OUT('out'))).out).toBe(true);   // 对象深比较
    expect((await run('out = x == None', { x: null }, OUT('out'))).out).toBe(true);
    expect((await run('out = x is None', { x: null }, OUT('out'))).out).toBe(true);         // is None ≡ == None
    expect((await run('out = x is not None', { x: 3 }, OUT('out'))).out).toBe(true);
  });
  it('反例：跨类型不相等不异常（宽松等值已废），in 同步严格', async () => {
    const warnLog: string[] = [];
    const interp = new BodyInterpreter({ inputs: { s: '3' }, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [], warnLog });
    const outputs = await interp.run(body('out = s == 3'), OUT('out'));
    expect(outputs.out).toBe(false);            // 原宽松为 true——数字串归一已移交输出边界
    expect(warnLog).toHaveLength(0);            // Python 同义：== 恒有答案，非计算异常
    expect((await run('out = 3 in xs', { xs: ['3'] }, OUT('out'))).out).toBe(false);   // in 与 == 同一等值
    expect((await run('out = a == b', { a: [1], b: [1, 2] }, OUT('out'))).out).toBe(false);
  });
  it('反例：is 右侧非 None 定向报错指路', () => {
    const errs: ParseError[] = [];
    parseExpression('x is 3', errs);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].message).toContain('仅限 None');
  });
  it('条件侧（evalExprSync）同语义：is None 可用、跨类型 False', () => {
    const ev = (src: string, vars: Record<string, unknown>) => {
      const errs: ParseError[] = [];
      const e = parseExpression(src, errs);
      expect(errs, src).toHaveLength(0);
      return evalExprSync(e!, n => vars[n]);
    };
    expect(ev('x is None', { x: undefined })).toBe(true);    // 未赋值同判
    expect(ev('s == 3', { s: '3' })).toBe(false);
  });
});

// @v: anc-exec-ordered-compare —— 序比较 Python 对齐（v0.6.0 作者定"心智用 python 一致"）：
// 同类型才可比；跨类型强转（"3"<5、None→0、列表 Number()）全部废为计算异常。双求值器成对钉。
describe('序比较同类型才可比（Python 语义）', () => {
  it('正例：数字/bool 按数、双字符串字典序、双列表逐元素', async () => {
    expect((await run('out = 3 < 5', {}, OUT('out'))).out).toBe(true);
    expect((await run('out = true < 2', {}, OUT('out'))).out).toBe(true);                       // bool 属数字家族
    expect((await run('out = a < b', { a: '2026-08-01', b: '2026-08-02' }, OUT('out'))).out).toBe(true);  // 日期串字典序
    expect((await run('out = "10" < "9"', {}, OUT('out'))).out).toBe(true);                      // 字典序非数值
    expect((await run('out = a < b', { a: [1, 2], b: [1, 3] }, OUT('out'))).out).toBe(true);     // 列表逐元素
    expect((await run('out = a < b', { a: [1], b: [1, 0] }, OUT('out'))).out).toBe(true);        // 前缀短者小
  });
  it('反例：数字×数字串/None/对象参比=计算异常折 None+warn（原强转行为已废）', async () => {
    for (const [src, inputs] of [
      ['out = s < 5', { s: '3' }],                 // 原强转为 true，现类型错
      ['out = x < 5', { x: null }],                // 原 None→0 静默为 true
      ['out = xs < 5', { xs: [1] }],               // 原单元素列表强转出 1<5
      ['out = a < b', { a: { k: 1 }, b: { k: 2 } }],
    ] as const) {
      const warnLog: string[] = [];
      const interp = new BodyInterpreter({ inputs: inputs as Record<string, unknown>, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [], warnLog });
      const outputs = await interp.run(body(src), OUT('out'));
      expect(outputs.out, src).toBeNull();
      expect(warnLog.some(w => w.includes('不可比')), src).toBe(true);
    }
  });
  it('条件侧（evalExprSync）同语义：字符串字典序可用，跨类型折 undefined 按不命中', () => {
    const ev = (src: string, vars: Record<string, unknown>, warns?: string[]) => {
      const errs: ParseError[] = [];
      const e = parseExpression(src, errs);
      expect(errs, src).toHaveLength(0);
      return evalExprSync(e!, n => vars[n], warns ? m => warns.push(m) : undefined);
    };
    expect(ev('day > "2026-08-01"', { day: '2026-08-02' })).toBe(true);
    const warns: string[] = [];
    expect(ev('s < 5', { s: '3' }, warns)).toBeUndefined();   // 条件整体按不命中
    expect(warns.some(w => w.includes('不可比'))).toBe(true);
  });
});

describe('A 档 serializer 往返（复用模式重放前提）', () => {
  const roundtrip = (src: string) => {
    const e1: ParseError[] = [];
    const b1 = parseActBody([src], 1, e1);
    expect(e1, src).toHaveLength(0);
    const out = serializeActBody(b1!);
    const e2: ParseError[] = [];
    const b2 = parseActBody(out.split('\n'), 1, e2);
    expect(e2, `回读 ${out}`).toHaveLength(0);
    expect(serializeActBody(b2!)).toBe(out);   // 二次序列化不动点
  };
  it('正例：新表达式类型全部 serialize→reparse 闭环', () => {
    for (const src of [
      'xs = [1, 2, "a"]', 'o = {"k": v, "n": 2}', 's = f"共{n}条 {{lit}}"',
      'r = a % b', 'r = a // b', 'r = a ** 2', 'ok = x in items', 'ok = x not in items',
    ]) roundtrip(src);
  });
  it('反例：列表字面量未闭合 → parse error', () => {
    const errs: ParseError[] = [];
    parseActBody(['xs = [1, 2'], 1, errs);
    expect(errs.length).toBeGreaterThan(0);
  });
  it('反例：负数下标越界读 undefined（不炸）', async () => {
    const r = await run('out = items[-9]', { items: [1] }, OUT('out'));
    expect(r.out).toBeUndefined();
  });
});

// Python 惯性 True/False 大写形归一（2026-08-10 盲测 expense 实撞：agent 写 approved = True
// 被 B4 报"未定义变量 True"——与 Python 对齐方针下直接归一，文档仍只教 true/false）
// @v: anc-exec-act-body-interp
describe('True/False 大写形归一', () => {
  it('正例：True/False 按布尔字面量求值（body 与条件同一 parsePrimary）', async () => {
    expect((await run('out = True', {}, OUT('out'))).out).toBe(true);
    expect((await run('out = False', {}, OUT('out'))).out).toBe(false);
    const errs: ParseError[] = [];
    const e = parseExpression('flag == True', errs);
    expect(errs).toHaveLength(0);
    expect(evalExprSync(e!, () => true)).toBe(true);
  });
  it('反例：TRUE/其他大小写变体仍按变量（未定义即报）', async () => {
    await expect(run('out = TRUE', {}, OUT('out'))).rejects.toThrow(/未定义变量/);
  });
});

// ===== hop_env 只读变量注入 =====
// @v: anc-exec-body-hop-env, anc-config-hop-env
describe('hop_env 只读变量注入（BodyExecContext.hopEnv）', () => {
  const HOP_ENV = { hop_env_kb_root: '/kb/brand', hop_env_lang: 'zh' };

  async function runWithEnv(src: string, outputs: OutputDecl[], warnLog?: string[]) {
    const interp = new BodyInterpreter({
      inputs: {}, toolProvider: mockProvider(), allowCommit: false,
      toolCallLog: [], warnLog, hopEnv: HOP_ENV,
    });
    return interp.run(body(src), outputs);
  }

  it('正例：body 引用已定义键取到值', async () => {
    const out = await runWithEnv('r = hop_env_kb_root', OUT('r'));
    expect(out.r).toBe('/kb/brand');
  });

  it('正例：f-string 插值走解释器既有文法', async () => {
    const out = await runWithEnv('r = f"{hop_env_kb_root}/规范.md"', OUT('r'));
    expect(out.r).toBe('/kb/brand/规范.md');
  });

  it('反例：引用表中不存在的 hop_env_* 键 → 引用未定义变量抛错（响亮不静默 None）', async () => {
    await expect(runWithEnv('r = hop_env_missing', OUT('r'))).rejects.toThrow(/未定义变量.*hop_env_missing/);
  });

  it('反例：赋值目标带 hop_env_ 前缀 → 计算异常（运行期写防线,replan body 兜底）', async () => {
    const warnLog: string[] = [];
    await runWithEnv('hop_env_kb_root = "/hacked"\nr = hop_env_kb_root', OUT('r'), warnLog);
    expect(warnLog.some(w => /hop_env_.*只读/.test(w))).toBe(true);
  });

  it('反例：写防线拦下后原值不变（表未被污染）', async () => {
    const warnLog: string[] = [];
    const out = await runWithEnv('hop_env_kb_root = "/hacked"\nr = hop_env_kb_root', OUT('r'), warnLog);
    expect(out.r).toBe('/kb/brand');
  });

  it('hopEnv 缺席时零影响（存量 body 行为不变）', async () => {
    const out = await run('r = "plain"', {}, OUT('r'));
    expect(out.r).toBe('plain');
  });
});


// dict 键=表达式求值（Python 对齐 2026-08-20——键求值 str 归一;None 键计算异常响亮）
// @v: anc-step-act-body-dict-key
describe('dict 变量键求值', () => {
  it('正例：字面量/变量/计算键混合求值,数字键 str 归一', async () => {
    const out = await run('k = "dyn"\nx = {"lit": 1, k: 2, f"p{k}": 3}\ny = {n: "num"}', { n: 7 },
      [{ name: 'x', type: 'yaml', description: '' }, { name: 'y', type: 'yaml', description: '' }]);
    expect(out.x).toEqual({ lit: 1, dyn: 2, pdyn: 3 });
    expect(out.y).toEqual({ '7': 'num' });   // 数字键 str 归一（JS 对象同义）
  });

  it('反例：None 键 → 计算异常响亮（不静默丢条目）', async () => {
    await expect(run('x = {ghost: 1}', { ghost: null }, [{ name: 'x', type: 'yaml', description: '' }]))
      .rejects.toThrow(/键求值为 None/);
  });
});

// 真值语义 Python 对齐（2026-08-20 作者拍板:空列表/空对象为假——真值面唯一未对齐 Python 处;
// yaml 值模型改结构后空列表形态大增,`if xs:` 判空须全类型工作,原空结构判真教学写法静默走错分支）
// @v: anc-exec-none-propagation
describe('真值语义:空结构为假（Python 对齐）', () => {
  it('正例：if 空列表/空对象走 else 分支;非空结构走 then', async () => {
    const src = 'if xs:\n    r = "nonempty"\nelse:\n    r = "empty"';
    expect((await run(src, { xs: [] }, OUT('r'))).r).toBe('empty');
    expect((await run(src, { xs: {} }, OUT('r'))).r).toBe('empty');
    expect((await run(src, { xs: ['a'] }, OUT('r'))).r).toBe('nonempty');
    expect((await run(src, { xs: { k: 1 } }, OUT('r'))).r).toBe('nonempty');
  });

  it('反例："false"/"0" 字符串仍真（真值只看空不空,bool 归一归输出边界）;any/all/bool 同口径', async () => {
    const src = 'r = "t" if xs else "f"';
    expect((await run(src, { xs: 'false' }, OUT('r'))).r).toBe('t');
    expect((await run(src, { xs: '0' }, OUT('r'))).r).toBe('t');
    const out = await run('a = any(items)\nb = all(items)\nc = bool(e)', { items: [[], {}, ''], e: [] },
      [{ name: 'a', type: 'bool', description: '' }, { name: 'b', type: 'bool', description: '' }, { name: 'c', type: 'bool', description: '' }]);
    expect(out.a).toBe(false);   // 元素全是空结构——any 假（原内联旧口径空列表元素算真）
    expect(out.b).toBe(false);
    expect(out.c).toBe(false);   // bool([]) Python 语义 False（原 Boolean([]) JS 语义 true）
  });

  it('正例：any/all 空列表字面语义——any([])=false、all([])=true（Python 对齐,概念文档承诺的字面语义直接锁）', async () => {
    const out = await run('a = any(e)\nb = all(e)', { e: [] },
      [{ name: 'a', type: 'bool', description: '' }, { name: 'b', type: 'bool', description: '' }]);
    expect(out.a).toBe(false);   // 空列表无一为真——any 假
    expect(out.b).toBe(true);    // 空列表无一为假（vacuous truth）——all 真
  });
});

// 列表推导求值（双求值器——async 解释器 scope 注入/同步求值器包装 readVar 注入）
// @v: anc-step-act-body-comprehension
describe('列表推导求值', () => {
  it('正例：映射+带滤+迭代变量遮蔽外层同名且退出恢复', async () => {
    const errors: import('../src/errors.js').ParseError[] = [];
    const body = parseActBody([
      'i = "outer"',
      'names = [i.name for i in items]',
      'long = [i.name for i in items if len(i.name) > 1]',
      'after = i',
    ], 1, errors)!;
    expect(errors).toHaveLength(0);
    const interp = new BodyInterpreter({ inputs: { items: [{ name: 'ab' }, { name: 'c' }] }, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [] });
    const out = await interp.run(body, [
      { name: 'names', type: '[line]', description: '' },
      { name: 'long', type: '[line]', description: '' },
      { name: 'after', type: 'line', description: '' },
    ]);
    expect(out.names).toEqual(['ab', 'c']);
    expect(out.long).toEqual(['ab']);
    expect(out.after).toBe('outer');   // 迭代变量退出后恢复外层值
  });

  // 嵌套深度≤2 求值面（2026-09-03 hopissues/0068——双求值器对推导递归通用,深度闸是静态文法面,求值零改动;本组实证）
  it('正例：0068 probe 原式真跑——2层嵌套(filter 内聚合谓词)求值正确', async () => {
    const errors: import('../src/errors.js').ParseError[] = [];
    const body = parseActBody(['alien = [x for x in xs if not any([startswith(strip(x), g) for g in gs])]'], 1, errors)!;
    expect(errors).toHaveLength(0);   // 修前此处红:列表推导禁嵌套×2
    const interp = new BodyInterpreter({
      inputs: { xs: ['第一百七十四条·第二款', '第四百条'], gs: ['第一百七十四条'] },
      toolProvider: mockProvider(), allowCommit: false, toolCallLog: [],
    });
    const out = await interp.run(body, [{ name: 'alien', type: '[line]', description: '' }]);
    expect(out.alien).toEqual(['第四百条']);
  });

  it('正例：2层裸嵌套(element 内推导)求值正确——构造嵌套列表', async () => {
    const errors: import('../src/errors.js').ParseError[] = [];
    const body = parseActBody(['m = [[y + 1 for y in x] for x in xs]'], 1, errors)!;
    expect(errors).toHaveLength(0);
    const interp = new BodyInterpreter({ inputs: { xs: [[1, 2], [3]] }, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [] });
    const out = await interp.run(body, [{ name: 'm', type: 'json', description: '' }]);
    expect(out.m).toEqual([[2, 3], [4]]);
  });

  it('反例：遍历对象非列表 → 计算异常（不静默造空表）', async () => {
    const errors: import('../src/errors.js').ParseError[] = [];
    const body = parseActBody(['names = [i for i in notalist]'], 1, errors)!;
    const interp = new BodyInterpreter({ inputs: { notalist: 'text' }, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [] });
    await expect(interp.run(body, [{ name: 'names', type: '[line]', description: '' }])).rejects.toThrow(/列表/);
  });
});

// @v: anc-exec-subprocess-run —— 命令行白名单调用（2026-08-29 todo/0033,作者拍 A 案:名字就叫 subprocess.run）
describe('subprocess.run 命令行白名单', () => {
  const WL = ['echo', 'cat'];   // 测试白名单:echo/cat 全平台在
  function mk(src: string, extra?: Partial<import('../src/act-body-interpreter.js').BodyExecContext>) {
    const errors: ParseError[] = [];
    const b = parseActBody(src.split('\n'), 1, errors);
    if (!b) throw new Error('parse failed: ' + JSON.stringify(errors));
    const journal: Array<{ stdout: string; stderr: string; returncode: number }> = [];
    const interp = new BodyInterpreter({
      inputs: {}, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [],
      commandWhitelist: WL, cmdJournal: journal, ...extra,
    });
    return { interp, b, journal };
  }

  // hopjit 恒拒名单（^anc-exec-subprocess-deny-hopjit,2026-08-30 作者定"hopjit 本身就不应该被 act 调用"）
  // @v: anc-exec-subprocess-deny-hopjit
  it('反例：argv[0]=hopjit 恒拒——白名单写了也不放行（层次约束:步骤内容不驱动引擎）', async () => {
    const { interp, b } = mk('r = subprocess.run(["hopjit", "status"])', { commandWhitelist: ['echo', 'hopjit'] });
    await expect(interp.run(b, OUT())).rejects.toThrow(/不得调用 hopjit/);
  });

  it('反例：路径形态 /usr/local/bin/hopjit 同拒（尾段判定,换路径绕不过）', async () => {
    const { interp, b } = mk('r = subprocess.run(["/usr/local/bin/hopjit", "run", "x.md"])', { commandWhitelist: ['/usr/local/bin/hopjit'] });
    await expect(interp.run(b, OUT())).rejects.toThrow(/不得调用 hopjit/);
  });

  it('正例：白名单命令真执行——echo 输出进 stdout,returncode=0,结果是结构体三字段', async () => {
    const { interp, b } = mk('r = subprocess.run(["echo", "hello"])\nout = r.stdout\ncode = r.returncode');
    const o = await interp.run(b, OUT('out', 'code'));
    expect(String(o['out'])).toContain('hello');
    expect(o['code']).toBe(0);
  });

  it('正例：管道形态——上一段 stdout 经 input= 喂下一段（cat 回显）', async () => {
    const { interp, b } = mk('a = subprocess.run(["echo", "piped-data"])\nr = subprocess.run(["cat"], input=a.stdout)\nout = r.stdout');
    const o = await interp.run(b, OUT('out'));
    expect(String(o['out'])).toContain('piped-data');
  });

  it('正例：journal 重放——第二次 run 从记录取值不重执行（命令不幂等,中断续跑从头重放）', async () => {
    const src = 'r = subprocess.run(["echo", "once"])\nout = r.stdout';
    const { interp, b, journal } = mk(src);
    await interp.run(b, OUT('out'));
    expect(journal.length).toBe(1);
    // 同一 journal 重建解释器重放:篡改记录值,若重执行会得真 echo 输出,取记录值则得篡改值
    journal[0] = { stdout: 'REPLAYED', stderr: '', returncode: 0 };
    const errors: ParseError[] = [];
    const b2 = parseActBody(src.split('\n'), 1, errors)!;
    const interp2 = new BodyInterpreter({ inputs: {}, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [], commandWhitelist: WL, cmdJournal: journal });
    const o2 = await interp2.run(b2, OUT('out'));
    expect(o2['out']).toBe('REPLAYED');
  });

  it('反例：白名单外命令拒——TOOL_EXEC_ERROR 点名命令与名单', async () => {
    const { interp, b } = mk('r = subprocess.run(["rm", "-rf", "x"])');
    await expect(interp.run(b, [])).rejects.toThrow(/命令 "rm" 不在白名单/);
  });

  it('反例：白名单缺席=能力关死（缺省安全）', async () => {
    const errors: ParseError[] = [];
    const b = parseActBody(['r = subprocess.run(["echo", "x"])'], 1, errors)!;
    const interp = new BodyInterpreter({ inputs: {}, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [] });
    await expect(interp.run(b, [])).rejects.toThrow(/未配置命令白名单/);
  });

  it('反例：整串命令行（argv 非列表）拒并指路列表形态', async () => {
    const { interp, b } = mk('r = subprocess.run("echo hello")');
    await expect(interp.run(b, [])).rejects.toThrow(/argv 必须是非空字符串列表/);
  });

  it('反例：Python 白名单外参数逐个拒并指路——check= 点名"失败是值"', async () => {
    const { interp, b } = mk('r = subprocess.run(["echo", "x"], check=True)');
    await expect(interp.run(b, [])).rejects.toThrow(/不支持参数 "check"/);
  });

  it('反例：shell= 同拒——把 shell 走私进来管控全失', async () => {
    const { interp, b } = mk('r = subprocess.run(["echo", "x"], shell=True)');
    await expect(interp.run(b, [])).rejects.toThrow(/不支持参数 "shell"/);
  });

  it('正例：参数里的分号只是字符——不经 shell,注入无门（echo 原样吐回）', async () => {
    const { interp, b } = mk('r = subprocess.run(["echo", "a; rm -rf /"])\nout = r.stdout');
    const o = await interp.run(b, OUT('out'));
    expect(String(o['out'])).toContain('a; rm -rf /');   // 分号被 echo 当普通字符输出,没有 shell 解释它
  });

  it('反例：timeout 非法值参数解析期拒——不执行命令（F6 裁定 B 早失败,修前红:warn"按缺省60执行"文案撒谎且命令真跑）', async () => {
    const { interp, b, journal } = mk('r = subprocess.run(["echo", "should-not-run"], timeout=0)');
    await expect(interp.run(b, [])).rejects.toThrow(/timeout=0 非法.*不执行命令/);
    expect(journal.length).toBe(0);   // 命令确实没跑——journal 零记录
  });

  it('反例：白名单内命令但系统不存在 → ENOENT 指路"找不到可执行文件"', async () => {
    const errors2: ParseError[] = [];
    const b2 = parseActBody(['r = subprocess.run(["no-such-cmd-xyz"])'], 1, errors2)!;
    const interp2 = new BodyInterpreter({ inputs: {}, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [], commandWhitelist: ['no-such-cmd-xyz'], cmdJournal: [] });
    await expect(interp2.run(b2, [])).rejects.toThrow(/找不到可执行文件|执行失败/);
  });

  it('反例：ENOBUFS 撞顶指路"输出过大用过滤收窄"——不截断是设计翻案后的行为（yes 灌爆 10MB）', async () => {
    const errors2: ParseError[] = [];
    const b3 = parseActBody(['r = subprocess.run(["yes"], timeout=10)'], 1, errors2)!;
    const interp2 = new BodyInterpreter({ inputs: {}, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [], commandWhitelist: ['yes'], cmdJournal: [] });
    await expect(interp2.run(b3, [])).rejects.toThrow(/输出超过 10MB 上限|执行失败/);
  }, 30000);

  it('反例：ETIMEDOUT 超时指路"可调大或收窄工作量"（sleep 2 撞 timeout=1）', async () => {
    const errors2: ParseError[] = [];
    const b2 = parseActBody(['r = subprocess.run(["sleep", "2"], timeout=1)'], 1, errors2)!;
    const interp2 = new BodyInterpreter({ inputs: {}, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [], commandWhitelist: ['sleep'], cmdJournal: [] });
    await expect(interp2.run(b2, [])).rejects.toThrow(/超时.*可调大|执行失败/);
  }, 10000);

  it('正例：cwd= 显式生效——pwd 输出为指定目录', async () => {
    const errors2: ParseError[] = [];
    const b2 = parseActBody(['r = subprocess.run(["pwd"], cwd="/tmp")', 'out = r.stdout'], 1, errors2)!;
    const interp2 = new BodyInterpreter({ inputs: {}, toolProvider: mockProvider(), allowCommit: false, toolCallLog: [], commandWhitelist: ['pwd'], cmdJournal: [] });
    const o = await interp2.run(b2, OUT('out'));
    expect(String(o['out']).trim().replace('/private','')).toBe('/tmp');
  });
});
