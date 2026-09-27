import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage, ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import JevService from '../src/index.ts'
import * as instructions from '../src/instructions.ts'

interface Wire { state: { sources: { id: string; text: string; origin: string }[]; operation: { name: string; arguments: string } }; questions: Record<string, object> }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

class BindingRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120000 } }
  async run(request: PtcRunRequest): Promise<PtcRunResult> {
    const value = await request.bindings[0]!.functions.write!({ file_path: 'product.txt', content: 'ptc wrote' })
    return { logs: [], value }
  }
}

async function fixture(ptc = false, sessionDirectory = '') {
  const root = await mkdtemp(join(tmpdir(), 'jev-instructions-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'home'))
  const cwd = join(root, sessionDirectory)
  await mkdir(cwd, { recursive: true })
  const requests: Wire[] = []
  let release: (() => void) | undefined
  let held: Promise<void> | undefined
  let status = 200
  let override: string | undefined
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Wire
    requests.push(body)
    await held
    const answers = Object.fromEntries(Object.keys(body.questions).map(id => {
      const source = body.state.sources.find(source => source.id === id)
      const writes = body.state.operation.name === 'write'
      const text = source?.text ?? ''
      const conflict = writes && text.includes('Write only in isolated workspace') && !body.state.operation.arguments.includes('plan.md')
      return [id, { choice: override ?? (id === 'no-requirements' ? 'not-applicable' : conflict ? 'conflict' : 'no-conflict') }]
    }))
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ answers }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  cleanups.push(async () => { release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const ctx = new Context()
  for (const plugin of [Storage, LlmRuntime, AgentRegistry, SessionStore, SystemPrompt, UserQuestionService]) await ctx.plugin(plugin)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(ToolRuntime, { mode: ptc ? 'ptc' : 'native' })
  if (ptc) await ctx.plugin(BindingRuntime)
  const backend = new JsonStorageBackend(join(root, 'storage'))
  const unregister = ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.provide('storageDomain', facility)
  ctx.provide('profileContext', { dir: join(root, 'profile') } as never)
  ctx.provide('settings', { configure: () => () => {} } as never)
  ctx.provide('credentials', { resolve: async () => ({ value: 'localhost-fixture', source: 'fixture' }) } as never)
  const instructionConfig = { dshHome: join(root, 'home'), maxBytes: 24000,
    instructionFileCandidates: ['TEAM.md'], localInstructionFileCandidates: [], projectRootMarkers: ['.git'] }
  ctx.provide('loader', { entries: () => [{ options: { name: '@deepseek-ai/dsh-agent-instructions' }, fiber: { state: 2, uid: 1, ctx, config: instructionConfig } }] } as never)
  const jev = await ctx.plugin(JevService, { baseUrl: `http://127.0.0.1:${address.port}/v1/systemone`, model: 'fixture',
    credentialRef: 'FIXTURE_KEY', timeoutMs: 5000, features: { 'instruction-guidance': true } })
  const judgments: Promise<unknown>[] = []
  const judgeOnce = ctx.jev.judgeOnce.bind(ctx.jev)
  vi.spyOn(ctx.jev, 'judgeOnce').mockImplementation(options => {
    const judgment = judgeOnce(options)
    judgments.push(judgment)
    return judgment
  })
  let instructionsFiber = await ctx.plugin(instructions)
  let writes = 0
  ctx.tools.register(defineTool({ name: 'write', description: 'Fixture file write through the original tools pipeline',
    parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { writes++; await writeFile(resolve(cwd, args.file_path), args.content); return 'written' },
  }))
  ctx.tools.register(defineTool({ name: 'read', description: 'Fixture file read through the original tools pipeline',
    parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => readFile(resolve(cwd, args.file_path), 'utf8'),
  }))
  const session = ctx.sessions.create(SessionId('instructions-' + root), { meta: { cwd } })
  session.append('user/message', user('Update this project.'), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  const agent = { ctx, id: session.id, session, status: 'running', inbox: { nextStep: [], nextTurn: [] }, options: {},
    steer: vi.fn(), followup: vi.fn(), send: vi.fn() } as never as Agent
  ctx.agents.enter(agent, undefined)
  const ask = vi.fn()
  ctx.on('user-questions/request', ask)
  let calls = 0
  const invoke = (path = 'product.txt', tool = 'write') => ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name: ptc ? 'run_code' : tool, arguments: ptc ? { description: 'Write fixture', code: 'await tools.write({file_path:"product.txt",content:"ptc wrote"})' } : tool === 'read' ? { file_path: path } : { file_path: path, content: 'written' },
    agent, signal: new AbortController().signal, callId: ToolCallId('instruction-' + ++calls),
  }))
  const step = async (messages: UserMessage[] = []) => {
    const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages }))
    if (decision.kind === 'enter') for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
    return decision.kind === 'enter' ? decision.messages.filter(message => message.source.kind === 'jev-instruction-guidance') : []
  }
  const settled = async (count = calls) => {
    await vi.waitFor(async () => {
      const list = (await ctx.jev.listRecords({})).items
      expect(list.length).toBeGreaterThanOrEqual(count)
      expect(list.every(record => record.status !== 'pending')).toBe(true)
    })
    // Adoption re-reads current files after ledger settlement; await the real public call.
    await Promise.all(judgments)
    await flush()
  }
  cleanups.push(async () => { release?.(); await ctx.fiber.dispose(); unregister(); await facility.closeAll(); await backend.close() })
  return { root, ctx, agent, session, invoke, step, settled, requests, ask, writes: () => writes,
    rule: (text: string, path = 'TEAM.md') => writeFile(join(root, path), text),
    hold: () => { held = new Promise<void>(resolve => { release = resolve }); return () => { release?.(); held = undefined } },
    reloadInstructions: async () => { await instructionsFiber.dispose(); instructionsFiber = await ctx.plugin(instructions) },
    status: (value: number) => { status = value }, answer: (value: string) => { override = value },
    enabled: (value: boolean) => updateVolatile(jev.config.features, createVolatile({ 'instruction-guidance': value })), instructionConfig }
}

