# SECURITY

| Yêu cầu | Hiện thực | Kiểm thử |
|---|---|---|
| Authentication | bcrypt (cost 10), JWT HS256 14 ngày trong cookie `HttpOnly; SameSite=Lax; Secure` (production) | e2e: đăng nhập sai → 401, không lộ email tồn tại |
| Authorization | 4 vai trò; router kiểm vai trò tối thiểu cho từng route; vai trò **luôn tra lại từ DB**, cookie workspace chỉ là gợi ý | e2e 22a: viewer/editor bị chặn đúng chỗ |
| Workspace isolation | Mọi bảng có `workspace_id`; mọi truy vấn kèm workspace của phiên; chuyển workspace chỉ khi là thành viên | e2e 22b: 18 thao tác chéo workspace bị 403/404; integration: mọi bảng có `workspace_id` |
| Validation | Zod ở router cho mọi body; CHECK/UNIQUE ở DB; cột UPDATE động qua whitelist | e2e |
| Secret encryption | Khoá API AES-256-GCM (khoá dẫn xuất từ `APP_SECRET`); không bao giờ trả về frontend, không ghi log, thông báo lỗi bị che | integration + e2e |
| Signed URL | Media: HMAC-SHA256 `id.exp`, hết hạn 15 phút, so sánh timing-safe; response `nosniff`, CSP `sandbox` | e2e: sai chữ ký/hết hạn → 403 |
| Rate limiting | Bảng `rate_limits` (hoạt động đa instance): đăng nhập/đăng ký theo IP + theo email; AI, upload, workflow, copilot theo người dùng | e2e: 429 |
| Upload | Allow-list MIME + phần mở rộng + **magic bytes**; giới hạn `MAX_UPLOAD_MB`; tên file làm sạch; lưu tên ngẫu nhiên; chặn path traversal; không nhận SVG/HTML/exe | unit + e2e |
| XSS | React escape; nội dung lưu nguyên văn; không dùng `dangerouslySetInnerHTML` ngoài script theme tĩnh; header `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` | e2e |
| CSRF | Cookie SameSite=Lax + kiểm `Origin` trên mọi request ghi | e2e |
| SQL injection | 100% truy vấn tham số hoá; tên bảng/cột chỉ lấy từ hằng số/whitelist | review |
| CSV injection | `toCsv` thêm `'` trước ô bắt đầu `= + - @` | unit |
| Audit logs | `audit_logs`: đăng ký/đăng nhập, đổi cài đặt, duyệt/lên lịch/đăng, xoá, import, xuất dữ liệu, bật tự động hoá… | integration |
| Prompt injection | Xem PROMPTS.md §4 | integration |
| Backup / export / delete | `pg_dump` (DEPLOYMENT.md); `GET /api/export/workspace`; `DELETE /api/workspace` | e2e (export) |
| Consent | Lead: cờ `contact_consent`, import CSV bắt buộc xác nhận; nhật ký có 3 mức riêng tư | e2e |

## Phê duyệt bắt buộc (Phần 22)
Đăng công khai, đổi lịch đã xác nhận, xoá dữ liệu quan trọng, bật tự động hoá, gửi nhật ký riêng tư ra AI ngoài, vượt ngân sách (chặn cứng) đều cần hành động xác nhận rõ ràng và được ghi audit. Chạy quảng cáo: hệ thống **không** có chức năng chạy quảng cáo.

## Giới hạn / rủi ro còn lại
- **Chưa có RLS** ở DB; một truy vấn mới thiếu `workspace_id` sẽ là lỗ hổng → bắt buộc review/test cho mọi route mới.
- Rate limit dựa `x-forwarded-for`: phải đặt sau reverse proxy tin cậy ghi đè header.
- Không có 2FA, quên mật khẩu qua email, khoá tài khoản vĩnh viễn, hay Google OAuth.
- Thu hồi phiên: JWT không có danh sách thu hồi (hết hạn sau 14 ngày; đổi `APP_SECRET` để vô hiệu hoá tất cả).
- Đổi `APP_SECRET` làm các khoá API đã lưu không giải mã được (nhập lại).
- Upload lưu đĩa cục bộ, chưa quét virus.
- `redactPII` dùng regex: không đảm bảo bắt hết tên riêng/địa chỉ.
- Chưa kiểm thử với API AI thật nên chưa xác minh luồng gửi dữ liệu ra ngoài ở môi trường thật.
- Chưa có kiểm thử bảo mật chuyên sâu (pen-test) hay `npm audit` theo lịch.
