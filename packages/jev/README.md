# @dsh-jev/plugin

This package adds shared, typed Jev judgments to a DeepSeek Harness Web profile. It registers the Host service (`ctx.jev`), a plugin-owned Typert Remote namespace (`jev`), and one settings and records page. Optional Host entries cover skill and glob selection (`./selection`), execution supervision (`./supervision`), current instruction guidance (`./instructions`), running user-message routing (`./interjection`), and shared finding corrections (`./shared-findings`). Each feature is independently disabled by default; the three supervision features have separate switches.

## Install and configure

Build this workspace, then install the package into an isolated DSH Web profile with the official `dsh plugin --profile <name> add <package-path>` command. Its `cordis.patch.yml` inserts Host rows `jev`, `jev-selection`, `jev-supervision`, `jev-instructions`, `jev-interjection-routing`, and `jev-shared-findings`; the package's Web Client mounts the generated Remote contribution and page. The profile must supply the standard LLM, credentials, user questions, settings, and storage domain services. The selection row additionally uses the Host's tools, skills, and Agent registry services; glob searches still use the Host's original filesystem and subprocess services. This plugin requires DSH `0.1.7-rc.2` and Cordis `4.0.4`.

The Jev page edits the profile's `jev` configuration through DSH config forms. `baseUrl` is the complete HTTP(S) System One endpoint, `model` names the provider model, `credentialRef` names a DSH credential reference, `timeoutMs` is the per-attempt deadline, and `features` holds per-feature enablement. A new feature is disabled until explicitly enabled. The page saves or replaces a key through `ctx.credentials`; neither Remote status nor records return the key. An empty endpoint is allowed so the page can load before connection setup. Nonempty endpoints reject URL credentials, queries, and fragments at configuration validation.

## Skill and glob selection

The separate `jev-selection` row registers `skill-selection` and `file-ranking`, both disabled by default. It hooks the original skill catalog publication and `glob` result pipeline for live Web root Agents. Other caller scopes retain the Host flow. The main model keeps using `skill` to load instructions and `glob` to search paths; there are no separate `jev_find_skills` or `jev_locate_files` tools.

The Jev page edits three positive safe integers in the current profile: `skillLimit` defaults to 5 top-ranked skills per judgment, before removing summaries already in context, `fileCandidates` is the maximum glob match count eligible for Jev (40), and `fileLimit` defaults to 12 displayed ranked paths. A glob with more than 40 matches bypasses Jev completely at the default setting; it does not truncate to 40 before assessment. The original result ordering, display limits, and recovery mechanism apply to bypassed searches. Settings do not enable either feature and persist across profile restarts.

Skill selection happens before summaries reach the main model. It assesses only model-invocable names and descriptions from the current Agent's catalog; Jev never receives skill bodies. A provider may read metadata files while collecting those summaries. After choosing the top configured number, the hook adds only skill names absent from catalogs still visible in the current Session; it does not fill vacated slots from lower-ranked skills. Earlier summaries remain available, and a fully repeated selection adds no catalog message. The visible additions explain how to expand the complete current catalog without another Jev call. Omitted skills remain callable, and an explicit user skill invocation continues through the original loading path. Loading a chosen skill by name does not trigger another selection. A new direct user request or a changed directory starts a fresh catalog selection; ordinary tool steps do not repeat it. The catalog fingerprint and temporary checked-directory state track only when to publish, never reuse a Jev answer.

Every eligible glob search uses that call's complete path results, without another scan or content read. Search patterns, path scopes, hidden and ignored files, and search errors retain the original glob behavior. Results sort by relevance probability, with original candidate order breaking ties. Low probabilities remain eligible for display; independent confidence appears only when supplied by Jev. Each repeated eligible request makes a fresh judgment. There is no cross-request judgment cache, and unrelated tools such as `grep` do not trigger ranking.

Jev receives at most the latest two direct user messages and the latest preceding visible assistant text, with a combined 2,000-character budget; glob also supplies its original pattern/path. Pending direct user text is included before skill publication. Text is allocated newest-first, retaining the end of an oversized message, and presented in conversation order. Reasoning, tool output, attachments, and skill bodies are excluded. Empty candidates, unavailable task context, and disabled features use the original flow without a Jev request or fabricated scores.

