#!/usr/bin/env python3
"""审计环境准备（anchor-audit 步 1 的脚本化——原 [act] 让 LLM 用文件工具删 .anchor-audit/
旧产物,standalone 写域闸拒〔WORK_ZONE_ONLY,该目录不在 work_zone〕,第八跑实撞 tool_failure 死。
确定性准备归脚本:路径探测+audit_mode 清理+PyYAML 自证〔本脚本 import yaml 即证〕。
用法: prep_env.py <project_root> [--concept-dir D] [--audit-mode fresh|resume]
输出: JSON 到 stdout(design_dir/src_dir/test_dir/paths_report);退出码 0/2。"""
import sys, os, json, glob

def main():
    if len(sys.argv) < 2:
        print("用法: prep_env.py <root> [--concept-dir D] [--audit-mode M]", file=sys.stderr); return 2
    root = sys.argv[1]
    def opt(name, default=None):
        return sys.argv[sys.argv.index(name)+1] if name in sys.argv and sys.argv.index(name)+1 < len(sys.argv) else default
    concept = opt('--concept-dir')
    mode = opt('--audit-mode') or 'fresh'
    try:
        import yaml  # noqa: F401 —— PyYAML 在场自证
        pyyaml = '可用'
    except ImportError:
        pyyaml = '缺失(scan.py 将失败)'
    lines = [f"【路径探测】project_root = {root}"]
    design = next((d for d in ('docs/design', 'design') if os.path.isdir(os.path.join(root, d))), None)
    if not design:
        design = 'docs/design'; lines.append("- 设计目录未找到(候选 docs/design、design 均缺)——记默认名,scan 将报错")
    else:
        lines.append(f"- 设计目录: {design}")
    src = 'src' if os.path.isdir(os.path.join(root, 'src')) else ''
    test = 'tests' if os.path.isdir(os.path.join(root, 'tests')) else ''
    lines.append(f"- src: {'存在' if src else '缺'} / tests: {'存在' if test else '缺'} / TRACEABILITY.md: {'存在' if os.path.isfile(os.path.join(root, 'TRACEABILITY.md')) else '缺'}")
    lines.append(f"- concept_dir: {concept or '未指定(S→D 维度 skip)'} / PyYAML: {pyyaml}")
    aud = os.path.join(root, '.anchor-audit')
    os.makedirs(aud, exist_ok=True)
    removed = []
    keep_batches = (mode == 'resume')
    for f in sorted(glob.glob(os.path.join(aud, '*'))):
        base = os.path.basename(f)
        if keep_batches and base.startswith('batch_') and base.endswith('_results.yaml'):
            continue
        if base == 'semantic_audit_summary.yaml':
            continue   # 台账文件恒不删——module_ledger 增量合并要读旧账(6.2 增量合并条款)
        if os.path.isfile(f):
            os.remove(f); removed.append(base)
    lines.append(f"【audit_mode={mode}】清理 {len(removed)} 项" + (f"(保留 batch_*_results 断点)" if keep_batches else "") + (f": {', '.join(removed[:8])}{'…' if len(removed) > 8 else ''}" if removed else "(无可清)"))
    print(json.dumps({'design_dir': design, 'src_dir': src or 'src', 'test_dir': test or 'tests', 'paths_report': '\n'.join(lines)}, ensure_ascii=False))
    return 0

sys.exit(main())
