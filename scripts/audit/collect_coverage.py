#!/usr/bin/env python3
"""test-coverage-audit spec 的机械扫描侧脚本——检测/运行/解析/gap 提取四个子命令。

与 spec 的分工（scripts/audit/test-coverage-audit.md Constraints 第一条）：
机械扫描（检测项目类型、运行覆盖率工具、解析数据、按阈值筛选组装）全在本脚本，
零 LLM 参与；覆盖质量判断（缺口严重度、mock 合理性）归 spec 里的 reason 步骤。

子命令（均以 `collect_coverage.py <project_root> <子命令> [参数]` 形态调用，
spec 的 hop_python body 经 `subprocess.run(["uv","run","--with","pyyaml","python3", ...])` 白名单通道执行）：

  --detect    检测项目类型（vitest/jest/pytest/go）与覆盖率工具是否已配置。
              产物：{project_root}/.coverage-audit/detection.yaml；
              stdout 输出同内容 JSON（coverage_configured / project_type / install_cmd），
              供 body parse_json 直接消费。
  --run       运行该类型的覆盖率命令（vitest/jest 经 npx，pytest 经 python3 -m，go 经 go test）。
              测试失败不算脚本失败：脚本恒 exit 0，工具退出码进 stdout JSON（tool_returncode），
              失败时输出尾部写入 run_error.txt 供 spec 兜底记录。
              覆盖率命令超时（1800 秒）同走失败路径：tool_returncode 记 -1 并带 timeout 标记、
              run_error.txt 落盘、脚本自身仍 exit 0。
  --analyze   解析覆盖率原始数据，产出三份 YAML 到 {project_root}/.coverage-audit/：
              coverage_summary.yaml（每文件行/分支覆盖率 + 全局汇总）、
              uncovered_details.yaml（每文件未覆盖行区段 + 源码上下文）、
              mock_patterns.yaml（mock/spy/stub 扫描结果——按 (种类,目标) 分组统计，
              并按机械规则预筛候选组：目标是内部模块（./ ../ src/ 开头）或模块级 mock
              （vi.mock/jest.mock/patch）进 candidates，其余组只计数进 acceptable_groups——
              LLM 审计步只对 candidates 逐条判 FLAG，acceptable 不逐条复述）。
              stdout 输出 JSON {written: [三份文件名], tool_returncode: 0}。
  --gaps      按阈值（--line-threshold 缺省 80，--branch-threshold 缺省 70）筛低覆盖文件，
              每个文件组装为一个自包含文本批（路径 + 覆盖率 + 未覆盖区段 + 源码上下文），
              产物 gaps.yaml；stdout 输出该文本批列表的 JSON 数组，
              供 spec body parse_json 直接赋 gap_files（LLM 零转写）。

依赖：pyyaml（经 uv run --with pyyaml 提供）。产物目录 {project_root}/.coverage-audit/ 自动创建。
"""
import json
import os
import re
import subprocess
import sys

import yaml


def audit_dir(root: str) -> str:
    d = os.path.join(root, ".coverage-audit")
    os.makedirs(d, exist_ok=True)
    return d


def read_json(path: str):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_yaml(path: str, data) -> None:
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)


# ---------------------------------------------------------------- detect


def detect(root: str) -> dict:
    pkg = {}
    pkg_path = os.path.join(root, "package.json")
    if os.path.exists(pkg_path):
        try:
            pkg = read_json(pkg_path)
        except Exception:
            pkg = {}
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}

    def has_file(*names: str) -> bool:
        return any(os.path.exists(os.path.join(root, n)) for n in names)

    if "vitest" in deps or has_file("vitest.config.ts", "vitest.config.js", "vitest.config.mts"):
        return {
            "project_type": "vitest",
            "coverage_configured": "@vitest/coverage-v8" in deps or "@vitest/coverage-istanbul" in deps,
            "install_cmd": "npm install -D @vitest/coverage-v8",
        }
    if "jest" in deps or "jest" in pkg or has_file("jest.config.js", "jest.config.ts"):
        return {"project_type": "jest", "coverage_configured": True, "install_cmd": "none"}  # jest 覆盖率内置
    py_markers = ["pytest.ini", "setup.cfg", "pyproject.toml"]
    py_texts = []
    for m in py_markers:
        p = os.path.join(root, m)
        if os.path.exists(p):
            try:
                py_texts.append(open(p, encoding="utf-8").read())
            except Exception:
                pass
    if any("pytest" in t for t in py_texts) or has_file("conftest.py"):
        configured = any("pytest-cov" in t or "pytest_cov" in t for t in py_texts)
        return {"project_type": "pytest", "coverage_configured": configured, "install_cmd": "uv pip install pytest-cov"}
    if has_file("go.mod"):
        return {"project_type": "go", "coverage_configured": True, "install_cmd": "none"}  # go test 覆盖率内置
    return {"project_type": "unknown", "coverage_configured": False, "install_cmd": "none"}


