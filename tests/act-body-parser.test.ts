// @module: act-body ^anc-struct-act-body
import { describe, it, expect } from 'vitest';
import { parseSpec } from '../src/parser.js';
import { parseActBody, serializeActBody, exprChildren, exprMapChildren, exprHasCall } from '../src/act-body-parser.js';
import type { ParseError } from '../src/errors.js';
import type { ActStep, CommitStep, AssignStmt, IfStmt, CallStmt, BinaryExpr, CallExpr } from '../src/ast-types.js';

// @v: anc-ast-act-body
// act body 结构化解析（```hop_python 围栏 → ActBody AST）

function actStep(body: string, decls = '  + → out: text  # o') {
  const spec = `# T
Id: t
## Goal
g
## Steps
1. [act] 测试
${decls}
  > 说明行
  > \`\`\`hop_python
${body.split('\n').map(l => '  > ' + l).join('\n')}
  > \`\`\`
`;
  const { ast, errors } = parseSpec(spec);
  return { step: ast.steps?.[0] as ActStep, errors, ast };
}

describe('act body 解析', () => {
  // @v: anc-exec-act-body-interp — 字符串转义标准语义（v0.2.2：\n 曾丢失为字面 n，coffee-week 周报换行实撞）
  it('字符串字面量转义：\\n 换行 \\t 制表 \\\\ 反斜杠', () => {
    const { step, errors } = actStep('x = "a\\nb\\tc\\\\d"\nout = x');
    expect(errors.filter(e => e.kind === 'parse')).toHaveLength(0);
    const assign = step.body!.statements[0] as AssignStmt;
    expect((assign.value as any).value).toBe('a\nb\tc\\d');
  });

  it('无 body 的 act：body undefined，零回归', () => {
    const spec = `# T
Id: t
## Goal
g
## Steps
1. [act] 普通
  + → out: text  # o
  > 自然语言执行说明
`;
    const { ast } = parseSpec(spec);
    const step = ast.steps?.[0] as ActStep;
    expect(step.body).toBeUndefined();
    expect(step.instruction).toContain('自然语言');
  });

  it('单赋值 + 工具调用（命名参数）', () => {
    const { step, errors } = actStep('out = fetch(url: "http://x")');
    expect(errors.filter(e => e.severity === 'error' || e.kind === 'parse')).toHaveLength(0);
    expect(step.body).toBeDefined();
    expect(step.body!.statements).toHaveLength(1);
    const a = step.body!.statements[0] as AssignStmt;
    expect(a.type).toBe('assign');
    expect(a.target).toBe('out');
    const call = a.value as CallExpr;
    expect(call.type).toBe('call');
    expect(call.callee).toBe('fetch');
    expect(call.args[0].name).toBe('url');
  });

  it('围栏与自然语言说明共存：instruction 保留说明、不含 body', () => {
    const { step } = actStep('out = 5');
    expect(step.instruction).toContain('说明行');
    expect(step.instruction).not.toContain('hop_python');
    expect(step.instruction).not.toContain('out = 5');
    expect(step.body).toBeDefined();
  });

  it('算术表达式 + 优先级', () => {
    const { step, errors } = actStep('out = a + b * 2');
    expect(errors).toHaveLength(0);
    const a = step.body!.statements[0] as AssignStmt;
    const e = a.value as BinaryExpr;
    expect(e.op).toBe('+');                       // 顶层是 +
    expect((e.right as BinaryExpr).op).toBe('*'); // 右侧是 *（优先级正确）
  });

  it('比较 + 字段取', () => {
    const { step, errors } = actStep('out = cfg.threshold > 3');
    expect(errors).toHaveLength(0);
    const a = step.body!.statements[0] as AssignStmt;
    const e = a.value as BinaryExpr;
    expect(e.op).toBe('>');
    expect((e.left as any).type).toBe('field');
    expect((e.left as any).field).toBe('threshold');
  });

  it('内置函数调用（位置参数）', () => {
    const { step, errors } = actStep('out = len(items)');
    expect(errors).toHaveLength(0);
    const call = (step.body!.statements[0] as AssignStmt).value as CallExpr;
    expect(call.callee).toBe('len');
    expect(call.args[0].name).toBeUndefined();   // 位置参数无 name
    expect((call.args[0].value as any).name).toBe('items');
  });

  it('if-else 块', () => {
    const { step, errors } = actStep(
      'if x > 3:\n    out = "high"\nelse:\n    out = "low"'
    );
    expect(errors).toHaveLength(0);
    const ifst = step.body!.statements[0] as IfStmt;
    expect(ifst.type).toBe('if');
    expect(ifst.then_body).toHaveLength(1);
    expect(ifst.else_body).toHaveLength(1);
  });

  it('if-elif-else：elif 展开为嵌套 IfStmt', () => {
    const { step, errors } = actStep(
      'if x > 9:\n    out = "h"\nelif x > 3:\n    out = "m"\nelse:\n    out = "l"'
    );
    expect(errors).toHaveLength(0);
    const ifst = step.body!.statements[0] as IfStmt;
    expect(ifst.else_body).toHaveLength(1);
    const nested = ifst.else_body![0] as IfStmt;
    expect(nested.type).toBe('if');             // elif → 嵌套 if
    expect(nested.then_body).toHaveLength(1);
    expect(nested.else_body).toHaveLength(1);   // 最终 else
  });

  it('多语句顺序', () => {
    const { step, errors } = actStep('a = 1\nb = 2\nout = a + b');
    expect(errors).toHaveLength(0);
    expect(step.body!.statements).toHaveLength(3);
  });

  it('禁循环：for → 解析错误，body 不产出', () => {
    const { step, errors } = actStep('for x in items:\n    out = x');
    expect(errors.some(e => e.kind === 'parse' && /循环/.test(e.message))).toBe(true);
    expect(step.body).toBeUndefined();
  });

  it('禁循环：while → 解析错误', () => {
    const { errors } = actStep('while x:\n    out = 1');
    expect(errors.some(e => e.kind === 'parse' && /循环/.test(e.message))).toBe(true);
  });

  it('禁 tab 缩进：「> 空格+tab」形态的 tab 残留进 body → 报错', () => {
    // > 紧跟的 tab 会被 RE_INSTRUCTION 吞掉，但「> 空格 tab」形态 tab 残留进 body 行首
    const spec = `# T
Id: t
## Goal
g
## Steps
1. [act] 测试
  + → out: text  # o
  > \`\`\`hop_python
  > if x:
  > \tout = 1
  > \`\`\`
`;
    const { errors } = parseSpec(spec);
    expect(errors.some(e => e.kind === 'parse' && /tab/.test(e.message))).toBe(true);
  });

  it('独立语句调用（无赋值）', () => {
    const { step, errors } = actStep('write(path: "out.txt", content: data)');
    expect(errors).toHaveLength(0);
    const c = step.body!.statements[0] as CallStmt;
    expect(c.type).toBe('call');
    expect(c.call.callee).toBe('write');
  });

  it('commit 步骤也支持 body', () => {
    const spec = `# T
Id: t
## Goal
g
## Steps
1. [commit] 发送
  + → sent: bool  # s
  > 发送邮件
  > \`\`\`hop_python
  > sent = send_email(to: addr, body: content)
  > \`\`\`
`;
    const { ast, errors } = parseSpec(spec);
    const step = ast.steps?.[0] as CommitStep;
    expect(errors.filter(e => e.kind === 'parse')).toHaveLength(0);
    expect(step.body).toBeDefined();
    expect(step.irreversible_action).toContain('发送邮件');
  });
});

