import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import Subagents from '@deepseek-ai/dsh-subagent'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import type { Agent } from '@deepseek-ai/dsh-agent'
import JevService from '../src/index.ts'
import * as Shared from '../src/shared-findings.ts'
import { SharedFindingsStore, sharedFindingsSpec } from '../src/shared-findings-store.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors)
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
class Query extends SessionQuery {
  searchSessions(): Promise<never> { return Promise.reject(new Error('not used')) }
  searchEvents(): Promise<never> { return Promise.reject(new Error('not used')) }
}
class FakeModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly next = new Map<string, StreamChunk[]>()
  readonly gates = new Map<string, ReturnType<typeof deferred>>()
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const scripted = this.next.get(options.sessionId ?? '')
    if (scripted !== undefined) { this.next.delete(options.sessionId ?? ''); yield* scripted; return }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Private exploration' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Private exploration' } }
    const gate = this.gates.get(options.sessionId ?? '')
    if (gate) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('cancelled'))
        options.signal?.addEventListener('abort', abort, { once: true })
        void gate.promise.then(() => { options.signal?.removeEventListener('abort', abort); resolve() })
        if (options.signal?.aborted) abort()
      })
      if (this.gates.get(options.sessionId ?? '') === gate) this.gates.delete(options.sessionId ?? '')
    }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    const text = JSON.stringify(options.messages).includes('SOURCE_A') ? 'Report A' : JSON.stringify(options.messages).includes('SOURCE_B') ? 'Report B' : 'Acknowledged.'
    yield { type: 'text-delta', index: 1, text }
    yield { type: 'block-end', index: 1, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function fixture(kind = 'unrelated', enabled = true) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-shared-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  let replyKind = kind
  let responseGate: ReturnType<typeof deferred> | undefined
  const requests: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    await responseGate?.promise
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ answers: { relation: { choice: replyKind }, ...body.questions?.basis === undefined ? {} : { basis: { choice: replyKind === 'replacement' ? 'line-1' : 'none' } } } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { responseGate?.resolve(); await new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections() })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('port unavailable')
  const ctx = new Context()
  let mountedFeature: { dispose: () => Promise<void> } | undefined
  cleanups.push(async () => {
    await mountedFeature?.dispose()
    await ctx.subagents.drainContinuableDescendants(ctx.agents.roots())
    await ctx.fiber.dispose()
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlPersistence, { root: join(dir, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Query)
  ctx.provide('settings', { configure: () => () => {} } as never)
  await ctx.plugin(Subagents, {})
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('json', new JsonStorageBackend(join(dir, 'storage')))
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'json' }))
  ctx.provide('profileContext', { dir } as never)
  ctx.provide('credentials', { resolve: async () => ({ value: 'fake-only', source: 'fixture' }), describe: async () => ({ configured: true, writable: true }) } as never)
  await ctx.plugin(UserQuestions)
  const common = await ctx.plugin(JevService, { baseUrl: `http://127.0.0.1:${address.port}/v1/systemone`, model: 'fake-judge', credentialRef: 'FAKE_KEY', timeoutMs: 10000, features: { 'shared-findings': enabled } })
  const opened = vi.spyOn(ctx.storageDomain, 'open')
  const feature = await ctx.plugin(Shared)
  mountedFeature = feature
  const model = new FakeModel()
  ctx.llm.registerAdapter(['fixture'], model)
  const root = await ctx.agentLoop.create(SessionId('root'), { provider: 'fixture', model: 'fixture' })
  const business = await opened.mock.results[0]!.value
  async function child(id: string, parent = root) {
    const gate = deferred(); model.gates.set(id, gate)
    const result = await ctx.subagents.startContinuable({ provider: 'spawn', label: id, childId: SessionId(id),
      request: { parent, maxDepth: 3, prompt: [{ type: 'text', text: 'Work on ' + id }] }, signal: new AbortController().signal })
    const agent = ctx.agents.get(result.childId)!
    await vi.waitFor(() => expect(model.requests.some(request => request.sessionId === id)).toBe(true))
    return { agent, gate }
  }
  async function send(sender: Agent, target: Agent, text: string) {
    return ctx.subagents.sendMessage(sender, target.id, [{ type: 'text', text }], { signal: new AbortController().signal })
  }
  return { ctx, root, model, child, send, requests, business, feature, dir, common,
    setKind: (value: string) => { replyKind = value },
    holdJudge: () => { responseGate = deferred(); return responseGate },
    findings: () => [...business.table('findings').entries()].map(([, value]) => value),
    relations: () => [...business.table('relations').entries()].map(([, value]) => value),
  }
}

