# probes — 模型度量仪器

探针族对应 D12 教程四层测试的机械化（族数随维度仪器化递增,以下表为准）。产出=可直接贴进 `../profiles/` 档案的实测数据。判据方法论权威=`docs/tutorials/D12-新模型接入与验证.md`,本目录只管"怎么跑"。

| 族 | 层级 | 形态 | 状态 |
|---|---|---|---|
| `protocol/` | 层一:协议面 | curl 脚本,零引擎 | 待实装(D12 层一四探针的脚本化——今日全部手工跑过,命令在教程里) |
| `output-cap/` | 层一:协议面 | 零引擎直连,一键跑批 | ✅ ../run-output-cap.mjs(对 ~/.hopjit/config.yaml 全部 anthropic 协议 provider 各发 2 次必然超长的请求〔缺省从 1 数到 15000,请求 max_tokens=65536〕,比对响应 output_tokens 与请求值:stop_reason=max_tokens 且 output_tokens 低于请求值九成=端点自带输出上限,两发一致才记值〔发数缺省 2 而非跑批纪律的 n≥6:端点上限是协议面的确定性数值,不是能力统计,两发一致即可定;不一致会判"不稳定"不记值〕;任一发写满请求值=端点上限不低于请求值;全部自然结束=记"至少多少";表=output-cap/endpoint-output-caps.yaml,每端点一条带实测日期与数数长度,个别模型对长数数任务自己停笔时单独换 --count 补测、--merge 并入)。2026-09-26 实测:bailian_qwen 硬帽 4096;antchat(Ling) 写满 65536;deepseek 至少 47873;antchat_qwen(Qwen3.8-27B) 至少 8893——该模型数长了会自己停笔或拒写,没能把输出推到请求值,只证明没有 4096 这类低帽。起因 todo/0113:百炼 claude-code-proxy 端点硬帽 4096 且忽略请求 max_tokens,引擎截断报文据此分辨"端点上限"与"本地配置上限") |
| `context-window/` | 层一:协议面 | 零引擎直连,一键跑批 | ✅ ../run-context-window.mjs(量端点单次请求最多收多少输入 token、收进去的内容模型还读不读得到:输入开头放一句暗号,中间编号记录行填充,末尾问暗号;规模逐次翻倍直到端点拒收,再二分到 5% 以内;窗口读数取端点自己数的输入 token〔usage 三项之和,两家端点会自动缓存相同前缀,只看 input_tokens 会少算〕;收下却答不出暗号=名义窗口够、实际用不上,单独记;超窗是报错还是回 200 静默截断记进 over_window_behavior;表=context-window/endpoint-context-windows.yaml,--merge 只替换本次测到的端点)。2026-09-28 实测:qwen_flash 收下 99.2 万但 77 万起答不出开头暗号〔实用按 ≤51 万〕;glm_flash 103 万全程读得到;deepseek 102 万全程读得到〔档案原记官方 128K〕;antchat(Ling) 25.6 万全程读得到;四家超窗都报错拒收;bailian_qwen(qwen27) 约 100 万(收下 1000203,端点硬限 1048576)且全程读得到〔分两次量:第一次到 89.6 万时百炼账户欠费,充值后续量出上界——此后探针遇到欠费/鉴权类报错直接中止,不再当超窗拒收记〕 |
| `smoke/` | 层二:引擎冒烟 | 最小 spec | ✅ onboard-smoke.md(两步:reason 真调用+body 机械步;跑法=项目级 hopjit.yaml 指目标模型后 start_run) |
| `act-free-stability/` | 层三核心 | 格点任务 spec | 矩阵契约已立(grid.yaml);格点任务模板与跑批待实装(挂 todo/0095——物理刀的验收仪器) |
| `capability/` | 层三:通识组定性 | 混合 | 待实装 |
| `extract-scaling/` | 层三:G2 任务复杂度(主)+P3 修订落实 | 尺寸阶梯语料+答案键,一键跑批 | ✅✅ 全仪器化:../run-task-complexity.mjs(单发裸能力对答案键机械判分;语料六档 XS2/S4/M9/L18/XL40/XXL80 点,高档 gen-corpus.mjs 生成——点数与 pad-ratio 双轴独立调,键自动派生;三模型全档曲线在库);P3 修订落实=../run-revision-ab.mjs(引擎真实装配修订轮考卷:fact-check 范本跑 S 档语料,提取步交带两处毛病的上一版、验收步打回两条意见,取引擎回到提取步时装配的上下文直连发给模型;两组只差修订 prompt 档位〔标准态/短卷〕,四关机械判分〔形态/补数值/改行号/没点名处原样〕,另记只看原文摘抄与分类的宽口径;--regrade 按现行判分规则重判已存响应;2026-09-28 五模型在库,详见 extract-scaling/README.md 修订 A/B 节) |
| `reasoning-complexity/` | 层三:G1 推理复杂度 | 双任务阶梯(--task mul 乘法=直接推理 / --task div 除法 2N÷N 商 2N+1 位有效数字=迭代推理),一键跑批 | ✅✅ 全仪器化:../run-reasoning-complexity.mjs(禁工具纯推理,爬梯 n=5+贴线判定恒升 20 发确认;真值 BigInt 生成+Python 独立复算零误——mul 180 题/div 30 题;div 出题剔除舍入决定位 4/5 与进位改位数的脏题,判分只放行尾零格式差)。定档:mul=deepseek≥12/qwen 3/Ling 2;div(2026-09-19)=deepseek≥8(测程顶,16位÷8位 17 位有效数字 19/20)/qwen 2/Ling 测程下限之下(N2 不达标) |
| `code-generation/` | 层三:G6 代码生成 | Python 与 SQL 各三档:规范条款→Python 校验脚本(隐藏测试文件判退出码)、取数需求→SQLite 查询(隐藏测试数据判结果集全等);自愈回路,一键跑批 | ✅ 两种语言六题全仪器化:../run-code-generation.mjs(--selfcheck 参考解自检零模型调用;Python 脚本在引擎同款语法沙箱里跑,SQL 用 node:sqlite 只读库执行;隐藏测试从不反馈给模型,自愈只反馈公开样例与沙箱/执行报文;每题做过负向验证)。定档(2026-09-23,n=6):deepseek=Python 强/SQL 强 · qwen27=Python 中/SQL 强 · Ling=Python 弱/SQL 强中。HopSpec 写作归 hopbuild2 构建卷,大规模复杂档待建 |
| `judge-granularity/` | 层三:P1 核验能力 | 三层阶梯,一键跑批 | ✅✅ 全仪器化:../run-judge-granularity.mjs 一键复跑(语料/模板/判档规则/判分全在内);三模型同卷实跑在库(deepseek=open-ok/Ling=checklist-only/qwen=closed-questions-only——四档阶梯三档各有实例,判档规则被三模型数据校验) |
| 标准工作卷族(层四) | 层四:能力定位 | 真机全任务卷,跑仓库原件 spec | **正式测试项两卷(2026-09-19 作者定"deep research, fact check 都纳入正式能力测试项")**:①`examples/hop-fact-check.md`(完整版 303 行;综合卷——检索链考 G4、fact/inference 二分与推演点前提溯源+推理有效性四级审查考 G1 推理可信、逐点并行考交付面;27b 微判定变体 350 行同功能面,弱模型跑变体强模型跑母本);②`examples/hop-deep-research/hop-deep-research.md`(工具重卷——多子问题 fan-out+独立二源对抗验证+引用报告,G4/P2 主考场,比 fact-check 重一档;尚未进过跑批,首跑待排)。跑批纪律与探针同源:spec 恒从仓库原件现拷、模型身份取响应体、结果按维度归因入档案不记总分 |
| `real-task-scaling/` | 层四×G2:真实任务复杂度阶梯 | 真实材料尺寸阶梯 × 标准工作卷 | **语料已建(2026-09-19 作者定"找不同大小的新闻稿/不同大小的 skill 来验证,作为实际的任务复杂度度量任务")**:阶梯一/二=四档真实新闻稿(0.7K/1.9K/5.1K/28.4K,原文零改写带出处)× fact-check 与 deep-research;阶梯三=五档真实 spec(2.8K~78K 仓库原件)× deep-validate 判官卷。判分=机械面(完备率/SCHEMA 计数/tokens 账)+强模型基线对照+人工抽查(推演判定与风险条目真伪);三模型跑批待排。契约详见其 README |

