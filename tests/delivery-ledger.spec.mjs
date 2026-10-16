/**
 * F4/F5: every delivery and settlement decision is observable without reading the
 * maildir, and claim retention archives a settled record instead of deleting it,
 * so cleanup can never make a settled message deliverable again.
 * @module dsh-session-mail/tests/delivery-ledger
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARCHIVE_DIR, ARCHIVE_MANIFEST, DIRECT_CLAIM_ROLE, LEDGER_ARCHIVE_DIR, LEDGER_DIR, LEDGER_MANIFEST,
  appendDirect, appendLedgerRecord, appendMessage, archivedClaimPath, claimPath, ledgerDay, markMessageConsumed,
  readArchiveManifest, readClaim, readCursor, readLedgerRecords, sweepLedger, sweepMailboxState, tryClaimMessage,
  writeWakeRequests,
} from '../mailbox.mjs'
import { createHost, makeMaildir, waitFor } from './helpers/fake-host.mjs'

const REPO_CWD = 'C:\\repo'
const TARGET = 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4'
const SENDER = 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5'
const IDENTITIES = [{ role: 'repo', name: '本仓', cwd: REPO_CWD, inbox: 'to-repo.jsonl' }]
const childPath = fileURLToPath(new URL('./helpers/claim-child.mjs', import.meta.url))

/**
 * The message ids one agent received, in delivery order.
 * @param agent - fake agent recording deliveries.
 * @returns the ids parsed out of the delivery frames.
 */
function deliveredIds(agent) {
  return agent.received.map(entry => entry.content[0].text.match(/^Mailbox (\S+)/)[1])
}

/**
 * The parsed `delivery`/`settlement` records one host logged.
 * @param host - fake host driving the plugin.
 * @returns the logged records in order.
 */
function ledger(host) {
  return host.logs
    .map(line => /^session-mail: (\S+) (\{.*\})$/.exec(line))
    .filter(Boolean)
    .map(match => ({ event: match[1], ...JSON.parse(match[2]) }))
}

/**
 * Build one protocol message addressed to a session by id.
 * @param id - message id.
 * @param toSession - addressee session id.
 * @returns the message object.
 */
function message(id, toSession) {
  return {
    id, ts: '2026-09-26T15:00:00', from: 'peer', from_session: SENDER,
    topic: 'info', body: `body of ${id}`, to_session: toSession,
  }
}

test('a wake, an injection, and a settlement each leave one ledger line', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: TARGET, cwd: REPO_CWD }],
    config: { maxConsecutiveWakes: 1 },
  })
  try {
    const sender = host.addAgent({ id: SENDER, cwd: REPO_CWD })
    const tool = sender.tools.get('mail_send')
    const woke = await tool.execute({ to_session: TARGET, topic: 'info', body: 'wake' }, { agent: sender })
    const injected = await tool.execute({ to_session: TARGET, topic: 'info', body: 'second' }, { agent: sender })

    const target = host.agents[0]
    host.emit('agent/inbox/claimed', { agent: target, message: target.received[0], turn: 4 })
    host.emit('agent/assistant-stream', {
      agent: target,
      frame: { type: 'end', attemptId: 'a1', revision: 1, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } },
    })
    await waitFor(async () => (await readClaim(maildir, DIRECT_CLAIM_ROLE, woke.id))?.state === 'consumed')

    const records = ledger(host).filter(record => record.event !== 'goal-disarm-scan')
    assert.deepEqual(records.map(record => record.event), ['delivery', 'delivery', 'settlement'])
    assert.deepEqual(records[0], {
      event: 'delivery', msg: woke.id, to: TARGET, route: DIRECT_CLAIM_ROLE,
      outcome: 'delivered', mode: 'wakeup', woke: true, targetStatus: 'idle',
    })
    assert.equal(records[1].outcome, 'delivered')
    assert.equal(records[1].mode, 'inject')
    assert.equal(records[1].woke, false)
    assert.equal(records[1].injectReason, 'wake-budget-exhausted')
    assert.equal(records[2].claimState, 'consumed')
    assert.equal(records[2].msg, woke.id)
    assert.equal(records[2].turn, 4)
    // The sender learned the same facts from the tool results.
    assert.equal(woke.woke, true)
    assert.equal(injected.delivered, 'injected')

    // The same records are in the maildir ledger, readable with no log sink at
    // all — that file is what an operator opens.
    //
    // The predicate counts only the scenario's own records. Counting the raw file
    // length would let the mount scan's `goal-disarm-scan` line satisfy the wait
    // on its own (it is written at mount, before any of this), and the settlement
    // record — which lands a moment after the claim reaches its terminal state —
    // would then still be in flight when the assertion below reads the file.
    // Reproduced: the assertion saw `['delivery', 'delivery']`.
    const scenarioRecords = async () =>
      (await readLedgerRecords(maildir)).filter(record => record.event !== 'goal-disarm-scan')
    await waitFor(async () => (await scenarioRecords()).length >= 3)
    const fileRecords = await scenarioRecords()
    assert.deepEqual(fileRecords.map(record => record.event), ['delivery', 'delivery', 'settlement'])
    assert.equal(fileRecords[0].msg, woke.id)
    assert.equal(fileRecords[0].outcome, 'delivered')
    assert.equal(fileRecords[0].woke, true)
    assert.equal(fileRecords[1].injectReason, 'wake-budget-exhausted')
    assert.equal(fileRecords[2].claimState, 'consumed')
    assert.equal(typeof fileRecords[0].ts, 'string')
    assert.equal(fileRecords.some(record => JSON.stringify(record).includes('wake me')), false,
      'the ledger must never carry message content')
  } finally {
    host.stop()
  }
})