it('defaults off and leaves shared messages on their original model path', async () => {
  const f = await fixture('replacement', false)
  const child = await f.child('child')
  await f.send(child.agent, f.root, 'Shared old report')
  await f.send(child.agent, f.root, 'Shared new report')
  await f.root.whenIdle()
  expect(f.requests).toHaveLength(0)
  expect(f.findings()).toHaveLength(0)
  expect(f.root.session.deriveMessages().some(message => JSON.stringify(message).includes('Shared new report'))).toBe(true)
})

it('observes only already shared originals and records actual model reception separately', async () => {
  const f = await fixture()
  const child = await f.child('child')
  expect(f.findings()).toHaveLength(0)
  await f.send(child.agent, f.root, 'Shared report only')
  await vi.waitFor(() => expect(f.findings()[0]?.recipients[0]?.state).toBe('model-received'))
  expect(f.findings()).toHaveLength(1)
  expect(f.findings()[0]!.original).not.toContain('Private exploration')
  expect(f.findings()[0]!.recipients[0]!.adopted).toBe('unknown')
  expect(f.requests).toHaveLength(0)
})

it('keeps conflict originals and asks only the root to arrange verification', async () => {
  const f = await fixture('conflict')
  const a = await f.child('a')
  const b = await f.child('b')
  await f.send(a.agent, f.root, 'Result A: test fails. Evidence log A.')
  await f.send(b.agent, f.root, 'Result B: test passes. Evidence log B.')
  await vi.waitFor(() => expect(f.relations()[0]?.deliveries[0]?.state).toMatch(/queued|model-received/))
  expect(f.findings().map(item => item.supersededBy)).toEqual([undefined, undefined])
  expect(f.ctx.agents.get(SessionId('a'))).toBe(a.agent)
  expect(f.ctx.agents.get(SessionId('b'))).toBe(b.agent)
  expect(f.relations()[0]!.deliveries.map(item => item.recipientId)).toEqual(['root'])
  await f.root.whenIdle()
  expect(JSON.stringify(f.model.requests.filter(request => request.sessionId === 'root'))).toContain('use your existing tools or delegation')
})

it('does not auto-deliver a correction to an agent that never received the old original', async () => {
  const f = await fixture('replacement')
  const a = await f.child('a')
  const b = await f.child('b')
  await f.send(a.agent, f.root, 'Tests cannot run.')
  await f.send(b.agent, f.root, 'Environment repaired; test suite now runs.\nEvidence: complete passing output.')
  await vi.waitFor(() => expect(f.relations()[0]?.kind).toBe('replacement'))
  await vi.waitFor(() => expect(f.relations()[0]?.deliveries[0]?.state).toMatch(/queued|model-received/))
  expect(f.relations()[0]!.deliveries.map(item => item.recipientId)).toEqual(['root'])
  expect(f.findings()[0]!.supersededBy).toBe(f.findings()[1]!.id)
})

it('does not rerun a relationship when the same shared source is delivered twice', async () => {
  const f = await fixture('support')
  const a = await f.child('a')
  await f.send(a.agent, f.root, 'Old source')
  await f.send(a.agent, f.root, 'New source with supporting evidence')
  await f.send(a.agent, f.root, 'New source with supporting evidence')
  await vi.waitFor(() => expect(f.findings().find(item => item.original.includes('New source'))?.messageIds).toHaveLength(2))
  expect(f.requests).toHaveLength(1)
  expect(f.relations()).toHaveLength(1)
  expect(f.relations()[0]!.deliveries).toHaveLength(0)
})

