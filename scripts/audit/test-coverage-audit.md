# Spec: 测试覆盖率质量审计
Id: test-coverage-audit
Goal: 对一个工程做语言无关的测试覆盖率质量审计——脚本收集覆盖率与 mock 数据，逐个低覆盖文件独立分析缺口，审计 mock 合理性，产出结构化报告 + 摘要
> 检测项目类型（未配覆盖率工具则经审批安装）→ 运行覆盖率并解析出三份 YAML → 逐个低覆盖文件并行分析未覆盖区域严重度 → 审计 mock 质量 → 汇总报告写盘 → 展示摘要。
> 本 spec 由 test-coverage-audit 自然语言 skill 经 /hopbuild 翻译而来，三焦点均结构化落实。

Constraints:
- 机械扫描（检测/运行/解析覆盖率/低覆盖筛选组装）用 `collect_coverage.py`（经 subprocess.run 白名单 uv 通道执行），不用 LLM 做计数、解析或转写
- 覆盖质量判断由 LLM 读源文件完成——subagent 视角独立，不带项目历史与开发者偏好
- 中间文件写入 `{project_root}/.coverage-audit/`
- 安装覆盖率工具是外部副作用，必须经用户审批后才执行
- 运行前提：宿主 hopjit.yaml 的 commands 白名单须含 uv（脚本经 `uv run --with pyyaml python3` 执行）；覆盖率工具安装若涉 npm 等白名单外命令，安装动作归用户终端手工执行
- 运行前提：目标项目须已构建就绪（需编译产物的项目先跑构建，如 TS 项目 npm run build）——覆盖率跑的是测试，测试依赖 dist 等产物时未构建会整批失败（--run 恒 exit 0 但工具退出码非 0，失败原因在 run_error.txt）

Inputs:
- project_root: line  # 待审计工程根目录（须为 workspace 内相对路径——步骤 8 报告写盘与 .coverage-audit/ 中间产物均以 workspace 沙箱为界；审计工程根之外的工程时，须以该工程为 workspace 启动本 spec）
- scripts_dir: line  # collect_coverage.py 所在目录（绝对路径），由 caller 按 skill 安装位置提供

Outputs:
- report_path: line  # 结构化审计报告 audit_report.yaml 的写盘路径
- audit_summary: text  # 自然语言审计摘要（总体评级 + 关键发现 + 优先行动）

## Steps

1. [act] 检测项目类型与覆盖率工具
  - ← project_root, scripts_dir
  + → coverage_configured: bool  # 是否已配置覆盖率工具
  + → project_type: line  # 检测到的项目类型（vitest/jest/pytest/go 等）
  + → install_cmd: line  # 未配置时建议的安装命令（已配置则为 none）
  > body 引擎直执（零 LLM）：经白名单 uv 通道跑 collect_coverage.py --detect（脚本写 detection.yaml
  > 并把同内容 JSON 打到 stdout——coverage_configured/project_type/install_cmd 三键），
  > stdout 经 parse_json 直接拆到三个输出槽；脚本失败（returncode 非 0）时用一行必然失败的
  > 类型转换制造计算异常使本步失败，错误信息带 stderr。
  > ```hop_python
  > r = subprocess.run(["uv", "run", "--with", "pyyaml", "python3", scripts_dir + "/collect_coverage.py", ".", "--detect"], cwd: project_root, timeout: 120)
  > if r.returncode != 0:
  >     detect_error = int("检测脚本失败: " + r.stderr)
  > det = parse_json(strip(r.stdout))
  > coverage_configured = det["coverage_configured"]
  > project_type = det["project_type"]
  > install_cmd = det["install_cmd"]
  > ```

