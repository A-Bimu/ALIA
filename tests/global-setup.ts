/**
 * Vitest global setup: bring up one PostgreSQL for the whole run, apply the
 * migrations, and hand the connection strings to the test files.
 *
 * The database is started once per run (and reused by every worker) because
 * starting PostgreSQL is the expensive part; each test still runs inside its own
 * rolled-back transaction.
 */

import {
  startTestDatabase,
  type ProvidedTestDatabase,
} from './support/test-database';

interface GlobalSetupProject {
  provide(key: string, value: unknown): void;
}

export default async function setup(project: GlobalSetupProject): Promise<() => Promise<void>> {
  const database = await startTestDatabase();

  const payload: ProvidedTestDatabase = {
    adminUrl: database.adminUrl,
    appUrl: database.appUrl,
    appRole: database.appRole,
    statementTimeoutMs: database.statementTimeoutMs,
  };
  project.provide('aliaTestDatabase', payload);

  return async () => {
    await database.stop();
  };
}
