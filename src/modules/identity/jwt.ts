/**
 * Access-token verification for ALIA.
 *
 * A partner backend presents a Supabase-compatible JWT. ALIA verifies it here and
 * derives the principal from the verified `sub` claim only. Nothing in the token
 * decides tenant access: the organization comes from a membership row read inside
 * an RLS-scoped transaction (see ./principal.ts).
 *
 * Deliberate refusals:
 * - any algorithm other than HS256 (no `alg: none`, no key confusion);
 * - a token without a numeric `exp` (an unexpiring token is never accepted);
 * - a non-UUID `sub`;
 * - a token that carries a privileged role claim (a leaked Supabase service key is
 *   signed with the same legacy symmetric secret, so it must not be usable as a
 *   partner principal).
 */

import { jwtVerify } from 'jose';

import { AliaError } from '@/lib/errors';

export const MAX_TOKEN_LENGTH = 8_192;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Role claims that must never authenticate a partner request. */
export const PRIVILEGED_TOKEN_ROLES: ReadonlySet<string> = new Set([
  'service_role',
  'supabase_admin',
  'supabase_storage_admin',
  'supabase_auth_admin',
  'postgres',
  'anon',
]);

const POSTGRES_ROLE_CLAIM_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export interface JwtConfig {
  /** Server-only symmetric secret. Never logged, never returned. */
  secret: string;
  issuer?: string;
  audience?: string;
}

export interface VerifiedToken {
  userId: string;
  /** Unix seconds. Always present: an unexpiring token is refused. */
  expiresAt: number;
}

function unauthenticated(cause?: unknown): AliaError {
  return new AliaError('UNAUTHENTICATED', {
    message: 'Authentication is required.',
    ...(cause === undefined ? {} : { cause }),
  });
}

type EnvSource = Record<string, string | undefined>;

/** Read the token-verification configuration; fails closed when it is absent. */
export function readJwtConfig(source: EnvSource = process.env): JwtConfig {
  const secret = source.SUPABASE_JWT_SECRET?.trim();
  if (!secret) {
    throw new AliaError('CONFIGURATION_ERROR', {
      message: 'Missing server configuration: SUPABASE_JWT_SECRET',
    });
  }
  const issuer = source.SUPABASE_JWT_ISSUER?.trim();
  const audience = source.SUPABASE_JWT_AUDIENCE?.trim();
  return {
    secret,
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
  };
}

/**
 * Extract a bearer token from an Authorization header. Returns null when no usable
 * bearer credential is present; a malformed header is never partially honoured.
 */
export function extractBearerToken(headerValue: string | null | undefined): string | null {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return null;

  const separator = trimmed.indexOf(' ');
  if (separator === -1) return null;

  const scheme = trimmed.slice(0, separator).toLowerCase();
  if (scheme !== 'bearer') return null;

  const token = trimmed.slice(separator + 1).trim();
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  return token;
}

/** Verify an access token and return the authenticated principal id. */
export async function verifyAccessToken(token: string, config: JwtConfig): Promise<VerifiedToken> {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw unauthenticated();
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(config.secret), {
      algorithms: ['HS256'],
      clockTolerance: 0,
      ...(config.issuer ? { issuer: config.issuer } : {}),
      ...(config.audience ? { audience: config.audience } : {}),
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    throw unauthenticated(error);
  }

  const subject = payload.sub;
  if (typeof subject !== 'string' || !UUID_PATTERN.test(subject)) {
    throw unauthenticated();
  }

  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw unauthenticated();
  }

  const roleClaim = payload.role;
  if (typeof roleClaim === 'string' && PRIVILEGED_TOKEN_ROLES.has(roleClaim)) {
    throw unauthenticated();
  }
  if (typeof roleClaim === 'string' && !POSTGRES_ROLE_CLAIM_PATTERN.test(roleClaim)) {
    throw unauthenticated();
  }

  return { userId: subject.toLowerCase(), expiresAt: payload.exp };
}
