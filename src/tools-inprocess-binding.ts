// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: tools ^anc-struct-tools
// InProcessBinding——in-process 扩展模块绑定成员：与主代码库隔离的独立工具库装载进引擎进程执行
//（零序列化换失去进程隔离——资格卡审计状态,声明装载=操作者断言）。
// 见 design/tool-interface.md ^anc-exec-inprocess-binding。

import type { ToolProvider, ToolResult, ToolDef } from './provider-types.js';
import type { ToolServerEntry } from './tools-registry.js';
import { checkArgsShallow } from './tools-mcp-binding.js';

const ERROR_SAMPLE_LIMIT = 500;

// 隔离模块须导出的执行面（契约见 design ^anc-exec-inprocess-binding 模块接口节）
interface ExtModule {
  execute(name: string, args: Record<string, unknown>): ToolResult | Promise<ToolResult>;
  close?(): void | Promise<void>;
}

/** in-process 绑定成员：装载隔离工具库（dynamic import），白名单/shape/requires_commit 权威恒在声明侧。
 * 惰性装载：首次 execute 时 import——失败=该次调用 fail。无超时钟（进程内无网络挂死面；经审计代码
 * 的死循环=引擎 bug 同级,同进程无法安全中断不设防）。 // @a: anc-exec-inprocess-binding */
export class InProcessBindingMember implements ToolProvider {
  private mod: ExtModule | null = null;

  constructor(private entry: ToolServerEntry) {}

  /** 工具面 = 注册白名单（与 mcp 成员同构——模块实况不扩权）。 */
  list(): ToolDef[] {
    return this.entry.tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.input_schema ?? { type: 'object', properties: {} },   // 兜底最小合法对象 schema（同 mcp-binding,裸 {} 过不了 OpenAI 门面端点校验）
      requires_commit: t.requires_commit,
    }));
  }

  async execute(tool_name: string, tool_args: Record<string, unknown>): Promise<ToolResult> {
    const spec = this.entry.tools.find(t => t.name === tool_name);
    if (!spec) return { result: `Unknown tool: ${tool_name}（不在模块 '${this.entry.name}' 白名单）`, success: false, content_type: 'text' };

    // 发端校验（与 mcp 同一校验器——双端校验"任何绑定同一套"的发端半边;
    // in-process 无发现源,声明即唯一 schema 源,不声明=发端放行）// @a: anc-exec-tool-shape-check
    if (spec.input_schema) {
      const problem = checkArgsShallow(spec.input_schema, tool_args);
      if (problem) {
        return { result: `INPUT_SCHEMA_MISMATCH: 工具 "${tool_name}" 实参不合 input_schema——${problem}（未调用模块）`, success: false, content_type: 'text' };
      }
    }

    // 惰性装载（首次调用；失败=本次 fail——错误带模块路径+原因）
    if (!this.mod) {
      const path = this.entry.binding.module!;
      let imported: Record<string, unknown>;
      try {
        imported = await import(path) as Record<string, unknown>;
      } catch (err: unknown) {
        return { result: `EXT_MODULE_LOAD_FAILED: 模块 '${this.entry.name}' 装载失败（${path}）——${truncate(errText(err), ERROR_SAMPLE_LIMIT)}`, success: false, content_type: 'text' };
      }
      if (typeof imported['execute'] !== 'function') {
        return { result: `EXT_MODULE_LOAD_FAILED: 模块 '${this.entry.name}'（${path}）缺 execute 命名导出——接口契约见 docs/design/tool-interface.md ^anc-exec-inprocess-binding`, success: false, content_type: 'text' };
      }
      this.mod = imported as unknown as ExtModule;
    }

    // 执行：同步异常被 catch 罩住（进程级破坏〔process.exit/段错误〕不设防——失去进程隔离即本档代价）
    try {
      const r = await this.mod.execute(tool_name, tool_args);
      if (r === null || typeof r !== 'object' || typeof (r as ToolResult).success !== 'boolean') {
        return { result: `EXT_TOOL_BAD_RESULT: 模块 '${this.entry.name}' 工具 "${tool_name}" 返回非 ToolResult 形状——${truncate(JSON.stringify(r), ERROR_SAMPLE_LIMIT)}`, success: false, content_type: 'text' };
      }
      return r;
    } catch (err: unknown) {
      return { result: `EXT_TOOL_ERROR: 模块 '${this.entry.name}' 工具 "${tool_name}" 抛异常——${truncate(errText(err), ERROR_SAMPLE_LIMIT)}`, success: false, content_type: 'text' };
    }
  }

  /** run 终态收：模块 close 尽力而为（与 mcp close 同语义）。 // @a: anc-exec-inprocess-binding */
  async close(): Promise<void> {
    try { await this.mod?.close?.(); } catch { /* run 已终态,清理尽力而为 */ }
    this.mod = null;
  }
}

function errText(err: unknown): string { return err instanceof Error ? err.message : String(err); }
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + `…[截断,原长${s.length}]` : s; }
