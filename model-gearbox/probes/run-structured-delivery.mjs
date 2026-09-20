#!/usr/bin/env node
// G5 结构化交付探针跑批——schema 复杂度阶梯(内容全给定,只考"按声明形态交付"的皮)。
// 用法: node model-gearbox/probes/run-structured-delivery.mjs --service <service_id> [--n 6] [--tiers t1..t6] [--out <dir>]
// 设计要点: 每题数据值在 prompt 里全给齐(内容零难度)——失败必然是形态失败,G5 与 G2 干净解耦。
//   六档阶梯按 schema 复杂度递增;T5 专埋 Ling 实撞死相考点(yaml 字段交成块标量字符串——
//   "内容对皮不对":值本身是合法 yaml 文本但包进了字符串,结构层判非对象即抓)。
// 判分机械三关: ①可解析 ②顶层键齐(不多不少) ③逐字段形态核(list 是 list/object 是 object/
//   标量类型对;yaml 字段的值必须是结构不是字符串——字符串值即使内容能二次解析也判"皮错"如实分记)。
// 产出: <out>/summary.yaml(逐档 pass/n+皮错率单列)+全部原始响应留档。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SERVICE = argOf('--service');
const N = parseInt(argOf('--n', '6'), 10);
const TIERS = argOf('--tiers', 't1,t2,t3,t4,t5,t6').split(',');
const OUT = argOf('--out', join(HERE, 'structured-delivery', `run-${SERVICE}-${new Date().toISOString().slice(0, 10)}`));
if (!SERVICE) { console.error('用法: --service <service_id> [--n 6] [--tiers t1..t6]'); process.exit(1); }

const cfg = yamlLoad(readFileSync(join(homedir(), '.hopjit', 'config.yaml'), 'utf-8'));
const provider = (cfg.providers ?? []).find(p => p.service_id === SERVICE);
if (!provider) { console.error(`service '${SERVICE}' 不在 providers 内`); process.exit(1); }
const KEY = process.env[provider.api_key_env];
if (!KEY) { console.error(`环境变量 ${provider.api_key_env} 未设置`); process.exit(1); }

