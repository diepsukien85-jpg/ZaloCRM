/**
 * Bộ sinh dữ liệu DEMO — chạy khi chưa cấu hình khoá API (hoặc AI_DEMO_MODE=true).
 * Nội dung mang tính khuôn mẫu, KHÔNG phải kết quả của AI; mọi bản ghi tạo ra đều được gắn is_demo=true và nhãn "[DEMO]".
 * Mục đích: cho phép chạy & kiểm thử toàn bộ luồng không cần khoá API.
 */
import type { IdeaBatchT, KeywordExpansionT, PostDraftT, RewriteT, ReviewT, SceneT, StoryExtractionT, VideoScriptT, ViralDecodeT, VariantsT } from './schemas';

export const DEMO_TAG = '[DEMO]';

function h(s: string): number { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return Math.abs(x); }
const pick = <T,>(arr: T[], seed: string, off = 0) => arr[(h(seed) + off) % arr.length];

const TIER_SUFFIX: Record<number, string[]> = {
  1: ['là gì', 'cho phụ nữ', 'ở quê', 'cho người mới'],
  2: ['bắt đầu từ đâu', 'sai lầm thường gặp', 'làm sao để không thua lỗ', 'có thật sự cần thiết không'],
  3: ['câu chuyện thật', 'một ngày ở kho', 'bài học sau khi làm', 'tình huống khách hàng hay hỏi'],
  4: ['cho chủ nhà rạp', 'chi phí thiết bị', 'quy trình thi công', 'chọn nhà cung cấp'],
  5: ['đèn chùm và màn sao', 'combo thiết bị sự kiện', 'báo giá trọn gói', 'đầu tư nhà rạp'],
};
const CHAIN: Record<string, string[]> = {
  'tiền bạc': ['chi phí đám cưới', 'đám cưới 100 triệu', 'bí mật chi phí trang trí', 'tối ưu đầu tư nhà rạp', 'đèn chùm và màn sao'],
  'kinh doanh': ['khởi nghiệp ở quê', 'nghề kiếm tiền', 'kinh doanh nhà rạp', 'đầu tư thiết bị', 'combo thiết bị sự kiện'],
  'biến hình': ['trước và sau', 'biến đổi không gian', 'lễ đường cổ tích', 'quá trình thi công', 'đèn chùm và màn sao'],
};
const EN: Record<string, string> = { 'tiền bạc': 'wedding budget', 'kinh doanh': 'small business', 'khởi nghiệp': 'startup', 'đám cưới': 'wedding decoration', 'biến hình': 'before and after makeover', 'ai': 'AI for business', 'gia đình': 'work life balance mom' };
const ZH: Record<string, string> = { 'tiền bạc': '婚礼预算', 'kinh doanh': '创业', 'đám cưới': '婚礼布置', 'biến hình': '前后对比', 'khởi nghiệp': '创业故事' };