test('a settled line behind a stalled watermark is not re-recorded on every poll', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: TARGET, cwd: REPO_CWD }] })
  try {
    const target = host.agents[0]
    // The first line names no live addressee, so it never earns a claim and the
    // resolved prefix stops there. The delivered line behind it is then examined
    // again by every poll pass — a non-decision that must leave no ledger record.
    await appendMessage(join(maildir, 'to-repo.jsonl'),
      message('blocker', 'session-abcdef09-2345-4678-89ab-cdef0123456f'))
    await appendMessage(join(maildir, 'to-repo.jsonl'), message('settled', TARGET))
    await waitFor(async () => { host.runPolls(); return target.received.length === 1 })
    await waitFor(async () => (await readClaim(maildir, 'repo', 'settled'))?.state === 'delivered')
    await markMessageConsumed(maildir, {
      role: 'repo', msgId: 'settled', sessionId: TARGET, owner: { pid: process.pid, boot: 'test' },
    })
    // A poll pass must run *after* the line became settled, because that is the
    // pass that observes it as settled and records the skip. The plugin's own
    // timer does not fire under the stand-in host, so asking for a pass is the
    // test's job — relying on the earlier passes to have done it is what made
    // this flaky, and a quiesce on "two reads agree" then hid the gap entirely by
    // settling on two equally early reads.
    //
    // Each attempt asks for one pass and then gives the serialized ledger write
    // time to land; retrying a plain read would not make a pass happen.
    await waitFor(async () => {
      host.runPolls()
      await new Promise(resolve => setTimeout(resolve, 30))
      return (await readLedgerRecords(maildir)).some(record => record.event === 'delivery-skipped')
    }, { intervalMs: 30 })
    // Snapshot the non-skip event count: further passes must add nothing.
    const countEvents = async () => {
      host.runPolls()
      const records = await readLedgerRecords(maildir)
      return records.filter(record => record.event !== 'delivery-skipped').length
    }
    // Then quiesce: the ledger appends behind one promise chain, so wait until two
    // consecutive reads agree before taking the baseline.
    let before = await countEvents()
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 40))
      const again = await countEvents()
      if (again === before) break
      before = again
    }
    assert.ok((await readLedgerRecords(maildir)).some(record => record.event === 'delivery-skipped'))

    for (let pass = 0; pass < 5; pass++) {
      host.runPolls()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(await countEvents(), before,
      'a poll pass that settles nothing new must not append a delivery record')
    assert.equal(target.received.length, 1)
    assert.equal(await readClaim(maildir, 'repo', 'settled').then(record => record.state), 'consumed')
  } finally {
    host.stop()
  }
})

