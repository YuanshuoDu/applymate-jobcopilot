CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "persona_evidence_chunks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fact_id" TEXT,
    "source_type" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "allowedUses" TEXT[] NOT NULL DEFAULT ARRAY['form_fill', 'tailor', 'cover_letter']::TEXT[],
    "embedding_model" TEXT,
    "embedded_at" TIMESTAMP(3),
    "embedding" vector(1536),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "persona_evidence_chunks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "persona_evidence_chunks_userId_source_ref_content_hash_key" ON "persona_evidence_chunks"("userId", "source_ref", "content_hash");
CREATE INDEX "persona_evidence_chunks_userId_status_updated_at_idx" ON "persona_evidence_chunks"("userId", "status", "updated_at" DESC);
CREATE INDEX "persona_evidence_chunks_userId_source_type_status_idx" ON "persona_evidence_chunks"("userId", "source_type", "status");
CREATE INDEX "persona_evidence_chunks_embedding_hnsw_idx" ON "persona_evidence_chunks" USING hnsw ("embedding" vector_cosine_ops) WHERE "status" = 'confirmed' AND "embedding" IS NOT NULL;

ALTER TABLE "persona_evidence_chunks" ADD CONSTRAINT "persona_evidence_chunks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "persona_evidence_chunks" ADD CONSTRAINT "persona_evidence_chunks_fact_id_fkey" FOREIGN KEY ("fact_id") REFERENCES "persona_facts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
