# Isolated Development Build and IM Rehearsal

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Qualify the local DSH checkout with locked dependencies/build/tests and rehearse IM artifact installation plus exact rollback without touching the live service.

**Architecture:** Keep the running npm installation/profile unchanged. Use pinned Node/pnpm and a separate store for the DSH clone; use a different disposable credential-free profile/store for the IM rehearsal. A successful build is not GUI or Telegram acceptance.

**Tech Stack:** Node 24.22.1, pnpm 11.28.5 (source pin), TypeScript, Vitest, existing reviewed IM artifact.

---

## Write scopes and constraints

- Lead: `workspaces/dsh-local-dev`, `workspaces/dsh-dev-toolchain`.
- IM delegate: `workspaces/im-install-rehearsal-20261107`, `workspaces/local-repair-audit-20261107`.
- No production profile/runtime/source-plugin writes; no restart, HMR, Telegram requests, global pnpm config, secret copying, or alternate public server.
- Installed runtime pnpm is 12.18.0 and its `.bin` shim is not a usable entry point. Source pin 11.28.5 is available from the official npm registry; Corepack prepared it under isolated `COREPACK_HOME`. Do not repair the live shim during this task.

## Task 1: Locked dependency preparation

1. Verify source Git status, baseline commit, package-manager pin and policy.
2. Run Corepack with `COREPACK_HOME=.../workspaces/dsh-dev-toolchain/corepack`.
3. Run `pnpm install --frozen-lockfile --ignore-scripts --store-dir .../workspaces/dsh-dev-toolchain/store --reporter append-only` in the clone; retain full log and exact exit code.
4. No lifecycle scripts run in this phase. Check required prebuilt tools individually after install. Do not disable supply-chain checks or rewrite lockfile merely to suppress installation failure.
5. Record effective modules store, pinned version and Git diff before moving to build.

## Task 2: Complete build and integration checks

1. Check memory/disk budget; this machine is shared with the live service. Use a serial build or explicit concurrency=1 rather than the monorepo's local default 12.
2. Run the complete `pnpm run build -- --serial` only after verifying its argument forwarding, or `pnpm run build --serial` as supported by the installed pnpm. Preserve aggregate gate summary, full log and process exit status. Do not run another build while one is running.
3. If a step fails, inspect exact log/source and reproduce the narrow failure before a minimal fix. New behavior requires regression coverage. Do not claim timeout equals failure.
4. Run targeted plugin-manager Vitest and regression checks after generated contracts exist. Rerun the native 29-case guard suite.
5. Verify CLI artifact version without loading any production profile. Full GUI/provider/channel acceptance remains pending.

## Task 3: Credential-free IM installation/rollback

1. Audit artifact archive layout and expected checksum before extracting or installing.
2. Build a new minimal disposable profile, explicitly pinned package manager/store, scripts disabled. Never copy live account credentials/state.
3. Attempt ordinary dependency closure offline first and record cache misses. If full closure cannot be reproduced safely, label a narrower artifact-level transaction separately.
4. Stage a known baseline artifact/tree and metadata; install the candidate; compare installed bytes against the immutable candidate; restore baseline using prepared artifacts, not a dependency on the same failing install path; verify exact tree/metadata.
5. Keep rollback/dry-run receipts and distinguish an isolated artifact test from full profile/loaded runtime or real messaging validation.

## Task 4: Review and activation handoff

1. Lead reviews delegate's scripts/report and reruns safe verification.
2. Record build/test commands, counts, skipped work and failures. Review final Git diff and tests before commit.
3. Only after build and rollback gates pass, propose a separate maintenance window. Switching the existing GUI to the dev build still requires current-state backups, exact launcher change, authenticated refresh and a real admitted conversation. Telegram acceptance is separate and requires an authorized test.
