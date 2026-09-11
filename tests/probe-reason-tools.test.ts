// @module: step-dispatcher ^anc-struct-step-dispatcher
// @v: anc-exec-reason-tools — reason 步走工具循环的端到端连通钉（4.1 探针转正）：mock LLM
// 两轮（首轮 tool_use 读文件/次轮 text 产出 YAML），断言循环走通、工具以 work_zone 写域执行、
// parseStepOutput 按声明键解出产出。实撞:anchor-audit spec standalone 化六跑第六跑死在 4.2——
// reason 要读盘上 cross_compare_results.yaml,零工具面判不了（同一份 spec 复用模式活 standalone 死）。
import { describe, it, expect, vi } from 'vitest';
import { StepDispatcher } from '../src/dispatcher.js';
import { ExecutionEngine } from '../src/engine.js';
import type { HostConfig } from '../src/provider-types.js';

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: { create: vi.fn() },
  }));
  for (const k of ['RateLimitError', 'InternalServerError', 'APIConnectionTimeoutError', 'APIConnectionError', 'AuthenticationError', 'BadRequestError', 'APIError']) {
    (MockAnthropic as any)[k] = class extends Error { };
  }
  return { default: MockAnthropic };
});

const HOST: HostConfig = {
  workspace_dir: '/tmp/test',
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'test-key',
};

const REASON_SPEC = `# Probe
Id: probe-reason-tools

## Goal
探针：reason 走工具循环

## Outputs
- verdict: text  # 判定结论

## Steps
1. [reason] 读盘上材料后推理
  + → verdict: text  # 判定结论
  > 读 data.yaml 后给出结论
`;

describe('4.1 探针：reason 步走既有工具循环体（mock 两轮）', () => {
  it('首轮 tool_use 读文件、次轮 text 交 YAML → parseStepOutput 解出声明键 verdict', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(REASON_SPEC, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    (dispatcher as any).sleep = () => Promise.resolve();
    // 受控工具面：一件 basic 读文件工具（探针不依赖真实 toolProvider 注册面）
    const execSpy = vi.fn().mockResolvedValue({ success: true, result: '盘上材料：答案是 42' });
    (dispatcher as any).toolProvider = {
      list: () => [{ name: 'read', description: '读文件', input_schema: { type: 'object', properties: { path: { type: 'string' } } }, category: 'basic', requires_commit: false }],
      execute: execSpy,
    };
    const mockCreate = (dispatcher as any).defaultClient.messages.create;
    // 首轮：LLM 发起 tool_use 读文件
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'data.yaml' } }],
      usage: { input_tokens: 50, output_tokens: 20 },
    });
    // 次轮：LLM 交按声明 schema 的 YAML 文本
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'verdict: 材料在场，结论是 42' }],
      usage: { input_tokens: 80, output_tokens: 10 },
    });

    const step = engine.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status !== 'step_ready') return;
    expect(step.step_type).toBe('reason');
    // 直调既有循环体（4.2 实现后 reason 分派会走到这里；探针先证循环体对 reason StepReady 可行）
    const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
    const result = await executeAct(step);
    expect(execSpy).toHaveBeenCalledWith('read', { path: 'data.yaml' }, 'work_zone');
    expect(result.verdict).toContain('42');   // 声明键按 parseStepOutput 阶梯解出
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
