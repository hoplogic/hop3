#!/usr/bin/env node
// extract-scaling 高档语料生成器——从结构化事实库合成文档,答案键自动派生。
// 规模双轴独立可调: --points N(核查点数) --pad-ratio R(稀释比:每点配 R 段无事实填充文——
//   同点数下拉高字节数,测"长文捞针"与"点密"两种难度形态)。
// 用法: node gen-corpus.mjs --tier xl --points 40 --pad-ratio 0.5 [--seed 7]
// 产出: doc-<tier>.md + doc-<tier>.key.yaml(match 锚自动带——生成器知道自己埋了什么)。
// 事实库: 五主题簇(航天/深海/糖代谢/城市交通/古代造纸),每簇 fact 与 inference 成对,
//   数字/年份/机构名做锚词(生成时可加扰动位防背题——同 seed 同卷)。
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump as yamlDump } from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TIER = argOf('--tier', 'xl');
const POINTS = parseInt(argOf('--points', '40'), 10);
const PAD = parseFloat(argOf('--pad-ratio', '0.5'));
const SEED = parseInt(argOf('--seed', '7'), 10);

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ── 事实模板库:每条 gen() 返回 {sentence, claim_gist, match, type, premises?} ──
// 数字由 seed 决定(扰动位),锚词=数字+专名——机械判分稳定。
const F = [];  // fact 模板
const I = [];  // inference 模板(每条绑定其前提 fact 的索引函数)

// 簇一:航天
F.push(() => { const y = ri(2019, 2024), n = ri(38, 62); return { s: `${y} 年全球共实施轨道发射 ${n * 10} 次，创当时历史新高。`, g: `${y} 年全球轨道发射 ${n * 10} 次`, m: [String(n * 10)], t: 'fact' }; });
F.push(() => { const p = ri(55, 75); return { s: `其中商业发射占比约 ${p}%，首次超过政府任务。`, g: `商业发射占比约 ${p}%`, m: [`${p}%`], t: 'fact' }; });
F.push(() => { const kg = ri(120, 180) * 100; return { s: `单次重型运载的近地轨道运力已达约 ${kg} 公斤。`, g: `重型运载近地轨道运力约 ${kg} 公斤`, m: [String(kg)], t: 'fact' }; });
I.push(() => { const y = ri(5, 15); return { s: `照此增速，业内普遍预计发射成本将在 ${y} 年内再降一半。`, g: `发射成本 ${y} 年内或再降一半`, m: ['成本', `${y} 年内`], t: 'inference', prem: '商业发射占比与发射次数增长' }; });

// 簇二:深海
F.push(() => { const d = ri(10900, 11000); return { s: `马里亚纳海沟最深处实测深度约 ${d} 米。`, g: `马里亚纳海沟最深约 ${d} 米`, m: [String(d)], t: 'fact' }; });
F.push(() => { const n = ri(20, 40); return { s: `目前全球具备全海深载人下潜能力的潜水器不足 ${n} 台。`, g: `全海深载人潜水器不足 ${n} 台`, m: [String(n), '潜水器'], t: 'fact' }; });
F.push(() => { const p = ri(80, 95); return { s: `深海海底约 ${p}% 的区域尚未进行高精度测绘。`, g: `深海约 ${p}% 未高精度测绘`, m: [`${p}%`, '测绘'], t: 'fact' }; });
I.push(() => { const w = pick(['矿产资源', '生物多样性', '地质构造', '微生物群落', '热液系统']); return { s: `这意味着深海${w}的家底评估仍缺乏可靠基础。`, g: `深海${w}家底评估缺乏可靠基础`, m: [w.slice(0, 2), '评估'], t: 'inference', prem: '大部分海底未高精度测绘' }; });

// 簇三:糖代谢
F.push(() => { const n = ri(4, 6); return { s: `世界卫生组织建议成年人每日游离糖摄入不超过总能量的 ${n * 5}%。`, g: `WHO 建议游离糖不超过总能量 ${n * 5}%`, m: ['世界卫生组织|WHO', `${n * 5}%`], t: 'fact' }; });
F.push(() => { const g = ri(30, 40); return { s: `一罐 330 毫升含糖汽水的糖含量约为 ${g} 克。`, g: `330 毫升含糖汽水约含糖 ${g} 克`, m: ['330', String(g)], t: 'fact' }; });
I.push(() => { const n = pick(['两', '三', '四']); return { s: `因此每天${n}罐汽水就可能令多数成年人超出建议上限。`, g: `每天${n}罐汽水或超糖摄入建议上限`, m: [`${n}罐`, '上限'], t: 'inference', prem: 'WHO 上限与单罐糖含量' }; });

