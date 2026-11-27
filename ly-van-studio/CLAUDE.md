# CLAUDE.md — Ly Vân AI Content Studio (thư mục `ly-van-studio/`)

> Thư mục này là ứng dụng **độc lập** trong repo ZaloCRM. Quy tắc GitNexus ở CLAUDE.md gốc áp dụng cho ZaloCRM; không sửa mã ZaloCRM khi làm việc ở đây.

## Kiến trúc (đọc docs/ARCHITECTURE.md)
Next.js 16 App Router + TS strict + Tailwind v4. **Toàn bộ API là một catch-all** `src/app/api/[...path]/route.ts` → `src/lib/router.ts`. Route khai báo bằng dữ liệu trong `src/lib/api/*.ts` (`{method, path, min, schema, rate, handler}`); router tự áp dụng xác thực → vai trò → Origin → rate limit → Zod. Logic nằm ở `src/lib/services/*` và `src/lib/ai/*`.

## Quy tắc coding (bắt buộc)
1. **Mọi truy vấn DB phải kèm `workspace_id` = `ctx.workspaceId`** (không có RLS). Route mới ⇒ thêm kiểm thử cách ly trong `tests/e2e/api.mjs` (mục 22b). Bảng mới ⇒ có `workspace_id`, `created_at/updated_at` (test sẽ fail nếu thiếu).
2. SQL luôn tham số hoá; tên cột động chỉ qua whitelist (`buildUpdate`, `crud`).
3. Không bịa dữ liệu: số liệu rỗng ⇒ `null` hiển thị "—"; lượng tìm kiếm chỉ kèm nguồn; dữ liệu sinh ở chế độ demo ⇒ `is_demo=true` + `<DemoBadge/>` + tiền tố `[DEMO]`.
4. Không tự đăng/duyệt/lên lịch: đổi trạng thái nội dung chỉ qua `services/content.ts#transition`. Hành động ngoại vi/không hoàn tác cần `confirm` + `audit()`.
5. Gọi AI chỉ qua `generateStructured` (budget → cache → provider → retry → Zod → usage log). Mọi dữ liệu không tin cậy đưa vào prompt phải bọc `wrapUntrusted`, PII qua `redactPII`. Agent mới ⇒ thêm prompt (versioned), schema Zod, hàm `demo`.
6. Không đưa secret ra frontend; khoá API chỉ lưu mã hoá (`app_settings`). Không log khoá.
7. UI: tiếng Việt, mobile-first, dùng token màu (`bg-surface`, `text-muted`…) để hỗ trợ dark mode; dùng component ở `src/components/ui.tsx`; mọi nút phải gọi API thật hoặc ghi rõ "chưa kết nối".
8. Tên file download tiếng Việt: dùng `contentDisposition()` (header chỉ ASCII).

## Lệnh
```
npm run typecheck && npm run lint && npm test && npm run build
npm run dev &   (rồi)  npm run test:e2e       # cần DB + server
npx tsx scripts/gen-api-doc.ts                 # sinh lại docs/API.md khi đổi route
```
DB test: `lyvan_test` (tự reset). Cổng dev: 3100.

## Giới hạn tích hợp (đừng tuyên bố khác)
Chưa có: Meta/TikTok/YouTube API, Google Drive/Calendar/Flow, transcription, Google OAuth, S3, pgvector, FFmpeg, thanh toán/subscription. AI provider có adapter nhưng **chưa kiểm thử với khoá thật**. Chi tiết: docs/INTEGRATION_STATUS.md.

## Tiếp tục phát triển (gợi ý ưu tiên)
1. Kiểm thử adapter AI với khoá thật; ghi `agent_runs.prompt_version`.
2. Meta Graph (Page) + YouTube Data API qua OAuth → `channel_connections` (mã hoá token), `publication_jobs` mode `api`, vẫn qua bước duyệt.
3. Transcription (file âm thanh → transcript) cho Story Bank & Viral Decoder.
4. Worker bền vững cho workflow (queue/lease) thay vì `after()`.
5. RLS làm lớp phòng thủ thứ hai; S3 cho media; pgvector cho tìm kiếm ngữ nghĩa.
6. Giai đoạn 4: subscription/usage billing, marketplace.
