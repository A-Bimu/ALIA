import { describe, expect, it } from 'vitest';

import { buildHealthReport } from '@/modules/health/service';

const FAKE_SECRET = 'fake-secret-value-abcdefghijkl';

describe('health report builder', () => {
  it('is healthy with a bare environment and reports timing', () => {
    const report = buildHealthReport({
      traceId: 'alia_trace_0002',
      env: {},
      now: new Date('2026-09-23T12:00:00.000Z'),
      uptimeSeconds: 42.9,
    });

    expect(report.status).toBe('ok');
    expect(report.checks.config).toBe('ok');
    expect(report.pending_configuration).toEqual([]);
    expect(report.timestamp).toBe('2026-09-23T12:00:00.000Z');
    expect(report.uptime_seconds).toBe(42);
    expect(report.trace_id).toBe('alia_trace_0002');
  });

  it('degrades when configuration is invalid and lists key names only', () => {
    const report = buildHealthReport({
      traceId: 'alia_trace_0003',
      env: { SUPABASE_URL: 'not-a-url', SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET },
    });

    expect(report.status).toBe('degraded');
    expect(report.checks.config).toBe('incomplete');
    expect(report.pending_configuration).toEqual(['SUPABASE_URL']);
    expect(JSON.stringify(report)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(report)).not.toContain('not-a-url');
  });

  it('reports the declared environment without echoing other values', () => {
    const report = buildHealthReport({ traceId: 'alia_trace_0004', env: { ALIA_ENV: 'staging' } });

    expect(report.environment).toBe('staging');
    expect(report.version).toBe('0.1.0');
    expect(JSON.stringify(report)).not.toContain('supabase');
  });
});
