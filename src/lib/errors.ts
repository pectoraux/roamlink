/**
 * Canonical application error with safe customer-facing messages.
 * Provider errors are never surfaced raw — they are classified into a
 * `ProviderError` and mapped to a safe message at the API boundary.
 */

export type ErrorClass =
  | "validation"
  | "auth"
  | "authorization"
  | "not_found"
  | "conflict"
  | "provider"
  | "payment"
  | "provisioning"
  | "rate_limit"
  | "internal";

export class AppError extends Error {
  constructor(
    public readonly errorClass: ErrorClass,
    message: string,
    public readonly statusCode: number = 400,
    public readonly safeMessage?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** A safe message suitable to show to customers. */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof AppError && err.safeMessage) return err.safeMessage;
  if (err instanceof AppError) return err.message;
  return "Something went wrong. Please try again.";
}

/** Map provider/payment errors to customer-safe messages. */
export function classifyProviderError(operation: string, err: unknown): AppError {
  const msg = err instanceof Error ? err.message : String(err);
  return new AppError(
    "provider",
    `Provider error during ${operation}: ${msg}`,
    502,
    `We couldn't complete ${operation} right now. Please try again in a moment.`,
    err,
  );
}
