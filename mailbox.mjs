/**
 * File store for the directional JSONL session mailbox
 * (`.session-mailbox/PROTOCOL.md` format: one UTF-8 JSON object per line,
 * directional files) plus the two pieces of shared state that make delivery
 * correct across dsh processes sharing one maildir: per-session presence
 * heartbeats (which sessions are live, and in which process) and per-message
 * delivery claims (which process owns delivering one message).
 * @module dsh-session-mail/mailbox
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Directory of live-session heartbeat records, one JSON file per session. */
export const PRESENCE_DIR = '.presence'

/** Directory of message delivery claims, partitioned into one subdirectory per role. */
export const CLAIMS_DIR = '.claims'

/** Directory of per-session direct staging pools, one JSONL file per addressee session. */
export const DIRECT_DIR = 'direct'

/** Claim-role key under which session-addressed (direct-pool) messages are claimed. */
export const DIRECT_CLAIM_ROLE = 'direct'

/** Subdirectory of one role's claim directory holding settled records retention moved aside. */
export const ARCHIVE_DIR = '_archived'

/** Manifest file naming every claim one retention sweep archived, in move order. */
export const ARCHIVE_MANIFEST = 'MANIFEST.jsonl'

/** A takeover lock older than this is broken: only a crashed taker leaves one behind. */
export const TAKEOVER_LOCK_TTL_MS = 30_000

/**
 * Canonical comparison key for a workspace path, on one named platform.
 *
 * The two platforms disagree about what "the same directory" means, so folding
 * one way for both is wrong in one of them:
 *
 * - **win32**: separators are backslashes and the filesystem is
 *   case-insensitive, so `/` is folded to `\` and the whole path is lowercased.
 *   `C:\Repo\` and `c:/repo` name one directory and must compare equal.
 * - **everything else**: separators are forward slashes and the filesystem is
 *   case-sensitive, so case is preserved. `/home/u/Repo` and `/home/u/repo` are
 *   two different directories and must **not** compare equal — folding them
 *   would silently resolve one identity's sessions to another identity's inbox.
 *
 * A trailing separator never distinguishes two paths on either platform.
 *
 * **Do not confuse this with `comparable` in `session-tools.mjs`.** The two apply
 * the same platform rule (lowercase on win32, preserve case elsewhere) but are
 * not interchangeable: this function exists to key `config.identities`, whose
 * `cwd` values are **raw configuration strings** that have not been resolved, so
 * it must also fold separators and a trailing one. `comparable` receives a path
 * already run through `path.resolve()`, so it folds case only. They are
 * deliberately kept apart rather than merged, because collapsing them would mean
 * resolving configuration strings as if they were filesystem paths, which is a
 * behaviour change for every existing `identities` entry. If they are ever
 * unified, the entry point must be this function, which is the more tolerant of
 * the two.
 * @param path - workspace path as configured or as reported by the session header.
 * @param platform - `process.platform` value whose rules to apply.
 * @returns the comparison key for that platform.
 */
export function pathComparisonKey(path, platform) {
  const text = String(path)
  if (platform === 'win32') return text.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return text.replace(/\/+$/, '')
}

/**
 * Canonical comparison key for a workspace path on this platform. Both the
 * configured identity and the session header's cwd are passed through this same
 * function, so a lookup only ever compares like with like.
 * @param path - workspace path as configured or as reported by the session header.
 * @returns the comparison key for this process's platform.
 */
export function normalizePath(path) {
  return pathComparisonKey(path, process.platform)
}

/**
 * Read one inbox file as parsed-line-ready raw lines.
 * @param path - absolute inbox JSONL path.
 * @returns non-empty lines in file order; empty array when the file does not exist yet.
 */
export async function readInboxLines(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    // ENOENT is the normal state of a mailbox before its first message.
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return text
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(line => line.trim().length > 0)
}

/**
 * Append one message as a single JSONL line. Single small appends are atomic
 * on the local filesystem, which the mailbox protocol relies on.
 * @param path - absolute inbox JSONL path.
 * @param message - complete message object.
 */
