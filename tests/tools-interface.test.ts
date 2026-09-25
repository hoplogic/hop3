// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: tools ^anc-struct-tools
// 工具接口标准批次一判据回归——注册文件加载/装配/双端校验/别名/time 内置。
// 见 design/tool-interface.md。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load as yamlLoadTest } from 'js-yaml';
import { loadToolRegistry, enrichParamsComments, type ToolServerEntry } from '../src/tools-registry.js';
import { InProcessBindingMember } from '../src/tools-inprocess-binding.js';
import { CompositeToolProvider } from '../src/tools-composite.js';
import { BodyInterpreter } from '../src/act-body-interpreter.js';
import { parseActBody } from '../src/act-body-parser.js';
import type { HostConfig, ToolProvider } from '../src/provider-types.js';

const HOST: HostConfig = {
  workspace_dir: '/tmp',
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'k',
};

function writeRegistry(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hoptools-'));
  const p = join(dir, 'hoptools.yaml');
  writeFileSync(p, yaml);
  return p;
}

const VALID_YAML = `
tool_servers:
  - name: bailian_search
    binding: { kind: mcp, transport: http, url: "https://example.com/mcp", auth_env: DASHSCOPE_API_KEY }
    tools:
      - name: bailian_web_search
        requires_commit: false
        output_schema: { pages: ['yaml'] }
        unwrap: json-in-text
`;

