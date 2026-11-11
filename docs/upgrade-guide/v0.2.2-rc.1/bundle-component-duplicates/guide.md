---
kind: upgrade-guide
description: "Bundle activation through Plugin Manager refuses component IDs already supplied by the current composition."
---

# Duplicate component IDs in plugin bundles

English | [中文](guide.zh.md)

## Change

Plugin Manager previously allowed a selected parent bundle and a standalone bundle to insert the same component IDs. Enabling another bundle through the service, Web page or management tool now returns `duplicate-entry` before saving a conflicting selection, even when the existing component is disabled. The same module under different IDs and ordinary configuration overrides remain supported. Existing selections are not silently removed.

`listBundles()` can return `providedBy` for an unselected bundle whose complete component set is already supplied by one selected bundle. The Web page identifies the provider and exposes the existing component controls instead of offering a second package activation. `enabled` still means that the independent bundle is selected; it does not mean every component it names is inactive when false.

## Migration

1. Inspect the affected profile's `package.json` under `dsh.profile.bundles`. If both a parent bundle and an independent bundle provide the same component IDs, retain the parent and deselect the redundant independent bundle. Do not uninstall its dependency if the parent still needs it.
2. Keep component activation in the profile's `cordis.patch.yml`, using one uniquely addressable entry per ID. Do not add another bundle layer to activate a component the parent already provides.
3. In the Web Plugins page, open a package marked **Provided by another package** and use its component switches. Verify the runtime entry is enabled and active and that the independent package remains unselected.
4. Clients that exhaustively handle `ManagementError['code']` must handle `duplicate-entry`. Clients of `listBundles()` may use the optional `providedBy` field to distinguish provision from package selection.
