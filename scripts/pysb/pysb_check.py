#!/usr/bin/env python3
# Python 语法沙箱检查器——三条规则的唯一实现。 # @a: anc-pysb-defenses
# 契约权威 docs/design/py-sandbox.md（检查器 HopTrait/HopType/HopSop + 白名单三表）;
# 概念权威 docs/concepts/HopSpec V3扩展-Python语法沙箱.md §2.2。
#
# 用法: python3 -I -B pysb_check.py <脚本路径>
# stdout 恰好一行 JSON: {"ok": true} 或 {"ok": false, "violations": [{line, name, reason, alternative}]}
# 退出码: 审完(不论过没过)恒 0;检查器自身出错(读不到文件/内部异常)=2,stderr 写原因。
# 检查器只解析与遍历,不执行被审脚本的任何部分。
import ast
import builtins
import json
import sys

# 表一：模块符号（规则二）。键=模块名,值=放行的符号;条目都可以当值用。
MODULE_SYMBOLS = {
    "ast": {"parse", "walk", "FunctionDef", "AsyncFunctionDef", "ClassDef", "get_docstring", "iter_child_nodes"},
    "re": {"match", "search", "findall", "sub", "split", "escape"},
    "json": {"loads", "dumps"},
    "sys": {"argv", "exit", "stderr"},
}

# 表二：内置名（规则三）。open 另有用法许可(只许直接调用),其余可当值用。
BUILTIN_NAMES = set("""
print len range int str float bool list dict set tuple
enumerate sorted reversed sum min max any all abs zip map filter
isinstance repr open
Exception ValueError KeyError OSError SyntaxError
""".split())
DIRECT_CALL_ONLY = {"open"}
OPEN_READ_MODES = {"r", "rb", "rt"}
OPEN_KEYWORDS = {"mode", "encoding", "errors", "newline", "buffering"}

# 表三：对象属性名（规则三）。ast 节点字段机械导出 + 手列常用方法。
AST_FIELDS = set()
for _n in dir(ast):
    _c = getattr(ast, _n)
    if isinstance(_c, type) and issubclass(_c, ast.AST):
        AST_FIELDS |= set(_c._fields) | set(getattr(_c, "_attributes", ()))
METHOD_NAMES = set("""
strip lstrip rstrip split rsplit splitlines join startswith endswith replace lower upper find rfind count
isdigit isalpha isspace isidentifier partition rpartition removeprefix removesuffix ljust rjust center zfill
append extend insert pop remove index sort reverse copy clear get keys values items setdefault update
add discard union intersection difference issubset
read readline readlines close
group groups start end span groupdict
""".split())
ATTRIBUTE_NAMES = AST_FIELDS | METHOD_NAMES

# "是不是内置名"的判定面:运行本检查器的 Python 的内置名全集,另并 site 注入的几个(防 -S 启动时漏判)。
ALL_BUILTINS = set(dir(builtins)) | {"help", "exit", "quit", "copyright", "credits", "license"}

MODULE_LIST_TEXT = " ".join(f"{m}.{s}" for m in MODULE_SYMBOLS for s in sorted(MODULE_SYMBOLS[m]))
BUILTIN_LIST_TEXT = " ".join(sorted(BUILTIN_NAMES))

# 常见被拒名字的具体替代写法;查不到的给该类白名单清单。
MODULE_ALTERNATIVES = {
    "os": "读文件用内置 open(路径)（只读模式）;取命令行参数用 sys.argv",
    "pathlib": "读文件用内置 open(路径)（只读模式）;路径拼接用字符串操作",
    "subprocess": "产物脚本不能起子进程——把要做的计算直接写在本脚本里",
    "shutil": "产物脚本只读不写,不能复制/删除文件",
}
BUILTIN_ALTERNATIVES = {
    "type": "判断类型用 isinstance(x, 类型),例如 isinstance(n, ast.FunctionDef)",
    "getattr": "直接写 x.属性名",
    "hasattr": "直接写 x.属性名,或用 isinstance 先判类型",
    "__name__": "产物由引擎直接当脚本执行,不需要 if __name__ == '__main__' 守卫,主逻辑写在顶层即可",
    "__file__": "要处理的文件路径用命令行参数传入,从 sys.argv 取",
    "eval": "没有替代——产物脚本不能运行期求值字符串代码",
    "exec": "没有替代——产物脚本不能运行期执行字符串代码",
}
ATTRIBUTE_ALTERNATIVES = {
    "format": "拼字符串用 f-string,例如 f'{name}: {count}'",
    "format_map": "拼字符串用 f-string,例如 f'{name}: {count}'",
    "write": "产物脚本不落盘;报错输出用 print(…, file=sys.stderr),正常输出用 print(…)",
    "writelines": "产物脚本不落盘;报错输出用 print(…, file=sys.stderr),正常输出用 print(…)",
    "compile": "直接用 re.search(模式, 文本) 这类模块级函数（它们自带编译缓存）",
}


