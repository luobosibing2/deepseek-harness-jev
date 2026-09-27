/** Jev bundle settings, feature catalogue, and bounded decision-record browser. */

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, SegmentedTabs, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { WebSettings } from './WebSettings.tsx'
import type { WebLimits } from '../web-types.ts'
import type { SupervisionConfigValues } from '../supervision-types.ts'
import type { SelectionConfigValues } from '../selection-types.ts'
import type {
  JevActionStatus, JevCredentialStatus, JevFeatureView, JevProbeResult, JevRecordDetail,
  JevRecordFilter, JevRecordPage, JevRecordStatus, JevRecordSummary,
} from '../types.ts'
import type { JevLocaleKey } from './locales.ts'
import css from './JevPage.module.css'

/** Settings section exposed by the Jev Host plugin. */
export interface JevConfigValues {
  baseUrl: string
  model: string
  credentialRef: string
  timeoutMs: number
  features: Record<string, boolean>
}

/** Browser calls provided by the Jev Remote namespace. */
export interface JevPageRemote {
  listFeatures(): Promise<JevFeatureView[]>
  listRecords(filter: JevRecordFilter): Promise<JevRecordPage>
  getRecord(id: string): Promise<JevRecordDetail | null>
  testConnection(signal: AbortSignal): Promise<JevProbeResult>
  getCredentialStatus(): Promise<JevCredentialStatus>
  setCredential(value: string): Promise<JevCredentialStatus>
}

/** Data and commands injected by the bundle registration. */
export interface JevPageFace {
  form: ConfigForm<JevConfigValues>
  selectionForm?: ConfigForm<SelectionConfigValues>
  supervisionForm?: ConfigForm<SupervisionConfigValues>
  webForm?: ConfigForm<WebLimits>
  jev: JevPageRemote
  notifySuccess: (message: string) => void
}

/** Props assembled by the bundle slot and locale renderer. */
export type JevPageProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<'jev.plugin'> & InjectFace<JevPageFace>

type Translate = (key: JevLocaleKey) => string
type Tab = 'settings' | 'records'

