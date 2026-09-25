// @module: act-body ^anc-struct-act-body
// 命令执行原语——把一个 argv 列表在白名单管控下真正 spawn 出去,并把失败翻译成能照着修的报文。
// 设计权威 docs/design/act-body.md ^anc-exec-command-primitive。
//
// 为什么独立成文件（2026-09-22,todo/0110 候选 B 批）：两个消费口需要同一套管控——
//   ① hop_python body 的 subprocess.run（规约作者写死的命令,^anc-exec-subprocess-run）
//   ② tools 模块的 run_script（工具面,执行步里模型按需跑脚本,docs/design/tools/run-script.md）
// 这里的四件（白名单两拒带配置指路 / hopjit 恒拒 / shell:false / 失败三类分辨指路）没有一件是
// 拍脑袋想出来的,全是实撞后补的:ENOENT 两因分辨来自 0020 批次误诊连带错修,白名单两拒的配置
// 指路来自 hopissues/0090（用户 1.5 小时废跑才摸到 hopjit.yaml）。抄第二份 = 下一次修坑只修到
// 一半,而实撞下次撞哪一侧无从预知。
//
// 本原语只抛不翻译：抛出的是带指路文本的 Error,由消费口决定包装形态（body 面 → 报文带
// TOOL_EXEC_ERROR 前缀,经既有升级链炸步；工具面 → ToolResult{success:false} 经工具结果通道
// 回执行方）。不认识这两种形态正是它能被两边共用的前提。重放 journal 与实参解析同理不进原语
// ——归各消费口自己。
// @a: anc-exec-command-primitive
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** 命令执行结果——非零退出码是值不是异常（失败是值,处置归调用方）。 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  returncode: number;
}

/** 执行策略——两个消费口的差异全在这里（限额、超时、报文里的自称、抛错前缀各自传）。 */
export interface RunCommandOptions {
  /** 允许的命令名集合;缺席或空=能力关死（缺省安全——引擎不内置任何命令）。 */
  whitelist?: string[];
  /** 工作目录（已算好的最终值——缺省回落归调用方,报文的 cwd 分辨判的就是这个值）。 */
  cwd?: string;
  /** 超时秒数——调用方给,原语不设缺省（两个消费口的缺省各自声明）。 */
  timeoutSec: number;
  /** 单流输出上限字节:body 面 10MB（消费者是变量）/ 工具面 64KB（消费者是模型上下文窗口）。 */
  maxBuffer: number;
  /** 喂给命令 stdin 的文本。 */
  input?: string;
  /** 报文里称呼调用入口的名字（body 面 'subprocess.run' / 工具面 'run_script'）。 */
  label: string;
  /**
   * 抛出报文的前缀。body 面必须传 'TOOL_EXEC_ERROR: '——引擎按这个前缀把 body 抛错转成
   * 本步失败（见 engine.ts 直执工具失败分支），少了它就成了未捕获崩溃;工具面留空。
   */
  errorPrefix?: string;
  /**
   * 拼在 argv 前面一起 spawn 的包装前缀（py-sandbox 套系统沙箱用:['sandbox-exec','-p',<profile>]）。
   * 只拼在 spawn 最前面,不参与白名单与 hopjit 恒拒核对——那两道仍只核 argv[0]。前缀由引擎内部
   * 给定、不来自模型也不来自规约;套一层沙箱只会让能力更小,所以不受命令白名单管。缺席=行为与
   * 无此选项时逐字节一致。权威 docs/design/act-body.md ^anc-exec-command-primitive v0.24.0。
   */
  wrapperArgv?: string[];
}

/**
 * 白名单管控下执行一个命令。argv[0]=命令名,其余为参数（参数列表制不经 shell）。
 * 抛出的 Error 带修法指路,由调用方包装成自己的失败形态。
 */
