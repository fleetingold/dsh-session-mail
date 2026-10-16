# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is `0.x`, a minor
bump may contain breaking changes; those are prefixed **BREAKING** below.

> **Note on history.** The entries below `0.7.0` were reconstructed from the commit history and the
> README at the time these notes were written. Only `v0.3.0` and `v0.4.0` were ever tagged, so the
> version boundaries for `0.5.0`–`0.7.0` are inferred from the work each commit completes. Treat the
> grouping as indicative and the commit hash as authoritative.

## [Unreleased]

### Added

- **`session_create` and `workspace_create` moved here** from the  `dsh-session-liveness` plugin, so every model tool this deployment offers is
  registered by one plugin. The tool names, parameter schemas, output schemas,
  call presentations, and rendered text are **unchanged** — a caller or a model
  that knew these tools cannot tell they moved. `session_create`'s rendered text
  still points at `mail_send`, which is now its own package's tool.
- `session-tools.mjs`: the helpers behind those tools — the same-repository and
  registered-Workspace target guards, repository-root discovery, and the
  workspace/group lookups. They are pure host-side functions whose services are
  parameters, so they run under plain Node with no host and no dependencies.
  Path comparison is platform-aware here (case-insensitive on Windows only).
- A second system-prompt section, `tool:session-create`, describing the creation
  tools. It is separate from `tool:session-mail` because it answers to a separate
  switch: a deployment that turns the tools off should not leave the model told
  about tools it does not have.
