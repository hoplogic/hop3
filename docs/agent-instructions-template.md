# 给项目 agent 的 HOP 指令模板

把下面围栏里的内容贴进你项目的常驻指令文件——Claude Code 是项目根的 `CLAUDE.md`，Codex 和 opencode 是 `AGENTS.md`。贴进去之后，项目里的 coding agent 每次开会话都会读到它，不再靠 skill 描述碰运气匹配。措辞可以按项目改，但三条边界别删。

```markdown
## 本项目用 HOP

本项目用 HOP（`/hop`，Codex 里是 `$hop`）管多步骤的活：把任务写成带目标、步骤、核验点的规约，由 hopjit 引擎按步执行——顺序不乱、核验不跳、进度有账、中断后能接上。
- 多步骤、要核验、中断后要接得上的活，交给 `/hop`；一句话能答完的直接答，不进 hop。
- 核验步（check）对着产出如实判：不合格就判 false 让引擎重跑，不许"差不多就 true"。
- `confirm` / `ask` 停点是用户要亲自出现的位置：停下来问，不替答、不猜。
- 已批准命令只按任务 HopSpec 的 `## 已批准命令` 清单执行；不在清单上的命令问用户要不要加，不自己加、不绕道 Bash。
- 详细说明在 `npm root -g` 下 `@hoplogic/hopjit/docs/AGENT-GUIDE.md`，第一次用先读它。
```