# ---------------------------------------------------------------- run

RUN_CMDS = {
    "vitest": ["npx", "vitest", "run", "--coverage", "--coverage.reporter=json"],
    "jest": ["npx", "jest", "--coverage", "--coverageReporters=json"],
    "pytest": ["python3", "-m", "pytest", "--cov", "--cov-report=json:.coverage-audit/coverage.json"],
    "go": ["go", "test", "./...", "-coverprofile=.coverage-audit/coverprofile.out"],
}


def run(root: str) -> dict:
    det = detect(root)
    ptype = det["project_type"]
    cmd = RUN_CMDS.get(ptype)
    ad = audit_dir(root)
    if cmd is None:
        with open(os.path.join(ad, "run_error.txt"), "w", encoding="utf-8") as f:
            f.write(f"未知项目类型（{ptype}），无可执行的覆盖率命令")
        return {"tool_returncode": 1, "project_type": ptype}
    try:
        r = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=1800)
    except subprocess.TimeoutExpired:
        with open(os.path.join(ad, "run_error.txt"), "w", encoding="utf-8") as f:
            f.write(f"命令 {' '.join(cmd)} 超时（1800 秒未完成，已中止）")
        return {"tool_returncode": -1, "project_type": ptype, "timeout": True}
    if r.returncode != 0:
        tail = (r.stdout + "\n" + r.stderr)[-4000:]
        with open(os.path.join(ad, "run_error.txt"), "w", encoding="utf-8") as f:
            f.write(f"命令 {' '.join(cmd)} 退出码 {r.returncode}\n{tail}")
    return {"tool_returncode": r.returncode, "project_type": ptype}


# ---------------------------------------------------------------- analyze


def source_context(root: str, rel: str, lines: list, width: int = 2) -> list:
    """对未覆盖行号列表取源码上下文片段（每个连续区段一条）。"""
    path = rel if os.path.isabs(rel) else os.path.join(root, rel)
    try:
        src = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except Exception:
        return [{"lines": f"{lines[0]}-{lines[-1]}", "context": "(源文件不可读)"}] if lines else []
    # 连续行号折区段
    segs, seg = [], [lines[0]] if lines else []
    for n in lines[1:]:
        if n == seg[-1] + 1:
            seg.append(n)
        else:
            segs.append(seg)
            seg = [n]
    if seg:
        segs.append(seg)
    out = []
    for s in segs[:20]:  # 单文件最多 20 区段，防超大文件失控
        lo, hi = max(1, s[0] - width), min(len(src), s[-1] + width)
        ctx = "\n".join(f"{i}: {src[i - 1]}" for i in range(lo, hi + 1))
        out.append({"lines": f"{s[0]}-{s[-1]}", "context": ctx})
    return out


