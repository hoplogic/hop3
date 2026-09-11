#!/usr/bin/env python3
"""语义审计汇总统计（anchor-audit 6.1 的脚本化——原 [act] 让 LLM 读全部批次文件做三维计数
+抄录明细,10 份批次的 ⚠️ 明细抄录烧穿 max_tokens〔第十跑实撞 output_tokens=65536〕;
本步自称'确定性——读盘逐文件计数,零新判断',Constraints 脚本侧归位。
用法: tally_batches.py <batch_file1> [batch_file2 ...]   （文件路径列表——支持任意落点,
      路径以调用方给的实际清单为准;现行落点 .anchor-audit/,经 write_batch.py 写盘）
输出: JSON 到 stdout——三维通过率表+模块规模表+err 清单全文+warn 明细全文（体量与缺陷数同阶）。
退出码: 0=成功, 2=输入缺失/解析失败。"""
import sys, json

def main():
    files = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not files:
        print("用法: tally_batches.py <batch_file...>", file=sys.stderr); return 2
    try:
        import yaml
    except ImportError:
        print("需要 PyYAML: uv run --with pyyaml", file=sys.stderr); return 2
    dims = ['s2d', 'd2c', 'c2t']
    per_module = {}
    errs, warns = [], []
    for fp in files:
        try:
            raw = open(fp).read()
            # 围栏剥壳容忍(第十跑实撞:一份批文件带 ```yaml 围栏——LLM 写盘时带壳,与引擎解析层
            # 同哲学:内容完好提取层不判死)
            lines = raw.strip().split(chr(10))
            if lines and lines[0].lstrip().startswith('```'):
                lines = lines[1:]
            if lines and lines[-1].strip() == '```':   # 尾行孤儿围栏(第十跑 step-dispatcher 批实撞:开栏缺席只留闭栏)
                lines = lines[:-1]
            # 通体公共缩进剥(同批实撞:整文件带两空格前导——LLM 把 yaml 当嵌套块写)
            nonblank = [l for l in lines if l.strip()]
            if nonblank:
                import re as _re
                common = min(len(_re.match(r' *', l).group(0)) for l in nonblank)
                if common > 0:
                    lines = [l[common:] if len(l) >= common else l for l in lines]
            raw = chr(10).join(lines)
            doc = yaml.safe_load(raw)
        except Exception:
            # 降级解析(第十三跑实撞:flow mapping 的 note 裸值含 [on fail] 方括号,YAML flow
            # 语法炸——LLM 写盘形态噪声第三例。逐行正则抽 anchor_id/verdict/note,
            # 内容完好提取层不判死;抽不出的行如实跳过)
            import re as _re
            doc = {'module': '?', 'results': []}
            cur = None
            m_mod = _re.search(r'^\s*module:\s*(\S+)', raw, _re.M)
            if m_mod: doc['module'] = m_mod.group(1)
            for ln in raw.split(chr(10)):
                m_a = _re.match(r'\s*-\s*anchor_id:\s*(\S+)', ln)
                if m_a:
                    cur = {'anchor_id': m_a.group(1)}; doc['results'].append(cur); continue
                m_d = _re.match(r'\s*(s2d|d2c|c2t):\s*\{\s*verdict:\s*"?([^,"]+)"?\s*,\s*note:\s*"?(.*?)"?\s*\}\s*$', ln)
                if m_d and cur is not None:
                    cur[m_d.group(1)] = {'verdict': m_d.group(2).strip(), 'note': m_d.group(3)}
            if not doc['results']:
                print(f"解析失败(降级也无果) {fp}", file=sys.stderr); return 2
        if not isinstance(doc, dict):
            print(f"形态异常(非映射) {fp}", file=sys.stderr); return 2
        mod = doc.get('module', '?')
        scale = doc.get('scale', {})
        stat = {d: {'ok': 0, 'warn': 0, 'err': 0, 'skip': 0} for d in dims}
        for a in (doc.get('anchors') or doc.get('results') or []):
            aid = a.get('anchor_id') or a.get('id') or '?'   # 批文件实际键=anchor_id(知识文档批结果格式);兼收 id 防两形态并存(第九轮 review 实撞:只读 id 致 245 条明细锚点名全 '?')
            for d in dims:
                cell = a.get(d) or {}
                v = str(cell.get('verdict', 'skip')).lower()
                note = cell.get('note', '')
                if v in ('✅', 'ok', 'pass'): stat[d]['ok'] += 1   # ⚠ 变体(无 FE0F)已入 warn 词表——emoji 选择符缺席是常见输入形态
                elif v in ('⚠️', '⚠', 'warn', 'warning'):
                    stat[d]['warn'] += 1
                    warns.append({'module': mod, 'anchor': aid, 'dim': d, 'note': note})
                elif v in ('❌', 'err', 'error', 'fail'):
                    stat[d]['err'] += 1
                    errs.append({'module': mod, 'anchor': aid, 'dim': d, 'note': note})
                else: stat[d]['skip'] += 1
        per_module[mod] = {'scale': scale, 'stat': stat, 'file': fp}
    total = {d: {k: sum(m['stat'][d][k] for m in per_module.values()) for k in ('ok','warn','err','skip')} for d in dims}
    rates = {}
    for d in dims:
        den = total[d]['ok'] + total[d]['warn'] + total[d]['err']
        rates[d] = round(total[d]['ok'] / den, 4) if den else None
    print(json.dumps({'modules': per_module, 'total': total, 'pass_rates': rates,
                      'err_items': errs, 'warn_items': warns,
                      'batch_count': len(files)}, ensure_ascii=False))
    return 0

sys.exit(main())
