/**
 * `createSession` workspace inheritance and the cross-repository target rule.
 * Moved here with the function from `dsh-session-liveness`; the cases are
 * unchanged, only the module under test moved.
 * @module dsh-session-mail/tests/session-create
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createSession } from '../session-tools.mjs'

/**
 * Run one case against a throwaway caller directory.
 * @param fn - receives the caller directory path.
 */
async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'session-mail-create-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * A Session Controller stand-in recording how creation was requested.
 * @returns the fake controller.
 */
function fakeController() {
  const calls = { create: [], rename: [] }
  return {
    calls,
    async create(options) {
      calls.create.push(options)
      return { sessionId: 'session-new' }
    },
    async rename(options) {
      calls.rename.push(options)
    },
  }
}

describe('createSession workspace inheritance', () => {
  it('joins the workspace that owns the target directory, passing its id instead of the path', async () => {
    await withDir(async callerCwd => {
      const controller = fakeController()
      const registry = { async resolveByPath(path) { return path === callerCwd ? { id: 'workspace-1', path } : undefined } }
      const result = await createSession({ controller, callerCwd, title: 'Task', registry })
      assert.deepEqual(controller.calls.create, [{ workspaceId: 'workspace-1' }])
      assert.equal(result.workspaceId, 'workspace-1')
      assert.equal(result.sessionId, 'session-new')
      assert.deepEqual(controller.calls.rename, [{ sessionId: 'session-new', title: 'Task' }])
    })
  })

  it('falls back to the raw directory when no workspace owns it', async () => {
    await withDir(async callerCwd => {
      const controller = fakeController()
      const registry = { async resolveByPath() { return undefined } }
      const result = await createSession({ controller, callerCwd, title: 'Task', registry })
      assert.deepEqual(controller.calls.create, [{ cwd: callerCwd }])
      assert.equal(result.workspaceId, undefined)
    })
  })

  it('falls back to the raw directory when the deployment mounts no registry', async () => {
    await withDir(async callerCwd => {
      const controller = fakeController()
      const result = await createSession({ controller, callerCwd, title: 'Task' })
      assert.deepEqual(controller.calls.create, [{ cwd: callerCwd }])
      assert.equal(result.workspaceId, undefined)
    })
  })

  it('falls back to the raw directory when the registry throws', async () => {
    await withDir(async callerCwd => {
      const controller = fakeController()
      const registry = { async resolveByPath() { throw new Error('registry offline') } }
      const result = await createSession({ controller, callerCwd, title: 'Task', registry })
      assert.deepEqual(controller.calls.create, [{ cwd: callerCwd }])
      assert.equal(result.workspaceId, undefined)
    })
  })

  it('keeps the agent preset alongside the resolved workspace', async () => {
    await withDir(async callerCwd => {
      const controller = fakeController()
      const registry = { async resolveByPath() { return { id: 'workspace-2' } } }
      await createSession({ controller, callerCwd, title: 'Task', agentPreset: 'standard', registry })
      assert.deepEqual(controller.calls.create, [{ workspaceId: 'workspace-2', agentPreset: 'standard' }])
    })
  })
})

describe('createSession across repositories', () => {
  it('opens a Session in a directory outside the caller repository when a Workspace owns it', async () => {
    await withDir(async callerCwd => {
      const foreign = await mkdtemp(join(tmpdir(), 'session-mail-foreign-'))
      try {
        const controller = fakeController()
        const registry = {
          async resolveByPath(path) { return path === foreign ? { id: 'workspace-f', path } : undefined },
        }
        const result = await createSession({ controller, callerCwd, title: 'Task', cwd: foreign, registry })
        assert.deepEqual(controller.calls.create, [{ workspaceId: 'workspace-f' }])
        assert.equal(result.workspaceId, 'workspace-f')
        assert.equal(result.sessionId, 'session-new')
      } finally {
        await rm(foreign, { recursive: true, force: true })
      }
    })
  })

  it('still refuses a foreign directory no Workspace owns, and creates nothing', async () => {
    await withDir(async callerCwd => {
      const foreign = await mkdtemp(join(tmpdir(), 'session-mail-foreign-'))
      try {
        const controller = fakeController()
        const registry = { async resolveByPath() { return undefined } }
        await assert.rejects(
          () => createSession({ controller, callerCwd, title: 'Task', cwd: foreign, registry }),
          /and no registered Workspace owns it/,
        )
        assert.deepEqual(controller.calls.create, [])
        assert.deepEqual(controller.calls.rename, [])
      } finally {
        await rm(foreign, { recursive: true, force: true })
      }
    })
  })
})
