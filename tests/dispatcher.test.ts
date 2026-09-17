// @module: step-dispatcher ^anc-struct-step-dispatcher
// @v: anc-struct-shared-providers — Provider 接口族的行为面（凭证解析/SDK 注入）在本文件覆盖
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { load as yamlLoadRaw } from 'js-yaml';
import { parseModelRef, StepDispatcher, DirSpecProvider, isHighlyRepetitive } from '../src/dispatcher.js';
import { parseFragment, flattenFragmentNumbering } from '../src/parser.js';
import Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionEngine } from '../src/engine.js';
import { PromptAssembler, formatPromptText } from '../src/prompt.js';
import type { OutputDecl } from '../src/ast-types.js';
import type { HostConfig } from '../src/provider-types.js';
import type { AssembledContext } from '../src/runtime-types.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const openaiCreateMock = vi.fn();
vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreateMock } },
  }));
  for (const k of ['RateLimitError', 'InternalServerError', 'APIConnectionTimeoutError', 'APIConnectionError', 'AuthenticationError', 'BadRequestError', 'APIError']) {
    (MockOpenAI as any)[k] = class extends Error { };
  }
  return { default: MockOpenAI };
});

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn(),
    },
  }));
  (MockAnthropic as any).RateLimitError = class extends Error { };
  (MockAnthropic as any).InternalServerError = class extends Error { };
  (MockAnthropic as any).APIConnectionTimeoutError = class extends Error { };
  (MockAnthropic as any).APIConnectionError = class extends Error { };
  (MockAnthropic as any).AuthenticationError = class extends Error { };
  (MockAnthropic as any).BadRequestError = class extends Error { };
  (MockAnthropic as any).APIError = class extends Error { status?: number };
  return { default: MockAnthropic };
});

const HOST: HostConfig = {
  workspace_dir: '/tmp/test',
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'test-key',
};

const SIMPLE_SPEC = `# Test
Id: test-disp

## Goal
Test dispatcher

## Outputs
- result: text  # final

## Steps
1. [reason] Think
  + → result: text  # thinking
  > Think carefully
`;

// @v: anc-struct-step-dispatcher
describe('StepDispatcher', () => {
  // @v: anc-exec-model-resolve
  describe('parseModelRef', () => {
    it('解析裸模型与 service/model，并保留模型中的后续斜杠', () => {
      expect(parseModelRef('m1')).toEqual({ service_id: 'default', model: 'm1' });
      expect(parseModelRef('backup/org/m2')).toEqual({ service_id: 'backup', model: 'org/m2' });
    });

    it.each(['/m2', 'backup/', '', ' m2'])('拒绝空片段或首尾空白：%j', ref => {
      expect(() => parseModelRef(ref)).toThrow(/INVALID_MODEL_REF/);
    });
  });

  // client 级非流式超时（buildtest 二撞:v0.8.7 首修落 create 第二参=修错层——SDK 预检只看
  // 构造期 _options.timeout,per-request 不进预检）。 // @v: anc-exec-nonstreaming-timeout
  describe('client 级非流式超时（SDK 预检解锁）', () => {
    it('正例：大输出预算按式放宽构造期 timeout（32768→≈15.4min）', async () => {
      const AnthropicMock = (await import('@anthropic-ai/sdk')).default as unknown as ReturnType<typeof vi.fn>;
      AnthropicMock.mockClear();
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const host = { ...HOST, resource_limits: { max_tool_iterations: 20, max_context_tokens: 1, max_output_tokens: 32768, max_replan_attempts: 3 } };
      void new StepDispatcher(engine, host);
      const ctorArgs = AnthropicMock.mock.calls.at(-1)![0] as { timeout: number };
      expect(ctorArgs.timeout).toBe(Math.ceil((32768 / 128_000) * 60 * 60_000));
      expect(ctorArgs.timeout).toBeGreaterThan(10 * 60_000);
    });

    it('正例：缺省预算（32768）构造期 timeout 按同式换算（2026-08-27 缺省抬升,断言随契约更新）', async () => {
      const AnthropicMock = (await import('@anthropic-ai/sdk')).default as unknown as ReturnType<typeof vi.fn>;
      AnthropicMock.mockClear();
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      void new StepDispatcher(engine, HOST);
      // 2026-08-27 缺省 16384→32768（^anc-exec-output-budget）:timeout 随同式换算 32768/128k×60min≈15.36min
      expect((AnthropicMock.mock.calls.at(-1)![0] as { timeout: number }).timeout).toBe(Math.ceil((32768 / 128_000) * 60 * 60_000));
    });
  });

  describe('formatInputs', () => {
    it('formats null as None', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const text = dispatcher.formatInputs({ x: null, y: 'hello' });
      expect(text).toContain('x: None');
      expect(text).toContain('y: hello');
    });

    it('formats undefined as None', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const text = dispatcher.formatInputs({ z: undefined });
      expect(text).toContain('z: None');
    });

    it('不截断长字符串（BUG-H 同批废除——截断=信息损毁,token 压力归预算裁剪链）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const text = dispatcher.formatInputs({ big: 'x'.repeat(600) });
      expect(text).toContain('x'.repeat(600));   // 全量在场
      expect(text).not.toContain('...');
    });

    it('formats objects as JSON', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const text = dispatcher.formatInputs({ obj: { a: 1 } });
      expect(text).toContain('obj: {"a":1}');
    });

    it('returns (none) for empty inputs', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const text = dispatcher.formatInputs({});
      expect(text).toBe('(none)');
    });
  });

  describe('formatOutputSchema', () => {
    it('formats output declarations', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const schema: OutputDecl[] = [
        { name: 'result', type: 'text', description: 'the result' },
        { name: 'score', type: 'int', description: '' },
      ];
      const text = dispatcher.formatOutputSchema(schema);
      expect(text).toContain('- result: text # the result');
      expect(text).toContain('- score: int');
    });
  });

  describe('selectTemperature (via buildApiRequest integration)', () => {
    it('uses different temperatures based on context', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);

      // Access private method via any cast for testing
      const selectTemp = (dispatcher as any).selectTemperature.bind(dispatcher);
      expect(selectTemp('reason')).toBe(0.3);
      expect(selectTemp('act')).toBe(0);
      expect(selectTemp('check')).toBe(0);
    });
  });

  // checkNoneInputs 已删（2026-08-09 fail即异常定稿:None闸废除,None是普通值）

  // @v: anc-exec-model-resolve, anc-provider-identity
  describe('resolveApiKey', () => {
    const ENV_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'HOPJIT_ANTHROPIC_API_KEY'] as const;
    function clearApiEnv() {
      const saved: Record<string, string | undefined> = {};
      for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
      return saved;
    }
    function restoreApiEnv(saved: Record<string, string | undefined>) {
      for (const k of ENV_KEYS) {
        if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k];
      }
    }

    it('uses ANTHROPIC_AUTH_TOKEN first', () => {
      const saved = clearApiEnv();
      process.env['ANTHROPIC_AUTH_TOKEN'] = 'test-token';
      try {
        const engine = new ExecutionEngine();
        engine.initExecution(SIMPLE_SPEC, HOST);
        const dispatcher = new StepDispatcher(engine, { ...HOST, api_key: '' });
        expect(dispatcher).toBeDefined();
      } finally {
        restoreApiEnv(saved);
      }
    });

    it('falls back to ANTHROPIC_API_KEY', () => {
      const saved = clearApiEnv();
      process.env['ANTHROPIC_API_KEY'] = 'api-key';
      try {
        const engine = new ExecutionEngine();
        engine.initExecution(SIMPLE_SPEC, HOST);
        const dispatcher = new StepDispatcher(engine, { ...HOST, api_key: '' });
        expect(dispatcher).toBeDefined();
      } finally {
        restoreApiEnv(saved);
      }
    });

    it('falls back to hostConfig.api_key', () => {
      const saved = clearApiEnv();
      try {
        const engine = new ExecutionEngine();
        engine.initExecution(SIMPLE_SPEC, HOST);
        const dispatcher = new StepDispatcher(engine, HOST);
        expect(dispatcher).toBeDefined();
      } finally {
        restoreApiEnv(saved);
      }
    });

    it('throws when no key available', () => {
      const saved = clearApiEnv();
      try {
        const engine = new ExecutionEngine();
        engine.initExecution(SIMPLE_SPEC, HOST);
        const noKeyHost: HostConfig = { ...HOST, api_key: '' };
        expect(() => new StepDispatcher(engine, noKeyHost)).toThrow('No API key');
      } finally {
        restoreApiEnv(saved);
      }
    });

    it('falls back to HOPJIT env var', () => {
      const saved = clearApiEnv();
      process.env['HOPJIT_ANTHROPIC_API_KEY'] = 'env-key';
      try {
        const engine = new ExecutionEngine();
        engine.initExecution(SIMPLE_SPEC, HOST);
        const dispatcher = new StepDispatcher(engine, { ...HOST, api_key: '' });
        expect(dispatcher).toBeDefined();
      } finally {
        restoreApiEnv(saved);
      }
    });

    it('does not read plaintext key from legacy config file', () => {
      const tmpHome = mkdtempSync(join(tmpdir(), 'hoptest-home-'));
      const configDir = join(tmpHome, '.hopjit');
      mkdirSync(configDir);
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ api_key: 'file-key' }));

      const origHome = process.env['HOME'];
      const saved = clearApiEnv();
      process.env['HOME'] = tmpHome;
      try {
        const engine = new ExecutionEngine();
        engine.initExecution(SIMPLE_SPEC, HOST);
        expect(() => new StepDispatcher(engine, { ...HOST, api_key: '' })).toThrow('No API key');
      } finally {
        process.env['HOME'] = origHome;
        restoreApiEnv(saved);
      }
    });
  });

  // @v: anc-exec-model-routing, anc-exec-model-resolve, anc-config-model-engine
  describe('resolveModel routing', () => {
    it('returns ANTHROPIC_MODEL env var as default', () => {
      const orig = process.env['ANTHROPIC_MODEL'];
      process.env['ANTHROPIC_MODEL'] = 'test-model-from-env';
      try {
        const engine = new ExecutionEngine();
        engine.initExecution(SIMPLE_SPEC, HOST);
        const dispatcher = new StepDispatcher(engine, HOST);
        expect(dispatcher.resolveModel('reason').model).toBe('test-model-from-env');
      } finally {
        if (orig) process.env['ANTHROPIC_MODEL'] = orig; else delete process.env['ANTHROPIC_MODEL'];
      }
    });

    it('uses hostConfig.model when no env var', () => {
      const orig = process.env['ANTHROPIC_MODEL'];
      delete process.env['ANTHROPIC_MODEL'];
      try {
        const engine = new ExecutionEngine();
        engine.initExecution(SIMPLE_SPEC, HOST);
        const dispatcher = new StepDispatcher(engine, { ...HOST, model: 'host-model' });
        expect(dispatcher.resolveModel('reason').model).toBe('host-model');
      } finally {
        if (orig) process.env['ANTHROPIC_MODEL'] = orig;
      }
    });

    it('uses routing_rules by step_type', () => {
      const orig = process.env['ANTHROPIC_MODEL'];
      delete process.env['ANTHROPIC_MODEL'];
      try {
        const engine = new ExecutionEngine();
        engine.initExecution(SIMPLE_SPEC, HOST);
        const dispatcher = new StepDispatcher(engine, {
          ...HOST,
          model_engine: {
            default_service_id: 'anthropic',
            default_model: 'fallback-model',
            routing_rules: [
              { match: { step_type: 'reason' }, service_id: 'deepseek', model: 'deepseek-v4-pro' },
              { match: { step_type: 'check' }, service_id: 'anthropic', model: 'claude-sonnet' },
            ],
          },
        });
        expect(dispatcher.resolveModel('reason')).toEqual({ service_id: 'deepseek', model: 'deepseek-v4-pro' });
        expect(dispatcher.resolveModel('check')).toEqual({ service_id: 'anthropic', model: 'claude-sonnet' });
        expect(dispatcher.resolveModel('act').model).toBe('fallback-model');
      } finally {
        if (orig) process.env['ANTHROPIC_MODEL'] = orig;
      }
    });

    it('spec-level config.model overrides routing_rules', () => {
      const orig = process.env['ANTHROPIC_MODEL'];
      delete process.env['ANTHROPIC_MODEL'];
      try {
        const specWithModel = `# Test
Goal: Test model routing

Config:
  model: spec-level-model

## Steps
1. [reason] Think
  + → result: text  # output
  > Think
`;
        const engine = new ExecutionEngine();
        engine.initExecution(specWithModel, {
          ...HOST,
          model_engine: {
            default_service_id: 'anthropic',
            default_model: 'global-default',
            routing_rules: [
              { match: { step_type: 'reason' }, service_id: 'deepseek', model: 'routed-model' },
            ],
          },
        });
        const dispatcher = new StepDispatcher(engine, HOST);
        expect(dispatcher.resolveModel('reason').model).toBe('spec-level-model');
      } finally {
        if (orig) process.env['ANTHROPIC_MODEL'] = orig;
      }
    });

    it('model_engine.default_model used when no routing_rules match', () => {
      const orig = process.env['ANTHROPIC_MODEL'];
      delete process.env['ANTHROPIC_MODEL'];
      try {
        const engine = new ExecutionEngine();
        engine.initExecution(SIMPLE_SPEC, HOST);
        const dispatcher = new StepDispatcher(engine, {
          ...HOST,
          model_engine: {
            default_service_id: 'anthropic',
            default_model: 'engine-default',
          },
        });
        expect(dispatcher.resolveModel('reason').model).toBe('engine-default');
      } finally {
        if (orig) process.env['ANTHROPIC_MODEL'] = orig;
      }
    });

    it('显式 model_engine.default_model 高于继承的 ANTHROPIC_MODEL', () => {
      const orig = process.env['ANTHROPIC_MODEL'];
      process.env['ANTHROPIC_MODEL'] = 'ambient-model';
      try {
        const engine = new ExecutionEngine();
        engine.initExecution(SIMPLE_SPEC, HOST);
        const dispatcher = new StepDispatcher(engine, {
          ...HOST,
          model_engine: { default_service_id: 'backup', default_model: 'm2' },
        });
        expect(dispatcher.resolveModel('reason')).toEqual({ service_id: 'backup', model: 'm2' });
      } finally {
        if (orig !== undefined) process.env['ANTHROPIC_MODEL'] = orig;
        else delete process.env['ANTHROPIC_MODEL'];
      }
    });

    it('step @model override takes highest priority', () => {
      const orig = process.env['ANTHROPIC_MODEL'];
      delete process.env['ANTHROPIC_MODEL'];
      // 软偏好在场性显式供给（0011①——原依赖开发机恰有 DEEPSEEK_API_KEY 才绿,
      // 干净环境/CI 必红;与 :4186 软偏好测试同款显式 set/清理）
      const origDs = process.env['DEEPSEEK_API_KEY'];
      process.env['DEEPSEEK_API_KEY'] = 'sk-test-present';
      try {
        const specWithStepModel = `# Test
Goal: Test step model override

## Steps
1. [reason] Think
  + → result: text  # output
  > @model deepseek/deepseek-v4
  > Think hard
`;
        const engine = new ExecutionEngine();
        engine.initExecution(specWithStepModel, {
          ...HOST,
          model: 'host-model',
          model_engine: {
            default_service_id: 'anthropic',
            default_model: 'global-default',
            routing_rules: [
              { match: { step_type: 'reason' }, service_id: 'anthropic', model: 'routed-model' },
            ],
          },
        });
        const dispatcher = new StepDispatcher(engine, {
          ...HOST,
          model: 'host-model',
          model_engine: {
            default_service_id: 'anthropic',
            default_model: 'global-default',
            routing_rules: [
              { match: { step_type: 'reason' }, service_id: 'anthropic', model: 'routed-model' },
            ],
          },
        });
        const step = engine.nextStep();
        if (step.status !== 'step_ready') throw new Error('Expected step_ready');
        expect(dispatcher.resolveModel('reason', step)).toEqual({ service_id: 'deepseek', model: 'deepseek-v4' });
      } finally {
        if (orig) process.env['ANTHROPIC_MODEL'] = orig;
        if (origDs === undefined) delete process.env['DEEPSEEK_API_KEY']; else process.env['DEEPSEEK_API_KEY'] = origDs;
      }
    });

    // @model 级软偏好落级（0011②模型域——软偏好缺席只测过 Config.models 级,@model 级同函数但
    // 未直接命中;显式清 env 钉住:引用的 service 无凭证→warn 落级沿链到 routing_rules）
    it('反例：@model 引用缺席 service → 软偏好落级到 routing_rules（不炸不误用）', () => {
      const origDs = process.env['DEEPSEEK_API_KEY'];
      const origModel = process.env['ANTHROPIC_MODEL'];
      delete process.env['DEEPSEEK_API_KEY'];
      delete process.env['ANTHROPIC_MODEL'];
      try {
        const spec = `# T\nGoal: g\n\n## Steps\n1. [reason] Think\n  + → r: text  # o\n  > @model deepseek/deepseek-v4\n  > t\n`;
        const engine = new ExecutionEngine();
        const me = { default_service_id: 'anthropic', default_model: 'global-default',
          routing_rules: [{ match: { step_type: 'reason' as const }, service_id: 'anthropic', model: 'routed-model' }] };
        engine.initExecution(spec, { ...HOST, model_engine: me });
        const dispatcher = new StepDispatcher(engine, { ...HOST, model_engine: me });
        const step = engine.nextStep();
        if (step.status !== 'step_ready') throw new Error('Expected step_ready');
        expect(dispatcher.resolveModel('reason', step)).toEqual({ service_id: 'anthropic', model: 'routed-model' });   // 落级命中系统层
      } finally {
        if (origDs !== undefined) process.env['DEEPSEEK_API_KEY'] = origDs;
        if (origModel !== undefined) process.env['ANTHROPIC_MODEL'] = origModel;
      }
    });

    it('falls back to hardcoded default when nothing configured', () => {
      const orig = process.env['ANTHROPIC_MODEL'];
      delete process.env['ANTHROPIC_MODEL'];
      try {
        const engine = new ExecutionEngine();
        engine.initExecution(SIMPLE_SPEC, HOST);
        const dispatcher = new StepDispatcher(engine, HOST);
        expect(dispatcher.resolveModel('reason').model).toBe('claude-sonnet-4-6');
      } finally {
        if (orig) process.env['ANTHROPIC_MODEL'] = orig;
      }
    });
  });

  // @v: anc-exec-cost-guardrails
  describe('budget protection', () => {
    it('tracks cumulative tokens', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      expect(dispatcher.getCumulativeTokens()).toBe(0);
    });
  });

  // @v: anc-exec-none-propagation —— 函数级 fail（2026-08-09 定稿）:None 闸已废,引擎不连坐。
  // 原"handles None inputs by failing step"测试断言旧 auto-fail 语义,且被 if(step_ready) 守卫
  // 空转通过（上游 fail 无事务边界=实例终止,根本到不了 step 2）——审计实抓误导测试,按现行语义改写。
  describe('execution loop integration（函数级 fail）', () => {
    it('反例:上游步骤失败且无事务边界 → 实例终止,下游步骤不执行（不存在 None auto-fail）', () => {
      const twoStepSpec = `# Two Steps
Id: two-steps

## Goal
Test uncaught failure

## Outputs
- final: text  # result

## Steps
1. [reason] First
  + → mid: text  # middle
  > Do something
2. [reason] Second
  - ← mid
  + → final_out: text  # final
  > Use mid
`;
      const engine = new ExecutionEngine();
      engine.initExecution(twoStepSpec, HOST);
      engine.nextStep(); // step 1 ready
      engine.failStep('1', 'test failure');

      // 未捕获失败=实例终止:step 2 不会成为 step_ready,nextStep 短路 failed
      const next = engine.nextStep();
      expect(next.status).toBe('failed');
      expect(engine.getStepStates().get('2')).not.toBe('running');
    });
  });

  // @v: anc-exec-operator-retry
  describe('算子级重试（独立模式 SCHEMA_MISMATCH）', () => {
    const NUM_SPEC = `# Num Test
Id: num-test

## Goal
Test schema retry

## Outputs
- score: int  # numeric score

## Steps
1. [reason] 打分
  + → score: int  # 数值评分
  > 给出 0-100 分
`;
    function setup() {
      const engine = new ExecutionEngine();
      engine.initExecution(NUM_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      const handleReady = (dispatcher as any).handleStepReady.bind(dispatcher);
      return { engine, dispatcher, mockCreate, handleReady };
    }
    const resp = (text: string) => ({
      content: [{ type: 'text', text }],
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    it('首次输出不匹配 → 反馈重做 → 第二次匹配则成功', async () => {
      const { engine, mockCreate, handleReady } = setup();
      mockCreate
        .mockResolvedValueOnce(resp('not a number'))   // 第 1 次：number 字段非数字 → SCHEMA_MISMATCH
        .mockResolvedValueOnce(resp('87'));            // 第 2 次：修正为数字 → 通过
      const next = engine.nextStep();
      expect(next.status).toBe('step_ready');
      if (next.status === 'step_ready') {
        await handleReady(next);
        expect(engine.getStepStates().get('1')).toBe('done');
        expect(mockCreate).toHaveBeenCalledTimes(2);  // 重做了 1 次
      }
    });

    it('连续不匹配耗尽缺省 3 次 → failStep', async () => {
      const { engine, mockCreate, handleReady } = setup();
      mockCreate.mockResolvedValue(resp('still not a number'));  // 每次都不匹配
      const next = engine.nextStep();
      expect(next.status).toBe('step_ready');
      if (next.status === 'step_ready') {
        await handleReady(next);
        expect(engine.getStepStates().get('1')).toBe('failed');
        expect(mockCreate).toHaveBeenCalledTimes(3);  // 缺省 3 次后放弃
      }
    });
  });

  // @v: anc-exec-cache-control — LLM 前缀缓存注入（B 断点 + C 观测）正反例
  describe('cache_control injection', () => {
    const CACHE_SPEC = `# Cache Test
Goal: probe cache blocks

## Outputs
- verdict: text  # 结论

## Steps
1. [reason] 判断
  + → verdict: text  # 结论
  > 给结论
`;
    function setup() {
      const engine = new ExecutionEngine();
      engine.initExecution(CACHE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      const handleReady = (dispatcher as any).handleStepReady.bind(dispatcher);
      return { engine, dispatcher, mockCreate, handleReady };
    }

    it('正例：单步请求 system 为块数组,稳定块尾带 ephemeral 断点', async () => {
      const { engine, mockCreate, handleReady } = setup();
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } });
      const next = engine.nextStep();
      if (next.status === 'step_ready') await handleReady(next);
      const req = mockCreate.mock.calls[0][0];
      expect(Array.isArray(req.system)).toBe(true);
      expect(req.system[0].cache_control).toEqual({ type: 'ephemeral' });
      // 稳定块含契约,不含祖先链(易变面)
      expect(req.system[0].text).toContain('Goal');
    });

    it('观测（C）：HopLog llm 块记 cache 两字段', async () => {
      const { engine, mockCreate, handleReady } = setup();
      const { HopLog } = await import('../src/hoplog.js');
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { readFileSync } = await import('node:fs');
      const dir = mkdtempSync(join(tmpdir(), 'hoplog-cache-'));
      const hopLog = new HopLog({ specId: 'cache-test', logDir: dir, title: 'T', goal: 'G' });
      (engine as any).hoplog = hopLog;
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 11 } });
      const next = engine.nextStep();
      if (next.status === 'step_ready') await handleReady(next);
      hopLog.close('completed');
      const log = readFileSync(hopLog.getFilePath(), 'utf-8');
      expect(log).toContain('cache_read_input_tokens');
      expect(log).toContain('7');
      expect(log).toContain('cache_creation_input_tokens');
      expect(log).toContain('11');
    });
  });

  // @v: anc-exec-api-retry
  describe('callLlmWithRetry', () => {
    function makeDispatcher() {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      // Stub sleep to avoid real delays
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      const callRetry = (dispatcher as any).callLlmWithRetry.bind(dispatcher);
      return { dispatcher, mockCreate, callRetry };
    }

    const OK_RESPONSE = {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    it('returns on first success', async () => {
      const { mockCreate, callRetry } = makeDispatcher();
      mockCreate.mockResolvedValueOnce(OK_RESPONSE);
      const resp = await callRetry({ model: 'test', messages: [] });
      expect(resp.content[0].text).toBe('ok');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('retries RateLimitError then succeeds', async () => {
      const { mockCreate, callRetry } = makeDispatcher();
      const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
      mockCreate
        .mockRejectedValueOnce(new Anthropic.RateLimitError())
        .mockRejectedValueOnce(new Anthropic.RateLimitError())
        .mockResolvedValueOnce(OK_RESPONSE);
      const resp = await callRetry({ model: 'test', messages: [] });
      expect(resp).toBeDefined();
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });

    // 裸网络异常文案兜底（D61,2026-08-24 dr14 实抓——流中断 undici 裸 TypeError 'terminated'
    // 不是 SDK 错误类实例,instanceof 链全不中落 other 档:0 重试+裸文案穿透 D58 前缀）
    // @v: anc-exec-api-retry
    it('正例：裸 TypeError("terminated") → 归 network 档重试并耗尽挂 NETWORK_ERROR 前缀；反例：业务文案含 terminated 词形不匹配不误归', async () => {
      const { mockCreate, callRetry } = makeDispatcher();
      mockCreate.mockRejectedValue(new TypeError('terminated'));   // 非 SDK 错误类——旧实现落 other 0 重试
      try { await callRetry({ model: 'test', messages: [] }); expect.unreachable(); } catch (e: any) {
        expect(String(e.message ?? e)).toMatch(/^NETWORK_ERROR: 网络中断/);
      }
      expect(mockCreate.mock.calls.length).toBeGreaterThanOrEqual(3);   // network 档 2 重试=至少 3 次调用

      const { mockCreate: mc2, callRetry: cr2 } = makeDispatcher();
      mc2.mockRejectedValue(new Error('用户文档中提到 terminatedProcess 概念'));   // 词形不完整,不该误归 network
      try { await cr2({ model: 'test', messages: [] }); } catch (e: any) {
        expect(String(e.message ?? e)).not.toContain('NETWORK_ERROR');
      }
    });

    // A 半边（v0.14.1——dr17 实撞:旧 2 次×短退避总耐受 3 秒,1 分钟网络中断 43 秒烧穿全树）
    // @v: anc-exec-api-retry
    it('正例：网络档 6 次重试——第 7 发成功即活过 6 次抖动（旧 2 次档下必死）', async () => {
      const { mockCreate, callRetry } = makeDispatcher();
      for (let i = 0; i < 6; i++) mockCreate.mockRejectedValueOnce(new TypeError('fetch failed'));
      mockCreate.mockResolvedValueOnce(OK_RESPONSE);
      const resp = await callRetry({ model: 'test', messages: [] });
      expect(resp.content[0].text).toBe('ok');
      expect(mockCreate).toHaveBeenCalledTimes(7);   // 6 次失败+1 次成功
    });

    it('正例：退避封顶 60s——第 7 次尝试（attempt 6）延迟不超 60s+抖动', async () => {
      const { dispatcher, mockCreate, callRetry } = makeDispatcher();
      const delays: number[] = [];
      (dispatcher as any).sleep = (ms: number) => { delays.push(ms); return Promise.resolve(); };
      mockCreate.mockRejectedValue(new TypeError('socket hang up'));
      try { await callRetry({ model: 'test', messages: [] }); } catch { /* 耗尽 */ }
      expect(delays.length).toBe(6);
      expect(Math.max(...delays)).toBeLessThan(60_100);   // 2^5*1000=32s<封顶;封顶护栏在(60s+jitter 上界)
      expect(delays[5]).toBeGreaterThan(30_000);           // 末次退避 32s 档真实生效(非旧 2 次档的 2s)
    });

    // 网络类耗尽挂可读前缀（2026-08-23 作者定——dr10 实撞:undici 断流原文案 `terminated`
    // 直落 FailRecord 经 L2c 给下一轮 LLM 零信息量,LLM 会试图"修正"网络故障）
    // @v: anc-exec-api-retry
    it('正例：网络错误耗尽 → 抛 NETWORK_ERROR 前缀（保留原文案）；反例：限流耗尽不挂该前缀', async () => {
      const { mockCreate, callRetry } = makeDispatcher();
      const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
      const connErr = new Anthropic.APIConnectionError();
      connErr.message = 'terminated';   // mock 类是裸 extends Error,真 SDK 的 {message} 构造形态在此手工赋值
      mockCreate.mockRejectedValue(connErr);
      try { await callRetry({ model: 'test', messages: [] }); expect.unreachable(); } catch (e: any) {
        const m = String(e.message ?? e);
        expect(m).toMatch(/^NETWORK_ERROR: 网络中断（非内容问题/);
        expect(m).toContain('terminated');
      }

      const { mockCreate: mc2, callRetry: cr2 } = makeDispatcher();
      mc2.mockRejectedValue(new Anthropic.RateLimitError());
      await expect(cr2({ model: 'test', messages: [] })).rejects.toThrow();
      try { await cr2({ model: 'test', messages: [] }); } catch (e: any) {
        expect(String(e.message ?? e)).not.toContain('NETWORK_ERROR');
      }
    });

    it('retries InternalServerError up to 3 times', async () => {
      const { mockCreate, callRetry } = makeDispatcher();
      const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
      mockCreate
        .mockRejectedValueOnce(new Anthropic.InternalServerError())
        .mockRejectedValueOnce(new Anthropic.InternalServerError())
        .mockRejectedValueOnce(new Anthropic.InternalServerError())
        .mockResolvedValueOnce(OK_RESPONSE);
      const resp = await callRetry({ model: 'test', messages: [] });
      expect(resp).toBeDefined();
      expect(mockCreate).toHaveBeenCalledTimes(4);
    });

    it('throws AuthenticationError immediately without retry', async () => {
      const { mockCreate, callRetry } = makeDispatcher();
      const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
      mockCreate.mockRejectedValueOnce(new Anthropic.AuthenticationError());
      await expect(callRetry({ model: 'test', messages: [] })).rejects.toThrow();
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('throws context overflow BadRequestError immediately', async () => {
      const { mockCreate, callRetry } = makeDispatcher();
      const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
      const err = new Anthropic.BadRequestError('context length exceeded, too many tokens');
      mockCreate.mockRejectedValueOnce(err);
      await expect(callRetry({ model: 'test', messages: [] })).rejects.toThrow();
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('throws after retries exhausted for unknown error', async () => {
      const { mockCreate, callRetry } = makeDispatcher();
      mockCreate.mockRejectedValue(new Error('unknown'));
      await expect(callRetry({ model: 'test', messages: [] })).rejects.toThrow('unknown');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  // 实例级上下文水位观测与软阈值告警（^anc-exec-ctx-watermark,hopissues/0095——150K+ 单轮
  // 延迟超线性恶化撞超时墙全程零观测;三项合计防缓存命中掩体量,双档告警各一次,阈值挂
  // max_context_tokens 零新配置键,不配则静默）。 // @v: anc-exec-ctx-watermark
  describe('上下文水位观测（0095）', () => {
    function makeWatermarkDispatcher(ctxLimit?: number) {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const host = ctxLimit
        ? { ...HOST, resource_limits: { max_tool_iterations: 20, max_context_tokens: ctxLimit, max_output_tokens: 4096, max_replan_attempts: 2 } }
        : HOST;
      const dispatcher = new StepDispatcher(engine, host);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      const callRetry = (dispatcher as any).callLlmWithRetry.bind(dispatcher);
      return { dispatcher, mockCreate, callRetry };
    }
    const respWithUsage = (inp: number, cacheRead = 0, cacheCreate = 0) => ({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: inp, output_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate },
    });

    it('正例：水位=三项合计取峰值（缓存命中不掩真实体量）,getCtxWatermark 透出', async () => {
      const { dispatcher, mockCreate, callRetry } = makeWatermarkDispatcher();
      mockCreate.mockResolvedValueOnce(respWithUsage(1000, 50_000, 2000));
      await callRetry({ model: 'test', messages: [] });
      expect(dispatcher.getCtxWatermark()).toBe(53_000);   // 单看 input_tokens 只有 1000——缓存掩体量的反面钉
      mockCreate.mockResolvedValueOnce(respWithUsage(30_000, 0, 0));
      await callRetry({ model: 'test', messages: [] });
      expect(dispatcher.getCtxWatermark()).toBe(53_000);   // 峰值取 max,回落不降账
    });

    it('正例：越 75% 档落 warn 一次,再越 100% 档升级 warn 一次,重复调用不重复告警', async () => {
      const { dispatcher, mockCreate, callRetry } = makeWatermarkDispatcher(100_000);
      const warns = (dispatcher as any).pendingToolWarns as string[];
      mockCreate.mockResolvedValue(respWithUsage(80_000));   // 越 75K 线
      await callRetry({ model: 'test', messages: [] });
      expect(warns.filter(w => w.includes('75%')).length).toBe(1);
      await callRetry({ model: 'test', messages: [] });   // 同水位再调:不重复
      expect(warns.filter(w => w.includes('75%')).length).toBe(1);
      mockCreate.mockResolvedValue(respWithUsage(120_000));   // 越 100K 线
      await callRetry({ model: 'test', messages: [] });
      expect(warns.filter(w => w.includes('已越 max_context_tokens（')).length).toBe(1);
      await callRetry({ model: 'test', messages: [] });
      expect(warns.filter(w => w.includes('已越 max_context_tokens（')).length).toBe(1);
    });

    it('反例：max_context_tokens 未配置 → 水位照记但零告警（向后兼容,与预检档同一开关哲学）', async () => {
      const { dispatcher, mockCreate, callRetry } = makeWatermarkDispatcher();
      mockCreate.mockResolvedValue(respWithUsage(500_000));
      await callRetry({ model: 'test', messages: [] });
      expect(dispatcher.getCtxWatermark()).toBe(500_000);
      expect(((dispatcher as any).pendingToolWarns as string[]).length).toBe(0);
    });

    it('正例：timeout 耗尽且水位越 75% → NETWORK_ERROR 文案带水位提示;网络类不带（瞬断无体量嫌疑）', async () => {
      const { mockCreate, callRetry, dispatcher } = makeWatermarkDispatcher(100_000);
      mockCreate.mockResolvedValueOnce(respWithUsage(90_000));
      await callRetry({ model: 'test', messages: [] });   // 先把水位抬过 75K
      const timeoutErr = Object.assign(new Error('Request timed out.'), { status: undefined });
      (dispatcher as any).defaultClient.classifyError = () => 'timeout';
      mockCreate.mockRejectedValue(timeoutErr);
      await expect(callRetry({ model: 'test', messages: [] })).rejects.toThrow(/水位 90K 已近告警线.*重试大概率同因/);
      // 网络类对照:同水位不带提示
      (dispatcher as any).defaultClient.classifyError = () => 'network';
      await expect(callRetry({ model: 'test', messages: [] })).rejects.toThrow(/NETWORK_ERROR: 网络中断（(?!.*水位)/);
    });
  });

  describe('checkBudget', () => {
    it('does not throw when under budget', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST, { tokenBudget: 1000 });
      const check = (dispatcher as any).checkBudget.bind(dispatcher);
      expect(() => check()).not.toThrow();
    });

    it('throws BUDGET_EXCEEDED when over budget', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST, { tokenBudget: 100 });
      (dispatcher as any).cumulativeTokens = 100;
      const check = (dispatcher as any).checkBudget.bind(dispatcher);
      expect(() => check()).toThrow('BUDGET_EXCEEDED');
    });

    it('does not throw when no budget configured', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).cumulativeTokens = 999999;
      const check = (dispatcher as any).checkBudget.bind(dispatcher);
      expect(() => check()).not.toThrow();
    });
  });

  describe('executionLoop state transitions', () => {
    const LLM_RESPONSE = {
      content: [{ type: 'text', text: 'the result' }],
      usage: { input_tokens: 50, output_tokens: 20 },
    };

    it('completed state returns completed result', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);

      // Complete step 1 manually so engine returns completed
      const next = engine.nextStep();
      if (next.status === 'step_ready') {
        engine.completeStep(next.step_id, { result: 'done' });
      }

      const result = await dispatcher.runSpec();
      expect(result.status).toBe('completed');
      expect(result.outputs).toBeDefined();
    });

    it('failed state returns failed result', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);

      const next = engine.nextStep();
      if (next.status === 'step_ready') {
        engine.failStep(next.step_id, 'manual fail');
      }

      const result = await dispatcher.runSpec();
      expect(result.status).toBe('failed');
      expect(result.failure?.reason).toContain('manual fail');
    });

    // B 半边网络暂停（^anc-exec-network-pause——dr17 实撞:NETWORK_ERROR 当普通失败吃容器
    // 内容重试预算,43 秒烧穿整树;持续断网应转 paused 树不报废,网络恢复 resume 续跑）
    // @v: anc-exec-network-pause
    // 范围注记 v2（b 案,review B1-1）：parallel call 子实例网络耗尽转 paused(network)入 U4b 队列
    // ——树不报废;网络恢复按 childInstance 应答免答续跑。 // @v: anc-exec-network-pause
    it('正例（b 案）：parallel call 子实例网络耗尽 → 入 HITL 队列 paused(network),恢复后免答续跑到 completed', async () => {
      const CALLEE = `# Sub
Id: sub
## Goal
g
## Inputs
- x: int  # 入
## Outputs
- y: text  # 出
## Steps
1. [reason] 想
  - ← x
  + → y: text  # 出
2. [exit]
`;
      const CALLER = `# Par
Id: par
## Goal
g
## Inputs
- xs: [int]  # 入列表
## Outputs
- ys: [text]  # 出列表
## Steps
1. [loop for-each x in xs, collect y into ys] 逐项并行调子
  + → ys: [text]  # 出列表
  1.1. [call sub(x) parallel] 并行调子
    + → y: y  # 收
2. [exit] 交付
`;
      const host: HostConfig = { ...HOST, spec_provider: { resolve: async (id: string) => id === 'sub' ? { spec_id: 'sub', source: CALLEE } : null } };
      // 子实例 Dispatcher 各自 new client——mock 挂构造器级共享（sleep 同理:原型级 stub 覆盖子层退避）
      const origImpl = (Anthropic as any).getMockImplementation();
      const sharedCreate = vi.fn().mockRejectedValue(new TypeError('fetch failed'));   // 持续断网
      (Anthropic as any).mockImplementation(() => ({ messages: { create: sharedCreate } }));
      const origSleep = (StepDispatcher.prototype as any).sleep;
      (StepDispatcher.prototype as any).sleep = () => Promise.resolve();
      try {
      const engine = new ExecutionEngine();
      const initR = engine.initExecution(CALLER, host, { params: { xs: [1] } });
      expect(initR.status).toBe('ok');
      const dispatcher = new StepDispatcher(engine, host);

      const r = await dispatcher.runSpec();
      expect(r.status).toBe('paused');                               // 不 failed——子树不报废
      expect(r.pause?.pause_reason).toBe('network');
      const child = r.pause?.child_instance;
      expect(child).toBeDefined();                                   // U4b 队列卡携子实例寻址
      expect(engine.getInflight().find(f => f.child_instance === child)?.status).toBe('paused');

      sharedCreate.mockReset();
      sharedCreate.mockResolvedValue({ content: [{ type: 'text', text: 'y: 好了' }], usage: { input_tokens: 5, output_tokens: 5 } });   // 网络恢复
      const r2 = await dispatcher.resume(r.pause!.step_id, {}, undefined, child);   // 免答:空 answer
      expect(r2.status).toBe('completed');
      expect(String((r2.outputs?.ys as unknown[])?.[0])).toContain('好了');
      } finally {
        (Anthropic as any).mockImplementation(origImpl);
        (StepDispatcher.prototype as any).sleep = origSleep;
      }
    });

    it('正例：串行 call 内网络耗尽 → paused(network) 冒泡到顶,resume 经 call_path 免答续跑', async () => {
      const CALLEE = `# Sub2
Id: sub2
## Goal
g
## Inputs
- x: int  # 入
## Outputs
- y: text  # 出
## Steps
1. [reason] 想
  - ← x
  + → y: text  # 出
2. [exit]
`;
      const CALLER = `# Ser
Id: ser
## Goal
g
## Inputs
- x: int  # 入
## Outputs
- y: text  # 出
## Steps
1. [call sub2(x)] 串行调子
  + → y: y  # 收
2. [exit]
`;
      const host: HostConfig = { ...HOST, spec_provider: { resolve: async (id: string) => id === 'sub2' ? { spec_id: 'sub2', source: CALLEE } : null } };
      const origImpl = (Anthropic as any).getMockImplementation();
      const sharedCreate = vi.fn().mockRejectedValue(new TypeError('socket hang up'));
      (Anthropic as any).mockImplementation(() => ({ messages: { create: sharedCreate } }));
      const origSleep = (StepDispatcher.prototype as any).sleep;
      (StepDispatcher.prototype as any).sleep = () => Promise.resolve();
      try {
      const engine = new ExecutionEngine();
      engine.initExecution(CALLER, host, { params: { x: 1 } });
      const dispatcher = new StepDispatcher(engine, host);

      const r = await dispatcher.runSpec();
      expect(r.status).toBe('paused');                               // 经 callFrames 冒泡到顶
      expect(r.pause?.pause_reason).toBe('network');
      expect(r.pause?.call_path).toEqual(['1']);                     // 挂起帧路径在载荷

      sharedCreate.mockReset();
      sharedCreate.mockResolvedValue({ content: [{ type: 'text', text: 'y: 修好了' }], usage: { input_tokens: 5, output_tokens: 5 } });
      const r2 = await dispatcher.resume(r.pause!.step_id, {}, r.pause!.call_path);   // call_path 下钻免答
      expect(r2.status).toBe('completed');
      expect(String(r2.outputs?.y)).toContain('修好了');
      } finally {
        (Anthropic as any).mockImplementation(origImpl);
        (StepDispatcher.prototype as any).sleep = origSleep;
      }
    });

    it('正例：网络重试耗尽 → run 转 paused(reason=network) 且步骤回置 pending 不 fail', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockRejectedValue(new TypeError('fetch failed'));   // 持续断网:全部调用网络错

      const result = await dispatcher.runSpec();
      expect(result.status).toBe('paused');                              // 不是 failed——树不报废
      expect(result.pause?.pause_reason).toBe('network');
      expect(result.pause?.step_id).toBe('1');
      expect(String(result.pause?.presented_data.context?.network_error)).toContain('NETWORK_ERROR');
      expect(engine.getStepStates().get('1')).toBe('pending');           // 步骤回置,非 failed
      expect(engine.getStatus().execution_status).not.toBe('failed');
    });

    it('正例：网络暂停后 resume 免答续跑——网络恢复即从断点完成', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockRejectedValue(new TypeError('socket hang up'));
      const paused = await dispatcher.runSpec();
      expect(paused.status).toBe('paused');

      mockCreate.mockReset();
      mockCreate.mockResolvedValue(LLM_RESPONSE);                        // 网络恢复
      const result = await dispatcher.resume('1', {});                   // 免答:answer 空对象即可
      expect(result.status).toBe('completed');
      expect(result.outputs?.result).toBeDefined();
    });

    it('反例守卫：worker 子 Dispatcher 网络耗尽仍走 failStep（暂停门 v1 不对 worker 开）', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST, { worker: true });
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockRejectedValue(new TypeError('fetch failed'));

      const result = await dispatcher.runSpec();
      expect(result.status).toBe('failed');                              // worker 照旧失败,父层 stale 对账兜底
      expect(result.failure?.reason).toContain('NETWORK_ERROR');
    });

    it('step_ready executes via LLM and completes', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();

      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockResolvedValue(LLM_RESPONSE);

      const result = await dispatcher.runSpec();
      expect(result.status).toBe('completed');
      expect(mockCreate).toHaveBeenCalled();
      expect(dispatcher.getCumulativeTokens()).toBeGreaterThan(0);
    });
  });

  // @v: anc-cli-execution-paused
  describe('confirm/commit steps pause execution', () => {
    it('confirm step returns paused status', async () => {
      const confirmSpec = `# Confirm Test
Id: confirm-test

## Goal
Test confirm pause

## Steps
1. [confirm] Approve action
  + → approval: bool  # user response
`;
      const engine = new ExecutionEngine();
      engine.initExecution(confirmSpec, HOST);

      const dispatcher = new StepDispatcher(engine, HOST);
      const executeStep = (dispatcher as any).executeStep.bind(dispatcher);

      const step = engine.nextStep();
      if (step.status === 'step_ready') {
        const result = await executeStep(step);
        expect(result).toBe('paused');
      }
    });

    it('commit step executes directly (no pause — authorization pre-completed)', async () => {
      const commitSpec = `# Commit Test
Id: commit-test

## Goal
Test commit direct execution

## Outputs
- approved: text  # result

## Steps
1. [commit] Approve changes
  + → approved: text  # user response
`;
      const engine = new ExecutionEngine();
      engine.initExecution(commitSpec, HOST);

      const dispatcher = new StepDispatcher(engine, HOST);
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      // commit 直接走 tool_use 循环 → mock LLM 返回最终输出
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'changes applied' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      });
      const executeStep = (dispatcher as any).executeStep.bind(dispatcher);

      const step = engine.nextStep();
      if (step.status === 'step_ready') {
        const result = await executeStep(step);
        // commit 不再返回 'paused'，而是直接执行返回结果
        expect(result).not.toBe('paused');
        expect(result.approved).toBe('changes applied');
      }
    });

    // commit 执行入口动态核（^anc-exec-advance-order-invariant 防线二,独立模式入口——
    // 0075 批:静态排布检查 P8 管不了运行期乱序,不可逆操作执行前核前序全终态）。
    // @v: anc-exec-advance-order-invariant
    it('commit 动态核反例：前序步骤非终态 → ADVANCE_ORDER_VIOLATION 抛带点名（executeStep catch 统一 failStep 走升级链）', async () => {
      const gateSpec = `# Commit Gate
Id: commit-gate-sa
## Goal
Test commit order gate
## Outputs
- out: text  # r
## Steps
1. [reason] 拟稿
  + → note: text
  > 拟一句稿。
2. [commit] 发布
  - ← note
  + → out: text
  > \`\`\`hop_python
  > out = "published:" + note
  > \`\`\`
`;
      const engine = new ExecutionEngine();
      const init = engine.initExecution(gateSpec, HOST);
      expect(init.status).toBe('ok');
      const dispatcher = new StepDispatcher(engine, HOST);
      const executeStep = (dispatcher as any).executeStep.bind(dispatcher);

      // 正常推进到 1,交付;再推进到 2（running）后模拟乱序残局:1 回 running
      let step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status !== 'step_ready') return;
      engine.completeStep('1', { note: 'ready' });
      step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status !== 'step_ready') return;
      expect(step.step_id).toBe('2');
      engine.getStepStates().set('1', 'running');
      await expect(executeStep(step)).rejects.toThrow(/ADVANCE_ORDER_VIOLATION.*'2'.*'1'/);
    });

    it('commit 动态核正例：正常序（前序全终态）→ 照常执行不拦', async () => {
      const gateSpec = `# Commit Gate OK
Id: commit-gate-ok
## Goal
Test commit normal order
## Outputs
- out: text  # r
## Steps
1. [reason] 拟稿
  + → note: text
  > 拟一句稿。
2. [commit] 发布
  - ← note
  + → out: text
  > \`\`\`hop_python
  > out = "published:" + note
  > \`\`\`
`;
      const engine = new ExecutionEngine();
      const init = engine.initExecution(gateSpec, HOST);
      expect(init.status).toBe('ok');
      const dispatcher = new StepDispatcher(engine, HOST);
      const executeStep = (dispatcher as any).executeStep.bind(dispatcher);

      let step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status !== 'step_ready') return;
      engine.completeStep('1', { note: 'ready' });
      step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status !== 'step_ready') return;
      expect(step.step_id).toBe('2');
      const result = await executeStep(step);
      expect(result).not.toBe('paused');
      expect(result.out).toBe('published:ready');
    });
  });

  // @v: anc-exec-adaptive-pipeline —— 三段流水线判据（A 档 2026-08-13）
  describe('handleAdaptive', () => {
    const SUBTASK_SPEC = `# Subtask
Id: subtask-test
## Goal
Test adaptive
## Outputs
- out: text  # output
## Steps
1. [subtask retry=2 adaptive] Do work
  + → out: text  # output
  1.1. [act] Try
    + → task_out: text  # output
`;

    it('三段流水线：分析→策略→生成各一发,后段吃前段产物,replan 成功（^anc-exec-adaptive-pipeline A档）', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SUBTASK_SPEC, HOST);
      engine.nextStep();
      engine.failStep('1.1', 'broke');
      engine.nextStep();              // 升级阶梯：第1次失败 → 带反馈重跑
      engine.failStep('1.1', 'broke again'); // 第2次失败 → adaptive_needed

      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '归因: 结构问题\n定位: 1.1 一步做太多\n证据: broke again' }], usage: { input_tokens: 10, output_tokens: 5 } })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '保留: 无\n替换: 1.1 拆两步\n新增意图: 分步降复杂度' }], usage: { input_tokens: 10, output_tokens: 5 } })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '1. [reason] Retry\n  + → out: text  # output\n  > Try again' }], usage: { input_tokens: 100, output_tokens: 50 } });

      const next = engine.nextStep();
      expect(next.status).toBe('adaptive_needed');

      const handleAdaptive = (dispatcher as any).handleAdaptive.bind(dispatcher);
      await handleAdaptive(next);

      // 三段恰各一发（不合并回一发——合并=退回自由生成）
      expect(mockCreate).toHaveBeenCalledTimes(3);
      // 后段吃前段产物：策略段请求含分析产物,生成段请求含策略产物
      const call2Body = JSON.stringify(mockCreate.mock.calls[1][0]);
      const call3Body = JSON.stringify(mockCreate.mock.calls[2][0]);
      expect(call2Body).toContain('结构问题');
      expect(call3Body).toContain('拆两步');
      // replan 生效
      const status = engine.getStatus();
      expect(status.pending).toBeGreaterThan(0);
    });

    // @v: anc-exec-subtask-free-expand —— standalone 消费分流（契约10,三轮review修复批:
    // handleAdaptive 原不读 reason,三段流水线强制归因不存在的失败）
    it('正例：initial_plan 单段生成——绕开三段流水线,请求携 expansion_context（修前红:三发归因调用）', async () => {
      const FREE_SPEC = `# Free
Id: free-test
## Goal
Test expand
## Outputs
- out: text  # output
## Steps
1. [reason] 前面
  + → a: text  # p
2. [subtask free] 到步展开
  - ← a
  + → out: text  # o
`;
      const engine = new ExecutionEngine();
      engine.initExecution(FREE_SPEC, HOST);
      engine.nextStep();
      engine.completeStep('1', { a: '真产出' });
      const next = engine.nextStep() as any;
      expect(next.status).toBe('adaptive_needed');
      expect(next.reason).toBe('initial_plan');

      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n' }], usage: { input_tokens: 10, output_tokens: 5 } });

      const handleAdaptive = (dispatcher as any).handleAdaptive.bind(dispatcher);
      await handleAdaptive(next);

      // 单段恰一发（修前形态:三段流水线三发,第一发是失败归因）
      expect(mockCreate).toHaveBeenCalledTimes(1);
      // 请求携运行时上下文与 plan 措辞（非 failed 措辞）
      const callBody = JSON.stringify(mockCreate.mock.calls[0][0]);
      expect(callBody).toContain('真产出');
      expect(callBody).toContain('Plan required');
      expect(callBody).not.toContain('failed.');
      // 展开生效:children 落地
      expect(engine.getStatus().pending).toBeGreaterThan(0);
    });

    // @v: anc-exec-subtask-free-expand —— 契约7 standalone 续批半边（撞限转暂停/收手收口/授权时序/纯内存短路）
    it('正例：standalone 撞 EXPANSION_LIMIT 全链——暂停问人→guidance 应答→携授权重生成落地（作者定"关键特性不等真需求",修前形态:烧 replanAttempts 而死）', async () => {
      const FREE_SPEC = `# Free
Id: free-ext
## Goal
Test extend
## Config
expansion_max: 1
## Outputs
- out: text  # output
## Steps
1. [reason] 前面
  + → a: text  # p
2. [subtask free] 到步展开
  - ← a
  + → out: text  # o
`;
      const engine = new ExecutionEngine();
      engine.initExecution(FREE_SPEC, HOST);
      engine.nextStep();
      engine.completeStep('1', { a: '真产出' });
      (engine as any).expansionCount = 1;   // 底账直置达限（上限 1）
      const next = engine.nextStep() as any;
      expect(next.reason).toBe('initial_plan');

      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      const PLAN = '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n';
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: PLAN }], usage: { input_tokens: 10, output_tokens: 5 } });

      // ① 撞限:handleAdaptive 提交被拒 → 转升层暂停,不烧 replanAttempts
      const handleAdaptive = (dispatcher as any).handleAdaptive.bind(dispatcher);
      await handleAdaptive(next);
      expect(engine.getEscalatePending()).toBe('2');
      expect((dispatcher as any).replanAttempts.get('2') ?? 0).toBe(0);   // 问路不烧熔断
      // ② 暂停卡语义:问"继续还是收手",context 携计数与被拒计划（纯内存实例不落盘卡,
      // 从 pauseForExpansionExtend 返回对象断言——盘卡半边归"纯内存短路"钉+落盘实例经 memo 同源）
      const card = engine.pauseForExpansionExtend('2', 'x') as any;
      expect(card.pause_reason).toBe('escalate');
      expect(card.presented_data.question).toContain('继续还是收手');
      expect(card.presented_data.context.expansion_count).toBe(1);
      // ③ 应答"继续":resume 清待答+记授权账
      const r = await dispatcher.resume('2', { guidance: '继续,方向:只做两步' });
      // ④ resume 内的执行循环已消费授权:重生成携 extendExpansion 放行,children 落地接续执行
      expect(engine.getEscalatePending()).toBeNull();
      expect((dispatcher as any).expansionExtendGranted.has('2')).toBe(false);   // 授权消费即清
      expect((engine as any).expansionCount).toBe(2);   // 放行照常计数
      // 重生成 prompt 吸收人给的方向（resume 后循环继续跑 children,重生成不是最后一次调用——全调用序里找）
      const allBodies = mockCreate.mock.calls.map((c: unknown[]) => JSON.stringify(c[0]));
      expect(allBodies.some((b: string) => b.includes('只做两步') && b.includes('展开续批指引'))).toBe(true);
      void r;
    });

    it('反例：展开续批 resume 走 subtask 形态分支——不碰 retryHistory/stepStates（变异 C 实锤:删分支走 check 路径 794 钉全绿存活,分支存在理由须上锁）', async () => {
      const FREE_SPEC = `# Free
Id: free-branch
## Goal
g
## Config
expansion_max: 1
## Outputs
- out: text  # o
## Steps
1. [reason] 前面
  + → a: text  # p
2. [subtask free] 到步展开
  - ← a
  + → out: text  # o
`;
      const engine = new ExecutionEngine();
      engine.initExecution(FREE_SPEC, HOST);
      engine.nextStep();
      engine.completeStep('1', { a: 'x' });
      (engine as any).expansionCount = 1;
      engine.nextStep();
      engine.pauseForExpansionExtend('2', 'plan');
      const r = engine.resumeFromEscalation('2', '继续') as any;
      expect(r.status).toBe('ok');
      // 分支语义:retryHistory 不塞【升层指引】——那是 check 路径的动作(guidance 消费归
      // dispatcher 授权账;若走 check 路径此处必有指引记录,变异 C 即红)
      const hist = (engine as any).retryHistory.get('2') ?? [];
      expect(JSON.stringify(hist)).not.toContain('升层指引');
      // 待答态与卡副本双清
      expect(engine.getEscalatePending()).toBeNull();
      expect((engine as any).escalateCardMemo).toBeNull();
    });

    it('反例：纯内存实例撞限暂停后 nextStep 短路回内存卡——不跌落再吐 initial_plan（修前红:盘卡 null 直通死循环,review 探针 OOM 实锤）', () => {
      const FREE_SPEC = `# Free
Id: free-mem
## Goal
g
## Config
expansion_max: 1
## Outputs
- out: text  # o
## Steps
1. [reason] 前面
  + → a: text  # p
2. [subtask free] 到步展开
  - ← a
  + → out: text  # o
`;
      const engine = new ExecutionEngine();   // 无 stateDir——纯内存,卡不落盘
      engine.initExecution(FREE_SPEC, HOST);
      engine.nextStep();
      engine.completeStep('1', { a: 'x' });
      (engine as any).expansionCount = 1;
      engine.nextStep();
      engine.pauseForExpansionExtend('2', 'plan');
      // 修前形态:readPausedCardRaw()=null → 跌落 adaptiveNeededSubtask 再吐 initial_plan(死循环单步)
      const n1 = engine.nextStep() as any;
      expect(n1.status).toBe('paused');
      expect(n1.pause_reason).toBe('escalate');
      // 幂等再取仍是卡
      const n2 = engine.nextStep() as any;
      expect(n2.status).toBe('paused');
    });

    it('反例：人答"收手"→ 不入授权账,failStep 走失败收口（修前红:任何应答都变续批授权,收手仍多烧一次展开）', async () => {
      const FREE_SPEC = `# Free
Id: free-stop
## Goal
g
## Config
expansion_max: 1
## Outputs
- out: text  # o
## Steps
1. [reason] 前面
  + → a: text  # p
2. [subtask free] 到步展开
  - ← a
  + → out: text  # o
`;
      const engine = new ExecutionEngine();
      engine.initExecution(FREE_SPEC, HOST);
      engine.nextStep();
      engine.completeStep('1', { a: 'x' });
      (engine as any).expansionCount = 1;
      const next = engine.nextStep() as any;
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '1. [act free] 干\n  - ← a\n  + → out: text  # o\n2. [check final] 核\n  - ← out\n  + → ok: bool  # k\n  + → note: text  # n' }], usage: { input_tokens: 10, output_tokens: 5 } });
      await (dispatcher as any).handleAdaptive(next);
      expect(engine.getEscalatePending()).toBe('2');
      const callsBefore = mockCreate.mock.calls.length;
      const r = await dispatcher.resume('2', { guidance: '收手' });
      expect((dispatcher as any).expansionExtendGranted.has('2')).toBe(false);   // 不入授权账
      expect(r.status).toBe('failed');   // 失败收口——deterministic 不进 retry 阶梯(普通 fail 会重展开再问一遍收手,骚扰)
      expect((engine as any).expansionCount).toBe(1);   // 没有多烧展开
      void callsBefore;
    });

    // @v: anc-exec-call-child-persist —— 子实例状态落盘随父（2026-08-29 作者定"为啥不落盘"四坑翻案）
    describe('call 子实例状态落盘随父', () => {
      const CALLER = `# P
Id: p
## Goal
g
## Inputs
- base: text  # in
## Outputs
- out: text  # o
## Steps
1. [call child(n: base)] 调子
  + → out: child_out
`;
      const CHILD = `# C
Id: child
## Goal
g
## Inputs
- n: text  # in
## Outputs
- child_out: text  # o
## Steps
1. [act] 算
  - ← n
  + → child_out: text  # o
> 计算
> \`\`\`hop_python
> child_out = n + "!"
> \`\`\`
`;
      it('正例：父落盘 → 子实例状态落 <父instanceDir>/calls/<callStepId>/（与复用模式同布局,state.json 在盘）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ccp-'));
        const hostX: HostConfig = { ...HOST, spec_provider: { resolve: async (id: string) => id === 'child' ? { spec_id: 'child', source: CHILD } : null } };
        const engine = new ExecutionEngine();
        engine.initExecution(CALLER, hostX, { stateDir: dir, params: { base: 'x' } });
        const d = new StepDispatcher(engine, hostX);
        (d as any).sleep = () => Promise.resolve();
        const r = await d.runSpec();
        expect(r.status).toBe('completed');
        const parentDir = engine.getInstanceDir()!;
        const childState = join(parentDir, 'calls', '1', 'state.json');
        expect(existsSync(childState)).toBe(true);
        // 四坑之④代表断言:子实例盘上账在,复用模式退火传播的读取路径(readState(childDir))从此有料可读
        const st = JSON.parse(readFileSync(childState, 'utf-8'));
        expect(st.step_states?.['1']).toBe('done');   // 子实例执行痕迹在盘（真实键名 step_states——退火传播 readState 同源）
        // 四坑之①代表断言:work_zone 随 FilePersistence.init 建立(deflate 有落点)
        expect(existsSync(join(parentDir, 'calls', '1', 'work_zone'))).toBe(true);
      });

      it('反例：父纯内存 → 子随纯内存,不落任何盘（"无跨进程"假设在纯内存宿主真成立,现状形态保留）', async () => {
        const hostX: HostConfig = { ...HOST, spec_provider: { resolve: async (id: string) => id === 'child' ? { spec_id: 'child', source: CHILD } : null } };
        const engine = new ExecutionEngine();
        engine.initExecution(CALLER, hostX, { params: { base: 'x' } });   // 无 stateDir
        const d = new StepDispatcher(engine, hostX);
        (d as any).sleep = () => Promise.resolve();
        const r = await d.runSpec();
        expect(r.status).toBe('completed');
        expect(engine.getInstanceDir()).toBeNull();   // 父无盘,子建盘无从谈起——判据本身即断言
      });

      // 契约条 2:parallel worker 子实例同判据（review 变异 A2 实锤零钉:删 launchParallelSubtask
      // 的 stateDir 传参全量 2293 绿存活——本钉锁该击杀面:再删必红）
      it('正例：父落盘 → parallel worker 子实例状态落 <父instanceDir>/parallel/<childId>/（契约条2,锁变异A2击杀面）', async () => {
        const PAR = `# PP
Id: pp
## Goal
g
## Inputs
- nums: [int]  # 列表
## Outputs
- doubled: [int]  # 翻倍
## Steps
1. [loop for-each n in nums, collect d into doubled] 逐个翻倍
  + → doubled: [int]  # 收集
  1.1. [subtask parallel] 翻倍一项
    + → d: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → d: int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > d = n * 2
      > \`\`\`
2. [exit] 交付
`;
        const dir = mkdtempSync(join(tmpdir(), 'ccp-par-'));
        const engine = new ExecutionEngine();
        engine.initExecution(PAR, HOST, { stateDir: dir, params: { nums: [1, 2] } });
        const d = new StepDispatcher(engine, HOST);
        (d as any).sleep = () => Promise.resolve();
        const r = await d.runSpec();
        expect(r.status).toBe('completed');
        expect(r.outputs?.doubled).toEqual([2, 4]);
        const parentDir = engine.getInstanceDir()!;
        // worker 子实例落 parallel/<childId>/——state.json 与 work_zone 都在盘
        const childState = join(parentDir, 'parallel', '1.1.1', 'state.json');
        expect(existsSync(childState)).toBe(true);
        expect(existsSync(join(parentDir, 'parallel', '1.1.1', 'work_zone'))).toBe(true);
        const st = JSON.parse(readFileSync(childState, 'utf-8'));
        expect(st.step_states?.['1.1.1']).toBe('done');   // worker 执行痕迹在盘
      });

      // 连锁修②:stale 重建 runSpec 三态的 paused 分支（review 变异 C 实锤零钉:删 reconcileAndRebuild
      // 的 paused 分支〔dispatcher.ts L426-434〕全量 2293 绿存活——本钉锁该击杀面:paused 子实例
      // 必须重新入队等应答,而不是被 else 当失败收割）
      it('正例：stale 重建遇 paused 子实例 → 重新入队等应答而非失败收割（连锁修②,锁变异C击杀面）', { timeout: 20000 }, async () => {
        const ASKP = `# AP
Id: ap
## Goal
g
## Inputs
- items: [int]  # 列表
## Outputs
- vals: [int]  # 收集
## Steps
1. [loop for-each it in items, collect human_val into vals] 逐项
  + → vals: [int]  # 收集
  1.1. [subtask parallel] 问人
    + → human_val: int  # 人值
    1.1.1. [ask require_human=true] 请提供
      - ← it
      + → human_val: int  # 人值
2. [exit] 交付
`;
        const dir = mkdtempSync(join(tmpdir(), 'ccp-stale-'));
        // 第一程:跑到子实例 ask 暂停(子状态落盘,子盘面=ask 步 pending 活跃态)
        const engine1 = new ExecutionEngine();
        engine1.initExecution(ASKP, HOST, { stateDir: dir, params: { items: [7] } });
        const d1 = new StepDispatcher(engine1, HOST);
        (d1 as any).sleep = () => Promise.resolve();
        const r1 = await d1.runSpec();
        expect(r1.status).toBe('paused');
        const instDir = engine1.getInstanceDir()!;
        // 模拟崩溃时点=子实例暂停冒泡之前(父账未记 paused):把父账 inflight 状态改回 inflight——
        // 这是 stale 名单的入口形态(盘上子实例活跃未终态→stale→reconcileAndRebuild 重建),
        // 重建 runSpec 走到 ask 返回 paused,吃进被变异C删除的那个 paused 分支
        const pStatePath = join(instDir, 'state.json');
        const pState = JSON.parse(readFileSync(pStatePath, 'utf-8'));
        expect(pState.inflight?.length).toBe(1);
        pState.inflight[0].status = 'inflight';
        writeFileSync(pStatePath, JSON.stringify(pState));
        // 从盘重建(d1 全部内存丢弃)
        const engine2 = ExecutionEngine.load(instDir);
        const d2 = new StepDispatcher(engine2, HOST);
        (d2 as any).sleep = () => Promise.resolve();
        await (d2 as any).reconcileAndRebuild();
        // 等重建 promise settle(子实例重跑到暂停点)
        for (let i = 0; i < 150; i++) {
          if ((d2 as any).pausedChildren.size > 0) break;
          const anyFailed = engine2.getInflight().some((f: { status: string }) => f.status === 'failed');
          if (anyFailed) break;   // 失败收割即坏形态,提早退出去断言
          await new Promise(res => setTimeout(res, 100));
        }
        // 击杀面断言:paused 子实例重新入队(pausedChildren 有它),而非被失败收割
        expect((d2 as any).pausedChildren.size).toBe(1);
        const failed = engine2.getInflight().filter((f: { status: string }) => f.status === 'failed');
        expect(failed).toHaveLength(0);
      });
    });

    // @v: anc-exec-adaptive-pipeline —— 片段编号归一（0030 复验实锤:LLM 片段带子编号 parse 关就死）
    it('正例：replace 片段带子编号（LLM 自然形态 1.1.）→ 扁平化归一后 parse 过,拼装成功（修前 references non-existent parent 三轮同因全灭）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SUBTASK_SPEC, HOST);
      const d = new StepDispatcher(engine, HOST);
      const edits = (d as any).parseReplanEdits('{"edits": [{"op": "replace", "step_id": "1.1", "why": "改取内层值"}]}', '1');
      expect(edits).not.toBeNull();
      // LLM 替换 1.1 时自然写 1.1. 子编号——修前 parseFragment 拒,fragOf null,整次回退
      const patch = '<<EDIT 0>> 换\n1.1. [act] 按新格式累加\n  + → task_out: text  # 取 value 累加';
      const md = (d as any).assembleReplanEdits(edits, patch, '1');
      expect(md).not.toBeNull();
      expect(md).toMatch(/^1\. \[act\] 按新格式累加/m);   // 子编号归一为顶层连号
    });

    it('正例：flattenFragmentNumbering——顶层连号+子行前缀整树随父改写;已连号幂等（review 修正:首版只改顶层号,子行成 orphan 的坏中间态曾被固化为正例）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SUBTASK_SPEC, HOST);
      const d = new StepDispatcher(engine, HOST);
      const flat = flattenFragmentNumbering;
      expect(flat('1.1. [act] 甲\n  + → a: text  # a\n2.3.1. [reason] 乙\n  - ← a\n  + → b: text  # b'))
        .toBe('1. [act] 甲\n  + → a: text  # a\n2. [reason] 乙\n  - ← a\n  + → b: text  # b');
      const already = '1. [act] 甲\n  + → a: text  # a\n2. [reason] 乙\n  + → b: text  # b';
      expect(flat(already)).toBe(already);                    // 幂等
      // 容器片段:子行前缀随父改写（1.1.→1. 时 1.1.1.→1.1.——树关系保持,flatten 后 parse 必须过）
      const nested = flat('1.1. [subtask] 甲\n  + → c: text\n  1.1.1. [act] 子\n    + → c: text  # c');
      expect(nested).toContain('1. [subtask] 甲');
      expect(nested).toContain('  1.1. [act] 子');
      const parsed = parseFragment(nested);
      expect(parsed.errors).toEqual([]);                       // 端到端:flatten 产物 parse 零错（修前 orphan）
      expect(parsed.ast.steps?.[0]?.children?.[0]?.step_id).toBe('1.1');
    });

    it('正例：围栏内形似编号的行不被改不计数（P2-4 裁定 A——注释/模板素材里的 markdown 列表不受染,围栏外真步骤连号不跳变）', () => {
      const flat = flattenFragmentNumbering;
      const md = '2.1. [act] 甲\n  + → a: text  # a\n```\n1. 围栏里的列表行\n3.3. 也别动我\n```\n2.2. [act] 乙\n  + → b: text  # b';
      const out = flat(md);
      expect(out).toContain('1. [act] 甲');
      expect(out).toContain('1. 围栏里的列表行');       // 围栏内原样
      expect(out).toContain('3.3. 也别动我');            // 围栏内原样
      expect(out).toContain('2. [act] 乙');              // 围栏内行不占计数——真步骤连号 1,2 不跳变
    });

    it('正例：零缩进合法层级不被拍平——父前缀在场时子随父,树关系保持（review 抓回归:首版把 1.+1.1. 拍成同级静默走样）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SUBTASK_SPEC, HOST);
      const d = new StepDispatcher(engine, HOST);
      const flat = flattenFragmentNumbering;
      const legal = '1. [subtask] 容器\n  + → out: text\n1.1. [act] 孩子\n  + → out: text  # o';
      expect(flat(legal)).toBe(legal);                         // 幂等:1.1. 的父 1. 在场→子随父,号不变
      const parsed = parseFragment(flat(legal));
      expect(parsed.errors).toEqual([]);
      expect(parsed.ast.steps?.[0]?.children?.[0]?.step_id).toBe('1.1');   // 父子关系保持非同级
    });

    // @v: anc-exec-adaptive-pipeline —— submitReplan 拒因留痕（0030）
    it('反例：生成段产物过不了 submitReplan 静态闸 → 拒因入 HopLog submit_rejected,终态 reason 携末轮拒因摘要（0030——修前只记死文案,三轮各败在哪零留痕）', async () => {
      // 本例日志级别用 warn（P2 归类裁定:submit_rejected 是错误凭证挂审计通道恒写——warn 级
      // '只看出事'的用户恰恰最该看到;同时反差断言流控字段 replan_pipeline 在 warn 级被裁剪）
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'replan-rej-'));
      const engine = new ExecutionEngine();
      engine.initExecution(SUBTASK_SPEC, HOST, { logDir: dir, logLevel: 'warn' });
      engine.nextStep();
      engine.failStep('1.1', 'broke');
      engine.nextStep();
      engine.failStep('1.1', 'broke again');

      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockClear();
      // 三轮 replan:每轮三段（分析/策略散文→触发全量生成分支）,生成段给"引用未定义变量"的坏 children
      // ——submitReplan 静态闸必拒（V1 未定义变量）,拒因应留痕而非蒸发
      mockCreate.mockImplementation((req: { messages: { content: unknown }[] }) => {
        const body = JSON.stringify(req.messages);
        if (body.includes('改动策略') || body.includes('归因')) {
          return Promise.resolve({ content: [{ type: 'text', text: '分析或策略产物' }], usage: { input_tokens: 5, output_tokens: 5 } });
        }
        return Promise.resolve({ content: [{ type: 'text', text: '分析或策略产物' }], usage: { input_tokens: 5, output_tokens: 5 } });
      });
      // 更简单:三段全部返回同一坏产物——生成段产出引用幽灵变量的步骤,submitReplan V1 必拒
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '1. [reason] 坏步\n  + → unrelated: text  # 不产出容器声明的 out——完备性闸必拒' }], usage: { input_tokens: 5, output_tokens: 5 } });

      let next = engine.nextStep();
      expect(next.status).toBe('adaptive_needed');
      const handleAdaptive = (dispatcher as any).handleAdaptive.bind(dispatcher);
      // 三轮耗尽（maxReplanAttempts=3,每轮 handleAdaptive 一次）
      await handleAdaptive(next);
      next = engine.nextStep();
      if (next.status === 'adaptive_needed') { await handleAdaptive(next); next = engine.nextStep(); }
      if (next.status === 'adaptive_needed') { await handleAdaptive(next); next = engine.nextStep(); }

      // ①终态 reason 携末轮拒因摘要（非裸死文案）——failed 响应字段是 failure_reason
      expect(next.status).toBe('failed');
      const failedNext = next as { failure_reason?: string };
      expect(failedNext.failure_reason ?? '').toContain('Replan failed after');
      expect(failedNext.failure_reason ?? '').toContain('last:');            // 末轮拒因摘要在场
      // ②HopLog 有 submit_rejected 拒因数组
      const { readdirSync, readFileSync } = await import('node:fs');
      const runDir = readdirSync(dir).find(f => f.startsWith('subtask-test-'));
      const log = readFileSync(join(dir, runDir!, 'main.yaml'), 'utf-8');
      expect(log).toContain('submit_rejected');                              // 审计通道:warn 级仍恒写
      expect((log.match(/submit_rejected:/g) ?? []).length).toBe(3);         // 逐轮记账恰三条（P2-8:锁住'三轮各败在哪'契约,防退化成只记末轮）
      expect(log).not.toContain('failure_analysis');                         // 反差:流控字段 warn 级照裁
      expect(log).toMatch(/out|完备|coverage|Output/i);                       // 拒因原文可读（完备性缺 out）
    });

    it('反例回归：replan 管线的软偏好落级 warn 随 subtask 落 HopLog——三段管线也是 LLM 调用路径,不许悬空（review 抓漏 2026-08-13）', async () => {
      const SPEC_PREF = `# Subtask
Id: subtask-pref
Config:
- models:
  - replan: ghostsvc/super-model
## Goal
Test adaptive
## Outputs
- out: text  # output
## Steps
1. [subtask retry=2 adaptive] Do work
  + → out: text  # output
  1.1. [act] Try
    + → task_out: text  # output
`;
      const engine = new ExecutionEngine();
      const tmpDir = mkdtempSync(join(tmpdir(), 'hoptest-replanwarn-'));
      engine.initExecution(SPEC_PREF, HOST, { logDir: tmpDir });
      engine.nextStep();
      engine.failStep('1.1', 'broke');
      engine.nextStep();
      engine.failStep('1.1', 'broke again');

      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '归因: 结构问题' }], usage: { input_tokens: 10, output_tokens: 5 } })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '替换: 1.1' }], usage: { input_tokens: 10, output_tokens: 5 } })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '1. [reason] Retry\n  + → out: text  # output\n  > Try again' }], usage: { input_tokens: 100, output_tokens: 50 } });

      const next = engine.nextStep();
      expect(next.status).toBe('adaptive_needed');
      await ((dispatcher as any).handleAdaptive.bind(dispatcher))(next);

      const yaml = readFileSync(engine.getHopLog()!.getFilePath(), 'utf-8');
      expect(yaml).toContain('ghostsvc');   // 落级 warn 随 subtask 落盘,不悬空不错挂
      expect((dispatcher as unknown as { pendingToolWarns: string[] }).pendingToolWarns).toHaveLength(0);
    });

    it('反例：流水线段产物为空 → 该次尝试失败走既有预算（零新失败通道）', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SUBTASK_SPEC, HOST);
      engine.nextStep(); engine.failStep('1.1', 'broke');
      engine.nextStep(); engine.failStep('1.1', 'broke again');

      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: '   ' }], usage: { input_tokens: 1, output_tokens: 0 } });   // 分析段空产物

      const next = engine.nextStep();
      expect(next.status).toBe('adaptive_needed');
      await ((dispatcher as any).handleAdaptive.bind(dispatcher))(next);

      expect(mockCreate).toHaveBeenCalledTimes(1);   // 首段失败即停,不继续后段
      expect(((dispatcher as any).replanAttempts.get('1') ?? 0)).toBeGreaterThan(0);   // 计入既有预算
    });

    it('circuit breaker fails subtask after max attempts', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SUBTASK_SPEC, HOST);
      engine.nextStep();
      engine.failStep('1.1', 'broke');
      engine.nextStep();              // 升级阶梯：第1次失败 → 带反馈重跑
      engine.failStep('1.1', 'broke again'); // 第2次失败 → adaptive_needed

      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      // Set attempts at max
      (dispatcher as any).replanAttempts.set('1', 3);

      const next = engine.nextStep();
      expect(next.status).toBe('adaptive_needed');

      const handleAdaptive = (dispatcher as any).handleAdaptive.bind(dispatcher);
      await handleAdaptive(next);

      const status = engine.getStatus();
      expect(status.failed).toBeGreaterThan(0);
    });

    it('increments attempt counter on replan error', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SUBTASK_SPEC, HOST);
      engine.nextStep();
      engine.failStep('1.1', 'broke');
      engine.nextStep();              // 升级阶梯：第1次失败 → 带反馈重跑
      engine.failStep('1.1', 'broke again'); // 第2次失败 → adaptive_needed

      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      // Return invalid replan markdown that will fail submitReplan
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'not valid steps markdown' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const next = engine.nextStep();
      const handleAdaptive = (dispatcher as any).handleAdaptive.bind(dispatcher);
      await handleAdaptive(next);

      expect((dispatcher as any).replanAttempts.get('1')).toBeGreaterThan(0);
    });

    it('increments attempt counter on LLM API error', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SUBTASK_SPEC, HOST);
      engine.nextStep();
      engine.failStep('1.1', 'broke');
      engine.nextStep();              // 升级阶梯：第1次失败 → 带反馈重跑
      engine.failStep('1.1', 'broke again'); // 第2次失败 → adaptive_needed

      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockRejectedValueOnce(new Error('API down'));

      const next = engine.nextStep();
      const handleAdaptive = (dispatcher as any).handleAdaptive.bind(dispatcher);
      await handleAdaptive(next);

      expect((dispatcher as any).replanAttempts.get('1')).toBe(1);
    });
  });

  describe('executeActWithTools', () => {

    // @v: anc-exec-tool-failure-report —— C 案机械兜底（本步工具全 failure 却交正常产出→warn
    // 留痕不拦截——"检索故障伪装成搜不到"的静默退化形态给审计面抓手;有任一 success 或零工具
    // 调用不触发。变异实证:warn 判定块删除,下方全败正例红）
    it('C 案正例：本步工具调用全部失败却交正常产出 → recordWarn 落账（不拦截产出）', async () => {
      const actSpec = `# Act Test
Id: act-allfail-warn
## Goal
Test all-failure warn
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const engine = new ExecutionEngine();
      engine.initExecution(actSpec, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const warns: string[] = [];
      vi.spyOn(engine, 'getHopLog').mockReturnValue({
        recordWarn: (_id: string, msg: string) => { warns.push(msg); },
        recordStepMeta: () => {}, recordStepStart: () => {}, recordStepDone: () => {},
      } as any);
      // 工具恒失败的 provider
      (dispatcher as any).toolProvider = {
        list: () => [{ name: 'web_search', description: '检索', input_schema: { type: 'object', properties: {} }, requires_commit: false, category: 'basic' }],
        execute: async () => ({ result: '超时', success: false }),
      };
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'x' } }],
        usage: { input_tokens: 50, output_tokens: 20 },
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't2', name: 'web_search', input: { query: 'y' } }],
        usage: { input_tokens: 60, output_tokens: 20 },
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'result: 看起来正常的产出' }],
        usage: { input_tokens: 80, output_tokens: 10 },
      });
      const step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        const result = await executeAct(step);
        expect(result.result).toBeDefined();   // 产出照常返回,不拦截
      }
      const allFailWarns = warns.filter(w => w.includes('工具调用均失败'));
      expect(allFailWarns.length).toBe(1);
      expect(allFailWarns[0]).toContain('2 次');   // 计数如实
    });

    it('C 案反例：工具调用有一次 success → 不 warn（只认全败）', async () => {
      const actSpec = `# Act Test
Id: act-partial-ok
## Goal
Test partial success no warn
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const engine = new ExecutionEngine();
      engine.initExecution(actSpec, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const warns: string[] = [];
      vi.spyOn(engine, 'getHopLog').mockReturnValue({
        recordWarn: (_id: string, msg: string) => { warns.push(msg); },
        recordStepMeta: () => {}, recordStepStart: () => {}, recordStepDone: () => {},
      } as any);
      let call = 0;
      (dispatcher as any).toolProvider = {
        list: () => [{ name: 'web_search', description: '检索', input_schema: { type: 'object', properties: {} }, requires_commit: false, category: 'basic' }],
        execute: async () => (++call === 1 ? { result: '超时', success: false } : { result: '{"pages":[]}', success: true }),
      };
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'x' } }],
        usage: { input_tokens: 50, output_tokens: 20 },
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't2', name: 'web_search', input: { query: 'y' } }],
        usage: { input_tokens: 60, output_tokens: 20 },
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'result: ok' }],
        usage: { input_tokens: 80, output_tokens: 10 },
      });
      const step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        await executeAct(step);
      }
      expect(warns.filter(w => w.includes('工具调用均失败')).length).toBe(0);
    });

    it('C 案反例：本步零工具调用（直接产出）→ 不 warn', async () => {
      const actSpec = `# Act Test
Id: act-no-tools
## Goal
Test no tools no warn
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const engine = new ExecutionEngine();
      engine.initExecution(actSpec, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const warns: string[] = [];
      vi.spyOn(engine, 'getHopLog').mockReturnValue({
        recordWarn: (_id: string, msg: string) => { warns.push(msg); },
        recordStepMeta: () => {}, recordStepStart: () => {}, recordStepDone: () => {},
      } as any);
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'result: 直接答' }],
        usage: { input_tokens: 50, output_tokens: 10 },
      });
      const step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        await executeAct(step);
      }
      expect(warns.filter(w => w.includes('工具调用均失败')).length).toBe(0);
    });

    it('executes tool calls and returns final output', async () => {
      const actSpec = `# Act Test
Id: act-test
## Goal
Test act
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const engine = new ExecutionEngine();
      engine.initExecution(actSpec, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;

      // First call: tool use
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'bash', input: { command: 'echo hi' } },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
      });
      // Second call: final text response
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 80, output_tokens: 10 },
      });

      const step = engine.nextStep();
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        const result = await executeAct(step);
        expect(result.result).toBe('done');
        expect(mockCreate).toHaveBeenCalledTimes(2);
      }
    });

    // 中间轮截断闸（二十六审:掐在工具参数生成中途时半截参数会被直接执行——write 类工具吃
    // 残缺参数比收残值更危险）。
    // @v: anc-exec-output-truncation-loud
    it('throws OUTPUT_TRUNCATED when tool-use round is cut by max_tokens (no tool executed)', async () => {
      const actSpec = `# Act Test
Id: act-trunc
## Goal
Test truncation
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const engine = new ExecutionEngine();
      engine.initExecution(actSpec, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      const execSpy = vi.fn();
      (dispatcher as any).toolProvider = { list: () => [{ name: 'write', description: '', input_schema: {}, requires_commit: false }], execute: execSpy };

      mockCreate.mockResolvedValueOnce({
        stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', id: 't1', name: 'write', input: { path: 'x.md', content: '半截' } }],
        usage: { input_tokens: 50, output_tokens: 16384 },
      });

      const step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        await expect(executeAct(step)).rejects.toThrow(/OUTPUT_TRUNCATED.*工具/);
        expect(execSpy).not.toHaveBeenCalled();   // 残缺参数没被执行
      }
    });

    // @v: anc-obs-llm-response — 工具循环首轮 llm 块记 prompt（发送口抄实际 request——
    // "L4 工具清单有没有真进请求"hoplog 可对证）;后续轮不重复记（首轮已含组装上下文全文）。
    it('工具循环首轮 llm 块记 prompt、后续轮不记（清单可对证性）', async () => {
      const actSpec = `# Act Test
Id: act-prompt-log
## Goal
Test prompt logging
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const engine = new ExecutionEngine();
      engine.initExecution(actSpec, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const metas: Array<Record<string, unknown>> = [];
      vi.spyOn(engine, 'getHopLog').mockReturnValue({
        recordStepMeta: (_id: string, meta: Record<string, unknown>) => { metas.push(meta); },
        recordWarn: () => {}, recordStepStart: () => {}, recordStepDone: () => {},
      } as any);
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.md' } }],
        usage: { input_tokens: 50, output_tokens: 20 },
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 80, output_tokens: 10 },
      });
      const step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        await executeAct(step);
      }
      const llmMetas = metas.filter(m => m.llm) as Array<{ llm: { prompt?: string } }>;
      expect(llmMetas.length).toBe(2);
      // 正例:首轮 prompt 在场且含 L4 清单头（实发请求含工具语境的对证点）
      expect(llmMetas[0].llm.prompt).toBeDefined();
      expect(llmMetas[0].llm.prompt).toContain('本步可用工具');
      // 反例:后续轮不重复记 prompt
      expect(llmMetas[1].llm.prompt).toBeUndefined();
    });

    it('throws on max tool iterations exceeded', async () => {
      const actSpec = `# Act Test
Id: act-iter
## Goal
Test iteration limit
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const engine = new ExecutionEngine();
      engine.initExecution(actSpec, HOST);
      const dispatcher = new StepDispatcher(engine, HOST, { maxToolIterations: 2 });
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;

      // Always return tool use (never final text)
      mockCreate.mockResolvedValue({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'bash', input: { command: 'echo' } },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
      });

      const step = engine.nextStep();
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        await expect(executeAct(step)).rejects.toThrow('MAX_TOOL_ITERATIONS');
      }
    });

    // 工具循环 tool_result 内容渲染：对象结果 JSON 序列化,禁 String() 直转产 [object Object]
    // （fact-check 实撞:Composite 裁剪通过面返回对象,注入后 LLM 只见占位符,8 事实点全 not_found）
    // @v: anc-exec-tool-result-render
    it('serializes object tool results as JSON in tool_result content (not [object Object])', async () => {
      const actSpec = `# Act Test
Id: act-objres
## Goal
Test object result rendering
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const objToolProvider = {
        list: () => [{ name: 'web_search', description: 'search', input_schema: {}, requires_commit: false }],
        execute: vi.fn().mockResolvedValue({ result: { pages: [{ title: 'T1', url: 'https://a' }] }, success: true, content_type: 'json' }),
      };
      const hostWithTools: HostConfig = { ...HOST, tool_provider: objToolProvider };
      const engine = new ExecutionEngine();
      engine.initExecution(actSpec, hostWithTools);
      const dispatcher = new StepDispatcher(engine, hostWithTools);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;

      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tool_1', name: 'web_search', input: { query: 'q' } }],
        usage: { input_tokens: 50, output_tokens: 20 },
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 80, output_tokens: 10 },
      });

      const step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        await executeAct(step);
        // 第二轮请求的 tool_result content 是 JSON 文本,不是 "[object Object]"
        const secondCall = mockCreate.mock.calls[1][0];
        const userMsg = secondCall.messages.find((m: any) => m.role === 'user' && Array.isArray(m.content));
        const toolResult = userMsg.content.find((b: any) => b.type === 'tool_result');
        expect(toolResult.content).not.toContain('[object Object]');
        expect(JSON.parse(toolResult.content)).toEqual({ pages: [{ title: 'T1', url: 'https://a' }] });
      }
    });

    // 失败面防御性同判（设计条款三——review 抓零测试钉:实现顺带覆盖但缺回归防护,将来
    // rendered 挪进 success 分支或失败面单独 String() 机检不红）
    // @v: anc-exec-tool-result-render
    it('serializes object result in failure branch (Error: {json}, not [object Object])', async () => {
      const actSpec = `# Act Test
Id: act-objfail
## Goal
Test object failure rendering
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const failToolProvider = {
        list: () => [{ name: 'flaky', description: 'flaky', input_schema: {}, requires_commit: false }],
        execute: vi.fn().mockResolvedValue({ result: { code: 42, detail: 'quota exceeded' }, success: false, content_type: 'json' }),
      };
      const hostWithTools: HostConfig = { ...HOST, tool_provider: failToolProvider };
      const engine = new ExecutionEngine();
      engine.initExecution(actSpec, hostWithTools);
      const dispatcher = new StepDispatcher(engine, hostWithTools);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;

      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tool_1', name: 'flaky', input: { q: 'x' } }],
        usage: { input_tokens: 50, output_tokens: 20 },
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 80, output_tokens: 10 },
      });

      const step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        await executeAct(step);
        const secondCall = mockCreate.mock.calls[1][0];
        const userMsg = secondCall.messages.find((m: any) => m.role === 'user' && Array.isArray(m.content));
        const toolResult = userMsg.content.find((b: any) => b.type === 'tool_result');
        expect(toolResult.is_error).toBe(true);
        expect(toolResult.content).not.toContain('[object Object]');
        expect(toolResult.content).toMatch(/^Error: \{/);
        expect(toolResult.content).toContain('quota exceeded');
      }
    });

    // 反例守卫：字符串结果原样注入（既有行为零变化,不被 JSON.stringify 加引号）
    // @v: anc-exec-tool-result-render
    it('injects string tool results verbatim (no extra JSON quoting)', async () => {
      const actSpec = `# Act Test
Id: act-strres
## Goal
Test string result rendering
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const strToolProvider = {
        list: () => [{ name: 'fetch_page', description: 'fetch', input_schema: {}, requires_commit: false }],
        execute: vi.fn().mockResolvedValue({ result: 'plain text content', success: true, content_type: 'text' }),
      };
      const hostWithTools: HostConfig = { ...HOST, tool_provider: strToolProvider };
      const engine = new ExecutionEngine();
      engine.initExecution(actSpec, hostWithTools);
      const dispatcher = new StepDispatcher(engine, hostWithTools);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;

      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tool_1', name: 'fetch_page', input: { path: 'x' } }],
        usage: { input_tokens: 50, output_tokens: 20 },
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 80, output_tokens: 10 },
      });

      const step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        await executeAct(step);
        const secondCall = mockCreate.mock.calls[1][0];
        const userMsg = secondCall.messages.find((m: any) => m.role === 'user' && Array.isArray(m.content));
        const toolResult = userMsg.content.find((b: any) => b.type === 'tool_result');
        expect(toolResult.content).toBe('plain text content');
      }
    });
  });

  // @v: anc-exec-requires-commit, anc-config-sandbox-step-mapping
  describe('requires_commit enforcement in act steps', () => {
    it('throws COMMIT_REQUIRED when act step calls requires_commit=true tool', async () => {
      const actSpec = `# Act Test
Id: act-commit-required
## Goal
Test requires_commit
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const dangerousToolProvider = {
        list: () => [
          { name: 'safe_tool', description: 'safe', input_schema: {}, requires_commit: false },
          { name: 'dangerous_tool', description: 'dangerous', input_schema: {}, requires_commit: true },
        ],
        execute: vi.fn().mockResolvedValue({ result: 'ok', success: true }),
      };
      const hostWithTools: HostConfig = {
        ...HOST,
        tool_provider: dangerousToolProvider,
      };
      const engine = new ExecutionEngine();
      engine.initExecution(actSpec, hostWithTools);
      const dispatcher = new StepDispatcher(engine, hostWithTools);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;

      // LLM tries to call the dangerous tool
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'dangerous_tool', input: { data: 'x' } },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
      });

      const step = engine.nextStep();
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        await expect(executeAct(step)).rejects.toThrow('COMMIT_REQUIRED');
        // Should not have called execute on the dangerous tool
        expect(dangerousToolProvider.execute).not.toHaveBeenCalled();
      }
    });

    it('allows act step to call requires_commit=false tool', async () => {
      const actSpec = `# Act Test
Id: act-safe-tool
## Goal
Test safe tool
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const safeToolProvider = {
        list: () => [
          { name: 'safe_tool', description: 'safe', input_schema: {}, requires_commit: false },
        ],
        execute: vi.fn().mockResolvedValue({ result: 'ok', success: true }),
      };
      const hostWithTools: HostConfig = {
        ...HOST,
        tool_provider: safeToolProvider,
      };
      const engine = new ExecutionEngine();
      engine.initExecution(actSpec, hostWithTools);
      const dispatcher = new StepDispatcher(engine, hostWithTools);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;

      // First call: tool use (safe)
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'safe_tool', input: { data: 'x' } },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
      });
      // Second call: final text response
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 80, output_tokens: 10 },
      });

      const step = engine.nextStep();
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        const result = await executeAct(step);
        expect(result.result).toBe('done');
        expect(safeToolProvider.execute).toHaveBeenCalledWith('safe_tool', { data: 'x' }, 'work_zone');   // act 语境写域信号  // @v: anc-exec-write-scope
      }
    });
  });

  // @v: anc-exec-output-empty-loud — 空响应响亮闸（doc-review 第十二次实撞:步 20 response=""
  // output_tokens=9 正常收尾,单输出收空串 completed,空 domain_name 灌下游拼出 // 残路径。
  // 截断闸只认 max_tokens,管不到正常收尾的空——提取病族第四形态:内容真缺提取层不放行）
  describe('EMPTY_OUTPUT 空响应响亮失败', () => {
    const mk = () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      return new StepDispatcher(engine, HOST);
    };
    const parse = (d: StepDispatcher, text: string, schema: { name: string; type: string; description: string }[]) =>
      (d as any).parseStepOutput({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { output_tokens: 9 } }, schema);

    it('正例：正常收尾全空响应 → 抛 EMPTY_OUTPUT 含 output_tokens 实数（单输出）', () => {
      const d = mk();
      expect(() => parse(d, '', [{ name: 'result', type: 'text', description: '' }])).toThrow(/EMPTY_OUTPUT.*9/);
    });

    it('正例：纯空白响应 → 同抛（多输出路径同罩——否则回退逐行全键 null,列表宽容度归一空列表静默空转）', () => {
      const d = mk();
      expect(() => parse(d, '  \n\t\n ', [
        { name: 'a', type: 'text', description: '' },
        { name: 'b', type: '[yaml]', description: '' },
      ])).toThrow(/EMPTY_OUTPUT/);
    });

    it('反例：模型显式产出空值 `键: ""` → 合法业务值照常收不误拦（引号形态归下游 coerce 归一,本闸只管不拦）', () => {
      const d = mk();
      const out = parse(d, 'result: ""', [{ name: 'result', type: 'text', description: '' }]);
      expect(String(out.result)).not.toMatch(/EMPTY_OUTPUT/);   // 不抛不拦,值真收下
      expect(out.result === '' || out.result === '""').toBe(true);   // 空串或字面引号对,均属"收下"——绝不 undefined/null
    });
  });

  // @v: anc-exec-output-empty-loud — 步级重发半边（hopissues/0072:瞬时空响应曾直落 failStep
  // 点燃容器,好实例自激死锁——G244 实撞:check 步一次空喷烧掉整个 42 步 run）
  describe('EMPTY_OUTPUT 步级重发（耗尽才转容器）', () => {
    const mkReady = (engine: ExecutionEngine): StepReady => {
      const s = engine.nextStep();
      if (s.status !== 'step_ready') throw new Error('expect step_ready');
      return s;
    };

    it('正例：首轮空响应、次轮正常 → 步级自愈,步 completed 不点燃容器', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const step = mkReady(engine);
      let calls = 0;
      (dispatcher as any).executeStepWithTimeout = async (st: StepReady) => {
        calls++;
        if (calls === 1) throw new Error('EMPTY_OUTPUT: 模型响应为空白(output_tokens=9)');
        // 重发轮的 instruction 必须带空响应提醒（定向修正供给,不是盲重发）
        expect(st.context.instruction).toContain('上一次响应为空');
        return { result: 'healed' };
      };
      await (dispatcher as any).handleStepReady(step);
      expect(calls).toBe(2);
      const status = engine.getStatus();
      expect(status.completed).toBe(1);
      expect(status.failed).toBe(0);
    });

    it('反例：连空耗尽（首发+重发共 EMPTY_RETRY_MAX+1 次）→ failStep 转容器升级链,不无限重发', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const step = mkReady(engine);
      let calls = 0;
      (dispatcher as any).executeStepWithTimeout = async () => {
        calls++;
        throw new Error('EMPTY_OUTPUT: 模型响应为空白(output_tokens=9)');
      };
      await (dispatcher as any).handleStepReady(step);
      expect(calls).toBe(3);   // EMPTY_RETRY_MAX=2:首发 1 + 重发 2,与 SCHEMA_RETRY_MAX 对齐
      const status = engine.getStatus();
      expect(status.failed).toBe(1);
    });

    it('正例：paused 属正常返回值原样穿透包装层——不重发不计数（0072-review 面三缺口3补钉）', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const step = mkReady(engine);
      let calls = 0;
      (dispatcher as any).executeStepWithTimeout = async () => { calls++; return 'paused'; };
      await (dispatcher as any).handleStepReady(step);
      expect(calls).toBe(1);   // 单次直返,零重发
      expect(engine.getStatus().failed).toBe(0);
    });

    it('正例：重发自愈后 instruction 已复原不含提醒——残留会成为 SCHEMA 重试的错误归因基线（0072-review 面二缺陷2补钉;两轮重发也不叠加）', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const step = mkReady(engine);
      const origInstr = step.context.instruction;
      let calls = 0;
      (dispatcher as any).executeStepWithTimeout = async (st: StepReady) => {
        calls++;
        if (calls <= 2) {
          // 两轮重发的第二轮:提醒不叠加——恒 baseInstr+一份提醒,不是提醒摞提醒
          if (calls === 2) expect(st.context.instruction.match(/上一次响应为空/g)?.length).toBe(1);
          throw new Error('EMPTY_OUTPUT: 模型响应为空白(output_tokens=9)');
        }
        return { result: 'healed' };
      };
      await (dispatcher as any).handleStepReady(step);
      expect(calls).toBe(3);
      expect(step.context.instruction).toBe(origInstr);   // 自愈后复原,零残留
      expect(engine.getStatus().completed).toBe(1);
    });

    it('正例：每次重发落 recordWarn [empty-retry] 留痕（设计"观测轨迹不可缺"句的消费钉）', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const warns: string[] = [];
      (engine as any).getHopLog = () => ({ recordWarn: (_id: string, msg: string) => { warns.push(msg); } });
      const step = mkReady(engine);
      let calls = 0;
      (dispatcher as any).executeStepWithTimeout = async () => {
        calls++;
        if (calls === 1) throw new Error('EMPTY_OUTPUT: 模型响应为空白(output_tokens=9)');
        return { result: 'ok' };
      };
      await (dispatcher as any).handleStepReady(step);
      expect(warns.filter(w => w.includes('[empty-retry]'))).toHaveLength(1);
    });

    it('正例：SCHEMA 重做轮撞空响应 → 同享步级自救,不点燃容器（全口径罩,作者拍 A——原形态该口直调超时器,一发即落 failStep）', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const step = mkReady(engine);
      let calls = 0;
      (dispatcher as any).executeStepWithTimeout = async () => {
        calls++;
        if (calls === 1) return { wrong_field: 'x' };   // 首发:schema 不匹配 → 进 SCHEMA 重做轮
        if (calls === 2) throw new Error('EMPTY_OUTPUT: 模型响应为空白(output_tokens=9)');   // 重做轮首发:空响应
        return { result: 'healed' };   // 空响应自救重发:正常
      };
      await (dispatcher as any).handleStepReady(step);
      expect(calls).toBe(3);
      expect(engine.getStatus().completed).toBe(1);
      expect(engine.getStatus().failed).toBe(0);
    });

    it('反例：SCHEMA 重做轮连空耗尽 → 才转容器（自救有界,每口独立计数不无限）', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const step = mkReady(engine);
      let calls = 0;
      (dispatcher as any).executeStepWithTimeout = async () => {
        calls++;
        if (calls === 1) return { wrong_field: 'x' };
        throw new Error('EMPTY_OUTPUT: 模型响应为空白(output_tokens=9)');
      };
      await (dispatcher as any).handleStepReady(step);
      // 首发 1(schema 不匹配) + SCHEMA 重做口的自救 1+2=3 → 共 4 次后耗尽转容器
      expect(calls).toBe(4);
      expect(engine.getStatus().failed).toBe(1);
    });

    it('正例：lack_of_info 补检索重发口撞空响应 → 同享步级自救（三口全包的第三口钉——两批 review 面三变异 c 实抓零保护后补）', async () => {
      const engine = new ExecutionEngine();
      const hostK: HostConfig = { ...HOST, knowledge_provider: { retrieve: vi.fn().mockResolvedValue([{ source_id: 'kb', content: '补充知识', relevance: 'high' }]) } };
      engine.initExecution(SIMPLE_SPEC, hostK);
      const dispatcher = new StepDispatcher(engine, hostK);
      (dispatcher as any).sleep = () => Promise.resolve();
      const step = mkReady(engine);
      let calls = 0;
      (dispatcher as any).executeStepWithTimeout = async () => {
        calls++;
        if (calls === 1) return { lack_of_info: '缺某某资料' };   // 首发:缺信息 → 触发补检索重发
        if (calls === 2) throw new Error('EMPTY_OUTPUT: 模型响应为空白(output_tokens=9)');   // 重发口首发:空响应
        return { result: 'healed' };   // 自救重发:正常
      };
      await (dispatcher as any).handleStepReady(step);
      expect(calls).toBe(3);
      expect(engine.getStatus().completed).toBe(1);
      expect(engine.getStatus().failed).toBe(0);
    });

    it('反例：非 EMPTY_OUTPUT 异常不入重发通道,原样单次落容器（重发只治空响应,不掩别的病）', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const step = mkReady(engine);
      let calls = 0;
      (dispatcher as any).executeStepWithTimeout = async () => {
        calls++;
        throw new Error('LLM crashed');
      };
      await (dispatcher as any).handleStepReady(step);
      expect(calls).toBe(1);
      expect(engine.getStatus().failed).toBe(1);
    });
  });

  // @v: anc-exec-output-parse-self-labeled — 尾部自标签收窄（2026-08-31 作者对打回轮基准实抓:
  // deepseek 思考散文+尾部 `intro: 值`,全文即值把思考整段收进变量——形态契约"产出以 YAML 键值收尾"）
  describe('单输出尾部自标签收窄', () => {
    const mk = () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      return new StepDispatcher(engine, HOST);
    };
    const parse = (d: StepDispatcher, text: string, name = 'result') =>
      (d as any).parseStepOutput({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: {} }, [{ name, type: 'text', description: '' }]);

    it('正例：思考散文+尾部标签行（实撞形态）→ 只收标签行值,思考弃', () => {
      const d = mk();
      const text = 'Let me count the characters. Total = 37. Two sentences, under 60.\n\nresult: 这款保温杯长效锁温，轻巧便携。';
      const out = parse(d, text);
      expect(out.result).toBe('这款保温杯长效锁温，轻巧便携。');
      expect(String(out.result)).not.toContain('Let me count');
    });

    it('正例：思考+尾部块标量标签 → 收块标量正文', () => {
      const d = mk();
      const text = '先想一下结构。\n\nresult: |\n  第一行\n  第二行';
      const out = parse(d, text);
      expect(out.result).toBe('第一行\n第二行');
    });

    it('反例：无自标签行 → 照旧全文即值（宽容底线不动）', () => {
      const d = mk();
      const text = '就是一段没有键值形态的裸产出文本。';
      const out = parse(d, text);
      expect(out.result).toBe('就是一段没有键值形态的裸产出文本。');
    });

    it('反例：标签行后还有非空散文（形态含糊）→ 不误切,原样保留', () => {
      const d = mk();
      const text = 'result: 短值\n后面又来了一段散文评注';
      const out = parse(d, text);
      expect(out.result).toBe(text);   // 含糊形态零变化（既有纪律:不做猜测）
    });

    // 第三形态:空值键行+全缩进子结构（doc-review 第十四次实撞 2026-09-01:23.1 模型末轮完全
    // 照做——散文导语+顶格 `templates_content:` 空值键行+缩进嵌套 6 条列表 28KB,旧收窄只认
    // 块标量与行内值两形态,嵌套子结构判含糊原样,散文进值 coerce 炸,列表校验判非数组三轮烧尽）
    // @v: anc-exec-output-parse-self-labeled
    it('正例：散文+空值键行+缩进嵌套列表（第十四次实撞形态）→ 收子结构剥缩进,散文弃', () => {
      const d = mk();
      const text = '[thinking]\n已读取暂存件,现按声明输出。\n\nresult:\n  - file_name: a.md\n    content: A\n  - file_name: b.md\n    content: B';
      const out = parse(d, text);
      expect(String(out.result)).not.toContain('[thinking]');
      expect(String(out.result)).toContain('- file_name: a.md');
      // 收出的字符串是合法 YAML 列表（coerce 归一层随后 yamlLoad 成结构——此处直接验可解性）
      const parsed = yamlLoadRaw(String(out.result));
      expect(Array.isArray(parsed)).toBe(true);
      expect((parsed as unknown[]).length).toBe(2);
    });

    it('反例：空值键行后出现顶格非空行 → 子结构已终结形态含糊,原样保留', () => {
      const d = mk();
      const text = 'result:\n  - item: 1\n顶格散文尾巴';
      const out = parse(d, text);
      expect(out.result).toBe(text);
    });
  });

  // @v: anc-exec-lack-of-info-chain — lack_of_info 全链（2026-08-31 排查实锤死路:解析站杀键——
  // 单输出整段当声明值收下静默 completed 毒值入库/多输出键蒸发三轮白烧;修=前置探测短路,
  // 0053 旧钉直喂 completeStep 只护承接站,护不住解析站——本组从响应文本起步）
  describe('lack_of_info 全链（响应文本→解析→分流→failStep 带 kind）', () => {
    const mkEngine = (spec: string) => {
      const engine = new ExecutionEngine();
      engine.initExecution(spec, HOST);
      return engine;
    };
    const REASON_SINGLE = `# T
Id: loi-s
## Goal
g
## Outputs
- analysis: text  # 分析
## Steps
1. [reason] 分析
  + → analysis: text  # 分析
`;
    const REASON_MULTI = `# T
Id: loi-m
## Goal
g
## Outputs
- a: text  # x
## Steps
1. [reason] 分析
  + → a: text  # x
  + → b: line  # y
`;

    it('正例：单输出 reason 交 lack_of_info（含思考散文前导）→ failStep(kind=lack_of_info),不 completed 不毒值', async () => {
      const engine = mkEngine(REASON_SINGLE);
      const d = new StepDispatcher(engine, HOST);
      (d as any).sleep = () => Promise.resolve();
      const mockCreate = (d as any).defaultClient.messages.create;
      mockCreate.mockClear();
      mockCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '让我想想。材料里没有上游报表。\n\nlack_of_info: 缺少上游报表原文' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
      const r = await d.runSpec();
      expect(r.status).toBe('failed');
      const reasons = engine.exportFailState().stepFailReasons ?? {};
      const r1 = (reasons as Record<string, { reason: string; fail_kind?: string }>)['1'];
      expect(r1?.fail_kind).toBe('lack_of_info');
      // 毒值不入库:analysis 未被写
      expect(engine.getVariableStore().read('analysis', '1')).toBeFalsy();
    });

    it('正例：多输出 reason 交 lack_of_info → 同 kind 失败,不白烧三轮', async () => {
      const engine = mkEngine(REASON_MULTI);
      const d = new StepDispatcher(engine, HOST);
      (d as any).sleep = () => Promise.resolve();
      const mockCreate = (d as any).defaultClient.messages.create;
      mockCreate.mockClear();
      mockCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'lack_of_info: 两个输入都是占位符' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
      const r = await d.runSpec();
      expect(r.status).toBe('failed');
      const reasons = engine.exportFailState().stepFailReasons ?? {};
      expect((reasons as Record<string, { fail_kind?: string }>)['1']?.fail_kind).toBe('lack_of_info');
      expect(mockCreate.mock.calls.length).toBe(1);   // 不白烧三轮
    });

    it('反例：正常产出不被误探（正文提及 lack_of_info 字样但非顶格键行）', async () => {
      const engine = mkEngine(REASON_SINGLE);
      const d = new StepDispatcher(engine, HOST);
      (d as any).sleep = () => Promise.resolve();
      const mockCreate = (d as any).defaultClient.messages.create;
      mockCreate.mockClear();
      mockCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'analysis: 本报告讨论 lack_of_info: 机制的设计,内容完整。' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
      const r = await d.runSpec();
      expect(r.status).toBe('completed');
      expect((r as any).outputs?.analysis).toContain('本报告讨论');
    });
  });

  // @v: anc-exec-tool-failure-report —— tool_failure standalone 全链（响应文本→前置探测→
  // completeStep 早判→failStep 带 kind;与 lack_of_info 链同构:直喂 completeStep 的钉只护
  // 承接站,本组护解析站——不前置探测则单输出把自报段当声明值收下毒值 completed）
  describe('tool_failure 全链（响应文本→解析→failStep 带 kind）', () => {
    const REASON_SPEC = `# T
Id: tf-r
## Goal
g
## Outputs
- analysis: text  # 分析
## Steps
1. [reason] 分析
  + → analysis: text  # 分析
`;

    it('正例：reason 响应文本交 tool_failure（思考散文前导）→ failStep(kind=tool_failure),不 completed 不毒值', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(REASON_SPEC, HOST);
      const d = new StepDispatcher(engine, HOST);
      (d as any).sleep = () => Promise.resolve();
      const mockCreate = (d as any).defaultClient.messages.create;
      mockCreate.mockClear();
      mockCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '我需要检索,但检索报错了。\n\ntool_failure: web_search 连续超时,无法取推理材料' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
      const r = await d.runSpec();
      expect(r.status).toBe('failed');
      const reasons = engine.exportFailState().stepFailReasons ?? {};
      expect((reasons as Record<string, { fail_kind?: string }>)['1']?.fail_kind).toBe('tool_failure');
      expect(engine.getVariableStore().read('analysis', '1')).toBeFalsy();
    });

    it('反例：正文提及 tool_failure 字样但非顶格键行 → 正常产出不误探', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(REASON_SPEC, HOST);
      const d = new StepDispatcher(engine, HOST);
      (d as any).sleep = () => Promise.resolve();
      const mockCreate = (d as any).defaultClient.messages.create;
      mockCreate.mockClear();
      mockCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'analysis: 本文讨论 tool_failure: 机制的设计,内容完整。' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
      const r = await d.runSpec();
      expect(r.status).toBe('completed');
      expect((r as any).outputs?.analysis).toContain('本文讨论');
    });
  });

  // @v: anc-exec-thinking-exhausted —— 烧穿疑似反刍分流二批（hopissues/0060 reopen 重修:
  // ①留档改走 HopLog.recordRuminationSuspect 文档级通道——首批经 recordStepMeta('') 被孤儿守卫
  // 拒收,留档静默失效而 mock 测试无守卫假绿未抓,故本组用**真 HopLog 实例**断言实际文件内容;
  // ②in-band 形态扩入——正文非空但高重复(hopkb r21 实录"让我重新审视"1330 次)同分流;
  // ③确定性口袋钉在 engine.test.ts。变异实证:撤 recordRuminationSuspect 调用→留档钉红;
  // 撤 isHighlyRepetitive 判据→in-band 钉红）
  describe('烧穿疑似反刍分流二批（hopissues/0060）', () => {
    function mkDispatcherWithRealLog() {
      const logDir = mkdtempSync(join(tmpdir(), 'rum-'));
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST, { logDir } as never);
      const d = new StepDispatcher(engine, HOST);
      const parse = (d as never as { parseStepOutput: (r: unknown, s: unknown) => unknown }).parseStepOutput.bind(d);
      const readLog = () => {
        const runDir = engine.getHopLogRunDir()!;
        return readFileSync(join(runDir, 'main.yaml'), 'utf-8');
      };
      return { d, parse, readLog };
    }
    const SCHEMA = [{ name: 'result', type: 'text', description: '' }];

    it('正例①（形态一,thinking 通道烧穿）：正文全空 → THINKING_EXHAUSTED,全文真实落 hoplog 文件（真 HopLog——首批 mock 假绿病根的改实钉）', () => {
      const { parse, readLog } = mkDispatcherWithRealLog();
      const resp = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '' }], usage: { output_tokens: 32768 } };
      expect(() => parse(resp, SCHEMA)).toThrow(/THINKING_EXHAUSTED.*正文为空.*可能是思维反刍/);
      const log = readLog();
      expect(log).toContain('rumination_suspect');
      expect(log).not.toContain('ERROR: orphan');   // 首批病形:留档变孤儿标记
    });

    it('正例②（形态二,in-band 反刍——reopen 主诉）：正文非空但高重复 → THINKING_EXHAUSTED 含 in-band 措辞,留档在场', () => {
      const { parse, readLog } = mkDispatcherWithRealLog();
      const loop = '让我重新审视一下这个判定。等等,我重新考虑。最终决定:违规。';
      const resp = { stop_reason: 'max_tokens', content: [{ type: 'text', text: loop.repeat(400) }], usage: { output_tokens: 65536 } };
      expect(() => parse(resp, SCHEMA)).toThrow(/THINKING_EXHAUSTED.*重复.*循环/);
      expect(readLog()).toContain('rumination_suspect');
    });

    it('反例①：正文非空且不重复的长文截断 → 照旧 OUTPUT_TRUNCATED（真超限指路调参;in-band 判据不误伤正常长文）', () => {
      const { parse } = mkDispatcherWithRealLog();
      // 不重复长文:每段带唯一序号与变化内容,远超窗宽
      const uniq = Array.from({ length: 300 }, (_, i) => `第${i}节:条款${i}的核对结论是形态${i % 7}与来源${i * 13}的交叉验证,细节各不相同。`).join('');
      const resp = { stop_reason: 'max_tokens', content: [{ type: 'text', text: uniq }], usage: { output_tokens: 32768 } };
      expect(() => parse(resp, SCHEMA)).toThrow(/OUTPUT_TRUNCATED/);
      expect(() => parse(resp, SCHEMA)).not.toThrow(/THINKING_EXHAUSTED/);
    });

    it('反例②：短正文截断（低于判据窗宽）→ 照旧 OUTPUT_TRUNCATED（短文不判反刍）', () => {
      const { parse } = mkDispatcherWithRealLog();
      const resp = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '写了一半的产出' }], usage: { output_tokens: 32768 } };
      expect(() => parse(resp, SCHEMA)).toThrow(/OUTPUT_TRUNCATED/);
    });

    it('边界：每实例留档 5 份封顶,第 6 次起只计数 warn 不存全文', () => {
      const { parse, readLog } = mkDispatcherWithRealLog();
      const resp = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '' }], usage: { output_tokens: 32768 } };
      for (let i = 0; i < 7; i++) {
        try { parse(resp, SCHEMA); } catch { /* 每次都抛,只看留档面 */ }
      }
      const log = readLog();
      expect((log.match(/rumination_suspect:/g) ?? []).length).toBe(5);
      expect((log.match(/留档已达 5 份上限/g) ?? []).length).toBe(2);
    });

    it('边界：封顶后报文不再谎称已留档——尾句如实说"本次未存全文"（阅卷实抓:首批报文与实况不一致病在封顶分支残留）', () => {
      const { parse } = mkDispatcherWithRealLog();
      const resp = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '' }], usage: { output_tokens: 32768 } };
      for (let i = 0; i < 5; i++) { try { parse(resp, SCHEMA); } catch { /* 烧满前 5 份 */ } }
      expect(() => parse(resp, SCHEMA)).toThrow(/本次未存全文/);
      expect(() => parse(resp, SCHEMA)).not.toThrow(/全文已留档/);
    });

    it('边界：hoplog 未开启时报文如实说"未留档"（不谎称已留档）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);   // 无 logDir——hoplog 缺席
      const d = new StepDispatcher(engine, HOST);
      const parse = (d as never as { parseStepOutput: (r: unknown, s: unknown) => unknown }).parseStepOutput.bind(d);
      const resp = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '' }], usage: { output_tokens: 32768 } };
      expect(() => parse(resp, SCHEMA)).toThrow(/未开启 hoplog.*未留档/);
    });

    it('直接钉：isHighlyRepetitive 判据面——循环文本 true/独特长文 false/短文 false', () => {
      const loop = '最终决定。等等,我重新考虑一下。'.repeat(500);
      expect(isHighlyRepetitive(loop)).toBe(true);
      const uniq = Array.from({ length: 400 }, (_, i) => `完全不同的第${i}句内容形态${i * 31}。`).join('');
      expect(isHighlyRepetitive(uniq)).toBe(false);
      expect(isHighlyRepetitive('短文')).toBe(false);
    });

    // @v: anc-exec-thinking-exhausted — 变招重试三批（R4 实撞:同 run 13 次烧满 65535 正文全空,
    // 免预算重试与首跑参数同源同型反复撞）:检出记名步号 → 该步后续装配 thinking 强制 disabled
    it('正例（变招重试）：带步号检出 THINKING_EXHAUSTED → 记名,该步后续 buildApiRequest 强制 thinking disabled 且报文告知降档', () => {
      const { d, parse } = mkDispatcherWithRealLog();
      const resp = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '' }], usage: { output_tokens: 65535 } };
      expect(() => (parse as (r: unknown, s: unknown, id?: string) => unknown)(resp, SCHEMA, '5.1.3.1.5'))
        .toThrow(/THINKING_EXHAUSTED.*重试轮将禁用推理通道/);
      const ctx = { task_context: 't', instruction: 'x', progress_summary: '', inputs: {}, output_schema: [] };
      const step = { step_id: '5.1.3.1.5', step_type: 'check', context: ctx };
      const req = (d as never as { buildApiRequest: (c: unknown, t: string, s?: unknown) => { request: Record<string, unknown> } })
        .buildApiRequest(ctx, 'check', step).request;
      expect(req['thinking']).toEqual({ type: 'disabled' });
    });

    it('反例（变招不误伤）：未记名的步照旧无 thinking 键（route 未声明吃端点缺省——存量行为零变化）', () => {
      const { d } = mkDispatcherWithRealLog();
      const ctx = { task_context: 't', instruction: 'x', progress_summary: '', inputs: {}, output_schema: [] };
      const step = { step_id: '2.2', step_type: 'check', context: ctx };
      const req = (d as never as { buildApiRequest: (c: unknown, t: string, s?: unknown) => { request: Record<string, unknown> } })
        .buildApiRequest(ctx, 'check', step).request;
      expect(req['thinking']).toBeUndefined();
    });

    it('反例（replan 段无步号不记名）：不带步号检出 → 报文无降档句,记名册不增', () => {
      const { d, parse } = mkDispatcherWithRealLog();
      const resp = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '' }], usage: { output_tokens: 65535 } };
      expect(() => parse(resp, SCHEMA)).toThrow(/THINKING_EXHAUSTED/);
      expect(() => parse(resp, SCHEMA)).not.toThrow(/重试轮将禁用推理通道/);
      expect((d as never as { thinkingExhaustedSteps: Set<string> }).thinkingExhaustedSteps.size).toBe(0);
    });
  });

  describe('parseStepOutput', () => {
    // @v: anc-exec-output-fence-recovery — coffee4 实撞两缺口正反例（2026-08-24）:
    // ①围栏正则只认 yaml|yml,flash 交 \`\`\`json 剥不掉——yamlLoad 对围栏行抛错走回退;
    // ②回退逐行正则不认带引号键('"seq_hit": true')——两缺口叠加,三轮完好产出全落 null 烧尽子实例。
    it('正例：```json 围栏包 JSON 多输出 → 剥壳解出全键（coffee4 实撞形态）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);
      const text = '```json\n{"seq_hit": true, "seq_plan": "a | b | NL"}\n```';
      const response = { content: [{ type: 'text', text }] };
      const schema = [
        { name: 'seq_hit', type: 'bool', description: '' },
        { name: 'seq_plan', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.seq_hit).toBe(true);
      expect(result.seq_plan).toBe('a | b | NL');
    });

    // @v: anc-exec-output-fence-content-retry — doc-review 首跑实撞（2026-08-30）:散文导语+围栏
    // 包全部输出键（内含嵌套映射）——围栏剥除是原地去标记,散文残留炸 yamlLoad,回退逐行不认
    // 嵌套映射键,内容完好三连 null 烧尽整步。修:整文解析失败后取首个围栏块内容单独再试。
    it('正例：散文导语+```yaml 围栏（嵌套映射）→ 围栏内容单解取到全键（doc-review 步7实撞形态）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);
      const text = '已完成分析。以下为产出：\n\n```yaml\ndoc_type_proposal: "考古-文明起源"\ndoc_analysis:\n  doc_type: "科普问答"\n  weak_points:\n    - "矛盾1"\n    - "矛盾2"\ndomain_candidates:\n  - "考古-文明起源"\n```';
      const response = { content: [{ type: 'text', text }] };
      const schema = [
        { name: 'doc_type_proposal', type: 'line', description: '' },
        { name: 'doc_analysis', type: 'yaml', description: '' },
        { name: 'domain_candidates', type: '[line]', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.doc_type_proposal).toBe('考古-文明起源');
      expect(result.doc_analysis).toEqual({ doc_type: '科普问答', weak_points: ['矛盾1', '矛盾2'] });
      expect(result.domain_candidates).toEqual(['考古-文明起源']);
    });

    it('反例：多围栏拼合不做跨块猜测——首块含声明键也不许单解采纳,照旧回退逐行取到第二块的键（review 修正:旧守卫判据"捕获组含```"在懒惰正则下恒假空转,首块含键的双围栏被单解采纳其余键 null;新判据=剥除首块后剩余仍含围栏开栏）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);
      // 首块就含声明键 seq_hit——旧守卫下会被单解采纳而 seq_plan 判 null;新守卫拒单解走回退,两键都取到
      const text = '```yaml\nseq_hit: true\n```\n中间散文评注\n```yaml\nseq_plan: 甲\n```';
      const response = { content: [{ type: 'text', text }] };
      const schema = [
        { name: 'seq_hit', type: 'bool', description: '' },
        { name: 'seq_plan', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.seq_plan).toBe('甲');                 // 回退取到第二块的键——单解采纳首块的话这里是 null
      expect(String(result.seq_hit)).toMatch(/true/);     // 回退同样取到首块的键
    });

    it('正例：第二触发臂——整文是合法 YAML 但无声明键,围栏含声明键 → 围栏单解取到（契约"或未命中声明键"半边）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);
      // 整文 yamlLoad 成功(散文行是合法标量? 不——用无声明键的合法映射做导语形态)
      const text = 'note: 说明文字\n\n```yaml\nseq_hit: true\nseq_plan: 乙\n```';
      const response = { content: [{ type: 'text', text }] };
      const schema = [
        { name: 'seq_hit', type: 'bool', description: '' },
        { name: 'seq_plan', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.seq_plan).toBe('乙');
      expect(result.seq_hit).toBe(true);
    });

    // @v: anc-exec-output-tail-yaml-retry — doc-review 第十次验证实撞（2026-08-31）:[thinking]
    // 散文+裸 YAML 键值块（无围栏）——整文 yamlLoad 被散文炸、无围栏跳过单解、回退逐行不认
    // 嵌套映射键→null 归一空列表,9 条对标成果业务面静默空转。修:找首个顶格声明键行,从该行
    // 截到文末单独再试 yamlLoad（与单输出"尾部自标签收窄"同一形态契约）。
    it('正例：[thinking] 散文+裸 YAML（无围栏,嵌套列表）→ 尾部键块单解取到全键（doc-review 步10实撞形态）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);
      const text = '[thinking]\n检索全部命中，无降级。产出结构化搜索结果（9 条）。\n\nseq_hit:\n  - title: "甲条目"\n    url: "https://a.example"\n    summary: "摘要甲"\n  - title: "乙条目"\n    url: "https://b.example"\n    summary: "摘要乙"\nseq_plan: 收尾值';
      const response = { content: [{ type: 'text', text }] };
      const schema = [
        { name: 'seq_hit', type: '[yaml]', description: '' },
        { name: 'seq_plan', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(Array.isArray(result.seq_hit)).toBe(true);
      expect((result.seq_hit as unknown[]).length).toBe(2);   // 修前:null（回退逐行不认嵌套块）
      expect(result.seq_plan).toBe('收尾值');
    });

    it('反例：散文行内提及键名（非顶格）不误触尾部单解——无顶格声明键行照旧回退逐行', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);
      // 散文里行内提到 "seq_hit:" 字样但带缩进/非行首——不构成顶格键行;全文无合法产出块
      const text = '[thinking]\n我准备输出 seq_hit: 相关内容,其中 seq_plan: 也会给。\n  seq_hit: 这行有缩进不是顶格\n(未产出)';
      const response = { content: [{ type: 'text', text }] };
      const schema = [
        { name: 'seq_hit', type: '[yaml]', description: '' },
        { name: 'seq_plan', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      // 回退逐行:首行行内 "seq_hit: 相关内容…"不在行首,缩进行 "  seq_hit: …"被带引号键正则命中取行内值——
      // 关键断言=尾部单解没有被误触发产出结构值(seq_hit 不是数组)
      expect(Array.isArray(result.seq_hit)).toBe(false);
    });

    // @v: anc-exec-output-quoted-prefix-repair — dispatcher 侧接线保护（review 变异3实证:恒 throw
    // 全绿零保护——契约"四处解析点"的 dispatcher 半边正是 doc-review 实撞主路径,必须锁住）。
    it('正例：多输出 text 含引号前缀行 → dispatcher 侧修复接线解出全键（变异3重放保护）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);
      const text = 'seq_hit: true\nseq_plan: "陶寺=尧都"是推定而非定论：证据待补';
      const response = { content: [{ type: 'text', text }] };
      const schema = [
        { name: 'seq_hit', type: 'bool', description: '' },
        { name: 'seq_plan', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.seq_hit).toBe(true);
      expect(result.seq_plan).toContain('陶寺=尧都');
      expect(result.seq_plan).toContain('证据待补');       // 裸文尾巴没丢——修复重包后整值在
    });

    it('反例：围栏内容不含任何声明键 → 不采围栏,回退逐行（业务围栏不误吞）', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);
      const text = '说明文字\n```yaml\nunrelated_key: 业务示例\n```\nseq_plan: 乙';
      const response = { content: [{ type: 'text', text }] };
      const schema = [
        { name: 'seq_hit', type: 'bool', description: '' },
        { name: 'seq_plan', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.seq_plan).toBe('乙');
      expect(result.seq_hit).toBeNull();
    });

    it('正例：残缺 JSON（截断）走回退——带引号键+缩进仍按键取到值；反例：键不在场落 null', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);
      // 模拟 thinking 模型 text 被掐断的残 JSON（无闭合}）——yamlLoad 必炸,回退逐行
      const text = '{\n  "seq_hit": true,\n  "seq_plan": "前置 | 范围 | NL';
      const response = { content: [{ type: 'text', text }] };
      const schema = [
        { name: 'seq_hit', type: 'bool', description: '' },
        { name: 'seq_plan', type: 'text', description: '' },
        { name: 'absent_key', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(String(result.seq_hit)).toMatch(/true/);   // 回退取到 'true,'→引号剥除后含 true
      expect(result.seq_plan).toContain('前置');
      expect(result.absent_key).toBeNull();
    });

    it('returns single output as text', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const response = { content: [{ type: 'text', text: '  hello world  ' }] };
      const schema = [{ name: 'result', type: 'text', description: '' }];
      const result = parse(response, schema);
      expect(result.result).toBe('hello world');
    });

    it('parses multi-output YAML-like format', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const response = { content: [{ type: 'text', text: 'score: 85\nsummary: looks good' }] };
      const schema = [
        { name: 'score', type: 'int', description: '' },
        { name: 'summary', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.score).toBe(85);   // YAML 解析给真类型（schema 即 number；旧正则时代是字符串 '85'）
      expect(result.summary).toBe('looks good');
    });

    // 块标量回归：`key: |` 换行正文必须取到正文——旧逐行正则把 '|' 当值（DeepSeek coffee-week 实撞）
    it('parses block scalar (key: | multiline) — real-world LLM output shape', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const response = { content: [{ type: 'text', text: 'verdict: 达标\nadvice: |\n  1. 第一条建议\n  2. 第二条建议\n' }] };
      const schema = [
        { name: 'verdict', type: 'text', description: '' },
        { name: 'advice', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.verdict).toBe('达标');
      expect(result.advice).toContain('第一条建议');
      expect(result.advice).not.toBe('|');
    });

    it('parses yaml fenced output (```yaml wrapper stripped)', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const response = { content: [{ type: 'text', text: '```yaml\nscore: 90\nsummary: ok\n```' }] };
      const schema = [
        { name: 'score', type: 'int', description: '' },
        { name: 'summary', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.score).toBe(90);
      expect(result.summary).toBe('ok');
    });

    it('sets null for missing keys in multi-output', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const response = { content: [{ type: 'text', text: 'score: 85' }] };
      const schema = [
        { name: 'score', type: 'int', description: '' },
        { name: 'missing', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.score).toBe(85);
      expect(result.missing).toBeNull();
    });

    // 回退路径块标量兜接（buildtest 实撞:`key: |` 后正文顶格→整文非法 YAML→回退正则把 '|'
    // 当值,skill_content='|' 毒值污染下游整链）。
    // @v: anc-exec-output-parse-fallback-block
    it('fallback path: block scalar with unindented body — collects block instead of "|"', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      // 顶格 markdown 正文（含 `# 标题` 等）使 yamlLoad 抛错 → 走回退正则
      const text = 'skill_content: |\n# 周报生成\n\n汇总本周记录草拟周报；核验通过后发布。\nsource_path: work_zone/source.md';
      const response = { content: [{ type: 'text', text }] };
      const schema = [
        { name: 'skill_content', type: 'text', description: '' },
        { name: 'source_path', type: 'line', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.skill_content).toContain('# 周报生成');
      expect(result.skill_content).toContain('草拟周报');
      expect(result.skill_content).not.toBe('|');
      expect(result.source_path).toBe('work_zone/source.md');
    });

    it('fallback path: |- indicator and indented body — strips common indent, trims tail blanks', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      // 缩进错层（首行 2 空格、次行 1 空格）→ 非法 YAML → 回退;公共缩进 1 应剥除
      const text = 'note: |-\n  line one\n :bad yaml here\n\nverdict: ok';
      const response = { content: [{ type: 'text', text }] };
      const schema = [
        { name: 'note', type: 'text', description: '' },
        { name: 'verdict', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.note).toContain('line one');
      expect(result.note).not.toMatch(/^\|/);
      expect(result.verdict).toBe('ok');
    });

    // 截断响亮失败（buildtest 实撞:v4-pro thinking 把 16384 输出预算全烧推理,text 空——
    // node_result="" 被当正常值收下,重试反馈错误归因）。
    // @v: anc-exec-output-truncation-loud
    it('throws OUTPUT_TRUNCATED when stop_reason is max_tokens — refuses partial output', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      // fixture 改实（^anc-exec-thinking-exhausted 随更）:旧料"text 空+max_tokens"正是烧穿
      // 正文为空形态,新设计下归 THINKING_EXHAUSTED 分流(疑似反刍组另有钉);本钉意图=拒收
      // 残值,改用非空正文(部分产出被掐)钉 OUTPUT_TRUNCATED 半边。
      const response = { stop_reason: 'max_tokens', usage: { output_tokens: 16384 }, content: [{ type: 'text', text: '写了一半被掐断的' }] };
      const schema = [{ name: 'result', type: 'text', description: '' }];
      expect(() => parse(response, schema)).toThrow(/OUTPUT_TRUNCATED.*16384/);
    });

    // 反例：正常 end_turn 不受影响
    it('end_turn responses parse normally (truncation guard is max_tokens only)', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const response = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok value' }] };
      const schema = [{ name: 'result', type: 'text', description: '' }];
      expect(parse(response, schema).result).toBe('ok value');
    });

    // 单输出自标注剥壳（buildtest 实撞:node_result 被 ```yaml + `node_result: |` 包裹进
    // validate 工具 parse 错——单输出"全文即值"是包裹症盲区）。
    // @v: anc-exec-output-parse-self-labeled
    it('single output: strips ```yaml + self-labeled block scalar wrapper', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const text = '```yaml\nresult: |\n  1. [act] 读取邮件\n  2. [loop for-each e in emails] 遍历\n```';
      const response = { content: [{ type: 'text', text }] };
      const schema = [{ name: 'result', type: 'text', description: '' }];
      const out = parse(response, schema);
      expect(out.result).toBe('1. [act] 读取邮件\n2. [loop for-each e in emails] 遍历');
    });

    it('single output: self-labeled block scalar without fence also unwrapped', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const response = { content: [{ type: 'text', text: 'note: |-\n  hello\n  world' }] };
      const schema = [{ name: 'note', type: 'text', description: '' }];
      expect(parse(response, schema).note).toBe('hello\nworld');
    });

    // 签名围栏块+散文尾巴（三十八审 flash 实撞:壳连'头部渲染完成…'评注逐字节落盘,首行非顶格
    // 标题 validate parse 错重试打转到超时——签名在场即无歧义,收首围栏内为值弃尾巴）。
    // @v: anc-exec-output-parse-self-labeled
    it('single output: signed fence + trailing prose → fence content taken, prose dropped', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const text = '```yaml\nheader_text: |-\n  # Spec: 收件箱分诊\n  Id: inbox-triage\n```\n\n头部渲染完成（validate 零 error）：\n- 标题由 skill 名组合。';
      const response = { content: [{ type: 'text', text }] };
      const schema = [{ name: 'header_text', type: 'text', description: '' }];
      const out = parse(response, schema);
      expect(out.header_text).toBe('# Spec: 收件箱分诊\nId: inbox-triage');
    });

    // 导语散文+签名块（三十九审扩——签名块在响应中段同样无歧义,原实现锚定响应开头漏剥）
    it('single output: leading prose + signed fence → fence content taken', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const text = '已完成渲染,输出如下:\n\n```yaml\nheader_text: |-\n  # Spec: X\n  Id: x\n```';
      const response = { content: [{ type: 'text', text }] };
      const schema = [{ name: 'header_text', type: 'text', description: '' }];
      expect(parse(response, schema).header_text).toBe('# Spec: X\nId: x');
    });

    // 反例：无签名的多围栏块拼合仍原样（二十五审钉——首围栏内没 echo 输出名,形态含糊不碰）
    it('single output: unsigned multi-fence collage still left untouched', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const text = '```python\nprint("a")\n```\n\n说明文字。\n\n```python\nprint("b")\n```';
      const response = { content: [{ type: 'text', text }] };
      const schema = [{ name: 'doc', type: 'text', description: '' }];
      expect(parse(response, schema).doc).toBe(text);
    });

    // 反例：无自标注签名的围栏是业务内容,原样不碰（md 文档里合法代码块）
    it('single output: plain fenced content without self-label left untouched', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const text = '```python\nprint("hi")\n```';
      const response = { content: [{ type: 'text', text }] };
      const schema = [{ name: 'code_doc', type: 'text', description: '' }];
      expect(parse(response, schema).code_doc).toBe(text);
    });

    // 反例：`<名>: 单行值` 后还有正文=形态含糊,原样零变化
    it('single output: ambiguous inline-label-plus-body left untouched', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const text = 'summary: first line\nmore body text here';
      const response = { content: [{ type: 'text', text }] };
      const schema = [{ name: 'summary', type: 'text', description: '' }];
      expect(parse(response, schema).summary).toBe(text);
    });

    // 多围栏拼合的两半判定（三十八审收窄改判——原"多块一律原样"拆两档）：
    // 有签名 → 收首围栏块为值（不跨块误捕:值=块内正文,散文与第二围栏弃——二十五审防的
    // "跨块收进值"仍被防住,只是判决从"整包原样"改"取签名块"）;无签名 → 仍原样（上一测试钉）。
    it('single output: signed first fence in multi-fence text → first block taken (no cross-block capture)', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      const text = '```yaml\nresult: |\n  a\n```\n中间散文\n```python\ncode\n```';
      const response = { content: [{ type: 'text', text }] };
      const schema = [{ name: 'result', type: 'text', description: '' }];
      const out = parse(response, schema);
      expect(out.result).toBe('a');                       // 签名块内正文即值
      expect(out.result).not.toContain('中间散文');        // 不跨块捕散文（二十五审语义保持）
    });

    // 反例：普通单行值不受收块逻辑影响（值非指示符 → 原样单行,既有行为零变化）
    it('fallback path: plain inline values unaffected by block collection', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const parse = (dispatcher as any).parseStepOutput.bind(dispatcher);

      // ": [" 使 yamlLoad 抛错(flow 未闭合) → 回退正则;两键均单行值
      const text = 'a: hello [world\nb: second value';
      const response = { content: [{ type: 'text', text }] };
      const schema = [
        { name: 'a', type: 'text', description: '' },
        { name: 'b', type: 'text', description: '' },
      ];
      const result = parse(response, schema);
      expect(result.a).toBe('hello [world');
      expect(result.b).toBe('second value');
    });
  });

  describe('handleStepReady', () => {
    // （原"fails step on None inputs"已删——None 闸 2026-08-09 废除,该测试靠 if(step_ready) 守卫
    //  空转通过;现行语义正反例见"execution loop integration（函数级 fail）"组）

    it('fails step on LLM error', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockRejectedValueOnce(new Error('LLM crashed'));

      const step = engine.nextStep();
      if (step.status === 'step_ready') {
        const handleReady = (dispatcher as any).handleStepReady.bind(dispatcher);
        await handleReady(step);
        const status = engine.getStatus();
        expect(status.failed).toBe(1);
      }
    });
  });

  describe('context overflow retry', () => {
    it('retries with aggressive reassembly on context overflow', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;

      const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
      const overflowErr = new Anthropic.BadRequestError('context length exceeded, too many tokens');

      // First call: overflow error. Second call: success
      mockCreate
        .mockRejectedValueOnce(overflowErr)
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'retried result' }],
          usage: { input_tokens: 30, output_tokens: 10 },
        });

      const step = engine.nextStep();
      if (step.status === 'step_ready') {
        const executeReason = (dispatcher as any).executeReasonOrCheck.bind(dispatcher);
        const result = await executeReason(step);
        expect(result.result).toBe('retried result');
        expect(mockCreate).toHaveBeenCalledTimes(2);
      }
    });
  });

  describe('resumeSpec', () => {
    it('delegates to executionLoop same as runSpec', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      engine.nextStep();
      engine.completeStep('1', { result: 'done' });

      const dispatcher = new StepDispatcher(engine, HOST);
      const result = await dispatcher.resumeSpec();
      expect(result.status).toBe('completed');
    });
  });

  describe('call and unknown step types', () => {
    it('call 分流断路器：executeStep 直击 call（绕过 handleStepReady 分流）→ 抛分流破坏错',async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);

      const callStep: StepReady = {
        status: 'step_ready',
        instance_id: 'test',
        step_id: '1',
        step_type: 'call' as any,
        summary: 'Call sub',
        context: {
          task_context: '', progress_summary: '', instruction: 'Call',
          inputs: {}, output_schema: [],
        },
      };

      const executeStep = (dispatcher as any).executeStep.bind(dispatcher);
      await expect(executeStep(callStep)).rejects.toThrow('未被 handleCallStep 拦截');
    });

    it('throws for unknown step type', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);

      const unknownStep: StepReady = {
        status: 'step_ready',
        instance_id: 'test',
        step_id: '1',
        step_type: 'mystery' as any,
        summary: 'Unknown',
        context: {
          task_context: '', progress_summary: '', instruction: '',
          inputs: {}, output_schema: [],
        },
      };

      const executeStep = (dispatcher as any).executeStep.bind(dispatcher);
      await expect(executeStep(unknownStep)).rejects.toThrow('Unknown executable step type');
    });
  });

  // @v: anc-exec-none-propagation —— 正例:None 是普通值,输入含 null 照常交执行体（LLM 被调用）,
  // 引擎不预拦不连坐（原 None-input auto-fail 组断言旧 MISSING_INPUT 闸,2026-08-09 废除后成误导,改写）
  describe('None 输入照常执行（None 闸已废）', () => {
    it('正例:输入含 null 时 LLM 照常被调用,步骤按 LLM 产出完成而非被预拦 fail', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok despite null input' }],
        usage: { input_tokens: 3, output_tokens: 3 },
      });

      const next = engine.nextStep();
      expect(next.status).toBe('step_ready');
      const fakeStep: StepReady = {
        ...(next as any),
        context: {
          ...(next as any).context,
          inputs: { query: null },
        },
      };

      await (dispatcher as any).handleStepReady(fakeStep);
      expect(mockCreate).toHaveBeenCalled();                        // 执行体真被调（未被 None 闸预拦）
      expect((engine as any).stepStates.get('1')).toBe('done');     // 按产出完成
    });
  });

  // @v: anc-obs-audit, anc-obs-mode-boundary
  describe('audit integration', () => {
    // @v: anc-obs-step-mapping
    it('knowledge retrieval records source_ids as flow field in HopLog', async () => {
      const kSpec = `# Knowledge Flow
Id: knowledge-flow
## Goal
Test knowledge flow record
## Constraints
- @knowledge 密算
## Outputs
- result: text  # out
## Steps
1. [reason] Analyze
  + → result: text  # analysis
  > analyze
`;
      const engine = new ExecutionEngine();
      const tmpDir = mkdtempSync(join(tmpdir(), 'hoptest-kflow-'));
      const hostWithKnowledge: HostConfig = {
        ...HOST,
        knowledge_provider: {
          retrieve: vi.fn().mockResolvedValue([
            { source_id: 'kb-mpc', content: '密算知识', relevance: 'high' },
          ]),
        },
      };
      engine.initExecution(kSpec, hostWithKnowledge, { logDir: tmpDir });
      const dispatcher = new StepDispatcher(engine, hostWithKnowledge);

      const step = engine.nextStep();
      if (step.status === 'step_ready') {
        await (dispatcher as any).injectKnowledge(step);
        const yaml = readFileSync(engine.getHopLog()!.getFilePath(), 'utf-8');
        expect(yaml).toContain('knowledge:');
        expect(yaml).toContain('source_id: kb-mpc');
      }
    });

    it('commit step executes directly and records commit_audit (authorized_by=policy)', async () => {
      const commitSpec = `# Commit Audit
Id: commit-audit
## Goal
Test commit audit
## Outputs
- result: text  # out
## Steps
1. [commit] Deploy to production
  + → result: text  # deploy outcome
  > deploy v2.0 to prod
`;
      const engine = new ExecutionEngine();
      const tmpDir = mkdtempSync(join(tmpdir(), 'hoptest-audit-'));
      engine.initExecution(commitSpec, HOST, { logDir: tmpDir });

      const dispatcher = new StepDispatcher(engine, HOST);
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'deployed' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      });
      const executeStep = (dispatcher as any).executeStep.bind(dispatcher);

      const step = engine.nextStep();
      if (step.status === 'step_ready') {
        const result = await executeStep(step);
        // commit 直接执行，不暂停（授权在前序完成，如 git commit）
        expect(result).not.toBe('paused');
        expect((result as any).result).toBe('deployed');

        const yaml = readFileSync(engine.getHopLog()!.getFilePath(), 'utf-8');
        expect(yaml).toContain('commit_audit:');
        expect(yaml).toContain('target: deploy v2.0 to prod');
        expect(yaml).toContain('authorized_by: policy');
      }
    });

    it('tool_call records audit event on success', async () => {
      const actSpec = `# Tool Audit
Id: tool-audit
## Goal
Test tool audit
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const toolProvider = {
        list: () => [
          { name: 'read_file', description: 'read', input_schema: {}, requires_commit: false },
        ],
        execute: vi.fn().mockResolvedValue({ result: 'file contents', success: true }),
      };
      const hostWithTools: HostConfig = { ...HOST, tool_provider: toolProvider };
      const engine = new ExecutionEngine();
      const tmpDir = mkdtempSync(join(tmpdir(), 'hoptest-audit-'));
      engine.initExecution(actSpec, hostWithTools, { logDir: tmpDir });

      const dispatcher = new StepDispatcher(engine, hostWithTools);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;

      // First call: tool use
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'read_file', input: { path: '/tmp/x' } },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
      });
      // Second call: final text
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 80, output_tokens: 10 },
      });

      const step = engine.nextStep();
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        await executeAct(step);

        const yaml = readFileSync(engine.getHopLog()!.getFilePath(), 'utf-8');
        expect(yaml).toContain('tool:');
        expect(yaml).toContain('- name: read_file');
        expect(yaml).toContain('result: success');
        // at 时间戳含冒号，YAML 引号包裹
        expect(yaml).toMatch(/at: ".+"/);
      }
    });

    it('tool_call records failure audit when tool execution fails', async () => {
      const actSpec = `# Tool Audit Fail
Id: tool-audit-fail
## Goal
Test tool audit failure
## Outputs
- result: text  # output
## Steps
1. [act] Do something
  + → result: text  # output
  > Use tools
`;
      const toolProvider = {
        list: () => [
          { name: 'write_file', description: 'write', input_schema: {}, requires_commit: false },
        ],
        execute: vi.fn().mockResolvedValue({ result: 'permission denied', success: false }),
      };
      const hostWithTools: HostConfig = { ...HOST, tool_provider: toolProvider };
      const engine = new ExecutionEngine();
      const tmpDir = mkdtempSync(join(tmpdir(), 'hoptest-audit-'));
      engine.initExecution(actSpec, hostWithTools, { logDir: tmpDir });

      const dispatcher = new StepDispatcher(engine, hostWithTools);
      (dispatcher as any).sleep = () => Promise.resolve();
      const mockCreate = (dispatcher as any).defaultClient.messages.create;

      // First call: tool use
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'write_file', input: { path: '/tmp/x' } },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
      });
      // Second call: final text
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'handled error' }],
        usage: { input_tokens: 80, output_tokens: 10 },
      });

      const step = engine.nextStep();
      if (step.status === 'step_ready') {
        const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
        await executeAct(step);

        const yaml = readFileSync(engine.getHopLog()!.getFilePath(), 'utf-8');
        expect(yaml).toContain('tool:');
        expect(yaml).toContain('- name: write_file');
        expect(yaml).toContain('result: failure');
      }
    });
  });

  describe('timeout enforcement', () => {
    it('throws STEP_TIMEOUT when step exceeds configured timeout', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST, { timeoutSeconds: 0.05 });

      const executeStepWithTimeout = (dispatcher as any).executeStepWithTimeout.bind(dispatcher);
      const fakeStep: StepReady = {
        status: 'step_ready',
        instance_id: 'test',
        step_id: '1',
        step_type: 'reason',
        summary: 'Think',
        context: {
          task_context: '', progress_summary: '', instruction: 'Think',
          inputs: {}, output_schema: [{ name: 'result', type: 'text', description: 'r' }],
        },
      };

      // Mock executeStep to hang forever
      (dispatcher as any).executeStep = () => new Promise(() => {});

      await expect(executeStepWithTimeout(fakeStep)).rejects.toThrow('STEP_TIMEOUT');
    });

    it('completes normally when step finishes before timeout', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST, { timeoutSeconds: 5 });

      const executeStepWithTimeout = (dispatcher as any).executeStepWithTimeout.bind(dispatcher);
      const fakeStep: StepReady = {
        status: 'step_ready',
        instance_id: 'test',
        step_id: '1',
        step_type: 'reason',
        summary: 'Think',
        context: {
          task_context: '', progress_summary: '', instruction: 'Think',
          inputs: {}, output_schema: [{ name: 'result', type: 'text', description: 'r' }],
        },
      };

      (dispatcher as any).executeStep = async () => ({ result: 'done' });

      const result = await executeStepWithTimeout(fakeStep);
      expect(result).toEqual({ result: 'done' });
    });
  });

  describe('replan failure escalation', () => {
    const ADAPTIVE_SPEC = `# Adaptive Test
Id: adaptive-test

## Goal
Test replan escalation

## Outputs
- result: text  # final

## Steps
1. [subtask retry=2 adaptive] Do work
  + → result: text  # output
  1.1. [reason] Think
    + → result: text  # thinking
    > Think carefully
`;

    it('calls failStep when replan error attempts reach max', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(ADAPTIVE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);

      const handleAdaptive = (dispatcher as any).handleAdaptive.bind(dispatcher);
      const mockCreate = (dispatcher as any).defaultClient.messages.create;

      // Simulate replan returning invalid markdown (submitReplan returns error)
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'not valid steps' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      // Mock assembleAdaptiveContext to avoid needing engine in adaptive state
      vi.spyOn(PromptAssembler.prototype, 'assembleAdaptiveContext').mockReturnValue({
        task_context: 'test', progress_summary: '', instruction: 'replan',
        inputs: {}, output_schema: [{ name: 'result', type: 'text', description: '' }],
      } as any);

      const failStepSpy = vi.spyOn(engine, 'failStep');

      const adaptiveResp: any = {
        status: 'adaptive_needed',
        instance_id: 'test',
        subtask_id: '1',
        failure: { step_id: '1.1', reason: 'test failure', attempt: 1, max_retries: 2 },
        subtask_contract: { outputs: [{ name: 'result', type: 'text', description: '' }], constraints: [] },
        original_children: [],
        retry_history: [],
      };

      // Call 3 times (max_replan_attempts default = 3)
      await handleAdaptive(adaptiveResp);
      await handleAdaptive(adaptiveResp);
      await handleAdaptive(adaptiveResp);

      expect(failStepSpy).toHaveBeenCalledWith('1', expect.stringContaining('Replan'));
    });

    // 截断闸覆盖 replan 管线（二十五审对读抓:pipelineCall 绕过 parseStepOutput——截断的
    // 部分产出会被静默收进 replan 三段）。
    // @v: anc-exec-output-truncation-loud
    it('pipelineCall throws OUTPUT_TRUNCATED on max_tokens (replan path covered)', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(ADAPTIVE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockResolvedValue({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: '被掐断的半截 replan…' }],
        usage: { input_tokens: 100, output_tokens: 16384 },
      });
      const pipelineCall = (dispatcher as any).pipelineCall.bind(dispatcher);
      const ctx = { task_context: 't', progress_summary: '', instruction: 'x', inputs: {}, output_schema: [{ name: 'result', type: 'text', description: '' }] };
      await expect(pipelineCall(ctx, 'replan', 'x'))
        .rejects.toThrow(/OUTPUT_TRUNCATED.*replan/);
    });

    it('calls failStep when replan API throws on last attempt', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(ADAPTIVE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);

      const handleAdaptive = (dispatcher as any).handleAdaptive.bind(dispatcher);
      const mockCreate = (dispatcher as any).defaultClient.messages.create;

      // Simulate API error
      mockCreate.mockRejectedValue(new Error('API server error'));

      vi.spyOn(PromptAssembler.prototype, 'assembleAdaptiveContext').mockReturnValue({
        task_context: 'test', progress_summary: '', instruction: 'replan',
        inputs: {}, output_schema: [{ name: 'result', type: 'text', description: '' }],
      } as any);

      const failStepSpy = vi.spyOn(engine, 'failStep');

      const adaptiveResp: any = {
        status: 'adaptive_needed',
        instance_id: 'test',
        subtask_id: '1',
        failure: { step_id: '1.1', reason: 'test failure', attempt: 1, max_retries: 2 },
        subtask_contract: { outputs: [{ name: 'result', type: 'text', description: '' }], constraints: [] },
        original_children: [],
        retry_history: [],
      };

      await handleAdaptive(adaptiveResp);
      await handleAdaptive(adaptiveResp);
      await handleAdaptive(adaptiveResp);

      expect(failStepSpy).toHaveBeenCalledWith('1', expect.stringContaining('API error'));
    });

    it('trips circuit breaker when attempts already exhausted', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(ADAPTIVE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);

      const handleAdaptive = (dispatcher as any).handleAdaptive.bind(dispatcher);
      const failStepSpy = vi.spyOn(engine, 'failStep');

      // Pre-set attempts to max
      (dispatcher as any).replanAttempts.set('1', 3);

      const adaptiveResp: any = {
        status: 'adaptive_needed',
        instance_id: 'test',
        subtask_id: '1',
        failure: { step_id: '1.1', reason: 'test failure', attempt: 1, max_retries: 2 },
        subtask_contract: { outputs: [], constraints: [] },
        original_children: [],
        retry_history: [],
      };

      await handleAdaptive(adaptiveResp);

      expect(failStepSpy).toHaveBeenCalledWith('1', expect.stringContaining('circuit breaker'));
    });
  });

  // @v: anc-exec-paused-resume, anc-exec-resume-semantics
  describe('pause-resume loop', () => {
    const CONFIRM_SPEC = `# Confirm Flow
Id: confirm-flow
## Goal
Test confirm pause-resume
## Outputs
- decision: bool  # final
## Steps
1. [confirm] Approve the plan
  + → decision: bool  # approve→true / reject→全局中止
  > Please approve
`;

    const COMMIT_SPEC = `# Commit Flow
Id: commit-flow
## Goal
Test commit pause-resume
## Outputs
- result: text  # final
## Steps
1. [commit] Deploy
  + → result: text  # deploy outcome
  > deploy to prod（B7 升 error 后 commit 必带 body——生成期定死动作）
  > \`\`\`hop_python
  > result = "deployed"
  > \`\`\`
`;

    it('runSpec pauses at confirm step with ExecutionPaused', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(CONFIRM_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);

      const result = await dispatcher.runSpec();
      expect(result.status).toBe('paused');
      expect(result.pause?.pause_reason).toBe('confirm');
      expect(result.pause?.step_id).toBe('1');
    });

    // @v: anc-exec-hitl-presentation
    it('resume confirm approve maps to bool true and completes', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(CONFIRM_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);

      const paused = await dispatcher.runSpec();
      expect(paused.status).toBe('paused');

      // confirm 收窄为纯审批：approve → bool true（不再原样写决策字符串）
      const result = await dispatcher.resume('1', { decision: 'approve' });
      expect(result.status).toBe('completed');
      expect(result.outputs?.decision).toBe(true);
    });

    it('resume confirm reject fails the step', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(CONFIRM_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);

      await dispatcher.runSpec();  // pauses at confirm
      const result = await dispatcher.resume('1', { decision: 'reject' });
      expect(result.status).toBe('failed');
      expect(result.failure?.step_id).toBe('1');
      expect(result.failure?.reason).toContain('rejected');
    });

    // resume 拒收传播（0016——修前 completeStep 返回值未接:被拒步骤保持 running 被 dfs 跳过
    // 直奔终态,结构化错误吞成'No executable step found'）。真引擎驱动非 mock——判据承重。
    // @v: anc-exec-resume-semantics
    it('反例：resume 注入被 completeStep 拒（ask 级凭证闸）→ rejected 上传不进循环,步骤保持可重试（0016）', async () => {
      const ASK_SPEC = `# Ask Flow\nId: ask-flow\n## Goal\ng\n## Outputs\n- v: text  # v\n## Steps\n1. [ask] 要环境参数\n  + → v: text  # v\n  > 给\n`;
      const engine = new ExecutionEngine();
      engine.initExecution(ASK_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const paused = await dispatcher.runSpec();
      expect(paused.status).toBe('paused');

      const r = await dispatcher.resume('1', { hop_env_gh_token: 'ghp_x', v: 'ok' });
      expect(r.status).toBe('paused');                                       // 不推进不终态
      expect(r.rejected?.code).toBe('SCHEMA_MISMATCH');                      // 结构化错误上传（凭证闸走 SCHEMA_MISMATCH 通道）
      expect(r.rejected?.message).toContain('HOP_ENV_CREDENTIAL_REJECTED');  // 原始拒因
      expect(r.rejected?.message).toContain('api_key_env');                  // 指路在场
      expect(r.failure).toBeUndefined();                                     // 不是失败终态形态

      // 修正后重试成功——被拒未消耗步骤,run 正常走完
      const ok = await dispatcher.resume('1', { value: 'good' });
      expect(ok.status).toBe('completed');
      expect(ok.outputs?.['v']).toBe('good');
    });

    it('commit executes directly in runSpec without pausing (authorization pre-completed)', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(COMMIT_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      const mockCreate = (dispatcher as any).defaultClient.messages.create;
      mockCreate.mockClear();
      // B7 升 error 后 commit 恒带 body——引擎直执零 LLM,mock 不该被碰

      // commit 不暂停，runSpec 直接执行到 completed（无需 resume）
      const result = await dispatcher.runSpec();
      expect(result.status).toBe('completed');
      expect(result.outputs?.result).toBe('deployed');
    });

    it('resume on non-pausable step throws', async () => {
      const engine = new ExecutionEngine();
      engine.initExecution(CONFIRM_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, HOST);
      await dispatcher.runSpec();
      // step '99' does not exist
      await expect(dispatcher.resume('99', { decision: 'x' })).rejects.toThrow('not found');
    });
  });

  // @v: anc-exec-act-body-interp
  // @v: anc-exec-tool-channels —— 通道选路（有 body→解释器①②/无 body→LLM 循环④）
  describe('act body 独立模式执行（端到端）', () => {
    function bodyHost(exec?: (n: string, a: Record<string, unknown>) => { result: unknown; success: boolean }) {
      return {
        ...HOST,
        tool_provider: {
          list: () => [
            { name: 'fetch', description: '', input_schema: {}, requires_commit: false },
            { name: 'send', description: '', input_schema: {}, requires_commit: true },
          ],
          execute: async (n: string, a: Record<string, unknown>) =>
            exec ? exec(n, a) : { result: 'r', success: true },
        },
      } as HostConfig;
    }

    it('有 body 的 act：解释器执行，产出落 vars（无 LLM）', async () => {
      const spec = `# T
Id: t
## Goal
g
## Inputs
- raw: text  # in
## Outputs
- result: text  # out
## Steps
1. [act] 处理
  - ← raw
  + → result: text  # 结果
  > \`\`\`hop_python
  > result = upper(raw)
  > \`\`\`
`;
      const engine = new ExecutionEngine();
      engine.initExecution(spec, bodyHost(), { params: { raw: 'hello' } } as any);
      const dispatcher = new StepDispatcher(engine, bodyHost());
      const handleReady = (dispatcher as any).handleStepReady.bind(dispatcher);
      const next = engine.nextStep();
      expect(next.status).toBe('step_ready');
      if (next.status === 'step_ready') {
        await handleReady(next);
        expect(engine.getStepStates().get('1')).toBe('done');
        expect(engine.getVariableStore().read('result', 'root')).toBe('HELLO');
      }
    });

    it('body 工具调用：调 ToolProvider，结果回流落 vars', async () => {
      const spec = `# T
Id: t
## Goal
g
## Inputs
- url: text  # u
## Outputs
- data: text  # d
## Steps
1. [act] 抓取
  - ← url
  + → data: text  # 数据
  > \`\`\`hop_python
  > data = fetch(url: url)
  > \`\`\`
`;
      const host = bodyHost((n, a) => ({ result: `fetched:${a.url}`, success: true }));
      const engine = new ExecutionEngine();
      engine.initExecution(spec, host, { params: { url: 'http://x' } } as any);
      const dispatcher = new StepDispatcher(engine, host);
      const handleReady = (dispatcher as any).handleStepReady.bind(dispatcher);
      const next = engine.nextStep();
      if (next.status === 'step_ready') {
        await handleReady(next);
        expect(engine.getStepStates().get('1')).toBe('done');
        expect(engine.getVariableStore().read('data', 'root')).toBe('fetched:http://x');
      }
    });

    it('body if 分支走对路', async () => {
      const spec = `# T
Id: t
## Goal
g
## Inputs
- score: int  # s
## Outputs
- level: text  # l
## Steps
1. [act] 分级
  - ← score
  + → level: text  # 级别
  > \`\`\`hop_python
  > if score > 60:
  >     level = "pass"
  > else:
  >     level = "fail"
  > \`\`\`
`;
      const engine = new ExecutionEngine();
      engine.initExecution(spec, bodyHost(), { params: { score: 80 } } as any);
      const dispatcher = new StepDispatcher(engine, bodyHost());
      const handleReady = (dispatcher as any).handleStepReady.bind(dispatcher);
      const next = engine.nextStep();
      if (next.status === 'step_ready') {
        await handleReady(next);
        expect(engine.getVariableStore().read('level', 'root')).toBe('pass');
      }
    });

    // 真 example 文件端到端：examples/syntax/act-body.md 纯内置函数，零 mock（空工具集，内置函数真跑），
    // 经 runSpec 全流程跑到 completed。常驻测试守护该 example。
    it('examples/syntax/act-body.md：runSpec 全流程真跑通（零 mock，纯内置函数）', async () => {
      const specText = readFileSync(join(process.cwd(), 'examples/syntax/act-body.md'), 'utf-8');
      const host = {
        ...HOST,
        // 空工具集——act-body.md 只用内置函数，不调外部工具，无需 mock 任何工具返回值
        tool_provider: { list: () => [], execute: async () => ({ result: '', success: true }) },
      } as HostConfig;
      const engine = new ExecutionEngine();
      // 样例已重写为报销单核算（380224f）：inputs=expenses/auto_limit,outputs=summary
      engine.initExecution(specText, host, { params: { expenses: [120, 88, 1500, 260], auto_limit: 1000 } } as any);
      const result = await new StepDispatcher(engine, host).runSpec();
      expect(result.status).toBe('completed');
      // 真实内置函数计算：sum=1968>1000→人工审批；max=1500>500→附发票说明
      expect(engine.getVariableStore().read('summary', 'root')).toBe('4 笔共 1968 元，人工审批，最大单笔 1500 元需附发票说明');
    });

    // 工具调用形态端到端：注入「真实测试桩工具」（非 mock 假值，是真能算的简单实现），
    // 验证 body 工具调用 + 内置函数混合真跑通。
    it('body 工具调用 + 内置混合：真实桩工具，runSpec 跑通', async () => {
      const spec = `# T
Id: tool-mix
## Goal
g
## Inputs
- nums: [int]  # 数字列表
## Outputs
- summary: text  # 摘要
## Steps
1. [act] 统计
  - ← nums
  + → summary: text  # 摘要
  > \`\`\`hop_python
  > total = sum_tool(data: nums)
  > n = len(nums)
  > summary = "sum=" + str(total) + " count=" + str(n)
  > \`\`\`
`;
      // 真实桩工具 sum_tool：真的对数组求和（不是 mock 假返回）
      const host = {
        ...HOST,
        tool_provider: {
          list: () => [{ name: 'sum_tool', description: '', input_schema: {}, requires_commit: false }],
          execute: async (n: string, a: Record<string, unknown>) => {
            if (n === 'sum_tool') {
              const arr = a.data as number[];
              return { result: arr.reduce((s, x) => s + x, 0), success: true };
            }
            return { result: '', success: false };
          },
        },
      } as HostConfig;
      const engine = new ExecutionEngine();
      engine.initExecution(spec, host, { params: { nums: [10, 20, 30] } } as any);
      const result = await new StepDispatcher(engine, host).runSpec();
      expect(result.status).toBe('completed');
      // sum_tool([10,20,30])=60, len=3
      expect(engine.getVariableStore().read('summary', 'root')).toBe('sum=60 count=3');
    });
  });
});

// @v: anc-exec-doc-ref-resolve, anc-exec-doc-ref-injection
// doc-ref 解析在 engine.assembleBasicContext（两模式共享基座），不在 dispatcher。
// 这些测试直接走 engine.nextStep()——即复用模式的 context 组装路径，
// 是"doc-ref 复用模式失效"bug 的回归测试。// @v: anc-exec-doc-ref-resolve
describe('engine doc-ref 注入（复用模式 nextStep 路径）', () => {
  function hostWithWorkspace(dir: string): HostConfig {
    return {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'test',
    };
  }

  const SPEC = (ref: string) => `# DocRef Spec
Id: docref-spec
## Goal
test doc-ref
## Outputs
- result: text  # out
## Steps
1. [reason] plan
  + → result: text  # r
  > 参照 ${ref} 完成
`;

  it('nextStep 直接组装的 context 含 doc_ref_context（复用模式生效，回归）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-'));
    writeFileSync(join(dir, 'kb.md'), '# KB\n\n## 二、色板\n主色 #003BFF。\n\n## 三、字体\n字体栈。\n');
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC('[[kb#二、色板]]'), hostWithWorkspace(dir), { logDir: mkdtempSync(join(tmpdir(), 'log-')) });
    const step = engine.nextStep();
    if (step.status === 'step_ready') {
      expect(step.context.doc_ref_context).toContain('主色 #003BFF');
      expect(step.context.doc_ref_context).toContain('来源: kb《二、色板》');   // yaml 条目化后 wiki 语法剥除
    } else {
      throw new Error('expected step_ready');
    }
  });

  it('运行期找不到章节 → 该步 failStep（硬报错不降级）', () => {
    // P15 在 init 期拦截缺失引用，故构造"init 通过、章节运行期才失效"场景：
    // init 用有效引用过 P15，再在 AST 上注入指向缺失章节的 doc_ref 模拟运行期漂移。
    const dir = mkdtempSync(join(tmpdir(), 'dr-'));
    writeFileSync(join(dir, 'kb.md'), '# KB\n\n## 二、色板\n主色。\n');
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC('[[kb#二、色板]]'), hostWithWorkspace(dir), { logDir: mkdtempSync(join(tmpdir(), 'log-')) });
    engine.getSpec()!.steps![0].doc_refs = [{ doc: 'kb', section: '幽灵章节' }];
    engine.nextStep(); // 触发 assembleBasicContext → DocRefError → failStep
    expect(engine.getStepStates().get('1')).toBe('failed');
  });

  it('doc-ref 来源记入 HopLog 流控字段', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-'));
    writeFileSync(join(dir, 'kb.md'), '# KB\n\n## 二、色板\n主色。\n');
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC('[[kb#二、色板]]'), hostWithWorkspace(dir), { logDir: mkdtempSync(join(tmpdir(), 'log-')) });
    engine.nextStep();
    const yaml = readFileSync(engine.getHopLog()!.getFilePath(), 'utf-8');
    expect(yaml).toContain('doc_refs:');
    expect(yaml).toContain('kb#二、色板');
  });

  it('无 doc-ref 的步骤不富化 doc_ref_context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-'));
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC('普通指令无引用'), hostWithWorkspace(dir), { logDir: mkdtempSync(join(tmpdir(), 'log-')) });
    const step = engine.nextStep();
    if (step.status === 'step_ready') {
      expect(step.context.doc_ref_context).toBeUndefined();
    }
  });
});

// @v: anc-exec-model-routing —— v0.2.1 未知 service fail-fast（codex 三轮 review P1:
// getClientForService('typo')===default 曾为真,spec 拼错 service 名烧默认后端的钱）
describe('getClientForService 未知 service fail-fast', () => {
  it('非 default 且无凭证 → 抛 UNKNOWN_SERVICE 报变量名', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    delete process.env['TYPO_API_KEY'];
    expect(() => (dispatcher as any).getClientForService('typo'))
      .toThrow(/UNKNOWN_SERVICE.*TYPO_API_KEY/);
  });

  it('default → 仍回缺省客户端（语义不变）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    expect((dispatcher as any).getClientForService('default')).toBeTruthy();
  });

  it('env 有凭证的 service → 正常建客户端', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    process.env['MYSVC_API_KEY'] = 'sk-x';
    try {
      expect((dispatcher as any).getClientForService('mysvc')).toBeTruthy();
    } finally { delete process.env['MYSVC_API_KEY']; }
  });
});

// ===== F类测试缺口补齐（2026-08-08 语义审计 c2t ⚠️，step-dispatcher 批）=====

// @v: anc-exec-resume-semantics
describe('resume: ask 数据注入与非暂停步骤报错', () => {
  const ASK_SPEC = `# Ask Flow
Id: ask-flow
## Goal
Test ask pause-resume
## Outputs
- choice: text  # final
## Steps
1. [ask] 选择方案
  + → choice: text  # 选择
  > 请选择
`;

  it('ask 经 dispatcher.resume 注入数据值 → completed 且值落 outputs', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(ASK_SPEC, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    const paused = await dispatcher.runSpec();
    expect(paused.status).toBe('paused');
    expect(paused.pause?.pause_reason).toBe('ask');
    const result = await dispatcher.resume('1', { value: 'plan_b' });
    expect(result.status).toBe('completed');
    expect(result.outputs?.choice).toBe('plan_b');
  });

  it('resume 存在但非 confirm/ask 的步骤 → 抛 not a pausable step', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);   // 步骤 1 是 reason
    const dispatcher = new StepDispatcher(engine, HOST);
    await expect(dispatcher.resume('1', { value: 'x' })).rejects.toThrow('not a pausable step');
  });
});

// @v: anc-exec-operator-retry, anc-exec-act-body-interp
describe('body 步骤 SCHEMA_MISMATCH 跳过算子级重试', () => {
  it('body 输出类型不匹配 → 不重做直接 failStep（确定性，重跑无意义）', async () => {
    const spec = `# T
Id: t-body-mismatch
## Goal
g
## Inputs
- raw: text  # in
## Outputs
- score: int  # out
## Steps
1. [act] 打分
  - ← raw
  + → score: int  # 数值
  > \`\`\`hop_python
  > score = upper(raw)
  > \`\`\`
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST, { params: { raw: 'hello' } } as any);
    const dispatcher = new StepDispatcher(engine, HOST);
    const mockCreate = (dispatcher as any).defaultClient.messages.create;
    const handleReady = (dispatcher as any).handleStepReady.bind(dispatcher);
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    if (next.status === 'step_ready') {
      await handleReady(next);
      expect(engine.getStepStates().get('1')).toBe('failed');   // 一次不匹配即失败,无 3 次重做
      expect(mockCreate).not.toHaveBeenCalled();                // body 全程无 LLM
    }
  });
});

// @v: anc-exec-knowledge-retrieval
describe('injectKnowledge 降级与空结果分支', () => {
  const K_SPEC = `# K
Id: k-degrade
## Goal
g
## Constraints
- @knowledge 密算
## Outputs
- result: text  # out
## Steps
1. [reason] Analyze
  + → result: text  # a
  > analyze
`;

  it('provider 抛错 → 不上抛、L2 留空、stderr 记降级诊断', async () => {
    const host: HostConfig = {
      ...HOST,
      knowledge_provider: { retrieve: vi.fn().mockRejectedValue(new Error('kb down')) },
    };
    const engine = new ExecutionEngine();
    engine.initExecution(K_SPEC, host);
    const dispatcher = new StepDispatcher(engine, host);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const step = engine.nextStep();
      expect(step.status).toBe('step_ready');
      if (step.status === 'step_ready') {
        await (dispatcher as any).injectKnowledge(step);   // 不应 throw
        expect(step.context.knowledge_context ?? '').toBe('');
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[knowledge-degraded]'));
      }
    } finally { errSpy.mockRestore(); }
  });

  it('retrieve 返回空数组 → HopLog 不写 knowledge 流控字段', async () => {
    const host: HostConfig = {
      ...HOST,
      knowledge_provider: { retrieve: vi.fn().mockResolvedValue([]) },
    };
    const engine = new ExecutionEngine();
    const tmpDir = mkdtempSync(join(tmpdir(), 'hoptest-kempty-'));
    engine.initExecution(K_SPEC, host, { logDir: tmpDir });
    const dispatcher = new StepDispatcher(engine, host);
    const step = engine.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status === 'step_ready') {
      await (dispatcher as any).injectKnowledge(step);
      const yaml = readFileSync(engine.getHopLog()!.getFilePath(), 'utf-8');
      expect(yaml).not.toContain('knowledge:');
    }
  });
});

// @v: anc-obs-mode-boundary
describe('独立模式 llm 观测块落盘', () => {
  it('reason 步骤经 LLM 完成后 HopLog 记 llm: model + tokens', async () => {
    const engine = new ExecutionEngine();
    const tmpDir = mkdtempSync(join(tmpdir(), 'hoptest-llmmeta-'));
    engine.initExecution(SIMPLE_SPEC, HOST, { logDir: tmpDir });
    const dispatcher = new StepDispatcher(engine, HOST);
    const mockCreate = (dispatcher as any).defaultClient.messages.create;
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'thought result' }],
      usage: { input_tokens: 42, output_tokens: 7 },
    });
    const handleReady = (dispatcher as any).handleStepReady.bind(dispatcher);
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    if (next.status === 'step_ready') {
      await handleReady(next);
      const yaml = readFileSync(engine.getHopLog()!.getFilePath(), 'utf-8');
      expect(yaml).toContain('llm:');
      expect(yaml).toContain('input_tokens: 42');
      expect(yaml).toContain('output_tokens: 7');
    }
  });
});

// @v: anc-exec-api-retry
describe('callLlmWithRetry: temperature 拒收自适应与限流耗尽', () => {
  function mk() {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    (dispatcher as any).sleep = () => Promise.resolve();
    const mockCreate = (dispatcher as any).defaultClient.messages.create;
    const callRetry = (dispatcher as any).callLlmWithRetry.bind(dispatcher);
    return { dispatcher, mockCreate, callRetry };
  }
  const OK = { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };

  it('端点拒收 temperature → 剥除立即重试(不计退避) + 该 client 后续免传', async () => {
    const { mockCreate, callRetry } = mk();
    const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
    const rejectTemp = new Anthropic.APIError('`temperature` is deprecated');
    rejectTemp.status = 400;
    mockCreate.mockRejectedValueOnce(rejectTemp).mockResolvedValue(OK);
    const req1: any = { model: 'test', messages: [], temperature: 0 };
    await callRetry(req1);
    expect(mockCreate).toHaveBeenCalledTimes(2);           // 拒收 → 剥除重试一次即成功
    expect(mockCreate.mock.calls[1][0].temperature).toBeUndefined();
    // per-client 免传：同 client 再发带 temperature 的请求,发出前已剥除,一次成功
    const req2: any = { model: 'test', messages: [], temperature: 0.7 };
    await callRetry(req2);
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[2][0].temperature).toBeUndefined();
  });

  it('限流 4 次重试全部耗尽 → 最终抛出限流错', async () => {
    const { mockCreate, callRetry } = mk();
    const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
    mockCreate.mockRejectedValue(new Anthropic.RateLimitError('rate limited'));
    await expect(callRetry({ model: 'test', messages: [] })).rejects.toThrow();
    expect(mockCreate).toHaveBeenCalledTimes(5);   // 首发 + 4 次重试
  });
});

// @v: anc-exec-call-recursion, anc-provider-spec-default, anc-exec-call-auto-map, anc-exec-call-depth-check
// worker 共享父 ToolProvider（hopissues/0021——每 worker 自建 Composite 各 spawn stdio mcp
// 子进程且无人 close:hopkb 实撞一天批量后 218 僵尸×600MB≈6.8GB;共享后 provider 生命周期
// 归顶层三收点,worker 零自建零泄漏）
// @v: anc-exec-tool-composite
describe('worker 共享父 ToolProvider（0021）', () => {
  it('正例：sharedToolProvider 注入 → worker 持同一引用（零新建零 spawn）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    const parent = new StepDispatcher(engine, HOST);
    const parentTp = parent.getToolProvider();

    const childEngine = new ExecutionEngine();
    childEngine.initExecution(SIMPLE_SPEC, HOST);
    const worker = new StepDispatcher(childEngine, HOST, { worker: true, sharedToolProvider: parentTp });
    expect(worker.getToolProvider()).toBe(parentTp);   // 同一引用
  });

  it('反例：未注入 → 照旧自建（顶层/宿主直构语义不变）', () => {
    const e1 = new ExecutionEngine();
    e1.initExecution(SIMPLE_SPEC, HOST);
    const d1 = new StepDispatcher(e1, HOST);
    const e2 = new ExecutionEngine();
    e2.initExecution(SIMPLE_SPEC, HOST);
    const d2 = new StepDispatcher(e2, HOST);
    expect(d1.getToolProvider()).not.toBe(d2.getToolProvider());
  });
});

// thinking 路由（形态 B 2026-08-20 作者拍板——推理型端点缺省开 thinking,重档实录 90% 输出
// 是 thinking 双档 OUTPUT_TRUNCATED 第一凶手;route 声明才发参,缺省不发吃端点缺省存量零变化）
// @v: anc-exec-thinking-routing
describe('thinking 路由（形态 B）', () => {
  const HOSTR: HostConfig = { ...HOST, model_engine: {
    default_service_id: 'default', default_model: 'm-default',
    routing_rules: [
      { match: { step_type: 'act' }, service_id: 'default', model: 'm-act', thinking: 'disabled' },
      { match: { step_type: 'reason' }, service_id: 'default', model: 'm-reason' },
    ],
  } };

  function reqFor(stepType: 'act' | 'reason' | 'commit') {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOSTR);
    const dispatcher = new StepDispatcher(engine, HOSTR);
    const ctx = { task_context: 't', instruction: 'x', progress_summary: '', inputs: {}, output_schema: [] } as any;
    return (dispatcher as any).buildApiRequest(ctx, stepType).request;
  }

  it('正例：route 带 thinking:disabled → 请求带 {type:disabled};commit 吃 act 条随整条继承', () => {
    expect(reqFor('act').thinking).toEqual({ type: 'disabled' });
    expect(reqFor('commit').thinking).toEqual({ type: 'disabled' });   // commit 无专条吃 act 条
  });

  it('反例：route 未声明 thinking → 请求零 thinking 键（吃端点缺省,存量零变化）', () => {
    expect('thinking' in reqFor('reason')).toBe(false);
  });

  it('正例：enabled 小预算 budget 下限夹 1024（anthropic 协议最低值——原发 750 违约 400）', () => {
    const H3 = { ...HOSTR, resource_limits: { max_tool_iterations: 20, max_context_tokens: 1, max_output_tokens: 1500, max_replan_attempts: 1 },
      model_engine: { ...HOSTR.model_engine!, routing_rules: [
        { match: { step_type: 'act' as const }, service_id: 'default', model: 'm', thinking: 'enabled' as const },
      ] } };
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, H3);
    const dispatcher = new StepDispatcher(engine, H3);
    const req = (dispatcher as any).buildApiRequest({ task_context: 't', instruction: 'x', progress_summary: '', inputs: {}, output_schema: [] } as any, 'act').request;
    expect(req.thinking.budget_tokens).toBe(1024);
  });

  it('正例：enabled 形态带 budget_tokens=输出预算一半', () => {
    const H2 = { ...HOSTR, model_engine: { ...HOSTR.model_engine!, routing_rules: [
      { match: { step_type: 'act' as const }, service_id: 'default', model: 'm', thinking: 'enabled' as const },
    ] } };
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, H2);
    const dispatcher = new StepDispatcher(engine, H2);
    const req = (dispatcher as any).buildApiRequest({ task_context: 't', instruction: 'x', progress_summary: '', inputs: {}, output_schema: [] } as any, 'act').request;
    expect(req.thinking.type).toBe('enabled');
    expect(req.thinking.budget_tokens).toBeGreaterThan(0);
  });
});

// check body 独立模式归解释器（四十一审 flash 实录抓漏:原 executeStep 分派 check 一律 LLM 判,
// check body 独立模式整个失效——LLM 对着 body 文本猜输出交 null 双槽 SCHEMA_MISMATCH 假失败;
// 与复用模式 isCallerActionPoint 消化同语义:有 body 零 LLM,无 body 照旧 LLM）
// @v: anc-step-check-body
describe('check body 独立模式归解释器', () => {
  const F = '```';
  const SPEC = `# T
Id: t

## Goal
g

## Outputs
- done: text  # 交付

## Steps
1. [subtask retry=2] 组
  + → done: text  # 出口
  1.1. [act] 出料
    + → data: text  # 值
    > ${F}hop_python
    > data = "hello"
    > ${F}
  1.2. [check] 判非空
    - ← data
    + → ok: bool  # 判定
    + → why: text  # 说明
    > ${F}hop_python
    > ok = len(data) > 0
    > why = "" if ok else "空"
    > ${F}
  1.3. [act] 收尾
    - ← data
    + → done: text  # 出口
    > ${F}hop_python
    > done = data
    > ${F}
2. [exit] 完
`;

  it('正例：check body 引擎直执零 LLM 到 completed（无凭证无网络照跑——真零调用的证明）', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    const res = await dispatcher.runSpec();
    expect(res.status).toBe('completed');
    expect(res.outputs?.done).toBe('hello');
  });

  it('正例：check body 判 false → CHECK_FAILED 容器 retry（判定路径同一,零分叉）', async () => {
    const failSpec = SPEC.replace('ok = len(data) > 0', 'ok = len(data) > 99');
    const engine = new ExecutionEngine();
    engine.initExecution(failSpec, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    const res = await dispatcher.runSpec();
    expect(res.status).toBe('failed');   // retry 耗尽（每轮判定确定性 false）
  });

  // check 步骤语境的写域直接钉住（review 抓真空口:此前只靠 executeActBody(step,false) 共享路径
  // 间接覆盖,无 check 主体用例）——check body 写 workspace 根须拒 WORK_ZONE_ONLY。
  // @v: anc-exec-write-scope
  it('反例：check body 写 workspace 根 → WORK_ZONE_ONLY 拒（check 与 act 同窄域）', async () => {
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const ws = mkdtempSync(join(tmpdir(), 'checkscope-'));
    const F = '```';
    const spec = `# T
Id: t

## Goal
g

## Outputs
- done: text  # 交付

## Steps
1. [subtask] 组
  + → done: text  # 出口
  1.1. [check] 判定顺手落盘（违规形态）
    + → ok: bool  # 判定
    + → why: text  # 说明
    > ${F}hop_python
    > write(path: "stray.yaml", content: "x")
    > ok = True
    > why = ""
    > ${F}
  1.2. [act] 收尾
    + → done: text  # 出口
    > ${F}hop_python
    > done = "d"
    > ${F}
2. [exit] 完
`;
    const host: HostConfig = { workspace_dir: ws, sandbox: { filesystem: { workspace_dir: ws, read_access: { allowed: [ws], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: 'test-key' };
    const engine = new ExecutionEngine();
    engine.initExecution(spec, host);
    const dispatcher = new StepDispatcher(engine, host);
    const res = await dispatcher.runSpec();
    // 具体拒因被 subtask retry 包裹（终态 reason='retry exhausted'）——按可观测事实断言：
    // run 失败且违规文件确实没落盘（若分域失效,首轮就写成、run 会 completed）。
    expect(res.status).toBe('failed');
    expect(existsSync(join(ws, 'stray.yaml'))).toBe(false);
  });

  it('反例：无 body 的 check 照旧走 LLM 判（executeReasonOrCheck 路径不被误改）', async () => {
    const noBody = `# T
Id: t

## Goal
g

## Steps
1. [subtask retry=2] 组
  + → out: text  # 出口
  1.1. [reason] 想
    + → out: text  # 值
    > 想一个词
  1.2. [check] 语义核验
    - ← out
    + → ok: bool  # 判定
    + → why: text  # 说明
    > 内容质量是否合格
2. [exit] 完
`;
    const engine = new ExecutionEngine();
    engine.initExecution(noBody, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    const res = await dispatcher.runSpec();
    // 无凭证环境 LLM 调用必失败——失败即证明走了 LLM 路径（零 LLM 会 completed）
    expect(res.status).toBe('failed');
  });
});

// spec 自递归（v4.0.0 hopbuild 递归展开的根基形态——spec 调自己,DirSpecProvider 按 Id 解析回
// 同一文件;三十三审真机探针钉入:此前 call 测试全是 A调B,'自己调自己'零覆盖）
// @v: anc-exec-call-recursion
describe('spec 自递归（调自己）', () => {
  const COUNTDOWN = `# Countdown
Id: countdown

## Goal
自递归倒数

## Inputs
- n: int  # 当前计数

## Outputs
- chain: text  # 递归链文本

## Steps
1. [branch] 判零
  - ← n
  + → chain: text  # 统一接口
  1.1. [case(n > 0)] 递归
    1.1.1. [act] 算下一层参数
      - ← n
      + → next_n: int  # n-1
      > \`\`\`hop_python
      > next_n = n - 1
      > \`\`\`
    1.1.2. [call countdown(n: next_n)] 递归调用
      + → sub_chain: chain
    1.1.3. [act] 拼链
      - ← n, sub_chain
      + → chain: text  # 本层+子层
      > \`\`\`hop_python
      > chain = str(n) + ">" + sub_chain
      > \`\`\`
  1.2. [case(else)] 触底
    1.2.1. [act] 出零
      + → chain: text  # 终点
      > \`\`\`hop_python
      > chain = "0"
      > \`\`\`
`;

  it('正例：三层自递归到触底,输出映射逐层回传（3>2>1>0）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfcall-'));
    writeFileSync(join(dir, 'countdown.md'), COUNTDOWN);
    const HOSTX = { ...HOST, spec_provider: new DirSpecProvider(dir) };
    const engine = new ExecutionEngine();
    engine.initExecution(COUNTDOWN, HOSTX, { params: { n: 3 } });
    const disp = new StepDispatcher(engine, HOSTX);
    const r = await disp.runSpec();
    expect(r.status).toBe('completed');
    expect(engine.getVariableStore().read('chain', 'root')).toBe('3>2>1>0');
  });

  it('反例：自递归深度超 max_call_depth → DEPTH_EXCEEDED 不无限递归', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfcall-'));
    writeFileSync(join(dir, 'countdown.md'), COUNTDOWN);
    const HOSTX = { ...HOST, spec_provider: new DirSpecProvider(dir), resource_limits: { max_tool_iterations: 20, max_context_tokens: 1, max_output_tokens: 1024, max_replan_attempts: 1, max_call_depth: 2 } };
    const engine = new ExecutionEngine();
    engine.initExecution(COUNTDOWN, HOSTX, { params: { n: 5 } });   // 需 5 层,限 2
    const disp = new StepDispatcher(engine, HOSTX);
    const r = await disp.runSpec();
    expect(r.status).toBe('failed');
  });
});

describe('独立模式 call 递归', () => {
  // callee：纯计算 act body（无 LLM），把输入翻倍
  const CALLEE_DOUBLE = `# Double
Id: double

## Goal
输入翻倍

## Inputs
- n: int  # 输入数

## Outputs
- doubled: int  # 翻倍结果

## Steps
1. [act] 翻倍
  - ← n
  + → doubled: int  # 结果
  > 纯计算
  > \`\`\`hop_python
  > doubled = n * 2
  > \`\`\`
`;

  // callee：中途 confirm 暂停（require_human）
  const CALLEE_CONFIRM = `# Gated
Id: gated

## Goal
带审批的产出

## Inputs
- n: int  # 输入数

## Outputs
- approved_n: int  # 审批后的数

## Steps
1. [confirm require_human=true] 审批这个数
  - ← n
  + → ok: bool  # 审批槽
2. [act] 透传
  - ← n
  + → approved_n: int  # 结果
  > 纯计算
  > \`\`\`hop_python
  > approved_n = n
  > \`\`\`
`;

  // caller：调 double 子 spec（映射 n: base）
  const CALLER = `# Caller
Id: caller

## Goal
调子 spec 翻倍

## Inputs
- base: int  # 底数

## Outputs
- result: int  # 翻倍结果

## Steps
1. [call double(n: base)] 调翻倍
  + → result: doubled  # 结果 ← 子输出
`;

  function inMemoryProvider(specs: Record<string, string>) {
    return {
      resolve: async (id: string) => (id in specs ? { spec_id: id, source: specs[id] } : null),
    };
  }

  function setup(callerSpec: string, host: HostConfig, params: Record<string, unknown>) {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(callerSpec, host, { params });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, host);
    return { engine, dispatcher };
  }

  it('正例：completed 子输出按 output_mapping 回填父变量（Inputs 自动映射 n←base）', async () => {
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ double: CALLEE_DOUBLE }) };
    const { dispatcher } = setup(CALLER, host, { base: 21 });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['result']).toBe(42);
  });

  // call 同界记账（独立模式 settleCallOutcome——commit 退火跨界半边;复用模式 CLI 消化点
  // 由 cli.test 覆盖） // @v: anc-exec-commit-anneal
  it('正例：子实例含已执行 commit → settleCallOutcome 登记父 call 步退火（成功终态）', async () => {
    const CALLEE_COMMIT = CALLEE_DOUBLE.replace('1. [act] 翻倍', '1. [commit] 不可逆翻倍');
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ double: CALLEE_COMMIT }) };
    const { engine, dispatcher } = setup(CALLER, host, { base: 21 });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(engine.hasCommittedSteps()).toBe(true);   // call 步已登记（子内 commit 已发生）
  });

  it('正例：失败子实例含已执行 commit → 同样登记（commit 已发生,失败不豁免）', async () => {
    // 子：commit 先执行成功,随后步骤失败（引用未定义工具触发 body 工具查找失败）
    const CALLEE_COMMIT_THEN_FAIL = `# CF
Id: double

## Goal
g

## Inputs
- n: int  # 数

## Outputs
- doubled: int  # 果

## Steps
1. [commit] 提交
  - ← n
  + → committed_val: int  # 已提交
  > 纯计算
  > \`\`\`hop_python
  > committed_val = n * 2
  > \`\`\`
2. [act] 崩掉的收尾
  - ← committed_val
  + → doubled: int  # 果
  > 纯计算
  > \`\`\`hop_python
  > doubled = nonexistent_tool(x: committed_val)
  > \`\`\`
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ double: CALLEE_COMMIT_THEN_FAIL }) };
    const { engine, dispatcher } = setup(CALLER, host, { base: 3 });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    expect(engine.hasCommittedSteps()).toBe(true);   // 失败子的 commit 同样登记
  });

  it('反例：子实例无 commit → 父零标记（committed 不误传）', async () => {
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ double: CALLEE_DOUBLE }) };
    const { engine, dispatcher } = setup(CALLER, host, { base: 21 });
    await dispatcher.runSpec();
    expect(engine.hasCommittedSteps()).toBe(false);
  });

  it('反例：无 SpecProvider → call 步骤 fail UNKNOWN_SPEC（不猜路径）', async () => {
    const { dispatcher } = setup(CALLER, HOST, { base: 1 });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toContain('UNKNOWN_SPEC');
  });

  it('反例：SpecProvider 解析不到 callee → fail UNKNOWN_SPEC', async () => {
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({}) };
    const { dispatcher } = setup(CALLER, host, { base: 1 });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toContain("未解析到 spec 或工具 'double'");   // 报文随 call 工具决议扩义更新（^anc-exec-call-tool）
  });

  it('正例：子 confirm 暂停冒泡到顶层（call_path=[call步id]），resume 带 call_path 下钻续跑到 completed', async () => {
    const callerGated = CALLER.replace('double(n: base)', 'gated(n: base)').replace('调翻倍', '调审批')
      .replace('result: int  # 结果', 'result: int  # 结果');
    const spec = `# Caller
Id: caller-gated

## Goal
调带审批的子 spec

## Inputs
- base: int  # 底数

## Outputs
- result: int  # 结果

## Steps
1. [call gated(n: base)] 调审批
  + → result: int  # 结果
`;
    void callerGated;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ gated: CALLEE_CONFIRM }) };
    const { dispatcher } = setup(spec.replace('+ → result: int  # 结果', '+ → result: approved_n  # 结果映射'), host, { base: 7 });
    const r1 = await dispatcher.runSpec();
    expect(r1.status).toBe('paused');
    expect(r1.pause?.call_path).toEqual(['1']);      // 顶层 call 步骤 id
    expect(r1.pause?.step_id).toBe('1');             // 子 spec 内的 confirm 步骤 id
    const r2 = await dispatcher.resume(r1.pause!.step_id, { value: 'approve' }, r1.pause!.call_path);
    expect(r2.status).toBe('completed');
    expect(r2.outputs?.['result']).toBe(7);
  });

  // 串行 call 链投影（^anc-mcp-run-status-inflight call_chain 条,todo/0011①——run 卡在 call 步
  // 时递归子树烧到哪层哪步外部全不可见,看护进度行整段 step=?）。链只在执行窗口在场（await 期间,
  // activeCallChildren 有登记）;暂停等人时链缺席——那时有 paused 卡+call_path 可定位,不重复。
  // @v: anc-mcp-run-status-inflight
  it('正例：getCallChain 逐层下钻在飞 call 登记表（两层嵌套全链）;反例：无在飞 call → 空链', () => {
    const hostX: HostConfig = { ...HOST, spec_provider: inMemoryProvider({}) };
    // 三层手工搭：顶层 → 中层(spec id: mid) → 底层(spec id: leaf)
    const mk = (id: string) => {
      const eng = new ExecutionEngine();
      eng.initExecution(`# S\nId: ${id}\n## Goal\ng\n## Outputs\n- o: text  # x\n## Steps\n1. [reason] r\n  + → o: text  # x\n`, hostX);
      return { eng, d: new StepDispatcher(eng, hostX) };
    };
    const top = mk('top'); const mid = mk('mid'); const leaf = mk('leaf');
    // 反例半边:未登记 → 空链（响应侧字段缺席的依据）
    expect(top.d.getCallChain()).toEqual([]);
    // 登记两层（执行窗口形态:executeCall 的 await 期间登记表有项）
    (mid.d as any).activeCallChildren.set('2.1', leaf.d);
    (top.d as any).activeCallChildren.set('5.1', mid.d);
    const chain = top.d.getCallChain();
    expect(chain.map(c => c.spec)).toEqual(['mid', 'leaf']);
    expect(chain[0].step).toBe('5.1');
    expect(chain[1].step).toBe('2.1');
  });

  it('反例：resume 带错误 call_path（帧不存在）→ 抛错且不推进', async () => {
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ gated: CALLEE_CONFIRM }) };
    const spec = `# CG
Id: cg

## Goal
g

## Inputs
- base: int  # 底数

## Outputs
- result: int  # 结果

## Steps
1. [call gated(n: base)] 调审批
  + → result: approved_n  # 映射
`;
    const { dispatcher } = setup(spec, host, { base: 3 });
    const r1 = await dispatcher.runSpec();
    expect(r1.status).toBe('paused');
    await expect(dispatcher.resume(r1.pause!.step_id, { value: 'approve' }, ['99'])).rejects.toThrow(/call frame '99' 不存在/);
  });

  it('反例：子 spec 失败 → 父 call 步骤收 CalleeFailure（内核原封,不自由转述）', async () => {
    const CALLEE_FAIL = `# Bad
Id: bad

## Goal
必败

## Outputs
- out: int  # 不会产出

## Steps
1. [act] 非数字转数（body 运行期异常 → step fail）
  + → out: int  # 结果
  > 纯计算
  > \`\`\`hop_python
  > out = float("not-a-number")
  > \`\`\`
`;
    const spec = `# CF
Id: cf

## Goal
f

## Outputs
- result: int  # 结果

## Steps
1. [call bad] 调必败
  + → result: out  # 映射
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ bad: CALLEE_FAIL }) };
    const { dispatcher } = setup(spec, host, {});
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toContain('CalleeFailure');
    expect(r.failure?.reason).toContain('"callee_spec_id":"bad"');
  });

  it('反例：depth 超限 → DEPTH_EXCEEDED 不建子实例（max_call_depth=1 时二层递归被拒）', async () => {
    // mid 调 double：caller→mid 深度1，mid→double 深度2 > 上限1
    const MID = `# Mid
Id: mid

## Goal
中间层

## Inputs
- n: int  # 数

## Outputs
- m: int  # 结果

## Steps
1. [call double(n)] 转调
  + → m: doubled  # 映射
`;
    const spec = `# CD
Id: cd

## Goal
d

## Inputs
- base: int  # 底数

## Outputs
- result: int  # 结果

## Steps
1. [call mid(n: base)] 调中间层
  + → result: m  # 映射
`;
    const host: HostConfig = {
      ...HOST,
      spec_provider: inMemoryProvider({ mid: MID, double: CALLEE_DOUBLE }),
      resource_limits: { max_tool_iterations: 20, max_context_tokens: 4000, max_output_tokens: 4096, max_replan_attempts: 3, max_call_depth: 1 },
    };
    const { dispatcher } = setup(spec, host, { base: 5 });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toContain('DEPTH_EXCEEDED');
  });

  it('正例：depth 上限内的二层递归正常完成（max_call_depth=2）', async () => {
    const MID = `# Mid
Id: mid

## Goal
中间层

## Inputs
- n: int  # 数

## Outputs
- m: int  # 结果

## Steps
1. [call double(n)] 转调
  + → m: doubled  # 映射
`;
    const spec = `# CD2
Id: cd2

## Goal
d

## Inputs
- base: int  # 底数

## Outputs
- result: int  # 结果

## Steps
1. [call mid(n: base)] 调中间层
  + → result: m  # 映射
`;
    const host: HostConfig = {
      ...HOST,
      spec_provider: inMemoryProvider({ mid: MID, double: CALLEE_DOUBLE }),
      resource_limits: { max_tool_iterations: 20, max_context_tokens: 4000, max_output_tokens: 4096, max_replan_attempts: 3, max_call_depth: 2 },
    };
    const { dispatcher } = setup(spec, host, { base: 5 });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['result']).toBe(10);
  });

  // 级联中止够到执行中的串行 call 子层（^anc-mcp-stop-run 第1条,2026-08-22 review 实抓：
  // handleCallStep 在 await 子 runSpec() 期间子既不在 inflightDispatchers 也不在 callFrames——
  // 首版只遍历两表,串行 call 子树烧到自然终态才停;activeCallChildren 第三表补平）
  // @v: anc-mcp-stop-run
  it('正例：cascade 打在 call 子层执行中 → 子步间中止,后续步骤不再执行（activeCallChildren 第三表）', async () => {
    // 子 spec 两步,各经受控工具——第一步挂起期间发 cascade,子应在步间停下,第二步工具不被调用
    const CALLEE_SLOW = `# Slow
Id: slow

## Goal
两步慢活

## Outputs
- b: text  # 第二步产物

## Steps
1. [act] 第一步
  + → a: text  # 中间产物
  > 调工具
  > \`\`\`hop_python
  > a = slow_tool()
  > \`\`\`
2. [act] 第二步
  - ← a
  + → b: text  # 产物
  > 调工具
  > \`\`\`hop_python
  > b = second_tool()
  > \`\`\`
`;
    const CALLER_SLOW = `# CS
Id: cs

## Goal
调慢子

## Outputs
- result: text  # 结果

## Steps
1. [call slow] 调用
  + → result: b  # 映射
`;
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>(res => { releaseSlow = res; });
    let slowCalled = false;
    const secondTool = vi.fn().mockResolvedValue({ result: 'x2', success: true });
    const toolProvider = {
      list: () => [
        { name: 'slow_tool', description: 's', input_schema: {}, requires_commit: false },
        { name: 'second_tool', description: 's2', input_schema: {}, requires_commit: false },
      ],
      execute: async (name: string) => {
        if (name === 'slow_tool') { slowCalled = true; await slowGate; return { result: 'x1', success: true }; }
        return secondTool();
      },
    };
    const host: HostConfig = { ...HOST, tool_provider: toolProvider, spec_provider: inMemoryProvider({ slow: CALLEE_SLOW }) };
    const { dispatcher } = setup(CALLER_SLOW, host, {});
    const p = dispatcher.runSpec();
    // 等子层真在飞（第一步工具已被调、挂在 gate 上）——此刻子只可能在 activeCallChildren 里
    while (!slowCalled) await new Promise(res => setTimeout(res, 5));
    dispatcher.requestAbortCascade();
    releaseSlow();                                   // 在飞那步跑完（协作式不打断单步）
    const r = await p;
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toContain('aborted');  // 子步间中止经 CalleeFailure 上卷
    expect(secondTool).not.toHaveBeenCalled();       // 子第二步没再执行——级联真停,不烧到自然终态
  });

  // replan 定向编辑（D44 定型编辑代数,作者三连裁定——delete/replace/insert 三原子+未提及=保留:
  // 去 keep〔编辑器缺省语义〕/补 delete〔代数完备〕/insert.before 锚〔引用原步骤定位〕）
  // @v: anc-exec-adaptive-pipeline
  describe('replan 定向编辑（编辑代数）', () => {
    const RSPEC = `# R
Id: r

## Goal
g

## Outputs
- out: text  # o

## Steps
1. [subtask retry=2 adaptive] 容器
  + → out: text  # o
  1.1. [reason] 甲步
    + → a: text  # pa
  1.2. [reason] 乙步
    - ← a
    + → b: text  # pb
  1.3. [reason] 丙步
    - ← b
    + → out: text  # o
2. [exit]
`;
    function mk() {
      const engine = new ExecutionEngine();
      engine.initExecution(RSPEC, HOST, {});
      return { engine, d: new StepDispatcher(engine, HOST) };
    }

    it('正例：delete+replace+insert 三原子同场——未提及步骤自动保留,全部重编号顶层连号', () => {
      const { d } = mk();
      // 删 1.2 / 换 1.3 / 在 1.1 之前插新步;1.1 未提及=自动保留
      const strategy = '{"edits": [{"op": "delete", "step_id": "1.2", "why": "假数据步"}, {"op": "replace", "step_id": "1.3", "why": "改吃a"}, {"op": "insert", "before": "1.1", "intent": "前置校验"}]}';
      const edits = (d as any).parseReplanEdits(strategy, '1');
      expect(edits).not.toBeNull();
      const patch = '<<EDIT 1>> 换丙\n7. [reason] 新丙\n  - ← a\n  + → out: text  # o\n<<EDIT 2>> 前插\n9. [check] 前置校验\n  - ← a\n  + → ok: bool  # p\n  + → note: text  # n';
      const md = (d as any).assembleReplanEdits(edits, patch, '1');
      expect(md).not.toBeNull();
      expect(md).toMatch(/^1\. \[check\] 前置校验/m);   // insert before 1.1 → 落位 1.
      expect(md).toMatch(/^2\. \[reason\] 甲步/m);      // 未提及=保留,重编号 2.
      expect(md).not.toContain('乙步');                   // delete 生效
      expect(md).toMatch(/^3\. \[reason\] 新丙/m);      // replace 落位 3.（乱号 7.归一）
    });

    it('正例：多 insert 同锚+与 delete 交错——清单序保持,删除锚步不影响已插片段（B案函数化次序钉）', () => {
      // 设计自查钉点:before 锚换算在"多 insert 指同一 before + 与 delete 交错"时的次序语义——
      // 同锚多 insert 按清单序排在锚步前;锚步本身被 delete 后,插入片段留在原位不随删。
      const { d } = mk();
      const strategy = '{"edits": [{"op": "insert", "before": "1.2", "intent": "插甲"}, {"op": "insert", "before": "1.2", "intent": "插乙"}, {"op": "delete", "step_id": "1.2", "why": "删锚步"}]}';
      const edits = (d as any).parseReplanEdits(strategy, '1');
      expect(edits).not.toBeNull();
      const patch = '<<EDIT 0>> 插甲\n1. [reason] 插甲步\n  - ← a\n  + → b: text  # pb\n<<EDIT 1>> 插乙\n1. [reason] 插乙步\n  - ← a\n  + → b: text  # pb';
      const md = (d as any).assembleReplanEdits(edits, patch, '1');
      expect(md).not.toBeNull();
      expect(md).toMatch(/^1\. \[reason\] 甲步/m);      // 未提及保留居首
      expect(md).toMatch(/^2\. \[reason\] 插甲步/m);    // 同锚清单序:先插甲
      expect(md).toMatch(/^3\. \[reason\] 插乙步/m);    // 后插乙
      expect(md).not.toMatch(/\[reason\] 乙步/);         // 锚步本身被 delete（"插乙步"含同串,按整行判）
      expect(md).toMatch(/^4\. \[reason\] 丙步/m);      // 后继保留重编号
    });

    it('正例：嵌套片段 insert before 锚+delete 锚——tagTemp 临时号防片段子号撞原步 id（review D4 固化面三探针,变异 tagTemp no-op 时删错对象）', () => {
      // 片段含子步(相对号 1.1)与原树步 1.1 撞号——tagTemp 失效时 delete 1.1 会按 id 定位到
      // 片段自己的子步,删错对象:原步 1.1 存活、片段子步消失(面三 probe3 实证形态)
      const { d } = mk();
      const strategy = '{"edits": [{"op": "insert", "before": "1.1", "intent": "带子步的前置"}, {"op": "delete", "step_id": "1.1", "why": "删原甲步"}]}';
      const edits = (d as any).parseReplanEdits(strategy, '1');
      expect(edits).not.toBeNull();
      const patch = '<<EDIT 0>> 带子步的前置\n1. [subtask retry=2] 新容器\n  + → a: text  # pa\n  1.1. [reason] 新子步\n    + → a: text  # pa';
      const md = (d as any).assembleReplanEdits(edits, patch, '1');
      expect(md).not.toBeNull();
      expect(md).toContain('新子步');                     // 片段子步存活——tagTemp 失效时它被 delete 误杀
      expect(md).not.toMatch(/\[reason\] 甲步/);         // 原步 1.1(甲步)被 delete——失效时它存活
      expect(md).toMatch(/^1\. \[subtask retry=2\] 新容器/m);
    });

    it('正例：insert before END → 追加末尾', () => {
      const { d } = mk();
      const edits = (d as any).parseReplanEdits('{"edits": [{"op": "insert", "before": "END", "intent": "收尾"}]}', '1');
      expect(edits).not.toBeNull();
      const md = (d as any).assembleReplanEdits(edits, '<<EDIT 0>> 收尾\n1. [reason] 收尾步\n  - ← out\n  + → out: text  # o', '1');
      expect(md).toMatch(/^4\. \[reason\] 收尾步/m);    // 三保留步后追加为 4.
      expect(md).toMatch(/^1\. \[reason\] 甲步/m);      // 全部未提及步骤保留
    });

    it('反例：replace/delete 引用悬空、同一步重复操作、insert.before 悬空 → null 回退全量', () => {
      const { d } = mk();
      expect((d as any).parseReplanEdits('{"edits": [{"op": "replace", "step_id": "9.9", "why": "w"}]}', '1')).toBeNull();
      expect((d as any).parseReplanEdits('{"edits": [{"op": "delete", "step_id": "1.1", "why": "w"}, {"op": "replace", "step_id": "1.1", "why": "w"}]}', '1')).toBeNull();
      expect((d as any).parseReplanEdits('{"edits": [{"op": "insert", "before": "8.8", "intent": "x"}]}', '1')).toBeNull();
    });

    it('反例：全删光且无补位（产物零步骤）→ null 回退（防极端输出）;策略散文 → null 回退', () => {
      const { d } = mk();
      expect((d as any).parseReplanEdits('{"edits": [{"op": "delete", "step_id": "1.1", "why": "w"}, {"op": "delete", "step_id": "1.2", "why": "w"}, {"op": "delete", "step_id": "1.3", "why": "w"}]}', '1')).toBeNull();
      expect((d as any).parseReplanEdits('删乙换丙', '1')).toBeNull();
    });

    it('反例：生成段缺某 <<EDIT k>> 片段 → assembleReplanEdits 返回 null 回退全量', () => {
      const { d } = mk();
      const edits = (d as any).parseReplanEdits('{"edits": [{"op": "replace", "step_id": "1.2", "why": "w"}]}', '1');
      expect((d as any).assembleReplanEdits(edits, '没有EDIT标记的散文', '1')).toBeNull();
    });
  });

  // call 子实例日志级别继承（2026-08-23 同批——dr9 实抓:顶层 debug 递归全 info,构建主体黑箱）
  // @v: anc-obs-log-levels
  it('正例：父 debug → call 子实例卫星日志同为 debug;父显式 info → 子随 info（两向继承）', async () => {
    const CALLEE = `# S
Id: sub

## Goal
g

## Outputs
- o: text  # x

## Steps
1. [act] 算
  + → o: text  # x
  > 纯机械
  > \`\`\`hop_python
  > o = "v"
  > \`\`\`
`;
    const CALLER = `# C
Id: c

## Goal
g

## Outputs
- out: text  # o

## Steps
1. [call sub] 调
  + → out: o  # 映射
2. [exit]
`;
    for (const lvl of ['debug', 'info'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `lvl-inherit-${lvl}-`));
      const HOSTX: HostConfig = { ...HOST, spec_provider: { resolve: async (id: string) => id === 'sub' ? { spec_id: id, source: CALLEE } : null } };
      const engine = new ExecutionEngine();
      engine.initExecution(CALLER, HOSTX, { logDir: dir, logLevel: lvl });
      const d = new StepDispatcher(engine, HOSTX);
      const r = await d.runSpec();
      expect(r.status).toBe('completed');
      const childLog = join(engine.getHopLog()!.getRunDir(), 'calls', '1', 'log');
      const runDirs = readdirSync(childLog);
      const head = readFileSync(join(childLog, runDirs[0], 'main.yaml'), 'utf-8');
      expect(head).toMatch(new RegExp(`^level: ${lvl}$`, 'm'));
    }
  });

  // 进程内 call 边界 $file 指针解引用（D59,2026-08-24——dr13 实撞:子 run 的大 fragment 输出
  // 经 deflateValues 成 {$file} 指针,settleCallOutcome 原封喂 completeCallStep 写进父变量
  // 空间,顺 collect 流进机械拼装步炸 edit_spec_tree,4 攻同败烧死。进程内传值恒真值）
  // @v: anc-exec-deflate
  it('正例：子实例大输出（>4096 经 deflate 成指针）跨 call 边界回填父空间为真值', async () => {
    const bigVal = 'F'.repeat(5000);   // 超 DEFLATE_THRESHOLD,子端 completed.outputs 会 deflate
    const CALLEE = `# S
Id: sub

## Goal
g

## Outputs
- big: text  # 大产出

## Steps
1. [act] 产大值
  + → big: text  # 大产出
  > 纯机械
  > \`\`\`hop_python
  > big = "F" * 5000
  > \`\`\`
`;
    const CALLER = `# C
Id: c

## Goal
g

## Outputs
- got: text  # 收取

## Steps
1. [call sub] 调
  + → got: big  # 映射
2. [exit]
`;
    const HOSTX: HostConfig = { ...HOST, spec_provider: { resolve: async (id: string) => id === 'sub' ? { spec_id: id, source: CALLEE } : null } };
    const engine = new ExecutionEngine();
    engine.initExecution(CALLER, HOSTX);
    const d = new StepDispatcher(engine, HOSTX);
    const r = await d.runSpec();
    expect(r.status).toBe('completed');
    // 父空间拿到的必须是真值字符串,不是 {$file} 指针对象
    const got = engine.getVariableStore().read('got', 'root');
    expect(typeof got).toBe('string');
    expect((got as string).length).toBe(5000);
  });

  // call 边界反馈传递（D41——父层重试反馈跨 call 传入子实例,外层意见轮重跑时重拆现场不再全盲）
  // @v: anc-exec-l2c-retry-feedback
  it('正例：父容器打回后重跑 call → 子实例收到 upstreamFeedback（buildCallUpstreamFeedback 含打回原文）', () => {
    const CALLER_FB = `# CF
Id: cf

## Goal
g

## Outputs
- out: text  # o

## Steps
1. [subtask retry=2] 容器
  + → out: text  # o
  1.1. [call sub] 调子
    + → out: o  # 映射
  1.2. [check] 闸
    - ← out
    + → ok: bool  # 过
    + → note: text  # 缺
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(CALLER_FB, HOST, {});
    engine.nextStep();
    engine.completeCallStep('1.1', { o: 'v1' });
    engine.nextStep(); engine.failStep('1.2', 'CHECK_FAILED: 产物有六个假body,打回');
    engine.nextStep();   // 重试轮
    const d = new StepDispatcher(engine, HOST);
    const up = (d as any).buildCallUpstreamFeedback('1.1');
    expect(up).toContain('假body');            // 父层打回意见进上游反馈
  });

  // @v: anc-exec-l2c-retry-feedback 当前打回意见零截断（v0.7.1 作者定"2000 也太少"）——
  // dr16 实撞:旧单条 400 截断把 6 项工单截剩残单传给子层。
  it('正例：大体量打回意见（>400 chars）跨 call 边界零截断下传（尾项存活）', () => {
    const CALLER_BIG = `# CB
Id: cb

## Goal
g

## Outputs
- out: text  # o

## Steps
1. [subtask retry=2] 容器
  + → out: text  # o
  1.1. [call sub] 调子
    + → out: o  # 映射
  1.2. [check] 闸
    - ← out
    + → ok: bool  # 过
    + → note: text  # 缺
2. [exit]
`;
    const engine = new ExecutionEngine();
    engine.initExecution(CALLER_BIG, HOST, {});
    engine.nextStep();
    engine.completeCallStep('1.1', { o: 'v1' });
    engine.nextStep();
    const bigOrder = Array.from({ length: 6 }, (_, i) => `缺陷${i + 1}：` + 'x'.repeat(300)).join('\n');
    engine.failStep('1.2', 'CHECK_FAILED: ' + bigOrder);
    engine.nextStep();
    const d = new StepDispatcher(engine, HOST);
    const up = (d as any).buildCallUpstreamFeedback('1.1')!;
    expect(up).toContain('缺陷1');
    expect(up).toContain('缺陷6');             // 旧 400 截断下必丢的末项存活
    expect(up.length).toBeGreaterThan(1500);   // 全量在场（旧口径 clip 到 400+前缀）
  });

  it('正例：递归拼接——本实例已持上游反馈时,下传给孙的反馈含祖辈意见（衰减靠截断不靠层数）', () => {
    const MINI = `# M
Id: m
## Goal
g
## Outputs
- o: text  # x
## Steps
1. [reason] r
  + → o: text  # x
`;
    const engine = new ExecutionEngine();
    engine.initExecution(MINI, HOST, { upstreamFeedback: '祖辈意见:档位如实标mixed' });
    const d = new StepDispatcher(engine, HOST);
    const up = (d as any).buildCallUpstreamFeedback('1');   // 本层无重试史,仅续传祖辈
    expect(up).toContain('祖辈意见');
  });

  it('反例：无重试史且无祖辈反馈 → undefined（正常路径零注入,不白占子实例 token）', () => {
    const MINI = `# M2
Id: m2
## Goal
g
## Outputs
- o: text  # x
## Steps
1. [reason] r
  + → o: text  # x
`;
    const engine = new ExecutionEngine();
    engine.initExecution(MINI, HOST, {});
    const d = new StepDispatcher(engine, HOST);
    expect((d as any).buildCallUpstreamFeedback('1')).toBeUndefined();
  });

  it('反例（对照）：单点 requestAbort 只停父层——call 子层不受影响跑完全部步骤（cascade 与单点的语义分界）', async () => {
    const CALLEE_TWO = `# Two
Id: two

## Goal
两步

## Outputs
- b: text  # 产物

## Steps
1. [act] 第一步
  + → a: text  # 中间
  > 调工具
  > \`\`\`hop_python
  > a = slow_tool()
  > \`\`\`
2. [act] 第二步
  - ← a
  + → b: text  # 产物
  > 调工具
  > \`\`\`hop_python
  > b = second_tool()
  > \`\`\`
`;
    const CALLER_TWO = `# CT
Id: ct

## Goal
调子

## Outputs
- result: text  # 结果

## Steps
1. [call two] 调用
  + → result: b  # 映射
`;
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>(res => { releaseSlow = res; });
    let slowCalled = false;
    const secondTool = vi.fn().mockResolvedValue({ result: 'y2', success: true });
    const toolProvider = {
      list: () => [
        { name: 'slow_tool', description: 's', input_schema: {}, requires_commit: false },
        { name: 'second_tool', description: 's2', input_schema: {}, requires_commit: false },
      ],
      execute: async (name: string) => {
        if (name === 'slow_tool') { slowCalled = true; await slowGate; return { result: 'y1', success: true }; }
        return secondTool();
      },
    };
    const host: HostConfig = { ...HOST, tool_provider: toolProvider, spec_provider: inMemoryProvider({ two: CALLEE_TWO }) };
    const { dispatcher } = setup(CALLER_TWO, host, {});
    const p = dispatcher.runSpec();
    while (!slowCalled) await new Promise(res => setTimeout(res, 5));
    dispatcher.requestAbort();                       // 单点：只置父层
    releaseSlow();
    const r = await p;
    expect(secondTool).toHaveBeenCalledTimes(1);     // 对照点：子层跑完全部步骤（单点不级联——parallel 杀活语义如旧）
    expect(r.status).toBe('failed');                 // 父自己仍在步间停下（call 整步跑完后的下一次检查点）
    expect(r.failure?.reason).toContain('aborted');
  });
});

// @v: anc-step-call-dynamic-callee —— callee 位插值解引用（晚绑定,2026-09-05 作者三拍:
// 动态派发归 call 不另造 run_spec 工具;结构管次数、变量管对象——LLM 只能定"调谁"不能定"调几次"）
describe('call callee 位插值解引用（^anc-step-call-dynamic-callee）', () => {
  // callee：纯计算 act body（无 LLM），把输入翻倍
  const CALLEE_DOUBLE = `# Double
Id: double

## Goal
输入翻倍

## Inputs
- n: int  # 输入数

## Outputs
- doubled: int  # 翻倍结果

## Steps
1. [act] 翻倍
  - ← n
  + → doubled: int  # 结果
  > 纯计算
  > \`\`\`hop_python
  > doubled = n * 2
  > \`\`\`
`;

  function inMemoryProvider(specs: Record<string, string>) {
    return {
      resolve: async (id: string) => (id in specs ? { spec_id: id, source: specs[id] } : null),
    };
  }

  function setup(callerSpec: string, host: HostConfig, params: Record<string, unknown>) {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(callerSpec, host, { params });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, host);
    return { engine, dispatcher };
  }

  it('正例：act body 产 callee 名变量 → call {var} 派发成功、子实例产出回填', async () => {
    const CALLER = `# Caller
Id: caller-dyn

## Goal
动态选 spec 调翻倍

## Inputs
- hint: line  # spec 名提示

## Outputs
- result: int  # 翻倍结果

## Steps
1. [act] 定 callee 名
  - ← hint
  + → target_spec: line  # 目标 spec id
  > 纯计算
  > \`\`\`hop_python
  > target_spec = strip(hint)
  > \`\`\`
2. [call {target_spec}(n: 21)] 调翻倍
  + → result: doubled  # 结果 ← 子输出
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ double: CALLEE_DOUBLE }) };
    const { dispatcher } = setup(CALLER, host, { hint: ' double ' });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['result']).toBe(42);
  });

  it('反例：变量值为对象 → 步骤 fail 含"非字符串"（不做 JSON 静默兜底）', async () => {
    const CALLER_OBJ = `# Caller
Id: caller-obj

## Goal
错误形态:callee 变量装了对象

## Inputs
- hint: line  # 提示

## Outputs
- result: int  # 结果

## Steps
1. [act] 产出对象值
  - ← hint
  + → target_spec: yaml  # 错拿对象当 callee
  > 纯计算
  > \`\`\`hop_python
  > target_spec = {"id": hint}
  > \`\`\`
2. [call {target_spec}(n: 21)] 调
  + → result: doubled
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ double: CALLEE_DOUBLE }) };
    const { dispatcher } = setup(CALLER_OBJ, host, { hint: 'double' });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toContain('非字符串');
    expect(r.failure?.reason).toContain('target_spec');   // 报文回显表达式原文
  });

  it('反例：求值出不存在的 Id → fail 含 UNKNOWN_SPEC（与拼错静态 Id 同款处置）', async () => {
    const CALLER_GHOST = `# Caller
Id: caller-ghost

## Goal
求值出不存在的 spec Id

## Inputs
- hint: line  # 提示

## Outputs
- result: int  # 结果

## Steps
1. [act] 定 callee 名
  - ← hint
  + → target_spec: line  # 目标 spec id
  > 纯计算
  > \`\`\`hop_python
  > target_spec = strip(hint)
  > \`\`\`
2. [call {target_spec}(n: 21)] 调
  + → result: doubled
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ double: CALLEE_DOUBLE }) };
    const { dispatcher } = setup(CALLER_GHOST, host, { hint: 'no-such-spec' });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toContain('UNKNOWN_SPEC');
  });

  it('正例：parallel 路径——loop 内 call {字段取} parallel 真派发收齐', async () => {
    const CALLER_PAR = `# Caller
Id: caller-par

## Goal
按清单逐项动态派发

## Inputs
- jobs: [yaml]  # 每项含 spec 字段（callee 标识）与 num 字段

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each job in jobs, collect v into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [act] 拆平本轮参数
    - ← job
    + → cur_n: int  # 本轮数
    > 纯计算
    > \`\`\`hop_python
    > cur_n = get(job, "num", 0)
    > \`\`\`
  1.2. [call {job.spec}(n: cur_n) parallel] 并行派发
    + → v: doubled  # 映射
2. [exit] 交付
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ double: CALLEE_DOUBLE }) };
    const { dispatcher } = setup(CALLER_PAR, host, { jobs: [{ spec: 'double', num: 1 }, { spec: 'double', num: 2 }] });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['outs']).toEqual([2, 4]);
  });

  it('反例：parallel 路径解引用失败——loop 内 call {job.spec} parallel,callee 位求值出对象值 → 该迭代失败带"非字符串"明细,不炸整个 loop（runSpec 收敛 completed,坏迭代不贡献元素——矩阵12同款集合语义。构造注记两条:①中间变量形态被 act body 输出 schema 检提前拦住到不了 call 位,故用字段取形态;②派发即推进语义下 launch 时刻读活变量空间,混合好坏两迭代会读到串轮绑定,故单坏迭代构造）', async () => {
    const CALLER_PAR_BAD = `# Caller
Id: caller-par-bad

## Goal
错误形态:并行派发的 callee 位求值出对象

## Inputs
- jobs: [yaml]  # 每项含 spec（callee 标识——坏项装对象）与 num 字段

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each job in jobs, collect v into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [act] 拆平本轮参数
    - ← job
    + → cur_n: int  # 本轮数
    > 纯计算
    > \`\`\`hop_python
    > cur_n = get(job, "num", 0)
    > \`\`\`
  1.2. [call {job.spec}(n: cur_n) parallel] 并行派发
    + → v: doubled  # 映射
2. [exit] 交付
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ double: CALLEE_DOUBLE }) };
    const { engine, dispatcher } = setup(CALLER_PAR_BAD, host, {
      jobs: [{ spec: { id: 'double' }, num: 2 }],   // callee 位是对象——解引用必败
    });
    const r = await dispatcher.runSpec();          // 不抛异常——坏迭代经收割账面收口,不炸 loop 结构
    // 语义更新（2026-09-06 全灭升 fail,^anc-exec-parallel-allfail）:本例单迭代派发且失败=1/1 全灭
    // ——旧期望 completed+空表按"部分失败列表变短"放行,新语义全灭不属部分失败,宿主 fail 上浮
    // 顶层无预算=实例 failed 诚实终态。解引用失败明细仍上账（下方断言不变）。
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect((r as any).failure?.reason ?? '').toContain('PARALLEL_ALL_FAILED');
    const reapDetails = engine.getExecEvents().filter(ev => ev.event === 'parallel_reap').map(ev => ev.detail ?? '').join('\n');
    expect(reapDetails).toContain('非字符串');      // 解引用失败明细上账（收割事件流）
    expect(reapDetails).toContain('job.spec');      // 报文回显表达式原文
  });

  it('正例：静态 Id 形态零回归——callee_spec_id 在场时 resolveCalleeId 直返不求值', async () => {
    const CALLER_STATIC = `# Caller
Id: caller-static

## Goal
静态调翻倍

## Inputs
- base: int  # 底数

## Outputs
- result: int  # 翻倍结果

## Steps
1. [call double(n: base)] 调翻倍
  + → result: doubled  # 结果 ← 子输出
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ double: CALLEE_DOUBLE }) };
    const { dispatcher } = setup(CALLER_STATIC, host, { base: 21 });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['result']).toBe(42);
  });
});

// @v: anc-exec-call-recursion, anc-exec-call-depth-check
// call 多层调用链补钉（^todo-call-deep-chain-tests，2026-08-11 作者记账）：二层链已覆盖，
// ≥3 层的跨层全局机制（call_path 多段剥头/失败壳逐层叠加/token 跨层上卷）此前零覆盖——
// 深链易坏点不是值搬运（每跳独立）而是这些跨多层机制。
describe('call 三层调用链（跨层机制补钉）', () => {
  // 三层链：top → mid → leaf。leaf 变体按用例给（纯计算/confirm/必败）。
  const LEAF_DOUBLE = `# Leaf
Id: leaf

## Goal
输入翻倍

## Inputs
- n: int  # 输入数

## Outputs
- doubled: int  # 翻倍结果

## Steps
1. [act] 翻倍
  - ← n
  + → doubled: int  # 结果
  > 纯计算
  > \`\`\`hop_python
  > doubled = n * 2
  > \`\`\`
`;
  const MID_PASS = `# Mid
Id: mid

## Goal
中间层转调

## Inputs
- k: int  # 数

## Outputs
- m: int  # 结果

## Steps
1. [call leaf(n: k)] 转调叶层
  + → m: doubled  # 映射
`;
  const TOP = `# Top
Id: top

## Goal
三层链顶层

## Inputs
- base: int  # 底数

## Outputs
- result: int  # 结果

## Steps
1. [call mid(k: base)] 调中间层
  + → result: m  # 映射
`;

  function inMemoryProvider(specs: Record<string, string>) {
    return {
      resolve: async (id: string) => (id in specs ? { spec_id: id, source: specs[id] } : null),
    };
  }
  function setup(callerSpec: string, host: HostConfig, params: Record<string, unknown>) {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(callerSpec, host, { params });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, host);
    return { engine, dispatcher };
  }

  it('正例（最小一单①）：三层链值穿透——base 经两跳映射到 leaf 翻倍后逐层回填', async () => {
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ mid: MID_PASS, leaf: LEAF_DOUBLE }) };
    const { dispatcher } = setup(TOP, host, { base: 21 });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['result']).toBe(42);
  });

  it('正例（最小一单②）：孙层 confirm 冒泡 call_path=[\'1\',\'1\']，resume 剥头两次下钻续跑到 completed', async () => {
    const LEAF_GATED = `# LeafG
Id: leafg

## Goal
带审批

## Inputs
- n: int  # 数

## Outputs
- ok_n: int  # 审批后

## Steps
1. [confirm require_human=true] 审批
  - ← n
  + → ok: bool  # 槽
2. [act] 透传
  - ← n
  + → ok_n: int  # 结果
  > 纯计算
  > \`\`\`hop_python
  > ok_n = n
  > \`\`\`
`;
    const MID_G = MID_PASS.replace('leaf(n: k)', 'leafg(n: k)').replace('m: doubled', 'm: ok_n');
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ mid: MID_G, leafg: LEAF_GATED }) };
    const { dispatcher } = setup(TOP, host, { base: 7 });
    const r1 = await dispatcher.runSpec();
    expect(r1.status).toBe('paused');
    // 跨层机制核心断言：两段 call_path（顶层 call '1' → mid 的 call '1'），step_id 是孙 spec 内的 confirm
    expect(r1.pause?.call_path).toEqual(['1', '1']);
    expect(r1.pause?.step_id).toBe('1');
    const r2 = await dispatcher.resume(r1.pause!.step_id, { value: 'approve' }, r1.pause!.call_path);
    expect(r2.status).toBe('completed');
    expect(r2.outputs?.['result']).toBe(7);
  });

  it('反例（最小一单③）：孙层 fail 穿两界带双层 CalleeFailure 壳，fail_kind 逐层继承（内核不被转述）', async () => {
    const LEAF_BAD = `# LeafB
Id: leafb

## Goal
必败

## Outputs
- out: int  # 不会产出

## Steps
1. [act] 运行期异常
  + → out: int  # 结果
  > 纯计算
  > \`\`\`hop_python
  > out = float("not-a-number")
  > \`\`\`
`;
    const MID_B = `# Mid
Id: mid

## Goal
中间层转调

## Outputs
- m: int  # 结果

## Steps
1. [call leafb] 转调必败
  + → m: out  # 映射
`;
    const TOP_B = `# TopB
Id: topb

## Goal
顶层

## Outputs
- result: int  # 结果

## Steps
1. [call mid] 调中间层
  + → result: m  # 映射
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ mid: MID_B, leafb: LEAF_BAD }) };
    const { dispatcher } = setup(TOP_B, host, {});
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    const reason = r.failure?.reason ?? '';
    // 双层壳：外壳 callee=mid，内层（mid 的 FailRecord 里）壳 callee=leafb——两层都在，内核不被自由转述
    expect(reason).toContain('"callee_spec_id":"mid"');
    expect(reason).toContain('CalleeFailure');
    expect(reason).toContain('leafb');
    expect(reason).toContain('not-a-number');   // 叶层原始失败内核穿两界仍在
    expect(reason).toContain('"fail_kind":"error"');   // fail_kind 跨界继承（标题主张的断言落点）
  });

  it('正例（次级）：三层链累计 token 跨层上卷——各层 LLM 用量汇入顶层 cumulative_tokens', async () => {
    // leaf 用 reason 步骤（走 LLM mock 计 token）；mid/top 纯 call 转发
    const LEAF_LLM = `# LeafL
Id: leafl

## Goal
推理一步

## Inputs
- n: int  # 数

## Outputs
- thought: text  # 推理结果

## Steps
1. [reason] 想一想
  - ← n
  + → thought: text  # 结果
  > 想
`;
    const MID_L = MID_PASS.replace('leaf(n: k)', 'leafl(n: k)').replace('m: doubled', 'm: thought').replace('- m: int  # 结果', '- m: text  # 结果');
    const TOP_L = TOP.replace('result: m', 'result: m').replace('- result: int  # 结果', '- result: text  # 结果');
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ mid: MID_L, leafl: LEAF_LLM }) };
    // 孙层 Dispatcher 各自 new client——mock 须挂在构造器级共享（顶层 defaultClient 单点 mock 够不到）
    const sharedCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"thought": "深思熟虑"}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    (Anthropic as any).mockImplementation(() => ({ messages: { create: sharedCreate } }));
    const { dispatcher } = setup(TOP_L, host, { base: 1 });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    // 孙层唯一一次 LLM 调用的 15 token 须上卷到顶层（跨层记账通道:settleCallOutcome 增量合并）
    expect(r.cumulative_tokens).toBe(15);
  });

  it('反例：跨 resume 不重复计 token——暂停前已计入的子层用量，resume 收帧时只并增量（reported_tokens 契约）', async () => {
    // leaf：先 reason（LLM 15 token）再 confirm 暂停再透传。暂停时 15 已上卷；resume 后
    // 收帧再并一次的话=30（双计）。断言终值 15。
    const LEAF_RP = `# LeafRP
Id: leafrp

## Goal
先想后审

## Inputs
- n: int  # 数

## Outputs
- out_n: int  # 结果

## Steps
1. [reason] 想一想
  - ← n
  + → thought: text  # 想法
  > 想
2. [confirm require_human=true] 审批
  - ← thought
  + → ok: bool  # 槽
3. [act] 透传
  - ← n
  + → out_n: int  # 结果
  > 纯计算
  > \`\`\`hop_python
  > out_n = n
  > \`\`\`
`;
    const MID_RP = MID_PASS.replace('leaf(n: k)', 'leafrp(n: k)').replace('m: doubled', 'm: out_n');
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ mid: MID_RP, leafrp: LEAF_RP }) };
    const sharedCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"thought": "已想好"}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    (Anthropic as any).mockImplementation(() => ({ messages: { create: sharedCreate } }));
    const { dispatcher } = setup(TOP, host, { base: 9 });
    const r1 = await dispatcher.runSpec();
    expect(r1.status).toBe('paused');
    expect(r1.cumulative_tokens).toBe(15);   // 暂停时孙层 15 已上卷
    const r2 = await dispatcher.resume(r1.pause!.step_id, { value: 'approve' }, r1.pause!.call_path);
    expect(r2.status).toBe('completed');
    expect(r2.outputs?.['result']).toBe(9);
    expect(r2.cumulative_tokens).toBe(15);   // resume 收帧只并增量 0——非 30 双计
  });

  it('正例（次级）：call 递归 × call parallel 混合——call 子实例门开真派发（一层不变式只关 parallel worker），三层收齐', async () => {
    // top --call--> mid（内含 loop + call leaf parallel）--真派发--> leaf×3。
    // 机制口径（review 探针纠偏 2026-08-11）：executeCall 建子 Dispatcher 不带 worker——
    // 设计"顶层/call 子 Dispatcher 启用 fan-out 探测；parallel worker 不启用"（step-dispatcher
    // ^anc-exec-standalone-parallel）——call 链不消耗并行层数，只有 parallel worker 内才退化。
    const MID_PAR = `# MidP
Id: midp

## Goal
批量并行构建

## Inputs
- nums: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in nums, collect v into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [call leaf(n) parallel] 并行翻倍
    + → v: doubled  # 映射
2. [exit] 交付
`;
    const TOP_P = `# TopP
Id: topp

## Goal
顶层

## Inputs
- items: [int]  # 列表

## Outputs
- all: [int]  # 结果

## Steps
1. [call midp(nums: items)] 调批量层
  + → all: outs  # 映射
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ midp: MID_PAR, leaf: LEAF_DOUBLE }) };
    const { dispatcher } = setup(TOP_P, host, { items: [1, 2, 3] });
    // 真派发断言：机制路径钉死（结果值真派发/退化同值，只断结果会掩盖机制回归）
    let dispatchCount = 0;
    const orig = ExecutionEngine.prototype.dispatchParallelCall;
    (ExecutionEngine.prototype as any).dispatchParallelCall = function (...a: unknown[]) { dispatchCount++; return (orig as any).apply(this, a); };
    try {
      const r = await dispatcher.runSpec();
      expect(r.status).toBe('completed');
      expect(r.outputs?.['all']).toEqual([2, 4, 6]);
      expect(dispatchCount).toBe(3);   // call 子实例内 parallel 真派发（门开）
    } finally {
      (ExecutionEngine.prototype as any).dispatchParallelCall = orig;
    }
  });
});

// @v: anc-provider-spec, anc-provider-spec-default
// call 工具决议与退化执行（^anc-exec-call-tool——概念 ^anc-step-call 扩义"工具应该可以被 call"）
// @v: anc-exec-call-tool
describe('call 工具决议（先 Spec 后 Tool）', () => {
  const TOOL_PROVIDER: ToolProvider = {
    list: () => [
      { name: 'lookup', description: '查数', input_schema: { type: 'object', properties: { key: { type: 'string' } } }, requires_commit: false },
      { name: 'send_alert', description: '发告警（不可逆）', input_schema: { type: 'object', properties: { msg: { type: 'string' } } }, requires_commit: true },
    ],
    execute: async (name, args) => name === 'lookup'
      ? { result: { value: `got:${String(args['key'])}` }, content_type: 'json' as const, success: true }
      : { result: 'sent', success: true },
  };
  const CALLER = `# CT
Id: ct
## Goal
g
## Inputs
- key: line  # 键
## Outputs
- out: text  # 出
## Steps
1. [call lookup(key)] 查数
  + → out: value  # 收 value 字段
2. [exit] 交付
`;

  it('正例：callee 未命中 spec 命中工具 → 单次 execute,响应字段按 output_mapping 落父变量', async () => {
    const host: HostConfig = { ...HOST, tool_provider: TOOL_PROVIDER };
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CALLER, host, { params: { key: 'k1' } });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, host);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.out).toBe('got:k1');   // value 字段经映射落 out
  });

  it('反例：requires_commit 工具在 call 位被拦（COMMIT_REQUIRED 指路 commit body）', async () => {
    const SPEC2 = CALLER.replace('lookup(key)', 'send_alert(msg: key)').replace('+ → out: value', '+ → out: result');
    const host: HostConfig = { ...HOST, tool_provider: TOOL_PROVIDER };
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC2, host, { params: { key: 'k1' } });
    const dispatcher = new StepDispatcher(engine, host);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toContain('COMMIT_REQUIRED');
  });

  it('反例：spec 与工具双不中 → UNKNOWN_SPEC 报文点明两面均未命中', async () => {
    const SPEC3 = CALLER.replace('lookup(key)', 'nonexistent(key)');
    const host: HostConfig = { ...HOST, tool_provider: TOOL_PROVIDER, spec_provider: { resolve: async () => null } };
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC3, host, { params: { key: 'k1' } });
    const dispatcher = new StepDispatcher(engine, host);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toContain('spec 或工具');
  });

  it('正例守卫：同名 spec 优先于工具（决议序=先 SpecProvider）', async () => {
    const CALLEE = `# L
Id: lookup
## Goal
g
## Inputs
- key: line  # 键
## Outputs
- value: text  # 值
## Steps
1. [act] 定值
  - ← key
  + → value: text  # 值
  > \`\`\`hop_python
  > value = "spec:" + key
  > \`\`\`
2. [exit]
`;
    const host: HostConfig = { ...HOST, tool_provider: TOOL_PROVIDER, spec_provider: { resolve: async (id: string) => id === 'lookup' ? { spec_id: 'lookup', source: CALLEE } : null } };
    const engine = new ExecutionEngine();
    engine.initExecution(CALLER, host, { params: { key: 'k9' } });
    const dispatcher = new StepDispatcher(engine, host);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.out).toBe('spec:k9');   // spec 赢——工具通道未触
  });

  // review D5：整值兜底收窄——对象响应字段 miss 响亮失败,不整值灌错
  it('D5 反例：对象响应而 output_mapping.from 打错字段名 → failed 点名可用字段,不灌整对象', async () => {
    const SPEC5 = CALLER.replace('+ → out: value', '+ → out: valeu');   // from 名拼错
    const host: HostConfig = { ...HOST, tool_provider: TOOL_PROVIDER };
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC5, host, { params: { key: 'k1' } });
    const dispatcher = new StepDispatcher(engine, host);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toContain("无字段 'valeu'");
    expect(r.failure?.reason).toContain('value');   // 报文列出真实可用字段
  });

  it('D5 正例：标量响应+单映射 → 整值直落（唯一合法兜底形态）', async () => {
    const TP5: ToolProvider = {
      list: () => [{ name: 'ping', description: '探', input_schema: { type: 'object', properties: { key: { type: 'string' } } }, requires_commit: false }],
      execute: async () => ({ result: 'pong', success: true }),
    };
    const SPEC6 = CALLER.replace('lookup(key)', 'ping(key)').replace('+ → out: value', '+ → out: r');
    const host: HostConfig = { ...HOST, tool_provider: TP5 };
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC6, host, { params: { key: 'k1' } });
    const dispatcher = new StepDispatcher(engine, host);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.out).toBe('pong');
  });
});

// Tools 段 init 对账（^anc-exec-tools-reconcile） // @v: anc-exec-tools-reconcile
describe('Tools 段 init 对账', () => {
  const TP: ToolProvider = {
    list: () => [{ name: 'web_search', description: '搜', input_schema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer' } } }, requires_commit: false }],
    execute: async () => ({ result: 'x', success: true }),
  };
  const mk = (tools: string) => `# TR
Id: tr
Goal: g

Tools:
${tools}

Outputs:
- r: text  # 出

## Steps
1. [reason] 想
  + → r: text  # 出
`;

  it('正例：声明的工具在清单且参数是子集 → init ok', () => {
    const engine = new ExecutionEngine();
    const r = engine.initExecution(mk(`- web_search(query) -> results: yaml  # 搜索
  - query: line   # 关键词`), { ...HOST, tool_provider: TP });
    expect(r.status).toBe('ok');
  });

  it('反例：声明的工具不在清单 → INIT_FAILED 点名', () => {
    const engine = new ExecutionEngine();
    const r = engine.initExecution(mk(`- no_such_tool(query) -> results: yaml  # 不存在
  - query: line   # 关键词`), { ...HOST, tool_provider: TP });
    expect(r.status).toBe('error');
    expect((r as { errors: { message: string }[] }).errors.some(e => e.message.includes("no_such_tool") && e.message.includes('不在环境工具面'))).toBe(true);
  });

  it('反例：声明了注册面没有的参数 → INIT_FAILED 点名超集参数', () => {
    const engine = new ExecutionEngine();
    const r = engine.initExecution(mk(`- web_search(query, depth) -> results: yaml  # 搜索
  - query: line   # 关键词
  - depth: int    # 注册面没有这个参数`), { ...HOST, tool_provider: TP });
    expect(r.status).toBe('error');
    expect((r as { errors: { message: string }[] }).errors.some(e => e.message.includes('depth'))).toBe(true);
  });

  it('正例：无 Tools 段/无 ToolProvider 零对账（向后兼容）', () => {
    const engine = new ExecutionEngine();
    const noTools = mk('').replace(/Tools:\n\n\n/, '');
    const r = engine.initExecution(noTools, HOST);
    expect(r.status).toBe('ok');
  });

  // review D6：spec 侧参数/输出类型词表核（表外 error）
  it('反例：参数类型不在词汇表 → INIT_FAILED 点名类型', () => {
    const engine = new ExecutionEngine();
    const r = engine.initExecution(mk(`- web_search(query) -> results: yaml  # 搜索
  - query: strnig   # 拼错的类型`), { ...HOST, tool_provider: TP });
    expect(r.status).toBe('error');
    expect((r as { errors: { message: string }[] }).errors.some(e => e.message.includes("strnig") && e.message.includes('词汇表'))).toBe(true);
  });

  // review D4：requires_commit 注明判据 token 化——否定语境不误判、独立注记才算注明
  it('D4 正例：说明含"并非 requires_commit" → 不判失实（negation-aware）', () => {
    const engine = new ExecutionEngine();
    const r = engine.initExecution(mk(`- web_search(query) -> results: yaml  # 只读搜索,并非 requires_commit
  - query: line   # 关键词`), { ...HOST, tool_provider: TP });
    expect(r.status).toBe('ok');
  });

  it('D4 反例：spec 注明 (requires_commit) 而注册面 false → INIT_FAILED 声明失实', () => {
    const engine = new ExecutionEngine();
    const r = engine.initExecution(mk(`- web_search(query) -> results: yaml  # 搜索（requires_commit）
  - query: line   # 关键词`), { ...HOST, tool_provider: TP });
    expect(r.status).toBe('error');
    expect((r as { errors: { message: string }[] }).errors.some(e => e.message.includes('声明失实'))).toBe(true);
  });
});

// review D1：生产通道（dispatcher.runSpec 装配后）对账真生效——init 期 provider 可能未装配,
// runSpec 入口按最终工具面复核。 // @v: anc-exec-tools-reconcile
describe('Tools 对账生产通道（runSpec 装配后,review D1）', () => {
  const SPEC_WITH_TOOL = `# TRP
Id: trp
Goal: g

Tools:
- ghost_tool(x) -> y: text  # 不存在的工具
  - x: line   # 入参

Outputs:
- r: text  # 出

## Steps
1. [reason] 想
  + → r: text  # 出
`;

  // @v: anc-exec-state-persistence —— init 后失败终态落盘（todo/0058,0043 漏网半边:Tools 对账
  // 拒原直接 return failed 零落账,state.json 停在全 pending,快照消费者〔CLI status/跨进程看护〕
  // 对死 run 恒见 running——看护实撞空轮询 12 分钟。修=markInitFailed 置 terminal_failure+
  // finalizeTerminal;determineExecutionStatus 先消费终态标记再步骤态推导。变异实证:撤
  // markInitFailed 调用,下方跨进程钉红）
  it('正例：Tools 对账拒后终态落盘——跨进程 load 后 getStatus 报 failed 非 running（todo/0058）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'init-fail-'));
    const engine = new ExecutionEngine();
    const r0 = engine.initExecution(SPEC_WITH_TOOL, HOST, { stateDir: dir });
    expect(r0.status).toBe('ok');
    const host: HostConfig = { ...HOST, tool_provider: { list: () => [{ name: 'other', description: 'o', input_schema: { type: 'object', properties: {} }, requires_commit: false }], execute: async () => ({ result: 'x', success: true }) } };
    const dispatcher = new StepDispatcher(engine, host);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    // 跨进程视角：从快照重建实例,status 必须与进程内响应一致（修前:恒 running 蒙住看护）
    const reloaded = ExecutionEngine.load(join(dir, engine.getInstanceId()));
    const st = reloaded.getStatus();
    expect(st.execution_status).toBe('failed');
    // 失败原因跨进程可读（terminal_failure 随快照）
    const next = reloaded.nextStep();
    expect(next.status).toBe('failed');
    if (next.status === 'failed') expect(String(next.failure_reason)).toContain('ghost_tool');
  });

  it('反例：Tools 段声明的工具不在装配后清单 → runSpec 即 failed 不进首步', async () => {
    const engine = new ExecutionEngine();
    // init 用无 provider 的 HOST（init 期对账跳过——正是 D1 抓的窗口）
    const r0 = engine.initExecution(SPEC_WITH_TOOL, HOST);
    expect(r0.status).toBe('ok');
    // 装配一个不含 ghost_tool 的 provider 进 dispatcher → runSpec 入口对账必须拦住
    const host: HostConfig = { ...HOST, tool_provider: { list: () => [{ name: 'other', description: 'o', input_schema: { type: 'object', properties: {} }, requires_commit: false }], execute: async () => ({ result: 'x', success: true }) } };
    const dispatcher = new StepDispatcher(engine, host);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    expect(String(r.failure?.reason ?? '')).toContain('ghost_tool');
    expect(r.failure?.step_id).toBe('(init)');   // 未进首步
  });

  it('正例：装配后清单含所声明工具 → 对账放行照常执行到 completed', async () => {
    const SPEC_OK = `# TRP2
Id: trp2
Goal: g

Tools:
- real_tool(x) -> y: text  # 真工具
  - x: line   # 入参

Outputs:
- r: text  # 出

## Steps
1. [act] 拼
  + → r: text  # 出
  > \`\`\`hop_python
  > r = "ok"
  > \`\`\`
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC_OK, HOST);
    const host: HostConfig = { ...HOST, tool_provider: { list: () => [{ name: 'real_tool', description: 'r', input_schema: { type: 'object', properties: { x: { type: 'string' } } }, requires_commit: false }], execute: async () => ({ result: 'x', success: true }) } };
    const dispatcher = new StepDispatcher(engine, host);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.r).toBe('ok');
  });
});

describe('DirSpecProvider（缺省同目录寻址）', () => {
  it('正例：解析 <baseDir>/<id>.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-'));
    writeFileSync(join(dir, 'foo.md'), '# Foo\nId: foo\n');
    const { DirSpecProvider } = await import('../src/dispatcher.js');
    const p = new DirSpecProvider(dir);
    const s = await p.resolve('foo');
    expect(s?.spec_id).toBe('foo');
    expect(s?.source).toContain('Id: foo');
  });

  it('反例：不存在的 id → null；含路径分隔符/.. → null（防穿越）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-'));
    writeFileSync(join(dir, 'real.md'), '# R\nId: real\n');
    const { DirSpecProvider } = await import('../src/dispatcher.js');
    const p = new DirSpecProvider(join(dir, 'sub'));
    mkdirSync(join(dir, 'sub'), { recursive: true });
    expect(await p.resolve('missing')).toBeNull();
    expect(await p.resolve('../real')).toBeNull();
    expect(await p.resolve('a/b')).toBeNull();
    expect(await p.resolve('a\\b')).toBeNull();
  });
});

// @v: anc-exec-standalone-parallel, anc-exec-parallel-confirm-exclude
// P0.5 迁移：原"独立模式真并行"（旧通道 collectParallelBatch/泳道池）测试改写为统一模型
// 文法与语义（subtask parallel=异步派发申报，loop 头 parallel 已废除）。矩阵行 1(subtask)/3/5/15。
// @v: anc-exec-gather, anc-exec-parallel-dispatch-model, anc-exec-parallel-reap-drain
describe('统一模型 subtask parallel（独立模式 P0.5）', () => {
  // 兄弟位并发：两个标注分支 + 中间未标注步骤混排（矩阵行 3）
  const SIBLING_SPEC = `# Para
Id: para

## Goal
兄弟并发

## Inputs
- a: int  # 甲
- b: int  # 乙

## Outputs
- out_a: int  # 甲结果
- out_b: int  # 乙结果
- out_c: int  # 主线结果

## Steps
1. [subtask] 混排组
  + → out_a: int  # 甲结果
  + → out_b: int  # 乙结果
  + → out_c: int  # 主线结果
  1.1. [subtask parallel] 处理甲
    + → out_a: int  # 甲结果
    1.1.1. [act] 算甲
      - ← a
      + → out_a: int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > out_a = a * 10
      > \`\`\`
  1.2. [act] 主线自己算（甲在飞时执行）
    - ← b
    + → out_c: int  # 主线结果
    > \`\`\`hop_python
    > out_c = b + 1
    > \`\`\`
  1.3. [subtask parallel] 处理乙
    + → out_b: int  # 乙结果
    1.3.1. [act] 算乙
      - ← b
      + → out_b: int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > out_b = b + 5
      > \`\`\`
2. [exit] 交付
`;

  // 循环体标注：渐进派发收集（原 for-each parallel 的统一模型写法）
  const LOOP_BODY_SPEC = `# FE
Id: fe

## Goal
逐项翻倍

## Inputs
- nums: [int]  # 数字列表

## Outputs
- doubled: [int]  # 翻倍列表

## Steps
1. [loop for-each n in nums, collect d into doubled] 逐个翻倍
  + → doubled: [int]  # 收集
  1.1. [subtask parallel] 翻倍一项
    + → d: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → d: int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > d = n * 2
      > \`\`\`
2. [exit] 交付
`;

  it('正例（矩阵3）：兄弟混排——标注者并发、未标注主线步骤照常执行、容器边界收齐', async () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SIBLING_SPEC, HOST, { params: { a: 3, b: 4 } });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, HOST);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['out_a']).toBe(30);
    expect(r.outputs?.['out_b']).toBe(9);
    expect(r.outputs?.['out_c']).toBe(5);
    // 收齐后账面无在飞（幻影反例）
    expect(engine.getInflight().filter(f => f.status === 'inflight')).toHaveLength(0);
  });

  it('正例（矩阵1 subtask 形态/5）：循环体标注渐进派发，列表按派发序收齐', async () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(LOOP_BODY_SPEC, HOST, { params: { nums: [1, 2, 3, 4, 5, 6, 7] } });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, HOST);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['doubled']).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });

  it('反例（矩阵12 subtask 形态）：失败的活不贡献收集元素（列表变短）', async () => {
    const FAIL_ONE = LOOP_BODY_SPEC.replace('> d = n * 2', '> d = float(n) * 2');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(FAIL_ONE, HOST, { params: { nums: [1, 'x', 3] } });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, HOST);
    const r = await dispatcher.runSpec();
    // 部分失败：收集 [2, 6]（失败项不贡献）；主线不被拖垮——全灭升 fail 后本语义一字不动
    expect(r.status).toBe('completed');
    expect(r.outputs?.['doubled']).toEqual([2, 6]);
  });

  // @v: anc-exec-parallel-allfail —— 全灭升 fail（2026-09-06 作者令"现在修":dv-batch 七子实例
  // 全灭主线照 completed 空 reports 实撞——全部失败被"部分失败列表变短"的字面漏网伪装成成功;
  // 概念 :696 澄清:集合语义容忍"少几个"不容忍"一个没有"）
  it('正例：全灭（3/3 派发全部失败）→ 宿主 loop fail 上浮,实例 failed 且 reason 携 PARALLEL_ALL_FAILED 与派发数', async () => {
    const ALL_FAIL = LOOP_BODY_SPEC.replace('> d = n * 2', '> d = float(n) * 2');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(ALL_FAIL, HOST, { params: { nums: ['x', 'y', 'z'] } });   // 三项全非数——全灭
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, HOST);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');                                        // 不再伪装 completed
    const reason = (r as { failure?: { reason: string } }).failure?.reason ?? '';
    expect(reason).toContain('PARALLEL_ALL_FAILED');
    expect(reason).toContain('派发 3');                                     // 派发数在场
  });

  it('反例：空输入列表（0 派发）→ completed 空表（空输入合法,不是全灭）', async () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(LOOP_BODY_SPEC, HOST, { params: { nums: [] } });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, HOST);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['doubled']).toEqual([]);
  });

  // @v: anc-exec-parallel-dispatch-model, anc-rule-s12 —— 收敛边界定形批（2026-08-13 作者四裁决）
  it('正例：兄弟位具名输出失败 → 收割即边界 fail → 边界 retry 重派发修复后 completed（retry 归属恒=最近边界）', async () => {
    // act body 消费 last_try：首轮 None 参与乘法计算异常 → 子实例 fail;边界 retry 时
    // 前置 act 置数 → 第二轮成功。锚"收割即 fail 走边界 retry"全环:失败→杀域→重置→重派→修复。
    const RETRY_SPEC = `# R
Id: r

## Goal
g

## Inputs
- flaky_gate: int  # 门值——测试以 None 起步模拟首轮故障

## Outputs
- out_v: int  # 结果

## Steps
1. [subtask retry=2] 边界
  + → out_v: int  # 结果
  1.1. [act] 置数（重跑轮把料补上）
    + → seed: int = 7  # 首轮 7
    > 纯计算
    > \`\`\`hop_python
    > seed = 7
    > \`\`\`
  1.2. [subtask parallel] 活
    + → out_v: int  # 结果
    1.2.1. [act] 算
      - ← seed, flaky_gate
      + → out_v: int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > out_v = seed * flaky_gate
      > \`\`\`
2. [exit] 交付
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(RETRY_SPEC, HOST, { params: { flaky_gate: 'x' } });
    expect(init.status).toBe('ok');
    // flaky_gate 以文本起步（7×'x' 计算异常→子实例 fail,同矩阵12实撞形态）;首轮 fail 后注入数值,重派轮成功
    const dispatcher = new StepDispatcher(engine, HOST);
    const varsStore = engine.getVariableStore();
    const origReap = engine.reapParallelSubtask.bind(engine);
    let firstFail = true;
    (engine as unknown as { reapParallelSubtask: typeof origReap }).reapParallelSubtask = (ci, outcome) => {
      origReap(ci, outcome);
      if (outcome.failure && firstFail) { firstFail = false; varsStore.write('flaky_gate', 3, 'root'); }
    };
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['out_v']).toBe(21);   // 重派轮 7*3——同 childInstance 名重用（killed 尸账让位）
    // 失败归属恒在最近边界"1"（不飘不抖）
    const events = (engine as any).execEvents as { event: string; step_id: string }[];
    expect(events.some(e => e.event === 'retry' && e.step_id === '1')).toBe(true);
  });

  it('正例：[case(cond) parallel] 是合法派发单位——branch 选中臂后整棵 case 异步派发,边界=上层 subtask', async () => {
    const CASE_PAR = `# CP
Id: cp

## Goal
g

## Inputs
- x: int  # 选择子

## Outputs
- r: int  # 结果

## Steps
1. [subtask] 边界
  + → r: int  # 结果
  1.1. [branch] 分流
    1.1.1. [case(x == 1) parallel] 并行臂
      + → r: int  # 结果
      1.1.1.1. [act] 算
        - ← x
        + → r: int  # 结果
        > 纯计算
        > \`\`\`hop_python
        > r = x * 100
        > \`\`\`
    1.1.2. [case(else)] 兜底
      1.1.2.1. [act] 缺省
        + → r: int  # 结果
        > 纯计算
        > \`\`\`hop_python
        > r = 0
        > \`\`\`
2. [exit] 交付
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CASE_PAR, HOST, { params: { x: 1 } });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, HOST);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['r']).toBe(100);
    // 真派发过（不是退化串行）:账上有 1.1.1 的派发事件
    const events = (engine as any).execEvents as { event: string; step_id: string }[];
    expect(events.some(e => e.event === 'parallel_dispatch' && e.step_id === '1.1.1')).toBe(true);
  });

  // @v: anc-exec-parallel-hitl-queue
  it('正例（U4b HITL 队列,0013）：标注子树内 ask → 入队 paused,按 child 应答续跑到 completed', async () => {
    const MIX_SPEC = `# Mix
Id: mix

## Goal
并发+ask 混合

## Inputs
- a: int  # 甲

## Outputs
- out_a: int  # 甲结果

## Steps
1. [subtask] 混合组
  + → out_a: int  # 甲结果
  1.1. [subtask parallel] 纯计算分支
    + → out_a: int  # 结果
    1.1.1. [act] 算
      - ← a
      + → out_a: int  # 结果
      > 纯计算
      > \`\`\`hop_python
      > out_a = a * 10
      > \`\`\`
  1.2. [subtask parallel] 要问人的分支
    + → human_val: int  # 人值
    1.2.1. [ask require_human=true] 请提供数值
      + → human_val: int  # 人值
2. [exit] 交付
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(MIX_SPEC, HOST, { params: { a: 2 } });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, HOST);
    const r = await dispatcher.runSpec();
    // U4b（0013 兑现,PARALLEL_HITL_TODO 判 failed 退役）：ask 分支 paused 入队,纯计算分支
    // 照常收割;主线只剩等人 → run 级 paused,队首卡携 child_instance 寻址。
    expect(r.status).toBe('paused');
    expect(r.pause?.pause_reason).toBe('ask');
    const child = r.pause?.child_instance;
    expect(child).toBeDefined();
    // 在飞账:该子实例 paused（让名额,不占并发;收齐门照等）
    expect(engine.getInflight().find(f => f.child_instance === child)?.status).toBe('paused');
    // 队列全量呈现面
    expect(dispatcher.getPausedChildren().size).toBe(1);
    // 按 child 应答 → 子实例续跑终态收割 → 主线收齐 → completed
    const r2 = await dispatcher.resume(r.pause!.step_id, { human_val: 7 }, undefined, child);
    expect(r2.status).toBe('completed');
    expect(dispatcher.getPausedChildren().size).toBe(0);
  });

  it('正例（U4b）：多子实例同时 paused 全入队,逐张应答逐个续跑,答完 completed', async () => {
    const MULTI = `# Multi
Id: multi

## Goal
批量问人

## Inputs
- items: [int]  # 列表

## Outputs
- vals: [int]  # 人值列表

## Steps
1. [loop for-each it in items, collect human_val into vals] 逐项
  + → vals: [int]  # 收集
  1.1. [subtask parallel] 问人分支
    + → human_val: int  # 人值
    1.1.1. [ask require_human=true] 请提供数值
      - ← it
      + → human_val: int  # 人值
2. [exit] 交付
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(MULTI, HOST, { params: { items: [1, 2] } });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, HOST);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('paused');
    // 两张卡全入队（方案 A 全量呈现面）,各携 child_instance
    expect(dispatcher.getPausedChildren().size).toBe(2);
    const cards = [...dispatcher.getPausedChildren().values()].map(x => x.pause);
    expect(new Set(cards.map(c => c.child_instance)).size).toBe(2);
    // 逐张应答:答第一张 → 仍有一张等 → run 仍 paused（下一张卡）
    const r2 = await dispatcher.resume(cards[0].step_id, { human_val: 11 }, undefined, cards[0].child_instance);
    expect(r2.status).toBe('paused');
    expect(dispatcher.getPausedChildren().size).toBe(1);
    // 答第二张 → 收齐 completed,收集列表按派发序两元素齐
    const c2 = [...dispatcher.getPausedChildren().values()][0].pause;
    const r3 = await dispatcher.resume(c2.step_id, { human_val: 22 }, undefined, c2.child_instance);
    expect(r3.status).toBe('completed');
    expect(r3.outputs?.['vals']).toEqual([11, 22]);
  });

  it('正例（U4b 杀活连坐）：主线失败时 paused 子实例同杀,卡不残留队列清空', async () => {
    const KILLMIX = `# KillMix
Id: killmix

## Goal
等人+主线失败

## Inputs
- a: int  # 甲

## Outputs
- out_b: int  # 乙

## Steps
1. [subtask retry=0] 混合组
  + → out_b: int  # 乙
  1.1. [subtask parallel] 要问人的分支
    + → human_val: int  # 人值
    1.1.1. [ask require_human=true] 请提供
      + → human_val: int  # 人值
  1.2. [act] 必败步
    - ← a
    + → out_b: int  # 乙
    > \`\`\`hop_python
    > out_b = fail("硬失败")
    > \`\`\`
2. [exit] 交付
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(KILLMIX, HOST, { params: { a: 1 } });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, HOST);
    const r = await dispatcher.runSpec();
    // 主线 1.2 失败 → retry=0 直败 → 杀活:paused 子实例连坐 killed,队列清空
    expect(r.status).toBe('failed');
    const pausedEntry = engine.getInflight().find(f => f.status === 'paused');
    expect(pausedEntry).toBeUndefined();   // 无残留 paused 账（killed 或已出账）
  });

  // @v: anc-exec-parallel-hitl-queue （U4b第6条:崩溃恢复=重派发重暂停——36轮review证伪'队列重建',
  // 内存态子实例崩溃即灭;重跑到暂停点重新入队,人没答过零损失;load 回填 rawSource 是配套）
  it('正例（U4b 跨进程恢复）：paused 账崩溃后 load+resumeSpec → 重派发重新暂停,应答续跑 completed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'u4b-crash-'));
    const SPEC_CRASH = `# M
Id: m-crash
## Goal
g
## Inputs
- a: int  # 甲

## Outputs
- out_a: int  # 结果

## Steps
1. [subtask] 组
  + → out_a: int  # 结果
  1.1. [subtask parallel] 问人
    + → human_val: int  # 人值
    1.1.1. [ask require_human=true] 请给
      + → human_val: int  # 人值
  1.2. [act] 算
    - ← a
    + → out_a: int  # 结果
    > \`\`\`hop_python
    > out_a = a
    > \`\`\`
2. [exit] 交付
  + → out_a
`;
    writeFileSync(join(dir, 's.md'), SPEC_CRASH);
    const sd = join(dir, '.hopstate');
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(SPEC_CRASH, HOST, { stateDir: sd, params: { a: 3 }, specPath: join(dir, 's.md') });
    const d1 = new StepDispatcher(e1, HOST);
    const r1 = await d1.runSpec();
    expect(r1.status).toBe('paused');
    expect(e1.getInflight().find(f => f.status === 'paused')).toBeDefined();
    // 崩溃模拟:全新进程 load（rawSource 从 spec_path 回填）
    const e2 = ExecutionEngine.load(join(sd, (init as { instance_id: string }).instance_id));
    const d2 = new StepDispatcher(e2, HOST);
    const r2 = await d2.resumeSpec();
    // 重派发重新暂停(不是 failed,不是队列凭空重建)
    expect(r2.status).toBe('paused');
    expect(r2.pause?.child_instance).toBeDefined();
    const r3 = await d2.resume(r2.pause!.step_id, { human_val: 9 }, undefined, r2.pause!.child_instance);
    expect(r3.status).toBe('completed');
    expect(r3.outputs?.['out_a']).toBe(3);
  });

  it('反例（U4b/0094）：child_instance 不在队列 → 结构化 rejected 不 throw（原钉标题写"结构化拒"断言却钉 throw——标题与断言自相矛盾,钉死的正是 0094 病灶:throw 被 mcp catch 锤 failed 终态毁可恢复 run;修后按标题本义断言）', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(`# T\nId: t\n## Goal\ng\n## Outputs\n- r: text\n## Steps\n1. [reason] R\n  + → r: text\n  > t\n`, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    const r = await dispatcher.resume('1', { v: 1 }, undefined, 'ghost.1');   // @v: anc-exec-parallel-hitl-queue
    expect(r.rejected?.code).toBe('CHILD_NOT_IN_QUEUE');
    expect(r.rejected?.message).toMatch(/串行 call 停点|去掉 child_instance/);   // 指引带串行停点修正路
  });

  it('反例（0094 实撞形态）：串行 call 内 confirm 停点被误带 child_instance 应答 → 结构化拒收 run 保持可恢复,去掉参数按 call_path 重答即续跑', async () => {
    // 复现 probe 二轮实撞:串行 [call callee],callee 内停点——挂起帧走 call_path 路由不入
    // pausedChildren 队列;caller 误带 child_instance(卡面 call_path/child_instance 均空无从判别)
    // 原直接 throw 锤死 run。修后:结构化拒 → caller 去参重答 → 正常续跑到 completed。
    const CALLEE_G = `# G\nId: g94\n\n## Goal\n带审批\n\n## Inputs\n- n: int  # 数\n\n## Outputs\n- out_n: int  # 出\n\n## Steps\n1. [confirm require_human=true] 审批\n  - ← n\n  + → ok: bool  # 槽\n2. [act] 透传\n  - ← n\n  + → out_n: int  # 出\n  > \`\`\`hop_python\n  > out_n = n\n  > \`\`\`\n`;
    const spec94 = `# M94\nId: m94\n\n## Goal\n串行调\n\n## Inputs\n- base: int  # 底\n\n## Outputs\n- result: int  # 果\n\n## Steps\n1. [call g94(n: base)] 调审批\n  + → result: out_n  # 映射\n`;
    const prov94 = { resolve: async (id: string) => (id === 'g94' ? { spec_id: id, source: CALLEE_G } : null) };
    const host94: HostConfig = { ...HOST, spec_provider: prov94 };
    const engine94 = new ExecutionEngine();
    const init94 = engine94.initExecution(spec94, host94, { params: { base: 7 } });
    expect(init94.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine94, host94);
    const r1 = await dispatcher.runSpec();
    expect(r1.status).toBe('paused');   // callee confirm 停点经 call_path 上浮
    // 误带 child_instance(模拟 0094 调用错)——结构化拒不 throw,run 可恢复
    const r2 = await dispatcher.resume(r1.pause!.step_id, { value: 'approve' }, r1.pause!.call_path, '1.1');
    expect(r2.rejected?.code).toBe('CHILD_NOT_IN_QUEUE');   // @v: anc-exec-parallel-hitl-queue
    expect(r2.rejected?.message).toMatch(/串行 call 停点|去掉 child_instance/);
    // 去掉 child_instance 按 call_path 正路重答 → 续跑到底
    const r3 = await dispatcher.resume(r1.pause!.step_id, { value: 'approve' }, r1.pause!.call_path);
    expect(r3.status).toBe('completed');
    expect(r3.outputs?.['result']).toBe(7);
  });

  it('正例（矩阵15）：嵌套——子实例内层标注退化串行（worker 门关），结果正确不串账', async () => {
    const NESTED = `# Nest
Id: nest

## Goal
嵌套并发

## Inputs
- nums: [int]  # 列表

## Outputs
- total: [int]  # 收集

## Steps
1. [loop for-each n in nums, collect t into total] 外层
  + → total: [int]  # 收集
  1.1. [subtask parallel] 外层派发单元
    + → t: int  # 单项
    1.1.1. [subtask parallel] 内层标注（子实例内退化串行）
      + → t: int  # 结果
      1.1.1.1. [act] 算
        - ← n
        + → t: int  # 结果
        > 纯计算
        > \`\`\`hop_python
        > t = n + 100
        > \`\`\`
2. [exit] 交付
`;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(NESTED, HOST, { params: { nums: [1, 2] } });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, HOST);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['total']).toEqual([101, 102]);
  });
});

// work_zone_path(rel?) 内置——实例 work_zone 涂鸦区路径（2026-08-10 作者定名）。
// 独立模式 MemoryPersistence 首调自建 tmpdir；写工具对 work_zone 绝对路径放行（.hopstate 禁令唯一豁免）。
// @v: anc-exec-work-zone, anc-exec-work-zone-path
describe('work_zone_path 内置函数（独立模式端到端）', () => {
  it('正例：body 内 work_zone_path 写→读闭环，产物真实落盘', async () => {
    const spec = `# WZ
Id: wz
## Goal
g
## Inputs
- draft_text: text  # 草稿
## Outputs
- readback: text  # 回读
## Steps
1. [act] 写草稿到 work_zone 并回读
  - ← draft_text
  + → readback: text  # 回读内容
  > \`\`\`hop_python
  > p = work_zone_path("draft.md")
  > write(path: p, content: draft_text)
  > readback = read(path: p)
  > \`\`\`
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST, { params: { draft_text: 'wz-e2e' } } as any);
    const dispatcher = new StepDispatcher(engine, HOST);
    const handleReady = (dispatcher as any).handleStepReady.bind(dispatcher);
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    if (next.status === 'step_ready') {
      await handleReady(next);
      expect(engine.getStepStates().get('1')).toBe('done');
      expect(engine.getVars().variables['readback']).toBe('wz-e2e');
    }
  });

  it('反例：work_zone_path 禁 .. 穿越；非 work_zone 的绝对路径写仍拒', async () => {
    const spec = `# WZ2
Id: wz2
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [act] 穿越尝试
  + → out: text  # o
  > \`\`\`hop_python
  > p = work_zone_path("../../../etc/hack")
  > out = p
  > \`\`\`
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    const handleReady = (dispatcher as any).handleStepReady.bind(dispatcher);
    const next = engine.nextStep();
    if (next.status === 'step_ready') {
      await handleReady(next);
      expect(engine.getStepStates().get('1')).toBe('failed');   // 穿越被拒 → 步骤 fail
    }
  });
});

// @v: anc-exec-model-resolve —— 凭证级0:显式后端配对不被宿主环境击穿(2026-08-10 实撞:
// CC 宿主 ANTHROPIC_AUTH_TOKEN 被拿去配 StandaloneConfig 选定的 DeepSeek endpoint → 401 错配)
// @v: anc-exec-standalone-invariants —— standalone 整体约束第2条（用户明说的压过环境里碰巧有的）凭证侧正反例
// @v: anc-exec-protocol-adapter
describe('openai 协议集成（HostConfig.protocol 分派）', () => {
  it('正例：protocol=openai 的 HostConfig 走 reason 全链到 completed（chat/completions 通道）', async () => {
    openaiCreateMock.mockResolvedValue({
      id: 'c1', model: 'qwen-max',
      choices: [{ message: { role: 'assistant', content: 'result: 思考完毕' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const host: HostConfig = { ...HOST, protocol: 'openai-chat', base_url: 'https://dashscope.example/compatible-mode/v1' };
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, host);
    const dispatcher = new StepDispatcher(engine, host);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(openaiCreateMock).toHaveBeenCalled();   // 真走了 openai 通道
    expect(r.cumulative_tokens).toBe(15);          // usage 字段名映射生效（prompt+completion→input+output）
  });

  it('反例：protocol=openai + 无 body act 带工具 → PROTOCOL_TOOL_LOOP_UNSUPPORTED（入口 fail-fast 指路，不带病进循环）', async () => {
    const TOOL_SPEC = `# T
Id: tool-act

## Goal
g

## Outputs
- out: text  # o

## Steps
1. [act] 无 body 的动作
  + → out: text  # 结果
  > 用工具查一下
`;
    const host: HostConfig = {
      ...HOST, protocol: 'openai-chat',
      tool_provider: { execute: async () => ({ result: 'x', success: true }), list: () => [{ name: 'search', description: '', input_schema: {}, requires_commit: false }] },
    };
    openaiCreateMock.mockClear();
    const engine = new ExecutionEngine();
    engine.initExecution(TOOL_SPEC, host);
    const dispatcher = new StepDispatcher(engine, host);
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toMatch(/PROTOCOL_TOOL_LOOP_UNSUPPORTED/);
    expect(openaiCreateMock).not.toHaveBeenCalled();   // 入口拦截,零 LLM 调用
  });

  it('正例：{SERVICE_ID}_PROTOCOL env 通道——routing_rules 路由到 openai service 时走适配器（standalone 多 provider 注入面）', async () => {
    openaiCreateMock.mockClear();
    openaiCreateMock.mockResolvedValue({
      id: 'c2', model: 'qwen-max',
      choices: [{ message: { role: 'assistant', content: 'result: ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    process.env['QWENSVC_API_KEY'] = 'k2';
    process.env['QWENSVC_BASE_URL'] = 'https://dashscope.example/compatible-mode/v1';
    process.env['QWENSVC_PROTOCOL'] = 'openai-chat';
    try {
      const host: HostConfig = {
        ...HOST,
        model_engine: { default_service_id: 'qwensvc', default_model: 'qwen-max' },
      };
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, host);
      const dispatcher = new StepDispatcher(engine, host);
      const r = await dispatcher.runSpec();
      expect(r.status).toBe('completed');
      expect(openaiCreateMock).toHaveBeenCalled();   // 路由 service 真走 openai 适配器,非 defaultClient
    } finally {
      delete process.env['QWENSVC_API_KEY']; delete process.env['QWENSVC_BASE_URL']; delete process.env['QWENSVC_PROTOCOL'];
    }
  });

  it('反例：路由到 openai service 的溢出错误按该 client 分类触发降级重组（分类器跟发请求的 client——2026-08-12 review 探针实撞:跟 defaultClient 时跨协议溢出判 other 永不降级）', async () => {
    openaiCreateMock.mockClear();
    const OpenAICtor = (await import('openai')).default as any;
    openaiCreateMock
      .mockRejectedValueOnce(new OpenAICtor.BadRequestError("This model's maximum context length is 8192 tokens"))
      .mockResolvedValue({
        id: 'c3', model: 'qwen-max',
        choices: [{ message: { role: 'assistant', content: 'result: 降级后成功' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
    process.env['QWENSVC_API_KEY'] = 'k3';
    process.env['QWENSVC_PROTOCOL'] = 'openai-chat';
    try {
      const host: HostConfig = {
        ...HOST,   // defaultClient=anthropic——分类器若跟它,openai 溢出错误 instanceof 全不命中
        model_engine: { default_service_id: 'qwensvc', default_model: 'qwen-max' },
      };
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, host);
      const dispatcher = new StepDispatcher(engine, host);
      const r = await dispatcher.runSpec();
      expect(r.status).toBe('completed');            // 溢出被正确分类→reassembleAggressive 降级重试成功
      expect(openaiCreateMock.mock.calls.length).toBe(2);   // 首发溢出+降级重发
    } finally {
      delete process.env['QWENSVC_API_KEY']; delete process.env['QWENSVC_PROTOCOL'];
    }
  });

  it('正例：protocol 缺省（anthropic）行为零变化——既有全量测试即此守卫,此处锁缺省值本身', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    expect((dispatcher as any).defaultClient.protocol).toBe('anthropic');
    expect((dispatcher as any).defaultClient.messages).toBeDefined();   // 直通包装保留 messages 通道
  });
});

describe('resolveCredential 级0:显式 base_url+api_key 配对优先', () => {
  const ENV = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'HOPJIT_ANTHROPIC_API_KEY'] as const;
  function withEnv(vals: Record<string, string | undefined>, fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    for (const [k, v] of Object.entries(vals)) if (v !== undefined) process.env[k] = v;
    try { fn(); } finally {
      for (const k of ENV) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; }
    }
  }

  it('正例:base_url+api_key 成对时,宿主 ANTHROPIC_AUTH_TOKEN 在场也用配对凭证（standalone 不被击穿）', () => {
    withEnv({ ANTHROPIC_AUTH_TOKEN: 'host-token-should-not-be-used' }, () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, {
        ...HOST, api_key: 'paired-deepseek-key', base_url: 'https://api.deepseek.com/anthropic',
      });
      const cred = (dispatcher as any).resolveCredential();
      expect(cred.apiKey).toBe('paired-deepseek-key');
      expect(cred.baseURL).toBe('https://api.deepseek.com/anthropic');
    });
  });

  it('反例:无 base_url（复用模式 buildHostConfig 形态）→ 环境继承照旧优先（级0不外溢）', () => {
    withEnv({ ANTHROPIC_AUTH_TOKEN: 'cc-proxy-token' }, () => {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, { ...HOST, api_key: 'injected-but-unpaired' });
      const cred = (dispatcher as any).resolveCredential();
      expect(cred.apiKey).toBe('cc-proxy-token');   // 环境变量仍是复用模式主路径
    });
  });
});

// @v: anc-exec-model-resolve —— SDK 隐式 env 读取切断（2026-08-10 真机 401 第二层真凶:
// SDK 构造器缺省自读 env.ANTHROPIC_AUTH_TOKEN,且 Bearer 头优先于显式 apiKey 发出）
describe('SDK 隐式 authToken 切断', () => {
  it('正例:宿主 ANTHROPIC_AUTH_TOKEN 在场时,defaultClient 的 authToken 为 null（不被 SDK 隐式捡走）', () => {
    const saved = process.env['ANTHROPIC_AUTH_TOKEN'];
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'host-token-must-not-leak';
    try {
      const engine = new ExecutionEngine();
      engine.initExecution(SIMPLE_SPEC, HOST);
      const dispatcher = new StepDispatcher(engine, {
        ...HOST, api_key: 'paired-key', base_url: 'https://api.deepseek.com/anthropic',
      });
      void dispatcher;
      // SDK 被 vi.mock——断言构造参数（真 SDK 行为由生产验证,此处锁调用面契约:authToken 显式 null）
      const AnthropicMock = (Anthropic as unknown) as ReturnType<typeof vi.fn>;
      const lastCall = AnthropicMock.mock.calls.at(-1)![0];
      expect(lastCall.authToken).toBeNull();                // 隐式通道已断（显式传 null）
      expect(lastCall.apiKey).toBe('paired-key');           // 显式配对生效
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_AUTH_TOKEN'] = saved;
      else delete process.env['ANTHROPIC_AUTH_TOKEN'];
    }
  });
});

// ===== 统一模型 call parallel（渐进派发+收齐）——正反例矩阵行 1/2/4/5/10/11/12/16 =====
// design/parallel-execution.md ^anc-exec-parallel-test-matrix

// @v: anc-exec-gather, anc-exec-parallel-dispatch-model, anc-exec-parallel-inflight, anc-exec-parallel-reap-drain, anc-exec-parallel-kill
// @v: anc-exec-doc-ref-resolve — 子实例 specPath 继承（第九跑实撞:dispatcher 三处子实例 init
// 漏传 specPath,子 specDir 缺席致 doc-ref 校验只剩 workspace 根基准——anchor-audit 的知识文档
// 住 spec 同目录,11 个语义批 init 全灭,父实例好的子实例全找不到）
describe('parallel 子实例 doc-ref specPath 继承', () => {
  it('正例：spec 引用同目录知识文档,parallel 子实例 init 不再"文件未找到"（specPath 随父传）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'docref-inherit-'));
    // 知识文档放 spec 同目录=workspace 的子目录 specs/（anchor-audit 实撞同构:知识文档住
    // scripts/audit/ 而非 workspace 根——workspace 根基准找不到,只有 spec 目录基准找得到）
    mkdirSync(join(dir, 'specs'));
    writeFileSync(join(dir, 'specs', 'know.md'), '# 知识\n\n## 判据\n\n判据正文。\n');
    const SPEC = `# P
Id: docref-inherit
## Inputs
- items: [line]  # 列表
## Goal
g
## Outputs
- outs: [text]  # 收集
## Steps
1. [loop for-each it in items, collect r into outs] 逐个
  + → outs: [text]  # 收集
  1.1. [subtask parallel] 单批
    - ← it
    + → r: text  # 产出
    1.1.1. [reason] 判
      - ← it
      + → r: text  # 产出
      > 按 [[know#判据]] 判定。
`;
    const HOST = { workspace_dir: dir, sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: 'k' } as any;
    const engine = new ExecutionEngine();
    const specPath = join(dir, 'specs', 'p.md');
    writeFileSync(specPath, SPEC);
    const init = engine.initExecution(SPEC, HOST, { params: { items: ['a'] }, specPath });
    expect(init.status).toBe('ok');   // 父实例本就好（specPath 直传）
    // 子实例 worker 新建 Anthropic 实例——配全局 SDK mock 使子实例 LLM 轮真跑通,
    // 修前形态=init 即死 doc-ref 文件未找到,collect 空;修后=全链 completed 且 outs 有元素
    const sharedCreate = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'r: 判过' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const origImpl = (Anthropic as any).getMockImplementation();
    (Anthropic as any).mockImplementation(() => ({ messages: { create: sharedCreate } }));
    try {
      const d = new StepDispatcher(engine, HOST);
      const result = await d.runSpec();
      expect(result.status).toBe('completed');
      expect((result as any).outputs.outs).toEqual(['判过']);
    } finally {
      (Anthropic as any).mockImplementation(origImpl);
    }
  });

  it('正例：call parallel 子实例继承 callee 自己的 specDir（callee 引用同目录知识文档,init 不死"文件未找到"——dv-batch 实撞形态:27c78b33 只给 711 路补了钉,819 路〔launchParallelCallChild〕零测试保护）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'docref-callpar-'));
    // 复刻实撞目录形态：parent/callee/knowledge 三件同住 workspace 的子目录（scripts/deep-validate 同构）——
    // workspace 根基准找不到 knowledge,只有 callee 的 specDir 基准找得到（fixture 放根=两级都命中,变异照绿假钉）
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'know2.md'), '# 知识\n\n## 判据\n\n判据正文。\n');
    writeFileSync(join(dir, 'sub', 'kid.md'), `# K
Id: kid
## Inputs
- x: line  # 入参
## Goal
g
## Outputs
- y: text  # 出参
## Steps
1. [reason] 判
  - ← x
  + → y: text  # 结果
  > 按 [[know2#判据]] 判定。
`);
    const PARENT = `# P2
Id: docref-callpar
## Inputs
- items: [line]  # 列表
## Goal
g
## Outputs
- outs: [text]  # 收集
## Steps
1. [loop for-each it in items, collect y into outs] 逐个
  + → outs: [text]  # 收集
  1.1. [call kid(x: it) parallel] 单个
    + → y: y  # 收取
`;
    const parentPath = join(dir, 'sub', 'p2.md');
    writeFileSync(parentPath, PARENT);
    const HOST = { workspace_dir: dir, sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } }, api_key: 'k', spec_provider: new DirSpecProvider(join(dir, 'sub')) } as any;
    const engine = new ExecutionEngine();
    const init = engine.initExecution(PARENT, HOST, { params: { items: ['a'] }, specPath: parentPath });
    expect(init.status).toBe('ok');
    const sharedCreate = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'y: 判过' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const origImpl = (Anthropic as any).getMockImplementation();
    (Anthropic as any).mockImplementation(() => ({ messages: { create: sharedCreate } }));
    try {
      const d = new StepDispatcher(engine, HOST);
      const result = await d.runSpec();
      // 修前形态（819 路漏传 specPath 的旧 dist）＝子实例 init 全灭"文件未找到",collect 空列表主线照 completed;
      // 现行代码=真跑通,outs 有元素——本钉锁住 819 路的 specPath 继承不回退
      expect(result.status).toBe('completed');
      expect((result as any).outputs.outs).toEqual(['判过']);
    } finally {
      (Anthropic as any).mockImplementation(origImpl);
    }
  });
});

// @v: anc-exec-parallel-fanout-concurrency —— 并发窗口/名额语义的现行覆盖组（0086 语义审计挂标）：
// 矩阵2 三钉直测名额窗口（在飞数≤max_concurrent-1 主线占一路/配 1 全串行退化/窗口全程不超额）。
// 说明：设计 §10g 的"dispatched 原子标记防重"表述针对已退役的 fanout-plan/fanout-next CLI 顾问
// 通道（P0.5 删）,现行防重权威=inflight 账（派发即入账落盘,幂等守卫见 dispatchParallelSubtask/Call）,
// 其直钉在 engine.test.ts 'fan-out 派发账落盘复原+防重派发' 组。
describe('统一模型 call parallel（独立模式 P0）', () => {
  // callee：纯计算，翻倍 + 可注入延迟观察并发（用忙等模拟耗时——act body 无 sleep，用循环拖时长不可行，
  // 改用 slow_tool 工具注入真实异步延迟）
  const CALLEE_BUILD = `# Build
Id: build

## Goal
构建一章

## Inputs
- src: int  # 素材

## Outputs
- built: int  # 构建产物

## Steps
1. [act] 构建
  - ← src
  + → built: int  # 产物
  > 纯计算
  > \`\`\`hop_python
  > built = src * 10
  > \`\`\`
`;

  const CALLEE_FLAKY = `# Flaky
Id: flaky

## Goal
双数失败

## Inputs
- src: int  # 素材

## Outputs
- built: int  # 产物

## Steps
1. [act] 构建（src ≠ 3 时计算异常失败——数字取下标）
  - ← src
  + → built: int  # 产物
  > \`\`\`hop_python
  > if src == 3:
  >     built = src * 10
  > else:
  >     built = src[0]
  > \`\`\`
`;

  // 流水线 caller：串行生产（+1）→ call parallel 派发构建（×10）→ 循环外消费
  const PIPELINE = `# Pipeline
Id: pipeline

## Goal
流水线构建

## Inputs
- chapters: [int]  # 章列表

## Outputs
- results: [int]  # 构建产物列表

## Steps
1. [loop for-each ch in chapters, collect built into results] 逐章
  + → results: [int]  # 产物列表
  1.1. [act] 生产
    - ← ch
    + → confirmed: int  # 确认稿
    > \`\`\`hop_python
    > confirmed = ch + 1
    > \`\`\`
  1.2. [call build(src: confirmed) parallel] 派发构建
    + → built  # 单项端（同名收取 callee 输出）
2. [exit] 交付
`;

  function inMemoryProvider(specs: Record<string, string>) {
    return { resolve: async (id: string) => (id in specs ? { spec_id: id, source: specs[id] } : null) };
  }

  function setup(callerSpec: string, host: HostConfig, params: Record<string, unknown>) {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(callerSpec, host, { params });
    expect(init.status).toBe('ok');
    return { engine, dispatcher: new StepDispatcher(engine, host) };
  }

  it('正例（矩阵1/4/5）：渐进派发+收齐——列表按派发序、全量收好才完成', async () => {
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ build: CALLEE_BUILD }) };
    const { engine, dispatcher } = setup(PIPELINE, host, { chapters: [1, 2, 3, 4] });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    // (ch+1)*10 按派发序：[20,30,40,50]
    expect(r.outputs?.['results']).toEqual([20, 30, 40, 50]);
    // 收齐后账面无在飞（幻影反例：完成时仍有 inflight）
    expect(engine.getInflight().filter(f => f.status === 'inflight')).toHaveLength(0);
  });

  it('正例（矩阵2/16）：配 1 全串行退化——结果与并发跑语义等价', async () => {
    const host: HostConfig = {
      ...HOST,
      spec_provider: inMemoryProvider({ build: CALLEE_BUILD }),
      resource_limits: { max_concurrent_workers: 1 },
    };
    const { engine, dispatcher } = setup(PIPELINE, host, { chapters: [1, 2, 3] });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['results']).toEqual([20, 30, 40]);
    // 反例断言：配 1 时名额全归主线，从未有过在飞记账（同步退化路径）
    expect(engine.getInflight()).toHaveLength(0);
  });

  it('正例（矩阵2）：名额窗口——在飞数不超过 max_concurrent-1（主线占一路）', async () => {
    const host: HostConfig = {
      ...HOST,
      spec_provider: inMemoryProvider({ build: CALLEE_BUILD }),
      resource_limits: { max_concurrent_workers: 3 },
    };
    const { engine, dispatcher } = setup(PIPELINE, host, { chapters: [1, 2, 3, 4, 5, 6] });
    // 监听派发事件：每次派发后在飞数 ≤ 2
    const origDispatch = engine.dispatchParallelCall.bind(engine);
    let maxSeen = 0;
    vi.spyOn(engine, 'dispatchParallelCall').mockImplementation((id: string) => {
      const out = origDispatch(id);
      maxSeen = Math.max(maxSeen, engine.getInflight().filter(f => f.status === 'inflight').length);
      return out;
    });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(maxSeen).toBeLessThanOrEqual(2);
    expect((r.outputs?.['results'] as unknown[]).length).toBe(6);
  });

  it('正例（矩阵12）：部分失败集合语义——单活 fail 不拖垮主线，列表变短', async () => {
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ flaky: CALLEE_FLAKY }) };
    const spec = PIPELINE.replace('build(src: confirmed)', 'flaky(src: confirmed)');
    // chapters [1,2,3] → confirmed [2,3,4] → 仅 src=3 成功 → [30]
    const { dispatcher } = setup(spec, host, { chapters: [1, 2, 3] });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['results']).toEqual([30]);
  });

  it('正例（矩阵10）：主线失败杀活——在飞全 killed、实例 fail、killed 不产出', async () => {
    // callee 走慢工具（50ms），保证主线第 3 轮失败时前两轮的活仍在飞
    const CALLEE_SLOW = `# Slow
Id: slow

## Goal
慢构建

## Inputs
- src: int  # 素材

## Outputs
- built: int  # 产物

## Steps
1. [act] 慢工具构建
  - ← src
  + → built: int  # 产物
  > \`\`\`hop_python
  > built = slow_echo(v: src)
  > \`\`\`
`;
    const FAIL_MAIN = PIPELINE
      .replace('build(src: confirmed)', 'slow(src: confirmed)')
      .replace(
        '    > confirmed = ch + 1',
        '    > if ch == 3:\n    >     confirmed = ch[9]\n    > else:\n    >     confirmed = ch + 1',   // ch=3 计算异常 → 主线 fail
      );
    const host: HostConfig = {
      ...HOST,
      spec_provider: inMemoryProvider({ slow: CALLEE_SLOW }),
      tool_provider: {
        list: () => [{ name: 'slow_echo', description: 'slow echo', parameters: {} }],
        execute: async (_name: string, args: Record<string, unknown>) => {
          await new Promise(res => setTimeout(res, 50));
          return { result: JSON.stringify((args['v'] as number) * 10), content_type: 'json' as const, success: true };
        },
      },
    };
    const { engine, dispatcher } = setup(FAIL_MAIN, host, { chapters: [1, 2, 3] });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('failed');
    const inflight = engine.getInflight();
    // 在飞的活全部 killed（不留幻影），账面无 inflight 残留
    expect(inflight.filter(f => f.status === 'inflight')).toHaveLength(0);
    expect(inflight.filter(f => f.status === 'killed').length).toBeGreaterThan(0);
    // killed 不产出：收集列表不含被杀活的值（失败前已收割的部分产出合法保留——fail 不碰值空间）
    const results = (engine.getVars().variables['results'] as unknown[] | undefined) ?? [];
    expect(results).not.toContain(20);
    expect(results).not.toContain(30);
    // killed 不复活：账面终态即便苟活结果到达也被 reap 丢弃（reapParallelCall killed 短路）
    for (const k of inflight.filter(f => f.status === 'killed')) {
      engine.reapParallelCall(k.child_instance, { vars: { built: 999 } });
    }
    expect(((engine.getVars().variables['results'] as unknown[] | undefined) ?? [])).not.toContain(999);
  });

  it('正例（矩阵11）：break 正常路径——不杀活、照常收齐、列表=已派发部分', async () => {
    const BREAK_SPEC = `# BreakPipe
Id: break-pipe

## Goal
第二轮后 break

## Inputs
- chapters: [int]  # 章列表

## Outputs
- results: [int]  # 产物

## Steps
1. [loop for-each ch in chapters, collect built into results] 逐章
  + → results: [int]  # 产物列表
  1.1. [call build(src: ch) parallel] 派发
    + → built  # 单项端（同名收取）
  1.2. [branch] 到 2 停
    + → none
    1.2.1. [case(ch == 2)] 停
      1.2.1.1. [break]
    1.2.2. [case(else)] 继续
      1.2.2.1. [continue]
2. [exit] 交付
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ build: CALLEE_BUILD }) };
    const { engine, dispatcher } = setup(BREAK_SPEC, host, { chapters: [1, 2, 3, 4] });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    // break 前派发了 ch=1、ch=2 两个活：结果 [10,20]（不杀、等完收好；ch=3/4 未派发）
    expect(r.outputs?.['results']).toEqual([10, 20]);
    expect(engine.getInflight().filter(f => f.status === 'killed')).toHaveLength(0);
  });

  it('正例（U4b HITL 队列,0013）：call 子实例内 confirm → 入队 paused,应答 approve 续跑收齐', async () => {
    const CALLEE_ASK = `# Gated
Id: gated

## Goal
带审批

## Inputs
- src: int  # 素材

## Outputs
- built: int  # 产物

## Steps
1. [confirm require_human=true] 审批
  - ← src
  + → ok: bool  # 审批槽
2. [act] 透传
  - ← src
  + → built: int  # 产物
  > \`\`\`hop_python
  > built = src
  > \`\`\`
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ gated: CALLEE_ASK }) };
    const spec = PIPELINE.replace('build(src: confirmed)', 'gated(src: confirmed)');
    const { engine, dispatcher } = setup(spec, host, { chapters: [1] });
    const r = await dispatcher.runSpec();
    // U4b:子实例 paused 入队,主线只剩等人 → run 级 paused（不再判 failed 丢元素）
    expect(r.status).toBe('paused');
    const child = r.pause?.child_instance;
    expect(child).toBeDefined();
    // 应答 approve → 子实例过 confirm 续跑 → 收割 → 主线收齐 completed,元素不丢
    const r2 = await dispatcher.resume(r.pause!.step_id, { ok: 'approve' }, undefined, child);
    expect(r2.status).toBe('completed');
    expect(r2.outputs?.['results']).toEqual([2]);   // gated 透传 built=src=ch+1=2——元素不丢是断言主体
  });

  // @v: anc-exec-parallel-hitl-queue （0013 兑现:35 轮临时清卡已撤——paused 子实例卡保留即入队,
  // 文件级消费方可读;应答续跑到终态后子实例目录随收割不再有活卡）
  it('正例（文件态,U4b）：子实例 confirm 暂停时卡保留在盘;应答续跑后 run completed', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'disp-card-'));
    const CALLEE_GATED = `# Gated
Id: gated

## Goal
带审批

## Inputs
- src: int  # 素材

## Outputs
- built: int  # 产物

## Steps
1. [confirm require_human=true] 审批
  - ← src
  + → ok: bool  # 审批槽
2. [act] 透传
  - ← src
  + → built: int  # 产物
  > \`\`\`hop_python
  > built = src
  > \`\`\`
`;
    const host: HostConfig = { ...HOST, spec_provider: inMemoryProvider({ gated: CALLEE_GATED }) };
    const spec = PIPELINE.replace('build(src: confirmed)', 'gated(src: confirmed)');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(spec, host, { params: { chapters: [1] }, stateDir });
    expect(init.status).toBe('ok');
    const dispatcher = new StepDispatcher(engine, host);
    const r = await dispatcher.runSpec();
    // U4b:暂停即 run 级 paused,子实例卡保留（0028 一等实物——文件级消费方可读）
    expect(r.status).toBe('paused');
    const child = r.pause!.child_instance!;
    // 注:worker 子引擎是内存实例（不传 stateDir）,盘上卡只在文件态子实例出现——本例父实例
    // 文件态但 worker 内存态,卡的权威是内存队列;文件态断言只核"没有被误删的残卡"。
    const r2 = await dispatcher.resume(r.pause!.step_id, { ok: 'approve' }, undefined, child);
    expect(r2.status).toBe('completed');
    expect(dispatcher.getPausedChildren().size).toBe(0);
  });
});

// ===== P1 crash-resume 在飞重建（独立模式，矩阵行 14）=====
// @v: anc-exec-parallel-inflight-reconcile
describe('P1 crash-resume 在飞重建（独立模式 resumeSpec 对账）', () => {
  it('正例：文件态实例重载后 resumeSpec——已终态在飞被补收割，run 直达 completed', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'disp-rec-'));
    const SPEC = `# Rec
Id: rec

## Goal
恢复

## Inputs
- nums: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in nums, collect o into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [subtask parallel] 处理
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > \`\`\`hop_python
      > o = n + 100
      > \`\`\`
2. [exit] 交付
`;
    // 第一"进程"：正常跑完（子实例状态与账面全落盘）
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(SPEC, HOST, { stateDir, params: { nums: [1, 2] } });
    expect(init.status).toBe('ok');
    const d1 = new StepDispatcher(e1, HOST);
    const r1 = await d1.runSpec();
    expect(r1.status).toBe('completed');
    const instDir = join(stateDir, e1.getInstanceId());
    // 第二"进程"：load 重建 + resumeSpec——对账应为空转（全已收割），终态幂等
    const e2 = ExecutionEngine.load(instDir);
    const d2 = new StepDispatcher(e2, HOST);
    const r2 = await d2.resumeSpec();
    expect(r2.status).toBe('completed');
    expect((r2.outputs?.['outs'] as number[])).toEqual([101, 102]);
    // 反例断言：对账不复活已收割项（inflight 空）
    expect(e2.getInflight().filter(f => f.status === 'inflight')).toHaveLength(0);
  });

  it('反例：killed 项对账不复活（账面终态恒定）', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'disp-rec-kill-'));
    const SPEC = `# RecK
Id: rec-k

## Goal
g

## Inputs
- nums: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in nums, collect o into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [subtask parallel] 处理
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > \`\`\`hop_python
      > o = n
      > \`\`\`
2. [exit] 交付
`;
    const e1 = new ExecutionEngine();
    e1.initExecution(SPEC, HOST, { stateDir, params: { nums: [9] } });
    e1.setUnifiedDispatch(true);
    const next = e1.nextStep();
    expect(next.status).toBe('dispatch_ready');
    // 主线失败杀活（子实例未跑）
    e1.killInflight();
    const instDir = join(stateDir, e1.getInstanceId());
    const e2 = ExecutionEngine.load(instDir);
    const { reaped, stale } = e2.reconcileInflight();
    // killed 不在对账范围（status!=inflight）——零补收零重建
    expect(reaped).toEqual([]);
    expect(stale).toEqual([]);
    expect(e2.getInflight().filter(f => f.status === 'killed')).toHaveLength(1);
  });
});

// ===== P1 单活超时 + 协作式杀活中断 =====
// @v: anc-exec-parallel-timeout, anc-exec-parallel-abort
describe('P1 单活超时腾名额（惰性活性检测）', () => {
  it('正例：超时项被判 failed 收割腾名额（FailRecord 注明 timeout）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'disp-to-'));
    const SPEC = `# TO
Id: to

## Goal
g

## Inputs
- nums: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in nums, collect o into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [subtask parallel] 处理
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > \`\`\`hop_python
      > o = n
      > \`\`\`
2. [exit] 交付
`;
    const host = { ...HOST, resource_limits: { parallel_child_timeout_seconds: 60 } } as HostConfig;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host, { stateDir, params: { nums: [1] } });
    engine.setUnifiedDispatch(true);
    const next = engine.nextStep();
    expect(next.status).toBe('dispatch_ready');
    // 手工把账面 dispatched_at 拨旧 120s（模拟卡死两分钟）
    const entry = engine.getInflight()[0] as any;
    entry.dispatched_at = new Date(Date.now() - 120_000).toISOString();
    const swept = engine.sweepTimedOutInflight();
    expect(swept).toEqual(['1.1.1']);
    expect(engine.getInflight().filter(f => f.status === 'inflight')).toHaveLength(0);
    // 失败收割不贡献元素——本例 1/1 超时即全灭,按新语义(2026-09-06 ^anc-exec-parallel-allfail)
    // 宿主 fail 上浮实例 failed;超时收割腾名额的本职断言(swept/inflight 清零)在上方不变
    const after = engine.nextStep();
    expect(after.status).toBe('failed');
    if (after.status === 'failed') expect(after.failure_reason ?? '').toContain('PARALLEL_ALL_FAILED');
  });

  it('正例：启动窗口让位——timeout<grace 且目录未建 → 不判超时（§U3 让位条款,2026-08-11 review 探针抓漏）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'disp-tograce-'));
    const SPEC = `# TG
Id: tg

## Goal
g

## Inputs
- nums: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in nums, collect o into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [subtask parallel] 处理
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > \`\`\`hop_python
      > o = n
      > \`\`\`
2. [exit] 交付
`;
    const host = { ...HOST, resource_limits: { parallel_child_timeout_seconds: 30 } } as HostConfig;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host, { stateDir, params: { nums: [1] } });
    engine.setUnifiedDispatch(true);
    engine.nextStep();   // 派发入账，worker 未起（目录未建）
    const entry = engine.getInflight()[0] as any;
    // 账龄 45s：> timeout(30) 但 ≤ grace(60)，目录未建=启动中——不判超时
    entry.dispatched_at = new Date(Date.now() - 45_000).toISOString();
    expect(engine.sweepTimedOutInflight()).toEqual([]);
    expect(engine.getInflight().filter(f => f.status === 'inflight')).toHaveLength(1);
  });

  it('反例：让位仅限目录未建——目录已建的活照常按账龄判超时（宽限期不豁免真卡死）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'disp-tobuilt-'));
    const SPEC = `# TB
Id: tb

## Goal
g

## Inputs
- nums: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in nums, collect o into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [subtask parallel] 处理
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > \`\`\`hop_python
      > o = n
      > \`\`\`
2. [exit] 交付
`;
    const host = { ...HOST, resource_limits: { parallel_child_timeout_seconds: 30 } } as HostConfig;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host, { stateDir, params: { nums: [1] } });
    engine.setUnifiedDispatch(true);
    engine.nextStep();
    const entry = engine.getInflight()[0] as any;
    // 目录建起来（模拟 worker 已启动但卡死）：写一份最小 state.json
    const realChildDir = join(engine.getInstanceDir()!, 'parallel', entry.child_instance);
    mkdirSync(realChildDir, { recursive: true });
    writeFileSync(join(realChildDir, 'state.json'), JSON.stringify({ format_version: 1, instance_id: entry.child_instance, spec_id: 'tb', step_states: { '1.1.1': 'running' } }));
    entry.dispatched_at = new Date(Date.now() - 45_000).toISOString();   // 同样 45s,但目录已建
    expect(engine.sweepTimedOutInflight()).toEqual([entry.child_instance]);
  });

  it('反例：未配置超时 → 永不超时（缺省关闭零行为变化）', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'disp-noto-'));
    const SPEC = `# NoTO
Id: noto

## Goal
g

## Inputs
- nums: [int]  # 列表

## Outputs
- outs: [int]  # 收集

## Steps
1. [loop for-each n in nums, collect o into outs] 逐项
  + → outs: [int]  # 收集
  1.1. [subtask parallel] 处理
    + → o: int  # 单项
    1.1.1. [act] 算
      - ← n
      + → o: int  # 结果
      > \`\`\`hop_python
      > o = n
      > \`\`\`
2. [exit] 交付
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, HOST, { stateDir, params: { nums: [1] } });
    engine.setUnifiedDispatch(true);
    engine.nextStep();
    const entry = engine.getInflight()[0] as any;
    entry.dispatched_at = new Date(Date.now() - 3600_000).toISOString();   // 一小时前
    expect(engine.sweepTimedOutInflight()).toEqual([]);   // 未配置——不收割
    expect(engine.getInflight().filter(f => f.status === 'inflight')).toHaveLength(1);
  });
});

describe('P1 协作式杀活中断（abort 标志步间检查）', () => {
  it('正例：requestAbort 后 executionLoop 步间返回 failed(aborted)，不再执行后续步骤', async () => {
    const SPEC = `# Ab
Id: ab

## Goal
g

## Outputs
- x: int  # 结果

## Steps
1. [act] 一步
  + → x: int  # 结果
  > \`\`\`hop_python
  > x = 1
  > \`\`\`
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, HOST, {});
    const d = new StepDispatcher(engine, HOST);
    d.requestAbort();   // 启动前置位（模拟父杀活先于子首步）
    const r = await d.runSpec();
    expect(r.status).toBe('failed');
    expect(r.failure?.reason).toContain('aborted');
    // 反例断言：步骤未被执行（x 未落值）
    expect(engine.getVars().variables['x'] ?? null).toBeNull();
  });
});

// review 补：abort 反例（未置位零影响）—— // @v: anc-exec-parallel-abort
describe('P1 abort 反例', () => {
  it('反例：未 requestAbort 的正常执行零影响（abort 检查点不误伤）', async () => {
    const SPEC = `# NoAb
Id: no-ab

## Goal
g

## Outputs
- x: int  # 结果

## Steps
1. [act] 一步
  + → x: int  # 结果
  > \`\`\`hop_python
  > x = 7
  > \`\`\`
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, HOST, {});
    const r = await new StepDispatcher(engine, HOST).runSpec();
    expect(r.status).toBe('completed');
    expect(r.outputs?.['x']).toBe(7);
  });
});

// @v: anc-exec-model-resolve, anc-exec-model-routing —— 两层配置逐类别继承+replan 独立档（2026-08-13 作者定形:
// spec 层缺省逐类别继承系统层;replan=元编程档须会 HopSpec 的模型,原借 reason 档）
describe('分级模型路由（两层逐类别继承）', () => {
  const RSPEC = `# R
Id: r

## Goal
g

## Steps
1. [reason] 想
  + → out: text  # o
  > t
`;
  function mkDispatcher(specMd: string, modelEngine?: object) {
    const engine = new ExecutionEngine();
    engine.initExecution(specMd, HOST);
    const host = { ...HOST, ...(modelEngine ? { model_engine: modelEngine } : {}) } as HostConfig;
    return new StepDispatcher(engine, host);
  }
  const SYS = {
    default_service_id: 'default', default_model: 'sys-default',
    routing_rules: [
      { match: { step_type: 'act' }, service_id: 'default', model: 'sys-flash' },
      { match: { step_type: 'reason' }, service_id: 'default', model: 'sys-pro' },
      { match: { step_type: 'replan' }, service_id: 'default', model: 'sys-opus' },
    ],
  };

  it('正例：spec 未配 → 逐类别继承系统层（act/reason/replan 各得其档,commit 无专条吃 act 档）', () => {
    const d = mkDispatcher(RSPEC, SYS);
    expect(d.resolveModel('act').model).toBe('sys-flash');
    expect(d.resolveModel('reason').model).toBe('sys-pro');
    expect(d.resolveModel('replan').model).toBe('sys-opus');
    expect(d.resolveModel('commit').model).toBe('sys-flash');   // 执行类共档回退
    expect(d.resolveModel('check').model).toBe('sys-default');  // 系统层无 check 条 → 默认
  });

  it('正例：spec Config.models 只写 replan 一键 → 该键覆盖,其余类别照常继承系统层（逐键继承非整块覆盖）', () => {
    const SPEC = `# R
Id: r
Config:
  models:
    replan: spec-opus

## Goal
g

## Steps
1. [reason] 想
  + → out: text  # o
  > t
`;
    const d = mkDispatcher(SPEC, SYS);
    expect(d.resolveModel('replan').model).toBe('spec-opus');   // spec 键赢
    expect(d.resolveModel('reason').model).toBe('sys-pro');     // 未写的键继承系统层
    expect(d.resolveModel('act').model).toBe('sys-flash');
  });

  it('正例：spec Config.model 单默认=全类别简写,类别键比它 specific', () => {
    const SPEC = `# R
Id: r
Config:
  model: spec-single
  models:
    act: spec-flash

## Goal
g

## Steps
1. [reason] 想
  + → out: text  # o
  > t
`;
    const d = mkDispatcher(SPEC, SYS);
    expect(d.resolveModel('act').model).toBe('spec-flash');     // 类别键 > 单默认
    expect(d.resolveModel('reason').model).toBe('spec-single'); // 单默认 > 系统层
  });

  it('反例：spec models 值非字符串 → 忽略该键落下一级（不静默把垃圾当模型名）', () => {
    const SPEC = `# R
Id: r
Config:
  models:
    reason: 42

## Goal
g

## Steps
1. [reason] 想
  + → out: text  # o
  > t
`;
    const d = mkDispatcher(SPEC, SYS);
    expect(d.resolveModel('reason').model).toBe('sys-pro');     // 非法值跳过,继承系统层
  });

  it('正例：spec models 显式 commit 键 → commit 与 act 分档（执行类共档仅在无专条时）', () => {
    const SPEC = `# R
Id: r
Config:
  models:
    act: spec-flash
    commit: spec-commit

## Goal
g

## Steps
1. [reason] 想
  + → out: text  # o
  > t
`;
    const d = mkDispatcher(SPEC, SYS);
    expect(d.resolveModel('commit').model).toBe('spec-commit'); // 专条赢
    expect(d.resolveModel('act').model).toBe('spec-flash');
  });

  // 生产调用点类别忠实（2026-08-17 0003:executeActWithTools 曾硬编码 'act'——commit 步
  // Config.models.commit/routing_rules[commit] 永不生效静默降配;本组测试穿过生产调用点
  // 喂假 LLM 断言实际请求的 model,直调 resolveModel 只测解析测不出接线死路——测在死路径上的教训）
  // @v: anc-exec-model-resolve


  it('正例：系统层全缺席时 ANTHROPIC_MODEL 环境级兜底（链第 6 级——CC 宿主继承）', () => {
    process.env['ANTHROPIC_MODEL'] = 'env-model';
    try {
      const d = mkDispatcher(RSPEC);   // 无 model_engine,无 spec Config
      expect(d.resolveModel('reason')).toEqual({ service_id: 'default', model: 'env-model' });
    } finally { delete process.env['ANTHROPIC_MODEL']; }
  });
});

// @v: anc-exec-model-resolve —— spec 面软偏好（作者定 2026-08-13"有这个模型就用,否则用缺省"——
// Constraints 同哲学:spec 分发面对环境零控制权,service 缺席是环境差异非笔误;系统面维持硬校验）
describe('spec 面模型引用软偏好', () => {
  const SYS2 = {
    default_service_id: 'default', default_model: 'sys-default',
    routing_rules: [{ match: { step_type: 'replan' }, service_id: 'default', model: 'sys-opus' }],
  };
  function mk(specMd: string) {
    const engine = new ExecutionEngine();
    engine.initExecution(specMd, HOST);
    return new StepDispatcher(engine, { ...HOST, model_engine: SYS2 } as HostConfig);
  }

  it('正例：偏好 service 在场（clients 池/env key 任一通道）→ 用偏好', () => {
    const SPEC = `# R
Id: r

Config:
- models:
  - replan: envsvc/strong-model

## Goal
g

## Steps
1. [reason] 想
  + → out: text  # o
  > t
`;
    process.env['ENVSVC_API_KEY'] = 'k';
    try {
      const d = mk(SPEC);
      expect(d.resolveModel('replan')).toEqual({ service_id: 'envsvc', model: 'strong-model' });
    } finally { delete process.env['ENVSVC_API_KEY']; }
  });

  it('反例：偏好 service 缺席 → 落下一级（系统分档）+ warn 留痕不炸——spec 可移植的判据', () => {
    const SPEC = `# R
Id: r

Config:
- models:
  - replan: ghostsvc/strong-model

## Goal
g

## Steps
1. [reason] 想
  + → out: text  # o
  > t
`;
    const d = mk(SPEC);
    expect(d.resolveModel('replan')).toEqual({ service_id: 'default', model: 'sys-opus' });   // 落系统分档
    const warns = (d as unknown as { pendingToolWarns: string[] }).pendingToolWarns;
    expect(warns.some(w => w.includes('ghostsvc') && w.includes('落下一级'))).toBe(true);      // 留痕
    d.resolveModel('replan');
    expect(warns.filter(w => w.includes('ghostsvc')).length).toBe(1);                          // 去重不刷屏
  });

  it('反例：偏好引用格式非法 → 同缺席落级不炸（分发面的坏引用按偏好未满足处理）', () => {
    const SPEC = `# R
Id: r

Config:
- model: "/bad-ref"

## Goal
g

## Steps
1. [reason] 想
  + → out: text  # o
  > t
`;
    const d = mk(SPEC);
    expect(d.resolveModel('reason').model).toBe('sys-default');
  });

  it('对照：系统面 routing_rules 引用维持硬校验（加载期启动即拒——分界不糊,mcp-server.test 文法反例为准）', () => {
    // 本例只锚分界事实：resolveModel 对系统面引用不做在场性核（信任加载期校验）——
    // 系统规则命中即返回,无 warn。
    const SPEC = `# R
Id: r

## Goal
g

## Steps
1. [reason] 想
  + → out: text  # o
  > t
`;
    const d = mk(SPEC);
    expect(d.resolveModel('replan').model).toBe('sys-opus');
    expect((d as unknown as { pendingToolWarns: string[] }).pendingToolWarns).toHaveLength(0);
  });

  it('反例回归：reason 步（无工具循环路径）的落级 warn 必须落 HopLog——不许悬在内存被丢（真机实撞 2026-08-13）', async () => {
    const SPEC = `# R
Id: r

Config:
- models:
  - reason: ghostsvc/super-model

## Goal
g

## Steps
1. [reason] 想
  + → out: text  # o
  > t
`;
    const engine = new ExecutionEngine();
    const tmpDir = mkdtempSync(join(tmpdir(), 'hoptest-warnflush-'));
    const host = { ...HOST, model_engine: SYS2 } as HostConfig;
    engine.initExecution(SPEC, host, { logDir: tmpDir });
    const dispatcher = new StepDispatcher(engine, host);
    ((dispatcher as any).defaultClient.messages.create as any).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'out: 好' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const step = engine.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status === 'step_ready') {
      await (dispatcher as any).executeReasonOrCheck(step);
    }
    const yaml = readFileSync(engine.getHopLog()!.getFilePath(), 'utf-8');
    expect(yaml).toContain('ghostsvc');                                                        // warn 已随步落盘
    expect((dispatcher as unknown as { pendingToolWarns: string[] }).pendingToolWarns).toHaveLength(0);  // 暂存清空
  });
});


// ── run 隔离不变量：dispatcher 侧承诺钉（ARCHITECTURE ^anc-run-isolation——review 补:
// 崩溃/串台回归钉的是 server 面,dispatcher 自身三承诺此前零直接测试）──
// @v: anc-run-isolation
describe('run 隔离：dispatcher 侧承诺', () => {
  const ISO_SPEC = `# I
Id: i

## Goal
g

## Outputs
- r: text  # o

## Steps
1. [subtask] 边界
  + → r: text
  1.1. [subtask parallel] 活
    + → r: text
    1.1.1. [act] 算
      + → r: text  # v
      > t
      > \`\`\`hop_python
      > r = 'ok'
      > \`\`\`
2. [exit]
`;

  it('池尾终极 catch：收割自身炸（reap 被 mock 抛）→ 不产生 unhandledRejection,warn 落 HopLog', async () => {
    const engine = new ExecutionEngine();
    const tmpDir = mkdtempSync(join(tmpdir(), 'iso-pool-'));
    engine.initExecution(ISO_SPEC, HOST, { logDir: tmpDir });
    const dispatcher = new StepDispatcher(engine, HOST);
    // 收割链炸穿内层 catch 的等价形态：completed 分支 reap 抛
    (engine as unknown as { reapParallelSubtask: () => void }).reapParallelSubtask = () => {
      throw new Error('收割链炸（隔离钉）');
    };
    const unhandled: unknown[] = [];
    const onUR = (r: unknown) => { unhandled.push(r); };
    process.on('unhandledRejection', onUR);
    try {
      const r = await dispatcher.runSpec();
      // drain 等待的池 promise 已被池尾 catch 收敛——runSpec 自身可能因收割缺失走超时/失败路径,
      // 隔离钉的是"无未处理拒绝泄出"
      await new Promise(res => setTimeout(res, 50));
      expect(unhandled).toHaveLength(0);
      expect(['completed', 'failed', 'paused']).toContain(r.status);
      const logDirs = readdirSync(tmpDir);
      const yaml = readFileSync(join(tmpDir, logDirs[0], 'main.yaml'), 'utf-8');
      expect(yaml).toContain('池尾兜住');
    } finally {
      process.off('unhandledRejection', onUR);
    }
  }, 30000);

  it('envOf 快照优先：快照在场时改 process.env 不影响本 run（冻结语义）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution('# T\nId: t\nGoal: g\n## Steps\n1. [reason] 想\n  + → r: text  # a\n  > t\n', HOST);
    const host = { ...HOST, env_snapshot: { 'FROZEN_API_KEY': 'sk-snap' } } as HostConfig;
    const d = new StepDispatcher(engine, host);
    process.env['FROZEN_API_KEY'] = 'sk-late-change';
    try {
      // preferIfAvailable 经 envOf 查在场性——快照有 FROZEN 键即在场,进程 env 改动不可见
      expect((d as unknown as { envOf: (k: string) => string | undefined }).envOf('FROZEN_API_KEY')).toBe('sk-snap');
      // 快照里没有的键=不在场（不回退进程 env——快照是封闭集）
      process.env['GHOST2_API_KEY'] = 'sk-proc';
      expect((d as unknown as { envOf: (k: string) => string | undefined }).envOf('GHOST2_API_KEY')).toBeUndefined();
    } finally { delete process.env['FROZEN_API_KEY']; delete process.env['GHOST2_API_KEY']; }
  });

  it('envOf 回退支路：快照缺席（宿主直构 HostConfig 嵌入场景）→ 直读进程 env（存量兼容）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution('# T\nId: t\nGoal: g\n## Steps\n1. [reason] 想\n  + → r: text  # a\n  > t\n', HOST);
    const d = new StepDispatcher(engine, HOST);   // HOST 无 env_snapshot
    process.env['LEGACY_PATH_KEY'] = 'sk-legacy';
    try {
      expect((d as unknown as { envOf: (k: string) => string | undefined }).envOf('LEGACY_PATH_KEY')).toBe('sk-legacy');
    } finally { delete process.env['LEGACY_PATH_KEY']; }
  });
});

// mock 单文本响应（BUG-F 组用——每次调用都返回同一文本,reason/check 都吃）
function mockLLMText(dispatcher: unknown, text: string): void {
  const mockCreate = (dispatcher as { defaultClient: { messages: { create: ReturnType<typeof vi.fn> } } }).defaultClient.messages.create;
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

// ===== BUG-F 回归：call parallel 子实例内大输入 deflate 写点 ENOENT =====
// 真身链条：MemoryPersistence workzone 无 vars/ 子目录 → resolveInputs deflate 裸写 ENOENT
// → nextStep 组装 catch 误标 doc-ref、瞬间 fail、重试同因必死("1ms retry exhausted")、
// 且 fail 在 recordStepStart 前=HopLog 零痕迹（静默死）。BUG-F 2026-08-14 修复。
// @v: anc-exec-deflate, anc-exec-work-zone, anc-exec-doc-ref-resolve
describe('BUG-F：MemoryPersistence 子实例大输入 deflate（call 子实例内 reason 静默死）', () => {
  const CALLEE = `# 探针callee
Id: probe_callee
Goal: call 子实例内 act 取域视图后 reason 消费
Inputs:
- target_kb: line
Outputs:
- domain: line

## Steps
1. [subtask] 包一层
  + → domain: line

  1.1. [act] 取候选领域结构视图
    - ← target_kb
    + → mindmaps: [yaml]
    > \`\`\`hop_python
    > got = get_domain_indexes(kb: target_kb)
    > mindmaps = got.indexes
    > \`\`\`

  1.2. [reason] 定主领域
    - ← mindmaps
    + → domain: line
    > 选一个领域路径。
2. [exit]
`;

  function bigHost(dir: string): HostConfig {
    // 200 项大输出——JSON 序列化必超 DEFLATE_THRESHOLD(4096)，触发 reason 步输入 deflate
    const big = Array.from({ length: 200 }, (_, i) => ({ path: `领域${i}/子域${i}`, desc: 'x'.repeat(30) }));
    return {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'sk-fake',
      tool_provider: {
        list: () => [{ name: 'get_domain_indexes', description: 'x', input_schema: {}, requires_commit: false }],
        execute: async () => ({ success: true, result: { indexes: big }, content_type: 'json' }),
      },
    };
  }

  it('正例：子实例形态（MemoryPersistence,parentInstanceId/callStepId）大输入 → reason 步真获得执行机会（mock LLM 返回即 completed）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugf-reg-'));
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CALLEE, bigHost(dir), {
      params: { target_kb: '/kb' }, parentInstanceId: 'fake-parent', callStepId: '1.1.1',
    });
    expect(init.status).toBe('ok');
    const d = new StepDispatcher(engine, bigHost(dir));
    mockLLMText(d, '数学理论/排队论');
    const r = await d.runSpec();
    // 修复前：1.2 从未 start,容器 1ms retry exhausted;修复后 LLM 真被调、跑到 completed
    expect(r.status).toBe('completed');
    expect(engine.getStepStates().get('1.2')).toBe('done');
  });

  it('反例守卫：组装失败不再误标 doc-ref 且 HopLog 留痕（标签忠实+失败必留痕）', async () => {
    // 直捣组装 catch：deflate 写点指向不可写路径（workZone 伪造为不存在且不可建的位置）
    // 用 FilePersistence 实例然后破坏 vars 目录为文件——制造确定性 EEXIST/ENOTDIR:
    const dir = mkdtempSync(join(tmpdir(), 'bugf-lbl-'));
    const stateDir = join(dir, '.hopstate');
    const engine = new ExecutionEngine();
    const init = engine.initExecution(CALLEE, bigHost(dir), { params: { target_kb: '/kb' }, stateDir, logDir: join(dir, '.hoplog'), logLevel: 'info' });
    expect(init.status).toBe('ok');
    const instId = (init as { instance_id: string }).instance_id;
    // 把 work_zone/vars 换成文件——mkdirSync recursive 撞文件必抛,稳定触发组装 catch
    const varsDir = join(stateDir, instId, 'work_zone', 'vars');
    rmSync(varsDir, { recursive: true, force: true });
    writeFileSync(varsDir, 'not-a-dir');
    const d = new StepDispatcher(engine, bigHost(dir));
    // 显式关阀恢复 deflate 路径（BUG-H 修后 dispatcher 缺省 inline 不写盘,本例正常 completed——
    // 本测试对象是组装 catch 两义务〔标签忠实/留痕〕,非 deflate 策略,保留写盘触发面）。
    engine.setInlineLlmContext(false);
    mockLLMText(d, '数学理论/排队论');
    const r = await d.runSpec();
    expect(r.status).toBe('failed');
    const reasons = engine.exportFailState().stepFailReasons ?? {};
    const r12 = (reasons as Record<string, { reason: string }>)['1.2'];
    expect(r12).toBeDefined();
    expect(r12.reason).toContain('context 组装失败');       // 标签忠实（不再冒充 doc-ref）
    expect(r12.reason).not.toMatch(/^doc-ref 解析失败/);
    // HopLog 留痕：1.2 的失败块在轨（修复前零痕迹）,且重试轮次键真实产生
    //（补 recordStepStart 走的是正规 start 路径——failed 后再 start 触发 #iter 轮次逻辑,
    // 非旁门补块;retry exhausted 前每轮都有 start+failed 成对块）
    const mains = readFileSync(join(engine.getHopLogRunDir()!, 'main.yaml'), 'utf-8');
    expect(mains).toContain('"1.2"');
    expect(mains).toContain('"1.2#2"');
    expect(mains).toContain('context 组装失败');
  });
});

// ===== BUG-H：standalone LLM 注入面内联真值（$file 指针不出现在 LLM prompt）=====
// @v: anc-exec-llm-inline-context
describe('BUG-H：standalone 注入面内联（裸 API LLM 无文件工具）', () => {
  const BIG_SPEC = `# H
Id: bug-h
## Goal
g
## Inputs
- material: text  # 大材料
## Outputs
- verdict: line  # 判定
## Steps
1. [reason] 读材料判定
  - ← material
  + → verdict: line  # 判定
  > 基于材料给出判定。
`;

  function hostDir(): { host: HostConfig; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'bugh-'));
    return {
      dir,
      host: {
        workspace_dir: dir,
        sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
        api_key: 'k',
      },
    };
  }

  it('正例：>4KB 输入经 dispatcher 驱动,LLM 收到的 prompt 含真值全文、零 $file 字样（哨兵:量级相称）', async () => {
    const { host, dir } = hostDir();
    const material = 'M'.repeat(6000);   // 超 DEFLATE_THRESHOLD(4096)
    const engine = new ExecutionEngine();
    engine.initExecution(BIG_SPEC, host, { params: { material }, stateDir: join(dir, '.hopstate') });
    const dispatcher = new StepDispatcher(engine, host);
    const mockCreate = (dispatcher as any).defaultClient.messages.create;
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok-verdict' }], usage: { input_tokens: 2000, output_tokens: 5 } });
    const r = await dispatcher.runSpec();
    expect(r.status).toBe('completed');
    // 断言 LLM 实收 prompt（mock 能验注入面——BUG-H 教训:mock 层此断言面此前不存在）。
    // 取末次调用（vi.mock 工厂的 create 跨测试共享,calls[0] 可能是别的用例的）:
    const req = mockCreate.mock.calls.at(-1)![0];
    const allText = JSON.stringify(req.messages) + req.system;
    expect(allText).toContain('M'.repeat(6000));   // 真值全文在场
    expect(allText).not.toContain('$file');        // 指针零出现
  });

  it('反例守卫：inline 阀关掉（复用模式语义）同输入即产指针——阀真实在管事', () => {
    const { host, dir } = hostDir();
    const material = 'M'.repeat(6000);
    const engine = new ExecutionEngine();
    engine.initExecution(BIG_SPEC, host, { params: { material }, stateDir: join(dir, '.hopstate') });
    // 不建 dispatcher（复用模式形态）——engine 缺省 inline=false
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    const v = (next as { context: { inputs: Record<string, unknown> } }).context.inputs['material'];
    expect(v).toHaveProperty('$file');   // 复用模式照旧指针（driver=Claude 会 Read）
  });

  it('正例：hop_env 长值 L2e 在 inline 下同样内联', () => {
    const { host, dir } = hostDir();
    host.hop_env = { hop_env_kb_digest: 'D'.repeat(5000) };
    const REF_SPEC = BIG_SPEC.replace('基于材料给出判定。', '按 hop_env_kb_digest 判定。');
    const engine = new ExecutionEngine();
    engine.initExecution(REF_SPEC, host, { params: { material: 'x' }, stateDir: join(dir, '.hopstate') });
    engine.setInlineLlmContext(true);   // dispatcher 构造动作的等价物
    const next = engine.nextStep();
    const table = (next as { context: { hop_env_table?: string } }).context.hop_env_table ?? '';
    expect(table).toContain('D'.repeat(5000));
    expect(table).not.toContain('$file');
  });
});

// @v: anc-exec-llm-inline-context —— L2d doc-ref 大节内联（三注入面的第三面,review 抓测试缺口）
describe('BUG-H：L2d doc-ref 大节 inline 下内联', () => {
  it('正例：>4KB 章节 standalone 下全文内联进 doc_ref_context,零 $file 提示', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugh-l2d-'));
    const bigSection = '## 大节\n' + '内容行。'.repeat(1500);   // >4KB
    writeFileSync(join(dir, 'kb.md'), '# KB\n\n' + bigSection + '\n\n## 小节\n短。\n');
    const SPEC = `# T
Id: t
## Goal
g
## Outputs
- r: line  # r
## Steps
1. [reason] R
  + → r: line  # r
  > 参照 [[kb#大节]] 完成
`;
    const host: HostConfig = {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'k',
    };
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, host, { stateDir: join(dir, '.hopstate') });
    expect(init.status).toBe('ok');
    engine.setInlineLlmContext(true);   // dispatcher 构造动作等价物
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    const ctx = (next as { context: { doc_ref_context?: string } }).context.doc_ref_context ?? '';
    expect(ctx).toContain('内容行。'.repeat(50));   // 大节全文真在场（抽样长片段）
    expect(ctx).not.toContain('$file');             // 零指针提示
  });

  it('反例守卫：阀关（复用模式）同章节走 $file 卸载——两模式分叉真实在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugh-l2d2-'));
    const bigSection = '## 大节\n' + '内容行。'.repeat(1500);
    writeFileSync(join(dir, 'kb.md'), '# KB\n\n' + bigSection + '\n');
    const SPEC = `# T
Id: t
## Goal
g
## Outputs
- r: line  # r
## Steps
1. [reason] R
  + → r: line  # r
  > 参照 [[kb#大节]] 完成
`;
    const host: HostConfig = {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'k',
    };
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host, { stateDir: join(dir, '.hopstate') });
    const next = engine.nextStep();
    const ctx = (next as { context: { doc_ref_context?: string } }).context.doc_ref_context ?? '';
    expect(ctx).toContain('请 Read 获取完整章节');   // 复用模式照旧卸载（yaml 条目化后指针条目形态,无 $file 字面）
  });

  // @v: anc-exec-llm-inline-context v2 预览通道（2026-08-25 作者定"独立模式用类似 yaml 缩进
  // 方式引用+相对宽松限额"——一刀切全内联把 41K 变量反复内联,57% prompt 超线;预览条目值位
  // 真内容节选+明示全文去处,非死引用）
  it('正例：超 20K 章节 inline 下转预览条目——头部真内容+省略声明+全文落盘路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugh-l2d3-'));
    const bigSection = '## 大节\n' + '内容行。'.repeat(6000);   // 24K chars > INLINE_PREVIEW_MAX
    writeFileSync(join(dir, 'kb.md'), '# KB\n\n' + bigSection + '\n');
    const SPEC = `# T
Id: t
## Goal
g
## Outputs
- r: line  # r
## Steps
1. [reason] R
  + → r: line  # r
  > 参照 [[kb#大节]] 完成
`;
    const host: HostConfig = {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'k',
    };
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host, { stateDir: join(dir, '.hopstate') });
    engine.setInlineLlmContext(true);
    const next = engine.nextStep();
    const ctx = (next as { context: { doc_ref_context?: string } }).context.doc_ref_context ?? '';
    expect(ctx).toContain('内容行。'.repeat(50));       // 值位是真内容（预览头部在场）
    expect(ctx).toContain('节选预览');                   // 明示是预览非全文(doc-ref L2 通道,yaml 条目形态照旧)
    expect(ctx).toContain('以下省略');                   // 明示省略量
    expect(ctx).toContain('docref');                     // 全文落盘路径在场（work_zone/docref/）
    expect(ctx).not.toContain('请 Read 获取完整章节');   // 不是旧指针条目
    expect(ctx.length).toBeLessThan(24000);              // 预览生效:条目体量被压到限额级
  });

  it('正例：>20K 输入变量 inline 下转 $preview 条目——渲染带节选与全文路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugh-l4p-'));
    const SPEC = `# T
Id: t
## Goal
g
## Inputs
- material: text  # 大料
## Outputs
- r: line  # r
## Steps
1. [reason] R
  - ← material
  + → r: line  # r
  > 基于材料判定
`;
    const host: HostConfig = {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'k',
    };
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host, { params: { material: '材料段。'.repeat(6000) }, stateDir: join(dir, '.hopstate') });   // 24K chars
    engine.setInlineLlmContext(true);
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    const inputs = (next as { context: { inputs: Record<string, unknown> } }).context.inputs;
    const v = inputs['material'] as { $preview?: string; full_chars?: number; full_file?: string };
    expect(v).toHaveProperty('$preview');                       // 预览对象非 $file 死引用
    expect(v.$preview!.length).toBe(20000);                     // 截头 20000
    expect(v.full_chars).toBe(24000);
    expect(v.full_file).toContain('vars');                      // 全文照旧落盘
    const text = formatPromptText((next as { context: AssembledContext }).context, 'reason');
    expect(text).toContain('字符节选）')   // 预览元信息并入 =| 头行尾注(2026-08-31 终形);
    expect(text).toContain('材料段。'.repeat(20));               // 值位真内容
    expect(text).not.toContain('$file');
  });

  // #53（dr20 实撞）:check 判定步豁免预览截头——判官必须看全文才能销项,截头=假判定
  // （5.2.5 spec_text 35092 字符被截前 20000,后 15092 字符里的待复验项不可见,四轮假判
  // 烧尽 5.2 打回小时级重建）。 // @v: anc-exec-inputs-deflate, anc-exec-llm-inline-context
  it('#53 正例：>20K 输入在 check 步 inline 下全量内联——判定步不截头', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugh-chk-'));
    const SPEC = `# T
Id: t
## Goal
g
## Inputs
- spec_text: text  # 被审全文
## Outputs
- r: line  # r
## Steps
1. [subtask] 审
  + → r: line  # r
  1.1. [check] 整体合理关
    - ← spec_text
    + → ok: bool  # 判定槽
    + → why: text  # 说明槽
    > 全文复核
  1.2. [act] 收尾
    + → r: line  # r
    > \`\`\`hop_python
    > r = "x"
    > \`\`\`
`;
    const host: HostConfig = {
      workspace_dir: dir,
      sandbox: { filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
      api_key: 'k',
    };
    const engine = new ExecutionEngine();
    const big = '条款行。'.repeat(6000);   // 24K chars > INLINE_PREVIEW_MAX
    engine.initExecution(SPEC, host, { params: { spec_text: big }, stateDir: join(dir, '.hopstate') });
    engine.setInlineLlmContext(true);
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    expect((next as { step_id: string }).step_id).toBe('1.1');
    const inputs = (next as { context: { inputs: Record<string, unknown> } }).context.inputs;
    expect(typeof inputs['spec_text']).toBe('string');           // 全量内联,非 $preview 对象
    expect((inputs['spec_text'] as string).length).toBe(24000);  // 一字不截
  });
});

// ═══ 两线合一回归防线（standalone 请求与 hoplog 记录字节同源） ═══
// @v: anc-obs-record-at-boundary
// 实撞背景:旧形态 dispatcher 自拼四段消息(不含 L0/L5),engine 记 formatPromptText 渲染件——
// 意图层记录与实发内容分叉,假 prompt 骗过十几轮走查,三次"模型锚定"定罪建立在模型从未收到的
// prompt 上（作者定 2026-08-24"不能再犯那么蠢的问题"）。
describe('两线合一：standalone 请求=hoplog 记录（record-at-boundary）', () => {
  const UNIFY_SPEC = `# U
Id: u
## Goal
g
## Outputs
- v: text  # x
## Steps
1. [subtask retry=2] 容器
  + → v: text  # x
  1.1. [reason] 生成
    + → v: text  # x
2. [exit]
`;
  const U_HOST: HostConfig = { workspace_dir: '/tmp', api: { provider: 'anthropic', model: 'claude-test' }, api_key: 'k' };

  function setup() {
    const engine = new ExecutionEngine();
    engine.initExecution(UNIFY_SPEC, U_HOST);
    const dispatcher = new StepDispatcher(engine, U_HOST);
    const mockCreate = (dispatcher as any).defaultClient.messages.create;
    const handleReady = (dispatcher as any).handleStepReady.bind(dispatcher);
    return { engine, dispatcher, mockCreate, handleReady };
  }
  const OK_RESP = { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 5 } };

  it('正例：重试轮真实请求含 L0 世界观与 L5 修正指令（旧形态两者全缺——分叉主罪）', async () => {
    const { engine, mockCreate, handleReady } = setup();
    mockCreate.mockResolvedValue(OK_RESP);
    engine.nextStep();
    engine.failStep('1.1', 'CHECK_FAILED: 请删除 agent_launcher 条目');
    const next = engine.nextStep();   // 重试轮
    expect(next.status).toBe('step_ready');
    if (next.status === 'step_ready') {
      await handleReady(next);
      const req = mockCreate.mock.calls.at(-1)![0];   // 模块级 mock 跨测试共享,取本测试的最后一次调用
      const sys = req.system.map((b: { text: string }) => b.text).join('\n');
      const msgs = req.messages.map((m: { content: string }) => m.content).join('\n');
      expect(sys).toContain('HopSpec 是把任务写成编号步骤树的规约');   // L0 世界观进真实请求
      expect(msgs).toContain('L5. 修正指令');                          // L5 进真实请求
      expect(msgs).toContain('请删除 agent_launcher 条目');            // 作者意见真的发出去了
    }
  });

  it('正例：hoplog llm.prompt 与实发 request 序列化逐字一致（发送边界成对落账）', async () => {
    const { engine, mockCreate, handleReady } = setup();
    const { HopLog } = await import('../src/hoplog.js');
    const dir = mkdtempSync(join(tmpdir(), 'unify-'));
    const hopLog = new HopLog({ specId: 'u', logDir: dir, title: 'T', goal: 'G' });
    (engine as any).hoplog = hopLog;
    mockCreate.mockResolvedValue(OK_RESP);
    const next = engine.nextStep();
    if (next.status === 'step_ready') await handleReady(next);
    hopLog.close('completed');
    const req = mockCreate.mock.calls.at(-1)![0];
    const sys = req.system.map((b: { text: string }) => b.text).join('\n\n');
    const msgs = req.messages.map((m: { content: string }) => m.content).join('\n\n');
    const yaml = readFileSync(hopLog.getFilePath(), 'utf-8');
    // 记录=发送:实发请求的开头世界观句与易变段尾内容都能在 hoplog 里逐字找到
    expect(yaml).toContain('HopSpec 是把任务写成编号步骤树的规约');
    expect(sys).toContain('HopSpec 是把任务写成编号步骤树的规约');
    expect(yaml).toContain('L4. 当前节点');
    expect(msgs).toContain('L4. 当前节点');
  });
});

// 输出预算解析链（2026-08-27 作者定"按 LLM 的上限去设置,Ln 门限自己控制"——缺省 16384→32768,
// +provider 级 {SID}_MAX_OUTPUT_TOKENS,摘 CLAUDE_CODE_MAX_OUTPUT_TOKENS〔主对话 agent 设置泄漏给引擎〕）
// @v: anc-exec-output-budget
describe('输出预算解析链（resolveMaxOutputTokens）', () => {
  function mk(host: Partial<HostConfig> = {}) {
    const engine = new ExecutionEngine();
    engine.initExecution(`# T
Id: t-budget
## Goal
g
## Outputs
- r: text  # o
## Steps
1. [reason] think
  + → r: text  # o
`, { ...HOST, ...host });
    return new StepDispatcher(engine, { ...HOST, ...host } as HostConfig);
  }

  it('正例：零配置缺省 32768（16384 时代结束）', () => {
    const d = mk();
    expect((d as any).resolveMaxOutputTokens()).toBe(32768);
  });

  it('正例：provider 级 {SID}_MAX_OUTPUT_TOKENS 生效（按当次路由 service 取）', () => {
    const d = mk({ env_snapshot: { DEEPSEEK_MAX_OUTPUT_TOKENS: '65536' } } as any);
    expect((d as any).resolveMaxOutputTokens('deepseek')).toBe(65536);
    expect((d as any).resolveMaxOutputTokens('other')).toBe(32768);   // 其他 service 不受影响
  });

  it('正例：resource_limits 覆盖 provider 级;HOPJIT env 恒最高', () => {
    const d = mk({ resource_limits: { max_output_tokens: 8192 } as any, env_snapshot: { DEEPSEEK_MAX_OUTPUT_TOKENS: '65536' } } as any);
    expect((d as any).resolveMaxOutputTokens('deepseek')).toBe(8192);
    const d2 = mk({ resource_limits: { max_output_tokens: 8192 } as any, env_snapshot: { HOPJIT_MAX_OUTPUT_TOKENS: '4096' } } as any);
    expect((d2 as any).resolveMaxOutputTokens()).toBe(4096);
  });

  it('反例：CLAUDE_CODE_MAX_OUTPUT_TOKENS 已摘除——设了也不进链（主对话 agent 设置不泄漏给引擎）', () => {
    const d = mk({ env_snapshot: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048' } } as any);
    expect((d as any).resolveMaxOutputTokens()).toBe(32768);   // 不是 2048
  });
});

// @v: anc-exec-subprocess-run —— 独立模式接线（review 抓 standalone 恒关死:dispatcher 原不注入白名单）
describe('subprocess.run 独立模式接线', () => {
  it('正例：hostConfig 白名单经 dispatcher 注入——standalone body 真执行 echo（修前红:必撞"未配置命令白名单"）', async () => {
    const SPEC = `# T
Id: t-sub
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [act] 跑命令
  + → out: text  # o
> 执行
> \`\`\`hop_python
> r = subprocess.run(["echo", "standalone-ok"])
> out = r.stdout
> \`\`\`
`;
    const host: HostConfig = { ...HOST, sandbox: { ...HOST.sandbox, runtime: { available: ['echo'] } } };
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host);
    const d = new StepDispatcher(engine, host);
    (d as any).sleep = () => Promise.resolve();
    const r = await d.runSpec();
    expect(r.status).toBe('completed');
    expect(String(engine.getVariableStore().read('out', 'root'))).toContain('standalone-ok');
  });

  it('正例：standalone for-each 二轮命令重执行——completeStep 清账后无 stale replay（F3 击杀:修前红,二轮拿回上一轮记录命令不再跑静默错数据）', async () => {
    const SPEC = `# T
Id: t-loop
## Goal
g
## Inputs
- items: [text]  # in
## Outputs
- outs: [text]  # o
## Steps
1. [loop for-each it in items, collect out into outs] 逐项跑
  - ← items
  + → outs: [text]  # 收集
  1.1. [subtask] 单项
    - ← it
    + → out: text  # o
    1.1.1. [act] 跑命令
      - ← it
      + → out: text  # o
      > 执行
      > \`\`\`hop_python
      > r = subprocess.run(["echo", it])
      > out = r.stdout
      > \`\`\`
`;
    const host: HostConfig = { ...HOST, sandbox: { ...HOST.sandbox, runtime: { available: ['echo'] } } };
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host, { params: { items: ['round-one', 'round-two'] } });
    const d = new StepDispatcher(engine, host);
    (d as any).sleep = () => Promise.resolve();
    const r = await d.runSpec();
    expect(r.status).toBe('completed');
    const outs = engine.getVariableStore().read('outs', 'root') as string[];
    // 修前形态:第二轮 cmdJournal 命中重放,outs[1] 是上一轮的 'round-one'（静默错数据）
    expect(String(outs[0])).toContain('round-one');
    expect(String(outs[1])).toContain('round-two');
  });

  it('正例：standalone cmdJournal 注入使 tool_request 挂起后续跑不重执行命令——journal 经引擎账重放（变异 F 真击杀面:删注入=每轮真执行,本钉断言的是重放行为本身）', async () => {
    // 直测接线语义:engine 账里预置记录,dispatcher 执行 body 时命中重放(不真跑 echo)
    const SPEC = `# T
Id: t-replay
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [act] 跑
  + → out: text  # o
> 执行
> \`\`\`hop_python
> r = subprocess.run(["echo", "fresh-run"])
> out = r.stdout
> \`\`\`
`;
    const host: HostConfig = { ...HOST, sandbox: { ...HOST.sandbox, runtime: { available: ['echo'] } } };
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, host);
    // 预置 journal:模拟上次进程死在本步中途已记一笔
    (engine as any).cmdJournal['1'] = [{ stdout: 'FROM-JOURNAL', stderr: '', returncode: 0 }];
    const d = new StepDispatcher(engine, host);
    (d as any).sleep = () => Promise.resolve();
    const r = await d.runSpec();
    expect(r.status).toBe('completed');
    // 命中重放取记录值——删 dispatcher 的 cmdJournal 注入则此断言红(每轮真执行得 fresh-run)
    expect(String(engine.getVariableStore().read('out', 'root'))).toBe('FROM-JOURNAL');
  });

  it('反例：hostConfig 名单空 → standalone 撞限失败如实（能力关死缺省安全,不静默跳过）', async () => {
    const SPEC = `# T
Id: t-sub2
## Goal
g
## Outputs
- out: text  # o
## Steps
1. [act] 跑命令
  + → out: text  # o
> 执行
> \`\`\`hop_python
> r = subprocess.run(["echo", "x"])
> out = r.stdout
> \`\`\`
`;
    const engine = new ExecutionEngine();
    engine.initExecution(SPEC, HOST);   // HOST 缺省 runtime.available=[]
    const d = new StepDispatcher(engine, HOST);
    (d as any).sleep = () => Promise.resolve();
    const r = await d.runSpec();
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r.failure)).toContain('未配置命令白名单');
  });
});

// @v: anc-exec-tool-manifest-source — 工具清单料源接线（prompt-assembler v0.13.0:Dispatcher 构造完
// CompositeToolProvider 必须经专用通路交给引擎,独立模式 L4 清单才能渲染真身档;2026-08-31 真机实抓
// 断裂形态=getToolDefs 只读 hostConfig.tool_provider〔全库无写入点〕→独立模式恒落复用模式通道指引档）
describe('工具清单料源接线（setToolDefsSource）', () => {
  it('正例：Dispatcher 构造后引擎 getToolDefs 返回注册面（含文件十件），清单渲染真身档', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    void new StepDispatcher(engine, HOST);
    const defs = engine.getToolDefs();
    expect(defs).toBeDefined();
    const names = defs!.map(d => d.name);
    expect(names).toContain('read');
    expect(names).toContain('write');
    // 文件族 basic 分档随注册面透传（L4 清单基础族恒列的判据）
    expect(defs!.find(d => d.name === 'read')!.category).toBe('basic');
    // 渲染面：真身档=参数逐条展开，不出现复用模式的通道指引文案
    const { buildToolManifest } = await import('../src/prompt.js');
    const manifest = buildToolManifest({ tool_grants: [] }, defs);
    expect(manifest).toContain('read');
    expect(manifest).toContain('参数');
    expect(manifest).not.toContain('用你环境里的同义操作落实');
    expect(manifest).not.toContain('tool-call');
  });

  it('反例：无 Dispatcher（复用模式）时 getToolDefs 仍 undefined，清单落通道指引档', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    expect(engine.getToolDefs()).toBeUndefined();
    const { buildToolManifest } = await import('../src/prompt.js');
    const manifest = buildToolManifest({ tool_grants: [{ name: 'insert_node' }] }, undefined);
    expect(manifest).toContain('用你环境里的同义操作落实');
    expect(manifest).toContain('tool-call');
  });

  // @v: anc-exec-act-free-role — 角色档尾块=单档提取（出口表宣称"单档提取",实装曾整份
  // buildL0Worldview 返回——act 工具循环 system 里 L0 世界观发两遍,每请求多烧 ~1.5K 字符,
  // 2026-08-31 作者对 probe hoplog 实抓）。
  it('act 工具循环 system:L0 恰一份,角色档尾块只含角色段不含世界观', async () => {
    const actSpec = `# Act Test
Id: act-role-tail
## Goal
Test role tail block
## Outputs
- result: text  # output
## Steps
1. [act free] Do something
  + → result: text  # output
  > Use tools
`;
    const engine = new ExecutionEngine();
    engine.initExecution(actSpec, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    (dispatcher as any).sleep = () => Promise.resolve();
    const mockCreate = (dispatcher as any).defaultClient.messages.create;
    // 全量跑时前序测试可能改写全局 SDK mock 使 create 成为共享 fn——先清历史,取样用末次调用
    // 防捞到别人的请求（单跑绿/全跑红实撞）。
    mockCreate.mockClear();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'result: done' }],
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    const step = engine.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status === 'step_ready') {
      const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
      await executeAct(step);
    }
    const req = mockCreate.mock.calls.at(-1)![0] as { system: Array<{ text: string }> };
    const sysAll = req.system.map(b => b.text).join('\n\n');
    // 正例:整个 system 里 L0 区块题恰一次(修前=2:buildSystemPrompt 一份+roleGuideText 整份 L0 又一份)
    expect(sysAll.match(/═══ L0/g)?.length ?? 0).toBe(1);
    // 正例:尾块=纯角色段(以"你的角色"开头,不含世界观开场句)
    const tail = req.system[req.system.length - 1].text;
    expect(tail.startsWith('你的角色：任务执行')).toBe(true);
    expect(tail).not.toContain('自由');   // 机制词退场（作者定——否则无法无天）
    expect(tail).not.toContain('HopSpec 是把任务写成编号步骤树的规约');
    // 反例兜底:角色段没有因此丢失(system 整体仍含 free 档禁令)
    expect(sysAll).toContain('【禁止】任何不可逆动作');
  });

  // @v: anc-exec-tool-manifest-supply — 清单供给三面（输出形状/路径写域/类型词表教学——
  // 2026-08-31 作者对真机 hoplog 连环抓:返回值格式没讲/LLM 写文件恒撞 WORK_ZONE_ONLY 烧满
  // 20 轮〔0056〕/两套类型词表打架）。
  it('清单供给三面：返回形状行+work_zone 写盘行+词表教学句在场（act 步）', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    void new StepDispatcher(engine, HOST);
    const defs = engine.getToolDefs()!;
    const { buildToolManifest } = await import('../src/prompt.js');
    const manifest = buildToolManifest({ tool_grants: [] }, defs, { stepType: 'act', workZoneRel: '.hopstate/x/work_zone' });
    // 面1:每件内置工具带"返回:"行(抽查 read/exists——形状描述如实)
    expect(manifest).toContain('返回:');
    expect(manifest).toMatch(/- read：[\s\S]*?返回:.*文件内容/);
    expect(manifest).toMatch(/- exists：[\s\S]*?返回:.*exists/);
    // 面2:路径纪律恒有行+act 步 work_zone 写盘行
    expect(manifest).toContain('路径一律相对 workspace');
    expect(manifest).toContain('本步写盘唯一合法位置');
    expect(manifest).toContain('.hopstate/x/work_zone');
    // 面3:词表教学句+调用方式行(作者补抓:列了工具没说怎么调/返回行不得用 HopSchema 词)
    expect(manifest).toContain('工具调用协议的词表');
    expect(manifest).toContain('不互译');
    expect(manifest).toContain('按 tool_use 协议发起调用');
    expect(manifest).toContain('不必为了用而用');
    expect(manifest).not.toContain('5000');   // 写盘体量约定已挪 L4 输出段（作者抓"在工具那写太远了"）
    expect(manifest).not.toContain('（text）');
  });

  it('清单供给分档：commit 步渲染 workspace 可写口径,work_zone 空串时写盘行如实省略', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    void new StepDispatcher(engine, HOST);
    const defs = engine.getToolDefs()!;
    const { buildToolManifest } = await import('../src/prompt.js');
    const commitM = buildToolManifest({ tool_grants: [] }, defs, { stepType: 'commit', workZoneRel: '.hopstate/x/work_zone' });
    expect(commitM).toContain('本步为交付写盘');
    expect(commitM).not.toContain('本步写盘唯一合法位置');
    const emptyWz = buildToolManifest({ tool_grants: [] }, defs, { stepType: 'act', workZoneRel: '' });
    expect(emptyWz).not.toContain('本步写盘唯一合法位置');
    expect(emptyWz).toContain('路径一律相对 workspace');   // 恒有行不随省
  });

  // 回退链两钉（review 面三变异 d/e 实锤零保护:删回退分支全量 2435 绿/优先序颠倒 914 绿——
  // 契约条2后半"回退 hostConfig.tool_provider"与优先序此前可整删而机检不红）。
  it('正例：两料源同时在场时 getToolDefs 优先出 composite 面（锁优先序）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    const hostTool = { name: 'host_only_tool', description: 'host injected', input_schema: {}, requires_commit: false };
    const host = { ...HOST, tool_provider: { list: () => [hostTool], execute: vi.fn() } as any };
    engine.setHostConfig(host);
    void new StepDispatcher(engine, host);
    const defs = engine.getToolDefs()!;
    const names = defs.map(d => d.name);
    // composite 面=文件十件+宿主件并入;若优先序颠倒成宿主注入口优先,则只有 host_only_tool 一件
    expect(names).toContain('read');
    expect(names).toContain('host_only_tool');
    expect(names.length).toBeGreaterThan(1);
  });

  it('正例：无 Dispatcher 但宿主注入 tool_provider 时 getToolDefs 走回退分支出宿主件（锁回退链）', () => {
    const engine = new ExecutionEngine();
    const hostTool = { name: 'host_only_tool', description: 'host injected', input_schema: {}, requires_commit: false };
    const host = { ...HOST, tool_provider: { list: () => [hostTool], execute: vi.fn() } as any };
    engine.initExecution(SIMPLE_SPEC, host);
    const defs = engine.getToolDefs();
    expect(defs).toBeDefined();
    expect(defs!.map(d => d.name)).toEqual(['host_only_tool']);
  });

  it('回归：接线不污染 hostConfig.tool_provider（mcp-server 两处重建 composite 不受影响）', () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    const host = { ...HOST };
    void new StepDispatcher(engine, host);
    expect(host.tool_provider).toBeUndefined();
  });
});

// @v: anc-exec-reason-tools — standalone reason 步工具面（2026-09-01 作者拍"所以应该给 reason
// 提供文件工具""等同于 act 的能力,不能 commit 写"。实撞:anchor-audit spec standalone 化六跑,
// 第六跑死在 4.2——reason 步要读盘上 cross_compare_results.yaml,零工具面判不了,同一份 spec
// 复用模式活 standalone 死）。四钉:声明 special 下发/未声明仅 basic/requires_commit 恒缺席/
// check 步零工具面照旧单发。
describe('reason 步工具面（^anc-exec-reason-tools）', () => {
  const PROVIDER_TOOLS = [
    { name: 'read', description: '读文件', input_schema: {}, category: 'basic' as const, requires_commit: false },
    { name: 'special_probe', description: '特殊件', input_schema: {}, category: 'special' as const, requires_commit: false },
    { name: 'other_special', description: '未声明特殊件', input_schema: {}, category: 'special' as const, requires_commit: false },
    { name: 'danger_send', description: '不可逆件', input_schema: {}, category: 'basic' as const, requires_commit: true },
  ];

  const mkReasonSpec = (grantLine: string) => `# R
Id: r-tools
## Goal
g
## Outputs
- verdict: text  # v
## Steps
1. [reason] 判断
${grantLine}  + → verdict: text  # v
  > 推理
`;

  async function runReasonAndGrabRequest(spec: string): Promise<Record<string, unknown>> {
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    (dispatcher as any).sleep = () => Promise.resolve();
    (dispatcher as any).toolProvider = { list: () => PROVIDER_TOOLS, execute: vi.fn() };
    const mockCreate = (dispatcher as any).defaultClient.messages.create;
    mockCreate.mockClear();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'verdict: ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const step = engine.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status !== 'step_ready') throw new Error('unreachable');
    const executeReason = (dispatcher as any).executeReason.bind(dispatcher);
    const result = await executeReason(step);
    expect(result.verdict).toBe('ok');   // 产出仍按声明 schema 解析（parseStepOutput 阶梯）
    return mockCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
  }

  it('钉①正例：reason 声明 special 工具 → 请求 tools 含之（basic 同列）', async () => {
    const req = await runReasonAndGrabRequest(mkReasonSpec('  - 工具: special_probe  # 读料\n'));
    const names = (req.tools as Array<{ name: string }>).map(t => t.name);
    expect(names).toContain('special_probe');
    expect(names).toContain('read');   // basic 恒下发
  });

  it('钉②反例：未声明 → 仅 basic（special 件不下发）', async () => {
    const req = await runReasonAndGrabRequest(mkReasonSpec(''));
    const names = (req.tools as Array<{ name: string }>).map(t => t.name);
    expect(names).toContain('read');
    expect(names).not.toContain('special_probe');
    expect(names).not.toContain('other_special');
  });

  it('钉③反例：requires_commit 件恒缺席（list 期过滤——即使它标 basic、即使 * 全量授权）', async () => {
    // 变异重放在案（4.4 实测）:撤 executeActWithTools 的 allowCommit||!requires_commit list 期
    // 过滤行 → 本钉红（danger_send 进 tools 清单）;恢复 → 绿。"不能 commit 写"红线的机检本体。
    const req = await runReasonAndGrabRequest(mkReasonSpec('  - 工具: *\n'));
    const names = (req.tools as Array<{ name: string }>).map(t => t.name);
    expect(names).toContain('special_probe');   // * 全量授权 special 照下发
    expect(names).not.toContain('danger_send'); // 不可逆件 LLM 根本看不到
  });

  it('钉④正例：check 步照旧单发零工具（请求无 tools 字段——判官纯判定,扩员不及 check）', async () => {
    const checkSpec = `# C
Id: c-noface
## Goal
g
## Outputs
- ok: bool  # 判
## Steps
1. [subtask] 生成并判定
  + → ok: bool  # 判
  1.1. [reason] 生成
    + → draft: text  # 草稿
  1.2. [check] 判定
    - ← draft
    + → ok: bool  # 判
    + → note: text  # 说明
`;
    const engine = new ExecutionEngine();
    engine.initExecution(checkSpec, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    (dispatcher as any).sleep = () => Promise.resolve();
    (dispatcher as any).toolProvider = { list: () => PROVIDER_TOOLS, execute: vi.fn() };
    const mockCreate = (dispatcher as any).defaultClient.messages.create;
    engine.nextStep();
    engine.completeStep('1.1', { draft: 'D' });
    const step = engine.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status !== 'step_ready') return;
    expect(step.step_type).toBe('check');
    mockCreate.mockClear();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok: true\nnote: ""' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const executeStep = (dispatcher as any).executeStep.bind(dispatcher);
    await executeStep(step);
    const req = mockCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect('tools' in req).toBe(false);   // 单发路径 buildApiRequest 不带 tools 字段
  });
});

// @v: anc-step-tool-deny — 节点级工具禁用的下发过滤（设计锚 ^anc-step-tool-deny,2026-09-05
// 作者拍"甲，而且是不是可以在指定节点禁止 write tool?"。缘起 0038b:修错步有树编辑工具仍选
// write 全文回写 7 轮 ≈17 万 tokens——文字禁令不牢靠,被禁件从下发清单整体剔除 LLM 根本看不到）。
// 四钉:act 禁 write 清单无 write（basic 族被禁实证）/不禁件照常在/reason 步禁用同样生效/
// 零禁用声明与改造前逐字节同构（存量零回归）。
describe('节点级工具禁用的下发过滤（^anc-step-tool-deny）', () => {
  const PROVIDER_TOOLS = [
    { name: 'read', description: '读文件', input_schema: {}, category: 'basic' as const, requires_commit: false },
    { name: 'write', description: '写文件', input_schema: {}, category: 'basic' as const, requires_commit: false },
    { name: 'append', description: '追加', input_schema: {}, category: 'basic' as const, requires_commit: false },
    { name: 'special_probe', description: '特殊件', input_schema: {}, category: 'special' as const, requires_commit: false },
  ];

  const mkActSpec = (entryLines: string) => `# D
Id: d-deny
## Goal
g
## Outputs
- result: text  # r
## Steps
1. [act free] 干活
${entryLines}  + → result: text  # r
  > 做事
`;

  async function runActAndGrabRequest(spec: string): Promise<Record<string, unknown>> {
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    (dispatcher as any).sleep = () => Promise.resolve();
    (dispatcher as any).toolProvider = { list: () => PROVIDER_TOOLS, execute: vi.fn() };
    const mockCreate = (dispatcher as any).defaultClient.messages.create;
    mockCreate.mockClear();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'result: ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const step = engine.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status !== 'step_ready') throw new Error('unreachable');
    const executeActWithTools = (dispatcher as any).executeActWithTools.bind(dispatcher);
    await executeActWithTools(step);
    return mockCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
  }

  it('钉①反例：act 步禁 write → 请求 tools 无 write（basic 族被禁实证——恒下发原则的唯一例外通道）', async () => {
    const req = await runActAndGrabRequest(mkActSpec('  - 禁工具: write  # 修错步禁整文件覆盖\n'));
    const names = (req.tools as Array<{ name: string }>).map(t => t.name);
    expect(names).not.toContain('write');
  });

  it('钉②正例：不禁件照常在（read/append 不受同步禁牵连）', async () => {
    const req = await runActAndGrabRequest(mkActSpec('  - 禁工具: write\n'));
    const names = (req.tools as Array<{ name: string }>).map(t => t.name);
    expect(names).toContain('read');
    expect(names).toContain('append');
  });

  it('钉③正例：reason 步禁用同样生效（executeReason 复用 executeActWithTools 循环体天然生效）', async () => {
    const spec = `# R
Id: r-deny
## Goal
g
## Outputs
- verdict: text  # v
## Steps
1. [reason] 判断
  - 禁工具: write  # 推理步禁写盘
  + → verdict: text  # v
  > 推理
`;
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    (dispatcher as any).sleep = () => Promise.resolve();
    (dispatcher as any).toolProvider = { list: () => PROVIDER_TOOLS, execute: vi.fn() };
    const mockCreate = (dispatcher as any).defaultClient.messages.create;
    mockCreate.mockClear();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'verdict: ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const step = engine.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status !== 'step_ready') throw new Error('unreachable');
    const executeReason = (dispatcher as any).executeReason.bind(dispatcher);
    await executeReason(step);
    const req = mockCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
    const names = (req.tools as Array<{ name: string }>).map(t => t.name);
    expect(names).not.toContain('write');
    expect(names).toContain('read');
  });

  it('钉④正例：零禁用声明 → 请求工具清单与既有形态一致（basic 全下发,存量零回归）', async () => {
    const req = await runActAndGrabRequest(mkActSpec(''));
    const names = (req.tools as Array<{ name: string }>).map(t => t.name);
    expect(names).toEqual(['read', 'write', 'append']);   // basic 三件全下发,special 未声明不下发
  });
});

// 工具循环上下文压缩降级（^anc-exec-toolloop-ctx-degrade,hopissues/0070——MCP 独立模式
// 引文核实实撞:step 3.1 请求 1.05M 超 1M 模型窗,重试四连撞且请求只增不减 1.05M→1.08M,
// retry 耗尽烧 6.2M tokens 零产出。修前行为:工具循环对 context_overflow 零捕获直死——
// 修前红实录:钉①在修前代码上抛裸 BadRequestError,压缩重试不存在）。
// @v: anc-exec-toolloop-ctx-degrade
describe('工具循环上下文压缩降级（0070）', () => {
  const ACT_SPEC = `# CtxDegrade
Id: ctx-degrade
## Goal
Test ctx degrade
## Outputs
- result: text  # output
## Steps
1. [act] 读大文件后判断
  + → result: text  # output
  > 读材料回答问题
`;

  // 长 tool_result 原料：超压缩门槛 16000 字符
  const LONG_CONTENT = '材料正文。'.repeat(4000);   // 5 字符×4000=20000 字符

  function setup(hostOverride?: Partial<HostConfig>) {
    const engine = new ExecutionEngine();
    const host = { ...HOST, ...hostOverride } as HostConfig;
    engine.initExecution(ACT_SPEC, host);
    const dispatcher = new StepDispatcher(engine, host);
    (dispatcher as any).sleep = () => Promise.resolve();
    (dispatcher as any).toolProvider = {
      list: () => [{ name: 'read_file', description: '读文件', input_schema: { type: 'object', properties: {} }, requires_commit: false, category: 'basic' }],
      execute: async () => ({ result: LONG_CONTENT, success: true }),
    };
    const warns: string[] = [];
    vi.spyOn(engine, 'getHopLog').mockReturnValue({
      recordWarn: (_id: string, msg: string) => { warns.push(msg); },
      recordStepMeta: () => {}, recordStepStart: () => {}, recordStepDone: () => {},
    } as any);
    // 每测新装 create mock——前文有测试把 Anthropic 构造器 mockImplementation 换成共享 create
    // 且不恢复（:5448/:5493）,直接取 defaultClient.messages.create 会拿到带残留调用计数与
    // 粘性缺省返回值的共享 mock,全量跑时计数断言全歪（单测跑绿全量红的病根）。
    const mockCreate = vi.fn();
    (dispatcher as any).defaultClient.messages.create = mockCreate;
    return { engine, dispatcher, mockCreate, warns };
  }

  const toolUseResp = (id: string) => ({
    content: [{ type: 'tool_use', id, name: 'read_file', input: { path: `${id}.md` } }],
    usage: { input_tokens: 50, output_tokens: 20 },
  });
  const summaryResp = { content: [{ type: 'text', text: '任务相关要点：材料结论 X。' }], usage: { input_tokens: 100, output_tokens: 30 } };
  const finalResp = { content: [{ type: 'text', text: 'result: 完成' }], usage: { input_tokens: 80, output_tokens: 10 } };

  async function runAct(engine: ExecutionEngine, dispatcher: StepDispatcher) {
    const step = engine.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status !== 'step_ready') throw new Error('unreachable');
    const executeAct = (dispatcher as any).executeActWithTools.bind(dispatcher);
    return executeAct(step);
  }

  it('钉①正例：首撞 overflow → 压缩调用发生+早轮 tool_result 换摘要标注+重试成功（修前红:直抛裸 overflow）', async () => {
    const { engine, dispatcher, mockCreate, warns } = setup();
    const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
    const overflowErr = new Anthropic.BadRequestError('prompt is too long: context length exceeded, too many tokens');

    // 轮1/轮2/轮3 各读一个大文件（造出 3 轮 user tool_result——最近 2 轮受保护,第 1 轮可压）,
    // 轮4 发送撞墙 → 压缩调用（返回摘要）→ 重试成功收尾
    mockCreate
      .mockResolvedValueOnce(toolUseResp('t1'))
      .mockResolvedValueOnce(toolUseResp('t2'))
      .mockResolvedValueOnce(toolUseResp('t3'))
      .mockRejectedValueOnce(overflowErr)     // 轮 4 首撞
      .mockResolvedValueOnce(summaryResp)     // 压缩调用（早轮 1 块——轮 2/3 是最近 2 轮受保护）
      .mockResolvedValueOnce(finalResp);      // 压缩后重试成功

    const { engine: e, dispatcher: d } = { engine, dispatcher };
    const result = await runAct(e, d);
    expect(result.result).toBe('完成');
    // 重试请求真发了：总调用 6 次（3 轮工具+撞墙 1+压缩 1+重试 1）
    expect(mockCreate).toHaveBeenCalledTimes(6);
    // 重试请求的 messages 里早轮 tool_result 已是摘要+标注
    const retryReq = mockCreate.mock.calls[5][0] as { messages: Array<{ role: string; content: unknown }> };
    const userMsgs = retryReq.messages.filter(m => m.role === 'user' && typeof m.content !== 'string');
    const firstToolResult = (userMsgs[0].content as Array<{ type: string; content?: string }>).find(b => b.type === 'tool_result');
    expect(firstToolResult?.content).toContain('已压缩为任务相关摘要');
    expect(firstToolResult?.content).toContain('任务相关要点');
    expect((firstToolResult?.content as string).length).toBeLessThan(LONG_CONTENT.length);
    // 最近 2 轮受保护：最后一个 user 消息的 tool_result 原文未动
    const lastToolResult = (userMsgs[userMsgs.length - 1].content as Array<{ type: string; content?: string }>).find(b => b.type === 'tool_result');
    expect(lastToolResult?.content).toBe(LONG_CONTENT);
    // 压缩留痕
    expect(warns.some(w => w.includes('[ctx-compress]'))).toBe(true);
  });

  it('钉②正例：压缩后二次撞 → CONTEXT_OVERFLOW 前缀+指路文案（不再四连撞原样重试）', async () => {
    const { engine, dispatcher, mockCreate } = setup();
    const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
    const overflowErr = new Anthropic.BadRequestError('prompt is too long: context length exceeded, too many tokens');

    mockCreate
      .mockResolvedValueOnce(toolUseResp('t1'))
      .mockResolvedValueOnce(toolUseResp('t2'))
      .mockResolvedValueOnce(toolUseResp('t3'))
      .mockRejectedValueOnce(overflowErr)     // 首撞
      .mockResolvedValueOnce(summaryResp)     // 压缩调用成功
      .mockRejectedValueOnce(overflowErr);    // 压缩后重试仍撞——确定性失败

    await expect(runAct(engine, dispatcher)).rejects.toThrow(/^CONTEXT_OVERFLOW: .*拆步骤（for-each 逐份）或换更大窗的模型/);
    expect(mockCreate).toHaveBeenCalledTimes(6);   // 二次撞后不再发任何请求——四连撞泥潭终结
  });

  it('钉③正例：压缩调用抛错 → 退化头部节选不死（节选标注在场+流程继续）', async () => {
    const { engine, dispatcher, mockCreate } = setup();
    const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
    const overflowErr = new Anthropic.BadRequestError('prompt is too long: context length exceeded, too many tokens');

    mockCreate
      .mockResolvedValueOnce(toolUseResp('t1'))
      .mockResolvedValueOnce(toolUseResp('t2'))
      .mockResolvedValueOnce(toolUseResp('t3'))
      .mockRejectedValueOnce(overflowErr)                       // 首撞
      .mockRejectedValueOnce(new Error('压缩服务自身故障'))     // 压缩调用抛错→退化节选
      .mockResolvedValueOnce(finalResp);                        // 节选后重试成功

    const result = await runAct(engine, dispatcher);
    expect(result.result).toBe('完成');
    const retryReq = mockCreate.mock.calls[5][0] as { messages: Array<{ role: string; content: unknown }> };
    const userMsgs = retryReq.messages.filter(m => m.role === 'user' && typeof m.content !== 'string');
    const firstToolResult = (userMsgs[0].content as Array<{ type: string; content?: string }>).find(b => b.type === 'tool_result');
    // 退化形态：头部节选 8000 字符+退化标注——对下游 LLM 如实,节选不冒充摘要
    //（修前红:退化件也贴"任务相关摘要"标注,LLM 把恰好截在头部的片段当已提炼要点用）
    expect(firstToolResult?.content).toContain('头部节选');
    expect(firstToolResult?.content).not.toContain('任务相关摘要');
    expect((firstToolResult?.content as string).length).toBeLessThan(10000);
    expect(firstToolResult?.content).toContain('材料正文');   // 头部节选是原文前缀
  });

  it('钉④正例：预检档——max_context_tokens 配小值 → 未撞 API 即压缩（发送前触发）', async () => {
    const { engine, dispatcher, mockCreate } = setup({
      resource_limits: { max_context_tokens: 6000, max_tool_iterations: 20, max_output_tokens: 4096, max_replan_attempts: 3 },
    });
    // 3 轮各读一个大文件（每份 20000 字符,累积≈15000 token 远超 6000×0.8=4800 线）——
    // 最近 2 轮 tool_result 受保护,第 1 轮 tool_result 到轮 4 发送前脱保护被预检压缩,
    // 全程 API 一次都没撞（压缩发生在发送之前）。
    mockCreate
      .mockResolvedValueOnce(toolUseResp('t1'))
      .mockResolvedValueOnce(toolUseResp('t2'))
      .mockResolvedValueOnce(toolUseResp('t3'))
      .mockResolvedValueOnce(summaryResp)     // 轮 4 发送前预检压缩（第 1 个 tool_result 轮已脱保护）
      .mockResolvedValueOnce(finalResp);      // 轮 4 正常发送收尾

    const result = await runAct(engine, dispatcher);
    expect(result.result).toBe('完成');
    // 全程零 overflow 异常——压缩发生在发送之前
    const finalReq = mockCreate.mock.calls[4][0] as { messages: Array<{ role: string; content: unknown }> };
    const userMsgs = finalReq.messages.filter(m => m.role === 'user' && typeof m.content !== 'string');
    const firstToolResult = (userMsgs[0].content as Array<{ type: string; content?: string }>).find(b => b.type === 'tool_result');
    expect(firstToolResult?.content).toContain('已压缩为任务相关摘要');
  });

  it('钉⑤反例：不配 max_context_tokens → 预检跳过（无压缩直发,向后兼容）', async () => {
    const { engine, dispatcher, mockCreate, warns } = setup();   // HOST 无 resource_limits
    mockCreate
      .mockResolvedValueOnce(toolUseResp('t1'))
      .mockResolvedValueOnce(toolUseResp('t2'))
      .mockResolvedValueOnce(toolUseResp('t3'))
      .mockResolvedValueOnce(finalResp);

    const result = await runAct(engine, dispatcher);
    expect(result.result).toBe('完成');
    expect(mockCreate).toHaveBeenCalledTimes(4);   // 恰 4 轮——零压缩调用
    expect(warns.some(w => w.includes('[ctx-compress]'))).toBe(false);
    // 终轮请求里 tool_result 全部原文未动
    const finalReq = mockCreate.mock.calls[3][0] as { messages: Array<{ role: string; content: unknown }> };
    const userMsgs = finalReq.messages.filter(m => m.role === 'user' && typeof m.content !== 'string');
    for (const um of userMsgs) {
      const tr = (um.content as Array<{ type: string; content?: string }>).find(b => b.type === 'tool_result');
      expect(tr?.content).toBe(LONG_CONTENT);
    }
  });

  it('钉⑥反例：阈值下界——15999 字符 tool_result 恰在 16000 阈值下,压缩触发也不动它', async () => {
    // 预检触发压缩扫描,但全部块长度 ≤ 阈值 → 零压缩调用、原文保全、流程照走（changed=false 不致死）
    const JUST_UNDER = 'x'.repeat(15999);
    const { engine, dispatcher, mockCreate, warns } = setup({
      resource_limits: { max_context_tokens: 1000, max_tool_iterations: 20, max_output_tokens: 4096, max_replan_attempts: 3 },
    });
    (dispatcher as any).toolProvider = {
      list: () => [{ name: 'read_file', description: '读文件', input_schema: { type: 'object', properties: {} }, requires_commit: false, category: 'basic' }],
      execute: async () => ({ result: JUST_UNDER, success: true }),
    };
    // 3 轮读文件（第 1 轮 tool_result 到轮 4 已脱最近 2 轮保护窗——若阈值判错它就会被压）+ 收尾
    mockCreate
      .mockResolvedValueOnce(toolUseResp('t1'))
      .mockResolvedValueOnce(toolUseResp('t2'))
      .mockResolvedValueOnce(toolUseResp('t3'))
      .mockResolvedValueOnce(finalResp);

    const result = await runAct(engine, dispatcher);
    expect(result.result).toBe('完成');
    expect(mockCreate).toHaveBeenCalledTimes(4);   // 恰 4 轮——零压缩调用
    expect(warns.some(w => w.includes('[ctx-compress]'))).toBe(false);
    const finalReq = mockCreate.mock.calls[3][0] as { messages: Array<{ role: string; content: unknown }> };
    for (const um of finalReq.messages.filter(m => m.role === 'user' && typeof m.content !== 'string')) {
      const tr = (um.content as Array<{ type: string; content?: string }>).find(b => b.type === 'tool_result');
      expect(tr?.content).toBe(JUST_UNDER);   // 15999 字符原文一字不动
    }
  });

  it('钉⑦反例：预检线——估算量在 max_context_tokens×0.8 线下不触发压缩（不到线直发）', async () => {
    // 3×20000 字符≈15000+ token,配 25000 → 线=20000 token,估算恒在线下 → 全程零压缩
    const { engine, dispatcher, mockCreate, warns } = setup({
      resource_limits: { max_context_tokens: 25000, max_tool_iterations: 20, max_output_tokens: 4096, max_replan_attempts: 3 },
    });
    mockCreate
      .mockResolvedValueOnce(toolUseResp('t1'))
      .mockResolvedValueOnce(toolUseResp('t2'))
      .mockResolvedValueOnce(toolUseResp('t3'))
      .mockResolvedValueOnce(finalResp);

    const result = await runAct(engine, dispatcher);
    expect(result.result).toBe('完成');
    expect(mockCreate).toHaveBeenCalledTimes(4);   // 不到线直发——零压缩调用
    expect(warns.some(w => w.includes('[ctx-compress]'))).toBe(false);
    const finalReq = mockCreate.mock.calls[3][0] as { messages: Array<{ role: string; content: unknown }> };
    const userMsgs = finalReq.messages.filter(m => m.role === 'user' && typeof m.content !== 'string');
    const firstToolResult = (userMsgs[0].content as Array<{ type: string; content?: string }>).find(b => b.type === 'tool_result');
    expect(firstToolResult?.content).toBe(LONG_CONTENT);   // 超阈值块也原文保全——没到线就不压
  });

  it('钉⑧正例：压缩故障链——压缩调用连续限流错 → 该块退化头部节选,主流程继续不死', async () => {
    const { engine, dispatcher, mockCreate, warns } = setup();
    const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
    const overflowErr = new Anthropic.BadRequestError('prompt is too long: context length exceeded, too many tokens');
    const rateLimitErr = new Anthropic.RateLimitError('rate limited');

    // 3 轮读大文件 + 轮 4 首撞 overflow → 压缩调用经 callLlmWithRetry,限流档重试 4 次
    // （attempt 0..4 共 5 次 create）全烧尽 → 该块退化头部节选 → 压缩后重试成功收尾
    mockCreate
      .mockResolvedValueOnce(toolUseResp('t1'))
      .mockResolvedValueOnce(toolUseResp('t2'))
      .mockResolvedValueOnce(toolUseResp('t3'))
      .mockRejectedValueOnce(overflowErr)       // 轮 4 首撞
      .mockRejectedValueOnce(rateLimitErr)      // 压缩调用限流×5（重试预算 4 耗尽）
      .mockRejectedValueOnce(rateLimitErr)
      .mockRejectedValueOnce(rateLimitErr)
      .mockRejectedValueOnce(rateLimitErr)
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce(finalResp);        // 退化节选后重试成功——主流程活着

    const result = await runAct(engine, dispatcher);
    expect(result.result).toBe('完成');
    expect(mockCreate).toHaveBeenCalledTimes(10);   // 3 工具+撞墙 1+压缩限流 5+重试 1
    const retryReq = mockCreate.mock.calls[9][0] as { messages: Array<{ role: string; content: unknown }> };
    const userMsgs = retryReq.messages.filter(m => m.role === 'user' && typeof m.content !== 'string');
    const firstToolResult = (userMsgs[0].content as Array<{ type: string; content?: string }>).find(b => b.type === 'tool_result');
    expect(firstToolResult?.content).toContain('头部节选');            // 退化件如实标注
    expect(firstToolResult?.content).not.toContain('任务相关摘要');   // 节选不冒充摘要
    expect(warns.some(w => w.includes('头部节选（压缩调用失败退化）'))).toBe(true);   // 留痕文案同分流
  });

  // @v: anc-exec-cache-control — 滚动断点=移动不是累加（review 面二 D1 实锤:初版只打不清,
  // 5 轮循环 6 断点超 Anthropic 官方上限 4,API 400 拒收长循环必死）
  it('滚动断点钉：N 轮工具循环后 messages 内 cache_control 计数恒 ≤1（修前红:逐轮累积）', async () => {
    const { engine, dispatcher, mockCreate } = setup();
    mockCreate
      .mockResolvedValueOnce(toolUseResp('t1'))
      .mockResolvedValueOnce(toolUseResp('t2'))
      .mockResolvedValueOnce(toolUseResp('t3'))
      .mockResolvedValueOnce(toolUseResp('t4'))
      .mockResolvedValueOnce(finalResp);

    const result = await runAct(engine, dispatcher);
    expect(result.result).toBe('完成');
    // 终轮请求 4 个 user 消息在场——断点只许 1 个（最新那条）,旧断点已清
    const finalReq = mockCreate.mock.calls[4][0] as { messages: Array<{ role: string; content: unknown }> };
    let breakpoints = 0;
    let lastUserHasIt = false;
    const userMsgs = finalReq.messages.filter(m => m.role === 'user' && typeof m.content !== 'string');
    expect(userMsgs.length).toBe(4);
    for (let i = 0; i < userMsgs.length; i++) {
      for (const b of userMsgs[i].content as Array<{ type: string; cache_control?: unknown }>) {
        if (b.type === 'tool_result' && b.cache_control) {
          breakpoints++;
          if (i === userMsgs.length - 1) lastUserHasIt = true;
        }
      }
    }
    expect(breakpoints).toBe(1);          // messages 内恒最多 1 断点（+system 1=总 2,远离上限 4）
    expect(lastUserHasIt).toBe(true);     // 且在最新 user 消息上——滚动语义
  });

  it('单发路径归一：reason/check 激进重组后二次撞 → CONTEXT_OVERFLOW 前缀（原裸 throw）', async () => {
    const engine = new ExecutionEngine();
    engine.initExecution(SIMPLE_SPEC, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    (dispatcher as any).sleep = () => Promise.resolve();
    const mockCreate = (dispatcher as any).defaultClient.messages.create;
    const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
    const overflowErr = new Anthropic.BadRequestError('context length exceeded, too many tokens');
    mockCreate.mockRejectedValue(overflowErr);   // 首发+激进重组重试都撞

    const step = engine.nextStep();
    expect(step.status).toBe('step_ready');
    if (step.status !== 'step_ready') return;
    const executeReason = (dispatcher as any).executeReasonOrCheck.bind(dispatcher);
    await expect(executeReason(step)).rejects.toThrow(/^CONTEXT_OVERFLOW: 激进重组后仍超模型窗/);
  });
});