2. [branch] 按覆盖率工具是否已配置
  - ← coverage_configured, install_cmd, project_root
  + → setup_ok: bool  # 环境就绪信号（已配置或安装成功）

  2.1. [case] 未配置覆盖率工具 (coverage_configured == false)
    + → setup_ok: bool

    2.1.1. [confirm require_human] 请批准安装覆盖率工具
      - ← install_cmd, project_type
      + → install_approved: bool  # approve→安装；reject→全局中止
      > 展示待安装的覆盖率工具命令 install_cmd 与项目类型 project_type，
      > 请用户批准是否安装（安装会改动项目依赖，是外部副作用，须人工把关）。

    2.1.2. [commit] 安装覆盖率工具（仅白名单内命令直执）
      - ← install_cmd, install_approved, project_root
      + → setup_ok: bool  # 安装成功标记
      + → setup_note: text  # 安装结果说明（白名单外命令时=请用户终端手工安装的指引）
      > 不可逆外部副作用（改动项目依赖）：install_approved 为 true 且 install_cmd 的命令名在
      > 白名单 {git, uv} 内（pytest 场景 `uv pip install pytest-cov`）时 body 直执安装；
      > 命令名在白名单外（vitest 场景的 npm——npm 无 uv/git 等价，且包安装本就是须人工把关的
      > 外部副作用）时不直执：setup_ok=false，setup_note 指引用户在终端手工执行 install_cmd 后重跑本 spec。
      > 幂等设计：工具已装则跳过（包管理器天然幂等）。
      > ```hop_python
      > argv = split(install_cmd, " ")
      > allowed = argv[0] == "git" or argv[0] == "uv"
      > if allowed:
      >     r = subprocess.run(argv, cwd: project_root, timeout: 300)
      >     setup_ok = r.returncode == 0
      >     setup_note = "安装完成" if setup_ok else "安装命令失败: " + r.stderr
      > else:
      >     setup_ok = False
      >     setup_note = "安装命令 " + install_cmd + " 的命令名不在白名单 {git, uv} 内——请用户在终端手工执行该命令安装后重跑本 spec"
      > ```

  2.2. [case] default
    + → setup_ok: bool
    2.2.1. [act] 标记环境就绪
      - ← coverage_configured
      + → setup_ok: bool  # 已配置，直接就绪
      > 覆盖率工具已配置，body 直赋就绪标记。
      > ```hop_python
      > setup_ok = True
      > ```