Glob's structured return remains `{ root, paths }`, with the ranked paths in `paths`. Native calls receive probabilities in the model-visible tool text. PTC programs receive the original structured type; scores are delivered to the main model through call-associated additional context and recorded in the Session. Glob cards show the sorted paths and do not add a probability column. Capped ranked output reports candidate, assessed, displayed, and omitted counts and provides a readable complete ranked result with scores. If result storage is unavailable, all scored paths are shown inline with an explicit notice.

Jev failures use the shared manual Retry or Cancel flow. A retry reads current settings and context, and refreshes skill candidates. A glob retry retains the completed search paths; if a lowered candidate maximum now excludes them, it sends no further judgment and returns the original glob result. Disabling while waiting requires enabling again or cancelling. A failed judgment does not silently return unranked output. Host restart does not resume an old pending judgment. The Jev ledger records judgments separately, while model-visible summaries, results, and additional context use DSH's normal Session records. Selection does not load a skill, read a file, establish that a file contains the implementation, or predict task success.

## Current instruction guidance

The `jev-instructions` row registers `instruction-guidance`, shown as “用户约束检查 / User instruction guidance” on the existing Jev page and disabled by default. Its `tools/pre-execute` observer calls the original next listener immediately. A background `judgeOnce` request can supply one reminder to an already-entering subsequent model step; it cannot reject, rewrite, delay, or cancel the original tool. Native and PTC child tools use the same pipeline. PTC observations inherit the enclosing turn signal instead of the child runtime's completed-call signal.

Every observation reads the acting Agent's applicable `@deepseek-ai/dsh-agent-instructions` fiber configuration. The public `standingMountFor(agent.ctx)` lookup supplies that Agent's standing preset tree; direct profile Loader entries remain available for preset-free compositions. Candidate entries must belong to the same runtime root and be unscoped or within the Agent's scope ancestry. Other active presets and other roots do not contribute instructions. The checker reads the selected fiber's actual configuration and calls the published baseline loader through `ctx.fs` for the session and explicit target directories. The session baseline retains the loader's configured root discovery. Targets inside the session directory add every intervening scope from the session directory, matching the Host's touched-path discovery even without a Git root or across nested root markers. Targets outside that directory retain independent loader root discovery. All reads preserve custom candidate names, local overlays, home, and source/render limits. A provider observer distinguishes read failures from confirmed absence. Direct user messages and Host instruction-form messages supply additional original evidence; tool output and assistant text never become user authority. Original paragraphs carry content-derived ids, paths, line numbers, scopes, and authority labels. Typed Choice questions assess each original in the presence of all supplied originals, including amendments and exceptions; no free-text Jev explanation field is required.

Read-only filesystem facts include canonical explicit paths and bounded Git directory/common-directory metadata. They do not define a workspace policy. Explicit file/path arguments, patch headers, and absolute shell tokens identify candidate targets; arbitrary program effects and unresolved relative shell targets remain unverified and must be classified as undetermined. The plugin performs no business tests, source scans, worktree creation, or instruction-file writes. There is no built-in requirement for a directory name, branch prefix, or isolated workspace.

`maxEvidenceChars` (24,000), `maxSources` (64 original paragraphs/paths), and `maxOperationChars` (4,000) bound judgment evidence. Omitted/truncated instructions, unavailable configuration or reads, and unknown answers end that check as failed/undetermined without human questions or automatic retries. These are plain configuration fields on the `jev-instructions` row. The shared connection, credential, ledger, and profile feature switch remain on `jev`. Disabling prevents new judgments. An already-issued request may finish and supply its reminder while its instructions, direct user request, and active turn remain current.

The plugin re-reads current originals before adoption and before admission to a model step. Changed requirements, cancellation, and a closed turn discard stale reminders. It never calls `steer`, `followup`, or inbox insertion to wake a completed Agent. An original paragraph receives at most one reminder for the current direct user request. Each new direct user message establishes a new request scope, so a new task can receive guidance for the same unchanged original; repeated operations within that scope record that the issue was already reminded and do not establish compliance. Restart discards pending work and does not replay old tools or reminders; recorded request ids and original paragraph ids retain deduplication for that request while its Session context remains visible. Reminder admission writes no action receipt and leaves the common ledger's action result unconfirmed: an outer Hook may still reject the step and a model may ignore the guidance. Original DSH Session messages show actual model context; Jev receipts do not claim an adjustment, acceptance, or successful business action.

