# Architecture & Production Hardening Guide

This document details the invariants, processing pipeline, failure-mode handling, and production-scale evolution of the Idempotent Webhook Processor.

---

## 1. Processing Pipeline

Every incoming event traverses a strict, deterministic decision pipeline inside `WebhookLedgerProcessor.processEvent()` (`src/ledger.mjs`):

```text
rawEvent
   │
   ▼
[1. Defensive Boundary & Envelope Validation]
   ├── invalid (non-object / missing event_id, event_type, or charge_id)
   │      └──► log WARN(malformed_event_skipped)
   │           quarantine in dead_letter_events (category: "malformed")
   │           malformed_skipped += 1   [seenEvents untouched]
   │
   ▼
[2. Deduplication Lookup: seenEvents.has(event_id)]
   ├── already seen
   │      ├── payload differs from original? ─► log WARN(duplicate_payload_conflict)
   │      └── payload matches original?      ─► log WARN(duplicate_event_skipped)
   │           duplicates_skipped += 1   [ledger untouched]
   │
   ▼
[3. Event Type Allowlist: SUPPORTED_EVENT_TYPES.has(event_type)]
   ├── unrecognized (e.g. "charge.disputed")
   │      └──► log WARN(unknown_event_type_skipped)
   │           quarantine in dead_letter_events (category: "unknown_type")
   │           unknown_type_skipped += 1   [seenEvents untouched for future replay]
   │
   ▼
[4. Type-Specific Payload Validation (amount_cents, received_at)]
   ├── invalid (missing, negative, float, NaN, non-integer, invalid timestamp)
   │      └──► log WARN(malformed_event_skipped)
   │           quarantine in dead_letter_events (category: "malformed")
   │           malformed_skipped += 1   [seenEvents & chargeAccounts untouched]
   │
   ▼
[5. Atomic State Transition]
   ├── charge.failed    ─► record event_id in seenEvents; no ledger mutation
   ├── charge.succeeded ─► safe-int check; account.net += amount_cents; record event_id
   └── charge.refunded  ─► safe-int check; account.net -= amount_cents; record event_id
                           if net < 0: log INFO(provisional_negative_balance)
```

### Why Pipeline Order Matters

1. **Deduplication precedes type/payload work**: Repeated deliveries of already-applied `event_id`s short-circuit in $O(1)$ without re-executing ledger logic. Because dedup keys strictly on `event_id` (not a hash of the full JSON/table row), retries with different `received_at` timestamps are deduplicated while distinct `event_id`s with identical amounts (e.g., two legitimate `$10.00` partial refunds on the same charge) are both applied.
2. **Event-type check precedes payload validation**: Future event types (such as `charge.disputed` or `customer.updated`) may legitimately carry schemas that omit `amount_cents`. Checking the supported-type allowlist before validating charge-specific fields ensures forward-compatible classification as `unknown_type` rather than `malformed`.
3. **Quarantined events are excluded from `seenEvents`**:
   - If a producer repairs and replays a previously malformed payload under the same `event_id`, it will process cleanly rather than being falsely dropped as a duplicate.
   - If a newer deployment adds support for `charge.disputed` and replays the dead-letter queue, those previously skipped events can be ingested cleanly without colliding with dedup records.

---

## 2. Mathematical Correctness: Order Independence & Idempotency

Let $E$ be any delivery stream of webhook events, and let $V(E)$ be the set of distinct valid recognized events deduplicated by `event_id`:

$$V(E) = \{ e \in E \mid \text{valid}(e) \land \text{supported}(e.\text{type}) \} / \sim_{\text{event\_id}}$$

Define the integer-cent delta function $\Delta$:

$$\Delta(e) = \begin{cases} +e.\text{amount\_cents} & \text{if } e.\text{type} = \text{charge.succeeded} \\ -e.\text{amount\_cents} & \text{if } e.\text{type} = \text{charge.refunded} \\ 0 & \text{if } e.\text{type} = \text{charge.failed} \end{cases}$$

For any charge $c$, the net balance is the sum over all unique valid events belonging to $c$:

$$\text{Balance}(c) = \sum_{e \in V(E),\; e.\text{charge\_id} = c} \Delta(e)$$

Because addition on the integers $(\mathbb{Z}, +)$ is both **commutative** ($a + b = b + a$) and **associative** ($(a + b) + c = a + (b + c)$), and because provisional negative balances are **never clamped or rejected** when a refund arrives prior to its capture:

- **Order Invariance**: Every permutation $\pi(E)$ produces the exact same final ledger.
- **Replay Idempotency**: Applying any stream $E$ repeatedly ($E$, $E \mathbin{\Vert} E$, $E \mathbin{\Vert} \pi(E)$) yields identical final balances.
- **Exact Monetary Precision**: All calculations stay strictly in checked safe integers (`Number.isSafeInteger`), eliminating floating-point rounding drift.
- **Conservation Accounting**: At every point in execution,
  $$\text{processed} + \text{duplicates\_skipped} + \text{malformed\_skipped} + \text{unknown\_type\_skipped} = \text{total\_events\_read}.$$

