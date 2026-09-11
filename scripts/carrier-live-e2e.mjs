#!/usr/bin/env node
// @a: anc-driver-live-e2e-scenarios, anc-driver-live-e2e-entry

import {
  DEFAULT_TIMEOUT_MS,
  SCENARIO_TIMEOUT_MS,
  LiveE2EError,
  assertBuilt,
  assertNoSecretLeak,
  archiveFailureEvidence,
  archivePassEvidence,
  assertScenario,
  buildCarrierCommand,
  carrierAdapter,
  cleanupWorkspace,
  collectSecrets,
  createIsolatedWorkspace,
  diagnosticSummary,
  installCarrierSkill,
  initializeGitWorkspace,
  readWorkspaceText,
  runChildProcess,
  selectCredential,
  validateScenarioPreconditions,
  buildIsolatedCodexHome,
} from './carrier-live-e2e-lib.mjs';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');

// codex 载体环境自包含（todo/0061,^anc-driver-live-e2e-isolation codex 子条）：起 codex
// 前用 buildIsolatedCodexHome 构造临时 CODEX_HOME（宿主配置滤掉插件/外部 MCP/notify——
// 未登录 slack 插件曾拖死两场景实撞）,spawn env 带 CODEX_HOME 指过去,宿主真身全程零接触。
// codex:standalone 的 hopjit MCP 注册块直写临时 home 的 config.toml（codex mcp add 无
// env_vars flag）——旧的宿主文件 mask/unmask/append/remove 四机制随隔离退役:临时 home 的
// config 已滤掉宿主 [mcp_servers.*],无同名撞块可防;run 完整目录删除零残留。
// 见 design ^anc-driver-codex-standalone-dispatch 注册通道条。
const HOPJIT_MCP_ANCHOR_BEGIN = '# >>> hopjit-e2e-standalone（脚本管理,勿手编;残留可整块删除） >>>';
const HOPJIT_MCP_ANCHOR_END = '# <<< hopjit-e2e-standalone <<<';

function registerCodexMcpBlock(isolatedHome, hopjitConfigPath, credentialEnvName) {
  const block = [
    '',
    HOPJIT_MCP_ANCHOR_BEGIN,
    '[mcp_servers.hopjit]',
    'command = "node"',
    `args = [${JSON.stringify(join(projectRoot, 'dist', 'mcp-server.js'))}]`,
    `env = { HOPJIT_CONFIG = ${JSON.stringify(hopjitConfigPath)} }`,
    `env_vars = [${JSON.stringify(credentialEnvName)}]`,
    // 三行皆真机实撞定形（2026-08-10）：required=起不来即整体报错（不再靠模型嘴说）；
    // 默认 startup 10s 对装载引擎的 server 偏紧；exec 非交互下 MCP 调用默认送审批,
    // 无人可批即 'user cancelled'——auto 免审（server 工具已带 ToolAnnotations 如实分级）。
    'required = true',
    'startup_timeout_sec = 30',
    'default_tools_approval_mode = "auto"',
    HOPJIT_MCP_ANCHOR_END,
    '',
  ].join('\n');
  appendFileSync(join(isolatedHome, 'config.toml'), block);
}

