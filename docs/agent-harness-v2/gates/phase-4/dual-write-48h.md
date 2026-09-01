# Phase 4 Gate — 48-hour dual-write integrity report

**Status:** `pending staging shadow` / `blocked — staging access not available`

This artifact records the evidence state for the Phase 4 Exit Gate. It does
not claim that a 48-hour staging observation was run. No counts, mismatch
samples, database snapshots, or production-shaped measurements are invented
here.

## Run metadata

| Field | Value |
|---|---|
| Logical scope | AH2-008 dual-write and transcript projection |
| Required observation window | Trailing 48 hours, set at the time of the staging run |
| Operator | Codex (repository-only verification) |
| Staging access provider | None available to Codex |
| Staging URL | Not available |
| Artifact recorded at | 2026-09-01T01:01:15Z |
| Database snapshot | Not captured |
| Gate decision | **NOT PASSED** |

## Required metrics

| Metric | Result | Evidence status |
|---|---:|---|
| Event count parity: V2 `agent_events` vs projected legacy events | `BLOCKED` | Requires a staging database query over a real 48-hour window |
| Projection mismatch count | `BLOCKED` | Requires paired rows and semantic comparison using the AH2-008 projector contract |
| Projection mismatch sample (maximum five) | `BLOCKED` | No rows may be copied without a controlled staging snapshot and PII review |
| Duplicate session count | `BLOCKED` | Requires staging data and the operator's canonical run/session key |
| Sequence / ordering errors | `BLOCKED` | Requires staging `agent_events` ordered by `(sessionId, sequence)` |

## Authoritative data sources

The dual-write implementation and its projection marker are the sources of
truth for collection:

