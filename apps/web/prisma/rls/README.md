# Candidate RLS rollout

The application uses Prisma connection pooling, so `app.user_id` must be set with `SET LOCAL` inside the same transaction as the candidate query. Use `src/lib/db/tenant-context.ts` for candidate-service transactions; do not set this value with a session-level `SET`.

`enable.sql` is intentionally deployment-gated. Run it only with a candidate-service database role after the tenant-query inventory and cross-tenant SQL tests pass. Running it against the current shared Prisma connection before that migration will deny existing candidate traffic because those requests do not yet carry a tenant transaction context.

Required rollout checks:

- candidate queries use `withTenantContext(userId, callback)`;
- admin reporting uses safe allow-listed queries and does not rely on an RLS bypass;
- a cross-tenant query returns zero rows;
- the candidate role cannot disable RLS or read another tenant's rows;
- the migration is applied in a maintenance window and followed by the web/worker smoke suite.
