/** Public Jev judgment, operation, and safe Remote data types. */

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }
export type JevInput = string | readonly Json[] | { readonly [key: string]: Json }

export type JevQuestion =
  | { id: string; kind: 'choice'; prompt: JevInput; options: readonly { id: string; description: JevInput | null }[] }
  | { id: string; kind: 'score'; prompt: JevInput; levels: readonly (JevInput | null)[] }
  | { id: string; kind: 'noul'; prompt: JevInput; criteria?: { true?: JevInput | null; false?: JevInput | null } }

export type JevAnswer =
  | { id: string; kind: 'choice'; optionId: string; probabilities?: Record<string, number>; confidence?: number; legend?: Json }
  | { id: string; kind: 'score'; value: number; probabilities?: Record<string, number>; confidence?: number; legend?: Json }
  | { id: string; kind: 'noul'; probability: number; confidence?: number; legend?: Json }

export interface JevRequest { state: Json; questions: readonly JevQuestion[] }
export interface JevResponse { answers: readonly JevAnswer[] }

export interface JevFeatureDefinition {
  id: string
  name: string
  description: string
  settingsDescription?: string
}

export interface JevFeatureView extends JevFeatureDefinition { enabled: boolean }

export interface JevOperationLink {
  sessionId?: string
  runId?: string
  stepId?: string
  inputVersion?: string
}

export type JevRecordStatus = 'pending' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type JevActionStatus = 'unconfirmed' | 'not-adopted' | 'cancelled' | 'executed' | 'execution-failed' | 'observed'

export interface JevActionReceipt {
  id: string
  status: JevActionStatus
  reason?: string
  at: string
}

export interface JevAttemptRecord {
  id: string
  startedAt: string
  settledAt?: string
  latencyMs?: number
  connection: { baseUrl: string; model: string; credentialRef: string }
  request: JevRequest
  status: JevRecordStatus
  rawResponse?: Json
  response?: JevResponse
  interpretation?: { usable: boolean; reason?: string }
  failure?: { code: string; message: string }
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface JevRecordSummary {
  id: string
  featureId: string
  sessionId?: string
  status: JevRecordStatus
  startedAt: string
  updatedAt: string
  attempts: number
  actionStatus?: JevActionStatus
  diagnostic: boolean
}

export interface JevRecordDetail extends JevRecordSummary {
  link: JevOperationLink
  attemptRecords: readonly JevAttemptRecord[]
  receipts: readonly JevActionReceipt[]
  failure?: { code: string; message: string }
}

export interface JevRecordFilter {
  featureId?: string
  status?: JevRecordStatus
  sessionId?: string
  cursor?: string
  limit?: number
}

export interface JevRecordPage { items: readonly JevRecordSummary[]; nextCursor?: string }

export interface JevCredentialStatus { configured: boolean; writable: boolean; source?: string }
export interface JevProbeResult { ok: boolean; latencyMs: number; recordId: string; failure?: { code: string; message: string } }
