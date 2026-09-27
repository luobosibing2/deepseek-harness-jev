/** Profile-owned limits for explicit Native webpage goals. */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { WebLimits } from '../web-types.ts'
import type { JevLocaleKey } from './locales.ts'
import css from './JevPage.module.css'

const fields: { key: keyof WebLimits; label: JevLocaleKey; max: number }[] = [
  { key: 'maxRounds', label: 'webMaxRounds', max: 1000 },
  { key: 'noProgressRounds', label: 'webNoProgress', max: 1000 },
  { key: 'maxObserveRounds', label: 'webMaxObserve', max: 1000 },
  { key: 'maxScrollCandidates', label: 'webMaxScrollCandidates', max: 1000 },
  { key: 'maxCandidates', label: 'webMaxCandidates', max: 1000 },
  { key: 'historySteps', label: 'webHistory', max: 100 },
  { key: 'evidenceChars', label: 'webEvidence', max: 1000000 },
  { key: 'scrollPixels', label: 'webScroll', max: 10000 },
  { key: 'resultSteps', label: 'webResultSteps', max: 100 },
]

export function WebSettings({ form, t, notifySuccess }: {
  form: ConfigForm<WebLimits>; t: (key: JevLocaleKey) => string; notifySuccess: (message: string) => void
}) {
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [draft, setDraft] = useState<Partial<Record<keyof WebLimits, string>>>({})
  const [error, setError] = useState<JevLocaleKey | null>(null)
  const [saving, setSaving] = useState(false)
  const edited = useRef(false)
  useEffect(() => {
    if (snapshot.value && !edited.current) setDraft(Object.fromEntries(fields.map(({ key }) => [key, String(snapshot.value![key])])))
  }, [snapshot.value])
  const dirty = snapshot.value !== undefined && fields.some(({ key }) => draft[key] !== String(snapshot.value![key]))
  const save = async () => {
    const changes: { op: 'set'; path: string[]; value: number }[] = []
    for (const { key, max } of fields) {
      const value = Number(draft[key])
      if (!Number.isSafeInteger(value) || value <= 0 || value > max) { setError('webInvalid'); return }
      changes.push({ op: 'set', path: [key], value })
    }
    setSaving(true); setError(null)
    try {
      if (!await form.mutate(changes, snapshot.revision)) { setError('webSaveFailed'); return }
      edited.current = false
      const saved = form.getSnapshot().value
      if (saved) setDraft(Object.fromEntries(fields.map(({ key }) => [key, String(saved[key])])))
      notifySuccess(t('webSaved'))
    } catch { setError('webSaveFailed') }
    finally { setSaving(false) }
  }
  return <section className={css.section} aria-label={t('webLimits')}>
    <h3 className={css.heading}>{t('webLimits')}</h3><p className={css.hint}>{t('webLimitsHint')}</p>
    {snapshot.value === undefined && snapshot.status === 'loading' && <StateDot state="ongoing" size={24} />}
    {snapshot.status === 'unavailable' && <p>{t('unavailable')}</p>}
    {snapshot.value !== undefined && <div className={css.form}>
      <div className={css.filters}>{fields.map(({ key, label, max }) => <div className={css.field} key={key}>
        <label htmlFor={`jev-web-${key}`}>{t(label)} (1–{max})</label>
        <input id={`jev-web-${key}`} type="text" inputMode="numeric" value={draft[key] ?? ''} disabled={!snapshot.writable || saving}
          onChange={event => { edited.current = true; setDraft(value => ({ ...value, [key]: event.target.value })); setError(null) }} />
      </div>)}</div>
      <Button variant="primary" disabled={!snapshot.writable || saving || !dirty} onClick={() => { void save() }}>{saving ? t('saving') : t('webSave')}</Button>
      {error && <p role="alert" className={css.notice}>{t(error)}</p>}
    </div>}
  </section>
}