3. [subtask retry=2] 运行覆盖率并解析数据
  - ← project_root, scripts_dir, setup_ok
  + → scan_ok: bool  # 三份 YAML 齐备（gate 后续分析）

  3.1. [act] 运行覆盖率工具
    - ← project_root, scripts_dir
    + → run_done: line  # 运行完成标记 + 退出码摘要
    > body 引擎直执（零 LLM）：经白名单 uv 通道跑 collect_coverage.py --run（脚本自身恒 exit 0，
    > 覆盖率工具的退出码在 stdout JSON 的 tool_returncode 键；工具失败时脚本已把输出尾部写入 run_error.txt）。
    > 工具退出码非 0 时 body 读 run_error.txt 摘要记入 run_done（后续 check 会拦）。
    > ```hop_python
    > r = subprocess.run(["uv", "run", "--with", "pyyaml", "python3", scripts_dir + "/collect_coverage.py", ".", "--run"], cwd: project_root, timeout: 1800)
    > if r.returncode != 0:
    >     run_script_error = int("运行脚本自身失败: " + r.stderr)
    > run_res = parse_json(strip(r.stdout))
    > if run_res["tool_returncode"] == 0:
    >     run_done = "覆盖率运行完成，退出码 0"
    > else:
    >     err_txt = read(path: project_root + "/.coverage-audit/run_error.txt")
    >     run_done = "覆盖率运行失败，首行: " + split(strip(err_txt), "\n")[0] + "（全文见 .coverage-audit/run_error.txt）"
    > ```

  3.2. [act] 解析覆盖率数据
    - ← project_root, scripts_dir, run_done
    + → analyze_done: line  # 解析完成标记（由 returncode 机械组装）
    > body 引擎直执（零 LLM）：经白名单 uv 通道跑 collect_coverage.py --analyze，
    > 产出 coverage_summary.yaml（每文件行/分支覆盖率）、uncovered_details.yaml（未覆盖行+源码上下文）、
    > mock_patterns.yaml（mock 按 (种类,目标) 分组统计+机械预筛候选组）到 `{project_root}/.coverage-audit/`；
    > analyze_done 按脚本退出码机械组装。
    > ```hop_python
    > r = subprocess.run(["uv", "run", "--with", "pyyaml", "python3", scripts_dir + "/collect_coverage.py", ".", "--analyze"], cwd: project_root, timeout: 300)
    > analyze_done = "解析完成，退出码 0" if r.returncode == 0 else "解析失败，退出码 " + str(r.returncode) + "，首行: " + split(strip(r.stderr), "\n")[0]
    > ```

  3.3. [check final] 验证三份 YAML 存在且非空
    - ← project_root, analyze_done
    + → scan_ok: bool  # 判定槽：三份 YAML 齐备
    + → scan_issue: text  # 说明槽：缺失/空文件清单（通过时不查看）
    > 机械判定由 body 引擎直执（零 LLM）：exists+read 逐份检查 `{project_root}/.coverage-audit/` 下
    > coverage_summary.yaml、uncovered_details.yaml、mock_patterns.yaml 三份文件均存在且非空。
    > 任一缺失或为空 → scan_ok=false、scan_issue 列出问题文件，触发 subtask retry 重跑。
    > ```hop_python
    > base = project_root + "/.coverage-audit/"
    > e1 = parse_json(exists(path: base + "coverage_summary.yaml"))
    > e2 = parse_json(exists(path: base + "uncovered_details.yaml"))
    > e3 = parse_json(exists(path: base + "mock_patterns.yaml"))
    > n1 = len(strip(read(path: base + "coverage_summary.yaml"))) if e1["exists"] else 0
    > n2 = len(strip(read(path: base + "uncovered_details.yaml"))) if e2["exists"] else 0
    > n3 = len(strip(read(path: base + "mock_patterns.yaml"))) if e3["exists"] else 0
    > scan_ok = n1 > 0 and n2 > 0 and n3 > 0
    > i1 = "" if n1 > 0 else "coverage_summary.yaml 缺失或为空；"
    > i2 = "" if n2 > 0 else "uncovered_details.yaml 缺失或为空；"
    > i3 = "" if n3 > 0 else "mock_patterns.yaml 缺失或为空；"
    > scan_issue = i1 + i2 + i3
    > ```

4. [act] 提取低覆盖文件清单
  - ← project_root, scripts_dir
  + → gap_files: [text]  # 每元素=一个低覆盖文件的自包含审计批（文件路径 + 覆盖率 + 该文件未覆盖行/分支 + 源码上下文）
  > body 引擎直执（零 LLM 零转写）：经白名单 uv 通道跑 collect_coverage.py --gaps（阈值参数化：
  > 行覆盖率 <80% 或分支覆盖率 <70%）——筛选与自包含元素组装全在脚本侧完成，脚本把文本批列表
  > 以 JSON 数组打到 stdout，parse_json 直接赋 gap_files。每个元素含：文件路径 + 行/分支覆盖率 +
  > 未覆盖行区段 + 源码上下文——单个 worker 仅凭该元素 + 读对应源/测试文件即可分析，不依赖其它文件。
  > ```hop_python
  > r = subprocess.run(["uv", "run", "--with", "pyyaml", "python3", scripts_dir + "/collect_coverage.py", ".", "--gaps", "--line-threshold", "80", "--branch-threshold", "70"], cwd: project_root, timeout: 120)
  > if r.returncode != 0:
  >     gaps_error = int("低覆盖筛选脚本失败，首行: " + split(strip(r.stderr), "\n")[0])
  > gap_files = parse_json(strip(r.stdout))
  > ```

