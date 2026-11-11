---
description: "面向部署方与维护者的 SQLite FTS5 会话历史全文搜索后端，用于选择、配置或排查查询服务之上的全文搜索。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-query-sqlite

[English](README.md) | 中文

## 概述

为跨会话或会话内查询增加带排序、游标分页的 SQLite FTS5 搜索。实时与持久化历史使用独立的单所有者派生索引，不修改来源日志；精确读取、过滤与追踪仍然可用。搜索是可选能力，可在启动或首次搜索时打开，也可关闭。匹配针对 token 与短语，而非任意子字符串。默认 `on-search` 模式在作答前对账；`syncMode: background` 立即返回已索引历史，由实例自有后台任务同步，并通过 `coverage` 报告新鲜度。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当组合需要对会话历史进行排序后的全文搜索时——例如 Web 内容搜索或 `/resume` 既往工作检索——挂载本包。常用路径是显式的：挂载插件、给它一个专用数据库路径，然后从代码调用 `ctx.sessionQuery.searchSessions` 或 `searchEvents`。

### 何时选择

当你想对既往会话进行带排序与分页的全文召回时选择它。它与 `dsh-session-query` 和会话服务一起使用；持久化后端可选但建议挂载，这样重启后持久化历史仍可搜索。不要把 `path` 指向 session-persistence 数据库——本包拥有独立的派生索引。当调用方不能等待完整持久化列举时（例如在大语料库上面向模型的搜索），选择 `syncMode: background`。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: /absolute/path/to/session-search.db
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | 必填 | 专用派生索引 SQLite 路径，或 `:memory:`；POSIX 上缺失的路径会以仅所有者可访问的方式创建 |
| `openAt` | `startup` | `startup` 在激活时打开；`first-search` 把 SQLite 模块推迟到首次搜索；`never` 关闭全文搜索，继承的读取保持可用 |
| `journalMode` | `wal` | `wal`、`delete`、`truncate` 或 `persist` |
| `defaultLimit` | `20` | 请求省略 `limit` 时的分页大小 |
| `maxLimit` | `100` | 接受的最大请求分页大小 |
| `snippetChars` | `240` | 按 Unicode 码点计算的最大 snippet 长度 |
| `readWindowMax` | `50` | 继承的 `readEvent()` 的 `before`/`after` 原始事件数上限 |
| `persistedReadConcurrency` | `4` | 继承批量读取的并发持久化日志读取数 |
| `preparedSessionCacheSize` | `5` | 继承的 `observeSession` 读取器为复用保留的冷 prepared-Session 观察数 |
| `syncMode` | `on-search` | `on-search` 在每次搜索内对账完整持久化来源且不报告 coverage；`background` 立即返回已索引历史、由实例自有的后台任务对账并报告 coverage |
| `syncIntervalMs` | `5000` | 后台对账间隔；最大 `2^31 - 1`，即 Node 的最大 timer 延迟 |
| `syncReadConcurrency` | `2` | 一次后台对账中的并发冷日志读取数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-query-sqlite)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索行为

`searchSessions` 搜索整个语料库，并按每个会话匹配最强的事件分组结果；`searchEvents` 搜索一个逻辑会话。查询是字面短语：首尾空白会被移除、内部空白会被规范化，引号、`OR`、`NEAR` 和 `*` 等 FTS5 语法被视为数据，绝不作为可执行查询语法。元数据过滤器（会话 id、cwd、创建时间、父级、可用性、事件 seq/时间/类型/表层）在排序前缩小结果。默认搜索全部 `current`、`shadowed` 与 `log-only` 事件；传入表层过滤器可缩小范围。

排序是确定性的：实际 FTS5 高亮匹配 span 更多的在前，然后文档更短的在前，事件时间、会话 id 与 seq 打破平局。结果携带按 `snippetChars` 个 Unicode 码点截断的纯文本摘录，没有提供方专用数值分数。分页通过不透明 `SessionSearchCursor` 延续，游标绑定到规范化后的确切请求；相关语料库变化时游标变为陈旧（`SESSION_QUERY_STALE_CURSOR`），会话内游标可在不相关会话变化后延续，跨会话游标则不能。

