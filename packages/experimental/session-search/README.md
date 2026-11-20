---
description: "Give agents tools to search and read earlier sessions from the current workspace."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-session-search

English | [中文](README.zh.md)

## Summary

Give every Agent five experimental read-only global tools to search earlier sessions. The content index opens on the first search and is shared by all Agents. The bundle ships switched off in Web and Desktop and is hidden from the default plugin lists.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

In **Plugins → Add plugin**, enter `@deepseek-ai/dsh-experimental-session-search`, choose **Install**, then **Enable now**. DSH uses the shipped copy without downloading another one. Alternatively, add the name to `dsh.profile.bundles` in the target [profile](../../boot/app-boot/README.md#profiles)'s `package.json`. HMR applies the selection live when enabled; otherwise restart the application. The enabled bundle appears in Plugins; switching it off removes its profile layer and hides its card again. A separately installed profile dependency remains listed while disabled.

With HMR enabled, enabling or disabling the bundle registers or removes its global tools in the running Host, so every Agent sees the change on its next request, in every preset including minimal.

This bundle enables Agent search tools. Sidebar search keeps its existing behavior.

### Durable index and process ownership

The shipped layer keeps the isolated provider on an in-memory index. The optional [`durable index overlay`](examples/durable-index.cordis.patch.yml) stores the index under `dshHomePath('storages/session-search/')` and reconciles it in the background (`syncMode: background`, 5000 ms interval, two concurrent reads), so a restart reuses it and searches never reconcile the corpus on demand.

Apply an overlay with `dsh --patch <path>` or through the profile's patch layer. A derived index belongs to one process at a time: the provider claims the sidecar database `<path>.owner.sqlite` before it opens the index, so a second process configured with the same path fails its first search with `SESSION_QUERY_INDEX_FAILED` instead of writing concurrently. Configure a distinct path namespace for each profile, persistence source, and isolated provider, and rename that namespace whenever a composition overrides the JSONL session root: ownership refuses concurrent writers but cannot prove that a path belongs to the mounted root, so two deployments over different roots that share one path would serve each other's sessions. The ownership sidecar is never deleted, and the operating system releases its lock when the owning process exits.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the Host group `optional-session-search`, which registers the tools in the global tool layer. Later profile patches can override its rows by id. The [profile composer](../../boot/app-boot/README.md) owns patch ordering and errors.

The group owns an isolated `sessionQuery` provider with a lazy `:memory:` index, released when the bundle is switched off. The host's metadata service keeps `openAt: never`. A configured file path also claims the sidecar database `<path>.owner.sqlite`, which carries the single-process rule for that path.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Capability implementation](../tool-session-query/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [capability implementation](../tool-session-query/README.md), which owns model context and results.

#### KV Cache effect

The layer adds no request content directly; the capability implementation owns cache effects from tools, prompts, and results. Toggling the bundle changes the tool list of live Sessions, which invalidates their cached request prefix once.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The shipped layer keeps one in-memory index after the first search, so the index is rebuilt after restarting the application or switching the bundle off and on. A durable path is opt-in, and one process owns each derived-index path. Search remains restricted to authorized workspaces.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>
