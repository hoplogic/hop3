// @module: hoplog ^anc-obs-hoplog
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HopLog, extractHopLogStepKeys, sanitize, toYaml } from '../src/hoplog.js';
import { load as yamlLoad } from 'js-yaml';
import { ExecutionEngine } from '../src/engine.js';
import type { HostConfig } from '../src/provider-types.js';
import { load as yamlLoad } from 'js-yaml';

const MINIMAL_HOST_CONFIG: HostConfig = {
  workspace_dir: '/tmp/test',
  sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
  api_key: 'test-key',
};

const TWO_STEP_SPEC = `# Log Test
Id: log-test

## Goal
Test hoplog output

## Inputs
- data: text  # input

## Outputs
- result: text  # final

## Steps
1. [reason] Analyze
  - ← data
  + → mid: text  # intermediate
  > Analyze

2. [act] Transform
  - ← mid
  + → result: text  # output
  > Transform
`;

// @v: anc-obs-nested-tree
describe('extractHopLogStepKeys', () => {
  it('只提取 execution 下符合深度缩进的真实块键，保留 loop 轮次', () => {
    const text = [
      'spec_id: t',
      'execution:',
      '  "1":',
      '    outputs:',
      '      "2": fake-body-key',
      '    "1.1":',
      '      status: completed',
      '    "1.1#2":',
      '      status: completed',
      '  "10":',
      '    status: completed',
      'status: completed',
    ].join('\n');
    expect(extractHopLogStepKeys(text)).toEqual(['1', '1.1', '1.1#2', '10']);
  });

  it('没有 execution 段时返回空集', () => {
    expect(extractHopLogStepKeys('spec_id: t\n  "1":\n')).toEqual([]);
  });
});

// 提取 main.yaml 中某步骤的记录（YAMLL：一个 step 的 start/meta/done 各自成块、块头同为该 id）。
// 聚合该 stepId 的**所有块**的 body 拼接返回——测试断言"某字段存在"沿用不变。
// 块 = 块头 `<2d>"id":` 或 `<2d>id:` 行 + 其后更深缩进(> 块头缩进)的 body，直到下一个 ≤ 块头缩进的行。
function stepBlock(yaml: string, stepId: string): string {
  const lines = yaml.split('\n');
  const headRe = new RegExp(`^( *)(?:${JSON.stringify(stepId)}|${stepId.replace(/[.]/g, '\\.')})(?:#\\d+)?:\\s*$`);
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headRe);
    if (!m) continue;
    const headIndent = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      const ind = lines[j].length - lines[j].trimStart().length;
      if (ind <= headIndent) break;       // 块结束
      bodies.push(lines[j]);
    }
  }
  return bodies.join('\n') + (bodies.length ? '\n' : '');
}

