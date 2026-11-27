# AGENTS

Mỗi agent = hàm trong `src/lib/ai/agents.ts` (+ prompt trong `prompts.ts` + schema Zod trong `schemas.ts` + sinh DEMO trong `demo.ts`). Mọi lần chạy ghi `agent_runs` (trạng thái, provider/model, cache, demo, thời gian, lỗi) và `ai_usage_logs`.

| # | Agent | Trạng thái triển khai | Ghi chú |
|---|---|---|---|
| 01 | Brand DNA | ✅ | `ai/context.ts` nạp DNA đang hoạt động + tỷ trọng trụ cột vào **mọi** prompt. Chỉnh sửa/phiên bản ở trang DNA. |
| 02 | Trend Research | ⚠ một phần | Chỉ **nhập thủ công** + phân tích AI. Không tự thu thập Facebook/TikTok/YouTube/Google Trends (chưa có API chính thức tích hợp; không vượt CAPTCHA/đăng nhập). |
| 03 | Keyword Expansion | ✅ | 5 tầng, vi/en/zh, 20/50/100. Điểm = ước tính AI; lượng tìm kiếm chỉ nhập tay kèm nguồn. |
| 04 | Viral Decoder | ✅ (văn bản) | Đầu vào là transcript/nội dung người dùng dán. Không tải video, không xem hình; mục chưa quan sát được → `null` + `not_observed`. Chưa có đầu vào file video/âm thanh (cần transcription). |
| 05 | Storytelling | ✅ | Ẩn SĐT/email (`redactPII`) trước khi gửi; mục thiếu → `not_stated`; nhật ký `private` cần xác nhận mới gửi ra AI ngoài. |
| 06 | Content Strategist | ✅ | Tạo & chấm điểm ý tưởng (25/25/20/20/10), tỷ trọng trụ cột (`selectIdeas`), chống trùng (Jaccard ≥ 0.6). |
| 07 | Copywriting | ✅ | Bài + ≥3 hook + caption + hashtag + CTA; rewrite (rút gọn/mở rộng/đổi hook/giọng/CTA). Carousel là văn bản theo slide (chưa có render ảnh). |
| 08 | Video Script | ✅ | Thời lượng tuỳ ý (15 s → 30 phút); video ≥180 s có 3 tiêu đề + mô tả + chapters. |
| 09 | AI Production | ✅ (xuất prompt) | `services/flow.ts` dựng prompt Google Flow từng cảnh (deterministic, 0 chi phí): @tag nhân vật, mốc 4/6/8/10 s, continuity, negative. **Không có API Google Flow** → quy trình thủ công; không giả lập tạo video. |
| 10 | Distribution | ✅ (xuất thủ công) | Biến thể cho 6 nền tảng. **Không đăng tự động**; "đã đăng" là xác nhận thủ công. |
| 11 | Analytics | ✅ | Số liệu tính bằng SQL/`metrics.ts` (không phải AI); AI chỉ viết nhận định (weekly/monthly) kèm `caveats` về tương quan. |
| 12 | Master | ✅ | `services/workflows.ts`: chạy workflow nhiều bước, lưu bước, huỷ, chạy lại, idempotency, giới hạn ngân sách/lần chạy. |

## Daily Content Agent (12 bước)
1 Đọc DNA → 2 Lịch sử → 3 Nhật ký (loại `private`) → 4 Xu hướng đã lưu → 5 Mở rộng từ khoá (3 gốc luân phiên) → 6 Tạo 10 ý tưởng → 7 Chấm điểm + chống trùng → 8 Chọn 5 (3 bài + 2 video, theo trụ cột) → 9 Viết 3 bài → 10 Viết 2 kịch bản (+ dự án video + prompt Flow) → 11 Biến thể đa nền tảng → 12 Lưu bản nháp + thông báo duyệt.
Kết quả luôn là **bản nháp** — không tự duyệt/đăng.

Weekly Review / Monthly Strategy: 4 bước (tổng hợp số liệu → xếp hạng → nhận định AI → lưu `research_reports`).

## Chạy mà chưa có khoá API
`generateStructured` thấy không có khoá (hoặc `AI_DEMO_MODE=true`) → gọi hàm `demo()` của agent: nội dung khuôn mẫu có tiền tố `[DEMO]`, `is_demo=true`, chi phí 0, UI hiện huy hiệu DEMO. Mục đích: chạy được toàn luồng để kiểm thử/làm quen giao diện, **không phải** chất lượng nội dung thật.

## Điều phối chi phí
Thứ tự: kiểm tra ngân sách (ngày/tháng/lần chạy) → cache (hash task+prompt+input+model, TTL cấu hình) → provider chính → retry (429/5xx/timeout, backoff) → JSON+Zod (1 lần yêu cầu sửa) → provider dự phòng. Model có thể chọn theo agent (`task_models`).