def analyze_istanbul(root: str) -> tuple:
    """vitest/jest 的 istanbul coverage-final.json → (summary_files, uncovered)"""
    cand = [os.path.join(root, "coverage", "coverage-final.json")]
    path = next((p for p in cand if os.path.exists(p)), None)
    if path is None:
        raise FileNotFoundError("coverage/coverage-final.json 不存在——先跑 --run")
    data = read_json(path)
    files, uncovered = [], []
    for abspath, rec in data.items():
        rel = os.path.relpath(abspath, root)
        s, b = rec.get("s", {}), rec.get("b", {})
        smap = rec.get("statementMap", {})
        total_s = len(s)
        cov_s = sum(1 for v in s.values() if v > 0)
        total_b = sum(len(v) for v in b.values())
        cov_b = sum(1 for v in b.values() for hit in v if hit > 0)
        line_pct = round(cov_s / total_s * 100, 1) if total_s else 100.0
        branch_pct = round(cov_b / total_b * 100, 1) if total_b else 100.0
        files.append({"file": rel, "line_pct": line_pct, "branch_pct": branch_pct})
        miss_lines = sorted({smap[k]["start"]["line"] for k, v in s.items() if v == 0 and k in smap})
        if miss_lines:
            uncovered.append({"file": rel, "regions": source_context(root, rel, miss_lines)})
    return files, uncovered


def analyze_pytest(root: str) -> tuple:
    path = os.path.join(root, ".coverage-audit", "coverage.json")
    if not os.path.exists(path):
        raise FileNotFoundError(".coverage-audit/coverage.json 不存在——先跑 --run")
    data = read_json(path)
    files, uncovered = [], []
    for rel, rec in data.get("files", {}).items():
        summ = rec.get("summary", {})
        line_pct = round(summ.get("percent_covered", 0.0), 1)
        nb = summ.get("num_branches", 0)
        branch_pct = round((nb - summ.get("missing_branches", 0)) / nb * 100, 1) if nb else 100.0
        files.append({"file": rel, "line_pct": line_pct, "branch_pct": branch_pct})
        miss = rec.get("missing_lines", [])
        if miss:
            uncovered.append({"file": rel, "regions": source_context(root, rel, sorted(miss))})
    return files, uncovered


MOCK_PATTERNS = [
    ("vi.mock", re.compile(r"vi\.mock\(\s*['\"]([^'\"]+)")),
    ("jest.mock", re.compile(r"jest\.mock\(\s*['\"]([^'\"]+)")),
    ("vi.fn", re.compile(r"vi\.fn\(")),
    ("jest.fn", re.compile(r"jest\.fn\(")),
    ("vi.spyOn", re.compile(r"vi\.spyOn\(\s*([^,)]+)")),
    ("jest.spyOn", re.compile(r"jest\.spyOn\(\s*([^,)]+)")),
    ("patch", re.compile(r"(?:mock\.)?patch\(\s*['\"]([^'\"]+)")),
    ("MagicMock", re.compile(r"MagicMock\(")),
    ("monkeypatch", re.compile(r"monkeypatch\.\w+\(\s*['\"]?([^'\",)]*)")),
]
TEST_FILE_RE = re.compile(r"(\.test\.|\.spec\.|^test_.*\.py$|_test\.(py|go)$)")
SKIP_DIRS = {"node_modules", ".git", "dist", "coverage", ".venv", "__pycache__", ".coverage-audit"}


def scan_mocks(root: str) -> dict:
    sites = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if not TEST_FILE_RE.search(fn):
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), root)
            try:
                text = open(os.path.join(dirpath, fn), encoding="utf-8", errors="replace").read()
            except Exception:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                for kind, pat in MOCK_PATTERNS:
                    m = pat.search(line)
                    if m:
                        target = m.group(1).strip() if pat.groups else ""
                        sites.append({"file": rel, "line": i, "kind": kind, "target": target})
    # 按 (kind, target) 分组统计；机械预筛候选：内部模块目标或模块级 mock
    groups = {}
    for s in sites:
        key = (s["kind"], s["target"])
        g = groups.setdefault(key, {"kind": s["kind"], "target": s["target"], "count": 0, "sites": []})
        g["count"] += 1
        if len(g["sites"]) < 5:
            g["sites"].append(f"{s['file']}:{s['line']}")
    def is_candidate(g: dict) -> bool:
        t = g["target"]
        internal = t.startswith(".") or t.startswith("/") or t.startswith("src/") or "/src/" in t
        module_level = g["kind"] in ("vi.mock", "jest.mock", "patch")
        return internal or module_level
    glist = sorted(groups.values(), key=lambda g: -g["count"])
    candidates = [g for g in glist if is_candidate(g)]
    acceptable = [g for g in glist if not is_candidate(g)]
    return {
        "total": len(sites),
        "candidates": candidates,   # LLM 审计步逐条判 FLAG 的对象
        "acceptable_groups": [{"kind": g["kind"], "target": g["target"], "count": g["count"]} for g in acceptable],
        "acceptable_count": sum(g["count"] for g in acceptable),
    }


