/**
 * dsh-session-mail — cross-session mailbox plugin.
 *
 * Attaches two model tools (`mail_send`, `mail_drain`) to every ROOT agent
 * whose session workspace (`session.header.cwd`) matches a configured
 * identity, and watches each identity's inbox JSONL so new messages reach
 * their target session: a wakeup turn on an idle agent, a next-step injection
 * on a running one. A delivered message lands in the target session's durable
 * inbox (`agent/inbox/spliced`), so it survives restarts.
 *
 * One maildir may be shared by several dsh processes, so the delivery state
 * lives in the maildir instead of process memory:
 *
 * - every live endpoint publishes a heartbeat record (`.presence/<sessionId>.json`),
 *   which gives all processes the same view of who is live and in which process;
 * - every message is claimed before delivery (`.claims/<role>/<msgId>.json`)
 *   through an exclusive-create file, so exactly one process delivers it; a
 *   claim whose owner died is taken over instead of stranding the message;
 * - a line whose addressee is offline is skipped, never held, so later lines
 *   for live sessions do not wait behind it.
 *
 * Addressing (v2): every message is stamped with the sender's session id
 * (`from_session`) and may name its addressee (`to_session`). A reply
 * (`reply_to`) is routed mechanically to the original sender's session. A
 * fresh send goes to the role's only live session; with several live sessions
 * it fails loud listing the candidates (the model asks the owner via
 * ask_user_question — the first candidate is the recommended default — or sets
 * `to_session`), so a message is always processed by exactly one session and
 * never silently delivered to a stranger. A message whose addressee is live in
 * another dsh process is appended and reported as `relay`: that process's
 * watcher delivers it within one poll interval. Envelopes written before
 * `to_session` existed carry no addressee; the role's earliest live session
 * owns those, ordered deterministically so every process picks the same owner.
 *
 * Session-ID addressing (v0.5.0): `to_session` is a general route — ANY root
 * session (including forks and sessions whose cwd has no configured identity)
 * may send to any other session by id, and every root session gets both tools.
 * A `to_session` send never touches a role inbox: the message lands in the
 * addressee's direct staging pool (`direct/<sessionId>.jsonl`), and delivery
 * goes to the live session directly (`push`, this process), through its
 * hosting process's direct-pool watcher (`relay`), or stays staged until the
 * addressee session next exists (`mailbox`). Draining is session-filtered: a
 * session that is not the rostered owner of its cwd's role inbox sees only its
 * direct pool (point-to-point mail), never the role broadcast. Role-inbox
 * behavior for the four configured identities is unchanged.
 *
 * The file format is the directional JSONL mailbox of
 * `.session-mailbox/PROTOCOL.md` (`to-main.jsonl` / `to-split.jsonl`); this
 * plugin is the native mechanism for that protocol, replacing the pwsh
 * wake-watcher plus drain discipline.
 * @module dsh-session-mail
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  DIRECT_CLAIM_ROLE, appendDirect, appendLedgerRecord, appendMessage, directPath, localTimestamp,
  markMessageConsumed, markMessageDelivered, markMessageFailed, nextMessageId, normalizePath, parseMessage,
  presenceIsLive, readClaim, readCursor, readInboxLines, readOwnerRoster, readPresences, readWakeRequests,
  removePresence, reopenClaim, rewriteDirect, sleep, sweepLedger, sweepMailboxState, tryClaimMessage,
  writeCursor, writePresence, writeWakeRequests,
} from './mailbox.mjs'
import { createSession, createWorkspace, joinSessionGroup } from './session-tools.mjs'

export const name = 'session-mail'

export const inject = ['agents', 'systemPrompt', 'tools']

/**
 * Producer-owned source kind for every synthetic message this plugin appends.
 * Session format v4 refuses the retired `{ kind: 'plugin' }` wrapper at native
 * admission ("format v4 message requires a producer-owned source kind"), and its
 * V3-to-V4 migration resolves a plugin identity through `producerKind()`: renamed
 * producers are mapped, the released same-name set keeps its name, and every
 * other plugin becomes `plugin:<name>` with its `plugin` field dropped. This
 * plugin is in neither table, so `plugin:session-mail` is the identity the
 * platform already records for its historical messages -- emitting a bare name
 * would split one producer into two identities inside a single log. The `plugin`
 * field stays alongside it for v3 hosts and readers that still key on it, and v4
 * admission preserves unknown attribution as it found it.
 */
const SOURCE_KIND = `plugin:${name}`

/** Build the source of one of this plugin's own messages: v4-admissible, v3-readable. */
function ownSource(fields) {
  return { ...fields, kind: SOURCE_KIND, plugin: name }
}

/** Whether an inbox insertion is this plugin's own notice, in either source shape. */
function isOwnSource(source) {
  return (source?.kind === 'plugin' && source.plugin === name) || source?.kind === SOURCE_KIND
}

export const Config = z.object({
  /** Directory holding the directional JSONL mailbox files plus the presence and claim state. */
  maildir: z.string(),
  /** One entry per mailbox endpoint; `inbox` names the file this role READS. */
  identities: z.array(z.object({
    role: z.string(),
    name: z.string(),
    cwd: z.string(),
    inbox: z.string(),
  })),
  /** Inbox poll interval in milliseconds. */
  pollMs: z.number().min(100).default(800),
  /** Debounce window that absorbs rapid-fire sends into one delivery batch. */
  batchWindowMs: z.number().min(0).default(1500),
  /** `wakeup` opens a turn on an idle target; `quiet` only injects. */
  delivery: z.union(['wakeup', 'quiet']).default('wakeup'),
  /** Turns one target may have opened by mailbox wakes before the next notice degrades to injection, reset by user input. */
  maxConsecutiveWakes: z.number().min(1).default(3),
  /**
   * Redeliveries allowed for one mailbox wake whose turn failed with a retryable
   * provider error before the model answered. `0` disables redelivery entirely.
   */
  maxRedeliveries: z.number().min(0).default(1),
  /**
   * How long one mailbox wake may stay undecided before it settles as failed.
   * Redelivery itself waits for the agent's next idle transition, so this is the
   * backstop for a session that never reaches one again (stuck turn, disposed
   * agent): without it the claim would read `delivered` forever and the sender
   * would never learn that no model answered.
   */
  wakeWindowMs: z.number().min(1000).default(600_000),
  /**
   * How many times that window may be extended while the target is still running
   * the wake turn. A long multi-step turn may legitimately outlast one window, so
   * a slow turn is never reported as dead; the cap bounds how long a turn that
   * never answers may hold its sender in the dark.
   */
  wakeWindowExtensions: z.number().min(0).default(3),
  /**
   * Bytes one ledger day file may reach before it stops with a `ledger-capped`
   * marker; `0` removes the cap. The ledger lives in the maildir beside the
   * claims because a host may mount no log sink at all.
   */
  ledgerMaxBytesPerDay: z.number().min(0).default(8 * 1024 * 1024),
  /** Days a ledger day file stays active before a sweep archives it. */
  ledgerRetentionDays: z.number().min(1).default(30),
  /**
   * Whether a session's goal that is still `active` but no longer `armed` sends one
   * `goal-disarmed` notice to that role's designated owner, so an owner who is away
   * learns automatic continuation stopped — on the activation edge itself, and in
   * the mount scan that catches the state a restart leaves behind.
   */
  goalDisarmNotice: z.boolean().default(true),
  /** Whether the first observation of an inbox delivers its whole pre-existing content. */
  catchUpOnStart: z.boolean().default(false),
  /**
   * Whether the `session_create` and `workspace_create` tools are attached to root
   * sessions. Both are one switch: creating a Session outside this repository is
   * only reachable through a registered Workspace, so registering one without the
   * other has no use.
   */
  createTool: z.boolean().default(true),
  /**
   * Whether a `to_session` send to an offline addressee revives it in this
   * process (acquiring the Session's write handle) before delivering, so a
   * dispatch does not wait for someone to open the target by hand.
   */
  activateOnSend: z.boolean().default(true),
  /** Interval at which this process republishes the presence record of every session it hosts. */
  presenceHeartbeatMs: z.number().min(200).default(2000),
  /** Age after which a presence record without a fresh heartbeat stops counting as a live session. */
  presenceTtlMs: z.number().min(1000).default(8000),
  /** Age after which a claim held by a live process may be taken over by another process. */
  claimTtlMs: z.number().min(1000).default(300_000),
  /** Age after which a delivered claim record may be deleted. */
  claimRetentionMs: z.number().min(60_000).default(30 * 24 * 60 * 60 * 1000),
  /** Interval between sweeps of dead presence records, expired claims, and abandoned locks. */
  sweepIntervalMs: z.number().min(5000).default(60_000),
})

/** Same-origin route serving the read-only mailbox snapshot to the Web tab. */
const MAILBOX_UI_ROUTE = '/session-mail/mailbox'

/** Wake requests older than this are dropped instead of delivered stale. */
const WAKE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Provider failure codes whose mailbox wake may be redelivered once: the
 * transient set `dsh-llm` already declares retryable. A quota, credential, or
 * context failure is terminal, so redelivering it would only repeat the wall —
 * that case reports the failure to the sender instead.
 */
const REDELIVERABLE_FAILURE_CODES = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'])

/** Claim states that settle a message: no further delivery attempt applies. */
const TERMINAL_CLAIM_STATES = new Set(['delivered', 'consumed', 'failed'])

/** Topic of the receipt one delivered-but-unconsumed message sends back to its sender. */
const DELIVERY_FAILED_TOPIC = 'delivery-failed'

/** Topic of the notice one still-active goal that came back disarmed sends to its role owner. */
const GOAL_DISARMED_TOPIC = 'goal-disarmed'

/**
 * Distinct ledger records one process keeps before clearing its duplicate guard.
 * The guard only suppresses a repeat of the exact same decision, so a cleared
 * guard can at worst re-record one old duplicate.
 */
const NOTED_RECORDS_LIMIT = 5000

/** Goal-disarm notices one scan may send before it summarizes the rest. */
const GOAL_DISARM_NOTICE_LIMIT = 10

/** Delay before the mount scan retries when the goal service is not up yet. */
const GOAL_DISARM_SCAN_RETRY_MS = 5000

/** The only `to_session` form that can name a session: a full lowercase session UUID. */
const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** System-prompt section text attached beside the mailbox tools. */
const SECTION_TEXT = 'Cross-session mailbox attached: mail_send delivers an operational signal to a peer session; '
  + 'mail_drain lists messages addressed to this session (backlog: true recovers pre-existing mail). Replies are '
  + 'routed automatically: set reply_to and the plugin delivers to the original sender\'s session. Address a peer '
  + 'by role (to) or by exact session id (to_session) — any session may be addressed by id, no mailbox identity '
  + 'needed. If mail_send reports several live peer sessions, ask the owner with ask_user_question (the first '
  + 'listed candidate is the recommended default, owner may re-select) or retry with to_session. A message whose '
  + 'addressee is live in another dsh process is relayed by that process\'s watcher. Keep body to anchors (commit '
  + 'hash, doc path, version), never bulk content. New messages arrive pushed; after handling one, acknowledge '
  + 'with mail_send and reply_to. A delivery that reports woke: false reached the peer\'s inbox without opening '
  + 'a turn — an idle peer then stays idle until other input reaches it; a message whose wakeup turn fails '
  + 'before the model answers returns as a delivery-failed receipt. Before sending several messages to the same '
  + 'idle peer, read mail_budget: a wakeup turn happens only while that peer\'s wake budget lasts, and past the '
  + 'limit the message is injected into an idle peer without opening one. The mailbox is a signal channel only — '
  + 'authoritative records stay in commits and documents.'

/**
 * System-prompt section text attached beside the session-creation tools.
 *
 * The sidebar half of this text describes the liveness plugin's observations
 * rather than this plugin's own contributions, because a Session that is told
 * `session_create` exists must also know why a freshly created Session may not
 * appear yet and how a cold one is revived.
 */
const SESSION_CREATE_SECTION_TEXT = 'Session creation attached: session_create materializes a peer Session in this '
  + 'repository (a task-semantic title is required) and returns its id; dispatch work to it with mail_send addressed '
  + 'by to_session, never by role. The new Session joins this Session\'s workspace, so the sidebar lists it under the '
  + 'same workspace instead of Ungrouped; pass a groupId only to join a chat group. A directory outside this '
  + 'repository is accepted only when a registered Workspace owns it, so run workspace_create on that directory '
  + 'first (idempotent: an already-registered directory is resolved, not duplicated). A Session that is alive, '
  + 'remote, or cold is a fact about which process holds it, and a cold Session is activated automatically when '
  + 'mail reaches it.'

/**
 * Render one message as the model-visible delivery frame.
 * @param msg - parsed mailbox message.
 * @returns multi-line text carrying id, sender, topic, body, and optional routing fields.
 */
