# 静态资源缓存调节实施计划

[English](2026-11-09-static-cache-tuning.md) | 中文

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** 消除内容命名的浏览器脚本与样式的重复验证，同时禁止缓存认证 HTML 或应用数据。

**Architecture:** 前端静态响应器仅将 assets/ 和 assets/langs/ 下 Vite hash 命名的 JavaScript、CSS 标记为浏览器私有不可变资源；其他文件继续验证，渲染出的 index 使用 no-store。部署代理的离线副本仅为经过核实的静态请求与响应组合保留私有缓存，并保留所有认证检查及默认 no-store 行为。代理候选文件及其摘要 pin 与运行中的服务分开保存。

**Tech Stack:** TypeScript、Cordis Loader 集成测试、Vitest、Node HTTP 与 node:test。

---

## 范围与测量

本计划覆盖浏览器对未变化构建的热缓存复用，不宣称首次下载、JavaScript 执行或插件激活变快。确定性的负对照是原始响应器为 hash 命名测试资源返回 no-cache；候选实现只能为符合条件的资源更改该策略。冷读取和强制验证的响应体、ETag、状态码、认证及错误行为分别断言。未授权浏览器自动化、在线重建、profile 重载、服务重启或部署。

## 任务 1：前端静态响应策略

文件：packages/host/frontend-static/src/index.ts 与 packages/host/frontend-static/tests/frontend-static.spec.ts。

1. 添加经 Loader 组合的测试，覆盖 hash 命名 JS/CSS（含语言分块）、GET/HEAD/304 一致性、不同构建 URL、无 hash 文件与 map 排除、查询参数与编码路径排除、认证 index 的 no-store，以及缺失或错误资源不得准入缓存。
2. 从隔离工作树运行 `node C:\Users\qq135\DSH\program\source\dsh\node_modules\vitest\vitest.mjs run packages/host/frontend-static/tests/frontend-static.spec.ts --maxWorkers=1`，在实现前记录预期的策略断言失败。如果相对可执行路径不可用，使用已有源码目录的 Vitest 绝对路径，不安装或重建在线依赖。
3. 添加严格的路径与查询参数分类器；仅为符合条件的 dist 资源返回 `private, max-age=31536000, immutable`，渲染出的 index 返回 `no-store`。保留 ETag 生成与回退语义，不引入服务端常驻缓存或公共 API。
4. 重跑聚焦测试与相邻 HTTP 服务测试，更新包 README 双语版本及源码 JSDoc。

## 任务 2：离线代理候选

文件：.cache/static-cache-proxy/proxy-core.mjs、.cache/static-cache-proxy/dshw_proxy.mjs，以及本地 Node 测试。服务目录中的在线文件保持不变。

1. 将当前部署源码复制到隔离候选目录，保留基线 SHA-256。
2. 添加 HTTP fixture 测试，确认原实现仍将符合条件的不可变静态响应标记为 no-store，运行并记录 RED。
3. 仅准入静态 URL 经过核实、响应元数据匹配且上游明确声明 immutable 的成功 GET/HEAD 响应。查询参数未知、编码路径、HTML/API、认证、错误及重定向响应不缓存。准入后改为浏览器私有缓存，保留 Access 验证、cookie 剥离与安全头。
4. 仅将候选 wrapper 的 pin 更新为候选 core 的 SHA-256，运行缓存策略与 pin 测试并记录 GREEN。

## 任务 3：审查与交付

1. 独立审查完整源码和部署 diff，检查缓存欺骗、私有数据缓存、旧构建、认证变化与部署风险。
2. 在隔离依赖环境支持的范围内运行聚焦测试、相关 lint/类型检查及 `git diff --check`。明确报告未运行的产物级检查，不重建在线目录。
3. 将源码与部署补丁、基线摘要及测试回执导出到运行目录。不覆盖在线文件，不改在线 pin，不重启，不宣称线上性能已改善。部署及端到端耗时验证由后续单独批准的维护窗口负责。
