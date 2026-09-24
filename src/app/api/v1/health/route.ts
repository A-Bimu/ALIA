import { buildHealthReport } from '@/modules/health/service';
import { toLogSafeError, toPublicError } from '@/lib/errors';
import { jsonResponse } from '@/lib/http';
import { resolveTraceId } from '@/lib/trace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/health
 *
 * Liveness and configuration readiness only. No secret, credential, tenant
 * data, or dependency connection detail is returned.
 */
export async function GET(request: Request): Promise<Response> {
  const traceId = resolveTraceId(request.headers);

  try {
    const report = buildHealthReport({ traceId });
    return jsonResponse(report, { status: 200, traceId });
  } catch (error) {
    // toLogSafeError carries no message or payload; nothing sensitive is logged.
    void toLogSafeError(error, traceId);
    const { status, body } = toPublicError(error, traceId);
    return jsonResponse(body, { status, traceId });
  }
}
