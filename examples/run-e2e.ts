#!/usr/bin/env npx tsx
/**
 * 端到端 dispatcher 执行示例——带 debug 日志。
 * 用法：npx tsx examples/run-e2e.ts examples/syntax/code-review.md
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExecutionEngine } from '../src/engine.js';
import { StepDispatcher } from '../src/dispatcher.js';
import type { HostConfig } from '../src/types.js';

const specPath = process.argv[2];
if (!specPath) {
  console.error('Usage: npx tsx examples/run-e2e.ts <spec.md> [--params <json>]');
  process.exit(1);
}

const specMd = readFileSync(resolve(specPath), 'utf-8');

const paramsIdx = process.argv.indexOf('--params');
const params = paramsIdx > 0 ? JSON.parse(process.argv[paramsIdx + 1]) : undefined;

const hostConfig: HostConfig = {
  workspace_dir: process.cwd(),
  sandbox: { mode: 'workspace' },
  api_key: process.env['ANTHROPIC_AUTH_TOKEN'] ?? process.env['ANTHROPIC_API_KEY'] ?? '',
  base_url: process.env['ANTHROPIC_BASE_URL'],
  model: process.env['ANTHROPIC_MODEL'],
};

const engine = new ExecutionEngine();
const initResult = engine.initExecution(specMd, hostConfig, {
  stateDir: '.hopstate',
  logDir: '.hoplog',
  logLevel: 'debug',
});

if (initResult.status !== 'ok') {
  console.error('Init failed:', JSON.stringify(initResult, null, 2));
  process.exit(1);
}

console.log(`✓ Init: instance_id=${initResult.instance_id}`);

if (params) {
  const vars = engine.getVariableStore();
  for (const [k, v] of Object.entries(params)) {
    vars.write(k, v, 'root');
  }
  console.log(`✓ Params injected: ${Object.keys(params).join(', ')}`);
}

const dispatcher = new StepDispatcher(engine, hostConfig);
console.log(`\n▶ Running spec...\n`);

const result = await dispatcher.runSpec();

console.log(`\n▶ Result: ${result.status}`);
if (result.status === 'completed') {
  console.log('Outputs:', JSON.stringify(result.outputs, null, 2));
} else if (result.status === 'failed') {
  console.log('Failure:', result.failure);
} else if (result.status === 'paused') {
  console.log('Paused at step:', result.pause?.step_id);
}

console.log(`\nTokens used: ${result.cumulative_tokens}`);
console.log(`\nLog files in .hoplog/`);
