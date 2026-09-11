#!/usr/bin/env python3
"""审计产物落盘（anchor-audit 4.3/6.2 的脚本化——act 步文件工具写域=work_zone only,
.anchor-audit/ 持久产物写盘被闸拒〔第十一跑实撞〕;审计产物与 scan.py 六份 YAML 同性质
=审计工具的工作产物,同 scan.py 一样由白名单脚本自主写盘,不经引擎文件工具写域闸。
用法: write_artifact.py <project_root> report <内容stdin>            → .anchor-audit/report.md
      write_artifact.py <project_root> summary <tally_json文件> <modules...>
          → semantic_audit_summary.yaml(含 audited_at/audited_commit/module_ledger 增量合并;
            scope 字段从 modules 推导:空=full,非空=排序去段名的模块清单)
退出码 0/2。"""
import sys, os, json, subprocess, datetime

def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr); return 2
    root, kind = sys.argv[1], sys.argv[2]
    aud = os.path.join(root, '.anchor-audit')
    os.makedirs(aud, exist_ok=True)
    if kind == 'report':
        content = sys.stdin.read()
        if not content.strip():
            print("report 内容为空(stdin)", file=sys.stderr); return 2
        out = os.path.join(aud, 'report.md')
        open(out, 'w').write(content)
        print(out); return 0
    if kind == 'summary':
        try:
            import yaml
        except ImportError:
            print("需要 PyYAML", file=sys.stderr); return 2
        if len(sys.argv) < 4:
            print("用法: write_artifact.py <root> summary <tally_json> <modules...>", file=sys.stderr); return 2
        tally_file = sys.argv[3]
        modules = sys.argv[4:]
        tally = json.load(open(tally_file))
        audited_at = datetime.datetime.now().astimezone().strftime('%Y-%m-%dT%H:%M%z')
        audited_commit = subprocess.run(['git', '-C', root, 'rev-parse', 'HEAD'],
                                        capture_output=True, text=True).stdout.strip()
        out = os.path.join(aud, 'semantic_audit_summary.yaml')
        ledger = {}
        if os.path.isfile(out):   # 增量合并:范围外模块条目原样保留(6.2 台账条款)
            old = yaml.safe_load(open(out)) or {}
            ledger = old.get('module_ledger', {}) or {}
        for m in (modules or tally.get('modules', {}).keys()):
            base = m.split('__part')[0]   # 拆段批归并回模块名
            ledger[base] = {'audited_commit': audited_commit, 'audited_at': audited_at}
        doc = {'audited_at': audited_at, 'audited_commit': audited_commit,
               'scope': 'full' if not modules else ' '.join(sorted({m.split('__part')[0] for m in modules})),
               'pass_rates': tally.get('pass_rates'), 'totals': tally.get('total'),
               'err_count': len(tally.get('err_items', [])), 'warn_count': len(tally.get('warn_items', [])),
               'module_ledger': ledger}
        yaml.safe_dump(doc, open(out, 'w'), allow_unicode=True, sort_keys=False)
        print(out); return 0
    print(f"未知 kind: {kind}", file=sys.stderr); return 2

sys.exit(main())
