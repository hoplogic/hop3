// @module: anchor-audit-scripts ^anc-meta-traceability
// audit 工具脚本资产安全三钉,第九轮 review 变异实锤后补（2026-09-01 anchor-audit standalone
// 化五批工程链 review,面三变异核证实锤:五脚本零测试,把资产保护分支整个删掉 794 个测试全绿）。
// 三钉锁最重的三个资产安全面（守卫哲学同 anc-meta-guard-trust:依赖缺失显式失败,不静默跳过）：
//   钉1 prep_env.py fresh 清理时台账 semantic_audit_summary.yaml 恒不删（module_ledger 增量账的家）
//   钉2 write_artifact.py summary 的 module_ledger 增量合并（范围外旧模块条目原样保留）
//   钉3 write_batch.py 写前 parse 把关（坏 YAML rc=2 带行号且不落盘;围栏壳属可修复噪声剥后写盘）
// 黑盒直驱:execFileSync 起 `uv run --with pyyaml python3 <脚本>`——与 spec body 的运行形态
// 完全同構（spec 5.2.1.2/6.2/步1 就是这么起脚本的）,测的即生产形态。
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT = join(HERE, '..', 'scripts', 'audit');

/** uv 在场检测——脚本经 `uv run --with pyyaml python3` 起（与 spec body 同形态）。
 *  无 uv 的环境 skip 带原因（uv 是 spec 声明的运行前提,缺它属环境配置缺失非脚本缺陷,
 *  与 anchor-scan.test 的 findPython 显式失败策略不同:那边测的是 scan.py 判据本体,
 *  这边测的是三个 spec 步骤的生产调用形态,形态里 uv 就是链的一环）。 */
