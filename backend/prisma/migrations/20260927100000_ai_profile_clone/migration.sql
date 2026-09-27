-- AI tự trả lời: "Học theo nick khác" — nick mới chép hướng dẫn + bài học từ nick mẫu. Idempotent.
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "cloned_from_account_id" TEXT;
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "cloned_at" TIMESTAMP(3);
-- Bài học chép từ nick mẫu (null = bài học của chính nick). Sửa / dạy lại thì thành của riêng nick.
ALTER TABLE "ai_lessons" ADD COLUMN IF NOT EXISTS "inherited_from_account_id" TEXT;
