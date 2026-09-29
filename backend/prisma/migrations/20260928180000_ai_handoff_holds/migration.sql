-- AI chuyển người thật → gắn thẻ "Chờ người thật", nhớ thẻ cũ để trả lại khi người thật trả lời. Idempotent.
CREATE TABLE IF NOT EXISTS "ai_handoff_holds" (
  "id" TEXT PRIMARY KEY,
  "org_id" TEXT NOT NULL,
  "zalo_account_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "prev_label" TEXT,
  "reason" TEXT,
  "held_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "released_at" TIMESTAMP(3),
  "release_note" TEXT
);
CREATE INDEX IF NOT EXISTS "ai_handoff_holds_released_at_idx" ON "ai_handoff_holds" ("released_at");
CREATE INDEX IF NOT EXISTS "ai_handoff_holds_conversation_id_idx" ON "ai_handoff_holds" ("conversation_id");
