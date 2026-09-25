// @module: doc-ref ^anc-struct-doc-ref
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractDocRefs, sliceSection, resolveDocRefs, checkDocRefExists,
  formatDocRefContext, DocRefError, expandHopEnv, sliceYamlKey, sliceByFileType } from '../src/doc-ref.js';
import type { SandboxConfig } from '../src/provider-types.js';

function sandboxFor(dir: string): SandboxConfig {
  return {
    filesystem: { workspace_dir: dir, read_access: { allowed: [dir], denied: [], confirm_required: [] } },
    network: { trusted_hosts: [] },
    runtime: { available: [] },
  };
}

const SAMPLE = [
  '# 设计规范',
  '',
  '## 一、设计理念',
  '理念正文。',
  '',
  '## 二、色板',
  '主色 #003BFF。',
  '### 主色系',
  '深蓝青绿。',
  '',
  '## 四、组件库',
  '组件总述。',
  '### 4.7 统计框',
  'stat-box 用法。',
  '### 4.8 对比框',
  'compare-box 用法。',
  '',
  '## 五、布局',
  '布局正文。',
].join('\n');

// @v: anc-rule-doc-ref-extract
describe('extractDocRefs', () => {
  it('提取 [[doc#章节]]', () => {
    expect(extractDocRefs('见 [[design#色板]] 一节')).toEqual([{ doc: 'design', section: '色板' }]);
  });

  it('忽略 |别名 后缀', () => {
    expect(extractDocRefs('[[design#色板|看色板]]')).toEqual([{ doc: 'design', section: '色板' }]);
  });

  it('排除 #^ 段落锚点反链', () => {
    expect(extractDocRefs('[[doc#^anc-foo]] 和 [[doc#色板]]')).toEqual([{ doc: 'doc', section: '色板' }]);
  });

  it('无 # 的纯 [[doc]] 不提取（整文档引用不支持）', () => {
    expect(extractDocRefs('[[design]] 整篇')).toEqual([]);
  });

  it('同一 (doc, section) 去重', () => {
    expect(extractDocRefs('[[d#a]] ... [[d#a]]')).toEqual([{ doc: 'd', section: 'a' }]);
  });

  it('多引用 + 带路径', () => {
    expect(extractDocRefs('[[办公/规范#二、色板]] [[办公/规范#四、组件库]]')).toEqual([
      { doc: '办公/规范', section: '二、色板' },
      { doc: '办公/规范', section: '四、组件库' },
    ]);
  });

  it('空文本返回空', () => {
    expect(extractDocRefs('')).toEqual([]);
  });
});

// @v: anc-exec-doc-ref-resolve
describe('sliceSection', () => {
  const lines = SAMPLE.split('\n');

  it('精确匹配整章节', () => {
    const r = sliceSection(lines, '一、设计理念');
    expect(r.matched).toBe('exact');
    expect(r.heading).toBe('一、设计理念');
    expect(r.content).toBe('理念正文。');
  });

  it('归一化序号匹配（#色板 命中 ## 二、色板）', () => {
    const r = sliceSection(lines, '色板');
    expect(r.matched).toBe('normalized');
    expect(r.heading).toBe('二、色板');
    // 含子标题 ### 主色系，切到下一同级 ## 四、组件库 为止
    expect(r.content).toContain('主色 #003BFF。');
    expect(r.content).toContain('### 主色系');
    expect(r.content).not.toContain('组件总述');
  });

  it('子标题切片不越界到同级下一节', () => {
    const r = sliceSection(lines, '4.7 统计框');
    expect(r.matched).toBe('exact');
    expect(r.content).toContain('stat-box 用法。');
    expect(r.content).not.toContain('compare-box');
  });

  it('归一化匹配 4.7（写 统计框）', () => {
    const r = sliceSection(lines, '统计框');
    expect(r.matched).toBe('normalized');
    expect(r.heading).toBe('4.7 统计框');
  });

  it('切到 EOF', () => {
    const r = sliceSection(lines, '五、布局');
    expect(r.content).toBe('布局正文。');
  });

  it('找不到返回 none', () => {
    expect(sliceSection(lines, '不存在的章节').matched).toBe('none');
  });

  it('归一化不误剥中文数字开头的真词（第三方/十全大补）', () => {
    const ls = ['## 第三方接入', 'A', '## 十全大补', 'B'].join('\n').split('\n');
    expect(sliceSection(ls, '第三方接入').matched).toBe('exact');
    expect(sliceSection(ls, '十全大补').matched).toBe('exact');
    // 写"接入"应子串兜底命中"第三方接入"，而非把"第三方"误当序号
    expect(sliceSection(ls, '接入').heading).toBe('第三方接入');
  });

  it('跳过 fence 内伪标题', () => {
    const fenced = ['## 真标题', '正文', '```', '## 假标题（fence 内）', '```', '尾部'].join('\n');
    const r = sliceSection(fenced.split('\n'), '真标题');
    expect(r.matched).toBe('exact');
    expect(r.content).toContain('## 假标题');  // fence 内的不被当作切片边界
    expect(r.content).toContain('尾部');
  });

  it('父章节包含其下所有子标题', () => {
    const r = sliceSection(lines, '四、组件库');
    expect(r.content).toContain('### 4.7 统计框');
    expect(r.content).toContain('### 4.8 对比框');
    expect(r.content).not.toContain('布局正文');
  });

  // F类补齐（2026-08-08 审计）：fuzzy 级别与 ambiguous 多命中此前无显式断言
  it('子串兜底命中 → matched=fuzzy 且单命中不标 ambiguous', () => {
    const ls = ['## 第三方接入', 'A'].join('\n').split('\n');
    const r = sliceSection(ls, '接入');
    expect(r.matched).toBe('fuzzy');
    expect(r.ambiguous).toBe(false);
  });

  it('子串多命中 → 取首个 + ambiguous=true', () => {
    const ls = ['## 部署准备', 'A', '## 部署执行', 'B'].join('\n').split('\n');
    const r = sliceSection(ls, '部署');
    expect(r.matched).toBe('fuzzy');
    expect(r.ambiguous).toBe(true);
    expect(r.heading).toBe('部署准备');   // 文档序取首
    expect(r.content).toBe('A');
  });
});

