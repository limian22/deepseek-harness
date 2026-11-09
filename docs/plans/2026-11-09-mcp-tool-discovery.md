# MCP tool discovery implementation plan

English | [中文](2026-11-09-mcp-tool-discovery.zh.md)

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Offer MCP tool search and on-demand invocation without placing every remote tool schema in each model request, while retaining the existing execution policy and durable audit trail.

**Architecture:** Keep original MCP tools registered and subject to scoped restrictions and step admission. Add an explicit opt-in discovery exposure mode: only compact discovery and invocation tools enter model declarations; selected original tools execute through the shared tool pipeline. Use existing nested dispatch recording semantics without changing persisted event fields or the agent loop.

**Tech Stack:** TypeScript, Cordis, Schemastery, MCP SDK, Vitest, existing native and PTC tool executors.

---

## Scope and acceptance

- Work only on branch `mcp-tool-discovery` in its isolated worktree. Do not alter running profiles, configuration, services, launchers, tunnels, or the original checkout's unrelated edits.
- Preserve direct exposure as the default. Configure discovery explicitly per MCP client and through the MCP manager.
- Do not depend on a model provider accepting deferred tools. Keep the default request small even for providers that require complete immediate declarations.
- Retain original public tool names for validation, guards, approval, timeout, cancellation, post-execution policy, and durable nested call records.
- Discovery must use the caller's scoped, step-admitted registrations, never a global cache that bypasses restrictions or a stale previous connection generation.
- Search is deterministic and bounded, supports pagination and exact lookup, and reports omissions explicitly. Full schemas are returned only when requested.
- Forward the authoritative post-policy content. Never return a raw successful value after policy has blocked or replaced it.
- Keep resources and server instructions unchanged; report these remaining context costs independently.

## Measurement card

| Field | Decision |
|---|---|
| User operation | Prepare model declarations for an MCP server, discover one tool, and invoke it |
| Workload | Fixed synthetic catalogs including a small catalog and a 250-tool catalog with substantial descriptions and nested parameter schemas |
| Entry path | Actual MCP registration and system-prompt assembly with native execution; include PTC regression coverage |
| Metric | Serialized declaration UTF-8 bytes and tool count; tokenizer counts only if an exact selected-model tokenizer is available |
| Exclusions | Network/model latency, real-service behavior, private user tool metadata, server instructions, and resources |
| Verdict | Discovery declarations stay constant as the remote catalog grows; large-catalog declaration size falls materially; direct mode is the negative control |
| Behavior | Original-name policy denial, input failure, successful result, cancellation, resync, removal, and recorded nested identity |

### Task 1: Tool presentation and execution foundation

**Files:**
- Modify only if needed: `packages/core/tools/src/contracts.ts`, `packages/core/tools/src/index.ts`, `packages/core/tools/src/pipeline.ts`.
- Modify only if needed: `packages/core/tool-executor-native/src/index.ts`, `packages/core/tool-executor-ptc/src/index.ts`, `packages/core/tool-executor-ptc/src/types.ts`.
- Test: `packages/core/tools/tests/tools.spec.ts` and focused executor tests.

1. Read the tool registry, guarded invocation pipeline, native descriptions, PTC bindings, and nesting recorder before choosing an extension.
2. Write failing tests for a registered tool omitted from model declarations while remaining available to a guarded nested invocation in its original scope.
3. Run `pnpm exec vitest run packages/core/tools/tests/tools.spec.ts` and observe the feature-specific failure.
4. Implement the smallest generic presentation distinction required by the MCP consumer. Keep access restrictions separate from presentation metadata; do not use schema omission as security enforcement.
5. Ensure model declarations and executor guidance both exclude hidden schemas, while introspection and executable lookup retain admitted originals.
6. Run focused tests, including scope restrictions, step expiration, shadowing, and native/PTC behavior. Record the exact command and outcome.

### Task 2: MCP discovery and invocation

