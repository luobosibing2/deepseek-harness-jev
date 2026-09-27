# @dsh-jev/plugin

This package adds shared, typed Jev judgments to a DeepSeek Harness Web profile. It registers a Host service (`ctx.jev`), a plugin-owned Typert Remote namespace (`jev`), and one settings and records page. Its separate `./selection` Host entry adds optional hooks for skill catalog selection and glob result ranking. Other business plugins register their own features and decide whether a complete answer is useful or still current.

## Install and configure

Build this workspace, then install the package into an isolated DSH Web profile with the official `dsh plugin --profile <name> add <package-path>` command. Its `cordis.patch.yml` inserts Host rows `jev` and `jev-selection`; the package's Web Client mounts the generated Remote contribution and page. The profile must supply the standard LLM, credentials, user questions, settings, and storage domain services. The selection row additionally uses the Host's tools, skills, and Agent registry services; glob searches still use the Host's original filesystem and subprocess services. This plugin requires DSH `0.1.7-rc.2` and Cordis `4.0.4`.

The Jev page edits the profile's `jev` configuration through DSH config forms. `baseUrl` is the complete HTTP(S) System One endpoint, `model` names the provider model, `credentialRef` names a DSH credential reference, `timeoutMs` is the per-attempt deadline, and `features` holds per-feature enablement. A new feature is disabled until explicitly enabled. The page saves or replaces a key through `ctx.credentials`; neither Remote status nor records return the key. An empty endpoint is allowed so the page can load before connection setup. Nonempty endpoints reject URL credentials, queries, and fragments at configuration validation.

## Skill and glob selection

The separate `jev-selection` row registers `skill-selection` and `file-ranking`, both disabled by default. It hooks the original skill catalog publication and `glob` result pipeline for live Web root Agents. Other caller scopes retain the Host flow. The main model keeps using `skill` to load instructions and `glob` to search paths; there are no separate `jev_find_skills` or `jev_locate_files` tools.

The Jev page edits three positive safe integers in the current profile: `skillLimit` defaults to 5 top-ranked skills per judgment, before removing summaries already in context, `fileCandidates` is the maximum glob match count eligible for Jev (40), and `fileLimit` defaults to 12 displayed ranked paths. A glob with more than 40 matches bypasses Jev completely at the default setting; it does not truncate to 40 before assessment. The original result ordering, display limits, and recovery mechanism apply to bypassed searches. Settings do not enable either feature and persist across profile restarts.

Skill selection happens before summaries reach the main model. It assesses only model-invocable names and descriptions from the current Agent's catalog; Jev never receives skill bodies. A provider may read metadata files while collecting those summaries. After choosing the top configured number, the hook adds only skill names absent from catalogs still visible in the current Session; it does not fill vacated slots from lower-ranked skills. Earlier summaries remain available, and a fully repeated selection adds no catalog message. The visible additions explain how to expand the complete current catalog without another Jev call. Omitted skills remain callable, and an explicit user skill invocation continues through the original loading path. Loading a chosen skill by name does not trigger another selection. A new direct user request or a changed directory starts a fresh catalog selection; ordinary tool steps do not repeat it. The catalog fingerprint and temporary checked-directory state track only when to publish, never reuse a Jev answer.

Every eligible glob search uses that call's complete path results, without another scan or content read. Search patterns, path scopes, hidden and ignored files, and search errors retain the original glob behavior. Results sort by relevance probability, with original candidate order breaking ties. Low probabilities remain eligible for display; independent confidence appears only when supplied by Jev. Each repeated eligible request makes a fresh judgment. There is no cross-request judgment cache, and unrelated tools such as `grep` do not trigger ranking.

Jev receives at most the latest two direct user messages and the latest preceding visible assistant text, with a combined 2,000-character budget; glob also supplies its original pattern/path. Pending direct user text is included before skill publication. Text is allocated newest-first, retaining the end of an oversized message, and presented in conversation order. Reasoning, tool output, attachments, and skill bodies are excluded. Empty candidates, unavailable task context, and disabled features use the original flow without a Jev request or fabricated scores.

Glob's structured return remains `{ root, paths }`, with the ranked paths in `paths`. Native calls receive probabilities in the model-visible tool text. PTC programs receive the original structured type; scores are delivered to the main model through call-associated additional context and recorded in the Session. Glob cards show the sorted paths and do not add a probability column. Capped ranked output reports candidate, assessed, displayed, and omitted counts and provides a readable complete ranked result with scores. If result storage is unavailable, all scored paths are shown inline with an explicit notice.

