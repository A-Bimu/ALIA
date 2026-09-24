import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { GET, dynamic, runtime } from '@/app/api/v1/health/route';
import { SECRET_KEY_PATTERN } from '@/config/env';
import { PROTECTED_RESPONSE_HEADERS } from '@/lib/http';
import { TRACE_HEADER } from '@/lib/trace';

const FAKE_SERVICE_ROLE = 'fake-service-role-key-do-not-log-0123456789';
const FAKE_PROVIDER_KEY = 'fake-provider-key-do-not-log-9876543210';
const HOSTILE_ENV_VALUE = 'postgres://user:fake-password-value@host:5432/db';

const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('alia'),
  api_version: z.literal('v1'),
  environment: z.string().min(1),
  version: z.string().min(1),
  uptime_seconds: z.number().int().nonnegative(),
  timestamp: z.string(),
  trace_id: z.string().min(1),
  checks: z.object({ config: z.enum(['ok', 'incomplete']) }),
  pending_configuration: z.array(z.string()),
});

/**
 * The platform Headers implementation refuses control characters, so a hostile
 * inbound value is delivered through a Headers-shaped stand-in, exactly as a raw
 * transport value would reach the handler.
 */
function hostileHeaders(values: Record<string, string>): Headers {
  return {
    get: (name: string) => values[name.toLowerCase()] ?? null,
  } as unknown as Headers;
}

async function callHealth(headers?: Headers | Record<string, string>) {
  const requestHeaders = headers instanceof Headers ? headers : new Headers(headers);
  const request = { headers: requestHeaders } as Request;
  const response = await GET(request);
  return { response, body: await response.json() };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/v1/health', () => {
  it('is a node runtime, uncached route handler', () => {
    expect(runtime).toBe('nodejs');
    expect(dynamic).toBe('force-dynamic');
  });

  it('returns a typed healthy response without sensitive data', async () => {
    const { response, body } = await callHealth();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(healthSchema.safeParse(body).success).toBe(true);
    expect(body.service).toBe('alia');
    expect(body.api_version).toBe('v1');
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('echoes a safe inbound trace id in both the header and the body', async () => {
    const { response, body } = await callHealth({ [TRACE_HEADER]: 'partner-trace-0001' });

    expect(response.headers.get(TRACE_HEADER)).toBe('partner-trace-0001');
    expect(body.trace_id).toBe('partner-trace-0001');
  });

  it('replaces an unsafe inbound trace id', async () => {
    const { response, body } = await callHealth(
      hostileHeaders({ [TRACE_HEADER]: 'bad\r\nx-injected: 1' }),
    );

    expect(response.headers.get(TRACE_HEADER)).not.toContain('\n');
    expect(body.trace_id).toMatch(/^alia_/);
  });

  it('never sets a protected header more than once', async () => {
    const { response } = await callHealth({ [TRACE_HEADER]: 'partner-trace-0002' });
    const names = [...response.headers.keys()].map((name) => name.toLowerCase());

    for (const protectedName of PROTECTED_RESPONSE_HEADERS) {
      expect(names.filter((name) => name === protectedName.toLowerCase())).toHaveLength(1);
    }
  });

  it('never exposes credentials or a secret-shaped key even when configured', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_ANON_KEY', 'fake-anon');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', FAKE_SERVICE_ROLE);
    vi.stubEnv('MODEL_PROVIDER_API_KEY', FAKE_PROVIDER_KEY);

    const { response, body } = await callHealth();
    const serialized = `${JSON.stringify(body)}${JSON.stringify([...response.headers])}`;

    expect(response.status).toBe(200);
    expect(serialized).not.toContain(FAKE_SERVICE_ROLE);
    expect(serialized).not.toContain(FAKE_PROVIDER_KEY);
    expect(serialized).not.toContain('example.supabase.co');
    expect(Object.keys(body).every((key) => !SECRET_KEY_PATTERN.test(key))).toBe(true);
  });

  it('never echoes an invalid environment value in the body or the headers', async () => {
    vi.stubEnv('ALIA_ENV', HOSTILE_ENV_VALUE);

    const { response, body } = await callHealth();
    const serialized = `${JSON.stringify(body)}${JSON.stringify([...response.headers])}`;

    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks.config).toBe('incomplete');
    expect(body.environment).toBe('unknown');
    expect(body.pending_configuration).toEqual(['ALIA_ENV']);
    expect(healthSchema.safeParse(body).success).toBe(true);
    expect(serialized).not.toContain(HOSTILE_ENV_VALUE);
    expect(serialized).not.toContain('fake-password-value');
  });

  it('reports incomplete configuration by key name only', async () => {
    vi.stubEnv('ALIA_LOG_LEVEL', 'verbose');

    const { response, body } = await callHealth();

    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks.config).toBe('incomplete');
    expect(body.pending_configuration).toEqual(['ALIA_LOG_LEVEL']);
    expect(JSON.stringify(body)).not.toContain('verbose');
  });
});
