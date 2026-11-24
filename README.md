# Idempotent Webhook Processor — Backend Engineer Assessment

A zero-dependency, standard-library-only Node.js implementation of an idempotent, order-independent payments webhook processor that parses and processes the fixture stream in [`webhook_events.md`](./webhook_events.md).

---

## Quick Start

Requires **Node.js 18+** (uses standard library modules only — **no `npm install` required**).

```bash
# Run the processor against webhook_events.md (formatted summary on stdout, structured logs on stderr)
node processor.mjs
# or
npm start

# Machine-readable JSON summary output
node processor.mjs --json

# Run the complete unit, edge-case, and permutation-invariance test suite
node --test tests/*.test.mjs
# or
npm test
```

---

## Observed Output on `webhook_events.md`

Running `node processor.mjs` produces structured JSON operational logs on `stderr` and the summary report on `stdout`:

```text
=== Webhook Processing Summary ===
Total events read:          10
Processed events:           7 (failed tracked for dedup: 1)
Duplicates skipped:         1
Malformed skipped:          1
Unknown-type skipped:       1

Final Ledger (charge_id -> net_amount_cents):
  charge-A     :      0 cents ($0.00)
  charge-B     :   1000 cents ($10.00)
  charge-C     :   7500 cents ($75.00)
  charge-E     :   6000 cents ($60.00)
  TOTAL        :  14500 cents ($145.00)
```

### Row-by-Row Fixture Reconciliation

| # | `event_id` | `event_type` | `charge_id` | `amount_cents` | Handling & Outcome |
|---|------------|--------------|-------------|----------------|--------------------|
| 1 | `evt-001` | `charge.succeeded` | `charge-A` | `5000` | Applied (`+5000`); `charge-A = 5000` |
| 2 | `evt-002` | `charge.refunded` | `charge-A` | `5000` | Applied (`-5000`); `charge-A = 0` |
| 3 | `evt-003` | `charge.refunded` | `charge-B` | `2000` | Out-of-order refund applied (`-2000`, logged as `provisional_negative_balance`); `charge-B = -2000` |
| 4 | `evt-004` | `charge.succeeded` | `charge-B` | `3000` | Capture reconciled (`+3000`); `charge-B = 1000` |
| 5 | `evt-005` | `charge.succeeded` | `charge-C` | `7500` | Applied (`+7500`); `charge-C = 7500` |
| 6 | `evt-005` | `charge.succeeded` | `charge-C` | `7500` | **Duplicate `event_id`** (different `received_at`) — logged & skipped |
| 7 | `evt-006` | `charge.failed` | `charge-D` | `1200` | Tracked in `seenEvents` for dedup; zero ledger mutation (`charge-D` omitted from revenue ledger) |
| 8 | `evt-007` | `charge.succeeded` | `charge-E` | *(empty)* | **Malformed** (missing `amount_cents`) — logged, quarantined, skipped |
| 9 | `evt-008` | `charge.disputed` | `charge-F` | `4400` | **Unknown `event_type`** — logged, quarantined, skipped |
| 10 | `evt-009` | `charge.succeeded` | `charge-E` | `6000` | Valid event for `charge-E` unaffected by row 8 — applied (`+6000`); `charge-E = 6000` |

---

## Core Design Decisions

1. **Strict `event_id` Deduplication (Never Payload Hashing)**
   - Deduplication keys solely on `event_id` via an $O(1)$ `Map` (`#seenEvents`).
   - Retries with updated delivery timestamps (`evt-005` at `09:15:03Z` vs `09:15:00Z`) are skipped, while distinct `event_id`s carrying identical `(event_type, charge_id, amount_cents)` (e.g., two separate partial refunds of the same amount) are both applied.
   - If a duplicate `event_id` arrives with altered immutable fields, the processor refuses to mutate the ledger and emits a high-signal `duplicate_payload_conflict` warning.

