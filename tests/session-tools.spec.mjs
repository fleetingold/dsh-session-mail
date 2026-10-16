/**
 * The migrated session-creation tools: their registration surface, the
 * `createTool` switch, and the call contract (name, parameter schema, call
 * presentation, rendered text, and the `mail_send` pointer) that callers and the
 * model already depend on.
 *
 * These are the regression pins for the move from `dsh-session-liveness`: the
 * functions moved package, so every externally visible string is asserted here
 * rather than left to a reviewer's eye.
 * @module dsh-session-mail/tests/session-tools
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost, makeMaildir } from './helpers/fake-host.mjs'

const REPO_CWD = process.cwd()
const IDENTITIES = [{ role: 'repo', name: 'repo', cwd: REPO_CWD, inbox: 'to-repo.jsonl' }]
const CALLER = 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5'

/** Every tool this plugin offers once the creation switch is on. */
const TOOL_NAMES = [
  'mail_send', 'mail_budget', 'mail_drain',
  'session_archive', 'session_unarchive', 'session_archived_list',
  'session_create', 'workspace_create',
]

/**
 * A Session Controller stand-in that records creation requests.
 * @returns the fake controller and its call log.
 */
function fakeController() {
  const calls = { create: [], rename: [] }
  return {
    calls,
    service: {
      async create(options) {
        calls.create.push(options)
        return { sessionId: 'session-created' }
      },
      async rename(options) {
        calls.rename.push(options)
      },
    },
  }
}

/**
 * Mount the plugin on one root session.
 * @param options - config overrides and service stand-ins.
 * @returns the host and the mounted agent.
 */
async function mount({ config = {}, sessionController, sessionGroups, workspaceRegistry } = {}) {
  const maildir = await makeMaildir()
  const fallback = fakeController()
  const host = await createHost({
    maildir,
    identities: IDENTITIES,
    agents: [{ id: CALLER, cwd: REPO_CWD }],
    // The default stand-in must answer `create`/`rename`, not only `setHeld`:
    // the creation tools need the controller's creation half.
    sessionController: sessionController ?? fallback.service,
    sessionGroups,
    workspaceRegistry,
    config,
  })
  return { host, agent: host.agents[0], maildir, controller: sessionController ?? fallback }
}

test('every tool this package offers is registered, and nothing is registered twice', async () => {
  const { host, agent } = await mount()
  try {
    assert.deepEqual([...agent.tools.keys()].sort(), [...TOOL_NAMES].sort())
    // A duplicate registration is not a silent overwrite in the real host: it
    // throws, which `attach` swallows into a logged error. Assert the log is
    // clean, so a second registrar would fail here rather than in production.
    assert.deepEqual(host.warnings.filter(line => /already registered/.test(line)), [])
  } finally {
    host.stop()
  }
})

test('the createTool switch removes exactly the two creation tools and their prompt section', async () => {
  const on = await mount({ config: { createTool: true } })
  const off = await mount({ config: { createTool: false } })
  try {
    assert.equal(on.agent.tools.has('session_create'), true)
    assert.equal(on.agent.tools.has('workspace_create'), true)
    assert.equal(off.agent.tools.has('session_create'), false)
    assert.equal(off.agent.tools.has('workspace_create'), false)
    // The other six stay: the switch is scoped to the creation capability.
    assert.deepEqual(
      [...off.agent.tools.keys()].sort(),
      TOOL_NAMES.filter(name => name !== 'session_create' && name !== 'workspace_create').sort(),
    )
  } finally {
    on.host.stop()
    off.host.stop()
  }
})

test('session_create keeps the parameter schema, the call presentation, and the mail_send pointer', async () => {
  const { host, agent } = await mount()
  try {
    const tool = agent.tools.get('session_create')
    assert.equal(tool.name, 'session_create')
    // `defineTool` compiles the declaration into JSON Schema, so the assertion
    // reads the compiled surface the host and the model actually see.
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['agent_preset', 'cwd', 'groupId', 'title'])
    assert.deepEqual(tool.parameters.required, ['title'])
    assert.match(tool.parameters.properties.title.description, /Task-semantic title/)
    assert.match(tool.parameters.properties.cwd.description, /must belong to a registered workspace/)
    assert.deepEqual(
      tool.presentCall({ title: 'Task' }),
      { card: 'generic', title: 'Create session · Task', kind: 'execute' },
    )
    // The output schema is part of the call contract too: `additionalProperties:
    // false` means a dropped or renamed field would be rejected, not ignored.
    assert.deepEqual(Object.keys(tool.output.schema.properties).sort(),
      ['groupId', 'groupIdError', 'sessionId', 'title', 'titleError', 'workspaceId'])
    assert.deepEqual(tool.output.schema.required.slice().sort(), ['sessionId', 'title'])
    // The dispatch pointer names this package's own mail_send, addressed by id.
    const [frame] = tool.output.render({}, { sessionId: 'session-created', title: 'Task' })
    assert.match(frame.text, /Dispatch its task with mail_send \{ to_session: "session-created", \.\.\. \}\./)
  } finally {
    host.stop()
  }
})

