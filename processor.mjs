#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { process_events, formatSummary } from "./src/process_events.mjs";
import { WebhookLedgerProcessor } from "./src/ledger.mjs";
import {
  DEFAULT_FIXTURE_PATH,
  loadWebhookEventsFromFile,
  parseWebhookEventsMarkdown,
} from "./src/parser.mjs";

export {
  process_events,
  formatSummary,
  WebhookLedgerProcessor,
  DEFAULT_FIXTURE_PATH,
  loadWebhookEventsFromFile,
  parseWebhookEventsMarkdown,
};

function parseCliArgs(argv) {
  let json = false;
  let fixturePath = DEFAULT_FIXTURE_PATH;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--fixture" && argv[i + 1]) {
      fixturePath = resolve(argv[i + 1]);
      i += 1;
    }
  }

  return { json, fixturePath };
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  const { json, fixturePath } = parseCliArgs(process.argv.slice(2));
  process_events({ fixturePath, json, print: true });
}