2. **Commutative Integer-Cent Accounting for Out-of-Order Delivery**
   - `received_at` reflects delivery time, not business event time, so sorting by `received_at` does not solve out-of-order delivery.
   - Instead, `charge.succeeded` (`+amount_cents`) and `charge.refunded` (`-amount_cents`) are accumulated as commutative integer-cent deltas without rejecting or clamping provisional negative balances. When `evt-003` (`-2000`) arrives before `evt-004` (`+3000`), `charge-B` holds a provisional `-2000` balance (logged as `INFO provisional_negative_balance`) and reconciles cleanly to `1000` when capture arrives.
   - Any charge still negative at the end of a stream is surfaced in `unresolved_negative_balances` for reconciliation alerting.

3. **Forward-Compatible Validation & Fault Isolation**
   - The pipeline validates in order: **envelope** (`event_id`, `event_type`, `charge_id`) → **dedup** → **supported `event_type` allowlist** → **type-specific payload** (`amount_cents`, `received_at`).
   - Checking the `event_type` allowlist before charge-amount validation ensures future event types with unfamiliar schemas are classified as `unknown_type` rather than `malformed`.
   - Empty `amount_cents` cells in `webhook_events.md` are explicitly parsed as `null` (avoiding JavaScript's `Number("") === 0` pitfall), and malformed or unknown events are quarantined in `dead_letter_events` without poisoning `seenEvents` or corrupting sibling events for the same `charge_id`.

4. **`charge.failed` Representation**
   - `charge.failed` (`evt-006`, `charge-D`) is omitted from the financial `ledger` map so that settled-and-refunded charges (`charge-A: 0`) remain clearly distinct from charges where funds never settled, while `evt-006` is still recorded in `seenEvents` so duplicate deliveries are properly deduplicated.

For full architectural diagrams, mathematical invariants, failure-mode matrix, and production PostgreSQL / DLQ hardening patterns, see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Project Structure

```text
backend-engineer/
├── processor.mjs                  # Runnable CLI entrypoint & public re-exports
├── webhook_events.md              # Original fixture table (single source of truth)
├── package.json                   # Zero-dependency ESM package config & scripts
├── src/
│   ├── parser.mjs                 # Markdown pipe-table fixture parser
│   ├── validator.mjs              # Envelope, event-type allowlist, and strict safe-int validators
│   ├── ledger.mjs                 # WebhookLedgerProcessor (idempotent, order-independent state machine)
│   ├── logger.mjs                 # Structured JSON-line logger (stderr)
│   └── process_events.mjs         # Public process_events() function & summary formatter
├── tests/
│   ├── parser.test.mjs            # Fixture table & malformed cell parsing tests
│   ├── processor.test.mjs         # Fixture verification, dedup, poison-pill, unknown-type, & edge-case tests
│   └── ordering_invariance.test.mjs # Exhaustive 24-permutation, 200-seed shuffle+dup, & replay tests
└── docs/
    └── ARCHITECTURE.md            # Deep-dive architecture, invariants, and production scaling design
```

---

## Verification & Test Coverage

All 16 tests run via Node's built-in test runner (`node --test tests/*.test.mjs`) with zero dependencies:

- **Parser Suite (`tests/parser.test.mjs`)**: Verifies all 10 fixture rows parse in delivery order, blank `amount_cents` stays `null` (never coerced to `0`), and non-integer strings are preserved for validation.
- **Processor Suite (`tests/processor.test.mjs`)**: Verifies exact fixture output and structured logs, `event_id`-only dedup (including distinct events with identical amounts), `charge.failed` dedup tracking, conflicting duplicate warnings, poison-pill isolation across 11 malformed variants, replayability after malformed payloads, forward-compatible unknown event types, and orphaned-refund detection.
- **Ordering & Idempotency Invariance Suite (`tests/ordering_invariance.test.mjs`)**: Verifies identical balances across all $4! = 24$ permutations of a multi-event charge lifecycle, across 200 seeded random shuffles of the fixture with injected duplicates, and under repeated full-stream replays ($S + S + S \equiv S$).
