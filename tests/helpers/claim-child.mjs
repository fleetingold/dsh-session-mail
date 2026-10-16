/**
 * Child-process entry for the cross-process claim tests: it tries to claim one
 * message exactly as a second dsh process would, optionally records delivery,
 * optionally holds the process open as a live claim owner, and reports the
 * outcome through a file. The parent spawns it with `stdio: 'ignore'`, so the
 * outcome never travels over a pipe.
 * @module dsh-session-mail/tests/helpers/claim-child
 */

import { stat, writeFile } from 'node:fs/promises'
import { markMessageDelivered, tryClaimMessage } from '../../mailbox.mjs'

const [maildir, role, msgId, sessionId, mode, outFile, ttlArg, releaseFile] = process.argv.slice(2)
const owner = { pid: process.pid, boot: 'child-boot' }
const result = await tryClaimMessage(maildir, {
  role, msgId, sessionId, owner, claimTtlMs: Number(ttlArg ?? 60_000),
})
if (result === 'mine' && mode === 'claim-and-deliver') {
  await markMessageDelivered(maildir, { role, msgId, sessionId, owner })
}
await writeFile(outFile, `${JSON.stringify({ result, pid: process.pid })}\n`, 'utf8')

if (mode === 'hold') {
  // Stay alive as the claim owner until the parent releases us, so a second
  // process runs while the owner is provably alive and holds the claim.
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const released = await stat(releaseFile).then(() => true, () => false)
    if (released) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
