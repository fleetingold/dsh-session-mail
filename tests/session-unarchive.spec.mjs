/**
 * `session_unarchive`: the tool clears one id in the host's archived-session set
 * through `workspaceRegistry.unarchiveSession`, needs no live session, is
 * idempotent without a second write, refuses a malformed id with zero state
 * change, and fails loud when the host cannot clear the id at all — an absent
 * registry service, or a registry that predates the unarchive method.
 * @module dsh-session-mail/tests/session-unarchive
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost, makeMaildir } from './helpers/fake-host.mjs'

const REPO_CWD = 'C:\\repo'
const IDENTITIES = [{ role: 'repo', name: '本仓', cwd: REPO_CWD, inbox: 'to-repo.jsonl' }]
const SENDER = 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5'
const TARGET = 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4'

/**
 * Build the workspace registry stand-in the host provides. `archiveSession`
 * refuses an id no session holds, like the real service; `unarchiveSession`
 * checks nothing, which is the asymmetry the tool depends on.
 * @param options - ids the registry knows about, the starting archive set, and
 * whether the build exposes `unarchiveSession` at all.
 * @returns the stub, its state, and its call log.
 */
function makeRegistry({ known = [TARGET], archived = [], withUnarchive = true } = {}) {
  const state = { archivedSessionIds: [...archived] }
  const calls = { archive: [], unarchive: [] }
  const service = {
    get archivedSessionIds() { return state.archivedSessionIds },
    async archiveSession(sessionId) {
      calls.archive.push(sessionId)
      if (!known.includes(sessionId)) {
        throw new Error(`cannot archive session '${sessionId}': live sessions and session persistence hold no such session`)
      }
      if (state.archivedSessionIds.includes(sessionId)) return
      state.archivedSessionIds.push(sessionId)
    },
  }
  if (withUnarchive) {
    service.unarchiveSession = async (sessionId) => {
      calls.unarchive.push(sessionId)
      if (!state.archivedSessionIds.includes(sessionId)) return
      state.archivedSessionIds = state.archivedSessionIds.filter(id => id !== sessionId)
    }
  }
  return { state, calls, service }
}

/**
 * Build one host carrying a sender session plus the registry stub.
 * @param registry - the stand-in service, or `false` for a host without one.
 * @returns the host handle and the sender agent.
 */
async function hostWithRegistry(registry) {
  const maildir = await makeMaildir()
  const host = await createHost({
    maildir, identities: IDENTITIES, agents: [{ id: SENDER, cwd: REPO_CWD }],
    ...(registry === false ? {} : { workspaceRegistry: registry.service }),
  })
  return { host, sender: host.agents[0] }
}

test('unarchive: a full id is cleared and the set reads back', async () => {
  const registry = makeRegistry()
  const { host, sender } = await hostWithRegistry(registry)
  try {
    await sender.tools.get('session_archive').execute({ session_id: TARGET }, { agent: sender })
    const result = await sender.tools.get('session_unarchive').execute({ session_id: TARGET }, { agent: sender })
    assert.equal(result.unarchived, true)
    assert.equal(result.alreadyActive, false)
    assert.deepEqual(result.archivedSessionIds, [])
    assert.deepEqual(registry.calls.unarchive, [TARGET])
    assert.deepEqual(registry.state.archivedSessionIds, [])
    const list = await sender.tools.get('session_archived_list').execute({}, { agent: sender })
    assert.equal(list.count, 0)
    assert.deepEqual(list.archivedSessionIds, [])
  } finally {
    host.stop()
  }
})

test('unarchive: an id that is not archived reports without a write', async () => {
  const registry = makeRegistry()
  const { host, sender } = await hostWithRegistry(registry)
  try {
    const result = await sender.tools.get('session_unarchive').execute({ session_id: TARGET }, { agent: sender })
    assert.equal(result.unarchived, false)
    assert.equal(result.alreadyActive, true)
    assert.deepEqual(registry.calls.unarchive, [], 'an unarchived id must not call unarchiveSession')
    assert.deepEqual(result.archivedSessionIds, [])
  } finally {
    host.stop()
  }
})

test('unarchive: an archived id whose session is gone still clears', async () => {
  // The session is unknown to the registry, so archiving this id is refused;
  // clearing it must not be, or a hidden id could never leave the set.
  const registry = makeRegistry({ known: [], archived: [] })
  const { host, sender } = await hostWithRegistry(registry)
  try {
    await assert.rejects(
      sender.tools.get('session_archive').execute({ session_id: TARGET }, { agent: sender }),
      /cannot archive/,
    )
    // Seed the hidden id the way a deployment that archived the session before
    // its log went away would hold it.
    registry.state.archivedSessionIds = [TARGET]
    const result = await sender.tools.get('session_unarchive').execute({ session_id: TARGET }, { agent: sender })
    assert.equal(result.unarchived, true)
    assert.deepEqual(registry.state.archivedSessionIds, [])
  } finally {
    host.stop()
  }
})

test('unarchive: a short or truncated id is refused before any call', async () => {
  const registry = makeRegistry({ archived: [TARGET] })
  const { host, sender } = await hostWithRegistry(registry)
  try {
    for (const malformed of ['session-ddddddd4', 'session-deadbeef-…', 'session-ddddddd4-dddd-4ddd-8ddd-dddddddddd']) {
      await assert.rejects(
        sender.tools.get('session_unarchive').execute({ session_id: malformed }, { agent: sender }),
        /is not a session id/,
        `expected ${malformed} to be refused by shape`,
      )
    }
    assert.deepEqual(registry.calls.unarchive, [], 'a malformed id must not reach the registry')
    assert.deepEqual(registry.state.archivedSessionIds, [TARGET])
  } finally {
    host.stop()
  }
})

test('unarchive: a host without the workspace registry fails loud', async () => {
  const { host, sender } = await hostWithRegistry(false)
  try {
    await assert.rejects(
      sender.tools.get('session_unarchive').execute({ session_id: TARGET }, { agent: sender }),
      /workspace registry is unavailable/,
    )
  } finally {
    host.stop()
  }
})

test('unarchive: a registry that predates the unarchive method fails loud', async () => {
  // An older harness build still has archiveSession and archivedSessionIds, so
  // only the method check separates "restored" from "silently still archived".
  const registry = makeRegistry({ withUnarchive: false, archived: [TARGET] })
  const { host, sender } = await hostWithRegistry(registry)
  try {
    await assert.rejects(
      sender.tools.get('session_unarchive').execute({ session_id: TARGET }, { agent: sender }),
      /no workspaceRegistry\.unarchiveSession/,
    )
    assert.deepEqual(registry.state.archivedSessionIds, [TARGET])
  } finally {
    host.stop()
  }
})

test('unarchive: render text separates a performed restore from a no-op', async () => {
  const registry = makeRegistry()
  const { host, sender } = await hostWithRegistry(registry)
  try {
    const tool = sender.tools.get('session_unarchive')
    assert.equal(tool.output.render({}, {
      unarchived: true, alreadyActive: false, archivedSessionIds: [],
    }).map(part => part.text).join(''), 'session unarchived; the archive now holds 0 session(s)')
    assert.equal(tool.output.render({}, {
      unarchived: false, alreadyActive: true, archivedSessionIds: [TARGET],
    }).map(part => part.text).join(''), 'session was not archived: nothing was written (1 session(s) archived)')
  } finally {
    host.stop()
  }
})
