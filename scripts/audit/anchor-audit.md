# Spec: 锚点一致性审计
Id: anchor-audit
Goal: 锚点追溯链全量一致性审计的编排壳——依次编排三块性质不同的工作：anchor-scan（确定性扫描+结构比对，脚本机检，日常已挂 check:audit）→ anchor-semantic-audit（按模块分批 LLM 读源判忠实，语义审计核心，产物带时间戳供 release 闸核验）→ anchor-fix（可选写操作修复，经人确认）。三块各自可独立执行，本 spec 提供全量入口
> 三块工作（性质与守卫规范手段类型学对齐，见 Constraints）：
> - **块一 anchor-scan**（步骤 3-4，确定性机检）：scan.py 六层锚点采集 + cross_compare.py 15 项集合比对 + 报告撰写。此块日常已由 `check:audit`/run-audit.mjs 独立执行——本 spec 内跑它是为全量审计的完整性与报告；
> - **块二 anchor-semantic-audit**（步骤 5-6，语义审计核心）：按模块聚合分批、并行 LLM 读源文件判 S→D/D→C/C→T 忠实。**这是台账 G3"发版前必跑"、release ④a 闸核验的真正对象**——汇总落盘 `semantic_audit_summary.yaml`（带时间戳），闸核它而非 cross_compare 产物（后者每次 check 都刷新，核它=恒绿假闸）；
> - **块三 anchor-fix**（步骤 7-8，写操作）：展示结果、经人确认后修复——审计只读、修复显式分离（同 act/commit 分离哲学）。

