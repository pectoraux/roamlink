/**
 * Structured logger — single source of truth for observability.
 * Every important transaction is logged with structured fields so it can be
 * shipped to a log aggregator in production.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = {
  requestId?: string;
  userId?: string;
  orderId?: string;
  provider?: string;
  providerReference?: string;
  operation?: string;
  status?: string;
  duration?: number;
  error?: string;
  [key: string]: unknown;
};

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") return env;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function emit(level: LogLevel, message: string, ctx: LogContext = {}) {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLevel()]) return;
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...ctx,
  };
  // In production this would write to stdout/structured log shipper.
  // Avoid leaking full objects in error to keep logs readable.
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  debug: (message: string, ctx?: LogContext) => emit("debug", message, ctx),
  info: (message: string, ctx?: LogContext) => emit("info", message, ctx),
  warn: (message: string, ctx?: LogContext) => emit("warn", message, ctx),
  error: (message: string, ctx?: LogContext) => emit("error", message, ctx),
};

/** Generate a request id for tracing. */
export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
