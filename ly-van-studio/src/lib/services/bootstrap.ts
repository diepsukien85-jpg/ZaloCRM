import { one, q, tx } from '../db';
import { seedPrompts } from '../ai/prompts';
import { setSetting } from '../ai/settings';
import type { PoolClient } from 'pg';

export const DEFAULT_PILLARS = [
  { name: 'Kinh doanh & tiền bạc', weight: 30, description: 'Chia sẻ thực chiến về kinh doanh, dòng tiền, lợi nhuận' },
  { name: 'Đám cưới & thẩm mỹ', weight: 25, description: 'Trang trí cưới, ánh sáng, không gian, xu hướng' },
  { name: 'Cuộc sống & gia đình', weight: 15, description: 'Làm mẹ, gia đình, cân bằng cuộc sống' },
  { name: 'Hậu trường doanh nghiệp', weight: 15, description: 'Kho, thi công, đội ngũ, quy trình' },
  { name: 'AI & phát triển bản thân', weight: 10, description: 'Ứng dụng AI, học tập, phát triển' },
  { name: 'Sản phẩm & bán hàng', weight: 5, description: 'Giới thiệu sản phẩm, giải đáp khách hàng B2B' },
];

export const ROOT_KEYWORDS = ['Tiền bạc', 'Kinh doanh', 'Khởi nghiệp', 'Đầu tư', 'Lợi nhuận', 'Làm giàu', 'Tình yêu', 'Hôn nhân', 'Gia đình', 'Hạnh phúc', 'Phụ nữ', 'Con cái', 'Đám cưới', 'Bí mật', 'Bất ngờ', 'Biến hình', 'Công nghệ', 'AI', 'Học tập', 'Thành công', 'Thất bại'];

const PERSONAL_DNA = {
  about: 'Nguyễn Thị Ly Vân — nữ doanh nhân thực chiến trong ngành trang trí tiệc cưới, thiết bị sự kiện, ô dù che nắng; có kinh nghiệm quản trị doanh nghiệp và ứng dụng AI. Là mẹ của bốn con, yêu thích học tập, kinh doanh, phát triển bản thân và chia sẻ kiến thức.',
  positioning: 'Nữ doanh nhân thực chiến – chia sẻ chân thực từ trải nghiệm thật về kinh doanh, ngành cưới & sự kiện, gia đình và AI.',
  personality: 'Chân thực, gần gũi, dễ hiểu, có chiều sâu kinh doanh, không khoe khoang.',
  voice: 'Xưng "mình/tôi", giọng kể chuyện tự nhiên, câu ngắn, ví dụ cụ thể từ công việc thật, tránh văn mẫu.',
  values: ['Chân thực', 'Có trải nghiệm thực tế', 'Chia sẻ để người khác học được', 'Tôn trọng khách hàng'],
  goals: ['Tăng nhận diện thương hiệu cá nhân', 'Xây dựng cộng đồng', 'Thu hút khách hàng B2B', 'Tạo khách hàng tiềm năng', 'Hỗ trợ đội ngũ bán hàng', 'Xây tài sản nội dung dài hạn'],
  audiences: ['Chủ nhà rạp', 'Chủ doanh nghiệp tổ chức sự kiện', 'Wedding planner', 'Phụ nữ kinh doanh', 'Người muốn khởi nghiệp trong ngành cưới và sự kiện'],
  products: [],
  rules: ['Không bịa trải nghiệm hay số liệu', 'Không biến trang cá nhân thành catalogue bán hàng', 'Ẩn thông tin riêng tư của khách hàng', 'Không hứa hẹn chắc chắn viral'],
  avoid: ['Khoe khoang', 'Văn mẫu AI sáo rỗng', 'Mua view / tương tác giả'],
};
const BUSINESS_DNA = {
  about: 'Trang Tùng Khang (trangtungkhang.vn) — cung cấp đèn chùm trang trí cưới, sản xuất màn sao, thiết bị tổ chức sự kiện, khung rạp & nhà lều, ô dù che nắng.',
  positioning: 'Nhà cung cấp thiết bị cho ngành cưới & sự kiện (B2B). Không định vị là đơn vị bán đồ trang trí nội ngoại thất nói chung.',
  personality: 'Uy tín, minh bạch, chuyên nghiệp, sáng tạo.',
  voice: 'Rõ ràng, thực tế, nói về lợi ích cho chủ nhà rạp/đơn vị sự kiện.',
  values: ['Uy tín', 'Chất lượng', 'Trách nhiệm', 'Sáng tạo', 'Minh bạch', 'Hợp tác', 'Học hỏi'],
  goals: ['Thu hút khách hàng B2B', 'Tạo khách hàng tiềm năng', 'Tăng doanh thu và lợi nhuận'],
  audiences: ['Chủ nhà rạp', 'Chủ doanh nghiệp tổ chức sự kiện', 'Wedding Planner', 'Đại lý phân phối', 'Chủ nhà hàng', 'Chủ quán cà phê', 'Chủ homestay', 'Chủ khu nghỉ dưỡng', 'Người muốn khởi nghiệp trong ngành cưới và sự kiện'],
  products: ['Đèn chùm trang trí cưới', 'Màn sao', 'Thiết bị tổ chức sự kiện', 'Khung rạp và nhà lều', 'Ô dù che nắng'],
  rules: ['Không bịa số liệu/chứng nhận', 'Báo giá và cam kết phải do đội bán hàng xác nhận'],
  avoid: ['Định vị thành đồ decor nội ngoại thất chung chung'],
};

