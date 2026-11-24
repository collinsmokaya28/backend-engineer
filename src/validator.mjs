export const EVENT_TYPES = Object.freeze({
  CHARGE_SUCCEEDED: "charge.succeeded",
  CHARGE_REFUNDED: "charge.refunded",
  CHARGE_FAILED: "charge.failed",
});

export const SUPPORTED_EVENT_TYPES = Object.freeze(
  new Set(Object.values(EVENT_TYPES))
);

const STRICT_NON_NEGATIVE_INT_PATTERN = /^\d+$/;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates the common webhook event envelope required before routing or
 * deduplication (`event_id`, `event_type`, `charge_id`).
 *
 * @param {unknown} rawEvent
 */
export function validateEnvelope(rawEvent) {
  if (rawEvent === null || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
    return { ok: false, reason: "event payload must be a non-null object" };
  }

  if (!isNonEmptyString(rawEvent.event_id)) {
    return { ok: false, reason: "missing or empty required field: event_id" };
  }

  if (!isNonEmptyString(rawEvent.event_type)) {
    return { ok: false, reason: "missing or empty required field: event_type" };
  }

  if (!isNonEmptyString(rawEvent.charge_id)) {
    return { ok: false, reason: "missing or empty required field: charge_id" };
  }

  return {
    ok: true,
    envelope: {
      row_number: rawEvent.row_number ?? null,
      event_id: rawEvent.event_id.trim(),
      event_type: rawEvent.event_type.trim(),
      charge_id: rawEvent.charge_id.trim(),
      received_at: typeof rawEvent.received_at === "string" ? rawEvent.received_at.trim() : "",
    },
  };
}

/**
 * Returns true if the event_type is handled by this processor version.
 *
 * @param {string} eventType
 */
export function isSupportedEventType(eventType) {
  return SUPPORTED_EVENT_TYPES.has(eventType);
}

/**
 * Parses and validates `amount_cents` as a non-negative safe integer.
 * Rejects missing values, booleans, floats, NaN/Infinity, and negative values
 * (direction is represented strictly by `event_type`, never by sign).
 *
 * @param {unknown} rawAmount
 */
export function parseValidAmountCents(rawAmount) {
  if (rawAmount === null || rawAmount === undefined || rawAmount === "") {
    return { ok: false, reason: "missing required field: amount_cents" };
  }

  if (typeof rawAmount === "number") {
    if (!Number.isSafeInteger(rawAmount)) {
      return { ok: false, reason: `amount_cents must be a safe integer, got: ${rawAmount}` };
    }
    if (rawAmount < 0) {
      return { ok: false, reason: `amount_cents must be non-negative, got: ${rawAmount}` };
    }
    return { ok: true, amount_cents: rawAmount };
  }

  if (typeof rawAmount === "string") {
    const trimmed = rawAmount.trim();
    if (!STRICT_NON_NEGATIVE_INT_PATTERN.test(trimmed)) {
      return { ok: false, reason: `amount_cents must be a non-negative integer, got: "${rawAmount}"` };
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) {
      return { ok: false, reason: `amount_cents exceeds safe integer range: "${rawAmount}"` };
    }
    return { ok: true, amount_cents: parsed };
  }

  return {
    ok: false,
    reason: `amount_cents has invalid type (${typeof rawAmount})`,
  };
}

/**
 * Validates payload fields for a recognized charge webhook event.
 *
 * @param {Record<string, unknown>} rawEvent
 */
export function validateKnownEventPayload(rawEvent) {
  const amountResult = parseValidAmountCents(rawEvent.amount_cents);
  if (!amountResult.ok) {
    return amountResult;
  }

  if (rawEvent.received_at !== undefined && rawEvent.received_at !== null && rawEvent.received_at !== "") {
    if (typeof rawEvent.received_at !== "string" || Number.isNaN(Date.parse(rawEvent.received_at))) {
      return {
        ok: false,
        reason: `invalid received_at timestamp: "${String(rawEvent.received_at)}"`,
      };
    }
  }

  return {
    ok: true,
    amount_cents: amountResult.amount_cents,
  };
}
