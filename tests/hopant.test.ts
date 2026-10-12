// @module: hopant ^anc-struct-hopant
// hopant 模块专属测试：目录布局、安装（全或无、本机面丢弃）、索引、配置适配四项、适配戳、卸载、错误码。
// 临时 home 用 mkdtempSync,不碰真实用户目录;CLI 子进程用例注入 HOME。设计 docs/design/hopant.md。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  antsRoot, antRoots, antDir, indexPath, listAnts, listAntsIn, resolveAnt, rebuildIndex,
  detectSource, planInstall, applyInstall, removeAnt,
  ownerId, headerHash, readStamp, writeStamp, needsAdapt, backupOrig, adapt, adaptState,
  resolveCalleeSpecPath, checkRunDeps, commitApprovalStorePath, dirsApprovalStorePath,
  isLocalFace, collectBodyUsage, reconcileHeader, packAnt, scanCredentials, shareAnts, CREDENTIAL_SCAN_DISCLAIMER,
  type AdaptEnv, type AdaptStamp, type AntRoots,
} from '../src/hopant.js';
import { parseSpec } from '../src/parser.js';
import { parseToolServers, loadTwoLevelRegistry } from '../src/tools-registry.js';
import { antInstall, type AdminContext } from '../src/hop-admin.js';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

function tmp(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }

/** 只关心用户级的用例：项目根指向一个空临时目录（项目级恒为空,查找自然落到用户级）*/
function userOnlyRoots(home: string): AntRoots { return antRoots(home, tmp('hopant-proj-empty-')); }

const SPEC = (id: string, extra = '') => `# Spec: ${id} 标题
Id: ${id}
Goal: ${id} 的目标第一行
第二行不该进索引
${extra}
## Outputs
- out % text  # 结果

## Steps
1. [act free] 干活
  + → out % text  # 结果
`;

/** 造一个单 HopAnt 来源目录 */
function makeAnt(parent: string, id: string, opts: { extra?: string; bootstrap?: boolean; local?: boolean; specBody?: string } = {}): string {
  const dir = join(parent, id);
  mkdirSync(join(dir, 'knowledge'), { recursive: true });
  writeFileSync(join(dir, `${id}.md`), opts.specBody ?? SPEC(id, opts.extra ?? ''), 'utf-8');
  writeFileSync(join(dir, 'knowledge', 'glossary.md'), '# 术语\n', 'utf-8');
  if (opts.bootstrap) writeFileSync(join(dir, 'bootstrap.js'), 'console.log(process.argv.includes("--dry-run") ? "plan: nothing" : "installed");\n', 'utf-8');
  if (opts.local) {
    mkdirSync(join(dir, 'inner_store'), { recursive: true });
    writeFileSync(join(dir, 'inner_store', 'adapt.yaml'), 'owner: other-host\nhash: x\n', 'utf-8');
    writeFileSync(join(dir, `${id}.orig.md`), 'orig', 'utf-8');
  }
  return dir;
}

describe('hopant：路径约定与索引（^anc-hopant-home / ^anc-hopant-index）', () => {
  it('正：antsRoot/antDir/indexPath 落在 <home>/.hopjit/ants 下;合法 id 不抛', () => { // @v: anc-hopant-home, anc-hopant-errors
    const home = tmp('hopant-home-');
    const root = antsRoot(home);
    expect(root).toBe(join(home, '.hopjit', 'ants'));
    expect(antDir(root, 'pdf-ocr')).toBe(join(home, '.hopjit', 'ants', 'pdf-ocr'));
    expect(indexPath(root)).toBe(join(home, '.hopjit', 'ants', 'index.md'));
    for (const good of ['a', 'pdf-ocr', 'x_1.2', '0abc']) expect(() => antDir(root, good)).not.toThrow();
  });

  it('反：id 含路径分隔符 / .. / 大写 / 空 → HOPANT_BAD_ID', () => { // @v: anc-hopant-home, anc-hopant-errors
    const root = antsRoot(tmp('hopant-home-'));
    for (const bad of ['a/b', '..', 'x..y', 'Upper', '', 'a\\b']) {
      expect(() => antDir(root, bad)).toThrow(/HOPANT_BAD_ID/);
    }
  });

  it('正：listAntsIn 只算含入口 spec 的子目录,升序;没装过返回空', () => { // @v: anc-hopant-home
    const home = tmp('hopant-home-');
    const root = antsRoot(home);
    expect(listAntsIn(root)).toEqual([]);
    mkdirSync(join(root, 'zeta'), { recursive: true });
    writeFileSync(join(root, 'zeta', 'zeta.md'), SPEC('zeta'), 'utf-8');
    mkdirSync(join(root, 'alpha'), { recursive: true });
    writeFileSync(join(root, 'alpha', 'alpha.md'), SPEC('alpha'), 'utf-8');
    mkdirSync(join(root, 'broken-no-entry'), { recursive: true });   // 半拷贝残留,不算
    expect(listAntsIn(root)).toEqual(['alpha', 'zeta']);
    // 升序是契约（设计 :87）。本机 APFS 的 readdirSync 对任何名字集都已按 JS 字典序返回（实测 ['10','9','Zed','_u','alpha','ä-ant',…] 两序完全一致）,
    // 所以在 macOS 上删掉 .sort() 是等价变异,任何 fixture 都拦不住——这不是无保护,是本平台无法观测;ext4/NTFS 上 readdir 不保证顺序,断言在那边才有区分力。
    for (const n of ['z-ant', 'ä-ant', 'b-ant', 'Zed', '_u', '10', '9']) { mkdirSync(join(root, n), { recursive: true }); writeFileSync(join(root, n, `${n}.md`), SPEC(n), 'utf-8'); }
    const got = listAntsIn(root);
    expect(got).toEqual([...got].sort());
    expect(got).toEqual(['10', '9', 'Zed', '_u', 'alpha', 'b-ant', 'z-ant', 'zeta', 'ä-ant']);
    // 两级合并 listAnts：项目级空时只剩用户级条目,每条带 scope 与 dir
    expect(listAnts(userOnlyRoots(home)).map(e => [e.id, e.scope])).toEqual(got.map(id => [id, 'user']));
  });

  it('正/反：rebuildIndex 三段格式 `- id — 标题 — Goal 首行`（正）;解析失败的条目写占位不中断、第二行不进索引（反）', () => { // @v: anc-hopant-index
    const root = antsRoot(tmp('hopant-home-'));
    mkdirSync(join(root, 'good'), { recursive: true });
    writeFileSync(join(root, 'good', 'good.md'), SPEC('good'), 'utf-8');
    mkdirSync(join(root, 'bad'), { recursive: true });
    writeFileSync(join(root, 'bad', 'bad.md'), '# Spec: bad\n## Steps\n1. [bogus] x\n', 'utf-8');
    const n = rebuildIndex(root);
    expect(n).toBe(2);
    const text = readFileSync(indexPath(root), 'utf-8');
    expect(text.split('\n')[0]).toContain('HopAnt 索引');
    expect(text).toContain('- good — good 标题 — good 的目标第一行');
    expect(text).not.toContain('第二行不该进索引');
    expect(text).toContain('- bad — （入口 spec 解析失败）');
    // Goal 缺席写（无 Goal）（变异 l）
    mkdirSync(join(root, 'nogoal'), { recursive: true });
    writeFileSync(join(root, 'nogoal', 'nogoal.md'), '# Spec: 无目标\n## Outputs\n- o % text  # x\n## Steps\n1. [act free] a\n  + → o % text  # x\n', 'utf-8');
    rebuildIndex(root);
    expect(readFileSync(indexPath(root), 'utf-8')).toContain('- nogoal — 无目标 — （无 Goal）');
  });
});

describe('hopant：来源识别与安装（^anc-hopant-install）', () => {
  it('正：单 ant 目录 → single;包根（ants/<id>/）→ package;都不是 → invalid', () => { // @v: anc-hopant-install
    const src = tmp('hopant-src-');
    const single = makeAnt(src, 'solo');
    expect(detectSource(single).kind).toBe('single');
    const pkg = join(src, 'pkg'); mkdirSync(join(pkg, 'ants'), { recursive: true });
    makeAnt(join(pkg, 'ants'), 'a1'); makeAnt(join(pkg, 'ants'), 'a2');
    writeFileSync(join(pkg, 'package.json'), '{"name":"pkg","version":"0.1.0"}', 'utf-8');
    const d = detectSource(pkg);
    expect(d.kind).toBe('package');
    expect(d.antDirs.map(p => p.split('/').pop())).toEqual(['a1', 'a2']);
    const empty = join(src, 'empty'); mkdirSync(empty);
    expect(detectSource(empty).kind).toBe('invalid');
    // 两形态同时满足按 package（变异 f：分支对调本例红）
    const both = makeAnt(src, 'both'); mkdirSync(join(both, 'ants'), { recursive: true }); makeAnt(join(both, 'ants'), 'inner');
    const db = detectSource(both);
    expect(db.kind).toBe('package');
    expect(db.antDirs.map(p => p.split('/').pop())).toEqual(['inner']);
  });

  it('正：单 ant 安装落到 <home>/.hopjit/ants/<id>/,建 inner_store/,重建索引', () => { // @v: anc-hopant-install, anc-hopant-index
    const home = tmp('hopant-home-'); const root = antsRoot(home); const src = tmp('hopant-src-');
    const plan = planInstall(makeAnt(src, 'solo'), root);
    expect(plan.source_kind).toBe('single');
    expect(plan.ok).toBe(true);
    const r = applyInstall(plan);
    expect(r.installed).toEqual(['solo']);
    expect(existsSync(join(antDir(root, 'solo'), 'solo.md'))).toBe(true);
    expect(existsSync(join(antDir(root, 'solo'), 'knowledge', 'glossary.md'))).toBe(true);
    expect(existsSync(join(antDir(root, 'solo'), 'inner_store'))).toBe(true);
    expect(readFileSync(indexPath(root), 'utf-8')).toContain('- solo — solo 标题');
  });

  it('正：包安装一次装多个;bootstrap_pending 只列带 bootstrap.js 的', () => { // @v: anc-hopant-install
    const home = tmp('hopant-home-'); const root = antsRoot(home); const src = tmp('hopant-src-');
    const pkg = join(src, 'pkg'); mkdirSync(join(pkg, 'ants'), { recursive: true });
    makeAnt(join(pkg, 'ants'), 'with-boot', { bootstrap: true }); makeAnt(join(pkg, 'ants'), 'plain');
    const r = applyInstall(planInstall(pkg, root));
    expect(r.installed).toEqual(['plain', 'with-boot']);
    expect(r.bootstrap_pending).toEqual(['with-boot']);
    expect(listAntsIn(root)).toEqual(['plain', 'with-boot']);
  });

  it('反：来源里的 inner_store/ 与 *.orig.md 不进来,skipped_local_files 列出', () => { // @v: anc-hopant-install
    const home = tmp('hopant-home-'); const root = antsRoot(home); const src = tmp('hopant-src-');
    const r = applyInstall(planInstall(makeAnt(src, 'dirty', { local: true }), root));
    const dst = antDir(root, 'dirty');
    expect(existsSync(join(dst, 'inner_store', 'adapt.yaml'))).toBe(false);   // 别人的戳没进来
    expect(existsSync(join(dst, 'inner_store'))).toBe(true);                   // 但空目录建了
    expect(existsSync(join(dst, 'dirty.orig.md'))).toBe(false);
    expect(r.skipped_local_files.sort()).toEqual(['dirty/dirty.orig.md', 'dirty/inner_store']);
  });

  it('反：撞 id 整单拒 HOPANT_ID_CONFLICT,包里没撞的那个也不装', () => { // @v: anc-hopant-install, anc-hopant-errors
    const home = tmp('hopant-home-'); const root = antsRoot(home); const src = tmp('hopant-src-');
    applyInstall(planInstall(makeAnt(src, 'taken'), root));
    const pkg = join(src, 'pkg'); mkdirSync(join(pkg, 'ants'), { recursive: true });
    makeAnt(join(pkg, 'ants'), 'taken'); makeAnt(join(pkg, 'ants'), 'fresh');
    const plan = planInstall(pkg, root);
    expect(plan.ok).toBe(false);
    expect(plan.ants.find(a => a.id === 'taken')!.conflict).toBe(true);
    expect(() => applyInstall(plan)).toThrow(/HOPANT_ID_CONFLICT.*taken/);
    expect(existsSync(antDir(root, 'fresh'))).toBe(false);
    expect(listAntsIn(root)).toEqual(['taken']);
  });

  it('反：Id 字段与文件名不一致 → HOPANT_ID_MISMATCH;入口 spec 解析失败 → HOPANT_SPEC_INVALID;来源无效 → HOPANT_SOURCE_INVALID', () => { // @v: anc-hopant-install, anc-hopant-errors
    const home = tmp('hopant-home-'); const root = antsRoot(home); const src = tmp('hopant-src-');
    const mm = makeAnt(src, 'mismatch', { specBody: SPEC('other-id') });
    expect(() => planInstall(mm, root)).toThrow(/HOPANT_ID_MISMATCH.*other-id.*mismatch/);
    const bad = makeAnt(src, 'badspec', { specBody: '# Spec: x\n## Steps\n1. [bogus] a\n' });
    expect(() => planInstall(bad, root)).toThrow(/HOPANT_SPEC_INVALID/);
    const empty = join(src, 'nothing'); mkdirSync(empty);
    expect(() => planInstall(empty, root)).toThrow(/HOPANT_SOURCE_INVALID/);
    // 缺 Id 字段视为一致（变异 v：`h.id && h.id !== id` 去掉 `h.id &&` 本例红）
    const noid = makeAnt(src, 'noid', { specBody: SPEC('noid').replace('Id: noid\n', '') });
    expect(planInstall(noid, root).ants[0].id).toBe('noid');
    // 大写目录名 → BAD_ID（设计 :84 首字符与大写规则）
    const up = makeAnt(src, 'Upper');
    expect(() => planInstall(up, root)).toThrow(/HOPANT_BAD_ID/);
  });

  it('正/反：本机面只看 ant 根——深层 knowledge/inner_store/ 照拷（正）,深层 x.orig.md 任意深度都跳（反）', () => { // @v: anc-hopant-install
    const home = tmp('hopant-home-'); const root = antsRoot(home); const src = tmp('hopant-src-');
    const a = makeAnt(src, 'deep');
    mkdirSync(join(a, 'knowledge', 'inner_store'), { recursive: true });
    writeFileSync(join(a, 'knowledge', 'inner_store', 'x.yaml'), 'k: v', 'utf-8');
    writeFileSync(join(a, 'knowledge', 'foo.orig.md'), 'orig', 'utf-8');
    const r = applyInstall(planInstall(a, root));
    expect(existsSync(join(antDir(root, 'deep'), 'knowledge', 'inner_store', 'x.yaml'))).toBe(true);
    expect(existsSync(join(antDir(root, 'deep'), 'knowledge', 'foo.orig.md'))).toBe(false);
    expect(r.skipped_local_files).toEqual(['deep/knowledge/foo.orig.md']);
  });

  it('正/反：removeAnt 删目录并重建索引;keepStore 把 inner_store 挪到备份位;不存在返回 null', () => { // @v: anc-hopant-install
    const home = tmp('hopant-home-'); const root = antsRoot(home); const src = tmp('hopant-src-');
    const roots = userOnlyRoots(home);
    applyInstall(planInstall(makeAnt(src, 'a'), root));
    applyInstall(planInstall(makeAnt(src, 'b'), root));
    writeFileSync(join(antDir(root, 'b'), 'inner_store', 'data.txt'), 'keep me', 'utf-8');
    expect(removeAnt(roots, 'a', false)).toBe('user');
    expect(existsSync(antDir(root, 'a'))).toBe(false);
    expect(readFileSync(indexPath(root), 'utf-8')).not.toContain('- a —');
    expect(removeAnt(roots, 'b', true)).toBe('user');
    expect(readFileSync(join(home, '.hopjit', 'ants-store-backup', 'b', 'data.txt'), 'utf-8')).toBe('keep me');
    expect(removeAnt(roots, 'ghost', false)).toBeNull();
    // 已有同名备份先删旧（变异 k：删那行则 rename 撞目录抛错或旧文件残留——本例红）
    applyInstall(planInstall(makeAnt(src, 'b'), root));
    writeFileSync(join(antDir(root, 'b'), 'inner_store', 'new.txt'), 'second', 'utf-8');
    expect(removeAnt(roots, 'b', true)).toBe('user');
    expect(existsSync(join(home, '.hopjit', 'ants-store-backup', 'b', 'data.txt'))).toBe(false);
    expect(readFileSync(join(home, '.hopjit', 'ants-store-backup', 'b', 'new.txt'), 'utf-8')).toBe('second');
  });
});

