import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { appendDirect, appendMessage, readClaim, readPresences } from '../mailbox.mjs'
import { createHost, makeMaildir, waitFor } from './helpers/fake-host.mjs'

const REPO_CWD = 'C:\\repo'
const IDENTITIES = [{ role: 'repo', name: '本仓', cwd: REPO_CWD, inbox: 'to-repo.jsonl' }]

/**
 * Append one addressee-less broadcast line to the role inbox.
 * @param maildir - mailbox directory.
 * @param id - message id.
 */
async function writeBroadcast(maildir, id) {
  await appendMessage(join(maildir, 'to-repo.jsonl'), {
    id, ts: '2026-09-22T09:00:00', from: 'peer', from_session: 'session-11111117-1111-4111-8111-111111111117',
    topic: 'info', body: `broadcast ${id}`,
  })
}

test('two live rostered sessions of one role: the broadcast is claimed and delivered exactly once', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir,
    identities: IDENTITIES,
    agents: [{ id: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', cwd: REPO_CWD }, { id: 'session-bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2', cwd: REPO_CWD }],
  })
  try {
    await writeBroadcast(maildir, 'msg-broadcast')

    // Drain races the same broadcast from both rostered sessions: claims make
    // it one winner, and the loser never sees the message at all.
    const [first, second] = await Promise.all([
      host.agents[0].tools.get('mail_drain').execute({}, { agent: host.agents[0] }),
      host.agents[1].tools.get('mail_drain').execute({}, { agent: host.agents[1] }),
    ])
    const winner = first.count === 1 ? { agent: host.agents[0], result: first } : { agent: host.agents[1], result: second }
    const loser = winner.agent === host.agents[0] ? second : first
    assert.equal(winner.result.count, 1)
    assert.deepEqual(winner.result.messages.map(entry => entry.id), ['msg-broadcast'])
    assert.equal(loser.count, 0)
    assert.equal(loser.messages.length, 0)

    // The claim record proves exactly-once consumption and names the winner.
    const claim = await readClaim(maildir, 'repo', 'msg-broadcast')
    assert.equal(claim.state, 'delivered')
    assert.equal(claim.sessionId, winner.agent.id)

    // The watcher push path agrees: nothing left to deliver, no duplicates.
    host.runPolls()
    assert.equal(host.agents[0].received.length, 0)
    assert.equal(host.agents[1].received.length, 0)
  } finally {
    host.stop()
  }
})

test('the broadcast is claimed once across two dsh processes and delivered to the earliest session', async () => {
  const maildir = await makeMaildir()
  const olderHost = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', cwd: REPO_CWD }] })
  await waitFor(async () => (await readPresences(maildir)).some(record => record.sessionId === 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'))
  await new Promise(resolve => setTimeout(resolve, 20))
  const newerHost = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2', cwd: REPO_CWD }] })
  try {
    await waitFor(async () => (await readPresences(maildir)).some(record => record.sessionId === 'session-bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2'))
    await writeBroadcast(maildir, 'msg-crossproc')

    newerHost.runPolls()
    olderHost.runPolls()
    await waitFor(async () => (await readClaim(maildir, 'repo', 'msg-crossproc'))?.state === 'delivered')
    const claim = await readClaim(maildir, 'repo', 'msg-crossproc')
    assert.equal(claim.sessionId, 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1')
    assert.equal(olderHost.agents[0].received.length, 1)
    assert.equal(newerHost.agents[0].received.length, 0)
  } finally {
    newerHost.stop()
    olderHost.stop()
  }
})

test('a non-rostered session drain never touches the role inbox, and the rostered main still receives the broadcast', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir,
    identities: IDENTITIES,
    agents: [{ id: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', cwd: REPO_CWD }, { id: 'session-9999999f-9999-4999-8999-99999999999f', cwd: REPO_CWD }],
  })
  try {
    // owner.json names session-aaa as the repo roster; the fork is outside it.
    await writeFile(join(maildir, 'owner.json'), `${JSON.stringify({ repo: ['session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'] })}\n`, 'utf8')
    await writeBroadcast(maildir, 'msg-gated')
    await appendDirect(maildir, 'session-9999999f-9999-4999-8999-99999999999f', {
      id: 'msg-named', ts: '2026-09-22T09:00:01', from: 'peer', from_session: 'session-11111117-1111-4111-8111-111111111117',
      topic: 'info', body: 'named mail', to_session: 'session-9999999f-9999-4999-8999-99999999999f',
    })

    // The fork's drain is structurally direct-pool-only: the role inbox is
    // never opened, so the broadcast stays unclaimed and invisible to it.
    const fork = host.agents[1]
    const forkDrain = await fork.tools.get('mail_drain').execute({ backlog: true }, { agent: fork })
    assert.deepEqual(forkDrain.messages.map(entry => entry.id), ['msg-named'])
    assert.equal(await readClaim(maildir, 'repo', 'msg-gated'), undefined)

    // The rostered main consumes the broadcast through the normal claim path.
    const main = host.agents[0]
    const mainDrain = await main.tools.get('mail_drain').execute({}, { agent: main })
    assert.deepEqual(mainDrain.messages.map(entry => entry.id), ['msg-gated'])
    const claim = await readClaim(maildir, 'repo', 'msg-gated')
    assert.equal(claim.state, 'delivered')
    assert.equal(claim.sessionId, 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1')
  } finally {
    host.stop()
  }
})