- [AH2-008 dual writer](https://github.com/YuanshuoDu/applymate-jobcopilot/blob/d34db398da9a542712ec7815f0507a76a006a951/apps/web/src/lib/agent/session/dual-write.ts)
- [AH2-008 transcript projector](https://github.com/YuanshuoDu/applymate-jobcopilot/blob/d34db398da9a542712ec7815f0507a76a006a951/apps/web/src/lib/agent/session/transcript-projector.ts)
- [AH2-008 projector and dual-write tests](https://github.com/YuanshuoDu/applymate-jobcopilot/tree/d34db398da9a542712ec7815f0507a76a006a951/apps/web/src/lib/agent/session)
- Prisma tables: `agent_events`, `agent_transcript_events`, `agent_sessions`, `agent_turns`, and `agent_automations`.

The projector stores an opaque marker at
`data.__agentHarnessV2.eventId`. The marker is the join key for comparing a
V2 event with its legacy projection; transcript timestamps must not be used as
the join key.

## Reproducible staging collection

The operator must run the following against a read-only, access-controlled
staging connection after recording the exact `window_start`, `window_end`,
deployment URL, deployment commit, operator, and timezone. The report must
retain aggregate results and a redacted sample only; do not paste raw resume,
contact, credential, answer, cookie, or provider-token data into this file or
the GitHub issue.

### 1. Event/projection parity and duplicate projections

```sql
WITH v2 AS (
  SELECT "id", "sessionId", "createdAt"
  FROM "agent_events"
  WHERE "createdAt" >= :window_start
    AND "createdAt" < :window_end
), projected AS (
  SELECT
    "sessionId",
    "data" -> '__agentHarnessV2' ->> 'eventId' AS "eventId"
  FROM "agent_transcript_events"
  WHERE "data" IS NOT NULL
    AND "data" ? '__agentHarnessV2'
), projected_by_event AS (
  SELECT "eventId", COUNT(*)::int AS "projectionCount"
  FROM projected
  WHERE "eventId" IS NOT NULL
  GROUP BY "eventId"
)
SELECT
  COUNT(*)::int AS "v2EventCount",
  COUNT(*) FILTER (WHERE p."eventId" IS NOT NULL)::int AS "projectedEventCount",
  COUNT(*) FILTER (WHERE p."eventId" IS NULL)::int AS "missingProjectionCount",
  COUNT(*) FILTER (WHERE p."projectionCount" > 1)::int AS "duplicateProjectionCount"
FROM v2
LEFT JOIN projected_by_event p ON p."eventId" = v2."id";
```

The parity result is not complete until the operator also checks for projected
markers that point to an event outside the selected V2 window and records that
count separately. A unique marker is expected for each dual-written event.

```sql
SELECT COUNT(*)::int AS "orphanProjectionCount"
FROM "agent_transcript_events" t
LEFT JOIN "agent_events" e
  ON e."id" = t."data" -> '__agentHarnessV2' ->> 'eventId'
WHERE t."data" IS NOT NULL
  AND t."data" ? '__agentHarnessV2'
  AND e."id" IS NULL;
```

### 2. Semantic projection mismatches

For each missing, duplicate, or sampled paired row, load the V2 event payload
and the legacy transcript row in a controlled script and compare user-visible
semantics with `compareTranscriptGolden` from the projector module. Report
only the field names that differ (`type`, `speaker`, `title`, `body`,
`durationMs`, or `data`) and a redacted row identifier. Never include raw
payloads in the report.

### 3. Duplicate canonical sessions

The operator must first declare the run key used by the staging exercise. For
automation runs, the `automation_started` transcript event contains the
`automationId` and the canonical session is linked by
`agent_automations.sessionId`. The following check finds one automation linked
to more than one observed transcript session:

```sql
WITH automation_sessions AS (
  SELECT
    "data" ->> 'automationId' AS "automationId",
    "sessionId",
    "createdAt"
  FROM "agent_transcript_events"
  WHERE "type" = 'automation_started'
    AND "createdAt" >= :window_start
    AND "createdAt" < :window_end
    AND "data" IS NOT NULL
    AND "data" ->> 'automationId' IS NOT NULL
)
SELECT COUNT(*)::int AS "duplicateAutomationSessionGroups"
FROM (
  SELECT "automationId"
  FROM automation_sessions
  GROUP BY "automationId"
  HAVING COUNT(DISTINCT "sessionId") > 1
) duplicate_automation_sessions;
```

The operator must reconcile any group against the canonical
`agent_automations.sessionId` row before counting it as a defect. For
chat/manual runs, use the recorded session IDs and expected turn boundaries;
similar goals or timestamps alone are not proof of a duplicate session.

### 4. Sequence and ordering errors

Run this over all events belonging to sessions touched in the window. Do not
interpret a sequence gap at the left edge of a time-window query as an error;
the session may have older events.

```sql
WITH ordered AS (
  SELECT
    "sessionId",
    "sequence",
    LAG("sequence") OVER (
      PARTITION BY "sessionId"
      ORDER BY "sequence"
    ) AS "previousSequence"
  FROM "agent_events"
  WHERE "sessionId" IN (
    SELECT DISTINCT "sessionId"
    FROM "agent_events"
    WHERE "createdAt" >= :window_start
      AND "createdAt" < :window_end
  )
)
SELECT COUNT(*)::int AS "sequenceGapOrOrderingErrorCount"
FROM ordered
WHERE "previousSequence" IS NOT NULL
  AND "sequence" <> "previousSequence" + 1;
```

The schema's `(sessionId, sequence)` unique constraint protects against exact
duplicates, while the continuity check detects committed sequence gaps. The
operator must still record retry or projection anomalies observed during the
window and explain any session whose first observed event is not sequence 1.

## Completion record to append after a real staging run

This section intentionally remains unfilled until an authorized staging
operator supplies evidence:

```text
window_start: <UTC timestamp>
window_end: <UTC timestamp>
deployment_url: <staging or preview URL>
deployment_commit: <commit SHA>
operator: <name or approved operator ID>
timezone: <IANA timezone>
v2_event_count: <integer>
projected_event_count: <integer>
missing_projection_count: <integer>
duplicate_projection_count: <integer>
projection_mismatch_count: <integer>
duplicate_session_count: <integer>
sequence_gap_or_ordering_error_count: <integer>
sample: <up to five redacted mismatch references, or none>
decision: <PASS / FAIL>
```

Until this record is completed from staging, AC2 remains blocked and the
Phase 4 Exit Gate remains `NOT PASSED`; this report does not unlock Phase 5.
