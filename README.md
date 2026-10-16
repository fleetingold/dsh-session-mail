# dsh-session-mail

A cross-session mailbox plugin for **DeepSeek Harness (DSH)**. It gives root Sessions a way to send
each other operational messages, and it delivers them the way a mailbox should: addressed, written
down, and settled once.

**English** · [中文](#中文说明)

> ## Non-official notice
>
> This is an **independent, community-maintained plugin**. It is **not affiliated with, endorsed by,
> or supported by DeepSeek**. "DeepSeek", "DSH", and "DeepSeek Harness" are used descriptively, to
> name the host runtime this plugin extends.
>
> It is **not** published under the `@deepseek-ai/*` scope and must not be. The `@deepseek-ai/*`
> packages it declares as peers are **not redistributed** with this project.
>
> **Licence:** MIT (see `LICENSE`).

---

## Contents

- [What it does](#what-it-does)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Configuration](#configuration)
- [Minimal runnable example](#minimal-runnable-example)
- [Compatibility](#compatibility)
- [Security and deployment constraints](#security-and-deployment-constraints)
- [Release boundary: what is not in this repository](#release-boundary-what-is-not-in-this-repository)
- [Known limitations](#known-limitations)

## What it does

Eight model tools, all attached to **root** Sessions:

| Tool | Purpose |
|---|---|
| `mail_send` | Send a message, addressed by role (`to`) or by exact Session id (`to_session`) |
| `mail_budget` | Read-only: a peer's wake budget, before sending |
| `mail_drain` | Pull messages addressed to this Session (`backlog: true` recovers earlier ones) |
| `session_archive` | Hide a Session from every list, group, and search |
| `session_unarchive` | Clear a Session id from the archive set |
| `session_archived_list` | Read-only: the archive set |
| `session_create` | Create a peer Session, with a task-semantic title |
| `workspace_create` | Register a Workspace over an existing directory |

Delivery is durable and exactly-once per message: a message is claimed through an exclusive file
before it is handed over, an offline addressee's line never blocks the lines behind it, and a wake is
settled by what actually happened (a committed model response consumes it, a failed one settles it, a
bounded retry may redeliver once). Everything lives in a **maildir** — a directory of plain JSONL
files — so several dsh processes on one machine can share one mailbox.

## Prerequisites

- **Node.js ≥ 22.** The test suite uses `node --test` with a glob.
- **A DSH runtime** providing `@deepseek-ai/dsh-root`. Verified against **`0.1.5-rc.2`**; see
  [Compatibility](#compatibility).
- **A local maildir** you own, on a **local filesystem** — see
  [Security and deployment constraints](#security-and-deployment-constraints).
- **Windows is the verified operations platform.** The core (host half, mailbox, tests) is written to
  be platform-independent and its tests pass without a host process, but the deployment scripts this
  project was developed alongside are Windows-only, and the plugin has **not** been booted against a
  real DSH host on Linux.
- **Building the Web Tab needs a toolchain this repository does not currently provide.** See
  [Known limitations](#known-limitations) — the host half works without it.

## Install

Install the package into your DSH profile, then mount it.

```sh
# 1. From your DSH profile directory
pnpm add @fleetingold/dsh-session-mail
#   (or, from a checkout: pnpm add <path-to-this-checkout>)

# 2. Add the mount row below to the profile's cordis.patch.yml

# 3. Restart dsh-web: the loader patch is applied when the process starts
```

```yaml
# cordis.patch.yml
- insert:
    - id: session-mail
      name: dsh-session-mail
      config:
        maildir: '<your-maildir>'
        identities:
          - role: main
            name: main
            cwd: '<your-repo-a>'
            inbox: to-main.jsonl
          - role: frontend
            name: frontend
            cwd: '<your-repo-b>'
            inbox: to-frontend.jsonl
```

## Configuration

`maildir` and `identities[]` are required; everything else has a default.

| Field | Type / default | Meaning |
|---|---|---|
| `maildir` | string, **required** | The mailbox directory. **All** processes sharing a mailbox must point at the same path. |
| `identities[]` | array of `{ role, name, cwd, inbox }`, **required** | Who may be addressed by role. `role` is the `to` target; `cwd` matches a Session's working directory; `inbox` is the file that role reads. |
| `pollMs` | number ≥ 100, `800` | Inbox poll interval |
| `batchWindowMs` | number ≥ 0, `1500` | Window that absorbs rapid-fire sends into one batch |
| `delivery` | `wakeup` \| `quiet`, `wakeup` | Whether delivery may open a turn on an idle target |
| `maxConsecutiveWakes` | number ≥ 1, `3` | Consecutive wakes this plugin may spend on one target; any other inbox input resets it |
| `maxRedeliveries` | number ≥ 0, `1` | Bounded retry of a retryable failure. **A redelivery spends another model turn**; `0` disables it |
| `wakeWindowMs` | number ≥ 1000, `600000` | Backstop that settles a wake which never produced a decision |
| `wakeWindowExtensions` | number ≥ 0, `3` | How many times that window may be extended while the target is still running |
| `activateOnSend` | boolean, `true` | Revive an offline `to_session` addressee before delivering |
| `createTool` | boolean, `true` | Attach `session_create` and `workspace_create` |
| `goalDisarmNotice` | boolean, `true` | Notify a role owner when a goal is `active` but its continuation is disarmed |
| `catchUpOnStart` | boolean, `false` | Deliver a mailbox's pre-existing content on first observation |
| `ledgerMaxBytesPerDay` | number ≥ 0, `8388608` | Delivery-ledger daily cap; `0` disables it |
| `ledgerRetentionDays` | number ≥ 1, `30` | Days before a ledger day file is archived |
| `presenceHeartbeatMs` | number ≥ 200, `2000` | Presence heartbeat interval |
| `presenceTtlMs` | number ≥ 1000, `8000` | Age at which a heartbeat stops counting as live |
| `claimTtlMs` | number ≥ 1000, `300000` | Age at which a live holder's claim may be taken over |
| `claimRetentionMs` | number ≥ 60000, `2592000000` | Age at which a settled claim is archived |
| `sweepIntervalMs` | number ≥ 5000, `60000` | Interval between sweeps of dead presence, expired claims, and abandoned locks |

The source of truth is the `Config` schema in `index.mjs`; if this table and the code disagree, the
code is right.

## Minimal runnable example

Two roles, `main` and `frontend`, sharing one maildir. Start a Session in each repository (so each
has an identity), then from the `main` Session:

```
mail_send { "to": "frontend", "topic": "task",
            "body": "anchor: src/app.ts is the file to change",
            "expect": "reply when the change is pushed" }
```

A delivery that opened a turn reports:

```json
{
  "id": "20261016-101500-1a2b3c4d",
  "delivered": "push",
  "woke": true,
  "mode": "wakeup",
  "wakeBudget": { "spent": 1, "limit": 3, "refillsOn": "non-mailbox-input" }
}
```

An idle target whose wake budget is spent reports `delivered: "injected"`, `woke: false` and
`injectReason: "wake-budget-exhausted"` — the message is in the target's inbox, but no turn was
opened, so the target will not act on it until something else reaches it. `mail_budget` reads the
same number **before** sending.

The reply comes back mechanically when the peer sets `reply_to`. With the Web Tab built (see below),
the mailbox for every role is also visible at `GET /session-mail/mailbox`.

## Compatibility

- **Verified against `@deepseek-ai/dsh-root` `0.1.5-rc.2`.** That is the only version this release
  makes a claim about. The npm-published `@deepseek-ai/dsh` CLI (`0.2.0-rc.2` at the time of
  writing) is a **different version line and has not been tested**.
- **The claim covers the logic layer only (L1).** The test suite runs on plain Node against a stub
  host and is green; it exercises path handling, claim mutual exclusion, the delivery state machine,
  the tool surface, and Session creation. It does **not** prove that the plugin loads in a real DSH
  process, and it does **not** prove the Web Tab boots. The plugin has **not** been booted against a
  real DSH host on Linux. This is deliberately not a statement that Linux is supported.
- While the version is `0.x`, a minor bump may contain breaking changes; see `CHANGELOG.md`.

## Security and deployment constraints

The full model is in [`SECURITY.md`](SECURITY.md). Two constraints are stated identically in this
project and in its companion plugin, because both read and write the same maildir — they are
properties of that directory, not of either plugin.

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

## Release boundary: what is not in this repository

This repository contains the code for all **eight** tools listed above. That is not the same as what
an outside user can run, and the difference matters:

- **Six tools work from this package alone**: `mail_send`, `mail_budget`, `mail_drain`,
  `session_archive`, `session_unarchive`, `session_archived_list`. They need only a maildir and a
  DSH runtime.
- **`session_create` and `workspace_create` are in this code, but their capability depends on
  services this package does not ship.** `session_create` calls the host's `sessionController`;
  resolving the target directory's Workspace and joining a Session group call the host's
  `workspaceRegistry` and `sessionGroups`. Where the host does not provide them, the tools report that
  rather than doing something half-right. So an outside user's practical result is **six tools, plus
  two whose availability depends on their deployment** — not eight unconditional ones.
- **The observation surface lives in a companion plugin that is not open sourced (yet).** The
  three-state Session reading (`alive` / `remote` / `cold`), the sidebar row markers and row-menu
  verbs, cross-process hold release, and the `.liveness/` control channel all come from
  `dsh-session-liveness`. **Without it, this package still sends, delivers, and settles mail, but
  nothing displays liveness and nothing can release a hold.** That plugin's open-sourcing is a
  separate, later decision.

In short: this repository's *code* carries eight tools; an outside user's *usable* surface is six, and
the panel is absent.

## Known limitations

- **Same machine only.** Liveness and claims use process ids, which are meaningful on one machine.
- **Local filesystem only.** NFS/SMB and sync folders do not provide the guarantees the claim protocol
  needs, and the failure is silent.
- **The Web Tab needs a bundle this repository cannot currently rebuild.** `src/client/` must be built
  into `lib/client.js`, which is not committed; the build script invokes `tsdown`, which is not
  declared as a dependency, and a clean `npm install` additionally hits a peer conflict among the
  published host packages. Tracked as an open item. **The host half does not need it.**
- **Case folding.** Ids map to file names without case folding, so on Windows two ids differing only
  by case collide onto one file; on a case-sensitive filesystem they do not.
- **Windows-only operations.** The deployment and probe scripts this project was developed alongside
  are not part of this package.
- Archiving hides a Session from every list, group, and search; it deletes no log and frees no disk.
  `session_unarchive` deliberately performs no existence check, so it accepts an id that names
  nothing.

---

# 中文说明

**跨会话信箱插件（DeepSeek Harness / DSH）**。它让根会话之间互发运维类消息，并按信箱该有的方式投递：**有寻址、有落盘、只结算一次**。

> ## 非官方声明
>
> 本项目是**独立的社区维护插件**，**与 DeepSeek 无隶属、无背书、无支持关系**。"DeepSeek"、"DSH"、"DeepSeek Harness" 仅作**描述性使用**，指本插件所扩展的宿主运行时。
>
> 本项目**不发布在 `@deepseek-ai/*` scope 下，也不得如此发布**。其声明的 `@deepseek-ai/*` peer 依赖**不随本包分发**。
>
> **许可**：MIT（见 `LICENSE`）。

## 目录

- [它做什么](#它做什么)
- [前置条件](#前置条件)
- [安装](#安装)
- [配置](#配置)
- [最小可跑示例](#最小可跑示例)
- [兼容声明](#兼容声明)
- [安全与部署约束](#安全与部署约束)
- [发行边界：本仓不含什么](#发行边界本仓不含什么)
- [已知限制](#已知限制)

## 它做什么

**八个模型工具**，全部挂在**根会话**上：

| 工具 | 作用 |
|---|---|
| `mail_send` | 发消息：按 role（`to`）或按精确会话 id（`to_session`）寻址 |
| `mail_budget` | **只读**：发信前读对端唤醒预算 |
| `mail_drain` | 拉取本会话的未读（`backlog: true` 可取更早的） |
| `session_archive` | 把会话从所有列表/分组/搜索里隐藏 |
| `session_unarchive` | 把会话 id 从归档集清除 |
| `session_archived_list` | **只读**：归档集 |
| `session_create` | 建对等会话（需任务语义标题） |
| `workspace_create` | 把一个已存在目录注册为 Workspace |

投递是**持久且逐条恰好一次**的：交给目标前先用独占文件**认领**；离线收件人的行**不会阻塞**后面的行；唤醒按**实际发生的事**结算（模型有提交响应即消费、失败即结算、可重试类在有界额度内可重投一次）。所有状态都在 **maildir**（一堆纯 JSONL 文件）里，因此**同机多个 dsh 进程可共用一个信箱**。

## 前置条件

- **Node.js ≥ 22**（测试用 `node --test` 的 glob）。
- **一个 DSH 运行时**（提供 `@deepseek-ai/dsh-root`）。**验证基线为 `0.1.5-rc.2`**，见[兼容声明](#兼容声明)。
- 一个**你自己拥有、位于本地文件系统**的 maildir——见[安全与部署约束](#安全与部署约束)。
- **运维面仅在 Windows 上验证过**。核心（host 半区、信箱、测试）按平台无关编写、且测试不需要宿主进程，但本项目一路同行的部署脚本是 Windows-only；插件**未在 Linux 的真宿主上启动过**。
- **构建 Web Tab 需要本仓目前不提供的工具链**——见[已知限制](#已知限制)。**host 半区不需要它。**

## 安装

把包装进 DSH profile，然后挂载。

```sh
# 1. 在 DSH profile 目录下
pnpm add @fleetingold/dsh-session-mail
#   （或从 checkout 安装：pnpm add <path-to-this-checkout>）

# 2. 把下面的挂载行加进该 profile 的 cordis.patch.yml

# 3. 重启 dsh-web：loader patch 在进程启动时应用
```

```yaml
# cordis.patch.yml
- insert:
    - id: session-mail
      name: dsh-session-mail
      config:
        maildir: '<your-maildir>'
        identities:
          - role: main
            name: main
            cwd: '<your-repo-a>'
            inbox: to-main.jsonl
          - role: frontend
            name: frontend
            cwd: '<your-repo-b>'
            inbox: to-frontend.jsonl
```

## 配置

`maildir` 与 `identities[]` **必填**，其余都有默认值。

| 字段 | 类型 / 默认 | 含义 |
|---|---|---|
| `maildir` | string，**必填** | 信箱目录。**共用同一信箱的所有进程必须指向同一路径** |
| `identities[]` | `{ role, name, cwd, inbox }` 数组，**必填** | 可按 role 寻址的名册。`role` 是 `to` 目标；`cwd` 匹配会话工作目录；`inbox` 是该 role 读取的收件文件 |
| `pollMs` | number ≥ 100，`800` | 收件轮询间隔 |
| `batchWindowMs` | number ≥ 0，`1500` | 把密集发送收拢成一批的窗口 |
| `delivery` | `wakeup` / `quiet`，`wakeup` | 投递是否可在空闲目标上开新回合 |
| `maxConsecutiveWakes` | number ≥ 1，`3` | 本插件对同一目标可连续消耗的唤醒次数；**任何非本插件的 inbox 输入都会重置它** |
| `maxRedeliveries` | number ≥ 0，`1` | 可重试类的有界重投。**重投会再消耗一次模型回合**；`0` 全局关闭 |
| `wakeWindowMs` | number ≥ 1000，`600000` | 唤醒始终没有决定时的兜底判决窗口 |
| `wakeWindowExtensions` | number ≥ 0，`3` | 目标仍在运行时可顺延该窗口的次数 |
| `activateOnSend` | boolean，`true` | 投递前把离线的 `to_session` 目标唤起 |
| `createTool` | boolean，`true` | 是否挂 `session_create` 与 `workspace_create` |
| `goalDisarmNotice` | boolean，`true` | goal 处于 `active` 但自动续跑已解除时，是否通知该 role 属主 |
| `catchUpOnStart` | boolean，`false` | 首次观察某信箱时是否补投其中已存在的内容 |
| `ledgerMaxBytesPerDay` | number ≥ 0，`8388608` | 投递台账单日上限；`0` 关闭 |
| `ledgerRetentionDays` | number ≥ 1，`30` | 台账日文件归档期限 |
| `presenceHeartbeatMs` | number ≥ 200，`2000` | presence 心跳间隔 |
| `presenceTtlMs` | number ≥ 1000，`8000` | 心跳超过多久不再算活 |
| `claimTtlMs` | number ≥ 1000，`300000` | 活持有者的认领超过多久可被接管 |
| `claimRetentionMs` | number ≥ 60000，`2592000000` | 已结算认领被归档的期限 |
| `sweepIntervalMs` | number ≥ 5000，`60000` | 清理死 presence、过期认领与超龄锁的间隔 |

**以源码为准**：`index.mjs` 的 `Config` schema。本表与代码不一致时，以代码为准。

## 最小可跑示例

两个 role：`main` 与 `frontend`，共用一个 maildir。在两个仓各开一个会话（使其各自有身份），然后在 `main` 会话里：

```
mail_send { "to": "frontend", "topic": "task",
            "body": "anchor: src/app.ts is the file to change",
            "expect": "reply when the change is pushed" }
```

**开了回合**的投递回执长这样：

```json
{
  "id": "20261016-101500-1a2b3c4d",
  "delivered": "push",
  "woke": true,
  "mode": "wakeup",
  "wakeBudget": { "spent": 1, "limit": 3, "refillsOn": "non-mailbox-input" }
}
```

若空闲目标的唤醒预算已花光，回执会是 `delivered: "injected"`、`woke: false`、`injectReason: "wake-budget-exhausted"`——**消息进了收件箱，但本次投递没有开回合**，目标不会因此行动，直到有别的东西到达它。`mail_budget` 可在**发信前**读到同一个数字。

对端设置 `reply_to` 后，回信由插件**机械路由**回来。构建了 Web Tab（见下）后，每个 role 的信箱也可经 `GET /session-mail/mailbox` 查看。

## 兼容声明

- **验证基线为 `@deepseek-ai/dsh-root` `0.1.5-rc.2`**，本版本**只对这一条做声明**。npm 上公开发布的 `@deepseek-ai/dsh` CLI（写作时 `0.2.0-rc.2`）属**另一号段，未经验证**。
- **该声明只覆盖逻辑层（L1）**：测试套件在**纯 Node + 假宿主**上跑绿，覆盖路径处理、认领互斥、投递状态机、工具面与会话创建；它**不证明**插件能在真 DSH 进程里装载，也**不证明** Web Tab 能 boot。插件**未在 Linux 的真宿主上启动过**。**这刻意不是一句"支持 Linux"。**
- `0.x` 期间 minor 版本可能包含破坏性变更，见 `CHANGELOG.md`。

## 安全与部署约束

完整模型见 [`SECURITY.md`](SECURITY.md)。以下两条约束在本项目与其配套插件里**逐字一致**——因为两者读写**同一个 maildir**，这两条是该目录的性质，而不是任一插件自己的行为。

### 共用声明 A · maildir 权限

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

### 共用声明 B · 同机 + 本地文件系统

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

> **为什么这两段是英文**：它们是**契约文本**——跨两个仓逐字一致，另有脚本
> `tools/verify-shared-text.mjs` 逐字比对。**改动须两仓同步、文本相同**；中文说明只解释、不替换它们。

## 发行边界：本仓不含什么

**本仓的代码包含上表全部八个工具**，但这**不等于**外部使用者能跑到的能力，差别要讲清：

- **六个工具只靠本包即可工作**：`mail_send`、`mail_budget`、`mail_drain`、`session_archive`、`session_unarchive`、`session_archived_list`。它们只需要一个 maildir 与一个 DSH 运行时。
- **`session_create` 与 `workspace_create` 在本仓代码里，但其能力依赖本包不附带的服务**：`session_create` 调宿主的 `sessionController`；解析目标目录所属 Workspace、加入会话组分别调宿主的 `workspaceRegistry` 与 `sessionGroups`。宿主未提供时，工具会**如实报告**而不是半对半错地做。⇒ 外部使用者的实际结果是**六个工具，外加两个取决于其部署的服务是否提供的工具**，而不是八个无条件可用。
- **观测面属于一个尚未开源的配套插件**：三态会话读数（`alive` / `remote` / `cold`）、侧栏行标记与行菜单动作、跨进程 hold 释放、`.liveness/` 控制通道，均来自 `dsh-session-liveness`。**没有它，本包仍能发信、投递、结算，但没有任何地方显示存活状态、也没有任何东西能释放 hold。** 该插件是否开源是**另一个更晚的决定**。

一句话：**本仓代码带八个工具；外部使用者的可用面是六个，且面板缺席。**

## 已知限制

- **仅同机**：判活与认领用进程 id，只在同一台机器上有意义。
- **仅本地文件系统**：NFS/SMB 与同步盘不提供认领协议所需的保证，且失败是**静默**的。
- **Web Tab 需要本仓目前无法重建的 bundle**：`src/client/` 要构建成 `lib/client.js`（**未提交**）；构建脚本调的 `tsdown` **未声明为依赖**，而干净的 `npm install` 还会撞上已发布宿主包之间的 peer 冲突。已登记为待办。**host 半区不需要它。**
- **大小写折叠**：id 映射到文件名时不做大小写折叠 ⇒ Windows 上仅大小写不同的两个 id 会落到同一文件；大小写敏感的文件系统上不会。
- **运维面 Windows-only**：本项目一路同行的部署与探针脚本**不在本包内**。
- 归档会把会话从所有列表/分组/搜索里隐藏，但**不删日志、不释放磁盘**；`session_unarchive` **刻意不校验存在性**，因此会接受一个什么都不是的 id。

---

## Licence / 许可

MIT. See [`LICENSE`](LICENSE). Security model: [`SECURITY.md`](SECURITY.md). Changes:
[`CHANGELOG.md`](CHANGELOG.md). Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md).
