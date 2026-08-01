# Deploying unattended auto-apply

The auto-apply feature has two separate runtime components. The Web app accepts
user approval and starts manual Agent runs. The Worker owns the browser
automation, the durable BullMQ queues, and the high-frequency automation scheduler.

```
Worker scheduler -> /api/agent/automations/due -> Redis agent-runs
                                                     |
Web manual run -> Agent pipeline -> Redis apply-tasks -> Worker -> ATS
```

## Required production configuration

Configuration templates are available at `apps/web/.env.example` and
`apps/worker/.env.example`. Populate them only through your host's encrypted
environment-variable store; never commit the resulting values.

Apply the pending Prisma migration before deploying this version. It adds the
`queued` workflow state, which prevents a job from being shown as submitted
before a Worker has confirmed the ATS submission.

```powershell
pnpm --filter @jobcopilot/web exec prisma migrate deploy
```

Set the following Web environment variables in Vercel:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Production Neon/Postgres database |
| `REDIS_URL` | Same Redis instance used by the Worker |
| `CRON_SECRET` | Vercel's daily Gmail-sync Cron authentication secret |
| `AGENT_AUTOMATION_CRON_SECRET` | Shared secret for the Worker to invoke due automations |
| `AGENT_WORKER_SECRET` | Shared secret used only by the Worker internal callback |
| `MINIMAX_API_KEY` | Platform default model, unless every user brings a key |

Set the following Worker secrets in Fly.io (or the chosen long-running host):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Same production database |
| `REDIS_URL` | Same Redis instance as the Web app |
| `AGENT_WEB_URL` | Public Web origin, for example `https://app.example.com` |
| `AGENT_WORKER_SECRET` | Exact same value as the Web app |
| `AGENT_AUTOMATION_CRON_SECRET` | Exact same value as the Web app |
| `AGENT_SCHEDULER_INTERVAL_MS` | Optional due-check interval; defaults to `300000` (five minutes) |
| `CLOAK_MAX_WORKERS` | Start at `1` to respect ATS rate limits |
| `CAPSOLVER_API_KEY` | Optional CAPTCHA solver |

The Worker invokes `/api/agent/automations/due` every five minutes by default.
This avoids Vercel Hobby Cron's daily-only restriction while retaining a secured,
private scheduler. Set `AGENT_SCHEDULER_ENABLED=0` only for a Worker instance that
must not schedule automations.

## Fly.io Worker deployment

The repository includes the production configuration at `apps/worker/fly.toml`.
It creates one always-on Worker Machine in London (`lhr`), keeps the Bull Board
disabled, and uses `/healthz` for the Fly health check. The `cloak_profiles`
volume preserves per-user browser state between Machine restarts.

Create the volume and deploy from the repository root:

```powershell
fly volumes create cloak_profiles --app applymate-worker --region lhr --size 1
fly secrets set --app applymate-worker DATABASE_URL=... REDIS_URL=... AGENT_WEB_URL=https://web-stevens-projects-894c8977.vercel.app AGENT_WORKER_SECRET=... AGENT_AUTOMATION_CRON_SECRET=...
fly deploy --config apps/worker/fly.toml --remote-only
```

Use the stable Vercel project alias for `AGENT_WEB_URL`, rather than a custom
public domain. This Worker-to-Web callback remains valid if the customer-facing
domain changes later. Set `AGENT_SCHEDULER_ENABLED=1` only after the Web deployment
containing the due-automation endpoint has reached production and the Worker health
check is green.

## First verification

1. Deploy the Web app after the migration, then deploy the Worker image.
2. Verify the Worker endpoint: `GET https://<worker-host>/healthz` returns 200.
3. Create an automation with `requireApproval=true` and `autoApply=false`.
   This checks discovery, scoring, material preparation, and session history
   without sending an application.
4. Run it manually from the Agent console and confirm its session completes.
5. Within the next scheduler interval, confirm the scheduled session records an
   `Automation dispatched` event and reaches a terminal state.
6. Only then enable `autoApply=true` and `requireApproval=false` for a test job
   whose ATS application may safely be submitted.

If a task remains queued, inspect `agent-runs` and `apply-tasks` in the private
Bull Board. If a submission is not confirmed, the Worker returns the job to
`ready_to_apply`; it does not mark it applied speculatively.
