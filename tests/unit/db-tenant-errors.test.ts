/**
 * Database failure mapping.
 *
 * A row level security refusal must never become a partial success, and a database
 * message must never travel to a caller or a log sink.
 */

import { describe, expect, it } from 'vitest';

import { AliaError, toLogSafeError, toPublicError } from '@/lib/errors';
import { toTypedDbError } from '@/lib/db/tenant';

const RLS_MESSAGE =
  'new row violates row-level security policy for table "learners" (learner 7f0c-... )';

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR' });
}

describe('toTypedDbError', () => {
  it('maps a policy refusal to FORBIDDEN and keeps the detail out of the response', () => {
    const typed = toTypedDbError(pgError('42501', RLS_MESSAGE));

    expect(typed.code).toBe('FORBIDDEN');
    expect(typed.httpStatus).toBe(403);
    expect(typed.message).toBe('This principal is not permitted to perform that action.');

    const { body } = toPublicError(typed, 'alia_trace_unit_1');
    expect(JSON.stringify(body)).not.toContain('row-level security');
    expect(JSON.stringify(body)).not.toContain('7f0c');
  });

  it('maps a unique violation to a typed idempotency conflict', () => {
    const typed = toTypedDbError(
      pgError('23505', 'duplicate key value violates unique constraint "learning_events_organization_id_external_event_id_key"'),
    );

    expect(typed.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(typed.httpStatus).toBe(409);
    const { body } = toPublicError(typed, 'alia_trace_unit_2');
    expect(JSON.stringify(body)).not.toContain('learning_events_organization_id');
  });

  it('maps constraint violations to a typed validation error', () => {
    for (const code of ['23502', '23503', '23514', '22P02', '22001', '22003']) {
      const typed = toTypedDbError(pgError(code, `constraint detail for ${code}`));
      expect(typed.code, code).toBe('VALIDATION_ERROR');
      expect(typed.httpStatus).toBe(400);
      const { body } = toPublicError(typed, 'alia_trace_unit_3');
      expect(JSON.stringify(body)).not.toContain('constraint detail');
    }
  });

  it('degrades a statement timeout and an unknown failure without leaking them', () => {
    for (const error of [pgError('57014', 'canceling statement due to statement timeout'), new Error('socket hang up')]) {
      const typed = toTypedDbError(error);
      expect(typed.code).toBe('INTERNAL_ERROR');

      const { body } = toPublicError(typed, 'alia_trace_unit_4');
      expect(JSON.stringify(body)).not.toContain('statement timeout');
      expect(JSON.stringify(body)).not.toContain('socket hang up');

      const logSafe = toLogSafeError(typed, 'alia_trace_unit_4');
      expect(logSafe).toEqual({
        trace_id: 'alia_trace_unit_4',
        code: 'INTERNAL_ERROR',
        name: 'AliaError',
      });
    }
  });

  it('recognises an error object without a code field', () => {
    expect(toTypedDbError({ message: 'no code' }).code).toBe('INTERNAL_ERROR');
    expect(toTypedDbError('a bare string').code).toBe('INTERNAL_ERROR');
    expect(toTypedDbError(null).code).toBe('INTERNAL_ERROR');
  });

  it('returns a typed error, never the raw database error', () => {
    const typed = toTypedDbError(pgError('42501', RLS_MESSAGE));
    expect(typed).toBeInstanceOf(AliaError);
    expect(typed.cause).toBeInstanceOf(Error);
  });
});