Jev failures use the shared manual Retry or Cancel flow. A retry reads current settings and context, and refreshes skill candidates. A glob retry retains the completed search paths; if a lowered candidate maximum now excludes them, it sends no further judgment and returns the original glob result. Disabling while waiting requires enabling again or cancelling. A failed judgment does not silently return unranked output. Host restart does not resume an old pending judgment. The Jev ledger records judgments separately, while model-visible summaries, results, and additional context use DSH's normal Session records. Selection does not load a skill, read a file, establish that a file contains the implementation, or predict task success.

## Shared finding corrections

The `@dsh-jev/plugin/shared-findings` bundle entry registers **Shared finding corrections / 共享发现纠正**, independently disabled by default in the Jev plugin page. The feature compares already delivered `agent-message` and continuable settlement messages, plus successful foreground reports returned by the native subagent tool and native `job_output` reads of linked one-shot background reports. Background identities are linked by the exact asynchronous tool execution, its observed child lifecycle, and the returned job ID, with the source call and child IDs saved before report consumption. Concurrent equal labels do not identify a source. It does not observe private exploration or turn internal PTC sub-dispatch output into a shared report. Original messages and native tool results remain unchanged.

Each original stores its source agent, root task, source message or tool-call identity, exact text including evidence references, and actual recipients. Model reception requires an assistant-stream chunk after the input has entered the recorded model history; inbox admission alone remains `queued`. A superseded original forwarded to a new recipient includes the current replacement at step admission; that supplemental notice establishes reception of the replacement only after its message ID appears in model history and a stream chunk confirms the attempt. Adoption stays `unknown`. A source repeated by the same sender under the same root retains one finding and adds its actual reception records. Nothing infers recipients from agent ownership or replays pre-enable history.

Relation questions distinguish replacement, conflict, support, unrelated, and unknown. They compare factual claims: control instructions, stop requests, acknowledgements, readiness, and receipt-only messages cannot replace or be replaced by factual findings. Repetition or paraphrase of the same conclusion is support. A replacement also identifies an exact line of the new original that explains the changed conclusion; a newer timestamp is insufficient. Superseded originals remain stored but leave the current comparison candidates. Pending old messages enter with an explicit notice identifying the current replacement, and corrections include both originals and the selected evidence. Unresolved conflicts retain both claims and ask the live root to verify with its existing tools or delegation; the hook creates no verifier.

Automatic correction delivery goes through the public parent-to-child message service and is limited to observed, still-live, continuable direct children under the same runtime root. Each admitted correction adds its actual recipient and message ID to the newer finding as queued; recorded model reception advances that receipt separately. This carries recipients through successive replacements without inferring adoption. The newer finding's sender does not receive its own report as a correction. An exact target's public disposal event aborts an in-flight send before the host can cold-resume it; ordinary tool or model work is not interrupted by correction delivery. Ended, one-shot, unsupported, and deeper recipients receive no automatic delivery, and the root receives the undelivered reason. Corrections identify the Jev plugin as their author and the parent-agent channel as their transport, and remain auxiliary evidence, not user authorization.

The actual pre-step handling a shared input waits for its relation. The common Jev service asks the exact live root on invalid, failed, or unknown judgments. Cancel retains unresolved originals and rejects the dependent admission without cancelling unrelated root work. Retry refreshes the originals, reception records, live targets, committed direct-user messages, and pending direct-user inbox. A changed user task invalidates the result even before the pending correction is committed. Disabling requires re-enabling before retry; an already sent attempt may finish.

`jev-shared-findings.config.maxRequestChars` is a live profile setting with default `48000` and minimum `2048`, covering the serialized comparison request. Oversized originals remain complete in the business store; the judgment receives a bounded omission record with source IDs and original lengths, and cannot produce an adoptable relation. Manual retry can use an increased limit; cancel leaves the relation unresolved. This limit never authorizes a comparison of silently truncated evidence. Each new original is compared pairwise with the remaining current findings; unrelated and supporting findings can still produce quadratic comparison growth.

The profile-specific `jev_shared_*` storage domain owns originals, relations, and delivery states separately from the common ledger. Jev's record page shows the comparison input, selected relationship and evidence, unresolved attempts, and delivery receipts. Receipt JSON distinguishes queued, model-received, not-delivered, and unconfirmed from adoption. Native messages use ordinary DSH Session records; the plugin adds no Session event type. Input/result persistence failure prevents request/adoption; missing or failed delivery receipts do not trigger a resend. Reload marks unfinished business relations interrupted, keeps history, and does not restore judgments, deliveries, or old recipient ownership.

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