// YAMLL 合法性校验：header（execution: 前）整体合法 + execution 后按块切分逐块合法。
// 块间允许重复 step-id 块头（YAMLL 不是单一 YAML 树）。返回错误列表，空 = 合法。
function yamllErrors(txt: string): string[] {
  const errs: string[] = [];
  const lines = txt.split('\n');
  const execIdx = lines.findIndex(l => l === 'execution:');
  if (execIdx < 0) { errs.push('无 execution:'); return errs; }
  try { yamlLoad(lines.slice(0, execIdx + 1).join('\n')); }
  catch (e) { errs.push('header 非法: ' + ((e as Error).message)); }
  const isHead = (l: string) => /^ *(?:"[\d.]+(?:#\d+)?"|[\d.]+(?:#\d+)?):\s*$/.test(l);
  const isTop = (l: string) => /^(status|ended_at|replan_audit|resumed_at):/.test(l);
  let cur: string[] = [];
  const flush = (blk: string[]) => {
    const body = blk.filter(l => l.trim() !== '');
    if (!body.length) return;
    const minI = Math.min(...body.map(l => l.length - l.trimStart().length));
    try { yamlLoad(body.map(l => l.slice(minI)).join('\n')); }
    catch (e) { errs.push(`块非法 [${body[0].trim()}]: ${(e as Error).message}`); }
  };
  for (let i = execIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { cur.push(l); continue; }
    if (isHead(l) || isTop(l)) { flush(cur); cur = [l]; } else cur.push(l);
  }
  flush(cur);
  return errs;
}
/** YAMLL 全合法断言（供测试替代旧的 yamlLoad(全文)）。 */
function expectYamllValid(txt: string): void {
  const errs = yamllErrors(txt);
  expect(errs, errs.join(' | ')).toEqual([]);
}

// @v: anc-obs-log-levels, anc-obs-step-mapping, anc-obs-hoplog
describe('hoplog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hoplog-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('sanitize', () => {
    it('masks API keys', () => {
      expect(sanitize('token: sk-abcdefghijklmnopqrstuvwxyz12345')).toBe('token: sk-***');
      expect(sanitize('my key-ABCDEFGHIJKLMNOPQRSTUVWXYZ is secret')).toBe('my key-*** is secret');
    });

    it('does not mask short keys', () => {
      expect(sanitize('sk-short')).toBe('sk-short');
    });

    it('truncates long strings', () => {
      const long = 'a'.repeat(300);
      const result = sanitize(long);
      expect(result.length).toBeLessThan(300);
      expect(result).toContain('[TRUNCATED]');
    });

    it('leaves short strings untouched', () => {
      expect(sanitize('hello world')).toBe('hello world');
    });
  });

  describe('toYaml', () => {
    it('serializes scalars', () => {
      expect(toYaml(null)).toBe('null');
      expect(toYaml(42)).toBe('42');
      expect(toYaml(true)).toBe('true');
      expect(toYaml('hello')).toBe('hello');
    });

    it('quotes strings with special chars', () => {
      expect(toYaml('value: with colon')).toBe('"value: with colon"');
      expect(toYaml('')).toBe('""');
    });

    it('uses block style for multiline strings', () => {
      const result = toYaml('line1\nline2');
      expect(result).toContain('|');
      expect(result).toContain('line1');
      expect(result).toContain('line2');
    });

    it('serializes objects', () => {
      const result = toYaml({ name: 'test', count: 3 });
      expect(result).toContain('name: test');
      expect(result).toContain('count: 3');
    });

    it('serializes nested objects', () => {
      const result = toYaml({ spec: { title: 'T', goal: 'G' } });
      expect(result).toContain('spec:');
      expect(result).toContain('  title: T');
      expect(result).toContain('  goal: G');
    });

    it('serializes arrays', () => {
      const result = toYaml(['a', 'b']);
      expect(result).toContain('- a');
      expect(result).toContain('- b');
    });

    it('omits undefined values', () => {
      const result = toYaml({ a: 1, b: undefined, c: 3 });
      expect(result).toContain('a: 1');
      expect(result).not.toContain('b');
      expect(result).toContain('c: 3');
    });

    // #41 块标量安全条件（^anc-obs-hoplog-flush 条款2）：首个内容行自带前导空白的多行串
    // 回退 JSON 单行——无指示符 | 的缩进基线被首行抬高,后续较浅行提前终止块标量误读成
    // 错层 key（dr16-6 r7 实锤:child_fragment 值以缩进 spec 片段开头,tier: 行炸档）
    it('#41 反例：首行带前导空白的多行串 → 回退 JSON 单行,嵌进 mapping 后 yamlLoad 忠实回读', () => {
      // 忠实复现 dr16 形态:值首行 4 空格缩进（spec 步骤片段）,后随非缩进行
      const frag = '    1. [act free] 写模板文件\n      - ← aggregator_spec\ntier-note: mixed';
      const val = toYaml(frag, 5);
      expect(val.startsWith('|')).toBe(false);   // 不走块标量
      // 按 recordStepMeta 同款拼接形态嵌进深缩进 mapping,整体须是合法 YAML 且值无损
      const doc = `steps:\n  "3.3.1#2":\n    response:\n      child_fragment: ${val}\n      child_tier: mixed\n`;
      const parsed = yamlLoad(doc) as { steps: Record<string, { response: { child_fragment: string; child_tier: string } }> };
      expect(parsed.steps['3.3.1#2'].response.child_fragment).toBe(frag);   // 逐字忠实
      expect(parsed.steps['3.3.1#2'].response.child_tier).toBe('mixed');    // 后随 key 不被吞
    });

    it('#41 反例二修：首内容行之前有非零长纯空白行 → 回退 JSON（YAML leading empty lines 约束）', () => {
      const s1 = '   \nabc\nx';   // 首行=3空格纯空白,发出后比基线深,块标量必炸
      const v1 = toYaml(s1, 3);
      expect(v1.startsWith('|')).toBe(false);
      const d1 = yamlLoad(`k:\n      inner: ${v1}\n      next: ok\n`) as { k: { inner: string; next: string } };
      expect(d1.k.inner).toBe(s1);
      expect(d1.k.next).toBe('ok');
      // 全空白多行串同回退
      const s2 = '  \n  ';
      expect(toYaml(s2, 3).startsWith('|')).toBe(false);
      expect(yamlLoad(`w: ${toYaml(s2, 0)}\n`)).toEqual({ w: s2 });
      // 真空行开头（零长度''）不回退——发出后恰等于基线,合法
      const s3 = '\nabc';
      expect(toYaml(s3, 3).startsWith('|')).toBe(true);
    });

    it('#41 正例：首行无前导空白的多行串照走块标量（后续行缩进更深合法,可读性不受损）', () => {
      const text = '第一行结论\n    - 缩进子条目\n第三行';
      const val = toYaml(text, 2);
      expect(val.startsWith('|')).toBe(true);   // 正常多行仍块标量
      const doc = `meta:\n  note: ${val}\n  next: ok\n`;
      const parsed = yamlLoad(doc) as { meta: { note: string; next: string } };
      expect(parsed.meta.note.trimEnd()).toBe(text);
      expect(parsed.meta.next).toBe('ok');
    });
  });

  describe('HopLog class', () => {
    // 反例半边（^anc-obs-step-done-timing 掩码祖先豁免的对照面,todo/0022）:真孤儿(非掩码
    // 祖先的未 start done)守卫语义不变仍标记——豁免只豁 worker 掩码祖先。// @v: anc-obs-step-done-timing
    it('writes ERROR marker for orphan writes (step never started)', () => {
      const log = new HopLog({
        specId: 'orphan-test',
        logDir: tmpDir,
        title: 'T',
        goal: 'G',
      });
      log.recordStepDone('99', { out: 'value' });
      log.close('completed');

      const yaml = readFileSync(log.getFilePath(), 'utf-8');
      expect(yaml).toContain('# ERROR: orphan recordStepDone("99")');
      // 孤儿写入的字段不应出现
      expect(yaml).not.toContain('out:');
    });

    it('creates run directory on construction', () => {
      const log = new HopLog({
        specId: 'test-spec',
        logDir: tmpDir,
        title: 'Test',
        goal: 'Testing',
      });
      expect(existsSync(log.getRunDir())).toBe(true);
    });

    // @v: anc-obs-file-layout
    it('generates correct run directory name', () => {
      const log = new HopLog({
        specId: 'my-spec',
        logDir: tmpDir,
        title: 'T',
        goal: 'G',
      });
      const dirName = log.getRunDir().split('/').pop()!;
      expect(dirName).toMatch(/^my-spec-\d{8}T\d{6}-[0-9a-f]{4}$/);
    });

    it('writes main.yaml on close', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        title: 'Title',
        goal: 'Goal',
      });
      log.close('completed');
      expect(existsSync(join(log.getRunDir(), 'main.yaml'))).toBe(true);
    });

    // @v: anc-obs-timestamp
    it('writes started_at in local-timezone millisecond-precision format', () => {
      const log = new HopLog({
        specId: 'ts-spec',
        logDir: tmpDir,
        title: 'T',
        goal: 'G',
      });
      log.close('completed');
      const yaml = readFileSync(log.getFilePath(), 'utf-8');
      // 毫秒段 .mmm 三位（2026-07-09 升级），见 ^anc-obs-timestamp
      const m = yaml.match(/started_at: "?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2})"?/);
      expect(m).not.toBeNull();
    });

    it('records step lifecycle', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        level: 'debug',
        title: 'T',
        goal: 'G',
        inputs: { x: 'hello' },
      });

      log.recordStepStart('1', 'reason', 'Step one', { x: 'hello' });
      log.recordStepDone('1', { y: 'world' });
      log.close('completed');

      const yaml = readFileSync(log.getFilePath(), 'utf-8');
      expect(yaml).toContain('  "1":');
      expect(yaml).toContain('    status: completed');
      // 步骤级 inputs/outputs（缩进 3 级 = 6 空格）
      expect(yaml).toContain('    inputs:\n      x: hello');
      expect(yaml).toContain('    outputs:\n      y: world');
    });

    // @v: anc-obs-step-mapping
    it('records all executable step types correctly', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        level: 'debug',
        title: 'T',
        goal: 'G',
      });

      const stepTypes = ['reason', 'act', 'check', 'confirm', 'commit', 'call'];
      for (const [i, type] of stepTypes.entries()) {
        const id = String(i + 1);
        log.recordStepStart(id, type, `${type} step`);
        log.recordStepDone(id, { out: `${type}_result` });
      }
      log.close('completed');

      const yaml = readFileSync(log.getFilePath(), 'utf-8');
      for (const [i, type] of stepTypes.entries()) {
        const id = String(i + 1);
        const block = stepBlock(yaml, id);
        expect(block).toContain(`    type: ${type}\n`);
        expect(block).toContain('    status: completed\n');
        expect(block).toContain(`    summary: ${type} step\n`);
      }
    });

    it('records step failure with warn', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        title: 'T',
        goal: 'G',
      });

      log.recordStepStart('1', 'act', 'Failing step');
      log.recordStepFailed('1', 'something went wrong');
      log.close('failed');

      const yaml = readFileSync(log.getFilePath(), 'utf-8');
      const block = stepBlock(yaml, '1');
      expect(block).toContain('    status: failed\n');
      expect(block).toContain('    reason: something went wrong\n');
      // 多行 reason 的块标量缩进同档（2026-08-31 作者实抓:recordStepFailed 未传 indent,
      // 续行比字段行浅,块标量提前终止整文非法——check note 多行失败原因首撞）
      const log2 = new HopLog({ specId: 'test2', logDir: tmpDir, title: 'T', goal: 'G' });
      log2.recordStepStart('1', 'check', 'multi-line fail');
      log2.recordStepFailed('1', 'CHECK_FAILED: 字数不足\n三要素缺失：\n- 缺容量');
      log2.close('failed');
      const yaml2 = readFileSync(log2.getFilePath(), 'utf-8');
      // YAMLL 块间重复键是设计特性(js-yaml 严格模式拒),整文 parse 不作断言——
      // 结构正确性按缩进直断:字段行 4 格(顶层步 f=4),块标量续行必须更深(6 格)
      expect(yaml2).toMatch(/ {4}reason: \|-?\n {6}CHECK_FAILED/);
      // 反例锚:修前形态是续行 2 格(浅于字段行,块标量提前终止)
      expect(yaml2).not.toMatch(/ {4}reason: \|-?\n {2}CHECK_FAILED/);
      // 单块可 parse(切出 1 的 failed 块验证块标量真实闭合)
      const failBlock = yaml2.split('\n').filter(l => / {4}(status|failed_at|fail_kind|reason)|^ {6}/.test(l)).join('\n');
      expect(failBlock).toContain('CHECK_FAILED');
      // run-level close status（顶层 key，无缩进）
      expect(yaml).toContain('\nstatus: failed\n');
    });

    it('recordWarn attaches warning to existing step record', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        title: 'T',
        goal: 'G',
      });

      log.recordStepStart('1', 'act', 'Step one');
      log.recordWarn('1', 'something looks off');
      log.recordStepDone('1', { result: 'ok' });
      log.close('completed');

      const yaml = readFileSync(log.getFilePath(), 'utf-8');
      const block = stepBlock(yaml, '1');
      expect(block).toContain('    warn: something looks off\n');
      expect(block).toContain('    status: completed\n');
    });

    // #29 组装期告警暂存（^anc-obs-log-levels recordWarn 条款）：prompt 组装告警在
    // recordStepStart 实参求值期发出,时序天然早于 start——原 guardOrphan 一行标记吃正文,
    // 压缩观测通道在大样路径失聪（ppt 实锤 orphan recordWarn(4.2)）
    it('#29 正例：start 前的 step 级 warn 暂存,start 后冲账为该 step 的 warn 块（正文不丢零 orphan）', () => {
      const log = new HopLog({ specId: 'test', logDir: tmpDir, title: 'T', goal: 'G' });
      log.recordWarn('4.2', '[context-compress] 输入 49K 压缩至 20K');   // 组装期,4.2 还没 start
      log.recordStepStart('4.2', 'reason', 'Big step');
      log.recordStepDone('4.2', { r: 'ok' });
      log.close('completed');
      const yaml = readFileSync(log.getFilePath(), 'utf-8');
      expect(yaml).not.toContain('orphan');
      expect(stepBlock(yaml, '4.2')).toContain('warn: "[context-compress] 输入 49K 压缩至 20K"');
    });

    it('#29 二修：loop 第二轮组装期 warn（上轮已终态）暂存,冲进 #2 轮块不归错轮', () => {
      const log = new HopLog({ specId: 'test', logDir: tmpDir, title: 'T', goal: 'G' });
      log.recordStepStart('4.2', 'reason', 'r1');
      log.recordStepDone('4.2', { r: 'a' });
      log.recordWarn('4.2', '[context-compress] 第二轮组装告警');   // 上轮终态,本轮未 start
      log.recordStepStart('4.2', 'reason', 'r2');   // 第二轮 start,iterCounts→2
      log.recordStepDone('4.2', { r: 'b' });
      log.close('completed');
      const yaml = readFileSync(log.getFilePath(), 'utf-8');
      expect(yaml).not.toContain('orphan');
      // 告警落在 #2 轮块键下（start 块之后同键 warn 块）,不落第一轮裸键块
      // 强断言块键归属（二审抓弱断言:位置在后≠块键归属——回归成"陈旧键写块头但物理在后"照绿）:
      // warn 必须以 "4.2#2": 块头开出,warn: 行紧随其下
      expect(yaml).toMatch(/"4\.2#2":\n\s+warn: "\[context-compress\] 第二轮组装告警"/);
      // 第一轮裸键块下不得出现该 warn
      const firstBlockEnd = yaml.indexOf('"4.2#2"');
      expect(yaml.slice(0, firstBlockEnd)).not.toContain('第二轮组装告警');
    });

    it('#29 反例兜底：到 close 仍未 start 的暂存 warn 降文档级落账（真序列 bug 正文也不丢）', () => {
      const log = new HopLog({ specId: 'test', logDir: tmpDir, title: 'T', goal: 'G' });
      log.recordWarn('9.9', '真孤儿告警正文');   // 9.9 永远不 start
      log.close('failed');
      const yaml = readFileSync(log.getFilePath(), 'utf-8');
      expect(yaml).toContain('[step 9.9 未start] 真孤儿告警正文');   // 正文在场
      expect(yaml).not.toContain('# ERROR: orphan recordWarn');      // 不再一行标记吞正文
    });

    it('recordWarn writes normally at warn level', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        level: 'warn',
        title: 'T',
        goal: 'G',
      });

      log.recordStepStart('1', 'act', 'Step one');
      log.recordWarn('1', 'this should be recorded');
      log.close('completed');

      const mainYaml = readFileSync(log.getFilePath(), 'utf-8');
      expect(stepBlock(mainYaml, '1')).toContain('    warn: this should be recorded\n');
      expect(mainYaml).toContain('warn: this should be recorded');
    });

    // @v: anc-obs-replan-audit
    // replan_audit 四元组:顶层事件、无视日志级别(warn 级也记)、不受 guardOrphan
    // (subtask 容器从不 recordStepStart——若走 guardOrphan 会被当孤儿丢弃)。
    it('recordReplanAudit writes the four-tuple as a top-level event at any level', () => {
      const log = new HopLog({
        specId: 'fmt-parse',
        logDir: tmpDir,
        level: 'warn',  // 最严级别也必须记录(审计事件无视级别)
        title: 'T',
        goal: 'G',
      });

      // 不 recordStepStart '1' —— 证明不受 guardOrphan 拦截
      log.recordReplanAudit({
        spec_id: 'fmt-parse',
        step_id: '1',
        error_reason: 'format detect failed',
        generated_children: [
          { step_id: '1.1', step_type: 'act', summary: 'sniff format', outputs: ['fmt'] },
          { step_id: '1.2', step_type: 'act', summary: 'parse', outputs: ['parsed'] },
        ],
        base: 'scratch',
        at: '2026-06-15 23:00:00+08:00',
      });
      log.close('completed');

      const yaml = readFileSync(log.getFilePath(), 'utf-8');
      // 顶层 key(无缩进),非 orphan-error
      expect(yaml).toContain('\nreplan_audit:\n');
      expect(yaml).not.toContain('orphan');
      // 四元组齐全
      expect(yaml).toContain('spec_id: fmt-parse');
      expect(yaml).toContain('step_id: "1"');
      expect(yaml).toContain('error_reason: format detect failed');
      expect(yaml).toContain('base: scratch');
      // 生成的 children 内容
      expect(yaml).toContain('sniff format');
      expect(yaml).toContain('parse');
    });

    describe('log level filtering', () => {
      it('debug level records full input/output values', () => {
        const log = new HopLog({
          specId: 'test',
          logDir: tmpDir,
          level: 'debug',
          title: 'T',
          goal: 'G',
        });
        log.recordStepStart('1', 'reason', 'S', { data: 'full value' });
        log.recordStepDone('1', { result: 'output value' });
        log.close('completed');

        const yaml = readFileSync(log.getFilePath(), 'utf-8');
        const block = stepBlock(yaml, '1');
        expect(block).toContain('    inputs:\n      data: full value');
        expect(block).toContain('    outputs:\n      result: output value');
      });

      it('info level records real values (sanitized)', () => {
        const log = new HopLog({
          specId: 'test',
          logDir: tmpDir,
          level: 'info',
          title: 'T',
          goal: 'G',
        });
        log.recordStepStart('1', 'reason', 'S', { data: 'full value' });
        log.recordStepDone('1', { result: 'output value' });
        log.close('completed');

        const yaml = readFileSync(log.getFilePath(), 'utf-8');
        const block = stepBlock(yaml, '1');
        // info 级记录真实值（sanitize API key 但保留内容）
        expect(block).toContain('full value');
        expect(block).toContain('output value');
      });

      it('warn level records step skeleton but no variable values', () => {
        const log = new HopLog({
          specId: 'test',
          logDir: tmpDir,
          level: 'warn',
          title: 'T',
          goal: 'G',
        });
        log.recordStepStart('1', 'reason', 'S', { data: 'value' });
        log.close('completed');

        const mainYaml = readFileSync(log.getFilePath(), 'utf-8');
        const block = stepBlock(mainYaml, '1');
        // 步骤骨架任何级别都记录
        expect(block).not.toBe('');
        expect(block).toContain('    type: reason\n');
        expect(block).toContain('    summary: S\n');
        // warn 级不记录变量值（inputs/outputs 不出现）
        expect(block).not.toContain('inputs');
        expect(mainYaml).not.toContain('value');
      });

      // @v: anc-obs-llm-response — DEBT-09 兑现:LLM 原始 response debug 级落账,info 级剥离
      it('debug level records llm.response full text (sanitized)', () => {
        const log = new HopLog({
          specId: 'test',
          logDir: tmpDir,
          level: 'debug',
          title: 'T',
          goal: 'G',
        });
        log.recordStepStart('1', 'reason', 'S');
        log.recordStepMeta('1', {
          llm: { model: 'm1', input_tokens: 10, output_tokens: 20, response: 'raw reply sk-SECRETKEYVALUE0123456789 end ' + 'x'.repeat(300) },
        });
        log.close('completed');

        const yaml = readFileSync(log.getFilePath(), 'utf-8');
        const block = stepBlock(yaml, '1');
        expect(block).toContain('raw reply');       // 原始回复全文在场
        expect(block).toContain('x'.repeat(300));   // 不截断（sanitizeFull,非 200 字 sanitize）
        expect(block).not.toContain('SECRETKEYVALUE'); // API key 脱敏生效
        expect(block).toContain('model: m1');
      });

      it('info level strips llm.response but keeps model/tokens', () => {
        const log = new HopLog({
          specId: 'test',
          logDir: tmpDir,
          level: 'info',
          title: 'T',
          goal: 'G',
        });
        log.recordStepStart('1', 'reason', 'S');
        log.recordStepMeta('1', {
          llm: { model: 'm1', input_tokens: 10, output_tokens: 20, response: 'raw reply text' },
        });
        log.close('completed');

        const yaml = readFileSync(log.getFilePath(), 'utf-8');
        const block = stepBlock(yaml, '1');
        expect(block).toContain('model: m1');          // 流控轨迹 info 级保留
        expect(block).toContain('output_tokens: 20');
        expect(block).not.toContain('raw reply text'); // response 剥离
        expect(block).not.toContain('response:');
      });

      it('multiple llm meta calls each land as separate blocks (schema-retry rounds keep trace)', () => {
        const log = new HopLog({
          specId: 'test',
          logDir: tmpDir,
          level: 'debug',
          title: 'T',
          goal: 'G',
        });
        log.recordStepStart('1', 'reason', 'S');
        log.recordStepMeta('1', { llm: { model: 'm1', output_tokens: 8183, response: 'first attempt discarded by schema check' } });
        log.recordStepMeta('1', { llm: { model: 'm1', output_tokens: 1800, response: 'second attempt accepted' } });
        log.close('completed');

        const yaml = readFileSync(log.getFilePath(), 'utf-8');
        // 两轮各自留痕——被丢弃轮是当轮模型真实行为的唯一物证
        expect(yaml).toContain('first attempt discarded by schema check');
        expect(yaml).toContain('second attempt accepted');
        expect(yaml).toContain('output_tokens: 8183');
        expect(yaml).toContain('output_tokens: 1800');
      });
    });

    it('sanitizes API keys in debug values', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        level: 'debug',
        title: 'T',
        goal: 'G',
      });
      log.recordStepStart('1', 'act', 'S', { key: 'sk-abcdefghijklmnopqrstuvwxyz12345' });
      log.close('completed');

      const yaml = readFileSync(log.getFilePath(), 'utf-8');
      expect(yaml).toContain('key: "sk-***"');
      expect(yaml).not.toContain('sk-abcdefghijklmnopqrstuvwxyz12345');
    });
  });

  describe('engine integration', () => {
    it('produces main.yaml after full execution', () => {
      const engine = new ExecutionEngine();
      const init = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { logDir: tmpDir, params: { data: 'd' } });
      expect(init.status).toBe('ok');

      const step1 = engine.nextStep();
      if (step1.status !== 'step_ready') return;
      engine.completeStep(step1.step_id, { mid: 'analyzed' });

      const step2 = engine.nextStep();
      if (step2.status !== 'step_ready') return;
      engine.completeStep(step2.step_id, { result: 'transformed' });

      const final = engine.nextStep();
      expect(final.status).toBe('completed');

      // Find the .hoplog directory
      const dirs = readdirSync(tmpDir);
      expect(dirs.length).toBe(1);
      expect(dirs[0]).toMatch(/^log-test-/);

      const mainYaml = readFileSync(join(tmpDir, dirs[0], 'main.yaml'), 'utf-8');
      expect(mainYaml).toContain('spec_id: log-test');
      expect(mainYaml).toContain('status: completed');
      expect(mainYaml).toContain('Analyze');
      expect(mainYaml).toContain('Transform');
    });

    // @v: anc-obs-step-start-timing, anc-obs-step-done-timing
    // branch/case 容器 lifecycle:branch 命中 case 后,hoplog 应含 branch 容器 start+done、
    // 选中 case start+done、未选中 case 不出现。回归 ppt-html 实测的 case 3.2 完全消失问题。
    it('records branch+selected-case container lifecycle (start+done), skipped case absent', () => {
      const BRANCH_SPEC = `# BranchLog
Id: branch-log
## Goal
g
## Inputs
- mode: line  # mode
## Outputs
- out: text  # final
## Steps
1. [branch] 路由
  - ← mode
  + → out: text  # selected
  1.1. [case] mode == "a"
    + → out: text  # path a
    1.1.1. [reason] do A
      + → out: text
      > pick A
  1.2. [case] default
    + → out: text  # path b
    1.2.1. [reason] do B
      + → out: text
      > pick B
2. [reason] tail
  - ← out
  + → final_out: text  # echo
  > echo out
`;
      const engine = new ExecutionEngine();
      engine.initExecution(BRANCH_SPEC, MINIMAL_HOST_CONFIG, { logDir: tmpDir, params: { mode: 'a' } });
      // 推进到 1.1.1(branch 命中 case 1.1)
      const r1 = engine.nextStep();
      if (r1.status !== 'step_ready' || r1.step_id !== '1.1.1') throw new Error('expected 1.1.1');
      engine.completeStep('1.1.1', { out: 'A' });
      // 推进到 2
      const r2 = engine.nextStep();
      if (r2.status !== 'step_ready' || r2.step_id !== '2') throw new Error('expected 2');
      engine.completeStep('2', { final_out: 'A' });
      const fin = engine.nextStep();
      expect(fin.status).toBe('completed');

      const dirs = readdirSync(tmpDir);
      const mainYaml = readFileSync(join(tmpDir, dirs[0], 'main.yaml'), 'utf-8');

      // branch 容器 start + done(start 走 newlyRunning,done 走 propagateCompletion 的 newlyDone 通道)
      const branchBlock = mainYaml.slice(mainYaml.indexOf('  "1":'));
      expect(branchBlock).toContain('type: branch');
      // 选中的 case 1.1 也应有 start + done
      const case11 = mainYaml.indexOf('  "1.1":');
      expect(case11).toBeGreaterThan(-1);
      const case11Block = mainYaml.slice(case11);
      expect(case11Block).toContain('type: case');
      // 未选中的 case 1.2 不应出现在 hoplog(skipped 不 start)
      expect(mainYaml).not.toContain('  "1.2":');
      // branch + case 都应有 completed_at / status: completed(容器 done 通道生效)
      // 用计数避免误匹配 — 至少 4 个 completed:1/1.1/1.1.1/2(branch 容器+选中 case+叶子+尾步)
      const completedCount = (mainYaml.match(/status: completed/g) || []).length;
      expect(completedCount).toBeGreaterThanOrEqual(4);

      // YAMLL 结构（^anc-obs-nested-tree v3）：缩进按 step-id 深度（供折叠），每事件自成块。
      // key 缩进：1@2sp、1.1@4sp、1.1.1@6sp；各自 status 缩进 = 2d+2（4/6/8sp）。
      expect(mainYaml).toMatch(/^ {2}"1":$/m);          // branch 块头 @2sp
      expect(mainYaml).toMatch(/^ {4}"1.1":$/m);        // case 块头 @4sp
      expect(mainYaml).toMatch(/^ {6}1\.1\.1:$/m);      // reason 块头 @6sp
      expect(mainYaml).toMatch(/^ {8}status: completed$/m); // 1.1.1 done @8sp
      expect(mainYaml).toMatch(/^ {6}status: completed$/m); // 1.1 done @6sp（归 case）
      expect(mainYaml).toMatch(/^ {4}status: completed$/m); // 1 done @4sp（归 branch）
      // YAMLL：start/done 各自成块、块头同 step-id 重复是合法的（不再要求 key 唯一）。
      // 整体 YAMLL 合法（header + 逐块）。
      expectYamllValid(mainYaml);
    });

    // 失败重跑轮同样带 #iter（2026-08-10 cc:repair e2e 实撞:failed→再 start 时 doneSteps 命中
    // 轮次+1,但 startedSteps 未清 → start 落 resume 去重分支被吞,新轮无 #N 块键——三轮全记 "3.2"）。
    it('failed→retry re-start gets #iter key (not swallowed as resumed)', () => {
      const log = new HopLog({ specId: 't', logDir: tmpDir, title: 'T', goal: 'G' });
      log.recordStepStart('3.2', 'check', 'gate');
      log.recordStepFailed('3.2', 'CHECK_FAILED: x');
      log.recordStepStart('3.2', 'check', 'gate');   // 失败重跑轮
      log.recordStepDone('3.2', { ok: true });
      const text = readFileSync(join(log.getRunDir(), 'main.yaml'), 'utf-8');
      expect(text).toContain('"3.2#2"');
      expect(extractHopLogStepKeys(text)).toContain('3.2#2');
    });

    // 反例①：真 resume（未终态续跑）不得被误判新轮——修复清 startedSteps 只发生在"已终态又
    // start"分支,未终态的 resume 续跑仍走去重分支:无 #2、有 resumed 标记（防修复误伤 resume 语义）。
    it('反例:未终态 resume 续跑不判新轮——无 #iter、有 resumed 标记', () => {
      const log = new HopLog({ specId: 't', logDir: tmpDir, title: 'T', goal: 'G' });
      log.recordStepStart('2', 'reason', 'work');    // start 后未终态（进程中断场景）
      const resumed = HopLog.resume(log.getRunDir());
      resumed.recordStepStart('2', 'reason', 'work'); // recover 重发 start——续跑非新轮
      resumed.recordStepDone('2', { ok: true });
      const text = readFileSync(join(log.getRunDir(), 'main.yaml'), 'utf-8');
      expect(text).not.toContain('"2#2"');            // 不是新轮
      expect(text).toContain('resumed_at:');          // 是恢复标记
    });

    // 正例②（跨进程,当次实撞里 3.1 恰好走通的路径钉死为契约）：failed 后跨进程重跑,
    // 文件重建 doneSteps（failed 也是终态）→ 再 start 带 #2。
    it('跨进程 failed→retry 重跑同样带 #iter key', () => {
      const log = new HopLog({ specId: 't', logDir: tmpDir, title: 'T', goal: 'G' });
      log.recordStepStart('3.1', 'act', 'assemble');
      log.recordStepFailed('3.1', 'boom');
      const runDir = log.getRunDir();
      const resumed = HopLog.resume(runDir);          // 新进程:从文件重建 doneSteps/iterCounts
      resumed.recordStepStart('3.1', 'act', 'assemble');  // 失败重跑轮
      resumed.recordStepDone('3.1', { ok: true });
      const text = readFileSync(join(runDir, 'main.yaml'), 'utf-8');
      expect(text).toContain('"3.1#2"');
      expect(extractHopLogStepKeys(text)).toContain('3.1#2');
    });

    // loop 多轮：同一子步 id 每轮重复，hoplog 用 #iter key 区分（^anc-obs-nested-tree）。
    // 回归"嵌套后同层重复 key、YAML 非法"。
    it('records loop iterations with #iter suffix keys (no duplicate keys)', () => {
      const LOOP_SPEC = `# LoopLog
Id: loop-log
## Goal
g
## Inputs
- seed: line  # seed
## Outputs
- final_out: text  # out
## Steps
1. [loop max_iterations=2] 反复
  + → acc: text = ""  # acc
  1.1. [reason] 本轮
    - ← seed
    + → item: text  # item
    > gen
2. [reason] 尾
  - ← acc
  + → final_out: text  # echo
  > done
`;
      const engine = new ExecutionEngine();
      engine.initExecution(LOOP_SPEC, MINIMAL_HOST_CONFIG, { logDir: tmpDir, params: { seed: 'x' } });
      // 第 1 轮 1.1
      let r = engine.nextStep();
      if (r.status !== 'step_ready' || r.step_id !== '1.1') throw new Error('expected 1.1 iter1');
      engine.completeStep('1.1', { item: '轮1' });
      // 第 2 轮 1.1（loop 回环）
      r = engine.nextStep();
      if (r.status !== 'step_ready' || r.step_id !== '1.1') throw new Error('expected 1.1 iter2');
      engine.completeStep('1.1', { item: '轮2' });
      // loop 结束到 step 2
      r = engine.nextStep();
      if (r.status !== 'step_ready' || r.step_id !== '2') throw new Error('expected 2');
      engine.completeStep('2', { final_out: 'done' });
      engine.nextStep();

      const dirs = readdirSync(tmpDir);
      const mainYaml = readFileSync(join(tmpDir, dirs[0], 'main.yaml'), 'utf-8');

      // loop 容器 @2sp，两轮子步：1.1（首轮）@4sp + 1.1#2（次轮）@4sp——#iter 区分两轮。
      expect(mainYaml).toMatch(/^ {2}"1":$/m);           // loop 块头
      expect(mainYaml).toMatch(/^ {4}"1.1":$/m);         // 第 1 轮
      expect(mainYaml).toMatch(/^ {4}"1.1#2":$/m);       // 第 2 轮，#iter 区分（两轮不同 key、不撞）
      // YAMLL：同一轮的 start/done 各自成块、块头同 key 重复合法；#iter 只区分**轮次**不同 key。
      // 两轮 item 值都在
      expect(mainYaml).toContain('轮1');
      expect(mainYaml).toContain('轮2');
      // loop 容器 done @4sp
      expect(mainYaml).toMatch(/^ {4}status: completed$/m);
    });

    it('works without logDir (no log output)', () => {
      const engine = new ExecutionEngine();
      const init = engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { data: 'd' } });
      expect(init.status).toBe('ok');

      const step1 = engine.nextStep();
      if (step1.status !== 'step_ready') return;
      engine.completeStep(step1.step_id, { mid: 'v' });

      const step2 = engine.nextStep();
      if (step2.status !== 'step_ready') return;
      engine.completeStep(step2.step_id, { result: 'r' });

      engine.nextStep();
      // No crash, no .hoplog directory created
      expect(readdirSync(tmpDir).length).toBe(0);
    });

    it('logs failure reason on failed execution', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { logDir: tmpDir, params: { data: 'd' } });

      const step1 = engine.nextStep();
      if (step1.status !== 'step_ready') return;
      engine.failStep(step1.step_id, 'test error');

      // Step 2 will None-propagate and fail; eventually reach terminal
      let resp = engine.nextStep();
      while (resp.status === 'step_ready') {
        engine.completeStep(resp.step_id, {});
        resp = engine.nextStep();
      }

      const dirs = readdirSync(tmpDir);
      expect(dirs.length).toBe(1);
      const mainYaml = readFileSync(join(tmpDir, dirs[0], 'main.yaml'), 'utf-8');
      expect(mainYaml).toContain('status: failed');
    });
  });

  // @v: anc-obs-audit
  describe('recordStepMeta audit fields', () => {
    it('records tool calls as step field', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        title: 'T',
        goal: 'G',
      });
      log.recordStepStart('1', 'act', 'Use tools');
      log.recordStepMeta('1', {
        tool: [
          { name: 'read_file', result: 'success', at: '2026-06-12 10:00:00+08:00' },
          { name: 'write_file', result: 'failure', at: '2026-06-12 10:00:01+08:00' },
        ],
      });
      log.recordStepDone('1');
      log.close('completed');

      const block = stepBlock(readFileSync(log.getFilePath(), 'utf-8'), '1');
      expect(block).toContain('    tool:\n');
      // 两条 tool 记录按顺序出现
      const first = block.indexOf('- name: read_file');
      const second = block.indexOf('- name: write_file');
      expect(first).toBeGreaterThan(-1);
      expect(second).toBeGreaterThan(first);
      expect(block.slice(first, second)).toContain('result: success');
      expect(block.slice(second)).toContain('result: failure');
    });

    it('records commit_audit as step field', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        title: 'T',
        goal: 'G',
      });
      log.recordStepStart('3', 'commit', 'Deploy');
      log.recordStepMeta('3', {
        commit_audit: { target: 'output.md', authorized_by: 'human', result: 'success', at: '2026-06-12 10:00:00+08:00' },
      });
      log.close('completed');

      const block = stepBlock(readFileSync(log.getFilePath(), 'utf-8'), '3');
      expect(block).toContain('    commit_audit:\n');
      expect(block).toContain('target: output.md');
      expect(block).toContain('authorized_by: human');
      expect(block).toContain('result: success');
    });

    // @v: anc-obs-hitl-record
    it('records hitl as step field', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        title: 'T',
        goal: 'G',
      });
      log.recordStepStart('2', 'confirm', 'Confirm plan');
      log.recordStepMeta('2', {
        hitl: { response: 'yes', responder: 'human', options: ['yes', 'no'], at: '2026-06-12 10:00:00+08:00' },
      });
      log.close('completed');

      const block = stepBlock(readFileSync(log.getFilePath(), 'utf-8'), '2');
      expect(block).toContain('    hitl:\n');
      expect(block).toContain('response: yes');
      expect(block).toContain('responder: human');
      expect(block).toContain('options:');
      expect(block).toContain('- yes');
      expect(block).toContain('- no');
    });

    it('streams audit fields to main.yaml immediately', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        title: 'T',
        goal: 'G',
      });
      log.recordStepStart('1', 'act', 'Use tools');
      log.recordStepMeta('1', {
        tool: [{ name: 'read_file', result: 'success', at: '2026-06-12 10:00:00+08:00' }],
      });
      log.recordStepStart('2', 'commit', 'Deploy');
      log.recordStepMeta('2', {
        commit_audit: { target: 'prod-deploy', authorized_by: 'none', result: 'success', at: '2026-06-12 10:00:01+08:00' },
      });

      const mainYaml = readFileSync(join(log.getRunDir(), 'main.yaml'), 'utf-8');
      expect(mainYaml).toContain('tool:');
      expect(mainYaml).toContain('name: read_file');
      expect(mainYaml).toContain('result: success');
      expect(mainYaml).toContain('commit_audit:');
      expect(mainYaml).toContain('target: prod-deploy');
      expect(mainYaml).toContain('authorized_by: none');
    });

    it('always records audit fields regardless of log level', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        level: 'warn',
        title: 'T',
        goal: 'G',
      });
      log.recordStepStart('1', 'act', 'Use tools');
      log.recordStepMeta('1', {
        tool: [{ name: 'read_file', result: 'success', at: '2026-06-12 10:00:00+08:00' }],
        knowledge: [{ source_id: 'kb-1', at: '2026-06-12 10:00:00+08:00' }],
        callee_spec_id: 'sub-spec',
      });
      log.close('completed');

      const mainYaml = readFileSync(log.getFilePath(), 'utf-8');
      const block = stepBlock(mainYaml, '1');
      // 审计性字段：warn 级仍写入
      expect(block).toContain('    tool:\n');
      expect(block).toContain('- name: read_file');
      expect(block).toContain('    callee_spec_id: sub-spec\n');
      // knowledge 是只读知识检索——流控字段，warn 级不写入（非审计范畴）
      expect(block).not.toContain('knowledge:');
    });

    it('skips flow-control fields at warn level', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        level: 'warn',
        title: 'T',
        goal: 'G',
      });
      log.recordStepStart('1', 'act', 'Retrying step');
      log.recordStepMeta('1', {
        retry: { attempt: 2, max: 3 },
        taken: '2.1',
        tokens_used: 1234,
      });
      log.close('completed');

      const mainYaml = readFileSync(log.getFilePath(), 'utf-8');
      expect(mainYaml).not.toContain('retry');
      expect(mainYaml).not.toContain('taken');
      expect(mainYaml).not.toContain('tokens_used');
    });

    it('records flow-control fields at info level', () => {
      const log = new HopLog({
        specId: 'test',
        logDir: tmpDir,
        level: 'info',
        title: 'T',
        goal: 'G',
      });
      log.recordStepStart('1', 'act', 'Retrying step');
      log.recordStepMeta('1', {
        retry: { attempt: 2, max: 3 },
        taken: '2.1',
      });
      log.close('completed');

      const mainYaml = readFileSync(log.getFilePath(), 'utf-8');
      const block = stepBlock(mainYaml, '1');
      expect(block).toContain('    retry:\n');
      expect(block).toContain('attempt: 2');
      expect(block).toContain('max: 3');
      expect(block).toContain('    taken: "2.1"\n');
    });
  });

  // @v: anc-obs-hoplog-flush
  describe('HopLog.flush()', () => {
    it('streams to main.yaml immediately', () => {
      const log = new HopLog({
        specId: 'flush-test',
        logDir: tmpDir,
        title: 'T',
        goal: 'G',
      });
      log.recordStepStart('1', 'act', 'Step');

      const runDir = log.getRunDir();
      expect(existsSync(join(runDir, 'main.yaml'))).toBe(true);

      const content = readFileSync(join(runDir, 'main.yaml'), 'utf-8');
      expect(content).toContain('spec_id: flush-test');
      expect(content).toContain('type: act');
      expect(content).toContain('summary: Step');
    });
  });

  // @v: anc-obs-hoplog-resume
  describe('HopLog.resume()', () => {
    it('resumes and continues appending to main.yaml', () => {
      const log = new HopLog({
        specId: 'resume-test',
        logDir: tmpDir,
        title: 'T',
        goal: 'G',
      });
      log.recordStepStart('1', 'act', 'Step one');
      log.recordStepDone('1', { result: 'done' });

      const runDir = log.getRunDir();
      expect(existsSync(join(runDir, 'main.yaml'))).toBe(true);

      const resumed = HopLog.resume(runDir);
      resumed.recordStepStart('2', 'reason', 'Step two');
      resumed.recordStepDone('2', { analysis: 'ok' });
      resumed.close('completed');

      const content = readFileSync(join(runDir, 'main.yaml'), 'utf-8');
      // Both steps are in the file
      expect(content).toContain('Step one');
      expect(content).toContain('Step two');
      expect(content).toContain('status: completed');
      // Resume marker present（结构化字段 resumed_at，落在 step 2 前）
      expect(content).toContain('resumed_at:');
    });

    // @v: anc-obs-hoplog-resume, anc-obs-nested-tree
    // 回归 e2e 实测：resume 发生在深缩进子步中途（subtask 内 act 中断），resumed_at 曾顶格写入
    // → 闭合 execution mapping、新 step key 悬空、YAML 非法。修复：resumed_at 作新 step 首个 body
    // 字段（随 step 深度），不顶格。断言真 yaml.load 通过。
    it('resume 发生在深缩进子步中途：resumed_at 不顶格截断、YAML 可解析', () => {
      const log = new HopLog({ specId: 'resume-deep', logDir: tmpDir, title: 'T', goal: 'G', level: 'debug' });
      // 顶层 subtask 4 下的子步 4.1（深缩进），带 doc_refs（深缩进 body，模拟 e2e 中断前最后记录）
      log.recordStepStart('4', 'subtask', '容器');
      log.recordStepStart('4.1', 'act', '子步一');
      log.recordStepMeta('4.1', { doc_refs: [{ source_id: 'spec#章节', at: '2026-01-01T00:00:00Z' }] });
      log.recordStepDone('4.1', { r: 'ok' });
      const runDir = log.getRunDir();

      // 进程在 subtask 4 内部中断后 resume，再 start 同 subtask 下的 4.2（深缩进子步）
      const resumed = HopLog.resume(runDir);
      resumed.recordStepStart('4.2', 'act', '子步二');
      resumed.recordStepDone('4.2', { r: 'ok2' });
      resumed.close('completed');

      const content = readFileSync(join(runDir, 'main.yaml'), 'utf-8');
      // 核心：YAMLL 逐块合法（resumed_at 顶格/错层会令块解析崩）
      expectYamllValid(content);
      // resumed_at 不在顶格
      expect(content).not.toMatch(/^resumed_at:/m);
      // resumed_at 作 4.2 的 body 字段存在（6 空格：4.2 深度 d=2 → 2d+2=6）——resume 后首个新 step 承载 marker
      expect(content).toMatch(/^ {6}resumed_at:/m);
    });

    it('creates fresh log when main.yaml missing', () => {
      const fakeDir = join(tmpDir, 'nonexistent-run');
      const resumed = HopLog.resume(fakeDir);
      resumed.recordStepStart('1', 'act', 'Fallback');
      // File exists and has content
      const content = readFileSync(resumed.getFilePath(), 'utf-8');
      expect(resumed.getFilePath()).toBe(join(fakeDir, 'main.yaml'));
      expect(content).toContain('resumed_at:');
      expect(content).toContain('  "1":');
      expect(content).toContain('type: act');
      expect(content).toContain('summary: Fallback');
    });

    it('engine resume continues appending to same log file', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'hoplog-resume-'));
      const engine = new ExecutionEngine();
      engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { stateDir, logDir: tmpDir, params: { data: 'd' } });

      const step1 = engine.nextStep();
      if (step1.status !== 'step_ready') throw new Error('Expected step_ready');
      engine.completeStep(step1.step_id, { mid: 'v1' });

      const instanceDir = (engine as any).instanceDir;

      // Simulate CLI next invocation: resume from state
      const resumed = ExecutionEngine.load(instanceDir);
      const step2 = resumed.nextStep();
      if (step2.status !== 'step_ready') throw new Error('Expected step_ready');
      resumed.completeStep(step2.step_id, { result: 'v2' });

      const final = resumed.nextStep();
      expect(final.status).toBe('completed');

      // Verify HopLog file contains both steps (streamed across invocations)
      const hoplog = resumed.getHopLog();
      expect(hoplog).not.toBeNull();
      const content = readFileSync(join(hoplog!.getRunDir(), 'main.yaml'), 'utf-8');
      expect(content).toContain('type: reason');  // step 1
      expect(content).toContain('type: act');     // step 2 (from TWO_STEP_SPEC)
      expect(content).toContain('resumed_at:');    // resume marker（结构化字段）
    });

    // 回归：resume marker 曾无条件 append `  # resumed at`（2 空格裸注释），跨进程续
    // reason/act 步时（debug 级 prompt 已写、response 未写）砸进未闭合的 8 空格 `prompt: |`
    // 块标量中间，提前终止标量 + 缩进错层 → 破坏 YAML（实测一份 run 10 marker 8 命中）。
    // 修复：延迟结构化写入（resumed_at 字段，按层级 flush）。见 design ^anc-obs-hoplog-resume。
    it('resume 时上一步 prompt 未闭合（跨进程续同一步）——resumed_at 不砸进 prompt 块标量', () => {
      // 进程 A：debug 级，reason 步 start 写了 prompt，但尚未 done（交 caller 后进程退出）
      const log = new HopLog({ specId: 'blockscalar', logDir: tmpDir, title: 'T', goal: 'G', level: 'debug' });
      log.recordStepStart('1', 'reason', '起草', { src: 'x' }, 'L1 Spec 契约\n多行 prompt 内容\n第三行');
      const runDir = log.getRunDir();

      // 进程 B：resume 后续「同一步」的 done（prompt→response 之间正是旧 bug 的插入点）
      const resumed = HopLog.resume(runDir);
      resumed.recordStepDone('1', { draft: 'ok' });
      resumed.close('completed');

      const content = readFileSync(join(runDir, 'main.yaml'), 'utf-8');
      const lines = content.split('\n');

      // ① marker 存在且为结构化字段（非裸注释）
      expect(content).toContain('resumed_at:');
      expect(content).not.toContain('# resumed');

      // ② 每个 resumed_at 行缩进合法（0=顶层 或 4=step 子字段），绝不是 prompt 内容的 6+ 缩进
      const markerLines = lines.filter(l => /resumed_at:/.test(l));
      expect(markerLines.length).toBeGreaterThan(0);
      for (const ml of markerLines) {
        const indent = ml.match(/^ */)![0].length;
        expect([0, 4]).toContain(indent);
      }

      // ③ marker 不落在 prompt 块标量内部：找 `      prompt: |` 后紧跟的内容行，
      //    验证其间没有 resumed_at（即 prompt 三行内容连续、未被 marker 截断）
      const promptIdx = lines.findIndex(l => /^      prompt: \|/.test(l));
      expect(promptIdx).toBeGreaterThan(-1);
      // prompt 内容行应连续为 8 空格缩进，直到 response/结构字段；这段内不得有 resumed_at
      const promptBody: string[] = [];
      for (let i = promptIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === '') { promptBody.push(l); continue; }
        const ind = l.match(/^ */)![0].length;
        if (ind >= 8) { promptBody.push(l); continue; }
        break; // 块标量结束
      }
      expect(promptBody.join('\n')).toContain('多行 prompt 内容');
      expect(promptBody.join('\n')).toContain('第三行');
      expect(promptBody.some(l => /resumed_at/.test(l))).toBe(false);

      // ④ response 完整写入（step done 的产出没被破坏）
      expect(content).toContain('response:');
      expect(content).toContain('draft: ok');

      // ⑤ 核心：llm 块 prompt 连续未被切断，response 作 step body 平级字段（4 空格，非 llm 子级）。
      //    response 改平级的原因见 hoplog.ts recordStepDone 注释：llm 块在 start 时写完即闭合，
      //    response 在 done 时才写、无法回到 llm 块内，故平级。prompt 块标量内容行连续（≥8 空格），
      //    其间无任何 <8 空格字段插入（含 resumed_at）——保证 prompt 三行不被截断。
      const respIdx = lines.findIndex(l => /^    response:/.test(l)); // 4 空格：step body 平级
      expect(respIdx).toBeGreaterThan(-1);
      // prompt 块标量（promptIdx 后）到其闭合之间只有 ≥8 空格内容行或空行，无字段插入
      const promptClose = lines.findIndex((l, i) => i > promptIdx && l.trim() !== '' && l.match(/^ */)![0].length < 8);
      const between = lines.slice(promptIdx + 1, promptClose).filter(l => l.trim() !== '');
      for (const l of between) {
        expect(l.match(/^ */)![0].length).toBeGreaterThanOrEqual(8);
      }
      // 真 YAML 可解析（block scalar + 平级 response 都合法）
      expectYamllValid(content);
    });

    // 回归：resume 后直接续完最后一步→close（无新 recordStepStart），marker 不能丢失
    it('resume 后直接 close（无新 step）——resumed_at 仍被 flush 不丢失', () => {
      const log = new HopLog({ specId: 'resume-close', logDir: tmpDir, title: 'T', goal: 'G', level: 'debug' });
      log.recordStepStart('1', 'act', '干活');
      log.recordStepDone('1', { r: 'v' });
      const runDir = log.getRunDir();

      const resumed = HopLog.resume(runDir);
      resumed.close('completed'); // resume 后没有任何 record*，直接 close

      const content = readFileSync(join(runDir, 'main.yaml'), 'utf-8');
      expect(content).toContain('resumed_at:'); // close 前 flush，marker 不丢
      expect(content).toContain('status: completed');
    });

    // loop 跨进程：进程 A 写首轮 1.1 done，进程 B resume 后同一 1.1 再 start（第 2 轮）——
    // resume 须从文件重建 iterCounts + doneSteps，B 里 1.1 再 start 生成 #2（不重复 key）。
    it('resume 重建 iterCounts：跨进程 loop 次轮生成 #iter key', () => {
      const log = new HopLog({ specId: 'resume-iter', logDir: tmpDir, title: 'T', goal: 'G', level: 'info' });
      log.recordStepStart('1', 'loop', '循环');       // 容器
      log.recordStepStart('1.1', 'reason', '首轮');   // 第 1 轮子步
      log.recordStepDone('1.1', { x: 'r1' });
      const runDir = log.getRunDir();

      // 进程 B：resume 后同一 1.1 再 start（loop 第 2 轮）
      const resumed = HopLog.resume(runDir);
      resumed.recordStepStart('1.1', 'reason', '次轮'); // doneSteps 含 1.1 → iter+1 → key 1.1#2
      resumed.recordStepDone('1.1', { x: 'r2' });
      resumed.close('completed');

      const content = readFileSync(join(runDir, 'main.yaml'), 'utf-8');
      expect(content).toMatch(/^ {4}"1.1":$/m);    // 第 1 轮（key 1.1）
      expect(content).toMatch(/^ {4}"1.1#2":$/m);  // 第 2 轮（跨进程重建 iterCount 后 key 1.1#2，与首轮不同）
      // YAMLL：同轮 start/done 各成块、块头重复合法；#iter 保证两轮 key 不同、不混。
      expect(content).toContain('r1');
      expect(content).toContain('r2');
      expectYamllValid(content);
    });

    // @v: anc-obs-hoplog-resume
    // 回归 e2e：resume 续一个 started-但-未-done 的 step（subtask 内 act 中断，resume 重发其 step_ready
    // 再走 recordStepStart）**不是** loop 新轮，不得生成 #iter key。旧 bug：doneSteps 收了所有 started，
    // 把未完成的 4.2 误判新轮 → "4#2"/"4.2#2"。修复：doneSteps 只收文件中真正终态（status:）的 step。
    it('resume 续未完成 step 不误判 loop 新轮（不生成 #iter）', () => {
      const log = new HopLog({ specId: 'resume-unfinished', logDir: tmpDir, title: 'T', goal: 'G', level: 'info' });
      log.recordStepStart('4', 'subtask', '容器');      // 容器，未 done
      log.recordStepStart('4.2', 'act', '外壳');        // 子步 started，但**未 done**（进程在此中断）
      const runDir = log.getRunDir();

      // 进程 B：resume 后重发 4.2（续未完成步，非新轮）
      const resumed = HopLog.resume(runDir);
      resumed.recordStepStart('4.2', 'act', '外壳-重发');
      resumed.recordStepDone('4.2', { shell: 'ok' });
      resumed.close('completed');

      const content = readFileSync(join(runDir, 'main.yaml'), 'utf-8');
      // 4/4.2 均未 done 过 → 不得有 #iter key
      expect(content).not.toMatch(/#2/);
      expect(content).not.toMatch(/"4#/);
      expect(content).not.toMatch(/"4\.2#/);
      // YAML 仍可解析
      expectYamllValid(content);
    });

    // @v: anc-obs-hoplog-resume
    // 回归 e2e v4（line 177 崩点）：recover 会对同一未完成 step 的 recordStepStart 重发**多次**
    // （非一次）。旧 resumedStarted"续一次即消费"在第 2 次重发漏判 → 重写骨架 → 重复 mapping key。
    // 修复：用 startedSteps 幂等——已写骨架的 step 又 start 且未 done，无论重发几次都跳过骨架、
    // 只补一次 resumed_at。断言：只有一个 2.1.1 key、YAML 可解析。
    it('recover 重发同 step 多次：骨架幂等、不重复 key、YAML 可解析', () => {
      const log = new HopLog({ specId: 'recover-multi', logDir: tmpDir, title: 'T', goal: 'G', level: 'debug' });
      log.recordStepStart('2', 'branch', '分支');
      log.recordStepStart('2.1', 'case', '命中');           // 逐级 start，不跳级
      log.recordStepStart('2.1.1', 'act', '读取', { s: 'y' }, 'prompt\n多行\n三行'); // 崩前最后写
      const runDir = log.getRunDir();

      const r = HopLog.resume(runDir);
      r.recordStepStart('2.1.1', 'act', '读取', { s: 'y' }, 'prompt\n多行\n三行'); // recover 重发 #1
      r.recordStepStart('2.1.1', 'act', '读取', { s: 'y' }, 'prompt\n多行\n三行'); // recover 重发 #2（幂等跳过）
      r.recordStepDone('2.1.1', { content: 'x' });
      r.recordStepDone('2.1', {}); r.recordStepDone('2', {}); r.close('completed');

      const content = readFileSync(join(runDir, 'main.yaml'), 'utf-8');
      // YAMLL：2.1.1 的 start/resumed/done 各成块、块头重复合法——不再断"唯一 key"。
      // 关键：recover 重发未误判 loop 新轮（无 #iter），且整体 YAMLL 合法。
      expect(content).not.toMatch(/2\.1\.1#/);
      // resumed_at 去重：多次重发只标一次
      expect((content.match(/resumed_at:/g) || []).length).toBe(1);
      expectYamllValid(content);
    });

    // @v: anc-obs-hoplog-resume
    // 回归 e2e v5（line 1366 崩点）：多次跨进程 resume 续同一未完成 step，每次都触发 flushResume。
    // 旧 bug：每次各写一个 resumed_at → 同 step 内重复 mapping key（YAML 非法）。
    // 修复：flushResume 单一出口 + resumedWritten 去重（跨进程从文件重建）——同 step 只落一个 resumed_at。
    it('多次跨进程 resume 续同 step：resumed_at 不重复、YAML 可解析', () => {
      const log = new HopLog({ specId: 'resume-multi', logDir: tmpDir, title: 'T', goal: 'G', level: 'debug' });
      log.recordStepStart('4', 'subtask', '容器');
      log.recordStepStart('4.1', 'act', '读取', { s: 'y' }, 'prompt\n多行\n三行'); // start 未 done
      const runDir = log.getRunDir();

      const b = HopLog.resume(runDir);
      b.recordStepStart('4.1', 'act', '读取', { s: 'y' }, 'prompt\n多行\n三行'); // resume#1 → resumed_at
      // 进程 B 未 done 又退
      const c = HopLog.resume(runDir);
      c.recordStepStart('4.1', 'act', '读取', { s: 'y' }, 'prompt\n多行\n三行'); // resume#2 → 应跳过（已写过）
      c.recordStepDone('4.1', { content: 'x' });
      c.recordStepDone('4', { done: true }); c.close('completed');

      const content = readFileSync(join(runDir, 'main.yaml'), 'utf-8');
      // YAMLL 逐块合法（4.1 的 start/resumed/done 各成块，块头重复合法）
      expectYamllValid(content);
      // 全文 resumed_at 出现次数 = 1（同 step 多次 resume 去重，只标一次）
      expect((content.match(/resumed_at:/g) || []).length).toBe(1);
    });
  });

  // @v: anc-obs-execution-log-absorption
  describe('event-level logging (engine integration)', () => {
    it('engine getExecEvents returns in-memory events with logDir', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { logDir: tmpDir, params: { data: 'd' } });

      const step1 = engine.nextStep();
      if (step1.status !== 'step_ready') return;
      engine.completeStep(step1.step_id, { mid: 'v' });

      const events = engine.getExecEvents();
      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.event === 'step_start')).toBe(true);
      expect(events.some(e => e.event === 'step_done')).toBe(true);
    });

    it('engine getExecEvents works without logDir', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { params: { data: 'd' } });

      const step1 = engine.nextStep();
      if (step1.status !== 'step_ready') return;
      engine.completeStep(step1.step_id, { mid: 'v' });

      const events = engine.getExecEvents();
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].step_id).toBe('1');
    });

    it('step records are streamed to main.yaml as they happen', () => {
      const engine = new ExecutionEngine();
      engine.initExecution(TWO_STEP_SPEC, MINIMAL_HOST_CONFIG, { logDir: tmpDir, params: { data: 'd' } });

      const step1 = engine.nextStep();
      if (step1.status !== 'step_ready') return;
      engine.completeStep(step1.step_id, { mid: 'v' });

      // Step 1 record already present in file before run finishes
      let dirs = readdirSync(tmpDir);
      let mainYaml = readFileSync(join(tmpDir, dirs[0], 'main.yaml'), 'utf-8');
      expect(mainYaml).toContain('type: reason');
      expect(mainYaml).toContain('status: completed');
      expect(mainYaml).not.toContain('type: act');

      const step2 = engine.nextStep();
      if (step2.status !== 'step_ready') return;
      engine.completeStep(step2.step_id, { result: 'r' });

      engine.nextStep(); // completes

      mainYaml = readFileSync(join(tmpDir, dirs[0], 'main.yaml'), 'utf-8');
      expect(mainYaml).toContain('type: act');
      expect(mainYaml).toContain('summary: Transform');
    });
  });

  // 旧通道 parallel hoplog 结构测试已删（P0.5：fanout/join 块随 nextParallelBatch/joinParallel
  // 退役；统一通道父侧 dispatch 块沿用 recordParallelDispatch，P1 补收割/收齐事件块专测）。
  // 旧通道 parallel hoplog 结构测试已删（P0.5：fanout/join 块随 nextParallelBatch/joinParallel
  // 退役；统一通道父侧 dispatch 块沿用 recordParallelDispatch，P1 补收割/收齐事件块专测）。
  // @v: anc-obs-parallel-child-satellite, anc-obs-nested-tree —— 卫星日志约定未变（子实例 log 归子目录）

});

