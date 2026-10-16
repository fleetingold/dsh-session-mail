/**
 * A-plugin / A-plugin+: a goal that is still `active` while its automatic
 * continuation is disarmed sends exactly one `goal-disarmed` notice to the goal
 * role's designated owner — both on the activation edge and in the mount scan that
 * catches the state a restart leaves behind.
 * @module dsh-session-mail/tests/goal-disarm-notice
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { directPath, readInboxLines } from '../mailbox.mjs'
import { createHost, makeMaildir, waitFor } from './helpers/fake-host.mjs'

const REPO_CWD = 'C:\\repo'
const REPO_ROLE = 'repo'
const OWNER = 'session-fffffff6-ffff-4fff-8fff-fffffffffff6'
const WORKER = 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4'
const IDENTITIES = [{ role: REPO_ROLE, name: '本仓', cwd: REPO_CWD, inbox: 'to-repo.jsonl' }]

/** A goal view in the state a restart leaves behind: active but disarmed. */
function goalView(overrides = {}) {
  return {
    id: 'goal-1', revision: 3, objective: 'finish the migration', phase: 'active',
    maxGoalRounds: 12, roundsStarted: 4, activation: 'disarmed', createdAt: 1, updatedAt: 2,
    ...overrides,
  }
}

/**
 * Write the owner roster that designates the notice recipient.
 * @param maildir - mailbox directory.
 * @param roleOwner - session id the role's broadcast mail belongs to.
 */
async function writeRoster(maildir, roleOwner) {
  await writeFile(join(maildir, 'owner.json'),
    `${JSON.stringify({ schema: 'test', roleOwners: { [REPO_ROLE]: roleOwner } })}\n`, 'utf8')
}

/**
 * The `goal-disarmed` notices a session received.
 * @param maildir - mailbox directory.
 * @param sessionId - addressee session id.
 * @returns the parsed notices.
 */
async function noticesFor(maildir, sessionId) {
  return (await readInboxLines(directPath(maildir, sessionId)))
    .map(line => JSON.parse(line))
    .filter(message => message.topic === 'goal-disarmed')
}

/**
 * Wait until the mount scan has recorded its trace, which is the point after
 * which its decision is final — a fixed sleep would race a loaded machine.
 * @param host - fake host driving the plugin.
 * @returns the scan trace line.
 */
async function waitForScan(host) {
  return await waitFor(() => host.logs.find(line => line.includes('goal-disarm-scan')), { timeoutMs: 15_000 })
}

test('the mount scan announces an active goal that a restart left disarmed', async () => {
  const maildir = await makeMaildir()
  await writeRoster(maildir, OWNER)
  const host = await createHost({
    maildir, identities: IDENTITIES,
    agents: [{ id: WORKER, cwd: REPO_CWD }, { id: OWNER, cwd: REPO_CWD }],
    goals: { get: agent => (agent.id === WORKER ? goalView() : undefined) },
  })
  try {
    const owner = host.agents[1]
    await waitFor(async () => (await noticesFor(maildir, OWNER)).length === 1, { timeoutMs: 15_000 })
    const [notice] = await noticesFor(maildir, OWNER)
    assert.equal(notice.to_session, OWNER)
    assert.equal(notice.from_session, WORKER)
    assert.match(notice.body, /goal-1/)
    assert.match(notice.body, /active/)
    assert.match(notice.body, /rounds started 4 of 12/)
    assert.match(notice.body, /继续/)
    // The recipient is a live session, so the notice is pushed here as well.
    await waitFor(() => owner.received.some(message => message.content[0].text.includes('goal-disarmed')))
    // Every scan leaves a trace, and the trace names what it did.
    const scan = await waitForScan(host)
    assert.match(scan, /"attempted":2/)
    assert.match(scan, /"foundActiveDisarmed":1/)
    assert.match(scan, /"sent":1/)
  } finally {
    host.stop()
  }
})

test('a second session-open scan does not announce the same disarm twice', async () => {
  const maildir = await makeMaildir()
  await writeRoster(maildir, OWNER)
  const host = await createHost({
    maildir, identities: IDENTITIES,
    agents: [{ id: WORKER, cwd: REPO_CWD }, { id: OWNER, cwd: REPO_CWD }],
    goals: { get: agent => (agent.id === WORKER ? goalView() : undefined) },
  })
  try {
    await waitForScan(host)
    await waitFor(async () => (await noticesFor(maildir, OWNER)).length === 1, { timeoutMs: 15_000 })
    host.addAgent({ id: 'session-abcdef01-2345-4678-89ab-cdef01234567', cwd: REPO_CWD })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal((await noticesFor(maildir, OWNER)).length, 1)
    // The goal service was already up, so the extra session open is not a rescan.
    const scans = host.logs.filter(line => line.includes('goal-disarm-scan'))
    assert.equal(scans.length, 1)
  } finally {
    host.stop()
  }
})

