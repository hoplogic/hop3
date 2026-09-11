#!/usr/bin/env node
// @a: anc-run-isolation
// run 隔离守卫：src 内核禁触进程级状态（process.env/process.cwd/process.chdir）+ 禁模块顶层可变状态。
//
// 为什么（ARCHITECTURE ^anc-run-isolation,2026-08-14 实撞:多 run 并发沉船+cwd 串台同病两症）：
// run 级的东西住进程级槽位=并发 run 互相影响。进程状态只许组合根（cli.ts/mcp-server.ts 入口）
// 一次读取折进 run 级 HostConfig,内核运行期只消费载体。
//
// 豁免=登记制：白名单逐条列（文件+模式+理由）,内核文件零豁免。
// 退出码：0=干净;1=违规;2=扫描面空转
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.HOPJIT_CHECK_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// 组合根白名单：进程边界翻译层,允许读进程状态（写 process.env 一律禁——含组合根）
const COMPOSITION_ROOTS = new Set(['cli.ts', 'mcp-server.ts']);
// 逐条登记豁免（文件 → [{pattern, reason}]）
const EXEMPT = [
  { file: 'dispatcher.ts', pattern: 'snap ? snap[key] : process.env[key]', reason: 'envOf 统一读取入口的回退支路——快照缺席回退直读（存量兼容,主锚 env_snapshot 条款）;唯一合法内核读点' },
  { file: 'engine.ts', pattern: "process.env['HOPJIT_CONTEXT_MODE']", reason: 'load=CLI 每命令组合根延伸;低危调试开关（见 engine.ts 豁免注记）' },
  { file: 'tools-mcp-binding.ts', pattern: 'process.env[', reason: 'env_passthrough/auth_env=stdio 子进程透传,装配期解引用属组合根延伸语义（主锚 env 例外①）' },
  { file: 'tools.ts', pattern: 'process.env', reason: '（如有）沙箱路径解析的 HOME 展开——进程身份级' },
  { file: 'tools-notify.ts', pattern: 'process.env.DINGTALK_', reason: '钉钉通道凭证解引用（DINGTALK_WEBHOOK/DINGTALK_SECRET）——与 tools-mcp-binding auth_env 同语义:通道凭证恒环境变量不进配置（[[tools/dingtalk-notify#^anc-tool-dingtalk-notify]] 凭证纪律）,发送时读属组合根延伸;只读不写,run 级零状态' },
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(dir, e.name), out);
    else if (e.name.endsWith('.ts')) out.push(join(dir, e.name));
  }
  return out;
}

let files;
try { files = walk(SRC); } catch { files = []; }
if (files.length === 0) {
  console.error('check-process-state: 扫描面空转（src 下 0 个 ts）——显式失败不假绿');
  process.exit(2);
}

const violations = [];
const RE_PROC = /process\.(env|cwd|chdir)\b/g;
const RE_TOPLEVEL_LET = /^let\s+\w+/;

for (const file of files) {
  const name = relative(SRC, file);
  const text = readFileSync(file, 'utf-8');
  const lines = text.split('\n');
  const isRoot = COMPOSITION_ROOTS.has(name);
  lines.forEach((line, i) => {
    // 进程状态读取
    if (RE_PROC.test(line)) {
      RE_PROC.lastIndex = 0;
      // 写入判定：process.env[X] = ...（赋值）——排除 ==/=== 比较与注释行
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
      const writesEnv = /process\.env\[[^\]]*\]\s*=(?![=])/.test(line);
      if (writesEnv) {
        violations.push({ file: name, line: i + 1, kind: 'env 写入（一律禁——进程环境不是全局注册表）', text: line.trim() });
        return;
      }
      if (isRoot) return;   // 组合根读取放行
      const ex = EXEMPT.find(e => e.file === name && line.includes(e.pattern.replace(/\[$/, '')) );
      if (ex) return;
      violations.push({ file: name, line: i + 1, kind: '内核读进程状态', text: line.trim() });
    }
    // 模块顶层可变状态（列首 let——类/函数体内缩进的不算）
    if (RE_TOPLEVEL_LET.test(line)) {
      if (isRoot) return;   // 组合根豁免（FORCE_JSON 登记先例）
      violations.push({ file: name, line: i + 1, kind: '模块顶层可变状态（run 级缓存住进程级槽的温床）', text: line.trim() });
    }
  });
}

if (violations.length > 0) {
  console.error('Process-state isolation check failed（ARCHITECTURE ^anc-run-isolation）:');
  for (const v of violations) console.error(`- src/${v.file}:${v.line} [${v.kind}] ${v.text}`);
  process.exit(1);
}
console.log(`Process-state isolation check passed. (${files.length} files)`);
