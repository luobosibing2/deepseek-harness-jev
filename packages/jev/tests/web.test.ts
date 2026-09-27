/** Native webpage goals through the actual tool registry, Jev HTTP adapter and durable storage. */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LlmRuntime, { ToolCallId, LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JevService, { JevError } from '../src/index.ts'
import * as web from '../src/web.ts'
import { buildWebCandidates, fieldState, webRequest, observationSchema, pageFingerprint, webInputSchema, WEB_FEATURE, type WebObservation, type WebLimits } from '../src/web-model.ts'
import { WebRunStore, webRunSchema, type WebRun } from '../src/web-store.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks() })
const limits: WebLimits = { maxRounds: 20, noProgressRounds: 3, maxCandidates: 80, maxObserveRounds: 3, maxScrollCandidates: 2, historySteps: 8, evidenceChars: 16000, scrollPixels: 600, resultSteps: 5 }
const input = webInputSchema.parse({ goal: 'Fill the verification value and submit', session: 'cua-session', target_id: 'bt-test', tab_id: 'tab-test', texts: [{ label: 'verification value', text: 'hello' }] })
const ref = (id: string, name: string, actions: string[], value: string | null = null) => ({
  ref: id, name, role: actions.includes('type') ? 'textbox' : 'button', actions, value, states: {}, visibility: 'in_viewport', frame: 'main',
})
function page(version = 1, value = '', submitted = false): WebObservation {
  return { status: 'ok', mode: 'snapshot', target_id: input.target_id, tab_id: input.tab_id,
    snapshot: { id: `p${version}`, format: 'semantic_v2', complete: true, selected_nodes: 2, total_nodes: 2, omitted: {}, continuation: null },
    page: { url: 'http://fixture.test/form', title: 'Verification' }, outline: submitted ? 'Submitted hello' : `Verification value: ${value}; Submit`,
    refs: submitted ? [] : [ref(`p${version}:1`, 'verification value', ['type'], value), ref(`p${version}:2`, 'Submit', ['click'])] }
}
type Wire = { state: { outline: string; goal: string; snapshot: { id: string }; recentSteps: object[] }; questions: Record<string, { criteria: Record<string, string> }> }

async function setup(options: {
  reply?: (wire: Wire, index: number) => object | Promise<object>
  enabled?: boolean; config?: Partial<WebLimits>; unavailable?: boolean
  loop?: boolean
  bind?: (signal: AbortSignal) => object | Promise<object>
  observe?: (snapshot: WebObservation, signal: AbortSignal) => Promise<WebObservation>
  action?: (name: string, args: Record<string, unknown>) => object | undefined | Promise<object | undefined>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jev-web-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const wires: Wire[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const wire = JSON.parse(Buffer.concat(chunks).toString()) as Wire
    wires.push(wire)
    const criteria = wire.questions.next.criteria
    const id = wire.state.outline.startsWith('Submitted') ? 'finish'
      : Object.entries(criteria).find(([, text]) => wire.state.outline.includes('hello') ? text.startsWith('Click ') : text.startsWith('Replace '))?.[0] ?? 'missing-input'
    const result = options.reply ? await options.reply(wire, wires.length) : { answers: { next: { choice: id } } }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture port unavailable')
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const ctx = new Context()
  if (options.loop) await mountAgentLoopTestDependencies(ctx)
  else for (const plugin of [LlmRuntime, AgentRegistry, SessionStore, SystemPrompt, ToolRuntime]) await ctx.plugin(plugin)
  await ctx.plugin(Storage)
  await ctx.plugin(UserQuestions)
  const backend = new JsonStorageBackend(join(root, 'storage'))
  const unregister = ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.provide('storageDomain', facility)
  ctx.provide('profileContext', { dir: join(root, 'profile') } as never)
  ctx.provide('settings', { configure: () => () => {} } as never)
  ctx.provide('credentials', { resolve: async () => ({ value: 'local-dummy' }), describe: async () => ({ configured: true, writable: true }) } as never)
  const common = await ctx.plugin(JevService, { baseUrl: `http://127.0.0.1:${address.port}/v1/systemone`, model: 'local-test',
    credentialRef: 'JEV_TEST_KEY', timeoutMs: 10000, features: { [WEB_FEATURE]: options.enabled ?? true } })
  let value = '', submitted = false, version = 0
  const calls: { name: string; args: Record<string, unknown>; parent: boolean; root: string }[] = []
  if (!options.unavailable) for (const name of ['get_browser_state', 'browser_type', 'browser_click', 'browser_pointer']) {
    ctx.tools.register(defineTool({ name: 'cua_driver_native__' + name, description: 'Deterministic Native fixture ' + name, parameters: {},
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'bound target bt-test (exact) with 1 tab(s)' }] },
      async execute(args, execution) {
        const actual = execution.arguments as Record<string, unknown>
        calls.push({ name, args: actual, parent: execution.parent !== undefined, root: execution.rootCallId })
        if (name === 'get_browser_state') {
          if (actual.pid !== undefined) return { structuredContent: options.bind ? await options.bind(execution.signal)
            : { status: 'ok', mode: 'bind', target_id: input.target_id, tabs: [{ tab_id: input.tab_id, title: 'Verification', url: 'http://fixture.test/form' }] } }
          const snapshot = page(++version, value, submitted)
          return { structuredContent: options.observe ? await options.observe(snapshot, execution.signal) : snapshot }
        }
        const outcome = await options.action?.(name, actual)
        if (outcome !== undefined) return { structuredContent: outcome }
        if (actual.ref !== `p${version}:${name === 'browser_type' ? 1 : 2}`) return { structuredContent: { effect: 'refused', route: 'trusted_input', escalation: { target: 'page', reason: 'route_unavailable' } } }
        if (name === 'browser_type') value = String(actual.text)
        if (name === 'browser_click') submitted = true
        return { structuredContent: { effect: 'unverifiable', route: name === 'browser_click' && actual.input_route === 'dom_event' ? 'dom' : 'trusted_input', delivery: { mode: 'background', ...(name === 'browser_type' ? { delivered_count: Array.from(String(actual.text)).length } : {}) } } }
      },
    }))
  }
  const native = ctx.tools.get('cua_driver_native__get_browser_state')
  const fiber = await ctx.plugin(web, { ...limits, ...options.config })
  const session = ctx.sessions.create(SessionId('web-session'), { meta: { cwd: root } })
  const agent = { id: session.id, session } as Agent
  ctx.agents.enter(agent, undefined)
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await ctx.fiber.dispose(); unregister(); await facility.closeAll(); await backend.close()
  }
  cleanup.push(dispose)
  let id = 0
  const call = (name: string, arguments_: object, signal = new AbortController().signal) => ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name, arguments: arguments_, agent, signal, callId: ToolCallId('web-' + ++id),
  }))
  return { ctx, agent, fiber, common, wires, calls, call, native, root, dispose, facility,
    setValue: (text: string) => { value = text },
    goal: (args: object = input, signal?: AbortSignal) => call('jev_web_goal', args, signal),
    history: () => call('jev_web_history', {}),
  }
}

