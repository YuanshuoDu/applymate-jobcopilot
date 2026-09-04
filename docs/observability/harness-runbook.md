# Agent Harness observability runbook

This runbook is for the AH2 server/Worker path. It uses read-only admin
queries and finite event codes. Do not paste prompts, resume text, job
descriptions, email addresses, cookies, provider tokens, screenshots, or raw
exception messages into an incident or query result. Replace `<window>` and
`<trace-id>` with an approved time window or opaque trace identifier.

## Guardrails before investigating

1. Confirm the query window and deployment/version; do not widen a query to
   export candidate data.
2. Use `/admin/observability/{queue,agents,sse,usage}` with an authorized
   admin account. A visitor must receive 403.
3. Prefer aggregate fields (`count`, percentile, rate, age, code, model,
   toolName, atsType) and `traceId` over raw payloads.
4. Do not retry, approve, submit, or change a feature flag from this
   read-only investigation. Escalate an external-action risk to the incident
   owner.

## 1. Turn latency p95 breach

**Trigger.** `turn_p95_latency_ms > 30000` for the configured SLO window, or
the dashboard shows a synthetic `60000` ms breach.

**First query.** In the Agents dashboard, query the window for:

```sql
SELECT "model", percentile_cont(0.95)
  WITHIN GROUP (ORDER BY "duration_ms") AS p95_ms,
       count(*) AS turns
FROM "harness_metric_events"
WHERE "event_type" IN ('turn.completed', 'turn.failed')
  AND "occurred_at" >= <window.start> AND "occurred_at" < <window.end>
GROUP BY "model";
```

If the implementation exposes this through the admin API rather than SQL,
request the equivalent aggregate fields only: `model`, `queueName`, `p95_ms`,
and `turns`.

**Expected result.** One or more model/queue buckets identify whether the
breach is queue wait, model latency, or a broad service regression. The trace
contains `turn.started` and `turn.completed` (or `turn.failed`) with the same
`traceId`; no candidate text is required.

**Next step.** If queue wait dominates, follow the queue-depth path below and
check worker capacity. If model time dominates, compare provider/model
latency and cost buckets, then route or throttle according to the approved
policy. If only one trace is slow, inspect its finite failure/recovery codes;
do not replay an external tool automatically.

## 2. Tool error-rate breach

**Trigger.** `tool_error_rate > 1%` in the SLO window, calculated from
`tool.failed / tool.invoked` for the same tool/version. A zero-invocation
window is a passing zero rather than an error.

**First query.** In the Agents dashboard, group `tool.invoked`,
`tool.completed`, and `tool.failed` by `toolName`, `toolVersion`, and
`failureCode`:

```sql
SELECT payload->>'toolName' AS tool_name,
       payload->>'toolVersion' AS tool_version,
       COALESCE(payload->>'failureCode', '') AS failure_code,
       count(*) FILTER (WHERE "event_type" = 'tool.invoked') AS invoked,
       count(*) FILTER (WHERE "event_type" = 'tool.completed') AS completed,
       count(*) FILTER (WHERE "event_type" = 'tool.failed') AS failed
FROM "harness_metric_events"
WHERE "event_type" IN ('tool.invoked', 'tool.completed', 'tool.failed')
  AND "occurred_at" >= <window.start> AND "occurred_at" < <window.end>
GROUP BY tool_name, tool_version, failure_code;
```

**Expected result.** The failing tool/version and a finite code such as
`provider_timeout`, `policy_denied`, or `captcha_detected` account for the
rate. The trace links the failed tool to its parent turn and does not expose
the input or provider response.

**Next step.** For transient provider/queue codes, pause or rate-limit the
affected path under the existing policy and watch the next window. For policy
or approval codes, verify the policy/approval path and preserve the deny
decision. For browser or CAPTCHA codes, route to the existing manual/recovery
runbook; never loosen a safety guard to clear the metric.

## 3. Approval-timeout breach

**Trigger.** `approval_timeout_rate > 5%`, calculated from
`approval.expired / approval.requested` in the same window.

**First query.** In the Agents dashboard, group approval events by
`approvalScope` and `toolName`, returning counts and median/maximum age:

```sql
SELECT payload->>'approvalScope' AS approval_scope,
       payload->>'toolName' AS tool_name,
       count(*) FILTER (WHERE "event_type" = 'approval.requested') AS requested,
       count(*) FILTER (WHERE "event_type" = 'approval.expired') AS expired,
       max((payload->>'ageMs')::double precision) AS max_age_ms
FROM "harness_metric_events"
WHERE "event_type" IN ('approval.requested', 'approval.expired')
  AND "occurred_at" >= <window.start> AND "occurred_at" < <window.end>
GROUP BY approval_scope, tool_name;
```