it('compares only current findings and carries actual recipients through three successive originals', async () => {
  const f = await fixture('replacement')
  const holder = await f.child('holder')
  const reporter = await f.child('reporter')
  await f.send(f.root, holder.agent, 'A: tests cannot run.\nEvidence: missing environment.')
  await vi.waitFor(() => expect(f.findings()).toHaveLength(1))
  await f.send(reporter.agent, f.root, 'B: tests now run.\nEvidence: repaired environment and passing test log.')
  await vi.waitFor(() => expect(f.relations()[0]?.deliveries[0]?.state).toBe('queued'))
  const a = f.findings().find(item => item.original.includes('A: tests'))!
  const firstDelivery = f.relations()[0]!.deliveries[0]!
  await vi.waitFor(() => expect(f.findings().find(item => item.original.includes('B: tests'))?.recipients)
    .toContainEqual({ agentId: 'holder', messageId: firstDelivery.messageId, state: 'queued', adopted: 'unknown' }))
  const b = f.findings().find(item => item.original.includes('B: tests'))!
  expect(b.messageIds).not.toContain(firstDelivery.messageId)
  await f.send(reporter.agent, f.root, 'C: a further regression prevents execution.\nEvidence: the new runtime log fails before tests start.')
  await vi.waitFor(() => expect(f.relations()[1]?.deliveries.some(item => item.recipientId === 'holder' && item.state === 'queued')).toBe(true))
  await vi.waitFor(() => expect(f.findings().find(item => item.original.includes('C: a further'))?.recipients.some(item => item.agentId === 'holder' && item.state === 'queued')).toBe(true))
  const c = f.findings().find(item => item.original.includes('C: a further'))!
  expect(f.requests).toHaveLength(2)
  expect(f.relations().map(item => [item.olderId, item.newerId])).toEqual([[a.id, b.id], [b.id, c.id]])
  expect(f.findings().find(item => item.id === a.id)?.supersededBy).toBe(b.id)
  expect(f.findings().find(item => item.id === b.id)?.supersededBy).toBe(c.id)
  expect(c.recipients.some(item => item.agentId === 'holder' && item.state === 'queued')).toBe(true)
  expect(f.findings()).toHaveLength(3)
  holder.gate.resolve()
  await vi.waitFor(() => expect(f.findings().find(item => item.id === c.id)?.recipients.some(item => item.agentId === 'holder' && item.state === 'model-received')).toBe(true))
  expect(f.findings().flatMap(item => item.recipients).every(item => item.adopted === 'unknown')).toBe(true)
  const holderInputs = JSON.stringify(f.model.requests.filter(request => request.sessionId === 'holder'))
  expect(holderInputs).toContain('Jev plugin-generated')
  expect(holderInputs).toContain('parent-agent message channel')
  expect(holderInputs).toContain('Replacement original:\\nAgent reporter sent a message: \\nC:')
})

it('does not send a reporter its own replacement or infer that the reporter adopted it', async () => {
  const f = await fixture('replacement')
  const reporter = await f.child('reporter')
  await f.send(f.root, reporter.agent, 'Old finding: test cannot run.')
  await vi.waitFor(() => expect(f.findings()).toHaveLength(1))
  const sends = vi.spyOn(f.ctx.subagents, 'sendMessage')
  await f.send(reporter.agent, f.root, 'New finding: test runs.\nEvidence: repaired environment and passing log.')
  await f.root.whenIdle()
  expect(f.relations()[0]?.kind).toBe('replacement')
  expect(f.relations()[0]!.deliveries).toEqual([])
  expect(sends.mock.calls.filter(call => call[1] === reporter.agent.id)).toEqual([])
  const newer = f.findings().find(item => item.senderId === reporter.agent.id)!
  expect(newer.recipients.map(item => item.agentId)).toEqual(['root'])
  expect(newer.recipients[0]!.adopted).toBe('unknown')
  reporter.gate.resolve()
  await vi.waitFor(() => expect(f.model.requests.filter(request => request.sessionId === 'reporter').length).toBeGreaterThan(1))
  expect(JSON.stringify(f.model.requests.filter(request => request.sessionId === 'reporter'))).not.toContain('Queued finding has been superseded')
})

