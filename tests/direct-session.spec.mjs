import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DIRECT_CLAIM_ROLE, appendDirect, appendMessage, claimPath, directPath, markMessageDelivered, readClaim, readPresences } from '../mailbox.mjs'
import { createHost, makeMaildir, waitFor } from './helpers/fake-host.mjs'

const REPO_CWD = 'C:\\repo'
const OTHER_CWD = 'C:\\other-repo'
const IDENTITIES = [{ role: 'repo', name: '本仓', cwd: REPO_CWD, inbox: 'to-repo.jsonl' }]

/**
 * The message ids one agent received, in delivery order.
 * @param agent - fake agent recording deliveries.
 * @returns the ids parsed out of the delivery frames.
 */
function deliveredIds(agent) {
  return agent.received.map(entry => entry.content[0].text.match(/^Mailbox (\S+)/)[1])
}

test('a to_session send to a locally hosted session is pushed through the direct pool', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD }] })
  try {
    const sender = host.addAgent({ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD })
    const outcome = await sender.tools.get('mail_send').execute(
      { to_session: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', topic: 'info', body: 'anchor: direct push', expect: 'ack' },
      { agent: sender },
    )
    assert.equal(outcome.delivered, 'push')
    assert.deepEqual(deliveredIds(host.agents[0]), [outcome.id])
    assert.equal((await readClaim(maildir, DIRECT_CLAIM_ROLE, outcome.id)).state, 'delivered')

    // The pool line is consumption bookkeeping, not pending mail: the watcher
    // sweep removes it and the target receives nothing more.
    host.runPolls()
    await waitFor(async () => (await readClaim(maildir, DIRECT_CLAIM_ROLE, outcome.id)).state === 'delivered')
    assert.equal(host.agents[0].received.length, 1)
  } finally {
    host.stop()
  }
})

test('a send to an offline session id stages in its pool and delivers when the session opens', async () => {
  const maildir = await makeMaildir()
  // Revival is on by default; this case pins the opt-out path, where an offline
  // addressee waits in its pool instead of being revived by the sender.
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }],
    config: { activateOnSend: false },
  })
  try {
    const sender = host.agents[0]
    const outcome = await sender.tools.get('mail_send').execute(
      { to_session: 'session-5555555b-5555-4555-8555-55555555555b', topic: 'info', body: 'anchor: staged mail' },
      { agent: sender },
    )
    assert.equal(outcome.delivered, 'mailbox')
    assert.deepEqual(deliveredIds(sender), [])

    host.addAgent({ id: 'session-5555555b-5555-4555-8555-55555555555b', cwd: OTHER_CWD })
    host.runPolls()
    await waitFor(() => host.agents.some(agent => deliveredIds(agent).length === 1))
    // The frame reaches the agent before the claim write lands, so the record is
    // awaited rather than read on the delivery observation's heels.
    await waitFor(async () => (await readClaim(maildir, DIRECT_CLAIM_ROLE, outcome.id))?.state === 'delivered')
  } finally {
    host.stop()
  }
})

test('a send to a session live in another dsh process is relayed through its direct pool', async () => {
  const maildir = await makeMaildir()
  const targetHost = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-33333339-3333-4333-8333-333333333339', cwd: OTHER_CWD }] })
  const senderHost = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }] })
  try {
    await waitFor(async () => (await readPresences(maildir)).some(record => record.sessionId === 'session-33333339-3333-4333-8333-333333333339'))
    const sender = senderHost.agents[0]
    const outcome = await sender.tools.get('mail_send').execute(
      { to_session: 'session-33333339-3333-4333-8333-333333333339', topic: 'info', body: 'anchor: cross-process direct' },
      { agent: sender },
    )
    assert.equal(outcome.delivered, 'relay')
    senderHost.runPolls()
    targetHost.runPolls()
    await waitFor(() => targetHost.agents[0].received.length === 1)
    assert.deepEqual(deliveredIds(targetHost.agents[0]), [outcome.id])
    // The frame reaches the agent before the claim write lands, so the record is
    // awaited rather than read on the delivery observation's heels.
    await waitFor(async () => (await readClaim(maildir, DIRECT_CLAIM_ROLE, outcome.id))?.state === 'delivered')
  } finally {
    senderHost.stop()
    targetHost.stop()
  }
})

