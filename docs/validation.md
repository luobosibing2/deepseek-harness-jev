# Validation / 验证说明

[English](../README.md) · [简体中文](../README.zh-CN.md)

The checked-in source and tests are public. Raw live-session captures, personal screenshots, credentials, runtime installations, and machine-specific experiments are not part of the public source history.

公开源码包含实现和可复测测试；真实会话原始抓取、个人截图、凭据、运行环境和绑定本机的实验资料不随源码公开。

| Area / 范围 | Evidence / 证据 | Limit / 边界 |
| --- | --- | --- |
| Shared service; skill/glob selection / 公共服务与选择 | [Public selection results](testing/jev-selection/public-results.zh-CN.md): deterministic service tests and DSH Web installation checks / [公开选择结果](testing/jev-selection/public-results.zh-CN.md)：确定性测试与 Web 安装验证 | No broad task-success or performance claim / 不声明大规模任务效果 |
| Supervision and correction hooks / 监督与纠正 | [Public result summary](testing/2026-09-27-jev-hooks/public-results.zh-CN.md): 152-test integration run and limited real-model cases / [公开结果摘要](testing/2026-09-27-jev-hooks/public-results.zh-CN.md)：152项集成及有限真实样例 | Completion false negative; drift reminder delivery not observed in the live sample; cross-form shared duplicates remain / 保留完成漏检、跑偏未验到实际送达及共享重复 |
| Workspace approval / 工作区审批 | Native DSH integration, six deterministic Host/UI cases, three real DeepSeek tasks and four Jev judgments / 原生集成、6个Host/UI场景、3个真实主任务及4次Jev判断 | Two real approvals executed, one forbidden case returned to human rejection, one explicitly authorized case was misclassified / 两个批准执行、一个禁止负例转人工拒绝、一个明确授权样例误判 |
| Tool-output admission / 工具输出准入 | [Real-profile report](reports/2026-09-27-tool-output-admission.md) / [真实 profile 报告](reports/2026-09-27-tool-output-admission.zh-CN.md): deterministic integration plus one genuine build log reduced by 75.7%; native full-log spill was recovered / 确定性集成、真实构建日志缩短75.7%、原生完整日志spill回读 | One synthetic project; a neutral 180-test run was judged but fully retained below the 0.8 threshold, so test-log reduction was not shown; no same-result Jev-plus-native-spill case / 单个合成项目；中性180项测试触发判断但低于0.8而完整保留，未观察到测试日志净缩减；未验同一结果同时触发Jev与原生spill |
| Native web branch / 网页分支 | Local and limited Native integration checks / 本地及限定Native验证 | Paused after unsatisfactory ordinary-site use; do not treat as accepted / 普通网站效果不佳后暂停，未验收通过 |

Counts describe particular executed test sets, not a live badge, total unique-case count, or accuracy rate. Real-model replies vary. Tests and traces distinguish an approval from an executed effect; a model's final narrative is not execution evidence.

以上数量是特定已执行集合，不是持续集成徽章、全部去重用例数或准确率。真实模型答案可变化；批准与实际执行分别记录，模型最终自述不能替代操作证据。

Workspace approval has a checked-in [QA case guide](../packages/jev/tests/workspace-approval-qa.md). Run paid-provider examples only with explicit authorization and a bounded budget; use disposable workspaces and keep service credentials outside Git.

工作区审批的[QA用例](../packages/jev/tests/workspace-approval-qa.md)已入库。真实服务复测需明确授权和预算，使用可丢弃工作区，不将服务凭据纳入Git。