describe('hopant：适配戳（^anc-hopant-stamp）', () => {
  it('正：ownerId 优先 git 用户名,其次登录名,空格与斜杠换连字符', () => { // @v: anc-hopant-stamp
    expect(ownerId('Lenx Wei', 'lenx', 'mbp.local')).toBe('Lenx-Wei-mbp.local');
    expect(ownerId('team/alpha\\x', '', 'host')).toBe('team-alpha-x-host');   // 变异 u：不换斜杠本例红
    expect(ownerId('', 'lenx', 'host')).toBe('lenx-host');
    expect(ownerId('', '', '')).toBe('user-host');
  });

  it('正/反：headerHash 只覆盖 Tools / 已批准命令 / Config 三段——改 Steps 不变,改三段任一都变', () => { // @v: anc-hopant-stamp
    const base = SPEC('h', '## Tools\n- web_search(query) -> r % yaml  # 搜\n  - query % text  # 词\n\n## 已批准命令\n- git status\n\n## Config\n- engine_min_version: 0.10.0\n');
    const h1 = headerHash(base);
    expect(h1).toMatch(/^[0-9a-f]{12}$/);
    expect(headerHash(base.replace('干活', '干别的活'))).toBe(h1);
    expect(headerHash(base.replace('git status', 'git push'))).not.toBe(h1);
    expect(headerHash(base.replace('web_search', 'bing_search'))).not.toBe(h1);
    expect(headerHash(base.replace('0.10.0', '0.11.0'))).not.toBe(h1);   // 变异 e：Config 段不进哈希本例红
  });

  it('反：headerHash 认 parser 认的全部段头形——中文 `## 工具`/`## 配置`、英文 `## Approved Commands`、内联 `Tools:`,改了都变（v0.1.0 自写正则下不变）', () => { // @v: anc-hopant-stamp
    const zh = SPEC('h', '## 工具\n- web_search(query) -> r % yaml  # 搜\n  - query % text  # 词\n\n## 已批准命令\n- git status\n\n## 配置\n- engine_min_version: 0.10.0\n');
    expect(headerHash(zh.replace('web_search', 'bing_search'))).not.toBe(headerHash(zh));
    expect(headerHash(zh.replace('0.10.0', '0.11.0'))).not.toBe(headerHash(zh));
    const en = SPEC('h', '## Tools\n- web_search(query) -> r % yaml  # 搜\n  - query % text  # 词\n\n## Approved Commands\n- git status\n');
    expect(headerHash(en.replace('git status', 'git push'))).not.toBe(headerHash(en));   // 变异 p
    const inline = SPEC('h', 'Tools:\n- web_search(query) -> r % yaml  # 搜\n  - query % text  # 词\n');
    expect(headerHash(inline.replace('web_search', 'bing_search'))).not.toBe(headerHash(inline));
  });

  it('正：writeStamp/readStamp 往返;坏文件与缺文件读回 null', () => { // @v: anc-hopant-stamp
    const dir = tmp('hopant-ant-');
    expect(readStamp(dir)).toBeNull();
    const stamp: AdaptStamp = { adapted: 'u-h @ abc', owner: 'u-h', hash: 'abc', at: '2026-10-06T00:00:00Z',
      report: { ok: true, tools: { missing: [], errors: [], warnings: [] }, credentials: { required: [], missing: [] }, commands: { required: [], missing: [] }, engine: { required: null, current: '0.19.1', ok: true }, hints: [] } };
    const p = writeStamp(dir, stamp);
    expect(p).toBe(join(dir, 'inner_store', 'adapt.yaml'));
    expect(readStamp(dir)).toEqual(stamp);
    writeFileSync(p, ': not yaml: [', 'utf-8');
    expect(readStamp(dir)).toBeNull();
    writeFileSync(p, 'adapted: x\nat: now\n', 'utf-8');   // 合法 YAML 但缺 owner/hash（变异 t：删形状校验本例红）
    expect(readStamp(dir)).toBeNull();
  });

  it('正/反：adaptState 三态——无戳 never / 戳在哈希不符 stale / 全同 adapted / 入口 spec 读不出按 stale', () => { // @v: anc-hopant-stamp
    const dir = makeAnt(tmp('hopant-src-'), 'st');
    expect(adaptState(dir, 'u-h')).toBe('never');
    const hash = headerHash(readFileSync(join(dir, 'st.md'), 'utf-8'));
    const rep = { ok: true, tools: { missing: [], errors: [], warnings: [] }, credentials: { required: [], missing: [] }, commands: { required: [], missing: [] }, engine: { required: null, current: null, ok: true }, hints: [] };
    writeStamp(dir, { adapted: `u-h @ ${hash}`, owner: 'u-h', hash, at: 'now', report: rep });
    expect(adaptState(dir, 'u-h')).toBe('adapted');
    expect(adaptState(dir, 'other-h')).toBe('stale');   // 变异 s（CLI 恒 adapted）由 CLI 组覆盖,本例锁模块侧
    writeFileSync(join(dir, 'st.md'), '# Spec: x\n## Tools\n- changed(q) -> r % text  # x\n  - q % text  # x\n## Steps\n1. [act free] a\n  + → r % text  # x\n', 'utf-8');
    expect(adaptState(dir, 'u-h')).toBe('stale');
  });

  it('正/反：needsAdapt——无戳/分支不同/哈希不同三种为真,全同为假', () => { // @v: anc-hopant-stamp
    const s = { owner: 'u-h', hash: 'abc' } as AdaptStamp;
    expect(needsAdapt(null, 'u-h', 'abc')).toBe(true);
    expect(needsAdapt(s, 'other-h', 'abc')).toBe(true);
    expect(needsAdapt(s, 'u-h', 'zzz')).toBe(true);
    expect(needsAdapt(s, 'u-h', 'abc')).toBe(false);
  });

  it('正/反：backupOrig 首次拷出 .orig.md 返回 true,再次不覆盖返回 false', () => { // @v: anc-hopant-adapt
    const src = tmp('hopant-src-');
    const dir = makeAnt(src, 'bk');
    expect(backupOrig(dir)).toBe(true);
    expect(readFileSync(join(dir, 'bk.orig.md'), 'utf-8')).toBe(SPEC('bk'));
    writeFileSync(join(dir, 'bk.md'), 'changed', 'utf-8');
    expect(backupOrig(dir)).toBe(false);
    expect(readFileSync(join(dir, 'bk.orig.md'), 'utf-8')).toBe(SPEC('bk'));
  });
});

describe('hopant：配置适配四项（^anc-hopant-adapt）', () => {
  const REG = parseToolServers([{
    name: 'search',
    binding: { kind: 'mcp', transport: 'http', url: 'http://x', auth_env: 'SEARCH_KEY' },
    tools: [{ name: 'my_search', requires_commit: false, input_schema: { type: 'object', properties: { query: { type: 'string' } } } }],
  }], '/');
  const SPEC_WITH = SPEC('ad', '## Tools\n- my_search(query) -> r % yaml  # 搜\n  - query % text  # 词\n\n## 已批准命令\n- mytool --flag\n\n## Config\n- engine_min_version: 0.10.0\n');

  function envOf(over: Partial<AdaptEnv>, binDir: string): AdaptEnv {
    return { tool_servers: REG, providers: [{ api_key_env: 'MODEL_KEY' }], env_vars: { SEARCH_KEY: 'k', MODEL_KEY: 'm' }, path_dirs: [binDir], engine_version: '0.19.1', ...over };
  }
  function binWith(cmd: string): string {
    const d = tmp('hopant-bin-'); writeFileSync(join(d, cmd), '#!/bin/sh\n', 'utf-8'); chmodSync(join(d, cmd), 0o755); return d;
  }

  it('正：四项全在场 → ok,required 列全,hints 空', () => { // @v: anc-hopant-adapt
    const dir = makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC_WITH });
    const r = adapt(dir, envOf({}, binWith('mytool')));
    expect(r.ok).toBe(true);
    expect(r.tools.missing).toEqual([]);
    expect(r.credentials.required).toEqual(['MODEL_KEY', 'SEARCH_KEY']);
    expect(r.commands.required).toEqual(['mytool']);
    expect(r.engine).toEqual({ required: '0.10.0', current: '0.19.1', ok: true });
    expect(r.hints).toEqual([]);
  });

  it('反：工具未注册 → tools.missing 点名 + hint 指路注册;声明了注册面没有的参数 → tools.errors', () => { // @v: anc-hopant-adapt
    const dir = makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC_WITH });
    const r1 = adapt(dir, envOf({ tool_servers: [] }, binWith('mytool')));
    expect(r1.ok).toBe(false);
    expect(r1.tools.missing).toEqual(['my_search']);
    expect(r1.tools.errors).toEqual([]);   // 变异 q：缺的工具不再重复进 errors（missing 先算,不解析引擎文案）
    expect(r1.hints.filter(h => h.includes('my_search'))).toHaveLength(1);
    expect(r1.hints.some(h => h.includes("工具 'my_search' 未注册") && h.includes('tool_servers'))).toBe(true);
    const dir2 = makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC_WITH.replace('- my_search(query)', '- my_search(query, lang)').replace('  - query % text  # 词\n', '  - query % text  # 词\n  - lang % line  # 语言\n') });
    const r2 = adapt(dir2, envOf({}, binWith('mytool')));
    expect(r2.tools.missing).toEqual([]);
    expect(r2.tools.errors.some(e => e.includes('lang'))).toBe(true);
    expect(r2.ok).toBe(false);
  });

  it('正/反：标准工具 web_search 没注册不算缺口,只进 notes;同样没注册的非标准工具算缺口;已注册的标准工具参数照样对账', () => { // @v: anc-hopant-adapt
    const std = makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC('ad', '## Tools\n- web_search(query) -> r % yaml  # 搜\n  - query % text  # 词\n') });
    const r1 = adapt(std, envOf({ tool_servers: [] }, binWith('x')));
    expect(r1.ok).toBe(true);
    expect(r1.tools.missing).toEqual([]);
    expect(r1.tools.standard_unregistered).toEqual(['web_search']);
    expect(r1.tools.errors).toEqual([]);
    expect(r1.hints).toEqual([]);
    expect(r1.notes.some(n => n.includes('web_search 是标准工具') && n.includes('独立模式'))).toBe(true);
    const nonStd = makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC('ad', '## Tools\n- my_search(query) -> r % yaml  # 搜\n  - query % text  # 词\n') });
    const r2 = adapt(nonStd, envOf({ tool_servers: [] }, binWith('x')));
    expect(r2.ok).toBe(false);
    expect(r2.tools.missing).toEqual(['my_search']);
    expect(r2.tools.standard_unregistered).toEqual([]);
    expect(r2.notes).toEqual([]);
    const reg = parseToolServers([{ name: 'bs', binding: { kind: 'mcp', transport: 'http', url: 'http://x' },
      tools: [{ name: 'bailian_web_search', tool_id: 'web_search', requires_commit: false, input_schema: { type: 'object', properties: { query: { type: 'string' } } } }] }], '/');
    const badSig = makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC('ad', '## Tools\n- web_search(query, lang) -> r % yaml  # 搜\n  - query % text  # 词\n  - lang % line  # 语言\n') });
    const r3 = adapt(badSig, envOf({ tool_servers: reg }, binWith('x')));
    expect(r3.tools.standard_unregistered).toEqual([]);
    expect(r3.tools.errors.some(e => e.includes('lang'))).toBe(true);
    expect(r3.ok).toBe(false);
  });

  it('反：凭证环境变量缺或空白 → credentials.missing + export 提示;与 Tools 无关的 server 的 auth_env 不算', () => { // @v: anc-hopant-adapt
    const dir = makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC_WITH });
    const extra = parseToolServers([{ name: 'unrelated', binding: { kind: 'mcp', transport: 'http', url: 'http://y', auth_env: 'UNRELATED_KEY' }, tools: [{ name: 'other', requires_commit: false }] }], '/');
    const r = adapt(dir, envOf({ tool_servers: [...REG, ...extra], env_vars: { SEARCH_KEY: '   ', MODEL_KEY: 'm' } }, binWith('mytool')));
    expect(r.ok).toBe(false);
    expect(r.credentials.required).toEqual(['MODEL_KEY', 'SEARCH_KEY']);
    expect(r.credentials.missing).toEqual(['SEARCH_KEY']);
    expect(r.hints.some(h => h.includes('export SEARCH_KEY='))).toBe(true);
  });

  it('反：命令不在 PATH → commands.missing;带 bootstrap.js 的 hint 指路 ant bootstrap', () => { // @v: anc-hopant-adapt
    const dir = makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC_WITH, bootstrap: true });
    const r = adapt(dir, envOf({}, binWith('nottheone')));
    expect(r.ok).toBe(false);
    expect(r.commands.missing).toEqual(['mytool']);
    expect(r.hints.some(h => h.includes("命令 'mytool'") && h.includes('hopjit ant bootstrap ad --dry-run'))).toBe(true);
    // 首项带路径分隔符直接按该路径查可执行位,不扫 PATH（变异 o：删该分支本例红）
    const bin = binWith('abs-tool');
    const absSpec = SPEC_WITH.replace('- mytool --flag', `- ${join(bin, 'abs-tool')} --flag`);
    const dir2 = makeAnt(tmp('hopant-src-'), 'ad', { specBody: absSpec });
    expect(adapt(dir2, envOf({}, tmp('hopant-emptybin-'))).commands.missing).toEqual([]);
    // 凭证 undefined（不只是空白）也算缺
    const r3 = adapt(makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC_WITH }), envOf({ env_vars: { MODEL_KEY: 'm' } }, binWith('mytool')));
    expect(r3.credentials.missing).toEqual(['SEARCH_KEY']);
  });

  it('反：引擎版本低于 engine_min_version → engine.ok false + 升级提示;spec 不声明 → 恒 ok', () => { // @v: anc-hopant-adapt
    const dir = makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC_WITH });
    const r = adapt(dir, envOf({ engine_version: '0.9.9' }, binWith('mytool')));
    expect(r.engine).toEqual({ required: '0.10.0', current: '0.9.9', ok: false });
    expect(r.ok).toBe(false);
    expect(r.hints.some(h => h.includes('@hoplogic/hopjit@latest'))).toBe(true);
    const plain = makeAnt(tmp('hopant-src-'), 'ad');
    expect(adapt(plain, envOf({ engine_version: '0.0.1' }, binWith('x'))).engine.ok).toBe(true);
    // 版本取不到（null）fail-open;patch 位参与比较（变异 g2）;非 semver 串按缺席不拦（变异 g3）
    const d2 = makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC_WITH });
    expect(adapt(d2, envOf({ engine_version: null }, binWith('mytool'))).engine).toEqual({ required: '0.10.0', current: null, ok: true });
    const d3 = makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC_WITH.replace('0.10.0', '0.19.2') });
    expect(adapt(d3, envOf({ engine_version: '0.19.1' }, binWith('mytool'))).engine.ok).toBe(false);
    const d4 = makeAnt(tmp('hopant-src-'), 'ad', { specBody: SPEC_WITH.replace('0.10.0', 'latest') });
    expect(adapt(d4, envOf({ engine_version: '0.0.1' }, binWith('mytool'))).engine.ok).toBe(true);
  });
});