export async function appendMessage(path, message) {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(message)}\n`, 'utf8')
}

/**
 * Parse one inbox line, rejecting torn or corrupt rows instead of failing the batch.
 * @param line - one raw JSONL line.
 * @returns the message object, or `undefined` when the line is not a usable message.
 */
export function parseMessage(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.id !== 'string' || value.id.length === 0) return undefined
  if (typeof value.topic !== 'string' || value.topic.length === 0) return undefined
  if (typeof value.body !== 'string') return undefined
  return value
}

/** Pad one number to two digits. */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * Local-time timestamp in the protocol's `ts` form.
 * @param date - instant to render; defaults to now.
 * @returns `YYYY-MM-DDTHH:mm:ss` in local time.
 */
export function localTimestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/**
 * One protocol message id: `yyyyMMdd-HHmmss-<8 hex>`. The random tail keeps
 * ids unique across process restarts within the same second.
 * @returns a globally unique id string.
 */
export function nextMessageId() {
  const date = new Date()
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  return `${stamp}-${randomUUID().slice(0, 8)}`
}

/**
 * Read the persisted resolved-prefix watermark of one role: every line before
 * it has already reached its addressee. Older plugin versions advance this file
 * as their own consumed cursor, so reading it keeps a mixed-version pair from
 * redelivering what the other side handled.
 * @param maildir - mailbox directory.
 * @param role - identity role name.
 * @returns the stored watermark, or `undefined` when absent or unusable.
 */
export async function readCursor(maildir, role) {
  try {
    const text = await readFile(join(maildir, `.cursor.${role}.json`), 'utf8')
    const value = JSON.parse(text)
    return typeof value?.cursor === 'number' && Number.isSafeInteger(value.cursor) && value.cursor >= 0
      ? value.cursor
      : undefined
  } catch {
    // Absent file (first observation) and unreadable content (hand-edited)
    // both mean "no trusted cursor"; callers fall back to their init policy.
    return undefined
  }
}

/**
 * Persist the resolved-prefix watermark of one role. Best-effort: a failed
 * write costs at most redelivery of one batch after restart, never message loss.
 * @param maildir - mailbox directory.
 * @param role - identity role name.
 * @param cursor - resolved line count.
 */
export async function writeCursor(maildir, role, cursor) {
  try {
    await writeFile(join(maildir, `.cursor.${role}.json`), `${JSON.stringify({ cursor })}\n`, 'utf8')
  } catch {
    // The in-memory watermark still advances; persistence is a restart convenience.
  }
}

/**
 * Turn one opaque id into a safe single file-name part. Message ids and session
 * ids come from inbox content, which a hand-edited or hostile line controls, so
 * a separator or `..` must never reach the filesystem.
 * @param id - message or session id.
 * @returns a path-safe fragment.
 */
function idToFilePart(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

/**
 * Absolute path of one session's presence record.
 * @param maildir - mailbox directory.
 * @param sessionId - session id as stamped in the envelope.
 * @returns the presence file path.
 */
export function presencePath(maildir, sessionId) {
  return join(maildir, PRESENCE_DIR, `${idToFilePart(sessionId)}.json`)
}

/**
 * Absolute path of one message's claim record.
 * @param maildir - mailbox directory.
 * @param role - role owning the inbox the message arrived in.
 * @param msgId - message id.
 * @returns the claim file path.
 */
export function claimPath(maildir, role, msgId) {
  return join(maildir, CLAIMS_DIR, idToFilePart(role), `${idToFilePart(msgId)}.json`)
}

/**
 * Absolute path of one session's direct staging pool. The session id comes
 * from tool arguments, so it must never reach the filesystem unfiltered.
 * @param maildir - mailbox directory.
 * @param sessionId - addressee session id as stamped in the envelope.
 * @returns the direct-pool JSONL path.
 */
export function directPath(maildir, sessionId) {
  return join(maildir, DIRECT_DIR, `${idToFilePart(sessionId)}.jsonl`)
}

/**
 * Append one session-addressed message to its addressee's direct staging pool.
 * Single small appends are atomic, matching the role-inbox append guarantee.
 * @param maildir - mailbox directory.
 * @param sessionId - addressee session id.
 * @param message - complete message object.
 */
export async function appendDirect(maildir, sessionId, message) {
  await appendMessage(directPath(maildir, sessionId), message)
}

/**
 * Atomically rewrite one session's direct staging pool, keeping only the given
 * raw lines. A temp-file rename makes a concurrent reader in this or another
 * process observe either the previous complete file or the new one.
 * @param maildir - mailbox directory.
 * @param sessionId - addressee session id.
 * @param lines - raw JSONL lines to keep, in file order.
 */
export async function rewriteDirect(maildir, sessionId, lines) {
  const path = directPath(maildir, sessionId)
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8')
  await renameAtomic(temp, path)
}

/**
 * Test whether a process id is alive on this machine. Presence and claim
 * records are only meaningful on the machine that owns the maildir, which the
 * protocol fixes as a local directory.
 * @param pid - process id recorded by a presence or claim record.
 * @returns true when the process exists and is signalable.
 */
export function processAlive(pid) {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM'
  }
}

/**
 * Rename `temp` onto `path`, retrying the transient EPERM Windows reports
 * while another process holds the destination open (every claim write races
 * concurrent readers of the same claim file). The readers hold the handle for
 * microseconds, so a short bounded retry covers the observed contention.
 * @param temp - source path of the completed temp write.
 * @param path - destination path to replace.
 */
async function renameAtomic(temp, path) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, path)
      return
    } catch (error) {
      if (error?.code !== 'EPERM' || attempt >= 10) throw error
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
}

/**
 * Write one JSON record so a reader observes either the previous complete
 * record or the new one, never a partial write.
 * @param path - destination path.
 * @param value - JSON-serializable record.
 */
async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, `${JSON.stringify(value)}\n`, 'utf8')
  await renameAtomic(temp, path)
}

/**
 * Read one JSON record.
 * @param path - record path.
 * @returns the parsed value, or `undefined` when absent or unreadable.
 */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    // Absent, mid-write, or hand-edited content all mean "no usable record";
    // every caller treats that as "retry on the next poll".
    return undefined
  }
}

/**
 * Remove one file, treating absence as success.
 * @param path - file to remove.
 */
async function removeFile(path) {
  try {
    await unlink(path)
  } catch (error) {
    // ENOENT is the normal outcome when another process removed it first.
    if (error?.code !== 'ENOENT') throw error
  }
}

/**
 * Publish or refresh one live-session heartbeat. The record names the process
 * that owns the session, so any dsh process sharing this maildir can tell that
 * the session is live and where its delivery has to happen.
 * @param maildir - mailbox directory.
 * @param entry - sessionId, role, cwd, attachedAt, and the owning pid/boot.
 * @param now - heartbeat instant; defaults to now.
 */
export async function writePresence(maildir, entry, now = Date.now()) {
  await writeJsonAtomic(presencePath(maildir, entry.sessionId), { ...entry, heartbeat: now })
}

/**
 * Read every presence record in the mailbox.
 * @param maildir - mailbox directory.
 * @returns parsed records in directory order; malformed files are skipped.
 */
export async function readPresences(maildir) {
  const dir = join(maildir, PRESENCE_DIR)
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    // ENOENT is the normal state before the first heartbeat.
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const value = await readJson(join(dir, name))
    if (value !== null && typeof value === 'object' && typeof value.sessionId === 'string') records.push(value)
  }
  return records
}

/**
 * Decide whether a presence record still denotes a live session. A fresh
 * heartbeat is the primary signal; a dead pid ends the record immediately
 * instead of waiting out the time-to-live of a killed process.
 * @param record - presence record.
 * @param options - presence time-to-live, clock, and pid probe.
 * @returns true when the record may be treated as a live session.
 */
export function presenceIsLive(record, { presenceTtlMs, now = Date.now(), alive = processAlive }) {
  if (typeof record?.heartbeat !== 'number') return false
  if (now - record.heartbeat > presenceTtlMs) return false
  return alive(record.pid)
}

/**
 * Remove one session's presence record, for a session this process hosted and
 * no longer hosts.
 * @param maildir - mailbox directory.
 * @param sessionId - session id whose record is retired.
 */
export async function removePresence(maildir, sessionId) {
  await removeFile(presencePath(maildir, sessionId))
}

/**
 * Rewrite a stale or orphaned claim under a short-lived lock, so two processes
 * that both find the same dead owner cannot both conclude they own delivery.
 * @param path - claim file path.
 * @param record - replacement claim record owned by this process.
 * @returns `'mine'` when the rewrite succeeded, `'held'` when another taker holds the lock.
 */
async function takeOverClaim(path, record) {
  const lockPath = `${path}.takeover`
  try {
    await writeFile(lockPath, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const lock = await stat(lockPath).catch(() => undefined)
    if (lock === undefined || Date.now() - lock.mtimeMs <= TAKEOVER_LOCK_TTL_MS) return 'held'
    await removeFile(lockPath)
    try {
      await writeFile(lockPath, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' })
    } catch (retryError) {
      // Another process won the broken-lock race; it owns this message now.
      if (retryError?.code === 'EEXIST') return 'held'
      throw retryError
    }
  }
  try {
    // Re-read under the lock: the owner may have finished between our first
    // read and the lock, and its `delivered` record must win over our takeover.
    const latest = await readJson(path)
    if (isTerminalClaimState(latest?.state)) return 'delivered'
    await writeJsonAtomic(path, record)
    return 'mine'
  } finally {
    await removeFile(lockPath)
  }
}

/**
 * Whether one claim state settles a message: no delivery attempt applies again.
 * `delivered` means the message was handed over, `consumed` that a model request
 * answered it, and `failed` that its wake settled without one.
 * @param state - claim state read from the record.
 * @returns true when the message is settled.
 */
export function isTerminalClaimState(state) {
  return state === 'delivered' || state === 'consumed' || state === 'failed'
}

/**
 * The instant one claim record was written for retention purposes.
 * @param record - claim record.
 * @returns the newest known timestamp, or `undefined` when it carries none.
 */
export function claimWrittenAt(record) {
  return record?.consumedAt ?? record?.failedAt ?? record?.deliveredAt ?? record?.claimedAt
}

/**
 * Try to take exclusive delivery rights for one message. The claim file is the
 * mutex: creating it with the `wx` flag succeeds for exactly one process. A
 * claim whose owner died, or whose verification window expired, may be taken
 * over, so a crashed deliverer delays its message instead of losing it.
 * @param maildir - mailbox directory.
 * @param request - role, msgId, addressee session id, owner identity, claim time-to-live, clock.
 * @returns `'mine'` when this process now owns delivery, `'delivered'` when the
 *   message is already settled, `'held'` when another live process owns it.
 */
export async function tryClaimMessage(maildir, request) {
  const { role, msgId, sessionId, owner, claimTtlMs, now = Date.now() } = request
  const path = claimPath(maildir, role, msgId)
  const record = {
    msgId, role, sessionId, pid: owner.pid, boot: owner.boot, state: 'claimed', claimedAt: now,
  }
  await mkdir(dirname(path), { recursive: true })
  // An archived settlement still settles this message: retention moves a record
  // aside, it never reopens a decision, so the claim must be consulted before the
  // exclusive create can mint a fresh one.
  if (await readJson(path) === undefined) {
    const archived = await readArchivedClaim(maildir, role, msgId)
    if (isTerminalClaimState(archived?.state)) return 'delivered'
  }
  try {
    await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' })
    return 'mine'
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const existing = await readJson(path)
  if (isTerminalClaimState(existing?.state)) return 'delivered'
  // An unreadable record is either a concurrent writer or hand-edited content;
  // both resolve on a later poll rather than by guessing ownership now.
  if (existing === undefined) return 'held'
  const age = typeof existing.claimedAt === 'number' ? now - existing.claimedAt : Number.POSITIVE_INFINITY
  if (processAlive(existing.pid) && age <= claimTtlMs) return 'held'
  return await takeOverClaim(path, record)
}

/**
 * Record that one message reached its addressee.
 *
 * A settlement already written for this message wins: the target's first turn can
 * fail before this write lands, and a hand-off record must never reopen what the
 * append-only claim states already decided.
 * @param maildir - mailbox directory.
 * @param request - role, msgId, addressee session id, owner identity, clock.
 */
export async function markMessageDelivered(maildir, request) {
  const { role, msgId, sessionId, owner, now = Date.now() } = request
  const path = claimPath(maildir, role, msgId)
  const existing = await readJson(path)
  if (existing?.state === 'consumed' || existing?.state === 'failed') return
  await writeJsonAtomic(path, {
    msgId,
    role,
    sessionId,
    pid: owner.pid,
    boot: owner.boot,
    state: 'delivered',
    claimedAt: typeof existing?.claimedAt === 'number' ? existing.claimedAt : now,
    ...(typeof existing?.attempts === 'number' ? { attempts: existing.attempts } : {}),
    deliveredAt: now,
  })
}

/**
 * Record that a model request consumed one delivered message: the terminal state
 * that separates a handed-over message from one the addressee actually saw.
 * @param maildir - mailbox directory.
 * @param request - role, msgId, addressee session id, owner identity, clock.
 */
export async function markMessageConsumed(maildir, request) {
  await markMessageSettled(maildir, request, 'consumed', 'consumedAt')
}

/**
 * Record that one delivered message settled without reaching a model, so its
 * sender can be told and the record can be audited.
 * @param maildir - mailbox directory.
 * @param request - role, msgId, addressee session id, owner identity, reason, clock.
 */
export async function markMessageFailed(maildir, request) {
  await markMessageSettled(maildir, request, 'failed', 'failedAt', request.reason)
}

/**
 * Write one terminal claim state, preserving the delivery facts already recorded.
 * @param maildir - mailbox directory.
 * @param request - role, msgId, addressee session id, owner identity, clock.
 * @param state - terminal state to write.
 * @param stampKey - field carrying this state's instant.
 * @param reason - failure detail, for `failed` only.
 */
async function markMessageSettled(maildir, request, state, stampKey, reason) {
  const { role, msgId, sessionId, owner, now = Date.now() } = request
  const path = claimPath(maildir, role, msgId)
  const existing = await readJson(path)
  await writeJsonAtomic(path, {
    msgId,
    role,
    sessionId,
    pid: owner.pid,
    boot: owner.boot,
    state,
    claimedAt: typeof existing?.claimedAt === 'number' ? existing.claimedAt : now,
    ...(typeof existing?.deliveredAt === 'number' ? { deliveredAt: existing.deliveredAt } : {}),
    ...(typeof existing?.attempts === 'number' ? { attempts: existing.attempts } : {}),
    ...(reason === undefined ? {} : { reason }),
    [stampKey]: now,
  })
}

/**
 * Reopen a settled claim this process owns for one bounded redelivery. Another
 * process must not observe a reopened claim as deliverable, so the record keeps
 * this process as its live owner and only the attempt count advances.
 * @param maildir - mailbox directory.
 * @param request - role, msgId, addressee session id, owner identity, clock.
 * @returns true when this process owns the claim and it is open again.
 */
export async function reopenClaim(maildir, request) {
  const { role, msgId, sessionId, owner, now = Date.now() } = request
  const path = claimPath(maildir, role, msgId)
  const existing = await readJson(path)
  if (existing === undefined || existing.pid !== owner.pid || existing.boot !== owner.boot) return false
  await writeJsonAtomic(path, {
    msgId,
    role,
    sessionId,
    pid: owner.pid,
    boot: owner.boot,
    state: 'claimed',
    claimedAt: now,
    attempts: (typeof existing.attempts === 'number' ? existing.attempts : 0) + 1,
  })
  return true
}

/**
 * Read one message's claim record: the active record first, then the archive a
 * retention sweep may have moved it to. A settled claim stays settled for good,
 * so an archived record must still answer this question.
 * @param maildir - mailbox directory.
 * @param role - role owning the inbox.
 * @param msgId - message id.
 * @returns the record, or `undefined` when unclaimed or unreadable.
 */
export async function readClaim(maildir, role, msgId) {
  const active = await readJson(claimPath(maildir, role, msgId))
  return active ?? await readArchivedClaim(maildir, role, msgId)
}

/**
 * Read one message's archived claim record. The lookup is one path built from
 * the message id, never a directory scan.
 * @param maildir - mailbox directory.
 * @param role - role owning the inbox.
 * @param msgId - message id.
 * @returns the archived record, or `undefined` when it was never archived.
 */
export async function readArchivedClaim(maildir, role, msgId) {
  return await readJson(archivedClaimPath(maildir, role, msgId))
}

/**
 * Absolute path of one message's archived claim record.
 * @param maildir - mailbox directory.
 * @param role - role owning the inbox.
 * @param msgId - message id.
 * @returns the archived claim file path.
 */
export function archivedClaimPath(maildir, role, msgId) {
  return join(maildir, CLAIMS_DIR, idToFilePart(role), ARCHIVE_DIR, `${idToFilePart(msgId)}.json`)
}

/**
 * Read the archive manifest of one role: one JSON line per archived claim, in
 * move order, so every archival stays reversible by hand.
 * @param maildir - mailbox directory.
 * @param role - role owning the inbox.
 * @returns the parsed entries; empty when nothing was archived yet.
 */
export async function readArchiveManifest(maildir, role) {
  const path = join(maildir, CLAIMS_DIR, idToFilePart(role), ARCHIVE_DIR, ARCHIVE_MANIFEST)
  const entries = []
  for (const line of await readInboxLines(path)) {
    try {
      entries.push(JSON.parse(line))
    } catch {
      // A torn manifest line names no claim; the archived files themselves stay
      // the record of what was moved.
    }
  }
  return entries
}

/**
 * Move one settled claim out of the active claim directory instead of deleting
 * it, recording the move in the archive manifest. Retention must never reopen a
 * decision, so nothing here is removed and every move is reversible by hand.
 * @param maildir - mailbox directory.
 * @param role - role owning the inbox.
 * @param name - active claim file name.
 * @param now - archival instant; defaults to now.
 * @returns true when the record was archived by this call.
 */
export async function archiveClaim(maildir, role, name, now = Date.now()) {
  const from = join(maildir, CLAIMS_DIR, idToFilePart(role), name)
  const record = await readJson(from)
  if (!await stat(from).then(() => true, () => false)) return false
  const archiveDir = join(maildir, CLAIMS_DIR, idToFilePart(role), ARCHIVE_DIR)
  await mkdir(archiveDir, { recursive: true })
  const to = join(archiveDir, name)
  await renameAtomic(from, to)
  const manifest = JSON.stringify({
    name,
    msgId: record?.msgId,
    role,
    sessionId: record?.sessionId,
    // An unreadable record still leaves the active directory: it can inform no
    // decision, but the manifest names it so nothing is lost silently.
    state: record?.state ?? 'unreadable',
    ...(record?.reason === undefined ? {} : { reason: record.reason }),
    archivedAt: now,
    archivedBy: { pid: process.pid, boot: record?.boot },
  })
  await appendFile(join(archiveDir, ARCHIVE_MANIFEST), `${manifest}\n`, 'utf8')
  return true
}

/**
 * Move aside shared state that can no longer inform a decision: presence records
 * whose owner died or stopped refreshing, settled claims past their retention,
 * and abandoned takeover locks. A settled claim is archived rather than deleted,
 * because deleting it would make its message claimable again; claims still in the
 * `claimed` state are left alone — they are taken over, never swept, so a slow
 * delivery is not silently dropped.
 * @param maildir - mailbox directory.
 * @param options - presence time-to-live, claim retention, clock, and pid probe.
 * @returns counts of removed presence records and archived claim records.
 */
export async function sweepMailboxState(maildir, options) {
  const { presenceTtlMs, claimRetentionMs, now = Date.now(), alive = processAlive } = options
  let presence = 0
  let claims = 0
  const presenceDir = join(maildir, PRESENCE_DIR)
  let presenceNames = []
  try {
    presenceNames = await readdir(presenceDir)
  } catch (error) {
    // ENOENT is the normal state before the first heartbeat.
    if (error?.code !== 'ENOENT') throw error
  }
  for (const name of presenceNames) {
    if (!name.endsWith('.json')) continue
    const path = join(presenceDir, name)
    const record = await readJson(path)
    if (record !== undefined && presenceIsLive(record, { presenceTtlMs, now, alive })) continue
    await removeFile(path)
    presence++
  }
  const claimsRoot = join(maildir, CLAIMS_DIR)
  let roleDirs = []
  try {
    roleDirs = await readdir(claimsRoot)
  } catch (error) {
    // ENOENT is the normal state before the first claim.
    if (error?.code !== 'ENOENT') throw error
  }
  for (const roleDir of roleDirs) {
    const dir = join(claimsRoot, roleDir)
    let names = []
    try {
      names = await readdir(dir)
    } catch (error) {
      // ENOENT means another process removed the whole role directory.
      if (error?.code !== 'ENOENT') throw error
    }
    for (const name of names) {
      const path = join(dir, name)
      if (name.endsWith('.takeover')) {
        const lock = await stat(path).catch(() => undefined)
        if (lock !== undefined && now - lock.mtimeMs > TAKEOVER_LOCK_TTL_MS) {
          await removeFile(path)
        }
        continue
      }
      if (!name.endsWith('.json')) continue
      const record = await readJson(path)
      if (record?.state === 'claimed') continue
      const settledAt = claimWrittenAt(record)
      if (typeof settledAt === 'number' && now - settledAt <= claimRetentionMs) continue
      if (await archiveClaim(maildir, roleDir, name, now)) claims++
    }
  }
  return { presence, claims }
}

/**
 * Read the pending wake requests written before a service restart: each names
 * a session id and the message to deliver to it once the service is back and
 * that session's agent exists again.
 * @param maildir - mailbox directory.
 * @returns the target list, or an empty array when absent, malformed, or
 *   shaped unexpectedly (a stale wake request must never break the plugin).
 */
export async function readWakeRequests(maildir) {
  try {
    const text = await readFile(join(maildir, '.wake.json'), 'utf8')
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || !Array.isArray(value.targets)) return []
    return value.targets.filter(target => target !== null && typeof target === 'object'
      && typeof target.sessionId === 'string' && target.sessionId.length > 0
      && typeof target.message === 'string' && target.message.length > 0)
  } catch {
    // Absent file (the normal steady state) and unreadable content both mean
    // "nothing to wake".
    return []
  }
}

/**
 * Replace the pending wake requests (called after delivering some, to leave
 * only the still-undeliverable ones pending).
 * @param maildir - mailbox directory.
 * @param targets - remaining wake targets.
 * @returns true when the file was written; false when persistence failed, which
 *   the caller reports instead of leaving the failure invisible.
 */
export async function writeWakeRequests(maildir, targets) {
  try {
    const body = `${JSON.stringify({ targets })}\n`
    await writeFile(join(maildir, '.wake.json'), body, 'utf8')
    return true
  } catch {
    // A failed write-back only risks a duplicate wake after the next restart,
    // which a conversational notice tolerates — but never silently.
    return false
  }
}

/**
 * Read the `owner.json` consumer roster (PROTOCOL.md §3.6): per side, the
 * legitimate mainline session ids that may consume that side's inbox.
 * @param maildir - mailbox directory.
 * @returns the parsed roster object, or `undefined` when absent or malformed
 *   (fail open — the roster is a safety belt, the fork-prompt discipline is
 *   the main defense).
 */
export async function readOwnerRoster(maildir) {
  try {
    const text = await readFile(join(maildir, 'owner.json'), 'utf8')
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    // Absent roster (not yet staffed) and unreadable content (mid-write)
    // both mean "no trusted roster"; callers then fail open.
    return undefined
  }
}

/**
 * Await one debounce window.
 * @param ms - non-negative duration.
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Directory of the delivery ledger, one JSONL file per local day. */
export const LEDGER_DIR = '.ledger'

/** Subdirectory of the ledger holding day files a sweep moved aside. */
export const LEDGER_ARCHIVE_DIR = '_archived'

/** Manifest file naming every ledger day file one sweep archived, in move order. */
export const LEDGER_MANIFEST = 'MANIFEST.jsonl'

/** Days whose ledger already emitted its size-cap marker, so it is written once. */
const ledgerCappedDays = new Set()

/**
 * Local calendar day of one instant, in the ledger's file-name form.
 * @param date - instant to render; defaults to now.
 * @returns `YYYY-MM-DD` in local time.
 */
export function ledgerDay(date = new Date()) {
  return localTimestamp(date).slice(0, 10)
}

/**
 * Append one ledger record to its day file. The ledger is a diagnostic surface:
 * a failed append is reported to the caller and dropped rather than raised, and
 * the day file stops at its configured size with one `ledger-capped` marker, so
 * an unbounded day cannot fill the disk.
 * @param maildir - mailbox directory.
 * @param record - the record to append, without a timestamp.
 * @param options - maximum bytes per day (0 disables the cap) and the clock.
 * @returns `'appended'`, `'capped'`, or `'failed'`.
 */
export async function appendLedgerRecord(maildir, record, options = {}) {
  const { maxBytesPerDay = 8 * 1024 * 1024, now = new Date() } = options
  const day = ledgerDay(now)
  try {
    const dir = join(maildir, LEDGER_DIR)
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${day}.jsonl`)
    const line = `${JSON.stringify({ ts: localTimestamp(now), ...record })}\n`
    if (maxBytesPerDay > 0) {
      const size = await stat(path).then(entry => entry.size, () => 0)
      if (size + Buffer.byteLength(line) > maxBytesPerDay) {
        if (!ledgerCappedDays.has(day)) {
          ledgerCappedDays.add(day)
          // The marker is written even when it does not fit: a capped day that
          // said nothing would be indistinguishable from a quiet one. It is one
          // bounded line, written once per day.
          const marker = `${JSON.stringify({
            ts: localTimestamp(now), event: 'ledger-capped', file: `${day}.jsonl`, bytes: size, cap: maxBytesPerDay,
          })}\n`
          await appendFile(path, marker, 'utf8')
        }
        return 'capped'
      }
    }
    await appendFile(path, line, 'utf8')
    return 'appended'
  } catch {
    // The claim record is the authority; bookkeeping never fails a delivery.
    return 'failed'
  }
}

