# 本地变更汇总：并入开发版（2026-11-07）

本轮目标：把我们这些天做过的本地修改全部落到"开发版"上——DSH 源码一份、IM 插件一份，都能构建、能测试，且不依赖散落在安装包里的手工补丁。

## A. DSH 开发版（`workspaces/dsh-local-dev`，分支 `fix/im-self-reload-guard`）

基线 `fcc0ad46`（0.2.2-rc.1），在此基础上依次提交：

| 提交 | 内容 |
|---|---|
| `9a349a37` | `fix(plugin-manager): block IM-owned profile self-reloads` — IM 会话及其子代理发起插件变更前直接拒绝，避免自重载死锁；29 项原生用例 + 2 项真实 Cordis 注册检查 |
| `4899a8be`、`ea5b9d35`、`a8f83105` | 构建、依赖闭包、回滚证据与切换门禁的记录文档 |
| `67028492` | `feat(plugin-market): prepare editable source for development installs` — 从旧工作树 cherry-pick；插件市场可直接把插件源码准备成可编辑目录 |
| `bd6dd3de` | `fix(plugin-market): use the Windows null device for Git isolation files` — 上游那份实现用 `os.devNull`（Windows 下是 `\\.\nul`），Git 当文件打开时报 `unable to access '\\.\nul'`；改为 Windows 用 `NUL` |

验证：

- 完整串行构建 **10/10 通过、0 失败**（351 秒），`build:check` 与前后端聚合检查均通过。
- `plugin-manager` + 插件市场开发版用例全绿；`repository-cache.spec.ts` 在本机需放宽 5 秒默认超时（`--testTimeout=30000` 时 18/18 通过），属 Windows 上 Git 夹具较慢的既有波动，与本轮改动无关。

## B. IM 插件开发版（`workspaces/upstream-dsh-im-connect`，分支 `integration/local-1.0.28`）

| 提交 | 内容 |
|---|---|
| `0cb233d` | 上游 1.0.28 + 已合并的 PR #62（群聊免@策略）、#63（思考折叠与投递生命周期） |
| `582d1b3` | `fix(delivery): never match unclaimed history by an undefined turn` — 冷启动首个事件没有回合号时，不把未领取的投递历史当成同一回合补成 `blocked` |

产物：`candidate/dsh-home/plugin-artifacts/michengai-dsh-im-connect-1.0.28-guard-582d1b3.tgz`
（420 文件，SHA-256 `4709110cb1d7f6a3e90b0913f754a20afc9a07f8c588bb5cb4e4bae54efe44e6`）

验证：全量 `npm test` 1442 项 / 1417 通过 / 0 失败 / 25 跳过；`tsc` 构建 exit 0。

## C. 现状与差距

- 在线 DSH 仍是 **npm 安装的 0.2.2-rc.1**，没有跑开发版；上述 DSH 改动只在本地源码树里。
- 在线 IM 插件已是 **1.0.28（`0cb233d`）**，但**不含** `582d1b3` 的 turn 守卫；守卫版本已出包，未部署。
- profile 级本地件（`auto-review-codex-compat.mjs`、`hermes-loop-dev`）仍在 `candidate/dsh-home/local-plugins`，与开发版无关，保持原状。

## D. 把开发版投放到在线服务需要的动作（各自独立、都需维护窗口）

1. **换成守卫版插件**：把 profile 依赖指向 `...-guard-582d1b3.tgz`，跑 `run-im-upgrade-20261107.py` 同款窗口流程即可（回滚 tar 仍在 `im-upgrade-1.0.28-20261107/`）。
2. **DSH 切开发版**：改启动器指向 `workspaces/dsh-local-dev/apps/cli/lib/bin.js`，用独立 `DSH_HOME` 副本试跑，确认 `--version`、登录、一次真实对话后再切正式 profile；回滚是把启动器改回原 `runtime` 行。
3. 两者可分开做，先做风险更低的那个；无论先做哪个，都要在窗口内保持"失败即回滚并保证起栈"。
