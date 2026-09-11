#!/usr/bin/env python3
"""按模块聚合分批（anchor-audit 5.1 的脚本化——原 [act] 让 LLM 产出全部锚点清单,
395 锚点必烧穿 max_tokens(2026-09-01 第七跑实撞 output_tokens=65536 掐断);
本步是"无推理纯计算",按 spec 自身 Constraints"确定性用脚本、判断用 LLM"归位脚本。
产出 batches.json 到 .anchor-audit/(键 batches=每模块一段批文本的列表),spec 5.1 跑本脚本+读回批文本清单。
用法: python3 make_batches.py <project_root> [--modules "m1 m2 ..."] [--resume]
退出码: 0=成功, 2=运行错误(缺输入文件/模块名不匹配)。"""
import sys, yaml, os

def main():
    if len(sys.argv) < 2:
        print("用法: make_batches.py <project_root> [--modules 'm1 m2']", file=sys.stderr); return 2
    root = sys.argv[1]
    modules_filter = None
    if '--modules' in sys.argv:
        i = sys.argv.index('--modules')
        modules_filter = sys.argv[i+1].split() if i+1 < len(sys.argv) else None
    resume = '--resume' in sys.argv   # 断点续传:.anchor-audit/ 已有 batch_{mod}_results.yaml 的模块不出批(按模块名匹配——5.1 断点条款的脚本化兑现)
    aud = os.path.join(root, '.anchor-audit')
    try:
        ca = yaml.safe_load(open(os.path.join(aud, 'code_anchors.yaml')))
        ma = yaml.safe_load(open(os.path.join(aud, 'module_anchors.yaml')))
        da = yaml.safe_load(open(os.path.join(aud, 'design_anchors.yaml')))
    except FileNotFoundError as e:
        print(f"缺输入文件: {e}", file=sys.stderr); return 2
    fm_raw = ma.get('file_modules', [])
    file_modules = {e['file']: e['module'] for e in fm_raw} if isinstance(fm_raw, list) else fm_raw
    ms_raw = ma.get('module_scale', [])
    module_scale = {e.get('module', e.get('name', '?')): e for e in ms_raw} if isinstance(ms_raw, list) else ms_raw
    design_pos = {}
    for d in (da.get('anchors') or []):
        design_pos.setdefault(d['id'], []).append(f"{d['file']}:{d['line']}")
    # 锚点归模块
    per_module = {}
    for a in (ca.get('anchors') or []):
        mod = file_modules.get(a['file'])
        if not mod: continue
        per_module.setdefault(mod, []).append(a)
    if modules_filter:
        missing = [m for m in modules_filter if m not in per_module]
        if missing:
            print(f"模块名不匹配(拼错防静默空跑): {', '.join(missing)}；可用: {', '.join(sorted(per_module))}", file=sys.stderr); return 2
        per_module = {m: per_module[m] for m in modules_filter}
    if resume:
        done = {m for m in per_module if os.path.isfile(os.path.join(aud, f"batch_{m}_results.yaml"))}
        if done:
            print(f"resume 跳过已完成 {len(done)} 模块: {', '.join(sorted(done))}", file=sys.stderr)
        per_module = {m: v for m, v in per_module.items() if m not in done}
    batches = []
    SPLIT_AT = 100   # 超 100 锚点按 50 一段拆(5.1 分批协议的兑现——第十跑 hop-cli 88 锚点
    CHUNK = 50       # 单批 MAX_TOOL_ITERATIONS 20 轮读源耗尽;拆段后每段独立 LLM 轮次预算)
    for mod in sorted(per_module):
        anchors = per_module[mod]
        lines = [f"module: {mod}", f"scale: {yaml.safe_dump(module_scale.get(mod, {}), allow_unicode=True, default_flow_style=True).strip()}",
                 f"anchor_count: {len(anchors)}",
                 "隔离声明: 单批仅审本模块,不读其它模块源文件、不依赖其它批产出", "anchors:"]
        for a in anchors:
            dp = design_pos.get(a['id'], [])
            lines.append(f"- id: {a['id']}\n  code: {a['file']}:{a['line']}\n  design: {', '.join(dp) if dp else '（设计锚未定位——审计时按 D→C 缺失线索核）'}")
        if len(anchors) > SPLIT_AT:
            for ci in range(0, len(anchors), CHUNK):
                seg = anchors[ci:ci+CHUNK]
                seg_lines = [f"module: {mod}__part{ci//CHUNK+1}", lines[1], f"anchor_count: {len(seg)}",
                             f"隔离声明: 单批仅审本模块第 {ci//CHUNK+1} 段({len(seg)} 锚点),不读其它模块源文件、不依赖其它批产出", "anchors:"]
                for a in seg:
                    dp = design_pos.get(a['id'], [])
                    seg_lines.append(f"- id: {a['id']}\n  code: {a['file']}:{a['line']}\n  design: {', '.join(dp) if dp else '（设计锚未定位——审计时按 D→C 缺失线索核）'}")
                batches.append('\n'.join(seg_lines))
        else:
            batches.append('\n'.join(lines))
    import json
    out = os.path.join(aud, 'batches.json')
    json.dump({'batches': batches, 'count': len(batches)}, open(out, 'w'), ensure_ascii=False)
    print(f"batches={len(batches)} → {out}")
    return 0

sys.exit(main())
