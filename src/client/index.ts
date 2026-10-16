/**
 * Browser mailbox plugin contributing the 信箱 (Mailbox) tab to the
 * conversation view slot, between Chat (order 0) and Trajectory (order 10).
 * Read-only: data comes from the `GET /session-mail/mailbox` route registered
 * by this package's node half; labels follow the active locale through the
 * locale service.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MailboxPayload } from './MailboxView.tsx'
import { MailboxView } from './MailboxView.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services: the conversation slot and the locale service. */
export const inject = ['slots', 'locale']

/** Same-origin read route registered by this package's node half. */
const MAILBOX_ROUTE = '/session-mail/mailbox'

/**
 * Client plugin body: register the locale dictionaries and the mailbox view
 * tab. The registration rides the slot service's inject wrapper, so it waits
 * for the conversation.view declaration and unloads with this plugin.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-mail: dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration.
  const t = ctx.locale.bind(NS)

  const fetchMailbox = async (): Promise<MailboxPayload> => {
    const response = await fetch(MAILBOX_ROUTE, { cache: 'no-store' })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`HTTP ${String(response.status)}${detail === '' ? '' : `: ${detail}`}`)
    }
    return await response.json() as MailboxPayload
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'mailbox',
    order: 5,
    locale: NS,
    label: () => t('view.mailbox'),
    inject: () => ({ fetchMailbox, t }),
  }, MailboxView))
}
