#!/usr/bin/env node
// act_free 工具面稳定性格点探针——按 act-free-stability/grid.yaml 契约实测可靠性衰减曲线。
// 测什么: act free 步在{供给长度 × 工具面大小 × 任务类型}网格上的完成率与轮效率。
// 方法: 每格现场组装一个最小 spec(单 act free 步),经引擎 standalone 跑(MCP core 直驱——
//   真实的工具下发/循环/收卷路径,不是裸 API 模拟),产出数字与答案键机械比对。
// 用法: node run-act-free-stability.mjs --service <id> [--n 6] [--cells short:0:noise_only,...]
//   缺省全格(3 长度 × 5 工具数 × 2 任务型 = 30 格 × n)。--cells 逗号分隔指定格点(断点续跑)。
// 产出: act-free-stability/run-<service>-<date>/ 下 cells.yaml(逐格账)+curve.yaml(档案同构曲线)。
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { loadStandaloneConfig, HopjitMcpCore } from '../../dist/mcp-server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SERVICE = argOf('--service');
const N = parseInt(argOf('--n', '6'), 10);
if (!SERVICE) { console.error('用法: --service <id> [--n 6] [--cells ...]'); process.exit(1); }

const GRID = yamlLoad(readFileSync(join(HERE, 'act-free-stability', 'grid.yaml'), 'utf-8'));
const LENGTHS = GRID.matrix.supply_length.map(s => String(s).split(' ')[0]);
const TOOLS = GRID.matrix.tool_count;
const KINDS = GRID.matrix.task_kind.map(s => String(s).split(' ')[0]);
const CELLS = argOf('--cells', '') ? argOf('--cells').split(',').map(c => c.split(':')) :
  LENGTHS.flatMap(l => TOOLS.flatMap(t => KINDS.map(k => [l, String(t), k])));

const OUT = argOf('--out', '') ? join(HERE, argOf('--out')) : join(HERE, 'act-free-stability', `run-${SERVICE}-${new Date().toISOString().slice(0, 10)}`);
mkdirSync(OUT, { recursive: true });

// 工具面阶梯: 0=禁全部基础族;1=只留 read;3=read/write/append;5=+listdir/exists;10=基础族满配(不禁)。
// act free 的基础族恒下发,收窄靠禁工具行(- 禁工具:)——与生产 spec 同一机制,测的就是真实供给面。
const BASIC10 = ['read', 'write', 'append', 'listdir', 'exists', 'create', 'edit_file', 'search_file', 'makedirs', 'move', 'remove'];   // tools.ts 基础族全员(spec 树编辑族/validate_spec 是特殊工具不在恒下发面)
const KEEP = { 0: [], 1: ['read'], 3: ['read', 'write', 'append'], 5: ['read', 'write', 'append', 'listdir', 'exists'], 10: BASIC10 };
function denyLines(toolCount) {
  const keep = new Set(KEEP[toolCount]);
  return BASIC10.filter(t => !keep.has(t)).map(t => `  - 禁工具: ${t}  # 格点工具面收窄`).join('\n');
}

function buildSpec(len, toolCount, kind, logText, answer) {
  const deny = denyLines(toolCount);
  if (kind === 'noise_only') {
    return `# Spec: 格点-噪声臂
Id: cell-noise
Goal: 找出日志里 code=999 那一行的 latency 值
Inputs:
- log_text: text  # 日志全文(已在手,不需要读任何文件)
Outputs:
- marker_latency: int  # code=999 行的 latency 数值
## Steps
### 1. [act free] 在 log_text 里找到 code=999 的那一行,交付它的 latency 数值(纯数字,不带 ms)
- ← log_text
${deny}
+ → marker_latency: int  # code=999 行的 latency 数值

日志全文已经在输入里,直接找,不需要碰任何文件或工具。
`;
  }
  return `# Spec: 格点-正用臂
Id: cell-tool
Goal: 读日志文件找 code=999 行的 latency 值
Inputs:
- log_file: line  # 日志文件名(workspace 相对路径)
Outputs:
- marker_latency: int  # code=999 行的 latency 数值
## Steps
### 1. [act free] 读 log_file 指向的文件,找到 code=999 的那一行,交付它的 latency 数值(纯数字,不带 ms)
- ← log_file
${deny}
+ → marker_latency: int  # code=999 行的 latency 数值

文件内容不在输入里,必须用工具读那个文件才能找。
`;
}

const config = loadStandaloneConfig();
// 路由覆写:整跑锁定被测 service(standalone config 的 default_model 换成被测档)
const provider = (config.providers ?? []).find(p => p.service_id === SERVICE);
if (!provider) { console.error(`service '${SERVICE}' 不在 ~/.hopjit/config.yaml providers 内`); process.exit(1); }
const MODEL = argOf('--model', provider.model);
if (!MODEL) { console.error(`service '${SERVICE}' 无 models 首项,用 --model 显式给模型名`); process.exit(1); }
console.log(`[路由] ${SERVICE}/${MODEL}`);

