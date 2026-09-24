/**
 * Database configuration and connection pool for ALIA server code.
 *
 * Rules enforced here (AGENTS.md, README "Non-negotiable boundaries"):
 * - the connection string is server-only and is never logged or returned;
 * - the tenant request path must enter the restricted application role, so a
 *   privileged role name (a service role, a database superuser) is refused as
 *   configuration before any query runs;
 * - a missing or malformed value fails closed with a typed configuration error
 *   that names the offending key and never echoes the value.
 */

import { Pool } from 'pg';

import { AliaError } from '@/lib/errors';

/** The role every normal tenant request runs as. NOLOGIN and unprivileged. */
export const DEFAULT_DB_APP_ROLE = 'alia_app';

export const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

export const MAX_POOL_SIZE = 5;

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
  /** Server-only connection string. Never log this value. */
  url: string;
  appRole: string;
  statementTimeoutMs: number;
}

function configurationError(message: string): AliaError {
  return new AliaError('CONFIGURATION_ERROR', { message });
}

type EnvSource = Record<string, string | undefined>;

/**
 * Read and validate the database configuration. Key names only in any error:
 * the connection string never appears in a message, a log, or a response.
 */
export function readDbConfig(source: EnvSource = process.env): DbConfig {
  const url = source.DATABASE_URL?.trim();
  if (!url) {
    throw configurationError('Missing server configuration: DATABASE_URL');
  }
  if (!POSTGRES_URL_PATTERN.test(url)) {
    throw configurationError('Invalid configuration: DATABASE_URL (must be a postgres:// connection string)');
  }

  const appRole = source.ALIA_DB_APP_ROLE?.trim() || DEFAULT_DB_APP_ROLE;
  if (!ROLE_NAME_PATTERN.test(appRole)) {
    throw configurationError('Invalid configuration: ALIA_DB_APP_ROLE (must be a lowercase role name)');
  }
  if (PRIVILEGED_ROLE_NAMES.has(appRole)) {
    throw configurationError(
      'Invalid configuration: ALIA_DB_APP_ROLE (a privileged role may not serve tenant requests)',
    );
  }

  const rawTimeout = source.ALIA_DB_STATEMENT_TIMEOUT_MS?.trim();
  let statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS;
  if (rawTimeout) {
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
