import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { appendMessage } from '../mailbox.mjs'
import { createHost, makeMaildir, waitFor } from './helpers/fake-host.mjs'

const REPO_CWD = 'C:\\repo'
const IDENTITIES = [{ role: 'repo', name: '本仓', cwd: REPO_CWD, inbox: 'to-repo.jsonl' }]

/**
 * Build one protocol message addressed to a session by id.
 * @param id - message id.
 * @param toSession - addressee session id.
 * @returns the message object.
 */
function message(id, toSession) {
  return {
    id,
    ts: '2026-09-23T10:00:00',
    from: 'peer',
    from_session: 'session-11111117-1111-4111-8111-111111111117',
    topic: 'info',
    body: `body of ${id}`,
    to_session: toSession,
  }
}

/**
 * Record how each delivery reached one agent: a wakeup turn or an injection.
 * @param agent - fake agent recording deliveries.
 * @returns the appended mode list, in delivery order.
 */
function recordModes(agent) {
  const modes = []
  const followup = agent.followup.bind(agent)
  const inject = agent.inject.bind(agent)
  agent.followup = (msg) => {
    modes.push('wakeup')
    followup(msg)
  }
  agent.inject = (msg) => {
    modes.push('inject')
    inject(msg)
  }
  return modes
}

/**
 * Append one message and drive the poll until the agent has received it.
 * @param maildir - mailbox directory.
 * @param host - fake host driving the plugin.
 * @param agent - target agent stand-in.
 * @param msg - message to append.
 */
async function deliver(maildir, host, agent, msg) {
  const before = agent.received.length
  await appendMessage(join(maildir, 'to-repo.jsonl'), msg)
  await waitFor(async () => {
    host.runPolls()
    return agent.received.length > before
  })
}

test('an outside inbox insertion resets the wake budget so later mail wakes again', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir,
    identities: IDENTITIES,
    agents: [{ id: 'session-22222228-2222-4222-8222-222222222228', cwd: REPO_CWD }],
    config: { maxConsecutiveWakes: 2 },
  })
  try {
    const agent = host.agents[0]
    const modes = recordModes(agent)

    // Budget 2: the first two notices open turns, the third degrades to injection.
    await deliver(maildir, host, agent, message('m1', 'session-22222228-2222-4222-8222-222222222228'))
    await deliver(maildir, host, agent, message('m2', 'session-22222228-2222-4222-8222-222222222228'))
    await deliver(maildir, host, agent, message('m3', 'session-22222228-2222-4222-8222-222222222228'))
    assert.deepEqual(modes, ['wakeup', 'wakeup', 'inject'])

    // A human prompt (any non-mailbox insertion) resets the budget for this agent.
    host.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' } } })

    await deliver(maildir, host, agent, message('m4', 'session-22222228-2222-4222-8222-222222222228'))
    assert.equal(modes[3], 'wakeup')
  } finally {
    host.stop()
  }
})

test('this mailbox\'s own notices never reset the wake budget', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir,
    identities: IDENTITIES,
    agents: [{ id: 'session-22222228-2222-4222-8222-222222222228', cwd: REPO_CWD }],
    config: { maxConsecutiveWakes: 2 },
  })
  try {
    const agent = host.agents[0]
    const modes = recordModes(agent)

    await deliver(maildir, host, agent, message('m1', 'session-22222228-2222-4222-8222-222222222228'))
    await deliver(maildir, host, agent, message('m2', 'session-22222228-2222-4222-8222-222222222228'))

    // An insertion carrying this plugin's own notice source must not re-arm the
    // budget, otherwise the self-excitation guard would never bind. Both shapes
    // count: the retired `plugin` wrapper still present in v3-era logs, and the
    // canonical `plugin:session-mail` producer kind this plugin now emits and
    // the platform's V3-to-V4 migration writes for its historical notices.
    host.emit('agent/inbox/inserted', {
      agent,
      message: { source: { kind: 'plugin', plugin: 'session-mail', form: 'notice' } },
    })
    host.emit('agent/inbox/inserted', {
      agent,
      message: { source: { kind: 'plugin:session-mail', plugin: 'session-mail', form: 'notice' } },
    })

    await deliver(maildir, host, agent, message('m3', 'session-22222228-2222-4222-8222-222222222228'))
    assert.equal(modes[2], 'inject')
  } finally {
    host.stop()
  }
})
