# Security Policy

`dsh-session-mail` moves operational messages between sessions **on one machine** through a
directory of plain JSONL files. Its security model is unusually small, and this document states it
plainly so that nobody mistakes the mailbox for an access-control mechanism.

## Reporting a vulnerability

Open a private security advisory on the repository (GitHub → **Security** → **Report a
vulnerability**). Please do not open a public issue for anything that could leak message contents or
session ids.

Include: the version (`package.json` → `version`), the operating system, the relevant `config`
(excluding your own paths if you prefer), and the smallest reproduction you have. This is a
volunteer-maintained project: expect an acknowledgement rather than a service-level commitment.

## Supported versions

Only the latest published version is supported. The plugin is `0.x`: breaking changes are possible
between minor versions and are called out in `CHANGELOG.md`.

Compatibility baseline: this release is verified against **`@deepseek-ai/dsh-root` 0.1.5-rc.2**. See
the README for what that claim does and does not cover.

## Threat model

The permissions of the maildir are the whole access control, and that statement is shared verbatim
with the `dsh-session-liveness` plugin — see **Deployment cautions → Shared statement A** below,
which is the canonical copy in this file.

### `owner.json` is a discipline layer, not a security boundary

The roster (`<maildir>/owner.json`) decides which session may consume a role inbox. It is read from
the same directory as the messages, so anyone who can write a message can also rewrite the roster.
When the roster is missing or empty the plugin deliberately **falls open** rather than locking
everyone out — the process discipline documented in the protocol is the real defence, not this file.

Do not treat a roster entry as a grant of trust, and do not treat the absence of one as a
protection.

### Tool surface

`mail_send`, `mail_budget`, `mail_drain`, `session_archive`, `session_unarchive`, and
`session_archived_list` are attached to **root** agents. Anything a root agent can be talked into
doing, these tools can do, including:

- **`session_unarchive` performs no existence check on the id.** That is deliberate: the archive set
  can outlive a session log, and an id with no surviving log must still be removable, otherwise a
  dangling entry could never be cleared. The consequence is that this tool will happily accept an id
  that names nothing.
- **`session_archive` / `session_unarchive` act on the host's workspace registry.** Archiving hides
  a session from lists, groups, and search; it does not delete the session log and does not free
  disk.

### What is written to disk

- **Message bodies are stored in cleartext**, both in the maildir and, after delivery, in the target
  session's durable inbox.
- The **delivery ledger** (`<maildir>/.ledger/<YYYY-MM-DD>.jsonl`) records one structured line per
  delivery and settlement decision and records **metadata only — never a message body**. That is
  intentional: the ledger is a diagnostic surface, not an archive. Retention is bounded
  (`ledgerRetentionDays`) and expired day files are *archived*, not deleted.
- Claim records and their archive are retained, also never containing bodies.

### Network surface

The host half registers one **read-only** same-origin HTTP route, `GET /session-mail/mailbox`, which
serves the mailbox contents to the Web UI. It is registered through the optional `webServer` service
(a deployment without a web server skips it entirely) and requests pass the host's
`connection.requestRejection` trust fence. There is no other network listener and no outbound
connection.

## Deployment cautions

### Shared statement A · maildir permissions

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

### Shared statement B · same machine + local filesystem

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

**Why this matters here.** The exactly-once delivery protocol relies on exclusive file creation
(`O_CREAT|O_EXCL`) and atomic `rename` to decide which process owns a message, so a network
filesystem's missing guarantees let the same message be delivered twice. And presence records are
judged live by heartbeat freshness plus a process-id probe, which says nothing about a process on
another machine. Do not place the maildir in a synchronised folder either — a sync service is a copy
of every message leaving the machine.

**Case-sensitive targets.** Internal ids are mapped to file names without case folding, so on a
case-insensitive filesystem (Windows) two ids differing only by case collide onto one file; on a
case-sensitive filesystem they do not. Session ids are generated lowercase and roles are normally
configured lowercase, so this needs a deliberate configuration to trigger — but it is a real
difference between platforms.

**This section is shared.** Statements A and B are **word-for-word identical** to the ones in
`dsh-session-liveness`'s README (section 「部署约束与 maildir 权限（与 `dsh-session-mail` 共用声明）」),
because both plugins share one maildir and the constraints are properties of that directory rather
than of either plugin. They are part of the two plugins' interface: **change them in both
repositories, in the same words.**

## Scope

In scope: the plugin's own code (`index.mjs`, `mailbox.mjs`, `src/`, `lib/`).

Out of scope: the host runtime (`@deepseek-ai/dsh-*`), the operating system and filesystem
behaviour, and anything a session does with the messages it receives — the mailbox delivers text to
an agent, and what that agent then does is the agent's business.
