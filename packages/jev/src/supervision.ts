/** Execution supervision over the public Agent, tool and native goal hooks. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { JevJudgeOptions, JevJudgeResult } from './index.ts'
import type { JevRequest, JevResponse, Json } from './types.ts'
import type { SupervisionConfigValues } from './supervision-types.ts'

/** Positive profile counts; feature switches live in the common Jev service. */
export interface Config { driftInterval: Volatile<number>; noProgressRounds: Volatile<number>; evidenceChars: Volatile<number> }
export const Config: s<SupervisionConfigValues, Config> = s.object({
  driftInterval: s.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(6).volatile(),
  evidenceChars: s.number().step(1).min(1).max(1_000_000).default(24_000).volatile(),
  noProgressRounds: s.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3).volatile(),
})

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'jev-supervision': { kind: 'jev-supervision'; form: 'notice'; summary: string; requestId: string; action: string; operationId: string }
  }
}

type Check = 'drift-monitoring' | 'completion-check' | 'goal-supervision'
interface Verdict { value: string; reason: string; issueKey: string }
interface State {
  steps: number
  enabled: boolean
  active: boolean
  turn: number
  requestId: string
  signal?: AbortSignal
  reminderScope: string
  ownsGoalTurn: boolean
  reminded: Set<string>
  pending: { outcome: Extract<JevJudgeResult, { kind: 'ok' }>; verdict: Verdict; version: string }[]
  stalled: number
  goalRevision: string
  lastRound: number
}

const choices = {
  drift: ['on-track', 'drift', 'unknown'],
  completion: ['complete', 'omission', 'needs-user', 'unknown'],
  progress: ['progress', 'no-progress', 'needs-user', 'unknown'],
} as const

function verdict(response: JevResponse, request: JevRequest): Verdict | undefined {
  const assessment = response.answers.find(answer => answer.id === 'assessment')
  const evidence = response.answers.find(answer => answer.id === 'evidence')
  if (response.answers.length !== 2 || assessment?.kind !== 'choice' || evidence?.kind !== 'choice') return undefined
  const question = request.questions.find(question => question.id === 'evidence')
  if (question?.kind !== 'choice') return undefined
  const selected = question.options.find(option => option.id === evidence.optionId)
  if (selected === undefined) return undefined
  const state = request.state
  if (typeof state !== 'object' || state === null || Array.isArray(state) || !('completeEvidence' in state) || state.completeEvidence !== true) return undefined
  const labels: Record<string, string> = {
    'on-track': '当前工作与要求一致 / Work follows the requirement',
    drift: '当前工作偏离所选要求；请回到该要求 / Return to the selected requirement',
    complete: '已有证据支持完成 / Recorded evidence supports completion',
    omission: '所选要求仍有缺项或最终事实与记录矛盾；请如实更正报告，其他补做限原授权，不擅自回滚、删除或修改文件 / Correct final factual claims contradicted by recorded evidence; address other omissions only within the original authorization, without unauthorized rollback, deletion, or file changes',
    'needs-user': '需要用户决定 / A user decision is needed',
    progress: '本轮增加有效调查或推进证据 / This round added useful evidence or progress',
    'no-progress': '本轮没有新增有效证据或推进 / This round added no useful evidence or progress',
    unknown: '证据不足 / Insufficient evidence',
  }
  return { value: assessment.optionId, reason: `${labels[assessment.optionId] ?? assessment.optionId}\n记录引用 / Recorded reference ${selected.id}: ${String(selected.description)}`, issueKey: selected.id }
}

function lastUser(agent: Agent): string {
  return agent.session.deriveMessages().findLast(message => message.role === 'user' && message.source.kind === 'user')?.id ?? ''
}

function goalIdentity(goal: GoalView | undefined): string {
  return goal === undefined ? '' : `${goal.id}:${goal.revision}:${goal.phase}`
}

function version(ctx: Context, agent: Agent): string {
  return JSON.stringify([lastUser(agent), goalIdentity(ctx.goals.get(agent)),
    [...agent.inbox.nextStep, ...agent.inbox.nextTurn].filter(message => message.source.kind === 'user').map(message => message.id)])
}

