# ApplyMate Production Domain Cutover

## Goal

Make `https://applymate.site` the canonical public ApplyMate URL. The `www`
hostname redirects to the canonical URL, and the Worker is served from
`https://worker.applymate.site`.

## Scope

- Attach `applymate.site` and `www.applymate.site` to the existing Vercel
  `web` project; redirect `www` to the apex host.
- Set the Web production origin for Auth.js and password-reset links to
  `https://applymate.site`.
- Register the canonical Google and GitHub OAuth callback URLs.
- Attach `worker.applymate.site` to the existing Fly.io worker application and
  point its `AGENT_WEB_URL` at the canonical Web origin.
- Replace the extension's production host allowlist with `applymate.site`.
- Validate the deployed site, auth callback endpoints, Worker health endpoint,
  and extension build.

## Non-Goals

- Moving the database, Redis, Vercel project, or Fly.io application.
- Changing OAuth client IDs, secrets, `AUTH_SECRET`, or shared Worker secrets.
- Decommissioning the previous deployment URL during the cutover. It remains a
  platform fallback until the production checks pass.

## Architecture

`applymate.site` terminates at the Vercel Web application. Vercel redirects
`www.applymate.site` to the apex host. The Web application derives its Gmail
OAuth callback from the request host and uses `NEXTAUTH_URL`/`AUTH_URL` for
Auth.js and password-reset links, so both values use the canonical origin.

`worker.applymate.site` terminates at the existing Fly.io worker. The Worker
continues to call the Web application through `AGENT_WEB_URL`, which changes
to the canonical origin. No user browser workflow calls the Worker directly.

The Chrome extension only treats the canonical Web host and local development
as trusted dashboard origins. Its manifest grants the canonical host API
permission; the temporary Vercel and old `applymate.ai` production patterns
are removed.

## External Configuration

The DNS owner has already created the domain records. The implementation must
confirm Vercel and Fly.io domain ownership before changing application
configuration. OAuth providers must accept these URLs:

- `https://applymate.site/api/auth/callback/google`
- `https://applymate.site/api/gmail/oauth/callback`
- `https://applymate.site/api/auth/callback/github`

The Vercel production variables are `NEXTAUTH_URL=https://applymate.site` and
`AUTH_URL=https://applymate.site`. The Fly.io Worker secret is
`AGENT_WEB_URL=https://applymate.site`.

## Rollback

If the canonical host, OAuth callbacks, or Worker-to-Web requests fail, restore
the prior production URL values and domain routing in the respective hosting
console. No database migration or credential rotation is part of this change,
so rollback does not affect persisted user data or sessions.

## Verification

- Confirm DNS and TLS for `applymate.site`, `www.applymate.site`, and
  `worker.applymate.site`.
- Confirm the canonical URL returns the Web application and `www` redirects to
  it.
- Confirm the Worker health endpoint is available at the Worker subdomain.
- Confirm the Google and GitHub OAuth redirect endpoints are registered.
- Run the extension typecheck and production build after replacing its host
  allowlists.
