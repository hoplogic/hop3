---
name: hopbuild2
description: >
  【实验性——日常翻译请用 /hopbuild；本 v2 仍在真机淬炼中，仅显式点名时使用】
  把一个自然语言 skill 翻译成结构化的 HopSpec 规约（hopskill）——递归等价分拆形态：
  判定序（顺序→分支→循环→原子）逐层消解 NL 节点，对齐门/终审门作者把关，
  产物带档位（hop=双模式可跑 / mixed=含未尽原子，复用模式可跑）。
  Trigger: "hopbuild2", "/hopbuild2", "用 hopbuild2 翻译", "递归分拆构建",
  "skill 转 hopspec v2", "构建 hopskill v2".
user_invocable: true
---

%% @trace
	id: hopbuild2-skill
	type: intent
	last_sync: 2026-09-11T12:27+0800
	note: hopbuild2 薄包装壳（design ^anc-build-layout2,2026-08-25 作者定"构建成完整 skill"）——本 skill 是 hopspec skill:流程权威在同目录 spec.md,经 /hopspec 驱动引擎强制执行;判定与结构知识在 split-node/split-structure/split-patterns 三件（call 递归 callee 与 doc-ref 注入源,分发时同目录随行）。壳自身零流程知识,只做参数收集与移交。
%%

# hopbuild2 — 自然语言 skill 翻译为 HopSpec 规约（递归等价分拆）

**做什么**：把一个自然语言 skill（散文 SKILL.md）翻译成合规的 HopSpec 规约（hopskill）。核心形态是类 LLVM pass 的递归等价分拆——每个自然语言节点按固定判定序（顺序→分支→循环→原子）判定并分拆，逐层消解为引擎可强制的 HopSpec 步骤；拆不动的以自然语言步骤诚实落定（未尽原子，合法交付档）。

**什么时候用**：你已有一个靠散文纪律运行的 skill，想让引擎强制它的关键纪律（遍历不漏/核验不跳/提交把关/真人研判）时。

**与 hopbuild（v1）的关系**：v2 是新一代构建形态（递归分拆取代单轮四拍），两者并存；用 v2 说 "hopbuild2"，用 v1 说 "hopbuild"。

## 参数

| 参数               | 类型   | 说明                                                         |
| ---------------- | ---- | ---------------------------------------------------------- |
| input_skill_path | line | 待翻译的自然语言 skill 文件路径——须 workspace 相对路径（如 .claude/skills/xxx/SKILL.md;绝对路径与含 .. 的路径会被路径闸拒并重问）;为空则列出候选供选 |
| max_depth | int | 可选。产物 spec 嵌套深度上限（步骤号最多几段——3 即 `x.y.z`）,缺省 3;语料确实巨大、三层装不下时显式传更大值放宽。用户没提就传 3 |

已给且存在时直接采用，不必强问;为空则列候选供用户选一个。max_depth 用户不提则不问，按缺省 3 传。

## 执行

**本 skill 是 hopspec skill**：流程权威在本目录 `spec.md`，按 `/hopspec` 驱动协议执行它——

```
/hopspec run <本目录>/spec.md --params '{"input_skill_path": "<收集值>", "max_depth": 3}'
```

MCP 注册时（工具面可见 `mcp__hopjit__*`）走 standalone 薄协议：`start_run(spec_path=<本目录>/spec.md, params={...}, workspace_dir=<作业目录>)`。**workspace_dir 必须指向作业目录**（待翻译 skill 所在处或用户指定的产物目录）——产物 spec.md 与 source.md 写作业目录，不写本 skill 安装目录。

执行中的介入点（引擎强制，原样呈给用户）：

- **对齐门（4.4）**：呈审头部契约（目标/交付物/输入/工具面）收修订意见——"待确认"的工具在此裁定；
- **终审门（5.4）**：整文呈审收意见（审阅文件含 spec 全文+研判点台账），意见清空才交付。

## 交付

执行完成后用户拿到（与 spec 的 Outputs 对齐）：

- **generated_spec_path**——翻译出的规约写盘路径（作业目录 skill/spec.md）;
- **tier**——产物档位：`hop`（全结构化，双模式可跑）或 `mixed`（含未尽原子步骤，复用模式可跑）。mixed 不是缺陷是诚实降档——哪些节点没拆动、为什么，研判点台账里都有记录（已随终审呈过作者）。

产物目录同时带 source.md（原文纯副本——终审与日后对读的物理基准）。

交付时**附打包指引**：`hopjit pack <generated_spec_path>` 可把该规约打包成独立具名 skill——用户此后用自然语言触发它，无需知道 /hopspec。

**交付前例行跑一轮 deep-validate**（2026-09-01 作者定"hopbuild/hopbuild2 跑完后应该例行化跑 deep-validate"）：翻译产物正是"没在目标模式跑过的新 spec"——validate 只管静态文法，运行期假设（步骤说明教的动作×执行模式能力面）要 deep-validate 查。跑 `scripts/deep-validate/deep-validate.md`（params={spec_path: 产物路径, exec_mode: 目标模式}，MCP start_run 或 /hopspec 均可，分钟级），风险报告随交付一并呈给用户——建议性不阻断，高位风险用户拍板修不修。首例实战：D72 批产物三条中风险全修后复跑清零。

执行失败/中止时如实报告，不写盘不留半成品。

**前置**：hopspec skill 已安装（缺席时提示用户先 `hopjit install-skill`）。本目录五文件（SKILL.md/spec.md/split-node.md/split-structure.md/split-patterns.md）必须同目录随行——spec 经 call 按同目录寻址两个分拆器，经 doc-ref 按同目录读知识库。
