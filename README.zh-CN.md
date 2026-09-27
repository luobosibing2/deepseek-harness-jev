# DeepSeek Jev

[English](README.md) | 简体中文

**为 DeepSeek Harness 提供可独立启用的 Jev 判断能力。**

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 Jev 连接起来，用于技能与文件选择、任务监督、共享发现纠正和单次操作审批。主 Agent 和原生工具继续工作，你可以在同一个设置页按需开启功能。

这是独立社区项目，并非 DeepSeek 或 Jev 官方发布。当前属于早期插件，已针对 **DSH 0.1.7-rc.2** 验证；接口和模型判断都不构成正确性保证。

## 包含哪些功能？

下表描述 `main` 分支。**每项功能都有独立开关，默认全部关闭**，安装插件不会自动开启。

| 功能 | 作用 |
| --- | --- |
| 技能选择 | 在技能目录发布前，对名称和摘要排序；主 Agent 仍通过原生 skill 加载正文。 |
| 文件排序 | 对原生 glob 返回的路径排序，不追加文件扫描或正文读取。 |
| 跑偏提醒 | 在模型步骤之间检查进展，必要时提供一次非阻塞提醒。 |
| 完成核查 | 对照已有证据检查已展示的最终回答，最多追加一次补充处理。 |
| 持续目标监督 | 检查原生目标完成申请，连续多轮没有进展时暂停。 |
| 用户约束提醒 | 读取当前用户要求及适用的 Agent 规则，必要时发送非阻塞提醒。 |
| 中途插话分流 | 把运行中的纠正消息送到下一步骤，其他消息留待后续轮次。 |
| 共享发现纠正 | 比较已经共享的报告和消息，向受影响的接收者发送纠正。 |
| 工作区提权代审批 | 仅在 workspace-write 下参与适用的原生单次提权；非肯定判断回到原人工审批。 |

所有功能共用连接、按 profile 保存的设置、判断记录与操作回执。多数 Agent 功能面向存活的 Web 主会话；向子 Agent 发送纠正，不等于子 Agent 自动拥有其他 Jev 增强。

**功能分支不等于已合入 main。** 工具输出筛选在 `codex/jev-tool-output-admission`；原生网页执行在 `codex/jev-native-web-execution`，该方向目前**暂停，普通网站效果未通过验收**。其他历史分支保留早期实现。切换前请看[分支状态](docs/branches.md)，本表始终以 `main` 为准。

## 环境要求

- 推荐 Node.js **24.11 或更高版本**；发布构建使用 Node 24.14.1 检查。
- `PATH` 中可用的 pnpm **11.7.0**。
- DeepSeek Harness CLI **0.1.7-rc.2**。插件固定使用对应 DSH peer 包和 Cordis **4.0.4**，不自动承诺兼容更新版本。
- 在 DSH 中配置好主模型，以及你自己的 Jev 兼容 System One 服务和凭据。

如尚未安装工具：

```sh
npm install --global pnpm@11.7.0 @deepseek-ai/dsh@0.1.7-rc.2
```

## 从源码安装

源码公开，**本次发布不包含把 @dsh-jev/plugin 发布到 npm**。请先从本仓库构建安装包，再通过 DSH 官方插件管理命令安装。

```sh
git clone https://github.com/luobosibing2/deepseek-jev.git
cd deepseek-jev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
mkdir -p dist
pnpm --filter @dsh-jev/plugin pack --pack-destination "$PWD/dist"
```

初次试用请使用**尚未存在的新 profile 名**；示例使用 `jev`。先从 Web 模板初始化，再添加插件：

```sh
dsh --profile jev --from-default-profile web --dump-default-config > /dev/null
dsh plugin --profile jev add ./dist/dsh-jev-plugin-0.1.0.tgz
dsh --profile jev
```

第一条命令创建 Web profile 后退出，不启动应用。如果直接给新 profile 添加插件，DSH 默认只初始化基础配置，不会自动成为 Web 应用。官方安装器会加载插件的 bundle patch，无需手改宿主源码。

