export function appSecret(): string {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 32) throw new Error('APP_SECRET phải có tối thiểu 32 ký tự (xem .env.example)');
  return s;
}
export const env = {
  get databaseUrl() { return process.env.DATABASE_URL ?? ''; },
  get allowSignup() { return (process.env.ALLOW_SIGNUP ?? 'true') !== 'false'; },
  get demoMode() { return process.env.AI_DEMO_MODE === 'true'; },
  get uploadDir() { return process.env.UPLOAD_DIR ?? './storage'; },
  get maxUploadBytes() { return Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024; },
  get cronSecret() { return process.env.CRON_SECRET ?? ''; },
};
