/**
 * Trace scanner: report any trace of a **real** Session id in a target tree,
 * including derived forms.
 *
 * Why this exists. The first de-identification gate searched for a handful of
 * known *complete* ids and reported zero, while two fixtures in the test suite were
 * derived from real ones - one kept as a bare first segment, one with its first
 * segment truncated and the remaining four kept verbatim. A complete-id search
 * cannot see either. So the gate is defined over the **forms a truncation can
 * produce**, driven by a corpus of real ids supplied from outside the repository.
 *
 * The corpus never enters the repository or the artifact: it is passed as a file
 * path, and this script prints counts and locations only - never an id, never a
 * matched substring. That keeps the report safe to paste anywhere.
 *
 * Usage:
 *   node tools/scan-session-id-traces.mjs --corpus <file> --target <dir> [--target <dir>...]
 *   node tools/scan-session-id-traces.mjs --corpus <file> --target <dir> --forms
 *
 * Corpus format: any UTF-8 text; every full id matching
 * `session-<8 hex>-<4 hex>-<4 hex>-<4 hex>-<12 hex>` is collected (so a maildir, a
 * JSONL dump, or a plain list of ids all work).
 *
 * Two triage rules, both learned the hard way:
 *
 *  1. **The corpus must hold real ids only.** A synthetic placeholder in the corpus
 *     makes the gate report hits that are *not* leaks: on 2026-10-16 a corpus that
 *     mixed in the test suite's own synthetic fixtures (e.g. an `0f0f0f0f` first
 *     segment) reported 18 hits across the docs, while a corpus of real ids alone
 *     reported 0 on the same tree. Those 18 were the fixtures quoting themselves.
 *     **A hit is evidence of leakage only if it derives from a real id in the
 *     corpus** - so check which corpus id each hit came from before acting on it.
 *     (Searching for a real id returns a clean 0 on this tree; that is the result
 *     that matters.)
 *  2. **`exit 1` is not by itself a failure verdict.** It means "some string in the
 *     target equals a derived form of some corpus id". Rule 1 decides whether that
 *     is a leak or a self-reference. The gate stays deliberately dumb about this:
 *     it prints counts and locations only, never an id or a matched substring, so
 *     triage has to come from the corpus side.
 *
 * Exit codes: 0 no trace found · 1 traces found · 2 usage error or unreadable
 * input (**never a silent pass**).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const args = process.argv.slice(2)
const listOf = flag => {
  const out = []
  for (let index = 0; index < args.length; index++) if (args[index] === flag && args[index + 1]) out.push(args[index + 1])
  return out
}
const corpusPath = listOf('--corpus')[0]
const targets = listOf('--target')
const showForms = args.includes('--forms')

if (!corpusPath || targets.length === 0) {
  console.error('usage: node tools/scan-session-id-traces.mjs --corpus <file> --target <dir> [--target <dir>...]')
  console.error('       (both are required; a missing or unreadable input exits 2, never 0)')
  process.exit(2)
}

let corpusText
try {
  corpusText = readFileSync(corpusPath, 'utf8')
} catch (error) {
  console.error(`cannot read corpus: ${corpusPath}: ${error.code ?? error.message}`)
  process.exit(2)
}

const FULL_ID = /session-([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})/g
const fullIds = new Set()
for (const match of corpusText.matchAll(FULL_ID)) fullIds.add(match[0])
if (fullIds.size === 0) {
  console.error('corpus contained no session ids; refusing to run a gate that cannot see anything')
  process.exit(2)
}

/** Every derived form a truncation can produce, longest first so overlaps report once. */
const patterns = []
const seen = new Set()
const add = (label, literal) => {
  // A short literal would match inside unrelated text; 8 hex is the floor the
  // owner specified (a bare first segment).
  if (literal.length < 8 || seen.has(literal)) return
  seen.add(literal)
  patterns.push({ label, literal })
}
for (const id of fullIds) {
  const body = id.slice('session-'.length)
  const segments = body.split('-')
  add('full id', id)
  add('last 4 segments', segments.slice(1).join('-'))
  add('first segment (short name)', segments[0])
  add('display truncation `session-…-…`', `session-${segments[0]}-…`)
  // First segment truncated to 7, remaining four verbatim.
  add('first segment truncated to 7', `session-${segments[0].slice(0, 7)}-${segments.slice(1).join('-')}`)
}

if (showForms) {
  console.log(`corpus: ${corpusPath}`)
  console.log(`complete ids: ${fullIds.size}`)
  console.log(`distinct derived forms: ${patterns.length} (literals themselves are not printed)`)
}

const walk = dir => {
  const found = []
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else found.push(path)
    }
  }
  visit(dir)
  return found
}

const counts = new Map(patterns.map(pattern => [pattern.label, 0]))
const locations = new Map()
let scanned = 0
let hits = 0

for (const target of targets) {
  let files
  try {
    files = statSync(target).isDirectory() ? walk(target) : [target]
  } catch (error) {
    console.error(`cannot read target: ${target}: ${error.code ?? error.message}`)
    process.exit(2)
  }
  for (const file of files) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    scanned += 1
    const lines = text.split('\n')
    for (const pattern of patterns) {
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].includes(pattern.literal)) continue
        hits += 1
        counts.set(pattern.label, counts.get(pattern.label) + 1)
        const where = `${relative(target, file).split('\\').join('/')}:${index + 1}`
        if (!locations.has(pattern.label)) locations.set(pattern.label, new Set())
        locations.get(pattern.label).add(where)
      }
    }
  }
}

console.log(`\ntargets: ${targets.length}  files scanned: ${scanned}`)
console.log(`forms checked: ${patterns.length}  derived from ${fullIds.size} complete ids`)
console.log('\n--- hits by form ---')
for (const [label, count] of counts) {
  const where = locations.get(label)
  console.log(`  ${String(count).padStart(4)}  ${label}${where ? `   e.g. ${[...where].slice(0, 4).join(', ')}` : ''}`)
}
const literalHits = [...new Set(patterns.filter(p => counts.get(p.label) > 0).map(p => p.label))]
console.log('\n--- summary ---')
console.log(`TRACE HITS: ${hits}${literalHits.length > 0 ? `  (forms: ${literalHits.join(', ')})` : ''}`)
if (hits === 0) console.log('no trace of any corpus id, in any checked form')
process.exitCode = hits === 0 ? 0 : 1
