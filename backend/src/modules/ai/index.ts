/**
 * AI plugin — route AI assistant (Phase 4 batch 2 migrate).
 * Route handler giữ NGUYÊN; lớp mỏng cho plugin-host nạp.
 */
import type { ZaloCrmPlugin } from '../../plugin-api/index.js';
import { aiRoutes } from './ai-routes.js';
import { aiAutoReplyRoutes } from './auto-reply/routes.js';

export const aiPlugin: ZaloCrmPlugin = {
  name: 'ai',
  version: '1.0.0',
  edition: 'core',
  async register({ app }) {
    // aiRoutes gồm cả 2 endpoint của popup "Hỏi AI về khách hàng hôm nay".
    // Nhánh này gộp chúng vào ai-routes.ts thay vì tách daily-brief-routes.ts,
    // nên KHÔNG đăng ký dailyBriefRoutes — đăng ký cả hai sẽ trùng đường dẫn
    // và Fastify chặn ngay lúc khởi động.
    await app.register(aiRoutes);
    // AI tự trả lời khách 1-1 theo thẻ phân loại + kho kịch bản.
    await app.register(aiAutoReplyRoutes);
  },
};