test('an identical decision is recorded once even when it is reported repeatedly', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: TARGET, cwd: REPO_CWD }] })
  try {
    const sender = host.addAgent({ id: SENDER, cwd: REPO_CWD })
    const sent = await sender.tools.get('mail_send').execute(
      { to_session: TARGET, topic: 'info', body: 'once' }, { agent: sender },
    )
    await waitFor(async () => (await readLedgerRecords(maildir)).length === 1)
    const target = host.agents[0]
    for (let repeat = 0; repeat < 3; repeat++) {
      host.emit('agent/inbox/claimed', { agent: target, message: target.received[0], turn: 4 })
      host.emit('agent/assistant-stream', {
        agent: target,
        frame: {
          type: 'end', attemptId: 'a1', revision: 1, index: 2,
          outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 },
        },
      })
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const records = await readLedgerRecords(maildir)
    assert.equal(records.filter(record => record.event === 'delivery').length, 1)
    assert.equal(records.filter(record => record.event === 'settlement' && record.msg === sent.id).length, 1)
  } finally {
    host.stop()
  }
})

test('T-b: a settled line is skipped without re-attempting its claim', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: TARGET, cwd: REPO_CWD }] })
  try {
    const target = host.agents[0]
    // Line 0 names no live session, so the resolved prefix stalls there and the
    // settled line behind it stays above the watermark, examined every pass.
    await appendMessage(join(maildir, 'to-repo.jsonl'),
      message('stall', 'session-abcdef09-2345-4678-89ab-cdef0123456f'))
    await appendMessage(join(maildir, 'to-repo.jsonl'), message('skipped', TARGET))
    await waitFor(async () => { host.runPolls(); return target.received.length === 1 })
    await waitFor(async () => (await readClaim(maildir, 'repo', 'skipped'))?.state === 'delivered')
    await markMessageConsumed(maildir, {
      role: 'repo', msgId: 'skipped', sessionId: TARGET, owner: { pid: process.pid, boot: 'test' },
    })
    for (let pass = 0; pass < 5; pass++) {
      host.runPolls()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    // The skip record is written once per distinct claim state; what must not
    // happen is a new line per poll pass.
    const skips = (await readLedgerRecords(maildir)).filter(record => record.event === 'delivery-skipped')
    assert.ok(skips.length >= 1, 'the skip must be visible in the ledger')
    assert.ok(skips.every(record => record.msg === 'skipped'), JSON.stringify(skips))
    assert.ok(skips.some(record => record.claimState === 'consumed'), JSON.stringify(skips))
    assert.ok(skips.length <= 2, `at most one skip per claim state, saw ${skips.length}`)
    assert.equal(target.received.length, 1)
    const deliveries = (await readLedgerRecords(maildir)).filter(record => record.event === 'delivery')
    assert.equal(deliveries.filter(record => record.msg === 'skipped').length, 1)
  } finally {
    host.stop()
  }
})

test('T-a: a line whose addressee appears later is still delivered', async () => {
  const maildir = await makeMaildir()
  const later = 'session-abcdef08-2345-4678-89ab-cdef0123456e'
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: TARGET, cwd: REPO_CWD }] })
  try {
    // No claim ever exists for this line while its addressee is absent: skipping
    // it would break the promise that an offline addressee is served on its next
    // open, so the skip must apply to settled claims only.
    await appendMessage(join(maildir, 'to-repo.jsonl'), message('later', later))
    host.runPolls()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(await readClaim(maildir, 'repo', 'later'), undefined)

    const arrived = host.addAgent({ id: later, cwd: REPO_CWD })
    await waitFor(async () => { host.runPolls(); return arrived.received.length === 1 })
    await waitFor(async () => (await readClaim(maildir, 'repo', 'later'))?.state === 'delivered')
    assert.deepEqual(deliveredIds(arrived), ['later'])
  } finally {
    host.stop()
  }
})

