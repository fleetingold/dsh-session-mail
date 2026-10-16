/**
 * F1b: a delivered message is only settled once its wake is decided. A committed
 * model response consumes it, a retryable provider failure redelivers it once at
 * the next idle, and a terminal failure records the reason and tells the sender.
 * @module dsh-session-mail/tests/wake-consumption
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DIRECT_CLAIM_ROLE, appendMessage, directPath, markMessageFailed, readClaim, readCursor, readInboxLines } from '../mailbox.mjs'
import { createHost, makeMaildir, waitFor } from './helpers/fake-host.mjs'

const REPO_CWD = 'C:\\repo'
const IDENTITIES = [{ role: 'repo', name: '本仓', cwd: REPO_CWD, inbox: 'to-repo.jsonl' }]

/**
 * The message ids one agent received, in delivery order.
 * @param agent - fake agent recording deliveries.
 * @returns the ids parsed out of the delivery frames.
 */
function deliveredIds(agent) {
  return agent.received.map(entry => entry.content[0].text.match(/^Mailbox (\S+)/)[1])
}

/**
 * Build one protocol message addressed to a session by id.
 * @param id - message id.
 * @param toSession - addressee session id.
 * @returns the message object.
 */
function message(id, toSession) {
  return {
    id,
    ts: '2026-09-26T10:00:00',
    from: 'peer',
    from_session: 'session-11111117-1111-4111-8111-111111111117',
    topic: 'info',
    body: `body of ${id}`,
    to_session: toSession,
  }
}

/**
 * Send one point-to-point message from the sender session.
 * @param sender - fake sender agent carrying the mailbox tools.
 * @param toSession - addressee session id.
 * @param body - message body.
 * @returns the tool result.
 */
async function send(sender, toSession, body) {
  return await sender.tools.get('mail_send').execute(
    { to_session: toSession, topic: 'info', body },
    { agent: sender },
  )
}

/**
 * Bind the delivered wake to a turn, the way the loop reports its claim.
 * @param host - fake host driving the plugin.
 * @param agent - the woken session.
 * @param turn - turn number to bind.
 */
function bindTurn(host, agent, turn) {
  host.emit('agent/inbox/claimed', { agent, message: agent.received.at(-1), turn })
}

/**
 * Report one committed model response for the woken session.
 * @param host - fake host driving the plugin.
 * @param agent - the woken session.
 */
function commitResponse(host, agent) {
  host.emit('agent/assistant-stream', {
    agent,
    frame: {
      type: 'end',
      attemptId: 'attempt-1',
      revision: 1,
      index: 4,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 12 },
    },
  })
}

/**
 * Report one failed model request for the woken session.
 * @param host - fake host driving the plugin.
 * @param agent - the woken session.
 * @param code - provider failure code.
 * @param turn - the turn that failed, matching the bound claim.
 */
function reportFailure(host, agent, code, turn) {
  host.emit('agent/error', {
    agent,
    turn,
    step: 1,
    error: { failure: { code, message: `provider said ${code}` } },
  })
}

test('T7 regression: a settled message left behind the cursor still advances it', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-7777777d-7777-4777-8777-77777777777d', cwd: REPO_CWD }] })
  try {
    const agent = host.agents[0]
    await appendMessage(join(maildir, 'to-repo.jsonl'), message('cursor-1', 'session-7777777d-7777-4777-8777-77777777777d'))
    // The race this pins: a wake settles without a model answer while the
    // resolved prefix is still behind its line. A watermark that only accepts
    // `delivered` stops there for good, so `consumed` and `failed` must resolve
    // the prefix too — the mixed-version cursor file is written from it.
    await markMessageFailed(maildir, {
      role: 'repo', msgId: 'cursor-1', sessionId: 'session-7777777d-7777-4777-8777-77777777777d',
      owner: { pid: process.pid, boot: 'test' }, reason: 'QUOTA',
    })
    await waitFor(async () => {
      host.runPolls()
      return await readCursor(maildir, 'repo') === 1
    })
    assert.equal(await readCursor(maildir, 'repo'), 1)
    // The settled message is not handed over a second time.
    assert.equal(agent.received.length, 0)
  } finally {
    host.stop()
  }
})

test('a committed model response consumes the wake and stops tracking it', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD }] })
  try {
    const sender = host.addAgent({ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD })
    const target = host.agents[0]
    const sent = await send(sender, 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', 'wake me')
    assert.equal(sent.woke, true)

    bindTurn(host, target, 4)
    commitResponse(host, target)
    await waitFor(async () => (await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id))?.state === 'consumed')

    const claim = await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id)
    assert.equal(claim.state, 'consumed')
    assert.equal(typeof claim.consumedAt, 'number')
    assert.deepEqual(deliveredIds(target), [sent.id])
  } finally {
    host.stop()
  }
})