需要在其他会话持续写入时读取多页的调用方可以传 `snapshot: true`。第一页会捕获完整排序（最多 500 条命中）并返回快照游标，后续页读取该捕获，并发写入不再让余下搜索失效。捕获在 2 分钟内可继续读取，每个范围最多保留 8 份捕获与 32 MiB 命中；过期或被淘汰的捕获与语料库变化一样返回 `SESSION_QUERY_STALE_CURSOR`。超过上限的结果集回退到世代绑定游标，不会静默截断。

`unicode61` tokenizer 匹配 token 与短语，而非任意子字符串：`AI` 不匹配 token `BRAID`。需要执行字面、空白灵活的字符串子串扫描时，使用带 `text` 子句的 `ctx.sessionQuery.filterEvents()`。

### 后台同步

启用 `syncMode: background` 后，搜索从不等待持久化列举或冷日志读取。它从当前派生索引作答，并请求实例自有的后台任务对账来源；该任务在服务活动期间每 `syncIntervalMs` 也对账一次，并合并重叠请求。每个被列举的会话在来源修订检查后于自己的事务中提交，因此中断的扫描从已提交会话继续，而不重新读取它们。来源修订已变化的世代在其通过校验的替代内容提交前保持隐藏；只有在完整的成功列举未包含某会话后才删除它。使用 `openAt: first-search` 时，后台同步从首次搜索开始，而不是在激活时开始。

每个后台页面都携带 `coverage`，按请求的全部会话谓词计算：在索引针对当前来源校验完成前 `state` 为 `initializing`；扫描运行或有已列举会话等待读取时为 `syncing`；出现隔离的来源失败后为 `degraded`；可枚举语料库完成索引后为 `ready`。`checkedAt` 是最后一次成功的完整观察。`indexedSessions`、`pendingSessions` 与 `failedSessions` 是限定在请求过滤器内的计数，绝不包含请求过滤之外的会话。在列举尚未建立范围之前省略计数；经过验证的计数包含可搜索的仅实时会话，且不会重复计算其持久化基库。捕获分页保留第一页的 coverage，因此续页绝不会报告比其捕获更新的状态；`on-search` 页面不携带 coverage。

重新打开持久索引时，持久命中会保持隐藏，直到一次完整列举校验当前来源元数据，因此被替换的来源绝不会提供前一个存储的行；如果该校验无法完成，状态保持 `initializing`，而不是虚假的 `ready`。对仍处于 pending 世代的已列举来源做会话内搜索时，返回该会话的 header、空页面以及 `syncing` 或 `degraded` 的 coverage 状态，而不是 `SESSION_QUERY_SESSION_NOT_FOUND`；只有来源从未列举过的 id 才以该错误失败。

### 何时推迟或关闭搜索

使用 `openAt: first-search` 时，服务在不导入 `node:sqlite`、不打开索引的情况下激活，把 SQLite 的实验性警告推迟到首次实际搜索；无效数据库让首次搜索失败，而不是服务激活失败。使用 `openAt: never` 时，全文搜索对该部署关闭：`searchSessions` 与 `searchEvents` 在任何请求规范化之前就以 `SESSION_QUERY_SEARCH_DISABLED` 失败，而继承的全部精确读取、过滤与追踪保持可用。请求超过编译谓词预算（跨会话 14 个组合谓词、会话内 13 个）或 SQLite 可移植的 32,766 绑定上限时，会在准备语句前以 `SESSION_QUERY_INVALID_FILTER` 失败。

### 失败与恢复

带类型的 `SessionQueryError` 失败携带稳定代码：搜索配置为关闭时 `SESSION_QUERY_SEARCH_DISABLED`；索引无法打开或对账时 `SESSION_QUERY_INDEX_FAILED`；搜索目标不存在时 `SESSION_QUERY_SESSION_NOT_FOUND`；语料库在分页之间变化或捕获过期时 `SESSION_QUERY_STALE_CURSOR`——请重试完整的搜索调用；游标不属于该请求时 `SESSION_QUERY_INVALID_CURSOR`。取消在同步 SQLite 调用之间被尊重；已在 JavaScript 线程上执行的语句无法被中断。