test('T-c: an unclaimed line still blocks the watermark, a settled line still passes it', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: TARGET, cwd: REPO_CWD }] })
  try {
    const target = host.agents[0]
    await appendMessage(join(maildir, 'to-repo.jsonl'),
      message('unclaimed', 'session-abcdef09-2345-4678-89ab-cdef0123456f'))
    await appendMessage(join(maildir, 'to-repo.jsonl'), message('claimed', TARGET))
    await waitFor(async () => { host.runPolls(); return target.received.length === 1 })
    await waitFor(async () => (await readClaim(maildir, 'repo', 'claimed'))?.state === 'delivered')
    await new Promise(resolve => setTimeout(resolve, 30))
    host.runPolls()
    // The settled line cannot advance the prefix past the unclaimed one.
    assert.equal(await readCursor(maildir, 'repo'), 0)

    // Once the unclaimed line is settled too, the prefix advances over both.
    await markMessageConsumed(maildir, {
      role: 'repo', msgId: 'unclaimed', sessionId: TARGET, owner: { pid: process.pid, boot: 'test' },
    })
    await markMessageConsumed(maildir, {
      role: 'repo', msgId: 'claimed', sessionId: TARGET, owner: { pid: process.pid, boot: 'test' },
    })
    await waitFor(async () => {
      host.runPolls()
      return await readCursor(maildir, 'repo') === 2
    })
    assert.equal(await readCursor(maildir, 'repo'), 2)
  } finally {
    host.stop()
  }
})

test('the ledger caps one day at its byte budget and marks that once', async () => {
  const maildir = await makeMaildir()
  const cap = 300
  const results = []
  for (let index = 0; index < 12; index++) {
    results.push(await appendLedgerRecord(maildir, { event: 'delivery', msg: `m${index}`, to: TARGET },
      { maxBytesPerDay: cap }))
  }
  assert.equal(results[0], 'appended')
  assert.ok(results.includes('capped'), `expected the cap to bind, saw ${JSON.stringify(results)}`)

  const day = ledgerDay()
  const path = join(maildir, LEDGER_DIR, `${day}.jsonl`)
  const text = await readFile(path, 'utf8')
  // The cap bounds the day file; the single marker that announces it is allowed
  // to sit just past the boundary rather than being silently dropped.
  assert.ok(Buffer.byteLength(text) <= cap + 200, `ledger grew past its cap: ${Buffer.byteLength(text)}`)
  assert.equal(text.split('\n').filter(line => line.includes('ledger-capped')).length, 1)
  const capped = await appendLedgerRecord(maildir, { event: 'delivery', msg: 'after-cap', to: TARGET },
    { maxBytesPerDay: cap })
  assert.equal(capped, 'capped')
  assert.equal(await readFile(path, 'utf8'), text, 'a capped day file must stop growing')
  const records = await readLedgerRecords(maildir)
  assert.equal(records.at(-1).event, 'ledger-capped')
  assert.equal(records.at(-1).cap, cap)
  assert.equal(records.at(-1).file, `${day}.jsonl`)
})

test('the ledger sweep archives a day file instead of deleting it', async () => {
  const maildir = await makeMaildir()
  await appendLedgerRecord(maildir, { event: 'delivery', msg: 'old-day', to: TARGET }, {})
  const day = ledgerDay()
  const active = join(maildir, LEDGER_DIR, `${day}.jsonl`)
  const aged = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
  await utimes(active, aged, aged)

  assert.equal(await sweepLedger(maildir, { retentionMs: 24 * 60 * 60 * 1000 }), 1)
  const moved = join(maildir, LEDGER_DIR, LEDGER_ARCHIVE_DIR, `${day}.jsonl`)
  assert.equal(await readFile(moved, 'utf8').then(() => true, () => false), true, 'the day file must survive')
  assert.equal(await readFile(active, 'utf8').then(() => true, () => false), false)
  const manifest = await readFile(join(maildir, LEDGER_DIR, LEDGER_ARCHIVE_DIR, LEDGER_MANIFEST), 'utf8')
  assert.equal(JSON.parse(manifest.trim()).name, `${day}.jsonl`)
  // A fresh day file is left alone.
  await appendLedgerRecord(maildir, { event: 'delivery', msg: 'fresh', to: TARGET }, {})
  assert.equal(await sweepLedger(maildir, { retentionMs: 24 * 60 * 60 * 1000 }), 0)
})

