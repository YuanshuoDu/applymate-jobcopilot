# Gmail application tracking design

## Decision

Gmail is evidence for a job application, not a second, competing pipeline.
ApplyMate keeps one candidate-facing lifecycle:

```text
Saved -> Applied -> Interview -> Offer
                              \-> Rejected
```

`In review` and `Viewed` are not lifecycle states:

- A phrase such as “your application is under review” is an employer update. It
  is shown in the application timeline, but does not move the job status.
- A platform email saying a profile or application was viewed is not reliable
  evidence that an employer reviewed an application. It is not used to update
  a job or shown as a Gmail application type.
- Internal “ready for the user to apply” work is stored separately as a job
  workflow state. It is never presented as an employer decision.

The three My Jobs headline metrics are therefore **Saved**, **Applied**, and
**Interview**. Offer and rejection remain visible as outcome filters and
timeline events, but are deliberately not presented as pipeline progress.

## Evidence model

Every imported Gmail message is stored once, by Gmail message id, with its
thread id, sender, subject, short excerpt, received time, classification,
optional linked job, and matching confidence. This makes a sync idempotent and
gives each Dashboard timeline item a source.

Email classifications are intentionally separate from job status:

| Gmail classification | Result when confidently linked |
| --- | --- |
| Application received | Move Saved to Applied; add timeline evidence |
| Interview invitation | Move Saved/Applied to Interview; add timeline evidence |
| Offer | Move active application to Offer; add timeline evidence |
| Rejection | Move active application to Rejected; add timeline evidence |
| Application update | Add timeline evidence only |
| Recommendation digest | Create reviewable recommendation cards |
| Other | Ignore; it is not job-application evidence |

The sync never changes a job from a loose text match. It links automatically
only when company and role evidence are strong. Uncertain external applications
are shown as **Needs matching**; the user can save the inferred role to My Jobs
or leave it unlinked.

## Product flow

### Gmail

The Gmail page remains a familiar three-pane inbox: filter application evidence
in the left sidebar, select a message in the list, and read it in the original
mail reader. Its evidence filters are **Applied**, **Interview**, **Offer**,
**Rejected**, and **Application update**. A recommendation digest may appear in
the inbox but is managed from the dedicated entry beside the Gmail title, not
from a second sidebar filter.

**Job recommendations** is a separate list-management page for roles extracted
from Indeed, LinkedIn, GradIreland, IrishJobs and similar subscription emails.
It deduplicates repeated roles, displays the source platform, and lets the user
Save or Dismiss each job. Saving creates one normal My Jobs record in `saved`
state, so subsequent scoring and application work use the same path as
discovered jobs.

### My Jobs

My Jobs exposes the same lifecycle everywhere: filters, badges, manual status
changes and Kanban columns use Saved, Applied, Interview, Offer and Rejected.
The old Review column disappears. A role prepared by the agent stays Saved with
an internal `ready_to_apply` workflow marker until a person or confirmed Gmail
receipt establishes that it was applied to.

### Dashboard

The dashboard timeline is projected from persisted Activity events rather than
from the current row state of five jobs. It can consequently show an
application receipt followed by an interview invitation and a later outcome.
When a daily sync finds new, unsaved recommendations, the Dashboard displays a
Job notifications panel and the notification bell deep-links to Job
recommendations.

## Sync and notification behaviour

`syncGmailForUser` is the sole writer for Gmail-derived state. It is used by
the Job recommendations refresh, the daily protected cron endpoint, and the
agent audit stage. The inbox itself reads Gmail directly so it can retain the
original mail experience. For each newly persisted message, sync does the
following in order:

1. classify the message and persist it with a unique Gmail id;
2. extract and score a job match;
3. update a linked job only when the transition is valid and evidence is
   confident;
4. write one Activity timeline event and, for a real status change, a
   notification;
5. extract recommendation cards from digest emails and notify once per day
   when new pending cards exist.

The daily job is safe to retry. Unique Gmail ids and recommendation fingerprints
mean it cannot duplicate a status update, timeline event, job card or daily
summary.

## Migration

Existing `review` jobs migrate to `saved` plus `ready_to_apply` workflow state.
The PostgreSQL enum is rebuilt without `review`. New durable Gmail tables and
the pre-existing Notification table are created in the same migration so the
Dashboard alert cannot silently disappear on deployments that missed the old
notification migration.

## Success checks

- No user-facing page offers or displays `In review` or `Viewed` as an
  application state.
- A confirmed Gmail application receipt changes a strongly matched Saved job
  to Applied exactly once.
- Interview, offer and rejection receipts update a matching active job and
  create dated Dashboard activity.
- An unmatched email never changes an unrelated job.
- Recommendation emails create deduplicated, reviewable cards that can be
  saved into My Jobs or dismissed.
- My Jobs counts are server aggregates and do not change because of pagination
  or a local filter.
- Daily recommendation notifications deep-link to Job recommendations.
