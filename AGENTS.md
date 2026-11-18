# DFR Model Development Protocol

This file applies to every AI model and human developer working in this
repository. It is an execution rulebook, not a replacement for the
architecture spec.

## 1. Current facts

- Current branch baseline: M0 read-only chain path is complete.
- Current implementation: TypeScript SDK → Gateway → Core → EVM Adapter → Provider Manager.
- Current next goal: M1 EVM safe write path, not a multi-tenant platform.
- Authoritative task book: [docs/development/m1-taskbook.md](./docs/development/m1-taskbook.md).
- Authoritative architecture index: [docs/architecture/README.md](./docs/architecture/README.md).

Never use historical test counts as a substitute for verification in this
session. Run the applicable baseline commands before taking over a task.

## 2. Required reading order

Before any coding task, read in this order:

1. This file;
2. [design.md](./design.md);
3. [plan.md](./plan.md);
4. [docs/development/handoff-protocol.md](./docs/development/handoff-protocol.md);
5. The architecture specs, ADRs, and source files listed on the current task card;
6. The delivery records of the current task's direct dependency tasks.

Do not load every document at once just to "learn more"; the task card
already lists the minimum context.

## 3. Unbreakable architecture boundaries

```text
Gateway       Cross-cutting concerns; implements no chain semantics, does not access the transaction tables directly
Core          Orchestration and capability routing; no branches like chain === 'ethereum'
Transaction   State machine, idempotency, nonce, confirmation coordination; owns the Store interface
Adapter       Chain semantics and encoding/decoding; does not select Providers, does not access the database
Provider      Transport, health, scoring, circuit breaking, failover; does not understand chain business semantics
Storage       Implements the Store interface; never calls back into Core or Adapter
```

Dependency direction and runtime topology are in
[docs/architecture/development-plan.md](./docs/architecture/development-plan.md).

## 4. Safety red lines

- Never write private keys, mnemonics, API keys, tokens, cookies, or a
  complete `signedPayload` into code, config, logs, errors, test snapshots,
  or commit history.
- Broadcast is a `non-idempotent-write`; the Provider layer's automatic call
  count must be strictly 1.
- When M1 enables broadcast, a persistent Store must be configured; never
  silently fall back to the in-memory Store.
- A failed simulation must not broadcast; a signing result must be bound to
  the original unsigned transaction.
- Chain, Capability, Provider, or credential configuration errors must
  fail-closed.
- Amounts, nonces, block heights, and gas always use decimal strings — never
  JS `number` or floating point.

When a suspected secret is found, report only the file, line number, type,
and rotation advice — never output the secret itself.

## 5. Task execution protocol

1. Take only one task whose status is `READY` and whose dependencies are all
   `DONE`.
2. Run `git status --short --branch`; never overwrite existing changes that
   do not belong to this task.
3. In the test file named on the task card, first write a failing test and
   actually see it fail (RED).
4. Write the minimal implementation that makes the test pass (GREEN).
5. Refactor without expanding the task scope (REFACTOR).
6. Run the task card's local gate, then run `pnpm verify`.
7. Self-review against [Definition of Done](./docs/development/definition-of-done.md).
8. Output a delivery record: changes, evidence, items not done, risks, next
   claimable task.

One task allows only one behavioral goal. When a side issue is found, record
it in the delivery report — do not expand the implementation on the spot.

## 6. Stop conditions

If any of the following applies, stop implementing and report — never invent
a workaround yourself:

- Need to change the dependency direction of Adapter / Provider / Core /
  Transaction;
- Need to add, remove, or change transaction state semantics;
- Need to change the signing trust boundary or persist `signedPayload`;
- Need to add automatic retries to broadcast;
- Need to modify an existing Adapter Contract Test to make a new chain pass;
- Need to put BEX business objects into DFR;
- OpenAPI, TypeScript types, and the spec cannot all be satisfied at once;
- A task dependency is unfinished, baseline tests fail, or the working tree
  has overlapping changes;
- Need to introduce Redis, a message queue, microservices, Kubernetes,
  KMS/HSM, or a multi-tenant control plane.

Such changes require a new or re-reviewed ADR, and work resumes only after
an explicit decision.

## 7. Verification commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm lint:openapi
pnpm test
pnpm check:secrets
pnpm verify
```

Real-network tests must be explicitly enabled; they must not enter the
default offline gate. Never treat an occasional testnet success as evidence
that concurrency, retry, or reorg handling is correct.

## 8. Git and collaboration

- Use GitHub normally, but control API and polling frequency; no high-frequency
  requests or meaningless polling.
- Do not use `git add -A`; stage only the paths the task explicitly covers.
- Do not use destructive commands such as `git reset --hard` or
  `git checkout --` to overwrite other people's changes.
- Parallel models must use separate branches/worktrees; only one owner per
  task at a time.
- Suggested commit message: `[DFR-M1-XXX] type(scope): summary`.
- Never delete, skip, or relax safety negative-control tests just to make CI
  green.

## 9. Documentation sync

The following changes must sync documentation and contract tests within the
same task:

| Change | Must sync |
|---|---|
| API routes/fields | OpenAPI, SDK, Gateway, contract tests |
| Capability | types, Adapter map, Registry schema/config, OpenAPI, contract tests |
| Error codes | types, metadata, error spec, OpenAPI, contract tests |
| State transitions | transaction lifecycle, state machine tests, event mapping |
| Tables/Store | storage model, migration, Store contract tests, runbook |
| Environment variables | configuration reference, runbook, startup validation tests |

An outdated diagram is more dangerous than no diagram; when changing a flow
that carries an ASCII diagram, update the diagram in sync.