const CHANNELS: [string, string, string, string][] = [
  ['Facebook cá nhân Ly Vân', 'facebook_profile', 'personal', 'Người theo dõi cá nhân, chủ nhà rạp, wedding planner'],
  ['Facebook Page thương hiệu cá nhân', 'facebook_page', 'personal', 'Cộng đồng quan tâm kinh doanh & ngành cưới'],
  ['TikTok Ly Vân', 'tiktok', 'personal', 'Người xem video ngắn'],
  ['YouTube Ly Vân', 'youtube', 'personal', 'Người xem video dài, tìm kiến thức'],
  ['Facebook Trang Tùng Khang Official', 'facebook_page', 'business', 'Khách hàng B2B'],
];

export const WORKFLOWS = [
  { key: 'daily', name: 'Daily Content Agent', implemented: true, hour: 7, description: 'Mỗi ngày: đọc DNA, lịch sử, nhật ký → mở rộng từ khoá → 10 ý tưởng → chọn 5 → 3 bài + 2 kịch bản → biến thể → lưu bản nháp.',
    steps: ['Đọc DNA thương hiệu', 'Đọc lịch sử nội dung', 'Đọc nhật ký công việc', 'Đọc xu hướng đã lưu', 'Mở rộng từ khoá', 'Tạo 10 ý tưởng', 'Chấm điểm & chống trùng', 'Chọn 5 ý tưởng', 'Viết 3 bài đăng', 'Viết 2 kịch bản video', 'Tạo biến thể đa nền tảng', 'Lưu bản nháp & thông báo duyệt'] },
  { key: 'weekly', name: 'Weekly Review', implemented: true, hour: 8, description: 'Tổng hợp số liệu tuần, nội dung tốt/kém, đề xuất thử nghiệm, kế hoạch tuần sau.', steps: ['Tổng hợp số liệu tuần', 'Xếp hạng nội dung', 'Nhận định & đề xuất AI', 'Lưu báo cáo'] },
  { key: 'monthly', name: 'Monthly Strategy', implemented: true, hour: 8, description: 'Tổng hợp KPI, tăng trưởng, chi phí, khách hàng; điều chỉnh chiến lược.', steps: ['Tổng hợp KPI tháng', 'Phân tích chi phí & khách hàng', 'Nhận định & đề xuất AI', 'Lưu báo cáo'] },
];

export const AGENTS = [
  ['brand_dna', 'Brand DNA Agent'], ['trend', 'Trend Research Agent'], ['keyword', 'Keyword Expansion Agent'], ['viral_decoder', 'Viral Decoder Agent'],
  ['storyteller', 'Storytelling Agent'], ['strategist', 'Content Strategist Agent'], ['copywriter', 'Copywriting Agent'], ['video_script', 'Video Script Agent'],
  ['production', 'AI Production Agent'], ['distribution', 'Distribution Agent'], ['analytics', 'Analytics Agent'], ['master', 'Master Agent'],
];

