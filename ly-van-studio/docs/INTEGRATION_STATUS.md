# INTEGRATION STATUS

Cập nhật: 27/11/2026. **Không mục nào dưới đây được kiểm thử với dịch vụ bên ngoài thật** (môi trường phát triển không có khoá API và bị chặn mạng ra ngoài).

Chú giải: ✅ Đã hoạt động (trong ứng dụng) · 🧪 Đã kiểm thử tự động · 🔑 Cần API key · 🔐 Cần OAuth/duyệt quyền · ⏳ Chưa triển khai · ⛔ Không được nền tảng hỗ trợ

| Tích hợp / chức năng | Trạng thái | Chi tiết |
|---|---|---|
| Đăng nhập email/mật khẩu | ✅ 🧪 | bcrypt + JWT cookie |
| Google OAuth | ⏳ 🔑 | chưa triển khai |
| Supabase Auth/Storage/RLS | ⏳ | thay bằng Postgres + auth tự viết (ARCHITECTURE.md) |
| Chế độ DEMO (không cần khoá) | ✅ 🧪 | nội dung khuôn mẫu gắn nhãn `[DEMO]`, `is_demo` |
| Anthropic API | 🔑 (adapter viết, **chưa chạy với khoá thật**) | luồng retry/fallback/schema/ngân sách/cache được 🧪 bằng mock `fetch` |
| OpenAI API | 🔑 (như trên) | Chat Completions |
| Google Gemini API | 🔑 (như trên) | generateContent |
| Chuyển giọng nói → văn bản | ⏳ 🔑 | dán transcript thủ công; ghi âm/tải file lưu được |
| Meta Graph API – Facebook **Page** (đăng, insights) | ⏳ 🔐 | cần app + duyệt quyền; hiện đăng thủ công |
| Facebook **trang cá nhân** (profile) | ⛔ | không có API đăng chính thức tương đương Page → xuất & đăng thủ công |
| Facebook Reels (API) | ⏳ 🔐 | chưa triển khai |
| TikTok API | ⏳ 🔐 | chưa triển khai |
| YouTube Data API | ⏳ 🔐 | chưa triển khai |
| Google Drive / Calendar | ⏳ 🔐 | chưa triển khai |
| Google Trends / nguồn xu hướng | ⏳ | không có tích hợp; xu hướng nhập thủ công (Radar) |
| RedNote / Douyin / web ngành cưới | ⛔/⏳ | không thu thập tự động (điều khoản, đăng nhập/CAPTCHA); nhập thủ công |
| Google Flow | ⛔ (không có API phù hợp) | ✅ xuất prompt từng cảnh 🧪; nhập thủ công tài sản |
| FFmpeg ghép video/logo/phụ đề | ⏳ | chỉ xuất SRT/ZIP |
| Phần mềm bán hàng nội bộ Trang Tùng Khang | ⏳ | trường `external_ref` + import/export CSV lead |
| Lịch tự động (cron) | ✅ 🧪 (logic `dueKey`) | cần cron ngoài gọi `/api/cron/tick`; mặc định TẮT |
| Lưu trữ file | ✅ 🧪 đĩa cục bộ + signed URL | S3-compatible ⏳ |
| Tìm kiếm ngữ nghĩa (pgvector) | ⏳ | dùng full-text/ILIKE |
| Thanh toán / subscription | ⏳ | Giai đoạn 4 |
| Docker / Vercel | ⏳ chưa build thử | Dockerfile + compose có sẵn nhưng chưa chạy (không có Docker daemon) |

Trang **Cài đặt → Tích hợp** hiển thị đúng bảng trạng thái này từ `GET /api/integrations`; ứng dụng không bao giờ hiển thị "đã kết nối" khi chưa có connector thật.
