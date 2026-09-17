#!/usr/bin/env node
// 教学供给面对账守卫（D93 防线一,^anc-build-teaching-sync——作者抓"知识供给缺口一直在打地鼠,
// 完全没有吸取教训"后立:可枚举事实的教学面是引擎注册面的手写副本,没有机械物问"写全了吗",
// 缺口只能靠真机烧钱发现。先例=内置函数 33 员九文档面对账后该族缺口停产,本守卫把"一次动作"
// 升格为常驻机检）。两个核对面:
//  A. 工具签名面——教学文档里的内置工具签名表逐件对 DefaultToolProvider.list() 的 input_schema
//     （工具名在场性+参数名逐个,引擎扩员/改名而教学没跟上当场红）;
//  B. 示例可验证面——教学文档里的 hop_python 示例段抽出跑参数名核（作者点名"重要的知识,示例也
//     非常重要"——教错的示例比不教破坏力更大;正文示例里的工具调用参数名必须真实存在）。
// 依赖缺失显式失败,不静默跳过（^anc-meta-guard-trust）。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const distTools = join(ROOT, 'dist', 'tools.js');
if (!existsSync(distTools)) {
  console.error('❌ teaching-sync: dist/tools.js 缺失——先 npm run build（守卫需要引擎注册面真身,不许拿手抄名单对账）');
  process.exit(1);
}
const { DefaultToolProvider } = await import(distTools);
const provider = new DefaultToolProvider({ workspace_dir: ROOT, sandbox: { runtime: {} } });
const registry = new Map();
for (const t of provider.list()) {
  registry.set(t.name, new Set(Object.keys(t.input_schema?.properties ?? {})));
}
// 通知件与 subprocess.run（注册面外的恒可用件,签名手册见 tools-notify.ts 与 act-body 设计）
registry.set('dingtalk_notify', new Set(['text', 'title', 'at_mobiles']));
registry.set('notify', new Set(['text', 'title', 'at_mobiles']));
registry.set('subprocess.run', new Set(['input', 'timeout', 'cwd']));

// 教学供给面清单（工具签名成表或示例密集的知识文档——扩新教学文档时在此登记）
const TEACHING_FILES = [
  'skills/hopbuild2/split-patterns.md',
  'scripts/deep-validate/deep-validate-knowledge.md',
];

let failed = 0;

// A. 签名表核:markdown 表格行 `| \`tool\` | \`args\` |` 形态——抽工具名与签名列参数名
for (const rel of TEACHING_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { console.error(`❌ teaching-sync: 教学文件缺失 ${rel}（清单登记了但盘上没有——改名/移动须同步本守卫清单）`); failed++; continue; }
  const text = readFileSync(p, 'utf-8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\|\s*`(\w+)`\s*\|\s*`?([^|]+?)`?\s*\|/);
    if (!m) continue;
    const tool = m[1];
    if (!registry.has(tool)) continue;   // 非工具行(表格里的别的条目)不判
    const legal = registry.get(tool);
    // 签名列抽参数名:只认该工具调用括号内的 `name:` 具名形态（示意变量值/字段访问/裸参数清单不判——
    // 首跑 5 处全误报:示意值 c/o/n 与 r.exists 字段被当参数,抽取面收窄到调用位真参数名）
    const sigText = m[2];
    const callM = sigText.match(new RegExp(`\\b${tool}\\(([^)]*)\\)`));
    if (!callM) continue;   // 签名列无调用形态(纯参数清单行)——A 面只核调用形态,清单形态归人工
    const names = [...callM[1].matchAll(/(?<![:\w.])(\w+)\s*:/g)].map(x => x[1]);
    const unknown = names.filter(n => !legal.has(n));
    if (unknown.length) {
      console.error(`❌ teaching-sync[A]: ${rel}:${i + 1} 工具 ${tool} 签名表参数 ${unknown.join('/')} 不在注册面（合法: ${[...legal].join('/')}）`);
      failed++;
    }
  }
}

// B. 示例段核:```hop_python 围栏内的工具调用参数名（教学示例教错=每个读者复制一次错误）
for (const rel of TEACHING_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;   // A 面已报
  const text = readFileSync(p, 'utf-8');
  const fences = [...text.matchAll(/```hop_python\n([\s\S]*?)```/g)];
  for (const f of fences) {
    const body = f[1].replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');   // 剥字符串防误报
    for (const tool of registry.keys()) {
      const callRe = new RegExp(`\\b${tool.replace('.', '\\.')}\\(([^)]*)\\)`, 'g');
      for (const c of body.matchAll(callRe)) {
        const given = [...c[1].matchAll(/(?<![:\w])(\w+)\s*:/g)].map(x => x[1]);
        const legal = registry.get(tool);
        const unknown = given.filter(n => !legal.has(n));
        if (unknown.length) {
          const lineNo = text.slice(0, text.indexOf(c[0])).split('\n').length;
          console.error(`❌ teaching-sync[B]: ${rel}:${lineNo} 示例调用 ${tool}(${unknown.join(':')}...) 参数名不在注册面（合法: ${[...legal].join('/')}）`);
          failed++;
        }
      }
    }
  }
}

if (failed) {
  console.error(`teaching-sync 共 ${failed} 处教学面与注册面失同源。`);
  process.exit(1);
}
console.log('Teaching-sync check passed.（教学签名表+示例参数名与引擎注册面同源）');