// serializeExpr 按优先级加括号（v0.9.1——三审探针实抓存量语义漂移:零括号版把 -(a+b) 序列化成
// -a + b,而 serializeActBody 是复用模式交付 caller"严格按此执行"的执行文本〔prompt ACT BODY 段〕,
// 携带错误逻辑）。判据=AST 级往返稳定（字符串级往返测不出——漂移后的字符串也能 reparse）。
// @v: anc-struct-act-body-exports
describe('serializeExpr 优先级括号（AST 级往返稳定）', () => {
  const strip = (k: string, v: unknown) => k === 'line' ? undefined : v;
  const astStable = (src: string): boolean => {
    const e1: ParseError[] = [];
    const b1 = parseActBody([src], 1, e1);
    expect(e1).toEqual([]);
    const text = serializeActBody(b1!);
    const e2: ParseError[] = [];
    const b2 = parseActBody(text.split('\n'), 1, e2);
    expect(e2, `reparse 失败: ${text}`).toEqual([]);
    return JSON.stringify(b1, strip) === JSON.stringify(b2, strip);
  };

  it('正例：括号语义保持（原五漂移形态 + ** 右结合两向）', () => {
    for (const src of [
      'out = ("h" if x > 3 else "l") == "x"',   // 三元进比较位
      'out = (a or b) and c',
      'out = not (a and b)',
      'out = (a + b) * c',
      'out = -(a + b)',
      'out = a - (b - c)',                       // 左结合右侧同级
      'out = (2 ** 3) ** 2',                     // ** 右结合左侧同级
    ]) expect(astStable(src), src).toBe(true);
  });

  it('反例面：自然优先级形态不多余加括号（序列化最简）', () => {
    for (const [src, expected] of [
      ['out = a + b * c', 'out = a + b * c'],
      ['out = a or b and c', 'out = a or b and c'],
      ['out = "h" if x > 3 else "l"', 'out = "h" if x > 3 else "l"'],
      ['out = a - b - c', 'out = a - b - c'],
      ['out = 2 ** 3 ** 2', 'out = 2 ** 3 ** 2'],       // ** 右结合右侧同级原样（左侧同级才括）
    ] as const) {
      const e: ParseError[] = [];
      const b = parseActBody([src], 1, e);
      expect(serializeActBody(b!), src).toBe(expected);
      expect(astStable(src), src).toBe(true);
    }
  });
});

