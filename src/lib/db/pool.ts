/**
 * Database configuration and connection pool for ALIA server code.
 *
 * Two credentials, deliberately separate:
 *
 * - `DATABASE_URL` is the migration/administrative connection. It owns the schema and
 *   is used by `npm run db:migrate` and by the test harness only. It is never handed
 *   to a request path.
 * - `ALIA_DB_REQUEST_URL` is the least-privileged login every normal tenant request
 *   connects with. It must be able to enter the restricted application role
 *   (`set local role alia_app`) and must not be a superuser, hold `BYPASSRLS`, own a
 *   tenant table, or be a member of a role that does.
 *
 * Rules enforced here (AGENTS.md, README "Non-negotiable boundaries"):
 * - neither connection string is ever logged or returned;
 * - the request connection refuses a privileged login name and refuses to reuse the
 *   migration/administrative credential;
 * - a missing or malformed value fails closed with a typed configuration error that
 *   names the offending key and never echoes the value.
 *
 * The live session is verified again in `src/lib/db/tenant.ts` before and after the
 * request work runs, because a URL alone cannot prove what the database granted.
 */

import { Pool } from 'pg';

import { AliaError } from '@/lib/errors';

/** The role every normal tenant request runs as. NOLOGIN and unprivileged. */
export const DEFAULT_DB_APP_ROLE = 'alia_app';

export const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

export const MAX_POOL_SIZE = 5;

/** Key holding the migration/administrative connection. Never a request credential. */
export const ADMIN_DB_URL_KEY = 'DATABASE_URL';

/** Key holding the dedicated least-privileged login used by tenant requests. */
export const REQUEST_DB_URL_KEY = 'ALIA_DB_REQUEST_URL';

const CONNECTION_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 10_000;

/**
 * Roles a tenant request must never run as. Listing them here turns "do not use a
 * service-role shortcut for normal requests" into a startup-time configuration
 * failure instead of a code-review promise.
 */
export const PRIVILEGED_ROLE_NAMES: ReadonlySet<string> = new Set([
  'postgres',
  'supabase_admin',
  'supabase_storage_admin',
  'supabase_auth_admin',
  'service_role',
  'authenticator',
  'admin',
  'rdsadmin',
  'cloud_admin',
  'azure_pg_admin',
]);

const ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\/[^\s]+$/;

export interface DbConfig {
  /** Server-only request connection string. Never log this value. */
  url: string;
  appRole: string;
  statementTimeoutMs: number;
}

function configurationError(message: string): AliaError {
  return new AliaError('CONFIGURATION_ERROR', { message });
}

type EnvSource = Record<string, string | undefined>;

function trimmed(source: EnvSource, key: string): string | undefined {
  const value = source[key]?.trim();
  return value ? value : undefined;
}

/**
 * Login role named by a connection string, or null when it cannot be determined.
 * Only the role name is inspected; the rest of the string is never reported.
 */
export function loginRoleOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const role = decodeURIComponent(parsed.username).trim();
    return role.length > 0 ? role : null;
  } catch {
    return null;
  }
}

/**
 * Read and validate the request-path configuration. Key names only in any error: the
 * connection string and the login role never appear in a message, a log, or a response.
 */
export function readDbConfig(source: EnvSource = process.env): DbConfig {
  const url = trimmed(source, REQUEST_DB_URL_KEY);
  if (!url) {
    throw configurationError(`Missing server configuration: ${REQUEST_DB_URL_KEY}`);
  }
  if (!POSTGRES_URL_PATTERN.test(url)) {
    throw configurationError(
      `Invalid configuration: ${REQUEST_DB_URL_KEY} (must be a postgres:// connection string)`,
    );
  }

  const appRole = trimmed(source, 'ALIA_DB_APP_ROLE') ?? DEFAULT_DB_APP_ROLE;
  if (!ROLE_NAME_PATTERN.test(appRole)) {
    throw configurationError('Invalid configuration: ALIA_DB_APP_ROLE (must be a lowercase role name)');
  }
  if (PRIVILEGED_ROLE_NAMES.has(appRole)) {
    throw configurationError(
      'Invalid configuration: ALIA_DB_APP_ROLE (a privileged role may not serve tenant requests)',
    );
  }

  // The connection the request path uses must be a dedicated least-privileged login.
  const loginRole = loginRoleOf(url);
  if (loginRole === null) {
    throw configurationError(
      `Invalid configuration: ${REQUEST_DB_URL_KEY} (must name a dedicated login role)`,
    );
  }
  if (PRIVILEGED_ROLE_NAMES.has(loginRole)) {
    throw configurationError(
      `Invalid configuration: ${REQUEST_DB_URL_KEY} (a privileged or administrative login may not serve tenant requests)`,
    );
  }
  if (loginRole === appRole) {
    throw configurationError(
      `Invalid configuration: ${REQUEST_DB_URL_KEY} (the application role is NOLOGIN; connect with a dedicated login instead)`,
    );
  }

  // The request credential must not be the migration/administrative credential.
  const adminUrl = trimmed(source, ADMIN_DB_URL_KEY);
  if (adminUrl !== undefined) {
    const adminLoginRole = loginRoleOf(adminUrl);
    if (adminUrl === url || (adminLoginRole !== null && adminLoginRole === loginRole)) {
      throw configurationError(
        `Invalid configuration: ${REQUEST_DB_URL_KEY} (must not be the migration or administrative connection)`,
      );
    }
  }

  const rawTimeout = trimmed(source, 'ALIA_DB_STATEMENT_TIMEOUT_MS');
  let statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 120_000) {
      throw configurationError(
        'Invalid configuration: ALIA_DB_STATEMENT_TIMEOUT_MS (must be an integer between 1 and 120000)',
      );
    }
    statementTimeoutMs = parsed;
  }

  return { url, appRole, statementTimeoutMs };
}

/**
 * Read the migration/administrative connection. Only `npm run db:migrate` and the
 * test harness may use it; no request path accepts this value.
 */
export function readAdminDbConfig(source: EnvSource = process.env): { url: string } {
  const url = trimmed(source, ADMIN_DB_URL_KEY);
  if (!url) {
    throw configurationError(`Missing server configuration: ${ADMIN_DB_URL_KEY}`);
  }
  if (!POSTGRES_URL_PATTERN.test(url)) {
    throw configurationError(
      `Invalid configuration: ${ADMIN_DB_URL_KEY} (must be a postgres:// connection string)`,
    );
  }
  return { url };
}

export function createPool(config: DbConfig): Pool {
  return new Pool({
    connectionString: config.url,
    application_name: 'alia',
    max: MAX_POOL_SIZE,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });
}

let sharedPool: Pool | undefined;

/** Memoised pool for the running process. */
export function getPool(): Pool {
  sharedPool ??= createPool(readDbConfig());
  return sharedPool;
}

export async function closePool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = undefined;
  if (pool) await pool.end();
}