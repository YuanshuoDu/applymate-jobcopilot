# Agent Harness observability taxonomy

Status: AH2-050 contract. This document is the source of truth for the
server-side event vocabulary, trace envelope, usage rollup, and privacy rules.

## 1. Design constraints

The taxonomy is deliberately small and operational. An event is a durable
fact used for replay-safe diagnosis, aggregation, or alerting; it is not a log
line and must not contain a prompt, resume, job description, email address, or
other candidate content. Web and Worker emit the same envelope. The Worker
writes through its existing raw `pg.Pool` boundary; the Web side owns the
Prisma schema and admin queries. No event emission requires a client metric or
an APM vendor.

The exact event vocabulary is closed. New event names require a taxonomy
revision and a corresponding emission, privacy, and dashboard test.

## 2. Common event envelope

Every event, including `queue.depth`, has these fields:

```ts
type HarnessEventEnvelope = {
  schemaVersion: 'harness-event.v1'
  eventId: string                 // stable unique id; idempotent at the sink
  eventType: HarnessEventType
  occurredAt: string              // UTC ISO-8601 timestamp
  traceId: string                 // session-wide opaque identifier
  spanId: string                  // identifier for this event's span
  parentSpanId: string | null     // null only for session.started
  correlationId: string           // request/queue correlation, not user input
  sessionId: string
  turnId?: string
  taskId?: string
  itemId?: string
  toolCallId?: string
  applicationTaskId?: string
  jobId?: string
  automationId?: string
  queueJobId?: string
  provider?: string               // allow-listed provider key, never a URL
  model?: string                  // allow-listed model key/version
  userId?: string                 // opaque internal id, never an email
  payload: Record<string, unknown> // allow-listed, redacted fields only
}
```

`parentSpanId` is nullable so the root session event still carries the field;
it is `null` only at the root. Child spans must point to an already-created
parent span. IDs are opaque generated identifiers and are never derived from
an email, prompt, IP address, URL, or candidate document. `occurredAt` is the
producer time; ingestion time belongs to storage metadata and is not used to
rewrite the trace.

The envelope is append-only and idempotent on `eventId`. A duplicate delivery
must not increment a counter or charge cost twice. A rejected payload is a
visible `event.invalid` ingestion error in operational logs, not a new member
of this closed event vocabulary.

## 3. Exact event vocabulary

The following 21 names are the complete AH2 event set. `payload` is restricted
to the fields shown; implementations may omit optional fields but may not add
candidate content.

| Event | Span/entity | Allow-listed payload | Primary use |
| --- | --- | --- | --- |
| `session.started` | Session | `entryPoint`, `harnessVersion` | Open a trace and establish the root span. |
| `session.completed` | Session | `status`, `durationMs`, `finalTurnCount` | Session completion and duration. |
| `turn.queued` | Turn | `queueName`, `queueWaitMs` | Queue depth and time-to-start measurement. |
| `turn.started` | Turn | `turnIndex`, `mode` | Turn start latency denominator. |
| `turn.completed` | Turn | `status`, `durationMs`, `stepCount` | Completion rate and p95 latency numerator. |
| `turn.failed` | Turn | `failureCode`, `retryable`, `durationMs` | Failure rate and safe diagnosis. |
| `turn.recovered` | Turn | `recoveryCode`, `attempt`, `durationMs` | Recovery success and recovery latency. |
| `tool.invoked` | Tool | `toolName`, `toolVersion`, `approvalRequired` | Tool call denominator and policy path. |
| `tool.completed` | Tool | `toolName`, `toolVersion`, `durationMs`, `status` | Tool success and latency. |
| `tool.failed` | Tool | `toolName`, `toolVersion`, `failureCode`, `retryable`, `durationMs` | Tool error rate and retry diagnosis. |
| `approval.requested` | Approval | `approvalScope`, `toolName`, `expiresAt` | Pending approval funnel. |
| `approval.granted` | Approval | `approvalScope`, `toolName`, `decisionAgeMs` | Approved-action count and decision latency. |
| `approval.denied` | Approval | `approvalScope`, `toolName`, `decisionAgeMs`, `reasonCode` | Denial funnel without free text. |
| `approval.expired` | Approval | `approvalScope`, `toolName`, `ageMs` | Approval timeout SLO numerator. |
| `artifact.created` | Artifact | `artifactType`, `artifactVersion`, `contentHash` | Artifact lineage; hash only, never content. |
| `artifact.updated` | Artifact | `artifactType`, `artifactVersion`, `contentHash`, `previousHash` | Stale-material and provenance diagnosis. |
| `submission.attempted` | Submission | `atsType`, `flowVersion`, `preflightStatus` | External-submit denominator before side effects. |
| `submission.completed` | Submission | `atsType`, `flowVersion`, `durationMs`, `resultCode` | Successful submission rate. |
| `submission.failed` | Submission | `atsType`, `flowVersion`, `failureCode`, `retryable`, `durationMs` | Submission-failure SLO numerator. |
| `cost.charged` | Usage/cost | `costMicros`, `inputTokens`, `outputTokens`, `unit`, `chargeType` | Leaf cost attribution by model and tool. |
| `queue.depth` | Queue | `queueName`, `depth`, `oldestAgeMs`, `sampledAt` | Queue health and saturation. |

