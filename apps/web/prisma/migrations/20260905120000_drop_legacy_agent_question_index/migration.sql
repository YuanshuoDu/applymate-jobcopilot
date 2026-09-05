-- NOT FOR PRODUCTION until the AH2 GA checklist, seven-day legacy-traffic
-- evidence, and owner approval are complete.
--
-- This migration intentionally removes one unused legacy index only. It does
-- not drop a table, column, row, sequence, or foreign key. The inventory and
-- impact matrix are the approval record for this exact object.
DROP INDEX IF EXISTS "AgentRunQuestion_userId_runId_answeredAt_idx";