test('workspace_create keeps the parameter schema and the call presentation', async () => {
  const { host, agent } = await mount()
  try {
    const tool = agent.tools.get('workspace_create')
    assert.equal(tool.name, 'workspace_create')
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(Object.keys(tool.parameters.properties), ['path'])
    assert.deepEqual(tool.parameters.required, ['path'])
    assert.deepEqual(
      tool.presentCall({ path: 'C:\\other' }),
      { card: 'generic', title: 'Create workspace · C:\\other', kind: 'execute' },
    )
    assert.deepEqual(Object.keys(tool.output.schema.properties).sort(), ['created', 'title', 'workspaceId'])
    assert.deepEqual(tool.output.schema.required.slice().sort(), ['created', 'title', 'workspaceId'])
    const [created] = tool.output.render({}, { workspaceId: 'workspace-1', title: 'other', created: true })
    assert.match(created.text, /^created workspace workspace-1 titled "other"\./)
    const [existing] = tool.output.render({}, { workspaceId: 'workspace-1', title: 'other', created: false })
    assert.match(existing.text, /^already registered workspace workspace-1/)
  } finally {
    host.stop()
  }
})

test('session_create creates the session, records the title, and joins a group when asked', async () => {
  const joins = []
  const { host, agent, controller } = await mount({
    sessionGroups: { async setMembers(request) { joins.push(request) } },
  })
  try {
    const outcome = await agent.tools.get('session_create').execute(
      { title: '  Migrate the tools  ', groupId: 'session-group-1' },
      { agent },
    )
    assert.equal(outcome.sessionId, 'session-created')
    assert.equal(outcome.title, 'Migrate the tools')
    assert.equal(outcome.groupId, 'session-group-1')
    assert.equal(outcome.groupIdError, '')
    const target = process.platform === 'win32' ? REPO_CWD.toLowerCase() : REPO_CWD
    assert.equal(controller.calls.create.length, 1)
    // An unregistered directory is passed as cwd, never as a workspaceId.
    assert.equal(String(controller.calls.create[0].cwd).toLowerCase(), target)
    assert.deepEqual(controller.calls.rename, [{ sessionId: 'session-created', title: 'Migrate the tools' }])
    assert.deepEqual(joins, [{ groupId: 'session-group-1', added: ['session-created'] }])
  } finally {
    host.stop()
  }
})

test('session_create refuses a blank title and a deployment without a Session Controller', async () => {
  const { host, agent } = await mount()
  try {
    await assert.rejects(
      () => agent.tools.get('session_create').execute({ title: '   ' }, { agent }),
      /title is required/,
    )
  } finally {
    host.stop()
  }
  const bare = await mount({ sessionController: false })
  try {
    await assert.rejects(
      () => bare.agent.tools.get('session_create').execute({ title: 'Task' }, { agent: bare.agent }),
      /session controller is unavailable/,
    )
  } finally {
    bare.host.stop()
  }
})

test('workspace_create registers through the host registry and reports idempotency', async () => {
  const created = []
  const registry = {
    async resolveByPath(path) {
      return created.includes(path) ? { id: 'workspace-1', title: 'repo' } : undefined
    },
    async create(path) {
      created.push(path)
      return { id: 'workspace-1', title: 'repo' }
    },
  }
  const { host, agent } = await mount({ workspaceRegistry: registry })
  try {
    const first = await agent.tools.get('workspace_create').execute({ path: REPO_CWD })
    assert.deepEqual(first, { workspaceId: 'workspace-1', title: 'repo', created: true })
    const second = await agent.tools.get('workspace_create').execute({ path: REPO_CWD })
    assert.deepEqual(second, { workspaceId: 'workspace-1', title: 'repo', created: false })
    assert.deepEqual(created, [REPO_CWD])
  } finally {
    host.stop()
  }
})

test('the creation tools refuse a deployment that mounts no workspace registry', async () => {
  const { host, agent } = await mount()
  try {
    await assert.rejects(
      () => agent.tools.get('workspace_create').execute({ path: REPO_CWD }),
      /mounts no workspace registry/,
    )
  } finally {
    host.stop()
  }
})
