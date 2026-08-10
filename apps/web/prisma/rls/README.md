# Candidate RLS rollout

The application uses Prisma connection pooling, so `app.user_id` must be set with `SET LOCAL` inside the same transaction as the candidate query. Use `src/lib/db/tenant-context.ts` for candidate-service transactions; do not set this value with a session-level `SET`.

`enable.sql` is intentionally deployment-gated. Run it only with a candidate-service database role after the tenant-query inventory and cross-tenant SQL tests pass. Running it against the current shared Prisma connection before that migration will deny existing candidate traffic because those requests do not yet carry a tenant transaction context.

Candidate requests activate their tenant context in `requireAuth`, and the
Prisma runtime wrapper starts an interactive transaction, sets `app.user_id`,
and switches to `applymate_candidate` for every tenant model query. Explicit
multi-operation candidate work must use an interactive callback transaction;
array transactions fail closed while RLS is enabled.

Required rollout checks:

- candidate request auth activates a tenant context before tenant queries;
- candidate multi-operation paths use `db.$transaction(async tx => ...)`;
- admin reporting uses safe allow-listed queries and does not rely on an RLS bypass;
- a cross-tenant query returns zero rows;
- the candidate role cannot disable RLS or read another tenant's rows;
- the migration is applied in a maintenance window and followed by the web/worker smoke suite.

Run the reversible cross-tenant smoke test with a direct database credential before
enabling the policies:

```powershell
pnpm --filter @jobcopilot/web exec tsx scripts/verify-rls.ts
```

The verifier creates a temporary `NOBYPASSRLS` role, runs the policy inside a
rolled-back transaction, checks two tenant contexts and the empty-context case,
then drops the temporary role.
