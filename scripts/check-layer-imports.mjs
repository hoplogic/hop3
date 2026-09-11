#!/usr/bin/env node
// @a: anc-meta-module-layering
// G8 守卫：依赖方向不越层（module-principles §2 分层表即本脚本判据）。
// 扫 src/ 全部相对 import（含 import type——类型是最易无声扩散的耦合面），
// 按"文件→模块→层"映射判方向：低层 import 高层 = 越向 = 红。
// 豁免名单与 ARCHITECTURE.md「分层桥接点」表一一对应——新增豁免必须先登记桥接表再改这里。
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// HOPJIT_CHECK_ROOT：判据回归测试注入 fixture 仓库根（chain-enforcement §5 硬要求 2——守卫判据自身要有测试）；生产恒缺省
const ROOT = process.env['HOPJIT_CHECK_ROOT'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// 文件（stem）→ 层。判据表 = docs/design/module-principles.md §2（改层归属先改设计再改这里）。
// 层序：shared(0) < core(1) < adapter(2)。允许 import 同层或更低层；禁止 import 更高层。
const LAYER = {
  // 共享层（0）
  'errors': 0, 'provider-types': 0,
  // 引擎核心层（1）
  'ast-types': 1, 'ast-runtime': 1, 'ast-helpers': 1, 'spec-tree-edit': 1,   // 树编辑核心属 spec-ast 模块,按依赖事实（仅 ast-types）定核心层——module-principles §2;契约在 tools.md
  'parser': 1, 'validator': 1,
  'engine': 1, 'engine-traverse': 1, 'runtime-types': 1,
  'prompt': 1, 'doc-ref': 1, 'hoplog': 1,
  'act-body-parser': 1, 'act-body-interpreter': 1, 'act-builtins': 1,
  // 驱动适配层（2）
  'cli': 2, 'cli-types': 2, 'dispatcher': 2, 'protocol-openai': 2, 'tools': 2, 'tools-registry': 2, 'tools-composite': 2, 'tools-mcp-binding': 2, 'tools-inprocess-binding': 2, 'tools-notify': 2, 'persistence': 2,   // protocol-openai 属 step-dispatcher；tools-registry/composite 属 tools 模块
  'mcp-server': 2,   // standalone MCP 协议壳（薄壳包 dispatcher，见 design/mcp-server.md）
};

// 豁免名单：与 ARCHITECTURE.md「分层桥接点」逐条对应（kind 仅注释用途）。
// key = `${fromStem}->${targetStem}`
const APPROVED_BRIDGES = new Set([
  'engine->persistence',   // worker 参数通道 + child 终态读取 + 缺省持久化实例化（桥接表第 1 条）
  'engine->cli-types',     // NextResponse 等返回形状，type-only（第 2 条）
  'doc-ref->tools',        // sandbox 校验链复用（第 3 条）
  'provider-types->ast-types',     // Provider 签名引用 AST 类型，type-only（第 4 条）
  'provider-types->runtime-types', // 同上（EngineSnapshot）
]);

const IMPORT_RE = /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"](\.\.?\/[\w./-]+?)['"]/g;

const violations = [];
for (const fname of readdirSync(SRC).filter(f => f.endsWith('.ts'))) {
  const fromStem = basename(fname, '.ts');
  const fromLayer = LAYER[fromStem];
  if (fromLayer === undefined) {
    violations.push(`${fname}: 不在 LAYER 表中——新文件须先在 module-principles §2 定层，再登记本脚本`);
    continue;
  }
  const text = readFileSync(join(SRC, fname), 'utf-8');
  for (const m of text.matchAll(IMPORT_RE)) {
    const targetStem = basename(m[1]).replace(/\.js$/, '');
    const targetLayer = LAYER[targetStem];
    if (targetLayer === undefined) continue; // 非 src 内部（如 node: 前缀不匹配正则，此处保险）
    if (targetLayer > fromLayer && !APPROVED_BRIDGES.has(`${fromStem}->${targetStem}`)) {
      violations.push(
        `${fname}(层${fromLayer}) import ${targetStem}(层${targetLayer})——低层引高层越向。` +
        `合法途径：Provider 注入 / 收窄接口；确需桥接先登记 ARCHITECTURE.md 分层桥接点表`);
    }
  }
}

if (violations.length) {
  console.error(`❌ 依赖方向越层 ${violations.length} 处（判据=module-principles §2）：`);
  for (const v of violations) console.error('   ' + v);
  process.exit(1);
}
console.log(`Layer import check passed.（src ${Object.keys(LAYER).length} 文件三层方向合规，豁免 ${APPROVED_BRIDGES.size} 条与桥接表对应）`);
