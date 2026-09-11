#!/usr/bin/env python3
"""anchor-scan 阶段三：15 项交叉比对集合运算（原名 13 项——12 基础 + 概念→设计 + 模块边界 + 出口注释，两次增补后计数失更；2026-08-08 修账并去重编号）。

读取 scan.py 输出的 6 份 YAML（概念/设计/代码/测试/追溯/模块），执行 15 项集合运算
（含概念→设计、模块三维校验），透传模块规模统计，
输出结构化比对结果供 LLM synthesis agent 撰写报告。

依赖: pyyaml (uv pip install pyyaml)

用法:
  python3 cross_compare.py <project_root>

输出: {project_root}/.anchor-audit/cross_compare_results.yaml
"""

import argparse
import os
import sys

try:
    import yaml
except ImportError:
    print("需要 PyYAML: uv pip install pyyaml", file=sys.stderr)
    sys.exit(2)


def load(path):
    with open(path, encoding='utf-8') as f:
        return yaml.safe_load(f) or {}


def dump(data, path):
    with open(path, 'w', encoding='utf-8') as f:
        yaml.dump(data, f, allow_unicode=True, default_flow_style=False, sort_keys=False)


def run_comparisons(project_root):
    audit_dir = os.path.join(project_root, '.anchor-audit')

    concept_data = load(os.path.join(audit_dir, 'concept_anchors.yaml'))
    design_data = load(os.path.join(audit_dir, 'design_anchors.yaml'))
    code_data = load(os.path.join(audit_dir, 'code_anchors.yaml'))
    test_data = load(os.path.join(audit_dir, 'test_anchors.yaml'))
    trace_data = load(os.path.join(audit_dir, 'traceability_cards.yaml'))
    module_data = load(os.path.join(audit_dir, 'module_anchors.yaml'))

    concept_anchors = concept_data.get('anchors', [])
    design_anchors = design_data.get('anchors', [])
    code_anchors = code_data.get('anchors', [])
    test_anchors = test_data.get('anchors', [])
    trace_cards = trace_data.get('cards', [])
    invalid_refs = trace_data.get('invalid_refs', [])
    design_violations = design_data.get('naming_violations', [])
    code_violations = code_data.get('naming_violations', [])
    test_violations = test_data.get('naming_violations', [])

    concept_ids = {a['id'] for a in concept_anchors}
    design_ids = {a['id'] for a in design_anchors}
    design_non_group = {a['id'] for a in design_anchors if not a.get('is_group_title', False)}
    code_ids = {a['id'] for a in code_anchors}
    test_ids = {a['id'] for a in test_anchors}
    trace_ids = {c['id'] for c in trace_cards}

    concept_loc = {a['id']: f"{a.get('file','')}:{a.get('line','')}" for a in concept_anchors}
    design_loc = {a['id']: f"{a.get('file','')}:{a.get('line','')}" for a in design_anchors}
    code_loc = {a['id']: f"{a.get('file','')}:{a.get('line','')}" for a in code_anchors}
    test_loc = {a['id']: f"{a.get('file','')}:{a.get('line','')}" for a in test_anchors}

    results = {}

    # 1. 设计→代码
    d2c_missing = sorted(design_non_group - code_ids)
    results['design_to_code'] = {
        'total': len(design_non_group),
        'covered': len(design_non_group) - len(d2c_missing),
        'missing': [{'id': a, 'location': design_loc.get(a, '')} for a in d2c_missing],
    }

    # 2. 代码→测试
    c2t_missing = sorted(code_ids - test_ids)
    results['code_to_test'] = {
        'total': len(code_ids),
        'covered': len(code_ids) - len(c2t_missing),
        'missing': [{'id': a, 'location': code_loc.get(a, '')} for a in c2t_missing],
    }

    # 3. 测试→代码（悬空 @v:）
    t2c_orphans = sorted(test_ids - code_ids)
    results['test_to_code'] = {
        'total': len(test_ids),
        'orphans': [{'id': a, 'location': test_loc.get(a, '')} for a in t2c_orphans],
    }

    # 4. 追溯完整性
    c2tr_missing = sorted(code_ids - trace_ids)
    results['code_to_traceability'] = {
        'total': len(code_ids),
        'covered': len(code_ids & trace_ids),
        'missing': [{'id': a, 'location': code_loc.get(a, '')} for a in c2tr_missing],
    }

    # 5. 状态正确性
    status_issues = []
    file_modules = module_data.get('file_modules', [])
    # anc-struct-* 模块锚点的落点通道是 @module:（文件头标注），不是 @a:/@v:——
    # 状态判定按 concept-anchor-rules「@module 通道」（2026-08-03）：src 侧有 @module=有代码落点，
    # tests 侧有=有测试落点。
    struct_code_ids = {f['anchor'] for f in file_modules if f['file'].startswith('src/')}
    struct_test_ids = {f['anchor'] for f in file_modules if f['file'].startswith('tests/')}

    for card in trace_cards:
        aid = card['id']
        st = card.get('status', '')
        in_code = aid in code_ids or aid in struct_code_ids
        in_test = aid in test_ids or aid in struct_test_ids
        in_design = aid in design_ids

        # 落点声明豁免（concept-anchor-rules「状态标记」2026-08-03）：标题括注声明落点
        # 不在 src/tests（伞锚点/driver 载体/文档程契约）→ 跳过三层齐全校验，真实性归语义审计。
        if card.get('placement_exempt'):
            continue
        if '✅' in st:
            broken = []
            if not in_code: broken.append('无代码锚点')
            if not in_test: broken.append('无测试锚点')
            if not in_design: broken.append('无设计锚点')
            if broken:
                status_issues.append({'id': aid, 'status': st, 'issue': 'status_error',
                                      'detail': f"标 ✅ 但 {', '.join(broken)}"})
        elif '⚠' in st:
            if in_code and in_test and in_design:
                status_issues.append({'id': aid, 'status': st, 'issue': 'upgradeable',
                                      'detail': '链路完整，可升级为 ✅'})
    results['status_check'] = status_issues

    # 6. 无效引用（文件不存在 或 文件内无本锚点 id；不再比对行号——行号是必然腐坏的快照）
    results['invalid_refs'] = invalid_refs or []

    # 6b. 反向核（2026-08-30 todo/0034——"卡→文件"单向之外补"代码落点→卡"半边:
    # 每个代码/测试锚点 (id, file) 应有某卡结构化行 (owner=id, file=同文件)；缺席=卡滞后,
    # 原单向核恒绿悄悄漏账。豁免面=文件级覆盖(同锚同文件多块只需一行,不逐块)。
    # 设计条款 anchor-audit-knowledge.md 6b。
    cards = trace_data.get('cards', [])
    covered_code = set()   # (owner, file) 已入卡集合
    covered_test = set()
    for card in cards:
        for ref in card.get('code_refs', []):
            covered_code.add((ref.get('owner'), ref.get('file')))
        for ref in card.get('test_refs', []):
            covered_test.add((ref.get('owner'), ref.get('file')))
    missing_code_refs = []
    seen_pairs = set()
    for a in code_anchors:
        pair = (a['id'], a.get('file'))
        if pair in seen_pairs:
            continue   # 文件级豁免:同锚同文件多块只报一次
        seen_pairs.add(pair)
        if pair not in covered_code:
            missing_code_refs.append({'id': a['id'], 'file': a.get('file'), 'line': a.get('line')})
    missing_test_refs = []
    seen_pairs = set()
    for a in test_anchors:
        pair = (a['id'], a.get('file'))
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        if pair not in covered_test:
            missing_test_refs.append({'id': a['id'], 'file': a.get('file'), 'line': a.get('line')})
    results['card_missing_code_refs'] = missing_code_refs
    results['card_missing_test_refs'] = missing_test_refs

    # 7. 命名违规
    all_violations = []
    for layer, vlist in [('design', design_violations), ('code', code_violations), ('test', test_violations)]:
        for v in (vlist or []):
            all_violations.append({**v, 'layer': layer})
    results['naming_violations'] = all_violations

    # 8. 代码→设计（孤儿 @a:）
    c2d_orphans = sorted(code_ids - design_ids)
    results['code_to_design'] = {
        'total': len(code_ids),
        'orphans': [{'id': a, 'location': code_loc.get(a, '')} for a in c2d_orphans],
    }

    # 9. 设计→追溯
    d2tr_missing = sorted(design_non_group - trace_ids)
    results['design_to_traceability'] = {
        'total': len(design_non_group),
        'missing': [{'id': a, 'location': design_loc.get(a, '')} for a in d2tr_missing],
    }

    # --- @module 三维校验（文件级横向归属，见 SKILL.md 模块归属标注）---
    unassigned = module_data.get('unassigned', [])
    integration_deps = module_data.get('integration_deps', [])
    module_anchors_known = set(module_data.get('module_anchors_known', []))

    # 10. 模块归属完整性：无 @module/@module-deps 的文件
    results['module_unassigned'] = {
        'total_files': len(file_modules) + len(unassigned) + len(integration_deps),
        'unassigned': unassigned,
    }

    # 11. 模块锚点真实性：@module 指向的定位锚点 ∖ 设计锚点 = 悬空
    # 模块身份锚点的权威可在设计层或概念层（如 anc-meta-traceability 定义于工程实现链规范）
    module_anchor_orphans = sorted(module_anchors_known - design_ids - concept_ids)
    # 关联具体文件，便于定位
    orphan_files = [{'anchor': fm['anchor'], 'file': fm['file'], 'module': fm['module']}
                    for fm in file_modules if fm['anchor'] in module_anchor_orphans]
    results['module_anchor_orphans'] = {
        'total': len(module_anchors_known),
        'orphans': orphan_files,
    }

    # 12. 集成依赖一致性：@module-deps 声明集 △ import 推导模块集
    dep_mismatches = []
    for it in integration_deps:
        declared = set(it.get('declared', []))
        imported = set(it.get('imported_modules', []))
        if declared != imported:
            dep_mismatches.append({
                'file': it['file'],
                'declared': sorted(declared),
                'imported': sorted(imported),
                'declared_only': sorted(declared - imported),   # 声明了但没 import（多报）
                'imported_only': sorted(imported - declared),   # import 了但没声明（漏报）
            })
    results['module_deps_mismatch'] = dep_mismatches

    # 13. 概念→设计：概念锚点 ∖ 设计锚点 = 设计未覆盖概念（S→D 结构侧；语义侧由 LLM 审计）
    #     概念层为空（未指定概念目录）则该项 skip——不报"全部未覆盖"假阳性。
    if concept_ids:
        c2d_missing = sorted(concept_ids - design_ids)
        results['concept_to_design'] = {
            'total': len(concept_ids),
            'covered': len(concept_ids & design_ids),
            'missing': [{'id': a, 'location': concept_loc.get(a, '')} for a in c2d_missing],
        }
    else:
        results['concept_to_design'] = {'total': 0, 'skipped': '未指定概念层目录，概念→设计比对 skip'}

    # 模块规模透传（确定性统计，供报告标注模块体量；不参与集合运算）
    results['module_scale'] = module_data.get('module_scale', [])

    # 14. 模块边界接口校验（增量式：仅对已声明 ⑤ 对外接口清单的模块生效）
    #  ① 深入非出口文件：import 目标 stem ∉ 目标模块出口文件集
    #  ② import 表外符号：import 的符号 ∉ 目标模块公开清单
    # 未声明清单的模块跳过（manifest 缺失即不检，符合"一个一个来"增量推进）。
    boundary_data = load(os.path.join(audit_dir, 'module_boundaries.yaml'))
    manifests = boundary_data.get('manifests', {})   # anc-struct-X → {symbols, exit_stems}
    cross_imports = boundary_data.get('cross_imports', [])
    boundary_violations = []
    for ci in cross_imports:
        anchor = ci.get('target_anchor')
        man = manifests.get(anchor)
        if not man:
            continue  # 目标模块未声明清单 → 增量式跳过
        exit_stems = set(man.get('exit_stems', []))
        symbols = set(man.get('symbols', []))
        # ① 深入非出口文件
        if ci['target_stem'] not in exit_stems:
            boundary_violations.append({
                'kind': 'non_exit_file', 'file': ci['file'],
                'from_module': ci['from_module'], 'target_module': ci['target_module'],
                'target_stem': ci['target_stem'], 'symbols': ci['symbols'],
                'detail': f"从非出口文件 {ci['target_stem']}.ts 深入 import（出口={sorted(exit_stems)}）",
            })
            continue  # 文件都非法，符号不再单独报
        # ② import 表外符号
        off_list = [s for s in ci['symbols'] if s not in symbols]
        if off_list:
            boundary_violations.append({
                'kind': 'symbol_not_public', 'file': ci['file'],
                'from_module': ci['from_module'], 'target_module': ci['target_module'],
                'target_stem': ci['target_stem'], 'symbols': off_list,
                'detail': f"import 了 {ci['target_module']} 清单外的符号 {off_list}",
            })
    results['module_boundary_violations'] = {
        'manifests_declared': len(manifests),
        'cross_imports_checked': sum(1 for ci in cross_imports if ci.get('target_anchor') in manifests),
        'violations': boundary_violations,
    }

    # 15. 出口注释完整性校验（增量式：仅出口文件的顶层 export）
    #  出口文件 export 符号紧邻上方无说明注释 = export_missing_comment
    export_comments = boundary_data.get('export_comments', [])
    export_comment_violations = [
        {'kind': 'export_missing_comment', 'file': ec['file'],
         'symbol': ec['symbol'], 'line': ec['line'],
         'detail': f"出口符号 {ec['symbol']}（{ec['file']}:{ec['line']}）上方无说明注释"}
        for ec in export_comments if not ec.get('has_comment')
    ]
    results['export_comment_violations'] = {
        'exports_checked': len(export_comments),
        'violations': export_comment_violations,
    }

    # Summary
    results['summary'] = {
        'concept_anchors': len(concept_ids),
        'design_anchors': len(design_ids),
        'design_non_group': len(design_non_group),
        'code_anchors': len(code_ids),
        'test_anchors': len(test_ids),
        'trace_cards': len(trace_ids),
        'concept_to_design_coverage': (f"{len(concept_ids & design_ids)}/{len(concept_ids)}"
                                       if concept_ids else 'skip（无概念层）'),
        'design_to_code_coverage': f"{len(design_non_group & code_ids)}/{len(design_non_group)}",
        'code_to_test_coverage': f"{len(code_ids & test_ids)}/{len(code_ids)}",
        'code_to_trace_coverage': f"{len(code_ids & trace_ids)}/{len(code_ids)}",
        'naming_violations': len(all_violations),
        'invalid_refs': len(results['invalid_refs']),
        'card_missing_code_refs': len(results['card_missing_code_refs']),
        'card_missing_test_refs': len(results['card_missing_test_refs']),
        'status_issues': len(status_issues),
        'module_unassigned': len(unassigned),
        'module_anchor_orphans': len(orphan_files),
        'module_deps_mismatch': len(dep_mismatches),
        'modules': len(results['module_scale']),
        'module_boundary_violations': len(boundary_violations),
        'export_comment_violations': len(export_comment_violations),
    }

    return results


