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

Apply pending Prisma migrations before deploying this version. The auto-apply
workflow needs the queued/submitting states and control-plane tables; the
admin-settings work also needs `20260603170000_add_ai_budget` and
`20260807110000_add_user_preferences_admin_permission`. `migrate deploy`
applies every missing migration in order.

```powershell
pnpm --filter @jobcopilot/web exec prisma migrate status
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
| `WORKER_CONTROL_URL` | Worker base URL without `/internal/admin/control`; for Fly use `https://applymate-worker.fly.dev` |
| `WORKER_CONTROL_SECRET` | HMAC secret that exactly matches the Worker secret for admin queue and ATS controls |
| `MINIMAX_API_KEY` | Platform default model, unless every user brings a key |

Set the following Worker secrets in Fly.io (or the chosen long-running host):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Same production database |
| `REDIS_URL` | Same Redis instance as the Web app |
| `AGENT_WEB_URL` | Public Web origin, for example `https://app.example.com` |
| `AGENT_WORKER_SECRET` | Exact same value as the Web app |
| `AGENT_AUTOMATION_CRON_SECRET` | Exact same value as the Web app |
| `WORKER_CONTROL_SECRET` | Exact same HMAC value as the Web app; required for every public listener |
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

Because the Web app runs on Vercel, `REDIS_URL` must be a public TLS Redis
endpoint (`rediss://...`) that both Vercel and Fly can reach. Do not use the
private URL produced by `fly redis create`: Fly restricts that endpoint to its
own private network, so it cannot serve as the shared BullMQ queue.

Create the volume and deploy from the repository root:

```powershell
fly volumes create cloak_profiles --app applymate-worker --region lhr --size 1
fly secrets set --app applymate-worker DATABASE_URL=... REDIS_URL=... AGENT_WEB_URL=https://web-stevens-projects-894c8977.vercel.app AGENT_WORKER_SECRET=... AGENT_AUTOMATION_CRON_SECRET=... WORKER_CONTROL_SECRET=...
fly deploy --config apps/worker/fly.toml --remote-only
```

Use the stable Vercel project alias for `AGENT_WEB_URL`, rather than a custom
public domain. This Worker-to-Web callback remains valid if the customer-facing
domain changes later. Set `AGENT_SCHEDULER_ENABLED=1` only after the Web deployment
containing the due-automation endpoint has reached production and the Worker health
check is green. The checked-in Fly config binds port 3001 on `0.0.0.0` so Fly's
HTTPS proxy can reach it. Only `/healthz` and the HMAC-protected
`/internal/admin/control` endpoint are available there; Bull Board remains disabled.
Set `WORKER_CONTROL_URL` in Vercel to the base URL only because the Web client
appends `/internal/admin/control` itself.

## First verification

1. Deploy the Web app after the migration, then deploy the Worker image.
2. Verify the Worker endpoint: `GET https://<worker-host>/healthz` returns 200.
3. Sign in as an MFA-enrolled administrator with queue permissions and load the
   queue summary. It must return live Worker counts rather than `404` or
   `Worker control plane is not configured`; corroborate the signed command in
   Fly logs. Use a staging queue for pause/resume mutation checks.
4. Create an automation with `requireApproval=true` and `autoApply=false`.
   This checks discovery, scoring, material preparation, and session history
   without sending an application.
5. Run it manually from the Agent console and confirm its session completes.
6. Within the next scheduler interval, confirm the scheduled session records an
   `Automation dispatched` event and reaches a terminal state.
7. Only then enable `autoApply=true` and `requireApproval=false` for a test job
   whose ATS application may safely be submitted.

If a task remains queued, inspect `agent-runs` and `apply-tasks` in the private
Bull Board. If a submission is not confirmed, the Worker returns the job to
`ready_to_apply`; it does not mark it applied speculatively.
