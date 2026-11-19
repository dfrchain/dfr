# Private-to-public release comparison — DFR

Snapshot date: 2026-11-19. **This document records a read-only Git-tree inventory, not a credential audit or an approval to mirror private code.**

## Compared revisions

- Private source: local checkout of `sudorm-rf0/dfr` at `28d4286` (branch `opt/access-layer-20261118`).
- Public destination: `dfrchain/dfr` at `beea7e8` (`main`), before this report.
- Private tree: **602 files**; public tree: **345 files**.
- Shared paths: **339**; of these, **39 identical Git blobs** and **300 differing blobs**.
- Private-only paths: **263**; public-only paths: **6**.

Git blob differences may reflect translation, redaction, or older/newer implementation; they are not by themselves leaks. The comparison is between the specified commits, not all branches or the full Git history.

## Boundaries for future releases

**Usually suitable for independent public deliverables after review:** the API schema, TypeScript client SDK, shared public types/errors, generic integration examples, sanitized test fixtures and documentation. A dedicated public release may also include already-public adapters and gateway code.

**Requires explicit code-owner review and business decision before new publication:** changes to `packages/provider/` scoring/routing, transaction orchestration, gateway internals, tenancy/control plane, costs, billing, partner integrations, proprietary performance optimizations and private infrastructure. Some versions of these components are already open source; this policy does not retrospectively make them private.

**Never sync:** secrets/keys, live environment files, protected configuration, customer data, internal operator endpoints, private deploy infrastructure, or unreleased proprietary research.

## Release procedure

1. Pin exact private source and public destination commit SHAs; generate **file-by-file** add/modify/delete inventory.
2. Require explicit approval for each file and all transitive imports. Do not `rsync` or copy the entire private worktree.
3. Audit Git history and present working files for secrets, credentials, proprietary data and licensing obligations. The existing public path-check workflow is not a substitute for this.
4. Execute target public build and tests; record the actual exits and evidence. Keep a release manifest and a reviewer.
5. Do not grant new third-party license rights over unrelated private code in a grant proposal.

This policy does not override Apache-2.0 licenses already granted for previously distributed code. A file may not be included in a new release solely because its filename matches a publicly available path.

## Follow-up

The comparison showed **300 different-blob shared paths** that need selective semantic review if future private changes are promoted to the public version. No bulk sync has been approved or performed. No full history-wide scan has been certified.
