# Local repair status and activation gates

Date: 2026-11-07 (Asia/Shanghai).

## Scope and provenance

A clean independent local clone was created from the preserved DSH Git object database, not from its dirty working-tree files. Baseline `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`, branch `fix/im-self-reload-guard`. Origin is `https://github.com/deepseek-ai/deepseek-harness.git`. This shallow baseline is the locally available 0.2.2-rc.1 commit, not a claim that upstream has not advanced. Existing migration worktrees were not changed. No push, PR creation, dependency install, service replacement, reload or restart was performed.

## Source guard

`packages/boot/plugin-manager/src/tools.ts` rejects the five profile-changing management actions for callers whose current or attached ancestor ID uses the IM prefixes. The check runs before sandbox policy/approval/manager access. The three listing actions retain normal permission checks. Ordinary Web/no-agent callers retain original behavior. Ancestors resolve through optional Agent registry then attached Session store, with cycle and 64-ID traversal bounds. Optional peer dependencies are explicit.

Limitations: this is an accidental self-unload safety guard, not a security boundary. It cannot reconstruct unloaded non-IM intermediate ancestors or guarantee detection beyond the traversal bound. The current source Session schema accepts only `origin: 'subagent'`; the old installed patch's unsupported `origin: 'im'` heuristic was deliberately not added to the source schema. No external Web/API mutation is blocked by this tool-only change.

## Verification

- Native Node fixture executes the actual stripped TypeScript entry point with isolated approval/manager/registry doubles; it does not unload any plugin.
- Before patch: **28 cases, 18 failed / 10 passed**. All failures were missing expected refusal, not fixture setup errors.
- After patch: **28 passed / 0 failed** initially; final suite after adding dependency-metadata/proxy regression checks: **29 passed / 0 failed**.
- Independent review caught incorrect optional-injection metadata and unsafe optional property reads. Both were corrected: retain the original required service array and use `ctx.get(...)` for registries. The Node fixture now checks metadata and throws on unsafe direct optional-service access.
- Additional [isolated Cordis registration check](<C:/Users/qq135/dsh-migration-20261106/workspaces/local-repair-audit-20261107/verify-guard-cordis.mjs>): **2 passed / 0 failed**. It mounts the actual tool through the installed Cordis framework using fake manager/tools/approval and checks missing-registry Web access plus Session-store IM ancestry. It never imports the production profile or IM plugin.
- Added 9 upstream Vitest integration cases (5 mutation actions, 3 read actions, unloaded IM parent); **not executed** because this checkout has no workspace dependencies.
- `git diff --check` passed after source/test edits.
- Full type-check, lint, workspace Vitest and monorepo build have **not run**. Native fixtures use VM doubles; the additional isolated Cordis check verifies limited registration/optional-service behavior, not the real unload lifecycle. This is source preparation, not a production-ready/dev-runtime acceptance claim.

## IM deployment audit

See [sanitized audit](<C:/Users/qq135/dsh-migration-20261106/workspaces/local-repair-audit-20261107/im-deployment-audit.md>) and [offline verification script](<C:/Users/qq135/dsh-migration-20261106/workspaces/local-repair-audit-20261107/verify-im-deployment.py>). The Lead reviewed and reran the latter with the existing Python interpreter using `-I -B`; exit 0.

- Install failed with `ERR_PNPM_UNEXPECTED_STORE`: existing dependency links use the migration-root pnpm store; the detached invocation selected the user's AppData store.
- Rollback reinstall failed with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. The old package archive restore was never reached. Installation-hook failure also bypassed stack startup in that script.
- Current installed package/profile/lock metadata remains **1.0.27**, not the integrated 1.0.28.
- Relative to archived patched 1.0.27, 391 files match and 8 differ; none missing/extra. Subsequent configuration/state changes also exist. Do not blanket-restore the old snapshot.
- Candidate artifact matches expected checksum; all 420 archived files match clean local integration commit `0cb233df09dcbfa2a1b0ee4e608c5c640190a1b6`.
- No candidate integration marker/new mention-policy/thinking-display module is installed. On-disk metadata/comparison does not establish loaded runtime bytes, provider success, or Telegram delivery.

## Deployment and rollback design (not executed)

### A. Prepare without touching live services

1. Capture a fresh current package/config snapshot; preserve failed deployment evidence. Copy state only to a local protected backup if needed; never print credentials or copy active bot credentials into a running test instance.
2. Audit the eight later IM file changes and their regression evidence. Decide explicitly which are preserved/ported/replaced. Version numbers alone are not a merge strategy.
3. Pin Node/package-manager versions and effective store configuration in each isolated checkout/profile. Check modules metadata against the effective store **before any stop hook**. Do not set global pnpm configuration, force module-directory purge, set `CI=true` to bypass prompts, or blindly rerun the existing one-shot script.
4. Prepare DSH workspace dependencies in the isolated clone, verify lockfile consistency and any approved build scripts, run targeted integration/type checks and the affected full build. Preserve failures rather than labelling VM tests a substitute.
5. Validate candidate IM artifact install and exact rollback in a disposable profile, using explicit store selection, noninteractive behavior designed in advance, scripts disabled unless reviewed, and immutable checksums. A true offline test uses `--offline`, not merely `--prefer-offline`.
6. For any later smoke boot, use a separate home/profile with channel credentials excluded/disabled so no duplicate bot poller runs. Do not start a replacement public GUI.

