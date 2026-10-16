import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PRESENCE_DIR, claimPath, markMessageDelivered, presenceIsLive, presencePath, processAlive,
  readArchiveManifest, readClaim, readPresences, removePresence, sweepMailboxState, tryClaimMessage,
  writePresence,
} from '../mailbox.mjs'
import { makeMaildir } from './helpers/fake-host.mjs'

/** A pid that is certainly dead: a child that has already exited. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  assert.equal(child.status, 0)
  assert.equal(typeof child.pid, 'number')
  return child.pid
}

const owner = { pid: process.pid, boot: 'test-boot' }

test('a presence record round-trips with its owning process', async () => {
  const maildir = await makeMaildir()
  await writePresence(maildir, {
    sessionId: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', role: 'repo', cwd: 'C:\\repo', status: 'idle', attachedAt: 1000,
    pid: process.pid, boot: 'test-boot',
  })
  const records = await readPresences(maildir)
  assert.equal(records.length, 1)
  assert.equal(records[0].sessionId, 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1')
  assert.equal(records[0].role, 'repo')
  assert.equal(records[0].pid, process.pid)
  assert.equal(typeof records[0].heartbeat, 'number')
  assert.equal(presenceIsLive(records[0], { presenceTtlMs: 8000 }), true)
})

test('a stale heartbeat or a dead hosting process ends liveness', async () => {
  const fresh = { sessionId: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', pid: process.pid, heartbeat: 1_000 }
  assert.equal(presenceIsLive(fresh, { presenceTtlMs: 8000, now: 5_000 }), true)
  assert.equal(presenceIsLive(fresh, { presenceTtlMs: 8000, now: 20_000 }), false)
  assert.equal(presenceIsLive(fresh, { presenceTtlMs: 8000, now: 5_000, alive: () => false }), false)
  assert.equal(presenceIsLive({ sessionId: 'x' }, { presenceTtlMs: 8000 }), false)
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(deadPid()), false)
})

test('removing a presence record tolerates a session that published none', async () => {
  const maildir = await makeMaildir()
  await removePresence(maildir, 'session-abcdef08-2345-4678-89ab-cdef0123456e')
  await writePresence(maildir, { sessionId: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', role: 'repo', pid: process.pid, boot: 'b' })
  await removePresence(maildir, 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1')
  assert.deepEqual(await readPresences(maildir), [])
})

test('a hostile session id cannot escape the presence directory', async () => {
  const maildir = await makeMaildir()
  const path = presencePath(maildir, '../../escape')
  assert.equal(path.startsWith(join(maildir, PRESENCE_DIR)), true)
  await writePresence(maildir, { sessionId: '../../escape', role: 'repo', pid: process.pid, boot: 'b' })
  const records = await readPresences(maildir)
  assert.equal(records.length, 1)
  assert.equal(records[0].sessionId, '../../escape')
})

test('the sweep retires dead presence, keeps live presence, and archives only expired claims', async () => {
  const maildir = await makeMaildir()
  await writePresence(maildir, { sessionId: 'session-fffffff6-ffff-4fff-8fff-fffffffffff6', role: 'repo', pid: process.pid, boot: 'b' })
  await writePresence(maildir, { sessionId: 'session-abcdef03-2345-4678-89ab-cdef01234569', role: 'repo', pid: deadPid(), boot: 'b' })
  const live = presencePath(maildir, 'session-fffffff6-ffff-4fff-8fff-fffffffffff6')
  const dead = presencePath(maildir, 'session-abcdef03-2345-4678-89ab-cdef01234569')

  const deliveredFresh = claimPath(maildir, 'repo', 'msg-fresh')
  const deliveredOld = claimPath(maildir, 'repo', 'msg-old')
  const pending = claimPath(maildir, 'repo', 'msg-pending')
  const corrupt = claimPath(maildir, 'repo', 'msg-corrupt')
  await mkdir(join(maildir, '.claims', 'repo'), { recursive: true })
  await writeFile(deliveredFresh, `${JSON.stringify({ state: 'delivered', deliveredAt: 10_000 })}\n`, 'utf8')
  await writeFile(deliveredOld, `${JSON.stringify({ state: 'delivered', deliveredAt: 1_000 })}\n`, 'utf8')
  await writeFile(pending, `${JSON.stringify({ state: 'claimed', pid: deadPid(), claimedAt: 1_000 })}\n`, 'utf8')
  await writeFile(corrupt, 'not json\n', 'utf8')
  const lock = `${pending}.takeover`
  await writeFile(lock, '123\n', 'utf8')

  const result = await sweepMailboxState(maildir, {
    presenceTtlMs: 8000, claimRetentionMs: 5000, now: 12_000,
  })

  assert.deepEqual(result, { presence: 1, claims: 2 })
  assert.deepEqual((await readPresences(maildir)).map(record => record.sessionId), ['session-fffffff6-ffff-4fff-8fff-fffffffffff6'])
  assert.equal(await readFile(live, 'utf8').then(() => true), true)
  assert.equal(await readFile(dead, 'utf8').then(() => true, () => false), false)
  assert.equal(await readClaim(maildir, 'repo', 'msg-fresh').then(record => record.state), 'delivered')
  // An expired settlement is archived, not deleted: the decision survives the
  // sweep, so the message can never become claimable again.
  assert.equal(await readFile(deliveredOld, 'utf8').then(() => 'present', () => 'absent'), 'absent')
  assert.equal(await readClaim(maildir, 'repo', 'msg-old').then(record => record.state), 'delivered')
  assert.equal(await readClaim(maildir, 'repo', 'msg-pending').then(record => record.state), 'claimed')
  assert.equal(await readClaim(maildir, 'repo', 'msg-corrupt'), undefined)
  const manifest = await readArchiveManifest(maildir, 'repo')
  assert.deepEqual(manifest.map(entry => [entry.name, entry.state]).sort(), [
    ['msg-corrupt.json', 'unreadable'],
    ['msg-old.json', 'delivered'],
  ])
})

test('one message is claimed once, and a delivered message is never claimed again', async () => {
  const maildir = await makeMaildir()
  const request = { role: 'repo', msgId: 'msg-1', sessionId: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', owner, claimTtlMs: 60_000 }
  assert.equal(await tryClaimMessage(maildir, request), 'mine')
  assert.equal(await tryClaimMessage(maildir, { ...request, owner: { pid: process.pid, boot: 'other' } }), 'held')
  await markMessageDelivered(maildir, request)
  assert.equal(await tryClaimMessage(maildir, { ...request, owner: { pid: process.pid, boot: 'other' } }), 'delivered')
  const record = await readClaim(maildir, 'repo', 'msg-1')
  assert.equal(record.state, 'delivered')
  assert.equal(record.pid, process.pid)
})

test('a claim orphaned by a dead owner is taken over, a live owner keeps it', async () => {
  const maildir = await makeMaildir()
  const path = claimPath(maildir, 'repo', 'msg-2')
  await mkdir(join(maildir, '.claims', 'repo'), { recursive: true })
  await writeFile(path, `${JSON.stringify({ state: 'claimed', pid: deadPid(), claimedAt: 1_000 })}\n`, 'utf8')
  const taken = await tryClaimMessage(maildir, {
    role: 'repo', msgId: 'msg-2', sessionId: 'session-bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2', owner, claimTtlMs: 60_000,
  })
  assert.equal(taken, 'mine')
  assert.equal((await readClaim(maildir, 'repo', 'msg-2')).sessionId, 'session-bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2')

  const livePath = claimPath(maildir, 'repo', 'msg-3')
  await writeFile(livePath, `${JSON.stringify({ state: 'claimed', pid: process.pid, claimedAt: Date.now() })}\n`, 'utf8')
  assert.equal(await tryClaimMessage(maildir, {
    role: 'repo', msgId: 'msg-3', sessionId: 'session-bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2', owner, claimTtlMs: 60_000,
  }), 'held')
})

test('an aged claim held by a live process is taken over after its time-to-live', async () => {
  const maildir = await makeMaildir()
  const path = claimPath(maildir, 'repo', 'msg-4')
  await mkdir(join(maildir, '.claims', 'repo'), { recursive: true })
  await writeFile(path, `${JSON.stringify({ state: 'claimed', pid: process.pid, claimedAt: 1_000 })}\n`, 'utf8')
  assert.equal(await tryClaimMessage(maildir, {
    role: 'repo', msgId: 'msg-4', sessionId: 'session-bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2', owner, claimTtlMs: 500, now: 2_000,
  }), 'mine')
})

test('a fresh takeover lock keeps the message with the process that holds it', async () => {
  const maildir = await makeMaildir()
  const path = claimPath(maildir, 'repo', 'msg-5')
  await mkdir(join(maildir, '.claims', 'repo'), { recursive: true })
  await writeFile(path, `${JSON.stringify({ state: 'claimed', pid: deadPid(), claimedAt: 1_000 })}\n`, 'utf8')
  await writeFile(`${path}.takeover`, '123\n', 'utf8')
  assert.equal(await tryClaimMessage(maildir, {
    role: 'repo', msgId: 'msg-5', sessionId: 'session-bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2', owner, claimTtlMs: 60_000,
  }), 'held')
  assert.equal((await readClaim(maildir, 'repo', 'msg-5')).sessionId, undefined)
})
