# 开发版运行手册（2026-11-07 起）

在线服务从今天起跑**本地开发版** DSH：栈照旧由 `dshw-stack.py` 管，只是它启动的 CLI 换成了开发树里的入口。安装包本身没有改动。

## 当前接线

| 项 | 值 |
|---|---|
| CLI 开关 | `ingress-private/cli-override.json` → `workspaces/dsh-local-dev/apps/cli/lib/bin.js` |
| 栈控制器 | `dshw-stack.py`（`fire-stack.py` 里读取开关；两者哈希互钉） |
| 端口 | 3180 web（dshw-web）、3181 代理、20259 cloudflared |
| 健康检查 | `runtime\python\python.exe -I -B check-dev-runtime-20261107.py` |
| 当前 IM 插件 | `@michengai/dsh-im-connect@1.0.28`，tree `cda31a33…`（含 turn 守卫） |

`check-dev-runtime` 会同时核对：开关指向开发版、3180 进程命令行是开发版、`ready.json` 就绪、隧道已起、本机 401 / 公网 302、IM 插件是期望构建。全部满足才退出 0。

## 改代码后的标准流程

```powershell
$root = 'C:\Users\qq135\dsh-migration-20261106'
$env:COREPACK_HOME = "$root\workspaces\dsh-dev-toolchain\corepack"

# 1. 只在依赖清单变化时才装依赖（锁定文件 + 独立 store，禁脚本）
corepack.cmd pnpm --dir "$root\workspaces\dsh-local-dev" install --frozen-lockfile --ignore-scripts `
  --store-dir "$root\workspaces\dsh-dev-toolchain\store"

# 2. 串行构建（本机与在线服务共用资源，别用默认 12 并发）
corepack.cmd pnpm --dir "$root\workspaces\dsh-local-dev" exec tsx scripts/build.ts --serial

# 3. 受控重启（会断线一次，刷新即回）
& "$root\runtime\python\python.exe" -I -B "$root\restart-stack-20261107.py" --delay 45

# 4. 验收
& "$root\runtime\python\python.exe" -I -B "$root\check-dev-runtime-20261107.py"
```

`restart-stack` 必须**从分离进程**启动（例如 `Invoke-CimMethod Win32_Process -MethodName Create`），否则它随会话一起被停。

## 重启：只用整栈入口，绝不单启 dsh web

只重启 dsh web 会把代理和 Cloudflare 通道落下。统一入口：

```powershell
# 分离进程启动，45 秒后整栈停/起（web + 代理 + CF 通道），完成后自动体检
& "$root\runtime\python\python.exe" -I -B "$root\restart-dev-stack-20261107.py" --delay 45
```

它调用 `restart-stack-20261107.py`，由栈自己 spawn cloudflared，因此隧道不会缺席；退出前跑 `check-dev-runtime` 并把结果写进 `ingress-private\dev-switch\restart.json`。

## 自动守护（CF 通道兜底）

`watch-dev-stack-20261107.py` 常驻（已启动）：每 45 秒检查 3180/3181/20259，连续两次有端口不在就**整栈重启**（因此 CF 通道一起回来），失败后退避 5 分钟再试。

| 操作 | 方法 |
|---|---|
| 查看状态 | `ingress-private\dev-switch\watchdog.json`、`watchdog.log` |
| 暂停（例如你要手工调试） | 新建 `ingress-private\dev-switch\watchdog.pause` |
| 恢复 | 删除该 pause 文件 |
| 停止 | 结束 `watchdog.json` 里的 pid |

## 回退到正式版（30 秒决定，约 2 分钟生效）

```powershell
Remove-Item 'C:\Users\qq135\dsh-migration-20261106\ingress-private\cli-override.json'
# 然后同样跑一次 restart-stack，栈会用回 runtime 里的安装版 CLI
```

删除开关后无需改任何代码；栈启动逻辑本身不变。

## 事故教训：不要手改被哈希钉死的启动器

`fire-stack.py`、`dshw-stack.py`、`stage-dshw-login.py` 用 `BASE_SHA` 互相校验字节哈希。2026-11-07 23:00 我在 `fire-stack.py` 里加 CLI 开关，导致 `Reviewed primitives changed`，整栈拒绝启动，服务中断约 28 分钟，最后由人工恢复（同步把三处 `BASE_SHA` 更新到改后的文件）。

规则：

1. 不要直接编辑这三个文件。
2. 必须改时：先备份 → 改 → 同步更新 `dshw-stack.py`、`stage-dshw-login.py` 里的 `BASE_SHA` → 在隔离环境验证完整起栈 → 才用于在线。
3. 任何"起不来"的兜底路径都必须先测过：当时我的兜底二次重启撞 `controller-missing`，再直接拉栈又撞同一哈希检查，等于没有兜底。

## 已知的次要告警（不影响使用）

- 启动时会报 2 个插件未激活：`workspace-controller`（配置里残留 macOS 路径 `/Users/evan`）与 `codex-computer-mcp`（MCP 客户端拉起失败）。两者在正式版运行时同样存在，属迁移遗留，不是开发版引入。
- Telegram 偶发 `轮询错误: operation aborted due to timeout`，属网络抖动，网关会自动重试。

## 相关脚本

| 脚本 | 用途 |
|---|---|
| `restart-dev-stack-20261107.py` | **整栈重启**（含 CF 通道）+ 完成后体检 |
| `watch-dev-stack-20261107.py` | 守护进程：端口掉线自动整栈拉起 |
| `check-dev-runtime-20261107.py` | 只读体检，7 项检查 |
| `restart-stack-20261107.py` | 底层受控停/起（栈自身协议） |
| `run-im-upgrade-20261107.py` | IM 插件升级窗口（支持 `--artifact/--artifact-sha/--backup-dir`） |
| `run-im-rollback-20261107.py` | IM 插件回滚窗口（走备份 tar，不依赖包管理器） |
