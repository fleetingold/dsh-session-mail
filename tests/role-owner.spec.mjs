import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendMessage } from '../mailbox.mjs'
import { createHost, makeMaildir, waitFor } from './helpers/fake-host.mjs'

const REPO_CWD = 'C:\\repo'
const IDENTITIES = [{ role: 'repo', name: '本仓', cwd: REPO_CWD, inbox: 'to-repo.jsonl' }]

/**
 * Build one addressee-less (role-addressed) message.
 * @param id - message id.
 * @returns the message object.
 */
function message(id) {
  return {
    id,
    ts: '2026-09-23T11:40:00',
    from: 'peer',
    from_session: 'session-11111117-1111-4111-8111-111111111117',
    topic: 'info',
    body: `body of ${id}`,
  }
}

/**
 * Write the consumer roster the plugin reads on every poll.
 * @param maildir - mailbox directory.
 * @param roster - roster value to persist.
 */
async function writeRoster(maildir, roster) {
  await writeFile(join(maildir, 'owner.json'), JSON.stringify(roster, null, 2), 'utf8')
}

/**
 * Append one role-addressed message and drive the poll until either agent has it.
 * @param maildir - mailbox directory.
 * @param host - fake host driving the plugin.
 * @param msg - message to append.
 * @returns the ids that received the message.
 */
async function deliver(maildir, host, msg) {
  await appendMessage(join(maildir, 'to-repo.jsonl'), msg)
  await waitFor(async () => {
    host.runPolls()
    return host.agents.some(agent => agent.received.length > 0)
  })
  return host.agents.filter(agent => agent.received.length > 0).map(agent => agent.id)
}

test('the roster-designated owner takes role mail instead of the earliest attached session', async () => {
  const maildir = await makeMaildir()
  // 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1' attaches first, so it wins by attach order without a named owner.
  const host = await createHost({
    maildir,
    identities: IDENTITIES,
    agents: [{ id: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', cwd: REPO_CWD }, { id: 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3', cwd: REPO_CWD }],
  })
  try {
    await writeRoster(maildir, {
      main: ['session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3'],
      repo: ['session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3'],
      roleOwners: { repo: 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3' },
    })
    assert.deepEqual(await deliver(maildir, host, message('m1')), ['session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3'])
  } finally {
    host.stop()
  }
})

test('an offline designated owner falls back to the earliest attached session', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir,
    identities: IDENTITIES,
    agents: [{ id: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', cwd: REPO_CWD }],
  })
  try {
    await writeRoster(maildir, {
      repo: ['session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
      roleOwners: { repo: 'session-abcdef05-2345-4678-89ab-cdef0123456b' },
    })
    assert.deepEqual(await deliver(maildir, host, message('m1')), ['session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'])
  } finally {
    host.stop()
  }
})

test('without a named owner role mail still reaches the earliest attached session', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir,
    identities: IDENTITIES,
    agents: [{ id: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', cwd: REPO_CWD }, { id: 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3', cwd: REPO_CWD }],
  })
  try {
    await writeRoster(maildir, { repo: ['session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3'] })
    assert.deepEqual(await deliver(maildir, host, message('m1')), ['session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'])
  } finally {
    host.stop()
  }
})

test('an addressed line still wins over the designated owner', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir,
    identities: IDENTITIES,
    agents: [{ id: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', cwd: REPO_CWD }, { id: 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3', cwd: REPO_CWD }],
  })
  try {
    await writeRoster(maildir, {
      repo: ['session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3'],
      roleOwners: { repo: 'session-ccccccc3-cccc-4ccc-8ccc-ccccccccccc3' },
    })
    const msg = { ...message('m1'), to_session: 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1' }
    assert.deepEqual(await deliver(maildir, host, msg), ['session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'])
  } finally {
    host.stop()
  }
})