function frameMessage(msg) {
  const head = `Mailbox ${msg.id} from ${msg.from ?? 'unknown'} [${msg.topic}]`
  const tail = []
  const replyTo = typeof msg.reply_to === 'string' && msg.reply_to.length > 0 ? msg.reply_to : msg['reply-to']
  if (typeof replyTo === 'string' && replyTo.length > 0) tail.push(`reply-to: ${replyTo}`)
  if (typeof msg.expect === 'string' && msg.expect.length > 0) tail.push(`expect: ${msg.expect}`)
  const body = tail.length > 0 ? `${msg.body}\n(${tail.join('; ')})` : msg.body
  return `${head}\n${body}`
}

/**
 * Reject two identities sharing a role, workspace, or inbox file — either
 * collision makes delivery state ambiguous.
 * @param identities - normalized identity list.
 */
function assertUnique(identities) {
  for (const key of ['role', 'cwdKey', 'inbox']) {
    const seen = new Set()
    for (const identity of identities) {
      if (seen.has(identity[key])) {
        throw new Error(`session-mail: duplicate identity ${key} ${JSON.stringify(identity[key])}`)
      }
      seen.add(identity[key])
    }
  }
}

/** Shorten a session id for compact display; errors always carry the full id too. */
function shortId(id) {
  return typeof id === 'string' && id.length > 12 ? `${id.slice(0, 12)}…` : String(id)
}

/**
 * The stable failure class of one `agent/error` payload. The loop reports the
 * thrown value: provider failures arrive as an `LlmError` carrying `failure.code`,
 * and anything else at most carries a `HarnessError` code. A value without one is
 * `UNKNOWN`, which never qualifies for redelivery.
 * @param error - the thrown value reported by `agent/error`.
 * @returns the machine-routable failure code.
 */
function failureCodeOf(error) {
  const code = error?.failure?.code ?? error?.code
  return typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN'
}

/**
 * Order two live sessions for ownership of an addressee-less envelope: earliest
 * attached first, session id breaking ties. Every process computes the same
 * order, so exactly one of them treats such a line as its own.
 * @param a - one live-session view entry.
 * @param b - another live-session view entry.
 * @returns a negative, zero, or positive comparison result.
 */
function byAttachOrder(a, b) {
  const delta = (a.attachedAt ?? 0) - (b.attachedAt ?? 0)
  return delta !== 0 ? delta : String(a.sessionId).localeCompare(String(b.sessionId))
}

/**
 * @param ctx - host Cordis context.
 * @param config - validated {@link Config} value.
 */
