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

## Next controlled slices

1. Add API-backed metadata pages for users, ATS health, applications, queues, AI budgets, and audit search.
2. Add versioned source-policy and feature-flag models with two-person approval and signed Worker commands.
3. Add broadcast drafts, anonymous audience preview, approval, batched notification delivery, and recipient deduplication.
4. Add session revocation, WebAuthn ceremony verification, break-glass approval, RLS, retention controls, and external security review.

Every write in later slices remains gated by permission, same-origin CSRF, an idempotency key, a 10-500 character reason, audit persistence before the side effect, and relevant approval separation.
