# Docker delivery scope

M1-A provides the local PostgreSQL test dependency; M1-E02 provides the
Gateway runtime image and the M1 all-in-one sample.

Requirements: pinned image major versions, health checks, resource limits,
persistent volumes, a non-root application container, and
migration/runtime identity separation. Never write real credentials into
an image or compose file.

## Files

| File | Purpose |
|---|---|
| `docker-compose.test.yml` | PostgreSQL for **testing** (pinned `container_name`, exposes 55432). Used by `pnpm test:db` |
| `gateway.Dockerfile` | Gateway runtime image: non-root, read-only root filesystem, `HEALTHCHECK` → `/healthz` |
| `docker-compose.m1.yml` | M1 all-in-one **sample** (PostgreSQL + migration task + Gateway), **not a production deployment file** |
| `initdb/01-roles.sh` | The single source for role and password initialization (shared by both compose files) |
| `.env.example` | Variable shapes (including the variables the sample compose additionally needs); `.env` is not committed |

## Verified properties (2026-10-05, M1-E02)

```text
Image run user       uid=1000(node)          — non-root
Root filesystem      read_only: true
Privilege escalation no-new-privileges:true
.env inside container absent (.dockerignore excludes it)
/healthz            200
/readyz             200 (stores=ok, chain details) / 503 (when a dependency is unreachable)
SIGTERM             graceful exit, exit code 0
```

Note: `docker-compose.m1.yml` maps the host port to **18787** by default
(fixed 8787 inside the container), to avoid clashing with services already
on the host; override with `DFR_GATEWAY_HOST_PORT`.

### Backup / restore client (E5, 2026-10-08)

The runtime image has a built-in **PostgreSQL 17 client**
(`postgresql17-client`), so production backups can run `pg_dump` /
`pg_restore` / `psql` from the same image instead of relying on the host
happening to have a client of the same major version installed.

Verified (`dfr-gateway:e5-backup`):

```text
Run user         uid=1000(node)
pg_dump          PostgreSQL 17.11
pg_restore       PostgreSQL 17.11
psql             PostgreSQL 17.11
Image size       238,564,072 bytes (about 238 MB)
```

Local restore-drill entry: `pnpm test:db-backup-restore` (uses isolated
databases only, deleted when verification completes). Supply-chain scanning
still uses `pnpm supply-chain`. A full re-run on 2026-10-09 against the same
image (`dfr-gateway:e5-backup`) found: **0 HIGH/CRITICAL**; the Node
dependency license check passed with no copyleft; the CycloneDX SBOM was
written to `infrastructure/docker/sbom/dfr-gateway.cdx.json`.

## Image supply chain (verified 2026-10-05)

Gate command: `pnpm supply-chain` (= `scripts/image-supply-chain.sh`). It
builds the image, generates a CycloneDX SBOM, and fails with a non-zero exit
code on HIGH/CRITICAL vulnerabilities. Scanning needs the trivy
vulnerability database and a Docker daemon, so it is **not** part of the
offline `pnpm verify`.

**How it runs in CI** (`.github/workflows/security-scan.yml`):

| Dimension | Value | Reason |
|---|---|---|
| Trigger | **Weekly Monday schedule** + manual `workflow_dispatch` | **Deliberately not on every push**: the vulnerability database updates daily, and attaching it would turn unrelated commits red on upstream CVE news — that is noise, not signal, and it trains the team to ignore red lights |
| trivy install | Official release + **checksum verification**, pinned version | No third-party action, and no "download and run" script is executed |
| Entry | `pnpm supply-chain` | The **same script** as local, so CI and local do not use two different verdicts |
| Artifacts | SBOM kept as an artifact for 30 days | Traceable at release-audit time: "what was in the image then" |

### Three-step slimming (each step driven by scan results, not by feel)

| Step | Change | Image size | HIGH/CRITICAL |
|---|---|---|---|
| 0 | Initial (`--prod=false`) | 316MB | Not scanned |
| 1 | Production dependencies only (`--prod`) | 253MB | 44 |
| 2 | Multi-stage build, pnpm/corepack removed | 232MB | 11 |
| 3 | npm/npx/corepack removed from the base image | **232MB** | **0** |

Key finding: **all 44 HIGH/CRITICAL findings came from build/packaging
tools** (pnpm, npm's bundled `tar` / `minimatch` / `pacote` / `sigstore` /
`glob` / `brace-expansion` / `ip-address` / `http-cache-semantics` /
`picomatch`), with **zero overlap** with the runtime dependencies
(`viem` / `pg`). The runtime entry is `node --experimental-strip-types`,
which never invokes any package manager.

So the correct remediation is to **remove the tools**, not to add
vulnerability exemptions. After remediation, all severity scans report 0.

### License check

The gate also scans licenses (`--scanners license`), with a policy of
**blocking only Node dependencies**:

| Scope | Handling | Reason |
|---|---|---|
| Node dependencies (`node-pkg`) | Block GPL / AGPL / SSPL / BUSL / Commons-Clause / Elastic / CC-BY-NC | This project is a private closed-source product; copyleft in JS dependencies would create a real distribution obligation |
| Alpine OS packages | Report only, do not block | GPL/LGPL shipped with the base image (musl/busybox) is normal for all Linux images, not a distribution decision of this project |
| This project's own packages | Allow `UNLICENSED` | Private packages, as expected |

Current verification: all Node dependencies are permissively licensed
(MIT / ISC / Apache-2.0 / BSD / MPL-2.0 / Zlib); GPL/LGPL hits all come from
Alpine OS packages. The negative control has been verified: injecting a
GPL-3.0 / AGPL-3.0 Node dependency makes the gate fail with a non-zero code.

### Known retained items

- `/opt/yarn-v1.22.22/` still exists in the base image. It has **no
  vulnerability findings**, so it was not removed (deleting it without a
  security basis would be an out-of-scope change). If it gains a finding in
  the future, handle it the same way: remove it.
- Cost of removing npm/npx/corepack: nothing can be temporarily installed
  inside the container any more. A production gateway image should not rely
  on installing things inside the container anyway; use the build stage
  `deps` or reproduce locally for interactive debugging.

### SBOM

`infrastructure/docker/sbom/dfr-gateway.cdx.json` (CycloneDX 1.7, about 367
components). It is generated output, excluded by `.gitignore`; reproducible
at any time with `pnpm supply-chain`.
