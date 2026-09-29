-- AI tự trả lời: gộp "Vai trò & xưng hô" + "Lời dặn" thành một "Hướng dẫn cho AI"
-- (viết tay hoặc tải file skill). Idempotent.
ALTER TABLE "ai_auto_reply_profiles" ADD COLUMN IF NOT EXISTS "guide_file_name" TEXT;

UPDATE "ai_auto_reply_profiles"
SET "extra_instruction" = 'Vai trò & xưng hô: ' || "persona"
      || CASE WHEN COALESCE(TRIM("extra_instruction"), '') = '' THEN '' ELSE E'\n\n' || "extra_instruction" END,
    "persona" = NULL
WHERE COALESCE(TRIM("persona"), '') <> '';