- Open-source readiness material: `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, and this changelog.
- A non-official notice and an explicit compatibility statement in the README.
- A `license` field in `package.json` (MIT).

### Changed

- **Path comparison is now platform-aware** instead of folding every workspace path
  the Windows way. Windows behaviour is **unchanged** (`/` becomes `\`, a trailing
  separator is dropped, the whole path is lowercased). On POSIX the separator stays
  `/` and **case is preserved**, because `/home/u/Repo` and `/home/u/repo` are two
  different directories there: folding them made one identity's sessions resolve to
  another identity's inbox, and refused nothing while doing it. Only a *trailing*
  separator is collapsed on either platform.
  The rules live in `pathComparisonKey(path, platform)`, with `normalizePath` as
  the current-platform wrapper, so both rules are tested on every OS rather than
  only the one the suite happens to run on.
- **`Config.createTool` is now this plugin's switch** (default `true`), governing
  the two creation tools as one unit. It moved with them from
  `dsh-session-liveness`; the name, default, and meaning are unchanged, so an
  existing profile patch keeps working.
- **Configuration changes:** none beyond the added `createTool`. Every existing
  field keeps its name, type, and default.

### Migration note

- `dsh-session-liveness` still registers its own copies of these two tools, and
  the host **throws** on a duplicate tool name in one scope rather than
  overwriting it — a throw that plugin's attach path catches and logs, so the
  visible symptom is the tools quietly disappearing at runtime. **Set
  `createTool: false` on the `session-liveness` row before this version takes
  effect**, and remove the plugin's copy in its next minor. The switch order,
  verification list, and rollback steps are in
  `docs/B′ 切换与回滚运行手册-2026-10-16.md`.

### Release note

- **The open-source first release is scoped to this repository only**;
  `dsh-session-liveness` is not part of it and is deferred to a later batch. That
  is a release-scope decision, not a change of code ownership: this package still
  carries all eight tools.
- **De-identification and metadata for the release are DONE**, as of the commit that
  carries this note: absolute user paths, real session ids, and internal project
  names are removed from everything that ships, and `package.json` carries the
  scoped name, `private: false`, and the rest of the publish surface. What is *not*
  shipped at all: the Windows-only operations scripts, the probe profiles, and the
  internal planning documents, which are excluded by policy rather than cleaned.
- **A release gate covers derived id forms, not just complete ids.**
  `tools/scan-session-id-traces.mjs` scans a target tree for any trace of a real
  Session id, taking the real-id corpus as an external file and checking the forms a
  truncation produces: the complete id, the last four segments, the bare first
  segment, a display truncation, and a first segment cut short. A missing corpus
  exits non-zero rather than passing. The three test fixtures that motivated it are
  synthetic and were verified against the corpus.
- **CI cannot be fully enabled yet**: `bundle`'s E1 guard fails by design while E1
  is undelivered, so enable only the `logic` job. Recorded in the release plan and
  in the workflow's header.

### Known issues

- **No known flakes.** The four members of one family are fixed, and the full
  suite ran **20 consecutive times with 0 failures**. All four were test-side; no
  product code changed, and no fix widened what is asserted.

  The family is "an assertion reads state a later asynchronous step establishes".
  It appeared in four shapes, now written down in `CONTRIBUTING.md` so new tests
  do not reintroduce it: a synchronous read of logs/inbox/ledger after a
  non-blocking trigger; stability mistaken for arrival; a count used as if it were
  the state; and depending on a transition nobody asked for.

  The last one is worth naming: under the stand-in host the plugin's own timers do
  not fire, so a poll pass that must run after a state change has to be requested.
  A quiesce loop that happened to request one hid the gap and made the failure look
  random. Fixing only the visible predicate first made it fail 13 times in 20 —
  which is what exposed the real cause.

- **Two test flakes fixed (2026-10-16), both test-only.** Full suite: **20
  consecutive runs, 0 failures** (was: the goal flake in 5 of 10 runs, and a rarer
  ledger flake).

  1. **`goal-disarm-notice.spec.mjs`** asserted the edge's `goal-disarm-edge`
     trace by reading the log synchronously right after waiting for the notice
     count to reach one. Those are two different moments and the notice comes
     first: delivery writes the message into the direct pool, and only then does
     the handler's `.then` record the trace. On a loaded machine the assertion
     raced the write. Reproduced with a probe: the notice was there, the trace was
     not, and waiting for the trace separately always produced it within 200ms.
     The assertion now awaits the trace instead of assuming it landed, so a run in
     which the edge never records one still fails.
  2. **`delivery-ledger.spec.mjs`** waited for `readLedgerRecords(maildir).length >= 3`,
     which the mount scan's own `goal-disarm-scan` line can satisfy on its own;
     the settlement record, written a moment after the claim reaches its terminal
     state, was then still in flight when the assertion read the file (observed as
     `['delivery', 'delivery']`). The wait and the assertion now share a predicate
     that counts only the scenario's records.

  Neither fix touches product code, and neither widens what is asserted.

## [0.7.0] — 2026-09-28

Commit: `bd35ff9`.

### Added

- **Wake-budget visibility.** The `mail_send` receipt now carries
  `wakeBudget { spent, limit, refillsOn: 'non-mailbox-input' }`, read *after* the delivery decision.
  The `relay` and `mailbox` routes report no reading rather than inventing a number, because another
  process owns that target.
- **`mail_budget` tool** (read-only): read the same budget *before* sending. It reports three states
  — sufficient, exhausted, unknown — and an unknown reading always names its reason.

### Notes

- This budget is this plugin's own `Config.maxConsecutiveWakes`. It is **independent** of the
  job-notification budget in `tool-jobs`: two counters, counted and refilled separately. Only the
  former decides whether `mail_send` opens a turn.

## [0.6.6] — 2026-09-26

Commit: `ca7ac19`.

### Added

- **`session_unarchive { session_id }`** — clear a full session UUID from the archive set. Idempotent
  (`unarchived: false, alreadyActive: true` when the id is not archived, with no state write), and it
  deliberately **does not check that the session exists**: the archive set can outlive a session log,
  and a dangling id must still be removable. A host without `workspaceRegistry.unarchiveSession`
  fails loudly rather than reporting a restore that did not happen.

## [0.6.5] — 2026-09-26

Commit: `170d7e9`.

### Added

- **`session_archive { session_id }`** — archive by full session UUID. Idempotent (an id already in
  the archive set returns `archived: false, alreadyArchived: true` without calling the host), a
  malformed id is refused with no side effect, and an unknown session surfaces the host's own error.
- **`session_archived_list {}`** — read-only; returns `{ count, archivedSessionIds }`.

### Notes

- Archiving is a **global hidden set**: the session leaves the grouped list, the flat list, and
  search. It deletes no session log and frees no disk. Unarchiving restores the row and its position.
- `session_unarchive` requires a host that exposes `workspaceRegistry.unarchiveSession`; older
  builds keep `session_archive` and `session_archived_list` working and fail `session_unarchive`
  explicitly.

## [0.6.4] — 2026-09-26

Commits: `5c586a0`, `dcbb9a2`, `6758280`, `0b88c16`, `ff7fa4c`, `bed249d`, `fef7042`.

### Added

- **Four-state delivery receipt.** `mail_send` reports a required `woke` (did this delivery actually
  open a turn?) and `delivered` is split into `push` / **`injected`** (the message reached an idle
  target's inbox but opened no turn, so the target will not act on it) / `relay` / `mailbox`, with
  `mode`, `injectReason` (`target-running` / `wake-budget-exhausted` / `delivery-quiet`), and
  `failure`. An `inject` into an idle target always logs a warning, and `injected` is never reported
  as `push`.
- **Consumption settlement with bounded redelivery.** The claim state machine grew from
  `claimed → delivered` to `claimed → delivered → consumed | failed(reason)`. Retryable failures
  (`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`) get one redelivery
  (`maxRedeliveries`, default 1) armed on the session's *next* idle transition; quota, credential,
  and context failures are not retried and instead send a `topic: delivery-failed` receipt to the
  sender's direct pool. A user abort is never redelivered.
- **Undecided-wake backstop.** `wakeWindowMs` (default 10 minutes) settles a wake that never
  produced a decision; `wakeWindowExtensions` (default 3) extends the window while the target is
  still running that turn, to roughly 30 minutes total.
- **Recipient-id double check.** `to_session` must match the full lowercase session UUID shape;
  short forms and display-truncated forms are refused with no file written. A well-formed id is then
  probed through `sessionController.setHeld`: a definite `not-found` is refused without staging,
  while `agent-busy` or a transient error keeps the message staged.
- **Delivery ledger.** Every delivery and settlement writes one structured line via `ctx.logger.info`
  (falling back to `debug`, never `warn`) **and** to `<maildir>/.ledger/<YYYY-MM-DD>.jsonl`. Metadata
  only — **never a message body**. Daily size is capped (`ledgerMaxBytesPerDay`), and expired day
  files are archived (`ledgerRetentionDays`) into `.ledger/_archived/` with an append-only
  `MANIFEST.jsonl`. Ledger write failures never affect delivery: the claim is authoritative.
- **Claim retention by archiving.** Terminal claims older than `claimRetentionMs` are renamed into
  `.claims/<role>/_archived/` and recorded in the manifest. Nothing is deleted, and both
  `readClaim()` and `tryClaimMessage()` consult the archive before the active file, so archiving
  never turns a settled message back into a deliverable one.

### Fixed

- Settled inbox lines are skipped instead of having their claim re-attempted, removing ledger noise
  from every poll.

### Notes

- **Redelivery costs another model turn.** Set `maxRedeliveries: 0` to disable it globally.

## [0.6.3] — 2026-09-23

Commit: `939342d`.

### Added

- **Roster-designated role owner.** `owner.json` gained an optional `roleOwners` map
  (`{ "main": "session-<uuid>" }`). Role broadcast mail (a message with no `to_session`) prefers that
  role's designated owner and falls back to the previous rule when the owner is not live.

### Notes

- The fallback is `byAttachOrder` — the earliest-attached live session in this process — and is
  **independent of the roster array order**. With several live sessions in one role, coordination
  mail used to land in whichever session happened to attach first.

## [0.6.2] — 2026-09-23

Commit: `c6e0703`.

### Fixed

- **The wake budget now resets on outside inbox input.** `maxConsecutiveWakes` counts only this
  plugin's *own* consecutive wakes; any inbox insertion from another source (a human typing in the
  GUI, another plugin's notification) resets the target's budget. Before this release the comments
  claimed that behaviour but the code never implemented it, so once a target exhausted its budget
  every later delivery degraded to an injection and an idle session appeared to stop receiving mail
  entirely.

## [0.6.1] — 2026-09-22

Commit: `b6d9806`.

### Added

- Tests pinning exactly-once broadcast claims and the refusal to consume a role inbox from a session
  outside the roster.

## [0.6.0] — 2026-09-21

Commit: `f6db04b`.

### Added

- **Activate-on-send.** When a `to_session` target has no live session in any dsh process, the plugin
  revives it in this process (`sessionController.setHeld`) before delivering, so dispatching work no
  longer requires somebody to open the target first. A failed revival leaves the message staged and
  reports why. Disable with `activateOnSend: false`.

## [0.5.1] — 2026-09-21

Commit: `f5a2ff8`.

### Changed

- **BREAKING** (for identity-less senders): role addressing is restricted to identified sessions.

## [0.5.0] — 2026-09-21

Commit: `11ba0a3`.

### Added

- **Session-id addressing.** `to_session` became a general route: any root session — including forks
  and sessions in repositories with no configured identity — can exchange point-to-point messages by
  session id. Sending needs no identity, and a named target is reached through a per-addressee
  staging pool (`direct/<sessionId>.jsonl`) that each process's watcher claims from. Role inbox
  broadcast still belongs to the roster's main session only.

## [0.4.0] — 2026-09-18

Tag: `v0.4.0`. Commit: `f79f9f2`.

### Added

- **Cross-process delivery.** One maildir can now be shared by several dsh processes. Each process
  publishes heartbeat records in `.presence/` naming the sessions it hosts, and every message is
  claimed before delivery through an exclusive-create file in `.claims/`, so the live-session view is
  visible cross-process and exactly one process delivers each message.
- **Skip instead of block.** A line whose addressee is offline no longer holds back the lines behind
  it.
- A scripted acceptance gate for the real second-process delivery path (`acceptance-two-process.ps1`).

## [0.3.0] — 2026-09-15

Tag: `v0.3.0`. Commit: `30594fa`.

### Added

- The mailbox Web tab: a host route `GET /session-mail/mailbox` plus a client tab between Chat and
  Trajectory, with zh/en labels, five-second auto-refresh, and unread markers after the watermark.
- The wake mechanism, and the probe-verify gate that boots the full web surface on an idle port with
  a temporary maildir and checks four things: boot succeeded, the route answers 200, the boot graph
  contains the plugin row, and the **served** bundle bytes materialize into a callable factory. That
  last check exists because a 200 status does not mean the bundle is executable.
- A production restart guard requiring an explicit confirmation flag.
- Deployment snapshots and rollback (`sync.ps1`, `restore.ps1`).