function parseArgs(argv) {
  const options = { scenario: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('#')) break;   // 行尾注释吞掉（npm run xxx # 说明——npm 会把注释当参数透传,实撞 2026-08-12）
    if (token === '--credential-env') options.credentialEnv = argv[++index];
    else if (token === '--launcher') options.launcher = argv[++index];
    else if (token === '--profile') options.profile = argv[++index];
    else if (token === '--model') options.model = argv[++index];
    else if (token === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else throw new LiveE2EError(`未知参数：${token}`, 2);
  }
  if (!options.scenario) {
    throw new LiveE2EError('用法：carrier-live-e2e.mjs <cc:delegated|codex:delegated|codex:flash|codex:demo|codex:standalone|cc:standalone>', 2);
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new LiveE2EError('--timeout-ms 必须是正数', 2);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // codex:standalone 与 flash 同走 ds（作者定,对齐 flash 先例）——单跑不带参也用 flash profile
  const standaloneLike = options.scenario === 'codex:standalone' || options.scenario === 'codex:standalone-parallel';
  options.profile ??= (options.scenario === 'codex:flash' || standaloneLike)
    ? (process.env.HOPSPEC_E2E_CODEX_FLASH_PROFILE ?? (standaloneLike ? 'deepseek-v4-flash' : undefined))
    : process.env.HOPSPEC_E2E_CODEX_DELEGATED_PROFILE;
  options.model ??= options.scenario.startsWith('cc:')
    ? process.env.HOPSPEC_E2E_CC_MODEL
    : process.env.HOPSPEC_E2E_CODEX_MODEL;
  options.launcher ??= process.env.HOPSPEC_E2E_CC_LAUNCHER;
  if (options.launcher === 'claude-ds') options.credentialEnv ??= 'DEEPSEEK_API_KEY';
  options.credentialEnv ??= process.env.HOPSPEC_E2E_CREDENTIAL_ENV;

  validateScenarioPreconditions(options.scenario, options);
  assertBuilt();
  const selected = selectCredential(options.scenario, process.env, options.credentialEnv);
  const secrets = collectSecrets(process.env, selected);
  const timeoutMs = options.timeoutMs ?? SCENARIO_TIMEOUT_MS[options.scenario] ?? DEFAULT_TIMEOUT_MS;
  const carrier = options.scenario.startsWith('cc:') ? 'cc' : 'codex';
  let workspace;
  let isolatedCodexHome = null;   // codex 临时 CODEX_HOME（^anc-driver-live-e2e-isolation codex 子条）
  let result;
  let normalized = [];

  try {
    // 复用模式 codex 场景屏蔽用户自有 hopjit MCP（2026-08-25 live:core 实撞第二形态:作者长期
    // 注册 [mcp_servers.hopjit],codex:delegated 看见工具面即按 skill §0 正确锁 STANDALONE 走
    // MCP——业务 completed 但复用模式判据红。两波互斥注释早预言此形态,当时防的是 e2e 自己的
    // 注册残留,防不了用户常驻注册。mask 机制已随隔离 home 退役——本注释块保留实撞史供考古。cc 场景无关（--strict-mcp-config 钉工具面）。
    // 用户常驻 hopjit MCP 注册的屏蔽机制已随隔离 home 退役——临时 config 滤掉了宿主
    // [mcp_servers.*] 全段,复用场景的工具面天然干净（原 mask/unmask 防的正是这个漏面）。
    if (carrier === 'codex') {
      isolatedCodexHome = buildIsolatedCodexHome();
    }
    workspace = createIsolatedWorkspace(carrier);
    await initializeGitWorkspace(workspace, process.env, timeoutMs);
    await installCarrierSkill(
      workspace,
      carrier,
      process.env,
      timeoutMs,
      options.scenario === 'codex:demo',
      // 双名双壳（2026-08-27 四改）：两壳恒装,场景 prompt 用 $hopspec-mcp 具名调用——
      // 本参数只余 cc 的 --mcp 注册便利。
      options.scenario === 'codex:standalone' || options.scenario === 'cc:standalone' || options.scenario === 'codex:standalone-parallel',
    );
    if (options.scenario === 'codex:standalone' || options.scenario === 'cc:standalone' || options.scenario === 'codex:standalone-parallel') {
      // 生成临时 StandaloneConfig（api_key_env 引用形态,key 恒在 env 不落盘）+ 指向本库 dist server
      const cfgPath = join(workspace, 'hopjit-standalone.yaml');
      const service = selected.name === 'DEEPSEEK_API_KEY'
        ? { id: 'deepseek', base: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat' }
        : { id: 'zenmux', base: 'https://zenmux.ai/api/anthropic', model: 'anthropic/claude-haiku-4.5' };
      writeFileSync(cfgPath, [
        'providers:',
        `  - service_id: ${service.id}`,
        '    protocol: anthropic',
        `    base_url: ${service.base}`,
        `    model: ${service.model}`,
        `    api_key_env: ${selected.name}`,
        '',
      ].join('\n'));
      options.hopjitConfig = cfgPath;
      options.repoRoot = process.cwd();
      if (options.scenario === 'cc:standalone') {
        // CC 注册通道:--mcp-config JSON（server 进程 env 带 HOPJIT_CONFIG,与 codex -c 注册同构）
        const mcpConfigPath = join(workspace, 'hopjit-mcp.json');
        writeFileSync(mcpConfigPath, JSON.stringify({
          mcpServers: {
            hopjit: {
              command: process.execPath,
              args: [join(process.cwd(), 'dist', 'mcp-server.js')],
              env: { HOPJIT_CONFIG: cfgPath },
            },
          },
        }, null, 2));
        options.mcpConfigPath = mcpConfigPath;
      }
    }
    if (options.scenario === 'codex:standalone' || options.scenario === 'codex:standalone-parallel') {
      // Codex 注册通道:持久注册——真机实证 exec 运行时不为 -c 注入的 mcp_servers 起
      // stdio 进程（判定实验一）;且 codex 以干净 env 启动 server（只带 env 表内声明值,
      // 不继承 shell）,server 的 key fail-fast 预检 STANDALONE_KEY_MISSING 即死
      //（判定实验二:'was not ready for this step'）。故注册块须带 env_vars 按名透传
      // 凭证变量（RawMcpServerConfig.env_vars——值不落盘,只写变量名,key 安全红线不破）。
      // codex mcp add 无 env_vars flag → runner 直接追加/移除锚定 TOML 块,成对清理。
      registerCodexMcpBlock(isolatedCodexHome, options.hopjitConfig, selected.name);
    }
    const invocation = buildCarrierCommand(options.scenario, { ...options, workspace });
    // standalone 场景:HOPJIT_CONFIG 注入 carrier 进程 env——server 作为 codex 子进程继承它
    // 加载临时 StandaloneConfig（mcp_servers.hopjit.env 的 -c 覆盖同时在,双通道冗余无害）。
    const carrierEnv = {
      ...process.env,
      ...(options.hopjitConfig ? { HOPJIT_CONFIG: options.hopjitConfig } : {}),
      ...(isolatedCodexHome ? { CODEX_HOME: isolatedCodexHome } : {}),   // 载体环境自包含（todo/0061）
    };
    result = await runChildProcess(invocation.command, invocation.args, {
      cwd: workspace,
      env: carrierEnv,
      timeoutMs,
    });

    if (result.timedOut) throw new LiveE2EError(`carrier 超时（${timeoutMs}ms）`, 1);
    if (result.code !== 0) throw new LiveE2EError(`carrier 退出码 ${result.code}`, 1);

    const adapted = carrierAdapter(options.scenario, result.stdout);
    normalized = adapted.normalized;
    const workspaceText = readWorkspaceText(workspace);
    assertNoSecretLeak({
      stdout: result.stdout,
      stderr: result.stderr,
      events: JSON.stringify(normalized),
      workspace: workspaceText,
      // 临时 CODEX_HOME 同罩（设计"凭证扫描面照罩——auth.json 在内";阅卷实抓漏配:
      // 里面有宿主复制的 auth.json 与注册块 config,删前不扫=扫描面有洞）
      ...(isolatedCodexHome ? { codex_home: readWorkspaceText(isolatedCodexHome) } : {}),
    }, secrets);
    const verdict = assertScenario({
      scenario: options.scenario,
      normalized,
      finalText: adapted.finalText,
      mainText: adapted.mainText,
      workspace,
    });

    // 通过凭证落盘（.e2e-evidence/<scenario>.json，含当时 HEAD）——release.sh ④b 发版闸
    // 据此校验"双绿且新鲜"。口头纪律无机检=没有纪律（2026-08-08 实撞：agents frontmatter
    // 缺失 400 差点带版发出，E2E 只写在手册里被跳过）。// @a: anc-driver-live-e2e-evidence
    const evidenceDir = join(projectRoot, '.e2e-evidence');
    mkdirSync(evidenceDir, { recursive: true });
    // 通过场景轨迹归档（焚毁前留档,审计链可事后抽查——2026-08-09 作者定）
    let passArchive;
    try {
      passArchive = archivePassEvidence({
        workspace, scenario: options.scenario, secrets,
        evidenceRoot: evidenceDir,
      });
    } catch (archiveError) {
      process.stderr.write(`通过轨迹归档失败（不影响判定）：${archiveError instanceof Error ? archiveError.message : String(archiveError)}\n`);
    }
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf-8' }).trim();
    writeFileSync(join(evidenceDir, `${options.scenario.replace(/:/g, '-')}.json`), JSON.stringify({
      scenario: options.scenario,
      commit: head,
      passed_at: new Date().toISOString(),
      credential_env: selected.name,
      exercised_mode: verdict?.exercised,
      evidence_archive: passArchive,
    }, null, 2));

    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      scenario: options.scenario,
      credential_env: selected.name,
      instance_count: 1,
      exercised_mode: verdict?.exercised,
    })}\n`);
  } catch (error) {
    if (result) {
      process.stderr.write(`${diagnosticSummary({
        scenario: options.scenario,
        result,
        normalized,
        secrets,
      })}\n`);
    }
    // exit-1（carrier 已启动的真失败）→ 焚毁前归档现场；exit-2 前置缺失无现场可归。
    // 见 design ^anc-driver-live-e2e-isolation 失败取证契约。
    const exitCode = error instanceof LiveE2EError ? error.exitCode : 1;
    if (exitCode === 1 && workspace && existsSync(workspace)) {
      try {
        const dest = archiveFailureEvidence({
          workspace,
          scenario: options.scenario,
          result,
          normalized,
          secrets,
          evidenceRoot: join(projectRoot, '.e2e-evidence'),
        });
        process.stderr.write(`失败现场已归档（key 已脱敏）：${dest}\n`);
      } catch (archiveError) {
        process.stderr.write(`失败现场归档失败（不影响退出码）：${archiveError instanceof Error ? archiveError.message : String(archiveError)}\n`);
      }
    }
    throw error;
  } finally {
    if (isolatedCodexHome) {
      try { rmSync(isolatedCodexHome, { recursive: true, force: true }); } catch { /* 清理尽力而为——临时 home 只有配置无执行产物 */ }
    }
    cleanupWorkspace(workspace);
  }
}

main().catch(error => {
  const exitCode = error instanceof LiveE2EError ? error.exitCode : 1;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(exitCode);
});
