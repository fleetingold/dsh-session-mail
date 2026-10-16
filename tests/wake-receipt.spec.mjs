/**
 * F1: the `mail_send` receipt must distinguish a real wakeup turn from an
 * injection that will never start one. A delivery that hands the message to an
 * idle agent without opening a turn is reported as `injected`, never `push`.
 * @module dsh-session-mail/tests/wake-receipt
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DIRECT_CLAIM_ROLE, directPath, readClaim, readInboxLines } from '../mailbox.mjs'
import { createHost, makeMaildir } from './helpers/fake-host.mjs'

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

test('an idle target out of wake budget is reported as injected, never push', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD }],
    config: { maxConsecutiveWakes: 1 },
  })
  try {
    const sender = host.addAgent({ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD })
    const target = host.agents[0]

    const woke = await send(sender, 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', 'first: opens a turn')
    assert.equal(woke.delivered, 'push')
    assert.equal(woke.woke, true)
    assert.equal(woke.mode, 'wakeup')

    const injected = await send(sender, 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', 'second: budget spent')
    assert.equal(injected.delivered, 'injected')
    assert.equal(injected.woke, false)
    assert.equal(injected.mode, 'inject')
    assert.equal(injected.injectReason, 'wake-budget-exhausted')
    assert.ok(host.warnings.some(line => line.includes('wake budget exhausted')),
      `expected a warning naming the exhausted budget, saw ${JSON.stringify(host.warnings)}`)

    // Both messages reached the inbox: the second one is queued, not lost, and
    // the receipt is what tells the sender no turn was opened for it.
    assert.deepEqual(deliveredIds(target), [woke.id, injected.id])
  } finally {
    host.stop()
  }
})

test('a running target receives a next-step injection and is reported as push', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD, status: 'running' }],
  })
  try {
    const sender = host.addAgent({ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD })
    const outcome = await send(sender, 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', 'steer into the running turn')
    assert.equal(outcome.delivered, 'push')
    assert.equal(outcome.woke, false)
    assert.equal(outcome.mode, 'inject')
    assert.equal(outcome.injectReason, 'target-running')
    assert.equal(host.warnings.length, 0)
  } finally {
    host.stop()
  }
})

test('a quiet deployment reports injected rather than claiming a wake', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD }],
    config: { delivery: 'quiet' },
  })
  try {
    const sender = host.addAgent({ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD })
    const outcome = await send(sender, 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', 'quiet mode')
    assert.equal(outcome.delivered, 'injected')
    assert.equal(outcome.woke, false)
    assert.equal(outcome.injectReason, 'delivery-quiet')
  } finally {
    host.stop()
  }
})

test('a failed hand-off reports the claim outcome instead of push', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    // The target must be running: an idle target with wake budget left takes the
    // followup path, so stubbing `inject` alone would never reach the failure.
    maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD, status: 'running' }],
  })
  try {
    const sender = host.addAgent({ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD })
    host.agents[0].inject = () => { throw new Error('inbox unavailable') }

    const outcome = await send(sender, 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', 'hand-off throws')
    assert.equal(outcome.delivered, 'mailbox')
    assert.equal(outcome.woke, false)
    assert.equal(outcome.failure, 'injection-failed')
    assert.equal((await readClaim(maildir, DIRECT_CLAIM_ROLE, outcome.id)).state, 'claimed')
  } finally {
    host.stop()
  }
})

test('T2: a to_session that is not a session id is refused before anything is staged', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }] })
  try {
    const sender = host.agents[0]
    // Four shapes a caller might plausibly produce, each refused by shape: a short
    // name, an eight-hex name, a seven-segment id, and a display-truncated one. The
    // identifiers are synthetic, and were checked against this machine's real
    // Session ids (and every truncation of them) before being used here.
    const malformed = [
      'session-0f0f0f0f',
      'session-feedface',
      'session-0f0f0f0-1a2b-4c3d-9e8f-0a1b2c3d4e5f',
      'session-feedface-…',
    ]
    for (const toSession of malformed) {
      await assert.rejects(
        send(sender, toSession, `body for ${toSession}`),
        /is not a session id/,
        `expected ${toSession} to be refused by shape`,
      )
      assert.equal((await readInboxLines(directPath(maildir, toSession))).length, 0,
        `expected no pool file for ${toSession}`)
    }
  } finally {
    host.stop()
  }
})

test('T3: a well-formed id that names no session is refused instead of staged', async () => {
  const maildir = await makeMaildir()
  const ghost = 'session-abcdef11-2345-4678-89ab-cdef01234571'
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }],
    sessionController: {
      async setHeld({ sessionId }) {
        const error = new Error(`session "${sessionId}" not found`)
        error.code = 'session/not-found'
        throw error
      },
    },
  })
  try {
    const sender = host.agents[0]
    await assert.rejects(send(sender, ghost, 'ghost addressee'), /names no session/)
    assert.equal((await readInboxLines(directPath(maildir, ghost))).length, 0)
  } finally {
    host.stop()
  }
})

test('a well-formed unknown id is still staged when existence cannot be verified', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }],
    sessionController: false,
  })
  try {
    const sender = host.agents[0]
    const outcome = await send(sender, 'session-5555555b-5555-4555-8555-55555555555b', 'stage without verification')
    assert.equal(outcome.delivered, 'mailbox')
    assert.equal(outcome.activationError, 'no-session-controller')
    assert.equal((await readInboxLines(directPath(maildir, 'session-5555555b-5555-4555-8555-55555555555b'))).length, 1)
  } finally {
    host.stop()
  }
})

test('T5: the disabled-activation probe still verifies existence and releases its hold', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }],
    config: { activateOnSend: false },
  })
  try {
    const sender = host.agents[0]
    const outcome = await send(sender, 'session-6666666c-6666-4666-8666-66666666666c', 'probe then stage')
    assert.equal(outcome.delivered, 'mailbox')
    assert.equal(outcome.activationError, 'activation-disabled')
    // The probe acquired a hold it did not keep: activation stays off.
    assert.equal(host.agents.some(agent => agent.id === 'session-6666666c-6666-4666-8666-66666666666c'), false)
    assert.equal((await readInboxLines(directPath(maildir, 'session-6666666c-6666-4666-8666-66666666666c'))).length, 1)
  } finally {
    host.stop()
  }
})
