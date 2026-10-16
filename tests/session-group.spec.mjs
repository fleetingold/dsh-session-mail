/**
 * `joinSessionGroup`: membership is added, never replaced, and every refusal is
 * reported instead of thrown — the Session exists either way. Moved here with
 * the function from `dsh-session-liveness`; the cases are unchanged.
 * @module dsh-session-mail/tests/session-group
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { joinSessionGroup } from '../session-tools.mjs'

describe('joinSessionGroup', () => {
  it('adds the session to the group without replacing existing members', async () => {
    const calls = []
    const groups = { async setMembers(request) { calls.push(request) } }
    const result = await joinSessionGroup(groups, ' session-group-1 ', 'session-new')
    assert.deepEqual(calls, [{ groupId: 'session-group-1', added: ['session-new'] }])
    assert.deepEqual(result, { groupId: 'session-group-1', groupIdError: '' })
  })

  it('asks for nothing when no group id was given', async () => {
    const calls = []
    const groups = { async setMembers(request) { calls.push(request) } }
    assert.deepEqual(await joinSessionGroup(groups, undefined, 'session-new'), { groupId: '', groupIdError: '' })
    assert.deepEqual(await joinSessionGroup(groups, '   ', 'session-new'), { groupId: '', groupIdError: '' })
    assert.equal(calls.length, 0)
  })

  it('reports a deployment without the sessionGroups service instead of throwing', async () => {
    const result = await joinSessionGroup(undefined, 'session-group-1', 'session-new')
    assert.equal(result.groupId, '')
    assert.match(result.groupIdError, /no sessionGroups service/)
  })

  it('keeps the session when the join is refused, and reports why', async () => {
    const groups = { async setMembers() { throw new Error('session/agent-busy') } }
    const result = await joinSessionGroup(groups, 'session-group-1', 'session-new')
    assert.deepEqual(result, { groupId: '', groupIdError: 'session/agent-busy' })
  })
})
