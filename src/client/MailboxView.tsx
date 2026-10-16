/** Mailbox view: email-style read-only reader over the session-mail HTTP route. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MailboxKey } from './locales.ts'
import { ensureStyles } from './styles.ts'

const AUTO_REFRESH_MS = 5_000

/** One mailbox message: the protocol envelope, tolerant of absent v2 fields. */
export interface MailboxMessage {
  readonly id: string
  readonly ts?: string
  readonly from?: string
  readonly topic?: string
  readonly body?: string
  readonly reply_to?: string
  readonly to_session?: string
  readonly from_session?: string
  readonly expect?: string
}

/** One role's inbox snapshot served by the host half. */
export interface MailboxBox {
  readonly role: string
  readonly name: string
  readonly inbox: string
  /** Consumed line count; messages at or beyond this index are pending. */
  readonly cursor: number
  readonly total: number
  /** Authorized live session count for the role (roster-filtered). */
  readonly live: number
  readonly messages: readonly MailboxMessage[]
}

/** The full mailbox payload served by the host half. */
export interface MailboxPayload {
  readonly maildir: string
  readonly generatedAt: string
  readonly boxes: readonly MailboxBox[]
}

/** Fetch callback injected from the plugin apply closure. */
export type MailboxFetch = () => Promise<MailboxPayload>

/** Namespace-bound translator threaded from the plugin apply closure. */
export type MailboxTranslate = (key: MailboxKey, params?: Record<string, string | number>) => string

/** Props: the inject face (the slot contract also passes session-scope owner props, unused here). */
export interface MailboxViewProps {
  readonly fetchMailbox: MailboxFetch
  readonly t: MailboxTranslate
}

/**
 * One routing/meta chip line rendered only when the field is present.
 */
function MetaEntry(props: { label: string, value: string }): React.JSX.Element {
  return (
    <span className="dsw-mailbox-meta">
      <span className="dsw-mailbox-metaKey">{props.label}</span>
      <span className="dsw-mailbox-metaValue">{props.value}</span>
    </span>
  )
}

/**
 * The mailbox tab body: a refresh toolbar plus one email-style card list per
 * configured box, with pending (beyond-cursor) messages visually marked.
 * @param props - the inject face: the fetch callback and the bound translator.
 */
export function MailboxView(props: MailboxViewProps): React.JSX.Element {
  const { fetchMailbox, t } = props
  const [payload, setPayload] = useState<MailboxPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [auto, setAuto] = useState(true)
  const [updatedAt, setUpdatedAt] = useState('')
  const fetchRef = useRef(fetchMailbox)
  fetchRef.current = fetchMailbox

  useEffect(() => { ensureStyles() }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await fetchRef.current()
      setPayload(next)
      setError(null)
      setUpdatedAt(new Date().toLocaleTimeString())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!auto) return undefined
    const timer = window.setInterval(() => { void refresh() }, AUTO_REFRESH_MS)
    return () => { window.clearInterval(timer) }
  }, [auto, refresh])

  const boxes = payload?.boxes ?? []
  const isEmpty = boxes.every(box => box.messages.length === 0)

  return (
    <div className="dsw-mailbox-root">
      <div className="dsw-mailbox-toolbar">
        <button type="button" className="dsw-mailbox-button" onClick={() => { void refresh() }} aria-label={t('header.refreshAria')}>
          {t('header.refresh')}
        </button>
        <label className="dsw-mailbox-auto">
          <input type="checkbox" checked={auto} onChange={event => setAuto(event.target.checked)} />
          <span>{t('header.auto')}</span>
        </label>
        {updatedAt !== '' && <span className="dsw-mailbox-updated">{t('header.updated', { time: updatedAt })}</span>}
        {loading && <span className="dsw-mailbox-loading">{t('state.loading')}</span>}
        {error !== null && <span className="dsw-mailbox-error">{`${t('state.loadFailed')}: ${error}`}</span>}
      </div>
      {isEmpty
        ? <div className="dsw-mailbox-empty">{t('state.empty')}</div>
        : boxes.map(box => <MailboxBoxSection key={box.role} box={box} t={t} />)}
    </div>
  )
}

/** One box section: header stats plus the message cards in file order. */
function MailboxBoxSection(props: { box: MailboxBox, t: MailboxTranslate }): React.JSX.Element {
  const { box, t } = props
  const pending = Math.max(0, box.total - box.cursor)
  return (
    <section className="dsw-mailbox-box">
      <div className="dsw-mailbox-boxHeader">
        <span className="dsw-mailbox-boxName">{box.name}</span>
        <span className="dsw-mailbox-chip">{box.role}</span>
        <span className="dsw-mailbox-live">
          <span className={box.live > 0 ? 'dsw-mailbox-liveDot on' : 'dsw-mailbox-liveDot'} />
          {t('box.live', { count: box.live })}
        </span>
        <span className="dsw-mailbox-chip">{t('box.messages', { count: box.total })}</span>
        {pending > 0 && <span className="dsw-mailbox-pendingChip">{t('box.pending', { count: pending })}</span>}
      </div>
      {box.messages.length === 0
        ? <div className="dsw-mailbox-empty">{t('state.empty')}</div>
        : (
            <div className="dsw-mailbox-cards">
              {box.messages.map((message, index) => (
                <MailboxCard key={message.id} message={message} pending={index >= box.cursor} t={t} />
              ))}
            </div>
          )}
    </section>
  )
}

/** One message card: sender, topic, time, body, and present routing fields. */
function MailboxCard(props: { message: MailboxMessage, pending: boolean, t: MailboxTranslate }): React.JSX.Element {
  const { message, pending, t } = props
  return (
    <article className={pending ? 'dsw-mailbox-card pending' : 'dsw-mailbox-card'}>
      <div className="dsw-mailbox-cardHead">
        <span className="dsw-mailbox-from">{message.from ?? '—'}</span>
        {message.topic !== undefined && <span className="dsw-mailbox-topic">{message.topic}</span>}
        {pending && <span className="dsw-mailbox-pendingBadge">{t('msg.pending')}</span>}
        {message.ts !== undefined && <span className="dsw-mailbox-time">{message.ts}</span>}
      </div>
      {message.body !== undefined && <p className="dsw-mailbox-body">{message.body}</p>}
      <div className="dsw-mailbox-meta">
        {message.reply_to !== undefined && <MetaEntry label={t('field.replyTo')} value={message.reply_to} />}
        {message.expect !== undefined && <MetaEntry label={t('field.expect')} value={message.expect} />}
        {message.to_session !== undefined && <MetaEntry label={t('field.to')} value={message.to_session} />}
        {message.from_session !== undefined && <MetaEntry label={t('field.fromSession')} value={message.from_session} />}
      </div>
    </article>
  )
}