// @v: anc-exec-doc-ref-resolve
// @v: anc-exec-doc-ref-yaml-slice — YAML 键切片（R10 sandbox 实撞:规则表存 YAML 是语料常态,
// 原先锚点只认 Markdown 标题,YAML 顶层键报"章节未匹配"只能整读或散文指路）
describe('sliceYamlKey（YAML 键切片）', () => {
  const YAML_SAMPLE = [
    '# 文件头注释',
    '',
    'kb:',
    '  version: "2.2"',
    '  # ============',
    '  # 铲除流程说明块',
    '  # ============',
    '  teardown:',
    '    rule: |',
    '      先停 operator 再清资源',
    '    steps:',
    '      - step1',
    '      - step2',
    '  faults:',
    '    TD-001:',
    '      symptom: 挂起',
    '    TD-002:',
    '      symptom: D状态',
    'other_top:',
    '  teardown: 同名键在别处',
  ];

  it('正例：单键名深度优先首命中——切键行自身+子树+上方紧邻注释块', () => {
    const r = sliceYamlKey(YAML_SAMPLE, 'teardown');
    expect(r.matched).toBe('fuzzy');   // 两处同名,取首+标歧义
    expect(r.ambiguous).toBe(true);
    expect(r.content).toContain('teardown:');          // 键行自身在切片内
    expect(r.content).toContain('铲除流程说明块');       // 紧邻注释块带入
    expect(r.content).toContain('先停 operator');       // 子树在
    expect(r.content).not.toContain('TD-001');          // 兄弟键不越界
    expect(r.content).not.toContain('同名键在别处');     // 首命中,不是 other_top 下的
  });

  it('正例：点路径精确逐层下钻——嵌套键唯一定位,单命中零歧义', () => {
    const r = sliceYamlKey(YAML_SAMPLE, 'kb.teardown');
    expect(r.matched).toBe('exact');
    expect(r.ambiguous).toBeFalsy();
    expect(r.content).toContain('先停 operator');
    const r2 = sliceYamlKey(YAML_SAMPLE, 'other_top.teardown');
    expect(r2.content).toContain('同名键在别处');   // 点路径能定位到另一处
  });

  it('反例：不存在的键 → matched none（P15/运行期报"章节未匹配"的判据源）', () => {
    expect(sliceYamlKey(YAML_SAMPLE, 'no_such').matched).toBe('none');
    expect(sliceYamlKey(YAML_SAMPLE, 'kb.no_such').matched).toBe('none');
    expect(sliceYamlKey(YAML_SAMPLE, 'teardown.rule.deeper_than_exists').matched).toBe('none');
  });

  it('反例：点路径跳级不命中——a 档限直接子级,跳过中间层报 none（阅卷可执行反例回归钉:kb.rule 跳过 teardown 层）', () => {
    // kb 的直接子级是 version/teardown/faults;rule 在 teardown 之下,kb.rule 是跳级
    expect(sliceYamlKey(YAML_SAMPLE, 'kb.rule').matched).toBe('none');
    // 全路径写齐才命中
    expect(sliceYamlKey(YAML_SAMPLE, 'kb.teardown.rule').matched).toBe('exact');
  });

  it('反例：注释行与值行不误判为键——#开头是注释,块标量内容行无冒号形态不入键表', () => {
    // "# 铲除流程说明块" 不是键;"      先停 operator 再清资源" 不是键
    expect(sliceYamlKey(YAML_SAMPLE, '铲除流程说明块').matched).toBe('none');
    expect(sliceYamlKey(YAML_SAMPLE, '先停 operator 再清资源').matched).toBe('none');
  });

  it('正例：引号键剥引号后同判——"quoted key": 按 quoted key 寻址命中（review 变异 E 实抓零钉后补）', () => {
    const lines = ['top:', '  "quoted key": v1', "  'single quoted': v2", '  normal: v3'];
    expect(sliceYamlKey(lines, 'quoted key').matched).toBe('exact');
    expect(sliceYamlKey(lines, 'quoted key').content).toContain('"quoted key": v1');
    expect(sliceYamlKey(lines, 'single quoted').matched).toBe('exact');
  });

  it('反例：带冒号的注释行不入键表——# 注意: xxx 不被误判为键（review 变异 B 实抓零钉后补:误判会污染键表波及切区间与点路径最浅缩进计算）', () => {
    const lines = ['kb:', '  # 注意: 这里是带冒号的注释', '  real_key: v'];
    expect(sliceYamlKey(lines, '# 注意').matched).toBe('none');
    expect(sliceYamlKey(lines, '注意').matched).toBe('none');
    // 且注释行不作为键行参与切区间边界:real_key 的切片不受它干扰
    const r = sliceYamlKey(lines, 'kb.real_key');
    expect(r.matched).toBe('exact');
  });

  it('反例：candidatePaths 对 .yaml 不追加 .md 兜底——只有 faults.yaml.md 在场时 [[faults.yaml#k]] 报文件未找到,不静默兜底命中错文件（review 变异 C 实抓零钉后补:兜底命中 .md 走 Markdown 档是 P15 假绿+错料注入的最坏形态）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docref-nofallback-'));
    writeFileSync(join(dir, 'faults.yaml.md'), '## k\nmd 正文');
    const err = checkDocRefExists(dir, sandboxFor(dir), { doc: 'faults.yaml', section: 'k' });
    expect(err).toContain('文件未找到');
    expect(() => resolveDocRefs([{ doc: 'faults.yaml', section: 'k' }], dir, sandboxFor(dir), '')).toThrow(/文件未找到/);
  });

  it('反例：与键行之间隔空行的注释块不带入——空行阻隔判据（review 面三盘点无反例后补）', () => {
    const lines = ['# 远处的注释', '', 'k:', '  v: 1'];
    const r = sliceYamlKey(lines, 'k');
    expect(r.matched).toBe('exact');
    expect(r.content).not.toContain('远处的注释');
  });

  it('正例：单键名单命中 → matched exact 且不标 ambiguous（review 面三盘点半边缺后补）', () => {
    const lines = ['only_key:', '  v: 1'];
    const r = sliceYamlKey(lines, 'only_key');
    expect(r.matched).toBe('exact');
    expect(r.ambiguous).toBeFalsy();
  });

  it('正例：零缩进/同列序列项不截断切片——- 项行不是键行不作出块边界（业界对照调研抓坑后补:GitHub Actions/K8s 清单最常见写法,修前切片在首个序列项处静默截断,唯一 P15 兜不住的切错形态）', () => {
    // 形态一:序列项与父键完全同列
    const flat = ['steps:', '- name: checkout', '  run: git checkout', '- name: test', '  run: npm test', 'after: done'];
    const r1 = sliceYamlKey(flat, 'steps');
    expect(r1.matched).toBe('exact');
    expect(r1.content).toContain('checkout');
    expect(r1.content).toContain('npm test');
    expect(r1.content).not.toContain('after');
    // 形态二:嵌套内缩进序列
    const nested = ['jobs:', '  build:', '    steps:', '    - name: checkout', '      run: x', '  deploy:', '    x: 1'];
    const r2 = sliceYamlKey(nested, 'steps');
    expect(r2.content).toContain('checkout');
    expect(r2.content).not.toContain('deploy');
    // 序列项内部的键(缩进更深)照常可寻址
    expect(sliceYamlKey(flat, 'run').matched).toBe('fuzzy');   // 两处 run,首命中+歧义
  });

  it('分流：sliceByFileType 按扩展名走档——.yaml 键切/.md 标题切互不越界', () => {
    const mdLines = ['# 标题', '## teardown', 'md 正文'];
    const asMd = sliceByFileType('/x/a.md', mdLines, 'teardown');
    expect(asMd.content).toBe('md 正文');                       // md 档:命中行+1 起
    const asYaml = sliceByFileType('/x/a.yaml', YAML_SAMPLE, 'kb.teardown');
    expect(asYaml.content).toContain('teardown:');              // yaml 档:含键行
    const asYml = sliceByFileType('/x/a.YML', YAML_SAMPLE, 'kb');
    expect(asYml.matched).toBe('exact');                        // .yml 大小写不敏感
  });

  it('端到端：resolveDocRefs 对 .yaml 文件按键注入(R10 实撞同构回归钉)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docref-yaml-'));
    writeFileSync(join(dir, 'faults.yaml'), YAML_SAMPLE.join('\n'));
    const frags = resolveDocRefs([{ doc: 'faults.yaml', section: 'kb.teardown' }], dir, sandboxFor(dir), '');
    expect(frags).toHaveLength(1);
    expect(frags[0].content).toContain('先停 operator');
    // 静态核同判据(修前此形态报"章节未匹配"):
    expect(checkDocRefExists(dir, sandboxFor(dir), { doc: 'faults.yaml', section: 'kb.teardown' })).toBeNull();
    expect(checkDocRefExists(dir, sandboxFor(dir), { doc: 'faults.yaml', section: 'no_such' })).toContain('章节未匹配');
  });
});

