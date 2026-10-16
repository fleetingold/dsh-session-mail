/** `session-mail` namespace dictionaries for the mailbox tab surface. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'session-mail'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'view.mailbox': '信箱',
  'header.refresh': '刷新',
  'header.refreshAria': '刷新信箱',
  'header.auto': '自动刷新',
  'header.updated': '更新于 {time}',
  'state.loading': '正在加载信箱…',
  'state.empty': '信箱为空',
  'state.loadFailed': '信箱加载失败',
  'box.live': '{count} 个授权会话在线',
  'box.messages': '{count} 条消息',
  'box.pending': '{count} 条未读',
  'msg.pending': '未读',
  'field.replyTo': '回执于',
  'field.expect': '期望',
  'field.to': '收件会话',
  'field.fromSession': '发件会话',
} as const

/** The mailbox dictionary key union. */
export type MailboxKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The mailbox tab surface copy. */
    'session-mail': MailboxKey
  }
}

/** English dictionary, checked complete against the Chinese source of truth. */
export const en: Record<MailboxKey, string> = {
  'view.mailbox': 'Mailbox',
  'header.refresh': 'Refresh',
  'header.refreshAria': 'Refresh mailbox',
  'header.auto': 'Auto refresh',
  'header.updated': 'Updated {time}',
  'state.loading': 'Loading mailbox…',
  'state.empty': 'The mailbox is empty',
  'state.loadFailed': 'Failed to load the mailbox',
  'box.live': '{count} authorized session(s) live',
  'box.messages': '{count} message(s)',
  'box.pending': '{count} unread',
  'msg.pending': 'Unread',
  'field.replyTo': 'reply-to',
  'field.expect': 'expect',
  'field.to': 'to session',
  'field.fromSession': 'sender session',
}
