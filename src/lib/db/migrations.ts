/**
 * Migration runner for the ALIA PostgreSQL schema.
 *
 * Kept free of application imports (only node: builtins) so both the operator CLI
 * (`npm run db:migrate`) and the test harness can execute it.
 *
 * Behaviour:
 * - migrations are plain SQL files applied in filename order;
 * - each applied file is recorded in `app.schema_migrations` with a sha256 checksum;
 * - a file whose content changed after it was applied is refused, so a shared
 *   database can never drift silently from the repository;
 * - a migration that fails rolls back completely.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Minimal shape needed from a pg client or pool. */
export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface MigrationFile {
  /** File name, for example `0001_foundation.sql`. */
  version: string;
  sql: string;
  checksum: string;
}

export interface MigrationRunResult {
  applied: string[];
  skipped: string[];
}

const MIGRATION_FILENAME_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export const LEDGER_SCHEMA = 'app';
export const LEDGER_TABLE = 'app.schema_migrations';

/** Line endings are normalised so a checksum is identical on Windows and CI. */
export function normalizeSql(sql: string): string {
  return sql.replace(/\r\n/g, '\n');
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(normalizeSql(sql), 'utf8').digest('hex');
}

/**
 * The ledger lives outside the tenant schema, is created by the migration role,
 * and is deliberately unreadable by the application role.
 */
export async function ensureLedger(client: MigrationClient): Promise<void> {
  await client.query(`create schema if not exists ${LEDGER_SCHEMA}`);
  await client.query(
    `create table if not exists ${LEDGER_TABLE} (
       version text primary key,
       checksum text not null,
       applied_at timestamptz not null default now()
     )`,
  );
  await client.query(`revoke all on table ${LEDGER_TABLE} from public`);
}

export async function listMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

  const files: MigrationFile[] = [];
  for (const version of entries) {
    if (!MIGRATION_FILENAME_PATTERN.test(version)) {
      throw new Error(
        `Migration ${version} does not match the required pattern NNNN_lower_snake_case.sql`,
      );
    }
    const sql = normalizeSql(await readFile(path.join(directory, version), 'utf8'));
    files.push({ version, sql, checksum: checksumOf(sql) });
  }
  return files;
}

/**
 * Apply every pending migration in order.
 *
 * Throws on: an unknown applied version, a checksum mismatch (applied content
 * changed in the repository), or a failing migration statement.
 */
export async function runMigrations(
  client: MigrationClient,
  directory: string,
): Promise<MigrationRunResult> {
  const files = await listMigrationFiles(directory);
  await ensureLedger(client);

  const ledger = await client.query(`select version, checksum from ${LEDGER_TABLE}`);
  const applied = new Map<string, string>();
  for (const row of ledger.rows) {
    applied.set(String(row.version), String(row.checksum));
  }

  const known = new Set(files.map((file) => file.version));
  for (const version of applied.keys()) {
    if (!known.has(version)) {
      throw new Error(
        `Database records migration ${version}, which is not present in ${directory}. Refusing to continue.`,
      );
    }
  }

  const result: MigrationRunResult = { applied: [], skipped: [] };

  for (const file of files) {
    const recorded = applied.get(file.version);
    if (recorded !== undefined) {
      if (recorded !== file.checksum) {
        throw new Error(
          `Migration ${file.version} changed after it was applied (checksum mismatch). Create a new migration instead of editing an applied one.`,
        );
      }
      result.skipped.push(file.version);
      continue;
    }

    await client.query('begin');
    try {
      await client.query(file.sql);
      await client.query(`insert into ${LEDGER_TABLE} (version, checksum) values ($1, $2)`, [
        file.version,
        file.checksum,
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${file.version} failed: ${cause}`);
    }
    result.applied.push(file.version);
  }

  return result;
}