describe('resolveDocRefs', () => {
  function setup(): string {
    const dir = mkdtempSync(join(tmpdir(), 'docref-'));
    writeFileSync(join(dir, 'spec.md'), SAMPLE);
    return dir;
  }

  it('解析小节内联（无 file_path）', () => {
    const dir = setup();
    const frags = resolveDocRefs([{ doc: 'spec', section: '色板' }], dir, sandboxFor(dir), '');
    expect(frags).toHaveLength(1);
    expect(frags[0].content).toContain('主色 #003BFF');
    expect(frags[0].file_path).toBeUndefined();
  });

  it('.md 后缀兜底（写 spec 命中 spec.md）', () => {
    const dir = setup();
    const frags = resolveDocRefs([{ doc: 'spec', section: '设计理念' }], dir, sandboxFor(dir), '');
    expect(frags[0].content).toBe('理念正文。');
  });

  it('同文件多章节只读一次（缓存）+ 各自切片', () => {
    const dir = setup();
    const frags = resolveDocRefs(
      [{ doc: 'spec', section: '色板' }, { doc: 'spec', section: '布局' }], dir, sandboxFor(dir), '');
    expect(frags).toHaveLength(2);
    expect(frags[1].content).toBe('布局正文。');
  });

  it('大节超阈走 $file 卸载（有 workZone）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docref-'));
    const big = '## 大章节\n' + 'x'.repeat(5000);
    writeFileSync(join(dir, 'big.md'), big);
    const workZone = mkdtempSync(join(tmpdir(), 'work_zone-'));
    const frags = resolveDocRefs([{ doc: 'big', section: '大章节' }], dir, sandboxFor(dir), workZone);
    expect(frags[0].file_path).toBeDefined();
    expect(existsSync(frags[0].file_path!)).toBe(true);
    expect(readFileSync(frags[0].file_path!, 'utf-8').length).toBeGreaterThan(4096);
  });

  it('独立模式（workZone 空串）大节内联不卸载', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docref-'));
    writeFileSync(join(dir, 'big.md'), '## 大章节\n' + 'x'.repeat(5000));
    const frags = resolveDocRefs([{ doc: 'big', section: '大章节' }], dir, sandboxFor(dir), '');
    expect(frags[0].file_path).toBeUndefined();
    expect(frags[0].content.length).toBeGreaterThan(4096);
  });

  // @v: anc-exec-llm-inline-context — inlineMode 三档（todo/0115 v3:本步有没有 read 决定大节给预览还是全文）
  it("inlineMode='full' 超 20K 大节全文内联——不落盘不产预览", () => {
    const dir = mkdtempSync(join(tmpdir(), 'docref-'));
    writeFileSync(join(dir, 'big.md'), '## 大章节\n' + 'x'.repeat(24000));
    const workZone = mkdtempSync(join(tmpdir(), 'work_zone-'));
    const frags = resolveDocRefs([{ doc: 'big', section: '大章节' }], dir, sandboxFor(dir), workZone, undefined, undefined, 'full');
    expect(frags[0].file_path).toBeUndefined();
    expect(frags[0].preview).toBeUndefined();
    expect(frags[0].content.length).toBe(24000);
    expect(existsSync(join(workZone, 'docref'))).toBe(false);
  });

  it("inlineMode='full' 中节（4K-20K）不落进 deflate 分支——全文内联无 file_path（BUG-H 不复发）", () => {
    const dir = mkdtempSync(join(tmpdir(), 'docref-'));
    writeFileSync(join(dir, 'big.md'), '## 大章节\n' + 'x'.repeat(5000));
    const workZone = mkdtempSync(join(tmpdir(), 'work_zone-'));
    const frags = resolveDocRefs([{ doc: 'big', section: '大章节' }], dir, sandboxFor(dir), workZone, undefined, undefined, 'full');
    expect(frags[0].file_path).toBeUndefined();
    expect(frags[0].content.length).toBe(5000);
  });

  it("inlineMode='preview' 超 20K 大节转预览——头部节选+全文落盘", () => {
    const dir = mkdtempSync(join(tmpdir(), 'docref-'));
    writeFileSync(join(dir, 'big.md'), '## 大章节\n' + 'x'.repeat(24000));
    const workZone = mkdtempSync(join(tmpdir(), 'work_zone-'));
    const frags = resolveDocRefs([{ doc: 'big', section: '大章节' }], dir, sandboxFor(dir), workZone, undefined, undefined, 'preview');
    expect(frags[0].preview!.length).toBe(20000);
    expect(frags[0].full_chars).toBe(24000);
    expect(readFileSync(frags[0].file_path!, 'utf-8').length).toBe(24000);
  });

  it("inlineMode='preview' 中节（4K-20K）全文内联——不预览也不 deflate", () => {
    const dir = mkdtempSync(join(tmpdir(), 'docref-'));
    writeFileSync(join(dir, 'big.md'), '## 大章节\n' + 'x'.repeat(5000));
    const workZone = mkdtempSync(join(tmpdir(), 'work_zone-'));
    const frags = resolveDocRefs([{ doc: 'big', section: '大章节' }], dir, sandboxFor(dir), workZone, undefined, undefined, 'preview');
    expect(frags[0].file_path).toBeUndefined();
    expect(frags[0].preview).toBeUndefined();
    expect(frags[0].content.length).toBe(5000);
  });

  it('文件不存在抛 DocRefError', () => {
    const dir = setup();
    expect(() => resolveDocRefs([{ doc: 'missing', section: 'x' }], dir, sandboxFor(dir), ''))
      .toThrow(DocRefError);
  });

  it('章节不存在抛 DocRefError', () => {
    const dir = setup();
    expect(() => resolveDocRefs([{ doc: 'spec', section: '不存在' }], dir, sandboxFor(dir), ''))
      .toThrow(DocRefError);
  });

  it('sandbox 拒绝越界路径（绝对路径）', () => {
    const dir = setup();
    expect(() => resolveDocRefs([{ doc: '/etc/passwd', section: 'x' }], dir, sandboxFor(dir), ''))
      .toThrow(/Absolute paths are forbidden/);
  });

  it('sandbox 拒绝路径穿越 ..', () => {
    const dir = setup();
    expect(() => resolveDocRefs([{ doc: '../secret', section: 'x' }], dir, sandboxFor(dir), ''))
      .toThrow(/Path traversal/);
  });
});