Constraints:
- **宪法级原则**（最高强制，违反即错）：每一个锚点都以最严格标准审计，不采样、不跳过、不降级；语义审计必须读源文件而非凭 ID/行号推断；每个 ⚠️ 都必须记录并解释。完整表述见语义/汇总步注入的 [[anchor-audit-knowledge#宪法级原则]]。
- **确定性用脚本、判断用 LLM**：锚点扫描、集合差运算、行号验证等有确定答案的工作由 Python 脚本执行（scan.py / cross_compare.py），LLM 不做计数/集合差/字符串匹配；语义一致性判断由 LLM 读源文件完成。
- **doc-ref 自动注入**：步骤 `>` 指令里的 doc-ref（双方括号包"文档名 + 井号 + 章节名"，如下方各步引用 anchor-audit-knowledge 的具体章节）由引擎运行期切片、自动注入该步 agent 上下文（小节内联、超阈值转 $file 指针），**无需手动查阅**；审计判据沉于知识文档、spec 留编排骨架，引用即注入。
- **锚点命名/语法权威**：`anc-{category}-{concept}` 格式、各层 `^`/`@a:`/`@v:` 行尾语法、组标题白名单——判据由各步引擎注入 [[anchor-audit-knowledge#锚点命名格式]]、[[anchor-audit-knowledge#各层锚点语法]]、[[anchor-audit-knowledge#组标题锚点白名单]]，禁止自创判据。
- **输出隔离**：所有中间文件写入 `{project_root}/.anchor-audit/`；语义审计每批结果独立写盘 `batch_{module}_results.yaml`（按模块名标识），resume 时保留已有批次。
- **中文输出**：所有报告和摘要用中文。

Inputs:
- project_root: line  # 待审计工程根目录（含设计目录 docs/design/ 或 design/、src/、tests/、TRACEABILITY.md），默认当前工作目录（cwd）
- scripts_dir: line  # 存放 scan.py/cross_compare.py 的目录，**绝对路径**。权威源在本库 scripts/audit/（随 spec 入库、可分发自足）。由 caller/driver 按 skill 安装位置或库内路径提供
- concept_dir: line  # 概念层 Markdown 目录（S→D 语义审计权威源，传给 scan.py --concept-dir），相对 project_root；多目录空格分隔；空=无概念层则 S→D 维度 skip
- audit_mode: line  # fresh（默认，清理 .anchor-audit/ 中间产物全新审计——semantic_audit_summary.yaml 台账恒不删,module_ledger 增量合并要读旧账）/ resume（另保留 batch_*_results.yaml 断点续传）
- modules: line  # 按模块跑：空（默认）=全量；非空=空格分隔的模块名列表（如 "step-dispatcher mcp-server"）——块一扫描仍全库（脚本廉价且结构比对需全景），块二语义审计只审这些模块，汇总标注审计范围

Outputs:
- report_path: line  # 结构审计报告绝对路径（Write 写 {project_root}/.anchor-audit/report.md 后返回的实际路径）
- semantic_summary: text  # 语义审计汇总（S→D/D→C/C→T 三维通过率 + 模块规模表 + ❌/⚠️ 清单）

## Steps

1. [act] 准备审计环境
  - ← project_root, scripts_dir, concept_dir, audit_mode
  + → design_dir: line  # 设计文档目录，相对 project_root（探测命中的实际名；候选序 docs/design → design，与 scan.py 缺省一致）
  + → src_dir: line     # 代码目录，相对 project_root（默认 src）
  + → test_dir: line    # 测试目录，相对 project_root（默认 tests）
  + → paths_report: text  # 探测结果摘要（各路径是否存在 + audit_mode 清理动作）
  > 无推理纯准备（2026-09-01 脚本化 prep_env.py——原形态教 LLM 用文件工具删 .anchor-audit/ 旧产物,standalone 写域闸拒〔WORK_ZONE_ONLY,该目录不在 work_zone〕第八跑实撞;探测/清理/PyYAML 自证全归脚本:fresh 清全部中间产物、resume 保留 batch_*_results 断点;semantic_audit_summary.yaml 恒不删——module_ledger 增量合并要读旧账〔6.2 条款〕,原 fresh"清空整个目录"连台账一起删是设计缺口,脚本化顺手修正）。
  > ```hop_python
  > cd_arg = ["--concept-dir", concept_dir] if concept_dir else []
  > am_arg = ["--audit-mode", audit_mode] if audit_mode else []
  > r = subprocess.run(["uv", "run", "--with", "pyyaml", "python3", scripts_dir + "/prep_env.py", project_root] + cd_arg + am_arg, cwd: project_root, timeout: 120)
  > prep = parse_json(r.stdout)
  > design_dir = prep.design_dir
  > src_dir = prep.src_dir
  > test_dir = prep.test_dir
  > paths_report = prep.paths_report
  > ```

2. [ask present_inputs=paths_report] 确认审计范围
  - ← paths_report
  + → scope_confirmed: line  # 用户确认信号（approve=按 paths_report 探测到的 design/src/test/concept 路径执行后续扫描）
  > 展示 paths_report（driver 据 present_inputs 硬约束必须完整 dump 探测结果给 user）：探测到的设计/代码/测试/概念目录 + audit_mode 清理动作。请 caller 确认这组路径正确、可据此扫描；用户已显式指定范围时此步可直接 approve。scope_confirmed 仅是放行信号，实际路径由 step 1 产出的 design_dir/src_dir/test_dir 承载，后续步骤直接用那几个变量，不从 scope_confirmed 取路径。

3. [subtask retry=2] 脚本扫描六层锚点
  - ← project_root, scripts_dir, concept_dir, design_dir, src_dir, test_dir, scope_confirmed
  + → scan_ok: bool  # 六份 YAML 齐备（子任务聚合输出，gate 结构/语义审计）

  3.1. [act] 运行 scan.py
    - ← project_root, scripts_dir, concept_dir, design_dir, src_dir, test_dir
    + → scan_done: line  # 扫描完成标记 + scan.py 退出码摘要
    > 无推理纯脚本调用（2026-09-01 body 化——原无 body 形态在 standalone 撞死:LLM 工具面无命令执行,tool_failure 自报耗尽;说明本就写"无推理纯脚本调用",恰是 subprocess.run body 正形。运行前提:sandbox.runtime.available 白名单须含 uv——经 `uv run --with pyyaml python3` 起(引擎 spawnSync 不吃 shell alias,裸 python3 落到系统装缺 pyyaml,2026-09-01 probe 实锤 rc=2;uv 一次性供依赖零系统污染)。白名单空时本步响亮拒,属环境配置缺失非本 spec 缺陷）。脚本输出 6 份 YAML 到 `{project_root}/.anchor-audit/`，各份内容与下游消费者由引擎注入（doc-ref）[[anchor-audit-knowledge#扫描产物说明]]。退出码 0=无违规，1=有命名违规/无效引用，2=运行错误。
    > ```hop_python
    > argv = ["uv", "run", "--with", "pyyaml", "python3", scripts_dir + "/scan.py", project_root, "--design-dir", design_dir, "--src-dir", src_dir, "--test-dir", test_dir]
    > argv = argv + (["--concept-dir", concept_dir] if concept_dir else [])
    > r = subprocess.run(argv, cwd: project_root, timeout: 300)
    > scan_done = "exit=" + str(r.returncode)
    > ```

  3.2. [check final] 验证六份 YAML 存在且非空
    - ← project_root, scan_done
    + → scan_ok: bool  # 判定槽：6 份 YAML 齐备
    + → scan_issue: text  # 说明槽：缺失/空文件清单（通过时不查看）
    > **机械检查、非 LLM 判断**（2026-09-01 body 化——原说明教"driver 用 test -s 判"系复用模式写法,standalone 判官 LLM 无文件工具判不了,如实拒判耗尽;确定性检查的正形=check body 引擎直执零 LLM;文件工具走 workspace 相对路径——沙箱禁绝对路径,0042 doc-review 第十一次同款实撞）：六份文件均存在且非空（concept_anchors 即便无概念层也由脚本写空壳带 note，仍应存在）。任一缺失或空 → scan_ok=false，scan_issue 列问题文件，触发 subtask retry 重跑 scan.py。
    > 注：用 `[check final]` 而非 act，是因它是 subtask 的契约验收门——失败才能触发 subtask retry 重跑扫描。
    > ```hop_python
    > names = ["concept_anchors.yaml", "design_anchors.yaml", "code_anchors.yaml", "test_anchors.yaml", "traceability_cards.yaml", "module_anchors.yaml"]
    > probes = [parse_json(exists(path: ".anchor-audit/" + n)) for n in names]
    > present = [names[i] for i in range(len(names)) if probes[i].exists]
    > contents = [read(path: ".anchor-audit/" + n) for n in present]
    > empty = [present[i] for i in range(len(present)) if len(strip(contents[i])) == 0]
    > missing = [n for n in names if n not in present]
    > scan_ok = len(missing) == 0 and len(empty) == 0
    > scan_issue = "六份齐备非空" if scan_ok else "缺失: " + join(missing, ", ") + " 空: " + join(empty, ", ")
    > ```

4. [subtask] 结构比对与报告
  - ← project_root, scripts_dir
  + → report_path: line  # report.md 写盘路径

  4.1. [act] 运行集合运算脚本
    - ← project_root, scripts_dir
    + → compare_done: line  # cross_compare 完成标记
    > 无推理纯脚本调用（2026-09-01 body 化,与 3.1 同批同因）：脚本读 6 份 YAML 做 15 项集合运算（概念→设计、设计→代码、代码→测试/设计/追溯、模块三维校验等，逐项定义由引擎注入下一步的 [[anchor-audit-knowledge#结构比对判据]]），透传模块规模，输出 `{project_root}/.anchor-audit/cross_compare_results.yaml`。
    > ```hop_python
    > r = subprocess.run(["uv", "run", "--with", "pyyaml", "python3", scripts_dir + "/cross_compare.py", project_root], cwd: project_root, timeout: 300)
    > compare_done = "exit=" + str(r.returncode)
    > ```

  4.2. [reason] 解读比对结果并撰写报告正文
    - ← project_root, compare_done
    + → report_md: text  # 结构审计报告完整 markdown 正文
    > 读 `{project_root}/.anchor-audit/cross_compare_results.yaml`（脚本已完成全部集合运算，你只解读、判严重度、撰写，不重做集合差）。按引擎注入的以下判据解读每一项并判定严重度（P0 链路断裂 / P1 覆盖缺口 / P2 命名风格），按注入的报告模板组织成完整 markdown 正文（含 module_scale 模块规模表）。引擎已自动注入（doc-ref）：
    > - 15 项比对的语义与缺失含义：[[anchor-audit-knowledge#结构比对判据]]
    > - 报告章节结构与统计表格式：[[anchor-audit-knowledge#报告格式模板]]

  4.3. [act] 写盘结构审计报告
    - ← report_md, project_root, scripts_dir
    + → report_path: line  # 写盘路径
    > 无推理纯写盘（2026-09-01 经 write_artifact.py——act 文件工具写域=work_zone only,.anchor-audit/ 持久产物被闸拒〔第十一跑实撞〕;审计产物与 scan.py 六份 YAML 同性质=审计工具的工作产物,同 scan.py 由白名单脚本自主写盘,不经引擎文件工具写域闸）：
    > ```hop_python
    > r = subprocess.run(["uv", "run", "--with", "pyyaml", "python3", scripts_dir + "/write_artifact.py", project_root, "report"], input: report_md, cwd: project_root, timeout: 60)
    > report_path = strip(r.stdout)
    > ```

5. [subtask] 语义一致性审计（全量或按模块）
  - ← project_root, modules
  + → batch_digests: [line]  # 各批摘要行（模块名+盘上路径+计数——全文只落盘不过变量通道，控量）

  5.1. [act] 按模块聚合分批
    - ← project_root, scripts_dir, modules, audit_mode
    + → batches: [text]  # 每元素=一个模块的待审计批（模块名 + 规模 + 该模块全部锚点 id/code/design 位，自包含）
    > 无推理纯计算（2026-09-01 脚本化——原形态让 LLM 读两份 YAML 后亲手产出全部锚点清单,395 锚点的转写必烧穿 max_tokens〔第七跑实撞 output_tokens=65536 工具循环轮掐断〕;本步恰是 Constraints"确定性用脚本、判断用 LLM"的脚本侧,归位 make_batches.py:锚点归模块/设计位反查/模块过滤防拼错/隔离声明,全在脚本内做——LLM 零转写,body 跑完 read 读回结构化产物）。**断点续传按模块名标识**：批文件名 = `batch_{module}_results.yaml`——5.2.1.2 写盘用模块名,resume 靠名匹配跳过已完成模块（位置序号会错位,弃用）。
    > ```hop_python
    > mods_arg = ["--modules", modules] if modules else []
    > resume_arg = ["--resume"] if audit_mode == "resume" else []
    > r = subprocess.run(["uv", "run", "--with", "pyyaml", "python3", scripts_dir + "/make_batches.py", project_root] + mods_arg + resume_arg, cwd: project_root, timeout: 120)
    > raw = read(path: ".anchor-audit/batches.json") if r.returncode == 0 else ""
    > batches = parse_json(raw).batches
    > ```

  5.2. [loop for-each batch in batches, collect batch_digest into batch_digests] 逐批并行语义审计
    + → batch_digests: [line]  # 各批摘要行（顺序对应 batches）

    5.2.1. [subtask retry=2 parallel] 审计单批锚点
      - ← batch, project_root, scripts_dir
      + → batch_digest: line  # 本批摘要行：`{module} {写盘路径} anchors={n}`——结果全文在盘上，变量通道只走这一行（产出控量：全文过 collect 会在汇总步撑爆上下文与输出；err/warn 计数归 6.1 tally）

      5.2.1.1. [reason] 逐锚点判定 S→D / D→C / C→T
        - ← batch, project_root
        + → batch_result_item: text  # 本批结果 yaml 文本（批头 module+scale，每锚点含 s2d/d2c/c2t verdict+note）
        > 你是语义一致性审计员，工作关系到系统正确性——任何遗漏的不对齐都会累积并最终导致执行灾难，必须以最严格标准审查每一个锚点。batch 是**一个模块**（批头带模块名与规模），对批内的**每个**锚点按引擎注入的协议读源文件做判定，并结合模块规模判断覆盖是否失衡，产出本批结果 yaml 文本（批头记 module+scale，不写盘，写盘交下一步）。引擎已自动注入（doc-ref）：
        > - 单批执行步骤 + 按模块分批协议（读哪些文件、±行号范围、规模如何参与判断、输出 yaml 格式；**超 ~30 锚点的批必须按"大批分段落盘"分段执行,严禁一口气攒全量输出**）：[[anchor-audit-knowledge#单批语义审计执行协议]]
        > - 三维度判据与严格判断标准（error≠warn、字段数必须一致、⚠️ 必附说明）：[[anchor-audit-knowledge#语义审计维度判据]]

      5.2.1.2. [act] 写盘本批结果（断点保护+写前校验）并产摘要行
        - ← batch_result_item, batch, scripts_dir, project_root
        + → batch_digest: line  # 本批摘要行：`{module} {实际写盘路径} anchors={n}`
        > 写盘经 write_batch.py（2026-09-01 作者令"赶快做掉"——写前 parse 把关:批结果 YAML 坏形态原本静默落盘,几步外 6.1 读盘才炸,病灶离症状隔容器;脚本写前校验让打回发生在产批当轮——parse 炸即 rc=2 带行号与修法指路,本步失败触发 subtask retry,LLM 拿着报错重产。围栏壳/通体缩进两形态属可修复噪声脚本自剥并记录;真坏才拒）。写盘路径=`{project_root}/.anchor-audit/batch_{module}_results.yaml`——write_batch.py 是白名单脚本自主写盘（同 write_artifact 先例,不经引擎文件工具写域闸）,落点必须与 5.1 make_batches --resume 的断点判据（查 .anchor-audit/ 已有批结果）对齐,写进各子实例 work_zone 会让 resume 永远查不到已完成批而重复出批;digest 记实际写盘路径（下游 6.1 按它逐文件读）。
        > ```hop_python
        > mod_line = [l for l in split(batch, "\n") if startswith(l, "module:")][0]
        > mod = strip(replace(mod_line, "module:", ""))
        > out_path = project_root + "/.anchor-audit/batch_" + mod + "_results.yaml"
        > r = subprocess.run(["uv", "run", "--with", "pyyaml", "python3", scripts_dir + "/write_batch.py", out_path], input: batch_result_item, timeout: 60)
        > batch_digest = mod + " " + strip(r.stdout)
        > ```

6. [subtask] 汇总并落盘语义审计产物
  - ← report_path, batch_digests, project_root
  + → semantic_summary: text  # 汇总：S→D/D→C/C→T 通过率 + ❌ 项清单 + ⚠️ 明细 + 模块规模表

  6.1. [act] 汇总统计（确定性——脚本计数,产出控量）
    - ← batch_digests, project_root, scripts_dir
    + → semantic_summary: text  # 三维通过率表+模块规模表+❌清单+⚠️明细(体量与缺陷数同阶)
    + → tally_path: line  # tally JSON 落盘路径(work_zone;6.2 write_artifact 消费)
    > 统计计数是确定性工作（2026-09-01 脚本化 tally_batches.py——原形态让 LLM 读全部批次文件三维计数+抄录明细,10 份批次的 ⚠️ 明细抄录烧穿 max_tokens〔第十跑实撞 output_tokens=65536,retry 耗尽〕;Constraints"确定性用脚本、判断用 LLM"的脚本侧归位。脚本收 digest 里的实际路径清单——批结果由 5.2.1.2 写盘到 `.anchor-audit/`,路径以 digest 为准;围栏壳/通体缩进两形态容忍〔第十跑两份批文件实撞〕）。脚本输出 JSON(三维计数/通过率/err 全文/warn 明细),本步把 JSON 转 markdown 汇总表——转写量与缺陷数同阶。
    > ```hop_python
    > paths = [split(d, " ")[1] for d in batch_digests]
    > r = subprocess.run(["uv", "run", "--with", "pyyaml", "python3", scripts_dir + "/tally_batches.py"] + paths, cwd: project_root, timeout: 120)
    > tally = parse_json(r.stdout)
    > head = "# 语义审计汇总\n\n批次: " + str(tally.batch_count) + "\n通过率: s2d=" + str(tally.pass_rates.s2d) + " d2c=" + str(tally.pass_rates.d2c) + " c2t=" + str(tally.pass_rates.c2t) + "\n❌ " + str(len(tally.err_items)) + " 条 / ⚠️ " + str(len(tally.warn_items)) + " 条\n"
    > err_lines = ["- ❌ " + e.module + " " + e.anchor + " [" + e.dim + "] " + e.note for e in tally.err_items]
    > warn_lines = ["- ⚠️ " + w.module + " " + w.anchor + " [" + w.dim + "] " + w.note for w in tally.warn_items]
    > semantic_summary = head + "\n## ❌ 清单\n" + join(err_lines, "\n") + "\n\n## ⚠️ 明细\n" + join(warn_lines, "\n")
    > tally_path = work_zone_path("tally.json")
    > written = write(path: tally_path, content: r.stdout)
    > ```

  6.2. [act] 写盘语义审计产物（release 闸核验对象）
    - ← tally_path, project_root, scripts_dir, modules
    + → summary_written: line  # 写盘路径
    > 无推理纯写盘（2026-09-01 经 write_artifact.py,同 4.3 写域正形;audited_at/audited_commit 由脚本取真值;module_ledger 增量合并在脚本内——写盘前读旧 summary,范围外模块条目原样保留〔台账是"每模块最后审于哪个 commit"的累积账,scripts/audit-scope.mjs 据此推增量;semantic_audit_summary.yaml 是"语义审计最近何时真跑过"的唯一凭证,scope=full 才作全量凭证〕;拆段批名 module__partN 归并回模块名记账）：
    > ```hop_python
    > mods = split(modules, " ") if modules else []
    > r = subprocess.run(["uv", "run", "--with", "pyyaml", "python3", scripts_dir + "/write_artifact.py", project_root, "summary", tally_path] + mods, cwd: project_root, timeout: 60)
    > summary_written = strip(r.stdout)
    > ```

7. [ask present_inputs=semantic_summary] 展示审计结果并询问修复
  - ← semantic_summary
  + → fix_choice: line  # auto_fix（自动修复 P0+P1 结构项）/ report_only（仅查看报告）/ exit
  > 展示 semantic_summary 完整内容（driver 据 present_inputs 硬约束必须完整 dump 给 user）：结构审计统计 + 缺失/违规数，语义审计 S→D/D→C/C→T 通过率 + ❌ 清单 + ⚠️ 明细。询问 caller：是否自动修复可修复项？选项 auto_fix（加缺失 `@a:`/`@v:` 锚点、修正死引用文件名等结构项；语义 ❌ 需人工、⚠️ 逐一确认）/ report_only / exit。

8. [branch] 按用户选择执行
  - ← fix_choice
  + → fix_outcome: text  # 修复结果摘要或报告路径提示

  8.1. [case] 自动修复 (fix_choice == "auto_fix")
    + → fix_outcome: text

    8.1.1. [commit] 修复前 git 快照
      - ← project_root
      + → snapshot_done: line  # 快照 commit 标记
      > 不可逆操作（建立可回滚锚点）：在 {project_root} 若为 git 仓库，建立修复前快照。安全流程见 [[anchor-audit-knowledge#自动修复安全流程]]。
      > 运行前提：sandbox.runtime.available 白名单须含 git——白名单空时本步响亮拒，属环境配置缺失。
      > ```hop_python
      > probe = parse_json(exists(path: ".git"))
      > added = subprocess.run(["git", "add", "-A"], cwd: project_root) if probe.exists else ""
      > committed = subprocess.run(["git", "commit", "-m", "pre-anchor-audit snapshot"], cwd: project_root) if probe.exists else ""
      > snapshot_done = "snapshot-created" if probe.exists else "not-a-git-repo"
      > ```

      8.1.2. [act] 提取可修复项清单
        - ← project_root, snapshot_done
        + → fixable_items: yaml  # 可自动修复的结构项清单（加缺失 @a:/@v:、修正死引用文件名），按文件末尾→开头排序
        > 无推理纯计算：读 `{project_root}/.anchor-audit/cross_compare_results.yaml`，筛出可自动修复的结构项（设计→代码缺失需补 `@a:`、无效引用需修正文件名），**按"文件内位置从末尾向前"排序**（避免前序插入行导致后续目标位置偏移，见引擎注入的 [[anchor-audit-knowledge#自动修复安全流程]]）。语义 ❌ 项不入清单（需人工）。

      8.1.3. [loop max=200] 逐项修复
        - ← fixable_items
        + → fix_log: yaml  # 延续变量：跨迭代累积的已修复项记录（更新模式）
        8.1.3.1. [reason] 取下一未修复项并定修复方案
          - ← fixable_items, fix_log
          + → fix_plan: yaml  # 当轮变量：{done: bool, file, line, edit_kind, old_str, new_str} 或 done=true
          > 对照 fixable_items 与已记录的 fix_log，取下一个未修复项：全部修完 → fix_plan.done=true（触发退出）；否则产出该项的精确修复方案（目标文件、行号、edit_kind=add_anchor|fix_ref_path、old_str→new_str 的精确替换内容）。只规划一项，不动手改（动手交下一步 act）。

        8.1.3.2. [branch] 按是否还有待修项分流
          - ← fix_plan
          8.1.3.2.1. [case] 全部修完 (fix_plan.done == true)
            8.1.3.2.1.1. [break]

          8.1.3.2.2. [case] default
            8.1.3.2.2.1. [act] 应用单项修复
              - ← fix_plan, fix_log
              + → fix_log: yaml  # 更新延续变量：追加本项修复记录
              > 无推理纯执行（方案已由上一步 reason 定）：用 Edit 按 fix_plan 的 file/old_str/new_str 应用单项修复，把本项 {file, line, edit_kind, 结果} 追加进 fix_log。

      8.1.4. [act] 汇总修复结果
        - ← project_root, fix_log
        + → fix_outcome: text  # 变更摘要
        > 无推理纯计算：执行 `git -C {project_root} diff --stat` 取变更概览，结合 fix_log 组装变更摘要写入 fix_outcome（含已修复项数、涉及文件；并注明语义 ❌ 项未自动改、需人工修复）。

  8.2. [case] 仅查看报告 (fix_choice == "report_only")
    + → fix_outcome: text
    8.2.1. [act] 输出报告路径
      - ← report_path
      + → fix_outcome: text
      > 无推理：组装提示文本，告知结构审计报告位于 report_path、语义审计批次结果位于 {project_root}/.anchor-audit/batch_*_results.yaml，未做修改。

9. [exit] 交付审计结果
  > 返回结构审计报告路径 report_path 与语义审计汇总 semantic_summary。
