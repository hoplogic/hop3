# /hop 运维场景补充规则（按需读——活涉及 ssh / 远端机器 / 多台环境，或项目 `hopjit.yaml` 有 `environments:` 段时）

这份文件只在运维类任务里读。它补充的是 `## 已批准命令` 段在多机器环境下怎么写，不改变 /hop 主线的任何规则。

## 1. 先看机器分级

项目 `hopjit.yaml` 里可以有一段 `environments:`（本阶段只是给 agent 读的约定，引擎不解析也不报错）：

```yaml
environments:
  test:          # 测试环境——可重建，远端命令不受限
    - test-node-1
    - test-node-2
  prod:          # 生产环境——只读巡检放 act，变更放 commit
    - prod-*
```

没有这段的项目，就按任务话语或材料里的机器清单问用户一句"哪些是测试机、哪些是生产机"，答案写进任务卡的「背景」节。拿不到分级就全部按生产机对待（安全侧）。

## 2. 按机器写 `## 已批准命令`

hopjit 的授权判的是**本机 argv**。`ssh test-node-1 'anything'` 这一条，本机命令是 `ssh test-node-1`，后面那段远端命令只是 ssh 的一个参数。所以：

- **测试机：整机放行**。一行 `- ssh test-node-1`（或项目的远端入口脚本 + 机器名，如 `- python3 scripts/ssh_exec.py --config configs/x.json exec test-node-1`），以它开头的一切远端命令都放行，远端跑什么 hopjit 不管——环境可重建，这就是"可逆"的定义，`rm -rf /data/exp` 放在 act 步骤里也没问题。
- **生产机：只放行只读前缀**。`- ssh prod-1 nvidia-smi`、`- ssh prod-1 journalctl`、`- ssh prod-1 df` 这样一条一条列到命令名；变更类命令（重启服务、改配置、删数据）不进 act，写进 `[commit]` 步骤的 body，前面站 check final 或 confirm。
- **前缀必须落到机器名**。`- ssh` 单独一行等于放行所有机器，禁止；parser 不拦这一条，但阅卷会抓。
- 通配的机器名（`prod-*`）不能直接当前缀——前缀是逐词相等匹配，一台机器一行。

## 3. 探索态 / 提交态仍按步骤类型

机器分级只决定"哪些命令能进清单、进到多宽"；一条命令是探索还是提交，仍由它所在的步骤类型决定（act = 探索，可重跑；commit = 提交，过闸执行一次），与主线一致。测试机上的命令放 act 即可；生产机上的变更放 commit。

## 4. 写进任务卡的样子

```markdown
## 背景
测试环境：test-node-1、test-node-2（可重建，远端命令不受限）。生产：prod-1、prod-2（只读巡检放 act，变更放 commit）。

## 已批准命令
- python3 scripts/ssh_exec.py --config configs/x.json exec test-node-1
- python3 scripts/ssh_exec.py --config configs/x.json exec test-node-2
- python3 scripts/ssh_exec.py --config configs/x.json exec prod-1 nvidia-smi
- python3 scripts/ssh_exec.py --config configs/x.json exec prod-1 journalctl
- python3 scripts/ssh_exec.py --config configs/x.json check
```
