%% @trace
	id: hopspec-v3-tx-rollback
	source: [[HopSpec V3核心规范]]
	source_id: hopspec-v3-core
	type: extend
	last_sync: 2026-05-23T09:42+08:00
	note: 扩展 commit 步骤的事务与补偿机制
%%
> HopSpec V3扩展：事务与补偿

## 定位

本扩展为 `[commit]` 步骤提供失败后的补偿和事务保障能力。属于可选扩展，不影响核心规范。

核心规范中，commit 失败的处理路径是：fail → None 传播 → subtask retry/adaptive → 逐层上报 → HITL。本扩展在此基础上增加两种模式：

| 模式 | 能力 | 适用场景 |
|------|------|---------|
| rollback | commit 挂载补偿动作，失败时尽力回滚 | 非数据库的外部操作（邮件、支付、API 调用） |
| tx | subtask 内 commit 原子化 | 数据库操作为主的事务场景 |

tx 建立在 rollback 之上：数据库 commit 走原生事务，非数据库 commit 走补偿回滚。

---

## Rollback 模式

### 语法

commit 节点体新增 `* rollback:` 前缀，声明该 commit 的补偿动作：

```
5. [commit] 发送审批通知邮件
  - ← approval_result
  + → notification_id: line  # 通知ID
  * rollback: 按 notification_id 撤回通知邮件
```

`* rollback:` 是可选的。没有 rollback 的 commit 是不可补偿的。

### 触发时机

当下游步骤失败传播到包含该 commit 的 subtask 边界时，HopJIT 按以下顺序处理：

1. subtask 内已完成的 commit，按执行的**逆序**触发 rollback
2. 每个 rollback 独立执行，自身也可能失败
3. rollback 失败时记录错误，继续执行剩余补偿，最终上报 caller + HITL

### 顺序流 vs 并行流

- **顺序流**（subtask 内 commit 依次执行）：逆序补偿，语义明确
- **并行流**（parallel 内多个 commit）：补偿顺序未定义，尽力执行，不承诺正确性

⚠️ rollback 是尽力补偿（best-effort），不是事务回滚。已被外部消费的副作用（邮件已读、款已到账）可能无法撤销。

### 示例

```
3. [subtask retry=2] 创建订单并通知
  + → order_id: line  # 订单号
  + → notification_id: line  # 通知ID
  3.1. [commit] 写入订单到数据库
    - ← order_data
    + → order_id
    * rollback: 按 order_id 删除订单记录
  3.2. [commit] 发送订单确认邮件
    - ← order_id
    + → notification_id
    * rollback: 按 notification_id 撤回邮件
  3.3. [check] 验证订单状态一致性
    - ← order_id, notification_id
    + → order_ok: bool  # 是否一致
```

check 失败时：先补偿 3.2（撤回邮件），再补偿 3.1（删除订单），然后触发 subtask retry。

---

## Transaction（tx）模式

### 语法

subtask 新增 `tx` 属性，声明内部 commit 的原子性要求：

```
4. [subtask tx] 转账事务
  + → transfer_id: line  # 转账记录ID
  4.1. [commit] 扣减源账户余额
    - ← source_account, amount
    + → debit_id: line  # 扣款记录ID
    * rollback: 按 debit_id 恢复源账户余额
  4.2. [commit] 增加目标账户余额
    - ← target_account, amount
    + → credit_id: line  # 入账记录ID
    * rollback: 按 credit_id 恢复目标账户余额
  4.3. [act] 生成转账记录
    - ← debit_id, credit_id
    + → transfer_id
```

### 执行策略

HopJIT 根据 commit 的实际类型选择执行路径：

| 场景 | 机制 | 保障级别 |
|------|------|---------|
| 全 DB commit | 原生数据库事务（BEGIN/COMMIT/ROLLBACK） | ACID |
| 混合（DB + 非 DB） | DB 部分走原生事务，非 DB 部分走 rollback 补偿 | 部分 ACID + 尽力补偿 |
| 全非 DB commit | 全部走 rollback 补偿 | 尽力补偿 |

### 语义

- tx subtask 内任一 commit 失败 → 整体回滚（原生事务 ROLLBACK + 已完成 commit 的补偿）
- tx 是声明意图，HopJIT 根据 commit 类型自动选择最强保障路径
- tx 可与 retry 组合使用：`[subtask tx retry=2]`，回滚后重试

---

## 验证规则

| # | 检查项 | 级别 |
|---|--------|------|
| E1 | `* rollback:` 仅允许在 `[commit]` 节点体中 | 错误 |
| E2 | `tx` 属性仅适用于 `[subtask]` | 错误 |
| E3 | `[subtask tx]` 内存在无 rollback 的非 DB commit | 警告 |
| E4 | `[parallel]` 内多个 commit 带 rollback，补偿顺序不确定 | 警告 |
