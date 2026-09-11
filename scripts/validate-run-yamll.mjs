// 校验一次真实 run 的所有 main.yaml（顶层 + parallel 子）YAMLL 逐块合法性。
// 复用 hoplog-fuzz.mjs 的 validateYamll 语义。用法：node scripts/validate-run-yamll.mjs <run-root-dir>
import { load } from '../node_modules/js-yaml/dist/js-yaml.mjs';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const root = process.argv[2];
if (!root) { console.error('用法: node scripts/validate-run-yamll.mjs <run-root-dir>'); process.exit(2); }

function validateYamll(txt) {
  const errs = [];
  const lines = txt.split('\n');
  const execIdx = lines.findIndex(l => l === 'execution:');
  if (execIdx < 0) { errs.push('无 execution: 标记'); return errs; }
  try { load(lines.slice(0, execIdx + 1).join('\n')); }
  catch (e) { errs.push('header 非法: ' + (e.problem || e.message)); }
  const isBlockHead = (l) => /^ *(?:"[\d.]+(?:#\d+)?"|[\d.]+(?:#\d+)?):\s*$/.test(l);
  const isTopKey = (l) => /^(status|ended_at|replan_audit|resumed_at|warn):/.test(l);
  let cur = [];
  const flush = (blk) => {
    const body = blk.filter(l => l.trim() !== '');
    if (body.length === 0) return;
    const minIndent = Math.min(...body.map(l => l.length - l.trimStart().length));
    const dedented = body.map(l => l.slice(minIndent)).join('\n');
    try { load(dedented); }
    catch (e) { errs.push(`块非法 [${body[0].trim()}]: ${e.problem || e.message}`); }
  };
  for (let i = execIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { cur.push(l); continue; }
    if (isBlockHead(l) || isTopKey(l)) { flush(cur); cur = [l]; }
    else cur.push(l);
  }
  flush(cur);
  return errs;
}

const files = execSync(`find "${root}" -name main.yaml`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
let ok = 0, bad = 0;
console.log(`=== 校验 ${files.length} 个 main.yaml ===`);
for (const f of files) {
  const txt = readFileSync(f, 'utf-8');
  const errs = validateYamll(txt);
  const rel = f.replace(root, '').replace(/^\//, '');
  if (errs.length === 0) { ok++; console.log(`  OK  ${rel}  (${txt.split('\n').length} 行)`); }
  else { bad++; console.log(`  ✗   ${rel}`); for (const e of errs.slice(0, 3)) console.log(`        → ${e}`); }
}
console.log(`\n=== 结果: ${ok} 合法, ${bad} 非法 ===`);
process.exit(bad === 0 ? 0 : 1);