// @v: anc-exec-doc-ref-resolve — 解析基准两级（2026-08-20 作者定目录三层归位:spec 目录=自包含
// 单元优先/workspace=作业对象根兜底;audit spec 同住知识文档 MCP standalone 实撞立）
describe('resolveDocRefs 两级基准（spec 目录优先/workspace 兜底）', () => {
  function setupSplit(): { ws: string; specDir: string } {
    const ws = mkdtempSync(join(tmpdir(), 'docref-ws-'));
    const specDir = mkdtempSync(join(tmpdir(), 'docref-spec-'));
    return { ws, specDir };
  }
  // 沙箱=workspace+specDir 双授权（init 组合点"随 spec 引用即授权"的测试等价形态）
  function sandboxBoth(ws: string, specDir: string): SandboxConfig {
    return {
      filesystem: { workspace_dir: ws, read_access: { allowed: [ws, specDir], denied: [], confirm_required: [] } },
      network: { trusted_hosts: [] },
      runtime: { available: [] },
    };
  }

  it('正例:知识文档只在 spec 目录（workspace 无此文件）→ 第一级命中', () => {
    const { ws, specDir } = setupSplit();
    writeFileSync(join(specDir, 'knowledge.md'), SAMPLE);
    const frags = resolveDocRefs([{ doc: 'knowledge', section: '色板' }], ws, sandboxBoth(ws, specDir), '', undefined, specDir);
    expect(frags[0].content).toContain('主色 #003BFF');
  });

  it('正例:两处同名 → spec 目录赢（自包含语义）', () => {
    const { ws, specDir } = setupSplit();
    writeFileSync(join(specDir, 'dup.md'), '## 章\nspec目录版');
    writeFileSync(join(ws, 'dup.md'), '## 章\nworkspace版');
    const frags = resolveDocRefs([{ doc: 'dup', section: '章' }], ws, sandboxBoth(ws, specDir), '', undefined, specDir);
    expect(frags[0].content).toBe('spec目录版');
  });

  it('正例:spec 目录未命中 → 回落 workspace（业务材料既有语义不变）', () => {
    const { ws, specDir } = setupSplit();
    writeFileSync(join(ws, 'biz.md'), '## 章\n业务材料');
    const frags = resolveDocRefs([{ doc: 'biz', section: '章' }], ws, sandboxBoth(ws, specDir), '', undefined, specDir);
    expect(frags[0].content).toBe('业务材料');
  });

  it('反例:specDir 缺席（内存态）→ 只按 workspace 判,spec 目录文件不可见', () => {
    const { ws, specDir } = setupSplit();
    writeFileSync(join(specDir, 'only-spec.md'), '## 章\n正文');
    expect(() => resolveDocRefs([{ doc: 'only-spec', section: '章' }], ws, sandboxBoth(ws, specDir), ''))
      .toThrow(DocRefError);
  });

  it('反例:.. 穿越不走 spec 目录级（越界逃逸面）——仍被 workspace 级响亮拦', () => {
    const { ws, specDir } = setupSplit();
    writeFileSync(join(specDir, 'esc.md'), '## 章\n正文');
    expect(() => resolveDocRefs([{ doc: `../${specDir.split('/').pop()}/esc`, section: '章' }], ws, sandboxBoth(ws, specDir), '', undefined, specDir))
      .toThrow(/Path traversal/);
  });

  it('反例:spec 目录命中但沙箱未授权该目录 → validateReadAccess 拦（denied 基线优先同理）', () => {
    const { ws, specDir } = setupSplit();
    writeFileSync(join(specDir, 'k.md'), '## 章\n正文');
    // 只授权 workspace,不含 specDir——init 组合点授权缺席的形态
    expect(() => resolveDocRefs([{ doc: 'k', section: '章' }], ws, sandboxFor(ws), '', undefined, specDir))
      .toThrow(/Read outside allowed paths/);
  });
});

