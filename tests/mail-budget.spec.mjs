/**
 * Wake-budget visibility: every `mail_send` this process decides reports the
 * addressee's budget after the decision, and `mail_budget` reads the same
 * counter before a send. Both report only what this process can read — a peer
 * another process hosts, or one that is offline, is reported unknown rather
 * than given a guessed number.
 * @module dsh-session-mail/tests/mail-budget
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writePresence } from '../mailbox.mjs'
import { createHost, makeMaildir } from './helpers/fake-host.mjs'

const REPO_CWD = 'C:\\repo'
const GHOST_CWD = 'C:\\ghost'
const TARGET = 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4'
const SENDER = 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5'
const ABSENT = 'session-5555555b-5555-4555-8555-55555555555b'
const REMOTE = 'session-7777777d-7777-4777-8777-77777777777d'
const IDENTITIES = [
  { role: 'repo', name: '本仓', cwd: REPO_CWD, inbox: 'to-repo.jsonl' },
  { role: 'ghost', name: '空置仓', cwd: GHOST_CWD, inbox: 'to-ghost.jsonl' },
]

/**
 * The reading a session this process hosts must report.
 * @param spent - turns this mailbox opened since the target's last outside input.
 * @param limit - configured consecutive-wake limit.
 * @returns the expected `wakeBudget` object.
 */
function budget(spent, limit) {
  return { spent, limit, refillsOn: 'non-mailbox-input' }
}

/**
 * Build one host with an idle target and a separate sender session.
 * @param config - plugin config overrides.
 * @returns the host, the sender agent, and the target agent.
 */
async function build(config = {}) {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir,
    identities: IDENTITIES,
    agents: [{ id: TARGET, cwd: REPO_CWD }],
    config: { maxConsecutiveWakes: 2, ...config },
  })
  const sender = host.addAgent({ id: SENDER, cwd: REPO_CWD })
  return { host, maildir, sender, target: host.agents[0] }
}

/**
 * Send one point-to-point message to the target.
 * @param sender - sender agent carrying the mailbox tools.
 * @param body - message body.
 * @returns the `mail_send` result.
 */
async function send(sender, body) {
  return await sender.tools.get('mail_send').execute(
    { to_session: TARGET, topic: 'info', body },
    { agent: sender },
  )
}

/**
 * Read peer budget rows.
 * @param sender - sender agent carrying the mailbox tools.
 * @param args - `to` and/or `to_session` scope.
 * @returns the `mail_budget` result.
 */
async function readBudget(sender, args) {
  return await sender.tools.get('mail_budget').execute(args, { agent: sender })
}

/**
 * The model-visible text of one tool result.
 * @param tool - the tool that produced the result.
 * @param value - the result value.
 * @returns the rendered text.
 */
function textOf(tool, value) {
  return tool.output.render({}, value).map(part => part.text).join('\n')
}

test('a receipt carries the budget read after the decision, in both directions', async () => {
  const { host, sender } = await build()
  try {
    const tool = sender.tools.get('mail_send')

    const first = await send(sender, 'first: opens a turn')
    assert.equal(first.woke, true)
    assert.equal(first.mode, 'wakeup')
    assert.deepEqual(first.wakeBudget, budget(1, 2))
    assert.match(textOf(tool, first), /wake budget now 1\/2/)

    const second = await send(sender, 'second: still inside the budget')
    assert.equal(second.woke, true)
    assert.deepEqual(second.wakeBudget, budget(2, 2))

    const third = await send(sender, 'third: budget spent')
    assert.equal(third.delivered, 'injected')
    assert.equal(third.woke, false)
    assert.equal(third.mode, 'inject')
    assert.equal(third.injectReason, 'wake-budget-exhausted')
    assert.deepEqual(third.wakeBudget, budget(2, 2))
    const text = textOf(tool, third)
    assert.match(text, /wake-budget-exhausted/)
    assert.match(text, /wake budget now 2\/2/)
  } finally {
    host.stop()
  }
})

