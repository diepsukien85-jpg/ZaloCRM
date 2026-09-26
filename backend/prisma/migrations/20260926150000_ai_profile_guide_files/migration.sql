-- AI tự trả lời: lưu tài liệu tham khảo của file skill (.skill/.zip). Idempotent.
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "guide_files" JSONB NOT NULL DEFAULT '[]';
