// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: anchor-audit-scripts ^anc-meta-traceability
// 守卫脚本判据回归（chain-enforcement §5 硬要求 2：守卫的判据逻辑自身要有测试，防重构静默退化）。
// 模式：HOPJIT_CHECK_ROOT 注入临时 fixture 仓库 → 造合规/违规两态 → 断言 exit code 与报文。
// 此前三守卫只有准入时的一次性负向验证（TRACEABILITY 卡记录）——一次性证明 ≠ 常驻保护。
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(import.meta.dirname, '..');

function runGuard(script: string, fixtureRoot: string, args: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync('node', [join(REPO, 'scripts', script), ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOPJIT_CHECK_ROOT: fixtureRoot },
    });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// ── check-scripts-syntax：scripts/ 全 .mjs 语法门 ──
// @v: anc-meta-guard-trust
describe('check-scripts-syntax 判据回归', () => {
  function fixture(mjs: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'gss-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    for (const [name, content] of Object.entries(mjs)) {
      writeFileSync(join(root, 'scripts', name), content);
    }
    return root;
  }

  it('正例：全部 mjs 语法合法 → exit 0 报文件数', () => {
    const root = fixture({ 'a.mjs': 'export const x = 1;\n', 'b.mjs': 'console.log(1);\n' });
    const r = runGuard('check-scripts-syntax.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('(2 mjs + 0 sh)');
  });

  it('反例：语法坏文件（重复声明——实撞形态）→ exit 1 报文件名与错误', () => {
    const root = fixture({ 'ok.mjs': 'export const x = 1;\n', 'bad.mjs': 'const log = 1;\nconst log = 2;\n' });
    const r = runGuard('check-scripts-syntax.mjs', root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('bad.mjs');
    expect(r.out).toContain('already been declared');
  });

  it('反例：扫描面空转（无任何 mjs）→ exit 2 显式失败不假绿', () => {
    const root = mkdtempSync(join(tmpdir(), 'gss-empty-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    const r = runGuard('check-scripts-syntax.mjs', root);
    expect(r.code).toBe(2);
    expect(r.out).toContain('静默空转');
  });

  it('反例：.sh 语法坏（未闭合 if——批量脚本改写高频形态）→ exit 1（2026-08-14 三档 review 补面）', () => {
    const root = fixture({ 'ok.mjs': 'export const x = 1;\n' });
    writeFileSync(join(root, 'scripts', 'bad.sh'), '#!/bin/bash\nif [ 1 = 1 ]; then\necho hi\n');
    const r = runGuard('check-scripts-syntax.mjs', root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('bad.sh');
  });

  it('正例：.sh 语法合法 → 计数入报文', () => {
    const root = fixture({ 'ok.mjs': 'export const x = 1;\n' });
    writeFileSync(join(root, 'scripts', 'good.sh'), '#!/bin/bash\necho ok\n');
    const r = runGuard('check-scripts-syntax.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('+ 1 sh)');
  });
});

// ── audit-scope：语义审计增量范围推导（模块台账 × git diff） ──
// @v: anc-meta-guard-trust
describe('audit-scope 增量范围推导', () => {
  function gitFixture(opts: { ledgerCommit?: 'HEAD' | 'BASE' | 'none'; changeAfterBase?: boolean }): string {
    const root = mkdtempSync(join(tmpdir(), 'ascope-'));
    const run = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    run(['init', '-q']);
    run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't']);
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.anchor-audit'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), '// @module: mod-a\nexport const a = 1;\n');
    run(['add', '-A']); run(['commit', '-qm', 'base']);
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    if (opts.changeAfterBase) {
      writeFileSync(join(root, 'src', 'a.ts'), '// @module: mod-a\nexport const a = 2;\n');
      run(['add', '-A']); run(['commit', '-qm', 'change']);
    }
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    if (opts.ledgerCommit !== 'none') {
      const c = opts.ledgerCommit === 'HEAD' ? head : base;
      writeFileSync(join(root, '.anchor-audit', 'semantic_audit_summary.yaml'),
        `audited_at: "2026-08-11T00:00+0800"\nscope: full\nmodule_ledger:\n  mod-a:\n    audited_commit: "${c}"\n    audited_at: "2026-08-11T00:00+0800"\n`);
    }
    return root;
  }

  it('正例：台账=HEAD 且无后续改动 → 范围为空 exit 0', () => {
    const root = gitFixture({ ledgerCommit: 'HEAD' });
    const r = runGuard('audit-scope.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('增量范围为空');
  });

  it('正例：台账=BASE 且此后 src 有改动 → 模块入范围并给出按模块跑命令', () => {
    const root = gitFixture({ ledgerCommit: 'BASE', changeAfterBase: true });
    const r = runGuard('audit-scope.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('mod-a');
    expect(r.out).toContain('"modules": "mod-a"');
  });

  it('反例：无台账记录 → 模块保守入范围（从未审过不豁免）', () => {
    const root = gitFixture({ ledgerCommit: 'none' });
    const r = runGuard('audit-scope.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('台账无记录');
  });

  it('反例：src 无任何 @module 标注 → exit 2 显式失败不静默空转', () => {
    const root = mkdtempSync(join(tmpdir(), 'ascope-empty-'));
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'pipe' });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const r = runGuard('audit-scope.mjs', root);
    expect(r.code).toBe(2);
    expect(r.out).toContain('扫描面异常');
  });
});

// ── G10 check-module-arch-audit：src @module: 集合 ⊆ 三视图 ──
// @v: anc-meta-module-arch-audit
describe('check-module-arch-audit 判据回归', () => {
  function fixture(views: { doctree: string; arch: string; mp: string }): string {
    const root = mkdtempSync(join(tmpdir(), 'guard-mav-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'docs', 'design'), { recursive: true });
    writeFileSync(join(root, 'src', 'alpha.ts'), '// @module: alpha ^anc-struct-alpha\n');
    writeFileSync(join(root, 'src', 'beta.ts'), '// @module: beta ^anc-struct-beta\n');
    writeFileSync(join(root, 'Doctree.md'), views.doctree);
    writeFileSync(join(root, 'ARCHITECTURE.md'), views.arch);
    writeFileSync(join(root, 'docs', 'design', 'module-principles.md'), views.mp);
    return root;
  }

  it('三视图全登记 → exit 0', () => {
    const root = fixture({ doctree: 'alpha beta', arch: 'alpha beta', mp: 'alpha beta' });
    const r = runGuard('check-module-arch-audit.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('2 模块');
  });

  it('单视图缺名 → exit 1 且精确报视图与模块名', () => {
    const root = fixture({ doctree: 'alpha beta', arch: 'alpha', mp: 'alpha beta' });
    const r = runGuard('check-module-arch-audit.mjs', root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ARCHITECTURE.md');
    expect(r.out).toContain("'beta'");
    expect(r.out).not.toContain("'alpha'");   // 已登记的不误报
  });

  it('判据源为空（src 无 @module:）→ exit 2 显式失败不静默跳过', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-mav-empty-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'docs', 'design'), { recursive: true });
    writeFileSync(join(root, 'src', 'plain.ts'), '// no module marker\n');
    writeFileSync(join(root, 'Doctree.md'), 'x');
    writeFileSync(join(root, 'ARCHITECTURE.md'), 'x');
    writeFileSync(join(root, 'docs', 'design', 'module-principles.md'), 'x');
    const r = runGuard('check-module-arch-audit.mjs', root);
    expect(r.code).toBe(2);
    expect(r.out).toContain('判据源异常');
  });
});

// ── G8 check-layer-imports：低层不得 import 高层 ──
// @v: anc-meta-module-layering
describe('check-layer-imports 判据回归', () => {
  // LAYER 表按生产名单：engine=core(1), cli=adapter(2), errors=shared(0)
  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'guard-layer-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, 'src', name), content);
    }
    return root;
  }

  // fixture 的 import 语句用拼接生成——scan.py 的 IMPORT_RE（认 from '...' 模式）会把
  // 本文件里的字符串字面量误认成真实依赖（module_deps_mismatch 假警报，实撞 2026-08-07）
  const imp = (names: string, path: string) => 'import ' + names + ' from ' + `'${path}'` + ';\n';

  it('方向合规（adapter→core→shared）→ exit 0', () => {
    const root = fixture({
      'errors.ts': 'export const E = 1;\n',
      'engine.ts': imp('{ E }', './errors.js'),
      'cli.ts': imp('{ E }', './engine.js'),
      // 生产 LAYER 表内其余文件缺席即可——脚本只扫存在的文件
    });
    const r = runGuard('check-layer-imports.mjs', root);
    expect(r.code).toBe(0);
  });

  it('越层（core import adapter）→ exit 1 精确报', () => {
    const root = fixture({
      'engine.ts': imp('{ x }', './cli.js'),   // 核心引适配=越层（且不在豁免表）
      'cli.ts': 'export const x = 1;\n',
    });
    const r = runGuard('check-layer-imports.mjs', root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('engine');
    expect(r.out).toContain('cli');
  });

  it('LAYER 表外新文件 → 显式红（禁静默跳过）', () => {
    const root = fixture({ 'mystery-module.ts': 'export const m = 1;\n' });
    const r = runGuard('check-layer-imports.mjs', root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('不在 LAYER 表');
  });
});

// ── G9 check-version-lock：接口区 diff 而版本行无 diff 即红 ──
// @v: anc-meta-module-versioning
describe('check-version-lock 判据回归', () => {
  // 判据吃 git diff——fixture 需真 git 仓库两个 commit
  function gitFixture(v1: string, v2: string): string {
    const root = mkdtempSync(join(tmpdir(), 'guard-vlock-'));
    mkdirSync(join(root, 'docs', 'design'), { recursive: true });
    const doc = join(root, 'docs', 'design', 'mod.md');
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    git('init', '-q');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(doc, v1);
    git('add', '-A'); git('commit', '-qm', 'v1');
    writeFileSync(doc, v2);
    git('add', '-A'); git('commit', '-qm', 'v2');
    return root;
  }

  const BASE = '> **模块版本**：mod `v0.1.0`\n\n| 符号 | 种类 |\n|---|---|\n| `foo` | 函数 |\n';

  it('接口区动了、版本行没动 → exit 1 报文档名', () => {
    const root = gitFixture(BASE, BASE.replace('| `foo` | 函数 |', '| `foo` | 函数 |\n| `bar` | 函数 |'));
    const r = runGuard('check-version-lock.mjs', root, ['HEAD~1..HEAD']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('mod.md');
  });

  it('接口区动了、版本行同动 → exit 0', () => {
    const root = gitFixture(
      BASE,
      BASE.replace('`v0.1.0`', '`v0.2.0`').replace('| `foo` | 函数 |', '| `foo` | 函数 |\n| `bar` | 函数 |'),
    );
    const r = runGuard('check-version-lock.mjs', root, ['HEAD~1..HEAD']);
    expect(r.code).toBe(0);
  });

  it('非接口区改动（普通正文）→ exit 0 不误报', () => {
    const root = gitFixture(BASE + '\n正文一段。\n', BASE + '\n正文改了一段。\n');
    const r = runGuard('check-version-lock.mjs', root, ['HEAD~1..HEAD']);
    expect(r.code).toBe(0);
  });
});

// ── check-driver-carriers：续接交接契约 token（^anc-exec-reuse-subagent-driver,2026-08-13 实撞销账） ──
// @v: anc-exec-reuse-subagent-driver, anc-driver-codex-static-lint
describe('check-driver-carriers 续接交接判据回归', () => {
  function driverFixture(mutate?: (path: string, content: string) => string): string {
    const root = mkdtempSync(join(tmpdir(), 'gdc-'));
    // 从真仓库整份复制 driver/（守卫扫描面），可选按文件变异
    const { cpSync, readFileSync: rf, writeFileSync: wf } = require('node:fs') as typeof import('node:fs');
    cpSync(join(REPO, 'driver'), join(root, 'driver'), { recursive: true });
    if (mutate) {
      for (const p of ['driver/hopspec-skill.md', 'driver/references/driver-subagent.md', 'driver/codex/SKILL.md']) {
        const abs = join(root, p);
        wf(abs, mutate(p, rf(abs, 'utf-8')));
      }
    }
    return root;
  }

  it('正例：现行 driver 束完整（<PENDING>/DRIVER_PROTOCOL_ERROR/current_response 三 token 在场）→ exit 0', () => {
    const r = runGuard('check-driver-carriers.mjs', driverFixture());
    expect(r.code).toBe(0);
  });

  it('反例：skill 丢 <PENDING>（续接交接不传在手响应——实撞形态）→ exit 1 报 token', () => {
    const r = runGuard('check-driver-carriers.mjs', driverFixture(
      (p, c) => p === 'driver/hopspec-skill.md' ? c.replaceAll('<PENDING>', '<X>') : c,
    ));
    expect(r.code).toBe(1);
    expect(r.out).toContain('continuation-handoff token: <PENDING>');
  });

  it('反例：subagent 模板丢缺件兜底 DRIVER_PROTOCOL_ERROR → exit 1', () => {
    const r = runGuard('check-driver-carriers.mjs', driverFixture(
      (p, c) => p === 'driver/references/driver-subagent.md' ? c.replaceAll('DRIVER_PROTOCOL_ERROR', 'X') : c,
    ));
    expect(r.code).toBe(1);
    expect(r.out).toContain('driver-subagent.md missing continuation-handoff token: DRIVER_PROTOCOL_ERROR');
  });
});

// ── check-driver-carriers：/hop 六动作 parity（^anc-exec-reuse-distill,2026-08-28 提纯批） ──
// @v: anc-exec-reuse-distill
describe('check-driver-carriers /hop distill 六动作 parity', () => {
  function driverFixture(mutate?: (path: string, content: string) => string): string {
    const root = mkdtempSync(join(tmpdir(), 'gdd-'));
    const { cpSync, readFileSync: rf, writeFileSync: wf } = require('node:fs') as typeof import('node:fs');
    cpSync(join(REPO, 'driver'), join(root, 'driver'), { recursive: true });
    if (mutate) {
      for (const p of ['driver/hop-skill.md', 'driver/codex/hop-skill.md']) {
        const abs = join(root, p);
        wf(abs, mutate(p, rf(abs, 'utf-8')));
      }
    }
    return root;
  }

  it('正例：两载体 distill token 组齐备 → exit 0', () => {
    const r = runGuard('check-driver-carriers.mjs', driverFixture());
    expect(r.code).toBe(0);
  });

  it('反例：CC 件丢查现成流程（消费半边蒸发——只存不用白提纯的形态;词随 f3bd989 说人话批改名,钉同步）→ exit 1 报 token 与载体', () => {
    const r = runGuard('check-driver-carriers.mjs', driverFixture(
      (p, c) => p === 'driver/hop-skill.md' ? c.replaceAll('查现成流程', '查流程') : c,
    ));
    expect(r.code).toBe(1);
    expect(r.out).toContain('driver/hop-skill.md missing /hop distill token: 查现成流程');
  });

  // @v: anc-exec-reuse-worktree-act —— act/commit 分界兑现通则句守卫（丢句=修复步回退直改共享区）
  it('反例：CC 件丢 worktree 通则句（act/commit 分界兑现蒸发——修复步回退直改共享区形态）→ exit 1', () => {
    const r = runGuard('check-driver-carriers.mjs', driverFixture(
      (p, c) => p === 'driver/hop-skill.md' ? c.replaceAll('改动阶段进 worktree', '改动阶段进隔离') : c,
    ));
    expect(r.code).toBe(1);
    expect(r.out).toContain('missing /hop distill token: 改动阶段进 worktree');
  });

  it('反例：Codex 件丢 hop_tasks/specs/（落盘约定漂移——两载体产物落不同目录即互不可见）→ exit 1', () => {
    const r = runGuard('check-driver-carriers.mjs', driverFixture(
      (p, c) => p === 'driver/codex/hop-skill.md' ? c.replaceAll('hop_tasks/specs/', 'hop_tasks/sp/') : c,
    ));
    expect(r.code).toBe(1);
    expect(r.out).toContain('driver/codex/hop-skill.md missing /hop distill token: hop_tasks/specs/');
  });
});


// ── release.sh 快照制静态断言（design [[release-engineering#^anc-release-snapshot]],2026-09-04）──
// 发版脚本不被 vitest 跑（publish 不可逆归人跑）,守卫形态=静态文本断言：钉住快照制的结构面——
// 冻结点唯一/作业对象在快照区/dry-run 分支在场,防将来改动漏改一处悄悄回到"验 HEAD 发 HEAD"的移动靶语义。
// @v: anc-release-snapshot
describe('release.sh 快照制静态断言', () => {
  const sh = readFileSync(join(REPO, 'scripts', 'release.sh'), 'utf-8');

  it('主区提交读取点+冻结行在场（CURR 单点读,SNAP 自 CURR 冻结——断点分诊与冻结共用同一读）', () => {
    expect(sh).toContain('CURR=$(git rev-parse HEAD)');
    expect(sh).toContain('SNAP=$CURR');
  });

  it('裸读 HEAD 仅 CURR 读取点一处（防将来改动漏改回 HEAD 移动靶语义——变异验证:删读取行本例与上例双红）', () => {
    const hits = sh.match(/rev-parse HEAD/g) ?? [];
    expect(hits.length).toBe(1);
  });

  it('断点分诊在场（未过升版本点且主区已推进→自动重冻结,2026-09-04 首发实撞"这个能智能点么"）', () => {
    expect(sh).toContain('断点分诊');
    expect(sh).toContain('BUMPED');
    // 分诊废弃动作三件齐:弃区/prune/删记录（缺一即残留半拉状态）
    const triage = sh.slice(sh.indexOf('断点分诊：'), sh.indexOf('if [ -f .release-snapshot ]; then\n  SNAP='));
    expect(triage).toContain('git worktree remove --force');
    expect(triage).toContain('rm -f .release-snapshot');
  });

  it('快照 worktree 建区行在场（--detach 于 SNAP）', () => {
    expect(sh).toContain('git worktree add --detach "$WT" "$SNAP"');
  });

  it('publish 在快照区上下文内（in_wt 前缀——防漏改跑回主区发主区内容）', () => {
    expect(sh).toContain('in_wt npm publish');
    // 全文不许出现不带 in_wt 前缀的 npm publish：
    const bare = sh.split('\n').filter(l => l.includes('npm publish') && !l.includes('in_wt') && !l.trimStart().startsWith('#'));
    expect(bare).toEqual([]);
  });

  it('升版本与全量检查同在快照区（in_wt npm version / in_wt npm run -s check）', () => {
    expect(sh).toContain('in_wt npm version');
    expect(sh).toContain('in_wt npm run -s check');
  });

  it('E2E 凭证闸对 SNAP 判而非 HEAD（旧变量名 HEADSHA 不得残留）', () => {
    expect(sh).toContain('"$EVCOMMIT" != "$SNAP"');
    expect(sh).not.toContain('HEADSHA');
  });

  it('breaking 闸基线 tag 按版本号排序取最大者,全文禁 describe --tags（快照制下版本提交在侧线,describe 沿祖先链越过全部快照制 tag 落到旧形态 tag——0.14.1 实撞:基线错落 v0.12.1,误拦三个已随 v0.13.0/v0.14.0 发过的提交）', () => {
    expect(sh).toContain("git tag -l 'v*' --sort=-v:refname | head -1");
    expect(sh).not.toContain('describe --tags');
  });

  it('dry-run 分支在场（演练模式:不 publish 不打 tag 不推送,尾部自动弃区）', () => {
    expect(sh).toContain('RELEASE_DRY_RUN');
    expect(sh).toContain('dry_cleanup');
  });

  it('收编三拍分立执行（cherry-pick/push/push tag 各自成行——|| 单行连写吞输出禁形）', () => {
    expect(sh).toContain('git cherry-pick "$VCOMMIT"');
    expect(sh).toContain('/usr/bin/git push origin "v$PKGV"');
  });
});

// ── check-text-integrity：文本文件禁 NUL 等控制字节（2026-08-13 实撞:字面 NUL 进 parser.ts,
// grep 判二进制全工具链失明,review 险把"代码在场"误判"缺失"）──
// @v: anc-meta-guard-text-integrity
describe('check-text-integrity 判据回归', () => {
  function tiFixture(files: Record<string, Buffer | string>): string {
    const root = mkdtempSync(join(tmpdir(), 'gti-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, 'src', name), content);
    }
    return root;
  }

  it('正例：干净文本 → exit 0 报文件数', () => {
    const r = runGuard('check-text-integrity.mjs', tiFixture({ 'a.ts': 'const x = 1;\n' }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 files');
  });

  it('反例：字面 NUL 字节（实撞形态）→ exit 1 报文件与偏移', () => {
    const r = runGuard('check-text-integrity.mjs', tiFixture({
      'ok.ts': 'const y = 2;\n',
      'bad.ts': Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0x78, 0x20, 0x3d, 0x20, 0x22, 0x00, 0x22, 0x3b, 0x0a]),
    }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('bad.ts');
    expect(r.out).toContain('0x00');
  });

  it('反例：扫描面空转 → exit 2 显式失败不假绿', () => {
    const root = mkdtempSync(join(tmpdir(), 'gti-empty-'));
    const r = runGuard('check-text-integrity.mjs', root);
    expect(r.code).toBe(2);
  });
});


// ── check-process-state：run 隔离守卫（ARCHITECTURE ^anc-run-isolation,2026-08-14）──
// @v: anc-run-isolation
describe('check-process-state 判据回归', () => {
  function psFixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'gps-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, 'src', name), content);
    }
    return root;
  }

  it('正例：干净内核 → exit 0', () => {
    const r = runGuard('check-process-state.mjs', psFixture({ 'a.ts': 'const x = 1;\n' }));
    expect(r.code).toBe(0);
  });

  it('反例三型：内核读 env/写 env/顶层可变 let → exit 1 各自命中', () => {
    const r = runGuard('check-process-state.mjs', psFixture({
      'r.ts': "const k = process.env['K'];\n",
      'w.ts': "process.env['X'] = 'y';\n",
      'l.ts': 'let counter = 0;\n',
    }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('内核读进程状态');
    expect(r.out).toContain('env 写入');
    expect(r.out).toContain('模块顶层可变状态');
  });

  it('反例：组合根写 env 也拒（写一律禁,读才有白名单）', () => {
    const r = runGuard('check-process-state.mjs', psFixture({
      'cli.ts': "process.env['X'] = 'y';\n",
    }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('env 写入');
  });

  it('正例：组合根读 env 放行（进程边界翻译层）', () => {
    const r = runGuard('check-process-state.mjs', psFixture({
      'cli.ts': "const m = process.env['HOPJIT_OUTPUT'];\nlet FORCE = m === 'json';\n",
    }));
    expect(r.code).toBe(0);
  });
});

// ── check-driver-carriers：心跳判死即行动 token（^anc-driver-codex-first-heartbeat,2026-08-14 flash 两轮超时实撞） ──
// @v: anc-driver-codex-first-heartbeat, anc-driver-codex-static-lint
describe('check-driver-carriers 心跳判死即行动判据回归', () => {
  function codexFixture(mutate: (content: string) => string): string {
    const root = mkdtempSync(join(tmpdir(), 'gdc-hb-'));
    const { cpSync, readFileSync: rf, writeFileSync: wf } = require('node:fs') as typeof import('node:fs');
    cpSync(join(REPO, 'driver'), join(root, 'driver'), { recursive: true });
    const p = join(root, 'driver/codex/SKILL.md');
    wf(p, mutate(rf(p, 'utf-8')));
    return root;
  }

  it('反例：skill 丢"判死即行动"禁令 → exit 1（弱模型卡死点防回退）', () => {
    const r = runGuard('check-driver-carriers.mjs', codexFixture(
      c => c.replace('禁止再 wait、禁止只查目录不行动', '尽快处理'),
    ));
    expect(r.code).toBe(1);
    expect(r.out).toContain('禁止再 wait');
  });

  it('反例：skill 丢空真短路（"天然满足"）→ exit 1', () => {
    const r = runGuard('check-driver-carriers.mjs', codexFixture(
      c => c.replaceAll('天然满足', '自动成立'),
    ));
    expect(r.code).toBe(1);
  });

  it('反例：skill 丢言行自检条款 → exit 1', () => {
    const r = runGuard('check-driver-carriers.mjs', codexFixture(
      c => c.replace('没发 spawn 就 wait 是在等一个不存在的人', ''),
    ));
    expect(r.code).toBe(1);
  });
});

// ── check-driver-carriers：last_sync 一致性（^anc-driver-lint-last-sync,手工纪律三撞升守卫 2026-08-14） ──
// @v: anc-driver-lint-last-sync, anc-driver-codex-static-lint
describe('check-driver-carriers last_sync 一致性判据回归', () => {
  function gitFixture(lastSync: string, opts: { dirty?: boolean; commitDate?: string } = {}): string {
    const root = mkdtempSync(join(tmpdir(), 'gdc-ls-'));
    const { cpSync, writeFileSync: wf, readFileSync: rf, readdirSync } = require('node:fs') as typeof import('node:fs');
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    cpSync(join(REPO, 'driver'), join(root, 'driver'), { recursive: true });
    // 全部文件 last_sync 刷到今天(基线绿),目标文件设为指定值:
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);   // 本地日（守卫比对 git --date=short 本地日——UTC 日在跨日窗口差一天,2026-08-16 实撞）
    const walk = (d: string) => {
      for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.md')) {
          const p = join(root, rel);
          wf(p, rf(p, 'utf-8').replace(/last_sync:\s*[^\n]+/, `last_sync: ${today}T00:00+0800`));
        }
      }
    };
    walk('driver');
    const target = join(root, 'driver/codex/SKILL.md');
    wf(target, rf(target, 'utf-8').replace(/last_sync:\s*[^\n]+/, `last_sync: ${lastSync}T00:00+0800`));
    // 真 git 仓库（守卫的 git 面判据需要）:
    execSync('git init -q && git add -A', { cwd: root });
    const commitDate = opts.commitDate ?? today;
    execSync(`git -c user.email=t@t -c user.name=t commit -q -m init --date="${commitDate}T12:00:00"`, {
      cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: `${commitDate}T12:00:00` },
    });
    if (opts.dirty) wf(target, rf(target, 'utf-8') + '\n<!-- dirty edit -->\n');
    return root;
  }

  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);   // 本地日——UTC 日在 CST 凌晨窗口差一天,todo/0035 flake 修（同文件 491/588 行既有同款取法,此处漏改）

  it('反例：已提交面——最后 commit 日期 > last_sync → exit 1 报文含锚', () => {
    const r = runGuard('check-driver-carriers.mjs', gitFixture('2026-07-31'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('实改未刷 last_sync');
    expect(r.out).toContain('anc-driver-lint-last-sync');
  });

  it('反例：脏区面——文件正在改但 last_sync ≠ 今天 → exit 1', () => {
    const r = runGuard('check-driver-carriers.mjs', gitFixture('2026-07-31', { dirty: true }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('git 脏区');
  });

  it('正例：改 + 刷（last_sync=今天）→ 绿', () => {
    const r = runGuard('check-driver-carriers.mjs', gitFixture(today(), { dirty: true }));
    expect(r.code).toBe(0);
  });

  it('正例：非 git 替身根 → 显式跳过明说不装绿（既有替身 fixture 复用）', () => {
    const root = mkdtempSync(join(tmpdir(), 'gdc-nogit-'));
    const { cpSync } = require('node:fs') as typeof import('node:fs');
    cpSync(join(REPO, 'driver'), join(root, 'driver'), { recursive: true });
    const r = runGuard('check-driver-carriers.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('last_sync 一致性检查跳过');
  });
});

// primer stripSegment 判据回归已随盲测退役删除（被测脚本移 docs/obsolete/hopbuild/）。
// buildtest（接任者）判据回归——判分三件在真机档自证,此处钉三档调度契约的前置分支。
// @v: anc-driver-live-e2e-primer
describe('hopbuild-selftest（buildtest）判据回归', () => {
  it('反例：凭证缺席 → exit 2（三档调度前置缺失语义,不假绿不误报失败）', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts/hopbuild-selftest.mjs')], {
      encoding: 'utf-8',
      env: { ...process.env, DEEPSEEK_API_KEY: '', ZENMUX_API_KEY: '' },
      timeout: 30_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toContain('前置缺失');
  });
});

// ── i18n-staleness：译本滞后报告（design [[i18n#^anc-i18n-translation-discipline]] 第 3 条）──
// 报告型守卫（exit 恒 0——初期降档不拦）,判据仍须回归:滞后判定/结构问题/死链三面。
// @v: anc-i18n-translation-discipline
describe('i18n-staleness 判据回归', () => {
  function fixture(opts: { trace?: string; withSource?: boolean; sourceCommitted?: boolean }): string {
    const root = mkdtempSync(join(tmpdir(), 'i18n-'));
    mkdirSync(join(root, 'docs', 'i18n', 'en', 'tutorials'), { recursive: true });
    mkdirSync(join(root, 'docs', 'tutorials'), { recursive: true });
    if (opts.withSource !== false) writeFileSync(join(root, 'docs', 'tutorials', '00-新人导读.md'), '# 源\n');
    const trace = opts.trace ?? `%% @trace\n\tid: t-en\n\tsource: [[../../../tutorials/00-新人导读]]\n\tsource_id: t\n\ttype: translation\n\tlast_sync: 2020-01-01T00:00+0800\n%%\n`;
    writeFileSync(join(root, 'docs', 'i18n', 'en', 'tutorials', '00-start-here.md'), trace + '# EN\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: root });
    if (opts.sourceCommitted !== false) {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
    }
    return root;
  }

  it('反例：源 commit 日期 > 译本 last_sync → 报滞后（exit 仍 0——报告不拦）', () => {
    const root = fixture({});
    const r = runGuard('i18n-staleness.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('滞后 1');
    expect(r.out).toContain('00-新人导读');
  });

  it('正例：last_sync=今天 ≥ 源改动日 → 全新鲜', () => {
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);   // 本地日（守卫比对 git --date=short 本地日——UTC 日在跨日窗口差一天,2026-08-16 实撞）
    const root = fixture({ trace: `%% @trace\n\tid: t-en\n\tsource: [[../../../tutorials/00-新人导读]]\n\tsource_id: t\n\ttype: translation\n\tlast_sync: ${today}T00:00+0800\n%%\n` });
    const r = runGuard('i18n-staleness.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('滞后 0');
    expect(r.out).toContain('新鲜 1');
  });

  it('反例：译本缺 @trace type:translation → 报结构问题（翻译三纪律第 1 条）', () => {
    const root = fixture({ trace: '# 无 trace 头\n' });
    const r = runGuard('i18n-staleness.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('结构问题 1');
    expect(r.out).toContain('缺 @trace');
  });

  it('反例：source 链接死链 → 报解析不到', () => {
    const root = fixture({ withSource: false });
    const r = runGuard('i18n-staleness.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('死链');
  });

  it('反例：译本正文死链（markdown+wiki 双式）→ 报结构问题（首批实撞:D 系列 wiki 链未调相对路径）', () => {
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);   // 本地日（守卫比对 git --date=short 本地日——UTC 日在跨日窗口差一天,2026-08-16 实撞）
    const root = fixture({ trace: `%% @trace\n\tid: t-en\n\tsource: [[../../../tutorials/00-新人导读]]\n\tsource_id: t\n\ttype: translation\n\tlast_sync: ${today}T00:00+0800\n%%\n[[missing-doc]] and [broken](./nope.md)\n` });
    const r = runGuard('i18n-staleness.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('死链 missing-doc.md');
    expect(r.out).toContain('死链 ./nope.md');
  });

  it('正例：代码位示意 token 不误报死链（围栏+行内反引号——D1 实撞 `[[wiki-links]]`）', () => {
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);   // 本地日（守卫比对 git --date=short 本地日——UTC 日在跨日窗口差一天,2026-08-16 实撞）
    const tick = '\u0060';   // 反引号经码点注入,避免模板字面量转义嵌套
    const trace = `%% @trace\n\tid: t-en\n\tsource: [[../../../tutorials/00-新人导读]]\n\tsource_id: t\n\ttype: translation\n\tlast_sync: ${today}T00:00+0800\n%%\n`
      + `Use ${tick}[[wiki-links]]${tick} in Obsidian.\n${tick}${tick}${tick}\n[[fence-token]] [also](./fake.md)\n${tick}${tick}${tick}\n`;
    const root = fixture({ trace });
    const r = runGuard('i18n-staleness.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('结构问题 0');
  });

  it('正例：正文链接全在盘 → 零结构问题', () => {
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);   // 本地日（守卫比对 git --date=short 本地日——UTC 日在跨日窗口差一天,2026-08-16 实撞）
    const root = fixture({ trace: `%% @trace\n\tid: t-en\n\tsource: [[../../../tutorials/00-新人导读]]\n\tsource_id: t\n\ttype: translation\n\tlast_sync: ${today}T00:00+0800\n%%\n[[../../../tutorials/00-新人导读]] ok\n` });
    const r = runGuard('i18n-staleness.mjs', root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('结构问题 0');
  });
});

// ── parser-fuzz：三不变量穷举守卫（design [[spec-parser#^anc-meta-parser-fuzz]]）──
// 判据回归：静默吞红/白名单不误报/基线台账吞已知/空扫描面 exit 2。真跑 dist 产物（fuzzer import dist）。
// @v: anc-meta-parser-fuzz
describe('parser-fuzz 判据回归', () => {
  const GOOD_SPEC = `# T
Id: t
## Goal
g
## Inputs
- xs: [line]  # in
## Outputs
- r: line  # r
## Steps
1. [reason] R
  - ← xs
  + → r: line  # r
`;

  // 探底变异种子是常驻复现件——fixture 基线恒含其指纹（它测的是 examples 面,种子面已由真基线钉住）
  const SEED_KNOWN = [
    'delete-line|<seed:probe-mutations>|- 无冒号坏行',
    'delete-line|<seed:probe-mutations>|bareword-line',
    'delete-line|<seed:probe-mutations>|+ → wrong-arrow: line',
    'delete-line|<seed:probe-mutations>|流浪散文行',
    'delete-line|<seed:probe-mutations>|2 [act] 坏编号缺点号',
    // 全半角劣化形态（不变量④,按形态归组——真基线同款已知待修缺陷,fixture spec 的冒号声明位同样命中）
    'fullwidth|<form>|:→：',
    'fullwidth|<form>|)→）',
    'fullwidth|<form>|(→（',
    'fullwidth|<form>|,→，',
  ].map(fingerprint => ({ fingerprint }));

  function fixture(specText: string, baseline?: { known: { fingerprint: string }[] }): string {
    const root = mkdtempSync(join(tmpdir(), 'pfz-'));
    mkdirSync(join(root, 'examples'), { recursive: true });
    mkdirSync(join(root, 'audits', 'baselines'), { recursive: true });
    writeFileSync(join(root, 'examples', 'probe.md'), specText);
    const known = [...SEED_KNOWN, ...(baseline?.known ?? [])];
    writeFileSync(join(root, 'audits', 'baselines', 'parser-fuzz-known.json'), JSON.stringify({ _note: 'fixture', known }));
    return root;
  }

  it('正例：干净 spec（无惰性行）→ exit 0 无新增', () => {
    const r = runGuard('parser-fuzz.mjs', fixture(GOOD_SPEC));
    expect(r.code).toBe(0);
    expect(r.out).toContain('无新增');
  });

  // @v: anc-rule-decl-zone-warn —— 0016 治好 Inputs 裸词吞点后,守卫红例换形态+回归钉
  it('反例：静默吞行（标题与 Id 之间的流浪行——Steps 扩围后仍在的头区吞点）→ exit 1 报行号', () => {
    // 红例形态第三换：Inputs 裸词与 Steps 流浪行先后被 ^anc-rule-decl-zone-warn（W1 声明区+
    // Steps 扩围）治好,守卫探测能力的红例换用头区（# 标题与 Id: 行之间）流浪行——该形态仍真实静默吞
    //（不属任何 section,identifySections 与各段收集都摸不到它）。
    const bad = GOOD_SPEC.replace('Id: t', 'header-stray-swallowed\nId: t');
    const r = runGuard('parser-fuzz.mjs', fixture(bad));
    expect(r.code).toBe(1);
    expect(r.out).toContain('header-stray-swallowed');
    expect(r.out).toContain('delete-line');
  });

  it('正例：Steps 区流浪散文行不再静默吞（Steps 扩围回归钉——进 decl_zone_orphans,守卫零新增）', () => {
    const bad = GOOD_SPEC.replace('  - ← xs', '  - ← xs\n  stray-prose-collected');
    const r = runGuard('parser-fuzz.mjs', fixture(bad));
    expect(r.code).toBe(0);
    expect(r.out).toContain('无新增');
  });

  it('正例：Inputs 区裸词不再静默吞（0016 全角冒号一刀回归钉——进 decl_zone_orphans,守卫零新增）', () => {
    const bad = GOOD_SPEC.replace('- xs: [line]  # in', '- xs: [line]  # in\nbareword-swallowed');
    const r = runGuard('parser-fuzz.mjs', fixture(bad));
    expect(r.code).toBe(0);
    expect(r.out).toContain('无新增');
  });

  it('正例：已知盲区在基线台账内 → exit 0 标已知不红（棘轮语义）', () => {
    const bad = GOOD_SPEC.replace('Id: t', 'header-stray-swallowed\nId: t');
    const fp = 'delete-line|examples/probe.md|header-stray-swallowed';
    const r = runGuard('parser-fuzz.mjs', fixture(bad, { known: [{ fingerprint: fp }] }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('📒 已知');
  });

  it('正例：白名单形态（## Task 非关键字分区散文,^anc-rule-surface-heading-flavor）不误报', () => {
    const withTask = GOOD_SPEC.replace('## Steps', '## Task\ncontract prose line\n## Steps');
    const r = runGuard('parser-fuzz.mjs', fixture(withTask));
    expect(r.code).toBe(0);
    expect(r.out).toContain('白名单命中');
  });

  it('反例：examples 扫描面空转 → exit 2 显式失败不装绿', () => {
    const root = mkdtempSync(join(tmpdir(), 'pfz-empty-'));
    mkdirSync(join(root, 'examples'), { recursive: true });
    const r = runGuard('parser-fuzz.mjs', root);
    expect(r.code).toBe(2);
    expect(r.out).toContain('扫描面为空');
  });

  it('反例：不变量④全半角劣化（全角冒号致声明丢——探针实撞形态）→ 按形态归组报红', () => {
    // GOOD_SPEC 的 Inputs 行 `- xs: [line]` 的冒号换全角后该声明静默丢——结构 shape 变、零报错
    const r = runGuard('parser-fuzz.mjs', fixture(GOOD_SPEC));
    // GOOD_SPEC 本身含冒号声明位,fuzzer 对其做全角变异必测到劣化(除非 parser 已修)——
    // 判据:要么报 fullwidth 形态,要么(parser 修后)全绿;二者之外(如站点级刷屏)即判据坏
    const grouped = r.out.includes('[fullwidth] <form>') || r.out.includes('劣化形态 0');
    expect(grouped).toBe(true);
    if (r.out.includes('[fullwidth]')) {
      expect(r.out).toContain('站点');   // 形态行必须带站点计数（归组证据）
      expect(r.out).toContain('📒 已知'); // fixture 基线恒含四形态指纹——已知不红（棘轮语义同真基线）
      expect(r.code).toBe(0);
    }
  });

  it('反例：不变量③往返破坏（叙事节含 Tools: 内联标签——contract-review 基线族最小形态）→ exit 1 报 roundtrip', () => {
    // 原红例"就地展开复合输出"已被 serializer 三形态分写治好（0016 投影漂移修）,红例换用仍真实
    // 破坏的形态：## Task 叙事节里的 Goal:/Tools: 内联标签行,serialize 原文回写后 re-parse 把
    // 它们再认成段头（identifySections 内联标签面无 narrative 语境）→ re-parse 报错,守卫按 roundtrip 拒。
    const spec = `# T
Id: t

## Task

Goal: inline label in narrative
Tools: (none)
Inputs:
- x: text  # in

## Steps
1. [reason] R
  - ← x
  + → r: text  # out

## Outputs
- r: text  # r
`;
    const r = runGuard('parser-fuzz.mjs', fixture(spec));
    expect(r.code).toBe(1);
    expect(r.out).toContain('roundtrip');
  });

  it('正例：就地展开复合输出往返稳定（serializer 三形态分写回归钉——修前 type 空串漂移成 yaml）', () => {
    const spec = `# T
Id: t
## Goal
g
## Outputs
- report: yaml  # r
## Steps
1. [act] assemble
  + → report:
    - total: int
    - note: line
  > fill fields
`;
    const r = runGuard('parser-fuzz.mjs', fixture(spec));
    expect(r.code).toBe(0);
    expect(r.out).toContain('无新增');
  });

  it('正例：不变量②双语等价对合法全特性 spec 全绿（内置 en-features 种子恒核,语料含 case/collect/attr 面）', () => {
    const r = runGuard('parser-fuzz.mjs', fixture(GOOD_SPEC));
    expect(r.code).toBe(0);
    expect(r.out).toContain('双语等价：违约 0');
  });
});

// ── coverage-report：V8 覆盖 JSON 合并报告器（fuzz 与真机三档共用）──
// @v: anc-meta-parser-fuzz
describe('coverage-report 判据回归', () => {
  it('反例：目录不存在 → exit 2', () => {
    const r = runGuard('coverage-report.mjs', REPO, ['/nonexistent-cov-dir']);
    expect(r.code).toBe(2);
  });

  it('反例：目录空（无 coverage-*.json）→ exit 2 不装绿', () => {
    const d = mkdtempSync(join(tmpdir(), 'cov-empty-'));
    const r = runGuard('coverage-report.mjs', REPO, [d]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('coverage 目录空');
  });

  it('反例：面清单模式加载链出现清单外文件 → exit 1 报分母漂移', () => {
    // 用真 fuzz coverage 产物 + 阉割版清单（抽掉 tools.js）——报告器必须红
    const covDir = join(REPO, '.coverage-fuzz');
    if (!existsSync(covDir)) return;   // 无产物跳过（fuzz:parser:cov 未跑过的环境）
    const manifest = JSON.parse(readFileSync(join(REPO, 'scripts', 'parser-fuzz-face.json'), 'utf-8'));
    delete manifest.out['tools.js'];
    const d = mkdtempSync(join(tmpdir(), 'cov-face-'));
    writeFileSync(join(d, 'face.json'), JSON.stringify(manifest));
    const r = runGuard('coverage-report.mjs', REPO, [covDir, '--face', join(d, 'face.json')]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('分母漂移');
    expect(r.out).toContain('tools.js');
  });

  it('正例：完整面清单 → exit 0,面外文件带 vitest 归属数字（核验非宣称）', () => {
    const covDir = join(REPO, '.coverage-fuzz');
    if (!existsSync(covDir)) return;
    const r = runGuard('coverage-report.mjs', REPO, [covDir, '--face', join(REPO, 'scripts', 'parser-fuzz-face.json')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('fuzz 目标面');
    expect(r.out).toContain('不作数');
    // 归属数字须为实测（vitest 实测 N%）或明示缺数——不许静默无归属:
    expect(/vitest 实测 [\d.]+%|vitest 数字缺/.test(r.out)).toBe(true);
  });
});

// ── check-spec-syntax skills/ 面收窄（design [[hopbuild#^anc-build-layout]]——只收 spec.md,教学件不误伤）──
// @v: anc-build-layout
describe('check-spec-syntax skills 面判据回归', () => {
  // @v: anc-build-main-flow —— 扫描面清单自身的锁（工程链review-hopfix批 2026-09-02:面三变异实证
  // base 删目录 73 测试照绿——守卫测试全走替身仓库,零例断言真库清单;且扩面初版随 dc944874 串批
  // 事故丢失无人发现。本例读脚本文本断言四目录在场,防"补上又丢"复发）
  it('正例：真库 base 扫描面清单含四目录（examples/scripts-audit/scripts-deep-validate/scripts-hopfix）', () => {
    const src = readFileSync(join(REPO, 'scripts', 'check-spec-syntax.mjs'), 'utf-8');
    const baseLine = src.split('\n').find(l => l.includes('for (const base of'));
    expect(baseLine).toBeDefined();
    for (const dir of ['examples', 'scripts/audit', 'scripts/deep-validate', 'scripts/hopfix']) {
      expect(baseLine).toContain(`'${dir}'`);
    }
  });

  it('正例：skills/ 下非 spec.md 的教学件不进 validate 面（首扩误伤四件当场收窄的回归钉）', () => {
    // 真仓库直跑:primer 族在 skills/hopbuild/ 且无 Steps——若被收进面,S8/S10 必红;通过=收窄生效。
    // 真仓库全量 validate 随仓库 spec 数增长:2026-08-31 约 5s 时放宽到 20s;2026-09-26 实测单跑已要
    // 约 19s 纯 CPU（real 22.6s）,全量测试里 12~25s,20s 线在负载下必撞——放宽到 60s。
    const r = runGuard('check-spec-syntax.mjs', REPO);
    expect(r.code).toBe(0);
    expect(r.out).toContain('skills');
  }, 60_000);

  it('反例：skills/ 下 spec.md 坏语法 → 红（替身仓库注入坏 spec.md）', () => {
    const root = mkdtempSync(join(tmpdir(), 'ss-skills-'));
    mkdirSync(join(root, 'examples'), { recursive: true });
    mkdirSync(join(root, 'skills', 'probe'), { recursive: true });
    writeFileSync(join(root, 'examples', 'ok.md'), '# Spec: T\nId: t\n## Goal\ng\n## Outputs\n- r: line  # r\n## Steps\n1. [reason] R\n  + → r: line  # r\n');
    writeFileSync(join(root, 'skills', 'probe', 'spec.md'), '# Spec: Bad\nId: bad\n## Steps\n1. [nosuch] X\n');
    const r = runGuard('check-spec-syntax.mjs', root);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('spec.md');
  });

  // doc-ref 切片锚存在性（守卫③段——hopbuild primer 改节名即断锚,原靠运行期 P15/人工核对）// @v: anc-build-knowledge
  it('反例：spec doc-ref 引同目录知识件不存在的章节 → 断锚红点名章节', () => {
    const root = mkdtempSync(join(tmpdir(), 'ss-anchor-'));
    mkdirSync(join(root, 'examples'), { recursive: true });
    mkdirSync(join(root, 'skills', 'probe'), { recursive: true });
    writeFileSync(join(root, 'examples', 'ok.md'), '# Spec: T\nId: t\n## Goal\ng\n## Outputs\n- r: line  # r\n## Steps\n1. [reason] R\n  + → r: line  # r\n');
    writeFileSync(join(root, 'skills', 'probe', 'knowledge.md'), '# K\n## 真实章节\n内容\n');
    writeFileSync(join(root, 'skills', 'probe', 'spec.md'),
      '# Spec: T\nId: t\n## Goal\ng\n## Outputs\n- r: line  # r\n## Steps\n1. [reason] R\n  + → r: line  # r\n  > [[knowledge#不存在的章节]]\n');
    const r = runGuard('check-spec-syntax.mjs', root);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('切片锚断裂');
    expect(r.out).toContain('不存在的章节');
  });

  it('正例：doc-ref 引真实章节/跨目录引用不误伤 → 绿', () => {
    const root = mkdtempSync(join(tmpdir(), 'ss-anchor-ok-'));
    mkdirSync(join(root, 'examples'), { recursive: true });
    mkdirSync(join(root, 'skills', 'probe'), { recursive: true });
    writeFileSync(join(root, 'examples', 'ok.md'), '# Spec: T\nId: t\n## Goal\ng\n## Outputs\n- r: line  # r\n## Steps\n1. [reason] R\n  + → r: line  # r\n');
    writeFileSync(join(root, 'skills', 'probe', 'knowledge.md'), '# K\n## 真实章节\n内容\n');
    writeFileSync(join(root, 'skills', 'probe', 'spec.md'),
      '# Spec: T\nId: t\n## Goal\ng\n## Outputs\n- r: line  # r\n## Steps\n1. [reason] R\n  + → r: line  # r\n  > [[knowledge#真实章节]]\n  > [[docs/elsewhere#别处]]\n');
    const r = runGuard('check-spec-syntax.mjs', root);
    expect(r.code).toBe(0);   // 同目录真锚过;跨目录归 P15 不在本面
  });

  // 涂鸦区相对路径黑名单（2026-08-20 实撞:body 直执 "work_zone/…" 父目录缺失 ENOENT 三例秒败）
  // @v: anc-build-principles
  it('反例：spec body 写涂鸦区相对路径 "work_zone/…" → 黑名单红指路 work_zone_path', () => {
    const root = mkdtempSync(join(tmpdir(), 'ss-wz-'));
    mkdirSync(join(root, 'examples'), { recursive: true });
    writeFileSync(join(root, 'examples', 'bad.md'),
      '# Spec: T\nId: t\n## Goal\ng\n## Outputs\n- r: line  # r\n## Steps\n1. [act] W\n  + → r: line  # r\n  > ```hop_python\n  > r = "x"\n  > write(path: "work_zone/a.md", content: r)\n  > ```\n');
    const r = runGuard('check-spec-syntax.mjs', root);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('work_zone_path');
  });

  it('正例：skills/ 非恒名真 spec（首行 # Spec:）进 validate 面;知识件（首行非 Spec 头,围栏内含示例 # Spec: 行）不误伤（2026-08-21 判据升级:恒名 spec.md 漏非恒名真 spec）', () => {
    const root = mkdtempSync(join(tmpdir(), 'ss-firstline-'));
    mkdirSync(join(root, 'examples'), { recursive: true });
    mkdirSync(join(root, 'skills', 'probe'), { recursive: true });
    writeFileSync(join(root, 'examples', 'ok.md'), '# Spec: T\nId: t\n## Goal\ng\n## Outputs\n- r: line  # r\n## Steps\n1. [reason] R\n  + → r: line  # r\n');
    // 非恒名真 spec,坏语法——判据升级后必须被扫到
    writeFileSync(join(root, 'skills', 'probe', 'my-node.md'), '# Spec: Bad\nId: bad\n## Steps\n1. [nosuch] X\n');
    // 知识件:首行非 Spec 头,但围栏内含示例 # Spec: 行——不得误伤
    writeFileSync(join(root, 'skills', 'probe', 'knowledge.md'), '# 知识库\n\n示例:\n\n\`\`\`\n# Spec: 示例\n\`\`\`\n');
    const r = runGuard('check-spec-syntax.mjs', root);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('my-node.md');       // 非恒名真 spec 被扫到
    expect(r.out).not.toContain('knowledge.md'); // 知识件不误伤
  });

  it('正例：work_zone_path("名") 形态不触黑名单 → 绿', () => {
    const root = mkdtempSync(join(tmpdir(), 'ss-wz-ok-'));
    mkdirSync(join(root, 'examples'), { recursive: true });
    writeFileSync(join(root, 'examples', 'ok.md'),
      '# Spec: T\nId: t\n## Goal\ng\n## Outputs\n- r: line  # r\n## Steps\n1. [act] W\n  + → r: line  # r\n  > ```hop_python\n  > r = "x"\n  > write(path: work_zone_path("a.md"), content: r)\n  > ```\n');
    const r = runGuard('check-spec-syntax.mjs', root);
    expect(r.code).toBe(0);
  });
});


// ── 发布防线四断言（design [[release-engineering#^anc-release-boundary-guards]],2026-09-13）──
// maintainers/ "不出公开面"由四处独立声明兑现,任一静默漂移其余不报警——第九轮工程链 review
// 变异核证实锤三处全穿透（INCLUDE_DIRS 偷加/MISS_EXPECTED 删项/NONRELEASE_RE 删项,全库零机检红）。
// 发布脚本不被 vitest 跑,守卫形态=静态文本断言（与上方 release.sh 快照制断言组同款成例）。
// 公开快照标记（design [[release-engineering#^anc-release-github-snapshot]] 公开快照自洽节）：
// scripts/check-hopissues.mjs 在快照剔除清单里、内网恒在（check:fast 要调它）——它不在即当前是公开快照。
// 读被剔除文件的测试按此标记跳过。不按"被读文件在不在"判：那样内网误删被测脚本会跟着静默跳过，防线退化。
const PUBLIC_SNAPSHOT = !existsSync(join(REPO, 'scripts', 'check-hopissues.mjs'));

// @v: anc-release-boundary-guards
describe('发布防线四断言（maintainers/ 不出公开面）', () => {
  it.skipIf(PUBLIC_SNAPSHOT)('github-publish.sh 出闸白名单 INCLUDE_DIRS 不含 maintainers（误配即整目录进公开快照,词表对其现内容零命中,白名单是唯一有效防线——变异:偷加 maintainers 本例红）', () => {
    const sh = readFileSync(join(REPO, 'scripts', 'github-publish.sh'), 'utf-8');
    const line = sh.split('\n').find(l => l.trimStart().startsWith('INCLUDE_DIRS=('));
    expect(line).toBeDefined();
    expect(line).not.toContain('maintainers');
  });

  it.skipIf(PUBLIC_SNAPSHOT)('github-verify.sh 验闸清单 MISS_EXPECTED 含 maintainers（删项后 verify 照报全过,验闸静默退化——变异:删 maintainers 项本例红;断言取括号内数组体,防行尾注释里的 maintainers 字样假绿〔首拍实撞〕）', () => {
    const sh = readFileSync(join(REPO, 'scripts', 'github-verify.sh'), 'utf-8');
    const line = sh.split('\n').find(l => l.trimStart().startsWith('MISS_EXPECTED=('));
    expect(line).toBeDefined();
    const arrayBody = line!.slice(line!.indexOf('(') + 1, line!.indexOf(')'));
    expect(arrayBody.split(/\s+/)).toContain('maintainers');
  });

  it('release.sh 凭证差集闸 NONRELEASE_RE 含 maintainers/（删项后果是误拦方向,同为防线声明点——变异:删 maintainers/ 本例红）', () => {
    const sh = readFileSync(join(REPO, 'scripts', 'release.sh'), 'utf-8');
    const line = sh.split('\n').find(l => l.trimStart().startsWith('NONRELEASE_RE='));
    expect(line).toBeDefined();
    expect(line).toContain('maintainers/');
  });

  it('package.json files 白名单不含 maintainers 与 RELEASING（npm tarball 出口负向断言,防将来误加）', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8'));
    const files: string[] = pkg.files ?? [];
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => f.includes('maintainers'))).toBe(false);
    expect(files.some(f => f.includes('RELEASING'))).toBe(false);
  });
});

// ── GitHub 公开快照远端立基（design [[release-engineering#^anc-release-github-snapshot]],todo/0094）──
// 旧脚本只看本地 .git 目录在不在就决定"追加还是 git init"——临时目录被系统清理后盲建出与远端不同宗的孤立历史,
// 推送时才被 fast-forward 保护拒绝(0.16.0/0.17.0 两撞);.git 只剩半截(没有 HEAD)时直接在坏仓上报错(0.18.0 撞)。
// 行为测试:本地裸仓当远端(HOP3_GITHUB_URL),只立基不导出(HOP3_PUBLISH_BASE_ONLY=1),覆盖立基规则表第 1/2/4/5/6/7 行。
// @v: anc-release-github-snapshot
describe.skipIf(PUBLIC_SNAPSHOT)('github-publish.sh 远端立基（立基规则表）', () => {
  const PUBLISH = join(REPO, 'scripts', 'github-publish.sh');
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  };
  function git(args: string[], cwd?: string): string {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  /** 建一个裸仓当远端;withMain=true 时推入一个快照形态提交,返回其提交号 */
  function remote(withMain: boolean): { root: string; url: string; main: string } {
    const root = mkdtempSync(join(tmpdir(), 'gh-snap-'));
    const url = join(root, 'remote.git');
    git(['init', '-q', '--bare', url]);
    if (!withMain) return { root, url, main: '' };
    const seed = join(root, 'seed');
    git(['init', '-q', '-b', 'main', seed]);
    git(['commit', '-q', '--allow-empty', '-m', 'hoplogic 0.0.1 (snapshot of internal abc1234)'], seed);
    git(['push', '-q', url, 'main'], seed);
    return { root, url, main: git(['rev-parse', 'HEAD'], seed) };
  }
  function publish(url: string, snap: string): { code: number; out: string } {
    const r = spawnSync('bash', [PUBLISH, snap], {
      encoding: 'utf-8',
      env: { ...GIT_ENV, HOP3_GITHUB_URL: url, HOP3_PUBLISH_BASE_ONLY: '1' },
    });
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }
  const head = (snap: string) => git(['--git-dir', join(snap, '.git'), 'rev-parse', 'HEAD']);

  it('① 快照目录不存在、远端有 main → 按远端 main 立基,本地 HEAD 等于远端 main（修前盲 init 产孤立根提交,本例红）', () => {
    const r0 = remote(true);
    const snap = join(r0.root, 'snap');
    const r = publish(r0.url, snap);
    expect(r.code, r.out).toBe(0);
    expect(head(snap)).toBe(r0.main);
  }, 60_000);

  it('② 快照目录里 .git 损坏（只剩 objects 目录、没有 HEAD）→ 删坏仓后按远端 main 立基（0.18.0 实况形态）', () => {
    const r0 = remote(true);
    const snap = join(r0.root, 'snap');
    mkdirSync(join(snap, '.git', 'objects'), { recursive: true });
    const r = publish(r0.url, snap);
    expect(r.code, r.out).toBe(0);
    expect(head(snap)).toBe(r0.main);
  }, 60_000);

  it('③ 远端不可达 → 退出非零、报"远端探测失败"、快照目录零改动（不创建 .git,不退回盲建）', () => {
    const r0 = remote(false);
    const snap = join(r0.root, 'snap');
    const r = publish(join(r0.root, 'no-such-remote.git'), snap);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('远端探测失败');
    expect(existsSync(join(snap, '.git'))).toBe(false);
    expect(existsSync(snap)).toBe(false);
  }, 60_000);

  it('④ 远端空仓（没有 main）→ 真首建,输出点明首次发布', () => {
    const r0 = remote(false);
    const snap = join(r0.root, 'snap');
    const r = publish(r0.url, snap);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('首次发布');
    expect(git(['--git-dir', join(snap, '.git'), 'symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
  }, 60_000);

  it('⑤ 本地 HEAD 已包含远端 main（本地多一个没推的提交）→ 沿用本地 HEAD 不重立', () => {
    const r0 = remote(true);
    const snap = join(r0.root, 'snap');
    git(['clone', '-q', r0.url, snap]);
    git(['commit', '-q', '--allow-empty', '-m', 'hoplogic 0.0.2 (snapshot of internal def5678)'], snap);
    const local = head(snap);
    const r = publish(r0.url, snap);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('沿用本地');
    expect(head(snap)).toBe(local);
  }, 60_000);

  it('⑥ 本地历史与远端分叉（远端 main 不是本地 HEAD 的祖先）→ 按远端 main 立基', () => {
    const r0 = remote(true);
    const snap = join(r0.root, 'snap');
    git(['init', '-q', '-b', 'main', snap]);
    git(['commit', '-q', '--allow-empty', '-m', 'orphan'], snap);
    const r = publish(r0.url, snap);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('分叉');
    expect(head(snap)).toBe(r0.main);
  }, 60_000);

  it('⑦ 全流程:本地仓与远端分叉且带上一轮导出留下的旧 tag → 新快照提交以远端 main 为父,本地 tag 移到新提交（修前"已存在不重打"留旧 tag 在孤立提交上,本例红）', () => {
    const r0 = remote(true);
    // 替身内网仓库:脚本按自身位置找仓库根,放一份脚本副本 + 白名单全部目录与文件的最小占位 + 净度词表
    const repo = join(r0.root, 'repo');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    cpSync(PUBLISH, join(repo, 'scripts', 'github-publish.sh'));
    writeFileSync(join(repo, 'scripts', 'github-purity-words.txt'), '# 替身词表\nzz-never-matches-zz\n');
    for (const d of ['src', 'tests', 'docs', 'driver', 'skills', 'examples', 'editors', 'model-gearbox']) {
      mkdirSync(join(repo, d), { recursive: true });
      writeFileSync(join(repo, d, 'placeholder.txt'), `${d}\n`);
    }
    writeFileSync(join(repo, 'examples', 'README.md'), '# examples\n');
    for (const f of ['README.md', 'USAGE.md', 'ARCHITECTURE.md', 'Doctree.md', 'TRACEABILITY.md', 'STATUS.md', 'LICENSE', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts']) {
      writeFileSync(join(repo, f), `${f}\n`);
    }
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9', scripts: { 'check:fast': 'tsc' } }, null, 2) + '\n');
    git(['init', '-q', '-b', 'main', repo]);
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'internal'], repo);
    // 快照目录:与远端分叉的本地仓,旧 tag v9.9.9 打在孤立提交上
    const snap = join(r0.root, 'snap');
    git(['init', '-q', '-b', 'main', snap]);
    git(['commit', '-q', '--allow-empty', '-m', 'orphan'], snap);
    git(['tag', 'v9.9.9'], snap);
    const orphan = head(snap);
    const r = spawnSync('bash', [join(repo, 'scripts', 'github-publish.sh'), snap], {
      encoding: 'utf-8',
      env: { ...GIT_ENV, HOP3_GITHUB_URL: r0.url },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, out).toBe(0);
    const newHead = head(snap);
    expect(newHead).not.toBe(orphan);
    expect(git(['--git-dir', join(snap, '.git'), 'rev-parse', 'HEAD^'])).toBe(r0.main);
    expect(git(['--git-dir', join(snap, '.git'), 'rev-parse', 'v9.9.9^{commit}'])).toBe(newHead);
    expect(out).toContain('已移到');
  }, 60_000);
});

// release.sh 两条静态断言（同上设计节）:⑦b 轮询总时长与收尾指路 GitHub 快照步。
// @v: anc-release-github-snapshot
describe('release.sh registry 轮询时长与 GitHub 快照指路', () => {
  const sh = readFileSync(join(REPO, 'scripts', 'release.sh'), 'utf-8');

  it('⑦b 轮询等待数组 POLL_SLEEPS 合计不少于 540 秒（0.18.0 实撞 publish 后约 5 分钟才可见,原 210 秒判了假失败）', () => {
    const line = sh.split('\n').find(l => l.trimStart().startsWith('POLL_SLEEPS=('));
    expect(line).toBeDefined();
    const body = line!.slice(line!.indexOf('(') + 1, line!.indexOf(')'));
    const total = body.trim().split(/\s+/).map(Number).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(540);
  });

  it('"✅ 发版完成" 那行之后紧跟指向 github-publish.sh 的下一步提示', () => {
    const lines = sh.split('\n');
    const i = lines.findIndex(l => l.includes('✅ 发版完成'));
    expect(i).toBeGreaterThan(-1);
    expect(lines.slice(i + 1, i + 4).some(l => l.includes('github-publish.sh'))).toBe(true);
  });
});

// chain-enforcement §5 第 5 条：测试运行器的进度回报不许被同步起子进程的用例饿死。
// 去掉让出钩子后,单跑 cli.test.ts 三次复现 `Timeout calling "onTaskUpdate"`（测试全过、退出码 1）——
// 钩子本身不经任何行为测试可见,只能钉挂载关系,防有人当成冗余配置删掉。
// @v: anc-meta-guard-trust
describe('vitest 进度回报让出钩子', () => {
  it('vitest.config.ts 的 setupFiles 挂着 tests/setup/yield-event-loop.ts', () => {
    const cfg = readFileSync(join(REPO, 'vitest.config.ts'), 'utf-8');
    expect(cfg).toMatch(/setupFiles:\s*\[[^\]]*['"]tests\/setup\/yield-event-loop\.ts['"]/);
  });
  it('让出钩子在 afterEach 里用 setImmediate 让出事件循环', () => {
    const src = readFileSync(join(REPO, 'tests', 'setup', 'yield-event-loop.ts'), 'utf-8');
    expect(src).toMatch(/afterEach\(\s*\(\)\s*=>\s*new Promise<void>\(\s*\(?resolve\)?\s*=>\s*setImmediate\(resolve\)\s*\)\s*\)/);
  });
});
