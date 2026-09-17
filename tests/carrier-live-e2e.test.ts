// @module: hop-cli ^anc-struct-hop-cli
// @v: anc-driver-live-e2e, anc-driver-live-e2e-isolation, anc-driver-live-e2e-events, anc-driver-live-e2e-scenarios
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HopLog } from '../src/hoplog.js';
import {
  LiveE2EError,
  assertNoSecretLeak,
  assertScenario,
  buildCarrierCommand,
  normalizeClaudeEvents,
  normalizeCodexEvents,
  parseJsonLines,
  redactSecrets,
  diagnosticSummary,
  runChildProcess,
  selectCredential,
  validateScenarioPreconditions,
  readTerminalEvidence,
  archiveFailureEvidence,
  archivePassEvidence,
  filterCodexConfigForIsolation,
  buildIsolatedCodexHome,
} from '../scripts/carrier-live-e2e-lib.mjs';

describe('carrier live E2E deterministic guard', () => {
  function terminalWorkspace(loggedSteps = ['1', '2', '3'], stateSteps = ['1', '2', '3']) {
    const workspace = mkdtempSync(join(tmpdir(), 'carrier-terminal-'));
    const instance = join(workspace, '.hopstate', 'instance-1');
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'state.json'), JSON.stringify({
      step_states: Object.fromEntries(stateSteps.map(id => [id, 'done'])),
    }));
    writeFileSync(join(instance, 'vars.json'), JSON.stringify({
      scopes: {
        root: {
          variables: {
            weekly_report: '# 本周经营周报\n- 周营业额：27600 元',
          },
        },
      },
    }));
    // G11：fixture 必须由生产 HopLog 真写，避免守卫拿自造格式自证。
    const log = new HopLog({ specId: 'coffee-week', logDir: join(workspace, '.hoplog'), title: 'T', goal: 'G' });
    for (const stepId of loggedSteps) {
      log.recordStepStart(stepId, 'act', `step ${stepId}`);
      // 深核标记随真实 coffee-week 形态:步骤2=reason(verdict)、3.2=check(report_ok)——
      // fixture 由生产 HopLog 真写,深核断言(LLM 步骤产物入轨)在守卫测试同样生效
      log.recordStepDone(stepId, stepId === '2' ? { verdict: 'ok', advice: 'a' } : { ok: true });
    }
    log.recordStepStart('3.2', 'check', 'gate');
    log.recordStepDone('3.2', { report_ok: true });
    // ask 介入点 hitl 决策入轨（2026-08-09 参数确认入 spec:coffee-week 首步 ask 确认目标）
    log.recordStepStart('0', 'ask', '确认本周数据和目标');
    log.recordStepMeta('0', { hitl: { shown: 'q', response_options: [], response: '26000', responder: 'caller', at: 'x' } });
    log.recordStepDone('0', { target_confirmed: 26000 });
    log.close('completed');
    return workspace;
  }

  it('G11 核真过程：真实 HopLog YAMLL 块键覆盖所有 done 步骤 → 绿', () => {
    const workspace = terminalWorkspace();
    expect(readTerminalEvidence(workspace).weeklyReport).toContain('周营业额：27600 元');
  });

  it('G11 核真过程：state 已 done 而 HopLog 缺该步轨迹 → 红', () => {
    const workspace = terminalWorkspace(['1', '2']);
    expect(() => readTerminalEvidence(workspace)).toThrow(/缺步骤 3/);
  });

  it('G11 核真过程：步骤 10 不得对子串步骤 1 假绿', () => {
    const workspace = terminalWorkspace(['10'], ['1']);
    expect(() => readTerminalEvidence(workspace)).toThrow(/缺步骤 1/);
  });

  it('G11 核真过程：.hoplog 整体缺失 → 红（standalone 黑箱信号）', () => {
    const workspace = terminalWorkspace();
    rmSync(join(workspace, '.hoplog'), { recursive: true });
    expect(() => readTerminalEvidence(workspace)).toThrow(/未产生 \.hoplog/);
  });

  it('parses JSONL and rejects malformed lines', () => {
    expect(parseJsonLines('{"type":"a"}\n\n{"type":"b"}\n')).toHaveLength(2);
    expect(() => parseJsonLines('{"type":"a"}\nnot-json')).toThrow(/第 2 行/);
  });

  it('normalizes Claude subagent and Bash actor events', () => {
    const events = [{
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'agent-1',
          name: 'Agent',
          input: { prompt: 'HopSpec driver segment' },
        }],
      },
    }, {
      type: 'assistant',
      parent_tool_use_id: 'agent-1',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'hopjit run examples/coffee-week.md' },
        }],
      },
    }, {
      type: 'result',
      result: 'status: completed\noutputs:\n  weekly_report: 周营业额：27600 元',
    }];

    const result = normalizeClaudeEvents(events);
    expect(result.normalized).toContainEqual(expect.objectContaining({
      type: 'subagent_start',
      role: 'segment',
    }));
    expect(result.normalized).toContainEqual({
      type: 'command',
      actor: 'subagent',
      command: 'hopjit run examples/coffee-week.md',
    });
    expect(result.finalText).toContain('status: completed');
  });

  it('normalizes Codex probe separately from formal segment', () => {
    const events = [
      { type: 'thread.started', thread_id: 'main' },
      {
        type: 'item.started',
        item: {
          type: 'collab_tool_call',
          tool: 'spawn_agent',
          prompt: 'Return HOPSPEC_AGENT_READY:nonce',
          receiver_thread_ids: ['probe'],
        },
      },
      {
        type: 'item.started',
        item: {
          type: 'collab_tool_call',
          tool: 'wait',
          sender_thread_id: 'main',
          receiver_thread_ids: ['worker'],
        },
      },
      {
        type: 'item.started',
        item: {
          type: 'collab_tool_call',
          tool: 'spawn_agent',
          prompt: 'You are a HopSpec driver segment',
          receiver_thread_ids: ['worker'],
        },
      },
      {
        type: 'item.started',
        item: {
          type: 'command_execution',
          thread_id: 'worker',
          command: 'hopjit run examples/coffee-week.md',
        },
      },
      {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          thread_id: 'main',
          text: 'status: completed\noutputs:\n  weekly_report: 周营业额：27600 元',
        },
      },
    ];

    const result = normalizeCodexEvents(events);
    expect(result.normalized.filter(event => event.type === 'subagent_start')).toEqual([
      expect.objectContaining({ role: 'probe' }),
      expect.objectContaining({ role: 'segment' }),
    ]);
    expect(result.normalized).toContainEqual({
      type: 'command',
      actor: 'subagent',
      command: 'hopjit run examples/coffee-week.md',
    });
    expect(result.normalized).toContainEqual(expect.objectContaining({
      type: 'subagent_wait',
    }));
  });

  // @v: anc-driver-live-e2e-events —— 闭合证据的 --answer 豁免正反例（2026-08-10 实撞:
  // main 仅注入 answer 被计入 writes,闭合证据'零写'判非零假红;正反例成对入法后首个新增判定）
  it('codex 闭合证据:--answer 注入不破坏零写判据（正例）;run 写命令仍破坏（反例）', () => {
    const workspace = terminalWorkspace();
    const finalText = 'status: completed\noutputs:\n  weekly_report: 周营业额：27600 元';
    const base = [
      { type: 'message', actor: 'main', text: '任务已启动,执行中。' },
      { type: 'subagent_wait', actor: 'main', role: 'segment', id: '' },
    ];
    expect(() => assertScenario({
      scenario: 'codex:delegated', workspace, finalText,
      normalized: [...base, { type: 'command', actor: 'main', command: 'node dist/cli.js submit_and_fetch_next 1 --answer \'{"value":26000}\'' }],
    })).not.toThrow();
    expect(() => assertScenario({
      scenario: 'codex:delegated', workspace, finalText,
      normalized: [...base, { type: 'command', actor: 'main', command: 'node dist/cli.js run examples/coffee-week.md' }],
    })).toThrow(/证据|main/);
  });

  // @v: anc-driver-live-e2e-events —— 终态断言吃 mainText 三撞成律（2026-08-17 cc:delegated 实撞:
  // 主 agent 先贴完整 YAML 块、又补发一条『终态如上』收尾消息把块挤出终位——delegated 通用路径
  // 与 anchor-audit 是本律定形时漏迁的最后两处存量直吃 finalText,销清归一后正反例钉住）
  it('delegated 终态:YAML 块非最后一条消息（后跟收尾人话）→仍绿;全程无 YAML→红', () => {
    const workspace = terminalWorkspace();
    const yaml = 'status: completed\noutputs:\n  weekly_report: 周营业额：27600 元';
    const trailer = '执行完成。终态 YAML 如上。';
    const base = [
      { type: 'message', actor: 'main', text: '任务已启动,执行中。' },
      { type: 'subagent_wait', actor: 'main', role: 'segment', id: '' },
      { type: 'message', actor: 'main', text: yaml },
      { type: 'message', actor: 'main', text: trailer },
    ];
    // 正例：finalText=收尾人话（覆盖语义）,mainText 聚合含 YAML → 不误红
    expect(() => assertScenario({
      scenario: 'codex:delegated', workspace, finalText: trailer, mainText: `${yaml}\n\n${trailer}`,
      normalized: base,
    })).not.toThrow();
    // 反例：全程零 YAML → 依然红（不因吃 mainText 而放水）
    expect(() => assertScenario({
      scenario: 'codex:delegated', workspace, finalText: trailer, mainText: `执行完成。全部跑通。\n\n${trailer}`,
      normalized: base,
    })).toThrow(/completed YAML/);
  });

  // @v: anc-driver-live-e2e-scenarios —— cc:call 正向场景断言正反例（2026-08-11 作者定"做"）
  it('cc:call 正向:completed+calls目录+回填规整值→绿;四种缺口各红', () => {
    function callWorkspace(opts = {}) {
      const workspace = mkdtempSync(join(tmpdir(), 'carrier-call-'));
      const instance = join(workspace, '.hopstate', 'inst-1');
      mkdirSync(instance, { recursive: true });
      writeFileSync(join(instance, 'state.json'), JSON.stringify({ step_states: { '1': 'done', '2': 'done' } }));
      writeFileSync(join(instance, 'vars.json'), JSON.stringify({
        scopes: { root: { variables: {
          clean_doc: opts.dirtyClean ? '  仍有首尾空白\n\n\n\n连续空行  ' : '第一段 有多余空格\n第二段:引擎按spec执行。\n第三段 结尾',
          summary: opts.noSummary ? '' : '文档共三段,核心是引擎按 spec 可靠执行。',
        } } },
      }));
      if (!opts.noCalls) {
        mkdirSync(join(instance, 'calls', 'child-1'), { recursive: true });
        writeFileSync(join(instance, 'calls', 'child-1', 'state.json'), '{}');
      }
      const log = new HopLog({ specId: 'call-parent-summarize', logDir: join(workspace, '.hoplog'), title: 'T', goal: 'G' });
      log.recordStepStart('1', 'call', '调用文本规整子流程');
      log.recordStepDone('1', { clean_doc: 'x' });
      log.recordStepStart('2', 'reason', '生成摘要');
      log.recordStepDone('2', { summary: 's' });
      log.close(opts.notCompleted ? 'failed' : 'completed');
      return workspace;
    }
    const finalText = 'status: completed\noutputs:\n  summary: 摘要';
    // 正例
    expect(assertScenario({ scenario: 'cc:call', workspace: callWorkspace(), finalText, normalized: [] }))
      .toEqual({ exercised: 'call' });
    // 反例1:无 calls/ 目录（call 未按协议驱动）
    expect(() => assertScenario({ scenario: 'cc:call', workspace: callWorkspace({ noCalls: true }), finalText, normalized: [] }))
      .toThrow(/calls\//);
    // 反例2:clean_doc 未经规整（回填值非子产物）
    expect(() => assertScenario({ scenario: 'cc:call', workspace: callWorkspace({ dirtyClean: true }), finalText, normalized: [] }))
      .toThrow(/未经子 spec 规整/);
    // 反例3:summary 空（回填值未被下游消费）
    expect(() => assertScenario({ scenario: 'cc:call', workspace: callWorkspace({ noSummary: true }), finalText, normalized: [] }))
      .toThrow(/summary/);
    // 反例4:终态非 completed
    expect(() => assertScenario({ scenario: 'cc:call', workspace: callWorkspace({ notCompleted: true }), finalText: '执行失败了。', normalized: [] }))
      .toThrow(/completed/);
  });

  // @v: anc-driver-codex-standalone-dispatch —— 薄协议断言正反例（2026-08-10 作者拍板拆分:
  // MCP 注册即选定,正判据=start_run 工具调用可观测,负判据=零 CLI 写命令零 subagent,成对钉死）
  it('codex:standalone 薄协议:MCP start_run 轨迹→绿;无 MCP 调用/CLI 写命令/subagent→红', () => {
    const workspace = terminalWorkspace();
    const finalText = 'status: completed\noutputs:\n  weekly_report: 周营业额：27600 元';
    const mcpTrace = [
      { type: 'mcp_tool', actor: 'main', server: 'hopjit', tool: 'start_run' },
      { type: 'mcp_tool', actor: 'main', server: 'hopjit', tool: 'run_status' },
    ];
    // 正例:纯 MCP 工具面轨迹 → exercised='standalone'
    expect(assertScenario({
      scenario: 'codex:standalone', workspace, finalText, normalized: mcpTrace,
    })).toEqual({ exercised: 'standalone' });
    // 反例1:业务结果对但零 MCP 调用（根本没走薄协议——旧假绿形态）→ 拒
    expect(() => assertScenario({
      scenario: 'codex:standalone', workspace, finalText, normalized: [],
    })).toThrow(/start_run/);
    // 反例2:观测到 hopjit CLI 写命令（inline 越界）→ 拒
    expect(() => assertScenario({
      scenario: 'codex:standalone', workspace, finalText,
      normalized: [...mcpTrace, { type: 'command', actor: 'main', command: 'node dist/cli.js run examples/coffee-week.md' }],
    })).toThrow(/CLI 写命令/);
    // 反例3改正例（f11aeb1 随销:看护 subagent 合法——^anc-driver-standalone-watch 作者 08-22 定
    // 标准范式,'零 subagent'是先于范式的过时判据;执行外包越界仍由判据2〔CLI 写命令全局扫,
    // 含 subagent 内命令〕覆盖）:subagent 在场但零 CLI 写命令 → 过
    expect(() => assertScenario({
      scenario: 'codex:standalone', workspace, finalText,
      normalized: [...mcpTrace, { type: 'subagent_start', actor: 'subagent', role: 'segment', id: 'w' }],
    })).not.toThrow();
    // 反例3':subagent 内出现 hopjit CLI 写命令（执行外包真越界）→ 仍拒
    expect(() => assertScenario({
      scenario: 'codex:standalone', workspace, finalText,
      normalized: [...mcpTrace,
        { type: 'subagent_start', actor: 'subagent', role: 'segment', id: 'w' },
        { type: 'command', actor: 'subagent', command: 'node dist/cli.js submit_and_fetch_next 1 --state-dir .hopstate' }],
    })).toThrow(/CLI 写命令/);
    // 反例4:终态非 completed YAML → 拒（同构 envelope）
    expect(() => assertScenario({
      scenario: 'codex:standalone', workspace, finalText: '任务完成了,周报如上。', normalized: mcpTrace,
    })).toThrow(/YAML/);
    // 反例5:文本判据全过但账面破坏（state 步骤 4 done 而 HopLog 无其轨迹）→ 拒（2026-08-12 review
    // 补账面核验——原版本只看文本,此形态假绿:server 进程内真实执行状况全凭终态嘴说）
    // @v: anc-driver-live-e2e-assertions —— 非空账面部分硬要求的在线侧判据
    expect(() => assertScenario({
      scenario: 'codex:standalone', workspace: terminalWorkspace(['1', '2', '3'], ['1', '2', '3', '4']), finalText, normalized: mcpTrace,
    })).toThrow(/缺步骤 4/);
  });

  it('normalizeClaudeEvents 归一 mcp__ 前缀工具调用（CC 载体 MCP 通道,与 codex 同构）', () => {
    const { normalized } = normalizeClaudeEvents([{
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'mcp__hopjit__start_run', input: {} }] },
    }]);
    expect(normalized.filter(e => e.type === 'mcp_tool')).toEqual([
      { type: 'mcp_tool', actor: 'main', server: 'hopjit', tool: 'start_run' },
    ]);
  });

  it('cc:standalone 与 codex:standalone 同一断言（载体中立薄协议）', () => {
    const workspace = terminalWorkspace();
    const finalText = 'status: completed\noutputs:\n  weekly_report: 周营业额：27600 元';
    const mcpTrace = [
      { type: 'mcp_tool', actor: 'main', server: 'hopjit', tool: 'start_run' },
    ];
    expect(assertScenario({
      scenario: 'cc:standalone', workspace, finalText, normalized: mcpTrace,
    })).toEqual({ exercised: 'standalone' });
    // mainText 优先:finalText 被 task-notification 补话覆盖时仍绿（CC 已知形态）
    expect(assertScenario({
      scenario: 'cc:standalone', workspace, finalText: '任务已全部完成。',
      mainText: finalText, normalized: mcpTrace,
    })).toEqual({ exercised: 'standalone' });
  });

  it('normalizeCodexEvents 归一 mcp_tool_call 事件（server/tool 字段保留）', () => {
    const { normalized } = normalizeCodexEvents([
      { type: 'thread.started', thread_id: 'root-1' },
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'hopjit', tool: 'start_run', thread_id: 'root-1' } },
    ]);
    const mcp = normalized.filter(e => e.type === 'mcp_tool');
    expect(mcp).toEqual([{ type: 'mcp_tool', actor: 'main', server: 'hopjit', tool: 'start_run' }]);
  });

  it('accepts Codex delegated closed evidence when worker internals are not forwarded', () => {
    const workspace = terminalWorkspace();
    expect(() => assertScenario({
      scenario: 'codex:delegated',
      workspace,
      finalText: 'status: completed\noutputs:\n  weekly_report: 周营业额：27600 元',
      normalized: [
        { type: 'message', actor: 'main', text: 'segment 已启动。' },
        { type: 'subagent_wait', actor: 'main', role: 'segment', id: '' },
      ],
    })).not.toThrow();
  });

  // @v: anc-driver-live-e2e-events —— main 写禁令的 --answer 豁免（2026-08-09 coffee-week 加 ask 后:
  // paused 注入按 skill 协议归 main 本职,断言曾误判'抢执行链'实红两场景）。正反例成对。
  it('delegated: main 的 --answer 介入点注入豁免（正例）;非 answer 写命令仍拒（反例）', () => {
    const workspace = terminalWorkspace();
    const finalText = 'status: completed\noutputs:\n  weekly_report: 周营业额：27600 元';
    // 正例:main 只有 --answer 注入 → 绿
    expect(() => assertScenario({
      scenario: 'cc:delegated', workspace, finalText,
      normalized: [
        { type: 'subagent_start', actor: 'subagent', role: 'segment', id: 'w' },
        { type: 'command', actor: 'subagent', command: 'node dist/cli.js submit_and_fetch_next 2 --output "@x"' },
        { type: 'command', actor: 'main', command: 'node dist/cli.js submit_and_fetch_next 1 --answer \'{"value":26000}\'' },
      ],
    })).not.toThrow();
    // 反例:main 跑 run（抢执行链）→ 拒,豁免不外溢
    expect(() => assertScenario({
      scenario: 'cc:delegated', workspace, finalText,
      normalized: [
        { type: 'subagent_start', actor: 'subagent', role: 'segment', id: 'w' },
        { type: 'command', actor: 'main', command: 'node dist/cli.js run examples/coffee-week.md' },
      ],
    })).toThrow(/main/);
    // 反例:main 提交执行步 --output → 拒（--answer 之外的 submit 也是执行链）
    expect(() => assertScenario({
      scenario: 'cc:delegated', workspace, finalText,
      normalized: [
        { type: 'subagent_start', actor: 'subagent', role: 'segment', id: 'w' },
        { type: 'command', actor: 'subagent', command: 'node dist/cli.js submit_and_fetch_next 3 --output "@y"' },
        { type: 'command', actor: 'main', command: 'node dist/cli.js submit_and_fetch_next 2 --output "@x"' },
      ],
    })).toThrow(/main/);
  });

  it('rejects delegated main writes and inline duplicate runs', () => {
    const workspace = terminalWorkspace();
    const finalText = 'status: completed\noutputs:\n  weekly_report: 周营业额：27600 元';
    expect(() => assertScenario({
      scenario: 'codex:delegated',
      workspace,
      finalText,
      normalized: [
        { type: 'subagent_start', actor: 'subagent', role: 'segment', id: 'worker' },
        { type: 'command', actor: 'main', command: 'hopjit run examples/coffee-week.md' },
      ],
    })).toThrow(/main/);
    expect(() => assertScenario({
      scenario: 'codex:flash',
      workspace,
      finalText,
      normalized: [
        { type: 'command', actor: 'main', command: 'hopjit run examples/coffee-week.md' },
        { type: 'command', actor: 'main', command: 'hopjit run examples/coffee-week.md' },
      ],
    })).toThrow(/恰为 1 次/);
  });

  it('flash 闭合证据分支：collab 流只见 wait 无 spawn_agent（codex 新版转发缺口）→ delegated-closed 绿；wait 在场但 main 有写命令 → 不豁免（2026-08-13 真机误红实撞）', () => {
    const workspace = terminalWorkspace();
    const finalText = 'status: completed\noutputs:\n  weekly_report: 周营业额：27600 元';
    // 正例：wait+零写命令 → 闭合证据 delegated
    expect(assertScenario({
      scenario: 'codex:flash', workspace, finalText,
      normalized: [
        { type: 'subagent_wait', actor: 'main', role: 'segment', id: '' },
        { type: 'command', actor: 'main', command: 'cat examples/coffee-week.md' },
      ],
    })).toEqual({ exercised: 'delegated-closed' });
    // 反例：wait 在场但 main 亲自写 HopJIT → 闭合证据不成立,落 inline 判据仍红（豁免不过度）
    expect(() => assertScenario({
      scenario: 'codex:flash', workspace, finalText,
      normalized: [
        { type: 'subagent_wait', actor: 'main', role: 'segment', id: '' },
        { type: 'command', actor: 'main', command: 'hopjit submit_and_fetch_next 1 --output foo' },
      ],
    })).toThrow(/恰为 1 次/);
  });

  // @v: anc-driver-live-e2e-scenarios —— 模式自适应断言（2026-08-08 作者定：判据不预设物理模式）
  it('flash scenario adapts: delegated when spawn works, inline when it does not', () => {
    const workspace = terminalWorkspace();
    const finalText = 'status: completed\noutputs:\n  weekly_report: 周营业额：27600 元';
    // spawn 起得来 → delegated（正式 segment 出现、main 零写命令）
    const verdict = assertScenario({
      scenario: 'codex:flash',
      workspace,
      finalText,
      normalized: [
        { type: 'subagent_start', actor: 'subagent', role: 'segment', id: 'worker' },
        { type: 'command', actor: 'subagent', command: 'hopjit run examples/coffee-week.md' },
      ],
    });
    expect(verdict).toEqual({ exercised: 'delegated' });
    // 但 delegated 姿态下 main 亲自写 HopJIT 仍判红
    expect(() => assertScenario({
      scenario: 'codex:flash',
      workspace,
      finalText,
      normalized: [
        { type: 'subagent_start', actor: 'subagent', role: 'segment', id: 'worker' },
        { type: 'command', actor: 'main', command: 'hopjit run examples/coffee-week.md' },
      ],
    })).toThrow(/main 不得执行/);
    // spawn 起不来 → inline：main 恰一次 run → exercised: inline
    const inlineVerdict = assertScenario({
      scenario: 'codex:flash',
      workspace,
      finalText,
      normalized: [
        { type: 'command', actor: 'main', command: 'hopjit run examples/coffee-week.md' },
      ],
    });
    expect(inlineVerdict).toEqual({ exercised: 'inline' });
  });

  it('fails with exit 2 when credential is missing; flash does not require profile precondition', () => {
    expect(() => selectCredential('cc:delegated', {}, undefined))
      .toThrowError(expect.objectContaining<Partial<LiveE2EError>>({ exitCode: 2 }));
    // codex:flash 无 profile 硬前置（e2e-all 缺省给 deepseek-v4-flash，可覆盖）
    expect(() => validateScenarioPreconditions('codex:flash', {})).not.toThrow();
    // codex:standalone 已转正（薄协议场景）——前置只需凭证,不再恒 exit 2
    expect(() => validateScenarioPreconditions('codex:standalone', {})).not.toThrow();
  });

  // @v: anc-driver-codex-capability-gate —— 直发能力门级 1 的 e2e 触发通道
  it('codex:flash shares the delegated tool surface (no suppression, mode follows environment)', () => {
    const flash = buildCarrierCommand('codex:flash', { workspace: '/w' });
    const delegated = buildCarrierCommand('codex:delegated', { workspace: '/w' });
    // 命题反转（2026-08-08 作者定）：flash 测弱模型长程，不测降级路径——工具面与 delegated 一致
    expect(flash.args).toContain('agents.enabled=true');
    expect(flash.args).toContain('multi_agent_v2');
    expect(delegated.args).toContain('agents.enabled=true');
  });

  // @v: anc-driver-live-e2e-scenarios —— 委派工具必须直接暴露；standalone 不启用
  it.each(['codex:delegated', 'codex:flash', 'codex:demo', 'codex:parallel'])(
    '%s exposes delegation outside functions.exec', (scenario) => {
      const { args } = buildCarrierCommand(scenario, { workspace: '/w' });
      expect(args).toContain('features.multi_agent_v2.non_code_mode_only=true');
      expect(args).not.toContain('features.multi_agent_v2.non_code_mode_only=false');
      expect(args).toContain('features.multi_agent_v2.tool_namespace="agents"');
    },
  );

  it.each(['codex:standalone', 'codex:standalone-parallel'])(
    '%s keeps delegation disabled', (scenario) => {
      const { args } = buildCarrierCommand(scenario, { workspace: '/w' });
      expect(args).toContain('agents.enabled=false');
      expect(args).toContain('features.multi_agent_v2=false');
      expect(args.some(arg => arg.includes('non_code_mode_only'))).toBe(false);
    },
  );

  it('invokes the claude-ds shell function without interpolating prompt arguments', () => {
    const invocation = buildCarrierCommand('cc:delegated', { launcher: 'claude-ds' });
    expect(invocation.command).toBe('zsh');
    expect(invocation.args.slice(0, 3)).toEqual([
      '-ic',
      'claude-ds "$@"',
      'carrier-live-e2e',
    ]);
    expect(invocation.args.at(-1)).toContain('$hopspec run examples/coffee-week.md');
  });

  it('allows Codex to run inside the isolated non-git workspace', () => {
    const invocation = buildCarrierCommand('codex:delegated', { workspace: '/tmp/e2e' });
    expect(invocation.args).toContain('--skip-git-repo-check');
    expect(invocation.args).toContain('workspace-write');
  });

  it('invokes the installed Codex demo explicitly as $demo-coffee-week', () => {
    const invocation = buildCarrierCommand('codex:demo', { workspace: '/tmp/e2e' });
    expect(invocation.args.at(-1)).toContain('$demo-coffee-week');
    expect(invocation.args.at(-1)).toContain('coffee-sales.json');
    expect(invocation.args.at(-1)).not.toContain('$hopspec run');
  });

  it('redacts diagnostics and rejects a key found in artifacts', () => {
    const key = 'temporary-secret-key';
    expect(redactSecrets(`error ${key}`, [key])).toBe('error [REDACTED]');
    expect(() => assertNoSecretLeak({ stdout: 'ok', workspace: `value=${key}` }, [key]))
      .toThrow(/workspace/);

    const dir = mkdtempSync(join(tmpdir(), 'carrier-leak-test-'));
    mkdirSync(join(dir, '.hopstate'), { recursive: true });
    writeFileSync(join(dir, '.hopstate', 'artifact.txt'), key);
    expect(() => assertNoSecretLeak({ artifact: key }, [key])).toThrow(/artifact/);
    const diagnostic = diagnosticSummary({
      scenario: 'cc:delegated',
      result: {
        code: 1,
        signal: null,
        timedOut: false,
        stdout: `provider error ${key}`,
        stderr: '',
      },
      normalized: [],
      secrets: [key],
    });
    expect(diagnostic).toContain('[REDACTED]');
    expect(diagnostic).not.toContain(key);
  });

  it('terminates a timed-out process instead of leaving it running', async () => {
    const result = await runChildProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 100 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });
});