test('mail_budget reads the counter before a send, and reports unknown rather than guessing', async () => {
  const { host, sender, target } = await build()
  try {
    const tool = sender.tools.get('mail_budget')

    // Enough budget: the row is exact, and the caller never reports itself.
    const fresh = await readBudget(sender, { to: 'repo' })
    assert.deepEqual(fresh.peers, [{
      sessionId: TARGET, role: 'repo', status: 'idle', live: 'local', wakeBudget: budget(0, 2),
    }])
    assert.match(textOf(tool, fresh), /repo session-dddd…: wake budget 0\/2 spent; status idle/)

    await send(sender, 'one wake')
    assert.deepEqual((await readBudget(sender, { to_session: TARGET })).peers[0].wakeBudget, budget(1, 2))

    // Budget spent: the reading still names the limit it is spent against.
    await send(sender, 'second wake')
    const spent = await readBudget(sender, { to_session: TARGET })
    assert.deepEqual(spent.peers[0].wakeBudget, budget(2, 2))
    assert.match(textOf(tool, spent), /wake budget 2\/2 spent/)

    // Any outside input refills; this mailbox's own notice must not.
    host.emit('agent/inbox/inserted', { agent: target, message: { source: { kind: 'user' } } })
    assert.deepEqual((await readBudget(sender, { to_session: TARGET })).peers[0].wakeBudget, budget(0, 2))
    await send(sender, 'wake after the refill')
    host.emit('agent/inbox/inserted', {
      agent: target,
      message: { source: { kind: 'plugin', plugin: 'session-mail', form: 'notice' } },
    })
    assert.deepEqual((await readBudget(sender, { to_session: TARGET })).peers[0].wakeBudget, budget(1, 2))

    // A session no process hosts, and a role with no live session, are unknown.
    const absent = await readBudget(sender, { to_session: ABSENT })
    assert.deepEqual(absent.peers, [{
      sessionId: ABSENT, live: 'offline', note: 'no live session to report a wake budget for',
    }])
    assert.match(textOf(tool, absent), /wake budget unknown/)

    const noLiveSession = await readBudget(sender, { to: 'ghost' })
    assert.deepEqual(noLiveSession.peers, [{
      role: 'ghost', live: 'offline', note: 'no live session to report a wake budget for',
    }])
  } finally {
    host.stop()
  }
})

test('a peer another process hosts is unknown in both the reading and the receipt', async () => {
  const { host, maildir, sender } = await build()
  try {
    const tool = sender.tools.get('mail_budget')
    // Fresh presence from a live pid: the session exists, this process just is
    // not the one that can read its budget.
    await writePresence(maildir, {
      sessionId: REMOTE, role: 'repo', cwd: REPO_CWD, status: 'idle',
      attachedAt: Date.now(), pid: process.pid, boot: 'other-process',
    })

    const rows = await readBudget(sender, { to_session: REMOTE })
    assert.deepEqual(rows.peers, [{
      sessionId: REMOTE, role: 'repo', status: 'idle', live: 'remote',
      note: 'owned by the dsh process hosting that session',
    }])
    assert.match(textOf(tool, rows), /wake budget unknown \(owned by the dsh process hosting that session\)/)

    // The relay path decides nothing here, so the receipt must carry no reading.
    const relayed = await sender.tools.get('mail_send').execute(
      { to_session: REMOTE, topic: 'info', body: 'relayed' },
      { agent: sender },
    )
    assert.equal(relayed.delivered, 'relay')
    assert.equal('wakeBudget' in relayed, false)
  } finally {
    host.stop()
  }
})

test('mail_budget refuses a scope it cannot answer instead of returning an empty reading', async () => {
  const { host, sender } = await build()
  try {
    await assert.rejects(readBudget(sender, { to: 'nope' }), /unknown peer role/)
    await assert.rejects(readBudget(sender, { to: 'repo', to_session: TARGET }), /not both/)
    await assert.rejects(readBudget(sender, { to_session: 'session-deadbeef-…' }), /is not a session id/)
  } finally {
    host.stop()
  }
})