// ===== P1 reap:/settle: 流式块（G11 收割段观测）=====
// @v: anc-obs-parallel-reap, anc-exec-parallel-reap-log
describe('P1 parallel reap/settle 块', () => {
  it('正例：收割逐条 reap 块（含 failed）+ 容器终态化 settle 块，dispatch→reap→settle 时序在轨', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hoplog-reap-'));
    const log = new HopLog({ specId: 't', logDir: tmp, title: 'T', goal: 'G' });
    log.recordStepStart('1', 'loop', '循环');
    log.recordParallelDispatch('1', '1.1.1', '/log/a');
    log.recordParallelDispatch('1', '1.1.2', '/log/b');
    log.recordParallelReap('1', '1.1.1', 'completed');
    log.recordParallelReap('1', '1.1.2', 'failed');
    log.recordParallelSettle('1');
    log.close('completed');
    const text = readFileSync(join(log.getRunDir(), 'main.yaml'), 'utf-8');
    expect((text.match(/dispatch:/g) ?? []).length).toBe(2);
    expect((text.match(/reap:/g) ?? []).length).toBe(2);
    expect(text).toContain('status: failed');       // 失败收割如实入轨
    expect((text.match(/settle:/g) ?? []).length).toBe(1);
    // 时序：最后一个 dispatch 在第一个 reap 之前、settle 在最后一个 reap 之后
    expect(text.lastIndexOf('dispatch:')).toBeLessThan(text.indexOf('reap:'));
    expect(text.lastIndexOf('reap:')).toBeLessThan(text.indexOf('settle:'));
    // 注：YAMLL 块头重复是格式约定（dispatch/reap 各自成块,块间重复合法——见
    // ^anc-obs-parallel-dispatch）,标准 YAML loadAll 会拒 duplicated key,不作全文解析断言。
  });

  it('反例：无 parallel 的 run 不出现 reap/settle 块（零误记）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hoplog-noreap-'));
    const log = new HopLog({ specId: 't2', logDir: tmp, title: 'T', goal: 'G' });
    log.recordStepStart('1', 'act', '普通步');
    log.recordStepDone('1', { x: 1 });
    log.close('completed');
    const text = readFileSync(join(log.getRunDir(), 'main.yaml'), 'utf-8');
    expect(text).not.toContain('reap:');
    expect(text).not.toContain('settle:');
  });
});

