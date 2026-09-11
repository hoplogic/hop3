#!/usr/bin/env node
// @a: anc-meta-guard-entry
// check:audit 的入口——解析带 pyyaml 的 python 后跑 scan.py + cross_compare.py，传递真实退出码。
// 为什么不能在 package.json 里直接写 `python3 ...`：npm 子进程没有 shell alias，裸 python3
// 可能是无 pyyaml 的 homebrew python → 报"需要 PyYAML"退出 2；而管道/包装还可能吞退出码，
// 变成静默假绿——与 anchor-scan.test.ts 首版同一个坑（见 ^anc-meta-guard-trust 禁止静默跳过）。
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function findPython() {
  const candidates = [
    process.env.HOPJIT_TEST_PYTHON,
    join(process.env.HOME ?? '', '.venv', 'bin', 'python3'),
    'python3', 'python',
  ].filter(Boolean);
  for (const py of candidates) {
    try { execFileSync(py, ['-c', 'import yaml'], { stdio: 'ignore', timeout: 10000 }); return py; }
    catch { /* next */ }
  }
  return null;
}

const py = findPython();
if (!py) {
  console.error('未找到装 pyyaml 的 python —— uv pip install pyyaml，或 HOPJIT_TEST_PYTHON=<路径> 指定。不静默跳过。');
  process.exit(2);
}

let findings = false;
for (const script of ['scripts/audit/scan.py', 'scripts/audit/cross_compare.py']) {
  try {
    // 字节码缓存重定向出源码目录（作者定 2026-09-04"以后禁止乱放"——__pycache__ 不落 scripts/audit/;
    // PYTHONPYCACHEPREFIX 是 CPython 官方缓存重定向口,加速保留盘面干净。目录用 os.tmpdir() 跨机
    // 可移植:macOS/Linux/Windows/CI 各自的系统临时区,不硬编码本机路径——作者问"换一台机器会有
    // 问题么"后改定,初版写死 /tmp/claude-502 是本机会话惯例,别机没有）
    execFileSync(py, [join(ROOT, script), ROOT], { stdio: 'inherit', timeout: 120000, env: { ...process.env, PYTHONPYCACHEPREFIX: join(tmpdir(), 'hoplogic3-pycache') } });
  } catch (e) {
    if (e.status === 1) { findings = true; continue; }  // 1 = 有发现，非运行错误
    console.error(`${script} 运行错误（exit ${e.status}）`);
    process.exit(e.status ?? 2);
  }
}
// 基线比对（ci-pipeline 决策 3 已拍板"基线锁定"，2026-08-03）：
// 有发现 ≠ 红灯，变差才红——比对逻辑在 check-anchor-baseline.mjs，其退出码即本入口退出码。
if (findings) console.log('\n[check:audit] 有发现（明细见上方）——进入基线比对，变差才挡。');
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-anchor-baseline.mjs')], { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status ?? 2);
}
process.exit(0);
