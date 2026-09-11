// hoplog 写入路径穷举 harness——每个场景真跑 HopLog + js-yaml 解析，列全崩溃点。不修，只暴露。
// 用法：node scripts/hoplog-fuzz.mjs
import { HopLog } from '../dist/hoplog.js';
import { load } from '../node_modules/js-yaml/dist/js-yaml.mjs';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const H = { workspace_dir: '/tmp', sandbox: {} };
let pass = 0, fail = 0;
const fails = [];

function check(name, buildFn) {
  const dir = mkdtempSync(join(tmpdir(), 'fuzz-'));
  let runDir;
  try {
    runDir = buildFn(dir);
  } catch (e) {
    fails.push({ name, phase: 'build', err: String(e.message).split('\n')[0] });
    fail++; return;
  }
  const f = join(runDir, 'main.yaml');
  let txt;
  try { txt = readFileSync(f, 'utf-8'); } catch (e) { fails.push({name,phase:'read',err:e.message}); fail++; return; }
  // YAMLL 校验：不 load 全文（块间允许重复 step-id 块头，全文非单一 YAML 树）。
  // 而是按块切分——execution 后每个 `<2d>"id":` 块头起一块，逐块（含块头当单键 mapping）load 必须合法。
  try {
    const errs = validateYamll(txt);
    if (errs.length === 0) { pass++; console.log('  OK  ' + name); }
    else { fail++; fails.push({ name, phase: 'yamll', err: errs[0] }); console.log('  ✗   ' + name + '  → ' + errs[0]); }
  } catch (e) {
    fail++; fails.push({ name, phase: 'harness', err: String(e.message) });
    console.log('  ✗   ' + name + '  [harness] ' + e.message);
  }
}

// YAMLL 校验器：header（execution: 之前）整体是合法 YAML；execution: 之后按块切分，每块单独合法。
// 块 = 一个 `<indent>"<id>":` 或 `<indent><id>:`（step-id 形态）块头行 + 其后更深缩进的 body，直到下一个同/更浅块头或顶层键。
function validateYamll(txt) {
  const errs = [];
  const lines = txt.split('\n');
  const execIdx = lines.findIndex(l => l === 'execution:');
  if (execIdx < 0) { errs.push('无 execution: 标记'); return errs; }
  // ① header：0..execIdx（含 execution:）应整体合法
  try { load(lines.slice(0, execIdx + 1).join('\n')); }
  catch (e) { errs.push('header 非法: ' + (e.problem || e.message)); }
  // ② execution 后按块头切分
  const isBlockHead = (l) => /^ *(?:"[\d.]+(?:#\d+)?"|[\d.]+(?:#\d+)?):\s*$/.test(l);
  const isTopKey = (l) => /^(status|ended_at|replan_audit|resumed_at|warn):/.test(l);
  let cur = [];
  const flush = (blk) => {
    const body = blk.filter(l => l.trim() !== '');
    if (body.length === 0) return;
    // 块头行缩进 2d，其 body 更深——单独 load 该块（它是一个单键 mapping）应合法
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
  return errs.slice(0, 3);
}

// 模拟 resume：从已有 runDir 重建（真实跨进程用 HopLog.resume）
function resumeLog(runDir, level) { return HopLog.resume(runDir, level); }

console.log('=== hoplog 写入路径穷举 ===');

// 1. 正常叶子步（info）
check('1-正常叶子(info)', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'info' });
  l.recordStepStart('1','reason','起草',{a:'x'});
  l.recordStepDone('1',{r:'ok'}); l.close('completed');
  return l.getRunDir();
});

// 1b. header 外部来源值含特殊字符（specId 用户 Id、traceId 调用方传）——须转义否则破 YAML header
check('1b-header特殊字符(specId/traceId转义)', (dir) => {
  const l = new HopLog({ specId:'spec: with colon', logDir:dir, title:'T', goal:'G', level:'info', traceId:'trace #hash: x' });
  l.recordStepStart('1','reason','起草',{a:'x'});
  l.recordStepDone('1',{r:'ok'}); l.close('completed');
  return l.getRunDir();
});

// 2. 正常叶子步（debug，prompt+response）
check('2-叶子debug(prompt+response)', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'多行\ngoal', level:'debug' });
  l.recordStepStart('1','reason','起草',{a:'x'},'prompt 多行\n第二行\n第三行');
  l.recordStepDone('1',{r:'ok'}); l.close('completed');
  return l.getRunDir();
});

