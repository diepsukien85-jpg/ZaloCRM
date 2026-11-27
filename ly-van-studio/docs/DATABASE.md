# DATABASE

PostgreSQL ≥ 13 (cần `gen_random_uuid()` từ `pgcrypto`). Migration: `db/migrations/*.sql`, chạy bằng `npm run db:migrate` (ghi vào bảng `schema_migrations`, mỗi file chạy trong một transaction).

## Quy ước
- Khoá chính `uuid`. Mọi bảng nghiệp vụ có `workspace_id` (FK → `workspaces` ON DELETE CASCADE), `created_at`, `updated_at` (trigger `set_updated_at`). Test `content-flow.test.ts` kiểm tra điều này tự động.
- Ràng buộc dữ liệu bằng `CHECK` (enum trạng thái, thang điểm 0–100, số không âm…), `UNIQUE` (vd. từ khoá không phân biệt hoa/thường theo ngôn ngữ trong workspace; chỉ một lịch đang hoạt động cho mỗi nội dung+nền tảng; idempotency key của workflow/publication).
- **Không bịa số liệu**: `keywords.search_volume` chỉ được ghi khi có `search_volume_source` (CHECK `keywords_volume_needs_source`). Điểm của AI nằm ở `relevance_score/content_potential_score` kèm `scores_are_ai_estimate`; `idea_scores.is_ai_estimate`.
- **Nhãn demo**: cột `is_demo` trên bảng có thể chứa dữ liệu sinh ở chế độ DEMO.

## Bảng theo nhóm (53 bảng)
| Nhóm | Bảng |
|---|---|
| Người dùng | `users`, `workspaces`, `workspace_members` (vai trò owner/admin/editor/viewer) |
| Thương hiệu | `brands`, `brand_dna` (+ `brand_dna_versions`), `products`, `audience_profiles`, `content_pillars` |
| Kênh | `channels`, `channel_connections` (token mã hoá — chưa dùng vì chưa có connector) |
| Nghiên cứu | `keywords`, `keyword_relationships`, `trend_sources`, `trends`, `source_references`, `research_reports`, `viral_decodes` |
| Câu chuyện & ý tưởng | `daily_journals`, `stories`, `ideas`, `idea_scores`, `campaigns` |
| Nội dung | `contents`, `content_versions`, `content_variants`, `content_approvals` |
| Video | `video_projects`, `video_scenes`, `characters`, `media_assets` |
| Phân phối | `schedules`, `publication_jobs`, `publication_logs` |
| Đo lường & bán hàng | `analytics_snapshots`, `leads`, `sales_attributions` |
| AI & tự động hoá | `agent_configs`, `prompt_templates`, `prompt_versions`, `agent_runs`, `workflow_definitions`, `workflow_runs`, `workflow_steps`, `automation_schedules`, `ai_usage_logs`, `budget_limits`, `ai_cache` |
| Hệ thống | `notifications`, `audit_logs`, `app_settings` (cài đặt + khoá API đã mã hoá), `rate_limits`, `schema_migrations` |

Bảng ngoài danh sách đặc tả: `ai_cache` (cache phản hồi AI), `rate_limits` (giới hạn tần suất), `schema_migrations`.

## Index quan trọng
`contents(workspace_id,status)`, `contents(workspace_id,scheduled_at)`, `ideas(workspace_id,status,total_score)`, `analytics_snapshots(workspace_id,snapshot_date)`, `ai_usage_logs(workspace_id,created_at)`, GIN full-text trên `daily_journals`.

## Row Level Security / Supabase
Ứng dụng **không dùng RLS** (cách ly ở tầng ứng dụng bằng `workspace_id`). Nếu chuyển sang Supabase: chạy migration trên Postgres của Supabase, vẫn kết nối bằng `DATABASE_URL` (service role) — **không** để trình duyệt truy cập trực tiếp DB. Muốn thêm RLS làm lớp phòng thủ thứ hai: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + policy `workspace_id = current_setting('app.workspace_id')::uuid` và `SET LOCAL app.workspace_id` trong mỗi transaction (chưa triển khai).

## Seed
`npm run db:seed` tạo một tài khoản + workspace với DNA Ly Vân/Trang Tùng Khang, 6 trụ cột (30/25/15/15/10/5), 5 kênh, 21 từ khoá gốc, prompt v1, 3 workflow (**TẮT**), ngân sách mặc định ($2/ngày, $30/tháng). **Không tạo số liệu hiệu quả giả.** Dữ liệu DEMO chỉ xuất hiện khi chạy agent không có khoá API và luôn gắn nhãn `is_demo`.

## Sao lưu / xoá / xuất
- Backup: `pg_dump` (xem DEPLOYMENT.md). Thư mục `UPLOAD_DIR` cần sao lưu riêng.
- Xuất dữ liệu workspace: `GET /api/export/workspace` (không gồm khoá API).
- Xoá dữ liệu: `DELETE /api/workspace` (chỉ owner, gõ lại tên workspace) → CASCADE.
