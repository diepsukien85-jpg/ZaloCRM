# TEST REPORT

Ngày chạy: 27/11/2026 · Node 22 · PostgreSQL 16 cục bộ · Chế độ AI: DEMO + mock `fetch` (không gọi API ngoài).

## Kết quả
| Lớp | Lệnh | Kết quả |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ 0 lỗi |
| Lint | `npm run lint` | ✅ 0 lỗi, 5 cảnh báo (điều hướng `location.href` có chủ đích) |
| Unit (30) | `vitest tests/unit` | ✅ 30/30 — công thức analytics & mẫu số 0, trùng ý tưởng, CSV (injection), mã hoá khoá, PII, JSON extraction, prompt Flow, SRT, upload (MIME/magic bytes/traversal), signed URL, lịch cron, ZIP/CRC, máy trạng thái, chọn ý tưởng theo tỷ trọng |
| Integration (24) | `vitest tests/integration` | ✅ 24/24 — Daily Agent end-to-end (12 bước, 10 ý tưởng, 3 bài + 2 kịch bản, biến thể, KPI không đếm trùng), idempotency/huỷ, ngân sách chặn cứng, AI client (cache, fallback, retry 429, sửa schema, 502, 402, khoá mã hoá), vòng đời duyệt→lịch→đăng + audit, phiên bản/autosave/khôi phục, ràng buộc DB (volume cần nguồn…), analytics, cách ly, đủ 49 bảng |
| E2E API qua HTTP, build production (27) | `npm run test:e2e` | ✅ 27/27 |
| E2E giao diện Playwright (44 bước) | `npm run test:e2e:ui` | ✅ đăng ký → Daily Agent → sửa/autosave → gửi duyệt → tải lại còn dữ liệu; 18 trang × (390px, 1280px) không lỗi JS/tràn ngang; dark mode lưu; Copilot; menu mobile |
| Production build | `npm run build` | ✅ 18 trang + API |

## Đối chiếu tiêu chí nghiệm thu (Phần 27)
| # | Tình huống | Kiểm bởi |
|---|---|---|
| 1-2 | Đăng ký/đăng nhập, tạo workspace | e2e API, e2e UI |
| 3-4 | Thương hiệu, cập nhật DNA (phiên bản) | e2e API |
| 5 | Cấu hình AI provider (khoá mã hoá, không lộ) | e2e API, integration |
| 6-7 | Mở rộng & lưu từ khoá | e2e API |
| 8-9 | Nhật ký → câu chuyện (ẩn SĐT) | e2e API |
| 10-11 | Ý tưởng + chấm điểm + chống trùng | e2e API, integration |
| 12-13 | Daily Agent: 3 bài + 2 kịch bản | integration, e2e API, e2e UI |
| 14 | Sửa & lưu phiên bản | integration, e2e API, e2e UI |
| 15 | Prompt Google Flow | unit, e2e API |
| 16-17 | Phê duyệt, đưa vào lịch | integration, e2e API |
| 18 | Xuất nội dung (MD/CSV/SRT/ZIP/JSON) | e2e API |
| 19-20 | Nhập số liệu, báo cáo | integration, e2e API |
| 21 | Giới hạn ngân sách | integration (AI client + budget), e2e API |
| 22 | Phân quyền & cách ly workspace | e2e API (22a, 22b), integration |
| 23 | Giao diện mobile | e2e UI (390px × 18 trang) |
| 24 | Xử lý lỗi API | integration (401/429/502/402, JSON sai) |
| 25 | Dữ liệu còn sau tải lại | e2e UI, e2e API |

## Lỗi tìm thấy & đã sửa trong lúc kiểm thử
- Tên file tiếng Việt trong `Content-Disposition` làm API xuất 500 → `contentDisposition()` (RFC 5987).
- Demo trích xuất câu chuyện làm lộ SĐT trong bài Facebook → che PII trước khi sinh.
- Điểm ý tưởng nhập tay/mặc định bị gắn nhãn "ước tính AI" → `is_ai_estimate=false`.
- Ghi chú "Lưu phiên bản" bị mất khi autosave đã lưu trước → gắn ghi chú vào phiên bản hiện tại.
- Giới hạn đăng nhập chỉ theo IP (giả được header) → thêm giới hạn theo email.
- `PATCH /leads/:id` không sửa được `external_ref` → thêm.

## KHÔNG được kiểm thử / giới hạn
- **Chưa có lần gọi nào tới API Anthropic/OpenAI/Gemini thật.** Chất lượng nội dung AI thật, định dạng phản hồi thật, giá thật chưa được xác minh. Bảng giá mặc định là ước tính, cờ "chưa xác minh".
- Chưa kiểm thử: ghi âm bằng micro thật, kéo thả trên thiết bị cảm ứng, Docker build, Vercel, nhiều instance song song, tải lớn, dark mode từng trang (chỉ kiểm tra bật/lưu và trang chủ), trình duyệt ngoài Chromium.
- Một số luồng UI chỉ kiểm bằng API/tay ngắn: Lên lịch/Đánh dấu đã đăng trên UI, Yêu cầu sửa, Chuyển đổi nội dung, kéo thả Kanban, đổi thứ tự cảnh, tạo lại prompt.
- Chưa có pen-test / `npm audit` / kiểm thử accessibility chuyên sâu.
- E2E cần reset bảng `rate_limits` nếu chạy lặp rất nhanh từ cùng IP (script dùng IP giả ngẫu nhiên nên thường không cần).

## Lỗi/hạn chế đã biết còn lại
Autosave gộp phiên bản trong 10 phút; tạo lại biến thể ghi đè bản sửa tay; `reorder` video tạo lại mọi prompt (ghi đè prompt sửa tay); `GET /keywords` giới hạn 1000 dòng không phân trang; `PATCH /journals` không đổi `entry_date`; import lead CSV chỉ 10 cột; `agent_runs.prompt_version` chưa ghi; Sales conversion/CAC dùng xấp xỉ (lead/đơn) vì chưa có "lead đủ điều kiện/khách mới" trong số liệu analytics.
