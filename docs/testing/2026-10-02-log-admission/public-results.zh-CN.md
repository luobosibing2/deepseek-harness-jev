## 直接答案

在六种固定人工日志、每例 baseline 与开启组各一次的 **12 次真实 DeepSeek Agent trial**中，现有日志功能出现两次可恢复的实际省略、两次判断成功但因省略概率未达默认 `0.8` 而保留，以及短日志和明确完整证据请求两次旁路。12/12 槽均正常结束，结构性证据和用量完整；最后的主模型答案逐条人工对照合成真值，均正确。四次真实 Jev 调用判断 **33 个候选**，其中 **15 个**达到门槛并被语义省略；另有 **4 条**逐字重复失败详情由确定性规则替换，不能算作 Jev 判断。实验表明这些固定输入上的触发、保护和读回链条可运行，**不证明真实软件任务收益、普遍准确率或净费用节省**。

本目录是 **2026-10-02 整理的公开记录**。从 Pier trial 的 `started_at` 与 `finished_at` 取到的实际运行窗口是 **2026-10-01 08:21:44.909968–08:34:56.538391 UTC**，即上海时间 **2026-10-01 16:21:44.909968–16:34:56.538391**。单价来源在 2026-10-01 核验；整理日期、试次时间和计价快照各有自己的含义。

## 固定条件与案例

每例先 baseline、后 log_admission，分别在新的默认非特权 Docker 容器中运行一次；Agent 时限 120 秒、并发 1、零自动重试、verifier 关闭。容器内显式使用 DSH `danger-full-access`，未增加 Docker capability、privileged、seccomp 例外或宿主挂载。两组关闭 Agent 网页工具，模型可见工具 schema 相同；12 项 Jev 功能中 baseline 全关，开启组只打开 `output-admission` 和 `test-log-admission`，selection、stage-navigation 均关闭。主模型为 DeepSeek `deepseek-flash` / `high`，Jev 请求和实际响应模型均为 `jev-1.13.0`。通用日志 6000 字符、可识别测试日志 4000 字符、省略概率 `0.8`、等待 4 秒、净省 300 字符且 10% 等默认参数未改变。

| 人工案例 | 原生 bash 退出 / `isError` | baseline → 开启组的 hook 原文与提案/最终字符数 | 开启组真实判断、实际采用 | 最终答案核对 |
| --- | --- | --- | --- | --- |
| `short-general`：短构建进度 | `0` / `false` | 498 → 498 | 未到 6000 门槛；Jev 0 | 两组均答 `SHORT-7`、`ready`。 |
| `long-general`：长进度与重复 warning | `0` / `false` | 11229 → 11229 | Jev 判断 10 候选，均选 omit，但概率 `.73–.77` 小于 .8，实际省略 0 | 两组均答 `GEN-42`、`ready`。 |
| `ordinary-pass`：被识别的普通 PASS | `0` / `false` | 8951 → 8951 | Jev 判断 8 候选，概率 `.65–.71`，实际省略 0 | 两组均答 100 项通过、耗时 1.9s。 |
| `failed-slow-named`：失败、慢项与具名快项 | `1` / `false` | 9206 → **1567** | Jev 判断并省略 8 候选，概率 `.83–.85`；规则 0 | 两组均答 AssertionError、97 通过/1 失败，具名 timing 420ms、policy 20ms。 |
| `duplicate-failure`：逐字重复失败详情 | `0` / `false` | 10680 → **1906** | Jev 判断并省略 7 候选，概率 `.86–.90`；另有 **4 条实际规则引用** | 两组均区分总体 5 失败/89 通过与具名项通过且耗时 420ms。 |
| `full-intent`：明确要求完整工具证据 | `0` / `false` | 11229 → 11229 | 用户有效全文意图触发旁路；Jev 0 | 两组均答 `GEN-42`、`ready`，工具证据保留完整原文。 |

表中的字符数为 hook 格式化文本的 **Unicode code points**，不是 UTF-8 bytes 或 token。两次实际省略分别减少 **7639/9206（82.98%）**与 **8774/10680（82.15%）** 个模型可见字符。四次未省略包含两次明确旁路和两次真实判断后的低概率保留；不能把它们统称为“Jev 未参与”。四个 Jev operation/attempt 均成功，响应模型 ID 符合请求；四次请求各有 10、8、8、7 个候选，响应耗时分别为 **659、609、867、690 ms**。33 个候选中另外 **18 个**虽选 omit，概率低于 .8，因此被保留。

`failed-slow-named` 的 emitter 真实退出码为 **1**，发布版 DSH 的原生 bash `isError` 仍为 `false`，模型文本带 `[exit code: 1]`；它按已识别测试日志走 `test-log-admission`，不是基础设施失败。开启组的提案及最终文本逐字保留首份 `FAIL auth.test.ts` 的完整 AssertionError 与 8 行详情、`Tests 1 failed | 97 passed`、420ms 慢项、任务点名的 20ms 快项和退出标记。实际 receipt 为 `rules=0, jev=8, inputChars=9206, proposedChars=finalChars=1567, finalIsError=false`。原文是 **9400 UTF-8 bytes**，保存文件与 pre-hook 文本逐字、哈希一致；主模型实际原生 `read` 一页，读取元数据覆盖 **111/111 行**，并在最后答案正确使用了失败详情和两项时长。

