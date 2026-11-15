# Sidebar reconnect implementation plan

English | [中文](2026-11-11-sidebar-reconnect.zh.md)

> Execution: same-session direct TDD; no service restart. Checkpoint: final diff and isolated browser verification.

**Goal:** Keep existing display titles while a reconnect listing is pending or failed, with visible refresh status and Retry.

**Architecture:** The manager continues to reset authoritative projection watermarks at reconnect. The ClientSessions display adapter may reuse a previous row title only while its listing is loading or failed and no new explicit title has arrived. A successful listing replaces those display hints. The workspace browser consumes refresh state and an injected retry callback; it owns localized presentation.

**Paths:** Code worktree: `C:/Users/qq135/DSH/program/source/dsh/.agents/worktrees/fix-sidebar-reconnect`, branch `fix-sidebar-reconnect`. Plan: integration checkout `docs/plans/`; do not commit into the dirty integration checkout.

## Confirmed behavior

- Keep old titles as display hints, never as current-generation projection values.
- Show loading or failure status; expose Retry after failure.
- Accept lower sequence numbers from the new Host generation.
- Clear old labels when a successful listing supplies no title; explicit null clears immediately.
- Preserve every registered projection key; do not introduce a TTL or new cache.

## Task 1: Display adapter regression

Files: `packages/api/session-controller/src/client/sessions/service.ts` and `tests/sessions-service.client.spec.ts`.

Add delayed and failed reconnect tests, plus successful omission and explicit-null controls. RED: the previously displayed title disappears while the listing is pending. Keep manager resets unchanged. Add optional refresh status to the list snapshot and reuse only the adapter's previous displayed title during refresh.

## Task 2: Workspace feedback

Files: `packages/client/ui-workspace/src/client/contract/slots.ts`, `index.ts`, `rows/WorkspaceBrowser.tsx`, `locales.ts`, and affected tests.

Add a retry callback through injection. Show localized refreshing/failure feedback in the existing header without hiding list content. Test loading, failure, retry, and return to normal. Update package README pairs.

## Task 3: Verification

Run the focused service, manager, and workspace browser specs with the existing Vitest entry and one worker. Run local compiler faces, scoped oxlint, translation pairing, and diff whitespace checks. Review authoritative projections separately from display hints. Build only after integrating reviewed changes; repeat the isolated delayed/failed browser probe against loaded artifacts. No restart is authorized.

## Execution receipt

- Browser baseline: delayed list produces 4 unnamed rows out of 6; a 503 leaves 4 unnamed rows.
- RED: service regression failed with `expected undefined to be 'Before reconnect'`; the explicit-null control passed.
- GREEN: 268 focused service/manager/browser component tests and 158 assembly tests passed; package typechecks and scoped lint passed.
- Pairing: implementation plan pair and two package README pairs validated.
- Tests / built / loaded: yes / both client faces built / yes in a fresh isolated browser against the existing local Host. The delayed list and 503 cases retained all labels, reported refresh state, and recovered through Retry; 0 unnamed rows and 0 page exceptions. Light and dark desktop sidebar captures inspected. The mobile drawer interaction and repository-wide build/check/snapshot gates were not verified.
- The nested worktree Vitest runner failed module resolution before collecting tests. Scoped patches were integrated with `git apply --check` and validated with the established integration-checkout runner; no service was restarted.
