/**
 * Access-token helpers for tests. The secret is a literal test value: it is never a
 * real credential and never leaves the test process.
 */

import { SignJWT } from 'jose';

export const TEST_JWT_SECRET = 'alia-test-only-jwt-secret-do-not-use-0000000000';

export const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111';

export interface MintOptions {
  secret?: string;
  role?: string;
  /** Seconds since epoch. Pass null to mint a token with no expiry claim. */
  expiresInSeconds?: number | null;
  issuer?: string;
  audience?: string;
  subject?: unknown;
}

/** Mint an HS256 token shaped like a Supabase access token. */
export async function mintToken(options: MintOptions = {}): Promise<string> {
  const secret = options.secret ?? TEST_JWT_SECRET;
  const subject = 'subject' in options ? options.subject : TEST_TENANT_ID;

  let token = new SignJWT({ role: options.role ?? 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt();

  if (typeof subject === 'string') {
    token = token.setSubject(subject);
  } else if (subject !== undefined && subject !== null) {
    token = token.setSubject(String(subject));
  }

  if (options.expiresInSeconds !== null) {
    token = token.setExpirationTime(
      Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 3_600),
    );
  }
  if (options.issuer) token = token.setIssuer(options.issuer);
  if (options.audience) token = token.setAudience(options.audience);

  return token.sign(new TextEncoder().encode(secret));
}

/** A structurally valid JWT signed with no algorithm (must always be refused). */
export function unsignedToken(payload: Record<string, unknown> = {}): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: TEST_TENANT_ID, ...payload })}.`;
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

export function requestWithAuthorization(authorization?: string): Request {
  return new Request('http://alia.test/api/v1/events', {
    method: 'POST',
    headers: authorization === undefined ? {} : { authorization },
  });
}
