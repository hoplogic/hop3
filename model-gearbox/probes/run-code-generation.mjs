#!/usr/bin/env node
// G6 代码生成探针跑批——Python 与 SQL 两种语言,各简单/普通/复杂三档(题目在 code-generation/tasks/,一题一个 md 文件)。
// Python 题:一条规范条款,模型写一个 Python 校验脚本:从 sys.argv[1] 读待查文件,合规退出 0、违规退出 1。
//   执行环境就是引擎 run_script 的真实环境——脚本先过 Python 语法沙箱(dist/py-sandbox.js,与引擎同一份实现),
//   审过才执行;题面把沙箱白名单全列给模型(测的是写代码的能力,不是猜白名单的能力)。
// SQL 题:一个取数需求+表结构,模型写一条 SQLite 查询。每份测试数据建一个临时库(建表+插数),以只读方式打开后
//   执行模型的查询,结果集逐行逐列与期望比对(顺序敏感,列名不比)。SQLite 用 Node 自带的 node:sqlite。
// 用法: node model-gearbox/probes/run-code-generation.mjs --service <service_id> [--n 6] [--heal 2] [--task <id>[,<id>…]] [--out <dir>]
// 测法: 每题 n 发(缺省 6),每发独立会话:
//   第 1 轮=一次写对率的样本;若沙箱拒绝或公开样例判错,把拒绝报文/公开样例实跑结果反馈给模型再写,
//   最多再给 heal 轮(缺省 2)——最后一轮的脚本记为自愈后结果。
// 判分: 对 tests/<题>/ 下全部隐藏测试逐个实跑——Python 题文件名 ok_* 应退出 0、bad_* 应退出 1,
//   SQL 题每份 yaml 的结果集与 expect 全等;全部对上=该解通过。隐藏测试从不反馈给模型——自愈回路只看得见公开样例,与 sdc 规约步骤里
//   "模型自己写样例自己验"同构:公开样例过了但隐藏测试挂,就是"自验通过的校验在真实文件上失效"。
// 产出: <out>/summary.yaml(逐题一次写对率/自愈后通过率/失败形态)+全部原始响应与逐轮判分留档。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { runSandboxedPython } from '../../dist/py-sandbox.js';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'code-generation');
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SERVICE = argOf('--service');
const N = parseInt(argOf('--n', '6'), 10);
const HEAL = parseInt(argOf('--heal', '2'), 10);
const ONLY = argOf('--task');
const OUT = argOf('--out', join(ROOT, `run-${SERVICE}-${new Date().toISOString().slice(0, 10)}`));
const SELFCHECK = args.includes('--selfcheck');
// 输出上限 32768:首跑 deepseek 在 16384 下出过"思考烧光预算、正文为空"的截断——截断是预算问题不是写码能力,
// 上限放宽减少这种混入,残余截断在逐轮记录里单独记为 truncated,不与"没交代码"混记
const MAX_TOKENS = parseInt(argOf('--max-tokens', '32768'), 10);
if (!SERVICE && !SELFCHECK) { console.error('用法: --service <service_id> [--n 6] [--heal 2] [--task <id>] [--out <dir>] | --selfcheck'); process.exit(1); }
let provider, KEY;
if (!SELFCHECK) {
  const cfg = yamlLoad(readFileSync(join(homedir(), '.hopjit', 'config.yaml'), 'utf-8'));
  provider = (cfg.providers ?? []).find(p => p.service_id === SERVICE);
  if (!provider) { console.error(`service '${SERVICE}' 不在 providers 内`); process.exit(1); }
  KEY = process.env[provider.api_key_env];
  if (!KEY) { console.error(`环境变量 ${provider.api_key_env} 未设置`); process.exit(1); }
}

