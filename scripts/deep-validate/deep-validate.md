# Spec: 跑前深检（deep-validate）
Id: deep-validate
Goal: 对一份 HopSpec 做跑前运行期假设检查——把每个步骤说明教的动作与目标执行模式的真实能力面对照,按判据台账五面逐面审毕,产出建议性风险报告（validate 的深化档:validate 管静态文法,本 spec 管静态判不了的运行期假设;不阻断,报告呈人）
> 设计权威 docs/design/deep-validate.md ^anc-meta-deep-validate-contract。fast 三硬约束：LLM 调用 O(1) 不随被审 spec 规模增长（单 reason 步过全部判据面,不分批）；输入控量三件（被审 spec 全文+validate 机械体检单+环境事实）,零源码翻查（引擎能力面事实预沉在判据台账知识文档里作教材）；分钟级时延。

Constraints:
- 产出是建议性风险报告,不设强制闸——采不采纳归人,validate 的 error 拦执行照旧,两层不混
- 判据全部来自注入的判据台账知识文档,禁止自创判据;每条风险必须能指出"说明文字的哪句话 × 环境事实的哪一条"矛盾,推测性的"可能有问题"不报

Inputs:
- spec_path: line  # 被审 spec 文件路径（workspace 相对）
- exec_mode: enum(standalone, driver)  # 目标执行模式（standalone=引擎直调 LLM API / driver=复用模式,CC 等 driver 亲自执行）

Outputs:
- risk_report: markdown  # 风险清单（每条=坑位/病理/修法建议/严重度;五个判据面逐面表态）

## Steps

1. [act] 机械备料
  - ← spec_path
  + → spec_text: text  # 被审 spec 全文（原文本体逐字）
  + → health_report: text  # validate 机械体检单（validate_spec 返回的 {status, errors, warnings} JSON——warning 是白送的缺陷线索,推理步逐条表态）
  + → env_config: text  # 项目 hopjit.yaml 原文（命令白名单等项目级环境事实;文件缺席=空串,如实入料——空白名单意味着一切 subprocess.run 必拒）
  > 纯机械备料,body 引擎直执零 LLM（输入控量三件在此集齐,推理步零翻查。exists 返回 JSON 文本,须 parse_json 取 .exists 才能当条件——裸用非空字符串恒真,文件缺席时 read 必炸）：
  > ```hop_python
  > spec_text = read(path: spec_path)
  > health_report = validate_spec(text: spec_text)
  > probe = parse_json(exists(path: "hopjit.yaml"))
  > env_config = read(path: "hopjit.yaml") if probe.exists else ""
  > ```

2. [subtask retry=2] 推理检查与齐格
  - ← spec_text, health_report, env_config, exec_mode, spec_path
  + → risk_report: markdown  # 齐格通过的风险报告（聚合输出）

  2.1. [reason] 五面推理检查
    - ← spec_text, health_report, env_config, exec_mode, spec_path
    - 工具: read  # 被审 spec 大件时 spec_text 超阈被节选卸载,按卸载指针读全文（实撞:零工具面下模型照指路伸手,把 read 调用写成文本交卷三连烧尽）
    + → risk_report: markdown  # 风险清单全文
    > 对被审 spec（spec_text,路径 spec_path）做跑前运行期假设检查。**单步过全部判据面,不分批**。按注入的判据台账逐面判定：五个判据面（执行模式能力面矛盾/确定性步骤形态/体量模式/环境依赖/写域与路径）每面按"判什么/怎么判/修法方向"执行,对照环境事实教材节的能力面硬事实（standalone 工具面十件/写域规则/命令白名单机制/复用模式 caller 面）。exec_mode 决定用哪套能力面判。env_config 是项目 hopjit.yaml 原文（判据面四的白名单核对基准;空串=无白名单）。health_report 的每条 warning 逐条表态（采纳为风险/不构成风险因为 X）。
    > 报告形态（markdown）：开头一行结论（风险 N 条:高 X 中 Y 低 Z）;然后**五个判据面逐面成节**,每面写"查了,结论无风险"或逐条列风险;每条风险四件套=坑位（步骤号+说明原文引文）/病理（指向环境事实教材的哪条硬事实）/修法建议（可执行的具体改法）/严重度（高/中/低,分级判据见台账使用说明）;末尾一节列 health_report warning 的逐条表态。
    > 重试反馈非空时=上一轮齐格未过（缺口清单）——定向补齐所缺的面/所缺的表态,已合格的部分原样保留不重写。引擎已自动注入（doc-ref）：
    > - 判定纪律与风险条目形态：[[deep-validate-knowledge#使用说明]]
    > - 五个判据面：[[deep-validate-knowledge#判据面一 执行模式能力面矛盾]]、[[deep-validate-knowledge#判据面二 确定性步骤形态]]、[[deep-validate-knowledge#判据面三 体量模式]]、[[deep-validate-knowledge#判据面四 环境依赖]]、[[deep-validate-knowledge#判据面五 写域与路径]]
    > - 环境事实教材（能力面硬事实,判定的对照基准）：[[deep-validate-knowledge#环境事实教材]]

  2.2. [check final] 报告齐格
    - ← risk_report, health_report
    + → report_ok: bool  # 判定槽
    + → report_note: text  # 说明槽（缺口清单——哪个面缺表态/哪条建议不可执行,回填给重试轮定向补）
    > 审毕清单制核验,三判全过才放行：①**五面各有表态**——报告里五个判据面逐面成节,每面有"无风险"结论或风险条目,任何一面缺席=静默跳面,不过;②**建议可执行**——每条风险的修法建议指到具体改法（改哪步/改成什么形态）,"注意一下/建议检查"这类空话=不过;③**条目四件套齐**——每条风险有坑位（带步骤号）/病理/修法/严重度四件。**warning 表态按闭口径核**：warning 全集就是输入 health_report 里的那几条（可能为零条）,逐条对号核报告有无表态——全集之外不存在"其他潜在警告",不许把没有的 warning 当缺口打回（实撞:判官对着只有两条 warning 的清单打回"缺少其他 warning 的表态",幻觉核对象烧尽重试）。不过时 report_note 一次列全全部缺口（它就是重试轮的定向工单,挤牙膏=多烧一轮）。

3. [exit] 交付风险报告
