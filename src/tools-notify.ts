// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: tools ^anc-struct-tools
// 钉钉通知通道（不可逆工具）——内置成员表第二员（todo/0052 通知半边正式形态,2026-08-30 作者三连纠
// 收口"tools 不再直接通过 hopjit cli 外露"后按工具模块重做）。设计 [[tools/dingtalk-notify]]。
// 一份发送实现两个消费口：spec 内 [commit] 步骤经工具面调（requires_commit=true 三闸拦
// act/check 语境）;引擎终态挂点（mcp-server applyResult）进程内直调 sendDingtalk。

import { createHmac } from 'node:crypto';
import type { ToolProvider, ToolDef, ToolResult } from './provider-types.js';

/** 钉钉发送入参（设计 [[tools/dingtalk-notify#^anc-tool-dingtalk-types]] NotifyArgs）。 */
export interface DingtalkMessage {
  text: string;
  title?: string;          // 给了走 markdown（手机通知栏显示标题）,缺席纯 text
  at_mobiles?: string[];   // @人手机号（消息标红——等人停点的提档手段）
}

/** 钉钉群机器人 webhook 发送执行体——工具 execute 与引擎终态挂点共用（一份发送实现两个
 * 消费口,见 [[tools/dingtalk-notify#^anc-tool-dingtalk-sop]]）。凭证恒环境变量：
 * DINGTALK_WEBHOOK 必（缺席=失败值带建法指引,不抛）;DINGTALK_SECRET 可选（在场自动加签:
 * timestamp+"\n"+secret 做 HmacSHA256,base64 后 urlencode 拼 URL——钉钉官方算法,
 * 2026-08-30 真机验证）。失败是值不抛异常——通知失败不该拖垮业务流程。 */
// @a: anc-tool-dingtalk-sop —— 标注恒行注释形态（审计 scan 只认 ///# 行,JSDoc 星号行认不出=等效缺席,review 面四实抓 missing+orphans 双现身）
export async function sendDingtalk(msg: DingtalkMessage): Promise<ToolResult> {
  const webhook = process.env.DINGTALK_WEBHOOK;
  if (!webhook) {
    return { success: false, result: 'DINGTALK_WEBHOOK 未设置——建法:钉钉群→群设置→机器人→自定义机器人（安全设置选加签,SEC 密钥放 DINGTALK_SECRET）', content_type: 'text' };
  }
  let url = webhook;
  const secret = process.env.DINGTALK_SECRET;
  if (secret) {
    const timestamp = Date.now();
    const sign = encodeURIComponent(
      createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'),
    );
    url += `&timestamp=${timestamp}&sign=${sign}`;
  }
  const msgtype = msg.title ? 'markdown' : 'text';
  const at = msg.at_mobiles?.length ? { at: { atMobiles: msg.at_mobiles, isAtAll: false } } : {};
  const body = msg.title
    ? { msgtype, markdown: { title: msg.title, text: msg.text }, ...at }
    : { msgtype, text: { content: msg.text }, ...at };
  try {
    const resp = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const r = await resp.json().catch(() => ({ errcode: -1, errmsg: `HTTP ${resp.status} 非 JSON 响应` })) as { errcode: number; errmsg?: string };
    if (r.errcode !== 0) {
      return { success: false, result: `钉钉拒收 errcode=${r.errcode} errmsg=${r.errmsg}。常见原因:关键词档消息没带设定关键词/加签密钥不对/token 失效`, content_type: 'text' };
    }
    return { success: true, result: JSON.stringify({ sent: true, msgtype }), content_type: 'json' };
  } catch (err) {
    return { success: false, result: `钉钉发送网络失败: ${err instanceof Error ? err.message : String(err)}`, content_type: 'text' };
  }
}

/** 运行状态卡片入参（^anc-cli-notify-reuse RunCardInput——standalone maybeNotify 与复用模式
 * outputWithNotify 两挂点共用的数据面）。 */
export interface RunCardInput {
  spec_title: string;
  state: 'completed' | 'failed' | 'paused';
  completed_steps: number;
  total_steps: number;
  current_step?: string;
  paused_question?: string;
  run_id_tail: string;
}

/** 运行状态卡片组装——一份渲染两处挂点同调（代码归置在通知模块,渲染的调用责任仍在引擎挂点侧,
 * sendDingtalk 仍只收文本——设计 [[tools/dingtalk-notify]] composeRunCard 归置注记）。
 * 徽记三态:✅ 完成 / ❌ 失败 / ⏸️ 等你确认。 // @a: anc-cli-notify-reuse */
export function composeRunCard(input: RunCardInput): { title: string; text: string } {
  const badge = input.state === 'completed' ? '✅ 完成' : input.state === 'failed' ? '❌ 失败' : '⏸️ 等你确认';
  const title = `${badge} ${input.spec_title}`;
  const lines: string[] = [];
  if (input.state === 'paused' && input.paused_question) lines.push(input.paused_question.slice(0, 200));
  if (input.state === 'failed' && input.current_step) lines.push(`失败步 ${input.current_step}`);
  lines.push(`进度: ${input.completed_steps}/${input.total_steps} 步${input.state !== 'failed' && input.current_step ? `  当前: ${input.current_step}` : ''}`);
  lines.push(`run: …${input.run_id_tail}`);
  return { title, text: `### ${title}\n\n${lines.map(l => `- ${l}`).join('\n')}` };
}

/** 钉钉通知通道 Provider——内置成员表第二员（[[tools#^anc-exec-builtin-member-table]]）。
 * wire 名 dingtalk_notify;tool_id=notify 的渠道中立映射由装配层 specs 表承载（换渠道只改
 * 表项,spec 恒用 notify）。requires_commit=true：发出即收不回,act/check 语境被既有
 * COMMIT_REQUIRED 三闸拒——本类零新增拦截代码。 // @a: anc-tool-dingtalk-notify */
export class NotifyToolProvider implements ToolProvider {
  list(): ToolDef[] {
    return [{
      name: 'dingtalk_notify',
      description: '发一条钉钉消息（群机器人 webhook;凭证走环境变量 DINGTALK_WEBHOOK/DINGTALK_SECRET）。发出即收不回——只在 [commit] 步骤调用',
      requires_commit: true,
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '消息正文（title 在场时作 markdown 正文）' },
          title: { type: 'string', description: '可选。给了走 markdown 消息,手机通知栏显示标题' },
          at_mobiles: { type: 'array', items: { type: 'string' }, description: '可选。@人手机号列表' },
        },
        required: ['text'],
      },
    }];
  }

  async execute(tool_name: string, tool_args: Record<string, unknown>): Promise<ToolResult> {
    if (tool_name !== 'dingtalk_notify') {
      return { success: false, result: `未知工具: ${tool_name}`, content_type: 'text' };
    }
    const text = typeof tool_args.text === 'string' ? tool_args.text : '';
    if (!text.trim()) {
      return { success: false, result: 'dingtalk_notify 需要非空 text（消息正文）', content_type: 'text' };
    }
    const title = typeof tool_args.title === 'string' && tool_args.title.trim() ? tool_args.title : undefined;
    const at_mobiles = Array.isArray(tool_args.at_mobiles)
      ? tool_args.at_mobiles.filter((m): m is string => typeof m === 'string' && !!m.trim())
      : undefined;
    return sendDingtalk({ text, ...(title ? { title } : {}), ...(at_mobiles?.length ? { at_mobiles } : {}) });
  }
}
