/**
 * guardrails.ts — lớp chặn bằng CODE cho tin AI sắp gửi khách (hàm thuần, dễ test).
 *
 * Phỏng theo bộ lớp chặn của ZL-CRM (Thầy Nguyễn Tất Kiểm, Apache-2.0): dặn trong
 * prompt là chưa đủ, mô hình vẫn có thể chối là AI, chèn gạch ngang dài, hay bảo
 * khách gửi mật khẩu. Nên kiểm SAU khi AI viết, TRƯỚC khi gửi.
 */

/** Bỏ dấu + thường hoá để so khớp tiếng Việt ("bao gia" khớp "báo giá"). */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/** Chuẩn hoá tên thẻ để so: bỏ tiền tố "🔵 " của thẻ Zalo mirror, emoji, dấu, khoảng trắng thừa. */
export function normalizeTagName(name: string): string {
  return fold(String(name))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesAnyKeyword(text: string, keywords: string[]): string | null {
  const hay = fold(text);
  for (const kw of keywords) {
    const needle = fold(String(kw)).trim();
    if (needle && hay.includes(needle)) return kw;
  }
  return null;
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Không dùng dấu gạch ngang dài trong tin gửi khách. */
export function cleanStyle(text: string): string {
  return text
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/[—–]/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s+([,.])/g, '$1')
    .trim();
}

/* ── Không bao giờ chối là AI ─────────────────────────────────────────── */
const IDENTITY_Q = /(\bbot\b|\bai\b|tu dong|may tra loi|nguoi that|robot|chatgpt|tro ly ao)/;
const DENIAL = /(khong phai (la )?(bot|ai|may|robot|tro ly)|(em|minh|toi) la nguoi that|dang noi chuyen voi nguoi that|khong phai tra loi tu dong|khong dung ai)/;

export function asksIdentity(text: string): boolean {
  return IDENTITY_Q.test(fold(text));
}

const HONEST_LINE = 'Dạ tin này do trợ lý AI của shop trả lời ạ, nhân viên vẫn theo dõi và sẽ hỗ trợ trực tiếp khi cần.';

/** Thay dòng chối là AI bằng câu thành thật; khách hỏi thẳng mà tin không nhận là AI thì thêm một dòng. */
export function enforceHonesty(reply: string, customerText: string): { text: string; fixed: boolean } {
  let fixed = false;
  const lines = reply.split('\n').map((line) => {
    if (!DENIAL.test(fold(line))) return line;
    fixed = true;
    return HONEST_LINE;
  });
  let text = lines.join('\n');
  if (asksIdentity(customerText) && !/(\bai\b|tro ly)/.test(fold(text))) {
    text = `${text}\n${HONEST_LINE}`;
    fixed = true;
  }
  return { text, fixed };
}

/* ── Không bảo khách gửi mật khẩu / OTP qua chat ──────────────────────── */
const CRED = /(mat khau|password|\bpass\b|\botp\b|ma xac thuc|ma xac nhan|ma pin|so the|cvv)/;
const ASK_SEND = /(gui|nhan|cung cap|doc|cho (em|minh|shop)|de lai|chup)/;
const NEGATE = /(khong (duoc |nen |can )?(gui|cung cap|doc|chia se)|tuyet doi khong|dung (gui|cung cap)|khong bao gio)/;

export function enforceNoCredentials(reply: string): { text: string; fixed: boolean } {
  let fixed = false;
  const text = reply.split('\n').map((line) => {
    const f = fold(line);
    if (CRED.test(f) && ASK_SEND.test(f) && !NEGATE.test(f)) {
      fixed = true;
      return 'Anh/chị lưu ý tuyệt đối không gửi mật khẩu, mã OTP hay thông tin thẻ qua tin nhắn ạ.';
    }
    return line;
  }).join('\n');
  return { text, fixed };
}

/* ── Đọc JSON mô hình trả về ─────────────────────────────────────────── */
export type AiDecision = { action: 'reply' | 'handoff'; reply: string; reason: string };

export function parseDecision(raw: string): AiDecision | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const p = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const reply = typeof p.reply === 'string' ? p.reply.trim() : '';
    const reason = typeof p.reason === 'string' ? p.reason : '';
    const action = p.action === 'handoff' || !reply ? 'handoff' : 'reply';
    return { action, reply, reason };
  } catch {
    return null;
  }
}

/** Giờ hiện tại theo offset phút của org (0-23). */
export function localHour(now: Date, offsetMinutes: number): number {
  return new Date(now.getTime() + offsetMinutes * 60_000).getUTCHours();
}

/** Trong khung [hourStart, hourEnd) — hourEnd 24 nghĩa là tới hết ngày. */
export function withinHours(hour: number, hourStart: number, hourEnd: number): boolean {
  return hour >= hourStart && hour < hourEnd;
}