打开已被另一个进程或服务实例拥有的索引路径会以 `SESSION_QUERY_INDEX_FAILED` 失败，消息中给出索引路径、所有权 sidecar 与该所有权声明的实例标识，并要求为每个 profile 与持久化来源配置独立的 `path`。服务关闭时释放所有权；拥有进程退出时由操作系统释放。

在后台模式下，来源或读取失败不会让搜索失败：它被隔离、计入限定范围内的 `failedSessions`，并由下一次对账重试，页面仍以 `degraded` coverage 可用。中止一次搜索只取消该调用方；共享同步任务及其生命周期取消由实例持有。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本后端建立在一个分离与三项承诺之上：

- **派生索引，绝不动源存储。** FTS 行存放在专用可丢弃数据库中；这里的代码从不打开 session-persistence 数据库。
- **实时优先的观察。** 一个串行化状态机比较持久化快照修订，只通过短生命周期读取句柄读取新增或已更改日志，并在一个事务中对账，因此搜索反映最新的稳定状态。
- **世代绑定的游标。** 每次语料库变化都会递增世代；游标携带其创建时的世代，宁可陈旧失败也不返回偏移后的页面。
- **可选的捕获分页。** 传入 `snapshot: true` 的搜索只捕获一次排序，读取多页的调用方不会被其他地方写入打断；捕获受时限、数量与字节数约束，超大的结果集保留世代绑定行为。
- **字面短语即数据。** 调用方查询文本被引成一个 FTS5 短语，查询语法保持惰性；保留高亮标记在索引前从文档中剥离。

设计历史记录在 [SQLite FTS5 会话搜索笔记](../../../.agents/notes/archived/feature/2026-07-10-sqlite-session-query-provider.md)与[统一服务决策](../../../.agents/notes/archived/architecture/2026-07-23-unified-session-query-service.md)中。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务：配置、openAt 生命周期、on-search 对账、后台同步、查询执行、游标 |
| [`src/query.ts`](src/query.ts) | 请求规范化、参数化谓词、摘录、谓词与绑定预算 |
| [`src/schema.ts`](src/schema.ts) | 数据库 schema、application id 归属、所有权声明、原地重置、仅所有者文件创建 |
| [`src/ownership.ts`](src/ownership.ts) | 通过专用 sidecar 数据库实现派生索引的跨进程所有权 |
| [`src/snapshots.ts`](src/snapshots.ts) | 多页搜索的有界捕获排序 |

### 索引生命周期

持久化 FTS 行存放在专用派生数据库中并跨重启保留；实时会话使用连接本地 TEMP 表，遮蔽同一会话的持久化基库，并在实时所有者脱离后再次显示基库。两类表都在数字 `seed_length` 中保留精确继承切点；重建的 header 只公开 `isSeeded`，而切点参与实时指纹与持久来源修订。每次 on-search 搜索执行一次串行化观察：列出持久化快照、把逐会话修订与已索引行比较、只通过读取句柄读取新增或已更改日志（在内存中补齐被中断的末尾轮次，从不写回）、提取语义文档，并在运行查询前于一个事务中提交对账。重复查询与不变的重新打开不读取任何内容；切换存储或观察到新增、已更改、已删除或经外部修复的来源时，会在下次稳定观察时对账。来源或事务失败不提交任何内容，下一次搜索重试。

后台模式保留相同的表与实时遮蔽，但把观察移出查询路径。扫描在不占用查询串行化器的情况下列出持久化快照，在一个事务中只发布有界变更（隐藏来源修订已变化的世代、删除完整列举不再包含的会话、把已列举但尚未读取的来源连同其修订与状态记入 `sync_sessions` 账本），然后在串行化器之外并发读取 pending 会话，并在重新核对来源修订后逐个原子提交。实时所有者存在的会话从不冷读取；它保留 TEMP 遮蔽，并在所有者脱离后被读取。重新打开或被替换的来源在完整列举校验当前来源元数据前不暴露持久行。`whenSynchronized()` 在无扫描运行或请求时 resolve，使调用方可以等待新鲜度屏障而不轮询 coverage。

