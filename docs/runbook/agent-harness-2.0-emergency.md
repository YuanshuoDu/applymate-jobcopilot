# Agent Harness 2.0 emergency runbook

This runbook is for an incident in which the canonical V2 path cannot safely
serve agent traffic. It is an operational procedure, not a normal feature
flag. The default is fail-closed V2 operation; an operator must record an
incident before enabling any legacy fallback.

## 1. Confirm the incident

1. Open the admin observability views for agents, queue, SSE, and usage.
2. Confirm the affected environment, deployment version, trace IDs, SLO
   breach, and whether unauthorized or duplicate external actions occurred.
3. Stop rollout advancement. If a rollout stage is active, use the admin
   rollback endpoint with a fresh idempotency key and a reason that references
   the incident record.
4. Do not copy candidate text, resume content, prompts, completions, cookies,
   tokens, or email addresses into the incident record.

## 2. Normal rollback to V1

AH2-051 rollback is the first response. It changes the rollout stage to the
previous safe stage and keeps V1 shadow execution dry-run only. Verify:

- `unauthorized_external_action = 0`;
- `submission_duplicate = 0`;
- V2 no longer receives new user traffic outside the selected internal allowlist;
- a rollback report is generated with metrics-only evidence; and
- the worker and web deployment versions agree on the rollback decision.

If the normal rollback succeeds, leave `EMERGENCY_LEGACY_MODE` unset. Open a
follow-up issue for the root cause and do not delete or bypass the evidence.

## 3. Emergency legacy adapter

The adapter is fail-closed unless the environment variable is explicitly set
to the exact value `true`:

```text
EMERGENCY_LEGACY_MODE=true
```

Only the on-call owner and a second reviewer may authorize this change. The
operator must:

1. create or update the incident with the authorization and expiry time;
2. verify the deployment/environment in the platform dashboard;
3. enable the variable only for the affected environment;
4. restart or redeploy the worker/web process so the value is loaded once;
5. run the read-only health and archive probes; and
6. record the exact start and expiry timestamps.

The adapter must reject missing, malformed, or any value other than
`true`. It must not silently translate free-form `ACTION:` text into a
mutation. Sensitive actions still require the existing scoped approval and
human handoff boundaries.

Disable the variable as soon as V2 is healthy, redeploy, and verify that the
adapter reports disabled. Never leave emergency mode enabled as a permanent
configuration or as a substitute for a rollback rehearsal.

## 4. Rebuild AgentRun archive access

The archive endpoint is read-only and ownership-scoped. To rebuild historical
visibility after a deployment:

1. verify the database migration state and read-only database connectivity;
2. query the archive endpoint as the owning account for a known historical run;
3. verify that the response contains only bounded run metadata and never raw
   prompt/output, candidate content, or credential material;
4. compare the count and timestamps with the admin audit record; and
5. if the data is missing, restore the database backup through the approved
   database recovery procedure, never by writing through the archive endpoint.

Do not drop or rewrite legacy AgentRun tables in this issue. Destructive schema
cleanup requires its own reviewed migration issue and rollback plan.

## 5. Close the incident

The incident reviewer signs off only after emergency mode is disabled, normal
rollout controls are active, the rollback exercise is recorded, and the next
stage remains blocked until the relevant observation window and thresholds pass.

Escalation: on-call owner → platform/security reviewer → product owner. Use
the repository issue and the admin audit record as the durable handoff; do not
use private chat as the only record.
