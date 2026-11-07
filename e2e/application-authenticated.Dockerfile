FROM node:20-bookworm
WORKDIR /workspace
ENV CI=true NEXT_TELEMETRY_DISABLED=1 PUPPETEER_SKIP_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm exec playwright install --with-deps chromium
# Prepare both Prisma engines while downloading dependencies. The following
# offline layer repeats the checks before the application build.
RUN export DATABASE_URL=postgresql://fixture:fixture@db:5432/application_flow_fixture && pnpm --filter web exec prisma generate --schema prisma/schema.prisma && pnpm --filter web exec prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /dev/null
RUN --network=none pnpm --filter @jobcopilot/agent-protocol build && pnpm --filter @jobcopilot/shared build && pnpm --filter @jobcopilot/agent-model build && pnpm --filter @jobcopilot/agent-policy build
RUN --network=none DATABASE_URL=postgresql://fixture:fixture@db:5432/application_flow_fixture pnpm --filter web exec prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /dev/null
RUN --network=none NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/workspace/e2e/application-authenticated-font.cjs AUTH_SECRET=fixture-only-secret-at-least-32-bytes DATABASE_URL=postgresql://fixture:fixture@db:5432/application_flow_fixture DIRECT_URL=postgresql://fixture:fixture@db:5432/application_flow_fixture pnpm --filter web build
