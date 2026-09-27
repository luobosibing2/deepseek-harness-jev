import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import JevService, { Config, JevError } from '../src/index.ts'
import { JevLedger } from '../src/ledger.ts'
import type { JevRequest } from '../src/types.ts'

const request: JevRequest = {
  state: {},
  questions: [
    { id: 'route', kind: 'choice', prompt: 'Choose route', options: [
      { id: 'left', description: 'left path' }, { id: 'right', description: 'right path' },
    ] },
    { id: 'risk', kind: 'score', prompt: 'Rate risk', levels: ['low', 'medium', 'high'] },
    { id: 'ready', kind: 'noul', prompt: 'Ready?' },
  ],
}

const valid = {
  answers: {
    route: { choice: 'left', probabilities: { left: 0.7, right: 0.3 } },
    risk: { score: 1.5, probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 } },
    ready: { noul: 0.8 },
  },
  usage: { input_tokens: 17, output_tokens: 5 },
}

type Reply = object | (() => Promise<object>)

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Jev fixture cleanup failed')
})

async function fixture(replies: Reply[]) {
  const received: object[] = []
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as object)
    const reply = replies.shift()
    const body = typeof reply === 'function' ? await reply() : reply
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body ?? valid))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind an ephemeral port')
  cleanups.push(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  return { url: `http://127.0.0.1:${address.port}/v1/systemone`, received }
}

async function setup(options: { root: string; profile: string; url: string; enabled?: boolean; timeoutMs?: number }) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  const backend = new JsonStorageBackend(options.root)
  const unregister = ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.provide('storageDomain', facility)
  ctx.provide('profileContext', { dir: options.profile } as never)
  ctx.provide('settings', { configure: () => () => {} } as never)
  ctx.provide('credentials', {
    resolve: async () => ({ value: 'local-fixture-key', source: 'fixture' }),
    describe: async () => ({ configured: true, writable: true, source: 'fixture' }),
    set: async () => {},
  } as never)
  const jevFiber = await ctx.plugin(JevService, {
    baseUrl: options.url, model: 'jev-local', credentialRef: 'JEV_TEST_KEY', timeoutMs: options.timeoutMs ?? 10_000,
    features: { fixture: options.enabled ?? true },
  })
  const agent = { id: 'fixture-session', session: { id: 'fixture-session', header: { delegationDepth: 0 } } } as Agent
  ctx.agents.enter(agent, undefined)
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await ctx.fiber.dispose()
    unregister()
    await facility.closeAll()
    await backend.close()
  }
  cleanups.push(dispose)
  return { ctx, agent, dispose, jevFiber, features: jevFiber.config.features as Volatile<Record<string, boolean>> }
}

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'jev-host-test-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

