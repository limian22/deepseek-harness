---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-mcp-tool-context

[English](2026-11-09-mcp-tool-context.md) | 中文

## 概述

为按需 MCP 调用转发的延迟图像上下文增加生产方拥有的 mcp-mode 来源类型。嵌套分派事件字段保持不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-mcp-tool-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "a29f84754aeb47811ce3c3e97a4ebe5acc67fccc5a961b19e5031bc2fea7ac35"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "a08f91d29b1c4e4dc4b25606343dc9e71d142f21be9a00aa85538ee180e4a3da"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "f9d830fa78f30a27fb7f835eccf81cdad9beb54a823c547273245ea9217e7db2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "d3e8b467e9f52dd37bc2943aa61a584e5b5d788e5658b2535e65e18afc5d9a34"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

保持同一格式版本：已有记录与来源类型仍然有效。来源类型是可合并扩展的归属判别符，不是指令或事件判别符。已发布的 V4 来源准入逻辑会不透明地保留非空的生产方类型；mcp-mode 回归覆盖原生恢复与 V3 迁移。新读取方保留相同的消息内容和来源对象。无需修改解码器、头版本、事件键或嵌套分派载荷。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts：11 项通过，包括 mcp-mode 的迁移与原生恢复。packages/mcp/mcp-client/tests/discovery.spec.ts：22 项通过，包括使用 mcp-mode 来源转发延迟上下文与图像。pnpm run build:artifacts：8 个构建步骤全部通过。

<a id="dev-note"></a>
## 开发备注

无。