export function demoKeywords(roots: string[], count: number): KeywordExpansionT {
  const out: KeywordExpansionT['keywords'] = [];
  const seen = new Set<string>();
  const add = (k: KeywordExpansionT['keywords'][number]) => { const id = k.keyword.toLowerCase() + k.language; if (!seen.has(id)) { seen.add(id); out.push(k); } };
  const intentFor = (t: number) => (t >= 5 ? 'transactional' : t === 4 ? 'commercial' : 'informational') as 'transactional' | 'commercial' | 'informational';
  const funnelFor = (t: number) => (t >= 5 ? 'decision' : t === 4 ? 'consideration' : 'awareness') as 'decision' | 'consideration' | 'awareness';
  for (const root of roots) {
    add({ keyword: root, parent: null, tier: 1, language: 'vi', category: root, search_intent: 'informational', audience: 'đại chúng', funnel_stage: 'awareness', relevance_score: 60 + (h(root) % 30), content_potential_score: 55 + (h(root + 'p') % 35) });
  }
  let round = 0;
  while (out.length < count && round < 12) {
    for (const root of roots) {
      const chain = CHAIN[root.toLowerCase()];
      for (let tier = 1; tier <= 5 && out.length < count; tier++) {
        const base = chain && round === 0 ? chain[tier - 1] : `${root} ${TIER_SUFFIX[tier][round % TIER_SUFFIX[tier].length]}`;
        add({ keyword: base, parent: root, tier, language: 'vi', category: root, search_intent: intentFor(tier), audience: tier >= 4 ? 'chủ nhà rạp, wedding planner' : 'phụ nữ kinh doanh, gia đình', funnel_stage: funnelFor(tier), relevance_score: 50 + (h(base) % 45), content_potential_score: 45 + (h(base + 'x') % 50) });
      }
      if (round === 0) {
        if (EN[root.toLowerCase()]) add({ keyword: EN[root.toLowerCase()], parent: root, tier: 1, language: 'en', category: root, search_intent: 'informational', audience: 'quốc tế', funnel_stage: 'awareness', relevance_score: 55, content_potential_score: 50 });
        if (ZH[root.toLowerCase()]) add({ keyword: ZH[root.toLowerCase()], parent: root, tier: 1, language: 'zh', category: root, search_intent: 'informational', audience: 'nguồn tham khảo tiếng Trung', funnel_stage: 'awareness', relevance_score: 50, content_potential_score: 50 });
      }
    }
    round++;
  }
  return { keywords: out.slice(0, count) };
}

const IDEA_TPL: Record<string, string[]> = {
  'Kinh doanh & tiền bạc': ['3 khoản chi nhỏ âm thầm ăn lợi nhuận của chủ nhà rạp', 'Tôi đã học cách tính giá thuê thiết bị như thế nào', 'Vốn ít nên bắt đầu nghề cưới từ đâu', 'Sai lầm khi nhập thiết bị sự kiện chỉ vì giá rẻ', 'Lợi nhuận thật của một đám cưới 100 triệu'],
  'Đám cưới & thẩm mỹ': ['Vì sao cùng một lễ đường nhưng ánh sáng quyết định cảm xúc', 'Màn sao: chi tiết nhỏ làm khách mời dừng lại chụp ảnh', 'Trước và sau: biến nhà rạp thành lễ đường cổ tích', 'Đèn chùm nên treo cao bao nhiêu cho vừa mắt', 'Xu hướng trang trí cưới đang được cô dâu hỏi nhiều'],
  'Cuộc sống & gia đình': ['Làm mẹ bốn con và vẫn học thêm mỗi ngày — tôi sắp xếp thế nào', 'Một buổi tối cả nhà cùng dọn kho', 'Bài học dạy con từ chuyện làm ăn', 'Khi công việc và gia đình cùng cần mình', 'Điều tôi muốn các con hiểu về tiền'],
  'Hậu trường doanh nghiệp': ['Một ngày ở kho Trang Tùng Khang', 'Kiểm tra từng bộ đèn chùm trước khi giao thế nào', 'Chuyện thi công ngoài trời mưa gió', 'Đội thợ làm gì trước ngày cưới 24 giờ', 'Vì sao chúng tôi từ chối một đơn hàng'],
  'AI & phát triển bản thân': ['Tôi dùng AI để soạn kịch bản video mỗi sáng', 'AI giúp chủ doanh nghiệp nhỏ tiết kiệm giờ nào', 'Điều AI không làm thay được cho người làm nghề', 'Cách tôi học một kỹ năng mới trong 30 ngày', 'Ghi nhật ký công việc để có nội dung mỗi ngày'],
  'Sản phẩm & bán hàng': ['Combo thiết bị cho nhà rạp mới mở gồm những gì', 'Ô dù che nắng: chọn loại nào cho quán cà phê sân vườn', 'So sánh khung rạp và nhà lều cho sự kiện ngoài trời', 'Câu hỏi khách hay hỏi trước khi đặt đèn chùm', 'Checklist thiết bị cho homestay làm sự kiện'],
};
const FORMATS: IdeaBatchT['ideas'][number]['format'][] = ['post', 'short_video', 'post', 'short_video', 'carousel'];

