/**
 * Immutable service identity. Kept free of environment values so it is safe to
 * return from a public endpoint.
 */
export const SERVICE_NAME = 'alia' as const;
export const SERVICE_VERSION = '0.1.0' as const;
export const API_VERSION = 'v1' as const;
