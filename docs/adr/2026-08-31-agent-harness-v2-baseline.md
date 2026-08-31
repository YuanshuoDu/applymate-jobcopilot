# Agent Harness 2.0 Legacy Baseline Snapshot

- **Snapshot type:** Phase 0 pre-V2 contract and safe-default evidence
- **Reference commit:** `7fc7b1a` (`origin/master`, after AH2-002)
- **Window:** `2026-08-31T00:00:00Z` → `2026-08-31T01:00:00Z`
- **Captured at:** 2026-08-31
- **Environment:** local/CI-equivalent checkout
- **Database access:** unavailable (`DATABASE_URL` was not configured)
- **Mutation:** none; all SQL below is read-only

## Important limitation

This checkout intentionally had no database credential. Therefore this artifact
does not invent production counts. The result for each database metric is
recorded as `unavailable` with its reason. A release operator must run the same
queries against staging or production with a read-only account and append the
timestamped result before enabling any V2 flag. The checked-in, database-free
part of the baseline is still authoritative: 11 V2 flags exist and all 11 are
disabled by default, in both Web and Worker health contracts.

## Safe-default snapshot

| Baseline | Result | Evidence |
|---|---:|---|
| Typed Harness V2 flags | 11 | `packages/shared/src/feature-flags.ts` |
| Flags with `defaultEnabled=false` | 11/11 | Shared catalog test |
| Web health safe-default state | `allDefaultOff=true` | `apps/web/src/app/api/agent/health/route.test.ts` |
| Worker health safe-default state | `allDefaultOff=true` | `apps/worker/src/admin/harness-health.test.ts` |
| Chat database metrics | unavailable | No `DATABASE_URL` in capture environment |
| Pipeline database metrics | unavailable | No `DATABASE_URL` in capture environment |
| Approval database metrics | unavailable | No `DATABASE_URL` in capture environment |
| Duplicate-risk database metrics | unavailable | No `DATABASE_URL` in capture environment |
| Cost database metrics | unavailable | No `DATABASE_URL` in capture environment |

## Reproducible read-only queries

Set `:window_start` and `:window_end` to the UTC values above. Run each query
with a read-only database role. These queries intentionally report both counts
and the source table so later snapshots can be compared without changing the
definition.

### Chat

```sql
SELECT 'agent_sessions' AS source,
       COUNT(*)::int AS sessions,
       COUNT(*) FILTER (WHERE created_at >= :window_start AND created_at < :window_end)::int AS sessions_in_window
FROM agent_sessions;

SELECT source, status, COUNT(*)::int AS sessions
FROM agent_sessions
WHERE created_at >= :window_start AND created_at < :window_end
GROUP BY source, status
ORDER BY source, status;

SELECT type, COUNT(*)::int AS transcript_events
FROM agent_transcript_events
WHERE created_at >= :window_start AND created_at < :window_end
GROUP BY type
ORDER BY type;
```

### Pipeline

```sql
SELECT status, COUNT(*)::int AS legacy_runs,
       COALESCE(ROUND(AVG(duration_ms))::int, 0) AS avg_duration_ms,
       COALESCE(SUM(jobs_found), 0)::int AS jobs_found
FROM agent_runs
WHERE created_at >= :window_start AND created_at < :window_end
GROUP BY status
ORDER BY status;

SELECT status, checkpoint, COUNT(*)::int AS executions,
       COALESCE(SUM(attempt_count), 0)::int AS attempts
FROM agent_executions
WHERE created_at >= :window_start AND created_at < :window_end
GROUP BY status, checkpoint
ORDER BY status, checkpoint;
```

### Approval

```sql
SELECT type, status, COUNT(*)::int AS approvals
FROM agent_approvals
WHERE created_at >= :window_start AND created_at < :window_end
GROUP BY type, status
ORDER BY type, status;
```

### Duplicate-risk signals

`application_tasks` has a unique `(user_id, job_id)` constraint. The first
query verifies the invariant; the second reports repeated result rows as a
review signal, not proof of a duplicated external side effect.

```sql
SELECT COUNT(*)::int AS duplicate_application_task_keys
FROM (
  SELECT user_id, job_id
  FROM application_tasks
  GROUP BY user_id, job_id
  HAVING COUNT(*) > 1
) duplicate_keys;

SELECT COUNT(*)::int AS repeated_user_job_result_pairs,
       COALESCE(SUM(result_count - 1), 0)::int AS excess_result_rows
FROM (
  SELECT user_id, job_id, COUNT(*)::int AS result_count
  FROM apply_results
  WHERE created_at >= :window_start AND created_at < :window_end
  GROUP BY user_id, job_id
  HAVING COUNT(*) > 1
) repeated_pairs;
```

### Cost

```sql
SELECT 'ai' AS category,
       COUNT(*)::int AS calls,
       COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
       COALESCE(SUM(estimated_cost_usd), 0)::numeric(18, 6) AS estimated_cost_usd,
       COALESCE(ROUND(AVG(latency_ms))::int, 0) AS avg_latency_ms
FROM ai_usage_events
WHERE created_at >= :window_start AND created_at < :window_end
UNION ALL
SELECT 'external_api' AS category,
       COALESCE(SUM(request_count), 0)::int AS calls,
       COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
       COALESCE(SUM(estimated_cost_usd), 0)::numeric(18, 6) AS estimated_cost_usd,
       COALESCE(ROUND(AVG(latency_ms))::int, 0) AS avg_latency_ms
FROM external_api_usage_events
WHERE created_at >= :window_start AND created_at < :window_end;
```

## Acceptance and update rule

This snapshot is complete for the safe-default and query-contract portions of
AH2-003. The database rows are intentionally marked unavailable in this local
environment. The first staging baseline update must append the actual query
outputs, database environment label, exact window, query commit, and operator;
it must not overwrite this pre-V2 record. No V2 flag may be enabled until that
credentialed snapshot exists.
