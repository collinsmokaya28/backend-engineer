# Webhook Event Fixture Data

Fixed, fabricated input data — hardcode this in your solution (or parse the
table below, your choice). Listed in **delivery order** (the order they
arrived), which is deliberately **not** the true chronological order of
what actually happened for some of these charges.

| # | event_id | event_type          | charge_id  | amount_cents | received_at            |
|---|----------|---------------------|------------|--------------|-------------------------|
| 1 | evt-001  | charge.succeeded     | charge-A   | 5000         | 2024-02-01T09:00:00Z   |
| 2 | evt-002  | charge.refunded      | charge-A   | 5000         | 2024-02-01T09:05:00Z   |
| 3 | evt-003  | charge.refunded      | charge-B   | 2000         | 2024-02-01T09:10:00Z   |
| 4 | evt-004  | charge.succeeded     | charge-B   | 3000         | 2024-02-01T09:12:00Z   |
| 5 | evt-005  | charge.succeeded     | charge-C   | 7500         | 2024-02-01T09:15:00Z   |
| 6 | evt-005  | charge.succeeded     | charge-C   | 7500         | 2024-02-01T09:15:03Z   |
| 7 | evt-006  | charge.failed        | charge-D   | 1200         | 2024-02-01T09:20:00Z   |
| 8 | evt-007  | charge.succeeded     | charge-E   |              | 2024-02-01T09:22:00Z   |
| 9 | evt-008  | charge.disputed      | charge-F   | 4400         | 2024-02-01T09:25:00Z   |
| 10| evt-009  | charge.succeeded     | charge-E   | 6000         | 2024-02-01T09:27:00Z   |

## Notes on specific rows

- **Rows 1–2 (`charge-A`)**: normal order — succeeded, then a full refund.
  Expected net: **0**.
- **Rows 3–4 (`charge-B`)**: the refund arrives **before** the succeeded
  event, out of delivery order. It's a partial refund. Expected net:
  **3000 − 2000 = 1000**, regardless of the order these two arrived in.
- **Rows 5–6 (`charge-C`)**: the exact same `event_id` (`evt-005`)
  delivered twice — a duplicate delivery, not two separate charges.
  Expected net: **7500** (counted once, not twice).
- **Row 7 (`charge-D`)**: a failed charge — contributes no amount. Whether
  you represent this as a ledger entry of `0` or omit `charge-D` from the
  ledger entirely is your call; either is acceptable as long as it's not
  counted as revenue.
- **Row 8 (`charge-E`, first occurrence)**: malformed — missing
  `amount_cents` entirely. This specific event should be skipped and
  logged.
- **Row 9 (`charge-F`)**: `charge.disputed` is not one of the three known
  event types your processor handles — skip and log it, don't crash, and
  don't let it affect the ledger.
- **Row 10 (`charge-E`, second occurrence)**: a **different, well-formed**
  event for the same `charge_id` as the malformed row 8 — this one should
  be processed normally. Expected net for `charge-E`: **6000** (only the
  well-formed event counts; the malformed one contributes nothing, but
  don't let skipping row 8 cause you to also skip row 10 or treat
  `charge-E` as fully invalid).
