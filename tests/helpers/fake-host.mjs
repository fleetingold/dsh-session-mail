/**
 * Minimal Cordis host stand-in for driving `dsh-session-mail` without a running
 * dsh process. It provides exactly the services, agent surface, and timer
 * control that `apply` touches, and exposes the assertions the tests need.
 * @module dsh-session-mail/tests/helpers/fake-host
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../index.mjs'

/**
 * Create one empty mailbox directory under the system temp directory.
 * @param prefix - directory-name prefix.
 * @returns the absolute maildir path.
 */
export async function makeMaildir(prefix = 'dsh-session-mail-') {
  return await mkdtemp(join(tmpdir(), prefix))
}

/**
 * Await a condition that the plugin reaches through timers it does not await.
 * @param predicate - returns a truthy value once the condition holds.
 * @param options - timeout and poll interval.
 * @returns the truthy value the predicate produced.
 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/**
 * Build one agent as the plugin sees a root session.
 * @param spec - session id, workspace path, and status.
 * @returns the agent stand-in, recording every delivered message in `received`.
 */
function makeAgent({ id, cwd, status = 'idle' }) {
  const disposers = []
  /** Agent-scoped listeners, mirroring the harness's per-agent event scope. */
  const listeners = new Map()
  const agent = {
    id,
    status,
    session: { header: { cwd } },
    received: [],
    listeners,
    followup(message) {
      agent.received.push(message)
    },
    inject(message) {
      agent.received.push(message)
    },
    ctx: {
      effect: (fn) => {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
      on: (event, listener) => {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
        return () => {
          const index = list.indexOf(listener)
          if (index >= 0) list.splice(index, 1)
        }
      },
      tools: {
        register: (tool) => {
          agent.tools.set(tool.name, tool)
          return () => agent.tools.delete(tool.name)
        },
      },
      systemPrompt: {
        section: () => () => {},
        getSectionOrder: () => 0,
      },
    },
    tools: new Map(),
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
  return agent
}

/**
 * Build a host around one mailbox, mount the plugin on it, and hand back the
 * controls the tests drive it with.
 * @param options - maildir, identities, initial agents, a Session Controller
 *   stand-in, the directory an activated session opens in, a goal service
 *   stand-in, and config overrides.
 * @returns the host handle.
 */
export async function createHost({
  maildir, identities, agents: agentSpecs = [], config = {}, sessionController, activationCwd, goals,
  workspaceRegistry, sessionGroups,
}) {
  const intervals = []
  const disposers = []
  const listeners = new Map()
  const agents = agentSpecs.map(makeAgent)
  const effective = {
    maildir,
    identities,
    pollMs: 50,
    batchWindowMs: 0,
    delivery: 'wakeup',
    maxConsecutiveWakes: 3,
    maxRedeliveries: 1,
    wakeWindowMs: 60_000,
    wakeWindowExtensions: 3,
    catchUpOnStart: true,
    activateOnSend: true,
    createTool: true,
    presenceHeartbeatMs: 200,
    presenceTtlMs: 1200,
    claimTtlMs: 60_000,
    claimRetentionMs: 60_000,
    sweepIntervalMs: 1000,
    goalDisarmNotice: true,
    ...config,
  }
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  // Intervals are captured instead of scheduled, so a test decides when a poll
  // or heartbeat happens.
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms })
    return intervals.length
  }
  globalThis.clearInterval = () => {}

  /**
   * Session Controller stand-in: acquiring the hold materializes the session as
   * a root agent here (the same publication path `agent/created` gives), and
   * releasing it drops that agent. Tests may replace it to force a refusal, or
   * pass `false` to model a deployment that has no Session Controller at all.
   */
  const controller = sessionController === false ? undefined : (sessionController ?? {
    async setHeld({ sessionId, held }) {
      const existing = agents.find(agent => agent.id === sessionId)
      if (held) {
        if (existing !== undefined) return { held: true, changed: false }
        const agent = makeAgent({ id: sessionId, cwd: activationCwd ?? identities[0]?.cwd ?? 'C:\\repo' })
        agents.push(agent)
        for (const listener of listeners.get('agent/created') ?? []) listener({ agent })
        return { held: true, changed: true }
      }
      if (existing === undefined) return { held: false, changed: false }
      agents.splice(agents.indexOf(existing), 1)
      return { held: false, changed: true }
    },
  })

  /** Every warning and error the plugin logged, in order, for assertions. */
  const warnings = []
  /** Every informational line the plugin logged, in order, for assertions. */
  const logs = []
  const ctx = {
    agents: { roots: () => agents.slice(), get: (id) => agents.find(agent => agent.id === id) },
    logger: {
      info: (message) => logs.push(String(message)),
      warn: (message) => warnings.push(String(message)),
      error: (message) => warnings.push(String(message)),
    },
    get: (name) => {
      if (name === 'sessionController') return controller
      if (name === 'goals') return goals
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'sessionGroups') return sessionGroups
      return undefined
    },
    inject: () => {},
    on: (event, listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }

  try {
    apply(ctx, effective)
  } catch (error) {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    throw error
  }

  return {
    ctx,
    config: effective,
    agents,
    warnings,
    logs,
    /**
     * Add one session to this host, through the same `agent/created` path the
     * running harness uses.
     * @param spec - session id, workspace path, and status.
     * @returns the new agent stand-in.
     */
    addAgent: (spec) => {
      const agent = makeAgent(spec)
      agents.push(agent)
      for (const listener of listeners.get('agent/created') ?? []) listener({ agent })
      return agent
    },
    /** Run every captured interval callback of one period. */
    runInterval: (ms) => {
      for (const interval of intervals.filter(entry => entry.ms === ms)) interval.fn()
    },
    /** Run every inbox poll this host registered. */
    runPolls: () => {
      for (const interval of intervals.filter(entry => entry.ms === effective.pollMs)) interval.fn()
    },
    /** Run the presence heartbeat this host registered. */
    runHeartbeat: () => {
      for (const interval of intervals.filter(entry => entry.ms === effective.presenceHeartbeatMs)) interval.fn()
    },
    /** Emit one host event to every listener the plugin registered, host scope then agent scope. */
    emit: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) listener(payload)
      // The harness delivers agent-scoped registrations inside each agent's own
      // scope, so the stand-in fans the same event out to every hosted agent.
      for (const agent of agents) {
        for (const listener of agent.listeners.get(event) ?? []) listener(payload)
      }
    },
    /** Unmount the plugin and restore the real timers. */
    stop: () => {
      for (const dispose of disposers.splice(0)) dispose()
      for (const agent of agents) agent.dispose()
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    },
  }
}