// @v: anc-config-tool-registry, anc-type-tool-spec, anc-type-tool-binding —— 加载即声明态类型的形状验证
describe('hoptools.yaml 加载（fail-fast）', () => {
  it('正例：合法文件加载成功——binding 归一/工具白名单/unwrap 保留', () => {
    const entries = loadToolRegistry(writeRegistry(VALID_YAML));
    expect(entries).toHaveLength(1);
    expect(entries[0].binding).toMatchObject({ kind: 'mcp', transport: 'http', auth_env: 'DASHSCOPE_API_KEY' });
    expect(entries[0].tools[0]).toMatchObject({ name: 'bailian_web_search', requires_commit: false, unwrap: 'json-in-text' });
  });

  // 行尾 # 说明回填（^anc-tool-params-notes,todo/0050 补装——设计承诺"parser 收说明入结构",
  // 此前 yamlLoad 后裸注释即丢,照设计示例写的用户参数说明被静默丢弃）
  // @v: anc-tool-params-notes
  describe('params 短形态行尾 # 说明回填（todo/0050）', () => {
    it('正例：短形态带行尾 # 说明 → 加载后 params 条目含 description（设计示例原样 fixture——照示例写的用户不再丢说明）', () => {
      const yaml = `
tool_servers:
  - name: duty-im
    binding: { kind: mcp, transport: http, url: "https://im.example/mcp", auth_env: IM_KEY }
    tools:
      - name: send_message
        requires_commit: true
        params:
          - channel: line     # 目标频道标识——值班群的群 ID（形如 "oc_a1b2c3"）,不是群名称;错传群名平台报 404
          - content: text     # 消息正文全文——发送即所见,无二次确认
`;
      const t = loadToolRegistry(writeRegistry(yaml))[0].tools[0];
      expect(t.params).toEqual([
        { name: 'channel', type: 'line', description: '目标频道标识——值班群的群 ID（形如 "oc_a1b2c3"）,不是群名称;错传群名平台报 404' },
        { name: 'content', type: 'text', description: '消息正文全文——发送即所见,无二次确认' },
      ]);
    });

    it('正例：两个工具各有同名同型参数但说明不同 → 各归其主（文本行序对齐,顺序消费不串）', () => {
      const yaml = `
tool_servers:
  - name: multi
    binding: { kind: mcp, transport: http, url: "https://x.example/mcp", auth_env: X_KEY }
    tools:
      - name: tool_a
        requires_commit: false
        params:
          - query: text  # A 的查询词说明
      - name: tool_b
        requires_commit: false
        params:
          - query: text  # B 的查询词说明
`;
      const tools = loadToolRegistry(writeRegistry(yaml))[0].tools;
      expect(tools[0].params?.[0].description).toBe('A 的查询词说明');
      expect(tools[1].params?.[0].description).toBe('B 的查询词说明');
    });

    it('正例：长形态显式 description 不被行尾注释覆盖（显式优先,回填只补缺）', () => {
      const yaml = `
tool_servers:
  - name: mix
    binding: { kind: mcp, transport: http, url: "https://x.example/mcp", auth_env: X_KEY }
    tools:
      - name: t1
        requires_commit: false
        params:
          - plain: line  # 短形态的说明
          - name: rich
            type: text
            description: 长形态显式说明
`;
      const t = loadToolRegistry(writeRegistry(yaml))[0].tools[0];
      expect(t.params).toEqual([
        { name: 'plain', type: 'line', description: '短形态的说明' },
        { name: 'rich', type: 'text', description: '长形态显式说明' },
      ]);
    });

    it('反例：params 条目类型 number → TOOLS_FILE_INVALID 拒（词表漂移修——int/float 唯二,与 output_schema 同表）', () => {
      const yaml = `
tool_servers:
  - name: bad
    binding: { kind: mcp, transport: http, url: "https://x.example/mcp", auth_env: X_KEY }
    tools:
      - name: t1
        requires_commit: false
        params:
          - total: number  # 总数
`;
      expect(() => loadToolRegistry(writeRegistry(yaml))).toThrow(/不在词汇表/);
    });

    it('反例：tools 数组的 - name: 工具名 # 注释 不被误配进参数说明（值是工具名不在类型词表,不进候选）', () => {
      const yaml = `
tool_servers:
  - name: guard
    binding: { kind: mcp, transport: http, url: "https://x.example/mcp", auth_env: X_KEY }
    tools:
      - name: text  # 这是工具名恰与类型词撞名的注释,不该进任何参数说明
        tool_id: text_tool
        requires_commit: false
        params:
          - q: text
`;
      const t = loadToolRegistry(writeRegistry(yaml))[0].tools[0];
      expect(t.params).toEqual([{ name: 'q', type: 'text' }]);
    });
  });

  // 回填算法重写钉（^anc-tool-params-notes v0.6.2——review 批四处实证缺陷:池化消费错配/
  // 工具名撞词表词/notes 污染/引号数组丢弃;重写=params 节窗口+序位配对,宁漏勿错配）
  // @v: anc-tool-params-notes
  // review B-6:工具参数位 line(nonempty) 收编钉（parser 归一站已收,词表不认=归一了用不上）
// @v: anc-type-constraint-annotation
describe('工具参数 line(nonempty) 词表收编（review B-6）', () => {
  it('正例：注册文件参数声明 line(nonempty) → 词表放行', () => {
    const yaml = `
tool_servers:
  - name: t
    binding: { kind: mcp, transport: http, url: "https://x.example/mcp", auth_env: X_KEY }
    tools:
      - name: t1
        requires_commit: false
        params:
          - name: q
            type: line(nonempty)
            description: 非空查询词
`;
    const entries = loadToolRegistry(writeRegistry(yaml));
    expect(entries[0].tools[0].params?.[0].type).toBe('line(nonempty)');
  });
});

describe('回填算法窗口化（review 批四缺陷钉）', () => {
    it('反例转正①：同名同型的无注释条目不偷别人的说明（首版 tool_a 无注释偷走 tool_b 的——序位配对各归其窗）', () => {
      const yaml = `
tool_servers:
  - name: multi
    binding: { kind: mcp, transport: http, url: "https://x.example/mcp", auth_env: X_KEY }
    tools:
      - name: tool_a
        requires_commit: false
        params:
          - q: text
      - name: tool_b
        requires_commit: false
        params:
          - q: text  # B 的查询词说明
`;
      const tools = loadToolRegistry(writeRegistry(yaml))[0].tools;
      expect(tools[0].params?.[0].description).toBeUndefined();
      expect(tools[1].params?.[0].description).toBe('B 的查询词说明');
    });

    it('反例转正②：参数恰叫 name 且工具名行带注释 → 工具名行注释不错配进参数（窗口外行不进配对）', () => {
      const yaml = `
tool_servers:
  - name: guard
    binding: { kind: mcp, transport: http, url: "https://x.example/mcp", auth_env: X_KEY }
    tools:
      - name: text  # 工具名恰是类型词的注释
        tool_id: text_tool
        requires_commit: false
        params:
          - name: line
`;
      const t = loadToolRegistry(writeRegistry(yaml))[0].tools[0];
      expect(t.params).toEqual([{ name: 'name', type: 'line' }]);
    });

    it('反例转正③：notes 块里的自由文本列表行不污染回填（窗口只罩 params 节）', () => {
      const yaml = `
tool_servers:
  - name: notes-guard
    binding: { kind: mcp, transport: http, url: "https://x.example/mcp", auth_env: X_KEY }
    tools:
      - name: t1
        requires_commit: false
        notes: |
          使用注意:
          - retries: int  # 这是 notes 里的自由文本不是参数说明
        params:
          - retries: int
`;
      const t = loadToolRegistry(writeRegistry(yaml))[0].tools[0];
      expect(t.params).toEqual([{ name: 'retries', type: 'int' }]);
    });

    it('反例转正④：带引号的数组类型 "[line]" 短形态说明照常回填（首版类型捕获含引号不过词表静默丢弃）', () => {
      const yaml = `
tool_servers:
  - name: arr
    binding: { kind: mcp, transport: http, url: "https://x.example/mcp", auth_env: X_KEY }
    tools:
      - name: t1
        requires_commit: false
        params:
          - tags: "[line]"  # 标签清单——每项一个短标签
`;
      const t = loadToolRegistry(writeRegistry(yaml))[0].tools[0];
      expect(t.params?.[0].description).toBe('标签清单——每项一个短标签');
    });

    it('反例转正（B2-1 甲）：params: [] 内联空数组不耗窗——后续工具窗口不左移错配（探针实撞:同签名时 t1 曾拿到乙的说明）', () => {
      const yaml = `
tool_servers:
  - name: shift
    binding: { kind: mcp, transport: http, url: "https://x.example/mcp", auth_env: X_KEY }
    tools:
      - name: t0
        requires_commit: false
        params: []
      - name: t1
        requires_commit: false
        params:
          - q: text  # 甲的说明
      - name: t2
        requires_commit: false
        params:
          - q: text  # 乙的说明
`;
      const tools = loadToolRegistry(writeRegistry(yaml))[0].tools;
      expect(tools[1].params?.[0].description).toBe('甲的说明');
      expect(tools[2].params?.[0].description).toBe('乙的说明');
    });

    it('反例转正（B2-1 乙）：notes 字面块内的 params: 示例行不造伪窗口——全局对账门拦供需失衡,整文件弃配不错配', () => {
      const yaml = `
tool_servers:
  - name: fake-win
    binding: { kind: mcp, transport: http, url: "https://x.example/mcp", auth_env: X_KEY }
    tools:
      - name: t1
        requires_commit: false
        notes: |
          调用示例:
          params:
            - q: text  # 假说明来自notes示例
        params:
          - q: text
`;
      const t = loadToolRegistry(writeRegistry(yaml))[0].tools[0];
      // 伪窗+真窗=2 窗 vs 1 个带 params 工具——总量失衡整文件弃配,真参数不带假说明
      expect(t.params).toEqual([{ name: 'q', type: 'text' }]);
    });

    it('边界：窗口条目数与 params 数组不符 → 整窗口弃配零回填（宁漏勿错配）', () => {
      const yaml = `
tool_servers:
  - name: mismatch
    binding: { kind: mcp, transport: http, url: "https://x.example/mcp", auth_env: X_KEY }
    tools:
      - name: t1
        requires_commit: false
        params:
          - a: text  # 甲说明
          - b: line  # 乙说明
`;
      // 构造窗口错位:直接改 servers 对象删掉一个条目再回填——用底层函数面钉
      const raw = yamlLoadTest(yaml) as { tool_servers: { tools: { params: unknown[] }[] }[] };
      raw.tool_servers[0].tools[0].params.pop();   // params 只剩 1 条,窗口有 2 行
      enrichParamsComments(yaml, raw.tool_servers);
      expect((raw.tool_servers[0].tools[0].params[0] as { description?: string }).description).toBeUndefined();
    });
  });

  // params/notes 语义面（^anc-tool-params-notes——2026-08-25 作者定'逐参数展开避免望词生义'）
  // @v: anc-tool-params-notes
  it('正例：params 短形态+description 长形态+notes 全收;仅 params 时 input_schema 机械生成', () => {
    const yaml = `
tool_servers:
  - name: duty-im
    binding: { kind: mcp, transport: http, url: "https://im.example/mcp", auth_env: IM_KEY }
    tools:
      - name: send_message
        requires_commit: true
        params:
          - channel: line
          - name: content
            type: text
            description: 消息正文全文——发送即所见
        notes: |
          单条上限 4000 字符,超长须分批
`;
    const entries = loadToolRegistry(writeRegistry(yaml));
    const t = entries[0].tools[0];
    expect(t.params).toEqual([
      { name: 'channel', type: 'line' },
      { name: 'content', type: 'text', description: '消息正文全文——发送即所见' },
    ]);
    expect(t.notes).toContain('4000');
    // input_schema 机械生成（类型词映射 JSON Schema）
    expect(t.input_schema).toMatchObject({ type: 'object', required: ['channel', 'content'] });
    expect((t.input_schema as { properties: Record<string, { type: string }> }).properties.content.type).toBe('string');
  });

  // 零参工具的 schema 兜底（2026-08-28 实撞:browser_snapshot 无 params 无 input_schema,
  // 注册面不生成 schema → LLM 通道工具清单裸缺,OpenAI 门面型 Anthropic 兼容端点(DeepSeek)
  // 400 "schema must be a JSON Schema of type object, got type null",deep-research fan-out
  // 六子实例全灭;真 Anthropic 端点宽容裸缺故此前未暴露）。// @v: anc-exec-mcp-binding
  it('正例：零参工具（params 与 input_schema 双缺席）→ 生成最小合法对象 schema,不裸缺', () => {
    const yaml = `
tool_servers:
  - name: pw
    binding: { kind: mcp, transport: stdio, command: npx, args: [-y, "@playwright/mcp@latest"] }
    tools:
      - name: browser_snapshot
        requires_commit: false
        notes: 当前页快照
`;
    const entries = loadToolRegistry(writeRegistry(yaml));
    const t = entries[0].tools[0];
    expect(t.input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('反例：显式 input_schema 在场时不被兜底覆盖（声明优先）', () => {
    const yaml = `
tool_servers:
  - name: pw
    binding: { kind: mcp, transport: stdio, command: npx, args: [-y, "@playwright/mcp@latest"] }
    tools:
      - name: browser_navigate
        requires_commit: false
        input_schema: { type: object, properties: { url: { type: string } }, required: [url] }
`;
    const entries = loadToolRegistry(writeRegistry(yaml));
    const t = entries[0].tools[0];
    expect(t.input_schema).toMatchObject({ type: 'object', required: ['url'] });
  });

  it('反例：params 类型词表外报错;params 与 input_schema 参数名集合不一致报错（防两面漂移）', () => {
    const badType = `
tool_servers:
  - name: s
    binding: { kind: mcp, transport: http, url: "https://x/mcp" }
    tools:
      - name: t1
        requires_commit: false
        params:
          - p: strang
`;
    expect(() => loadToolRegistry(writeRegistry(badType))).toThrow(/类型 'strang' 不在词汇表/);
    const drift = `
tool_servers:
  - name: s
    binding: { kind: mcp, transport: http, url: "https://x/mcp" }
    tools:
      - name: t2
        requires_commit: false
        input_schema: { type: object, properties: { a: { type: string } } }
        params:
          - b: line
`;
    expect(() => loadToolRegistry(writeRegistry(drift))).toThrow(/参数名集合与 input_schema.properties 不一致/);
  });

  it('反例：文件不存在 → TOOLS_FILE_MISSING 指路文法', () => {
    expect(() => loadToolRegistry('/nonexistent/hoptools.yaml')).toThrow(/TOOLS_FILE_MISSING.*tool-interface/);
  });

  it('反例：binding 内明文凭证字段 → TOOLS_FILE_PLAINTEXT_KEY 拒（api_key_env 同纪律）', () => {
    const p = writeRegistry(`
tool_servers:
  - name: s
    binding: { kind: mcp, url: "https://x", api_key: "sk-plaintext" }
    tools: [{ name: t, requires_commit: false }]
`);
    expect(() => loadToolRegistry(p)).toThrow(/TOOLS_FILE_PLAINTEXT_KEY.*auth_env/);
  });

  it('反例：requires_commit 缺失 → 拒（不可逆标记不设缺省，声明即负责）', () => {
    const p = writeRegistry(`
tool_servers:
  - name: s
    binding: { kind: mcp, url: "https://x" }
    tools: [{ name: t }]
`);
    expect(() => loadToolRegistry(p)).toThrow(/requires_commit 缺失/);
  });

  it('反例：中文工具名无 tool_id → 拒（body 无法调用，须声明语言面 ID）', () => {
    const p = writeRegistry(`
tool_servers:
  - name: s
    binding: { kind: mcp, url: "https://x" }
    tools: [{ name: 企业工商数据模糊查询, requires_commit: false }]
`);
    expect(() => loadToolRegistry(p)).toThrow(/非合法标识符.*tool_id/);
  });

  it('正例：中文工具名带 tool_id → 通过', () => {
    const p = writeRegistry(`
tool_servers:
  - name: s
    binding: { kind: mcp, url: "https://x" }
    tools: [{ name: 企业工商数据模糊查询, tool_id: company_search, requires_commit: false }]
`);
    const entries = loadToolRegistry(p);
    expect(entries[0].tools[0].tool_id).toBe('company_search');
  });

  it('反例：unwrap 枚举外值 → 拒', () => {
    const p = writeRegistry(`
tool_servers:
  - name: s
    binding: { kind: mcp, url: "https://x" }
    tools: [{ name: t, requires_commit: false, unwrap: base64 }]
`);
    expect(() => loadToolRegistry(p)).toThrow(/unwrap.*json-in-text/);
  });
});

// 测试替身：可编程外部成员（批次二 McpBinding 的注入位——批次一按 tool-interface 注入契约测装配）
function stubProvider(tools: Record<string, { requires_commit?: boolean; result: unknown }>): ToolProvider {
  return {
    list: () => Object.entries(tools).map(([name, t]) => ({ name, description: '', input_schema: {}, requires_commit: t.requires_commit ?? false })),
    execute: async (name) => {
      const t = tools[name];
      if (!t) return { result: `no such tool ${name}`, success: false, content_type: 'text' };
      return { result: typeof t.result === 'string' ? t.result : JSON.stringify(t.result), success: true, content_type: 'text' };
    },
  };
}

function makeComposite(entry: ToolServerEntry, stub: ToolProvider, host: HostConfig = HOST): CompositeToolProvider {
  return new CompositeToolProvider(host, { registry: [entry], externalProviderFor: () => stub });
}

const SEARCH_ENTRY: ToolServerEntry = {
  name: 'bailian_search',
  binding: { kind: 'mcp', transport: 'http', url: 'https://example.com/mcp' },
  tools: [{ name: 'bailian_web_search', requires_commit: false, output_schema: { pages: ['yaml'] }, unwrap: 'json-in-text' }],
};

// @v: anc-exec-tool-composite
describe('CompositeToolProvider 装配', () => {
  // @v: anc-exec-builtin-member-table —— 并集例也是成员表装配面的钉（面四 G3 抓 @v 只罩下例后上移补位）
  it('正例：list()=内置组∪外部成员并集（file 十七件〔0070 批 search_file 扩员〕+run_script 一件〔0110 批执行类工具组扩员〕+notify 两条目〔wire 名+tool_id〕+外部 1 件）', () => {
    const c = makeComposite(SEARCH_ENTRY, stubProvider({ bailian_web_search: { result: '{}' } }));
    const names = c.list().map(t => t.name);
    expect(names).toContain('read');
    expect(names).toContain('validate_spec');
    expect(names).toContain('bailian_web_search');
    expect(names).toContain('dingtalk_notify');   // 内置成员表第二员（^anc-exec-builtin-member-table）
    expect(names).toContain('notify');            // tool_id 渠道中立条目
    expect(names).toContain('run_script');        // 执行类工具组一件（^anc-exec-builtin-run-script）
    expect(names.length).toBe(21);
  });

  // @v: anc-exec-builtin-member-table, anc-tool-dingtalk-notify
  it('正例：notify 条目带 requires_commit=true（specs 表合并进 ToolDef——act 拦截判据源）', () => {
    const c = makeComposite(SEARCH_ENTRY, stubProvider({ bailian_web_search: { result: '{}' } }));
    const byName = new Map(c.list().map(t => [t.name, t]));
    expect(byName.get('dingtalk_notify')?.requires_commit).toBe(true);
    expect(byName.get('notify')?.requires_commit).toBe(true);   // tool_id 条目同带（不带=语言面调用绕拦截）
    expect(byName.get('read')?.requires_commit).toBe(false);    // file 组照旧 false 不被波及
  });

  it('反例：外部工具与内置同名 → TOOLS_NAME_CONFLICT fail-fast（不覆盖）', () => {
    const entry: ToolServerEntry = { ...SEARCH_ENTRY, tools: [{ name: 'read', requires_commit: false }] };
    expect(() => makeComposite(entry, stubProvider({ read: { result: 'x' } })))
      .toThrow(/TOOLS_NAME_CONFLICT.*read.*builtin-file/);
  });

  it('反例：tool_id 与既有工具名冲突 → fail-fast', () => {
    const entry: ToolServerEntry = {
      ...SEARCH_ENTRY,
      tools: [{ name: '中文工具', tool_id: 'write', requires_commit: false }],
    };
    expect(() => makeComposite(entry, stubProvider({ '中文工具': { result: 'x' } })))
      .toThrow(/TOOLS_NAME_CONFLICT.*tool_id "write"/);
  });

  it('正例：宿主注入 provider 并入成员（不再整体替换——file 十件仍在场）', () => {
    const host: HostConfig = { ...HOST, tool_provider: stubProvider({ my_tool: { result: 'ok' } }) };
    const c = new CompositeToolProvider(host);
    const names = c.list().map(t => t.name);
    expect(names).toContain('read');      // 旧语义下 tool_provider 在场时 file 十件消失——新语义并入
    expect(names).toContain('my_tool');
  });

  it('正例：requires_commit 以声明为准覆盖成员自报（annotations 不可信的引擎侧落点）', () => {
    const entry: ToolServerEntry = {
      ...SEARCH_ENTRY,
      tools: [{ name: 'bailian_web_search', requires_commit: true, unwrap: 'json-in-text' }],   // 声明升格 commit 级
    };
    const c = makeComposite(entry, stubProvider({ bailian_web_search: { requires_commit: false, result: '{}' } }));
    const def = c.list().find(t => t.name === 'bailian_web_search')!;
    expect(def.requires_commit).toBe(true);   // 成员自报 false 被声明 true 压过
  });
});

// @v: anc-exec-tool-shape-check
describe('双端校验（unwrap/output_schema）', () => {
  it('正例：unwrap json-in-text 解包 + shape 相合 + 多余字段裁剪', async () => {
    const entry: ToolServerEntry = {
      ...SEARCH_ENTRY,
      tools: [{ name: 'bailian_web_search', requires_commit: false, output_schema: { pages: ['yaml'] }, unwrap: 'json-in-text' }],
    };
    const c = makeComposite(entry, stubProvider({
      bailian_web_search: { result: { pages: [{ title: 't' }], request_id: 'r1', status: 200 } },
    }));
    const r = await c.execute('bailian_web_search', { query: 'x' });
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ pages: [{ title: 't' }] });   // request_id/status 被裁
  });

  it('反例：缺声明字段 → SCHEMA_DEVIATION（带期望+实际截断样本——供 adaptive 适配的偏差明细）', async () => {
    const c = makeComposite(SEARCH_ENTRY, stubProvider({
      bailian_web_search: { result: { data: [] } },   // 无 pages
    }));
    const r = await c.execute('bailian_web_search', { query: 'x' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/SCHEMA_DEVIATION.*缺字段: pages.*期望形状.*实际样本/s);
  });

  it('反例：unwrap 解包失败（非 JSON text）→ SCHEMA_DEVIATION 同语义', async () => {
    const c = makeComposite(SEARCH_ENTRY, stubProvider({
      bailian_web_search: { result: '<html>gateway error</html>' },
    }));
    const r = await c.execute('bailian_web_search', { query: 'x' });
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/SCHEMA_DEVIATION.*json-in-text 解析失败/);
  });

  it('正例：无 output_schema 声明 → 原样放行（裸奔容忍——warn 由消费方记）', async () => {
    const entry: ToolServerEntry = {
      ...SEARCH_ENTRY,
      tools: [{ name: 'bailian_web_search', requires_commit: false, unwrap: 'json-in-text' }],
    };
    const c = makeComposite(entry, stubProvider({
      bailian_web_search: { result: { anything: 1, goes: true } },
    }));
    const r = await c.execute('bailian_web_search', { query: 'x' });
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ anything: 1, goes: true });
  });

  it('正例：tool_id 调用路由到 wire 名（中文名工具经别名可达）', async () => {
    const entry: ToolServerEntry = {
      ...SEARCH_ENTRY,
      tools: [{ name: '企业工商数据模糊查询', tool_id: 'company_search', requires_commit: false, unwrap: 'json-in-text', output_schema: { data: {} } }],
    };
    const c = makeComposite(entry, stubProvider({
      '企业工商数据模糊查询': { result: { data: { total: 10 }, status: '200' } },
    }));
    const r = await c.execute('company_search', {});
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ data: { total: 10 } });
  });

  it('反例：偏差样本超长被截断（百炼网关报文实撞——防 FailRecord 爆炸）', async () => {
    const c = makeComposite(SEARCH_ENTRY, stubProvider({
      bailian_web_search: { result: 'x'.repeat(2000) },
    }));
    const r = await c.execute('bailian_web_search', { query: 'x' });
    expect(r.success).toBe(false);
    expect(String(r.result).length).toBeLessThan(900);
    expect(String(r.result)).toContain('截断');
  });
});

