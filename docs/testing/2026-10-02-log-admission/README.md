# Log Admission Frozen-Run Evidence / 日志省略冻结运行证据

本目录记录一次已完成的原生 bash 日志省略实验：六个人工固定日志案例，各运行 baseline 与仅开启两项日志功能的条件一次，共 12 次真实 DeepSeek Agent trial。目录日期 **2026-10-02 是整理日期**；实际 trial 发生在 2026-10-01 08:21:44–08:34:56 UTC（上海时间 16:21:44–16:34:56），准确微秒时间见[结构化结果](./results.json)。

This folder records one completed native-bash log-admission experiment: six fixed synthetic logs, each run once with baseline and once with only the two log features enabled. **2026-10-02 is the documentation date**; the trials ran on 2026-10-01, with exact UTC and Asia/Shanghai timestamps in the structured results.

## 文件 / Files

- [中文结果说明](./public-results.zh-CN.md)：配对观测、原文保护与读回、用量和外推限制。
- [结构化结果](./results.json)：固定条件、版本与哈希、每例原文/提案/最终字符数、UTF-8 字节数及哈希、汇总用量。
- [公开回执](./receipts.json)：12 槽的真实状态、Jev operation/attempt/choice 概率、**实际**规则与 Jev 替换 receipt、原生读取完整性及用量；不把源规则预期当作已执行规则。

## 管线身份 / Pipeline identity

本次使用本地忽略目录中的**一次性实验辅助包**，复用公开的 [DeepSWE 适配器](../../../bench/deepswe/README.zh-CN.md)来启动发布版 DSH、Pier 和独立容器，但六份日志及其分析器不是该适配器的公开可维护入口。`vitest-duration-sharding` 仅提供固定镜像和启动标识，本次没有运行 DeepSWE verifier 或评估修题成功率。原始 Session、完整日志、Jev ledger、宿主路径、临时恢复定位器及凭据不在公开文件中；结构化文件是字段白名单摘要。

This was a **one-off local helper**, not a newly published maintained runner. It reused the public [DeepSWE adapter](../../../bench/deepswe/README.md) for published DSH, Pier, and isolated containers; it did not run the DeepSWE verifier. The raw Sessions, logs, ledger, machine paths, temporary recovery locators, and credentials remain local. The JSON files are allowlisted summaries of the historical run, not material from which a new checkout can rerun it directly.