it('reads historical runs without inventing new budgets or timing records', () => {
  const { maxObserveRounds: _observe, maxScrollCandidates: _scroll, ...oldLimits } = limits
  const record = webRunSchema.parse({ id: 'old', sessionId: 'session', callId: 'call', startedAt: 'then', updatedAt: 'then',
    input, limits: oldLimits, status: 'interrupted', reason: 'Host stopped', rounds: 1, steps: [] })
  expect(record.metrics).toBeUndefined()
  expect(record.limits.maxObserveRounds).toBeUndefined()
})

describe('web action space', () => {
  it('accepts nullable Native names but withholds uninformed unnamed actions', () => {
    const raw = page()
    raw.refs.push({ ref: 'p1:8', role: 'generic', name: null, value: null, states: {}, actions: ['type'], frame: 'main', visibility: 'unknown' })
    const observed = observationSchema.parse(raw)
    const built = buildWebCandidates(input, observed, limits, new Set(['browser_type', 'browser_click']))
    expect(observed.refs.at(-1)?.name).toBeNull()
    expect(built.candidates.find(item => item.arguments?.ref === 'p1:8')).toBeUndefined()
    expect(built.stats.unnamed).toBe(1)
  })
  it('uses actual capabilities and literal supplied text, never disabled or invented actions', () => {
    const state = page()
    state.refs.push({ ...ref('p1:3', 'Disabled', ['click']), states: { disabled: true } }, ref('p1:4', 'No action', []))
    const built = buildWebCandidates(input, state, limits, new Set(['browser_type', 'browser_click']))
    expect(built.candidates.filter(item => item.kind === 'action')).toHaveLength(2)
    expect(built.candidates[0]).toMatchObject({ tool: 'browser_type', arguments: { text: 'hello', replace: true, session: 'cua-session' } })
    expect(built.candidates.some(item => item.description.includes('Disabled'))).toBe(false)
    expect(pageFingerprint(state)).toBe(pageFingerprint({ ...state, snapshot: { ...state.snapshot, id: 'p100' }, refs: state.refs.map(item => ({ ...item, ref: 'p100:1' })) }))
  })
  it('reports candidate omissions and missing input while preserving valid semantic coverage', () => {
    const built = buildWebCandidates({ ...input, texts: [] }, page(), limits, new Set(['browser_type', 'browser_click']))
    expect(built.candidates.some(item => item.kind === 'missing-input' && item.description.includes('verification value'))).toBe(true)
    const capped = buildWebCandidates(input, page(), { ...limits, maxCandidates: 1 }, new Set(['browser_type', 'browser_click']))
    expect(capped).toMatchObject({ eligible: 2, omitted: 1 })
    expect(() => observationSchema.parse({ ...page(), snapshot: { format: 'dom_refs_v1' } })).toThrow()
  })
  it('keeps named controls beyond the raw front 80 when wrappers and unavailable targets are filtered', () => {
    const state = page()
    state.refs = [
      ...Array.from({ length: 60 }, (_, i) => ({ ...ref(`p1:w${i}`, 'Container', ['pointer']), role: 'generic' })),
      ...Array.from({ length: 25 }, (_, i) => ({ ...ref(`p1:h${i}`, 'Hidden', ['click']), visibility: 'css_hidden' })),
      ...state.refs,
    ]
    const space = buildWebCandidates(input, state, limits, new Set(['browser_click', 'browser_type', 'browser_pointer']))
    expect(space.candidates.filter(item => item.kind === 'action').map(item => item.tool)).toEqual(['browser_type', 'browser_click'])
    expect(space.stats).toMatchObject({ selected: 2, selectedScroll: 0, hidden: 25 })
    const request = webRequest(input, state, space, [], limits)
    expect(request.state).toMatchObject({ elements: expect.arrayContaining([expect.objectContaining({ name: 'Submit', ref: 'p1:2' })]) })
  })
  it('counts real scroll scopes separately without evicting a normal action', () => {
    const state = page()
    state.refs.unshift(...Array.from({ length: 4 }, (_, i) => ref(`p1:s${i}`, 'Scrollable region', ['scroll'])))
    const space = buildWebCandidates(input, state, { ...limits, maxCandidates: 3 }, new Set(['browser_click', 'browser_type', 'browser_pointer']))
    expect(space.stats).toMatchObject({ eligible: 10, selected: 3, selectedScroll: 1, scrollBudget: 6, actionBudget: 1 })
    expect(space.candidates.slice(0, 2).map(item => item.tool)).toEqual(['browser_type', 'browser_click'])
    expect(space.omitted).toBe(7)
  })
  it('retains distinct same-name targets while deduplicating the same ref and arguments', () => {
    const state = page()
    state.refs = [ref('p1:1', 'Open', ['click']), ref('p1:2', 'Open', ['click']), ref('p1:1', 'Open', ['click']),
      { ...ref('p1:3', '', ['click']), name: null }]
    const space = buildWebCandidates(input, state, limits, new Set(['browser_click']))
    expect(space.candidates.filter(item => item.kind === 'action').map(item => item.arguments?.ref)).toEqual(['p1:1', 'p1:2'])
    expect(space.stats).toMatchObject({ unnamed: 1, duplicateActions: 1 })
  })
  it('describes literal field matches and does not offer an identical replacement', () => {
    const state = page(2, 'hello')
    expect(fieldState(input, state, [])).toMatchObject({ fields: [{ valueState: 'matches-supplied-value', matchingSuppliedLabels: ['verification value'] }] })
    const space = buildWebCandidates(input, state, limits, new Set(['browser_type', 'browser_click']))
    expect(space.candidates.some(item => item.tool === 'browser_type')).toBe(false)
    expect(fieldState(input, page(1, ''), []).fields[0].valueState).toBe('empty')
    expect(fieldState(input, page(1, 'different'), []).fields[0].valueState).toBe('other-value')
  })
  it('keeps a focused target when the action budget excludes earlier unrelated controls', () => {
    const state = page()
    state.refs = [...Array.from({ length: 100 }, (_, i) => ref('p1:x' + i, 'Open item ' + i, ['click'])),
      { ...ref('p1:focused', 'Search query', ['type'], ''), states: { focused: true } }]
    const built = buildWebCandidates(input, state, { ...limits, maxCandidates: 1 }, new Set(['browser_click', 'browser_type']))
    expect(built.candidates[0]).toMatchObject({ tool: 'browser_type', arguments: { ref: 'p1:focused' } })
    expect(built.elements).toMatchObject([{ ref: 'p1:focused', name: 'Search query' }])
    expect(built.stats.actionBudget).toBe(100)
  })
  it('does not preserve a verified field claim after its identity disappears or becomes ambiguous', () => {
    const previous = { round: 1, at: 'then', observation: page(), status: 'executed' as const, verification: 'value-readback' as const,
      candidate: { id: 'typed', kind: 'action' as const, description: 'Type verification value', tool: 'browser_type', arguments: { ref: 'p1:1', text: 'hello' } } }
    expect(fieldState(input, page(2, 'hello', true), [previous]).lastInput).toMatchObject({ state: 'not-found', deliveryAndReadbackVerified: false })
    const ambiguous = page(2, 'hello')
    ambiguous.refs.push({ ...ambiguous.refs[0], ref: 'p2:another' })
    expect(fieldState(input, ambiguous, [previous]).lastInput).toMatchObject({ state: 'ambiguous', deliveryAndReadbackVerified: false })
  })
  it('ignores outline indentation but retains order, values and availability as progress', () => {
    const a = { ...page(), outline: 'Form\n  Value: hello\n  Submit' }
    const b = { ...page(), outline: '\n Form \n    Value:   hello \n Submit \n' }
    expect(pageFingerprint(a)).toBe(pageFingerprint(b))
    expect(pageFingerprint(a)).not.toBe(pageFingerprint({ ...a, refs: [...a.refs].reverse() }))
    expect(pageFingerprint(a)).not.toBe(pageFingerprint({ ...a, refs: a.refs.map(item => ({ ...item, states: { disabled: true } })) }))
    expect(pageFingerprint(a)).not.toBe(pageFingerprint({ ...a, refs: a.refs.map(item => ({ ...item, value: 'changed' })) }))
  })

})