def _binding_name(node, parents):
    """返回该节点在绑定位置上引入的名字;不是绑定位置返回 None。"""
    if isinstance(node, ast.Name) and not isinstance(node.ctx, ast.Load):
        return node.id
    if isinstance(node, ast.arg):
        return node.arg
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return node.name
    if isinstance(node, ast.ExceptHandler):
        return node.name
    for cls_name in ("MatchAs", "MatchStar", "TypeVar", "ParamSpec", "TypeVarTuple"):
        cls = getattr(ast, cls_name, None)
        if cls is not None and isinstance(node, cls):
            return node.name
    match_mapping = getattr(ast, "MatchMapping", None)
    if match_mapping is not None and isinstance(node, match_mapping):
        return node.rest
    if isinstance(node, ast.alias) and not isinstance(parents.get(node), ast.Import):
        return node.asname or node.name
    return None


def check_source(source_bytes):
    """按三条规则审一份源码的原始字节,返回拒绝记录列表(空=通过)。"""
    violations = []

    def reject(line, name, reason, alternative):
        violations.append({"line": line or 0, "name": name, "reason": reason, "alternative": alternative})

    # 规则一:原始字节直接交 CPython 自己的解析器(编码声明与标识符 NFKC 归一照 CPython 语义)
    try:
        tree = ast.parse(source_bytes)
    except SyntaxError as e:
        reject(e.lineno, "<语法>", f"脚本解析失败:{e.msg}", "按报错位置修正语法后再跑")
        return violations
    except ValueError as e:
        reject(0, "<语法>", f"脚本解析失败:{e}", "去掉源码里的空字节等非法字符后再跑")
        return violations

    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}

    # 规则二·import 形态:只许 import 模块,模块 ∈ 表一
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            reject(node.lineno, f"from {node.module or '.'} import", "不许 from 形态的 import",
                   f"改写成 import 模块,使用处写 模块.符号。可用的模块符号:{MODULE_LIST_TEXT}")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    reject(node.lineno, alias.name, "不许用 as 给模块改名", f"直接 import {alias.name},使用处写 {alias.name}.符号")
                elif alias.name not in MODULE_SYMBOLS:
                    reject(node.lineno, alias.name, f"{alias.name} 不在模块白名单内",
                           MODULE_ALTERNATIVES.get(alias.name.split(".")[0], f"可用的模块符号:{MODULE_LIST_TEXT}"))
                else:
                    imported.add(alias.name)

    for node in ast.walk(tree):
        # 绑定位置:模块名、内置名、下划线开头的名字都不许被重新绑定
        bound = _binding_name(node, parents)
        if bound:
            if bound in imported:
                reject(getattr(node, "lineno", 0), bound, f"{bound} 是已导入的模块名,不许重新绑定", "换一个名字")
            elif bound.startswith("_"):
                reject(getattr(node, "lineno", 0), bound, "不许绑定下划线开头的名字",
                       "换一个不以下划线开头的普通名字(如 unused、item);类里需要 __init__ 时改用 dict 或函数")
            elif bound in ALL_BUILTINS:
                reject(getattr(node, "lineno", 0), bound, f"{bound} 是内置名,不许重新绑定", f"换一个名字(如 my_{bound})")
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            for name in node.names:
                if name in imported or name in ALL_BUILTINS or name.startswith("_"):
                    reject(node.lineno, name, f"不许声明 {name}", "换一个普通名字")

        # 对象属性:模块名后的 .符号 交下面的模块名分支核,其余一律查表三
        if isinstance(node, ast.Attribute):
            if isinstance(node.value, ast.Name) and node.value.id in imported:
                pass
            elif node.attr.startswith("_"):
                reject(node.lineno, f".{node.attr}", "不许访问下划线开头的属性", "可用的属性只有表三里的方法与语法树字段")
            elif node.attr not in ATTRIBUTE_NAMES:
                reject(node.lineno, f".{node.attr}", f"属性 {node.attr} 不在属性白名单内",
                       ATTRIBUTE_ALTERNATIVES.get(node.attr, "改用白名单内的方法(字符串/列表/字典/集合常用方法、文件 read 系列、匹配结果 group 系列、语法树节点字段)"))

        match_class = getattr(ast, "MatchClass", None)
        if match_class is not None and isinstance(node, match_class):
            for attr in node.kwd_attrs:
                if attr.startswith("_") or attr not in ATTRIBUTE_NAMES:
                    reject(node.lineno, attr, f"match 类模式里取属性 {attr} 不在属性白名单内", "改用白名单内的属性名")

        if not (isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)):
            continue
        parent = parents.get(node)

        # 模块名:只许以 模块.符号 形态出现,且组合 ∈ 表一
        if node.id in imported:
            if not (isinstance(parent, ast.Attribute) and parent.value is node):
                reject(node.lineno, node.id, f"模块 {node.id} 不许当值使用(传参/赋值/放进容器)",
                       f"只写 {node.id}.符号 这一种形态")
            elif parent.attr not in MODULE_SYMBOLS[node.id]:
                reject(node.lineno, f"{node.id}.{parent.attr}", f"{node.id}.{parent.attr} 不在模块符号白名单内",
                       ATTRIBUTE_ALTERNATIVES.get(parent.attr, f"可用的模块符号:{MODULE_LIST_TEXT}"))
            elif not isinstance(parent.ctx, ast.Load):
                reject(node.lineno, f"{node.id}.{parent.attr}", "不许给模块属性赋值或删除", "把值存进自己的变量")
            continue

        # 内置名:∈ 表二,且按用法许可核
        if node.id in ALL_BUILTINS or node.id.startswith("_"):
            if node.id not in BUILTIN_NAMES:
                reject(node.lineno, node.id, f"内置名 {node.id} 不在内置名白名单内",
                       BUILTIN_ALTERNATIVES.get(node.id, f"可用的内置名:{BUILTIN_LIST_TEXT}"))
            elif node.id in DIRECT_CALL_ONLY:
                _check_direct_call(node, parent, reject)

    unique = {(v["line"], v["name"], v["reason"]): v for v in violations}
    return sorted(unique.values(), key=lambda v: (v["line"], v["name"]))


