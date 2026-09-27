/** Profile-local browser runs, including write-ahead records for in-flight actions. */
import { createHash } from 'node:crypto'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { observationSchema, stopSchema, webInputSchema, webLimitsSchema, webStepSchema, webMetricsSchema, candidateStatsSchema } from './web-model.ts'

export const webRunSchema = z.object({
  id: z.string(), sessionId: z.string(), callId: z.string(), startedAt: z.string(), updatedAt: z.string(),
  input: webInputSchema, limits: webLimitsSchema, status: stopSchema, reason: z.string(),
  handoffReason: z.string().optional(), candidateStats: candidateStatsSchema.optional(), metrics: webMetricsSchema.optional(),
  rounds: z.number().int().nonnegative(), steps: z.array(webStepSchema), observation: observationSchema.optional(),
})
export type WebRun = z.infer<typeof webRunSchema>

const savedObservationSchema = z.object({
  id: z.string(), sessionId: z.string(), observedAt: z.string(), session: z.string(),
  scope: z.object({ query: z.string().optional(), scope_ref: z.string().optional(), continuation: z.string().optional() }),
  observation: observationSchema,
})
export type SavedWebObservation = z.infer<typeof savedObservationSchema>

export function webStoreSpec(profileDir: string) {
  return defineDomain({ name: 'jev_web_' + createHash('sha256').update(profileDir).digest('hex').slice(0, 20),
    version: 1, layout: 'per-record', tables: { runs: domainTable<string, WebRun>(webRunSchema), observations: domainTable<string, SavedWebObservation>(savedObservationSchema) } })
}

/** A pending action never becomes a successful action solely through recovery. */
export class WebRunStore {
  private constructor(private readonly domain: Domain<ReturnType<typeof webStoreSpec>>) {}
  static async open(facility: { open: (spec: ReturnType<typeof webStoreSpec>) => Promise<Domain<ReturnType<typeof webStoreSpec>>> }, profileDir: string): Promise<WebRunStore> {
    const store = new WebRunStore(await facility.open(webStoreSpec(profileDir)))
    for (const [, run] of store.domain.table('runs').entries()) {
      if (run.status === 'running') await store.save({ ...run, status: 'interrupted', reason: 'Host stopped; no judgment or action was resumed.',
        steps: run.steps.map(step => step.status === 'executing' ? { ...step, status: 'unconfirmed' } : step) })
    }
    return store
  }
  get(id: string): WebRun | undefined { return this.domain.table('runs').get(id) }
  list(sessionId: string): WebRun[] {
    return [...this.domain.table('runs').entries()].map(([, run]) => run).filter(run => run.sessionId === sessionId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
  }
  async save(run: WebRun): Promise<void> {
    await this.domain.table('runs').put(run.id, structuredClone({ ...run, updatedAt: new Date().toISOString() }))
  }
  getObservation(id: string): SavedWebObservation | undefined { return this.domain.table('observations').get(id) }
  async saveObservation(record: SavedWebObservation): Promise<void> {
    await this.domain.table('observations').put(record.id, structuredClone(record))
  }
  async close(): Promise<void> { await this.domain.close() }
}
