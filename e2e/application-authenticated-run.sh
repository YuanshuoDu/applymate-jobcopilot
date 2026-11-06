#!/bin/sh
set -eu
expected='postgresql://fixture:fixture@db:5432/application_flow_fixture'
test "${CI:-}" = true
test "${APPLICATION_AUTH_DISPOSABLE:-}" = true
test "${DATABASE_URL:-}" = "$expected"
test "${DIRECT_URL:-}" = "$expected"
test "${RLS_RUNTIME_MODE:-}" = off
test -z "${AGENT_PREVIEW_FIXTURE:-}"
pnpm --filter @jobcopilot/web exec prisma migrate deploy --schema prisma/schema.prisma
node e2e/application-authenticated-seed.cjs
pnpm --filter web exec next start --hostname 127.0.0.1 --port 3100 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
node -e "const http=require('http');let n=0;function check(){http.get('http://127.0.0.1:3100/login',r=>{r.resume();if(r.statusCode<500)process.exit(0);retry()}).on('error',retry)}function retry(){if(++n>90)process.exit(1);setTimeout(check,1000)}check()"
pnpm exec playwright test --config e2e/application-authenticated.config.ts
node e2e/application-authenticated-verify.cjs
