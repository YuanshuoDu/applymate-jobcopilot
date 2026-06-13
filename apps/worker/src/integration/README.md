# Integration Tests

Run with real Postgres + Redis:

```bash
export DATABASE_URL=postgresql://...
export REDIS_URL=redis://...
RUN_INTEGRATION_TESTS=1 pnpm --filter worker test -- src/integration/
```

Unit tests (always run, no env needed):

```bash
pnpm --filter worker test
```