def _check_direct_call(node, parent, reject):
    """open 的用法许可:只许直接调用;模式实参缺席或是字面量 r/rb/rt;不许展开实参。"""
    if not (isinstance(parent, ast.Call) and parent.func is node):
        reject(node.lineno, node.id, f"{node.id} 只许直接调用,不许当值使用(赋值/放进容器/当实参/作类属性)",
               f"在要读文件的地方直接写 {node.id}(路径)")
        return
    if any(isinstance(a, ast.Starred) for a in parent.args) or any(k.arg is None for k in parent.keywords):
        reject(node.lineno, node.id, f"{node.id} 的实参不许用 * 或 ** 展开", f"把实参逐个写出来,例如 {node.id}(路径, 'r')")
        return
    if len(parent.args) > 2:
        reject(node.lineno, node.id, f"{node.id} 最多两个位置实参(路径与模式)", "其余参数用关键字写,例如 encoding='utf-8'")
    for kw in parent.keywords:
        if kw.arg not in OPEN_KEYWORDS:
            reject(node.lineno, node.id, f"{node.id} 不许用关键字实参 {kw.arg}", f"可用的关键字:{' '.join(sorted(OPEN_KEYWORDS))}")
    mode = parent.args[1] if len(parent.args) > 1 else next((k.value for k in parent.keywords if k.arg == "mode"), None)
    if mode is not None and not (isinstance(mode, ast.Constant) and mode.value in OPEN_READ_MODES):
        reject(node.lineno, node.id, f"{node.id} 的模式实参必须是字面量 'r'、'rb' 或 'rt'(产物脚本只读不写)",
               "读文件写 open(路径) 或 open(路径, 'r');报错输出用 print(…, file=sys.stderr)")


def main(argv):
    if len(argv) != 2:
        print("用法: pysb_check.py <脚本路径>", file=sys.stderr)
        return 2
    try:
        with open(argv[1], "rb") as f:
            source_bytes = f.read()
    except OSError as e:
        print(f"检查器读不到被审脚本: {e}", file=sys.stderr)
        return 2
    violations = check_source(source_bytes)
    result = {"ok": True} if not violations else {"ok": False, "violations": violations}
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