`tests/instructions-scope.test.ts` mounts real published preset/Loader trees and runs actual AgentLoop requests, checking two presets, two simultaneous runtime roots, and the direct Loader fallback. `tests/instructions.test.ts` exercises the published Native/PTC tool runtime, real AgentLoop with a deterministic main-model adapter, shared Jev service, and localhost HTTP. The test profile and filesystem live in temporary directories with dummy credentials. The fixture responses validate wiring and lifecycle behavior, not a paid judge's semantic accuracy.

## Shared finding corrections

The `@dsh-jev/plugin/shared-findings` bundle entry registers **Shared finding corrections / 共享发现纠正**, independently disabled by default in the Jev plugin page. The feature compares already delivered `agent-message` and continuable settlement messages, plus successful foreground reports returned by the native subagent tool and native `job_output` reads of linked one-shot background reports. Background identities are linked by the exact asynchronous tool execution, its observed child lifecycle, and the returned job ID, with the source call and child IDs saved before report consumption. Concurrent equal labels do not identify a source. It does not observe private exploration or turn internal PTC sub-dispatch output into a shared report. Original messages and native tool results remain unchanged.

Each original stores its source agent, root task, source message or tool-call identity, exact text including evidence references, and actual recipients. Model reception requires an assistant-stream chunk after the input has entered the recorded model history; inbox admission alone remains `queued`. A superseded original forwarded to a new recipient includes the current replacement at step admission; that supplemental notice establishes reception of the replacement only after its message ID appears in model history and a stream chunk confirms the attempt. Adoption stays `unknown`. A source repeated by the same sender under the same root retains one finding and adds its actual reception records. Nothing infers recipients from agent ownership or replays pre-enable history.

Relation questions distinguish replacement, conflict, support, unrelated, and unknown. They compare factual claims: control instructions, stop requests, acknowledgements, readiness, and receipt-only messages cannot replace or be replaced by factual findings. Repetition or paraphrase of the same conclusion is support. A replacement also identifies an exact line of the new original that explains the changed conclusion; a newer timestamp is insufficient. Superseded originals remain stored but leave the current comparison candidates. Pending old messages enter with an explicit notice identifying the current replacement, and corrections include both originals and the selected evidence. Unresolved conflicts retain both claims and ask the live root to verify with its existing tools or delegation; the hook creates no verifier.

Automatic correction delivery goes through the public parent-to-child message service and is limited to observed, still-live, continuable direct children under the same runtime root. Each admitted correction adds its actual recipient and message ID to the newer finding as queued; recorded model reception advances that receipt separately. This carries recipients through successive replacements without inferring adoption. The newer finding's sender does not receive its own report as a correction. An exact target's public disposal event aborts an in-flight send before the host can cold-resume it; ordinary tool or model work is not interrupted by correction delivery. Ended, one-shot, unsupported, and deeper recipients receive no automatic delivery, and the root receives the undelivered reason. Corrections identify the Jev plugin as their author and the parent-agent channel as their transport, and remain auxiliary evidence, not user authorization.

The actual pre-step handling a shared input waits for its relation. The common Jev service asks the exact live root on invalid, failed, or unknown judgments. Cancel retains unresolved originals and rejects the dependent admission without cancelling unrelated root work. Retry refreshes the originals, reception records, live targets, committed direct-user messages, and pending direct-user inbox. A changed user task invalidates the result even before the pending correction is committed. Disabling requires re-enabling before retry; an already sent attempt may finish.

`jev-shared-findings.config.maxRequestChars` is a live profile setting with default `48000` and minimum `2048`, covering the serialized comparison request. Oversized originals remain complete in the business store; the judgment receives a bounded omission record with source IDs and original lengths, and cannot produce an adoptable relation. Manual retry can use an increased limit; cancel leaves the relation unresolved. This limit never authorizes a comparison of silently truncated evidence. Each new original is compared pairwise with the remaining current findings; unrelated and supporting findings can still produce quadratic comparison growth.

