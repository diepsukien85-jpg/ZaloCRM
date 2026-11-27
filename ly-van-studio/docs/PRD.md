# PRD — Ly Vân AI Content Studio v1.0

## 1. Mục tiêu
Giúp một nữ doanh nhân vận hành thương hiệu cá nhân trên Facebook/TikTok/YouTube không cần đội marketing lớn: mỗi ngày đề xuất ≥10 ý tưởng, chọn 5, tạo 3 bài + 2 kịch bản video (kèm hook, caption, hashtag, hướng dẫn quay, prompt Google Flow, biến thể theo nền tảng); người dùng kiểm soát và phê duyệt mọi nội dung.

## 2. Người dùng & vai trò
Chủ sở hữu (Ly Vân) · Quản trị · Biên tập (viết/sửa, không duyệt) · Người xem (chỉ đọc).

## 3. Phạm vi theo giai đoạn
| Giai đoạn | Trạng thái |
|---|---|
| **1 – MVP**: auth, workspace, DNA, dashboard, cấu hình AI, Keyword Lab, Story Bank, Idea Bank, Content Factory, Video Script, Flow prompt, Calendar, Copilot, Daily Agent thủ công, export, analytics nhập tay, theo dõi chi phí AI | ✅ làm xong (xem TEST_REPORT.md) |
| **2 – Research & Automation**: Trend Radar, Viral Decoder, media upload, transcription, scheduled workflows, weekly report, Google Drive, Video Studio nâng cao | ⚠ Trend Radar (nhập tay), Viral Decoder (văn bản), upload, lịch workflow + weekly/monthly ✅; transcription, Google Drive, FFmpeg ❌ |
| **3 – Distribution & Growth**: API nền tảng, publication workflow, analytics sync, lead, attribution, tích hợp bán hàng | ⚠ Lead + attribution + CSV ✅; quy trình đăng thủ công ✅; API nền tảng, sync, tích hợp bán hàng ❌ |
| **4 – SaaS**: multi-brand/user/role, subscription, billing, marketplace | ⚠ multi-brand/workspace/user/role ✅; còn lại ❌ |

## 4. 18 module & tiêu chí chấp nhận chính
1. **Tổng quan**: 15 chỉ số, bộ lọc, KPI ngày/tuần/tháng, nút CHẠY AI AGENT HÔM NAY (12 bước, thời gian, lỗi). Số liệu chưa có hiện "—".
2. **AI Agent Center**: 12 agent, bật/tắt, log run, prompt có phiên bản.
3. **DNA**: chỉnh sửa trong UI, lưu phiên bản, tỷ trọng trụ cột (tổng 100%).
4. **Radar xu hướng**: nhập tay có nguồn/ngày/độ tin cậy/xác minh; không tự thu thập.
5. **Keyword Lab**: 5 tầng, vi/en/zh, 20/50/100, cây/mindmap, so sánh, CSV, chuyển ý tưởng/series/30 ngày; không bịa lượng tìm kiếm.
6. **Giải mã viral**: phân tích văn bản người dùng cung cấp; không suy đoán hình ảnh.
7. **Câu chuyện**: nhật ký, 3 mức riêng tư, trích xuất không bịa, ẩn PII.
8. **Ý tưởng**: điểm /100 (25/25/20/20/10) là ước tính AI; chống trùng.
9. **Content Factory**: 13 trạng thái, autosave, phiên bản + diff, AI rewrite, biến thể, chuyển đổi, export MD/CSV, phê duyệt.
10. **Video Studio**: storyboard, timeline, prompt Flow từng cảnh, thư viện nhân vật, SRT/ZIP.
11. **Thư viện tư liệu**: upload kiểm tra chặt, signed URL.
12. **Lịch**: ngày/tuần/tháng/kanban/danh sách, kéo thả, KPI, không đếm trùng biến thể.
13. **Kênh**: 5 kênh mặc định, KPI từng kênh, kênh vệ tinh; không lưu mật khẩu MXH.
14. **Lead**: pipeline 7 trạng thái, import CSV có consent, quy thuộc doanh thu.
15. **Analytics**: công thức theo đặc tả, mẫu số 0, nguồn dữ liệu, doanh thu ≠ lợi nhuận.
16. **Tự động hoá**: Daily/Weekly/Monthly, mặc định TẮT, bật cần xác nhận.
17. **Chi phí AI**: bảng usage, ngân sách ngày/tháng + cảnh báo + chặn cứng, bảng giá có ngày cập nhật, cache.
18. **Cài đặt**: provider/khoá mã hoá, tích hợp (trạng thái thật), thành viên, xuất/xoá dữ liệu, audit.

## 5. Phi chức năng
Tiếng Việt, Asia/Ho_Chi_Minh, VND; sáng/tối; responsive; bảo mật (SECURITY.md); không phát sinh chi phí ngoài khi chưa cấu hình/bấm.

## 6. Ngoài phạm vi hiện tại
Đăng tự động lên mạng xã hội, chạy quảng cáo, tạo video thật (Google Flow), dựng video FFmpeg, thu thập dữ liệu mạng xã hội, thanh toán.
