/**
 * Operator CLI: apply pending migrations to the configured database.
 *
 *   DATABASE_URL=postgres://... npm run db:migrate
 *
 * Runs as the migration/owner role from DATABASE_URL, which must be privileged
 * enough to create roles and tables. It never prints the connection string.
 *
 * Console output is intentional here: this is an operator tool, not a request
 * path (see the eslint override for scripts/).
 */

import path from 'node:path';

import { Client } from 'pg';

import { runMigrations } from '../src/lib/db/migrations.ts';

const DEFAULT_MIGRATIONS_DIR = path.join('supabase', 'migrations');

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('DATABASE_URL is not set. Nothing was applied.');
    return 1;
  }

  const directory = process.env.ALIA_MIGRATIONS_DIR?.trim() || path.resolve(process.cwd(), DEFAULT_MIGRATIONS_DIR);

  const client = new Client({ connectionString: url, application_name: 'alia-migrate' });
  await client.connect();
  try {
    const result = await runMigrations(client, directory);
    for (const version of result.applied) {
      console.log(`applied ${version}`);
    }
    console.log(
      `done: ${result.applied.length} applied, ${result.skipped.length} already present`,
    );
    return 0;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'migration failed');
    process.exit(1);
  },
);