def main():
    parser = argparse.ArgumentParser(description='anchor-scan 阶段三：15 项交叉比对')
    parser.add_argument('project_root', help='项目根目录')
    args = parser.parse_args()

    project_root = os.path.abspath(args.project_root)
    audit_dir = os.path.join(project_root, '.anchor-audit')

    for fname in ('concept_anchors.yaml', 'design_anchors.yaml', 'code_anchors.yaml',
                   'test_anchors.yaml', 'traceability_cards.yaml', 'module_anchors.yaml'):
        fpath = os.path.join(audit_dir, fname)
        if not os.path.exists(fpath) or os.path.getsize(fpath) == 0:
            print(f"错误: 缺少或为空: {fname}", file=sys.stderr)
            sys.exit(2)

    results = run_comparisons(project_root)
    outpath = os.path.join(audit_dir, 'cross_compare_results.yaml')
    dump(results, outpath)

    s = results['summary']
    print(f"交叉比对完成:")
    print(f"  概念→设计覆盖: {s['concept_to_design_coverage']}")
    print(f"  设计→代码覆盖: {s['design_to_code_coverage']}")
    print(f"  代码→测试覆盖: {s['code_to_test_coverage']}")
    print(f"  代码→追溯覆盖: {s['code_to_trace_coverage']}")
    print(f"  命名违规: {s['naming_violations']}")
    print(f"  无效引用: {s['invalid_refs']}")
    print(f"  状态问题: {s['status_issues']}")
    print(f"  模块漏标: {s['module_unassigned']}  悬空模块锚点: {s['module_anchor_orphans']}  集成依赖不一致: {s['module_deps_mismatch']}")
    print(f"  模块数: {s['modules']}")
    print(f"  模块边界违规: {s['module_boundary_violations']}  出口注释违规: {s['export_comment_violations']}")
    print(f"\n输出: {outpath}")


if __name__ == '__main__':
    main()