### B. Transaction and rollback gates

- Capture the **latest** live package and metadata/state at the approved quiet boundary; never overwrite newer model choices or activity state with the old 18:49 snapshot.
- Rollback must work from prepared exact files/artifacts without requiring the same failed network/package-manager operation to succeed.
- Stack recovery must be independent of installation-hook success (guarded finally/error recovery through the existing owned-process controller). Do not stop the stack until both install and rollback rehearsal pass.
- Confirm no concurrent package writers or active turns will be disrupted before requesting the maintenance window.

### C. Activation acceptance

Switching the current service to DSH local source still requires explicit maintenance confirmation. Verify launcher/build identity, authenticated existing GUI after refresh, loaded tool schema/guard path without destructive probe, one real user conversation, and separately authorized Telegram delivery. Listener readiness or test counts alone are insufficient. Keep old launcher/package snapshots for a verified rollback. No automatic hot-update promise is made.

## Round 2 results (2026-11-07 evening)

Work tree: `workspaces/dsh-local-dev`, branch `fix/im-self-reload-guard`, commit `9a349a37` plus this round's docs. Live service untouched; no restart, HMR, provider call or external message.

### Dependency preparation

- Installed runtime pnpm is 12.18.0 and its `node_modules/.bin/pnpm.cmd` shim is not a usable entry point (it calls an extensionless shell placeholder). Not repaired.
- Source pin is pnpm 11.28.5. It was prepared through Corepack under an isolated `COREPACK_HOME` (`workspaces/dsh-dev-toolchain/corepack`); no global or live-profile package-manager change.
- `pnpm install --frozen-lockfile --ignore-scripts --store-dir .../dsh-dev-toolchain/store` finished **exit 0**, 1434 packages, 394 workspace projects, 2m13s, full log `workspaces/dsh-dev-toolchain/logs/install-20261107-locked.log`. Store confirmed as the isolated `.../store/v11`; lockfile unchanged; no lifecycle script ran.
- Pending build scripts remain listed in `node_modules/.modules.yaml`; they were not enabled.

### Complete serial build

- `pnpm exec tsx scripts/build.ts --serial`, **exit 0**, 10 gates passed / 0 failed / 0 skipped in 574s. Order: native addon 1.3s, Host Typert 50.7s, host compiler 178.8s, Host bundle 19.8s, Desktop bundle 2.4s, client compiler 95.0s, Client bundle 19.6s, Web build 8.7s, host aggregate check 115.4s, client aggregate check 82.3s. Log `workspaces/dsh-dev-toolchain/logs/build-20261107-serial.log`.
- Serial (`--serial`) was chosen deliberately: this machine is shared with the live service and had ~5-7 GiB free memory, so the default 12-worker local budget was not used.

### Tests after the build

- `vitest run packages/boot/plugin-manager/tests/tools.spec.ts`: **40/40 passed**, exit 0. This is the real DSH fixture through `ctx.plugin(tool)`, so it now covers the mounting/optional-injection defects independent review found, including the 5 new mutation refusals, 3 read cases and the unloaded-IM-parent case.
- Native guard suite: **29/29 passed**. Isolated real-Cordis registration check: **2/2 passed**.
- CLI artifact in the isolated tree reports `0.2.2-rc.1` (exit 0) with `DSH_HOME` pointed at a fresh unused directory.

### IM Connect isolated rehearsal (delegate, Lead-verified)

Report: [installation-rollback-rehearsal.md](<C:/Users/qq135/dsh-migration-20261106/workspaces/im-install-rehearsal-20261107/installation-rollback-rehearsal.md>). The Lead reran its independent verifier (`verify_evidence.py` via `python -I -B`): PASS, exit 0, reproducing 1.0.27 (399 files) → 1.0.28 (420) → 1.0.27 (399) with the baseline manifest hash restored exactly.

- **Artifact-level placement and exact reversal: PASS.** Deterministic npm-layout repack of the old uncompressed tar preserves all 399 regular-file bytes; candidate tgz copied byte-identically. No overlay artifacts, no fake lockfile, normal-operation (not crash-atomic) reversal.
- **Real package-manager installation: still NOT achieved in isolation.** Fresh-cache pnpm 12.18.0 failed `ERR_PNPM_BAD_CONFIG_DEP` for its own config-dependency metadata; npm `--offline` failed `ENOTCACHED` for `@deepseek-ai/cordis` with unresolved peers. Policies, strict peers and scripts were left intact; no network was used.
- Therefore full production dependency closure, a real frozen reinstall, loaded-runtime compatibility and channel startup remain **unverified**. The old archive also predates the eight later local package-file changes, so a live restore from it would discard newer fixes.

