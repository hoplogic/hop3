// 识别器正反例——与引擎 parser 的一致性由本组样例对齐（同样例两边跑,语法参考仲裁）。
// @v: anc-viz-step-recognizer, anc-viz-obsidian-fold
import { test } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// esbuild 即时转译识别器为 ESM 供测试 import
execSync(`npx esbuild ${join(here, '../src/recognizer.ts')} --format=esm --outfile=${join(here, '.recognizer.mjs')}`, { cwd: join(here, '..') });
const { isHopSpec, recognizeSteps, foldRangeFor } = await import(join(here, '.recognizer.mjs'));

test('正例：7 级+ 标题风步骤识别（markdown 标题机制之上——插件存在的理由）', () => {
  const lines = [
    '# Spec: t', '## Steps',
    '### 1. [subtask] 顶层',
    '####### 5.3.1.1.1. [break]',                    // 7 个 #
    '######## 5.3.3.1.1.1. [reason] 八级深步骤',      // 8 个 #
  ];
  const steps = recognizeSteps(lines);
  assert.equal(steps.length, 3);
  assert.equal(steps[1].depth, 5);
  assert.equal(steps[2].depth, 6);
  assert.equal(steps[2].stepType, 'reason');
});

test('正例：缩进风与中文类型词同识别（层级=编号段数,与表面形态解耦）', () => {
  const lines = ['  2.1. [推理] 中文步骤', '    2.1.1. [act] 深一层'];
  const steps = recognizeSteps(lines);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].stepType, '推理');
  assert.equal(steps[0].depth, 2);
  assert.equal(steps[1].depth, 3);
});

test('正例：落点标记提取（四类,供高亮与大纲色点）', () => {
  const steps = recognizeSteps(['1. [loop] 遍历 → traverse', '2. [commit] 发布 → commit → verify']);
  assert.deepEqual(steps[0].marks, ['traverse']);
  assert.deepEqual(steps[1].marks, ['commit', 'verify']);
});

test('正例：case 直连括号与 call 映射形态识别（一致性探针实撞回归——case( 无空格首版漏识别）', () => {
  const steps = recognizeSteps([
    '###### 5.3.1.1. [case(next_idx >= pending_total)] 触底',
    '2. [case(else)] 兜底',
    '3. [call sub-spec(doc: parent_doc)] 调子流程',
  ]);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].stepType, 'case');
  assert.equal(steps[1].stepType, 'case');
  assert.equal(steps[2].stepType, 'call');
});

test('一致性锚测：与引擎 parser 同集识别（真实最深 spec——语法参考仲裁的物证）', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const enginePath = join(here, '../../../dist/parser.js');
  if (!existsSync(enginePath)) return;   // 独立分发场景无引擎——跳过（库内开发恒在场）
  const { parseSpec } = await import(enginePath);
  const text = readFileSync(join(here, '../../../skills/hopbuild/spec.md'), 'utf-8');
  const plugin = new Set(recognizeSteps(text.split('\n')).map(s => s.stepId));
  const engine = [];
  const walk = (s) => { engine.push(s.step_id); (s.children ?? s.cases ?? []).forEach(walk); };
  parseSpec(text).ast.steps.forEach(walk);
  assert.deepEqual([...plugin].sort(), engine.sort());
});

test('反例：围栏内步骤形状文本不识别（示例不是步骤）', () => {
  const lines = ['```markdown', '1. [reason] 这是示例', '```', '2. [act] 这是真步骤'];
  const steps = recognizeSteps(lines);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].stepId, '2');
});

test('反例：普通有序列表/散文数字不误识别', () => {
  const steps = recognizeSteps(['1. 普通列表项没有方括号', '第 3 次尝试的散文', '2019. 年份开头']);
  assert.equal(steps.length, 0);
});

test('折叠域：域=行尾→下一个非后代步骤行前（编号前缀判后代）', () => {
  const lines = [
    '1. [subtask] 甲',       // 0
    '  - ← x',               // 1
    '  1.1. [reason] 甲一',  // 2
    '    > 说明',            // 3
    '2. [act] 乙',           // 4
  ];
  const steps = recognizeSteps(lines);
  const r = foldRangeFor(steps[0], steps, lines.length);
  assert.deepEqual(r, { from: 0, to: 3 });   // 1 的域到乙之前
  const r2 = foldRangeFor(steps[1], steps, lines.length);
  assert.deepEqual(r2, { from: 2, to: 3 });  // 1.1 的域=自己的说明行
});

test('折叠域反例：叶子无后续行→null（空域不折）', () => {
  const lines = ['1. [act] 单行叶子'];
  const steps = recognizeSteps(lines);
  assert.equal(foldRangeFor(steps[0], steps, 1), null);
});

// @v: anc-viz-obsidian-plugin — 激活判据条款（# Spec: 头在场才启用,普通 markdown 零打扰）
test('isHopSpec 激活判据：# Spec: 头在场才启用（普通 markdown 零打扰）', () => {
  assert.equal(isHopSpec('# Spec: x\n## Steps\n'), true);
  assert.equal(isHopSpec('# 普通笔记\n1. [reason] 形状像步骤'), false);
});
