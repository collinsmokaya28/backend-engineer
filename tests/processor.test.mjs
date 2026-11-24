import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/logger.mjs";
import { WebhookLedgerProcessor } from "../src/ledger.mjs";
import { formatSummary, process_events } from "../src/process_events.mjs";

describe("process_events() against webhook_events.md fixture", () => {
  it("produces exact expected counts, final ledger, and structured logs", () => {
    const logger = createLogger({ silent: true });
    const printed = [];

    const summary = process_events({
      logger,
      print: true,
      output: (text) => printed.push(text),
    });

    assert.equal(summary.total_events_read, 10);
    assert.equal(summary.processed_events, 7);
    assert.equal(summary.duplicates_skipped, 1);
    assert.equal(summary.malformed_skipped, 1);
    assert.equal(summary.unknown_type_skipped, 1);
    assert.equal(summary.failed_events_recorded, 1);
    assert.equal(summary.out_of_order_refunds_observed, 1);
    assert.equal(summary.seen_event_count, 7);

    // Accounting conservation invariant: every read event is accounted for.
    assert.equal(
      summary.processed_events +
        summary.duplicates_skipped +
        summary.malformed_skipped +
        summary.unknown_type_skipped,
      summary.total_events_read
    );

    assert.deepEqual(summary.ledger, {
      "charge-A": 0,
      "charge-B": 1000,
      "charge-C": 7500,
      "charge-E": 6000,
    });
    assert.equal("charge-D" in summary.ledger, false);
    assert.equal("charge-F" in summary.ledger, false);
    assert.deepEqual(summary.unresolved_negative_balances, []);

    assert.equal(summary.dead_letter_events.length, 2);
    assert.equal(summary.dead_letter_events[0].category, "malformed");
    assert.equal(summary.dead_letter_events[0].event.event_id, "evt-007");
    assert.equal(summary.dead_letter_events[1].category, "unknown_type");
    assert.equal(summary.dead_letter_events[1].event.event_id, "evt-008");

    const loggedEvents = logger.entries.map((e) => e.event);
    assert.deepEqual(loggedEvents, [
      "provisional_negative_balance",
      "duplicate_event_skipped",
      "malformed_event_skipped",
      "unknown_event_type_skipped",
    ]);

    assert.equal(printed.length, 1);
    assert.match(printed[0], /Total events read:\s+10/);
    assert.match(printed[0], /Duplicates skipped:\s+1/);
    assert.match(printed[0], /Malformed skipped:\s+1/);
    assert.match(printed[0], /Unknown-type skipped:\s+1/);
    assert.match(printed[0], /charge-B\s*:\s*1000 cents/);
  });
});

describe("deduplication semantics", () => {
  it("deduplicates strictly by event_id even when received_at differs", () => {
    const logger = createLogger({ silent: true });
    const summary = process_events({
      logger,
      print: false,
      events: [
        {
          event_id: "evt-dup",
          event_type: "charge.succeeded",
          charge_id: "chg-1",
          amount_cents: 4000,
          received_at: "2024-02-01T10:00:00Z",
        },
        {
          event_id: "evt-dup",
          event_type: "charge.succeeded",
          charge_id: "chg-1",
          amount_cents: 4000,
          received_at: "2024-02-01T10:05:19Z",
        },
      ],
    });

    assert.equal(summary.duplicates_skipped, 1);
    assert.deepEqual(summary.ledger, { "chg-1": 4000 });
  });

  it("does NOT deduplicate distinct event_ids that share identical payload fields", () => {
    const logger = createLogger({ silent: true });
    const summary = process_events({
      logger,
      print: false,
      events: [
        {
          event_id: "evt-cap",
          event_type: "charge.succeeded",
          charge_id: "chg-1",
          amount_cents: 5000,
          received_at: "2024-02-01T10:00:00Z",
        },
        {
          event_id: "evt-ref-1",
          event_type: "charge.refunded",
          charge_id: "chg-1",
          amount_cents: 1000,
          received_at: "2024-02-01T10:01:00Z",
        },
        {
          event_id: "evt-ref-2",
          event_type: "charge.refunded",
          charge_id: "chg-1",
          amount_cents: 1000,
          received_at: "2024-02-01T10:01:00Z",
        },
      ],
    });

    assert.equal(summary.duplicates_skipped, 0);
    assert.equal(summary.processed_events, 3);
    assert.deepEqual(summary.ledger, { "chg-1": 3000 });
  });

  it("tracks charge.failed events as seen for deduplication without mutating the ledger", () => {
    const logger = createLogger({ silent: true });
    const summary = process_events({
      logger,
      print: false,
      events: [
        {
          event_id: "evt-fail-1",
          event_type: "charge.failed",
          charge_id: "chg-fail",
          amount_cents: 2500,
          received_at: "2024-02-01T10:00:00Z",
        },
        {
          event_id: "evt-fail-1",
          event_type: "charge.failed",
          charge_id: "chg-fail",
          amount_cents: 2500,
          received_at: "2024-02-01T10:00:05Z",
        },
      ],
    });

    assert.equal(summary.total_events_read, 2);
    assert.equal(summary.processed_events, 1);
    assert.equal(summary.failed_events_recorded, 1);
    assert.equal(summary.duplicates_skipped, 1);
    assert.deepEqual(summary.ledger, {});
  });

  it("logs a payload conflict warning if a duplicate event_id carries altered fields and refuses to mutate ledger", () => {
    const logger = createLogger({ silent: true });
    const processor = new WebhookLedgerProcessor({ logger });

    const first = processor.processEvent({
      event_id: "evt-100",
      event_type: "charge.succeeded",
      charge_id: "chg-100",
      amount_cents: 5000,
    });
    const second = processor.processEvent({
      event_id: "evt-100",
      event_type: "charge.succeeded",
      charge_id: "chg-100",
      amount_cents: 9999,
    });

    assert.equal(first.status, "processed");
    assert.equal(second.status, "duplicate");
    assert.equal(second.conflict, true);
    assert.deepEqual(processor.getLedger(), { "chg-100": 5000 });
    assert.equal(logger.entries[0].event, "duplicate_payload_conflict");
  });
});

