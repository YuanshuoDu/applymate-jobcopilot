# Agent Location Verification Rollout

**Status:** rollout procedure only. Location verification remains disabled unless the Web capability gate is explicitly enabled. This document does not authorize a deployment, worker drain, environment change, or live verification run.

## Capability gate

The Web service accepts version 2 objective location requirements only when `AGENT_OBJECTIVE_LOCATION_VERIFICATION_ENABLED` is exactly `1`. An unset value or any other value keeps the capability off. The API rejects malformed or unsupported version 2 requirements before creating the objective Turn or outbox entry. The Web UI shows the server's “Explicit location verification is not enabled yet” message in an alert and preserves the draft. The existing UI flow may create Session metadata before it sends the objective-start request; the gate prevents the Turn and outbox admission.

Version 1 count requirements and objectives without verification requirements keep their existing behavior. Version 2 location requirements are persisted with the Turn and must not be rewritten as version 1 or omitted during retries, repair, or re-planning. No schema migration is part of this change.

## Enablement order

1. Keep `AGENT_OBJECTIVE_LOCATION_VERIFICATION_ENABLED` unset or set to `0` in every Web environment while preparing the release.
2. Deploy the Worker version that understands version 2 requirements, Scout location checks, and the evidence verifier to the full Worker fleet.
3. Stop old Worker processes from receiving work. Drain their in-flight work and confirm every queue consumer that can receive Agent tasks runs the compatible Worker version. Do not proceed while an old Worker may receive a new location-verification Turn.
4. Deploy the matching Web API and UI while the capability gate remains off. Confirm the gate value is still off across the Web fleet.
5. Only after the Worker upgrade and drain are complete, enable the capability by setting `AGENT_OBJECTIVE_LOCATION_VERIFICATION_ENABLED=1` for the Web service and applying that configuration through the normal release process.

The order matters because an older Worker does not reliably recognize version 2. It may treat the unknown requirement as absent and bypass the location coverage check. Never enable the Web gate until every Worker has been upgraded and all old Worker processes and consumers have been drained.

## Existing and in-flight work

- Turns with no verification requirements and valid version 1 count-only Turns continue under their existing behavior on the upgraded Worker.
- The gate controls new Web admissions. Turning it off does not remove or downgrade version 2 requirements already persisted on a Turn.
- A persisted version 2 Turn requires a Worker that understands version 2 through its completion or explicit operator-directed stop. Keep compatible Workers available for that work; never route an unterminated version 2 Turn to a version 1-only Worker, which may treat its requirement as absent.
- The upgraded Worker fails closed at planning and child creation for invalid, unsupported, or conflicting persisted requirement copies. It does not repair them by deleting the location requirement.

An older persisted v2 location-repair snapshot that does not contain the inherited location guard is not resumable on the upgraded Worker; validation fails closed. Do not silently add the missing guard to that snapshot or describe its earlier repair report as location-verified. Location verification remains disabled by default. Before first enablement in any environment, upgrade and drain every old Worker as described above.

## Evidence and outcome semantics

The location verifier uses server-observed successful tool receipts bound to the same user, Session, Turn, root, parent, task, and current attempt. It binds the observed Job ID and source to the Scout candidate. A model-reported location or an unbound query result cannot establish the location.

Comparison normalizes Unicode with NFKC, trims the ends, folds internal whitespace, lowercases, and then compares the entire string. It does not infer aliases: `Dublin` does not match `Dublin, Ireland`. Location verification is separate from any candidate-count requirement.

- A trusted observed location that does not match the allowlist fails the location criterion.
- Missing or null location, missing or stale receipts, foreign evidence, or ambiguous/conflicting observations leave the criterion unverified.
- Conflicting observations for the same candidate do not pass, even if one observation matches.

## Rollback order

1. Disable the Web gate first by setting `AGENT_OBJECTIVE_LOCATION_VERIFICATION_ENABLED` to `0` or removing it, then apply the configuration and confirm all Web instances reject new version 2 location requirements.
2. Keep the compatible Worker fleet running while already-persisted version 2 work completes. If that work cannot continue, explicitly stop it; do not strip its persisted requirement or hand it to a legacy Worker.
3. If a Worker rollback is still required, wait until no version 2 Turn remains runnable, queued, or resumable. Only then drain and roll back the Worker fleet. Never allow a legacy Worker to receive an unterminated version 2 Turn; it may treat the unknown requirement as absent.
4. Keep a Web API version that rejects version 2 input until no newer client can submit it. Do not roll back to an API parser that may coerce an unsupported requirement into a null/absent value while such clients remain.
5. Roll back Web code only after the gate is off and the API/client compatibility condition above is satisfied. Version 1 and no-requirement flows remain the fallback.
