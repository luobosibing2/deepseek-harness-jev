/** Actual standing-preset trees and direct Loader fallback through a real AgentLoop. */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets, { standingMountFor, livePresetMounts } from '@deepseek-ai/dsh-agent-preset-registry'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import JevService from '../src/index.ts'
import * as instructions from '../src/instructions.ts'

interface Body { state: { sources: { id: string; origin: string; text: string; authority: string }[] }; questions: Record<string, object> }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture(mode: 'preset' | 'direct', label: string) {
  const root = await mkdtemp(join(tmpdir(), 'jev-instruction-scopes-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.git')); await mkdir(join(root, 'home'))
  await writeFile(join(root, 'FIRST.md'), label + ' first-preset instructions')
  await writeFile(join(root, 'SECOND.md'), label + ' second-preset instructions')
  await writeFile(join(root, 'DIRECT.md'), label + ' direct-loader instructions')
  const received: Body[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Body
    received.push(body)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { choice: 'no-conflict' }])) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local address')
  const ctx = new Context()
  ctx.baseUrl = new URL('../', import.meta.url).href
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  await ctx.plugin(Loader)
  await ctx.plugin(Storage)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(UserQuestionService)
  const backend = new JsonStorageBackend(join(root, 'storage'))
  const unregister = ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.provide('storageDomain', facility)
  ctx.provide('profileContext', { dir: join(root, 'profile') } as never)
  ctx.provide('settings', { configure: () => () => {} } as never)
  ctx.provide('credentials', { resolve: async () => ({ value: 'localhost-scope-fixture', source: 'fixture' }) } as never)
  await ctx.plugin(JevService, { baseUrl: `http://127.0.0.1:${address.port}/v1/systemone`, model: 'scope-fixture',
    credentialRef: 'FIXTURE_KEY', timeoutMs: 5000, features: { 'instruction-guidance': true } })
  const judgmentPromises: Promise<unknown>[] = []
  const judge = ctx.jev.judgeOnce.bind(ctx.jev)
  vi.spyOn(ctx.jev, 'judgeOnce').mockImplementation(options => { const result = judge(options); judgmentPromises.push(result); return result })
  await ctx.plugin(instructions)
  await ctx.plugin(AgentLoop, { agents: [] })
  const entry = (candidate: string) => ({ id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions',
    config: { dshHome: join(root, 'home'), maxBytes: 24000, instructionFileCandidates: [candidate], localInstructionFileCandidates: [] } })
  if (mode === 'preset') {
    await ctx.plugin(AgentPresets, { default: 'first' })
    for (const [id, candidate] of [['first', 'FIRST.md'], ['second', 'SECOND.md']]) {
      const unregisterPreset = await ctx.agentPresets.register({ id: id!, plugins: [entry(candidate!)] })
      ctx.effect(() => unregisterPreset)
    }
  } else {
    await ctx.loader.create(entry('DIRECT.md'))
    await ctx.loader.await()
  }
  ctx.tools.register(defineTool({ name: 'write', description: 'Write a deterministic test file',
    parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute: async args => { await writeFile(join(root, args.file_path), 'fixture'); return 'written' },
  }))
  class MainModel extends LlmAdapter {
    readonly requests: GenerateOptions[] = []
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      const count = this.requests.filter(request => request.model === options.model).length
      if (count === 1) {
        const id = ToolCallId('scope-' + options.model)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: JSON.stringify({ file_path: options.model + '.txt' }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        await Promise.all(judgmentPromises)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const model = new MainModel()
  ctx.llm.registerAdapter(['scope-main'], model)
  cleanup.push(async () => { await ctx.fiber.dispose(); unregister(); await facility.closeAll(); await backend.close() })
  const run = async (id: string, presetId?: string) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(label + '-' + id), meta: { cwd: root },
      agentOptions: { provider: 'scope-main', model: id },
      ...presetId === undefined ? {} : { setup: async (agentCtx: Context) => { await ctx.agentPresets.mount(agentCtx, presetId) } },
    })
    const before = received.length
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Write the requested fixture file' }] }))
    await handle.agent.whenIdle()
    expect(errors).toEqual([])
    expect(received).toHaveLength(before + 1)
    return { agent: handle.agent, body: received[before]! }
  }
  return { ctx, run, received }
}

describe('instruction configuration addresses the acting Agent scope', () => {
  it('reads distinct standing presets without mixing another root with the same preset ids', async () => {
    const a = await fixture('preset', 'root-A')
    const b = await fixture('preset', 'root-B')
    expect(livePresetMounts().length).toBeGreaterThanOrEqual(4)
    expect([...a.ctx.loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-agent-instructions')).toHaveLength(0)
    const first = await a.run('one', 'first')
    const second = await a.run('two', 'second')
    const other = await b.run('three', 'first')
    expect(standingMountFor(first.agent.ctx)?.presetId).toBe('first')
    expect(standingMountFor(second.agent.ctx)?.presetId).toBe('second')
    expect(standingMountFor(first.agent.ctx)?.key).not.toBe(standingMountFor(other.agent.ctx)?.key)
    const workspace = (body: Body) => body.state.sources.filter(source => source.authority === 'workspace').map(source => source.text)
    expect(workspace(first.body)).toEqual(['root-A first-preset instructions'])
    expect(workspace(second.body)).toEqual(['root-A second-preset instructions'])
    expect(workspace(other.body)).toEqual(['root-B first-preset instructions'])
  })
  it('uses the actual direct Loader when the Agent has no preset', async () => {
    const h = await fixture('direct', 'direct-root')
    const result = await h.run('direct')
    expect(standingMountFor(result.agent.ctx)).toBeUndefined()
    expect(result.body.state.sources.filter(source => source.authority === 'workspace').map(source => source.text))
      .toEqual(['direct-root direct-loader instructions'])
  })
})
