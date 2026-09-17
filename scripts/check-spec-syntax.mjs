#!/usr/bin/env node
// release 必查（2026-08-09 作者定）:全部 examples/scripts spec ①过 validate ②不含旧写法。
// 旧写法兼容读(引擎绿)但样例是教材——教材必须只写标准写法,否则用户照抄旧形态。
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// HOPJIT_CHECK_ROOT：判据回归测试注入 fixture 仓库根（chain-enforcement §5 硬要求;同族 check-scripts-syntax 先例）；生产恒缺省
const ROOT = process.env['HOPJIT_CHECK_ROOT'] ?? resolve(import.meta.dirname, '..');
// cli 恒取本脚本所在仓库（替身仓库注入 fixture 时无 dist——validate 崩=假红,判据回归测试实抓）
const CLI_HOME = resolve(import.meta.dirname, '..');
const SKIP_NAMES = new Set(['README.md', 'GETTING-STARTED.md']);

// 旧写法黑名单（标准写法之外的形态;兼容读不等于教材可写）
const LEGACY = [
  { re: /max_iterations=/, hint: '旧属性 max_iterations=N → 用 max=N' },
  { re: /\[check finally\]/, hint: '旧修饰 check finally → 用 check final' },
  { re: /\[case\(\.\.\.\)\]|\[case\(default\)\]|\[case\(\s*\)\]/, hint: '旧统配已废止 → 用 [case(else)]' },
  { re: /^\s*\d+(?:\.\d+)*\.\s*\[call\]\s/m, hint: '旧 call 形态 [call] id : 描述 → 用 [call id(输入映射)] 描述' },
  // 涂鸦区相对路径反模式（2026-08-20 实撞:落到用户工作区根下裸目录,body 直执父目录缺失 ENOENT 秒败）
  { re: /path:\s*["']work_zone\//, hint: '涂鸦区相对路径 "work_zone/…" → 用 work_zone_path("名") 取引擎涂鸦区绝对路径' },
];

function* walkSpecs(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { yield* walkSpecs(p); continue; }
    if (!name.endsWith('.md') || SKIP_NAMES.has(name)) continue;
    yield p;
  }
}

const targets = [];
for (const base of ['examples', 'scripts/audit', 'scripts/deep-validate', 'scripts/hopfix']) {   // 扩面 2026-09-02 重做:初版随 dc944874 串批事故丢失(message 承诺了实体蒸发,三份 spec 闸外裸奔毒句实证)——本次入库并配 guard 测试例锁清单防再丢
  const dir = join(ROOT, base);
  if (existsSync(dir)) targets.push(...walkSpecs(dir));
}
// skills/ 面收"首行 # Spec: 头"的文件（2026-08-21 判据升级——原恒名 spec.md 漏掉 expand-node.md/
// split-node.md 等非恒名真 spec,release 闸外裸奔;首行判不误伤教学件:2026-08-15 误伤根因是多行
// 正则命中围栏内示例 `# Spec:` 行,首行判无此病;知识件/壳/primer 首行非 # Spec: 天然跳过）
// @a: anc-build-layout
if (existsSync(join(ROOT, 'skills'))) {
  for (const p of walkSpecs(join(ROOT, 'skills'))) {
    const firstLine = readFileSync(p, 'utf-8').split('\n', 1)[0];
    if (firstLine.startsWith('# Spec:')) targets.push(p);
  }
}

// ③ 文档行文扫描面（2026-08-13 作者定"扩"——旧术语在设计/教程/概念行文里繁殖,spec 面守卫扫不到）：
// docs/ 全 md 黑名单逐行扫;行级豁免=废止告示类标记词（其本职就是提旧写法）;rounds/ 整目录豁免（讨论存档）。
const PROSE_EXEMPT = /将废止|废除|废止|兼容读|黑名单|旧写法|旧修饰|兼容判据|过渡期/;
function* walkDocs(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'rounds') continue;   // 讨论存档不改正文
      yield* walkDocs(p); continue;
    }
    if (name.endsWith('.md')) yield p;
  }
}