打开 DSH 输出的认证访问地址。在 DSH 中配置主模型，然后进入插件的 **Jev** 页面。

## 配置 Jev

1. 填写完整 System One 地址，例如 `https://api.typesafe.ai/v1/systemone`。
2. 填写模型，例如 `jev-latest`。
3. 指定 DSH 凭据引用，保存连接，再通过页面的凭据控件保存 API Key。不要把密钥写入源码或仓库 URL。
4. 检查超时时间，只开启需要的功能。
5. 在“判断记录”中查看输入、答案、尝试次数，以及实际采纳或执行回执。

主 Agent 的模型连接与 Jev 判断连接分别配置。凭据显示“已配置”不等于连接测试成功；连接测试和已启用的判断会向服务方发送请求。

选择功能默认取 5 个技能摘要，最多对 40 个 glob 命中排序，展示 12 条路径。超过上限时直接跳过 Jev，不会悄悄只判断前 40 个。监督功能默认每 6 个完成的模型步骤检查一次跑偏，连续 3 个原生目标轮次无进展则暂停。这些参数可调整，保存参数不会自动开启功能。

## 行为与限制

- **提醒是建议。** 跑偏和约束提醒不会阻塞、取消工具，也不会强制主模型遵守。
- **完成核查只审查证据。** 它不会独立运行测试；真实样例曾放行缺乏依据的“没有新增文件”声明，不能视为完成保证。
- **审批只针对一次操作。** 不改变会话沙箱模式，不覆盖宿主固定检查。有效 approve 可返回 allowed-once，unauthorized 或 unknown 回原人工审批；技术故障保留人工 Retry/Cancel。
- **共享纠正有明确范围。** 它只处理已经共享的报告和消息，不读取所有 Agent 的内部探索；自动投递限当前存活的主 Agent 及其活跃、可继续的直接子 Agent。同一发现以不同形式上报时，仍可能产生重复纠正。
- **判断成功不等于执行成功。** 日志分别记录判断、采纳、许可发放和实际操作结果。
- **验证有范围。** 确定性测试证明集成流程，有限真实样例不能证明普遍语义准确率。详见[验证说明](docs/validation.md)。

开启的功能会将相关任务上下文或操作内容发送到配置的判断服务。精确判断输入和回答保存在 profile 的本地插件记录中，主模型可见影响使用正常 DSH Session 记录。运行资料和凭据应保留为私有数据；公开源码历史不包含个人 QA 截图和原始会话抓取。

## 更新与移除

已有 profile 更新时，重新构建、打包，运行 `dsh plugin --profile jev add <新安装包路径>`，再重启该 profile。不要对已有 profile 重新执行 `--from-default-profile`。相同版本号的不同构建使用新的安装包文件名，验收更新时核对实际安装内容。

单项功能可在 Jev 页面关闭。移除整个包时，以当前 CLI 的 `dsh plugin --help` 为准。替换实验分支安装包可能移除该分支特有功能，替换前保留 profile 备份。

## 开发

```sh
pnpm run typecheck
pnpm run build
pnpm exec vitest run packages/jev/tests/host.test.ts packages/jev/tests/wire.test.ts
```

按改动运行相关测试。没有明确授权时，不开启真实服务实验或使用他人的凭据。开发夹具和测试不会进入可安装 tarball。

- [包参考与消费者 API](packages/jev/README.md)
- [工作区审批集成测试](packages/jev/tests/workspace-approval.test.ts)
- [工作区审批 QA 用例](packages/jev/tests/workspace-approval-qa.md)
- [分支状态](docs/branches.md)
- [验证说明](docs/validation.md)

## 许可证与致谢

MIT，见 [LICENSE](LICENSE)。安装包携带的第三方许可见 [THIRD_PARTY_NOTICES.md](packages/jev/THIRD_PARTY_NOTICES.md)。

功能研究受到 [Mu](https://github.com/qybaihe/mu) 启发。本项目通过公开扩展点实现 DSH 插件，不分发修改版 DeepSeek Harness、Mu 或 Cua runtime。DeepSeek Harness、Typert 工具和 Zod 保留各自声明。
