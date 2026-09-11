# 设计草案：call 寻址 + SpecProvider（C 方向探索）

> 状态：**设计探索稿**，按 author 选定的 C 方向（名字 + SpecProvider 解析，npm 式）推演，评估是否合适。不直接改正式 design/。
> 关联：TODO「HopAnt 三阻塞之 call 寻址语法」、exec-engine v1 偏差「独立模式 call 抛 not implemented」、Provider 三件套架构。

## 一、问题边界（两个 id，本稿只决 callee 寻址）

| id | 含义 | 决策状态 |
|----|------|---------|
| **callee_spec_id** | 调哪个子 spec | **本稿决策对象**（C 方向） |
| 子实例 id | 子执行实例落哪、id 取啥 | 已定：复用模式 = callStepId（幂等、可定位），保留不动 |

## 二、核心洞察：SpecProvider 只在独立模式必需 ★

call 寻址在两模式下角色根本不同（与沙箱「强制力分级」同构）：

| | 复用模式（CC 驱动） | 独立模式（引擎驱动） |
|---|---|---|
| 谁解析 callee | **CC 自己**——引擎只在 prompt 给出 `callee_spec_id` 文本，CC 拿名字去自己的 Spec 库找 | **引擎自己**——必须拿到子 spec 内容才能递归执行 |
| SpecProvider | **不需要**（引擎不碰解析，寻址是 caller 的事，属契约） | **必需**（引擎调 `resolve(id)` 拿 spec） |
| 类比 | 沙箱"复用模式 = 契约，caller 自律" | 沙箱"独立模式 = ToolProvider 强制" |

→ **推论**：SpecProvider 是「独立模式 call 递归」的前置件，与现有 v1 偏差（独立 call 未实装）天然对齐。复用模式当前已能工作（CC 自己找 spec），不依赖 SpecProvider。

## 三、callee_spec_id 形态（C 方向：名字，不内嵌版本/路径）

- **语法不变**：`1. [call] text-normalize : 摘要` —— callee_spec_id = `text-normalize`，仍是裸名字
- **不在名字里塞版本/org**（区别于 Go 式 B 方案）：保持引用方便；版本/来源校验下沉到 SpecProvider 解析时处理
- **解析归 SpecProvider**：名字 → SpecProvider 在注册表/Spec 库定位具体 spec（可带版本策略、来源校验、同名消歧）——逻辑在宿主，引擎不硬编码寻址规则

## 四、SpecProvider 接口（与三件套同构）

```typescript
export interface SpecProvider {  // 候选锚点 anc-provider-spec
  // 按 callee_spec_id 解析子 spec 源（markdown 文本）。找不到返回 null（引擎据此 fail：UNKNOWN_SPEC）
  resolve(spec_id: string): Promise<SpecSource | null>;
  // 可选：列出可用 spec（供发现/校验），与 IdentityProvider.list_services 同构
  list?(): SpecEntry[];
}

export interface SpecSource {
  spec_id: string;
  source: string;        // HopSpec markdown 全文
  version?: string;      // 可选版本（解析方决定语义；引擎只透传记录进 HopLog 审计）
}

export interface SpecEntry {
  spec_id: string;
  description: string;
}
```

- 挂载点：`HostConfig.spec_provider?: SpecProvider`（与 tool/knowledge/identity_provider 并列，types.ts:459-461）
- 返回 null → 引擎 fail，错误码候选 `UNKNOWN_SPEC`
- version 引擎只透传/审计（记进 HopLog 的 callee_spec_id 旁），**不内置版本解析逻辑**（npm 式：registry 决定解析，lockfile 是宿主的事）

## 五、两模式落地

**复用模式（已工作，本稿不改）**：
- prompt.ts:421 已把 callee_spec_id 文本给 CC，CC 自行解析。**保持**。
- 可选增强：若 HostConfig 有 spec_provider，复用模式也可让引擎预解析校验 callee 存在性（提前 fail，而非等 CC 找不到）——但非必需，列为后续。

**独立模式（依赖 SpecProvider，属待实装 call 递归的一部分）**：
- dispatcher `case 'call'` 当前抛 not implemented。实装时：
  1. `spec = await hostConfig.spec_provider.resolve(call.callee_spec_id)` → null 则 fail UNKNOWN_SPEC
  2. 按 param_mapping 从父 vars 构造子 Inputs
  3. 嵌套 Dispatcher 执行子 spec（子实例 id = callStepId，落 calls/<callStepId>/）
  4. 子完成 → completeCallStep 按 output_mapping 回填
  5. confirm 冒泡：子 spec 的 confirm 需上升到顶层 caller（anc-exec-call-escalation）

## 六、嵌套 call 的 id（你的追问延伸）

子实例 id = callStepId，跨层嵌套靠**目录路径层级**隔离，id 本身可跨层重名：
```
.hopstate/<root>/calls/<callStep_2.1>/calls/<孙callStep_1.3>/
```
- 同层 callStepId 在各自父 spec 内唯一（parser 保证步骤 id 唯一）→ 同目录下不冲突
- 跨层即便 callStepId 数字相同，路径不同 → 隔离
- **待验证**：当前代码是否真支持嵌套（calls/ 目录递归创建）——独立模式未实装，复用模式靠 CC 传 --parent 链，嵌套需 CC 维护父链。列为实装时验证项。

## 七、合适性评估

**优点**：
- 与 Provider 三件套架构完全一致（宿主注入、引擎按 id 查、返回或 null），无新范式
- 引用方便（裸名），解析安全（Provider 可加版本/来源/消歧），方便与安全各归其位
- 复用模式零改动；SpecProvider 只在独立模式必需，与现有 v1 偏差对齐，不增加当前负担

**风险/待决**：
- 版本语义完全下放 Provider，引擎不管 → 若未来要"引擎级版本锁"（Go 式可复现）需回头加。但 v1 不做版本是合理偏差。
- 同名消歧规则在 Provider，不同宿主可能行为不一 → 需文档约定 Provider 契约（resolve 应确定性）
- 嵌套 call 在两模式的父链维护未验证

**结论**：C 方向合适，且边界清晰（SpecProvider = 独立模式 call 递归前置件）。建议作为「独立模式 call 实装」任务的一部分推进，不单独提前做（复用模式不需要）。
