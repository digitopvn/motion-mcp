import { redact, redactDeep } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** JSON-lines logger that redacts every message and field before writing to stderr. */
export function createLogger(
  bindings: Record<string, unknown> = {},
  level: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info",
): Logger {
  const write = (lvl: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redact(msg),
      ...redactDeep(bindings),
      ...(data ? redactDeep(data) : {}),
    };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    child: (b) => createLogger({ ...bindings, ...b }, level),
  };
}