export const DEFAULT_KPI = { posts_per_day: 3, short_videos_per_day: 2, originals_per_30_days: 150 };

/** Khởi tạo workspace mới: thương hiệu mặc định theo DNA, trụ cột, kênh, prompt, workflow (TẮT), ngân sách. KHÔNG tạo số liệu giả. */
export async function bootstrapWorkspace(workspaceId: string, userId: string) {
  await tx(async (c: PoolClient) => {
    const brands: Record<string, string> = {};
    for (const [kind, name, slug, website, dna] of [['personal', 'Nguyễn Thị Ly Vân', 'ly-van', null, PERSONAL_DNA], ['business', 'Trang Tùng Khang', 'trang-tung-khang', 'https://trangtungkhang.vn', BUSINESS_DNA]] as const) {
      const b = (await c.query('INSERT INTO brands(workspace_id, name, slug, kind, website, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [workspaceId, name, slug, kind, website, dna.about])).rows[0];
      brands[kind] = b.id;
      await c.query('INSERT INTO brand_dna(workspace_id, brand_id, data) VALUES ($1,$2,$3)', [workspaceId, b.id, JSON.stringify(dna)]);
      await c.query('INSERT INTO brand_dna_versions(workspace_id, brand_id, version, data, changed_by) VALUES ($1,$2,1,$3,$4)', [workspaceId, b.id, JSON.stringify(dna), userId]);
    }
    for (const p of DEFAULT_PILLARS) await c.query('INSERT INTO content_pillars(workspace_id, brand_id, name, weight, description) VALUES ($1,$2,$3,$4,$5)', [workspaceId, brands.personal, p.name, p.weight, p.description]);
    for (const [name, platform, kind, aud] of CHANNELS) {
      await c.query("INSERT INTO channels(workspace_id, brand_id, name, platform, target_audience, kpi, connection_status) VALUES ($1,$2,$3,$4,$5,$6,'manual')", [workspaceId, brands[kind], name, platform, aud, JSON.stringify(DEFAULT_KPI)]);
    }
    for (const k of ROOT_KEYWORDS) {
      await c.query("INSERT INTO keywords(workspace_id, brand_id, keyword, tier, category, source, scores_are_ai_estimate) VALUES ($1,$2,$3,1,$3,'seed',true) ON CONFLICT DO NOTHING", [workspaceId, brands.personal, k]);
    }
    for (const w of WORKFLOWS) {
      await c.query('INSERT INTO workflow_definitions(workspace_id, key, name, description, steps, implemented) VALUES ($1,$2,$3,$4,$5,$6)', [workspaceId, w.key, w.name, w.description, JSON.stringify(w.steps), w.implemented]);
      // Mặc định TẮT: chỉ bật khi người dùng xác nhận.
      await c.query('INSERT INTO automation_schedules(workspace_id, workflow_key, enabled, hour, weekday, day_of_month) VALUES ($1,$2,false,$3,$4,$5)', [workspaceId, w.key, w.hour, w.key === 'weekly' ? 1 : null, w.key === 'monthly' ? 1 : null]);
    }
    for (const [key] of AGENTS) await c.query('INSERT INTO agent_configs(workspace_id, agent_key) VALUES ($1,$2)', [workspaceId, key]);
    await c.query("INSERT INTO budget_limits(workspace_id, scope, amount_usd) VALUES ($1,'daily',2),($1,'monthly',30)", [workspaceId]);
    await c.query("INSERT INTO trend_sources(workspace_id, name, platform, kind, status) VALUES ($1,'Nhập thủ công','other','manual','manual')", [workspaceId]);
  });
  await seedPrompts(workspaceId);
  await setSetting(workspaceId, 'kpi', DEFAULT_KPI);
}

export async function hasBootstrap(workspaceId: string) {
  return !!(await one('SELECT 1 FROM brands WHERE workspace_id=$1', [workspaceId]));
}
export { q };