// 表达式遍历原语（v0.10.0 ^anc-struct-expr-walk——B+A 基建:子表达式清单唯一权威+never 穷尽断言）。
// @v: anc-struct-expr-walk
describe('exprChildren / exprMapChildren 遍历原语', () => {
  const parse1 = (src: string) => {
    const errs: ParseError[] = [];
    const b = parseActBody([src], 1, errs);
    expect(errs).toEqual([]);
    return (b!.statements[0] as AssignStmt).value;
  };

  it('正例：11 种节点的孩子清单形状（清单即权威——扫描面全靠它下钻）', () => {
    expect(exprChildren(parse1('x = 1'))).toEqual([]);                                  // literal
    expect(exprChildren(parse1('x = y'))).toEqual([]);                                  // var
    expect(exprChildren(parse1('x = a.b'))).toHaveLength(1);                            // field
    expect(exprChildren(parse1('x = a[i]'))).toHaveLength(2);                           // index
    expect(exprChildren(parse1('x = -a'))).toHaveLength(1);                             // unary
    expect(exprChildren(parse1('x = a + b'))).toHaveLength(2);                          // binary
    expect(exprChildren(parse1('x = len(a, b)'))).toHaveLength(2);                      // call args
    expect(exprChildren(parse1('x = [a, b, c]'))).toHaveLength(3);                      // list
    expect(exprChildren(parse1('x = {"k": v}'))).toHaveLength(2);                       // dict key+value（键=表达式,Python 对齐 2026-08-20）
    expect(exprChildren(parse1('x = f"a{p}b{q}"'))).toHaveLength(2);                    // fstring 插值(文本段不算)
    expect(exprChildren(parse1('x = a if c else b'))).toHaveLength(3);                  // ternary 三支
  });

  // dict 键=表达式（Python 对齐 2026-08-20 作者定『与 python 一致』——原『键限字符串字面量』
  // 人为收紧废;重档真递归实录:flash 写裸键 {invoice: x} 三轮 parse error 递归子调用全灭）
  // @v: anc-step-act-body-dict-key
  it('正例：dict 键三形态——字面量/变量/f-string 计算键,serialize 往返稳定', () => {
    const errs: ParseError[] = [];
    const body = parseActBody(['x = {"lit": 1, kv: 2, f"p{kv}": 3}'], 1, errs);
    expect(errs).toHaveLength(0);
    const dict = (body.statements[0] as { value: { type: string; entries: Array<{ key: { type: string } }> } }).value;
    expect(dict.entries.map(en => en.key.type)).toEqual(['literal', 'var', 'fstring']);
    const rendered = serializeActBody(body);
    const errs2: ParseError[] = [];
    const body2 = parseActBody(rendered.split('\n'), 1, errs2);
    expect(errs2).toHaveLength(0);
    expect(JSON.stringify(body2.statements[0])).toBe(JSON.stringify(body.statements[0]).replace(/,"line":\d+/, ',"line":1'));
  });

  it('正例：exprMapChildren 同构重建——恒等映射结构不变,替换映射只动孩子', () => {
    const e = parse1('x = a + b');
    expect(exprMapChildren(e, c => c)).toEqual(e);                                      // 恒等
    const swapped = exprMapChildren(e, () => ({ type: 'literal', value: 0, literal_kind: 'number' } as never));
    expect((swapped as BinaryExpr).left).toEqual({ type: 'literal', value: 0, literal_kind: 'number' });
    expect((swapped as BinaryExpr).op).toBe((e as BinaryExpr).op);                      // 自身字段不动
  });

  it('反例：扫描面经原语真下钻——深嵌套（三元里 fstring 里 call）工具调用被 exprHasCall 挖出', () => {
    const deep = parse1('x = ("a" if c else f"v={read(path: p)}")');
    expect(exprHasCall(deep)).toBe(true);
  });
});


