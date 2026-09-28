/**
 * engagement-cron.ts — Daily cron for Phase 8 Engagement Heatmap.
 *
 * Schedule: 02:30 VN time (19:30 UTC prev day).
 * Tasks:
 *   1. Recompute pattern/trend/score for every contact (over 28-day window)
 *   2. Cleanup engagement_daily rows older than 84 days (12 weeks rolling)
 *
 * Runtime: ~2-5 minutes cho org 5000 contacts. Batch processing 200 per chunk.
 */
import cron from 'node-cron';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { recomputeContactEngagement } from './engagement-service.js';

const CLEANUP_RETENTION_DAYS = 84;

export function startEngagementCron(): void {
  // 02:30 giờ VN (trước đây chạy 19:30 tối — giờ cao điểm — vì lệch múi giờ)
  cron.schedule('30 2 * * *', async () => {
    logger.info('[engagement-cron] Daily classification + cleanup starting');
    try {
      await runEngagementCron();
    } catch (err) {
      logger.error('[engagement-cron] error', err);
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' });
  logger.info('[engagement-cron] scheduled daily at 19:30 UTC (02:30 VN)');
}

export async function runEngagementCron(): Promise<{
  contactsReclassified: number;
  rowsCleaned: number;
  durationMs: number;
}> {
  const start = Date.now();

  // 1. Recompute pattern for contacts that have engagement data in last 28 days
  const cutoff28 = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
  const contactsWithData = await prisma.contactEngagementDaily.findMany({
    where: { date: { gte: cutoff28 } },
    select: { contactId: true },
    distinct: ['contactId'],
  });

  let contactsReclassified = 0;
  for (const c of contactsWithData) {
    try {
      await recomputeContactEngagement(c.contactId);
      contactsReclassified++;
    } catch (err) {
      logger.warn('[engagement-cron] recompute failed', { contactId: c.contactId, err: (err as Error).message });
    }
  }

  // 2. Cleanup rows older than 84 days
  const cutoffCleanup = new Date(Date.now() - CLEANUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cleanup = await prisma.contactEngagementDaily.deleteMany({
    where: { date: { lt: cutoffCleanup } },
  });

  // 3. Phase 8.C — Recompute Priority Score cho mọi contact (sau khi engagement
  // đã classify lại để priority phản ánh trend mới nhất). Sẽ tự skip nếu không
  // đổi (saves index churn).
  const { recomputeContactPriority } = await import('./priority-service.js');
  const allContacts = await prisma.contact.findMany({ select: { id: true } });
  let prioritiesUpdated = 0;
  for (const c of allContacts) {
    const result = await recomputeContactPriority(c.id);
    if (result !== null) prioritiesUpdated++;
  }

  const result = {
    contactsReclassified,
    prioritiesUpdated,
    rowsCleaned: cleanup.count,
    durationMs: Date.now() - start,
  };
  logger.info('[engagement-cron] done', result);
  return result;
}
