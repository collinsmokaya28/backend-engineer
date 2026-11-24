import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/logger.mjs";
import { loadWebhookEventsFromFile } from "../src/parser.mjs";
import { process_events } from "../src/process_events.mjs";

function generatePermutations(items) {
  if (items.length <= 1) {
    return [items];
  }
  const results = [];
  for (let i = 0; i < items.length; i += 1) {
    const current = items[i];
    const remaining = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of generatePermutations(remaining)) {
      results.push([current, ...perm]);
    }
  }
  return results;
}

/**
 * Deterministic PRNG (Mulberry32) so randomized permutation tests are 100% reproducible.
 */
function createSeededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithRng(items, rng) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

describe("order independence and replay idempotency invariants", () => {
  it("yields the exact same balance across all 24 permutations of a multi-event charge lifecycle", () => {
    const lifecycleEvents = [
      { event_id: "e1", event_type: "charge.succeeded", charge_id: "charge-X", amount_cents: 5000 },
      { event_id: "e2", event_type: "charge.refunded", charge_id: "charge-X", amount_cents: 1200 },
      { event_id: "e3", event_type: "charge.refunded", charge_id: "charge-X", amount_cents: 800 },
      { event_id: "e4", event_type: "charge.failed", charge_id: "charge-X", amount_cents: 5000 },
    ];

    const permutations = generatePermutations(lifecycleEvents);
    assert.equal(permutations.length, 24);

    for (const perm of permutations) {
      const summary = process_events({
        events: perm,
        logger: createLogger({ silent: true }),
        print: false,
      });
      assert.deepEqual(summary.ledger, { "charge-X": 3000 });
      assert.equal(summary.processed_events, 4);
      assert.equal(summary.duplicates_skipped, 0);
      assert.deepEqual(summary.unresolved_negative_balances, []);
    }
  });

  it("converges to the exact fixture ledger across 200 random shuffles with injected duplicates", () => {
    const baseEvents = loadWebhookEventsFromFile();
    const expectedLedger = {
      "charge-A": 0,
      "charge-B": 1000,
      "charge-C": 7500,
      "charge-E": 6000,
    };

    // Valid event IDs that can be duplicated arbitrarily without changing the ledger.
    const validEvents = baseEvents.filter(
      (e) => e.event_id !== "evt-007" && e.event_id !== "evt-008"
    );

    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = createSeededRng(seed);
      const extraDuplicatesCount = Math.floor(rng() * 6);
      const stream = [...baseEvents];

      for (let d = 0; d < extraDuplicatesCount; d += 1) {
        const pick = validEvents[Math.floor(rng() * validEvents.length)];
        stream.push({
          ...pick,
          received_at: `2024-02-01T10:${String(d).padStart(2, "0")}:00Z`,
        });
      }

      const shuffled = shuffleWithRng(stream, rng);
      const summary = process_events({
        events: shuffled,
        logger: createLogger({ silent: true }),
        print: false,
      });

      assert.deepEqual(summary.ledger, expectedLedger, `ledger diverged on seed ${seed}`);
      assert.equal(summary.processed_events, 7, `processed count diverged on seed ${seed}`);
      assert.equal(summary.duplicates_skipped, 1 + extraDuplicatesCount);
      assert.equal(summary.malformed_skipped, 1);
      assert.equal(summary.unknown_type_skipped, 1);
    }
  });

  it("is strictly idempotent under full valid-stream replay (S + S + S === S)", () => {
    const baseEvents = loadWebhookEventsFromFile();
    const validOnly = baseEvents.filter(
      (e) => e.event_id !== "evt-007" && e.event_id !== "evt-008"
    );

    const once = process_events({
      events: validOnly,
      logger: createLogger({ silent: true }),
      print: false,
    });
    const thrice = process_events({
      events: [...validOnly, ...validOnly, ...validOnly],
      logger: createLogger({ silent: true }),
      print: false,
    });

    assert.deepEqual(thrice.ledger, once.ledger);
    assert.equal(thrice.processed_events, once.processed_events);
  });
});
