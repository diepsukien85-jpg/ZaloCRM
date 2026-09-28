-- Tìm theo NỘI DUNG tin nhắn chat 1-1 (không dấu, 1 phần từ). Bảng phụ nhỏ (chỉ tin chữ ở hội thoại 1-1) + index trigram,
-- trigger tự cập nhật — tìm thẳng trên bảng messages (~1 triệu dòng, phần lớn tin nhóm) mất 4-5 giây. Idempotent.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION fold_vi(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT translate(lower(coalesce(t, '')),
    'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd')
$$;

CREATE TABLE IF NOT EXISTS dm_message_search (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sent_at TIMESTAMP(3) NOT NULL,
  folded TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dm_message_search_folded_trgm ON dm_message_search USING gin (folded gin_trgm_ops);
CREATE INDEX IF NOT EXISTS dm_message_search_conv_sent ON dm_message_search (conversation_id, sent_at DESC);

CREATE OR REPLACE FUNCTION dm_message_search_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF NEW.content_type = 'text' AND NEW.is_deleted = false AND coalesce(NEW.content, '') <> ''
       AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = NEW.conversation_id AND c."threadType" = 'user') THEN
      INSERT INTO dm_message_search (message_id, conversation_id, sent_at, folded)
      VALUES (NEW.id, NEW.conversation_id, NEW.sent_at, fold_vi(left(NEW.content, 2000)))
      ON CONFLICT (message_id) DO UPDATE SET folded = EXCLUDED.folded, sent_at = EXCLUDED.sent_at;
    ELSIF TG_OP = 'UPDATE' THEN
      DELETE FROM dm_message_search WHERE message_id = NEW.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Không bao giờ làm hỏng việc lưu tin nhắn.
    RAISE WARNING 'dm_message_search_sync lỗi: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messages_dm_search_ins ON messages;
CREATE TRIGGER messages_dm_search_ins AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION dm_message_search_sync();
DROP TRIGGER IF EXISTS messages_dm_search_upd ON messages;
CREATE TRIGGER messages_dm_search_upd AFTER UPDATE OF content, is_deleted ON messages FOR EACH ROW EXECUTE FUNCTION dm_message_search_sync();

INSERT INTO dm_message_search (message_id, conversation_id, sent_at, folded)
SELECT m.id, m.conversation_id, m.sent_at, fold_vi(left(m.content, 2000))
  FROM messages m JOIN conversations c ON c.id = m.conversation_id
 WHERE c."threadType" = 'user' AND m.content_type = 'text' AND m.is_deleted = false AND coalesce(m.content, '') <> ''
ON CONFLICT (message_id) DO NOTHING;