const STATUSES: readonly JevRecordStatus[] = ['pending', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted']
const PAGE_SIZE = 25

function statusLabel(status: JevRecordStatus, t: Translate): string {
  return t(status)
}

function actionStatusLabel(status: JevActionStatus, t: Translate): string {
  const key: Record<JevActionStatus, JevLocaleKey> = {
    unconfirmed: 'unconfirmed', 'not-adopted': 'notAdopted', cancelled: 'cancelled', executed: 'executed',
    'execution-failed': 'executionFailed', observed: 'observed',
  }
  return t(key[status])
}

function dateText(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

function JsonDetail({ value }: { value: unknown }) {
  return <pre className={css.code}>{JSON.stringify(value, null, 2)}</pre>
}

function DetailBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null
  return <div className={css.detailBlock}><span className={css.detailLabel}>{label}</span><JsonDetail value={value} /></div>
}

function Loading({ label }: { label: string }) {
  return <div className={css.loading} role="status" aria-label={label}><StateDot state="ongoing" size={24} /></div>
}

/** Render one plugin-owned page inside the Host Plugins bundle detail. */
export function JevPage(props: JevPageProps) {
  const [tab, setTab] = useState<Tab>('settings')
  const t = props.t
  if (props.view !== 'page') return null
  return (
    <div className={css.page}>
      <SegmentedTabs
        label={t('tabs')}
        items={[
          { value: 'settings', label: t('settings'), id: 'jev-settings-tab', panelId: 'jev-settings-panel' },
          { value: 'records', label: t('records'), id: 'jev-records-tab', panelId: 'jev-records-panel' },
        ]}
        value={tab}
        onChange={setTab}
        className={css.tabs}
      />
      {tab === 'settings'
        ? <div id="jev-settings-panel" role="tabpanel" aria-labelledby="jev-settings-tab" className={css.panel}>
          <SettingsPanel form={props.form} jev={props.jev} notifySuccess={props.notifySuccess} t={t} />
          {props.webForm && <WebSettings form={props.webForm} notifySuccess={props.notifySuccess} t={t} />}
          {props.supervisionForm && <SupervisionSettings form={props.supervisionForm} notifySuccess={props.notifySuccess} t={t} />}
          {props.selectionForm && <SelectionSettings form={props.selectionForm} notifySuccess={props.notifySuccess} t={t} />}
        </div>
        : <div id="jev-records-panel" role="tabpanel" aria-labelledby="jev-records-tab"><RecordsPanel jev={props.jev} t={t} /></div>}
    </div>
  )
}

interface PanelProps { form: ConfigForm<JevConfigValues>; jev: JevPageRemote; notifySuccess: (message: string) => void; t: Translate }

type SelectionField = keyof SelectionConfigValues
const SELECTION_FIELDS: readonly { key: SelectionField; label: JevLocaleKey }[] = [
  { key: 'skillLimit', label: 'skillSummaryCount' },
  { key: 'fileCandidates', label: 'fileRankingMaximum' },
  { key: 'fileLimit', label: 'rankedPathCount' },
]

function parsePositiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function SelectionSettings({ form, notifySuccess, t }: {
  form: ConfigForm<SelectionConfigValues>; notifySuccess: (message: string) => void; t: Translate
}) {
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [draft, setDraft] = useState<Record<SelectionField, string>>({ skillLimit: '', fileCandidates: '', fileLimit: '' })
  const [errors, setErrors] = useState<Partial<Record<SelectionField, boolean>>>({})
  const [saveError, setSaveError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const edited = useRef(false)
  const observed = useRef('')

  useEffect(() => {
    if (snapshot.value === undefined) return
    const next = {
      skillLimit: String(snapshot.value.skillLimit),
      fileCandidates: String(snapshot.value.fileCandidates),
      fileLimit: String(snapshot.value.fileLimit),
    }
    const signature = JSON.stringify(next)
    if (signature === observed.current) return
    observed.current = signature
    if (!edited.current) setDraft(next)
    setHydrated(true)
  }, [snapshot.value])

  const current = snapshot.value
  const dirty = hydrated && current !== undefined && SELECTION_FIELDS.some(({ key }) => draft[key] !== String(current[key]))

  useEffect(() => { if (!dirty) edited.current = false }, [dirty])

  const edit = (key: SelectionField, value: string) => {
    edited.current = true
    setDraft(previous => ({ ...previous, [key]: value }))
    setErrors(previous => ({ ...previous, [key]: false }))
    setSaveError(false)
  }

  const save = async () => {
    const parsed = {} as SelectionConfigValues
    const nextErrors: Partial<Record<SelectionField, boolean>> = {}
    for (const { key } of SELECTION_FIELDS) {
      const value = parsePositiveInteger(draft[key])
      if (value === null) nextErrors[key] = true
      else parsed[key] = value
    }
    if (Object.keys(nextErrors).length > 0) { setErrors(nextErrors); return }
    setSaving(true)
    setSaveError(false)
    try {
      const accepted = await form.mutate(SELECTION_FIELDS.map(({ key }) => ({ op: 'set' as const, path: [key], value: parsed[key] })), snapshot.revision)
      if (accepted) {
        const saved = form.getSnapshot().value
        if (saved !== undefined) {
          setDraft({ skillLimit: String(saved.skillLimit), fileCandidates: String(saved.fileCandidates), fileLimit: String(saved.fileLimit) })
          edited.current = false
        }
        notifySuccess(t('selectionCountSaved'))
      } else setSaveError(true)
    } catch { setSaveError(true) }
    finally { setSaving(false) }
  }

  return <section className={css.section} aria-label={t('selectionCounts')}>
    <h3 className={css.heading}>{t('selectionCounts')}</h3>
    <p className={css.hint}>{t('selectionCountsHint')}</p>
    {snapshot.status === 'loading' && current === undefined && <Loading label={t('loading')} />}
    {snapshot.status === 'unavailable' && <p className={css.notice}>{t('unavailable')}</p>}
    {current !== undefined && <div className={css.form}>
      <div className={css.filters}>{SELECTION_FIELDS.map(({ key, label }) => <div className={css.field} key={key}>
        <label htmlFor={`jev-selection-${key}`}>{t(label)}</label>
        <input id={`jev-selection-${key}`} type="text" inputMode="numeric" value={draft[key]} aria-invalid={errors[key] || undefined} aria-describedby={errors[key] ? `jev-selection-${key}-error` : undefined} disabled={!snapshot.writable || saving} onChange={event => { edit(key, event.target.value) }} />
        {errors[key] && <span id={`jev-selection-${key}-error`} role="alert" className={css.notice}>{t('selectionCountInvalid')}</span>}
      </div>)}</div>
      <div className={css.actions}><Button variant="primary" disabled={!snapshot.writable || saving || !dirty} onClick={() => { void save() }}>{saving ? t('saving') : t('saveSelectionCounts')}</Button>{!snapshot.writable && <span className={css.hint}>{t('readOnly')}</span>}</div>
      {saveError && <p role="alert" className={css.notice}>{t('selectionCountSaveFailed')}</p>}
    </div>}
  </section>
}

type SupervisionField = keyof SupervisionConfigValues
const SUPERVISION_FIELDS: readonly { key: SupervisionField; label: JevLocaleKey }[] = [
  { key: 'driftInterval', label: 'driftInterval' },
  { key: 'noProgressRounds', label: 'noProgressRounds' },
  { key: 'evidenceChars', label: 'evidenceChars' },
]

function SupervisionSettings({ form, notifySuccess, t }: {
  form: ConfigForm<SupervisionConfigValues>; notifySuccess: (message: string) => void; t: Translate
}) {
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [draft, setDraft] = useState<Record<SupervisionField, string>>({ driftInterval: '', noProgressRounds: '', evidenceChars: '' })
  const [errors, setErrors] = useState<Partial<Record<SupervisionField, boolean>>>({})
  const [saveError, setSaveError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const edited = useRef(false)
  const observed = useRef('')

  useEffect(() => {
    if (snapshot.value === undefined) return
    const next = {
      driftInterval: String(snapshot.value.driftInterval),
      noProgressRounds: String(snapshot.value.noProgressRounds),
      evidenceChars: String(snapshot.value.evidenceChars),
    }
    const signature = JSON.stringify(next)
    if (signature === observed.current) return
    observed.current = signature
    if (!edited.current) setDraft(next)
    setHydrated(true)
  }, [snapshot.value])

  const current = snapshot.value
  const dirty = hydrated && current !== undefined && SUPERVISION_FIELDS.some(({ key }) => draft[key] !== String(current[key]))

  useEffect(() => { if (!dirty) edited.current = false }, [dirty])

  const edit = (key: SupervisionField, value: string) => {
    edited.current = true
    setDraft(previous => ({ ...previous, [key]: value }))
    setErrors(previous => ({ ...previous, [key]: false }))
    setSaveError(false)
  }

  const save = async () => {
    const parsed = {} as SupervisionConfigValues
    const nextErrors: Partial<Record<SupervisionField, boolean>> = {}
    for (const { key } of SUPERVISION_FIELDS) {
      const value = parsePositiveInteger(draft[key])
      if (value === null) nextErrors[key] = true
      else parsed[key] = value
    }
    if (Object.keys(nextErrors).length > 0) { setErrors(nextErrors); return }
    setSaving(true)
    setSaveError(false)
    try {
      const accepted = await form.mutate(SUPERVISION_FIELDS.map(({ key }) => ({ op: 'set' as const, path: [key], value: parsed[key] })), snapshot.revision)
      if (accepted) {
        const saved = form.getSnapshot().value
        if (saved !== undefined) {
          setDraft({ driftInterval: String(saved.driftInterval), noProgressRounds: String(saved.noProgressRounds), evidenceChars: String(saved.evidenceChars) })
          edited.current = false
        }
        notifySuccess(t('supervisionCountSaved'))
      } else setSaveError(true)
    } catch { setSaveError(true) }
    finally { setSaving(false) }
  }

  return <section className={css.section} aria-label={t('supervisionCounts')}>
    <h3 className={css.heading}>{t('supervisionCounts')}</h3>
    <p className={css.hint}>{t('supervisionCountsHint')}</p>
    {snapshot.status === 'loading' && current === undefined && <Loading label={t('loading')} />}
    {snapshot.status === 'unavailable' && <p className={css.notice}>{t('unavailable')}</p>}
    {current !== undefined && <div className={css.form}>
      <div className={css.filters}>{SUPERVISION_FIELDS.map(({ key, label }) => <div className={css.field} key={key}>
        <label htmlFor={`jev-supervision-${key}`}>{t(label)}</label>
        <input id={`jev-supervision-${key}`} type="text" inputMode="numeric" value={draft[key]} aria-invalid={errors[key] || undefined} aria-describedby={errors[key] ? `jev-supervision-${key}-error` : undefined} disabled={!snapshot.writable || saving} onChange={event => { edit(key, event.target.value) }} />
        {errors[key] && <span id={`jev-supervision-${key}-error`} role="alert" className={css.notice}>{t('supervisionCountInvalid')}</span>}
      </div>)}</div>
      <div className={css.actions}><Button variant="primary" disabled={!snapshot.writable || saving || !dirty} onClick={() => { void save() }}>{saving ? t('saving') : t('saveSupervisionCounts')}</Button>{!snapshot.writable && <span className={css.hint}>{t('readOnly')}</span>}</div>
      {saveError && <p role="alert" className={css.notice}>{t('supervisionCountSaveFailed')}</p>}
    </div>}
  </section>
}

function SettingsPanel({ form, jev, notifySuccess, t }: PanelProps) {
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [draft, setDraft] = useState({ baseUrl: '', model: '', credentialRef: 'JEV_API_KEY', timeoutMs: '30000' })
  const editedConnection = useRef(false)
  const observedConnection = useRef('')
  const [features, setFeatures] = useState<readonly JevFeatureView[]>([])
  const [featureLoading, setFeatureLoading] = useState(true)
  const [featureError, setFeatureError] = useState('')
  const [featureErrorLabel, setFeatureErrorLabel] = useState<'featureLoadFailed' | 'featureSaveFailed'>('featureLoadFailed')
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [featureBusy, setFeatureBusy] = useState('')
  const [credential, setCredential] = useState<JevCredentialStatus | null>(null)
  const [credentialMessage, setCredentialMessage] = useState('')
  const [secret, setSecret] = useState('')
  const [secretSaving, setSecretSaving] = useState(false)
  const [probe, setProbe] = useState<JevProbeResult | null>(null)
  const [probeError, setProbeError] = useState('')
  const [testing, setTesting] = useState(false)
  const probeAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (snapshot.value === undefined) return
    const next = {
      baseUrl: snapshot.value.baseUrl,
      model: snapshot.value.model,
      credentialRef: snapshot.value.credentialRef,
      timeoutMs: String(snapshot.value.timeoutMs),
    }
    const signature = JSON.stringify(next)
    if (signature === observedConnection.current) return
    observedConnection.current = signature
    if (!editedConnection.current) setDraft(next)
  }, [snapshot.value])

  const loadFeatures = useCallback(async () => {
    setFeatureLoading(true)
    setFeatureError('')
    try { setFeatures(await jev.listFeatures()) }
    catch { setFeatureErrorLabel('featureLoadFailed'); setFeatureError(t('featureLoadFailed')) }
    finally { setFeatureLoading(false) }
  }, [jev, t])

  const loadCredential = useCallback(async () => {
    try { setCredential(await jev.getCredentialStatus()); setCredentialMessage('') }
    catch { setCredentialMessage(t('unavailable')) }
  }, [jev, t])

  useEffect(() => { void loadFeatures(); void loadCredential(); return () => { probeAbort.current?.abort() } }, [loadFeatures, loadCredential])

  const current = snapshot.value
  const dirty = current !== undefined && (
    draft.baseUrl !== current.baseUrl || draft.model !== current.model ||
    draft.credentialRef !== current.credentialRef || draft.timeoutMs !== String(current.timeoutMs)
  )

  useEffect(() => { if (!dirty) editedConnection.current = false }, [dirty])

  const editConnection = (field: keyof typeof draft, value: string) => {
    editedConnection.current = true
    setDraft(previous => ({ ...previous, [field]: value }))
  }

  const saveConnection = async () => {
    const timeoutMs = Number(draft.timeoutMs)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) { setSaveMessage(t('invalidTimeout')); return }
    setSaving(true)
    setSaveMessage('')
    try {
      const accepted = await form.mutate([
        { op: 'set', path: ['baseUrl'], value: draft.baseUrl.trim() },
        { op: 'set', path: ['model'], value: draft.model.trim() },
        { op: 'set', path: ['credentialRef'], value: draft.credentialRef.trim() },
        { op: 'set', path: ['timeoutMs'], value: timeoutMs },
      ], snapshot.revision)
      if (accepted) {
        notifySuccess(t('saveSuccess'))
        editedConnection.current = false
        const saved = form.getSnapshot().value
        if (saved !== undefined) setDraft({ baseUrl: saved.baseUrl, model: saved.model, credentialRef: saved.credentialRef, timeoutMs: String(saved.timeoutMs) })
        void loadCredential()
      } else setSaveMessage(t('saveFailed'))
    } catch { setSaveMessage(t('saveFailed')) }
    finally { setSaving(false) }
  }

  const saveKey = async () => {
    if (!secret) return
    setSecretSaving(true)
    setCredentialMessage('')
    try {
      setCredential(await jev.setCredential(secret))
      setSecret('')
      notifySuccess(t('keySaved'))
    } catch { setCredentialMessage(t('keySaveFailed')) }
    finally { setSecretSaving(false) }
  }

  const runProbe = async () => {
    const controller = new AbortController()
    probeAbort.current = controller
    setTesting(true)
    setProbe(null)
    setProbeError('')
    try { setProbe(await jev.testConnection(controller.signal)) }
    catch { if (!controller.signal.aborted) setProbeError(t('testFailed')) }
    finally { if (probeAbort.current === controller) probeAbort.current = null; setTesting(false) }
  }

  const toggleFeature = async (id: string, enabled: boolean) => {
    setFeatureBusy(id)
    setFeatureError('')
    try {
      const accepted = await form.mutate([{ op: 'set', path: ['features', id], value: enabled }], snapshot.revision)
      if (!accepted) { setFeatureErrorLabel('featureSaveFailed'); setFeatureError(t('featureSaveFailed')) }
    } catch { setFeatureErrorLabel('featureSaveFailed'); setFeatureError(t('featureSaveFailed')) }
    finally { setFeatureBusy('') }
  }

  return (
    <div className={css.panel}>
      <section className={css.section} aria-label={t('connection')}>
        <h3 className={css.heading}>{t('connection')}</h3>
        {snapshot.status === 'loading' && current === undefined && <Loading label={t('loading')} />}
        {snapshot.status === 'unavailable' && <p className={css.notice}>{t('unavailable')}</p>}
        {current !== undefined && <div className={css.form}>
          <div className={css.filters}>
            <label className={css.field}><span>{t('baseUrl')}</span><input value={draft.baseUrl} disabled={!snapshot.writable || saving} onChange={event => { editConnection('baseUrl', event.target.value) }} /></label>
            <label className={css.field}><span>{t('model')}</span><input value={draft.model} disabled={!snapshot.writable || saving} onChange={event => { editConnection('model', event.target.value) }} /></label>
            <label className={css.field}><span>{t('credentialRef')}</span><input value={draft.credentialRef} disabled={!snapshot.writable || saving} onChange={event => { editConnection('credentialRef', event.target.value) }} /></label>
            <label className={css.field}><span>{t('timeoutMs')}</span><input type="number" min="1" step="1" value={draft.timeoutMs} disabled={!snapshot.writable || saving} onChange={event => { editConnection('timeoutMs', event.target.value) }} /></label>
          </div>
          <div className={css.actions}><Button variant="primary" disabled={!snapshot.writable || saving || !dirty} onClick={() => { void saveConnection() }}>{saving ? t('saving') : t('saveConnection')}</Button>{!snapshot.writable && <span className={css.hint}>{t('readOnly')}</span>}</div>
          {saveMessage && <p role="status" className={css.notice}>{saveMessage}</p>}
        </div>}
        <div className={css.form}>
          <label className={css.field}><span>{t('apiKey')}{credential !== null ? ` · ${credential.configured ? t('configured') : t('missing')}${!credential.writable ? ` · ${t('readOnly')}` : ''}` : ''}</span><input type="password" autoComplete="new-password" value={secret} disabled={!credential?.writable || secretSaving || dirty} onChange={event => { setSecret(event.target.value) }} /><span className={css.hint}>{t('apiKeyHint')}</span></label>
          <div className={css.actions}><Button disabled={!secret || !credential?.writable || secretSaving || dirty} onClick={() => { void saveKey() }}>{secretSaving ? t('saving') : credential?.configured ? t('replaceKey') : t('saveKey')}</Button><Button disabled={testing || dirty || snapshot.status !== 'ready'} onClick={() => { void runProbe() }}>{testing ? t('testing') : t('testConnection')}</Button></div>
          {dirty && <p className={css.hint}>{t('saveFirst')}</p>}
          {credentialMessage && <p role="status" className={css.notice}>{credentialMessage}</p>}
          {probe && <p role="status" className={probe.ok ? css.success : css.notice}>{t(probe.ok ? 'testSucceeded' : 'testFailed')} · {t('latency')}: {probe.latencyMs} ms{probe.failure ? ` · ${probe.failure.code}: ${probe.failure.message}` : ''}</p>}
          {probeError && <p role="alert" className={css.notice}>{probeError}</p>}
        </div>
      </section>
      <section className={css.section} aria-label={t('features')}>
        <div className={css.recordHead}><h3 className={css.heading}>{t('features')}</h3><Button size="sm" disabled={featureLoading} onClick={() => { void loadFeatures() }}>{t('refreshFeatures')}</Button></div>
        {featureLoading && features.length === 0 && current !== undefined && <Loading label={t('loading')} />}
        {featureError && <p role="alert" className={css.notice}>{featureError} {featureErrorLabel === 'featureLoadFailed' && <Button size="sm" onClick={() => { void loadFeatures() }}>{t('retry')}</Button>}</p>}
        {!featureLoading && !featureError && features.length === 0 && <p className={css.empty}>{t('noFeatures')}</p>}
        <div className={css.list}>{features.map(feature => {
          const enabled = current?.features?.[feature.id] ?? feature.enabled
          return <div className={css.feature} key={feature.id}><div className={css.featureBody}><span className={css.featureTitle}>{feature.id === 'shared-findings' ? t('sharedFindingsName') : feature.name}</span><span className={css.description}>{feature.id === 'shared-findings' ? t('sharedFindingsDescription') : feature.description}</span>{feature.settingsDescription && <span className={css.hint}>{feature.settingsDescription}</span>}</div><Switch checked={enabled} label={`${enabled ? t('disable') : t('enable')} ${feature.id === 'shared-findings' ? t('sharedFindingsName') : feature.name}`} disabled={!snapshot.writable || featureBusy !== ''} onChange={next => { void toggleFeature(feature.id, next) }} /></div>
        })}</div>
      </section>
    </div>
  )
}

