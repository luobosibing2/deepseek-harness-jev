import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, resolveConfig } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionHeader, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import GoalService from '@deepseek-ai/dsh-goal'
import * as goalDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as goalTools from '@deepseek-ai/dsh-tool-goal'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { JevLedger } from '../src/ledger.ts'
import JevService from '../src/index.ts'
import * as interjection from '../src/interjection.ts'

type Entry = StreamChunk[] | ((request: GenerateOptions) => Promise<StreamChunk[]> | StreamChunk[])
class Model extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(readonly script: Entry[]) { super() }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('Fixture script exhausted')
    for (const chunk of typeof entry === 'function' ? await entry(request) : entry) yield chunk
  }
}
const text = (value: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const call = (id: string, name = 'probe', args: object = {}): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const answer = (value: string) => ({ answers: { route: { choice: value } } })
type Reply = object | (() => Promise<object>)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function harness(script: Entry[], replies: Reply[], features: Record<string, boolean> = {}, counts = {}, resume?: { root: string; id: ReturnType<typeof SessionId>; seed?: { header: SessionHeader; events: readonly SessionEvent[] } }) {
  const root = resume?.root ?? await mkdtemp(join(tmpdir(), 'jev-routing-'))
  if (resume === undefined) cleanups.push(() => rm(root, { recursive: true, force: true }))
  // The fixture captures multiple wire questions and heterogeneous evidence fields for assertions.
  const requests: any[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    const reply = replies.shift() ?? answer('unknown')
    response.writeHead(200, { 'content-type': 'application/json' })
    const result = typeof reply === 'function' ? await reply() : reply
    const encoded = JSON.stringify(result)
    response.end(encoded)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No fixture port')
  const ctx = new Context()
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  await ctx.plugin(Storage)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(GoalService)
  await ctx.plugin(goalDriver)
  await ctx.plugin(goalTools)
  const backend = new JsonStorageBackend(join(root, 'storage'))
  const unregister = ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.provide('storageDomain', facility)
  ctx.provide('profileContext', { dir: join(root, 'profile') } as never)
  ctx.provide('settings', { configure: () => () => {} } as never)
  ctx.provide('credentials', { resolve: async () => ({ value: 'local-fixture-key', source: 'fixture' }) } as never)
  await ctx.plugin(Loader)
  ctx.loader.builtins['jev-fixture'] = JevService
  const commonId = await ctx.loader.create({ id: 'jev', name: 'cordis:jev-fixture', config: {
    baseUrl: `http://127.0.0.1:${address.port}/v1/systemone`, model: 'jev-local', credentialRef: 'JEV_TEST_KEY', timeoutMs: 2_000, features,
  } })
  const commonEntry = ctx.loader.resolve(commonId)
  const common = commonEntry.fiber!
  await common.await()
  const setFeatures = async (features: Record<string, boolean>) => {
    const config = { ...commonEntry.options.config, features }
    resolveConfig(common.runtime!, common.ctx.waterfall(common, 'internal/config', config, () => config))
    await commonEntry.update({ config })
    await commonEntry.fiber!.await()
  }
  await ctx.plugin(interjection, counts)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  const model = new Model(script)
  ctx.llm.registerAdapter(['fixture'], model)
  ctx.tools.register(defineTool({ name: 'probe', description: 'Record a deterministic investigation', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] }, execute: async () => 'No source change; investigation result' }))
  if (resume?.seed !== undefined) { const writer = await ctx.sessionPersistence.create(resume.seed.header); await writer.append(resume.seed.events); await writer.close() }
  const agent = resume === undefined
    ? await ctx.agentLoop.create(SessionId('routing-fixture'), { provider: 'fixture', model: 'fixture' })
    : (await ctx.agentLoop.resume(ctx, { resumeSessionId: resume.id, agentOptions: { provider: 'fixture', model: 'fixture' } })).agent
  let disposed = false
  const dispose = async () => { if (disposed) return; disposed = true; await ctx.fiber.dispose(); unregister(); await facility.closeAll(); await backend.close() }
  cleanups.push(dispose)
  const send = (value: string) => agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] }))
  const records = () => ctx.jev.listRecords({ sessionId: agent.id, limit: 100 })
  return { ctx, agent, model, requests, send, records, errors, dispose, features: common.config.features, common, setFeatures, root }
}
const visible = (agent: Agent) => agent.session.deriveMessages().flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')