// @v: anc-driver-live-e2e-isolation —— 失败取证契约（2026-08-08 增补:焚毁前归档+key 脱敏）
// @v: anc-driver-live-e2e-scenarios —— 失败路径场景组断言（2026-08-09 作者定 12345）
describe('失败路径场景断言（确定性守卫）', () => {
  function failureWorkspace({ stepStates, variables, retryHistory, terminalFailure, failReasons, withCalls, hoplog }: {
    stepStates: Record<string, string>;
    variables?: Record<string, unknown>;
    retryHistory?: Record<string, unknown[]>;
    terminalFailure?: { stepId: string; reason: string };
    failReasons?: Record<string, { reason: string; fail_kind: string }>;
    withCalls?: boolean;
    // G11：轨迹 fixture 由生产 HopLog 真写（禁手捏另一套格式）——脚本化调用序列
    hoplog?: (log: HopLog) => void;
  }) {
    const workspace = mkdtempSync(join(tmpdir(), 'carrier-failure-'));
    const instance = join(workspace, '.hopstate', 'instance-1');
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'state.json'), JSON.stringify({
      step_states: stepStates,
      ...(retryHistory ? { retry_history: retryHistory } : {}),
      ...(terminalFailure ? { terminal_failure: terminalFailure } : {}),
      ...(failReasons ? { step_fail_reasons: failReasons } : {}),
    }));
    writeFileSync(join(instance, 'vars.json'), JSON.stringify({
      scopes: { root: { variables: variables ?? {} } },
    }));
    if (withCalls) mkdirSync(join(instance, 'calls', '1'), { recursive: true });
    if (hoplog) {
      const log = new HopLog({ specId: 'failure-fixture', logDir: join(workspace, '.hoplog'), title: 'T', goal: 'G' });
      hoplog(log);
    }
    return workspace;
  }

  // 各场景合规轨迹的生产 HopLog 调用序列（绿 fixture 共用）
  const REPAIR_LOG = (log: HopLog) => {
    log.recordStepStart('3.1', 'act', '组装');
    log.recordStepDone('3.1', { weekly_report: 'v1' });
    log.recordStepStart('3.2', 'check', '核验');
    log.recordStepFailed('3.2', 'CHECK_FAILED: 周报缺少数据复核区块，须补上');
    log.recordStepStart('3.1', 'act', '组装');       // 轮次 #2
    log.recordStepDone('3.1', { weekly_report: 'v2 含复核' });
    log.recordStepStart('3.2', 'check', '核验');     // 轮次 #2
    log.recordStepDone('3.2', { report_ok: true });
    log.close('completed');
  };
  const UNCAUGHT_LOG = (log: HopLog) => {
    log.recordStepStart('1', 'act', '记录标签长度');
    log.recordStepDone('1', { label_len: 11 });
    log.recordStepStart('2', 'act', '翻倍');
    log.recordWarn('2', '计算异常: "north-store" 不可转数字（运算 *）→ None');
    log.recordStepFailed('2', '计算异常: ...');
    log.close('failed');
  };
  const PARTIAL_LOG = (log: HopLog) => {
    // 统一模型（P2+P1）：逐个 dispatch 块入轨（渐进派发）+ reap 块（随到随收,失败收割凭据位——
    // 2026-08-11 断言随 §U3 三契约①迁移:父账恒 done,失败凭据=reap:failed 块）
    log.recordParallelDispatch('1', '1.1.1', '');
    log.recordParallelDispatch('1', '1.1.2', '');
    log.recordParallelDispatch('1', '1.1.3', '');
    log.recordParallelReap('1', '1.1.1', 'completed');
    log.recordParallelReap('1', '1.1.2', 'failed');
    log.recordParallelReap('1', '1.1.3', 'completed');
    log.recordStepStart('2', 'act', '汇总');
    log.recordStepDone('2', { summary: 'collected=2' });
    log.close('completed');
  };
  const PAUSED_LOG = (log: HopLog) => {
    log.recordStepStart('1', 'act', '统计');
    log.recordStepDone('1', { total: 27600 });
    log.recordStepStart('2', 'confirm', '批准发布周报');
    // 停在介入点：无 hitl 决策块、不 close
  };
  const CALLFAIL_LOG = (log: HopLog) => {
    log.recordStepStart('1', 'call', '调用子流程');
    log.recordStepFailed('1', 'CalleeFailure: {"callee_spec_id":"e2e-call-child",...}');
    log.close('failed');
  };

  it('cc:repair 绿:completed+复核区块+retry_history 非空;红:无重试账', () => {
    const green = failureWorkspace({
      stepStates: { '1': 'done', '2': 'done', '3': 'done' },
      variables: { weekly_report: '# 周报\n## 数据复核\n已复核' },
      retryHistory: { '3': [{ attempt: 1, failure_reason: 'CHECK_FAILED: 缺区块' }] },
      hoplog: REPAIR_LOG,
    });
    expect(() => assertScenario({
      scenario: 'cc:repair', workspace: green,
      finalText: 'status: completed\noutputs:\n  weekly_report: ...',
      normalized: [],
    })).not.toThrow();

    const noRetry = failureWorkspace({
      stepStates: { '1': 'done' },
      variables: { weekly_report: '## 数据复核' },
      hoplog: REPAIR_LOG,
    });
    expect(() => assertScenario({
      scenario: 'cc:repair', workspace: noRetry,
      finalText: 'status: completed', normalized: [],
    })).toThrow(/retry_history/);
  });

  it('cc:uncaught 绿:failed+skipped+label_len 保留+terminal_failure;红:步骤3被执行', () => {
    const base = {
      variables: { label_len: 11 },
      terminalFailure: { stepId: '2', reason: '计算异常: ...' },
    };
    const green = failureWorkspace({
      ...base, stepStates: { '1': 'done', '2': 'failed', '3': 'skipped' }, hoplog: UNCAUGHT_LOG,
    });
    expect(() => assertScenario({
      scenario: 'cc:uncaught', workspace: green,
      finalText: 'status: failed\nreason: 计算异常: "north-store" 不可转数字',
      normalized: [],
    })).not.toThrow();

    const ran3 = failureWorkspace({
      ...base, stepStates: { '1': 'done', '2': 'failed', '3': 'done' }, hoplog: UNCAUGHT_LOG,
    });
    expect(() => assertScenario({
      scenario: 'cc:uncaught', workspace: ran3,
      finalText: 'status: failed\nreason: 计算异常', normalized: [],
    })).toThrow(/skipped/);
  });

  it('cc:parallel-partial 绿:列表长2无null;红:含null(旧失败槽语义复活)', () => {
    // 账形随统一模型（2026-08-11）：父账恒 done+skipped（派发即推进），失败凭据在 reap 块
    const green = failureWorkspace({
      stepStates: { '1': 'done', '1.1': 'done', '1.1.1': 'skipped', '2': 'done' },
      variables: { doubled_list: [6400, 8200], summary: 'collected=2' },
      hoplog: PARTIAL_LOG,
    });
    expect(() => assertScenario({
      scenario: 'cc:parallel-partial', workspace: green,
      finalText: 'status: completed', normalized: [],
    })).not.toThrow();

    const withNull = failureWorkspace({
      stepStates: { '1': 'done', '1.1': 'done', '1.1.1': 'skipped', '2': 'done' },
      variables: { doubled_list: [6400, null, 8200], summary: 'collected=2' },
      hoplog: PARTIAL_LOG,
    });
    expect(() => assertScenario({
      scenario: 'cc:parallel-partial', workspace: withNull,
      finalText: 'status: completed', normalized: [],
    })).toThrow(/长度 2|null/);

    // 新反例（断言迁移 2026-08-11）：父账出现 failed child=旧通道账形复活/主线被拖垮——即红
    const parentFailed = failureWorkspace({
      stepStates: { '1': 'done', '1.1': 'done', '1.1.1': 'failed', '2': 'done' },
      variables: { doubled_list: [6400, 8200], summary: 'collected=2' },
      hoplog: PARTIAL_LOG,
    });
    expect(() => assertScenario({
      scenario: 'cc:parallel-partial', workspace: parentFailed,
      finalText: 'status: completed', normalized: [],
    })).toThrow(/父账出现 failed/);
  });

  it('cc:paused 绿:无终态无answer;红:观测到 --answer 替答', () => {
    const green = failureWorkspace({
      stepStates: { '1': 'done', '2': 'running' },
      variables: { total: 27600 },
      hoplog: PAUSED_LOG,
    });
    expect(() => assertScenario({
      scenario: 'cc:paused', workspace: green,
      finalText: '有一处需要你确认：批准发布周报（周营业额 27600 元）',
      normalized: [],
    })).not.toThrow();

    expect(() => assertScenario({
      scenario: 'cc:paused', workspace: green,
      finalText: '已确认',
      normalized: [{ type: 'command', actor: 'subagent', command: 'node cli.js submit_and_fetch_next 2 --answer \'{"value":"approve"}\'' }],
    })).toThrow(/替答/);
  });

  it('过程轨迹缺失即红:state 全对但无 .hoplog → 拒绿（G11 核真过程）', () => {
    const noLog = failureWorkspace({
      stepStates: { '1': 'done', '2': 'failed', '3': 'skipped' },
      variables: { label_len: 11 },
      terminalFailure: { stepId: '2', reason: '计算异常: ...' },
      // 无 hoplog——终态全对但过程不可核
    });
    expect(() => assertScenario({
      scenario: 'cc:uncaught', workspace: noLog,
      finalText: 'status: failed\nreason: 计算异常', normalized: [],
    })).toThrow(/\.hoplog|轨迹/);
  });

  it('repair 一次跑就绿即红:无轮次键 → 重试未真实演练（G11）', () => {
    const oneShot = failureWorkspace({
      stepStates: { '1': 'done', '2': 'done', '3': 'done' },
      variables: { weekly_report: '## 数据复核' },
      retryHistory: { '3': [{ attempt: 1, failure_reason: 'CHECK_FAILED: x' }] },
      hoplog: (log) => {   // 只有一轮:失败块在但无 #2 轮次键
        log.recordStepStart('3.2', 'check', '核验');
        log.recordStepFailed('3.2', 'CHECK_FAILED: 缺区块');
        log.close('completed');
      },
    });
    expect(() => assertScenario({
      scenario: 'cc:repair', workspace: oneShot,
      finalText: 'status: completed', normalized: [],
    })).toThrow(/轮次|#2/);
  });

  // @v: anc-exec-retry-adaptive, anc-exec-adaptive-pipeline —— cc:adaptive 断言判据（新增 live 场景断言必有 vitest 判据,G13 纪律）
  it('cc:adaptive 绿:replan_audit+候选文件+新children轨迹+completed全过;红:各判据单独缺失', () => {
    const finalText = 'status: completed';
    const ADAPTIVE_LOG = (log: HopLog) => {
      log.recordStepStart('1', 'subtask', '汇总金额');
      log.recordStepStart('1.1', 'act', '直接累加');
      log.recordWarn('1.1', '计算异常: {"value":3200,"currency":"CNY"} 不可转数字（运算 +）→ None');
      log.recordStepFailed('1.1', '计算异常', 'error');
      log.recordStepStart('1.1', 'act', '直接累加');   // 第二轮（带反馈重跑）
      log.recordStepFailed('1.1', '计算异常', 'error');
      log.recordReplanAudit({ spec_id: 'e2e-adaptive', step_id: '1', error_reason: '计算异常: amount 变嵌套对象', generated_children: [], base: 'scratch', at: '2026-08-13T00:00:00Z' });
      log.recordStepStart('1.1', 'act', '取内层 value 累加');  // replan 后新 children
      log.recordStepDone('1.1', { total: 9600 });
      log.recordStepDone('1', { total: 9600 });
      log.close('completed');
    };
    function adaptiveWorkspace(opts: { noCandidate?: boolean; noAudit?: boolean } = {}) {
      const ws = failureWorkspace({
        stepStates: { '1': 'done', '1.1': 'done', '2': 'done' },
        variables: { total: 9600 },
        hoplog: opts.noAudit
          ? (log: HopLog) => { log.recordStepStart('1', 'subtask', 's'); log.recordStepStart('1.1', 'act', 'a'); log.recordStepStart('1.2', 'act', 'b'); log.recordStepDone('1.2', {}); log.close('completed'); }
          : ADAPTIVE_LOG,
      });
      if (!opts.noCandidate) {
        const dir = join(ws, 'examples', 'e2e-failure', 'e2e-adaptive.replan');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, '1.v1.md'), '%% @trace\n\tid: replan-x\n%%\n1. [act] 新步骤\n');
      }
      return ws;
    }
    // 绿：五判据全过
    expect(assertScenario({ scenario: 'cc:adaptive', workspace: adaptiveWorkspace(), finalText, normalized: [] }))
      .toEqual({ exercised: 'adaptive-completed' });
    // 红①：无 replan_audit 块
    expect(() => assertScenario({ scenario: 'cc:adaptive', workspace: adaptiveWorkspace({ noAudit: true }), finalText, normalized: [] }))
      .toThrow(/replan_audit/);
    // 红②：候选文件缺失（缺口1交付的真机核证半边）
    expect(() => assertScenario({ scenario: 'cc:adaptive', workspace: adaptiveWorkspace({ noCandidate: true }), finalText, normalized: [] }))
      .toThrow(/候选文件/);
  });

  it('cc:call-fail 绿:CalleeFailure 内核原封;红:--failure 文本转述', () => {
    const calleeReason = 'CalleeFailure: {"callee_spec_id":"e2e-call-child","child_instance":"1","failed_step":"1","reason":"计算异常: ...","fail_kind":"error","attempts":0}';
    const green = failureWorkspace({
      stepStates: { '1': 'failed' },
      failReasons: { '1': { reason: calleeReason, fail_kind: 'error' } },
      terminalFailure: { stepId: '1', reason: calleeReason },
      withCalls: true,
      hoplog: CALLFAIL_LOG,
    });
    expect(() => assertScenario({
      scenario: 'cc:call-fail', workspace: green,
      finalText: 'status: failed\nreason: CalleeFailure ...',
      normalized: [{ type: 'command', actor: 'subagent', command: 'node cli.js submit_and_fetch_next 1 --failure-child 1' }],
    })).not.toThrow();

    const freeText = failureWorkspace({
      stepStates: { '1': 'failed' },
      failReasons: { '1': { reason: '子流程失败了', fail_kind: 'error' } },
      withCalls: true,
      hoplog: (log) => { log.recordStepStart('1', 'call', '调用'); log.recordStepFailed('1', '子流程失败了'); log.close('failed'); },
    });
    expect(() => assertScenario({
      scenario: 'cc:call-fail', workspace: freeText,
      finalText: 'status: failed',
      normalized: [{ type: 'command', actor: 'subagent', command: 'node cli.js submit_and_fetch_next 1 --failure "子流程失败了"' }],
    })).toThrow(/CalleeFailure/);
  });

  it('parallel 冒烟断言吃 mainText：终态 YAML 在前补话在后 → 绿（2026-08-12 真机实撞:该断言漏配 mainText 误红）', () => {
    const workspace = failureWorkspace({
      stepStates: { '1': 'done', '1.1': 'done', '2': 'done' },
      variables: { doubled_list: [6400, 5600, 8200], summary: 'collected=3' },
      hoplog: (log: HopLog) => {
        log.recordParallelDispatch('1', '1.1.1', '');
        log.recordParallelDispatch('1', '1.1.2', '');
        log.recordParallelDispatch('1', '1.1.3', '');
        log.close('completed');
      },
    });
    const mainText = 'status: completed\noutputs:\n  doubled_list: [6400, 5600, 8200]\n\nWorker 1.1.3 也确认 completed。';
    expect(assertScenario({
      scenario: 'cc:parallel', workspace,
      finalText: 'Worker 1.1.3 也确认 completed——主线早已合并全部结果。',   // 补话覆盖最后一条
      mainText, normalized: [],
    })).toEqual({ exercised: 'parallel-smoke' });
    // 反例成对:mainText 也无终态 YAML(真没跑完)→ 仍红,豁免不过度
    expect(() => assertScenario({
      scenario: 'cc:parallel', workspace,
      finalText: '还在跑。', mainText: '还在跑。', normalized: [],
    })).toThrow(/completed/);
  });
});