5. [loop for-each gap in gap_files, collect gap_analyse into gap_analyses] 逐个低覆盖文件并行分析覆盖缺口
  + → gap_analyses: [yaml]  # 各文件分析结果（for-each 同名收集为列表）

  5.1. [subtask retry=2 parallel] 分析单个低覆盖文件
    - ← gap
    + → gap_analyse: yaml  # 本文件的缺口分析（子任务聚合输出）

    5.1.1. [reason] 分类该文件的未覆盖区域
      - ← gap
      - 工具: read  # 读源码与对应测试文件（gap 只含路径与覆盖率,内容须自读）
      + → gap_analyse: yaml  # {file, line_pct, branch_pct, uncovered:[{lines, description, severity}]}
      > gap 是一个低覆盖文件（含路径/覆盖率/未覆盖区段）。读该文件源码与对应测试文件，
      > 对每个未覆盖区域按注入的判据定级并排序，产出本文件的缺口分析 yaml。引擎已自动注入（doc-ref）：
      > [[test-coverage-audit-knowledge#覆盖缺口严重度分类]]

6. [reason] 审计 mock 质量
  - ← project_root
  - 工具: read  # 读 .coverage-audit/mock_patterns.yaml（输入只有路径,文件内容须自读）
  + → mock_audit: yaml  # {total, flagged:[{file,line,target,issue,explanation,recommendation}], acceptable_count, acceptable_groups:[{kind,target,count}]}
  > 读 `{project_root}/.coverage-audit/mock_patterns.yaml`（脚本已按 (种类,目标) 分组统计并机械预筛：
  > candidates=内部模块目标或模块级 mock 的候选组，acceptable_groups=其余组的分组计数）。
  > **只对 candidates 里的候选逐条按注入的判据判定应否 FLAG**，对每个 flagged mock 给出解释与建议；
  > acceptable 侧照抄脚本的分组计数（acceptable_count/acceptable_groups），不逐条复述——
  > mock 量大时逐条复述会撞输出上限，预筛+计数的形态没有这个封顶。引擎已自动注入（doc-ref）：
  > [[test-coverage-audit-knowledge#mock FLAG 判据]]

7. [reason] 汇总生成审计报告
  - ← gap_analyses, mock_audit, project_type
  + → report_yaml: yaml  # 结构化报告（coverage_summary + critical_gaps + mock_audit + test_architecture + overall_verdict + priority_actions）
  + → audit_summary: text  # 自然语言摘要（总体评级 + 关键发现 + 优先行动）
  > 综合逐文件缺口分析 gap_analyses（列表）与 mock 审计 mock_audit，按注入的架构评估维度评估整体测试质量，
  > 给出总体评级（GOOD/ADEQUATE/NEEDS_IMPROVEMENT/POOR）与优先行动（P0/P1），
  > 按注入的报告格式模板产出结构化 report_yaml 与自然语言 audit_summary 两份。引擎已自动注入（doc-ref）：
  > [[test-coverage-audit-knowledge#测试架构评估维度]]
  > [[test-coverage-audit-knowledge#审计报告格式模板]]

8. [commit] 写盘审计报告（交付写盘）
  - ← report_yaml, audit_summary, project_root
  + → report_path: line  # audit_report.yaml 写盘路径
  > 交付写盘归 commit（写域=workspace；project_root 须为 workspace 内相对路径，见 Inputs 注释）：
  > body 把 report_yaml 序列化写入 `{project_root}/.coverage-audit/audit_report.yaml`、
  > 把 audit_summary 写入 `{project_root}/.coverage-audit/audit_summary.md`。
  > 幂等：重放时同内容覆写同路径，结果一致。
  > ```hop_python
  > report_path = project_root + "/.coverage-audit/audit_report.yaml"
  > w1 = write(path: report_path, content: str(report_yaml))
  > w2 = write(path: project_root + "/.coverage-audit/audit_summary.md", content: audit_summary)
  > ```

9. [ask present_inputs=audit_summary] 展示审计摘要
  - ← audit_summary, report_path
  + → next_action: line  # view_report（查看完整报告）/ exit（结束）
  > 展示 audit_summary 完整内容（driver 据 present_inputs 硬约束必须完整 dump 给用户）：
  > 总体评级 + 覆盖缺口 + mock 质量 + 测试架构评估 + 优先行动。
  > 询问用户下一步：查看完整报告（report_path 指向的 audit_report.yaml）还是结束。

10. [exit] 交付审计结果
  > 返回结构化报告路径 report_path 与自然语言审计摘要 audit_summary。