// ── 六档考卷(数据值全给定;expect=形态断言树:'int'|'str'|'bool'|{obj:{...}}|{list:形态}|{yaml:true}) ──
// 声明区措辞与引擎 L4 输出声明同风格(HopSchema 注释形态)——测的就是引擎场景的皮。
const TIERS_DEF = {
  t1: {
    name: '平坦三标量',
    prompt: `按下面的输出声明交付数据。数据值:店名="莱西咖啡",本周目标销售额=26000(整数),是否连锁=否。

输出声明:
- shop_name: line  # 店名
- weekly_target: int  # 本周目标销售额
- is_chain: bool  # 是否连锁

直接输出 YAML,不要围栏,不要任何说明文字,第一行就是第一个键。`,
    expect: { shop_name: 'str', weekly_target: 'int', is_chain: 'bool' },
  },
  t2: {
    name: '六字段混型含多行',
    prompt: `按下面的输出声明交付数据。数据值:任务名="季度盘点",优先级=2(整数),负责人="王芳",预计小时=6.5(小数),已批准=是,备注原文如下(三行,逐字保留):
第一行:先清点主仓
第二行:再对账系统库存
第三行:差异超 3% 上报

输出声明:
- task_name: line  # 任务名
- priority: int  # 优先级
- owner: line  # 负责人
- est_hours: float  # 预计小时
- approved: bool  # 已批准
- note: text  # 备注(多行,用块标量 | 保留换行)

直接输出 YAML,不要围栏,不要任何说明文字。`,
    expect: { task_name: 'str', priority: 'int', owner: 'str', est_hours: 'float', approved: 'bool', note: 'str' },
  },
  t3: {
    name: '对象列表 5×4',
    prompt: `按下面的输出声明交付数据。五名成员数据:
1. 张伟,后端,8 年,在岗
2. 李娜,前端,5 年,在岗
3. 刘强,测试,3 年,休假
4. 陈静,运维,6 年,在岗
5. 赵磊,数据,4 年,离岗

输出声明:
- members: [Member]  # 成员清单(数组,每元素 Member 结构)
  Member 结构: name: line / role: line / years: int / active: bool(在岗=true)

直接输出 YAML,不要围栏。members 的值必须是真正的 YAML 数组(- name: … 条目),不是文字描述。`,
    expect: { members: { list: { name: 'str', role: 'str', years: 'int', active: 'bool' }, len: 5 } },
  },
  t4: {
    name: '三层嵌套+内层列表',
    prompt: `按下面的输出声明交付数据。项目"北斗改造":状态=进行中(active);预算:总额=120000(整数),已用=45000(整数),币种="CNY";里程碑两个:①"方案定稿",截止"2026-10-01",完成=是;②"联调完成",截止"2026-11-15",完成=否。

输出声明:
- project:  # 复合结构,字段下一层缩进展开
  - name: line
  - status: line
  - budget:  # 复合结构
    - total: int
    - used: int
    - currency: line
  - milestones: [Milestone]  # Milestone: title: line / due: line / done: bool

直接输出 YAML,不要围栏。嵌套层级必须是真实的 YAML 缩进结构,不是拼在字符串里。`,
    expect: { project: { obj: { name: 'str', status: 'str', budget: { obj: { total: 'int', used: 'int', currency: 'str' } }, milestones: { list: { title: 'str', due: 'str', done: 'bool' }, len: 2 } } } },
  },
  t5: {
    name: 'yaml 字段结构值(Ling 死相考点)',
    prompt: `按下面的输出声明交付数据。附属文件台账三件:
1. 路径 "docs/api.md",定性=参考性,处置="按需读取"
2. 路径 "scripts/check.py",定性=流程性,处置="并入构建视野"
3. 路径 "assets/logo.png",定性=未引用,处置="呈裁"

输出声明:
- ledger: yaml  # 附属文件台账(结构化数据——每件三键 path/定性/处置 的对象数组)
- total: int  # 台账件数

注意:ledger 声明的类型是 yaml(结构化数据)——它的值必须是真正的 YAML 结构(缩进的对象数组),**不是**把内容包进 "ledger: |" 块标量字符串里。直接输出 YAML,不要围栏。`,
    expect: { ledger: { yamlStruct: { list: { path: 'str', '定性': 'str', '处置': 'str' }, len: 3 } }, total: 'int' },
  },
  t6: {
    name: '多输出混排(结构+多行文本相邻)',
    prompt: `按下面的输出声明交付数据。判定结果=不通过(false);缺陷两条:①"步骤 3 缺输入声明"(严重度=高) ②"备注含裸数字"(严重度=低);整改说明原文(两行):
先补步骤 3 的输入声明
再把裸数字改成带单位形态

输出声明:
- passed: bool  # 判定
- defects: [Defect]  # 缺陷清单(Defect: desc: line / severity: line)
- advice: text  # 整改说明(多行块标量)

键与键连续排列,之间不夹散文。直接输出 YAML,不要围栏。`,
    expect: { passed: 'bool', defects: { list: { desc: 'str', severity: 'str' }, len: 2 }, advice: 'str' },
  },
};

