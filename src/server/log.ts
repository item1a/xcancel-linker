// Structured JSON logging. One log call = one JSON line. Devvit's log viewer
// renders these as-is, but downstream tooling (grep, jq, log shipping) can
// parse them mechanically. Skip-paths (deleted body, too old, no links) are
// intentionally not logged — they're the common case and would just be noise.

type LogLevel = "info" | "warn" | "error";

export function serializeErr(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      err_name: err.name,
      err_message: err.message,
    };
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") out.err_status = status;
    if (err.stack) out.err_stack = err.stack;
    return out;
  }
  return { err: String(err) };
}

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    app: "xcancel-linker",
    msg,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
