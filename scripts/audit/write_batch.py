#!/usr/bin/env python3
"""批结果写盘+写前校验（anchor-audit 5.2.1.2 的脚本化——2026-09-01 作者令'赶快做掉':
批结果 YAML 坏形态原本静默落盘,几步外 6.1 读盘才炸,病灶离症状隔容器;写前 parse 把关
让打回发生在产批当轮〔rc=2 → act 步失败 → subtask retry 带反馈重产〕。
容忍与校验分工:围栏壳/通体缩进两形态视为可修复噪声——剥后能 parse 即修复后写盘(修复了什么
写 stdout 供 digest 记录);剥后仍炸=真坏,rc=2 报行号与错因,LLM 拿着报错重产。
用法: write_batch.py <输出文件绝对或相对路径> < 批结果文本(stdin)
输出: 成功=写盘路径+锚点计数+修复记录;失败=rc 2+错因。"""
import sys, os

def main():
    if len(sys.argv) < 2:
        print("用法: write_batch.py <输出路径> < 内容stdin", file=sys.stderr); return 2
    out_path = sys.argv[1]
    raw = sys.stdin.read()
    if not raw.strip():
        print("内容为空", file=sys.stderr); return 2
    try:
        import yaml
    except ImportError:
        print("需要 PyYAML", file=sys.stderr); return 2
    fixed = []
    lines = raw.strip().split('\n')
    if lines and lines[0].lstrip().startswith('```'):
        lines = lines[1:]; fixed.append('剥首行围栏')
    if lines and lines[-1].strip() == '```':
        lines = lines[:-1]; fixed.append('剥尾行孤儿围栏')
    nonblank = [l for l in lines if l.strip()]
    if nonblank:
        import re
        common = min(len(re.match(r' *', l).group(0)) for l in nonblank)
        if common > 0:
            lines = [l[common:] if len(l) >= common else l for l in lines]
            fixed.append(f'剥通体缩进{common}格')
    text = '\n'.join(lines)
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as e:
        mark = getattr(e, 'problem_mark', None)
        loc = f"第 {mark.line+1} 行第 {mark.column+1} 列" if mark else "位置未知"
        print(f"YAML 解析失败({loc}): {getattr(e, 'problem', e)}——常见病:flow 形态 {{...}} 里 note 裸值含 [ , : 等符号;修法=note 值加双引号或改块风格 note: |", file=sys.stderr)
        return 2
    if not isinstance(doc, dict) or not (doc.get('results') or doc.get('anchors')):
        print("形态不合契约:顶层须为映射且含 results(或 anchors)列表——批头 module/scale + results 逐锚点", file=sys.stderr); return 2
    n = len(doc.get('results') or doc.get('anchors'))
    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
    open(out_path, 'w').write(text)
    print(f"{out_path} anchors={n}" + (f" 修复:{'+'.join(fixed)}" if fixed else ""))
    return 0

sys.exit(main())