// toYaml 块标量 chomping 保真（review fuzz 抓:恒 | 使无尾换行值读回多一个 \n——12/21 病态样本中;
// 解析合法性零失败,病在保真。按值真实结尾选 |-(无尾换行)/|(恰一尾换行)）
// @v: anc-obs-hoplog-flush
describe('toYaml 多行字符串保真', () => {
  it('正例：无尾换行值 |- 读回逐字节同;尾换行值 | 保一个;反例守卫:回退形态(首行带空白)JSON 单行仍逐字节同', async () => {
    const { toYaml } = await import('../src/hoplog.js');
    const { load } = await import('js-yaml');
    const roundtrip = (v: string) => (load('v: ' + toYaml(v, 0) + '\n') as { v: string }).v;
    expect(roundtrip('a\nb')).toBe('a\nb');            // 无尾换行——|- strip
    expect(roundtrip('x\n')).toBe('x\n');              // 恰一尾换行——| clip
    expect(roundtrip('colon: here\nnext')).toBe('colon: here\nnext');
    expect(roundtrip('key:\n  nested: yaml\nend')).toBe('key:\n  nested: yaml\nend');
    expect(roundtrip('  lead\nnext')).toBe('  lead\nnext');   // 回退 JSON 形态照旧保真
    expect(roundtrip('x\n\n\n')).toBe('x\n');          // 多尾换行归一到一个（观测值语义无损,如实记档）
  });
});

