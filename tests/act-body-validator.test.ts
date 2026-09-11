// @module: act-body ^anc-struct-act-body
import { describe, it, expect } from 'vitest';
import { parseSpec } from '../src/parser.js';
import { validateSpec } from '../src/validator.js';
import { ACT_BUILTINS, ACT_BUILTIN_NAMES } from '../src/act-builtins.js';

// @v: anc-rule-b-all, anc-rule-b2, anc-rule-b4, anc-rule-b5
// act body 校验（B 系列）

function hasRule(errors: { rule: string }[], rule: string) {
  return errors.some(e => e.rule === rule);
}

function validateActBody(bodyLines: string, inputs = '', outputs = '  + → out: text  # o') {
  const spec = `# T
Id: t
## Goal
g
## Steps
1. [act] 测试
${inputs}${outputs}
  > \`\`\`hop_python
${bodyLines.split('\n').map(l => '  > ' + l).join('\n')}
  > \`\`\`
`;
  const { ast, errors: parseErrors } = parseSpec(spec);
  const errors = validateSpec(ast);
  return { parseErrors, errors };
}

describe('B 系列：act body 校验', () => {
  it('B4：引用未定义变量 → error', () => {
    const { errors } = validateActBody('out = unknown_var');
    expect(hasRule(errors, 'B4')).toBe(true);
  });

  // 切片端点经 exprChildren 下钻（2026-09-05 review 变异实锤:exprChildren slice case 砍掉端点后
  // B4 漏放,1287 例全绿存活——本钉即重放该变异的防线）
  // @v: anc-step-act-body-slice
  it('B4：切片端点里藏未定义变量 → error（items[ghost:2]/items[:ghost] 双形态）', () => {
    const t1 = validateActBody('out = items[ghost_start:2]', '  - ← items\n');
    expect(hasRule(t1.errors, 'B4')).toBe(true);
    const t2 = validateActBody('out = items[:ghost_stop]', '  - ← items\n');
    expect(hasRule(t2.errors, 'B4')).toBe(true);
  });

  // B4 default 下钻经 exprChildren（v0.10.0 ^anc-struct-expr-walk——复合节点子表达式自动覆盖）
  // @v: anc-struct-expr-walk
  it('B4：三元 else 支/列表元素里藏未定义变量 → error（复合节点 default 下钻）', () => {
    const t1 = validateActBody('out = "a" if 1 > 0 else ghost1');
    expect(hasRule(t1.errors, 'B4')).toBe(true);
    const t2 = validateActBody('out = [1, ghost2]');
    expect(hasRule(t2.errors, 'B4')).toBe(true);
  });

  it('B4：三元三支全合法 → 通过（下钻不误伤）', () => {
    const { errors } = validateActBody(
      'out = raw if len(raw) > 0 else "empty"',
      '  - ← raw\n',
    );
    expect(hasRule(errors, 'B4')).toBe(false);
  });

  it('B4：引用 ← 输入变量 → 通过', () => {
    const { errors } = validateActBody(
      'out = upper(raw)',
      '  - ← raw\n',
    );
    expect(hasRule(errors, 'B4')).toBe(false);
  });

  it('B4：引用上文赋值的局部变量 → 通过', () => {
    const { errors } = validateActBody('tmp = 5\nout = tmp');
    expect(hasRule(errors, 'B4')).toBe(false);
  });

  it('B4：分支内局部变量不泄漏到分支外 → 分支外引用报错', () => {
    const { errors } = validateActBody(
      'if 1 > 0:\n    local_x = 5\nout = local_x',  // local_x 只在 then 分支声明
    );
    expect(hasRule(errors, 'B4')).toBe(true);
  });

  it('B2：内置函数调用 → 通过', () => {
    const { errors } = validateActBody(
      'out = len(raw)',
      '  - ← raw\n',
    );
    expect(hasRule(errors, 'B2')).toBe(false);
  });

  it('B2：内置函数参数个数不符 → error', () => {
    const { errors } = validateActBody('out = len(1, 2, 3)');  // len 只接受 1 个
    expect(hasRule(errors, 'B2')).toBe(true);
    expect(errors.find(e => e.rule === 'B2')!.severity).toBe('error');
  });

  it('B2：非内置调用（视为工具）→ warn', () => {
    const { errors } = validateActBody(
      'out = fetch_data(url: raw)',
      '  - ← raw\n',
    );
    const b2 = errors.find(e => e.rule === 'B2');
    expect(b2).toBeDefined();
    expect(b2!.severity).toBe('warn');
  });

  // @v: anc-rule-b2 —— 内置文件/编辑工具零误报（此前漏列,body 调 write/read 误报
  // "非内置视为工具"warn——2026-09-06 R3 抽测两路独立撞,每个新作者付一次犹豫成本）
  it('B2：内置文件工具（write/read）→ 零 B2 条目', () => {
    const { errors } = validateActBody(
      'out = write(path: "o.md", content: raw)',
      '  - ← raw\n',
    );
    expect(hasRule(errors, 'B2')).toBe(false);
    const r = validateActBody('out = read(path: "in.md")');
    expect(hasRule(r.errors, 'B2')).toBe(false);
  });

  it('B2：文件工具名单不吞真未知名 → 照 warn（反例）', () => {
    const { errors } = validateActBody('out = wrote(path: "o.md")');  // 拼错的 write
    const b2 = errors.find(e => e.rule === 'B2');
    expect(b2).toBeDefined();
    expect(b2!.severity).toBe('warn');
  });

  it('B5：声明 +→ 输出但 body 不写 → warn', () => {
    const { errors } = validateActBody('tmp = 5');  // 声明 out 但只赋值 tmp
    expect(hasRule(errors, 'B5')).toBe(true);
    expect(errors.find(e => e.rule === 'B5')!.severity).toBe('warn');
  });

  it('B5：分支内赋值声明输出也算已写 → 不报 B5', () => {
    const { errors } = validateActBody(
      'if 1 > 0:\n    out = "a"\nelse:\n    out = "b"',
    );
    expect(hasRule(errors, 'B5')).toBe(false);
  });

  it('无 body 的 act 不触发 body 内容校验（B1-B6）;B7 形态 warn 是唯一例外（2026-08-22 [act free] 档新增）', () => {
    const spec = `# T
Id: t
## Goal
g
## Steps
1. [act] 普通
  + → out: text  # o
  > 自然语言执行
`;
    const { ast } = parseSpec(spec);
    const errors = validateSpec(ast);
    const bRules = errors.filter(e => e.rule.startsWith('B'));
    expect(bRules.every(e => e.rule === 'B7' && e.severity === 'warn')).toBe(true);
    expect(bRules.length).toBe(1);   // 恰 B7 一条:无 free 无 body 形态欠账提醒
  });
});

