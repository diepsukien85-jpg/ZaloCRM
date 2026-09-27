/**
 * context-builder.ts — gom ngữ cảnh + dựng prompt cho AI trả lời khách 1-1.
 *
 * Phỏng theo ZL-CRM (Thầy Nguyễn Tất Kiểm, Apache-2.0). Bốn nguồn:
 *   1. Lịch sử chat với khách (20 tin gần nhất)
 *   2. Hồ sơ CRM (tên, trạng thái, thẻ, ghi chú sale)
 *   3. Kho kịch bản (bộ khung trả lời) — mục khớp từ khoá lên trước
 *   4. Mẫu tin nhắn có sẵn
 * Cắt ngắn có kiểm soát: prompt dài vừa đắt vừa dễ khiến AI bịa.
 */
import { prisma } from '../../../shared/database/prisma-client.js';
import { clip, fold, matchesAnyKeyword } from './guardrails.js';
import type { GuideFile } from './config-service.js';

const HISTORY_LIMIT = 20;
const PLAYBOOK_LIMIT = 8;
const TEMPLATE_LIMIT = 6;
const PLAYBOOK_CHARS = 1200;
const TEMPLATE_CHARS = 300;
const MESSAGE_CHARS = 400;

export type AutoReplyContext = {
  customer: Record<string, unknown>;
  history: string[];
  pendingCustomerText: string;
  playbook: Array<{ title: string; category: string | null; content: string }>;
  templates: Array<{ name: string; content: string }>;
};

export async function buildAutoReplyContext(input: {
  orgId: string;
  conversationId: string;
  /** Nick nhận tin — lấy kịch bản dùng chung + kịch bản riêng của nick này. */
  zaloAccountId: string;
  contactId: string | null;
  pendingCustomerText: string;
  tags: string[];
}): Promise<AutoReplyContext> {
  const { orgId, conversationId, contactId, pendingCustomerText } = input;

  const [messages, contact, notes, playbookRows, templateRows] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId, isDeleted: false },
      orderBy: [{ zaloMsgIdNum: { sort: 'desc', nulls: 'last' } }, { sentAt: 'desc' }],
      take: HISTORY_LIMIT,
      select: { senderType: true, content: true, contentType: true, sentAt: true, sentVia: true },
    }),
    contactId
      ? prisma.contact.findUnique({
          where: { id: contactId },
          select: {
            fullName: true, crmName: true, gender: true, province: true, occupation: true,
            nextAppointment: true, statusRef: { select: { name: true } },
          },
        })
      : null,
    contactId
      ? prisma.note.findMany({
          where: { orgId, contactId },
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { body: true },
        })
      : [],
    prisma.aiPlaybookEntry.findMany({
      where: { orgId, enabled: true, OR: [{ zaloAccountId: null }, { zaloAccountId: input.zaloAccountId }] },
      // Mục riêng của nick lên trước mục dùng chung khi cùng độ ưu tiên.
      orderBy: [{ priority: 'desc' }, { zaloAccountId: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      select: { title: true, category: true, keywords: true, content: true },
    }),
    prisma.messageTemplate.findMany({
      where: { orgId },
      orderBy: { updatedAt: 'desc' },
      take: 40,
      select: { name: true, category: true, content: true },
    }),
  ]);

  const scored = playbookRows.map((row) => {
    const keywords = Array.isArray(row.keywords) ? (row.keywords as string[]) : [];
    return { row, matched: keywords.length > 0 && !!matchesAnyKeyword(pendingCustomerText, keywords) };
  });
  const playbook = [...scored.filter((s) => s.matched), ...scored.filter((s) => !s.matched)]
    .slice(0, PLAYBOOK_LIMIT)
    .map(({ row }) => ({ title: row.title, category: row.category, content: clip(row.content, PLAYBOOK_CHARS) }));

  const templates = templateRows
    .filter((t) => matchesAnyKeyword(pendingCustomerText, [t.name, ...(t.category ? [t.category] : [])]))
    .slice(0, TEMPLATE_LIMIT)
    .map((t) => ({ name: t.name, content: clip(t.content, TEMPLATE_CHARS) }));

  const history = [...messages].reverse().map((m) => {
    const who = m.senderType === 'self' ? (m.sentVia === 'automation' ? 'shop (tự động)' : 'shop') : 'khách';
    const text = m.contentType === 'text' || m.contentType === 'rich'
      ? clip(m.content ?? '', MESSAGE_CHARS)
      : `(gửi ${m.contentType})`;
    return `${who}: ${text}`;
  });

  const customer: Record<string, unknown> = contact
    ? {
        ten: contact.crmName || contact.fullName || null,
        gioiTinh: contact.gender,
        tinh: contact.province,
        ngheNghiep: contact.occupation,
        trangThai: contact.statusRef?.name ?? null,
        the: input.tags,
        lichHenSapToi: contact.nextAppointment?.toISOString() ?? null,
        ghiChuSale: notes.map((n) => clip(n.body, 300)),
      }
    : { ten: null, the: input.tags };

  return { customer, history, pendingCustomerText: clip(pendingCustomerText, 1200), playbook, templates };
}

