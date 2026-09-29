-- AI tự trả lời: vòng tự học (feedback loop). Idempotent, chỉ thêm cột/bảng.
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "learning_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "last_learned_at" TIMESTAMP(3);

ALTER TABLE "ai_auto_reply_logs" ADD COLUMN IF NOT EXISTS "customer_text" TEXT;
ALTER TABLE "ai_auto_reply_logs" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
ALTER TABLE "ai_auto_reply_logs" ADD COLUMN IF NOT EXISTS "outcome_at" TIMESTAMP(3);
ALTER TABLE "ai_auto_reply_logs" ADD COLUMN IF NOT EXISTS "staff_followup" TEXT;
ALTER TABLE "ai_auto_reply_logs" ADD COLUMN IF NOT EXISTS "customer_followup" TEXT;
ALTER TABLE "ai_auto_reply_logs" ADD COLUMN IF NOT EXISTS "feedback" TEXT;
ALTER TABLE "ai_auto_reply_logs" ADD COLUMN IF NOT EXISTS "feedback_note" TEXT;
ALTER TABLE "ai_auto_reply_logs" ADD COLUMN IF NOT EXISTS "corrected_reply" TEXT;
ALTER TABLE "ai_auto_reply_logs" ADD COLUMN IF NOT EXISTS "feedback_by" TEXT;
ALTER TABLE "ai_auto_reply_logs" ADD COLUMN IF NOT EXISTS "feedback_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "ai_auto_reply_logs_outcome_created_at_idx" ON "ai_auto_reply_logs" ("outcome", "created_at");

CREATE TABLE IF NOT EXISTS "ai_lessons" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "zalo_account_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'daily',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_lessons_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ai_lessons_zalo_account_id_active_idx" ON "ai_lessons" ("zalo_account_id", "active");
