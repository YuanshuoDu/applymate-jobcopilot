# ApplyMate Auto-Apply On-Call Runbook

This runbook covers the production auto-apply path:

`web -> BullMQ apply-tasks -> worker -> CloakBrowser -> ATS flow/pattern/LLM -> apply_results`

Use it to stabilize incidents first, then gather evidence for Claude/PM or a Codex implementation issue.

## Quick Reference

- Observability dashboard: `/admin/observability`
- Observability API: `/api/admin/observability`
- Bull Board: `/admin/queues`
- Apply queue: `apply-tasks`
- Scout queue: `scout-tasks`
- Results table: `apply_results`
- Key columns: `user_id`, `job_id`, `ats_type`, `flow_used`, `status`, `error`, `duration_ms`, `created_at`
- Redis env: `REDIS_URL`
- Database env: `DATABASE_URL`
- Worker env: `CLOAK_MAX_WORKERS`, `APPLY_TIMEOUT_MS`, `CAPSOLVER_API_KEY`, `RATE_LIMIT_PER_USER_HOUR`
- Bull Board env: `BULL_BOARD_PASSWORD`, `BULL_BOARD_PORT`

## First Five Minutes

1. Open `/admin/observability`; record success rate, CAPTCHA rate, average duration, last-24h count, and per-ATS success.
2. Open `/admin/queues`; record `waiting`, `active`, `delayed`, and `failed` for `apply-tasks`.
3. Check the latest merged work and CI:

```bash
gh pr list --repo YuanshuoDu/applymate-jobcopilot --state merged --limit 10
gh run list --repo YuanshuoDu/applymate-jobcopilot --limit 10
```

4. Confirm Redis and Postgres:

```bash
redis-cli -u "$REDIS_URL" PING
psql "$DATABASE_URL" -c "SELECT NOW();"
```

5. If users are being harmed and the cause is unclear, pause `apply-tasks` in Bull Board before debugging deeper.

## Scenario 1: Flow Success Rate Drops

**Symptoms:** Overall success rate drops, one ATS in `/admin/observability` is much worse than others, recent `apply_results` rows show `failed` or `manual`, or worker logs repeat selector/navigation/submit failures.

**Diagnosis:** Check per-ATS and per-flow success:

```bash
curl -sS https://<web-host>/api/admin/observability | jq '.byAts[] | {atsType,count,successRate}'
psql "$DATABASE_URL" -c "
SELECT COALESCE(ats_type,'unknown') AS ats_type,
       COALESCE(flow_used,'unknown') AS flow_used,
       COUNT(*) AS total,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status='submitted') / NULLIF(COUNT(*),0), 1) AS success_rate,
       COUNT(*) FILTER (WHERE status='failed') AS failed,
       COUNT(*) FILTER (WHERE status='manual') AS manual
FROM apply_results
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY ats_type, flow_used
ORDER BY total DESC;"
psql "$DATABASE_URL" -c "
SELECT created_at, user_id, job_id, ats_type, flow_used, status, LEFT(error, 240) AS error
FROM apply_results
WHERE created_at > NOW() - INTERVAL '24 hours'
  AND COALESCE(ats_type,'unknown') = '<ats-type>'
ORDER BY created_at DESC
LIMIT 25;"
redis-cli -u "$REDIS_URL" LLEN bull:apply-tasks:waiting
redis-cli -u "$REDIS_URL" LLEN bull:apply-tasks:active
gh pr list --repo YuanshuoDu/applymate-jobcopilot --state merged --search "flow OR greenhouse OR lever OR workday OR personio" --limit 20
```

**Recovery:** If one ATS is failing, keep other traffic running and isolate that ATS. If a recent flow PR caused the drop, ask Claude/PM whether to revert or hotfix. If a pre-programmed flow is stale, create or update a flow issue for `apps/worker/src/flows/`. If `flow_used='pattern-cache'` is failing, lower confidence or record pattern failures so the worker falls back to LLM. If all ATS types fail, switch to Scenario 3 or 4.

**Prevention:** Review per-ATS success after every flow PR, add fixtures for every ATS structure change, keep flow fixes scoped, and watch `programmatic`, `pattern-cache`, and `llm` separately.

## Scenario 2: CAPTCHA Spike

