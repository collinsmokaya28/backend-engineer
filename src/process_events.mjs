import { WebhookLedgerProcessor } from "./ledger.mjs";
import { createLogger } from "./logger.mjs";
import { DEFAULT_FIXTURE_PATH, loadWebhookEventsFromFile } from "./parser.mjs";

function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${remainder}`;
}

/**
 * Formats a processing summary into a deterministic, human-readable report.
 *
 * @param {ReturnType<WebhookLedgerProcessor["getSummary"]>} summary
 * @returns {string}
 */
export function formatSummary(summary) {
  const ledgerEntries = Object.entries(summary.ledger);
  const totalNetCents = ledgerEntries.reduce((acc, [, amount]) => acc + amount, 0);

  const lines = [
    "=== Webhook Processing Summary ===",
    `Total events read:          ${summary.total_events_read}`,
    `Processed events:           ${summary.processed_events} (failed tracked for dedup: ${summary.failed_events_recorded})`,
    `Duplicates skipped:         ${summary.duplicates_skipped}`,
    `Malformed skipped:          ${summary.malformed_skipped}`,
    `Unknown-type skipped:       ${summary.unknown_type_skipped}`,
    "",
    "Final Ledger (charge_id -> net_amount_cents):",
  ];

  if (ledgerEntries.length === 0) {
    lines.push("  (empty)");
  } else {
    for (const [chargeId, netCents] of ledgerEntries) {
      lines.push(`  ${chargeId.padEnd(12)} : ${String(netCents).padStart(6)} cents (${formatCents(netCents)})`);
    }
    lines.push(`  ${"TOTAL".padEnd(12)} : ${String(totalNetCents).padStart(6)} cents (${formatCents(totalNetCents)})`);
  }

  if (summary.unresolved_negative_balances.length > 0) {
    lines.push("");
    lines.push("Unresolved Negative Balances (pending capture):");
    for (const item of summary.unresolved_negative_balances) {
      lines.push(`  ${item.charge_id}: ${item.net_amount_cents} cents`);
    }
  }

  return lines.join("\n");
}

/**
 * Reads incoming webhook events (from `webhook_events.md` by default, or from
 * an explicitly provided iterable), applies each distinct valid event exactly
 * once regardless of arrival order, logs and skips malformed and unknown-type
 * events, and prints a summary report.
 *
 * @param {object} [options]
 * @param {Iterable<unknown>} [options.events] - Optional event stream overriding fixture loading.
 * @param {string} [options.fixturePath] - Optional path to a markdown webhook fixture file.
 * @param {ReturnType<typeof createLogger>} [options.logger] - Optional structured logger instance.
 * @param {boolean} [options.print=true] - Whether to print the formatted summary to output.
 * @param {boolean} [options.json=false] - Whether to print the summary as formatted JSON.
 * @param {(text: string) => void} [options.output] - Optional output sink (defaults to stdout).
 */
export function process_events({
  events,
  fixturePath = DEFAULT_FIXTURE_PATH,
  logger = createLogger(),
  print = true,
  json = false,
  output = (text) => process.stdout.write(`${text}\n`),
} = {}) {
  const incomingEvents = events ?? loadWebhookEventsFromFile(fixturePath);
  const processor = new WebhookLedgerProcessor({ logger });
  const summary = processor.processStream(incomingEvents);

  if (print) {
    output(json ? JSON.stringify(summary, null, 2) : formatSummary(summary));
  }

  return summary;
}