describe('hopant：两级注册面读取 loadTwoLevelRegistry（tools-registry 出口,hopjit ant adapt 消费）', () => {
  const SYS = `providers:\n  - service_id: sys\n    protocol: anthropic\n    base_url: http://x\n    model: m\n    api_key_env: SYS_KEY\ntool_servers:\n  - name: search\n    binding: { kind: mcp, transport: http, url: http://s, auth_env: S1 }\n    tools:\n      - { name: web_search, requires_commit: false }\n`;
  const PROJ = `providers:\n  - service_id: SYS\n    protocol: anthropic\n    base_url: http://y\n    model: m2\n    api_key_env: PROJ_KEY\ntool_servers:\n  - name: search\n    binding: { kind: mcp, transport: http, url: http://p, auth_env: P1 }\n    tools:\n      - { name: web_search, requires_commit: false }\n  - name: extra\n    binding: { kind: mcp, transport: http, url: http://e }\n    tools:\n      - { name: other, requires_commit: false }\n`;
  const write = (dir: string, name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text, 'utf-8'); return p; };

  it('正：项目级按 name / service_id（大写比）赢,系统级独有的保留（变异 h：改成系统级赢本例红）', () => { // @v: anc-config-tool-registry
    const d = tmp('hopant-cfg-');
    const r = loadTwoLevelRegistry(write(d, 'sys.yaml', SYS), write(d, 'proj.yaml', PROJ));
    expect(r.tool_servers.map(t => t.name).sort()).toEqual(['extra', 'search']);
    expect(r.tool_servers.find(t => t.name === 'search')!.binding.auth_env).toBe('P1');
    expect(r.providers).toHaveLength(1);
    expect(r.providers[0].api_key_env).toBe('PROJ_KEY');
  });

  it('正：缺席 / 空文件 / 纯注释都按无配置,不抛', () => { // @v: anc-config-tool-registry
    const d = tmp('hopant-cfg-');
    expect(loadTwoLevelRegistry(null, null)).toEqual({ tool_servers: [], providers: [] });
    expect(loadTwoLevelRegistry(join(d, 'nope.yaml'), write(d, 'empty.yaml', ''))).toEqual({ tool_servers: [], providers: [] });
    expect(loadTwoLevelRegistry(write(d, 'c.yaml', '# only comments\n\n# more\n'), null)).toEqual({ tool_servers: [], providers: [] });
  });

  it('反：顶层不是 YAML 映射 / providers 不是列表 → TOOLS_FILE_INVALID 响亮拒,不静默按空', () => { // @v: anc-config-tool-registry
    const d = tmp('hopant-cfg-');
    expect(() => loadTwoLevelRegistry(write(d, 'list.yaml', '- just\n- a list\n'), null)).toThrow(/TOOLS_FILE_INVALID.*不是 YAML 映射/);
    expect(() => loadTwoLevelRegistry(null, write(d, 'p.yaml', 'providers: notalist\n'))).toThrow(/TOOLS_FILE_INVALID.*providers 须为列表/);
  });
});

describe('hopant：call 目标两级解析 resolveCalleeSpecPath（^anc-hopant-callee-resolve）', () => {
  it('正：同目录优先;同目录没有再找 <antsRoot>/<id>/<id>.md', () => { // @v: anc-hopant-callee-resolve
    const caller = tmp('hopant-caller-'); const home = tmp('hopant-home-');
    const roots = userOnlyRoots(home); const root = roots.user;
    mkdirSync(join(root, 'both'), { recursive: true }); writeFileSync(join(root, 'both', 'both.md'), SPEC('both'), 'utf-8');
    mkdirSync(join(root, 'only-ant'), { recursive: true }); writeFileSync(join(root, 'only-ant', 'only-ant.md'), SPEC('only-ant'), 'utf-8');
    writeFileSync(join(caller, 'both.md'), SPEC('both'), 'utf-8');
    expect(resolveCalleeSpecPath(caller, roots, 'both')).toBe(join(caller, 'both.md'));
    expect(resolveCalleeSpecPath(caller, roots, 'only-ant')).toBe(join(root, 'only-ant', 'only-ant.md'));
  });

  it('反：三处都没有 → null;roots 为 null 只查同目录;id 含 / \\ .. 或为空 → null 不碰盘', () => { // @v: anc-hopant-callee-resolve
    const caller = tmp('hopant-caller-'); const home = tmp('hopant-home-');
    const roots = userOnlyRoots(home); const root = roots.user;
    mkdirSync(join(root, 'ant-x'), { recursive: true }); writeFileSync(join(root, 'ant-x', 'ant-x.md'), SPEC('ant-x'), 'utf-8');
    writeFileSync(join(caller, 'real.md'), SPEC('real'), 'utf-8');
    expect(resolveCalleeSpecPath(caller, roots, 'ghost')).toBeNull();
    expect(resolveCalleeSpecPath(caller, null, 'ant-x')).toBeNull();
    expect(resolveCalleeSpecPath(caller, null, 'real')).toBe(join(caller, 'real.md'));
    mkdirSync(join(caller, 'sub'));
    for (const bad of ['', '../real', 'a/b', 'a\\b', '..']) expect(resolveCalleeSpecPath(join(caller, 'sub'), roots, bad)).toBeNull();
    // HopAnt 目录里只有同名入口 spec 算数,内部子 spec 不能从外面直接 call
    writeFileSync(join(root, 'ant-x', 'inner.md'), SPEC('inner'), 'utf-8');
    expect(resolveCalleeSpecPath(caller, roots, 'inner')).toBeNull();
  });
});