Failure and reason values are finite codes (for example,
`provider_timeout`, `policy_denied`, or `captcha_detected`). They are not raw
exceptions, HTTP bodies, selector text, prompt text, or model output.

## 4. Trace hierarchy and boundary propagation

The canonical tree is:

```text
Session (traceId)
└── Turn (parentSpanId = session span)
    ├── Task / Item (when present)
    ├── Tool (parentSpanId = turn or task span)
    │   └── Approval (when required)
    ├── Artifact (created/updated by the turn or tool)
    └── Submission (parentSpanId = the guarded tool span)
        └── cost.charged (parentSpanId = the model/tool span that incurred it)
```

The hierarchy is logical rather than a requirement that every node emit a
separate event. When an optional node has no event, the child points to the
nearest emitted ancestor and retains the corresponding `turnId`, `taskId`,
`toolCallId`, or `applicationTaskId` field. `submission.*` is always a child
of the guarded external-action tool, so an operator can prove which tool was
authorized before inspecting the result.

At the Worker→Web boundary, propagate the opaque `traceId`, current
`parentSpanId`, `sessionId`, and `correlationId` as authenticated server-side
metadata (for example, the internal job envelope or equivalent request
headers). The receiving side validates length, character set, and ownership;
it never trusts a client-supplied user or tenant identifier. The timeline/SSE
stream may carry these metadata fields alongside the event, but the timeline
reducer remains unchanged. A query by `sessionId` or `traceId` must return the
ordered session, turn, task, tool, approval, artifact, submission, and cost
events without exposing payload PII.

## 5. Five-minute usage rollup

Usage is recorded server-side in five-minute UTC buckets. The raw event
envelope remains the audit/trace fact; the `usage_event` table is the queryable
rollup used by admin dashboards and cost controls. A rollup job:

1. reads only new, valid `cost.charged` and model/tool usage facts;
2. groups them by `bucketStart` (five-minute UTC boundary), `userId`,
   `sessionId`, `turnId`, `toolName`, `provider`, and `model`;
3. sums `inputTokens`, `outputTokens`, and integer `costMicros`;
4. upserts idempotently using the source event identity/bucket; and
5. exposes daily queries grouped by the required four-tuple
   `(userId, model, toolName, day)`.

The daily view is a projection of five-minute rows, not a second charge. A
retry or duplicate delivery is deduplicated by event identity before summing.
The attribution chain is:

```text
session total = sum(turn totals)
turn total    = sum(tool/model leaf totals)
tool total    = sum(cost.charged rows for that tool)
model total   = sum(cost.charged rows for that model)
```

Only leaf `cost.charged` rows are added. Parent totals are derived and must
never be charged again. Unknown pricing is represented by a `chargeType` or
pricing-status code and a zero/estimated cost according to the model policy;
it must not be silently assigned to another model.

## 6. Privacy and redaction contract

Event payloads are allow-listed, not “log everything and redact later”. The
following keys and their aliases are forbidden at every depth:

```text
email, e-mail, phone, name, address, ip, ipAddress, userAgent,
text, prompt, completion, message, content, resume, coverLetter,
jobDescription, html, screenshot, har, cookie, authorization, token,
secret, apiKey, password
```

Raw exception messages are converted to finite `failureCode` values. URLs are
not emitted; use an allow-listed `atsType` or route key. Hashes are for
artifact provenance only and must be cryptographic content hashes, never a
substitute for storing the underlying content. `userId` is an internal opaque
identifier and is still excluded from UI payloads unless an authorized admin
query explicitly needs it. Tests must assert that `payload.email`,
`payload.text`, and `payload.ip` are `undefined` for every event type.

## 7. Operational interpretation

Events are facts, while metrics are derived views. Dashboard counters must
state their time window and source event. SLO alerts are emitted when a
derived rule breaches its threshold, with the rule key, measured value,
threshold, window, and a trace/query reference; an alert must not copy the
underlying candidate data. This separation keeps replay deterministic and
makes a synthetic breach safe to run in CI without a database, provider, or
external side effect.
