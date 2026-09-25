// 每个用例结束后让出一次事件循环（设计权威 docs/design/chain-enforcement.md ^anc-meta-guard-trust 第 5 条）。
// cli.test.ts 这类套件用 execSync/spawnSync 同步起子进程,单个用例在同步调用里把工作进程的事件循环
// 连续占住,vitest 工作进程向主进程回报进度的 onTaskUpdate 调用就一直发不出去——排队超过 vitest 内置的
// 60 秒通信超时即报 `Timeout calling "onTaskUpdate"`,测试全过而退出码 1。用例间插一次 setImmediate,
// 排队中的回报就能在下一个用例开跑前发出。
// @a: anc-meta-guard-trust —— 测试运行器进度回报不被同步子进程饿死
import { afterEach } from 'vitest';

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
