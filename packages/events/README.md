# @dfr/events (M2 planned module)

In M1, post-submission notifications are carried by the Transaction
Engine's internal interfaces; M2 will re-evaluate whether to extract this
package and offer SSE externally; cross-restart replay is only committed
in M6.

This module must not introduce Kafka/NATS early, and must not claim that
an in-process cursor survives restarts. The authoritative source for event
types is `@dfr/types`.
