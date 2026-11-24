import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE_PATH = resolve(MODULE_DIR, "..", "webhook_events.md");

const SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;
const STRICT_INTEGER_PATTERN = /^-?\d+$/;

/**
 * Splits a markdown pipe-table line into trimmed cell strings.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitTableRow(line) {
  const trimmed = line.trim();
  const withoutOuterPipes = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutOuterPipes.split("|").map((cell) => cell.trim());
}

/**
 * Parses a raw amount_cents table cell without silently coercing blank cells to 0.
 *
 * - Empty cells become `null` so downstream validation identifies them as missing.
 * - Strict base-10 integers parse to JS numbers (checked for safe integer range later).
 * - Anything else (e.g. "abc", "12.50") is returned as the raw string so validation rejects it.
 *
 * @param {string} raw
 * @returns {number | string | null}
 */
function parseAmountCell(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (STRICT_INTEGER_PATTERN.test(raw)) {
    return Number(raw);
  }
  return raw;
}

/**
 * Parses webhook events from markdown table content.
 *
 * Expects a GitHub-flavored markdown table containing the columns:
 * `event_id`, `event_type`, `charge_id`, `amount_cents`, `received_at`
 * (plus an optional `#` row-index column).
 *
 * @param {string} markdown
 * @returns {Array<{
 *   row_number: number | null,
 *   event_id: string,
 *   event_type: string,
 *   charge_id: string,
 *   amount_cents: number | string | null,
 *   received_at: string
 * }>}
 */
export function parseWebhookEventsMarkdown(markdown) {
  if (typeof markdown !== "string") {
    throw new TypeError("markdown input must be a string");
  }

  const lines = markdown.split(/\r?\n/);
  let headers = null;
  let inTable = false;
  const events = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("|")) {
      if (inTable) {
        break;
      }
      continue;
    }

    const cells = splitTableRow(trimmed);

    if (!headers) {
      headers = cells.map((h) => h.toLowerCase());
      continue;
    }

    if (!inTable && cells.every((cell) => SEPARATOR_CELL_PATTERN.test(cell))) {
      inTable = true;
      continue;
    }

    if (!inTable) {
      continue;
    }

    const record = Object.create(null);
    for (let i = 0; i < headers.length; i += 1) {
      record[headers[i]] = cells[i] ?? "";
    }

    const rawRowNumber = record["#"] ?? "";
    const rowNumber = STRICT_INTEGER_PATTERN.test(rawRowNumber)
      ? Number.parseInt(rawRowNumber, 10)
      : events.length + 1;

    events.push({
      row_number: rowNumber,
      event_id: record.event_id ?? "",
      event_type: record.event_type ?? "",
      charge_id: record.charge_id ?? "",
      amount_cents: parseAmountCell(record.amount_cents),
      received_at: record.received_at ?? "",
    });
  }

  return events;
}

/**
 * Loads and parses webhook events from a markdown fixture file.
 *
 * @param {string} [fixturePath=DEFAULT_FIXTURE_PATH]
 */
export function loadWebhookEventsFromFile(fixturePath = DEFAULT_FIXTURE_PATH) {
  const content = readFileSync(fixturePath, "utf8");
  return parseWebhookEventsMarkdown(content);
}