The profile-specific `jev_shared_*` storage domain owns originals, relations, and delivery states separately from the common ledger. Jev's record page shows the comparison input, selected relationship and evidence, unresolved attempts, and delivery receipts. Receipt JSON distinguishes queued, model-received, not-delivered, and unconfirmed from adoption. Native messages use ordinary DSH Session records; the plugin adds no Session event type. Input/result persistence failure prevents request/adoption; missing or failed delivery receipts do not trigger a resend. Reload marks unfinished business relations interrupted, keeps history, and does not restore judgments, deliveries, or old recipient ownership.

## Running user-message routing

The `jev-interjection-routing` row adds the independent `interjection-routing` switch to the Jev feature page, disabled by default. While enabled, all direct user messages arriving during a live root Agent's activity are classified by meaning, including messages originally submitted as queue or steer. Corrections enter the nearest available step; additional work and other non-corrections remain queued for a subsequent turn. Idle new tasks, goal messages, plugin notices and subagent messages retain their original handling. The classifier does not cancel an already-started model request or tool.

A pending message retains its original identity, text, attachments and source in the public inbox. The plugin keeps the identity editable after a public claim by reinserting it, waits at pre-step or turn-stopping, then admits the current content once. Edits invalidate the earlier classification; removal cancels only that input. The original queue's remove-then-steer operation keeps the same identity and remains subject to semantic routing. Same-destination messages retain arrival order independently of response order; equal text with different identities remains distinct. Other pre-step or tool guards retain their decisions.

The judgment uses the current message text, current task and bounded visible history, with one Choice among `correction`, `queue`, and `unknown`. It does not require generated explanations. `contextChars` defaults to 12,000 and `messageChars` to 24,000; both are positive integers bounded at 1,000,000 in the plugin config. Attachments remain on the original message; their types, rather than unseen contents, are described to the classifier. Missing text, oversized input or insufficient attachment/context evidence cannot silently choose the original send mode. Transport or interpretation failure uses the public manual Retry/Cancel interaction. Cancel removes that message; disabling while waiting requires enabling again before retry. An already-issued successful answer may still be adopted after disabling, unless the message, task or cancellation has made it stale.

The Session records reception, classification, cancellation and original user-message admission. Mode intervals are persisted synchronously through the public inbox as plugin-owned notice messages that are appended and immediately removed without waking the Agent. Their `agent/inbox/spliced` records precede later user input and identify the feature state and running activity at arrival. This preserves the released Session requirement that the first model-surface message be its system head. Per-message notices arriving before that head use the same logged inbox mechanism and are surfaced after the first system message. No unknown Session event type or direct-user impersonation is introduced.

On Host restore, the plugin scans those recorded intervals before permitting model work. It removes unfinished routed inputs, shows an interrupted notice, and writes a stable zero-attempt public interruption record; it does not repeat classification or deliver them according to their old mode. Inputs originally queued in a disabled interval retain the Host behavior. The recovery check also covers a prefix ending after original inbox insertion but before any Jev operation was written. Mode-record failure blocks dependent model admission. Ordinary Host stop remains immediate; classified inputs are cancelled, while unrelated retained inbox work follows the Host's `keepInbox` behavior.

`ctx.jev.recordInterrupted(featureId, link)` records a recovery interruption without a model call or human question. The feature must be registered but may be disabled. `link.sessionId` and `link.inputVersion` must identify the Session and original input; the same feature/Session/input key returns the same record. The ledger writes `interrupted`, zero attempts and a fixed `INTERRUPTED` explanation in one durable put. The original input remains available through its Session identity; this API does not fabricate a model attempt.

## Native 网页目标执行

`@dsh-jev/plugin/web` 在现有 bundle 中登记默认关闭的 `native-web-execution` 功能，并提供页面交接工具 `jev_web_bind`、目标工具 `jev_web_goal`、页面读取工具 `jev_web_observe` 与轨迹读取工具 `jev_web_history`。启用后仍需主 Agent 明确调用目标工具；普通 `cua_driver_native__*` 工具不增加 Jev 判断、不被替换。插件不创建或关闭 Cua runtime，不注册第二个 computer-use provider，也不启动 MCP Server。DSH Native 及已准备好的浏览器是外部前提。