export function demoIdeas(count: number, pillars: { name: string; weight: number }[], exclude: string[]): IdeaBatchT {
  const pool = pillars.length ? pillars : Object.keys(IDEA_TPL).map((name) => ({ name, weight: 1 }));
  const total = pool.reduce((s, p) => s + p.weight, 0) || 1;
  const ex = new Set(exclude.map((x) => x.toLowerCase()));
  const ideas: IdeaBatchT['ideas'] = [];
  const counters: Record<string, number> = {};
  let guard = 0;
  while (ideas.length < count && guard++ < 400) {
    // phân bổ theo tỷ trọng: chọn pillar thiếu nhiều nhất so với kỳ vọng
    const best = pool.map((p) => ({ p, deficit: (p.weight / total) * (ideas.length + 1) - (counters[p.name] ?? 0) })).sort((a, b) => b.deficit - a.deficit)[0].p;
    const tpls = IDEA_TPL[best.name] ?? Object.values(IDEA_TPL).flat();
    const idx = counters[best.name] ?? 0;
    counters[best.name] = idx + 1;
    if (idx >= tpls.length * 3) { counters[best.name] = 0; continue; }
    const base = tpls[idx % tpls.length];
    const title = idx >= tpls.length ? `${base} (góc nhìn ${idx >= tpls.length * 2 ? 'dành cho người mới' : 'từ trải nghiệm thật'})` : base;
    if (ex.has(title.toLowerCase())) continue;
    ex.add(title.toLowerCase());
    const s = h(title);
    const scores = { attraction: 12 + (s % 11), brand_fit: 14 + ((s >> 3) % 11), retention: 9 + ((s >> 5) % 10), conversion: 6 + ((s >> 7) % 12), feasibility: 5 + ((s >> 9) % 6) };
    ideas.push({ title, summary: `${DEMO_TAG} Ý tưởng mẫu thuộc trụ cột "${best.name}". Cần bổ sung trải nghiệm thật của Ly Vân trước khi đăng.`, pillar: best.name, format: FORMATS[ideas.length % FORMATS.length], platform: FORMATS[ideas.length % FORMATS.length] === 'short_video' ? 'facebook_reels' : 'facebook_profile', hook: `${title.split(' ').slice(0, 9).join(' ')}…`, keyword: null, scores, rationale: `${DEMO_TAG} Điểm mẫu, chưa phải đánh giá của AI thật.` });
  }
  return { ideas };
}

export function demoPost(title: string, pillar: string, context: string): PostDraftT {
  const base = context.trim() ? context.trim().slice(0, 500) : 'Hãy thêm trải nghiệm thật của bạn vào đây.';
  return {
    title: `${DEMO_TAG} ${title}`,
    hooks: [`${title}?`, `Ít ai nói thật về chuyện này: ${title.toLowerCase()}`, `Tôi từng nghĩ ${title.toLowerCase()} đơn giản hơn nhiều.`],
    body: `${DEMO_TAG} Bản nháp mẫu — chưa phải do AI viết.\n\n${title}\n\n${base}\n\nĐiều tôi rút ra: (điền bài học thật của bạn).\n\nBạn đang gặp tình huống tương tự không? Kể ở bình luận nhé.`,
    caption: `${title}`, hashtags: ['#lyvan', '#kinhdoanh', '#trangtungkhang'], cta: 'Bạn thấy sao? Để lại bình luận để mình trao đổi thêm.',
  };
}

