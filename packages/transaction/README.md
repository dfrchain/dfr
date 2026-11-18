# @dfr/transaction (M1 planned module)

This directory only becomes a workspace package at M1-A. It will own the
state machine, Store ports, idempotency coordination, nonce coordination,
and confirmation tracking.

It depends only on `@dfr/types` and `@dfr/errors` — not on the Gateway, any
concrete Adapter, the Provider Manager, or database drivers. Concrete tasks
start at `DFR-M1-A04`; do not scaffold it early without claiming a task.
