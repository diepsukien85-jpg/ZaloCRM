# HƯỚNG DẪN SỬ DỤNG

## 0. Bắt đầu
Đăng ký tại `/login`. Hệ thống tạo sẵn 2 thương hiệu (Nguyễn Thị Ly Vân, Trang Tùng Khang), 6 trụ cột nội dung, 5 kênh, 21 từ khoá gốc. Nếu thấy nhãn **DEMO** nghĩa là chưa nhập khoá AI: nội dung chỉ là khuôn mẫu để làm quen — **hãy nhập khoá ở Cài đặt → AI Provider** để có nội dung thật.

## 1. Quy trình mỗi ngày (≈10 phút)
1. **Nhật ký** (Ngân hàng câu chuyện): ghi 1–3 điều thật xảy ra hôm nay (đặt Riêng tư nếu nhạy cảm).
2. **Tổng quan → CHẠY AI AGENT HÔM NAY**: xem tiến độ 12 bước.
3. **Content Factory**: mở từng bản nháp, sửa cho đúng giọng bạn (đừng đăng nguyên văn AI), thêm trải nghiệm thật. Bấm **Gửi duyệt** → **Duyệt** (quản trị) → **Lên lịch**.
4. Đăng **thủ công** trên nền tảng (sao chép nội dung/biến thể), rồi bấm **Đánh dấu đã đăng**.
5. Cuối tuần: nhập số liệu ở **Phân tích hiệu quả** (hoặc import CSV) và xem báo cáo.

## 2. Từng màn hình
- **DNA thương hiệu**: sửa định vị, giọng văn, quy tắc; mỗi lần lưu là một phiên bản. Tỷ trọng trụ cột phải bằng 100%.
- **Phòng từ khoá**: nhập từ khoá gốc → mở rộng 20/50/100. Điểm là *ước tính AI*. Lượng tìm kiếm chỉ nhập khi bạn có nguồn (ghi rõ nguồn). Nút ⋯ để chuyển thành ý tưởng/series/kế hoạch 30 ngày.
- **Radar xu hướng**: tự thêm xu hướng bạn thấy (kèm link, ngày, độ tin cậy). Hệ thống không tự lấy dữ liệu từ mạng xã hội.
- **Giải mã viral**: dán transcript/nội dung bài tham khảo (không dán dữ liệu riêng tư; không copy nguyên văn). Chỉ có transcript thì phần góc quay/ánh sáng sẽ để trống.
- **Ý tưởng**: chấm điểm lại theo cảm nhận của bạn; bấm "Viết bài"/"Kịch bản video".
- **Video Studio**: sửa từng cảnh, sao chép **Prompt Google Flow** từng cảnh hoặc tất cả, dán vào Google Flow thủ công, tải ảnh/video kết quả lên lại. Tải SRT/ZIP để dựng bằng CapCut. Hệ thống **không** tự tạo video.
- **Lịch**: kéo thả để đổi ngày. Đổi lịch đã xác nhận sẽ hỏi lại.
- **Lead**: nhập tay hoặc import CSV (cần tick đồng ý). Không thu thập liên hệ riêng tư từ mạng xã hội.
- **Phân tích**: các chỉ số — Engagement = tương tác/views; CPL = chi phí MKT/lead; ROAS = doanh thu/chi phí QC; ROI = (lợi nhuận gộp − chi phí MKT)/chi phí MKT. Doanh thu ≠ lợi nhuận. Chỉ là tương quan.
- **Tự động hoá**: lịch Daily/Weekly/Monthly **đang tắt**; bật cần xác nhận, cần cron gọi `/api/cron/tick` (xem DEPLOYMENT.md).
- **Chi phí AI**: đặt ngân sách ngày/tháng; vượt mức hệ thống dừng gọi AI. **Hãy cập nhật bảng giá model** theo nhà cung cấp.
- **Copilot** (nút góc trên): hỏi hoặc dùng lệnh `/DAILY /KEYWORD /VIRAL /DECODE /STORY /FLOW /30DAY /AUDIT /REPORT /REWRITE`.

## 3. Quy tắc vàng
Không bịa trải nghiệm · không mua view/bot · không biến trang cá nhân thành catalogue · không hứa chắc chắn viral · đo lường rồi mới tăng quảng cáo · đừng phụ thuộc hoàn toàn vào AI.

## 4. Xử lý sự cố
- "Đã chạm ngân sách": tăng ngân sách ở Chi phí AI.
- "Tất cả nhà cung cấp AI đều lỗi": kiểm tra khoá/số dư, bấm Kiểm tra kết nối.
- Daily Agent báo đang chạy mãi: bấm Huỷ rồi chạy lại.
- Mất khoá API sau khi đổi `APP_SECRET`: nhập lại khoá.
