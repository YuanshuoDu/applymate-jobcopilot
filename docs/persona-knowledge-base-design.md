# Persona Knowledge Base Design

## Goal

Persona is ApplyMate's user-owned, evidence-backed knowledge base. It is not a
copy of a single resume. It combines original resumes, profile preferences and
user-confirmed application answers so that form filling, resume tailoring and
cover-letter generation can retrieve only the facts needed for the task.

## Principles

1. A fact is not knowledge until the user confirms it.
2. Every reusable fact has provenance, a lifecycle and an allowed-use scope.
3. AI-adapted resumes are outputs, never evidence for Persona.
4. Exact fields use deterministic lookup; semantic RAG is reserved for long,
   evidence-rich text.
5. Privacy is the default: minimise data, exclude special categories and make
   every fact exportable, correctable and revocable.

## Phase 1: Structured fact store

`PersonaFact` is the canonical record. It stores a normalised key, the displayed
value, source, evidence, confidence, user confirmation, allowed uses and expiry.

```text
resume / application form / manual entry
              ↓
          candidate fact
              ↓ user confirms, edits or rejects
       confirmed PersonaFact
              ↓
  exact lookup for form fields and AI context assembly
```

Facts have one of `pending`, `confirmed`, `superseded`, `rejected` or `revoked`
states. Updating an answer supersedes the active value; it does not silently
overwrite its history. Existing `User.personaFields` remains a read-compatible
cache during migration, then can be retired after backfill verification.

### Retrieval contract

- `form_fill`: exact key/label lookup, only confirmed and unexpired facts.
- `tailor`: confirmed factual context from original resumes plus facts whose
  `allowedUses` includes `tailor`.
- `cover_letter`: the same, with no job-specific answer promoted to Persona.

The application should prefer exact values for identity, contact, legal status,
notice period and preferences. This is fast, explainable and avoids an LLM call.

## Phase 2: Evidence RAG

When a task needs a narrative answer (for example, a difficult project or an
achievement), create chunks only from confirmed evidence: base-resume bullets,
confirmed project notes and user-approved long answers.

```text
question → exact facts first → semantic top-K evidence chunks → task prompt
```

Use Postgres + pgvector where available. Embeddings, chunks and source links are
all personal data and must be deleted or revoked together. Do not embed raw
special-category data. RAG is not used for phone/email/select fields.

## Security and GDPR controls

- Default-deny special-category, financial and government-ID fields.
- Record the source, confirmation time and purpose for every reusable answer.
- Encrypt databases and backups; use application-level encryption for the most
  sensitive contact/identity fields where operationally feasible.
- Keep server-side EU-region storage as the canonical source. The extension may
  cache only recently used, user-authorised fields and must clear its cache on
  sign-out, revocation or expiry.
- Implement export, correction, per-fact revocation and account deletion across
  facts, source evidence, vector chunks and extension caches.
- Pass only task-scoped top-K facts to an LLM. When using a third-party model or
  BYOK, disclose the processor and data scope before sending content.

This follows GDPR privacy-by-design/default practices described by the EDPB:
https://www.edpb.europa.eu/topics/ai-and-technology/privacy-by-design-and-by-default_en

## Rollout

1. Ship `PersonaFact`, migration and dual-read compatibility.
2. Backfill validated legacy fields as `confirmed` facts with `source=legacy`.
3. Move form-save, edit and delete operations to the fact store.
4. Add exact retrieval telemetry without logging values.
5. Add approved evidence chunking and pgvector retrieval only after a DPIA and
   retention policy are complete.
