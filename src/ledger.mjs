import { createLogger } from "./logger.mjs";
import {
  EVENT_TYPES,
  isSupportedEventType,
  parseValidAmountCents,
  validateEnvelope,
  validateKnownEventPayload,
} from "./validator.mjs";

/**
 * Idempotent, order-independent webhook processor for payment charge events.
 *
 * Core invariants:
 * 1. Exactly-once application per `event_id`: deduplication keys strictly on
 *    `event_id` (independent of delivery timestamp or retry count).
 * 2. Order independence (commutativity): financial deltas are accumulated in
 *    integer cents (`+amount_cents` for `charge.succeeded`, `-amount_cents` for
 *    `charge.refunded`) without rejecting or clamping provisional negative
 *    balances when a refund arrives before its corresponding capture.
 * 3. Fault isolation: malformed poison pills and unrecognized future event
 *    types are logged, quarantined, and skipped without mutating the ledger or
 *    halting subsequent events (including other events for the same `charge_id`).
 */
export class WebhookLedgerProcessor {
  #logger;
  #seenEvents = new Map();
  #chargeAccounts = new Map();
  #deadLetterEvents = [];
  #stats = {
    total_events_read: 0,
    processed_events: 0,
    duplicates_skipped: 0,
    malformed_skipped: 0,
    unknown_type_skipped: 0,
    failed_events_recorded: 0,
    out_of_order_refunds_observed: 0,
  };

  constructor({ logger = createLogger() } = {}) {
    this.#logger = logger;
  }

  /**
   * Processes a single raw webhook event defensively.
   *
   * @param {unknown} rawEvent
   */
  processEvent(rawEvent) {
    this.#stats.total_events_read += 1;

    try {
      return this.#processEventInternal(rawEvent);
    } catch (error) {
      this.#stats.malformed_skipped += 1;
      const reason = error instanceof Error ? error.message : String(error);
      this.#deadLetterEvents.push({
        category: "malformed",
        reason: `unexpected error during event processing: ${reason}`,
        event: null,
      });
      this.#logger.error("malformed_event_skipped", {
        reason: `unexpected error during event processing: ${reason}`,
      });
      return { status: "malformed", reason };
    }
  }

  /**
   * Processes an iterable stream of webhook events and returns the final summary.
   *
   * @param {Iterable<unknown>} events
   */
  processStream(events) {
    for (const rawEvent of events) {
      this.processEvent(rawEvent);
    }
    return this.getSummary();
  }

  #processEventInternal(rawEvent) {
    const envelopeResult = validateEnvelope(rawEvent);
    if (!envelopeResult.ok) {
      this.#stats.malformed_skipped += 1;
      this.#deadLetterEvents.push({
        category: "malformed",
        reason: envelopeResult.reason,
        event: rawEvent,
      });
      this.#logger.warn("malformed_event_skipped", {
        row_number: rawEvent?.row_number ?? null,
        event_id: rawEvent?.event_id ?? null,
        charge_id: rawEvent?.charge_id ?? null,
        reason: envelopeResult.reason,
      });
      return { status: "malformed", reason: envelopeResult.reason };
    }

    const { row_number, event_id, event_type, charge_id, received_at } = envelopeResult.envelope;

    // 1. Deduplicate strictly by event_id before re-applying any side effects.
    if (this.#seenEvents.has(event_id)) {
      const previous = this.#seenEvents.get(event_id);
      const parsedAmount = parseValidAmountCents(rawEvent.amount_cents);
      const hasPayloadConflict =
        previous.event_type !== event_type ||
        previous.charge_id !== charge_id ||
        (parsedAmount.ok && previous.amount_cents !== parsedAmount.amount_cents);

      this.#stats.duplicates_skipped += 1;
      this.#logger.warn(
        hasPayloadConflict ? "duplicate_payload_conflict" : "duplicate_event_skipped",
        {
          row_number,
          event_id,
          event_type,
          charge_id,
          received_at,
        }
      );
      return { status: "duplicate", event_id, conflict: hasPayloadConflict };
    }

    // 2. Check event_type before type-specific payload validation so future
    //    event types with unfamiliar schemas are classified as unknown rather
    //    than malformed. Not added to seenEvents so they can be replayed once
    //    support is deployed.
    if (!isSupportedEventType(event_type)) {
      this.#stats.unknown_type_skipped += 1;
      const reason = `unrecognized event_type: "${event_type}"`;
      this.#deadLetterEvents.push({
        category: "unknown_type",
        reason,
        event: rawEvent,
      });
      this.#logger.warn("unknown_event_type_skipped", {
        row_number,
        event_id,
        event_type,
        charge_id,
        received_at,
        reason,
      });
      return { status: "unknown_type", event_id, event_type };
    }

    // 3. Validate type-specific fields (amount_cents, received_at).
    //    Malformed events are quarantined without poisoning seenEvents or
    //    corrupting other events sharing the same charge_id.
    const payloadResult = validateKnownEventPayload(rawEvent);
    if (!payloadResult.ok) {
      this.#stats.malformed_skipped += 1;
      this.#deadLetterEvents.push({
        category: "malformed",
        reason: payloadResult.reason,
        event: rawEvent,
      });
      this.#logger.warn("malformed_event_skipped", {
        row_number,
        event_id,
        event_type,
        charge_id,
        received_at,
        reason: payloadResult.reason,
      });
      return { status: "malformed", event_id, reason: payloadResult.reason };
    }

    const { amount_cents } = payloadResult;

    // 4. Apply event to ledger (or track failed event as seen with zero delta).
    if (event_type === EVENT_TYPES.CHARGE_FAILED) {
      this.#seenEvents.set(event_id, { event_type, charge_id, amount_cents });
      this.#stats.processed_events += 1;
      this.#stats.failed_events_recorded += 1;
      return { status: "processed", event_id, event_type, charge_id, amount_cents, delta_cents: 0 };
    }

    const delta = event_type === EVENT_TYPES.CHARGE_SUCCEEDED ? amount_cents : -amount_cents;
    const account = this.#getOrCreateAccount(charge_id);
    const nextNet = account.net_amount_cents + delta;
    const nextSucceeded =
      event_type === EVENT_TYPES.CHARGE_SUCCEEDED
        ? account.succeeded_cents + amount_cents
        : account.succeeded_cents;
    const nextRefunded =
      event_type === EVENT_TYPES.CHARGE_REFUNDED
        ? account.refunded_cents + amount_cents
        : account.refunded_cents;

    if (
      !Number.isSafeInteger(nextNet) ||
      !Number.isSafeInteger(nextSucceeded) ||
      !Number.isSafeInteger(nextRefunded)
    ) {
      this.#stats.malformed_skipped += 1;
      const reason = `integer overflow applying ${event_id} to ${charge_id}`;
      this.#deadLetterEvents.push({
        category: "malformed",
        reason,
        event: rawEvent,
      });
      this.#logger.error("malformed_event_skipped", {
        row_number,
        event_id,
        charge_id,
        reason,
      });
      return { status: "malformed", event_id, reason };
    }

    account.succeeded_cents = nextSucceeded;
    account.refunded_cents = nextRefunded;
    account.net_amount_cents = nextNet;
    account.applied_event_ids.push(event_id);

    this.#seenEvents.set(event_id, { event_type, charge_id, amount_cents });
    this.#stats.processed_events += 1;

    if (event_type === EVENT_TYPES.CHARGE_REFUNDED && account.net_amount_cents < 0) {
      this.#stats.out_of_order_refunds_observed += 1;
      this.#logger.info("provisional_negative_balance", {
        row_number,
        event_id,
        charge_id,
        provisional_net_cents: account.net_amount_cents,
        note: "refund arrived before corresponding charge.succeeded; balance will reconcile once capture arrives",
      });
    }

    return { status: "processed", event_id, event_type, charge_id, amount_cents, delta_cents: delta };
  }

  #getOrCreateAccount(chargeId) {
    let account = this.#chargeAccounts.get(chargeId);
    if (!account) {
      account = {
        succeeded_cents: 0,
        refunded_cents: 0,
        net_amount_cents: 0,
        applied_event_ids: [],
      };
      this.#chargeAccounts.set(chargeId, account);
    }
    return account;
  }

  /**
   * Returns a deterministic `charge_id -> net_amount_cents` ledger object
   * sorted alphabetically by `charge_id`.
   *
   * @returns {Record<string, number>}
   */
  getLedger() {
    const ledger = {};
    const sortedChargeIds = [...this.#chargeAccounts.keys()].sort();
    for (const chargeId of sortedChargeIds) {
      ledger[chargeId] = this.#chargeAccounts.get(chargeId).net_amount_cents;
    }
    return ledger;
  }

  /**
   * Returns charges that still have a negative net balance after processing
   * (e.g., an orphaned refund whose capture has not yet arrived).
   */
  getUnresolvedNegativeBalances() {
    const unresolved = [];
    for (const [chargeId, account] of this.#chargeAccounts.entries()) {
      if (account.net_amount_cents < 0) {
        unresolved.push({
          charge_id: chargeId,
          net_amount_cents: account.net_amount_cents,
          succeeded_cents: account.succeeded_cents,
          refunded_cents: account.refunded_cents,
        });
      }
    }
    return unresolved.sort((a, b) => a.charge_id.localeCompare(b.charge_id));
  }

  /**
   * Returns the complete processing summary, ledger, and audit metadata.
   */
  getSummary() {
    return {
      ...this.#stats,
      seen_event_count: this.#seenEvents.size,
      ledger: this.getLedger(),
      unresolved_negative_balances: this.getUnresolvedNegativeBalances(),
      dead_letter_events: this.#deadLetterEvents.map((item) => ({ ...item })),
    };
  }
}
