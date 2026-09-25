import ast
import re
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    tree = ast.parse(f.read())
problems = []


def check(fn):
    doc = ast.get_docstring(fn)
    if doc is None:
        problems.append("L" + str(fn.lineno) + ": " + fn.name + " has no docstring")
        return
    a = fn.args
    params = [p.arg for p in a.posonlyargs + a.args + a.kwonlyargs]
    if a.vararg is not None:
        params.append(a.vararg.arg)
    if a.kwarg is not None:
        params.append(a.kwarg.arg)
    for p in params:
        if p == "self" or p == "cls":
            continue
        if not re.search(r"\b" + re.escape(p) + r"\b", doc):
            problems.append("L" + str(fn.lineno) + ": " + fn.name + " docstring does not mention " + p)


def visit(node, in_func):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if not in_func and not child.name.startswith("_"):
                check(child)
            visit(child, True)
        else:
            visit(child, in_func)


visit(tree, False)
for p in problems:
    print(p)
sys.exit(1 if problems else 0)
