export type MotionErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFIG"
  | "PROVIDER"
  | "RENDER"
  | "LINT"
  | "BUDGET_EXCEEDED"
  | "TIMEOUT"
  | "CANCELLED"
  | "INTERNAL";

/** Normalized error used across packages so MCP responses and traces stay consistent. */
export class MotionError extends Error {
  readonly code: MotionErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: MotionErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "MotionError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export function toMotionError(err: unknown, fallback: MotionErrorCode = "INTERNAL"): MotionError {
  if (err instanceof MotionError) return err;
  if (err instanceof Error) return new MotionError(fallback, err.message, { cause: err });
  return new MotionError(fallback, String(err));
}
