# IM Self-Reload Guard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Move the installed IM self-reload safety patch into clean, reviewable DSH source and diagnose the failed IM Connect deployment without touching the live service.

**Architecture:** Reject profile mutations from IM-owned tool callers before approval or manager reconciliation. Walk only attached ancestor sessions using optional Agent/Session registries; retain all existing approval and manager behavior for reads and ordinary Web callers. This is an accidental self-unload guard, not an authorization boundary or a complete solution for unloaded remote ancestors.

**Tech Stack:** TypeScript, Node 24 built-in TypeScript stripping and node:test; upstream Vitest integration fixture.

---

## Baseline and scope

- Clean local clone at `workspaces/dsh-local-dev`, branch `fix/im-self-reload-guard`, baseline `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` (0.2.2-rc.1). Origin points to official upstream. No network refresh or claim of latest upstream.
- Production stays on its existing npm installation. No package install, reload, restart, external messages, secrets, or live configuration writes.
- Reuse the existing local patch's behavior, but declare optional registry dependencies explicitly. Current source supports `origin: 'subagent'` only; do not add an unsupported IM-origin header format. Identify IM owners by existing `dsh-im-session-` and legacy `im:` IDs, including an unloaded direct ancestor ID.
- Considered: keep patching installed JS (not reviewable), replace profile/plugin lifecycle (too broad), or narrow source guard (chosen).

### Task 1: Red-capable offline regression

**Files:** Create `packages/boot/plugin-manager/tests/im-self-reload.node.test.mjs`.

1. Load the actual `src/tools.ts`, strip TypeScript using Node's built-in module API, strip static imports, and register it in a VM with manager/approval/registry doubles.
2. Assert all five mutations refuse direct IM and attached descendants before approval/manager access. Assert all three reads preserve approval; ordinary Web/no-agent callers preserve mutation behavior. Cover legacy IDs, missing and cyclic ancestry, maximum depth, Session-store fallback, late registry lookup, and no prefix false positives.
3. Run `node --test packages/boot/plugin-manager/tests/im-self-reload.node.test.mjs` against baseline; record failures caused by missing guard, not setup errors.

### Task 2: Minimal source guard

**Files:** Modify `packages/boot/plugin-manager/src/tools.ts`, `packages/boot/plugin-manager/package.json`.

1. Keep the original required injection array. This vendored Cordis does not support `inject: { required, optional }`; read optional registries using its documented `ctx.get('agents')`/`ctx.get('sessions')` APIs, not direct properties. Add type-only augmentation imports and declare matching optional peer dependencies already available as dev dependencies.
2. Before policy resolution, for non-list actions walk current session and at most 64 distinct ancestor IDs. If an ID begins `dsh-im-session-` or `im:`, throw `Error` with code `im-self-reload-blocked`. Check ancestor ID before lookup so the direct unloaded IM parent is still recognized. Resolve further ancestors from Agent registry then Session store. Cycles and missing ancestors stop traversal.
3. Update tool description to explain the refusal and external maintenance path. Do not change sandbox mode or approval rules.
4. Rerun the exact Node test command; require all cases green.

### Task 3: Upstream integration coverage and review

**Files:** Modify `packages/boot/plugin-manager/tests/tools.spec.ts`; create `docs/plans/2026-11-07-local-repair-status.md`.

1. Add real-tool fixture tests for direct IM mutation rejection and list-only access; manager spies must remain untouched for refused mutations.
2. Run `git diff --check`; review source, optional dependency metadata, lifecycle limitations, and red/green results.
3. If workspace dependencies are absent, explicitly report Vitest/type-check/full build as not run; do not install into the running profile or fake a complete development build.
4. Record IM deployment evidence and a copy-profile installation preflight: pin existing pnpm store/version/environment, verify artifact/source hashes and dependency graph in an isolated profile, prepare rollback artifact before requesting a maintenance window. Never rerun the failed production script unchanged.
5. Keep source local and reviewable; no push/PR/deployment without a separate deliberate step.

## Completion gates

Offline red/green regression + whitespace check; clean source baseline provenance; sanitized IM deployment audit; explicit distinction between source-ready and production-ready. A dev-service switch additionally requires dependency install/build, artifact compatibility, isolated smoke acceptance, rollback validation, and approved maintenance window; none is implied by unit tests.
