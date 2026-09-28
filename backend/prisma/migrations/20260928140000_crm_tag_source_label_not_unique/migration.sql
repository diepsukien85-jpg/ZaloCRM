-- ID thẻ Zalo chỉ duy nhất trong 1 nick → bỏ unique toàn hệ thống trên crm_tags.source_zalo_label_id. Idempotent.
DROP INDEX IF EXISTS "crm_tags_source_zalo_label_id_key";
ALTER TABLE "crm_tags" DROP CONSTRAINT IF EXISTS "crm_tags_source_zalo_label_id_key";
CREATE INDEX IF NOT EXISTS "crm_tags_source_zalo_label_id_idx" ON "crm_tags" ("source_zalo_label_id");