// --task 可给多个题 id,逗号分隔
const ONLY_IDS = ONLY ? ONLY.split(',').map(x => x.trim()) : null;
// 题目 = code-generation/tasks/<题id>.md,一题一个 markdown 文件(Obsidian 里可直接看)。文件结构:
//   开头 frontmatter 给 id / lang / level;"## 题目正文" 一节的全文就是 statement,原样发给模型;
//   SQL 题另有 "## 表结构" 一节,节内 ```sql 代码块是建表语句(题面与判分共用这一份)。
//   两节之外的文字(一级标题、引用块说明)是给人看的,不发给模型。缺节或 frontmatter 缺字段即报错退出,不静默跳过。
function sectionOf(body, title, file) {
  const m = body.match(new RegExp(`^## ${title}[ \\t]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  if (!m) { console.error(`${file} 缺 "## ${title}" 一节`); process.exit(1); }
  return m[1].trim();
}
function loadTasks() {
  const dir = join(ROOT, 'tasks');
  return listFiles(dir).filter(f => f.endsWith('.md')).map(f => {
    const text = readFileSync(join(dir, f), 'utf-8');
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fm) { console.error(`${f} 开头缺 frontmatter(--- 包住的 id/lang/level)`); process.exit(1); }
    const meta = yamlLoad(fm[1]);
    for (const k of ['id', 'lang', 'level']) if (!meta?.[k]) { console.error(`${f} 的 frontmatter 缺 ${k}`); process.exit(1); }
    if (`${meta.id}.md` !== f) { console.error(`${f} 的 frontmatter id=${meta.id} 与文件名不一致`); process.exit(1); }
    const body = text.slice(fm[0].length);
    const task = { ...meta, statement: sectionOf(body, '题目正文', f) };
    if (meta.lang === 'sql') {
      const sm = sectionOf(body, '表结构', f).match(/```sql\n([\s\S]*?)```/);
      if (!sm) { console.error(`${f} 的 "## 表结构" 一节里没有 \`\`\`sql 代码块`); process.exit(1); }
      task.schema = sm[1].trim();
    }
    return task;
  });
}
// 只收普通文件——目录里混进的隐藏目录(如工具副产物)不是测试文件
const listFiles = dir => readdirSync(dir).filter(f => !f.startsWith('.') && statSync(join(dir, f)).isFile()).sort();
const TASKS = loadTasks().filter(t => !ONLY_IDS || ONLY_IDS.includes(t.id));
if (TASKS.length === 0) { console.error(`题目 '${ONLY}' 不在 code-generation/tasks/ 内`); process.exit(1); }
const expectOf = f => (f.startsWith('bad') || /_bad\./.test(f) ? 1 : 0);
const SANDBOX_OPTS = { interpreter: 'python3', whitelist: ['python3'], timeoutSec: 60, maxBuffer: 65536 };

// 沙箱规则说明——与 scripts/pysb/pysb_check.py 三张白名单表同内容(改检查器白名单必须同步本段)
const SANDBOX_RULES = `脚本的运行环境有一个 Python 语法沙箱,脚本先被静态审查,审查通过才执行。规则:
- import 只能写 \`import 模块名\` 这一种形式(不许 from ... import,不许 as 改名),模块只能是 ast / re / json / sys;
  使用时写 模块.符号,可用的符号只有:ast.parse ast.walk ast.FunctionDef ast.AsyncFunctionDef ast.ClassDef ast.get_docstring ast.iter_child_nodes / re.match re.search re.findall re.sub re.split re.escape / json.loads json.dumps / sys.argv sys.exit sys.stderr;
- 可用的内置名只有:print len range int str float bool list dict set tuple enumerate sorted reversed sum min max any all abs zip map filter isinstance repr open Exception ValueError KeyError OSError SyntaxError;
- open 只能直接调用且只能用读模式('r' / 'rb' / 'rt' 或不写模式);
- 对象上能用的属性/方法只有:字符串、列表、字典、集合的常用方法(strip split splitlines join startswith endswith replace lower upper find count partition removeprefix append extend pop sort get keys values items add union 等)、文件对象的 read readline readlines close、正则匹配结果的 group groups start end span、以及 ast 语法树节点的字段(name lineno end_lineno body 等);
- 不许定义或访问下划线开头的名字(所以不能写 if __name__ == "__main__":,主逻辑直接写在模块顶层);不许重新绑定内置名或模块名(变量不要叫 list、str、re 这类名字)。`;