// @v: anc-rule-p15
describe('checkDocRefExists', () => {
  function setup(): string {
    const dir = mkdtempSync(join(tmpdir(), 'docref-'));
    writeFileSync(join(dir, 'spec.md'), SAMPLE);
    return dir;
  }

  it('文件+章节存在 → null（通过）', () => {
    const dir = setup();
    expect(checkDocRefExists(dir, sandboxFor(dir), { doc: 'spec', section: '色板' })).toBeNull();
  });

  // F类补齐（2026-08-08 审计）：两个异常捕获分支——P15 是收集器,抛错须转错误串不中断 validator
  it('绝对路径 doc → 捕获 resolveDocFile 抛错,返回错误串不抛', () => {
    const dir = setup();
    const r = checkDocRefExists(dir, sandboxFor(dir), { doc: '/etc/passwd', section: 'x' });
    expect(r).toMatch(/Absolute paths are forbidden/);
  });

  it('路径穿越 doc → 捕获抛错,返回错误串不抛', () => {
    const dir = setup();
    const r = checkDocRefExists(dir, sandboxFor(dir), { doc: '../secret', section: 'x' });
    expect(r).toMatch(/Path traversal/);
  });

  it('文件不存在 → 错误说明', () => {
    const dir = setup();
    const err = checkDocRefExists(dir, sandboxFor(dir), { doc: 'nope', section: 'x' });
    expect(err).toContain('文件未找到');
  });

  it('章节不存在 → 错误说明', () => {
    const dir = setup();
    const err = checkDocRefExists(dir, sandboxFor(dir), { doc: 'spec', section: '幽灵章节' });
    expect(err).toContain('章节未匹配');
  });

  // @v: anc-rule-p15 — P15 与注入期同判两级基准（spec_dir 第五参）
  it('正例:P15 spec_dir 在场→spec 目录知识文档通过（与注入期同判）', () => {
    const ws = mkdtempSync(join(tmpdir(), 'docref-p15ws-'));
    const specDir = mkdtempSync(join(tmpdir(), 'docref-p15sd-'));
    writeFileSync(join(specDir, 'knowledge.md'), SAMPLE);
    const sandbox: SandboxConfig = {
      filesystem: { workspace_dir: ws, read_access: { allowed: [ws, specDir], denied: [], confirm_required: [] } },
      network: { trusted_hosts: [] }, runtime: { available: [] },
    };
    expect(checkDocRefExists(ws, sandbox, { doc: 'knowledge', section: '色板' }, undefined, specDir)).toBeNull();
  });

  it('反例:P15 spec_dir 缺席→同一引用报文件未找到（两级判定面一致性的对照）', () => {
    const ws = mkdtempSync(join(tmpdir(), 'docref-p15ws2-'));
    const specDir = mkdtempSync(join(tmpdir(), 'docref-p15sd2-'));
    writeFileSync(join(specDir, 'knowledge.md'), SAMPLE);
    const err = checkDocRefExists(ws, sandboxFor(ws), { doc: 'knowledge', section: '色板' });
    expect(err).toContain('文件未找到');
  });
});

