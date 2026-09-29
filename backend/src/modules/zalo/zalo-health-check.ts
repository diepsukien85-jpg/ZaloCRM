/**
 * zalo-health-check.ts — Cron-based health monitor for Zalo account connections.
 * Runs every 5 minutes to detect disconnected accounts and auto-reconnect them.
 * Also runs a daily session refresh at 04:00 UTC to keep cookies fresh.
 */
import cron from 'node-cron';
import { Prisma } from '@prisma/client';
import { zaloPool } from './zalo-pool.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';

export function startZaloHealthCheck(): void {
  // Every 5 minutes: check all accounts with saved sessions
  cron.schedule('*/5 * * * *', async () => {
    try {
      const accounts = await prisma.zaloAccount.findMany({
        where: {
          sessionData: { not: Prisma.JsonNull },
          status: { notIn: ['disconnected'] },
          archivedAt: null,
        },
        select: { id: true, displayName: true, sessionData: true, proxyUrl: true },
      });

      for (const acc of accounts) {
        const session = acc.sessionData as any;
        if (!session?.imei) continue;
        // ensureReconnecting tự bỏ qua nick đang connected/connecting/qr_pending hoặc
        // đã có chuỗi backoff chạy → an toàn gọi mỗi tick. Nick còn rớt → khởi chuỗi mới.
        logger.info(`[health-check] Ensuring reconnect for ${acc.displayName || acc.id}...`);
        zaloPool.ensureReconnecting(acc.id);
      }
    } catch (err) {
      logger.error('[health-check] Error during health check:', err);
    }
  });

  // 04:00 giờ VN (vắng khách — làm mới phiên đóng listener vài giây): refresh all sessions to keep cookies alive
  cron.schedule('0 4 * * *', async () => {
    logger.info('[health-check] Daily session refresh starting...');
    try {
      const accounts = await prisma.zaloAccount.findMany({
        where: {
          sessionData: { not: Prisma.JsonNull },
          status: { notIn: ['disconnected'] },
          archivedAt: null,
        },
        select: { id: true, sessionData: true, proxyUrl: true },
      });

      for (const acc of accounts) {
        const session = acc.sessionData as any;
        if (session?.imei) {
          zaloPool.disconnectForRefresh(acc.id);
          await new Promise((r) => setTimeout(r, 5000));
          zaloPool.reconnect(acc.id, session, acc.proxyUrl).catch((err) => {
            logger.warn(`[health-check] Daily refresh failed for ${acc.id}:`, err);
          });
        }
        // Stagger reconnects by 10 seconds per account to avoid rate limits
        await new Promise((r) => setTimeout(r, 10000));
      }
    } catch (err) {
      logger.error('[health-check] Error during daily refresh:', err);
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' });

  logger.info('[health-check] Zalo health check started (every 5 min + daily refresh at 04:00 UTC)');
}
