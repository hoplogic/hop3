// @module: act-body ^anc-struct-act-body
import { describe, it, expect } from 'vitest';
import { parseSpec } from '../src/parser.js';
import { parseActBody, serializeActBody } from '../src/act-body-parser.js';
import { PromptAssembler } from '../src/prompt.js';
import { ExecutionEngine } from '../src/engine.js';
import type { ActStep } from '../src/ast-types.js';
import type { ParseError } from '../src/errors.js';
import type { HostConfig } from '../src/provider-types.js';

// @v: anc-exec-act-body-interp, anc-ast-act-body
// 复用模式 body 交付 + serializeActBody round-trip

const HOST: HostConfig = {
  workspace_dir: '/tmp/x', sandbox: { mode: 'workspace' } as any, api_key: 'k',
} as any;

function bodyOf(src: string) {
  const errors: ParseError[] = [];
  const b = parseActBody(src.split('\n'), 1, errors);
  if (!b) throw new Error('parse failed: ' + JSON.stringify(errors));
  return b;
}

describe('serializeActBody round-trip（parse→serialize→parse 语义等价）', () => {
  const cases = [
    'out = upper(raw)',
    'a = 1\nb = a + 2\nout = b',
    'out = fetch(url: u, timeout: 30)',
    'if x > 3:\n    out = "hi"\nelse:\n    out = "lo"',
    'if x > 9:\n    out = "h"\nelif x > 3:\n    out = "m"\nelse:\n    out = "l"',
    'out = cfg.level',
    'out = a and b or not c',
  ];
  for (const src of cases) {
    it(`round-trip: ${src.split('\n')[0]}...`, () => {
      const ast1 = bodyOf(src);
      const text = serializeActBody(ast1);
      const ast2 = bodyOf(text);
      // 语义等价：再序列化一次应与第一次序列化结果一致（稳定点）
      expect(serializeActBody(ast2)).toBe(text);
      // 语句数一致
      expect(ast2.statements.length).toBe(ast1.statements.length);
    });
  }

  it('elif 正确还原为 elif（不退化成嵌套 if-else 文本歧义）', () => {
    const src = 'if x > 9:\n    out = "h"\nelif x > 3:\n    out = "m"\nelse:\n    out = "l"';
    const text = serializeActBody(bodyOf(src));
    expect(text).toContain('elif x > 3:');
    expect(text).toContain('else:');
    // 重新解析仍是一个顶层 if（elif/else 嵌在内），非两个顶层语句
    expect(bodyOf(text).statements.length).toBe(1);
  });
});

describe('复用模式 body 交付（prompt buildInstruction）', () => {
  function instructionFor(spec: string): string {
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    const assembler = new PromptAssembler(engine);
    const node = engine.getSpec()!.steps![0];
    // buildInstruction 是 private，经 assembleContext 的 instruction 字段间接验证
    const ctx = (assembler as any).buildInstruction(node) as string;
    return ctx;
  }

  it('有 body 的 act：instruction 附加 hop_python 围栏 body', () => {
    const spec = `# T
Id: t
## Goal
g
## Inputs
- raw: text  # in
## Outputs
- result: text  # out
## Steps
1. [act] 处理
  - ← raw
  + → result: text  # 结果
  > 说明
  > \`\`\`hop_python
  > result = upper(raw)
  > \`\`\`
`;
    const instr = instructionFor(spec);
    expect(instr).toContain('[ACT BODY');
    expect(instr).toContain('```hop_python');
    expect(instr).toContain('result = upper(raw)');
    expect(instr).toContain('ToolProvider 清单');   // 提示 caller 按清单注册
  });

  it('无 body 的 act：instruction 不附 body 块', () => {
    const spec = `# T
Id: t
## Goal
g
## Steps
1. [act] 处理
  + → out: text  # o
  > 自然语言执行说明
`;
    const instr = instructionFor(spec);
    expect(instr).not.toContain('[ACT BODY');
    expect(instr).toContain('自然语言');
  });
});
