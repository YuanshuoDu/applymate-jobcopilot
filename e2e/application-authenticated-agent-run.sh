#!/bin/sh
set -eu
expected='postgresql://fixture:fixture@db:5432/application_flow_fixture'
test "${CI:-}" = true
test "${APPLICATION_AUTH_DISPOSABLE:-}" = true
test "${APPLICATION_AUTH_AGENT_REVIEWED_EXECUTION:-}" = true
test "${DATABASE_URL:-}" = "$expected"
test "${DIRECT_URL:-}" = "$expected"
test "${REDIS_URL:-}" = 'redis://redis:6379/15'
test "${AGENT_WEB_URL:-}" = 'http://127.0.0.1:3100'
test "${AGENT_WORKER_SECRET:-}" = 'fixture-only-worker-secret-at-least-32-bytes'
test "${PLATFORM_ENV:-}" = development
test "${RLS_RUNTIME_MODE:-}" = off
test -z "${AGENT_PREVIEW_FIXTURE:-}"
pnpm --filter @jobcopilot/web exec prisma migrate deploy --schema prisma/schema.prisma
node e2e/application-authenticated-seed.cjs
pnpm --filter web exec next start --hostname 127.0.0.1 --port 3100 &
server_pid=$!
worker_pid=''
cleanup() {
  if [ -n "$worker_pid" ]; then kill "$worker_pid" 2>/dev/null || true; fi
  kill "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT
node -e "const http=require('http');let n=0;function check(){http.get('http://127.0.0.1:3100/login',r=>{r.resume();if(r.statusCode<500)process.exit(0);retry()}).on('error',retry)}function retry(){if(++n>90)process.exit(1);setTimeout(check,1000)}check()"
./apps/worker/node_modules/.bin/tsx e2e/application-authenticated-agent-worker.mjs > /tmp/application-agent-worker.log 2>&1 &
worker_pid=$!
for attempt in $(seq 1 90); do
  if grep -q SYNTHETIC_QUESTION_WORKER_READY /tmp/application-agent-worker.log; then break; fi
  if ! kill -0 "$worker_pid" 2>/dev/null || [ "$attempt" -eq 90 ]; then
    cat /tmp/application-agent-worker.log
    exit 1
  fi
  sleep 1
done
if ! pnpm exec playwright test --config e2e/application-authenticated-agent.config.ts; then
  cat /tmp/application-agent-worker.log
  exit 1
fi