// 列表推导（2026-08-19 作者拍板『[i.name for i in inputs] 可以加,风险可控』——纯映射/过滤
// 有界零状态,不违禁循环本意;此前对象列表提字段名单只能靠 LLM 动脑,工具参数拼装被迫走转述面）
// @v: anc-step-act-body-comprehension
describe('列表推导', () => {
  const parse = (lines: string[]) => {
    const errors: import('../src/errors.js').ParseError[] = [];
    const body = parseActBody(lines, 1, errors);
    return { body, errors };
  };

  it('正例：基础映射 [i.name for i in inputs] 解析为 comprehension 节点', () => {
    const { body, errors } = parse(['names = [i.name for i in inputs]']);
    expect(errors).toHaveLength(0);
    const assign = body!.statements[0] as { value: { type: string; itemVar: string } };
    expect(assign.value.type).toBe('comprehension');
    expect(assign.value.itemVar).toBe('i');
  });

  it('正例：带滤形态 [x for x in xs if len(x) > 3]', () => {
    const { body, errors } = parse(['long = [x for x in xs if len(x) > 3]']);
    expect(errors).toHaveLength(0);
    const v = (body!.statements[0] as { value: { type: string; filter?: unknown } }).value;
    expect(v.type).toBe('comprehension');
    expect(v.filter).toBeDefined();
  });

  it('正例：序列化往返稳定', () => {
    const { body } = parse(['names = [i.name for i in inputs if i.name != "x"]']);
    const text = serializeActBody(body!);
    expect(text).toContain('[i.name for i in inputs if');
    const { body: b2, errors: e2 } = parse(text.split('\n'));
    expect(e2).toHaveLength(0);
    expect((b2!.statements[0] as { value: { type: string } }).value.type).toBe('comprehension');
  });

  it('反例：语句级 for 循环仍拦（推导放行不开循环口子）', () => {
    const { errors } = parse(['for x in xs:', '    y = x']);
    expect(errors.some(e => e.message.includes('禁止循环语句'))).toBe(true);
  });

  it('反例：while 恒拦（无推导形态）', () => {
    const { errors } = parse(['while ok:', '    y = 1']);
    expect(errors.some(e => e.message.includes('禁止循环语句'))).toBe(true);
  });

  // 嵌套深度≤2（2026-09-03 作者拍板放宽原禁嵌套——hopissues/0068:外层过滤+内层聚合谓词是
  // 标准 Python 合法形态被整体堵死;深度定义:顶层=第1层,element/source/filter 内=第2层,再嵌=第3层拒）
  it('正例：2层嵌套放行——filter 内聚合谓词形（0068 probe 原式）', () => {
    const { errors } = parse(['alien = [x for x in xs if not any([startswith(strip(x), g) for g in gs])]']);
    expect(errors).toHaveLength(0);
  });

  it('正例：2层裸嵌套放行——element 内推导构造嵌套列表（拍板已知副作用,同为标准 Python 且有界）', () => {
    const { errors, body } = parse(['m = [[y for y in x] for x in xs]']);
    expect(errors).toHaveLength(0);
    expect((body!.statements[0] as { value: { type: string } }).value.type).toBe('comprehension');
  });

  it('反例：3层嵌套拒——source 链上三层（放开不是无界）', () => {
    const { errors } = parse(['z = [[w for w in [v for v in y]] for y in xs]']);
    expect(errors.some(e => e.message.includes('超两层'))).toBe(true);
  });

  it('反例：3层嵌套拒——filter 内嵌套里再嵌套', () => {
    const { errors } = parse(['z = [x for x in xs if any([any([e for e in g]) for g in gs])]']);
    expect(errors.some(e => e.message.includes('超两层'))).toBe(true);
  });
});

