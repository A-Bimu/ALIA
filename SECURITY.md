# Security policy

ALIA is currently a controlled founding-pilot alpha.

Do not open a public issue containing a credential, child data, production data, exploitable detail, or private tenant information. Use GitHub private vulnerability reporting when available.

## Required handling

- Revoke and rotate an exposed secret immediately through its provider, then remove it from code and history using an approved procedure.
- Treat cross-organization access, RLS bypass, private-memory disclosure, organization-memory leakage, and child-data exposure as critical.
- Stop model calls when budget, authorization, or safety checks cannot be verified.
- Keep evidence minimal and redact personal data from logs, tests, issues, and pull requests.
- Do not test against production or delete data without explicit approval.

## Supported versions

Only the latest main branch and explicitly named pilot release are supported during alpha.
