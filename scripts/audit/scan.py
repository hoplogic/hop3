#!/usr/bin/env python3
"""anchor-audit 五层锚点扫描脚本。

扫描概念文档 (^anc-)、设计文档 (^anc-)、代码 (@a: anc-)、测试 (@v: anc-)、
TRACEABILITY.md 与文件级 @module 归属，输出 6 份 YAML 到 {project}/.anchor-audit/：
concept_anchors / design_anchors / code_anchors / test_anchors /
traceability_cards / module_anchors（含每模块规模统计 module_scale）。

依赖: pyyaml (uv pip install pyyaml)

用法:
  python3 scan.py <project_root> [--concept-dir 概念目录...] \\
    [--design-dir design] [--src-dir src] [--test-dir tests]

退出码:
  0  扫描完成，无命名违规或无效引用
  1  扫描完成，发现命名违规或无效引用
  2  脚本运行错误
"""

import argparse
import os
import re
import sys

try:
    import yaml
except ImportError:
    print("需要 PyYAML: uv pip install pyyaml", file=sys.stderr)
    sys.exit(2)

CATEGORIES = frozenset([
    "step", "ast", "type", "rule", "cli", "provider",
    "config", "error", "exec", "struct", "layer", "obs", "meta",
    # i18n：国际化跨切面（文档多语言树/翻译纪律/关键词双语,2026-08-15）
    "i18n",
    # build：hopbuild 构建器（自举形态/分发布局/知识源,2026-08-15）
    "build",
    # viz：可视化支持（编辑器插件:折叠/大纲/落点高亮,2026-08-16）
    "viz",
    # tool：工具契约跨切面（声明两面/注册面语义/参数展开,2026-08-25 工具一等公民批）
    "tool",
    # driver：驱动载体（CC / Codex carrier 的角色分工、交接契约、安装布局、静态纪律）
    # string：跨切面字符串处理规范（转义、编码、序列化边界）
    # ⚠️ 权威表在 design/concept-anchor-rules.md「类别表」——本常量须与之同步
    "driver", "string",
    # run：跨切面 run 生命周期规范（run 隔离不变量,2026-08-14）
    "run",
    # surface：语法表层表述变种（标准/大纲、内联/标题风）
    "surface",
    # mcp：MCP server 协议面（standalone 执行的工具面、run 生命周期、key 隔离、载体注册）
    "mcp",
    # module：模块规范（概念级，2026-08-08 自元规范收拢单立）
    # flow：HopSop（HopSpec 无执行态真子集，2026-08-08 上升为概念标准）
    # guard：守卫规范（概念级，2026-08-08 自元规范单立）
    # hoptype：HopType 体系自身的元级约定（区别于 struct 的具体组件实例）
    "module", "flow", "guard", "hoptype", "ref",
    # release：发版工程设施（快照制发版生命周期/凭证闸/收编协议,2026-09-04 快照制批）
    "release",
])

GROUP_TITLE_WHITELIST = frozenset([
    "anc-ast-executable-steps",
    "anc-ast-structural-steps",
    "anc-cli-response-types",
    "anc-error-types",
    "anc-provider-interfaces",
    "anc-type-auxiliary",
    "anc-type-system",
])

ANCHOR_ID_RE = re.compile(r'^anc-[a-z][a-z0-9-]*$')
CODE_EXTENSIONS = ('.ts', '.py', '.mjs', '.sh')
EXPORT_KEYWORDS = re.compile(r'\b(export|interface|type|function|const|enum|class|def)\b')


def dump(data, path):
    with open(path, 'w', encoding='utf-8') as f:
        yaml.dump(data, f, allow_unicode=True, default_flow_style=False, sort_keys=False)


def validate_name(anchor_id):
    # 类别段容数字（i18n 类别 2026-08-15 入表时实撞:[a-z]+ 对 'i18n' 只吃到 'i' 即判格式不匹配）
    m = re.match(r'^anc-([a-z][a-z0-9]*)-', anchor_id)
    if not m:
        return f"格式不匹配 anc-{{category}}-{{concept}}"
    if m.group(1) not in CATEGORIES:
        return f"类别 '{m.group(1)}' 不在合法类别表中"
    return None


def parse_anchor_ids(raw):
    # 每个逗号段取空白前首词再校验——允许 `@v: anc-x — 说明文字` 的尾注写法
    # （concept-anchor-rules「各层嵌入语法」L2/L3：标注行可带破折号说明，扫描器只认首词）。
    ids = []
    for t in raw.split(","):
        head = t.strip().split()[0] if t.strip() else ""
        if head and ANCHOR_ID_RE.match(head):
            ids.append(head)
    return ids


def read_lines(fpath):
    try:
        with open(fpath, encoding="utf-8", errors="replace") as f:
            return f.readlines()
    except OSError:
        return []