// @v: anc-driver-live-e2e-scenarios —— cc:anchor-audit 复杂流程断言 + passes 归档（2026-08-09）
describe('cc:anchor-audit 断言与 passes 归档（确定性守卫）', () => {
  function auditWorkspace({ withDefectsInReport = true, workerModules = ['alpha', 'beta'], hitl = 2, reportOnly = true }: {
    withDefectsInReport?: boolean; workerModules?: string[]; hitl?: number; reportOnly?: boolean;
  } = {}) {
    const workspace = mkdtempSync(join(tmpdir(), 'carrier-audit-'));
    const instance = join(workspace, '.hopstate', 'instance-1');
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'state.json'), JSON.stringify({ step_states: { '1': 'done' } }));
    writeFileSync(join(instance, 'vars.json'), JSON.stringify({ scopes: { root: { variables: {} } } }));
    // 审计产物
    const auditDir = join(workspace, 'fixture', '.anchor-audit');
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, 'report.md'),
      withDefectsInReport ? '# 报告\n缺失: anc-string-escape-control 与 anc-string-locale' : '# 报告\n全部通过');
    writeFileSync(join(auditDir, 'semantic_audit_summary.yaml'), 'audited_at: x\n');
    writeFileSync(join(auditDir, 'cross_compare_results.yaml'), 'summary: {}\n');
    for (const mod of ['alpha', 'beta']) writeFileSync(join(auditDir, `batch_${mod}_results.yaml`), `module: ${mod}\n`);
    // 主 HopLog（真 HopLog 写,debug 级带 prompt——模拟 doc-ref 注入与数据流标记）
    const log = new HopLog({ specId: 'anchor-audit', logDir: join(workspace, '.hoplog'), title: 'T', goal: 'G', level: 'debug' });
    log.recordStepStart('4.2', 'reason', '解读比对', undefined,
      '═══ L2. 知识 ═══\n- 来源: anchor-audit-knowledge《结构比对判据》\n  作用: 作者指定的必读知识——本步背景教材\n  内容: |\n    语义审计维度判据\n    读 cross_compare_results.yaml');
    log.recordStepDone('4.2', { report_md: 'x' });
    for (let i = 0; i < hitl; i++) {
      log.recordStepStart(String(2 + i * 5), 'ask', `介入点${i}`);
      log.recordStepMeta(String(2 + i * 5), { hitl: { shown: 'q', response_options: [], response: i === 0 ? 'approve' : (reportOnly ? 'report_only' : 'auto_fix'), responder: 'caller', at: 'x' } });
      log.recordStepDone(String(2 + i * 5), {});
    }
    // 统一模型（P2）：dispatch 块逐个入轨（渐进派发），join 块随旧通道退役
    log.recordParallelDispatch('5.2', '5.2.1.1', '');
    log.recordParallelDispatch('5.2', '5.2.1.2', '');
    log.close('completed');
    // worker 子日志（各含本模块 batch,不含另一模块）
    const mainRun = readdirSync(join(workspace, '.hoplog'))[0];
    workerModules.forEach((mod, i) => {
      const childLogDir = join(workspace, '.hoplog', mainRun, 'parallel', `5.2.${i + 1}`, 'log');
      mkdirSync(childLogDir, { recursive: true });
      const wlog = new HopLog({ specId: 'anchor-audit', logDir: childLogDir, title: 'T', goal: 'G', level: 'debug' });
      wlog.recordStepStart('5.2.1.1', 'reason', '审计单批', undefined,
        `batch:\n  module: ${mod}\n═══ L2. 知识 ═══\n- 来源: anchor-audit-knowledge《结构比对判据》\n  作用: 作者指定的必读知识\n  内容: |\n    语义审计维度判据…`);
      wlog.recordStepDone('5.2.1.1', {});
      wlog.close('completed');
    });
    return workspace;
  }

  it('绿:产物+召回+hitl×2+join+批隔离全过', () => {
    const workspace = auditWorkspace();
    expect(() => assertScenario({
      scenario: 'cc:anchor-audit', workspace,
      finalText: 'status: completed\noutputs:\n  report_path: ...', normalized: [],
    })).not.toThrow();
  });

  it('红:report 未抓到埋设缺陷 → 召回失败', () => {
    const workspace = auditWorkspace({ withDefectsInReport: false });
    expect(() => assertScenario({
      scenario: 'cc:anchor-audit', workspace,
      finalText: 'status: completed', normalized: [],
    })).toThrow(/召回/);
  });

  it('红:worker prompt 串模块 → 批隔离违规', () => {
    const workspace = auditWorkspace({ workerModules: ['alpha', 'alpha'] });   // 第2个worker也是alpha批
    expect(() => assertScenario({
      scenario: 'cc:anchor-audit', workspace,
      finalText: 'status: completed', normalized: [],
    })).toThrow(/隔离|两批/);
  });

  it('archivePassEvidence:归档.hoplog+脱敏+滚动保留3份', () => {
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'pass-evidence-'));
    const SECRET = 'sk-test-pass-archive-secret-123456';
    for (let i = 0; i < 5; i++) {
      const workspace = mkdtempSync(join(tmpdir(), `pass-ws-${i}-`));
      mkdirSync(join(workspace, '.hoplog', 'run-1'), { recursive: true });
      writeFileSync(join(workspace, '.hoplog', 'run-1', 'main.yaml'), `spec_id: t\nkey: ${SECRET}\n`);
      const dest = archivePassEvidence({ workspace, scenario: 'cc:delegated', secrets: [SECRET], evidenceRoot });
      expect(existsSync(join(dest, '.hoplog', 'run-1', 'main.yaml'))).toBe(true);
      expect(readFileSync(join(dest, '.hoplog', 'run-1', 'main.yaml'), 'utf-8')).not.toContain(SECRET);
    }
    const kept = readdirSync(join(evidenceRoot, 'passes')).filter(n => n.startsWith('cc-delegated-'));
    expect(kept.length).toBe(3);   // 滚动保留最近 3 份
  });

  it('滚动保留兄弟判定不吃前缀场景:cc:call 归档不因 cc-call-fail-* 在场被误删（2026-08-12 真机实撞:刚归档即蒸发,凭证指向空目录）', () => {
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'pass-evidence-prefix-'));
    // 预置 3 份 cc-call-fail 归档（时间戳字母序在 cc-call-2026 之后——数字<字母,cc-call 新归档排最前）
    mkdirSync(join(evidenceRoot, 'passes'), { recursive: true });
    for (const stamp of ['2026-08-11T11-00-00-000Z', '2026-08-11T12-00-00-000Z', '2026-08-12T08-00-00-000Z']) {
      mkdirSync(join(evidenceRoot, 'passes', `cc-call-fail-${stamp}`), { recursive: true });
    }
    const workspace = mkdtempSync(join(tmpdir(), 'pass-ws-call-'));
    mkdirSync(join(workspace, '.hoplog', 'run-1'), { recursive: true });
    writeFileSync(join(workspace, '.hoplog', 'run-1', 'main.yaml'), 'spec_id: t\n');
    const dest = archivePassEvidence({ workspace, scenario: 'cc:call', secrets: [], evidenceRoot });
    expect(existsSync(dest)).toBe(true);                              // 修复前:被当 cc-call-fail 的最旧兄弟当场删除
    const fails = readdirSync(join(evidenceRoot, 'passes')).filter(n => n.startsWith('cc-call-fail-'));
    expect(fails.length).toBe(3);                                     // 非兄弟场景零波及
  });
});

