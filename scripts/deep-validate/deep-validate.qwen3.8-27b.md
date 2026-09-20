# Spec: 跑前深检（deep-validate）— Qwen3.8-27B 变体
Id: deep-validate-qwen27b
Goal: 对一份 HopSpec 做跑前运行期假设检查——把每个步骤说明教的动作与目标执行模式的真实能力面对照,按判据台账逐面审毕,产出建议性风险报告（validate 的深化档:validate 管静态文法,本 spec 管静态判不了的运行期假设;不阻断,报告呈人）
> 变体产物——母本 scripts/deep-validate/deep-validate.md,目标 profile=model-gearbox/profiles/qwen3.8-27b.yaml,生成 2026-09-18。
> 降档原理（作者定性:inline tool use 打环死锁的病根=缺乏可靠规划能力——"什么时候取料/取几次/何时停"交模型临场定,它就在这个自由度里打环）:①LLM 步零 inline 工具——一切取料前置为 hop_python body 机械步,读什么/读几次生成期定死;②大料不走变量卸载通道——body 直读盘面切片喂小段,供给面控在该模型走偏阈值下;③单步认知负载减半——五面合审拆成逐面小步,每步一面一产出;④审毕聚合归机械拼接。母本改动后本变体须重新生成。

Constraints:
- 产出是建议性风险报告,不设强制闸——采不采纳归人,validate 的 error 拦执行照旧,两层不混
- 判据全部来自注入的判据台账知识文档,禁止自创判据;每条风险必须能指出"说明文字的哪句话 × 环境事实的哪一条"矛盾,推测性的"可能有问题"不报

Inputs:
- spec_path: line  # 被审 spec 文件路径（workspace 相对）
- exec_mode: enum(standalone, driver)  # 目标执行模式（standalone=引擎直调 LLM API / driver=复用模式,CC 等 driver 亲自执行）

Outputs:
- risk_report: markdown  # 风险清单（每条=坑位/病理/修法建议/严重度;判据面逐面表态）

## Steps

1. [act] 机械备料与切片（取料全部在此定死——LLM 步零取料权）
  - ← spec_path
  + → header_slice: text  # 被审 spec 头部段（Goal/Constraints/Inputs/Outputs/Tools——判据面一/四的料）
  + → steps_slice_1: text  # Steps 前半（判据面二/三/五逐步扫描的料,按行数对半切）
  + → steps_slice_2: text  # Steps 后半
  + → health_report: text  # validate 机械体检单（{status, errors, warnings} JSON）
  + → env_config: text  # 项目 hopjit.yaml 原文（文件缺席=空串,如实入料）
  > 纯机械备料,body 引擎直执零 LLM。切片判据:头部=首个 "## Steps" 行之前全文;步骤区按行数对半切两片（单片控制在约两万字符内——目标模型长供给走偏阈值下;超大 spec 两片仍超限时如实截断并在片头标注）。取料动作全部发生在本步,后续 LLM 步只消费变量:
  > ```hop_python
  > full_text = read(path: spec_path)
  > health_report = validate_spec(text: full_text)
  > probe = parse_json(exists(path: "hopjit.yaml"))
  > env_config = read(path: "hopjit.yaml") if probe.exists else ""
  > rows = split(full_text, "\n")
  > steps_at = [i for i in range(len(rows)) if startswith(strip(rows[i]), "## Steps")]
  > cut = steps_at[0] if len(steps_at) > 0 else 0
  > header_slice = join([rows[i] for i in range(cut)], "\n")
  > body_rows = [rows[i] for i in range(cut, len(rows))]
  > half = len(body_rows) // 2 + 1
  > steps_slice_1 = join([body_rows[i] for i in range(half)], "\n")
  > steps_slice_2 = join([body_rows[i] for i in range(half, len(body_rows))], "\n")
  > ```