describe('内置函数白名单', () => {
  it('覆盖预期的函数集合', () => {
    for (const name of ['len', 'min', 'max', 'round', 'split', 'join', 'keys', 'get', 'float', 'str', 'bool', 'int', 'strip']) {
      expect(ACT_BUILTIN_NAMES.has(name)).toBe(true);
    }
  });

  it('内置函数可实际求值（阶段3执行器复用）', () => {
    expect(ACT_BUILTINS.get('len')!.fn([[1, 2, 3]])).toBe(3);
    expect(ACT_BUILTINS.get('upper')!.fn(['abc'])).toBe('ABC');
    expect(ACT_BUILTINS.get('split')!.fn(['a,b,c', ','])).toEqual(['a', 'b', 'c']);
    expect(ACT_BUILTINS.get('sum')!.fn([[1, 2, 3]])).toBe(6);
    expect(ACT_BUILTINS.get('count')!.fn([[]])).toBe(0);
    expect(ACT_BUILTINS.get('get')!.fn([{ a: 1 }, 'a'])).toBe(1);
    expect(ACT_BUILTINS.get('get')!.fn([{ a: 1 }, 'b', 'default'])).toBe('default');
  });

  it('不在白名单的名字', () => {
    expect(ACT_BUILTIN_NAMES.has('eval')).toBe(false);
    expect(ACT_BUILTIN_NAMES.has('exec')).toBe(false);
    expect(ACT_BUILTIN_NAMES.has('open')).toBe(false);  // IO 走 ToolProvider
  });

  // str(结构) = YAML 块式序列化（^anc-type-yaml-structured 文本化条款——原 String(obj)
  // 产 "[object Object]" 丢数据,三十六审探针实抓）。 // @v: anc-type-yaml-structured
  it('正例：str(结构) → YAML 块式文本;str(标量/字符串) 原语义不变', () => {
    const s = ACT_BUILTINS.get('str')!.fn([{ goal: 'g', inputs: [{ name: 'x' }] }]) as string;
    expect(s).toContain('goal: g');
    expect(s).toContain('- name: x');
    expect(s).not.toContain('[object Object]');
    expect(ACT_BUILTINS.get('str')!.fn([42])).toBe('42');
    expect(ACT_BUILTINS.get('str')!.fn(['ab'])).toBe('ab');
  });
});

