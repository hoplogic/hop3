// HopSpec 步骤行识别器——三能力（折叠/大纲/高亮）共用的唯一识别层。
// 与引擎零依赖：按概念层表面文法独立实现（语法参考是共同权威），一致性由测试对齐。
// 层级 = 编号段数，与 # 个数、缩进量无关——"与表面形态解耦"的实现。
// 见 [[obsidian-plugin#^anc-viz-step-recognizer]]。// @a: anc-viz-step-recognizer

export interface StepLine {
  lineNo: number;        // 0-based 行号
  stepId: string;        // "5.3.3.1"
  depth: number;         // 编号段数（"5.3.3.1" = 4）
  stepType: string;      // 方括号内类型词（不验合法性，只认形状）
  summary: string;       // 摘要（] 之后的文本）
  marks: string[];       // 行尾纪律落点标记（traverse|verify|commit|hitl）
}

// 行 = 可选前缀（#{1,} 空格 | 空白缩进）+ 编号 + '. [' + 类型词（双语）+ 可选属性 + ']' + 摘要
// 属性位两形态:空格+属性词（retry=2/for-each…）| 直连括号（case(条件)/call id(映射)——引擎侧走平衡扫描通道,
// 识别器不解析内容只认形状,[^\]]* 足够（review 一致性探针实撞:case( 无空格,首版正则漏识别全部 case 步骤）
const RE_STEP_LINE = /^(?:#+\s+|\s*)(\d+(?:\.\d+)*)\.\s*\[([\w一-鿿]+)(?:[\s(][^\]]*)?\]\s*(.*)$/;
const RE_FENCE = /^\s*(?:>\s*)?```/;
const RE_MARK = /→\s*(traverse|verify|commit|hitl)\b/g;
const RE_SPEC_HEAD = /^(?:<!--[\s\S]*?-->\s*)?# Spec:/m;

/** 文件是否 HopSpec（激活判据，与引擎同：# Spec: 头在场） */
export function isHopSpec(text: string): boolean {
  return RE_SPEC_HEAD.test(text);
}

/** 识别全部步骤行。围栏内不识别（示例文本不是步骤——状态机跟踪开合，引擎 identifySections 同规则）。 */
export function recognizeSteps(lines: string[]): StepLine[] {
  const out: StepLine[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (RE_FENCE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(RE_STEP_LINE);
    if (!m) continue;
    const marks: string[] = [];
    let mk: RegExpExecArray | null;
    RE_MARK.lastIndex = 0;
    while ((mk = RE_MARK.exec(lines[i])) !== null) marks.push(mk[1]);
    out.push({
      lineNo: i,
      stepId: m[1],
      depth: m[1].split('.').length,
      stepType: m[2],
      summary: m[3],
      marks,
    });
  }
  return out;
}

/** 折叠域：步骤行 → [域起行, 域止行]（含）。域 = 本行之后到下一个"编号非其后代"的步骤行之前。
 * 后代判定 = 编号前缀（"5.3.1" 是 "5.3" 后代；"5.4" 不是）。尾部步骤折到文件末（去尾空行）。
 * 见 [[obsidian-plugin#^anc-viz-obsidian-fold]]。// @a: anc-viz-obsidian-fold */
export function foldRangeFor(step: StepLine, all: StepLine[], totalLines: number): { from: number; to: number } | null {
  let end = totalLines - 1;
  for (const s of all) {
    if (s.lineNo <= step.lineNo) continue;
    if (!s.stepId.startsWith(step.stepId + '.')) { end = s.lineNo - 1; break; }
  }
  // 去尾空行——折叠域贴住内容
  // （caller 传 lines 时可自剪；此处保守返回，空域即 null）
  if (end <= step.lineNo) return null;
  return { from: step.lineNo, to: end };
}