/** Trần ký tự tài liệu tham khảo đưa vào 1 lượt trả lời (ngoài hướng dẫn chính). */
export const REFERENCE_BUDGET_CHARS = 26000;
const AUTO_REFERENCE_LIMIT = 3;

/** Từ chức năng / xưng hô quá phổ biến trong tin khách — không nói lên chủ đề. */
const STOP = new Set([
  'em', 'anh', 'chi', 'minh', 'ban', 'shop', 'oi', 'co', 'khong', 'ko', 'duoc', 'dc', 'vay', 'sao', 'nao', 'the',
  'cho', 'cua', 'la', 'va', 'voi', 'nhe', 'nha', 'roi', 'di', 'thi', 'ma', 'hay', 'bao', 'nhieu', 'may', 'gi', 'dau',
  'lam', 'can', 'muon', 'lay', 'cai', 'nay', 'do', 'ben', 'ok', 'oke', 'cam', 'on', 'da', 'ah', 'ha', 'hen', 'nhen',
  'vs', 'mot', 'hai', 'ba', 'con', 'ne', 'luon', 'giup', 'hoi', 'xin', 'biet', 'khi', 'neu', 've', 'tu', 'den', 'o',
]);
const COMMON_PAIRS = new Set(['cho em', 'cho minh', 'anh chi', 'shop oi', 'duoc khong', 'bao nhieu', 'nhu the', 'the nao', 'con khong', 'cam on']);

/** Từ khách hay dùng → cách tài liệu thường viết. */
const SYNONYMS: Array<[RegExp, string[]]> = [
  [/\b(ship|sip|van chuyen|chuyen phat|gui hang)\b/, ['giao hang', 'phi giao', 'van chuyen']],
  [/\b(coc|dat truoc|giu hang)\b/, ['dat coc', 'giu hang', 'dat hang']],
  [/\b(ctv|cong tac vien)\b/, ['ctv', 'cong tac vien']],
  [/\b(npp|nha phan phoi|dai ly)\b/, ['npp', 'nha phan phoi']],
  [/\b(si|bo moi|tap hoa|lay nhieu|so luong)\b/, ['gia si', 'khach si']],
  [/\b(loi|hu|hong|bao hanh|khong chay)\b/, ['bao hanh', 'doi tra']],
  [/\b(doi|tra hang|hoan)\b/, ['doi tra', 'khieu nai']],
  [/\b(ck|chuyen khoan|stk|tai khoan|cod|thanh toan|tra tien)\b/, ['thanh toan', 'chuyen khoan']],
  [/\b(mo cua|dong cua|may gio|gio lam)\b/, ['gio mo cua', 'mo cua']],
  [/\b(dia chi|o dau|cho nao|duong|kho)\b/, ['dia chi', 'kho']],
  [/\b(diem|tich luy|tich diem)\b/, ['diem tich luy']],
  [/\b(khuyen mai|giam gia|sale|uu dai)\b/, ['khuyen mai']],
  [/\b(gia|bao gia)\b/, ['bao gia', 'gia']],
];

