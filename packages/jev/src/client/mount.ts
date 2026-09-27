/** Browser lifecycle for the Jev Remote contribution and plugin-owned pages. */

import type { Context } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@dsh-jev/plugin/remote'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WebLimits } from '../web-types.ts'
import type { SupervisionConfigValues } from '../supervision-types.ts'
import type { SelectionConfigValues } from '../selection-types.ts'
import { JevPage, type JevConfigValues, type JevPageFace } from './JevPage.tsx'
import { JevToast, type JevToastMessage } from './JevToast.tsx'
import { en, zh, type JevLocaleKey } from './locales.ts'
import { jevPageRemote } from './remote-adapter.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Jev settings and record-browser copy. */
    'jev.plugin': JevLocaleKey
  }
}

const NS = 'jev.plugin'
const PACKAGE = '@dsh-jev/plugin'
const ENTRY = 'jev'
const SELECTION_ENTRY = 'jev-selection'

/** Services needed after the generated Jev Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale', 'configForms']

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const form = ctx.configForms.get<JevConfigValues>(ENTRY)
  const selectionForm = ctx.configForms.get<SelectionConfigValues>(SELECTION_ENTRY)
  const supervisionForm = ctx.configForms.get<SupervisionConfigValues>('jev-supervision')
  const webForm = ctx.configForms.get<WebLimits>('jev-web')
  const toast = createSnapshotStore<JevToastMessage | null>(null)
  let sequence = 0
  const dismiss = () => { toast.set(null) }
  const notifySuccess = (message: string) => { toast.set({ sequence: ++sequence, text: message }) }
  const face: JevPageFace = { form, selectionForm, supervisionForm, webForm, jev: jevPageRemote(ctx.remote.jev), notifySuccess }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'jev.feedback', inject: () => ({ hooks: { jevToast: toast }, dismiss }),
  }, JevToast))
  ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: PACKAGE,
    locale: NS,
    inject: () => face,
  }, JevPage))))
}

/**
 * Mount Jev's generated Remote first, then register the bundle page while its settings entry is served.
 * @param ctx - Client runtime with Remote, locale, slots, and config forms.
 * @param contribution - generated Jev Remote namespace.
 * @returns disposer for both Remote and UI registrations.
 */
export async function mountJevUi(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.jev', 'slots', 'locale', 'configForms'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
