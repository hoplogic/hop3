# Spec: 网页内容提取
Id: webpage-extract
Goal: 打开给定 URL（含动态渲染页），等渲染稳定后提取页面内容成结构化摘要——playwright 工具端到端最小样例
> 运行前提：须以 examples/hoptools-playwright.yaml 注册 browser_navigate/browser_snapshot 两工具后运行（浏览器工具属 special 工具面，由 act free 步骤经授权行调用，不走 hop_python body）。
Inputs:
- url: line  # 目标网页 URL（含协议）
- focus: text  # 关注点（要从页面提取什么——如"产品价格与规格"/"文章正文要点"）
Outputs:
- extraction: markdown  # 提取结果（按 focus 组织,注明页面标题与 URL）

## Tools
- browser_navigate(url) -> result: text  # 导航到 URL（注册见 examples/hoptools-playwright.yaml;返回=操作回执散文）
  - url: line  # 目标 URL
- browser_snapshot() -> result: text  # 当前页可访问性快照（渲染后内容的结构化文本——文本形态,非 JSON 对象）

## Steps

1. [act free] 打开页面
  - ← url
  - 工具: browser_navigate  # 打开目标页
  + → nav_result: text  # 导航回执（server 返回散文——声明如实,yaml 会 SCHEMA_MISMATCH）
  > 用 browser_navigate 打开 url，回执记入 nav_result。

2. [act free] 取渲染后快照
  - 工具: browser_snapshot  # 取渲染后快照
  + → page_snapshot: text  # 页面快照文本（可访问性树的 yaml 风格文本——整体是文本值非结构）
  > 用 browser_snapshot 取当前页渲染后的可访问性快照，全文记入 page_snapshot。

3. [reason] 按关注点提取
  - ← focus, page_snapshot, url
  + → extraction: markdown  # 提取结果
  > 从 page_snapshot 里按 focus 提取相关内容，组织成 markdown：
  > 开头注明页面标题与 URL；只提取快照里真实存在的内容，不补写不臆测；
  > 页面与 focus 无关时如实说明页面实际是什么。

4. [exit] 交付
  + → extraction
