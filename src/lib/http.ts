import { TRACE_HEADER } from '@/lib/trace';

export interface JsonResponseInit {
  status?: number;
  traceId: string;
  headers?: Record<string, string>;
}

/**
 * Single JSON response shape for the versioned API. Every response carries the
 * trace identifier and is never cached by a shared cache.
 */
export function jsonResponse(body: unknown, init: JsonResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      [TRACE_HEADER]: init.traceId,
      ...init.headers,
    },
  });
}