function hasUv(): boolean {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

type RunResult = { status: number; stdout: string; stderr: string };

/** 跑一个 audit 脚本,返回退出码与两路输出（不抛——退出码是断言对象） */
function runScript(script: string, args: string[], stdin?: string): RunResult {
  try {
    const stdout = execFileSync(
      'uv', ['run', '--with', 'pyyaml', 'python3', join(AUDIT, script), ...args],
      { encoding: 'utf-8', timeout: 60000, input: stdin ?? undefined, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: err.status ?? -1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

const uvOk = hasUv();
const d = uvOk ? describe : describe.skip; // 无 uv 的环境 skip（原因见 hasUv 注释）

d('audit 工具脚本资产安全三钉', () => {
  beforeAll(() => {
    if (!uvOk) {
      // describe.skip 已挡,这里只是防御性双保险
      throw new Error('uv 不在 PATH——audit 脚本经 uv run --with pyyaml 起,缺 uv 无法测试');
    }
  });

  // @v: anc-meta-guard-trust —— 钉1:prep_env fresh 清理台账恒不删
  it('prep_env fresh 清掉杂文件但 semantic_audit_summary.yaml 恒不删（增量账不许被清）', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-prep-'));
    const aud = join(root, '.anchor-audit');
    mkdirSync(aud, { recursive: true });
    writeFileSync(join(aud, 'semantic_audit_summary.yaml'), 'module_ledger: {old-mod: {audited_commit: abc}}\n');
    writeFileSync(join(aud, 'batches.json'), '{"batches": []}');
    writeFileSync(join(aud, 'batch_foo_results.yaml'), 'module: foo\nresults: []\n');
    const r = runScript('prep_env.py', [root, '--audit-mode', 'fresh']);
    expect(r.status, `prep_env rc 应为 0,stderr: ${r.stderr}`).toBe(0);
    // 杂文件被清（fresh 清全部中间产物）
    expect(existsSync(join(aud, 'batches.json'))).toBe(false);
    expect(existsSync(join(aud, 'batch_foo_results.yaml'))).toBe(false);
    // 台账恒不删——删了它 module_ledger 增量合并读不到旧账,audit-scope.mjs 的增量推导全废
    expect(existsSync(join(aud, 'semantic_audit_summary.yaml'))).toBe(true);
    expect(readFileSync(join(aud, 'semantic_audit_summary.yaml'), 'utf-8')).toContain('old-mod');
  });

  // @v: anc-meta-guard-trust —— 钉2:write_artifact summary 的 module_ledger 增量合并
  it('write_artifact summary 保留范围外旧模块 ledger 条目并写入新模块条目', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-wa-'));
    const aud = join(root, '.anchor-audit');
    mkdirSync(aud, { recursive: true });
    // 先落一份含旧模块账的 summary（模拟前一轮按模块审计留下的账）
    writeFileSync(join(aud, 'semantic_audit_summary.yaml'), [
      'audited_at: 2026-08-01T00:00+0800',
      'module_ledger:',
      '  old-module:',
      '    audited_commit: deadbeef',
      '    audited_at: 2026-08-01T00:00+0800',
      '',
    ].join('\n'));
    // 新一轮 tally（只审了 new-module）
    const tallyPath = join(root, 'tally.json');
    writeFileSync(tallyPath, JSON.stringify({
      modules: { 'new-module': {} },
      total: {}, pass_rates: { s2d: 1, d2c: 1, c2t: 1 },
      err_items: [], warn_items: [], batch_count: 1,
    }));
    const r = runScript('write_artifact.py', [root, 'summary', tallyPath, 'new-module']);
    expect(r.status, `write_artifact rc 应为 0,stderr: ${r.stderr}`).toBe(0);
    const out = readFileSync(join(aud, 'semantic_audit_summary.yaml'), 'utf-8');
    // 旧模块条目原样保留（删掉合并逻辑=每次按模块跑都把别的模块的账洗掉,增量凭证全废）
    expect(out).toContain('old-module');
    expect(out).toContain('deadbeef');
    // 新模块条目也在
    expect(out).toContain('new-module');
    // scope 从 modules 推导（G4 修后签名:summary <tally_json> <modules...>,无死参 scope）
    expect(out).toContain('scope: new-module');
  });

  // @v: anc-meta-guard-trust —— 钉3:write_batch 写前 parse 把关（坏拒好收）
  it('write_batch 坏 YAML rc=2 带行号指路且目标文件不落盘', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-wb-'));
    const outPath = join(root, 'batch_demo_results.yaml');
    // flow 形态 note 裸值含方括号——第十三跑实撞的 YAML 炸弹原型
    const bad = [
      'module: demo',
      'results:',
      '  - anchor_id: anc-x',
      '    c2t: { verdict: "⚠️", note: engine.test.ts [on fail] 组 8 例炸语法 }',
      '',
    ].join('\n');
    const r = runScript('write_batch.py', [outPath], bad);
    expect(r.status, 'rc 应为 2（真坏打回当轮重产）').toBe(2);
    expect(r.stderr).toMatch(/第 \d+ 行/); // 报错带行号指路,LLM 拿着重产
    expect(existsSync(outPath), '坏 YAML 不许落盘——静默落盘=病灶离症状隔容器（6.1 读盘才炸）').toBe(false);
  });

  it('write_batch 围栏壳好 YAML rc=0 剥壳写盘且 stdout 带修复记录', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-wb2-'));
    const outPath = join(root, 'batch_demo_results.yaml');
    const fenced = [
      '```yaml',
      'module: demo',
      'results:',
      '  - anchor_id: anc-x',
      '    c2t: { verdict: "✅", note: "对齐" }',
      '```',
      '',
    ].join('\n');
    const r = runScript('write_batch.py', [outPath], fenced);
    expect(r.status, `rc 应为 0,stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('anchors=1');
    expect(r.stdout).toContain('修复'); // 修复了什么写 stdout 供 digest 记录
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf-8')).not.toContain('```'); // 落盘的是剥壳后正文
  });
});

// collect_coverage.py（test-coverage-audit spec 的机械扫描侧脚本,a6dc9504 新建时零测试）——
// 黑盒直驱形态与上组同構（uv run --with pyyaml python3,即 spec body 的生产调用形态）。
// 锁两个下游直接消费的接口面：--detect 的三键 JSON（spec body parse_json 按键名取值,
// 键改名即下游静默拿 undefined）与 --gaps 的 JSON 数组形态（直接赋 gap_files）。
d('collect_coverage 覆盖率脚本', () => {
  // --detect 对仓库根跑:本仓库就是 vitest 工程,detect 应稳定判出 vitest
  it('--detect 对仓库根:stdout JSON 恰含 coverage_configured/project_type/install_cmd 三键且 project_type=vitest', () => {
    const r = runScript('collect_coverage.py', [join(HERE, '..'), '--detect']);
    expect(r.status, `rc 应为 0,stderr: ${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout);
    // 恰含三键（多一键少一键都红）——这三个键名是 spec body parse_json 的取值面
    expect(Object.keys(out).sort()).toEqual(['coverage_configured', 'install_cmd', 'project_type']);
    expect(out.project_type).toBe('vitest');
  });

  // --gaps 的真实依赖链:读 {root}/.coverage-audit/ 下 coverage_summary.yaml 与
  // uncovered_details.yaml 两份 --analyze 产物——这里手工落最小盘面,跑真筛选逻辑
  it('--gaps --line-threshold 80 --branch-threshold 70:stdout 是 JSON 数组,低覆盖文件成批、达标文件不入', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-cc-gaps-'));
    const aud = join(root, '.coverage-audit');
    mkdirSync(aud, { recursive: true });
    writeFileSync(join(aud, 'coverage_summary.yaml'), [
      'total_files: 2',
      'overall_line_pct: 72.5',
      'overall_branch_pct: 75.0',
      'files:',
      '  - {file: low.ts, line_pct: 50.0, branch_pct: 60.0}',
      '  - {file: high.ts, line_pct: 95.0, branch_pct: 90.0}',
      '',
    ].join('\n'));
    writeFileSync(join(aud, 'uncovered_details.yaml'), [
      'files:',
      '  - file: low.ts',
      '    regions:',
      '      - {lines: "3-4", context: "3: foo\\n4: bar"}',
      '',
    ].join('\n'));
    const r = runScript('collect_coverage.py', [root, '--gaps', '--line-threshold', '80', '--branch-threshold', '70']);
    expect(r.status, `rc 应为 0,stderr: ${r.stderr}`).toBe(0);
    const arr = JSON.parse(r.stdout);
    expect(Array.isArray(arr), '--gaps stdout 必须是 JSON 数组（spec body 直接赋 gap_files）').toBe(true);
    expect(arr.length).toBe(1);            // 只有 low.ts 低于阈值
    expect(arr[0]).toContain('low.ts');    // 批文本自包含文件路径
    expect(arr[0]).not.toContain('high.ts');
    expect(existsSync(join(aud, 'gaps.yaml'))).toBe(true); // 产物同步落盘
  });

  // 变异防线:三键名逐个精确断言（任一键改名——如 coverage_configured→covconf——即红）
  it('变异防线:--detect 输出三键名精确匹配,改名即红', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-cc-det-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }));
    const r = runScript('collect_coverage.py', [root, '--detect']);
    expect(r.status, `rc 应为 0,stderr: ${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout);
    for (const k of ['coverage_configured', 'project_type', 'install_cmd']) {
      expect(Object.prototype.hasOwnProperty.call(out, k), `键 ${k} 必须以此名精确在场`).toBe(true);
    }
    expect(Object.keys(out).length).toBe(3);
  });
});