describe("poison-pill isolation and unknown event types", () => {
  it("handles diverse malformed inputs without crashing or corrupting valid events", () => {
    const logger = createLogger({ silent: true });
    const throwingObject = {};
    Object.defineProperty(throwingObject, "event_id", {
      get() {
        throw new Error("corrupt getter");
      },
    });

    const summary = process_events({
      logger,
      print: false,
      events: [
        null,
        "not-an-object",
        [],
        throwingObject,
        { event_id: "", event_type: "charge.succeeded", charge_id: "c1", amount_cents: 100 },
        { event_id: "e-missing-charge", event_type: "charge.succeeded", charge_id: "", amount_cents: 100 },
        { event_id: "e-null-amt", event_type: "charge.succeeded", charge_id: "c1", amount_cents: null },
        { event_id: "e-neg-amt", event_type: "charge.succeeded", charge_id: "c1", amount_cents: -50 },
        { event_id: "e-float-amt", event_type: "charge.succeeded", charge_id: "c1", amount_cents: 12.5 },
        { event_id: "e-bool-amt", event_type: "charge.succeeded", charge_id: "c1", amount_cents: true },
        { event_id: "e-bad-date", event_type: "charge.succeeded", charge_id: "c1", amount_cents: 100, received_at: "not-a-date" },
        { event_id: "e-valid", event_type: "charge.succeeded", charge_id: "c1", amount_cents: 2500, received_at: "2024-02-01T12:00:00Z" },
      ],
    });

    assert.equal(summary.total_events_read, 12);
    assert.equal(summary.malformed_skipped, 11);
    assert.equal(summary.processed_events, 1);
    assert.deepEqual(summary.ledger, { c1: 2500 });
  });

  it("does not poison event_id when a malformed event is later replayed cleanly", () => {
    const logger = createLogger({ silent: true });
    const summary = process_events({
      logger,
      print: false,
      events: [
        { event_id: "evt-fixable", event_type: "charge.succeeded", charge_id: "chg-1", amount_cents: null },
        { event_id: "evt-fixable", event_type: "charge.succeeded", charge_id: "chg-1", amount_cents: 3200 },
      ],
    });

    assert.equal(summary.malformed_skipped, 1);
    assert.equal(summary.processed_events, 1);
    assert.equal(summary.duplicates_skipped, 0);
    assert.deepEqual(summary.ledger, { "chg-1": 3200 });
  });

  it("classifies unknown event types even when they omit amount_cents", () => {
    const logger = createLogger({ silent: true });
    const summary = process_events({
      logger,
      print: false,
      events: [
        {
          event_id: "evt-future-1",
          event_type: "customer.subscription.created",
          charge_id: "chg-future",
          amount_cents: null,
        },
      ],
    });

    assert.equal(summary.unknown_type_skipped, 1);
    assert.equal(summary.malformed_skipped, 0);
    assert.deepEqual(summary.ledger, {});
  });

  it("surfaces unresolved negative balances when an orphaned refund never receives its capture", () => {
    const logger = createLogger({ silent: true });
    const summary = process_events({
      logger,
      print: false,
      events: [
        {
          event_id: "evt-orphan-refund",
          event_type: "charge.refunded",
          charge_id: "chg-orphan",
          amount_cents: 1500,
        },
      ],
    });

    assert.deepEqual(summary.ledger, { "chg-orphan": -1500 });
    assert.equal(summary.unresolved_negative_balances.length, 1);
    assert.equal(summary.unresolved_negative_balances[0].charge_id, "chg-orphan");
    assert.match(formatSummary(summary), /Unresolved Negative Balances/);
  });
});
