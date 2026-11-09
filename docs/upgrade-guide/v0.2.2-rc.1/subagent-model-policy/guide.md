---
kind: upgrade-guide
description: Recorded child-model policies now constrain omitted delegation routes and reject backends that cannot select an authorized model.
---

# Child-model policies constrain every delegation

English | [中文](guide.zh.md)

## Change

Previously, the Subagent model-selection list constrained explicit model arguments only. Omitting those arguments could inherit a parent model outside the list. A recorded Session policy now constrains ordinary, fork, workflow, and direct service delegations. Omitted selection prefers an authorized effective configured route, then an authorized parent route, otherwise the first policy entry. Explicit unauthorized routes are rejected rather than redirected. Backends without child LLM route support, including fixed Codex, Claude Code, and ACP integrations, reject delegation while a Session policy is active.

Sessions without a recorded policy retain their previous default behavior. Settings changes still apply to fresh top-level Sessions; an existing recorded policy remains in force after restore. This change does not rewrite Session history.

## Migration

1. In Subagent settings, review the authorized model list. Include every model that new child delegations may use; select only Flash if all route-selectable children should use Flash.
2. If a deployment provides child defaults through `agentOptions` or `agentRouteDefaults`, include their effective provider/model pair in the list to retain those defaults. Otherwise omitted selections resolve to another authorized route.
3. To use a backend whose model the Harness cannot select, disable model selection and start a fresh top-level Session without a recorded policy. Do not expect disabling the preference to remove a policy already recorded in an existing Session.
4. After loading the updated runtime, create a child without model arguments and inspect its recorded provider/model. It must belong to the Session's authorized list. An explicit route outside that list must fail before a child starts.
