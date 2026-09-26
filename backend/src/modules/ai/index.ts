/**
 * AI plugin — route AI assistant (Phase 4 batch 2 migrate).
 * Route handler giữ NGUYÊN; lớp mỏng cho plugin-host nạp.
 */
import type { ZaloCrmPlugin } from '../../plugin-api/index.js';
import { aiRoutes } from './ai-routes.js';
import { dailyBriefRoutes } from './daily-brief-routes.js';
import { aiAutoReplyRoutes } from './auto-reply/routes.js';

export const aiPlugin: ZaloCrmPlugin = {
  name: 'ai',
  version: '1.0.0',
  edition: 'core',
  async register({ app }) {
    await app.register(aiRoutes);
    // Popup "Hỏi AI về khách hôm nay" — snapshot + hỏi đáp.
    await app.register(dailyBriefRoutes);
    // AI tự trả lời khách 1-1 theo thẻ phân loại + kho kịch bản.
    await app.register(aiAutoReplyRoutes);
  },
};