// @v: anc-exec-thinking-exhausted —— recordRuminationSuspect 文档级留档（hopissues/0060 二批:
// 首批经 recordStepMeta('') 被孤儿守卫拒收静默失效——本组直接钉"未 start 任何步骤照样落块"
// 与"密钥抹除但不截断"两个关键行为）
describe('recordRuminationSuspect 疑似反刍留档', () => {
  it('正例：未 start 任何步骤时调用照样落块（文档级顶层块,不过孤儿守卫——首批病根的直接钉）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rum-log-'));
    const log = new HopLog({ specId: 't', logDir: dir, goal: 'g', inputs: {} });
    log.recordRuminationSuspect('parseStepOutput', 32768, '正文空,响应全文:\n循环内容');
    const content = readFileSync(log.getFilePath(), 'utf-8');
    expect(content).toContain('rumination_suspect:');
    expect(content).toContain('parseStepOutput');
    expect(content).not.toContain('ERROR: orphan');
  });

  it('反例：outputTokens 为 ? 回退值时整档仍可解析（review C1-1——裸插值曾写出 YAML 保留指示符破坏整档）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rum-log-'));
    const log = new HopLog({ specId: 't', logDir: dir, goal: 'g', inputs: {} });
    log.recordRuminationSuspect('parseStepOutput', '?', '正文空');
    const content = readFileSync(log.getFilePath(), 'utf-8');
    expect(content).toContain('output_tokens: "?"');   // 引号包裹——toYaml 处理保留指示符,整档不再被裸 ? 破坏
  });

  it('反例：content 含 sk- 密钥被抹,但超 200 字长文不被截断（sanitizeFull 通道——截断=白留）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rum-log-'));
    const log = new HopLog({ specId: 't', logDir: dir, goal: 'g', inputs: {} });
    const long = 'sk-' + 'a'.repeat(30) + ' 前缀密钥后面跟着长文' + '内容块'.repeat(200) + '结尾标记词';
    log.recordRuminationSuspect('replan-pipeline', 65536, long);
    const content = readFileSync(log.getFilePath(), 'utf-8');
    expect(content).toContain('sk-***');
    expect(content).not.toContain('sk-' + 'a'.repeat(30));
    expect(content).toContain('结尾标记词');   // 不截断——尾部仍在
    expect(content).not.toContain('[TRUNCATED]');
  });
});

