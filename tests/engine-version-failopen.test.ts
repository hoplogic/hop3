// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: exec-engine ^anc-struct-exec-engine
// 引擎版本读取失败的 fail-open 钉（独立文件——须 mock node:fs 的 readFileSync 对 package.json 抛错,
// 混进 engine.test.ts 会污染同文件其余用例的文件读取;设计权威 exec-engine ^anc-exec-engine-min-version-gate
// 第十一轮 review 修:原兜底 0.0.0 落进数值比恒小于一切声明值,读失败时带 engine_min_version 键的 spec
// 全被误拒,与"永不因版本读取问题拒 spec"的设计本意正相反;修后读失败返回 null→闸跳过比对）。
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (String(path).endsWith('package.json')) throw new Error('mock: package.json unreadable');
      return (orig.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof orig.readFileSync,
  };
});

import { ExecutionEngine } from '../src/engine.js';
import type { HostConfig } from '../src/provider-types.js';

const HOST: HostConfig = {
  workspace_dir: '/tmp/test',
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'test-key',
};
const SPEC = `# FO
Id: fo
## Goal
g
Config:
  engine_min_version: 99.0.0
## Outputs
- r: text  # r
## Steps
1. [act free] 干
  + → r: text  # r
`;

// @v: anc-exec-engine-min-version-gate —— 读失败 fail-open:package.json 不可读时带键 spec 照常起跑
//（修前兜底 0.0.0 会把 99.0.0 声明判为版本不足误拒——本钉在旧实装下必红）
describe('engine_min_version 读失败 fail-open（第十一轮 review）', () => {
  it('正例：引擎版本读取失败 → 跳过比对照常起跑（声明 99.0.0 也放行——版本读取问题是宿主装置故障,不拒用户的 spec）', () => {
    const engine = new ExecutionEngine();
    const init = engine.initExecution(SPEC, HOST);
    expect(init.status).toBe('ok');
  });
});
