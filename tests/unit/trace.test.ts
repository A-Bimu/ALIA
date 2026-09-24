import { describe, expect, it } from 'vitest';

import {
  MAX_TRACE_ID_LENGTH,
  REQUEST_ID_HEADER,
  TRACE_HEADER,
  isValidTraceId,
  newTraceId,
  resolveTraceId,
} from '@/lib/trace';

/**
 * The platform Headers implementation refuses to hold control characters, so a
 * hostile value is delivered through a minimal Headers-shaped stand-in, exactly
 * as a raw transport value would arrive at the handler.
 */
function fakeHeaders(values: Record<string, string>): Headers {
  return {
    get: (name: string) => values[name.toLowerCase()] ?? null,
  } as unknown as Headers;
}

describe('trace identifiers', () => {
  it('generates unique, well-formed identifiers', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTraceId()));

    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(isValidTraceId(id)).toBe(true);
      expect(id.startsWith('alia_')).toBe(true);
      expect(id.length).toBeLessThanOrEqual(MAX_TRACE_ID_LENGTH);
    }
  });

  it('honours a safe inbound trace identifier', () => {
    const headers = new Headers({ [TRACE_HEADER]: 'partner-trace-0001' });

    expect(resolveTraceId(headers)).toBe('partner-trace-0001');
    expect(resolveTraceId(new Headers({ [TRACE_HEADER]: '  partner-trace-0001  ' }))).toBe(
      'partner-trace-0001',
    );
    expect(resolveTraceId(new Headers({ [REQUEST_ID_HEADER]: 'req-abcdef12' }))).toBe('req-abcdef12');
  });

  it('rejects unusable inbound identifiers and generates a fresh one', () => {
    const unsafe = [
      '',
      'short',
      'has space',
      'line\nbreak',
      'inject\r\nset-cookie: x=1',
      'x'.repeat(MAX_TRACE_ID_LENGTH + 1),
      '_leading-underscore',
      'unicode-☃-id',
    ];

    for (const value of unsafe) {
      expect(isValidTraceId(value)).toBe(false);
      expect(resolveTraceId(fakeHeaders({ [TRACE_HEADER]: value }))).not.toBe(value);
      expect(isValidTraceId(resolveTraceId(fakeHeaders({ [TRACE_HEADER]: value })))).toBe(true);
    }
  });

  it('generates an identifier when no headers are supplied', () => {
    expect(isValidTraceId(resolveTraceId())).toBe(true);
    expect(isValidTraceId(resolveTraceId(null))).toBe(true);
    expect(isValidTraceId(resolveTraceId(new Headers()))).toBe(true);
  });
});
