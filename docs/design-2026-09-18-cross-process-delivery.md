# 跨进程投递设计（0.4.0，2026-09-18）

> 触发：2026-09-18 15:31 从一个源码实例向另一个运行实例里的活会话发信，`mail_send` 回报"对端离线"，信在信箱里排队且被队头阻塞。（两个实例的端口与实测记录属部署细节，不进本文件；本节结论不依赖它们。）

## 缺口

0.3.0 的两处状态都是进程本地或全局唯一的：

1. **活会话视图**：`liveRootsOfRole()` = `ctx.agents.roots()` ∩ cwd 身份 ∩ 名册。`ctx.agents.roots()` 只包含本进程的根 agent，因此另一个 dsh 进程里的活会话一律被判为离线。
2. **消费状态**：内存 `seen` 集合 + 每 role 一个 `.cursor.<role>.json`。`consumePrefix()` 逐行前进，遇到"收件人不在本进程"就 `break`，整段前缀被保持——离线收件人的行会把后面所有行挡住（head-of-line），而且没有跨进程互斥，两个进程各自扫描同一份文件。

投递动作本身无法跨进程：`agent.followup/inject` 是本进程 API。所以设计目标不是"远程投递"，而是**让正确的进程去做投递**。

## 设计

三项改动，全部以 maildir 为共享介质：

### 1. presence 心跳（跨进程活会话视图）

- `<maildir>\.presence\<sessionId>.json` = `{sessionId, role, cwd, status, attachedAt, pid, boot, heartbeat}`。
- 每个进程的独立心跳定时器（`presenceHeartbeatMs`，默认 2s）为它承载的、通过名册的会话重写记录；会话打开时（`agent/created`）与插件挂载时立即发一次。
- 判活（`presenceIsLive`）= 心跳新鲜（`presenceTtlMs`，默认 8s）**且** `pid` 存活。心跳新鲜是主信号，pid 探测让被杀进程的记录立刻失效而不必等满 TTL。
- 本进程只回收自己的记录（`pid`/`boot` 匹配且已不再承载）；其他进程的记录由心跳与 `sweepMailboxState()` 负责。
- 视图分层：`localRoots()` 是投递目标（唯一可投递集合），`viewOfRole()` 把本地会话与心跳记录合并成候选/在线视图。名册（`owner.json`）对两侧都生效。

### 2. 认领文件（恰好一次 + 崩溃接管）

- `<maildir>\.claims\<role>\<msgId>.json`，`fs.open(path, 'wx')` 独占创建即互斥量——本地文件系统的 create-exclusive 是原子的，不需要锁服务。
- 状态机：`claimed`（owner pid/boot/claimedAt）→ 投递成功 → `delivered`（`deliveredAt`）。
- 接管：`claimed` 且（owner pid 已死 **或** 认领超过 `claimTtlMs`，默认 5 分钟）时，任何进程可在 `<claim>.takeover` 短锁（`wx`，30s 超龄可破）内接管。**接管必须在锁内重读一次**：owner 可能刚好在两次读之间完成投递，此时 `delivered` 胜出——这是"四进程竞争只允许一个赢"的关键。
- 语义取舍：认领成功但投递抛异常时**保持 `claimed`**，让超龄接管重试；协议本就容忍重复投递，宁可延迟不可丢失。
- 保留了 `id → 文件名` 的字符白名单（`[A-Za-z0-9._-]`，截断 120），因为 `msgId`/`sessionId` 来自可手编的信箱内容。

### 3. 跳过而非阻塞 + 水位兼容

- poll 逐行扫描，**不再 break**：不属于本进程的行跳过，后面的行照常投递；同一会话内部仍按文件顺序投递（FIFO 未被破坏）。
- `mail_drain` 同样改为全文件扫描，只认领属于自己的行（有 `to_session` 且等于自己；无 `to_session` 时归最早打开的活会话，`attachedAt` 升序 + sessionId 兜底，跨进程确定）。
- 水位 `.cursor.<role>.json` 语义从"消费游标"改为"已全部投递的前缀长度"，**只写不读**（首次读旧值用于迁移）：0.3.0 读它当游标，0.4.0 每轮重算并写回，因此混版期间两边不会互相无限重放。0.4.0 每轮还读一次旧值，把 `index < cursor` 的行视为已投递（只跳过、不阻塞），兼容 0.3.0 仍在投递的情形。
- `catchUpOnStart: false` 的旧语义（挂载时已在文件里的信不主动推）保留：本进程首次观察该 role 且无持久水位时，把水位置为当前行数。

## 不变量

1. 一条消息最多被一个进程投递给一个会话：认领文件互斥 + 投递后才能写 `delivered`。
2. 任何时刻至多一个进程把某个 session id 当成本地会话（会话由唯一进程承载）；出现两份时，认领仍保证只投一次，另一份只是空转。
3. 一条线的处理不依赖其他线的状态：不存在"前一行的收件人离线"导致后续行饿死（测试 `a line for an offline session does not hold back the lines behind it`）。
4. 无 `to_session` 的行在任意进程视图下算出同一个 owner（`byAttachOrder`）。

## 验证

| 层级 | 证据 |
|---|---|
| 单元（`tests/mailbox-state.spec.mjs`） | presence 判活/清理/路径安全、认领互斥与接管、锁保持、水位清理 |
| 跨进程互斥（`tests/claims-cross-process.spec.mjs` + `tests/helpers/claim-child.mjs`） | 四个真子进程竞争同一消息只有一个 `mine`；崩溃 owner 被下一个进程接管；活 owner 被拒绝 |
| 端到端（`tests/delivery.spec.mjs`） | 两个假 host 共用一个真实 maildir：A 发→`relay`→B 的 poll 投递并写 `delivered`；离线行不阻塞；水位兼容；drain 归属；无收件人归属 |
| 真进程（`acceptance-two-process.ps1`，2026-09-18 16:48 实测） | 另起一个真实 dsh 进程（临时 profile，`identity.cwd = 仓库根`），其会话发布 presence → 驱动进程把一条 `to_session=<该会话>` 的信追加进共享信箱 → 该进程认领并 `delivered`，会话日志出现该消息 id 与 `agent/inbox/spliced`。不依赖模型配额：会话在第一次模型请求之前就已存在，投递靠的是 watcher |
| 探针四道门 | 探针脚本（空闲端口）全绿：boot、`/session-mail/mailbox` 200、boot 图含插件行、客户端 bundle 可物料化 |

## 未覆盖

- **两个活会话互相通信的真实验收**（进程 A 的会话调 `mail_send` 发给进程 B 的会话）：需要两个 headless 会话各自完成一次模型轮次，而 headless 应用一轮即退出——本机 2026-09-18 的模型配额已耗尽（`429 RATE_LIMIT`，19:08 重置），另有一次请求因 `max_completion_tokens` 参数校验被拒，因此该形态由两条证据间接覆盖：`relay` 判定由两 host 端到端测试验证（同一 `viewOfRole` + presence 代码路径），跨进程投递由 `acceptance-two-process.ps1` 在真进程上验证。配额恢复后可用同样形状补跑：先起接收方（保持会话存活），再把它的 session id 填进发送方的提示词，断言发送方工具结果带 `delivered=relay`。
- **多机共享 maildir**：pid 判活仅同机有效；跨机需要租约服务，超出本插件边界。
- **混版窗口的重复投递**：见 README《已知限制》。
