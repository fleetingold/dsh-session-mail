/**
 * Path comparison: the key both the configured identity and a session's
 * `header.cwd` are folded into before they are compared, and the consequences at
 * the two call sites that use it.
 *
 * The rules differ by platform on purpose — Windows folds case because its
 * filesystem does, POSIX does not because its filesystem does not — so the
 * platform is passed in explicitly here and every case runs on every OS, rather
 * than the suite silently testing only the machine it happens to run on.
 * @module dsh-session-mail/tests/path-normalization
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePath, pathComparisonKey } from '../mailbox.mjs'
import { createHost, makeMaildir } from './helpers/fake-host.mjs'

/** Both call sites fold through this, so its behaviour is asserted per platform. */
test('the comparison key folds separators and case by platform, not by habit', () => {
  // --- win32: backslashes and case folding, exactly as before ---
  assert.equal(pathComparisonKey('C:\\Repo', 'win32'), 'c:\\repo')
  assert.equal(pathComparisonKey('c:/repo', 'win32'), 'c:\\repo')
  assert.equal(pathComparisonKey('C:\\Repo\\', 'win32'), 'c:\\repo')
  // Only a *trailing* separator is collapsed, which is the pre-existing rule: a
  // doubled separator between segments is a malformed path, not a spelling of a
  // single separator, so it is left alone rather than quietly repaired.
  const doubledTrailing = 'C:' + '\\' + 'Repo' + '\\' + '\\'
  assert.equal(pathComparisonKey(doubledTrailing, 'win32'), 'c:\\repo')
  const doubledInterior = 'C:' + '\\' + '\\' + 'Repo'
  assert.equal(pathComparisonKey(doubledInterior, 'win32'), 'c:\\\\repo')
  // Same directory written four ways: one key.
  const windowsForms = ['C:\\Repo', 'c:/repo', 'C:\\Repo\\', 'c:\\REPO']
  assert.equal(new Set(windowsForms.map(form => pathComparisonKey(form, 'win32'))).size, 1)

  // --- POSIX: forward slashes, case preserved ---
  assert.equal(pathComparisonKey('/home/u/repo', 'linux'), '/home/u/repo')
  assert.equal(pathComparisonKey('/home/u/repo/', 'linux'), '/home/u/repo')
  assert.equal(pathComparisonKey('/home/u/repo///', 'linux'), '/home/u/repo')
  assert.equal(pathComparisonKey('/home/u/repo', 'darwin'), '/home/u/repo')
  // Two directories that differ only by case are two directories.
  assert.notEqual(pathComparisonKey('/home/u/Repo', 'linux'), pathComparisonKey('/home/u/repo', 'linux'))
})

test('case folding diverges between the platforms, which is the whole point', () => {
  const mixed = '/home/u/Repo'
  const lower = '/home/u/repo'
  // Windows collapses the pair; POSIX keeps them apart.
  assert.equal(pathComparisonKey(mixed, 'win32'), pathComparisonKey(lower, 'win32'))
  assert.notEqual(pathComparisonKey(mixed, 'linux'), pathComparisonKey(lower, 'linux'))
  // And the platform-native wrapper agrees with its own platform's rule.
  assert.equal(normalizePath('C:/Repo'), process.platform === 'win32' ? 'c:\\repo' : 'C:/Repo')
})

test('a configured identity is matched by its cwd through the comparison key', async () => {
  const maildir = await makeMaildir()
  // Written with the opposite separator and mixed case: on Windows this must
  // still resolve to the `repo` role, and on POSIX it must resolve too because
  // the host reports the very same string back.
  const configured = process.platform === 'win32' ? 'C:\\Repo' : '/tmp/Repo'
  const reported = process.platform === 'win32' ? 'c:/repo/' : '/tmp/Repo'
  const identities = [{ role: 'repo', name: 'repo', cwd: configured, inbox: 'to-repo.jsonl' }]
  const host = await createHost({
    maildir,
    identities,
    agents: [{ id: 'session-eeeeeee5-eeee-4eee-8eee-eeeeeeeeeee5', cwd: reported }],
  })
  try {
    // The identity resolves, which is what makes this session a mailbox endpoint
    // and what stamps its role on every message it sends.
    const outcome = await host.agents[0].tools.get('mail_send').execute(
      { to: 'repo', topic: 'info', body: 'anchor: same directory, different spelling' },
      { agent: host.agents[0] },
    )
    assert.equal(typeof outcome.id, 'string')
    assert.equal(host.warnings.filter(line => /no identity|not an endpoint/.test(line)).length, 0)
  } finally {
    host.stop()
  }
})

test('on POSIX a case-different cwd is a different identity, and the call site enforces it', async () => {
  const maildir = await makeMaildir()
  // One identity, and a session whose cwd differs from it only by case. On
  // Windows that is the same directory, so the session resolves to the role; on
  // POSIX it is a different directory, so the session has no mailbox identity
  // and role addressing must be refused rather than quietly attributed to
  // another identity's inbox. That refusal is the behaviour this fix protects.
  const configured = process.platform === 'win32' ? 'C:\\repo' : '/tmp/repo'
  const reported = process.platform === 'win32' ? 'C:\\Repo' : '/tmp/Repo'
  const identities = [{ role: 'repo', name: 'repo', cwd: configured, inbox: 'to-repo.jsonl' }]
  const host = await createHost({
    maildir,
    identities,
    agents: [{ id: 'session-ddddddd4-dddd-4ddd-8ddd-ddddddddddd4', cwd: reported }],
  })
  try {
    const send = host.agents[0].tools.get('mail_send').execute(
      { to: 'repo', topic: 'info', body: 'anchor: is this cwd the configured directory?' },
      { agent: host.agents[0] },
    )
    if (process.platform === 'win32') {
      // Same directory, so the role resolves and the send is accepted.
      const outcome = await send
      assert.equal(typeof outcome.id, 'string')
    } else {
      await assert.rejects(send, /role addressing requires a mailbox identity/)
    }
  } finally {
    host.stop()
  }
})
