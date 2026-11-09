# Subagent model policy implementation plan

English | [中文](2026-11-08-subagent-model-policy.zh.md)

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make the user's selected child-model list constrain implicit as well as explicit delegation routes.

**Architecture:** Keep the durable session policy and existing settings lifetime. Resolve omitted routes deterministically within that policy, preserving an allowed effective configured route, then an allowed parent route, otherwise choosing the first allowed route. Never silently fall back outside the policy after provider errors. Unconfigured/disabled sessions retain existing behavior. User explicitly approved “限定使用勾选模型” in this session.

**Tech Stack:** TypeScript, Cordis, Vitest, pnpm.

## Global constraints

- Do not alter unrelated existing working tree changes.
- No production restart or profile plugin mutation during the executing turn.
- Empty active policy fails closed; invalid explicit route still rejects.
- Changing route clears inherited reasoning effort; preserve unrelated Agent options.
- Test results, built artifacts, loaded runtime and live provider response are separate acceptance gates.
- Fixed-runtime external CLI agents require explicit assessment, not accidental rerouting.

## Task 1: Policy-aware omitted route resolution

Files: `packages/subagent/tool-subagent/src/model-selection.ts`, `src/index.ts`, `tests/model-selection.spec.ts`, related package docs/tests.

1. Replace the existing regression expectation permitting out-of-policy defaults with tests that require the selected route. Cover a single allowed Flash route with a GPT parent, multi-route deterministic ordering, allowed defaults/parent, partial configured route, preserved non-LLM options, effort reset, empty policy, explicit rejection, disabled/no-policy compatibility and fork reuse.
2. Run `pnpm exec vitest run packages/subagent/tool-subagent/tests/model-selection.spec.ts` and record failing assertions before implementation.
3. Implement policy-aware resolution in the shared resolver. Preflight the effective selected route before creating a child; do not carry provider-owned defaults into another route inadvertently.
4. Run `pnpm exec vitest run packages/subagent/tool-subagent`; review all failures before proceeding.

## Task 2: Entry-point audit and consistency

Audit confirmed that workflow directly calls `startActivation`, while ordinary tools use a tool-local resolver. Move policy/projection ownership and shared pure route helpers into `packages/subagent/subagent/src/model-selection.ts`, re-export existing tool-local imports for compatibility, and enforce admission at the shared service boundary after exact-parent authorization. Reject explicit out-of-policy routes, choose an allowed route for omitted selection, and reject fixed-runtime backends unable to honor a recorded policy. Add core service and workflow host regression tests (RED before implementation), then run both package suites. Regenerate current persistence catalogs if declaration ownership changes; never alter frozen release schemas. No service restart or live-profile mutation.

## Task 3: Review, UI copy and verification

1. Update settings explanation to state that omitted routes remain constrained, and document deterministic defaults.
2. Review the integrated diff independently, covering route preflight and policy bypasses.
3. Run relevant delegation/workflow/settings tests and targeted type checks where practical.
4. Build affected artifacts using repository-supported commands, without racing other builders or overwriting unrelated work.
5. Report whether the running process loaded the fix; if backend restart is needed, defer controlled activation and real omitted-route smoke test to a maintenance boundary.