export function demoScript(title: string, durationSec: number, kind: 'short' | 'long', context: string): VideoScriptT {
  const per = durationSec <= 30 ? 6 : 8;
  const n = Math.max(2, Math.round(durationSec / per));
  const scenes: SceneT[] = Array.from({ length: n }, (_, i) => ({
    scene_no: i + 1, duration_sec: Math.round(durationSec / n),
    shot_description: i === 0 ? `Cận mặt nhân vật nói thẳng vào camera, mở đầu bằng câu hook` : i === n - 1 ? 'Nhân vật khép lại, nhìn camera, nụ cười tự nhiên' : `Cảnh minh hoạ ý ${i} của nội dung (quay thực tế tại kho/công trình)`,
    dialogue: i === 0 ? `${title}?` : i === n - 1 ? 'Bạn thấy sao? Nói mình nghe nhé.' : `Ý chính số ${i}: (điền nội dung thật).`,
    voiceover: '', camera: i === 0 ? 'Cận cảnh, máy cố định, ngang tầm mắt' : 'Trung cảnh, đi nhẹ theo nhân vật', lighting: 'Ánh sáng tự nhiên, mềm', audio: 'Giọng thật, nhạc nền nhỏ',
    on_screen_text: i === 0 ? title.slice(0, 40) : '', environment: 'Kho / công trình thực tế', outfit: 'Trang phục gọn gàng, thường ngày',
  }));
  return {
    title: `${DEMO_TAG} ${title}`, main_keyword: title.split(' ').slice(0, 3).join(' '), audience: 'Chủ nhà rạp, wedding planner, người khởi nghiệp ngành cưới',
    problem: context.slice(0, 200), desire: 'Làm nghề có lãi và bền', hooks: [`${title}?`, `Đừng làm điều này trước khi xem video này`, `Tôi mất nhiều năm mới hiểu: ${title.toLowerCase()}`],
    duration_sec: durationSec, scenes, cta: 'Theo dõi để xem thêm chia sẻ thực tế.', caption: title, hashtags: ['#lyvan', '#nhaRap', '#trangtungkhang'],
    youtube: kind === 'long' ? { titles: [title, `${title} — chia sẻ thật`, `Sự thật về ${title.toLowerCase()}`], description: `${DEMO_TAG} Mô tả mẫu cho video: ${title}`, chapters: scenes.map((s, i) => ({ time: `${String(Math.floor((i * durationSec) / n / 60)).padStart(2, '0')}:${String(Math.floor(((i * durationSec) / n) % 60)).padStart(2, '0')}`, title: `Phần ${i + 1}` })) } : null,
  };
}

const split = (t: string) => t.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);
export function demoStory(text: string): StoryExtractionT {
  const ss = split(text);
  const first = ss[0] ?? '', last = ss[ss.length - 1] ?? '';
  return {
    title: `${DEMO_TAG} ${first.slice(0, 60) || 'Câu chuyện từ nhật ký'}`, characters: [], setting: '', problem: first, conflict: '', decision: '', action: ss[1] ?? '', result: ss.length > 2 ? last : '',
    lesson: '', emotion: '', viewer_value: '', not_stated: ['nhân vật', 'bối cảnh', 'mâu thuẫn', 'quyết định', 'bài học', 'cảm xúc'],
    lessons: [`${DEMO_TAG} Bài học 1 — bạn cần tự viết từ trải nghiệm thật`, `${DEMO_TAG} Bài học 2`, `${DEMO_TAG} Bài học 3`],
    broad_keywords: ['kinh doanh', 'bài học', 'gia đình', 'khởi nghiệp', 'thực chiến'],
    ideas: Array.from({ length: 5 }, (_, i) => ({ title: `${DEMO_TAG} Ý tưởng ${i + 1} từ câu chuyện: ${first.slice(0, 50)}`, summary: '' })),
    hooks: [first.slice(0, 80) || 'Hôm nay có một chuyện', 'Tôi không nghĩ chuyện này lại dạy mình nhiều đến vậy', 'Chuyện nhỏ nhưng đáng kể lại'],
    facebook_post: `${DEMO_TAG}\n${text.slice(0, 600)}`, short_video_idea: `${DEMO_TAG} Kể lại: ${first.slice(0, 100)}`,
  };
}

