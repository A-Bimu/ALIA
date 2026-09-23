/**
 * Structured error contract for ALIA.
 *
 * Every failure surfaced to a partner product is a typed code, a stable HTTP
 * status, and a message that is safe to log and safe to return. Internal
 * failures never leak their original message, stack, or payload.
 */

export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  IDEMPOTENCY_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  BUDGET_EXCEEDED: 402,
  RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_TIMEOUT: 504,
  CONFIGURATION_ERROR: 500,
  INTERNAL_ERROR: 500,
} as const;

export type AliaErrorCode = keyof typeof ERROR_STATUS;

export const DEFAULT_ERROR_MESSAGE: Record<AliaErrorCode, string> = {
  VALIDATION_ERROR: 'The request did not match the expected schema.',
  UNAUTHENTICATED: 'Authentication is required.',
  FORBIDDEN: 'This principal is not permitted to perform that action.',
  NOT_FOUND: 'The requested resource was not found.',
  METHOD_NOT_ALLOWED: 'That method is not supported for this endpoint.',
  IDEMPOTENCY_CONFLICT: 'This request conflicts with a previously seen request.',
  PAYLOAD_TOO_LARGE: 'The request payload is larger than the allowed limit.',
  BUDGET_EXCEEDED: 'The organization budget for this period is exhausted.',
  RATE_LIMITED: 'Too many requests. Retry after the indicated delay.',
  PROVIDER_UNAVAILABLE: 'The language service is temporarily unavailable.',
  PROVIDER_TIMEOUT: 'The language service did not respond in time.',
  CONFIGURATION_ERROR: 'The service is not correctly configured.',
  INTERNAL_ERROR: 'The service failed to complete the request.',
};

/** Codes whose details are authored for callers and safe to return. */
const CLIENT_SAFE_DETAIL_CODES: ReadonlySet<AliaErrorCode> = new Set([
  'VALIDATION_ERROR',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'BUDGET_EXCEEDED',
]);

/** Codes whose message must be replaced by the default before leaving the process. */
const MESSAGE_WITHHELD_CODES: ReadonlySet<AliaErrorCode> = new Set([
  'CONFIGURATION_ERROR',
  'INTERNAL_ERROR',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
]);

export interface AliaErrorOptions {
  message?: string;
  /** Caller-safe detail only. Never a secret, credential, or child data. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AliaError extends Error {
  readonly code: AliaErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: AliaErrorCode, options: AliaErrorOptions = {}) {
    super(options.message ?? DEFAULT_ERROR_MESSAGE[code], { cause: options.cause });
    this.name = 'AliaError';
    this.code = code;
    this.httpStatus = ERROR_STATUS[code];
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isAliaError(value: unknown): value is AliaError {
  return value instanceof AliaError;
}

export interface AliaErrorBody {
  trace_id: string;
  error: {
    code: AliaErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface PublicErrorResult {
  status: number;
  body: AliaErrorBody;
}

/**
 * Convert any thrown value into a response-safe error body.
 * Unknown failures become INTERNAL_ERROR with no original message.
 */
export function toPublicError(error: unknown, traceId: string): PublicErrorResult {
  if (!isAliaError(error)) {
    return {
      status: ERROR_STATUS.INTERNAL_ERROR,
      body: {
        trace_id: traceId,
        error: { code: 'INTERNAL_ERROR', message: DEFAULT_ERROR_MESSAGE.INTERNAL_ERROR },
      },
    };
  }

  const message = MESSAGE_WITHHELD_CODES.has(error.code)
    ? DEFAULT_ERROR_MESSAGE[error.code]
    : error.message;

  const body: AliaErrorBody = {
    trace_id: traceId,
    error: { code: error.code, message },
  };

  if (error.details !== undefined && CLIENT_SAFE_DETAIL_CODES.has(error.code)) {
    body.error.details = error.details;
  }

  return { status: error.httpStatus, body };
}

export interface LogSafeError {
  trace_id: string;
  code: AliaErrorCode;
  name: string;
}

/**
 * Log-safe projection. Deliberately excludes message, stack, cause, and details
 * so a credential or learner payload cannot reach a log sink through an error.
 */
export function toLogSafeError(error: unknown, traceId: string): LogSafeError {
  if (isAliaError(error)) {
    return { trace_id: traceId, code: error.code, name: error.name };
  }
  return { trace_id: traceId, code: 'INTERNAL_ERROR', name: 'UnknownError' };
}