/** Cụm tra cứu của câu khách: âm tiết có nghĩa, cặp âm tiết, và từ đồng nghĩa. Đã bỏ dấu. */
export function queryTerms(text: string): string[] {
  const flat = fold(text).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const syl = flat.split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < syl.length; i++) {
    if (syl[i].length >= 2 && !STOP.has(syl[i]) && !/^\d+$/.test(syl[i])) out.add(syl[i]);
    if (i + 1 < syl.length) {
      const pair = `${syl[i]} ${syl[i + 1]}`;
      if (!COMMON_PAIRS.has(pair) && !(STOP.has(syl[i]) && STOP.has(syl[i + 1]))) out.add(pair);
    }
  }
  for (const [re, adds] of SYNONYMS) if (re.test(` ${flat} `)) adds.forEach((a) => out.add(a));
  return [...out];
}

/** Khớp nguyên từ trong chuỗi đã bỏ dấu (để "si" không dính vào "sinh"). */
function hasWord(hay: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${term.replace(/ /g, '[^a-z0-9]+')}([^a-z0-9]|$)`).test(hay);
}

/**
 * Chọn tài liệu tham khảo cho 1 lượt: mọi file "always" + tối đa 3 file "auto"
 * khớp chủ đề câu khách hỏi nhất (điểm = số cụm từ của khách xuất hiện trong
 * tên file / tiêu đề / nội dung; tên file & tiêu đề nặng hơn). Giữ trong
 * REFERENCE_BUDGET_CHARS. Hàm thuần.
 */
export function pickGuideFiles(files: GuideFile[], customerText: string, budget = REFERENCE_BUDGET_CHARS): GuideFile[] {
  const q = queryTerms(customerText);
  const always = files.filter((f) => f.mode === 'always');
  const scored = files
    .filter((f) => f.mode === 'auto')
    .map((f) => {
      const name = fold(f.path.replace(/\.[a-z]+$/i, '').replace(/[-_/.]/g, ' '));
      const headings = fold(f.content.split('\n').filter((l) => /^#{1,4}\s/.test(l)).join(' '));
      const body = fold(f.content);
      let score = 0;
      for (const t of q) {
        const w = t.includes(' ') ? 2 : 1;
        if (hasWord(name, t)) score += 4 * w;
        if (hasWord(headings, t)) score += 2 * w;
        if (hasWord(body, t)) score += w;
      }
      return { f, score };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, AUTO_REFERENCE_LIMIT)
    .map((x) => x.f);
  const out: GuideFile[] = [];
  let used = 0;
  for (const f of [...always, ...scored]) {
    if (used >= budget) break;
    const room = budget - used;
    const content = f.content.length > room ? `${f.content.slice(0, room)}\n…(cắt bớt)` : f.content;
    out.push({ ...f, content });
    used += content.length;
  }
  return out;
}

export function renderReferences(files: GuideFile[]): string {
  if (!files.length) return '';
  return ['<tai_lieu_tham_khao>', ...files.map((f) => `### ${f.path}\n${f.content.replace(/<\/?tai_lieu_tham_khao>/g, '')}`), '</tai_lieu_tham_khao>'].join('\n');
}

/** Cách gọi khách theo giới tính Zalo. */
export type Addressing = { selfPronoun: string; gender: 'male' | 'female' | null } | null;

export function addressingRule(a: Addressing): string | null {
  if (!a) return null;
  const self = a.selfPronoun.trim() || 'em';
  const call = a.gender === 'female' ? 'chị' : a.gender === 'male' ? 'anh' : null;
  return call
    ? `XƯNG HÔ BẮT BUỘC: khách là ${a.gender === 'female' ? 'NỮ' : 'NAM'} (theo hồ sơ Zalo) → gọi khách là "${call}", tự xưng "${self}". Ví dụ: "Dạ ${self} chào ${call} ạ". Không gọi "anh chị", "bạn", "quý khách". Quy tắc này đứng trên phần xưng hô trong HƯỚNG DẪN CỦA SHOP (nói về công ty vẫn dùng tên shop như hướng dẫn).`
    : `XƯNG HÔ BẮT BUỘC: chưa rõ giới tính khách → gọi khách là "anh/chị", tự xưng "${self}". Nếu khách tự xưng rõ (vd "chị hỏi", "anh muốn") thì gọi theo đó. Quy tắc này đứng trên phần xưng hô trong HƯỚNG DẪN CỦA SHOP.`;
}