describe('archiveFailureEvidence 失败现场归档', () => {
  const SECRET = 'sk-test-supersecret-value-123456';

  function failedWorkspace() {
    const workspace = mkdtempSync(join(tmpdir(), 'carrier-fail-'));
    // 两个实例(弃跑重开的典型现场) + hoplog 轨迹,其中混入 secret 验证脱敏
    for (const inst of ['inst-a', 'inst-b']) {
      const dir = join(workspace, '.hopstate', inst);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ step_states: { '1': 'done' } }));
      writeFileSync(join(dir, 'vars.json'), JSON.stringify({ note: `key=${SECRET}` }));
    }
    const runDir = join(workspace, '.hoplog', 'run-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'main.yaml'), `spec_id: t\nexecution:\n  "1":\n    note: ${SECRET}\n`);
    return workspace;
  }

  it('归档 .hopstate/.hoplog/完整 stdio/事件,且全部 secret 被脱敏', () => {
    const workspace = failedWorkspace();
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'evidence-'));
    const dest = archiveFailureEvidence({
      workspace,
      scenario: 'codex:flash',
      result: { stdout: `early context ${SECRET} then failure`, stderr: 'boom' },
      normalized: [{ type: 'command', command: `run --key ${SECRET}` }],
      secrets: [SECRET],
      evidenceRoot,
    });
    // 目录结构:两实例+轨迹+stdio+事件全在
    expect(existsSync(join(dest, '.hopstate', 'inst-a', 'vars.json'))).toBe(true);
    expect(existsSync(join(dest, '.hopstate', 'inst-b', 'state.json'))).toBe(true);
    expect(existsSync(join(dest, '.hoplog', 'run-1', 'main.yaml'))).toBe(true);
    // stdout 完整不截断
    expect(readFileSync(join(dest, 'stdout.log'), 'utf-8')).toContain('early context');
    // 全树无 secret 原文,已替换为 [REDACTED]
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
    for (const f of walk(dest)) {
      const text = readFileSync(f, 'utf-8');
      expect(text).not.toContain(SECRET);
    }
    expect(readFileSync(join(dest, '.hoplog', 'run-1', 'main.yaml'), 'utf-8')).toContain('[REDACTED]');
    rmSync(workspace, { recursive: true, force: true });
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  it('workspace 无 .hopstate/.hoplog（早期失败）→ 仍归档 stdio 不炸', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'carrier-early-'));
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'evidence2-'));
    const dest = archiveFailureEvidence({
      workspace, scenario: 'cc:delegated',
      result: { stdout: 'partial', stderr: '' },
      normalized: [], secrets: [], evidenceRoot,
    });
    expect(readFileSync(join(dest, 'stdout.log'), 'utf-8')).toBe('partial');
    expect(readFileSync(join(dest, 'events.json'), 'utf-8')).toBe('[]');
    rmSync(workspace, { recursive: true, force: true });
    rmSync(evidenceRoot, { recursive: true, force: true });
  });
});

