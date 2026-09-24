/**
 * Database configuration contract.
 *
 * Two rules are enforced here as configuration validation, so they fail at startup
 * rather than at review time:
 * - the request path must use a dedicated least-privileged login, never a privileged
 *   or administrative one (no service-role shortcut);
 * - the request connection must not be the migration/administrative `DATABASE_URL`.
 */

import { describe, expect, it } from 'vitest';

import { AliaError } from '@/lib/errors';
import {
  ADMIN_DB_URL_KEY,
  DEFAULT_DB_APP_ROLE,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  loginRoleOf,
  MAX_POOL_SIZE,
  PRIVILEGED_ROLE_NAMES,
  readAdminDbConfig,
  readDbConfig,
  REQUEST_DB_URL_KEY,
} from '@/lib/db/pool';

const REQUEST_URL = 'postgres://alia_request:pw@db.example.test:5432/postgres';
const ADMIN_URL = 'postgres://alia_owner:pw@db.example.test:5432/postgres';

function requestSource(overrides: Record<string, string | undefined> = {}) {
  return { [REQUEST_DB_URL_KEY]: REQUEST_URL, ...overrides };
}

describe('readDbConfig', () => {
  it('fails closed when the request connection is absent, naming the key only', () => {
    try {
      readDbConfig({});
      expect.unreachable('a missing request connection must fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(AliaError);
      const typed = error as AliaError;
      expect(typed.code).toBe('CONFIGURATION_ERROR');
      expect(typed.message).toContain(REQUEST_DB_URL_KEY);
      expect(typed.message).not.toContain('postgres://');
    }
  });

  it('does not accept the migration/administrative key as the request connection', () => {
    try {
      readDbConfig({ [ADMIN_DB_URL_KEY]: ADMIN_URL });
      expect.unreachable('DATABASE_URL must not be usable as the request connection');
    } catch (error) {
      const typed = error as AliaError;
      expect(typed.code).toBe('CONFIGURATION_ERROR');
      expect(typed.message).toContain(REQUEST_DB_URL_KEY);
      expect(typed.message).not.toContain(ADMIN_DB_URL_KEY);
    }
  });

  it('treats an empty value as unset', () => {
    expect(() => readDbConfig({ [REQUEST_DB_URL_KEY]: '   ' })).toThrow(AliaError);
  });

  it('refuses a connection string that is not a postgres URL, without echoing it', () => {
    try {
      readDbConfig({ [REQUEST_DB_URL_KEY]: 'mysql://user:pw@host:3306/db' });
      expect.unreachable('a non-postgres scheme must be refused');
    } catch (error) {
      const typed = error as AliaError;
      expect(typed.code).toBe('CONFIGURATION_ERROR');
      expect(typed.message).toContain(REQUEST_DB_URL_KEY);
      expect(typed.message).not.toContain('mysql://');
      expect(typed.message).not.toContain('pw@host');
    }
  });

  it('accepts a postgres URL and applies documented defaults', () => {
    const config = readDbConfig(requestSource());

    expect(config.url).toBe(REQUEST_URL);
    expect(config.appRole).toBe(DEFAULT_DB_APP_ROLE);
    expect(config.statementTimeoutMs).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(MAX_POOL_SIZE).toBeGreaterThan(0);
  });

  it('refuses every privileged role as the request role, without echoing the name', () => {
    for (const role of PRIVILEGED_ROLE_NAMES) {
      try {
        readDbConfig(requestSource({ ALIA_DB_APP_ROLE: role }));
        expect.unreachable(`${role} must not be usable as the tenant request role`);
      } catch (error) {
        const typed = error as AliaError;
        expect(typed.code).toBe('CONFIGURATION_ERROR');
        expect(typed.message).toContain('privileged role');
        expect(typed.message).not.toContain(role);
      }
    }
  });

  it('refuses every privileged role as the login behind the request connection', () => {
    for (const role of PRIVILEGED_ROLE_NAMES) {
      const url = `postgres://${role}:pw@db.example.test:5432/postgres`;
      try {
        readDbConfig({ [REQUEST_DB_URL_KEY]: url });
        expect.unreachable(`${role} must not be the login of the request connection`);
      } catch (error) {
        const typed = error as AliaError;
        expect(typed.code).toBe('CONFIGURATION_ERROR');
        expect(typed.message).toContain(REQUEST_DB_URL_KEY);
        expect(typed.message).not.toContain(url);
        expect(typed.message).not.toContain(`://${role}:`);
      }
    }
  });

  it('refuses a connection string that names no login role', () => {
    expect(() => readDbConfig({ [REQUEST_DB_URL_KEY]: 'postgres://db.example.test:5432/postgres' })).toThrow(
      AliaError,
    );
  });

  it('refuses to connect as the application role itself, which cannot log in', () => {
    try {
      readDbConfig({
        [REQUEST_DB_URL_KEY]: `postgres://${DEFAULT_DB_APP_ROLE}:pw@db.example.test:5432/postgres`,
      });
      expect.unreachable('the application role is NOLOGIN and must not be a login');
    } catch (error) {
      const typed = error as AliaError;
      expect(typed.code).toBe('CONFIGURATION_ERROR');
      expect(typed.message).toContain(REQUEST_DB_URL_KEY);
    }
  });

  it('refuses to reuse the migration/administrative connection for requests', () => {
    // Same string, and the same login behind two different strings.
    const reuses = [
      { [REQUEST_DB_URL_KEY]: ADMIN_URL, [ADMIN_DB_URL_KEY]: ADMIN_URL },
      {
        [REQUEST_DB_URL_KEY]: 'postgres://alia_owner:pw@db.example.test:5432/postgres?sslmode=require',
        [ADMIN_DB_URL_KEY]: ADMIN_URL,
      },
    ];

    for (const source of reuses) {
      try {
        readDbConfig(source);
        expect.unreachable('the request connection must not be the administrative one');
      } catch (error) {
        const typed = error as AliaError;
        expect(typed.code).toBe('CONFIGURATION_ERROR');
        expect(typed.message).toContain('administrative');
        expect(typed.message).not.toContain('alia_owner');
        expect(typed.message).not.toContain(ADMIN_URL);
      }
    }
  });

  it('accepts a request login that is distinct from the administrative login', () => {
    const config = readDbConfig({
      [REQUEST_DB_URL_KEY]: REQUEST_URL,
      [ADMIN_DB_URL_KEY]: ADMIN_URL,
    });
    expect(config.url).toBe(REQUEST_URL);
    expect(loginRoleOf(config.url)).not.toBe(loginRoleOf(ADMIN_URL));
  });

  it('refuses a malformed role name', () => {
    for (const role of ['Alia App', 'alia-app', '1alia', 'alia"app', '']) {
      if (role === '') {
        // An empty value falls back to the default, which is valid.
        expect(readDbConfig(requestSource({ ALIA_DB_APP_ROLE: role })).appRole).toBe(
          DEFAULT_DB_APP_ROLE,
        );
        continue;
      }
      expect(() => readDbConfig(requestSource({ ALIA_DB_APP_ROLE: role }))).toThrow(AliaError);
    }
  });

  it('accepts a custom restricted role', () => {
    const config = readDbConfig(requestSource({ ALIA_DB_APP_ROLE: 'alia_reader' }));
    expect(config.appRole).toBe('alia_reader');
  });

  it('validates the statement timeout', () => {
    expect(
      readDbConfig(requestSource({ ALIA_DB_STATEMENT_TIMEOUT_MS: '2500' })).statementTimeoutMs,
    ).toBe(2_500);

    for (const value of ['0', '-1', '1.5', 'abc', '999999']) {
      expect(
        () => readDbConfig(requestSource({ ALIA_DB_STATEMENT_TIMEOUT_MS: value })),
        `${value} must be refused`,
      ).toThrow(AliaError);
    }
  });
});

describe('readAdminDbConfig', () => {
  it('requires DATABASE_URL and names the key only', () => {
    try {
      readAdminDbConfig({});
      expect.unreachable('a missing DATABASE_URL must fail closed');
    } catch (error) {
      const typed = error as AliaError;
      expect(typed.code).toBe('CONFIGURATION_ERROR');
      expect(typed.message).toContain(ADMIN_DB_URL_KEY);
    }
  });

  it('accepts the migration connection and refuses a non-postgres scheme', () => {
    expect(readAdminDbConfig({ [ADMIN_DB_URL_KEY]: ADMIN_URL }).url).toBe(ADMIN_URL);
    expect(() => readAdminDbConfig({ [ADMIN_DB_URL_KEY]: 'mysql://user:pw@host:3306/db' })).toThrow(
      AliaError,
    );
  });

  it('is a different key from the request connection', () => {
    expect(ADMIN_DB_URL_KEY).not.toBe(REQUEST_DB_URL_KEY);
  });
});

describe('loginRoleOf', () => {
  it('reads the login role and never the rest of the string', () => {
    expect(loginRoleOf(REQUEST_URL)).toBe('alia_request');
    expect(loginRoleOf('postgres://alia_request@db.example.test:5432/postgres')).toBe('alia_request');
    expect(loginRoleOf('postgres://db.example.test:5432/postgres')).toBeNull();
    expect(loginRoleOf('not a url')).toBeNull();
  });
});
