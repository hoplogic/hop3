#!/usr/bin/env node
// 把仓库里带工程链标记的用户面文档清洗成 npm 包发布件。
// 行为权威=docs/design/release-engineering.md ^anc-release-tarball-self-contained（清单/九步清洗/替换机制/守卫）。
// @a: anc-release-tarball-self-contained
//
// 用法：
//   node scripts/build-pkgdocs.mjs --out <目录>    生成到指定目录,不碰源（守卫测试与人工核看）
//   node scripts/build-pkgdocs.mjs --in-place      备份源到 .pkgdocs-backup/ 后原地覆盖（prepack）
//   node scripts/build-pkgdocs.mjs --restore       从备份字节级恢复并删备份目录（postpack / 中断残留处置）
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname, relative, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// PKGDOCS_REPO / PKGDOCS_MANIFEST 两个环境变量只给守卫测试用：把脚本指到一个临时仓与临时清单跑失败路径（净度不过/备份残留）,真打包不设
const REPO = process.env.PKGDOCS_REPO ? resolve(process.env.PKGDOCS_REPO) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = process.env.PKGDOCS_MANIFEST ? resolve(process.env.PKGDOCS_MANIFEST) : join(REPO, 'scripts', 'pkgdocs-manifest.json');
const BACKUP_DIR = join(REPO, '.pkgdocs-backup');
const PURITY_WORDS_PATH = join(REPO, 'scripts', 'github-purity-words.txt');

export function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

