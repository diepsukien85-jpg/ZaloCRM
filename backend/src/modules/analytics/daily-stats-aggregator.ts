/**
 * daily-stats-aggregator.ts — ghi bảng daily_message_stats (trước 28/09/2026 KHÔNG code nào ghi → biểu đồ
 * uptime nick, thời gian phản hồi, hiệu suất nhóm luôn trống / 0).
 *
 * Mỗi giờ tính lại hôm nay + hôm qua (ngày giờ VN) từ bảng messages, 1 dòng / nick / ngày
 * (userId = chủ nick): tin gửi, tin nhận, hội thoại chưa đọc / chưa trả lời (chụp lúc tính, chỉ cập nhật
 * cho hôm nay), thời gian phản hồi trung bình (giây) ở chat 1-1: từ tin khách đầu lượt tới tin shop kế tiếp (≤ 24h).
 * Lần đầu (bảng trống) bù 30 ngày.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';

const VN_OFFSET_MS = 7 * 3_600_000;

/** Ngày VN (YYYY-MM-DD) + mốc UTC đầu / cuối ngày. Hàm thuần. */
export function vnDay(now: Date, daysAgo = 0): { date: string; from: Date; to: Date } {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const startVn = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate() - daysAgo);
  const from = new Date(startVn - VN_OFFSET_MS);
  return { date: new Date(startVn).toISOString().slice(0, 10), from, to: new Date(from.getTime() + 86_400_000) };
}

export async function aggregateDay(day: { date: string; from: Date; to: Date }, isToday: boolean): Promise<number> {
  return prisma.$executeRaw`
    WITH vol AS (
      SELECT c.zalo_account_id,
             COUNT(*) FILTER (WHERE m.sender_type = 'self')    AS sent,
             COUNT(*) FILTER (WHERE m.sender_type = 'contact') AS recv
        FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.sent_at >= ${day.from} AND m.sent_at < ${day.to} AND m.is_deleted = false
       GROUP BY 1
    ),
    seq AS (
      SELECT c.zalo_account_id, m.conversation_id, m.sender_type, m.sent_at,
             LAG(m.sender_type) OVER (PARTITION BY m.conversation_id ORDER BY m.sent_at) AS prev
        FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c."threadType" = 'user' AND m.is_deleted = false
         AND m.sent_at >= ${day.from} AND m.sent_at < ${day.to}
    ),
    starts AS (
      SELECT * FROM seq WHERE sender_type = 'contact' AND (prev IS NULL OR prev = 'self')
    ),
    rt AS (
      SELECT s.zalo_account_id,
             EXTRACT(EPOCH FROM (
               SELECT MIN(m2.sent_at) FROM messages m2
                WHERE m2.conversation_id = s.conversation_id AND m2.sender_type = 'self'
                  AND m2.sent_at > s.sent_at AND m2.sent_at < s.sent_at + interval '24 hours'
             ) - s.sent_at) AS sec
        FROM starts s
    ),
    rta AS (SELECT zalo_account_id, ROUND(AVG(sec))::int AS avg_rt FROM rt WHERE sec IS NOT NULL GROUP BY 1),
    snap AS (
      SELECT zalo_account_id,
             COUNT(*) FILTER (WHERE unread_count > 0)                     AS unread,
             COUNT(*) FILTER (WHERE unread_count > 0 AND is_replied = false) AS unreplied
        FROM conversations GROUP BY 1
    )
    INSERT INTO daily_message_stats
      (id, org_id, user_id, zalo_account_id, stat_date, messages_sent, messages_received, messages_unread, messages_unreplied, avg_response_time_seconds)
    SELECT gen_random_uuid()::text, za.org_id, za.owner_user_id, za.id, ${day.date}::date,
           COALESCE(v.sent, 0), COALESCE(v.recv, 0),
           CASE WHEN ${isToday} THEN COALESCE(sn.unread, 0) ELSE 0 END,
           CASE WHEN ${isToday} THEN COALESCE(sn.unreplied, 0) ELSE 0 END,
           r.avg_rt
      FROM zalo_accounts za
      LEFT JOIN vol v ON v.zalo_account_id = za.id
      LEFT JOIN rta r ON r.zalo_account_id = za.id
      LEFT JOIN snap sn ON sn.zalo_account_id = za.id
     WHERE za.owner_user_id IS NOT NULL AND (v.sent IS NOT NULL OR ${isToday})
    ON CONFLICT (user_id, zalo_account_id, stat_date) DO UPDATE SET
      messages_sent = EXCLUDED.messages_sent,
      messages_received = EXCLUDED.messages_received,
      avg_response_time_seconds = EXCLUDED.avg_response_time_seconds,
      messages_unread = CASE WHEN ${isToday} THEN EXCLUDED.messages_unread ELSE daily_message_stats.messages_unread END,
      messages_unreplied = CASE WHEN ${isToday} THEN EXCLUDED.messages_unreplied ELSE daily_message_stats.messages_unreplied END
  `;
}

/** Tính lại `days` ngày gần nhất (0 = hôm nay). */
export async function aggregateRecentDays(days: number, now = new Date()): Promise<void> {
  for (let i = 0; i < days; i++) {
    const t = Date.now();
    const n = await aggregateDay(vnDay(now, i), i === 0);
    if (days > 2) logger.info(`[daily-stats] ${vnDay(now, i).date}: ${n} dòng (${Date.now() - t}ms)`);
  }
}

let timer: NodeJS.Timeout | null = null;
export function startDailyStatsAggregator(): void {
  if (timer) return;
  const run = async (first: boolean) => {
    try {
      const empty = first && (await prisma.dailyMessageStat.count()) === 0;
      await aggregateRecentDays(empty ? 30 : 2);
    } catch (err) {
      logger.warn('[daily-stats] tổng hợp lỗi:', err);
    }
  };
  setTimeout(() => void run(true), 90_000).unref?.();
  timer = setInterval(() => void run(false), 60 * 60_000);
  timer.unref?.();
}