test('a quota failure is recorded and receipted to the sender, never redelivered', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD }],
    config: { maxRedeliveries: 1 },
  })
  try {
    const sender = host.addAgent({ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD })
    const target = host.agents[0]
    const sent = await send(sender, 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', 'wake into a quota wall')

    bindTurn(host, target, 5)
    reportFailure(host, target, 'QUOTA', 5)
    await waitFor(async () => (await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id))?.state === 'failed')

    const claim = await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id)
    assert.equal(claim.reason, 'QUOTA')
    // A terminal provider failure is reported, not retried against the same wall.
    assert.deepEqual(deliveredIds(target), [sent.id])

    // The receipt is appended by the same settlement, so await its arrival rather
    // than reading the pool on the claim write's heels.
    await waitFor(async () => (await readInboxLines(directPath(maildir, 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5'))).length === 1)
    const receiptLines = await readInboxLines(directPath(maildir, 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5'))
    assert.equal(receiptLines.length, 1)
    const receipt = JSON.parse(receiptLines[0])
    assert.equal(receipt.topic, 'delivery-failed')
    assert.equal(receipt.receipt, true)
    assert.match(receipt.body, new RegExp(sent.id))
    // The receipt reaching the sender's staging pool and the sender receiving it
    // are two different steps: `deliveredIds` reads what was actually delivered
    // into the session, which the delivery step fills afterwards. Waiting for the
    // pool above does not imply this, so wait for this too — the assertion still
    // fails if the receipt never arrives.
    await waitFor(() => deliveredIds(sender).length === 1)
    assert.deepEqual(deliveredIds(sender), [receipt.id])
  } finally {
    host.stop()
  }
})

test('a retryable provider failure redelivers once, then settles as failed', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD }],
    config: { maxRedeliveries: 1 },
  })
  try {
    const sender = host.addAgent({ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD })
    const target = host.agents[0]
    const sent = await send(sender, 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', 'wake into a transient wall')

    bindTurn(host, target, 6)
    reportFailure(host, target, 'SERVER', 6)
    await waitFor(() => target.received.length === 2)
    // The reopened claim is delivered again under the same message id.
    assert.equal(deliveredIds(target)[1], sent.id)
    await waitFor(async () => {
      const claim = await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id)
      return claim?.state === 'delivered' && claim.attempts === 1
    })

    bindTurn(host, target, 7)
    reportFailure(host, target, 'SERVER', 7)
    await waitFor(async () => (await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id))?.state === 'failed')
    assert.equal((await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id)).reason, 'SERVER')
    assert.equal(target.received.length, 2)
  } finally {
    host.stop()
  }
})

test('a turn that ends without a response settles without redelivery or receipt', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD }] })
  try {
    const sender = host.addAgent({ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD })
    const target = host.agents[0]
    const sent = await send(sender, 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', 'wake then abort')

    bindTurn(host, target, 8)
    // An aborted turn reports no agent/error: only the return to idle.
    host.emit('agent/status', { agent: target, status: 'idle' })
    await waitFor(async () => (await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id))?.state === 'failed')

    const claim = await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id)
    assert.equal(claim.reason, 'turn-ended-without-response')
    assert.deepEqual(deliveredIds(target), [sent.id])
    assert.equal((await readInboxLines(directPath(maildir, 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5'))).length, 0)
  } finally {
    host.stop()
  }
})

test('T7b: an undecided wake extends its window while the turn is still running', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD }],
    config: { wakeWindowMs: 30, wakeWindowExtensions: 5 },
  })
  try {
    const sender = host.addAgent({ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD })
    const target = host.agents[0]
    const sent = await send(sender, 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', 'slow turn')
    // The turn is still working: a slow multi-step turn must not be reported as
    // a dead wake, however many windows it outlasts within the extension cap.
    target.status = 'running'
    const extended = () => host.warnings.filter(line => line.includes('settlement window extended')).length
    await waitFor(() => extended() >= 2)
    assert.equal((await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id))?.state, 'delivered')
    assert.equal((await readInboxLines(directPath(maildir, 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5'))).length, 0)

    // Once it stops running without ever answering, the window decides and the
    // sender hears about it.
    target.status = 'idle'
    await waitFor(async () => (await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id))?.state === 'failed')
    assert.equal((await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id)).reason, 'consumption-window-expired')
    assert.equal((await readInboxLines(directPath(maildir, 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5'))).length, 1)
  } finally {
    host.stop()
  }
})

test('T7b cap: a turn still running at the hard cap reports why it could not be trusted', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD }],
    config: { wakeWindowMs: 30, wakeWindowExtensions: 0 },
  })
  try {
    const sender = host.addAgent({ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD })
    const target = host.agents[0]
    const sent = await send(sender, 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', 'stuck while running')
    target.status = 'running'
    await waitFor(async () => (await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id))?.state === 'failed')

    // "Running and never answering" is distinguishable from "never started".
    assert.equal((await readClaim(maildir, DIRECT_CLAIM_ROLE, sent.id)).reason,
      'consumption-window-expired-while-running')
    assert.equal((await readInboxLines(directPath(maildir, 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5'))).length, 1)
  } finally {
    host.stop()
  }
})
