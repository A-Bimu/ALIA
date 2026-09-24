import { randomUUID } from 'node:crypto';

/** Inbound header a partner product may use to correlate its own request. */
export const TRACE_HEADER = 'x-trace-id';
export const REQUEST_ID_HEADER = 'x-request-id';

export const MAX_TRACE_ID_LENGTH = 128;

const SAFE_TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** Generate a trace identifier for an ALIA-originated operation. */
export function newTraceId(): string {
  return `alia_${randomUUID()}`;
}

/**
 * An inbound trace identifier is honoured only when it is a short, plain token.
 * Anything else (control characters, oversized values, log-injection attempts)
 * is discarded and replaced.
 */
export function isValidTraceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_TRACE_ID_LENGTH &&
    SAFE_TRACE_ID_PATTERN.test(value)
  );
}

export function resolveTraceId(headers?: Headers | null): string {
  if (headers) {
    const inbound = headers.get(TRACE_HEADER)?.trim() ?? headers.get(REQUEST_ID_HEADER)?.trim();
    if (inbound && isValidTraceId(inbound)) return inbound;
  }
  return newTraceId();
}