it('records a late recipient only after its current-replacement notice reaches the model and carries it forward', async () => {
  const f = await fixture('replacement')
  const holder = await f.child('holder')
  const late = await f.child('late')
  const reporter = await f.child('reporter')
  const old = 'Old finding: tests cannot run.'
  await f.send(f.root, holder.agent, old)
  await vi.waitFor(() => expect(f.findings()).toHaveLength(1))
  await f.send(reporter.agent, f.root, 'Second finding: tests run.\nEvidence: repaired environment and passing log.')
  await vi.waitFor(() => expect(f.relations()[0]?.deliveries[0]?.state).toBe('queued'))
  const second = f.findings().find(item => item.original.includes('Second finding'))!
  await f.send(f.root, late.agent, old)
  await vi.waitFor(() => expect(f.findings().find(item => item.original.includes(old))?.recipients.some(item => item.agentId === 'late')).toBe(true))
  expect(f.findings().find(item => item.id === second.id)!.recipients.some(item => item.agentId === 'late')).toBe(false)
  const admitted = deferred()
  const prepared = deferred()
  cleanups.push(async () => { admitted.resolve() })
  late.agent.ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    prepared.resolve()
    await admitted.promise
    return decision
  })
  const nextCall = deferred()
  late.gate.resolve()
  f.model.gates.set('late', nextCall)
  await prepared.promise
  expect(f.findings().find(item => item.id === second.id)!.recipients.some(item => item.agentId === 'late')).toBe(false)
  admitted.resolve()
  await vi.waitFor(() => expect(f.findings().find(item => item.id === second.id)?.recipients.some(item => item.agentId === 'late' && item.state === 'model-received')).toBe(true))
  const receipt = f.findings().find(item => item.id === second.id)!.recipients.find(item => item.agentId === 'late')!
  const notice = late.agent.session.deriveMessages().find(message => message.id === receipt.messageId)
  expect(JSON.stringify(notice)).toContain('Queued finding has been superseded')
  expect(receipt.adopted).toBe('unknown')
  await f.send(reporter.agent, f.root, 'Third finding: the environment failed again.\nEvidence: fresh startup failure.')
  await vi.waitFor(() => expect(f.relations().some(item => item.olderId === second.id && item.deliveries.some(delivery => delivery.recipientId === 'late' && delivery.state === 'queued'))).toBe(true))
})

it('states factual-only relation rules and retains a reported restatement as support without another correction', async () => {
  const f = await fixture('replacement')
  const holder = await f.child('holder')
  const reporter = await f.child('reporter')
  await f.send(f.root, holder.agent, 'Old finding: test cannot run.')
  await vi.waitFor(() => expect(f.findings()).toHaveLength(1))
  await f.send(reporter.agent, f.root, 'New finding: test runs.\nEvidence: repaired environment and passing log.')
  await vi.waitFor(() => expect(f.relations()[0]?.deliveries[0]?.state).toBe('queued'))
  f.setKind('support')
  await f.send(holder.agent, f.root, 'Received the correction: the test now runs after the environment repair.')
  await f.root.whenIdle()
  expect(f.requests).toHaveLength(2)
  expect(f.relations()[1]?.kind).toBe('support')
  expect(f.relations()[1]!.deliveries).toEqual([])
  const input = JSON.stringify(f.requests[1])
  expect(input).toContain('requests to stop')
  expect(input).toContain('acknowledgements')
  expect(input).toContain('including a restatement after a correction, is support, not replacement')
  expect(input).toContain('either original contains only these')
  expect(f.requests[1]).toMatchObject({ questions: { relation: {
    instructions: expect.stringContaining('requests to stop'),
  } } })
  f.setKind('unrelated')
  await f.send(f.root, holder.agent, 'STOP: stop work and only acknowledge receipt.')
  await vi.waitFor(() => expect(f.relations()).toHaveLength(4))
  await vi.waitFor(() => expect(f.relations().slice(2).every(item => item.kind === 'unrelated')).toBe(true))
  expect(f.relations().slice(1).every(item => item.deliveries.length === 0)).toBe(true)
})