// @a: anc-exec-command-primitive
export function runWhitelistedCommand(argv: string[], opts: RunCommandOptions): CommandResult {
  const { whitelist, cwd, timeoutSec, maxBuffer, input, label } = opts;
  const p = opts.errorPrefix ?? '';
  const cmd = argv[0];
  // hopjit 恒拒名单（^anc-exec-subprocess-deny-hopjit,2026-08-30 作者定——层次约束:被执行的
  // 步骤内容不得反过来驱动执行引擎,自嵌套执行必坏状态账;优先于白名单,白名单写了也不放行）
  // @a: anc-exec-subprocess-deny-hopjit
  if (cmd === 'hopjit' || cmd.split('/').pop() === 'hopjit') {
    throw new Error(`${p}执行中的步骤不得调用 hopjit——步骤内容不驱动引擎（自嵌套执行会破坏状态账）。跑别的 spec 用 [call <Id>] 步骤;通知等不可逆动作走注册工具的 commit 步骤;执行状态是引擎的账,步骤不查`);
  }
  // 白名单两拒——报文都带配置指路（hopissues/0090:空名单报"不可用"不点名命令、缺命令报
  // "X 不在白名单"不提配置载体,用户 1.5h 废跑后才摸到 hopjit.yaml）。
  if (!whitelist || whitelist.length === 0) {
    throw new Error(`${p}命令 "${cmd}" 无法执行——本执行环境未配置命令白名单（sandbox.runtime.available 为空=能力关死,缺省安全）。修法:把 ${cmd} 加进项目根 hopjit.yaml 的 commands: 列表（如 commands:\n  - ${cmd}）后重跑（hopissues/0090 指路条款）`);
  }
  if (!whitelist.includes(cmd)) {
    throw new Error(`${p}命令 "${cmd}" 不在白名单（sandbox.runtime.available: ${whitelist.join(', ')}）。修法:把 ${cmd} 加进项目根 hopjit.yaml 的 commands: 列表（如 commands:\n  - ${cmd}）后重跑（hopissues/0090 指路条款）`);
  }
  const full = [...(opts.wrapperArgv ?? []), ...argv];
  const r = spawnSync(full[0], full.slice(1), {
    input,
    timeout: timeoutSec * 1000,
    cwd,
    encoding: 'utf-8',
    shell: false,   // 恒定——参数列表制的物理保证,不是可选项
    maxBuffer,
  });
  if (r.error) {
    // spawn 自身失败——三类常见因各带指路（review 抓 ENOBUFS 裸报不指路——设计"撞顶=失败报文
    // 指路",不截断:截断的 stdout 喂下游=静默数据缺角,比响亮失败更危险）。
    const code = (r.error as NodeJS.ErrnoException).code;
    // ENOENT 两因分辨——Node 对"cwd 不存在"与"命令不存在"报同一 ENOENT,不分辨即误导排障
    //（0020 批 review 实撞:占位符 cwd 未替换,报文指向命令误诊"本机无 uv"）。
    const cwdMissing = code === 'ENOENT' && typeof cwd === 'string' && !existsSync(cwd);
    const mb = maxBuffer / (1024 * 1024);
    const limitText = mb >= 1 ? `${mb}MB` : `${Math.round(maxBuffer / 1024)}KB`;
    const hint = code === 'ENOBUFS' ? `——输出超过 ${limitText} 上限,用命令自带过滤收窄（如 git log --grep= 而非全量再筛）`
      : code === 'ETIMEDOUT' ? `——超时（timeout=${timeoutSec}s,可调大或收窄命令工作量）`
      : cwdMissing ? `——工作目录不存在: ${cwd}（常见因:body 里 cwd 参数的占位符没替换、或相对路径基准错;命令本身可能好好在系统里）`
      : code === 'ENOENT' ? '——命令不存在（白名单里有名字但系统里找不到可执行文件）'
      : '';
    throw new Error(`${p}${label} ["${cmd}", ...] 执行失败: ${r.error.message}${hint}`);
  }
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', returncode: r.status ?? -1 };
}