/** Only recorded visible evidence is sent; reasoning blocks and new filesystem reads are excluded. */
function evidence(ctx: Context, agent: Agent, mode: keyof typeof choices, budget: number, requestId: string): JevRequest {
  const history = agent.session.deriveMessages()
  const goal = ctx.goals.get(agent)
  let start = Math.max(0, history.findIndex(message => message.id === requestId))
  if (goal?.phase === 'active') {
    const rounds = history.flatMap((message, index) => message.role === 'user' && message.source.kind === 'goal'
      && message.source.goalId === goal.id && message.source.revision === goal.revision && message.source.round > 0 ? [index] : [])
    start = mode === 'progress' ? rounds.at(-2) ?? rounds.at(-1) ?? start : rounds[0] ?? start
  }
  const all = history.slice(start).map(message => ({
    id: message.id, role: message.role,
    ...message.role === 'user' ? { source: message.source.kind } : {},
    content: message.content.filter(block => block.type !== 'reasoning'),
  }))
  const messages: typeof all = []
  const goalSize = goal?.phase === 'active' ? JSON.stringify(goal).length : 0
  const omittedGoal = goalSize > budget
  let remaining = Math.max(0, budget - goalSize)
  let omitted = 0
  for (const message of all.toReversed()) {
    const size = JSON.stringify(message).length
    if (size > remaining) { omitted++; continue }
    messages.unshift(message)
    remaining -= size
  }
  const candidates = messages.filter(message => message.role === 'user' && (message.source === 'user' || message.source === 'goal'))
  const selected = candidates.length === 0 ? messages : candidates
  const options: { id: string; description: string }[] = selected.map(message => ({ id: message.id,
    description: JSON.stringify(message.content).slice(0, 800) + (JSON.stringify(message.content).length > 800 ? ' [excerpt; full record above]' : '') }))
  if (goal?.phase === 'active') options.unshift({ id: goalIdentity(goal), description: omittedGoal ? 'Goal objective exceeds evidence budget; choose unknown.' : goal.objective })
  if (options.length === 0) options.push({ id: 'no-evidence', description: 'No evidence fits the configured budget; choose unknown.' })
  const completionRules = 'Check the submitted answer and claimed deliverables, verification results, and side effects against the actual recorded tool results and applicable user requirements. A final factual claim contradicted by recorded evidence is an omission requiring correction, even if the requested investigation is otherwise finished; it cannot be complete. A supplement may correct the report or complete only work already allowed by the user. Read-only or no-repair instructions remain binding: do not require deleting artifacts, repairing files, or other unauthorized work. A reminder is not itself proof of a violation or a mandatory pause; needs-user requires an actual unresolved user decision, not merely a reminder or a correctable factual error.'
  const state = JSON.parse(JSON.stringify({
    mode, goal: omittedGoal ? { id: goal?.id ?? '', objectiveOmitted: true } : goal ?? null, messages, completeEvidence: !omittedGoal && omitted === 0 && messages.length > 0, omittedMessages: omitted, excludedEarlierMessages: start, evidenceScope: goal?.phase === 'active' ? mode === 'progress' ? 'current and previous goal round with current goal' : 'current goal revision rounds' : 'original user request and its subsequent work', evidenceCharacterBudget: budget,
    rules: 'Use only recorded evidence. Assistant completion claims and successful tool dispatch are not verification. A test started without a result is not passed. A pass before later edits is stale for those edits. Explicitly required verification missing is an omission; insufficient information or omitted evidence is unknown. Necessary investigation and eliminating a relevant hypothesis are progress. Ignoring a reminder alone is not no-progress. In progress mode compare evidence added by the latest goal round to prior rounds. Select the requirement or recorded message supporting your assessment in the evidence question. Do not invent requirements or execute tools.'
      + (mode === 'completion' ? ' ' + completionRules : ''),
  })) as Json
  const completionDescriptions = {
    complete: 'The requested work and final factual claims are supported by recorded evidence, with no outstanding required work, verification, or factual correction.',
    omission: 'Recorded evidence identifies unfinished required work, missing required verification, or a contradicted final factual claim that can be corrected within the existing user authorization.',
    'needs-user': 'An unresolved decision or authorization from the user is necessary to finish; a report correction or other already-authorized work cannot resolve it.',
    unknown: 'The recorded evidence is insufficient or omitted, so completion cannot be determined; do not infer success or invent missing work.',
  }
  return { state, questions: [
    { id: 'assessment', kind: 'choice', prompt: 'Assess ' + mode + ' from the existing evidence only.' + (mode === 'completion' ? ' ' + completionRules : ''), options: mode === 'completion'
      ? choices.completion.map(id => ({ id, description: completionDescriptions[id] }))
      : choices[mode].map(id => ({ id, description: id })) },
    { id: 'evidence', kind: 'choice', prompt: 'Which recorded requirement or message most directly supports the assessment?', options },
  ] }
}