// Python 惯性错误定向报错（2026-08-10 作者预警：agent 会编 import os / os.xxx——
// 泛用报错让 agent 盲目重试，文案必须指对方向）。正反例成对。
import { parseActBody } from '../src/act-body-parser.js';
import type { ParseError } from '../src/errors.js';

describe('Python 惯性错误定向报错', () => {
  const parse = (lines: string[]) => {
    const errs: ParseError[] = [];
    parseActBody(lines, 1, errs);
    return errs;
  };

  it('反例：import os / from os import → 定向报错（无 import，裸名直调）', () => {
    for (const lines of [['import os', 'x = 1'], ['from os import path']]) {
      const errs = parse(lines);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0].message).toContain('无 import');
      expect(errs[0].message).toContain('裸名');
    }
  });

  it('反例：os.listdir(x) / s.strip() 方法调用形 → 定向报错（指出函数化写法）', () => {
    for (const lines of [['files = os.listdir(dir_path)'], ['c = text.strip()'], ['ok = os.path.exists(p)']]) {
      const errs = parse(lines);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0].message).toContain('无模块/方法调用');
      expect(errs[0].message).toContain('strip(s)');
    }
  });

  // 报错指路必须给存在的替代（buildtest 实撞:xs.append(...) 被拒后 LLM 按旧文案"方法函数化"
  // 写裸名 append——白名单无此函数,下一轮撞"未知函数",指路指向不存在的路=反馈死循环）
  it('反例：xs.append(item) 报错文案给拼接正解（append 不在白名单,不指死路）', () => {
    const errs = parse(['urgent_list.append(entry)']);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].message).toContain('xs = xs + [item]');
    expect(errs[0].message).toContain('无 append');
  });

  it('正例：裸名调用照常合法（strip(s)/listdir 工具）', () => {
    expect(parse(['cleaned = strip(text)'])).toHaveLength(0);
    expect(parse(['files = listdir(path: dir_path)'])).toHaveLength(0);
  });
});


// dict 键位 B4（Python 对齐 2026-08-20——裸名键未定义专属报文指路两改法;已定义变量键合法）
// @v: anc-step-act-body-dict-key
describe('dict 键位 B4', () => {
  it('反例：裸名键未定义 → B4 error 指路两改法（加引号/先定义）', () => {
    const { errors } = validateActBody('out = {invoice: 1}', '', '  + → out: yaml  # o');
    const hit = errors.find(e => e.rule === 'B4');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('{"invoice"');
    expect(hit!.message).toContain('先给该变量赋值');
  });

  it('正例：已定义变量键/字面量键零 B4', () => {
    const { errors } = validateActBody('k = "a"\nout = {"lit": 1, k: 2}', '', '  + → out: yaml  # o');
    expect(errors.filter(e => e.rule === 'B4')).toEqual([]);
  });
});

// check body 同受 B 系列（概念'与 act 同文法同解释器'——三十五审抓漏:原 B 面只挂 act/commit,
// check body 的 ghost 变量 validate 绿、运行期才炸）
// @v: anc-rule-b-all, anc-step-check-body
describe('check body B 系列覆盖', () => {
  const mkCheck = (bodyLines: string, inputs = '') => `# T
Id: t
## Goal
g
## Steps
1. [check] 判
${inputs}  + → ok: bool  # 判定
  + → why: text  # 说明
  > \`\`\`hop_python
${bodyLines.split('\n').map(l => '  > ' + l).join('\n')}
  > \`\`\`
`;

  it('正例：check body 引用 ← 输入合法零 B 报', () => {
    const { ast, errors: pe } = parseSpec(mkCheck('ok = len(raw) > 0\nwhy = "checked"', '  - ← raw\n'));
    expect(pe).toHaveLength(0);
    expect(validateSpec(ast).filter(e => e.rule.startsWith('B') && e.severity === 'error')).toEqual([]);
  });

  it('反例：check body 引用未定义变量 → B4 error（不再静默放行到运行期）', () => {
    const { ast } = parseSpec(mkCheck('ok = len(ghost_var) > 0\nwhy = "x"'));
    const errs = validateSpec(ast).filter(e => e.rule === 'B4');
    expect(errs.some(e => e.message.includes('ghost_var'))).toBe(true);
  });
});

