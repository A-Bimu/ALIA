import { describe, expect, it } from 'vitest';

import { PROTECTED_RESPONSE_HEADERS, jsonResponse } from '@/lib/http';
import { TRACE_HEADER } from '@/lib/trace';

const TRACE_ID = 'alia_trace_http_0001';

describe('jsonResponse', () => {
  it('applies every API response invariant by default', async () => {
    const response = jsonResponse({ status: 'ok' }, { traceId: TRACE_ID });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get(TRACE_HEADER)).toBe(TRACE_ID);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('honours a caller status while keeping the protected headers', () => {
    const response = jsonResponse({ code: 'not_found' }, { status: 404, traceId: TRACE_ID });

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get(TRACE_HEADER)).toBe(TRACE_ID);
  });

  it('lets a caller add an unprotected header', () => {
    const response = jsonResponse(
      { status: 'ok' },
      { traceId: TRACE_ID, headers: { 'retry-after': '30', 'x-alia-route': 'rule' } },
    );

    expect(response.headers.get('retry-after')).toBe('30');
    expect(response.headers.get('x-alia-route')).toBe('rule');
  });

  it('refuses caller overrides of the protected headers, including mixed case', () => {
    const response = jsonResponse(
      { status: 'ok' },
      {
        traceId: TRACE_ID,
        headers: {
          'content-type': 'text/html',
          'Content-Type': 'text/plain',
          'CACHE-CONTROL': 'public, max-age=600',
          'cache-control': 'public, max-age=600',
          'X-Content-Type-Options': 'sniff',
          'x-content-type-options': 'sniff',
          [TRACE_HEADER]: 'spoofed-trace-value',
          'X-Trace-Id': 'spoofed-trace-value-2',
        },
      },
    );

    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get(TRACE_HEADER)).toBe(TRACE_ID);

    const names = [...response.headers.keys()].map((name) => name.toLowerCase());
    for (const protectedName of PROTECTED_RESPONSE_HEADERS) {
      expect(names.filter((name) => name === protectedName.toLowerCase())).toHaveLength(1);
    }
    const serialized = JSON.stringify([...response.headers]);
    expect(serialized).not.toContain('spoofed-trace-value');
    expect(serialized).not.toContain('max-age=600');
    expect(serialized).not.toContain('text/html');
  });
});
