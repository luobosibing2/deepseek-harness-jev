/** Goal-level webpage execution through the Host's existing Native Cua tools. */
import { randomUUID } from 'node:crypto'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-app-boot'
import { JevError } from './index.ts'
import { actionResultSchema, buildWebCandidates, NATIVE_PREFIX, observationSchema, pageFingerprint, selectedWebCandidate,
  WEB_FEATURE, webInputSchema, webRequest, type WebObservation, type WebInput, type WebLimits, type WebStop, type WebStep } from './web-model.ts'
import { WebRunStore, type WebRun } from './web-store.ts'

export const name = 'jev-native-web-execution'
export const inject = ['jev', 'tools', 'agents', 'settings', 'storageDomain', 'profileContext']
export type Config = { [K in keyof WebLimits]: Volatile<number> }
const count = (value: number, max: number) => s.number().step(1).min(1).max(max).default(value).volatile()
export const Config: s<WebLimits, Config> = s.object({
  maxRounds: count(20, 1000), noProgressRounds: count(3, 1000), maxCandidates: count(80, 1000), maxObserveRounds: count(3, 1000), maxScrollCandidates: count(2, 1000),
  historySteps: count(8, 100), evidenceChars: count(16000, 1000000), scrollPixels: count(600, 10000), resultSteps: count(5, 100),
})

const nativeEnvelope = z.object({ structuredContent: z.json().optional(), isError: z.boolean().optional() })
const nativeStatus = z.object({ status: z.string(), refusal: z.object({ code: z.string(), message: z.string() }).optional() })
const bindInput = z.object({ session: z.string().trim().min(1), pid: z.number().int().positive(), window_id: z.number().int().nonnegative() })
const boundPage = z.object({ status: z.literal('ok'), mode: z.literal('bind'), target_id: z.string().min(1),
  tabs: z.array(z.object({ tab_id: z.string().min(1), url: z.string().optional(), title: z.string().optional() })) })

class Stop extends Error {
  constructor(readonly status: WebStop, message: string, readonly handoffReason?: string) { super(message) }
}

function limitsOf(config: Config): WebLimits {
  return { maxRounds: config.maxRounds.get(), noProgressRounds: config.noProgressRounds.get(), maxCandidates: config.maxCandidates.get(),
    maxObserveRounds: config.maxObserveRounds.get(), maxScrollCandidates: config.maxScrollCandidates.get(),
    historySteps: config.historySteps.get(), evidenceChars: config.evidenceChars.get(), scrollPixels: config.scrollPixels.get(), resultSteps: config.resultSteps.get() }
}

/** Canonical structuredContent carries Cua refusals even when isError is false. */
function nativeValue(result: ToolExecutionResult): z.infer<ReturnType<typeof z.json>> {
  const parsed = nativeEnvelope.safeParse(result.value)
  if (result.isError || !parsed.success || parsed.data.isError || parsed.data.structuredContent === undefined) {
    throw new Stop('unconfirmed', 'Native did not return a confirmed structured outcome. Inspect the page before retrying.')
  }
  return parsed.data.structuredContent
}

function overview(run: WebRun) {
  const page = run.observation
  const needs = run.steps.at(-1)?.candidate?.needs
  return {
    run_id: run.id, status: run.status, reason: run.reason, goal: run.input.goal, rounds: run.rounds, limits: run.limits, metrics: run.metrics ?? null, candidate_coverage: run.candidateStats ?? null, handoff_reason: run.handoffReason ?? null,
    action_count: run.steps.filter(step => step.status === 'executed').length,
    evidence: page === undefined ? null : { ...page.page, snapshot_id: page.snapshot.id,
      outline: page.outline.slice(0, run.limits.evidenceChars), omitted_outline_chars: Math.max(0, page.outline.length - run.limits.evidenceChars),
      coverage: page.snapshot },
    steps: run.steps.slice(-run.limits.resultSteps).map(({ observation: _observation, ...step }) => step),
    omitted_steps: Math.max(0, run.steps.length - run.limits.resultSteps),
    retrieval: { tool: 'jev_web_history', run_id: run.id },
    handoff: ['needs-main-agent', 'no-progress', 'budget', 'unsupported', 'unconfirmed', 'action-failed', 'missing-input'].includes(run.status) && page !== undefined ? {
      to: 'main-agent',
      browser: { session: run.input.session, target_id: run.input.target_id, tab_id: run.input.tab_id },
      input_route: run.input.input_route,
      instruction: 'Decide the next action and continue with Native CUA within the existing task authorization. Inspect prior executed and uncertain steps to avoid repetition. Do not call Jev again with unchanged evidence and candidates. Use jev_web_observe for fresh model-visible refs or scoped evidence, then act with Native CUA. These elements belong to the returned snapshot; after another observation, use its new refs. Full observation is available through jev_web_history.',
      elements: page.refs.slice(0, run.limits.maxCandidates), omitted_elements: Math.max(0, page.refs.length - run.limits.maxCandidates),
    } : null,
    missing_fields: run.status === 'missing-input' ? needs ? [needs]
      : (page?.refs ?? []).filter(ref => ref.actions.includes('type')).map(ref => ({ ref: ref.ref, name: ref.name, role: ref.role })) : [],
    completion_verified: false,
  }
}

