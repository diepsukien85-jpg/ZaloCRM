/**
 * bao-cao-phan-hoi.ts — lệnh cho Tiểu Mỹ / Claude Code đọc chỉ số nhân viên phản hồi khách Zalo (CHỈ ĐỌC).
 *
 *   cd ~/apps/zalocrm/backend && node --env-file=.env dist/cli/bao-cao-phan-hoi.js [tuỳ chọn]
 *     --hom-nay (mặc định) | --hom-qua | --7-ngay | --30-ngay | --tu YYYY-MM-DD --den YYYY-MM-DD
 *     --nick "Minh Mẫn"   chỉ 1 nick (tìm gần đúng theo tên)
 *     --cham 30           ngưỡng trả lời chậm (phút)
 *     --json              in JSON đầy đủ (mọi khách đang chờ) thay vì văn bản
 *     --gui-telegram      gửi luôn báo cáo 21:00 (dùng khi Sếp bảo "gửi báo cáo ngay")
 */
import { prisma } from '../shared/database/prisma-client.js';
import { computeResponseReport, formatResponseReport, vnDayStart } from '../modules/analytics/response-report.js';
import { sendDailyReports } from '../modules/analytics/daily-report.js';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}
const has = (name: string) => process.argv.includes(name);
const vnDate = (s: string) => new Date(`${s}T00:00:00+07:00`);

async function main() {
  const now = new Date();
  if (has('--gui-telegram')) {
    console.log(`Đã gửi báo cáo cho ${await sendDailyReports(now)} tổ chức.`);
    return;
  }
  let from = vnDayStart(now, 0); let to = now; let label = 'hôm nay';
  if (has('--hom-qua')) { from = vnDayStart(now, 1); to = vnDayStart(now, 0); label = 'hôm qua'; }
  if (has('--7-ngay')) { from = vnDayStart(now, 7); label = '7 ngày qua'; }
  if (has('--30-ngay')) { from = vnDayStart(now, 30); label = '30 ngày qua'; }
  if (arg('--tu')) { from = vnDate(arg('--tu')!); to = arg('--den') ? new Date(vnDate(arg('--den')!).getTime() + 86_400_000) : now; label = `${arg('--tu')} → ${arg('--den') ?? 'nay'}`; }
  const slowMinutes = Number(arg('--cham')) || 30;
  const orgs = await prisma.organization.findMany({ where: { zaloAccounts: { some: { purged: false } } }, select: { id: true, name: true } });
  for (const o of orgs) {
    const r = await computeResponseReport({ orgId: o.id, from, to, slowMinutes, now, nickFilter: arg('--nick') ?? undefined });
    if (has('--json')) { console.log(JSON.stringify({ org: o.name, label, ...r }, null, 1)); continue; }
    console.log(formatResponseReport(r, `Phản hồi khách ${label} — ${o.name}`, 'https://crm.shinsulab.com')
      .replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error('Lỗi:', err?.message ?? err); process.exit(1); });
