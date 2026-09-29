# Branches / 分支

[English](../README.md) · [简体中文](../README.zh-CN.md)

`main` contains the accepted integration baseline. Feature branches preserve worktree source snapshots; they are not promises of production readiness. The public export excludes private runtime evidence while the original local engineering history is retained privately. Public commit IDs therefore differ from the original local commits.

`main`为已接受的集成基线。功能分支保存工作区源码快照，不代表生产可用。公开导出排除私人运行证据，本地工程原始历史另行保留，因此公开提交SHA与原本地SHA不同。

| Branch | Status / 状态 |
| --- | --- |
| `main` | Shared service, skill/glob, six supervision/correction features, workspace approval, tool-output admission / 公共能力、技能与glob、六项监督纠正、工作区审批、工具输出准入 |
| `codex/jev-common-foundation` | Historical foundation snapshot, integrated in main / 已集成的公共能力历史快照 |
| `codex/jev-skill-file-selection` | Historical selection snapshot, integrated in main / 已集成的选择模块历史快照 |
| `codex/jev-execution-supervision` | Historical split implementation; superseded by main integration / 历史拆分实现，以main整合版为准 |
| `codex/jev-instruction-enforcement` | Historical split implementation; superseded by main integration / 历史拆分实现，以main整合版为准 |
| `codex/jev-interjection-routing` | Historical split implementation; superseded by main integration / 历史拆分实现，以main整合版为准 |
| `codex/jev-shared-findings` | Historical split implementation; superseded by main integration / 历史拆分实现，以main整合版为准 |
| `codex/jev-task-execution-checks` | Historical integrated hook snapshot / 监督纠正历史整合快照 |
| `codex/jev-workspace-approval` | Accepted approval implementation, integrated in main / 已验收并合入的审批实现 |
| `codex/jev-tool-output-admission` | Historical output/test-log filtering snapshot, integrated in main; includes an approval integration snapshot / 输出与测试日志筛选历史快照，已集成到main，含审批集成快照 |
| `codex/jev-native-web-execution` | Paused experiment; ordinary-site effectiveness not accepted; [proposal](proposals/2026-09-27-jev-native-web-execution.md) / 已暂停实验，正常网站效果未验收；[提案](proposals/2026-09-27-jev-native-web-execution.zh-CN.md) |
| `codex/jev-desktop-install-validation` | Historical validation baseline; no additional product implementation / 历史验证基线，无新增产品实现 |
| `codex/jev-open-source-release` | Publication documentation and packaging metadata / 公开发布文档与打包元数据 |

Do not merge an old split branch over `main` just because its checkout still exists. Installing a feature-branch tarball replaces the same package name and can remove other branch-only features. Use a separate DSH profile for experiments.

不要因旧工作区仍存在就把拆分实现覆盖到main。同名插件包的分支安装会替换整个包，可能移除其他分支独有功能，实验请使用独立DSH profile。
