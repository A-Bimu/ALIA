/**
 * Database configuration contract.
 *
 * The service-role rule is enforced here as configuration validation: a privileged
 * role name can never be configured for a tenant request path, so "no service-role
 * shortcut" fails at startup rather than at review time.
 */

import { describe, expect, it } from 'vitest';

import { AliaError } from '@/lib/errors';
import {
  DEFAULT_DB_APP_ROLE,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  MAX_POOL_SIZE,
  PRIVILEGED_ROLE_NAMES,
  readDbConfig,
} from '@/lib/db/pool';

const PASSWORD_BEARING_URL = 'postgres://alia_user:sup3r-s3cret-pw@db.example.test:5432/postgres';

describe('readDbConfig', () => {
  it('fails closed when DATABASE_URL is absent, naming the key only', () => {
    try {
      readDbConfig({});
      expect.unreachable('a missing DATABASE_URL must fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(AliaError);
      const typed = error as AliaError;
      expect(typed.code).toBe('CONFIGURATION_ERROR');
      expect(typed.message).toContain('DATABASE_URL');
      expect(typed.message).not.toContain('postgres://');
    }
  });

  it('treats an empty value as unset', () => {
    expect(() => readDbConfig({ DATABASE_URL: '   ' })).toThrow(AliaError);
  });

  it('refuses a connection string that is not a postgres URL, without echoing it', () => {
    try {
      readDbConfig({ DATABASE_URL: 'mysql://user:pw@host:3306/db' });
      expect.unreachable('a non-postgres scheme must be refused');
    } catch (error) {
      const typed = error as AliaError;
      expect(typed.code).toBe('CONFIGURATION_ERROR');
      expect(typed.message).toContain('DATABASE_URL');
      expect(typed.message).not.toContain('mysql://');
      expect(typed.message).not.toContain('pw@host');
    }
  });

  it('accepts a postgres URL and applies documented defaults', () => {
    const config = readDbConfig({ DATABASE_URL: PASSWORD_BEARING_URL });

    expect(config.url).toBe(PASSWORD_BEARING_URL);
    expect(config.appRole).toBe(DEFAULT_DB_APP_ROLE);
    expect(config.statementTimeoutMs).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(MAX_POOL_SIZE).toBeGreaterThan(0);
  });

  it('refuses every privileged role as the request role, without echoing the name', () => {
    for (const role of PRIVILEGED_ROLE_NAMES) {
      try {
        readDbConfig({ DATABASE_URL: PASSWORD_BEARING_URL, ALIA_DB_APP_ROLE: role });
        expect.unreachable(`${role} must not be usable as the tenant request role`);
      } catch (error) {
        const typed = error as AliaError;
        expect(typed.code).toBe('CONFIGURATION_ERROR');
        expect(typed.message).toContain('privileged role');
        expect(typed.message).not.toContain(role);
      }
    }
  });

  it('refuses a malformed role name', () => {
    for (const role of ['Alia App', 'alia-app', '1alia', 'alia"app', '']) {
      if (role === '') {
        // An empty value falls back to the default, which is valid.
        expect(readDbConfig({ DATABASE_URL: PASSWORD_BEARING_URL, ALIA_DB_APP_ROLE: role }).appRole).toBe(
          DEFAULT_DB_APP_ROLE,
        );
        continue;
      }
      expect(() =>
        readDbConfig({ DATABASE_URL: PASSWORD_BEARING_URL, ALIA_DB_APP_ROLE: role }),
      ).toThrow(AliaError);
    }
  });

  it('accepts a custom restricted role', () => {
    const config = readDbConfig({
      DATABASE_URL: PASSWORD_BEARING_URL,
      ALIA_DB_APP_ROLE: 'alia_reader',
    });
    expect(config.appRole).toBe('alia_reader');
  });

  it('validates the statement timeout', () => {
    expect(
      readDbConfig({ DATABASE_URL: PASSWORD_BEARING_URL, ALIA_DB_STATEMENT_TIMEOUT_MS: '2500' })
        .statementTimeoutMs,
    ).toBe(2_500);

    for (const value of ['0', '-1', '1.5', 'abc', '999999']) {
      expect(
        () => readDbConfig({ DATABASE_URL: PASSWORD_BEARING_URL, ALIA_DB_STATEMENT_TIMEOUT_MS: value }),
        `${value} must be refused`,
      ).toThrow(AliaError);
    }
  });
});