**Files:**
- Create: `packages/mcp/mcp-client/src/discovery.ts`.
- Modify: `packages/mcp/mcp-client/src/index.ts`, `packages/mcp/mcp-client/src/tools.ts`, and connection/generation option forwarding as necessary.
- Create: `packages/mcp/mcp-client/tests/discovery.spec.ts`.
- Modify: `packages/mcp/mcp-manager/src/index.ts` and owning manager tests.

1. Write failing tests for opt-in exposure: original registrations exist, but only compact discovery/invocation declarations reach the model.
2. Write failing tests for deterministic query matching, empty-query paging, exact tool lookup, non-ASCII text, complete-result byte bounds, and oversized single definitions.
3. Run `pnpm exec vitest run packages/mcp/mcp-client/tests/discovery.spec.ts` and observe missing-feature failures.
4. Add validated configuration for exposure and result budgets with explicit defaults. Forward it through both transport types, connection generations, and manager-created clients.
5. Implement discovery over current, caller-visible original definitions; reject stale or foreign-shadow registrations rather than routing them to another server.
6. Implement invocation through `ToolExecutionPipeline` under the original name, forwarding agent, step admission, parent token, root call identity, and cancellation.
7. Record nested start and settlement before the outer call returns. Preserve original arguments, error state, authoritative content, and presentation metadata. Ferry deferred contexts and successful turn-conclusion markers.
8. Test original-name policy denial with zero remote side effects, invalid original arguments, unavailable and restricted originals, cancellation, timeout, resync, disposal, and post-policy replacement.
9. Run MCP client and manager tests plus affected core executor tests. Do not start another dependency install or build while an owned one is running.

### Task 3: Real composition, transcript, and measurement

**Files:**
- Add package-owned Loader fixtures and a non-unit composition test under `packages/mcp/mcp-client/tests/fixtures/` and `packages/mcp/mcp-client/tests/`.
- Add a keyless model-visible recorded-session case under `snapshots/` using the existing fixture registration mechanism, if current support permits it; missing harness support belongs to the same change.
- Add package-owned measurement assertions to `packages/mcp/mcp-client/tests/discovery.spec.ts` or a separate focused spec.

1. Boot the production MCP plugin through the real Loader with a controlled local fixture server and no private user configuration.
2. Assert model-facing declarations, discovery output, successful original call, denial, and durable original-name nested records.
3. Pin model-visible stable wording and dynamic omission behavior in a keyless snapshot.
4. Compare direct and discovery declarations for identical fixed catalogs; publish exact bytes, counts, and ratio rather than invented token counts.
5. Run the corresponding composition and snapshot commands and report any platform or dependency limitations separately from functional results.

### Task 4: Documentation, review, and verification

**Files:**
- Update affected README English/Chinese pairs for MCP client, manager, and changed core tool contracts.
- Update `docs/subsystems/mcp.md`, `docs/subsystems/mcp.zh.md`, and tool subsystem references when a public type changes.
- Regenerate affected configuration/tool/API catalogs using their existing generators, never hand-edit generated regions.

1. Document opt-in configuration, discovery workflow, permissions, costs, failure behavior, lifecycle, and limitations alongside the owning packages.
2. Re-record edited bilingual pairs with the repository pairing tool.
3. Obtain independent code review focused on permission bypass, scope leakage, stale generations, bounds, output replacement, cancellation, and nested recording.
4. Fix substantiated findings with regression tests.
5. Run focused Vitest suites, lint for changed sources, relevant documentation checks, and `git diff --check`.
6. Run `pnpm run build:artifacts`, then `pnpm run build:check` after the latest artifact build, with recorded exit statuses. If the build cannot complete, state the concrete blocker and do not claim verification.
7. Review the final diff. Report measured declaration savings, exact checks, remaining unverified external-service behavior, branch/worktree location, and the fact that online activation has not occurred.

## Ownership

The builder owns production source and package-local tests. The lead owns this plan, documentation, catalog integration, and final verification. The independent reviewer reads the completed diff and reports actionable findings. Concurrent write scopes must remain disjoint.
