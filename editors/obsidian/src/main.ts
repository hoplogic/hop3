// HopSpec Obsidian 插件主体——折叠/大纲/落点高亮三能力装配。
// 识别层单一来源 recognizer.ts（纯函数,零 Obsidian 依赖,可独立单测）。
// 见 [[obsidian-plugin#^anc-viz-obsidian-plugin]]。// @a: anc-viz-obsidian-plugin
import { Plugin, ItemView, WorkspaceLeaf, TFile, MarkdownView } from 'obsidian';
import { foldService } from '@codemirror/language';
import { ViewPlugin, Decoration, DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { isHopSpec, recognizeSteps, foldRangeFor, StepLine } from './recognizer.js';

const VIEW_TYPE = 'hopspec-outline';
const MARK_CLASS: Record<string, string> = {
  traverse: 'hopspec-mark-traverse',
  verify: 'hopspec-mark-verify',
  commit: 'hopspec-mark-commit',
  hitl: 'hopspec-mark-hitl',
};

// 步骤类型词语义族分色（与落点色系呼应:commit 恒警示橙/把关族绿/动脑蓝/动手青/结构灰蓝）
const TYPE_FAMILY: Record<string, string> = {
  reason: 'hopspec-type-reason', '推理': 'hopspec-type-reason',
  act: 'hopspec-type-act', '探索': 'hopspec-type-act',
  check: 'hopspec-type-gate', '检查': 'hopspec-type-gate',
  confirm: 'hopspec-type-gate', '确认': 'hopspec-type-gate',
  ask: 'hopspec-type-gate', '询问': 'hopspec-type-gate',
  commit: 'hopspec-type-commit', '提交': 'hopspec-type-commit',
  call: 'hopspec-type-flow', '调用': 'hopspec-type-flow',
  subtask: 'hopspec-type-flow', '子任务': 'hopspec-type-flow',
  loop: 'hopspec-type-flow', '循环': 'hopspec-type-flow',
  branch: 'hopspec-type-flow', '分支': 'hopspec-type-flow',
  case: 'hopspec-type-flow', '条件': 'hopspec-type-flow',
  break: 'hopspec-type-flow', '跳出循环': 'hopspec-type-flow',
  continue: 'hopspec-type-flow', '继续循环': 'hopspec-type-flow',
  exit: 'hopspec-type-flow', '结束': 'hopspec-type-flow',
};
const RE_TYPE_TOKEN = /\[([\w一-鿿]+)/;
const RE_IO_LINE = /^(\s*)([-+])\s*([←→])/;
const RE_COMMENT = /\s#\s.*$/;
// 头部关键字（双语——Goal:/Constraints:/Inputs:/Outputs:/Types:/Id: 行首）
const RE_HEADER_KW = /^(Goal|Constraints|Inputs|Outputs|Types|Id|目标|约束|输入|输出|类型|标识)\s*:/;
// 类型位:声明行的 `name: type` 中 type 段（IO 行与头部 Inputs/Outputs/Types 字段行同形——
// 冒号后到行内 # 说明/缺省值 =/行尾;类型词汇开放〔Types 自定义〕按位置着色不按词表）
const RE_TYPE_POS = /^(\s*(?:[-+]\s*[←→]\s*|-\s*)?[\w一-鿿_.]+)(\s*:\s*)([\w\[\]()（）一-鿿, ]+?)(?=\s{2,}#|\s*=|\s*$)/;

// ── 折叠：CM6 foldService——步骤行折叠域=行尾→下一个非后代步骤行前 // @a: anc-viz-obsidian-fold
const hopspecFold = foldService.of((state, lineStart, lineEnd) => {
  const doc = state.doc;
  const text = doc.toString();
  if (!isHopSpec(text)) return null;
  const lines = text.split('\n');
  const steps = recognizeSteps(lines);
  const lineNo = doc.lineAt(lineStart).number - 1;   // CM 1-based → 0-based
  const step = steps.find(s => s.lineNo === lineNo);
  if (!step) return null;
  const range = foldRangeFor(step, steps, lines.length);
  if (!range) return null;
  // 域内容起点=本行行尾,终点=末行行尾（贴内容去尾空行）
  let toLine = range.to;
  while (toLine > range.from && lines[toLine].trim() === '') toLine--;
  if (toLine <= range.from) return null;
  return { from: lineEnd, to: doc.line(toLine + 1).to };
});

// 头部声明上下文:该行向上最近的非空非声明行是否 Inputs:/Outputs:/Types: 关键字行
//（限定类型位着色范围——普通 markdown 列表「- 词: 值」不误着）
function isHeaderDeclContext(view: EditorView, lineNumber: number): boolean {
  for (let n = lineNumber - 1; n >= 1; n--) {
    const t = view.state.doc.line(n).text;
    if (/^(Inputs|Outputs|Types|输入|输出|类型)\s*:/.test(t)) return true;
    if (t.trim() === '' || /^\s*-/.test(t)) continue;
    return false;
  }
  return false;
}

// ── 落点高亮 + 7+ 级井号前缀隐藏（编辑视图/Live Preview）// @a: anc-viz-mark-highlight, anc-viz-reading-view
// 前缀隐藏按 Live Preview 惯例：光标不在该行时隐藏字面 #######（7+ 级不是 markdown 标题,渲染器
// 不吃井号——真机实撞:编辑视图仍露井号）;光标进入该行时显示,可编辑性不丢。
const markHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view); }
  build(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const text = view.state.doc.toString();
    if (!isHopSpec(text)) return builder.finish();
    const reMark = /→\s*(traverse|verify|commit|hitl)\b/g;
    const rePrefix = /^#{7,}\s+(?=\d)/;
    const cursorLines = new Set<number>();
    for (const r of view.state.selection.ranges) {
      cursorLines.add(view.state.doc.lineAt(r.head).number);
    }
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        // 7+ 级井号前缀隐藏（光标行豁免）+ 行级加粗（缺省效果——1-6 级标题渲染器给粗体,
        // 7+ 级不是标题没这待遇,补齐观感一致性;CSS 类可被主题覆盖）
        const pm = line.text.match(rePrefix);
        if (pm) {
          builder.add(line.from, line.from, Decoration.line({ class: 'hopspec-deep-step' }));
          if (!cursorLines.has(line.number)) {
            builder.add(line.from, line.from + pm[0].length, Decoration.replace({}));
          }
        }
        // 步骤类型词分族着色（[reason]/[act]/… 与中文词——只在步骤行:pm 或 1-6 级标题风/缩进风步骤形状）
        const isStepLine = /^(?:#+\s+|\s*)\d+(?:\.\d+)*\.\s*\[/.test(line.text);
        if (isStepLine) {
          const tm = line.text.match(RE_TYPE_TOKEN);
          if (tm && TYPE_FAMILY[tm[1]]) {
            const start = line.from + (tm.index ?? 0);
            builder.add(start, start + tm[0].length + (line.text[(tm.index ?? 0) + tm[0].length] === ']' ? 1 : 0),
              Decoration.mark({ class: TYPE_FAMILY[tm[1]] }));
          }
        }
        // 头部关键字着色（Goal:/Constraints:/…——双语）
        const kw = line.text.match(RE_HEADER_KW);
        if (kw) {
          builder.add(line.from, line.from + kw[0].length, Decoration.mark({ class: 'hopspec-header-kw' }));
        }
        // 数据流行前缀着色（- ← 输入 / + → 输出）+ 类型位 + 行内 # 说明
        const io = line.text.match(RE_IO_LINE);
        const isDeclLine = io || (kw === null && /^\s*-\s*[\w一-鿿_]+\s*:/.test(line.text) && isHeaderDeclContext(view, line.number));
        if (io) {
          const pfxStart = line.from + io[1].length;
          builder.add(pfxStart, pfxStart + io[0].length - io[1].length,
            Decoration.mark({ class: io[3] === '←' ? 'hopspec-io-in' : 'hopspec-io-out' }));
        }
        if (isDeclLine) {
          // 类型位（name: type 的 type 段——输出声明与头部 Inputs/Outputs 字段行同形）
          const tp = line.text.match(RE_TYPE_POS);
          if (tp) {
            const typeStart = line.from + tp[1].length + tp[2].length;
            builder.add(typeStart, typeStart + tp[3].length, Decoration.mark({ class: 'hopspec-type-pos' }));
          }
          const cm = line.text.match(RE_COMMENT);
          if (cm && cm.index !== undefined) {
            builder.add(line.from + cm.index, line.to, Decoration.mark({ class: 'hopspec-comment' }));
          }
        }
        // 落点着色
        let m: RegExpExecArray | null;
        reMark.lastIndex = 0;
        while ((m = reMark.exec(line.text)) !== null) {
          builder.add(line.from + m.index, line.from + m.index + m[0].length,
            Decoration.mark({ class: MARK_CLASS[m[1]] }));
        }
        pos = line.to + 1;
      }
    }
    return builder.finish();
  }
}, { decorations: v => v.decorations });

