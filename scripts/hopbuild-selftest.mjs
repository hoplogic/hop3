#!/usr/bin/env node
// hopbuild 自跑 e2e（buildtest——live:deep 成员,2026-08-18 盲测替换批）：
// 真跑 hopbuild spec 翻译一题样本 NL skill——引擎驱动/doc-ref 切片注入/validate 自校验/retry 闭环
// 全在真实消费形态下。判分两件（不采信 agent 自评）:产物 validate 零 error + source.md 纯副本落盘
//（锚点体系缓装 2026-08-20——对账判分随退役）。协议契约 design/carrier-live-e2e.md ^anc-driver-live-e2e-primer。
// 退出码 0=绿 1=失败 2=前置缺失（三档调度契约）。
// 用法：node scripts/hopbuild-selftest.mjs [--timeout-min 30]
// @a: anc-driver-live-e2e-primer
import { mkdtempSync, readFileSync, writeFileSync, existsSync, cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'skills/hopbuild2/spec.md');   // v1 spec 退役改 NL 形态（2026-08-25 ^anc-build-bootstrap 翻案条）——引擎强制链真机验证归 hopbuild2
// 样本三例并行（作者定 2026-08-18——各覆盖一组要素,轻档量级几分钟;ticket 重档题留 --fixture 手动深跑）:
// mini=遍历+不可逆(for-each/commit) | branch=分档+人审(branch/case/confirm 把关链) | verify=核验闭环+裁量(check final/retry/ask) | multi=多文件保真(D83 附属二分/基准拼接/分隔行——目录形态 fixture,review-hb2补课批 2026-09-08 补:此前三例全单文件,D83 主链 live 档零覆盖)
const fIdx = process.argv.indexOf('--fixture');
const CASES = fIdx >= 0
  ? [{ id: resolve(process.argv[fIdx + 1]).split('/').pop().replace('.md',''), fixture: resolve(process.argv[fIdx + 1]) }]
  : [
      { id: 'mini',   fixture: join(ROOT, 'scripts/fixtures/mini-skill.md') },
      { id: 'branch', fixture: join(ROOT, 'scripts/fixtures/branch-skill.md') },
      { id: 'verify', fixture: join(ROOT, 'scripts/fixtures/verify-skill.md') },
      { id: 'multi',  fixture: join(ROOT, 'scripts/fixtures/multi-skill') },
    ];
// 缺省 60min（v4-pro 实测:30min 时 18 步 done 仍在健康推进被掐——递归展开循环多轮分钟级,
// 30 不够;强档单轮核查一次过,时间花在真工作上）
const tIdx = process.argv.indexOf('--timeout-min');
const timeoutMin = tIdx >= 0 ? Number(process.argv[tIdx + 1]) || 60 : 60;

// 前置：凭证（standalone reason/act 需 LLM API——live 档同款环境）
const KEY_ENV = process.env['DEEPSEEK_API_KEY'] ? 'DEEPSEEK_API_KEY' : (process.env['ZENMUX_API_KEY'] ? 'ZENMUX_API_KEY' : null);
if (!KEY_ENV) { console.error('前置缺失：需 DEEPSEEK_API_KEY 或 ZENMUX_API_KEY（standalone LLM 执行）'); process.exit(2); }
if (!existsSync(SPEC) || CASES.some(c => !existsSync(c.fixture))) { console.error('前置缺失：spec.md 或 fixture 不在'); process.exit(2); }

// 多例并行=子进程隔离（每例 spawn 自身 --fixture 单跑——doc-ref 按 run 组合根 cwd 解析,
// 进程内并行 chdir 必串台;子进程各持独立 cwd 零共享。汇总三档:任一 fail→1,全绿→0）
if (CASES.length > 1) {
  const { spawn } = await import('node:child_process');
  const { createWriteStream } = await import('node:fs');
  // 过程流落 log 文件实时可 tail;stdout 只留结论通道（每例一行终判+汇总）——不混流不缓冲
  const logDir = mkdtempSync(join(tmpdir(), 'hopbuild-selftest-logs-'));
  const results = await Promise.all(CASES.map(c => new Promise(res => {
    const logPath = join(logDir, `${c.id}.log`);
    const log = createWriteStream(logPath);
    console.log(`── ${c.id} 启动（日志: tail -f ${logPath}）`);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fixture', c.fixture, '--timeout-min', String(timeoutMin)], { env: process.env });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('close', code => {
      log.end();
      console.log(`${code === 0 ? '✅' : '❌'} ${c.id} (exit ${code}${code !== 0 ? `,详见 ${logPath}` : ''})`);
      res({ id: c.id, code });
    });
  })));
  const worst = results.some(r => r.code !== 0) ? 1 : 0;
  console.log(`═══ ${worst ? '❌ 三例并行有失败' : '✅ 三例并行全绿'}（日志目录 ${logDir}）═══`);
  process.exit(worst);
}
const { id: CASE_ID, fixture: FIXTURE } = CASES[0];

const { HopjitMcpCore } = await import(join(ROOT, 'dist/mcp-server.js'));
const { parseSpec } = await import(join(ROOT, 'dist/parser.js'));
const { validateSpec } = await import(join(ROOT, 'dist/validator.js'));

