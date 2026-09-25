import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    text = f.read()
found = 0
for no, line in enumerate(text.split("\n"), start=1):
    line = line.rstrip("\r")
    if len(line) > 100:
        print("L" + str(no) + ": " + str(len(line)) + " characters")
        found += 1
sys.exit(1 if found else 0)
