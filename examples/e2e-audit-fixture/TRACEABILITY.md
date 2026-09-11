# 追溯表（fixture）

### anc-rule-c2f-convert ✅
- design/alpha.md 换算规则
  - src/alpha.ts c2f — @a: anc-rule-c2f-convert
    - tests/alpha.test.ts "c2f" — @v: anc-rule-c2f-convert

### anc-error-abs-zero-reject ✅
- design/alpha.md 边界拒绝
  - src/alpha.ts c2f RangeError — @a: anc-error-abs-zero-reject
    - tests/alpha.test.ts "c2f boundary" — @v: anc-error-abs-zero-reject

### anc-obs-temp-report ✅
- design/beta.md 报告格式
  - src/beta.ts report — @a: anc-obs-temp-report
    - tests/beta.test.ts "report" — @v: anc-obs-temp-report