/** Install three independently enabled consumers; native goals retain exclusive continuation ownership. */
export function apply(ctx: Context, config: Config): void {
  for (const feature of [
    { id: 'drift-monitoring', name: '跑偏提醒 / Drift reminders', description: '后台检查已完成步骤；只提醒一次，不打断执行 / Background, non-blocking reminders' },
    { id: 'completion-check', name: '完成核查 / Completion check', description: '回答展示后核查，普通请求最多补做一次 / Check submitted answers; at most one supplemental attempt' },
    { id: 'goal-supervision', name: '目标增强 / Goal supervision', description: '核查模型完成申请；连续无进展暂停原生目标 / Guard completion and pause stalled native goals' },
  ]) ctx.effect(() => ctx.jev.registerFeature(feature))
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), 'jev-supervision.settings')
  const states = new WeakMap<Agent, State>()
  const tasks = new Set<Promise<void>>()
  const assessments = new Map<string, Verdict>()
  const lifetime = new AbortController()
  ctx.effect(() => async () => { lifetime.abort(); await Promise.allSettled([...tasks]) })

  const live = (agent: Agent | undefined): agent is Agent => agent !== undefined && ctx.agents.get(agent.id) === agent && ctx.agents.roots().includes(agent)
  const enabled = (feature: Check) => ctx.jev.isFeatureEnabled(feature)
  const stateFor = (agent: Agent): State => {
    let state = states.get(agent)
    if (state === undefined) {
      state = { steps: 0, enabled: false, active: false, turn: -1, requestId: '', reminderScope: '', ownsGoalTurn: false, reminded: new Set(), pending: [], stalled: 0, goalRevision: '', lastRound: -1 }
      states.set(agent, state)
    }
    return state
  }
  const receipt = (id: string, action: string, status: 'observed' | 'executed' | 'not-adopted', reason?: string) =>
    ctx.jev.writeReceipt(id, { id: action, status, at: new Date().toISOString(), ...reason === undefined ? {} : { reason } })
  const notice = (state: State, operationId: string, action: string, text: string): UserMessage => createUserMessage({
    source: { kind: 'jev-supervision', form: 'notice', summary: text, requestId: state.requestId, action, operationId },
    content: [{ type: 'text', text }],
  })
  const pause = (agent: Agent) => {
    const goal = ctx.goals.get(agent)
    if (goal?.phase === 'active') ctx.agents.withInitiator(agent, () => ctx.goals.pause(agent, { id: goal.id, revision: goal.revision }))
  }
  const current = (agent: Agent, state: State, identity: string) =>
    live(agent) && state.active && !state.signal?.aborted && version(ctx, agent) === identity

  async function judge(agent: Agent, state: State, mode: 'completion' | 'progress', signal: AbortSignal, feature?: Check): Promise<JevJudgeResult> {
    let identity = ''
    let goalAtAttempt = ''
    let request: JevRequest
    const outcome = await ctx.jev.judge({
      featureId: feature ?? (mode === 'completion' && ctx.goals.get(agent)?.phase !== 'active' ? 'completion-check' : 'goal-supervision'),
      agent, signal, link: { sessionId: agent.session.id, inputVersion: state.requestId },
      refresh: () => { identity = version(ctx, agent); goalAtAttempt = goalIdentity(ctx.goals.get(agent)); request = evidence(ctx, agent, mode, config.evidenceChars.get(), state.requestId); return request },
      interpret: response => {
        const result = verdict(response, request)
        return result !== undefined && result.value !== 'unknown' ? { usable: true } : { usable: false, reason: 'Jev 无法判定 / Evidence is insufficient for this check' }
      },
      canAdopt: () => current(agent, state, identity) || 'Requirements, goal, or execution changed',
    })
    if (outcome.kind === 'ok') assessments.set(outcome.operationId, verdict(outcome.response, request!)!)
    if (outcome.kind === 'cancelled' && goalIdentity(ctx.goals.get(agent)) === goalAtAttempt) pause(agent)
    return outcome
  }

  async function usedSupplement(agent: Agent, requestId: string): Promise<boolean> {
    if (agent.session.deriveMessages().some(message => message.role === 'user' && message.source.kind === 'jev-supervision'
      && message.source.requestId === requestId && message.source.action === 'supplement')) return true
    let cursor: string | undefined
    do {
      const page = await ctx.jev.listRecords({ featureId: 'completion-check', sessionId: agent.session.id, limit: 100, ...cursor === undefined ? {} : { cursor } })
      for (const item of page.items) {
        const record = await ctx.jev.getRecord(item.id)
        if (record?.link.inputVersion === requestId && record.receipts.some(item => item.id === 'supplement-reserved')) return true
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return false
  }

  ctx.effect(() => ctx.jev.onFeatureStateChange(features => {
    for (const agent of ctx.agents.roots()) {
      const state = states.get(agent)
      if (state !== undefined && state.enabled !== (features['drift-monitoring'] === true)) {
        state.enabled = features['drift-monitoring'] === true
        state.steps = 0
      }
    }
  }))

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || !live(agent)) return decision
    const state = stateFor(agent)
    if (state.turn !== turn) {
      state.turn = turn
      state.requestId = messages.find(message => message.source.kind === 'user')?.id ?? (lastUser(agent) || messages[0]?.id || 'turn-' + turn)
      const goal = ctx.goals.get(agent)
      state.ownsGoalTurn = goal?.phase === 'active' || messages.some(message => message.source.kind === 'goal')
      const scope = goal?.phase === 'active' ? goalIdentity(goal) : state.requestId
      if (state.reminderScope !== scope) { state.reminderScope = scope; state.reminded.clear() }
    }
    state.active = true
    state.signal = signal
    const on = await enabled('drift-monitoring')
    if (on !== state.enabled) { state.enabled = on; state.steps = 0 }
    const identity = version(ctx, agent)
    const pending = state.pending.splice(0)
    const additions: UserMessage[] = []
    for (const item of pending) {
      if (!current(agent, state, item.version) || messages.some(message => message.source.kind === 'user') || state.reminded.has(item.verdict.issueKey)) {
        void receipt(item.outcome.operationId, 'drift-not-delivered', 'not-adopted', 'Task changed, stopped, or this issue was already delivered').catch(error => ctx.logger.warn(String(error)))
        continue
      }
      state.reminded.add(item.verdict.issueKey)
      additions.push(notice(state, item.outcome.operationId, 'drift', 'Jev 跑偏提醒 / Correction: ' + item.verdict.reason))
    }
    // The surrounding waterfall may still reject; delivery is acknowledged only by user/message.
    if (version(ctx, agent) !== identity) return decision
    return { ...decision, messages: [...decision.messages, ...additions] }
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || agent.session !== session || !live(agent)) return
    const state = stateFor(agent)
    if (event.type === 'turn/end') {
      state.active = false
      for (const item of state.pending.splice(0)) {
        const task = receipt(item.outcome.operationId, 'drift-not-delivered', 'not-adopted', 'Task ended before another model step').then(() => {}, error => ctx.logger.warn(String(error)))
        tasks.add(task); void task.finally(() => tasks.delete(task))
      }
      return
    }
    if (event.type === 'user/message' && event.data.source.kind === 'jev-supervision') {
      const source = event.data.source
      const task = receipt(source.operationId, source.action + '-delivered', 'executed', 'Message admitted to the session').then(() => {}, error => {
        ctx.logger.warn('Jev action receipt remains unconfirmed: ' + String(error))
      })
      tasks.add(task); void task.finally(() => tasks.delete(task))
      return
    }
    if (event.type !== 'step/end' || !state.active) return
    const task = (async () => {
      const on = await enabled('drift-monitoring')
      if (!state.active || state.signal?.aborted) return
      if (!on) { state.enabled = false; state.steps = 0; return }
      if (!state.enabled) { state.enabled = true; state.steps = 0 }
      if (++state.steps < config.driftInterval.get()) return
      state.steps = 0
      let identity = ''
      let request: JevRequest
      const outcome = await ctx.jev.judgeOnce({
        featureId: 'drift-monitoring', agent, signal: AbortSignal.any([lifetime.signal, ...state.signal === undefined ? [] : [state.signal]]),
        link: { sessionId: session.id, stepId: String(event.seq), inputVersion: state.requestId },
        refresh: () => { identity = version(ctx, agent); request = evidence(ctx, agent, 'drift', config.evidenceChars.get(), state.requestId); return request },
        interpret: response => { const result = verdict(response, request); return result !== undefined && result.value !== 'unknown' ? { usable: true } : { usable: false, reason: 'Drift is undetermined' } },
        canAdopt: () => current(agent, state, identity) || 'Task changed or ended; no wakeup',
      })
      if (outcome.kind !== 'ok') return
      const result = verdict(outcome.response, request!)!
      if (result.value === 'drift') {
        if (!current(agent, state, identity)) { await receipt(outcome.operationId, 'drift-not-delivered', 'not-adopted', 'Task ended'); return }
        state.pending.push({ outcome, verdict: result, version: identity })
      } else await receipt(outcome.operationId, 'on-track', 'observed')
    })().catch(error => { ctx.logger.warn('Jev background supervision failed without blocking: ' + String(error)) })
    tasks.add(task); void task.finally(() => tasks.delete(task))
  })

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (!live(agent) || signal.aborted || agent.inbox.nextStep.length > 0) return
    const state = stateFor(agent)
    const goal = ctx.goals.get(agent)
    if (goal?.phase === 'active') {
      if (!await enabled('goal-supervision')) return
      const revision = goalIdentity(goal)
      if (state.goalRevision !== revision) { state.goalRevision = revision; state.stalled = 0; state.lastRound = -1 }
      if (goal.roundsStarted === 0 || state.lastRound === goal.roundsStarted) return
      const result = await judge(agent, state, 'progress', signal)
      if (result.kind !== 'ok') return
      const assessment = assessments.get(result.operationId)!
    assessments.delete(result.operationId)
      state.lastRound = goal.roundsStarted
      if (assessment.value === 'progress') state.stalled = 0
      else if (assessment.value === 'no-progress') state.stalled++
      if (assessment.value === 'needs-user' || state.stalled >= config.noProgressRounds.get()) {
        pause(agent)
        agent.session.append('user/message', notice(state, result.operationId, 'goal-paused', 'Jev 已暂停目标 / Goal paused: ' + assessment.reason), { surfaceOp: 'append' })
        await receipt(result.operationId, 'goal-paused', 'executed', assessment.reason)
      } else await receipt(result.operationId, 'progress-checked', 'observed', assessment.reason)
      return
    }
    if (state.ownsGoalTurn || !await enabled('completion-check') || !state.requestId) return
    const result = await judge(agent, state, 'completion', signal)
    if (result.kind !== 'ok') return
    const assessment = assessments.get(result.operationId)!
    assessments.delete(result.operationId)
    if (assessment.value === 'complete') { await receipt(result.operationId, 'completion-checked', 'observed', 'Requirements supported by recorded evidence; not an independent test run'); return }
    const identity = version(ctx, agent)
    if (assessment.value === 'omission' && !await usedSupplement(agent, state.requestId)) {
      if (signal.aborted || version(ctx, agent) !== identity || [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message => message.source.kind === 'user')) return
      await receipt(result.operationId, 'supplement-reserved', 'observed', 'One supplemental attempt reserved for this original request')
      if (signal.aborted || version(ctx, agent) !== identity) { await receipt(result.operationId, 'supplement-stale', 'not-adopted', 'Requirements changed after reservation'); return }
      agent.steer(notice(state, result.operationId, 'supplement', 'Jev 发现遗漏；本请求仅自动补做一次 / Complete these omissions once: ' + assessment.reason))
      await receipt(result.operationId, 'supplement-queued', 'executed', 'Supplement queued; completion remains unverified').catch(error => {
        ctx.logger.warn('Jev supplement is already queued; its action receipt remains unconfirmed: ' + String(error))
      })
    } else {
      agent.session.append('user/message', notice(state, result.operationId, 'completion-stopped', 'Jev 停止自动补做 / No further automatic work: ' + assessment.reason), { surfaceOp: 'append' })
      await receipt(result.operationId, 'completion-stopped', 'observed', assessment.reason)
    }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || exec.name !== 'update_goal' || !live(exec.agent!)) return decision
    const args = exec.arguments
    if (typeof args !== 'object' || args === null || !('action' in args) || args.action !== 'complete' || !await enabled('goal-supervision')) return decision
    const agent = exec.agent!
    const goal = ctx.goals.get(agent)
    if (goal === undefined || goal.phase === 'complete') return decision
    const identity = goalIdentity(goal)
    const result = await judge(agent, stateFor(agent), 'completion', exec.signal, 'goal-supervision')
    if (result.kind !== 'ok') return { kind: 'deny', reason: 'Jev completion check was cancelled or became stale.' }
    if (goalIdentity(ctx.goals.get(agent)) !== identity) {
      await receipt(result.operationId, 'goal-complete-stale', 'not-adopted', 'Goal revision changed')
      return { kind: 'deny', reason: 'Goal changed during completion check.' }
    }
    const assessment = assessments.get(result.operationId)!
    assessments.delete(result.operationId)
    if (assessment.value === 'complete') {
      await receipt(result.operationId, 'goal-complete-allowed', 'observed', 'Evidence check passed; native goal tool still owns authorization and mutation')
      return decision
    }
    if (assessment.value === 'needs-user') pause(agent)
    await receipt(result.operationId, 'goal-complete-denied', 'observed', assessment.reason)
    return { kind: 'deny', reason: 'Jev: ' + assessment.reason }
  }, { prepend: true })
}

export const name = 'jev-supervision'
export const inject = ['jev', 'agents', 'tools', 'goals', 'sessions', 'settings']
