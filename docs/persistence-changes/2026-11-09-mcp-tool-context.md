---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-mcp-tool-context

English | [中文](2026-11-09-mcp-tool-context.zh.md)

## Summary

Adds the producer-owned mcp-mode source kind for deferred image context from on-demand MCP calls. Nested dispatch event fields are unchanged.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Same-version: existing records and source kinds remain valid. The source kind is a merge-extensible attribution discriminator, not an instruction or an event discriminator. Released V4 source admission preserves nonempty producer-owned kinds opaquely; the mcp-mode regression exercises native restore and V3 migration. New readers retain the same message content and source object. No decoder, header version, event key, or nested-dispatch payload changes are required.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts: 11 passed, including mcp-mode through migration and native restore. packages/mcp/mcp-client/tests/discovery.spec.ts: 22 passed, including forwarding deferred context and images with the mcp-mode source. pnpm run build:artifacts: all 8 build steps passed.

<a id="dev-note"></a>
## Dev Note

None.
