/**
 * Test database harness.
 *
 * The RLS proof needs a real PostgreSQL, not a mock: policies, forced RLS,
 * composite foreign keys, and role privileges are the behaviour under test.
 *
 * Two modes:
 * - `ALIA_TEST_DATABASE_URL` (or `DATABASE_URL`) is set: use that database. CI uses
 *   this with a Postgres service container.
 * - otherwise: start a local PostgreSQL 18 from the `embedded-postgres`
 *   devDependency. No Docker, no administrator rights, no paid infrastructure.
 *
 * The database is created fresh for a run: migrations are applied from
 * supabase/migrations, and the admin connection used here is the migration role
 * (`DATABASE_URL` in a real deployment). Request paths never use it; they run as
 * `alia_app` through a scoped login role that the harness creates only for tests, and
 * that login is deliberately unprivileged (no superuser, no BYPASSRLS, owns no table,
 * member of no privileged role) so the application-path guards can be exercised
 * against the same shape a deployment uses.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import { Client, Pool, type PoolClient } from 'pg';

import { runMigrations } from '@/lib/db/migrations';

/** The restricted role the application path enters with `set local role`. */
export const APP_ROLE = 'alia_app';

/** Test-only login role that is a member of APP_ROLE. Not used outside tests. */
export const APP_LOGIN_ROLE = 'alia_test_login';

export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase', 'migrations');

export interface TestDatabase {
  /** Superuser/owner connection. Seeding and privileged assertions only. */
  adminUrl: string;
  /** Restricted connection string an application process would be given. */
  appUrl: string;
  appRole: string;
  statementTimeoutMs: number;
  stop(): Promise<void>;
}

/** The serialisable subset handed to test files through vitest `provide`. */
export type ProvidedTestDatabase = Omit<TestDatabase, 'stop'>;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function createAdminClient(url: string): Promise<Client> {
  const client = new Client({ connectionString: url, application_name: 'alia-test-admin' });
  await client.connect();
  return client;
}

async function ensureAppLoginRole(client: Client, password: string): Promise<void> {
  const existing = await client.query('select 1 from pg_roles where rolname = $1', [APP_LOGIN_ROLE]);
  if (existing.rowCount === 0) {
    await client.query(
      `create role ${APP_LOGIN_ROLE} login password '${password}' nosuperuser nobypassrls nocreatedb nocreaterole`,
    );
  } else {
    await client.query(`alter role ${APP_LOGIN_ROLE} with login password '${password}'`);
  }
  await client.query(`grant ${APP_ROLE} to ${APP_LOGIN_ROLE}`);
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const externalUrl = process.env.ALIA_TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  const password = randomBytes(18).toString('hex');

  let server: EmbeddedPostgres | undefined;
  let databaseDir: string | undefined;
  let adminUrl: string;

  if (externalUrl) {
    adminUrl = externalUrl;
  } else {
    const port = await freePort();
    const superuserPassword = randomBytes(12).toString('hex');
    databaseDir = await mkdtemp(path.join(tmpdir(), 'alia-pg-'));
    // The data directory must be empty for initdb; mkdtemp gives us a unique path.
    await rm(databaseDir, { recursive: true, force: true });
    server = new EmbeddedPostgres({
      databaseDir,
      user: 'postgres',
      password: superuserPassword,
      port,
      persistent: false,
    });
    await server.initialise();
    await server.start();
    adminUrl = `postgres://postgres:${encodeURIComponent(superuserPassword)}@127.0.0.1:${port}/postgres`;
  }

  const admin = await createAdminClient(adminUrl);
  try {
    await runMigrations(admin, MIGRATIONS_DIR);
    await ensureAppLoginRole(admin, password);
  } finally {
    await admin.end();
  }

  const appUrl = (() => {
    const parsed = new URL(adminUrl);
    parsed.username = APP_LOGIN_ROLE;
    parsed.password = password;
    return parsed.toString();
  })();

  return {
    adminUrl,
    appUrl,
    appRole: APP_ROLE,
    statementTimeoutMs: 5_000,
    async stop(): Promise<void> {
      if (server) await server.stop();
      if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
    },
  };
}

/** Connection string with a `…://` scheme pg accepts from `new URL`. */
export function testRuntimeConfig(database: {
  appUrl: string;
  appRole: string;
  statementTimeoutMs: number;
}) {
  return {
    url: database.appUrl,
    appRole: database.appRole,
    statementTimeoutMs: database.statementTimeoutMs,
  };
}

export function createAppPool(database: { appUrl: string }): Pool {
  return new Pool({
    connectionString: database.appUrl,
    application_name: 'alia-test-app',
    max: 4,
  });
}

export interface Denial {
  denied: true;
  code?: string;
  message: string;
}

export interface PrincipalScope {
  userId: string;
  /**
   * Organization selected for the transaction. Omitted only for the pre-selection
   * step that discovers a principal's own memberships.
   */
  organizationId?: string;
}

/**
 * Run SQL exactly as the application path does: inside one transaction, as the
 * restricted role, with the verified claim and the selected organization. Always
 * rolled back, so an isolation test leaves nothing behind.
 */
export async function runAsPrincipal(
  pool: Pool,
  userId: string,
  sql: string,
  values: unknown[] = [],
  organizationId?: string,
): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await applyTestScope(client, { userId, organizationId });
    const result = await client.query(sql, values);
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

/**
 * Enter the request session inside an already-open transaction: the restricted role,
 * the verified claim, and the selected organization, in the same order and with the
 * same settings the application uses.
 */
export async function applyTestScope(
  client: PoolClient,
  scope: PrincipalScope,
): Promise<void> {
  await client.query(`set local role ${APP_ROLE}`);
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [scope.userId]);
  await client.query(`select set_config('app.organization_id', $1, true)`, [
    scope.organizationId ?? '',
  ]);
}

/**
 * Run a callback inside one request transaction and roll everything back. Gives a
 * test the raw client, so it can prove what happens when the callback leaves the
 * restricted role (`reset role`) or rewrites the settings the policies read.
 */
export async function withAppSession<T>(
  pool: Pool,
  scope: PrincipalScope,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await applyTestScope(client, scope);
    return await run(client);
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

/** Run mutating SQL as the application path inside a transaction that commits. */
export async function runAsPrincipalCommitted(
  pool: Pool,
  userId: string,
  sql: string,
  values: unknown[] = [],
  organizationId?: string,
): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await applyTestScope(client, { userId, organizationId });
    const result = await client.query(sql, values);
    await client.query('commit');
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function isDenied(value: unknown): value is Denial {
  return typeof value === 'object' && value !== null && (value as Denial).denied === true;
}

/** Capture a denial instead of failing the test, so the evidence can be asserted. */
export async function captureDenial(
  promise: Promise<unknown>,
): Promise<{ rows: Record<string, unknown>[]; rowCount: number } | Denial> {
  try {
    return (await promise) as { rows: Record<string, unknown>[]; rowCount: number };
  } catch (error) {
    const typed = error as { code?: string; message?: string };
    return { denied: true, code: typed.code, message: typed.message ?? 'denied' };
  }
}

export function newId(): string {
  return randomUUID();
}
