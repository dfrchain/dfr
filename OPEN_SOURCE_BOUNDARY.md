# Open-source boundary and release policy

This repository is an **already public Apache-2.0 distribution**. The source presently published here includes the SDK, types, adapters, provider selection/scoring, transaction engine, gateway, and tests. Do not describe this snapshot as "SDK only."

## Existing grants and ownership
The repository-level Apache-2.0 license grants rights to recipients of the published work; later deleting a file or making a repository private does not revoke licenses already received. Company-owned confidential services, future proprietary algorithms, credentials, customer data, and unreleased work **not distributed in this repository** are not licensed merely by this document. A repository policy cannot override the actual license on published files. Check file headers and third-party notices before changing any license.

## Public / private boundary
- **Public in this distribution:** `sdk/typescript/`, `packages/types/`, `packages/errors/`, chain adapters, published `packages/core/`, `packages/transaction/`, `packages/provider/`, `apps/gateway/`, existing tests, API specification, documentation, and examples. These are already published; do not retroactively label them secret.
- **Review before future public releases:** changes to provider routing/selection/scoring, commercial pricing, proprietary optimization and control-plane capabilities; deploy orchestration; internal benchmarks and customer integration details. Keep genuinely new commercial modules in separately maintained private repositories unless a release is explicitly approved.
- **Never include:** live credentials, private keys, seed phrases, signing material, customer data, confidential endpoints, production environment files, billing records or service-account access. Example configs may contain clearly fake placeholders only.
- **Security-relevant protocol implementation:** prefer auditable and independently reproducible code where trust or customer funds depend on it. Secrecy is not a substitute for independent validation.

## Release gate (mandatory for new public syncs)
1. Compare proposed public changes against a reviewed source commit and enumerate **all** added/changed files, including generated files and workflows.
2. Check file-by-file ownership, upstream dependency licenses and SPDX headers; do not import incompatible or unauthorized third-party code.
3. Scan tracked **and Git-history** content for credentials and private material using dedicated history-aware tooling; the repository's `pnpm check:secrets` scans working-tree files and **is not** a historical scan.
4. Check configs, comments, fixtures, test vectors, docs, CI logs and build artifacts for operational details and sensitive data. Sanitize before publication.
5. Run the documented build/tests and record exact commands, exit codes, commit SHA and limitations. Do not claim a green gate unless executed.
6. Have a maintainer approve the precise release diff. Do not automatically mirror entire private trees or publish entire worktrees.
7. If a live secret is found: revoke/rotate it immediately; coordinate disclosure and history remediation. Deleting the current file alone does not remove prior public copies.

## Funding
Grant-funded outputs and their license must be agreed in writing and tracked separately. An open-source grant may cover a defined SDK, testing tool or documentation scope without granting access to independently developed private services. Do not promise an exception to a funder's mandatory open-source terms.

## Reporting
Report suspected leaks privately to hello@dfrchain.com. Do **not** post credentials, private keys, exploitable production configuration, or customer data in public issues.
