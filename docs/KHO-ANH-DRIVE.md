# Kho ảnh chat: đĩa cục bộ + Google Drive (bỏ Cloudflare R2)

Từ **22/09/2026**, zalocrm không còn đẩy ảnh/video/file của khung chat lên
Cloudflare R2 nữa. Mục đích: cắt chi phí Cloudflare.

## Mô hình mới

```
Zalo / nhân viên gửi ảnh
        │
        ▼
   ĐĨA máy chạy zalocrm          ← bản GỐC, ghi ngay, không chờ ai
   backend/data/media/<ngày>/<uuid>.<đuôi>
        │  (hàng đợi nền, không chặn việc gửi tin)
        ▼
   GOOGLE DRIVE                  ← bản SAO, cùng cấu trúc thư mục
   ZaloCRM-Media/<ngày>/<uuid>.<đuôi>
```

Trình duyệt tải ảnh qua chính backend: `GET /api/v1/media/<ngày>/<uuid>.<đuôi>`.
URL lưu trong DB là **đường dẫn tương đối**, nên chạy qua Cloudflare Tunnel hay
gọi thẳng `127.0.0.1:3080` đều đúng — không còn phụ thuộc domain CDN nào.

## Quy mô thật (đo 22/09/2026)

Đây là con số quyết định mọi tham số bên dưới — đừng chỉnh mà không đọc lại nó:

| Chỉ số | Giá trị |
|---|---|
| File media ghi mới | **~148.000 / ngày** (thấp 77k · đỉnh 193k) |
| Dung lượng | **~19 GiB / ngày** (đỉnh ~24 GiB) |
| Cỡ file trung bình | 133 KiB |
| Đĩa Mac mini còn trống | ~77 GiB |
| Giữ 3 ngày ⇒ chiếm | **~57 GiB** (ngày đỉnh ~73 GiB — sát trần) |
| Drive 5TB đầy sau | **~270 ngày** |

Hệ quả: giữ 3 ngày là **vừa khít**, không còn dư địa. Vì vậy có chế độ *cứu đĩa*
(xem bên dưới) — thiếu nó thì một chuỗi ngày cao điểm sẽ làm đầy ổ và kéo sập máy.

## Đồng bộ hai chiều

| Chiều | Khi nào chạy | Làm gì |
|---|---|---|
| đĩa → Drive | ngay sau mỗi lần ghi file | đẩy lên Drive ở nền, lỗi thì thử lại 5 lần |
| đĩa → Drive | mỗi 15 phút | nhặt các file lỡ chưa lên được (mất mạng, Drive lỗi) |
| Drive → đĩa | mỗi 15 phút | kéo về file **chỉ có trên Drive** — ảnh Sếp bỏ tay vào thư mục Drive cũng hiện trong zalocrm; máy cài lại cũng tự lấy lại kho |
| Drive → đĩa | ngay lúc cần | file đã bị dọn khỏi đĩa thì request đầu tiên tự kéo về rồi nằm lại |
| dọn đĩa | mỗi 15 phút | xoá bản nóng cũ hơn `MEDIA_LOCAL_RETENTION_DAYS`, **chỉ khi Drive đã có bản sao** |
| 🚨 cứu đĩa | khi trống < `MEDIA_MIN_FREE_GB` | xoá ngày **cũ nhất trước**, bỏ qua cả hạn giữ lẫn xác nhận Drive, dừng ngay khi đủ chỗ. Ngày **hôm nay** luôn được giữ |

Chưa cấu hình Drive thì mọi thứ vẫn chạy — chế độ **chỉ-đĩa-cục-bộ**, không có
bản sao. Đĩa vẫn được cứu khi sắp đầy, nên máy không bao giờ bị lấp.

> ⚠️ Chế độ cứu đĩa **xoá cả file còn trong hạn 3 ngày**. Cố ý: ngày cao điểm thì
> chẳng có gì "quá hạn" để xoá, mà ổ thì vẫn đầy. Mất ảnh cũ hơn mất máy — và ảnh
> vẫn còn trên Drive nếu Drive đang chạy.

### Vì sao phải đẩy nhiều luồng

`MEDIA_UPLOAD_CONCURRENCY=6`. Nối tiếp một luồng thì 148k file/ngày × ~300ms =
**hơn 12 tiếng/ngày**, ngày cao điểm là 16 tiếng — không còn dư địa, hàng đợi sẽ
ùn vô hạn. Ngoài ra đường ghi mới **bỏ qua** bước hỏi "Drive có file này chưa"
(key là UUID vừa sinh, chắc chắn chưa có): tiết kiệm đúng 148k lượt gọi API/ngày.
Lượt thử lại thì vẫn hỏi, phòng khi lỗi xảy ra *sau* khi Drive đã nhận.

Tương tự, lúc dọn đĩa hệ thống liệt kê **cả thư mục ngày một lần** (~150 lượt gọi)
thay vì hỏi từng file (~148k lượt).

## Cài đặt một lần

Google **không cho service account** tạo file có nội dung trong My Drive
(*"Service Accounts do not have storage quota"*). Phải là OAuth của một tài khoản
Google thật — ảnh sẽ nằm trong Drive của tài khoản đó và ăn vào quota của nó.

