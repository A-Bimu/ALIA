import { describe, expect, it } from 'vitest';

import {
  PUBLIC_ENV_KEYS,
  SECRET_KEY_PATTERN,
  getPublicEnv,
  inspectEnv,
  loadEnv,
  requireSupabaseServerConfig,
} from '@/config/env';
import { AliaError, isAliaError } from '@/lib/errors';

const FAKE_SECRET = 'fake-service-role-secret-value-1234567890';

describe('typed environment contract', () => {
  it('parses a bare environment from defaults without requiring credentials', () => {
    const env = loadEnv({});

    expect(env.NODE_ENV).toBe('development');
    expect(env.ALIA_ENV).toBe('local');
    expect(env.ALIA_LOG_LEVEL).toBe('info');
    expect(env.MODEL_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(env.MODEL_MAX_INPUT_TOKENS).toBe(4_000);
    expect(env.MODEL_MAX_OUTPUT_TOKENS).toBe(800);
    expect(env.SUPABASE_URL).toBeUndefined();
  });

  it('treats an empty string as unset instead of as a configured value', () => {
    const env = loadEnv({ SUPABASE_URL: '   ', SUPABASE_ANON_KEY: '' });

    expect(env.SUPABASE_URL).toBeUndefined();
    expect(env.SUPABASE_ANON_KEY).toBeUndefined();
  });

  it('coerces numeric limits and rejects non-positive values', () => {
    expect(loadEnv({ MODEL_REQUEST_TIMEOUT_MS: '2500' }).MODEL_REQUEST_TIMEOUT_MS).toBe(2500);
    expect(loadEnv({ MODEL_MAX_OUTPUT_TOKENS: '512' }).MODEL_MAX_OUTPUT_TOKENS).toBe(512);

    const bad = inspectEnv({ MODEL_MAX_OUTPUT_TOKENS: '0' });
    expect(bad.ok).toBe(false);
    expect(bad.issues.map((issue) => issue.key)).toContain('MODEL_MAX_OUTPUT_TOKENS');
  });

  it('rejects an unknown log level and an malformed Supabase URL', () => {
    const logLevel = inspectEnv({ ALIA_LOG_LEVEL: 'verbose' });
    expect(logLevel.ok).toBe(false);
    expect(logLevel.issues[0]?.key).toBe('ALIA_LOG_LEVEL');

    const url = inspectEnv({ SUPABASE_URL: 'not-a-url' });
    expect(url.ok).toBe(false);
    expect(url.issues[0]?.key).toBe('SUPABASE_URL');
  });

  it('fails closed with a typed configuration error and never echoes the value', () => {
    let thrown: unknown;
    try {
      loadEnv({ SUPABASE_URL: 'not-a-url', SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET });
    } catch (error) {
      thrown = error;
    }

    expect(isAliaError(thrown)).toBe(true);
    const aliaError = thrown as AliaError;
    expect(aliaError.code).toBe('CONFIGURATION_ERROR');
    expect(aliaError.httpStatus).toBe(500);
    expect(aliaError.message).toContain('SUPABASE_URL');
    expect(aliaError.message).not.toContain(FAKE_SECRET);
    expect(aliaError.message).not.toContain('not-a-url');
  });

  it('reports issue keys without values from the non-throwing inspector', () => {
    const inspection = inspectEnv({ ALIA_LOG_LEVEL: 'verbose', SUPABASE_URL: FAKE_SECRET });

    expect(inspection.ok).toBe(false);
    const serialized = JSON.stringify(inspection);
    expect(serialized).toContain('ALIA_LOG_LEVEL');
    expect(serialized).not.toContain(FAKE_SECRET);
    expect(serialized).not.toContain('verbose');
  });

  it('requires Supabase configuration for server data paths', () => {
    expect(requireSupabaseServerConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' })).toEqual({
      url: 'https://example.supabase.co',
      anonKey: 'anon',
    });

    expect(() => requireSupabaseServerConfig({})).toThrowError(/SUPABASE_URL, SUPABASE_ANON_KEY/);
  });

  it('exposes only an allowlisted, secret-free public slice', () => {
    expect(PUBLIC_ENV_KEYS.every((key) => !SECRET_KEY_PATTERN.test(key))).toBe(true);

    const publicEnv = getPublicEnv({
      SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET,
      MODEL_PROVIDER_API_KEY: FAKE_SECRET,
    });

    expect(Object.isFrozen(publicEnv)).toBe(true);
    expect(Object.keys(publicEnv).every((key) => !SECRET_KEY_PATTERN.test(key))).toBe(true);
    expect(JSON.stringify(publicEnv)).not.toContain(FAKE_SECRET);
  });
});
