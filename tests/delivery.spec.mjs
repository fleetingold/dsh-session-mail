import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { appendMessage, readClaim, readCursor, readPresences, writeCursor } from '../mailbox.mjs'
import { createHost, makeMaildir, waitFor } from './helpers/fake-host.mjs'

const REPO_CWD = 'C:\\repo'
const IDENTITIES = [{ role: 'repo', name: '本仓', cwd: REPO_CWD, inbox: 'to-repo.jsonl' }]

/**
 * Build one protocol message.
 * @param id - message id.
 * @param toSession - addressee session id; omit for a pre-v2 envelope.
 * @returns the message object.
 */
function message(id, toSession) {
  return {
    id,
    ts: '2026-09-18T16:00:00',
    from: 'peer',
    from_session: 'session-11111117-1111-4111-8111-111111111117',
    topic: 'info',
    body: `body of ${id}`,
    ...(toSession === undefined ? {} : { to_session: toSession }),
  }
}

/**
 * Append messages to the role's inbox in order.
 * @param maildir - mailbox directory.
 * @param messages - messages to append.
 */
async function writeInbox(maildir, messages) {
  for (const msg of messages) await appendMessage(join(maildir, 'to-repo.jsonl'), msg)
}

/**
 * The message ids one agent received, in delivery order.
 * @param agent - fake agent recording deliveries.
 * @returns the ids parsed out of the delivery frames.
 */
function deliveredIds(agent) {
  return agent.received.map(entry => entry.content[0].text.match(/^Mailbox (\S+)/)[1])
}

test('a message for a session in another dsh process is relayed and delivered there', async () => {
  const maildir = await makeMaildir()
  const targetHost = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: REPO_CWD }] })
  const senderHost = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }] })
  try {
    const target = targetHost.agents[0]
    const sender = senderHost.agents[0]
    await waitFor(async () => (await readPresences(maildir)).some(record => record.sessionId === 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4'))

    const outcome = await sender.tools.get('mail_send').execute(
      { to: 'repo', topic: 'info', body: 'anchor: commit deadbeef', to_session: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', expect: 'ack' },
      { agent: sender },
    )
    assert.equal(outcome.delivered, 'relay')

    // The sender process owns no delivery for that line, so only the hosting
    // process moves it — and it moves on its own next poll.
    senderHost.runPolls()
    targetHost.runPolls()
    await waitFor(() => target.received.length === 1)
    assert.deepEqual(deliveredIds(target), [outcome.id])
    // The frame the peer receives must carry the producer-owned source kind:
    // session format v4 refuses the retired `plugin` wrapper at admission, and
    // the platform's own V3-to-V4 migration names this producer
    // `plugin:session-mail` (the `producerKind()` fallback), so both paths must
    // agree on that one identity.
    assert.equal(target.received[0].source.kind, 'plugin:session-mail')
    assert.equal(target.received[0].source.plugin, 'session-mail')
    assert.equal(target.received[0].source.form, 'notice')
    assert.equal(sender.received.length, 0)
    // The delivered claim is written after the delivery lands, so await the
    // claim state itself instead of asserting it behind a receipt race.
    await waitFor(async () => (await readClaim(maildir, 'repo', outcome.id))?.state === 'delivered')
    assert.equal((await readClaim(maildir, 'repo', outcome.id)).state, 'delivered')
  } finally {
    senderHost.stop()
    targetHost.stop()
  }
})

test('a line for an offline session does not hold back the lines behind it', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-fffffff6-ffff-4fff-8fff-fffffffffff6', cwd: REPO_CWD }] })
  try {
    await writeInbox(maildir, [
      message('msg-offline', 'session-6666666c-6666-4666-8666-66666666666c'),
      message('msg-live-1', 'session-fffffff6-ffff-4fff-8fff-fffffffffff6'),
      message('msg-live-2', 'session-fffffff6-ffff-4fff-8fff-fffffffffff6'),
    ])
    host.runPolls()
    await waitFor(() => host.agents[0].received.length === 2)
    assert.deepEqual(deliveredIds(host.agents[0]), ['msg-live-1', 'msg-live-2'])
    assert.equal(await readClaim(maildir, 'repo', 'msg-offline'), undefined)
  } finally {
    host.stop()
  }
})

