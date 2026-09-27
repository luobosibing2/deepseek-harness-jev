// @vitest-environment jsdom
/** Jev page behavior at the Host configuration and Remote seams. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { JevPage, type JevConfigValues, type JevPageRemote } from '../src/client/JevPage.tsx'
import { en, zh, type JevLocaleKey } from '../src/client/locales.ts'
import type { SupervisionConfigValues } from '../src/supervision-types.ts'
import type { SelectionConfigValues } from '../src/selection-types.ts'
import { WebSettings } from '../src/client/WebSettings.tsx'
import type { WebLimits } from '../src/web-types.ts'
import type { JevRecordDetail, JevRecordSummary } from '../src/types.ts'

// The published primitive barrel imports optional DSH libraries that the Host
// module table supplies at runtime. These narrow atoms keep component tests
// focused on Jev's state and accessibility wiring.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button type="button" {...props}>{children}</button>,
  SegmentedTabs: ({ items, value, onChange, label }: { items: readonly { value: string; label: string; id: string; panelId: string }[]; value: string; onChange: (value: 'settings' | 'records') => void; label: string }) => <div role="tablist" aria-label={label}>{items.map(item => <button type="button" role="tab" key={item.value} aria-selected={value === item.value} onClick={() => { onChange(item.value as 'settings' | 'records') }}>{item.label}</button>)}</div>,
  StateDot: () => <span aria-hidden="true" />,
  Switch: ({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) => <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => { onChange(!checked) }} />,
}))

afterEach(() => { document.body.innerHTML = '' })

function formStub(accept = true) {
  let snapshot: ConfigFormSnapshot<JevConfigValues> = {
    status: 'ready',
    value: { baseUrl: 'https://example.invalid', model: 'test-model', credentialRef: 'JEV_API_KEY', timeoutMs: 30000, features: {} },
    base: {}, user: {}, revision: 1, writable: true, mode: 'host',
  }
  const listeners = new Set<() => void>()
  const mutate = vi.fn(async (ops: readonly { op: string; path: readonly string[]; value?: unknown }[], expectedRevision?: number) => {
    if (!accept || expectedRevision !== snapshot.revision) return false
    const value = structuredClone(snapshot.value!)
    for (const op of ops) {
      if (op.op !== 'set') continue
      if (op.path[0] === 'features') value.features[op.path[1]!] = Boolean(op.value)
      else Object.assign(value, { [op.path[0]!]: op.value })
    }
    snapshot = { ...snapshot, value, revision: snapshot.revision! + 1 }
    for (const listener of listeners) listener()
    return true
  })
  const form: ConfigForm<JevConfigValues> = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate,
    set: async () => false,
    unset: async () => false,
  }
  return { form, mutate }
}

function selectionFormStub(options: { accept?: boolean; initial?: SelectionConfigValues; loading?: boolean } = {}) {
  let snapshot: ConfigFormSnapshot<SelectionConfigValues> = {
    status: options.loading ? 'loading' : 'ready',
    value: options.loading ? undefined : options.initial ?? { skillLimit: 5, fileCandidates: 40, fileLimit: 12 },
    base: {}, user: {}, revision: 4, writable: true, mode: 'host',
  }
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of listeners) listener() }
  const mutate = vi.fn(async (ops: readonly { op: string; path: readonly string[]; value?: unknown }[], expectedRevision?: number) => {
    if (options.accept === false || expectedRevision !== snapshot.revision || snapshot.value === undefined) return false
    const value = { ...snapshot.value }
    for (const op of ops) {
      if (op.op === 'set') Object.assign(value, { [op.path[0]!]: op.value })
    }
    snapshot = { ...snapshot, value, revision: snapshot.revision! + 1 }
    publish()
    return true
  })
  const form: ConfigForm<SelectionConfigValues> = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate,
    set: async () => false,
    unset: async () => false,
  }
  return {
    form, mutate,
    load: (value: SelectionConfigValues) => { snapshot = { ...snapshot, status: 'ready', value }; publish() },
    getValue: () => snapshot.value,
  }
}

function supervisionFormStub(options: { accept?: boolean; initial?: SupervisionConfigValues; loading?: boolean } = {}) {
  let snapshot: ConfigFormSnapshot<SupervisionConfigValues> = {
    status: options.loading ? 'loading' : 'ready',
    value: options.loading ? undefined : options.initial ?? { driftInterval: 6, noProgressRounds: 3, evidenceChars: 24000 },
    base: {}, user: {}, revision: 4, writable: true, mode: 'host',
  }
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of listeners) listener() }
  const mutate = vi.fn(async (ops: readonly { op: string; path: readonly string[]; value?: unknown }[], expectedRevision?: number) => {
    if (options.accept === false || expectedRevision !== snapshot.revision || snapshot.value === undefined) return false
    const value = { ...snapshot.value }
    for (const op of ops) {
      if (op.op === 'set') Object.assign(value, { [op.path[0]!]: op.value })
    }
    snapshot = { ...snapshot, value, revision: snapshot.revision! + 1 }
    publish()
    return true
  })
  const form: ConfigForm<SupervisionConfigValues> = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate,
    set: async () => false,
    unset: async () => false,
  }
  return {
    form, mutate,
    load: (value: SupervisionConfigValues) => { snapshot = { ...snapshot, status: 'ready', value }; publish() },
    getValue: () => snapshot.value,
  }
}

function remoteStub(): JevPageRemote {
  return {
    listFeatures: vi.fn(async () => []),
    listRecords: vi.fn(async () => ({ items: [] })),
    getRecord: vi.fn(async () => null),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 18, recordId: 'probe-1' })),
    getCredentialStatus: vi.fn(async () => ({ configured: true, writable: true, source: 'file' })),
    setCredential: vi.fn(async () => ({ configured: true, writable: true, source: 'file' })),
  }
}

function renderPage(form: ConfigForm<JevConfigValues>, jev: JevPageRemote, selectionForm?: ConfigForm<SelectionConfigValues>, notifySuccess: (message: string) => void = () => {}) {
  return render(<JevPage view="page" form={form} selectionForm={selectionForm} jev={jev} notifySuccess={notifySuccess} t={(key: JevLocaleKey) => en[key]} />)
}

it('validates and saves Native webpage limits without enabling the feature', async () => {
  let snapshot: ConfigFormSnapshot<WebLimits> = { status: 'ready', base: {}, user: {}, revision: 3, writable: true, mode: 'host',
    value: { maxRounds: 20, noProgressRounds: 3, maxCandidates: 80, maxObserveRounds: 3, maxScrollCandidates: 2, historySteps: 8, evidenceChars: 16000, scrollPixels: 600, resultSteps: 5 } }
  const listeners = new Set<() => void>()
  const mutate = vi.fn(async (ops: readonly { op: string; path: readonly string[]; value?: unknown }[], revision?: number) => {
    expect(revision).toBe(3)
    snapshot = { ...snapshot, value: { ...snapshot.value! }, revision: 4 }
    for (const op of ops) Object.assign(snapshot.value!, { [op.path[0]]: op.value })
    for (const notify of listeners) notify()
    return true
  })
  const form: ConfigForm<WebLimits> = { getSnapshot: () => snapshot, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    mutate, set: async () => false, unset: async () => false }
  const notifySuccess = vi.fn()
  render(<WebSettings form={form} t={key => zh[key]} notifySuccess={notifySuccess} />)
  const rounds = await screen.findByLabelText(new RegExp(zh.webMaxRounds))
  fireEvent.change(rounds, { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: zh.webSave }))
  expect(await screen.findByText(zh.webInvalid)).toBeTruthy()
  expect(mutate).not.toHaveBeenCalled()
  fireEvent.change(rounds, { target: { value: '7' } })
  fireEvent.change(screen.getByLabelText(new RegExp(zh.webMaxObserve)), { target: { value: '4' } })
  fireEvent.change(screen.getByLabelText(new RegExp(zh.webMaxScrollCandidates)), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: zh.webSave }))
  await waitFor(() => expect(notifySuccess).toHaveBeenCalledWith(zh.webSaved))
  expect(snapshot.value?.maxRounds).toBe(7)
  expect(snapshot.value?.maxObserveRounds).toBe(4)
  expect(snapshot.value?.maxScrollCandidates).toBe(1)
  expect(mutate.mock.calls[0][0].some(op => op.path.includes('features'))).toBe(false)
})

describe('Jev bundle page', () => {
  it('shows only credential status, writes a replacement, and runs one explicit diagnostic', async () => {
    const { form } = formStub()
    const jev = remoteStub()
    renderPage(form, jev)
    expect(await screen.findByText(en.noFeatures)).toBeTruthy()
    expect(screen.getByText(new RegExp(en.configured))).toBeTruthy()
    expect(screen.queryByDisplayValue('saved-secret')).toBeNull()

    fireEvent.change(screen.getByLabelText(new RegExp(en.apiKey)), { target: { value: 'new-secret' } })
    fireEvent.click(screen.getByRole('button', { name: en.replaceKey }))
    await waitFor(() => { expect(jev.setCredential).toHaveBeenCalledWith('new-secret') })
    expect(screen.queryByDisplayValue('new-secret')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))
    await waitFor(() => { expect(jev.testConnection).toHaveBeenCalledTimes(1) })
    expect(await screen.findByText(new RegExp(en.testSucceeded))).toBeTruthy()
  })

  it('checks a refused revision write and keeps a newly registered feature off', async () => {
    const { form, mutate } = formStub(false)
    const jev = remoteStub()
    jev.listFeatures = vi.fn(async () => [{ id: 'example', name: 'Example', description: 'Test feature', enabled: false }])
    renderPage(form, jev)
    expect(await screen.findByText('Example')).toBeTruthy()
    const toggle = screen.getByRole('switch', { name: `${en.enable} Example` })
    fireEvent.click(toggle)
    await waitFor(() => { expect(screen.getByText(en.featureSaveFailed, { exact: false })).toBeTruthy() })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['features', 'example'], value: true }], 1)
  })

  it('preserves an unsaved connection edit when a feature switch changes the configuration revision', async () => {
    const { form } = formStub()
    const jev = remoteStub()
    jev.listFeatures = vi.fn(async () => [{ id: 'example', name: 'Example', description: 'Test feature', enabled: false }])
    renderPage(form, jev)
    expect(await screen.findByText('Example')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://draft.invalid' } })
    fireEvent.click(screen.getByRole('switch', { name: `${en.enable} Example` }))
    await waitFor(() => { expect(screen.getByRole('switch', { name: `${en.disable} Example` })).toBeTruthy() })
    expect((screen.getByLabelText(en.baseUrl) as HTMLInputElement).value).toBe('https://draft.invalid')
  })

  it('refreshes the feature catalogue after a business plugin registers', async () => {
    const { form } = formStub()
    const jev = remoteStub()
    let registered = false
    jev.listFeatures = vi.fn(async () => registered ? [{ id: 'later', name: 'Later feature', description: 'Arrived after the page opened', enabled: false }] : [])
    renderPage(form, jev)
    expect(await screen.findByText(en.noFeatures)).toBeTruthy()
    registered = true
    fireEvent.click(screen.getByRole('button', { name: en.refreshFeatures }))
    expect(await screen.findByText('Later feature')).toBeTruthy()
  })

  it('keeps accepted rows after refresh fails and opens attempt and action details', async () => {
    const { form } = formStub()
    const jev = remoteStub()
    const summary: JevRecordSummary = {
      id: 'record-1', featureId: 'example', sessionId: 'session-1', status: 'succeeded',
      startedAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:01.000Z',
      attempts: 1, actionStatus: 'executed', diagnostic: false,
    }
    const detail: JevRecordDetail = {
      ...summary, link: { sessionId: 'session-1' },
      attemptRecords: [{
        id: 'attempt-1', startedAt: summary.startedAt, status: 'succeeded', latencyMs: 18,
        connection: { baseUrl: 'https://example.invalid', model: 'test-model', credentialRef: 'JEV_API_KEY' },
        request: { state: null, questions: [{ id: 'q1', kind: 'noul', prompt: 'Ready?' }] },
        rawResponse: { output: 'raw-answer' },
        response: { answers: [{ id: 'q1', kind: 'noul', probability: 0.9 }] },
        usage: { inputTokens: 4, outputTokens: 2 },
      }],
      receipts: [{ id: 'receipt-1', status: 'executed', at: summary.updatedAt }],
    }
    let calls = 0
    jev.listRecords = vi.fn(async () => {
      calls++
      if (calls > 1) throw new Error('temporary outage')
      return { items: [summary] }
    })
    jev.getRecord = vi.fn(async () => detail)
    renderPage(form, jev)
    fireEvent.click(screen.getByRole('tab', { name: en.records }))
    expect(await screen.findByText(/record-1|session-1/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(await screen.findByText(new RegExp(en.recordsFailed))).toBeTruthy()
    expect(screen.getByText(/session-1/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.details }))
    expect(await screen.findByText('null')).toBeTruthy()
    expect(screen.getByText(/raw-answer/)).toBeTruthy()
    expect(screen.getByText(/inputTokens/)).toBeTruthy()
    expect(screen.getByText(/test-model/)).toBeTruthy()
    expect(screen.getByText(/receipt-1/)).toBeTruthy()
  })

  it('drops a late detail response after changing record filters', async () => {
    const { form } = formStub()
    const jev = remoteStub()
    const summary: JevRecordSummary = {
      id: 'record-1', featureId: 'example', status: 'succeeded',
      startedAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:01.000Z',
      attempts: 1, diagnostic: false,
    }
    jev.listRecords = vi.fn(async () => ({ items: [summary] }))
    let settle: (detail: JevRecordDetail | null) => void = () => {}
    jev.getRecord = vi.fn(() => new Promise<JevRecordDetail | null>(resolve => { settle = resolve }))
    renderPage(form, jev)
    fireEvent.click(screen.getByRole('tab', { name: en.records }))
    expect(await screen.findByText('example')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.details }))
    fireEvent.change(screen.getByLabelText(en.feature), { target: { value: 'former-feature' } })
    fireEvent.click(screen.getByRole('button', { name: en.applyFilters }))
    expect(jev.listRecords).toHaveBeenLastCalledWith({ featureId: 'former-feature', limit: 25 })
    settle({ ...summary, link: {}, attemptRecords: [], receipts: [] })
    await waitFor(() => { expect(screen.queryByRole('button', { name: en.closeDetails })).toBeNull() })
  })
})

describe('Jev selection counts', () => {
  it('describes the glob bypass threshold and ranked display count', () => {
    const { form } = formStub()
    const selection = selectionFormStub()
    renderPage(form, remoteStub(), selection.form)
    expect(screen.getByText(en.selectionCountsHint)).toBeTruthy()
    expect(en.selectionCountsHint).toContain('more files')
    expect(en.selectionCountsHint).toContain('original glob result')
    expect(zh.selectionCountsHint).toContain('超过排序上限')
    expect(zh.selectionCountsHint).toContain('跳过 Jev')
    expect(en.rankedPathCount).toBe('Ranked paths shown')
    expect(zh.rankedPathCount).toBe('展示的已排序路径数')
  })

  it('shows saved profile values after the selection form loads', async () => {
    const { form } = formStub()
    const selection = selectionFormStub({ loading: true })
    renderPage(form, remoteStub(), selection.form)
    expect(screen.queryByLabelText(en.skillSummaryCount)).toBeNull()
    selection.load({ skillLimit: 8, fileCandidates: 60, fileLimit: 16 })
    await waitFor(() => { expect((screen.getByLabelText(en.skillSummaryCount) as HTMLInputElement).value).toBe('8') })
    expect((screen.getByLabelText(en.fileRankingMaximum) as HTMLInputElement).value).toBe('60')
    expect((screen.getByLabelText(en.rankedPathCount) as HTMLInputElement).value).toBe('16')
  })

  it('saves all three counts in one revision-aware mutation', async () => {
    const { form } = formStub()
    const selection = selectionFormStub()
    const notifySuccess = vi.fn()
    renderPage(form, remoteStub(), selection.form, notifySuccess)
    await waitFor(() => { expect((screen.getByLabelText(en.skillSummaryCount) as HTMLInputElement).value).toBe('5') })
    fireEvent.change(screen.getByLabelText(en.skillSummaryCount), { target: { value: '9' } })
    fireEvent.change(screen.getByLabelText(en.fileRankingMaximum), { target: { value: '50' } })
    fireEvent.change(screen.getByLabelText(en.rankedPathCount), { target: { value: '18' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveSelectionCounts }))
    await waitFor(() => { expect(selection.mutate).toHaveBeenCalledTimes(1) })
    expect(selection.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['skillLimit'], value: 9 },
      { op: 'set', path: ['fileCandidates'], value: 50 },
      { op: 'set', path: ['fileLimit'], value: 18 },
    ], 4)
    expect(selection.getValue()).toEqual({ skillLimit: 9, fileCandidates: 50, fileLimit: 18 })
    expect(notifySuccess).toHaveBeenCalledWith(en.selectionCountSaved)
  })

  it('rejects empty, zero, negative, fractional, and unsafe counts without a write', async () => {
    const { form } = formStub()
    const selection = selectionFormStub()
    renderPage(form, remoteStub(), selection.form)
    await waitFor(() => { expect((screen.getByLabelText(en.skillSummaryCount) as HTMLInputElement).value).toBe('5') })
    for (const value of ['', '0', '-1', '1.5', '9007199254740992']) {
      fireEvent.change(screen.getByLabelText(en.skillSummaryCount), { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: en.saveSelectionCounts }))
      expect(screen.getByLabelText(en.skillSummaryCount).getAttribute('aria-invalid')).toBe('true')
      expect(selection.mutate).not.toHaveBeenCalled()
    }
    expect(selection.getValue()).toEqual({ skillLimit: 5, fileCandidates: 40, fileLimit: 12 })
  })

  it('keeps edits and saved values when the form refuses a revision write', async () => {
    const { form } = formStub()
    const selection = selectionFormStub({ accept: false })
    renderPage(form, remoteStub(), selection.form)
    await waitFor(() => { expect((screen.getByLabelText(en.fileRankingMaximum) as HTMLInputElement).value).toBe('40') })
    fireEvent.change(screen.getByLabelText(en.fileRankingMaximum), { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveSelectionCounts }))
    expect(await screen.findByText(en.selectionCountSaveFailed)).toBeTruthy()
    expect((screen.getByLabelText(en.fileRankingMaximum) as HTMLInputElement).value).toBe('45')
    expect(selection.getValue()?.fileCandidates).toBe(40)
    expect(selection.mutate).toHaveBeenCalledWith(expect.any(Array), 4)
  })

  it('preserves unsaved selection and connection edits across writes to the other form', async () => {
    const publicForm = formStub()
    const selection = selectionFormStub()
    const jev = remoteStub()
    jev.listFeatures = vi.fn(async () => [{ id: 'example', name: 'Example', description: 'Test feature', enabled: false }])
    renderPage(publicForm.form, jev, selection.form)
    expect(await screen.findByText('Example')).toBeTruthy()
    await waitFor(() => { expect((screen.getByLabelText(en.skillSummaryCount) as HTMLInputElement).value).toBe('5') })
    fireEvent.change(screen.getByLabelText(en.skillSummaryCount), { target: { value: '7' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://draft.invalid' } })
    fireEvent.click(screen.getByRole('switch', { name: `${en.enable} Example` }))
    await waitFor(() => { expect(screen.getByRole('switch', { name: `${en.disable} Example` })).toBeTruthy() })
    expect((screen.getByLabelText(en.skillSummaryCount) as HTMLInputElement).value).toBe('7')
    fireEvent.click(screen.getByRole('button', { name: en.saveSelectionCounts }))
    await waitFor(() => { expect(selection.getValue()?.skillLimit).toBe(7) })
    expect((screen.getByLabelText(en.baseUrl) as HTMLInputElement).value).toBe('https://draft.invalid')
    expect(publicForm.form.getSnapshot().value?.baseUrl).toBe('https://example.invalid')
    expect(publicForm.form.getSnapshot().value?.features.example).toBe(true)
    expect(publicForm.mutate).toHaveBeenCalledTimes(1)
  })
})


describe('Jev supervision settings', () => {
  it('toggles one feature independently, validates counts, and reloads accepted profile values', async () => {
    const { form } = formStub()
    const counts = supervisionFormStub()
    const jev = remoteStub()
    jev.listFeatures = vi.fn(async () => ['drift-monitoring', 'completion-check', 'goal-supervision'].map(id => ({ id, name: id, description: id, enabled: false })))
    const draw = () => render(<JevPage view="page" form={form} supervisionForm={counts.form} jev={jev} notifySuccess={() => {}} t={(key: JevLocaleKey) => en[key]} />)
    const mounted = draw()
    expect((await screen.findAllByRole('switch')).every(element => element.getAttribute('aria-checked') === 'false')).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable completion-check' }))
    await waitFor(() => expect(form.getSnapshot().value?.features).toEqual({ 'completion-check': true }))
    expect(screen.getByRole('switch', { name: 'Enable drift-monitoring' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Enable goal-supervision' }).getAttribute('aria-checked')).toBe('false')
    expect((screen.getByLabelText(en.driftInterval) as HTMLInputElement).value).toBe('6')
    expect((screen.getByLabelText(en.noProgressRounds) as HTMLInputElement).value).toBe('3')
    fireEvent.change(screen.getByLabelText(en.driftInterval), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveSupervisionCounts }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(counts.mutate).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(en.driftInterval), { target: { value: '9' } })
    fireEvent.change(screen.getByLabelText(en.noProgressRounds), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveSupervisionCounts }))
    await waitFor(() => expect(counts.getValue()).toEqual({ driftInterval: 9, noProgressRounds: 4, evidenceChars: 24000 }))
    mounted.unmount(); draw()
    expect((screen.getByLabelText(en.driftInterval) as HTMLInputElement).value).toBe('9')
    expect((screen.getByLabelText(en.noProgressRounds) as HTMLInputElement).value).toBe('4')
    expect((await screen.findByRole('switch', { name: 'Disable completion-check' })).getAttribute('aria-checked')).toBe('true')
  })
})