// @v: anc-exec-doc-ref-injection
describe('formatDocRefContext', () => {
  it('小节内联渲染', () => {
    const text = formatDocRefContext([
      { doc: 'spec', section: '色板', heading: '二、色板', content: '主色 #003BFF', matched: 'exact' },
    ]);
    // yaml 条目化（2026-08-24 受众公理:剥 [[]] wiki 语法与"命中标题"调试尾巴,来源人话+作用说明）
    expect(text).toContain('来源: spec《色板》');
    expect(text).toContain('作用: 作者指定的必读知识');
    expect(text).toContain('主色 #003BFF');
    expect(text).not.toContain('[[spec#色板]]');
    expect(text).not.toContain('命中标题');
  });

  it('大节只放 $file 指针', () => {
    const text = formatDocRefContext([
      { doc: 'big', section: 'X', heading: 'X', content: 'ignored', matched: 'exact', file_path: '/abs/p.md' },
    ]);
    expect(text).toContain('/abs/p.md');
    expect(text).toContain('请 Read');
    expect(text).not.toContain('ignored');
  });

  it('空片段返回空串', () => {
    expect(formatDocRefContext([])).toBe('');
  });
});


// ===== hop_env 环境参数展开（doc-ref 路径位唯一引擎展开位）=====
// @v: anc-exec-doc-ref-hop-env, anc-config-hop-env
describe('expandHopEnv（三段式转义处理）', () => {
  const env = { hop_env_kb_root: '/kb/brand', hop_env_extra: 'docs' };

  it('正例：{hop_env_*} 替换为表值', () => {
    const r = expandHopEnv('{hop_env_kb_root}/规范.md', env);
    expect(r.path).toBe('/kb/brand/规范.md');
    expect(r.expanded).toBe(true);
  });

  it('正例：同一路径多键展开', () => {
    expect(expandHopEnv('{hop_env_kb_root}/{hop_env_extra}/x.md', env).path).toBe('/kb/brand/docs/x.md');
  });

  it('正例：反斜杠转义为字面花括号,不触发展开', () => {
    const r = expandHopEnv('dir/\\{literal\\}.md', env);
    expect(r.path).toBe('dir/{literal}.md');
    expect(r.expanded).toBe(false);
  });

  it('正例：转义与变量共存——转义段不被误替换（三段式）', () => {
    const r = expandHopEnv('\\{hop_env_kb_root\\}/{hop_env_extra}', env);
    expect(r.path).toBe('{hop_env_kb_root}/docs');
  });

  it('正例：无花括号路径原样返回', () => {
    expect(expandHopEnv('plain/path.md', env).path).toBe('plain/path.md');
  });

  it('反例：未定义键响亮报错,报文含键名与可用键清单', () => {
    expect(() => expandHopEnv('{hop_env_missing}/x.md', env))
      .toThrow(/HOP_ENV_UNDEFINED.*hop_env_missing.*hop_env_kb_root/s);
  });

  it('反例：表整体缺席时引用变量同样报错（不静默空串）', () => {
    expect(() => expandHopEnv('{hop_env_kb_root}/x.md', undefined)).toThrow(/HOP_ENV_UNDEFINED/);
  });

  it('反例：非 hop_env_ 前缀的花括号不展开（面最小——只认命名空间形态）', () => {
    expect(expandHopEnv('{other_var}/x.md', env).path).toBe('{other_var}/x.md');
  });
});

