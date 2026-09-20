# probes — 模型度量仪器

探针族对应 D12 教程四层测试的机械化（族数随维度仪器化递增,以下表为准）。产出=可直接贴进 `../profiles/` 档案的实测数据。判据方法论权威=`docs/tutorials/D12-新模型接入与验证.md`,本目录只管"怎么跑"。

| 族 | 层级 | 形态 | 状态 |
|---|---|---|---|
| `protocol/` | 层一:协议面 | curl 脚本,零引擎 | 待实装(D12 层一四探针的脚本化——今日全部手工跑过,命令在教程里) |
| `smoke/` | 层二:引擎冒烟 | 最小 spec | ✅ onboard-smoke.md(两步:reason 真调用+body 机械步;跑法=项目级 hopjit.yaml 指目标模型后 start_run) |
| `act-free-stability/` | 层三核心 | 格点任务 spec | 矩阵契约已立(grid.yaml);格点任务模板与跑批待实装(挂 todo/0095——物理刀的验收仪器) |
| `capability/` | 层三:通识组定性 | 混合 | 待实装 |
| `extract-scaling/` | 层三:G2 任务复杂度(主)+P3 修订落实 | 尺寸阶梯语料+答案键,一键跑批 | ✅✅ 全仪器化:../run-task-complexity.mjs(单发裸能力对答案键机械判分;语料六档 XS2/S4/M9/L18/XL40/XXL80 点,高档 gen-corpus.mjs 生成——点数与 pad-ratio 双轴独立调,键自动派生;三模型全档曲线在库) |
| `reasoning-complexity/` | 层三:G1 推理复杂度 | 双任务阶梯(--task mul 乘法=直接推理 / --task div 除法 2N÷N 商 2N+1 位有效数字=迭代推理),一键跑批 | ✅✅ 全仪器化:../run-reasoning-complexity.mjs(禁工具纯推理,爬梯 n=5+贴线判定恒升 20 发确认;真值 BigInt 生成+Python 独立复算零误——mul 180 题/div 30 题;div 出题剔除舍入决定位 4/5 与进位改位数的脏题,判分只放行尾零格式差)。定档:mul=deepseek≥12/qwen 3/Ling 2;div(2026-09-19)=deepseek≥8(测程顶,16位÷8位 17 位有效数字 19/20)/qwen 2/Ling 测程下限之下(N2 不达标) |
| `judge-granularity/` | 层三:P1 核验能力 | 三层阶梯,一键跑批 | ✅✅ 全仪器化:../run-judge-granularity.mjs 一键复跑(语料/模板/判档规则/判分全在内);三模型同卷实跑在库(deepseek=open-ok/Ling=checklist-only/qwen=closed-questions-only——四档阶梯三档各有实例,判档规则被三模型数据校验) |
| 标准工作卷族(层四) | 层四:能力定位 | 真机全任务卷,跑仓库原件 spec | **正式测试项两卷(2026-09-19 作者定"deep research, fact check 都纳入正式能力测试项")**:①`examples/hop-fact-check.md`(完整版 303 行;综合卷——检索链考 G4、fact/inference 二分与推演点前提溯源+推理有效性四级审查考 G1 推理可信、逐点并行考交付面;27b 微判定变体 350 行同功能面,弱模型跑变体强模型跑母本);②`examples/hop-deep-research/hop-deep-research.md`(工具重卷——多子问题 fan-out+独立二源对抗验证+引用报告,G4/P2 主考场,比 fact-check 重一档;尚未进过跑批,首跑待排)。跑批纪律与探针同源:spec 恒从仓库原件现拷、模型身份取响应体、结果按维度归因入档案不记总分 |
| `real-task-scaling/` | 层四×G2:真实任务复杂度阶梯 | 真实材料尺寸阶梯 × 标准工作卷 | **语料已建(2026-09-19 作者定"找不同大小的新闻稿/不同大小的 skill 来验证,作为实际的任务复杂度度量任务")**:阶梯一/二=四档真实新闻稿(0.7K/1.9K/5.1K/28.4K,原文零改写带出处)× fact-check 与 deep-research;阶梯三=五档真实 spec(2.8K~78K 仓库原件)× deep-validate 判官卷。判分=机械面(完备率/SCHEMA 计数/tokens 账)+强模型基线对照+人工抽查(推演判定与风险条目真伪);三模型跑批待排。契约详见其 README |

跑批入口分族实装中(0095):首件 `run-judge-granularity.mjs --service <service_id> [--n 6]`(P1 三层阶梯一键复跑——L2/L3 机械判分+判档建议,L1 出自反比对材料归人判;三模型 2026-09-18 实跑定档)。统一入口 run-probes.mjs 等第二件族脚本落地后再收拢。

四条跑批纪律(与档案纪律同源,详见 ../README.md):每格 n≥6;实测与推断分标;模型身份取响应体 model 字段;**被测 spec 恒每次起跑前从仓库原件现拷**(工作面里的 spec 副本一律视为陈旧——实撞:A5 重跑误用别的评测目录下的旧副本,母本刚补的声明行不在场,验的是已废形态;评测工作面手工散拷 N 份没有任何新鲜度保障,与 hopissues/0096"陈旧副本静默被加载"同款病根。跑批脚本实装后由脚本强制现拷,手工跑批期间靠本条纪律)。
