# API usage infrastructure

The admin API Usage page now has an **Other APIs** tab for non-job and non-model integrations. It reports request count, input/output bytes, errors, latency, estimated cost, provider ownership, event freshness, and telemetry source.

Tracked event providers:

- Gmail API and Google OAuth (user-owned credentials, including Auth.js sign-in calls)
- GitHub API (user-owned credentials, including Auth.js sign-in calls)
- Resend (platform email; set `EXTERNAL_API_COST_PER_REQUEST_RESEND` when the plan is metered)
- Azure Key Vault (platform credential wrapping; set `EXTERNAL_API_COST_PER_REQUEST_AZURE_KEY_VAULT` when metered)
- Worker control and scheduled agent-run calls (internal operational metadata)
- Upstash Redis (server-only `INFO` snapshot; no Redis command body is stored)
- Neon Postgres (server-only consumption snapshot; compute, storage, branch, restore, and network metrics)
- Vercel Speed Insights (browser telemetry; provider-side usage is not exposed to the server)

The Other APIs aggregate cost is shown as `—` whenever an active provider has an unknown unit price; a numeric subtotal is never presented as a complete bill.

Upstash configuration is server-only. For current-month requests, bandwidth, and billed cost, set `PAID_REDIS_DATABASE_ID`, `UPSTASH_API_EMAIL`, and `UPSTASH_API_KEY` (Upstash Developer API credentials), in addition to `PAID_REDIS_KV_REST_API_URL` and `PAID_REDIS_KV_REST_API_TOKEN`. If management credentials are not configured, the dashboard falls back to the Redis `INFO` snapshot and labels it `instance_lifetime`; that fallback is a command-only estimate and is not a billing-period total. `REDIS_COST_ALERT_USD=5` marks the dashboard warning threshold and is evaluated by the daily `/api/admin/observability/alerts/evaluate` Vercel Cron on the current Hobby plan, which creates a deduplicated admin incident/notification without stopping Redis. A Pro deployment can safely tighten that schedule to every five minutes. `REDIS_MAX_BUDGET_USD=20` documents the provider-side stop cap. The Upstash console remains authoritative for the actual budget stop.

Neon configuration is server-only. Set `NEON_API_KEY` and `NEON_ORG_ID` to read current-month consumption metrics from Neon's consumption API; optionally set `NEON_PROJECT_ID` to limit the query to this project. On accounts where consumption history is unavailable, the dashboard falls back to the project details `data_transfer_bytes` value and labels it `current_billing_period`. Estimated cost uses the reported Launch/Scale plan and documented rates, with optional `NEON_COST_*` overrides; it is an estimate rather than an invoice, and unknown plan/rates are shown as `—`. Consumption data is refreshed by Neon approximately every 15 minutes and the request does not wake a compute. Postgres SQL query count is not exposed as a provider billing metric. No API keys, access tokens, URLs, request bodies, response bodies, email contents, prompts, or exception text are persisted in usage events.

Inventory boundary: Mantiks, RapidAPI salary/market endpoints, ATS providers, and direct board feeds remain in the Job API catalogue because they return or enrich job-market records. Model provider endpoints and embeddings remain in the Model API catalogue. Google favicon/mail links, `next/font/google`, and Vercel Speed Insights are browser/build telemetry rather than server-billed API calls; they are documented as unavailable instead of fabricating request or cost totals.
