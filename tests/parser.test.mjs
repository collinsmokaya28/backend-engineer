import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FIXTURE_PATH,
  loadWebhookEventsFromFile,
  parseWebhookEventsMarkdown,
} from "../src/parser.mjs";

describe("webhook fixture markdown parser", () => {
  it("loads all 10 events from webhook_events.md in delivery order", () => {
    const events = loadWebhookEventsFromFile(DEFAULT_FIXTURE_PATH);

    assert.equal(events.length, 10);
    assert.deepEqual(
      events.map((e) => e.event_id),
      [
        "evt-001",
        "evt-002",
        "evt-003",
        "evt-004",
        "evt-005",
        "evt-005",
        "evt-006",
        "evt-007",
        "evt-008",
        "evt-009",
      ]
    );
  });

  it("preserves empty amount_cents as null instead of coercing to 0", () => {
    const events = loadWebhookEventsFromFile(DEFAULT_FIXTURE_PATH);
    const malformed = events.find((e) => e.event_id === "evt-007");

    assert.ok(malformed, "expected evt-007 in fixture");
    assert.equal(malformed.charge_id, "charge-E");
    assert.equal(malformed.amount_cents, null);
  });

  it("preserves non-integer amount_cents as raw string for downstream validation", () => {
    const markdown = [
      "| # | event_id | event_type | charge_id | amount_cents | received_at |",
      "|---|----------|------------|-----------|--------------|-------------|",
      "| 1 | evt-bad  | charge.succeeded | charge-Z | 12.50 | 2024-02-01T09:00:00Z |",
      "| 2 | evt-txt  | charge.succeeded | charge-Z | NaN   | 2024-02-01T09:01:00Z |",
    ].join("\n");

    const events = parseWebhookEventsMarkdown(markdown);
    assert.equal(events.length, 2);
    assert.equal(events[0].amount_cents, "12.50");
    assert.equal(events[1].amount_cents, "NaN");
  });

  it("returns an empty array when no markdown table is present", () => {
    assert.deepEqual(parseWebhookEventsMarkdown("# Empty file\nNo events."), []);
  });
});