主 Agent 先通过 Native `browser_prepare` 准备任务浏览器，再从 `list_windows` 找到该进程的实际窗口，将同一 Cua `session`、准备结果的 `pid` 和窗口的 `window_id` 传给 `jev_web_bind`。该工具调用既有 Native 的绑定能力，把 `target_id` 和各标签页的 `tab_id`、标题、网址放入模型可见的 JSON 正文；它不启动浏览器、不导航，也不调用 Jev。主 Agent 从列表中选择任务页面，使用返回的原始标识调用 Native 导航或 `jev_web_goal`。绑定拒绝保留原原因，缺少标识不猜测；不得把 CDP target、标签页序号或占位值当作 Cua `tab_id`。DSH 0.1.7-rc.2 普通 Native 的正文只显示绑定摘要，结构化结果中的标签页标识须由此插件工具显式交给模型。

主 Agent 将现有 Cua `session`、`target_id`、`tab_id` 以及 `goal` 交给工具；`session` 是 Cua 的显式会话，不是 DSH Session ID。可提供 `constraints` 和 `texts: [{ label, text }]`，其中 `label` 说明字段用途，`text` 是允许填写的原文。第一版使用 `semantic_v2` 声明的点击、填写和滚动能力。填写以替换字段内容执行，空字符串可明确清空；缺少内容时返回字段线索，不生成文本。文件上传、截图定位、桌面应用和未交接页面操作返回主 Agent 处理。

每轮判断包含目标、约束、当前页面、候选及近期实际结果；字段明确区分空值、匹配已给原文、其他值与未知值，填写后的唯一读回事实单独记录。已匹配的原文不再构造相同替换，不能由“已填写”推断整个目标已完成。历史只携带动作和实际交付／验证结果，不把原始回执、概率和计时塞入选择上下文。Jev 只选择候选 ID，不生成工具参数；页面文字是观察证据，不能覆盖任务指令。

候选先过滤不可见、禁用与缺乏可识别名称的点击／填写目标，再按已确认输入／焦点、具名可见控件及其余具名目标排序；同优先级保留观察次序。不同 ref 的同名控件不合并，只有同 ref、同动作和同参数才去重。普通 pointer 能力不产生滚动候选，只有观察明确声明 scroll 或 scrollable 状态时才提供有界方向选项；滚动不挤占已经可容纳的点击与填写。每个保留候选的元素信息一并传给 Jev，省略与过滤原因进入输入及轨迹。当前 semantic_v2 未提供的父子关系、href 和 bounds 不会被猜测补充。

`input_route` 默认 `trusted`；调用方可显式选择 `dom_event` 合成后台点击／滚动，但后台拒绝后插件不会自动更换路线。刷新同一页面快照会替换旧引用。公开动作回执可能不保留过期引用的细分拒绝码；收到拒绝后交回主 Agent，不解析展示文字来猜测可重试，也不重发旧动作。

现有 Jev 设置页提供以下限制，按 profile 保存并在新运行开始时读取：决策轮次 `maxRounds=20`、连续无变化观察 `noProgressRounds=3`、连续 observe 选择 `maxObserveRounds=3`、可执行候选 `maxCandidates=80`、滚动候选 `maxScrollCandidates=2`（仍计入总候选额度）、近期步骤 `historySteps=8`、页面正文字符 `evidenceChars=16000`、滚动 CSS 像素 `scrollPixels=600`、结果摘要步骤 `resultSteps=5`。只重新观察和人工重试也占决策预算；第三次连续选择 observe 时交回主模型，不再读取或判断。无变化比较忽略快照／引用 ID 和正文显示空白，保留字段值、控件顺序和能力变化。动作后的观察直接供下一次选择使用，人工重试和显式 observe 则重新读取。

`jev_web_observe(session,target_id,tab_id)` 通过同一 Native 读取当前页，将实际 refs、值、页面正文、快照身份和覆盖范围写入模型正文，不调用 Jev。可传 Native 的 `query`、`scope_ref`、`continuation` 补充特定范围，但新观察替换旧引用，不拼接多个快照的 refs。正文按现有限制截取，完整观察保存在插件记录中；只传返回的 `observation_id` 及 `offset/limit` 可按字符读取保存的 JSON，不再触发 Native 观察。保存记录属于历史证据，分页不能证明引用仍有效；页面操作或其他观察后需重新读取。每个 DSH 会话只能读取自己的记录。

