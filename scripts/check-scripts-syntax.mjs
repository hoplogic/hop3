// scripts/ 全部 .mjs 的 node --check 语法门。// @a: anc-meta-guard-trust
// 为什么存在：断言库等 .mjs 不经 tsc（只查 src/）也不经 vitest 编译面（fixture 测试拿到的是
// import 后的函数）——语法级断链（重复声明等）只有 node 原生加载才炸，此前=真机 e2e 才暴露
// （2026-08-11 实撞：断言迁移引入重复 const log，五场景真机全红同一 SyntaxError）。
// 守卫自证：零文件=显式失败（防 glob 静默空转）；坏文件=报文件名+错误摘要（不吞现场）。
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// HOPJIT_CHECK_ROOT：判据回归测试注入 fixture 仓库根（chain-enforcement §5 硬要求 2）；生产恒缺省
const ROOT = process.env['HOPJIT_CHECK_ROOT'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const files = globSync(join(ROOT, 'scripts', '**', '*.mjs')).sort();
if (files.length === 0) {
  console.error('check:scripts-syntax FAILED: glob 未匹配到任何 scripts/**/*.mjs（根=' + ROOT + '）——扫描面异常（目录改名/守卫脚本挪位?），不许静默空转。');
  process.exit(2);
}
let failed = 0;
for (const f of files) {
  try {
    execFileSync('node', ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    const stderr = String(err.stderr ?? '').split('\n').slice(0, 6).join('\n');   // 6 行含 SyntaxError 正文（node --check 格式：路径/源行/箭头/空行/错误行）
    console.error(`✗ ${f}\n${stderr}`);
  }
}
// .sh 面（2026-08-14 三档 review 补）：release.sh/live-*.sh 等 7 个 shell 脚本此前语法零机检——
// 批量脚本改写高频期裸奔。bash -n 只查语法不执行。.sh 零文件不红（shell 脚本非必有资产）。
const shFiles = globSync(join(ROOT, 'scripts', '**', '*.sh')).sort();
for (const f of shFiles) {
  try {
    execFileSync('bash', ['-n', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    const stderr = String(err.stderr ?? '').split('\n').slice(0, 4).join('\n');
    console.error(`✗ ${f}\n${stderr}`);
  }
}
if (failed > 0) {
  console.error(`check:scripts-syntax FAILED: ${failed}/${files.length + shFiles.length} 个文件语法错误（见上）。修法：按报错行修文件后重跑 npm run -s check:scripts-syntax。`);
  process.exit(1);
}
console.log(`Scripts syntax check passed. (${files.length} mjs + ${shFiles.length} sh)`);
