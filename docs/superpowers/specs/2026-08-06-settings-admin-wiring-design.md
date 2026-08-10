# Settings and Admin Wiring Design

> Status: approved for implementation
> Date: 2026-08-06

## Goal

Make every existing Settings control either perform its real operation or show a truthful unavailable state, while using one shared, server-owned settings contract that the internal admin surface can safely inspect and update.

## Scope

Candidate Settings will persist profile fields, avatar data, job preferences, notification preferences, and privacy preferences. It will perform real data export, account deletion, password change, OAuth connect/disconnect, API-key management, and AI configuration actions. Theme and language remain local preferences. Billing actions will open a support request because this repository has no payment provider or subscription state machine.

The admin integration will expose a server-authorized, allow-listed user-settings endpoint. It can read the same non-secret settings and update only notification/privacy preferences. It will never return or accept passwords, OAuth tokens, discovery keys, AI keys, resume content, cover-letter content, Persona facts, or Gmail message data. The existing observability endpoint will use the same authorization guard.

## Data Contract

`User.preferences` remains a JSON object. Existing job-preference and `aiSettings` keys are preserved. New keys are:

```ts
notificationPreferences: {
  apply: boolean; reject: boolean; interview: boolean;
  offer: boolean; weekly: boolean; followUp: boolean;
}
privacyPreferences: {
  shareUsageData: boolean; allowAiTraining: boolean;
  storeCoverLetters: boolean;
}
```

Updates merge only the supplied top-level preference keys. This prevents profile saves from deleting AI configuration or future preference keys. Defaults are applied only at read time when a key is absent.

## API and Authorization

`PATCH /api/me` validates profile/image input and merges preferences. `/api/me/persona/export` is the download source. The delete action calls `/api/me/delete`, the existing confirmation-protected route.

`GET/PATCH /api/admin/v1/users/:id/settings` requires an authenticated administrator whose email or user ID is explicitly allow-listed by `ADMIN_EMAILS`/`ADMIN_USER_IDS`. The DTO contains masked identity, plan, profile metadata, job preferences, notification preferences, and privacy preferences only. PATCH accepts notification/privacy changes and writes an audit-safe Activity record. Missing allow-list configuration denies access.

## UI Behavior

- Profile avatar uses a hidden file input, validates image type and 2 MiB size, and saves a data URL through `/api/me`.
- Notification/privacy toggles optimistically persist and roll back on failure.
- Data export downloads a timestamped JSON file.
- Unsupported LinkedIn/Indeed connections are disabled with an explicit explanation; they do not report fake success.
- Billing buttons open a support email with the requested operation and never claim a plan transition occurred.
- Admin users page lists masked users and lets authorized staff edit notification/privacy preferences through the admin endpoint.

## Error Handling and Security

All mutations surface non-2xx responses. Admin routes use `Cache-Control: no-store`, explicit selects, bounded input validation, and deny-by-default authorization. Secret-like fields are rejected from admin payloads. Avatar data is restricted to image data URLs under the size limit or an existing remote URL.

## Verification

Vitest covers preference defaults/merging, avatar validation, candidate profile merge, admin authorization and DTO redaction, and admin settings updates. Web typecheck, focused tests, the full web test suite, and `git diff --check` are required before handoff.
