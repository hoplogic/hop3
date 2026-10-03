// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: hop-cli ^anc-struct-hop-cli
// npm postinstall 钩子入口：装包即装 skill（等价零参数 hopjit install-skill,自动探测载体;不带 --force）。
// 四种环境跳过、任何异常都只向 stderr 打一行指路,退出码恒 0——钩子抛错=npm install 失败=用户连 hopjit
// 命令都拿不到。项目级两件（CC .mcp.json 注册/settings.local.json 放行）经 HOPJIT_POSTINSTALL=1 让
// install-skill 跳过,首次 /hop 时在用户项目里补。见 hop-cli ^anc-cli-postinstall。// @a: anc-cli-postinstall

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { postinstallSkipReason } from './cli.js';

const HINT = '在 agent 里说"装一下 hop",或手动跑 hopjit install-skill';
const distDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(distDir, 'cli.js');
const reason = postinstallSkipReason(process.env, typeof process.getuid === 'function' ? process.getuid() : undefined, dirname(distDir), existsSync(cliPath));
if (reason) {
  process.stderr.write(`[hopjit] 未自动安装 skill（${reason}）——${HINT}\n`);
} else {
  const r = spawnSync(process.execPath, [cliPath, '--json', 'install-skill'], {
    env: { ...process.env, HOPJIT_POSTINSTALL: '1' },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let summary = '';
  try {
    const o = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { status?: string; carriers?: string[] };
    if (o.status === 'ok') summary = `已为 ${(o.carriers ?? []).join(', ')} 装好 /hop（新开会话即可用）`;
  } catch { /* 非 JSON 输出按失败处理 */ }
  if (summary) process.stderr.write(`[hopjit] ${summary}\n`);
  else process.stderr.write(`[hopjit] 未自动安装 skill（${(r.stderr || r.stdout || '').trim().split('\n').pop() || `退出码 ${r.status}`}）——${HINT}\n`);
}
process.exitCode = 0;