const cells = [];
const cellsF = join(OUT, 'cells.yaml');
for (const [len, tc, kind] of CELLS) {
  const logText = readFileSync(join(HERE, 'act-free-stability', 'tasks', `log-${len}.txt`), 'utf-8');
  const mline = logText.split('\n').find(l => l.includes('code=999'));
  const answer = Number(mline.match(/latency=(\d+)ms/)[1]);
  const results = [];
  for (let i = 0; i < N; i++) {
    const ws = join(tmpdir(), `afs-${SERVICE}-${len}-${tc}-${kind}-${i}-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'hopjit.yaml'), `default_model: ${SERVICE}/${MODEL}\n`);
    writeFileSync(join(ws, 'cell.md'), buildSpec(len, Number(tc), kind, logText, answer));
    if (kind === 'tool_required') writeFileSync(join(ws, 'app.log'), logText);
    const params = kind === 'noise_only' ? { log_text: logText } : { log_file: 'app.log' };
    const core = new HopjitMcpCore(loadStandaloneConfig());
    const t0 = Date.now();
    let verdict = 'error', rounds = null, tokens = null;
    try {
      const started = await core.startRun(join(ws, 'cell.md'), params, undefined, ws);
      if (started.error) throw new Error(JSON.stringify(started.error));
      const runId = started.run_id;
      for (let w = 0; w < 60; w++) {          // 单发上限 5 分钟
        await new Promise(r => setTimeout(r, 5000));
        const st = core.runStatus(runId);
        if (st.status === 'completed') {
          tokens = st.cumulative_tokens ?? null;
          const got = Number(st.outputs?.marker_latency);
          verdict = got === answer ? 'pass' : `wrong(${got}≠${answer})`;
          // 轮效率:从 hoplog 数 llm 调用次数(粗算);tool_required 最小 2 轮(调 read+交卷),noise 最小 1
          break;
        }
        if (st.status === 'failed') { verdict = `failed(${String(st.failure_reason ?? '').slice(0, 80)})`; break; }
        if (st.status === 'paused') {
          const preason = st.paused?.pause_reason ?? '';
          if (preason === 'network') { await core.resumeRun(runId, st.paused?.step_id, {}); continue; }  // 网络抖动自愈续跑
          verdict = 'paused-unexpected(' + preason + ')'; await core.stopRun(runId); break;
        }
        if (w === 59) { verdict = 'timeout-5min'; await core.stopRun(runId); }
      }
    } catch (e) { verdict = `error(${String(e.message).slice(0, 160)})`; console.error('  [诊断]', e.stack?.split('\n').slice(0,3).join(' | ')); }
    results.push({ verdict, tokens, secs: Math.round((Date.now() - t0) / 1000) });
    console.log(`[${len}/${tc}tools/${kind}] #${i + 1}/${N}: ${verdict} (${results.at(-1).secs}s)`);
    if (verdict === 'pass') rmSync(ws, { recursive: true, force: true }); else console.error('  [现场保留]', ws);
  }
  const rate = results.filter(r => r.verdict === 'pass').length / N;
  cells.push({ cell: `${len}:${tc}:${kind}`, rate, n: N, results });
  writeFileSync(cellsF, yamlDump({ service: SERVICE, cells }, { lineWidth: 200 }));  // 逐格落盘,断点不丢
  console.log(`── 格 ${len}:${tc}:${kind} rate=${rate}`);
}

// 曲线机械读档(grid.yaml rating_rules)
const byTool = {};
for (const c of cells) {
  const [, t, kind] = c.cell.split(':');
  if (t === '0' && kind === 'tool_required') continue;   // 设计内必死对照格(零工具读不了文件)——测的是诚实申报,不进耐受读档
  (byTool[t] ??= []).push(c.rate);
}
const toolLevels = Object.keys(byTool).map(Number).sort((a, b) => a - b);
let rating = 'untested-curve';
if (cells.length) {
  if (cells.every(c => c.rate >= 0.9)) rating = 'full-tolerance';
  else {
    let best = null;
    for (const t of toolLevels) { if (byTool[t].every(r => r >= 0.9)) best = t; else break; }
    rating = best !== null ? `le${best}-tools` : 'unstable-at-any-tools';
  }
  const kindsCovered = new Set(cells.map(c => c.cell.split(':')[2]));
  if (!kindsCovered.has('tool_required')) rating += '-noise-side-only';
}
writeFileSync(join(OUT, 'curve.yaml'), yamlDump({ service: SERVICE, rating, cells: cells.map(c => ({ cell: c.cell, rate: c.rate, n: c.n })) }));
console.log(`\n═══ rating=${rating}  账在 ${OUT}`);
