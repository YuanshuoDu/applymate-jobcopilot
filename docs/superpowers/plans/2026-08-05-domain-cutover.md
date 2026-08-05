# ApplyMate Production Domain Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `https://applymate.site` the sole canonical ApplyMate Web origin, with a canonical Worker subdomain and extension trust configuration.

**Architecture:** Vercel serves the Web application at the apex domain and redirects `www` to it. Fly.io keeps the Worker as a separate service behind `worker.applymate.site`; it calls the Web application through `AGENT_WEB_URL`. The extension uses the canonical origin by default and only trusts that production host for dashboard authentication synchronization.

**Tech Stack:** Vercel Domains and Production Environment Variables, Fly.io certificates and secrets, Google Cloud OAuth, GitHub OAuth, Chrome MV3 manifest, TypeScript, Vite.

---

## File Structure

- Modify: `apps/extension/manifest.json` to grant the canonical dashboard host permission and remove temporary production host patterns.
- Modify: `apps/extension/src/lib/storage.ts` to make the canonical dashboard origin the default API endpoint.
- Modify: `apps/extension/src/content/index.ts` to recognize only the canonical production dashboard as a dashboard page.
- Modify: `apps/extension/src/sidepanel/FormFillerView.tsx` to refresh extension authentication from the canonical dashboard.
- Create: `docs/superpowers/plans/2026-08-05-domain-cutover.md` as the execution record.

### Task 1: Establish the Canonical Vercel Host

**Files:**
- Modify: Vercel project `web` domain configuration

- [ ] **Step 1: Confirm the current redirect direction**

Run:

```powershell
curl.exe -sS -I --ssl-no-revoke https://applymate.site
curl.exe -sS -I --ssl-no-revoke https://www.applymate.site
```

Expected: the apex returns `200`, and `www` returns a `301` or `308` with `Location: https://applymate.site/`.

- [ ] **Step 2: Set the apex as the Vercel primary domain**

In Vercel project `web` > Settings > Domains, make `applymate.site` the production domain and configure `www.applymate.site` to redirect to `applymate.site`. The observed reverse redirect (`applymate.site` to `www`) must not remain.

- [ ] **Step 3: Validate Vercel TLS and routing**

Run the Step 1 commands again. Record the `x-vercel-id` response header and confirm both hostnames have valid HTTPS.

- [ ] **Step 4: Commit the execution record only if it changed**

```powershell
git add docs/superpowers/plans/2026-08-05-domain-cutover.md
git commit -m "docs: record canonical domain validation"
```

Expected: no source changes are included in this commit.

### Task 2: Configure Web Origin and OAuth Callbacks

**Files:**
- Modify: Vercel project `web` Production Environment Variables
- Modify: Google Cloud OAuth client configuration
- Modify: GitHub OAuth App configuration

- [ ] **Step 1: Set canonical Web environment variables in Vercel Production**

Set these values without changing existing secrets:

```env
NEXTAUTH_URL=https://applymate.site
AUTH_URL=https://applymate.site
```

Keep `AUTH_SECRET`, `DATABASE_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `AGENT_WORKER_SECRET`, and `AGENT_AUTOMATION_CRON_SECRET` unchanged.

- [ ] **Step 2: Register Google redirect URLs**

Add these exact Authorized redirect URIs to the current Google OAuth client:

```text
https://applymate.site/api/auth/callback/google
https://applymate.site/api/gmail/oauth/callback
```

Add `https://applymate.site` as an Authorized JavaScript origin. Do not remove the old URL until one successful Google sign-in and Gmail attachment complete on the new host.

- [ ] **Step 3: Register the GitHub callback URL**

Set the GitHub OAuth App homepage to `https://applymate.site` and its Authorization callback URL to:

```text
https://applymate.site/api/auth/callback/github
```

- [ ] **Step 4: Redeploy the Vercel production deployment**

Redeploy the existing production deployment after saving environment variables. Verify that a password reset issued from the new host links to `https://applymate.site/reset-password`.

- [ ] **Step 5: Validate endpoint reachability without initiating user login**

Run:

```powershell
curl.exe -sS -I --ssl-no-revoke https://applymate.site/api/auth/signin
curl.exe -sS -I --ssl-no-revoke https://applymate.site/api/gmail/oauth/start
```

Expected: each endpoint returns an application response rather than a domain, TLS, or Vercel routing error. The Gmail endpoint may redirect to login for an anonymous request.

### Task 3: Attach and Configure the Worker Subdomain

**Files:**
- Modify: Fly.io application `applymate-worker` certificate and secret configuration
- Modify: DNS record for `worker.applymate.site`

