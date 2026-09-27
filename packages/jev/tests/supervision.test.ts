import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
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
import * as supervision from '../src/supervision.ts'

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
const answer = (value: string) => ({ answers: { assessment: { choice: value }, evidence: { choice: '$first' } } })
type Reply = object | (() => Promise<object>)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function harness(script: Entry[], replies: Reply[], features: Record<string, boolean> = {}, counts = {}, resume?: { root: string; id: ReturnType<typeof SessionId> }) {
  const root = resume?.root ?? await mkdtemp(join(tmpdir(), 'jev-supervision-'))
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
    const encoded = JSON.stringify(result).replace('"$first"', JSON.stringify(Object.keys(requests.at(-1).questions.evidence.criteria)[0]))
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
  const common = await ctx.plugin(JevService, {
    baseUrl: `http://127.0.0.1:${address.port}/v1/systemone`, model: 'jev-local', credentialRef: 'JEV_TEST_KEY', timeoutMs: 2_000, features,
  })
  await ctx.plugin(supervision, counts)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  const model = new Model(script)
  ctx.llm.registerAdapter(['fixture'], model)
  ctx.tools.register(defineTool({ name: 'probe', description: 'Record a deterministic investigation', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] }, execute: async () => 'No source change; investigation result' }))
  const agent = resume === undefined
    ? await ctx.agentLoop.create(SessionId('supervision-fixture'), { provider: 'fixture', model: 'fixture' })
    : (await ctx.agentLoop.resume(ctx, { resumeSessionId: resume.id, agentOptions: { provider: 'fixture', model: 'fixture' } })).agent
  let disposed = false
  const dispose = async () => { if (disposed) return; disposed = true; await ctx.fiber.dispose(); unregister(); await facility.closeAll(); await backend.close() }
  cleanups.push(dispose)
  const send = (value: string) => agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] }))
  const records = () => ctx.jev.listRecords({ sessionId: agent.id, limit: 100 })
  return { ctx, agent, model, requests, send, records, errors, dispose, features: common.config.features, root }
}
const visible = (agent: Agent) => agent.session.deriveMessages().flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')