`jev_web_goal` 返回运行标识、结束原因、已执行动作数、最后可用页面证据、近期步骤及完整记录入口。`completion-suggested` 是完成建议，`completion_verified` 始终为 false，主 Agent 必须结合证据决定是否完成。`needs-main-agent` 包括合法 unknown、连续重新观察上限和无可用候选的前置检查；`handoff_reason` 区分页面未就绪、观察不完整、目标信息不足、能力缺失与判断无法确定。空白页或无可识别动作且无 Native busy 状态时，在首次判断前交回，零 Jev 请求。业务无法判定时，插件立即交回主模型继续 Native CUA，不询问人，也不重试 Jev。结果的 `handoff` 提供原 Cua 页面标识、输入路由及有界的当前元素；省略的元素可从 `jev_web_history` 读取完整观察；需要当前引用时调用 `jev_web_observe`。主模型须结合已有执行轨迹避免重复动作，重新观察后使用新引用，不能在证据和候选未变时反复调用目标工具。其他结束原因区分缺少内容、能力不足、动作拒绝／失败、结果未确认、预算、无进展、关闭、取消、中断和内部故障。Native 动作以最终公开的 `ActionResult`（`effect/route/delivery/evidence/escalation`）判定，不能读取底层实现里的旧 `status:ok` 当作最终协议。`refused`、`partial`、`suspected_noop` 和非后台交付都会停止；`unverifiable` 只表示效果未验证，不表示没有交付或目标完成。后台交付后重新观察；填写还需完整交付计数与同角色、名称及 frame 的唯一字段值读回吻合，才继续下一步。同名字段无法唯一验证时交回未确认，不重复填写。步骤中的 `executed` 是交付事实，`verification` 单独记录 `unverified`／`value-readback`。

完整轨迹保存在按 profile 隔离的插件 storage domain。主 Agent 调用 `jev_web_history` 不带 `run_id` 可列出本 DSH 会话的运行，包括被取消的调用；带 `run_id` 则按 `offset`／`limit` 读取完整 JSON 字符页，使用 `next_offset` 继续。其他 DSH 会话不能读取此轨迹。公共 Jev 判断记录以 `runId`、步骤及回执与它关联。运行中的 `metrics.observe/action` 测量 Native 工具管线调用次数与耗时；`judgmentWait` 测量整个公共 judge 等待，包含服务调用、人工等待以及重试观察，与 observe 时间可能重叠，不能直接相加。单次 Jev 请求延迟从关联的公共 attempt 记录读取；候选分类、省略、选择及读回结果可分别从运行和步骤恢复。旧记录中缺失的新指标保持缺失，不伪造计时。主模型看见的目标工具结果仍由 DSH 原工具日志保存；内部 Native 子调用不伪装为独立的模型调用。

动作执行前先保存待执行状态，执行后的回执与动作不是原子事务。写入失败停止后续动作；重启将未完成运行标为中断、待执行动作标为未确认，不重发模型请求或重放动作。取消与卸载只影响本功能自己的工作，借用的浏览器和正常 Native 保持可用。Jev 服务超时、失败和无效响应继续使用公共人工 Retry／Cancel；合法 `unknown` 是业务交接结果，不进入该流程。手动重试重新观察，关闭后需先启用或取消。已发出的有效判断可在功能关闭后完成本步，但不继续下一轮。

`tests/web.test.ts` 使用真实 DSH 工具流程、AgentLoop、Session 重放、JSON 存储和本地确定性 Jev HTTP 服务验证控制流程；其中 Native 是明确的测试替身，不能据此声称已验证真实浏览器或付费模型质量。

## Consumer API

Register a feature from its own Cordis plugin and give the returned disposer to its own effect. Supply the exact live Web root `Agent` from the business invocation; `ctx.userQuestions` verifies that identity before asking the human.