`duplicate-failure` 的 emitter 是成功打印人工归档日志的程序，**真实退出码为 0**；日志里“五个失败”不是五次实际软件测试失败。首份失败详情完整保留，后四份 byte-identical 详情分别以指向首份原始行的引用替换；ledger 的四条 `exactDuplicateReferences` 均记录逐字相等。Jev 另外省略 7 个普通 PASS 候选。receipt 单列 `rules=4, jev=7, inputChars=10680, proposedChars=finalChars=1906`。原文是 **10858 UTF-8 bytes**，保存文件逐字/哈希一致；主模型实际原生 `read` 一页，覆盖 **137/137 行**，最终正确区分五个失败文件与具名通过项。两份读回都产生额外主模型调用及用量，已计入下表，不能以减少字符直接宣称减少 token 或美元。

两次省略后的 Host 最终模型可见文本与 Jev 提案逐字相同，结构化退出值和 `isError` 未变。其他四例的原文、提案及最终文本也逐字相同；没有 Agent 网页搜索、需人工回答、fixture 文件变化或用量缺失。公开[结构化结果](./results.json)逐例保存原文、提案、最终文本的字符数、UTF-8 字节数与 SHA-256，以及全部保护原始块的哈希/逐字保留标记；[公开回执](./receipts.json)单列实际 operation、attempt、choice 概率、真实 receipt、原生状态、完整读取元数据、usage 与耗时。两份 JSON 都不包含原始日志、prompt、Session/call ID、宿主绝对路径或恢复 locator。

## 用量、版本与复核

用量按 2026-10-01 核验的 [DeepSeek 官方峰时价格](https://api-docs.deepseek.com/quick_start/pricing/)和 [TypeSafe Jev 1.13.0 价格](https://docs.typesafe.ai/models)估算，**不是服务商账单或硬支出上限**。主模型每百万 tokens 的输入/cache read/cache write/输出单价为 USD `0.30/0.006/0.30/1.20`；Jev 输入 USD `0.042`，输出 USD `0`，本客户端没有单独 Jev 缓存 usage 字段，不能推断后端缓存状态。

| 条件 | 主模型调用 | 主模型输入 / 缓存读 / 缓存写 / 输出 tokens | 主模型估算 USD | Jev 调用；输入 / 输出 tokens | Jev 估算 USD | Agent 执行时间合计 |
| --- | ---: | --- | ---: | --- | ---: | ---: |
| baseline | 16 | 26544 / 111616 / 0 / 6718 | 0.016694496 | 0；0 / 0 | 0 | 53.680439 秒 |
| log_admission | 18 | 17424 / 141568 / 0 / 6126 | 0.013427808 | 4；21707 / 1233 | 0.000911694 | 55.525914 秒 |
| 合计 | **34** | **43968 / 253184 / 0 / 12844** | **0.030122304** | **4；21707 / 1233** | **0.000911694** | **109.206353 秒** |

全批已知峰价估算合计 **USD 0.031033998**，12/12 槽费用字段完整，低于内部 USD 1 提示阈值。执行时间取 Pier 的 `agent_execution.started_at/finished_at`，不含准备、镜像和 npm 时间；没有将时间或美元差值算作插件因果收益。两组主模型自行选择的额外 `ls`、`glob`、读取 emitter 源码路径不同，两次原文恢复也增加了 `read` 和后续主模型请求。缓存命中和顺序效应均可影响用量。

冻结 suite lock SHA-256 为 `762b7e2dee013886820cacf417f65ffee3522ce92d9c7d4ae7447d062c16a764`；插件源码基线 `7e208e040d7f4dae7dcdf292e53a4a1b73c0303f`、插件 tar SHA-256 `e9927b097baff28b05ecd0028b9f0c1d16bf9177aa70fa05b873e76d5403bf70`。DSH `0.1.7-rc.2`、Pier `4d3c14041d16443f3f9f460dcdf23629994a304e`、Node `24.14.1`、pnpm `11.7.0`；Docker 固定 `linux/amd64` 镜像 digest `sha256:11087ec4eb0320e80546ad5eda89c67938e72be69cbb7c6730cf9baf88dc7556`。其余 manifest、Node tar、npm 锁和 seed 任务目录哈希见[结构化结果](./results.json)。主模型 `deepseek-flash` 是浮动后端别名，冻结本地输入不保证远端实现不变。

首次收费前，源规则和发布版 DSH 的**本地 mock 服务**在六例均经原生 bash 验证，外部 provider 调用为 0；12 个 Pier Job/Trial 入口还做了无容器、无模型构造检查。随后实际运行按固定次序单槽执行，无自动收费重试。人工逐条阅读 12 条最后的主模型答案后，六例两组的事实回答均与合成真值一致；`ordinary-pass/baseline` 的机械字面提示未命中 `100 passed`，因为答案写成“100 tests passed”，这不是事实错误。完整原始 Session、Jev ledger 与恢复文件继续留在本地忽略目录；本公开版本仅是白名单摘要。

## 边界与验证

这六种日志均由固定脚本人工构造，并非真实项目的 build/test 判分，也没有独立 DeepSWE verifier；DeepSWE Vitest 任务只供镜像与启动标识。每个案例只有一次 baseline 在前、一次开启组在后，不能从模型回复、费用或耗时差异推出通用的语义准确率、修题成功率或 ROI。长 general（`output-admission`）与普通 PASS（`test-log-admission`）证明 Jev 在这两个输入上确实判断、却按默认概率门槛保留；另两个案例证明特定保护信息与实际原文恢复可和省略共存。Session 未记录 compaction/spill/pruner 类型事件、Host 在这十二槽未再改写提案，只是本轮可观察证据，不等于覆盖全部内部机制或未来运行。此次辅助 driver 没有作为公开维护管线入库，[DeepSWE 适配器](../../../bench/deepswe/README.zh-CN.md)也不能直接重跑这些案例；本报告和 JSON 只记录已完成的历史运行。
