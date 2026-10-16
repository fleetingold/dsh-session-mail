import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writePresence } from '../mailbox.mjs'
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

/** Start a process that stays alive, for a presence record owned elsewhere. */
async function liveStranger() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise((resolve) => { child.once('spawn', resolve) })
  return child
}

test('a to_session send to an addressee offline everywhere revives it here and pushes', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }] })
  try {
    const sender = host.agents[0]
    const outcome = await sender.tools.get('mail_send').execute(
      { to_session: 'session-4444444a-4444-4444-8444-44444444444a', topic: 'task', body: 'anchor: revive the addressee' },
      { agent: sender },
    )
    assert.equal(outcome.delivered, 'push')
    assert.equal(outcome.activated, true)
    const target = host.agents.find(agent => agent.id === 'session-4444444a-4444-4444-8444-44444444444a')
    assert.ok(target, 'the addressee session was materialized in this process')
    // The revived session went through the ordinary open path, so it carries the
    // whole tool set this plugin registers — the six mailbox/archive tools plus
    // the two session-creation tools the migration moved here from the liveness
    // plugin. Pinning all eight here is what makes this the revived-path check
    // for the migration: a tool that only attached on the initial mount would
    // show up missing on a session opened later.
    assert.deepEqual([...target.tools.keys()].sort(),
      ['mail_budget', 'mail_drain', 'mail_send', 'session_archive', 'session_archived_list',
        'session_create', 'session_unarchive', 'workspace_create'])
    assert.deepEqual(deliveredIds(target), [outcome.id])
  } finally {
    host.stop()
  }
})

test('activateOnSend=false keeps the staged mailbox path', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }],
    config: { activateOnSend: false },
  })
  try {
    const sender = host.agents[0]
    const outcome = await sender.tools.get('mail_send').execute(
      { to_session: 'session-4444444a-4444-4444-8444-44444444444a', topic: 'task', body: 'anchor: stay staged' },
      { agent: sender },
    )
    assert.equal(outcome.delivered, 'mailbox')
    assert.equal(outcome.activated, false)
    assert.equal(host.agents.some(agent => agent.id === 'session-4444444a-4444-4444-8444-44444444444a'), false)
  } finally {
    host.stop()
  }
})

test('an addressee live in another dsh process is relayed, never revived here', async () => {
  const maildir = await makeMaildir()
  const stranger = await liveStranger()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }] })
  try {
    await writePresence(maildir, { sessionId: 'session-33333339-3333-4333-8333-333333333339', pid: stranger.pid, status: 'idle' })
    const sender = host.agents[0]
    const outcome = await sender.tools.get('mail_send').execute(
      { to_session: 'session-33333339-3333-4333-8333-333333333339', topic: 'task', body: 'anchor: relay' },
      { agent: sender },
    )
    assert.equal(outcome.delivered, 'relay')
    assert.equal(outcome.activated, false)
    assert.equal(host.agents.some(agent => agent.id === 'session-33333339-3333-4333-8333-333333333339'), false)
  } finally {
    host.stop()
    stranger.kill()
  }
})

test('a refused revival keeps the message staged and reports the reason', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }],
    sessionController: {
      async setHeld() { throw new Error('session/agent-busy: held by another harness process') },
    },
  })
  try {
    const sender = host.agents[0]
    const tool = sender.tools.get('mail_send')
    const outcome = await tool.execute(
      { to_session: 'session-abcdef07-2345-4678-89ab-cdef0123456d', topic: 'task', body: 'anchor: refused' },
      { agent: sender },
    )
    assert.equal(outcome.delivered, 'mailbox')
    assert.equal(outcome.activated, false)
    assert.match(outcome.activationError, /agent-busy/)
    // The model-visible account names the failure instead of implying delivery.
    const text = tool.output.render({}, outcome).map(part => part.text).join('\n')
    assert.match(text, /reviving it here failed: .*agent-busy/)
  } finally {
    host.stop()
  }
})

test('a deployment without a Session Controller leaves the message staged', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }],
    sessionController: false,
  })
  try {
    const sender = host.agents[0]
    const outcome = await sender.tools.get('mail_send').execute(
      { to_session: 'session-4444444a-4444-4444-8444-44444444444a', topic: 'task', body: 'anchor: no controller' },
      { agent: sender },
    )
    assert.equal(outcome.delivered, 'mailbox')
    assert.equal(outcome.activated, false)
    // Existence cannot be verified without the controller, so the message stages
    // and the refusal names that reason instead of reporting nothing at all.
    assert.equal(outcome.activationError, 'no-session-controller')
  } finally {
    host.stop()
  }
})

test('the role route reports activated=false alongside its own delivered state', async () => {
  const maildir = await makeMaildir()
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: REPO_CWD }] })
  try {
    const sender = host.agents[0]
    const outcome = await sender.tools.get('mail_send').execute(
      { to: 'repo', topic: 'info', body: 'anchor: role route' },
      { agent: sender },
    )
    // Role addressing keeps its own semantics: the sender is the role's only
    // live session, so it owns the line, and revival is never a role-route step.
    assert.equal(outcome.delivered, 'push')
    assert.equal(outcome.activated, false)
  } finally {
    host.stop()
  }
})
