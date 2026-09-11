# alpha 模块设计

温度换算工具模块。

## 模块定位【契约】 ^anc-struct-alpha

alpha 提供摄氏/华氏温度换算纯函数，无 IO。

## 换算规则【契约】 ^anc-rule-c2f-convert

摄氏转华氏：F = C × 9/5 + 32。输入输出均为数字，非数字输入抛错。

## 边界拒绝【契约】 ^anc-error-abs-zero-reject

低于绝对零度（-273.15°C）的输入必须拒绝（抛 RangeError），不得静默返回。
