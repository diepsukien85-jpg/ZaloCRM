# PROMPTS

## Nguyên tắc
1. **Một system prompt gốc** (`BASE` trong `src/lib/ai/prompts.ts`): tiếng Việt tự nhiên, không bịa trải nghiệm/số liệu, không khoe khoang, không catalogue, bám DNA, điểm số = ước tính.
2. Mỗi tác vụ có prompt riêng (10 prompt): `keyword_expansion`, `idea_generation`, `post_writing`, `video_script`, `story_extraction`, `viral_decode`, `variants`, `rewrite`, `review`, `trend_analysis`, `copilot`.
3. **Prompt có phiên bản**: seed vào `prompt_templates` + `prompt_versions` (v1, active). Người dùng tạo phiên bản mới / kích hoạt lại phiên bản cũ ở trang AI Agent Center → tab Prompt. Runtime chọn bản `active` của workspace, fallback về mặc định trong mã. `agent_runs.prompt_version` chưa được ghi (xem hạn chế).
4. **Chống prompt injection**: (a) mọi dữ liệu không đáng tin (nhật ký, transcript, xu hướng, tin nhắn người dùng) được bọc trong `<untrusted_data>` (`wrapUntrusted`, chặn thoát thẻ); (b) mọi system prompt được nối `INJECTION_GUARD`; (c) đầu ra bắt buộc JSON và bị validate bằng Zod nên lệnh lạ không thể biến thành hành động; (d) agent không có công cụ ghi/đăng — chỉ trả dữ liệu, ứng dụng quyết định lưu; (e) test `ai-client.test.ts` kiểm tra tin nhắn độc hại nằm trong thẻ.
5. **Quyền riêng tư**: `redactPII` che SĐT/email/số dài trước khi đưa vào prompt; nhật ký `private` bị loại khỏi ngữ cảnh Daily Agent và cần xác nhận khi trích xuất thủ công.

## Cấu trúc user prompt
```
<DNA thương hiệu đang hoạt động>
<tham số tác vụ: chủ đề, nền tảng, số lượng…>
<dữ liệu tham khảo trong <untrusted_data>…>
Trả JSON: {schema mô tả ngắn}
```
Schema chi tiết (Zod) ở `src/lib/ai/schemas.ts`.

## Chỉnh prompt an toàn
- Tạo phiên bản mới thay vì sửa tại chỗ; ghi ghi chú thay đổi.
- Giữ nguyên các quy tắc "không bịa", "JSON duy nhất"; nếu bỏ, đầu ra có thể không qua validate (hệ thống tự yêu cầu sửa 1 lần rồi báo lỗi).
