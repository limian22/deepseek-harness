---
kind: upgrade-guide
description: Glob calls without a sort argument return paths in path order.
---

# Glob result order

English | [中文](guide.zh.md)

## Change

`glob` defaults to path order. Calls that previously relied on the oldest matching files appearing first must request modification-time order explicitly. An over-limit preview can still sample across top-level entries according to the plugin configuration.

## Migration

1. Add `"sort": "modified"` to calls that require the old order.
2. Check that the full result lists files from oldest to newest with a fixture whose paths and modification times sort differently.