def read_text(fpath):
    try:
        with open(fpath, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


# ---------------------------------------------------------------------------
# _scan_markdown_anchors —— 设计层/概念层共用：行尾 ^anc- 锚点提取
# ---------------------------------------------------------------------------

# 设计与概念层提取逻辑完全一致（同是行尾 ` ^anc-*` 的 Markdown），抽共用函数避免重复——
# anchor-audit 自身正是查"重复实现"的工具，扫描器本身不该有近似复制对。
def _scan_markdown_anchors(project, dirs, skip_dirs, label):
    anchors = []
    naming_violations = []
    # 两种合法定义形态（concept-anchor-rules「各层嵌入语法」2026-08-03）：
    # ①行尾锚定 ；②行中锚定 （锚点后紧跟全/半角冒号）。
    # 其它行中提及（"见 ^anc-x"、括号引用）是引用不是定义，不采集。
    # 两种合法定义形态（concept-anchor-rules「各层嵌入语法」2026-08-03）：
    # ①行尾锚定；②行中锚定 `**标题** ^anc-x：正文`——必须紧跟粗体闭合 `**` 且后接冒号，
    # 两条件缺一不可（散文提及如"修正 ^anc-x：……"不带前置粗体，不会误采）。
    # 三形态（concept-anchor-rules「各层嵌入语法」——③表格单元格尾锚 2026-09-04 todo/0057 补:
    # 表格行末单元格"内容 ^anc-x |"形态,概念层表格组织条目时锚落单元格里,原正则行尾 $ 收不到。
    # 定义判据=锚前同单元格有实内容——设计文档顶部分级表的索引行（整格只有锚 `| ^anc-x |`
    # 或多锚列表 `^a / ^b |`,尾锚前是 `/`）是引用不是定义,首版三形态正则误收 11+1 处
    # 假重复实抓后两轮收窄:锚前字符排除管道/空白/斜杠）
    anchor_re = re.compile(r'(?: \^(anc-[a-z][a-z0-9-]*)$|(?<=\*\*) \^(anc-[a-z][a-z0-9-]*)(?=：|:)|(?<=[^|\s/]) \^(anc-[a-z][a-z0-9-]*) \|$)')
    seen = set()

    for d in dirs:
        dir_path = os.path.join(project, d)
        # 允许文件级设计源（如根目录 ARCHITECTURE.md——概念锚点规则「设计锚点合法载体」2026-08-03）
        if os.path.isfile(dir_path):
            walk_iter = [(os.path.dirname(dir_path), [], [os.path.basename(dir_path)])]
        elif os.path.isdir(dir_path):
            walk_iter = os.walk(dir_path)
        else:
            print(f"  警告: {label}目录不存在，跳过: {d}", file=sys.stderr)
            continue
        for root, subdirs, files in walk_iter:
            subdirs[:] = [s for s in subdirs if s not in skip_dirs]
            for fname in sorted(files):
                if not fname.endswith(".md"):
                    continue
                fpath = os.path.join(root, fname)
                rel = os.path.relpath(fpath, project)
                lines = read_lines(fpath)
                # 围栏内外一律扫描——行尾 " ^anc-*" 格式本身已极大降低假阳性，
                # 设计文档在代码围栏内（如 TS 接口示例）标注锚点是合法且常见的做法
                for lineno, raw_line in enumerate(lines, 1):
                    stripped = raw_line.rstrip("\n")
                    m = anchor_re.search(stripped)
                    if not m:
                        continue
                    aid = m.group(1) or m.group(2) or m.group(3)
                    key = (aid, rel)
                    if key in seen:
                        naming_violations.append({"id": aid, "file": rel, "line": lineno,
                                                  "reason": "同文件重复锚点（首次出现已记录）"})
                        continue
                    seen.add(key)
                    anchors.append({"id": aid, "file": rel, "line": lineno,
                                    "is_group_title": aid in GROUP_TITLE_WHITELIST})
                    err = validate_name(aid)
                    if err:
                        naming_violations.append({"id": aid, "file": rel, "line": lineno,
                                                  "reason": err})
    return anchors, naming_violations


# 设计/概念层扫描共用的子目录跳过集
_MD_SKIP_DIRS = {"reviews", "rounds", "node_modules", "dist", "coverage",
                 ".anchor-audit", ".git", ".obsidian"}


# ---------------------------------------------------------------------------
# scan_design
# ---------------------------------------------------------------------------

def scan_design(project, design_dirs):
    anchors, naming_violations = _scan_markdown_anchors(
        project, design_dirs, _MD_SKIP_DIRS, "设计")
    dump({"anchors": anchors, "naming_violations": naming_violations},
         os.path.join(project, ".anchor-audit", "design_anchors.yaml"))
    return len(anchors), len(naming_violations)


# ---------------------------------------------------------------------------
# scan_concept —— 概念层 Markdown ^anc- 锚点（S→D 语义审计的权威源）
# ---------------------------------------------------------------------------

def scan_concept(project, concept_dirs, design_dirs, src_dir, test_dir):
    """扫概念层 Markdown 锚点。概念层是 S→D 维度的权威源（设计须忠实传达概念语义）。
    跳过 design/src/test/code/examples/obsolete——概念目录常是工程根（含上述子目录），
    不排除会把设计锚点重复扫成概念锚点。concept_dirs 为空 → 无概念层，S→D 维度 skip。
    """
    if not concept_dirs:
        dump({"anchors": [], "naming_violations": [], "note": "未指定概念层目录，S→D 维度 skip"},
             os.path.join(project, ".anchor-audit", "concept_anchors.yaml"))
        return 0, 0
    # 排除设计/源码/测试及常见工程子目录，避免概念扫描下钻重复采集设计锚点
    skip = set(_MD_SKIP_DIRS)
    skip |= {os.path.basename(d.rstrip("/")) for d in design_dirs}
    skip |= {os.path.basename(src_dir.rstrip("/")), os.path.basename(test_dir.rstrip("/"))}
    skip |= {"code", "examples", "obsolete", "scripts"}
    anchors, naming_violations = _scan_markdown_anchors(
        project, concept_dirs, skip, "概念")
    dump({"anchors": anchors, "naming_violations": naming_violations},
         os.path.join(project, ".anchor-audit", "concept_anchors.yaml"))
    return len(anchors), len(naming_violations)


# ---------------------------------------------------------------------------
# scan_code
# ---------------------------------------------------------------------------

def scan_code(project, src_dirs):
    anchors = []
    naming_violations = []
    placement_warnings = []
    a_re = re.compile(r'(?://|#)\s*@a:\s*(.+)')
    walk_roots = []
    for d in src_dirs:
        p_ = os.path.join(project, d)
        if os.path.isdir(p_):
            walk_roots.append(p_)
        else:
            print(f"  警告: 源码目录不存在，跳过: {d}", file=sys.stderr)

    for src_path in walk_roots:
      for root, _dirs, files in os.walk(src_path):
          for fname in sorted(files):
              if not fname.endswith(CODE_EXTENSIONS):
                  continue
              fpath = os.path.join(root, fname)
              rel = os.path.relpath(fpath, project)
              lines = read_lines(fpath)
              for lineno, raw_line in enumerate(lines, 1):
                  line = raw_line.rstrip("\n")
                  m = a_re.search(line)
                  if not m:
                      continue
                  ids = parse_anchor_ids(m.group(1))
                  context = line[:m.start()].strip()[:100]
                  has_export = bool(EXPORT_KEYWORDS.search(line))
                  is_comment = line.strip().startswith("//") or line.strip().startswith("#")
                  for aid in ids:
                      anchors.append({"id": aid, "file": rel, "line": lineno, "context": context})
                      err = validate_name(aid)
                      if err:
                          naming_violations.append({"id": aid, "file": rel, "line": lineno, "reason": err})
                      if not has_export and not is_comment:
                          placement_warnings.append({"id": aid, "file": rel, "line": lineno,
                                                      "reason": "非 export 声明行且非注释行"})

    dump({"anchors": anchors, "naming_violations": naming_violations,
          "placement_warnings": placement_warnings},
         os.path.join(project, ".anchor-audit", "code_anchors.yaml"))
    return len(anchors), len(naming_violations)


# ---------------------------------------------------------------------------
# scan_test
# ---------------------------------------------------------------------------

def scan_test(project, test_dir, aux_test_dirs=()):
    anchors = []
    naming_violations = []
    v_re = re.compile(r'(?://|#)\s*@v:\s*(.+)')
    walk_roots = []
    for d in [test_dir, *aux_test_dirs]:
        p_ = os.path.join(project, d)
        if os.path.isdir(p_):
            walk_roots.append(p_)
        else:
            print(f"  警告: 测试目录不存在，跳过: {d}", file=sys.stderr)

    for test_path in walk_roots:
      for root, _dirs, files in os.walk(test_path):
          for fname in sorted(files):
              if not fname.endswith(CODE_EXTENSIONS):
                  continue
              fpath = os.path.join(root, fname)
              rel = os.path.relpath(fpath, project)
              lines = read_lines(fpath)
              for lineno, raw_line in enumerate(lines, 1):
                  line = raw_line.rstrip("\n")
                  m = v_re.search(line)
                  if not m:
                      continue
                  for aid in parse_anchor_ids(m.group(1)):
                      anchors.append({"id": aid, "file": rel, "line": lineno})
                      err = validate_name(aid)
                      if err:
                          naming_violations.append({"id": aid, "file": rel, "line": lineno, "reason": err})

    dump({"anchors": anchors, "naming_violations": naming_violations},
         os.path.join(project, ".anchor-audit", "test_anchors.yaml"))
    return len(anchors), len(naming_violations)


# ---------------------------------------------------------------------------
# scan_traceability
# ---------------------------------------------------------------------------

def scan_traceability(project, src_dir, test_dir):
    trace_path = os.path.join(project, "TRACEABILITY.md")
    content = read_text(trace_path)
    if not content:
        dump({"cards": [], "gaps": [], "invalid_refs": []},
             os.path.join(project, ".anchor-audit", "traceability_cards.yaml"))
        return 0, 0

    # 引用格式：`file.ts` 或旧式 `file.ts:123`（行号可选、已废弃——行号必然随代码增删腐坏，
    # 定位靠 @a:/@v: 锚点 grep，不靠行号快照。见 anchor-audit-knowledge.md「引用有效性」）
    code_ref_re = re.compile(r'([\w./-]+\.(?:ts|py))(?::(\d+))?')
    cards = []
    current = None
    in_gaps = False
    gaps = []

    for line in content.split("\n"):
        m = re.match(r'^### (anc-[a-z][a-z0-9-]*)\s*(.*)', line)
        if m:
            if current:
                cards.append(current)
            aid = m.group(1)
            status_raw = m.group(2).strip()
            status = "无标记"
            for marker, label in [("✅", "✅"), ("⚠", "⚠️"), ("🔲", "🔲"), ("❌", "❌")]:
                if marker in status_raw:
                    status = label
                    break
            current = {"id": aid, "status": status, "description": "",
                       "placement_exempt": ("伞锚点" in status_raw or "落点=" in status_raw),
                       "code_refs": [], "test_refs": []}
            in_gaps = False
            continue

        if re.match(r'^## ', line):
            if current:
                cards.append(current)
                current = None
            in_gaps = bool(re.match(r'^## 落差清单', line))
            continue

        if current:
            if not current["description"]:
                s = line.strip()
                if s and not s.startswith("-") and not s.startswith("#") and not s.startswith("|"):
                    current["description"] = s

            # 该行末尾 `— @a: anc-x, anc-y` 声明了这条引用**归属哪个锚点**。
            # 卡片是嵌套树：一张卡片下常列出相关锚点的落点（如 anc-step-commit 卡片下
            # 列 `validator.ts — @a: anc-rule-p2`）——那是 anc-rule-p2 的落点，不是本卡片的。
            # 不按行绑定就会拿本卡片 id 去那个文件里找，必然找不到 → 假报缺失（2026-08-01
            # 发现 58 处报缺里 25 处是此类误报）。
            # 见 design/concept-anchor-rules.md ^anc-meta-card-ref-owner
            # @a: anc-meta-card-ref-owner
            declared = parse_anchor_ids(line.split("@a:")[-1] if "@a:" in line
                                       else line.split("@v:")[-1]) if ("@a:" in line or "@v:" in line) else []
            owner = current["id"] if (not declared or current["id"] in declared) else declared[0]

            # 可校验引用的判据 = 行内带 @a:/@v: 声明（concept-anchor-rules「追溯文件」节，2026-08-03）。
            # 散文行提到文件名（"(未覆盖) types.ts……"、"`engine.ts` getLogEvents() 消费……"）是说明
            # 不是引用——当引用校验会逼卡片回避文件名，毁可读性换指标。
            if declared or "@a:" in line or "@v:" in line:
                is_v = "@v:" in line
                for fm in code_ref_re.finditer(line):
                    fname = fm.group(1)
                    lineno = int(fm.group(2)) if fm.group(2) else None  # 行号可选（旧式引用残留）
                    # 路径以仓库根为基准：已带合法目录前缀的不动，裸文件名按 @a:/@v: 归 src/tests
                    if "/" in fname:
                        path = fname
                    elif is_v or '.test.' in fname or '_test.' in fname or fname.startswith('test_'):
                        path = test_dir + "/" + fname
                    else:
                        path = src_dir + "/" + fname
                    bucket = "test_refs" if is_v else "code_refs"
                    current[bucket].append({"file": path, "line": lineno, "owner": owner})

        if in_gaps:
            gm = re.match(r'^\|\s*(\d+)\s*\|\s*(anc-[^\|]+?)\s*\|(.+?)\|\s*(.+?)\s*\|', line)
            if gm:
                gaps.append({"num": int(gm.group(1)), "anchor": gm.group(2).strip(),
                             "description": gm.group(3).strip(), "decision": gm.group(4).strip()})

    if current:
        cards.append(current)

    # Batch verify line refs
    file_cache = {}

    def cached_read(filepath):
        if filepath not in file_cache:
            file_cache[filepath] = read_lines(os.path.join(project, filepath))
        return file_cache[filepath]

    # 引用有效性校验：验证「该文件存在，且文件内确有标注本卡片锚点 id 的 @a:/@v:」。
    # 不再比对行号——行号是必然腐坏的快照（2026-08-01 前 310 处"漂移"里 57 处其实是
    # 文件已删除的死引用，253 处是代码增删导致的偏移，修完即再漂移）。锚点 id 才是稳定定位器。
    invalid_refs = []

    def check_ref(card_id, ref, marker):
        # 校验对象是该引用行声明的归属锚点（owner），不是卡片 id——见上方 owner 计算处注释
        target = ref.get("owner") or card_id
        flines = cached_read(ref["file"])
        if not flines:
            invalid_refs.append({"id": card_id, "owner": target, "ref": ref["file"],
                                 "reason": "引用的文件不存在或为空（死引用）"})
            ref["valid"] = False
            return
        # 锚点行形如「// @a: <锚点id>, <锚点id>」—— 逐行找标注了归属锚点 id 的那一行。
        # 例外：anc-struct-* 是**模块定位锚点**，按工程实现链规范其代码落点形式是
        # `// @module: <模块名> ^anc-struct-x`（见规范「模块归属标注」表），不是 @a:。
        # 用 @a: 判据校验它们必然找不到 → 假报缺失。模块归属另有 scan_module 维度专管。
        markers = (marker, "@module:") if target.startswith("anc-struct-") else (marker,)
        found = any(any(mk in ln for mk in markers) and target in ln for ln in flines)
        ref["valid"] = found
        if not found:
            has_marker = any(marker in ln for ln in flines)
            invalid_refs.append({
                "id": card_id, "owner": target, "ref": ref["file"],
                "reason": (f"文件内有 {marker} 但无归属锚点 {target}" if has_marker
                           else f"文件内无任何 {marker} 标注"),
            })

    for card in cards:
        for ref in card["code_refs"]:
            check_ref(card["id"], ref, "@a:")
        for ref in card["test_refs"]:
            check_ref(card["id"], ref, "@v:")

    dump({"cards": cards, "gaps": gaps, "invalid_refs": invalid_refs},
         os.path.join(project, ".anchor-audit", "traceability_cards.yaml"))
    return len(cards), len(invalid_refs)


# ---------------------------------------------------------------------------
# scan_modules —— 文件级 @module / @module-deps 归属（横向追溯）
# ---------------------------------------------------------------------------

# // @module: <模块名> ^anc-struct-xxx  （锚点可以是 struct/provider/obs 等任一定位锚点）
MODULE_RE = re.compile(r'(?://|#)\s*@module:\s*(\S+)\s+\^(anc-[a-z][a-z0-9-]*)')
# // @module-deps: a, b, c
MODULE_DEPS_RE = re.compile(r'(?://|#)\s*@module-deps:\s*(.+)')
# 本地 import 路径：from './x.js' / from '../src/x.js'（取末段文件名 x）
IMPORT_RE = re.compile(r"""from\s+['"](\.\.?/[\w./-]+?)['"]""")


def _basename_noext(import_path):
    # './engine-vars.js' -> 'engine-vars'；'../src/parser.js' -> 'parser'
    base = import_path.rsplit('/', 1)[-1]
    for ext in ('.js', '.ts'):
        if base.endswith(ext):
            base = base[:-len(ext)]
    return base


# 测试案例标记：vitest/jest 的 it(/test( + pytest 的 def test_
TEST_CASE_RE = re.compile(r'\b(?:it|test)\s*\(|^\s*def\s+test_', re.MULTILINE)


def _count_code_lines(text):
    # 非空、非纯注释行计为代码行（粗粒度规模度量，非精确 SLOC）
    n = 0
    for ln in text.split("\n"):
        s = ln.strip()
        if s and not s.startswith("//") and not s.startswith("#") and not s.startswith("*"):
            n += 1
    return n


def _design_section_chars(project, design_dirs, anchor):
    """统计某模块定位锚点所在设计章节的字符数（规模度量）。
    定位锚点所在行→下一个 ^anc-* 行或同级/更高级标题止，截取区间计字符。锚点未找到返回 0。
    """
    anchor_re = re.compile(r' \^(anc-[a-z][a-z0-9-]*)\s*$')
    head_re = re.compile(r'^(#{1,6})\s')
    for d in design_dirs:
        dpath = os.path.join(project, d)
        if not os.path.isdir(dpath):
            continue
        for root, subdirs, files in os.walk(dpath):
            subdirs[:] = [s for s in subdirs if s not in _MD_SKIP_DIRS]
            for fname in sorted(files):
                if not fname.endswith(".md"):
                    continue
                lines = read_lines(os.path.join(root, fname))
                hit = None
                for i, ln in enumerate(lines):
                    m = anchor_re.search(ln.rstrip("\n"))
                    if m and m.group(1) == anchor:
                        hit = i
                        break
                if hit is None:
                    continue
                # 命中行起，到下一个锚点行 / 标题行止
                end = len(lines)
                for j in range(hit + 1, len(lines)):
                    s = lines[j].rstrip("\n")
                    if anchor_re.search(s) or head_re.match(s):
                        end = j
                        break
                return sum(len(lines[k]) for k in range(hit, end))
    return 0


def scan_modules(project, src_dir, test_dir, design_dirs):
    """扫 src+test 文件头 @module / @module-deps + 每模块规模统计。
    - file_modules: 单一归属文件 → 模块（建立 文件名 stem → 模块 反查表）
    - unassigned: 既无 @module 也无 @module-deps 的文件
    - integration_deps: 有 @module-deps 的集成测试，记声明集 + import 推导集
    - module_scale: 每模块 {code_lines, test_cases, design_chars, src_files, test_files}
      （确定性规模度量，供语义审计按模块聚合时标注模块体量）
    """
    file_modules = []        # {file, module, anchor, stem}
    integration = []         # {file, declared:[...], imports:[...stem]}
    unassigned = []
    stem_to_module = {}      # 文件名 stem → 模块名（反查表，来自 @module 标注自身）
    # 每模块规模累加器：module → {anchor, code_lines, test_cases, src_files, test_files}
    scale = {}

    def _is_src(rel):
        return rel.startswith(src_dir + os.sep) or rel.startswith(src_dir + "/")

    # 第一遍：扫所有文件的 @module，建反查表 + 累加规模
    targets = []
    for base_dir in (src_dir, test_dir):
        dpath = os.path.join(project, base_dir)
        if not os.path.isdir(dpath):
            continue
        for root, _dirs, files in os.walk(dpath):
            for fname in sorted(files):
                if not fname.endswith(CODE_EXTENSIONS):
                    continue
                targets.append(os.path.join(root, fname))

    for fpath in targets:
        rel = os.path.relpath(fpath, project)
        text = read_text(fpath)
        head = "\n".join(text.split("\n")[:15])  # 标注在文件头部
        mod_m = MODULE_RE.search(head)
        deps_m = MODULE_DEPS_RE.search(head)
        stem = _basename_noext(rel)
        if mod_m:
            module, anchor = mod_m.group(1), mod_m.group(2)
            file_modules.append({"file": rel, "module": module, "anchor": anchor, "stem": stem})
            if _is_src(rel):
                stem_to_module[stem] = module  # 反查表：仅 src 是 import 目标
            sc = scale.setdefault(module, {"anchor": anchor, "code_lines": 0,
                                           "test_cases": 0, "src_files": 0, "test_files": 0})
            if _is_src(rel):
                sc["code_lines"] += _count_code_lines(text)
                sc["src_files"] += 1
            else:
                sc["test_cases"] += len(TEST_CASE_RE.findall(text))
                sc["test_files"] += 1
        elif deps_m:
            declared = [d.strip() for d in deps_m.group(1).split(",") if d.strip()]
            imp_stems = sorted({_basename_noext(m.group(1)) for m in IMPORT_RE.finditer(text)})
            integration.append({"file": rel, "declared": sorted(declared), "import_stems": imp_stems})
        else:
            unassigned.append(rel)

    # 第二遍：用反查表把集成测试的 import stem 映射成模块集
    for it in integration:
        mods = sorted({stem_to_module[s] for s in it["import_stems"] if s in stem_to_module})
        it["imported_modules"] = mods
        del it["import_stems"]

    # 第三遍：补每模块的设计章节字数（按定位锚点切片）
    for module, sc in scale.items():
        sc["design_chars"] = _design_section_chars(project, design_dirs, sc["anchor"])

    # 规模列表按 code_lines 降序，便于报告优先关注大模块
    module_scale = [{"module": m, **sc} for m, sc in scale.items()]
    module_scale.sort(key=lambda x: x["code_lines"], reverse=True)

    dump({"file_modules": file_modules, "unassigned": unassigned,
          "integration_deps": integration,
          "module_anchors_known": sorted(set(m["anchor"] for m in file_modules)),
          "module_scale": module_scale},
         os.path.join(project, ".anchor-audit", "module_anchors.yaml"))
    return len(file_modules), len(unassigned)


# ---------------------------------------------------------------------------
# 模块边界接口校验（增量式：仅对已在设计层声明 ⑤ 对外接口清单的模块生效）
# ---------------------------------------------------------------------------

# 具名 import：from './x.js' import { A, B as C, type D }。捕获整个 { } 花名册 + 路径。
NAMED_IMPORT_RE = re.compile(
    r"import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['\"](\.\.?/[\w./-]+?)['\"]",
    re.DOTALL,
)
# ⑤ 清单锚点：^anc-<module>-exports（挂在对外接口清单节标题）。
EXPORTS_ANCHOR_RE = re.compile(r'\^(anc-[a-z0-9-]+-exports)\b')
# markdown 表格数据行：| 符号 | ... |。取第一列整格（可含多个 `符号`，见 _row_symbols）。
TABLE_ROW_RE = re.compile(r'^\|([^|]*)\|')
# 从第一列格提取所有反引号包裹的符号（一格可列多个：`A` / `B` / `C`，或 `A`…`Z`）。
CELL_SYMBOL_RE = re.compile(r'`([A-Za-z_][\w]*)`')


def _row_symbols(cell):
    """从表格第一列格提取所有公开符号。支持一格多符号（反引号包裹）。
    无反引号时回退取首 token（兼容裸写）。"""
    syms = CELL_SYMBOL_RE.findall(cell)
    if syms:
        return syms
    m = re.match(r'\s*([A-Za-z_][\w]*)', cell)
    return [m.group(1)] if m else []


def _parse_named_import_symbols(clause):
    """'A, B as C, type D' → ['A','C','D']（取绑定到本地的名字，剥 type/as）。"""
    out = []
    for part in clause.split(','):
        p = part.strip()
        if not p:
            continue
        p = re.sub(r'^type\s+', '', p)  # 剥 `type ` 前缀
        m = re.search(r'\bas\s+([A-Za-z_]\w*)$', p)  # `X as Y` → 取 Y
        out.append(m.group(1) if m else re.sub(r'\W.*$', '', p))
    return [s for s in out if s]


def _parse_exports_manifest(project, design_dirs):
    """从设计文档解析各模块 ⑤ 对外接口清单。
    锚点 ^anc-<X>-exports 所在节的 markdown 表格 = 公开符号集;
    节内 `出口 = a.ts / b.ts` 或表格"出口文件"列 = 出口文件 stem 集。
    返回 {module_anchor_prefix: {"symbols": set, "exit_stems": set, "doc": rel}}。
    仅声明了 ⑤ 清单的模块入表——机检对未声明模块不生效（增量式）。
    """
    manifests = {}
    for ddir in design_dirs:
        dpath = os.path.join(project, ddir)
        if not os.path.isdir(dpath):
            continue
        for root, subdirs, files in os.walk(dpath):
            subdirs[:] = [s for s in subdirs if s not in _MD_SKIP_DIRS]
            for fname in sorted(files):
                if not fname.endswith('.md'):
                    continue
                fpath = os.path.join(root, fname)
                rel = os.path.relpath(fpath, project)
                lines = read_text(fpath).split('\n')
                # 找 exports 锚点行，从该行向下吃到下一个 ## 标题为止
                for i, line in enumerate(lines):
                    am = EXPORTS_ANCHOR_RE.search(line)
                    if not am:
                        continue
                    anchor = am.group(1)  # anc-struct-exec-engine-exports
                    symbols, exit_stems = set(), set()
                    for j in range(i + 1, len(lines)):
                        nxt = lines[j]
                        # 节末：下一个 ## 标题,或另一个 exports 锚点的**真定义**(行尾 ^anc-...-exports)。
                        # `[[文档#^anc-...-exports]]` 只是引用,不是节起点——不可当节末(否则截断本节表格)。
                        nxt_anchor = EXPORTS_ANCHOR_RE.search(nxt)
                        is_anchor_def = bool(nxt_anchor) and '[[' not in nxt[:nxt_anchor.start()]
                        if nxt.startswith('## ') or is_anchor_def:
                            break
                        # 出口文件声明：抓行内所有 <name>.ts
                        for em in re.finditer(r'`?([\w-]+)\.ts`?', nxt):
                            exit_stems.add(em.group(1))
                        # 表格数据行第一列 = 公开符号（跳表头/分隔行；一格可列多符号）
                        rm = TABLE_ROW_RE.match(nxt.strip())
                        if rm:
                            cell = rm.group(1).strip()
                            if cell in ('符号', 'Symbol') or set(cell) <= set('-: '):
                                continue  # 表头 / 分隔行
                            for s in _row_symbols(cell):
                                symbols.add(s)
                    manifests[anchor] = {"symbols": sorted(symbols),
                                         "exit_stems": sorted(exit_stems), "doc": rel}
    return manifests


# 顶层 export 声明（函数/类/接口/类型/枚举/常量，含 abstract）。捕获符号名。
EXPORT_DECL_RE = re.compile(
    r'^export\s+(?:abstract\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_]\w*)')
# 纯 re-export 转发行（export { X } from './y'）——豁免，语义在源头。
REEXPORT_RE = re.compile(r'^export\s+(?:type\s+)?\{[^}]*\}\s+from\s')


def _scan_export_comments(project, exit_stems_by_file):
    """对每个出口文件扫顶层 export，判紧邻上方是否有说明性注释。
    规则：export 行向上跳过空行后的第一非空行，以 // /* * 开头或 */ 结尾 = 有注释。
    行尾 // @a: 追溯锚点不算职责注释（那是给追溯的）——故只看**上方**行，不看 export 行自身尾注。
    返回 [{file, symbol, line, has_comment}]（仅出口文件、仅顶层 export）。re-export 转发行豁免。
    """
    records = []
    for rel, stem in exit_stems_by_file:
        fpath = os.path.join(project, rel)
        if not os.path.exists(fpath):
            continue
        lines = read_text(fpath).split('\n')
        for i, line in enumerate(lines):
            if REEXPORT_RE.match(line):
                continue  # 纯转发豁免
            m = EXPORT_DECL_RE.match(line)
            if not m:
                continue
            # 向上跳空行，取第一非空行
            k = i - 1
            while k >= 0 and lines[k].strip() == '':
                k -= 1
            has = False
            if k >= 0:
                s = lines[k].strip()
                if s.startswith('//') or s.startswith('/*') or s.startswith('*') or s.endswith('*/'):
                    has = True
            records.append({"file": rel, "symbol": m.group(1),
                            "line": i + 1, "has_comment": has})
    return records


def scan_module_boundaries(project, src_dir, design_dirs):
    """跨模块 import 合法性原料：抽 src 文件的具名跨模块 import（符号级）+ 各模块 ⑤ 清单。
    输出 module_boundaries.yaml，供 cross_compare 做三项校验：
      ① 深入非出口文件：import 目标 stem ∉ 目标模块出口文件集
      ② import 表外符号：符号 ∉ 目标模块公开清单
      ③ 出口注释完整性：出口文件 export 符号上方无说明注释（export_comments）
    仅对声明了 ⑤ 清单的模块生效（增量式）。tests 白盒、同模块 import 由 cross_compare 侧豁免。
    """
    # 复用 scan_modules 已写的 module_anchors.yaml（file→module + anchor）
    ma_path = os.path.join(project, ".anchor-audit", "module_anchors.yaml")
    file_modules = []
    if os.path.exists(ma_path):
        import yaml as _yaml
        with open(ma_path, encoding='utf-8') as f:
            file_modules = (_yaml.safe_load(f) or {}).get("file_modules", [])
    stem_to_module = {fm["stem"]: fm["module"] for fm in file_modules
                      if fm["file"].startswith(src_dir + os.sep) or fm["file"].startswith(src_dir + "/")}
    stem_to_anchor = {fm["stem"]: fm["anchor"] for fm in file_modules}

    manifests = _parse_exports_manifest(project, design_dirs)
    # 锚点前缀（anc-struct-exec-engine）→ exports 清单
    manifest_by_module_anchor = {a[:-len("-exports")]: m for a, m in manifests.items()}

    # 抽每个 src 文件的具名跨模块 import
    cross_imports = []  # {file, from_module, target_stem, target_module, symbols:[...]}
    spath = os.path.join(project, src_dir)
    for root, _dirs, files in os.walk(spath):
        for fname in sorted(files):
            if not fname.endswith(CODE_EXTENSIONS):
                continue
            fpath = os.path.join(root, fname)
            rel = os.path.relpath(fpath, project)
            stem = _basename_noext(rel)
            from_module = stem_to_module.get(stem)
            text = read_text(fpath)
            for m in NAMED_IMPORT_RE.finditer(text):
                syms = _parse_named_import_symbols(m.group(1))
                tgt_stem = _basename_noext(m.group(2))
                tgt_module = stem_to_module.get(tgt_stem)
                if not tgt_module or tgt_module == from_module:
                    continue  # 非本地模块 / 同模块 → 不检
                cross_imports.append({
                    "file": rel, "from_module": from_module,
                    "target_stem": tgt_stem, "target_module": tgt_module,
                    "target_anchor": stem_to_anchor.get(tgt_stem),
                    "symbols": syms,
                })

    # 出口注释校验：收集所有已声明模块的出口文件（stem ∈ 某 manifest 的 exit_stems），
    # 映射到 src 下实际文件，扫其顶层 export 的注释状态。
    declared_exit_stems = set()
    for man in manifest_by_module_anchor.values():
        declared_exit_stems.update(man.get("exit_stems", []))
    stem_to_relfile = {}
    for root, _dirs, files in os.walk(spath):
        for fname in sorted(files):
            if not fname.endswith(CODE_EXTENSIONS):
                continue
            rel = os.path.relpath(os.path.join(root, fname), project)
            stem_to_relfile[_basename_noext(rel)] = rel
    exit_files = [(stem_to_relfile[s], s) for s in sorted(declared_exit_stems)
                  if s in stem_to_relfile]
    export_comments = _scan_export_comments(project, exit_files)

    dump({"manifests": manifest_by_module_anchor,
          "cross_imports": cross_imports,
          "export_comments": export_comments},
         os.path.join(project, ".anchor-audit", "module_boundaries.yaml"))
    return len(manifest_by_module_anchor), len(cross_imports)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="anchor-audit 四层锚点扫描")
    parser.add_argument("project", help="项目根目录")
    parser.add_argument("--design-dir", nargs="+", default=["docs/design", "docs/reference", "ARCHITECTURE.md"])
    parser.add_argument("--src-dir", default="src")
    parser.add_argument("--aux-test-dirs", nargs="*", default=["scripts", "editors"],
                        help="附加测试落点目录（真机断言 @v: 挂锚处,5a 断言在链——G13）")
    parser.add_argument("--aux-src-dirs", nargs="*", default=["scripts", "editors"],
                        help="附加代码落点目录（如机检守卫 scripts/），与 --src-dir 一并扫 @a:")
    parser.add_argument("--test-dir", default="tests")
    parser.add_argument("--concept-dir", nargs="*", default=["docs/concepts"],
                        help="概念层 Markdown 目录（S→D 存在性覆盖权威源）；本库快照即 docs/concepts（G6 销账 2026-08-03）；目录不存在则 S→D 维度 skip")
    args = parser.parse_args()

    project = os.path.abspath(args.project)
    if not os.path.isdir(project):
        print(f"错误: 项目目录不存在: {project}", file=sys.stderr)
        sys.exit(2)

    os.makedirs(os.path.join(project, ".anchor-audit"), exist_ok=True)

    print(f"扫描项目: {project}")
    print(f"  概念: {', '.join(args.concept_dir) or '(无，S→D skip)'}  设计: {', '.join(args.design_dir)}  源码: {args.src_dir}/  测试: {args.test_dir}/")
    print()

    has_findings = False

    cc_count, cc_viol = scan_concept(project, args.concept_dir, args.design_dir,
                                     args.src_dir, args.test_dir)
    print(f"概念锚点: {cc_count}  命名违规: {cc_viol}")
    has_findings |= cc_viol > 0

    d_count, d_viol = scan_design(project, args.design_dir)
    print(f"设计锚点: {d_count}  命名违规: {d_viol}")
    has_findings |= d_viol > 0

    c_count, c_viol = scan_code(project, [args.src_dir] + list(args.aux_src_dirs))
    print(f"代码锚点: {c_count}  命名违规: {c_viol}")
    has_findings |= c_viol > 0

    t_count, t_viol = scan_test(project, args.test_dir, args.aux_test_dirs)
    print(f"测试锚点: {t_count}  命名违规: {t_viol}")
    has_findings |= t_viol > 0

    tr_count, tr_invalid = scan_traceability(project, args.src_dir, args.test_dir)
    print(f"追溯卡片: {tr_count}  无效引用: {tr_invalid}")
    has_findings |= tr_invalid > 0

    m_count, m_unassigned = scan_modules(project, args.src_dir, args.test_dir, args.design_dir)
    print(f"模块归属: {m_count}  漏标文件: {m_unassigned}")
    has_findings |= m_unassigned > 0

    b_manifests, b_imports = scan_module_boundaries(project, args.src_dir, args.design_dir)
    print(f"模块边界清单: {b_manifests} 个已声明  跨模块 import: {b_imports}")

    audit_dir = os.path.join(project, ".anchor-audit")
    print(f"\n输出目录: {audit_dir}/")
    for f in ("concept_anchors.yaml", "design_anchors.yaml", "code_anchors.yaml",
              "test_anchors.yaml", "traceability_cards.yaml", "module_anchors.yaml",
              "module_boundaries.yaml"):
        print(f"  {f}")

    sys.exit(1 if has_findings else 0)


if __name__ == "__main__":
    main()
