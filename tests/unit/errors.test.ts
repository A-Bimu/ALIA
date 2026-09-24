import { describe, expect, it } from 'vitest';

import {
  AliaError,
  DEFAULT_ERROR_MESSAGE,
  ERROR_STATUS,
  isAliaError,
  toLogSafeError,
  toPublicError,
} from '@/lib/errors';

const TRACE = 'alia_trace_0001';

describe('structured errors', () => {
  it('maps every code to a stable HTTP status', () => {
    expect(ERROR_STATUS.VALIDATION_ERROR).toBe(400);
    expect(ERROR_STATUS.UNAUTHENTICATED).toBe(401);
    expect(ERROR_STATUS.FORBIDDEN).toBe(403);
    expect(ERROR_STATUS.BUDGET_EXCEEDED).toBe(402);
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
    expect(ERROR_STATUS.PROVIDER_UNAVAILABLE).toBe(503);
    expect(ERROR_STATUS.INTERNAL_ERROR).toBe(500);
  });

  it('returns a typed body for a known error', () => {
    const error = new AliaError('VALIDATION_ERROR', {
      message: 'field skill_id is required',
      details: { field: 'skill_id' },
    });

    const { status, body } = toPublicError(error, TRACE);

    expect(status).toBe(400);
    expect(body.trace_id).toBe(TRACE);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('field skill_id is required');
    expect(body.error.details).toEqual({ field: 'skill_id' });
  });

  it('withholds internal and configuration detail', () => {
    const internal = new AliaError('INTERNAL_ERROR', {
      message: 'postgres://user:secret@host/db failed',
      details: { credential: 'secret' },
    });

    const { status, body } = toPublicError(internal, TRACE);

    expect(status).toBe(500);
    expect(body.error.message).toBe(DEFAULT_ERROR_MESSAGE.INTERNAL_ERROR);
    expect(body.error.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('secret');

    const configuration = new AliaError('CONFIGURATION_ERROR', {
      message: 'Missing server configuration: SUPABASE_ANON_KEY',
    });
    expect(toPublicError(configuration, TRACE).body.error.message).toBe(
      DEFAULT_ERROR_MESSAGE.CONFIGURATION_ERROR,
    );
  });

  it('degrades an unknown thrown value without leaking it', () => {
    const thrown = new Error('boom: apikey=sk-live-123');
    const { status, body } = toPublicError(thrown, TRACE);

    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('sk-live-123');
    expect(JSON.stringify(body)).not.toContain('boom');
  });

  it('keeps messages, stacks, and payloads out of the log-safe projection', () => {
    const error = new AliaError('CONFIGURATION_ERROR', {
      message: 'Missing server configuration: SUPABASE_ANON_KEY',
      cause: new Error('connection refused for postgres://user:pw@host'),
    });

    const logSafe = toLogSafeError(error, TRACE);

    expect(logSafe).toEqual({ trace_id: TRACE, code: 'CONFIGURATION_ERROR', name: 'AliaError' });
    expect(JSON.stringify(logSafe)).not.toContain('supabase');
    expect(JSON.stringify(logSafe)).not.toContain('pw@host');

    expect(toLogSafeError('a bare string', TRACE)).toEqual({
      trace_id: TRACE,
      code: 'INTERNAL_ERROR',
      name: 'UnknownError',
    });
  });

  it('recognises only its own error type', () => {
    expect(isAliaError(new AliaError('NOT_FOUND'))).toBe(true);
    expect(isAliaError(new Error('plain'))).toBe(false);
    expect(isAliaError({ code: 'NOT_FOUND' })).toBe(false);
  });
});