/**
 * Read one ledger day back as parsed records.
 * @param maildir - mailbox directory.
 * @param day - `YYYY-MM-DD`; defaults to today.
 * @returns the parsed records, empty when the day file does not exist.
 */
export async function readLedgerRecords(maildir, day = ledgerDay()) {
  const records = []
  for (const line of await readInboxLines(join(maildir, LEDGER_DIR, `${day}.jsonl`))) {
    try {
      records.push(JSON.parse(line))
    } catch {
      // A torn ledger line is diagnostic noise; the next line still reads.
    }
  }
  return records
}

/**
 * Move ledger day files past their retention into the ledger archive, recording
 * each move in an append-only manifest. Nothing is deleted: a ledger is evidence
 * of what happened, and evidence is archived, never dropped.
 * @param maildir - mailbox directory.
 * @param options - retention age and the clock.
 * @returns the number of day files archived.
 */
export async function sweepLedger(maildir, options = {}) {
  const { retentionMs = 30 * 24 * 60 * 60 * 1000, now = Date.now() } = options
  const dir = join(maildir, LEDGER_DIR)
  let names = []
  try {
    names = await readdir(dir)
  } catch (error) {
    // ENOENT is the normal state before the first ledger record.
    if (error?.code !== 'ENOENT') throw error
    return 0
  }
  let archived = 0
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    const entry = await stat(path).catch(() => undefined)
    if (entry === undefined || now - entry.mtimeMs <= retentionMs) continue
    const archiveDir = join(dir, LEDGER_ARCHIVE_DIR)
    await mkdir(archiveDir, { recursive: true })
    await renameAtomic(path, join(archiveDir, name))
    await appendFile(join(archiveDir, LEDGER_MANIFEST),
      `${JSON.stringify({ name, bytes: entry.size, archivedAt: now })}\n`, 'utf8')
    archived++
  }
  return archived
}