// mainText：全部主消息拼接——终态 YAML 断言依据（2026-08-10 cc:parallel-partial 实撞：
// 主 agent 先报 completed YAML，task-notification 补话晚到覆盖 finalText → 语义断言误红。
// finalText 保留（顺序断言用），语义断言改看 mainText）。 // @v: anc-driver-live-e2e-events
describe('mainText 聚合（终态 YAML 断言不依赖最后一条消息）', () => {

  it('正例：completed YAML 在前、补话在后 → mainText 含终态而 finalText 不含', () => {
    const events = [{
      type: 'result',
      result: 'status: completed\noutputs:\n  doubled_list:\n  - 6400',
    }, {
      type: 'result',
      result: '最后一路 worker 也已确认完成，与已报告的终态输出一致。',
    }];
    const r = normalizeClaudeEvents(events);
    expect(r.finalText).not.toContain('status: completed');   // 最后一条是补话
    expect(r.mainText).toContain('status: completed');        // 语义断言依据
  });

  it('反例：主消息从未报 completed → mainText 同样不含（不放水）', () => {
    const events = [{
      type: 'result',
      result: '执行中断，未完成。',
    }];
    const r = normalizeClaudeEvents(events);
    expect(r.mainText).not.toContain('status: completed');
  });

  it('Codex 侧同构：mainText 聚合全部 main agent_message', () => {
    const events = [
      { type: 'thread.started', thread_id: 'main' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'status: completed\noutputs: {}', thread_id: 'main' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '收尾补话', thread_id: 'main' } },
    ];
    const r = normalizeCodexEvents(events);
    expect(r.finalText).toBe('收尾补话');
    expect(r.mainText).toContain('status: completed');
  });
});