it('waits at actual message admission while the shared relation is unresolved', async () => {
  const f = await fixture('support')
  const a = await f.child('a')
  await f.send(a.agent, f.root, 'Old claim')
  await f.root.whenIdle()
  const gate = f.holdJudge()
  await f.send(a.agent, f.root, 'New claim')
  await vi.waitFor(() => expect(f.requests).toHaveLength(1))
  expect(f.root.session.deriveMessages().some(message => JSON.stringify(message).includes('New claim'))).toBe(false)
  gate.resolve()
  await vi.waitFor(() => expect(f.root.session.deriveMessages().some(message => JSON.stringify(message).includes('New claim'))).toBe(true))
})

it('delivers once at the active direct child boundary without cancelling its current model call', async () => {
  const f = await fixture('replacement')
  const holder = await f.child('holder')
  const reporter = await f.child('reporter')
  await f.send(f.root, holder.agent, 'Old finding: test is unavailable.')
  await vi.waitFor(() => expect(f.findings()).toHaveLength(1))
  await f.send(reporter.agent, f.root, 'New finding: repaired environment; test ran.\nEvidence: passing log.')
  await vi.waitFor(() => expect(f.relations()[0]?.deliveries[0]?.state).toBe('queued'))
  expect(f.relations()[0]!.deliveries[0]!.recipientId).toBe('holder')
  expect(holder.agent.status).toBe('running')
  expect(f.model.gates.has('holder')).toBe(true)
  holder.gate.resolve()
  await vi.waitFor(() => expect(f.model.requests.filter(request => request.sessionId === 'holder').length).toBeGreaterThan(1))
  expect(JSON.stringify(f.model.requests.filter(request => request.sessionId === 'holder'))).toContain('queued original is superseded')
})

it('skips a recipient ending during judgment and never cold-resumes it', async () => {
  const f = await fixture('replacement')
  const holder = await f.child('holder')
  const reporter = await f.child('reporter')
  await f.send(f.root, holder.agent, 'Old finding: test is unavailable.')
  await vi.waitFor(() => expect(f.findings()).toHaveLength(1))
  const secondCall = deferred()
  holder.gate.resolve()
  f.model.gates.set('holder', secondCall)
  await vi.waitFor(() => expect(f.findings()[0]?.recipients[0]?.state).toBe('model-received'))
  const gate = f.holdJudge()
  await f.send(reporter.agent, f.root, 'New finding: repaired environment; test ran.\nEvidence: passing log.')
  await vi.waitFor(() => expect(f.requests).toHaveLength(1))
  holder.agent.cancel({ kind: 'user' })
  holder.gate.resolve()
  await vi.waitFor(() => expect(f.ctx.agents.get(holder.agent.id) === undefined).toBe(true))
  const starts: string[] = []
  f.ctx.on('subagent/start', info => { starts.push(info.id) })
  gate.resolve()
  await vi.waitFor(() => expect(f.relations()[0]?.deliveries.some(item => item.recipientId === 'holder' && item.state === 'not-delivered')).toBe(true))
  expect(starts).not.toContain('holder')
  expect(f.ctx.agents.get(holder.agent.id) === undefined).toBe(true)
})

it('aborts a correction that loses the public send-versus-disposal race without cold-resuming', async () => {
  const f = await fixture('replacement')
  const holder = await f.child('holder')
  const reporter = await f.child('reporter')
  await f.send(f.root, holder.agent, 'Old finding: test is unavailable.')
  await vi.waitFor(() => expect(f.findings()).toHaveLength(1))
  const secondCall = deferred()
  holder.gate.resolve()
  f.model.gates.set('holder', secondCall)
  await vi.waitFor(() => expect(f.findings()[0]?.recipients[0]?.state).toBe('model-received'))
  const flushGate = deferred()
  const flushEntered = deferred()
  cleanups.push(async () => { flushGate.resolve() })
  holder.agent.ctx.effect(() => async () => { flushEntered.resolve(); await flushGate.promise })
  holder.agent.cancel({ kind: 'user' })
  holder.gate.resolve()
  await flushEntered.promise
  expect(f.ctx.agents.get(holder.agent.id)).toBe(holder.agent)
  const sendSpy = vi.spyOn(f.ctx.subagents, 'sendMessage')
  const starts: string[] = []
  f.ctx.on('subagent/start', info => { starts.push(info.id) })
  await f.send(reporter.agent, f.root, 'New finding: repaired environment; test ran.\nEvidence: passing log.')
  await vi.waitFor(() => expect(sendSpy.mock.calls.some(call => call[1] === holder.agent.id)).toBe(true))
  flushGate.resolve()
  await vi.waitFor(() => expect(f.ctx.agents.get(holder.agent.id) === undefined).toBe(true))
  await f.root.whenIdle()
  expect(starts).not.toContain('holder')
  expect(f.relations()[0]!.deliveries[0]!.state).toBe('unconfirmed')
})

