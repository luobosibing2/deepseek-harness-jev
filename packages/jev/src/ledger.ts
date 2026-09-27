/** Profile-scoped durable operation, attempt, and action records. */
import { createHash, randomUUID } from 'node:crypto'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { validateRequest } from './wire.ts'
import { parseWireResponse } from './wire.ts'
import type {
  JevActionReceipt, JevAttemptRecord, JevInput, JevOperationLink, JevRecordDetail,
  JevRecordFilter, JevRecordPage, JevRecordStatus, JevRequest, Json,
} from './types.ts'

const STATUS = new Set<JevRecordStatus>(['pending', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJson)
  return isRecord(value) && Object.values(value).every(isJson)
}

function isInput(value: unknown): value is JevInput {
  return typeof value === 'string' || (isJson(value) && value !== null && typeof value === 'object')
}

const nonempty = z.string().min(1)
const jsonSchema = z.custom<Json>(isJson)
const inputSchema = z.custom<JevInput>(isInput)
const questionSchema = z.discriminatedUnion('kind', [
  z.object({ id: nonempty, kind: z.literal('choice'), prompt: inputSchema,
    options: z.array(z.object({ id: nonempty, description: inputSchema.nullable() })).min(1) }),
  z.object({ id: nonempty, kind: z.literal('score'), prompt: inputSchema,
    levels: z.array(inputSchema.nullable()).min(2).max(10) }),
  z.object({ id: nonempty, kind: z.literal('noul'), prompt: inputSchema,
    criteria: z.object({ true: inputSchema.nullable().optional(), false: inputSchema.nullable().optional() }).optional() }),
])
const requestSchema = z.object({ state: jsonSchema, questions: z.array(questionSchema).min(1) })
  .refine(request => {
    try { validateRequest(request); return true } catch { return false }
  })
const probability = z.number().min(0).max(1)
const answerSchema = z.discriminatedUnion('kind', [
  z.object({ id: nonempty, kind: z.literal('choice'), optionId: nonempty,
    probabilities: z.record(z.string(), probability).optional(), confidence: probability.optional(), legend: jsonSchema.optional() }),
  z.object({ id: nonempty, kind: z.literal('score'), value: z.number().finite(),
    probabilities: z.record(z.string(), probability).optional(), confidence: probability.optional(), legend: jsonSchema.optional() }),
  z.object({ id: nonempty, kind: z.literal('noul'), probability,
    confidence: probability.optional(), legend: jsonSchema.optional() }),
])
const statusSchema = z.enum(['pending', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted'])
const actionStatusSchema = z.enum(['unconfirmed', 'not-adopted', 'cancelled', 'executed', 'execution-failed', 'observed'])
const attemptSchema = z.object({
  id: nonempty, startedAt: nonempty, settledAt: nonempty.optional(), latencyMs: z.number().nonnegative().optional(),
  connection: z.object({
    baseUrl: z.string().refine(value => {
      if (value === '') return true
      try {
        const url = new URL(value)
        return (url.protocol === 'https:' || url.protocol === 'http:')
          && !url.username && !url.password && !url.search && !url.hash
      } catch { return false }
    }),
    model: z.string(), credentialRef: z.string().regex(/^(?:$|[A-Za-z_][A-Za-z0-9_]*)$/),
  }),
  request: requestSchema, status: statusSchema,
  rawResponse: jsonSchema.optional(), response: z.object({ answers: z.array(answerSchema) }).optional(),
  interpretation: z.object({ usable: z.boolean(), reason: z.string().optional() }).optional(),
  failure: z.object({ code: nonempty, message: nonempty }).optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional() }).optional(),
})
const detailSchema: z.ZodType<JevRecordDetail> = z.object({
  id: nonempty, featureId: nonempty, sessionId: nonempty.optional(),
  status: statusSchema, startedAt: nonempty, updatedAt: nonempty,
  attempts: z.number().int().nonnegative(), actionStatus: actionStatusSchema.optional(), diagnostic: z.boolean(),
  link: z.object({ sessionId: nonempty.optional(), runId: nonempty.optional(), stepId: nonempty.optional(), inputVersion: nonempty.optional() }),
  attemptRecords: z.array(attemptSchema),
  failure: z.object({ code: nonempty, message: nonempty }).optional(),
  receipts: z.array(z.object({ id: nonempty, status: actionStatusSchema, reason: z.string().optional(), at: nonempty })),
}).superRefine((detail, issue) => {
  if (detail.attempts !== detail.attemptRecords.length) {
    issue.addIssue({ code: 'custom', message: 'attempt count does not match records' })
  }
  for (const attempt of detail.attemptRecords) {
    if (attempt.status !== 'succeeded') continue
    if (attempt.rawResponse === undefined || attempt.response === undefined) {
      issue.addIssue({ code: 'custom', message: 'successful attempt lacks response' })
      continue
    }
    try {
      const parsed = parseWireResponse(attempt.rawResponse, attempt.request)
      if (JSON.stringify(parsed.response) !== JSON.stringify(attempt.response)) {
        issue.addIssue({ code: 'custom', message: 'stored response differs from raw answer' })
      }
    } catch {
      issue.addIssue({ code: 'custom', message: 'successful attempt has invalid raw answer' })
    }
  }
})