// @v: anc-exec-tool-composite, anc-exec-tool-shape-check —— tool_id 经 body 全链（review 探针补:
// list() 不含 tool_id 时中文名工具经别名调用被判未知工具——修后端到端锁死）
describe('tool_id 经 hop_python body 调用（端到端）', () => {
  const idEntry: ToolServerEntry = {
    name: 's',
    binding: { kind: 'mcp', transport: 'http', url: 'https://x' },
    tools: [{ name: '企业工商数据模糊查询', tool_id: 'company_search', requires_commit: false, unwrap: 'json-in-text', output_schema: { data: {} } }],
  };
  const idStub = stubProvider({ '企业工商数据模糊查询': { result: { data: { total: 10 }, status: '200' } } });

  function bodyOf(src: string) {
    const errors: import('../src/errors.js').ParseError[] = [];
    const b = parseActBody(src.split('\n'), 1, errors);
    expect(errors).toEqual([]);
    return b!;
  }

  it('正例：body 经 tool_id 调中文名工具——list 名单可见、路由到 wire 名、shape 校验生效', async () => {
    const c = makeComposite(idEntry, idStub);
    const interp = new BodyInterpreter({ inputs: {}, toolProvider: c, allowCommit: false, toolCallLog: [], warnLog: [] });
    const out = await interp.run(bodyOf('x = company_search(kw: "阿里")'), [{ name: 'x', type: 'yaml', description: '' }]);
    expect(out.x).toEqual({ data: { total: 10 } });   // unwrap+裁剪全链生效
  });

  it('反例：requires_commit=true 的工具经 tool_id 在 act body 调用 → COMMIT_REQUIRED 拦截（语言面 ID 不豁免安全闸）', async () => {
    const entry: ToolServerEntry = {
      ...idEntry,
      tools: [{ name: '危险中文工具', tool_id: 'danger_tool', requires_commit: true }],
    };
    const c = makeComposite(entry, stubProvider({ '危险中文工具': { requires_commit: true, result: 'x' } }));
    const interp = new BodyInterpreter({ inputs: {}, toolProvider: c, allowCommit: false, toolCallLog: [], warnLog: [] });
    await expect(interp.run(bodyOf('x = danger_tool(a: 1)'), [{ name: 'x', type: 'yaml', description: '' }]))
      .rejects.toThrow(/COMMIT_REQUIRED/);
  });
});

