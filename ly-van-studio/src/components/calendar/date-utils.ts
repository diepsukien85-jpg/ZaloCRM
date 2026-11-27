/** Mọi phép tính ngày theo múi giờ Asia/Ho_Chi_Minh (UTC+7, không có giờ mùa hè). Khoá ngày dạng YYYY-MM-DD. */
const OFF = 7 * 3600 * 1000;
export const dayKey = (iso: string | Date) => new Date(new Date(iso).getTime() + OFF).toISOString().slice(0, 10);
export const timeOf = (iso: string | Date) => new Date(new Date(iso).getTime() + OFF).toISOString().slice(11, 16);
export const todayKey = () => dayKey(new Date());
export const addDays = (key: string, n: number) => { const d = new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const addMonths = (key: string, n: number) => { const d = new Date(`${key.slice(0, 8)}01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
/** Thứ Hai = 0 */
export const weekdayIdx = (key: string) => (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7;
export const startOfWeek = (key: string) => addDays(key, -weekdayIdx(key));
export const vnToIso = (key: string, hhmm: string) => new Date(`${key}T${hhmm}:00+07:00`).toISOString();
export const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
export const dayLabel = (key: string) => { const [, m, d] = key.split('-'); return `${WEEKDAYS[weekdayIdx(key)]} ${Number(d)}/${Number(m)}`; };
export const monthLabel = (key: string) => `Tháng ${Number(key.slice(5, 7))}/${key.slice(0, 4)}`;
export const toLocalInput = (iso: string) => `${dayKey(iso)}T${timeOf(iso)}`;
export const fromLocalInput = (v: string) => vnToIso(v.slice(0, 10), v.slice(11, 16));
