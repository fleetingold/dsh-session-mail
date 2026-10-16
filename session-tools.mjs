/**
 * Session-creation primitives: the workspace/registry guards and the three
 * helpers behind the `session_create` and `workspace_create` tools.
 *
 * These functions were moved here from the `dsh-session-liveness` plugin so that
 * all eight model tools live in one package. They are pure host-side helpers:
 * the Session Controller, the workspace registry, and the session-group service
 * are **parameters**, never imports, so nothing in this module needs a host to
 * load and the whole thing is exercised by plain Node tests.
 *
 * The guards encode one rule with two faces. A new Session may open inside the
 * caller's own repository, or in a directory that a **registered Workspace**
 * owns — the Workspace being the explicit, owner-visible grant that a directory
 * belongs to this deployment, and the only thing that relaxes the
 * same-repository rule. An unregistered foreign directory is refused, and
 * `workspace_create` is how a caller registers one.
 *
 * Path comparison is platform-aware on purpose: Windows paths differ only by
 * case, POSIX paths do not, so the comparison form is chosen per platform
 * rather than normalised one way for both.
 * @module dsh-session-mail/session-tools
 */

import { stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/** Repository marker the same-repository rule walks up for. */
const REPO_MARKER = '.git'

/** Upper bound on the upward search, so a path outside any repository terminates. */
const ROOT_SEARCH_LIMIT = 64

/**
 * Tolerated marker-probe failures: the path is absent, not a directory, or a
 * parent the caller may not stat. All three mean "no marker here, keep walking".
 */
const MARKER_PROBE_MISSES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'])

/**
 * Path form two paths are compared in: Windows paths differ only by case.
 *
 * **Do not confuse this with `pathComparisonKey` in `mailbox.mjs`.** The two
 * apply the same platform rule (lowercase on win32, preserve case elsewhere) but
 * are not interchangeable, and neither is a spare copy of the other:
 *
 * - this function receives paths this module has already run through
 *   `path.resolve()` (see `isWithin`), so it only has to fold case;
 * - `pathComparisonKey` keys the mailbox identities, whose `cwd` values are raw
 *   **configuration strings** that were never resolved, so it must also fold `/`
 *   to `\` on win32 and drop a trailing separator.
 *
 * They are deliberately left separate rather than merged: routing the identity
 * keys through this function would mean `path.resolve()`-ing user configuration,
 * which would change what every existing `identities` entry matches. If they are
 * ever unified, the entry point must be `pathComparisonKey`, the more tolerant of
 * the two.
 * @param path - absolute path already resolved.
 * @returns the comparison form for this platform.
 */
function comparable(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/**
 * Find the repository root that owns a directory.
 * @param cwd - directory to start from.
 * @returns the nearest ancestor (or the directory itself) holding `.git`, or
 *   undefined when the walk reaches the filesystem root.
 */
export async function resolveRepoRoot(cwd) {
  let current = resolve(cwd)
  for (let depth = 0; depth < ROOT_SEARCH_LIMIT; depth++) {
    try {
      await stat(join(current, REPO_MARKER))
      return current
    } catch (error) {
      if (!MARKER_PROBE_MISSES.has(error?.code)) throw error
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * Test whether one path sits inside a root.
 * @param root - containing directory.
 * @param candidate - path to test.
 * @returns true when the paths are equal or the candidate is below the root.
 */
export function isWithin(root, candidate) {
  const boundary = comparable(resolve(root))
  const target = comparable(resolve(candidate))
  if (target === boundary) return true
  return target.startsWith(boundary.endsWith(sep) ? boundary : `${boundary}${sep}`)
}

/**
 * Enforce the same-repository rule for a session `session_create` materializes.
 * @param callerCwd - the calling session's working directory.
 * @param requestedCwd - requested directory, or undefined to inherit the caller's.
 * @returns the resolved directory the new session may use.
 * @throws when the requested directory is outside the caller's repository.
 */
export async function assertSameRepo(callerCwd, requestedCwd) {
  const requested = resolve(requestedCwd ?? callerCwd)
  const repoRoot = await resolveRepoRoot(callerCwd)
  const boundary = repoRoot ?? resolve(callerCwd)
  if (isWithin(boundary, requested)) return requested
  const scope = repoRoot === undefined ? "the calling session's directory" : "the calling session's repository"
  throw new Error(
    `session_create: cwd "${requested}" is outside ${scope} "${boundary}" — create the session inside the same repository`,
  )
}

/**
 * Enforce the target rule for a Session `session_create` materializes: the
 * directory may lie inside the caller's repository, or be owned by a
 * **registered Workspace**. A Workspace is the explicit, owner-visible grant
 * that lets a Session open outside the caller's repository, so an unregistered
 * foreign directory is still refused — the same-repository rule relaxes only
 * where a Workspace already says the directory belongs to the sidebar.
 * @param callerCwd - the calling session's working directory.
 * @param requestedCwd - requested directory, or undefined to inherit the caller's.
 * @param registry - the workspace registry service, or undefined when absent.
 * @returns the resolved directory the new Session may use.
 * @throws when the directory is neither inside the caller's repository nor owned by a Workspace.
 */
export async function assertTargetAllowed(callerCwd, requestedCwd, registry) {
  const requested = resolve(requestedCwd ?? callerCwd)
  const repoRoot = await resolveRepoRoot(callerCwd)
  const boundary = repoRoot ?? resolve(callerCwd)
  if (isWithin(boundary, requested)) return requested
  const workspace = await resolveWorkspace(registry, requested)
  if (workspace !== undefined) return requested
  const scope = repoRoot === undefined ? "the calling session's directory" : "the calling session's repository"
  throw new Error(
    `session_create: cwd "${requested}" is outside ${scope} "${boundary}" and no registered Workspace owns it — `
    + 'register the directory first (workspace_create) or name a directory inside the same repository',
  )
}

/**
 * Resolve the workspace that owns one directory, tolerating a deployment (or a
 * registry fault) that cannot answer: the caller then keeps the cwd-only path.
 * @param registry - the workspace registry service, or undefined when absent.
 * @param path - absolute directory the new Session would open in.
 * @returns the owning workspace, or undefined when none is registered.
 */
async function resolveWorkspace(registry, path) {
  if (registry === undefined || registry === null || typeof registry.resolveByPath !== 'function') {
    return undefined
  }
  try {
    const workspace = await registry.resolveByPath(path)
    return workspace !== null && typeof workspace === 'object' ? workspace : undefined
  } catch {
    return undefined
  }
}

/**
 * Create one peer Session and give it the task-semantic title the caller wrote.
 *
 * The Session joins the **workspace** that owns the target directory, so it is
 * listed under the caller's workspace in the sidebar instead of Ungrouped. The
 * Session Controller accepts `workspaceId` or `cwd`, never both, so a registered
 * workspace is passed as its id and an unregistered directory falls back to the
 * raw path.
 * @param options - the Session Controller service, the caller's working
 *   directory, the required title, an optional cwd, an optional preset, and the
 *   workspace registry when the deployment mounts one.
 * @returns the new session id, the recorded title, a title failure when the
 *   rename did not land, and the joined workspace id when one was resolved (the
 *   session exists and stays addressable either way).
 */
export async function createSession({ controller, callerCwd, title, cwd, agentPreset, registry }) {
  const normalizedTitle = typeof title === 'string' ? title.trim() : ''
  if (normalizedTitle === '') {
    throw new Error('session_create: title is required — name the task this session is about to receive')
  }
  const target = await assertTargetAllowed(callerCwd, cwd, registry)
  const workspace = await resolveWorkspace(registry, target)
  const created = await controller.create({
    ...(workspace === undefined ? { cwd: target } : { workspaceId: workspace.id }),
    ...(agentPreset === undefined || agentPreset === '' ? {} : { agentPreset }),
  })
  const sessionId = created?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('session_create: the Host returned no session id')
  }
  try {
    await controller.rename({ sessionId, title: normalizedTitle })
  } catch (error) {
    return {
      sessionId, title: '', titleError: String(error?.message ?? error),
      ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
    }
  }
  return {
    sessionId, title: normalizedTitle, titleError: '',
    ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
  }
}

/**
 * Register the Workspace that owns one directory, or report the one already
 * there. Idempotent by path: a directory a Workspace already owns is resolved
 * and never duplicated, so a caller can run this before `session_create`
 * without first asking whether the directory is registered.
 *
 * The Workspace is what makes a directory reachable to a Session created from
 * another repository (`assertTargetAllowed`), and what puts the Sessions under
 * it in the sidebar instead of Ungrouped.
 * @param options - the workspace registry service and the directory to register.
 * @returns the Workspace id, the title the registry gave it, and whether this call created it.
 * @throws when no registry can create a Workspace, the path is missing or not a
 *   directory, or the registry refuses the directory.
 */
export async function createWorkspace({ registry, path }) {
  if (registry === undefined || registry === null || typeof registry.create !== 'function') {
    throw new Error('workspace_create: this deployment mounts no workspace registry that can create a Workspace')
  }
  const requested = resolve(String(path ?? ''))
  let info
  try {
    info = await stat(requested)
  } catch {
    throw new Error(`workspace_create: "${requested}" does not exist`)
  }
  if (!info.isDirectory()) throw new Error(`workspace_create: "${requested}" is not a directory`)
  const existing = await resolveWorkspace(registry, requested)
  if (existing !== undefined) {
    return { workspaceId: String(existing.id ?? ''), title: String(existing.title ?? ''), created: false }
  }
  let created
  try {
    created = await registry.create(requested)
  } catch (error) {
    throw new Error(`workspace_create: the registry refused "${requested}": ${String(error?.message ?? error)}`)
  }
  const workspaceId = String(created?.id ?? '')
  if (workspaceId === '') throw new Error('workspace_create: the Host returned no workspace id')
  return { workspaceId, title: String(created?.title ?? ''), created: true }
}

/**
 * Put one Session into an existing session group, so the sidebar lists it under
 * that group instead of Ungrouped. Membership is added, never replaced: the
 * `sessionGroups.setMembers` request carries only `added`.
 * @param groups - the `sessionGroups` service, or undefined when the
 *   deployment mounts no session-group bundle.
 * @param groupId - owning group Session id; a blank value asks for nothing.
 * @param sessionId - Session to add as a member.
 * @returns the joined group id, and a failure reason when the join did not land
 *   (the Session exists and stays addressable either way).
 */
export async function joinSessionGroup(groups, groupId, sessionId) {
  const normalized = typeof groupId === 'string' ? groupId.trim() : ''
  if (normalized === '') return { groupId: '', groupIdError: '' }
  if (groups === undefined || groups === null) {
    return { groupId: '', groupIdError: 'this deployment mounts no sessionGroups service' }
  }
  try {
    await groups.setMembers({ groupId: normalized, added: [sessionId] })
    return { groupId: normalized, groupIdError: '' }
  } catch (error) {
    return { groupId: '', groupIdError: String(error?.message ?? error) }
  }
}
