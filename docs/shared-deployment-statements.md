# Shared deployment statements (ABI with the companion liveness plugin)

Two constraints follow from the fact that this plugin and its companion — a Session-liveness plugin
that reads and writes the **same maildir** — share one directory. They are therefore properties of
that directory rather than of either plugin, and they are part of the two plugins' interface.

**The two statements below are word-for-word identical in both repositories.** Each side names the
other. Change them in both, in the same words.

| Statement | Where it lives on each side |
|---|---|
| **A · maildir permissions** | here as [`#shared-statement-a`](#shared-statement-a--maildir-permissions) and in `SECURITY.md` under *Deployment cautions*; the companion's README carries the same text |
| **B · same machine + local filesystem** | same three places |

The companion repository is **not** open sourced yet, so the check described below cannot run against
a sibling checkout here. That is expected, and it is reported rather than skipped.

## Why these are interface, not documentation

Both plugins exchange files inside the maildir: presence records, per-message delivery claims, and a
control channel for cross-process hold release. A reader in one plugin consumes what the other
writes, with **no shared types, no shared code, and no version handshake** — only directory names and
field names, plus the two constraints below. If either side's documentation drifts, whichever half a
user happens to read is wrong, and nothing fails loudly.

## Shared statement A · maildir permissions

> **The maildir's file permissions are the entire access control.**
>
> There is **no authentication, no authorization, no encryption, and no signing** anywhere in the
> delivery path. Every message is a UTF-8 JSON object on one line, in cleartext.
>
> Whatever can read the maildir can read every message that has not yet been rotated away; whatever
> can write it can forge one. The plugin does not create the directory with a restrictive mode and
> does not tighten it afterwards — on POSIX systems the store therefore inherits your process umask
> (commonly `0755` for directories, `0644` for files), which on a shared machine means **any local
> user can read the mailbox**.
>
> **Do this**: create the maildir yourself with owner-only permissions and keep them that way.
>
> ```sh
> mkdir -m 0700 <your-maildir>
> chmod -R go-rwx <your-maildir>   # after it exists
> ```

## Shared statement B · same machine + local filesystem

> **The maildir must live on a local filesystem, and every participating dsh process must run on the
> same machine.**
>
> The presence, claim, and liveness protocols exchange files — exclusive creation, atomic `rename`,
> and unlink — whose guarantees a network filesystem (NFS/SMB) or a synchronised folder does not
> provide; the failure is silent, and the same work can be done twice.
>
> They also identify a process by **PID**, which is meaningful only on the machine that allocated it.
> The `.liveness/` control channel routes each release request by PID, so sharing one maildir across
> machines cannot work and can mis-route a request to an unrelated process.

## Verifying the two sides match

`tools/verify-shared-text.mjs` extracts each statement from both repositories and compares them byte
for byte, exiting non-zero on any difference. Run it from anywhere — it resolves its inputs relative
to itself, not to the current directory.

```sh
node tools/verify-shared-text.mjs --liveness <path-to-companion-checkout>/README.md
```

### The anchor is the script **plus its boundary**, never a bare hash

A bare sha256 is not reproducible: a different extraction boundary yields a different — and equally
self-consistent — value. The comparison that produced this document's numbers was in fact reproduced
independently under a second boundary and produced different absolute hashes with the same
"identical on both sides" conclusion. So any hash quoted for these statements is meaningful **only**
together with the script and this boundary:

> Take the lines following the heading while they are blockquoted; strip the leading `>` and one
> optional space; strip trailing whitespace; stop at the first non-blockquoted line once any content
> has been collected; drop trailing blank lines. **Nothing else is normalised** — no whitespace
> collapsing, no newline conversion, no character stripping.

The four inputs are `SECURITY.md`'s two `### Shared statement …` sections on this side, and the
companion README's two `### 共用声明 …` sections on the other.
