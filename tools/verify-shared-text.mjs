/**
 * Verify that the two deployment constraints shared by `dsh-session-mail` and
 * `dsh-session-liveness` are still word-for-word identical.
 *
 * Those two blocks are part of the two plugins' interface: both read and write
 * one maildir, so the directory's properties are not either plugin's own
 * documentation. The anchors in `docs/规划-跨插件工具套件与文件级契约-2026-10-16.md`
 * §2.5 are defined as **this script plus the boundary it uses** — a hash quoted
 * without them is not reproducible, because a different extraction boundary
 * yields a different (still self-consistent) value.
 *
 * Boundary, precisely: for a given heading, take the following lines while they
 * are blockquoted; strip the leading `>` and one optional space; strip trailing
 * whitespace; stop at the first non-blockquoted line once any content has been
 * collected, and drop trailing blank lines. Nothing else is normalised.
 *
 * Usage: node tools/verify-shared-text.mjs [--mail <path>] [--liveness <path>]
 * Exits 0 when both statements match on both sides, 1 otherwise.
 *
 * Defaults resolve **relative to this script**, not to the working directory, so
 * the check can be run from anywhere (a CI job's arbitrary cwd, another
 * repository, a bare shell) without failing on a misleading ENOENT for a path
 * that was never meant to be relative to where you happened to stand.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const MAIL_SECURITY = resolve(repoRoot, argOf('--mail', 'SECURITY.md'))
const LIVENESS_README = resolve(repoRoot, argOf('--liveness', '../dsh-session-liveness/README.md'))

/** Statements paired with the heading each side uses. */
const PAIRS = [
  {
    name: 'A · maildir permissions',
    mail: { file: MAIL_SECURITY, heading: '### Shared statement A · maildir permissions' },
    liveness: { file: LIVENESS_README, heading: '### 共用声明 A · maildir 权限' },
  },
  {
    name: 'B · same machine + local filesystem',
    mail: { file: MAIL_SECURITY, heading: '### Shared statement B · same machine + local filesystem' },
    liveness: { file: LIVENESS_README, heading: '### 共用声明 B · 同机 + 本地文件系统' },
  },
]

/**
 * Extract one blockquoted statement under a heading.
 * @param spec - the file and the heading that introduces the statement.
 * @returns the statement text, newline-joined, with no trailing blanks.
 */
function extract({ file, heading }) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex(line => line.trim() === heading)
  if (start < 0) throw new Error(`heading not found in ${file}: ${heading}`)
  const out = []
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]
    if (!line.startsWith('>')) {
      // Blank lines between blockquote paragraphs are still inside the block, but
      // the first bare line after content ends it.
      if (out.length > 0) break
      continue
    }
    out.push(line.replace(/^>\s?/, '').replace(/\s+$/, ''))
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

const digest = text => createHash('sha256').update(text, 'utf8').digest('hex')

let allEqual = true
for (const pair of PAIRS) {
  const mail = extract(pair.mail)
  const liveness = extract(pair.liveness)
  const equal = mail === liveness
  if (!equal) allEqual = false
  console.log(pair.name)
  console.log(`  mail     ${mail.split('\n').length} lines  sha256:${digest(mail)}`)
  console.log(`  liveness ${liveness.split('\n').length} lines  sha256:${digest(liveness)}`)
  console.log(`  identical: ${equal}`)
  if (!equal) {
    const left = mail.split('\n')
    const right = liveness.split('\n')
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      if (left[index] !== right[index]) {
        console.log(`  first difference at line ${index + 1}:`)
        console.log(`    mail:     ${JSON.stringify(left[index])}`)
        console.log(`    liveness: ${JSON.stringify(right[index])}`)
        break
      }
    }
  }
}

console.log(`\nverbatim identical across both repositories: ${allEqual}`)
process.exitCode = allEqual ? 0 : 1
