// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: tools ^anc-struct-tools
// 外部工具注册（统一配置 tool_servers 节）的加载与校验——ToolSpec 声明态类型 + fail-fast 解析。
// 文法权威 design/tool-interface.md ^anc-config-tool-registry。

import { readFileSync, existsSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { load as yamlLoad } from 'js-yaml';

/** ToolBinding：工具送达机制（第二层）。见 [[tool-interface#^anc-type-tool-binding]] */
export interface ToolBinding { // @a: anc-type-tool-binding
  kind: 'in-process' | 'mcp';
  module?: string;                 // in-process：隔离模块文件路径（加载期解析为绝对路径）// @a: anc-exec-inprocess-binding
  transport?: 'stdio' | 'http';   // mcp 专用；缺省 stdio
  url?: string;                    // mcp+http：server 端点
  command?: string;                // mcp+stdio：启动命令
  args?: string[];
  auth_env?: string;               // 环境变量名引用（api_key_env 同纪律——文件不含秘密）
  env_passthrough?: string[];      // 白名单透传的环境变量名
}

/** ToolSpec：工具的声明态契约（第一层类型面）——ToolDef 的超集。见 [[tool-interface#^anc-type-tool-spec]] */
export interface ToolSpec { // @a: anc-type-tool-spec
  name: string;                    // wire 工具名，全局唯一（字符串等值判）；允许任意 Unicode
  tool_id?: string;                // hop_python body 调用名=语言面标识符——name 非法标识符时必填,缺省=name（原名 alias,2026-08-12 作者纠名）
  description?: string;
  input_schema?: Record<string, unknown>;   // 可省——mcp 绑定从 tools/list 发现并比对
  // params 语义面（v0.5.0 ^anc-tool-params-notes——与 input_schema 分工:机器校验面 vs 人与 LLM
  // 语义面;说明写到杜绝望词生义。两面并存核参数名集合一致;仅 params 时 input_schema 机械生成）
  params?: { name: string; type: string; description?: string }[];
  notes?: string;                  // 跨参数复杂语义多行块（幂等/上限/调用纪律）——进 prompt 不参与校验
  output_schema?: Record<string, unknown>;   // 声明即硬校验；无声明放行+warn
  requires_commit: boolean;        // 权威在本声明，不信绑定侧自报
  unwrap?: 'json-in-text';         // 响应解包指示（百炼系 text 块内嵌 JSON 惯例）
}

// params 条目类型词汇（HopSpec 原子 + [原子]——与 output_schema 同表）// @a: anc-tool-params-notes
const PARAM_TYPES = new Set(['bool', 'int', 'float', 'line', 'text', 'markdown', 'yaml', 'prompt', 'line(nonempty)']);   // line(nonempty) 收编（review B-6:parser 归一站已收工具参数位,词表不认=归一了但用不上）// @a: anc-type-constraint-annotation
function validParamType(t: string): boolean {
  const m = t.match(/^\[(.+)\]$/);
  return PARAM_TYPES.has(m ? m[1].trim() : t);
}
// HopSpec 类型词 → JSON Schema 基础类型（params 单独在场时机械生成 input_schema）
function paramTypeToJsonSchema(t: string): Record<string, unknown> {
  const m = t.match(/^\[(.+)\]$/);
  if (m) return { type: 'array', items: paramTypeToJsonSchema(m[1].trim()) };
  if (t === 'bool') return { type: 'boolean' };
  if (t === 'int') return { type: 'integer' };
  if (t === 'float') return { type: 'number' };   // HopSpec float → JSON Schema number（词表词 number 已除名,此处 'number' 是 JSON Schema 词汇）
  if (t === 'yaml') return { type: 'object' };
  return { type: 'string' };   // line/text/markdown/prompt
}

/** ToolServerEntry：tool_servers 节的一个外部 server 条目。见 [[tool-interface#^anc-config-tool-registry]] */
export interface ToolServerEntry { // @a: anc-config-tool-registry
  name: string;                    // server 逻辑名（HopLog 记账用）
  binding: ToolBinding;
  tools: ToolSpec[];               // 白名单语义：声明即启用
  call_timeout_ms?: number;        // 单调用超时硬闸（缺省 60000）——挂死的外部 call 不吊死步骤
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** params 短形态行尾 # 说明回填（^anc-tool-params-notes——设计承诺"parser 收说明入结构",
 * YAML 裸注释 yamlLoad 后即丢,故各读入口在 yamlLoad 之后、parseToolServers 之前拿原始文本
 * 把说明提取回填进短形态条目（补 description 键——长短形态判定天然兼容,解析主体零改动）。
 *
 * 算法=params 节窗口定位+节内序位配对（2026-09-02 review 批重写——首版"全文候选池按名+型
 * 顺序消费"四处实证缺陷:①同名同型无注释条目偷走他人说明〔消费序与候选序错位〕②工具名行
 * 恰为词表词时进池错配③notes 块自由文本污染候选池④带引号"[原子]"类型不过词表静默丢弃）:
 * ①窗口=原始文本里每个 `params:` 行下方的连续列表项行块（按行序收集,只扫窗口内——tools
 *   数组行/notes 块天然在窗口外）;
 * ②对每个带 params 的工具按序取下一窗口,窗口内第 i 个列表项起始行对应 params 数组第 i 个
 *   条目（YAML 保序,行序=条目序——序位配对,无池化消费）;
 * ③配对安全门:短形态条目核"行首键=参数名且行值(剥缠绕引号)=类型串"才写入,长形态条目核
 *   "行首键=name"——任一不合即整窗口弃配（宁漏勿错配:错说明比丢说明更害）;
 * ④类型串比对前剥缠绕引号（"[line]" 形态——数组类型短形态须引号防 YAML 解析成数组,剥后
 *   照常配对,静默丢弃缺陷④由此治）。
 * 长形态显式 description 恒不覆盖。 // @a: anc-tool-params-notes */
export function enrichParamsComments(rawText: string, servers: unknown[]): void {
  // ① 收集 params 节窗口：每窗口=列表项行数组 [{key, value, desc?}]（按文本行序）
  const lines = rawText.split('\n');
  type WinEntry = { key: string; value: string; desc?: string };
  const windows: WinEntry[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const pm = lines[i].match(/^(\s*)params:\s*(#.*)?$/);
    if (!pm) continue;
    const baseIndent = pm[1].length;
    const win: WinEntry[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') continue;
      const indent = l.match(/^(\s*)/)![1].length;
      if (indent <= baseIndent) break;   // 出节
      const em = l.match(/^\s*-\s*([^\s:#]+)\s*:\s*([^#]*?)\s*(?:#\s*(.*?)\s*)?$/);
      if (em) {
        // 剥值的缠绕引号（"[line]" / '[line]' 形态）
        let val = em[2].trim();
        const qm = val.match(/^(["'])(.*)\1$/);
        if (qm) val = qm[2];
        win.push({ key: em[1], value: val, ...(em[3] ? { desc: em[3] } : {}) });
      }
      // 长形态的续行（type:/description: 子行）不作列表项起始,自然跳过
    }
    if (win.length > 0) windows.push(win);
  }
  if (windows.length === 0) return;

  // 全局对账门（review B2-1 形态乙——notes 字面块内写 params: 示例行会造伪窗口:窗口收集是
  // 纯文本行扫描不知身处字面块。伪窗必致供需总量失衡,总数不等即整文件弃配,宁漏勿错配）
  let expecting = 0;
  for (const sv of servers) {
    if (sv === null || typeof sv !== 'object') continue;
    const tools = (sv as Record<string, unknown>)['tools'];
    if (!Array.isArray(tools)) continue;
    for (const t of tools) {
      if (t === null || typeof t !== 'object') continue;
      const params = (t as Record<string, unknown>)['params'];
      if (Array.isArray(params) && params.length > 0) expecting++;
    }
  }
  if (windows.length !== expecting) return;

  // ② 逐工具按序取窗口,序位配对+安全门
  let winIdx = 0;
  for (const sv of servers) {
    if (sv === null || typeof sv !== 'object') continue;
    const tools = (sv as Record<string, unknown>)['tools'];
    if (!Array.isArray(tools)) continue;
    for (const t of tools) {
      if (t === null || typeof t !== 'object') continue;
      const params = (t as Record<string, unknown>)['params'];
      if (!Array.isArray(params)) continue;
      // 空 params（params: [] 内联形态）不耗窗——收集侧对无列表项行的 params: 不产窗,
      // 消费侧照耗即供需错位一格,后续工具窗口整体左移错配他人说明（review B2-1 探针实撞形态甲）
      if (params.length === 0) continue;
      const win = windows[winIdx++];
      if (!win || win.length !== params.length) continue;   // 窗口缺/条目数不合=弃配（宁漏勿错）
      // ③ 安全门预核:逐条目形态匹配,任一不合弃整窗口
      const shortForm: (Record<string, unknown> | null)[] = [];
      let safe = true;
      for (let i = 0; i < params.length; i++) {
        const pEntry = params[i];
        if (pEntry === null || typeof pEntry !== 'object') { safe = false; break; }
        const rec = pEntry as Record<string, unknown>;
        const keys = Object.keys(rec).filter(x => x !== 'description');
        const isShort = keys.length === 1 && typeof rec[keys[0]] === 'string' && keys[0] !== 'name';
        if (isShort) {
          if (win[i].key !== keys[0] || win[i].value !== (rec[keys[0]] as string).trim()) { safe = false; break; }
          shortForm.push(rec);
        } else {
          if (win[i].key !== 'name') { safe = false; break; }   // 长形态起始行恒 - name: …
          shortForm.push(null);
        }
      }
      if (!safe) continue;
      // ④ 写入:短形态无显式 description 的条目收本行说明
      for (let i = 0; i < params.length; i++) {
        const rec = shortForm[i];
        if (!rec || typeof rec['description'] === 'string' || !win[i].desc) continue;
        rec['description'] = win[i].desc;
      }
    }
  }
}

/** 加载 tool_servers 注册条目——fail-fast：语法错/字段缺失/name 或 tool_id 冲突/凭证明文，启动即拒并报定位。
 * 见 [[tool-interface#^anc-config-tool-registry]]。 // @a: anc-config-tool-registry */
export function loadToolRegistry(path: string): ToolServerEntry[] {
  if (!existsSync(path)) {
    throw new Error(`TOOLS_FILE_MISSING: 工具注册文件不存在（${path}）。文法见 docs/design/tool-interface.md ^anc-config-tool-registry`);
  }
  const parsed = yamlLoad(readFileSync(path, 'utf-8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`TOOLS_FILE_INVALID: ${path} 不是 YAML 映射`);
  }
  const raw = parsed as Record<string, unknown>;
  const servers = raw['tool_servers'];
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error(`TOOLS_FILE_INVALID: ${path} 缺 tool_servers[]（至少 1 条）`);
  }
  enrichParamsComments(readFileSync(path, 'utf-8'), servers);   // 行尾 # 说明回填（短形态） // @a: anc-tool-params-notes
  return parseToolServers(servers, dirname(pathResolve(path)));
}

/** tool_servers 节解析（统一配置收编后本函数是主入口——loadToolRegistry 独立文件形态保留供测试/迁移期;
 * baseDir=所在配置文件目录,in-process module 相对路径解析基准）。 // @a: anc-config-tool-registry */
export function parseToolServers(servers: unknown[], baseDir: string): ToolServerEntry[] {

  const entries: ToolServerEntry[] = [];
  for (const [i, sv] of (servers as Record<string, unknown>[]).entries()) {
    if (sv === null || typeof sv !== 'object') throw new Error(`TOOLS_FILE_INVALID: tool_servers[${i}] 须为映射`);
    if (typeof sv['name'] !== 'string' || !sv['name'].trim()) throw new Error(`TOOLS_FILE_INVALID: tool_servers[${i}].name 缺失`);
    const b = sv['binding'] as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object') throw new Error(`TOOLS_FILE_INVALID: tool_servers[${i}].binding 缺失`);
    if (b['kind'] !== 'mcp' && b['kind'] !== 'in-process') throw new Error(`TOOLS_FILE_INVALID: tool_servers[${i}].binding.kind '${String(b['kind'])}' 不支持（枚举 mcp | in-process）`);
    // in-process：module 必填,相对声明所在配置文件目录解析（声明装载=操作者对模块审计状态的断言——
    // 个人版审计闸,见 tool-interface ^anc-exec-inprocess-binding）。// @a: anc-exec-inprocess-binding
    if (b['kind'] === 'in-process') {
      if (typeof b['module'] !== 'string' || !b['module'].trim()) {
        throw new Error(`TOOLS_FILE_INVALID: tool_servers[${i}].binding.module 缺失（in-process 须声明隔离模块文件路径）`);
      }
      for (const alien of ['url', 'command', 'transport'] as const) {
        if (alien in b) throw new Error(`TOOLS_FILE_INVALID: tool_servers[${i}].binding.${alien} 不属于 in-process 绑定（module 一个字段即全部）`);
      }
    }
    for (const secret of ['api_key', 'auth', 'token', 'key'] as const) {
      if (secret in b) throw new Error(`TOOLS_FILE_PLAINTEXT_KEY: tool_servers[${i}].binding.${secret} 禁止写入注册文件——用 auth_env 环境变量名引用`);
    }
    if (b['auth_env'] !== undefined && (typeof b['auth_env'] !== 'string' || !IDENT_RE.test(b['auth_env']))) {
      throw new Error(`TOOLS_FILE_INVALID: tool_servers[${i}].binding.auth_env 须为合法环境变量名`);
    }
    const tools = sv['tools'];
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new Error(`TOOLS_FILE_INVALID: tool_servers[${i}].tools 缺失（白名单语义——不声明工具的 server 条目无意义）`);
    }
    const specs: ToolSpec[] = [];
    for (const [j, t] of (tools as Record<string, unknown>[]).entries()) {
      if (typeof t['name'] !== 'string' || !t['name'].trim()) throw new Error(`TOOLS_FILE_INVALID: tool_servers[${i}].tools[${j}].name 缺失`);
      if (typeof t['requires_commit'] !== 'boolean') throw new Error(`TOOLS_FILE_INVALID: tool_servers[${i}].tools[${j}].requires_commit 缺失（必填——不可逆标记不设缺省,声明即负责）`);
      const name = t['name'] as string;
      const toolId = t['tool_id'] as string | undefined;
      if (!IDENT_RE.test(name) && !toolId) {
        throw new Error(`TOOLS_FILE_INVALID: 工具 "${name}" 名非合法标识符（hop_python body 无法调用）——须声明 tool_id`);
      }
      if (toolId !== undefined && !IDENT_RE.test(toolId)) {
        throw new Error(`TOOLS_FILE_INVALID: 工具 "${name}" 的 tool_id "${toolId}" 非合法标识符`);
      }
      if (t['output_schema'] !== undefined) {
        const err = validateSchemaSyntax(t['output_schema']);
        if (err) throw new Error(`TOOLS_FILE_INVALID: 工具 "${name}" 的 output_schema ${err}——语法见 docs/design/tool-interface.md ^anc-type-output-schema-syntax`);
      }
      if (t['unwrap'] !== undefined && t['unwrap'] !== 'json-in-text') {
        throw new Error(`TOOLS_FILE_INVALID: 工具 "${name}" 的 unwrap '${String(t['unwrap'])}' 不支持（枚举 json-in-text）`);
      }
      // params 语义面解析（^anc-tool-params-notes——条目式 [{参数名: 类型}] 或 [{name,type,description}]
      // 两形态;短形态行尾 # 说明由各读入口 enrichParamsComments 在 yamlLoad 后回填成 description 键,
      // 到达此处时两形态已同构）
      let params: { name: string; type: string; description?: string }[] | undefined;
      if (t['params'] !== undefined) {
        if (!Array.isArray(t['params'])) throw new Error(`TOOLS_FILE_INVALID: 工具 "${name}" 的 params 须为条目列表`);
        params = (t['params'] as unknown[]).map((p, k) => {
          if (p === null || typeof p !== 'object') throw new Error(`TOOLS_FILE_INVALID: 工具 "${name}" params[${k}] 须为映射条目`);
          const rec = p as Record<string, unknown>;
          let pname: string, ptype: string, pdesc: string | undefined;
          if (typeof rec['name'] === 'string' && typeof rec['type'] === 'string') {
            pname = rec['name']; ptype = rec['type'];
            pdesc = typeof rec['description'] === 'string' ? rec['description'] : undefined;
          } else {
            const keys = Object.keys(rec).filter(x => x !== 'description');
            if (keys.length !== 1 || typeof rec[keys[0]] !== 'string') {
              throw new Error(`TOOLS_FILE_INVALID: 工具 "${name}" params[${k}] 形态不合——'- 参数名: 类型' 或 '{name, type, description}'`);
            }
            pname = keys[0]; ptype = rec[keys[0]] as string;
            pdesc = typeof rec['description'] === 'string' ? rec['description'] : undefined;
          }
          if (!validParamType(ptype)) throw new Error(`TOOLS_FILE_INVALID: 工具 "${name}" 参数 "${pname}" 类型 '${ptype}' 不在词汇表（HopSpec 原子 + [原子]）`);
          return { name: pname, type: ptype, ...(pdesc ? { description: pdesc } : {}) };
        });
        // 两面并存核参数名集合一致（防漂移——^anc-tool-params-notes）
        const isch = t['input_schema'] as Record<string, unknown> | undefined;
        const ischProps = isch && typeof isch === 'object' && isch['properties'] && typeof isch['properties'] === 'object'
          ? Object.keys(isch['properties'] as Record<string, unknown>) : null;
        if (ischProps) {
          const pnames = params.map(p => p.name).sort().join(',');
          if (pnames !== [...ischProps].sort().join(',')) {
            throw new Error(`TOOLS_FILE_INVALID: 工具 "${name}" 的 params 参数名集合与 input_schema.properties 不一致（params: ${pnames}; schema: ${[...ischProps].sort().join(',')}）——两面须同名同集,防漂移`);
          }
        }
      }
      if (t['notes'] !== undefined && typeof t['notes'] !== 'string') {
        throw new Error(`TOOLS_FILE_INVALID: 工具 "${name}" 的 notes 须为文本`);
      }
      // 仅 params 无 input_schema：机械生成（类型词映射 JSON Schema 基础类型）。
      // 零参工具（params 与 input_schema 双缺席）同样生成最小合法对象 schema——LLM 通道的
      // 工具清单不许出现无 schema 条目（OpenAI 门面型端点对裸 {} 校验 400"got type null",
      // deep-research 真机 fan-out 全灭实撞;设计 ^anc-exec-mcp-binding 3.2 兜底条款）。
      const genSchema = !t['input_schema']
        ? (params
          ? { type: 'object', properties: Object.fromEntries(params.map(p => [p.name, { ...paramTypeToJsonSchema(p.type), ...(p.description ? { description: p.description } : {}) }])), required: params.map(p => p.name) }
          : { type: 'object', properties: {} })
        : undefined;
      specs.push({
        name,
        ...(toolId ? { tool_id: toolId } : {}),
        ...(typeof t['description'] === 'string' ? { description: t['description'] } : {}),
        ...(t['input_schema'] && typeof t['input_schema'] === 'object' ? { input_schema: t['input_schema'] as Record<string, unknown> } : genSchema ? { input_schema: genSchema } : {}),
        ...(params ? { params } : {}),
        ...(typeof t['notes'] === 'string' ? { notes: t['notes'] } : {}),
        ...(t['output_schema'] && typeof t['output_schema'] === 'object' ? { output_schema: t['output_schema'] as Record<string, unknown> } : {}),
        requires_commit: t['requires_commit'] as boolean,
        ...(t['unwrap'] ? { unwrap: 'json-in-text' as const } : {}),
      });
    }
    if (sv['call_timeout_ms'] !== undefined && (typeof sv['call_timeout_ms'] !== 'number' || sv['call_timeout_ms'] <= 0)) {
      throw new Error(`TOOLS_FILE_INVALID: tool_servers[${i}].call_timeout_ms 须为正数（毫秒）`);
    }
    entries.push({
      name: sv['name'] as string,
      // _base_dir=该条目声明所在配置文件目录（统一配置两级形态——项目级声明的 module 相对项目根）
      binding: normalizeBinding(b, typeof sv['_base_dir'] === 'string' ? sv['_base_dir'] as string : baseDir), tools: specs,
      ...(typeof sv['call_timeout_ms'] === 'number' ? { call_timeout_ms: sv['call_timeout_ms'] } : {}),
    });
  }
  return entries;
}

function normalizeBinding(b: Record<string, unknown>, baseDir: string): ToolBinding {
  if (b['kind'] === 'in-process') {
    const raw = b['module'] as string;
    return { kind: 'in-process', module: pathResolve(baseDir, raw) };   // 相对声明所在配置文件目录 // @a: anc-exec-inprocess-binding
  }
  const transport = (b['transport'] as 'stdio' | 'http' | undefined) ?? (b['url'] ? 'http' : 'stdio');
  if (transport === 'http' && typeof b['url'] !== 'string') throw new Error('TOOLS_FILE_INVALID: binding.transport=http 须带 url');
  if (transport === 'stdio' && typeof b['command'] !== 'string') throw new Error('TOOLS_FILE_INVALID: binding.transport=stdio 须带 command');
  return {
    kind: 'mcp',
    transport,
    ...(typeof b['url'] === 'string' ? { url: b['url'] } : {}),
    ...(typeof b['command'] === 'string' ? { command: b['command'] } : {}),
    ...(Array.isArray(b['args']) ? { args: b['args'] as string[] } : {}),
    ...(typeof b['auth_env'] === 'string' ? { auth_env: b['auth_env'] } : {}),
    ...(Array.isArray(b['env_passthrough']) ? { env_passthrough: b['env_passthrough'] as string[] } : {}),
  };
}

// output_schema 语法校验（^anc-type-output-schema-syntax）：值位=HopSpec 类型词汇（原子或 [原子]），
// 嵌套映射/未知类型名=文法错误启动即拒——语法不提供写不出假承诺的形态。// @a: anc-type-output-schema-syntax
const SHAPE_ATOM_TYPES = new Set(['bool', 'int', 'float', 'line', 'text', 'markdown', 'yaml', 'prompt']);
function validateSchemaSyntax(shape: unknown): string | null {
  if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) return '须为 YAML 映射（字段名 → HopSpec 类型名）';
  for (const [k, v] of Object.entries(shape as Record<string, unknown>)) {
    if (typeof v === 'string') {
      if (!SHAPE_ATOM_TYPES.has(v)) return `字段 "${k}" 类型 '${v}' 不在词汇表（${[...SHAPE_ATOM_TYPES].join('/')}）`;
    } else if (Array.isArray(v)) {
      if (v.length !== 1 || typeof v[0] !== 'string' || !SHAPE_ATOM_TYPES.has(v[0] as string)) {
        return `字段 "${k}" 列表类型须为 [原子]（如 [yaml]/[line]）——嵌套映射不在语法内（深层结构写 # 注释）`;
      }
    } else {
      return `字段 "${k}" 值位须为类型名或 [类型名]（收到 ${JSON.stringify(v)}）——嵌套映射不在语法内`;
    }
  }
  return null;
}


/** 项目级 tool_servers 注册表现读（0076 批立于 CLI 侧,2026-09-06 review 抓 load 半边三份同构后
 * 真收敛挪入本模块——组合根工厂 loadRegistry 半边与 tool-call 命令共用单一权威。
 * 读 `<baseDir>/hopjit.yaml` 的 tool_servers 节→enrichParamsComments→parseToolServers;
 * baseDir 由组合根传入（进程状态 process.cwd() 只许组合根读——run 隔离不变量
 * ^anc-run-isolation,本函数纯参数化,check-process-state 守卫首拦后定形）;
 * 无文件/无节/空文件返 undefined〔纯内置直执面〕;坏节抛 TOOLS_FILE_INVALID 任其上抛不吞——
 * 工厂语境经消化路径折步骤 fail,tool-call 语境 CONFIG_ERROR 响亮退出。
 * 现读语义:每引擎实例首次消化时读一次（^anc-exec-tool-request 注册件装配条款②）。 */
// @a: anc-exec-tool-request
export function loadProjectToolRegistry(baseDir: string): ToolServerEntry[] | undefined {
  const projYamlPath = pathResolve(baseDir, 'hopjit.yaml');
  if (!existsSync(projYamlPath)) return undefined;
  const projYamlText = readFileSync(projYamlPath, 'utf-8');
  // 空文件/纯注释文件=无配置返 undefined（js-yaml load 对空文档抛 'expected a document'——
  // 2026-09-06 review 现读语义钉实撞:该形态非坏节,不该折 fail;先判后解析零依赖错误消息）
  if (projYamlText.split('\n').every(l => !l.trim() || l.trim().startsWith('#'))) return undefined;
  const raw = yamlLoad(projYamlText) as { tool_servers?: unknown[] } | null;
  if (!raw?.tool_servers?.length) return undefined;
  enrichParamsComments(projYamlText, raw.tool_servers);   // 行尾 # 说明回填 // @a: anc-tool-params-notes
  return parseToolServers(raw.tool_servers, baseDir);
}