const work = mkdtempSync(join(tmpdir(), 'hopbuild-selftest-'));
const skillDir = join(work, 'skills', 'sample');
mkdirSync(skillDir, { recursive: true });
// 目录形态 fixture(多文件 skill)整目录拷;单文件照旧拷成 SKILL.md
if (statSync(FIXTURE).isDirectory()) cpSync(FIXTURE, skillDir, { recursive: true });
else cpSync(FIXTURE, join(skillDir, 'SKILL.md'));
// hopbuild2 四件复制入工作区根（doc-ref 按进程 cwd 解析——spec 与知识件同住 cwd 即命中;
// call 同目录寻址两分拆器。v1 spec 退役后被测物=hopbuild2,^anc-build-bootstrap 翻案条）
cpSync(SPEC, join(work, 'spec.md'));
cpSync(join(ROOT, 'skills/hopbuild2/split-node.md'), join(work, 'split-node.md'));
cpSync(join(ROOT, 'skills/hopbuild2/split-structure.md'), join(work, 'split-structure.md'));
cpSync(join(ROOT, 'skills/hopbuild2/split-patterns.md'), join(work, 'split-patterns.md'));

// 构建模型=强档（首跑实测:deepseek-chat 轻档下 attempt2/3 产物逐字节同交——反馈注入了没消费,
// 弱模型典型;hopbuild 是元编程任务〔写 spec〕,按路由哲学吃最强档——replan 类同理。
// HOPJIT_BUILDTEST_MODEL 可覆盖试档）。
const MODEL = process.env['HOPJIT_BUILDTEST_MODEL'] ?? 'deepseek-v4-pro';   // DS 直连即有 v4-pro（作者定）
// 机械档模型（分档路由,act 面实撞后收回——act 双形态:带 hop_python body 的引擎直执**零 LLM 调用**
// 路由无关;无 body 的 act 是工具循环文本加工（读原文/植锚/并入草稿/组装审阅件）恰需能力,chat 档
// 实撞:5.3.4 并入草稿把说明散文塞进 draft_path 值→5.4 read(path:散文)报 Path traversal 毒值下游。
// 真机械且走 LLM 的只有 commit 写盘一步——快档只留 commit）
const FAST_MODEL = process.env['HOPJIT_BUILDTEST_FAST_MODEL'] ?? 'deepseek-chat';
// 输出预算升 32768（实撞:v4-pro thinking 型把缺省 16384 全烧在推理上,text 空——OUTPUT_TRUNCATED
// 响亮失败后同预算重试同因必死,测试语境直接给足）。已设过的不覆盖。
process.env['HOPJIT_MAX_OUTPUT_TOKENS'] ??= '65536';   // flash 实撞 32768 顶满(偶发滔滔不绝)——OUTPUT_TRUNCATED 响亮但重试同预算再滔滔=白烧,给足
const base = process.env['ZENMUX_API_KEY'] && !process.env['DEEPSEEK_API_KEY']
  ? { base_url: 'https://zenmux.ai/api/anthropic' }
  : { base_url: 'https://api.deepseek.com/anthropic' };
const core = new HopjitMcpCore({
  providers: [{ service_id: 'ds', protocol: 'anthropic', base_url: base.base_url, model: MODEL, api_key_env: KEY_ENV }],
  routing_rules: [
    { step_type: 'commit', model: `ds/${FAST_MODEL}` },
  ],
});
console.log(`── 构建模型: ${MODEL}（commit 机械档 → ${FAST_MODEL}）`);

const t0 = Date.now();
const deadline = t0 + timeoutMin * 60_000;
const oldCwd = process.cwd();
process.chdir(work);
const stateDir = join(work, '.hopstate');
console.log(`═══ hopbuild 自跑 e2e（样本=${CASE_ID};超时 ${timeoutMin}min;工作区 ${work}）═══`);

// skill_path 用相对路径（run 组合根 cwd=work——沙箱 write 拒绝绝对路径:v3.5.0 轮实撞,步骤6 commit body
// 以 skill_path 算交付路径,绝对形态被工具面拦）
// max_depth 恒传（D75 产物嵌套深度闸——spec.md Inputs 新必填,顶层闸 INIT_FAILED 拒缺参;缺省档 3）
const r0 = await core.startRun(join(work, 'spec.md'), { input_skill_path: 'skills/sample/SKILL.md', max_depth: 3 }, stateDir);
if (r0.error) { console.error('startRun 拒:', JSON.stringify(r0.error)); process.exit(1); }
const runId = r0.run_id;