describe('resolveDocRefs × hop_env（展开+沙箱链）', () => {
  it('正例：展开命中 workspace 内相对路径,注入成功', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopenv-'));
    writeFileSync(join(dir, 'spec-doc.md'), SAMPLE);
    const frags = resolveDocRefs([{ doc: '{hop_env_doc}', section: '二、色板' }], dir, sandboxFor(dir), '', { hop_env_doc: 'spec-doc.md' });
    expect(frags[0].content).toContain('主色');
  });

  it('正例：展开为 workspace 外绝对路径——声明根在 read allowed 即放行', () => {
    const ws = mkdtempSync(join(tmpdir(), 'hopenv-ws-'));
    const kb = mkdtempSync(join(tmpdir(), 'hopenv-kb-'));
    writeFileSync(join(kb, 'guide.md'), SAMPLE);
    const sandbox = sandboxFor(ws);
    sandbox.filesystem.read_access.allowed.push(kb);   // 组合根"写配置即授权"的动作等价物
    const frags = resolveDocRefs([{ doc: '{hop_env_kb}/guide.md', section: '五、布局' }], ws, sandbox, '', { hop_env_kb: kb });
    expect(frags[0].content).toContain('布局正文');
  });

  it('反例：展开为未声明的 workspace 外根——read allowed 未含即拒', () => {
    const ws = mkdtempSync(join(tmpdir(), 'hopenv-ws2-'));
    const kb = mkdtempSync(join(tmpdir(), 'hopenv-kb2-'));
    writeFileSync(join(kb, 'guide.md'), SAMPLE);
    expect(() => resolveDocRefs([{ doc: '{hop_env_kb}/guide.md', section: '五、布局' }], ws, sandboxFor(ws), '', { hop_env_kb: kb }))
      .toThrow(/allowed|denied/i);
  });

  it('反例：未定义键 → 抛错含 HOP_ENV_UNDEFINED（dispatcher 据此 failStep）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopenv-'));
    expect(() => resolveDocRefs([{ doc: '{hop_env_nope}/x.md', section: '节' }], dir, sandboxFor(dir), '', {}))
      .toThrow(/HOP_ENV_UNDEFINED/);
  });

  it('反例：展开出的绝对路径含 .. → 拒（穿越防线不因展开通道豁免）', () => {
    const ws = mkdtempSync(join(tmpdir(), 'hopenv-ws3-'));
    expect(() => resolveDocRefs([{ doc: '{hop_env_kb}/../etc/x.md', section: '节' }], ws, sandboxFor(ws), '', { hop_env_kb: '/kb' }))
      .toThrow(/\.\./);
  });

  it('反例：字面绝对路径（非 hop_env 展开产物）维持原禁令', () => {
    const ws = mkdtempSync(join(tmpdir(), 'hopenv-ws4-'));
    expect(() => resolveDocRefs([{ doc: '/etc/hosts', section: '节' }], ws, sandboxFor(ws), '', { hop_env_x: '/kb' }))
      .toThrow(/Absolute|未找到/);
  });
});