### Remaining gates before switching this GUI to the dev build

1. Stage a dependency-complete rehearsal in its own store/cache (host, peer and package-manager config-dependency metadata) with ordinary policies, then prove frozen install and rollback without the failing path.
2. Preserve the eight later IM local changes separately and decide each one's fate.
3. Back up the current launcher/package/profile/state at an approved quiet boundary; keep restart recovery independent of install-hook success.
4. Switch launcher, then verify authenticated GUI after refresh, the loaded tool schema, one real admitted conversation, and separately authorized Telegram delivery. Roll back on any failed gate.

## Round 3 (in progress): dependency closure and the eight later IM changes

### Eight later local IM changes: decided

Preserved byte-exactly with diffs and provenance in [im-local-changes-preserved-20261107-2](<C:/Users/qq135/dsh-migration-20261106/workspaces/im-local-changes-preserved-20261107-2/README.md>). They implement two fixes: the cold-start deferred-delivery poisoning guard, and reply-stream serialization plus channel message sealing.

- The sealing/serialization fix is **already upstream in 1.0.28** (`reply-stream.ts:91-113` queues extraction and calls `stream?.seal?.()`; `telegram.ts:799` has `seal()`). Do not stack it again.
- The cold-start guard is **not** in 1.0.28. Probe `probe-turn-entries.mjs` returns `UNGUARDED`, and `gateway.ts:1094-1097` patches every matched entry to `blocked` on every event while `turn` can be `undefined`. Ported as an independent local commit in the IM integration checkout: `582d1b3 fix(delivery): never match unclaimed history by an undefined turn`, with red-then-green `tests/turn-guard.test.mjs`. Full IM suite: **1442 tests / 1417 passed / 0 failed / 25 skipped**, `tsc` build exit 0.
- Line-ending and build-copy churn was removed from that commit so it contains only the guard (3 source lines, 4 built lines, regenerated source maps, 1 test file).

### Dependency closure

A delegate is repeating the isolated install with one controlled network fetch into its own store/cache, mirroring the live profile's package specs (no state, credentials, `.env` or `cordis.patch.yml` copied) and copying `link:`/`file:` dependencies into the isolated scope so nothing links back to the live profile. Candidate install, frozen-lockfile rerun, and rollback to the prepared old 1.0.27 artifact are each required to pass before this gate is called done. Results will be appended here.

### Dependency closure: PASSED (isolated, credential-free)

Run `workspaces/im-install-rehearsal-20261107/network-run-20261107-205354-cf2313`. Two aborted runs and their evidence were retained, not overwritten.

- Controlled network install: **exit 0, 32.016 s**, 313 downloaded / 348 added; afterwards everything ran offline from a warm store. Only one retry was authorized, for a harness path-mapping defect that the exhaustive preflight (`validate_isolated_references.cjs`) then caught at 7 regression points.
- Candidate `@michengai/dsh-im-connect@1.0.28`: installed, then `--frozen-lockfile` offline **exit 0** (1.151 s, then 0.902 s); a **fresh `node_modules`** directory with the warm store also passed **exit 0** (5.600 s), so the result is not just idempotency of an existing tree.
- Rollback to the prepared old 1.0.27 artifact: install **exit 0** (3.159 s) and frozen offline **exit 0** (1.109 s).
- 9 IM peers resolve and satisfy version ranges in both candidate and rollback phases.
- The 176 extra files in the candidate package directory are pnpm `nodeLinker: hoisted` placement of `undici`: lock proves IM→6.29.1, `dsh-http-proxy`→8.11.2, `dshmarket`→7.30.1, and `.modules.yaml` `hoistedLocations` puts 6.29.1 inside the IM package. Dependency layout is recorded separately; the 420 artifact files were never altered.

Lead-side independent verification ([verify-final-rehearsal-lead.py](<C:/Users/qq135/dsh-migration-20261106/workspaces/local-repair-audit-20261107/verify-final-rehearsal-lead.py>), `python -I -B`, exit 0, verdict PASS) recomputed from the archives rather than trusting the report:

- candidate tgz = 420 files; saved candidate maps (initial, frozen, fresh-tree) match byte-for-byte with **0 missing / 0 extra / 0 mismatched**;
- old tar = 399 files; saved rollback maps (install, frozen) match the same way;
- rollback profile manifest exactly equals baseline `4dc08193…`; old package tree digest exactly equals `baa9e60b…` (the first verifier attempt reported FAIL only because it used `ensure_ascii=False`; with the rehearsal's documented canonical form it reproduces the declared digests, and the per-file maps had already matched).

Still **not** verified by this gate: loading the plugins in a running host, channel startup, real delivery, or that the live profile resolves the same peers (`testProfileOnlyPeerDeclarations: 40` are explicit in the isolated test profile only).