// ── 大纲：右侧栏步骤树,点击跳行 // @a: anc-viz-outline
class HopSpecOutlineView extends ItemView {
  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'HopSpec outline'; }
  getIcon() { return 'list-tree'; }

  private currentFile: TFile | null = null;

  async render() {
    const container = this.containerEl.children[1];
    container.empty();
    const file = this.app.workspace.getActiveFile() ?? this.currentFile;
    this.currentFile = file;
    if (!file) { container.createEl('div', { text: '（无活动文件）', cls: 'hopspec-outline-empty' }); return; }
    const text = await this.app.vault.cachedRead(file);
    if (!isHopSpec(text)) { container.createEl('div', { text: '（非 HopSpec 文件）', cls: 'hopspec-outline-empty' }); return; }
    const steps = recognizeSteps(text.split('\n'));
    const root = container.createEl('div', { cls: 'hopspec-outline' });
    for (const s of steps) {
      const item = root.createEl('div', { cls: 'hopspec-outline-item' });
      item.style.paddingLeft = `${(s.depth - 1) * 14}px`;
      item.createEl('span', { text: `${s.stepId}. `, cls: 'hopspec-outline-id' });
      item.createEl('span', { text: `[${s.stepType}] `, cls: 'hopspec-outline-type' });
      item.createEl('span', { text: s.summary, cls: 'hopspec-outline-summary' });
      for (const mark of s.marks) item.createEl('span', { cls: `hopspec-outline-dot ${MARK_CLASS[mark]}` });
      item.addEventListener('click', () => {
        // 点击时焦点在大纲面板,activeView 不是 MarkdownView（首版实撞:点了不跳静默失败）——
        // 改 Obsidian 原生跳行:找显示该文件的 markdown leaf（无则最近 leaf 开文件）,eState.line
        // 两种视图（编辑/阅读）都工作。
        const target = this.currentFile;
        if (!target) return;
        let leaf = this.app.workspace.getLeavesOfType('markdown')
          .find(l => (l.view as MarkdownView).file?.path === target.path);
        if (!leaf) leaf = this.app.workspace.getLeaf(false);
        void leaf.openFile(target, { eState: { line: s.lineNo } });
      });
    }
  }
}