/** Profile directory identity is part of the domain name even when a backend is shared. */
export function ledgerSpec(profileDir: string) {
  const suffix = createHash('sha256').update(profileDir).digest('hex').slice(0, 20)
  return defineDomain({
    name: `jev_${suffix}`,
    version: 1,
    layout: 'per-record',
    tables: { operations: domainTable<string, JevRecordDetail>(detailSchema) },
  })
}

/** Every mutator awaits the domain's durable write before returning a record to a caller. */
export class JevLedger {
  private constructor(private readonly domain: Domain<ReturnType<typeof ledgerSpec>>) {}

  static async open(facility: { open: (spec: ReturnType<typeof ledgerSpec>) => Promise<Domain<ReturnType<typeof ledgerSpec>>> }, profileDir: string): Promise<JevLedger> {
    const ledger = new JevLedger(await facility.open(ledgerSpec(profileDir)))
    await ledger.markInterrupted()
    return ledger
  }

  async close(): Promise<void> { await this.domain.close() }

  /** Mark calls and waits left by an earlier Host process as interrupted. */
  private async markInterrupted(): Promise<void> {
    for (const [id, value] of this.domain.table('operations').entries()) {
      if (value.status === 'pending' || value.status === 'waiting') {
        await this.domain.table('operations').update(id, current => ({
          ...current,
          status: 'interrupted',
          updatedAt: new Date().toISOString(),
          attemptRecords: current.attemptRecords.map(attempt =>
            attempt.status === 'pending' || attempt.status === 'waiting'
              ? { ...attempt, status: 'interrupted' }
              : attempt),
        }))
      } else if (!value.diagnostic && value.status === 'succeeded' && value.receipts.length === 0 && value.actionStatus !== 'unconfirmed') {
        await this.domain.table('operations').update(id, current => ({ ...current, actionStatus: 'unconfirmed', updatedAt: new Date().toISOString() }))
      }
    }
  }

  async create(featureId: string, link: JevOperationLink, diagnostic = false): Promise<JevRecordDetail> {
    const at = new Date().toISOString()
    const detail: JevRecordDetail = {
      id: randomUUID(), featureId, link, ...link.sessionId === undefined ? {} : { sessionId: link.sessionId },
      diagnostic, status: 'pending', startedAt: at, updatedAt: at, attempts: 0,
      attemptRecords: [], receipts: [],
    }
    await this.domain.table('operations').put(detail.id, detail)
    return detail
  }

  /** Write one stable zero-attempt recovery record in a single durable operation. */
  async createInterrupted(featureId: string, link: JevOperationLink): Promise<JevRecordDetail> {
    const id = 'interrupted-' + createHash('sha256').update(JSON.stringify([featureId, link.sessionId, link.inputVersion])).digest('hex')
    const existing = this.get(id)
    if (existing !== null) return existing
    const at = new Date().toISOString()
    const detail: JevRecordDetail = {
      id, featureId, link, sessionId: link.sessionId, diagnostic: false, status: 'interrupted',
      startedAt: at, updatedAt: at, attempts: 0, attemptRecords: [], receipts: [],
      failure: { code: 'INTERRUPTED', message: 'Jev operation was interrupted before delivery; no request was resumed' },
    }
    await this.domain.table('operations').put(id, detail)
    return detail
  }