1. [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services**
   → **Library** → bật **Google Drive API**
2. **Credentials** → **Create credentials** → **OAuth client ID** → **Desktop app** → tải JSON
3. Lưu JSON vào `~/.config/gcp/drive-oauth-client.json`
   ```bash
   mkdir -p ~/.config/gcp && mv ~/Downloads/client_secret_*.json ~/.config/gcp/drive-oauth-client.json
   ```
4. Cấp quyền:
   ```bash
   cd ~/apps/zalocrm/backend && npm run drive:setup
   ```
   Trình duyệt mở ra, bấm đồng ý. Token ghi vào `~/.config/gcp/drive-oauth-token.json`.
5. Khởi động lại backend.

Kiểm tra: `GET /api/v1/media-sync/status` (cần đăng nhập) trả tài khoản Drive +
dung lượng còn lại. `POST /api/v1/media-sync/run` chạy đối chiếu ngay, không đợi
15 phút.

## Chuyển dữ liệu cũ khỏi R2

Bucket `zalocrm-media` có lifecycle **xoá object sau 3 ngày**, nên chỉ media của
~3 ngày gần nhất còn cứu được — phần cũ hơn đã mất từ trước rồi.

```bash
cd ~/apps/zalocrm/backend
npm run media:migrate-from-r2 -- --dry     # đếm trước
npm run media:migrate-from-r2              # kéo về + viết lại URL trong DB
```

Chạy xong mới được xoá bucket R2 và gỡ domain `crmcdn.shinsulab.com`.
`S3_ENDPOINT` / `S3_PUBLIC_URL` trong `.env` giữ lại tới lúc đó — hai biến này
giờ **chỉ dùng để nhận diện URL cũ** còn tồn trong DB, không còn client nào ghi
lên R2 nữa.

## Cấu hình

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MEDIA_DIR` | `data/media` | thư mục kho trên đĩa (tương đối = so với `backend/`) |
| `MEDIA_LOCAL_RETENTION_DAYS` | **`3`** | giữ bản nóng bao nhiêu ngày; `0` = không dọn. **Mỗi ngày ≈ 19 GiB** |
| `MEDIA_MIN_FREE_GB` | `20` | tụt dưới mức này thì bật chế độ cứu đĩa |
| `MEDIA_UPLOAD_CONCURRENCY` | `6` | số file đẩy lên Drive song song |
| `MEDIA_RECONCILE_WINDOW_DAYS` | `2` | vòng đối chiếu chỉ soi mấy ngày gần nhất |
| `DRIVE_RETENTION_DAYS` | `0` | ném thư mục ngày cũ trên Drive vào Thùng rác sau N ngày; `0` = giữ mãi |
| `MEDIA_SYNC_INTERVAL_MINUTES` | `15` | chu kỳ đối chiếu; `0` = tắt vòng nền |
| `DRIVE_MEDIA_FOLDER_ID` | *(trống)* | thư mục Drive chứa bản sao; trống = tự tạo theo tên |
| `DRIVE_MEDIA_FOLDER_NAME` | `ZaloCRM-Media` | tên thư mục khi tự tạo ở gốc My Drive |
| `DRIVE_OAUTH_CLIENT` | `~/.config/gcp/drive-oauth-client.json` | OAuth client JSON |
| `DRIVE_OAUTH_TOKEN` | `~/.config/gcp/drive-oauth-token.json` | token do `drive:setup` ghi ra |

## Lưu ý về dung lượng Drive

Drive **không có lifecycle rule** như R2 — mặc định kho phình mãi. Với ~19 GiB/ngày:

| Gói Drive | Đầy sau |
|---|---|
| 15 GB miễn phí | **chưa tới 1 ngày** — không dùng được |
| Google One 2 TB | ~105 ngày |
| **Google One 5 TB** (đang dùng) | **~270 ngày** |

Theo dõi bằng `GET /api/v1/media-sync/status` (trả `drive.usedGb` / `drive.freeGb`
và `disk.freeGb`). Gần đầy thì đặt `DRIVE_RETENTION_DAYS` (vd `180`) để hệ thống
tự ném thư mục ngày cũ vào Thùng rác — nhớ là Thùng rác giữ thêm 30 ngày mới thực
sự trả lại chỗ.

## Bảo mật

Route `/api/v1/media/*` **không đòi đăng nhập** — cố ý, và đúng bằng mức bảo mật
của bucket R2 public trước đây: thẻ `<img>`/`<video>` của trình duyệt không gửi
được header `Authorization`, còn đường dẫn thì chứa UUID v4 nên không đoán ra.
Đường dẫn được kiểm bằng `isValidKey()` trước khi ghép vào filesystem — có test
riêng cho các mưu đồ vượt thư mục (`tests/media-store.test.ts`,
`tests/media-routes.test.ts`).

Thư mục Drive **không** được chia sẻ public — backend đọc bằng OAuth của tài
khoản chủ, nên ảnh khách hàng không lộ ra ngoài qua link Drive.

## File liên quan

- `backend/src/shared/storage/media-store.ts` — kho đĩa, sinh key, URL, dọn bản nóng
- `backend/src/shared/storage/drive-media.ts` — lớp gọi Google Drive
- `backend/src/shared/storage/media-sync.ts` — hàng đợi đẩy + vòng đối chiếu hai chiều
- `backend/src/modules/chat/media-routes.ts` — route phục vụ file (có hỗ trợ `Range`)
- `backend/scripts/drive-oauth-setup.mjs` — cấp quyền một lần
- `backend/scripts/migrate-r2-to-media.ts` — chuyển dữ liệu cũ khỏi R2