**Symptoms:** `/admin/observability` shows rising `overall.captchaRate`, `apply_results.error` contains "captcha", users see more manual applications, or CapSolver balance/latency is unhealthy.

**Diagnosis:** Check dashboard, DB, worker env, and solver logs:

```bash
curl -sS https://<web-host>/api/admin/observability | jq '.overall | {total,captchaRate,captchaErrors,successRate,last24h}'
psql "$DATABASE_URL" -c "
SELECT created_at, ats_type, flow_used, status, LEFT(error, 240) AS error
FROM apply_results
WHERE created_at > NOW() - INTERVAL '24 hours'
  AND error ILIKE '%captcha%'
ORDER BY created_at DESC
LIMIT 50;"
fly secrets list -a <worker-app> | grep CAPSOLVER_API_KEY
fly ssh console -a <worker-app> -C 'printenv CAPSOLVER_API_KEY | wc -c'
fly logs -a <worker-app> | grep -i "captcha\|capsolver"
```

**Recovery:** If `CAPSOLVER_API_KEY` is missing, set it and restart:

```bash
fly secrets set CAPSOLVER_API_KEY=<value> -a <worker-app>
fly apps restart <worker-app>
```

If CapSolver balance is empty, top it up or rotate to a funded key. If CAPTCHA is caused by aggressive throughput, slow the worker:

```bash
fly secrets set APPLY_TIMEOUT_MS=60000 -a <worker-app>
fly secrets set CLOAK_MAX_WORKERS=1 -a <worker-app>
fly apps restart <worker-app>
```

Pause `apply-tasks` in Bull Board if CAPTCHA/manual exceeds 20 percent of recent applies and the cause is unknown.

**Prevention:** Monitor `captchaRate`, keep CapSolver balance visible, avoid raising `CLOAK_MAX_WORKERS` without checking CAPTCHA rate, and track domain-specific spikes before pausing everything.

## Scenario 3: Worker OOM / Stall

**Symptoms:** Bull Board shows jobs stuck in `active`, `waiting` grows while logs stop, Fly reports restarts or memory pressure, or `apply_results` stops receiving new rows.

**Diagnosis:** Check worker health, memory, env, Redis, and DB writes:

```bash
fly status -a <worker-app>
fly logs -a <worker-app>
fly ssh console -a <worker-app>
free -m
ps aux | sort -nrk 4 | head
printenv CLOAK_MAX_WORKERS
printenv APPLY_TIMEOUT_MS
redis-cli -u "$REDIS_URL" PING
psql "$DATABASE_URL" -c "
SELECT COUNT(*) AS last_15m
FROM apply_results
WHERE created_at > NOW() - INTERVAL '15 minutes';"
redis-cli -u "$REDIS_URL" LLEN bull:apply-tasks:waiting
redis-cli -u "$REDIS_URL" LLEN bull:apply-tasks:active
redis-cli -u "$REDIS_URL" LLEN bull:apply-tasks:failed
```

**Recovery:** Reduce concurrency before restarting if memory is exhausted:

```bash
fly secrets set CLOAK_MAX_WORKERS=1 -a <worker-app>
fly apps restart <worker-app>
```

If memory is still tight, scale and restart:

```bash
fly scale memory 512 -a <worker-app>
fly apps restart <worker-app>
```

If active jobs remain stale, record job IDs and retry or fail them in Bull Board. If the same ATS stalls repeatedly, create a flow-specific issue.

**Prevention:** Keep `CLOAK_MAX_WORKERS` aligned with memory, watch `duration_ms`, use the existing Cloak pool helpers, and add tests for paths that can leave jobs active after errors.

## Scenario 4: Apply Queue Backlog

**Symptoms:** `/admin/queues` shows `apply-tasks.waiting` growing, users report delayed starts, `apply_results.created_at` lags behind enqueue time, or throughput is lower than enqueue rate.

**Diagnosis:** Check Bull Board, Redis queue keys, throughput, and common errors:

```bash
open https://<worker-host>/admin/queues
redis-cli -u "$REDIS_URL" LLEN bull:apply-tasks:waiting
redis-cli -u "$REDIS_URL" LLEN bull:apply-tasks:active
redis-cli -u "$REDIS_URL" LLEN bull:apply-tasks:delayed
redis-cli -u "$REDIS_URL" LLEN bull:apply-tasks:failed
psql "$DATABASE_URL" -c "
SELECT date_trunc('minute', created_at) AS minute, COUNT(*) AS completed
FROM apply_results
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY 1
ORDER BY 1 DESC;"
psql "$DATABASE_URL" -c "
SELECT LEFT(error, 80) AS error, COUNT(*)
FROM apply_results
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY 1
ORDER BY COUNT(*) DESC
LIMIT 20;"
```

**Recovery:** If backlog is over 100 and rising, pause `apply-tasks` in Bull Board. Inspect failed jobs before retrying; do not bulk-retry CAPTCHA or rate-limit failures. If workers are healthy and CAPTCHA is normal, raise concurrency carefully:

```bash
fly secrets set CLOAK_MAX_WORKERS=2 -a <worker-app>
fly apps restart <worker-app>
```

If jobs are stale, fail or retry them from Bull Board after recording IDs. If Redis is unreachable, restore Redis before changing app code.

**Prevention:** Track queue counts after deploys, keep concurrency small unless CAPTCHA and OOM are stable, add capacity based on `duration_ms`, and avoid bulk retries without filtering by error type.

## Scenario 5: Rate-Limit Cascading Failure

**Symptoms:** Worker logs show `RATE_LIMITED:<retryMs>`, many jobs are delayed for the same user/domain, `apply_results.error` contains `RATE_LIMITED`, or a few users dominate queue activity.

**Diagnosis:** Inspect Redis rate-limit keys and recent DB failures:

```bash
redis-cli -u "$REDIS_URL" KEYS "ratelimit:*"
redis-cli -u "$REDIS_URL" GET ratelimit:user:<user-id>
redis-cli -u "$REDIS_URL" TTL ratelimit:user:<user-id>
redis-cli -u "$REDIS_URL" GET ratelimit:domain:<user-id>:<domain>
redis-cli -u "$REDIS_URL" TTL ratelimit:domain:<user-id>:<domain>
psql "$DATABASE_URL" -c "
SELECT user_id, COUNT(*) AS failures, MAX(created_at) AS last_seen
FROM apply_results
WHERE created_at > NOW() - INTERVAL '4 hours'
  AND error LIKE 'RATE_LIMITED:%'
GROUP BY user_id
ORDER BY failures DESC
LIMIT 20;"
fly secrets list -a <worker-app> | grep RATE_LIMIT_PER_USER_HOUR
fly ssh console -a <worker-app> -C 'printenv RATE_LIMIT_PER_USER_HOUR'
```

**Recovery:** If one user is stuck and the queue is otherwise healthy, clear only that user's keys:

```bash
redis-cli -u "$REDIS_URL" DEL ratelimit:user:<user-id>
redis-cli -u "$REDIS_URL" DEL ratelimit:domain:<user-id>:<domain>
```

If many users are blocked by an incident, temporarily raise the hourly limit and restart:

```bash
fly secrets set RATE_LIMIT_PER_USER_HOUR=60 -a <worker-app>
fly apps restart <worker-app>
```

If a user is abusive, pause or cancel their queued jobs before raising global limits. Restore `RATE_LIMIT_PER_USER_HOUR` to normal after recovery; the code defaults to `30` when unset.

**Prevention:** Keep rate-limit retries visible, prefer per-user fixes over global limit changes, review high-volume users, and remember `ratelimit:domain:<user-id>:<domain>` is separate from the per-user hourly key.

## Evidence to Attach

- Incident window and environment.
- `/api/admin/observability` snapshot.
- Bull Board counts for `apply-tasks`.
- Relevant `apply_results` SQL output.
- Worker logs near first failure.
- Redis key samples with sensitive IDs redacted.
- Recent deploys or PRs that touched flows, worker code, env vars, Redis, or DB access.

## Escalation

- Escalate to Claude/PM when rollback, scope, or dispatch decisions are needed.
- Escalate to Codex when there is an in-progress issue, requested PR fix, failing CI caused by a PR, or reproducible implementation bug.
- Pause auto-apply when users are being harmed and the recovery path is unknown.
- Do not merge emergency fixes without Claude review unless the user explicitly authorizes it in the current thread.