- [ ] **Step 1: Add the Fly.io certificate**

Run from an authenticated Fly.io session:

```powershell
flyctl certs add worker.applymate.site --app applymate-worker
flyctl certs show worker.applymate.site --app applymate-worker
```

Expected: Fly.io outputs the exact DNS target or validation record required for the Worker hostname.

- [ ] **Step 2: Add the Fly.io-provided DNS record**

Create the record shown by `flyctl certs show`; do not reuse the Vercel root-domain record for the Worker. Wait until certificate status is `Ready`.

- [ ] **Step 3: Point scheduled Worker calls at the canonical Web origin**

Run:

```powershell
flyctl secrets set AGENT_WEB_URL=https://applymate.site --app applymate-worker
```

Expected: Fly deploys a new Worker release while preserving all existing secrets.

- [ ] **Step 4: Verify Worker health over the custom hostname**

Run:

```powershell
curl.exe -sS --fail --ssl-no-revoke https://worker.applymate.site/healthz
```

Expected: `200` and the JSON health response currently served by `applymate-worker.fly.dev`.

### Task 4: Switch Chrome Extension Production Origins

**Files:**
- Modify: `apps/extension/manifest.json`
- Modify: `apps/extension/src/lib/storage.ts`
- Modify: `apps/extension/src/content/index.ts`
- Modify: `apps/extension/src/sidepanel/FormFillerView.tsx`

- [ ] **Step 1: Replace manifest production host patterns**

In `apps/extension/manifest.json`, replace the dashboard content-script match `*://web-delta-ruddy-29.vercel.app/*` with `https://applymate.site/*`. Replace host permissions `https://*.vercel.app/*` and `https://*.applymate.ai/*` with `https://applymate.site/*`. Keep local development entries and job-board permissions unchanged.

- [ ] **Step 2: Make the canonical origin the default extension API base URL**

In `apps/extension/src/lib/storage.ts`, set:

```ts
apiBaseUrl: 'https://applymate.site',
```

Preserve the extension settings schema and all storage behavior.

- [ ] **Step 3: Restrict dashboard-page detection to the canonical host**

In `apps/extension/src/content/index.ts`, replace the two production hostname checks with:

```ts
window.location.hostname === 'applymate.site'
```

Keep the existing `localhost` condition for development.

- [ ] **Step 4: Restrict side-panel authentication refresh to the canonical host**

In `apps/extension/src/sidepanel/FormFillerView.tsx`, replace the old Vercel and `*.applymate.ai` checks with:

```ts
url.hostname === 'applymate.site'
```

Keep the existing `localhost` condition.

- [ ] **Step 5: Verify no deprecated production endpoint remains**

Run:

```powershell
rg -n "web-delta-ruddy-29\.vercel\.app|applymate\.ai" apps/extension
```

Expected: no matches, except intentional product-name text which does not contain a URL or hostname.

- [ ] **Step 6: Typecheck and package the extension**

Run:

```powershell
pnpm --filter @jobcopilot/extension typecheck
pnpm --filter @jobcopilot/extension build
```

Expected: both commands exit `0` and produce the Chrome MV3 output under `apps/extension/dist`.

- [ ] **Step 7: Commit and push the source migration**

```powershell
git add apps/extension/manifest.json apps/extension/src/lib/storage.ts apps/extension/src/content/index.ts apps/extension/src/sidepanel/FormFillerView.tsx
git commit -m "chore: use applymate.site in extension"
git push
```

Expected: the commit contains only the domain-origin migration and is pushed to `origin/chore/domain-cutover`.

### Task 5: Production Acceptance Check

**Files:**
- Modify: no repository files

- [ ] **Step 1: Confirm canonical host and redirect behavior**

Run:

```powershell
curl.exe -sS -I --ssl-no-revoke https://applymate.site
curl.exe -sS -I --ssl-no-revoke https://www.applymate.site
```

Expected: apex `200`; `www` redirects to apex.

- [ ] **Step 2: Confirm Worker and public authentication routes**

Run:

```powershell
curl.exe -sS --fail --ssl-no-revoke https://worker.applymate.site/healthz
curl.exe -sS -I --ssl-no-revoke https://applymate.site/api/auth/signin
```

Expected: Worker health returns `200`; Web auth route returns an application response.

- [ ] **Step 3: Perform manual OAuth smoke tests**

From a private browser window, verify one Google login, one GitHub login, and one Gmail connect flow. Confirm every callback and final page URL starts with `https://applymate.site`.

- [ ] **Step 4: Record the final results and hand off**

Include the production URLs tested, the commits pushed, the extension build result, and any OAuth provider action that remains pending.
