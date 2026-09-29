/**
 * conversation-search.ts — tìm hội thoại kiểu Zalo: KHÔNG phân biệt dấu / hoa thường, gõ 1 phần là ra,
 * nhiều từ thì từ nào cũng phải có (thứ tự tuỳ ý). Tìm trong: tên khách, tên CRM, tên Zalo & tên gợi nhớ
 * của bạn bè ở nick đó, tên nhóm, SĐT (bỏ ký tự không phải số, 0xxx ≈ 84xxx), và NỘI DUNG tin chữ ở chat 1-1
 * (bảng dm_message_search + index trigram, trigger tự cập nhật — xem migration 20260928200000).
 * (28/09/2026 — trước đây chỉ tìm tên / SĐT khách, phân biệt dấu, không tìm được tên nhóm.)
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';

const FROM = 'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ';
const TO = 'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd';

/** Hàm thuần: bỏ dấu tiếng Việt + thường hoá (giống translate() trong SQL). */
export function foldVi(s: string): string {
  const lower = s.normalize('NFC').toLowerCase();
  let out = '';
  for (const ch of lower) { const i = FROM.indexOf(ch); out += i >= 0 ? TO[i] : ch; }
  return out;
}

/** Hàm thuần: tách từ khoá tìm kiếm (tối đa 6 từ, bỏ ký tự đặc biệt). */
export function searchTokens(q: string): string[] {
  return foldVi(q).replace(/[%_\\]/g, ' ').split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
}

/** Id hội thoại khớp từ khoá (tối đa `limit`), trong phạm vi tổ chức. */
export async function searchConversationIds(orgId: string, q: string, limit = 1000): Promise<string[]> {
  const tokens = searchTokens(q);
  if (!tokens.length) return [];
  const digits = q.replace(/\D/g, '');
  const phoneLike = digits.length >= 4 ? (digits.startsWith('0') ? digits.slice(1) : digits.startsWith('84') ? digits.slice(2) : digits) : null;
  const fold = (col: Prisma.Sql) => Prisma.sql`translate(lower(normalize(coalesce(${col}, ''), NFC)), ${FROM}, ${TO})`;
  const hay = Prisma.sql`(${fold(Prisma.sql`ct.full_name`)} || ' ' || ${fold(Prisma.sql`ct.crm_name`)} || ' ' || ${fold(Prisma.sql`cv.group_name`)}
    || ' ' || ${fold(Prisma.sql`f.zalo_display_name`)} || ' ' || ${fold(Prisma.sql`f.alias_in_nick`)})`;
  const nameCond = Prisma.join(tokens.map((t) => Prisma.sql`${hay} LIKE ${'%' + t + '%'}`), ' AND ');
  const phoneCond = phoneLike
    ? Prisma.sql`OR regexp_replace(coalesce(ct.phone, '') || ' ' || coalesce(ct.phone_2, '') || ' ' || coalesce(ct.phone_normalized, ''), '\\D', '', 'g') LIKE ${'%' + phoneLike + '%'}`
    : Prisma.empty;
  const byName = prisma.$queryRaw<Array<{ id: string }>>`
    SELECT cv.id
      FROM conversations cv
      LEFT JOIN contacts ct ON ct.id = cv.contact_id
      LEFT JOIN friends f ON f.zalo_account_id = cv.zalo_account_id AND f.zalo_uid_in_nick = cv.external_thread_id
     WHERE cv.org_id = ${orgId} AND ((${nameCond}) ${phoneCond})
     ORDER BY cv.last_message_at DESC NULLS LAST
     LIMIT ${limit}`;
  // Nội dung: cả CỤM từ khoá đúng thứ tự trong 1 tin (vd "nguyen tien" — không lấy tin có "nguyễn" … "tiền" rời rạc),
  // tối thiểu 3 ký tự để index trigram dùng được.
  const phrase = tokens.join(' ');
  const byContent = phrase.length >= 3
    ? prisma.$queryRaw<Array<{ id: string }>>`
        SELECT s.conversation_id AS id
          FROM dm_message_search s JOIN conversations cv ON cv.id = s.conversation_id
         WHERE cv.org_id = ${orgId} AND s.folded LIKE ${'%' + phrase + '%'}
         GROUP BY s.conversation_id
         ORDER BY max(s.sent_at) DESC
         LIMIT 300`.catch(() => [] as Array<{ id: string }>) // bảng phụ chưa có (chưa chạy migration) → bỏ qua
    : Promise.resolve([] as Array<{ id: string }>);
  const [a, b] = await Promise.all([byName, byContent]);
  return [...new Set([...a.map((r) => r.id), ...b.map((r) => r.id)])].slice(0, limit);
}
