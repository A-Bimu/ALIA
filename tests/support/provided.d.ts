/**
 * Types the values provided by tests/global-setup.ts so `inject('aliaTestDatabase')`
 * is typed in every test file.
 */

import type { ProvidedTestDatabase } from './test-database';

declare module 'vitest' {
  interface ProvidedContext {
    aliaTestDatabase: ProvidedTestDatabase;
  }
}