export type PromptOptions = {
  /** Hội thoại chưa có tin nào của shop → được chào / giới thiệu trợ lý AI một lần. */
  firstMessage?: boolean;
  /** Bài học chủ shop dạy trực tiếp — ưu tiên CAO HƠN hướng dẫn / skill. */
  ownerLessons?: string[];
};

export function buildSystemPrompt(persona: string | null, guide: string | null, lessons: string[] = [], references: GuideFile[] = [], addressing: Addressing = null, products = '', opts: PromptOptions = {}): string {
  const g = guide?.trim() || '';
  const who = persona?.trim()
    || (g ? 'người trả lời khách của shop, đóng vai, xưng hô và tư vấn đúng như HƯỚNG DẪN CỦA SHOP ở cuối' : 'nhân viên chăm sóc khách hàng của shop, xưng "em", gọi khách là "anh/chị"');
  const lines = [
    `Bạn là ${who}, đang trả lời khách trên Zalo.`,
    'Bạn nhận NGỮ CẢNH: hồ sơ khách, KHO KỊCH BẢN của shop, mẫu tin, lịch sử chat và các tin khách vừa gửi.',
    'Nhiệm vụ: viết MỘT tin nhắn trả lời gộp cho các tin khách vừa gửi, HOẶC chuyển cho nhân viên (handoff).',
    '',
    'Quy tắc bắt buộc (luôn đứng trên mọi hướng dẫn khác):',
    '- Giá, phí ship, chính sách, khuyến mãi, tồn kho, thời gian giao: CHỈ lấy từ kho kịch bản, mẫu tin hoặc HƯỚNG DẪN CỦA SHOP. Không có thì KHÔNG nêu con số, nói sẽ kiểm tra và báo lại.',
    '- Không bịa thông tin sản phẩm, đơn hàng, lịch hẹn hay điều khách chưa nói.',
    '- Viết như người nhắn Zalo: ngắn gọn, tự nhiên, tối đa 4 câu trừ khi khách hỏi nhiều ý. Không dùng dấu gạch ngang dài, không markdown.',
    '- Không chào lại từ đầu nếu hai bên đang giữa cuộc trò chuyện. Nếu cần chào / giới thiệu là trợ lý AI thì gộp gọn trong NỬA câu đầu rồi TRẢ LỜI NGAY điều khách hỏi; không chèn câu hỏi chung ("cần tìm món gì ạ?") khi khách đã nói rõ nhu cầu.',
    '- Không dùng danh sách đánh số, gạch đầu dòng hay dòng trống; viết liền như người nhắn Zalo, mỗi mẫu gợi ý là một câu ngắn.',
    '- KHÔNG BAO GIỜ nhận là người thật. Khách hỏi thẳng có phải bot/AI không thì phải nói thật. Được tự giới thiệu là trợ lý AI nếu HƯỚNG DẪN CỦA SHOP yêu cầu; nếu hướng dẫn không nói gì thì không cần tự nhắc.',
    '- Không yêu cầu khách gửi mật khẩu, mã OTP, thông tin thẻ.',
    '- Chọn "handoff" (chuyển chủ shop xử lý) khi: khách bức xúc, khiếu nại, đòi hoàn tiền/đổi trả; khách muốn gặp người thật; việc cần chủ shop quyết (giá đặc biệt, công nợ, hoá đơn VAT, phí giao ngoài vùng…) hoặc thông tin không có trong ngữ cảnh; và các trường hợp HƯỚNG DẪN CỦA SHOP yêu cầu chuyển. Khi handoff, "reply" là MỘT câu ngắn báo khách đã ghi nhận và chủ shop sẽ nhắn lại (không hứa nhanh hơn hướng dẫn cho phép); để rỗng nếu không cần nói gì (vd tin chỉ là sticker).',
    '- Tin chỉ là lời cảm ơn / sticker không cần đáp: action "reply" với câu đáp rất ngắn, hoặc handoff với reply rỗng nếu không cần nói gì.',
    '',
    ...(addressingRule(addressing) ? ['', addressingRule(addressing)!] : []),
    '',
    'Trả về DUY NHẤT một JSON, không kèm chữ nào khác:',
    '{"action": "reply" | "handoff", "reply": "tin gửi khách", "reason": "một câu ngắn giải thích (với handoff: viết theo khung lý do của hướng dẫn nếu có)", "urgent": true|false, "productIds": [id sản phẩm muốn gửi ảnh, tối đa 3]}',
  ];
  if (products) {
    lines.push(
      '',
      'SẢN PHẨM TRONG KHO (tra từ hệ thống bán hàng ngay lúc này — nguồn giá/tồn kho chính xác nhất):',
      '- Khách hỏi mua / tìm món: TƯ VẤN CỤ THỂ từ danh sách này: gợi ý 2-3 mẫu hợp nhu cầu nhất, nêu tên + giá lẻ + điểm nổi bật ngắn (lấy từ mô tả), rồi hỏi khách chọn mẫu nào. Không trả lời chung chung kiểu "bên em có nhiều loại". Cả tin tối đa khoảng 4-5 câu ngắn.',
      '- Khách hỏi giá sỉ / số lượng mà chưa rõ mẫu: báo luôn giá theo mức số lượng của 1-2 mẫu phổ biến nhất khớp câu hỏi, rồi hỏi khách lấy mẫu nào.',
      '- Chỉ nêu giá CTV/NPP khi khách hỏi giá sỉ hoặc số lượng nhiều (theo đúng ngưỡng ghi trong danh sách). Không bao giờ nêu giá vốn.',
      '- Chỉ nói về sản phẩm có trong danh sách; không bịa món, không bịa giá, không hứa còn hàng số lượng lớn nếu tồn ít. Món "GẦN ĐÚNG" thì nói rõ kho chưa có đúng món khách hỏi rồi mới gợi ý món liên quan.',
      '- Muốn khách xem ảnh: điền id vào "productIds" (tối đa 3); hệ thống tự gửi ảnh sau tin nhắn, trong tin chỉ cần nói "gửi ảnh để anh/chị xem".',
      '- Danh sách rỗng hoặc không có món phù hợp: nói sẽ kiểm tra lại và báo khách, hỏi thêm nhu cầu; KHÔNG bịa.',
      '- Khách GỬI ẢNH (dòng "[Khách gửi ảnh: …]"): tìm trong danh sách món khớp ảnh (cùng loại, thương hiệu, dung tích). Có món khớp → xác nhận bên em có bán + nêu tên + giá lẻ NGAY trong tin (không nói "để em kiểm tra giá"), rồi hỏi khách lấy mấy cái. Chỉ có món tương tự → nói rõ "mẫu tương tự" kèm giá. Không có gì liên quan → nói thật hiện chưa có và hỏi thêm nhu cầu.',
      '- Kho có NHIỀU BIẾN THỂ cùng loại (dung tích, kích thước, màu): chọn ĐÚNG biến thể khớp ảnh / lời khách (vd ảnh ghi 20ml → món 20ml) và dùng giá, id của đúng biến thể đó; không lấy giá của biến thể khác.',
      products,
    );
  }
  if (g) {
    lines.push(
      '',
      'HƯỚNG DẪN CỦA SHOP cho nick này (vai trò, xưng hô, cách tư vấn, thông tin sản phẩm…).',
      'Làm theo hướng dẫn này; chỉ khi nó mâu thuẫn với "Quy tắc bắt buộc" ở trên thì theo quy tắc bắt buộc.',
      'Nếu hướng dẫn yêu cầu trả lời theo định dạng khác, vẫn phải trả về JSON như trên (đặt nội dung vào "reply").',
      '<huong_dan_cua_shop>',
      g.replace(/<\/?huong_dan_cua_shop>/g, ''),
      '</huong_dan_cua_shop>',
    );
  }
  if (references.length) {
    lines.push(
      '',
      'TÀI LIỆU THAM KHẢO của skill (chọn theo câu khách hỏi, cùng giá trị như HƯỚNG DẪN CỦA SHOP):',
      renderReferences(references),
    );
  }
  if (lessons.length) {
    lines.push(
      '',
      'BÀI HỌC RÚT RA từ các lần trả lời trước của nick này (từ cách nhân viên sửa và nhận xét của chủ shop).',
      'Áp dụng khi phù hợp. Nếu mâu thuẫn với HƯỚNG DẪN CỦA SHOP hoặc quy tắc bắt buộc thì theo hướng dẫn / quy tắc.',
      '<bai_hoc>',
      ...lessons.map((l) => `- ${l.replace(/<\/?bai_hoc>/g, '')}`),
      '</bai_hoc>',
    );
  }
  const owner = opts.ownerLessons ?? [];
  if (owner.length) {
    lines.push(
      '',
      'CHỦ SHOP ĐÃ DẠY TRỰC TIẾP — ƯU TIÊN CAO HƠN HƯỚNG DẪN / SKILL / TÀI LIỆU / BÀI HỌC TỰ RÚT (chỉ đứng sau Quy tắc bắt buộc).',
      'Khi hướng dẫn hay tài liệu nói khác, LÀM THEO điều chủ shop dạy dưới đây. Nếu hai điều dưới đây mâu thuẫn nhau, điều ghi SAU thắng (dạy riêng cho nick này, mới hơn):',
      '<chu_shop_day>',
      ...owner.map((l) => `- ${l.replace(/<\/?chu_shop_day>/g, '')}`),
      '</chu_shop_day>',
    );
  }
  // Tự kiểm tra ở CUỐI prompt (mô hình bám phần cuối tốt nhất).
  lines.push(
    '',
    'TỰ KIỂM TRA TRƯỚC KHI TRẢ LỜI:',
    opts.firstMessage
      ? '- Đây là tin ĐẦU TIÊN của shop trong hội thoại: được chào + giới thiệu ngắn (nếu hướng dẫn yêu cầu) trong nửa câu đầu, rồi trả lời ngay.'
      : '- Hội thoại ĐÃ có tin của shop: KHÔNG chào lại, KHÔNG giới thiệu lại là trợ lý AI; vào thẳng câu trả lời.',
    ...(products
      ? [
          '- Có SẢN PHẨM TRONG KHO khớp nhu cầu → trong tin PHẢI nêu tên + giá lẻ của 1-3 mẫu cụ thể (khách hỏi sỉ / số lượng → nêu cả giá theo mức CTV/NPP đúng ngưỡng). Gửi ảnh không thay cho việc nêu tên và giá.',
        ]
      : []),
    ...(owner.length ? ['- Câu trả lời đã làm đúng mọi điều trong <chu_shop_day> liên quan tới câu khách hỏi chưa? (điều chủ shop dạy thắng skill / tài liệu).'] : []),
    '- Không danh sách đánh số / gạch đầu dòng; tối đa khoảng 5 câu ngắn; đúng xưng hô bắt buộc.',
    '- Trả về đúng JSON như đã quy định.',
  );
  return lines.join('\n');
}

