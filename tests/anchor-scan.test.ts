// @module: anchor-audit-scripts ^anc-meta-traceability
// anchor-audit 扫描器（scripts/audit/scan.py）的行为回归测试。
// 它是审计基础设施——判据错了会让全库锚点审计失真（假报缺失 / 漏报断链），
// 故其核心判据必须有测试锁住，不能只靠人工跑一次看输出对不对。
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN = join(HERE, '..', 'scripts', 'audit', 'scan.py');

/**
 * 找一个装了 pyyaml 的 python 解释器。
 * ⚠️ 不能只试 `python3`——shell 里的 `python3` 可能是 alias（如 `uv run python`，解析到
 * ~/.venv 带 pyyaml），而 node 子进程没有 shell alias，拿到的是 homebrew python（无 pyyaml）。
 * 早期版本因此在真实环境里静默跳过全部用例（每例 0ms 假绿），比没有测试更坏。
 * 故：逐个候选实测 `import yaml`，全不可用则让测试**显式失败**，绝不静默跳过。
 */
function findPython(): string | null {
  const candidates = [
    process.env.HOPJIT_TEST_PYTHON,           // 显式指定优先
    join(process.env.HOME ?? '', '.venv', 'bin', 'python3'),  // uv/venv 常见位置
    'python3',
    'python',
  ].filter((c): c is string => Boolean(c));
  for (const py of candidates) {
    try {
      execFileSync(py, ['-c', 'import yaml'], { stdio: 'ignore', timeout: 10000 });
      return py;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/** 造一个最小工程（design/ src/ tests/ + TRACEABILITY.md），跑 scan.py，返回 traceability_cards.yaml 文本 */
function runScan(python: string, traceability: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'anchor-scan-'));
  for (const dir of ['design', 'src', 'tests']) mkdirSync(join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  writeFileSync(join(root, 'TRACEABILITY.md'), traceability);
  try {
    // stdio pipe：吞掉 scan.py 对可选目录（docs/concepts 等）的"不存在，跳过"stderr 警告——
    // 最小工程本就没有这些目录，警告是扫描器正确行为，但直通测试输出会吓到装包跑测试的人（2026-08-06 用户反馈）
    execFileSync(python, [SCAN, root], { encoding: 'utf-8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    // scan.py 有发现时退出码为 1，属正常；产物仍已落盘
  }
  const out = join(root, '.anchor-audit', 'traceability_cards.yaml');
  return existsSync(out) ? readFileSync(out, 'utf-8') : '';
}

describe('anchor-audit scan.py 判据回归', () => {
  let python: string | null = null;
  beforeAll(() => {
    python = findPython();
  });

  it('测试前提：能找到装了 pyyaml 的 python（缺失则显式失败，不静默跳过）', () => {
    expect(python, [
      '未找到装了 pyyaml 的 python 解释器 —— scan.py 的判据测试无法执行。',
      '装法：uv pip install pyyaml；或用 HOPJIT_TEST_PYTHON=<路径> 指定解释器。',
      '（本用例存在的意义：让缺依赖变成红灯，而非让下面 4 个用例静默跳过冒充通过）',
    ].join('\n')).not.toBeNull();
  });

  // @v: anc-meta-card-ref-owner
  it('引用行归属该行声明的锚点，不误用卡片 id（嵌套锚点不假报缺失）', () => {
    // 卡片 anc-step-demo 下嵌套列出 anc-rule-demo 的落点——这是合法写法，
    // 校验须按行归属：validator.ts 里只有 anc-rule-demo，不该因缺 anc-step-demo 报错。
    const yaml = runScan(python!,
      [
        '### anc-step-demo ✅',
        '',
        '演示步骤类型',
        '',
        '- [[概念#^anc-step-demo]] ← 权威源',
        '  - ast-types.ts `DemoStep` — @a: anc-step-demo',
        '  - [[spec-parser#^anc-rule-demo]] — 嵌套的别的锚点',
        '    - validator.ts P-demo check — @a: anc-rule-demo',
        '',
      ].join('\n'),
      {
        'src/ast-types.ts': 'export interface DemoStep {} // @a: anc-step-demo\n',
        'src/validator.ts': '// @a: anc-rule-demo\nconst check = 1;\n',
      },
    );
    expect(yaml).not.toBe('');
    // 关键断言：不得出现任何无效引用（旧实现会报 validator.ts 缺 anc-step-demo）
    expect(yaml).toMatch(/invalid_refs:\s*\[\]/);
    // owner 字段须落盘，且 validator.ts 归属 anc-rule-demo
    expect(yaml).toContain('owner: anc-rule-demo');
  });

  // @v: anc-meta-card-ref-owner
  it('真缺锚点仍被抓出（防止归属逻辑把断链一起放过）', () => {
    // ast-types.ts 里没有 anc-step-demo 标注 → 必须报无效引用
    const yaml = runScan(python!,
      [
        '### anc-step-demo ✅',
        '',
        '演示步骤类型',
        '',
        '- ast-types.ts `DemoStep` — @a: anc-step-demo',
        '',
      ].join('\n'),
      { 'src/ast-types.ts': 'export interface DemoStep {}\n' },
    );
    expect(yaml).toContain('invalid_refs:');
    expect(yaml).toMatch(/无任何 @a: 标注|无归属锚点 anc-step-demo/);
  });

  // @v: anc-meta-card-ref-owner
  it('死引用（文件不存在）被抓出', () => {
    const yaml = runScan(python!,
      ['### anc-step-demo ✅', '', '演示', '', '- gone.ts — @a: anc-step-demo', ''].join('\n'),
      {},
    );
    expect(yaml).toContain('死引用');
  });

  // @v: anc-meta-card-ref-owner
  it('引用不比对行号：带 :123 的旧式引用只要锚点在该文件即有效', () => {
    // 行号故意写错（:999），但 ast-types.ts 内确有该锚点 → 应视为有效
    const yaml = runScan(python!,
      ['### anc-step-demo ✅', '', '演示', '', '- ast-types.ts:999 — @a: anc-step-demo', ''].join('\n'),
      { 'src/ast-types.ts': '// @a: anc-step-demo\nexport interface DemoStep {}\n' },
    );
    expect(yaml).toMatch(/invalid_refs:\s*\[\]/);
  });
});

// @v: anc-driver-live-e2e-assertions —— aux-test-dirs @v 扫描面扩容（G13①,5a 断言在链）
describe('scan.py aux-test-dirs（scripts/ 的 @v 扫描面）', () => {
  let python: string | null = null;
  beforeAll(() => { python = findPython(); });

  function runScanRaw(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'anchor-scan-aux-'));
    for (const dir of ['design', 'src', 'tests', 'scripts']) mkdirSync(join(root, dir), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    writeFileSync(join(root, 'TRACEABILITY.md'), '# T\n');
    try {
      execFileSync(python!, [SCAN, root], { encoding: 'utf-8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { /* 有发现退出码 1 属正常 */ }
    const out = join(root, '.anchor-audit', 'test_anchors.yaml');
    return existsSync(out) ? readFileSync(out, 'utf-8') : '';
  }

  it('正例：scripts/ 里 .mjs 的 @v: 进 test_anchors（真机断言入收链通道）', () => {
    if (!python) return;
    const yaml = runScanRaw({
      'scripts/live-lib.mjs': '// @v' + ': anc-probe-live-assert —— 真机断言\n',   // 字面量拆接防本文件被扫出假锚点
      'tests/a.test.ts': '// @v' + ': anc-probe-vitest\n',
    });
    expect(yaml).toContain('anc-probe-live-assert');
    expect(yaml).toContain('scripts/live-lib.mjs');
    expect(yaml).toContain('anc-probe-vitest');   // 原 tests/ 面不受影响
  });

  it('反例：scripts/ 里无 @v 标注的文件不进 test_anchors（扩面不滥收）', () => {
    if (!python) return;
    const yaml = runScanRaw({
      'scripts/plain.mjs': '// 无锚点的普通脚本\nconst x = 1;\n',
      'tests/a.test.ts': '// @v' + ': anc-probe-vitest\n',
    });
    expect(yaml).not.toContain('plain.mjs');
  });
});