/** Mount only plugin-owned tools, records, settings and cancellation. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const lifetime = new AbortController()
  const active = new Map<Promise<unknown>, { sessionId: string; controller: AbortController }>()
  ctx.on('internal/plugin', fiber => { if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort() }, { global: true })
  const store = await WebRunStore.open(ctx.storageDomain, ctx.profileContext.dir)
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...active.keys()])
    await store.close()
  }, 'jev-web.runs')
  lifetime.signal.throwIfAborted()
  ctx.effect(() => ctx.jev.registerFeature({ id: WEB_FEATURE, name: 'Native 网页目标执行 / Native web goals',
    description: '在已交接网页上按目标选择并执行，缺少内容或能力时交回主代理。 / Execute a goal in an existing Native browser tab; return missing inputs or capabilities to the main Agent.' }))
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), 'jev-web.settings')
  ctx.on('agent/disposed', ({ agent }) => {
    for (const { sessionId, controller } of active.values()) if (sessionId === agent.session.id) controller.abort()
  })

  const live = (exec: ToolRunContext) => exec.agent !== undefined && ctx.agents.get(exec.agent.id) === exec.agent && ctx.agents.roots().includes(exec.agent)
  const available = (exec: ToolRunContext) => new Set(['browser_click', 'browser_type', 'browser_pointer']
    .filter(tool => ctx.tools.get(NATIVE_PREFIX + tool, exec.agent) !== undefined))

  async function owned<T>(exec: ToolRunContext, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const signal = AbortSignal.any([exec.signal, lifetime.signal, controller.signal])
    const task = run(signal)
    active.set(task, { sessionId: exec.agent?.session.id ?? '', controller })
    try { return await task } finally { active.delete(task) }
  }

  async function execute(input: WebInput, exec: ToolRunContext, signal: AbortSignal) {
    const agent = exec.agent
    if (!live(exec) || agent === undefined) return { status: 'unsupported', reason: 'Requires a live Web root Agent.' }
    if (!ctx.jev.isFeatureEnabled(WEB_FEATURE)) return { status: 'disabled', reason: 'Enable Native web goals in Jev settings.' }
    if (ctx.tools.get(NATIVE_PREFIX + 'get_browser_state', agent) === undefined) {
      return { status: 'unsupported', reason: 'DSH Native get_browser_state is unavailable; the existing provider was not changed.' }
    }
    const limits = limitsOf(config)
    const at = new Date().toISOString()
    const run: WebRun = { id: randomUUID(), sessionId: agent.session.id, callId: exec.callId, startedAt: at, updatedAt: at,
      input, limits, status: 'running', reason: '', rounds: 0, steps: [],
      metrics: { observe: { calls: 0, milliseconds: 0 }, action: { calls: 0, milliseconds: 0 }, judgmentWait: { calls: 0, milliseconds: 0 } } }
    await store.save(run)
    let dispatch = 0
    let unchanged = 0
    let fingerprint: string | undefined
    let ledgerFailed = false
    const pending = new Set<Promise<unknown>>()
    const track = <T>(task: Promise<T>): Promise<T> => {
      pending.add(task)
      void task.then(() => pending.delete(task), () => pending.delete(task))
      return task
    }
    const save = async () => {
      try { await store.save(run) } catch (error) { ledgerFailed = true; throw error }
    }
    const callNative = (tool: string, args: Record<string, unknown>, callSignal: AbortSignal) => track((async () => {
      const metric = tool === 'get_browser_state' ? run.metrics!.observe : run.metrics!.action
      metric.calls++
      const started = performance.now()
      try {
        return await ctx.tools.execute({ name: NATIVE_PREFIX + tool, arguments: args, agent, signal: callSignal,
          callId: ToolCallId(`${exec.callId}:jev-web:${++dispatch}`), rootCallId: exec.rootCallId, parent: exec.token })
      } finally { metric.milliseconds += performance.now() - started }
    })())
    const observe = async (callSignal: AbortSignal) => {
      callSignal.throwIfAborted()
      const raw = nativeValue(await callNative('get_browser_state', {
        session: input.session, target_id: input.target_id, tab_id: input.tab_id, snapshot_format: 'semantic_v2', include_screenshot: false,
      }, callSignal))
      callSignal.throwIfAborted()
      const status = nativeStatus.safeParse(raw)
      if (status.success && status.data.status === 'refused') throw new Stop('unsupported', status.data.refusal?.message ?? 'Native refused the page observation.')
      const parsed = observationSchema.safeParse(raw)
      if (!parsed.success) throw new Stop('unsupported', 'Native did not return the supported semantic_v2 page observation.')
      const page = parsed.data
      if (page.target_id !== input.target_id || page.tab_id !== input.tab_id) throw new Stop('unsupported', 'Native returned a different page; no action was issued.')
      run.observation = page
      await save()
      return page
    }
    const receipt = async (step: WebStep, status: 'executed' | 'execution-failed' | 'not-adopted' | 'observed') => {
      if (step.operationId === undefined) return
      await ctx.jev.writeReceipt(step.operationId, { id: run.id + ':' + step.round + ':' + status,
        status, at: new Date().toISOString(), reason: `${step.candidate?.description ?? ''}; trace: jev_web_history run_id=${run.id}` })
    }

    let readyObservation: WebObservation | undefined
    let consecutiveObserve = 0
    try {
      while (run.status === 'running') {
        signal.throwIfAborted()
        if (!live(exec)) throw new Stop('cancelled', 'The invoking Agent is no longer live.')
        if (!ctx.jev.isFeatureEnabled(WEB_FEATURE)) throw new Stop('disabled', 'Feature disabled; no further judgment was started.')
        let space: ReturnType<typeof buildWebCandidates> | undefined
        const prepare = async (attemptSignal: AbortSignal) => {
          if (run.rounds >= limits.maxRounds) throw new Stop('budget', 'Automatic decision round budget exhausted.', 'decision-budget')
          run.rounds++
          const page = readyObservation ?? await observe(attemptSignal)
          readyObservation = undefined
          const current = pageFingerprint(page)
          unchanged = current === fingerprint ? unchanged + 1 : 0
          fingerprint = current
          if (unchanged >= limits.noProgressRounds) throw new Stop('no-progress', 'Consecutive observations show no semantic page progress.', 'no-progress')
          space = buildWebCandidates(input, page, limits, available(exec), run.steps)
          run.candidateStats = space.stats
          if (space.stats.selected === 0 && !page.refs.some(ref => ref.states.busy === true) && !space.candidates.some(candidate => candidate.needs !== undefined) && !run.steps.some(step => step.status === 'executed')) {
            const reason = page.page.url === 'about:blank' ? 'page-not-ready'
              : !page.snapshot.complete ? 'observation-incomplete'
              : space.stats.unnamed > 0 ? 'insufficient-target-information' : 'no-supported-action'
            throw new Stop('needs-main-agent', 'No identifiable executable target in this observation. Use Native navigation or jev_web_observe to establish the required page evidence before another selection.', reason)
          }
          await save()
          return webRequest(input, page, space, run.steps, limits)
        }
        const firstRequest = await prepare(signal)
        let firstAttempt = true
        const judgmentStarted = performance.now()
        run.metrics!.judgmentWait.calls++
        const outcome = await ctx.jev.judge({ featureId: WEB_FEATURE, agent, signal,
          link: { sessionId: agent.session.id, runId: run.id, stepId: String(run.steps.length + 1) },
          refresh: attemptSignal => track((async () => {
            if (firstAttempt) { firstAttempt = false; return firstRequest }
            return prepare(attemptSignal)
          })()),
          interpret: response => {
            const choice = selectedWebCandidate(response, space?.candidates ?? [])
            return choice !== undefined ? { usable: true }
              : { usable: false, reason: 'Jev returned no valid candidate for the current webpage; retry with fresh evidence or cancel.' }
          },
          canAdopt: () => live(exec) ? true : 'The invoking Agent is no longer live.',
        }).finally(() => { run.metrics!.judgmentWait.milliseconds += performance.now() - judgmentStarted })
        signal.throwIfAborted()
        if (outcome.kind === 'cancelled') throw new Stop('cancelled', 'The judgment was cancelled.')
        if (outcome.kind === 'not-adopted') throw new Stop('cancelled', outcome.reason)
        const candidate = selectedWebCandidate(outcome.response, space?.candidates ?? [])
        if (candidate === undefined || run.observation === undefined) throw new Stop('failed', 'The judgment has no current action table.')
        const step: WebStep = { round: run.rounds, at: new Date().toISOString(), observation: run.observation,
          operationId: outcome.operationId, attemptId: outcome.attemptId, candidate, candidateStats: space?.stats, status: 'selected' }
        run.steps.push(step)
        await save()
        if (candidate.kind !== 'action') {
          step.status = 'observed'
          await save()
          await receipt(step, 'observed')
          if (candidate.kind === 'observe') {
            consecutiveObserve++
            if (consecutiveObserve >= limits.maxObserveRounds) throw new Stop('needs-main-agent', 'Consecutive reobservation limit reached; main Agent must assess the page.', 'observe-budget')
            continue
          }
          if (candidate.kind === 'unknown') throw new Stop('needs-main-agent', candidate.description, 'decision-undetermined')
          throw new Stop(candidate.kind === 'finish' ? 'completion-suggested' : candidate.kind === 'missing-input' ? 'missing-input' : 'unsupported', candidate.description)
        }
        if (candidate.tool === undefined || candidate.arguments === undefined) throw new Stop('failed', 'Executable candidate lacks Native arguments.')
        signal.throwIfAborted()
        consecutiveObserve = 0
        step.status = 'executing'
        await save()
        const result = await callNative(candidate.tool, candidate.arguments, signal)
        step.result = z.json().parse(result.value ?? { isError: result.isError, error: result.error?.message ?? 'No canonical Native value' })
        const value = nativeValue(result)
        const action = actionResultSchema.safeParse(value)
        if (!action.success) throw new Stop('unconfirmed', 'Native did not return its public ActionResult; inspect the page before retrying.')
        if (action.data.effect === 'refused') {
          step.status = 'failed'
          await save()
          await receipt(step, 'execution-failed')
          throw new Stop('action-failed', 'Native refused the action. ' + JSON.stringify(action.data.escalation ?? {}) + '; return to the main Agent without changing route.')
        }
        if (action.data.effect === 'partial' || action.data.effect === 'suspected_noop' || action.data.delivery?.mode !== 'background') {
          throw new Stop('unconfirmed', 'Native delivery is partial, uncertain, or not background; no action was repeated. Inspect the page.')
        }
        if (candidate.tool === 'browser_type' && action.data.delivery.delivered_count !== Array.from(String(candidate.arguments.text)).length) {
          throw new Stop('unconfirmed', 'Native did not acknowledge all requested text; do not repeat typing automatically.')
        }
        step.status = 'executed'
        step.verification = 'unverified'
        await save()
        await receipt(step, 'executed')
        const after = await observe(signal)
        readyObservation = after
        if (candidate.tool === 'browser_type') {
          const before = step.observation.refs.find(ref => ref.ref === candidate.arguments?.ref)
          const fields = before === undefined ? [] : after.refs.filter(ref => ref.role === before.role && ref.name === before.name && ref.frame === before.frame)
          if (fields.length !== 1 || fields[0].value !== candidate.arguments.text) {
            throw new Stop('unconfirmed', 'Input was delivered, but a fresh observation does not uniquely confirm the requested field value. No typing was repeated.')
          }
          step.verification = 'value-readback'
          await save()
        }
      }
    } catch (error) {
      // Jev cancels its wait promptly; owned Native reads and their callbacks must settle before closing the trace.
      await Promise.allSettled([...pending])
      const pendingStep = run.steps.at(-1)
      if (pendingStep?.status === 'executing') pendingStep.status = 'unconfirmed'
      run.status = signal.aborted ? 'cancelled' : error instanceof Stop ? error.status
        : error instanceof JevError && error.code === 'FEATURE_DISABLED' ? 'disabled'
        : error instanceof JevError && error.code === 'RECEIPT_NOT_SAVED' ? 'unconfirmed' : 'failed'
      run.handoffReason = error instanceof Stop ? error.handoffReason : undefined
      run.reason = signal.aborted ? 'Cancelled; already delivered input is not rolled back.'
        : error instanceof Stop || error instanceof JevError ? error.message : 'Web execution stopped after an internal or storage failure.'
      if (ledgerFailed) {
        run.status = pendingStep?.status === 'unconfirmed' || pendingStep?.status === 'executed' ? 'unconfirmed' : 'failed'
        run.reason = 'Trace persistence failed; no further action was issued. Inspect existing records and page state before retrying.'
      } else {
        try { await store.save(run) }
        catch (saveError) {
          run.status = 'unconfirmed'
          run.reason = 'Final trace could not be saved; previous durable entries remain available. Do not replay actions.'
          ctx.logger.warn('Jev web final trace write failed: %s', saveError instanceof Error ? saveError.name : 'failure')
        }
      }
    }
    return overview(run)
  }

  ctx.tools.register(defineTool({
    name: 'jev_web_bind',
    description: 'Bind a prepared Native browser window and return its exact target_id and tab IDs in readable JSON. Use this before jev_web_goal; choose the intended tab from the returned titles and URLs. Does not launch a browser, navigate, or call Jev.',
    parameters: {
      session: { type: 'string', required: true, description: 'Cua session used to prepare this browser; repeat it on subsequent Native and Jev web calls.' },
      pid: { type: 'integer', required: true, description: 'Prepared browser process ID from Native browser_prepare, not the executable anchor PID used to launch it.' },
      window_id: { type: 'integer', required: true, description: 'Actual browser window owned by pid, obtained from Native list_windows.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const input = bindInput.parse(args)
      return owned(exec, async (signal): Promise<z.infer<ReturnType<typeof z.json>>> => {
        if (!live(exec)) return { status: 'unsupported', reason: 'Requires a live Web root Agent.' }
        if (!ctx.jev.isFeatureEnabled(WEB_FEATURE)) return { status: 'disabled', reason: 'Enable Native web goals in Jev settings.' }
        if (ctx.tools.get(NATIVE_PREFIX + 'get_browser_state', exec.agent) === undefined) {
          return { status: 'unsupported', reason: 'DSH Native get_browser_state is unavailable.' }
        }
        signal.throwIfAborted()
        const result = await ctx.tools.execute({ name: NATIVE_PREFIX + 'get_browser_state',
          arguments: { ...input, include_screenshot: false, snapshot_format: 'semantic_v2' }, agent: exec.agent, signal,
          callId: ToolCallId(`${exec.callId}:jev-web:bind`), rootCallId: exec.rootCallId, parent: exec.token })
        signal.throwIfAborted()
        const raw = nativeValue(result)
        const status = nativeStatus.safeParse(raw)
        if (status.success && status.data.status === 'refused') {
          return { status: 'unsupported', reason: status.data.refusal?.message ?? 'Native refused the window binding.', refusal: status.data.refusal ?? null }
        }
        const parsed = boundPage.safeParse(raw)
        if (!parsed.success) return { status: 'unsupported', reason: 'Native did not return a browser binding with explicit tab IDs. No page was selected.' }
        return { status: 'ok', session: input.session, pid: input.pid, window_id: input.window_id, target_id: parsed.data.target_id,
          tabs: parsed.data.tabs.map(tab => ({ tab_id: tab.tab_id, title: tab.title ?? null, url: tab.url ?? null })) }
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'jev_web_observe',
    description: 'Read the handed-off Native tab and return semantic_v2 refs and page evidence in model-visible JSON, without Jev. Use these refs with Native actions. Every fresh read replaces previous refs for this tab. Optional query/scope_ref/continuation request Native scope; never combine refs from different snapshots. To retrieve full evidence without another Native read, pass only observation_id and character offset/limit; this is historical evidence, not a freshness guarantee.',
    parameters: {
      session: { type: 'string', description: 'Existing Cua session; required for a fresh observation.' },
      target_id: { type: 'string', description: 'Exact existing Native target; required for a fresh observation.' },
      tab_id: { type: 'string', description: 'Exact handed-off tab; required for a fresh observation.' },
      query: { type: 'string', description: 'Optional Native semantic search query.' },
      scope_ref: { type: 'string', description: 'Optional current Native scope reference.' },
      continuation: { type: 'string', description: 'Optional Native continuation token; returned refs belong only to the new snapshot.' },
      observation_id: { type: 'string', description: 'Saved observation ID returned by this tool; omit for a fresh read.' },
      offset: { type: 'integer', description: 'Saved JSON character offset; default 0.' },
      limit: { type: 'integer', description: 'Saved JSON character limit; default 12000, maximum 20000.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const parsed = z.object({
        session: z.string().trim().min(1).optional(), target_id: z.string().trim().min(1).optional(), tab_id: z.string().trim().min(1).optional(),
        query: z.string().optional(), scope_ref: z.string().min(1).optional(), continuation: z.string().min(1).optional(),
        observation_id: z.string().min(1).optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(20000).default(12000),
      }).parse(args)
      return owned(exec, async (signal): Promise<z.infer<ReturnType<typeof z.json>>> => {
        if (!live(exec) || exec.agent === undefined) return { status: 'unsupported', reason: 'Requires a live Web root Agent.' }
        if (!ctx.jev.isFeatureEnabled(WEB_FEATURE)) return { status: 'disabled', reason: 'Enable Native web goals in Jev settings.' }
        if (parsed.observation_id !== undefined) {
          if (parsed.session !== undefined || parsed.target_id !== undefined || parsed.tab_id !== undefined || parsed.query !== undefined || parsed.scope_ref !== undefined || parsed.continuation !== undefined) throw new Error('Saved evidence retrieval accepts only observation_id, offset and limit.')
          const saved = store.getObservation(parsed.observation_id)
          if (!saved || saved.sessionId !== exec.agent.session.id) throw new Error('Observation not found in this Agent session')
          const json = JSON.stringify(saved)
          return { status: 'saved-evidence', observation_id: saved.id, snapshot_id: saved.observation.snapshot.id, observed_at: saved.observedAt,
            freshness: 'Historical evidence; any subsequent Native observation or page action can invalidate these refs.',
            json: json.slice(parsed.offset, parsed.offset + parsed.limit), offset: parsed.offset, total_chars: json.length,
            next_offset: parsed.offset + parsed.limit < json.length ? parsed.offset + parsed.limit : null }
        }
        if (!parsed.session || !parsed.target_id || !parsed.tab_id) throw new Error('Fresh observation requires session, target_id and tab_id.')
        if (args.offset !== undefined || args.limit !== undefined) throw new Error('offset and limit apply only to saved observation_id retrieval.')
        if (ctx.tools.get(NATIVE_PREFIX + 'get_browser_state', exec.agent) === undefined) return { status: 'unsupported', reason: 'DSH Native get_browser_state is unavailable.' }
        const scope = { ...(parsed.query !== undefined ? { query: parsed.query } : {}),
          ...(parsed.scope_ref !== undefined ? { scope_ref: parsed.scope_ref } : {}), ...(parsed.continuation !== undefined ? { continuation: parsed.continuation } : {}) }
        signal.throwIfAborted()
        const raw = nativeValue(await ctx.tools.execute({ name: NATIVE_PREFIX + 'get_browser_state',
          arguments: { session: parsed.session, target_id: parsed.target_id, tab_id: parsed.tab_id, ...scope, snapshot_format: 'semantic_v2', include_screenshot: false },
          agent: exec.agent, signal, callId: ToolCallId(`${exec.callId}:jev-web:observe`), rootCallId: exec.rootCallId, parent: exec.token }))
        signal.throwIfAborted()
        const status = nativeStatus.safeParse(raw)
        if (status.success && status.data.status === 'refused') return { status: 'unsupported', reason: status.data.refusal?.message ?? 'Native refused the observation.', refusal: status.data.refusal ?? null }
        const result = observationSchema.safeParse(raw)
        if (!result.success) return { status: 'unsupported', reason: 'Native did not return a supported semantic_v2 observation.' }
        const page = result.data
        if (page.target_id !== parsed.target_id || page.tab_id !== parsed.tab_id) return { status: 'unsupported', reason: 'Native returned a different page; its refs were not adopted.' }
        const id = randomUUID(), observedAt = new Date().toISOString(), limits = limitsOf(config)
        await store.saveObservation({ id, sessionId: exec.agent.session.id, observedAt, session: parsed.session, scope, observation: page })
        return { status: 'ok', observation_id: id, observed_at: observedAt,
          browser: { session: parsed.session, target_id: page.target_id, tab_id: page.tab_id }, scope, snapshot: page.snapshot, page: page.page,
          outline: page.outline.slice(0, limits.evidenceChars), omitted_outline_chars: Math.max(0, page.outline.length - limits.evidenceChars),
          elements: page.refs.slice(0, limits.maxCandidates), omitted_elements: Math.max(0, page.refs.length - limits.maxCandidates),
          retrieval: { tool: 'jev_web_observe', observation_id: id },
          instruction: 'Use refs only from this snapshot. Saved pagination does not read Native again or make old refs current. Use query/scope_ref/continuation for a new scoped observation when needed.' }
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'jev_web_goal',
    description: 'Pursue a webpage goal in a Native Cua tab identified by jev_web_bind. Returns evidence and a trace. For a handoff, use jev_web_observe when fresh refs are needed and continue with Native CUA. Do not repeatedly call this tool on unchanged evidence after it cannot choose. Service failures still require human Retry/Cancel. Supply missing text yourself; inspect the stop reason before claiming completion.',
    parameters: {
      goal: { type: 'string', required: true, description: 'Goal and success criteria for this task.' },
      session: { type: 'string', required: true, description: 'Existing explicit Cua session; not a DSH Session id.' },
      target_id: { type: 'string', required: true, description: 'Exact target_id returned by jev_web_bind.' },
      tab_id: { type: 'string', required: true, description: 'Exact intended tabs[].tab_id returned by jev_web_bind; never a CDP id, guessed id, or placeholder.' },
      constraints: { type: 'string', description: 'Task-specific limits or actions that must not occur.' },
      texts: { type: 'array', description: 'Caller-supplied literal values with semantic field labels; omit for tasks without typing.',
        items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string', required: true }, text: { type: 'string', required: true } } } },
      input_route: { type: 'string', enum: ['trusted', 'dom_event'], description: 'Default trusted. dom_event explicitly authorizes synthetic background click/scroll; no automatic route fallback.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const input = webInputSchema.parse(args)
      return owned(exec, signal => execute(input, exec, signal))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'jev_web_history',
    description: 'Read this Agent session’s durable webpage runs, including cancelled or interrupted runs. Omit run_id to list runs; with run_id, read the JSON record in character pages.',
    parameters: {
      run_id: { type: 'string' }, offset: { type: 'integer', description: 'Zero-based run-list offset or JSON character offset; default 0.' },
      limit: { type: 'integer', description: 'Default 10 runs (maximum 100), or 12000 JSON characters (maximum 20000).' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec): Promise<z.infer<ReturnType<typeof z.json>>> {
      if (!live(exec) || exec.agent === undefined) throw new Error('Requires a live root Agent')
      if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) throw new Error('offset must be a nonnegative integer')
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 20000)) throw new Error('limit must be an integer from 1 to 20000')
      const offset = args.offset ?? 0
      if (args.run_id === undefined) {
        const all = store.list(exec.agent.session.id)
        const limit = Math.min(args.limit ?? 10, 100)
        return { runs: all.slice(offset, offset + limit).map(run => ({ run_id: run.id, call_id: run.callId, status: run.status,
          reason: run.reason, goal: run.input.goal, started_at: run.startedAt, steps: run.steps.length })), total: all.length,
          next_offset: offset + limit < all.length ? offset + limit : null }
      }
      const run = store.get(args.run_id)
      if (run === undefined || run.sessionId !== exec.agent.session.id) throw new Error('Run not found in this Agent session')
      const serialized = JSON.stringify(run)
      const limit = args.limit ?? 12000
      return { run_id: run.id, status: run.status, json: serialized.slice(offset, offset + limit), offset,
        total_chars: serialized.length, next_offset: offset + limit < serialized.length ? offset + limit : null }
    },
  }))
}
