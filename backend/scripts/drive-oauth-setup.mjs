#!/usr/bin/env node
/**
 * drive-oauth-setup.mjs — cấp quyền Google Drive MỘT LẦN cho kho ảnh chat.
 *
 * Vì sao phải làm bằng tay: Google KHÔNG cho service account tạo file có nội dung
 * trong My Drive ("Service Accounts do not have storage quota"). Phải là OAuth của
 * một tài khoản Google THẬT — tài khoản nào chạy ở bước 3 thì ảnh nằm trong Drive
 * của tài khoản đó, và dung lượng tính vào quota của tài khoản đó.
 *
 * Chuẩn bị (làm một lần trên Google Cloud Console):
 *   1. console.cloud.google.com → APIs & Services → Library → bật "Google Drive API"
 *   2. Credentials → Create credentials → OAuth client ID → Desktop app → tải JSON
 *   3. Lưu JSON vào  ~/.config/gcp/drive-oauth-client.json
 *      (đổi chỗ khác thì đặt DRIVE_OAUTH_CLIENT trong backend/.env)
 *
 * Chạy:  npm run drive:setup
 * Script mở trình duyệt, Sếp bấm đồng ý, xong là token ghi vào
 * ~/.config/gcp/drive-oauth-token.json (chmod 600). Không cần chạy lại.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;

const expand = (p) => String(p || '').replace(/^~(?=$|\/)/, os.homedir());
const CLIENT_PATH = expand(process.env.DRIVE_OAUTH_CLIENT || '~/.config/gcp/drive-oauth-client.json');
const TOKEN_PATH = expand(process.env.DRIVE_OAUTH_TOKEN || '~/.config/gcp/drive-oauth-token.json');

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(CLIENT_PATH)) {
  fail(
    `Không thấy OAuth client JSON tại: ${CLIENT_PATH}\n` +
    `   Tạo ở console.cloud.google.com → Credentials → OAuth client ID → Desktop app,\n` +
    `   tải JSON về rồi lưu đúng đường dẫn trên (mkdir -p ~/.config/gcp).`,
  );
}

const raw = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8'));
const cfg = raw.installed || raw.web;
if (!cfg?.client_id || !cfg?.client_secret) {
  fail(`${CLIENT_PATH} không đúng dạng OAuth client (thiếu installed/web.client_id).`);
}

const oauth = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, REDIRECT);
const authUrl = oauth.generateAuthUrl({
  access_type: 'offline',   // bắt buộc, để Google trả refresh_token
  prompt: 'consent',        // ép cấp lại refresh_token kể cả khi đã đồng ý trước đó
  scope: SCOPES,
  // Gợi ý sẵn email để Google chọn đúng tài khoản, đỡ một bước bấm và tránh
  // lỡ tay cấp quyền nhầm tài khoản đang đăng nhập cùng lúc trong Chrome.
  ...(process.env.DRIVE_SETUP_EMAIL ? { login_hint: process.env.DRIVE_SETUP_EMAIL } : {}),
});

console.log('\n🔑 Mở trình duyệt để cấp quyền Google Drive…');
console.log(`AUTH_URL=${authUrl}\n`);
// DRIVE_SETUP_NO_BROWSER=1 → chỉ in link, không tự bật trình duyệt. Dùng khi có
// thứ khác lo phần bấm (agent lái Chrome, hoặc chạy trên máy không màn hình).
if (process.env.DRIVE_SETUP_NO_BROWSER !== '1') exec(`open "${authUrl}"`);

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth2callback')) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
       .end('Thiếu tham số code — thử chạy lại npm run drive:setup');
    return;
  }
  try {
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('Google không trả refresh_token — gỡ quyền app ở myaccount.google.com/permissions rồi chạy lại.');
    }
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });

    oauth.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: oauth });
    const about = await drive.about.get({ fields: 'user(emailAddress),storageQuota(limit,usage)' });
    const email = about.data.user?.emailAddress ?? '(không rõ)';
    const q = about.data.storageQuota ?? {};
    const gb = (n) => (Number(n || 0) / 1024 ** 3).toFixed(1);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
       .end('<h2>✅ Xong! Đóng tab này và quay lại terminal.</h2>');

    console.log(`\n✅ Đã lưu token: ${TOKEN_PATH}`);
    console.log(`   Tài khoản Drive: ${email}`);
    console.log(`   Dung lượng: đã dùng ${gb(q.usage)}GB / ${q.limit ? `${gb(q.limit)}GB` : 'không giới hạn'}`);
    console.log('\n👉 Khởi động lại zalocrm backend là ảnh bắt đầu đồng bộ lên Drive.\n');
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(err?.message || err));
    fail(String(err?.message || err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`⏳ Đang chờ Google gọi về ${REDIRECT} …`);
});
