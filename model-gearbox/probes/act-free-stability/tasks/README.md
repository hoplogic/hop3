# 格点任务素材(run-act-free-stability.mjs 消费)

- log-{short,mid,long}.txt:合成运维日志(1K/4K/9K 字符,行结构固定 `日期 时间 [级别] 服务 latency=Nms code=N`)——机械可判素材,ERROR 行数/延迟数值可精确验算;
- 两类任务由跑批脚本按格点现场组装成最小 spec:
  - noise_only:日志全文内联进步骤说明,问 ERROR 行数——**不需要任何工具**(答案就在眼前),测"工具在场会不会乱摸"(P2 抗噪半边);
  - tool_required:日志落盘为 work_zone 外的 workspace 文件,步骤说明只给文件名,必须 read 才答得出——测"该用时用不用得好"(正用半边);
- 判分机械:产出的数字与答案键精确比对,零判官(grid.yaml verdict_check: mechanical)。