// 净度验收七样 + NUL 第八样（设计第 9 步）——命中即失败,不许静默放行
const PURITY_PATTERNS = [
  ['@trace', /@trace/],
  ['^anc-', /\^anc-\w/],              // `^anc-*` 作为术语出现在语法参考正文（讲引擎渲染要剥掉什么）是合法的,只抓真锚名
  ['docs/design/', /docs\/design\//],
  ['[[', /\[\[[^\]]/],              // 空的 `[[]]` 是核心规范讲 doc-ref 语法本身,合法;只抓真双链
  ['todo/NNNN', /todo\/\d{4}/],
  ['hopissues/NNNN', /hopissues\/(?:[\w-]+\/)?\d{4}/],
  ['内部开发面', /内部开发面/],
];

function loadPurityWords() {
  if (!existsSync(PURITY_WORDS_PATH)) {   // 公开快照里该词表被剔除——明示后只跑八样,不静默（^anc-meta-guard-trust）
    if (!loadPurityWords.warned) { console.error('pkgdocs: 净度词表 scripts/github-purity-words.txt 缺席（公开快照形态）——只跑七样+NUL,不做词表核'); loadPurityWords.warned = true; }
    return [];
  }
  return readFileSync(PURITY_WORDS_PATH, 'utf-8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(w => new RegExp(w));
}

/** 文件名（去扩展名）→ 清单内相对路径,双链按文件名解析 */
function buildNameIndex(files) {
  const idx = new Map();
  for (const f of files) idx.set(basename(f).replace(/\.md$/, ''), f);
  return idx;
}

function relLink(fromFile, toFile) {
  let r = relative(dirname(fromFile), toFile).split('\\').join('/');
  if (!r.startsWith('.')) r = './' + r;
  return r.replace(/ /g, '%20');
}

/** 真锚名=至少两段（`^anc-step-call`）;`^anc-*`/`^anc-xxx`/`^anc-x` 这类单段占位是讲语法的示例,放过 */
const REAL_ANC = '\\^anc-[a-z0-9]+-[\\w-]*\\w';

/** 把围栏代码块与行内代码换成占位符,清洗只碰散文;结束后原样放回。净度验收用同一个函数剥代码区（stripCode）——两把尺必然同判。
 *  围栏按 CommonMark：只认行首（允许缩进与 `> ` 引用前缀）3 个以上同种反引号/波浪线开的行,同种且数量不少于开栏的行关栏;
 *  行内出现的 ``` 是普通文本（实撞：核心规范 L247 "` ```hop_python `" 翻转了正则状态机,其后半篇全未处理）。
 *  行内代码按反引号串配对（`code`、``含 ` 的 code``）。 */
function shieldCode(text) {
  const slots = [];
  const put = m => { slots.push(m); return `\u0000${slots.length - 1}\u0000`; };
  const lines = text.split('\n');
  const out = [];
  let fence = null;   // { ch, n, buf }
  for (const line of lines) {
    const m = /^(\s*(?:>\s*)*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      fence.buf.push(line);
      if (m && m[2][0] === fence.ch && m[2].length >= fence.n && /^\s*(?:>\s*)*[`~]+\s*$/.test(line)) {
        out.push(put(fence.buf.join('\n'))); fence = null;
      }
      continue;
    }
    if (m) { fence = { ch: m[2][0], n: m[2].length, buf: [line] }; continue; }
    out.push(line.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (mm) => mm.includes('\n') ? mm : put(mm)));
  }
  if (fence) out.push(fence.buf.join('\n'));   // 未关的围栏当散文
  const shielded = out.join('\n');
  const unshield = t => {
    // 只还原自己发出的序号;源文本里本来就有的 NUL（或撞形的 NUL+数字）不许被当占位符吞掉,也不许静默留在发布件里
    const r = t.replace(/\u0000(\d+)\u0000/g, (m, i) => (Number(i) < slots.length ? slots[Number(i)] : m));
    if (r.includes('\u0000')) throw new Error('build-pkgdocs 占位符还原不净（残留 NUL）——源文本含 NUL 字节,或围栏/行内代码配对有误');
    return r;
  };
  return { shielded, unshield };
}

/** 净度验收的散文区=同一把尺剥掉代码区后的文本（占位符一并去掉） */
export function stripCode(text) {
  return shieldCode(text).shielded.replace(/\u0000\d+\u0000/g, '');
}

/** 九步清洗（第 9 步验收在 cleanAll 里统一做）。导出供反例测试直接调用。 */
export function cleanDoc(src, fromFile, manifest) {
  const nameIdx = buildNameIndex(manifest.files);
  let s = src;

  // 步 1. 去 @trace 头块（文件首个 %% … %% 块,连同其后空行）
  s = s.replace(/^\s*%%\s*@trace[\s\S]*?%%\s*\n(\s*\n)?/, '');

  // 步 2. 真实工程链引用不分散文/代码,先于遮蔽全局处理（代码块注释里也会写 `^anc-config-model-engine` 锚点定义,HopAnt:327 实撞）：
  //  - 双链：目标片段是 #^anc- 或目标是清单内文件 → 真引用;`[[文档路径#章节名]]`/`[[faults.yaml#键]]`/`[[doc]]` 这类示例放过
  //  - 锚名：两段以上的真锚名删;`^anc-*`/`^anc-xxx` 占位放过
  //  - 设计层路径：`docs/design/x.md`
  s = s.replace(/(`+)?\[\[([^\]`]+)\]\]\1?/g, (m, bt, inner) => {
    const [target, alias] = inner.split('|');
    const [base, frag] = target.split('#');
    const name = basename(base).replace(/\.md$/, '');
    if (base === '' && frag && frag.startsWith('^anc-')) return '本文相关节';
    // 示例判据：目标是语法占位（含 {…} 模板、`文档路径`、`doc`、`.yaml` 键示例、`双链` 字样）且无锚片段 → 放过;其余是真引用
    const isExample = !(frag && frag.startsWith('^anc-')) && !nameIdx.has(name)
      && (/[{}]/.test(base) || /^(文档路径|doc|双链)$/.test(name) || /\.ya?ml$/.test(base));
    if (isExample) return m;
    const hit = nameIdx.get(name);
    const text = alias ?? name;
    if (hit) return `[${text}](${relLink(fromFile, hit)})`;
    return bt ? `${bt}${text}${bt}` : text;   // 反引号包的清单外双链退成反引号包的纯名字（保留代码形态,去掉双链）
  });
  s = s.replace(new RegExp(`(按|见|详见|权威见|权威)\\s*\`${REAL_ANC}\``, 'g'), '$1相关规范');
  s = s.replace(new RegExp(`[（(]\\s*\`?${REAL_ANC}\`?(\\s*[/、,，]\\s*\`?${REAL_ANC}\`?)*\\s*[)）]`, 'g'), '');   // 带不带反引号的（^anc-x）括注都整删（代码注释里也有）
  s = s.replace(new RegExp(`\\s*\`${REAL_ANC}\`(\\s*[/、,，]\\s*\`${REAL_ANC}\`)*`, 'g'), '');
  s = s.replace(/[ \t]+\^anc-[\w-]*\w(?=[ \t]*$|[ \t]*[：:])/gm, '');   // 锚点定义位（标题/粗体后,行尾或冒号前）不论几段都是真锚
  s = s.replace(new RegExp(`(见|详见|权威见|权威|按)\\s*${REAL_ANC}(\\s*[/、,，]\\s*${REAL_ANC})*`, 'g'), '$1本文相关节');
  s = s.replace(new RegExp(`[ \\t]*${REAL_ANC}(\\s*[/、,，]\\s*${REAL_ANC})*`, 'g'), '');
  s = s.split('\n').filter(line => {
    if (!/`(?:docs\/)?design\/[^`]*`/.test(line)) return true;
    const aside = /^(\s*[>\-|]|\s{2,})/.test(line) && /(开发者向|权威|详见|见)/.test(line);
    return !aside;
  }).join('\n');
  s = s.replace(/`(?:docs\/)?design\/[^`]*`/g, '源码仓设计文档');

  // 步 3. 遮蔽代码区——以下只碰散文
  const { shielded, unshield } = shieldCode(s);
  s = shielded;

  // 步 4. 去设计层残余引用：旁注行整删,其余片段改"源码仓设计文档"
  s = s.split('\n').filter(line => {
    if (!/docs\/design\//.test(line)) return true;
    const aside = /^(\s*[>\-|]|\s{2,})/.test(line) && /(开发者向|权威|详见|见)/.test(line);
    return !aside;
  }).join('\n');
  s = s.replace(/\[([^\]]*)\]\([^)]*docs\/design\/[^)]*\)/g, '$1');
  s = s.replace(/(?:docs\/)?design\/[\w./-]*\w/g, '源码仓设计文档');

  // 步 5. 去卡号与内部标注：所在括注整删,裸出现改"内部事项卡"
  const cardRe = /(todo|hopissues)\/(?:[\w-]+\/)?\d{4}|内部开发面|维护者内部面/;
  s = s.replace(/（[^（）]*?）/g, m => cardRe.test(m) ? '' : m);
  s = s.replace(/〔[^〔〕]*?〕/g, m => cardRe.test(m) ? '' : m);
  s = s.replace(/\(([^()]*?)\)/g, (m, inner) => cardRe.test(inner) ? '' : m);
  s = s.replace(/(todo|hopissues)\/(?:[\w-]+\/)?\d{4}/g, '内部事项卡');
  s = s.replace(/(内部开发面|维护者内部面)[，,、]?/g, '');

  // 步 5 续. 讲锚点自身的句子：'本锚点'是设计锚点术语,对外读者改'本节';'原 `^anc-x` 锚点在…原位保留；'整句删（讲的是包外文档的内部安排）
  s = s.replace(/本锚点/g, '本节');
  s = s.replace(/原\s*锚点在[^；;。]*[；;。]\s*/g, '');

  // 步 5 续. 不随包的内部文件名裸出现：TODO.md / CLAUDE.md / roadmap 改成通称
  s = s.replace(/\bTODO\.md\b/g, '内部待办清单').replace(/\bCLAUDE\.md\b/g, '内部工程约定').replace(/\broadmap\b/g, '路线图');

  // 步 6. 残句收尾：删除留下的"（与 等…）""（见）""（）"空括注与孤立分隔符
  s = s.replace(/[（(]\s*(?:见|详见|权威见|权威)?\s*[)）]/g, '');
  s = s.replace(/（与\s+等[^（）]*）/g, '');
  s = s.replace(/^(\s*>?\s*-\s*)([^\n]*?)\s+\/\s+—/gm, '$1$2 —');
  s = s.replace(/见\s+本文相关节/g, '见本文相关节');
  s = s.replace(/路线图\s+路线图/g, '路线图');

  // 步 7. 还原代码区
  s = unshield(s);

  // 步 8. 专项——00-新人导读：开发者系列整段收成一句（D 篇不进包,逐篇导读在包里全是死名字）
  if (basename(fromFile) === '00-新人导读.md') {
    s = s.replace(/^走\*\*生态开发者系列\*\*[^\n]*$/m, '开发 hop 引擎本身（改 `src/`、设计契约、driver 层）的开发者系列教程 D0-D12 随源码仓分发,不在本包内。');
  }

  // 步 8. 专项——README
  if (basename(fromFile) === 'README.md' && dirname(fromFile) === '.') {
    s = s.replace(/^> \*\*仓库形态\*\*[^\n]*\n(?:>[^\n]*\n)*\n?/m, '');
    s = s.replace(/^>\s*\n(?=## )/m, '');
    s = s.split('\n').filter(line => !(/^\|/.test(line) && /(todo\/|audits\/|CLAUDE\.md|内部工程约定|maintainers\/|RELEASING)/.test(line))).join('\n');
    s = s.replace(/\n## 开发与发版（维护者）[\s\S]*?(?=\n## )/, '\n');
  }

  // 收尾：连续三个以上空行压成两个
  s = s.replace(/\n{4,}/g, '\n\n\n');
  return s;
}

export function purityViolations(text) {
  const hits = [];
  // 行内代码与围栏代码块里的 `[[文档路径#章节]]`、`^anc-*` 是在讲语法本身,不是泄露——净度只看散文;剥代码区与清洗用同一把尺
  if (text.includes('\u0000')) hits.push('NUL');
  const prose = stripCode(text);
  for (const [label, re] of PURITY_PATTERNS) if (re.test(prose)) hits.push(label);
  for (const re of loadPurityWords()) if (re.test(text)) hits.push(`词表:${re.source}`);
  return hits;
}

/** 清洗清单全部文件,返回 Map<相对路径, 发布件文本>;任一净度不过即抛错 */
export function cleanAll(manifest, repo = REPO) {
  const out = new Map();
  const bad = [];
  for (const f of manifest.files) {
    const abs = join(repo, f);
    if (!existsSync(abs)) { bad.push(`${f}: 源文件不存在`); continue; }
    const cleaned = cleanDoc(readFileSync(abs, 'utf-8'), f, manifest);
    const v = purityViolations(cleaned);
    if (v.length) bad.push(`${f}: 净度未过 ${v.join(' / ')}`);
    out.set(f, cleaned);
  }
  if (bad.length) throw new Error('build-pkgdocs 净度验收失败,不写任何发布件：\n  ' + bad.join('\n  '));
  return out;
}

function writeTo(dir, docs) {
  for (const [f, text] of docs) {
    const p = join(dir, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listFiles(p)); else out.push(p);
  }
  return out;
}

export function inPlace(repo = REPO) {
  const backup = join(repo, '.pkgdocs-backup');
  if (existsSync(backup)) throw new Error(`${backup} 已存在——上一次 --in-place 未恢复,先跑 --restore`);
  const manifest = loadManifest();
  const docs = cleanAll(manifest, repo);   // 先全量清洗验收,再动盘——验收失败源一字未动
  for (const f of manifest.files) {
    const b = join(backup, f);
    mkdirSync(dirname(b), { recursive: true });
    copyFileSync(join(repo, f), b);
  }
  writeTo(repo, docs);
  return docs.size;
}

export function restore(repo = REPO) {
  const backup = join(repo, '.pkgdocs-backup');
  if (!existsSync(backup)) return 0;
  let n = 0;
  for (const b of listFiles(backup)) {
    const rel = relative(backup, b);
    copyFileSync(b, join(repo, rel));
    n++;
  }
  rmSync(backup, { recursive: true, force: true });
  return n;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--out') {
      if (!args[1]) throw new Error('--out 需要目录');
      const docs = cleanAll(loadManifest());
      writeTo(resolve(args[1]), docs);
      console.log(`pkgdocs: ${docs.size} 份发布件 → ${resolve(args[1])}`);
    } else if (args[0] === '--in-place') {
      console.log(`pkgdocs: 原地替换 ${inPlace()} 份（备份在 .pkgdocs-backup/,postpack 恢复）`);
    } else if (args[0] === '--restore') {
      console.log(`pkgdocs: 恢复 ${restore()} 份`);
    } else {
      console.error('用法: build-pkgdocs.mjs --out <目录> | --in-place | --restore');
      process.exit(2);
    }
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}