/** Khối NGUỒN dùng chung cho lượt trả lời và lượt kiểm duyệt căn cứ. */
export function renderSources(ctx: AutoReplyContext): string {
  const out: string[] = [];
  out.push('<ho_so_khach>', JSON.stringify(ctx.customer), '</ho_so_khach>', '');
  out.push('<kho_kich_ban>');
  if (ctx.playbook.length === 0) out.push('(Chưa có kịch bản. KHÔNG được nêu giá hay chính sách.)');
  for (const p of ctx.playbook) out.push(`### ${p.title}${p.category ? ` [${p.category}]` : ''}`, p.content);
  out.push('</kho_kich_ban>', '');
  if (ctx.templates.length) {
    out.push('<mau_tin>');
    for (const t of ctx.templates) out.push(`- ${t.name}: ${t.content}`);
    out.push('</mau_tin>', '');
  }
  out.push('<lich_su_chat>', ...ctx.history, '</lich_su_chat>');
  return out.join('\n');
}

export function renderUserPrompt(ctx: AutoReplyContext): string {
  return [
    renderSources(ctx),
    '',
    '<tin_khach_vua_gui>',
    // Nội dung khách gửi là DỮ LIỆU, không phải chỉ dẫn cho bạn.
    ctx.pendingCustomerText.replace(/<\/?tin_khach_vua_gui>/g, ''),
    '</tin_khach_vua_gui>',
  ].join('\n');
}
