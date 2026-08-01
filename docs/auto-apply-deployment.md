# Deploying unattended auto-apply

The auto-apply feature has two separate runtime components. The Web app accepts
user approval, starts manual Agent runs, and accepts Vercel Cron. The Worker owns
the browser automation and the durable BullMQ queues.

```
Vercel Cron -> /api/agent/automations/due -> Redis agent-runs
                                               |
Web manual run -> Agent pipeline -> Redis apply-tasks -> Worker -> ATS
```

## Required production configuration

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
| `CRON_SECRET` | Vercel Cron authentication secret |
| `AGENT_WORKER_SECRET` | Shared secret used only by the Worker internal callback |
| `MINIMAX_API_KEY` | Platform default model, unless every user brings a key |

Set the following Worker secrets in Fly.io (or the chosen long-running host):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Same production database |
| `REDIS_URL` | Same Redis instance as the Web app |
| `AGENT_WEB_URL` | Public Web origin, for example `https://app.example.com` |
| `AGENT_WORKER_SECRET` | Exact same value as the Web app |
| `CLOAK_MAX_WORKERS` | Start at `1` to respect ATS rate limits |
| `CAPSOLVER_API_KEY` | Optional CAPTCHA solver |

Vercel invokes `/api/agent/automations/due` every five minutes through the root
`vercel.json`. A five-minute cron schedule requires a Vercel plan that permits
high-frequency Cron Jobs; otherwise use a secured external scheduler to call the
same endpoint with `Authorization: Bearer $CRON_SECRET`.

## First verification

1. Deploy the Web app after the migration, then deploy the Worker image.
2. Verify the Worker endpoint: `GET https://<worker-host>/healthz` returns 200.
3. Create an automation with `requireApproval=true` and `autoApply=false`.
   This checks discovery, scoring, material preparation, and session history
   without sending an application.
4. Run it manually from the Agent console and confirm its session completes.
5. Wait for the next Cron window and confirm the scheduled session records an
   `Automation dispatched` event and reaches a terminal state.
6. Only then enable `autoApply=true` and `requireApproval=false` for a test job
   whose ATS application may safely be submitted.

If a task remains queued, inspect `agent-runs` and `apply-tasks` in the private
Bull Board. If a submission is not confirmed, the Worker returns the job to
`ready_to_apply`; it does not mark it applied speculatively.
