import { TRACE_HEADER } from '@/lib/trace';

export interface JsonResponseInit {
  status?: number;
  traceId: string;
  headers?: Record<string, string>;
}

/**
 * Header names whose value is an invariant of every API response. They are
 * applied after caller headers, so a caller can never replace them, and the
 * canonical spelling always wins over a differently-cased attempt.
 */
export const PROTECTED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'x-content-type-options',
  TRACE_HEADER,
] as const;

/**
 * Single JSON response shape for the versioned API. Every response carries the
 * trace identifier and is never cached by a shared cache.
 *
 * Caller headers are applied first and the protected headers last: the response
 * invariants are authoritative, because `Headers.set` replaces an existing entry
 * case-insensitively. A caller cannot override `content-type`, `cache-control`,
 * `x-content-type-options`, or `x-trace-id`.
 */
export function jsonResponse(body: unknown, init: JsonResponseInit): Response {
  const headers = new Headers();

  for (const [name, value] of Object.entries(init.headers ?? {})) {
    headers.set(name, value);
  }

  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set(TRACE_HEADER, init.traceId);

  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}
