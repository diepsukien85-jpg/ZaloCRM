-- AI tự trả lời: xưng hô theo giới tính Zalo + (các cột nâng cấp khác cùng đợt). Idempotent.
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "address_by_gender" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "self_pronoun" TEXT NOT NULL DEFAULT 'em';
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "use_product_catalog" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "send_product_images" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "notify_handoff" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "handoff_chat_id" TEXT;
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "handoff_pause_minutes" INTEGER NOT NULL DEFAULT 60;
