import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readClaim } from '../mailbox.mjs'
import { makeMaildir, waitFor } from './helpers/fake-host.mjs'

const childPath = fileURLToPath(new URL('./helpers/claim-child.mjs', import.meta.url))

/**
 * Run one claim child to completion.
 * @param args - maildir, role, msgId, sessionId, mode, and outcome file.
 * @returns the child's exit code.
 */
function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, ...args], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', code => resolve(code))
  })
}

/**
 * Read one child's reported outcome.
 * @param outFile - outcome file the child wrote.
 * @returns the parsed outcome and the child pid.
 */
async function outcomeOf(outFile) {
  return JSON.parse(await readFile(outFile, 'utf8'))
}

test('exactly one of four racing dsh processes wins one message', async () => {
  const maildir = await makeMaildir()
  const outs = [0, 1, 2, 3].map(index => join(maildir, `race-${index}.json`))
  const codes = await Promise.all(outs.map((out, index) => runChild([
    maildir, 'repo', 'msg-race', `session-${index}`, 'claim-and-deliver', out,
  ])))
  assert.deepEqual(codes, [0, 0, 0, 0])

  const outcomes = await Promise.all(outs.map(outcomeOf))
  const winners = outcomes.filter(outcome => outcome.result === 'mine')
  assert.equal(winners.length, 1, `expected one winner, got ${JSON.stringify(outcomes)}`)

  const claim = await readClaim(maildir, 'repo', 'msg-race')
  assert.equal(claim.state, 'delivered')
  assert.equal(claim.pid, winners[0].pid)
})

test('a claim orphaned by a crashed process is taken over by the next process', async () => {
  const maildir = await makeMaildir()
  const crashedOut = join(maildir, 'crashed.json')
  assert.equal(await runChild([
    maildir, 'repo', 'msg-orphan', 'session-abcdef04-2345-4678-89ab-cdef0123456a', 'claim-only', crashedOut,
  ]), 0)
  assert.equal((await outcomeOf(crashedOut)).result, 'mine')
  const orphan = await readClaim(maildir, 'repo', 'msg-orphan')
  assert.equal(orphan.state, 'claimed')
  assert.equal(orphan.sessionId, 'session-abcdef04-2345-4678-89ab-cdef0123456a')

  const nextOut = join(maildir, 'next.json')
  assert.equal(await runChild([
    maildir, 'repo', 'msg-orphan', 'session-abcdef01-2345-4678-89ab-cdef01234567', 'claim-and-deliver', nextOut,
  ]), 0)
  assert.equal((await outcomeOf(nextOut)).result, 'mine')
  const recovered = await readClaim(maildir, 'repo', 'msg-orphan')
  assert.equal(recovered.state, 'delivered')
  assert.equal(recovered.sessionId, 'session-abcdef01-2345-4678-89ab-cdef01234567')
})

test('a claim held by a live process is refused to a second process', async () => {
  const maildir = await makeMaildir()
  const holderOut = join(maildir, 'holder.json')
  const releaseFile = join(maildir, 'release')
  const holder = spawn(process.execPath, [
    childPath, maildir, 'repo', 'msg-live', 'session-abcdef02-2345-4678-89ab-cdef01234568', 'hold', holderOut, '60000', releaseFile,
  ], { stdio: 'ignore' })
  const holderExit = new Promise((resolve, reject) => {
    holder.on('error', reject)
    holder.on('exit', resolve)
  })
  try {
    const claimed = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(holderOut, 'utf8'))
      } catch {
        // The holder writes its outcome a moment after it starts.
        return undefined
      }
    })
    assert.equal(claimed.result, 'mine')
    assert.equal((await readClaim(maildir, 'repo', 'msg-live')).pid, claimed.pid)

    const secondOut = join(maildir, 'second.json')
    assert.equal(await runChild([
      maildir, 'repo', 'msg-live', 'session-5555555b-5555-4555-8555-55555555555b', 'claim-and-deliver', secondOut,
    ]), 0)
    assert.equal((await outcomeOf(secondOut)).result, 'held')
    assert.equal((await readClaim(maildir, 'repo', 'msg-live')).sessionId, 'session-abcdef02-2345-4678-89ab-cdef01234568')
  } finally {
    await writeFile(releaseFile, 'release\n', 'utf8')
    await holderExit
  }
})
