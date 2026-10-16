/**
 * Report whether one session log carries given needles. `.jsonl.zstd` is a
 * container of concatenated Zstandard frames, and a single-frame decode stops
 * after the header, so the harness's own frame scanner does the decoding.
 *
 * Usage: node --import <tsx> tests/helpers/session-log.mjs <harnessRepo> <logFile> <needle>...
 * @module dsh-session-mail/tests/helpers/session-log
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const [harnessRepo, logFile, ...needles] = process.argv.slice(2)
if (harnessRepo === undefined || logFile === undefined) {
  console.error('usage: session-log.mjs <harnessRepo> <logFile> <needle>...')
  process.exit(2)
}

const zstdUrl = pathToFileURL(join(harnessRepo, 'packages/session/session-persistence-jsonl/src/zstd.ts')).href
const { scanZstdFrames, decompressZstdFrame } = await import(zstdUrl)

if (!fs.existsSync(logFile)) {
  console.log(JSON.stringify({ logFile, exists: false }))
  process.exit(0)
}
const buffer = fs.readFileSync(logFile)
const { frames } = scanZstdFrames(buffer)
let text = ''
for (const frame of frames) {
  text += (await decompressZstdFrame(buffer.subarray(frame.start, frame.end))).toString('utf8')
}
const report = { logFile, exists: true, frames: frames.length, events: text.split('\n').filter(line => line.length > 0).length }
for (const needle of needles) report[needle] = text.includes(needle)
console.log(JSON.stringify(report))
