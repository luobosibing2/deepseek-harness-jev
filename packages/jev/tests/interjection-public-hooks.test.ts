/** Public-hook feasibility checks against the released Agent loop; no product routing is installed. */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import Storage, { type StorageBackend } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import JevService, { type Config, type JevJudgeResult } from '../src/index.ts'
import { ledgerSpec } from '../src/ledger.ts'
import { createVolatile } from '@deepseek-ai/cosmokit'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const message = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

class LocalModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly firstStarted = Promise.withResolvers<void>()
  readonly releaseFirst = Promise.withResolvers<void>()
  constructor(private readonly holdFirst = true) { super() }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1 && this.holdFirst) {
      this.firstStarted.resolve()
      await this.releaseFirst.promise
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(model: LocalModel, root?: string) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (root !== undefined) await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['local-fixture'], model)
  cleanups.push(async () => { model.releaseFirst.resolve(); await ctx.fiber.dispose() })
  return ctx
}

async function classifier() {
  const received = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = createServer(async (_request, response) => {
    received.resolve()
    await release.promise
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ kind: 'non-correction' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No local fixture port')
  cleanups.push(async () => { release.resolve(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { received, release, url: `http://127.0.0.1:${address.port}/judge` }
}

function committed(agent: Agent) {
  return agent.session.snapshotEvents().filter((event): event is Extract<SessionEvent, { type: 'user/message' }> => event.type === 'user/message').map(event => event.data)
}

async function running(ctx: Context, model: LocalModel) {
  const agent = await ctx.agentLoop.create(SessionId('routing-feasibility'), { provider: 'local-fixture', model: 'local' })
  agent.followup(message('Original task'))
  await model.firstStarted.promise
  return agent
}

describe('released Agent public inbox hooks', () => {
  it('does not await asynchronous inserted observers before model delivery', async () => {
    const model = new LocalModel()
    const ctx = await harness(model)
    const http = await classifier()
    const agent = await running(ctx, model)
    const input = message('When done, add an example')
    let judged = false
    let judgment: Promise<void> = Promise.resolve()
    ctx.on('agent/inbox/inserted', ({ message: item }) => {
      if (item.id !== input.id) return
      judgment = fetch(http.url).then(async response => { await response.json(); judged = true })
      return judgment
    })
    agent.steer(input)
    await http.received.promise
    model.releaseFirst.resolve()
    await agent.whenIdle()
    expect(judged).toBe(false)
    expect(committed(agent).filter(item => item.id === input.id)).toHaveLength(1)
    expect(model.requests).toHaveLength(2)
    http.release.resolve()
    await judgment
  })

  it('holds the model at pre-step but claimed input is no longer editable or removable', async () => {
    const model = new LocalModel()
    const ctx = await harness(model)
    const agent = await running(ctx, model)
    const input = message('Original interjection')
    const waiting = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    ctx.on('agent/pre-step', async ({ messages }, next) => {
      if (messages.some(item => item.id === input.id)) { waiting.resolve(); await release.promise }
      return next()
    }, { prepend: true })
    agent.steer(input)
    model.releaseFirst.resolve()
    await waiting.promise
    expect(model.requests).toHaveLength(1)
    expect(agent.inbox.nextStep).toEqual([])
    expect(agent.inbox.replace(input.id, { ...input, content: [{ type: 'text', text: 'Edited interjection' }] })).toBe(false)
    expect(agent.inbox.remove(input.id)).toBe(false)
    release.resolve()
    await agent.whenIdle()
    expect(committed(agent).find(item => item.id === input.id)?.content).toEqual(input.content)
  })

  it('can reinsert a claimed identity synchronously to retain public edits, with an explicit canceled splice on transfer', async () => {
    const model = new LocalModel()
    const ctx = await harness(model)
    const agent = await running(ctx, model)
    const input = message('Original interjection')
    const waiting = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    ctx.on('agent/inbox/claimed', ({ message: item }) => {
      if (item.id === input.id) agent.inbox.append('next-step', item)
    })
    ctx.on('agent/pre-step', async ({ messages }, next) => {
      if (!messages.some(item => item.id === input.id)) return next()
      waiting.resolve()
      await release.promise
      const current = agent.inbox.nextStep.find(item => item.id === input.id)
      if (current === undefined) throw new Error('Expected the retained input')
      agent.inbox.remove(input.id)
      messages.splice(messages.findIndex(item => item.id === input.id), 1, current)
      return next()
    }, { prepend: true })
    agent.steer(input)
    model.releaseFirst.resolve()
    await waiting.promise
    expect(agent.inbox.replace(input.id, { ...input, content: [{ type: 'text', text: 'Edited interjection' }] })).toBe(true)
    release.resolve()
    await agent.whenIdle()
    expect(committed(agent).filter(item => item.id === input.id)).toHaveLength(1)
    expect(committed(agent).find(item => item.id === input.id)?.content).toEqual([{ type: 'text', text: 'Edited interjection' }])
    expect(agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')).toBe(true)
  })

  it('exposes persisted pending messages to awaited resume hooks without replaying inserted notifications', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jev-routing-resume-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const originalModel = new LocalModel()
    const original = await harness(originalModel, root)
    const agent = await running(original, originalModel)
    const input = message('An unclassified running interjection')
    agent.followup(input)
    await original.sessionPersistence.flush()
    const reader = await original.sessionPersistence.open(agent.session.id, 'read')
    const snapshot = await reader.read()
    const header = reader.header
    await reader.close()
    // Replay the flushed prefix, excluding orderly shutdown's later canceled splice.
    agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    originalModel.releaseFirst.resolve()
    await agent.whenIdle()
    await original.fiber.dispose()

    const restoredModel = new LocalModel(false)
    const restoredRoot = await mkdtemp(join(tmpdir(), 'jev-routing-restored-'))
    cleanups.push(() => rm(restoredRoot, { recursive: true, force: true }))
    const restored = await harness(restoredModel, restoredRoot)
    const writer = await restored.sessionPersistence.create(header)
    await writer.append(snapshot.events)
    await writer.close()
    const created = Promise.withResolvers<void>()
    const releaseCreated = Promise.withResolvers<void>()
    cleanups.push(async () => { releaseCreated.resolve() })
    let replayedInsertions = 0
    let restoredPending: string[] = []
    restored.on('agent/inbox/inserted', () => { replayedInsertions++ })
    restored.on('agent/created', async ({ agent: current, source }) => {
      if (source !== 'resume') return
      restoredPending = current.inbox.nextTurn.map(item => item.id)
      created.resolve()
      await releaseCreated.promise
      return undefined
    })
    const resuming = restored.agents.resume({ resumeSessionId: agent.session.id, agentOptions: { provider: 'local-fixture', model: 'local' } })
    await created.promise
    expect(restoredPending).toEqual([input.id])
    expect(replayedInsertions).toBe(0)
    expect(restoredModel.requests).toHaveLength(0)
    releaseCreated.resolve()
    const resumed = await resuming
    // Resume alone is idle; fresh wake consumes older pending input first.
    resumed.agent.followup(message('New work after restart'))
    await resumed.agent.whenIdle()
    expect(committed(resumed.agent).filter(item => item.id === input.id)).toHaveLength(1)
    expect(restoredModel.requests).toHaveLength(2)
  })

  it('can persist inbox input before the first public Jev record is durable, leaving no arrival-time feature marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jev-routing-admission-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const model = new LocalModel()
    const ctx = await harness(model, join(root, 'sessions'))
    await ctx.plugin(Storage)
    await ctx.plugin(UserQuestionService)
    const recordWriteEntered = Promise.withResolvers<void>()
    const releaseRecordWrite = Promise.withResolvers<void>()
    const json = new JsonStorageBackend(join(root, 'ledger'))
    // A conforming slow backend exercises the public durability seam without replacing any service method.
    const slowStorage: StorageBackend = {
      kv: { async open(descriptor) {
        const unit = await json.kv.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          async putRecord(table, key, value) {
            recordWriteEntered.resolve()
            await releaseRecordWrite.promise
            return unit.putRecord(table, key, value)
          },
          deleteRecord: (table, key) => unit.deleteRecord(table, key),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
        }
      } },
      close: () => json.close(),
    }
    const unregister = ctx.storage.backend.register('routing-slow-fixture', slowStorage)
    const facility = new DomainFacility(ctx, { backend: 'routing-slow-fixture' })
    ctx.provide('storageDomain', facility)
    const profile = join(root, 'profile')
    ctx.provide('profileContext', { dir: profile } as never)
    ctx.provide('settings', { configure: () => () => {} } as never)
    ctx.provide('credentials', {
      resolve: async () => ({ value: 'local-fixture-key', source: 'fixture' }),
      describe: async () => ({ configured: true, writable: true, source: 'fixture' }),
      set: async () => {},
    } as never)
    const http = await classifier()
    const service = await ctx.plugin(JevService, {
      baseUrl: http.url, model: 'local', credentialRef: 'FIXTURE_KEY', timeoutMs: 10_000,
      features: { 'interjection-routing': true },
    })
    ctx.jev.registerFeature({ id: 'interjection-routing', name: 'Routing fixture', description: 'Admission feasibility only' })
    const lifetime = new AbortController()
    let judgment: Promise<JevJudgeResult> | undefined
    cleanups.push(async () => {
      lifetime.abort()
      releaseRecordWrite.resolve()
      if (judgment !== undefined) await judgment
      model.releaseFirst.resolve()
      await ctx.fiber.dispose()
      unregister()
      await facility.closeAll()
      await slowStorage.close()
    })
    const agent = await running(ctx, model)
    const input = message('Running input before marker durability')
    ctx.on('agent/inbox/inserted', ({ message: current }) => {
      if (current.id !== input.id) return
      judgment = ctx.jev.judge({
        featureId: 'interjection-routing', agent, signal: lifetime.signal,
        link: { sessionId: agent.id, inputVersion: current.id },
        refresh: () => ({ state: { messageId: current.id }, questions: [{ id: 'route', kind: 'noul', prompt: 'Correction?' }] }),
      })
    })
    agent.followup(input)
    await recordWriteEntered.promise
    await ctx.sessionPersistence.flush()
    const stored = await ctx.sessionPersistence.open(agent.id, 'read')
    const prefix = (await stored.read()).events
    await stored.close()
    expect(prefix.at(-1)).toMatchObject({ type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [input] } })
    expect(await ctx.jev.listRecords({})).toEqual({ items: [] })
    const probe = new JsonStorageBackend(join(root, 'ledger'))
    const spec = ledgerSpec(profile)
    const unit = await probe.kv.open({ name: spec.name, version: 1, tables: ['operations'], hasGlobal: false, layout: 'per-record' })
    expect((await unit.loadAll()).tables.operations).toEqual({})
    await probe.close()
    // The current value can already be off; it cannot reconstruct the value at input admission.
    updateVolatile((service.config as Config).features, createVolatile({ 'interjection-routing': false }))
    expect((await ctx.jev.listFeatures())[0]?.enabled).toBe(false)
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([input.id])
    lifetime.abort()
    releaseRecordWrite.resolve()
    await judgment
  })

})
