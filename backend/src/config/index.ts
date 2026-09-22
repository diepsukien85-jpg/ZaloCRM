/**
 * Centralized configuration loader.
 * All environment variables are read once at startup and typed here.
 */

// SECURITY FIX (A2): JWT_SECRET and ENCRYPTION_KEY must NOT fall back to dev
// defaults when NODE_ENV=production. Webhook signature forgery / token forgery
// possible if dev defaults leak to a prod container with missing env vars.
const isProd = process.env.NODE_ENV === 'production';

const DEV_JWT_FALLBACK = 'dev-secret-change-me';
const DEV_ENC_FALLBACK = 'dev-key-change-me-16b';

export function envValue(name: string): string | undefined {
  const value = process.env[name];
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return '';
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") return trimmed;
  const commentAt = trimmed.search(/\s+#/);
  return (commentAt >= 0 ? trimmed.slice(0, commentAt) : trimmed).trim();
}

function requireSecret(name: string, devFallback: string, value: string | undefined): string {
  if (isProd) {
    if (!value || value === devFallback || value.length < 32) {
      // Fail-fast: better to crash boot than run prod with forgeable secrets.
      throw new Error(
        `[config] FATAL: ${name} must be set (≥32 chars, not the dev default) when NODE_ENV=production. ` +
        `Set ${name} in environment before starting the server.`,
      );
    }
    return value;
  }
  return value || devFallback;
}

export const config = {
  port: parseInt(envValue('PORT') || '3000'),
  host: envValue('HOST') || '0.0.0.0',
  nodeEnv: envValue('NODE_ENV') || 'development',
  jwtSecret: requireSecret('JWT_SECRET', DEV_JWT_FALLBACK, envValue('JWT_SECRET')),
  encryptionKey: requireSecret('ENCRYPTION_KEY', DEV_ENC_FALLBACK, envValue('ENCRYPTION_KEY')),
  databaseUrl: envValue('DATABASE_URL') || 'postgresql://crmuser:password@localhost:5432/zalocrm',
  uploadDir: envValue('UPLOAD_DIR') || '/var/lib/zalo-crm/files',
  appUrl: envValue('APP_URL') || 'http://localhost:3000',

  /* --- Kho ảnh/video/file khung chat: đĩa cục bộ + đồng bộ Google Drive ---
   * Thay Cloudflare R2 từ 2026-09-22 để cắt chi phí. Xem shared/storage/media-store.ts. */
  mediaDir: envValue('MEDIA_DIR') || 'data/media',
  // Đĩa chỉ giữ bản nóng; quá hạn thì xoá, cần lại thì kéo về từ Drive.
  // 0 = không bao giờ dọn. Đo 22/09/2026: ~148k file/ngày ≈ 19 GiB/ngày,
  // nên 3 ngày ≈ 57 GiB — đó là lý do KHÔNG được để số này lớn.
  mediaLocalRetentionDays: parseInt(envValue('MEDIA_LOCAL_RETENTION_DAYS') || '3'),
  // Phao cứu sinh: đĩa tụt dưới ngưỡng này thì dọn theo TUỔI kể cả khi chưa xác
  // nhận được bản sao trên Drive. Thà mất ảnh cũ còn hơn treo cả máy Mac mini.
  mediaMinFreeGb: parseInt(envValue('MEDIA_MIN_FREE_GB') || '20'),
  // Số file đẩy lên Drive song song. Nối tiếp (1) thì 148k file/ngày không kịp.
  mediaUploadConcurrency: parseInt(envValue('MEDIA_UPLOAD_CONCURRENCY') || '6'),
  // Vòng đối chiếu chỉ soi mấy ngày gần nhất — liệt kê cả cửa sổ giữ bản nóng ở
  // quy mô này là hàng trăm nghìn file mỗi lượt, quá tốn.
  mediaReconcileWindowDays: parseInt(envValue('MEDIA_RECONCILE_WINDOW_DAYS') || '2'),
  // Xoá luôn thư mục ngày cũ trên Drive sau ngần này ngày. 0 = giữ mãi.
  // 5TB / ~19 GiB mỗi ngày ≈ 270 ngày mới đầy.
  driveRetentionDays: parseInt(envValue('DRIVE_RETENTION_DAYS') || '0'),
  // Thư mục Drive chứa bản sao. Trống → tự tạo/tìm theo tên ở gốc My Drive.
  driveMediaFolderId: envValue('DRIVE_MEDIA_FOLDER_ID') || '',
  driveMediaFolderName: envValue('DRIVE_MEDIA_FOLDER_NAME') || 'ZaloCRM-Media',
  // OAuth của TÀI KHOẢN GOOGLE THẬT — service account KHÔNG upload được nội dung
  // vào My Drive ("Service Accounts do not have storage quota"). Tạo bằng
  // `npm run drive:setup`.
  driveOauthClientPath: envValue('DRIVE_OAUTH_CLIENT') || '~/.config/gcp/drive-oauth-client.json',
  driveOauthTokenPath: envValue('DRIVE_OAUTH_TOKEN') || '~/.config/gcp/drive-oauth-token.json',
  // Chu kỳ quét đối chiếu hai chiều (phút). 0 = tắt vòng nền.
  mediaSyncIntervalMinutes: parseInt(envValue('MEDIA_SYNC_INTERVAL_MINUTES') || '15'),

  /* --- S3 cũ: CHỈ còn dùng để NHẬN DIỆN url tồn trong DB trước 2026-09-22 ---
   * Không còn client S3 nào ghi lên đây nữa (r2-client.ts đã xoá). */
  s3Endpoint: envValue('S3_ENDPOINT') || '',
  s3PublicUrl: envValue('S3_PUBLIC_URL') || '',

  aiDefaultProvider: envValue('AI_DEFAULT_PROVIDER') || 'anthropic',
  aiDefaultModel: envValue('AI_DEFAULT_MODEL') || 'claude-sonnet-4-6',

  /* Legacy keys (kept for backward compat) */
  anthropicApiKey: envValue('ANTHROPIC_API_KEY') || envValue('ANTHROPIC_AUTH_TOKEN') || '',
  geminiApiKey: envValue('GEMINI_API_KEY') || envValue('GEMINI_AUTH_TOKEN') || '',

  /* --- AI Provider configs --- */
  anthropicBaseUrl: envValue('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com',
  anthropicAuthToken: envValue('ANTHROPIC_AUTH_TOKEN') || envValue('ANTHROPIC_API_KEY') || '',
  anthropicDefaultOpusModel: envValue('ANTHROPIC_DEFAULT_OPUS_MODEL') || '',
  anthropicDefaultSonnetModel: envValue('ANTHROPIC_DEFAULT_SONNET_MODEL') || '',
  anthropicDefaultHaikuModel: envValue('ANTHROPIC_DEFAULT_HAIKU_MODEL') || '',

  /* --- Claude Code CLI provider (gói cước Pro/Max qua OAuth, KHÔNG dùng API key) --- */
  claudeCliEnabled: (envValue('CLAUDE_CLI_ENABLED') || '') === '1',
  claudeCliBin: envValue('CLAUDE_CLI_BIN') || 'claude',
  claudeCliModel: envValue('CLAUDE_CLI_MODEL') || 'claude-sonnet-4-6',

  geminiBaseUrl: envValue('GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com',
  geminiAuthToken: envValue('GEMINI_AUTH_TOKEN') || envValue('GEMINI_API_KEY') || '',
  geminiDefaultProModel: envValue('GEMINI_DEFAULT_PRO_MODEL') || '',
  geminiDefaultFlashModel: envValue('GEMINI_DEFAULT_FLASH_MODEL') || '',

  openaiBaseUrl: envValue('OPENAI_BASE_URL') || 'https://api.openai.com',
  openaiAuthToken: envValue('OPENAI_AUTH_TOKEN') || '',
  openaiDefaultGpt4oModel: envValue('OPENAI_DEFAULT_GPT4O_MODEL') || '',
  openaiDefaultGpt4oMiniModel: envValue('OPENAI_DEFAULT_GPT4O_MINI_MODEL') || '',

  qwenBaseUrl: envValue('QWEN_BASE_URL') || 'https://dashscope.aliyuncs.com',
  qwenAuthToken: envValue('QWEN_AUTH_TOKEN') || '',
  qwenDefaultPlusModel: envValue('QWEN_DEFAULT_PLUS_MODEL') || '',
  qwenDefaultTurboModel: envValue('QWEN_DEFAULT_TURBO_MODEL') || '',
  qwenDefaultMaxModel: envValue('QWEN_DEFAULT_MAX_MODEL') || '',

  kimiBaseUrl: envValue('KIMI_BASE_URL') || 'https://api.moonshot.cn',
  kimiAuthToken: envValue('KIMI_AUTH_TOKEN') || '',
  kimiDefaultMoonshotV1Model: envValue('KIMI_DEFAULT_MOONSHOT_V1_MODEL') || '',

  isProduction: process.env.NODE_ENV === 'production',
};