export function apply(ctx, config) {
  if (config.identities.length === 0) {
    throw new Error('session-mail: config.identities is empty — list one entry per mailbox endpoint')
  }
  const identities = config.identities.map(identity => ({ ...identity, cwdKey: normalizePath(identity.cwd) }))
  assertUnique(identities)

  const byCwd = new Map(identities.map(identity => [identity.cwdKey, identity]))
  const byRole = new Map(identities.map(identity => [identity.role, identity]))
  /** This process's identity in the shared presence and claim records. */
  const self = { pid: process.pid, boot: randomUUID().slice(0, 8) }
  /** role → resolved-prefix watermark; mirrors and is seeded by the persisted cursor file. */
  const cursors = new Map()
  /** Roles whose first observation in this process has already been handled. */
  const observed = new Set()
  /** Agent → turns opened by mailbox wakes since that agent last consumed user input. */
  const wakeSpent = new WeakMap()
  /**
   * Agent → the mailbox wake whose model consumption is still unproven: the
   * message, its claim route, redeliveries spent, and the turn that claimed it.
   * At most one entry exists per agent, because a wake only happens while idle.
   */
  const pendingWake = new WeakMap()
  const attached = new WeakSet()
  /** Agent → attach time in this boot; orders ambiguity candidates by recency of open. */
  const attachedAt = new WeakMap()
  const polling = new Set()
  const targetRoles = identities.map(identity => identity.role).join(', ')

  const identityOf = (agent) => {
    const cwd = agent?.session?.header?.cwd
    return cwd === undefined ? undefined : byCwd.get(normalizePath(cwd))
  }

  /** Log one warning; a torn-down host context must never turn logging into a failure. */
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // Host context inactive during unload; teardown noise must not escape.
    }
  }

  /**
   * Serialized ledger appends: one chain, so two settlements in the same tick
   * cannot interleave their lines inside one day file.
   */
  let ledgerAppends = Promise.resolve()

  /**
   * Goal-disarm notices already sent, keyed `goalId|revision|sessionId`, so an edge
   * and the mount scan cannot both announce the same disarm.
   */
  const notifiedGoalDisarms = new Set()
  /** Monotonic scan counter, which keeps every scan trace distinct in the ledger. */
  let goalScanCount = 0

  /**
   * Ledger records already written by this process, so a repeated decision cannot
   * duplicate a line. Bounded: at the cap the set is cleared, which can only let
   * an old duplicate through once.
   */
  const notedRecords = new Set()

  /**
   * Record one delivery or settlement decision as a single structured line, so a
   * delivery that reached nobody is visible without reading the maildir by hand.
   * It goes to the lowest informational level the host offers and never to
   * `warn`: the claim record is the authority, and a warning must keep meaning
   * "something needs attention". Records carry ids and states only — never the
   * message body, which belongs to the mailbox and not to a log.
   * @param event - short event name, e.g. `delivery` or `settlement`.
   * @param fields - the facts to record verbatim.
   */
  const note = (event, fields) => {
    const key = `${event}|${JSON.stringify(fields)}`
    if (notedRecords.has(key)) return
    if (notedRecords.size >= NOTED_RECORDS_LIMIT) notedRecords.clear()
    notedRecords.add(key)
    try {
      const logger = ctx.logger
      const line = `session-mail: ${event} ${JSON.stringify(fields)}`
      if (typeof logger?.info === 'function') logger.info(line)
      else if (typeof logger?.debug === 'function') logger.debug(line)
    } catch {
      // Same teardown window as warn: a diagnostic never fails a delivery.
    }
    // The ledger file is the authoritative place an operator can read: this host
    // may mount no log exporter, in which case `ctx.logger` reaches nothing.
    ledgerAppends = ledgerAppends
      .then(() => appendLedgerRecord(config.maildir, { event, ...fields }, {
        maxBytesPerDay: config.ledgerMaxBytesPerDay,
      }))
      .then((result) => {
        if (result === 'failed') warn(`session-mail: appending the ${event} ledger record for ${fields.msg ?? '?'} failed`)
      })
      .catch(() => {
        // appendLedgerRecord already contains its own failures; this only keeps
        // the serialized chain alive for the next record.
      })
  }

  /**
   * The `owner.json` roster as a session-id list for one role (PROTOCOL.md §3.6).
   * @param roster - parsed roster, or `undefined` when absent or malformed.
   * @param role - identity role name.
   * @returns the allowed session ids, or `undefined` when the roster does not restrict this role.
   */
  function rosterListFor(roster, role) {
    const entry = roster?.[role]
    const list = Array.isArray(entry) ? entry : entry === undefined ? undefined : [entry]
    return list !== undefined && list.length > 0 ? list : undefined
  }

  /**
   * The roster's designated owner of one role's inbox (`owner.json`
   * `roleOwners[role]`), when the roster names one.
   * @param roster - parsed roster, or `undefined` when absent or malformed.
   * @param role - identity role name.
   * @returns the session id role mail should reach, or `undefined` when unnamed.
   */
  function roleOwnerFor(roster, role) {
    const owner = roster?.roleOwners?.[role]
    return typeof owner === 'string' && owner.length > 0 ? owner : undefined
  }

  /**
   * Root agents of one role that this process hosts and may deliver to.
   * @param identity - identity whose sessions are listed.
   * @param rosterList - allowed session ids, or `undefined` when unrestricted.
   * @returns the local delivery targets.
   */
  function localRoots(identity, rosterList) {
    let roots
    try {
      roots = ctx.agents.roots()
    } catch {
      // Teardown window: the poll interval can fire while the host context
      // is already inactive; no live targets exist then, so poll no-ops.
      return []
    }
    return roots.filter(agent => identityOf(agent)?.role === identity.role
      && (rosterList === undefined || rosterList.includes(agent.id)))
  }

  /**
   * Every root agent this process hosts, identity or not — the population that
   * gets the mailbox tools, a presence record, and a direct-pool watcher.
   * @returns the hosted root agents; empty across a teardown window.
   */
  function allRoots() {
    try {
      return ctx.agents.roots()
    } catch {
      // Same teardown window as localRoots.
      return []
    }
  }

  /**
   * Describe one hosted session as a view entry.
   * @param agent - live root agent hosted by this process.
   * @param identity - identity matched for that agent.
   * @returns the view entry, carrying the agent because only this process can deliver to it.
   */
  function localEntry(agent, identity) {
    return {
      sessionId: agent.id,
      role: identity.role,
      cwd: agent?.session?.header?.cwd,
      status: agent.status,
      attachedAt: attachedAt.get(agent) ?? 0,
      pid: self.pid,
      boot: self.boot,
      local: true,
      agent,
    }
  }

  /**
   * Every live session of one role across all dsh processes sharing this
   * maildir: the sessions this process hosts plus the ones whose heartbeat
   * records are still fresh.
   * @param identity - identity whose live sessions are listed.
   * @param rosterList - allowed session ids, or `undefined` when unrestricted.
   * @returns view entries; hosted sessions first, each carrying `local`.
   */
  async function viewOfRole(identity, rosterList) {
    const entries = localRoots(identity, rosterList).map(agent => localEntry(agent, identity))
    const known = new Set(entries.map(entry => entry.sessionId))
    for (const record of await readPresences(config.maildir)) {
      if (record.role !== identity.role) continue
      if (known.has(record.sessionId)) continue
      if (rosterList !== undefined && !rosterList.includes(record.sessionId)) continue
      if (!presenceIsLive(record, { presenceTtlMs: config.presenceTtlMs })) continue
      entries.push({ ...record, local: false })
    }
    return entries
  }

  /**
   * Resolve one inbox line's owning session among the live view.
   * @param msg - parsed mailbox message.
   * @param view - live-session view of the role.
   * @param designatedOwner - the roster's designated owner of this role, when named.
   * @returns the owning entry, or `undefined` when the addressee is offline or nobody is live.
   */
  function ownerOf(msg, view, designatedOwner) {
    if (typeof msg.to_session === 'string' && msg.to_session.length > 0) {
      return view.find(entry => entry.sessionId === msg.to_session)
    }
    // A named owner takes role mail whenever it is live. Without one, the
    // earliest attached live session owns the broadcast — which routed
    // coordination mail to whichever same-identity session happened to attach
    // first (2026-09-23: framework letters landed in the executor's pool while
    // the coordinating session sat in the same process).
    if (designatedOwner !== undefined) {
      const designated = view.find(entry => entry.sessionId === designatedOwner)
      if (designated !== undefined) return designated
    }
    return [...view].sort(byAttachOrder)[0]
  }

  /**
   * Publish this process's presence records and retire its own stale ones.
   * Records of other processes are left to their heartbeat loop and the sweep.
   */
  async function publishPresence() {
    const roster = await readOwnerRoster(config.maildir)
    const live = new Set()
    for (const identity of identities) {
      for (const agent of localRoots(identity, rosterListFor(roster, identity.role))) {
        live.add(agent.id)
        await writePresence(config.maildir, {
          sessionId: agent.id,
          role: identity.role,
          cwd: agent?.session?.header?.cwd,
          status: agent.status,
          attachedAt: attachedAt.get(agent) ?? Date.now(),
          pid: self.pid,
          boot: self.boot,
        })
      }
    }
    // Sessions whose cwd has no configured identity (new-repo mains, forks in
    // foreign workspaces) publish too: session-ID addressing resolves its
    // targets through presence, so they must be discoverable cross-process.
    for (const agent of allRoots()) {
      if (live.has(agent.id)) continue
      live.add(agent.id)
      await writePresence(config.maildir, {
        sessionId: agent.id,
        role: identityOf(agent)?.role,
        cwd: agent?.session?.header?.cwd,
        status: agent.status,
        attachedAt: attachedAt.get(agent) ?? Date.now(),
        pid: self.pid,
        boot: self.boot,
      })
    }
    for (const record of await readPresences(config.maildir)) {
      if (record.pid === self.pid && record.boot === self.boot && !live.has(record.sessionId)) {
        await removePresence(config.maildir, record.sessionId)
      }
    }
  }

  /**
   * Read the resolved-prefix watermark from memory and from the persisted file,
   * which an older plugin version sharing this maildir also advances. A file
   * shorter than the watermark means the inbox was archived per protocol §4, so
   * every current line is post-rotation and new.
   * @param identity - identity whose inbox is read.
   * @param lines - current inbox lines.
   * @returns the number of leading resolved lines.
   */
  async function currentWatermark(identity, lines) {
    const persisted = await readCursor(config.maildir, identity.role)
    const merged = Math.max(persisted ?? 0, cursors.get(identity.role) ?? 0)
    return merged > lines.length ? 0 : merged
  }

  /**
   * Recompute and persist the resolved-prefix watermark: every line before it
   * reached its addressee, or is unparseable. Older plugin versions read this
   * file as their consumed cursor, so keeping it current is what lets a 0.3.0
   * and a 0.4.0 process share one mailbox without replaying each other's work.
   * @param identity - identity whose inbox is read.
   * @param lines - current inbox lines.
   */
  async function refreshWatermark(identity, lines) {
    let resolved = Math.min(await currentWatermark(identity, lines), lines.length)
    while (resolved < lines.length) {
      const msg = parseMessage(lines[resolved])
      if (msg !== undefined) {
        const claim = await readClaim(config.maildir, identity.role, msg.id)
        if (claim === undefined || !TERMINAL_CLAIM_STATES.has(claim.state)) break
      }
      resolved++
    }
    if (cursors.get(identity.role) === resolved) return
    cursors.set(identity.role, resolved)
    await writeCursor(config.maildir, identity.role, resolved)
  }

  /**
   * The mailbox wake budget of one target, as a model-facing reading.
   * @param agent - exact live target agent.
   * @returns the turns this mailbox has opened on that target since it last took
   *   non-mailbox input, the configured limit, and the refill condition.
   */
  function wakeBudgetReading(agent) {
    return {
      spent: wakeSpent.get(agent) ?? 0,
      limit: config.maxConsecutiveWakes,
      refillsOn: 'non-mailbox-input',
    }
  }

  /**
   * Deliver one message to a live agent: wakeup turn within budget, else injection.
   * @param agent - exact live target agent.
   * @param msg - parsed mailbox message.
   * @param route - claim role and destination the message arrived through, kept
   *   so a failed wake can reopen its own claim and redeliver.
   * @param attempts - redeliveries already spent on this message.
   * @returns how the message reached the agent: `woke` reports whether a turn was
   *   opened, `mode` names the mechanism, `reason` explains why an idle target
   *   received an injection instead of a wakeup turn, and `wakeBudget` reads the
   *   target's budget after this decision.
   */
  function deliver(agent, msg, route, attempts = 0) {
    const message = createUserMessage({
      content: [{ type: 'text', text: frameMessage(msg) }],
      source: ownSource({
        form: 'notice',
        summary: `[${msg.topic}] from ${msg.from ?? 'unknown'}`,
      }),
    })
    if (config.delivery === 'wakeup' && agent.status === 'idle'
      && (wakeSpent.get(agent) ?? 0) < config.maxConsecutiveWakes) {
      wakeSpent.set(agent, (wakeSpent.get(agent) ?? 0) + 1)
      // Registered before the wake: a turn that fails synchronously enough to
      // report back in the same tick must still find its pending entry.
      if (msg.receipt !== true) {
        armWakeWindow(agent, { msg, route, attempts, deliveryId: message.id, turn: undefined })
      }
      agent.followup(message)
      return { woke: true, mode: 'wakeup', wakeBudget: wakeBudgetReading(agent) }
    }
    agent.inject(message)
    // Injection is consumed at the target's next step boundary, so it reaches a
    // running turn but leaves an idle one idle: the sender must not read that as
    // a wake, and this process must not report one either.
    if (agent.status !== 'idle') {
      return { woke: false, mode: 'inject', reason: 'target-running', wakeBudget: wakeBudgetReading(agent) }
    }
    const budgetSpent = config.delivery === 'wakeup'
    const reason = budgetSpent ? 'wake-budget-exhausted' : 'delivery-quiet'
    warn(`session-mail: ${msg.id} injected into idle session ${shortId(agent.id)}; it will not open a turn`
      + ` (${budgetSpent ? 'wake budget exhausted' : 'delivery is quiet'})`)
    return { woke: false, mode: 'inject', reason, wakeBudget: wakeBudgetReading(agent) }
  }

  /**
   * Register one wake as pending and start its settlement window. The window is
   * the backstop for a wake that never reaches a decided state — no committed
   * model response, no agent error, no return to idle — because only a decision
   * can settle the claim and tell the sender.
   * @param agent - the woken session.
   * @param entry - the pending wake record, without a window yet.
   * @returns the registered entry.
   */
  function armWakeWindow(agent, entry) {
    const armed = { ...entry, window: undefined }
    armed.window = setTimeout(() => {
      if (pendingWake.get(agent) !== armed) return
      const expired = armed.armed === true ? 'redelivery-window-expired' : 'consumption-window-expired'
      const extensions = armed.extensions ?? 0
      // A turn that is still running may legitimately outlast one window, so a
      // slow turn is extended instead of reported as dead — until the cap, where
      // the sender has to hear that the peer is running and still not answering.
      if (agent.status === 'running' && extensions < config.wakeWindowExtensions) {
        armWakeWindow(agent, { ...armed, extensions: extensions + 1, window: undefined })
        warn(`session-mail: wake ${armed.msg.id} on ${shortId(agent.id)} is still running;`
          + ` settlement window extended (${extensions + 1} of ${config.wakeWindowExtensions})`)
        return
      }
      const reason = agent.status === 'running' ? `${expired}-while-running` : expired
      settleWake(agent, 'failed', reason).catch((error) => {
        warn(`session-mail: settling expired wake ${armed.msg.id} failed: ${error?.message ?? error}`)
      })
    }, config.wakeWindowMs)
    armed.window.unref?.()
    pendingWake.set(agent, armed)
    return armed
  }

  /**
   * Drop one pending wake and cancel its settlement window.
   * @param agent - the woken session.
   * @param entry - the pending entry being settled.
   */
  function releaseWake(agent, entry) {
    if (entry.window !== undefined) clearTimeout(entry.window)
    if (pendingWake.get(agent) === entry) pendingWake.delete(agent)
  }

  /**
   * Settle one mailbox wake whose model consumption is now decided: record the
   * terminal claim state, redeliver a retryable failure once, and report an
   * unconsumed message back to its sender.
   * @param agent - the session the wake belongs to.
   * @param verdict - `consumed`, or the failure that ended the wake.
   * @param detail - provider failure code or short reason for the record.
   */
  async function settleWake(agent, verdict, detail) {
    const entry = pendingWake.get(agent)
    if (entry === undefined) return
    releaseWake(agent, entry)
    const { msg, route, attempts } = entry
    if (verdict === 'consumed') {
      await markMessageConsumed(config.maildir, {
        role: route.claimRole, msgId: msg.id, sessionId: agent.id, owner: self,
      })
      note('settlement', {
        msg: msg.id, to: agent.id, route: route.claimRole, claimState: 'consumed', attempts, turn: entry.turn,
      })
      return
    }
    if (attempts < config.maxRedeliveries && REDELIVERABLE_FAILURE_CODES.has(detail)) {
      // Redelivery must not inject into the failed turn that is still running, so
      // it is armed here and handed over the agent's next idle transition. A
      // transient provider failure already spent the retry policy's own backoff
      // inside that turn, so no second delay is added here.
      const armed = { ...entry, armed: true }
      pendingWake.set(agent, armed)
      warn(`session-mail: wake ${msg.id} on ${shortId(agent.id)} failed (${detail});`
        + ` redelivery ${attempts + 1} of ${config.maxRedeliveries} armed for its next idle`)
      note('redelivery-armed', {
        msg: msg.id, to: agent.id, route: route.claimRole, claimState: 'delivered',
        reason: detail, attempts: attempts + 1, turn: entry.turn,
      })
      if (agent.status === 'idle') {
        await redeliver(agent, armed).catch((error) => {
          warn(`session-mail: redelivering ${msg.id} failed: ${error?.message ?? error}`)
        })
      }
      return
    }
    await markMessageFailed(config.maildir, {
      role: route.claimRole, msgId: msg.id, sessionId: agent.id, owner: self, reason: detail,
    })
    warn(`session-mail: wake ${msg.id} on ${shortId(agent.id)} ended ${verdict}: ${detail};`
      + ` the message stays in the session history but no model request answered it`)
    note('settlement', {
      msg: msg.id, to: agent.id, route: route.claimRole, claimState: 'failed', reason: detail, attempts, turn: entry.turn,
    })
    // An aborted or blocked turn is under someone else's control, so it earns a
    // record but not a receipt; a provider failure is the sender's business.
    if (verdict === 'failed') await notifySender(agent, msg, detail)
  }

  /**
   * Redeliver one armed wake now that its agent is idle: reopen this process's
   * own settled claim and hand the same message over again.
   * @param agent - the session the wake belongs to.
   * @param entry - the armed pending entry.
   */
  async function redeliver(agent, entry) {
    if (pendingWake.get(agent) !== entry) return
    releaseWake(agent, entry)
    const { msg, route, attempts } = entry
    const reopened = await reopenClaim(config.maildir, {
      role: route.claimRole, msgId: msg.id, sessionId: agent.id, owner: self,
    })
    if (!reopened) return
    try {
      deliver(agent, msg, route, attempts + 1)
    } catch (error) {
      warn(`session-mail: redelivering ${msg.id} to ${shortId(agent.id)} failed: ${error?.message ?? error}`)
      return
    }
    await markMessageDelivered(config.maildir, {
      role: route.claimRole, msgId: msg.id, sessionId: agent.id, owner: self,
    })
  }

  /**
   * Append one delivery-failure receipt to the sending session's direct pool, so
   * a sender whose message never reached a model learns it without polling. The
   * receipt carries `receipt: true` and therefore never starts its own wake
   * tracking, which keeps two failing sessions from trading receipts.
   * @param agent - the session whose wake failed.
   * @param msg - the unconsumed message.
   * @param detail - why the wake settled without consumption.
   */
  async function notifySender(agent, msg, detail) {
    const sender = typeof msg.from_session === 'string' && msg.from_session.length > 0 ? msg.from_session : undefined
    if (sender === undefined) return
    await deliverNotice(sender, {
      id: nextMessageId(),
      ts: localTimestamp(),
      from: 'session-mail',
      from_session: agent.id,
      topic: DELIVERY_FAILED_TOPIC,
      body: `mail ${msg.id} (topic ${msg.topic}) reached ${shortId(agent.id)} but its wakeup turn failed before a `
        + `model request answered it: ${detail}. The message stays in that session's history, so resend when the `
        + 'failure clears or handle it there.',
      to_session: sender,
      receipt: true,
    })
  }

  /**
   * Hand one plugin notice to a session by id: stage it in that session's direct
   * pool, then deliver it here when this process hosts the session. The message is
   * an ordinary mailbox envelope, so the existing delivery chain, wake budget, and
   * accounting all apply unchanged.
   * @param targetSessionId - addressee session id.
   * @param message - complete mailbox envelope.
   */
  async function deliverNotice(targetSessionId, message) {
    await appendDirect(config.maildir, targetSessionId, message)
    const local = allRoots().find(candidate => candidate.id === targetSessionId)
    if (local !== undefined) await deliverDirectClaimed(local, message)
  }

  /**
   * Send one `goal-disarmed` notice for a goal that is still active while its
   * process-local continuation is not. The notice goes to the goal role's
   * designated owner; when that owner is the affected session itself, it is skipped
   * because the session's own goal bar already shows it, and waking it would only
   * spend its own wake budget.
   * @param sessionId - the session whose goal came back disarmed.
   * @param goalRef - goal identity and revision from the activation change.
   * @returns the disposition, for the scan trace.
   */
  async function notifyGoalDisarmed(sessionId, goalRef) {
    const dedupKey = `${goalRef.id}|${goalRef.revision}|${sessionId}`
    if (notifiedGoalDisarms.has(dedupKey)) return 'duplicate'
    const agent = ctx.agents.get?.(sessionId)
    if (agent === undefined) return 'skipped-no-agent'
    const view = ctx.get('goals')?.get?.(agent)
    if (view === undefined || view.phase !== 'active' || view.activation !== 'disarmed') return 'skipped-inactive'
    const identity = identityOf(agent)
    if (identity === undefined) return 'skipped-no-identity'
    const owner = roleOwnerFor(await readOwnerRoster(config.maildir), identity.role)
    if (owner === undefined) return 'skipped-no-owner'
    if (owner === sessionId) return 'skipped-recipient-is-self'
    if (notifiedGoalDisarms.size >= NOTED_RECORDS_LIMIT) notifiedGoalDisarms.clear()
    notifiedGoalDisarms.add(dedupKey)
    await deliverNotice(owner, {
      id: nextMessageId(),
      ts: localTimestamp(),
      from: identity.name,
      from_session: sessionId,
      topic: GOAL_DISARMED_TOPIC,
      body: `goal ${view.id} (revision ${view.revision}) of session ${shortId(sessionId)} is ${view.phase} while its `
        + `automatic continuation is ${view.activation}: rounds started ${view.roundsStarted} of `
        + `${view.maxGoalRounds ?? 'an unbounded cap'}. 在该会话里说“继续”即可恢复自动续跑。`,
      to_session: owner,
      expect: 'resume that session\'s goal, or ignore when it should stay stopped',
    })
    return 'sent'
  }

  /**
   * Scan every session this process hosts for one that is `active` but no longer
   * `armed`, and announce each. A restart leaves exactly this state without any
   * activation change, so the scan — not the edge — is what covers it. Every scan
   * records one note, because a silent scan fixing a silent state would repeat the
   * failure it exists to remove.
   * @param source - why the scan ran, e.g. `mount` or `retry`.
   */
  async function scanDisarmedGoals(source) {
    const roots = allRoots()
    const trace = {
      scan: goalScanCount += 1,
      source,
      attempted: roots.length,
      foundActiveDisarmed: 0,
      sent: 0,
      skippedRecipientIsSelf: 0,
      skippedNoOwner: 0,
      skippedOther: 0,
      duplicates: 0,
      overflow: 0,
    }
    const overflowByOwner = new Map()
    if (config.goalDisarmNotice === true && ctx.get('goals') !== undefined) {
      for (const agent of roots) {
        const view = ctx.get('goals')?.get?.(agent)
        if (view === undefined || view.phase !== 'active' || view.activation !== 'disarmed') continue
        trace.foundActiveDisarmed += 1
        if (trace.sent >= GOAL_DISARM_NOTICE_LIMIT) {
          // Bounded: the rest is summarized rather than sent one by one.
          trace.overflow += 1
          const identity = identityOf(agent)
          const owner = identity === undefined
            ? undefined
            : roleOwnerFor(await readOwnerRoster(config.maildir), identity.role)
          if (owner !== undefined && owner !== agent.id) {
            const listed = overflowByOwner.get(owner) ?? []
            listed.push(agent.id)
            overflowByOwner.set(owner, listed)
          }
          continue
        }
        const disposition = await notifyGoalDisarmed(agent.id, view)
        if (disposition === 'sent') trace.sent += 1
        else if (disposition === 'duplicate') trace.duplicates += 1
        else if (disposition === 'skipped-recipient-is-self') trace.skippedRecipientIsSelf += 1
        else if (disposition === 'skipped-no-owner') trace.skippedNoOwner += 1
        else trace.skippedOther += 1
      }
      for (const [owner, sessions] of overflowByOwner) {
        await deliverNotice(owner, {
          id: nextMessageId(),
          ts: localTimestamp(),
          from: 'session-mail',
          from_session: sessions[0],
          topic: GOAL_DISARMED_TOPIC,
          body: `${sessions.length} more session(s) are active with automatic continuation disarmed and were not `
            + `announced individually: ${sessions.join(', ')}. 在这些会话里说“继续”即可恢复自动续跑。`,
          to_session: owner,
        })
      }
    }
    note('goal-disarm-scan', trace)
  }

  /**
   * Turn one claim-and-hand-off outcome into the receipt fields of `mail_send`.
   * @param outcome - result of one delivery attempt.
   * @returns the `delivered`, `woke`, and reason fields of the tool result, plus
   *   the target's wake budget whenever this process made the delivery decision;
   *   a target another process owns carries no reading.
   */
  function receiptOf(outcome) {
    if (outcome.result !== 'delivered') {
      const failure = outcome.result === 'held'
        ? 'claim-held-by-another-process'
        : outcome.result === 'failed' ? 'injection-failed' : 'already-delivered'
      return { delivered: 'mailbox', woke: false, failure }
    }
    const budget = outcome.wakeBudget === undefined ? {} : { wakeBudget: outcome.wakeBudget }
    if (outcome.woke === true) return { delivered: 'push', woke: true, mode: 'wakeup', ...budget }
    // A next-step injection into a running turn is an ordinary hand-off; an
    // injection into an idle target is not a wake and is reported as `injected`.
    return outcome.reason === 'target-running'
      ? { delivered: 'push', woke: false, mode: 'inject', injectReason: 'target-running', ...budget }
      : { delivered: 'injected', woke: false, mode: 'inject', injectReason: outcome.reason, ...budget }
  }

  /**
   * Claim one message for a hosted session and hand it over, recording the
   * outcome in the maildir so no other process delivers it again.
   * @param identity - identity whose inbox holds the message.
   * @param agent - hosted session the message belongs to.
   * @param msg - parsed mailbox message.
   * @returns the claim result (`delivered`, `held`, `already`, or `failed`) and,
   *   when this process handed the message over, how it reached the agent.
   */
  async function deliverClaimed(identity, agent, msg) {
    const claim = await tryClaimMessage(config.maildir, {
      role: identity.role, msgId: msg.id, sessionId: agent.id, owner: self, claimTtlMs: config.claimTtlMs,
    })
    let outcome
    if (claim === 'delivered') outcome = { result: 'already' }
    else if (claim !== 'mine') outcome = { result: claim }
    else {
      let handoff
      try {
        handoff = deliver(agent, msg, { claimRole: identity.role })
      } catch (error) {
        // The claim stays in the `claimed` state on purpose: the takeover path
        // retries it once the claim time-to-live expires, so a failed injection
        // delays the message instead of losing it.
        warn(`session-mail: delivering ${msg.id} to ${shortId(agent.id)} failed: ${error?.message ?? error}`)
        outcome = { result: 'failed' }
      }
      if (outcome === undefined) {
        await markMessageDelivered(config.maildir, {
          role: identity.role, msgId: msg.id, sessionId: agent.id, owner: self,
        })
        outcome = { result: 'delivered', ...handoff }
      }
    }
    // `already` is not a decision this process made — an earlier pass or another
    // process settled the claim, and every poll pass re-examines the lines above
    // its watermark, so recording it would flood the ledger with scan noise.
    if (outcome.result !== 'already') {
      note('delivery', {
        msg: msg.id, to: agent.id, route: identity.role, outcome: outcome.result,
        ...(outcome.mode === undefined ? {} : { mode: outcome.mode, woke: outcome.woke === true }),
        ...(outcome.reason === undefined ? {} : { injectReason: outcome.reason }),
        targetStatus: agent.status,
      })
    }
    return outcome
  }

  /**
   * Claim one direct-pool message for a hosted session and hand it over,
   * recording the outcome under the shared `direct` claim role.
   * @param agent - hosted session the message names.
   * @param msg - parsed message from its direct pool.
   * @returns the claim result (`delivered`, `held`, `already`, or `failed`) and,
   *   when this process handed the message over, how it reached the agent.
   */
  async function deliverDirectClaimed(agent, msg) {
    const claim = await tryClaimMessage(config.maildir, {
      role: DIRECT_CLAIM_ROLE, msgId: msg.id, sessionId: agent.id, owner: self, claimTtlMs: config.claimTtlMs,
    })
    let outcome
    if (claim === 'delivered') outcome = { result: 'already' }
    else if (claim !== 'mine') outcome = { result: claim }
    else {
      let handoff
      try {
        handoff = deliver(agent, msg, { claimRole: DIRECT_CLAIM_ROLE })
      } catch (error) {
        // Same contract as the role path: the claim stays `claimed` and the
        // takeover path retries, so a failed injection delays instead of losing.
        warn(`session-mail: delivering ${msg.id} to ${shortId(agent.id)} failed: ${error?.message ?? error}`)
        outcome = { result: 'failed' }
      }
      if (outcome === undefined) {
        await markMessageDelivered(config.maildir, {
          role: DIRECT_CLAIM_ROLE, msgId: msg.id, sessionId: agent.id, owner: self,
        })
        outcome = { result: 'delivered', ...handoff }
      }
    }
    note('delivery', {
      msg: msg.id, to: agent.id, route: DIRECT_CLAIM_ROLE, outcome: outcome.result,
      ...(outcome.mode === undefined ? {} : { mode: outcome.mode, woke: outcome.woke === true }),
      ...(outcome.reason === undefined ? {} : { injectReason: outcome.reason }),
      targetStatus: agent.status,
    })
    return outcome
  }

  /**
   * One direct-pool sweep for a locally hosted session: claim-and-deliver
   * every staged message, then rewrite the pool without the delivered lines.
   * Claims make the sweep safe against the process that hosts the session
   * concurrently doing the same work.
   * @param agent - hosted session whose pool is swept.
   */
  async function pollDirectPool(agent) {
    const lines = await readInboxLines(directPath(config.maildir, agent.id))
    if (lines.length === 0) return
    const kept = []
    let changed = false
    for (const line of lines) {
      const msg = parseMessage(line)
      if (msg === undefined) {
        kept.push(line) // torn or corrupt line: kept, per PROTOCOL.md §4
        continue
      }
      const outcome = await deliverDirectClaimed(agent, msg)
      if (outcome.result === 'delivered' || outcome.result === 'already') {
        changed = true
        continue
      }
      if (outcome.result === 'failed') {
        warn(`session-mail: direct delivery of ${msg.id} to ${shortId(agent.id)} deferred to the claim takeover window`)
      }
      kept.push(line)
    }
    if (changed) await rewriteDirect(config.maildir, agent.id, kept)
  }

  const sweepingDirect = new Set()
  /**
   * Sweep the direct pools of every locally hosted session. A session's pool
   * is its point-to-point inbox: this is how a session-addressed message sent
   * from another process (relay) or before the addressee existed (mailbox)
   * reaches it without any role-inbox involvement.
   */
  async function pollDirect() {
    if (config.batchWindowMs > 0) await sleep(config.batchWindowMs)
    for (const agent of allRoots()) {
      if (sweepingDirect.has(agent.id)) continue
      sweepingDirect.add(agent.id)
      try {
        await pollDirectPool(agent)
      } finally {
        sweepingDirect.delete(agent.id)
      }
    }
  }

  /**
   * One inbox poll: deliver every unclaimed line whose owner this process
   * hosts. A line whose addressee is offline, or live in another process, is
   * skipped — never held — so it cannot block the lines behind it.
   * @param identity - identity whose inbox file is watched.
   */
  async function poll(identity) {
    if (polling.has(identity.role)) return
    polling.add(identity.role)
    try {
      const path = join(config.maildir, identity.inbox)
      let lines = await readInboxLines(path)
      if (!observed.has(identity.role)) {
        observed.add(identity.role)
        const persisted = await readCursor(config.maildir, identity.role)
        if (persisted === undefined && !config.catchUpOnStart) {
          // Unchanged 0.3.0 semantic: mail already in the file when the plugin
          // mounts is not pushed; mail_drain (backlog: true) pulls it.
          cursors.set(identity.role, lines.length)
          await writeCursor(config.maildir, identity.role, lines.length)
          return
        }
      }
      const roster = await readOwnerRoster(config.maildir)
      const rosterList = rosterListFor(roster, identity.role)
      const designatedOwner = roleOwnerFor(roster, identity.role)
      const local = localRoots(identity, rosterList)
      if (local.length === 0) {
        await refreshWatermark(identity, lines)
        return
      }
      if (config.batchWindowMs > 0) {
        await sleep(config.batchWindowMs)
        lines = await readInboxLines(path)
      }
      const view = await viewOfRole(identity, rosterList)
      const watermark = await currentWatermark(identity, lines)
      for (let index = 0; index < lines.length; index++) {
        if (index < watermark) continue
        const msg = parseMessage(lines[index])
        if (msg === undefined) continue // torn or corrupt line: skipped, per PROTOCOL.md §4
        const owner = ownerOf(msg, view, designatedOwner)
        if (owner === undefined || owner.local !== true) continue
        // A settled line can never be delivered again, so re-attempting its claim
        // on every pass is pure work — and while a stalled watermark keeps such a
        // line above it, that work repeats every poll interval. The skip is
        // recorded once per message per process, so the work stays visible.
        const settled = await readClaim(config.maildir, identity.role, msg.id)
        if (settled !== undefined && TERMINAL_CLAIM_STATES.has(settled.state)) {
          note('delivery-skipped', {
            msg: msg.id, to: owner.agent.id, route: identity.role, claimState: settled.state,
          })
          continue
        }
        await deliverClaimed(identity, owner.agent, msg)
      }
      await refreshWatermark(identity, lines)
    } finally {
      polling.delete(identity.role)
    }
  }

  for (const identity of identities) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        poll(identity).catch((error) => {
          warn(`session-mail: inbox poll failed for ${identity.role}: ${error?.message ?? error}`)
        })
      }, config.pollMs)
      return () => clearInterval(timer)
    }, `session-mail.watch.${identity.role}`)
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      pollDirect().catch((error) => {
        warn(`session-mail: direct-pool poll failed: ${error?.message ?? error}`)
      })
    }, config.pollMs)
    return () => clearInterval(timer)
  }, 'session-mail.watch.direct')

  // Presence outlives no process: a killed instance stops refreshing, its
  // records age out of the live view, and whoever polls next may take over its
  // unreported claims.
  ctx.effect(() => {
    const timer = setInterval(() => {
      publishPresence().catch((error) => {
        warn(`session-mail: presence heartbeat failed: ${error?.message ?? error}`)
      })
    }, config.presenceHeartbeatMs)
    return () => clearInterval(timer)
  }, 'session-mail.presence')

  ctx.effect(() => {
    const timer = setInterval(() => {
      sweepMailboxState(config.maildir, {
        presenceTtlMs: config.presenceTtlMs,
        claimRetentionMs: config.claimRetentionMs,
      }).catch((error) => {
        warn(`session-mail: state sweep failed: ${error?.message ?? error}`)
      })
      sweepLedger(config.maildir, {
        retentionMs: config.ledgerRetentionDays * 24 * 60 * 60 * 1000,
      }).catch((error) => {
        warn(`session-mail: ledger sweep failed: ${error?.message ?? error}`)
      })
    }, config.sweepIntervalMs)
    return () => clearInterval(timer)
  }, 'session-mail.sweep')

  /**
   * Register the mailbox snapshot route on the web surface. Same trust fence
   * as the shipped host routes: the connection service rejects untrusted
   * requests before any handler work.
   *
   * 'webServer' stays OUT of this plugin's inject list on purpose (the mailbox
   * tools must attach in webless surfaces too), so the fiber property proxy
   * rejects a `webCtx.webServer` access — the optional service is read with
   * `ctx.get`, which reads the global service store instead.
   * @param webCtx - context carrying the webServer service.
   */
  const registerMailboxRoute = (webCtx) => {
    webCtx.effect(() => {
      const webServer = webCtx.get('webServer')
      if (webServer === undefined) return undefined
      return webServer.register({
        kind: 'exact',
        path: MAILBOX_UI_ROUTE,
        handler: async (req, res) => {
          const connection = ctx.get('connection')
          const rejection = connection?.requestRejection?.(req)
          if (rejection !== undefined) {
            res.statusCode = rejection
            res.end()
            return
          }
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }
          try {
            const payload = await mailboxSnapshot()
            res.statusCode = 200
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(JSON.stringify(payload))
          } catch (error) {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: String(error?.message ?? error) }))
          }
        },
      })
    }, `session-mail: GET ${MAILBOX_UI_ROUTE}`)
  }

  /**
   * Assemble the read-only mailbox snapshot served to the Web tab: per box,
   * every parseable message in file order, the resolved-prefix watermark, and
   * the live session count of the role across all dsh processes. State is read
   * fresh per request; no cache.
   * @returns the snapshot payload.
   */
  async function mailboxSnapshot() {
    const roster = await readOwnerRoster(config.maildir)
    const boxes = []
    for (const identity of identities) {
      const lines = await readInboxLines(join(config.maildir, identity.inbox))
      let cursor = cursors.get(identity.role)
      if (cursor === undefined) cursor = (await readCursor(config.maildir, identity.role)) ?? 0
      const messages = []
      for (const line of lines) {
        const msg = parseMessage(line)
        if (msg !== undefined) messages.push(msg)
      }
      const view = await viewOfRole(identity, rosterListFor(roster, identity.role))
      boxes.push({
        role: identity.role,
        name: identity.name,
        inbox: identity.inbox,
        cursor,
        total: messages.length,
        live: view.length,
        liveLocal: view.filter(entry => entry.local === true).length,
        messages,
      })
    }
    return { maildir: config.maildir, generatedAt: localTimestamp(), boxes }
  }

  // Optional service: the mailbox tools must attach in every surface, while
  // the route exists only where the webserver does (the modules row's pattern).
  if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], registerMailboxRoute)
  else registerMailboxRoute(ctx)

  /**
   * Attach the mailbox tools and prompt section to one agent's scoped context.
   * Scoped contributions unwind with the agent, so reopening a session or
   * swapping a preset never leaks registrations. Every root session gets the
   * tools: session-ID addressing works without a configured identity.
   * @param agent - exact live root agent.
   * @param identity - the identity matched for this agent, if its cwd has one.
   */
  function attach(agent, identity) {
    if (attached.has(agent)) return
    attached.add(agent)
    attachedAt.set(agent, Date.now())
    agent.ctx.effect(() => {
      const tools = [
        agent.ctx.tools.register(mailSendTool()),
        agent.ctx.tools.register(mailBudgetTool()),
        agent.ctx.tools.register(mailDrainTool()),
        agent.ctx.tools.register(sessionArchiveTool()),
        agent.ctx.tools.register(sessionUnarchiveTool()),
        agent.ctx.tools.register(sessionArchivedListTool()),
      ]
      const section = agent.ctx.systemPrompt.section({
        name: 'tool:session-mail',
        order: agent.ctx.systemPrompt.getSectionOrder('TOOL_JOBS'),
        text: SECTION_TEXT,
      })
      // The session-creation tools are a separate capability with a separate
      // switch, so they get their own prompt section rather than being folded
      // into the mailbox text: a deployment that turns `createTool` off should
      // not leave the model told about tools it does not have.
      const createSections = []
      if (config.createTool === true) {
        tools.push(agent.ctx.tools.register(sessionCreateTool()))
        tools.push(agent.ctx.tools.register(workspaceCreateTool()))
        createSections.push(agent.ctx.systemPrompt.section({
          name: 'tool:session-create',
          order: agent.ctx.systemPrompt.getSectionOrder('TOOL_JOBS'),
          text: SESSION_CREATE_SECTION_TEXT,
        }))
      }
      // The wake budget counts this mailbox's own consecutive wakes only: any
      // other inbox insertion (a human prompt, another plugin's notice) resets
      // it, so a session that keeps being driven by mail can be woken again
      // after outside input. Without this listener the documented reset never
      // happened, and once a target had spent its budget every later notice
      // degraded to injection for the life of the process — an idle session
      // then looked like it never received mail at all.
      let resetWakeBudget
      try {
        resetWakeBudget = agent.ctx.on('agent/inbox/inserted', ({ message }) => {
          const source = message?.source
          if (isOwnSource(source)) return
          wakeSpent.delete(agent)
        })
      } catch (error) {
        warn(`session-mail: wake-budget reset hook unavailable on ${shortId(agent.id)}: ${error?.message ?? error}`)
      }
      // Consumption tracking for mailbox wakes. A `delivered` claim only proves
      // the message was handed over, so these listeners decide the terminal
      // state: a committed model response consumes it, a failed request settles
      // it, and any other way back to idle settles it without a model answer.
      const disposition = []
      const observe = (event, listener) => {
        try {
          disposition.push(agent.ctx.on(event, listener))
        } catch (error) {
          warn(`session-mail: ${event} hook unavailable on ${shortId(agent.id)}: ${error?.message ?? error}`)
        }
      }
      observe('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
        const entry = pendingWake.get(subject)
        if (entry === undefined || message?.id !== entry.deliveryId) return
        entry.turn = turn
      })
      observe('agent/assistant-stream', ({ agent: subject, frame }) => {
        const entry = pendingWake.get(subject)
        if (entry === undefined) return
        // A committed assistant settlement is the one proof the model answered
        // the request that carried this message.
        if (frame?.type === 'end' && frame.outcome?.kind === 'committed') {
          settleWake(subject, 'consumed').catch((error) => {
            warn(`session-mail: recording consumption of ${entry.msg.id} failed: ${error?.message ?? error}`)
          })
        }
      })
      observe('agent/error', ({ agent: subject, turn, error }) => {
        const entry = pendingWake.get(subject)
        if (entry === undefined) return
        if (entry.turn !== undefined && turn !== entry.turn) return
        const detail = failureCodeOf(error)
        settleWake(subject, 'failed', detail).catch((failure) => {
          warn(`session-mail: settling wake ${entry.msg.id} failed: ${failure?.message ?? failure}`)
        })
      })
      observe('agent/status', ({ agent: subject, status }) => {
        // A turn that fails reports `agent/error` first; an abort or a blocked
        // step returns to idle without it, and neither may be redelivered.
        if (status !== 'idle') return
        const entry = pendingWake.get(subject)
        if (entry === undefined) return
        if (entry.armed === true) {
          redeliver(subject, entry).catch((error) => {
            warn(`session-mail: redelivering on ${shortId(subject.id)} failed: ${error?.message ?? error}`)
          })
          return
        }
        settleWake(subject, 'unanswered', 'turn-ended-without-response').catch((error) => {
          warn(`session-mail: settling wake on ${shortId(subject.id)} failed: ${error?.message ?? error}`)
        })
      })
      return () => {
        for (const dispose of tools) dispose()
        section()
        for (const dispose of createSections) dispose()
        resetWakeBudget?.()
        for (const dispose of disposition) dispose()
      }
    }, `session-mail.attach.${identity?.role ?? 'direct'}`)
  }

  ctx.on('agent/created', ({ agent }) => {
    // This listener runs inside every session open; a synchronous throw here
    // vetoes the agent publication itself, so containment is the failure mode.
    try {
      // Subagents share the workspace cwd but are not mailbox endpoints.
      if (!ctx.agents.roots().includes(agent)) return
      attach(agent, identityOf(agent))
    } catch (error) {
      ctx.logger?.error?.(`session-mail: attaching mailbox to session ${agent?.id ?? 'unknown'} failed; session continues without mailbox tools: ${error?.stack ?? error}`)
    }
    // A session that just opened must be visible to the other dsh processes
    // before their next poll, not one heartbeat later.
    publishPresence().catch((error) => {
      warn(`session-mail: presence publish failed: ${error?.message ?? error}`)
    })
    // Pending restart wakes ride session open: when the restarted service
    // materializes a targeted session again, its wake delivers here and the
    // session continues without the owner typing anything.
    deliverPendingWakes().catch((error) => {
      warn(`session-mail: wake delivery failed: ${error?.message ?? error}`)
    })
    // A goal service that was not up at mount gets another chance as soon as a
    // session opens, instead of waiting out the retry timer.
    retryGoalScan()
  })

  // Sessions already live when the plugin mounts (first install, live patch
  // reload) get the same attachment and presence publication immediately.
  for (const agent of ctx.agents.roots()) {
    attach(agent, identityOf(agent))
  }
  publishPresence().catch((error) => {
    warn(`session-mail: presence publish failed: ${error?.message ?? error}`)
  })

  /**
   * Announce a goal that came back disarmed while it is still active. The edge is
   * what a process-local activation change publishes; a restart lands disarmed
   * without any change, which the mount scan below covers instead.
   */
  ctx.on('goal/activation-changed', (payload) => {
    if (config.goalDisarmNotice !== true) return
    const goal = payload?.goal
    if (goal?.activation !== 'disarmed') return
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
    if (sessionId === undefined) return
    notifyGoalDisarmed(sessionId, goal)
      .then((disposition) => {
        if (disposition === 'sent') {
          note('goal-disarm-edge', { sessionId, goalId: goal.id, revision: goal.revision })
        }
      })
      .catch((error) => {
        warn(`session-mail: goal-disarm notice for ${shortId(sessionId)} failed: ${error?.message ?? error}`)
      })
  })

  /** Run one scan and contain its failure, so a scan never breaks delivery. */
  const runGoalScan = (source) => {
    scanDisarmedGoals(source).catch((error) => {
      warn(`session-mail: goal-disarm scan (${source}) failed: ${error?.message ?? error}`)
    })
  }

  // A restart restores an active goal disarmed with no activation change to
  // observe, so the mount scan is what announces that state. A goal service that is
  // not up yet is retried on the next session open and once on a short timer.
  let goalScanPending = ctx.get('goals') === undefined
  runGoalScan('mount')
  /** Retry the mount scan once the goal service exists; hoisted so the session-open
   * listener can call it before this line runs. */
  function retryGoalScan() {
    if (!goalScanPending) return
    if (ctx.get('goals') === undefined) return
    goalScanPending = false
    runGoalScan('retry')
  }
  ctx.effect(() => {
    const timer = setTimeout(retryGoalScan, GOAL_DISARM_SCAN_RETRY_MS)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'session-mail.goal-scan-retry')

  const wakeDelivery = { chain: Promise.resolve(), delivered: new Set() }
  /**
   * Queue a wake pass behind any pass already running. A trigger arriving
   * while another pass runs must not be dropped — the session that opens
   * during the mount pass is exactly the one whose wake is still pending —
   * while the fingerprint set keeps the queued pass from re-delivering what
   * the earlier pass already handed over.
   * @returns the queued pass, settling when its own delivery attempt finished.
   */
  function deliverPendingWakes() {
    const pass = wakeDelivery.chain.then(() => runWakePass())
    wakeDelivery.chain = pass.catch(() => {})
    return pass
  }

  /**
   * One delivery pass over the pending wake requests. A restart wake is
   * addressed to a session this process must host, so it never relays.
   */
  async function runWakePass() {
    const wakes = await readWakeRequests(config.maildir)
    if (wakes.length === 0) return
    const now = Date.now()
    const remaining = []
    let changed = false
    for (const wake of wakes) {
      const fingerprint = `${wake.sessionId}\u0000${wake.message}`
      if (wakeDelivery.delivered.has(fingerprint)) {
        changed = true
        continue
      }
      const requestedAt = Date.parse(wake.requestedAt ?? '')
      if (Number.isFinite(requestedAt) && now - requestedAt > WAKE_MAX_AGE_MS) {
        changed = true
        continue
      }
      const target = ctx.agents.roots().find(agent => agent.id === wake.sessionId)
      if (target === undefined) {
        remaining.push(wake)
        continue
      }
      target.followup(createUserMessage({
        content: [{ type: 'text', text: wake.message }],
        source: ownSource({ form: 'notice', summary: 'wake after restart' }),
      }))
      wakeDelivery.delivered.add(fingerprint)
      changed = true
    }
    if (changed && !await writeWakeRequests(config.maildir, remaining)) {
      warn('session-mail: writing the remaining restart wakes back to .wake.json failed;'
        + ' a delivered wake may be repeated after the next restart')
    }
  }

  // Wakes for sessions already live when the plugin mounts deliver now; the
  // agent/created listener covers the ones that open later.
  deliverPendingWakes().catch((error) => {
    warn(`session-mail: wake delivery failed: ${error?.message ?? error}`)
  })

  /**
   * Render the fail-loud ambiguity error for a fresh send with several live
   * peer sessions: candidates sorted running-first then newest-open, the
   * first marked as the recommended default for an owner question.
   * @param targetIdentity - the target role config.
   * @param view - live-session view of the target role, across all processes.
   * @returns the error message listing every candidate with its full session id.
   */
  function ambiguityMessage(targetIdentity, view) {
    const rank = (entry) => (entry.status === 'running' ? 0 : 1)
    const candidates = [...view]
      .sort((a, b) => rank(a) - rank(b) || byAttachOrder(b, a))
      .map(entry => ({ ...entry }))
    const lines = candidates.map((candidate, position) => {
      const where = candidate.local === true ? 'this dsh process' : 'another dsh process'
      const state = candidate.status === 'running' ? `running now, ${where}` : `idle since open, ${where}`
      // A candidate this process hosts carries its live reading; a peer process's
      // budget is unreadable here, so the owner picks on what is known.
      const budget = candidate.local === true
        ? `; wake budget ${wakeBudgetReading(candidate.agent).spent}/${config.maxConsecutiveWakes} spent`
        : '; wake budget unknown (another dsh process owns it)'
      const mark = position === 0 ? '  ← recommended default' : ''
      return `  ${position + 1}. session ${shortId(candidate.sessionId)} (${state}${budget})${mark}\n     full id: ${candidate.sessionId}`
    })
    return `session-mail: target role "${targetIdentity.role}" has ${candidates.length} live sessions; ask the owner `
      + `with ask_user_question (default = option 1, owner may re-select) or retry with to_session. Candidates:\n${lines.join('\n')}`
  }

  /**
   * Acquire this process's hold on one offline addressee, so the message has a
   * live receiver. The hold is the Session's write ownership, so acquisition is
   * the same resume any Agent-bound work performs, and it fails the same way
   * (`session/agent-busy`) when another process still holds the Session.
   *
   * A missing service or a refused acquisition leaves the message staged: the
   * addressee still receives it on its next open, and the refusal is reported
   * rather than swallowed.
   * @param sessionId - addressee session id.
   * @returns whether the hold is now held here, and the refusal reason when it is not.
   */
  /**
   * Classify one refused hold acquisition. Only a definitive "no such session"
   * may fail a send loud; anything else (a peer process holding it, a transient
   * failure) keeps the message staged, because refusing a real addressee would
   * drop mail the protocol promises to deliver.
   * @param error - the value `setHeld` rejected with.
   * @returns the refusal reason, and whether the session is definitively absent.
   */
  function activationRefusal(error) {
    const message = String(error?.message ?? error)
    if (error?.code === 'session/not-found' || /not found/i.test(message)) {
      return { ok: false, reason: 'not-found', absent: true }
    }
    return { ok: false, reason: /busy|already owned|held/i.test(message) ? 'agent-busy' : message }
  }

  /**
   * Acquire this process's hold on one offline addressee, so the message has a
   * live receiver. The hold is the Session's write ownership, so acquisition is
   * the same resume any Agent-bound work performs, and it fails the same way
   * (`session/agent-busy`) when another process still holds the Session.
   *
   * The probe is also the only definitive existence test available here, so it
   * runs even when activation is switched off: a hold this call acquired is then
   * released again, and an id that names no session is reported for the caller to
   * refuse instead of staging a pool file nothing can ever read.
   *
   * A missing service or a refused acquisition leaves the message staged: the
   * addressee still receives it on its next open, and the refusal is reported
   * rather than swallowed.
   * @param sessionId - addressee session id.
   * @returns whether the hold is now held here, why not when it is not, and
   *   whether the id is definitively absent.
   */
  async function activateTarget(sessionId) {
    const controller = ctx.get('sessionController')
    if (controller === undefined || typeof controller.setHeld !== 'function') {
      return { ok: false, reason: 'no-session-controller' }
    }
    if (!config.activateOnSend) {
      try {
        const probe = await controller.setHeld({ sessionId, held: true })
        if (probe?.changed === true) {
          try {
            await controller.setHeld({ sessionId, held: false })
          } catch (error) {
            // The session exists but kept its hold: report the refusal and leave
            // it live rather than failing a send that can still be staged.
            warn(`session-mail: releasing the existence probe on "${sessionId}" failed: ${error?.message ?? error}`)
          }
        }
        return { ok: false, reason: 'activation-disabled' }
      } catch (error) {
        return activationRefusal(error)
      }
    }
    try {
      await controller.setHeld({ sessionId, held: true })
      return { ok: true }
    } catch (error) {
      const refusal = activationRefusal(error)
      warn(`session-mail: reviving "${sessionId}" failed (${refusal.reason}): ${error?.message ?? error}`)
      return refusal
    }
  }

  /**
   * The model-facing wake-budget clause of one `mail_send` receipt.
   * @param value - the receipt carrying an optional `wakeBudget`.
   * @returns a bracketed clause, or an empty string when no process here decided
   *   the delivery and therefore no reading exists.
   */
  function budgetNote(value) {
    const budget = value?.wakeBudget
    if (budget === undefined) return ''
    return ` [peer wake budget now ${budget.spent}/${budget.limit}; refills on any non-mailbox input in that session]`
  }

  /**
   * Build the `mail_send` tool definition against the configured identities.
   * @returns a tool definition for the scoped registry.
   */
  function mailSendTool() {
    return defineTool({
      name: 'mail_send',
      description: 'Append a message to a peer session\'s mailbox (directional JSONL signal channel). '
        + 'A live peer receives it immediately, in this process (wakeup turn or next-step injection) or '
        + 'through the other dsh process that hosts it; an addressee that is offline in every dsh process is '
        + 'revived in this one first when possible, and otherwise receives the message on its next open. '
        + 'The result reports whether this delivery opened a turn (`woke`): `injected` means the message '
        + 'reached the peer\'s inbox without opening one, so an idle peer stays idle until other input reaches it. '
        + 'It also reports the addressee\'s wake budget (`wakeBudget`) whenever this process decided the delivery. '
        + 'With reply_to the plugin routes the reply to the original sender\'s session automatically.',
      parameters: {
        to: { type: 'string', description: `Peer role. Valid targets: ${targetRoles}. Requires a mailbox identity; omit and use to_session when this session has none.` },
        topic: { type: 'string', required: true, description: 'Short signal kind per PROTOCOL.md, e.g. feed-ready / page-accepted / page-failed / blocker / question-for-owner / info.' },
        body: { type: 'string', required: true, description: 'Anchors only: commit hash, doc path, version. Never bulk content.' },
        reply_to: { type: 'string', description: 'Message id this message answers; routes delivery to the original sender\'s session.' },
        to_session: { type: 'string', description: 'Explicit addressee session id. Required when mail_send reports several live peer sessions; any session may be addressed this way, no mailbox identity needed.' },
        expect: { type: 'string', description: 'What the peer should do next.' },
      },
      presentCall: args => ({ card: 'generic', title: `Mailbox → ${args.to ?? shortId(args.to_session)}${args.to_session === undefined ? '' : ` (${shortId(args.to_session)})`} [${args.topic}]`, kind: 'execute', rawInput: args.body }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            /**
             * How the message left this process: `push` reached a live local
             * agent, `injected` reached the local agent's inbox without opening
             * a turn, `relay` reached a peer hosted by another dsh process, and
             * `mailbox` stayed staged with no live addressee.
             */
            delivered: { type: 'string', required: true, enum: ['push', 'injected', 'relay', 'mailbox'] },
            /** Whether this delivery opened a turn on the addressee. */
            woke: { type: 'boolean', required: true },
            /** The mechanism that handed the message over, when one did. */
            mode: { type: 'string', enum: ['wakeup', 'inject'] },
            /**
             * Why an injection replaced a wakeup turn: the target was already
             * running one, its wake budget was spent, or delivery is quiet.
             */
            injectReason: { type: 'string', enum: ['target-running', 'wake-budget-exhausted', 'delivery-quiet'] },
            /** Whether this process revived an offline addressee before delivering. */
            activated: { type: 'boolean', required: true },
            /** Why reviving the addressee failed, when it did. */
            activationError: { type: 'string' },
            /** Why this process held the claim but handed nothing over. */
            failure: { type: 'string', enum: ['claim-held-by-another-process', 'already-delivered', 'injection-failed'] },
            /**
             * The addressee's mailbox wake budget after this delivery decision.
             * Absent when this process did not make the decision: a peer another
             * dsh process hosts, or a message that stayed staged.
             */
            wakeBudget: {
              type: 'object',
              additionalProperties: false,
              properties: {
                /** Wakeup turns this mailbox has opened on the addressee since its last non-mailbox input. */
                spent: { type: 'integer', required: true },
                /** The configured `maxConsecutiveWakes` this count is spent against. */
                limit: { type: 'integer', required: true },
                /** What refills the budget: any inbox insertion this plugin did not write. */
                refillsOn: { type: 'string', required: true, enum: ['non-mailbox-input'] },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.woke === true
            ? `message ${value.id} ${value.activated === true ? 'revived the addressee session in this process and opened a turn' : 'opened a wakeup turn on the peer session'}${budgetNote(value)}; expect its acknowledgment via reply_to`
            : value.delivered === 'push'
              ? `message ${value.id} injected into the peer session's running turn; the model sees it at that turn's next step${budgetNote(value)}`
              : value.delivered === 'injected'
                ? `message ${value.id} injected into an idle peer session (${value.injectReason}): the message is in its inbox, but this delivery opened NO turn — the peer acts only once other input reaches it${budgetNote(value)}`
                : value.delivered === 'relay'
                  ? `message ${value.id} appended for a peer session live in another dsh process; that process's watcher delivers it within one poll interval`
                  : value.failure === 'injection-failed'
                    ? `message ${value.id} could not be handed to the addressee session in this process; it stays staged in its pool for the next delivery attempt`
                    : value.failure === 'already-delivered'
                      ? `message ${value.id} was already delivered to the addressee session by another process`
                      : value.failure === 'claim-held-by-another-process'
                        ? `message ${value.id} is staged; another dsh process owns its delivery`
                        : `message ${value.id} staged for the addressee session; no live session is listening under that id`
                          + (value.activationError === undefined
                            ? ', so it receives the message on its next open'
                            : `, and reviving it here failed: ${value.activationError}`),
        }],
      },
      async execute(args, exec) {
        const hasRole = typeof args.to === 'string' && args.to.length > 0
        const hasSession = typeof args.to_session === 'string' && args.to_session.length > 0
        if (!hasRole && !hasSession) {
          throw new Error('session-mail: name the addressee — a peer role (to) or a session id (to_session)')
        }
        // 发免费, but role addressing (the broadcast channel) stays a privilege
        // of sessions whose cwd has a mailbox identity; identity-less sessions
        // self-certify via the from_session stamp and address peers by id only.
        const from = identityOf(exec.agent)
        if (hasRole && from === undefined) {
          throw new Error('session-mail: role addressing requires a mailbox identity (this session\'s cwd is not listed in config.identities) — address the peer with to_session')
        }
        let target
        let view
        if (hasRole) {
          target = byRole.get(args.to)
          if (target === undefined) {
            throw new Error(`session-mail: unknown peer role ${JSON.stringify(args.to)}; valid targets: ${targetRoles}`)
          }
          view = await viewOfRole(target, rosterListFor(await readOwnerRoster(config.maildir), target.role))
        }
        const isReply = typeof args.reply_to === 'string' && args.reply_to.length > 0

        // Resolve the addressee. A reply is routed mechanically: the original
        // message's sender owns the answer. A fresh send targets the role's
        // only live session; several live sessions fail loud with candidates
        // (the model asks the owner or sets to_session, and the candidates now
        // include sessions hosted by other dsh processes) — never a silent
        // guess; zero live sessions leave the message as the role's mailbox.
        let toSession = hasSession ? args.to_session : undefined
        if (isReply && toSession === undefined) {
          if (from === undefined) {
            throw new Error(`session-mail: reply_to ${args.reply_to} cannot be resolved without a mailbox identity — pass to_session explicitly`)
          }
          const inboxLines = await readInboxLines(join(config.maildir, from.inbox))
          const original = inboxLines
            .map(line => parseMessage(line))
            .find(msg => msg?.id === args.reply_to && typeof msg.from_session === 'string')
          if (original === undefined) {
            throw new Error(`session-mail: reply_to ${args.reply_to} not found in this role's inbox (archived?) — pass to_session explicitly`)
          }
          toSession = original.from_session
        }
        if (toSession === undefined) {
          if (view.length === 1) toSession = view[0].sessionId
          else if (view.length > 1) throw new Error(ambiguityMessage(target, view))
        }
        // Shape gate: only a full session UUID can name a session. Short names,
        // display-truncated ids, and pasted concatenations used to reach the
        // filesystem as an addressee nobody could ever read.
        if (toSession !== undefined && !SESSION_ID_PATTERN.test(toSession)) {
          throw new Error(`session-mail: to_session ${JSON.stringify(toSession)} is not a session id — expected `
            + '"session-<8 hex>-<4 hex>-<4 hex>-<4 hex>-<12 hex>". Copy the full id from the target\'s .presence '
            + 'file or from a message\'s from_session; nothing was staged.')
        }

        const message = {
          id: nextMessageId(),
          ts: localTimestamp(),
          from: from?.name ?? exec.agent.id,
          from_session: exec.agent.id,
          topic: args.topic,
          body: args.body,
          ...(isReply ? { reply_to: args.reply_to } : {}),
          ...(toSession !== undefined ? { to_session: toSession } : {}),
          ...(typeof args.expect === 'string' && args.expect.length > 0 ? { expect: args.expect } : {}),
        }

        // Role route: the configured identity's inbox, behavior unchanged
        // since v0.4.0 (push / relay / mailbox by the live view).
        if (target !== undefined) {
          await appendMessage(join(config.maildir, target.inbox), message)
          const owner = ownerOf(message, view)
          if (owner === undefined) return { id: message.id, delivered: 'mailbox', woke: false, activated: false }
          if (owner.local !== true) return { id: message.id, delivered: 'relay', woke: false, activated: false }
          return { id: message.id, ...receiptOf(await deliverClaimed(target, owner.agent, message)), activated: false }
        }

        // Session-ID route: never touches a role inbox. The message stages in
        // the addressee's direct pool; a locally hosted addressee is pushed
        // immediately, a live remote one is delivered by its hosting process's
        // direct-pool watcher, and an addressee that is offline everywhere is
        // revived here first so the dispatch does not wait for a manual open.
        const local = allRoots().find(agent => agent.id === toSession)
        if (local !== undefined) {
          await appendDirect(config.maildir, toSession, message)
          const handoff = await deliverDirectClaimed(local, message)
          return { id: message.id, ...receiptOf(handoff), activated: false }
        }
        const remote = (await readPresences(config.maildir)).find(record =>
          record.sessionId === toSession
          && presenceIsLive(record, { presenceTtlMs: config.presenceTtlMs }))
        if (remote !== undefined) {
          await appendDirect(config.maildir, toSession, message)
          return { id: message.id, delivered: 'relay', woke: false, activated: false }
        }

        // Nothing hosts the addressee and no live record names it, so the id is
        // verified before anything is written: a pool file under an id no session
        // can ever claim is a message nobody will ever read, and staging it
        // silently is exactly the failure this check removes.
        const activated = await activateTarget(toSession)
        if (activated.absent === true) {
          throw new Error(`session-mail: to_session ${JSON.stringify(toSession)} names no session — nothing was `
            + 'staged. Copy the id from the target\'s .presence file or from a message\'s from_session, and do not '
            + 'use a short or truncated id.')
        }
        await appendDirect(config.maildir, toSession, message)
        if (activated.ok) {
          const revived = allRoots().find(agent => agent.id === toSession)
          if (revived !== undefined) {
            const handoff = await deliverDirectClaimed(revived, message)
            return { id: message.id, ...receiptOf(handoff), activated: true }
          }
        }
        return {
          id: message.id,
          delivered: 'mailbox',
          woke: false,
          activated: activated.ok,
          ...(activated.reason === undefined ? {} : { activationError: activated.reason }),
        }
      },
    })
  }

  /**
   * Build the `mail_budget` read-only tool: peer wake budgets, readable before a
   * send. Only this process can read the budget of a session it hosts, so a peer
   * another process owns, or one that is offline, is reported unknown rather than
   * given a guessed number.
   * @returns a tool definition for the scoped registry.
   */
  function mailBudgetTool() {
    /** One row for a session this process hosts: the only exact reading there is. */
    const localRow = (agent) => {
      const role = identityOf(agent)?.role
      return {
        sessionId: agent.id,
        ...(role === undefined ? {} : { role }),
        status: agent.status,
        live: 'local',
        wakeBudget: wakeBudgetReading(agent),
      }
    }
    /** One row for a live session whose budget this process cannot read. */
    const remoteRow = (record) => ({
      sessionId: record.sessionId,
      ...(typeof record.role === 'string' && record.role.length > 0 ? { role: record.role } : {}),
      ...(typeof record.status === 'string' ? { status: record.status } : {}),
      live: 'remote',
      note: 'owned by the dsh process hosting that session',
    })
    const offlineRow = (named) => ({
      ...named,
      live: 'offline',
      note: 'no live session to report a wake budget for',
    })
    /** The live presence record of one session id, when any process published a fresh one. */
    const livePresence = async (sessionId) => (await readPresences(config.maildir))
      .find(record => record.sessionId === sessionId
        && presenceIsLive(record, { presenceTtlMs: config.presenceTtlMs }))

    return defineTool({
      name: 'mail_budget',
      description: 'Read the mailbox wake budget of peer sessions before sending. A `mail_send` opens a wakeup '
        + 'turn only while the addressee\'s budget lasts; past the limit the message is injected into an idle peer '
        + 'without opening a turn. Reports this process\'s own reading; a peer another dsh process hosts, or one '
        + 'that is offline, is reported unknown instead of a guessed number.',
      parameters: {
        to: { type: 'string', description: `Peer role. Valid targets: ${targetRoles}.` },
        to_session: { type: 'string', description: 'Explicit peer session id.' },
      },
      presentCall: () => ({ card: 'generic', title: 'Read peer wake budgets', kind: 'read' }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            peers: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sessionId: { type: 'string' },
                  role: { type: 'string' },
                  status: { type: 'string' },
                  /** Where the session is hosted: only `local` carries a reading. */
                  live: { type: 'string', required: true, enum: ['local', 'remote', 'offline'] },
                  /** The addressee's budget; present only for a session this process hosts. */
                  wakeBudget: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      spent: { type: 'integer', required: true },
                      limit: { type: 'integer', required: true },
                      refillsOn: { type: 'string', required: true, enum: ['non-mailbox-input'] },
                    },
                  },
                  /** Why no reading exists, when none does. */
                  note: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.peers.length === 0
            ? '(no peer session to report a wake budget for)'
            : value.peers.map((peer) => {
              const who = [peer.role, peer.sessionId === undefined ? undefined : shortId(peer.sessionId)]
                .filter(part => part !== undefined).join(' ')
              return peer.wakeBudget === undefined
                ? `${who}: wake budget unknown (${peer.note ?? 'no reading available'})`
                : `${who}: wake budget ${peer.wakeBudget.spent}/${peer.wakeBudget.limit} spent`
                  + `; status ${peer.status ?? 'unknown'}`
            }).join('\n'),
        }],
      },
      async execute(args, exec) {
        const hasRole = typeof args.to === 'string' && args.to.length > 0
        const hasSession = typeof args.to_session === 'string' && args.to_session.length > 0
        if (hasRole && hasSession) {
          throw new Error('session-mail: name either a peer role (to) or a session id (to_session), not both')
        }
        if (hasSession && !SESSION_ID_PATTERN.test(args.to_session)) {
          throw new Error(`session-mail: to_session ${JSON.stringify(args.to_session)} is not a session id — expected `
            + '"session-<8 hex>-<4 hex>-<4 hex>-<4 hex>-<12 hex>". Copy the full id from the target\'s .presence '
            + 'file or from a message\'s from_session; nothing was read.')
        }
        if (hasSession) {
          const hosted = allRoots().find(agent => agent.id === args.to_session)
          if (hosted !== undefined) return { peers: [localRow(hosted)] }
          const record = await livePresence(args.to_session)
          return {
            peers: [record === undefined ? offlineRow({ sessionId: args.to_session }) : remoteRow(record)],
          }
        }
        const identity = hasRole ? byRole.get(args.to) : undefined
        if (hasRole && identity === undefined) {
          throw new Error(`session-mail: unknown peer role ${JSON.stringify(args.to)}; valid targets: ${targetRoles}`)
        }
        // The role scope mirrors the live view role mail resolves against, roster
        // included; the unrestricted scope reports every hosted root session.
        const rosterList = identity === undefined
          ? undefined
          : rosterListFor(await readOwnerRoster(config.maildir), identity.role)
        const peers = []
        for (const agent of identity === undefined ? allRoots() : localRoots(identity, rosterList)) {
          if (agent === exec.agent) continue
          peers.push(localRow(agent))
        }
        const seen = new Set(peers.map(row => row.sessionId))
        for (const record of await readPresences(config.maildir)) {
          if (record.sessionId === exec.agent.id || seen.has(record.sessionId)) continue
          if (identity !== undefined && record.role !== identity.role) continue
          if (rosterList !== undefined && !rosterList.includes(record.sessionId)) continue
          if (!presenceIsLive(record, { presenceTtlMs: config.presenceTtlMs })) continue
          seen.add(record.sessionId)
          peers.push(remoteRow(record))
        }
        if (hasRole && peers.length === 0) peers.push(offlineRow({ role: identity.role }))
        return { peers }
      },
    })
  }

  /**
   * Build the `mail_drain` tool definition against the configured identities.
   * @returns a tool definition for the scoped registry.
   */
  function mailDrainTool() {
    return defineTool({
      name: 'mail_drain',
      description: 'Read this session\'s unconsumed mailbox messages and mark them consumed. '
        + 'Returns point-to-point mail addressed to this session id (any session has a direct pool), plus the '
        + 'role inbox only for the session that owns it (rostered main); a fork or non-main session never sees '
        + 'the role broadcast. New messages are normally pushed automatically; use this at explicit drain '
        + 'checkpoints (session start, pipeline handoff) or to recover after a missed push.',
      parameters: {
        backlog: { type: 'boolean', description: 'Include messages this session already consumed, and pre-existing mail the plugin did not push.' },
      },
      presentCall: () => ({ card: 'generic', title: 'Drain session mailbox', kind: 'read' }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            held: { type: 'integer', required: true },
            // Messages are protocol-open objects; objectness is the only sound constraint.
            messages: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value.count === 0
            ? ['(no messages addressed to this session)']
            : value.messages.map(msg => {
              const tail = []
              if (typeof msg.reply_to === 'string' && msg.reply_to.length > 0) tail.push(`reply-to: ${msg.reply_to}`)
              if (typeof msg.expect === 'string' && msg.expect.length > 0) tail.push(`expect: ${msg.expect}`)
              const head = `${msg.id} [${msg.topic}] from ${msg.from ?? 'unknown'}:`
              const body = tail.length > 0 ? `${msg.body}\n(${tail.join('; ')})` : msg.body
              return `${head}\n${body}`
            })).concat(value.held > 0 ? [`(${value.held} line(s) owned by another session or with no live addressee)`] : []).join('\n\n'),
        }],
      },
      async execute(args, exec) {
        const identity = identityOf(exec.agent)
        const myId = exec.agent.id
        const mine = []
        let held = 0

        // Direct pool: point-to-point mail addressed to this session id.
        // Every session owns exactly one pool; claims keep the sweep
        // exactly-once when the hosting process polls the same file.
        const directLines = await readInboxLines(directPath(config.maildir, myId))
        const kept = []
        let directChanged = false
        for (const line of directLines) {
          const msg = parseMessage(line)
          if (msg === undefined) {
            kept.push(line) // torn or corrupt line: kept, per PROTOCOL.md §4
            continue
          }
          const claim = await readClaim(config.maildir, DIRECT_CLAIM_ROLE, msg.id)
          if (claim !== undefined && TERMINAL_CLAIM_STATES.has(claim.state)) {
            directChanged = true
            if (args.backlog === true) mine.push(msg)
            continue
          }
          const outcome = await tryClaimMessage(config.maildir, {
            role: DIRECT_CLAIM_ROLE, msgId: msg.id, sessionId: myId, owner: self, claimTtlMs: config.claimTtlMs,
          })
          if (outcome === 'delivered') {
            directChanged = true
            if (args.backlog === true) mine.push(msg)
            continue
          }
          if (outcome !== 'mine') {
            held++
            kept.push(line)
            continue
          }
          // A drain consumes its own mail, exactly like the push path does.
          await markMessageDelivered(config.maildir, { role: DIRECT_CLAIM_ROLE, msgId: msg.id, sessionId: myId, owner: self })
          directChanged = true
          mine.push(msg)
        }
        if (directChanged) await rewriteDirect(config.maildir, myId, kept)

        // Role inbox: the rostered owner session (the cwd's main) reads the
        // broadcast exactly as before; a fork or a session without a mailbox
        // identity skips it — role broadcast only ever reaches the main.
        if (identity !== undefined) {
          // Consumption right: the owner.json roster (PROTOCOL.md §3.6) decides
          // who may claim this role's inbox.
          const roster = await readOwnerRoster(config.maildir)
          const rosterList = rosterListFor(roster, identity.role)
          const designatedOwner = roleOwnerFor(roster, identity.role)
          if (rosterList === undefined || rosterList.includes(myId)) {
            const lines = await readInboxLines(join(config.maildir, identity.inbox))
            const view = await viewOfRole(identity, rosterList)
            for (const line of lines) {
              const msg = parseMessage(line)
              if (msg === undefined) continue
              // Only lines this session owns are its mail: an addressed line names
              // it, an addressee-less line names the role's designated owner (or,
              // without one, the role's earliest live session).
              const owner = ownerOf(msg, view, designatedOwner)
              if (owner === undefined || owner.sessionId !== myId) {
                held++
                continue
              }
              const claim = await readClaim(config.maildir, identity.role, msg.id)
              if (claim !== undefined && TERMINAL_CLAIM_STATES.has(claim.state)) {
                if (args.backlog === true) mine.push(msg)
                continue
              }
              const outcome = await tryClaimMessage(config.maildir, {
                role: identity.role, msgId: msg.id, sessionId: myId, owner: self, claimTtlMs: config.claimTtlMs,
              })
              if (outcome === 'delivered') {
                if (args.backlog === true) mine.push(msg)
                continue
              }
              if (outcome !== 'mine') {
                held++
                continue
              }
              // A drain consumes its own mail, exactly like the push path does.
              await markMessageDelivered(config.maildir, { role: identity.role, msgId: msg.id, sessionId: myId, owner: self })
              mine.push(msg)
            }
            await refreshWatermark(identity, lines)
          }
        }
        return { count: mine.length, held, messages: mine }
      },
    })
  }

  /**
   * The workspace registry that owns the archived-session set, when this process
   * has one. Its absence is reported by the caller rather than acted around.
   * @returns the registry service, or `undefined` when unavailable.
   */
  function workspaceRegistryOf() {
    return ctx.get('workspaceRegistry')
  }

  /**
   * The Session Controller of this process, when the Host exposes one. Reviving
   * an offline addressee and creating a peer Session both need it, and both
   * report its absence rather than silently doing nothing.
   * @returns the controller service, or `undefined` when unavailable.
   */
  function controllerOf() {
    return ctx.get('sessionController')
  }

  /**
   * Build the `session_archive` tool definition. Archiving hides one session from
   * every workspace list, group, and search; it deletes no log and frees no disk,
   * and `session_unarchive` restores the row, so the description names it.
   * @returns a tool definition for the scoped registry.
   */
  function sessionArchiveTool() {
    return defineTool({
      name: 'session_archive',
      description: 'Archive one session by its exact id: the session leaves every workspace list, group, and search. '
        + 'Archiving hides a session — it deletes no log and frees no disk — and its companion session_unarchive '
        + 'restores the row. Idempotent: an already archived id reports alreadyArchived without writing again.',
      parameters: {
        session_id: {
          type: 'string',
          required: true,
          description: 'Exact session id: the full session UUID, never a short or display-truncated form.',
        },
      },
      presentCall: args => ({
        card: 'generic',
        title: `Archive session ${shortId(args.session_id)}`,
        kind: 'execute',
      }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            /** Whether this call performed the archive. */
            archived: { type: 'boolean', required: true },
            /** Whether the id was already archived, so nothing was written. */
            alreadyArchived: { type: 'boolean', required: true },
            /** The archive set as it stands after this call. */
            archivedSessionIds: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.archived === true
            ? `session archived; the archive now holds ${value.archivedSessionIds.length} session(s)`
            : 'session was already archived: nothing was written'
              + ` (${value.archivedSessionIds.length} session(s) archived)`,
        }],
      },
      async execute(args) {
        const sessionId = typeof args.session_id === 'string' ? args.session_id : ''
        if (!SESSION_ID_PATTERN.test(sessionId)) {
          throw new Error(`session-mail: session_id ${JSON.stringify(args.session_id)} is not a session id — expected `
            + '"session-<8 hex>-<4 hex>-<4 hex>-<4 hex>-<12 hex>". Copy the full id; nothing was archived.')
        }
        const registry = workspaceRegistryOf()
        if (registry === undefined) {
          throw new Error('session-mail: the workspace registry is unavailable in this process; nothing was archived')
        }
        const archived = [...registry.archivedSessionIds]
        if (archived.includes(sessionId)) {
          return { archived: false, alreadyArchived: true, archivedSessionIds: archived }
        }
        try {
          await registry.archiveSession(sessionId)
        } catch (error) {
          throw new Error(`session-mail: cannot archive ${sessionId}: ${error?.message ?? error}`)
        }
        return { archived: true, alreadyArchived: false, archivedSessionIds: [...registry.archivedSessionIds] }
      },
    })
  }

  /**
   * Build the `session_unarchive` tool definition: restore one archived session
   * to every workspace list, group, and search. Clearing a hidden id needs no
   * live session, so an archived id whose log is gone is still restorable.
   * @returns a tool definition for the scoped registry.
   */
  function sessionUnarchiveTool() {
    return defineTool({
      name: 'session_unarchive',
      description: 'Restore one archived session by its exact id: the session returns to its workspace list, group, '
        + 'and search. Unarchiving clears a hidden id and restores its recorded position; it restores no deleted log '
        + 'because archiving deleted none. An archived id whose log is gone is still clearable. Idempotent: an id '
        + 'that is not archived reports alreadyActive without writing.',
      parameters: {
        session_id: {
          type: 'string',
          required: true,
          description: 'Exact session id: the full session UUID, never a short or display-truncated form.',
        },
      },
      presentCall: args => ({
        card: 'generic',
        title: `Unarchive session ${shortId(args.session_id)}`,
        kind: 'execute',
      }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            /** Whether this call cleared the id. */
            unarchived: { type: 'boolean', required: true },
            /** Whether the id was already absent, so nothing was written. */
            alreadyActive: { type: 'boolean', required: true },
            /** The archive set as it stands after this call. */
            archivedSessionIds: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.unarchived === true
            ? `session unarchived; the archive now holds ${value.archivedSessionIds.length} session(s)`
            : 'session was not archived: nothing was written'
              + ` (${value.archivedSessionIds.length} session(s) archived)`,
        }],
      },
      async execute(args) {
        const sessionId = typeof args.session_id === 'string' ? args.session_id : ''
        if (!SESSION_ID_PATTERN.test(sessionId)) {
          throw new Error(`session-mail: session_id ${JSON.stringify(args.session_id)} is not a session id — expected `
            + '"session-<8 hex>-<4 hex>-<4 hex>-<4 hex>-<12 hex>". Copy the full id; nothing was unarchived.')
        }
        const registry = workspaceRegistryOf()
        if (registry === undefined) {
          throw new Error('session-mail: the workspace registry is unavailable in this process; nothing was unarchived')
        }
        // The host gained unarchiveSession after the archive tools shipped. An
        // older host must say so instead of reporting a restore that never
        // happened: the archived set would simply stay as it was.
        if (typeof registry.unarchiveSession !== 'function') {
          throw new Error('session-mail: this host build exposes no workspaceRegistry.unarchiveSession, so '
            + `${sessionId} stays archived. Update the harness build before calling session_unarchive.`)
        }
        const archived = [...registry.archivedSessionIds]
        if (!archived.includes(sessionId)) {
          return { unarchived: false, alreadyActive: true, archivedSessionIds: archived }
        }
        try {
          await registry.unarchiveSession(sessionId)
        } catch (error) {
          throw new Error(`session-mail: cannot unarchive ${sessionId}: ${error?.message ?? error}`)
        }
        return { unarchived: true, alreadyActive: false, archivedSessionIds: [...registry.archivedSessionIds] }
      },
    })
  }

  /**
   * Build the `session_archived_list` tool definition: a read-only view of the
   * deployment's archived-session set.
   * @returns a tool definition for the scoped registry.
   */
  function sessionArchivedListTool() {
    return defineTool({
      name: 'session_archived_list',
      description: 'List the sessions this deployment has archived. Read-only: the archive is a global hidden set, '
        + 'and listing it changes nothing.',
      parameters: {},
      presentCall: () => ({ card: 'generic', title: 'List archived sessions', kind: 'read' }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            archivedSessionIds: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.count === 0
            ? '(no archived sessions)'
            : `${value.count} archived session(s):\n${value.archivedSessionIds.join('\n')}`,
        }],
      },
      async execute() {
        const registry = workspaceRegistryOf()
        if (registry === undefined) {
          throw new Error('session-mail: the workspace registry is unavailable in this process')
        }
        const archived = [...registry.archivedSessionIds]
        return { count: archived.length, archivedSessionIds: archived }
      },
    })
  }

  /**
   * Build the `session_create` tool: it creates a peer Session in the caller's
   * repository and records the task-semantic title on it.
   *
   * Moved here from `dsh-session-liveness` so that every model tool this
   * deployment offers is registered by one plugin; the tool name, parameter
   * schema, output schema, call presentation, and rendered text are unchanged,
   * because they are what callers and the model already depend on.
   * @returns the tool definition for a root agent's scoped registry.
   */
  function sessionCreateTool() {
    return defineTool({
      name: 'session_create',
      description: 'Create a peer Session to hand a task to when no existing Session fits. Name it for the task it '
        + 'will receive, then dispatch with mail_send { to_session: "<id>", ... }. The new Session is created in this '
        + 'session\'s repository (and joins this session\'s workspace, so the sidebar lists it there instead of '
        + 'Ungrouped), starts alive in this process, and is addressed by session id (never by role).',
      parameters: {
        title: {
          type: 'string',
          required: true,
          description: 'Task-semantic title for the new Session, in the caller\'s language, e.g. "UI 走查修复" — '
            + 'not "new session". It is written to the Session log, so the sidebar, search, and forks show it.',
        },
        cwd: {
          type: 'string',
          description: 'Directory for the new Session. Defaults to this session\'s directory. A directory inside this '
            + 'session\'s repository is accepted directly; a directory outside it must belong to a registered '
            + 'workspace (register it first with workspace_create), and the Session then joins that workspace.',
        },
        agent_preset: { type: 'string', description: 'Optional agent preset id for the new Session.' },
        groupId: {
          type: 'string',
          description: 'Optional id of an existing session group (a chat group, not a workspace) to join. The group '
            + 'id is the group Session id (session-<uuid>); membership is added, never replaced. When the join does '
            + 'not land, the result says so and the Session still exists.',
        },
      },
      presentCall: args => ({ card: 'generic', title: `Create session · ${args.title}`, kind: 'execute' }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string', required: true },
            title: { type: 'string', required: true },
            titleError: { type: 'string' },
            workspaceId: { type: 'string' },
            groupId: { type: 'string' },
            groupIdError: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `created session ${value.sessionId}`
            + (value.title === '' ? '' : ` titled "${value.title}"`)
            + (value.titleError === undefined || value.titleError === ''
              ? ''
              : ` (title not recorded: ${value.titleError})`)
            + (value.workspaceId === undefined || value.workspaceId === ''
              ? ''
              : ` in workspace ${value.workspaceId}`)
            + (value.groupId === undefined || value.groupId === ''
              ? ''
              : ` and joined group ${value.groupId}`)
            + (value.groupIdError === undefined || value.groupIdError === ''
              ? ''
              : ` (group not joined: ${value.groupIdError})`)
            + `. Dispatch its task with mail_send { to_session: "${value.sessionId}", ... }.`,
        }],
      },
      async execute(args, exec) {
        const controller = controllerOf()
        if (controller === undefined) {
          throw new Error('session_create: the session controller is unavailable in this deployment')
        }
        const callerCwd = exec.agent?.session?.header?.cwd
        if (typeof callerCwd !== 'string' || callerCwd === '') {
          throw new Error('session_create: this session has no working directory to inherit')
        }
        const created = await createSession({
          controller,
          callerCwd,
          title: args.title,
          cwd: args.cwd,
          agentPreset: args.agent_preset,
          registry: workspaceRegistryOf(),
        })
        // The group join runs after creation on purpose: a group that refused or
        // does not exist must not cost the caller the Session it just made.
        return { ...created, ...await joinSessionGroup(ctx.get('sessionGroups'), args.groupId, created.sessionId) }
      },
    })
  }

  /**
   * Build the `workspace_create` tool: it registers the Workspace that owns one
   * existing directory. A Workspace is both the grant that lets `session_create`
   * open a Session outside this repository and the sidebar group those Sessions
   * are listed under, so it is the first half of "create a Workspace, then create
   * a Session in it".
   * @returns the tool definition for a root agent's scoped registry.
   */
  function workspaceCreateTool() {
    return defineTool({
      name: 'workspace_create',
      description: 'Register a Workspace over an existing directory. A Workspace is what lets session_create open a '
        + 'Session outside this repository (an unregistered foreign directory is refused) and what groups those '
        + 'Sessions in the sidebar instead of Ungrouped. Idempotent: a directory a Workspace already owns is '
        + 'resolved, never duplicated, and the title comes from the registry (normally the directory name).',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute path of an existing directory to register as a Workspace.',
        },
      },
      presentCall: args => ({ card: 'generic', title: `Create workspace · ${args.path}`, kind: 'execute' }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            workspaceId: { type: 'string', required: true },
            title: { type: 'string', required: true },
            created: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.created ? 'created' : 'already registered'} workspace ${value.workspaceId}`
            + (value.title === '' ? '' : ` titled "${value.title}"`)
            + '. Create a Session in it with session_create { cwd: "<that directory>" }.',
        }],
      },
      async execute(args) {
        return createWorkspace({ registry: workspaceRegistryOf(), path: args.path })
      },
    })
  }
}