test('a ledger that cannot be written never affects the delivery or the claim', async () => {
  const maildir = await makeMaildir()
  // A file where the ledger directory must be makes every ledger write fail.
  await writeFile(join(maildir, LEDGER_DIR), 'blocked\n', 'utf8')
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: TARGET, cwd: REPO_CWD }] })
  try {
    const sender = host.addAgent({ id: SENDER, cwd: REPO_CWD })
    const sent = await sender.tools.get('mail_send').execute(
      { to_session: TARGET, topic: 'info', body: 'ledger blocked' }, { agent: sender },
    )
    assert.equal(sent.woke, true)
    assert.equal(sent.delivered, 'push')
    assert.equal((await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id)).state, 'delivered')
    await waitFor(() => host.warnings.some(line => line.includes('ledger record')))
  } finally {
    host.stop()
  }
})

test('a failed wake and its reason are both on the ledger', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: TARGET, cwd: REPO_CWD }] })
  try {
    const sender = host.addAgent({ id: SENDER, cwd: REPO_CWD })
    await sender.tools.get('mail_send').execute(
      { to_session: TARGET, topic: 'info', body: 'ledger-body-marker' }, { agent: sender },
    )
    const target = host.agents[0]
    host.emit('agent/inbox/claimed', { agent: target, message: target.received[0], turn: 9 })
    host.emit('agent/error', { agent: target, turn: 9, step: 1, error: { failure: { code: 'QUOTA' } } })
    await waitFor(async () => ledger(host).some(record => record.event === 'settlement'))

    const record = ledger(host).find(entry => entry.event === 'settlement')
    assert.equal(record.claimState, 'failed')
    assert.equal(record.reason, 'QUOTA')
    assert.equal(record.turn, 9)
    // Metadata only: a ledger line never carries message content.
    assert.equal(Object.values(record).some(value => typeof value === 'string' && value.includes('ledger-body-marker')), false)
  } finally {
    host.stop()
  }
})

test('a failed restart-wake write-back is reported, never swallowed', async () => {
  const maildir = await makeMaildir()
  // The parent directory is gone, so the write cannot land.
  const missing = join(maildir, 'gone', 'deeper')
  assert.equal(await writeWakeRequests(missing, [{ sessionId: TARGET, message: 'wake' }]), false)
  assert.equal(await writeWakeRequests(maildir, []), true)
})

test('retention archives a settled claim instead of reopening it', async () => {
  const maildir = await makeMaildir()
  const msgId = 'msg-retained'
  await markMessageConsumed(maildir, {
    role: DIRECT_CLAIM_ROLE, msgId, sessionId: TARGET, owner: { pid: process.pid, boot: 'test' }, now: 1000,
  })
  const active = claimPath(maildir, DIRECT_CLAIM_ROLE, msgId)
  assert.equal((await readClaim(maildir, DIRECT_CLAIM_ROLE, msgId)).state, 'consumed')

  const swept = await sweepMailboxState(maildir, {
    presenceTtlMs: 1000, claimRetentionMs: 10, now: 2000, alive: () => false,
  })
  assert.equal(swept.claims, 1)

  // Archived, not deleted: the decision survives the sweep and stays readable.
  const archived = await readFile(archivedClaimPath(maildir, DIRECT_CLAIM_ROLE, msgId), 'utf8')
  assert.equal(JSON.parse(archived).state, 'consumed')
  assert.deepEqual(await readFile(active, 'utf8').then(() => 'present', () => 'absent'), 'absent')
  assert.equal((await readClaim(maildir, DIRECT_CLAIM_ROLE, msgId)).state, 'consumed')

  const manifest = await readArchiveManifest(maildir, DIRECT_CLAIM_ROLE)
  assert.equal(manifest.length, 1)
  assert.equal(manifest[0].msgId, msgId)
  assert.equal(manifest[0].state, 'consumed')
  assert.equal(typeof manifest[0].archivedAt, 'number')

  // The decisive assertion: cleanup must not turn a settled claim deliverable.
  assert.equal(await tryClaimMessage(maildir, {
    role: DIRECT_CLAIM_ROLE, msgId, sessionId: TARGET, owner: { pid: process.pid, boot: 'next' }, claimTtlMs: 60_000,
  }), 'delivered')
})