// 簇四:城市交通
F.push(() => { const n = ri(28, 45); return { s: `该市地铁网络总里程于去年突破 ${n * 20} 公里。`, g: `地铁总里程突破 ${n * 20} 公里`, m: [String(n * 20), '公里'], t: 'fact' }; });
F.push(() => { const p = ri(42, 58); return { s: `公共交通出行分担率达到 ${p}%，同比提高三个百分点。`, g: `公交分担率达 ${p}%`, m: [`${p}%`, '分担率'], t: 'fact' }; });
F.push(() => { const n = ri(15, 25); return { s: `早高峰平均通勤时间缩短至 ${n + 30} 分钟。`, g: `早高峰平均通勤 ${n + 30} 分钟`, m: [String(n + 30), '通勤'], t: 'fact' }; });
I.push(() => { const w = pick(['道路拥堵', '通勤压力', '地面公交负荷', '私家车依赖', '停车缺口']); return { s: `可见轨道交通扩容对缓解${w}起到了实质作用。`, g: `轨交扩容实质缓解${w}`, m: [w.slice(0, 2)], t: 'inference', prem: '里程增长与通勤时间缩短' }; });

// 簇五:古代造纸
F.push(() => { const y = ri(3, 8); return { s: `考古发现将麻纸的使用历史前推至公元前 ${y} 十年左右。`, g: `麻纸使用史前推至公元前约 ${y}0 年`, m: ['麻纸', '公元前'], t: 'fact' }; });
F.push(() => { const n = ri(60, 90); return { s: `传统竹纸工艺全程需经约 ${n} 道工序。`, g: `传统竹纸约 ${n} 道工序`, m: [String(n), '工序'], t: 'fact' }; });
I.push(() => { const w = pick(['文献记载', '通行认知', '教科书叙述', '既有定论', '主流断代']); return { s: `这说明造纸术的成熟远比${w}的时间更早。`, g: `造纸术成熟早于${w}`, m: ['造纸', w.slice(0, 2)], t: 'inference', prem: '考古发现的年代前推' }; });

// 填充句库(零事实——稀释用:过渡/评论/背景,不含可查证断言)
const PADS = [
  '这一领域的讨论近年持续升温，各方观点不一。',
  '相关背景此处不再展开，读者可参阅综述文献。',
  '需要说明的是，不同口径的统计之间存在方法差异。',
  '接下来转入另一组话题。',
  '上述内容在业内已有多轮讨论。',
  '此处按下不表，先看另一组数据。',
  '这一趋势背后的机制仍有争论。',
  '为便于阅读，以下分小节呈现。',
];

// ── 合成:按 POINTS 循环抽模板(fact:inference ≈ 7:3),PAD 按比例穿插 ──
// 唯一性强制:同句重复=考卷失真(一句提取一次是正确行为,键挂两条则一提两中虚高)。
// 签名=句全文;重复即重掷(模板数字空间给机会),掷 30 次不出新弃该次抽取。
const sentences = [];
const key = [];
const seen = new Set();
let fi = 0, ii = 0, made = 0, guard = 0;
while (made < POINTS && guard < POINTS * 50) {
  guard++;
  const wantInf = made > 0 && made % 10 >= 7;   // 每 10 点约 3 个 inference
  const pool = wantInf ? I : F;
  const idx = wantInf ? ii++ : fi++;
  let item = null;
  for (let tryn = 0; tryn < 30; tryn++) {
    const cand = pool[idx % pool.length]();
    if (!seen.has(cand.s)) { item = cand; break; }
  }
  if (!item) continue;
  seen.add(item.s);
  sentences.push(item.s);
  const entry = { ref: `pt${made + 1}`, match: item.m, type: item.t, claim_gist: item.g };
  if (item.t === 'inference' && item.prem) entry.premises_if_inference = [item.prem];
  key.push(entry);
  made++;
  if (rand() < PAD) sentences.push(pick(PADS));
}
if (made < POINTS) { console.error(`模板空间不足:只生成 ${made}/${POINTS} 点——扩模板库或降 --points`); process.exit(1); }

const doc = `# 综合简报（生成语料 tier=${TIER} seed=${SEED}）\n\n${sentences.join('')}\n`;
const keyDoc = {
  '#说明': `生成语料答案键(gen-corpus.mjs seed=${SEED} points=${POINTS} pad-ratio=${PAD})——文档与键同源自动派生,改参数即换卷`,
  expected_total: POINTS,
  required: key,
};
writeFileSync(join(HERE, `doc-${TIER}.md`), doc);
writeFileSync(join(HERE, `doc-${TIER}.key.yaml`), yamlDump(keyDoc, { lineWidth: 200 }));
console.log(`doc-${TIER}.md: ${Buffer.byteLength(doc)} bytes, ${POINTS} points (密度 ${(POINTS / Buffer.byteLength(doc) * 1000).toFixed(1)} 点/KB)`);
