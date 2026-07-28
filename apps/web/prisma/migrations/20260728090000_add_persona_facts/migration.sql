CREATE TABLE "persona_facts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_ref" TEXT,
    "evidence" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "allowedUses" TEXT[] NOT NULL DEFAULT ARRAY['form_fill', 'tailor', 'cover_letter']::TEXT[],
    "consent_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "persona_facts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "persona_facts_userId_key_normalized_value_key" ON "persona_facts"("userId", "key", "normalized_value");
CREATE INDEX "persona_facts_userId_status_updated_at_idx" ON "persona_facts"("userId", "status", "updated_at" DESC);
CREATE INDEX "persona_facts_userId_category_status_idx" ON "persona_facts"("userId", "category", "status");

ALTER TABLE "persona_facts" ADD CONSTRAINT "persona_facts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