**Expected result.** The result distinguishes expired approvals from denied
or granted approvals and shows whether one scope/tool is responsible. The
linked trace ends in a safe waiting/expired state; it has no submission side
effect.

**Next step.** Confirm notification and queue health, then ask the authorized
operator to resolve genuinely pending approvals through the normal UI. Do not
extend an expiry or replay a tool from the dashboard. If the same scope keeps
expiring, keep the action blocked and escalate an approval delivery/session
incident.

## 4. Submission-failure breach

**Trigger.** `submission_failed_rate > 2%`, calculated from
`submission.failed / submission.attempted` in the SLO window.

**First query.** In the Agents dashboard, group submission events by `atsType`,
`flowVersion`, `preflightStatus`, and finite `failureCode`:

```sql
SELECT payload->>'atsType' AS ats_type,
       payload->>'flowVersion' AS flow_version,
       payload->>'preflightStatus' AS preflight_status,
       COALESCE(payload->>'failureCode', '') AS failure_code,
       count(*) FILTER (WHERE "event_type" = 'submission.attempted') AS attempted,
       count(*) FILTER (WHERE "event_type" = 'submission.failed') AS failed
FROM "harness_metric_events"
WHERE "event_type" IN ('submission.attempted', 'submission.failed')
  AND "occurred_at" >= <window.start> AND "occurred_at" < <window.end>
GROUP BY ats_type, flow_version, preflight_status, failure_code;
```

**Expected result.** The first query identifies a flow/version or ATS cluster
and confirms whether failures happened before or after the guarded submit
boundary. A failed row has a trace and `submission.attempted`; there is no
assumption that a retry is safe.

**Next step.** If preflight is failing, keep submissions stopped and repair
the flow or candidate-data validation. If the provider/ATS is failing,
disable or rate-limit that flow and use the existing manual fallback. If a
completed external action is uncertain, treat it as possibly submitted and
perform the idempotency/reconciliation procedure before any retry.

## 5. Queue depth, SSE freshness, or recovery breach

**Trigger.** Queue depth/oldest age grows without draining, event-to-SSE
visibility exceeds its SLO, or the SSE dashboard shows reconnect gaps,
`turn.recovered` spikes, or missing terminal events.

**First query.** Start in Queue and SSE dashboards and correlate the same
window:

```sql
SELECT payload->>'queueName' AS queue_name,
       max((payload->>'depth')::double precision) AS peak_depth,
       max((payload->>'oldestAgeMs')::double precision) AS oldest_age_ms
FROM "harness_metric_events"
WHERE "event_type" = 'queue.depth'
  AND "occurred_at" >= <window.start> AND "occurred_at" < <window.end>
GROUP BY queue_name;

SELECT "event_type", count(*) AS count, max("occurred_at") AS latest_event_at
FROM "harness_metric_events"
WHERE "occurred_at" >= <window.start> AND "occurred_at" < <window.end>
GROUP BY "event_type";
```

Then select one opaque `<trace-id>` from the aggregate result and call
`queryHarnessTrace({ traceId: <trace-id> })` (or the equivalent admin trace
query) to verify the ordered `session → turn → tool/submission` event chain.
The trace query deliberately selects metadata columns only; never query or
display raw event payloads.

**Expected result.** The queue result shows whether work is saturated or
stalled; the stream result shows whether events were written but delayed to
SSE. A healthy reconnect returns a snapshot plus the missing durable tail,
with no duplicate event IDs and no missing sequence. A recovery path ends in a
single terminal turn event.

**Next step.** For saturation, inspect worker capacity and the oldest queue
job before changing concurrency. For stream lag or cursor gaps, preserve the
trace and follow the SSE reconnect/replay procedure; do not edit the reducer
or delete events. For repeated recovery/no-progress signals, stop affected
automation safely and escalate with the trace ID, event codes, deployment
version, and aggregate timestamps only.

## Alert and evidence recording

Each SLO rule emits one persisted alert row containing only `ruleKey`, `metric`,
`value`, `threshold`, `traceId`, `status`, and created/resolved timestamps. Record
the alert ID, deployment/version, query window, dashboard result, and operator
decision in the incident system. A synthetic CI breach
must use `turn_p95_latency_ms=60000`, assert the alert, and use no database,
provider, browser, or secret. Passing the drill proves rule wiring only; it
does not replace staging or production observation.