// trace_id 继承（0088 批⑬钉A——hoplog 侧测试面,0086 半边一挂账:header 写入点
// hoplog.ts `trace_id: options.traceId ?? runId` 无直钉,?? 兜底被改坏无测试拦）
// @v: anc-obs-trace-inherit
describe('trace_id 落轨（HopLog header）', () => {
  it('正例：options.traceId 在场 → header trace_id=传入值（worker/call 子实例继承父 instance_id 的载体）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-a-'));
    const log = new HopLog({ specId: 't', logDir: dir, title: 'T', goal: 'G', traceId: 'parent-instance-uuid-42' });
    const head = readFileSync(log.getFilePath(), 'utf-8');
    expect(head).toMatch(/^trace_id: parent-instance-uuid-42$/m);
  });

  it('正例：不带 traceId → 回落本 run 的 run_id（防御性保证 header 恒有 trace_id;顶层直构 HopLog 场景）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-b-'));
    const log = new HopLog({ specId: 't', logDir: dir, title: 'T', goal: 'G' });
    const head = readFileSync(log.getFilePath(), 'utf-8');
    const runId = head.match(/^run_id: (.+)$/m)?.[1];
    expect(runId).toBeTruthy();
    expect(head).toContain(`trace_id: ${runId}`);
  });
});
