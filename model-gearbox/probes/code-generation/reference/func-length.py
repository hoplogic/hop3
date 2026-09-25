import ast
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    tree = ast.parse(f.read())
found = 0
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        span = node.end_lineno - node.lineno + 1
        if span > 40:
            print("L" + str(node.lineno) + ": " + node.name + " spans " + str(span) + " lines")
            found += 1
sys.exit(1 if found else 0)
