# 复盘：2026-09-15 dsh-web 多次重启与 GUI 故障

状态：已收口。影响：dsh-web 服务当日 16 次 boot，其中多次为失败 boot；GUI 一度完全无法进入（"Failed to load plugins"）。生产会话任务随每次重启中断。

## 时间线（依据服务日志与文件时间戳）

| 时间 | 事件 |
|---|---|
| 09:51 | 服务 boot（v0.2.0 代码），此后整个上午稳定运行，承载本会话与生产任务 |
| 上午–午后 | v0.3.0 开发：信箱 Tab、`/session-mail/mailbox` 路由、客户端 bundle |
| 午后 | 部署 v0.3.0 后首次 boot 崩溃：`cannot get property "webServer" without inject`（host 半区 `index.mjs` 用属性代理读未声明的可选服务）。前台 `pnpm dsh web` 同样失败 |
| 崩溃后 | profile 的 `cordis.patch.yml` 里 session-mail 插件行被注释禁用以恢复启动（"disabled temporarily (2026-09-15)"），服务继续跑旧进程 |
| 午后 | 重启脚本 成功执行：服务停止 → 计划任务拉起 → 新进程 boot（携带已修复的 host 代码 + **坏 client bundle**） |
| 新进程运行期 | 浏览器报 `failed to import loader entry (dsh-session-mail): exports is not defined`，整个 GUI boot 失败。当次部署的 client bundle 缺失 CJS 脚手架（tsdown 静默忽略 `intro` 选项，产物没有 `var module = { exports: {} }; var exports = module.exports;` 两行） |
| 期间 | 多次重启排障（out.log 当日 16 次 boot）；期间 `cordis.patch.yml` 一度被改为非 YAML 数组格式，再次产生失败 boot（`overlay ... must be a top-level YAML array of loader patch entries`） |
| 14:35 | 修复构建配置并重新 sync，安装副本 bundle 恢复完整（hash 87DD…） |
| 14:42–43 | 最终成功 boot：boot 图含 session-mail 行，服务端分发的 bundle 经物料化测试验证可执行（导出 `apply, inject`） |
| 14:58 | 唤醒重复投递竞态修复（`deliverPendingWakes` 互斥 + 指纹去重）sync 到安装副本，待下次自然重启生效 |

## 根因（三条，按危害排序）

1. **client bundle 未做执行验证就部署**（危害最大）：host 半区 boot 成功、路由 200、boot 图有行——服务看起来完全健康，但浏览器工厂体一执行就抛错，整个 GUI 拒绝 boot。部署验证只查了状态码与响应头几行，没有对"服务端实际分发的字节"做物料化测试。
2. **boot 关键路径改动没有先做 boot 验证**：`webCtx.webServer` 属性代理访问未在 inject 声明，违反 Cordis 规则（可选服务必须 `ctx.get`），直接炸掉整个 profile boot。
3. **配置文件改动无校验**：`cordis.patch.yml` 被改成非法 YAML 格式后，boot 在解析层崩溃。

共同根因：**把生产服务当成了实验环境**。每个改动都以"sync + 重启生产"收尾，而重启一次 = 打断所有进行中的生产会话任务一次。

## 已落地的修复

| 修复 | 文件 | 作用 |
|---|---|---|
| 探针验证门（自动化） | 探针脚本 | 一条命令完成：空闲端口 + 临时信箱全量 boot → 路由 200 → boot 图行 → **对服务端分发字节做物料化测试** → 清理。任何一项不过即退出非零 |
| 生产重启守卫 | 重启脚本（部署侧） | 必须显式确认标志才会执行；默认先自动跑探针（可跳过但仅限纯文档改动） |
| 可选服务读法 | `index.mjs` | `webCtx.get('webServer')` 替代属性代理 |
| bundle 构建配置 | `tsdown.config.ts` | banner/intro/footer 与仓库预设逐字对齐，产物含完整 CJS 脚手架 |
| 唤醒投递竞态 | `index.mjs` | 挂载期与会话打开期并发触发收敛为一次 + 指纹去重 |
| 版本管理与回滚 | 源码 git + 部署侧配置 git + 部署快照 | 源码、profile 配置、部署状态三层分别可独立回退；坏部署一步还原，不再依赖人工救火 |

## 流程规则（此后生效）

1. **实验不进生产**：任何改动先过探针（空闲端口 + 临时信箱，与生产服务、生产信箱、生产会话完全隔离）。
2. **三面全绿才算过**：路由 200、boot 图行存在、服务端字节物料化成功。状态码 200 不等于 bundle 可执行。
3. **重启需要 owner 明确批准**：显式确认标志是有意的摩擦。重启前确认没有进行中的生产任务；一次变更集只重启一次，禁止边排障边反复重启。
4. **配置即代码**：改 `cordis.patch.yml` 后先 `dsh web --patch ... --dump-config`（或探针 boot）验证解析，再动服务。
