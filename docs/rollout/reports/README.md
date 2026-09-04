# Agent Harness rollout reports

This directory contains the immutable go/no-go evidence for each AH2-051
rollout stage. Reports are generated after the observation window closes and
must be committed or attached to the deployment record before an operator
advances the stage.

## File contract

Use `stage-{N}-{ts}.md`, where `N` is the stage ordinal (`0` for
`internal-only`, then `1`, `5`, `25`, `50`, and `100`) and `ts` is a UTC
timestamp in `YYYYMMDDTHHMMSSZ` form. Never overwrite an existing report.

Every report must contain:

1. the stage, observation window, deployment/version, and decision (`advance`,
   `hold`, or `rollback`);
2. actual values for completion, unauthorized external actions, duplicate
   submissions, replay consistency, and cost p95 ratio;
3. the V1/V2 difference count and metric-only summary;
4. the number of user feedback items and their aggregate category counts; and
5. the operator, reviewer, UTC sign-off time, and rollback target when one was
   selected.

Only opaque identifiers, counts, ratios, status codes, and bounded timestamps
may be included. Reports must not contain candidate text, resume content,
email addresses, phone numbers, browser payloads, prompts, completions,
cookies, tokens, or credentials.

The report is evidence for the rollout decision, not a substitute for the
staging smoke, production observation window, or rollback exercise required by
the roadmap. A failed threshold stops advancement immediately.
