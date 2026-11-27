# ARCHITECTURE — Ly Vân AI Content Studio

## 1. Quyết định kiến trúc (và lý do)

| Hạng mục | Lựa chọn | Lý do / khác biệt so với đề xuất |
|---|---|---|
| Vị trí mã | Thư mục `ly-van-studio/` **độc lập** trong repo ZaloCRM | Repo hiện có là ZaloCRM (Vue + Fastify + Prisma, một sản phẩm khác đang chạy). Không ghi đè/xoá gì; ứng dụng mới không phụ thuộc mã cũ. Có thể tách thành repo riêng bằng `git subtree split`. |
| Web | Next.js 16 App Router, React 19, TypeScript strict, Tailwind v4, lucide-react, recharts | Theo đề xuất. Đã kiểm tra phiên bản bằng `npm view` ngày 27/11/2026. |
| UI kit | Component tự viết kiểu shadcn (`src/components/ui.tsx`) | Không dùng CLI shadcn để giảm phụ thuộc/ghi đè; cùng triết lý (token màu CSS, component thuần). |
| API | **Một catch-all route** `app/api/[...path]` + router tự viết (`src/lib/router.ts`) | 145 endpoint khai báo dạng dữ liệu (method, path, quyền tối thiểu, schema Zod, rate limit) → một chỗ duy nhất áp dụng xác thực, phân quyền, CSRF, rate-limit, validate. Giảm nguy cơ quên kiểm tra quyền ở từng file route. |
| DB | PostgreSQL thuần + `pg`, migration SQL (`db/migrations`) | Supabase không dùng được trong môi trường phát triển (không có mạng ra ngoài). Schema là Postgres chuẩn nên có thể chạy trên Supabase (xem DATABASE.md). |
| Auth | Email/mật khẩu (bcrypt) + JWT HS256 trong cookie HttpOnly/SameSite=Lax | Thay Supabase Auth. Google OAuth **chưa triển khai** (cần client id/secret). |
| Cách ly dữ liệu | `workspace_id` trên mọi bảng nghiệp vụ + mọi truy vấn lọc theo workspace của phiên | Thay RLS của Supabase. Có test tự động kiểm tra mọi bảng có `workspace_id`. |
| AI | Lớp trừu tượng provider (Anthropic/OpenAI/Gemini qua `fetch`), không dùng SDK | Ít phụ thuộc, kiểm soát timeout/retry/usage. Có provider `demo` bắt buộc gắn nhãn. |
| Job nền | Workflow engine trong DB (`workflow_runs/steps`) chạy bằng `after()` của Next + endpoint cron | Phù hợp triển khai Node tự chạy (VPS/Docker). Trên serverless thuần cần worker riêng (xem DEPLOYMENT.md). Có idempotency, retry (chạy lại run), cancel. |
| Storage | Đĩa cục bộ `UPLOAD_DIR` + signed URL HMAC | S3-compatible **chưa triển khai**; hàm lưu/đọc nằm gọn trong `services/media.ts` để thay. |
| Tìm kiếm ngữ nghĩa | Full-text Postgres (`to_tsvector('simple')`) + ILIKE | pgvector **chưa triển khai** (không bắt buộc cho MVP). |

## 2. Sơ đồ

```
Trình duyệt (React client components)
   │  fetch /api/*  (cookie lv_session)
   ▼
app/api/[...path]/route.ts ──► router.ts ──► [auth → role → origin → rate limit → zod] ──► handler
                                                                                          │
              ┌───────────────────────────────┬───────────────────────────────────────────┤
              ▼                               ▼                                           ▼
        services/*                       ai/agents.ts                               lib/db.ts (pg Pool)
 (content state machine,        (12 agent = module + prompt +                      PostgreSQL
  workflows, analytics,          schema Zod + demo fallback)
  flow prompts, media)                     │
                                           ▼
                               ai/client.ts: provider order → budget check → cache →
                               adapter (anthropic|openai|gemini) → retry/timeout → JSON+Zod
                               (1 lần sửa) → usage log → fallback provider
```

## 3. Multi-agent
12 "Agent" là **module + prompt + schema**, không phải 12 tiến trình AI (tối ưu chi phí). `Master Agent` = workflow engine (`services/workflows.ts`) điều phối các bước, kiểm tra trùng lặp (`similarity.ts`), kiểm tra DNA (mọi agent nạp DNA đang hoạt động qua `ai/context.ts`), theo dõi ngân sách (`ai/budget.ts`), lưu DB. Xem `AGENTS.md`.

## 4. Vòng đời nội dung & phê duyệt
`services/content.ts` là điểm duy nhất đổi trạng thái có ý nghĩa (`transition`). Quy tắc: không nhảy cóc; duyệt/yêu cầu sửa cần `admin+`; lên lịch cần `scheduled_at` + `confirm`; "đã đăng" chỉ là **xác nhận thủ công** (tạo `publication_jobs` mode `manual`), không có đăng tự động; sửa nội dung đã duyệt tự đưa về `draft`. Mỗi bước ghi `content_approvals` + `audit_logs`.

## 5. KPI không đếm trùng
Nội dung gốc có `parent_content_id IS NULL`. Biến thể phân phối nằm ở `content_variants` (không phải `contents`) nên KPI/dashboard chỉ đếm nội dung gốc.

## 6. Cấu trúc thư mục
```
db/migrations/        schema SQL
scripts/              migrate, seed, gen-api-doc
src/app/              trang (app) + login + api catch-all
src/components/       ui kit, shell, run-progress, ...
src/lib/              db, auth, http, router, crud, crypto, csv, metrics, similarity, zip
src/lib/ai/           providers, client, budget, pricing, prompts, schemas, demo, agents, safety
src/lib/services/     content, workflows, analytics, flow, media, schedule, bootstrap
src/lib/api/          định nghĩa route theo miền
tests/                unit, integration (vitest), e2e (node + playwright)
```

## 7. Giới hạn đã biết của kiến trúc
- Workflow chạy trong tiến trình web; nếu tiến trình chết giữa chừng, run còn trạng thái `running` (UI cho phép huỷ/chạy lại). Chưa có worker/lease tự phục hồi.
- Rate limit dựa trên IP từ `x-forwarded-for`: chỉ tin cậy khi đặt sau reverse proxy ghi đè header này; đăng nhập còn có giới hạn theo email.
- Chưa có RLS ở tầng DB: an toàn phụ thuộc việc mọi truy vấn mới phải kèm `workspace_id` (có test cách ly cho các luồng chính).
