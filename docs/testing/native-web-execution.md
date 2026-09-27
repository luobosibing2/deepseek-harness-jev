# Native web execution: paused experiment / 原生网页执行：暂停实验

This branch preserves an independent Jev plugin that reuses DSH Native Cua tools. It is not included in main and is not an accepted general website automation release.

本分支保留复用 DSH Native Cua 的独立 Jev 插件实验，未合入 main，不能视为已验收的通用网页自动化版本。

## Implemented / 已实现

- Page binding and model-visible identifiers; read-only observation; bounded click/type/scroll selection; persistent history.
- Main-agent-supplied text, candidate filtering, scroll and observation limits, and returning valid unknown results to the main agent.
- 页面交接、模型可读标识、只读观察、有界点击/输入/滚动选择和持久轨迹。
- 主 Agent 提供填写内容，候选筛选、滚动与观察额度，合法 unknown 交回主 Agent。

## Observed limits / 已观察限制

Local deterministic regressions and limited real Native form/navigation checks succeeded. Ordinary-site use exposed candidate coverage, repeated observation, and handoff problems. A later real browser search encountered the site's security-verification page; no verification challenge was solved. Named-profile state retention did not make ordinary-site tasks reliably successful.

本地确定性回归及限定的 Native 表单/导航流程通过。普通网站使用暴露候选覆盖、重复观察与交接问题，后续真实搜索出现站点安全验证，没有处理验证挑战。命名 profile 状态保留不代表普通网站任务可靠成功。

The user paused this direction. Preserve the source for study; do not interpret this branch as permission to resume implementation, tests, desktop migration, or model calls. Private raw sessions and screenshots are retained outside the public repository.

用户已暂停此方向。代码用于保留和研究，不能把本分支视为继续实施、测试、桌面迁移或调用模型的授权。私人会话与截图未进入公开仓库。
