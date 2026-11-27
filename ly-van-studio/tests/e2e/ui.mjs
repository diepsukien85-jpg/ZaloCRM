// E2E giao diện bằng Playwright: đăng ký → chạy Daily Agent → duyệt → kiểm tra 18 trang ở mobile & desktop.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const exe = ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const PAGES = ['/', '/agents', '/dna', '/trends', '/keywords', '/viral', '/stories', '/ideas', '/content', '/video', '/media', '/calendar', '/channels', '/leads', '/analytics', '/automation', '/ai-cost', '/settings'];
const problems = []; let ok = 0;
const email = `ui-${Date.now()}@e2e.local`;

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { 'x-forwarded-for': '10.9.9.9' } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push(`console: ${m.text()}`); });

await page.goto(BASE + '/login');
await page.getByRole('button', { name: /Chưa có tài khoản/ }).click();
await page.getByLabel('Họ và tên').fill('Ly Vân');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Mật khẩu').fill('password123');
await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
await page.waitForURL(BASE + '/');
await page.getByRole('button', { name: /CHẠY AI AGENT HÔM NAY/ }).waitFor();
ok++;

// Chạy Daily Agent từ nút lớn và xem tiến độ
await page.getByRole('button', { name: /CHẠY AI AGENT HÔM NAY/ }).click();
await page.getByText('Hoàn tất').first().waitFor({ timeout: 60000 });
await page.getByText('DEMO').first().waitFor();
ok++;
await page.keyboard.press('Escape');

// Mở Content Factory, vào bài đầu tiên, sửa → autosave → gửi duyệt
await page.goto(BASE + '/content');
await page.getByText('3 bài').count();
const firstLink = page.locator('a[href^="/content/"]').first();
await firstLink.waitFor();
await firstLink.click();
await page.waitForURL(/\/content\/[0-9a-f-]{36}/);
const body = page.locator('textarea').first();
await body.waitFor();
const ta = page.getByLabel(/Nội dung|Thân bài/).first();
await (await ta.count() ? ta : body).fill('Nội dung đã sửa bởi e2e UI');
await page.getByText(/Đã lưu lúc/).waitFor({ timeout: 15000 });
ok++;
await page.getByRole('tab', { name: /Duyệt & đăng/ }).or(page.getByRole('button', { name: /Duyệt & đăng/ })).first().click();
await page.getByRole('button', { name: /^Gửi duyệt/ }).click();
await page.getByText('Chờ duyệt').first().waitFor({ timeout: 10000 });
await page.getByRole('tab', { name: /Soạn thảo/ }).or(page.getByRole('button', { name: /^Soạn thảo/ })).first().click();
ok++;

// Duyệt sau khi tải lại → dữ liệu còn nguyên
await page.reload();
await page.getByText('Nội dung đã sửa bởi e2e UI').first().waitFor();
ok++;

// Quét 18 trang × 2 viewport: không lỗi JS, không tràn ngang, có tiêu đề
for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  await page.setViewportSize(vp);
  for (const p of PAGES) {
    errs.length = 0;
    const res = await page.goto(BASE + p, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const h1 = await page.locator('h1').count();
    const failed = (await page.locator('[role=alert]').allTextContents()).filter((t) => t.trim());
    if (res.status() !== 200) problems.push(`${p} @${vp.width}: HTTP ${res.status()}`);
    else if (overflow > 2) problems.push(`${p} @${vp.width}: tràn ngang ${overflow}px`);
    else if (!h1) problems.push(`${p} @${vp.width}: thiếu h1`);
    else if (errs.length) problems.push(`${p} @${vp.width}: ${errs.join(' | ')}`);
    else if (failed.length) problems.push(`${p} @${vp.width}: alert ${failed.join(' | ')}`);
    else ok++;
  }
}

// Dark mode
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(BASE + '/');
await page.getByRole('button', { name: 'Chế độ tối' }).click();
assert.ok(await page.evaluate(() => document.documentElement.classList.contains('dark')));
await page.reload();
assert.ok(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'dark mode phải được ghi nhớ');
ok++;

// Copilot
await page.getByRole('button', { name: /Copilot/ }).click();
await page.getByLabel('Tin nhắn Copilot').fill('/REPORT');
await page.getByLabel('Tin nhắn Copilot').press('Enter');
await page.getByText(/Báo cáo 30 ngày/).waitFor({ timeout: 15000 });
ok++;

// Menu mobile
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE + '/');
await page.getByRole('button', { name: 'Mở menu' }).click();
await page.getByRole('link', { name: 'Video Studio' }).click();
await page.waitForURL(/\/video/);
ok++;

await page.screenshot({ path: process.env.SHOT ?? '/tmp/claude-0/ui-mobile.png' });
await browser.close();
console.log(`UI: ${ok} bước/trang đạt, ${problems.length} vấn đề`);
problems.forEach((x) => console.log(' ✘', x));
process.exit(problems.length ? 1 : 0);
