/**
 * Lightweight structured logger writing JSON lines to stderr by default.
 * Keeping operational logs on stderr leaves stdout clean for machine- or
 * human-readable summary reports.
 */
export function createLogger({ write = (line) => process.stderr.write(`${line}\n`), silent = false } = {}) {
  const entries = [];

  function emit(level, event, details = {}) {
    const entry = {
      level,
      event,
      ...details,
    };
    entries.push(entry);
    if (!silent) {
      write(JSON.stringify(entry));
    }
    return entry;
  }

  return {
    entries,
    info(event, details) {
      return emit("INFO", event, details);
    },
    warn(event, details) {
      return emit("WARN", event, details);
    },
    error(event, details) {
      return emit("ERROR", event, details);
    },
  };
}
