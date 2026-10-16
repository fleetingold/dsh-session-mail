/**
 * `createWorkspace`: idempotent registration, path validation, and the failures
 * a deployment without a usable registry produces. Moved here with the function
 * from `dsh-session-liveness`; the cases are unchanged.
 * @module dsh-session-mail/tests/workspace-create
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createWorkspace } from '../session-tools.mjs'

/**
 * Run one case against a throwaway directory.
 * @param fn - receives the directory path.
 */
async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'session-mail-workspace-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * A Workspace registry stand-in recording what it was asked to create.
 * @param owned - directory path the registry already owns, if any.
 * @returns the fake registry.
 */
function fakeRegistry(owned) {
  const created = []
  return {
    created,
    async resolveByPath(path) {
      return owned !== undefined && path === owned ? { id: 'workspace-owned', title: 'owned', path } : undefined
    },
    async create(path) {
      created.push(path)
      return { id: 'workspace-new', title: 'new', path }
    },
  }
}

describe('createWorkspace', () => {
  it('creates the Workspace that owns an unregistered directory', async () => {
    await withDir(async dir => {
      const registry = fakeRegistry()
      const result = await createWorkspace({ registry, path: dir })
      assert.deepEqual(registry.created, [dir])
      assert.equal(result.created, true)
      assert.equal(result.workspaceId, 'workspace-new')
      assert.equal(result.title, 'new')
    })
  })

  it('resolves a directory a Workspace already owns without creating a second one', async () => {
    await withDir(async dir => {
      const registry = fakeRegistry(dir)
      const result = await createWorkspace({ registry, path: dir })
      assert.deepEqual(registry.created, [])
      assert.equal(result.created, false)
      assert.equal(result.workspaceId, 'workspace-owned')
    })
  })

  it('refuses a path that does not exist', async () => {
    await withDir(async dir => {
      await assert.rejects(
        () => createWorkspace({ registry: fakeRegistry(), path: join(dir, 'absent') }),
        /does not exist/,
      )
    })
  })

  it('refuses a path that is not a directory', async () => {
    await withDir(async dir => {
      const file = join(dir, 'file.txt')
      await writeFile(file, 'not a directory')
      await assert.rejects(
        () => createWorkspace({ registry: fakeRegistry(), path: file }),
        /is not a directory/,
      )
    })
  })

  it('refuses a deployment whose registry cannot create a Workspace', async () => {
    await withDir(async dir => {
      await assert.rejects(() => createWorkspace({ registry: {}, path: dir }), /no workspace registry/)
      await assert.rejects(() => createWorkspace({ path: dir }), /no workspace registry/)
    })
  })

  it('reports a registry refusal as its own failure', async () => {
    await withDir(async dir => {
      const registry = {
        async resolveByPath() { return undefined },
        async create() { throw new Error('not a repository') },
      }
      await assert.rejects(() => createWorkspace({ registry, path: dir }), /the registry refused .*not a repository/)
    })
  })
})
