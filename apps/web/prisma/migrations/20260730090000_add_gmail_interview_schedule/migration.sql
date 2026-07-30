ALTER TABLE "gmail_messages"
  ADD COLUMN "scheduled_at" TIMESTAMP(3);

CREATE INDEX "gmail_messages_user_id_kind_scheduled_at_idx"
  ON "gmail_messages"("user_id", "kind", "scheduled_at");
