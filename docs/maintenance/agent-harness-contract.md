# Agent Harness 2.0 maintenance contract

## Canonical path

Agent Harness V2 is the canonical production path. New work must use the typed
session, turn, item, event, approval, tool, and rollout contracts. Legacy code
is compatibility or emergency-only code and must not become a new integration
surface.

## Ownership and escalation

- **Primary owner:** Agent Harness platform on-call.
- **Security owner:** platform/security reviewer for approvals, external
  actions, credentials, and incident response.
- **Product owner:** ApplyMate owner for rollout and GA decisions.
- **Escalation:** on-call owner → security reviewer → product owner.

Every production incident must have a repository issue, an admin audit record,
an affected deployment/environment, bounded trace identifiers, and a named
reviewer. Never put candidate content, resume text, prompts, completions,
cookies, tokens, or email addresses in an issue or metric payload.

## Service expectations

The release gates remain the source of truth:

- turn completion rate at least 99%;
- unauthorized external actions and duplicate submissions equal 0;
- replay consistency at least 99.9%;
- cost p95 no more than 1.2 times the legacy baseline; and
- the applicable latency, tool-error, approval-timeout, and submission-failure
  SLOs remain within their observability rules.

Any breach stops advancement and triggers the previous-stage rollback path.
There is no automatic promotion based only on a green CI run.

## Change and compatibility policy

1. New agent behavior must be typed, persisted, replayable, tenant-scoped, and
   covered by deterministic tests.
2. External writes, email sends, browser submissions, sensitive answers, and
   uploads require the existing policy and action-time approval boundaries.
3. Legacy compatibility may remain read-only or fail-closed while its traffic
   counter is observed. The in-process counter is diagnostic only; production
   zero-traffic sign-off must use durable deployment request logs. It must have
   an owner, an expiry, and a removal issue.
4. Destructive database changes require a separate migration issue/PR with a
   backup, rollback plan, staging evidence, and owner approval.
5. Protocol, schema, and event changes require versioned contracts and replay
   tests. Unknown events must remain safely opaque rather than being discarded.
6. Every rollout change must include a metrics-only report and an explicit
   rollback target.

## Security response

If an unauthorized or duplicate external action is detected, freeze rollout,
rollback to the previous safe stage, preserve the bounded evidence, and notify
the security owner. Do not enable emergency legacy mode merely to hide an
incident. Emergency mode is temporary, exact-value gated, dual-authorized,
and must be disabled and redeployed after recovery.