it('observes a foreground report only after the real native subagent tool returns it', async () => {
  const f = await fixture('support')
  const reporter = await f.child('reporter')
  await f.send(reporter.agent, f.root, 'Previously shared finding')
  await f.root.whenIdle()
  await f.ctx.plugin(ToolSubagent, { provider: 'spawn', modelSelectionSettings: false, enableRunInBackground: false })
  f.model.next.set('root', [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('native-delegation'), name: 'subagent', arguments: JSON.stringify({ description: 'read evidence', prompt: 'Return a finding' }) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
  f.root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Delegate evidence reading' }] }))
  await f.root.whenIdle()
  await vi.waitFor(() => expect(f.findings().some(item => item.source === 'tool-report')).toBe(true))
  const finding = f.findings().find(item => item.source === 'tool-report')!
  expect(finding.toolCallId).toBe('native-delegation')
  expect(finding.original).toContain('Acknowledged.')
  expect(f.ctx.agents.get(SessionId(finding.senderId)) === undefined).toBe(true)
  expect(f.relations()).toHaveLength(1)
})

it('uses the live root for failure decisions and cancellation does not resume dependent input or cancel unrelated work', async () => {
  const f = await fixture('unknown')
  const a = await f.child('a')
  await f.send(a.agent, f.root, 'Old unresolved evidence')
  await f.root.whenIdle()
  const answer = deferred()
  const asked: string[] = []
  f.ctx.on('user-questions/request', async request => {
    asked.push(request.agent!.id)
    await answer.promise
    return { answers: [{ id: 'jev-resolution', selected: ['取消 / Cancel'] }] }
  })
  await f.send(a.agent, f.root, 'New unresolved evidence')
  await vi.waitFor(() => expect(asked).toEqual(['root']))
  expect(f.root.session.deriveMessages().some(message => JSON.stringify(message).includes('New unresolved evidence'))).toBe(false)
  answer.resolve()
  await f.root.whenIdle()
  expect(f.relations()[0]!.state).toBe('unresolved')
  expect(f.relations()[0]!.deliveries).toHaveLength(0)
  expect(f.findings().every(item => item.supersededBy === undefined)).toBe(true)
  f.root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Independent new user work' }] }))
  await f.root.whenIdle()
  expect(JSON.stringify(f.model.requests.at(-1))).toContain('Independent new user work')
  expect(JSON.stringify(f.model.requests)).not.toContain('New unresolved evidence')
})

it('requires enabling before a manual retry and does not issue a disabled retry', async () => {
  const f = await fixture('unknown')
  const a = await f.child('a')
  await f.send(a.agent, f.root, 'Old finding')
  await f.root.whenIdle()
  const decision = deferred()
  let asks = 0
  f.ctx.on('user-questions/request', async () => {
    asks++
    if (asks === 1) { await decision.promise; return { answers: [{ id: 'jev-resolution', selected: ['重试 / Retry'] }] } }
    return { answers: [{ id: 'jev-resolution', selected: ['取消 / Cancel'] }] }
  })
  await f.send(a.agent, f.root, 'New finding')
  await vi.waitFor(() => expect(asks).toBe(1))
  updateVolatile(f.common.config.features, createVolatile({ 'shared-findings': false }))
  decision.resolve()
  await f.root.whenIdle()
  expect(asks).toBe(2)
  expect(f.requests).toHaveLength(1)
  expect(f.relations()[0]!.state).toBe('unresolved')
})

it('does not repeat a sent correction after its common receipt fails or feature reloads', async () => {
  const f = await fixture('replacement')
  const a = await f.child('a')
  const b = await f.child('b')
  await f.send(f.root, a.agent, 'Old finding')
  await vi.waitFor(() => expect(f.findings()).toHaveLength(1))
  const original = f.ctx.jev.writeReceipt.bind(f.ctx.jev)
  vi.spyOn(f.ctx.jev, 'writeReceipt').mockImplementation((operation, receipt) => receipt.id.endsWith('-queued')
    ? Promise.reject(new Error('fixture receipt write failure')) : original(operation, receipt))
  const sends = vi.spyOn(f.ctx.subagents, 'sendMessage')
  await f.send(b.agent, f.root, 'New finding with explicit evidence')
  await vi.waitFor(() => expect(f.relations()[0]?.deliveries[0]?.messageId).toBeDefined())
  await f.feature.dispose()
  await f.ctx.plugin(Shared)
  expect(sends.mock.calls.filter(call => call[1] === a.agent.id)).toHaveLength(1)
  expect(f.requests).toHaveLength(1)
})

it('reports a grandchild holder to the root without sending a correction across the direct-child limit', async () => {
  const f = await fixture('replacement')
  const middle = await f.child('middle')
  const holder = await f.child('grandchild', middle.agent)
  const reporter = await f.child('reporter')
  await f.send(middle.agent, holder.agent, 'Old finding')
  await vi.waitFor(() => expect(f.findings()).toHaveLength(1))
  const sends = vi.spyOn(f.ctx.subagents, 'sendMessage')
  await f.send(reporter.agent, f.root, 'New finding with evidence')
  await vi.waitFor(() => expect(f.relations()[0]?.deliveries.some(item => item.recipientId === 'grandchild' && item.state === 'not-delivered')).toBe(true))
  expect(sends.mock.calls.some(call => call[1] === holder.agent.id)).toBe(false)
  await vi.waitFor(() => expect(f.relations()[0]?.deliveries.some(item => item.recipientId === 'root')).toBe(true))
})

it('keeps simultaneous source queues distinct and does not compare findings across live roots', async () => {
  const f = await fixture('support')
  const a = await f.child('a')
  const b = await f.child('b')
  const secondRoot = await f.ctx.agentLoop.create(SessionId('second-root'), { provider: 'fixture', model: 'fixture' })
  const c = await f.child('c', secondRoot)
  await Promise.all([
    f.send(a.agent, f.root, 'First source'), f.send(b.agent, f.root, 'Second source'),
    f.send(a.agent, f.root, 'Third source'), f.send(c.agent, secondRoot, 'Other root source'),
  ])
  await vi.waitFor(() => expect(f.relations()).toHaveLength(3))
  await vi.waitFor(() => expect(f.relations().every(item => item.state === 'resolved')).toBe(true))
  expect(new Set(f.relations().map(item => item.id)).size).toBe(3)
  expect(f.relations().every(item => item.rootId === 'root')).toBe(true)
  expect(f.requests).toHaveLength(3)
})

it('marks persisted pending relations interrupted without replaying old judgments or messages', async () => {
  const f = await fixture('support')
  await f.feature.dispose()
  const store = await SharedFindingsStore.open(f.ctx.storageDomain, f.dir)
  await store.saveRelation({ id: 'interrupted-fixture', rootId: 'root', olderId: 'old', newerId: 'new', state: 'pending', deliveries: [{ recipientId: 'child', state: 'unconfirmed', adopted: 'unknown' }], at: new Date().toISOString() })
  await store.close()
  const reopened = await SharedFindingsStore.open(f.ctx.storageDomain, f.dir)
  expect(reopened.relation('interrupted-fixture')!.state).toBe('interrupted')
  expect(reopened.relation('interrupted-fixture')!.deliveries[0]!.state).toBe('unconfirmed')
  expect(f.requests).toHaveLength(0)
  expect(f.model.requests).toHaveLength(0)
  await reopened.close()
})

it('does not adopt a judgment when a direct user correction is pending in the root inbox', async () => {
  const f = await fixture('replacement')
  const a = await f.child('a')
  await f.send(a.agent, f.root, 'Old finding')
  await f.root.whenIdle()
  const gate = f.holdJudge()
  await f.send(a.agent, f.root, 'New finding with evidence')
  await vi.waitFor(() => expect(f.requests).toHaveLength(1))
  f.root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Correction: this task now concerns a different environment.' }] }))
  expect(f.root.inbox.nextTurn.length).toBeGreaterThan(0)
  gate.resolve()
  await f.root.whenIdle()
  expect(f.relations()[0]!.state).toBe('unresolved')
  expect(f.relations()[0]!.deliveries).toHaveLength(0)
  expect(f.findings().every(item => item.supersededBy === undefined)).toBe(true)
})

it('retains oversized originals but never adopts a truncated relation and asks the root', async () => {
  const f = await fixture('unknown')
  const a = await f.child('a')
  await f.send(a.agent, f.root, 'Old finding')
  await f.root.whenIdle()
  const asked: string[] = []
  f.ctx.on('user-questions/request', async request => {
    asked.push(request.agent!.id)
    return { answers: [{ id: 'jev-resolution', selected: ['取消 / Cancel'] }] }
  })
  const report = 'Evidence line\n'.repeat(8000)
  await f.send(a.agent, f.root, report)
  await f.root.whenIdle()
  expect(asked).toEqual(['root'])
  expect(JSON.stringify(f.requests[0]).length).toBeLessThan(48_000)
  expect(JSON.stringify(f.requests[0])).toContain('originalsOmitted')
  expect(f.findings()[1]!.original).toContain(report)
  expect(f.relations()[0]!.state).toBe('unresolved')
  expect(f.relations()[0]!.deliveries).toHaveLength(0)
})

it('binds concurrent same-label background reports by execution and job identity, not arrival order', async () => {
  const f = await fixture('support')
  await f.ctx.plugin(JobsLocal)
  await f.ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  await f.ctx.plugin(ToolSubagent, { provider: 'spawn', modelSelectionSettings: false })
  const calls = (items: { id: string; name: string; arguments: object }[]): StreamChunk[] => [
    ...items.flatMap((item, index): StreamChunk[] => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(item.id), name: item.name, arguments: JSON.stringify(item.arguments) } },
    ]),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  f.model.next.set('root', calls([
    { id: 'launch-A', name: 'subagent', arguments: { description: 'identical label', prompt: 'SOURCE_A', run_in_background: true } },
    { id: 'launch-B', name: 'subagent', arguments: { description: 'identical label', prompt: 'SOURCE_B', run_in_background: true } },
  ]))
  f.root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Start two background reports' }] }))
  await f.root.whenIdle()
  await vi.waitFor(() => expect(f.ctx.jobs.list(f.root.id).filter(job => job.status === 'completed')).toHaveLength(2))
  expect(f.findings()).toHaveLength(0)
  const sources = [...f.business.table('background_sources').entries()].map(([, value]) => value)
  expect(sources).toHaveLength(2)
  expect(sources.every(source => source.childIds.length === 1)).toBe(true)
  const a = sources.find(source => source.sourceCallId === 'launch-A')!
  const b = sources.find(source => source.sourceCallId === 'launch-B')!
  expect(a.childIds[0]).not.toBe(b.childIds[0])
  f.model.next.set('root', calls([
    { id: 'read-B', name: 'job_output', arguments: { job_id: b.jobId } },
    { id: 'read-A', name: 'job_output', arguments: { job_id: a.jobId } },
  ]))
  f.root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read both finished reports' }] }))
  await f.root.whenIdle()
  await vi.waitFor(() => expect(f.findings()).toHaveLength(2))
  expect(f.findings().find(item => item.toolCallId === 'read-A')!.senderId).toBe(a.childIds[0])
  expect(f.findings().find(item => item.toolCallId === 'read-B')!.senderId).toBe(b.childIds[0])
  expect(f.findings().find(item => item.toolCallId === 'read-A')!.original).toContain('Report A')
  expect(f.findings().find(item => item.toolCallId === 'read-B')!.original).toContain('Report B')
  expect(f.relations()).toHaveLength(1)
})