// codex 载体环境自包含（todo/0061,^anc-driver-live-e2e-isolation codex 子条——2026-09-01
// 发版前实撞:宿主未登录 slack 插件把 codex:delegated/codex:demo 双双拖死超时,e2e 结论掺
// 宿主环境噪声。变异实证:撤段过滤〔原样透传〕正例①红）
// @v: anc-driver-live-e2e-isolation
describe('codex 隔离 home（宿主配置过滤,todo/0061）', () => {
  const HOST_SAMPLE = `model = "openai/gpt-5.6-sol"
model_provider = "zenmux"
model_reasoning_effort = "high"
notify = [
    "/Users/x/SkyComputerUseClient",
    "turn-ended",
]
sandbox_mode = "workspace-write"

[model_providers.zenmux]
name = "ZenMux"
base_url = "https://zenmux.ai/api/v1"
env_key = "ZENMUX_API_KEY"
wire_api = "responses"

[mcp_servers.deepwiki]
url = "https://mcp.deepwiki.com/mcp"
startup_timeout_sec = 3600.0

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/x/.codex"

[projects."/Users/x/proj"]
trust_level = "trusted"

[marketplaces.openai-bundled]
source_type = "local"
source = "/tmp/x"

[plugins."slack@openai-curated"]
enabled = true

[plugins."browser@openai-bundled"]
enabled = true

[shell_environment_policy]
inherit = "all"
`;

  it('正例①：三族段与 notify 数组全滤,model/providers/projects 信任/shell 策略段保留（照宿主实况构造含未登录 slack 形态）', () => {
    const out = filterCodexConfigForIsolation(HOST_SAMPLE);
    expect(out).not.toContain('[plugins.');
    expect(out).not.toContain('[marketplaces.');
    expect(out).not.toContain('[mcp_servers.');
    expect(out).not.toContain('slack');
    expect(out).not.toContain('notify = [');
    expect(out).not.toContain('SkyComputerUseClient');
    expect(out).toContain('model = "openai/gpt-5.6-sol"');
    expect(out).toContain('[model_providers.zenmux]');
    expect(out).toContain('env_key = "ZENMUX_API_KEY"');
    expect(out).toContain('[projects."/Users/x/proj"]');
    expect(out).toContain('trust_level = "trusted"');
    expect(out).toContain('[shell_environment_policy]');
  });

  it('正例②：buildIsolatedCodexHome 产出过滤后 config.toml+复制 profile 文件族与 auth.json', () => {
    const hostHome = mkdtempSync(join(tmpdir(), 'fake-codex-home-'));
    writeFileSync(join(hostHome, 'config.toml'), HOST_SAMPLE);
    writeFileSync(join(hostHome, 'deepseek-v4-flash.config.toml'), 'model = "deepseek-v4-flash"\n');
    writeFileSync(join(hostHome, 'auth.json'), '{"tokens":{}}');
    const home = buildIsolatedCodexHome(hostHome);
    try {
      const cfg = readFileSync(join(home, 'config.toml'), 'utf-8');
      expect(cfg).not.toContain('[plugins.');
      expect(cfg).toContain('[model_providers.zenmux]');
      expect(readFileSync(join(home, 'deepseek-v4-flash.config.toml'), 'utf-8')).toContain('deepseek-v4-flash');
      expect(existsSync(join(home, 'auth.json'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(hostHome, { recursive: true, force: true });
    }
  });

  it('边界：assertNoSecretLeak 罩临时 home 通道——auth.json 含密钥值即失败（阅卷实抓扫描面漏配的直接钉）', () => {
    const secret = 'sk-testvalue1234567890abcd';
    expect(() => assertNoSecretLeak({
      stdout: '', stderr: '', events: '',
      workspace: '',
      codex_home: `auth.json: {"token":"${secret}"}`,
    }, [secret])).toThrow(/codex_home/);
  });

  it('反例转正（C2-1）：保留段内部的 notify 键不被误删（条款说顶层——按段原样透传承诺兑现）', () => {
    const cfg = `notify = ["top-level-noise"]

[model_providers.x]
notify = ["keep-me-inside-section"]
base_url = "https://x"
`;
    const out = filterCodexConfigForIsolation(cfg);
    expect(out).not.toContain('top-level-noise');
    expect(out).toContain('keep-me-inside-section');
  });

  it('边界：[[双括号数组表]] 形态的三族段同剔（理论形态顺手封死）', () => {
    const cfg = `model = "m"

[[mcp_servers.weird]]
url = "https://x"
`;
    const out = filterCodexConfigForIsolation(cfg);
    expect(out).not.toContain('mcp_servers');
    expect(out).toContain('model = "m"');
  });

  it('反例：无三族段且无 notify 的配置过滤后与输入等价（不误删）', () => {
    const plain = `model = "m"

[model_providers.a]
base_url = "https://a"

[projects."/p"]
trust_level = "trusted"
`;
    expect(filterCodexConfigForIsolation(plain)).toBe(plain);
  });
});