// 推导迭代变量的 B4 可见性（itemVar 是绑定变量——element/filter 扩展可见集,source 用原集）
// @v: anc-step-act-body-comprehension
describe('列表推导 B4 可见性', () => {
  it('正例：itemVar 在 element/filter 内可见不误报', () => {
    const md = '# T\n\n## Goal\ng\n\n## Inputs\n- xs: yaml\n\n## Steps\n1. [act] 提取\n  - ← xs\n  + → names: [line]  # v\n  > ```hop_python\n  > names = [i.name for i in xs if len(i.name) > 1]\n  > ```\n';
    const { ast, errors: pe } = parseSpec(md);
    expect(pe).toHaveLength(0);
    const errs = validateSpec(ast).filter(e => e.severity === 'error');
    expect(errs).toEqual([]);
  });

  it('反例：source 引用未定义变量仍拦（可见集扩展只及 element/filter）', () => {
    const md = '# T\n\n## Goal\ng\n\n## Steps\n1. [act] 提取\n  + → names: [line]  # v\n  > ```hop_python\n  > names = [i for i in ghost_list]\n  > ```\n';
    const { ast } = parseSpec(md);
    const errs = validateSpec(ast).filter(e => e.rule === 'B4');
    expect(errs.some(e => e.message.includes('ghost_list'))).toBe(true);
  });

  it('反例：itemVar 泄漏到推导外引用仍拦', () => {
    const md = '# T\n\n## Goal\ng\n\n## Inputs\n- xs: yaml\n\n## Steps\n1. [act] 提取\n  - ← xs\n  + → names: [line]  # v\n  + → leak: line  # v\n  > ```hop_python\n  > names = [i for i in xs]\n  > leak = i\n  > ```\n';
    const { ast } = parseSpec(md);
    const errs = validateSpec(ast).filter(e => e.rule === 'B4');
    expect(errs.some(e => e.message.includes('"i"'))).toBe(true);
  });
});

// @v: anc-exec-subprocess-run —— B2 专项静态拒（review 抓设计"validate 拒"未实装:env= 曾全绿到运行期才死）
describe('B2 subprocess.run 具名参数专项', () => {
  function v(body: string) {
    const md = `# T
Id: t
## Goal
g
## Outputs
- out: text  # o
## Inputs
- src_text: text  # in
## Steps
1. [act] 干
  - ← src_text
  + → out: text  # o
> \`\`\`hop_python
> ${body}
> out = "x"
> \`\`\`
`;
    const { ast, errors: pe } = parseSpec(md);
    if (pe.length) return pe.map(e => ({ rule: 'parse', severity: 'error' as const, message: e.message }));
    return validateSpec(ast!);
  }

  it('反例：env= 禁参 validate 期 error 点名指路（修前红:arity≤4 全绿到运行期）', () => {
    const errs = v('r = subprocess.run(["echo", "x"], env=src_text)');
    expect(errs.some(e => e.severity === 'error' && e.message.includes('不支持参数 "env"'))).toBe(true);
  });

  it('反例：双位置参数 validate 期拒——argv 只有一个', () => {
    const errs = v('r = subprocess.run(["echo"], ["extra"])');
    expect(errs.some(e => e.severity === 'error' && e.message.includes('只接受一个位置参数'))).toBe(true);
  });

  it('正例：argv+input+timeout+cwd 四项合法形态零 error', () => {
    const errs = v('r = subprocess.run(["cat"], input=src_text, timeout=30, cwd=src_text)');
    expect(errs.filter(e => e.severity === 'error')).toHaveLength(0);
  });
});

// @v: anc-exec-subprocess-run —— case 条件占位拒（缺口⑩:占位 throw 零测试引用）
describe('subprocess.run case 条件拒调', () => {
  it('反例：case 条件里调 subprocess.run → 占位 fn throw 折计算异常,条件按不命中（now/today 同款模式）', () => {
    const { fn } = ACT_BUILTINS.get('subprocess.run')!;
    expect(() => fn([['echo', 'x']])).toThrow(/需要实例上下文/);
  });
});
