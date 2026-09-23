import { z } from 'zod';

import { AliaError } from '@/lib/errors';

/**
 * Typed environment contract for ALIA.
 *
 * Rules enforced here:
 * - every value is validated, not read ad hoc;
 * - a missing or invalid value fails closed with a typed error;
 * - error output names the offending key and never echoes the value;
 * - only the public allowlist below may ever reach a browser.
 */
export const ENV_SOURCE_KIND = 'server' as const;

/** Key names that must never be exposed to a browser or a public payload. */
export const SECRET_KEY_PATTERN =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DSN|CONNECTION_STRING)/i;

/** The only environment keys a browser may receive. */
export const PUBLIC_ENV_KEYS = ['NEXT_PUBLIC_ALIA_SERVICE_NAME'] as const;

const nonEmptyString = z.string().trim().min(1);
const positiveInt = z.coerce.number().int().positive();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ALIA_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  ALIA_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NEXT_PUBLIC_ALIA_SERVICE_NAME: nonEmptyString.default('ALIA'),

  // Server-only. Absent until the owning task wires it; presence is still validated.
  SUPABASE_URL: z.url().optional(),
  SUPABASE_ANON_KEY: nonEmptyString.optional(),
  SUPABASE_SERVICE_ROLE_KEY: nonEmptyString.optional(),

  MODEL_PROVIDER_BASE_URL: z.url().optional(),
  MODEL_PROVIDER_API_KEY: nonEmptyString.optional(),
  MODEL_SMALL_NAME: nonEmptyString.default('llama-3.1-8b-instruct'),
  MODEL_STRONG_NAME: nonEmptyString.default('llama-3.3-70b-instruct'),

  MODEL_REQUEST_TIMEOUT_MS: positiveInt.default(15_000),
  MODEL_MAX_INPUT_TOKENS: positiveInt.default(4_000),
  MODEL_MAX_OUTPUT_TOKENS: positiveInt.default(800),
});

export type AliaEnv = z.infer<typeof envSchema>;

export interface EnvIssue {
  /** Key name only. Never the value. */
  key: string;
  problem: string;
}

export interface EnvInspection {
  ok: boolean;
  issues: EnvIssue[];
}

type EnvSource = Record<string, string | undefined>;

function normalizeSource(source: EnvSource): EnvSource {
  const normalized: EnvSource = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    if (value === undefined) continue;
    normalized[key] = value;
  }
  return normalized;
}

/**
 * Remove any supplied value from a message so an invalid value can never be
 * echoed back through an error, a log line, or an HTTP response.
 */
function redactValues(message: string, source: EnvSource): string {
  let redacted = message;
  for (const value of Object.values(source)) {
    if (typeof value !== 'string' || value.length < 4) continue;
    redacted = redacted.split(value).join('[redacted]');
  }
  return redacted;
}

function issuesFrom(error: z.ZodError, source: EnvSource): EnvIssue[] {
  return error.issues.map((issue) => ({
    key: issue.path.join('.') || '(root)',
    problem: redactValues(issue.message, source),
  }));
}

/** Non-throwing inspection used by health checks and configuration reports. */
export function inspectEnv(source: EnvSource = process.env): EnvInspection {
  const normalized = normalizeSource(source);
  const result = envSchema.safeParse(normalized);
  if (result.success) return { ok: true, issues: [] };
  return { ok: false, issues: issuesFrom(result.error, normalized) };
}

/** Validated configuration. Throws a typed configuration error when invalid. */
export function loadEnv(source: EnvSource = process.env): AliaEnv {
  const normalized = normalizeSource(source);
  const result = envSchema.safeParse(normalized);
  if (result.success) return result.data;

  const issues = issuesFrom(result.error, normalized);
  throw new AliaError('CONFIGURATION_ERROR', {
    message: `Invalid configuration: ${issues
      .map((issue) => `${issue.key} (${issue.problem})`)
      .join('; ')}`,
  });
}

/** Memoised accessor for the running process environment. */
let cachedEnv: AliaEnv | undefined;

export function getEnv(): AliaEnv {
  cachedEnv ??= loadEnv(process.env);
  return cachedEnv;
}

/** Test and worker hook so a changed process environment is re-read. */
export function resetEnvCache(): void {
  cachedEnv = undefined;
}

/**
 * Server-only Supabase configuration. Normal request paths fail closed here
 * instead of falling back to a privileged credential.
 */
export function requireSupabaseServerConfig(
  source: EnvSource = process.env,
): { url: string; anonKey: string } {
  const normalized = normalizeSource(source);
  const url = normalized.SUPABASE_URL;
  const anonKey = normalized.SUPABASE_ANON_KEY;
  const missing = [url ? null : 'SUPABASE_URL', anonKey ? null : 'SUPABASE_ANON_KEY'].filter(
    (key): key is string => key !== null,
  );
  if (missing.length > 0) {
    throw new AliaError('CONFIGURATION_ERROR', {
      message: `Missing server configuration: ${missing.join(', ')}`,
    });
  }
  const parsed = envSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new AliaError('CONFIGURATION_ERROR', {
      message: `Invalid configuration: ${issuesFrom(parsed.error, normalized)
        .map((issue) => issue.key)
        .join(', ')}`,
    });
  }
  return { url: parsed.data.SUPABASE_URL as string, anonKey: parsed.data.SUPABASE_ANON_KEY as string };
}

/**
 * The browser-safe configuration slice. Built from an explicit allowlist, then
 * verified: no key may look like a secret and no value may come from the server
 * secret set.
 */
export function getPublicEnv(source: EnvSource = process.env): Readonly<{
  serviceName: string;
}> {
  for (const key of PUBLIC_ENV_KEYS) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new AliaError('CONFIGURATION_ERROR', {
        message: `Public key ${key} is not allowed in the browser allowlist`,
      });
    }
  }
  const parsed = loadEnv(source);
  return Object.freeze({
    serviceName: parsed.NEXT_PUBLIC_ALIA_SERVICE_NAME,
  });
}