test('the activation edge announces a disarm while the goal stays active', async () => {
  const maildir = await makeMaildir()
  await writeRoster(maildir, OWNER)
  // The service view flips with the edge; at mount it still reads armed.
  let current = goalView({ activation: 'armed' })
  const host = await createHost({
    maildir, identities: IDENTITIES,
    agents: [{ id: WORKER, cwd: REPO_CWD }, { id: OWNER, cwd: REPO_CWD }],
    goals: { get: agent => (agent.id === WORKER ? current : undefined) },
  })
  try {
    await waitForScan(host)
    assert.equal((await noticesFor(maildir, OWNER)).length, 0)

    // The edge: the process-local activation changes to disarmed.
    current = goalView({ activation: 'disarmed' })
    host.emit('goal/activation-changed', {
      sessionId: WORKER, goal: { id: 'goal-1', revision: 3, activation: 'disarmed' },
    })
    await waitFor(async () => (await noticesFor(maildir, OWNER)).length === 1, { timeoutMs: 15_000 })
    const [notice] = await noticesFor(maildir, OWNER)
    assert.match(notice.body, /自动续跑|继续/)
    // The notice count turning one and the edge's own trace are two different
    // moments, and the notice comes first: delivery writes the message into the
    // direct pool, and only then does the handler's `.then` record
    // `goal-disarm-edge`. So reading the log synchronously here raced the write
    // and failed on a loaded machine (reproduced: 200ms of further waiting always
    // produced the line). Wait for the trace instead of assuming it already
    // landed — the assertion still fails if the edge never records one.
    assert.ok(
      await waitFor(() => host.logs.find(line => line.includes('goal-disarm-edge')), { timeoutMs: 15_000 }),
      JSON.stringify(host.logs),
    )

    // A repeat of the same edge stays a single notice.
    host.emit('goal/activation-changed', {
      sessionId: WORKER, goal: { id: 'goal-1', revision: 3, activation: 'disarmed' },
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal((await noticesFor(maildir, OWNER)).length, 1)
  } finally {
    host.stop()
  }
})

test('no notice when the goal is armed, absent, not active, or the owner is itself', async () => {
  const cases = [
    { name: 'armed', view: goalView({ activation: 'armed' }), owner: OWNER },
    { name: 'paused', view: goalView({ phase: 'paused' }), owner: OWNER },
    { name: 'no goal', view: undefined, owner: OWNER },
    { name: 'owner is the session itself', view: goalView(), owner: WORKER },
  ]
  for (const testCase of cases) {
    const maildir = await makeMaildir()
    await writeRoster(maildir, testCase.owner)
    const host = await createHost({
      maildir, identities: IDENTITIES,
      agents: [{ id: WORKER, cwd: REPO_CWD }, { id: OWNER, cwd: REPO_CWD }],
      goals: { get: agent => (agent.id === WORKER ? testCase.view : undefined) },
    })
    try {
      await waitForScan(host)
      const recipients = [OWNER, WORKER]
      for (const recipient of recipients) {
        assert.equal((await noticesFor(maildir, recipient)).length, 0,
          `${testCase.name}: expected no notice for ${recipient}`)
      }
      // A skipped scan still leaves its trace, which the helper already confirmed.
    } finally {
      host.stop()
    }
  }
})

test('the notice switch turns both paths off', async () => {
  const maildir = await makeMaildir()
  await writeRoster(maildir, OWNER)
  const host = await createHost({
    maildir, identities: IDENTITIES,
    agents: [{ id: WORKER, cwd: REPO_CWD }, { id: OWNER, cwd: REPO_CWD }],
    goals: { get: agent => (agent.id === WORKER ? goalView() : undefined) },
    config: { goalDisarmNotice: false },
  })
  try {
    const scan = await waitForScan(host)
    for (const recipient of [OWNER, WORKER]) {
      assert.equal((await noticesFor(maildir, recipient)).length, 0)
    }
    assert.match(scan, /"foundActiveDisarmed":0/)
  } finally {
    host.stop()
  }
})