export default class HopSpecPlugin extends Plugin {
  private outlineView: HopSpecOutlineView | null = null;
  private refreshTimer: number | null = null;

  async onload() {
    this.registerEditorExtension([hopspecFold, markHighlighter]);
    // 阅读视图支持（编辑视图归 CM6 扩展,阅读视图走 post-processor 管线——7+ 级标题在阅读视图
    // 渲染为字面 ####### 段落,此处重塑为分级步骤行:隐藏井号/按深度缩进/落点着色）
    // @a: anc-viz-reading-view
    this.registerMarkdownPostProcessor((el, ctx) => {
      const RE_LITERAL = /^(#{7,})\s+(\d+(?:\.\d+)*)\.\s*(\[[^\]]+\])\s*(.*)$/;
      for (const p of Array.from(el.querySelectorAll('p'))) {
        const lines = (p.textContent ?? '').split('\n');
        if (!lines.some(l => RE_LITERAL.test(l.trim()))) continue;
        const frag = createFragment();
        for (const line of lines) {
          const m = line.trim().match(RE_LITERAL);
          if (!m) { frag.createEl('div', { text: line }); continue; }
          const depth = m[2].split('.').length;
          const row = frag.createEl('div', { cls: 'hopspec-rv-step' });
          row.style.setProperty('--hopspec-depth', String(depth));
          row.createEl('span', { text: `${m[2]}. `, cls: 'hopspec-rv-id' });
          row.createEl('span', { text: `${m[3]} `, cls: 'hopspec-rv-type' });
          // 摘要含落点标记则拆出着色
          const markM = m[4].match(/^(.*?)(→\s*(?:traverse|verify|commit|hitl).*)$/);
          if (markM) {
            row.createEl('span', { text: markM[1] });
            const markWord = markM[2].match(/traverse|verify|commit|hitl/)?.[0] ?? '';
            row.createEl('span', { text: markM[2], cls: MARK_CLASS[markWord] ?? '' });
          } else {
            row.createEl('span', { text: m[4] });
          }
        }
        p.replaceWith(frag);
      }
    });
    this.registerView(VIEW_TYPE, (leaf) => {
      this.outlineView = new HopSpecOutlineView(leaf);
      return this.outlineView;
    });
    this.addCommand({
      id: 'open-outline',
      name: 'Open HopSpec outline',
      callback: () => this.activateOutline(),
    });
    // 文件切换/编辑刷新（编辑防抖 ~300ms）;打开 HopSpec 文件自动开大纲（要手动跑命令=装了像没装）
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshOutline()));
    this.registerEvent(this.app.workspace.on('file-open', (f) => { void this.autoActivate(f); }));
    this.registerEvent(this.app.vault.on('modify', (f: TFile) => {
      if (f === this.app.workspace.getActiveFile()) this.debounceRefresh();
    }));
  }

  private debounceRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refreshOutline(), 300);
  }

  private refreshOutline() { void this.outlineView?.render(); }

  // HopSpec 文件打开即自动挂大纲（一次性——已有大纲叶则只刷新）
  private async autoActivate(f: TFile | null) {
    if (!f || !f.path.endsWith('.md')) return;
    const text = await this.app.vault.cachedRead(f);
    if (!isHopSpec(text)) return;
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length === 0) await this.activateOutline();
    else this.refreshOutline();
  }

  private async activateOutline() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) { void this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      this.refreshOutline();
    }
  }

  onunload() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
  }
}