let failed = 0;
const docsDir = join(ROOT, 'docs');
if (existsSync(docsDir)) {
  for (const file of walkDocs(docsDir)) {
    const rel = file.slice(ROOT.length + 1);
    const lines = readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (PROSE_EXEMPT.test(lines[i])) continue;
      for (const { re, hint } of LEGACY) {
        // call 形态正则带 ^…m 行锚,对单行测试直接适用
        if (re.test(lines[i])) {
          console.error(`❌ ${rel}:${i + 1} 行文含旧写法: ${hint}`);
          failed++;
        }
      }
    }
  }
}

for (const file of targets) {
  const rel = file.slice(ROOT.length + 1);
  const text = readFileSync(file, 'utf-8');
  // 非 spec 的 md（无 # Spec: 头）跳过 validate 与黑名单
  if (!/^(<!--[\s\S]*?-->\s*)?# Spec:/m.test(text)) continue;

  // ③(前置) doc-ref 切片锚存在性（同目录被引文件的章节标题须真在——hopbuild primer 改节名即断锚,
  // 原靠运行期 P15 才炸/人工 grep 核对;知识件头注'节标题是切片锚不可改名'的机检半边）。
  // 只核同目录相对引用（跨目录/含 hop_env 占位的归 P15 运行期）。// @a: anc-build-knowledge
  for (const m of text.matchAll(/\[\[([^\]#|]+)#([^\]|]+)\]\]/g)) {
    const [, doc, section] = m;
    if (doc.includes('/') || doc.includes('{')) continue;   // 跨目录/占位归 P15
    const docPath = join(file, '..', doc.endsWith('.md') ? doc : doc + '.md');
    if (!existsSync(docPath)) {
      console.error(`❌ ${rel} doc-ref 被引文件缺席: [[${doc}#${section}]]`);
      failed++;
      continue;
    }
    const docText = readFileSync(docPath, 'utf-8');
    const heads = new Set([...docText.matchAll(/^#{1,4} (.+)$/gm)].map(h => h[1].trim()));
    if (!heads.has(section.trim())) {
      console.error(`❌ ${rel} doc-ref 切片锚断裂: [[${doc}#${section}]]——${doc} 无此章节标题（节标题是切片锚,改名须同步引用方）`);
      failed++;
    }
  }

  // ① validate
  try {
    const out = execFileSync(process.execPath, [join(CLI_HOME, 'dist', 'cli.js'), '--json', 'validate', file], { encoding: 'utf-8' });
    const r = JSON.parse(out);
    if (r.status !== 'ok') {
      console.error(`❌ ${rel} validate: ${r.errors.map(e => `${e.rule} ${e.message}`).join('; ').slice(0, 200)}`);
      failed++;
      continue;
    }
  } catch (e) {
    console.error(`❌ ${rel} validate 进程失败: ${e.message.slice(0, 120)}`);
    failed++;
    continue;
  }

  // ② 旧写法黑名单
  for (const { re, hint } of LEGACY) {
    if (re.test(text)) {
      console.error(`❌ ${rel} 含旧写法: ${hint}`);
      failed++;
    }
  }

}

// ③ hopbuild2 专项断言（D72②/D73② 回归锁,2026-09-02 工程链review-D72D73批补——面三变异实证:
// 词表词改坏 validate 纹丝不动、路径闸判定恒 false 化 validate 放行,两处语义此前零回归锁,
// 靠对话内手跑脚本与人眼当闸。从 spec 正文机械提取判定行,按 body 同款逻辑跑正反输入,
// 漏拦/误拦/提取不到均响亮红——提取失败静默跳过=锁形同虚设）。 // @a: anc-build-main-flow
{
  const hb2Path = join(ROOT, 'skills', 'hopbuild2', 'spec.md');
  // HOPJIT_CHECK_ROOT 替身仓库（guard 测试 fixture）无 hopbuild2——豁免跳过;真库缺席走 readFileSync 响亮炸
  // （existsSync 只在替身模式下当豁免判据:真库该文件缺席=分发件被删,断言层不静默放行）
  if (process.env['HOPJIT_CHECK_ROOT'] && !existsSync(hb2Path)) {
    // fixture 模式且无 hopbuild2:本段不适用,跳过（fixture 测的是通用 spec 语法面）
  } else {
  const hb2 = readFileSync(hb2Path, 'utf-8');

  // ③a 词表断言:提取 carrier_cons 行的全部子串模式,按 body 同款"词 in lower(条目)"判定
  const ccLine = hb2.split('\n').find(l => l.includes('carrier_cons = ['));
  if (!ccLine) {
    console.error('❌ hopbuild2 专项: spec.md 找不到 carrier_cons 行——词表被移除或改形态,回归锁锚不到,须同步本断言');
    failed++;
  } else {
    const words = [...ccLine.matchAll(/"([^"]+)" in lower\(str\(c\)\)/g)].map(m => m[1]);
    const hitBy = (cons) => words.some(w => cons.toLowerCase().includes(w));
    const poison = [
      '同轮无依赖的审查员必须并行发射（run_in_background: true），不得串行执行',
      '用 Task 工具派发子任务',
      '用Task工具派活',
      '必须用 AskUserQuestion 与用户确认',
      '派 SubAgent 执行单一视角评审',
      '用 Agent 工具起后台审查员',
      '经Agent工具派发',
      '完成后发射 Agent 汇总',
      '并行发射agent收集回执',
    ];
    const clean = [
      '同轮无依赖的审查员必须并行执行，不得串行',
      '用 web_search 工具检索至少 2 个关键词',
      '各调研方向须并行发起调研，全部完成后再进入下一步',
      '文档定位类型须经用户确认',
    ];
    // 九子串正典（D74② 设计口径的机械化——两处词表各自与此比,单侧漂移与同步删词皆红;
    // hopbuild2 载体词表变更时本清单同步改,权威=docs/design/hopbuild2.md D74②）
    const CARRIER_CANON = ['run_in_background', 'subagent', 'task 工具', 'task工具', 'agent 工具', 'agent工具', 'askuserquestion', '发射 agent', '发射agent'].sort().join(',');
    if ([...words].sort().join(',') !== CARRIER_CANON) { console.error(`❌ hopbuild2 专项: 对齐门词表与九子串正典不一致（实际: ${[...words].sort().join(',')} vs 正典: ${CARRIER_CANON}）——删词/改词须先改设计 D74② 再同步正典清单`); failed++; }
    if (words.some(w => w !== w.toLowerCase())) { console.error('❌ hopbuild2 专项: 词表模式含大写字符——比对经 lower(条目),大写模式永不命中（等于删词）'); failed++; }
    for (const p of poison) if (!hitBy(p)) { console.error(`❌ hopbuild2 专项: 毒句漏拦: ${p.slice(0, 40)}`); failed++; }
    for (const c of clean) if (hitBy(c)) { console.error(`❌ hopbuild2 专项: 干净句误拦: ${c.slice(0, 40)}`); failed++; }
  }

  // ③b 路径闸断言:提取 1.2 的三判行,按 body 同款逻辑跑三输入
  const absLine = hb2.split('\n').find(l => l.includes('bad_abs ='));
  const dotsLine = hb2.split('\n').find(l => l.includes('bad_dots ='));
  if (!absLine || !dotsLine || !absLine.includes('startswith(skill_path, "/")') || !dotsLine.includes('".." in skill_path')) {
    console.error('❌ hopbuild2 专项: 路径闸判定行缺失或形态漂移（bad_abs 须 startswith(skill_path, "/")、bad_dots 须 ".." in skill_path）——判定被删/改形态,回归锁锚不到,须同步本断言');
    failed++;
  } else {
    // body 同款判定复现:绝对拒/越界拒/合法相对放行（在场性用本脚本自身文件模拟）
    const gate = (p, exists) => { const a = p.startsWith('/'); const d = p.includes('..'); return (!a && !d) ? exists : false; };
    if (gate('/Users/x/skill.md', true) !== false) { console.error('❌ hopbuild2 专项: 路径闸放过绝对路径'); failed++; }
    if (gate('../escape/skill.md', true) !== false) { console.error('❌ hopbuild2 专项: 路径闸放过含 .. 路径'); failed++; }
    if (gate('skills/sample/SKILL.md', true) !== true) { console.error('❌ hopbuild2 专项: 路径闸误拒合法相对路径'); failed++; }
  }

  // ③c 分拆通道载体语汇断言（D74②/hopissues 0065——split-structure 1.3 语法关的 carrier_lines
  // 词表,与 ③a 对齐门词表同源纪律:hop_python body 不能跨文件引用,两处各自内联,本断言双盯
  // 防漂移。毒句/干净句复用 ③a 判定形态——干净句含 [call ... parallel] 正形核不误伤）
  const ssPath = join(ROOT, 'skills', 'hopbuild2', 'split-structure.md');
  if (!existsSync(ssPath)) {
    console.error('❌ hopbuild2 专项: split-structure.md 缺失——0065 载体语汇兜底的载体文件不在,回归锁锚不到');
    failed++;
  } else {
    const ss = readFileSync(ssPath, 'utf-8');
    const clLine = ss.split('\n').find(l => l.includes('carrier_lines = ['));
    if (!clLine) {
      console.error('❌ hopbuild2 专项: split-structure.md 找不到 carrier_lines 行——0065 词表被移除或改形态,须同步本断言');
      failed++;
    } else {
      const clWords = [...clLine.matchAll(/"([^"]+)" in lower\(l\)/g)].map(m => m[1]);
      const CARRIER_CANON2 = ['run_in_background', 'subagent', 'task 工具', 'task工具', 'agent 工具', 'agent工具', 'askuserquestion', '发射 agent', '发射agent'].sort().join(',');
      if ([...clWords].sort().join(',') !== CARRIER_CANON2) { console.error(`❌ hopbuild2 专项: 分拆通道词表与九子串正典不一致（实际: ${[...clWords].sort().join(',')} vs 正典: ${CARRIER_CANON2}）——删词/改词须先改设计 D74② 再同步正典清单`); failed++; }
      if (clWords.some(w => w !== w.toLowerCase())) { console.error('❌ hopbuild2 专项: 分拆通道词表含大写模式——比对经 lower(l),大写永不命中（等于删词）'); failed++; }
      // 与 ③a 对齐门词表集合一致性（同源纪律的机械化——任一处删词/改词即两集不等）
      const ccLine2 = hb2.split('\n').find(l => l.includes('carrier_cons = ['));
      if (ccLine2) {
        const ccWords = [...ccLine2.matchAll(/"([^"]+)" in lower\(str\(c\)\)/g)].map(m => m[1]).sort().join(',');
        const clSorted = [...clWords].sort().join(',');
        if (ccWords && ccWords !== clSorted) {
          console.error(`❌ hopbuild2 专项: 两处载体词表集合不一致（对齐门: ${ccWords} vs 分拆通道: ${clSorted}）——同源纪律失守,改词须两处同步`);
          failed++;
        }
      }
      // 毒句/干净句判定复现(body 同款: 词 in lower(行))
      const hitLine = (line) => clWords.some(w => line.toLowerCase().includes(w));
      const poison = ['27. [act free] 四层递进强制触发并行发射审查员 run_in_background: true', '发射 Agent 收集回执', '用 Task 工具派活', '用Task工具派活', '等待 subagent 全部完成', '经 AskUserQuestion 确认', '用 Agent 工具起后台成员', '经Agent工具逐个派发', '并行发射agent不等回执'];
      const clean = ['27. [call reviewer(指令: 卡) parallel] 派发审查员', '并行执行,不得串行', '收齐后串行 [call 汇总(...)]', '2. [reason] 分析材料'];
      for (const pLine of poison) { if (!hitLine(pLine)) { console.error(`❌ hopbuild2 专项: 分拆通道词表漏拦毒句: ${pLine}`); failed++; } }
      for (const cLine of clean) { if (hitLine(cLine)) { console.error(`❌ hopbuild2 专项: 分拆通道词表误伤干净句: ${cLine}`); failed++; } }
    }
  }

  // ③d 0062 半边+消费接线+B7 跨层同源断言（D74①/hopissues 0062,2026-09-02 工程链 review 面三
  // 变异实证补——free_warns 计数/判据/指路三处此前删任一机检全绿（0062 半边整体裸奔）,
  // syntax_ok 不消费 carrier_lines 亦全绿（词表完好防线已断）;'也未标 free' 子串跨层耦合
  // 引擎 B7 warn 文案,润色文案即 free_warns 恒 0 静默复发。TRACEABILITY 卡 anc-guard-hb2-carrier）
  {
    // 0062 半边三处在场（spec.md）
    const cntLine = hb2.split('\n').find(l => l.includes('free_warns = len('));
    if (!cntLine || !cntLine.includes('也未标 free')) {
      console.error("❌ hopbuild2 专项: spec.md free_warns 计数行缺失或不含判据子串'也未标 free'——0062 合法关计数被删/改形态");
      failed++;
    }
    const legalOkLine = hb2.split('\n').find(l => l.includes('legal_ok ='));
    if (!legalOkLine || !legalOkLine.includes('free_warns == 0')) {
      console.error("❌ hopbuild2 专项: spec.md legal_ok 行缺失或不含 'free_warns == 0'——0062 合法关判据被删,act-free 警告重新放行");
      failed++;
    }
    const legalNoteLine = hb2.split('\n').find(l => l.includes('legal_note ='));
    if (!legalNoteLine || !legalNoteLine.includes('[act free]')) {
      console.error("❌ hopbuild2 专项: spec.md legal_note 行缺失或不含 '[act free]' 指路——0062 打回反馈失去修法指引");
      failed++;
    }
    // 0065 消费接线（split-structure.md）
    if (existsSync(ssPath)) {
      const ss2 = readFileSync(ssPath, 'utf-8');
      const soLine = ss2.split('\n').find(l => l.includes('syntax_ok ='));
      if (!soLine || !soLine.includes('len(carrier_lines) == 0')) {
        console.error("❌ hopbuild2 专项: split-structure.md syntax_ok 行缺失或不含 'len(carrier_lines) == 0'——0065 词表在场但判定不消费,防线已断");
        failed++;
      }
    }
    // B7 文案跨层同源（src/validator.ts）
    const validatorPath = join(ROOT, 'src', 'validator.ts');
    if (existsSync(validatorPath)) {
      const vsrc = readFileSync(validatorPath, 'utf-8');
      if (!vsrc.includes('也未标 free')) {
        console.error("❌ hopbuild2 专项: src/validator.ts B7 warn 文案不再含'也未标 free'——spec.md free_warns 判据子串跨层耦合该文案,润色文案须两处同步（spec.md 5.1.3.1.3 计数行判据一起改）,否则 free_warns 恒 0、0062 病静默复发");
        failed++;
      }
    } else if (!process.env['HOPJIT_CHECK_ROOT']) {
      console.error('❌ hopbuild2 专项: src/validator.ts 缺失——B7 跨层同源断言锚不到');
      failed++;
    }
  }

  // ③e D75 深度闸断言（2026-09-03 工程链 review 面三变异实证补——split-structure 1.3 深度判定行
  // 改坏〔恒 false 化〕后 check:fast/spec-syntax/全量三道全绿零拦,深度闸此前零机检保护。
  // 三半边同锁:判定公式在场且形态未漂移+超限反馈指路在场+递归 call 透传 sub_depth 在场,
  // 缺任一响亮红——公式在但反馈没了=拦了不说为什么,公式在但不透传=子层深度恒从头算,闸名存实亡）
  if (existsSync(ssPath)) {
    const ssD = readFileSync(ssPath, 'utf-8');
    // 判定公式行:deep_lines 须含绝对深度公式 depth + len(split(...)) - 1 > max_depth 全形,
    // 且比较式收在 max_depth] 行尾——防"公式子串还在但尾部追加 + 999 恒 false 化"逃逸
    // （变异重放实证:纯 includes 断言被 '> max_depth + 999' 骗过,追加式改坏必须锚比较式收尾）
    const dlLine = ssD.split('\n').find(l => l.includes('deep_lines ='));
    if (!dlLine || !dlLine.includes('depth + len(split(cand_nums[i], ".")) - 1 > max_depth')
        || !/>\s*max_depth\]\s*$/.test(dlLine)) {
      console.error('❌ hopbuild2 专项: split-structure.md deep_lines 深度判定行缺失或公式形态漂移（须含 depth + len(split(cand_nums[i], ".")) - 1 > max_depth 且比较式收在 max_depth] 行尾——尾部追加运算=判定被改坏）——D75 深度闸半边被动——先改设计 hopbuild2.md D75 再同步');
      failed++;
    } else {
      // body 同款判定复现:绝对深度=本层深+步骤号段数-1,超 max_depth(3) 拦、恰在界内放行
      const deep = (depth, num, maxDepth) => depth + num.split('.').length - 1 > maxDepth;
      if (deep(1, '2.1.1.1', 3) !== true) { console.error('❌ hopbuild2 专项: D75 深度闸放过第 4 层步骤行（depth=1 + 四段号）——先改设计 hopbuild2.md D75 再同步'); failed++; }
      if (deep(3, '5', 3) !== false) { console.error('❌ hopbuild2 专项: D75 深度闸误拦恰在第 3 层的顶层行（depth=3 + 单段号）——先改设计 hopbuild2.md D75 再同步'); failed++; }
      if (deep(2, '1.2.3', 3) !== true) { console.error('❌ hopbuild2 专项: D75 深度闸放过 depth=2 + 三段号的第 4 层行——先改设计 hopbuild2.md D75 再同步'); failed++; }
    }
    // syntax_ok 消费接线:公式在场但判定不吃 deep_lines=防线已断
    const soLineD = ssD.split('\n').find(l => l.includes('syntax_ok ='));
    if (!soLineD || !soLineD.includes('len(deep_lines) == 0')) {
      console.error("❌ hopbuild2 专项: split-structure.md syntax_ok 行缺失或不含 'len(deep_lines) == 0'——D75 深度闸半边被动（公式在场但判定不消费）——先改设计 hopbuild2.md D75 再同步");
      failed++;
    }
    // 超限反馈指路在场:拦下后须告诉分拆 LLM 修法
    if (!ssD.includes('深度上限')) {
      console.error("❌ hopbuild2 专项: split-structure.md 不含'深度上限'超限反馈文案——D75 深度闸半边被动（拦了不指路）——先改设计 hopbuild2.md D75 再同步");
      failed++;
    }
    // 递归 call 透传:子实例须收到父层算好的 sub_depth,否则子层深度恒从头算、闸名存实亡
    if (!ssD.includes('depth: sub_depth')) {
      console.error("❌ hopbuild2 专项: split-structure.md 递归 call 不再透传 depth: sub_depth——D75 深度闸半边被动（子层深度恒从头算）——先改设计 hopbuild2.md D75 再同步");
      failed++;
    }
  }
  }
}

// ③f D83/D84 多文件保真四断言（工程链review-hb2补课批 2026-09-08 补——面三改坏实证:legal_kinds
// 删值/2.4 前缀补全判反/三词表删词/4.4 present_inputs 少写一个,四处改坏 validate 与本守卫全绿
// 零拦（其中前缀补全是 probe 实撞当场修的点,修复此前零回归锁）。正典权威=docs/design/hopbuild2.md
// D83①/D84①,删词改值须先改设计再同步本清单。TRACEABILITY 卡 anc-build-multifile-exec）
{
  const hb2Path2 = join(ROOT, 'skills', 'hopbuild2', 'spec.md');
  if (process.env['HOPJIT_CHECK_ROOT'] && !existsSync(hb2Path2)) {
    // fixture 替身仓库无 hopbuild2——豁免跳过
  } else {
  const hb2f = readFileSync(hb2Path2, 'utf-8');
  // ③f-1 legal_kinds 四值正典（2.3 台账形态核——删值即台账定性面静默收窄）
  const lkLine = hb2f.split('\n').find(l => l.includes('legal_kinds = ['));
  if (!lkLine) {
    console.error('❌ hopbuild2 专项: spec.md 找不到 legal_kinds 行——台账四值法被移除或改形态,须先改设计 D83① 再同步本断言');
    failed++;
  } else {
    const kinds = [...lkLine.matchAll(/"([^"]+)"/g)].map(m => m[1]).sort().join(',');
    const KINDS_CANON = ['流程性', '参考性', '混合', '未引用'].sort().join(',');
    if (kinds !== KINDS_CANON) { console.error(`❌ hopbuild2 专项: legal_kinds 与四值正典不一致（实际: ${kinds} vs 正典: ${KINDS_CANON}）——删值/改值须先改设计 D83① 再同步`); failed++; }
  }
  // ③f-2 2.4 前缀补全形态（probe 实撞修复点:包内相对路径必须机械补 skill 目录前缀,判反即 ENOENT 复发）
  const pfLine = hb2f.split('\n').find(l => l.includes('flow_files = ['));
  if (!pfLine || !pfLine.includes('p if startswith(p, dir_prefix) else dir_prefix + p')) {
    console.error('❌ hopbuild2 专项: spec.md 2.4 前缀补全行缺失或形态漂移（须含 p if startswith(p, dir_prefix) else dir_prefix + p——判反/删除即 probe 实撞的 ENOENT 复发）——先改设计 D83① 再同步');
    failed++;
  }
  const rfLine = hb2f.split('\n').find(l => l.includes('ref_assets = ['));
  if (!rfLine || !rfLine.includes('dir_prefix + p')) {
    console.error('❌ hopbuild2 专项: spec.md ref_assets 前缀补全行缺失或形态漂移——参考性清单路径不归一,交付随包按它取件必空');
    failed++;
  }
  // ③f-3 三词表正典（中英双语,D95③ 英文扩员;5.1.3.1.1 action_ledger 抽取——删词即动作句台账静默变薄,漏抽的动作蒸发无人查）
  const wordCanon = (line, canon, label) => {
    if (!line) { console.error(`❌ hopbuild2 专项: spec.md 找不到 ${label} 词表行——D84① 抽取词表被移除,须先改设计再同步`); failed++; return; }
    const ws = [...line.matchAll(/"([^"]+)"/g)].map(m => m[1]).sort().join(',');
    if (ws !== canon.sort().join(',')) { console.error(`❌ hopbuild2 专项: ${label} 词表与正典不一致（实际: ${ws}）——删词/改词须先改设计 D84① 再同步`); failed++; }
  };
  wordCanon(hb2f.split('\n').find(l => l.includes('deliver_words = [')), ['写入', '保存', '落盘', '发送', '提交', '部署', '删除', '发布', '输出到', 'write', 'save', 'send', 'submit', 'deploy', 'delete', 'publish', 'commit', 'create the file', 'output to'], 'deliver_words');
  wordCanon(hb2f.split('\n').find(l => l.includes('gate_words = [')), ['必须', '不得', '才能', '方可', '禁止', '之前不', 'must', 'never', 'only after', 'do not', "don't", 'required before', 'cannot', 'forbidden'], 'gate_words');
  wordCanon(hb2f.split('\n').find(l => l.includes('notify_words = [')), ['通知', '告知', '上报', 'notify', 'alert', 'report to', 'escalate'], 'notify_words');
  // ③f-3b 匹配式 lower 归一（D95③——英文句首大写逃逸子串匹配,删 lower 即英文词表半失效）
  const hitLine = hb2f.split('\n').find(l => l.includes('hit_rows = ['));
  if (!hitLine || !hitLine.includes('w in lower(l)')) {
    console.error('❌ hopbuild2 专项: spec.md 5.1.3.1.1 匹配行缺 lower 归一（须为 w in lower(l)——英文句首大写行将逃逸词表匹配,英文语料 action_ledger 变薄）——先改设计 D95③ 再同步');
    failed++;
  }
  // ③f-5 合理关判料时点（D96③——判官必须吃修错后的 recheck_result 与销项底册 issue_history;
  // ← 行回退成 health_report(修错前旧单)即幻影工单复发,丢 issue_history 即判官失忆挤牙膏复发）
  const srLine = hb2f.split('\n').find(l => l.startsWith('- ←') && l.includes('log_text') && l.includes('action_ledger'));
  if (!srLine || !srLine.includes('recheck_result') || !srLine.includes('issue_history') || srLine.includes('health_report')) {
    console.error('❌ hopbuild2 专项: spec.md 5.1.3.1.5 合理关 ← 行形态漂移（须含 recheck_result 与 issue_history、不含 health_report——判官吃修错前旧单=幻影工单,丢销项底册=判官失忆,两病 R3 验尸实锤）——先改设计 D96②③ 再同步');
    failed++;
  }
  // ③f-4 呈审面双变量（4.4 present_inputs 少写 aux_ledger=呈审面缺半边静默失效,P14 只拦写错名不拦少写）
  const piLine = hb2f.split('\n').find(l => l.includes('present_inputs=header_final'));
  if (!piLine || !piLine.includes('present_inputs=header_final,aux_ledger')) {
    console.error('❌ hopbuild2 专项: spec.md 4.4 呈审行缺失或 present_inputs 不含 aux_ledger——附属台账呈审面被删,人对齐时看不见二分定性,先改设计 D83③ 再同步');
    failed++;
  }
  }
}

// ④ hopfix 专项断言（工程链review-hopfix批 2026-09-02 补——面三变异实证:层一闸重放比对蒸发/
// commit 快照守卫删行,validate 双双纹丝不动,两处语义零回归锁全靠人眼。从 spec 正文机械提取
// 判定行核形态在场,提取失败响亮红不静默跳过）。 // @a: anc-build-main-flow
{
  const hfPath = join(ROOT, 'scripts', 'hopfix', 'hopfix.md');
  if (process.env['HOPJIT_CHECK_ROOT'] && !existsSync(hfPath)) {
    // fixture 替身仓库无 hopfix——豁免跳过(真库缺席走 readFileSync 响亮炸)
  } else {
  const hf = readFileSync(hfPath, 'utf-8');
  // ④a 层一闸重放比对行:gate1_ok 须含重放逐字节比对与 validate 双判
  const gateLine = hf.split('\n').find(l => l.includes('gate1_ok ='));
  if (!gateLine) {
    console.error('❌ hopfix 专项: 找不到 gate1_ok 判定行——层一闸被移除或改形态,回归锁锚不到,须同步本断言');
    failed++;
  } else if (!gateLine.includes('replay_text == draft_text') || !gateLine.includes('len(added_errs) == 0')) {
    console.error('❌ hopfix 专项: 层一闸判定形态漂移——gate1_ok 须含 replay_text == draft_text(拼装重放逐字节比对)与 len(added_errs) == 0(error 基线对照闸,A 案 2026-09-02:新增即拦既有不背锅,取代旧 err_n == 0 绝对闸——绝对闸在基线带病时结构性死锁,首实战 12 轮盲烧实撞)双判,缺任一=改动外零变化承诺失守');
    failed++;
  }
  // ④b commit 快照守卫行:guard = int(...) 异常拒写形态
  const snapLine = hf.split('\n').find(l => l.includes('guard = int(') && l.includes('snap_back != spec_text'));
  if (!snapLine) {
    console.error('❌ hopfix 专项: 找不到快照守卫行（guard = int(...) if snap_back != spec_text）——快照失败拒写防线被移除,写回失去回滚面保障');
    failed++;
  }
  }
}

if (failed > 0) {
  console.error(`\nSpec 语法检查失败 ${failed} 项——样例是教材,必须只写标准写法。`);
  process.exit(1);
}
console.log(`Spec syntax check passed.（examples+scripts+skills 全 spec validate 绿 + 零旧写法 + hopbuild2 词表/路径闸回归断言 + hopfix 层一闸/快照守卫回归断言）`);