// @v: anc-exec-subprocess-run —— parser 特例与 kwargs 双形态（2026-08-29 todo/0033）
// 序列切片（^anc-step-act-body-slice,2026-09-05 todo/0071——0066 实撞 l[2:] 报"] 未闭合"不指路）
// @v: anc-step-act-body-slice
describe('序列切片解析', () => {
  const parse = (lines: string[]) => {
    const errors: import('../src/errors.js').ParseError[] = [];
    const body = parseActBody(lines, 1, errors);
    return { body, errors };
  };

  it('正例：四形态解析为 slice 节点（双端/省start/省stop/全省）', () => {
    for (const src of ['x = l[1:3]', 'x = l[:2]', 'x = l[2:]', 'x = l[:]']) {
      const { body, errors } = parse([src]);
      expect(errors, src).toHaveLength(0);
      const assign = body!.statements[0] as { value: { type: string } };
      expect(assign.value.type, src).toBe('slice');
    }
  });

  it('正例：负数端点与表达式端点（l[-2:] / l[n-1:len(l)]——断节点形态,2026-09-05 review 抓弱钉补强）', () => {
    for (const src of ['x = l[-2:]', 'x = l[n-1:len(l)]']) {
      const { body, errors } = parse([src]);
      expect(errors, src).toHaveLength(0);
      const assign = body!.statements[0] as { value: { type: string } };
      expect(assign.value.type, src).toBe('slice');
    }
  });

  it('正例：单下标路径零回归（l[0]/l[-1]/l[i] 仍为 index 节点）', () => {
    for (const src of ['x = l[0]', 'x = l[-1]', 'x = l[i]']) {
      const { body, errors } = parse([src]);
      expect(errors, src).toHaveLength(0);
      const assign = body!.statements[0] as { value: { type: string } };
      expect(assign.value.type, src).toBe('index');
    }
  });

  it('反例：步长切片 l[::2] 定向报错给两条正路（reversed 反转/推导式隔位取——不再是裸"] 未闭合"）', () => {
    const { errors } = parse(['x = l[::2]']);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('步长切片');
    expect(errors[0].message).toContain('reversed');
    expect(errors[0].message).toContain('推导式');
  });

  it('正例：切片与字典字面量同 body 无歧义（冒号双用途上下文分立）', () => {
    expect(parse(['d = {"k": items[1:]}']).errors).toHaveLength(0);
  });

  it('正例：serializeExpr 往返稳定（四形态+负数/表达式端点原文重建）', () => {
    for (const src of ['x = l[1:3]', 'x = l[:2]', 'x = l[2:]', 'x = l[:]', 'x = l[-2:]', 'x = l[n - 1:len(l)]']) {
      const { body, errors } = parse([src]);
      expect(errors, src).toHaveLength(0);
      const rendered = serializeActBody(body!);
      expect(rendered.trim(), src).toBe(src);
    }
  });
});

