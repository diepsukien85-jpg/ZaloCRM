# API REST

> Tệp này được sinh tự động bằng `npx tsx scripts/gen-api-doc.ts` từ định nghĩa route trong `src/lib/api/*`. Mọi endpoint nằm dưới `/api`.

**Quy ước chung**
- Xác thực bằng cookie HttpOnly `lv_session` (JWT). Workspace hiện hành lấy từ cookie `lv_ws` nhưng **vai trò luôn được tra lại từ DB**.
- Vai trò tối thiểu: GET = `viewer`, ghi = `editor`; một số route yêu cầu `admin`/`owner` (cột "Quyền").
- Mọi request ghi kiểm tra header `Origin` cùng host (chống CSRF).
- Body JSON được validate bằng Zod; lỗi trả `{error, code, details}` với HTTP 400/401/402/403/404/409/429/5xx.
- `402` = vượt ngân sách AI; `409` = xung đột/cần xác nhận; `429` = giới hạn tần suất.
- Các endpoint AI (cột "Giới hạn") có rate limit theo người dùng.

## Xác thực, workspace, thành viên

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| POST | `/api/auth/register` | công khai | body Zod, rate 10/phút |
| POST | `/api/auth/login` | công khai | body Zod, rate 15/phút |
| POST | `/api/auth/logout` | công khai |  |
| GET | `/api/auth/me` | công khai |  |
| POST | `/api/auth/workspace` | editor | body Zod |
| POST | `/api/workspaces` | viewer | body Zod |
| GET | `/api/members` | viewer |  |
| POST | `/api/members` | admin | body Zod |
| DELETE | `/api/members/:id` | admin |  |

## Thương hiệu, DNA, kênh, nhân vật

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/api/brands` | viewer |  |
| POST | `/api/brands` | admin | body Zod |
| PATCH | `/api/brands/:id` | admin | body Zod |
| PUT | `/api/brands/:id/dna` | admin | body Zod |
| GET | `/api/brands/:id/dna/versions` | viewer |  |
| PUT | `/api/brands/:id/pillars` | admin | body Zod |
| GET | `/api/products` | viewer |  |
| POST | `/api/products` | editor | body Zod |
| PATCH | `/api/products/:id` | editor | body Zod |
| DELETE | `/api/products/:id` | editor |  |
| GET | `/api/audiences` | viewer |  |
| POST | `/api/audiences` | editor | body Zod |
| PATCH | `/api/audiences/:id` | editor | body Zod |
| DELETE | `/api/audiences/:id` | editor |  |
| GET | `/api/campaigns` | viewer |  |
| POST | `/api/campaigns` | editor | body Zod |
| PATCH | `/api/campaigns/:id` | editor | body Zod |
| DELETE | `/api/campaigns/:id` | editor |  |
| GET | `/api/channels` | viewer |  |
| POST | `/api/channels` | editor | body Zod |
| PATCH | `/api/channels/:id` | editor | body Zod |
| DELETE | `/api/channels/:id` | editor |  |
| GET | `/api/characters` | viewer |  |
| POST | `/api/characters` | editor | body Zod |
| PATCH | `/api/characters/:id` | editor | body Zod |
| DELETE | `/api/characters/:id` | editor |  |

## Nghiên cứu: từ khoá, xu hướng, giải mã viral

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/api/keywords` | viewer |  |
| POST | `/api/keywords` | editor | body Zod |
| PATCH | `/api/keywords/:id` | editor | body Zod |
| DELETE | `/api/keywords/:id` | editor |  |
| POST | `/api/keywords/expand` | editor | body Zod, rate 30/phút |
| GET | `/api/keywords/export.csv` | viewer |  |
| POST | `/api/keywords/:id/plan` | editor | body Zod, rate 30/phút |
| GET | `/api/trends` | viewer |  |
| POST | `/api/trends` | editor | body Zod |
| PATCH | `/api/trends/:id` | editor | body Zod |
| DELETE | `/api/trends/:id` | editor |  |
| POST | `/api/trends/:id/analyze` | editor | rate 30/phút |
| POST | `/api/trends/:id/idea` | editor | rate 30/phút |
| GET | `/api/viral-decodes` | viewer |  |
| GET | `/api/viral-decodes/:id` | viewer |  |
| POST | `/api/viral-decodes` | editor | body Zod, rate 30/phút |
| POST | `/api/viral-decodes/:id/ideas` | editor |  |