```ts
ctx.effect(() => ctx.jev.registerFeature({
  id: 'my-feature',
  name: 'My feature',
  description: 'What this judgment supports',
}))

const outcome = await ctx.jev.judge({
  featureId: 'my-feature',
  agent: invocation.agent,
  signal: invocation.signal,
  link: { sessionId: invocation.agent.session.id, runId: runId },
  refresh: async (signal) => ({
    state: await readCurrentState(signal),
    questions: [
      { id: 'choice', kind: 'choice', prompt: 'Choose one', options: [
        { id: 'a', description: 'Candidate A' },
        { id: 'b', description: 'Candidate B' },
      ] },
      { id: 'risk', kind: 'score', prompt: 'Rate risk', levels: ['low', 'medium', 'high'] },
      { id: 'ready', kind: 'noul', prompt: 'Is this ready?' },
    ],
  }),
  interpret: (response) => businessCanUse(response)
    ? { usable: true }
    : { usable: false, reason: 'The answer does not resolve this operation' },
  canAdopt: () => targetIsCurrent() ? true : 'Target changed during judgment',
})

if (outcome.kind !== 'ok') return
const executed = await performBusinessAction(outcome.response)
await ctx.jev.writeReceipt(outcome.operationId, {
  id: actionId,
  status: executed ? 'executed' : 'execution-failed',
  at: new Date().toISOString(),
})
```

`refresh` runs again only after a human selects Retry. A retry reads the latest connection, credential, feature switch, and business input. If the feature was disabled while waiting, the service asks the human to enable it or cancel and sends no new request. Disabling an already sent judgment does not cancel that attempt. Choice preserves the selected option and service probability distribution. Score preserves the fractional position in the ordered rubric (`1.5` is valid for three levels), without normalization. Noul preserves its probability of true separately from optional confidence. A missing, malformed, or out-of-range answer cannot return `kind: 'ok'`.

Before every HTTP call, the service durably writes the exact JSON state and questions. It uses `ctx.llm.stream` with a versioned JSON envelope containing that same snapshot; the dedicated adapter sends the System One HTTP body and rejects ordinary chat calls. A valid result must be durably written before it is returned. Transport, timeout, validation, and business-interpretation failures wait for an explicit human Retry or Cancel; a missing answerer fails the operation. External cancellation stops the dependent operation without cancelling the whole Host Session. Business actions still use the Host's normal tools, guards, and sandbox; `ctx.jev` never performs them.

Each profile stores its own operation and attempt records in a storage domain derived from `ctx.profileContext.dir`. The browser Remote reads only that domain; `listRecords` caps a page at 100 summaries and `getRecord` loads detail on demand. Action receipts are idempotent by receipt id. A conflicting receipt fails, and an absent receipt after a restart means the action result is unconfirmed. If the input write fails, no Jev request is sent; if the result write fails, no answer is returned as usable. Receipt write failure means the caller must investigate the action and must not repeat it merely to repair the record.

## Local Web fixture

The files under `tests/fixtures` are not included in the package. Their private `package.json` gives the test command a separate Loader package identity from `@dsh-jev/plugin`, so the Host plugin remains the single active source of its Web Client. They use only a local HTTP server and a test-only DSH slash command; they do not call a paid service or run the main chat model.

1. Run `node packages/jev/tests/fixtures/system-one-server.mjs` from this workspace. It prints local `/success`, `/invalid-once`, and `/always-invalid` System One URLs. `POST http://127.0.0.1:<printed-port>/reset` resets the one-time failure counter.
2. Start an isolated Web profile with an extra overlay containing `insert: [{ id: jev-fixture, name: /absolute/path/to/packages/jev/tests/fixtures/command.mjs }]`. The ordinary Jev package bundle must already be installed in that profile. The overlay is test-only and is never part of `cordis.patch.yml`.
3. In Jev settings, set a printed local endpoint and a dummy test credential, then enable the registered `fixture` feature. In a real Web root Session, submit `/jev_fixture` in the chat composer. This is a `ctx.commands` human command and supplies its actual `CommandInvocation.agent` to `ctx.jev.judge`; the main model is not invoked. `/invalid-once` shows the human Retry/Cancel flow, and each retry increments the fixture state's `version`. `/jev_fixture stale` records a target that was not adopted. `/jev_fixture undetermined` exercises the consumer's unusable-answer path.

These fixtures establish only local protocol and Web integration. They do not establish compatibility with a paid Jev endpoint or a future DSH release.

## Execution supervision

The `jev-supervision` row registers independent `drift-monitoring`, `completion-check`, and `goal-supervision` switches, all off by default. The plugin page saves `driftInterval` (6 completed model steps), `noProgressRounds` (3 consecutive native goal rounds), and `evidenceChars` (24,000 evidence characters, maximum 1,000,000) in that profile. Parallel tool calls count as one model step. Changing counts does not enable a feature; disabling prevents subsequent calls while an already-issued answer may still be adopted.