const input = (value: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] })
function deliveryTurn(agent: Agent, id: string) {
  let turn = 0
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'user/message' && event.data.id === id) return turn
  }
  return undefined
}
const committed = (agent: Agent, id: string) => agent.session.deriveMessages().filter(message => message.id === id)
async function running(replies: Reply[], enabled = true, more: Entry[] = []) {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const h = await harness([async () => { started.resolve(); await release.promise; return call('probe') }, text('original done'), ...more, text('queued done'), text('another queued done')], replies, { 'interjection-routing': enabled })
  cleanups.push(async () => { release.resolve() })
  h.send('Original task'); await started.promise
  return { ...h, release }
}

describe('interjection business routing through published AgentLoop and HTTP Jev', () => {
  it('keeps default-off and idle input on the original Host path', async () => {
    const h = await harness([text('idle answer')], [], {})
    expect((await h.ctx.jev.listFeatures()).find(feature => feature.id === 'interjection-routing')?.enabled).toBe(false)
    h.send('An idle task'); await h.agent.whenIdle()
    expect(h.requests).toHaveLength(0)
    const off = await running([], false)
    const steer = input('Original steer')
    off.agent.steer(steer); off.release.resolve(); await off.agent.whenIdle()
    expect(deliveryTurn(off.agent, steer.id)).toBe(1)
    expect(off.requests).toHaveLength(0)
  })

  it('moves an original queue correction into the active turn and an original steer addition into a later turn', async () => {
    const h = await running([answer('correction'), answer('queue')])
    const correction = input('Wrong direction, inspect X first')
    const later = input('After finishing, add an example')
    h.agent.followup(correction); h.agent.steer(later)
    h.release.resolve(); await h.agent.whenIdle()
    expect(h.errors).toEqual([])
    expect(deliveryTurn(h.agent, correction.id)).toBe(1)
    expect(deliveryTurn(h.agent, later.id)).toBe(2)
    expect(committed(h.agent, correction.id)).toHaveLength(1)
    expect(committed(h.agent, later.id)).toHaveLength(1)
    expect(h.requests).toHaveLength(2)
  })

  it('waits before the dependent model step while the already-started tool finishes', async () => {
    const deferred = Promise.withResolvers<object>()
    const h = await running([() => deferred.promise])
    const message = input('Stop that approach and inspect X')
    h.agent.followup(message); h.release.resolve()
    await vi.waitFor(() => expect(h.agent.session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(true))
    expect(h.model.requests).toHaveLength(1)
    expect(committed(h.agent, message.id)).toHaveLength(0)
    deferred.resolve(answer('correction'))
    await h.agent.whenIdle()
    expect(deliveryTurn(h.agent, message.id)).toBe(1)
  })

  it('retains editable pending identities and classifies the edited content instead of the old response', async () => {
    const deferred = Promise.withResolvers<object>()
    const h = await running([() => deferred.promise, answer('correction')])
    const message = input('Add an example later')
    h.agent.steer(message); h.release.resolve()
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    expect(h.agent.inbox.replace(message.id, { ...message, content: [{ type: 'text', text: 'Actually correct the current direction' }] })).toBe(true)
    deferred.resolve(answer('queue'))
    await h.agent.whenIdle()
    expect(h.errors).toEqual([])
    expect(committed(h.agent, message.id)).toHaveLength(1)
    expect(JSON.stringify(committed(h.agent, message.id))).toContain('Actually correct')
    expect(deliveryTurn(h.agent, message.id)).toBe(1)
    expect(h.requests[1].state.message).toBe('Actually correct the current direction')
  })

  it('honors removal and user stop without reviving late classifications', async () => {
    const deferred = Promise.withResolvers<object>()
    const h = await running([() => deferred.promise])
    const message = input('Remove this message')
    h.agent.followup(message)
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    expect(h.agent.inbox.remove(message.id)).toBe(true)
    h.agent.cancel({ kind: 'user' })
    h.release.resolve(); await h.agent.whenIdle()
    deferred.resolve(answer('correction'))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(committed(h.agent, message.id)).toHaveLength(0)
    expect(h.model.requests).toHaveLength(1)
  })

  it('preserves arrival order per destination despite out-of-order answers and equal text', async () => {
    const first = Promise.withResolvers<object>()
    const second = Promise.withResolvers<object>()
    const third = Promise.withResolvers<object>()
    const h = await running([() => first.promise, () => second.promise, () => third.promise])
    const a = input('Same text'), b = input('Later work'), c = input('Same text')
    h.agent.followup(a); h.agent.steer(b); h.agent.followup(c)
    await vi.waitFor(() => expect(h.requests).toHaveLength(3))
    third.resolve(answer('correction')); second.resolve(answer('queue')); first.resolve(answer('correction'))
    h.release.resolve(); await h.agent.whenIdle()
    const delivered = h.agent.session.deriveMessages().filter(message => [a.id, b.id, c.id].includes(message.id)).map(message => message.id)
    expect(delivered).toEqual([a.id, c.id, b.id])
    expect(deliveryTurn(h.agent, a.id)).toBe(1)
    expect(deliveryTurn(h.agent, c.id)).toBe(1)
    expect(deliveryTurn(h.agent, b.id)).toBe(2)
  })

  it('cancels only the failed message after a real human-resolution response', async () => {
    const h = await running([{ answers: {} }, answer('queue')])
    h.ctx.on('user-questions/request', async () => ({ answers: [{ id: 'jev-resolution', selected: ['取消 / Cancel'] }] }))
    const bad = input('Unclassifiable input'), good = input('Later request')
    h.agent.steer(bad); h.agent.followup(good)
    h.release.resolve(); await h.agent.whenIdle()
    expect(committed(h.agent, bad.id)).toHaveLength(0)
    expect(committed(h.agent, good.id)).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  it('records synchronous enablement intervals before subsequent running user input', async () => {
    const h = await running([answer('correction')], false)
    await h.setFeatures({ 'interjection-routing': true })
    const message = input('Correction after hot update')
    h.agent.followup(message); h.release.resolve(); await h.agent.whenIdle()
    expect(h.requests).toHaveLength(1)
    expect(deliveryTurn(h.agent, message.id)).toBe(1)
    const events = h.agent.session.snapshotEvents()
    const marker = events.findLast(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'jev-interjection' && message.source.action === 'mode' && message.source.enabled && message.source.running))
    const insertion = events.find(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(item => item.id === message.id))
    expect(marker!.seq).toBeLessThan(insertion!.seq)
  })

  it('restores a persisted inbox prefix from before Jev has a record as interrupted, never as original queue delivery', async () => {
    const deferred = Promise.withResolvers<object>()
    const h = await running([() => deferred.promise])
    const message = input('An unclassified correction')
    h.agent.followup(message)
    const all = h.agent.session.snapshotEvents()
    const inserted = all.findIndex(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(item => item.id === message.id))
    const prefix = all.slice(0, inserted + 1)
    expect(prefix.at(-1)?.type).toBe('agent/inbox/spliced')
    const root = await mkdtemp(join(tmpdir(), 'jev-routing-prefix-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    h.agent.cancel({ kind: 'user' }); h.release.resolve(); deferred.resolve(answer('correction')); await h.agent.whenIdle()
    const restored = await harness([text('new task')], [], { 'interjection-routing': true }, {}, { root, id: h.agent.id, seed: { header: h.agent.session.header, events: prefix } })
    expect(restored.requests).toHaveLength(0)
    expect(restored.model.requests).toHaveLength(0)
    expect([...restored.agent.inbox.nextStep, ...restored.agent.inbox.nextTurn].some(item => item.id === message.id)).toBe(false)
    expect(visible(restored.agent)).toContain('Interrupted by Host restart')
    const recovered = await restored.records()
    expect(recovered.items).toHaveLength(1)
    expect(recovered.items[0]).toMatchObject({ status: 'interrupted', attempts: 0 })
    expect((await restored.ctx.jev.getRecord(recovered.items[0]!.id))?.link.inputVersion).toBe(message.id)
    restored.send('A genuinely new task'); await restored.agent.whenIdle()
    expect(committed(restored.agent, message.id)).toHaveLength(0)
    expect(restored.requests).toHaveLength(0)
  })

  it('keeps disabled-interval pending input on the original path after restart', async () => {
    const h = await running([], false)
    const message = input('Queued while disabled')
    h.agent.followup(message)
    const prefix = h.agent.session.snapshotEvents()
    const root = await mkdtemp(join(tmpdir(), 'jev-routing-disabled-prefix-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    h.agent.cancel({ kind: 'user' }); h.release.resolve(); await h.agent.whenIdle()
    const restored = await harness([text('old queued task'), text('new task')], [], { 'interjection-routing': true }, {}, { root, id: h.agent.id, seed: { header: h.agent.session.header, events: prefix } })
    expect(restored.agent.inbox.nextTurn.some(item => item.id === message.id)).toBe(true)
    restored.send('New task'); await restored.agent.whenIdle()
    expect(committed(restored.agent, message.id)).toHaveLength(1)
    expect(restored.requests).toHaveLength(0)
  })

  it('fails the dependent step when a mode marker is rejected by the public Session append reentrancy guard', async () => {
    const h = await running([], false)
    let changed = false
    h.ctx.on('session/event', (_session, event) => {
      if (event.type !== 'tool/result' || changed) return
      changed = true
      const own: Context = Object.create(h.common.ctx)
      own[Context.filter] = owner => owner.fiber === h.common
      updateVolatile(h.features, createVolatile({ 'interjection-routing': true }))
      h.common.ctx.emit(own, 'loader/volatile-update', [['features']])
    })
    h.release.resolve(); await h.agent.whenIdle()
    expect(h.model.requests).toHaveLength(1)
    expect(h.errors.some(error => error instanceof Error && error.message.includes('mode could not be recorded'))).toBe(true)
    expect(h.requests).toHaveLength(0)
  })

  it('applies committed feature updates separately to two live root sessions', async () => {
    const h = await harness([text('first'), text('second')], [], {})
    const other = await h.ctx.agentLoop.create(SessionId('other-root'), { provider: 'fixture', model: 'fixture' })
    await h.setFeatures({ 'interjection-routing': true })
    for (const agent of [h.agent, other]) {
      const marker = agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted).findLast(message => message.source.kind === 'jev-interjection' && message.source.action === 'mode')
      expect(marker?.source.kind === 'jev-interjection' && marker.source.action === 'mode' && marker.source.enabled).toBe(true)
    }
    h.send('Idle task one'); other.followup(input('Idle task two'))
    await Promise.all([h.agent.whenIdle(), other.whenIdle()])
    expect(h.requests).toHaveLength(0)
  })

  it('requires re-enablement before a failed message can be retried, and cancellation removes just that message', async () => {
    const h = await running([{ answers: {} }])
    let prompts = 0
    h.ctx.on('user-questions/request', async () => {
      prompts++
      if (prompts === 1) {
        const own: Context = Object.create(h.common.ctx)
        own[Context.filter] = owner => owner.fiber === h.common
        updateVolatile(h.features, createVolatile({ 'interjection-routing': false }))
        h.common.ctx.emit(own, 'loader/volatile-update', [['features']])
        return { answers: [{ id: 'jev-resolution', selected: ['重试 / Retry'] }] }
      }
      return { answers: [{ id: 'jev-resolution', selected: ['取消 / Cancel'] }] }
    })
    const message = input('Uncertain request')
    h.agent.followup(message); h.release.resolve(); await h.agent.whenIdle()
    expect(prompts).toBe(2)
    expect(h.requests).toHaveLength(1)
    expect(committed(h.agent, message.id)).toHaveLength(0)
  })

  it('lets an already-issued classification finish after feature disablement', async () => {
    const deferred = Promise.withResolvers<object>()
    const h = await running([() => deferred.promise])
    const message = input('Correction in flight')
    h.agent.followup(message)
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    const own: Context = Object.create(h.common.ctx)
    own[Context.filter] = owner => owner.fiber === h.common
    updateVolatile(h.features, createVolatile({ 'interjection-routing': false }))
    h.common.ctx.emit(own, 'loader/volatile-update', [['features']])
    deferred.resolve(answer('correction')); h.release.resolve(); await h.agent.whenIdle()
    expect(deliveryTurn(h.agent, message.id)).toBe(1)
  })


  it('waits for a late correction before the native goal driver can begin another round', async () => {
    const deferred = Promise.withResolvers<object>()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let h: Awaited<ReturnType<typeof harness>>
    h = await harness([async () => { started.resolve(); await release.promise; return text('goal round answer') }, () => {
      const goal = h.ctx.goals.get(h.agent)!
      h.ctx.agents.withInitiator(h.agent, () => h.ctx.goals.pause(h.agent, { id: goal.id, revision: goal.revision }))
      return text('corrected goal work')
    }], [() => deferred.promise], { 'interjection-routing': true })
    cleanups.push(async () => { release.resolve(); deferred.resolve(answer('correction')) })
    h.ctx.goals.create(h.agent, { objective: 'Goal work', maxGoalRounds: 5 })
    await started.promise
    const message = input('Correct this direction before doing anything else')
    h.agent.followup(message); release.resolve()
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    expect(h.ctx.goals.get(h.agent)?.roundsStarted).toBe(1)
    expect(h.model.requests).toHaveLength(1)
    deferred.resolve(answer('correction')); await h.agent.whenIdle()
    expect(h.errors).toEqual([])
    expect(deliveryTurn(h.agent, message.id)).toBe(1)
    expect(h.ctx.goals.get(h.agent)?.roundsStarted).toBe(1)
    expect(h.ctx.goals.get(h.agent)?.phase).toBe('paused')
    expect(h.requests).toHaveLength(1)
  })

  it('gives a classified correction to downstream guards and preserves their rejection', async () => {
    const h = await running([answer('correction')])
    const message = input('Do not modify files yet')
    let observed = false
    h.ctx.on('agent/pre-step', async ({ messages }, next) => {
      if (messages.some(item => item.id === message.id)) { observed = true; return { kind: 'reject' } }
      return next()
    })
    h.agent.followup(message); h.release.resolve(); await h.agent.whenIdle()
    expect(observed).toBe(true)
    expect(h.model.requests).toHaveLength(1)
    expect(committed(h.agent, message.id)).toHaveLength(0)
    expect([...h.agent.inbox.nextStep, ...h.agent.inbox.nextTurn].some(item => item.id === message.id)).toBe(true)
  })

  it('reclassifies an edit made while a downstream pre-step guard is awaiting', async () => {
    const h = await running([answer('correction'), answer('queue')])
    const message = input('Correct the work')
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let once = true
    h.ctx.on('agent/pre-step', async ({ messages }, next) => {
      if (once && messages.some(item => item.id === message.id)) { once = false; entered.resolve(); await release.promise }
      return next()
    })
    h.agent.followup(message); h.release.resolve(); await entered.promise
    expect(h.agent.inbox.replace(message.id, { ...message, content: [{ type: 'text', text: 'Instead do this as a later task' }] })).toBe(true)
    release.resolve(); await h.agent.whenIdle()
    expect(h.errors).toEqual([])
    expect(committed(h.agent, message.id)).toHaveLength(1)
    expect(JSON.stringify(committed(h.agent, message.id))).toContain('Instead do this as a later task')
    expect(deliveryTurn(h.agent, message.id)).toBe(2)
  })


  it('preserves the protected system head when input arrives before the first model request', async () => {
    const h = await harness([text('combined answer')], [answer('correction')], { 'interjection-routing': true })
    h.send('Original not yet committed task')
    const message = input('Correct the initial direction')
    h.agent.followup(message)
    await h.agent.whenIdle()
    expect(h.errors).toEqual([])
    expect(deliveryTurn(h.agent, message.id)).toBe(1)
    expect(JSON.stringify(h.requests[0].state.context)).toContain('Original not yet committed task')
    await h.ctx.sessionPersistence.flush()
    const reader = await h.ctx.sessionPersistence.open(h.agent.id, 'read')
    const persisted = await reader.read()
    await reader.close()
    const firstSurface = persisted.events.find(event => ['system/message', 'user/message', 'assistant/message', 'tool/result'].includes(event.type))
    expect(firstSurface?.type).toBe('system/message')
  })


  it('preserves a pending identity when the original queue control removes and steers it synchronously', async () => {
    const deferred = Promise.withResolvers<object>()
    const h = await running([() => deferred.promise])
    const message = input('Do the additional work later')
    h.agent.followup(message)
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    expect(h.agent.inbox.remove(message.id)).toBe(true)
    h.agent.steer(message)
    deferred.resolve(answer('queue')); h.release.resolve(); await h.agent.whenIdle()
    expect(h.errors).toEqual([])
    expect(committed(h.agent, message.id)).toHaveLength(1)
    expect(deliveryTurn(h.agent, message.id)).toBe(2)
    expect(h.requests).toHaveLength(1)
  })

  it('honors the original stop keepInbox behavior without awaiting a slow classifier or dropping unrelated input', async () => {
    const deferred = Promise.withResolvers<object>()
    const h = await running([() => deferred.promise])
    const message = input('Pending classified input')
    h.agent.followup(message)
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    await h.setFeatures({ 'interjection-routing': false })
    const unrelated = input('Retained ordinary queued input')
    h.agent.followup(unrelated)
    h.agent.cancel({ kind: 'user' }, { keepInbox: true })
    h.release.resolve()
    await h.agent.whenIdle()
    expect(committed(h.agent, message.id)).toHaveLength(0)
    expect(h.agent.inbox.nextTurn.some(item => item.id === unrelated.id)).toBe(true)
    expect(h.model.requests).toHaveLength(1)
    deferred.resolve(answer('correction'))
  })


  it('rechecks a correction arriving while another pre-step hook is still awaiting', async () => {
    const deferred = Promise.withResolvers<object>()
    const h = await running([() => deferred.promise])
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let once = true
    h.ctx.on('agent/pre-step', async ({ step }, next) => {
      if (once && step === 2) { once = false; entered.resolve(); await release.promise }
      return next()
    })
    h.release.resolve(); await entered.promise
    const message = input('Correct direction before the next request')
    h.agent.followup(message); release.resolve()
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    expect(h.model.requests).toHaveLength(1)
    deferred.resolve(answer('correction')); await h.agent.whenIdle()
    expect(h.errors).toEqual([])
    expect(committed(h.agent, message.id)).toHaveLength(1)
    expect(h.model.requests).toHaveLength(2)
  })


  it('cancels classification when Host stop arrives before the first pre-step hook', async () => {
    const h = await harness([text('must not run')], [answer('correction')], { 'interjection-routing': true })
    h.send('Initial task')
    const message = input('Immediate correction')
    h.agent.followup(message)
    h.agent.cancel({ kind: 'user' }, { keepInbox: true })
    await h.agent.whenIdle()
    expect(h.model.requests).toHaveLength(0)
    expect(committed(h.agent, message.id)).toHaveLength(0)
    expect([...h.agent.inbox.nextTurn, ...h.agent.inbox.nextStep].some(item => item.id === message.id)).toBe(false)
  })

})