// 3. debug + doc_refs 中途 meta（v3 崩点）
check('3-debug+doc_refs中途meta', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'debug' });
  l.recordStepStart('4','subtask','容器');
  l.recordStepStart('4.1','act','读取',{s:'y'},'prompt\n多行');
  l.recordStepMeta('4.1',{ doc_refs:[{source_id:'spec#一',at:'2026-01-01T00:00:00Z'}] });
  l.recordStepDone('4.1',{content:'大段\n内容'});
  l.recordStepDone('4',{done:true}); l.close('completed');
  return l.getRunDir();
});

// 4. parallel fanout / dispatch×N / join（完整新链路：fanout 字段序 max_concurrent→children→started_at；
//    每 child 一条 dispatch 块（dispatched_at/log，模拟增量滑动窗口派发）；join 带 per-child log + started_at + ended_at）
check('4-parallel fanout+dispatch+join', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'debug' });
  l.recordStepStart('4','subtask','容器');
  l.recordStepStart('4.3','parallel','并行');
  l.recordParallelFanout('4.3',['4.3.1','4.3.2','4.3.3'],2);
  // 初始批派发 2 个（窗口=2）
  l.recordParallelDispatch('4.3','4.3.1','logs/parallel/4.3.1/log');
  l.recordParallelDispatch('4.3','4.3.2','logs/parallel/4.3.2/log');
  // 4.3.1 完成后补位派发 4.3.3（dispatched_at 更晚，体现持续过程）
  l.recordParallelDispatch('4.3','4.3.3','logs/parallel/4.3.3/log');
  l.recordParallelJoin('4.3',{
    '4.3.1':{failed:false, log:'logs/parallel/4.3.1/log/run/main.yaml'},
    '4.3.2':{failed:false, log:'logs/parallel/4.3.2/log/run/main.yaml'},
    '4.3.3':{failed:true,  log:'logs/parallel/4.3.3/log/run/main.yaml'},
  }, '2026-07-09 12:25:44+08:00');
  l.recordStepDone('4.3',{pages:['p1','p2']});
  l.recordStepDone('4',{done:true}); l.close('completed');
  return l.getRunDir();
});

// 5. resume 续未完成叶子（进程A start 未 done，进程B resume 续 done）
check('5-resume续未完成叶子', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'debug' });
  l.recordStepStart('1','reason','起草',{a:'x'},'prompt\n多行');
  const rd = l.getRunDir();
  const r = resumeLog(rd);
  r.recordStepDone('1',{res:'ok'}); r.close('completed');
  return rd;
});

// 6. resume 深缩进子步中途（v3：subtask 内 act 中断）
check('6-resume深缩进子步', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'debug' });
  l.recordStepStart('4','subtask','容器');
  l.recordStepStart('4.1','act','子步一');
  l.recordStepDone('4.1',{r:'ok'});
  const rd = l.getRunDir();
  const r = resumeLog(rd);
  r.recordStepStart('4.2','act','子步二');
  r.recordStepDone('4.2',{r:'ok2'});
  r.recordStepDone('4',{done:true}); r.close('completed');
  return rd;
});

// 7. ★recover 重发同 step 多次（v4 line177 崩点）：进程A start 4.1(未done)，
//    进程B resume 后 recordStepStart('4.1') 被调 2 次（recover 重发），再 done
check('7-recover重发同step两次', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'debug' });
  l.recordStepStart('2','branch','分支');
  l.recordStepStart('2.1','case','命中');            // 不跳级：逐级 start（真实引擎行为）
  l.recordStepStart('2.1.1','act','读取',{s:'y'},'prompt\n多行\n三行');  // 崩前最后写的
  const rd = l.getRunDir();
  const r = resumeLog(rd);
  r.recordStepStart('2.1.1','act','读取',{s:'y'},'prompt\n多行\n三行'); // recover 重发 #1
  r.recordStepStart('2.1.1','act','读取',{s:'y'},'prompt\n多行\n三行'); // recover 重发 #2（幂等应跳过骨架）
  r.recordStepDone('2.1.1',{content:'x'});
  r.recordStepDone('2.1',{}); r.recordStepDone('2',{}); r.close('completed');
  return rd;
});

// 8. loop 多轮 #iter
check('8-loop多轮#iter', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'info' });
  l.recordStepStart('1','loop','循环');
  l.recordStepStart('1.1','reason','轮1'); l.recordStepDone('1.1',{x:'r1'});
  l.recordStepStart('1.1','reason','轮2'); l.recordStepDone('1.1',{x:'r2'});
  l.recordStepDone('1',{}); l.close('completed');
  return l.getRunDir();
});

// 9. resume 后直接 close（末步已 done，进程切换在 step 间）
check('9-resume后直接close', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'info' });
  l.recordStepStart('1','reason','x'); l.recordStepDone('1',{r:'ok'});
  const rd = l.getRunDir();
  const r = resumeLog(rd); r.close('completed');
  return rd;
});

