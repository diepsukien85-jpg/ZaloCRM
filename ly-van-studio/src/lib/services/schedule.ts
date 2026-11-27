export type SchedRow = { workflow_key: string; hour: number; minute: number; weekday: number | null; day_of_month: number | null; timezone: string; last_run_at: string | Date | null };

function parts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const o = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
  return { date: `${o.year}-${o.month}-${o.day}`, day: Number(o.day), hour: Number(o.hour) % 24, minute: Number(o.minute), weekday: wd };
}

/** Đến hạn chạy? Chỉ chạy một lần mỗi kỳ (ngày/tuần/tháng) sau mốc giờ đặt. Trả về khoá idempotency nếu đến hạn. */
export function dueKey(s: SchedRow, now = new Date()): string | null {
  const n = parts(now, s.timezone);
  if (s.workflow_key === 'weekly' && s.weekday != null && n.weekday !== s.weekday) return null;
  if (s.workflow_key === 'monthly' && s.day_of_month != null && n.day !== s.day_of_month) return null;
  if (n.hour * 60 + n.minute < s.hour * 60 + s.minute) return null;
  const key = `sched:${s.workflow_key}:${n.date}`;
  if (s.last_run_at) {
    const l = parts(new Date(s.last_run_at), s.timezone);
    if (l.date === n.date) return null;
  }
  return key;
}

/** Lần chạy kế tiếp (hiển thị UI) — duyệt tối đa 400 ngày. */
export function nextRun(s: SchedRow, now = new Date()): Date | null {
  for (let i = 0; i < 400 * 24 * 4; i++) {
    const t = new Date(now.getTime() + i * 15 * 60_000);
    const p = parts(t, s.timezone);
    if (p.hour * 60 + p.minute < s.hour * 60 + s.minute || p.hour * 60 + p.minute >= s.hour * 60 + s.minute + 15) continue;
    if (s.workflow_key === 'weekly' && s.weekday != null && p.weekday !== s.weekday) continue;
    if (s.workflow_key === 'monthly' && s.day_of_month != null && p.day !== s.day_of_month) continue;
    if (t.getTime() <= now.getTime()) continue;
    return t;
  }
  return null;
}