function buildPythonPrompt(task) {
  return `请写一个 Python 校验脚本,检查一个文件是否符合下面这条规范条款。

${task.statement.trim()}

脚本的接口要求:
- 从命令行参数 sys.argv[1] 取得待检查文件的路径,用 UTF-8 编码读这个文件的内容来判;
- 文件符合条款:退出码 0;文件违反条款:逐条打印违规位置(行号与原因),然后退出码 1;
- 你的脚本会被拿去检查很多不同的文件,不只是示例。

${SANDBOX_RULES}

最后把完整脚本放在一个 \`\`\`python 代码块里交付(只放一个代码块)。`;
}

async function call(messages) {
  const headers = { 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  if (provider.auth === 'bearer') headers['Authorization'] = `Bearer ${KEY}`;
  else headers['x-api-key'] = KEY;
  const r = await fetch(`${provider.base_url}/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: provider.model, max_tokens: MAX_TOKENS, messages }),
  });
  const body = await r.json();
  const text = (body.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, model: body.model ?? '(响应体缺 model 字段)', stop: body.stop_reason, error: body.error?.message };
}

const SQLITE_VERSION = new DatabaseSync(':memory:').prepare('SELECT sqlite_version() AS v').get().v;

function buildSqlPrompt(task) {
  return `请写一条 SQLite 查询(一条 SELECT 语句,可以用 WITH 子句),满足下面的取数需求。

表结构:
\`\`\`sql
${task.schema.trim()}
\`\`\`

${task.statement.trim()}

执行环境:SQLite ${SQLITE_VERSION},支持 WITH 子句、窗口函数(ROW_NUMBER、LAG 等)和日期函数(date、julianday 等)。
查询在只读数据库上执行,只交一条查询,不要建表、不要改数据。
你的查询会拿到很多份不同的数据上执行,不只是示例。

最后把完整查询放在一个 \`\`\`sql 代码块里交付(只放一个代码块)。`;
}

// 取最后一个带目标语言标签的代码块(没有语言标签的 ``` 块作兜底)
function extractCode(text, lang) {
  const tags = lang === 'sql' ? '(sql|sqlite)' : '(python|py)';
  const blocks = [...text.matchAll(new RegExp('```' + tags + '?[ \\t]*\\n([\\s\\S]*?)```', 'g'))];
  if (blocks.length === 0) return null;
  const tagged = blocks.filter(b => b[1]);
  return (tagged.length ? tagged : blocks).pop()[2];
}

// SQL 题:每份测试数据在临时目录里建库(建表+插数),关掉后以只读方式重开再执行模型的查询——只读打开保证
// 查询改不了数据;prepare 只编译第一条语句,查询后面夹带的语句不会执行。结果按列序取数组逐行逐列比对。
// 返回形态与 Python 题同构:{rejected:false, results:[{file, ok, error?, got?, want?}]}
function runSqlAgainst(query, schema, srcDir, files) {
  const dir = mkdtempSync(join(tmpdir(), 'hop-cg-sql-'));
  try {
    const results = [];
    for (const f of files) {
      const t = yamlLoad(readFileSync(join(srcDir, f), 'utf-8'));
      const dbPath = join(dir, f + '.db');
      const w = new DatabaseSync(dbPath);
      w.exec(schema);
      if (t.data) w.exec(t.data);
      w.close();
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const stmt = db.prepare(query);
        stmt.setReturnArrays(true);
        const got = stmt.all();
        const want = t.expect ?? [];
        const ok = JSON.stringify(got) === JSON.stringify(want);
        results.push({ file: f, ok, ...(ok ? {} : { got: JSON.stringify(got).slice(0, 400), want: JSON.stringify(want).slice(0, 400) }) });
      } catch (e) {
        results.push({ file: f, ok: false, crashed: true, error: String(e.message ?? e).slice(0, 300) });
      } finally { db.close(); }
    }
    return { rejected: false, results };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 在临时目录里放脚本+测试文件,逐个实跑。返回每个文件的 {file, expect, rc, ok}(沙箱拒绝时返回 rejected)
function runPyAgainst(code, srcDir, files) {
  const dir = mkdtempSync(join(tmpdir(), 'hop-cg-'));
  try {
    writeFileSync(join(dir, 'guard.py'), code);
    for (const f of files) copyFileSync(join(srcDir, f), join(dir, f));
    const results = [];
    for (const f of files) {
      let r;
      try { r = runSandboxedPython(join(dir, 'guard.py'), [f], SANDBOX_OPTS); }
      catch (e) { r = { status: 'error', message: String(e.message ?? e) }; }
      if (r.status === 'rejected') return { rejected: true, message: r.message };
      if (r.status === 'error') { results.push({ file: f, expect: expectOf(f), rc: null, ok: false, note: r.message.slice(0, 200) }); continue; }
      // 崩溃单独判:Python 未捕获异常同样退出 1,与"查到违规退出 1"在退出码上分不开——不单判的话,
      // 一个见文件就崩的脚本会在全部 bad_* 文件上白拿分。判据:stderr 有 Traceback,或退出码不是 0/1
      const crashed = /Traceback \(most recent call last\)/.test(r.stderr) || (r.returncode !== 0 && r.returncode !== 1);
      const ok = !crashed && r.returncode === expectOf(f);
      results.push({ file: f, expect: expectOf(f), rc: r.returncode, crashed, ok, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 600) });
    }
    return { rejected: false, results };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 按语言分派:测试文件清单、执行、公开样例文件
const hiddenFilesOf = task => listFiles(join(ROOT, 'tests', task.id));
const publicFilesOf = task => listFiles(join(ROOT, 'public')).filter(f => task.lang === 'sql' ? f === task.id + '.yaml' : f.startsWith(task.id + '_'));
const runAgainst = (task, code, dir, files) => task.lang === 'sql' ? runSqlAgainst(code, task.schema, dir, files) : runPyAgainst(code, dir, files);

function sqlFeedbackOf(pub) {
  const lines = pub.results.filter(r => !r.ok).map(r => r.error ? `- ${r.file}:查询执行报错:${r.error}` : `- ${r.file}:结果不对。期望 ${r.want},实际 ${r.got}`);
  return `你的查询用公开样例实跑的结果不对:\n${lines.join('\n')}\n\n请修正后交付完整查询(一个 \`\`\`sql 代码块)。`;
}

function feedbackOf(pub) {
  if (pub.rejected) return `你的脚本没有通过语法沙箱审查,没有执行。审查报文:\n${pub.message}\n\n请按报文改写后交付完整脚本(一个 \`\`\`python 代码块)。`;
  const lines = pub.results.map(r => `- ${r.file}:应退出 ${r.expect},实际退出 ${r.rc}${r.crashed ? '(脚本崩溃,见 stderr)' : ''}${r.stdout ? `;stdout: ${JSON.stringify(r.stdout.trim().slice(0, 200))}` : ''}${r.stderr ? `;stderr: ${JSON.stringify(r.stderr.trim().slice(0, 400))}` : ''}`);
  return `你的脚本用两个公开样例实跑的结果不对:\n${lines.join('\n')}\n\n请修正后交付完整脚本(一个 \`\`\`python 代码块)。`;
}

// 仪器自检(--selfcheck,零模型调用):参考解 reference/<题>.py 必须在全部隐藏测试与公开样例上退出码全对。
// 改题面、改测试文件、改沙箱白名单之后先跑它——参考解挂了说明仪器坏了,这时测出的模型分数没有意义。
async function selfcheck() {
  const all = loadTasks();
  let bad = 0;
  for (const task of all) {
    const code = readFileSync(join(ROOT, 'reference', `${task.id}.${task.lang === 'sql' ? 'sql' : 'py'}`), 'utf-8');
    for (const [dir, files] of [[join(ROOT, 'tests', task.id), hiddenFilesOf(task)], [join(ROOT, 'public'), publicFilesOf(task)]]) {
      if (files.length === 0) { console.log(`✗ ${task.id} ${dir} 下没有测试文件`); bad++; continue; }
      const r = runAgainst(task, code, dir, files);
      if (r.rejected) { console.log(`✗ ${task.id} 参考解被沙箱拒绝:\n${r.message}`); bad++; continue; }
      for (const x of r.results) {
        if (!x.ok) bad++;
        const detail = task.lang === 'sql' ? (x.ok ? '结果集全等' : (x.error ?? `期望 ${x.want} 实际 ${x.got}`)) : `应${x.expect} 实${x.rc}`;
        console.log(`${x.ok ? '✓' : '✗'} ${task.id} ${x.file} ${detail}`);
      }
    }
  }
  console.log(bad ? `\n仪器自检失败 ${bad} 项——修好参考解或测试文件前不要跑模型` : '\n仪器自检全过');
  if (bad) process.exit(1);
}
if (SELFCHECK) { await selfcheck(); process.exit(0); }

mkdirSync(OUT, { recursive: true });
const modelSeen = new Set();
const perTask = {};

for (const task of TASKS) {
  const hiddenDir = join(ROOT, 'tests', task.id);
  const hidden = hiddenFilesOf(task);
  const pubDir = join(ROOT, 'public');
  const pub = publicFilesOf(task);
  const isSql = task.lang === 'sql';
  const prompt = isSql ? buildSqlPrompt(task) : buildPythonPrompt(task);
  // 公开样例随题面给模型看(内容原文),让它知道输入长什么样;SQL 题给插数语句与期望结果集
  const pubText = isSql
    ? pub.map(f => { const t = yamlLoad(readFileSync(join(pubDir, f), 'utf-8')); return `公开样例(往空表里插入下面的数据):\n\`\`\`sql\n${t.data.trim()}\n\`\`\`\n在这份数据上,查询应返回的结果集(每行一个数组,按结果列顺序):\n\`\`\`\n${(t.expect ?? []).map(r => JSON.stringify(r)).join('\n') || '(空结果)'}\n\`\`\``; }).join('\n\n')
    : pub.map(f => `公开样例 ${f}(应退出 ${expectOf(f)}):\n\`\`\`\n${readFileSync(join(pubDir, f), 'utf-8')}\`\`\``).join('\n\n');
  const firstMsg = `${prompt}\n\n${pubText}`;
  const shots = [];
  for (let i = 1; i <= N; i++) {
    const messages = [{ role: 'user', content: firstMsg }];
    const rounds = [];
    let finalHidden = null;
    for (let round = 0; round <= HEAL; round++) {
      const { text, model, stop, error } = await call(messages);
      modelSeen.add(model);
      writeFileSync(join(OUT, `${task.id}-${i}-r${round}.txt`), text || `(空正文 stop_reason=${stop} error=${error ?? ''})`);
      const code = extractCode(text, task.lang);
      if (!code) {
        rounds.push({ round, outcome: stop === 'max_tokens' ? 'truncated' : error ? 'api-error' : 'no-code', ...(error ? { error: String(error).slice(0, 200) } : {}) });
        messages.push({ role: 'assistant', content: text || '(空)' }, { role: 'user', content: isSql ? '没有找到 ```sql 代码块。请把完整查询放在一个 ```sql 代码块里交付。' : '没有找到 ```python 代码块。请把完整脚本放在一个 ```python 代码块里交付。' });
        continue;
      }
      const h = runAgainst(task, code, hiddenDir, hidden);
      const p = runAgainst(task, code, pubDir, pub);
      const hiddenPass = !h.rejected && h.results.every(r => r.ok);
      const pubPass = !p.rejected && p.results.every(r => r.ok);
      const rec = { round, outcome: h.rejected ? 'rejected' : 'ran', public_pass: pubPass, hidden_pass: hiddenPass };
      if (h.rejected) rec.reject_head = h.message.split('\n').slice(0, 3).join(' | ').slice(0, 300);
      else {
        rec.hidden_failed = h.results.filter(r => !r.ok).map(r => isSql ? `${r.file}(${r.crashed ? '执行报错' : '结果不对'})` : `${r.file}(应${r.expect}实${r.rc}${r.crashed ? ' 崩溃' : ''})`);
        rec.crashed_files = h.results.filter(r => r.crashed).length;
      }
      rounds.push(rec);
      finalHidden = rec;
      console.log(`  ${task.id} #${i} r${round}: ${rec.outcome} 公开=${pubPass ? '✓' : '✗'} 隐藏=${hiddenPass ? '✓' : '✗'}${rec.hidden_failed?.length ? ' 挂:' + rec.hidden_failed.join(',') : ''}`);
      if (pubPass) break;   // 模型看得见的回路只有公开样例——公开过了就没有再修的理由(隐藏测试不反馈)
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: isSql ? sqlFeedbackOf(p) : feedbackOf(p) });
    }
    writeFileSync(join(OUT, `${task.id}-${i}-grading.yaml`), yamlDump(rounds, { lineWidth: 200 }));
    const first = rounds[0];
    shots.push({
      i,
      first_try_pass: first.outcome === 'ran' && first.hidden_pass,
      first_try_outcome: first.outcome,
      first_try_crashed: first.outcome === 'ran' && first.crashed_files > 0,
      final_pass: !!finalHidden?.hidden_pass,
      rounds_used: rounds.length,
      public_pass_hidden_fail: !!finalHidden && finalHidden.public_pass && !finalHidden.hidden_pass,
      final_hidden_failed: finalHidden?.hidden_failed ?? (finalHidden ? '(沙箱拒绝)' : '(无代码)'),
    });
  }
  const cnt = k => shots.filter(s => s[k]).length;
  perTask[task.id] = {
    语言: task.lang,
    档: task.level,
    一次写对: `${cnt('first_try_pass')}/${N}`,
    自愈后通过: `${cnt('final_pass')}/${N}`,
    首轮沙箱拒绝: `${shots.filter(s => s.first_try_outcome === 'rejected').length}/${N}`,
    首轮截断: `${shots.filter(s => s.first_try_outcome === 'truncated').length}/${N}`,
    首轮崩溃: `${cnt('first_try_crashed')}/${N}`,
    公开过隐藏挂: `${cnt('public_pass_hidden_fail')}/${N}`,
    隐藏测试文件数: hidden.length,
    shots,
  };
}

const summary = {
  service: SERVICE, model_from_response: [...modelSeen],
  date: new Date().toISOString().slice(0, 10),
  维度: `G6 代码生成——Python 档(规范条款→校验脚本,Python 语法沙箱内执行,判分=隐藏测试文件退出码全对)与 SQL 档(取数需求→SQLite 查询,判分=隐藏测试数据上结果集全等);每题 n=${N},自愈回路最多 ${HEAL} 轮只反馈公开样例与沙箱/执行报文`,
  指标说明: '一次写对=第 1 轮的解在全部隐藏测试上全对(Python 退出码全对,SQL 结果集全等);首轮崩溃在 SQL 题=查询执行报错;自愈后通过=回路结束时最后一版脚本全对;公开过隐藏挂=模型看得见的样例都过了但隐藏测试有挂(自验通过的校验在真实文件上失效)',
  tasks: perTask,
};
writeFileSync(join(OUT, 'summary.yaml'), yamlDump(summary, { lineWidth: 200 }));
console.log('\n══ summary ══');
for (const [id, t] of Object.entries(perTask)) console.log(`${id}(${t.语言}·${t.档}): 一次写对 ${t.一次写对} / 自愈后 ${t.自愈后通过} / 首轮沙箱拒绝 ${t.首轮沙箱拒绝} / 首轮崩溃 ${t.首轮崩溃} / 公开过隐藏挂 ${t.公开过隐藏挂}`);
console.log(`产物: ${OUT}`);
