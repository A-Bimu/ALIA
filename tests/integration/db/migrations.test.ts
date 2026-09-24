/**
 * Migration engine behaviour: a clean database, checksum drift, a failing migration,
 * and the filename contract.
 *
 * Every case runs against its own scratch database on the same server, so "from a
 * clean database" is literal and one case cannot influence another.
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { Client } from 'pg';

import { runMigrations } from '@/lib/db/migrations';
import { MIGRATIONS_DIR, type ProvidedTestDatabase } from '../../support/test-database';

const database = inject('aliaTestDatabase') as ProvidedTestDatabase;

let root: Client;
const createdDatabases: string[] = [];

async function createScratchDatabase(label: string): Promise<Client> {
  const name = `alia_migrate_${label}_${randomBytes(4).toString('hex')}`;
  await root.query(`create database ${name}`);
  createdDatabases.push(name);

  const url = new URL(database.adminUrl);
  url.pathname = `/${name}`;
  const client = new Client({
    connectionString: url.toString(),
    application_name: `alia-migrate-${label}`,
  });
  await client.connect();
  return client;
}

/** Run a case against a private, empty database. */
async function withScratchDatabase(
  label: string,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const client = await createScratchDatabase(label);
  try {
    await run(client);
  } finally {
    await client.end();
  }
}

async function scratchDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'alia-migrations-'));
}

beforeAll(async () => {
  root = new Client({ connectionString: database.adminUrl, application_name: 'alia-migrations-root' });
  await root.connect();
});

afterAll(async () => {
  if (!root) return;
  for (const name of createdDatabases) {
    await root.query(`drop database if exists ${name} with (force)`);
  }
  await root.end();
});

describe('migration engine', () => {
  it('applies the repository migrations to a clean database in order', async () => {
    await withScratchDatabase('repo', async (client) => {
      const first = await runMigrations(client, MIGRATIONS_DIR);

      expect(first.applied).toEqual([
        '0001_foundation.sql',
        '0002_learning_data.sql',
        '0003_governed_memory_and_controls.sql',
      ]);
      expect(first.skipped).toEqual([]);

      const ledger = await client.query<{ version: string; checksum: string }>(
        'select version, checksum from app.schema_migrations order by version',
      );
      expect(ledger.rows.map((row) => row.version)).toEqual(first.applied);
      for (const row of ledger.rows) {
        expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      }

      // The schema that landed really does force RLS on every tenant table.
      const forced = await client.query<{ n: number }>(
        `select count(*)::int as n
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity`,
      );
      expect(Number(forced.rows[0]?.n)).toBe(11);
    });
  });

  it('is idempotent: a second run against the same clean database changes nothing', async () => {
    await withScratchDatabase('idempotent', async (client) => {
      await runMigrations(client, MIGRATIONS_DIR);

      const second = await runMigrations(client, MIGRATIONS_DIR);

      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual([
        '0001_foundation.sql',
        '0002_learning_data.sql',
        '0003_governed_memory_and_controls.sql',
      ]);
    });
  });

  it('refuses a migration that changed after it was applied', async () => {
    await withScratchDatabase('drift', async (client) => {
      const directory = await scratchDirectory();
      await writeFile(path.join(directory, '0001_first.sql'), 'create table public.probe_one (id int);\n');
      await writeFile(path.join(directory, '0002_second.sql'), 'create table public.probe_two (id int);\n');

      const applied = await runMigrations(client, directory);
      expect(applied.applied).toEqual(['0001_first.sql', '0002_second.sql']);

      await writeFile(
        path.join(directory, '0001_first.sql'),
        'create table public.probe_one (id int, extra text);\n',
      );

      await expect(runMigrations(client, directory)).rejects.toThrow(/changed after it was applied/);

      // The already-applied definition is untouched.
      const columns = await client.query<{ attname: string }>(
        `select a.attname
           from pg_attribute a
           join pg_class c on c.oid = a.attrelid
          where c.relname = 'probe_one' and a.attnum > 0 and not a.attisdropped
          order by a.attnum`,
      );
      expect(columns.rows.map((row) => row.attname)).toEqual(['id']);
    });
  });

  it('refuses a database that records a migration the directory does not contain', async () => {
    await withScratchDatabase('ghost', async (client) => {
      const directory = await scratchDirectory();
      await writeFile(path.join(directory, '0001_only.sql'), 'create table public.probe_only (id int);\n');
      await runMigrations(client, directory);

      await client.query(
        `insert into app.schema_migrations (version, checksum) values ('9999_ghost.sql', 'x')`,
      );

      await expect(runMigrations(client, directory)).rejects.toThrow(/not present in/);
    });
  });

  it('rolls a failing migration back completely and records nothing', async () => {
    await withScratchDatabase('broken', async (client) => {
      const directory = await scratchDirectory();
      await writeFile(
        path.join(directory, '0001_broken.sql'),
        'create table public.probe_partial (id int);\nselect * from public.table_that_does_not_exist;\n',
      );

      await expect(runMigrations(client, directory)).rejects.toThrow(/0001_broken.sql failed/);

      const table = await client.query<{ exists: boolean }>(
        `select exists (
           select 1 from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'probe_partial'
         ) as exists`,
      );
      expect(table.rows[0]?.exists).toBe(false);

      const ledger = await client.query(
        `select 1 from app.schema_migrations where version = '0001_broken.sql'`,
      );
      expect(ledger.rowCount).toBe(0);
    });
  });

  it('rejects a migration file name that would sort unpredictably', async () => {
    await withScratchDatabase('naming', async (client) => {
      const directory = await scratchDirectory();
      await writeFile(path.join(directory, 'add-something.sql'), 'select 1;\n');

      await expect(runMigrations(client, directory)).rejects.toThrow(/NNNN_lower_snake_case\.sql/);
    });
  });
});