### Schema 归属

数据库携带 application id 与 schema 版本 9，在持久化与实时表之外新增 `sync_sessions` 账本。打开时拒绝其他应用程序拥有的文件或规范数据库，拒绝未知用户表；只有已识别的不兼容派生 schema 才会原地重置——因此不相关或 session-persistence 数据库绝不会被触碰。在 POSIX 文件系统上，缺失的目录与数据库文件以仅所有者可访问的方式创建（进程 umask 前为 `0700` 与 `0600`）。每个路径通过以 SQLite 独占锁定模式打开的 `<path>.owner.sqlite` sidecar 声明：一个进程中恰好一个服务拥有派生索引路径，主数据库在 WAL 下仍可被其他连接读取，第二个声明以可诊断错误失败，拥有进程退出时由操作系统释放声明。sidecar 从不删除。世代与 TEMP 遮蔽状态由连接持有。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享查询服务逐步进入类型级约定与设计证据。

- [会话查询子系统参考](../../../docs/subsystems/session-query.zh.md)——本后端实现的完整类型级约定。
- [dsh-session-query](../session-query/README.zh.md)——服务定义：本后端继承的精确读取、过滤与追踪。
- [dsh-tool-session-query](../../experimental/tool-session-query/README.zh.md)——调用这些搜索方法的面向模型消费方。
- [SQLite FTS5 会话搜索](../../../.agents/notes/archived/feature/2026-07-10-sqlite-session-query-provider.md)——搜索语义、对账与 tokenizer 决策。
- [JSONL 会话持久化](../../session/session-persistence-jsonl/README.zh.md)——本可丢弃索引观察的权威 Session store；其 root 必须与本包的数据库路径分开。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该搜索后端只向调用方返回命中，且不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 SQLite 对比或任务积压。

- **无调用方授权**——这是上下文范围内的可信服务；模型工具或 UI 必须强制执行自己的访问策略。
- **Coverage 只描述提供方可枚举的语料库**——持久化后端可能省略它无法分类的 artifact，例如 JSONL 列举中不支持或损坏的 header。这些 artifact 从不被索引、不计入 `failedSessions`，而 `ready` 只声明后端可枚举的每个会话都已同步，不对磁盘上的每个 artifact 作声明。
- **后台新鲜度是目标而非保证**——`syncIntervalMs` 约束正常负载下的对账节奏，但初始索引与恢复所需时间取决于语料库。需要精确搜索时对账的调用方仍使用 `on-search`。
- **索引发布运行在 JavaScript 线程**——后台扫描通过持久化读取句柄读取，但文档提取与 SQLite 提交仍在 JavaScript 线程上运行；只有后端自身的冷读取路径可以把解码工作移出线程。
- **同步查询执行**——`DatabaseSync` 在 MATCH 执行期间会阻塞 JavaScript 线程，且无法中断已运行的语句。
- **Token 召回，而非任意子字符串**——`unicode61` tokenizer 不会匹配更大 token 中的子字符串；对字面扫描使用 `filterEvents()`。
- **捕获分页是进程内且有界的**——捕获不跨进程或重启共享，2 分钟后过期，最多保存 500 条命中；更宽的结果集仍使用世代绑定游标。
- **单一所有者的派生索引**——每个索引路径必须仅归一个进程中的一个服务所有；第二个所有者会被拒绝，且不支持外部写入者或多进程共享索引。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 未来：其他 tokenizer 与搜索提供方

`unicode61` tokenizer 的选择牺牲子字符串召回，以换取较小的索引体积与双字符 token 支持；trigram 备选方案经实测后被否决。切换 tokenizer 或增加另一个搜索后端会改变索引召回，并需要各自的对账与世代方案。把索引发布移到 worker 需要单独的实测边界；通用查询约定不假设特定线程。

</details>