let answered = 0;
const MAX_ANSWERS = 8;   // 回路轮上限（对齐门/忠实门 fail 会重呈审——同 step 重答同款;超限=流程异常死循环）
// 按 step_id 映射（二十四审——按次数索引脆弱:4.3 对齐门 fail 回 4.1 后 4.2 二轮 paused 会吃掉终审答）
const ANSWER_BY_STEP = {
  '1.1': () => ({ value: 'skills/sample/SKILL.md' }), // skill_path 确认（相对路径——沙箱语义;D72② 步骤1改 subtask,ask 落 1.1）
  '4.4': () => ({ value: '' }),                          // hopbuild2 对齐门呈审 → 通过
  '5.1.3.1.6.3': () => ({ value: 'accept' }),            // 修检额度烧尽问人（D68/D69 三选一,快乐路径不触发;触发即选接受现状——守卫跑通优先,不选 continue 防自测无限续圈）
  '5.1.5': () => ({ value: '' }),                        // hopbuild2 终审 → 放行（D70 后步号:意见轮循环内）
  '5.1.7.3': () => ({ value: 'accept' }),                // 意见轮机械额度耗尽问人（D71 三选一,快乐路径不触发;触发即选接受现状——不选 continue 防自测无限续圈）
};
for (;;) {
  if (Date.now() > deadline) { console.error(`超时 ${timeoutMin}min（answered=${answered}）`); process.exit(1); }
  const st = core.runStatus(runId);
  if (st.status === 'completed') break;
  if (st.status === 'failed') { console.error('run failed:', JSON.stringify(st.failure).slice(0, 400)); process.exit(1); }
  if (st.status === 'paused') {
    const p = st.paused;
    const mk = ANSWER_BY_STEP[String(p?.step_id)];
    if (!mk) { console.error(`paused 在预答表外的步骤（step=${p?.step_id},reason=${p?.pause_reason}）——spec 暂停面变了,预答表须同步`); process.exit(1); }
    if (answered >= MAX_ANSWERS) { console.error(`注入超 ${MAX_ANSWERS} 次仍未终态（最后 step=${p?.step_id}）——疑呈审/终审死循环`); process.exit(1); }
    console.log(`── paused@${p?.step_id}（${p?.pause_reason}）→ 注入（第 ${answered + 1} 次）`);
    const rr = core.resumeRun(runId, p.step_id, mk(), stateDir);
    if (rr.error) { console.error('resume 拒:', JSON.stringify(rr.error)); process.exit(1); }
    answered++;
  }
  await new Promise(res => setTimeout(res, 3000));
}
process.chdir(oldCwd);

const st = core.runStatus(runId);
const outs = st.outputs ?? {};
console.log(`run completed（${Math.round((Date.now() - t0) / 1000)}s,answered=${answered}）`);

// ═══ 判分三件 ═══
let fail = 0;
// ① 产物 spec validate 零 error（generated_spec_path 是相对 run cwd=work 的路径——判分已 chdir 回
// oldCwd,须 resolve 到 work 下;三十一审抢修:相对形态改造后判分 existsSync 按 oldCwd 解析必假红）
const rawSpecPath = String(outs.generated_spec_path ?? '');
const specPath = rawSpecPath ? resolve(work, rawSpecPath) : '';
if (!specPath || !existsSync(specPath)) { console.error(`❌ 判分①: generated_spec_path 不存在（${specPath}）`); fail++; }
else {
  const { ast, errors: pe } = parseSpec(readFileSync(specPath, 'utf-8'));
  const errs = pe.length ? pe : validateSpec(ast).filter(e => e.severity === 'error');
  if (errs.length) { console.error(`❌ 判分①: 产物 validate ${errs.length} error——${errs.slice(0, 3).map(e => e.message).join('; ').slice(0, 200)}`); fail++; }
  else console.log('✅ 判分①: 产物 spec validate 零 error');
}
// ② source.md 纯副本落盘（锚点体系缓装 2026-08-20 作者定——判分③双向对账随退役;
// source.md 降纯原文副本:核在场+与 fixture 原文一致,不再核 ^src-* 锚）
const srcPath = specPath ? join(dirname(specPath), 'source.md') : '';
if (!srcPath || !existsSync(srcPath)) { console.error('❌ 判分②: source.md 未随产物落盘（原文副本缺席——终审与日后对读无基准）'); fail++; }
else {
  const src = readFileSync(srcPath, 'utf-8');
  const fixtureBody = statSync(FIXTURE).isDirectory() ? readFileSync(join(FIXTURE, 'SKILL.md'), 'utf-8') : readFileSync(FIXTURE, 'utf-8');
  if (!src.includes(fixtureBody.trim().split('\n')[0])) { console.error('❌ 判分②: source.md 内容与原文对不上（首行缺席——不是原文副本）'); fail++; }
  else console.log('✅ 判分②: source.md 纯副本落盘（原文首行在场）');
  // 多文件例加判:构建基准须含附属拼接分隔行（D83——流程性附属真进了视野的物理凭证;
  // 单文件例天然无分隔行不核）
  if (statSync(FIXTURE).isDirectory()) {
    if (!src.includes('<<<<< 附属文件')) { console.error('❌ 判分②b: 多文件例 source.md 不含附属拼接分隔行——流程性附属没进构建基准,D83 主链空转'); fail++; }
    else console.log('✅ 判分②b: 多文件例构建基准含附属拼接分隔行');
  }
}
console.log(fail ? `═══ ❌ buildtest 失败 ${fail} 项 ═══` : '═══ ✅ buildtest 全绿 ═══');
process.exit(fail ? 1 : 0);