describe('supervision through real AgentLoop, goal driver, tools and HTTP Jev', () => {
  it('registers independent disabled switches and count defaults without making requests', async () => {
    const h = await harness([text('done')], [])
    expect((await h.ctx.jev.listFeatures()).map(feature => [feature.id, feature.enabled])).toEqual([
      ['drift-monitoring', false], ['completion-check', false], ['goal-supervision', false],
    ])
    expect(supervision.Config({}).driftInterval.get()).toBe(6)
    expect(supervision.Config({}).noProgressRounds.get()).toBe(3)
    expect(() => supervision.Config({ driftInterval: 0 })).toThrow()
    h.send('Do the task'); await h.agent.whenIdle()
    expect(h.requests).toHaveLength(0)
  })

  it('shows the original answer, performs one supplement, then stops on remaining omissions', async () => {
    const h = await harness([text('I am done'), text('Still no test result')], [answer('omission'), answer('omission')], { 'completion-check': true })
    h.send('Implement and test it'); await h.agent.whenIdle()
    expect(h.model.requests).toHaveLength(2)
    expect(h.requests).toHaveLength(2)
    const content = visible(h.agent)
    expect(content.indexOf('I am done')).toBeLessThan(content.indexOf('Complete these omissions once'))
    expect(content).toContain('Correct final factual claims contradicted by recorded evidence')
    expect(content).toContain('without unauthorized rollback, deletion, or file changes')
    expect(content).toContain('No further automatic work')
    const records = await h.records()
    expect(records.items).toHaveLength(2)
    const details = await Promise.all(records.items.map(record => h.ctx.jev.getRecord(record.id)))
    expect(details.filter(record => record?.receipts.some(receipt => receipt.id === 'supplement-reserved'))).toHaveLength(1)
  })

  it('sends completion evidence rules and distinct assessment criteria to the judge', async () => {
    const h = await harness([call('inspect'), text('Investigation finished')], [answer('complete')], { 'completion-check': true })
    h.send('Inspect only; do not repair files'); await h.agent.whenIdle()
    expect(h.requests).toHaveLength(1)
    const request = h.requests[0]
    expect(request.state.completeEvidence).toBe(true)
    expect(JSON.stringify(request.state.messages)).toContain('No source change; investigation result')
    expect(request.state.rules).toContain('A final factual claim contradicted by recorded evidence is an omission requiring correction')
    expect(request.state.rules).toContain('complete only work already allowed by the user')
    expect(request.state.rules).toContain('A reminder is not itself proof of a violation or a mandatory pause')
    expect(request.questions.assessment.instructions).toContain('A final factual claim contradicted by recorded evidence is an omission requiring correction')
    expect(request.questions.assessment.instructions).toContain('complete only work already allowed by the user')
    expect(request.questions.assessment.instructions).toContain('A reminder is not itself proof of a violation or a mandatory pause')
    expect(request.questions.assessment.criteria).toEqual({
      complete: expect.stringContaining('final factual claims are supported by recorded evidence'),
      omission: expect.stringContaining('a contradicted final factual claim'),
      'needs-user': expect.stringContaining('An unresolved decision or authorization from the user'),
      unknown: expect.stringContaining('recorded evidence is insufficient or omitted'),
    })
  })

  it('starts the sixth-step check without delaying the seventh model request and never wakes a completed task', async () => {
    let release!: (value: object) => void
    const waiting = new Promise<object>(resolve => { release = resolve })
    const h = await harness([...Array.from({ length: 6 }, (_, i) => call('probe-' + i)), text('done')], [() => waiting], { 'drift-monitoring': true })
    h.send('Investigate'); await h.agent.whenIdle()
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    expect(h.model.requests).toHaveLength(7)
    release(answer('drift'))
    await vi.waitFor(async () => expect((await h.records()).items[0]?.status).toBe('succeeded'))
    expect(h.model.requests).toHaveLength(7)
    expect(visible(h.agent)).not.toContain('Correction:')
  })

  it('delivers drift once in a later real step and leaves tools running', async () => {
    let h: Awaited<ReturnType<typeof harness>>
    h = await harness([call('one'), async () => {
      await vi.waitFor(async () => expect((await h.records()).items[0]?.status).toBe('succeeded'))
      return call('two')
    }, text('I did not change course')], [answer('drift'), answer('drift')], { 'drift-monitoring': true }, { driftInterval: 1 })
    h.send('Investigate'); await h.agent.whenIdle()
    expect(h.model.requests).toHaveLength(3)
    expect(visible(h.agent).match(/Correction:/g)).toHaveLength(1)
    expect(h.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(2)
  })

  it('records malformed background answers without a human wait or interruption', async () => {
    const h = await harness([call('one'), text('done')], [{ answers: {} }], { 'drift-monitoring': true }, { driftInterval: 1 })
    const ask = vi.fn(); h.ctx.on('user-questions/request', ask)
    h.send('Investigate'); await h.agent.whenIdle()
    await vi.waitFor(async () => expect((await h.records()).items.some(item => item.status === 'failed')).toBe(true))
    expect(ask).not.toHaveBeenCalled()
    expect(h.model.requests).toHaveLength(2)
  })

  it('pauses the native goal after three no-progress rounds without a second completion continuation', async () => {
    const h = await harness([text('same failure'), text('same failure'), text('same failure')], Array.from({ length: 3 }, () => answer('no-progress')), { 'goal-supervision': true, 'completion-check': true })
    h.ctx.goals.create(h.agent, { objective: 'Fix it', maxGoalRounds: 8 })
    await vi.waitFor(() => expect(h.ctx.goals.get(h.agent)?.phase).toBe('paused'))
    await h.agent.whenIdle()
    expect(h.ctx.goals.get(h.agent)?.roundsStarted).toBe(3)
    expect(h.model.requests).toHaveLength(3)
    expect(h.requests.map(request => request.state.mode)).toEqual(['progress', 'progress', 'progress'])
  })

  it('resets the consecutive count for new investigation evidence', async () => {
    const h = await harness(Array.from({ length: 6 }, () => text('investigation')), ['no-progress', 'no-progress', 'progress', 'no-progress', 'no-progress', 'no-progress'].map(value => answer(value)), { 'goal-supervision': true })
    h.ctx.goals.create(h.agent, { objective: 'Find root cause', maxGoalRounds: 9 })
    await vi.waitFor(() => expect(h.ctx.goals.get(h.agent)?.phase).toBe('paused'))
    expect(h.ctx.goals.get(h.agent)?.roundsStarted).toBe(6)
  })

  it('blocks the model complete tool but leaves native manual completion available', async () => {
    let h: Awaited<ReturnType<typeof harness>>
    h = await harness([() => {
      const goal = h.ctx.goals.get(h.agent)!
      return call('complete', 'update_goal', { action: 'complete', goal_id: goal.id, revision: goal.revision })
    }, text('Still pending')], [answer('omission'), answer('needs-user')], { 'goal-supervision': true })
    h.ctx.goals.create(h.agent, { objective: 'Test changes', maxGoalRounds: 8 })
    await vi.waitFor(() => expect(h.ctx.goals.get(h.agent)?.phase).toBe('paused'))
    const goal = h.ctx.goals.get(h.agent)!
    expect(visible(h.agent)).toContain('Jev:')
    h.ctx.goals.complete(h.agent, { id: goal.id, revision: goal.revision })
    expect(h.ctx.goals.get(h.agent)?.phase).toBe('complete')
  })

  it('keeps a failed completion check waiting and refreshes recorded evidence after manual retry', async () => {
    const h = await harness([text('done')], [{ answers: {} }, answer('complete')], { 'completion-check': true })
    let resolve!: (value: { answers: { id: string; selected: string[] }[] }) => void
    const asked = new Promise<void>(ready => { h.ctx.on('user-questions/request', () => { ready(); return new Promise(answer => { resolve = answer }) }) })
    h.send('Do it'); await asked
    expect(visible(h.agent)).toContain('done')
    expect(h.agent.status).toBe('running')
    resolve({ answers: [{ id: 'jev-resolution', selected: ['重试 / Retry'] }] })
    await h.agent.whenIdle()
    expect(h.requests).toHaveLength(2)
    expect((await h.ctx.jev.getRecord((await h.records()).items[0]!.id))?.attemptRecords).toHaveLength(2)
  })
  it('does not turn cropped evidence into a successful completion', async () => {
    const h = await harness([text('done')], [answer('complete')], { 'completion-check': true }, { evidenceChars: 30 })
    h.ctx.on('user-questions/request', async () => ({ answers: [{ id: 'jev-resolution', selected: ['取消 / Cancel'] }] }))
    h.send('Implement the full requirement with current tests'); await h.agent.whenIdle()
    expect(h.requests[0].state.completeEvidence).toBe(false)
    expect(h.requests[0].state.omittedMessages).toBeGreaterThan(0)
    const record = await h.ctx.jev.getRecord((await h.records()).items[0]!.id)
    expect(record?.status).toBe('cancelled')
    expect(record?.attemptRecords[0]?.failure?.code).toBe('UNDETERMINED')
    expect(record?.receipts).toHaveLength(0)
  })

  it('cancels a failed goal check, pauses native continuation, and keeps another queued user request', async () => {
    const h = await harness([text('goal answer'), text('queued user answer')], [{ answers: {} }], { 'goal-supervision': true })
    let resolve!: (value: { answers: { id: string; selected: string[] }[] }) => void
    const asked = new Promise<void>(ready => { h.ctx.on('user-questions/request', () => { ready(); return new Promise(answer => { resolve = answer }) }) })
    h.ctx.goals.create(h.agent, { objective: 'Test all changes', maxGoalRounds: 8 })
    await asked
    h.send('An independent user request')
    resolve({ answers: [{ id: 'jev-resolution', selected: ['取消 / Cancel'] }] })
    await h.agent.whenIdle()
    expect(h.ctx.goals.get(h.agent)?.phase).toBe('paused')
    expect(h.model.requests).toHaveLength(2)
    expect(visible(h.agent)).toContain('queued user answer')
  })

  it('does not allow a stale completion answer to change an edited goal', async () => {
    let release!: (value: object) => void
    const pending = new Promise<object>(resolve => { release = resolve })
    let h: Awaited<ReturnType<typeof harness>>
    h = await harness([() => { const goal = h.ctx.goals.get(h.agent)!; return call('complete', 'update_goal', { action: 'complete', goal_id: goal.id, revision: goal.revision }) }, text('denied')], [() => pending, answer('needs-user')], { 'goal-supervision': true })
    h.ctx.goals.create(h.agent, { objective: 'Original goal', maxGoalRounds: 8 })
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    const goal = h.ctx.goals.get(h.agent)!
    h.ctx.goals.edit(h.agent, { id: goal.id, revision: goal.revision }, { objective: 'Revised goal' })
    release(answer('complete'))
    await vi.waitFor(() => expect(h.ctx.goals.get(h.agent)?.phase).toBe('paused'))
    expect(h.ctx.goals.get(h.agent)?.objective).toBe('Revised goal')
    const details = await Promise.all((await h.records()).items.map(record => h.ctx.jev.getRecord(record.id)))
    expect(details.some(record => record?.receipts.some(receipt => receipt.status === 'not-adopted'))).toBe(true)
  })

  it('checks an ordinary request when the retained native goal is already complete', async () => {
    const h = await harness([text('done')], [answer('complete')], { 'completion-check': true })
    const goal = h.ctx.goals.create(h.agent, { objective: 'Old goal', maxGoalRounds: 8 })
    h.ctx.goals.complete(h.agent, { id: goal.id, revision: goal.revision })
    await h.agent.whenIdle()
    h.send('New unrelated work'); await h.agent.whenIdle()
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0].state.mode).toBe('completion')
  })

  it('keeps a disabled interactive check waiting until cancellation without another request', async () => {
    const h = await harness([text('done')], [{ answers: {} }], { 'completion-check': true })
    let prompts = 0
    h.ctx.on('user-questions/request', async () => {
      prompts++
      if (prompts === 1) {
        updateVolatile(h.features, createVolatile({ 'completion-check': false }))
        return { answers: [{ id: 'jev-resolution', selected: ['重试 / Retry'] }] }
      }
      return { answers: [{ id: 'jev-resolution', selected: ['取消 / Cancel'] }] }
    })
    h.send('Do it'); await h.agent.whenIdle()
    expect(prompts).toBe(2)
    expect(h.requests).toHaveLength(1)
    expect(h.model.requests).toHaveLength(1)
  })

  it('excludes a long finished task before budgeting the current short request', async () => {
    const h = await harness([text('old done'), text('current done')], [answer('complete')], {}, { evidenceChars: 1_000 })
    h.send('Old unrelated task ' + 'x'.repeat(8_000)); await h.agent.whenIdle()
    updateVolatile(h.features, createVolatile({ 'completion-check': true }))
    h.send('Say current done'); await h.agent.whenIdle()
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0].state.completeEvidence).toBe(true)
    expect(h.requests[0].state.excludedEarlierMessages).toBeGreaterThan(0)
    expect(JSON.stringify(h.requests)).not.toContain('Old unrelated task')
    expect((await h.records()).items[0]?.status).toBe('succeeded')
  })

  it('reopens persisted records and Session without resending or resetting the original request supplement allowance', async () => {
    const first = await harness([text('first answer'), text('supplement answer')], [answer('omission'), answer('omission')], { 'completion-check': true })
    first.send('Implement and test'); await first.agent.whenIdle()
    const original = first.agent.session.deriveMessages().find(message => message.role === 'user' && message.source.kind === 'user')!
    const supplement = first.agent.session.deriveMessages().find(message => message.role === 'user' && message.source.kind === 'jev-supervision' && message.source.action === 'supplement')!
    await first.dispose()
    const second = await harness([text('same original work')], [answer('omission')], { 'completion-check': true }, {}, { root: first.root, id: first.agent.id })
    expect(second.model.requests).toHaveLength(0)
    expect(second.requests).toHaveLength(0)
    expect(second.agent.session.deriveMessages().some(message => message.id === original.id)).toBe(true)
    if (supplement.role !== 'user') throw new Error('Expected recorded supplement')
    second.agent.steer(createUserMessage({ source: supplement.source, content: [{ type: 'text', text: 'Continue the original work once after an explicit wake' }] }))
    await second.agent.whenIdle()
    expect(second.model.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
    expect(visible(second.agent)).toContain('No further automatic work')
  })

  it('does not send or adopt an unlogged background attempt and still completes the main Agent', async () => {
    const h = await harness([call('one'), text('done')], [answer('drift')], { 'drift-monitoring': true }, { driftInterval: 1 })
    vi.spyOn(JevLedger.prototype, 'startAttempt').mockRejectedValueOnce(new Error('fixture disk write failed'))
    h.send('Investigate'); await h.agent.whenIdle()
    expect(h.model.requests).toHaveLength(2)
    expect(h.requests).toHaveLength(0)
    expect(visible(h.agent)).not.toContain('Correction:')
  })

  it('does not deliver a background answer whose result write failed', async () => {
    const h = await harness([call('one'), async () => {
      await vi.waitFor(async () => expect((await h.records()).items[0]?.status).toBe('failed'))
      return call('two')
    }, text('done')], [answer('drift')], { 'drift-monitoring': true }, { driftInterval: 1 })
    vi.spyOn(JevLedger.prototype, 'settleAttempt').mockRejectedValueOnce(new Error('fixture result write failed'))
    h.send('Investigate'); await h.agent.whenIdle()
    expect(h.model.requests).toHaveLength(3)
    expect(visible(h.agent)).not.toContain('Correction:')
  })

  it('resets the stalled-round count after the user resumes a paused native goal', async () => {
    const h = await harness(Array.from({ length: 6 }, () => text('same failure')), Array.from({ length: 6 }, () => answer('no-progress')), { 'goal-supervision': true })
    h.ctx.goals.create(h.agent, { objective: 'Fix it', maxGoalRounds: 9 })
    await vi.waitFor(() => expect(h.ctx.goals.get(h.agent)?.phase).toBe('paused'))
    const paused = h.ctx.goals.get(h.agent)!
    h.ctx.goals.resume(h.agent, { id: paused.id, revision: paused.revision })
    await vi.waitFor(() => expect(h.ctx.goals.get(h.agent)?.roundsStarted).toBe(6))
    await vi.waitFor(() => expect(h.ctx.goals.get(h.agent)?.phase).toBe('paused'))
    expect(h.model.requests).toHaveLength(6)
  })

  it('preserves an earlier public tool denial without running a completion judgment', async () => {
    let h: Awaited<ReturnType<typeof harness>>
    h = await harness([() => { const goal = h.ctx.goals.get(h.agent)!; return call('complete', 'update_goal', { action: 'complete', goal_id: goal.id, revision: goal.revision }) }, text('not allowed')], [answer('needs-user')], { 'goal-supervision': true })
    h.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'update_goal' ? { kind: 'deny', reason: 'Earlier authority denied completion' } : next())
    h.ctx.goals.create(h.agent, { objective: 'Goal', maxGoalRounds: 8 })
    await vi.waitFor(() => expect(h.ctx.goals.get(h.agent)?.phase).toBe('paused'))
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0].state.mode).toBe('progress')
    expect(visible(h.agent)).toContain('Earlier authority denied completion')
  })

})
