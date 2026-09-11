// in-process 扩展模块参考例——与主代码库隔离的独立工具库（住 examples/，不在 src/；
// 真实项目里这是你自己仓库中的一个文件）。接口契约：命名导出 execute（必须）+ close（可选），
// 白名单/requires_commit/output_schema 权威在配置 tool_servers 声明侧，本模块只管执行。
// 契约见 docs/design/tool-interface.md ^anc-exec-inprocess-binding。

export function execute(name, args) {
  if (name === 'word_stats') {
    const text = String(args.text ?? '');
    const words = text.split(/\s+/).filter(Boolean);
    return {
      result: {
        words: words.length,
        chars: text.length,
        longest: words.reduce((a, b) => (b.length > a.length ? b : a), ''),
      },
      success: true,
      content_type: 'json',
    };
  }
  if (name === 'boom') {
    throw new Error('模块内部异常（崩溃面参考例——引擎须 catch 住报 EXT_TOOL_ERROR,进程存活）');
  }
  return { result: `unknown tool: ${name}`, success: false, content_type: 'text' };
}

export function close() {
  // 无资源要还——空实现示范可选导出
}
