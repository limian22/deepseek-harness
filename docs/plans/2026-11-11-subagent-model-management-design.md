# Subagent model management

**Status:** accepted 2026-11-11
**Scope:** an ancestor agent may re-route a live descendant's model, and a delegated Session's own page may select its model.

## Problem

A delegated Session inherits its route from the Agent that created it. Neither the parent agent nor the child's page can change it afterwards:

- `packages/subagent/*/src` exposes no model-routing API; `tool-subagent-control` offers `send_message`, `interrupt_agent`, `wait_agent`, and `list_agents` only.
- `packages/client/ui-model-selection/src/client/index.ts` withheld both model entries from addressed subagent sessions.
- `packages/api/session-controller/src/commands.ts` recorded one Session's selection but also rewrote the deployment default.

The runtime capability already exists: a Session's `model/selection` event is last-wins, durable, and restored by the `modelSelection` projection, and `AgentModel.select()` appends it.

## Decisions

1. **Reuse `model/selection`.** No new Session event, so no format, SDK-projection, or snapshot change. The "who asked" distinction lives in the tool/UI layer, not in Session history.
2. **Authorization** stays in `subagent/model-selection-policy`, which keeps its first-wins semantics and is never rewritten:
   - an ancestor may choose only routes inside that allowlist; a route outside it fails with the allowed routes named;
   - a Session with no recorded policy accepts any configured route, matching the existing parent-route fallback;
   - a human acting on the child's page may choose any configured route, because users hold model-selection authority themselves.
3. **No default rewrite from a delegated Session.** `session.selectModel` accepts `persistDefault` (default `true`); delegated pages send `false`.
4. **Apply timing.** The change appends `model/selection` and takes effect from the target's next turn; work in progress is not interrupted.

## Interfaces

`set_subagent_model({ agent, provider, model, reasoning_effort? })` in `tool-subagent-control`:

- resolves `agent` through `ctx.subagents.resolveName()`, which scopes names to the caller's own descendants;
- requires a live Agent for the target, otherwise asks the caller to resume it first;
- validates the route against the target Session's allowlist and `ctx.llm.resolveCallConfig()`;
- returns `{ agent, provider, model, reasoningEffort?, changed }`.

`session.selectModel` gains optional `persistDefault`. The Web model entries are enabled for addressed subagent sessions and pass `persistDefault: false` there.

## Verification

- `tool-subagent-control/tests/set-model.spec.ts`: allowlisted route applied, route outside the allowlist refused with the allowed list, no-policy Session accepts any route, unchanged route reports `changed: false`, unresolvable route fails before the Agent is touched.
- `ui-model-selection/tests/browser-plugin.client.spec.ts`: an addressed subagent Session exposes both entries and submits `persistDefault: false`.
- `session-controller` tests keep covering the default-writing path for ordinary Sessions.

## Known limitations

- The target must have a live Agent; routing a cold, non-resumable child is out of scope.
- A Session whose recorded allowlist names models the deployment no longer configures stays unusable from the ancestor path; the page path can still move it to a configured route.