  get(id: string): JevRecordDetail | null { return this.domain.table('operations').get(id) ?? null }

  async startAttempt(operationId: string, request: JevRequest, connection: JevAttemptRecord['connection']): Promise<JevAttemptRecord> {
    const attempt: JevAttemptRecord = {
      id: randomUUID(), request, connection, status: 'pending', startedAt: new Date().toISOString(),
    }
    await this.domain.table('operations').update(operationId, current => ({
      ...current, status: 'pending', updatedAt: attempt.startedAt,
      attempts: current.attemptRecords.length + 1,
      attemptRecords: [...current.attemptRecords, attempt],
    }))
    return attempt
  }

  async settleAttempt(operationId: string, attemptId: string, patch: Pick<JevAttemptRecord, 'status' | 'response' | 'rawResponse' | 'failure' | 'usage' | 'interpretation'>): Promise<void> {
    const at = new Date().toISOString()
    await this.domain.table('operations').update(operationId, current => {
      if (!current.attemptRecords.some(attempt => attempt.id === attemptId)) throw new Error('Jev attempt not found')
      return {
        ...current, status: patch.status, updatedAt: at,
        attemptRecords: current.attemptRecords.map(attempt => attempt.id === attemptId
          ? { ...attempt, ...patch, settledAt: at, latencyMs: Date.now() - Date.parse(attempt.startedAt) }
          : attempt),
      }
    })
  }

  async setStatus(operationId: string, status: JevRecordStatus): Promise<void> {
    await this.domain.table('operations').update(operationId, current => ({ ...current, status, updatedAt: new Date().toISOString() }))
  }

  /** Preserve a pre-attempt or ledger-stage failure without inventing an HTTP attempt. */
  async failOperation(operationId: string, failure: { code: string; message: string }): Promise<void> {
    await this.domain.table('operations').update(operationId, current => ({ ...current, status: 'failed', failure, updatedAt: new Date().toISOString() }))
  }

  async receipt(operationId: string, receipt: JevActionReceipt): Promise<JevRecordDetail> {
    return this.domain.table('operations').update(operationId, current => {
      if (current.status !== 'succeeded') throw new Error('Jev action receipt requires a successful judgment')
      if (receipt.status === 'unconfirmed') throw new Error('Jev action receipt cannot declare an unconfirmed status')
      const previous = current.receipts.find(item => item.id === receipt.id)
      if (previous !== undefined) {
        if (JSON.stringify(previous) !== JSON.stringify(receipt)) throw new Error('Jev action receipt conflicts with existing id')
        return current
      }
      return {
        ...current,
        actionStatus: receipt.status,
        updatedAt: receipt.at,
        receipts: [...current.receipts, receipt],
      }
    })
  }

  list(filter: JevRecordFilter): JevRecordPage {
    const limit = filter.limit === undefined ? 25 : Math.max(1, Math.min(100, Math.trunc(filter.limit)))
    const rows = [...this.domain.table('operations').entries()].map(([, row]) => row)
      .filter(row => (filter.featureId === undefined || row.featureId === filter.featureId)
        && (filter.status === undefined || row.status === filter.status)
        && (filter.sessionId === undefined || row.sessionId === filter.sessionId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
    const cursorIndex = filter.cursor === undefined ? -1 : rows.findIndex(row => row.id === filter.cursor)
    if (filter.cursor !== undefined && cursorIndex < 0) throw new Error('Jev record cursor does not match this query')
    const start = cursorIndex + 1
    const selected = rows.slice(start, start + limit)
    return {
      items: selected.map(({ link: _link, attemptRecords: _attemptRecords, receipts: _receipts, ...summary }) => summary),
      ...start + limit < rows.length ? { nextCursor: selected.at(-1)?.id } : {},
    }
  }
}