## Nhật ký, ý tưởng, Content Factory

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/api/journals` | viewer |  |
| POST | `/api/journals` | editor | body Zod |
| PATCH | `/api/journals/:id` | editor | body Zod |
| DELETE | `/api/journals/:id` | editor |  |
| POST | `/api/journals/:id/extract` | editor | body Zod, rate 30/phút |
| GET | `/api/stories` | viewer |  |
| DELETE | `/api/stories/:id` | editor |  |
| POST | `/api/stories/:id/ideas` | editor |  |
| GET | `/api/ideas` | viewer |  |
| POST | `/api/ideas` | editor | body Zod |
| PATCH | `/api/ideas/:id` | editor | body Zod |
| PUT | `/api/ideas/:id/score` | editor | body Zod |
| DELETE | `/api/ideas/:id` | editor |  |
| POST | `/api/ideas/generate` | editor | body Zod, rate 30/phút |
| POST | `/api/ideas/:id/produce` | editor | body Zod, rate 30/phút |
| GET | `/api/contents` | viewer |  |
| POST | `/api/contents` | editor | body Zod |
| GET | `/api/contents/export.csv` | viewer |  |
| GET | `/api/contents/:id` | viewer |  |
| PATCH | `/api/contents/:id` | editor | body Zod |
| POST | `/api/contents/:id/transition` | editor | body Zod |
| POST | `/api/contents/:id/restore` | editor | body Zod |
| DELETE | `/api/contents/:id` | admin |  |
| POST | `/api/contents/:id/rewrite` | editor | body Zod, rate 30/phút |
| POST | `/api/contents/:id/variants` | editor | body Zod, rate 30/phút |
| PATCH | `/api/contents/:id/variants/:platform` | editor | body Zod |
| POST | `/api/contents/:id/convert` | editor | body Zod, rate 30/phút |
| GET | `/api/contents/:id/export.md` | viewer |  |

## Video Studio

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/api/video/projects` | viewer |  |
| POST | `/api/video/projects` | editor | body Zod |
| GET | `/api/video/projects/:id` | viewer |  |
| PATCH | `/api/video/projects/:id` | editor | body Zod |
| DELETE | `/api/video/projects/:id` | editor |  |
| POST | `/api/video/projects/:id/scenes` | editor | body Zod |
| PATCH | `/api/video/scenes/:id` | editor | body Zod |
| DELETE | `/api/video/scenes/:id` | editor |  |
| POST | `/api/video/scenes/:id/duplicate` | editor |  |
| POST | `/api/video/projects/:id/reorder` | editor | body Zod |
| POST | `/api/video/projects/:id/prompts` | editor | body Zod |
| GET | `/api/video/projects/:id/export` | viewer |  |

## Dashboard, analytics, lịch, lead, workflow, media

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/api/dashboard` | viewer |  |
| GET | `/api/analytics/summary` | viewer |  |
| GET | `/api/analytics/groups` | viewer |  |
| GET | `/api/analytics/top` | viewer |  |
| GET | `/api/analytics/snapshots` | viewer |  |
| POST | `/api/analytics/snapshots` | editor | body Zod |
| DELETE | `/api/analytics/snapshots/:id` | editor |  |
| POST | `/api/analytics/import` | editor | body Zod |
| GET | `/api/analytics/export.csv` | viewer |  |
| GET | `/api/kpi` | viewer |  |
| PUT | `/api/kpi` | admin | body Zod |
| GET | `/api/calendar` | viewer |  |
| PATCH | `/api/calendar/:id/move` | editor | body Zod |
| GET | `/api/leads` | viewer |  |
| POST | `/api/leads` | editor | body Zod |
| PATCH | `/api/leads/:id` | editor | body Zod |
| DELETE | `/api/leads/:id` | admin |  |
| POST | `/api/leads/import` | editor | body Zod |
| GET | `/api/leads/export.csv` | viewer |  |
| POST | `/api/leads/:id/attribute` | editor | body Zod |
| GET | `/api/workflows` | viewer |  |
| POST | `/api/workflows/:key/run` | editor | body Zod, rate 10/phút |
| GET | `/api/workflow-runs/:id` | viewer |  |
| POST | `/api/workflow-runs/:id/cancel` | editor |  |
| POST | `/api/workflow-runs/:id/retry` | editor |  |
| PUT | `/api/automations/:key` | admin | body Zod |
| GET | `/api/media` | viewer |  |
| POST | `/api/media` | editor | rate 40/phút |
| GET | `/api/media/:id/url` | viewer |  |
| GET | `/api/media/:id/file` | công khai |  |
| PATCH | `/api/media/:id` | editor | body Zod |
| DELETE | `/api/media/:id` | editor |  |

## AI, cài đặt, copilot, hệ thống

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/api/settings/ai` | admin |  |
| PUT | `/api/settings/ai` | admin | body Zod |
| POST | `/api/settings/ai/test` | admin | body Zod, rate 10/phút |
| PUT | `/api/settings/pricing` | admin | body Zod |
| GET | `/api/ai/usage` | viewer |  |
| PUT | `/api/budgets` | admin | body Zod |
| GET | `/api/agents` | viewer |  |
| PUT | `/api/agents/:key` | admin | body Zod |
| GET | `/api/prompts` | viewer |  |
| POST | `/api/prompts/:id/versions` | admin | body Zod |
| POST | `/api/prompts/:id/activate` | admin | body Zod |
| POST | `/api/copilot` | editor | body Zod, rate 30/phút |
| GET | `/api/notifications` | viewer |  |
| POST | `/api/notifications/read` | editor |  |
| GET | `/api/audit-logs` | admin |  |
| GET | `/api/integrations` | viewer |  |
| GET | `/api/export/workspace` | admin |  |
| DELETE | `/api/workspace` | owner | body Zod |
| GET | `/api/publications` | viewer |  |
| POST | `/api/cron/tick` | công khai |  |
| GET | `/api/health` | công khai |  |

**Tổng: 145 endpoint.**

Không có endpoint "giả" cho Meta/TikTok/YouTube/Google Drive/Google Flow: các tích hợp này chưa triển khai (xem INTEGRATION_STATUS.md).