跑批入口分族实装中(0095):首件 `run-judge-granularity.mjs --service <service_id> [--n 6]`(P1 三层阶梯一键复跑——L2/L3 机械判分+判档建议,L1 出自反比对材料归人判;三模型 2026-09-18 实跑定档)。统一入口 run-probes.mjs 等第二件族脚本落地后再收拢。

**端点报错不是能力读数**(2026-09-28 百炼账户欠费实撞后加):直连探针拿到非 2xx 响应一律中止、不计分——原先把欠费拒收的空响应当"模型答错"计,差点把 qwen-flash 开思考记成"乘法 N=2 都不达标"。限流与服务端错由各探针自己的重发逻辑处理,重发后仍失败同样中止。

四条跑批纪律(与档案纪律同源,详见 ../README.md):每格 n≥6;实测与推断分标;模型身份取响应体 model 字段;**被测 spec 恒每次起跑前从仓库原件现拷**(工作面里的 spec 副本一律视为陈旧——实撞:A5 重跑误用别的评测目录下的旧副本,母本刚补的声明行不在场,验的是已废形态;评测工作面手工散拷 N 份没有任何新鲜度保障,与 hopissues/0096"陈旧副本静默被加载"同款病根。跑批脚本实装后由脚本强制现拷,手工跑批期间靠本条纪律)。