describe('Jev Host through Cordis, LlmRuntime, JSON storage, and local HTTP', () => {
  it('rejects secret-bearing or malformed connection settings at configuration validation', () => {
    expect(() => Config({ baseUrl: 'https://user:key@example.test/v1/systemone' })).toThrow()
    expect(() => Config({ baseUrl: 'https://example.test/v1/systemone?api_key=secret' })).toThrow()
    expect(() => Config({ baseUrl: 'https://example.test/v1/systemone#token' })).toThrow()
    expect(() => Config({ credentialRef: 'BAD-REF' })).toThrow()
    expect(() => Config({ model: ' ' })).toThrow()
    expect(Config({ baseUrl: '' }).baseUrl.get()).toBe('')
  })
  it('publishes a synchronous committed feature snapshot only when enablement changes', async () => {
    const path = await root()
    const http = await fixture([])
    const { ctx, jevFiber, features } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    const observed: boolean[] = []
    const dispose = ctx.jev.onFeatureStateChange(snapshot => {
      observed.push(snapshot.fixture === true)
      expect(ctx.jev.isFeatureEnabled('fixture')).toBe(snapshot.fixture === true)
      expect(Object.isFrozen(snapshot)).toBe(true)
    })
    const own: Context = Object.create(jevFiber.ctx)
    own[Context.filter] = owner => owner.fiber === jevFiber
    updateVolatile(features, createVolatile({ fixture: false }))
    jevFiber.ctx.emit(own, 'loader/volatile-update', [['features']])
    expect(observed).toEqual([false])
    jevFiber.ctx.emit(own, 'loader/volatile-update', [['timeoutMs']])
    expect(observed).toEqual([false])
    dispose()
    updateVolatile(features, createVolatile({ fixture: true }))
    jevFiber.ctx.emit(own, 'loader/volatile-update', [['features']])
    expect(observed).toEqual([false])
  })

  it('blocks a disabled feature without sending a request', async () => {
    const path = await root()
    const http = await fixture([])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url, enabled: false })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    await expect(ctx.jev.judge({ featureId: 'fixture', link: { sessionId: 'fixture-session' }, agent, refresh: () => request }))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    expect(http.received).toHaveLength(0)
  })

  it('records a complete typed request and successful response before returning it', async () => {
    const path = await root()
    const http = await fixture([valid])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    const outcome = await ctx.jev.judge({ featureId: 'fixture', link: { sessionId: 'fixture-session', inputVersion: 'v1' }, agent, refresh: () => request })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.response.answers[1]).toMatchObject({ kind: 'score', value: 1.5 })
    expect(http.received[0]).toMatchObject({ model: 'jev-local', state: {}, questions: { risk: { type: 'score', criteria: ['low', 'medium', 'high'] } } })
    const record = await ctx.jev.getRecord(outcome.operationId)
    expect(record?.attemptRecords[0]).toMatchObject({ status: 'succeeded', usage: { inputTokens: 17, outputTokens: 5 } })
    expect(JSON.stringify(record)).not.toContain('local-fixture-key')
  })

  it('makes a single non-interactive attempt and retains failure evidence', async () => {
    const path = await root()
    const http = await fixture([{ answers: {} }])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    const ask = vi.fn()
    ctx.on('user-questions/request', ask)
    const result = await ctx.jev.judgeOnce({ featureId: 'fixture', agent, link: {}, refresh: () => request })
    expect(result).toMatchObject({ kind: 'failed', failure: { code: 'INVALID_RESPONSE' } })
    expect(ask).not.toHaveBeenCalled()
    expect(http.received).toHaveLength(1)
    expect((await ctx.jev.getRecord(result.operationId!))?.attemptRecords).toHaveLength(1)
  })

  it('records a sanitized refresh failure without an HTTP attempt or human question', async () => {
    const path = await root()
    const http = await fixture([])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    const ask = vi.fn()
    ctx.on('user-questions/request', ask)
    const result = await ctx.jev.judgeOnce({ featureId: 'fixture', agent, link: {}, refresh: () => { throw new JevError('RULE_READ_FAILED', 'private text that must not be stored') } })
    expect(result).toMatchObject({ kind: 'failed', failure: { code: 'RULE_READ_FAILED' } })
    expect(http.received).toHaveLength(0)
    expect(ask).not.toHaveBeenCalled()
    const record = await ctx.jev.getRecord(result.operationId!)
    expect(record?.failure).toEqual({ code: 'RULE_READ_FAILED', message: 'Jev rule read failed' })
    expect(record?.attemptRecords).toHaveLength(0)
    expect(JSON.stringify(record)).not.toContain('private text')
  })

  it('does not adopt a valid background answer after its target changes', async () => {
    const path = await root()
    const http = await fixture([valid])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    const result = await ctx.jev.judgeOnce({ featureId: 'fixture', agent, link: {}, refresh: () => request,
      canAdopt: () => 'Requirements changed' })
    expect(result.kind).toBe('not-adopted')
    expect((await ctx.jev.getRecord(result.operationId!))?.receipts[0]?.status).toBe('not-adopted')
  })

  it('waits for a manual retry and refreshes the second attempt input', async () => {
    const path = await root()
    const bad = { answers: { ...valid.answers, risk: { score: 9 } } }
    const http = await fixture([bad, valid])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    let calls = 0
    let resolveAsk: ((answer: { answers: { id: string; selected: string[] }[] }) => void) | undefined
    const asked = new Promise<void>(resolve => {
      ctx.on('user-questions/request', () => { resolve(); return new Promise(answer => { resolveAsk = answer }) })
    })
    const pending = ctx.jev.judge({ featureId: 'fixture', link: {}, agent,
      refresh: () => ({ ...request, state: { version: ++calls } }),
    })
    await asked
    expect(http.received).toHaveLength(1)
    resolveAsk?.({ answers: [{ id: 'jev-resolution', selected: ['重试 / Retry'] }] })
    const outcome = await pending
    expect(outcome.kind).toBe('ok')
    expect(calls).toBe(2)
    expect(http.received).toMatchObject([{ state: { version: 1 } }, { state: { version: 2 } }])
    if (outcome.kind === 'ok') expect((await ctx.jev.getRecord(outcome.operationId))?.attemptRecords).toHaveLength(2)
  })

  it('cancels a pending manual answer without sending a retry', async () => {
    const path = await root()
    const http = await fixture([{ answers: {} }])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    const controller = new AbortController()
    let askReady: (() => void) | undefined
    const asked = new Promise<void>(resolve => { askReady = resolve })
    ctx.on('user-questions/request', () => { askReady?.(); return new Promise(() => {}) })
    const pending = ctx.jev.judge({ featureId: 'fixture', link: {}, agent, refresh: () => request, signal: controller.signal })
    await asked
    controller.abort()
    const outcome = await pending
    expect(outcome.kind).toBe('cancelled')
    expect(http.received).toHaveLength(1)
    if (outcome.kind === 'cancelled') expect((await ctx.jev.getRecord(outcome.operationId))?.status).toBe('cancelled')
  })

  it('asks for enablement after a manual retry when the feature was disabled during the wait', async () => {
    const path = await root()
    const http = await fixture([{ answers: {} }])
    const { ctx, agent, features } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    let prompts = 0
    ctx.on('user-questions/request', () => {
      prompts += 1
      if (prompts === 1) {
        updateVolatile(features, createVolatile({ fixture: false }))
        return Promise.resolve({ answers: [{ id: 'jev-resolution', selected: ['重试 / Retry'] }] })
      }
      return Promise.resolve({ answers: [{ id: 'jev-resolution', selected: ['取消 / Cancel'] }] })
    })
    const outcome = await ctx.jev.judge({ featureId: 'fixture', link: {}, agent, refresh: () => request })
    expect(outcome.kind).toBe('cancelled')
    expect(prompts).toBe(2)
    expect(http.received).toHaveLength(1)
  })

  it('allows an already sent judgment to finish after disablement and rejects a later call', async () => {
    const path = await root()
    let entered: (() => void) | undefined
    const sent = new Promise<void>(resolve => { entered = resolve })
    let release: ((value: object) => void) | undefined
    const answer = new Promise<object>(resolve => { release = resolve })
    const http = await fixture([() => { entered?.(); return answer }])
    const { ctx, agent, features } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    const pending = ctx.jev.judge({ featureId: 'fixture', link: {}, agent, refresh: () => request })
    await sent
    updateVolatile(features, createVolatile({ fixture: false }))
    release?.(valid)
    expect((await pending).kind).toBe('ok')
    await expect(ctx.jev.judge({ featureId: 'fixture', link: {}, agent, refresh: () => request }))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    expect(http.received).toHaveLength(1)
  })

  it('does not dispatch when a feature turns off during asynchronous input refresh', async () => {
    const path = await root()
    const http = await fixture([valid])
    const { ctx, agent, features } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    let refreshStarted: (() => void) | undefined
    const refreshing = new Promise<void>(resolve => { refreshStarted = resolve })
    let returnInput: ((value: JevRequest) => void) | undefined
    const input = new Promise<JevRequest>(resolve => { returnInput = resolve })
    ctx.on('user-questions/request', () => Promise.resolve({ answers: [{ id: 'jev-resolution', selected: ['取消 / Cancel'] }] }))
    const pending = ctx.jev.judge({ featureId: 'fixture', link: {}, agent,
      refresh: () => { refreshStarted?.(); return input },
    })
    await refreshing
    updateVolatile(features, createVolatile({ fixture: false }))
    returnInput?.(request)
    expect((await pending).kind).toBe('cancelled')
    expect(http.received).toHaveLength(0)
  })

  it('runs a fixed diagnostic while every business feature is disabled', async () => {
    const path = await root()
    const http = await fixture([{ answers: { ready: { noul: 0.9 } } }])
    const profile = join(path, 'profile')
    const storage = join(path, 'storage')
    const { ctx, dispose } = await setup({ root: storage, profile, url: http.url, enabled: false })
    const result = await ctx.jev.testConnection(new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(http.received[0]).toMatchObject({ state: { diagnostic: 'jev-connection-test' }, questions: { ready: { type: 'noul' } } })
    expect(await ctx.jev.getRecord(result.recordId)).toMatchObject({ diagnostic: true, status: 'succeeded' })
    await dispose()
    const backend = new JsonStorageBackend(storage)
    const readCtx = new Context()
    await readCtx.plugin(Storage)
    readCtx.storage.backend.register('json', backend)
    const ledger = await JevLedger.open(new DomainFacility(readCtx, { backend: 'json' }), profile)
    expect(ledger.get(result.recordId)?.actionStatus).toBeUndefined()
    await ledger.close()
    await backend.close()
    await readCtx.fiber.dispose()
  })

  it('classifies a local service timeout and never retries without a human answer', async () => {
    const path = await root()
    let entered: (() => void) | undefined
    const sent = new Promise<void>(resolve => { entered = resolve })
    let release: ((value: object) => void) | undefined
    const answer = new Promise<object>(resolve => { release = resolve })
    const http = await fixture([() => { entered?.(); return answer }])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url, timeoutMs: 30 })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    const pending = ctx.jev.judge({ featureId: 'fixture', link: {}, agent, refresh: () => request })
    await sent
    await expect(pending).rejects.toMatchObject({ code: 'NO_INTERFACE' })
    release?.(valid)
    expect(http.received).toHaveLength(1)
    expect((await ctx.jev.listRecords({})).items[0]?.status).toBe('failed')
    const id = (await ctx.jev.listRecords({})).items[0]?.id
    if (id !== undefined) expect((await ctx.jev.getRecord(id))?.attemptRecords[0]?.failure?.code).toBe('TIMEOUT')
  })

  it('drains a waiting operation on Host disposal and persists cancellation', async () => {
    const path = await root()
    const http = await fixture([{ answers: {} }])
    const profile = join(path, 'profile')
    const storage = join(path, 'storage')
    const { ctx, agent, dispose } = await setup({ root: storage, profile, url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    let reached: (() => void) | undefined
    const asked = new Promise<void>(resolve => { reached = resolve })
    ctx.on('user-questions/request', () => { reached?.(); return new Promise(() => {}) })
    const pending = ctx.jev.judge({ featureId: 'fixture', link: {}, agent, refresh: () => request })
    await asked
    const stopping = dispose()
    const outcome = await pending
    await stopping
    expect(outcome.kind).toBe('cancelled')
    const backend = new JsonStorageBackend(storage)
    const readCtx = new Context()
    await readCtx.plugin(Storage)
    readCtx.storage.backend.register('json', backend)
    const ledger = await JevLedger.open(new DomainFacility(readCtx, { backend: 'json' }), profile)
    if (outcome.kind === 'cancelled') expect(ledger.get(outcome.operationId)?.status).toBe('cancelled')
    await ledger.close()
    await backend.close()
    await readCtx.fiber.dispose()
  })

  it('marks a pending file-backed attempt interrupted on reopen', async () => {
    const path = await root()
    const profile = join(path, 'profile')
    const backend = new JsonStorageBackend(join(path, 'storage'))
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json' })
    const ledger = await JevLedger.open(facility, profile)
    const operation = await ledger.create('fixture', { sessionId: 'fixture-session' })
    await ledger.startAttempt(operation.id, request, { baseUrl: 'http://127.0.0.1:1/', model: 'local', credentialRef: 'JEV_TEST_KEY' })
    await ledger.close()
    const reopened = await JevLedger.open(facility, profile)
    expect(reopened.get(operation.id)).toMatchObject({ status: 'interrupted', attemptRecords: [{ status: 'interrupted' }] })
    await reopened.close()
    await facility.closeAll()
    await backend.close()
    await ctx.fiber.dispose()
  })

  it('fails explicitly without a human answerer and settles the operation', async () => {
    const path = await root()
    const http = await fixture([{ answers: {} }])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    await expect(ctx.jev.judge({ featureId: 'fixture', link: {}, agent, refresh: () => request }))
      .rejects.toMatchObject({ code: 'NO_INTERFACE' })
    expect((await ctx.jev.listRecords({})).items[0]?.status).toBe('failed')
  })

  it('does not treat an empty human reply as cancellation or send another request', async () => {
    const path = await root()
    const http = await fixture([{ answers: {} }])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    ctx.on('user-questions/request', () => Promise.resolve({ answers: [{ id: 'jev-resolution', selected: [] }] }))
    await expect(ctx.jev.judge({ featureId: 'fixture', link: {}, agent, refresh: () => request }))
      .rejects.toMatchObject({ code: 'INVALID_HUMAN_ANSWER' })
    expect(http.received).toHaveLength(1)
    expect((await ctx.jev.listRecords({})).items[0]?.status).toBe('failed')
  })

  it('refuses transport when the durable input write fails', async () => {
    const path = await root()
    const http = await fixture([valid])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    const write = vi.spyOn(JevLedger.prototype, 'startAttempt').mockRejectedValueOnce(new Error('medium refused write'))
    try {
      await expect(ctx.jev.judge({ featureId: 'fixture', link: {}, agent, refresh: () => request }))
        .rejects.toMatchObject({ code: 'LOG_WRITE_FAILED' })
      expect(http.received).toHaveLength(0)
    } finally { write.mockRestore() }
  })

  it('does not expose a valid answer when the result write fails', async () => {
    const path = await root()
    const http = await fixture([valid])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    const write = vi.spyOn(JevLedger.prototype, 'settleAttempt').mockRejectedValueOnce(new Error('medium refused write'))
    try {
      await expect(ctx.jev.judge({ featureId: 'fixture', link: {}, agent, refresh: () => request }))
        .rejects.toMatchObject({ code: 'LOG_WRITE_FAILED' })
      expect(http.received).toHaveLength(1)
      expect((await ctx.jev.listRecords({})).items[0]?.status).toBe('pending')
    } finally { write.mockRestore() }
  })

  it('keeps a pre-write request snapshot even if its producer mutates the input while persistence waits', async () => {
    const path = await root()
    const http = await fixture([valid])
    const { ctx, agent } = await setup({ root: join(path, 'storage'), profile: join(path, 'profile'), url: http.url })
    ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    const state = { version: 1 }
    let reached: (() => void) | undefined
    const writing = new Promise<void>(resolve => { reached = resolve })
    let release: (() => void) | undefined
    const allow = new Promise<void>(resolve => { release = resolve })
    const original = JevLedger.prototype.startAttempt
    const write = vi.spyOn(JevLedger.prototype, 'startAttempt').mockImplementation(async function (id, current, connection) {
      reached?.()
      await allow
      return original.call(this, id, current, connection)
    })
    try {
      const pending = ctx.jev.judge({ featureId: 'fixture', link: {}, agent,
        refresh: () => ({ state, questions: request.questions }),
      })
      await writing
      state.version = 2
      release?.()
      const outcome = await pending
      expect(outcome.kind).toBe('ok')
      expect(http.received[0]).toMatchObject({ state: { version: 1 } })
      if (outcome.kind === 'ok') expect((await ctx.jev.getRecord(outcome.operationId))?.attemptRecords[0]?.request.state)
        .toEqual({ version: 1 })
    } finally { write.mockRestore() }
  })

  it('keeps action receipts idempotent and rejects conflicts and cross-profile ids', async () => {
    const path = await root()
    const http = await fixture([valid])
    const storage = join(path, 'storage')
    const first = await setup({ root: storage, profile: join(path, 'first'), url: http.url })
    first.ctx.jev.registerFeature({ id: 'fixture', name: 'Fixture', description: 'Test only' })
    const outcome = await first.ctx.jev.judge({ featureId: 'fixture', link: {}, agent: first.agent, refresh: () => request })
    if (outcome.kind !== 'ok') throw new Error('expected successful local fixture')
    const receipt = { id: 'action-1', status: 'executed' as const, at: new Date().toISOString() }
    await first.ctx.jev.writeReceipt(outcome.operationId, receipt)
    await first.ctx.jev.writeReceipt(outcome.operationId, receipt)
    expect((await first.ctx.jev.getRecord(outcome.operationId))?.receipts).toHaveLength(1)
    await expect(first.ctx.jev.writeReceipt(outcome.operationId, { ...receipt, status: 'execution-failed' }))
      .rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' })
    const second = await setup({ root: storage, profile: join(path, 'second'), url: http.url })
    expect(await second.ctx.jev.getRecord(outcome.operationId)).toBeNull()
    await expect(second.ctx.jev.writeReceipt(outcome.operationId, receipt))
      .rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
  })
})
