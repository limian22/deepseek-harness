---
description: "为智能体提供搜索和读取当前工作区历史会话的工具。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-session-search

[English](README.md) | 中文

## 概述

为所有智能体提供五个实验性只读全局工具，用于搜索历史会话。内容索引在首次搜索时打开，由所有智能体共享。Web 和 Desktop 随附此配置包，默认关闭，且不在默认插件列表中展示。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在**插件 → 添加插件**中输入 `@deepseek-ai/dsh-experimental-session-search`，选择**安装**，再选择**立即启用**。DSH 使用随包提供的版本，无需再次下载。也可在目标 [profile](../../boot/app-boot/README.zh.md#profiles) 的 `package.json` 中，将包名加入 `dsh.profile.bundles`。开启 HMR 时选择即时生效；否则需重启应用。启用后的组合包会出现在插件页；关闭时移除其配置层，并再次隐藏卡片。另行安装到 profile 的依赖在关闭后仍会列出。

开启 HMR 时，启用或关闭组合包会在运行中的 Host 注册或移除其全局工具，因此所有预设（包括 minimal）中的每个智能体都会在下一次请求时看到变化。

此配置包启用智能体的搜索工具。侧边栏搜索保留现有行为。

### 持久索引与进程所有权

随附的配置层让独立提供方使用内存索引。[`examples/`](examples/) 中的两个启用叠加层可以在不改动随附配置层的前提下改变部署形态：

- [`examples/durable-index.cordis.patch.yml`](examples/durable-index.cordis.patch.yml) 将索引存放在 `dshHomePath('storages/session-search/')` 下，并在后台增量同步（`syncMode: background`、5000 毫秒间隔、两个并发读取），使重启后可以复用，且搜索不再按需全量对账。
- [`examples/off-thread-read.cordis.patch.yml`](examples/off-thread-read.cordis.patch.yml) 打开 JSONL 后端的 `readWorker`，由长驻只读 worker 解码当前格式的冷日志。worker 无法启动或违反协议时，读取以类型化失败拒绝，并在下一次打开时重建；后端不会静默改回 Host 线程读取，历史代与未来格式始终在进程内解码。

用 `dsh --patch <路径>` 或通过 profile 的补丁层应用叠加层。每个派生索引同一时刻只属于一个进程：提供方会在打开索引之前占用伴随数据库 `<path>.owner.sqlite`，因此配置了同一路径的第二个进程会在首次搜索时以 `SESSION_QUERY_INDEX_FAILED` 失败，而不是并发写入。请为每个 profile、持久化来源和独立提供方配置各自的路径命名空间，并在组合覆盖 JSONL 会话根目录时同时更换该命名空间：所有权只拒绝并发写入，无法证明某个路径属于当前挂载的会话根目录，因此读取不同根目录却共用一个路径的两个部署会互相读到对方的会话。该所有权伴随数据库永不删除，其锁在持有进程退出时由操作系统释放。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入 Host 组 `optional-session-search`，在全局工具层注册这些工具。后续配置补丁可以按 id 覆盖其条目。[配置组合器](../../boot/app-boot/README.zh.md) 负责补丁顺序和错误处理。

该组拥有独立的 `sessionQuery` 提供方和惰性打开的 `:memory:` 索引，关闭组合包时释放。Host 的元数据服务仍使用 `openAt: never`。配置为文件路径时，还会占用伴随数据库 `<path>.owner.sqlite`，它承载该路径的单进程约束。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[能力实现](../tool-session-query/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过[能力实现](../tool-session-query/README.zh.md) 贡献模型上下文和结果。

#### KV Cache 影响

此配置层不直接添加请求内容；能力实现负责工具目录、提示和结果的缓存影响。切换组合包会改变运行中会话的工具列表，使其已缓存的请求前缀失效一次。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 随附配置层在首次搜索后持有一个内存索引，因此应用重启或重新开关组合包后索引会重建。持久路径与线程外日志读取都是可选的叠加层，且每个派生索引路径由单一进程拥有。搜索仍仅限获授权的工作区。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
