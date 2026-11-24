# Backend Engineer Assessment — Idempotent Webhook Processor

## What this assessment does

This is a **language-agnostic** problem — implement it in whatever language
you like, standard library only, no install required. You're given a fixed,
fabricated stream of incoming webhook events (see `webhook_events.md`) from
a fictional payments provider, and your job is to write a processor that
handles them correctly despite the ways real webhook delivery actually
misbehaves.

## Background

Webhook events arrive with: `event_id`, `event_type` (`"charge.succeeded"`,
`"charge.refunded"`, or `"charge.failed"`), `charge_id`, `amount_cents`, and
`received_at` (delivery order — **not necessarily** the true chronological
order of what happened, since webhook providers don't guarantee ordering).

Your processor maintains a running ledger of charge balances (a `dict`/map
from `charge_id` to net amount) and must handle:

1. **Exact duplicate delivery**: the same `event_id` can be delivered more
   than once (this is normal, expected webhook behavior — providers
   generally guarantee "at least once" delivery, not "exactly once").
   Processing the same `event_id` twice must **not** double-count it.
2. **Out-of-order delivery**: a `"charge.refunded"` event can arrive
   *before* the `"charge.succeeded"` event it refers to (same `charge_id`).
   Your ledger must end up correct regardless of arrival order — i.e. once
   all events for a given `charge_id` have been processed (regardless of
   what order they arrived in), the net balance must be right.
3. **A poison-pill event**: one event in the stream is malformed (missing
   `amount_cents`). Your processor must not crash on it or block
   processing of subsequent events — skip it, log it, and continue.
4. **An event for an unknown `event_type`** (a value your processor
   doesn't recognize, simulating a future event type your code predates):
   should be logged and skipped, not crash, and not silently mutate the
   ledger.

## Requirements

Implement `process_events()` that:

1. Reads all events from `webhook_events.md`'s fixture data (hardcode it
   in your solution, or parse the table — your choice; there's no need to
   over-engineer parsing for a fixed list).
2. Applies each event to the ledger **exactly once**, regardless of how
   many times that `event_id` appears in the input.
3. Produces a correct final `charge_id -> net_amount_cents` ledger,
   regardless of the arrival order of events for the same `charge_id`
   (`charge.succeeded` adds the amount, `charge.refunded` subtracts it,
   `charge.failed` contributes nothing to the ledger but should still be
   tracked as "seen" for dedup purposes).
4. Skips and logs the malformed event and the unknown-event-type event,
   without crashing or corrupting the ledger.
5. Prints a summary: total events read, duplicates skipped, malformed
   skipped, unknown-type skipped, final ledger.

## What we're actually evaluating

- Whether your dedup is by `event_id`, not by "have I seen this exact
  payload before" or some other proxy that would break on legitimate
  distinct events.
- Whether your ledger ends up correct regardless of arrival order — i.e.
  you're not relying on `charge.succeeded` always being processed before
  `charge.refunded` for the same charge.
- Whether malformed/unknown events are handled gracefully without
  corrupting the ledger or halting processing.

## How to submit

1. Commit your changes to your own repo using **the same email associated
   with your candidate account**.
2. Once ready, either reply to our team confirming you're ready to submit,
   **or** zip the `backend-engineer/` folder and upload it directly on our
   platform.

**Please note:** please don't generate the full solution entirely with AI
tools — correctly handling out-of-order events and exactly-once dedup
together (not just one or the other) is the actual point of this exercise.
Using AI for a specific syntax lookup is fine.
