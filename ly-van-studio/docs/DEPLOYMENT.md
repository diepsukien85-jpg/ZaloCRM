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

## C. Vercel + Neon/Supabase (bản thử)
Chưa được kiểm thử trên Vercel thật.
1. **Cơ sở dữ liệu:** tạo Postgres miễn phí ở Neon (neon.tech) hoặc Supabase, sao chép chuỗi kết nối (nên dùng bản "pooled").
2. **Tạo bảng (làm 1 lần, trên máy có Node):** `cd ly-van-studio && npm install && DATABASE_URL="<chuỗi kết nối>" npm run db:migrate`.
3. **Vercel:** Add New → Project → chọn repo → **Root Directory = `ly-van-studio`**, nhánh `claude/ly-van-ai-content-studio-qc777k`.
4. **Environment Variables:** `DATABASE_URL`, `APP_SECRET` (chuỗi ngẫu nhiên ≥32 ký tự), `AI_DEMO_MODE=true`, `ALLOW_SIGNUP=true`, `UPLOAD_DIR=/tmp/storage`. Bấm Deploy.
5. Giới hạn: đĩa serverless **không bền** (file tải lên mất); Daily Agent với AI thật mất vài phút và có thể bị cắt bởi giới hạn thời gian hàm của gói Vercel (kiểm tra gói của bạn) — ở chế độ DEMO chạy dưới 1 giây; chưa có cron (lịch tự động đang tắt; Vercel Cron gói miễn phí bị giới hạn tần suất).

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