describe('hopant：复用模式起跑依赖核 checkRunDeps（^anc-hopant-run-deps）', () => {
  const REG = parseToolServers([{
    name: 'search',
    binding: { kind: 'mcp', transport: 'http', url: 'http://x' },
    tools: [
      { name: 'my_search', requires_commit: false, input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
      { name: 'lookup', requires_commit: false, input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
    ],
  }], '/');
  const TOOLS = (name: string) => `## Tools\n- ${name}(query) -> r % yaml  # 搜\n  - query % text  # 词\n`;
  const CALLER = (callee: string, extra = '') => `# Spec: 调用方
Id: caller
Goal: 调一个子流程
${extra}
## Outputs
- out % text  # 结果

## Steps
1. [act free] 备料
  + → q % text  # 词
2. [call ${callee}(q: q)] 调
  + → out: r  # 收取
`;
  const CALLEE = (id: string, extra = '') => `# Spec: ${id}
Id: ${id}
Goal: 子流程
${extra}
## Inputs
- q % text  # 词

## Outputs
- r % text  # 结果

## Steps
1. [act free] 干
  - ← q
  + → r % text  # 结果
`;
  function specIn(dir: string, name: string, text: string): string { const p = join(dir, `${name}.md`); writeFileSync(p, text, 'utf-8'); return p; }

  it('正：标准工具不注册也过;已注册工具过;call 已装 HopAnt 过且递归核它的 Tools', () => { // @v: anc-hopant-run-deps
    const home = tmp('hopant-home-'); const roots = userOnlyRoots(home); const dir = tmp('hopant-proj-');
    const std = specIn(dir, 'std', CALLEE('std', TOOLS('web_search')));
    const r1 = checkRunDeps(readFileSync(std, 'utf-8'), std, { roots, tool_servers: [] });
    expect(r1.ok).toBe(true);
    expect(r1.tools.standard_unregistered).toEqual(['std: web_search']);
    const reg = specIn(dir, 'reg', CALLEE('reg', TOOLS('my_search')));
    expect(checkRunDeps(readFileSync(reg, 'utf-8'), reg, { roots, tool_servers: REG }).ok).toBe(true);
    // 已装 HopAnt 的 Tools 声明了注册面有的工具 → 过;注册面清空后同一 call 树报出该 HopAnt 的缺口（证明递归核了它）
    const antHome = join(roots.user, 'helper'); mkdirSync(antHome, { recursive: true });
    writeFileSync(join(antHome, 'helper.md'), CALLEE('helper', TOOLS('my_search')), 'utf-8');
    const c = specIn(dir, 'caller', CALLER('helper'));
    expect(checkRunDeps(readFileSync(c, 'utf-8'), c, { roots, tool_servers: REG }).ok).toBe(true);
    const r2 = checkRunDeps(readFileSync(c, 'utf-8'), c, { roots, tool_servers: [] });
    expect(r2.ok).toBe(false);
    expect(r2.tools.missing).toEqual(['helper: my_search']);
    expect(r2.hints.some(h => h.includes('my_search') && h.includes('tool_servers'))).toBe(true);
  });

  it('正：call 已注册的工具名、标准工具名都算找得到;call 环（a↔b）不死循环', () => { // @v: anc-hopant-run-deps
    const home = tmp('hopant-home-'); const roots = userOnlyRoots(home); const dir = tmp('hopant-proj-');
    const t = specIn(dir, 'caller', CALLER('lookup'));
    expect(checkRunDeps(readFileSync(t, 'utf-8'), t, { roots, tool_servers: REG }).ok).toBe(true);
    const w = specIn(dir, 'caller', CALLER('web_search'));
    expect(checkRunDeps(readFileSync(w, 'utf-8'), w, { roots, tool_servers: [] }).ok).toBe(true);
    const cyc = tmp('hopant-cyc-');
    specIn(cyc, 'b', CALLER('a').replace('Id: caller', 'Id: b'));
    const a = specIn(cyc, 'a', CALLER('b').replace('Id: caller', 'Id: a'));
    expect(checkRunDeps(readFileSync(a, 'utf-8'), a, { roots, tool_servers: [] }).ok).toBe(true);
  });

  it('反：未注册的非标准工具进 missing;call 目标三处都找不到 → missing 带 spec 名与步骤号,hint 指路 /hop 安装', () => { // @v: anc-hopant-run-deps
    const home = tmp('hopant-home-'); const roots = userOnlyRoots(home); const dir = tmp('hopant-proj-');
    const u = specIn(dir, 'u', CALLEE('u', TOOLS('my_search')));
    const r1 = checkRunDeps(readFileSync(u, 'utf-8'), u, { roots, tool_servers: [] });
    expect(r1.ok).toBe(false);
    expect(r1.tools.missing).toEqual(['u: my_search']);
    expect(r1.hints.some(h => h.includes('宿主自己挂的 MCP 也要在这里注册'))).toBe(true);
    const c = specIn(dir, 'caller', CALLER('ghost-ant'));
    const r2 = checkRunDeps(readFileSync(c, 'utf-8'), c, { roots, tool_servers: REG });
    expect(r2.ok).toBe(false);
    expect(r2.calls.missing).toEqual(['caller 步骤 2: ghost-ant']);
    expect(r2.hints.some(h => h.includes('ghost-ant') && h.includes('本项目或本机已装的 HopAnt') && h.includes('/hop 安装'))).toBe(true);   // 文案与设计 checkRunDeps 第 4 步同句（两级根后改为"本项目或本机",入口改 /hop 安装）
  });

  it('边界：动态 callee 不核;callee 解析出错 → unreadable 且不 ok;入口自身解析出错不抢引擎的报错,返回 ok', () => { // @v: anc-hopant-run-deps
    const home = tmp('hopant-home-'); const roots = userOnlyRoots(home); const dir = tmp('hopant-proj-');
    const dyn = specIn(dir, 'dyn', CALLER('{picked}').replace('## Outputs', '## Inputs\n- picked % text  # 选中的 spec id\n\n## Outputs'));
    expect(checkRunDeps(readFileSync(dyn, 'utf-8'), dyn, { roots, tool_servers: [] }).ok).toBe(true);
    specIn(dir, 'broken', '# Spec: broken\nId: broken\nGoal: g\n## Steps\n1. [nosuchtype] x\n');
    const c = specIn(dir, 'caller', CALLER('broken'));
    const r = checkRunDeps(readFileSync(c, 'utf-8'), c, { roots, tool_servers: [] });
    expect(r.ok).toBe(false);
    expect(r.calls.unreadable).toHaveLength(1);
    expect(r.calls.unreadable[0]).toMatch(/^broken: 第 \d+ 行/);
    const bad = specIn(dir, 'bad', '# Spec: bad\nId: bad\nGoal: g\n## Steps\n1. [nosuchtype] x\n');
    expect(checkRunDeps(readFileSync(bad, 'utf-8'), bad, { roots, tool_servers: [] }).ok).toBe(true);
  });
});

describe('hopant：CLI 承接 hopjit ant（^anc-cli-ant）', () => {
  const run = (home: string, cwd: string, args: string[]) => spawnSync('node', [CLI, '--json', 'ant', ...args], {
    encoding: 'utf-8', cwd, env: { ...process.env, HOME: home, PATH: process.env.PATH ?? '' },
  });

  it('正：install → list（never）→ adapt（无依赖即 ok 并写戳）→ list（adapted）→ remove;dry-run 不写盘', () => { // @v: anc-cli-ant
    expect(existsSync(CLI), 'dist/cli.js 缺席——先 npx tsc 再跑本组（禁止静默跳过）').toBe(true);
    const home = tmp('hopant-home-'); const src = tmp('hopant-src-'); const cwd = tmp('hopant-cwd-');
    const ant = makeAnt(src, 'cli-ant', { bootstrap: true });

    const dry = run(home, cwd, ['install', ant, '--dry-run']);
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout).dry_run).toBe(true);
    expect(existsSync(antDir(antsRoot(home), 'cli-ant'))).toBe(false);

    const inst = run(home, cwd, ['install', ant]);
    expect(inst.status, inst.stderr).toBe(0);
    const instJ = JSON.parse(inst.stdout);
    expect(instJ.result.installed).toEqual(['cli-ant']);
    expect(instJ.next_step).toContain('hopjit ant bootstrap cli-ant --dry-run');

    const l1 = JSON.parse(run(home, cwd, ['list']).stdout);
    expect(l1.ants).toEqual([{ id: 'cli-ant', scope: 'user', title: 'cli-ant 标题', adapt_state: 'never' }]);   // 缺省装用户级,条目带 scope

    const ad = run(home, cwd, ['adapt', 'cli-ant']);
    expect(ad.status, ad.stderr).toBe(0);
    const adJ = JSON.parse(ad.stdout);
    expect(adJ.report.ok).toBe(true);
    expect(adJ.stamp_written).toBe(join(antDir(antsRoot(home), 'cli-ant'), 'inner_store', 'adapt.yaml'));

    const l2 = JSON.parse(run(home, cwd, ['list']).stdout);
    expect(l2.ants[0].adapt_state).toBe('adapted');

    const boot = run(home, cwd, ['bootstrap', 'cli-ant', '--dry-run']);
    expect(boot.status).toBe(0);
    const bootJ = JSON.parse(boot.stdout);
    expect(bootJ.has_bootstrap).toBe(true);
    expect(bootJ.stdout).toContain('plan: nothing');

    // 归属标识：config.yaml 有 owner_id 就恒用它（人在打包时答过的值,决策 8）——手写一个现算绝不会得出的值,list 用它比对 → 戳里的现算分支判 stale;
    // 再 adapt 写戳用落盘值（变异：localOwnerId 不读 config 本例红）
    const cfgPath = join(home, '.hopjit', 'config.yaml');
    mkdirSync(join(home, '.hopjit'), { recursive: true });
    writeFileSync(cfgPath, 'owner_id: seeded-team-x\n', 'utf-8');
    expect(JSON.parse(run(home, cwd, ['list']).stdout).ants[0].adapt_state).toBe('stale');
    const ad2 = JSON.parse(run(home, cwd, ['adapt', 'cli-ant']).stdout);
    expect(readFileSync(ad2.stamp_written, 'utf-8')).toContain('owner: seeded-team-x');
    expect(JSON.parse(run(home, cwd, ['list']).stdout).ants[0].adapt_state).toBe('adapted');
    expect(readFileSync(cfgPath, 'utf-8')).toBe('owner_id: seeded-team-x\n');   // adapt/list 只读不写

    // 改 spec 头 → list 报 stale（变异 s：CLI 恒 adapted 本例红）
    const specP = join(antDir(antsRoot(home), 'cli-ant'), 'cli-ant.md');
    writeFileSync(specP, readFileSync(specP, 'utf-8') + '\n## Config\n- engine_min_version: 0.1.0\n', 'utf-8');
    expect(JSON.parse(run(home, cwd, ['list']).stdout).ants[0].adapt_state).toBe('stale');

    // --keep-store 挪备份 + kept_store 真;再 remove 不存在 → removed false（变异 cc）
    writeFileSync(join(antDir(antsRoot(home), 'cli-ant'), 'inner_store', 'd.txt'), 'x', 'utf-8');
    const rm = JSON.parse(run(home, cwd, ['remove', 'cli-ant', '--keep-store']).stdout);
    expect(rm).toMatchObject({ removed: true, kept_store: true });
    expect(existsSync(join(home, '.hopjit', 'ants-store-backup', 'cli-ant', 'd.txt'))).toBe(true);
    expect(JSON.parse(run(home, cwd, ['remove', 'cli-ant']).stdout)).toMatchObject({ removed: false, kept_store: false });
    expect(JSON.parse(run(home, cwd, ['list']).stdout).ants).toEqual([]);
  });

  it('正/反：bootstrap 无脚本 has_bootstrap:false exit 0;脚本非零 → returncode 透传且本命令 exit 1（变异 x、y）', () => { // @v: anc-cli-ant
    expect(existsSync(CLI), 'dist/cli.js 缺席——先 npx tsc 再跑本组（禁止静默跳过）').toBe(true);
    const home = tmp('hopant-home-'); const src = tmp('hopant-src-'); const cwd = tmp('hopant-cwd-');
    run(home, cwd, ['install', makeAnt(src, 'noboot')]);
    const nb = run(home, cwd, ['bootstrap', 'noboot']);
    expect(nb.status).toBe(0);
    expect(JSON.parse(nb.stdout)).toMatchObject({ has_bootstrap: false });
    const bad = makeAnt(src, 'badboot');
    writeFileSync(join(bad, 'bootstrap.js'), 'console.error("boom"); process.exit(3);\n', 'utf-8');
    run(home, cwd, ['install', bad]);
    const bb = run(home, cwd, ['bootstrap', 'badboot']);
    expect(bb.status).toBe(1);
    const j = JSON.parse(bb.stdout);
    expect(j.returncode).toBe(3);
    expect(j.stderr).toContain('boom');
  });

  it('反：hopjit.yaml 为列表 → adapt 响亮拒 TOOLS_FILE_INVALID;空 hopjit.yaml 照跑;HOPJIT_CONFIG 在场只读它', () => { // @v: anc-cli-ant
    expect(existsSync(CLI), 'dist/cli.js 缺席——先 npx tsc 再跑本组（禁止静默跳过）').toBe(true);
    const home = tmp('hopant-home-'); const src = tmp('hopant-src-'); const cwd = tmp('hopant-cwd-');
    run(home, cwd, ['install', makeAnt(src, 'cfg', { specBody: SPEC('cfg', '## Tools\n- my_search(query) -> r % yaml  # 搜\n  - query % text  # 词\n') })]);
    writeFileSync(join(cwd, 'hopjit.yaml'), '- just\n- a list\n', 'utf-8');
    const bad = run(home, cwd, ['adapt', 'cfg']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/TOOLS_FILE_INVALID/);
    writeFileSync(join(cwd, 'hopjit.yaml'), '', 'utf-8');
    const empty = run(home, cwd, ['adapt', 'cfg']);
    expect(empty.stdout).toContain('"missing":["my_search"]');
    // HOPJIT_CONFIG 单文件：它注册了 web_search,项目级 hopjit.yaml 不读
    const only = join(tmp('hopant-cfg-'), 'only.yaml');
    writeFileSync(only, 'providers:\n  - service_id: o\n    protocol: anthropic\n    base_url: http://x\n    model: m\n    api_key_env: O_KEY\ntool_servers:\n  - name: s\n    binding: { kind: mcp, transport: http, url: http://s }\n    tools:\n      - { name: my_search, requires_commit: false, input_schema: { type: object, properties: { query: { type: string } } } }\n', 'utf-8');
    const r = spawnSync('node', [CLI, '--json', 'ant', 'adapt', 'cfg'], { encoding: 'utf-8', cwd, env: { ...process.env, HOME: home, HOPJIT_CONFIG: only, O_KEY: 'k' } });
    const j = JSON.parse(r.stdout);
    expect(j.report.tools.missing).toEqual([]);
    expect(j.report.credentials.required).toEqual(['O_KEY']);
  });

  it('反：adapt / bootstrap 指向没装的 id → HOPANT_NOT_FOUND 走 stderr,exit 1;adapt 有缺口 exit 1 且 report 在 stdout', () => { // @v: anc-cli-ant, anc-hopant-errors
    expect(existsSync(CLI), 'dist/cli.js 缺席——先 npx tsc 再跑本组（禁止静默跳过）').toBe(true);
    const home = tmp('hopant-home-'); const src = tmp('hopant-src-'); const cwd = tmp('hopant-cwd-');
    const nf = run(home, cwd, ['adapt', 'ghost']);
    expect(nf.status).toBe(1);
    expect(nf.stderr).toMatch(/HOPANT_NOT_FOUND/);
    expect(run(home, cwd, ['bootstrap', 'ghost']).stderr).toMatch(/HOPANT_NOT_FOUND/);

    const ant = makeAnt(src, 'needy', { specBody: SPEC('needy', '## Tools\n- nowhere_tool(q) -> r % text  # 不存在\n  - q % text  # 词\n') });
    expect(run(home, cwd, ['install', ant]).status).toBe(0);
    const ad = run(home, cwd, ['adapt', 'needy']);
    expect(ad.status).toBe(1);
    const j = JSON.parse(ad.stdout);
    expect(j.report.ok).toBe(false);
    expect(j.report.tools.missing).toEqual(['nowhere_tool']);
    expect(j.stamp_written).toBeNull();
    expect(JSON.parse(run(home, cwd, ['list']).stdout).ants[0].adapt_state).toBe('never');
  });

  // @v: anc-cli-ant
  it('正/反：install --scope project 落 <cwd>/hop_tasks/ants/;remove --scope user 对只装在项目级的 id 返回 removed:false;remove 不带 scope 删项目级返回 scope:project', () => {
    expect(existsSync(CLI), 'dist/cli.js 缺席——先 npx tsc 再跑本组（禁止静默跳过）').toBe(true);
    const home = tmp('hopant-home-'); const src = tmp('hopant-src-'); const cwd = realpathSync(tmp('hopant-cwd-'));   // cwd 当项目根;子进程 process.cwd() 回的是 realpath,macOS /tmp 是软链
    const ant = makeAnt(src, 'proj-ant');
    const inst = run(home, cwd, ['install', ant, '--scope', 'project']);
    expect(inst.status, inst.stderr).toBe(0);
    const instJ = JSON.parse(inst.stdout);
    expect(instJ.scope).toBe('project');   // 变异 M8：action 忽略 opts.scope 恒传 'user' → 红
    expect(instJ.plan.root).toBe(join(cwd, 'hop_tasks', 'ants'));
    expect(existsSync(join(cwd, 'hop_tasks', 'ants', 'proj-ant', 'proj-ant.md'))).toBe(true);
    expect(existsSync(join(home, '.hopjit', 'ants', 'proj-ant'))).toBe(false);
    expect(JSON.parse(run(home, cwd, ['list']).stdout).ants).toEqual([{ id: 'proj-ant', scope: 'project', title: 'proj-ant 标题', adapt_state: 'never' }]);
    // --scope user 指定了一级,那一级没有 → removed:false,不退而删项目级
    const rmUser = JSON.parse(run(home, cwd, ['remove', 'proj-ant', '--scope', 'user']).stdout);
    expect(rmUser).toMatchObject({ removed: false });
    expect(rmUser.scope).toBeUndefined();
    expect(existsSync(join(cwd, 'hop_tasks', 'ants', 'proj-ant', 'proj-ant.md'))).toBe(true);
    // 不带 scope → 两级查找命中项目级,删它并回报 scope:project
    const rm = JSON.parse(run(home, cwd, ['remove', 'proj-ant']).stdout);
    expect(rm).toMatchObject({ removed: true, scope: 'project' });
    expect(existsSync(join(cwd, 'hop_tasks', 'ants', 'proj-ant'))).toBe(false);
    expect(JSON.parse(run(home, cwd, ['list']).stdout).ants).toEqual([]);
  });
});

