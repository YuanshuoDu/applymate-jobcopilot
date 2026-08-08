# ATS Policy Enforcement Design

> Status: approved for implementation
> Date: 2026-08-08

## Goal

Make every ATS policy control in the admin console affect the Worker that
performs discovery and unattended application work. A displayed acknowledgement
must mean that a Worker has read the committed policy version, not merely that
it accepted an HTTP request.

## Problem

The web app persists `AtsSourcePolicy` and sends a signed
`apply_ats_policy` command. The Worker currently responds with the requested
version without loading a policy, while scout discovery uses a fixed 250 ms
delay. The command is also sent from inside the database transaction, so a
separate Worker connection cannot reliably see the intended version.

This makes pause, rollout, dynamic RPS, retry/backoff, and auto-apply controls
appear to work while the platform behavior remains unchanged.

## Architecture

Hard ATS ceilings remain a shared, code-owned allow-list. The Web app validates
administrator input against that ceiling; the Worker independently clamps every
effective policy to the same ceiling. This keeps a database mistake or stale
control command from increasing provider traffic beyond the documented safe
rate.

The Worker loads the committed database policy at the beginning of source work
and immediately before every provider request. A missing policy row uses the
current product behavior as its effective fallback. A database-read failure
fails closed for that source; an unavailable policy service must not permit
unbounded or stale discovery traffic.

Redis implements source-wide and user-and-source pacing slots. The effective
global and per-user rates are bounded by the shared hard limit. `rolloutPercent`
uses a deterministic user/source hash, so a user either consistently receives a
source or consistently does not until the configured rollout changes. Disabled,
pending-pause, and paused sources make no outbound discovery requests.

The same policy gate applies to known ATS unattended application flows. For an
unconfigured source it preserves existing behavior. Once a policy exists,
`allowAutoApply: false`, a paused source, or rollout exclusion stops the Worker
before browser navigation and returns a safe manual outcome.

Admin mutation routes first commit the desired policy and audit record. They
then send the signed command. The Worker reads the committed row and replies
with the version it actually loaded. The Web app records
`lastAcknowledgedVersion` only when that reply equals the currently stored
version; otherwise the console remains pending.

## Boundaries

- The Worker never imports `apps/web`; shared hard limits live in
  `packages/shared`.
- The database remains the desired-state source of truth. The command is an
  immediate propagation and acknowledgement mechanism, not a second config
  store.
- No new ATS providers, queues, or provider credentials are introduced.
- Existing no-policy discovery and auto-apply behavior stays unchanged.
- Admin policy changes do not enable unattended application for an ATS unless
  an administrator explicitly saves `allowAutoApply: true` for that source.

## Administrative Runtime Controls

Platform feature flags are restricted to a code-owned registry rather than
arbitrary strings. The initial registry contains `worker_discovery` and
`unattended_apply`; each has a real server-side consumer. A missing or retired
flag preserves the existing enabled behavior. An active disabled flag acts as a
global kill switch. An active enabled flag evaluates explicit user targets,
plan targets, and deterministic rollout in that order.

The pure targeting algorithm lives in `@jobcopilot/shared` so Web and Worker
make the same rollout decision. Web evaluates `unattended_apply` before it
queues a form-fill or submit task; Worker re-evaluates it before opening a
browser so already queued work cannot bypass a newly activated control.
Worker evaluates `worker_discovery` before querying an ATS. A missing legacy
feature-flag table keeps the existing behavior during a staged migration;
other lookup failures stop the affected automated operation safely.

The admin UI presents only registered controls and its status text reflects
the actual active state, not a generic claim that any arbitrary key is live.
ATS controls expose every persisted policy input. Direct ATS APIs report that
no credential is required instead of incorrectly reporting a missing secret.

Queue pause and resume commands are dispatched only after their audit and
idempotency transaction commits. A command result is returned only after the
Worker has actually performed the queue operation; a failed dispatch records a
separate failed audit event. This does not remove the production requirement
for a private configured Worker control plane.

## Error Handling

- A malformed or stale control command returns an error without acknowledging
  any version.
- A Worker that cannot read the requested policy returns an error, leaving the
  console pending.
- A source policy lookup or Redis pacing failure skips that source safely and
  logs only source/version/error metadata.
- Fetch failures retry at most `maxRetries` times with bounded exponential
  backoff based on `backoffBaseMs`.
- Unknown or expired platform flags have no runtime effect. A managed
  operation that cannot evaluate a present feature-flag store returns a safe
  unavailable/manual outcome rather than opening a browser or making an ATS
  request.

## Verification

Unit tests will prove effective-policy defaults, hard-limit clamping, pause and
rollout gates, Redis slot behavior, retry/backoff, control-plane version
validation, post-commit acknowledgement, auto-apply blocking, deterministic
feature targeting, registered-key validation, and queue-command auditing.
Existing Settings/admin route tests and all package suites, type checks,
builds, browser smoke tests, and deployment preflight checks remain required
before merge.
