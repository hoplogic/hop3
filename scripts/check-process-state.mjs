#!/usr/bin/env node
// @a: anc-run-isolation
// run 隔离守卫：src 内核禁触进程级状态（process.env/process.cwd/process.chdir）与机器身份级读取（homedir()/hostname()/userInfo()/process.execPath,
// 2026-10-10 扩面——hop-admin.ts 设计承诺四项不读而守卫只拦三项,0154+0155 review 变异 M19a 实证加 homedir 导入守卫绿）+ 禁模块顶层可变状态。
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
const COMPOSITION_ROOTS = new Set(['cli.ts', 'mcp-server.ts']);   // 两个进程边界;postinstall.ts 曾是第三个,2026-10-09 随 npm 钩子撤（^anc-cli-postinstall 撤销记录）
// 逐条登记豁免（文件 → [{pattern, reason}]）
const EXEMPT = [
  { file: 'dispatcher.ts', pattern: 'snap ? snap[key] : process.env[key]', reason: 'envOf 统一读取入口的回退支路——快照缺席回退直读（存量兼容,主锚 env_snapshot 条款）;唯一合法内核读点' },
  { file: 'engine.ts', pattern: "process.env['HOPJIT_CONTEXT_MODE']", reason: 'load=CLI 每命令组合根延伸;低危调试开关（见 engine.ts 豁免注记）' },
  { file: 'tools-mcp-binding.ts', pattern: 'process.env[', reason: 'env_passthrough/auth_env=stdio 子进程透传,装配期解引用属组合根延伸语义（主锚 env 例外①）' },
  { file: 'tools.ts', pattern: 'process.env', reason: '（如有）沙箱路径解析的 HOME 展开——进程身份级' },
  { file: 'tools-notify.ts', pattern: 'process.env.DINGTALK_', reason: '钉钉通道凭证解引用（DINGTALK_WEBHOOK/DINGTALK_SECRET）——与 tools-mcp-binding auth_env 同语义:通道凭证恒环境变量不进配置（[[tools/dingtalk-notify#^anc-tool-dingtalk-notify]] 凭证纪律）,发送时读属组合根延伸;只读不写,run 级零状态' },
  { file: 'engine.ts', pattern: "expanded = v === '~' ? homedir() : join(homedir(), v.slice(2));", reason: 'Config.dirs 声明里 ~ 的家目录展开（^anc-exec-dirs-grant）——与 tools.ts HOME 展开同语义:进程身份级,起跑一次性解析进白名单,不是 run 级状态' },
  { file: 'config-load.ts', pattern: 'env: Record<string, string | undefined> = process.env', reason: 'detectSystemLanguage 的缺省参数——系统语言（LC_ALL/LC_MESSAGES/LANG）是进程身份级配置,与 HOME/HOPJIT_CONFIG 同属 ARCHITECTURE ^anc-run-isolation env 例外②;只在 HostConfig 构造期（applyReuseConfig / startRun / restoreRun）读一次定 language,不在 run 运行期查;结果落 HostConfig.language 与 hop_env_language 快照面（todo/0160）' },
  { file: 'hop-admin.ts', pattern: 'cp.spawn(process.execPath, [process.argv[1]]', reason: 'HANDSHAKE_SCRIPT 模板字符串内的子进程源码文本——由 node -e 在子进程里执行,不是本模块读进程状态（mcpHandshake 自身的 node 路径经参数 execPath 传入）' },
  // 模块顶层可变状态的登记项（守卫的顶层 let 规则只扫列首 let,const 持有的可变 Set 扫不到——这里按登记制补账,ARCHITECTURE ^anc-run-isolation 豁免清单同款）
  { file: 'dispatcher.ts', pattern: 'const reachedEndpoints = new Set<string>()', reason: '本进程里成功应答过的端点集（v0.41.0,hopissues/0118,^anc-exec-network-pause）——只增不删、只影响死端点判定的降级（ENOTFOUND/ECONNREFUSED 改走网络重试）,不装 run 级数据;刻意模块级而非实例级:parallel worker 各自新建 StepDispatcher,实例级状态不共享' },
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
const RE_PROC = /process\.(env|cwd|chdir|execPath)\b|\b(homedir|hostname|userInfo)\(/g;   // 2026-10-10 扩面：机器身份级读取同属进程状态（^anc-run-isolation 守卫句）
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
      violations.push({ file: name, line: i + 1, kind: '内核读进程状态（含 homedir/hostname/userInfo/execPath 机器身份级读取）', text: line.trim() });
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
