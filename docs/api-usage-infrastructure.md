# API usage infrastructure

The admin API Usage page now has an **Other APIs** tab for non-job and non-model integrations. It reports request count, input/output bytes, errors, latency, estimated cost, provider ownership, event freshness, and telemetry source.

Tracked event providers:

- Gmail API and Google OAuth (user-owned credentials)
- GitHub API (user-owned credentials)
- Resend (platform email; set `EXTERNAL_API_COST_PER_REQUEST_RESEND` when the plan is metered)
- Azure Key Vault (platform credential wrapping; set `EXTERNAL_API_COST_PER_REQUEST_AZURE_KEY_VAULT` when metered)
- Worker control and scheduled agent-run calls (internal operational metadata)
- Upstash Redis (server-only `INFO` snapshot; no Redis command body is stored)
- Vercel Speed Insights (browser telemetry; provider-side usage is not exposed to the server)

Upstash configuration is server-only. For current-month requests, bandwidth, and billed cost, set `PAID_REDIS_DATABASE_ID`, `UPSTASH_API_EMAIL`, and `UPSTASH_API_KEY` (Upstash Developer API credentials), in addition to `PAID_REDIS_KV_REST_API_URL` and `PAID_REDIS_KV_REST_API_TOKEN`. If management credentials are not configured, the dashboard falls back to the Redis `INFO` snapshot and labels it `instance_lifetime`; that fallback is a command-only estimate and is not a billing-period total. `REDIS_COST_ALERT_USD=5` marks the dashboard warning threshold and is evaluated by the daily `/api/admin/observability/alerts/evaluate` Vercel Cron on the current Hobby plan, which creates a deduplicated admin incident/notification without stopping Redis. A Pro deployment can safely tighten that schedule to every five minutes. `REDIS_MAX_BUDGET_USD=20` documents the provider-side stop cap. The Upstash console remains authoritative for the actual budget stop.

Neon/Postgres is listed as an inventory item but intentionally reports telemetry unavailable: database billing is not request-count based and no provider billing API is queried. No API keys, access tokens, URLs, request bodies, response bodies, email contents, prompts, or exception text are persisted in usage events.

Inventory boundary: Mantiks, RapidAPI salary/market endpoints, ATS providers, and direct board feeds remain in the Job API catalogue because they return or enrich job-market records. Model provider endpoints and embeddings remain in the Model API catalogue. Google favicon/mail links, `next/font/google`, and Vercel Speed Insights are browser/build telemetry rather than server-billed API calls; they are documented as unavailable instead of fabricating request or cost totals.
