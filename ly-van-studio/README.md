# Ly Vân AI Content Studio

Hệ điều hành marketing AI cho thương hiệu cá nhân **Nguyễn Thị Ly Vân** và doanh nghiệp **Trang Tùng Khang**: nghiên cứu → từ khoá → ý tưởng → bài viết/kịch bản → prompt Google Flow → lịch → đo lường → tối ưu. Có backend, PostgreSQL, AI orchestration, phân quyền, workspace isolation.

> Ứng dụng nằm trong thư mục `ly-van-studio/` của repo ZaloCRM và **độc lập** với ZaloCRM (xem docs/ARCHITECTURE.md).
> Chưa có khoá AI → chạy **chế độ DEMO** (nội dung khuôn mẫu, gắn nhãn DEMO). Các tích hợp mạng xã hội **chưa triển khai** (xem docs/INTEGRATION_STATUS.md).

## Cài đặt nhanh (5 bước)
Yêu cầu: Node ≥ 20, PostgreSQL ≥ 13.

```bash
cd ly-van-studio
npm install
# 1. Tạo DB
createdb lyvan_studio            # hoặc: psql -c "CREATE DATABASE lyvan_studio"
# 2. Cấu hình
cp .env.example .env             # sửa DATABASE_URL, đặt APP_SECRET >= 32 ký tự ngẫu nhiên
# 3. Tạo bảng + tài khoản đầu tiên
npm run db:migrate
npm run db:seed                  # lyvan@example.local / ChangeMe-12345 (đổi ngay) — hoặc tự đăng ký ở /login
# 4. Chạy
npm run dev                      # http://localhost:3100
```
Bước 5 (tuỳ chọn): vào **Cài đặt → AI Provider**, nhập khoá Anthropic/OpenAI/Gemini → "Kiểm tra kết nối". Chưa nhập thì mọi tính năng AI chạy ở chế độ DEMO.

Production: `npm run build && npm start` hoặc Docker Compose (docs/DEPLOYMENT.md).

## Lệnh
| Lệnh | Việc |
|---|---|
| `npm run dev` / `build` / `start` | chạy / build / chạy production (cổng 3100) |
| `npm run typecheck` · `npm run lint` | kiểm tra kiểu / lint |
| `npm test` | unit + integration (cần PostgreSQL, DB `lyvan_test`; tự reset schema) |
| `npm run test:e2e` / `test:e2e:ui` | e2e API / giao diện (Playwright) qua HTTP, cần server đang chạy (`BASE=http://localhost:3100`) |
| `npm run db:migrate` · `db:seed` · `db:reset` | migration / seed / reset (chỉ dev) |

Biến test DB: `TEST_DATABASE_URL` (mặc định `postgres://lyvan:lyvan@localhost:5432/lyvan_test`).

## Dùng thử trong 2 phút
1. Đăng ký ở `/login` → workspace được khởi tạo sẵn DNA Ly Vân/Trang Tùng Khang, 5 kênh, 21 từ khoá gốc.
2. Trang **Tổng quan** → **CHẠY AI AGENT HÔM NAY** → xem 12 bước chạy → **Content Factory** có 3 bài + 2 kịch bản (bản nháp, DEMO nếu chưa có khoá).
3. Mở một bài → sửa (autosave + phiên bản) → Gửi duyệt → Duyệt → Lên lịch → xem ở **Lịch nội dung**.
4. **Video Studio**: xem storyboard, prompt Google Flow từng cảnh, tải SRT/ZIP.
5. **Phân tích hiệu quả**: nhập số liệu thủ công/CSV để xem CPL, ROAS, ROI…

Hướng dẫn chi tiết: docs/USER_GUIDE_VI.md · Báo cáo kiểm thử: docs/TEST_REPORT.md · Tích hợp: docs/INTEGRATION_STATUS.md.

## Nguyên tắc sản phẩm
Không bịa số liệu/trải nghiệm · không tự đăng bài · không mua view/bot · dữ liệu demo luôn có nhãn · điểm AI là ước tính, không cam kết viral · lịch tự động mặc định TẮT.
