import { inspectEnv } from '@/config/env';
import { API_VERSION, SERVICE_NAME, SERVICE_VERSION } from '@/config/service';

export { API_VERSION, SERVICE_NAME, SERVICE_VERSION };

export interface HealthReport {
  status: 'ok' | 'degraded';
  service: typeof SERVICE_NAME;
  api_version: typeof API_VERSION;
  environment: string;
  version: string;
  uptime_seconds: number;
  timestamp: string;
  trace_id: string;
  checks: {
    /** Configuration is validated without disclosing any value. */
    config: 'ok' | 'incomplete';
  };
  /** Names of configuration keys still required by later tasks. Never values. */
  pending_configuration: string[];
}

export interface HealthReportOptions {
  traceId: string;
  env?: Record<string, string | undefined>;
  now?: Date;
  uptimeSeconds?: number;
}

/**
 * Build the health payload. It contains no secret, credential, connection
 * string, or tenant row: only service identity, timing, and the names of
 * configuration keys that are currently unset.
 */
export function buildHealthReport(options: HealthReportOptions): HealthReport {
  const source = options.env ?? process.env;
  const inspection = inspectEnv(source);
  const pending = inspection.issues.map((issue) => issue.key).sort();

  return {
    status: inspection.ok ? 'ok' : 'degraded',
    service: SERVICE_NAME,
    api_version: API_VERSION,
    environment: source.ALIA_ENV?.trim() || 'local',
    version: SERVICE_VERSION,
    uptime_seconds: Math.max(0, Math.floor(options.uptimeSeconds ?? process.uptime())),
    timestamp: (options.now ?? new Date()).toISOString(),
    trace_id: options.traceId,
    checks: { config: inspection.ok ? 'ok' : 'incomplete' },
    pending_configuration: pending,
  };
}
