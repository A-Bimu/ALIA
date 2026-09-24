/**
 * Environment contract for the ALIA-002 additions.
 *
 * The database and token-verification keys are server-only. A malformed value must
 * be reported by key name, and none of these values may ever reach a browser slice.
 */

import { describe, expect, it } from 'vitest';

import { ENV_SOURCE_KIND, getPublicEnv, inspectEnv, loadEnv, PUBLIC_ENV_KEYS } from '@/config/env';
import { AliaError } from '@/lib/errors';

const DB_URL = 'postgres://alia_user:sup3r-s3cret-pw@db.example.test:5432/postgres';
const JWT_SECRET = 'test-only-jwt-secret-value-0123456789';

describe('database and auth configuration', () => {
  it('accepts a postgres connection string, a role name, and a timeout', () => {
    const env = loadEnv({
      DATABASE_URL: DB_URL,
      ALIA_DB_APP_ROLE: 'alia_app',
      ALIA_DB_STATEMENT_TIMEOUT_MS: '2500',
      SUPABASE_JWT_SECRET: JWT_SECRET,
      SUPABASE_JWT_AUDIENCE: 'authenticated',
    });

    expect(env.DATABASE_URL).toBe(DB_URL);
    expect(env.ALIA_DB_APP_ROLE).toBe('alia_app');
    expect(env.ALIA_DB_STATEMENT_TIMEOUT_MS).toBe(2_500);
  });

  it('reports a malformed database URL or role by key name only', () => {
    const inspection = inspectEnv({
      DATABASE_URL: 'mysql://user:pw@host:3306/db',
      ALIA_DB_APP_ROLE: 'Alia App',
      ALIA_DB_STATEMENT_TIMEOUT_MS: '-5',
    });

    expect(inspection.ok).toBe(false);
    expect(inspection.environment).toBe('unknown');
    expect(inspection.issues.map((issue) => issue.key).sort()).toEqual([
      'ALIA_DB_APP_ROLE',
      'ALIA_DB_STATEMENT_TIMEOUT_MS',
      'DATABASE_URL',
    ]);

    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain('mysql://');
    expect(serialized).not.toContain('pw@host');
    expect(serialized).not.toContain('Alia App');
  });

  it('keeps the connection string out of a thrown configuration error', () => {
    try {
      loadEnv({ DATABASE_URL: 'not-a-url' });
      expect.unreachable('an invalid DATABASE_URL must fail closed');
    } catch (error) {
      const typed = error as AliaError;
      expect(typed.code).toBe('CONFIGURATION_ERROR');
      expect(typed.message).toContain('DATABASE_URL');
      expect(typed.message).not.toContain('not-a-url');
    }
  });

  it('never exposes a server-only key in the browser slice', () => {
    const publicEnv = getPublicEnv({
      DATABASE_URL: DB_URL,
      SUPABASE_JWT_SECRET: JWT_SECRET,
      NEXT_PUBLIC_ALIA_SERVICE_NAME: 'ALIA',
    });

    expect(Object.keys(publicEnv)).toEqual(['serviceName']);
    expect(JSON.stringify(publicEnv)).not.toContain(DB_URL);
    expect(JSON.stringify(publicEnv)).not.toContain(JWT_SECRET);

    for (const key of PUBLIC_ENV_KEYS) {
      expect(key.startsWith('NEXT_PUBLIC_')).toBe(true);
    }
    expect(ENV_SOURCE_KIND).toBe('server');
  });

  it('does not require any of the new keys for a healthy bare environment', () => {
    const inspection = inspectEnv({});
    expect(inspection.ok).toBe(true);
    expect(inspection.issues).toEqual([]);
  });
});
