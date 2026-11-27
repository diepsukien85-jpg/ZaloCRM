# DEPLOYMENT

## Yêu cầu
Node ≥ 20 (đã chạy trên 22), PostgreSQL ≥ 13, ổ đĩa ghi được cho `UPLOAD_DIR`.

## A. Docker Compose (khuyến nghị cho VPS)
```bash
cd ly-van-studio
cp .env.example .env     # đặt APP_SECRET (>=32 ký tự ngẫu nhiên), POSTGRES_PASSWORD, ALLOW_SIGNUP=false sau khi tạo tài khoản
docker compose up -d --build
docker compose exec web npm run db:migrate
docker compose exec web npm run db:seed    # tuỳ chọn: tạo tài khoản đầu tiên (SEED_EMAIL/SEED_PASSWORD)
```
Đặt Caddy/Nginx phía trước (HTTPS, ghi đè `X-Forwarded-For`). Cron (mỗi 10 phút):
```
*/10 * * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://your.domain/api/cron/tick
```
Chỉ các lịch **đã được người dùng bật và xác nhận** mới chạy.

> Dockerfile/compose được cung cấp nhưng **chưa được build thử trong môi trường phát triển** (không có Docker daemon) — kiểm tra khi triển khai đầu tiên.

## B. Node trực tiếp
```bash
npm ci && npm run build
DATABASE_URL=... APP_SECRET=... npm run db:migrate
npm start        # cổng 3100
```
Dùng systemd/pm2 để giữ tiến trình.

## C. Vercel + Postgres (Supabase/Neon)
Chạy được phần web/API. Lưu ý: (1) workflow chạy bằng `after()` trong hàm serverless — giới hạn thời gian (`maxDuration`) của gói Vercel có thể cắt Daily Agent; cần worker riêng hoặc nâng giới hạn; (2) **đĩa serverless không bền** → upload media cần chuyển sang S3-compatible (chưa triển khai); (3) cron dùng Vercel Cron gọi `/api/cron/tick` kèm header `Authorization: Bearer <CRON_SECRET>` (kiểm tra tài liệu Vercel hiện hành về cách gửi header). Hiện chưa kiểm thử trên Vercel.

## Biến môi trường
Xem `.env.example`. Khoá AI có thể đặt ở env hoặc nhập trong Cài đặt (mã hoá trong DB).

## Sao lưu
```bash
pg_dump -Fc "$DATABASE_URL" > backup-$(date +%F).dump
tar czf uploads-$(date +%F).tgz storage/
```
Khôi phục: `pg_restore -d "$DATABASE_URL" backup.dump`. Thử khôi phục định kỳ.

## Checklist trước khi dùng thật
- [ ] `APP_SECRET` ngẫu nhiên, lưu an toàn (mất = mất khoá API đã lưu).
- [ ] HTTPS + reverse proxy ghi đè XFF; `ALLOW_SIGNUP=false` sau khi tạo tài khoản.
- [ ] Đổi mật khẩu seed; kiểm tra ngân sách AI mặc định ($2/ngày, $30/tháng) và **cập nhật bảng giá** model.
- [ ] Nhập khoá AI và bấm "Kiểm tra kết nối".
- [ ] Sao lưu DB + thư mục upload tự động.