// @v: anc-exec-time-builtins
describe('time 实例上下文内置（now/today）', () => {
  const OUT = [{ name: 'ts', type: 'line', description: '' }, { name: 'd', type: 'line', description: '' }];
  const noopProvider: ToolProvider = { list: () => [], execute: async () => ({ result: '', success: true }) };

  function body(src: string) {
    const errors: import('../src/errors.js').ParseError[] = [];
    const b = parseActBody(src.split('\n'), 1, errors);
    expect(errors).toEqual([]);
    return b!;
  }

  it('正例：now() 返回 ISO 8601 形状、today() 返回 YYYY-MM-DD——值入 timeJournal', async () => {
    const journal: string[] = [];
    const interp = new BodyInterpreter({ inputs: {}, toolProvider: noopProvider, allowCommit: false, toolCallLog: [], warnLog: [], timeJournal: journal });
    const out = await interp.run(body('ts = now()\nd = today()'), OUT);
    expect(String(out.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(String(out.d)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(journal).toEqual([out.ts, out.d]);
  });

  it('正例：重放取记录值——journal 预填时不取新时钟（重放确定性）', async () => {
    const journal = ['2020-01-01T00:00:00+08:00', '2020-01-01'];
    const interp = new BodyInterpreter({ inputs: {}, toolProvider: noopProvider, allowCommit: false, toolCallLog: [], warnLog: [], timeJournal: journal });
    const out = await interp.run(body('ts = now()\nd = today()'), OUT);
    expect(out.ts).toBe('2020-01-01T00:00:00+08:00');
    expect(out.d).toBe('2020-01-01');
  });

  it('反例：无时间上下文（timeJournal 缺席）→ 响亮报错不静默', async () => {
    const interp = new BodyInterpreter({ inputs: {}, toolProvider: noopProvider, allowCommit: false, toolCallLog: [], warnLog: [] });
    await expect(interp.run(body('ts = now()'), OUT)).rejects.toThrow(/now 不可用.*时间上下文/);
  });

  it('反例：条件路径（ACT_BUILTINS 占位）调用 → 报"需实例上下文"', async () => {
    const { ACT_BUILTINS } = await import('../src/act-builtins.js');
    expect(() => ACT_BUILTINS.get('now')!.fn([])).toThrow(/需要实例上下文/);
    expect(() => ACT_BUILTINS.get('today')!.fn([])).toThrow(/需要实例上下文/);
  });
});

// @v: anc-exec-time-builtins —— 构造点接线（此前只测解释器层,两个真实执行路径零覆盖——设计-代码不一致实撞 2026-08-12）
describe('time 内置——执行路径接线', () => {
  it('正例：独立模式 dispatcher.executeActBody——body 内 now() 可用（构造点已传 timeJournal）', async () => {
    const { ExecutionEngine } = await import('../src/engine.js');
    const { StepDispatcher } = await import('../src/dispatcher.js');
    const spec = ['# T', 'Id: t', '## Goal', 'g', '## Outputs', '- ts: line  # 时刻', '## Steps',
      '1. [act] 取时刻', '  + → ts: line  # 时刻', '  > 纯计算', '  > ```hop_python', '  > ts = now()', '  > ```',
    ].join('\n');
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    const dispatcher = new StepDispatcher(engine, HOST);
    const next = engine.nextStep();
    expect(next.status).toBe('step_ready');
    if (next.status !== 'step_ready') return;
    await (dispatcher as unknown as { handleStepReady: (s: unknown) => Promise<void> }).handleStepReady.call(dispatcher, next);
    expect(engine.getStepStates().get('1')).toBe('done');
    expect(String(engine.getVariableStore().read('ts', 'root'))).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('正例：复用模式跨进程重放——挂起点前求值的 now() 随 state 落盘,新进程重放取记录值', async () => {
    const { ExecutionEngine } = await import('../src/engine.js');
    const { readFileSync } = await import('node:fs');
    const spec = ['# T', 'Id: t', '## Goal', 'g', '## Outputs', '- ts: line  # 时刻', '## Steps',
      '1. [act] 先取时刻再调工具', '  + → ts: line  # 时刻', '  > 工具', '  > ```hop_python',
      '  > ts = now()', '  > data = my_tool(x: "1")', '  > ```',
    ].join('\n');
    const stateDir = mkdtempSync(join(tmpdir(), 'time-xproc-'));
    const e1 = new ExecutionEngine();
    const init = e1.initExecution(spec, HOST, { stateDir }) as { status: string; instance_id: string };
    expect(init.status).toBe('ok');
    // 进程1：推进到 tool_request 挂起——now() 已求值,值应已随 state 落盘
    const r1 = await e1.advanceToCaller();
    expect(r1.status).toBe('tool_request');
    const instanceDir = join(stateDir, init.instance_id);
    const state = JSON.parse(readFileSync(join(instanceDir, 'state.json'), 'utf-8'));
    const recorded = state.time_journal?.['1']?.[0];
    expect(String(recorded)).toMatch(/^\d{4}-\d{2}-\d{2}T/);   // 挂起点时间值在盘上
    // 进程2：load 重建 + 提交工具结果 + 重放——ts 必须取记录值（不取新时钟）
    const e2 = ExecutionEngine.load(instanceDir);
    e2.submitToolResult('1', { result: 'r', success: true });
    const r2 = await e2.advanceToCaller();
    expect(r2.status).not.toBe('tool_request');   // journal 代入,不再挂起
    expect(e2.getVariableStore().read('ts', 'root')).toBe(recorded);
  });

  it('反例：步骤完成后 timeJournal 已清——重试/重跑取新时间是预期语义（不重放陈旧时刻）', async () => {
    const { ExecutionEngine } = await import('../src/engine.js');
    const spec = ['# T', 'Id: t', '## Goal', 'g', '## Outputs', '- ts: line  # 时刻', '## Steps',
      '1. [act] 取时刻', '  + → ts: line  # 时刻', '  > 纯计算', '  > ```hop_python', '  > ts = now()', '  > ```',
    ].join('\n');
    const engine = new ExecutionEngine();
    engine.initExecution(spec, HOST);
    const r = await engine.advanceToCaller();
    expect(r.status).not.toBe('tool_request');
    const tj = (engine as unknown as { timeJournal: Record<string, string[]> }).timeJournal;
    expect(tj['1']).toBeUndefined();   // 本步跑完清账（与 tool_journal 同时机）
  });
});

// @v: anc-config-tool-registry —— call_timeout_ms 文法（五点需求⑤收尾）
describe('call_timeout_ms 注册文法', () => {
  it('正例：正数毫秒被解析进条目', () => {
    const p = writeRegistry(['tool_servers:', '  - name: s', '    call_timeout_ms: 5000',
      '    binding: { kind: mcp, transport: stdio, command: /bin/cat }',
      '    tools:', '      - name: t', '        requires_commit: false'].join('\n'));
    expect(loadToolRegistry(p)[0].call_timeout_ms).toBe(5000);
  });
  it('反例：非正数 → TOOLS_FILE_INVALID', () => {
    const p = writeRegistry(['tool_servers:', '  - name: s', '    call_timeout_ms: 0',
      '    binding: { kind: mcp, transport: stdio, command: /bin/cat }',
      '    tools:', '      - name: t', '        requires_commit: false'].join('\n'));
    expect(() => loadToolRegistry(p)).toThrow(/call_timeout_ms 须为正数/);
  });
  it('正例：缺省不设 → 条目无该字段（绑定层用 60s 缺省）', () => {
    const p = writeRegistry(['tool_servers:', '  - name: s',
      '    binding: { kind: mcp, transport: stdio, command: /bin/cat }',
      '    tools:', '      - name: t', '        requires_commit: false'].join('\n'));
    expect(loadToolRegistry(p)[0].call_timeout_ms).toBeUndefined();
  });
});

// @v: anc-config-tool-registry —— per_parallel_child 文法（todo/0112:并行子任务独占进程开关）
describe('per_parallel_child 注册文法', () => {
  const entryWith = (line: string, binding = '{ kind: mcp, transport: stdio, command: /bin/cat }') =>
    writeRegistry(['tool_servers:', '  - name: s', ...(line ? [`    ${line}`] : []),
      `    binding: ${binding}`,
      '    tools:', '      - name: t', '        requires_commit: false'].join('\n'));
  it('反例：写成非布尔值（字符串 "yes"）→ TOOLS_FILE_INVALID', () => {
    expect(() => loadToolRegistry(entryWith('per_parallel_child: "yes"'))).toThrow(/TOOLS_FILE_INVALID.*per_parallel_child 须为布尔值/);
  });
  it('反例：写在 in-process 绑定上 → TOOLS_FILE_INVALID（进程内模块没有进程可独占）', () => {
    expect(() => loadToolRegistry(entryWith('per_parallel_child: true', '{ kind: in-process, module: ./m.mjs }')))
      .toThrow(/TOOLS_FILE_INVALID.*per_parallel_child.*只适用于 kind: mcp/);
  });
  it('正例：true 被解析进条目', () => {
    expect(loadToolRegistry(entryWith('per_parallel_child: true'))[0].per_parallel_child).toBe(true);
  });
  it('正例：缺省与显式 false → 条目无该字段（所有子任务共用顶层进程）', () => {
    expect(loadToolRegistry(entryWith(''))[0].per_parallel_child).toBeUndefined();
    expect(loadToolRegistry(entryWith('per_parallel_child: false'))[0].per_parallel_child).toBeUndefined();
  });
});

// @v: anc-type-tool-binding, anc-exec-inprocess-binding —— 绑定档位与 in-process 文法
//（装载机制 2026-08-12 实装——原"未实装拒"测试随之改写为文法正反例）
describe('binding.kind 档位与 in-process 文法', () => {
  it('正例：kind: in-process + module → 解析为绝对路径（相对 hoptools.yaml 目录）', () => {
    const p = writeRegistry(['tool_servers:', '  - name: ext',
      '    binding: { kind: in-process, module: ./my-tools.mjs }',
      '    tools:', '      - name: t', '        requires_commit: false'].join('\n'));
    const entry = loadToolRegistry(p)[0];
    expect(entry.binding.kind).toBe('in-process');
    expect(entry.binding.module).toMatch(/^\/.*my-tools\.mjs$/);   // 已解析为绝对路径
  });
  it('反例：in-process 缺 module → 拒（隔离模块路径必填——声明装载=操作者断言的载体）', () => {
    const p = writeRegistry(['tool_servers:', '  - name: ext',
      '    binding: { kind: in-process }',
      '    tools:', '      - name: t', '        requires_commit: false'].join('\n'));
    expect(() => loadToolRegistry(p)).toThrow(/binding\.module 缺失/);
  });
  it('反例：in-process 带 mcp 专属字段 → 拒（module 一个字段即全部,不静默忽略歧义配置）', () => {
    const p = writeRegistry(['tool_servers:', '  - name: ext',
      '    binding: { kind: in-process, module: ./m.mjs, command: /bin/cat }',
      '    tools:', '      - name: t', '        requires_commit: false'].join('\n'));
    expect(() => loadToolRegistry(p)).toThrow(/command 不属于 in-process/);
  });
  it('反例：kind 未知值 → 拒（枚举封闭,不静默当 mcp）', () => {
    const p = writeRegistry(['tool_servers:', '  - name: s',
      '    binding: { kind: grpc, url: "https://x" }',
      '    tools:', '      - name: t', '        requires_commit: false'].join('\n'));
    expect(() => loadToolRegistry(p)).toThrow(/kind 'grpc' 不支持/);
  });
});

// @v: anc-exec-tool-shape-check —— declared-or-flagged 留痕半边（Trait 补齐时实装 2026-08-12——
// 原注释"由调用方记 warn"是空头支票:两个调用方都没记,契约写完核一致性当场抓出）
describe('无声明放行的裸奔留痕', () => {
  it('正例：外部工具无 output_schema → 结果放行 + warn 一次（每工具不逐调用刷屏）', async () => {
    const warns: string[] = [];
    const entry: ToolServerEntry = {
      name: 'srv', binding: { kind: 'mcp', transport: 'http', url: 'https://x' },
      tools: [{ name: 'bare_tool', requires_commit: false }],   // 无 output_schema
    };
    const stub = { list: () => [{ name: 'bare_tool', description: '', input_schema: {}, requires_commit: false }],
                   execute: async () => ({ result: '{"a":1}', success: true as const, content_type: 'text' as const }) };
    const c = new CompositeToolProvider(HOST, { registry: [entry], externalProviderFor: () => stub, warn: m => warns.push(m) });
    const r1 = await c.execute('bare_tool', {});
    expect(r1.success).toBe(true);                          // 放行
    await c.execute('bare_tool', {});
    expect(warns.filter(w => w.includes('裸奔')).length).toBe(1);   // 留痕恰一次
    expect(warns[0]).toContain('bare_tool');
  });

  it('反例：有 output_schema 声明的工具不触发裸奔 warn（declared 侧走核对,flagged 侧零误报）', async () => {
    const warns: string[] = [];
    const entry: ToolServerEntry = {
      name: 'srv', binding: { kind: 'mcp', transport: 'http', url: 'https://x' },
      tools: [{ name: 'shaped', requires_commit: false, output_schema: { a: 'int' }, unwrap: 'json-in-text' }],
    };
    const stub = { list: () => [{ name: 'shaped', description: '', input_schema: {}, requires_commit: false }],
                   execute: async () => ({ result: '{"a":1}', success: true as const, content_type: 'text' as const }) };
    const c = new CompositeToolProvider(HOST, { registry: [entry], externalProviderFor: () => stub, warn: m => warns.push(m) });
    const r = await c.execute('shaped', {});
    expect(r.success).toBe(true);
    expect(warns.some(w => w.includes('裸奔'))).toBe(false);
  });
});

// @v: anc-type-output-schema-syntax —— output_schema 语法契约（作者定方案 A 2026-08-12:
// HopSpec 类型词汇 YAML 映射,与 Outputs/struct Fields 一门类型语言;此前无显式语法三态并存实撞）
describe('output_schema 语法（HopSpec 类型词汇）', () => {
  function reg(shapeYaml: string): string {
    return writeRegistry(['tool_servers:', '  - name: s',
      '    binding: { kind: mcp, transport: stdio, command: /bin/cat }',
      '    tools:', '      - name: t', '        requires_commit: false',
      `        output_schema: ${shapeYaml}`].join('\n'));
  }
  it('正例：原子与 [原子] 词汇通过（int/line/[yaml]）', () => {
    expect(() => loadToolRegistry(reg('{ total: int, id: line, pages: [yaml] }'))).not.toThrow();
  });
  it('反例：嵌套映射非法（pages: [{...}]——语法不提供写不出假承诺的形态,批次一示例即此形态实撞）', () => {
    expect(() => loadToolRegistry(reg('{ pages: [{ title: line }] }'))).toThrow(/嵌套映射不在语法内/);
  });
  it('反例：未知类型名 → 启动即拒并列词汇表', () => {
    expect(() => loadToolRegistry(reg('{ total: number }'))).toThrow(/不在词汇表.*bool\/int/s);
  });
  it('反例：空数组占位（旧写法 pages: []）→ 拒（值位必须有类型语义,占位装饰废止）', () => {
    expect(() => loadToolRegistry(reg('{ pages: [] }'))).toThrow(/列表类型须为 \[原子\]/);
  });

  it('正例：顶层值类型核对——声明 int 来了整数过、声明 [yaml] 来了数组过', async () => {
    const entry: ToolServerEntry = {
      name: 's', binding: { kind: 'mcp', transport: 'http', url: 'https://x' },
      tools: [{ name: 't', requires_commit: false, output_schema: { total: 'int', pages: ['yaml'] }, unwrap: 'json-in-text' }],
    };
    const stub = { list: () => [{ name: 't', description: '', input_schema: {}, requires_commit: false }],
                   execute: async () => ({ result: '{"total": 3, "pages": [{"u": 1}]}', success: true as const, content_type: 'text' as const }) };
    const c = new CompositeToolProvider(HOST, { registry: [entry], externalProviderFor: () => stub });
    const r = await c.execute('t', {});
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ total: 3, pages: [{ u: 1 }] });
  });
  it('反例：声明 int 来了字符串 → SCHEMA_DEVIATION 报字段与两侧类型（v1 第二级——此前只核键在场,类型漂移静默放行）', async () => {
    const entry: ToolServerEntry = {
      name: 's', binding: { kind: 'mcp', transport: 'http', url: 'https://x' },
      tools: [{ name: 't', requires_commit: false, output_schema: { total: 'int' }, unwrap: 'json-in-text' }],
    };
    const stub = { list: () => [{ name: 't', description: '', input_schema: {}, requires_commit: false }],
                   execute: async () => ({ result: '{"total": "3"}', success: true as const, content_type: 'text' as const }) };
    const c = new CompositeToolProvider(HOST, { registry: [entry], externalProviderFor: () => stub });
    const r = await c.execute('t', {});
    expect(r.success).toBe(false);
    expect(String(r.result)).toMatch(/SCHEMA_DEVIATION.*"total".*声明 int.*实际 string/s);
  });
});

// in-process 绑定执行面正反例（0011 工具面域——设计 HopSop 第 4 步明文/代码在/测试零覆盖:
// EXT_TOOL_BAD_RESULT 形状闸 + close 传导 + _base_dir 两级各自解析）。
// @v: anc-exec-inprocess-binding
describe('in-process 绑定执行面（0011 缺口补钉）', () => {
  function writeModule(dir: string, body: string): string {
    const p = join(dir, 'ext-tools.mjs');
    writeFileSync(p, body);
    return p;
  }

  it('反例：模块返回非 ToolResult 形状 → EXT_TOOL_BAD_RESULT 结构化失败（不裸抛不采信）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inproc-bad-'));
    const mod = writeModule(dir, 'export function execute() { return { whatever: 42 }; }');
    const member = new InProcessBindingMember({
      name: 'ext', binding: { kind: 'in-process', module: mod },
      tools: [{ name: 't', requires_commit: false }],
    } as ToolServerEntry);
    const r = await member.execute('t', {});
    expect(r.success).toBe(false);
    expect(String(r.result)).toContain('EXT_TOOL_BAD_RESULT');
  });

  it('正例：close 传导——run 终态 Composite.close 到达模块 close（0011:只测过 mcp 侧）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inproc-close-'));
    const marker = join(dir, 'closed.marker');
    const mod = writeModule(dir, [
      "import { writeFileSync } from 'node:fs';",
      "export function execute() { return { result: 'ok', success: true, content_type: 'text' }; }",
      `export function close() { writeFileSync(${JSON.stringify(marker)}, 'closed'); }`,
    ].join('\n'));
    const member = new InProcessBindingMember({
      name: 'ext', binding: { kind: 'in-process', module: mod },
      tools: [{ name: 't', requires_commit: false }],
    } as ToolServerEntry);
    await member.execute('t', {});   // 惰性装载:先执行一次让模块进内存
    await member.close();
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(true);   // close 真到达模块
  });

  it('正例：close 幂等——模块未装载(从未 execute)时 close 零动作不炸', async () => {
    const member = new InProcessBindingMember({
      name: 'ext', binding: { kind: 'in-process', module: '/nonexistent/mod.mjs' },
      tools: [{ name: 't', requires_commit: false }],
    } as ToolServerEntry);
    await expect(member.close()).resolves.toBeUndefined();
  });

  it('正例：_base_dir 两级配置——module 相对路径按各自声明文件目录解析（0011:只测过单文件）', () => {
    const sysDir = mkdtempSync(join(tmpdir(), 'inproc-sys-'));
    const projDir = mkdtempSync(join(tmpdir(), 'inproc-proj-'));
    const sysP = join(sysDir, 'config.yaml');
    const projP = join(projDir, 'hopjit.yaml');
    writeFileSync(sysP, ['tool_servers:', '  - name: sys_ext', '    binding: { kind: in-process, module: ./sys-tools.mjs }',
      '    tools:', '      - name: st', '        requires_commit: false'].join('\n'));
    writeFileSync(projP, ['tool_servers:', '  - name: proj_ext', '    binding: { kind: in-process, module: ./proj-tools.mjs }',
      '    tools:', '      - name: pt', '        requires_commit: false'].join('\n'));
    const sysEntries = loadToolRegistry(sysP);
    const projEntries = loadToolRegistry(projP);
    expect(sysEntries[0].binding.module).toBe(join(sysDir, 'sys-tools.mjs'));     // 各自相对各自声明文件
    expect(projEntries[0].binding.module).toBe(join(projDir, 'proj-tools.mjs'));
  });
});
