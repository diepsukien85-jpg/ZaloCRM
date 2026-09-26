-- AI tự trả lời: cấu hình RIÊNG TỪNG NICK (2026-09-26). Idempotent.

CREATE TABLE IF NOT EXISTS "ai_auto_reply_profiles" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "zalo_account_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'dry_run',
    "trigger_tags" JSONB NOT NULL DEFAULT '[]',
    "hour_start" INTEGER NOT NULL DEFAULT 7,
    "hour_end" INTEGER NOT NULL DEFAULT 22,
    "debounce_seconds" INTEGER NOT NULL DEFAULT 20,
    "max_replies_per_day" INTEGER NOT NULL DEFAULT 300,
    "max_replies_per_conv_per_day" INTEGER NOT NULL DEFAULT 15,
    "skip_if_staff_replied_within_min" INTEGER NOT NULL DEFAULT 10,
    "blocked_keywords" JSONB NOT NULL DEFAULT '[]',
    "persona" TEXT,
    "extra_instruction" TEXT,
    "verify_grounding" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_auto_reply_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_auto_reply_profiles_zalo_account_id_key" ON "ai_auto_reply_profiles" ("zalo_account_id");
CREATE INDEX IF NOT EXISTS "ai_auto_reply_profiles_org_id_idx" ON "ai_auto_reply_profiles" ("org_id");

ALTER TABLE "ai_playbook_entries" ADD COLUMN IF NOT EXISTS "zalo_account_id" TEXT;
CREATE INDEX IF NOT EXISTS "ai_playbook_entries_org_id_zalo_account_id_idx" ON "ai_playbook_entries" ("org_id", "zalo_account_id");

ALTER TABLE "ai_auto_reply_logs" ADD COLUMN IF NOT EXISTS "zalo_account_id" TEXT;
CREATE INDEX IF NOT EXISTS "ai_auto_reply_logs_zalo_account_id_created_at_idx" ON "ai_auto_reply_logs" ("zalo_account_id", "created_at");

-- Chuyển cấu hình dùng chung cũ thành 1 profile cho MỖI nick đã chọn trong đó.
INSERT INTO "ai_auto_reply_profiles" (
    "id", "org_id", "zalo_account_id", "enabled", "mode", "trigger_tags", "hour_start", "hour_end",
    "debounce_seconds", "max_replies_per_day", "max_replies_per_conv_per_day",
    "skip_if_staff_replied_within_min", "blocked_keywords", "persona", "extra_instruction",
    "verify_grounding", "created_at", "updated_at")
SELECT gen_random_uuid()::text, c."org_id", a.id, c."enabled", c."mode", c."trigger_tags", c."hour_start", c."hour_end",
       c."debounce_seconds", c."max_replies_per_day", c."max_replies_per_conv_per_day",
       c."skip_if_staff_replied_within_min", c."blocked_keywords", c."persona", c."extra_instruction",
       c."verify_grounding", (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC')
FROM "ai_auto_reply_configs" c
CROSS JOIN LATERAL jsonb_array_elements_text(c."account_ids") AS a(id)
ON CONFLICT ("zalo_account_id") DO NOTHING;

UPDATE "ai_auto_reply_logs" l SET "zalo_account_id" = c."zalo_account_id"
FROM "conversations" c WHERE c."id" = l."conversation_id" AND l."zalo_account_id" IS NULL;
