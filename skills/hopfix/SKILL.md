---
name: hopfix
description: >
  对既有 HopSpec 做定向修正——把修正意见（或 deep-validate 检查报告）变成
  节点级定向编辑：只改点名的地方，改完机械核对+呈人确认才写回（自动留快照可回滚）；
  结构性变更如实拒并指路重新翻译，不硬修。
  Trigger: "hopfix", "/hopfix", "修一下这个 spec", "这个 spec 有几处要改",
  "按报告修正 spec", "定向修正".
user_invocable: true
---

%% @trace
	id: hopfix-skill
	type: intent
	last_sync: 2026-09-02T17:40+0800
	note: hopfix 薄包装壳（design docs/design/hopfix.md ^anc-meta-hopfix-contract）——本 skill 是 hopspec skill:流程权威在 scripts/hopfix/hopfix.md,经 /hopspec 驱动引擎强制执行。壳自身零流程知识,只做参数收集与移交。缘起作者抓"你这个用法是想把人都劝退么"——裸驱动命令不是给人用的形态,壳补齐 2026-09-02。
%%

# hopfix — 定向修正一份 HopSpec

**做什么**：你手里有一份 spec（hopbuild 翻译的、手写的、examples 里的都行），发现几处要改——错别字、阈值写错、说明和代码对不上、缺一行输入声明这类**点得出位置的局部问题**。hopfix 替你逐处改好，并保证三件事：**只改你点名的地方**（机械核对，不靠自觉）、**改完呈你过目才写回**（写回前自动留原件快照，随时可回滚）、**改不动的如实说**（要是你的意见其实是"这段整个拆法要换"，它不会硬改，会明说这超出定向修正范围、该重新翻译）。

**什么时候用**：跑 spec 前后发现小毛病，不想为几处改动重新翻译整份，也不想手改担心引入新问题。检查工具（deep-validate）的风险报告可以整份直接喂给它——查出什么修什么。

**什么时候不用**：要大改结构（整段重新分拆、改目标改交付物）——那是重新翻译（/hopbuild2）的活，hopfix 会把这类意见拒回来并告诉你去哪。

## 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| spec_path | line | 待修 spec 的路径——须 workspace 相对路径（绝对路径与含 .. 的路径会被拒并重问） |
| fix_order | text | 修正意见——人话写就行（"步骤 3 的说明里××是错别字；步骤 5 的阈值应该是 30000"），或直接贴一份检查报告全文 |

用户话语里已带这两样（点了哪份 spec、说了要改什么）就直接采用不再问;缺哪样只问哪样。

## 执行

**本 skill 是 hopspec skill**：流程权威在 `scripts/hopfix/hopfix.md`，按 `/hopspec` 驱动协议执行它——

```
/hopspec run scripts/hopfix/hopfix.md --params '{"spec_path": "<收集值>", "fix_order": "<收集值>"}'
```

MCP 注册时（工具面可见 `mcp__hopjit__*`）走 standalone 薄协议：`start_run(spec_path=scripts/hopfix/hopfix.md, params={...}, workspace_dir=<待修 spec 所在的作业目录>)`——**workspace_dir 必须指向待修 spec 所在处**（spec_path 按它相对解析，写回也落它）。

执行中的介入点（引擎强制，原样呈给用户）：

- **确认写回（3.2.3）**：改动清单与修正稿呈你过目——逐项"改了哪一步、依据你哪句意见"，外加三道核对的结论。答 yes 才写回原路径；答别的就不写，修正稿留在工作区自行取用。

## 交付

- **fix_report**——修正报告：修了什么（逐项）/ 拒了什么（逐项拒因与指路）/ 核对结论 / 快照位置（回滚就把快照拷回原路径）；
- 改动涉及执行形态（改了 body、加删了步骤）时，报告里会附一条复验命令建议——投产前跑一遍更稳。
