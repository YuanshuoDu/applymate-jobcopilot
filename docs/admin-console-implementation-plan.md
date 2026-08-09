# Admin Console Delivery Plan

This plan implements `admin-console-rbac-design.md` in secure vertical slices. The first slice is delivered with the internal console foundation and Contact us workspace.

## Delivered foundation

- Dedicated admin membership and role tables. Commercial `User.plan` is never used for authorization.
- Explicit permission allow-list, server-side `requireAdmin`, WebAuthn requirement for super admins, deny auditing, and no-store responses.
- Append-only audit records with hashed request metadata and safe snapshot types.
- Allow-listed admin user DTOs that mask email and expose only operational metadata.
- Legacy public observability endpoint removed; authenticated aggregates live at `/api/admin/v1/observability`.
- Candidate Contact us routes with ownership filters, HTML removal, secret redaction, server-owned SLA, and hidden internal notes.
- Support workspace at `/admin/contact-us` with an independent admin shell and responsive queue/conversation/context layout.

Initialize roles once a staff user exists with `INITIAL_SUPER_ADMIN_EMAIL=<staff-email> pnpm --filter web exec ts-node --project prisma/tsconfig.seed.json prisma/seed-admin-roles.ts`. The script refuses a second production super-admin initialization.

## Delivered controlled operations

- API-backed metadata pages for users, ATS health, applications, queues, AI budgets, audit search, and access review.
- Versioned source-policy controls with hard RPS ceilings, two-person source pause, and signed Worker propagation acknowledgement.
- Feature-flag draft/approval/rollback lifecycle, read-only snapshots, broadcast drafts, anonymous audience preview, approval, batched notification delivery, and recipient deduplication.
- Queue summary/pause/resume through a HMAC-signed, short-lived, replay-protected Worker command endpoint. The console does not access Redis or Bull Board.
- Budget overrides use optimistic versions and immutable adjustment records. Usage reset is a short-lived, independent-approver workflow.
- Role/status changes revoke existing admin sessions. Break-glass grants are short-lived, independently approved, audited, and resolved by `requireAdmin` without changing a standing role.
- The audit table has a database-level append-only trigger and revokes public UPDATE/DELETE/TRUNCATE privileges.

## Release-gate work and verified deployment state

The application migrations have been deployed to the configured Neon database and `prisma migrate status` reports the schema is up to date. The database contains the seven system roles and one active `super_admin` membership. The checked-in WebAuthn ceremony is real: the Security page calls `@simplewebauthn/browser`, the API verifies registration/authentication responses, stores credential counters, issues a short-lived reauthentication grant, and requires that grant for high-risk writes. Each administrator still needs to register a physical security key before using those writes.

The remaining production-only gates are intentionally explicit:

1. Roll out PostgreSQL RLS only with a candidate-service credential and transaction-scoped `SET LOCAL app.user_id`. Enable it after tenant-query inventory and cross-tenant SQL tests; the current shared Neon owner role has `BYPASSRLS`, so enabling policies on that connection would not provide meaningful isolation.
2. Restrict the application database role to `INSERT`/`SELECT` on `AdminAuditLog`, add the isolated daily hash-chain checkpoint job, and verify audit-write failure alerts. The migration already blocks normal row updates/deletes and revokes public mutation privileges; role-specific grants require deployment ownership.
3. Configure `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID`, `ADMIN_APP_URL`, `WORKER_CONTROL_URL`, and matching `WORKER_CONTROL_SECRET` values in the deployment secret store. For Fly, the checked-in configuration binds `WORKER_ADMIN_HOST=0.0.0.0` for the HTTPS proxy; the control route remains HMAC-signed, short-lived, replay-protected, and Bull Board stays disabled.
4. Run the full Web and Worker suites, the migration smoke test against an ephemeral PostgreSQL instance, and the external access-control/security review before production rollout.

Every admin write remains gated by permission, same-origin CSRF, an idempotency key, a 10-500 character reason, audit persistence before the side effect, and relevant approval separation.
