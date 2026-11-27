// Chạy demo: đăng ký → Daily Agent (DEMO) → chụp ảnh các màn hình chính vào thư mục OUT.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const OUT = process.env.OUT ?? './demo-shots';
fs.mkdirSync(OUT, { recursive: true });
const exe = ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 }, extraHTTPHeaders: { 'x-forwarded-for': `10.77.${Math.floor(Math.random() * 250)}.1` } })).newPage();
const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('📸', name); };

await page.goto(BASE + '/login');
await page.getByRole('button', { name: /Chưa có tài khoản/ }).click();
await page.getByLabel('Họ và tên').fill('Nguyễn Thị Ly Vân');
await page.getByLabel('Email').fill(`demo${Date.now()}@example.local`);
await page.getByLabel('Mật khẩu').fill('demo-password-123');
await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
await page.waitForURL(BASE + '/');
await shot('01-tong-quan-truoc-khi-chay');

await page.getByRole('button', { name: /CHẠY AI AGENT HÔM NAY/ }).click();
await page.getByText('Hoàn tất').first().waitFor({ timeout: 60000 });
await shot('02-daily-agent-12-buoc');
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
await shot('03-tong-quan-sau-khi-chay');

const go = async (path, name, wait) => { await page.goto(BASE + path, { waitUntil: 'networkidle' }); if (wait) await page.getByText(wait).first().waitFor({ timeout: 8000 }).catch(() => {}); await shot(name); };
await go('/content', '04-content-factory-danh-sach', 'Bản nháp');
await page.locator('a[href^="/content/"]').first().click();
await page.waitForURL(/\/content\/[0-9a-f-]{36}/);
await shot('05-trinh-soan-bai-viet');
await go('/video', '06-video-studio');
await page.locator('button, a').filter({ hasText: /\[DEMO\]|giây/ }).first().click().catch(() => {});
await shot('07-video-storyboard');
await go('/ideas', '08-ngan-hang-y-tuong');
await go('/keywords', '09-keyword-lab');
await go('/calendar', '10-lich-noi-dung');
await go('/ai-cost', '11-chi-phi-ai');
await go('/settings', '12-cai-dat');
await browser.close();
console.log('Xong →', OUT);
