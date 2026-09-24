/**
 * Access-token verification contract.
 *
 * Every refusal here is a boundary: a token that is not an HS256 token signed with
 * the configured secret, carrying a UUID subject and a numeric expiry, and free of a
 * privileged role claim, must never authenticate a partner request.
 */

import { describe, expect, it } from 'vitest';

import { AliaError } from '@/lib/errors';
import {
  extractBearerToken,
  MAX_TOKEN_LENGTH,
  PRIVILEGED_TOKEN_ROLES,
  readJwtConfig,
  verifyAccessToken,
} from '@/modules/identity/jwt';
import { mintToken, TEST_JWT_SECRET, TEST_TENANT_ID, unsignedToken } from '../support/tokens';

const config = { secret: TEST_JWT_SECRET };

describe('extractBearerToken', () => {
  it('reads a well-formed bearer credential', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer   abc.def.ghi  ')).toBe('abc.def.ghi');
  });

  it('ignores anything that is not a bearer credential', () => {
    for (const header of [
      undefined,
      null,
      '',
      '   ',
      'abc.def.ghi',
      'Basic dXNlcjpwYXNz',
      'Bearer',
      'Bearer   ',
      `Bearer ${'a'.repeat(MAX_TOKEN_LENGTH + 1)}`,
    ]) {
      expect(extractBearerToken(header)).toBeNull();
    }
  });
});

describe('readJwtConfig', () => {
  it('fails closed when the secret is absent, naming the key only', () => {
    try {
      readJwtConfig({});
      expect.unreachable('a missing secret must fail closed');
    } catch (error) {
      const typed = error as AliaError;
      expect(typed.code).toBe('CONFIGURATION_ERROR');
      expect(typed.message).toContain('SUPABASE_JWT_SECRET');
    }
  });

  it('carries optional issuer and audience only when configured', () => {
    expect(readJwtConfig({ SUPABASE_JWT_SECRET: 's' })).toEqual({ secret: 's' });
    expect(
      readJwtConfig({
        SUPABASE_JWT_SECRET: 's',
        SUPABASE_JWT_ISSUER: 'https://project.supabase.co/auth/v1',
        SUPABASE_JWT_AUDIENCE: 'authenticated',
      }),
    ).toEqual({
      secret: 's',
      issuer: 'https://project.supabase.co/auth/v1',
      audience: 'authenticated',
    });
  });
});

describe('verifyAccessToken', () => {
  it('accepts a valid token and returns the lower-cased subject and expiry', async () => {
    const token = await mintToken({ subject: TEST_TENANT_ID.toUpperCase(), expiresInSeconds: 600 });

    const verified = await verifyAccessToken(token, config);

    expect(verified.userId).toBe(TEST_TENANT_ID);
    expect(verified.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('refuses an expired token', async () => {
    const token = await mintToken({ subject: TEST_TENANT_ID, expiresInSeconds: -60 });

    await expect(verifyAccessToken(token, config)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses a token with no expiry claim', async () => {
    const token = await mintToken({ subject: TEST_TENANT_ID, expiresInSeconds: null });

    await expect(verifyAccessToken(token, config)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses a token signed with another secret', async () => {
    const token = await mintToken({ subject: TEST_TENANT_ID, secret: 'a-different-secret-000' });

    await expect(verifyAccessToken(token, config)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses an unsigned token and a structurally broken one', async () => {
    for (const token of [unsignedToken(), 'not.a.token', `${TEST_TENANT_ID}.${TEST_TENANT_ID}`, '']) {
      await expect(verifyAccessToken(token, config)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('refuses a subject that is missing or not a UUID', async () => {
    const missing = await mintToken({ subject: undefined });
    const notUuid = await mintToken({ subject: 'user-123' });

    await expect(verifyAccessToken(missing, config)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(verifyAccessToken(notUuid, config)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses a token carrying a privileged role claim', async () => {
    for (const role of PRIVILEGED_TOKEN_ROLES) {
      const token = await mintToken({ subject: TEST_TENANT_ID, role });
      await expect(verifyAccessToken(token, config), role).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    }
  });

  it('enforces the configured audience and issuer', async () => {
    const token = await mintToken({
      subject: TEST_TENANT_ID,
      audience: 'authenticated',
      issuer: 'https://project.supabase.co/auth/v1',
    });

    const strict = {
      secret: TEST_JWT_SECRET,
      audience: 'authenticated',
      issuer: 'https://project.supabase.co/auth/v1',
    };
    await expect(verifyAccessToken(token, strict)).resolves.toMatchObject({ userId: TEST_TENANT_ID });

    await expect(
      verifyAccessToken(token, { ...strict, audience: 'other' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      verifyAccessToken(token, { ...strict, issuer: 'https://example.test/auth/v1' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('never echoes the token or the secret in a refusal', async () => {
    const token = await mintToken({ subject: TEST_TENANT_ID, secret: 'wrong-secret-0000000' });

    try {
      await verifyAccessToken(token, config);
      expect.unreachable('a mis-signed token must be refused');
    } catch (error) {
      const typed = error as AliaError;
      expect(typed.message).not.toContain(token);
      expect(typed.message).not.toContain(TEST_JWT_SECRET);
    }
  });
});
