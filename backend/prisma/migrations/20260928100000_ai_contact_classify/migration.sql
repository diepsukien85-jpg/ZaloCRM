-- AI tự phân loại người nhắn 1-1: Khách Hàng / Nhân Viên / Người Thân (theo thẻ Zalo). Idempotent.
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "classify_contacts" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "label_groups" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "owner_title" TEXT;
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "ask_delay_minutes" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "ask_template" TEXT;
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "staff_guide" TEXT;
ALTER TABLE "ai_auto_reply_logs" ADD COLUMN IF NOT EXISTS "audience" TEXT NOT NULL DEFAULT 'customer';

CREATE TABLE IF NOT EXISTS "ai_contact_classes" (
  "id" TEXT PRIMARY KEY,
  "org_id" TEXT NOT NULL,
  "zalo_account_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "group" TEXT NOT NULL DEFAULT 'unknown',       -- customer | staff | family | other | unknown
  "state" TEXT NOT NULL DEFAULT 'classified',    -- classified | asking | asked | unresolved | owner_cleared
  "source" TEXT,                                 -- label | ai | answer
  "confidence" DOUBLE PRECISION,
  "reason" TEXT,
  "label_applied" BOOLEAN NOT NULL DEFAULT false,
  "ask_due_at" TIMESTAMP(3),
  "asked_at" TIMESTAMP(3),
  "answered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_contact_classes_conversation_id_key" ON "ai_contact_classes" ("conversation_id");
CREATE INDEX IF NOT EXISTS "ai_contact_classes_state_ask_due_at_idx" ON "ai_contact_classes" ("state", "ask_due_at");
CREATE INDEX IF NOT EXISTS "ai_contact_classes_zalo_account_id_updated_at_idx" ON "ai_contact_classes" ("zalo_account_id", "updated_at");