---

## 3. Failure-Mode & Edge-Case Matrix

| Failure Mode | Example | Classification | Ledger Impact | Added to `seenEvents`? | Telemetry / Audit |
|---|---|---|---|---|---|
| Exact retry (same or later `received_at`) | `evt-005` rows 5 & 6 | `duplicate` | None | Already present | `WARN duplicate_event_skipped` |
| Retry with mutated payload | Same `event_id`, altered `amount_cents` | `duplicate` (`conflict: true`) | None (original wins) | Already present | `WARN duplicate_payload_conflict` |
| Out-of-order refund before capture | `evt-003` before `evt-004` (`charge-B`) | `processed` | `-2000`, then `+3000` = `1000` | Yes | `INFO provisional_negative_balance` |
| Orphaned refund (capture never arrives) | Single `charge.refunded` | `processed` | `-amount_cents` | Yes | Flagged in `unresolved_negative_balances` |
| Failed charge | `evt-006` (`charge-D`) | `processed` | None (omitted from financial ledger) | Yes (subsequent retries deduped) | `failed_events_recorded += 1` |
| Missing/invalid `amount_cents` | `evt-007` (`charge-E`) | `malformed` | None (`charge-E` remains healthy for `evt-009`) | No (replayable if fixed) | `WARN malformed_event_skipped` + DLQ |
| Unrecognized future `event_type` | `evt-008` (`charge.disputed`) | `unknown_type` | None | No (replayable post-upgrade) | `WARN unknown_event_type_skipped` + DLQ |
| Non-object / throwing getter | `null`, `[]`, hostile object | `malformed` | None | No | `WARN`/`ERROR malformed_event_skipped` + DLQ |

---

## 4. Production Hardening & Distributed Systems Evolution

This assessment intentionally uses zero external dependencies and an in-memory store. In a production multi-worker payment service, the exact same invariants map directly onto durable storage and distributed concurrency primitives:

### 4.1 Transactional Inbox + Ledger Schema (PostgreSQL)

Replace the in-memory `Map`s with an ACID transaction that atomically claims `event_id` and updates the charge balance:

```sql
CREATE TABLE processed_webhook_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  charge_id    TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  received_at  TIMESTAMPTZ,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE charge_ledger (
  charge_id        TEXT PRIMARY KEY,
  succeeded_cents  BIGINT NOT NULL DEFAULT 0,
  refunded_cents   BIGINT NOT NULL DEFAULT 0,
  net_amount_cents BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Inside a single database transaction per webhook event:

1. `INSERT INTO processed_webhook_events (...) VALUES (...) ON CONFLICT (event_id) DO NOTHING RETURNING event_id;`
2. If zero rows are returned, the event is a duplicate (even under concurrent workers!) — commit/return `200 OK` immediately without touching `charge_ledger`.
3. If inserted and `event_type IN ('charge.succeeded', 'charge.refunded')`, execute an atomic upsert on `charge_ledger`:
   ```sql
   INSERT INTO charge_ledger (charge_id, succeeded_cents, refunded_cents, net_amount_cents)
   VALUES ($1, $2, $3, $4)
   ON CONFLICT (charge_id) DO UPDATE SET
     succeeded_cents  = charge_ledger.succeeded_cents  + EXCLUDED.succeeded_cents,
     refunded_cents   = charge_ledger.refunded_cents   + EXCLUDED.refunded_cents,
     net_amount_cents = charge_ledger.net_amount_cents + EXCLUDED.net_amount_cents,
     updated_at       = NOW();
   ```

Because PostgreSQL acquires a row-level lock on `charge_ledger(charge_id)` during `ON CONFLICT DO UPDATE` and enforces `PRIMARY KEY (event_id)` atomically in the same transaction, **concurrent duplicate deliveries and concurrent out-of-order deliveries for the same `charge_id` are both race-free without distributed locks**.

### 4.2 Webhook HTTP & Security Perimeter

- **Signature Verification**: Verify HMAC-SHA256 webhook signatures against the raw request body before parsing JSON, using constant-time comparison (`crypto.timingSafeEqual`).
- **Fast Ack + Async Queue**: Acknowledge valid, signature-verified webhooks promptly (`200 OK`) after durable enqueueing (SQS / Kafka / PubSub) so provider timeouts do not trigger retry storms.
- **Dead-Letter Queue (DLQ)**: Route `malformed` and `unknown_type` events to separate DLQ topics/tables with schema version metadata so operators can replay `unknown_type` events cleanly once handlers ship.
- **Reconciliation Alerting**: Run a scheduled sweep over `charge_ledger WHERE net_amount_cents < 0 AND updated_at < NOW() - INTERVAL '15 minutes'` to alert on genuinely orphaned refunds (distinct from normal sub-minute out-of-order delivery).