describe('web goals with the existing DSH tool pipeline', () => {
  it('makes every returned tab selectable in model text without choosing or guessing a page', async () => {
    const tabs = [{ tab_id: 'tab-one', title: 'First', url: 'https://one.test/' }, { tab_id: 'tab-two', title: 'Second', url: 'https://two.test/' }]
    const fixture = await setup({ bind: () => ({ status: 'ok', mode: 'bind', target_id: 'bt-two', tabs }) })
    const result = await fixture.call('jev_web_bind', { session: 'selected-session', pid: 123, window_id: 456 })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ session: 'selected-session', target_id: 'bt-two', tabs })
    const text = result.content.find(block => block.type === 'text')
    if (text?.type !== 'text') throw new Error('Missing model-visible tab list')
    expect(JSON.parse(text.text)).toEqual(result.value)
    expect(fixture.calls).toEqual([{ name: 'get_browser_state', args: { session: 'selected-session', pid: 123, window_id: 456,
      snapshot_format: 'semantic_v2', include_screenshot: false }, parent: true, root: 'web-1' }])
    expect(fixture.wires).toHaveLength(0)
    expect(fixture.ctx.tools.get('cua_driver_native__get_browser_state')).toBe(fixture.native)
  })
  it('retains Native binding refusals and rejects missing tab IDs without inventing a handoff', async () => {
    const fixture = await setup({ bind: () => ({ status: 'refused', refusal: { code: 'browser_consent_required', message: 'Explicit approval required' } }) })
    const result = await fixture.call('jev_web_bind', { session: 'selected-session', pid: 123, window_id: 456 })
    expect(result.value).toMatchObject({ status: 'unsupported', refusal: { code: 'browser_consent_required' } })
    const missing = await setup({ bind: () => ({ status: 'ok', mode: 'bind', target_id: 'bt-only', tabs: [{}] }) })
    expect((await missing.call('jev_web_bind', { session: 'selected-session', pid: 123, window_id: 456 })).value).toMatchObject({ status: 'unsupported' })
    expect(fixture.wires).toHaveLength(0)
    expect(missing.wires).toHaveLength(0)
  })
  it('keeps disabled, unavailable and denied binding calls from obtaining Native state', async () => {
    const args = { session: 'selected-session', pid: 123, window_id: 456 }
    const disabled = await setup({ enabled: false })
    expect((await disabled.call('jev_web_bind', args)).value).toMatchObject({ status: 'disabled' })
    expect(disabled.calls).toHaveLength(0)
    const absent = await setup({ unavailable: true })
    expect((await absent.call('jev_web_bind', args)).value).toMatchObject({ status: 'unsupported' })
    const denied = await setup()
    denied.ctx.on('tools/pre-execute', (exec, next) => exec.name === 'cua_driver_native__get_browser_state'
      ? { kind: 'deny', reason: 'Fixture denies binding' } : next())
    expect((await denied.call('jev_web_bind', args)).isError).toBe(true)
    expect(denied.calls).toHaveLength(0)
  })
  it('fills, clicks, observes and returns a completion suggestion with durable history', async () => {
    const fixture = await setup()
    const result = await fixture.goal()
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ status: 'completion-suggested', action_count: 2, rounds: 3, completion_verified: false,
      evidence: { outline: 'Submitted hello' } })
    expect(fixture.wires).toHaveLength(3)
    expect(fixture.calls.filter(call => call.name === 'get_browser_state')).toHaveLength(3)
    expect(fixture.wires[1].state.recentSteps[0]).toMatchObject({ outcome: 'Requested text was delivered in full and uniquely read back.' })
    expect(fixture.wires[1].state.recentSteps[0]).not.toHaveProperty('result')
    expect(result.value).toMatchObject({ metrics: { observe: { calls: 3, milliseconds: expect.any(Number) }, action: { calls: 2 }, judgmentWait: { calls: 3 } } })
    expect(fixture.wires.every(wire => wire.state.goal === input.goal)).toBe(true)
    expect(fixture.calls.filter(call => call.name !== 'get_browser_state').map(call => call.name)).toEqual(['browser_type', 'browser_click'])
    expect(fixture.calls.every(call => call.parent && call.root === 'web-1')).toBe(true)
    const history = await fixture.history()
    expect(history.value).toMatchObject({ total: 1, runs: [{ status: 'completion-suggested', steps: 3 }] })
    const records = await fixture.ctx.jev.listRecords({ featureId: WEB_FEATURE })
    expect(records.items).toHaveLength(3)
    expect(fixture.ctx.tools.get('cua_driver_native__get_browser_state')).toBe(fixture.native)
  })
  it('leaves direct Native calls untouched before and after disabling or unloading the plugin', async () => {
    const fixture = await setup({ enabled: false })
    expect((await fixture.goal()).value).toMatchObject({ status: 'disabled' })
    expect(fixture.calls).toHaveLength(0)
    await fixture.call('cua_driver_native__get_browser_state', {})
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.wires).toHaveLength(0)
    await fixture.fiber.dispose()
    expect(fixture.ctx.tools.get('jev_web_goal')).toBeUndefined()
    expect(fixture.ctx.tools.get('cua_driver_native__get_browser_state')).toBe(fixture.native)
    await fixture.call('cua_driver_native__get_browser_state', {})
    expect(fixture.calls).toHaveLength(2)
    expect(fixture.ctx.jev).toBeDefined()
  })
  it('returns missing contents and missing Native without inventing inputs or installing capabilities', async () => {
    const fixture = await setup()
    expect((await fixture.goal({ ...input, texts: [] })).value).toMatchObject({ status: 'missing-input' })
    expect(fixture.calls.every(call => call.name === 'get_browser_state')).toBe(true)
    const absent = await setup({ unavailable: true })
    expect((await absent.goal()).value).toMatchObject({ status: 'unsupported' })
    expect(absent.wires).toHaveLength(0)
  })
  it('keeps transport success with a Cua refusal distinct from execution success', async () => {
    const fixture = await setup({ action: () => ({ effect: 'refused', route: 'trusted_input', escalation: { target: 'page', reason: 'route_unavailable' } }) })
    expect((await fixture.goal()).value).toMatchObject({ status: 'action-failed', action_count: 0 })
    expect(fixture.calls.filter(call => call.name !== 'get_browser_state')).toHaveLength(1)
    expect(fixture.calls.some(call => call.args.input_route === 'dom_event')).toBe(false)
  })
  it('identifies the selected missing field even when other literal text was supplied', async () => {
    const fixture = await setup({ reply: () => ({ answers: { next: { choice: 'missing-0' } } }) })
    const result = await fixture.goal({ ...input, texts: [{ label: 'an unrelated search query', text: 'different content' }] })
    expect(result.value).toMatchObject({ status: 'missing-input', missing_fields: [{ name: 'verification value', role: 'textbox' }] })
    expect(fixture.calls.every(call => call.name === 'get_browser_state')).toBe(true)
  })
  it('returns a projected page refusal without guessing its hidden diagnostic or replaying its ref', async () => {
    const fixture = await setup({ action: () => ({ effect: 'refused', route: 'trusted_input', escalation: { target: 'page', reason: 'route_unavailable' } }) })
    expect((await fixture.goal()).value).toMatchObject({ status: 'action-failed', action_count: 0 })
    expect(fixture.calls.filter(call => call.name !== 'get_browser_state')).toHaveLength(1)
  })
  it('does not mistake acknowledged text delivery for a verified field value', async () => {
    const fixture = await setup({ action: () => ({ effect: 'unverifiable', route: 'trusted_input', delivery: { mode: 'background', delivered_count: 5 } }) })
    expect((await fixture.goal()).value).toMatchObject({ status: 'unconfirmed', action_count: 1 })
    expect(fixture.calls.filter(call => call.name !== 'get_browser_state')).toHaveLength(1)
    expect(fixture.calls.filter(call => call.name === 'get_browser_state')).toHaveLength(2)
  })
  it('stops a partially delivered input without retry or completion claims', async () => {
    const fixture = await setup({ action: () => ({ effect: 'partial', route: 'trusted_input', delivery: { mode: 'background', delivered_count: 2 } }) })
    expect((await fixture.goal()).value).toMatchObject({ status: 'unconfirmed', action_count: 0 })
    expect(fixture.calls.filter(call => call.name !== 'get_browser_state')).toHaveLength(1)
  })
  it('bounds observe-only decisions and detects semantic no-progress despite changing snapshot ids', async () => {
    const choice = () => ({ answers: { next: { choice: 'observe' } } })
    const bounded = await setup({ config: { maxRounds: 2, noProgressRounds: 10 }, reply: choice })
    expect((await bounded.goal()).value).toMatchObject({ status: 'budget', rounds: 2 })
    expect(bounded.wires).toHaveLength(2)
    expect(bounded.calls).toHaveLength(2)
    const stalled = await setup({ config: { noProgressRounds: 1 }, reply: choice })
    expect((await stalled.goal()).value).toMatchObject({ status: 'no-progress', rounds: 2 })
    expect(stalled.wires).toHaveLength(1)
  })
  it('caps consecutive observe selections even while unrelated page content changes', async () => {
    const fixture = await setup({ reply: () => ({ answers: { next: { choice: 'observe' } } }),
      observe: async snapshot => ({ ...snapshot, outline: 'Changing ticker ' + snapshot.snapshot.id }) })
    expect((await fixture.goal()).value).toMatchObject({ status: 'needs-main-agent', handoff_reason: 'observe-budget', rounds: 3, action_count: 0 })
    expect(fixture.calls).toHaveLength(3)
    expect(fixture.wires).toHaveLength(3)
  })
  it.each([
    ['page-not-ready', 'about:blank', true, []],
    ['observation-incomplete', 'https://fixture.test/', false, []],
    ['insufficient-target-information', 'https://fixture.test/', true, [{ ...ref('p1:1', '', ['click']), name: null }]],
    ['no-supported-action', 'https://fixture.test/', true, []],
  ] as const)('returns %s without paying for a Jev choice', async (reason, url, complete, refs) => {
    const fixture = await setup({ observe: async snapshot => ({ ...snapshot, page: { url, title: '' }, outline: '', refs: [...refs], snapshot: { ...snapshot.snapshot, complete } }) })
    expect((await fixture.goal()).value).toMatchObject({ status: 'needs-main-agent', handoff_reason: reason, action_count: 0 })
    expect(fixture.wires).toHaveLength(0)
    expect(fixture.calls).toHaveLength(1)
  })
  it('allows bounded reobservation when Native explicitly reports a pending page change', async () => {
    const fixture = await setup({ reply: () => ({ answers: { next: { choice: 'observe' } } }), config: { noProgressRounds: 10 },
      observe: async snapshot => ({ ...snapshot, refs: [{ ...ref('loading', 'Loading', []), states: { busy: true } }] }) })
    expect((await fixture.goal()).value).toMatchObject({ status: 'needs-main-agent', handoff_reason: 'observe-budget' })
    expect(fixture.wires).toHaveLength(3)
  })
  it('returns fresh refs in tool text, forwards Native scope and pages saved evidence without new reads', async () => {
    const fixture = await setup({ config: { maxCandidates: 1, evidenceChars: 8 } })
    const result = await fixture.call('jev_web_observe', { session: input.session, target_id: input.target_id, tab_id: input.tab_id,
      query: 'Submit', scope_ref: 'p0:main', continuation: 'next-scope' })
    const text = result.content.find(block => block.type === 'text')
    if (text?.type !== 'text') throw new Error('Missing model-visible refs')
    const value = JSON.parse(text.text) as { observation_id: string; snapshot: { id: string }; elements: WebObservation['refs'] }
    expect(value).toMatchObject({ status: 'ok', snapshot: { id: 'p1' }, elements: [{ ref: 'p1:1' }], omitted_elements: 1 })
    expect(fixture.calls[0].args).toMatchObject({ query: 'Submit', scope_ref: 'p0:main', continuation: 'next-scope' })
    let offset: number | null = 0, saved = ''
    while (offset !== null) {
      const page = await fixture.call('jev_web_observe', { observation_id: value.observation_id, offset, limit: 80 })
      const chunk = page.value as { json: string; next_offset: number | null }
      saved += chunk.json; offset = chunk.next_offset
    }
    expect(JSON.parse(saved)).toMatchObject({ observation: { snapshot: { id: 'p1' }, refs: [{ ref: 'p1:1' }, { ref: 'p1:2' }] } })
    expect(fixture.wires).toHaveLength(0)
    expect(fixture.calls).toHaveLength(1)
    expect((await fixture.call('jev_web_observe', { observation_id: value.observation_id, session: input.session })).isError).toBe(true)
    const otherSession = fixture.ctx.sessions.create(SessionId('another-observer'), { meta: { cwd: fixture.root } })
    const other = { id: otherSession.id, session: otherSession } as Agent
    fixture.ctx.agents.enter(other, undefined)
    const denied = await fixture.ctx.agents.withInitiator(other, () => fixture.ctx.tools.execute({ name: 'jev_web_observe',
      arguments: { observation_id: value.observation_id }, agent: other, signal: new AbortController().signal, callId: ToolCallId('other-read') }))
    expect(denied.isError).toBe(true)
  })
  it('does not obtain state through disabled or denied observation tools', async () => {
    const args = { session: input.session, target_id: input.target_id, tab_id: input.tab_id }
    const disabled = await setup({ enabled: false })
    expect((await disabled.call('jev_web_observe', args)).value).toMatchObject({ status: 'disabled' })
    expect(disabled.calls).toHaveLength(0)
    const absent = await setup({ unavailable: true })
    expect((await absent.call('jev_web_observe', args)).value).toMatchObject({ status: 'unsupported' })
    const denied = await setup()
    denied.ctx.on('tools/pre-execute', (exec, next) => exec.name === 'cua_driver_native__get_browser_state' ? { kind: 'deny', reason: 'Denied read' } : next())
    expect((await denied.call('jev_web_observe', args)).isError).toBe(true)
    expect(denied.calls).toHaveLength(0)
  })
  it('waits on invalid Choice and rebuilds page input only after a human retry', async () => {
    const fixture = await setup({ reply: (_wire, index) => ({ answers: { next: { choice: index === 1 ? 'invented' : 'finish' } } }) })
    fixture.ctx.on('user-questions/request', () => {
      expect(fixture.wires).toHaveLength(1)
      expect(fixture.calls.every(call => call.name === 'get_browser_state')).toBe(true)
      fixture.setValue('changed during wait')
      return { answers: [{ id: 'jev-resolution', selected: ['重试 / Retry'] }] }
    })
    expect((await fixture.goal()).value).toMatchObject({ status: 'completion-suggested', rounds: 2 })
    expect(fixture.wires[1].state.outline).toContain('changed during wait')
    expect(fixture.wires[0].state.snapshot.id).not.toBe(fixture.wires[1].state.snapshot.id)
  })
  it('returns a valid unknown choice to the main Agent without an available human interface', async () => {
    const fixture = await setup({ reply: () => ({ answers: { next: { choice: 'unknown' } } }) })
    const ask = vi.spyOn(fixture.ctx.userQuestions, 'ask')
    const result = await fixture.goal()
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ status: 'needs-main-agent', action_count: 0, rounds: 1, completion_verified: false,
      handoff: { to: 'main-agent', browser: { session: input.session, target_id: input.target_id, tab_id: input.tab_id },
        elements: [{ ref: 'p1:1', actions: ['type'] }, { ref: 'p1:2', actions: ['click'] }], omitted_elements: 0 },
      steps: [{ candidate: { id: 'unknown' }, status: 'observed' }] })
    expect(ask).not.toHaveBeenCalled()
    expect(fixture.wires).toHaveLength(1)
    expect(fixture.calls.map(call => call.name)).toEqual(['get_browser_state'])
    expect((await fixture.history()).value).toMatchObject({ runs: [{ status: 'needs-main-agent', steps: 1 }] })
  })
  it.each(['TIMEOUT', 'SERVICE_FAILURE'])('retains human Retry/Cancel on %s instead of handing a service fault to the model', async code => {
    const fixture = await setup()
    vi.spyOn(fixture.ctx.llm, 'stream').mockImplementation(async function* () { throw new JevError(code, 'Fixture service failure') })
    const question = vi.fn(() => ({ answers: [{ id: 'jev-resolution', selected: ['取消 / Cancel'] }] }))
    fixture.ctx.on('user-questions/request', question)
    const result = await fixture.goal()
    expect(result.value).toMatchObject({ status: 'cancelled', action_count: 0, handoff: null })
    expect(question).toHaveBeenCalledTimes(1)
    expect(fixture.calls.every(call => call.name === 'get_browser_state')).toBe(true)
  })
  it('adopts one in-flight answer after disabling but makes no further selection', async () => {
    let disable: () => void = () => {}
    const fixture = await setup({ reply: wire => { disable(); return { answers: { next: { choice: Object.keys(wire.questions.next.criteria)[0] } } } } })
    disable = () => updateVolatile(fixture.common.config.features as Volatile<Record<string, boolean>>, createVolatile({ [WEB_FEATURE]: false }))
    expect((await fixture.goal()).value).toMatchObject({ status: 'disabled', action_count: 1 })
    expect(fixture.wires).toHaveLength(1)
  })
  it('preserves cancellation history and does not cancel the Native runtime', async () => {
    const controller = new AbortController()
    const fixture = await setup({ reply: () => ({ answers: {} }) })
    fixture.ctx.on('user-questions/request', () => { controller.abort(); return new Promise(() => {}) })
    const result = await fixture.goal(input, controller.signal)
    expect(result.isError).toBe(true)
    expect((await fixture.history()).value).toMatchObject({ runs: [{ status: 'cancelled' }] })
    await fixture.call('cua_driver_native__get_browser_state', {})
    expect(fixture.ctx.tools.get('cua_driver_native__get_browser_state')).toBe(fixture.native)
  })
  it('does not dispatch an action when its write-ahead trace cannot be saved', async () => {
    const original = WebRunStore.prototype.save
    vi.spyOn(WebRunStore.prototype, 'save').mockImplementation(function (this: WebRunStore, run: WebRun) {
      if (run.steps.some(step => step.status === 'executing')) return Promise.reject(new Error('disk unavailable'))
      return original.call(this, run)
    })
    const fixture = await setup()
    expect((await fixture.goal()).value).toMatchObject({ status: 'unconfirmed', action_count: 0 })
    expect(fixture.calls.every(call => call.name === 'get_browser_state')).toBe(true)
  })
  it('does not repeat an executed action when its completed trace write fails', async () => {
    const original = WebRunStore.prototype.save
    vi.spyOn(WebRunStore.prototype, 'save').mockImplementation(function (this: WebRunStore, run: WebRun) {
      if (run.steps.some(step => step.status === 'executed')) return Promise.reject(new Error('disk unavailable'))
      return original.call(this, run)
    })
    const fixture = await setup()
    expect((await fixture.goal()).value).toMatchObject({ status: 'unconfirmed' })
    expect(fixture.calls.filter(call => call.name !== 'get_browser_state')).toHaveLength(1)
    const listed = (await fixture.history()).value as { runs: { run_id: string }[] }
    const record = (await fixture.call('jev_web_history', { run_id: listed.runs[0].run_id })).value as { json: string }
    expect(JSON.parse(record.json).steps[0].status).toBe('executing')
  })
  it('reports an unsaved public action receipt as unconfirmed without repeating its action', async () => {
    const fixture = await setup()
    vi.spyOn(fixture.ctx.jev, 'writeReceipt').mockRejectedValue(new JevError('RECEIPT_NOT_SAVED', 'Action receipt was not saved; do not repeat the action'))
    expect((await fixture.goal()).value).toMatchObject({ status: 'unconfirmed', action_count: 1 })
    expect(fixture.calls.filter(call => call.name !== 'get_browser_state')).toHaveLength(1)
  })
  it('recovers in-flight actions as interrupted and unconfirmed without contacting Native or Jev', async () => {
    const fixture = await setup()
    const profile = join(fixture.root, 'recovery-profile')
    const store = await WebRunStore.open(fixture.facility, profile)
    const run: WebRun = { id: 'recover', sessionId: 'old-session', callId: 'old-call', startedAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z',
      input, limits, status: 'running', reason: '', rounds: 1,
      steps: [{ round: 1, at: '2026-09-27T00:00:00Z', observation: page(), status: 'executing' }] }
    await store.save(run); await store.close()
    const restored = await WebRunStore.open(fixture.facility, profile)
    expect(restored.get('recover')).toMatchObject({ status: 'interrupted', steps: [{ status: 'unconfirmed' }] })
    expect(restored.list('another-session')).toEqual([])
    await restored.close()
    expect(fixture.calls).toHaveLength(0); expect(fixture.wires).toHaveLength(0)
  })
  it('retains the Host permission decision on nested Native calls', async () => {
    const fixture = await setup()
    fixture.ctx.on('tools/pre-execute', (exec, next) => exec.name === 'cua_driver_native__browser_type'
      ? { kind: 'deny', reason: 'Fixture denies typing' } : next())
    expect((await fixture.goal()).value).toMatchObject({ status: 'unconfirmed', action_count: 0 })
    expect(fixture.calls.every(call => call.name === 'get_browser_state')).toBe(true)
  })
  it('waits for its cancelled Native read to settle before completing plugin unload', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let readSignal: AbortSignal | undefined
    const fixture = await setup({ observe: async (snapshot, signal) => {
      readSignal = signal; started.resolve(); await release.promise; return snapshot
    } })
    cleanup.push(async () => { release.resolve() })
    const running = fixture.goal()
    await started.promise
    let unloaded = false
    const disposal = fixture.fiber.dispose().then(() => { unloaded = true })
    await vi.waitFor(() => expect(readSignal?.aborted).toBe(true))
    expect(unloaded).toBe(false)
    release.resolve()
    await disposal
    expect((await running).value).toMatchObject({ status: 'cancelled' })
    expect(fixture.wires).toHaveLength(0)
    await fixture.call('cua_driver_native__get_browser_state', {})
    expect(fixture.ctx.tools.get('cua_driver_native__get_browser_state')).toBe(fixture.native)
  })
  it('returns paged records only to their owning session', async () => {
    const fixture = await setup()
    const output = (await fixture.goal()).value as { run_id: string }
    const first = (await fixture.call('jev_web_history', { run_id: output.run_id, limit: 10 })).value as { json: string; next_offset: number }
    const second = (await fixture.call('jev_web_history', { run_id: output.run_id, offset: first.next_offset, limit: 10 })).value as { json: string }
    expect((first.json + second.json).startsWith('{"id":')).toBe(true)
    const session = fixture.ctx.sessions.create(SessionId('other-root'), { meta: { cwd: fixture.root } })
    const other = { id: session.id, session } as Agent
    fixture.ctx.agents.enter(other, undefined)
    const read = await fixture.ctx.tools.execute({ name: 'jev_web_history', arguments: { run_id: output.run_id }, agent: other,
      signal: new AbortController().signal, callId: ToolCallId('foreign-read') })
    expect(read.isError).toBe(true)
  })
  it('hands off only IDs read from model-visible binding text and replays the full bind-to-goal conversation', async () => {
    const fixture = await setup({ loop: true })
    await fixture.ctx.plugin(JsonlPersistence, { root: join(fixture.root, 'sessions') })
    await fixture.ctx.plugin(AgentLoop, { agents: [] })
    class Model extends LlmAdapter {
      readonly requests: GenerateOptions[] = []
      async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(request)
        if (this.requests.length === 1) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('model-native-bind'), name: 'cua_driver_native__get_browser_state', arguments: JSON.stringify({ session: input.session, pid: 123, window_id: 456 }) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else if (this.requests.length === 2) {
          const nativeMessage = request.messages.filter(message => message.role === 'tool').at(-1)
          expect(JSON.stringify(nativeMessage)).toContain('with 1 tab(s)')
          expect(JSON.stringify(nativeMessage)).not.toContain('tab-test')
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('model-web-bind'), name: 'jev_web_bind', arguments: JSON.stringify({ session: input.session, pid: 123, window_id: 456 }) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else if (this.requests.length === 3) {
          const message = request.messages.filter(message => message.role === 'tool').at(-1)
          const text = message?.content.find(block => block.type === 'text')
          if (text?.type !== 'text') throw new Error('Model did not receive a readable binding')
          const binding = JSON.parse(text.text) as { status: string; session: string; target_id: string; tabs: { tab_id: string }[] }
          expect(binding.status).toBe('ok')
          expect(binding.tabs).toHaveLength(1)
          const goal = { goal: input.goal, texts: input.texts, session: binding.session, target_id: binding.target_id, tab_id: binding.tabs[0].tab_id }
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('model-web'), name: 'jev_web_goal', arguments: JSON.stringify(goal) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The page confirms Submitted hello.' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    const model = new Model()
    fixture.ctx.llm.registerAdapter(['web-fixture-model'], model)
    const errors: unknown[] = []
    fixture.ctx.on('agent/error', event => { errors.push(event.error) })
    const agent = await fixture.ctx.agentLoop.create(SessionId('loop-web'), { provider: 'web-fixture-model', model: 'local' }, { cwd: fixture.root })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: input.goal }] }))
    await agent.whenIdle()
    expect(errors).toEqual([])
    expect(model.requests).toHaveLength(4)
    const messages = JSON.stringify(model.requests[3].messages)
    expect(messages).toContain('completion-suggested')
    expect(messages).toContain('Submitted hello')
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(3)
    expect(events.filter(event => event.type === 'tool/result')).toHaveLength(3)
    const resultEvent = events.filter(event => event.type === 'tool/result').at(-1)
    expect(JSON.stringify(resultEvent)).toContain('jev_web_history')
    const replay = Session.create(agent.session.id, events, agent.session.header)
    expect(replay.deriveMessages()).toEqual(agent.session.deriveMessages())
    if (resultEvent?.type !== 'tool/result') throw new Error('Missing recorded result')
    const content = resultEvent.data.message.content.find(block => block.type === 'text')
    if (content?.type !== 'text') throw new Error('Missing result text')
    const value = JSON.parse(content.text) as { status: string; action_count: number; completion_verified: boolean; evidence: { outline: string }; steps: { candidate: { kind: string }; status: string }[] }
    expect({ status: value.status, actionCount: value.action_count, verified: value.completion_verified, page: value.evidence.outline,
      steps: value.steps.map(step => [step.candidate.kind, step.status]) }).toMatchInlineSnapshot(`
        {
          "actionCount": 2,
          "page": "Submitted hello",
          "status": "completion-suggested",
          "steps": [
            [
              "action",
              "executed",
            ],
            [
              "action",
              "executed",
            ],
            [
              "finish",
              "observed",
            ],
          ],
          "verified": false,
        }
      `)
  })
  it('lets the next main-model step continue Native actions after Jev becomes undecided without repeating an executed input', async () => {
    const fixture = await setup({ loop: true, reply: (wire, index) => ({ answers: { next: {
      choice: index === 1 ? Object.entries(wire.questions.next.criteria).find(([, text]) => text.startsWith('Replace '))?.[0] : 'unknown',
    } } }) })
    await fixture.ctx.plugin(JsonlPersistence, { root: join(fixture.root, 'sessions') })
    await fixture.ctx.plugin(AgentLoop, { agents: [] })
    const ask = vi.spyOn(fixture.ctx.userQuestions, 'ask')
    class Model extends LlmAdapter {
      readonly requests: GenerateOptions[] = []
      async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(request)
        if (this.requests.length === 1) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('undecided-goal'), name: 'jev_web_goal',
            arguments: JSON.stringify({ ...input, input_route: 'dom_event' }) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else if (this.requests.length === 2) {
          const result = request.messages.filter(message => message.role === 'tool').at(-1)?.content.find(block => block.type === 'text')
          if (result?.type !== 'text') throw new Error('Missing handoff text in the next model request')
          const value = JSON.parse(result.text) as { status: string; action_count: number; handoff: {
            browser: { session: string; target_id: string; tab_id: string }; input_route: string; elements: WebObservation['refs'];
          }; steps: { status: string; verification?: string }[] }
          expect(value.status).toBe('needs-main-agent')
          expect(value.action_count).toBe(1)
          expect(value.steps[0]).toMatchObject({ status: 'executed', verification: 'value-readback' })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('main-model-observe'), name: 'jev_web_observe', arguments: JSON.stringify(value.handoff.browser) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else if (this.requests.length === 3) {
          const result = request.messages.filter(message => message.role === 'tool').at(-1)?.content.find(block => block.type === 'text')
          if (result?.type !== 'text') throw new Error('Missing fresh observation in model request')
          const value = JSON.parse(result.text) as { browser: { session: string; target_id: string; tab_id: string }; snapshot: { id: string }; elements: WebObservation['refs'] }
          expect(value.snapshot.id).toBe('p3')
          const field = value.elements.find(element => element.actions.includes('type'))
          expect(field?.value).toBe('hello')
          const button = value.elements.find(element => element.actions.includes('click'))
          if (button === undefined) throw new Error('Missing actionable element in handoff')
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('main-model-native-click'), name: 'cua_driver_native__browser_click',
            arguments: JSON.stringify({ ...value.browser, ref: button.ref, input_route: 'dom_event' }) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Continued through Native CUA after the Jev handoff.' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    const model = new Model()
    fixture.ctx.llm.registerAdapter(['handoff-fixture-model'], model)
    const errors: unknown[] = []
    fixture.ctx.on('agent/error', event => { errors.push(event.error) })
    const agent = await fixture.ctx.agentLoop.create(SessionId('loop-handoff'), { provider: 'handoff-fixture-model', model: 'local' }, { cwd: fixture.root })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: input.goal }] }))
    await agent.whenIdle()
    expect(errors).toEqual([])
    expect(model.requests).toHaveLength(4)
    expect(ask).not.toHaveBeenCalled()
    expect(fixture.wires).toHaveLength(2)
    expect(fixture.calls.filter(call => call.name !== 'get_browser_state').map(call => call.name)).toEqual(['browser_type', 'browser_click'])
    const observed = await fixture.call('cua_driver_native__get_browser_state', { session: input.session, target_id: input.target_id, tab_id: input.tab_id })
    expect(observed.value).toMatchObject({ structuredContent: { outline: 'Submitted hello' } })
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['jev_web_goal', 'jev_web_observe', 'cua_driver_native__browser_click'])
    expect(Session.create(agent.session.id, events, agent.session.header).deriveMessages()).toEqual(agent.session.deriveMessages())
  })
})