export function demoDecode(text: string, hasVisuals: boolean): ViralDecodeT {
  const ss = split(text);
  return {
    topic: ss[0]?.slice(0, 80) ?? '', audience: '(chưa xác định từ đầu vào)', hook: ss[0] ?? '', structure: ['Mở bằng hook', 'Triển khai vấn đề', 'Kết bằng CTA'], conflict: '', curiosity: '', emotion: '',
    pacing: hasVisuals ? 'Chưa phân tích (DEMO)' : null, camera: null, lighting: null, audio: null, on_screen_text: null, cta: ss[ss.length - 1] ?? '',
    retention_formula: `${DEMO_TAG} Hook → vấn đề → giải pháp → CTA`, reusable_formula: `${DEMO_TAG} [Câu hỏi gây tò mò] + [Câu chuyện thật] + [Bài học] + [CTA mềm]`, template: `${DEMO_TAG} HOOK: ...\nTHÂN: ...\nCTA: ...`,
    not_observed: hasVisuals ? [] : ['góc quay', 'ánh sáng', 'nhịp dựng', 'hình ảnh', 'âm thanh'],
    ideas: Array.from({ length: 5 }, (_, i) => ({ title: `${DEMO_TAG} Phiên bản Ly Vân #${i + 1}`, summary: '' })), script: `${DEMO_TAG} Kịch bản mẫu`, production_guide: `${DEMO_TAG} Hướng dẫn sản xuất mẫu`,
  };
}

const PLAT: Record<string, { ar: string; dur: number | null }> = {
  facebook_profile: { ar: '', dur: null }, facebook_page: { ar: '', dur: null }, facebook_reels: { ar: '9:16', dur: 30 }, tiktok: { ar: '9:16', dur: 30 }, youtube_shorts: { ar: '9:16', dur: 45 }, youtube_long: { ar: '16:9', dur: 480 },
};
export function demoVariants(platforms: string[], title: string, hook: string, body: string, hashtags: string[], cta: string): VariantsT {
  return { variants: platforms.map((p) => ({ platform: p as VariantsT['variants'][number]['platform'], title: `${DEMO_TAG} ${title}`, hook, caption: body.slice(0, p.startsWith('facebook') ? 500 : 150), hashtags: hashtags.slice(0, p === 'tiktok' ? 5 : 3), aspect_ratio: PLAT[p]?.ar ?? '', duration_sec: PLAT[p]?.dur ?? null, cta, body })) };
}

export function demoRewrite(instruction: string, text: string): RewriteT {
  const t = instruction.toLowerCase();
  let out = text;
  if (/rút gọn|ngắn/.test(t)) out = split(text).slice(0, Math.max(1, Math.ceil(split(text).length / 2))).join(' ');
  else if (/mở rộng|dài/.test(t)) out = `${text}\n\n(${DEMO_TAG} Bổ sung ví dụ thực tế của bạn vào đây.)`;
  else if (/cta/.test(t)) out = `${text}\n\nBạn nghĩ sao? Để lại bình luận nhé.`;
  else if (/hook/.test(t)) out = `Ít ai nói thật về chuyện này.\n${text}`;
  return { text: out, hooks: ['Ít ai nói thật về chuyện này.', 'Tôi từng nghĩ khác.', 'Chuyện nhỏ nhưng đáng nói.'], note: `${DEMO_TAG} Chỉnh sửa theo quy tắc đơn giản, không dùng AI` };
}

export function demoReview(stats: string): ReviewT {
  return { summary: `${DEMO_TAG} Nhận định mẫu dựa trên số liệu đã tính. ${stats}`, best: [], weak: [], experiments: ['Thử đổi hook ở 2 bài cùng chủ đề', 'Thử một định dạng video 30 giây mới'], next_plan: ['Duy trì 3 bài + 2 video/ngày', 'Rà soát nội dung kém sau 7 ngày'], caveats: ['Số liệu chỉ thể hiện tương quan, không chứng minh nhân quả.', 'Mẫu có thể nhỏ.'] };
}