// commit 批准账位置（todo/0146）：spec 在 HopAnt 目录下记进该 HopAnt 的 inner_store,其余记在 run 根旁。
// @v: anc-hopant-commit-store
// @v: anc-hopant-commit-store, anc-exec-dirs-grant —— dirsApprovalStorePath 是引擎"commit 账同目录换名"规则的具名真身,两边须恒相等

// ---------- AntPacker：封装（^anc-hopant-pack） ----------
// @v: anc-hopant-pack, anc-hopant-errors
describe('hopant：封装 packAnt / reconcileHeader / collectBodyUsage（^anc-hopant-pack）', () => {
  const RICH = `# Spec: rich
Id: rich
Goal: 对账探针
## Tools
- web_search(query) -> r % yaml  # 标准工具,free 步用
  - query % text  # q
- unused_tool(a) -> r % yaml  # 声明了正文没用
  - a % text  # a
## Inputs
- x % text  # x
## Outputs
- out % text  # 结果
## 已批准命令
- git status
- stale_cmd
## Steps
1. [act] 带 body
  + → out % text
  > \`\`\`hop_python
  > r = subprocess.run(["uv", "run", "x"], cwd: "/x")
  > out = my_tool(q: str(other_tool(z: 1)))
  > w = write(path: "a.md", content: out)
  > \`\`\`
2. [act free] 查
  - 工具: web_search
  + → o2 % text
3. [reason] 想
  + → o3 % text
`;
  it('正：collectBodyUsage——tool_grants ∪ body callee 去内建;嵌套实参里的调用也收;subprocess.run 首项进 commands', () => {
    const { ast } = parseSpec(RICH);
    const u = collectBodyUsage(ast.steps);
    expect(u.tools).toEqual(['my_tool', 'other_tool', 'web_search']);   // str/write 是内建不收;web_search 来自 grants
    expect(u.commands).toEqual(['uv']);
    expect(u.undetermined).toEqual([]);
  });
  it('正：reconcileHeader——少补多删：补 my_tool/other_tool,删 unused_tool（连带参数子行）,标准工具 web_search 声明了保留;命令补 uv 删 git/stale_cmd;其余字节不变', () => {
    const { report, newText } = reconcileHeader(RICH);
    expect(report).toEqual({ tools_added: ['my_tool', 'other_tool'], tools_removed: ['unused_tool'], commands_added: ['uv'], commands_removed: ['git', 'stale_cmd'], commands_undetermined: [] });
    expect(newText).not.toContain('unused_tool');
    expect(newText).not.toContain('  - a % text  # a');   // 变异：删顶层条目不连带子行 → 残留红
    expect(newText).toContain('- web_search(query)');
    expect(newText).toContain('- my_tool(input) -> result % yaml');
    expect(newText).toMatch(/## 已批准命令\n- uv\n/);
    expect(newText).not.toContain('- git status');
    expect(newText.split('## Steps')[1]).toBe(RICH.split('## Steps')[1]);   // Steps 段逐字节不动
    expect(parseSpec(newText).errors).toEqual([]);   // 重写后仍是合法 spec
  });
  it('反：subprocess.run 第一参不是列表字面量 → undetermined 非空,一条命令都不删（只补）', () => {
    const t = RICH.replace('subprocess.run(["uv", "run", "x"], cwd: "/x")', 'subprocess.run(cmd, cwd: "/x")').replace('  > r = subprocess.run', '  > cmd = ["uv"]\n  > r = subprocess.run');
    const { report } = reconcileHeader(t);
    expect(report.commands_undetermined).toHaveLength(1);
    expect(report.commands_removed).toEqual([]);   // 变异：undetermined 时照删 → 红
    expect(report.commands_added).toEqual([]);
  });
  it('正：标准工具只声明不使用（没有 free 步授权、正文也没调）仍保留——它由调用方自带能力落实,正文本就无调用形态', () => {
    const t = `# Spec: w\nId: w\nGoal: g\n## Tools\n- web_search(query) -> r % yaml  # 只声明\n  - query % text  # q\n## Outputs\n- out % text  # o\n## Steps\n1. [act] a\n  + → out % text\n  > \`\`\`hop_python\n  > out = "x"\n  > \`\`\`\n`;
    const { report, newText } = reconcileHeader(t);
    expect(report.tools_removed).toEqual([]);   // 变异：去掉 STANDARD_TOOL_NAMES 豁免 → ['web_search'] 红
    expect(newText).toBe(t);
  });
  it('正：零增删时 newText 与原文逐字节相同;段不存在而有新增时 Tools 段插在 Outputs 之后（概念节序）、已批准命令插在 Steps 之前', () => {
    const clean = `# Spec: c\nId: c\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`;
    expect(reconcileHeader(clean).newText).toBe(clean);
    const noSections = `# Spec: n\nId: n\nGoal: g\n## Inputs\n- x % text  # x\n## Outputs\n- out % text  # o\n## Steps\n1. [act] a\n  + → out % text\n  > \`\`\`hop_python\n  > r = subprocess.run(["ls"], cwd: "/")\n  > out = ext_tool(a: 1)\n  > \`\`\`\n`;
    const { report, newText } = reconcileHeader(noSections);
    expect(report.tools_added).toEqual(['ext_tool']); expect(report.commands_added).toEqual(['ls']);
    expect(newText.indexOf('## Tools')).toBeGreaterThan(newText.indexOf('## Outputs'));   // 变异 D21：插 Inputs 前 → 红
    expect(newText.indexOf('## Tools')).toBeLessThan(newText.indexOf('## 已批准命令'));
    expect(newText.indexOf('## 已批准命令')).toBeLessThan(newText.indexOf('## Steps'));
    expect(parseSpec(newText).errors).toEqual([]);
  });
  it('正：packAnt——写 <out>/<id>/<id>.md（Id 行改写）+ doc-ref 文件 + assets;不建 inner_store;reconciled 带出', () => {
    const src = tmp('pk-src-'); const out = tmp('pk-out-');
    writeFileSync(join(src, 'kb.md'), '# 知识\n## 规则\n一条\n');
    writeFileSync(join(src, 'extra.txt'), 'x');
    const spec = `# Spec: s\nId: wrong-id\nGoal: g\n## Constraints\n- 按 [[kb#规则]] 做\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`;
    writeFileSync(join(src, 'spec.md'), spec);
    const r = packAnt(join(src, 'spec.md'), out, { id: 'my-ant', assets: ['extra.txt'] });
    expect(r.id).toBe('my-ant');
    expect(readFileSync(join(out, 'my-ant', 'my-ant.md'), 'utf-8')).toContain('Id: my-ant');
    expect(existsSync(join(out, 'my-ant', 'kb.md'))).toBe(true);
    expect(existsSync(join(out, 'my-ant', 'extra.txt'))).toBe(true);
    expect(existsSync(join(out, 'my-ant', 'inner_store'))).toBe(false);   // 变异：packAnt 建 inner_store → 红
    expect(r.docs_copied).toEqual(['kb.md']); expect(r.assets_copied).toEqual(['extra.txt']);
  });
  it('反：doc-ref 文件缺 → HOPANT_DOC_MISSING 不写;目标非空 → HOPANT_TARGET_EXISTS;坏 id → HOPANT_BAD_ID', () => {
    const src = tmp('pk-src2-'); const out = tmp('pk-out2-');
    writeFileSync(join(src, 'spec.md'), `# Spec: s\nId: good-id\nGoal: g\n## Constraints\n- 按 [[nowhere#节]] 做\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`);
    expect(() => packAnt(join(src, 'spec.md'), out)).toThrow(/^HOPANT_DOC_MISSING: .*nowhere/);
    expect(existsSync(join(out, 'good-id'))).toBe(false);   // 变异：先写后核 → 目录残留红
    writeFileSync(join(src, 'ok.md'), `# Spec: o\nId: good-id\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`);
    mkdirSync(join(out, 'good-id')); writeFileSync(join(out, 'good-id', 'x'), '');
    expect(() => packAnt(join(src, 'ok.md'), out)).toThrow(/^HOPANT_TARGET_EXISTS/);
    expect(() => packAnt(join(src, 'ok.md'), tmp('pk-out3-'), { id: 'Bad' })).toThrow(/^HOPANT_BAD_ID/);
  });
  it('正（D1/D2/G1）：授权行内建名与 `*` 不进使用面;容器步骤（subtask/branch→case）、if 三部分、列表字面量内嵌套调用、engine special 与通知件剔除', () => {
    const nested = `# Spec: nest
Id: nest
Goal: g
## Outputs
- out % text  # o
## Steps
1. [act free] 查
  - 工具: read
  - 工具: ext_grant
  + → a % text
2. [act free] 全量授权（\`*\` 与具名互斥,语义审计 #19 后单独一步）
  - 工具: *
  + → b % text
3. [subtask] 容器
  + → out % text
  3.1. [branch] 分
    - ← a
    + → out % text
    3.1.1. [case(a == "x")] 甲
      + → out % text
      3.1.1.1. [act] 深层
        + → out % text
        > \`\`\`hop_python
        > if cond_tool(q: a):
        >     out = then_tool(q: a)
        > else:
        >     out = else_tool(q: a)
        > xs = [list_tool(q: a), 1]
        > v = validate_spec(spec: a)
        > r = run_script(cmd: a)
        > dingtalk_notify(text: a)
        > \`\`\`
`;
    const { ast, errors } = parseSpec(nested);
    expect(errors).toEqual([]);
    const u = collectBodyUsage(ast.steps);
    expect(u.tools).toEqual(['ext_grant', 'cond_tool', 'then_tool', 'else_tool', 'list_tool']);
    // 变异 D1：grants 不过内建名单 → read 混入红;D2：不跳 * → * 混入红;G1：删 visit(getChildren) → 深层四个全丢红;删 else_body/condition 递归 → 对应项丢红;
    // 删 walkExprCalls 对数组的下钻 → list_tool 丢红;isBuiltinCallee 去掉 B2 两名单 → validate_spec / run_script / dingtalk_notify 混入红
  });
  it('正（四 OK）：补入标准工具写标准签名 web_search(query) -> result % yaml,非标准工具写占位 (input) + 子条目', () => {
    const t = `# Spec: t\nId: t\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] 查\n  - 工具: web_search\n  + → a % text\n2. [act] 用\n  + → out % text\n  > \`\`\`hop_python\n  > out = my_ext(q: a)\n  > \`\`\`\n`;
    const { report, newText } = reconcileHeader(t);
    expect(report.tools_added).toEqual(['web_search', 'my_ext']);
    expect(newText).toContain('- web_search(query) -> result % yaml  # 封装对账补入（标准工具,签名由 hop 定）\n  - query % text  # 查询词');
    expect(newText).not.toContain('web_search(input)');   // 变异：标准工具也写占位 → 红
    expect(newText).toContain('- my_ext(input) -> result % yaml');
    expect(newText).toContain('  - input % text  # 待补');
    expect(parseSpec(newText).errors).toEqual([]);
  });
  it('正（D3）：删条目按 parser 文法识别——中文工具名多声明被真删;带引号命令首项多声明被真删;报告与正文一致', () => {
    const t = `# Spec: zh\nId: zh\nGoal: g\n## Tools\n- 网页检索(词) -> r % yaml  # 多声明\n  - 词 % text  # q\n- 9tool(a) -> r % yaml  # 数字开头,多声明\n  - a % text  # a\n## Outputs\n- out % text  # o\n## 已批准命令\n- "my cmd" --x\n- git status\n## Steps\n1. [act] a\n  + → out % text\n  > \`\`\`hop_python\n  > r = subprocess.run(["git", "status"], cwd: "/")\n  > out = str(r)\n  > \`\`\`\n`;
    const { report, newText } = reconcileHeader(t);
    expect(report.tools_removed).toEqual(['网页检索', '9tool']);
    expect(report.commands_removed).toEqual(['my cmd']);
    expect(newText).not.toContain('网页检索');   // 变异 D3：toolDeclOf 用 [A-Za-z_] 开头正则 → 中文行残留红
    expect(newText).not.toContain('9tool');
    expect(newText).not.toContain('"my cmd"');   // 变异 D3：首项取 \\S+ 得 "my → 比不上残留红
    expect(newText).toContain('- git status');
    expect(parseSpec(newText).errors).toEqual([]);
    expect(parseSpec(newText).ast.header.tools ?? []).toEqual([]);
  });
  it('正（D8/D11）：Id 行改写——中文 `标识:` 行被改;原文无 Id 行时在 `# Spec:` 后插入 Id 行;产物可 share（核一严格比对过）', () => {
    const src = tmp('pk-id-'); const out = tmp('pk-id-out-');
    writeFileSync(join(src, 'zh.md'), `# Spec: z\n标识: wrong\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`);
    packAnt(join(src, 'zh.md'), out, { id: 'zh-ant' });
    expect(readFileSync(join(out, 'zh-ant', 'zh-ant.md'), 'utf-8')).toMatch(/^标识: zh-ant$/m);   // 变异 D11：缺省 rewrite 去掉 标识 分支 → 红
    writeFileSync(join(src, 'noid.md'), `# Spec: n\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`);
    const r = packAnt(join(src, 'noid.md'), out, { id: 'no-id-ant' });
    const text = readFileSync(join(r.dir, 'no-id-ant.md'), 'utf-8');
    expect(text.split('\n')[1]).toBe('Id: no-id-ant');   // 变异 D8：不插入 → 红
    expect(parseSpec(text).ast.header.id).toBe('no-id-ant');
  });
  it('反（D5/D6/G5）：--assets 缺 → DOC_MISSING 且目标目录不存在;doc-ref 越界 ../ → DOC_MISSING;id 含 .. → BAD_ID;坏 spec → SPEC_INVALID;步骤级 doc-ref 被收并拷', () => {
    const base = tmp('pk-neg-'); const src = join(base, 'sub'); mkdirSync(src); const out = tmp('pk-neg-out-');
    const ok = `# Spec: o\nId: ok-id\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`;
    writeFileSync(join(src, 'ok.md'), ok);
    expect(() => packAnt(join(src, 'ok.md'), out, { assets: ['nope.txt'] })).toThrow(/^HOPANT_DOC_MISSING: --assets/);
    expect(existsSync(join(out, 'ok-id'))).toBe(false);   // 变异 D5：assets 核在 mkdir 后 → 目录残留红
    writeFileSync(join(base, 'shared.md'), '# s\n## 节\nx\n');
    writeFileSync(join(src, 'esc.md'), `# Spec: e\nId: esc-id\nGoal: g\n## Constraints\n- 见 [[../shared#节]]\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`);
    expect(() => packAnt(join(src, 'esc.md'), out)).toThrow(/^HOPANT_DOC_MISSING: doc-ref 引用越出/);   // 变异 D6：不判越界 → 文件写到 out/shared.md 不抛红
    expect(existsSync(join(out, 'shared.md'))).toBe(false);
    expect(() => packAnt(join(src, 'ok.md'), out, { id: 'a..b' })).toThrow(/^HOPANT_BAD_ID/);
    writeFileSync(join(src, 'bad.md'), `# Spec: b\nId: bad-id\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [nonsense] a\n  + → out % text\n`);
    expect(() => packAnt(join(src, 'bad.md'), out)).toThrow(/^HOPANT_SPEC_INVALID/);
    writeFileSync(join(src, 'kb2.md'), '# kb2\n## 节\nx\n');
    writeFileSync(join(src, 'stepdoc.md'), `# Spec: sd\nId: sd-id\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n  > 参考 [[kb2#节]]\n`);
    const r = packAnt(join(src, 'stepdoc.md'), out);
    expect(r.docs_copied).toEqual(['kb2.md']);   // 变异 G5：visitDocs 删 → 步骤级 doc 不收红
    expect(existsSync(join(r.dir, 'kb2.md'))).toBe(true);
  });
  // @v: anc-hopant-pack —— todo/0159：随包文件存在但读不出,写盘前一次性报 HOPANT_DOC_MISSING,不留半成品目录、不抛裸 EACCES
  it.skipIf(process.getuid?.() === 0)('正/反（0159 随包文件可读核）：doc-ref 文件 chmod 000 → HOPANT_DOC_MISSING 带系统 message 且目标目录不建;--assets 文件 chmod 000 → 同;恢复可读后照常拷入', () => {
    const base = tmp('pk-unread-'); const src = join(base, 'sub'); mkdirSync(src); const out = tmp('pk-unread-out-');
    writeFileSync(join(src, 'kb.md'), '# kb\n## 节\nx\n');
    writeFileSync(join(src, 'extra.txt'), 'asset');
    writeFileSync(join(src, 'spec.md'), `# Spec: u\nId: unread-id\nGoal: g\n## Constraints\n- 见 [[kb#节]]\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n`);
    try {
      chmodSync(join(src, 'kb.md'), 0o000);
      expect(() => packAnt(join(src, 'spec.md'), out, { assets: ['extra.txt'] })).toThrow(/^HOPANT_DOC_MISSING: 随包文件存在但读不出: .*kb\.md（.*EACCES/);
      expect(existsSync(join(out, 'unread-id'))).toBe(false);   // 变异：可读核放到 mkdirSync 之后 → 目录残留红
      chmodSync(join(src, 'kb.md'), 0o644);
      chmodSync(join(src, 'extra.txt'), 0o000);
      expect(() => packAnt(join(src, 'spec.md'), out, { assets: ['extra.txt'] })).toThrow(/^HOPANT_DOC_MISSING: 随包文件存在但读不出: .*extra\.txt（.*EACCES/);   // 变异：去掉 accessSync 段 → cpSync 抛裸 EACCES,前缀断言红
      expect(existsSync(join(out, 'unread-id'))).toBe(false);
    } finally {
      chmodSync(join(src, 'kb.md'), 0o644);
      chmodSync(join(src, 'extra.txt'), 0o644);
    }
    const r = packAnt(join(src, 'spec.md'), out, { assets: ['extra.txt'] });
    expect(r.docs_copied).toEqual(['kb.md']);
    expect(r.assets_copied).toEqual(['extra.txt']);
    expect(readFileSync(join(r.dir, 'extra.txt'), 'utf-8')).toBe('asset');
  });
  it('正（D10②）：第一个真实 HopAnt examples/ants/hop-fact-check 与源 examples/hop-fact-check.md 逐字节相同;假 HOME 下 install + adapt ok,唯一提示是标准工具 web_search', () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const antDirSrc = join(repo, 'examples', 'ants', 'hop-fact-check');
    expect(readFileSync(join(antDirSrc, 'hop-fact-check.md'), 'utf-8')).toBe(readFileSync(join(repo, 'examples', 'hop-fact-check.md'), 'utf-8'));
    expect(readFileSync(join(antDirSrc, 'fact-check-sample.md'), 'utf-8')).toBe(readFileSync(join(repo, 'examples', 'fact-check-sample.md'), 'utf-8'));
    expect(reconcileHeader(readFileSync(join(antDirSrc, 'hop-fact-check.md'), 'utf-8')).report).toEqual({ tools_added: [], tools_removed: [], commands_added: [], commands_removed: [], commands_undetermined: [] });
    const root = antsRoot(tmp('real-home-'));
    const res = applyInstall(planInstall(antDirSrc, root));
    expect(res.installed).toEqual(['hop-fact-check']);
    const rep = adapt(antDir(root, 'hop-fact-check'), { tool_servers: [], providers: [], env_vars: {}, path_dirs: [], engine_version: '0.19.1' });
    expect(rep.ok).toBe(true);
    expect(rep.tools.missing).toEqual([]);
    expect(rep.tools.standard_unregistered).toEqual(['web_search']);
  });
});