async function call(prompt) {
  const headers = { 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  if (provider.auth === 'bearer') headers['Authorization'] = `Bearer ${KEY}`;
  else headers['x-api-key'] = KEY;
  const r = await fetch(`${provider.base_url}/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: provider.model, max_tokens: 16384, messages: [{ role: 'user', content: prompt }] }),
  });
  const body = await r.json();
  const text = (body.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text: text || `(空正文 stop_reason=${body.stop_reason})`, model: body.model ?? '(响应体缺 model 字段)' };
}

// 形态断言树递归核(返回 {ok, issues[], skinError})
function checkShape(val, expect, path, issues, flags) {
  const scalar = (v, t) => {
    if (t === 'int') return Number.isInteger(v);
    if (t === 'float') return typeof v === 'number';
    if (t === 'bool') return typeof v === 'boolean';
    if (t === 'str') return typeof v === 'string';
    return false;
  };
  if (typeof expect === 'string') {
    if (!scalar(val, expect)) issues.push(`${path}: 期望 ${expect} 实为 ${Array.isArray(val) ? 'list' : typeof val}`);
    return;
  }
  if (expect.yamlStruct) {
    // yaml 声明字段:值必须是结构。字符串值(即使内容可二次解析为合法结构)=皮错——Ling 死相本相
    if (typeof val === 'string') {
      flags.skinError = true;
      let inner = null;
      try { inner = yamlLoad(val); } catch { /* 内容也坏 */ }
      issues.push(`${path}: yaml 字段交成字符串${inner && typeof inner === 'object' ? '(内容可解析——纯皮错,块标量包结构)' : '(内容也不可解析)'}`);
      return;
    }
    checkShape(val, expect.yamlStruct, path, issues, flags);
    return;
  }
  if (expect.list) {
    if (!Array.isArray(val)) { issues.push(`${path}: 期望数组 实为 ${typeof val}`); if (typeof val === 'string') flags.skinError = true; return; }
    if (expect.len !== undefined && val.length !== expect.len) issues.push(`${path}: 期望 ${expect.len} 元素 实为 ${val.length}`);
    val.forEach((el, i) => {
      if (el === null || typeof el !== 'object') { issues.push(`${path}[${i}]: 元素非对象`); return; }
      for (const [k, t] of Object.entries(expect.list)) checkShape(el[k], t, `${path}[${i}].${k}`, issues, flags);
    });
    return;
  }
  if (expect.obj) {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) {
      issues.push(`${path}: 期望对象 实为 ${Array.isArray(val) ? 'list' : typeof val}`);
      if (typeof val === 'string') flags.skinError = true;
      return;
    }
    for (const [k, t] of Object.entries(expect.obj)) checkShape(val[k], t, `${path}.${k}`, issues, flags);
  }
}

function grade(text, expect) {
  const flags = { skinError: false };
  const fenced = text.trimStart().startsWith('```');
  const cleanStart = !fenced && /^[\w一-鿿]+\s*:/.test(text.trimStart());
  // 围栏剥离(围栏=违反"不要围栏"指令的皮病,fence 单列计数;剥后内容照判——区分"只披了围栏"与"结构真坏")
  let body = text;
  if (fenced) {
    const m = text.match(/```[a-z]*\n([\s\S]*?)```/);
    if (m) body = m[1];
  }
  let doc = null;
  try { doc = yamlLoad(body); } catch { /* 解析失败 */ }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { pass: false, parse: false, prose_prefix: !cleanStart, skin_error: false, issues: ['(整体不可解析为对象)'] };
  }
  const issues = [];
  const expKeys = Object.keys(expect), gotKeys = Object.keys(doc);
  for (const k of expKeys) if (!(k in doc)) issues.push(`缺键 ${k}`);
  for (const k of gotKeys) if (!expKeys.includes(k)) issues.push(`多键 ${k}`);
  for (const [k, t] of Object.entries(expect)) if (k in doc) checkShape(doc[k], t, k, issues, flags);
  return { pass: cleanStart && issues.length === 0, parse: true, prose_prefix: !cleanStart, fence: fenced, skin_error: flags.skinError, issues: fenced ? ['围栏包裹(违禁指令)', ...issues] : issues };
}

mkdirSync(OUT, { recursive: true });
const modelSeen = new Set();
const result = {};
for (const tier of TIERS) {
  const def = TIERS_DEF[tier];
  if (!def) { console.error(`未知档 ${tier}`); continue; }
  console.log(`[${tier.toUpperCase()} ${def.name}] ×${N}…`);
  const runs = [];
  for (let i = 1; i <= N; i++) {
    const { text, model } = await call(def.prompt);
    modelSeen.add(model);
    writeFileSync(join(OUT, `${tier}-${i}.txt`), text);
    const g = grade(text, def.expect);
    runs.push({ i, ...g });
    console.log(`  ${tier}-${i}: pass=${g.pass}${g.skin_error ? ' 皮错' : ''}${g.issues.length ? ' | ' + g.issues.slice(0, 2).join('/') : ''}`);
  }
  const passN = runs.filter(r => r.pass).length;
  const skinN = runs.filter(r => r.skin_error).length;
  const fenceN = runs.filter(r => r.fence).length;
  result[tier] = { name: def.name, pass: `${passN}/${N}`, skin_error: `${skinN}/${N}`, fence: `${fenceN}/${N}`, runs: runs.map(r => ({ i: r.i, pass: r.pass, skin: r.skin_error, fence: r.fence ?? false, issues: r.issues.slice(0, 4) })) };
}
const summary = {
  service: SERVICE, model_from_response: [...modelSeen], n_per_cell: N,
  date: new Date().toISOString().slice(0, 10),
  维度: 'G5 结构化交付——schema 复杂度阶梯(内容全给定零难度,失败必为形态失败;皮错=yaml/结构字段交成字符串,单列计数)',
  tiers: result,
};
writeFileSync(join(OUT, 'summary.yaml'), yamlDump(summary, { lineWidth: 200 }));
console.log('\n══ summary ══\n' + TIERS.map(t => `${t.toUpperCase()}:${result[t]?.pass ?? '-'}${result[t]?.skin_error !== '0/' + N ? '(皮错' + result[t]?.skin_error + ')' : ''}`).join('  ') + '\n产物: ' + OUT);
