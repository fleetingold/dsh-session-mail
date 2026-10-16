/**
 * `session_archive` and `session_archived_list`: the archive tools act through the
 * host's workspace registry, are idempotent without a second write, refuse a
 * malformed or unknown id with zero state change, and list without writing.
 * `session_unarchive` has its own suite.
 * @module dsh-session-mail/tests/session-archive
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost, makeMaildir } from './helpers/fake-host.mjs'

const REPO_CWD = 'C:\\repo'
const IDENTITIES = [{ role: 'repo', name: '本仓', cwd: REPO_CWD, inbox: 'to-repo.jsonl' }]
const SENDER = 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5'
const TARGET = 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4'

/**
 * Build the workspace registry stand-in the host provides: it records every write
 * and refuses an id no session holds, exactly like the real service.
 * @param options - ids the registry knows about.
 * @returns the stub and its call log.
 */
function makeRegistry({ known = [TARGET] } = {}) {
  const state = { archivedSessionIds: [] }
  const calls = { archive: [] }
  return {
    state,
    calls,
    service: {
      get archivedSessionIds() { return state.archivedSessionIds },
      async archiveSession(sessionId) {
        calls.archive.push(sessionId)
        if (!known.includes(sessionId)) {
          throw new Error(`cannot archive session '${sessionId}': live sessions and session persistence hold no such session`)
        }
        if (state.archivedSessionIds.includes(sessionId)) return
        state.archivedSessionIds.push(sessionId)
      },
    },
  }
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

test('archive: a full id is archived and the set reads back', async () => {
  const registry = makeRegistry()
  const { host, sender } = await hostWithRegistry(registry)
  try {
    const result = await sender.tools.get('session_archive').execute({ session_id: TARGET }, { agent: sender })
    assert.equal(result.archived, true)
    assert.equal(result.alreadyArchived, false)
    assert.deepEqual(result.archivedSessionIds, [TARGET])
    assert.deepEqual(registry.state.archivedSessionIds, [TARGET])
    const list = await sender.tools.get('session_archived_list').execute({}, { agent: sender })
    assert.equal(list.count, 1)
    assert.deepEqual(list.archivedSessionIds, [TARGET])
  } finally {
    host.stop()
  }
})

test('archive: an already archived id reports without a second write', async () => {
  const registry = makeRegistry()
  const { host, sender } = await hostWithRegistry(registry)
  try {
    await sender.tools.get('session_archive').execute({ session_id: TARGET }, { agent: sender })
    const writes = registry.calls.archive.length
    const again = await sender.tools.get('session_archive').execute({ session_id: TARGET }, { agent: sender })
    assert.equal(again.archived, false)
    assert.equal(again.alreadyArchived, true)
    assert.equal(registry.calls.archive.length, writes, 'a repeat must not call archiveSession again')
    assert.deepEqual(again.archivedSessionIds, [TARGET])
  } finally {
    host.stop()
  }
})

test('archive: an unknown session fails loud with zero state change', async () => {
  const registry = makeRegistry()
  const { host, sender } = await hostWithRegistry(registry)
  try {
    const unknown = 'session-abcdef09-2345-4678-89ab-cdef0123456f'
    await assert.rejects(
      sender.tools.get('session_archive').execute({ session_id: unknown }, { agent: sender }),
      /cannot archive/,
    )
    assert.deepEqual(registry.state.archivedSessionIds, [])
    assert.deepEqual(registry.calls.archive, [unknown])
  } finally {
    host.stop()
  }
})

test('archive: a short or truncated id is refused before any call', async () => {
  const registry = makeRegistry()
  const { host, sender } = await hostWithRegistry(registry)
  try {
    for (const malformed of ['session-ddddddd4', 'session-deadbeef-…', 'session-ddddddd4-dddd-4ddd-8ddd-dddddddddd']) {
      await assert.rejects(
        sender.tools.get('session_archive').execute({ session_id: malformed }, { agent: sender }),
        /is not a session id/,
        `expected ${malformed} to be refused by shape`,
      )
    }
    assert.deepEqual(registry.calls.archive, [], 'a malformed id must not reach the registry')
    assert.deepEqual(registry.state.archivedSessionIds, [])
  } finally {
    host.stop()
  }
})

test('archive: a host without the workspace registry fails loud instead of pretending', async () => {
  const { host, sender } = await hostWithRegistry(false)
  try {
    await assert.rejects(
      sender.tools.get('session_archive').execute({ session_id: TARGET }, { agent: sender }),
      /workspace registry is unavailable/,
    )
    await assert.rejects(
      sender.tools.get('session_archived_list').execute({}, { agent: sender }),
      /workspace registry is unavailable/,
    )
  } finally {
    host.stop()
  }
})

test('archive: the list writes nothing and renders an already-archived result', async () => {
  const registry = makeRegistry()
  const { host, sender } = await hostWithRegistry(registry)
  try {
    await sender.tools.get('session_archive').execute({ session_id: TARGET }, { agent: sender })
    const writes = registry.calls.archive.length
    await sender.tools.get('session_archived_list').execute({}, { agent: sender })
    await sender.tools.get('session_archived_list').execute({}, { agent: sender })
    assert.equal(registry.calls.archive.length, writes, 'listing must not write')
    assert.deepEqual(sender.tools.get('session_archive').output.render({}, {
      archived: false, alreadyArchived: true, archivedSessionIds: [TARGET],
    }).map(part => part.text).join(''), 'session was already archived: nothing was written (1 session(s) archived)')
  } finally {
    host.stop()
  }
})