// ---------- AntPacker：分享（^anc-hopant-share） ----------
// @v: anc-hopant-share, anc-hopant-errors
describe('hopant：分享 shareAnts / scanCredentials / isLocalFace（^anc-hopant-share）', () => {
  /** 装进 roots.user（用户级）;分享按 resolveAnt 两级查找,项目级在本组恒为空 */
  function installed(roots: AntRoots, id: string, opts: { extra?: string; files?: Record<string, string>; local?: boolean } = {}): void {
    const src = tmp('sh-src-');
    const dir = makeAnt(src, id, { extra: opts.extra, local: opts.local });
    for (const [rel, content] of Object.entries(opts.files ?? {})) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), content); }
    applyInstall(planInstall(dir, roots.user));
    const dst = antDir(roots.user, id);
    if (opts.local) { mkdirSync(join(dst, 'inner_store'), { recursive: true }); writeFileSync(join(dst, 'inner_store', 'adapt.yaml'), 'x: 1\n'); writeFileSync(join(dst, `${id}.orig.md`), 'orig'); }
  }
  it('正：isLocalFace——顶层 inner_store/ 与任意深度 *.orig.md 为本机面;knowledge/ 与子目录同名文件不是', () => {
    expect(isLocalFace('inner_store/adapt.yaml')).toBe(true);
    expect(isLocalFace('inner_store')).toBe(true);
    expect(isLocalFace('a.orig.md')).toBe(true);
    expect(isLocalFace('knowledge/deep/x.orig.md')).toBe(true);
    expect(isLocalFace('knowledge/inner_store/notes.md')).toBe(false);   // 只看顶层
    expect(isLocalFace('a.md')).toBe(false);
  });
  it('正：单 ant 分享——缺省 name=id,version 0.1.0;package.json 字段;ants/<id>/ 只有可分发面,inner_store 与 *.orig.md 不进;checks 三项 + credential_scan 回执带免责', () => {
    const home = userOnlyRoots(tmp('sh-home-')); const out = tmp('sh-out-');
    installed(home, 'alpha', { local: true });
    const r = shareAnts(home, ['alpha'], out, { owner: 'me-box' });
    expect(r.name).toBe('alpha'); expect(r.version).toBe('0.1.0'); expect(r.dir).toBe(join(out, 'alpha'));
    const pkg = JSON.parse(readFileSync(join(out, 'alpha', 'package.json'), 'utf-8'));
    expect(pkg).toEqual({ name: 'alpha', version: '0.1.0', files: ['ants/'], hopant: { owner: 'me-box', ants: { alpha: {} } } });
    expect(existsSync(join(out, 'alpha', 'ants', 'alpha', 'alpha.md'))).toBe(true);
    expect(existsSync(join(out, 'alpha', 'ants', 'alpha', 'knowledge', 'glossary.md'))).toBe(true);
    expect(existsSync(join(out, 'alpha', 'ants', 'alpha', 'inner_store'))).toBe(false);   // 变异：cpSync filter 去掉 isLocalFace → 红（自检也红）
    expect(existsSync(join(out, 'alpha', 'ants', 'alpha', 'alpha.orig.md'))).toBe(false);
    expect(r.checks).toEqual({ header_dir_consistent: true, no_local_face: true, lineage_written: [] });
    expect(r.credential_scan.method).toBe('heuristic');
    expect(r.credential_scan.disclaimer).toBe(CREDENTIAL_SCAN_DISCLAIMER);
    expect(r.credential_scan.rejected).toEqual([]); expect(r.credential_scan.warnings).toEqual([]);
    expect(r.credential_scan.files_scanned).toBe(2);   // alpha.md + knowledge/glossary.md 恰两件;inner_store/adapt.yaml 与 alpha.orig.md 不计（变异：核二不排除本机面 → 计数 4 红）
  });
  it('正：多 ant 包须 --name;缺则 HOPANT_PKG_NAME_REQUIRED;给了则两 ant 都在 ants/ 下', () => {
    const home = userOnlyRoots(tmp('sh-home2-')); const out = tmp('sh-out2-');
    installed(home, 'a1'); installed(home, 'a2');
    expect(() => shareAnts(home, ['a1', 'a2'], out, { owner: 'o' })).toThrow(/^HOPANT_PKG_NAME_REQUIRED/);
    const r = shareAnts(home, ['a1', 'a2'], out, { owner: 'o', name: 'bundle', version: '2.0.0' });
    expect(r.ants).toEqual(['a1', 'a2']);
    expect(existsSync(join(out, 'bundle', 'ants', 'a2', 'a2.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, 'bundle', 'package.json'), 'utf-8')).version).toBe('2.0.0');
  });
  it('反（D19/D23）：凭证拒——knowledge 里 sk- 形态（L1）、spec 里键名提示+高熵（L2+L3）、scripts/ 代码文件里 ghp_（L1,扫描面含代码）→ HOPANT_CREDENTIAL_LITERAL 点名文件:行:层 + 免责句,不写包;本机面里的凭证不扫', () => {
    const home = userOnlyRoots(tmp('sh-home3-')); const out = tmp('sh-out3-');
    installed(home, 'leaky', { files: { 'knowledge/cfg.yaml': 'service: x\napi_key: sk-abcdefghijklmnopqrstuvwxyz0123\n' } });
    expect(() => shareAnts(home, ['leaky'], out, { owner: 'o' })).toThrow(/^HOPANT_CREDENTIAL_LITERAL: leaky\/knowledge\/cfg\.yaml:2（第 1 层）.*不保证无漏/);
    expect(existsSync(join(out, 'leaky'))).toBe(false);   // 变异：核二挪到写包之后 → 目录残留红
    const home2 = userOnlyRoots(tmp('sh-home4-'));
    installed(home2, 'leaky2', { extra: '## Constraints\n- api_key: 7f3a9c2e1b8d4f6a9c0e2b5d8f1a3c6e7f3a9c2e\n' });
    expect(() => shareAnts(home2, ['leaky2'], out, { owner: 'o' })).toThrow(/^HOPANT_CREDENTIAL_LITERAL: leaky2\/leaky2\.md:\d+（第 2\+3 层）/);
    const home3 = userOnlyRoots(tmp('sh-home4b-'));
    installed(home3, 'leaky3', { files: { 'scripts/run.py': 'import os\nkey = "ghp_abcdefghijklmnopqrstuvwxyz0123"\n' } });
    expect(() => shareAnts(home3, ['leaky3'], out, { owner: 'o' })).toThrow(/^HOPANT_CREDENTIAL_LITERAL: leaky3\/scripts\/run\.py:2（第 1 层）/);   // 变异 D23：只扫 md/yaml/json → 代码文件放行红
    const home4 = userOnlyRoots(tmp('sh-home4c-'));
    installed(home4, 'quiet', { files: { 'inner_store/secret.yaml': 'api_key: sk-abcdefghijklmnopqrstuvwxyz0123\n' } });
    expect(() => shareAnts(home4, ['quiet'], out, { owner: 'o' })).not.toThrow();   // 变异：核二不排除本机面 → 红
  });
  it('正（D19 警告档）：单层证据只警告不拦——L3 `token: abc123def`、L2 内容哈希;围栏内 L2+L3 降为警告;警告进 credential_scan.warnings 且包照写', () => {
    const home = userOnlyRoots(tmp('sh-home-w-')); const out = tmp('sh-out-w-');
    installed(home, 'warny', { files: { 'knowledge/notes.md': '# n\ntoken: abc123def\ncontent_hash: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\n```yaml\napi_key: 7f3a9c2e1b8d4f6a9c0e2b5d8f1a3c6e7f3a9c2e\n```\n' } });
    const r = shareAnts(home, ['warny'], out, { owner: 'o' });
    expect(existsSync(join(out, 'warny', 'package.json'))).toBe(true);
    expect(r.credential_scan.rejected).toEqual([]);
    expect(r.credential_scan.warnings.map(w => [w.line, w.layers])).toEqual([[2, [3]], [3, [2]], [5, [2, 3]]]);   // 变异：单层也拒 → 抛红;围栏不降档 → 抛红
    expect(r.credential_scan.warnings[2].reason).toContain('代码围栏');
  });
  it('反（G2/D22）：ids 空 / owner 空白 / 非法包名 → HOPANT_BAD_ID;`@scope/name` 合法;目标非空 → HOPANT_TARGET_EXISTS;入口 spec 坏 → HOPANT_SPEC_INVALID;有 lineage.yaml 时写谱系', () => {
    const home = userOnlyRoots(tmp('sh-home-g2-')); const out = tmp('sh-out-g2-');
    installed(home, 'g2');
    expect(() => shareAnts(home, [], out, { owner: 'o' })).toThrow(/^HOPANT_BAD_ID/);   // 变异 M26：ids 空不拒 → 红
    expect(() => shareAnts(home, ['g2'], out, { owner: '  ' })).toThrow(/^HOPANT_BAD_ID: 归属标识/);   // 变异 D22：模块不校验 owner → 红
    expect(() => shareAnts(home, ['g2'], out, { owner: 'o', name: 'Bad Name' })).toThrow(/^HOPANT_BAD_ID: 包名/);   // 变异 M3b：包名规则空转 → 红
    const r = shareAnts(home, ['g2'], out, { owner: 'o', name: '@scope/g2-pkg' });   // 变异 M3：PKG_NAME_RE 去 @scope/ → 抛红
    expect(existsSync(join(r.dir, 'package.json'))).toBe(true);
    expect(() => shareAnts(home, ['g2'], out, { owner: 'o', name: '@scope/g2-pkg' })).toThrow(/^HOPANT_TARGET_EXISTS/);   // 变异 M23 → 红
    const home2 = userOnlyRoots(tmp('sh-home-g2b-'));
    installed(home2, 'broken');
    writeFileSync(join(antDir(home2.user, 'broken'), 'broken.md'), '# Spec: b\nId: broken\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [nonsense] a\n  + → out % text\n');
    expect(() => shareAnts(home2, ['broken'], out, { owner: 'o' })).toThrow(/^HOPANT_SPEC_INVALID/);   // 变异 M39 → 红
    const home3 = userOnlyRoots(tmp('sh-home-g2c-'));
    installed(home3, 'lin');
    mkdirSync(join(antDir(home3.user, 'lin'), 'inner_store'), { recursive: true });
    writeFileSync(join(antDir(home3.user, 'lin'), 'inner_store', 'lineage.yaml'), 'origin: a/1\n');
    const r3 = shareAnts(home3, ['lin'], out, { owner: 'o' });
    expect(r3.checks.lineage_written).toEqual(['lin']);   // 变异 M18：谱系有也不写 → 红
    expect(JSON.parse(readFileSync(join(r3.dir, 'package.json'), 'utf-8')).hopant.ants.lin).toEqual({ lineage: { origin: 'a/1' } });
    expect(existsSync(join(r3.dir, 'ants', 'lin', 'inner_store'))).toBe(false);
  });
  it('反：入口 spec Id 与目录名不一致 → HOPANT_ID_MISMATCH;没装 → HOPANT_NOT_FOUND;doc-ref 文件不在目录（含步骤级）→ HOPANT_DOC_MISSING', () => {
    const home = userOnlyRoots(tmp('sh-home5-')); const out = tmp('sh-out5-');
    installed(home, 'mm');
    writeFileSync(join(antDir(home.user, 'mm'), 'mm.md'), SPEC('other-id'));   // 装后被改坏
    expect(() => shareAnts(home, ['mm'], out, { owner: 'o' })).toThrow(/^HOPANT_ID_MISMATCH/);
    expect(() => shareAnts(home, ['ghost'], out, { owner: 'o' })).toThrow(/^HOPANT_NOT_FOUND/);
    installed(home, 'dd', { extra: '## Constraints\n- 见 [[gone#节]]\n' });
    expect(() => shareAnts(home, ['dd'], out, { owner: 'o' })).toThrow(/^HOPANT_DOC_MISSING: dd .*gone/);
    installed(home, 'sd');
    writeFileSync(join(antDir(home.user, 'sd'), 'sd.md'), '# Spec: sd\nId: sd\nGoal: g\n## Outputs\n- out % text  # o\n## Steps\n1. [act free] a\n  + → out % text\n  > 参考 [[stepgone#节]]\n');
    expect(() => shareAnts(home, ['sd'], out, { owner: 'o' })).toThrow(/^HOPANT_DOC_MISSING: sd .*stepgone/);   // 变异 M40：share 侧 visitDocs 删 → 红
  });
  it('直测 scanCredentials（D19/G3）：三层各出证据——L1 十二形态逐个拒且示例文件不降档;L2+L3 叠加拒;单层警告;max_tokens / 环境变量名 / *_env / 占位 / $VAR / os.environ / UUID / 纯数字 全放行', () => {
    const l1 = [
      'a: sk-abcdefghijklmnopqrstuvwxyz0123', 'a: sk-ant-abcdefghijklmnopqrstuvwxyz0123', 'a: ghp_abcdefghijklmnopqrstuvwxyz0123', 'a: github_pat_abcdefghijklmnopqrstuvwxyz0123',
      'a: glpat-abcdefghijklmnopqrst', 'a: xoxb-1234567890-abcdefghij', 'a: AKIAABCDEFGHIJKLMNOP', 'a: AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'a: ya29.abcdefghijklmnopqrstuvwxyz', 'a: sk_live_abcdefghijklmnopqrstuv', 'a: SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuv',
      'a: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop', '-----BEGIN RSA PRIVATE KEY-----', 'url: https://user:pa55w0rd@host.example/path',
    ];
    const r1 = scanCredentials(l1.join('\n'), { file: 'x/sample.yaml' });   // 文件名含 sample——L1 仍拒不降档（变异：L1 也降档 → 红）
    expect(r1.rejected.map(h => h.line)).toEqual(l1.map((_, i) => i + 1));
    expect(r1.rejected.every(h => h.layers.join() === '1')).toBe(true);
    const mixed = [
      'api_key_env: MY_KEY',                 // 1 放行：*_env 键
      'api_key: MY_KEY',                     // 2 放行：环境变量名形态
      'token: ${TOKEN}',                     // 3 放行：占位
      'api_key: $OPENAI_KEY',                // 4 放行：$VAR 占位（变异：PLACEHOLDER 去 $VAR → 多报红）
      'token: 12345678901234567890',         // 5 放行：纯数字（变异：L3 不排纯数字 → 多报红;max_tokens: 4096 太短本就不满足 ≥8）
      'token_budget: 2000',                  // 6 放行
      'secret_sauce: recipe',                // 7 放行：无数字小写词
      'api_key: 123e4567-e89b-12d3-a456-426614174000',   // 8 警告（L3 单独）：带连字符 UUID 熵约 3.7 不过 L2 门槛（变异：L2 熵门槛降到 3.5 → 升级为 L2+L3 拒红）
      'api_key: 7f3a9c2e1b8d4f6a9c0e2b5d8f1a3c6e7f3a9c2e',   // 9 拒：L2+L3（变异：叠加不拒 → 红）
      'token: abc123def',                    // 10 警告：L3 单独
      'content_hash: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',   // 11 警告：L2 单独
      'passwd: Hunter2!x9', 'credential: Hunter2!x9', 'apikey: Hunter2!x9',   // 12-14 警告：三个键词（变异 G3：键词表丢 passwd/credential → 少报红）
    ];
    const r2 = scanCredentials(mixed.join('\n'), { file: 'x/cfg.yaml' });
    expect(r2.rejected.map(h => [h.line, h.layers])).toEqual([[9, [2, 3]]]);
    expect(r2.warnings.map(h => [h.line, h.layers])).toEqual([[8, [3]], [10, [3]], [11, [2]], [12, [3]], [13, [3]], [14, [3]]]);
    const code = 'token = os.environ["X"]\nkey = os.getenv("K")\nsecret = "Hunter2!x9"\n';
    const r3 = scanCredentials(code, { file: 'x/scripts/run.py' });
    expect(r3.rejected).toEqual([]);
    expect(r3.warnings.map(h => [h.line, h.layers])).toEqual([[3, [3]]]);   // 变异：L3 不排 os.environ 取值表达式 → 1/2 多报红
  });
});

// ---------- 两级 HopAnt 根：项目级 <项目>/hop_tasks/ants 先于用户级 <home>/.hopjit/ants（todo/0155,设计 hopant 决策 1 / 9） ----------
// @v: anc-hopant-home
describe('hopant：两级根（^anc-hopant-home 决策 1 / 9）', () => {
  /** 两级根各自一个临时目录;proj 是项目根,roots.project = <proj>/hop_tasks/ants */
  function twoRoots(): { home: string; proj: string; roots: AntRoots } {
    const home = tmp('hopant-home-'); const proj = tmp('hopant-proj-');
    return { home, proj, roots: antRoots(home, proj) };
  }
  /** 把一个新造的 HopAnt 来源装进指定一级 */
  function installTo(root: string, id: string, extra = ''): void {
    applyInstall(planInstall(makeAnt(tmp('hopant-src-'), id, { extra }), root));
  }
  // 起跑依赖核用的调用方 / 被调方 spec（与 checkRunDeps 组同形,call 步静态指向 callee id）
  const CALLER = (callee: string) => `# Spec: 调用方
Id: caller
Goal: 调一个子流程

## Outputs
- out % text  # 结果

## Steps
1. [act free] 备料
  + → q % text  # 词
2. [call ${callee}(q: q)] 调
  + → out: r  # 收取
`;
  const CALLEE = (id: string) => `# Spec: ${id}
Id: ${id}
Goal: 子流程

## Inputs
- q % text  # 词

## Outputs
- r % text  # 结果

## Steps
1. [act free] 干
  - ← q
  + → r % text  # 结果
`;

  // @v: anc-hopant-home
  it('正：antRoots 两级路径——project = <项目>/hop_tasks/ants,user = <home>/.hopjit/ants', () => {
    const { home, proj, roots } = twoRoots();
    expect(roots).toEqual({ project: join(proj, 'hop_tasks', 'ants'), user: join(home, '.hopjit', 'ants') });
    expect(roots.user).toBe(antsRoot(home));
  });

  // @v: anc-hopant-home
  it('正/反：resolveAnt——同 id 两级都有取项目级（遮蔽）;只有用户级取用户级;都没有 null', () => {
    const { roots } = twoRoots();
    installTo(roots.project, 'both'); installTo(roots.user, 'both');
    installTo(roots.user, 'only-user');
    expect(resolveAnt(roots, 'both')).toEqual({ dir: join(roots.project, 'both'), scope: 'project' });
    expect(resolveAnt(roots, 'only-user')).toEqual({ dir: join(roots.user, 'only-user'), scope: 'user' });
    expect(resolveAnt(roots, 'nobody')).toBeNull();
    // 在场判据与 listAntsIn 同：目录在但没有 <id>.md 入口 spec 不算（半拷贝残留不能遮住用户级的好件）
    mkdirSync(join(roots.project, 'only-user'), { recursive: true });
    expect(resolveAnt(roots, 'only-user')!.scope).toBe('user');
  });

  // @v: anc-hopant-home
  it('正：listAnts 合并——项目级全部在前（升序）,用户级在后;同 id 两级都有时两条都在、scope 不同', () => {
    const { roots } = twoRoots();
    installTo(roots.user, 'zed'); installTo(roots.user, 'dup'); installTo(roots.user, 'alpha');
    installTo(roots.project, 'proj-b'); installTo(roots.project, 'dup'); installTo(roots.project, 'proj-a');
    const got = listAnts(roots);
    expect(got.map(e => [e.id, e.scope])).toEqual([
      ['dup', 'project'], ['proj-a', 'project'], ['proj-b', 'project'],
      ['alpha', 'user'], ['dup', 'user'], ['zed', 'user'],
    ]);
    expect(got[0].dir).toBe(join(roots.project, 'dup'));
    expect(got[4].dir).toBe(join(roots.user, 'dup'));
    // 变异：项目级 / 用户级顺序对调 → 红;同 id 去重只留一条 → 红（用户要看得见被遮的那个）
  });

  // @v: anc-hopant-install
  it('正/反：planInstall 撞 id 只在本级判——用户级已有同 id,装项目级 ok（合法遮蔽）;装回用户级才是 conflict', () => {
    const { roots } = twoRoots();
    installTo(roots.user, 'same');
    installTo(roots.user, 'other-user');   // 用户级另有一个 id——它的索引在装项目级前后必须一字不变
    const src = makeAnt(tmp('hopant-src-'), 'same');
    const toProject = planInstall(src, roots.project);
    expect(toProject.ok).toBe(true);
    expect(toProject.root).toBe(roots.project);
    expect(toProject.ants[0]).toMatchObject({ id: 'same', conflict: false, dst: join(roots.project, 'same') });
    // @v: anc-hopant-index —— 装项目级只重建项目级索引,用户级 index.md 内容前后相同（变异：applyInstall 顺带重写另一级索引 → 红）
    const userIndexBefore = readFileSync(indexPath(roots.user), 'utf-8');
    expect(userIndexBefore).toContain('- other-user — other-user 标题');
    const r = applyInstall(toProject);
    expect(r.installed).toEqual(['same']);
    expect(existsSync(join(roots.project, 'same', 'same.md'))).toBe(true);
    expect(readFileSync(indexPath(roots.project), 'utf-8')).toContain('- same — same 标题');   // 只重建装进去的那一级索引
    expect(readFileSync(indexPath(roots.user), 'utf-8')).toBe(userIndexBefore);
    const toUser = planInstall(src, roots.user);
    expect(toUser.ok).toBe(false);
    expect(toUser.ants[0].conflict).toBe(true);
    expect(() => applyInstall(toUser)).toThrow(/HOPANT_ID_CONFLICT.*same/);
  });

  // @v: anc-hopant-install
  it('正/反：removeAnt——两级都有且不给 scope 删项目级返回 project,用户级留着;scope=user 删用户级;keepStore 对项目级 ant 也挪到 <home>/.hopjit/ants-store-backup/<id>/', () => {
    const { home, roots } = twoRoots();
    installTo(roots.project, 'twin'); installTo(roots.user, 'twin');
    expect(removeAnt(roots, 'twin', false)).toBe('project');
    expect(existsSync(join(roots.project, 'twin'))).toBe(false);
    expect(existsSync(join(roots.user, 'twin', 'twin.md'))).toBe(true);
    expect(resolveAnt(roots, 'twin')!.scope).toBe('user');   // 遮蔽物没了,用户级那份露出来
    // 指定 scope=user 时不走 resolveAnt——项目级重新装上也删的是用户级
    installTo(roots.project, 'twin');
    expect(removeAnt(roots, 'twin', false, 'user')).toBe('user');
    expect(existsSync(join(roots.user, 'twin'))).toBe(false);
    expect(existsSync(join(roots.project, 'twin', 'twin.md'))).toBe(true);
    // 指定 scope 但那一级没有 → null,不会退而删另一级
    expect(removeAnt(roots, 'twin', false, 'user')).toBeNull();
    expect(existsSync(join(roots.project, 'twin', 'twin.md'))).toBe(true);
    // keepStore：项目级 ant 的 inner_store 也挪到用户主目录下的备份位（两级共用,由 roots.user 上溯 home）
    writeFileSync(join(roots.project, 'twin', 'inner_store', 'data.txt'), 'proj data', 'utf-8');
    expect(removeAnt(roots, 'twin', true)).toBe('project');
    expect(readFileSync(join(home, '.hopjit', 'ants-store-backup', 'twin', 'data.txt'), 'utf-8')).toBe('proj data');
    expect(existsSync(join(roots.project, 'twin'))).toBe(false);
    expect(removeAnt(roots, 'twin', false)).toBeNull();
  });

  // @v: anc-hopant-callee-resolve
  it('正/反：resolveCalleeSpecPath 三级——同目录 > 项目根 > 用户根;roots 为 null 只查同目录', () => {
    const { roots } = twoRoots();
    const caller = tmp('hopant-caller-');
    installTo(roots.project, 'tri'); installTo(roots.user, 'tri');
    installTo(roots.project, 'proj-only'); installTo(roots.user, 'user-only');
    installTo(roots.user, 'shadowed'); installTo(roots.project, 'shadowed');
    writeFileSync(join(caller, 'tri.md'), SPEC('tri'), 'utf-8');
    expect(resolveCalleeSpecPath(caller, roots, 'tri')).toBe(join(caller, 'tri.md'));
    expect(resolveCalleeSpecPath(caller, roots, 'shadowed')).toBe(join(roots.project, 'shadowed', 'shadowed.md'));   // 变异：两级顺序对调 → 红
    expect(resolveCalleeSpecPath(caller, roots, 'proj-only')).toBe(join(roots.project, 'proj-only', 'proj-only.md'));
    expect(resolveCalleeSpecPath(caller, roots, 'user-only')).toBe(join(roots.user, 'user-only', 'user-only.md'));
    expect(resolveCalleeSpecPath(caller, roots, 'nobody')).toBeNull();
    expect(resolveCalleeSpecPath(caller, null, 'tri')).toBe(join(caller, 'tri.md'));
    expect(resolveCalleeSpecPath(caller, null, 'proj-only')).toBeNull();
    expect(resolveCalleeSpecPath(caller, null, 'user-only')).toBeNull();
  });

  // @v: anc-hopant-commit-store
  it('正/反：commitApprovalStorePath——spec 在项目根下 → 项目级 inner_store;在用户根下 → 用户级 inner_store;其余 → <runRootParent>/commit_approvals.json', () => {
    const { proj, roots } = twoRoots();
    mkdirSync(roots.project, { recursive: true }); mkdirSync(roots.user, { recursive: true });   // 两级目录真建出来,realpath 走解析分支
    const p = realpathSync(roots.project); const u = realpathSync(roots.user);
    expect(commitApprovalStorePath(roots, join(p, 'pa', 'pa.md'), '/run/.hopstate')).toBe(join(p, 'pa', 'inner_store', 'commit_approvals.json'));
    expect(commitApprovalStorePath(roots, join(u, 'ua', 'ua.md'), '/run/.hopstate')).toBe(join(u, 'ua', 'inner_store', 'commit_approvals.json'));
    expect(commitApprovalStorePath(roots, join(realpathSync(proj), 'hop_tasks', 'task-x', 'task-x.md'), '/run/.hopstate')).toBe(join('/run/.hopstate', 'commit_approvals.json'));   // hop_tasks/ 下但不在 ants/ 内的任务卡不算 HopAnt
    expect(commitApprovalStorePath(roots, join(p, 'stray.md'), '/run/.hopstate')).toBe(join('/run/.hopstate', 'commit_approvals.json'));
    expect(dirsApprovalStorePath(roots, join(p, 'pa', 'pa.md'), '/run/.hopstate')).toBe(join(p, 'pa', 'inner_store', 'dirs_approvals.json'));
  });

  // @v: anc-hopant-run-deps
  it('正：checkRunDeps——call 目标只装在项目级也算找得到,ok 且 calls.missing 空;被调方的 Tools 照样递归核', () => {
    const { roots } = twoRoots();
    const dir = tmp('hopant-caller-');
    installTo(roots.project, 'foo');
    const c = join(dir, 'caller.md'); writeFileSync(c, CALLER('foo'), 'utf-8');
    const r = checkRunDeps(readFileSync(c, 'utf-8'), c, { roots, tool_servers: [] });
    expect(r.ok).toBe(true);
    expect(r.calls.missing).toEqual([]);
    expect(r.hints).toEqual([]);
    // 项目级 foo 声明了没注册的工具 → 缺口以 foo 的名义报出（证明递归核到的是项目级那份）
    writeFileSync(join(roots.project, 'foo', 'foo.md'), CALLEE('foo').replace('## Inputs', '## Tools\n- my_search(query) -> r % yaml  # 搜\n  - query % text  # 词\n\n## Inputs'), 'utf-8');
    const r2 = checkRunDeps(readFileSync(c, 'utf-8'), c, { roots, tool_servers: [] });
    expect(r2.ok).toBe(false);
    expect(r2.tools.missing).toEqual(['foo: my_search']);
  });

  // @v: anc-hopant-share
  it('正：shareAnts——只装在项目级的 HopAnt 也能分享,包里有 ants/<id>/<id>.md', () => {
    const { roots } = twoRoots();
    const out = tmp('hopant-share-out-');
    installTo(roots.project, 'x');
    const r = shareAnts(roots, ['x'], out, { owner: 'o' });
    expect(r.ants).toEqual(['x']);
    expect(r.dir).toBe(join(out, 'x'));
    expect(existsSync(join(out, 'x', 'ants', 'x', 'x.md'))).toBe(true);
    expect(existsSync(join(out, 'x', 'ants', 'x', 'knowledge', 'glossary.md'))).toBe(true);
    expect(existsSync(join(out, 'x', 'ants', 'x', 'inner_store'))).toBe(false);
    // 同 id 两级都有时分享的是项目级那份（决策 9）
    installTo(roots.user, 'x', '## Constraints\n- 用户级那份\n');
    const out2 = tmp('hopant-share-out-');
    shareAnts(roots, ['x'], out2, { owner: 'o' });
    expect(readFileSync(join(out2, 'x', 'ants', 'x', 'x.md'), 'utf-8')).not.toContain('用户级那份');
  });

  // @v: anc-hopant-home
  it('正：rebuildIndex 对不存在的空根返回 0 且不建目录——项目里不无故长出 hop_tasks/ants/', () => {
    const { proj, roots } = twoRoots();
    expect(existsSync(roots.project)).toBe(false);
    expect(rebuildIndex(roots.project)).toBe(0);
    expect(existsSync(roots.project)).toBe(false);
    expect(existsSync(join(proj, 'hop_tasks'))).toBe(false);
    // 索引本来就在（之前装过后来全卸了）→ 照常重写成空索引
    mkdirSync(roots.project, { recursive: true }); writeFileSync(indexPath(roots.project), '- stale\n', 'utf-8');
    expect(rebuildIndex(roots.project)).toBe(0);
    expect(readFileSync(indexPath(roots.project), 'utf-8')).not.toContain('stale');
  });

  // @v: anc-hopant-home
  it('反：resolveAnt 对带路径分隔符 / .. / 空串的 id 抛 HOPANT_BAD_ID,不拼路径去查盘', () => {
    const { roots } = twoRoots();
    installTo(roots.user, 'id');
    expect(() => resolveAnt(roots, 'Bad/../id')).toThrow(/HOPANT_BAD_ID/);   // 变异：antDir 换成 join 绕过校验 → 解析到 <root>/id 命中,不抛,红
    expect(() => resolveAnt(roots, '')).toThrow(/HOPANT_BAD_ID/);
    expect(() => resolveAnt(roots, '../id')).toThrow(/HOPANT_BAD_ID/);
  });

  // @v: anc-mcp-admin-tools
  it('正：hop-admin.antInstall 不传 scope → 缺省装进 roots.user,项目级不长出目录,响应 scope 为 user', () => {
    const { home, proj, roots } = twoRoots();
    const ctx: AdminContext = { home, cwd: proj, env: {}, exec_path: process.execPath, login: 'u', hostname: 'h', roots };
    const src = makeAnt(tmp('hopant-src-'), 'dflt');
    const res = antInstall(ctx, src, false);   // 第四参缺席——走函数自己的缺省值（变异 M7：缺省改 'project' → 本例红）
    expect(res.scope).toBe('user');
    expect((res.plan as { root: string }).root).toBe(roots.user);
    expect(existsSync(join(antDir(roots.user, 'dflt'), 'dflt.md'))).toBe(true);
    expect(existsSync(join(roots.project, 'dflt'))).toBe(false);
    expect(existsSync(join(proj, 'hop_tasks'))).toBe(false);   // 项目里不无故长出 hop_tasks/
    // dry_run 也带同一个缺省 scope
    const dry = antInstall(ctx, makeAnt(tmp('hopant-src-'), 'dflt2'), true);
    expect(dry.scope).toBe('user');
    expect(existsSync(join(roots.user, 'dflt2'))).toBe(false);
  });
});

describe('dirsApprovalStorePath（与 commit 账同目录,文件名 dirs_approvals.json）', () => {
  const ants = join('/home', 'u', '.hopjit', 'ants');
  const roots: AntRoots = { project: join('/proj', 'hop_tasks', 'ants'), user: ants };   // 项目级根不存在,realpath 失败回退原值
  it('正例：HopAnt 内 spec → <antDir>/inner_store/dirs_approvals.json;项目 spec → <state_dir>/dirs_approvals.json;恒等于 dirname(commit 账) + dirs_approvals.json', () => {
    for (const [spec, run] of [[join(ants, 'demo', 'demo.md'), '/proj/.hopstate'], ['/proj/hop_tasks/a/a.md', '/proj/.hopstate'], [join(ants, 'demo', 'sub', 'x.md'), '/x/.hopstate']] as const) {
      const d = dirsApprovalStorePath(roots, spec, run);
      expect(d.endsWith('/dirs_approvals.json')).toBe(true);
      expect(d).toBe(join(dirname(commitApprovalStorePath(roots, spec, run)), 'dirs_approvals.json'));
    }
    expect(dirsApprovalStorePath(roots, join(ants, 'demo', 'demo.md'), '/proj/.hopstate')).toBe(join(ants, 'demo', 'inner_store', 'dirs_approvals.json'));
    expect(dirsApprovalStorePath(roots, '/proj/hop_tasks/a/a.md', '/proj/.hopstate')).toBe('/proj/.hopstate/dirs_approvals.json');
  });
});

describe('commitApprovalStorePath', () => {
  const ants = join('/home', 'u', '.hopjit', 'ants');
  const roots: AntRoots = { project: join('/proj', 'hop_tasks', 'ants'), user: ants };   // 项目级根不存在,realpath 失败回退原值
  it('正例：HopAnt 目录内的 spec（含嵌套子目录）→ <antDir>/inner_store/commit_approvals.json', () => {
    expect(commitApprovalStorePath(roots, join(ants, 'demo', 'demo.md'), '/proj/.hopstate'))
      .toBe(join(ants, 'demo', 'inner_store', 'commit_approvals.json'));
    expect(commitApprovalStorePath(roots, join(ants, 'demo', 'sub', 'x.md'), '/proj/.hopstate'))
      .toBe(join(ants, 'demo', 'inner_store', 'commit_approvals.json'));
  });
  it('正例：项目内 spec / 任务卡 → <run 根上一级>/commit_approvals.json', () => {
    expect(commitApprovalStorePath(roots, '/proj/hop_tasks/a/a.md', '/proj/.hopstate'))
      .toBe(join('/proj/.hopstate', 'commit_approvals.json'));
  });
  it('反例：ants 根下直接放的文件不算 HopAnt（少一层目录）;同名前缀目录不算 ants 根内', () => {
    expect(commitApprovalStorePath(roots, join(ants, 'stray.md'), '/p/.hopstate')).toBe(join('/p/.hopstate', 'commit_approvals.json'));
    expect(commitApprovalStorePath(roots, ants + '-other/x/y.md', '/p/.hopstate')).toBe(join('/p/.hopstate', 'commit_approvals.json'));
  });
  it('正例：ants 根经软链（HOME 是软链）、specPath 是解析过软链的真实路径 → 仍落 inner_store（两边按同一口径解析）', () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'ants-real-')));
    mkdirSync(join(real, 'ants', 'demo'), { recursive: true });
    writeFileSync(join(real, 'ants', 'demo', 'demo.md'), '# d\n');
    const link = join(mkdtempSync(join(tmpdir(), 'ants-link-')), 'home');
    symlinkSync(real, link);
    expect(commitApprovalStorePath({ project: join('/nope', 'hop_tasks', 'ants'), user: join(link, 'ants') }, join(real, 'ants', 'demo', 'demo.md'), '/p/.hopstate'))
      .toBe(join(real, 'ants', 'demo', 'inner_store', 'commit_approvals.json'));
  });
});