test('a fork drains only its point-to-point mail and never the role broadcast', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir,
    identities: IDENTITIES,
    agents: [{ id: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', cwd: REPO_CWD }, { id: 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3', cwd: REPO_CWD }],
  })
  try {
    // Broadcast without an addressee: belongs to the role's earliest live session.
    await appendMessage(join(maildir, 'to-repo.jsonl'), {
      id: 'msg-broadcast', ts: '2026-09-21T12:00:00', from: 'peer', from_session: 'session-11111117-1111-4111-8111-111111111117',
      topic: 'info', body: 'role broadcast',
    })
    // Point-to-point mail staged for the fork.
    await appendDirect(maildir, 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3', {
      id: 'msg-named', ts: '2026-09-21T12:00:01', from: 'peer', from_session: 'session-11111117-1111-4111-8111-111111111117',
      topic: 'info', body: 'named mail', to_session: 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3',
    })

    const fork = host.agents[1]
    const forkDrain = await fork.tools.get('mail_drain').execute({}, { agent: fork })
    assert.deepEqual(forkDrain.messages.map(entry => entry.id), ['msg-named'])
    assert.equal((await readClaim(maildir, DIRECT_CLAIM_ROLE, 'msg-named')).state, 'delivered')

    // The fork's send works without consuming the role inbox.
    const sent = await fork.tools.get('mail_send').execute(
      { to_session: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', topic: 'info', body: 'anchor: fork upstream' },
      { agent: fork },
    )
    assert.equal(sent.delivered, 'push')

    const main = host.agents[0]
    // The fork's point-to-point send was pushed immediately (claim delivered),
    // so it reached main's transcript and is not pending in any drain.
    assert.deepEqual(deliveredIds(main), [sent.id])
    const mainDrain = await main.tools.get('mail_drain').execute({}, { agent: main })
    assert.deepEqual(mainDrain.messages.map(entry => entry.id), ['msg-broadcast'])
  } finally {
    host.stop()
  }
})

test('a session without a mailbox identity drains its direct pool without error', async () => {
  const maildir = await makeMaildir()
  // Opt out of revival: this case asserts the staged outcome of a session-id send.
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-8888888e-8888-4888-8888-88888888888e', cwd: OTHER_CWD }],
    config: { activateOnSend: false },
  })
  try {
    await appendDirect(maildir, 'session-8888888e-8888-4888-8888-88888888888e', {
      id: 'msg-newrepo', ts: '2026-09-21T12:00:00', from: 'peer', from_session: 'session-11111117-1111-4111-8111-111111111117',
      topic: 'info', body: 'new-repo mail', to_session: 'session-8888888e-8888-4888-8888-88888888888e',
    })
    // Role broadcast parked in the identity's inbox must stay invisible to the
    // identity-less session: its drain never reads a role inbox.
    await appendMessage(join(maildir, 'to-repo.jsonl'), {
      id: 'msg-broadcast', ts: '2026-09-21T12:00:01', from: 'peer', from_session: 'session-11111117-1111-4111-8111-111111111117',
      topic: 'info', body: 'role broadcast',
    })
    const agent = host.agents[0]
    // The lightweight tool pair is injected without any identity binding.
    assert.equal(typeof agent.tools.get('mail_send'), 'object')
    assert.equal(typeof agent.tools.get('mail_drain'), 'object')
    const drain = await agent.tools.get('mail_drain').execute({}, { agent })
    assert.deepEqual(drain.messages.map(entry => entry.id), ['msg-newrepo'])
    assert.equal(drain.held, 0)

    // Role addressing is refused; session-id addressing is free.
    await assert.rejects(
      () => agent.tools.get('mail_send').execute(
        { to: 'repo', topic: 'info', body: 'anchor: no broadcast right' }, { agent },
      ),
      /to_session/,
    )
    const sent = await agent.tools.get('mail_send').execute(
      { to_session: 'session-11111117-1111-4111-8111-111111111117', topic: 'info', body: 'anchor: send free' },
      { agent },
    )
    assert.equal(sent.delivered, 'mailbox')
  } finally {
    host.stop()
  }
})

test('a delivered direct claim is never delivered again', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD }] })
  try {
    await appendDirect(maildir, 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', {
      id: 'msg-done', ts: '2026-09-21T12:00:00', from: 'peer', from_session: 'session-11111117-1111-4111-8111-111111111117',
      topic: 'info', body: 'already delivered', to_session: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4',
    })
    await markMessageDelivered(maildir, { role: DIRECT_CLAIM_ROLE, msgId: 'msg-done', sessionId: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', owner: { pid: process.pid, boot: 'other' } })

    host.runPolls()
    assert.equal(host.agents[0].received.length, 0)

    const agent = host.agents[0]
    const first = await agent.tools.get('mail_drain').execute({ backlog: true }, { agent })
    assert.deepEqual(first.messages.map(entry => entry.id), ['msg-done'])
    const second = await agent.tools.get('mail_drain').execute({}, { agent })
    assert.equal(second.count, 0)
    assert.equal(await readClaim(maildir, DIRECT_CLAIM_ROLE, 'msg-done').then(record => record.state), 'delivered')
    assert.equal(claimPath(maildir, DIRECT_CLAIM_ROLE, 'msg-done').includes('direct'), true)
  } finally {
    host.stop()
  }
})

test('a hostile to_session cannot escape the direct directory', async () => {
  const maildir = await makeMaildir()
  assert.equal(directPath(maildir, '../../escape').startsWith(join(maildir, 'direct')), true)
})