describe('instruction guidance with original Native/PTC pipeline and localhost Jev', () => {
  it('does not wait for a slow judge; the next existing model step receives exactly one original-backed reminder', async () => {
    const f = await fixture()
    const receipts = vi.spyOn(f.ctx.jev, 'writeReceipt')
    await f.rule('Write only in isolated workspace. Planning plan.md in the main workspace is allowed.')
    const release = f.hold()
    { const actual = await f.invoke(); expect(actual, JSON.stringify(actual)).toMatchObject({ isError: false }) }
    expect(await readFile(join(f.root, 'product.txt'), 'utf8')).toBe('written')
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    expect(await f.step()).toHaveLength(0)
    release(); await f.settled()
    const reminders = await f.step()
    expect(reminders).toHaveLength(1)
    expect(receipts).not.toHaveBeenCalled()
    const record = await f.ctx.jev.getRecord((await f.ctx.jev.listRecords({})).items[0]!.id)
    expect(record?.receipts).toEqual([])
    expect(JSON.stringify(reminders)).toContain('TEAM.md')
    expect(JSON.stringify(reminders)).toContain('Write only in isolated workspace')
    expect(f.session.deriveMessages().some(message => message.role === 'user' && message.source.kind === 'jev-instruction-guidance')).toBe(true)
    await f.invoke(); await f.settled(); expect(await f.step()).toHaveLength(0)
    expect(f.writes()).toBe(2); expect(f.ask).not.toHaveBeenCalled()
  })
  it('adopts an issued slow judgment after disabling while new calls send no requests', async () => {
    const f = await fixture(); await f.rule('Write only in isolated workspace.')
    const release = f.hold()
    expect((await f.invoke()).isError).toBe(false)
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    f.enabled(false)
    expect((await f.invoke()).isError).toBe(false)
    expect(f.writes()).toBe(2)
    expect(f.requests).toHaveLength(1)
    release(); await f.settled(1)
    expect(await f.step()).toHaveLength(1)
    expect(f.requests).toHaveLength(1)
    expect((await f.ctx.jev.listRecords({})).items).toHaveLength(1)
    expect(f.ask).not.toHaveBeenCalled()
  })
  it('restores same-request deduplication but permits a new direct request to remind the same original', async () => {
    const f = await fixture(); await f.rule('Write only in isolated workspace.')
    await f.invoke(); await f.settled()
    const first = await f.step()
    expect(first).toHaveLength(1)
    await f.reloadInstructions()
    await f.invoke(); await f.settled()
    expect(await f.step()).toHaveLength(0)
    const newRequest = user('Start the next task: update this project again.')
    f.session.append('user/message', newRequest, { surfaceOp: 'append' })
    await f.invoke(); await f.settled()
    const second = await f.step()
    expect(second).toHaveLength(1)
    const firstSource = first[0]!.source
    const secondSource = second[0]!.source
    expect(firstSource.kind).toBe('jev-instruction-guidance')
    expect(secondSource.kind).toBe('jev-instruction-guidance')
    if (firstSource.kind !== 'jev-instruction-guidance' || secondSource.kind !== 'jev-instruction-guidance') throw new Error('Missing reminder sources')
    expect(secondSource.requestId).toBe(newRequest.id)
    expect(secondSource.requestId).not.toBe(firstSource.requestId)
    expect(secondSource.originalIds).toEqual(firstSource.originalIds)
    await f.invoke(); await f.settled(); expect(await f.step()).toHaveLength(0)
    expect(f.writes()).toBe(4)
  })
  it('uses actual candidate config, discovers first-touch nested rules, and refreshes modified/deleted originals and exceptions', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'AGENTS.md'), 'Write only in isolated workspace.')
    await f.invoke(); await f.settled(); expect(await f.step()).toHaveLength(0)
    await mkdir(join(f.root, 'deep'))
    await f.rule('Write only in isolated workspace. Planning plan.md in main is allowed.', 'deep/TEAM.md')
    await f.invoke('deep/product.txt'); await f.settled(); expect(await f.step()).toHaveLength(1)
    await f.invoke('deep/plan.md'); await f.settled(); expect(await f.step()).toHaveLength(0)
    await f.rule('Direct edits are allowed.', 'deep/TEAM.md')
    await f.invoke('deep/product.txt'); await f.settled(); expect(await f.step()).toHaveLength(0)
    await rm(join(f.root, 'deep/TEAM.md'))
    await f.invoke('deep/product.txt'); await f.settled(); expect(await f.step()).toHaveLength(0)
    expect(JSON.stringify(f.requests[0])).not.toContain('Write only in isolated workspace')
  })
  it.each(['read', 'write'])('includes every intermediate custom rule for no-Git nested %s targets', async tool => {
    const f = await fixture()
    await rm(join(f.root, '.git'), { recursive: true })
    await mkdir(join(f.root, 'rules-on/allowed/deep'), { recursive: true })
    await f.rule('Session requirement.')
    await f.rule('Write only in isolated workspace. Read-only access is allowed.', 'rules-on/TEAM.md')
    await f.rule('Planning plan.md in main is allowed.', 'rules-on/allowed/TEAM.md')
    await f.rule('Ignored default filename.', 'rules-on/AGENTS.md')
    await f.rule('original', 'rules-on/allowed/deep/note.md')
    expect((await f.invoke('rules-on/allowed/deep/note.md', tool)).isError).toBe(false)
    await f.settled()
    const originals = f.requests[0]!.state.sources.filter(source => !source.origin.startsWith('user-message:'))
    expect(originals.map(source => source.text)).toEqual([
      'Session requirement.', 'Write only in isolated workspace. Read-only access is allowed.', 'Planning plan.md in main is allowed.',
    ])
    expect(await f.step()).toHaveLength(tool === 'write' ? 1 : 0)
    await f.invoke('rules-on/allowed/deep/plan.md'); await f.settled()
    expect(await f.step()).toHaveLength(0)
  })
  it('refreshes changed and deleted intermediate no-Git rules before adoption and on subsequent calls', async () => {
    const f = await fixture()
    await rm(join(f.root, '.git'), { recursive: true })
    await mkdir(join(f.root, 'rules-on/allowed'), { recursive: true })
    await f.rule('Write only in isolated workspace.', 'rules-on/TEAM.md')
    const release = f.hold()
    await f.invoke('rules-on/allowed/note.md')
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    expect(f.requests[0]!.state.sources.map(source => source.text)).toContain('Write only in isolated workspace.')
    await f.rule('Direct edits are allowed.', 'rules-on/TEAM.md')
    release(); await f.settled()
    expect(await f.step()).toHaveLength(0)
    await f.invoke('rules-on/allowed/note.md'); await f.settled()
    expect(f.requests[1]!.state.sources.map(source => source.text)).toContain('Direct edits are allowed.')
    await f.rule('Write only in isolated workspace.', 'rules-on/TEAM.md')
    await f.invoke('rules-on/allowed/note.md'); await f.settled()
    await rm(join(f.root, 'rules-on/TEAM.md'))
    expect(await f.step()).toHaveLength(0)
    await f.invoke('rules-on/allowed/note.md'); await f.settled()
    expect(f.requests[3]!.state.sources.map(source => source.text)).toEqual(['Update this project.'])
    expect(await f.step()).toHaveLength(0)
  })
  it('retains the session ancestor baseline and extends its scopes through nested project markers', async () => {
    const f = await fixture(false, 'session')
    f.instructionConfig.projectRootMarkers = ['ROOT']
    await f.rule('', 'ROOT')
    await f.rule('Outer project requirement.')
    await f.rule('Session requirement.', 'session/TEAM.md')
    await mkdir(join(f.root, 'session/middle/independent/deep'), { recursive: true })
    await f.rule('Outside independent project.', 'session/middle/TEAM.md')
    await f.rule('', 'session/middle/independent/ROOT')
    await f.rule('Independent project requirement.', 'session/middle/independent/TEAM.md')
    await f.invoke('middle/independent/deep/note.md'); await f.settled()
    expect(f.requests[0]!.state.sources.map(source => source.text)).toEqual([
      'Update this project.', 'Outer project requirement.', 'Session requirement.', 'Outside independent project.', 'Independent project requirement.',
    ])
  })
  it('preserves default root discovery for targets outside the session directory', async () => {
    const f = await fixture(false, 'session')
    await rm(join(f.root, '.git'), { recursive: true })
    await f.rule('Outside session requirement.')
    await f.rule('Session requirement.', 'session/TEAM.md')
    await mkdir(join(f.root, 'session-sibling/branch/deep'), { recursive: true })
    await f.rule('Outside intermediate requirement.', 'session-sibling/TEAM.md')
    await f.rule('External leaf requirement.', 'session-sibling/branch/deep/TEAM.md')
    await f.invoke(join(f.root, 'session-sibling/branch/deep/note.md')); await f.settled()
    expect(f.requests[0]!.state.sources.map(source => source.text)).toEqual([
      'Update this project.', 'Session requirement.', 'External leaf requirement.',
    ])
    await mkdir(join(f.root, 'session-sibling/.git'))
    await f.invoke(join(f.root, 'session-sibling/branch/deep/note.md')); await f.settled()
    expect(f.requests[1]!.state.sources.map(source => source.text)).toEqual([
      'Update this project.', 'Session requirement.', 'Outside intermediate requirement.', 'External leaf requirement.',
    ])
  })
  it('does not adopt a stale user amendment or late result and never wakes an agent', async () => {
    const f = await fixture(); await f.rule('Write only in isolated workspace.')
    const release = f.hold(); await f.invoke(); await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    release(); await f.settled()
    expect(await f.step([user('Direct edits in this workspace are now allowed.')])).toHaveLength(0)
    const release2 = f.hold(); await f.invoke(); await vi.waitFor(() => expect(f.requests).toHaveLength(2))
    Object.assign(f.agent, { status: 'idle' }); f.ctx.emit('agent/status', { agent: f.agent, status: 'idle' })
    release2(); await f.settled(); expect(await f.step()).toHaveLength(0)
    expect(f.agent.steer).not.toHaveBeenCalled(); expect(f.agent.followup).not.toHaveBeenCalled()
  })
  it('records HTTP failure and undetermined replies without asking or blocking tools', async () => {
    const f = await fixture(); await f.rule('Write only in isolated workspace.')
    f.status(503); { const actual = await f.invoke(); expect(actual, JSON.stringify(actual)).toMatchObject({ isError: false }) }; await f.settled()
    expect(await f.step()).toHaveLength(0)
    f.status(200); f.answer('undetermined'); { const actual = await f.invoke(); expect(actual, JSON.stringify(actual)).toMatchObject({ isError: false }) }; await f.settled()
    expect(await f.step()).toHaveLength(0); expect(f.ask).not.toHaveBeenCalled()
    expect((await f.ctx.jev.listRecords({})).items.every(record => record.status === 'failed')).toBe(true)
  })
  it('keeps the host denial and independent feature switch effective', async () => {
    const f = await fixture(); await f.rule('Write only in isolated workspace.')
    f.enabled(false); await f.invoke(); expect(f.requests).toHaveLength(0)
    f.enabled(true)
    f.ctx.on('tools/pre-execute', async (_exec, _next) => ({ kind: 'deny', reason: 'Host permission refused' }))
    expect((await f.invoke()).isError).toBe(true); expect(f.writes()).toBe(1)
    await f.settled(1); expect(f.ask).not.toHaveBeenCalled()
  })
  it('observes PTC child tools and delivers the correction to the parent model step', async () => {
    const f = await fixture(true); await f.rule('Write only in isolated workspace.')
    { const actual = await f.invoke(); expect(actual, JSON.stringify(actual)).toMatchObject({ isError: false }) }
    await f.settled(2)
    expect(f.writes()).toBe(1)
    expect(f.requests.some(request => request.state.operation.name === 'write'), JSON.stringify(await Promise.all((await f.ctx.jev.listRecords({})).items.map(item => f.ctx.jev.getRecord(item.id))))).toBe(true)
    expect(await f.step()).toHaveLength(1)
  })
  it('delivers once into a real AgentLoop model request without inventing a follow-up turn', async () => {
    const f = await fixture(); await f.rule('Write only in isolated workspace.')
    await f.ctx.plugin(SessionProjectionRegistry)
    await f.ctx.plugin(AgentLoop, { agents: [] })
    const seen: GenerateOptions[] = []
    class MainModel extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        seen.push(options)
        const number = seen.length
        if (number === 2) await f.settled(1)
        if (number < 3) {
          const id = ToolCallId('real-loop-' + number)
          const args = JSON.stringify({ file_path: 'product.txt', content: 'main model wrote' })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'I saw the reminder and choose not to change the location.' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'I saw the reminder and choose not to change the location.' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    f.ctx.llm.registerAdapter(['fixture-main'], new MainModel())
    const agent = await f.ctx.agentLoop.create(SessionId('real-loop'), { provider: 'fixture-main', model: 'fixture' }, { cwd: f.root })
    agent.followup(user('Update this project.'))
    await agent.whenIdle()
    expect(seen).toHaveLength(3)
    expect(JSON.stringify(seen[2]!.messages)).toContain('Jev 用户约束提醒')
    expect(agent.session.deriveMessages().filter(message => message.role === 'user' && message.source.kind === 'jev-instruction-guidance')).toHaveLength(1)
    expect(f.writes()).toBe(2)
    expect(f.ask).not.toHaveBeenCalled()
    expect(agent.status).toBe('idle')
  })
  it('treats unreadable current instructions and bounded omissions as undetermined, never as empty policy', async () => {
    const f = await fixture(); await f.rule('Write only in isolated workspace.')
    const original = f.ctx.fs.streamText.bind(f.ctx.fs)
    vi.spyOn(f.ctx.fs, 'streamText').mockImplementation(async (target, signal) => {
      if (f.ctx.fs.processPath(target).endsWith('TEAM.md')) throw new Error('read unavailable')
      return original(target, signal)
    })
    { const actual = await f.invoke(); expect(actual, JSON.stringify(actual)).toMatchObject({ isError: false }) }; await f.settled()
    expect(f.requests).toHaveLength(0); expect(await f.step()).toHaveLength(0); expect(f.ask).not.toHaveBeenCalled()
    const record = await f.ctx.jev.getRecord((await f.ctx.jev.listRecords({})).items[0]!.id)
    expect(record?.failure?.code).toBe('INSTRUCTIONS_UNAVAILABLE')
    expect(record?.attempts).toBe(0)
  })
})
