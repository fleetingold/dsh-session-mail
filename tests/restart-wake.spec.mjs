/**
 * The restart-wake path must hand the session a message whose source is the
 * producer-owned kind the platform records for this plugin: session format v4
 * refuses the retired `plugin` wrapper at admission, and its V3-to-V4 migration
 * stores this plugin's historical notices as `plugin:session-mail` (the
 * `producerKind()` fallback), so both paths must agree on one identity.
 * @module dsh-session-mail/tests/restart-wake
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeWakeRequests } from '../mailbox.mjs'
import { createHost, makeMaildir, waitFor } from './helpers/fake-host.mjs'

const REPO_CWD = 'C:\\repo'
const IDENTITIES = [{ role: 'repo', name: '本仓', cwd: REPO_CWD, inbox: 'to-repo.jsonl' }]

test('a restart wake carries the canonical producer-owned source', async () => {
  const maildir = await makeMaildir()
  const targetId = 'session-7777777a-7777-4777-8777-77777777777a'
  // Pending wakes ride session open, so seeding the request before the mount is
  // exactly the restarted-service ordering this path exists for.
  await writeWakeRequests(maildir, [{ sessionId: targetId, message: 'wake: continue after restart' }])
  const host = await createHost({ maildir, identities: IDENTITIES, agents: [{ id: targetId, cwd: REPO_CWD }] })
  try {
    const agent = host.agents[0]
    await waitFor(() => agent.received.length === 1)
    const source = agent.received[0].source
    assert.equal(source.kind, 'plugin:session-mail')
    assert.equal(source.plugin, 'session-mail')
    assert.equal(source.form, 'notice')
    assert.equal(source.summary, 'wake after restart')
  } finally {
    host.stop()
  }
})