test('a watermark left by an older plugin version suppresses the lines it consumed', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-fffffff6-ffff-4fff-8fff-fffffffffff6', cwd: REPO_CWD }] })
  try {
    await writeInbox(maildir, [
      message('msg-a', 'session-fffffff6-ffff-4fff-8fff-fffffffffff6'),
      message('msg-b', 'session-fffffff6-ffff-4fff-8fff-fffffffffff6'),
      message('msg-c', 'session-fffffff6-ffff-4fff-8fff-fffffffffff6'),
    ])
    await writeCursor(maildir, 'repo', 2)

    host.runPolls()
    await waitFor(() => host.agents[0].received.length === 1)
    assert.deepEqual(deliveredIds(host.agents[0]), ['msg-c'])
    await waitFor(async () => (await readCursor(maildir, 'repo')) === 3)
  } finally {
    host.stop()
  }
})

test('drain returns what this session owns and never what another session owns', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-fffffff6-ffff-4fff-8fff-fffffffffff6', cwd: REPO_CWD }] })
  try {
    await writeInbox(maildir, [
      message('msg-mine', 'session-fffffff6-ffff-4fff-8fff-fffffffffff6'),
      message('msg-other', 'session-abcdef06-2345-4678-89ab-cdef0123456c'),
    ])
    const live = host.agents[0]
    const drain = live.tools.get('mail_drain')

    const first = await drain.execute({}, { agent: live })
    assert.equal(first.count, 1)
    assert.equal(first.held, 1)
    assert.deepEqual(first.messages.map(entry => entry.id), ['msg-mine'])
    assert.equal((await readClaim(maildir, 'repo', 'msg-mine')).state, 'delivered')

    const second = await drain.execute({}, { agent: live })
    assert.equal(second.count, 0)
    assert.equal(second.held, 1)

    const backlog = await drain.execute({ backlog: true }, { agent: live })
    assert.equal(backlog.count, 1)
    assert.deepEqual(backlog.messages.map(entry => entry.id), ['msg-mine'])
  } finally {
    host.stop()
  }
})

test('an envelope without an addressee belongs to the earliest live session, in either process', async () => {
  const maildir = await makeMaildir()
  const olderHost = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', cwd: REPO_CWD }] })
  await waitFor(async () => (await readPresences(maildir)).some(record => record.sessionId === 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'))
  await new Promise(resolve => setTimeout(resolve, 20))
  const newerHost = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3', cwd: REPO_CWD }] })
  try {
    await waitFor(async () => (await readPresences(maildir)).some(record => record.sessionId === 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3'))
    await writeInbox(maildir, [message('msg-legacy')])

    // The later process polls first: it must defer to the earlier session.
    newerHost.runPolls()
    olderHost.runPolls()
    await waitFor(() => olderHost.agents[0].received.length === 1)
    assert.deepEqual(deliveredIds(olderHost.agents[0]), ['msg-legacy'])
    assert.equal(newerHost.agents[0].received.length, 0)
    assert.equal((await readClaim(maildir, 'repo', 'msg-legacy')).sessionId, 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1')
  } finally {
    newerHost.stop()
    olderHost.stop()
  }
})

test('mail already in the file when the plugin mounts waits for an explicit drain', async () => {
  const maildir = await makeMaildir()
  await writeInbox(maildir, [message('msg-old-1', 'session-fffffff6-ffff-4fff-8fff-fffffffffff6'), message('msg-old-2', 'session-fffffff6-ffff-4fff-8fff-fffffffffff6')])
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-fffffff6-ffff-4fff-8fff-fffffffffff6', cwd: REPO_CWD }], config: { catchUpOnStart: false },
  })
  try {
    host.runPolls()
    await waitFor(async () => (await readCursor(maildir, 'repo')) === 2)
    assert.equal(host.agents[0].received.length, 0)

    const drained = await host.agents[0].tools.get('mail_drain').execute({ backlog: true }, { agent: host.agents[0] })
    assert.deepEqual(drained.messages.map(entry => entry.id), ['msg-old-1', 'msg-old-2'])
  } finally {
    host.stop()
  }
})