def analyze(root: str) -> dict:
    det = detect(root)
    ptype = det["project_type"]
    if ptype in ("vitest", "jest"):
        files, uncovered = analyze_istanbul(root)
    elif ptype == "pytest":
        files, uncovered = analyze_pytest(root)
    else:
        raise SystemExit(f"--analyze 暂不支持项目类型 {ptype}（vitest/jest/pytest 可用）")
    ad = audit_dir(root)
    overall_line = round(sum(f["line_pct"] for f in files) / len(files), 1) if files else 0.0
    overall_branch = round(sum(f["branch_pct"] for f in files) / len(files), 1) if files else 0.0
    write_yaml(os.path.join(ad, "coverage_summary.yaml"), {
        "total_files": len(files),
        "overall_line_pct": overall_line,
        "overall_branch_pct": overall_branch,
        "files": files,
    })
    write_yaml(os.path.join(ad, "uncovered_details.yaml"), {"files": uncovered})
    write_yaml(os.path.join(ad, "mock_patterns.yaml"), scan_mocks(root))
    return {"written": ["coverage_summary.yaml", "uncovered_details.yaml", "mock_patterns.yaml"], "tool_returncode": 0}


# ---------------------------------------------------------------- gaps


def gaps(root: str, line_thr: float, branch_thr: float) -> list:
    ad = audit_dir(root)
    with open(os.path.join(ad, "coverage_summary.yaml"), encoding="utf-8") as f:
        summary = yaml.safe_load(f)
    with open(os.path.join(ad, "uncovered_details.yaml"), encoding="utf-8") as f:
        details = yaml.safe_load(f)
    detail_map = {d["file"]: d["regions"] for d in details.get("files", [])}
    batches = []
    for rec in summary.get("files", []):
        if rec["line_pct"] >= line_thr and rec["branch_pct"] >= branch_thr:
            continue
        regions = detail_map.get(rec["file"], [])
        region_txt = "\n\n".join(f"未覆盖行 {r['lines']}:\n{r['context']}" for r in regions)
        batches.append(
            f"文件: {rec['file']}\n行覆盖率: {rec['line_pct']}%  分支覆盖率: {rec['branch_pct']}%\n"
            f"（筛选阈值: 行 <{line_thr}% 或分支 <{branch_thr}%）\n\n{region_txt or '（无未覆盖行明细）'}"
        )
    write_yaml(os.path.join(ad, "gaps.yaml"), {"threshold": {"line": line_thr, "branch": branch_thr}, "batches": batches})
    return batches


# ---------------------------------------------------------------- main


def main() -> None:
    args = sys.argv[1:]
    if len(args) < 2:
        raise SystemExit("用法: collect_coverage.py <project_root> --detect|--run|--analyze|--gaps [--line-threshold N] [--branch-threshold N]")
    root = os.path.abspath(args[0])
    cmd = args[1]
    if cmd == "--detect":
        det = detect(root)
        write_yaml(os.path.join(audit_dir(root), "detection.yaml"), det)
        print(json.dumps(det, ensure_ascii=False))
    elif cmd == "--run":
        print(json.dumps(run(root), ensure_ascii=False))
    elif cmd == "--analyze":
        print(json.dumps(analyze(root), ensure_ascii=False))
    elif cmd == "--gaps":
        def opt(name: str, default: float) -> float:
            return float(args[args.index(name) + 1]) if name in args else default
        print(json.dumps(gaps(root, opt("--line-threshold", 80.0), opt("--branch-threshold", 70.0)), ensure_ascii=False))
    else:
        raise SystemExit(f"未知子命令: {cmd}")


if __name__ == "__main__":
    main()