Drift checks run in the background through `judgeOnce`. A correction is appended only to an already-admitted later model step and is acknowledged when its ordinary Session message is recorded. A repeated selected requirement is not reminded again for the same ordinary request or goal revision. The check never rejects tools, waits for a human, cancels the Agent, or wakes an ended task. Transport, interpretation, and logging failures leave that check unadopted.

Completion checks run after the answer is visible at `agent/turn-stopping`. Recorded evidence supporting completion closes normally. Explicit omissions reserve and queue at most one supplemental attempt for the original request; another omission or a required user decision is recorded visibly without another automatic attempt. The reservation is saved before queueing and is read from the profile ledger after restart. Session messages also retain the original request identity. A failed action receipt does not authorize repetition. This is evidence review, not an independent test execution.

The completion assessment asks Jev to compare final claims about deliverables, verification, and side effects with recorded tool results and applicable user requirements. A factual claim contradicted by that evidence requires correction and counts as an omission even when the requested investigation is finished. Supplemental work remains within existing user authorization: a read-only review can correct its report without authorizing file repair or artifact deletion. A reminder alone neither establishes a violation nor requires a pause; `needs-user` denotes an unresolved user decision, while `unknown` denotes insufficient evidence. These instructions guide the judge and do not independently establish its semantic accuracy.

Active goals use only DSH's native goal-round driver and its existing round limit. Goal supervision assesses progress after each completed native round, clears the consecutive count after useful investigation or progress, and pauses after the configured run of unchanged evidence. User resume starts a new count. Model `update_goal` completion requests pass through the public tool pre-execute hook; an omission denies that application without replacing the tool's own authorization. Manual goal completion uses the unchanged goal service. A cancelled interactive check pauses its unchanged active goal while preserving other queued user work. A turn owned by the goal flow never starts an independent completion supplement.

Judgments use only recorded visible messages, tool results, the current request, and the native goal. No extra filesystem scan or verification command is run, and reasoning blocks are excluded. Ordinary evidence begins at the original request; goal completion uses the current goal revision's rounds; progress compares the current and previous goal rounds with the current goal. The request records this scope and the excluded earlier-message count. If necessary evidence exceeds the configured character budget, omitted evidence is explicit and no completion or no-progress finding is accepted. Increasing the budget and manually retrying can provide the missing evidence. Answers use two bounded Choice questions (assessment and existing evidence identity); they never require generated `legend` prose. User feedback quotes the selected existing requirement or record.

New user requirements, target goal revisions, cancellation, and task completion fence result adoption. A Host restart interrupts pending public ledger records and does not resume checks or native goal execution. Scope and timing tests use the published DSH 0.1.7-rc.2 Agent loop, tool runtime, native goal driver, JSONL Session persistence, and local deterministic Jev HTTP responses. These tests establish integration and limits; they do not establish the quality of a paid judge model.

## Non-interactive consumer API

`ctx.jev.judgeOnce(options)` accepts the same `JevJudgeOptions` as `judge`, including `refresh`, `interpret`, `canAdopt`, and `signal`. It makes at most one attempt, opens no user question, and returns `ok`, `cancelled`, `not-adopted`, or `failed`. Only `ok` authorizes a consumer to consider adoption. `failed` contains a safe failure code and message; `operationId` is absent when the operation could not be created. A refresh failure records an operation-level failure without fabricating an HTTP attempt. Input-log failure sends no request, result-log failure returns no usable answer, and a failed receipt must not trigger repeated execution. The interactive `judge` retains manual Retry/Cancel behavior.

`ctx.jev.isFeatureEnabled(id)` reads current profile enablement synchronously. `ctx.jev.onFeatureStateChange(listener)` returns an owned disposer and synchronously supplies an immutable feature snapshot after the owning Loader fiber commits changed feature values. It does not emit an initial snapshot or unchanged settings. Consumers register their disposer with `ctx.effect` and can read the initial state using `isFeatureEnabled`.

## 验收记录

Native 网页执行的测试范围和真实运行边界见 [网页目标执行验收](../../docs/testing/native-web-execution.md)。

四组执行检查 Hook 的测试、真实调用结果与已接受边界见 [2026-09-27 验收归档](../../docs/testing/2026-09-27-jev-hooks/README.md)。
