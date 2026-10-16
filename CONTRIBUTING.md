# Contributing

Thanks for looking. This is a small, single-maintainer plugin, so the most useful contributions are
bug reports with a reproduction and focused patches. Please open an issue before starting anything
large, so we do not both write the same thing.

## Getting set up

There is **nothing to install** to work on the host half or to run the tests: the test suite uses
only Node built-ins, and it never mounts a real host.

```sh
git clone <repository>
cd dsh-session-mail
node --version          # need >= 22
node --test "tests/*.spec.mjs"
```

That suite is the contract. It runs in about a second and must be green before you open a pull
request.

### Syntax check

```sh
node --check index.mjs
node --check mailbox.mjs
```

### The client bundle

`src/client/` is TypeScript/TSX and is **not** loaded directly; it is built into `lib/client.js`,
which is what the Web UI loads. **This build is currently not reproducible from a clean checkout** —
the toolchain is taken from a sibling `deepseek-harness` checkout, and `lib/` is not tracked. If your
change touches `src/client/`, say so in the pull request and expect the maintainer to handle the
build; making the build self-contained is tracked as an open item.

## Conventions

**Commits** follow [Conventional Commits](https://www.conventionalcommits.org/), which is how
`CHANGELOG.md` is maintained. Use a scope that names the area, and describe the behaviour rather than
the edit:

```
feat(delivery): report whether a delivery opened a turn, on both routes
fix(addressing): refuse a well-formed id that names no session
docs(readme): ...
test(claims): pin exactly-once broadcast claims
```

**Behaviour changes need a test.** Each test file is named for the behaviour it pins
(`tests/wake-receipt.spec.mjs`), and it should carry a comment saying what the case is for. Prefer
adding a case to the existing file over creating a new one.

**Test fixtures must be synthetic, and the de-identification scan must be driven by real ids only.**
Session ids are opaque, so fixtures are invented placeholders — but the check that they really are
placeholders has to come from outside the repository. `tools/scan-session-id-traces.mjs` takes a
corpus of **real** ids as a file path precisely so no real id ever enters the repository or the
artifact, and it reports counts and locations only, never a matched string.

Two rules when you run it, both learned from a false alarm:

- **The corpus must contain real ids only.** A corpus that also carries the test suite's own
  synthetic fixtures reports hits that are *not* leaks, because the fixtures quote themselves in
  test files and docs. On 2026-10-16 such a corpus reported 18 hits across `docs/`, while a
  real-id-only corpus reported 0 on the same tree.
- **A hit is leakage evidence only if it derives from a real id you put in the corpus.** `exit 1`
  means "some string equals a derived form of some corpus id" — not "this repo leaks". Triage from
  the corpus side before acting.

**Never assert on state a later asynchronous step establishes.** Four test flakes have come from
this one family, and every fix was in the test. The shapes it takes:

- reading `host.logs`, `host.warnings`, `agent.received`, or an inbox/ledger/claim file
  **synchronously** after a non-blocking trigger (`host.emit(...)`, `host.runPolls()`) that only
  *starts* the work;
- treating **stability as arrival** — a loop that waits for "two consecutive reads agree" is
  satisfied by two equally early reads, so it can take a baseline before anything has been written;
- using a **count or length as if it were the state** — `records.length >= 3` was satisfied by an
  unrelated record the mount scan had already written;
- depending on **a transition nobody asked for** — under the stand-in host the plugin's own timers do
  not fire, so a pass that must run after a state change has to be requested explicitly. A quiesce
  loop can hide this by happening to run it.

The rule of thumb: `await waitFor(...)` on the exact thing the assertion then reads. Waiting may
never widen what is asserted — if the state never arrives, the test must still fail.

**Do not log message bodies.** The mailbox carries coordination content between sessions. The
delivery ledger deliberately records metadata only; diagnostics added to it must do the same.

**Config schema changes are public API.** Every field in `Config` is something a user writes into
their profile patch, so adding, renaming, or re-defaulting one is a change users feel. Record it
under a **Configuration changes** heading in `CHANGELOG.md` in the same pull request.

**Protocol format changes are cross-plugin API.** The files under the maildir — `.presence/`,
`direct/`, `.claims/`, `.ledger/` — are a file-level interface that another plugin consumes.
Changing a field name or a directory name breaks that plugin with no compile error anywhere. Do not
change one without calling it out explicitly in the pull request and in `CHANGELOG.md`.

## Platform support

The core (host half, mailbox, tests) is intended to work on Windows, Linux, and macOS. The
**operations and deployment scripts (`*.ps1`) and the service-management guidance are Windows-only**
and will stay that way.

## Pull requests

Keep one concern per pull request. In the description, say what you observed, what you changed, and
how you verified it — a paste of the relevant `node --test` output is ideal. If you changed
behaviour, note whether anything user-visible moved (tool output fields, log lines, on-disk
formats).

By contributing you agree that your contribution is licensed under the MIT licence in `LICENSE`.