describe('subprocess.run parser 特例', () => {
  function parse(src: string) {
    const errors: ParseError[] = [];
    const b = parseActBody(src.split('\n'), 1, errors);
    return { b, errors };
  }

  it('正例：subprocess.run 字面收窄放行——callee 归一为 "subprocess.run"', () => {
    const { b, errors } = parse('r = subprocess.run(["git", "diff"])');
    expect(errors).toHaveLength(0);
    const stmt = b!.statements[0] as { value: { type: string; callee: string } };
    expect(stmt.value.type).toBe('call');
    expect(stmt.value.callee).toBe('subprocess.run');
  });

  it('正例：kwargs 双形态——input=x 与 input: x 同一 AST（serializer 恒输出既有冒号形态往返稳定）', () => {
    const a = parse('r = subprocess.run(["cat"], input=prev)');
    const bb = parse('r = subprocess.run(["cat"], input: prev)');
    expect(a.errors).toHaveLength(0);
    expect(bb.errors).toHaveLength(0);
    expect(JSON.stringify(a.b)).toBe(JSON.stringify(bb.b));
  });

  it('反例：其余 field 调用照旧定向报错——os.listdir 不因特例放行而松动', () => {
    const { errors } = parse('x = os.listdir(dir)');
    expect(errors.some(e => e.message.includes('无模块/方法调用'))).toBe(true);
  });

  it('反例：subprocess.call/Popen 不放行——特例只认 run 一个字面（Popen 是 Python 另一套 API,本环境只有 run）', () => {
    const { errors } = parse('p = subprocess.Popen(["git", "diff"])');
    expect(errors.some(e => e.message.includes('无模块/方法调用'))).toBe(true);
  });

  it('正例：== 与 kwargs 的 = 不混——比较表达式照旧解析', () => {
    const { b, errors } = parse('ok = get(m, "k") == 3');
    expect(errors).toHaveLength(0);
    expect(b).not.toBeNull();
  });
});


// hopissues/0079——禁循环早拦在 tokenizer 之前对原始行直搜 LOOP_KEYWORDS,字符串字面量里的
// 英文 while/for 被误拦（实撞:subprocess 参数含错误文案 'Profile changed while being read'
// 被拒,被迫无意义改写业务文案）。修=先掩引号段再搜。// @v: anc-step-act-body-comprehension
describe('禁循环早拦对字符串字面量豁免(0079)', () => {
  const parseOne = (src: string) => { const e: ParseError[] = []; parseActBody([src], 1, e); return e; };
  it('正例：字符串里的 while 放行（卡红例原文）', () => {
    expect(parseOne('msg = "Profile changed while being read"')).toEqual([]);
  });
  it('正例：字符串里的 for 放行（含单引号与转义引号形态——转义例用关键词带空格夹在转义引号间的形态:review 面三变异实证旧输入 for 紧贴引号时删转义分支两版同判,假辨别力）', () => {
    expect(parseOne(`msg = 'waiting for input'`)).toEqual([]);
    expect(parseOne('msg = "say \\" while \\" now"')).toEqual([]);
  });
  it('反例：语句位 while 照拦', () => {
    expect(parseOne('while x > 0:').some(e => e.message.includes('禁止循环语句'))).toBe(true);
  });
  it('反例：语句位 for 照拦,列表推导照放（既有语义零回归）', () => {
    expect(parseOne('for i in xs:').some(e => e.message.includes('禁止循环语句'))).toBe(true);
    expect(parseOne('ys = [i for i in xs]')).toEqual([]);
  });
  it('反例：字符串含 while 且真有推导外语句级 for 混排 → 照拦（掩串不放跑真循环——for 早于 [ 不是推导）', () => {
    expect(parseOne('zs = for i in "wait while ok"').some(e => e.message.includes('禁止循环语句'))).toBe(true);
  });
});
