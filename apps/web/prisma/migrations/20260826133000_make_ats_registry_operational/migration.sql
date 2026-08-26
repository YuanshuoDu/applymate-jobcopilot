-- Turn ats_employers into the audited registry consumed by Worker discovery.
ALTER TABLE "ats_employers"
  ALTER COLUMN "firstSeen" DROP NOT NULL,
  ALTER COLUMN "firstSeen" DROP DEFAULT,
  ALTER COLUMN "lastSeen" DROP NOT NULL,
  ALTER COLUMN "lastSeen" DROP DEFAULT,
  ADD COLUMN "country" VARCHAR(2),
  ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "ats_employers_atsType_enabled_idx"
  ON "ats_employers"("atsType", "enabled");

-- Preserve the exact Greenhouse and Lever discovery coverage that the Worker
-- used before this registry became database-backed. Administrators can now
-- add to, rename, or disable this list without a Worker release.
INSERT INTO "ats_employers" ("atsType", "slug", "name", "country", "enabled", "firstSeen", "lastSeen")
VALUES
  ('greenhouse', 'n26', 'N26', 'de', true, NULL, NULL),
  ('greenhouse', 'personio', 'Personio', 'de', true, NULL, NULL),
  ('greenhouse', 'contentful', 'Contentful', 'de', true, NULL, NULL),
  ('greenhouse', 'deliveroo', 'Deliveroo', 'gb', true, NULL, NULL),
  ('greenhouse', 'zalando', 'Zalando', 'de', true, NULL, NULL),
  ('greenhouse', 'spotify', 'Spotify', 'se', true, NULL, NULL),
  ('greenhouse', 'revolut', 'Revolut', 'gb', true, NULL, NULL),
  ('greenhouse', 'klarna', 'Klarna', 'se', true, NULL, NULL),
  ('greenhouse', 'checkout', 'Checkout.com', 'gb', true, NULL, NULL),
  ('greenhouse', 'stripe', 'Stripe', 'ie', true, NULL, NULL),
  ('greenhouse', 'datadog', 'Datadog', 'us', true, NULL, NULL),
  ('greenhouse', 'figma', 'Figma', 'us', true, NULL, NULL),
  ('greenhouse', 'airtable', 'Airtable', 'us', true, NULL, NULL),
  ('greenhouse', 'notion', 'Notion', 'us', true, NULL, NULL),
  ('greenhouse', 'vercel', 'Vercel', 'us', true, NULL, NULL),
  ('greenhouse', 'hubspot', 'HubSpot', 'ie', true, NULL, NULL),
  ('greenhouse', 'gitlab', 'GitLab', 'us', true, NULL, NULL),
  ('greenhouse', 'databricks', 'Databricks', 'us', true, NULL, NULL),
  ('greenhouse', 'snowflake', 'Snowflake', 'us', true, NULL, NULL),
  ('greenhouse', 'confluent', 'Confluent', 'us', true, NULL, NULL),
  ('lever', 'spotify', 'Spotify', 'se', true, NULL, NULL),
  ('lever', 'klarna', 'Klarna', 'se', true, NULL, NULL),
  ('lever', 'tiermobility', 'TIER Mobility', 'de', true, NULL, NULL),
  ('lever', 'n26', 'N26', 'de', true, NULL, NULL),
  ('lever', 'deliveroo', 'Deliveroo', 'gb', true, NULL, NULL),
  ('lever', 'monzo', 'Monzo', 'gb', true, NULL, NULL),
  ('lever', 'revolut', 'Revolut', 'gb', true, NULL, NULL),
  ('lever', 'checkout', 'Checkout.com', 'gb', true, NULL, NULL),
  ('lever', 'wefox', 'Wefox', 'de', true, NULL, NULL),
  ('lever', 'tradeRepublic', 'Trade Republic', 'de', true, NULL, NULL),
  ('lever', 'personio', 'Personio', 'de', true, NULL, NULL),
  ('lever', 'zalando', 'Zalando', 'de', true, NULL, NULL),
  ('lever', 'deliveryHero', 'Delivery Hero', 'de', true, NULL, NULL),
  ('lever', 'bolt', 'Bolt', 'ee', true, NULL, NULL),
  ('lever', 'northvolt', 'Northvolt', 'se', true, NULL, NULL)
ON CONFLICT ("atsType", "slug") DO UPDATE SET
  "name" = COALESCE("ats_employers"."name", EXCLUDED."name"),
  "country" = COALESCE("ats_employers"."country", EXCLUDED."country");
