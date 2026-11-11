# Management and Session Read Performance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

English | [中文](2026-11-10-management-session-read-perf.zh.md)

**Goal:** Reduce repeated plugin-management metadata work and Session-list filesystem reads without weakening freshness or authorization.

**Architecture:** Keep plugin management in its existing Remote and store owners; remove the full inventory dependency from its availability check and deduplicate metadata within each operation. Keep canonical generation discovery in JSONL persistence; reuse only file observations whose current identity has been checked, without time-based freshness or global caches.

**Tech Stack:** TypeScript, Cordis, Typert, React stores, Node filesystem APIs, Vitest.

---

## Scope and constraints

This is an execution reference for the two measured read paths, not a redesign of application startup. The current checkout is the implementation target; no additional checkout or repository copy is required. Tests run serially with one worker. Product configuration, runtime artifacts, service processes, and browser debugging remain unchanged.

Local authenticated samples before implementation: Session list 2.42 seconds for 843 rows and 1,040,129 bytes; a subsequent call exceeded a six-second limit. Plugin inventory took 1.37 seconds, bundles 2.33 seconds, and plugins 1.57 seconds. These are individual backend samples, not browser latency percentiles or cold-start measurements.

## Task 1: Plugin management

**Files:** `packages/client/ui-plugin-manager/src/client/manager-store.ts`, its store tests, `packages/host/plugin-inventory/src/index.ts`, and the owning metadata helpers in `packages/boot/app-boot` or `packages/boot/plugin-manager` only as required.

1. Add a failing regression for the unnecessary full-inventory preflight and repeated metadata reads. Preserve managed/unmanaged behavior, errors, refresh generations, and disposal.
2. Run only the relevant spec with `node node_modules/vitest/vitest.mjs run <selected-spec> --maxWorkers=1`; record the expected failing assertion before changing implementation.
3. Use a lightweight existing availability result where possible; if an additive Remote is required, update its declarations and consumers together. Reuse metadata within an operation rather than introducing a long-lived TTL cache.
4. Re-run the selected specs and existing availability/access-control tests. Assert eliminated calls and identical returned data rather than relying on wall-clock thresholds.
5. Update the affected README pairs and pairing records. Do not activate or rebuild the running Host.

## Task 2: Session persistence listing

**Files:** `packages/session/session-persistence-jsonl/src/index.ts`, owner-local listing tests, and the package README pair.

1. Inspect the actual directory, generation, header, identity, and revision reads. Do not remove a final identity observation unless an equivalent fresh observation already exists.
2. Add a failing real-filesystem regression for repeated list work using temporary synthetic Sessions. Include external append/replacement, new or deleted Sessions, generation selection, historical translation, cancellation, and concurrent list behavior where affected.
3. After Task 1 releases the test slot, run the selected regression with one worker and record RED.
4. Retain directory discovery and current file-identity checks. Reuse unchanged header work only with explicit invalidation, instance ownership, bounded retention, and no caching of failed or incomplete reads.
5. Run the selected regression and relevant existing generation/migration fixtures serially. Compare filesystem call counts and returned snapshots; keep performance measurements separate from correctness assertions.
6. Update README semantics and the bilingual pairing record without changing persisted formats or existing Session generations.

## Task 3: Integration and evidence

1. Review the complete scoped diff and inspect all changed production consumers.
2. Run focused type or generation checks where required, not a full repository build. If artifact prerequisites prevent a check, name the missing verification rather than reporting success.
3. Run scoped whitespace, documentation pairing, and lint checks serially after both implementation tasks finish.
4. Report measured work reduction, executed pass/fail counts, remaining latency components, and the distinction between source changes and runtime activation. Do not claim a new live endpoint speed without deploying and measuring the corresponding artifacts.

## Acceptance

Plugin management no longer requires a full inventory solely to decide availability. Repeated metadata work is reduced without stale package data. Session list results remain fresh across external changes and canonical-generation selection, while unchanged files avoid redundant read work. Authentication, cancellation, disposal, and serialized results retain their existing behavior. No service is restarted or stopped by this plan.
