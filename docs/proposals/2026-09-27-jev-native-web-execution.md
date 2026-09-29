# Proposal: Jev-assisted Native web goal execution

English | [简体中文](2026-09-27-jev-native-web-execution.zh-CN.md)

**Status: paused proposal.** The user paused this direction on 2026-09-27 after the observed effect on ordinary websites was unsatisfactory. The experimental code is not in `main`; this document proposes behavior for review and does not authorize implementation, further testing, or a merge of the [experimental branch](https://github.com/luobosibing2/dsh-jev-plugin/tree/codex/jev-native-web-execution).

## Direct answer

An optional Jev feature would help the main DSH agent carry out a goal on an already selected web page. The main agent supplies the goal, page identity, constraints, and any text to enter. The plugin observes that page through DSH's existing Native Computer Use tools, builds executable candidates from the current observation, asks Jev to choose one candidate, executes at most one action, and returns the evidence and a bounded outcome to the main agent. Jev selects among observed actions; it does not generate text, invent a target, decide that the goal is complete, or replace the main agent.

## Problem and observed limits

The paused experiment exposed three connected failures. Expanding scroll actions for every pointer reference consumed much of an 80-action candidate budget, leaving a visible search control beyond the truncation point. An unnamed link could be selected without enough evidence about its destination. Repeated observations and an unclear handoff led the main agent to revisit the same state. These observations motivate candidate quality, state reporting, and stopping rules; they do not establish that the revised feature improves real website outcomes.

The Native references observed in the experiment provided action capabilities, frame, name, reference, role, states, value, and visibility. They did not provide reliable parent relationships, link destinations, or element bounds. A later implementation must recheck the current Native interface before using any additional field.

## Proposed behavior

- **Scope and ownership.** Keep the feature inside this independent plugin, disabled by default and enabled per profile. Require an explicitly handed-off task page in a live Web root session. Use the Host's registered Native tools and their authorization rules; do not patch DSH, start another browser driver, select an unrelated tab, or intercept ordinary Native calls.
- **Observation and candidates.** Provide a bounded, read-only observation of the handed-off page in ordinary model-visible tool output. Build candidates only from one current Native observation and text supplied by the main agent. Filter unsupported, disabled, invisible, and insufficiently described actions before spending the candidate budget. Give actionable inputs and named controls space before a separate small scroll allowance. Do not merge distinct Native references merely because they have the same name, infer missing parentage or URLs, or offer an action whose target description was omitted.
- **Jev's decision.** Send the goal, available evidence, executable candidates, and a compact history of observed results to the shared Jev service. Accept only a candidate from that same decision round. A transport failure or invalid answer follows the existing human Retry/Cancel path; a valid business `unknown` returns to the main agent for continued Native work.
- **Execution and limits.** Execute no more than one selected action per decision, then observe the result. Reuse that post-action observation for the next decision when still valid. Bound total rounds, lack of progress, and consecutive observe choices. Cancel before late results cause further actions. Never execute a stale reference, automatically switch to foreground input after a Native rejection, or replay a write whose effect is uncertain. Entered text must be fully delivered and uniquely read back before the feature treats a field as filled.
- **Handoff and records.** Return the page identity, last observation and its coverage limits, attempted actions, verified effects, and an explicit reason for stopping. A completion suggestion remains subject to the main agent's verification. Record candidate counts, omissions, decisions, field readback, and measurable observation, Jev, and execution time without adding overlapping durations or claiming unmeasured wait time. Model-visible results remain reconstructable from the DSH Session; auxiliary Jev judgments use the plugin ledger.

## Alternatives considered

**Increase the 80-action cap alone.** This retains duplicate scroll options and weakly described links while sending more candidates to Jev. Candidate filtering and separate allowances address the observed omission directly.

**Replace Native with a DOM/CDP browser stack.** Browser-use and agent-browser offer richer element relationships, but adopting them would introduce a second observation and execution owner and assume fields the observed Native interface did not supply.

**Add screenshot guessing, a second planning model, or automatic foreground fallback.** These would widen the feature's authority and could repeat uncertain writes. The existing main agent and Native tools own cases the plugin cannot resolve.

**Use confidence alone to gate actions.** A threshold cannot recover a search button that never entered the candidate set.

## Acceptance criteria

- With the feature disabled or when the main agent uses ordinary Native tools, the plugin makes no Jev request and does not alter Native arguments, results, permissions, or runtime ownership.
- Under the same 80-action budget, a page with the previously duplicated scroll candidates retains its observed search input and submit control. Unnamed targets without sufficient evidence are not blindly selected, and distinct same-named controls retain distinct identities.
- After an input is fully delivered and uniquely read back, the next decision represents it as filled rather than proposing the same replacement. An unconfirmed write remains uncertain and is not replayed for diagnosis.
- A blank or unbound page, missing content, unsupported action, business `unknown`, stale reference, or exhausted progress budget gives the main agent a specific handoff reason and usable current evidence. Read-only observation makes zero Jev requests and exposes real Native references in the next model-visible turn.
- Focused tests cover the public tool path, lifecycle, failure and cancellation cases, Session output, and candidate accounting. Real ordinary-site trials with a fixed task and main model separately compare Native-only and Native-plus-Jev outcomes, main-model/Jev/CUA calls, and wall time. Simulated runs cannot satisfy that effectiveness criterion.

## Boundaries and verification

The experimental branch has local regression and isolated Native-flow evidence, including candidate retention and model-visible reference handoff. The user paused it after poor observed practical effect. Normal-website success, performance improvement, and a combined real main-model/Jev acceptance run remain unverified. This PR publishes only the proposal; it does not change the shipped plugin or resume the paused experiment. Any later implementation needs a new decision to resume, current DSH Native interface checks, and the real-site acceptance above. Credentials, local profiles, and raw user sessions are not part of this proposal.
