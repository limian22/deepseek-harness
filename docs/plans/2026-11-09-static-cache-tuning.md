# Static resource cache tuning implementation plan

English | [中文](2026-11-09-static-cache-tuning.zh.md)

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Remove repeated validation of content-named browser scripts and styles without caching authenticated HTML or application data.

**Architecture:** The frontend static responder marks only Vite hash-named JavaScript and CSS under assets/ and assets/langs/ as private immutable browser resources; every other file keeps revalidation and the rendered index is no-store. An offline copy of the deployment proxy preserves private caching only for verified static request/response combinations and keeps all authentication checks and default no-store behavior. The proxy candidate and its digest pin remain separate from the running service.

**Tech Stack:** TypeScript, Cordis Loader integration tests, Vitest, Node HTTP and node:test.

---

## Scope and measurement

This plan covers warm browser reuse of an unchanged build. It does not claim faster first-ever download, JavaScript evaluation, or plugin activation. The deterministic negative control is the original responder's no-cache header for a hash-named fixture; the candidate must replace that policy only for eligible resources. Cold and forced-revalidation bodies, ETags, status codes, authorization, and error behavior remain independently asserted. No browser automation, live rebuild, profile reload, service restart, or deployment is authorized.

## Task 1: Frontend static response policy

Files: packages/host/frontend-static/src/index.ts and packages/host/frontend-static/tests/frontend-static.spec.ts.

1. Add Loader-composed tests for hash-named JS/CSS (including language chunks), GET/HEAD/304 parity, distinct build URLs, non-hash and map exclusions, query/encoded-path exclusions, authenticated index no-store, and missing/error resource non-admission.
2. Run `node C:\Users\qq135\DSH\program\source\dsh\node_modules\vitest\vitest.mjs run packages/host/frontend-static/tests/frontend-static.spec.ts --maxWorkers=1` from the isolated worktree and record the expected policy assertion failures before implementation. If the relative executable is unavailable, use the existing source checkout's absolute Vitest executable without installing or rebuilding online dependencies.
3. Add a narrow pathname/query classifier; return `private, max-age=31536000, immutable` only for eligible dist resources, and `no-store` for the rendered index. Preserve existing ETag generation and fallback semantics; introduce no retained server cache or public API.
4. Re-run the focused suite and neighboring HTTP server tests. Update the package README pair and source JSDoc.

## Task 2: Offline proxy candidate

Files: .cache/static-cache-proxy/proxy-core.mjs, .cache/static-cache-proxy/dshw_proxy.mjs, and owner-local Node tests. The online files under the service directory remain untouched.

1. Copy the current deployment source into the isolated candidate directory and retain its baseline SHA-256.
2. Add HTTP fixture tests showing that eligible immutable static responses remain no-store on the original implementation; run them and record RED.
3. Admit only successful GET/HEAD responses with a verified static URL, suitable response metadata, and an explicit upstream immutable policy. Reject unknown queries, encoded paths, HTML/API, authentication, errors and redirects from caching. Rewrite admitted policy to private browser caching; preserve Access verification, cookie stripping and security headers.
4. Re-pin only the candidate wrapper to its candidate core SHA-256. Run cache-policy and pin tests, and record GREEN.

## Task 3: Review and handoff

1. Independently review the complete source and deployment diffs for cache deception, cached private data, stale builds, authentication changes and unsafe rollout.
2. Run focused tests, relevant lint/type checks where the isolated dependency setup supports them, and `git diff --check`. Report unavailable artifact-wide checks explicitly rather than rebuilding the live checkout.
3. Export source and deployment patches with baseline digests and test receipts to the run directory. Do not copy a candidate over online files, change live pins, restart, or claim online performance gains. A later approved maintenance window owns deployment and end-to-end timing.
