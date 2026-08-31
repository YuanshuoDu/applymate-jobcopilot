# ADR: Agent Harness 2.0 Foundation and Safe Rollout

- **Status:** Accepted for Phase 0
- **Date:** 2026-08-31
- **Scope:** `@jobcopilot/shared`, Web control-plane flag reads, Worker health/runtime flag reads
- **Related:** `docs/agent-harness-v2-technical-design.md`, `docs/agent-harness-v2-development-roadmap.md` AH2-003

## Context

ApplyMate is moving from a legacy chat/pipeline pair toward a Codex-style
Session → Turn → Step → Item runtime. The migration will introduce durable
state, model/tool calls, approvals, and subagents in later phases. Before those
changes, operators need a stable set of rollout controls and a repeatable
legacy baseline. A missing or malformed control must never accidentally enable
V2 or an external side effect.

The repository already has legacy operational flags such as
`unattended_apply`. Those controls preserve their existing product defaults and
must not be silently changed by this ADR. Harness 2.0 controls therefore live
in a separate typed catalog.

## Decisions

### 1. PostgreSQL remains the source of truth

The existing `PlatformFeatureFlag` table is the durable source for reviewed
environment/user/plan overrides. Web and Worker may cache or read the same row,
but neither Redis nor a process-local map is authoritative. This ADR does not
add a migration.

### 2. One shared resolver owns the decision

`packages/shared/src/feature-flags.ts` owns the V2 catalog, type guard,
rollout evaluation, safe-default behavior, and health snapshot. Web and Worker
only adapt their database clients and call `evaluateAgentHarnessFeature`; they
must not reimplement rollout or fallback rules.

An override is effective only when it is `active`, enabled, within its rollout
and targeting rules, and not past `rollbackAt`. Unknown keys return `false`.
Missing rows return the catalog default (`false`). Missing feature-flag tables
also return the catalog default; unexpected database errors are surfaced so an
operator can distinguish an outage from a safe disabled state.

### 3. V2 flags are separate and default off

The following 11 names are the only Phase 0 Harness controls. They are all
typed, centrally declared, and default to `false`:

| Flag | Missing/disabled behavior | First intended phase |
|---|---|---|
| `AGENT_PROTOCOL_V2_DUAL_WRITE` | legacy | Phase 1 |
| `AGENT_EVENT_SSE_V2` | legacy | Phase 2 |
| `AGENT_INPUT_QUEUE_V2` | legacy | Phase 2 |
| `AGENT_CHAT_LOOP_V2` | legacy | Phase 5/9 |
| `AGENT_TURN_WORKER_V2` | legacy | Phase 5 |
| `AGENT_TOOL_KERNEL_V2` | deny-risk | Phase 3 |
| `AGENT_POLICY_V2` | deny-risk | Phase 4 |
| `AGENT_SUBAGENTS_V2` | legacy | Phase 6 |
| `AGENT_CONTEXT_COMPACTION_V2` | legacy | Phase 7 |
| `AGENT_BROWSER_TOOL_V2` | deny-risk | Phase 8 |
| `AGENT_UI_TIMELINE_V2` | legacy | Phase 9 |

“Legacy” means the current implementation remains the selected path. “Deny-
risk” means a future caller must refuse a risky operation when the V2
capability is unavailable. A flag is never an approval receipt and can never
authorize submit, send, upload, or another irreversible action by itself.

### 4. Web and Worker expose non-sensitive health evidence

The Web `/api/agent/health` response and Worker `/healthz` response include the
same `agentHarnessFlags` safe-default snapshot:

```json
{
  "source": "safe_defaults",
  "allDefaultOff": true,
  "flags": {
    "AGENT_PROTOCOL_V2_DUAL_WRITE": { "enabled": false, "defaultEnabled": false }
  }
}
```

The complete catalog is present in the actual response. The health payload
contains no user IDs, plans, override rows, credentials, prompts, or model
data. It proves the deployed binary has safe defaults; it is not a substitute
for the authenticated admin rollout view.

### 5. Reviewed rollout is required

To enable a flag, an operator must create/update the environment-scoped row,
submit it through the existing admin review workflow, and approve it with an
explicit rollback time for high-risk controls. Rollback sets the flag inactive
or disabled and the next read falls back safely. Phase 0 does not open any V2
flag for ordinary users.

### 6. No direct Codex dependency

The runtime remains inside the existing Worker and uses the existing
provider-neutral ModelRouter/LLM boundary. Codex source remains a design
reference for protocol and harness behavior; no Codex binary or app-server is
introduced into the production execution path.

### 7. Baseline is read-only and reproducible

The accompanying `2026-08-31-agent-harness-v2-baseline.md` records the query
contract for chat, pipeline, approvals, duplicate-risk signals, and cost. The
queries are read-only and use an explicit UTC window. A production snapshot
must be captured by an operator with database access before any V2 flag is
enabled. Local/CI runs must report unavailable data rather than fabricate
zeroes.

## Consequences

Positive:

- Future Phase 1–10 PRs have stable names and safe rollback semantics.
- Web and Worker cannot diverge in rollout hashing or missing-row behavior.
- Health probes make accidental default-on deployment visible.
- Legacy behavior remains unchanged while the V2 protocol is additive.

Trade-offs:

- The catalog and the existing legacy operational catalog are both present;
  this is intentional until later phases consolidate control-plane ownership.
- A flag-table outage disables V2 rather than allowing an optimistic rollout.
- Production metrics require credentialed read-only capture and are not inferred
  from local tests.

## Rejected alternatives

- **Environment variables as the rollout source:** difficult to target users,
  audit, approve, or roll back consistently across Web and Worker.
- **Redis-only flags:** violates PostgreSQL source-of-truth and can diverge on
  cache loss.
- **One boolean “HARNESS_V2”:** cannot stage protocol, tools, policy, runtime,
  subagents, UI, and browser risk independently.
- **Flag-controlled submit authorization:** unsafe; external actions require
  the later Policy/Receipt contracts in addition to any rollout flag.
