-- AI tự trả lời theo thẻ phân loại + nhóm bỏ qua (2026-09-26)
-- Idempotent (IF NOT EXISTS) — prod áp SQL tay, chạy lại không lỗi.

CREATE TABLE IF NOT EXISTS "ai_auto_reply_configs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "trigger_tags" JSONB NOT NULL DEFAULT '[]',
    "account_ids" JSONB NOT NULL DEFAULT '[]',
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
    CONSTRAINT "ai_auto_reply_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_auto_reply_configs_org_id_key" ON "ai_auto_reply_configs" ("org_id");

CREATE TABLE IF NOT EXISTS "ai_playbook_entries" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "keywords" JSONB NOT NULL DEFAULT '[]',
    "content" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_playbook_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ai_playbook_entries_org_id_enabled_idx" ON "ai_playbook_entries" ("org_id", "enabled");

CREATE TABLE IF NOT EXISTS "ai_auto_reply_logs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "source_message_id" TEXT,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "content" TEXT,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_auto_reply_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ai_auto_reply_logs_org_id_created_at_idx" ON "ai_auto_reply_logs" ("org_id", "created_at");
CREATE INDEX IF NOT EXISTS "ai_auto_reply_logs_conversation_id_created_at_idx" ON "ai_auto_reply_logs" ("conversation_id", "created_at");

CREATE TABLE IF NOT EXISTS "ignored_groups" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "group_thread_id" TEXT NOT NULL,
    "group_name" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ignored_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ignored_groups_org_id_group_thread_id_key" ON "ignored_groups" ("org_id", "group_thread_id");