test('two drainers racing one settled-then-archived message deliver it at most once', async () => {
  const maildir = await makeMaildir()
  const msgId = 'msg-race-archived'
  await appendDirect(maildir, TARGET, message(msgId, TARGET))
  await markMessageConsumed(maildir, {
    role: DIRECT_CLAIM_ROLE, msgId, sessionId: TARGET, owner: { pid: process.pid, boot: 'test' }, now: 1000,
  })
  await sweepMailboxState(maildir, { presenceTtlMs: 1000, claimRetentionMs: 10, now: 2000, alive: () => false })
  assert.equal((await readClaim(maildir, DIRECT_CLAIM_ROLE, msgId)).state, 'consumed')

  // A second dsh process claims the same message while this one drains it.
  const outFile = join(maildir, 'child.json')
  const childExit = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      childPath, maildir, DIRECT_CLAIM_ROLE, msgId, TARGET, 'claim-and-deliver', outFile,
    ], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: TARGET, cwd: REPO_CWD }] })
  let drain
  try {
    drain = await host.agents[0].tools.get('mail_drain').execute({}, { agent: host.agents[0] })
    assert.equal(await childExit, 0)
  } finally {
    host.stop()
  }

  const child = JSON.parse(await readFile(outFile, 'utf8'))
  assert.equal(child.result, 'delivered', 'the archived settlement must refuse the second claim')
  assert.equal(drain.count, 0, 'the drain must not hand over an already settled message')
  assert.equal((await readClaim(maildir, DIRECT_CLAIM_ROLE, msgId)).state, 'consumed')
})

test('an archived claim leaves the archive manifest on disk for reversal', async () => {
  const maildir = await makeMaildir()
  const msgId = 'msg-manifest'
  await markMessageConsumed(maildir, {
    role: DIRECT_CLAIM_ROLE, msgId, sessionId: TARGET, owner: { pid: process.pid, boot: 'test' }, now: 1000,
  })
  await sweepMailboxState(maildir, { presenceTtlMs: 1000, claimRetentionMs: 10, now: 2000, alive: () => false })
  const manifestPath = join(maildir, '.claims', DIRECT_CLAIM_ROLE, ARCHIVE_DIR, ARCHIVE_MANIFEST)
  const lines = (await readFile(manifestPath, 'utf8')).split('\n').filter(line => line.trim())
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.equal(entry.name, `${msgId}.json`)
  assert.equal(entry.role, DIRECT_CLAIM_ROLE)
  assert.equal(entry.sessionId, TARGET)
  assert.equal(typeof entry.archivedBy.pid, 'number')
  // Writing the manifest cannot be undone by the sweep: archived records are
  // outside the claim directory the sweep walks.
  const again = await sweepMailboxState(maildir, { presenceTtlMs: 1000, claimRetentionMs: 10, now: 3000, alive: () => false })
  assert.equal(again.claims, 0)
})

test('a role inbox line settled and archived still advances the cursor', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: TARGET, cwd: REPO_CWD }] })
  try {
    await writeFile(join(maildir, 'to-repo.jsonl'), `${JSON.stringify(message('cursor-archived', TARGET))}\n`, 'utf8')
    const target = host.agents[0]
    await waitFor(async () => { host.runPolls(); return target.received.length === 1 })
    await markMessageConsumed(maildir, {
      role: 'repo', msgId: 'cursor-archived', sessionId: TARGET, owner: { pid: process.pid, boot: 'test' }, now: 1000,
    })
    await sweepMailboxState(maildir, { presenceTtlMs: 1000, claimRetentionMs: 10, now: 2000, alive: () => false })
    await waitFor(async () => {
      host.runPolls()
      return await readFile(join(maildir, '.cursor.repo.json'), 'utf8').then(() => true, () => false)
    })
    const cursor = JSON.parse(await readFile(join(maildir, '.cursor.repo.json'), 'utf8'))
    assert.equal(cursor.cursor, 1)
    assert.equal(target.received.length, 1)
  } finally {
    host.stop()
  }
})