// 10. recover 重发 + 后续还有兄弟步（重发 step 非文件末尾时）
check('10-recover重发后有兄弟步', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'debug' });
  l.recordStepStart('4','subtask','容器');
  l.recordStepStart('4.1','act','子步一',{},'p1');  // 未 done 崩
  const rd = l.getRunDir();
  const r = resumeLog(rd);
  r.recordStepStart('4.1','act','子步一',{},'p1');  // recover 重发
  r.recordStepDone('4.1',{r:'ok'});
  r.recordStepStart('4.2','act','子步二');  // 兄弟步
  r.recordStepDone('4.2',{r:'ok2'});
  r.recordStepDone('4',{done:true}); r.close('completed');
  return rd;
});

// 11. ★多次 resume 各触发幂等分支（v5 line1366 崩点）：4.1 start(debug prompt) 未 done →
//     进程 B resume 只走 recordStepStart(幂等)不 done → 进程 C resume 再续 → 最后 done。
//     每次 resume 的 recordStepStart 都落一个 resumed_at，验证多个 resumed_at 缩进都对。
check('11-多次resume各触发幂等', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'debug' });
  l.recordStepStart('4','subtask','容器');
  l.recordStepStart('4.1','act','读取',{s:'y'},'prompt\n多行\n三行'); // start 未 done
  const rd = l.getRunDir();
  const b = resumeLog(rd);
  b.recordStepStart('4.1','act','读取',{s:'y'},'prompt\n多行\n三行'); // resume#1 幂等→resumed_at
  // 进程 B 未 done 又退
  const c = resumeLog(rd);
  c.recordStepStart('4.1','act','读取',{s:'y'},'prompt\n多行\n三行'); // resume#2 幂等→又一 resumed_at
  c.recordStepDone('4.1',{content:'x'});
  c.recordStepDone('4',{done:true}); c.close('completed');
  return rd;
});

// 12. ★嵌套 resume：父容器 4 与子步 4.1 都经历 resume（v5 实际序）。
//     4 start → 4.1 start(未done) → resume → 4.1 done → 4 done → resume → close
check('12-嵌套resume父子都续', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'debug' });
  l.recordStepStart('4','subtask','容器');
  l.recordStepStart('4.1','act','读取',{s:'y'},'prompt\n多行');
  const rd = l.getRunDir();
  const b = resumeLog(rd);
  b.recordStepStart('4.1','act','读取',{s:'y'},'prompt\n多行'); // resume 续 4.1
  b.recordStepDone('4.1',{c:'x'});
  b.recordStepDone('4',{done:true});
  const c = resumeLog(rd); // 4 已 done，resume 后直接 close
  c.close('completed');
  return rd;
});

// 13. ★resume 续 debug act（prompt 已写）后接 doc_refs meta 再 done——resume+llm+meta+response 全叠加
check('13-resume续debug+meta+response', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'debug' });
  l.recordStepStart('2','branch','分支');
  l.recordStepStart('2.1','case','命中');            // 逐级 start，不跳级
  l.recordStepStart('2.1.1','act','读取',{s:'y'},'prompt\n多行\n三行'); // start(prompt) 未 done
  const rd = l.getRunDir();
  const r = resumeLog(rd);
  r.recordStepStart('2.1.1','act','读取',{s:'y'},'prompt\n多行\n三行'); // resume 幂等→resumed_at
  r.recordStepMeta('2.1.1',{ doc_refs:[{source_id:'spec#一',at:'2026-01-01T00:00:00Z'}] });
  r.recordStepDone('2.1.1',{content:'大段\n内容'});
  r.recordStepDone('2.1',{}); r.recordStepDone('2',{}); r.close('completed');
  return rd;
});

// 14. 文档级 warn（空 stepId）：Output 声明未赋值——warn 作顶层独立块，不过 guardOrphan、不误当孤儿。
//     级别须为 warn/info（recordWarn shouldRecord('warn')）；穿插在 step 块之后验证 YAMLL 块间独立。
check('14-文档级warn(空stepId顶层块)', (dir) => {
  const l = new HopLog({ specId:'s', logDir:dir, title:'T', goal:'G', level:'info' });
  l.recordStepStart('1','reason','起草',{a:'x'});
  l.recordStepDone('1',{r:'ok'});
  l.recordWarn('', 'Output "digest" declared in Outputs but never assigned'); // 文档级：顶层 warn 块
  l.close('completed');
  return l.getRunDir();
});

console.log(`\n=== 结果: ${pass} 通过, ${fail} 崩溃 ===`);
if (fails.length) {
  console.log('\n崩溃清单:');
  for (const f of fails) console.log(`  ✗ ${f.name} [${f.phase}] line ${f.line||'-'}: ${f.err}`);
}