interface RecordsProps { jev: JevPageRemote; t: Translate }

function RecordsPanel({ jev, t }: RecordsProps) {
  const [features, setFeatures] = useState<readonly JevFeatureView[]>([])
  const [featureId, setFeatureId] = useState('')
  const [status, setStatus] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [filter, setFilter] = useState<JevRecordFilter>({ limit: PAGE_SIZE })
  const [items, setItems] = useState<readonly JevRecordSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<JevRecordDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const queryGeneration = useRef(0)
  const detailGeneration = useRef(0)

  const query = useCallback(async (nextFilter: JevRecordFilter, append: boolean) => {
    const generation = ++queryGeneration.current
    setLoading(true)
    setError('')
    try {
      const page = await jev.listRecords(nextFilter)
      if (generation !== queryGeneration.current) return
      setItems(previous => append ? [...previous, ...page.items] : page.items)
      setNextCursor(page.nextCursor)
    } catch { if (generation === queryGeneration.current) setError(t('recordsFailed')) }
    finally { if (generation === queryGeneration.current) setLoading(false) }
  }, [jev, t])

  useEffect(() => {
    void query({ limit: PAGE_SIZE }, false)
    void jev.listFeatures().then(setFeatures, () => {})
    return () => { queryGeneration.current++; detailGeneration.current++ }
  }, [jev, query])

  const applyFilters = () => {
    detailGeneration.current++
    const next: JevRecordFilter = { limit: PAGE_SIZE }
    if (featureId) next.featureId = featureId
    if (status) next.status = status as JevRecordStatus
    if (sessionId.trim()) next.sessionId = sessionId.trim()
    setFilter(next)
    setSelected('')
    setDetail(null)
    void query(next, false)
  }

  const openDetail = async (id: string) => {
    const generation = ++detailGeneration.current
    setSelected(id)
    setDetailLoading(true)
    setDetailError('')
    if (detail?.id !== id) setDetail(null)
    try {
      const result = await jev.getRecord(id)
      if (generation === detailGeneration.current) setDetail(result)
    } catch { if (generation === detailGeneration.current) setDetailError(t('detailFailed')) }
    finally { if (generation === detailGeneration.current) setDetailLoading(false) }
  }

  const closeDetail = () => { detailGeneration.current++; setSelected(''); setDetail(null); setDetailError(''); setDetailLoading(false) }

  return <div className={css.panel}>
    <section className={css.section} aria-label={t('records')}>
      <div className={css.filters}>
        <label className={css.field}><span>{t('feature')}</span><input list="jev-feature-suggestions" placeholder={t('allFeatures')} value={featureId} onChange={event => { setFeatureId(event.target.value) }} /><datalist id="jev-feature-suggestions">{features.map(feature => <option value={feature.id} key={feature.id} label={feature.id === 'shared-findings' ? t('sharedFindingsName') : feature.name} />)}</datalist></label>
        <label className={css.field}><span>{t('status')}</span><select value={status} onChange={event => { setStatus(event.target.value) }}><option value="">{t('allStatuses')}</option>{STATUSES.map(value => <option value={value} key={value}>{statusLabel(value, t)}</option>)}</select></label>
        <label className={css.field}><span>{t('sessionId')}</span><input value={sessionId} onChange={event => { setSessionId(event.target.value) }} /></label>
      </div>
      <div className={css.actions}><Button variant="primary" onClick={applyFilters} disabled={loading}>{t('applyFilters')}</Button><Button onClick={() => { void query(filter, false) }} disabled={loading}>{t('refresh')}</Button></div>
      {error && <p role="alert" className={css.notice}>{error} <Button size="sm" onClick={() => { void query(filter, false) }}>{t('retry')}</Button></p>}
      {loading && items.length === 0 && <Loading label={t('loading')} />}
      {!loading && !error && items.length === 0 && <p className={css.empty}>{t('noRecords')}</p>}
      <div className={css.list}>{items.map(item => <article className={css.record} key={item.id}>
        <div className={css.recordHead}><span className={css.featureTitle}>{item.diagnostic ? t('diagnostic') : features.find(feature => feature.id === item.featureId)?.name ?? item.featureId}</span><span className={css.meta}>{statusLabel(item.status, t)}</span></div>
        <span className={css.meta}>{t('time')}: {dateText(item.startedAt)} · {t('attempts')}: {item.attempts}{item.sessionId ? ` · ${t('sessionId')}: ${item.sessionId}` : ''}</span>
        <div><Button size="sm" onClick={() => { void openDetail(item.id) }}>{t('details')}</Button></div>
      </article>)}</div>
      {nextCursor && <div className={css.actions}><Button disabled={loading} onClick={() => { void query({ ...filter, cursor: nextCursor }, true) }}>{loading ? t('loading') : t('loadMore')}</Button></div>}
    </section>
    {selected && <section className={css.section} aria-label={t('details')}><div className={css.recordHead}><h3 className={css.heading}>{t('details')}</h3><Button size="sm" onClick={closeDetail}>{t('closeDetails')}</Button></div>
      {detailError && <p role="alert" className={css.notice}>{detailError} <Button size="sm" onClick={() => { void openDetail(selected) }}>{t('retry')}</Button></p>}
      {detailLoading && !detail && <Loading label={t('loading')} />}
      {!detailLoading && !detailError && !detail && <p className={css.empty}>{t('noDetail')}</p>}
      {detail && <div className={css.detail}>
        <div className={css.meta}>{t('operation')}: {detail.id} · {t('status')}: {statusLabel(detail.status, t)}</div>
        <DetailBlock label={t('operation')} value={detail.link} />
        <DetailBlock label={t('failure')} value={detail.failure} />
        <h4 className={css.heading}>{t('attempts')}</h4>
        {detail.attemptRecords.map((attempt, index) => <div className={css.record} key={attempt.id}>
          <div className={css.meta}>#{index + 1} · {dateText(attempt.startedAt)} · {statusLabel(attempt.status, t)}{attempt.latencyMs !== undefined ? ` · ${t('latency')}: ${attempt.latencyMs} ms` : ''}</div>
          <DetailBlock label={t('connectionIdentity')} value={attempt.connection} />
          <DetailBlock label={t('input')} value={attempt.request.state} />
          <DetailBlock label={t('questions')} value={attempt.request.questions} />
          <DetailBlock label={t('rawAnswer')} value={attempt.rawResponse} />
          <DetailBlock label={t('answer')} value={attempt.response} />
          <DetailBlock label={t('interpretation')} value={attempt.interpretation} />
          <DetailBlock label={t('failure')} value={attempt.failure} />
          <DetailBlock label={t('usage')} value={attempt.usage} />
        </div>)}
        <h4 className={css.heading}>{t('receipts')}</h4>
        {detail.receipts.length === 0 ? <p className={css.empty}>{t('noDetail')}</p> : detail.receipts.map(receipt => <div className={css.record} key={receipt.id}><span className={css.meta}>{dateText(receipt.at)} · {actionStatusLabel(receipt.status, t)}</span><DetailBlock label={t('actualAction')} value={receipt.reason ?? receipt.id} /></div>)}
      </div>}
    </section>}
  </div>
}
