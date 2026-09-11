%% @trace
	id: hopspec-codex-discovery
	source: [[codex-driver-carrier]]
	source_id: hopjit-codex-driver-carrier
	type: extract
	last_sync: 2026-08-14T22:40+0800
	note: Codex main orchestrator 的 spec 发现、recent-dirs 与 params 确认流程。
%%

# Codex Spec Discovery

> **定位纪律（焊死，禁猜）**：run 的 spec 定位只认两级确定性解析——①现成路径（绝对/相对 cwd）②相对 `<PKG>` 包根（npm 包 `examples/` 根含入门件，与仓库路径同形，一次命中）。两级不中→停下问用户（列 `<PKG>/examples/` 供选）。禁止 recent-dirs 猜测/glob 搜索/模糊匹配（recent-dirs 仅供 list 排序）。定位静默完成、一行结论后进参数确认。

## recent-dirs

项目根 `.hopspec/recent-dirs.json` 保存最多 10 个近期 spec 目录：

```json
{"dirs":["<最近目录>","<更早目录>"]}
```

成功定位 spec 后把其目录移到队首。`.hopspec/` 仅存发现缓存，`.hopstate/` 仅存 HopJIT 状态，`.hoplog/` 仅存日志；三者都应加入项目 `.gitignore`。任何 `run/resume/submit` 的 `--state-dir` 必须是项目根 `.hopstate/` 的绝对路径，禁止使用 `.hopspec/`。

## list

1. 用户给目录：直接调用 `<CLI> --json list "<dir>"`。
2. 未给目录且 recent-dirs 有值：依次调用各目录的 `list`，合并结果。
3. 首次无历史：直接询问用户指定目录或允许全项目扫描。
4. 展示 `file [id] - goal`，不自行分析 spec。

`list` 无状态，不带 `--state-dir`。

## run 前定位

1. 可读路径：直接使用。
2. 否则先按 recent-dirs 搜索文件名。
3. 仍未命中再做受限全项目搜索，跳过 `.git/node_modules/dist`。
4. 多个命中时列出候选并询问用户；零命中时报告已搜索范围。

定位成功后维护 recent-dirs。

## params

- 用户已提供完整 params：原样采用。
- 未提供或不完整：读取 spec `## Inputs`，从对话推断值，缺失项给合理示例。
- 把每个 Input 的名称、类型和拟用值完整展示给用户确认。
- 用户确认后才启动 `run`。
- 无 Inputs 时不传 `--params`。