2. [subtask retry=2] 判据面一与四：能力面矛盾与环境依赖（头部料）
  - ← header_slice, env_config, exec_mode, health_report
  + → facet_14: markdown  # 两面的表态与风险条目

  2.1. [reason] 审头部两面
    - ← header_slice, env_config, exec_mode, health_report
    + → facet_14: markdown  # 判据面一（执行模式能力面矛盾）与判据面四（环境依赖）逐面成节
    > 只审两个判据面,料只有头部段与环境配置。判据面一:头部 Tools 段声明 × 目标执行模式能力面对照;判据面四:subprocess.run/外部件 × env_config 白名单对照。每面写"查了,结论无风险"或逐条列风险（每条四件套=坑位〔步骤号+原文引文〕/病理/修法建议/严重度）。health_report 里与这两面相关的 warning 逐条表态。引擎已自动注入（doc-ref）：
    > - 判定纪律与风险条目形态：[[deep-validate-knowledge#使用说明]]
    > - 判据：[[deep-validate-knowledge#判据面一 执行模式能力面矛盾]]、[[deep-validate-knowledge#判据面四 环境依赖]]
    > - 环境事实教材：[[deep-validate-knowledge#环境事实教材]]

  2.2. [check] 两面齐格
    - ← facet_14
    + → f14_ok: bool  # 判定槽
    + → f14_note: text  # 说明槽（缺口清单回填重试轮）
    > 两判:两面各有表态（缺一面=不过）;风险条目四件套齐。不过时缺口一次列全。

3. [subtask retry=2] 判据面二三五·前半（steps_slice_1）
  - ← steps_slice_1, exec_mode, health_report
  + → facet_235a: markdown  # 三面对前半步骤区的表态

  3.1. [reason] 审步骤前半三面
    - ← steps_slice_1, exec_mode, health_report
    + → facet_235a: markdown  # 判据面二（确定性步骤形态）/三（体量模式）/五（写域与路径）对本片逐面成节
    > 只审给定的前半片,三面逐面表态,条目四件套同上;片外步骤不猜不审（后半归下一步）。引擎已自动注入（doc-ref）：
    > - 判定纪律：[[deep-validate-knowledge#使用说明]]
    > - 判据：[[deep-validate-knowledge#判据面二 确定性步骤形态]]、[[deep-validate-knowledge#判据面三 体量模式]]、[[deep-validate-knowledge#判据面五 写域与路径]]
    > - 环境事实教材：[[deep-validate-knowledge#环境事实教材]]

  3.2. [check] 前半齐格
    - ← facet_235a
    + → f235a_ok: bool  # 判定槽
    + → f235a_note: text  # 说明槽
    > 三面各有表态+条目四件套齐,缺口一次列全。

4. [subtask retry=2] 判据面二三五·后半（steps_slice_2）
  - ← steps_slice_2, exec_mode, health_report
  + → facet_235b: markdown  # 三面对后半步骤区的表态

  4.1. [reason] 审步骤后半三面
    - ← steps_slice_2, exec_mode, health_report
    + → facet_235b: markdown  # 同 3.1 判据,对后半片
    > 同 3.1 口径,只审后半片。引擎已自动注入（doc-ref）：
    > - 判定纪律：[[deep-validate-knowledge#使用说明]]
    > - 判据：[[deep-validate-knowledge#判据面二 确定性步骤形态]]、[[deep-validate-knowledge#判据面三 体量模式]]、[[deep-validate-knowledge#判据面五 写域与路径]]
    > - 环境事实教材：[[deep-validate-knowledge#环境事实教材]]

  4.2. [check] 后半齐格
    - ← facet_235b
    + → f235b_ok: bool  # 判定槽
    + → f235b_note: text  # 说明槽
    > 同 3.2 口径。

5. [act] 机械拼接总报告
  - ← facet_14, facet_235a, facet_235b
  + → risk_report: markdown  # 聚合报告（逐面表态全集）
  > 纯机械拼接零 LLM（聚合不需要判断——各面表态已在分步齐格过关）:
  > ```hop_python
  > risk_report = "# 跑前深检风险报告（分面审毕）\n\n" + facet_14 + "\n\n" + facet_235a + "\n\n" + facet_235b
  > ```

6. [exit] 交付风险报告
  - ← risk_report
