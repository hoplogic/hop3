# beta 模块设计

温度报告格式化模块。

## 模块定位【契约】 ^anc-struct-beta

beta 把换算结果格式化为人读字符串，依赖 alpha。

## 报告格式【契约】 ^anc-obs-temp-report

格式：`{c}°C = {f}°F`，保留一位小数。

## 输出转义【契约】 ^anc-string-escape-control

字符串输出必须转义控制字符（\n/\t），防日志注入。