describe('checkDocRefExists × hop_env（P15 两档）', () => {
  it('档一正例：表可得,展开后静态查——缺文件即报', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p15-'));
    const err = checkDocRefExists(dir, sandboxFor(dir), { doc: '{hop_env_kb}/nope.md', section: '节' }, { hop_env_kb: dir });
    expect(err).toMatch(/未找到/);
  });

  it('档一正例：表可得且文件在场——通过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p15b-'));
    writeFileSync(join(dir, 'ok.md'), SAMPLE);
    const err = checkDocRefExists(dir, sandboxFor(dir), { doc: '{hop_env_kb}/ok.md', section: '二、色板' }, { hop_env_kb: dir });
    expect(err).toBeNull();
  });

  it('档二：表缺席,含变量的引用跳过不误拒（留注入期兜底）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p15c-'));
    const err = checkDocRefExists(dir, sandboxFor(dir), { doc: '{hop_env_kb}/nope.md', section: '节' }, undefined);
    expect(err).toBeNull();
  });

  it('反例：表可得但键未定义——静态即报 HOP_ENV_UNDEFINED（不假绿）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p15d-'));
    const err = checkDocRefExists(dir, sandboxFor(dir), { doc: '{hop_env_nope}/x.md', section: '节' }, { hop_env_kb: dir });
    expect(err).toMatch(/HOP_ENV_UNDEFINED/);
  });

  it('字面引用行为零变化（无变量不受 hopEnv 参数影响）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p15e-'));
    writeFileSync(join(dir, 'doc.md'), SAMPLE);
    expect(checkDocRefExists(dir, sandboxFor(dir), { doc: 'doc.md', section: '二、色板' }, { hop_env_kb: '/kb' })).toBeNull();
  });
});
