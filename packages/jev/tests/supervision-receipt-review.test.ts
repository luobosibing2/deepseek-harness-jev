/** Independent fault-injection review of the one-supplement receipt ordering. */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import GoalService from '@deepseek-ai/dsh-goal'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import JevService from '../src/index.ts'
import { JevLedger } from '../src/ledger.ts'
import * as supervision from '../src/supervision.ts'

class ReviewModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (this.requests.length > 4) throw new Error('Unexpected repeated supplement')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Still missing the requested verification' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function harness(resume?: { root: string; id: ReturnType<typeof SessionId> }) {
  const root = resume?.root ?? await mkdtemp(join(tmpdir(), 'jev-supplement-receipt-'))
  if (resume === undefined) cleanup.push(() => rm(root, { recursive: true, force: true }))
  let httpCalls = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { questions: { evidence: { criteria: Record<string, string> } } }
    httpCalls++
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ answers: {
      assessment: { choice: 'omission' }, evidence: { choice: Object.keys(body.questions.evidence.criteria)[0] },
    } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing local HTTP address')
  const ctx = new Context()
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => errors.push(error))
  await ctx.plugin(Storage)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(GoalService)
  const backend = new JsonStorageBackend(join(root, 'storage'))
  const unregister = ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.provide('storageDomain', facility)
  ctx.provide('profileContext', { dir: join(root, 'profile') } as never)
  ctx.provide('settings', { configure: () => () => {} } as never)
  ctx.provide('credentials', { resolve: async () => ({ value: 'localhost-only-review', source: 'fixture' }) } as never)
  await ctx.plugin(JevService, { baseUrl: `http://127.0.0.1:${address.port}/v1/systemone`, model: 'review',
    credentialRef: 'REVIEW_KEY', timeoutMs: 2000, features: { 'completion-check': true } })
  await ctx.plugin(supervision)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  const model = new ReviewModel()
  ctx.llm.registerAdapter(['review'], model)
  const agent = resume === undefined
    ? await ctx.agentLoop.create(SessionId('receipt-review'), { provider: 'review', model: 'review' })
    : (await ctx.agentLoop.resume(ctx, { resumeSessionId: resume.id, agentOptions: { provider: 'review', model: 'review' } })).agent
  const ask = vi.fn()
  ctx.on('user-questions/request', ask)
  let closed = false
  const dispose = async () => {
    if (closed) return
    closed = true
    await ctx.fiber.dispose(); unregister(); await facility.closeAll(); await backend.close()
  }
  cleanup.push(dispose)
  const records = async () => Promise.all((await ctx.jev.listRecords({ sessionId: agent.id, limit: 100 })).items.map(record => ctx.jev.getRecord(record.id)))
  return { ctx, root, agent, model, errors, ask, records, dispose, httpCalls: () => httpCalls,
    send: () => agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement and verify the task' }] })) }
}

function injectReceiptFailure(ids: readonly string[]) {
  const original = JevLedger.prototype.receipt
  const failures: string[] = []
  vi.spyOn(JevLedger.prototype, 'receipt').mockImplementation(async function (operationId, receipt) {
    if (ids.includes(receipt.id)) { failures.push(receipt.id); throw new Error('Review injected action-receipt storage failure') }
    return original.call(this, operationId, receipt)
  })
  return failures
}

describe('independent supplement receipt failure review through real AgentLoop and localhost Jev', () => {
  it('does not duplicate or ask after the queued receipt fails, and preserves the allowance after reopening', async () => {
    const first = await harness()
    const failed = injectReceiptFailure(['supplement-queued'])
    first.send(); await first.agent.whenIdle()
    expect(failed).toEqual(['supplement-queued'])
    expect(first.model.requests, JSON.stringify({ status: first.agent.status, nextStep: first.agent.inbox.nextStep.map(message => message.source), errors: first.errors.map(error => String(error)), httpCalls: first.httpCalls() })).toHaveLength(2)
    expect(first.httpCalls()).toBe(2)
    expect(first.ask).not.toHaveBeenCalled()
    expect(first.agent.status).toBe('idle')
    expect(first.agent.inbox.nextStep).toHaveLength(0)
    const supplements = first.agent.session.deriveMessages().filter(message => message.role === 'user'
      && message.source.kind === 'jev-supervision' && message.source.action === 'supplement')
    expect(supplements).toHaveLength(1)
    const records = await first.records()
    expect(records.filter(record => record?.receipts.some(receipt => receipt.id === 'supplement-reserved'))).toHaveLength(1)
    expect(records.some(record => record?.receipts.some(receipt => receipt.id === 'supplement-queued'))).toBe(false)
    expect(records.some(record => record?.receipts.some(receipt => receipt.id === 'completion-stopped'))).toBe(true)
    // A post-enqueue bookkeeping failure must not strand the committed supplement.
    expect(first.errors).toHaveLength(0)
    expect(first.agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'error')).toBe(false)
    const supplement = supplements[0]!
    if (supplement.role !== 'user') throw new Error('Missing supplement message')
    await first.dispose()
    vi.restoreAllMocks()
    const resumed = await harness({ root: first.root, id: first.agent.id })
    expect(resumed.model.requests).toHaveLength(0)
    expect(resumed.httpCalls()).toBe(0)
    resumed.agent.steer(createUserMessage({ source: supplement.source, content: [{ type: 'text', text: 'Explicitly continue this original task after restart' }] }))
    await resumed.agent.whenIdle()
    expect(resumed.model.requests).toHaveLength(1)
    expect(resumed.httpCalls()).toBe(1)
    expect(resumed.ask).not.toHaveBeenCalled()
    expect((await resumed.records()).filter(record => record?.receipts.some(receipt => receipt.id === 'supplement-reserved'))).toHaveLength(1)
  })

  it('still prevents enqueue when the durable allowance reservation cannot be saved', async () => {
    const h = await harness()
    const failed = injectReceiptFailure(['supplement-reserved'])
    h.send(); await h.agent.whenIdle()
    expect(failed).toEqual(['supplement-reserved'])
    expect(h.model.requests).toHaveLength(1)
    expect(h.httpCalls()).toBe(1)
    expect(h.ask).not.toHaveBeenCalled()
    expect(h.agent.inbox.nextStep).toHaveLength(0)
    expect(h.agent.session.deriveMessages().some(message => message.role === 'user'
      && message.source.kind === 'jev-supervision' && message.source.action === 'supplement')).toBe(false)
    expect((await h.records()).every(record => record?.receipts.length === 0)).toBe(true)
    expect(h.errors).toHaveLength(1)
  })

  it('does not duplicate or hang when the admitted-message delivery receipt fails', async () => {
    const h = await harness()
    const failed = injectReceiptFailure(['supplement-delivered'])
    h.send(); await h.agent.whenIdle()
    expect(failed).toEqual(['supplement-delivered'])
    expect(h.model.requests).toHaveLength(2)
    expect(h.httpCalls()).toBe(2)
    expect(h.ask).not.toHaveBeenCalled()
    expect(h.agent.status).toBe('idle')
    const records = await h.records()
    const reserved = records.find(record => record?.receipts.some(receipt => receipt.id === 'supplement-reserved'))!
    expect(reserved.receipts.map(receipt => receipt.id)).toEqual(['supplement-reserved', 'supplement-queued'])
    expect(reserved.actionStatus).toBe('executed')
    expect(h.errors).toHaveLength(0)
    expect(h.agent.session.deriveMessages().filter(message => message.role === 'user'
      && message.source.kind === 'jev-supervision' && message.source.action === 'supplement')).toHaveLength(1)
  })
})
